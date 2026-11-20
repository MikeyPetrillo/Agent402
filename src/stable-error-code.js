// One stable, machine-readable code per tool error answer, so a caller (a
// reseller's integration above all) can branch on a word that never changes
// instead of on message text, which may. The code is read from the answer's
// final HTTP status; the table is part of the wholesale contract
// (src/wholesale.js publishes it, scripts/test-wholesale.js pins it): a code
// is only ever added, never renamed or removed. A meaning says what the
// status means, never whether the call was charged: that depends on the rail
// (a Tempo push transfer is final before the call runs), so the contract says
// it once, rail by rail, beside a link to the refund terms (src/wholesale.js).
//
// A 402 carries no code and the table lists none: the payment-required answer
// follows the x402 and MPP wire formats, which this server does not add to.
// Where errorCode rides is said once, in ERROR_CODE_SCOPE and
// ERROR_CODE_NOT_CARRIED (the wholesale JSON, /wholesale and the changelog
// read the same words), and scripts/test-wholesale.js probes every kind of
// answer each sentence names on a booted server.

/** The answers that carry errorCode. */
export const ERROR_CODE_SCOPE = "Every error answer a tool's route writes, other than a 402, carries errorCode beside the message: an input refused before payment, a run that ended in an error, a retired route (410) and a tool that is paused or switched off (503).";
/** The answers that carry none. */
export const ERROR_CODE_NOT_CARRIED = "A 402 is the payment-required answer: it follows the x402 and MPP wire formats and carries no errorCode. Some refusals from the payment and request checks in front of a tool's route carry none either: a payment already used, a rate limit on unpaid or free calls, a body the server cannot read.";

export const ERROR_CODES = Object.freeze([
  { status: 400, code: "invalid_input", meaning: "The input is missing a field, has a wrong type or is out of range; the message names the field. Fix the input.", retry: "fix-input" },
  { status: 404, code: "not_found", meaning: "The thing the input names does not exist at the source.", retry: "fix-input" },
  { status: 409, code: "conflict", meaning: "The request conflicts with the state of what it acts on; the message says what.", retry: "fix-input" },
  { status: 410, code: "retired", meaning: "The route is retired; the body names its replacement.", retry: "use-replacement" },
  { status: 413, code: "input_too_large", meaning: "The input is over a size limit the body names.", retry: "fix-input" },
  { status: 415, code: "unsupported_media_type", meaning: "The body's content type is not one the route reads.", retry: "fix-input" },
  { status: 422, code: "input_not_resolvable", meaning: "The input is well formed but the source cannot resolve it (an unknown ticker, coin or place).", retry: "fix-input" },
  { status: 429, code: "rate_limited", meaning: "Too many requests; wait the Retry-After seconds.", retry: "after-retry-after" },
  { status: 499, code: "client_closed", meaning: "The caller closed the connection before the answer.", retry: "same-request" },
  { status: 500, code: "internal_error", meaning: "A fault in our code.", retry: "later" },
  { status: 502, code: "upstream_error", meaning: "The data source answered with an error or an unreadable answer.", retry: "later" },
  { status: 503, code: "unavailable", meaning: "The tool or its source is unavailable for now.", retry: "after-retry-after" },
  { status: 504, code: "timeout", meaning: "The source did not answer in time.", retry: "later" },
]);

const BY_STATUS = new Map(ERROR_CODES.map((e) => [e.status, e.code]));

/** The stable code for an error answer's final status: the exact status's
 *  code, else the class fallback (other 4xx invalid_input, other 5xx
 *  internal_error). Null under 400, and null for a 402 (the payment-required
 *  answer carries no code). */
export function stableErrorCode(status) {
  const s = Number(status);
  if (!Number.isInteger(s) || s < 400 || s === 402) return null;
  if (BY_STATUS.has(s)) return BY_STATUS.get(s);
  return s >= 500 ? "internal_error" : "invalid_input";
}

/** `{ errorCode }` for spreading into an error answer (empty under 400 and for a 402). */
export function errorCodeField(status) {
  const code = stableErrorCode(status);
  return code ? { errorCode: code } : {};
}
