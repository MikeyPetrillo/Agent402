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
