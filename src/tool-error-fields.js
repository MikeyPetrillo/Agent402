// The machine-readable fields a tool error carries into its JSON answer,
// shared by every writer of a catalog error so none drops one.
const HINT_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** { upstreamStatus?, attribution?, retryAfterSeconds?, hint? } from a thrown error. */
export function toolErrorFields(err) {
  const upstreamStatus = Number.isInteger(err?.upstreamStatus) ? err.upstreamStatus : null;
  const attribution = typeof err?.attribution === "string" ? err.attribution : upstreamStatus ? "upstream" : null;
  return {
    ...(upstreamStatus ? { upstreamStatus } : {}),
    ...(attribution ? { attribution } : {}),
    ...(Number.isInteger(err?.retryAfter) ? { retryAfterSeconds: err.retryAfter } : {}),
    // A short code the caller can branch on (e.g. "narrow-query").
    ...(typeof err?.hint === "string" && HINT_RE.test(err.hint) ? { hint: err.hint } : {}),
  };
}
