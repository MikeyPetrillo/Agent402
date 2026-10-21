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
import { SettleError, VerifyError } from "@x402/core/types";
import { verifyTypedData, parseCompactSignature, compactSignatureToSignature, serializeSignature } from "viem";
import {
  ARC_CAIP2, ARC_CHAIN_ID, ARC_USDC, CIRCLE_FACILITATOR_BASE, CIRCLE_LABEL,
  CircleResponseError, safeReason, arcKindsFromSupported,
} from "./circle-supported.js";

export {
  ARC_CAIP2, ARC_CHAIN_ID, ARC_USDC, CIRCLE_FACILITATOR_BASE, CIRCLE_LABEL,
  safeReason, arcKindsFromSupported,
};
export { isArcNetwork, stripArcFromSupported, withoutArcKinds } from "./circle-supported.js";

const MAX_BODY_BYTES = 64 * 1024;
const SUPPORTED_TIMEOUT_MS = 10_000;
const VERIFY_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 30_000;
const PENDING_POLL_MS = 1_000;
const PENDING_BUDGET_MS = 20_000;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UINT = /^[0-9]{1,78}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;

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

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const lc = (s) => String(s || "").toLowerCase();

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
  // Every signature is checked here, under ARC's own domain, in whatever form
  // it comes (65-byte with v 27/28 or 0/1, or 64-byte EIP-2098 compact). One
  // made for Base, for another chainId or for another token recovers to
  // someone else and is refused. A form that cannot be verified locally (a
  // contract wallet's ERC-1271 or ERC-6492 signature) is refused too: nothing
  // reaches Circle that this server has not verified itself.
  let valid = false;
  try {
    // viem verifies 65-byte signatures (v 27/28 or 0/1); a 64-byte EIP-2098
    // compact one is expanded to that form first.
    const full = sig.length === 130 ? serializeSignature(compactSignatureToSignature(parseCompactSignature(sig))) : sig;
    valid = await verifyTypedData({ address: auth.from, ...arcTypedData(auth), signature: full });
  } catch { valid = false; }
  if (!valid) return refuse("invalid_exact_evm_payload_signature", payer);
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
  constructor({ apiKey, fetchImpl, now, pendingBudgetMs = PENDING_BUDGET_MS, pendingPollMs = PENDING_POLL_MS, onPending = null } = {}) {
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
  }

  /** Circle's final word on one payment: { status, transaction } with status
   *  "pending" | "completed" | "failed", or null when it cannot be read. */
  async paymentStatus(paymentId) {
    if (typeof paymentId !== "string" || !UUID.test(paymentId)) return null;
    let r;
    try { r = await this._request("status", `/status/${paymentId}`, { timeoutMs: VERIFY_TIMEOUT_MS }); } catch { return null; }
    if (!r.ok || r.parseError || !isObj(r.data)) return null;
    const { status, transaction, network } = r.data;
    if (network !== undefined && network !== ARC_CAIP2) return null;
    if (status === "completed") return TX.test(String(transaction || "")) ? { status, transaction } : null;
    if (status === "failed" || status === "pending") return { status, transaction: null };
    return null;
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
        // Still unresolved: the buyer is refused now, and the payment is booked
        // by paymentId so a later pass turns a late completion into an owed
        // refund instead of a silent charge.
        if (this._onPending) {
          try {
            await this._onPending({ paymentId, payer, network, amount: String(paymentRequirements?.amount ?? ""), resource: paymentPayload?.resource?.url });
          } catch { /* booking never breaks the settle path */ }
        }
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
      const s = await this.paymentStatus(paymentId);
      if (s?.status === "completed") return { success: true, transaction: s.transaction, network: ARC_CAIP2, payer };
      if (s?.status === "failed") return { success: false, errorReason: "settlement_failed", transaction: "", network: ARC_CAIP2, payer };
    }
    return null;
  }
}

/** The Arc client when a key is configured, else null. */
export function circleClientFromEnv(env = process.env, opts = {}) {
  const key = String(env.CIRCLE_FACILITATOR_API_KEY || "").trim();
  return key ? new CircleFacilitatorClient({ apiKey: key, ...opts }) : null;
}

/** True when the Arc rail's switch (the Circle key) is set. Never returns the key. */
export function circleKeyConfigured(env = process.env) {
  return !!String(env.CIRCLE_FACILITATOR_API_KEY || "").trim();
}
