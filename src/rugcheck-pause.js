// Automatic pause for the RugCheck-backed tools while RugCheck is not
// answering. RUGCHECK_TOOLS (src/rugcheck-switch.js) decides whether the tools
// exist at all; this only takes them off the offer for a cool-down when their
// upstream has stopped answering, so a buyer meets a free 503 with a
// Retry-After before any payment instead of signing for a call that can only
// time out.
//
//   * Every RugCheck read reports its outcome. A deadline, an unreachable
//     host, a 5xx or a "cannot produce a report" answer is a failure; any
//     other answer (a report, or a refusal of the input) resets the count.
//   * RUGCHECK_PAUSE_AFTER consecutive failures (default 3) pause the tools
//     for RUGCHECK_PAUSE_MS (default 5 minutes).
//   * After the cool-down the tools are offered again (fail open). The next
//     read decides: a success clears the state, one more failure starts a
//     new cool-down.
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
  let failures = 0;
  let pausedUntil = 0;
  let probation = false; // true after a cool-down ends, until the next read

  function noteFailure(why = "failure") {
    const c = config(env);
    failures++;
    if (!c.enabled) return;
    if (probation || failures >= c.after) {
      pausedUntil = now() + c.pauseMs;
      probation = false;
      log(`[rugcheck-pause] ${failures} consecutive RugCheck failures (last: ${why}); RugCheck tools paused for ${Math.round(c.pauseMs / 1000)} s`);
    }
  }

  function noteSuccess() {
    failures = 0;
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

  return { noteFailure, noteSuccess, state, failures: () => failures };
}

export const rugcheckPause = createRugcheckPause();

/** True for a read failure that means RugCheck is not answering. */
export function isRugcheckOutage(err) {
  if (!err) return false;
  if (err.upstreamFailure === "deadline" || err.upstreamFailure === "unreachable") return true;
  return err.statusCode === 502 || err.statusCode === 503;
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
