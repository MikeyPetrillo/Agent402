// What a failed call tells a buyer whose payment was settled before the run.
//
// A handler's refusal says "not charged" because settlement runs after the
// handler and a status of 400 or above cancels it. A run that settled first
// (src/settle-first.js) is the exception, as a Tempo push credential is
// (src/push-refusal-body.js): the payment was taken at the run's settle
// point, and an answer of 400 or above after it is booked as a refund owed
// to the paying wallet (server.js, the refund ledger class
// settle-first-failed). So once such a settlement succeeded the server
// installs this wrapper on the response, and a JSON body of 400 or above goes
// out with that sentence restated and the fields a client reads set:
// `charged: true`, `refundOwed: true`, `retry: "same-payment"` (the same
// request sent again with the same payment runs at no further charge and
// voids the debt: src/idempotency.js), `payment` (the note), the settlement
// `transaction` and, for an EVM transaction, `refundStatusUrl` (the free
// refund lookup).
//
// Only a JSON object body sent before the headers went out is touched; a
// stream, a Buffer or a 2xx goes out byte-identical. It never throws: any
// failure sends the original body.
import { rewriteNotCharged } from "./push-refusal-body.js";
import { OWED_REPAID } from "./tempo-push-debts.js";
import { refundStatusUrlOf, RETRY_SAME_PAYMENT } from "./payment-reject.js";

const NOTE_BODY = "This payment was settled before the call ran, so this failure is recorded as a refund owed to the paying wallet; send the same request with the same payment again to have it run at no further charge, or the amount is refunded after on-chain proof";
/** The sentence a buyer reads in place of "not charged". */
export const SETTLED_FIRST_FAILURE_NOTE = `${NOTE_BODY}.`;
const WORDS = Object.freeze({
  noteBody: NOTE_BODY,
  owed: `the payment settled before the call is ${OWED_REPAID}`,
  // A sentence scoped to a rail this payment is not on still holds; one
  // scoped to x402 or the evm path is about this payment and is restated.
  scopedStays: /\b(?:on|over) (?:card|credits)\b/i,
  keepScopedStandalone: false,
});

/** The text with every "not charged" claim restated for this buyer. */
export function rewriteNotChargedForSettledFirst(text) { return rewriteNotCharged(text, WORDS); }

const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** The body such a buyer is sent for a failure: string fields restated (one
 *  level of nesting), and the payment fields set. Null when the text is not
 *  a JSON object. */
export function settledFirstFailureBody(bodyText, { transaction = null, origin = null } = {}) {
  try {
    if (typeof bodyText !== "string" || !bodyText.trimStart().startsWith("{")) return null;
    const body = JSON.parse(bodyText);
    if (!isPlainObject(body)) return null;
    const rewrite = (o) => { for (const [k, v] of Object.entries(o)) if (typeof v === "string") o[k] = rewriteNotChargedForSettledFirst(v); };
    rewrite(body);
    for (const v of Object.values(body)) if (isPlainObject(v)) rewrite(v);
    const tx = typeof transaction === "string" && transaction ? transaction : null;
    const refundStatusUrl = tx ? refundStatusUrlOf(origin, tx) : null;
    return JSON.stringify({ ...body, charged: true, refundOwed: true, retry: RETRY_SAME_PAYMENT, payment: SETTLED_FIRST_FAILURE_NOTE, ...(tx ? { transaction: tx } : {}), ...(refundStatusUrl ? { refundStatusUrl } : {}) });
  } catch {
    return null;
  }
}

/** Wraps res.send for one request whose payment settled before its run. */
export function installSettledFirstBody(req, res, { transaction = null, origin = null } = {}) {
  const origSend = res.send;
  res.send = function settledFirstSend(chunk) {
    try {
      if (typeof chunk === "string" && res.statusCode >= 400 && !res.headersSent) {
        const rewritten = settledFirstFailureBody(chunk, { transaction, origin });
        if (rewritten !== null) chunk = rewritten;
      }
    } catch {
      // A rewrite must never break a failure answer.
    }
    return origSend.call(this, chunk);
  };
}
