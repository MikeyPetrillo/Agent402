// The payment this server verified on a request, kept on the request itself
// (own, non-enumerable) by the x402 resource server's after-verify hook
// (src/payments.js registerVerifiedPaymentStash). Present only once the
// facilitator answered `isValid: true` for this request's payment: a request
// on a route with no price, or one whose payment did not verify, carries none.
// Readers: the settle-first point (src/payments.js) and the payer screen's
// records rule (src/x402-payer-screen.js). No imports, so any module may read it.
const VERIFIED_PAYMENT = Symbol("a402.verifiedPayment");

/** Keep `value` ({ paymentPayload, requirements, ... }) on `req`. Never throws. */
export function stashVerifiedPayment(req, value) {
  try {
    if (!req || typeof req !== "object" || !value || typeof value !== "object") return false;
    Object.defineProperty(req, VERIFIED_PAYMENT, { value, enumerable: false, configurable: true });
    return true;
  } catch { return false; }
}

/** The verified payment kept on `req`, or null. */
export function verifiedPaymentOf(req) {
  const v = req && typeof req === "object" && Object.hasOwn(req, VERIFIED_PAYMENT) ? req[VERIFIED_PAYMENT] : null;
  return v && typeof v === "object" ? v : null;
}

/** The payer the verification on this request vouches for, or null when no
 *  payment verified here: the facilitator's own `payer` from its verify
 *  answer (an EVM address lowercased; any other kept exactly), else, for an
 *  EVM payload, the verified signer field (Permit2's signer for a Permit2
 *  payload, else the EIP-3009 `authorization.from`). */
export function verifiedPayerOf(req) {
  const v = verifiedPaymentOf(req);
  if (!v) return null;
  const EVM = /^0x[0-9a-fA-F]{40}$/;
  if (typeof v.payer === "string" && v.payer) return EVM.test(v.payer) ? v.payer.toLowerCase() : v.payer.slice(0, 128);
  const inner = v.paymentPayload?.payload;
  if (!inner || typeof inner !== "object") return null;
  const from = inner.permit2Authorization ? inner.permit2Authorization.from : inner.authorization?.from;
  return typeof from === "string" && EVM.test(from) ? from.toLowerCase() : null;
}
