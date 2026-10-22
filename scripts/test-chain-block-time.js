// Base block time across the Denim upgrade (2 s -> 200 ms), offline.
//
// Every depth, margin and span the scanners use on Base is a wall-clock
// quantity written in seconds and counted in blocks at the block time in
// force (src/chain-block-time.js). This runs a simulated chain whose headers
// carry whole-second timestamps (after the fork, five blocks share each one)
// before and after its activation, and requires:
//   * the activation switch per network (Sepolia default, mainnet unset);
//   * the measured rate, and which source wins when;
//   * every window covering the same wall-clock time on both sides;
//   * the ledger's real sync path counting its head margin at the live rate.
// An optional live read of Base Sepolia block times runs outside CI only and
// is skipped when unreachable; nothing here depends on it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-blocktime-"));
process.env.REVENUE_LEDGER_DB = join(dir, "revenue.db");
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
delete process.env.BASE_DENIM_ACTIVATION_TIMESTAMP;
delete process.env.BASE_SEPOLIA_DENIM_ACTIVATION_TIMESTAMP;
delete process.env.ALCHEMY_API_KEY;

const T = await import("../src/chain-block-time.js");
const { rpcHeaderReader, createBlockClock } = await import("../src/block-clock.js");

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed++; };

const SEPOLIA_ACT_MS = Date.parse("2026-10-21T18:00:00Z");

// A chain: 2 s blocks up to the fork timestamp, 200 ms after. Header
// timestamps are whole seconds, so after the fork five blocks share each.
function fakeChain({ forkSec, nowSec, head = 40_000_000 }) {
  // Number of the first block at or after the fork.
  const afterBlocks = Math.max(0, Math.floor((nowSec - forkSec) / 0.2));
  const forkN = head - afterBlocks;
  const ts = (n) => (n >= forkN ? Math.floor(forkSec + (n - forkN) * 0.2) : Math.floor(forkSec - (forkN - n) * 2));
  const getHeader = async (n) => {
    const num = n === "latest" ? head : Number(n);
    if (num < 0 || num > head) throw new Error("no such block");
    return { number: num, timestamp: ts(num) };
  };
  return { head, ts, getHeader, forkN };
}

// ---- 1. the activation switch ------------------------------------------------
eq(T.denimActivationMs("base-sepolia", {}), SEPOLIA_ACT_MS, "Base Sepolia activates 2026-10-21T18:00:00Z by default");
eq(T.denimActivationMs("eip155:84532", {}), SEPOLIA_ACT_MS, "...by its CAIP-2 id too");
eq(T.denimActivationMs("base", {}), null, "mainnet has no activation until one is set");
eq(T.denimActivationMs("base", { BASE_DENIM_ACTIVATION_TIMESTAMP: "2026-11-18T17:00:00Z" }), Date.parse("2026-11-18T17:00:00Z"), "mainnet takes an ISO time");
eq(T.denimActivationMs("base", { BASE_DENIM_ACTIVATION_TIMESTAMP: "1795000000" }), 1_795_000_000_000, "...or unix seconds");
eq(T.denimActivationMs("base-sepolia", { BASE_SEPOLIA_DENIM_ACTIVATION_TIMESTAMP: "off" }), null, "\"off\" clears the Sepolia default");
eq(T.denimActivationMs("base", { BASE_DENIM_ACTIVATION_TIMESTAMP: "soon" }), null, "an unreadable value is no activation (never a guess)");
eq(T.denimActivationMs("optimism", {}), null, "chains without the upgrade have none");
eq(T.scheduledBlockMs("base-sepolia", { atMs: SEPOLIA_ACT_MS - 1, env: {} }), 2000, "Sepolia: 2 s up to the activation");
eq(T.scheduledBlockMs("base-sepolia", { atMs: SEPOLIA_ACT_MS, env: {} }), 200, "Sepolia: 200 ms from the activation instant");
eq(T.scheduledBlockMs("base", { atMs: Date.parse("2027-06-01"), env: {} }), 2000, "mainnet with no activation set stays on its schedule's 2 s");
eq(T.scheduledBlockMs("arbitrum", { env: {} }), 250, "other chains read the nominal table");

// ---- 2. measurement on a fake chain, several blocks per timestamp -------------
{
  T.resetBlockMsMeasurements();
  const forkSec = 1_800_000_000, env = {};
  const pre = fakeChain({ forkSec, nowSec: forkSec - 3600 });
  // pre-fork: the head is before forkSec, so every block is 2 s.
  const preChain = { getHeader: async (n) => { const num = n === "latest" ? 40_000_000 : Number(n); return { number: num, timestamp: (forkSec - 3600) - (40_000_000 - num) * 2 }; } };
  const r1 = await T.refreshBlockMs("base", preChain.getHeader, { now: (forkSec - 3600) * 1000 });
  eq(Math.round(r1.ms), 2000, "before the fork the measured rate is 2000 ms");
  eq(T.blockMs("base", { now: (forkSec - 3600) * 1000, env }), 2000, "...and blockMs reads 2000");
  void pre;

  const post = fakeChain({ forkSec, nowSec: forkSec + 3600 });
  const tsHead = post.ts(post.head), ts5 = [0, 1, 2, 3, 4].map((i) => post.ts(post.head - i));
  ok(new Set(ts5).size <= 2, `after the fork several blocks share one whole-second timestamp (${ts5.join(",")})`);
  const r2 = await T.refreshBlockMs("base", post.getHeader, { now: (forkSec + 3600) * 1000 });
  ok(Math.abs(r2.ms - 200) <= 2, `after the fork the measured rate is 200 ms over 1,000 blocks (${r2.ms})`);
  eq(T.blockMs("base", { now: (forkSec + 3600) * 1000, env }), 200, "mainnet with no activation set moves to 200 ms on the measurement alone");
  void tsHead;

  // Throttle: a second refresh inside the interval reuses the sample.
  let calls = 0;
  await T.refreshBlockMs("base", async (n) => { calls++; return post.getHeader(n); }, { now: (forkSec + 3600) * 1000 + 1000 });
  eq(calls, 0, "a refresh inside MEASURE_EVERY_MS reads nothing");

  // Stale measurement: the schedule is back in charge.
  eq(T.blockMs("base", { now: (forkSec + 3600) * 1000 + T.MEASURE_FRESH_MS + 1, env }), 2000, "a stale measurement is not used (schedule again)");

  // Unreadable chain: never throws, keeps what it had.
  T.resetBlockMsMeasurements();
  const dead = await T.refreshBlockMs("base", async () => { throw new Error("down"); }, { now: Date.now() });
  eq(dead, null, "an unreadable chain records nothing and does not throw");
  eq(T.blockMs("base", { env: {} }), 2000, "...and the schedule answers");
}

// ---- 3. which source wins across a scheduled activation -------------------------
{
  T.resetBlockMsMeasurements();
  const actSec = 1_800_000_000, env = { BASE_DENIM_ACTIVATION_TIMESTAMP: String(actSec) };
  // A pure 2 s sample taken just before the activation...
  const before = { getHeader: async (n) => { const num = n === "latest" ? 50_000 : Number(n); return { number: num, timestamp: (actSec - 60) - (50_000 - num) * 2 }; } };
  await T.refreshBlockMs("base", before.getHeader, { now: (actSec - 60) * 1000, force: true });
  eq(T.blockMs("base", { now: (actSec - 30) * 1000, env }), 2000, "before the activation: 2000 (measured and scheduled agree)");
  eq(T.blockMs("base", { now: (actSec + 30) * 1000, env }), 200, "30 s after it, a still-fresh sample from before it is ignored: the schedule's 200 wins");
  // A sample straddling the activation.
  const straddle = fakeChain({ forkSec: actSec, nowSec: actSec + 100 });
  await T.refreshBlockMs("base", straddle.getHeader, { now: (actSec + 100) * 1000, force: true });
  const m = T.blockMsMeasurement("base");
  ok(m.fromSec < actSec && m.toSec >= actSec && m.ms > 300 && m.ms < 1900, `a sample straddling the fork mixes the rates (${Math.round(m.ms)} ms)`);
  eq(T.blockMs("base", { now: (actSec + 100) * 1000, env }), 200, "...and is not used: 200");
  // The activation was announced but the fork slipped: a pure 2 s sample after it wins.
  const slipped = { getHeader: async (n) => { const num = n === "latest" ? 90_000 : Number(n); return { number: num, timestamp: (actSec + 7200) - (90_000 - num) * 2 }; } };
  await T.refreshBlockMs("base", slipped.getHeader, { now: (actSec + 7200) * 1000, force: true });
  eq(T.blockMs("base", { now: (actSec + 7200) * 1000, env }), 2000, "a fork that slipped past its configured time: the chain's own 2 s sample wins");
  // Jitter inside 20% reads as the scheduled value.
  T.noteBlockSample("base", { number: 0, timestamp: actSec + 10 }, { number: 1000, timestamp: actSec + 10 + 210 }, { now: (actSec + 300) * 1000 });
  eq(T.blockMs("base", { now: (actSec + 300) * 1000, env }), 200, "a measured 210 ms reads as the scheduled 200 (stable counts)");
}

// ---- 4. every window covers the same wall-clock time on both sides -------------
T.resetBlockMsMeasurements();
const { EVM, resumeOverlapBlocks, RESUME_OVERLAP_SECONDS } = await import("../src/revenue-live.js");
const RL = await import("../src/revenue-ledger.js");
const { EVM_LOGS_PUBLICS, laneDepthBlocks, evmLogsRead } = await import("../src/evm-logs-rpc.js");
const { resolveScanWindow, fundingWindowBlocks, chainScanConfig, FUNDING_DEFAULTS } = await import("../src/leaderboard.js");

const sides = [
  { name: "before Denim", set: () => { delete process.env.BASE_DENIM_ACTIVATION_TIMESTAMP; }, ms: 2000 },
  { name: "after Denim", set: () => { process.env.BASE_DENIM_ACTIVATION_TIMESTAMP = "2020-01-01T00:00:00Z"; }, ms: 200 },
];
const seen = {};
for (const side of sides) {
  T.resetBlockMsMeasurements();
  side.set();
  eq(RL.LEDGER_BLOCK_MS.base, side.ms, `${side.name}: LEDGER_BLOCK_MS.base reads the live rate (${side.ms})`);
  const span = EVM.base.span, depth = RL.publicDepthBlocks("base"), margin = RL.headMarginBlocks("base");
  const laneDepth = laneDepthBlocks(EVM_LOGS_PUBLICS.base[0], "base"), overlap = resumeOverlapBlocks("base");
  const lbSpan = chainScanConfig("base").spanBlocks;
  const secs = (b) => (b * side.ms) / 1000;
  eq(secs(span), 60_000, `${side.name}: the live view's Base span is ${span} blocks = 60,000 s`);
  eq(secs(lbSpan), 60_000, `${side.name}: the leaderboard's per-chain span reads the same`);
  eq(secs(depth), RL.LEDGER_PUBLIC_DEPTH_SECONDS, `${side.name}: the ledger's public depth is ${depth} blocks = one hour`);
  eq(secs(margin), RL.LEDGER_HEAD_MARGIN_SECONDS, `${side.name}: the head margin is ${margin} blocks = 10 s`);
  eq(secs(laneDepth), 18_000, `${side.name}: the public Base lane's depth is ${laneDepth} blocks = 5 h`);
  eq(secs(overlap), RESUME_OVERLAP_SECONDS, `${side.name}: a resumed activity scan overlaps ${overlap} blocks = 2 min`);
  // Same lanes: every getLogs window stays within the 9,000-block range cap.
  const chunk = RL.ledgerChunkBlocks(EVM.base);
  ok(chunk <= EVM_LOGS_PUBLICS.base[0].maxRange && chunk <= 9000, `${side.name}: the ledger chunk (${chunk}) stays inside the public lane's range cap`);
  seen[side.name] = { span, depth, margin, laneDepth };
}
eq(seen["after Denim"].span, seen["before Denim"].span * 10, "the Base span in blocks is ten times wider after Denim");
eq(seen["before Denim"].span, 30_000, "...and exactly the 30,000 it was before");
eq(seen["before Denim"].laneDepth, 9_000, "the public lane's depth is exactly the 9,000 blocks it was before");
eq(seen["before Denim"].margin, 5, "the head margin is exactly the 5 blocks it was before");
eq(seen["before Denim"].depth, 1800, "the public depth is exactly the 1,800 blocks it was before");

// The public lane's depth gate through evmLogsRead itself: a range 30 min
// behind the head is a public read after Denim (9,000 blocks) as it was
// before (900 blocks).
for (const side of sides) {
  T.resetBlockMsMeasurements();
  side.set();
  const head = 50_000_000, back = Math.round(1800_000 / side.ms);
  let publicHits = 0;
  const lanes = [{ url: "https://lane.invalid", maxRange: 9_000, maxDepthSeconds: 18_000 }];
  const fetchImpl = async (_u, init) => {
    publicHits++;
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify(body.map((b) => ({ jsonrpc: "2.0", id: b.id, result: b.method === "eth_blockNumber" ? "0x" + head.toString(16) : [] }))), { status: 200 });
  };
  const from = head - back;
  const filter = { address: "0x" + "1".repeat(40), topics: ["0x" + "2".repeat(64)], fromBlock: "0x" + from.toString(16), toBlock: "0x" + (from + 100).toString(16) };
  await evmLogsRead(filter, { caller: "test", chain: "base", rpcs: [], head, lanes, fetchImpl, fallback: async () => [] });
  eq(publicHits, 1, `${side.name}: a range 30 min behind the head goes to the public lane (${back} blocks back)`);
  const deep = head - Math.round(6 * 3600_000 / side.ms);
  publicHits = 0;
  await evmLogsRead({ ...filter, fromBlock: "0x" + deep.toString(16), toBlock: "0x" + (deep + 100).toString(16) }, { caller: "test", chain: "base", rpcs: [], head, lanes, fetchImpl, fallback: async () => [] });
  eq(publicHits, 0, `${side.name}: a range 6 h behind stays on the configured list`);
}

// Leaderboard: a pinned span reports its window at the measured rate.
for (const [name, forkOffset] of [["before Denim", -86_400 * 30], ["after Denim", 86_400]]) {
  const nowSec = 1_800_000_000;
  const c = forkOffset < 0
    ? { getHeader: async (n) => { const num = n === "latest" ? 40_000_000 : Number(n); return { number: num, timestamp: nowSec - (40_000_000 - num) * 2 }; } }
    : fakeChain({ forkSec: nowSec - forkOffset, nowSec });
  const w = await resolveScanWindow(createBlockClock(c.getHeader), { spanBlocks: 43_200, chain: { key: "base" } }, async () => "0x0");
  const want = forkOffset < 0 ? 86_400 : 8_640;
  ok(Math.abs(w.windowSeconds - want) <= want * 0.01, `${name}: a pinned 43,200-block span reports ${w.windowSeconds} s (want ${want}), not a fixed 2 s each`);
}
// Funding windows on an unreadable chain after Denim keep 30 and 45 days.
{
  T.resetBlockMsMeasurements();
  process.env.BASE_DENIM_ACTIVATION_TIMESTAMP = "2020-01-01T00:00:00Z";
  const f = await fundingWindowBlocks(createBlockClock(async () => { throw new Error("down"); }), 50_000_000, 1_800_000_000, "base");
  ok(f.bazaarWindowBlocks * 0.2 >= 30 * 86_400 && f.knownTtlBlocks * 0.2 >= 45 * 86_400, `unreadable chain after Denim: the floors are 30 and 45 days at 200 ms (${f.bazaarWindowBlocks}, ${f.knownTtlBlocks})`);
  ok(f.bazaarWindowBlocks >= FUNDING_DEFAULTS.bazaarWindowBlocks, "...and never below the 2 s constants");
}

// ---- 5. the ledger's sync path counts its margin at the live rate -------------
// A fake Base JSON-RPC behind the real syncEvmChain: the cursor's first range
// must end exactly `margin` blocks short of the head, and the block time it
// used must have come from the chain's own headers.
for (const [name, forkOffset, wantMs] of [["before Denim", null, 2000], ["after Denim", 86_400, 200]]) {
  T.resetBlockMsMeasurements();
  delete process.env.BASE_DENIM_ACTIVATION_TIMESTAMP; // mainnet unset: measurement only
  process.env.EVM_LOGS_ALCHEMY_FIRST = "on";
  const nowSec = Math.floor(Date.now() / 1000);
  const c = forkOffset == null
    ? { head: 40_000_000, getHeader: async (n) => { const num = n === "latest" ? 40_000_000 : Number(n); return { number: num, timestamp: nowSec - (40_000_000 - num) * 2 }; } }
    : fakeChain({ forkSec: nowSec - forkOffset, nowSec });
  const ranges = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const b = JSON.parse(init.body);
    const reply = async (one) => {
      let result;
      if (one.method === "eth_blockNumber") result = "0x" + c.head.toString(16);
      else if (one.method === "eth_getBlockByNumber") { const h = await c.getHeader(one.params[0] === "latest" ? "latest" : parseInt(one.params[0], 16)); result = { number: "0x" + h.number.toString(16), timestamp: "0x" + h.timestamp.toString(16) }; }
      else if (one.method === "eth_getLogs") { ranges.push([parseInt(one.params[0].fromBlock, 16), parseInt(one.params[0].toBlock, 16)]); result = []; }
      else result = null;
      return { jsonrpc: "2.0", id: one.id, result };
    };
    const out = Array.isArray(b) ? await Promise.all(b.map(reply)) : await reply(b);
    return new Response(JSON.stringify(out), { status: 200 });
  };
  const wallet = "0x" + (forkOffset == null ? "a" : "b").repeat(40);
  process.env.REVENUE_LEDGER_FROM_BASE = String(c.head - 20_000);
  try {
    await RL.syncEvmChain("base", wallet, { maxChunks: 50 });
  } finally { globalThis.fetch = realFetch; }
  const margin = Math.ceil(10_000 / wantMs);
  const lastTo = Math.max(...ranges.map((r) => r[1]));
  eq(Math.round(T.blockMsMeasurement("base")?.ms / 10) * 10, wantMs, `${name}: the sync measured ${wantMs} ms from the chain's own headers`);
  eq(lastTo, c.head - margin, `${name}: the scan stops ${margin} blocks (10 s) short of the head`);
  ok(ranges.every(([f, t]) => t - f + 1 <= 9000), `${name}: every getLogs range stays inside 9,000 blocks (${ranges.length} reads)`);
}
delete process.env.REVENUE_LEDGER_FROM_BASE;
delete process.env.EVM_LOGS_ALCHEMY_FIRST;
delete process.env.BASE_DENIM_ACTIVATION_TIMESTAMP;

// ---- 5b. the leaderboard log cache keeps ten minutes of reorg margin ----------
{
  delete process.env.STATE_DATABASE_URL;
  const C = await import("../src/leaderboard-log-cache.js");
  eq(C.LOG_CACHE_DEFAULTS.reorgMarginSeconds, 600, "the cache's reorg margin is written in seconds");
  const latest = 40_000_000;
  const cursorAfterColdScan = async (extra = {}) => {
    const cache = C.createLogWindowCache({ store: C.createLogCacheStore({ prefix: "bt-test" }), token: "0xusdc", segmentBlocks: 18_000, ...extra });
    await cache.scan({ wallets: ["0xa"], start: latest - 50_000, latest, chunkBlocks: 9000, walletChunk: 10, pad: (w) => w, readLogs: async () => [] });
    return latest - cache.stats().lastCursor;
  };
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  T.resetBlockMsMeasurements();
  eq(await cursorAfterColdScan(), 300, "2 s blocks: the cursor stops 300 blocks (600 s) short of the head");
  // A fresh measurement of the chain at 200 ms (whole-second timestamps, five blocks each).
  T.noteBlockSample("base", { number: 0, timestamp: nowSec - 200 }, { number: 1000, timestamp: nowSec }, { now: nowMs });
  eq(T.blockMs("base", { now: nowMs, env: {} }), 200, "the measured 200 ms rate is in force");
  eq(await cursorAfterColdScan(), 3000, "200 ms blocks: the cursor stops 3,000 blocks (still 600 s) short of the head");
  eq(await cursorAfterColdScan({ reorgMarginBlocks: 5 }), 5, "a pinned block count is kept as written");
  T.resetBlockMsMeasurements();
}

// ---- 6. optional: live Base Sepolia block times (never in CI) ------------------
if (process.env.CI || /^(off|0|false)$/i.test(process.env.BLOCK_TIME_LIVE || "")) {
  console.log("  live Base Sepolia read: not run under CI (no coverage claimed)");
} else {
  T.resetBlockMsMeasurements();
  const rpc = async (method, params) => {
    const r = await fetch("https://sepolia.base.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
  const m = await T.refreshBlockMs("base-sepolia", rpcHeaderReader(rpc), { force: true });
  if (!m) console.log("  live Base Sepolia read: SKIP (unreachable)");
  else {
    const want = T.scheduledBlockMs("base-sepolia");
    const msNow = Date.now();
    const nearFork = Math.abs(msNow - SEPOLIA_ACT_MS) < 30 * 60_000;
    console.log(`  live Base Sepolia: ${m.ms.toFixed(1)} ms per block (blocks ${T.MEASURE_SAMPLE_BLOCKS} back, ${m.toSec - m.fromSec} s)`);
    ok(nearFork || Math.abs(m.ms - want) <= want * 0.2, `live Base Sepolia: ${m.ms.toFixed(1)} ms per block over ${T.MEASURE_SAMPLE_BLOCKS} blocks (schedule says ${want})`);
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(`test-chain-block-time: ${passed} passed`);
