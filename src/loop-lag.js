// Event-loop lag monitor, always on.
//
// Built 2026-08-30 to answer one question with evidence instead of a hypothesis:
// seven Solana verifies failed with `fetch failed [UND_ERR_CONNECT_TIMEOUT]`
// while CDP answered from outside in 15-37 ms. A CONNECT timeout means undici's
// timer fired before a TCP connection was established - and that timer is a
// TIMER, so a blocked event loop produces exactly this error with a perfectly
// healthy network. Everything else was ruled out: rate limits return 429 (an
// answer, and their ceiling is 500 writes / 10 s), IPv6 is already forced off
// process-wide, the client uses plain fetch and so inherits that, and CDP was
// reachable throughout.
//
// We only ever instrumented BOOT (boot-profile.js, written after a 15.5 s hold),
// so a stall four hours into a container's life was invisible. This closes that:
// the next CDP timeout either coincides with a logged stall or it does not, and
// one occurrence settles which side the fault is on.
//
// Deliberately cheap: one timer, no sampling profiler, no allocation per tick.
// The measurement is the only honest one available in-process - schedule a timer
// for N ms and see how late it actually fires. Lateness IS the lag.

const TICK_MS = Number(process.env.LOOP_LAG_TICK_MS) || 500;
const WARN_MS = Number(process.env.LOOP_LAG_WARN_MS) || 1000;
const state = { worstMs: 0, worstAt: null, stalls: 0, lastStallMs: 0, lastStallAt: null, startedAt: null };

/** @returns {{worstMs:number, worstAt:string|null, stalls:number, lastStallMs:number, lastStallAt:string|null, watching:boolean}} */
export function loopLagStatus() {
  return {
    watching: state.startedAt !== null,
    worstMs: Math.round(state.worstMs),
    worstAt: state.worstAt,
    stalls: state.stalls,
    lastStallMs: Math.round(state.lastStallMs),
    lastStallAt: state.lastStallAt,
  };
}

/** Reset the high-water mark (the operator endpoint offers this; alarms do not). */
export function resetLoopLag() {
  state.worstMs = 0; state.worstAt = null; state.stalls = 0; state.lastStallMs = 0; state.lastStallAt = null;
}

export function startLoopLagMonitor({ tickMs = TICK_MS, warnMs = WARN_MS, log = console.warn } = {}) {
  if (state.startedAt) return () => {};
  state.startedAt = Date.now();
  let expected = Date.now() + tickMs;
  const timer = setInterval(() => {
    const now = Date.now();
    const late = now - expected;          // how much later than scheduled it ran
    expected = now + tickMs;
    if (late <= 0) return;
    if (late > state.worstMs) { state.worstMs = late; state.worstAt = new Date(now).toISOString(); }
    if (late >= warnMs) {
      state.stalls++; state.lastStallMs = late; state.lastStallAt = new Date(now).toISOString();
      // One line, with the number, so it can be correlated against a payment
      // failure by timestamp. Anything richer belongs in a profiler run.
      log(`[loop-lag] event loop blocked ${Math.round(late)}ms (stall #${state.stalls}) - in-flight sockets can hit connect timeouts while this lasts`);
    }
  }, tickMs);
  // Never hold the process open: a diagnostic must not change shutdown.
  if (typeof timer.unref === "function") timer.unref();
  return () => { clearInterval(timer); state.startedAt = null; };
}
