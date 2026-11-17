// A compact PAYMENT-REQUIRED header for a client with a small header limit.
//
// Every paid route's PAYMENT-REQUIRED header carries one accept per rail plus
// the Bazaar listing and two optional extensions, and measures between about
// 8.5 and 10.5 KB. A client whose HTTP parser caps a header line near 8 KB
// (Python aiohttp's default max_line_size is 8190) cannot read that 402 at
// all, so it can never pay.
//
// On request, this serves a shorter header in its place:
//   - the resource and the Bazaar extension exactly as the full header has them
//     (the facilitator indexes the listing from what the client copies out of
//     the header, so it is never reduced);
//   - the primary exact accept (Base USDC first), then every other plain exact
//     accept in the original order that keeps it under
//     COMPACT_HEADER_MAX_BYTES; upto and Gateway batched accepts are left out,
//     and so is every extension other than the Bazaar one (builder-code and
//     payment-identifier are optional for an exact payment);
//   - a `compact` field that counts what was left out and names where the full
//     list is: the 402 body, which keeps the full PaymentRequired object with
//     every accept (src/payment-required-body.js).
// Each kept accept is the full header's object, unchanged, so a payment signed
// from one matches the route's requirements and settles exactly as before.
//
// WHO GETS IT. Only a request that asks: `X-Payment-Compact: 1` (or true), or a
// User-Agent naming aiohttp, whose default limit is the reason this exists.
// Every other request, the Bazaar validator's included, gets the header it got
// before, byte for byte. Every 402 that carries the header varies on both
// request headers, so a cache never hands one client's header to another.
//
// WHEN. The 402 body mirror decides at res.send, after it has copied the FULL
// header into the body, and leaves the compact value on the response. The
// header itself is swapped at writeHead by paymentRequiredCompactMiddleware,
// which is mounted FIRST so its hook runs LAST: every other reader of the
// header at writeHead (the MPP shim mints its challenges from it) still reads
// the full offer. A full header already under the ceiling is served unchanged.
//
// Rollback lever: PAYMENT_REQUIRED_COMPACT=off and server.js mounts neither half.
import { isGatewayBatchedPayment } from "./gateway-wire.js";

/** The request header that asks for the compact header. */
export const COMPACT_REQUEST_HEADER = "X-Payment-Compact";
/** The documented way to ask, as a client sends it. */
export const COMPACT_REQUEST_EXAMPLE = `${COMPACT_REQUEST_HEADER}: 1`;
/** The compact header's value stays under this many bytes: under 8 KB with
 *  room for the header name and line ending on a parser capped at 8190. */
export const COMPACT_HEADER_MAX_BYTES = 7500;
/** The request headers that decide which header a 402 carries. */
export const COMPACT_VARY = Object.freeze([COMPACT_REQUEST_HEADER, "User-Agent"]);
/** The primary network: Base. */
export const PRIMARY_NETWORK = "eip155:8453";
/** The one extension the compact header keeps. */
export const KEPT_EXTENSION = "bazaar";
/** Where the full offer is, as the compact header names it. */
export const FULL_OFFER_IN = "body";

const AIOHTTP_UA = /\baiohttp\//i;
const YES = /^\s*(?:1|true|yes|on)\s*$/i;
const COMPACT = Symbol.for("agent402.paymentRequiredCompact");

const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const encode = (doc) => Buffer.from(JSON.stringify(doc), "utf8").toString("base64");

/** True when the request asks for the compact header (the flag, or aiohttp). */
export function wantsCompactHeader(req) {
  const h = req?.headers || {};
  const flag = h[COMPACT_REQUEST_HEADER.toLowerCase()];
  if (typeof flag === "string" && YES.test(flag)) return true;
  const ua = h["user-agent"];
  return typeof ua === "string" && ua.length <= 1024 && AIOHTTP_UA.test(ua);
}

const isPlainExact = (a) => isPlainObject(a) && a.scheme === "exact" && !isGatewayBatchedPayment(a);

/**
 * The compact PaymentRequired for a full one, as { doc, value }, or null when
 * there is nothing to shorten: the full header is already under `maxBytes`,
 * the object is not a v2 offer, or it holds no plain exact accept. The value
 * may still reach `maxBytes` when the primary accept alone does not fit; it is
 * then the smallest offer that can be paid from.
 */
export function compactPaymentRequired(pr, maxBytes = COMPACT_HEADER_MAX_BYTES) {
  if (!isPlainObject(pr) || !Array.isArray(pr.accepts) || !isPlainObject(pr.resource)) return null;
  if (encode(pr).length < maxBytes) return null;
  const exact = pr.accepts.filter(isPlainExact);
  if (!exact.length) return null;
  const primary = exact.find((a) => a.network === PRIMARY_NETWORK) || exact[0];
  const extensions = isPlainObject(pr.extensions) && KEPT_EXTENSION in pr.extensions ? { [KEPT_EXTENSION]: pr.extensions[KEPT_EXTENSION] } : undefined;
  const omittedExtensions = isPlainObject(pr.extensions) ? Object.keys(pr.extensions).filter((k) => k !== KEPT_EXTENSION) : [];
  const build = (accepts) => {
    const doc = { ...pr, accepts };
    if (extensions) doc.extensions = extensions; else delete doc.extensions;
    doc.compact = { acceptsOmitted: pr.accepts.length - accepts.length, extensionsOmitted: omittedExtensions, fullOfferIn: FULL_OFFER_IN };
    return doc;
  };
  let kept = [primary];
  for (const a of exact) {
    if (a === primary) continue;
    if (encode(build([...kept, a])).length < maxBytes) kept = [...kept, a];
  }
  const doc = build(kept);
  return { doc, value: encode(doc) };
}

/** Mark a response to carry `compactValue` in place of `fullValue` when its
 *  head is written (called by the 402 body mirror). */
export function markCompactHeader(res, fullValue, compactValue) {
  try { res[COMPACT] = { full: fullValue, compact: compactValue }; } catch { /* never break a 402 */ }
}

/** `Vary` with every token in `add` present once, existing tokens kept. */
export function mergeVary(current, add = COMPACT_VARY) {
  const cur = String(current ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (cur.includes("*")) return "*";
  const have = new Set(cur.map((s) => s.toLowerCase()));
  for (const t of add) if (!have.has(t.toLowerCase())) { cur.push(t); have.add(t.toLowerCase()); }
  return cur.join(", ");
}

/**
 * Express middleware, mounted before every other middleware so its writeHead
 * hook runs after theirs. A response that carries PAYMENT-REQUIRED varies on
 * the request headers that choose it; a response the mirror marked gets the
 * compact value, provided the header still holds the value the mirror saw.
 */
export function paymentRequiredCompactMiddleware() {
  return function paymentRequiredCompact(_req, res, next) {
    const writeHead = res.writeHead;
    res.writeHead = function compactWriteHead(...args) {
      try {
        if (!res.headersSent) {
          const current = res.getHeader("PAYMENT-REQUIRED");
          if (typeof current === "string" && current) {
            res.setHeader("Vary", mergeVary(res.getHeader("Vary")));
            const mark = res[COMPACT];
            const status = Number(args[0]) || res.statusCode;
            if (mark && status === 402 && mark.full === current && typeof mark.compact === "string" && mark.compact) {
              res.setHeader("PAYMENT-REQUIRED", mark.compact);
            }
          }
        }
      } catch { /* a header swap must never break a response */ }
      return writeHead.apply(this, args);
    };
    next();
  };
}

/** Python aiohttp's default cap on one header line, in bytes (its
 *  max_line_size and max_field_size defaults). */
export const AIOHTTP_DEFAULT_LINE_BYTES = 8190;

/** One paragraph, for every text surface that tells a client how to read the
 *  402 when its parser caps a header line (/llms-full.txt, the
 *  /how-to-pay page and the wiki copy it). Plain text with backquoted code. */
export function smallHeaderLimitText() {
  return `A client whose parser caps one header line near 8 KB (Python aiohttp's default \`max_line_size\` and \`max_field_size\` are ${AIOHTTP_DEFAULT_LINE_BYTES}) reads the 402 one of two ways. Raise the limit: \`aiohttp.ClientSession(max_line_size=32768, max_field_size=32768)\`. Or send \`${COMPACT_REQUEST_EXAMPLE}\` (a User-Agent that names aiohttp gets the same without it) for a PAYMENT-REQUIRED header under ${COMPACT_HEADER_MAX_BYTES.toLocaleString("en-US")} bytes: the resource and the Bazaar extension unchanged, the Base exact accept first, each other exact accept that fits, and a \`compact\` field whose \`fullOfferIn\` names the body, which keeps every accept. A payment signed from the compact header settles the same way. The paywall's 402 body states the header's size in \`paymentRequiredHeader\`.`;
}

