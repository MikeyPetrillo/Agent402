// Signed receipts: a receipt this server signs over each paid answer it
// served after the payment settled.
//
// Off unless RECEIPT_SIGNING_KEY is set. With it, every final 200 whose
// payment settled (x402 on every network, the MPP evm wire, Tempo, the card
// wire) carries an `Agent402-Receipt` header: a compact JWS (RFC 7515),
// EdDSA over Ed25519, whose payload is the canonical record below. The
// public keys are published at RECEIPT_KEYS_PATH, and POST
// RECEIPT_VERIFY_PATH checks a receipt against them (free, no egress).
//
// Where it is signed: receiptSignerMiddleware() wraps res.write/res.end and
// is mounted before every payment gate, so each gate's buffered answer is
// replayed through it AFTER the gate settled (the x402 middleware, the Tempo
// broadcast and the card capture all settle before they replay the buffered
// body). It signs only when the body is about to leave in one end() call
// with the head not yet written, the final status is 200, and `describe`
// (src/server.js) reads settlement evidence on the response: a decoded
// PAYMENT-RESPONSE with success true, or the Tempo/card gate's own settled
// mark. A 4xx/5xx, a failed settle (402), a free or trial answer, a credits
// call and a streamed answer carry no receipt.
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
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, randomUUID } from "node:crypto";
import { gateMounted } from "./gate-mounts.js";

export const RECEIPT_HEADER = "Agent402-Receipt";
export const RECEIPT_KEYS_PATH = "/.well-known/agent402-receipt-key.json";
export const RECEIPT_VERIFY_PATH = "/api/receipts/verify";
export const RECEIPT_TYP = "agent402-receipt+jws";
export const RECEIPT_VERSION = 1;
/** The rail kinds a receipt is signed on (conformance rows read this). */
export const SIGNED_RAILS = Object.freeze(["x402", "gateway-batched", "mpp-evm", "mpp-tempo", "mpp-stripe"]);
/** Upper bound on the header value: every string field is capped below. */
export const RECEIPT_MAX_BYTES = 2048;
const FIELD_MAX = 160;

const KID_RE = /^[A-Za-z0-9._-]{1,32}$/;
const PEM_HEAD = "-----BEGIN PRIVATE KEY-----";

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
  const kid = typeof env.RECEIPT_SIGNING_KEY_ID === "string" ? env.RECEIPT_SIGNING_KEY_ID.trim() : "";
  try {
    if (!KID_RE.test(kid)) throw new Error("RECEIPT_SIGNING_KEY_ID is missing or not 1-32 of A-Z a-z 0-9 . _ -");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error("RECEIPT_SIGNING_KEY is not one line of base64");
    const pem = Buffer.from(raw, "base64").toString("utf8").trim();
    if (!pem.startsWith(PEM_HEAD) || !pem.includes("-----END PRIVATE KEY-----")) throw new Error("RECEIPT_SIGNING_KEY does not decode to a PKCS8 PEM private key");
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
 * Middleware. Mount before every payment gate (beside answerHeadersGuard).
 * `describe(req, res)` answers the settlement fields of a final settled paid
 * answer ({ rail, network, payer, settlement, priceUsd, slug, replay }) or
 * null. Never throws into the response: a failure to sign sends the answer
 * without a receipt.
 */
export function receiptSignerMiddleware({ describe, iss = null, signer = () => receiptKeys().signer, onError = null } = {}) {
  return function receiptSignerMw(req, res, next) {
    if (!signer() || req.method === "HEAD" || req.method === "OPTIONS") return next();
    let wrote = false;
    const origWrite = res.write;
    const origEnd = res.end;
    res.write = function receiptWrite(...args) { wrote = true; return origWrite.apply(this, args); };
    res.end = function receiptEnd(chunk, encoding, cb) {
      try {
        if (!wrote && !res.headersSent && res.statusCode === 200 && typeof chunk !== "function") {
          const s = signer();
          const d = s ? describe(req, res) : null;
          if (d && SIGNED_RAILS.includes(d.rail)) {
            const bytes = chunk == null ? Buffer.alloc(0) : Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk), typeof encoding === "string" ? encoding : "utf8");
            const url = String(req.originalUrl || req.url || "");
            const q = url.indexOf("?");
            const record = buildReceiptRecord({
              iss, method: req.method, path: req.path, slug: d.slug,
              requestSha256: requestDigest(req.method, `${req.path}${q >= 0 ? url.slice(q) : ""}`, req.body),
              responseSha256: responseDigest(bytes),
              priceUsd: d.priceUsd, rail: d.rail, network: d.network, payer: d.payer, settlement: d.settlement, replay: d.replay,
            });
            const jws = signReceipt(record, s);
            if (jws.length <= RECEIPT_MAX_BYTES) res.setHeader(RECEIPT_HEADER, jws);
          }
        }
      } catch (e) { try { onError?.(e); } catch { /* never break the answer */ } }
      return origEnd.call(this, chunk, encoding, cb);
    };
    next();
  };
}
