// Offline: which routes are slow and what they advertise (src/slow-routes.js),
// and how a job's progress is carried and shown (src/job-progress.js, the
// task store's update in src/mcp-tasks.js). Pins:
//   - the slow set is the measured run budget past 20 s; its numbers come
//     from EVM_RUN_SECONDS, never a second table that can drift;
//   - the 402 advice middleware sets X-Async-Recommended and an `async` body
//     block on a slow route's 402 only, never on a 200 or a fast route, and
//     never touches PAYMENT-REQUIRED;
//   - a sink is reached only through its in-process key; a header from
//     outside matches nothing and is removed;
//   - progressView: queued, running (reported vs estimated), final states;
//     Retry-After only while not final;
//   - the throttled writer writes stage changes at once, drops no-op patches
//     and never writes after cancel;
//   - the task store's update moves queued -> running, records stages, and
//     never touches a terminal record.
//
//   node scripts/test-job-progress.js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asyncProfileOf, asyncAdvice, asyncRecommendedHeader, slowRouteMarker, asyncAdviceMiddleware, estimateBasisSeconds, SLOW_ADVISE_SECONDS } from "../src/slow-routes.js";
import { EVM_RUN_SECONDS } from "../src/evm-validity.js";
import { PROGRESS_HEADER, registerProgressSink, progressMiddleware, reportProgress, reportHandlerStarted, stepProgress, throttledProgressWriter, progressView, normalizePatch, _sinkCountForTest } from "../src/job-progress.js";
import { requestTimingMiddleware } from "../src/request-timing.js";
import { createTaskStore } from "../src/mcp-tasks.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- slow-routes -------------------------------------------------------------
{
  const video = asyncProfileOf({ slug: "v1-videos" });
  ok(video?.slow === true && video.maxSeconds === EVM_RUN_SECONDS["v1-videos"] && video.expectedSeconds > 0 && video.expectedSeconds < video.maxSeconds, "v1-videos is slow, its budget is the EVM run budget, its typical run is under it");
  const research = asyncProfileOf({ slug: "research" });
  ok(research?.slow === true && research.maxSeconds === EVM_RUN_SECONDS.research, "a report composite is slow with the composite run budget");
  const decide = asyncProfileOf({ slug: "decide-execute" });
  ok(decide?.slow === true && decide.expectedSeconds === null && estimateBasisSeconds(decide) === Math.round(decide.maxSeconds / 2), "a slow route with no measured typical run estimates from half its budget and states no expected time");
  for (const [slug, s] of Object.entries(EVM_RUN_SECONDS)) {
    const p = asyncProfileOf({ slug });
    if (!(p && p.maxSeconds === s && p.slow === s > SLOW_ADVISE_SECONDS)) { ok(false, `${slug} profile matches its run budget`); }
  }
  ok(true, "every EVM_RUN_SECONDS route has a profile from the same number");
  const exec = asyncProfileOf({ slug: "route-execute-max" });
  ok(exec && exec.slow === false && asyncRecommendedHeader({ slug: "route-execute-max" }) === null, "a route-execute tier runs as a job on request but is not advertised as slow");
  ok(asyncProfileOf({ slug: "v1-images-edit" }) === null, "the multipart image edit route never runs as a job (a job replays JSON)");
  ok(asyncProfileOf({ slug: "uuid" }) === null && asyncAdvice({ slug: "uuid" }) === null && slowRouteMarker({ slug: "uuid" }) === "", "a fast route has no profile, no advice, no marker");
  const adv = asyncAdvice({ slug: "v1-videos" });
  ok(adv.recommended === true && adv.prefer === "respond-async" && adv.accepted === 202 && adv.statusUrl === "/api/jobs/{id}" && adv.maxSeconds === video.maxSeconds && /Retry-After/.test(adv.how), "advice block for a slow route");
  ok(asyncRecommendedHeader({ slug: "v1-videos" }) === `respond-async; expected-seconds=${video.expectedSeconds}; max-seconds=${video.maxSeconds}`, "X-Async-Recommended value");
  ok(asyncRecommendedHeader({ slug: "decide-execute" }) === `respond-async; max-seconds=${decide.maxSeconds}`, "no expected-seconds where none is measured");
  ok(/slow: about \d+ s, up to \d+ s; send Prefer: respond-async/.test(slowRouteMarker({ slug: "research" })), "llms.txt marker");
}

// ---- 402 advice middleware ----------------------------------------------------
function fakeRes(status) {
  const headers = {};
  const res = { statusCode: status, headersSent: false, sent: null, setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, getHeader: (k) => headers[k.toLowerCase()], headers };
  res.send = function (chunk) { res.sent = chunk; return res; };
  return res;
}
async function through(mw, req, res, body) {
  await new Promise((r) => mw(req, res, r));
  res.send(body);
  return res;
}
{
  const defs = { "POST /v1/videos/generations": { slug: "v1-videos" }, "POST /api/uuid": { slug: "uuid" } };
  const mw = asyncAdviceMiddleware((req) => defs[`${req.method} ${req.path}`] || null);
  const r1 = await through(mw, { method: "POST", path: "/v1/videos/generations" }, fakeRes(402), JSON.stringify({ x402Version: 2, accepts: [] }));
  const b1 = JSON.parse(r1.sent);
  ok(r1.headers["x-async-recommended"]?.startsWith("respond-async") && b1.async?.recommended === true && Array.isArray(b1.accepts), "a slow route's 402 gets the header and the body block");
  const r2 = await through(mw, { method: "POST", path: "/v1/videos/generations" }, fakeRes(200), JSON.stringify({ data: [] }));
  ok(!r2.headers["x-async-recommended"] && !("async" in JSON.parse(r2.sent)), "a 200 is untouched");
  const r3 = await through(mw, { method: "POST", path: "/api/uuid" }, fakeRes(402), JSON.stringify({}));
  ok(!r3.headers["x-async-recommended"] && r3.sent === "{}", "a fast route's 402 is untouched");
  const r4 = await through(mw, { method: "POST", path: "/v1/videos/generations" }, fakeRes(402), "<html>pay</html>");
  ok(r4.headers["x-async-recommended"] && r4.sent === "<html>pay</html>", "a non-JSON 402 keeps its body and still gets the header");
  const r5 = await through(mw, { method: "POST", path: "/v1/videos/generations" }, fakeRes(402), JSON.stringify({ async: "theirs" }));
  ok(JSON.parse(r5.sent).async === "theirs", "an existing async key is never overwritten");
}

// ---- sinks, middleware, scope -------------------------------------------------
{
  const got = [];
  const sink = registerProgressSink((p) => got.push(p));
  const timing = requestTimingMiddleware(() => "test");
  const pm = progressMiddleware();
  const run = (headers, fn) => new Promise((resolve) => {
    const req = { headers: { ...headers }, method: "POST", path: "/x" };
    const res = { on() {}, headersSent: false, statusCode: 200, locals: {} };
    timing(req, res, () => pm(req, res, () => { fn(req); resolve(req); }));
  });
  const req1 = await run({ [PROGRESS_HEADER]: sink.key }, () => { reportHandlerStarted(); reportProgress({ stage: "step one", done: 1, total: 4 }); });
  ok(!(PROGRESS_HEADER in req1.headers), "the progress header is removed before the handler");
  ok(got.length === 2 && got[0].phase === "running" && got[1].stage === "step one" && got[1].progress === 0.25, `a handler reports through the scope without the request (${JSON.stringify(got)})`);
  const before = got.length;
  await run({ [PROGRESS_HEADER]: "f".repeat(36) }, () => { reportProgress({ stage: "forged" }); });
  await run({}, () => { reportProgress({ stage: "no job" }); });
  ok(got.length === before, "a key from outside matches nothing, and outside a job a report does nothing");
  // Nested step counters: only the outermost reports.
  got.length = 0;
  await run({ [PROGRESS_HEADER]: sink.key }, () => {
    const outer = stepProgress(2);
    outer.next("outer one");
    const inner = stepProgress(5);
    inner.next("inner one");
    outer.next("outer two");
  });
  ok(JSON.stringify(got.map((p) => p.stage)) === JSON.stringify(["outer one", "outer two"]), `a nested composite's steps stay quiet (${got.map((p) => p.stage).join(", ")})`);
  sink.release();
  ok(_sinkCountForTest() === 0, "a released sink is gone");
  reportProgress({ stage: "x" }, { __a402JobProgress: () => { throw new Error("boom"); } });
  ok(true, "a sink that throws never breaks the run");
  ok(JSON.stringify(normalizePatch({ stage: "s", done: 7, total: 4, junk: 1 })) === JSON.stringify({ stage: "s", done: 4, total: 4, progress: 1 }), "a patch is normalized: done held to total, unknown keys dropped");
}

// ---- progressView ---------------------------------------------------------------
{
  const now = 1_000_000;
  const base = { status: "working", phase: "queued", pollIntervalMs: 5000 };
  const q = progressView(base, { now, basisSeconds: 90, expectedSeconds: 90, maxSeconds: 180 });
  ok(q.status === "queued" && q.stage === "queued" && q.progress === 0 && q.etaSeconds === 90 && q.retryAfterSeconds >= 1, "queued");
  const est = progressView({ ...base, phase: "running", startedAtMs: now - 30_000, stage: "started" }, { now, basisSeconds: 90, expectedSeconds: 90, maxSeconds: 180 });
  ok(est.status === "running" && est.progressEstimated === true && Math.abs(est.progress - 1 / 3) < 0.01 && est.etaSeconds === 60 && est.elapsedSeconds === 30, `running with an estimate (${JSON.stringify(est)})`);
  const over = progressView({ ...base, phase: "running", startedAtMs: now - 200_000 }, { now, basisSeconds: 90, maxSeconds: 180 });
  ok(over.progress === 0.95 && over.progressEstimated === true && over.etaSeconds >= 0, "an estimate past the typical run holds under 1");
  const rep = progressView({ ...base, phase: "running", startedAtMs: now - 20_000, stage: "writing report", done: 3, total: 4, progress: 0.75 }, { now, basisSeconds: 90, maxSeconds: 180 });
  ok(rep.progressEstimated === false && rep.progress === 0.75 && rep.steps.done === 3 && rep.steps.total === 4 && rep.etaSeconds === 7 && rep.stage === "writing report", `running with reported steps (${JSON.stringify(rep)})`);
  ok(rep.retryAfterSeconds === 4, "Retry-After shortens as the answer nears (half the ETA, at most the poll interval)");
  const none = progressView({ ...base, phase: "running", startedAtMs: now - 5000 }, { now });
  ok(none.progress === null && none.etaSeconds === null && none.retryAfterSeconds === 5, "no profile and no report: progress and ETA are null, not guessed");
  const done = progressView({ status: "completed", startedAtMs: now - 50_000, endedAtMs: now - 1000 }, { now });
  ok(done.status === "succeeded" && done.progress === 1 && done.stage === "done" && done.elapsedSeconds === 49 && !("retryAfterSeconds" in done), "succeeded: no Retry-After");
  const failed = progressView({ status: "failed" }, { now });
  const cancelled = progressView({ status: "cancelled" }, { now });
  ok(failed.status === "failed" && cancelled.status === "failed" && cancelled.stage === "cancelled" && !("retryAfterSeconds" in failed), "failed and cancelled are final");
}

// ---- throttled writer -------------------------------------------------------------
{
  let t = 0;
  const writes = [];
  const w = throttledProgressWriter((p) => { writes.push(p); }, { minGapMs: 2000, now: () => t });
  w({ phase: "running" });
  w({ stage: "a" });
  await sleep(0);
  ok(writes.length === 2 && writes[1].stage === "a" && writes[1].phase === "running", "phase and stage changes are written at once, merged");
  w({ stage: "a" });
  ok(writes.length === 2, "a patch that changes nothing is not written");
  t += 100; w({ progress: 0.5 });
  await sleep(0);
  ok(writes.length === 2, "a fraction-only change inside the gap waits");
  t += 2000; await w.drain();
  ok(writes.length === 3 && writes[2].progress === 0.5, "and is written once the gap passes (drain)");
  w({ progress: 0.6 }); w.cancel(); t += 5000; await sleep(10);
  ok(writes.length === 3, "nothing is written after cancel");
}

// ---- task store update ---------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "job-progress-"));
  try {
    const store = createTaskStore({ dir, log: () => {} });
    const rec = await store.create({ slug: "research" });
    ok(rec.phase === "queued", "a new job is queued");
    ok(await store.update(rec.taskId, { phase: "running" }) && (await store.get(rec.taskId)).phase === "running" && (await store.get(rec.taskId)).startedAtMs > 0, "update moves it to running and stamps the start");
    await store.update(rec.taskId, { stage: "searching", done: 1, total: 5, progress: 0.2 });
    const r2 = await store.get(rec.taskId);
    ok(r2.stage === "searching" && r2.done === 1 && r2.total === 5 && r2.progress === 0.2 && r2.status === "working", "stage and steps are stored on the working record");
    await store.complete(rec.taskId, { ok: true });
    ok(await store.update(rec.taskId, { stage: "late" }) === false && (await store.get(rec.taskId)).stage === "searching" && (await store.get(rec.taskId)).status === "completed", "a terminal record is never updated");
    ok((await store.get(rec.taskId)).endedAtMs > 0, "the terminal transition stamps the end");
    ok(await store.update("0".repeat(48), { stage: "x" }) === false, "an unknown id is not created by an update");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
