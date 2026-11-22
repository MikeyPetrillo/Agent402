// The one sentence family about the exception to "a failed call is not
// charged" (CLAUDE.md, "x402 settlement ordering"; src/settle-first.js). Every
// copy surface that says a failed paid call is not charged carries one of
// these beside the claim: by interpolation in a module, word for word in
// markdown (scripts/test-copy-absolutes.js finds the claims and checks).

/** The clause after "is not charged,". */
export const SETTLE_FIRST_EXCEPTION = "except when this server is protecting itself from unpaid runs: then a model or image call from a new wallet, or from a wallet whose recent payments did not settle, may be settled before it runs, and if it fails, sending the same payment again runs it at no further charge or the amount is refunded";
/** The whole sentence, where a page states the rule itself. */
export const FAILED_CALL_SENTENCE = `A paid call that fails is not charged, ${SETTLE_FIRST_EXCEPTION}.`;
/** The exception alone, as a sentence beside a claim worded another way. */
export const SETTLE_FIRST_SENTENCE = "When this server is protecting itself from unpaid runs, a model or image call from a new wallet, or from a wallet whose recent payments did not settle, may be settled before it runs; if it fails, sending the same payment again runs it at no further charge, or the amount is refunded.";
/** The words every member of the family shares (what the guard reads for). */
export const SETTLE_FIRST_MARK = "protecting itself from unpaid runs";
/** The same sentence as a clause inside another sentence (lower case, no stop). */
export const SETTLE_FIRST_SENTENCE_LOWER = SETTLE_FIRST_SENTENCE[0].toLowerCase() + SETTLE_FIRST_SENTENCE.slice(1, -1);
