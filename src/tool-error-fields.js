// The machine-readable fields a tool error carries into its JSON answer,
// shared by every writer of a catalog error so none drops one.
const HINT_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** { upstreamStatus?, attribution?, retryAfterSeconds?, hint?, retry?, refusedNetwork?, otherNetworksFrom? } from a thrown error. */
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
    // An image over a pixel cap names the caps, its own size and the longest
    // side to downscale to.
    ...imageCaps(err),
    // A refusal scoped to one payment network (the settle breaker's 429,
    // src/gateway-settle-breaker.js): what to do (retry: other-network), the
    // network refused, and where the route lists the others.
    ...(typeof err?.refusedNetwork === "string" && NETWORK_RE.test(err.refusedNetwork) ? {
      ...(typeof err?.retry === "string" && HINT_RE.test(err.retry) ? { retry: err.retry } : {}),
      refusedNetwork: err.refusedNetwork,
      ...(typeof err?.otherNetworksFrom === "string" && FIX_RE.test(err.otherNetworksFrom) ? { otherNetworksFrom: err.otherNetworksFrom } : {}),
    } : {}),
    // One plain sentence or two on how to recover (bounded, printable text).
    ...(typeof err?.fix === "string" && FIX_RE.test(err.fix) ? { fix: err.fix } : {}),
  };
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const isAmount = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
const NETWORK_RE = /^[a-z0-9]{3,8}:[A-Za-z0-9._=-]{1,64}$/; // CAIP-2
const FIX_RE = /^[\x20-\x7e]{1,400}$/;
// Each field is read by its own name, never by a computed key, so nothing an
// error carries beyond these numbers (its message, its stack) can reach the
// answer through this copy.
function imageCaps(err) {
  const read = {
    maxMegapixels: err?.maxMegapixels, maxSide: err?.maxSide, maxPixels: err?.maxPixels,
    width: err?.width, height: err?.height, megapixels: err?.megapixels,
    downscaleToLongestSide: err?.downscaleToLongestSide,
  };
  const out = {};
  for (const [k, v] of Object.entries(read)) if (isAmount(v)) out[k] = v;
  return out;
}
const SUGGESTION_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
function suggestionsOf(err) {
  const s = Array.isArray(err?.suggestions) ? err.suggestions.filter((x) => typeof x === "string" && SUGGESTION_RE.test(x)).slice(0, 3) : [];
  return s.length ? s : null;
}
