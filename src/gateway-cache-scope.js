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
//   facilitator verified before settling (payerFromRequest). A rail with no
//   proven payer (a non-EVM x402 payment, a card) stores nothing, and a call
//   served without settling (a trial, a first-call allowance grant) stores
//   nothing.
//
//   reader (pre-paywall, before anything is verified): the same scope, proved
//   on the request itself. A credits key or a Tempo sender is proved by its
//   gate, which runs earlier. An x402 payment is proved here: it must be an
//   x402 v2 EIP-3009 authorization to this server's receiving wallet, still
//   inside its validity window, whose signature recovers to its own `from`
//   under the token domain its accept names. Anything else reads no scope, and
//   the request goes on to the paywall and is charged as any other.
//
// The repeat stays free for the buyer who paid; it is no longer anyone else's.
import { createHash } from "node:crypto";
import { recoverTypedDataAddress } from "viem";
import { decodeB64Json } from "./payment-reject.js";
import { identityPayerOf, paymentHeaderOf } from "./payer.js";
import { allowanceServed } from "./allowance-state.js";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;
const UINT = /^\d{1,78}$/;

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

/** The scope of the payer a settled final 200 was paid by, or null. */
export function writerCacheScope(req, res, env = process.env) {
  if (!req) return null;
  if (String(res?.getHeader?.("X-Trial-Accepted") || "") === "true") return null;
  if (allowanceServed(req)) return null;
  if (req.creditsSettled === true) return creditsScope(req.creditsKeyId);
  if (req.tempoSettled === true || req.mppTempoCredential === true) return req.tempoSettled === true ? tempoScope(req.mppTempoSender) : null;
  // identityPayerOf: the EVM signer the facilitator verified (null in
  // FREE_MODE, where nothing is verified).
  const from = identityPayerOf(req, env);
  return from ? `evm:${from}` : null;
}

/** The EVM signer an x402 v2 exact authorization to `payTo` proves, or null.
 *  Never throws. */
export async function provenX402Signer(headerValue, { payTo, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  try {
    if (!payTo || !ADDR.test(payTo)) return null;
    const p = decodeB64Json(headerValue);
    if (!p || p.x402Version !== 2) return null;
    const accepted = p.accepted;
    const auth = p.payload?.authorization;
    const signature = p.payload?.signature;
    if (!accepted || accepted.scheme !== "exact" || !auth || typeof signature !== "string" || !SIG.test(signature)) return null;
    if (p.payload?.permit2Authorization) return null;
    const m = /^eip155:(\d{1,12})$/.exec(String(accepted.network || ""));
    if (!m) return null;
    const name = accepted.extra?.name, version = accepted.extra?.version;
    if (typeof name !== "string" || !name || typeof version !== "string" || !version) return null;
    if (!ADDR.test(String(accepted.asset || ""))) return null;
    const { from, to, value, validAfter, validBefore, nonce } = auth;
    if (!ADDR.test(String(from)) || !ADDR.test(String(to)) || !HEX32.test(String(nonce))) return null;
    if (![value, validAfter, validBefore].every((v) => UINT.test(String(v)))) return null;
    if (String(to).toLowerCase() !== payTo.toLowerCase()) return null;
    if (BigInt(validBefore) <= BigInt(nowSec) || BigInt(validAfter) > BigInt(nowSec)) return null;
    const signer = await recoverTypedDataAddress({
      domain: { name, version, chainId: Number(m[1]), verifyingContract: accepted.asset },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from, to, value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce },
      signature,
    });
    return signer && signer.toLowerCase() === String(from).toLowerCase() ? signer.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The scope a pre-paywall request proves, or null. `payTo` is the EVM
 *  receiving wallet the gateway routes settle to. */
export async function readerCacheScope(req, { payTo, nowSec } = {}) {
  if (!req) return null;
  // The credits and Tempo gates ran first and set these only on acceptance
  // (and stripped any payment header riding alongside).
  if (req.creditsSettled === true) return creditsScope(req.creditsKeyId);
  if (req.mppTempoCredential === true) return tempoScope(req.mppTempoSender);
  const header = paymentHeaderOf(req);
  if (!header) return null;
  const signer = await provenX402Signer(header, { payTo, nowSec });
  return signer ? `evm:${signer}` : null;
}

/** The pre-paywall cache read, mounted by src/server.js after the credits,
 *  Tempo and Stripe gates and before the x402 paywall.
 *    keyOf(req)  the payer-neutral cache key of the body, or null (throws on
 *                an invalid body: the request then goes on unanswered here)
 *    get(key)    the stored answer under a scoped key, or null
 *    payTo       the EVM receiving wallet an x402 proof must pay */
export function gatewayCacheGate({ carriesPaymentAttempt, keyOf, get, payTo }) {
  return async (req, res, next) => {
    if (req.method !== "POST" || !carriesPaymentAttempt(req)) return next();
    try {
      let key = keyOf(req);
      // Scoped to the payer this request proves: an entry is read only by the
      // payer who paid for it. No proven payer, no read: the request goes on
      // to the paywall like any other.
      if (key) key = scopedCacheKey(key, await readerCacheScope(req, { payTo }));
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
