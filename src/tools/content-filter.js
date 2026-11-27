// Whether a provider's error says its content filter stopped the request or
// its output: the rule the video, image and image-gen routes share, so each
// answers 422 with reason content_filtered (the prompt is what has to change)
// instead of a 502 that reads as our failure.
//
// Signals: a moderation code or type on the error object, or wording that
// says the content was filtered or refused by the filter. A bare "content
// filter" or "safety system" also names the service in an outage ("Content
// moderation service is temporarily unavailable"), so it does not count, and
// any text that carries an outage marker is never a filtered verdict,
// whatever else it says. Bounded patterns only: the text is the upstream's
// and can quote the prompt.
export const CONTENT_FILTER_CODES = new Set(["content_filter", "content_filtered", "content_policy_violation", "moderation_blocked", "safety_violation", "safety_violations", "responsible_ai_policy_violation"]);
const FILTER_TEXT_RE = /\bcontent (?:may have been |was |has been )?(?:filtered|moderated)\b|\bcontent[ _-]polic(?:y|ies) violation\b|\bmoderation[ _-]blocked\b|\bsafety violations?\b|\b(?:blocked|flagged|rejected|refused) (?:by|as a result of) (?:the |our |its )?(?:safety|moderation|content) (?:filter|system|check|policy)\b/i;
// An outage worded as a rejection ("Request rejected by the moderation
// system: service overloaded") is still an outage: the same prompt may pass
// on a retry, so it must never read as "rephrase". ("try again" alone is
// not a marker: a filter's own message says "rephrase and try again".)
const OUTAGE_TEXT_RE = /\b(?:unavailable|timed? ?out|timeout|internal error|retry|try again (?:later|shortly|soon|in )|overloaded|overload|capacity|rate[ _-]?limit(?:ed|s)?|too many requests|busy|5\d\d)\b/i;

/** `error` is the provider's error: a string, or an object with message,
 *  code and type. */
export function providerContentFiltered(error) {
  const codes = error && typeof error === "object" ? [error.code, error.type] : [];
  const text = (typeof error === "string" ? error : (error && typeof error.message === "string" ? error.message : "")).slice(0, 2_000);
  if (OUTAGE_TEXT_RE.test(text)) return false;
  if (codes.some((c) => typeof c === "string" && CONTENT_FILTER_CODES.has(c.toLowerCase()))) return true;
  return FILTER_TEXT_RE.test(text);
}

/** The same for an error answer's body text (JSON with an `error`, or raw). */
export function providerBodyContentFiltered(text) {
  const raw = String(text || "").slice(0, 8_000);
  let error = raw;
  try { const j = JSON.parse(raw); if (j && typeof j === "object") error = j.error ?? ""; } catch { /* raw text */ }
  return providerContentFiltered(error);
}
