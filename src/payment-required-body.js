// The 402 body carries the same PaymentRequired object as the header.
//
// x402 v2 puts the payment requirements in the base64 PAYMENT-REQUIRED header
// and the paywall answers with a JSON body of `{}`, plus the fields this server
// adds (altPayment, replacement, reason, hint, retry, an RFC 9457 problem). A
// client or index that reads the BODY found no accepts at all. This module
// copies the decoded header object (x402Version, error, resource, accepts,
// extensions) into the JSON body of the same response.
//
// The header stays authoritative and is never touched. The body is the same
// object for a reader of either, so the two cannot disagree: every key the
// header carries wins, every other key this server set is kept, and those keys
// keep their place at the front of the body (a log line that shows the first
// hundred characters still shows the reason).
//
// ONE EXCEPTION, `error`, on a body that explains itself. A refusal this server
// explained (a verify or gate `hint`, or an RFC 9457 problem's `detail`) keeps
// its explanation where an `error`-first client reads it: such a body carries
// the offer (x402Version, resource, accepts, extensions) and NO `error` at all,
// neither the header's one-line sentence nor our own "Payment rejected"
// fallback. OpenAI-compatible SDK clients build their message from a top-level
// `error` whenever one exists (and from the whole body otherwise), and
// agent402-client reads `error` before `detail`, so a mirrored `error` showed
// "insufficient_funds" or "Payment required" in place of the hint that says
// the wallet holds too little USDC, or the problem detail that names the bad
// credential. `error` is optional in the protocol's PaymentRequired schema, so
// the body still parses as one, and a key that is absent does not disagree
// with the header. An unpaid 402 (no hint, no detail) carries the header's
// `error` like every other key.
//
// WHY A SEND-LEVEL WRAPPER. The MPP problem patch (markMppProblem in
// src/mpp-problem.js) replaces the body at res.send, after every res.json
// wrapper has run. A merge at res.json would be thrown away on an MPP refusal,
// and those 402s do carry PAYMENT-REQUIRED. So this wraps res.send and is
// MOUNTED BEFORE every middleware that can call markMppProblem (the MPP shim,
// the Tempo gate and the Stripe gate): the problem patch then captures THIS
// wrapper as the send it delegates to, and every res.json wrapper (the
// proof-of-work altPayment hint, the retired-converter pointer, the verify
// hint) ends in this.send and reaches it too. It reads the FINAL header, which
// the paywall set after the Algorand sub-cent filter, the accepts[0]
// outputSchema stamp and the per-request quote. Nothing here rebuilds an offer.
//
// KEYED ON THE HEADER. A body is merged only when the status is 402 or 412
// (412 is permit2_allowance_required, which also carries the header), a
// PAYMENT-REQUIRED header on the response decodes to an object with a numeric
// x402Version and an accepts array, and the body is a JSON object. Everything
// else goes out byte-identical: a settle-failure 402 (PAYMENT-RESPONSE only),
// a prepaid-credits 402, a Tempo or Stripe problem answered directly, a 402 a
// handler threw, an HTML paywall page, a Buffer. Putting accepts on any of
// those would state an offer no header states.
//
// It never throws: any failure sends the original body.
//
// THE HEADER'S OWN SIZE. With the compact option on (server.js, unless
// PAYMENT_REQUIRED_COMPACT=off), a mirrored 402 body also says how large the
// header it carries is and how to ask for the compact one
// (`paymentRequiredHeader`), and a request that asks gets the compact header
// (src/payment-required-compact.js) while this body keeps the full offer. The
// decision is made here, after the full header is in the body, so the body
// always holds every accept.
//
// THE TERMS. A mirrored body also names the terms the payment is made under
// (`terms`, the /terms URL, and `termsNote`), so an agent that reads only the
// 402 meets them before it pays. Body only: the header is never touched.
//
// Rollback lever: PAYMENT_REQUIRED_BODY=off and server.js does not mount it.
import { decodeB64Json } from "./payment-reject.js";
import { COMPACT_REQUEST_EXAMPLE, compactPaymentRequired, markCompactHeader, wantsCompactHeader } from "./payment-required-compact.js";

/** Statuses whose body mirrors the header when one is present. */
export const MIRRORED_STATUSES = Object.freeze(new Set([402, 412]));

/** The body field that describes the PAYMENT-REQUIRED header itself. */
export const HEADER_NOTE_KEY = "paymentRequiredHeader";
/** The body field that names the terms a payment is made under: the URL of
 *  /terms (`terms`) and one sentence saying so (`termsNote`). Body only, so
 *  the header and its size budget are unchanged. */
export const TERMS_KEY = "terms";
export const TERMS_NOTE_KEY = "termsNote";
/** The `terms` and `termsNote` fields for a terms URL, or {} without one. */
export function termsFields(termsUrl) {
  if (typeof termsUrl !== "string" || !termsUrl) return {};
  return { [TERMS_KEY]: termsUrl, [TERMS_NOTE_KEY]: `Paying for this call accepts the Terms of Service at ${termsUrl}.` };
}

/** The protocol keys that make up the offer. `error` is deliberately not
 *  here: it is the refusal's own sentence and a stripped copy keeps it. */
export const PAYMENT_REQUIRED_OFFER_KEYS = Object.freeze(["x402Version", "resource", "accepts", "extensions"]);

const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

/** True when a 402 body already says in words what went wrong: our verify or
 *  gate `hint`, or an RFC 9457 problem's `detail`. Such a body is mirrored
 *  without `error` (see the header comment). */
export function explainsItself(body) {
  return isPlainObject(body) && (nonEmptyString(body.hint) || nonEmptyString(body.detail));
}

/** The PaymentRequired object in a PAYMENT-REQUIRED header value, or null when
 *  it is absent, undecodable, or not shaped like one. */
export function decodePaymentRequired(value) {
  if (typeof value !== "string" || !value) return null;
  const doc = decodeB64Json(value);
  if (!isPlainObject(doc)) return null;
  if (typeof doc.x402Version !== "number" || !Array.isArray(doc.accepts)) return null;
  return doc;
}

/** The body with the header's object merged in (header keys win), as a JSON
 *  string, or null when the body should go out unchanged. A body that
 *  explains itself gets the offer without any `error` key. */
export function mergePaymentRequiredBody(bodyText, headerValue, trailing = null) {
  try {
    if (typeof bodyText !== "string" || !bodyText.trimStart().startsWith("{")) return null;
    const pr = decodePaymentRequired(headerValue);
    if (!pr) return null;
    const body = JSON.parse(bodyText);
    if (!isPlainObject(body)) return null;
    const tail = isPlainObject(trailing) ? trailing : {};
    if (!explainsItself(body)) return JSON.stringify({ ...body, ...pr, ...tail });
    const { error: _headerError, ...offer } = pr;
    const { error: _ownError, ...ours } = body;
    return JSON.stringify({ ...ours, ...offer, ...tail });
  } catch {
    return null;
  }
}

/** A copy of a mirrored 402 body without the offer keys, for surfaces that
 *  relay a refusal as text (the offer stays in the header). Anything that is
 *  not shaped like a mirrored body is returned unchanged. */
export function withoutPaymentRequired(doc) {
  if (!isPlainObject(doc) || typeof doc.x402Version !== "number") return doc;
  const out = { ...doc };
  for (const k of PAYMENT_REQUIRED_OFFER_KEYS) delete out[k];
  delete out[HEADER_NOTE_KEY];
  delete out[TERMS_KEY];
  delete out[TERMS_NOTE_KEY];
  return out;
}

/** The `paymentRequiredHeader` body field, and the compact header value when
 *  this request asked for one that is shorter than the full header. */
export function headerNoteFor(req, headerValue, statusCode) {
  const pr = statusCode === 402 && wantsCompactHeader(req) ? decodePaymentRequired(headerValue) : null;
  const c = pr ? compactPaymentRequired(pr) : null;
  const note = { bytes: (c ? c.value : headerValue).length, compact: !!c };
  if (c) Object.assign(note, { acceptsInHeader: c.doc.accepts.length, acceptsInBody: pr.accepts.length });
  note.compactRequest = COMPACT_REQUEST_EXAMPLE;
  return { note, compactValue: c ? c.value : null };
}

/** Express middleware. See the header comment for the mount-order rule. */
export function paymentRequiredBodyMiddleware({ compact = false, termsUrl = null } = {}) {
  const terms = termsFields(termsUrl);
  return function paymentRequiredBody(req, res, next) {
    const origSend = res.send;
    res.send = function mirroredSend(chunk) {
      try {
        if (typeof chunk === "string" && MIRRORED_STATUSES.has(res.statusCode) && !res.headersSent) {
          const header = res.getHeader("PAYMENT-REQUIRED");
          const h = compact && decodePaymentRequired(header) ? headerNoteFor(req, header, res.statusCode) : null;
          const merged = mergePaymentRequiredBody(chunk, header, { ...terms, ...(h ? { [HEADER_NOTE_KEY]: h.note } : {}) });
          if (merged !== null) {
            chunk = merged;
            if (h?.compactValue) markCompactHeader(res, header, h.compactValue);
          }
        }
      } catch {
        // A mirror must never break a 402.
      }
      return origSend.call(this, chunk);
    };
    next();
  };
}
