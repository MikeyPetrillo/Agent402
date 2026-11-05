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
