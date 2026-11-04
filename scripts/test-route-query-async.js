// routeQueryAsync (src/x402-index.js) must give the SAME answer as routeQuery
// and must not hold the thread for the whole query. Both drive one generator,
// routeQuerySteps; the async form yields between slices while it scores
// candidates. Measured on the prod-sized fixture (scripts/lib/route-perf-
// fixture.js): what a concurrent timer sees as its worst lateness is the
// longest single hold, and it must be far under the query's full cost.
// Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
process.env.X402_INDEX_CRAWL = "off";
import assert from "node:assert/strict";
const { routeQuery, routeQueryAsync, _cacheForTests, _setBazaarQualityForTest, warmRouteIndex, _routeIndexSettledForTest } = await import("../src/x402-index.js");
const { buildRoutePerfFixture, GOLDEN_QUERIES } = await import("./lib/route-perf-fixture.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const cache = _cacheForTests();
buildRoutePerfFixture({ cache, setBazaarQuality: _setBazaarQualityForTest });
warmRouteIndex(); await _routeIndexSettledForTest();
const ctx = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "w" };

const HEAVY = "get the price of a token and the data for a wallet in usdc on base";
for (const q of [...GOLDEN_QUERIES, HEAVY, "the and for a of on with to"]) {
  for (const include of ["external", "all"]) {
    const a = routeQuery({ query: q, top: 25, include, ...ctx });
    const b = await routeQueryAsync({ query: q, top: 25, include, ...ctx });
    ok(JSON.stringify(a) === JSON.stringify(b), `async equals sync for ${JSON.stringify(q)} include=${include}`);
  }
}

// How long the thread is held at a stretch. A callback queued on every turn
// records the gap between turns; a query that never yields makes one gap the
// whole query. A gap counts this thread's CPU time inside it, not its wall
// time: on a loaded host the thread sits descheduled inside a slice, which
// stretches the gap without any of the query's work in it (measured under CPU
// contention: the query's last step, the global sort of about 31,000 scored
// rows, ran 31 to 48 ms of thread CPU and read 57 to 95 ms of wall time).
const threadCpuMs = () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; };
async function worstHold(run) {
  let worst = 0, worstWall = 0, last = performance.now(), lastCpu = threadCpuMs(), live = true;
  const tick = () => {
    const now = performance.now(), cpu = threadCpuMs();
    worst = Math.max(worst, Math.min(now - last, cpu - lastCpu)); worstWall = Math.max(worstWall, now - last);
    last = now; lastCpu = cpu;
    if (live) setImmediate(tick);
  };
  setImmediate(tick);
  const t0 = performance.now();
  await run();
  const total = performance.now() - t0;
  live = false;
  await new Promise((r) => setImmediate(r));
  return { worst, worstWall, total };
}
routeQuery({ query: HEAVY, top: 10, include: "external", ...ctx }); // warm statics
const sync = await worstHold(async () => { routeQuery({ query: HEAVY, top: 10, include: "external", ...ctx }); });
let busy = 0;
const asy = await worstHold(() => routeQueryAsync({ query: HEAVY, top: 10, include: "external", ...ctx }, { onBusy: (ms) => { busy += ms; } }));
console.log(`# sync hold ${sync.worst.toFixed(1)} ms of thread CPU (${sync.worstWall.toFixed(1)} ms wall) of ${sync.total.toFixed(1)}; async worst hold ${asy.worst.toFixed(1)} ms of thread CPU (${asy.worstWall.toFixed(1)} ms wall) over ${asy.total.toFixed(1)} ms, busy ${busy.toFixed(1)} ms`);
ok(asy.worst < sync.worst * 0.6, `the async query's longest hold (${asy.worst.toFixed(1)} ms of thread CPU) is well under the sync query's (${sync.worst.toFixed(1)} ms)`);
ok(busy > 0 && busy <= asy.total + 1, "onBusy reports the time the query actually held the thread");
let calls = 0;
await routeQueryAsync({ query: HEAVY, top: 10, include: "external", ...ctx }, { onBusy: () => { calls++; } });
ok(calls > 1, `onBusy is called per slice (${calls} calls), so a budget is charged while the query runs`);
console.log(`test-route-query-async: ${n} passed`);
