// x402 over MCP (transports-v2/mcp.md): the codec between an MCP tool call
// and the paid HTTP route that decides it. Pure: no I/O, no settlement.
//
// Wire:
//   - payment required: a tool RESULT with isError: true whose
//     content[0].text is JSON.stringify of the PaymentRequired object (the
//     form the transport requires, and the one its client falls back to). It
//     carries NO structuredContent: the transport's copy there is optional,
//     and a tool that lists an outputSchema has every structuredContent it
//     returns validated against that schema by the MCP SDK client, error
//     results included, so a PaymentRequired there fails the whole call
//     (-32602) for a client that only wanted to read the ask;
//   - the client retries with the PaymentPayload object in
//     tools/call params._meta["x402/payment"];
//   - a settled result carries the SettleResponse in
//     result._meta["x402/payment-response"];
//   - a settle that fails after the handler ran returns the payment-required
//     shape again and none of the tool's output (the transport's shape,
//     buildSettlementFailedResult; the hosted connector answers a failed
//     settle with buildSettlementUnprovenResult instead: no offer).
//
// Settlement authority stays with the paid route: the connector re-encodes the
// payload as the PAYMENT-SIGNATURE header @x402/express reads, replays the call
// over the loopback (src/mcp-mpp.js) and reads the route's own PAYMENT-REQUIRED
// or PAYMENT-RESPONSE header back. The header codecs are @x402/core's own.
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { parsePaymentPayload, parsePaymentRequired } from "@x402/core/schemas";
import { RETRY_SAME_PAYMENT, RETRY_WATCH_TRANSACTION, UNDECIDED_RETRY_VERBS } from "./payment-reject.js";

export const X402_PAYMENT_META = "x402/payment";
export const X402_PAYMENT_RESPONSE_META = "x402/payment-response";
export const X402_PAYMENT_HEADER = "PAYMENT-SIGNATURE";
/** Where a settlement-pending result carries its fields ({reason, retry,
 *  retryAfterSeconds, network, transactions, hint}). */
export const SETTLEMENT_PENDING_META = "org.agent402/settlement-pending";
/** The PaymentRequired a payment-required, invalid-payment or
 *  settlement-failed result carries (its first text block), or null. */
export function paymentRequiredOfResult(result) {
  if (!isPlainObject(result) || result.isError !== true) return null;
  const first = Array.isArray(result.content) ? result.content[0] : null;
  if (!first || first.type !== "text" || typeof first.text !== "string") return null;
  let parsed;
  try { parsed = JSON.parse(first.text); } catch { return null; }
  return isPaymentRequiredV2(parsed) ? parsed : null;
}
/** Compact JSON bytes of one payment payload. Its base64 header (4/3 of this)
 *  stays well inside the HTTP parser's 16 KiB header block; a signed EVM
 *  authorization is under 1 KiB and a signed Solana, Stellar or Algorand
 *  transaction a few KiB. */
export const X402_PAYMENT_MAX_BYTES = 8192;
/** Object nesting a payment may have. A payment echoes the offer's
 *  extensions, and a Bazaar extension carries the tool's input schema and
 *  output example inside its own JSON Schema: the deepest offer the catalog
 *  makes nests 18 levels (measured over every route's 402), so 32 leaves room
 *  and still bounds the walk's recursion. */
const MAX_DEPTH = 32;
const MAX_HEADER_CHARS = 16384;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const isPlainObject = (v) => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** A lower bound on the UTF-8 bytes JSON.stringify(value) would write, found
 *  by a walk that stops as soon as the bound passes `maxBytes`, the nesting
 *  passes MAX_DEPTH or a value is its own ancestor. Each node costs at least
 *  one byte, so the walk visits at most `maxBytes` nodes, and its recursion is
 *  at most MAX_DEPTH + 1 frames deep whatever the input's nesting. Reads
 *  values the way JSON.stringify does (own enumerable string keys), so a
 *  getter that throws is caught here, before any serialization. */
function boundedSize(value, maxBytes) {
  let bytes = 0;
  const stack = new Set();
  // Bytes a value writes at least: a string its quotes and one per UTF-16
  // unit (a unit is one to three UTF-8 bytes, a surrogate pair four), null
  // four, any other primitive one; undefined, a function or a symbol writes
  // nothing as an object member.
  const skipped = (v) => v === undefined || typeof v === "function" || typeof v === "symbol";
  const walk = (v, depth) => {
    if (v === null || typeof v !== "object") {
      bytes += typeof v === "string" ? v.length + 2 : v === null ? 4 : skipped(v) ? 0 : 1;
      return bytes > maxBytes ? "too_large" : null;
    }
    if (stack.has(v)) return "not_json";
    if (depth > MAX_DEPTH) return "too_deep";
    stack.add(v);
    bytes += 2;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (i > 0) bytes += 1;
        if (bytes > maxBytes) return "too_large";
        const r = walk(v[i], depth + 1);
        if (r) return r;
      }
    } else {
      let members = 0;
      for (const key of Object.keys(v)) {
        const member = v[key];
        if (skipped(member)) continue;
        bytes += key.length + 3 + (members++ > 0 ? 1 : 0);
        if (bytes > maxBytes) return "too_large";
        const r = walk(member, depth + 1);
        if (r) return r;
      }
    }
    stack.delete(v);
    return null;
  };
  try { return walk(value, 1); } catch { return "not_json"; }
}

/** True when JSON.stringify(value) would write `maxBytes` bytes or fewer
 *  and nest no deeper than MAX_DEPTH, decided by the bounded walk before any
 *  serialization. Never throws. */
export function jsonWithin(value, maxBytes) {
  return boundedSize(value, maxBytes) === null;
}

/** A detached JSON copy of `value` (no getters, no prototype chain, no
 *  accessor surprises), or a reason it cannot be one: bytes over `maxBytes`,
 *  depth over MAX_DEPTH, or a key that names a prototype slot. The bounded
 *  walk runs first, so serialization never starts on an input past either
 *  bound. Never throws. */
function jsonCopy(value, maxBytes) {
  const early = boundedSize(value, maxBytes);
  if (early) return { reason: early };
  let json;
  try { json = JSON.stringify(value); } catch { return { reason: "not_json" }; }
  if (typeof json !== "string") return { reason: "not_json" };
  if (Buffer.byteLength(json, "utf8") > maxBytes) return { reason: "too_large" };
  let bad = null;
  let copy;
  try {
    copy = JSON.parse(json, function reviver(key, v) {
      if (FORBIDDEN_KEYS.has(key)) bad = "forbidden_key";
      return v;
    });
  } catch { return { reason: "not_json" }; }
  if (bad) return { reason: bad };
  const depthOk = (v, d) => {
    if (v === null || typeof v !== "object") return true;
    if (d > MAX_DEPTH) return false;
    for (const k of Object.keys(v)) if (!depthOk(v[k], d + 1)) return false;
    return true;
  };
  if (!depthOk(copy, 1)) return { reason: "too_deep" };
  return { copy };
}

const refusal = (reason, message) => ({ ok: false, status: 400, error: "invalid_payment", reason, message });

/**
 * Read the payment from a tools/call `params._meta`.
 *   { ok: true, payment: null }            no x402 payment (the call is unpaid)
 *   { ok: true, payment }                  a detached, shape-checked v2 PaymentPayload
 *   { ok: false, status: 400, error, reason, message }  a payment that cannot be used
 * Never throws.
 */
export function readPaymentFromMeta(meta, { maxBytes = X402_PAYMENT_MAX_BYTES } = {}) {
  if (meta === undefined || meta === null) return { ok: true, payment: null };
  if (!isPlainObject(meta)) return refusal("meta_not_object", "_meta must be an object");
  if (!Object.hasOwn(meta, X402_PAYMENT_META)) return { ok: true, payment: null };
  let raw;
  try { raw = meta[X402_PAYMENT_META]; } catch { return refusal("not_json", `${X402_PAYMENT_META} could not be read`); }
  if (raw === undefined || raw === null) return { ok: true, payment: null };
  if (!isPlainObject(raw)) return refusal("not_object", `${X402_PAYMENT_META} must be a PaymentPayload object`);
  const { copy, reason } = jsonCopy(raw, maxBytes);
  if (reason === "too_large") return refusal(reason, `${X402_PAYMENT_META} is larger than ${maxBytes} bytes`);
  if (reason === "too_deep") return refusal(reason, `${X402_PAYMENT_META} is nested deeper than ${MAX_DEPTH} levels`);
  if (reason === "forbidden_key") return refusal(reason, `${X402_PAYMENT_META} names a reserved key`);
  if (reason) return refusal(reason, `${X402_PAYMENT_META} is not JSON`);
  if (copy.x402Version !== 2) return refusal("unsupported_version", `${X402_PAYMENT_META} must be x402Version 2`);
  // The v2 schema: accepted is a full PaymentRequirements (CAIP-2 network,
  // non-empty amount, asset, payTo, positive timeout) and payload an object.
  let parsed;
  try { parsed = parsePaymentPayload(copy); } catch { parsed = { success: false }; }
  if (!parsed.success) {
    const first = parsed.error?.issues?.[0];
    const at = Array.isArray(first?.path) && first.path.length ? `.${first.path.map(String).join(".")}` : "";
    return refusal("invalid_shape", `${X402_PAYMENT_META}${at.slice(0, 80)} does not match the PaymentPayload schema`);
  }
  return { ok: true, payment: copy };
}

/** The PAYMENT-SIGNATURE header value for a payment read by readPaymentFromMeta
 *  (@x402/core's encoder, the one @x402/express decodes). null for anything
 *  that is not a plain object. Never throws. */
export function paymentSignatureHeader(payment) {
  if (!isPlainObject(payment)) return null;
  try { return encodePaymentSignatureHeader(payment); } catch { return null; }
}

/** A v2 PaymentRequired object from the route's PAYMENT-REQUIRED header, or
 *  null when absent or not a valid v2 PaymentRequired. Never throws. */
export function paymentRequiredFromHeader(value) {
  if (typeof value !== "string" || !value || value.length > MAX_HEADER_CHARS * 4) return null;
  let decoded;
  try { decoded = decodePaymentRequiredHeader(value.trim()); } catch { return null; }
  return isPaymentRequiredV2(decoded) ? decoded : null;
}

function isPaymentRequiredV2(value) {
  if (!isPlainObject(value) || value.x402Version !== 2) return false;
  try { return parsePaymentRequired(value).success === true; } catch { return false; }
}

/** Copy the `_meta` entries of an MPP challenge (src/mcp-mpp.js) onto `into`
 *  by reference, so each value serializes exactly as it was given. Only own
 *  string keys; prototype slots are skipped, and so is every "x402/" key: the
 *  x402 entries of a result are written by this module alone, so a caller's
 *  meta can never put a settle receipt on a failure. */
function mergeMeta(into, extra) {
  if (!isPlainObject(extra)) return into;
  for (const key of Object.keys(extra)) {
    if (FORBIDDEN_KEYS.has(key) || key.startsWith("x402/")) continue;
    Object.defineProperty(into, key, { value: extra[key], enumerable: true, writable: true, configurable: true });
  }
  return into;
}

function requiredShape(paymentRequired, { message, meta, settleReceipt } = {}) {
  const content = [{ type: "text", text: JSON.stringify(paymentRequired) }];
  if (typeof message === "string" && message.trim()) content.push({ type: "text", text: message.trim() });
  const result = { isError: true, content };
  const merged = mergeMeta({}, meta);
  if (settleReceipt) merged[X402_PAYMENT_RESPONSE_META] = settleReceipt;
  if (Object.keys(merged).length) result._meta = merged;
  return result;
}

/**
 * The payment-required tool result. `paymentRequired` is a v2 PaymentRequired
 * (usually paymentRequiredFromHeader of the route's 402). `message` adds a
 * readable sentence after the JSON block. `mppMeta` is the `_meta` object an
 * MPP challenge result carries (for example {"org.paymentauth/payment-required": ...});
 * its entries ride along unchanged, so one result offers both wires.
 * null when `paymentRequired` is not a valid v2 PaymentRequired. Never throws.
 */
export function buildPaymentRequiredResult(paymentRequired, { message, mppMeta } = {}) {
  if (!isPaymentRequiredV2(paymentRequired)) return null;
  return requiredShape(paymentRequired, { message, meta: mppMeta });
}

/**
 * The result for a settle that failed after the tool ran: the payment-required
 * shape again (its `error` names the failure) and none of the tool's output.
 * `settleResponse`, when given and marked success: false, rides in
 * _meta["x402/payment-response"] so the client can read the failure reason.
 * null when `paymentRequired` is not a valid v2 PaymentRequired. Never throws.
 */
export function buildSettlementFailedResult(paymentRequired, { reason, message, settleResponse, mppMeta } = {}) {
  if (!isPaymentRequiredV2(paymentRequired)) return null;
  const why = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 200) : "";
  const body = { ...paymentRequired, error: why ? `Payment settlement failed: ${why}` : "Payment settlement failed" };
  let settleReceipt = null;
  if (isPlainObject(settleResponse) && settleResponse.success === false) {
    const { copy } = jsonCopy(settleResponse, X402_PAYMENT_MAX_BYTES);
    if (copy && copy.success === false) settleReceipt = copy;
  }
  return requiredShape(body, { message, meta: mppMeta, settleReceipt });
}

/**
 * The result for a payment that cannot be used (the reader refused it, or the
 * route's verify did): the payment-required shape again, its `error` naming
 * the reason, so a client can sign a fresh payment and retry, as the
 * transport spec and the official server do. No settle receipt rides on it.
 * null when `paymentRequired` is not a valid v2 PaymentRequired. Never throws.
 */
export function buildInvalidPaymentResult(paymentRequired, { reason, message, mppMeta } = {}) {
  if (!isPaymentRequiredV2(paymentRequired)) return null;
  const why = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 200) : "Payment verification failed";
  return requiredShape({ ...paymentRequired, error: why }, { message, meta: mppMeta });
}

// A transaction id as each rail writes it (src/payment-reject.js railTxOf): an
// EVM hash, a Stellar hash, a Solana signature, an Algorand id. Kept exactly
// as written.
const TX_ID = /^(?:0x[0-9a-fA-F]{64}|[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,88}|[A-Z2-7]{52})$/;

/**
 * The result for a payment whose settlement is not decided yet: Circle
 * Gateway still settling a batched payment (retry same-payment: the SAME
 * payment resent later is served with no new charge), or a broadcast transfer
 * not yet confirmed on chain (retry watch-transaction). It carries the
 * route's own explanation and NO PaymentRequired: a client that signed a
 * fresh offer here could pay twice. `refusal` is the route's 402 body
 * ({reason, retry, hint, network, transactions}); `settleResponse`, when
 * marked success: false, rides in _meta["x402/payment-response"].
 * Never throws.
 */
export function buildSettlementPendingResult({ label = "Agent402", refusal = {}, retryAfterSeconds = null, settleResponse = null } = {}) {
  const r = isPlainObject(refusal) ? refusal : {};
  const text = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
  const retry = text(r.retry, 40);
  const hint = text(r.hint, 1000) || "This payment's settlement is not confirmed yet, so the answer was withheld. Do not sign a new authorization for this call: a second one is a second payment.";
  const wait = Number.isFinite(Number(retryAfterSeconds)) && Number(retryAfterSeconds) > 0 ? Math.min(Math.ceil(Number(retryAfterSeconds)), 3600) : null;
  const transactions = Array.isArray(r.transactions) ? r.transactions.filter((t) => typeof t === "string" && TX_ID.test(t)).slice(0, 8) : [];
  // The payment's own expiry and the refund lookup, as the route's body names
  // them (src/payment-reject.js unconfirmedSettleRefusal): the point a new
  // payment is safe, and where a repayment shows.
  const validBefore = typeof r.authorizationValidBefore === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(r.authorizationValidBefore) ? r.authorizationValidBefore : null;
  const roundOf = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
  const refundStatusUrl = typeof r.refundStatusUrl === "string" && r.refundStatusUrl.length <= 300 && /^https?:\/\/[^\s"<>]+$/.test(r.refundStatusUrl) ? r.refundStatusUrl : null;
  // The route's hint points at its own body ("listed in transactions"); here
  // the hashes ride in _meta, so the text names them and says where they are.
  const where = transactions.length ? ` Transaction${transactions.length > 1 ? "s" : ""} to watch: ${transactions.join(", ")} (also in this result's _meta["${SETTLEMENT_PENDING_META}"].transactions).` : "";
  const structured = {
    reason: text(r.reason, 60) || "settlement-pending",
    ...(retry ? { retry } : {}),
    ...(wait ? { retryAfterSeconds: wait } : {}),
    ...(text(r.network, 80) ? { network: text(r.network, 80) } : {}),
    ...(transactions.length ? { transactions } : {}),
    ...(validBefore ? { authorizationValidBefore: validBefore } : {}),
    ...(roundOf(r.lastValidRound) ? { lastValidRound: roundOf(r.lastValidRound) } : {}),
    ...(roundOf(r.expirationLedger) ? { expirationLedger: roundOf(r.expirationLedger) } : {}),
    ...(refundStatusUrl ? { refundStatusUrl } : {}),
    hint,
  };
  const resend = retry === RETRY_SAME_PAYMENT ? ` Resend this call with the same _meta["${X402_PAYMENT_META}"]${wait ? ` after about ${wait} s` : ""}.` : "";
  // The fields ride in _meta, never structuredContent (see the wire note above).
  const result = { isError: true, content: [{ type: "text", text: `${label}: ${hint}${where}${resend}` }], _meta: { [SETTLEMENT_PENDING_META]: structured } };
  if (isPlainObject(settleResponse) && settleResponse.success === false) {
    const { copy } = jsonCopy(settleResponse, X402_PAYMENT_MAX_BYTES);
    if (copy && copy.success === false) result._meta[X402_PAYMENT_RESPONSE_META] = copy;
  }
  return result;
}

/**
 * The result for a settle that failed, whatever its answer reads as: a
 * settle answer naming a transaction, a timeout, a revert, a refusal naming
 * no transaction, a bare settlement_failed. The answer is one facilitator's
 * and says nothing of a fallback asked after it, so it carries NO
 * PaymentRequired (a client that signed a fresh one could pay twice): the
 * text says not to sign again, names the transaction to watch when the settle
 * answer or the route's body names one, and adds the route's own hint.
 * `refusal` is the route's 402 body; `settleResponse` its decoded
 * PAYMENT-RESPONSE (or null when the 402 carried none). The fields ride in
 * _meta["org.agent402/settlement-pending"] with reason settlement-failed.
 * Never throws.
 */
export function buildSettlementUnprovenResult({ label = "Agent402", refusal = {}, settleResponse = null } = {}) {
  const r = isPlainObject(refusal) ? refusal : {};
  const s = isPlainObject(settleResponse) && settleResponse.success === false ? settleResponse : null;
  const text = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
  const transactions = [];
  for (const t of [s?.transaction, ...(Array.isArray(r.transactions) ? r.transactions : [])]) {
    if (typeof t === "string" && TX_ID.test(t.trim()) && !transactions.includes(t.trim()) && transactions.length < 8) transactions.push(t.trim());
  }
  const code = text(s?.errorReason, 80);
  const network = text(r.network, 80) || text(s?.network, 80);
  const hint = `This payment did not settle${code && /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(code) ? ` (${code})` : ""}, so the answer was withheld. `
    + (transactions.length
      ? `The settle answer names ${transactions.length > 1 ? "transactions" : "a transaction"}, so the transfer may still land; if it does, the amount is booked as owed to the paying wallet and repaid after on-chain proof. `
      : "Nothing here proves that no transfer was sent. ")
    + "Do not sign a new authorization for this call: a second one is a second payment. Check the paying wallet before paying for this call again.";
  const where = transactions.length ? ` Transaction${transactions.length > 1 ? "s" : ""} to watch${network ? ` on ${network}` : ""}: ${transactions.join(", ")} (also in this result's _meta["${SETTLEMENT_PENDING_META}"].transactions).` : "";
  const routeHint = text(r.hint, 1000);
  const structured = {
    reason: "settlement-failed",
    ...(transactions.length ? { retry: RETRY_WATCH_TRANSACTION } : {}),
    ...(network ? { network } : {}),
    ...(transactions.length ? { transactions } : {}),
    hint,
  };
  const result = { isError: true, content: [{ type: "text", text: `${label}: ${hint}${where}${routeHint ? ` ${routeHint}` : ""}` }], _meta: { [SETTLEMENT_PENDING_META]: structured } };
  if (s) {
    const { copy } = jsonCopy(s, X402_PAYMENT_MAX_BYTES);
    if (copy && copy.success === false) result._meta[X402_PAYMENT_RESPONSE_META] = copy;
  }
  return result;
}

/**
 * The result for a paid route that answered 5xx after a payment was
 * presented: the route's own answer (`detail`, its body as text) and NO
 * PaymentRequired. The text says not to sign again for this call and names
 * the transaction to watch when the route's body (`refusal`) names one.
 * Never throws.
 */
export function buildPaidRouteFailedResult({ label = "Agent402", status = 500, detail = "", refusal = {} } = {}) {
  const r = isPlainObject(refusal) ? refusal : {};
  const transactions = [];
  for (const t of Array.isArray(r.transactions) ? r.transactions : []) {
    if (typeof t === "string" && TX_ID.test(t.trim()) && !transactions.includes(t.trim()) && transactions.length < 8) transactions.push(t.trim());
  }
  const code = Number.isInteger(status) && status >= 500 && status <= 599 ? status : 500;
  const said = typeof detail === "string" && detail.trim() ? `: ${detail.trim().slice(0, 1000)}` : "";
  const where = transactions.length ? ` Transaction${transactions.length > 1 ? "s" : ""} to watch: ${transactions.join(", ")}.` : "";
  return {
    isError: true,
    content: [{ type: "text", text: `${label} HTTP ${code}${said} The route failed after this payment was presented. Settlement normally runs only after a successful answer, so check the paying wallet before paying again. Do not sign a new authorization for this call: to try again, start a new call.${where}` }],
  };
}

/** True for a paid route's 402 that says the payment's settlement is not
 *  decided yet (buildSettlementPendingResult): its body's retry verb is one
 *  of UNDECIDED_RETRY_VERBS (src/payment-reject.js: same-payment,
 *  watch-transaction, check-wallet) or its reason is settlement-unconfirmed,
 *  or its settle answer reads settlement_pending. Never throws. */
export function isSettlementUndecided(body, settleResponse) {
  try {
    if (isPlainObject(body) && (UNDECIDED_RETRY_VERBS.includes(body.retry) || body.reason === "settlement-unconfirmed")) return true;
    return isPlainObject(settleResponse) && settleResponse.success === false && settleResponse.errorReason === "settlement_pending";
  } catch { return false; }
}

/** The SettleResponse from the route's PAYMENT-RESPONSE header, when it
 *  records a completed settlement (success: true with a transaction and a
 *  network); null otherwise. Never throws. */
export function settleResponseFromHeader(value) {
  if (typeof value !== "string" || !value || value.length > MAX_HEADER_CHARS * 4) return null;
  let decoded;
  try { decoded = decodePaymentResponseHeader(value.trim()); } catch { return null; }
  if (!isPlainObject(decoded) || decoded.success !== true) return null;
  if (typeof decoded.transaction !== "string" || !decoded.transaction) return null;
  if (typeof decoded.network !== "string" || !decoded.network) return null;
  const { copy } = jsonCopy(decoded, X402_PAYMENT_MAX_BYTES);
  return copy || null;
}

/** The success `_meta` entry: {"x402/payment-response": SettleResponse} from
 *  the route's PAYMENT-RESPONSE header, or null. Never throws. */
export function paymentResponseMeta(headerValue) {
  const settle = settleResponseFromHeader(headerValue);
  return settle ? { [X402_PAYMENT_RESPONSE_META]: settle } : null;
}

/** `result` with the settle receipt added to its `_meta` (other keys kept);
 *  `result` unchanged when the header records no completed settlement. */
export function withPaymentResponse(result, headerValue) {
  const meta = paymentResponseMeta(headerValue);
  if (!meta || !isPlainObject(result)) return result;
  const merged = mergeMeta({}, result._meta);
  merged[X402_PAYMENT_RESPONSE_META] = meta[X402_PAYMENT_RESPONSE_META];
  return { ...result, _meta: merged };
}
