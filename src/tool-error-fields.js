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

/** The attribution an error carries: its own `attribution`, else "upstream"
 *  when it carries the upstream's status, else null (the vocabulary is in
 *  src/upstream-deadline.js: upstream | upstream-access | caller | ours | unknown). */
export function attributionOf(err) {
  if (typeof err?.attribution === "string") return err.attribution;
  return Number.isInteger(err?.upstreamStatus) ? "upstream" : null;
}

/** True when the failure is not the caller's input: an error attributed to
 *  anyone but the caller, or any 5xx. Such an answer never echoes the input
 *  schema back as a fix. */
export function notCallersInput(err, status) {
  const a = attributionOf(err);
  return (a !== null && a !== "caller") || status >= 500;
}

const NO_CHARGE_FREE = "this free call presented no payment, so there was nothing to charge";
/**
 * Whose fault, and the next step that can work, for a free call's error that
 * is not the caller's input (notCallersInput). A third party is named as
 * failing only when the error is attributed "upstream" or "upstream-access",
 * which only a definite answer from it sets; our own limit, budget,
 * resolver, key, allowance or defect says so; a URL the caller supplied that
 * gave no answer gets "check the URL, or retry".
 */
export function faultAdvice(err, status) {
  const a = attributionOf(err);
  const kind = typeof err?.hint === "string" ? err.hint : null;
  const say = (whose, nextStep) => ({ whoseFault: `${whose}; ${NO_CHARGE_FREE}`, nextStep });
  if (a === "upstream") return say("not your input - a third party this tool depends on refused or failed our request", "retry the SAME call later; changing the input will not help");
  if (a === "upstream-access") return say("not your input - a third party this tool depends on refused this server's access", "this resource is not reachable by this server; a different source may be, but the same call will keep failing");
  if (kind === "source-timeout" || kind === "source-unreachable") {
    return say(`the URL you supplied ${kind === "source-timeout" ? "did not answer within our time limit" : "could not be connected to from this server"}; nothing shows whether the URL or the path to it is at fault`, "check that the URL is correct and publicly reachable, or retry the SAME call");
  }
  if (kind === "smaller-input") return say("our time limit for this call passed on an input this long; the input is valid, but it is long enough to outlast the limit", "send a shorter input");
  if (kind === "our-deadline" || kind === "budget-spent") return say("not your input - our own time limit for this call passed before an answer came back, which shows nothing about the source", "retry the SAME call");
  if (kind === "our-egress") return say("not your input - this server could not look up the source's host (its own DNS lookup failed)", "retry the SAME call shortly");
  if (kind === "our-pacing") return say("not your input - this server's own request pacing for the source has no room this moment", "retry the SAME call in a few seconds");
  if (kind === "our-key" || kind === "our-allowance") return say("not your input - this server's own key or allowance with the source refused the call", "retry the SAME call later; changing the input will not help");
  if (a === "unknown") return say("not your input - the source could not be reached from this server, and nothing shows which side failed", "retry the SAME call later");
  if (a === "ours" || status === 500) return say("not your input as far as this server can tell - an internal error on our side", "retry the SAME call once; if it fails the same way, the defect is ours");
  return say("not your input - this call could not be completed", "retry the SAME call later");
}
