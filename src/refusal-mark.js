// The reason code a payment gate refused a request for, kept on the request
// itself (own, non-enumerable), for the refusal record (src/payment-refusals.js)
// to read when the response ends. Set by a gate whose refusal is not a 402 (the
// settle breaker's 429) or whose reason no classifier names (the settle-first
// resend limit). No imports, so any gate may set it.
const REFUSAL_MARK = Symbol("a402.paymentRefusal");
const CODE = /^[a-z][a-z0-9_.-]{0,63}$/;

/** Mark `req` as refused by a payment gate for `reason` (a machine code). Never throws. */
export function markPaymentRefusal(req, reason) {
  try {
    const r = String(reason ?? "").trim().toLowerCase();
    if (!req || typeof req !== "object" || !CODE.test(r)) return false;
    Object.defineProperty(req, REFUSAL_MARK, { value: r, enumerable: false, configurable: true });
    return true;
  } catch { return false; }
}

/** The reason a gate marked on `req`, or null. */
export function paymentRefusalMarkOf(req) {
  const v = req && typeof req === "object" && Object.hasOwn(req, REFUSAL_MARK) ? req[REFUSAL_MARK] : null;
  return typeof v === "string" ? v : null;
}
