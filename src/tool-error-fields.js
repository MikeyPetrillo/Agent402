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
    // Ids to retry with (a model refusal names the closest served ids), at
    // most three short strings.
    ...(suggestionsOf(err) ? { suggestions: suggestionsOf(err) } : {}),
    // An input over a size cap names the cap and the size it read.
    ...(isCount(err?.maxInputChars) ? { maxInputChars: err.maxInputChars } : {}),
    ...(isCount(err?.inputChars) ? { inputChars: err.inputChars } : {}),
  };
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const SUGGESTION_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
function suggestionsOf(err) {
  const s = Array.isArray(err?.suggestions) ? err.suggestions.filter((x) => typeof x === "string" && SUGGESTION_RE.test(x)).slice(0, 3) : [];
  return s.length ? s : null;
}
