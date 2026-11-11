// A facilitator's settle refusal that is a verdict about the buyer's payment
// itself: a bad signature, too little balance, an authorization or nonce
// already used, an expired or not-yet-valid window, or a payload, scheme or
// network the facilitator does not take.
//
// Two shapes are read. The x402 reason codes (invalid_*, insufficient_funds,
// ...), and the same verdicts in words, for a facilitator that puts prose in
// its errorReason ("Signature does not authorize this transfer ..."). A
// reverted transfer (invalid_exact_evm_transaction_failed) is not a verdict:
// the revert-retry rule in src/payments.js owns it. Only the reason is read,
// never errorMessage: a node's "insufficient funds for gas" there is the
// settler's own gas wallet, not the buyer. Prose that names the settler's
// side (gas, a fee, a fee payer, a relayer or signer) is not a verdict either,
// and neither is a bare "insufficient funds": a balance verdict names the
// balance ("transfer amount exceeds balance", "insufficient balance").
//
// Who reads which: isPaymentVerdictReason (codes and words) decides whether a
// Robinhood refusal may go to the next listed facilitator (a verdict never
// does). isPaymentVerdictCode (codes only) is the outage read's test
// (src/robinhood-outage.js), with a used authorization (isUsedAuthorizationReason)
// never a verdict there: the read finds the transfer that used it.

const CODE = /^[a-z0-9_.:-]+$/i;
const NOT_THE_BUYER = /\bgas\b|\bfees?\b|fee ?payer|\brelayer\b|\bsigners?\b/i;
const USED_PROSE = [
  /\b(?:nonce|authorization)\b.*\b(?:used|consumed|canceled|cancelled)\b/i,
  /\balready (?:been )?used\b/i,
];
const PROSE_VERDICTS = [
  /\bsignature\b/i,
  /\binsufficient\b.*\bbalance\b/i,
  /\bexceeds\b.*\bbalance\b/i,
  /\bbalance\b.*\b(?:too low|insufficient)\b/i,
  ...USED_PROSE,
  /\bexpired\b|\bnot yet valid\b|\bvalid ?(?:before|after)\b/i,
];

/** True when `reason` is a verdict CODE about the buyer's payment (words are not read). */
export function isPaymentVerdictCode(reason) {
  const r = String(reason || "").trim();
  if (!r) return false;
  if (r === "invalid_exact_evm_transaction_failed") return false;
  return /^invalid_/.test(r) || /insufficient_funds|unsupported_scheme|unsupported_network|invalid_payload/.test(r);
}

/** True when `reason` says the authorization or its nonce was already used
 *  (or canceled), as a code or in words. */
export function isUsedAuthorizationReason(reason) {
  const r = String(reason || "").trim();
  if (!r) return false;
  if (CODE.test(r)) return /(?:^|_)(?:nonce|authorization)_(?:already_)?used\b|already_used/i.test(r);
  return USED_PROSE.some((re) => re.test(r));
}

/** True when `reason` (a settle refusal's errorReason) is a verdict about the buyer's payment. */
export function isPaymentVerdictReason(reason) {
  const r = String(reason || "").trim();
  if (!r) return false;
  if (r === "invalid_exact_evm_transaction_failed") return false;
  if (isPaymentVerdictCode(r)) return true;
  if (CODE.test(r)) return false;
  if (NOT_THE_BUYER.test(r)) return false;
  return PROSE_VERDICTS.some((re) => re.test(r));
}

// ---- who a failed settle proves at fault (the settle breaker's count) ------
// A settle that failed after the handler served is counted against the
// paying wallet (src/gateway-settle-breaker.js) only when the answer is a
// definite verdict on the buyer's own payment: too little balance, a bad
// signature, an authorization or nonce already used, a window that closed,
// a payload the facilitator refused, or the same authorization already
// settling for another request (our claim store, src/settlement-claims.js).
// Everything else is not a verdict code (src/settle-fault.js reads what
// else it proves): a timeout or connection error on our side, a hook of ours
// that could not run (wallet_check_failed, settle_mark_failed,
// before_settle_hook_error), a facilitator's HTTP error or billing refusal
// on our account, a reverted transfer (the settler's own gas can cause it),
// a settle still pending, a check that could not complete (*_unverifiable),
// and requirements that are ours (invalid_network, invalid_payment_requirements).
// The receipt a buyer gets carries a code-shaped reason
// (src/facilitator-diagnostics.js), so only codes are read here.
const SETTLE_NOT_BUYER = /(?:transaction|simulation|verification)_failed$|_unverifiable$|_check_failed$|_hook_error$|^invalid_(?:network|scheme|payment_requirements|x402_version|transaction_state)$|_requirements$|_not_configured$|_auth_store$|_unauthenticated$|_broadcast$|_verifier_error$|^unsupported_|credits/i;
const SETTLE_BUYER_EXTRA = /^(?:insufficient_(?:funds|balance)|duplicate_authorization|transaction_served_elsewhere)$|_insufficient_(?:funds|balance)$|(?:^|_)expired$/i;

/** True when a failed settle's `errorReason` is a definite verdict on the
 *  buyer's payment (see above): the one class the settle breaker counts. */
export function isBuyerSettleVerdict(reason) {
  const r = String(reason || "").trim();
  if (!r || !CODE.test(r)) return false;
  if (isUsedAuthorizationReason(r)) return true;
  if (SETTLE_NOT_BUYER.test(r)) return false;
  return SETTLE_BUYER_EXTRA.test(r) || isPaymentVerdictCode(r);
}
