// The one word a refund row's status is shown as, wherever an answer names it.
//
// The refund ledger keeps a row held for review as `blocked`; every public
// reader (the refund lookup, a refused resend's `refund.status`, the
// settle-first resend limit) names it `held`. An answer that refuses a
// refunded payment shows `owed`, `sending`, `paid` or `held`, and reads any
// other status as `owed`, so it never says less than the lookup it links to.
// scripts/test-refund-status-word.js fails a reader that maps the words on
// its own.

/** A row status as the refund lookup names it: `blocked` reads `held`. */
export function publicRefundStatus(status) {
  return status === "blocked" ? "held" : status;
}

const ANSWER_WORDS = new Set(["owed", "sending", "paid", "held"]);

/** The `refund.status` a refused payment's answer carries: owed, sending,
 *  paid or held, anything else owed. */
export function refundAnswerStatus(status) {
  const w = publicRefundStatus(status);
  return ANSWER_WORDS.has(w) ? w : "owed";
}
