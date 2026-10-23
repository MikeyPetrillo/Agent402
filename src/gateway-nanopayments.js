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
// failed inside the call. It answers the buyer a 402 with nothing served
// (transaction empty, so the vendor's own pending retry does not resend the
// same nonce), is booked by its authorization in the pending book, and the
// 402 body says why (src/gateway-wire.js classifySettlementPending).
import { SettleError, VerifyError } from "@x402/core/types";
import { AsyncLocalStorage } from "node:async_hooks";
import { verifyTypedData, parseCompactSignature, compactSignatureToSignature, serializeSignature } from "viem";
import { createJsonDocument } from "./json-document.js";
import { trackStoreReady } from "./state-db.js";
import { GATEWAY_KIND_NAME, GATEWAY_WIRE, SETTLEMENT_PENDING_REASON, isGatewayBatchedPayment } from "./gateway-wire.js";

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
  constructor({ fetchImpl, now, networks = Object.values(GATEWAY_NETWORK_NAMES), onPending = null } = {}) {
    this._fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this._now = now || (() => Date.now());
    this._wanted = [...networks];
    this._kinds = new Map();
    // Called with { payer, network, nonce, amount, resource } for a settle
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
      // Neither paid nor failed inside the call: refused to the buyer now,
      // booked by its authorization so a later completion is repaid. The
      // transaction is left empty so @x402/core's own pending retry never
      // resends this nonce.
      if (this._onPending) {
        try {
          await this._onPending({ payer, network, nonce: paymentPayload?.payload?.authorization?.nonce, amount: String(paymentRequirements?.amount ?? ""), resource: paymentPayload?.resource?.url });
        } catch { /* booking never breaks the settle path */ }
      }
      console.warn(`[gateway] batched settlement on ${network} still pending at Gateway; not reported as settled`);
    }
    return { success: false, errorReason: reason, transaction: "", network, payer };
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
 */
export function installGatewayRouting(server, client, networks) {
  if (!server || server[INSTALLED]) return server;
  const nets = networks instanceof Set ? networks : new Set(networks || []);
  const batched = (paymentPayload, requirements) => isGatewayBatchedPayment(paymentPayload) || (isObj(requirements) && isObj(requirements.extra) && requirements.extra.name === GATEWAY_KIND_NAME);
  const origVerify = server.verifyPayment.bind(server);
  const origSettle = server.settlePayment.bind(server);
  const origClient = server.getFacilitatorClient.bind(server);
  server.verifyPayment = (paymentPayload, requirements, ...rest) => {
    if (!batched(paymentPayload, requirements)) return origVerify(paymentPayload, requirements, ...rest);
    return scope.run({ client, network: requirements?.network }, () => origVerify(paymentPayload, requirements, ...rest));
  };
  server.settlePayment = (paymentPayload, requirements, ...rest) => {
    if (!batched(paymentPayload, requirements)) return origSettle(paymentPayload, requirements, ...rest);
    return scope.run({ client, network: requirements?.network }, () => origSettle(paymentPayload, requirements, ...rest));
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
// the authorization (network, payer, nonce). Reconciled by hand from Gateway's
// transfer history (the seller reconciliation guide); listed on
// /__operator/gateway-pending.json. Bounded; a full book refuses new entries
// loudly rather than dropping old ones.
// ---------------------------------------------------------------------------
export const PENDING_MAX_ENTRIES = 2000;
export const pendingKey = (network, payer, nonce) => `${String(network)}|${lc(payer)}|${lc(nonce)}`;

export function createGatewayPendingBook({ file = process.env.GATEWAY_PENDING_FILE || "/data/gateway-pending.json", now = () => Date.now(), log = console.warn, maxEntries = PENDING_MAX_ENTRIES } = {}) {
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
  const change = async (fn) => {
    if (!PG) { await refresh(); fn(state.pending); await doc.save(state); return true; }
    const r = await doc.update((b) => { const pending = { ...((isObj(b) && isObj(b.pending)) || {}) }; fn(pending); return { pending }; }, { fallback: null });
    if (r.ok) absorb(r.body);
    return !!r.ok;
  };
  const entries = () => Object.values(state.pending);
  return {
    ready,
    refresh,
    /** Book one pending settlement under its authorization. False when refused or already there. */
    async book({ payer, network, nonce, amount, resource } = {}) {
      if (!ADDR.test(String(payer || "")) || !B32.test(String(nonce || "")) || !/^eip155:[0-9]{1,12}$/.test(String(network || ""))) return false;
      const key = pendingKey(network, payer, nonce);
      let made = false;
      await change((pending) => {
        if (pending[key]) return;
        if (Object.keys(pending).length >= maxEntries) { log(`[gateway] pending book full (${maxEntries}); a pending settlement on ${network} was not booked`); return; }
        pending[key] = { key, network, payer: lc(payer), nonce: lc(nonce), amount: UINT.test(String(amount ?? "")) ? String(amount) : null, resource: typeof resource === "string" ? resource.slice(0, 300) : null, at: now(), state: "pending" };
        made = true;
      });
      return made;
    },
    /** Drop an entry an operator reconciled (repaid, failed at Gateway, or served). */
    async resolve(key, { outcome, note } = {}) {
      if (typeof key !== "string" || !state.pending[key] && !(await refresh(), state.pending[key])) return { ok: false, error: "no such entry" };
      if (!["refunded", "not_charged", "served"].includes(outcome)) return { ok: false, error: 'outcome must be "refunded", "not_charged" or "served"' };
      await change((pending) => { delete pending[key]; });
      log(`[gateway] pending entry ${key} resolved as ${outcome}${note ? ` (${String(note).slice(0, 200)})` : ""}`);
      return { ok: true, key, outcome };
    },
    list() { return entries(); },
    /** One word for /api/gateway-status: ok / pending / near_capacity / full. */
    async alarmStatus() {
      await refresh();
      const n = entries().length;
      if (n >= maxEntries) return "full";
      if (n >= Math.ceil(maxEntries * 0.8)) return "near_capacity";
      return n ? "pending" : "ok";
    },
    async operatorView() { await refresh(); return { status: await this.alarmStatus(), count: entries().length, entries: entries().sort((a, b) => a.at - b.at) }; },
  };
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
