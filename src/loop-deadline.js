// A deadline for an I/O wait that counts the time the event loop could have
// read the answer, not the time the loop was held.
//
// A plain setTimeout deadline misfires when the loop is busy: the command is
// sent, synchronous work (a boot's catalog build, a large parse) holds the
// loop past the deadline while the answer sits unread in the socket, and when
// the loop frees the timers phase runs before the poll phase, so the timeout
// fires first and a store that answered in a millisecond is booked as one that
// did not answer. Two corrections, both bounded:
//   - a timer that fires late (the loop was held) is re-armed once for the
//     held time, up to `ms` more, so the wait gets the loop time it was owed;
//   - the expiry itself runs on setImmediate, after the poll phase of the same
//     loop turn, so an answer already in the socket or the threadpool is
//     taken before the deadline is declared.
// A wait on a store that is really down still ends: at most 2 x ms plus the
// held time plus one loop turn.
const LATE_MS = 20;

/**
 * Call `onExpire` after `ms` of loop time. Returns cancel(). `now` is a test
 * seam. The timer is unref'd unless `ref` is true (a wait that must keep the
 * process alive until it answers or expires).
 */
export function loopDeadline(ms, onExpire, { now = () => performance.now(), ref = false } = {}) {
  let done = false, timer = null, immediate = null, rearmed = false;
  let due = now() + ms;
  const expire = () => { immediate = setImmediate(() => { immediate = null; if (!done) { done = true; onExpire(); } }); };
  const arm = (wait) => {
    timer = setTimeout(() => {
      timer = null;
      if (done) return;
      const late = now() - due;
      if (!rearmed && late > LATE_MS) {
        rearmed = true;
        const extra = Math.min(ms, late);
        due = now() + extra;
        arm(extra);
        return;
      }
      expire();
    }, Math.max(0, wait));
    if (!ref) timer.unref?.();
  };
  arm(ms);
  return () => { done = true; if (timer) clearTimeout(timer); if (immediate) clearImmediate(immediate); };
}

/** Resolve `p`, or reject with `error()` when it has not settled within `ms` of loop time. */
export function withLoopTimeout(p, ms, error, { ref = false } = {}) {
  return new Promise((resolve, reject) => {
    const cancel = loopDeadline(ms, () => reject(error()), { ref });
    Promise.resolve(p).then((v) => { cancel(); resolve(v); }, (e) => { cancel(); reject(e); });
  });
}

/** Resolve `p`, or `fallback` when it has not settled within `ms` of loop time (p keeps running). */
export function withLoopDeadline(p, ms, fallback = null) {
  return new Promise((resolve, reject) => {
    const cancel = loopDeadline(ms, () => resolve(fallback));
    Promise.resolve(p).then((v) => { cancel(); resolve(v); }, (e) => { cancel(); reject(e); });
  });
}
