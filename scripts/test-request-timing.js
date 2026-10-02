// Per-route timing + in-flight list + the [loop-stats] minute line, offline.
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { recordTiming, routeTimings, installRequestTimingFetch, requestTimingMiddleware, oldestInFlight, inFlightCount, __resetTimingForTest } from "../src/request-timing.js";

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
const statLines = [];
const stop2 = startLoopLagMonitor({ tickMs: 20, statsMs: 100, log: () => {}, statsLog: (l) => statLines.push(l) });
await new Promise((r) => setTimeout(r, 260));
stop2();
ok(statLines.some((l) => /^\[loop-stats\] p50=\d+ms p99=\d+ms max=\d+ms blocks>=\d+ms=\d+ blocked=\d+ms gc=\d+ms major=\d+ms heap=\d+MB rss=\d+MB$/.test(l)), `the minute line carries loop percentiles, block count, GC time and memory (${statLines[0]})`);
ok(loopLagStatus().lastMinute && typeof loopLagStatus().lastMinute.p99 === "number", "the last minute's numbers are on loopLagStatus for the operator read");

console.log(`test-request-timing: ${n} passed`);
process.exit(0);
