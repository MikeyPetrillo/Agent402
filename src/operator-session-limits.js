// The operator browser session's two limits, read by the server that enforces
// them and by the pages that state them (src/dpa.js), so a page never types
// a figure the code does not run.
export const OP_SESSION_TTL_MS = 8 * 3600 * 1000;
/** Inside the absolute lifetime, a session ends after
 *  OPERATOR_SESSION_IDLE_SECONDS (default 1800) with no authenticated request. */
export function opSessionIdleMs(env = process.env) {
  return Math.min(OP_SESSION_TTL_MS, Math.max(1, Number(env.OPERATOR_SESSION_IDLE_SECONDS) || 1800) * 1000);
}
/** "30 minutes", "1 hour", "8 hours": a duration in whole minutes or hours. */
export function durationWords(ms) {
  const min = Math.round(ms / 60000);
  if (min % 60 === 0) { const h = min / 60; return `${h} hour${h === 1 ? "" : "s"}`; }
  return `${min} minute${min === 1 ? "" : "s"}`;
}
