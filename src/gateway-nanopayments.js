// Circle Gateway nanopayments: batched, gas-free USDC x402 payments as a second
// accept beside the plain one on the networks the switch names.
//
// Switch: GATEWAY_NANOPAYMENTS=on (default off). Networks:
// GATEWAY_NANOPAYMENT_NETWORKS (default "arc,base"); a network is offered only
// when it is itself in the plain offer and Gateway's /v1/x402/supported lists
// its GatewayWalletBatched kind at boot. An unreadable or malformed /supported
// drops the option everywhere and nothing else (fail closed, like Arc).
//
// Wire: the buyer signs an EIP-3009 TransferWithAuthorization under the
// GatewayWalletBatched EIP-712 domain (name, version, verifyingContract from
// /supported; chainId the network's own), to our treasury payTo, for exactly
// the amount the accept quoted, with maxTimeoutSeconds at least the kind's
// minValiditySeconds. Gateway verifies and settles it off chain
// (POST /v1/x402/verify, /v1/x402/settle, both keyless), locks the buyer's
// Gateway balance and credits ours; a batch lands on chain later. A seller
// withdraws by signing a transfer attestation (scripts/gateway-withdraw.js).
//
// Where it sits in the paywall: the accept is one more `exact` option built
// by src/payments.js acceptsForItem, so every hook the plain path runs (the
// client-gone abort, the wallet blocklist, the settlement claim, the late
// settlement book, the failure monitor) runs for it. @x402/core picks a
// facilitator by (scheme, network) only, which would hand a batched payment
// to the plain facilitator, so installGatewayRouting wraps the resource
// server's verifyPayment and settlePayment to run inside an async scope when
// the payment's `accepted` is the batched kind, and getFacilitatorClient to
// answer this client inside that scope. Every other payment reads the scope
// empty and goes exactly where it goes today.
//
// Like src/circle-facilitator.js: every upstream failure is reduced to an
// HTTP status and a short reason code from a closed alphabet (no body, no
// header is ever repeated); responses are untrusted (JSON only, byte cap,
// shape check, redirects refused); a local preflight refuses a payment that
// does not match the requirement or whose signature does not verify under
// the Gateway domain before Gateway sees it (EOA signatures only: Gateway
// takes no ERC-1271 signature on this path).
//
// `settlement_pending` from /settle is a distinct outcome: neither paid nor
// failed inside the call. The client first reads Gateway's transfer record
// for the authorization (GET /v1/x402/transfers?nonce=, keyless) for a
// bounded time, inside the CDN answer window when the request came through
// it (src/cdn-sync-window.js): a transfer Gateway accepted is served and
// booked like any settle success, one Gateway reports failed is refused (not
// charged). Still unresolved, it answers the buyer a 402 with nothing served
// (transaction empty, so the vendor's own pending retry does not resend the
// same nonce), is booked by its authorization in the pending book, and the
// 402 body asks for the SAME payment again after a short wait, never a new
// signature (src/gateway-wire.js classifySettlementPending). That resend is
// resolved against Gateway's record BEFORE anything is verified or settled
// again (installGatewayRouting): accepted, it is served and booked exactly
// once (the book entry is taken by one request and dropped on its final
// 200); still pending, it is refused at verify with the same words; failed,
// the entry is dropped and the buyer told nothing was charged.
//
// A batched payment never reaches a chain facilitator, the settle fallback,
// the verify failover or our relayer (src/payments.js): Gateway alone can
// settle a GatewayWalletBatched authorization.
import { SettleError, VerifyError } from "@x402/core/types";
import { AsyncLocalStorage } from "node:async_hooks";
import { verifyTypedData, parseCompactSignature, compactSignatureToSignature, serializeSignature } from "viem";
import { createJsonDocument } from "./json-document.js";
import { trackStoreReady, leased } from "./state-db.js";
import { randomUUID } from "node:crypto";
import { cdnSyncLeftMs } from "./cdn-sync-window.js";
import { GATEWAY_KIND_NAME, GATEWAY_PENDING_BOOKED, GATEWAY_WIRE, SETTLEMENT_FAILED_REASON, SETTLEMENT_PENDING_REASON, isGatewayBatchedPayment } from "./gateway-wire.js";

export { GATEWAY_KIND_NAME, GATEWAY_WIRE, SETTLEMENT_PENDING_REASON, isGatewayBatchedPayment, isGatewayBatchedHeader, isGatewayBatchedRequest, settlementKindOf } from "./gateway-wire.js";

export const GATEWAY_API_BASE = "https://gateway-api.circle.com";
export const GATEWAY_LABEL = "Circle Gateway (batched)";
/** The networks the switch may name, by the short name the env var takes. */
export const GATEWAY_NETWORK_NAMES = Object.freeze({ arc: "eip155:5042", base: "eip155:8453" });
/** Circle's Gateway domain ids for those networks (the balance and transfer APIs key on them). */
export const GATEWAY_DOMAINS = Object.freeze({ "eip155:5042": 26, "eip155:8453": 6 });
export const DEFAULT_NETWORKS = "arc,base";
/** Dollars in our Gateway balance past which the status word reads "withdraw". */
export const DEFAULT_WITHDRAW_ALERT_USD = 25;
/** Seconds added above the kind's minValiditySeconds, as Circle's own scheme does. */
export const VALIDITY_BUFFER_SECONDS = 100;

const MAX_BODY_BYTES = 64 * 1024;
const SUPPORTED_TIMEOUT_MS = 10_000;
const VERIFY_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 30_000;
const BALANCE_TIMEOUT_MS = 10_000;
const TRANSFER_TIMEOUT_MS = 8_000;
/** How long a settle Gateway answered settlement_pending waits for Gateway's
 *  transfer record before answering pending (GATEWAY_PENDING_WAIT_MS). */
export const DEFAULT_PENDING_WAIT_MS = 8_000;
export const PENDING_POLL_MS = 1_000;
/** Kept free at the end of a CDN request's answer window for the settle
 *  hooks and the write after the wait. */
export const CDN_PENDING_RESERVE_MS = 5_000;
/** A transfer in one of these states holds the buyer's Gateway balance for
 *  us: what a /settle success reports, so it is served the same way. Only
 *  confirmed and completed prove a debt for a refund (src/payment-verify.js),
 *  Gateway's own advice for accounting. */
export const ACCEPTED_TRANSFER_STATUSES = Object.freeze(["received", "batched", "confirmed", "completed"]);
const TRANSFER_STATUSES = new Set([...ACCEPTED_TRANSFER_STATUSES, "failed"]);

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UINT = /^[0-9]{1,78}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
const REASON = /^[a-z0-9_]{1,64}$/;
const VERSION = /^[0-9]{1,4}$/;
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const lc = (s) => String(s || "").toLowerCase();

/** A reason code we are willing to repeat; anything else becomes a placeholder. */
export function safeReason(value, fallback = "gateway_unrecognized_reason") {
  const s = typeof value === "string" ? value.trim() : "";
  return REASON.test(s) ? s : fallback;
}

/** Every Gateway failure: an HTTP status and a reason code, never a body. */
export class GatewayResponseError extends Error {
  constructor(op, status, reason) {
    super(`Circle Gateway ${op} failed (${Number(status) || 0}): ${reason}`);
    this.name = "GatewayResponseError";
    this.status = Number(status) || 0;
    this.reason = reason;
  }
}

/** GATEWAY_NANOPAYMENTS=on turns the option on; anything else is off. */
export function gatewayNanopaymentsEnabled(env = process.env) {
  return String(env.GATEWAY_NANOPAYMENTS || "").trim().toLowerCase() === "on";
}

/** The CAIP-2 networks the switch names (default arc,base); unknown names are
 *  dropped with a warning. Order follows the variable. */
export function gatewayNanopaymentNetworks(env = process.env, log = console.warn) {
  const raw = String(env.GATEWAY_NANOPAYMENT_NETWORKS ?? "").trim() || DEFAULT_NETWORKS;
  const out = [];
  for (const name of raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const caip2 = GATEWAY_NETWORK_NAMES[name] || (Object.values(GATEWAY_NETWORK_NAMES).includes(name) ? name : null);
    if (!caip2) { log(`[gateway] GATEWAY_NANOPAYMENT_NETWORKS names "${name}", which is not a network this option can settle (known: ${Object.keys(GATEWAY_NETWORK_NAMES).join(", ")}); ignored`); continue; }
    if (!out.includes(caip2)) out.push(caip2);
  }
  return out;
}

/** The dollar figure past which the balance word reads "withdraw". */
export function gatewayPendingWaitMs(env = process.env) {
  const n = Number(env.GATEWAY_PENDING_WAIT_MS);
  return Number.isFinite(n) && n >= 0 && n <= 60_000 ? n : DEFAULT_PENDING_WAIT_MS;
}

/**
 * One Gateway transfer record (GET /v1/x402/transfers/{id}, or an element of
 * the search answer), reduced to the fields we check, or null when its shape
 * is not the documented one. Never trusted beyond what it is matched against.
 */
export function normalizeGatewayTransfer(t) {
  if (!isObj(t)) return null;
  const id = String(t.id || "");
  const status = String(t.status || "");
  if (!UUID.test(id) || !TRANSFER_STATUSES.has(status)) return null;
  if (!ADDR.test(String(t.fromAddress || "")) || !ADDR.test(String(t.toAddress || ""))) return null;
  if (!UINT.test(String(t.amount ?? "")) || !B32.test(String(t.nonce || ""))) return null;
  const net = (v) => (typeof v === "string" && /^eip155:[0-9]{1,12}$/.test(v) ? v : null);
  return {
    id: id.toLowerCase(), status, token: typeof t.token === "string" ? t.token : null,
    from: lc(t.fromAddress), to: lc(t.toAddress), amount: String(t.amount), nonce: lc(t.nonce),
    sendingNetwork: net(t.sendingNetwork), recipientNetwork: net(t.recipientNetwork),
  };
}

/** True when a normalized transfer is THIS authorization: same nonce, same
 *  payer, to our payTo, for exactly the amount, in USDC, on this network. */
export function gatewayTransferMatches(t, { payer, payTo, amount, nonce, network }) {
  if (!t) return false;
  if (t.nonce !== lc(nonce) || t.from !== lc(payer) || t.to !== lc(payTo)) return false;
  if (t.token !== null && t.token !== "USDC") return false;
  if (!UINT.test(String(amount ?? "")) || BigInt(t.amount) !== BigInt(amount)) return false;
  return t.recipientNetwork === network || t.sendingNetwork === network;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export function gatewayWithdrawAlertUsd(env = process.env) {
  const n = Number(env.GATEWAY_WITHDRAW_ALERT_USD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WITHDRAW_ALERT_USD;
}

/**
 * Reduce Gateway's /v1/x402/supported to the kinds we can offer: one per
 * wanted network, scheme exact, extra.name GatewayWalletBatched, with the
 * USDC asset Gateway lists for it. Returns a Map caip2 -> kind. A malformed
 * answer throws (the boot check then drops the option everywhere); a wanted
 * network the answer does not list is simply absent from the map.
 */
export function gatewayKindsFromSupported(data, wanted = Object.values(GATEWAY_NETWORK_NAMES)) {
  if (!isObj(data) || !Array.isArray(data.kinds) || data.kinds.length > 500) {
    throw new GatewayResponseError("supported", 200, "invalid_supported_shape");
  }
  const want = new Set(wanted);
  const out = new Map();
  for (const k of data.kinds) {
    if (!isObj(k) || typeof k.scheme !== "string" || typeof k.network !== "string") {
      throw new GatewayResponseError("supported", 200, "invalid_supported_kind");
    }
    if (k.scheme !== "exact" || !want.has(k.network) || out.has(k.network)) continue;
    if (k.x402Version !== undefined && k.x402Version !== 2) continue;
    const extra = isObj(k.extra) ? k.extra : null;
    if (!extra || extra.name !== GATEWAY_KIND_NAME) continue;
    if (!ADDR.test(String(extra.verifyingContract || ""))) continue;
    const minValidity = Number(extra.minValiditySeconds);
    if (!Number.isInteger(minValidity) || minValidity <= 0 || minValidity > 100_000_000) continue;
    const assets = Array.isArray(extra.assets) ? extra.assets : [];
    const usdc = assets.find((a) => isObj(a) && a.symbol === "USDC" && ADDR.test(String(a.address || "")) && (a.decimals === undefined || a.decimals === 6));
    if (!usdc) continue;
    const versions = Array.isArray(usdc.authorizationVersions) ? usdc.authorizationVersions.filter((v) => typeof v === "string" && VERSION.test(v)) : [];
    // The domain version the buyer signs: the kind's own, which must be one
    // the asset accepts when it lists any; else the lowest the asset accepts.
    let version = typeof extra.version === "string" && VERSION.test(extra.version) ? extra.version : null;
    if (version && versions.length && !versions.includes(version)) version = null;
    if (!version && versions.length) version = versions.map(Number).sort((a, b) => a - b)[0].toString();
    if (!version) continue;
    out.set(k.network, Object.freeze({
      network: k.network,
      chainId: Number(k.network.split(":")[1]),
      name: GATEWAY_KIND_NAME,
      version,
      verifyingContract: String(extra.verifyingContract),
      minValiditySeconds: minValidity,
      maxTimeoutSeconds: minValidity + VALIDITY_BUFFER_SECONDS,
      asset: lc(usdc.address),
      decimals: 6,
    }));
  }
  return out;
}

/** The accept fields one network's batched option adds to the plain accept. */
export function gatewayAcceptFields(kind) {
  return {
    maxTimeoutSeconds: kind.maxTimeoutSeconds,
    extra: { name: kind.name, version: kind.version, verifyingContract: kind.verifyingContract },
  };
}

/** The EIP-712 typed data a buyer signs for a batched payment on `kind`'s network. */
export function gatewayTypedData(kind, auth) {
  return {
    domain: { name: kind.name, version: kind.version, chainId: kind.chainId, verifyingContract: kind.verifyingContract },
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

/** True when `sig` is a valid ECDSA signature by `auth.from` over the Gateway
 *  typed data for `kind`. Pure: no RPC call. */
export async function isGatewayEoaSignature(kind, auth, sig) {
  try {
    const full = sig.length === 130 ? serializeSignature(compactSignatureToSignature(parseCompactSignature(sig))) : sig;
    return await verifyTypedData({ address: auth.from, ...gatewayTypedData(kind, auth), signature: full });
  } catch { return false; }
}

/**
 * Local preflight for a batched payment. Returns null when it may go to
 * Gateway, or { reason, payer } when it must be refused here. Reason words
 * are Gateway's own where one exists.
 */
export async function preflightGatewayPayment(paymentPayload, requirements, kinds, nowSec = Math.floor(Date.now() / 1000)) {
  const refuse = (reason, payer) => ({ reason, payer: ADDR.test(String(payer || "")) ? payer : undefined });
  if (!isObj(requirements) || requirements.scheme !== "exact") return refuse("unsupported_scheme");
  const kind = kinds instanceof Map ? kinds.get(requirements.network) : null;
  if (!kind) return refuse("unsupported_network");
  if (!isObj(requirements.extra) || requirements.extra.name !== GATEWAY_KIND_NAME) return refuse("unsupported_domain");
  if (lc(requirements.asset) !== kind.asset) return refuse("unsupported_asset");
  if (!ADDR.test(String(requirements.payTo || "")) || !UINT.test(String(requirements.amount ?? ""))) return refuse("invalid_payload");
  if (!isObj(paymentPayload) || paymentPayload.x402Version !== 2) return refuse("invalid_payload");
  if (!isGatewayBatchedPayment(paymentPayload)) return refuse("unsupported_domain");
  const accepted = paymentPayload.accepted;
  if (accepted.network !== requirements.network || lc(accepted.asset) !== kind.asset) return refuse("unsupported_network");
  const inner = paymentPayload.payload;
  const auth = isObj(inner) ? inner.authorization : null;
  const sig = isObj(inner) ? inner.signature : null;
  if (!isObj(auth) || typeof sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(sig)) return refuse("invalid_payload");
  const payer = auth.from;
  if (!ADDR.test(String(auth.from || "")) || !ADDR.test(String(auth.to || ""))) return refuse("invalid_payload", payer);
  for (const f of ["value", "validAfter", "validBefore"]) if (!UINT.test(String(auth[f] ?? ""))) return refuse("invalid_payload", payer);
  if (!B32.test(String(auth.nonce || ""))) return refuse("invalid_payload", payer);
  if (lc(auth.to) !== lc(requirements.payTo)) return refuse("address_mismatch", payer);
  if (lc(auth.from) === lc(auth.to)) return refuse("self_transfer", payer);
  if (BigInt(auth.value) !== BigInt(requirements.amount)) return refuse("amount_mismatch", payer);
  if (BigInt(auth.validAfter) > BigInt(nowSec)) return refuse("authorization_not_yet_valid", payer);
  if (BigInt(auth.validBefore) <= BigInt(nowSec + 6)) return refuse("authorization_expired", payer);
  if (sig.length !== 132 && sig.length !== 130) return refuse("invalid_signature", payer);
  if (sig.length === 132 && BigInt(`0x${sig.slice(66, 130)}`) > SECP256K1_HALF_N) return refuse("invalid_signature", payer);
  if (!(await isGatewayEoaSignature(kind, auth, sig))) return refuse("invalid_signature", payer);
  return null;
}

/**
 * The check a resend of a booked pending payment passes before it is served
 * on Gateway's transfer record: the preflight without the clock (the
 * authorization was already spent at Gateway; its validity window no longer
 * decides anything). Returns null, or a refusal reason.
 */
async function resumeCheck(paymentPayload, requirements, kinds) {
  const kind = kinds instanceof Map ? kinds.get(requirements?.network) : null;
  if (!kind || !isObj(requirements) || requirements.scheme !== "exact" || !isGatewayBatchedPayment(paymentPayload)) return "unsupported_network";
  if (lc(requirements.asset) !== kind.asset || paymentPayload.accepted.network !== requirements.network) return "unsupported_network";
  const auth = paymentPayload?.payload?.authorization;
  const sig = paymentPayload?.payload?.signature;
  if (!isObj(auth) || typeof sig !== "string" || !ADDR.test(String(auth.from || "")) || !UINT.test(String(auth.value ?? "")) || !UINT.test(String(requirements.amount ?? ""))) return "invalid_payload";
  if (lc(auth.to) !== lc(requirements.payTo)) return "address_mismatch";
  if (BigInt(auth.value) !== BigInt(requirements.amount)) return "amount_mismatch";
  if (!(await isGatewayEoaSignature(kind, auth, sig))) return "invalid_signature";
  return null;
}

/** The route a batched payment paid for, as the pending book keeps it:
 *  the request's method and path (no query), read from the request this
 *  server is answering, never from the buyer's payload. Null without one. */
export function gatewayResourceOf(req) {
  if (!req || typeof req !== "object" || typeof req.method !== "string") return null;
  const url = String(req.originalUrl || req.url || "");
  if (!url.startsWith("/")) return null;
  return `${req.method.toUpperCase()} ${url.split("?")[0].slice(0, 280)}`;
}

/** The first machine reason in an error body ({errors:[{reason}]} or {errorReason}), or a status code. */
function reasonFromErrorBody(data, status) {
  const first = isObj(data) && Array.isArray(data.errors) ? data.errors[0] : null;
  const r = isObj(first) ? first.reason : isObj(data) ? data.errorReason : null;
  return safeReason(r, `gateway_http_${Number(status) || 0}`);
}

/** Read a response body as JSON under a byte cap; throws GatewayResponseError with a reason, never the body. */
async function readJsonCapped(res, op) {
  const type = String(res.headers?.get?.("content-type") || "");
  if (!/\bjson\b/i.test(type)) {
    try { await res.body?.cancel?.(); } catch { /* nothing to release */ }
    throw new GatewayResponseError(op, res.status, "non_json_response");
  }
  const declared = Number(res.headers?.get?.("content-length") || 0);
  if (declared > MAX_BODY_BYTES) {
    try { await res.body?.cancel?.(); } catch { /* nothing to release */ }
    throw new GatewayResponseError(op, res.status, "response_too_large");
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
        throw new GatewayResponseError(op, res.status, "response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } else {
    text = String(await res.text());
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new GatewayResponseError(op, res.status, "response_too_large");
  }
  try { return JSON.parse(text); } catch { throw new GatewayResponseError(op, res.status, "invalid_json"); }
}

/**
 * The Gateway client: /supported, verify, settle and the balance read. Keyless
 * on every call. Not a routing facilitator (never handed to x402ResourceServer's
 * constructor): installGatewayRouting hands it a batched payment by scope.
 */
export class GatewayNanopaymentsClient {
  constructor({ fetchImpl, now, networks = Object.values(GATEWAY_NETWORK_NAMES), onPending = null, pendingWaitMs = gatewayPendingWaitMs(), pendingPollMs = PENDING_POLL_MS } = {}) {
    this._fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this._now = now || (() => Date.now());
    this._wanted = [...networks];
    this._kinds = new Map();
    this._pendingWaitMs = pendingWaitMs;
    this._pendingPollMs = pendingPollMs;
    // Called with { payer, network, nonce, amount, payTo, resource } for a settle
    // Gateway answered settlement_pending (src/gateway-nanopayments.js book).
    this._onPending = typeof onPending === "function" ? onPending : null;
  }

  toJSON() { return { facilitator: GATEWAY_LABEL }; }

  /** The kinds the last /supported read kept (caip2 -> kind). */
  kinds() { return this._kinds; }

  async _request(op, path, { method = "GET", body, timeoutMs }) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await this._fetch(`${GATEWAY_API_BASE}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = String(e?.name || "");
      const reason = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error";
      const err = new GatewayResponseError(op, 0, reason);
      if (reason === "timeout") err.name = "TimeoutError";
      else err.code = "GATEWAY_NETWORK_ERROR";
      throw err;
    }
    if (res.status >= 300 && res.status < 400) throw new GatewayResponseError(op, res.status, "redirect_refused");
    let data = null;
    let parseError = null;
    try { data = await readJsonCapped(res, op); } catch (e) { parseError = e; }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, data, parseError };
  }

  /** Read /v1/x402/supported and keep the kinds for the wanted networks. */
  async getSupported() {
    const r = await this._request("supported", "/v1/x402/supported", { timeoutMs: SUPPORTED_TIMEOUT_MS });
    if (!r.ok) throw new GatewayResponseError("supported", r.status, r.parseError ? r.parseError.reason : reasonFromErrorBody(r.data, r.status));
    if (r.parseError) throw r.parseError;
    this._kinds = gatewayKindsFromSupported(r.data, this._wanted);
    return { kinds: [...this._kinds.values()].map((k) => ({ x402Version: 2, scheme: "exact", network: k.network, extra: { name: k.name, version: k.version, verifyingContract: k.verifyingContract } })) };
  }

  async verify(paymentPayload, paymentRequirements) {
    // A resend of a payment the pending book holds: decided from Gateway's
    // transfer record (installGatewayRouting), never verified at Gateway again.
    const resume = scope.getStore()?.resume;
    if (resume) {
      const payer = paymentPayload?.payload?.authorization?.from;
      if (resume.outcome !== "accepted") return { isValid: false, invalidReason: resume.outcome === "failed" ? SETTLEMENT_FAILED_REASON : resume.outcome === "served" ? "nonce_already_used" : resume.outcome === "mismatch" ? "resource_mismatch" : SETTLEMENT_PENDING_REASON, payer };
      const bad = await resumeCheck(paymentPayload, paymentRequirements, this._kinds);
      return bad ? { isValid: false, invalidReason: bad, payer } : { isValid: true, payer };
    }
    const refused = await preflightGatewayPayment(paymentPayload, paymentRequirements, this._kinds, Math.floor(this._now() / 1000));
    if (refused) return { isValid: false, invalidReason: refused.reason, payer: refused.payer };
    const r = await this._request("verify", "/v1/x402/verify", {
      method: "POST", timeoutMs: VERIFY_TIMEOUT_MS,
      body: { paymentPayload, paymentRequirements },
    });
    if (!r.ok || r.parseError || !isObj(r.data) || typeof r.data.isValid !== "boolean") {
      const reason = r.parseError ? r.parseError.reason : !r.ok ? reasonFromErrorBody(r.data, r.status) : "invalid_verify_response";
      throw new VerifyError(r.ok ? 502 : r.status, { isValid: false, invalidReason: reason, invalidMessage: `Circle Gateway answered HTTP ${r.status}` });
    }
    // The payer is the signer this server verified, never an address Gateway names.
    const payer = paymentPayload.payload.authorization.from;
    if (r.data.isValid === true) return { isValid: true, payer };
    return { isValid: false, invalidReason: safeReason(r.data.invalidReason), payer };
  }

  async settle(paymentPayload, paymentRequirements) {
    const network = paymentRequirements?.network;
    const signedFrom = paymentPayload?.payload?.authorization?.from;
    const store = scope.getStore();
    // A resend Gateway already accepted (installGatewayRouting): served on its
    // transfer record, with no second settle call.
    if (store?.resume) {
      const r = store.resume;
      const bad = r.outcome !== "accepted" ? SETTLEMENT_PENDING_REASON : await resumeCheck(paymentPayload, paymentRequirements, this._kinds);
      if (bad) return { success: false, errorReason: bad, transaction: "", network, payer: ADDR.test(String(signedFrom || "")) ? signedFrom : undefined };
      return { success: true, transaction: r.transfer.id, network, payer: signedFrom };
    }
    const refused = await preflightGatewayPayment(paymentPayload, paymentRequirements, this._kinds, Math.floor(this._now() / 1000));
    if (refused) return { success: false, errorReason: refused.reason, transaction: "", network, payer: refused.payer };
    const r = await this._request("settle", "/v1/x402/settle", {
      method: "POST", timeoutMs: SETTLE_TIMEOUT_MS,
      body: { paymentPayload, paymentRequirements },
    });
    const bad = (status, reason) => new SettleError(status, {
      success: false, errorReason: reason, errorMessage: `Circle Gateway answered HTTP ${r.status}`,
      transaction: "", network, payer: ADDR.test(String(signedFrom || "")) ? signedFrom : undefined,
    });
    if (!r.ok) throw bad(r.status, r.parseError ? r.parseError.reason : reasonFromErrorBody(r.data, r.status));
    if (r.parseError) throw bad(502, r.parseError.reason);
    const d = r.data;
    if (!isObj(d) || typeof d.success !== "boolean") throw bad(502, "invalid_settle_response");
    const payer = signedFrom; // verified by the preflight above
    if (d.success === true) {
      // A success names Gateway's transaction id (a UUID; a chain hash is also
      // taken) on this network; anything else is not proof of a settlement.
      const tx = String(d.transaction || "");
      if (!(UUID.test(tx) || TX_HASH.test(tx)) || (d.network !== undefined && d.network !== network)) throw bad(502, "invalid_settle_response");
      return { success: true, transaction: tx, network, payer };
    }
    const reason = safeReason(d.errorReason);
    if (reason === SETTLEMENT_PENDING_REASON) {
      // Neither paid nor failed inside the call. Gateway's transfer record
      // for this authorization is read for a bounded time first.
      const auth = paymentPayload?.payload?.authorization;
      const want = { payer, payTo: paymentRequirements?.payTo, amount: paymentRequirements?.amount, nonce: auth?.nonce, network };
      const found = await this._awaitTransfer(want, store?.req || null);
      if (found.state === "accepted") return { success: true, transaction: found.transfer.id, network, payer };
      if (found.state === "failed") return { success: false, errorReason: SETTLEMENT_FAILED_REASON, transaction: "", network, payer };
      // Still unresolved: refused to the buyer now, booked by its
      // authorization so the same payment resent later is resolved against
      // Gateway first. The transaction is left empty so @x402/core's own
      // pending retry never resends this nonce.
      if (this._onPending) {
        try {
          const booked = await this._onPending({ payer, network, nonce: auth?.nonce, amount: String(paymentRequirements?.amount ?? ""), payTo: paymentRequirements?.payTo, resource: gatewayResourceOf(store?.req) });
          if (booked === true && store?.req && typeof store.req === "object") store.req[GATEWAY_PENDING_BOOKED] = true;
        } catch { /* booking never breaks the settle path */ }
      }
      console.warn(`[gateway] batched settlement on ${network} still pending at Gateway after the wait; not reported as settled`);
    }
    return { success: false, errorReason: reason, transaction: "", network, payer };
  }

  /** The wait for a pending settlement: Gateway's transfer record for the
   *  authorization, polled until it answers or the budget ends. The budget
   *  is GATEWAY_PENDING_WAIT_MS, cut to the CDN answer window (less a
   *  reserve) for a request that came through the CDN proxy. */
  async _awaitTransfer(want, req) {
    let budget = this._pendingWaitMs;
    const left = cdnSyncLeftMs(req, this._now());
    if (left !== null) budget = Math.min(budget, left - CDN_PENDING_RESERVE_MS);
    const deadline = this._now() + budget;
    let last = { state: "none" };
    // Each read follows a pause (Gateway needs a moment to write the record)
    // and the last one lands at the deadline; a read never outlasts the
    // budget by more than a second.
    while (this._now() < deadline) {
      await sleepMs(Math.min(this._pendingPollMs, deadline - this._now()));
      last = await this.transferByAuthorization(want, { timeoutMs: Math.max(1000, Math.min(TRANSFER_TIMEOUT_MS, deadline - this._now())) });
      if (last.state === "accepted" || last.state === "failed") return last;
    }
    return last;
  }

  /** Gateway's transfer for one authorization (GET /v1/x402/transfers?nonce=,
   *  keyless): { state: "accepted" | "failed" | "none" | "unreadable",
   *  transfer }. Only a record that matches the authorization counts. */
  async transferByAuthorization(want, { timeoutMs = TRANSFER_TIMEOUT_MS } = {}) {
    if (!B32.test(String(want?.nonce || "")) || !ADDR.test(String(want?.payer || ""))) return { state: "unreadable" };
    let r;
    try {
      const q = new URLSearchParams({ nonce: lc(want.nonce), network: String(want.network || "") });
      r = await this._request("transfers", `/v1/x402/transfers?${q}`, { timeoutMs });
    } catch { return { state: "unreadable" }; }
    if (!r.ok || r.parseError || !isObj(r.data) || !Array.isArray(r.data.transfers) || r.data.transfers.length > 100) return { state: "unreadable" };
    const matches = r.data.transfers.map(normalizeGatewayTransfer).filter((t) => gatewayTransferMatches(t, want));
    const live = matches.find((t) => t.status !== "failed");
    if (live) return { state: "accepted", transfer: live };
    if (matches.length) return { state: "failed", transfer: matches[0] };
    return { state: "none" };
  }

  /**
   * Our available USDC in Gateway for `depositor`, summed over `domains`
   * (POST /v1/balances, keyless: a balance is readable by address). Returns
   * { usd, byDomain } or throws a GatewayResponseError.
   */
  async balances({ depositor, domains = Object.values(GATEWAY_DOMAINS) } = {}) {
    if (!ADDR.test(String(depositor || ""))) throw new GatewayResponseError("balances", 0, "invalid_depositor");
    const r = await this._request("balances", "/v1/balances", {
      method: "POST", timeoutMs: BALANCE_TIMEOUT_MS,
      body: { token: "USDC", sources: domains.map((domain) => ({ domain, depositor })) },
    });
    if (!r.ok) throw new GatewayResponseError("balances", r.status, r.parseError ? r.parseError.reason : reasonFromErrorBody(r.data, r.status));
    if (r.parseError) throw r.parseError;
    const rows = isObj(r.data) && Array.isArray(r.data.balances) ? r.data.balances : null;
    if (!rows) throw new GatewayResponseError("balances", r.status, "invalid_balances_response");
    const byDomain = {};
    let usd = 0;
    for (const row of rows) {
      if (!isObj(row) || !/^\d+(\.\d+)?$/.test(String(row.balance ?? ""))) throw new GatewayResponseError("balances", r.status, "invalid_balances_response");
      const n = Number(row.balance);
      byDomain[String(row.domain)] = n;
      usd += n;
    }
    return { usd: Number(usd.toFixed(6)), byDomain };
  }
}

// ---------------------------------------------------------------------------
// Routing: a batched payment goes to this client; every other payment reads
// the scope empty and takes the vendor's own lookup.
// ---------------------------------------------------------------------------
const scope = new AsyncLocalStorage();
const INSTALLED = Symbol.for("agent402.gatewayRouting");

/** The Gateway client bound to the current async scope, or null. */
export function activeGatewayClient() { return scope.getStore()?.client || null; }

/**
 * Wrap verifyPayment, settlePayment and getFacilitatorClient on an
 * x402ResourceServer INSTANCE. Idempotent per instance. `networks` is the set
 * of CAIP-2 ids the batched option is offered on: a batched payload for any
 * other network is refused by the client's own preflight (unsupported_network)
 * rather than handed to the plain facilitator.
 *
 * With `pendingBook` (createGatewayPendingBook), a batched payment whose
 * authorization the book holds is resolved against Gateway's transfer record
 * BEFORE any verify or settle call reaches Gateway:
 *   accepted -> one request takes the entry (claimResume), is verified and
 *               settled on the record (no Gateway call), and drops the entry
 *               on its final 200; any other end hands the entry back.
 *               `wasServed({ tx, network })` (a sale already booked for that
 *               transfer) drops the entry and refuses the resend instead.
 *   failed   -> the entry is dropped (Gateway charged nothing) and the resend
 *               is refused with settlement_failed.
 *   a resend for another route than the entry's (method and path) -> refused
 *               with resource_mismatch before Gateway is read; the entry stays.
 *   pending, unreadable, or another request holds the entry -> refused at
 *               verify with settlement_pending; the entry stays.
 */
export function installGatewayRouting(server, client, networks, { pendingBook = null, wasServed = null, log = console.warn } = {}) {
  if (!server || server[INSTALLED]) return server;
  const nets = networks instanceof Set ? networks : new Set(networks || []);
  const batched = (paymentPayload, requirements) => isGatewayBatchedPayment(paymentPayload) || (isObj(requirements) && isObj(requirements.extra) && requirements.extra.name === GATEWAY_KIND_NAME);
  const origVerify = server.verifyPayment.bind(server);
  const origSettle = server.settlePayment.bind(server);
  const origClient = server.getFacilitatorClient.bind(server);
  const reqOfTransport = (tc) => tc?.request?.adapter?.req || null;
  // Resumes taken by a verify in this process, for the settle of the same
  // request: by request when the transport names one, else by entry key.
  const byReq = new WeakMap();
  const byKey = new Map();

  async function resolvePending(paymentPayload, requirements, req) {
    if (!pendingBook) return null;
    const a = paymentPayload?.payload?.authorization;
    if (!isObj(a) || !ADDR.test(String(a.from || "")) || !B32.test(String(a.nonce || ""))) return null;
    const network = requirements?.network;
    const key = pendingKey(network, a.from, a.nonce);
    let entry = null;
    try { entry = await pendingBook.get(key); } catch { return { outcome: "pending", key }; }
    if (!entry) return null;
    // The resend must be for the route the entry was booked on (method and
    // path): a pending payment never buys a different route at the same
    // price. Refused before Gateway is read; the entry stays pending.
    if ((entry.resource ?? null) !== gatewayResourceOf(req)) return { outcome: "mismatch", key };
    const found = await client.transferByAuthorization({ payer: a.from, payTo: requirements?.payTo, amount: requirements?.amount, nonce: a.nonce, network });
    if (found.state === "failed") {
      try { await pendingBook.resolve(key, { outcome: "not_charged", note: "Gateway reports the transfer failed" }); } catch { /* the entry stays; nothing is served either way */ }
      return { outcome: "failed", key };
    }
    if (found.state !== "accepted") return { outcome: "pending", key };
    if (typeof wasServed === "function") {
      let served = false;
      try { served = !!(await wasServed({ tx: found.transfer.id, network })); } catch { return { outcome: "pending", key }; }
      if (served) {
        try { await pendingBook.resolve(key, { outcome: "served", note: "a sale is already booked for this transfer" }); } catch { /* refused either way */ }
        return { outcome: "served", key };
      }
    }
    const owner = randomUUID();
    let took = false;
    try { took = await pendingBook.claimResume(key, owner); } catch { took = false; }
    if (!took) return { outcome: "pending", key };
    const resume = { outcome: "accepted", key, owner, transfer: found.transfer, done: false };
    // The entry is dropped on this request's final 200 (served, and booked
    // once by the sale ledger) and handed back on any other end.
    const finish = async (served) => {
      if (resume.done) return;
      resume.done = true;
      byKey.delete(key);
      try {
        if (served) await pendingBook.resolve(key, { outcome: "served", note: "resent and served on Gateway's transfer record" });
        else await pendingBook.releaseResume(key, owner);
      } catch (e) { log(`[gateway] pending entry ${key} could not be ${served ? "dropped" : "handed back"}: ${String(e?.message || e).slice(0, 120)}`); }
    };
    resume.finish = finish;
    const res = req?.res;
    if (res && typeof res.once === "function") {
      byReq.set(req, resume);
      res.once("finish", () => { void finish(res.statusCode === 200); });
      res.once("close", () => { if (!res.writableFinished) void finish(false); });
    } else {
      byKey.set(key, resume);
    }
    return resume;
  }

  server.verifyPayment = async (paymentPayload, requirements, ...rest) => {
    if (!batched(paymentPayload, requirements)) return origVerify(paymentPayload, requirements, ...rest);
    const req = reqOfTransport(rest[1]);
    const resume = await resolvePending(paymentPayload, requirements, req);
    return scope.run({ client, network: requirements?.network, req, resume }, () => origVerify(paymentPayload, requirements, ...rest));
  };
  server.settlePayment = async (paymentPayload, requirements, ...rest) => {
    if (!batched(paymentPayload, requirements)) return origSettle(paymentPayload, requirements, ...rest);
    const req = reqOfTransport(rest[1]);
    const a = paymentPayload?.payload?.authorization;
    const key = isObj(a) ? pendingKey(requirements?.network, a.from, a.nonce) : null;
    const resume = (req && byReq.get(req)) || (key && byKey.get(key)) || null;
    // Without a response to watch, the settle's own outcome ends the resume.
    const watched = !!(req?.res && typeof req.res.once === "function");
    let result;
    try {
      result = await scope.run({ client, network: requirements?.network, req, resume }, () => origSettle(paymentPayload, requirements, ...rest));
    } catch (e) {
      if (resume && !watched) await resume.finish(false);
      throw e;
    }
    if (resume && !watched) await resume.finish(result?.success === true);
    return result;
  };
  server.getFacilitatorClient = (x402Version, network, scheme) => {
    const ctx = scope.getStore();
    if (ctx && scheme === "exact" && nets.has(String(network))) return ctx.client;
    return origClient(x402Version, network, scheme);
  };
  server[INSTALLED] = true;
  return server;
}

// ---------------------------------------------------------------------------
// The pending book: settlements Gateway answered settlement_pending, keyed by
// the authorization (network, payer, nonce). A resend of the same payment
// resolves its entry against Gateway's transfer record (installGatewayRouting);
// an entry no buyer comes back for is resolved by the pending resolver below
// (Gateway's transfer record, every ten minutes under a lease): confirmed and
// never served becomes an owed debt in the refund ledger, failed is dropped.
// Listed on /__operator/gateway-pending.json. Bounded; a full book refuses new
// entries loudly rather than dropping old ones.
// ---------------------------------------------------------------------------
export const PENDING_MAX_ENTRIES = 2000;
/** How long one resend may hold a pending entry before another may take it. */
export const RESUME_LEASE_MS = 10 * 60_000;
/** An entry still waiting this long reads "unresolved" (it pages):
 *  GATEWAY_PENDING_UNRESOLVED_HOURS, default 24. */
export const DEFAULT_PENDING_UNRESOLVED_HOURS = 24;
export function gatewayPendingUnresolvedMs(env = process.env) {
  const h = Number(env.GATEWAY_PENDING_UNRESOLVED_HOURS);
  return (Number.isFinite(h) && h > 0 && h <= 24 * 30 ? h : DEFAULT_PENDING_UNRESOLVED_HOURS) * 3_600_000;
}
export const pendingKey = (network, payer, nonce) => `${String(network)}|${lc(payer)}|${lc(nonce)}`;

export function createGatewayPendingBook({ file = process.env.GATEWAY_PENDING_FILE || "/data/gateway-pending.json", now = () => Date.now(), log = console.warn, maxEntries = PENDING_MAX_ENTRIES, unresolvedMs = gatewayPendingUnresolvedMs() } = {}) {
  let state = { pending: {} };
  const absorb = (s) => { if (isObj(s) && isObj(s.pending)) state = { pending: { ...s.pending } }; };
  const doc = createJsonDocument({ name: "gateway-pending", file, log: () => {} });
  absorb(doc.loadSync(null));
  const PG = doc.backend === "pg";
  const ready = trackStoreReady(PG ? doc.load(null).then(absorb) : Promise.resolve(), "gateway-pending");
  const refresh = async () => {
    try {
      const b = PG ? await doc.load(null) : doc.loadSync(null);
      if (isObj(b)) absorb(b); else state = { pending: {} };
    } catch { /* keep the last body read */ }
  };
  // One change at a time in this process (a file read between another
  // change's mutation and its save would lose that mutation); across
  // replicas the database update is the compare-and-set. A mutator may run
  // more than once under the database, so each run starts from the body it
  // is handed and decides afresh.
  let queue = Promise.resolve();
  const changeNow = async (fn) => {
    if (!PG) { await refresh(); fn(state.pending); await doc.save(state); return true; }
    const r = await doc.update((b) => { const pending = isObj(b) && isObj(b.pending) ? { ...b.pending } : {}; fn(pending); return { pending }; }, { fallback: null });
    if (r.ok) absorb(r.body);
    return !!r.ok;
  };
  const change = (fn) => { const run = queue.then(() => changeNow(fn), () => changeNow(fn)); queue = run.catch(() => {}); return run; };
  const entries = () => Object.values(state.pending);
  return {
    ready,
    refresh,
    /** Book one pending settlement under its authorization. False when refused or already there. */
    async book({ payer, network, nonce, amount, payTo, resource } = {}) {
      if (!ADDR.test(String(payer || "")) || !B32.test(String(nonce || "")) || !/^eip155:[0-9]{1,12}$/.test(String(network || ""))) return false;
      const key = pendingKey(network, payer, nonce);
      let made = false;
      const wrote = await change((pending) => {
        made = false;
        if (pending[key]) return;
        if (Object.keys(pending).length >= maxEntries) { log(`[gateway] pending book full (${maxEntries}); a pending settlement on ${network} was not booked`); return; }
        pending[key] = { key, network, payer: lc(payer), nonce: lc(nonce), amount: UINT.test(String(amount ?? "")) ? String(amount) : null, payTo: ADDR.test(String(payTo || "")) ? lc(payTo) : null, resource: typeof resource === "string" ? resource.slice(0, 300) : null, at: now(), state: "pending" };
        made = true;
      });
      // A database update that did not land made nothing, whatever the mutator saw.
      return made && wrote === true;
    },
    /** Drop an entry that is reconciled: repaid, failed at Gateway, served, or
     *  booked as an owed debt in the refund ledger (the resolver). */
    async resolve(key, { outcome, note } = {}) {
      if (typeof key !== "string" || !state.pending[key] && !(await refresh(), state.pending[key])) return { ok: false, error: "no such entry" };
      if (!["refunded", "not_charged", "served", "owed"].includes(outcome)) return { ok: false, error: 'outcome must be "refunded", "not_charged", "served" or "owed"' };
      await change((pending) => { delete pending[key]; });
      log(`[gateway] pending entry ${key} resolved as ${outcome}${note ? ` (${String(note).slice(0, 200)})` : ""}`);
      return { ok: true, key, outcome };
    },
    /** The entry for one authorization key, read from the shared store. */
    async get(key) {
      await refresh();
      return typeof key === "string" && state.pending[key] ? { ...state.pending[key] } : null;
    },
    /** Take an entry for one resend (installGatewayRouting): true when this
     *  owner now holds it. Another owner's hold lapses after `leaseMs`, so a
     *  replica that died mid-request cannot strand the entry. */
    async claimResume(key, owner, { leaseMs = RESUME_LEASE_MS } = {}) {
      let took = false;
      const wrote = await change((pending) => {
        took = false;
        const e = pending[key];
        if (!e) return;
        if (e.state === "resuming" && e.owner !== owner && now() - Number(e.resumeAt || 0) < leaseMs) return;
        pending[key] = { ...e, state: "resuming", owner, resumeAt: now() };
        took = true;
      });
      return took && wrote === true;
    },
    /** Hand an entry back after a resend that was not served. */
    async releaseResume(key, owner) {
      let back = false;
      await change((pending) => {
        back = false;
        const e = pending[key];
        if (!e || e.owner !== owner) return;
        const { owner: _o, resumeAt: _r, ...rest } = e;
        pending[key] = { ...rest, state: "pending" };
        back = true;
      });
      return back;
    },
    list() { return entries(); },
    /** One word for /api/gateway-status: ok / pending / near_capacity /
     *  unresolved (an entry has waited past unresolvedMs) / full. */
    async alarmStatus() {
      await refresh();
      const list = entries();
      const n = list.length;
      if (n >= maxEntries) return "full";
      if (list.some((e) => now() - Number(e.at || 0) >= unresolvedMs)) return "unresolved";
      if (n >= Math.ceil(maxEntries * 0.8)) return "near_capacity";
      return n ? "pending" : "ok";
    },
    async operatorView() { await refresh(); return { status: await this.alarmStatus(), count: entries().length, entries: entries().sort((a, b) => a.at - b.at) }; },
  };
}

// ---------------------------------------------------------------------------
// The pending resolver: every entry is read against Gateway's transfer record
// (the keyless lookup by nonce, transferByAuthorization) on a schedule, so a
// payment nobody resends is still settled in the books:
//   confirmed / completed, never served -> one owed debt in the refund ledger
//       (wire gateway-batched, evidence the Gateway transfer id, priced at the
//       amount the buyer signed), which refund-run proves at Gateway and
//       repays; the entry is dropped once the row is there.
//   confirmed / completed, a sale booked for it -> dropped as served.
//   failed -> dropped, not charged.
//   received / batched, none, unreadable -> kept for the next tick.
// The resolver holds the entry (claimResume) while it decides, so a resend in
// the same moment is told to wait and the buyer is never both served and
// owed. Evidence is the transfer id and the ledger is insert-if-absent by
// evidence, so a tick that books and then fails to drop books nothing more
// the next time. Bounded per tick; entries are read in turn across ticks.
// ---------------------------------------------------------------------------
export const PENDING_RESOLVE_INTERVAL_MS = 10 * 60_000;
export const PENDING_RESOLVE_MAX_PER_TICK = 25;
/** Gateway statuses that prove the buyer was charged (as src/payment-verify.js). */
export const PROVEN_TRANSFER_STATUSES = Object.freeze(["confirmed", "completed"]);

/** The slug a debt row carries: the last path segment of the booked route. */
function slugOfResource(resource) {
  const path = typeof resource === "string" ? resource.split(" ").pop() : "";
  const seg = String(path || "").split("/").filter(Boolean).pop() || "";
  return /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(seg) ? seg : "gateway-pending";
}

/**
 * The resolver: `tick()` reads up to `maxPerTick` entries and returns counts.
 * `recordOwed(row)` books a debt (recordRefundOwed), `owedExists(evidence)`
 * says whether the ledger holds a row for it, `wasServed({ tx, network })`
 * whether a sale is booked for the transfer. `payTo` is the fallback payTo
 * for an entry booked without one.
 */
export function createGatewayPendingResolver({ book, client, recordOwed, owedExists, wasServed = null, payTo = null, maxPerTick = PENDING_RESOLVE_MAX_PER_TICK, log = console.warn } = {}) {
  let cursor = 0;
  async function decide(e) {
    const amount = String(e.amount ?? "");
    const pay = e.payTo || payTo;
    if (!UINT.test(amount) || !ADDR.test(String(pay || ""))) return "kept";
    const owner = `resolver-${randomUUID()}`;
    if (!(await book.claimResume(e.key, owner))) return "kept";
    let release = true;
    try {
      const found = await client.transferByAuthorization({ payer: e.payer, payTo: pay, amount, nonce: e.nonce, network: e.network });
      if (found.state === "failed") {
        release = false;
        await book.resolve(e.key, { outcome: "not_charged", note: "Gateway reports the transfer failed" });
        return "not_charged";
      }
      if (found.state !== "accepted" || !PROVEN_TRANSFER_STATUSES.includes(found.transfer.status)) return "kept";
      const tx = found.transfer.id;
      if (typeof wasServed === "function" && await wasServed({ tx, network: e.network })) {
        release = false;
        await book.resolve(e.key, { outcome: "served", note: "a sale is booked for this transfer" });
        return "served";
      }
      if (!(await owedExists(tx))) {
        await recordOwed({
          slug: slugOfResource(e.resource), network: e.network, payer: e.payer,
          priceUsd: Number(BigInt(amount)) / 1e6, tx, httpStatus: 402, wire: GATEWAY_WIRE,
          note: "batched payment settled at Gateway after its request was answered pending; never served",
        });
      }
      // Dropped only once the debt is in the ledger; otherwise kept for the next tick.
      if (!(await owedExists(tx))) return "kept";
      release = false;
      await book.resolve(e.key, { outcome: "owed", note: `owed debt booked for Gateway transfer ${tx}` });
      return "owed";
    } finally {
      if (release) { try { await book.releaseResume(e.key, owner); } catch { /* the hold lapses on its own */ } }
    }
  }
  return {
    async tick() {
      const out = { read: 0, owed: 0, not_charged: 0, served: 0, kept: 0 };
      try { await book.refresh(); } catch { return out; }
      const all = book.list().sort((a, b) => (a.at - b.at) || String(a.key).localeCompare(String(b.key)));
      if (!all.length) { cursor = 0; return out; }
      const start = cursor % all.length;
      const turn = [...all.slice(start), ...all.slice(0, start)].slice(0, Math.max(1, maxPerTick));
      cursor = start + turn.length;
      for (const e of turn) {
        out.read++;
        let r = "kept";
        try { r = await decide(e); } catch (err) { log(`[gateway] pending resolver: ${String(err?.message || err).slice(0, 120)}`); }
        out[r] = (out[r] || 0) + 1;
      }
      if (out.owed || out.not_charged || out.served) log(`[gateway] pending resolver: ${out.owed} owed, ${out.not_charged} not charged, ${out.served} served, ${out.kept} kept`);
      return out;
    },
  };
}

let resolverTimer = null;
/** Run the resolver every `intervalMs` under one lease across replicas. */
export function startGatewayPendingResolver(opts = {}, { intervalMs = Number(process.env.GATEWAY_PENDING_RESOLVE_MS) > 0 ? Number(process.env.GATEWAY_PENDING_RESOLVE_MS) : PENDING_RESOLVE_INTERVAL_MS } = {}) {
  if (resolverTimer) return null;
  const resolver = createGatewayPendingResolver(opts);
  const tick = leased("gateway-pending-resolver", { ttlMs: Math.max(intervalMs, 120_000) }, () => resolver.tick());
  const run = () => { tick().catch(() => {}); };
  resolverTimer = setInterval(run, intervalMs);
  if (typeof resolverTimer.unref === "function") resolverTimer.unref();
  setTimeout(run, 30_000).unref?.();
  return resolver;
}

// ---------------------------------------------------------------------------
// The balance watch: our Gateway balance, read every interval and bucketed to
// a word for /api/gateway-status (figure on the operator view only).
// ---------------------------------------------------------------------------
let balanceState = { usd: null, byDomain: null, readAt: 0, error: null, started: false };

/** Read once and remember. Never throws. */
export async function refreshGatewayBalance(client, { depositor, domains, now = () => Date.now() } = {}) {
  try {
    const b = await client.balances({ depositor, domains });
    balanceState = { ...balanceState, usd: b.usd, byDomain: b.byDomain, readAt: now(), error: null };
  } catch (e) {
    balanceState = { ...balanceState, error: String(e?.reason || e?.name || "error").slice(0, 40), readAt: balanceState.readAt };
  }
  return balanceState;
}

export function startGatewayBalanceWatch(client, { depositor, domains, intervalMs = Number(process.env.GATEWAY_BALANCE_READ_MS) > 0 ? Number(process.env.GATEWAY_BALANCE_READ_MS) : 10 * 60_000 } = {}) {
  if (balanceState.started) return;
  balanceState = { ...balanceState, started: true };
  const tick = () => refreshGatewayBalance(client, { depositor, domains }).catch(() => {});
  const t = setInterval(tick, intervalMs);
  if (typeof t.unref === "function") t.unref();
  setTimeout(tick, 1500).unref?.();
}

/** The status word (and, for the operator, the figure). off while the
 *  option is off or no watch runs; unknown until a read lands. */
export function gatewayBalanceStatus({ full = false, env = process.env } = {}) {
  if (!balanceState.started) return { status: "off" };
  const alertUsd = gatewayWithdrawAlertUsd(env);
  const status = balanceState.usd == null ? "unknown" : balanceState.usd >= alertUsd ? "withdraw" : "ok";
  if (!full) return { status };
  return { status, usd: balanceState.usd, byDomain: balanceState.byDomain, readAt: balanceState.readAt ? new Date(balanceState.readAt).toISOString() : null, alertUsd, ...(balanceState.error ? { lastError: balanceState.error } : {}) };
}

/** Test-only. */
export function _resetGatewayBalanceForTests() { balanceState = { usd: null, byDomain: null, readAt: 0, error: null, started: false }; }

// ---------------------------------------------------------------------------
// The live offer, for the public surfaces (set by src/payments.js from the
// final boot offer; empty until then and with the switch off).
// ---------------------------------------------------------------------------
let liveKinds = new Map();
export function setGatewayOffer(kinds) { liveKinds = kinds instanceof Map ? kinds : new Map(); }

/** The batched option as the public surfaces describe it: null when off. */
export function gatewayOfferPublic() {
  if (!liveKinds.size) return null;
  const networks = {};
  for (const k of liveKinds.values()) {
    networks[k.network] = { scheme: "exact", kind: k.name, asset: k.asset, verifyingContract: k.verifyingContract, extra: { name: k.name, version: k.version, verifyingContract: k.verifyingContract }, maxTimeoutSeconds: k.maxTimeoutSeconds, minValiditySeconds: k.minValiditySeconds };
  }
  return {
    kind: GATEWAY_KIND_NAME,
    wire: GATEWAY_WIRE,
    networks,
    buyerGas: "none: the buyer signs an EIP-3009 authorization against its Gateway balance and pays no gas",
    settlement: "batched off chain by Circle Gateway and credited to the seller's Gateway balance; the buyer deposits USDC into Gateway once, then every payment is a signature",
    note: "Offered beside the plain accept on the same networks at the same price; identity-bound routes keep the plain accept only. A payment whose accept carries extra.name GatewayWalletBatched is verified and settled through Circle Gateway; every other payment settles through the network's facilitator as before.",
  };
}

/** The network short names the option is live on, in RAILS order ("arc", "base"). */
export function gatewayOfferNetworkNames() {
  const byCaip2 = Object.fromEntries(Object.entries(GATEWAY_NETWORK_NAMES).map(([n, c]) => [c, n]));
  return [...liveKinds.keys()].map((c) => byCaip2[c] || c);
}

/** True when the batched option is live on `caip2`. */
export function gatewayOfferedOn(caip2) { return liveKinds.has(String(caip2 || "")); }
