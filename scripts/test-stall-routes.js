// The routes production named while its event loop was held (the [loop-lag]
// in-flight lists): each figure they read is now built across event-loop
// turns, shared between callers and warmed at boot, at production scale.
//   1. Offline: the sliced builders return exactly what the one-turn reads
//      return (sales summaries, the revenue ledger's summary, daily series
//      and buyer events, the index snapshot, the tool directory) and never
//      hold the loop past GAP_MS on production-sized data (the sales
//      summaries also with every page of work inflated, so they must yield
//      on elapsed time, not after a count of pages); a seller summary
//      rebuild projects only the sellers that changed. The all-chains
//      /marketplace page (both views) renders the same bytes in slices as in
//      one turn, and while a warm start folds entries in, the readers of one
//      turn share one index snapshot instead of each building its own.
//   2. Booted on a production-sized index (5,800 sellers, ~198k tools) and
//      sales ledger: the first request to each route after boot holds the
//      loop under ROUTE_BOUND_MS, and the shared ledger figures the routes
//      serve equal a direct read of the ledger.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync as readProcFile, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PerformanceObserver } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import Database from "better-sqlite3";
import { getFreePort } from "./lib/free-port.js";
import { buildRoutePerfFixture } from "./lib/route-perf-fixture.js";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
// A loop hold is the time this thread was ours: its wall time less the time
// it sat runnable on the scheduler's queue waiting for a core. On a loaded host the thread can sit descheduled in the middle of a
// turn, which stretches a gap without any of our work in it (measured
// under contention: a seller-summary rebuild of 6 to 16 ms ours read
// 30 to 880 ms of wall time), so that wait is not ours. A wait the thread
// chose (a synchronous file read, a spawnSync, an Atomics.wait) is not on
// that queue and is ours: a buyer waits through it as through CPU work, and
// a reading of thread CPU alone saw a 200 ms Atomics.wait as 0 ms. The queue
// wait is the second field of the thread's schedstat (Linux, where CI runs);
// where that file is missing the hold is the thread's CPU time, which misses
// a blocking wait, so under CI the file is required.
const threadCpuMs = () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; };
const SCHEDSTAT = (() => { const p = `/proc/self/task/${process.pid}/schedstat`; try { return /^\d+ \d+ \d+/.test(readProcFile(p, "utf8")) ? p : null; } catch { return null; } })();
const queuedMs = () => Number(readProcFile(SCHEDSTAT, "utf8").split(" ")[1]) / 1e6;
// A clock that advances only while the time is ours; a hold is its advance.
const oursMs = SCHEDSTAT ? () => performance.now() - queuedMs() : threadCpuMs;
const HOLD_READING = SCHEDSTAT ? "wall time less run-queue wait" : "thread CPU";
console.log(`# loop holds read as ${HOLD_READING}${SCHEDSTAT ? "" : " (no schedstat here: a blocking wait reads as 0)"}`);
if (process.env.CI) assert.ok(SCHEDSTAT, "under CI the main thread's schedstat must be readable, so a blocking wait is measured");
// Same-machine baseline: a fixed job of the kind the builders do (objects
// built, serialized, parsed, sorted), the fastest of three runs so one
// collector pause does not decide it. Every loop-hold bound below is the
// larger of its absolute floor (what a laptop reads, with room) and a share
// of this baseline, so a shared runner several times slower than a laptop
// gets a bound several times wider, while a hold that is a multiple of the
// baseline still fails (the deliberate-regression check below proves it).
// Measured at about 16 ms on a laptop, where the floors are the bounds. The
// STALL_*_MS variables set the floors. Timed on the ours clock, as the holds
// are: a wall-clock baseline taken on a contended host read several times its
// work and widened every bound with it, so a planted hold passed there.
// The booted server's probe (section 2) runs this same function, from its
// source text, on the server's main thread.
const baselineJob = (ours) => {
  const once = () => {
    const t0 = ours();
    const rows = []; for (let i = 0; i < 36_000; i++) rows.push({ i, s: "k" + (i % 977), v: i * 1.5, t: [i, i + 1] });
    JSON.parse(JSON.stringify(rows)).sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.i - b.i));
    return ours() - t0;
  };
  return Math.min(once(), once(), once());
};
const BASELINE_MS = baselineJob(oursMs);
const boundAt = (floor, k, base) => ({ ms: Math.max(floor, Math.round(k * base)), note: `bound ${Math.max(floor, Math.round(k * base))} ms: ${floor} ms or ${k}x the ${base.toFixed(1)} ms baseline` });
const bound = (floor, k) => boundAt(floor, k, BASELINE_MS);
const GAP = bound(Number(process.env.STALL_GAP_MS || 120), 3);
const GAP_MS = GAP.ms;
// A first request after boot also compiles the route's code, which a shared
// runner slows far more than the hot baseline loop (209 ms against a 21 ms
// baseline seen on one); the stalls this pin exists for were seconds long.
// In section 2 the baseline is the booted server's own, run on its main thread
// on each side of the request it bounds (the larger of the two): a host that
// turns busy minutes after this process took its baseline, or that runs the
// server on a slower core than this process, slows the route and the
// server's baseline together (one first request read 402 ms against a 300 ms
// bound taken here, at a machine load of 25). The same job reads about 1.4
// times longer on the server's thread than here (its heap holds the
// production-sized index: 23 to 25 ms against 17 ms on a laptop), so the
// server's multiple is 9 where this process's is 12: the same bound in
// milliseconds on a quiet machine.
const ROUTE_FLOOR_MS = Number(process.env.STALL_ROUTE_BOUND_MS || 150), ROUTE_K = 12, ROUTE_K_SERVER = 9;
const ROUTE = bound(ROUTE_FLOOR_MS, ROUTE_K);
const ROUTE_BOUND_MS = ROUTE.ms;
// One step of a sliced page: measured at 3.4 ms on a laptop for the longest
// (?all=1, 5,800 sellers); the floor allows a runner several times slower.
const STEP = bound(Number(process.env.STALL_STEP_BOUND_MS || 25), 0.75);
const STEP_BOUND_MS = STEP.ms;
// The /marketplace walk's roster loops that yield per 250 rows, in whole
// loops (one-chain view, all-chains view): the fixture reads 4.36 and 5.18,
// the rest being the operator counts and per-chain passes, which yield per
// 250 rows of a part of the roster. One loop that stops yielding drops a whole
// loop's worth below these.
const MARKET_ROSTER_LOOPS = 4, MARKET_ROSTER_LOOPS_ALL = 5;
console.log(`baseline ${BASELINE_MS.toFixed(1)} ms; ${GAP.note}; ${ROUTE.note}; ${STEP.note}`);
const SALES_ROWS = Number(process.env.STALL_SALES_ROWS || 60_000);
const TRANSFER_ROWS = Number(process.env.STALL_TRANSFER_ROWS || 200_000);

const dir = mkdtempSync(join(tmpdir(), "a402-stall-routes-"));
// The fixtures (ledgers, the index cache, the booted server's stores) are
// about half a gigabyte: removed on every exit, a failed assertion included,
// and on an interrupt. The booted server is killed first (see section 2).
let serverProc = null;
process.on("exit", () => {
  try { serverProc?.kill("SIGKILL"); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(130));
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
process.env.REVENUE_LEDGER_DB = join(dir, "revenue.db");
process.env.X402_INDEX_CRAWL = "off";
const now = Date.now();
let seed = 7;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

// --- fixtures: a sales ledger of SALES_ROWS rows over 120 days. No row lands
// within EDGE_MS of the 30-day window's edge: the booted server's figures are
// read minutes after this test's own, and a row that crossed the edge in
// between read as a mismatch (seen on a slow run).
const EDGE_MS = 6 * 3_600_000;
const clearOfWindowEdge = (ts) => { const edge = now - 30 * 86_400_000; return Math.abs(ts - edge) < EDGE_MS ? edge + (ts < edge ? -EDGE_MS : EDGE_MS) : ts; };
const sales = await import("../src/sales-ledger.js");
{
  const db = new Database(process.env.SALES_LEDGER_DB);
  const slugs = ["hash", "v1-chat-nano", "web-search", "market-quote", "dns-lookup", "pdf-extract", "tts", "image-gen", "whois", "json-to-csv", "browser-render", "qr"];
  const nets = ["eip155:8453", "eip155:8453", "eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "tempo", "eip155:137", "eip155:42161", "stellar:pubnet", "algorand:mainnet"];
  const rails = ["usdc", "usdc", "usdc", "pow", "marketplace", "card"];
  const ins = db.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES (?,?,?,?,?,?,?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < SALES_ROWS; i++) {
      const net = nets[Math.floor(rnd() * nets.length)];
      ins.run(clearOfWindowEdge(now - Math.floor(rnd() * 120 * 86_400_000)), slugs[Math.floor(rnd() * slugs.length)], Math.round(rnd() * 50) / 1000 + 0.001,
        rails[Math.floor(rnd() * rails.length)], net, rnd() < 0.1 ? null : "0x" + Math.floor(rnd() * 400).toString(16).padStart(40, "a"),
        "0x" + i.toString(16).padStart(64, "0"), rnd() < 0.25 ? 1 : 0, net === "tempo" ? "mpp-tempo" : "x402");
    }
  })();
  db.close();
}

// The worst event-loop block while `fn` runs, from a 1 ms interval, less the
// collector's pauses inside it (the production stall line reports collector
// time apart too): the gaps are kept so a pause is subtracted from the gap it
// fell in, and a gap's hold is read on the ours clock (above).
let gaps = null, last = performance.now(), lastOurs = oursMs();
const lagTimer = setInterval(() => { const t = performance.now(), c = oursMs(); if (gaps) gaps.push([last, t, c - lastOurs]); last = t; lastOurs = c; }, 1);
const gcPauses = [];
new PerformanceObserver((list) => { for (const e of list.getEntries()) gcPauses.push([e.startTime, e.startTime + e.duration]); }).observe({ entryTypes: ["gc"] });
async function blockOf(fn) {
  await new Promise((r) => setTimeout(r, 20));
  // Start `fn` from the check phase, as a slice that follows a yield runs. A
  // start from the timer callback above ran its first slice there and its
  // second in the same loop iteration's check phase, with I/O polled between
  // them but no timer phase, so the 1 ms interval read two slices as one gap.
  await new Promise((r) => setImmediate(r));
  gaps = []; last = performance.now(); lastOurs = oursMs(); gcPauses.length = 0;
  const value = await fn();
  // The observer delivers gc entries on a later task: wait for a pause that
  // ended the window to arrive before it is subtracted.
  await new Promise((r) => setTimeout(r, 50));
  let ms = 0, raw = 0, gc = 0;
  for (const [a, b, ours] of gaps) {
    let inGc = 0;
    for (const [s0, e0] of gcPauses) inGc += Math.max(0, Math.min(b, e0) - Math.max(a, s0));
    if (b - a > raw) { raw = b - a; gc = inGc; }
    ms = Math.max(ms, Math.min(b - a, ours) - inGc);
  }
  gaps = null;
  return { value, ms: Math.round(ms), raw: Math.round(raw), gc: Math.round(gc) };
}
// The pin every loop-hold figure below is held to, in both sections.
const heldUnder = (ms, limit) => ms < limit;

// --- 0. a deliberate regression: a build that holds the loop for five times
// a derived bound must fail the same pin and the same measurement the
// figures below pass, whatever the machine's baseline made the bound.
const spin = (ms) => { const t = performance.now(); while (performance.now() - t < ms) { /* hold the loop */ } };
const blockFor = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
{
  for (const [name, limit, note] of [["GAP", GAP_MS, GAP.note], ["ROUTE", ROUTE_BOUND_MS, ROUTE.note]]) {
    const r = await blockOf(async () => spin(5 * limit));
    ok(!heldUnder(r.ms, limit), `a deliberate ${5 * limit} ms hold fails the ${name} pin (measured ${r.ms} ms; ${note})`);
  }
  // A hold that is not CPU work: the thread blocked in a synchronous wait.
  if (SCHEDSTAT) {
    const r = await blockOf(async () => blockFor(2 * GAP_MS));
    ok(!heldUnder(r.ms, GAP_MS), `a deliberate ${2 * GAP_MS} ms blocking wait fails the GAP pin (measured ${r.ms} ms ours; longest gap ${r.raw} ms)`);
  }
}

// A sliced walk timed step by step: each step's hold (ours, as above) less the
// collector's pauses inside it, as blockOf reads a gap. That still leaves
// runtime work outside any reported pause: on a 2-vCPU runner whose collector
// threads are starved, the main thread finishes their sweeping and marking in
// whatever step allocates next (seen on CI: one step of the ?all=1 page read
// 72.6 ms ours after its 74.2 ms of pauses, while the whole page
// built in one turn took 67 ms). A step's own work repeats on every walk and
// that runtime work does not, so each step is read as its least over `walks`
// walks and the longest of those is pinned.
async function stepCpuWalk(makeSteps) {
  const steps = makeSteps();
  const windows = [];
  let r;
  gcPauses.length = 0;
  do { const t = performance.now(), c0 = oursMs(); r = steps.next(); windows.push([t, performance.now(), oursMs() - c0]); } while (!r.done);
  // The observer delivers gc entries on a later task.
  await new Promise((res) => setTimeout(res, 50));
  return { value: r.value, steps: windows.map(([a0, b0, ours0]) => {
    let inGc = 0;
    for (const [s0, e0] of gcPauses) inGc += Math.max(0, Math.min(b0, e0) - Math.max(a0, s0));
    return { wall: b0 - a0, gc: inGc, net: Math.min(b0 - a0, ours0) - inGc };
  }) };
}
async function longestStep(makeSteps, walks = 3) {
  const runs = [];
  for (let k = 0; k < walks; k++) runs.push(await stepCpuWalk(makeSteps));
  const count = runs[0].steps.length;
  const sameShape = runs.every((w) => w.steps.length === count);
  let longest = 0, single = 0, longestRaw = 0, longestGc = 0;
  for (let i = 0; i < count; i++) longest = Math.max(longest, Math.min(...runs.map((w) => w.steps[i]?.net ?? Infinity)));
  for (const w of runs) for (const st of w.steps) {
    single = Math.max(single, st.net);
    if (st.wall > longestRaw) { longestRaw = st.wall; longestGc = st.gc; }
  }
  return { value: runs[0].value, values: runs.map((w) => w.value), count, sameShape, longest, single, longestRaw, longestGc };
}
// The step reading itself, on synthetic walks of 30 steps: a full collection
// inside a step is subtracted; work the runtime adds to one walk's step is
// not the step's; work the step does on every walk still fails the pin.
{
  const cpuSpin = (ms) => { const c = threadCpuMs(); while (threadCpuMs() - c < ms) { /* this thread's CPU */ } };
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc");
  const walk = (at, fn) => function* () { for (let i = 0; i < 30; i++) { if (i === at) fn(); yield; } return "done"; };
  // A live heap built before the walk, so the step holds only the collection.
  let live = Array.from({ length: 6_000_000 }, (_, i) => ({ i, p: null }));
  const inGc = await longestStep(walk(10, () => gc()));
  ok(live.length > 0 && inGc.longestRaw > STEP_BOUND_MS && inGc.longestGc > STEP_BOUND_MS && heldUnder(inGc.longest, STEP_BOUND_MS), `a full collection inside a step is the collector's, not the step's (longest ${inGc.longest.toFixed(1)} ms ours, one walk's worst ${inGc.single.toFixed(1)} ms; longest raw step ${inGc.longestRaw.toFixed(1)} ms, ${inGc.longestGc.toFixed(1)} ms of it the collector; ${STEP.note})`);
  live = null;
  let walkNo = 0;
  const once = await longestStep(() => { walkNo++; return walk(10, () => { if (walkNo === 2) cpuSpin(3 * STEP_BOUND_MS); })(); });
  ok(!heldUnder(once.single, STEP_BOUND_MS) && heldUnder(once.longest, STEP_BOUND_MS), `${3 * STEP_BOUND_MS} ms of runtime work in one walk's step is not the step's (that walk read ${once.single.toFixed(1)} ms; the step's least over three walks ${once.longest.toFixed(1)} ms)`);
  const every = await longestStep(walk(10, () => cpuSpin(2 * STEP_BOUND_MS)));
  ok(!heldUnder(every.longest, STEP_BOUND_MS), `${2 * STEP_BOUND_MS} ms of work the step does on every walk fails the step pin (read ${every.longest.toFixed(1)} ms; ${STEP.note})`);
  if (SCHEDSTAT) {
    const waits = await longestStep(walk(10, () => blockFor(2 * STEP_BOUND_MS)));
    ok(!heldUnder(waits.longest, STEP_BOUND_MS), `a ${2 * STEP_BOUND_MS} ms blocking wait the step makes on every walk fails the step pin (read ${waits.longest.toFixed(1)} ms; ${STEP.note})`);
  }
}

// --- 1a. sales summaries
{
  for (const days of [30, 36_500]) {
    const sync = sales.salesSummary({ days });
    const sliced = await blockOf(() => sales.salesSummaryAsync({ days }));
    ok(isDeepStrictEqual(sliced.value, sync), `salesSummaryAsync({ days: ${days} }) equals salesSummary`);
    ok(heldUnder(sliced.ms, GAP_MS), `...and never held the loop past ${GAP_MS} ms (${GAP.note}) on ${SALES_ROWS} rows (worst ${sliced.ms} ms ours; longest gap ${sliced.raw} ms, ${sliced.gc} ms of it the collector)`);
    const nSync = sales.externalByNetwork({ days });
    const nSliced = await blockOf(() => sales.externalByNetworkAsync({ days }));
    ok(isDeepStrictEqual(nSliced.value, nSync), `externalByNetworkAsync({ days: ${days} }) equals externalByNetwork (worst ${nSliced.ms} ms ours)`);
  }
  // The page walk against the one-query read of the same window, straight
  // from the file: counts and per-rail totals add across the 30 pages, and a
  // buyer or tool seen on several pages is counted once. The window is read
  // just before and just after the summary; when both agree, the summary
  // must equal them.
  {
    const { PAYING_RAILS_SQL } = await import("../src/paid-rails.js");
    const ro = new Database(process.env.SALES_LEDGER_DB, { readonly: true });
    const ext = `FROM sales WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND ts >= ?`;
    const direct = (since) => ({
      buyers: ro.prepare(`SELECT COUNT(DISTINCT payer) AS n ${ext} AND payer IS NOT NULL`).get(since).n,
      tools: ro.prepare(`SELECT COUNT(DISTINCT slug) AS n ${ext}`).get(since).n,
      byRail: Object.fromEntries(ro.prepare("SELECT internal, rail, COUNT(*) AS n FROM sales WHERE ts >= ? GROUP BY internal, rail").all(since).map((r) => [`${r.internal ? "internal" : "external"}:${r.rail}`, r.n])),
      settlements: ro.prepare(`SELECT COUNT(*) AS n ${ext}`).get(since).n,
      netBuyers: ro.prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT network, payer ${ext} AND payer IS NOT NULL)`).get(since).n,
    });
    for (const days of [30, 36_500]) {
      const a = direct(Date.now() - days * 86_400_000);
      const sum = await sales.salesSummaryAsync({ days });
      const net = await sales.externalByNetworkAsync({ days });
      const b = direct(Date.now() - days * 86_400_000);
      if (!isDeepStrictEqual(a, b)) { console.log(`skip - the ${days}-day window moved a row while it was read`); continue; }
      const netSettlements = Object.values(net).reduce((t, r) => t + r.settlements, 0);
      ok(sum.distinctExternalBuyers === a.buyers && sum.distinctToolsSoldExternal === a.tools && isDeepStrictEqual(sum.totals.byRail, a.byRail) && netSettlements === a.settlements,
        `the ${days}-day page walk equals the one-query read (${a.buyers} buyers, ${a.tools} tools, ${a.settlements} external settlements)`);
      // No buyer here pays on two spellings of one rail, so the per-rail sets add up to the distinct (network, payer) pairs.
      ok(Object.values(net).reduce((t, r) => t + r.buyers, 0) === a.netBuyers, `...and its per-rail buyers count each (network, payer) once (${a.netBuyers})`);
    }
    ro.close();
  }
  const detailed = await sales.salesSummaryAsync({ days: 30, detailed: true });
  ok(isDeepStrictEqual(detailed, sales.salesSummary({ days: 30, detailed: true })), "the detailed summary is the same sliced or whole");
  // A slow host, simulated: every page of the window walk costs a quarter of
  // the bound more. The walk yields on elapsed time, so a turn still holds
  // one slice plus one page; a walk that yielded after a fixed count of
  // pages (four or more) would hold the loop past the bound here.
  const pageCost = Math.ceil(GAP_MS / 4);
  let pages = 0;
  sales._setSummaryPageCostForTests(() => { pages++; spin(pageCost); });
  try {
    for (const [name, fn] of [["salesSummaryAsync", () => sales.salesSummaryAsync({ days: 36_500 })], ["externalByNetworkAsync", () => sales.externalByNetworkAsync({ days: 36_500 })]]) {
      pages = 0;
      const slow = await blockOf(fn);
      ok(pages >= 20 && heldUnder(slow.ms, GAP_MS), `${name} with ${pageCost} ms more work per page (${pages} pages, ${pages * pageCost} ms in all) yields on elapsed time: never held the loop past ${GAP_MS} ms (worst ${slow.ms} ms ours; longest gap ${slow.raw} ms, ${slow.gc} ms of it the collector)`);
    }
  } finally { sales._setSummaryPageCostForTests(null); }
}

// --- 1b. the revenue ledger: summary, daily series, buyer events.
const rev = await import("../src/revenue-ledger.js");
{
  const db = new Database(process.env.REVENUE_LEDGER_DB);
  const W = "0x1111111111111111111111111111111111111111", SOL = "So1anaTestWa11et", XLM = "GSTELLARTESTWALLET";
  const chains = ["base", "base", "base", "base", "polygon", "arbitrum", "monad", "solana", "stellar", "optimism"];
  const nowS = Math.floor(now / 1000);
  db.prepare("INSERT OR REPLACE INTO cursors (chain, wallet, next_block, caught_up, updated_ts) VALUES (?,?,?,?,?)").run("base", W, 40_000_000, 1, nowS);
  const ins = db.prepare("INSERT OR IGNORE INTO transfers (chain, wallet, txid, tx_hash, block, when_ts, payer, usd, asset, external) VALUES (?,?,?,?,?,?,?,?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < TRANSFER_ROWS; i++) {
      const chain = chains[Math.floor(rnd() * chains.length)];
      const wallet = chain === "solana" ? SOL : chain === "stellar" ? XLM : W;
      const when = nowS - Math.floor(rnd() * 120 * 86_400);
      // Stellar amounts carry seven decimals; sums must still match SQLite's to the bit.
      const dec = chain === "stellar" ? 1e7 : 1e6;
      const usd = Math.round((rnd() < 0.02 ? rnd() * 5 : rnd() * 0.05) * dec) / dec;
      // EVM rows mostly undated (dated from block anchors), like the scanner's.
      const dated = chain === "solana" || chain === "stellar" || rnd() < 0.05;
      const tx = "0x" + i.toString(16).padStart(64, "0");
      ins.run(chain, wallet, `${tx}:0`, tx, rnd() < 0.01 ? null : 30_000_000 + Math.floor((when - (nowS - 130 * 86_400)) / 2), dated ? when : null,
        rnd() < 0.1 ? null : "0x" + Math.floor(rnd() * 600).toString(16).padStart(40, "b"), usd, "USDC", rnd() < 0.3 ? 1 : 0);
    }
  })();
  db.close();
  rev.setPayerDustFloorUsd(0.001);
  const wallets = { walletAddress: W, solanaWallet: SOL, stellarWallet: XLM, algorandWallet: null, baseExtraWallets: [], algorandExtraWallets: [] };
  const mpp = new Set(["0x" + (5).toString(16).padStart(64, "0"), "0x" + (77).toString(16).padStart(64, "0")]);
  const cases = [
    ["ledgerSummary", () => rev.ledgerSummary(wallets), () => rev.ledgerSummaryAsync(wallets)],
    ["ledgerDaily", () => rev.ledgerDaily(wallets, mpp, { withScope: true }), () => rev.ledgerDailyAsync(wallets, mpp, { withScope: true })],
    ["externalPaymentEventsFor", () => rev.externalPaymentEventsFor(wallets), () => rev.externalPaymentEventsForAsync(wallets)],
  ];
  for (const [name, whole, sliced] of cases) {
    const a = whole();
    const b = await blockOf(sliced);
    ok(isDeepStrictEqual(b.value, a), `${name}Async equals ${name} (same figures, same order) on ${TRANSFER_ROWS} transfers`);
    ok(heldUnder(b.ms, GAP_MS), `...and never held the loop past ${GAP_MS} ms (${GAP.note}) (worst ${b.ms} ms ours; longest gap ${b.raw} ms, ${b.gc} ms of it the collector)`);
  }
  // The sliced runner yields only where a step does, so no step of a read may
  // carry a whole history: the Tempo settlements (read from the sales ledger
  // and checked against the transfers, about 4,200 rows here) once ran as one
  // step, about 30 ms on a laptop, which a runner three times slower carried
  // past the bound above. A slow host, simulated: each Tempo row costs
  // 1/1024 of a step's bound more, so a step that took the whole history
  // would cost at least four bounds, while one that yields every 256 rows
  // carries a quarter of one. Timed on the ours clock (above), the fastest of
  // three runs (one run can land on a slower core of a mixed-core host).
  const tempoRows = sales.externalTempoPayments().length;
  const rowCost = STEP_BOUND_MS / 1024;
  rev._setTempoRowCostForTests(() => spin(rowCost));
  try {
    for (const kind of ["summary", "events"]) {
      const r = [0, 1, 2].map(() => rev._longestLedgerStepForTests(kind, wallets, { clock: oursMs })).reduce((p, q) => (q.longestMs < p.longestMs ? q : p));
      ok(tempoRows > 4096 && heldUnder(r.longestMs, STEP_BOUND_MS), `the ${kind === "summary" ? "ledgerSummary" : "externalPaymentEventsFor"} steps yield within the Tempo history: with ${rowCost.toFixed(3)} ms more work per Tempo row (${tempoRows} rows), the longest of ${r.steps} steps ran ${r.longestMs.toFixed(1)} ms ours (${STEP.note})`);
    }
  } finally { rev._setTempoRowCostForTests(null); }
  // The block anchors that date a chain's undated rows: read on an index that
  // walks blocks in order (on the others the read built a temp b-tree over the
  // chain's whole history, about 17 ms at 400k rows), once per chain per walk
  // however many wallets the chain carries, each read in a step of its own
  // (it once ran inside the step of a row page). The walk's clock here is the
  // read count, so each window's reading is the reads that step made.
  const plan = rev._datedPointsPlanForTests("base");
  ok(plan.some((d) => d.includes("idx_transfers_dated")) && !plan.some((d) => d.includes("TEMP B-TREE")), `the dated-points read walks idx_transfers_dated, no temp b-tree (${plan.join(" | ")})`);
  const W2 = "0x2222222222222222222222222222222222222222", W3 = "0x3333333333333333333333333333333333333333";
  {
    const extra = new Database(process.env.REVENUE_LEDGER_DB);
    const insX = extra.prepare("INSERT OR IGNORE INTO transfers (chain, wallet, txid, tx_hash, block, when_ts, payer, usd, asset, external) VALUES (?,?,?,?,?,?,?,?,?,?)");
    extra.transaction(() => {
      for (const [k, w] of [W2, W3].entries()) for (let i = 0; i < 3000; i++) {
        const tx = "0x" + (k + 1).toString(16) + i.toString(16).padStart(63, "0");
        insX.run("base", w, `${tx}:0`, tx, 30_000_000 + i * 900, null, "0x" + (i % 50).toString(16).padStart(40, "c"), 0.01, "USDC", 1);
      }
    })();
    extra.close();
  }
  const three = { ...wallets, baseExtraWallets: [W2, W3] };
  // The read is shared across a chain's wallets, and each wallet's caught-up
  // cursor ends ITS anchors only: appended to the shared read, one wallet's
  // cursor would date the next wallet's newest rows.
  {
    const cur = new Database(process.env.REVENUE_LEDGER_DB);
    const setCursor = cur.prepare("INSERT OR REPLACE INTO cursors (chain, wallet, next_block, caught_up, updated_ts) VALUES (?,?,?,?,?)");
    setCursor.run("base", W2, 40_100_000, 1, nowS - 3600);
    setCursor.run("base", W3, 40_200_000, 1, nowS);
    cur.close();
    const s = rev._sharedAnchorsForTests("base", [W2, W3]);
    const last = (a) => a[a.length - 1];
    ok(s.after === s.before && last(s.anchors[0])[0] === 40_100_000 && last(s.anchors[1])[0] === 40_200_000 && !s.anchors[1].some(([b]) => b === 40_100_000),
      `each base wallet's anchors end at its own cursor and the shared read is unchanged (${s.before} points before, ${s.after} after; ends ${last(s.anchors[0])[0]}, ${last(s.anchors[1])[0]})`);
  }
  for (const kind of ["events", "daily"]) {
    const counted = (w) => rev._longestLedgerStepForTests(kind, w, { clock: () => rev._datedPointsReadsForTests() });
    const one = counted(wallets), all = counted(three);
    const reads = (r) => r.windows.reduce((t, x) => t + x.ms, 0);
    ok(reads(one) > 0 && reads(all) === reads(one), `the ${kind} walk reads each chain's dated points once: ${reads(one)} reads with one base wallet, ${reads(all)} with three`);
    const shared = all.windows.filter((x) => x.ms > 0 && (x.fed || x.ms > 1));
    ok(shared.length === 0, `...each in a step of its own, never one that began with a wallet's rows (${shared.length} of ${all.steps} steps shared a read)`);
  }
}

// --- 1c. the index: snapshot, tool directory, seller summaries.
const x = await import("../src/x402-index.js");
const cache = x._cacheForTests();
const { ctx } = buildRoutePerfFixture({ sellers: 5800, toolsTarget: 198_000, cache: { set: (o, e) => cache.set(o, { ...e, fetchedAt: 1, history: [1] }) } });
{
  // The build time and the host's own row stamp read the clock; all else must match.
  const stripAsOf = ({ asOf: _a, sellers, ...rest }) => ({ ...rest, sellers: sellers.map((s) => (s.local ? { ...s, fetchedAt: 0 } : s)) });
  const whole = x.indexSnapshot(ctx);
  // A version bump (one entry set again, unchanged) leaves the alias walk
  // cold, so the sliced build below walks it in its own steps.
  { const [o, v] = cache.entries().next().value; cache.set(o, v); }
  const sliced = await blockOf(() => x.indexSnapshotAsync(ctx));
  ok(whole.sellers.length >= 5800 && isDeepStrictEqual(stripAsOf(sliced.value), stripAsOf(whole)), `indexSnapshotAsync equals indexSnapshot (${whole.sellers.length} sellers)`);
  ok(heldUnder(sliced.ms, GAP_MS), `...and never held the loop past ${GAP_MS} ms (${GAP.note}) (worst ${sliced.ms} ms ours)`);
}
{
  const ourTools = [];
  const cold = await blockOf(() => x.indexRowsReady({ ourTools, excludeOrigin: "" }));
  ok(heldUnder(cold.ms, GAP_MS), `a cold tool directory is built in slices, never past ${GAP_MS} ms (${GAP.note}) (worst ${cold.ms} ms ours)`);
  const digest = (r) => createHash("sha256").update(JSON.stringify([r.total, r.matched, r.described, r.results])).digest("hex");
  const sliced = [digest(x.allIndexedTools({ limit: 300, offset: 40_000 })), digest(x.allIndexedTools({ search: "json", limit: 200 }))];
  const total = x.allIndexedTools({ limit: 1 }).total;
  x._resetFlatCacheForTest(); x._resetIndexRowsForTest();
  const whole = [digest(x.allIndexedTools({ limit: 300, offset: 40_000 })), digest(x.allIndexedTools({ search: "json", limit: 200 }))];
  ok(total > 190_000 && isDeepStrictEqual(sliced, whole), `the sliced directory is the one-turn directory, row for row (${total} rows)`);
  const cats = x.indexedToolCategories("");
  ok(isDeepStrictEqual(x.indexedToolCategories(""), cats) && cats.reduce((s, c) => s + c.count, 0) === x.allIndexedTools({ limit: 1 }).thirdParty, "the category counts are memoized and still count every third-party row");
}
{
  // The directory's interleave (described rows first, each half round-robin
  // by seller, routes in order), step by step on a full directory's rows: the
  // split, the grouping and the final join each walk every row, and in one
  // step they held the loop 50 to 170 ms on a loaded runner. The rows count
  // their own field reads, so a step that walks every row is seen whatever
  // the host's speed; the step bound covers the work no field read shows.
  // The join reads no field, so it is counted in steps: the route sort is the
  // last read, and after it come the round-robin (a step per 8,192 rows it
  // places, or fewer) and the join, a step per 16,384 rows it moves. One
  // seller lists 20,000 routes (the largest production seller lists 77k):
  // its sort runs in steps of 1,024 rows, about 20k field reads each.
  let reads = 0;
  const N = 200_000, collate = new Intl.Collator().compare;
  const rows = Array.from({ length: N }, (_, i) => {
    const s = i % 10 === 0 ? "big" : String(i % 5800);
    const seller = `https://s${s}.example`, sellerName = i % 3 ? `Seller ${s}` : "", described = i % 5 < 2;
    const route = `/r${(i * 7919) % N}`;
    return { get route() { reads++; return route; }, get seller() { reads++; return seller; }, get sellerName() { reads++; return sellerName; }, get described() { reads++; return described; } };
  });
  const roundRobin = (subset) => {
    const by = new Map();
    for (const r of subset) { const k = r.sellerName || r.seller; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
    const groups = [...by.entries()].sort((a, b) => collate(String(a[0]), String(b[0]))).map(([, l]) => l.sort((a, b) => collate(String(a.route), String(b.route))));
    const out = [];
    for (let i = 0; out.length < subset.length; i++) for (const g of groups) if (i < g.length) out.push(g[i]);
    return out;
  };
  const expected = [...roundRobin(rows.filter((r) => r.described)), ...roundRobin(rows.filter((r) => !r.described))];
  const rest = rows.filter((row) => !row.described);
  const depth = Math.max(...[...Map.groupBy(rest, (row) => row.sellerName || row.seller).values()].map((g) => g.length));
  const v0 = x._interleaveVisitsForTest();
  let most = 0, steps = 0, lastRead = 0, r;
  const it = x._interleaveStepsForTest(rows);
  do { const r0 = reads; r = it.next(); most = Math.max(most, reads - r0); steps++; if (reads > r0) lastRead = steps; } while (!r.done);
  const tail = steps - lastRead, joinSlices = Math.floor(rest.length / 16384);
  ok(r.value.length === N && r.value.every((row, i) => row === expected[i]), `the sliced interleave is the one-pass interleave, row for row (${N} rows)`);
  ok(most <= 3 * 8192, `...and no step reads more than a slice of rows (most field reads in one step: ${most} of ${N} rows, over ${steps} steps)`);
  // Each row is placed once: a spent seller leaves the round list (walking
  // every seller in each round of the deepest one allocated 38% of a
  // production-sized crawl cycle, 2026-11-04).
  const visits = x._interleaveVisitsForTest() - v0, rrSlices = Math.floor(rest.length / 8192);
  ok(visits === N, `...the round-robin visits each row once (${visits} group visits for ${N} rows, ${depth} rounds deep)`);
  ok(tail >= rrSlices + joinSlices, `...and the round-robin and the join run in slices: ${tail} steps after the last field read, at least ${rrSlices} for the round-robin and ${joinSlices} for the join of ${rest.length} rows`);
  const st = await longestStep(() => x._interleaveStepsForTest(rows));
  ok(st.sameShape && heldUnder(st.longest, STEP_BOUND_MS), `...in ${st.count} steps, the longest ${st.longest.toFixed(1)} ms ours, each step its least over three walks (${STEP.note}; one walk's worst step ${st.single.toFixed(1)} ms)`);
}
{
  x.__resetRoutableSummaryMemoForTest();
  const first = x.routableSellerSummaries();
  const before = x._routableRowBuildsForTest();
  // One seller re-crawled (the crawler replaces the entry) and one added.
  const [origin, v] = [...cache.entries()].find(([o]) => o.startsWith("https://seller1"));
  cache.set(origin, { ...v, fetchedAt: 2 });
  const fresh = "https://stall-routes-new.example";
  cache.set(fresh, { ...v, manifest: { name: "stall routes new", homepage: fresh }, tools: v.tools.map((t) => ({ ...t, seller: fresh })), fetchedAt: 2 });
  // A third whose key is not the text a parser makes of it (scheme and host
  // case): its rows read the key's one kept answer too, never a parse per row.
  const upper = "HTTPS://Stall-Routes-Upper.EXAMPLE";
  cache.set(upper, { ...v, manifest: { name: "stall routes upper", homepage: upper }, tools: v.tools.map((t) => ({ ...t, seller: upper })), fetchedAt: 2 });
  // The alias walk behind the rebuild reads a host per cached origin, redirect
  // target and homepage: each is parsed once per string, never once per walk,
  // so a rebuild parses URLs for the changed sellers only.
  // A seller key's own check (isPlainSellerKey, and sellerKeyFixedAnswer for a
  // key that is not plain) is one parse each the first time a key is seen,
  // kept for the process. The route index is still adding sellers
  // in its own turns while this runs, so those first sights land in the window
  // on a slow host: they are counted apart and held to one per key, and every
  // other parse is held to the bound.
  const RealURL = globalThis.URL;
  let parses = 0;
  const keyParses = [];
  globalThis.URL = class extends RealURL {
    constructor(...args) {
      const reader = /\b(isPlainSellerKey|sellerKeyFixedAnswer)\b/.exec(String(new Error().stack));
      if (reader) keyParses.push(`${reader[1]} ${String(args[0])}`); else parses++;
      super(...args);
    }
  };
  let rebuilt;
  try { rebuilt = await blockOf(() => x.routableSellerSummaries()); } finally { globalThis.URL = RealURL; }
  const projected = x._routableRowBuildsForTest() - before;
  ok(rebuilt.value.length === first.length + 2 && projected === 3, `a seller-summary rebuild projects only the changed sellers (${projected} of ${rebuilt.value.length})`);
  const upperRows = v.tools.length;
  // The same rows read directly: a first sight parses the key, a second read of
  // every row parses nothing.
  const direct = v.tools.map((t) => ({ ...t, seller: "Https://Stall-Routes-Upper-Direct.EXAMPLE:8443/App" }));
  for (const t of direct) x._computeToolStaticsForTest(t);
  const p0 = parses, k0 = keyParses.length;
  globalThis.URL = class extends RealURL { constructor(...args) { parses++; super(...args); } };
  let offDirect;
  try { offDirect = direct.map((t) => x._computeToolStaticsForTest(t).offSeller); } finally { globalThis.URL = RealURL; }
  const perRow = parses - p0;
  parses = p0; keyParses.length = k0;
  ok(upperRows >= 10 && perRow === 0 && offDirect.every((o) => o === false), `...the ${upperRows} rows of a seller whose key is written in another case parse nothing per row (${perRow} parses)`);
  ok(parses <= 16, `...and parses URLs for the changed sellers only (${parses} parses over ${rebuilt.value.length} sellers)`);
  ok(new Set(keyParses).size === keyParses.length, `...and a seller key is parsed once by each of its two checks, the first time it is seen (${keyParses.length} first sights, ${new Set(keyParses).size} distinct)`);
  ok(keyParses.some((k) => k === `sellerKeyFixedAnswer ${upper}`) || x._routeLeavesSellerForTest(upper, "/x") === false, "...the key written in another case among them, read as under its seller");
  ok(heldUnder(rebuilt.ms, GAP_MS), `...and never held the loop past ${GAP_MS} ms (${GAP.note}) (worst ${rebuilt.ms} ms ours; longest gap ${rebuilt.raw} ms, ${rebuilt.gc} ms of it the collector)`);
  cache.delete("https://stall-routes-new.example");
  cache.delete(upper);
}

// --- 1d. /marketplace: the all-chains page in slices, byte for byte.
const mp = await import("../src/market-page.js");
{
  // The production shape the page joins on: sellers on several chains, a
  // leaderboard naming some of their wallets (grouped hosts collapse), and the
  // dispatch labels the server adds (every badge variant).
  const snap = x.indexSnapshot(ctx);
  const nets = [["eip155:8453"], ["eip155:8453", "eip155:137"], ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"], ["eip155:42161", "eip155:8453"], ["stellar:pubnet"], ["eip155:143"]];
  const reasons = ["eligible", "settlement_required", "crawl_failed", "no_supported_route"];
  const sellersLabelled = snap.sellers.map((s, i) => (s.local ? s : {
    ...s,
    networks: nets[i % nets.length],
    payToByNetwork: Object.fromEntries(nets[i % nets.length].map((n) => [n, "0x" + String(i % 4000).padStart(40, "0")])),
    routerDispatchEligible: i % 4 === 0,
    routerDispatchReason: reasons[i % 4],
    routerDispatchByChain: i % 4 === 0 ? { base: { eligible: true, reason: "eligible" } } : {},
    ...(i % 9 === 0 ? { mpp: true } : {}),
    ...(i % 13 === 0 ? { paidToolCount: 1 } : {}),
  }));
  const labelled = { ...snap, sellers: sellersLabelled };
  const leaderboard = Array.from({ length: 900 }, (_, i) => ({ wallet: "0x" + String(i * 3).padStart(40, "0"), wallets: i % 10 === 0 ? ["0x" + String(i * 3).padStart(40, "0"), "0x" + String(i * 3 + 1).padStart(40, "0")] : undefined, callsSettled: 5000 - i * 5, totalUsd: 900 - i, uniqueBuyers: 1 + (i % 40) }));
  const leaderboardSnap = { leaderboard, windowLabel: "24h" };
  const economySnap = null;
  for (const all of [false, true]) {
    const opts = { snapshot: labelled, leaderboardSnap, economySnap, all, wallet: "0x" + "9".repeat(40), host: null, routerChains: ["base", "solana"], chainsOffered: 12, tempo: true };
    const t0 = performance.now();
    const whole = mp.marketPage(null, "https://agent402.tools", opts);
    const oneTurnMs = Math.round(performance.now() - t0);
    const sliced = await blockOf(() => mp.marketPageAsync(null, "https://agent402.tools", opts));
    ok(sliced.value === whole && whole.length > 100_000, `/marketplace${all ? "?all=1" : ""}: the sliced page is the one-turn page, byte for byte (${whole.length} chars, ${labelled.sellers.length} sellers)`);
    // The page's own work per step, timed step by step: no step is more than
    // a fraction of the whole page (the loop-lag figure below also carries
    // the garbage collector's tasks, which run between turns either way).
    // Read before the loop-lag pin: its bound is the tighter one, so a hold
    // planted in one step fails here by a wide margin, not there by a narrow one.
    // A collector pause that lands inside a step is the runtime's, not the
    // step's work, so it is subtracted the same way blockOf does.
    const st = await longestStep(() => mp._marketPageAllStepsForTest("https://agent402.tools", opts));
    ok(st.sameShape && st.values.every((v) => v === whole) && st.count > 20 && heldUnder(st.longest, STEP_BOUND_MS), `...in ${st.count} steps, the longest ${st.longest.toFixed(1)} ms ours, each step its least over three walks (${STEP.note}; one walk's worst step ${st.single.toFixed(1)} ms; longest raw step ${st.longestRaw.toFixed(1)} ms, ${st.longestGc.toFixed(1)} ms of it the collector)`);
    ok(heldUnder(sliced.ms, GAP_MS), `...and never held the loop past ${GAP_MS} ms (${GAP.note}) (worst ${sliced.ms} ms ours; longest gap ${sliced.raw} ms, ${sliced.gc} ms of it the collector; the page in one turn: ${oneTurnMs} ms)`);
    // Every loop over the roster yields, and that is pinned by count, not only
    // by time: a loop that stopped yielding costs a step a few milliseconds
    // here, well inside the step bound. The page over half the sellers against
    // the whole: each roster loop that yields adds a step per 250 rows
    // (PAGE_YIELD_ROWS in src/market-page.js), so the difference counts them.
    const halfN = Math.floor(labelled.sellers.length / 2);
    const halfOpts = { ...opts, snapshot: { ...labelled, sellers: labelled.sellers.slice(0, halfN) } };
    let halfCount = 1;
    for (const it = mp._marketPageAllStepsForTest("https://agent402.tools", halfOpts); !it.next().done;) halfCount++;
    const perLoop = Math.floor((labelled.sellers.length - halfN) / 250);
    const loops = (st.count - halfCount) / perLoop;
    const LOOPS = all ? MARKET_ROSTER_LOOPS_ALL : MARKET_ROSTER_LOOPS;
    ok(loops >= LOOPS, `...and each of its ${LOOPS} roster loops yields every 250 rows: ${st.count} steps over ${labelled.sellers.length} sellers, ${halfCount} over ${halfN} (${loops.toFixed(2)} loops' worth)`);
  }
  ok(mp.marketPage("base", "https://agent402.tools", { snapshot: labelled, leaderboardSnap }) === await mp.marketPageAsync("base", "https://agent402.tools", { snapshot: labelled, leaderboardSnap }), "a chain view through marketPageAsync is marketPage's");
}

// --- 1e. the warm start: page readers share one snapshot.
{
  const ndjson = join(dir, "warm-share.ndjson");
  const rows = [...cache.entries()].map(([o, v]) => JSON.stringify([o, v]));
  writeFileSync(ndjson, [JSON.stringify({ savedAt: now, format: "ndjson-v1", origins: rows.length }), ...rows].join("\n") + "\n");
  rows.length = 0;
  cache.clear();
  const builds0 = x._indexSnapshotBuildsForTest();
  let turns = 0, shared = true, readerWorst = 0, readerWorstWall = 0, inLine = 0;
  gaps = []; last = performance.now();
  const warming = x.loadPersistedIndexCacheAsync(ndjson);
  // Each turn of the warm start: the nav strip, the page and a second page
  // read the snapshot, as three HTML requests landing in one turn would.
  while (x.indexWarmStartInProgress()) {
    const t = performance.now(), c0 = oursMs();
    const before = x._indexSnapshotBuildsForTest();
    const a = x.warmStartSnapshot(ctx), b = x.warmStartSnapshot(ctx), c = x.warmStartSnapshot(ctx);
    if (!(a === b && b === c)) shared = false;
    // A build that finishes inside the readers' turn is an in-line build; the
    // sliced rebuild only starts here and finishes over later turns.
    if (x._indexSnapshotBuildsForTest() - before > 1) inLine++;
    // Ours, as blockOf reads a gap (the wall time is printed).
    readerWorst = Math.max(readerWorst, Math.min(performance.now() - t, oursMs() - c0));
    readerWorstWall = Math.max(readerWorstWall, performance.now() - t);
    turns++;
    await new Promise((r) => setImmediate(r));
  }
  const loaded = await warming;
  await new Promise((r) => setTimeout(r, 5));
  const warmWorst = Math.round(Math.max(0, ...gaps.map(([g0, g1]) => g1 - g0)));
  gaps = null;
  const builds = x._indexSnapshotBuildsForTest() - builds0;
  ok(loaded >= 5800 && turns >= 10, `a warm start of ${loaded} sellers ran over ${turns} turns with readers in each`);
  ok(shared && inLine === 0, "every reader in one turn got the same snapshot, and no turn built more than one");
  ok(builds < turns, `the readers of ${turns} turns shared ${builds} snapshot builds (each reader used to build its own: ${turns * 3})`);
  // The loop's own worst block over the warm start is printed, not bounded:
  // it is mostly the loader's batches, which this file does not pin.
  ok(heldUnder(readerWorst, GAP_MS), `...and the readers' longest turn was ${Math.round(readerWorst)} ms ours (${GAP.note}; ${Math.round(readerWorstWall)} ms of wall time; the loop's longest block over the warm start, loader batches included: ${warmWorst} ms)`);
  ok(isDeepStrictEqual(x.warmStartSnapshot(ctx).sellers.length, x.indexSnapshot(ctx).sellers.length), "after the warm start a reader builds from the whole cache");
}

clearInterval(lagTimer);

// --- 2. booted at production scale.
{
  const lines = [];
  buildRoutePerfFixture({ sellers: 5800, toolsTarget: 198_000, cache: { set: (o, e) => lines.push(JSON.stringify([o, { ...e, fetchedAt: now, source: "manifest" }])) } });
  writeFileSync(join(dir, "x402-index-cache.ndjson"), [JSON.stringify({ savedAt: now, format: "ndjson-v1", origins: lines.length }), ...lines].join("\n") + "\n");
  lines.length = 0;
}
const TOKEN = "stall-routes-operator-token-0123456789";
// The booted server's holds are read on the same ours clock as section 1's,
// by a probe preloaded into its main thread and asked over the IPC channel:
// its own loop-lag figure (/__operator/perf.json) is wall time, which a busy
// host stretches without any of the route's work in it (a /marketplace?all=1
// first request read 1,323 ms there). The wall figure is still printed.
const HOLD_PROBE = join(dir, "hold-probe.mjs");
writeFileSync(HOLD_PROBE, `import { readFileSync } from "node:fs";
import { PerformanceObserver } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";
if (isMainThread && typeof process.send === "function") {
  const p = "/proc/self/task/" + process.pid + "/schedstat";
  let sched = null; try { if (/^\\d+ \\d+ \\d+/.test(readFileSync(p, "utf8"))) sched = p; } catch {}
  const cpu = () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; };
  const ours = sched ? () => performance.now() - Number(readFileSync(sched, "utf8").split(" ")[1]) / 1e6 : cpu;
  const gcs = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { gcs.push([e.startTime, e.startTime + e.duration]); if (gcs.length > 4000) gcs.shift(); } }).observe({ entryTypes: ["gc"] });
  let gaps = [], last = performance.now(), lastOurs = ours();
  setInterval(() => { const t = performance.now(), o = ours(); if (t - last > 2) { gaps.push([last, t, o - lastOurs]); if (gaps.length > 20000) gaps.shift(); } last = t; lastOurs = o; }, 1).unref();
  const baselineJob = ${baselineJob.toString()};
  process.on("message", (m) => {
    if (m === "hold:reset") { gaps = []; process.send({ hold: "reset" }); return; }
    if (m === "hold:baseline") { process.send({ hold: "baseline", ms: baselineJob(ours) }); return; }
    if (m !== "hold:read") return;
    let worst = 0, wall = 0, wallGc = 0;
    for (const [a, b, o] of gaps) {
      let g = 0;
      for (const [s0, e0] of gcs) g += Math.max(0, Math.min(b, e0) - Math.max(a, s0));
      worst = Math.max(worst, Math.min(b - a, o) - g);
      if (b - a > wall) { wall = b - a; wallGc = g; }
    }
    process.send({ hold: "read", worstMs: Math.round(Math.max(0, worst)), wallMs: Math.round(wall), wallGcMs: Math.round(wallGc), reading: sched ? "ours" : "thread CPU" });
  });
}
`);
const port = await getFreePort();
const proc = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "", INDEX_CACHE_FILE: join(dir, "x402-index-cache.json"), INDEX_FIRST_CRAWL_DELAY_MS: "999999999",
    ROUTE_INDEX_WARM_DELAY_MS: "0", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", STATE_DATABASE_URL: "", ROUTER_WORKERS: "0",
    AGENT402_OPERATOR_TOKEN: TOKEN, STATS_DB_DIR: dir, LOOP_LAG_TICK_MS: "5", LAZY_DEPS_WARM: "off",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import ${JSON.stringify(HOLD_PROBE).slice(1, -1)}`.trim(),
  },
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
serverProc = proc;
const base = `http://127.0.0.1:${port}`;
const op = { headers: { authorization: `Bearer ${TOKEN}` } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serverHold = (cmd) => new Promise((resolve, reject) => {
  const want = cmd.slice("hold:".length);
  const timer = setTimeout(() => { proc.off("message", on); reject(new Error(`the hold probe did not answer ${cmd}`)); }, 10_000);
  function on(m) { if (m?.hold === want) { clearTimeout(timer); proc.off("message", on); resolve(m); } }
  proc.on("message", on);
  proc.send(cmd);
});
try {
  let up = false;
  for (let i = 0; i < 240 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await sleep(500); } }
  ok(up, "server booted");
  let sellers = 0;
  for (let i = 0; i < 240 && sellers < 5700; i++) {
    try { sellers = (await (await fetch(`${base}/__operator/heap.json`, op)).json()).index?.entries || 0; } catch { /* warming */ }
    if (sellers < 5700) await sleep(500);
  }
  ok(sellers >= 5700, `the index warm-started at production size (${sellers} sellers)`);
  // Boot work (the route index, the warmers) finishes before the routes are
  // measured: wait for three quiet seconds in a row.
  let quiet = 0;
  // Read on the probe's ours clock, as the routes are: the server's own wall
  // figure never reads quiet on a host busy with other work.
  for (let i = 0; i < 120 && quiet < 3; i++) {
    await serverHold("hold:reset");
    await sleep(1000);
    quiet = (await serverHold("hold:read")).worstMs < 40 ? quiet + 1 : 0;
  }
  ok(quiet >= 3, "boot work settled before the routes are measured");
  // Bounded: the routes whose first request built a ledger or index figure
  // in its own turn (measured here before the change: 200-370 ms on a chain
  // page, 800 ms on the directory, 220 ms on /leaderboard). The rest are read
  // once for their status: their figures are pinned in section 1.
  const routes = ["/base", "/polygon", "/solana", "/monad", "/marketplace", "/marketplace?all=1", "/marketplace/tools", "/marketplace/tools?q=json", "/leaderboard", "/api/sales"];
  // One request with the server's hold while it ran, and the bound from the
  // server's own baseline taken just before and just after (the larger).
  const heldBy = async (request) => {
    const before = (await serverHold("hold:baseline")).ms;
    await fetch(`${base}/__operator/perf.json?reset=1`, op);
    await serverHold("hold:reset");
    const out = await request();
    await sleep(300);
    // Our code's hold: the probe's worst gap on the ours clock, less the
    // collector's share of it. The server's own wall figure is printed.
    const h = await serverHold("hold:read");
    const { worstMs, worstGcMs = 0 } = (await (await fetch(`${base}/__operator/perf.json`, op)).json()).loop;
    const after = (await serverHold("hold:baseline")).ms;
    return { ...out, h, worstMs, worstGcMs, limit: boundAt(ROUTE_FLOOR_MS, ROUTE_K_SERVER, Math.max(before, after)) };
  };
  for (const r of routes) {
    const { resp, h, worstMs, worstGcMs, limit } = await heldBy(async () => { const resp = await fetch(base + r); await resp.arrayBuffer(); return { resp }; });
    ok(resp.status === 200 && heldUnder(h.worstMs, limit.ms), `GET ${r}, the first request after boot: 200, the loop held at most ${h.worstMs} ms ${h.reading} (${limit.note}, the server's own; longest gap ${h.wallMs} ms, ${h.wallGcMs} ms of it the collector; the server's wall figure ${worstMs} ms, ${worstGcMs} ms of it the collector)`);
  }
  {
    // The operator's sales page reads the detailed summary across turns too,
    // and it is the ledger's own detailed summary.
    const { resp, body, h, limit } = await heldBy(async () => { const resp = await fetch(`${base}/__operator/sales.json`, op); return { resp, body: await resp.json() }; });
    ok(resp.status === 200 && heldUnder(h.worstMs, limit.ms), `GET /__operator/sales.json: 200, the loop held at most ${h.worstMs} ms ${h.reading} (${limit.note}, the server's own; longest gap ${h.wallMs} ms)`);
    const { mppAgentsThisWeek, feedback, ...summary } = body;
    const direct = JSON.parse(JSON.stringify(sales.salesSummary({ days: 30, detailed: true })));
    ok(isDeepStrictEqual(summary.totals, direct.totals) && summary.distinctExternalBuyers === direct.distinctExternalBuyers && isDeepStrictEqual(summary.repeatBuyers, direct.repeatBuyers) && feedback && "mppAgentsThisWeek" in body,
      "/__operator/sales.json carries the ledger's detailed summary, feedback and the weekly MPP count");
  }
  {
    // Neither ledger read behind a request runs the one-turn walk: the
    // operator's sales page awaits the sliced summary, and a cold shared
    // reading starts the sliced build instead of reading in line.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
    const route = src.slice(src.indexOf('app.get("/__operator/sales.json"'), src.indexOf('app.get("/__operator/sales.json"') + 1400);
    ok(/await salesSummaryAsync\(\{ detailed: true \}\)/.test(route) && !/[^a-zA-Z]salesSummary\(/.test(route), "/__operator/sales.json awaits salesSummaryAsync, never the one-turn salesSummary");
    // Its weekly MPP count reads the current week alone: the weekly series
    // behind it scans every payer's history (two whole-ledger reads in line).
    ok(/mppAgentsThisWeekCount\(\)/.test(route) && !/mppAgentsWeekly\(/.test(route), "/__operator/sales.json counts this week's MPP agents without the whole-history series");
    const cold = src.slice(src.indexOf("function currentLedgerFigures()"), src.indexOf("const ledgerFiguresBoot"));
    ok(cold.length > 0 && !/salesSummary\(|externalByNetwork\(/.test(cold) && /refreshLedgerFigures\(\)/.test(cold), "a cold shared ledger reading starts the sliced build, never a one-turn read");
    ok(/await Promise\.race\(\[ledgerFiguresBoot,/.test(src) && src.indexOf("await Promise.race([ledgerFiguresBoot,") < src.indexOf("const httpServer = app.listen("), "the first shared ledger reading is awaited (bounded) before the server listens");
  }
  {
    // The shared labelled snapshot reaches the page: every external row of the
    // full roster carries its dispatch badge, the host's row none.
    const html = await (await fetch(`${base}/marketplace?all=1`)).text();
    const rows = (html.match(/data-mfb-row data-local="0"/g) || []).length;
    const badges = (html.match(/class="mlr-dispatch/g) || []).length;
    ok(rows >= 5700 && badges === rows, `/marketplace?all=1 labels every external seller row (${badges} badges on ${rows} rows)`);
  }
  for (const r of ["/", "/api/stats", "/revenue", "/api/revenue", "/api/index/tools?q=weather"]) {
    ok((await fetch(base + r)).status === 200, `GET ${r} answers 200 on the production-sized boot`);
  }
  // The shared ledger figures are the ledger's own.
  const apiSales = await (await fetch(`${base}/api/sales`)).json();
  ok(isDeepStrictEqual(apiSales, JSON.parse(JSON.stringify(sales.salesSummary({ days: 30 })))), "/api/sales equals a direct salesSummary of the same ledger");
  const me = await (await fetch(`${base}/api/index?seller=agent402.tools`)).json();
  const { hostFigures, hostIndexEntry } = await import("../src/host-entry.js");
  const want = hostIndexEntry(hostFigures({ summaryFn: sales.salesSummary, byNetworkFn: sales.externalByNetwork, toolCount: me.toolCount, baseUrl: me.origin }));
  ok(me.self === true && isDeepStrictEqual(me.external, want.external), "the host entry's figures equal a direct read of the ledger");
} finally {
  proc.kill("SIGKILL");
}
console.log(`test-stall-routes: ${n} passed`);
process.exit(0);
