// Arc mainnet settlement through Circle's hosted x402 facilitator.
//
// Arc (chain 5042) settles native USDC at 0x3600...0000 (6 decimals, EIP-712
// domain "USDC" / "2", EIP-3009 transferWithAuthorization). Circle's
// Facilitator Service is the facilitator that settles it. Its wire is stock
// x402 v2 under a different base path (/v1/facilitator/x402/{supported,
// verify,settle}) with a Bearer API key on verify and settle; /supported is
// keyless. So the request bodies are the stock ones, and this client exists
// for what the stock HTTPFacilitatorClient does not do:
//
//   1. It never quotes the upstream body. The stock client puts the first 200
//      characters of any error body into the thrown message, and the
//      facilitator diagnostics would log a non-JSON one. Here every failure is
//      reduced to an HTTP status and a short reason code drawn from a closed
//      alphabet, so nothing the far end sends (or echoes) reaches a log, an
//      error message or a buyer's receipt.
//   2. Responses are untrusted input: JSON only, a byte cap, a schema check,
//      and redirects refused (a redirect could otherwise carry the
//      Authorization header to another host).
//   3. It is Arc only. Circle also advertises Base and Polygon, which other
//      facilitators own here; getSupported() returns only the Arc `exact`
//      kind on the Arc USDC asset, so this client can never win another
//      chain's route, and a /supported that lacks that kind (or is malformed)
//      drops Arc from the offer at boot (src/payments.js). A second instance,
//      off unless CIRCLE_FACILITATOR_EVM_FALLBACK=on, settles Base and Polygon
//      exact USDC as the LAST settle fallback only: it is never a routing
//      client, so it never verifies and never wins a route, and it is asked
//      only after every earlier settler refused before broadcasting.
//   4. A local preflight on verify and settle: the requirement must be Arc
//      exact USDC, the signed authorization must pay that payTo exactly that
//      amount inside its validity window, and the signature (any ECDSA form)
//      must verify for the payer under Arc's own EIP-712 domain. A payment
//      signed for another chain or another token, or a signature this server
//      cannot verify itself (contract wallets), is refused before Circle sees it.
//   5. `settlement_pending` (the outcome was unresolved inside Circle's wait
//      window) is reconciled by polling /status for a bounded time; one still
//      pending after that is booked by paymentId (src/circle-pending.js) and a
//      reconcile pass resolves it from Circle's final status later.
//
// The base URL is a constant. Nothing in a request can change the host, and
// the API key is read from the environment by the caller and held only in
// this instance's closure.
import { HTTPFacilitatorClient } from "@x402/core/server";
import { EVM_RPCS } from "./evm-rpcs.js";
import { ADDR, TX, UUID, UINT, B32, SECP256K1_HALF_N, isObj, lc } from "./circle-shapes.js";
import { SettleError, VerifyError } from "@x402/core/types";
import {
  verifyTypedData, parseCompactSignature, compactSignatureToSignature, serializeSignature,
  encodeDeployData, hashTypedData, erc6492SignatureValidatorAbi, erc6492SignatureValidatorByteCode,
  ExecutionRevertedError, RawContractError,
} from "viem";
import {
  ARC_CAIP2, ARC_CHAIN_ID, ARC_USDC, ARC_PROFILE, CIRCLE_FACILITATOR_BASE, CIRCLE_LABEL,
  CircleResponseError, safeReason, arcKindsFromSupported, usdcKindsFromSupported,
} from "./circle-supported.js";
import { EVM_TOKEN_DOMAINS } from "./evm-usdc-domain.js";
import { PERMIT2_ADDRESS, uptoPermit2WitnessTypes, x402UptoPermit2ProxyAddress } from "@x402/evm";

export {
  ARC_CAIP2, ARC_CHAIN_ID, ARC_USDC, ARC_PROFILE, CIRCLE_FACILITATOR_BASE, CIRCLE_LABEL,
  safeReason, arcKindsFromSupported, usdcKindsFromSupported,
};
export { isArcNetwork, stripArcFromSupported, withoutArcKinds } from "./circle-supported.js";

// The settle fallback on Base and Polygon (CIRCLE_FACILITATOR_EVM_FALLBACK=on):
// the same client, the same key and the same rules, for the native USDC whose
// EIP-712 domain src/evm-usdc-domain.js read from each chain. It is only ever
// asked to settle after every earlier settler refused before broadcasting
// (src/payments.js), and it is never a routing client.
const domainRow = (caip2) => {
  const r = EVM_TOKEN_DOMAINS.find((x) => x.network === caip2 && x.symbol === "USDC");
  if (!r) throw new Error(`no measured USDC domain for ${caip2}`);
  return r;
};
const evmProfile = (caip2) => {
  const r = domainRow(caip2);
  return Object.freeze({ caip2, chainId: Number(caip2.split(":")[1]), asset: r.asset, decimals: 6, name: r.name, version: r.version });
};
export const CIRCLE_EVM_FALLBACK_PROFILES = Object.freeze([evmProfile("eip155:8453"), evmProfile("eip155:137")]);
export const CIRCLE_EVM_FALLBACK_NETWORKS = Object.freeze(CIRCLE_EVM_FALLBACK_PROFILES.map((p) => p.caip2));
export const CIRCLE_EVM_LABEL = "Circle (EVM settle fallback)";

const MAX_BODY_BYTES = 64 * 1024;
const SUPPORTED_TIMEOUT_MS = 10_000;
const VERIFY_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 30_000;
const PENDING_POLL_MS = 1_000;
const PENDING_BUDGET_MS = 20_000;


/** The first machine reason in a Circle ErrorResponse ({code, message, errors:[{reason}]}),
 *  or a status-derived code. The message field is never read. */
function reasonFromErrorBody(data, status) {
  const first = data && typeof data === "object" && Array.isArray(data.errors) ? data.errors[0] : null;
  const r = first && typeof first === "object" ? first.reason : null;
  return safeReason(r, `circle_http_${Number(status) || 0}`);
}

/** Read a response body as JSON under a byte cap. Throws CircleResponseError
 *  with a reason code, never the body. */
async function readJsonCapped(res, op) {
  const type = String(res.headers?.get?.("content-type") || "");
  if (!/\bjson\b/i.test(type)) {
    try { await res.body?.cancel?.(); } catch { /* nothing to release */ }
    throw new CircleResponseError(op, res.status, "non_json_response");
  }
  const declared = Number(res.headers?.get?.("content-length") || 0);
  if (declared > MAX_BODY_BYTES) {
    try { await res.body?.cancel?.(); } catch { /* nothing to release */ }
    throw new CircleResponseError(op, res.status, "response_too_large");
  }
  let text = "";
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw new CircleResponseError(op, res.status, "response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } else {
    text = String(await res.text());
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new CircleResponseError(op, res.status, "response_too_large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CircleResponseError(op, res.status, "invalid_json");
  }
}


/** The EIP-3009 typed data a buyer signs for a USDC exact payment on the
 *  profile's chain (Arc by default). */
function usdcTypedData(auth, profile = ARC_PROFILE) {
  return {
    domain: { name: profile.name, version: profile.version, chainId: profile.chainId, verifyingContract: profile.asset },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from, to: auth.to, value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce,
    },
  };
}

/**
 * Local preflight for an Arc exact payment. Returns null when it may go to
 * Circle, or { reason, payer } when it must be refused here.
 */
export async function preflightArcPayment(paymentPayload, requirements, nowSec = Math.floor(Date.now() / 1000), { contractVerifier = null } = {}) {
  return preflightUsdcPayment(paymentPayload, requirements, nowSec, { contractVerifier, profiles: [ARC_PROFILE] });
}

/**
 * The same preflight for any of `profiles` (the requirement's network picks
 * one; any other network is refused). Only `exact` is accepted: an `upto`
 * (Permit2) payment is refused here, before anything is sent. The contract
 * wallet verifier applies on Arc only; elsewhere a signature this server
 * cannot verify as an EOA's is refused.
 */
export async function preflightUsdcPayment(paymentPayload, requirements, nowSec = Math.floor(Date.now() / 1000), { contractVerifier = null, profiles = [ARC_PROFILE] } = {}) {
  const refuse = (reason, payer) => ({ reason, payer: ADDR.test(String(payer || "")) ? payer : undefined });
  if (!isObj(requirements) || requirements.scheme !== "exact") return refuse("unsupported_scheme");
  const profile = profiles.find((p) => p.caip2 === requirements.network);
  if (!profile) return refuse("invalid_network");
  if (lc(requirements.asset) !== lc(profile.asset)) return refuse("invalid_payment_requirements");
  if (!ADDR.test(String(requirements.payTo || "")) || !UINT.test(String(requirements.amount ?? ""))) return refuse("invalid_payment_requirements");
  if (!isObj(paymentPayload) || paymentPayload.x402Version !== 2) return refuse("invalid_x402_version");
  const accepted = paymentPayload.accepted;
  if (isObj(accepted) && (accepted.network !== profile.caip2 || lc(accepted.asset) !== lc(profile.asset))) return refuse("invalid_network");
  const inner = paymentPayload.payload;
  const auth = isObj(inner) ? inner.authorization : null;
  const sig = isObj(inner) ? inner.signature : null;
  if (!isObj(auth) || typeof sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(sig)) return refuse("invalid_payload");
  const payer = auth.from;
  if (!ADDR.test(String(auth.from || "")) || !ADDR.test(String(auth.to || ""))) return refuse("invalid_payload", payer);
  for (const f of ["value", "validAfter", "validBefore"]) if (!UINT.test(String(auth[f] ?? ""))) return refuse("invalid_payload", payer);
  if (!B32.test(String(auth.nonce || ""))) return refuse("invalid_payload", payer);
  if (lc(auth.to) !== lc(requirements.payTo)) return refuse("invalid_exact_evm_payload_recipient_mismatch", payer);
  if (BigInt(auth.value) !== BigInt(requirements.amount)) return refuse("invalid_exact_evm_payload_authorization_value_mismatch", payer);
  if (BigInt(auth.validAfter) > BigInt(nowSec)) return refuse("invalid_exact_evm_payload_authorization_valid_after", payer);
  if (BigInt(auth.validBefore) <= BigInt(nowSec + 6)) return refuse("invalid_exact_evm_payload_authorization_valid_before", payer);
  // Every signature is checked here, under ARC's own domain, in whatever form
  // it comes (65-byte with v 27/28 or 0/1, or 64-byte EIP-2098 compact). One
  // made for Base, for another chainId or for another token recovers to
  // someone else and is refused. A signature that is not a valid ECDSA
  // signature from `from` (a contract wallet's ERC-1271 or ERC-6492 one) is
  // refused too, unless the contract-wallet verifier is configured
  // (ARC_CONTRACT_WALLETS=on): then it is verified on chain against Arc, and
  // anything but a clear yes is refused. Nothing reaches Circle unverified.
  // Low-s rule (EIP-2): a 65-byte signature whose s is in the upper half of
  // the curve order is the malleable twin of a valid one; refused here, the
  // same as the token contract itself would.
  if (sig.length === 132 && BigInt(`0x${sig.slice(66, 130)}`) > SECP256K1_HALF_N) return refuse("invalid_exact_evm_payload_signature", payer);
  if (await isLocalEoaSignature(auth, sig, profile)) return null;
  if (!contractVerifier || profile.caip2 !== ARC_CAIP2) return refuse("invalid_exact_evm_payload_signature", payer);
  const verdict = await contractVerifier(auth, sig);
  if (verdict === true) return null;
  return refuse(verdict === "unverifiable" ? "contract_signature_unverifiable" : "invalid_exact_evm_payload_signature", payer);
}

/**
 * Local preflight for an Arc `upto` (Permit2) payment, the same rule as the
 * exact one: nothing reaches Circle unless this server has verified it. The
 * Permit2 authorization must name the requirement's token, the x402 upto
 * proxy as spender, our payTo as the witness recipient, the facilitator the
 * requirement names, a live window, and a ceiling: equal to the requirement
 * on verify, and at or above the amount asked on settle (the metered amount,
 * which may be lower, never higher). The signature must be a low-s ECDSA
 * signature by `from` over Permit2's typed data on this chain. An EIP-2612
 * gas sponsoring permit, when the buyer attached one, must be for the same
 * owner and token and approve Permit2; Circle checks its signature.
 */
export async function preflightUptoPayment(paymentPayload, requirements, nowSec = Math.floor(Date.now() / 1000), { profiles = [ARC_PROFILE], settle = false } = {}) {
  const refuse = (reason, payer) => ({ reason, payer: ADDR.test(String(payer || "")) ? payer : undefined });
  if (!isObj(requirements) || requirements.scheme !== "upto") return refuse("unsupported_scheme");
  const profile = profiles.find((p) => p.caip2 === requirements.network);
  if (!profile) return refuse("invalid_network");
  if (lc(requirements.asset) !== lc(profile.asset)) return refuse("invalid_payment_requirements");
  const facilitator = isObj(requirements.extra) ? requirements.extra.facilitatorAddress : null;
  if (!ADDR.test(String(requirements.payTo || "")) || !UINT.test(String(requirements.amount ?? "")) || !ADDR.test(String(facilitator || ""))) return refuse("invalid_payment_requirements");
  if (!isObj(paymentPayload) || paymentPayload.x402Version !== 2) return refuse("invalid_x402_version");
  const accepted = paymentPayload.accepted;
  if (!isObj(accepted) || accepted.scheme !== "upto" || accepted.network !== profile.caip2 || lc(accepted.asset) !== lc(profile.asset)) return refuse("invalid_network");
  const inner = paymentPayload.payload;
  const p2 = isObj(inner) ? inner.permit2Authorization : null;
  const sig = isObj(inner) ? inner.signature : null;
  if (!isObj(p2) || typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) return refuse("invalid_payload");
  const payer = p2.from;
  const permitted = p2.permitted;
  const witness = p2.witness;
  if (!ADDR.test(String(p2.from || "")) || !ADDR.test(String(p2.spender || "")) || !isObj(permitted) || !isObj(witness)) return refuse("invalid_payload", payer);
  if (!ADDR.test(String(permitted.token || "")) || !ADDR.test(String(witness.to || "")) || !ADDR.test(String(witness.facilitator || ""))) return refuse("invalid_payload", payer);
  for (const v of [permitted.amount, p2.nonce, p2.deadline, witness.validAfter]) if (!UINT.test(String(v ?? ""))) return refuse("invalid_payload", payer);
  if (lc(p2.spender) !== lc(x402UptoPermit2ProxyAddress)) return refuse("invalid_permit2_spender", payer);
  if (lc(witness.to) !== lc(requirements.payTo)) return refuse("invalid_permit2_recipient_mismatch", payer);
  if (lc(witness.facilitator) !== lc(facilitator)) return refuse("invalid_upto_evm_payload_facilitator_mismatch", payer);
  if (lc(permitted.token) !== lc(profile.asset)) return refuse("permit2_token_mismatch", payer);
  const ceiling = BigInt(permitted.amount);
  const asked = BigInt(requirements.amount);
  if (settle ? asked > ceiling : asked !== ceiling) return refuse(settle ? "upto_settlement_exceeds_amount" : "permit2_amount_mismatch", payer);
  if (BigInt(p2.deadline) < BigInt(nowSec + 6)) return refuse("permit2_deadline_expired", payer);
  if (BigInt(witness.validAfter) > BigInt(nowSec)) return refuse("permit2_not_yet_valid", payer);
  const ext = isObj(paymentPayload.extensions) ? paymentPayload.extensions : null;
  const permit = ext && isObj(ext.eip2612GasSponsoring) && isObj(ext.eip2612GasSponsoring.info) ? ext.eip2612GasSponsoring.info : null;
  if (permit && permit.from !== undefined) {
    if (lc(permit.from) !== lc(p2.from) || lc(permit.asset) !== lc(profile.asset) || lc(permit.spender) !== lc(PERMIT2_ADDRESS)) return refuse("invalid_eip2612_extension", payer);
  }
  if (BigInt(`0x${sig.slice(66, 130)}`) > SECP256K1_HALF_N) return refuse("invalid_upto_evm_payload_signature", payer);
  try {
    const valid = await verifyTypedData({
      address: p2.from,
      domain: { name: "Permit2", chainId: profile.chainId, verifyingContract: PERMIT2_ADDRESS },
      types: uptoPermit2WitnessTypes,
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: permitted.token, amount: ceiling },
        spender: p2.spender,
        nonce: BigInt(p2.nonce),
        deadline: BigInt(p2.deadline),
        witness: { to: witness.to, facilitator: witness.facilitator, validAfter: BigInt(witness.validAfter) },
      },
      signature: sig,
    });
    if (valid) return null;
  } catch { /* an unparseable signature is refused below */ }
  return refuse("invalid_upto_evm_payload_signature", payer);
}

/** The signer of an EVM payload: authorization.from (exact) or
 *  permit2Authorization.from (upto). */
const signerOf = (paymentPayload) => paymentPayload?.payload?.authorization?.from ?? paymentPayload?.payload?.permit2Authorization?.from;

/** The nonce a pending settlement is booked under (src/circle-pending.js keys
 *  on a 32-byte hex nonce): EIP-3009's as signed, a Permit2 uint nonce as the
 *  same number in 32-byte hex. */
export function pendingNonceOf(paymentPayload) {
  const exact = paymentPayload?.payload?.authorization?.nonce;
  if (exact !== undefined) return exact;
  const p2 = paymentPayload?.payload?.permit2Authorization?.nonce;
  if (!UINT.test(String(p2 ?? ""))) return undefined;
  const hex = BigInt(p2).toString(16);
  return hex.length <= 64 ? `0x${hex.padStart(64, "0")}` : undefined;
}

/** True when `sig` is a valid ECDSA signature by `auth.from` over the
 *  profile's (Arc by default) EIP-3009 typed data. Pure: no RPC call. */
export async function isLocalEoaSignature(auth, sig, profile = ARC_PROFILE) {
  try {
    // viem verifies 65-byte signatures (v 27/28 or 0/1); a 64-byte EIP-2098
    // compact one is expanded to that form first.
    const full = sig.length === 130 ? serializeSignature(compactSignatureToSignature(parseCompactSignature(sig))) : sig;
    return await verifyTypedData({ address: auth.from, ...usdcTypedData(auth, profile), signature: full });
  } catch { return false; }
}

/** The payload's signature is not a local ECDSA one (a contract-wallet form). */
export async function isContractWalletPayment(paymentPayload) {
  const auth = paymentPayload?.payload?.authorization;
  const sig = paymentPayload?.payload?.signature;
  if (!isObj(auth) || typeof sig !== "string" || !ADDR.test(String(auth.from || ""))) return false;
  return !(await isLocalEoaSignature(auth, sig));
}

/** ARC_CONTRACT_WALLETS=on turns contract-wallet signatures on; anything else is off. */
export function arcContractWalletsEnabled(env = process.env) {
  return String(env.ARC_CONTRACT_WALLETS || "").trim().toLowerCase() === "on";
}

export const CONTRACT_VERIFY_TIMEOUT_MS = 4_000;

export const CONTRACT_VERIFY_MAX_INFLIGHT = 8;

/** Was this call error the contract REVERTING (a verdict: the signature is
 *  not valid), as opposed to the RPC failing (no verdict at all)? */
function isRevert(err) {
  const hit = (x) => x instanceof ExecutionRevertedError || x instanceof RawContractError;
  try {
    if (typeof err?.walk === "function") return !!err.walk(hit);
  } catch { /* fall through */ }
  return hit(err);
}

/**
 * An on-chain verifier for contract-wallet signatures on Arc: one eth_call of
 * the ERC-6492 universal signature validator (deployless), which checks
 * ERC-1271 on a deployed wallet and an ERC-6492 wrapped signature for an
 * undeployed one. It is called directly, not through viem's verifyTypedData,
 * because that turns ANY call failure (an RPC error included) into `false`:
 * here a revert is a verdict (false, cached) and anything else (an RPC error,
 * a timeout, an unreadable answer) is "unverifiable" (refused, never cached).
 * The RPC is the Arc constant (src/evm-rpcs.js); nothing in a request names
 * it. At most CONTRACT_VERIFY_MAX_INFLIGHT checks run at once in a process
 * ("busy" past that: refused). Each definite verdict is cached by (from,
 * nonce, signature) for a few minutes, so a settle after its verify costs no
 * second call. Only true passes.
 */
export function createContractVerifier({ publicClient = null, rpcUrl, timeoutMs = CONTRACT_VERIFY_TIMEOUT_MS, ttlMs = 5 * 60_000, now = () => Date.now(), maxInflight = CONTRACT_VERIFY_MAX_INFLIGHT } = {}) {
  let client = publicClient;
  let inflight = 0;
  const cache = new Map();
  const getClient = async () => {
    if (client) return client;
    const { createPublicClient, http } = await import("viem");
    client = createPublicClient({ transport: http(rpcUrl, { timeout: timeoutMs, retryCount: 0 }) });
    return client;
  };
  return async function verifyContractSignature(auth, sig) {
    // The verdict covers the whole signed message (to, value, validity window,
    // nonce), so the key is its EIP-712 digest, not only the payer and nonce.
    let digest;
    try { digest = hashTypedData(usdcTypedData(auth)); } catch { return "unverifiable"; }
    const key = `${lc(auth.from)}|${lc(digest)}|${lc(sig)}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.verdict;
    if (inflight >= maxInflight) return "unverifiable";
    inflight++;
    let verdict;
    let timer = null;
    try {
      const c = await getClient();
      const data = encodeDeployData({
        abi: erc6492SignatureValidatorAbi,
        bytecode: erc6492SignatureValidatorByteCode,
        args: [auth.from, digest, sig],
      });
      const res = await Promise.race([
        c.call({ data }),
        // Not unref'd: a request is waiting on this answer. Cleared below.
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), timeoutMs); }),
      ]);
      const out = typeof res?.data === "string" ? res.data : "0x";
      verdict = /^0x0*1$/.test(out) ? true : /^0x0*$/.test(out) ? false : "unverifiable";
    } catch (e) {
      verdict = isRevert(e) ? false : "unverifiable";
    } finally {
      if (timer) clearTimeout(timer);
      inflight--;
    }
    // Only a definite answer is cached; an RPC failure is tried afresh.
    if (verdict !== "unverifiable") {
      if (cache.size > 2000) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now(), verdict });
    }
    return verdict;
  };
}

/**
 * Circle facilitator client, Arc only. Subclasses the stock client so every
 * consumer that expects one (the resource server, the label wrapper, the
 * memoizer) treats it as one, and overrides all three calls.
 *
 * The base URL is deliberately NOT exposed as `url`: src/payments.js registers
 * any client `url` with the facilitator diagnostics, which log an excerpt of a
 * non-JSON error body. This client's errors are already reduced.
 */
export class CircleFacilitatorClient extends HTTPFacilitatorClient {
  constructor({ apiKey, fetchImpl, now, pendingBudgetMs = PENDING_BUDGET_MS, pendingPollMs = PENDING_POLL_MS, onPending = null, contractVerifier = null, profiles = [ARC_PROFILE], label = CIRCLE_LABEL, upto = false } = {}) {
    super({ url: "http://127.0.0.1:0" });
    // The stock constructor sets `url`; remove it (see the class comment).
    delete this.url;
    const key = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!key) throw new Error("CircleFacilitatorClient needs an API key");
    // Held in a closure, not a property, so serializing or inspecting the
    // client never prints it.
    this._auth = () => ({ Authorization: `Bearer ${key}` });
    this._fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this._now = now || (() => Date.now());
    this._pendingBudgetMs = pendingBudgetMs;
    this._pendingPollMs = pendingPollMs;
    // Called with { paymentId, payer, network, amount, resource } for a
    // settlement still pending after the reconcile window (src/circle-pending.js).
    this._onPending = typeof onPending === "function" ? onPending : null;
    // Set only with ARC_CONTRACT_WALLETS=on (circleClientFromEnv): verifies a
    // contract-wallet signature on chain; null refuses every one, as before.
    // The networks this instance verifies and settles (Arc by default; the
    // Base and Polygon settle fallback names its own). Nothing else passes
    // the preflight, /supported reports only these, and a status or settle
    // answer naming another network is not proof.
    const list = Array.isArray(profiles) && profiles.length ? profiles : [ARC_PROFILE];
    this._profiles = Object.freeze([...list]);
    this._networks = new Set(this._profiles.map((p) => p.caip2));
    // `upto` on Arc only, and only when asked (X402_UPTO_NETWORKS names
    // eip155:5042): /supported then also reports Circle's Arc upto kind and
    // the preflight admits a Permit2 payment. Off, upto is refused as before.
    this._uptoNetworks = Object.freeze(upto === true && this._networks.has(ARC_CAIP2) ? [ARC_CAIP2] : []);
    // The verifier checks against Arc's domain and Arc's RPC, so it is kept
    // only by an instance that settles Arc, and handed to the preflight only
    // for an Arc requirement (_preflight). Any other network refuses every
    // signature that is not a local EOA one, whatever was passed here.
    this._contractVerifier = typeof contractVerifier === "function" && this._networks.has(ARC_CAIP2) ? contractVerifier : null;
    this._label = String(label || CIRCLE_LABEL);
  }

  /** The CAIP-2 networks this instance settles. */
  get networks() { return [...this._networks]; }

  _preflight(paymentPayload, paymentRequirements, { settle = false } = {}) {
    if (paymentRequirements?.scheme === "upto" && this._uptoNetworks.includes(paymentRequirements?.network)) {
      return preflightUptoPayment(paymentPayload, paymentRequirements, Math.floor(this._now() / 1000), { profiles: this._profiles, settle });
    }
    const contractVerifier = paymentRequirements?.network === ARC_CAIP2 ? this._contractVerifier : null;
    return preflightUsdcPayment(paymentPayload, paymentRequirements, Math.floor(this._now() / 1000), { contractVerifier, profiles: this._profiles });
  }

  /** Circle's final word on one payment: { status, transaction, network } with
   *  status "pending" | "completed" | "failed", or null when it cannot be read.
   *  With `network` (the one the payment was booked or settled on), an answer
   *  naming any other network is null, never a settlement. An answer naming
   *  none is read as `network`: the payment id is the one issued for the
   *  settle we sent on that network (the caller refuses an id booked twice). */
  async paymentStatus(paymentId, { network: expected } = {}) {
    if (typeof paymentId !== "string" || !UUID.test(paymentId)) return null;
    if (expected !== undefined && !this._networks.has(expected)) return null;
    let r;
    try { r = await this._request("status", `/status/${paymentId}`, { timeoutMs: VERIFY_TIMEOUT_MS }); } catch { return null; }
    if (!r.ok || r.parseError || !isObj(r.data)) return null;
    const { status, transaction, network } = r.data;
    if (network !== undefined && !this._networks.has(network)) return null;
    if (expected !== undefined && network !== undefined && network !== expected) return null;
    if (expected === undefined && network === undefined && this._networks.size !== 1) return null;
    const named = network === undefined ? expected : network;
    if (status === "completed") return TX.test(String(transaction || "")) ? { status, transaction, network: named } : null;
    if (status === "failed" || status === "pending") return { status, transaction: null, network: named };
    return null;
  }

  toJSON() { return { facilitator: this._label }; }

  async _request(op, path, { method = "GET", body, auth = true, timeoutMs }) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) Object.assign(headers, this._auth());
    let res;
    try {
      res = await this._fetch(`${CIRCLE_FACILITATOR_BASE}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = String(e?.name || "");
      const reason = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error";
      const err = new CircleResponseError(op, 0, reason);
      // Keep the shape the failure hooks read for "may have broadcast".
      if (reason === "timeout") err.name = "TimeoutError";
      else err.code = "CIRCLE_NETWORK_ERROR";
      throw err;
    }
    if (res.status >= 300 && res.status < 400) {
      throw new CircleResponseError(op, res.status, "redirect_refused");
    }
    let data = null;
    let parseError = null;
    try { data = await readJsonCapped(res, op); } catch (e) { parseError = e; }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, data, parseError };
  }

  async getSupported() {
    const r = await this._request("supported", "/supported", { auth: false, timeoutMs: SUPPORTED_TIMEOUT_MS });
    if (!r.ok) throw new CircleResponseError("supported", r.status, r.parseError ? r.parseError.reason : reasonFromErrorBody(r.data, r.status));
    if (r.parseError) throw r.parseError;
    return usdcKindsFromSupported(r.data, this._profiles, { uptoNetworks: this._uptoNetworks });
  }

  async verify(paymentPayload, paymentRequirements) {
    const refused = await this._preflight(paymentPayload, paymentRequirements);
    if (refused) return { isValid: false, invalidReason: refused.reason, payer: refused.payer };
    const r = await this._request("verify", "/verify", {
      method: "POST", timeoutMs: VERIFY_TIMEOUT_MS,
      body: { x402Version: paymentPayload.x402Version, paymentPayload: this.toJsonSafe(paymentPayload), paymentRequirements: this.toJsonSafe(paymentRequirements) },
    });
    if (!r.ok || r.parseError || !isObj(r.data) || typeof r.data.isValid !== "boolean") {
      const reason = r.parseError ? r.parseError.reason : !r.ok ? reasonFromErrorBody(r.data, r.status) : "invalid_verify_response";
      throw new VerifyError(r.ok ? 502 : r.status, { isValid: false, invalidReason: reason, invalidMessage: `Circle facilitator answered HTTP ${r.status}` });
    }
    // The payer is the signer this server verified (authorization.from, bound
    // by the local signature check or, for a contract wallet, by its on-chain
    // check), never an address the facilitator names.
    const payer = signerOf(paymentPayload);
    if (r.data.isValid === true) return { isValid: true, payer };
    return { isValid: false, invalidReason: safeReason(r.data.invalidReason), payer };
  }

  async settle(paymentPayload, paymentRequirements) {
    // The requirement's network once the preflight has accepted it; a refusal
    // names it only when it is one of ours.
    const network = this._networks.has(paymentRequirements?.network) ? paymentRequirements.network : this._profiles[0].caip2;
    const signedFrom = signerOf(paymentPayload);
    const refused = await this._preflight(paymentPayload, paymentRequirements, { settle: true });
    if (refused) return { success: false, errorReason: refused.reason, transaction: "", network, payer: refused.payer };
    const r = await this._request("settle", "/settle", {
      method: "POST", timeoutMs: SETTLE_TIMEOUT_MS,
      body: { x402Version: paymentPayload.x402Version, paymentPayload: this.toJsonSafe(paymentPayload), paymentRequirements: this.toJsonSafe(paymentRequirements) },
    });
    const bad = (status, reason) => new SettleError(status, {
      success: false, errorReason: reason, errorMessage: `Circle facilitator answered HTTP ${r.status}`,
      transaction: "", network, payer: ADDR.test(String(signedFrom || "")) ? signedFrom : undefined,
    });
    if (!r.ok) throw bad(r.status, r.parseError ? r.parseError.reason : reasonFromErrorBody(r.data, r.status));
    if (r.parseError) throw bad(502, r.parseError.reason);
    const d = r.data;
    if (!isObj(d) || typeof d.success !== "boolean") throw bad(502, "invalid_settle_response");
    const payer = signedFrom; // verified by the preflight above, never Circle's word
    if (d.success === true) {
      // A success must name a transaction on the requirement's network;
      // anything else is not proof.
      if (!TX.test(String(d.transaction || "")) || (d.network !== undefined && d.network !== network)) {
        throw bad(502, "invalid_settle_response");
      }
      return { success: true, transaction: d.transaction, network, payer };
    }
    const reason = safeReason(d.errorReason);
    if (reason === "settlement_pending") {
      const paymentId = d?.extensions?.["settlement-status"]?.paymentId;
      if (typeof paymentId === "string" && UUID.test(paymentId)) {
        const resolved = await this._awaitPending(paymentId, payer, network);
        if (resolved) return resolved;
        // Still unresolved: the buyer is refused now, and the payment is booked
        // by paymentId so a later pass turns a late completion into an owed
        // refund instead of a silent charge.
        if (this._onPending) {
          try {
            await this._onPending({ paymentId, payer, network, nonce: pendingNonceOf(paymentPayload), amount: String(paymentRequirements?.amount ?? ""), resource: paymentPayload?.resource?.url });
          } catch { /* booking never breaks the settle path */ }
        }
      }
      console.warn(`[circle] ${network} settlement still pending after the reconcile window; not reported as settled`);
    }
    return { success: false, errorReason: reason, transaction: "", network, payer };
  }

  /** Poll /status/{paymentId} until terminal or the budget runs out. Returns
   *  a settle result for a terminal outcome, null while still pending. */
  async _awaitPending(paymentId, payer, network = ARC_CAIP2) {
    const deadline = this._now() + this._pendingBudgetMs;
    while (this._now() < deadline) {
      await new Promise((r) => setTimeout(r, this._pendingPollMs));
      const s = await this.paymentStatus(paymentId, { network });
      if (s?.status === "completed") return { success: true, transaction: s.transaction, network, payer };
      if (s?.status === "failed") return { success: false, errorReason: "settlement_failed", transaction: "", network, payer };
    }
    return null;
  }
}

/** The Arc client when a key is configured, else null. */
export function circleClientFromEnv(env = process.env, opts = {}) {
  const key = String(env.CIRCLE_FACILITATOR_API_KEY || "").trim();
  if (!key) return null;
  const contractVerifier = arcContractWalletsEnabled(env)
    ? (opts.contractVerifier || createContractVerifier({ rpcUrl: EVM_RPCS[ARC_CAIP2] }))
    : null;
  return new CircleFacilitatorClient({ apiKey: key, ...opts, contractVerifier });
}

/** CIRCLE_FACILITATOR_EVM_FALLBACK=on turns the Base and Polygon settle
 *  fallback on; anything else (unset included) is off. */
export function circleEvmFallbackEnabled(env = process.env) {
  return String(env.CIRCLE_FACILITATOR_EVM_FALLBACK || "").trim().toLowerCase() === "on";
}

/** The Base and Polygon settle-fallback client when its switch is on and the
 *  key is set, else null. Restricted to `networks` (those offered), never
 *  given the Arc contract-wallet verifier. */
export function circleEvmFallbackFromEnv(env = process.env, { networks = CIRCLE_EVM_FALLBACK_NETWORKS, ...opts } = {}) {
  if (!circleEvmFallbackEnabled(env)) return null;
  const key = String(env.CIRCLE_FACILITATOR_API_KEY || "").trim();
  if (!key) return null;
  const profiles = CIRCLE_EVM_FALLBACK_PROFILES.filter((p) => networks.includes(p.caip2));
  if (!profiles.length) return null;
  return new CircleFacilitatorClient({ apiKey: key, ...opts, contractVerifier: null, profiles, label: CIRCLE_EVM_LABEL });
}

/** True when the Arc rail's switch (the Circle key) is set. Never returns the key. */
export function circleKeyConfigured(env = process.env) {
  return !!String(env.CIRCLE_FACILITATOR_API_KEY || "").trim();
}
