// Abort in-flight composites on SIGTERM.
//
// A redeploy sends SIGTERM; shutdown() closes the listener and drains what is
// in flight, exiting within DRAIN_DEADLINE_MS (75 s). The dispatcher refuses
// to START a composite while draining (503, never charged). What it could not
// do until 2026-09-02 was stop one already running: a report composite (30 s to
// 4 min of OpenRouter, Brave, EDGAR calls) kept running to the deadline, the
// upstream money was spent, the process exited, and the buyer's request died
// with the container - never charged, because no 200 was ever written, so
// every such deploy was pure loss.
//
// The kits are many and their upstream calls are everywhere, so the signal is
// not threaded through each one. Instead: a composite runs inside an
// AsyncLocalStorage scope, and a global fetch wrapper joins the process-wide
// drain signal onto every outbound call made inside that scope (AbortSignal.any
// with whatever signal the caller already passed). shutdown() aborts the
// controller; every waiting upstream call rejects at once; the handler throws;
// the response is a 503 (>= 400 cancels settlement); the process can exit as
// soon as the socket closes. A fetch OUTSIDE a composite scope is untouched -
// an ordinary in-flight request still completes after SIGTERM, which
// test-drain-on-sigterm pins.
//
// Bounded honesty: an OpenRouter generation that has already finished
// server-side is billed whether or not we read the response. Aborting saves
// every call not yet started and every one still generating, which for a
// multi-call report is most of the spend; it cannot claw back a completed one.
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage();
let controller = new AbortController();
let active = 0;
let installed = false;

/** Run `fn` as a composite: every fetch inside inherits the drain signal. */
export async function runInAbortableScope(fn) {
  active++;
  try { return await scope.run({ abortable: true }, fn); }
  finally { active--; }
}

export function inAbortableScope() { return scope.getStore()?.abortable === true; }
export function drainSignal() { return controller.signal; }
export function activeAbortableScopes() { return active; }

/** Called by shutdown(): every composite in flight is cut off now. Returns how many were running. */
export function abortInFlightComposites(reason = "draining") {
  const n = active;
  if (!controller.signal.aborted) controller.abort(Object.assign(new Error(`${reason}: composite aborted so the deploy can complete`), { name: "AbortError", statusCode: 503 }));
  return n;
}

/** An error produced by the drain abort (or an AbortError raised while draining). */
export function isDrainAbort(err) {
  if (!err) return false;
  if (err === controller.signal.reason) return true;
  return controller.signal.aborted && String(err.name) === "AbortError";
}

/** Install the fetch wrapper once. Idempotent. `fetchImpl` for tests. */
export function installDrainAwareFetch({ fetchImpl } = {}) {
  const target = fetchImpl || globalThis.fetch;
  if (!target) return null;
  if (!fetchImpl && installed) return globalThis.fetch;
  const wrapped = function drainAwareFetch(input, init) {
    if (!inAbortableScope()) return target.call(this, input, init);
    if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
    const own = init?.signal;
    const signal = own ? AbortSignal.any([own, controller.signal]) : controller.signal;
    return target.call(this, input, { ...(init || {}), signal });
  };
  wrapped.__a402DrainAware = true;
  if (!fetchImpl) { globalThis.fetch = wrapped; installed = true; }
  return wrapped;
}

/** Test seam: a fresh controller so one test's abort does not poison the next. */
export function __resetDrainForTest() { controller = new AbortController(); }
