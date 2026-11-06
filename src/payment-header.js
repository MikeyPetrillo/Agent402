// One reading of an x402 payment header (PAYMENT-SIGNATURE, X-PAYMENT).
//
// The paywall (@x402/core decodePaymentSignatureHeader) decodes the base64
// with atob and a TextDecoder, which drops a leading UTF-8 byte order mark,
// then JSON.parse. Buffer's utf8 decode keeps that mark, so JSON.parse throws
// on bytes the paywall reads as a payment. Every reader of these headers goes
// through decodePaymentHeader, and the intake middleware rewrites each header
// to the canonical base64 of its parsed JSON before any other middleware runs,
// so every later reader, ours and the library's, sees the same bytes. A header
// that does not decode is removed, and the paywall answers its ordinary 402.

export const PAYMENT_HEADER_NAMES = Object.freeze(["payment-signature", "x-payment"]);

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const utf8 = new TextDecoder("utf-8"); // default: a leading BOM is dropped, as the paywall does

/** The payment header's JSON object, or null when it does not decode to one.
 *  Accepts standard base64 or base64url, padded or not, with surrounding
 *  whitespace and a leading byte order mark on the value itself. Pure. */
export function decodePaymentHeader(value) {
  if (typeof value !== "string" || !value) return null;
  let s = value.replace(/^(?:﻿|ï»¿)/, "").replace(/[\t\n\f\r ]+/g, "");
  if (!s) return null;
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  if (s.length % 4 === 1) return null;
  if (!s.endsWith("=")) s += "=".repeat((4 - (s.length % 4)) % 4);
  if (s.length % 4 !== 0 || !BASE64_RE.test(s)) return null;
  try {
    const parsed = JSON.parse(utf8.decode(Buffer.from(s, "base64")));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The canonical header value for a decoded payload: base64 of its JSON. */
export function encodePaymentHeader(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/** Read every payment header on `req` once. Each one that decodes is rewritten
 *  to its canonical value; when any present one does not decode, both are
 *  removed (the value as sent is kept on `req.__paymentHeaderAsSent` for the
 *  402's diagnostic hint). Returns "none" | "canonical" | "dropped". */
export function canonicalizePaymentHeaders(req) {
  const headers = req?.headers;
  if (!headers) return "none";
  let seen = false;
  const rewritten = [];
  for (const name of PAYMENT_HEADER_NAMES) {
    const raw = headers[name];
    if (raw == null || raw === "") continue;
    seen = true;
    const payload = typeof raw === "string" ? decodePaymentHeader(raw) : null;
    if (!payload) {
      Object.defineProperty(req, "__paymentHeaderAsSent", { value: String(raw), configurable: true, enumerable: false, writable: true });
      for (const n of PAYMENT_HEADER_NAMES) delete headers[n];
      return "dropped";
    }
    rewritten.push([name, encodePaymentHeader(payload)]);
  }
  for (const [name, value] of rewritten) headers[name] = value;
  return seen ? "canonical" : "none";
}

/** Express middleware: canonicalizePaymentHeaders on every request. */
export function paymentHeaderIntake() {
  return function paymentHeaderIntakeMiddleware(req, _res, next) {
    canonicalizePaymentHeaders(req);
    next();
  };
}
