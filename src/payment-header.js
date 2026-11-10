// One reading of an x402 payment header (PAYMENT-SIGNATURE, X-PAYMENT).
//
// It decodes a header the same way the paywall's own decoder does. Every
// reader of these headers goes through decodePaymentHeader, and the intake
// middleware rewrites each header to the canonical base64 of its parsed JSON
// before any other middleware runs, so every later reader, ours and the
// library's, sees the same bytes. A header that does not decode is removed,
// and the paywall answers its ordinary 402.

export const PAYMENT_HEADER_NAMES = Object.freeze(["payment-signature", "x-payment"]);

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const utf8 = new TextDecoder("utf-8"); // default: a leading BOM is dropped, as the paywall does

// The families whose payment is a signed transaction, by v1 name prefix. A
// CAIP-2 id is read by its namespace instead. scripts/test-payment-header-signed-fields.js
// holds this beside the server's own network table.
const NON_EVM_V1 = /^(?:solana|algorand|stellar)/i;
/** Whether a declared network settles an EIP-3009 authorization: an eip155
 *  CAIP-2 id, or a v1 name outside the transaction-signed families. */
export function isEvmNetworkName(network) {
  if (typeof network !== "string" || !network) return false;
  if (network.includes(":")) return network.startsWith("eip155:");
  return !NON_EVM_V1.test(network);
}

/** Remove the EVM authorization blocks no signature covers. A payload carries
 *  two: `authorization` (EIP-3009) and `permit2Authorization` (Permit2). The
 *  facilitator verifies one of them, and only on an EVM network: Permit2 when
 *  that block is present, EIP-3009 otherwise. On a network that settles a
 *  signed transaction it reads neither, so there both are whatever the sender
 *  typed, and both are removed; beside a Permit2 block the EIP-3009 block is
 *  removed. Every network the header names (v2 `accepted.network`, v1
 *  `network`, `payload.network`) must be an EVM one for a block to stay:
 *  whichever of them the paywall reads, it then verified that block. A header
 *  naming no network matches no offer and is never verified, so nothing
 *  downstream of a verify reads it. Mutates and returns `decoded`. */
export function dropUnsignedAuthorization(decoded) {
  const inner = decoded?.payload;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return decoded;
  const has = (k) => Object.hasOwn(inner, k);
  if (!has("authorization") && !has("permit2Authorization")) return decoded;
  const named = [decoded?.accepted?.network, decoded?.network, inner.network].filter((n) => n !== undefined && n !== null);
  if (!named.every(isEvmNetworkName)) { delete inner.authorization; delete inner.permit2Authorization; return decoded; }
  if (inner.permit2Authorization !== undefined && inner.permit2Authorization !== null) delete inner.authorization;
  return decoded;
}

/** One spelling of a signed nonce: a decimal or 0x integer in its decimal
 *  form ("7", "07" and "0x7" are one nonce to the contract that consumes it),
 *  anything else lowercased as sent. */
export function canonicalNonce(nonce) {
  const raw = String(nonce ?? "").trim();
  if (/^(?:0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(raw)) { try { return BigInt(raw).toString(); } catch { /* fall through */ } }
  return raw.toLowerCase();
}

/** The payment header's JSON object, or null when it does not decode to one.
 *  An authorization block no signature covers is removed (see
 *  dropUnsignedAuthorization), so no reader takes an identity, nonce or
 *  amount from it, and the intake rewrite below sends the header on without it.
 *  Accepts standard base64 or base64url, padded or not, with surrounding
 *  whitespace and a leading byte order mark on the value itself. Pure. */
export function decodePaymentHeader(value) {
  const parsed = parsePaymentHeader(value);
  return parsed ? dropUnsignedAuthorization(parsed) : null;
}
function parsePaymentHeader(value) {
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

// What intake removed, for the operator: a real client that sends one of
// these blocks where no signature covers it would show up here, by network
// family and block name, never by address. One line a minute at most.
const removed = new Map();
let removedLoggedAt = 0;
const familyOf = (decoded) => {
  const n = String(decoded?.accepted?.network ?? decoded?.network ?? decoded?.payload?.network ?? "none");
  return n.includes(":") ? n.split(":")[0] : (isEvmNetworkName(n) ? "evm-v1" : n.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16) || "none");
};
function noteRemovedBlocks(parsed, now = Date.now(), log = console.log) {
  const inner = parsed?.payload;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return;
  const before = ["authorization", "permit2Authorization"].filter((k) => Object.hasOwn(inner, k));
  if (!before.length) return;
  const copy = { ...parsed, payload: { ...inner } };
  dropUnsignedAuthorization(copy);
  for (const k of before) if (!Object.hasOwn(copy.payload, k)) { const key = `${familyOf(parsed)}/${k}`; removed.set(key, (removed.get(key) || 0) + 1); }
  if (removed.size && now - removedLoggedAt >= 60_000) {
    removedLoggedAt = now;
    log(`[payment-header] unsigned blocks removed at intake: ${[...removed].map(([k, n]) => `${k}=${n}`).join(" ")}`);
    removed.clear();
  }
}
/** Counts not yet logged; test seam. */
export function __removedBlockCounts() { return Object.fromEntries(removed); }
export function __noteRemovedBlocksForTest(parsed, now, log) { return noteRemovedBlocks(parsed, now, log); }

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
    const parsed = typeof raw === "string" ? parsePaymentHeader(raw) : null;
    if (parsed) noteRemovedBlocks(parsed);
    const payload = parsed ? dropUnsignedAuthorization(parsed) : null;
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
