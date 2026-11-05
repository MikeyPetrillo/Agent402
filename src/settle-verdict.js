// A facilitator's settle refusal that is a verdict about the buyer's payment
// itself: a bad signature, too little balance, an authorization or nonce
// already used, an expired or not-yet-valid window, or a payload, scheme or
// network the facilitator does not take. A verdict is definite: no other
// settler is asked and nothing is waited on.
//
// Two shapes are read. The x402 reason codes (invalid_*, insufficient_funds,
// ...), and the same verdicts in words, for a facilitator that puts prose in
// its errorReason ("Signature does not authorize this transfer ..."). A
// reverted transfer (invalid_exact_evm_transaction_failed) is not a verdict:
// the revert-retry rule in src/payments.js owns it. Only the reason is read,
// never errorMessage: a node's "insufficient funds for gas" there is the
// settler's own gas wallet, not the buyer. Prose that names the settler's
// side (gas, a fee payer, a relayer or signer) is not a verdict either.

const CODE = /^[a-z0-9_.:-]+$/i;
const NOT_THE_BUYER = /\bgas\b|fee ?payer|\brelayer\b|\bsigners?\b/i;
const PROSE_VERDICTS = [
  /\bsignature\b/i,
  /\binsufficient\b.*\b(?:balance|funds)\b/i,
  /\bexceeds\b.*\bbalance\b/i,
  /\bbalance\b.*\b(?:too low|insufficient)\b/i,
  /\b(?:nonce|authorization)\b.*\b(?:used|consumed|canceled|cancelled)\b/i,
  /\balready (?:been )?used\b/i,
  /\bexpired\b|\bnot yet valid\b|\bvalid ?(?:before|after)\b/i,
];

/** True when `reason` (a settle refusal's errorReason) is a verdict about the buyer's payment. */
export function isPaymentVerdictReason(reason) {
  const r = String(reason || "").trim();
  if (!r) return false;
  if (r === "invalid_exact_evm_transaction_failed") return false;
  if (/^invalid_/.test(r) || /insufficient_funds|unsupported_scheme|unsupported_network|invalid_payload/.test(r)) return true;
  if (CODE.test(r)) return false;
  if (NOT_THE_BUYER.test(r)) return false;
  return PROSE_VERDICTS.some((re) => re.test(r));
}
