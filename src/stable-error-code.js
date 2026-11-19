// One stable, machine-readable code per tool error answer, so a caller (a
// reseller's integration above all) can branch on a word that never changes
// instead of on message text, which may. The code is read from the answer's
// final HTTP status; the table is part of the wholesale contract
// (src/wholesale.js publishes it, scripts/test-wholesale.js pins it): a code
// is only ever added, never renamed or removed.

export const ERROR_CODES = Object.freeze([
  { status: 400, code: "invalid_input", meaning: "The input is missing a field, has a wrong type or is out of range; the message names the field. Fix the input; nothing was charged.", retry: "fix-input" },
  { status: 402, code: "payment_required", meaning: "No payment, or a payment that was refused; the body is the payment challenge.", retry: "pay" },
  { status: 404, code: "not_found", meaning: "The thing the input names does not exist at the source.", retry: "fix-input" },
  { status: 409, code: "conflict", meaning: "The request conflicts with one already in progress (for example the same idempotency key with a different body).", retry: "fix-input" },
  { status: 410, code: "retired", meaning: "The route is retired; the body names its replacement.", retry: "use-replacement" },
  { status: 413, code: "input_too_large", meaning: "The input is over a size limit the body names.", retry: "fix-input" },
  { status: 415, code: "unsupported_media_type", meaning: "The body's content type is not one the route reads.", retry: "fix-input" },
  { status: 422, code: "input_not_resolvable", meaning: "The input is well formed but the source cannot resolve it (an unknown ticker, coin or place).", retry: "fix-input" },
  { status: 429, code: "rate_limited", meaning: "Too many requests; wait the Retry-After seconds.", retry: "after-retry-after" },
  { status: 499, code: "client_closed", meaning: "The caller closed the connection before the answer; not charged.", retry: "same-request" },
  { status: 500, code: "internal_error", meaning: "A fault in our code; not charged.", retry: "later" },
  { status: 502, code: "upstream_error", meaning: "The data source answered with an error or an unreadable answer; not charged.", retry: "later" },
  { status: 503, code: "unavailable", meaning: "The tool or its source is unavailable for now; not charged.", retry: "after-retry-after" },
  { status: 504, code: "timeout", meaning: "The source did not answer in time; not charged.", retry: "later" },
]);

const BY_STATUS = new Map(ERROR_CODES.map((e) => [e.status, e.code]));

/** The stable code for an error answer's final status: the exact status's
 *  code, else the class fallback (other 4xx invalid_input, other 5xx
 *  internal_error). Null under 400. */
export function stableErrorCode(status) {
  const s = Number(status);
  if (!Number.isInteger(s) || s < 400) return null;
  if (BY_STATUS.has(s)) return BY_STATUS.get(s);
  return s >= 500 ? "internal_error" : "invalid_input";
}

/** `{ errorCode }` for spreading into an error answer (empty under 400). */
export function errorCodeField(status) {
  const code = stableErrorCode(status);
  return code ? { errorCode: code } : {};
}
