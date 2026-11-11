// Per-route timing + in-flight list + the [loop-stats] minute line, offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { recordTiming, routeTimings, installRequestTimingFetch, requestTimingMiddleware, oldestInFlight, inFlightCount, requestsDuring, __resetTimingForTest, callerKeyOf, currentCallerKey } from "../src/request-timing.js";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };

// --- percentiles and the key cap
__resetTimingForTest();
for (let i = 1; i <= 100; i++) recordTiming("GET /api/x", i, i / 2);
const row = routeTimings().find((r) => r.route === "GET /api/x");
ok(row.count === 100 && row.totalMs.p50 === 51 && row.totalMs.p99 === 100, `total percentiles (${JSON.stringify(row.totalMs)})`);
ok(row.computeMs.p50 === 25.5 && row.upstreamMs.p95 === 48, `compute = total - upstream (${JSON.stringify(row.computeMs)})`);
for (let i = 0; i < 400; i++) recordTiming(`GET /k${i}`, 1, 0);
ok(routeTimings({ top: 1000 }).length <= 301 && routeTimings({ top: 1000 }).some((r) => r.route === "(other)"), "route keys are capped; the overflow folds into (other)");
recordTiming("POST /api/paid-route", 5, 0, true);
ok(routeTimings({ top: 1000 }).some((r) => r.route === "POST /api/paid-route"), "a reserved (catalog) route keeps its own ring even when the free slots are full");
__resetTimingForTest();

// --- the caller key: a keyed hash of req.ip, read only inside a request
{
  const a = callerKeyOf({ ip: "203.0.113.5" }), b = callerKeyOf({ ip: "203.0.113.6" });
  ok(/^[0-9a-f]{12}$/.test(a) && a === callerKeyOf({ ip: "203.0.113.5" }) && a !== b, `one address, one key; two addresses, two keys (${a}, ${b})`);
  const { createHash } = await import("node:crypto");
  ok(!a.includes("203") && createHash("sha256").update("203.0.113.5").digest("hex").slice(0, 12) !== a, "the key is not the address and not its plain hash");
  ok(callerKeyOf({}) === null && currentCallerKey() === null, "no address, no key; outside a request, null");
  let seen;
  const ends = [];
  requestTimingMiddleware(() => "k")({ ip: "198.51.100.1" }, { on(ev, fn) { ends.push(fn); }, headersSent: true, statusCode: 200, writableFinished: true }, () => { seen = currentCallerKey(); });
  for (const fn of ends) fn();
  __resetTimingForTest();
  ok(seen === callerKeyOf({ ip: "198.51.100.1" }), "inside a request the scope carries the caller's key");
}

// --- end to end through express: upstream wait charged to the right request
installRequestTimingFetch();
const upstream = http.createServer((req, res) => setTimeout(() => res.end("{}"), 120)).listen(0);
await new Promise((r) => upstream.once("listening", r));
const up = `http://127.0.0.1:${upstream.address().port}/`;
const app = express();
app.use(requestTimingMiddleware((req) => `${req.method} ${req.path}`));
app.get("/slow-upstream", async (_q, res) => { await fetch(up); res.json({ ok: true }); });
app.get("/busy", (_q, res) => { const t = Date.now() + 60; while (Date.now() < t); res.json({ ok: true }); });
app.get("/hang", (_q, res) => { setTimeout(() => res.json({ ok: true }), 300); });
const srv = app.listen(0); await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${srv.address().port}`;
await fetch(`${base}/slow-upstream`); await fetch(`${base}/busy`);
const hang = fetch(`${base}/hang`);
await new Promise((r) => setTimeout(r, 50));
ok(inFlightCount() === 1 && /^GET \/hang \d+ms$/.test(oldestInFlight(3)[0]), `an unfinished request is listed in flight (${oldestInFlight(3)})`);
await hang;
const t = Object.fromEntries(routeTimings().map((r) => [r.route, r]));
ok(t["GET /slow-upstream"].upstreamMs.p50 >= 100 && t["GET /slow-upstream"].computeMs.p50 < 60, `outbound wait counts as upstream, not compute (${JSON.stringify(t["GET /slow-upstream"])})`);
ok(t["GET /busy"].computeMs.p50 >= 55 && t["GET /busy"].upstreamMs.p50 === 0, "synchronous work counts as compute");
ok(inFlightCount() === 0, "finished requests leave the in-flight list");
srv.close(); upstream.close();

// --- loop-lag names the in-flight requests and the minute line carries percentiles
const { startLoopLagMonitor, setStallContext, loopLagStatus } = await import("../src/loop-lag.js");
const lines = [];
setStallContext(() => ["POST /api/x 900ms"]);
const stop = startLoopLagMonitor({ tickMs: 20, warnMs: 100, log: (l) => lines.push(l), statsLog: (l) => lines.push(l) });
await new Promise((r) => setTimeout(r, 40));
const until = Date.now() + 200; while (Date.now() < until);
await new Promise((r) => setTimeout(r, 60));
stop();
ok(lines.some((l) => /\[loop-lag\] event loop blocked \d+ms .* in-flight: POST \/api\/x 900ms/.test(l)), `a stall line names the in-flight requests (${lines.find((l) => l.includes("loop-lag"))})`);
ok(loopLagStatus().stalls >= 1, "the stall is counted");

// A handler that blocks the loop and answers at the end of the block has left
// the in-flight list before the lag timer fires: the stall still names it.
const app2 = express();
app2.use(requestTimingMiddleware((req) => `${req.method} ${req.path}`));
app2.get("/hog", (_q, res) => { const u = Date.now() + 250; while (Date.now() < u); res.json({ ok: true }); });
const srv2 = app2.listen(0); await new Promise((r) => srv2.once("listening", r));
const lines2 = [];
setStallContext(({ fromMs } = {}) => requestsDuring(fromMs, 3));
const stop3 = startLoopLagMonitor({ tickMs: 20, warnMs: 100, log: (l) => lines2.push(l), statsLog: () => {} });
await new Promise((r) => setTimeout(r, 40));
await fetch(`http://127.0.0.1:${srv2.address().port}/hog`);
await new Promise((r) => setTimeout(r, 60));
stop3(); srv2.close();
ok(lines2.some((l) => /\[loop-lag\] event loop blocked \d+ms .* in-flight: GET \/hog \d+ms done/.test(l)), `a request that finished inside the stall is named (${lines2.find((l) => l.includes("loop-lag"))})`);
const statLines = [];
const stop2 = startLoopLagMonitor({ tickMs: 20, statsMs: 100, log: () => {}, statsLog: (l) => statLines.push(l) });
await new Promise((r) => setTimeout(r, 260));
stop2();
ok(statLines.some((l) => /^\[loop-stats\] p50=\d+ms p99=\d+ms max=\d+ms blocks>=\d+ms=\d+ blocked=\d+ms gc=\d+ms major=\d+ms heap=\d+MB rss=\d+MB$/.test(l)), `the minute line carries loop percentiles, block count, GC time and memory (${statLines[0]})`);
ok(loopLagStatus().lastMinute && typeof loopLagStatus().lastMinute.p99 === "number", "the last minute's numbers are on loopLagStatus for the operator read");

console.log(`test-request-timing: ${n} passed`);
process.exit(0);
