// Router worker pool (src/router-pool.js, src/router-worker-thread.js).
//
// A route query holds the thread for its whole CPU cost even when sliced,
// and a burst of them takes turns at the slice boundaries, so every other
// request waits behind the burst (prod read "[loop-lag] event loop blocked
// 1388ms"). The pool scores in a worker thread that imports the index module
// and holds a replica of the stores a query reads. What this file pins:
//   (a) the worker's answer is byte-identical to the in-thread answer, on the
//       prod-sized fixture, for every include mode, a network filter, a
//       shared scored memo and a catalog, and the busy time is reported;
//   (b) on a booted server, a burst of 20 concurrent uncached router queries
//       leaves /health answering fast and the main loop unblocked, with the
//       in-thread boot measured beside it for the report;
//   (c) a crashed worker falls back to this thread and is replaced;
//   (d) a query past its deadline fails clearly and the worker is recycled;
//   (e) an index change (set, replace, delete, Bazaar quality) reaches the
//       worker before the next query.
// Offline: the server boots warm-started from the fixture with the crawler's
// first cycle deferred, so nothing leaves the machine.
process.env.X402_INDEX_CRAWL = "off";
process.env.ROUTER_WORKERS = "1";
process.env.ROUTER_WORKER_TEST_HOOKS = "1";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";
import { buildRoutePerfFixture, GOLDEN_QUERIES } from "./lib/route-perf-fixture.js";

const xi = await import("../src/x402-index.js");
const pool = await import("../src/router-pool.js");
const { routeQuery, routeQueryAsync, _cacheForTests, _setBazaarQualityForTest, warmRouteIndex, _routeIndexSettledForTest } = xi;
const { startRouterPool, stopRouterPool, routerPoolStatus, routerPoolLoaded, _routerPoolForTest: hooks } = pool;

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

// ------------------------------------------------------------- (a) identical answers
const cache = _cacheForTests();
const { ctx } = buildRoutePerfFixture({ cache, setBazaarQuality: _setBazaarQualityForTest });
warmRouteIndex(); await _routeIndexSettledForTest();
const t0 = performance.now();
startRouterPool();
await routerPoolLoaded();
const loadMs = Math.round(performance.now() - t0);
const st0 = routerPoolStatus();
ok(st0.loaded && st0.workers.length === 1, `one worker loaded with the ${cache.size}-seller fixture in ${loadMs} ms (resync ${st0.lastResyncMs} ms, ${st0.cloneMs} ms of main-thread cloning)`);
const wst = await hooks.workerStats();
ok(wst && wst.cacheSize === cache.size && wst.routeIndex.indexedTools > 100_000, `the worker holds every seller (${wst?.cacheSize}) and indexed ${wst?.routeIndex?.indexedTools} tools (worker heap ${wst?.heapUsedMb} MB)`);

const HEAVY = "get the price of a token and the data for a wallet in usdc on base";
const queries = [...GOLDEN_QUERIES, HEAVY, "the and for a of on with to", "ip", "wallet balance usdc"];
let compared = 0, mismatched = [];
let busyTotal = 0, busyCalls = 0;
for (const q of queries) {
  for (const include of ["external", "all", "local"]) {
    const a = routeQuery({ query: q, top: 25, include, ...ctx });
    const b = await routeQueryAsync({ query: q, top: 25, include, ...ctx }, { onBusy: (ms) => { busyTotal += ms; busyCalls++; } });
    compared++;
    if (!same(a, b)) mismatched.push(`${q}/${include}`);
  }
}
ok(mismatched.length === 0, `worker and in-thread answers identical on ${compared} query/include pairs${mismatched.length ? ` (differ: ${mismatched.join(", ")})` : ""}`);
ok(routerPoolStatus().served.worker >= compared, `every async query was served by the worker (${routerPoolStatus().served.worker})`);
ok(busyCalls === compared && busyTotal > 0, `onBusy reported the worker's CPU for each query (${busyCalls} calls, ${Math.round(busyTotal)} ms total)`);
{
  const args = { query: "chat completions", top: 20, include: "external", networkFilter: "solana", strictNetwork: true, ...ctx };
  ok(same(routeQuery(args), await routeQueryAsync(args)), "a network filter with strictNetwork gives the same answer from the worker");
  const args2 = { query: "chat completions", top: 20, include: "external", networkFilter: "base", ...ctx };
  ok(same(routeQuery(args2), await routeQueryAsync(args2)), "a Base network filter gives the same answer from the worker");
}
{
  // One memo across two calls (the /api/route page and its shortlist).
  const m1 = {}, m2 = {};
  const a1 = routeQuery({ query: "json to csv", top: 5, include: "all", scoredMemo: m1, ...ctx });
  const a2 = routeQuery({ query: "json to csv", top: 25, include: "all", scoredMemo: m1, ...ctx });
  const b1 = await routeQueryAsync({ query: "json to csv", top: 5, include: "all", scoredMemo: m2, ...ctx });
  const b2 = await routeQueryAsync({ query: "json to csv", top: 25, include: "all", scoredMemo: m2, ...ctx });
  ok(same(a1, b1) && same(a2, b2), "a scored memo shared by two calls gives the same two answers from the worker");
}
{
  // An empty query and a query with no terms take the same envelope.
  ok(same(routeQuery({ query: "", top: 5, include: "all", ...ctx }), await routeQueryAsync({ query: "", top: 5, include: "all", ...ctx })), "the empty-query envelope is the same from the worker");
}

// ------------------------------------------------------------- (e) refresh reaches the worker
{
  const origin = "https://fresh-seller.example";
  const entry = (tools) => ({ manifest: { name: "fresh", homepage: origin }, tools: tools.map((t) => ({ seller: origin, method: "POST", route: `/api/${t.slug}`, category: "data", tags: [], price: 0.002, networks: ["eip155:8453"], description: "", ...t })), fetchedAt: Date.now(), error: null, history: [1, 1, 1] });
  const find = async (q) => (await routeQueryAsync({ query: q, top: 10, include: "external", ...ctx })).results.map((r) => `${r.seller}|${r.slug}`);
  ok(!(await find("kumquats")).length, "before the set, nothing answers the new word");
  cache.set(origin, entry([{ slug: "kumquat-finder", name: "Kumquat finder", description: "Finds kumquats." }]));
  ok((await find("kumquats")).includes(`${origin}|kumquat-finder`), "a seller set on the main thread is routed by the worker on the very next query");
  cache.set(origin, entry([{ slug: "quince-finder", name: "Quince finder", description: "Finds quinces now." }]));
  const after = await find("kumquats");
  ok(!after.length && (await find("quinces")).includes(`${origin}|quince-finder`), "a replaced entry's new rows are found and its old rows are gone");
  _setBazaarQualityForTest(origin, { calls30d: 5, payers30d: 7, lastCalledAt: null });
  const row = (await routeQueryAsync({ query: "quinces", top: 10, include: "external", ...ctx })).results.find((r) => r.seller === origin);
  ok(row && row.why.bazaarPayers30d === 7, `a Bazaar quality change reaches the worker (payers30d ${row?.why?.bazaarPayers30d})`);
  cache.delete(origin);
  _setBazaarQualityForTest(origin, null);
  ok(!(await find("quinces")).length, "a deleted seller is gone from the worker's answers");
  ok(routerPoolStatus().served.inThread === 0 && routerPoolStatus().fallbacks === 0, "all of that was served by the worker, none fell back");
}

// ------------------------------------------------------------- (c) crash falls back and recovers
{
  const before = routerPoolStatus();
  ok(hooks.crashWorker(), "the worker is told to crash");
  // Give the crash a moment to land, then query: the answer comes from this thread.
  await sleep(300);
  const a = routeQuery({ query: HEAVY, top: 10, include: "external", ...ctx });
  const b = await routeQueryAsync({ query: HEAVY, top: 10, include: "external", ...ctx });
  const mid = routerPoolStatus();
  ok(same(a, b), "a query while no worker is loaded answers identically from this thread");
  ok(mid.crashes === before.crashes + 1 && !mid.loaded && mid.served.inThread >= 1, `the crash was counted and the query ran in-thread (crashes ${mid.crashes}, inThread ${mid.served.inThread})`);
  const t1 = performance.now();
  await Promise.race([routerPoolLoaded(), sleep(30_000)]);
  const after = routerPoolStatus();
  ok(after.loaded && after.restarts >= 1, `a replacement worker loaded in ${Math.round(performance.now() - t1)} ms (restarts ${after.restarts})`);
  const served = after.served.worker;
  const c = await routeQueryAsync({ query: HEAVY, top: 10, include: "external", ...ctx });
  ok(same(a, c) && routerPoolStatus().served.worker === served + 1, "the replacement worker serves the same answer");
}

// ------------------------------------------------------------- (d) deadline
{
  hooks.setDeadlineMs(300);
  const before = routerPoolStatus();
  const hung = hooks.hangQuery(2000, { query: "ip", top: 5, include: "external", ...ctx });
  const behind = routeQueryAsync({ query: "json to csv", top: 5, include: "external", ...ctx });
  let err = null;
  try { await hung; } catch (e) { err = e; }
  ok(err && err.code === "router_query_deadline" && /deadline/.test(err.message) && err.statusCode === 503, `the hung query fails with a clear deadline error (${err?.message})`);
  const b = await behind;
  ok(same(b, routeQuery({ query: "json to csv", top: 5, include: "external", ...ctx })), "the query queued behind it answers identically from this thread");
  const mid = routerPoolStatus();
  ok(mid.deadlines === before.deadlines + 1 && mid.fallbacks >= before.fallbacks + 1, `the deadline was counted and the queued query fell back (deadlines ${mid.deadlines}, fallbacks ${mid.fallbacks})`);
  hooks.setDeadlineMs(10_000);
  await Promise.race([routerPoolLoaded(), sleep(30_000)]);
  ok(routerPoolStatus().loaded, "a fresh worker is loaded after the recycle");
}
await stopRouterPool();
ok(routerPoolStatus().workers.length === 0, "stopRouterPool leaves no worker");

// ------------------------------------------------------------- (b) a booted server under a burst
// The fixture, written in the warm-start NDJSON format (as test-perf-budget.js).
const TOKEN = "router-worker-operator-token-0123456789";
const dir = mkdtempSync(join(tmpdir(), "a402-router-worker-"));
const file = join(dir, "x402-index-cache.json");
{
  const lines = [];
  const now = Date.now();
  buildRoutePerfFixture({ cache: { set: (o, e) => lines.push(JSON.stringify([o, { ...e, fetchedAt: now, source: "manifest" }])) } });
  writeFileSync(join(dir, "x402-index-cache.ndjson"), [JSON.stringify({ savedAt: now, format: "ndjson-v1", origins: lines.length }), ...lines].join("\n") + "\n");
}
const BURST = 20;
const HOT = ["price", "token", "wallet", "data", "api", "list", "fetch", "get", "chain", "base", "usdc", "balance", "transaction", "block", "quote", "rate", "search", "web", "json", "convert"];
const burstQueries = Array.from({ length: BURST }, (_, k) => `get the ${HOT[k % HOT.length]} of a ${HOT[(k + 3) % HOT.length]} and the ${HOT[(k + 7) % HOT.length]} for a ${HOT[(k + 11) % HOT.length]} on ${HOT[(k + 13) % HOT.length]} ${k}`);

async function bootAndBurst(routerWorkers) {
  const port = await getFreePort();
  const log = [];
  const proc = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, FREE_MODE: "true", PORT: String(port), INDEX_CACHE_FILE: file, INDEX_FIRST_CRAWL_DELAY_MS: "999999999", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", AGENT402_OPERATOR_TOKEN: TOKEN, ROUTE_INDEX_WARM_DELAY_MS: "500", X402_INDEX_CRAWL: "", ROUTER_WORKERS: String(routerWorkers), ROUTER_WORKER_TEST_HOOKS: "", LOOP_LAG_WARN_MS: "250" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) log.push(l.slice(0, 300)); };
  proc.stdout.on("data", keep); proc.stderr.on("data", keep);
  const base = `http://127.0.0.1:${port}`;
  const op = (q = "") => fetch(`${base}/__operator/perf.json${q}`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await sleep(500); } }
    assert.ok(up, `server booted (ROUTER_WORKERS=${routerWorkers})`);
    let sellers = 0;
    for (let i = 0; i < 60 && sellers < 2900; i++) {
      try { sellers = (await (await fetch(`${base}/api/index?limit=1`)).json()).sellerCount || 0; } catch { /* warming */ }
      if (sellers < 2900) await sleep(500);
    }
    assert.ok(sellers >= 2900, `the index warm-started at production size (${sellers} sellers)`);
    // The route index builds off the query path; with workers, wait for one.
    let perf = null;
    for (let i = 0; i < 120; i++) {
      perf = await op();
      if (routerWorkers === 0 || perf.routerPool?.loaded) break;
      await sleep(250);
    }
    assert.ok(routerWorkers === 0 || perf.routerPool?.loaded, `a router worker loaded on the server (${JSON.stringify(perf.routerPool)})`);
    await sleep(1500);
    await op("?reset=1");
    // The burst: 20 distinct uncached heavy queries at once, from loopback (no
    // per-client budget), with /health probed back to back beside them.
    const health = [];
    let burstDone = false;
    const tb = performance.now();
    const burst = Promise.all(burstQueries.map((q) => fetch(`${base}/api/route?q=${encodeURIComponent(q)}&top=25&include=external`, { signal: AbortSignal.timeout(60_000) }).then(async (r) => ({ status: r.status, body: await r.json() })).catch((e) => ({ status: 0, error: String(e) })))).then((r) => { burstDone = true; return r; });
    while (!burstDone) {
      const t = performance.now();
      try { await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(30_000) })).arrayBuffer(); health.push(performance.now() - t); }
      catch { health.push(30_000); }
      await sleep(10);
    }
    const results = await burst;
    const burstMs = Math.round(performance.now() - tb);
    const after = await op();
    const answered = results.filter((r) => r.status === 200 && Array.isArray(r.body?.results) && r.body.results.length > 0).length;
    const stallLines = log.filter((l) => l.includes("[loop-lag]")).length;
    return { answered, burstMs, healthN: health.length, p50: Math.round(pct(health, 0.5)), p95: Math.round(pct(health, 0.95)), max: Math.round(Math.max(...health)), worstMs: after.loop.worstMs, stalls: after.loop.stalls, stallLines, routerPool: after.routerPool, lastMinute: after.loop.lastMinute };
  } finally {
    proc.kill("SIGKILL");
  }
}

const inThread = await bootAndBurst(0);
console.log(`# in-thread (ROUTER_WORKERS=0): burst of ${BURST} answered ${inThread.answered} in ${inThread.burstMs} ms; /health n=${inThread.healthN} p50=${inThread.p50}ms p95=${inThread.p95}ms max=${inThread.max}ms; main-loop worst hold ${inThread.worstMs} ms, stalls>=250ms ${inThread.stalls}`);
const worker = await bootAndBurst(1);
console.log(`# worker (ROUTER_WORKERS=1): burst of ${BURST} answered ${worker.answered} in ${worker.burstMs} ms; /health n=${worker.healthN} p50=${worker.p50}ms p95=${worker.p95}ms max=${worker.max}ms; main-loop worst hold ${worker.worstMs} ms, stalls>=250ms ${worker.stalls}; pool ${JSON.stringify(worker.routerPool)}`);
ok(worker.answered === BURST, `every query of the burst answered 200 with rows on the worker boot (${worker.answered}/${BURST})`);
ok(worker.routerPool.served.worker >= BURST, `the burst was served by the worker (${worker.routerPool.served.worker} worker-served, ${worker.routerPool.served.inThread} in-thread)`);
// The bound. With the scoring in the worker, a /health probe waits only for
// this thread's own work per answer (a message post, the dispatch-field
// projection and the JSON of a 25-row page), tens of milliseconds at most on
// a slow runner; 200 ms leaves that room four times over and sits under the
// loop monitor's 500 ms tick, while a regression to in-thread scoring (0.5-3 s
// holds, measured on prod and reproduced by the in-thread boot above) cannot
// pass it. The worst main-loop hold bound is the same number for the same
// reason: the loop monitor's lateness IS the longest hold.
const HEALTH_P95_MS = Number(process.env.ROUTER_WORKER_HEALTH_P95_MS || 200);
ok(worker.p95 <= HEALTH_P95_MS, `/health p95 ${worker.p95} ms <= ${HEALTH_P95_MS} ms during the burst on the worker boot`);
ok(worker.worstMs <= HEALTH_P95_MS, `the main loop's worst hold ${worker.worstMs} ms <= ${HEALTH_P95_MS} ms during the burst on the worker boot`);
ok(worker.stalls === 0, `no main-loop stall over 250 ms during the burst on the worker boot (${worker.stalls})`);
console.log(`test-router-worker: ${n} passed`);
