// MPP (Machine Payments Protocol) for the tollbooth - dependency-free codec.
//
// MPP is the IETF-track "Payment" HTTP authentication scheme (tempoxyz/mpp,
// paymentauth.org): the same 402 lifecycle as x402 with standard headers:
//
//   challenge   WWW-Authenticate: Payment id="...", realm="...", method="evm",
//               intent="charge", request="<b64url JSON>", expires="...", opaque="..."
//   credential  Authorization: Payment <b64url JSON{challenge, payload, source?}>
//   receipt     Payment-Receipt: <b64url JSON{method, status, reference, timestamp}>
//
// MPP's `evm` charge method is the same primitive as x402 `exact` on EVM
// (an EIP-3009 transferWithAuthorization signed by the buyer), so a tollbooth
// that already settles x402 through the operator's @x402/express middleware can
// accept MPP clients as pure header translation - settlement authority stays
// with the x402 stack, exactly once per purchase:
//
//   OUTBOUND  the middleware's own PAYMENT-REQUIRED header (its advertised
//             `accepts`) is turned into one HMAC-bound MPP challenge per
//             eligible EVM entry; the verbatim accepts entry rides in the
//             challenge's opaque slot so inbound is stateless and byte-exact.
//   INBOUND   an Authorization: Payment credential whose challenge id
//             HMAC-verifies is re-encoded as a PAYMENT-SIGNATURE header and
//             handed to the SAME middleware, which verifies + settles it as if
//             an x402 client had sent it.
//   RECEIPT   the settled PAYMENT-RESPONSE is mirrored as an MPP Payment-Receipt.
//
// No mppx dependency: it pulls in ox/zod and a viem peer, too heavy for a
// drop-in middleware, and the wire is small. Byte-compatibility with the
// reference client is proven by scripts/test-tollbooth-mpp.js in the parent
// repo, which drives a REAL mppx client through this codec.
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  META_ACCEPTS_KEY, STABLECOIN_DECIMALS, DEFAULT_MPP_CHAIN_IDS, b64url, unb64url, b64std, unb64std,
  canonicalJson, encodeRequest, challengeIdInput, serializeChallenge, decodeCredentialHeader, challengeShapeOk,
  metaFromChallenge, authorizationFromPayload, paymentSignatureFor, receiptFor, transactionFromPaymentResponse,
} from "./mpp-codec.js";

// The wire primitives live in mpp-codec.js (runtime-agnostic, shared with the
// edge build); this file adds the node:crypto HMAC binding on top.
export { DEFAULT_MPP_CHAIN_IDS, b64url, unb64url, canonicalJson };
export { isMppCredential } from "./mpp-codec.js";

// Positional HMAC binding of the challenge id - the same slot layout the
// reference implementation uses, so its Challenge.verify() agrees with ours
// given the same secret (handy in tests; the spec only requires that WE bind).
function challengeId(secretKey, c) {
  return createHmac("sha256", Buffer.from(secretKey, "utf8")).update(challengeIdInput(c), "utf8").digest("base64url");
}
function idMatches(secretKey, c) {
  const a = Buffer.from(String(c.id || ""), "utf8");
  const b = Buffer.from(challengeId(secretKey, c), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- OUTBOUND: PAYMENT-REQUIRED -> WWW-Authenticate: Payment ---------------
/**
 * Decode an x402 v2 PAYMENT-REQUIRED header (base64 JSON envelope) and mint one
 * HMAC-bound MPP evm/charge challenge per eligible EVM `accepts` entry.
 * @returns {string|null} WWW-Authenticate value, or null when nothing qualifies.
 */
export function challengesFromPaymentRequired(paymentRequiredHeader, { secretKey, realm, chainIds = DEFAULT_MPP_CHAIN_IDS } = {}) {
  if (!secretKey || !paymentRequiredHeader) return null;
  let envelope;
  try { envelope = JSON.parse(unb64std(paymentRequiredHeader)); } catch { return null; }
  const accepts = Array.isArray(envelope?.accepts) ? envelope.accepts : [];
  const allowAll = chainIds === "all";
  const allowed = new Set(allowAll ? [] : (chainIds || []).map(Number));
  const out = [];
  for (const a of accepts) {
    if (!a || a.scheme !== "exact" || typeof a.network !== "string" || !a.network.startsWith("eip155:")) continue;
    const chainId = Number(a.network.slice("eip155:".length));
    if (!Number.isInteger(chainId)) continue;
    if (!allowAll && !allowed.has(chainId)) continue;
    if (typeof a.amount !== "string" || typeof a.asset !== "string" || typeof a.payTo !== "string") continue;
    const timeout = Number(a.maxTimeoutSeconds) > 0 ? Number(a.maxTimeoutSeconds) : 300;
    const c = {
      realm,
      method: "evm",
      intent: "charge",
      request: encodeRequest({
        amount: a.amount,
        currency: a.asset,
        recipient: a.payTo,
        methodDetails: { chainId, credentialTypes: ["authorization"], decimals: STABLECOIN_DECIMALS },
      }),
      // Native MPP clients sign validBefore = expires; keep it inside the
      // advertised x402 window so facilitator timeout semantics match.
      expires: new Date(Date.now() + timeout * 1000).toISOString(),
      // The verbatim accepts entry (RAW, not normalised - the middleware's
      // requirement matching deep-equals the full advertised object).
      opaque: encodeRequest({ [META_ACCEPTS_KEY]: JSON.stringify(a) }),
    };
    c.id = challengeId(secretKey, c);
    out.push(serializeChallenge(c));
  }
  if (!out.length) return null;
  return out.join(", ");
}

// ---- INBOUND: Authorization: Payment -> PAYMENT-SIGNATURE ------------------
/**
 * Validate an MPP credential against our HMAC binding and re-encode it as an
 * x402 v2 PAYMENT-SIGNATURE value. Returns null for anything that is not a
 * valid, unexpired, HMAC-bound evm/charge credential of ours.
 */
export function translateCredential(authorizationHeader, { secretKey } = {}) {
  if (!secretKey) return null;
  const wire = decodeCredentialHeader(authorizationHeader);
  const ch = wire?.challenge;
  if (!challengeShapeOk(ch)) return null;
  // HMAC binding (spec: servers MUST bind ids to challenge params). This also
  // proves the echoed accepts entry in opaque is ours and untampered.
  if (!idMatches(secretKey, ch)) return null;
  if (ch.expires && !(Date.parse(ch.expires) > Date.now())) return null;
  let accepted;
  try { accepted = JSON.parse(metaFromChallenge(ch)[META_ACCEPTS_KEY]); } catch { return null; }
  if (!accepted || typeof accepted !== "object") return null;
  const auth = authorizationFromPayload(wire.payload);
  if (!auth) return null;
  return paymentSignatureFor(accepted, auth);
}

// ---- RECEIPT: PAYMENT-RESPONSE -> Payment-Receipt -------------------------
export function receiptFromPaymentResponse(paymentResponseHeader) {
  const tx = transactionFromPaymentResponse(paymentResponseHeader);
  return tx ? receiptFor(tx) : null;
}
