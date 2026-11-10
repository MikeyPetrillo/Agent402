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
import { readFileSync } from "node:fs";
import { PerformanceObserver } from "node:perf_hooks";
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
// whole query. A gap's hold is the time this thread was ours inside it: its
// wall time less the time it sat runnable on the scheduler's queue. On a
// loaded host the thread sits descheduled inside a slice, which stretches the
// gap without any of the query's work in it (measured under CPU contention:
// the query's last step, the global sort of about 31,000 scored rows, ran 31
// to 48 ms of thread CPU and read 57 to 95 ms of wall time); a wait the
// thread chose (a synchronous read, an Atomics.wait) is ours. The queue wait
// is the second field of the thread's schedstat (Linux, where CI runs); where
// that file is missing the hold is the thread's CPU time, and under CI the
// file is required (test-stall-routes.js reads holds the same way).
const threadCpuMs = () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; };
const SCHEDSTAT = (() => { const p = `/proc/self/task/${process.pid}/schedstat`; try { return /^\d+ \d+ \d+/.test(readFileSync(p, "utf8")) ? p : null; } catch { return null; } })();
const oursMs = SCHEDSTAT ? () => performance.now() - Number(readFileSync(SCHEDSTAT, "utf8").split(" ")[1]) / 1e6 : threadCpuMs;
const HOLD = SCHEDSTAT ? "ours" : "of thread CPU";
if (process.env.CI) assert.ok(SCHEDSTAT, "under CI the main thread's schedstat must be readable, so a blocking wait is measured");
// A collector pause inside a gap is the runtime's, not a step of the query:
// it lands in whichever form happens to be running, and the yielding form
// gives it more places to land. Each gap is read less the pauses inside it
// (test-stall-routes.js reads its holds the same way), and the pause time in
// the worst gap and in the whole run is printed beside the figures.
const gcPauses = [];
new PerformanceObserver((list) => { for (const e of list.getEntries()) gcPauses.push([e.startTime, e.startTime + e.duration]); }).observe({ entryTypes: ["gc"] });
async function worstHold(run) {
  let last = performance.now(), lastOurs = oursMs(), live = true;
  const gaps = [];
  gcPauses.length = 0;
  const tick = () => {
    const now = performance.now(), ours = oursMs();
    gaps.push([last, now, ours - lastOurs]);
    last = now; lastOurs = ours;
    if (live) setImmediate(tick);
  };
  setImmediate(tick);
  const t0 = performance.now();
  await run();
  const t1 = performance.now(), total = t1 - t0;
  live = false;
  await new Promise((r) => setImmediate(r));
  // The observer delivers gc entries on a later task.
  await new Promise((r) => setTimeout(r, 50));
  const gcIn = (a, b) => { let ms = 0; for (const [s0, e0] of gcPauses) ms += Math.max(0, Math.min(b, e0) - Math.max(a, s0)); return ms; };
  let worst = 0, worstWall = 0, worstGc = 0, worstRaw = 0;
  for (const [a, b, ours] of gaps) {
    const inGc = gcIn(a, b), held = Math.min(b - a, ours);
    if (held - inGc > worst) { worst = held - inGc; worstGc = inGc; worstRaw = held; }
    worstWall = Math.max(worstWall, b - a);
  }
  return { worst, worstWall, total, worstGc, worstRaw, gc: gcIn(t0, t1) };
}
// An absolute bound on the async query's longest hold, beside the ratio to
// the sync query's: a hold in code both forms run (routeQuerySteps) inflates
// both sides, so the ratio alone passes it. The bound is the larger of a
// floor and a multiple of a same-machine baseline job, as test-stall-routes.js
// derives its bounds, so a slower runner gets a wider one. Measured: the
// longest step, the final sort, about 65 ms on a laptop against a baseline of
// about 16 ms.
// The baseline is timed on the ours clock too, so a contended host does not
// widen the bound with time that was not ours.
const BASELINE_MS = (() => {
  const once = () => {
    const t0 = oursMs();
    const rows = []; for (let i = 0; i < 36_000; i++) rows.push({ i, s: "k" + (i % 977), v: i * 1.5, t: [i, i + 1] });
    JSON.parse(JSON.stringify(rows)).sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.i - b.i));
    return oursMs() - t0;
  };
  return Math.min(once(), once(), once());
})();
const HOLD_FLOOR_MS = Number(process.env.ROUTE_QUERY_HOLD_MS || 130);
const HOLD_BOUND_MS = Math.max(HOLD_FLOOR_MS, Math.round(5 * BASELINE_MS));
const HOLD_NOTE = `bound ${HOLD_BOUND_MS} ms: ${HOLD_FLOOR_MS} ms or 5x the ${BASELINE_MS.toFixed(1)} ms baseline`;
routeQuery({ query: HEAVY, top: 10, include: "external", ...ctx }); // warm statics
const sync = await worstHold(async () => { routeQuery({ query: HEAVY, top: 10, include: "external", ...ctx }); });
let busy = 0;
const asy = await worstHold(() => routeQueryAsync({ query: HEAVY, top: 10, include: "external", ...ctx }, { onBusy: (ms) => { busy += ms; } }));
console.log(`# sync hold ${sync.worst.toFixed(1)} ms ${HOLD} (${sync.worstWall.toFixed(1)} ms wall) of ${sync.total.toFixed(1)}; async worst hold ${asy.worst.toFixed(1)} ms ${HOLD} (${asy.worstWall.toFixed(1)} ms wall) over ${asy.total.toFixed(1)} ms, busy ${busy.toFixed(1)} ms; collector: ${sync.gc.toFixed(1)} ms in the sync run, ${asy.gc.toFixed(1)} ms in the async run, ${asy.worstGc.toFixed(1)} ms of the ${asy.worstRaw.toFixed(1)} ms gap that held longest`);
ok(asy.worst < sync.worst * 0.6, `the async query's longest hold (${asy.worst.toFixed(1)} ms ${HOLD}) is well under the sync query's (${sync.worst.toFixed(1)} ms)`);
ok(asy.worst < HOLD_BOUND_MS, `the async query's longest hold (${asy.worst.toFixed(1)} ms ${HOLD}) is under an absolute bound (${HOLD_NOTE})`);
ok(busy > 0 && busy <= asy.total + 1, "onBusy reports the time the query actually held the thread");
let calls = 0;
await routeQueryAsync({ query: HEAVY, top: 10, include: "external", ...ctx }, { onBusy: () => { calls++; } });
ok(calls > 1, `onBusy is called per slice (${calls} calls), so a budget is charged while the query runs`);
console.log(`test-route-query-async: ${n} passed`);
