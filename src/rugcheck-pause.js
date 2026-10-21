// Automatic pause for the RugCheck-backed tools while RugCheck is not
// answering. RUGCHECK_TOOLS (src/rugcheck-switch.js) decides whether the tools
// exist at all; this only takes them off the offer for a cool-down when their
// upstream has stopped answering, so a buyer meets a free 503 with a
// Retry-After before any payment instead of signing for a call that can only
// time out.
//
//   * Every RugCheck read reports its outcome, keyed by the input it read (the
//     mint). Only a failure that says RugCheck itself is down counts: an
//     unreachable host, a deadline the read's own cap ran out on, a 5xx or a
//     rate limit. A report, or a refusal of the input (4xx, no report), resets
//     the count. A failure that belongs to the input or to the caller counts
//     for nothing either way: "unable to generate" for a mint, or a deadline
//     the handler's budget cut short or had already spent.
//   * RUGCHECK_PAUSE_AFTER consecutive failures (default 3) pause the tools
//     for RUGCHECK_PAUSE_MS (default 5 minutes), but only when they span at
//     least two distinct inputs: one mint that reliably times out or errors
//     is that mint's answer, not an outage, and never pauses the tools. An
//     unreachable host is independent of the input, so it needs no second one.
//   * After the cool-down the tools are offered again (fail open). The next
//     reads decide: a success clears the state; an unreachable host, or
//     failures on two distinct inputs, start a new cool-down.
//
// State is per process; each replica learns from its own reads.
// RUGCHECK_PAUSE=off disables the pause (reads still report, nothing pauses).
import { RUGCHECK_SLUGS } from "./rugcheck-switch.js";

const DEFAULT_AFTER = 3;
const DEFAULT_PAUSE_MS = 5 * 60_000;

function config(env = process.env) {
  const after = Number.parseInt(env.RUGCHECK_PAUSE_AFTER || "", 10);
  const ms = Number.parseInt(env.RUGCHECK_PAUSE_MS || "", 10);
  return {
    enabled: String(env.RUGCHECK_PAUSE || "").trim().toLowerCase() !== "off",
    after: Number.isInteger(after) && after > 0 ? after : DEFAULT_AFTER,
    pauseMs: Number.isInteger(ms) && ms > 0 ? ms : DEFAULT_PAUSE_MS,
  };
}

export function createRugcheckPause({ now = () => Date.now(), env = process.env, log = (m) => console.warn(m) } = {}) {
  let streak = [];       // the consecutive failures' input keys
  let pausedUntil = 0;
  let probation = false; // true after a cool-down ends, until the next success
  let seq = 0;

  /**
   * One read that failed with RugCheck down. `key` names the input (the
   * mint); `kind` is "unreachable" (independent of the input), "deadline" or
   * "upstream" (a 5xx or a rate limit). A failure without a key is one input.
   */
  function noteFailure(why = "failure", { key = null, kind = "deadline" } = {}) {
    const c = config(env);
    streak.push(kind === "unreachable" ? `#unreachable:${++seq}` : `in:${key ?? "?"}`);
    if (streak.length > 64) streak = streak.slice(-64);
    if (!c.enabled) return;
    const distinct = new Set(streak).size;
    const trip = probation ? distinct >= 2 || kind === "unreachable" : streak.length >= c.after && distinct >= 2;
    if (!trip) return;
    log(`[rugcheck-pause] ${streak.length} consecutive RugCheck failures across ${distinct} reads (last: ${why}); RugCheck tools paused for ${Math.round(c.pauseMs / 1000)} s`);
    pausedUntil = now() + c.pauseMs;
    probation = false;
    streak = [];
  }

  function noteSuccess() {
    streak = [];
    probation = false;
    pausedUntil = 0;
  }

  /** { paused, retryAfterSeconds }. A cool-down that has ended opens probation. */
  function state() {
    if (!config(env).enabled || !pausedUntil) return { paused: false, retryAfterSeconds: 0 };
    const left = pausedUntil - now();
    if (left > 0) return { paused: true, retryAfterSeconds: Math.max(1, Math.ceil(left / 1000)) };
    pausedUntil = 0;
    probation = true;
    return { paused: false, retryAfterSeconds: 0 };
  }

  return { noteFailure, noteSuccess, state, failures: () => streak.length };
}

export const rugcheckPause = createRugcheckPause();

/**
 * How a RugCheck read failure counts toward the pause:
 *   "unreachable" | "deadline" | "upstream"  RugCheck itself is down
 *   "neutral"  the input's or the caller's failure; counts for nothing
 *   "answer"   RugCheck answered (a refusal of the input); resets the count
 * `budgetShortened`: the read ran under less than its own cap because the
 * handler's budget was nearly (or wholly) spent, so its deadline is the
 * caller's, not RugCheck's.
 */
export function rugcheckFailureKind(err, { budgetShortened = false } = {}) {
  if (!err) return "answer";
  if (err.rugcheckNoReport) return "neutral";
  if (err.upstreamFailure === "unreachable") return "unreachable";
  if (err.upstreamFailure === "deadline") return budgetShortened ? "neutral" : "deadline";
  if (err.statusCode === 502 || err.statusCode === 503) return "upstream";
  return "answer";
}

/** True for a read failure that means RugCheck is not answering. */
export function isRugcheckOutage(err, opts) {
  const k = rugcheckFailureKind(err, opts);
  return k === "unreachable" || k === "deadline" || k === "upstream";
}

/** The input a RugCheck URL reads (the mint), for counting distinct inputs. */
export function rugcheckInputKey(url) {
  const s = String(url || "");
  const m = /\/tokens\/([^/?#]+)/.exec(s);
  return m ? m[1] : s;
}

/**
 * Express middleware, mounted before every payment gate: while paused, a call
 * to a RugCheck-backed route answers 503 with Retry-After and is not charged.
 * `routes` lists the "METHOD /path" keys the RugCheck-backed tools serve on.
 */
export function rugcheckPauseMiddleware(routes, pause = rugcheckPause) {
  const keys = new Set(routes);
  return (req, res, next) => {
    const m = req.method === "HEAD" ? "GET" : req.method;
    const twin = m === "GET" ? "POST" : m === "POST" ? "GET" : null;
    if (!keys.has(`${m} ${req.path}`) && !(twin && keys.has(`${twin} ${req.path}`))) return next();
    const s = pause.state();
    if (!s.paused) return next();
    res.set("Cache-Control", "no-store").set("Retry-After", String(s.retryAfterSeconds));
    return res.status(503).json({
      error: `RugCheck, the source of this tool, is not answering right now, so the RugCheck-backed tools are paused. Not charged - retry in about ${s.retryAfterSeconds} s.`,
      attribution: "upstream",
      retryAfterSeconds: s.retryAfterSeconds,
    });
  };
}

export { RUGCHECK_SLUGS };
