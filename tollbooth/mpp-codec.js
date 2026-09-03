// MPP wire codec shared by the Node build (mpp.js, HMAC via node:crypto) and
// the edge build (edge-mpp.js, HMAC via Web Crypto). Runtime-agnostic on
// purpose: no node:* imports, no Buffer - only TextEncoder/TextDecoder,
// btoa/atob, which every Fetch-API runtime (Workers, Next.js edge, Deno, Bun,
// Node 20+) provides. Nothing in here signs or verifies; the two builds own
// that, so this file cannot mint a challenge on its own.
//
// Wire (tempoxyz/mpp, paymentauth.org):
//   challenge   WWW-Authenticate: Payment id="...", realm="...", method="evm",
//               intent="charge", request="<b64url JCS>", expires="...", opaque="<b64url JCS>"
//   credential  Authorization: Payment <b64url JSON{challenge, payload, source?}>
//   receipt     Payment-Receipt: <b64url JSON{method, status, reference, timestamp}>
export const SCHEME = "Payment";
export const META_ACCEPTS_KEY = "x402";
export const STABLECOIN_DECIMALS = 6; // Circle USDC + Paxos USDG on every EVM rail
// What a stock mppx client can auto-sign (its built-in asset registry covers
// Base + Celo mainnets); every extra challenge costs ~800 bytes on every 402.
export const DEFAULT_MPP_CHAIN_IDS = [8453, 42220];

const te = new TextEncoder();
const td = new TextDecoder();
function bytesToBinary(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}
const binaryToBytes = (bin) => Uint8Array.from(bin, (c) => c.charCodeAt(0));
/** utf8 string -> standard base64 */
export const b64std = (s) => btoa(bytesToBinary(te.encode(String(s))));
/** standard base64 -> utf8 string (throws on junk) */
export const unb64std = (s) => td.decode(binaryToBytes(atob(String(s).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, ""))));
/** utf8 string -> base64url (no padding) */
export const b64url = (s) => b64std(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** base64url -> utf8 string (padding optional; throws on junk) */
export function unb64url(s) {
  let v = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (v.length % 4) v += "=";
  return td.decode(binaryToBytes(atob(v)));
}
/** bytes -> base64url, for HMAC digests */
export const bytesToB64url = (bytes) => btoa(bytesToBinary(new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** RFC 8785-style canonical JSON (sorted object keys, no whitespace) - what the
 *  reference implementation uses for the `request`/`opaque` slots. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}
export const encodeRequest = (obj) => b64url(canonicalJson(obj));

/** Positional id-binding input - the same slot layout the reference
 *  implementation HMACs, so its Challenge.verify() agrees with ours given the
 *  same secret. The builds sign this string. */
export const challengeIdInput = (c) =>
  [c.realm, c.method, c.intent, c.request, c.expires ?? "", c.digest ?? "", c.opaque ?? ""].join("|");

export const authParam = (name, value) => {
  const v = String(value);
  if (/[\r\n]/.test(v)) throw new Error("invalid auth-param value");
  return `${name}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};

/** One serialized challenge (the caller has already set `c.id`). */
export function serializeChallenge(c) {
  return `${SCHEME} ` + [
    authParam("id", c.id), authParam("realm", c.realm), authParam("method", c.method), authParam("intent", c.intent),
    authParam("request", c.request), authParam("expires", c.expires), authParam("opaque", c.opaque),
  ].join(", ");
}

/** The evm/charge request slot for one x402-shaped accept. */
export function chargeRequestFor({ amount, asset, chainId }) {
  return encodeRequest({
    amount: String(amount),
    currency: asset,
    // `recipient` is filled by the caller's accept; kept explicit there.
    methodDetails: { chainId, credentialTypes: ["authorization"], decimals: STABLECOIN_DECIMALS },
  });
}

/** True when the header looks like an MPP credential (scheme check only). */
export function isMppCredential(authorizationHeader) {
  return typeof authorizationHeader === "string" && /^Payment\s+\S/i.test(authorizationHeader);
}

/** Decode `Authorization: Payment <b64url JSON>` to its wire object, or null. */
export function decodeCredentialHeader(authorizationHeader) {
  if (typeof authorizationHeader !== "string") return null;
  const m = authorizationHeader.match(/^Payment\s+([A-Za-z0-9_-]+=*)\s*$/i);
  if (!m) return null;
  try { return JSON.parse(unb64url(m[1])); } catch { return null; }
}

/** Shape-check an evm/charge challenge object from a credential (no HMAC here). */
export function challengeShapeOk(ch) {
  return !!ch && typeof ch === "object" && ch.method === "evm" && ch.intent === "charge"
    && typeof ch.request === "string" && typeof ch.opaque === "string" && typeof ch.id === "string";
}

/** The meta object bound into the challenge's opaque slot, or null. */
export function metaFromChallenge(ch) {
  try {
    const meta = JSON.parse(unb64url(ch.opaque));
    return meta && typeof meta === "object" ? meta : null;
  } catch { return null; }
}

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_SIG = /^0x[0-9a-fA-F]+$/;
const UINT = /^\d+$/;
/** Validate an `authorization` payload; returns {authorization, signature} or null. */
export function authorizationFromPayload(p) {
  if (!p || p.type !== "authorization") return null;
  const { from, to, value, validAfter, validBefore, nonce, signature } = p;
  if (!HEX_ADDR.test(String(from)) || !HEX_ADDR.test(String(to)) || !HEX_32.test(String(nonce)) || !HEX_SIG.test(String(signature))) return null;
  if (!UINT.test(String(value)) || !UINT.test(String(validAfter)) || !UINT.test(String(validBefore))) return null;
  return { authorization: { from, to, value: String(value), validAfter: String(validAfter), validBefore: String(validBefore), nonce }, signature };
}

/** x402 v2 PAYMENT-SIGNATURE value (standard base64 JSON) for an accept + authorization. */
export function paymentSignatureFor(accepted, { authorization, signature }) {
  return b64std(JSON.stringify({ x402Version: 2, accepted, payload: { authorization, signature } }));
}

/** MPP Payment-Receipt value for a settled transaction reference. */
export function receiptFor(transaction) {
  return b64url(JSON.stringify({ method: "evm", status: "success", reference: transaction, timestamp: new Date().toISOString() }));
}

/** Decode a settled x402 PAYMENT-RESPONSE header to its transaction, or null. */
export function transactionFromPaymentResponse(paymentResponseHeader) {
  let settle;
  try { settle = JSON.parse(unb64std(paymentResponseHeader)); } catch { return null; }
  if (!settle || settle.success !== true || typeof settle.transaction !== "string") return null;
  return settle.transaction;
}
