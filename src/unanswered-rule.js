// "Did not answer within our limit": the one rule for noticing an upstream
// that hangs, without claiming the upstream is down.
//
// Our own deadline firing proves nothing about the upstream on one call: a
// long input can need more than our cap, and that is one caller's input size.
// The same deadline firing on ONE upstream across many calls from several
// callers inside a window, while other upstreams answer (in the same
// five-minute buckets, for the failure monitor), is a pattern worth
// acting on: the failure monitor publishes it as upstreamHealth=unanswered
// (src/tool-failure-monitor.js), and the speech and direct-upstream breakers
// route the next callers to their backups for a cool-down. Every text this
// rule drives says "did not answer within our limit", never that the upstream
// failed.
//
// Thresholds (env, read at each call):
//   UPSTREAM_UNANSWERED_WINDOW_MS   the window (default 15 minutes)
//   UPSTREAM_UNANSWERED_MIN         deadlines in the window (default 5)
//   UPSTREAM_UNANSWERED_MIN_CALLERS distinct callers among them (default 3)
//   UPSTREAM_UNANSWERED_RATE        share of the upstream's calls in the window
//                                   that ended at our deadline (default 0.5; the
//                                   failure monitor reads it, the breakers see
//                                   only their own deadlines and successes)
// A caller is a keyed hash of the request's client address
// (src/request-timing.js callerKey); work outside a request is one caller,
// "background".
import { positiveNum as num } from "./env-num.js";

export function unansweredSettings(env = process.env) {
  return {
    windowMs: num(env.UPSTREAM_UNANSWERED_WINDOW_MS, 15 * 60_000),
    minCalls: num(env.UPSTREAM_UNANSWERED_MIN, 5),
    minCallers: num(env.UPSTREAM_UNANSWERED_MIN_CALLERS, 3),
    rate: num(env.UPSTREAM_UNANSWERED_RATE, 0.5),
  };
}

/** The caller key for a deadline event (a missing key is "background"). */
export const callerOf = (key) => (typeof key === "string" && key ? key.slice(0, 32) : "background");

/**
 * One link's recent deadlines of ours. note(caller) records one; reached()
 * says whether the window now holds the pattern; clear() forgets them (an
 * answer from the link). Bounded: at most 256 events kept.
 */
export function createUnansweredTracker({ env = process.env, now = Date.now } = {}) {
  let events = []; // { at, caller }
  const trim = () => {
    const { windowMs } = unansweredSettings(env);
    const floor = now() - windowMs;
    events = events.filter((e) => e.at > floor).slice(-256);
  };
  return {
    note(caller) { events.push({ at: now(), caller: callerOf(caller) }); trim(); return this.reached(); },
    reached() {
      trim();
      const s = unansweredSettings(env);
      return events.length >= s.minCalls && new Set(events.map((e) => e.caller)).size >= s.minCallers;
    },
    clear() { events = []; },
    state() { trim(); return { deadlines: events.length, callers: new Set(events.map((e) => e.caller)).size }; },
  };
}
