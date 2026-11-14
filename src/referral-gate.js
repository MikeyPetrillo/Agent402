// Referral copies of paid tool routes: /ref/<slug>.
//
// A referral network sends buyers through a reviewer's link. For each
// allowlisted tool this gate serves a copy of the paid route whose 402 pays
// the network's split contract instead of this server's wallet: the buyer
// signs an EIP-3009 ReceiveWithAuthorization to that contract on Base, and
// the network's facilitator settles it on a request signed by a hot key of
// ours (src/referral-settle.js). The contract pays our share to a wallet of
// ours; the rest is the reviewer's commission and the network's fee.
//
// The gate is standalone. It is not a catalog route, adds no rail and rewrites
// nothing onto a catalog path, so every surface derived from the catalog or
// the rails (pricing, openapi, llms.txt, the x402 manifest, the sitemap) stays
// as it is, and a header the x402 paywall cannot verify never reaches a
// catalog-keyed middleware. It calls the tool's own handler.
//
// Money rules (root CLAUDE.md, "x402 settlement ordering"):
//   - The amount is the amount the direct route's Base accept carries for the
//     same request, in USDC base units: the same price function, the same
//     per-network funnel. Never higher.
//   - Handler first, then settle. A handler error, a timeout, a stream or a
//     binary answer is answered as it is and never settled.
//   - One authorization, one run: the replay guard holds it from before the
//     run until it is settled (consumed, held to validBefore) or released.
//   - A buyer whose connection closed before settlement starts is not settled.
//   - A sale is booked only after the facilitator returns a transaction, at
//     the NET amount (gross less commission and fee); the gross is the quote.
//   - This rail has no refund path. A charge that could not be delivered is
//     logged as CHARGED-BUT-NOT-SERVED and counted.
//
// REFERRAL_PAY_TO, REFERRAL_FACILITATOR_URL, REFERRAL_SIGNER_KEY,
// REFERRAL_SLUGS and REFERRAL_SETUP_URL together turn it on (all present and
// well formed; anything less is off). Optional knobs are read in
// referralConfig below.
import { createHash } from "node:crypto";
import { verifyTypedData, parseCompactSignature, compactSignatureToSignature, serializeSignature } from "viem";
import { USDC_DOMAIN_BY_NETWORK } from "./evm-usdc-domain.js";
import { decodePaymentHeader } from "./payment-header.js";
import { handlerInputOf, withIgnoredParams } from "./handler-input.js";
import { withLoopTimeout } from "./loop-deadline.js";
import { binaryTypesOf } from "./tool-media-type.js";
import { referralLogText } from "./referral-settle.js";

export const REFERRAL_NETWORK = "eip155:8453";
export const REFERRAL_CHAIN_ID = 8453;
const USDC = USDC_DOMAIN_BY_NETWORK[REFERRAL_NETWORK];
export const REFERRAL_ASSET = USDC.asset;
/** What the 402 asks a buyer to sign for: the example value of the network's
 *  own documents. The run and the settlement both fit inside it. */
export const REFERRAL_MAX_TIMEOUT_SECONDS = 60;
export const REFERRAL_DEFAULTS = Object.freeze({
  // The handler's budget. With the settle reserve it fits a 60 s authorization.
  deadlineMs: 45_000,
  // The facilitator's /settle waits for the receipt.
  settleMs: 30_000,
  verifyMs: 10_000,
  // An authorization must still be valid this long after the handler ends,
  // so the settlement can land before validBefore.
  settleReserveMs: 10_000,
  commissionBps: 1000,
  feeBps: 0,
});
/** A paid call is started only when its authorization leaves the handler at
 *  least this long before the settle reserve. */
export const REFERRAL_MIN_RUN_MS = 3_000;
export const REFERRAL_TOKEN_MAX_CHARS = 8192;
export const REFERRAL_AGENT_ID_MAX_CHARS = 128;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^\d{1,78}$/;
const HEX = /^0x[0-9a-fA-F]+$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const lc = (s) => (typeof s === "string" ? s.toLowerCase() : "");
const headerText = (v) => (Array.isArray(v) ? v[0] : v);

const RECEIVE_TYPES = Object.freeze({
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
});

/** An https URL with no credentials (http only for a loopback host, for local
 *  runs), as its string without a trailing slash; null otherwise. */
function cleanUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
    if (u.username || u.password || u.hash) return null;
    return u.toString().replace(/\/+$/, "");
  } catch { return null; }
}
function msKnob(env, name, dflt, { min = 1000, max = 600_000 } = {}) {
  const raw = String(env?.[name] ?? "").trim();
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : dflt;
}
function bpsKnob(env, name, dflt) {
  const raw = String(env?.[name] ?? "").trim();
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : dflt;
}
/**
 * The commission map: `default:1000,v1-chat-pro:1500`. A bare number is the
 * default. Returns `{ default, bySlug }`, or null when an entry is malformed
 * (a net booked from a misread rate is worse than a gate that stays off).
 */
export function parseCommissionBps(raw, dflt = REFERRAL_DEFAULTS.commissionBps) {
  const out = { default: dflt, bySlug: {} };
  const text = String(raw ?? "").trim();
  if (!text) return out;
  const bps = (v) => (/^\d{1,5}$/.test(v) && Number(v) <= 10_000 ? Number(v) : null);
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    const name = i < 0 ? "default" : part.slice(0, i).trim().toLowerCase();
    const n = bps(i < 0 ? part : part.slice(i + 1).trim());
    if (n === null || (name !== "default" && !SLUG.test(name)) || (name !== "default" && Object.hasOwn(out.bySlug, name))) return null;
    if (name === "default") out.default = n; else out.bySlug[name] = n;
  }
  return out;
}
/** The commission a slug's sale is booked net of. */
export function commissionBpsFor(config, slug) {
  const m = config?.commission;
  return m && Object.hasOwn(m.bySlug, slug) ? m.bySlug[slug] : (m ? m.default : REFERRAL_DEFAULTS.commissionBps);
}

const REQUIRED_VARS = ["REFERRAL_PAY_TO", "REFERRAL_FACILITATOR_URL", "REFERRAL_SIGNER_KEY", "REFERRAL_SLUGS", "REFERRAL_SETUP_URL"];

/**
 * The gate's configuration, or null (off) unless every required variable is
 * set and well formed.
 *
 *   REFERRAL_PAY_TO             the network's split contract (0x address); the 402's payTo
 *   REFERRAL_FACILITATOR_URL    the facilitator's base URL (https)
 *   REFERRAL_SIGNER_KEY         32-byte hex key that signs facilitator requests
 *   REFERRAL_SLUGS              comma list of catalog slugs to serve under /ref/<slug>
 *   REFERRAL_SETUP_URL          the network's setup document, echoed in the 402 (https)
 *   REFERRAL_DEADLINE_MS        handler budget, default 45000
 *   REFERRAL_SETTLE_MS          /settle timeout, default 30000
 *   REFERRAL_VERIFY_MS          /verify timeout, default 10000
 *   REFERRAL_SETTLE_RESERVE_MS  validity kept for the settlement, default 10000
 *   REFERRAL_VERIFY             default on: ask /verify before the handler; `off` relies on the local checks
 *   REFERRAL_VERIFY_SIGNED      default on: /verify carries the signed headers; `off` sends it unsigned
 *   REFERRAL_COMMISSION_BPS     per-slug map, `default:1000,<slug>:1500,...` (a bare number is the
 *                               default; a slug not named reads the default, 1000 when none is
 *                               given); read ONLY to book the net amount
 *   REFERRAL_FEE_BPS            default 0; read ONLY to book the net amount
 */
export function referralConfig(env = process.env) {
  const payTo = String(env?.REFERRAL_PAY_TO || "").trim();
  const facilitatorUrl = cleanUrl(env?.REFERRAL_FACILITATOR_URL);
  const signerKey = String(env?.REFERRAL_SIGNER_KEY || "").trim();
  const setupUrl = cleanUrl(env?.REFERRAL_SETUP_URL);
  const slugs = [...new Set(String(env?.REFERRAL_SLUGS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (!ADDR.test(payTo) || !facilitatorUrl || !setupUrl || !/^(0x)?[0-9a-fA-F]{64}$/.test(signerKey)) return null;
  if (!slugs.length || !slugs.every((s) => SLUG.test(s))) return null;
  const commission = parseCommissionBps(env?.REFERRAL_COMMISSION_BPS);
  const feeBps = bpsKnob(env, "REFERRAL_FEE_BPS", REFERRAL_DEFAULTS.feeBps);
  if (!commission || [commission.default, ...Object.values(commission.bySlug)].some((c) => c + feeBps > 10_000)) return null;
  Object.freeze(commission.bySlug);
  const off = (name) => String(env?.[name] || "").trim().toLowerCase() === "off";
  return Object.freeze({
    payTo, facilitatorUrl, signerKey, setupUrl, slugs: Object.freeze(slugs),
    deadlineMs: msKnob(env, "REFERRAL_DEADLINE_MS", REFERRAL_DEFAULTS.deadlineMs),
    settleMs: msKnob(env, "REFERRAL_SETTLE_MS", REFERRAL_DEFAULTS.settleMs),
    verifyMs: msKnob(env, "REFERRAL_VERIFY_MS", REFERRAL_DEFAULTS.verifyMs),
    settleReserveMs: msKnob(env, "REFERRAL_SETTLE_RESERVE_MS", REFERRAL_DEFAULTS.settleReserveMs),
    verify: !off("REFERRAL_VERIFY"),
    verifySigned: !off("REFERRAL_VERIFY_SIGNED"),
    commission: Object.freeze(commission), feeBps,
  });
}

/** Names (never values) of the required variables that are set while the gate
 *  is off, for one boot warning: a half-configured gate serves nothing. */
export function referralConfigProblem(env = process.env) {
  if (referralConfig(env)) return null;
  const set = REQUIRED_VARS.filter((n) => String(env?.[n] || "").trim());
  if (!set.length) return null;
  const missing = REQUIRED_VARS.filter((n) => !set.includes(n));
  return missing.length ? `missing ${missing.join(", ")}` : "a value is not well formed (an address, an https URL, a 32-byte hex key, a slug list, the commission map, or commission plus fee past 10000 bps)";
}

const flatUsdOf = (def) => Number(String(def?.price ?? "").replace(/[^0-9.]/g, "")) || 0;
const priceFnOf = (def) => (typeof def?.quote === "function" ? def.quote : typeof def?.tierQuote === "function" ? def.tierQuote : null);
const usdText = (usd) => "$" + usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

/** USDC base units (a BigInt) of a "$0.03" price, or null when the text is not
 *  a dollar amount of at most six decimals above zero. */
export function baseUnitsOf(priceText) {
  const m = /^\$(\d{1,12})(?:\.(\d{1,6}))?$/.exec(String(priceText ?? "").trim());
  if (!m) return null;
  const units = BigInt(m[1]) * 1_000_000n + BigInt((m[2] || "").padEnd(6, "0") || "0");
  return units > 0n ? units : null;
}

/** What a referred sale books: the gross the buyer paid, and the net left
 *  after the reviewer's commission and the network's fee. Each leg is floored
 *  (a leg that rounds to zero is not taken), so the remainder stays in net. */
export function referralNet(grossUnits, { commissionBps = 0, feeBps = 0 } = {}) {
  const gross = BigInt(grossUnits);
  const commission = (gross * BigInt(commissionBps)) / 10_000n;
  const fee = (gross * BigInt(feeBps)) / 10_000n;
  const net = gross - commission - fee;
  return { grossUnits: gross, netUnits: net > 0n ? net : 0n, grossUsd: Number(gross) / 1e6, netUsd: Number(net > 0n ? net : 0n) / 1e6 };
}

/**
 * Why a catalog definition cannot be served as a referral copy, or null.
 * `flags` are the server's own predicates over the definition; `runBoundMs`
 * is the longest the tool's own upstream wait can take, when it is known.
 */
export function referralIneligibility(def, { identityBound = false, lastingEffect = false, paysThirdParty = false, longRunning = false, runBoundMs = null, deadlineMs = REFERRAL_DEFAULTS.deadlineMs, priceForNetwork = (p) => p } = {}) {
  if (!def || typeof def !== "object" || typeof def.handler !== "function") return "not in the catalog";
  if (identityBound) return "identity-bound route";
  if (lastingEffect) return "its effect outlives the answer";
  if (paysThirdParty) return "pays an outside seller";
  if (longRunning) return "long-running or composite route";
  if (binaryTypesOf(def)) return "answers bytes, not JSON";
  if (Number.isFinite(runBoundMs) && runBoundMs > deadlineMs) return `its own upstream wait (${Math.round(runBoundMs / 1000)} s) is past the handler deadline (${Math.round(deadlineMs / 1000)} s)`;
  if (!(flatUsdOf(def) > 0)) return "no list price";
  let listed = null;
  try { listed = baseUnitsOf(priceForNetwork(def.price, REFERRAL_NETWORK)); } catch { listed = null; }
  if (listed === null) return "its list price is not a whole number of USDC base units";
  return null;
}

/** The allowlisted definitions that pass the boot checks, by slug, and the
 *  ones refused with the reason. `flagsOf(def)` returns the flags above. */
export function referralRoutes(config, catalog, flagsOf = () => ({})) {
  const defs = new Map();
  const refused = [];
  const bySlug = new Map(Object.values(catalog || {}).filter((d) => d && typeof d.slug === "string").map((d) => [d.slug, d]));
  for (const slug of config?.slugs || []) {
    const def = bySlug.get(slug);
    let reason;
    try { reason = referralIneligibility(def, { deadlineMs: config.deadlineMs, ...(def ? flagsOf(def) : {}) }); }
    catch { reason = "could not be checked"; }
    if (reason) refused.push({ slug, reason });
    else defs.set(slug, def);
  }
  return { defs, refused };
}

/** The slug a request path names under /ref/, or null. Case, a trailing slash
 *  and percent-encoding are folded the way the router resolves the path. */
export function referralSlugOfPath(path) {
  let p = String(path || "");
  if (p.length > 200) return null;
  try { p = decodeURIComponent(p); } catch { /* a malformed escape stays as written */ }
  p = p.toLowerCase().replace(/\/{2,}/g, "/");
  if (!p.startsWith("/ref/")) return null;
  const slug = p.slice(5).replace(/\/+$/, "");
  return SLUG.test(slug) ? slug : null;
}

/** True when `signature` is an ECDSA signature by `auth.from` over the
 *  ReceiveWithAuthorization typed data of Base USDC. Pure: no network call. */
export async function isLocalReceiveSignature(auth, signature) {
  try {
    const full = signature.length === 130 ? serializeSignature(compactSignatureToSignature(parseCompactSignature(signature))) : signature;
    return await verifyTypedData({
      address: auth.from,
      domain: { name: USDC.name, version: USDC.version, chainId: REFERRAL_CHAIN_ID, verifyingContract: REFERRAL_ASSET },
      types: RECEIVE_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message: { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
      signature: full,
    });
  } catch { return false; }
}

/**
 * The local reading of a decoded payment against the requirement this request
 * was quoted. Returns `{ reason }` (a refusal code) or
 * `{ auth, signature, validBeforeMs }`. Reads string fields only.
 */
export function checkReferralPayment(payment, requirement, { nowMs = Date.now(), reserveMs = REFERRAL_DEFAULTS.settleReserveMs, minRunMs = REFERRAL_MIN_RUN_MS } = {}) {
  const refuse = (reason) => ({ reason });
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) return refuse("invalid_request");
  const txt = (v) => (typeof v === "string" ? v : "");
  // Every network and asset the payment names must be the one quoted.
  for (const n of [payment.accepted?.network, payment.network, payment.payload?.network]) {
    if (n !== undefined && n !== null && n !== REFERRAL_NETWORK) return refuse("invalid_network");
  }
  const asset = payment.accepted?.asset;
  if (asset !== undefined && asset !== null && lc(txt(asset)) !== lc(requirement.asset)) return refuse("invalid_payment_requirements");
  const scheme = payment.accepted?.scheme ?? payment.scheme;
  if (scheme !== undefined && scheme !== null && scheme !== "exact") return refuse("unsupported_scheme");
  const inner = payment.payload;
  const auth = inner && typeof inner === "object" && !Array.isArray(inner) ? inner.authorization : null;
  const signature = inner && typeof inner === "object" ? inner.signature : null;
  if (!auth || typeof auth !== "object" || Array.isArray(auth) || typeof signature !== "string" || !HEX.test(signature) || signature.length > 4098) return refuse("invalid_payload");
  if (!ADDR.test(txt(auth.from)) || !ADDR.test(txt(auth.to)) || !B32.test(txt(auth.nonce))) return refuse("invalid_payload");
  for (const f of ["value", "validAfter", "validBefore"]) if (!UINT.test(txt(auth[f]))) return refuse("invalid_payload");
  // The money checks: the contract named in the 402, and exactly the amount.
  if (lc(auth.to) !== lc(requirement.payTo)) return refuse("invalid_exact_evm_payload_recipient_mismatch");
  if (BigInt(auth.value) !== BigInt(requirement.amount)) return refuse("invalid_exact_evm_payload_authorization_value_mismatch");
  const nowSec = BigInt(Math.floor(nowMs / 1000));
  if (BigInt(auth.validAfter) > nowSec) return refuse("invalid_exact_evm_payload_authorization_valid_after");
  const validBeforeSec = BigInt(auth.validBefore);
  // Bounded before it becomes a Number: a uint256 far in the future is "valid long enough".
  const validBeforeMs = validBeforeSec > 4_102_444_800n ? 4_102_444_800_000 : Number(validBeforeSec) * 1000;
  if (validBeforeMs - nowMs < reserveMs + minRunMs) return refuse("invalid_exact_evm_payload_authorization_valid_before");
  // EIP-2: the upper-half-s twin of a valid signature is refused, as the token does.
  if (signature.length === 132 && BigInt(`0x${signature.slice(66, 130)}`) > SECP256K1_HALF_N) return refuse("invalid_exact_evm_payload_signature");
  return { auth, signature, validBeforeMs };
}

/** The replay identity of a referral authorization: the chain consumes a
 *  nonce per (token, from), so that pair on Base is the payment. */
export function referralReplayKey(auth) {
  return `referral:${createHash("sha256").update(`${REFERRAL_NETWORK}\n${lc(auth.from)}\n${lc(auth.nonce)}`).digest("hex")}`;
}

const REFUSAL_TEXT = Object.freeze({
  invalid_request: "The PAYMENT-SIGNATURE header does not decode to a payment.",
  invalid_network: "This route settles USDC on Base (eip155:8453) only.",
  invalid_exact_evm_payload_recipient_mismatch: "The authorization does not pay the address this route's 402 names.",
  invalid_exact_evm_payload_authorization_value_mismatch: "The authorization's value is not the amount this request's 402 asks.",
  invalid_exact_evm_payload_authorization_valid_before: "The authorization expires too soon for the call to run and settle. Sign a fresh one.",
  invalid_exact_evm_payload_authorization_valid_after: "The authorization is not valid yet.",
  invalid_exact_evm_payload_signature: "The signature is not the payer's over this ReceiveWithAuthorization.",
});

/**
 * Build the gate. Every dependency on the server is passed in, so the module
 * can be run against stubs.
 *
 * @param {object} o
 * @param {object} o.config                    referralConfig()
 * @param {Map<string, object>} o.defs         slug -> catalog definition (referralRoutes)
 * @param {{verify: Function, settle: Function}} o.settler   createReferralSettler()
 * @param {object} o.replayGuard               createReplayGuard(): a guard of this gate's own
 * @param {string} o.baseUrl
 * @param {(def, req) => number} o.priceUsdOf  the server's per-request price (stashes the quote on the request)
 * @param {(price: string, network: string) => string} o.priceForNetwork
 * @param {(def, req) => ({status, body}|null)} [o.preValidate]        the pre-payment input check
 * @param {(def, input) => ({status, body}|null)} [o.prePaymentRefusal] the metered pre-payment refusal
 * @param {(def, req) => Promise<void>} [o.warmQuote]
 * @param {(req, fn) => any} [o.runAsCaller]
 * @param {(res, err, slug) => any} o.sendToolError   the direct route's error rendering
 * @param {(sale: object) => any} o.recordSale
 * @param {(req) => boolean} [o.isSynthetic]
 * @param {(req) => string} [o.salePathOf]
 * @param {(def) => boolean} [o.requireShared]  whether the claim must be in the shared store
 * @param {(req, res, def) => void} [o.onRun]   called once when a handler is about to run
 */
export function createReferralGate({
  config, defs, settler, replayGuard, baseUrl, priceUsdOf, priceForNetwork,
  preValidate = () => null, prePaymentRefusal = () => null, warmQuote = null, runAsCaller = (_req, fn) => fn(),
  sendToolError, recordSale, isSynthetic = () => false, salePathOf = () => null, requireShared = () => false, onRun = null,
  log = console, now = Date.now,
} = {}) {
  if (!config || !(defs instanceof Map) || !settler || !replayGuard) throw new Error("referral gate: config, defs, settler and replayGuard are required");
  if (typeof priceUsdOf !== "function" || typeof priceForNetwork !== "function" || typeof sendToolError !== "function" || typeof recordSale !== "function") throw new Error("referral gate: priceUsdOf, priceForNetwork, sendToolError and recordSale are required");
  const origin = String(baseUrl || "").replace(/\/+$/, "");
  const counters = { challenges: 0, refused: 0, replays: 0, verifyRefused: 0, handlerErrors: 0, timeouts: 0, clientGone: 0, settleFailed: 0, settleInDoubt: 0, settled: 0, chargedNotServed: 0 };

  /** The amount this request is quoted, in USDC base units (a decimal
   *  string): the direct route's own Base amount. A request whose input cannot
   *  be priced reads the route's list price, as the direct route's 402 does. */
  function amountFor(def, req) {
    let usd = 0;
    try { usd = Number(priceUsdOf(def, req)); } catch { usd = 0; }
    const text = priceFnOf(def) && Number.isFinite(usd) && usd > 0 ? usdText(usd) : def.price;
    const units = baseUnitsOf(priceForNetwork(text, REFERRAL_NETWORK)) ?? baseUnitsOf(priceForNetwork(def.price, REFERRAL_NETWORK));
    return units === null ? null : units.toString();
  }

  /** The one accept of this request's 402, and the requirement the facilitator is sent. */
  function requirementFor(def, amount) {
    return {
      scheme: "exact",
      network: REFERRAL_NETWORK,
      asset: REFERRAL_ASSET,
      amount,
      payTo: config.payTo,
      maxTimeoutSeconds: REFERRAL_MAX_TIMEOUT_SECONDS,
      extra: { name: USDC.name, version: USDC.version, authorizationType: "ReceiveWithAuthorization", facilitatorUrl: config.facilitatorUrl, endpoint: `/ref/${def.slug}` },
    };
  }

  function challengeFor(def, req, requirement) {
    // The attribution token is echoed exactly as sent (never re-encoded); one
    // past the bound is not echoed at all, since a cut token is another token.
    const token = headerText(req.headers["x-referrer-token"]);
    const agentId = headerText(req.headers["x-referrer-buyer-agent-id"]);
    return {
      x402Version: 2,
      resource: { url: `${origin}/ref/${def.slug}`, description: String(def.name || def.slug).slice(0, 200), mimeType: "application/json" },
      accepts: [requirement],
      extensions: {
        attributionToken: typeof token === "string" && token.length <= REFERRAL_TOKEN_MAX_CHARS ? token : "",
        ...(typeof agentId === "string" && agentId && agentId.length <= REFERRAL_AGENT_ID_MAX_CHARS ? { buyerAgentId: agentId } : {}),
        setup_url: config.setupUrl,
      },
    };
  }

  const refusePayment = (res, reason, { status = 402, retryable = false, retryAfter = null } = {}) => {
    if (retryAfter) res.setHeader("Retry-After", String(retryAfter));
    const text = REFUSAL_TEXT[reason];
    return res.status(status).json({ success: false, errorReason: reason, ...(text ? { errorMessage: text } : {}), ...(retryable ? { retryable: true } : {}) });
  };
  const line = (level, text) => { try { (log[level] || log.log).call(log, `[referral] ${text}`); } catch { /* a log never breaks a call */ } };
  const shortPayer = (from) => `${String(from).slice(0, 6)}`;

  async function handler(req, res) {
    res.set("X-Robots-Tag", "noindex, nofollow").set("Cache-Control", "no-store");
    const slug = referralSlugOfPath(req.path);
    const def = slug ? defs.get(slug) : null;
    if (!def) return res.status(404).json({ error: "Not found" });
    // PAYMENT-SIGNATURE is the only payment evidence this route reads.
    delete req.headers["x-payment"];

    // A chat body is always answered as one JSON object here (the answer has
    // to carry the settlement's transaction), so streaming is turned off
    // BEFORE the request is priced: the quote and the run read one input.
    let input = null;
    try {
      input = handlerInputOf(req, def);
      if (def.category === "llm" && input && typeof input === "object") {
        if ("stream" in input) input.stream = false;
        delete input.stream_options;
      }
    } catch { input = null; }
    if (warmQuote && input) { try { await warmQuote(def, req); } catch { /* priced in place */ } }

    const amount = amountFor(def, req);
    if (amount === null) return res.status(404).json({ error: "Not found" });
    const requirement = requirementFor(def, amount);

    const raw = headerText(req.headers["payment-signature"]);
    if (typeof raw !== "string" || !raw) {
      // A header that did not decode was removed at intake.
      if (req.__droppedPaymentAttempt === true) { counters.refused++; return refusePayment(res, "invalid_request"); }
      counters.challenges++;
      return res.status(402).json(challengeFor(def, req, requirement));
    }

    const payment = decodePaymentHeader(raw);
    if (!payment) { counters.refused++; return refusePayment(res, "invalid_request"); }
    const checked = checkReferralPayment(payment, requirement, { nowMs: now(), reserveMs: config.settleReserveMs });
    if (checked.reason) { counters.refused++; return refusePayment(res, checked.reason); }
    const { auth, signature, validBeforeMs } = checked;
    const payer = lc(auth.from);
    // The payer's own signature, checked here. A signature this server cannot
    // verify as an EOA's (a contract wallet's) is left to the facilitator's
    // /verify; with that step off it is refused.
    const localSignature = await isLocalReceiveSignature(auth, signature);
    if (!localSignature && !config.verify) { counters.refused++; return refusePayment(res, "invalid_exact_evm_payload_signature"); }

    // The input, checked the way the direct route checks it before payment: a
    // request that cannot be served is a 4xx with nothing claimed.
    try {
      if (input === null) handlerInputOf(req, def);
      const bad = preValidate(def, req) || prePaymentRefusal(def, input);
      if (bad && Number(bad.status) >= 400) { counters.refused++; return res.status(Number(bad.status)).json(bad.body); }
    } catch (err) {
      const status = Number(err?.statusCode);
      if (status >= 400 && status < 500) { counters.refused++; return res.status(status).json({ error: referralLogText(err?.message), tool: def.slug }); }
      // Anything else is left to the handler, as on the direct route.
    }

    // One authorization, one run.
    const key = referralReplayKey(auth);
    let verdict;
    try { verdict = await replayGuard.begin(key, undefined, { requireShared: !!requireShared(def) }); }
    catch { verdict = "unavailable"; }
    if (verdict === "unavailable") {
      res.setHeader("Retry-After", "30");
      return res.status(503).json({ error: "This route is briefly unavailable: the shared payment store did not answer, so no run was started and nothing was charged. Retry in about 30 seconds.", reason: "replay-store-unavailable" });
    }
    if (verdict !== "ok") {
      counters.replays++;
      res.setHeader("X-Payment-Replay", verdict);
      return res.status(409).json({ error: "Payment authorization already used. Each payment authorization (nonce) is single-use - sign a fresh authorization to make another paid call.", reason: verdict });
    }
    let held = true;
    const release = () => { if (!held) return; held = false; replayGuard.release(key).catch(() => {}); };
    const consume = (settled) => { if (!held) return; held = false; replayGuard.settle(key, undefined, { validBeforeMs, settled }).catch(() => {}); };
    // Post-settlement hooks a handler left on the request (a share link is
    // written only for a settled call): each runs once with the outcome.
    const settledHooks = (ok) => { for (const fn of Array.isArray(req.__onSettled) ? req.__onSettled.splice(0) : []) { try { fn(ok); } catch { /* never break a response */ } } };
    let gone = false;
    let charged = null;
    res.once("close", () => { if (!res.writableFinished) gone = true; });
    const clientGone = () => gone || res.destroyed === true || req.socket?.destroyed === true;

    try {
      if (config.verify) {
        const v = await settler.verify(payment, requirement);
        if (!v.ok) {
          release();
          counters.verifyRefused++;
          line("warn", `verify refused ${def.slug} payer=${shortPayer(payer)} reason=${v.reason} status=${v.status}`);
          // No verdict on the payment (the facilitator did not answer): retry later.
          if (v.inDoubt) return refusePayment(res, "facilitator_unavailable", { status: 503, retryable: true, retryAfter: 30 });
          return refusePayment(res, v.reason || "invalid_payment", { retryable: v.retryable });
        }
        if (v.payer && v.payer !== payer) { release(); counters.verifyRefused++; return refusePayment(res, "invalid_payment"); }
      }
      if (clientGone()) { release(); counters.clientGone++; return undefined; }

      // The handler runs inside the authorization: it ends early enough for
      // the settlement to land before validBefore.
      const left = validBeforeMs - now() - config.settleReserveMs;
      const budget = Math.min(config.deadlineMs, left);
      if (!(left >= REFERRAL_MIN_RUN_MS)) { release(); counters.refused++; return refusePayment(res, "invalid_exact_evm_payload_authorization_valid_before"); }
      if (onRun) { try { onRun(req, res, def); } catch { /* bookkeeping only */ } }
      let result;
      try {
        if (input === null) input = handlerInputOf(req, def);
        result = await withLoopTimeout(
          Promise.resolve().then(() => runAsCaller(req, () => def.handler(input, req))),
          budget,
          () => Object.assign(new Error("The call did not finish in time, so it was not settled and nothing was charged. Retry with a fresh payment."), { statusCode: 504, referralTimeout: true }),
        );
      } catch (err) {
        release();
        settledHooks(false);
        if (err?.referralTimeout) counters.timeouts++; else counters.handlerErrors++;
        // A provider refused the buyer's request and no other model took it: a 400, as on the direct route.
        if (err?.upstreamRejected === true && (err.statusCode || 502) === 502) err.statusCode = 400;
        if (!(Number(err?.statusCode) >= 400)) { try { err.statusCode = 500; } catch { /* a frozen error keeps the renderer's default */ } }
        if (!res.headersSent) sendToolError(res, err, def.slug);
        return undefined;
      }

      // Only a JSON answer can carry the transaction: a stream or raw bytes is refused, uncharged.
      if (result && (result.__binary || typeof result.__sse === "function")) {
        release();
        settledHooks(false);
        counters.handlerErrors++;
        return res.status(500).json({ error: "This tool's answer cannot be served on this route; nothing was charged.", tool: def.slug });
      }
      // The answer is serialized BEFORE the settlement, so a value that
      // cannot be sent is found while nothing has been charged.
      const answer = withIgnoredParams(result, req);
      const wrap = !answer || typeof answer !== "object" || Array.isArray(answer) || Object.hasOwn(answer, "transaction");
      try { if (JSON.stringify(answer === undefined ? null : answer) === undefined) throw new Error("not JSON"); }
      catch {
        release();
        settledHooks(false);
        counters.handlerErrors++;
        return res.status(500).json({ error: "This tool's answer could not be serialized; nothing was charged.", tool: def.slug });
      }

      // The buyer left before settlement starts: nothing could be delivered, so nothing is settled.
      if (clientGone()) {
        release();
        settledHooks(false);
        counters.clientGone++;
        line("warn", `client gone before settlement (${def.slug} payer=${shortPayer(payer)}) - not settled, not charged`);
        return undefined;
      }

      // A settle call that throws says nothing about whether the payment moved.
      let s;
      try { s = await settler.settle(payment, requirement); }
      catch { s = { ok: false, inDoubt: true, reason: "settle_error", status: 0, retryable: false }; }
      if (!s || !s.ok) {
        s = s || { inDoubt: true, reason: "settle_error", status: 0 };
        settledHooks(false);
        // An answer that does not say whether the payment moved, or one that
        // says the authorization is already spent on chain, keeps the claim:
        // that authorization buys no second run. Any other refusal moved
        // nothing, and the claim is given back.
        const hold = s.inDoubt || s.reason === "authorization_used";
        if (hold) { consume(false); counters.settleInDoubt++; } else { release(); counters.settleFailed++; }
        line(hold ? "error" : "warn", `${hold ? "SETTLE-IN-DOUBT" : "settle failed"} after a successful handler (${def.slug} payer=${shortPayer(payer)} reason=${s.reason} status=${s.status})${hold ? " - authorization held, buyer answered 402; the payment may have moved" : " - buyer answered 402, not charged"}`);
        if (!res.headersSent && !clientGone()) refusePayment(res, s.reason || "settle_failed", { retryable: s.retryable });
        return undefined;
      }

      // Settled. The authorization is spent: its mark is held while it stays valid.
      consume(true);
      charged = s.transaction;
      counters.settled++;
      const body = wrap ? { result: answer === undefined ? null : answer, transaction: s.transaction } : { ...answer, transaction: s.transaction };
      const text = JSON.stringify(body);
      const money = referralNet(amount, { commissionBps: commissionBpsFor(config, def.slug), feeBps: config.feeBps });
      try {
        recordSale({
          slug: def.slug, priceUsd: money.netUsd, quoteUsd: money.grossUsd, rail: "referral", wire: "referral", network: "base",
          payer, tx: s.transaction, synthetic: !!isSynthetic(req), responseSha256: createHash("sha256").update(text, "utf8").digest("hex"), via: salePathOf(req),
        });
      } catch { /* accounting never breaks serving */ }
      settledHooks(true);
      line("log", `settled ${def.slug} payer=${shortPayer(payer)} tx=${s.transaction}`);
      const notServed = (why) => { counters.chargedNotServed++; line("error", `CHARGED-BUT-NOT-SERVED: ${why} (${def.slug} payer=${shortPayer(payer)} tx=${s.transaction} gross=${money.grossUsd})`); };
      if (clientGone()) { notServed("the buyer's connection closed during settlement"); return undefined; }
      // A close after this point, before the last byte, is the same outcome.
      res.once("close", () => { if (!res.writableFinished) notServed("the connection closed before the answer was fully sent"); });
      try { res.status(200).type("application/json").send(text); }
      catch (err) { notServed(`the answer could not be written: ${referralLogText(err?.message, 120)}`); }
      return undefined;
    } catch (err) {
      // Nothing above is expected to throw. Before a settlement was sent the
      // claim is given back; after it, `held` is already false.
      release();
      if (charged) counters.chargedNotServed++;
      line("error", `${charged ? `CHARGED-BUT-NOT-SERVED: gate error after settlement tx=${charged}` : "gate error"} (${def.slug}): ${referralLogText(err?.message)}`);
      if (!res.headersSent) { try { res.status(500).json({ error: "request failed", tool: def.slug }); } catch { /* socket already gone */ } }
      return undefined;
    }
  }

  return { handler, stats: () => ({ ...counters }), slugs: () => [...defs.keys()] };
}
