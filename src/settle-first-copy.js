// The one sentence family about calls paid before they run (src/settle-first.js),
// the exception to "a failed call is not charged on x402" (CLAUDE.md,
// "x402 settlement ordering"). Every copy surface that says a failed call is
// not charged (scoped to x402 or not) carries one of these after the claim,
// which keeps its own scoped wording: by interpolation in a module, word for
// word in markdown (scripts/test-copy-absolutes.js finds the claims and checks).

/** The full sentence, where a page states the rule itself. */
export const FAILED_CALL_SENTENCE = "Some calls are paid before they run. If one fails, send the same payment again to retry it free, or it is refunded.";
/** The short form, beside a claim worded another way. */
export const SETTLE_FIRST_SENTENCE = "Some calls are paid before they run; a failed one can be retried free with the same payment, or is refunded.";
/** The words every member of the family shares (what the guard reads for). */
export const SETTLE_FIRST_MARK = "paid before they run";
