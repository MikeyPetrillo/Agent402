// Native MPP on Tempo for the tollbooth - dependency-free (0.9.0).
//
// MPP's own native payment method is `tempo/charge`: a TIP-20 stablecoin
// transfer on Tempo (chain 4217), settled through Tempo's hosted relay
// (`POST /v1/mpp/validate` before the handler, `POST /v1/mpp/broadcast` only
// after a successful response). It is NOT EIP-3009, so it cannot ride an x402
// facilitator the way mpp.js translates the `evm` method - it needs its own
// gate, and that gate needs a Tempo API key with the `mpp:write` scope.
//
// Same posture as mpp.js: no mppx dependency. The challenge is minted with
// the same HMAC id binding mpp.js uses (so a stock mppx client pays it and
// mppx's Challenge.verify agrees on the id given the same secret), the
// request shape is byte-for-byte what mppx's tempo/charge schema emits (base
// units `amount` string, NO `decimals` on the wire, `methodDetails.chainId`,
// optional `methodDetails.splits` in base units - every one of those drifts
// bit the main app live in 2026-08), and the relay is spoken to over plain
// fetch with the wire mppx's own Relay.js uses ({challenge, payload}, header
// `tempo-api-key`, `idempotency-key` on broadcast, `{success:true}` /
// `{success:true, receipt}` on the way back).
//
// Split payments (`splits`): Tempo settles one transfer to up to 10 extra
// recipients atomically with the main one - a platform fee in the same
// transaction, which x402 cannot express. Each split amount must be > 0 and
// the splits must total strictly LESS than the price (the remainder is the
// operator's); validated at config time so a bad split never mints a
// challenge nobody can pay.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

const SCHEME = "Payment";
export const TEMPO_MAINNET_CHAIN_ID = 4217;
/** USDC.e on Tempo mainnet (138/141 registry sellers + mppx's mainnet default). */
export const TEMPO_USDC_E = "0x20C000000000000000000000b9537d11c60E8b50";
/** PathUSD - mppx's TESTNET default; accepted if the operator lists it. */
export const TEMPO_PATHUSD = "0x20c0000000000000000000000000000000000000";
const DEFAULT_API_BASE = "https://api.tempo.xyz";
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]+$/;

export const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
export const unb64url = (s) => Buffer.from(String(s), "base64url").toString("utf8");
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}
function challengeId(secretKey, c) {
  const input = [c.realm, c.method, c.intent, c.request, c.expires ?? "", c.digest ?? "", c.opaque ?? ""].join("|");
  return createHmac("sha256", Buffer.from(secretKey, "utf8")).update(input, "utf8").digest("base64url");
}
function idMatches(secretKey, c) {
  const a = Buffer.from(String(c.id || ""), "utf8");
  const b = Buffer.from(challengeId(secretKey, c), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
const authParam = (name, value) => {
  const v = String(value);
  if (/[\r\n]/.test(v)) throw new Error("invalid auth-param value");
  return `${name}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};

/** "$0.001" | 0.001 | "0.001" -> base-units BigInt at `decimals`. */
export function toBaseUnits(price, decimals = 6) {
  const s = String(price).trim().replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`tempo: price "${price}" is not a decimal amount`);
  const [int, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`tempo: price "${price}" has more than ${decimals} decimals`);
  return BigInt(int + frac.padEnd(decimals, "0"));
}

/** Normalise + validate the operator's tempo config once, at createTollbooth time. */
export function tempoConfig(cfg = {}) {
  const apiKey = String(cfg.apiKey || "").trim();
  const recipient = String(cfg.recipient || "").trim();
  if (!apiKey) throw new Error("tollbooth tempo: `apiKey` (Tempo API key with the mpp:write scope) is required");
  if (!HEX_ADDR.test(recipient)) throw new Error("tollbooth tempo: `recipient` must be a 0x EVM address (your Tempo payTo)");
  const decimals = Number.isInteger(cfg.decimals) ? cfg.decimals : 6;
  const currencies = (Array.isArray(cfg.currencies) ? cfg.currencies : [cfg.currency || TEMPO_USDC_E]).map((c) => String(c).trim()).filter(Boolean);
  if (!currencies.length || !currencies.every((c) => HEX_ADDR.test(c))) throw new Error("tollbooth tempo: `currency`/`currencies` must be TIP-20 token addresses (default USDC.e)");
  const chainId = Number.isInteger(cfg.chainId) ? cfg.chainId : TEMPO_MAINNET_CHAIN_ID;
  const timeoutSeconds = Number.isFinite(cfg.timeoutSeconds) && cfg.timeoutSeconds > 0 ? cfg.timeoutSeconds : 300;
  const splits = Array.isArray(cfg.splits) ? cfg.splits.map((s, i) => {
    if (!s || !HEX_ADDR.test(String(s.recipient || ""))) throw new Error(`tollbooth tempo: splits[${i}].recipient must be a 0x address`);
    const amount = toBaseUnits(s.amount, decimals);
    if (amount <= 0n) throw new Error(`tollbooth tempo: splits[${i}].amount must be > 0`);
    return { recipient: s.recipient, amount };
  }) : [];
  if (splits.length > 10) throw new Error("tollbooth tempo: at most 10 splits");
  return {
    apiKey, recipient, decimals, currencies, chainId, timeoutSeconds, splits,
    apiBaseUrl: String(cfg.apiBaseUrl || DEFAULT_API_BASE).replace(/\/$/, ""),
    description: cfg.description ? String(cfg.description).slice(0, 200) : undefined,
    fetch: cfg.fetch || globalThis.fetch,
    relay: cfg.relay || null, // { validate(input) -> {ok, error?}, broadcast(input, {idempotencyKey}) -> {ok, receipt?, error?} } (tests)
    relayTimeoutMs: Number.isFinite(cfg.relayTimeoutMs) ? cfg.relayTimeoutMs : 20_000,
    // Chain-truth confirm on broadcast failure (see confirmTempoSettlement):
    // `confirm: false` disables; `confirmRpcUrl` overrides the Tempo RPC;
    // `confirmSettlement` injects the whole check (tests).
    confirm: cfg.confirm !== false,
    confirmRpcUrl: String(cfg.confirmRpcUrl || process.env.TOLLBOOTH_TEMPO_RPC_URL || "https://rpc.tempo.xyz").replace(/\/$/, ""),
    confirmSettlement: typeof cfg.confirmSettlement === "function" ? cfg.confirmSettlement : null,
  };
}

/** Mint one tempo/charge challenge per currency. Returns the WWW-Authenticate
 *  value ("Payment id=..., ..." joined by ", ") or null when unpriceable. */
export function mintTempoChallenges({ price, realm, secretKey, tempo }) {
  let amount;
  try { amount = toBaseUnits(price, tempo.decimals); } catch { return null; }
  if (amount <= 0n) return null;
  const splitTotal = tempo.splits.reduce((a, s) => a + s.amount, 0n);
  if (tempo.splits.length && !(splitTotal < amount)) return null; // config-time check should have caught it; never mint an unpayable challenge
  const expires = new Date(Date.now() + tempo.timeoutSeconds * 1000).toISOString();
  const out = [];
  for (const currency of tempo.currencies) {
    const request = {
      amount: amount.toString(),
      currency,
      recipient: tempo.recipient,
      ...(tempo.description ? { description: tempo.description } : {}),
      methodDetails: {
        chainId: tempo.chainId,
        ...(tempo.splits.length ? { splits: tempo.splits.map((s) => ({ recipient: s.recipient, amount: s.amount.toString() })) } : {}),
      },
    };
    const c = { realm, method: "tempo", intent: "charge", request: b64url(canonicalJson(request)), expires };
    c.id = challengeId(secretKey, c);
    out.push([authParam("id", c.id), authParam("realm", c.realm), authParam("method", c.method), authParam("intent", c.intent), authParam("request", c.request), authParam("expires", c.expires)].join(", "));
  }
  return out.map((p) => `${SCHEME} ${p}`).join(", ");
}

/** Parse an Authorization: Payment credential; null unless it is a
 *  well-formed tempo/charge credential (no binding check here). */
export function parseTempoCredential(authorizationHeader) {
  if (typeof authorizationHeader !== "string") return null;
  const m = authorizationHeader.match(/^Payment\s+([A-Za-z0-9_-]+=*)\s*$/i);
  if (!m) return null;
  let wire;
  try { wire = JSON.parse(unb64url(m[1])); } catch { return null; }
  const ch = wire?.challenge;
  if (!ch || typeof ch !== "object" || ch.method !== "tempo" || (ch.intent || "charge") !== "charge") return null;
  if (typeof ch.request !== "string" || typeof ch.id !== "string") return null;
  const p = wire.payload;
  if (!p || typeof p !== "object") return null;
  if (p.type === "transaction" || p.type === "proof") { if (!HEX.test(String(p.signature || ""))) return null; }
  else if (p.type === "hash") { if (!HEX.test(String(p.hash || ""))) return null; }
  else return null;
  return { challenge: ch, payload: p, ...(wire.source ? { source: wire.source } : {}) };
}

/** Binding: is this a challenge WE minted, unexpired, for our recipient, in a
 *  currency we offer, on our chain, for at least this price? The relay checks
 *  the signed transaction against the challenge's OWN request - never that we
 *  minted it - so a forged 1-unit challenge would buy anything without this. */
export function checkTempoBinding(credential, { secretKey, realm, price, tempo, now = Date.now() }) {
  const bad = (reason) => ({ ok: false, reason });
  const ch = credential?.challenge;
  if (!ch) return bad("no challenge");
  if (!secretKey) return bad("no secret to verify the challenge binding");
  if (!idMatches(secretKey, ch)) return bad("challenge id does not HMAC-verify - not minted by this gate");
  if (realm && ch.realm !== realm) return bad("challenge realm is not ours");
  const exp = Date.parse(ch.expires);
  if (!Number.isFinite(exp) || exp <= now) return bad("challenge expired");
  let r;
  try { r = JSON.parse(unb64url(ch.request)); } catch { return bad("challenge request does not decode"); }
  if (!tempo.currencies.map((c) => c.toLowerCase()).includes(String(r.currency || "").toLowerCase())) return bad("challenge currency is not one this gate offers");
  if (String(r.recipient || "").toLowerCase() !== tempo.recipient.toLowerCase()) return bad("challenge recipient is not this gate's payTo");
  if (Number(r.methodDetails?.chainId) !== tempo.chainId) return bad("challenge chainId is not this gate's chain");
  let amount, expected;
  try { amount = BigInt(String(r.amount)); expected = toBaseUnits(price, tempo.decimals); } catch { return bad("challenge amount is not an integer base-units string"); }
  if (amount < expected) return bad(`challenge amount ${amount} is below this route's price ${expected}`);
  return { ok: true, amount };
}

// Buyer-facing relay failure: status + the relay's error CODE only. The
// relay's free-text `message` is an upstream body and goes to the operator
// log (console.warn at the call sites), never into the 402 problem document
// a buyer reads - a relay that echoes a key or account detail in an error
// must not hand it to every buyer. (Leak audit 2026-08-19.)
function relayFailure(res, body) {
  const code = body && typeof body === "object" && body.error && typeof body.error === "object" && typeof body.error.code === "string" ? body.error.code : null;
  return `relay HTTP ${res?.status ?? "?"}${code ? ` ${code.slice(0, 60)}` : ""}`;
}
function relayFailureDetail(res, body) {
  const msg = body && typeof body === "object" && body.error && typeof body.error.message === "string" ? body.error.message : "";
  return `${relayFailure(res, body)}${msg ? ` ${msg.slice(0, 160)}` : ""}`;
}

/** The relay client. Injectable `relay` (tests) takes precedence. */
export function tempoRelay(tempo) {
  if (tempo.relay) return tempo.relay;
  const post = async (path, input, headers = {}) => {
    let res;
    try {
      res = await tempo.fetch(`${tempo.apiBaseUrl}/v1/mpp/${path}`, {
        method: "POST",
        headers: { Accept: "application/json", "content-type": "application/json", "tempo-api-key": tempo.apiKey, ...headers },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(tempo.relayTimeoutMs),
      });
    } catch (e) {
      return { ok: false, error: `relay unreachable: ${String(e?.message || e).slice(0, 120)}` };
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok || !body || body.success !== true) return { ok: false, error: relayFailure(res, body), detail: relayFailureDetail(res, body), body };
    return { ok: true, body };
  };
  return {
    async validate(input) {
      const r = await post("validate", input);
      return r.ok ? { ok: true } : { ok: false, error: r.error, detail: r.detail || r.error };
    },
    async broadcast(input, { idempotencyKey }) {
      const r = await post("broadcast", input, { "idempotency-key": idempotencyKey });
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail || r.error };
      const receipt = r.body.receipt;
      if (!receipt || typeof receipt !== "object" || typeof receipt.reference !== "string" || receipt.method !== "tempo") return { ok: false, error: "relay broadcast answered success without a tempo receipt" };
      return { ok: true, receipt };
    },
  };
}

export function relayInput(credential) {
  // The relay's input is mppx's DESERIALIZED credential (Relay.js
  // toRelayInput): the challenge with `request` as the decoded object, not
  // the base64url string that rides on the wire. The first live proof
  // (run 32295980187, 2026-08-19) sent the wire string and the relay refused
  // every credential while the stub relay in the offline suite accepted
  // either - the suite now pins the decoded shape.
  const { request, ...challenge } = credential.challenge;
  let decoded = request;
  if (typeof request === "string") { try { decoded = JSON.parse(unb64url(request)); } catch { decoded = request; } }
  return { challenge: { ...challenge, request: decoded }, payload: credential.payload, ...(credential.source ? { source: credential.source } : {}) };
}
export function broadcastIdempotencyKey(input) {
  return `mpp_${createHash("sha256").update(canonicalJson(input), "utf8").digest("hex")}`;
}
/** Payment-Receipt header value (base64url JSON, as mppx's Receipt.serialize). */
export function tempoReceiptHeader(receipt) {
  return b64url(JSON.stringify({ method: "tempo", status: "success", reference: receipt.reference, timestamp: receipt.timestamp || new Date().toISOString(), ...(receipt.externalId ? { externalId: receipt.externalId } : {}) }));
}
/** RFC 9457 problem document for a refused tempo credential. */
export function tempoProblem(kind, detail) {
  const titles = { "invalid-challenge": "Invalid Challenge", "verification-failed": "Verification Failed", "malformed-credential": "Malformed Credential", "payment-insufficient": "Payment Insufficient" };
  return { type: `https://paymentauth.org/problems/${kind}`, title: titles[kind] || kind, status: 402, detail };
}

// ---------------------------------------------------------------------------
// Chain-truth confirm on broadcast failure (2026-08-20) — the relay's verdict
// and the chain's truth can diverge: a buyer whose packed signature ends with
// a yParity-style v byte (0x00/0x01) gets normalized to 27/28 by the Tempo
// node, so the canonical txid stops matching keccak(submitted bytes) and the
// relay's post-broadcast hash check reports `invalid_payment` for a payment
// that SETTLED (measured live: two double charges in one buy attempt).
// Before answering 402, ask the chain whether this credential's OWN
// transaction landed. The txid commits to the signed bytes, so the candidates
// are exact — the submitted form and its v-swapped twin — never a time-window
// or payer heuristic. Fails closed on every uncertainty. Dependency-free like
// the rest of this file: keccak-256 is implemented below (BigInt lanes — it
// runs at most once per FAILED broadcast, so speed is irrelevant) and pinned
// against standard vectors plus the live incident transaction in the tests.
// ---------------------------------------------------------------------------

const KECCAK_RC = [
  "0x0000000000000001", "0x0000000000008082", "0x800000000000808a", "0x8000000080008000",
  "0x000000000000808b", "0x0000000080000001", "0x8000000080008081", "0x8000000000008009",
  "0x000000000000008a", "0x0000000000000088", "0x0000000080008009", "0x000000008000000a",
  "0x000000008000808b", "0x800000000000008b", "0x8000000000008089", "0x8000000000008003",
  "0x8000000000008002", "0x8000000000000080", "0x000000000000800a", "0x800000008000000a",
  "0x8000000080008081", "0x8000000000008080", "0x0000000080000001", "0x8000000080008008",
].map(BigInt);
const KECCAK_RHO = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const U64 = (1n << 64n) - 1n;

function keccakF(A) {
  const rotl = (v, n) => n === 0n ? v : (((v << n) & U64) | (v >> (64n - n)));
  for (let round = 0; round < 24; round++) {
    const C = [0, 1, 2, 3, 4].map((x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
      for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D;
    }
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], BigInt(KECCAK_RHO[x + 5 * y]));
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ ((~B[((x + 1) % 5) + 5 * y] & U64) & B[((x + 2) % 5) + 5 * y]);
    A[0] ^= KECCAK_RC[round];
  }
}

/** keccak-256 of a Buffer, as a 0x hex string. Original Keccak padding
 *  (0x01 … 0x80), NOT SHA-3's 0x06 — Ethereum txids use the former. */
export function keccak256Hex(buf) {
  const rate = 136;
  const padded = Buffer.alloc(Math.ceil((buf.length + 1) / rate) * rate);
  buf.copy(padded);
  padded[buf.length] = 0x01;
  padded[padded.length - 1] |= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) A[i] ^= padded.readBigUInt64LE(off + i * 8);
    keccakF(A);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i], i * 8);
  return `0x${out.toString("hex")}`;
}

/** The txids this signed Tempo transaction could have landed under: the
 *  submitted bytes, plus (when the envelope verifiably ends with the 65-byte
 *  packed signature — RLP string header 0xb841 at the right offset) the
 *  v-swapped twin: yParity (0/1) <-> legacy (27/28). */
export function candidateTxIds(signedTx) {
  const hex = String(signedTx || "").toLowerCase();
  if (!/^0x76[0-9a-f]{2,}$/.test(hex) || hex.length % 2 !== 0) return [];
  const out = [keccak256Hex(Buffer.from(hex.slice(2), "hex"))];
  // b841 = RLP header for a 65-byte string; 134 hex chars = header + 65 bytes.
  const sigIsLast = hex.length >= 138 && hex.slice(-134, -130) === "b841";
  if (!sigIsLast) return out;
  const swap = { "00": "1b", "01": "1c", "1b": "00", "1c": "01" }[hex.slice(-2)];
  if (swap) out.push(keccak256Hex(Buffer.from(hex.slice(2, -2) + swap, "hex")));
  return out;
}

// TIP-20 TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)
const TRANSFER_WITH_MEMO_TOPIC = keccak256Hex(Buffer.from("TransferWithMemo(address,address,uint256,bytes32)"));
const MPP_TAG = keccak256Hex(Buffer.from("mpp")).slice(2, 10);

/** Is this bytes32 memo an MPP attribution memo bound to `challengeId`?
 *  Mirrors mppx tempo/Attribution.js verifyChallengeBinding: TAG, version
 *  0x01, and bytes 25..31 = keccak256(challengeId)[0..6]. */
export function memoBoundToChallenge(memo, challengeId) {
  const hex = String(memo || "").toLowerCase().replace(/^0x/, "");
  if (hex.length !== 64 || typeof challengeId !== "string" || !challengeId) return false;
  if (hex.slice(0, 8) !== MPP_TAG || hex.slice(8, 10) !== "01") return false;
  return hex.slice(50, 64) === keccak256Hex(Buffer.from(challengeId)).slice(2, 16);
}

/** Did this credential's transaction settle despite the relay's verdict?
 *  Returns { txId } when a candidate receipt exists, succeeded (status 0x1),
 *  and carries the challenge's transfer (currency + recipient + >= amount) as
 *  a TransferWithMemo whose MPP memo is bound to THIS challenge's id - else
 *  null. Polls briefly (a just-mined tx may not be indexed when the
 *  relay answers). Never throws. */
export async function confirmTempoSettlement(credential, { rpcUrl, fetchImpl = globalThis.fetch, attempts = 4, delayMs = 2000 } = {}) {
  try {
    const payload = credential?.payload;
    if (payload?.type !== "transaction" || typeof payload.signature !== "string") return null;
    let request = credential?.challenge?.request;
    if (typeof request === "string") { try { request = JSON.parse(unb64url(request)); } catch { return null; } }
    const currency = String(request?.currency || "").toLowerCase();
    const recipient = String(request?.recipient || "").toLowerCase();
    let minAmount;
    try { minAmount = BigInt(String(request?.amount)); } catch { return null; }
    if (!currency.startsWith("0x") || !recipient.startsWith("0x") || !(minAmount > 0n)) return null;
    const candidates = candidateTxIds(payload.signature);
    if (!candidates.length) return null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      for (const txId of candidates) {
        let receipt;
        try {
          const res = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txId] }) });
          if (!res.ok) continue;
          const body = await res.json();
          if (body.error) continue;
          receipt = body.result;
        } catch { continue; }
        if (!receipt || receipt.status !== "0x1") continue;
        for (const log of receipt.logs || []) {
          if (String(log.address || "").toLowerCase() !== currency) continue;
          if ((log.topics || [])[0] !== TRANSFER_WITH_MEMO_TOPIC) continue;
          if (`0x${String(log.topics[2] || "").slice(-40)}`.toLowerCase() !== recipient) continue;
          if (!memoBoundToChallenge(log.topics[3], credential?.challenge?.id)) continue;
          let value;
          try { value = BigInt(log.data); } catch { continue; }
          if (value >= minAmount) return { txId };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
