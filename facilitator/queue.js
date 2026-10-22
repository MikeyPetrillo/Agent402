// A minimal promise-chain serializer. Used to make settlement calls
// genuinely one-at-a-time (not just "usually" - the facilitator's single
// signer account has one Stellar sequence number, and two concurrent
// settlements both reading it before either submits is a proven, live-tested
// failure mode: one of them gets rejected before it ever reaches a ledger).
//
// Deliberately NOT a generic job queue with concurrency limits, retries, or
// backpressure - just enough to guarantee ordering for this one call site.
//
// A job may answer its caller before its work has stopped (a timed-out
// settle). The job receives hold(promise): the next job does not start until
// that promise settles, even after the caller has its answer. holdMaxMs
// bounds the wait, so a promise that never settles cannot stop the queue for
// good; by then settle-deadline.js has refused any new submission, so what
// can still be running is a submission already sent, or its poll.
export function createSerialQueue({ holdMaxMs = 0, log = console.log } = {}) {
  let tail = Promise.resolve();
  return function enqueue(fn) {
    let held = null;
    const hold = (p) => { held = p; };
    const run = () => fn(hold);
    const result = tail.then(run, run);
    // Swallow so one failed job never poisons the chain for the next job -
    // each caller still gets its own rejection via `result`.
    tail = result.then(() => {}, () => {}).then(() => waitHeld(held, holdMaxMs, log));
    return result;
  };
}

function waitHeld(held, holdMaxMs, log) {
  if (!held || typeof held.then !== "function") return undefined;
  const done = Promise.resolve(held).then(() => {}, () => {});
  if (!(Number(holdMaxMs) > 0)) return done;
  let timer;
  const cap = new Promise((resolve) => {
    timer = setTimeout(() => { log(`[queue] held work still running after ${holdMaxMs}ms; releasing the slot`); resolve(); }, holdMaxMs);
  });
  return Promise.race([done, cap]).finally(() => clearTimeout(timer));
}

// FACILITATOR_SETTLE_HOLD_MAX_MS, read as a positive, bounded cap. Anything
// that is not a positive number (unset, garbage, zero, negative) takes the
// default, and the value is held to [1 s, 10 min], so no setting can remove
// the cap (waitHeld treats a non-positive cap as none).
export const HOLD_MAX_FLOOR_MS = 1_000;
export const HOLD_MAX_CEILING_MS = 600_000;
export function holdMaxFrom(raw, fallbackMs) {
  const n = Number(raw);
  const fb = Math.min(HOLD_MAX_CEILING_MS, Math.max(HOLD_MAX_FLOOR_MS, Number(fallbackMs) || HOLD_MAX_FLOOR_MS));
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(n) || n <= 0) return fb;
  return Math.min(HOLD_MAX_CEILING_MS, Math.max(HOLD_MAX_FLOOR_MS, n));
}
