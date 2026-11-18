// verifyReceipt(): check an Agent402-Receipt header (a compact JWS, EdDSA
// over Ed25519) against the server's published keys, offline once the keys
// are in hand. Optional: the client never calls it on its own.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

export const RECEIPT_HEADER = "Agent402-Receipt";
export const RECEIPT_KEYS_PATH = "/.well-known/agent402-receipt-key.json";
const TYP = "agent402-receipt+jws";

/** sha256 hex of "<METHOD> <path>[?query]\n" + JSON.stringify(body) (no body: "-"). */
export function receiptRequestDigest(method, pathWithQuery, body) {
  const h = createHash("sha256").update(`${String(method || "").toUpperCase()} ${String(pathWithQuery || "")}\n`);
  if (body instanceof Uint8Array) h.update(body);
  else if (body && typeof body === "object" && Object.keys(body).length) h.update(JSON.stringify(body));
  else if (typeof body === "string" && body) h.update(body);
  else h.update("-");
  return h.digest("hex");
}

/**
 * @param {string} receipt  the Agent402-Receipt header value
 * @param {object} [opts]
 * @param {Array}  [opts.keys]      the `keys` of the published key document
 * @param {string} [opts.baseUrl]   fetch the key document from here when `keys` is absent
 * @param {Function} [opts.fetchImpl]
 * @param {string|Uint8Array} [opts.body]  the answer bytes, checked against responseSha256
 * @param {{method:string,path:string,body?:any}} [opts.request]  checked against requestSha256
 * @returns {Promise<{valid:boolean, reason:string|null, kid?:string, record?:object}>}
 */
export async function verifyReceipt(receipt, { keys = null, baseUrl = "https://agent402.tools", fetchImpl = globalThis.fetch, body, request } = {}) {
  const no = (reason, extra = {}) => ({ valid: false, reason, ...extra });
  if (typeof receipt !== "string") return no("not_a_receipt");
  const parts = receipt.trim().split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return no("not_a_compact_jws");
  let head, record;
  try { head = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); record = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return no("unreadable"); }
  if (!head || head.alg !== "EdDSA" || head.typ !== TYP || typeof head.kid !== "string") return no("unexpected_header");
  if (!keys) {
    let base = String(baseUrl);
    while (base.endsWith("/")) base = base.slice(0, -1);
    const r = await fetchImpl(`${base}${RECEIPT_KEYS_PATH}`);
    if (!r.ok) return no("keys_unavailable", { kid: head.kid, record });
    keys = (await r.json())?.keys || [];
  }
  const key = keys.find((k) => k && k.kid === head.kid && (k.crv == null || k.crv === "Ed25519") && typeof k.x === "string");
  if (!key) return no("unknown_kid", { kid: head.kid, record });
  let ok = false;
  try { ok = edVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" }), Buffer.from(parts[2], "base64url")); } catch { ok = false; }
  if (!ok) return no("bad_signature", { kid: head.kid, record });
  const iat = Date.parse(record?.iat);
  if (!Number.isFinite(iat) || (key.validFrom && iat < Date.parse(key.validFrom)) || (key.validUntil && iat >= Date.parse(key.validUntil))) return no("key_not_valid_at_issue", { kid: head.kid, record });
  if (body != null) {
    const digest = createHash("sha256").update(typeof body === "string" ? Buffer.from(body, "utf8") : body).digest("hex");
    if (digest !== record.responseSha256) return no("response_mismatch", { kid: head.kid, record });
  }
  if (request && receiptRequestDigest(request.method, request.path, request.body) !== record.requestSha256) return no("request_mismatch", { kid: head.kid, record });
  return { valid: true, reason: null, kid: head.kid, record };
}

/** The server-sent event that carries a streamed answer's receipt. */
export const RECEIPT_SSE_EVENT = "agent402-receipt";
const SSE_FRAME_HEAD = `\nevent: ${RECEIPT_SSE_EVENT}\ndata: `;

/**
 * Split a streamed (text/event-stream) answer, as received, into the bytes
 * its receipt covers and the receipt: the server ends a settled stream with
 * "\nevent: agent402-receipt\ndata: <receipt>\n\n" after the last byte the
 * receipt's responseSha256 digests.
 * @param {string|Uint8Array} streamed  every byte of the answer, in order
 * @returns {{ body: Uint8Array, receipt: string|null }}
 */
export function splitStreamedReceipt(streamed) {
  const buf = typeof streamed === "string" ? Buffer.from(streamed, "utf8") : Buffer.from(streamed ?? []);
  const at = buf.lastIndexOf(SSE_FRAME_HEAD);
  if (at < 0) return { body: buf, receipt: null };
  const m = /^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\n\n$/.exec(buf.subarray(at + Buffer.byteLength(SSE_FRAME_HEAD)).toString("utf8"));
  return m ? { body: buf.subarray(0, at), receipt: m[1] } : { body: buf, receipt: null };
}

/**
 * Check the receipt that ends a streamed answer against the bytes streamed
 * before it. Same options as verifyReceipt (keys, baseUrl, request).
 * @returns {Promise<{valid:boolean, reason:string|null, kid?:string, record?:object}>}
 */
export async function verifyStreamedReceipt(streamed, opts = {}) {
  const { body, receipt } = splitStreamedReceipt(streamed);
  if (!receipt) return { valid: false, reason: "no_receipt_event" };
  return verifyReceipt(receipt, { ...opts, body });
}
