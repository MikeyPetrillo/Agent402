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

/** The lowercased EVM signer field of the verified payment (Permit2's signer
 *  when the payload is a Permit2 one, else the EIP-3009 `authorization.from`),
 *  or null when nothing verified on this request or it names no EVM address. */
export function verifiedEvmPayerOf(req) {
  const inner = verifiedPaymentOf(req)?.paymentPayload?.payload;
  if (!inner || typeof inner !== "object") return null;
  const from = inner.permit2Authorization ? inner.permit2Authorization.from : inner.authorization?.from;
  return typeof from === "string" && /^0x[0-9a-fA-F]{40}$/.test(from) ? from.toLowerCase() : null;
}
