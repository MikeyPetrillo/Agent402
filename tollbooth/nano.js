// MPP `nano/charge` for the tollbooth - dependency-free, verification only.
//
// Nano (XNO) is a feeless block-lattice: the buyer publishes a `send` block
// from its own account, waits for it to confirm, and presents the block hash
// as the credential. There is nothing for the gate to sign, broadcast or
// settle: it reads the block from a Nano node (RPC `block_info`) and checks it.
// Wire per draft-nano-charge-00 (tempoxyz/mpp-specs#377):
//
//   challenge   method="nano", intent="charge", request = b64url JCS of
//               { amount (raw, decimal string), currency: "XNO", recipient,
//                 methodDetails: { network: "nano:mainnet", binding: "amount" } }
//   credential  Authorization: Payment <b64url JSON{challenge, payload:{type:"hash", hash}}>
//   receipt     Payment-Receipt: <b64url JSON{method:"nano", reference: HASH, status, timestamp}>
//
// A Nano block has no memo, so the challenge is bound to a payment by its
// AMOUNT: each challenge asks for the price plus a random suffix of up to
// 10^24 raw (below 0.000001 XNO) and only a send of exactly that amount to
// the recipient answers it (the spec's binding="amount" mode). The amount
// rides inside the HMAC-bound request, so a buyer cannot pick its own. The
// per-challenge-address mode needs a seed to derive accounts, and this file
// holds no keys.
//
// Same HMAC challenge id as mpp.js and tempo.js (mppx's positional layout).
// BLAKE2b (RFC 7693) is implemented below for the address checksum only.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { b64url, unb64url, canonicalJson, challengeIdInput, authParam } from "./mpp-codec.js";

const SCHEME = "Payment";
export const NANO_MAINNET = "nano:mainnet";
/** Upper bound (exclusive) of the per-challenge amount suffix, in raw. */
export const NANO_SUFFIX_SPACE = 10n ** 24n;
const ALPHABET = "13456789abcdefghijkmnopqrstuwxyz";
const ADDRESS = /^(?:nano|xrb)_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/;
const HASH64 = /^[0-9A-Fa-f]{64}$/;
const RAW = /^[1-9][0-9]*$/;

// ---- BLAKE2b (RFC 7693), BigInt lanes; runs on a 32-byte input per call ----
const U64 = (1n << 64n) - 1n;
const B2B_IV = [
  "0x6a09e667f3bcc908", "0xbb67ae8584caa73b", "0x3c6ef372fe94f82b", "0xa54ff53a5f1d36f1",
  "0x510e527fade682d1", "0x9b05688c2b3e6c1f", "0x1f83d9abfb41bd6b", "0x5be0cd19137e2179",
].map(BigInt);
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr = (v, n) => ((v >> n) | (v << (64n - n))) & U64;

function b2bCompress(h, block, t, last) {
  const m = Array.from({ length: 16 }, (_, i) => block.readBigUInt64LE(i * 8));
  const v = [...h, ...B2B_IV];
  v[12] ^= t & U64;
  v[13] ^= t >> 64n;
  if (last) v[14] ^= U64;
  const G = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) & U64; v[d] = rotr(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & U64; v[b] = rotr(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & U64; v[d] = rotr(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & U64; v[b] = rotr(v[b] ^ v[c], 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    G(0, 4, 8, 12, m[s[0]], m[s[1]]); G(1, 5, 9, 13, m[s[2]], m[s[3]]);
    G(2, 6, 10, 14, m[s[4]], m[s[5]]); G(3, 7, 11, 15, m[s[6]], m[s[7]]);
    G(0, 5, 10, 15, m[s[8]], m[s[9]]); G(1, 6, 11, 12, m[s[10]], m[s[11]]);
    G(2, 7, 8, 13, m[s[12]], m[s[13]]); G(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

/** Unkeyed BLAKE2b of `buf` with an `outlen`-byte digest (1..64). */
export function blake2b(buf, outlen = 64) {
  const h = [...B2B_IV];
  h[0] ^= 0x01010000n ^ BigInt(outlen);
  const blocks = Math.max(1, Math.ceil(buf.length / 128));
  for (let i = 0; i < blocks; i++) {
    const block = Buffer.alloc(128);
    buf.copy(block, 0, i * 128, Math.min(buf.length, (i + 1) * 128));
    const last = i === blocks - 1;
    b2bCompress(h, block, BigInt(last ? buf.length : (i + 1) * 128), last);
  }
  const out = Buffer.alloc(64);
  h.forEach((w, i) => out.writeBigUInt64LE(w, i * 8));
  return out.subarray(0, outlen);
}

// ---- addresses ----
/** `nano_`/`xrb_` address -> 32-byte public key as uppercase hex, or null
 *  when the format or the BLAKE2b checksum is wrong. */
export function nanoAddressToPublicKey(address) {
  const s = String(address || "");
  if (!ADDRESS.test(s)) return null;
  let v = 0n;
  for (const ch of s.slice(s.indexOf("_") + 1)) v = (v << 5n) | BigInt(ALPHABET.indexOf(ch));
  const key = Buffer.from(((v >> 40n) & ((1n << 256n) - 1n)).toString(16).padStart(64, "0"), "hex");
  const checksum = (v & ((1n << 40n) - 1n)).toString(16).padStart(10, "0");
  const expected = Buffer.from(blake2b(key, 5)).reverse().toString("hex");
  return checksum === expected ? key.toString("hex").toUpperCase() : null;
}

/** Normalise + validate the operator's nano config once, at createTollbooth time. */
export function nanoConfig(cfg = {}) {
  const recipient = String(cfg.recipient || "").trim();
  const recipientKey = nanoAddressToPublicKey(recipient);
  if (!recipientKey || !recipient.startsWith("nano_")) throw new Error("tollbooth nano: `recipient` must be a nano_ address with a valid checksum");
  const priceRaw = String(cfg.priceRaw ?? "").trim();
  if (!RAW.test(priceRaw)) throw new Error("tollbooth nano: `priceRaw` must be a positive integer amount of raw (1 XNO = 10^30 raw)");
  const rpcUrl = String(cfg.rpcUrl || "").trim();
  if (!/^https?:\/\//i.test(rpcUrl)) throw new Error("tollbooth nano: `rpcUrl` (a Nano node RPC you trust, ideally your own) is required");
  return {
    recipient, recipientKey, priceRaw: BigInt(priceRaw), rpcUrl,
    network: String(cfg.network || NANO_MAINNET),
    timeoutSeconds: Number.isFinite(cfg.timeoutSeconds) && cfg.timeoutSeconds > 0 ? cfg.timeoutSeconds : 300,
    rpcTimeoutMs: Number.isFinite(cfg.rpcTimeoutMs) ? cfg.rpcTimeoutMs : 10_000,
    description: cfg.description ? String(cfg.description).slice(0, 200) : undefined,
    fetch: cfg.fetch || globalThis.fetch,
  };
}

function challengeId(secretKey, c) {
  return createHmac("sha256", Buffer.from(secretKey, "utf8")).update(challengeIdInput(c), "utf8").digest("base64url");
}
function idMatches(secretKey, c) {
  const a = Buffer.from(String(c.id || ""), "utf8");
  const b = Buffer.from(challengeId(secretKey, c), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Mint one nano/charge challenge; returns the WWW-Authenticate value. The
 *  amount is the price plus a fresh random suffix below NANO_SUFFIX_SPACE. */
export function mintNanoChallenge({ realm, secretKey, nano, suffix }) {
  const s = suffix ?? (BigInt(`0x${randomBytes(10).toString("hex")}`) % (NANO_SUFFIX_SPACE - 1n)) + 1n;
  const request = {
    amount: (nano.priceRaw + s).toString(),
    currency: "XNO",
    recipient: nano.recipient,
    ...(nano.description ? { description: nano.description } : {}),
    methodDetails: { network: nano.network, binding: "amount" },
  };
  const c = { realm, method: "nano", intent: "charge", request: b64url(canonicalJson(request)), expires: new Date(Date.now() + nano.timeoutSeconds * 1000).toISOString() };
  c.id = challengeId(secretKey, c);
  return `${SCHEME} ${[authParam("id", c.id), authParam("realm", c.realm), authParam("method", c.method), authParam("intent", c.intent), authParam("request", c.request), authParam("expires", c.expires)].join(", ")}`;
}

/** Parse an Authorization: Payment credential; null unless its challenge is
 *  nano/charge. The hash is NOT checked here (a bad one is a
 *  malformed-credential answer, not someone else's credential). */
export function parseNanoCredential(authorizationHeader) {
  if (typeof authorizationHeader !== "string") return null;
  const m = authorizationHeader.match(/^Payment\s+([A-Za-z0-9_-]+=*)\s*$/i);
  if (!m) return null;
  let wire;
  try { wire = JSON.parse(unb64url(m[1])); } catch { return null; }
  const ch = wire?.challenge;
  if (!ch || typeof ch !== "object" || ch.method !== "nano" || (ch.intent || "charge") !== "charge") return null;
  const p = wire.payload && typeof wire.payload === "object" ? wire.payload : {};
  const hash = p.type === "hash" && HASH64.test(String(p.hash || "")) ? String(p.hash).toUpperCase() : null;
  return { challenge: ch, blockHash: hash };
}

/** Local checks: a challenge WE minted, unexpired, for our recipient and
 *  network, whose amount is this route's price plus a suffix. */
export function checkNanoBinding(credential, { secretKey, realm, nano, now = Date.now() }) {
  const bad = (reason) => ({ ok: false, reason });
  const ch = credential?.challenge;
  if (!ch || typeof ch.id !== "string" || typeof ch.request !== "string") return bad("no challenge");
  if (!secretKey || !idMatches(secretKey, ch)) return bad("challenge id does not HMAC-verify - not minted by this gate");
  if (realm && ch.realm !== realm) return bad("challenge realm is not ours");
  const exp = Date.parse(ch.expires);
  if (!Number.isFinite(exp) || exp <= now) return bad("challenge expired");
  let r;
  try { r = JSON.parse(unb64url(ch.request)); } catch { return bad("challenge request does not decode"); }
  if (r.currency !== "XNO" || nanoAddressToPublicKey(r.recipient) !== nano.recipientKey) return bad("challenge recipient is not this gate's");
  if (r.methodDetails?.network !== nano.network || r.methodDetails?.binding !== "amount") return bad("challenge network or binding is not this gate's");
  if (!RAW.test(String(r.amount))) return bad("challenge amount is not a raw integer");
  const amount = BigInt(r.amount);
  if (amount < nano.priceRaw || amount >= nano.priceRaw + NANO_SUFFIX_SPACE) return bad("challenge amount is not this route's price");
  return { ok: true, amount, expiresAtMs: exp };
}

/** Ask the node about `blockHash` and check it pays exactly `amount` raw to
 *  the recipient in a confirmed send. Never throws; never moves funds.
 *  Returns { ok: true } or { ok: false, kind, reason, retry? }. */
export async function verifyNanoPayment(blockHash, { amount, nano }) {
  const fail = (kind, reason, retry = false) => ({ ok: false, kind, reason, retry });
  let body;
  try {
    const res = await nano.fetch(nano.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "block_info", json_block: "true", hash: blockHash }),
      signal: AbortSignal.timeout(nano.rpcTimeoutMs),
    });
    if (!res.ok) return fail("verification-failed", `node answered HTTP ${res.status}`, true);
    body = await res.json();
  } catch {
    return fail("verification-failed", "node unreachable", true);
  }
  if (!body || typeof body !== "object" || body.error) return fail("verification-failed", "block not found", true);
  const c = body.contents || {};
  if (c.type !== "state" || body.subtype !== "send") return fail("verification-failed", "block is not a send");
  const linkKey = HASH64.test(String(c.link || "")) ? String(c.link).toUpperCase() : nanoAddressToPublicKey(c.link_as_account);
  if (linkKey !== nano.recipientKey) return fail("verification-failed", "block does not pay this gate's recipient");
  if (!/^[0-9]+$/.test(String(body.amount))) return fail("verification-failed", "block amount is not a raw integer");
  const sent = BigInt(String(body.amount));
  if (sent < amount) return fail("payment-insufficient", `block sent ${sent} raw, challenge asks ${amount}`);
  if (sent !== amount) return fail("verification-failed", `block sent ${sent} raw, challenge asks exactly ${amount}`);
  if (body.confirmed !== "true" && body.confirmed !== true) return fail("verification-failed", "block is not confirmed yet", true);
  return { ok: true };
}

/** Payment-Receipt header value (base64url JSON). */
export function nanoReceiptHeader(blockHash) {
  return b64url(JSON.stringify({ method: "nano", reference: blockHash, status: "success", timestamp: new Date().toISOString() }));
}
/** RFC 9457 problem document for a refused nano credential. */
export function nanoProblem(kind, detail) {
  const titles = { "invalid-challenge": "Invalid Challenge", "verification-failed": "Verification Failed", "malformed-credential": "Malformed Credential", "payment-insufficient": "Payment Insufficient" };
  return { type: `https://paymentauth.org/problems/${kind}`, title: titles[kind] || kind, status: 402, detail };
}
