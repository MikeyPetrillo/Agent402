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
//      drops Arc from the offer at boot (src/payments.js).
//   4. A local preflight on verify and settle: the requirement must be Arc
//      exact USDC, the signed authorization must pay that payTo exactly that
//      amount inside its validity window, and an EOA-shaped signature must
//      recover to the payer under Arc's own EIP-712 domain. A payment signed
//      for another chain or another token is refused here, before Circle sees
//      it. Contract-wallet signatures (ERC-1271) are left to Circle, which
//      checks them on chain.
//   5. `settlement_pending` (the outcome was unresolved inside Circle's wait
//      window) is reconciled by polling /status for a bounded time, so a
//      payment that lands a moment later is reported as the settlement it is.
//
// The base URL is a constant. Nothing in a request can change the host, and
// the API key is read from the environment by the caller and held only in
// this instance's closure.
import { HTTPFacilitatorClient } from "@x402/core/server";
import { SettleError, VerifyError } from "@x402/core/types";
import { recoverTypedDataAddress } from "viem";

export const ARC_CAIP2 = "eip155:5042";
export const ARC_CHAIN_ID = 5042;
/** Arc native USDC, verified on chain 2026-10-20: decimals() 6,
 *  DOMAIN_SEPARATOR() rebuilds from ("USDC", "2", 5042, asset). */
export const ARC_USDC = Object.freeze({
  asset: "0x3600000000000000000000000000000000000000",
  decimals: 6,
  name: "USDC",
  version: "2",
});
export const CIRCLE_FACILITATOR_BASE = "https://api.circle.com/v1/facilitator/x402";
export const CIRCLE_LABEL = "Circle (Arc)";

const MAX_BODY_BYTES = 64 * 1024;
const SUPPORTED_TIMEOUT_MS = 10_000;
const VERIFY_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 30_000;
const PENDING_POLL_MS = 1_000;
const PENDING_BUDGET_MS = 20_000;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON = /^[a-z0-9_]{1,64}$/;
const UINT = /^[0-9]{1,78}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;

/** A reason code we are willing to repeat: lower snake case, bounded. Anything
 *  else (prose, markup, an echoed header) becomes a fixed placeholder. */
export function safeReason(value, fallback = "circle_unrecognized_reason") {
  const s = typeof value === "string" ? value.trim() : "";
  return REASON.test(s) ? s : fallback;
}

/** The first machine reason in a Circle ErrorResponse ({code, message, errors:[{reason}]}),
 *  or a status-derived code. The message field is never read. */
function reasonFromErrorBody(data, status) {
  const first = data && typeof data === "object" && Array.isArray(data.errors) ? data.errors[0] : null;
  const r = first && typeof first === "object" ? first.reason : null;
  return safeReason(r, `circle_http_${Number(status) || 0}`);
}

class CircleResponseError extends Error {
  constructor(op, status, reason) {
    super(`Circle facilitator ${op} failed (${Number(status) || 0}): ${reason}`);
    this.name = "CircleResponseError";
    this.status = Number(status) || 0;
    this.reason = reason;
  }
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

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const lc = (s) => String(s || "").toLowerCase();

/** Reduce Circle's /supported to the one kind we route here: Arc `exact` on the
 *  Arc USDC asset. Malformed input throws (the boot guard then drops Arc). */
export function arcKindsFromSupported(data) {
  if (!isObj(data) || !Array.isArray(data.kinds) || data.kinds.length > 500) {
    throw new CircleResponseError("supported", 200, "invalid_supported_shape");
  }
  const kinds = [];
  for (const k of data.kinds) {
    if (!isObj(k) || typeof k.scheme !== "string" || typeof k.network !== "string") {
      throw new CircleResponseError("supported", 200, "invalid_supported_kind");
    }
    if (k.scheme !== "exact" || k.network !== ARC_CAIP2) continue;
    if (k.x402Version !== undefined && k.x402Version !== 2) continue;
    // A listed asset must be the Arc USDC we price in; a kind for any other
    // token on Arc is not one we can settle.
    if (k.asset !== undefined && lc(k.asset) !== lc(ARC_USDC.asset)) continue;
    const extra = isObj(k.extra) ? k.extra : {};
    if (extra.name !== undefined && extra.name !== ARC_USDC.name) continue;
    if (extra.version !== undefined && extra.version !== ARC_USDC.version) continue;
    kinds.push({ x402Version: 2, scheme: "exact", network: ARC_CAIP2, extra: { name: ARC_USDC.name, version: ARC_USDC.version } });
    break;
  }
  const extensions = Array.isArray(data.extensions)
    ? data.extensions.filter((e) => typeof e === "string" && REASON.test(e.replace(/-/g, "_")) && e.length <= 64)
    : [];
  const signers = {};
  const arcSigners = isObj(data.signers) ? data.signers[ARC_CAIP2] : null;
  if (Array.isArray(arcSigners)) signers[ARC_CAIP2] = arcSigners.filter((a) => typeof a === "string" && ADDR.test(a)).slice(0, 32);
  return { kinds, extensions, signers };
}

/** The EIP-3009 typed data a buyer signs for an Arc USDC exact payment. */
function arcTypedData(auth) {
  return {
    domain: { name: ARC_USDC.name, version: ARC_USDC.version, chainId: ARC_CHAIN_ID, verifyingContract: ARC_USDC.asset },
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
export async function preflightArcPayment(paymentPayload, requirements, nowSec = Math.floor(Date.now() / 1000)) {
  const refuse = (reason, payer) => ({ reason, payer: ADDR.test(String(payer || "")) ? payer : undefined });
  if (!isObj(requirements) || requirements.scheme !== "exact") return refuse("unsupported_scheme");
  if (requirements.network !== ARC_CAIP2) return refuse("invalid_network");
  if (lc(requirements.asset) !== lc(ARC_USDC.asset)) return refuse("invalid_payment_requirements");
  if (!ADDR.test(String(requirements.payTo || "")) || !UINT.test(String(requirements.amount ?? ""))) return refuse("invalid_payment_requirements");
  if (!isObj(paymentPayload) || paymentPayload.x402Version !== 2) return refuse("invalid_x402_version");
  const accepted = paymentPayload.accepted;
  if (isObj(accepted) && (accepted.network !== ARC_CAIP2 || lc(accepted.asset) !== lc(ARC_USDC.asset))) return refuse("invalid_network");
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
  // EOA-shaped signature (65 bytes, v 27 or 28, the only EOA form Circle
  // accepts): it must recover to the payer under ARC's domain. A signature
  // made for Base (or any other chainId or token) recovers to someone else.
  if (sig.length === 132) {
    const v = parseInt(sig.slice(130), 16);
    if (v === 27 || v === 28) {
      let signer = null;
      try { signer = await recoverTypedDataAddress({ ...arcTypedData(auth), signature: sig }); } catch { signer = null; }
      if (!signer || lc(signer) !== lc(auth.from)) return refuse("invalid_exact_evm_payload_signature", payer);
    }
  }
  return null;
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
  constructor({ apiKey, fetchImpl, now, pendingBudgetMs = PENDING_BUDGET_MS, pendingPollMs = PENDING_POLL_MS } = {}) {
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
  }

  toJSON() { return { facilitator: CIRCLE_LABEL }; }

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
    return arcKindsFromSupported(r.data);
  }

  async verify(paymentPayload, paymentRequirements) {
    const refused = await preflightArcPayment(paymentPayload, paymentRequirements, Math.floor(this._now() / 1000));
    if (refused) return { isValid: false, invalidReason: refused.reason, payer: refused.payer };
    const r = await this._request("verify", "/verify", {
      method: "POST", timeoutMs: VERIFY_TIMEOUT_MS,
      body: { x402Version: paymentPayload.x402Version, paymentPayload: this.toJsonSafe(paymentPayload), paymentRequirements: this.toJsonSafe(paymentRequirements) },
    });
    if (!r.ok || r.parseError || !isObj(r.data) || typeof r.data.isValid !== "boolean") {
      const reason = r.parseError ? r.parseError.reason : !r.ok ? reasonFromErrorBody(r.data, r.status) : "invalid_verify_response";
      throw new VerifyError(r.ok ? 502 : r.status, { isValid: false, invalidReason: reason, invalidMessage: `Circle facilitator answered HTTP ${r.status}` });
    }
    const payer = ADDR.test(String(r.data.payer || "")) ? r.data.payer : paymentPayload?.payload?.authorization?.from;
    if (r.data.isValid === true) return { isValid: true, payer };
    return { isValid: false, invalidReason: safeReason(r.data.invalidReason), payer };
  }

  async settle(paymentPayload, paymentRequirements) {
    const network = ARC_CAIP2;
    const signedFrom = paymentPayload?.payload?.authorization?.from;
    const refused = await preflightArcPayment(paymentPayload, paymentRequirements, Math.floor(this._now() / 1000));
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
    const payer = ADDR.test(String(d.payer || "")) ? d.payer : (ADDR.test(String(signedFrom || "")) ? signedFrom : undefined);
    if (d.success === true) {
      // A success must name an Arc transaction; anything else is not proof.
      if (!TX.test(String(d.transaction || "")) || (d.network !== undefined && d.network !== ARC_CAIP2)) {
        throw bad(502, "invalid_settle_response");
      }
      return { success: true, transaction: d.transaction, network, payer };
    }
    const reason = safeReason(d.errorReason);
    if (reason === "settlement_pending") {
      const paymentId = d?.extensions?.["settlement-status"]?.paymentId;
      if (typeof paymentId === "string" && UUID.test(paymentId)) {
        const resolved = await this._awaitPending(paymentId, payer);
        if (resolved) return resolved;
      }
      console.warn("[circle] Arc settlement still pending after the reconcile window; not reported as settled");
    }
    return { success: false, errorReason: reason, transaction: "", network, payer };
  }

  /** Poll /status/{paymentId} until terminal or the budget runs out. Returns
   *  a settle result for a terminal outcome, null while still pending. */
  async _awaitPending(paymentId, payer) {
    const deadline = this._now() + this._pendingBudgetMs;
    while (this._now() < deadline) {
      await new Promise((r) => setTimeout(r, this._pendingPollMs));
      let r;
      try {
        r = await this._request("status", `/status/${paymentId}`, { timeoutMs: VERIFY_TIMEOUT_MS });
      } catch {
        continue;
      }
      if (!r.ok || r.parseError || !isObj(r.data)) continue;
      const { status, transaction, network } = r.data;
      if (network !== undefined && network !== ARC_CAIP2) return { success: false, errorReason: "invalid_settle_response", transaction: "", network: ARC_CAIP2, payer };
      if (status === "completed" && TX.test(String(transaction || ""))) return { success: true, transaction, network: ARC_CAIP2, payer };
      if (status === "failed") return { success: false, errorReason: "settlement_failed", transaction: "", network: ARC_CAIP2, payer };
    }
    return null;
  }
}

/** The Arc client when a key is configured, else null. */
export function circleClientFromEnv(env = process.env) {
  const key = String(env.CIRCLE_FACILITATOR_API_KEY || "").trim();
  return key ? new CircleFacilitatorClient({ apiKey: key }) : null;
}

/** True when the Arc rail's switch (the Circle key) is set. Never returns the key. */
export function circleKeyConfigured(env = process.env) {
  return !!String(env.CIRCLE_FACILITATOR_API_KEY || "").trim();
}
