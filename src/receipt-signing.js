// Signed receipts: a receipt this server signs over each paid answer it
// served after the payment settled.
//
// Off unless RECEIPT_SIGNING_KEY is set. With it, every final 200 whose
// payment settled (x402 on every network, the MPP evm wire, Tempo, the card
// wire, a prepaid credits debit) carries a receipt: a compact JWS (RFC 7515),
// EdDSA over Ed25519, whose payload is the canonical record below. The public
// keys are published at RECEIPT_KEYS_PATH, and POST RECEIPT_VERIFY_PATH checks
// a receipt against them (free, no egress). A card-bought report carries one
// signed by createCheckoutReceipt (src/human-checkout.js stores it on the
// delivered report). A monitor subscription's paid period (the first one and
// each renewal, by card or over MPP on Tempo) carries one signed by
// createSubscriptionReceipt once the period's payment is final
// (src/stripe-subscriptions.js on invoice.paid, src/mpp-subscriptions.js on a
// confirmed transfer), kept on the subscription's record.
//
// Where it is signed: receiptSignerMiddleware() wraps res.writeHead,
// res.write and res.end and is mounted before every payment gate, so each
// gate's buffered answer is replayed through it AFTER the gate settled (the
// x402 middleware, the Tempo broadcast and the card capture all settle before
// they replay the buffered body; a Tempo push credential and a credits debit
// are final before the end of the answer). It signs a final 200 only when
// `describe` (src/server.js) reads settlement evidence on the response: a
// decoded PAYMENT-RESPONSE with success true, the Tempo/card gate's own
// settled mark, or the credits debit the gate landed. Delivery:
//   - an answer sent in one end() call with the head not yet written: the
//     `Agent402-Receipt` response header;
//   - an answer written in parts (a stream): the digest covers every byte
//     written, and the receipt follows the last byte as a final server-sent
//     comment line (`: agent402-receipt <receipt>`, RECEIPT_SSE_COMMENT) when
//     the answer is text/event-stream (a comment, not an event: every
//     event-stream parser skips it, so a client that JSON-parses each event's
//     data, as OpenAI-compatible SDKs do, never meets it and finishes the
//     stream as it would without it), and as an `Agent402-Receipt` HTTP trailer when the
//     client sent `TE: trailers` on HTTP/1.1. Every streamed answer is
//     signed, a stream that is neither (no event stream, no trailers asked
//     for) included: its head names X-Agent402-Receipt-Url (RECEIPT_URL_HEADER,
//     GET RECEIPT_FETCH_PATH/<key>), and the receipt is kept there once the
//     answer finished 200 (src/receipt-store.js), the same receipt a trailer
//     carries. The key is a random token the head names (never the
//     settlement, which is public on chain), so only the buyer can fetch it.
// A 4xx/5xx, a failed settle (402), a free or trial answer carries none.
//
// Key settings (src/receipt-signing.js is the only reader):
//   RECEIPT_SIGNING_KEY       a PKCS8 Ed25519 private key in PEM, the whole
//                             PEM base64-encoded as one line. Anything else
//                             is refused at boot with the reason (the value
//                             is never logged) and signing stays off.
//   RECEIPT_SIGNING_KEY_ID    the key id (1-32 of A-Z a-z 0-9 . _ -), e.g.
//                             "r1-2026-11". Required with the key.
//   RECEIPT_SIGNING_KEY_VALID_FROM  optional ISO date the key is valid from.
//   RECEIPT_RETIRED_KEYS      optional JSON array of earlier public keys
//                             [{ kid, x, validFrom, validUntil }] (x: the raw
//                             32-byte Ed25519 public key, base64url), kept
//                             published so receipts they signed still verify.
//                             A list that does not read refuses signing.
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, randomUUID, randomBytes } from "node:crypto";
import { gateMounted } from "./gate-mounts.js";

export const RECEIPT_HEADER = "Agent402-Receipt";
export const RECEIPT_KEYS_PATH = "/.well-known/agent402-receipt-key.json";
export const RECEIPT_VERIFY_PATH = "/api/receipts/verify";
export const RECEIPT_TYP = "agent402-receipt+jws";
export const RECEIPT_VERSION = 1;
/** The rail kinds a receipt is signed on (conformance rows read this).
 *  "credits": a prepaid credits debit; "card-checkout": a report bought at
 *  card checkout (signed at delivery, src/human-checkout.js);
 *  "card-subscription" / "mpp-subscription": a monitor subscription's paid
 *  period, by card or over MPP on Tempo (signed once the payment is final). */
export const SIGNED_RAILS = Object.freeze(["x402", "gateway-batched", "mpp-evm", "mpp-tempo", "mpp-stripe", "credits", "card-checkout", "card-subscription", "mpp-subscription"]);
/** The rails the response signer signs on (the card checkout signs at delivery). */
const RESPONSE_RAILS = Object.freeze(["x402", "gateway-batched", "mpp-evm", "mpp-tempo", "mpp-stripe", "credits"]);
/** The tag of the server-sent comment line that carries a streamed answer's
 *  receipt: `: agent402-receipt <receipt>`. */
export const RECEIPT_SSE_COMMENT = "agent402-receipt";
const SSE_FRAME_HEAD = `\n: ${RECEIPT_SSE_COMMENT} `;
/** The head of a streamed paid answer names where its receipt is kept. */
export const RECEIPT_URL_HEADER = "X-Agent402-Receipt-Url";
/** GET RECEIPT_FETCH_PATH/<key>: a kept streamed answer's receipt (free). */
export const RECEIPT_FETCH_PATH = "/api/receipt";
// A fetch key is a random 128-bit token (base64url, 22 characters) that only
// the answer's head names, so only the buyer holds it. A settlement is never
// a key: an on-chain transaction is public, and a key anyone can read off the
// chain would make every streamed receipt (route, price, payer, digests) a
// feed of what a wallet bought.
const FETCH_KEY_RE = /^[A-Za-z0-9_-]{22}$/;
/** Whether `key` reads as a receipt fetch key (a token a streamed answer's head named). */
export function isReceiptFetchKey(key) { return typeof key === "string" && FETCH_KEY_RE.test(key); }
/** A new fetch key. */
export function newReceiptFetchKey() { return randomBytes(16).toString("base64url"); }
/**
 * The key a call's settlement fields give its streamed receipt: always null.
 * A streamed receipt is kept only under the random token its head names
 * (newReceiptFetchKey), whatever the rail. Kept for callers that ask.
 */
export function receiptFetchKey(_fields) {
  return null;
}

/** Upper bound on the header value: every string field is capped below. */
export const RECEIPT_MAX_BYTES = 2048;
const FIELD_MAX = 160;

const KID_RE = /^[A-Za-z0-9._-]{1,32}$/;
// The PKCS8 PEM markers, built from parts so a secret scanner does not take
// the constant for a key.
const PEM_LABEL = "PRIVATE " + "KEY";
const PEM_HEAD = `-----BEGIN ${PEM_LABEL}-----`;
const PEM_TAIL = `-----END ${PEM_LABEL}-----`;

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");
const cap = (v) => (v == null ? null : String(v).slice(0, FIELD_MAX));

function isoOrNull(v, name) {
  if (v == null || v === "") return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) throw new Error(`${name} is not a date`);
  return new Date(t).toISOString();
}

/** The Ed25519 public key of `keyObject` as raw bytes, base64url. */
function rawPublicX(keyObject) {
  return createPublicKey(keyObject).export({ format: "jwk" }).x;
}

/**
 * Parse the signing settings. Returns { signer, keys, error }: signer null
 * and error null when the key is unset (feature off), signer null and error
 * a reason when a setting is unusable. The reason never quotes a value.
 */
export function loadReceiptKeys(env = process.env) {
  const raw = typeof env.RECEIPT_SIGNING_KEY === "string" ? env.RECEIPT_SIGNING_KEY.trim() : "";
  const retired = [];
  let error = null;
  try {
    let list = [];
    if (env.RECEIPT_RETIRED_KEYS) { try { list = JSON.parse(env.RECEIPT_RETIRED_KEYS); } catch { throw new Error("RECEIPT_RETIRED_KEYS is not JSON"); } }
    if (!Array.isArray(list)) throw new Error("RECEIPT_RETIRED_KEYS is not a JSON array");
    for (const k of list) {
      if (!k || typeof k !== "object" || !KID_RE.test(String(k.kid || ""))) throw new Error("RECEIPT_RETIRED_KEYS has an entry without a usable kid");
      const x = String(k.x || "");
      if (Buffer.from(x, "base64url").length !== 32) throw new Error(`RECEIPT_RETIRED_KEYS ${k.kid}: x is not a 32-byte base64url key`);
      createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
      retired.push({ kid: k.kid, x, validFrom: isoOrNull(k.validFrom, `RECEIPT_RETIRED_KEYS ${k.kid} validFrom`), validUntil: isoOrNull(k.validUntil, `RECEIPT_RETIRED_KEYS ${k.kid} validUntil`), status: "retired" });
    }
  } catch (e) {
    error = String(e?.message || "RECEIPT_RETIRED_KEYS is unusable").replace(/[\r\n]/g, " ").slice(0, 200);
    retired.length = 0;
  }
  if (!raw) return { signer: null, keys: retired, error };
  // A retired list that does not read refuses signing: a receipt its keys
  // signed would stop verifying the moment this key replaced them.
  if (error) return { signer: null, keys: [], error: `${error}; signing refused until it reads` };
  const kid = typeof env.RECEIPT_SIGNING_KEY_ID === "string" ? env.RECEIPT_SIGNING_KEY_ID.trim() : "";
  try {
    if (!KID_RE.test(kid)) throw new Error("RECEIPT_SIGNING_KEY_ID is missing or not 1-32 of A-Z a-z 0-9 . _ -");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error("RECEIPT_SIGNING_KEY is not one line of base64");
    const pem = Buffer.from(raw, "base64").toString("utf8").trim();
    if (!pem.startsWith(PEM_HEAD) || !pem.includes(PEM_TAIL)) throw new Error("RECEIPT_SIGNING_KEY does not decode to a PKCS8 PEM private key");
    let privateKey;
    try { privateKey = createPrivateKey({ key: pem, format: "pem" }); } catch { throw new Error("RECEIPT_SIGNING_KEY: the PEM does not parse as a private key"); }
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`RECEIPT_SIGNING_KEY is a ${privateKey.asymmetricKeyType} key, not Ed25519`);
    if (retired.some((k) => k.kid === kid)) throw new Error("RECEIPT_SIGNING_KEY_ID is also listed in RECEIPT_RETIRED_KEYS");
    const validFrom = isoOrNull(env.RECEIPT_SIGNING_KEY_VALID_FROM, "RECEIPT_SIGNING_KEY_VALID_FROM");
    const x = rawPublicX(privateKey);
    const signer = { kid, privateKey, x, validFrom };
    return { signer, keys: [{ kid, x, validFrom, validUntil: null, status: "current" }, ...retired], error };
  } catch (e) {
    return { signer: null, keys: retired, error: String(e?.message || "RECEIPT_SIGNING_KEY is unusable").slice(0, 200) };
  }
}

// The process's settings, read once.
let LOADED = null;
export function receiptKeys() { if (!LOADED) LOADED = loadReceiptKeys(); return LOADED; }
/** Test hook: re-read the settings from `env`. */
export function resetReceiptKeys(env) { LOADED = env ? loadReceiptKeys(env) : null; return receiptKeys(); }
/** True while a usable key is loaded in this process. */
export function receiptSigningEnabled() { return !!receiptKeys().signer; }
/** True while paid answers carry a signed receipt: a key loaded AND the
 *  signer mounted in the serving chain (src/server.js; never in FREE_MODE).
 *  Copy that offers signed receipts reads this. */
export function receiptsServed() { return gateMounted("receiptSigner") && receiptSigningEnabled(); }

/** The published key document. */
export function receiptKeyDocument(baseUrl = "") {
  const { keys } = receiptKeys();
  return {
    document: "agent402-receipt-keys",
    version: RECEIPT_VERSION,
    signing: receiptSigningEnabled(),
    header: RECEIPT_HEADER,
    format: "Compact JWS (RFC 7515), alg EdDSA (Ed25519); the protected header names the kid; the payload is the receipt record.",
    verify: `${baseUrl}${RECEIPT_VERIFY_PATH}`,
    keys: keys.map((k) => ({ kid: k.kid, kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", x: k.x, status: k.status, validFrom: k.validFrom, validUntil: k.validUntil })),
  };
}

/**
 * The request digest a receipt names: sha256 hex of
 * "<METHOD> <path>[?<query>]\n" followed by the request body as this server
 * parsed it, JSON.stringify'd (a raw body: its bytes; none: "-"). A client
 * that sent JSON.stringify(input) recomputes it from its own input.
 */
export function requestDigest(method, pathWithQuery, body) {
  const h = createHash("sha256").update(`${String(method || "").toUpperCase()} ${String(pathWithQuery || "")}\n`);
  if (Buffer.isBuffer(body)) h.update(body);
  else if (body && typeof body === "object" && Object.keys(body).length) h.update(JSON.stringify(body));
  else if (typeof body === "string" && body) h.update(body);
  else h.update("-");
  return h.digest("hex");
}

/** sha256 hex of the answer bytes (before any content encoding). */
export function responseDigest(bytes) { return sha256hex(bytes ?? Buffer.alloc(0)); }

/** The canonical record, keys in a fixed order. */
export function buildReceiptRecord({ iss = null, method, path, slug = null, requestSha256, responseSha256, priceUsd = null, rail, network = null, payer = null, settlement = null, replay = false, now = Date.now(), id = null }) {
  const price = Number.isFinite(Number(priceUsd)) && priceUsd !== null && priceUsd !== "" ? String(Number(Number(priceUsd).toFixed(8))) : null;
  const rid = id || (settlement
    ? b64u(createHash("sha256").update(`${rail}|${network}|${settlement}|${requestSha256}|${responseSha256}`).digest()).slice(0, 22)
    : b64u(Buffer.from(randomUUID().replace(/-/g, ""), "hex")));
  return {
    v: RECEIPT_VERSION,
    id: rid,
    iss: cap(iss),
    iat: new Date(now).toISOString(),
    method: cap(String(method || "").toUpperCase()),
    path: cap(path),
    slug: cap(slug),
    requestSha256: String(requestSha256),
    responseSha256: String(responseSha256),
    priceUsd: price,
    rail: cap(rail),
    network: cap(network),
    payer: cap(payer),
    settlement: cap(settlement),
    replay: !!replay,
  };
}

/** Sign a record: the compact JWS. */
export function signReceipt(record, signer = receiptKeys().signer) {
  if (!signer) throw new Error("receipt signing is off");
  const head = b64u(JSON.stringify({ alg: "EdDSA", kid: signer.kid, typ: RECEIPT_TYP }));
  const body = b64u(JSON.stringify(record));
  const input = `${head}.${body}`;
  return `${input}.${b64u(edSign(null, Buffer.from(input), signer.privateKey))}`;
}

const VERIFY_KEY_CACHE = new Map();
function publicKeyOf(x) {
  let k = VERIFY_KEY_CACHE.get(x);
  if (!k) { k = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }); if (VERIFY_KEY_CACHE.size < 64) VERIFY_KEY_CACHE.set(x, k); }
  return k;
}

/**
 * Check a compact JWS against `keys` (the published list). Answers
 * { valid, reason, kid, record, checks }. With `responseBody` (string or
 * bytes) or `responseSha256`, the record's response digest must match; with
 * `request` ({ method, path, body }) the request digest must match.
 */
export function verifyReceipt(jws, { keys = receiptKeys().keys, responseBody, responseSha256, request } = {}) {
  const out = (valid, reason, extra = {}) => ({ valid, reason, ...extra });
  if (typeof jws !== "string" || jws.length > RECEIPT_MAX_BYTES * 2) return out(false, "not_a_receipt");
  const parts = jws.trim().split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return out(false, "not_a_compact_jws");
  let head, record;
  try { head = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); record = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return out(false, "unreadable"); }
  if (!head || head.alg !== "EdDSA" || head.typ !== RECEIPT_TYP || typeof head.kid !== "string") return out(false, "unexpected_header");
  if (!record || typeof record !== "object" || Array.isArray(record) || record.v !== RECEIPT_VERSION) return out(false, "unexpected_record", { kid: head.kid });
  const key = (keys || []).find((k) => k.kid === head.kid);
  if (!key) return out(false, "unknown_kid", { kid: head.kid, record });
  let sigOk = false;
  try { sigOk = edVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKeyOf(key.x), Buffer.from(parts[2], "base64url")); } catch { sigOk = false; }
  if (!sigOk) return out(false, "bad_signature", { kid: head.kid, record });
  const iat = Date.parse(record.iat);
  const inWindow = Number.isFinite(iat) && (!key.validFrom || iat >= Date.parse(key.validFrom)) && (!key.validUntil || iat < Date.parse(key.validUntil));
  const checks = { signature: true, keyValidAtIssue: inWindow };
  if (!inWindow) return out(false, "key_not_valid_at_issue", { kid: head.kid, record, checks });
  if (responseBody != null || responseSha256 != null) {
    const want = responseBody != null ? responseDigest(typeof responseBody === "string" ? Buffer.from(responseBody, "utf8") : Buffer.from(responseBody)) : String(responseSha256).toLowerCase();
    checks.response = want === record.responseSha256;
    if (!checks.response) return out(false, "response_mismatch", { kid: head.kid, record, checks });
  }
  if (request && typeof request === "object") {
    checks.request = requestDigest(request.method, request.path, request.body) === record.requestSha256;
    if (!checks.request) return out(false, "request_mismatch", { kid: head.kid, record, checks });
  }
  return out(true, null, { kid: head.kid, record, checks });
}

/**
 * The final server-sent comment line that carries a streamed answer's
 * receipt, after the last byte the receipt's digest covers. It opens with a
 * newline, so it ends a last line the stream left open (an empty line after
 * a finished event dispatches nothing), and it ends with a single newline:
 * a comment needs no blank line, and one would dispatch an event the stream
 * left open.
 */
export function receiptSseFrame(jws) { return `${SSE_FRAME_HEAD}${jws}\n`; }

/**
 * Split an event-stream answer as received into the bytes the receipt's
 * responseSha256 covers and the receipt itself: { body: Buffer, receipt }
 * (receipt null, body the whole input, when the stream does not end with
 * the receipt line).
 */
export function splitSseReceipt(streamed) {
  const buf = Buffer.isBuffer(streamed) ? streamed : typeof streamed === "string" ? Buffer.from(streamed, "utf8") : Buffer.from(streamed ?? []);
  const at = buf.lastIndexOf(SSE_FRAME_HEAD);
  if (at < 0) return { body: buf, receipt: null };
  const rest = buf.subarray(at + Buffer.byteLength(SSE_FRAME_HEAD)).toString("utf8");
  const m = /^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\n$/.exec(rest);
  if (!m) return { body: buf, receipt: null };
  return { body: buf.subarray(0, at), receipt: m[1] };
}

/**
 * A signed receipt for a report bought at card checkout, over the purchase
 * and its delivery: the checkout (method POST, path `/api/buy`, the product
 * and its input as the request), the delivered report's text as the answer,
 * the amount collected, the payment intent as the settlement. Null when
 * signing is off or the purchase carries no payment intent.
 */
export function createCheckoutReceipt({ iss = null, product, input, reportText, priceUsd, paymentIntent, deliveredAt = Date.now() }, signer = receiptKeys().signer) {
  if (!signer || typeof paymentIntent !== "string" || !paymentIntent) return null;
  const record = buildReceiptRecord({
    iss, method: "POST", path: CHECKOUT_RECEIPT_PATH, slug: product,
    requestSha256: requestDigest("POST", CHECKOUT_RECEIPT_PATH, { product, input }),
    responseSha256: responseDigest(Buffer.from(String(reportText ?? ""), "utf8")),
    priceUsd, rail: "card-checkout", network: null, payer: null, settlement: paymentIntent, replay: false,
    now: Number.isFinite(Date.parse(deliveredAt)) ? Date.parse(deliveredAt) : Number(deliveredAt) || Date.now(),
  });
  const jws = signReceipt(record, signer);
  return jws.length <= RECEIPT_MAX_BYTES ? jws : null;
}
/** The checkout route a card report receipt names. */
export const CHECKOUT_RECEIPT_PATH = "/api/buy";

/** The subscribe route a monitor subscription's receipt names, per rail. */
export const SUBSCRIPTION_RECEIPT_PATHS = Object.freeze({ "card-subscription": "/api/subscribe", "mpp-subscription": "/api/mpp/monitors/subscribe" });
/** Paid-period receipts kept on a subscription's record (the newest last). */
export const SUBSCRIPTION_RECEIPTS_KEPT = 3;

/**
 * The paid period a subscription receipt's answer digest covers: canonical
 * JSON, keys in a fixed order, built only from the period's own facts, so the
 * same period always reads the same bytes. The buyer is shown this text beside
 * the receipt and checks it at RECEIPT_VERIFY_PATH as the body.
 */
export function subscriptionPeriodStatement({ rail, subscription, product, target, period, settlement, priceUsd }) {
  const price = Number.isFinite(Number(priceUsd)) && priceUsd !== null && priceUsd !== "" ? String(Number(Number(priceUsd).toFixed(8))) : null;
  return JSON.stringify({
    kind: "monitor-subscription-period",
    rail: cap(rail), subscription: cap(subscription), product: cap(product), target: cap(target),
    period: period == null ? null : cap(period), settlement: cap(settlement), priceUsd: price,
  });
}

/**
 * A signed receipt for one paid period of a monitor subscription:
 * { receipt, statement, id, period, settlement, at }, or null when signing is
 * off, the rail is not a subscription rail, or the period names no final
 * payment (`settlement`: the paid invoice's id by card, the confirmed
 * transfer's hash on Tempo). The request digest covers the subscribe call
 * (product, target and subscription), the answer digest the period statement.
 */
export function createSubscriptionReceipt({ iss = null, rail, network = null, payer = null, subscription, product, target, period = null, settlement, priceUsd, paidAt = Date.now() }, signer = receiptKeys().signer) {
  const path = SUBSCRIPTION_RECEIPT_PATHS[rail];
  if (!signer || !path || typeof settlement !== "string" || !settlement || typeof subscription !== "string" || !subscription) return null;
  const statement = subscriptionPeriodStatement({ rail, subscription, product, target, period, settlement, priceUsd });
  const at = Number.isFinite(Date.parse(paidAt)) ? Date.parse(paidAt) : Number(paidAt) || Date.now();
  const record = buildReceiptRecord({
    iss, method: "POST", path, slug: product,
    requestSha256: requestDigest("POST", path, { product: product ?? null, target: target ?? null, subscription }),
    responseSha256: responseDigest(Buffer.from(statement, "utf8")),
    priceUsd, rail, network, payer, settlement, replay: false, now: at,
  });
  const receipt = signReceipt(record, signer);
  if (receipt.length > RECEIPT_MAX_BYTES) return null;
  return { receipt, statement, id: record.id, period: period == null ? null : String(period), settlement, at: record.iat };
}

/** A record's kept receipts with one more period's appended (same period: kept as it was). */
export function appendPeriodReceipt(list, entry, keep = SUBSCRIPTION_RECEIPTS_KEPT) {
  const prior = Array.isArray(list) ? list.filter((r) => r && typeof r.receipt === "string") : [];
  if (!entry || typeof entry.receipt !== "string") return prior;
  if (prior.some((r) => r.settlement === entry.settlement && r.period === entry.period)) return prior;
  return [...prior, entry].slice(-keep);
}

const bytesOf = (chunk, encoding) => (chunk == null ? Buffer.alloc(0)
  : Buffer.isBuffer(chunk) ? chunk
  : chunk instanceof Uint8Array ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  : Buffer.from(String(chunk), typeof encoding === "string" ? encoding : "utf8"));
const TE_TRAILERS_RE = /(?:^|,)\s*trailers\s*(?:;|,|$)/i;

/**
 * Middleware. Mount before every payment gate (beside answerHeadersGuard).
 * `describe(req, res)` answers the settlement fields of a final settled paid
 * answer ({ rail, network, payer, settlement, priceUsd, slug, replay }) or
 * null. `onSigned(jws, record, req, res)`, when given, is told of each
 * receipt as it is attached. Never throws into the response: a failure to
 * sign sends the answer without a receipt.
 */
export function receiptSignerMiddleware({ describe, iss = null, signer = () => receiptKeys().signer, onError = null, onSigned = null, onStreamed = null, fetchUrl = (key) => `${RECEIPT_FETCH_PATH}/${key}`, pendingRail = null } = {}) {
  return function receiptSignerMw(req, res, next) {
    if (!signer() || req.method === "HEAD" || req.method === "OPTIONS") return next();
    // The method the buyer sent, before the POST/GET alias (src/server.js)
    // rewrites it for the gate chain: the receipt names and digests the
    // request as sent.
    const sentMethod = req.method;
    // A client that asked for trailers on HTTP/1.1 can take the receipt as
    // one after a streamed answer's last byte.
    const wantsTrailer = TE_TRAILERS_RE.test(String(req.headers?.te || "")) && Number(req.httpVersionMajor) === 1 && Number(req.httpVersionMinor) >= 1;
    let wrote = false;
    let hash = null;
    let hashBroken = false;
    let trailerDeclared = false;
    let eventStream = false;
    // A one-piece answer: end() sends the head itself, and the receipt rides it.
    let oneShot = false;
    // The key a streamed answer's receipt is kept by, named in its head.
    let fetchKey = null;
    let lastRecord = null;
    const origWriteHead = res.writeHead;
    const origWrite = res.write;
    const origEnd = res.end;
    const recordFor = (bytesDigest) => {
      const s = signer();
      const d = s ? describe(req, res) : null;
      if (!d || !RESPONSE_RAILS.includes(d.rail)) return null;
      const url = String(req.originalUrl || req.url || "");
      const q = url.indexOf("?");
      const record = buildReceiptRecord({
        iss, method: sentMethod, path: req.path, slug: d.slug,
        requestSha256: requestDigest(sentMethod, `${req.path}${q >= 0 ? url.slice(q) : ""}`, req.body),
        responseSha256: bytesDigest,
        priceUsd: d.priceUsd, rail: d.rail, network: d.network, payer: d.payer, settlement: d.settlement, replay: d.replay,
      });
      const jws = signReceipt(record, s);
      if (jws.length > RECEIPT_MAX_BYTES) return null;
      lastRecord = record;
      // The issued receipt, for its keeper (src/server.js keeps it for the
      // wallet's audit report once the response finished 200). Never throws.
      if (onSigned) { try { onSigned(jws, record, req, res); } catch (e) { try { onError?.(e); } catch { /* never break the answer */ } } }
      return jws;
    };
    const contentTypeOf = (args) => {
      for (const a of args) {
        if (a && typeof a === "object" && !Array.isArray(a)) {
          for (const [k, v] of Object.entries(a)) if (String(k).toLowerCase() === "content-type") return String(v);
        }
      }
      return String(res.getHeader("Content-Type") ?? "");
    };
    res.writeHead = function receiptWriteHead(...args) {
      try {
        const status = typeof args[0] === "number" ? args[0] : res.statusCode;
        eventStream = /^text\/event-stream/i.test(contentTypeOf(args));
        // A trailer is declared only where Node sends the answer chunked: a
        // 200 with no length set, on a request that asked for trailers.
        const hasLength = res.hasHeader("Content-Length") || args.some((a) => a && typeof a === "object" && !Array.isArray(a) && Object.keys(a).some((k) => k.toLowerCase() === "content-length" || k.toLowerCase() === "transfer-encoding"));
        if (wantsTrailer && status === 200 && !hasLength && !res.hasHeader("Transfer-Encoding") && !res.headersSent) { res.setHeader("Trailer", RECEIPT_HEADER); trailerDeclared = true; }
        // A streamed paid answer names where its receipt will be kept: a
        // random token only this answer's head carries.
        if (onStreamed && !oneShot && status === 200 && !res.headersSent) {
          const d = describe(req, res);
          // A paid answer whose settlement is read only as it ends (a credits
          // debit lands before the last byte): `pendingRail` names its rail at
          // the head, and the address is a random token, as for a batched payment.
          let pending = null;
          if (!d && typeof pendingRail === "function") { try { pending = pendingRail(req, res); } catch { pending = null; } }
          if ((d && RESPONSE_RAILS.includes(d.rail)) || RESPONSE_RAILS.includes(pending)) {
            fetchKey = newReceiptFetchKey();
            res.setHeader(RECEIPT_URL_HEADER, fetchUrl(fetchKey));
          }
        }
      } catch (e) { try { onError?.(e); } catch { /* never break the answer */ } }
      try { return origWriteHead.apply(this, args); }
      catch (e) {
        // Never let the declaration break an answer: send it without one.
        if (!trailerDeclared || res.headersSent) throw e;
        trailerDeclared = false;
        res.removeHeader("Trailer");
        return origWriteHead.apply(this, args);
      }
    };
    res.write = function receiptWrite(chunk, encoding, cb) {
      try {
        if (!wrote) { wrote = true; hash = createHash("sha256"); }
        if (hash && chunk != null && typeof chunk !== "function") hash.update(bytesOf(chunk, encoding));
      } catch (e) { hash = null; hashBroken = true; try { onError?.(e); } catch { /* never break the answer */ } }
      return origWrite.apply(this, arguments);
    };
    res.end = function receiptEnd(chunk, encoding, cb) {
      if (typeof chunk === "function") { cb = chunk; chunk = undefined; encoding = undefined; }
      else if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
      try {
        if (!wrote && !res.headersSent) oneShot = true;
        if (!wrote && !res.headersSent && res.statusCode === 200) {
          const jws = recordFor(responseDigest(bytesOf(chunk, encoding)));
          if (jws) res.setHeader(RECEIPT_HEADER, jws);
        } else if ((wrote || res.headersSent) && !hashBroken && res.statusCode === 200 && (eventStream || trailerDeclared || onStreamed)) {
          // Every byte of the answer, written in parts or after its head.
          if (!hash) hash = createHash("sha256");
          if (chunk != null) hash.update(bytesOf(chunk, encoding));
          const jws = recordFor(hash.digest("hex"));
          hash = null;
          // Kept for GET RECEIPT_FETCH_PATH/<key>, under the token the head named.
          const keys = jws && fetchKey ? [fetchKey] : [];
          if (onStreamed) for (const key of keys) { try { onStreamed(key, jws, lastRecord, req, res); } catch (e) { try { onError?.(e); } catch { /* never break the answer */ } } }
          if (jws) {
            if (trailerDeclared) res.addTrailers({ [RECEIPT_HEADER]: jws });
            if (eventStream) {
              // The answer's last bytes, then the receipt line, then the end.
              if (chunk != null && bytesOf(chunk, encoding).length) origWrite.call(this, chunk, encoding);
              origWrite.call(this, receiptSseFrame(jws));
              return origEnd.call(this, cb);
            }
          }
        }
      } catch (e) { try { onError?.(e); } catch { /* never break the answer */ } }
      return origEnd.call(this, chunk, encoding, cb);
    };
    next();
  };
}
