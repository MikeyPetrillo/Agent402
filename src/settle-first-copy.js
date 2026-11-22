// The one sentence family about calls paid before they run (src/settle-first.js),
// the exception to "a failed call is not charged on x402" (CLAUDE.md,
// "x402 settlement ordering"). Every copy surface that says a failed call is
// not charged (scoped to x402 or not) carries one of these after the claim,
// which keeps its own scoped wording: by interpolation in a module, word for
// word in markdown (scripts/test-copy-absolutes.js finds the claims and checks).
//
// A served surface prints the sentence only while runs can settle first:
// GATEWAY_SETTLE_FIRST=off (no run settles first, src/gateway-settle-breaker.js
// settleFirstEnabled) makes both exports empty, read once at import like the
// other switches. No module under src/ types the words itself.

/** The approved words, whatever the switch (the guard and the markdown copies read these). */
export const FAILED_CALL_TEXT = "Some calls are paid before they run. If one fails, send the same payment again to retry it free, or it is refunded.";
export const SETTLE_FIRST_TEXT = "Some calls are paid before they run; a failed one can be retried free with the same payment, or is refunded.";
/** The words every member of the family shares (what the guard reads for). */
export const SETTLE_FIRST_MARK = "paid before they run";

/** GATEWAY_SETTLE_FIRST=off turns settle-first off; anything else leaves it on. */
export function settleFirstCopyOn(env = process.env) { return String(env.GATEWAY_SETTLE_FIRST || "").trim().toLowerCase() !== "off"; }
const ON = settleFirstCopyOn();

/** The full sentence, where a page states the rule itself ("" when settle-first is off). */
export const FAILED_CALL_SENTENCE = ON ? FAILED_CALL_TEXT : "";
/** The short form, beside a claim worded another way ("" when settle-first is off). */
export const SETTLE_FIRST_SENTENCE = ON ? SETTLE_FIRST_TEXT : "";
