// The routes production named while its event loop was held (the [loop-lag]
// in-flight lists): each figure they read is now built across event-loop
// turns, shared between callers and warmed at boot, at production scale.
//   1. Offline: the sliced builders return exactly what the one-turn reads
//      return (sales summaries, the revenue ledger's summary, daily series
//      and buyer events, the index snapshot, the tool directory) and never
//      hold the loop past GAP_MS on production-sized data; a seller summary
//      rebuild projects only the sellers that changed. The all-chains
//      /marketplace page (both views) renders the same bytes in slices as in
//      one turn, and while a warm start folds entries in, the readers of one
//      turn share one index snapshot instead of each building its own.
//   2. Booted on a production-sized index (5,800 sellers, ~198k tools) and
//      sales ledger: the first request to each route after boot holds the
//      loop under ROUTE_BOUND_MS, and the shared ledger figures the routes
//      serve equal a direct read of the ledger.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { getFreePort } from "./lib/free-port.js";
import { buildRoutePerfFixture } from "./lib/route-perf-fixture.js";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const GAP_MS = Number(process.env.STALL_GAP_MS || 120);
const ROUTE_BOUND_MS = Number(process.env.STALL_ROUTE_BOUND_MS || 150);
// One step of a sliced page: measured at 3.4 ms on a laptop for the longest
// (?all=1, 5,800 sellers); the bound allows a runner several times slower.
const STEP_BOUND_MS = Number(process.env.STALL_STEP_BOUND_MS || 25);
const SALES_ROWS = Number(process.env.STALL_SALES_ROWS || 60_000);
const TRANSFER_ROWS = Number(process.env.STALL_TRANSFER_ROWS || 200_000);

const dir = mkdtempSync(join(tmpdir(), "a402-stall-routes-"));
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
process.env.REVENUE_LEDGER_DB = join(dir, "revenue.db");
process.env.X402_INDEX_CRAWL = "off";
const now = Date.now();
let seed = 7;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

// --- fixtures: a sales ledger of SALES_ROWS rows over 120 days.
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
      ins.run(now - Math.floor(rnd() * 120 * 86_400_000), slugs[Math.floor(rnd() * slugs.length)], Math.round(rnd() * 50) / 1000 + 0.001,
        rails[Math.floor(rnd() * rails.length)], net, rnd() < 0.1 ? null : "0x" + Math.floor(rnd() * 400).toString(16).padStart(40, "a"),
        "0x" + i.toString(16).padStart(64, "0"), rnd() < 0.25 ? 1 : 0, net === "tempo" ? "mpp-tempo" : "x402");
    }
  })();
  db.close();
}

// The worst event-loop block while `fn` runs, from a 1 ms interval.
let worst = 0, last = performance.now();
const lagTimer = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - last); last = t; }, 1);
async function blockOf(fn) {
  await new Promise((r) => setTimeout(r, 20));
  worst = 0; last = performance.now();
  const value = await fn();
  await new Promise((r) => setTimeout(r, 5));
  return { value, ms: Math.round(worst) };
}

// --- 1a. sales summaries
{
  for (const days of [30, 36_500]) {
    const sync = sales.salesSummary({ days });
    const sliced = await blockOf(() => sales.salesSummaryAsync({ days }));
    ok(isDeepStrictEqual(sliced.value, sync), `salesSummaryAsync({ days: ${days} }) equals salesSummary`);
    ok(sliced.ms < GAP_MS, `...and never held the loop past ${GAP_MS} ms on ${SALES_ROWS} rows (worst ${sliced.ms} ms)`);
    const nSync = sales.externalByNetwork({ days });
    const nSliced = await blockOf(() => sales.externalByNetworkAsync({ days }));
    ok(isDeepStrictEqual(nSliced.value, nSync), `externalByNetworkAsync({ days: ${days} }) equals externalByNetwork (worst ${nSliced.ms} ms)`);
  }
  const detailed = await sales.salesSummaryAsync({ days: 30, detailed: true });
  ok(isDeepStrictEqual(detailed, sales.salesSummary({ days: 30, detailed: true })), "the detailed summary is the same sliced or whole");
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
    ok(b.ms < GAP_MS, `...and never held the loop past ${GAP_MS} ms (worst ${b.ms} ms)`);
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
  const sliced = await blockOf(() => x.indexSnapshotAsync(ctx));
  ok(whole.sellers.length >= 5800 && isDeepStrictEqual(stripAsOf(sliced.value), stripAsOf(whole)), `indexSnapshotAsync equals indexSnapshot (${whole.sellers.length} sellers)`);
  ok(sliced.ms < GAP_MS, `...and never held the loop past ${GAP_MS} ms (worst ${sliced.ms} ms)`);
}
{
  const ourTools = [];
  const cold = await blockOf(() => x.indexRowsReady({ ourTools, excludeOrigin: "" }));
  ok(cold.ms < GAP_MS, `a cold tool directory is built in slices, never past ${GAP_MS} ms (worst ${cold.ms} ms)`);
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
  x.__resetRoutableSummaryMemoForTest();
  const first = x.routableSellerSummaries();
  const before = x._routableRowBuildsForTest();
  // One seller re-crawled (the crawler replaces the entry) and one added.
  const [origin, v] = [...cache.entries()].find(([o]) => o.startsWith("https://seller1"));
  cache.set(origin, { ...v, fetchedAt: 2 });
  const fresh = "https://stall-routes-new.example";
  cache.set(fresh, { ...v, manifest: { name: "stall routes new", homepage: fresh }, tools: v.tools.map((t) => ({ ...t, seller: fresh })), fetchedAt: 2 });
  const rebuilt = await blockOf(() => x.routableSellerSummaries());
  const projected = x._routableRowBuildsForTest() - before;
  ok(rebuilt.value.length === first.length + 1 && projected === 2, `a seller-summary rebuild projects only the changed sellers (${projected} of ${rebuilt.value.length})`);
  ok(rebuilt.ms < GAP_MS, `...and never held the loop past ${GAP_MS} ms (worst ${rebuilt.ms} ms)`);
  cache.delete("https://stall-routes-new.example");
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
    ok(sliced.ms < GAP_MS, `...and never held the loop past ${GAP_MS} ms (worst ${sliced.ms} ms, which includes the collector's work between turns; the page in one turn: ${oneTurnMs} ms)`);
    // The page's own work per step, timed step by step: no step is more than
    // a fraction of the whole page (the loop-lag figure above also carries
    // the garbage collector's tasks, which run between turns either way).
    const steps = mp._marketPageAllStepsForTest("https://agent402.tools", opts);
    let longest = 0, count = 0, r;
    do { const t = performance.now(); r = steps.next(); longest = Math.max(longest, performance.now() - t); count++; } while (!r.done);
    ok(r.value === whole && count > 20 && longest < STEP_BOUND_MS, `...in ${count} steps, the longest ${longest.toFixed(1)} ms (bound ${STEP_BOUND_MS} ms)`);
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
  let turns = 0, shared = true, readerWorst = 0, inLine = 0;
  worst = 0; last = performance.now();
  const warming = x.loadPersistedIndexCacheAsync(ndjson);
  // Each turn of the warm start: the nav strip, the page and a second page
  // read the snapshot, as three HTML requests landing in one turn would.
  while (x.indexWarmStartInProgress()) {
    const t = performance.now();
    const before = x._indexSnapshotBuildsForTest();
    const a = x.warmStartSnapshot(ctx), b = x.warmStartSnapshot(ctx), c = x.warmStartSnapshot(ctx);
    if (!(a === b && b === c)) shared = false;
    // A build that finishes inside the readers' turn is an in-line build; the
    // sliced rebuild only starts here and finishes over later turns.
    if (x._indexSnapshotBuildsForTest() - before > 1) inLine++;
    readerWorst = Math.max(readerWorst, performance.now() - t);
    turns++;
    await new Promise((r) => setImmediate(r));
  }
  const loaded = await warming;
  await new Promise((r) => setTimeout(r, 5));
  const warmWorst = Math.round(worst);
  const builds = x._indexSnapshotBuildsForTest() - builds0;
  ok(loaded >= 5800 && turns >= 10, `a warm start of ${loaded} sellers ran over ${turns} turns with readers in each`);
  ok(shared && inLine === 0, "every reader in one turn got the same snapshot, and no turn built more than one");
  ok(builds < turns, `the readers of ${turns} turns shared ${builds} snapshot builds (each reader used to build its own: ${turns * 3})`);
  ok(readerWorst < GAP_MS && warmWorst < GAP_MS, `...the readers' longest turn was ${Math.round(readerWorst)} ms, and the loop's longest block over the warm start and its shared rebuilds ${warmWorst} ms (bound ${GAP_MS} ms)`);
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
const port = await getFreePort();
const proc = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "", INDEX_CACHE_FILE: join(dir, "x402-index-cache.json"), INDEX_FIRST_CRAWL_DELAY_MS: "999999999",
    ROUTE_INDEX_WARM_DELAY_MS: "0", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", STATE_DATABASE_URL: "", ROUTER_WORKERS: "0",
    AGENT402_OPERATOR_TOKEN: TOKEN, STATS_DB_DIR: dir, LOOP_LAG_TICK_MS: "5", LAZY_DEPS_WARM: "off",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const base = `http://127.0.0.1:${port}`;
const op = { headers: { authorization: `Bearer ${TOKEN}` } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  for (let i = 0; i < 120 && quiet < 3; i++) {
    await fetch(`${base}/__operator/perf.json?reset=1`, op);
    await sleep(1000);
    quiet = (await (await fetch(`${base}/__operator/perf.json`, op)).json()).loop.worstMs < 40 ? quiet + 1 : 0;
  }
  ok(quiet >= 3, "boot work settled before the routes are measured");
  // Bounded: the routes whose first request built a ledger or index figure
  // in its own turn (measured here before the change: 200-370 ms on a chain
  // page, 800 ms on the directory, 220 ms on /leaderboard). The rest are read
  // once for their status: their figures are pinned in section 1.
  const routes = ["/base", "/polygon", "/solana", "/monad", "/marketplace", "/marketplace?all=1", "/marketplace/tools", "/marketplace/tools?q=json", "/leaderboard", "/api/sales"];
  for (const r of routes) {
    await fetch(`${base}/__operator/perf.json?reset=1`, op);
    const resp = await fetch(base + r);
    await resp.arrayBuffer();
    await sleep(300);
    const ms = (await (await fetch(`${base}/__operator/perf.json`, op)).json()).loop.worstMs;
    ok(resp.status === 200 && ms < ROUTE_BOUND_MS, `GET ${r}, the first request after boot: 200, the loop held at most ${ms} ms (bound ${ROUTE_BOUND_MS} ms)`);
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
