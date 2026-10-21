// Progress for a paid call that runs as a job (an HTTP async job, src/async-jobs.js,
// or an MCP task on the connector, src/mcp-tasks.js).
//
// HOW A HANDLER REACHES ITS JOB. Both job kinds run the paid call as a loopback
// request to this same process. The caller registers a sink under a random
// in-process key and sends that key on the loopback in PROGRESS_HEADER; the
// middleware below finds the sink, removes the header, and puts the sink on
// the request's scope (src/request-timing.js). A handler, or any helper it
// calls, then reports with reportProgress({ stage, done, total, progress })
// and needs no request object. Outside a job the scope has no sink and the
// call does nothing. The key is never sent to a buyer and lives only in this
// process's memory, so a header from outside matches nothing.
//
// MONEY. Progress is bookkeeping only: it never touches a status code, a
// payment header or the response, and a sink that throws is swallowed. The
// job's terminal state is still written only by its runner, from the final
// loopback answer.
import { randomBytes } from "node:crypto";
import { currentRequestScope } from "./request-timing.js";

export const PROGRESS_HEADER = "x-agent402-job-progress";
const sinks = new Map(); // key -> sink(patch)

/** Register a sink; returns { key, release }. The key goes in PROGRESS_HEADER. */
export function registerProgressSink(sink) {
  const key = randomBytes(18).toString("hex");
  sinks.set(key, sink);
  return { key, release: () => { sinks.delete(key); } };
}
export const _sinkCountForTest = () => sinks.size;

/** Middleware: attach a registered sink to this request's scope. Mounted after
 *  the request-timing scope exists and before any handler runs. */
export function progressMiddleware() {
  return function jobProgress(req, _res, next) {
    const raw = req.headers[PROGRESS_HEADER];
    if (raw === undefined) return next();
    delete req.headers[PROGRESS_HEADER];
    const sink = typeof raw === "string" ? sinks.get(raw) : null;
    if (sink) {
      const scope = currentRequestScope();
      if (scope) scope.jobProgress = sink;
      Object.defineProperty(req, "__a402JobProgress", { value: sink, configurable: true, enumerable: false, writable: true });
    }
    next();
  };
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));
/** Normalize a patch to the fields a job stores; drops anything else. */
export function normalizePatch(patch = {}) {
  const out = {};
  if (patch.phase === "running" || patch.phase === "queued") out.phase = patch.phase;
  if (typeof patch.stage === "string" && patch.stage) out.stage = patch.stage.slice(0, 60);
  const done = Number(patch.done), total = Number(patch.total);
  if (Number.isInteger(total) && total > 0 && Number.isInteger(done) && done >= 0) { out.done = Math.min(done, total); out.total = total; }
  if (Number.isFinite(Number(patch.progress)) && patch.progress !== null && patch.progress !== undefined) out.progress = clamp01(Number(patch.progress));
  else if (out.total) out.progress = out.done / out.total;
  return out;
}

/** Report progress from inside a handler (no-op outside a job). Never throws. */
export function reportProgress(patch, req = null) {
  try {
    const sink = req?.__a402JobProgress || currentRequestScope()?.jobProgress;
    if (typeof sink !== "function") return;
    const p = normalizePatch(patch);
    if (Object.keys(p).length) sink(p);
  } catch { /* progress must never fail a run */ }
}

/** Called once when the paid handler starts (the payment gate has passed). */
export function reportHandlerStarted(req = null) {
  reportProgress({ phase: "running", stage: "started" }, req);
}

/**
 * A step counter for a composite: `steps.next("label")` marks the previous
 * step done and names the next one; `steps.done()` marks every step done. A
 * nested composite (one report run inside another) reports into the same job,
 * so only the outermost counter that is live reports.
 */
export function stepProgress(total, req = null) {
  const scope = currentRequestScope();
  const owner = Symbol("steps");
  if (scope && !scope.jobStepsOwner) scope.jobStepsOwner = owner;
  const mine = () => !scope || scope.jobStepsOwner === owner;
  let done = 0;
  return {
    next(stage) { if (!mine()) return; reportProgress({ stage, done, total }, req); done = Math.min(total, done + 1); },
    done(stage = "finishing") { if (!mine()) return; reportProgress({ stage, done: total, total }, req); },
  };
}

/**
 * A throttled writer for a job record: the newest patch always wins, a change
 * of phase or stage or step is written at once, and any other update at most
 * every `minGapMs`. Writes are serialized so they land in order. `write(patch)`
 * may return a promise; its failure is ignored (progress is advisory).
 */
export function throttledProgressWriter(write, { minGapMs = 2000, now = () => Date.now() } = {}) {
  let last = {}, lastAt = 0, chain = Promise.resolve(), pending = null, timer = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const p = pending; pending = null; lastAt = now();
    chain = chain.then(() => write(p)).catch(() => {});
  };
  const fn = (patch) => {
    // A patch that changes nothing (a poll loop reporting the same stage) is not written.
    if (Object.keys(patch).every((k) => last[k] === patch[k])) return;
    const merged = { ...last, ...patch };
    const sharp = merged.phase !== last.phase || merged.stage !== last.stage || merged.done !== last.done;
    last = merged;
    pending = merged;
    if (sharp || now() - lastAt >= minGapMs) { if (timer) { clearTimeout(timer); timer = null; } flush(); }
    else if (!timer) { timer = setTimeout(flush, Math.max(0, minGapMs - (now() - lastAt))); timer.unref?.(); }
  };
  fn.drain = () => { if (timer) { clearTimeout(timer); timer = null; } flush(); return chain; };
  fn.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } pending = null; };
  return fn;
}

/**
 * The progress view of a job record, for GET /api/jobs/:id and tasks/get.
 *   status: queued | running | succeeded | failed
 *   stage, progress (0-1 or null), progressEstimated, steps, etaSeconds,
 *   elapsedSeconds, expectedSeconds, maxSeconds, retryAfterSeconds (non-final)
 * A record with no reported progress gets an estimate from elapsed time
 * against `basisSeconds` (the route's typical run, or half its budget when no
 * typical run is measured), labeled progressEstimated. `expectedSeconds` is
 * the measured typical run, shown only when there is one.
 */
export function progressView(rec, { now = Date.now(), basisSeconds = null, expectedSeconds = null, maxSeconds = null, pollSeconds = 5 } = {}) {
  const terminal = rec.status === "completed" || rec.status === "failed" || rec.status === "cancelled";
  // A working record with no phase predates progress reporting: its run had
  // already started, so it reads as running.
  const status = rec.status === "completed" ? "succeeded" : terminal ? "failed" : rec.phase === "queued" ? "queued" : "running";
  const view = { status };
  const startMs = Number(rec.startedAtMs) || null;
  const elapsed = startMs ? Math.max(0, (now - startMs) / 1000) : 0;
  if (terminal) {
    view.stage = rec.status === "completed" ? "done" : rec.status === "cancelled" ? "cancelled" : "failed";
    view.progress = rec.status === "completed" ? 1 : null;
    view.etaSeconds = 0;
    if (startMs) view.elapsedSeconds = Math.round(((Number(rec.endedAtMs) || now) - startMs) / 1000);
    return view;
  }
  if (status === "queued") {
    view.stage = "queued";
    view.progress = 0;
    view.etaSeconds = basisSeconds != null ? Math.round(basisSeconds) : null;
  } else {
    view.stage = rec.stage || "running";
    view.elapsedSeconds = Math.round(elapsed);
    const reported = Number.isFinite(rec.progress) ? rec.progress : null;
    if (rec.total > 0) view.steps = { done: rec.done ?? 0, total: rec.total };
    if (reported != null) {
      view.progress = Math.round(reported * 1000) / 1000;
      view.progressEstimated = false;
      // Straight-line ETA from the reported fraction, never past the budget.
      let eta = reported > 0.02 ? elapsed * (1 - reported) / reported : basisSeconds != null ? Math.max(0, basisSeconds - elapsed) : null;
      if (eta != null && maxSeconds > 0) eta = Math.min(eta, Math.max(0, maxSeconds - elapsed));
      view.etaSeconds = eta != null ? Math.round(eta) : null;
    } else if (basisSeconds > 0) {
      // No reported fraction: elapsed time against the typical run, held under 0.95.
      view.progress = Math.round(Math.min(0.95, elapsed / basisSeconds) * 1000) / 1000;
      view.progressEstimated = true;
      const eta = elapsed < basisSeconds ? basisSeconds - elapsed : maxSeconds > elapsed ? Math.min(10, maxSeconds - elapsed) : 5;
      view.etaSeconds = Math.round(eta);
    } else {
      view.progress = null;
      view.etaSeconds = null;
    }
  }
  if (expectedSeconds != null) view.expectedSeconds = Math.round(expectedSeconds);
  if (maxSeconds != null) view.maxSeconds = maxSeconds;
  const eta = view.etaSeconds;
  view.retryAfterSeconds = Math.max(1, Math.min(pollSeconds, eta != null && eta > 0 ? Math.ceil(eta / 2) : pollSeconds));
  return view;
}
