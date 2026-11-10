// Whose answer is this? The payer scope of the gateway response cache.
//
// The gateway cache (embeddings, rerank, opted-in chat; src/tools/
// llm-gateway-kit.js) answers a byte-identical repeat of an already-paid call
// BEFORE the paywall, free. Keyed on the request body alone it was shared by
// every buyer, and the read asked only that the request carry something that
// DECODES as a payment (src/payment-attempt.js reads shape, never a
// signature). So anyone who could reproduce another buyer's body, with any
// well-formed header naming an offered network, was served that buyer's paid
// answer and never charged, and an `X-Cache: hit` told them the body had been
// sent before.
//
// Now every entry is stored under the payer that paid for it, and read only by
// a request that proves it is that payer:
//
//   writer (on the final 200, after settlement, in the route binder's finish
//   hook): the rail's VERIFIED payer. A prepaid credits key (its id), a Tempo
//   sender the gate proved (req.mppTempoSender), or the EVM x402 signer the
//   facilitator verified before settling (payerFromRequest), and that signer
//   only when the reader's own proof (below) named the same payer on this
//   same request: an entry no later request could read is never stored. A
//   rail with no proven payer (a non-EVM x402 payment, a card, an x402 v1 or
//   Permit2 payment, a contract wallet's signature) stores nothing, and a
//   call served without settling (a trial, a first-call allowance grant)
//   stores nothing.
//
//   reader (pre-paywall, before anything is verified): first a payer-neutral
//   presence marker the writer stores beside each entry, so a body nobody
//   holds an entry for costs no signature recovery; then the same scope,
//   proved on the request itself. A credits key or a Tempo sender is proved by its
//   gate, which runs earlier. An x402 payment is proved here: it must be an
//   x402 v2 EIP-3009 authorization to this server's receiving wallet, on a
//   network spelled the one way the replay guard keys it ("eip155:<id>", no
//   leading zero), still valid, with a bounded life (a validity window no
//   longer than the guard keeps a settled payment's consumed mark, or an
//   expiry no further out than the stock x402 v2 client sets one: that
//   client signs every payment valid from the epoch),
//   whose signature recovers to its own `from`
//   under the token domain its accept names, and whose replay key the replay
//   guard holds neither in flight nor consumed (a settled authorization is
//   public on chain, so its bytes prove nothing once used). Anything else
//   reads no scope, and the request goes on to the paywall and is charged as
//   any other.
//
// The repeat stays free for the buyer who paid; it is no longer anyone else's.
import { createHash } from "node:crypto";
import { recoverTypedDataAddress } from "viem";
import { decodeB64Json } from "./payment-reject.js";
import { identityPayerOf, paymentHeaderOf } from "./payer.js";
import { allowanceServed } from "./allowance-state.js";
import { SETTLED_HOLD_MS, CONSUMED_VALIDITY_MARGIN_MS } from "./replay-guard.js";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;
const UINT = /^\d{1,78}$/;
// The one spelling of an EVM network the proof reads: the replay guard keys a
// payment on the network string as sent (src/replay-guard.js
// paymentReplayKey), so "eip155:08453", which names the same chain to the
// signature, would be another payment to the guard. A non-canonical spelling
// proves nothing.
const CANONICAL_EVM_NETWORK = /^eip155:([1-9]\d{0,11})$/;
// The longest validity window a read accepts. The guard holds a settled
// payment's consumed mark for SETTLED_HOLD_MS from its settle, which is after
// validAfter; a window no longer than that (less a clock margin) has closed
// before the mark lapses, so a settled authorization can never be read once
// the guard has let it go.
const MAX_READ_WINDOW_SEC = BigInt(Math.floor((SETTLED_HOLD_MS - CONSUMED_VALIDITY_MARGIN_MS) / 1000));
// The stock x402 v2 exact client signs validAfter "0" and validBefore = now +
// the accept's maxTimeoutSeconds, so its window is never short and the bound
// above reads none of its payments. A read also accepts an authorization
// that expires no later than that client would set it for a payment signed
// now (the exact-scheme accepts ask DEFAULT_MAX_TIMEOUT_SECONDS,
// src/evm-validity.js: the same figure, held equal by
// scripts/test-gateway-cache-scope.js; the batched accept asks a longer one),
// plus a clock allowance. An authorization that expires within the guard's
// hold of its settle, as one from a client that follows an exact accept does,
// has expired before its consumed mark lapses.
export const STOCK_MAX_TIMEOUT_SEC = 300;
export const STOCK_EXPIRY_SLACK_SEC = 60;
const MAX_READ_REMAINING_SEC = BigInt(STOCK_MAX_TIMEOUT_SEC + STOCK_EXPIRY_SLACK_SEC);

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/** The cache key a scope reads and writes: null without a scope (no read, no write). */
export function scopedCacheKey(key, scope) {
  if (!key || typeof scope !== "string" || !scope) return null;
  return createHash("sha256").update(`${scope}\n${key}`).digest("hex");
}

const tempoScope = (sender) => (typeof sender === "string" && ADDR.test(sender) ? `tempo:${sender.toLowerCase()}` : null);
const creditsScope = (keyId) => (typeof keyId === "string" && keyId ? `credits:${keyId}` : null);

// The payer-neutral marker stored beside every scoped entry: "some payer
// holds an answer for this body". The read checks it first, so a body nobody
// has an entry for costs no signature recovery before the paywall. A scope
// never reads it (scopes are "evm:", "tempo:" and "credits:").
export function presenceCacheKey(key) {
  if (!key) return null;
  return createHash("sha256").update(`present\n${key}`).digest("hex");
}
const PRESENT = Object.freeze({ present: true });

/** The scope of the payer a settled final 200 was paid by, or null. `payTo`
 *  is the EVM receiving wallet (as for the reader). */
export async function writerCacheScope(req, res, env = process.env, { payTo } = {}) {
  if (!req) return null;
  if (String(res?.getHeader?.("X-Trial-Accepted") || "") === "true") return null;
  if (allowanceServed(req)) return null;
  if (req.creditsSettled === true) return creditsScope(req.creditsKeyId);
  if (req.tempoSettled === true || req.mppTempoCredential === true) return req.tempoSettled === true ? tempoScope(req.mppTempoSender) : null;
  // identityPayerOf: the EVM signer the facilitator verified (null in
  // FREE_MODE, where nothing is verified). Stored only under a payer the
  // reader's own proof names (provenX402Signer, without the validity window,
  // which binds a read and not an entry): the scope the reader proved on this
  // request, else the same proof run here. One predicate for both sides.
  const from = identityPayerOf(req, env);
  if (!from) return null;
  const scope = `evm:${String(from).toLowerCase()}`;
  if (provenScopeOf(req) === scope) return scope;
  const signer = await provenX402Signer(paymentHeaderOf(req), { payTo, anyTime: true });
  return signer && `evm:${signer}` === scope ? scope : null;
}

/** The route binder's finish-hook commit of a settled 200's deferred cache
 *  writes: each under the writer scope, with its presence marker. */
export async function commitGatewayCacheWrites(req, res, deferred, { payTo, store, env = process.env } = {}) {
  if (!Array.isArray(deferred) || !deferred.length) return;
  const scope = await writerCacheScope(req, res, env, { payTo });
  if (!scope) return;
  for (const w of deferred) {
    try {
      const k = scopedCacheKey(w.key, scope);
      if (!k) continue;
      store(k, w.body);
      store(presenceCacheKey(w.key), PRESENT);
    } catch { /* cache is best-effort */ }
  }
}

// The EVM scope the reader proved on a request, kept for the writer.
const PROVEN_SCOPE = Symbol("gatewayCacheProvenScope");
const provenScopeOf = (req) => (req && typeof req === "object" ? req[PROVEN_SCOPE] || null : null);

/** The EVM signer an x402 v2 exact authorization to `payTo` proves, or null.
 *  Never throws. */
let proofRecoveries = 0;
/** Signature recoveries run so far (a test reads it to prove when none ran). */
export function proofRecoveryCount() { return proofRecoveries; }
// Recovered signers, keyed on everything the signature covers (domain,
// message, signature): a signature copied onto another message is another
// key and is recovered again. Least recently used first out, bounded.
export const PROOF_MEMO_MAX = 2_000;
let proofMemoMax = PROOF_MEMO_MAX;
const proofMemo = new Map();
/** Entries in the recovery memo (a test reads its bound). */
export function proofMemoSize() { return proofMemo.size; }
/** Test hook: the memo's bound (the default is PROOF_MEMO_MAX). */
export function __setProofMemoMax(n = PROOF_MEMO_MAX) {
  proofMemoMax = n;
  while (proofMemo.size > proofMemoMax) proofMemo.delete(proofMemo.keys().next().value);
}
async function recoverMemo(domain, message, signature) {
  const k = createHash("sha256").update(JSON.stringify([domain.name, domain.version, domain.chainId, domain.verifyingContract.toLowerCase(), message.from.toLowerCase(), message.to.toLowerCase(), String(message.value), String(message.validAfter), String(message.validBefore), message.nonce.toLowerCase(), signature.toLowerCase()])).digest("hex");
  if (proofMemo.has(k)) {
    const v = proofMemo.get(k);
    proofMemo.delete(k);
    proofMemo.set(k, v);
    return v;
  }
  proofRecoveries++;
  let signer = null;
  try {
    signer = (await recoverTypedDataAddress({ domain, types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", message, signature })).toLowerCase();
  } catch { signer = null; }
  proofMemo.set(k, signer);
  while (proofMemo.size > proofMemoMax) proofMemo.delete(proofMemo.keys().next().value);
  return signer;
}
export async function provenX402Signer(headerValue, { payTo, nowSec = Math.floor(Date.now() / 1000), anyTime = false } = {}) {
  try {
    if (!payTo || !ADDR.test(payTo)) return null;
    const p = decodeB64Json(headerValue);
    if (!p || p.x402Version !== 2) return null;
    const accepted = p.accepted;
    const auth = p.payload?.authorization;
    const signature = p.payload?.signature;
    if (!accepted || accepted.scheme !== "exact" || !auth || typeof signature !== "string" || !SIG.test(signature)) return null;
    if (p.payload?.permit2Authorization) return null;
    const m = typeof accepted.network === "string" ? CANONICAL_EVM_NETWORK.exec(accepted.network) : null;
    if (!m) return null;
    const name = accepted.extra?.name, version = accepted.extra?.version;
    if (typeof name !== "string" || !name || typeof version !== "string" || !version) return null;
    if (!ADDR.test(String(accepted.asset || ""))) return null;
    const { from, to, value, validAfter, validBefore, nonce } = auth;
    if (!ADDR.test(String(from)) || !ADDR.test(String(to)) || !HEX32.test(String(nonce))) return null;
    if (![value, validAfter, validBefore].every((v) => UINT.test(String(v)))) return null;
    if (String(to).toLowerCase() !== payTo.toLowerCase()) return null;
    if (!anyTime) {
      const after = BigInt(validAfter), before = BigInt(validBefore), t = BigInt(nowSec);
      if (before <= t || after > t) return null;
      if (before - after > MAX_READ_WINDOW_SEC && before - t > MAX_READ_REMAINING_SEC) return null;
    }
    const signer = await recoverMemo(
      { name, version, chainId: Number(m[1]), verifyingContract: accepted.asset },
      { from, to, value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce },
      signature,
    );
    return signer && signer === String(from).toLowerCase() ? signer : null;
  } catch {
    return null;
  }
}

/** The scope a pre-paywall request proves, or null. `payTo` is the EVM
 *  receiving wallet the gateway routes settle to. `paymentHeld(req)` answers
 *  whether the replay guard already holds this request's payment (in flight
 *  or consumed); it is required for an x402 proof, and a held payment, a
 *  throw or a missing reader proves nothing. */
export async function readerCacheScope(req, { payTo, nowSec, paymentHeld } = {}) {
  if (!req) return null;
  // The credits and Tempo gates ran first and set these only on acceptance
  // (and stripped any payment header riding alongside).
  if (req.creditsSettled === true) return creditsScope(req.creditsKeyId);
  if (req.mppTempoCredential === true) return tempoScope(req.mppTempoSender);
  const header = paymentHeaderOf(req);
  if (!header || typeof paymentHeld !== "function") return null;
  const signer = await provenX402Signer(header, { payTo, nowSec });
  if (!signer) return null;
  const scope = `evm:${signer}`;
  // Proved for the writer before the held check: the request that settles
  // this payment is the one the guard holds next.
  if (typeof req === "object") req[PROVEN_SCOPE] = scope;
  try {
    if (await paymentHeld(req)) return null;
  } catch {
    return null;
  }
  return scope;
}

/** The pre-paywall cache read, mounted by src/server.js after the credits,
 *  Tempo and Stripe gates and before the x402 paywall.
 *    keyOf(req)  the payer-neutral cache key of the body, or null (throws on
 *                an invalid body: the request then goes on unanswered here)
 *    get(key)    the stored answer under a scoped key (or a presence
 *                marker, presenceCacheKey), or null
 *    payTo       the EVM receiving wallet an x402 proof must pay
 *    paymentHeld(req)  true when the replay guard holds this request's
 *                payment in flight or consumed (claims nothing) */
export function gatewayCacheGate({ carriesPaymentAttempt, keyOf, get, payTo, paymentHeld }) {
  return async (req, res, next) => {
    if (req.method !== "POST" || !carriesPaymentAttempt(req)) return next();
    try {
      let key = keyOf(req);
      // No payer holds an answer for this body: nothing to prove, no
      // signature recovery, straight on to the paywall.
      if (key && !(await get(presenceCacheKey(key)))) key = null;
      // Scoped to the payer this request proves: an entry is read only by the
      // payer who paid for it. No proven payer, no read: the request goes on
      // to the paywall like any other.
      if (key) key = scopedCacheKey(key, await readerCacheScope(req, { payTo, paymentHeld }));
      if (key) {
        // The local store first, then the cache every replica shares.
        const hit = await get(key);
        if (hit) {
          // Read by the Tempo and Stripe gates, which run earlier: a gateway
          // cache hit is never settled on any rail.
          req.gatewayCacheHit = true;
          res.setHeader("X-Cache", "hit");
          res.setHeader("Cache-Control", "no-store, private");
          return res.status(200).json(hit);
        }
      }
    } catch { /* invalid input: let the paywall and handler answer honestly */ }
    next();
  };
}
