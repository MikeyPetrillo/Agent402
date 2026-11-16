// x402 over MCP (transports-v2/mcp.md): the codec between an MCP tool call
// and the paid HTTP route that decides it. Pure: no I/O, no settlement.
//
// Wire:
//   - payment required: a tool RESULT with isError: true, structuredContent =
//     the PaymentRequired object, content[0].text = JSON.stringify of that same
//     object (a client without structured content parses it from there);
//   - the client retries with the PaymentPayload object in
//     tools/call params._meta["x402/payment"];
//   - a settled result carries the SettleResponse in
//     result._meta["x402/payment-response"];
//   - a settle that fails after the handler ran returns the payment-required
//     shape again and none of the tool's output.
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

export const X402_PAYMENT_META = "x402/payment";
export const X402_PAYMENT_RESPONSE_META = "x402/payment-response";
export const X402_PAYMENT_HEADER = "PAYMENT-SIGNATURE";
/** Compact JSON bytes of one payment payload. Its base64 header (4/3 of this)
 *  stays well inside the HTTP parser's 16 KiB header block; a signed EVM
 *  authorization is under 1 KiB and a signed Solana, Stellar or Algorand
 *  transaction a few KiB. */
export const X402_PAYMENT_MAX_BYTES = 8192;
const MAX_DEPTH = 8;
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
  const result = { isError: true, structuredContent: paymentRequired, content };
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
