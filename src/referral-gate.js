// Referral copies of paid tool routes: /ref/<slug>.
//
// For each allowlisted tool this gate serves a copy of the paid route whose
// 402 pays a referral network's split contract instead of this server's
// wallet: the buyer signs an EIP-3009 ReceiveWithAuthorization to that
// contract on Base, and the network's facilitator settles it on a request
// signed by a hot key of ours (src/referral-settle.js). The contract pays our
// share to a wallet of ours.
//
// The gate is standalone. It is not a catalog route, adds no rail and rewrites
// nothing onto a catalog path, so every surface derived from the catalog or
// the rails (pricing, openapi, llms.txt, the x402 manifest, the sitemap) stays
// as it is, and a header the x402 paywall cannot verify never reaches a
// catalog-keyed middleware. It calls the tool's own handler.
//
// MONEY RULES (root CLAUDE.md, "x402 settlement ordering"):
//   - The amount is the amount the direct route's Base accept carries for the
//     same request, in USDC base units: the same price function, the same
//     per-network funnel. Never higher.
//   - An authorization is taken only when it is the buyer's own signature
//     (checked here, before any call leaves this server), names the contract
//     and exactly the amount, is still valid for the whole run and the
//     settlement (handler deadline + settle reserve + the verify wait), and
//     expires no more than REFERRAL_MAX_VALIDITY_MS ahead.
//   - One authorization, one run. The replay guard holds it from before the
//     run. It is released only while nothing has run (an input refusal, a
//     verify refusal, a store that did not answer). Once the handler has
//     started the authorization is spent for running purposes whatever
//     happens next: it is held to its validBefore.
//   - Handler first, then settle. The handler runs under the gate's deadline,
//     presented to it as the end of its payment window and as a ceiling on
//     its upstream budget, so its upstream work is cut off at the deadline,
//     not only abandoned. An error, a timeout, a stream or a binary answer is
//     answered as it is and never settled.
//   - A buyer gone before settlement is not settled while the run holds a
//     hang-up forgiveness ticket: the direct routes' rule, on budgets of this
//     gate's own, so referral traffic never changes a direct buyer's outcome.
//     Without a ticket the payment is settled and the answer is kept for the
//     buyer's re-send.
//   - Before /settle is called, the intent is written to a durable book
//     (src/referral-book.js); with no intent stored, /settle is not called.
//     One /settle is in flight per authorization. An answer that does not say
//     whether the payment moved is decided by the chain
//     (src/referral-chain.js): a payment has landed only when the receipt of
//     the transaction that used the nonce shows success and a USDC transfer
//     from the payer to the pay-to address of at least the amount. A nonce
//     spent any other way (a cancel, a transfer elsewhere) delivers nothing
//     and books nothing.
//   - The tool's answer is kept, against the authorization, for the
//     authorization's life: a re-send of the same PAYMENT-SIGNATURE returns
//     it when the payment landed, with no second run and no second sale.
//   - A sale is booked once, at the NET amount (gross less the slug's
//     commission and the fee); the gross is the quote.
//   - Unsettled runs are bounded per signed payer and per client address in
//     this gate's own lane; the direct routes' settle breaker, its status
//     word and its counters neither see nor judge a referral run.
//   - This rail has no refund path. A charge that could not be delivered is
//     logged as CHARGED-BUT-NOT-SERVED, counted, and kept in the book.
//
// TIME. deadline + settle reserve + verify wait must fit the 60 s window the
// 402 asks a buyer to sign for (referralConfig refuses a configuration that
// does not); the settle call itself may run past validBefore, since it waits
// for the receipt of a transaction submitted inside it.
//
// The answer store is in this process: one replica serves today. With two, a
// re-send that reaches the other replica reads the book and the replay guard
// (both shared) and is refused as already used; it does not run again.
import { createHash } from "node:crypto";
import { verifyTypedData, parseCompactSignature, compactSignatureToSignature, serializeSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { USDC_DOMAIN_BY_NETWORK } from "./evm-usdc-domain.js";
import { decodePaymentHeader } from "./payment-header.js";
import { handlerInputOf, withIgnoredParams } from "./handler-input.js";
import { withLoopTimeout } from "./loop-deadline.js";
import { binaryTypesOf } from "./tool-media-type.js";
import { referralLogText } from "./referral-settle.js";
import { chainVerdict } from "./referral-chain.js";
import { runAsReferral } from "./referral-run.js";
import { DEFAULT_KEY_BUDGET_USD, DEFAULT_GLOBAL_BUDGET_USD } from "./hangup-forgiveness.js";

export const REFERRAL_NETWORK = "eip155:8453";
export const REFERRAL_CHAIN_ID = 8453;
const USDC = USDC_DOMAIN_BY_NETWORK[REFERRAL_NETWORK];
export const REFERRAL_ASSET = USDC.asset;
/** What the 402 asks a buyer to sign for. The run, the verify wait and the
 *  settle reserve fit inside it (referralConfig). */
export const REFERRAL_MAX_TIMEOUT_SECONDS = 60;
export const REFERRAL_DEFAULTS = Object.freeze({
  // The handler's budget.
  deadlineMs: 25_000,
  // The facilitator's /settle waits for the receipt.
  settleMs: 50_000,
  verifyMs: 10_000,
  // An authorization must still be valid this long after the handler ends,
  // so the settlement is submitted before validBefore.
  settleReserveMs: 10_000,
  // An authorization may expire at most this far ahead.
  maxValidityMs: 15 * 60_000,
  // Unsettled runs (a settle the facilitator refused for the payment, a run
  // that timed out) one payer or one client address may hold in the window.
  unsettledMax: 3,
  unsettledWindowMs: 15 * 60_000,
  // Paid calls in flight (verify, run and settle together).
  maxInflight: 24,
  feeBps: 0,
});
export const REFERRAL_TOKEN_MAX_CHARS = 8192;
export const REFERRAL_AGENT_ID_MAX_CHARS = 128;
/** One answer larger than this is not served on this route (it is held in memory through the settle). */
export const REFERRAL_ANSWER_MAX_BYTES = 8 * 1024 * 1024;
/** Answers kept for a re-send: this many, this many bytes. */
export const REFERRAL_KEPT_ANSWERS_MAX = 200;
export const REFERRAL_KEPT_BYTES_MAX = 48 * 1024 * 1024;
/** An answer up to this size is stored with its open book entry, so a restart keeps it. */
export const REFERRAL_PERSISTED_ANSWER_MAX_BYTES = 256 * 1024;
/** Settle attempts a kept answer may make after its first. */
export const REFERRAL_RESEND_SETTLES_MAX = 2;

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
function msKnob(env, name, dflt, { min = 1000, max = 3_600_000 } = {}) {
  const raw = String(env?.[name] ?? "").trim();
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : dflt;
}
function intKnob(env, name, dflt, { min = 1, max = 10_000 } = {}) {
  const raw = String(env?.[name] ?? "").trim();
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
}
function usdKnob(env, name, dflt) {
  const raw = String(env?.[name] ?? "").trim();
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : dflt;
}
/**
 * The commission map, `default:<bps>,<slug>:<bps>`: what each slug's sale is
 * booked net of. A bare number is the default. Returns
 * `{ default: number|null, bySlug }`, or null when the text is empty or an
 * entry is malformed: there is no built-in rate, and a net booked from a
 * misread one is worse than a gate that stays off.
 */
export function parseCommissionBps(raw) {
  const out = { default: null, bySlug: {} };
  const text = String(raw ?? "").trim();
  if (!text) return null;
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
/** The commission a slug's sale is booked net of, or null when the map names neither it nor a default. */
export function commissionBpsFor(config, slug) {
  const m = config?.commission;
  if (!m) return null;
  return Object.hasOwn(m.bySlug, slug) ? m.bySlug[slug] : m.default;
}
/** True when the text is a 32-byte key a signer can be made from (never all zero, never past the curve order). */
function usableSignerKey(key) {
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) return false;
  try { return ADDR.test(privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`).address); } catch { return false; }
}

const REQUIRED_VARS = ["REFERRAL_PAY_TO", "REFERRAL_FACILITATOR_URL", "REFERRAL_SIGNER_KEY", "REFERRAL_SLUGS", "REFERRAL_SETUP_URL", "REFERRAL_COMMISSION_BPS"];

/**
 * The gate's configuration, or null (off) unless every required variable is
 * set and well formed. Never throws.
 *
 * Required:
 *   REFERRAL_PAY_TO             the network's split contract (0x address); the 402's payTo
 *   REFERRAL_FACILITATOR_URL    the facilitator's base URL (https)
 *   REFERRAL_SIGNER_KEY         32-byte hex key that signs facilitator requests
 *   REFERRAL_SLUGS              comma list of catalog slugs to serve under /ref/<slug>
 *   REFERRAL_SETUP_URL          the network's setup document, echoed in the 402 (https)
 *   REFERRAL_COMMISSION_BPS     `default:<bps>,<slug>:<bps>`: read ONLY to book the net amount;
 *                               every slug in REFERRAL_SLUGS must be named or covered by `default`
 * Optional (default):
 *   REFERRAL_FEE_BPS            (0) read ONLY to book the net amount
 *   REFERRAL_DEADLINE_MS        (25000) handler budget
 *   REFERRAL_SETTLE_MS          (50000) /settle timeout
 *   REFERRAL_VERIFY_MS          (10000) /verify timeout
 *   REFERRAL_SETTLE_RESERVE_MS  (10000) validity kept for the settlement after the handler
 *   REFERRAL_MAX_VALIDITY_MS    (900000) the furthest ahead an authorization may expire
 *   REFERRAL_VERIFY_SIGNED      (on) /verify carries the signed headers; `off` sends it unsigned
 *   REFERRAL_UNSETTLED_MAX      (3) unsettled runs per payer and per client address in the window
 *   REFERRAL_UNSETTLED_WINDOW_MS (900000)
 *   REFERRAL_MAX_INFLIGHT       (24) paid calls in flight
 *   REFERRAL_HANGUP_KEY_USD, REFERRAL_HANGUP_GLOBAL_USD, REFERRAL_HANGUP_WINDOW_MS
 *                               this route's own hang-up forgiveness budgets (the direct routes'
 *                               sizes: per payer and per address, route-wide, one day)
 * deadline + settle reserve + verify must not exceed the 60 s the 402 asks a
 * buyer to sign for, or the gate stays off.
 */
export function referralConfig(env = process.env) {
  try {
    const payTo = String(env?.REFERRAL_PAY_TO || "").trim();
    const facilitatorUrl = cleanUrl(env?.REFERRAL_FACILITATOR_URL);
    const signerKey = String(env?.REFERRAL_SIGNER_KEY || "").trim();
    const setupUrl = cleanUrl(env?.REFERRAL_SETUP_URL);
    const slugs = [...new Set(String(env?.REFERRAL_SLUGS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
    if (!ADDR.test(payTo) || !facilitatorUrl || !setupUrl || !usableSignerKey(signerKey)) return null;
    if (!slugs.length || !slugs.every((s) => SLUG.test(s))) return null;
    const commission = parseCommissionBps(env?.REFERRAL_COMMISSION_BPS);
    const feeBps = intKnob(env, "REFERRAL_FEE_BPS", REFERRAL_DEFAULTS.feeBps, { min: 0, max: 10_000 });
    if (!commission) return null;
    for (const slug of slugs) {
      const c = Object.hasOwn(commission.bySlug, slug) ? commission.bySlug[slug] : commission.default;
      if (c === null || c + feeBps > 10_000) return null;
    }
    Object.freeze(commission.bySlug);
    const deadlineMs = msKnob(env, "REFERRAL_DEADLINE_MS", REFERRAL_DEFAULTS.deadlineMs);
    const verifyMs = msKnob(env, "REFERRAL_VERIFY_MS", REFERRAL_DEFAULTS.verifyMs);
    const settleReserveMs = msKnob(env, "REFERRAL_SETTLE_RESERVE_MS", REFERRAL_DEFAULTS.settleReserveMs);
    if (deadlineMs + settleReserveMs + verifyMs > REFERRAL_MAX_TIMEOUT_SECONDS * 1000) return null;
    return Object.freeze({
      payTo, facilitatorUrl, signerKey, setupUrl, slugs: Object.freeze(slugs),
      deadlineMs, verifyMs, settleReserveMs,
      settleMs: msKnob(env, "REFERRAL_SETTLE_MS", REFERRAL_DEFAULTS.settleMs),
      maxValidityMs: msKnob(env, "REFERRAL_MAX_VALIDITY_MS", REFERRAL_DEFAULTS.maxValidityMs, { min: REFERRAL_MAX_TIMEOUT_SECONDS * 1000 }),
      verifySigned: String(env?.REFERRAL_VERIFY_SIGNED || "").trim().toLowerCase() !== "off",
      unsettledMax: intKnob(env, "REFERRAL_UNSETTLED_MAX", REFERRAL_DEFAULTS.unsettledMax, { min: 1, max: 1000 }),
      unsettledWindowMs: msKnob(env, "REFERRAL_UNSETTLED_WINDOW_MS", REFERRAL_DEFAULTS.unsettledWindowMs),
      maxInflight: intKnob(env, "REFERRAL_MAX_INFLIGHT", REFERRAL_DEFAULTS.maxInflight, { min: 1, max: 1000 }),
      // This route's own hang-up forgiveness budgets (USD, as micro-dollars):
      // the sizes the direct routes use, counted apart from them.
      hangupKeyMicro: Math.round(usdKnob(env, "REFERRAL_HANGUP_KEY_USD", DEFAULT_KEY_BUDGET_USD) * 1e6),
      hangupGlobalMicro: Math.round(usdKnob(env, "REFERRAL_HANGUP_GLOBAL_USD", DEFAULT_GLOBAL_BUDGET_USD) * 1e6),
      hangupWindowMs: msKnob(env, "REFERRAL_HANGUP_WINDOW_MS", 24 * 3600_000, { max: 30 * 24 * 3600_000 }),
      commission: Object.freeze(commission), feeBps,
    });
  } catch { return null; }
}

/** Names (never values) of the required variables that are set while the gate
 *  is off, for one boot warning: a half-configured gate serves nothing. */
export function referralConfigProblem(env = process.env) {
  if (referralConfig(env)) return null;
  const set = REQUIRED_VARS.filter((n) => String(env?.[n] || "").trim());
  if (!set.length) return null;
  const missing = REQUIRED_VARS.filter((n) => !set.includes(n));
  return missing.length ? `missing ${missing.join(", ")}` : "a value is not usable (an address, an https URL, a 32-byte signer key, a slug list, a commission map that covers every slug, commission plus fee past 10000 bps, or deadline + settle reserve + verify past 60 s)";
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

/** What a sale on this route books: the gross the buyer paid, and the net
 *  left after the commission and the fee. Each leg is floored (a leg that
 *  rounds to zero is not taken), so the remainder stays in net. */
export function referralNet(grossUnits, { commissionBps = 0, feeBps = 0 } = {}) {
  const gross = BigInt(grossUnits);
  const commission = (gross * BigInt(commissionBps)) / 10_000n;
  const fee = (gross * BigInt(feeBps)) / 10_000n;
  const net = gross - commission - fee;
  return { grossUnits: gross, netUnits: net > 0n ? net : 0n, grossUsd: Number(gross) / 1e6, netUsd: Number(net > 0n ? net : 0n) / 1e6 };
}

/**
 * Why a catalog definition cannot be served as a referral copy, or null.
 * `flags` are the server's own readings of the definition:
 *   compute       its handler reaches no upstream (nothing to cut off)
 *   clamped       its upstream work ends at the gate's deadline (it reads the
 *                 payment window the gate presents, or runs under a handler
 *                 budget the gate's ceiling caps)
 *   ownTimeoutMs  otherwise, the longest its own upstream wait can take
 * A tool that is neither `compute` nor `clamped` is served only when its own
 * upstream timeout is known and fits the handler deadline: a run the deadline
 * cannot cut off would keep spending upstream after the buyer was told it was
 * not charged.
 */
export function referralIneligibility(def, { identityBound = false, lastingEffect = false, paysThirdParty = false, longRunning = false, compute = false, clamped = false, ownTimeoutMs = null, deadlineMs = REFERRAL_DEFAULTS.deadlineMs, priceForNetwork = (p) => p } = {}) {
  if (!def || typeof def !== "object") return "not in the catalog";
  if (typeof def.handler !== "function") return "in the catalog but has no handler";
  if (identityBound) return "identity-bound route";
  if (lastingEffect) return "its effect outlives the answer";
  if (paysThirdParty) return "pays an outside seller";
  if (longRunning) return "long-running or composite route";
  if (binaryTypesOf(def)) return "answers bytes, not JSON";
  if (!compute && !clamped) {
    if (!Number.isFinite(ownTimeoutMs) || !(ownTimeoutMs > 0)) return "declares no upstream timeout the handler deadline can be checked against";
    if (ownTimeoutMs > deadlineMs) return `its own upstream wait (${Math.round(ownTimeoutMs / 1000)} s) is past the handler deadline (${Math.round(deadlineMs / 1000)} s)`;
  }
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
  const served = [];
  const bySlug = new Map(Object.values(catalog || {}).filter((d) => d && typeof d.slug === "string").map((d) => [d.slug, d]));
  for (const slug of config?.slugs || []) {
    const def = bySlug.get(slug);
    let reason;
    try { reason = referralIneligibility(def, { deadlineMs: config.deadlineMs, ...(def ? flagsOf(def) : {}) }); }
    catch { reason = "could not be checked"; }
    if (reason) { refused.push({ slug, reason }); continue; }
    defs.set(slug, def);
    // Why the handler deadline can be kept, for the boot line.
    let f = {};
    try { f = flagsOf(def) || {}; } catch { f = {}; }
    served.push({ slug, why: f.compute ? "no upstream work" : f.clamped ? `upstream work ends at the deadline${Number.isFinite(f.ownTimeoutMs) && f.ownTimeoutMs > 0 ? ` (own timeout ${Math.round(f.ownTimeoutMs / 1000)} s)` : ""}` : `own upstream timeout ${Math.round(f.ownTimeoutMs / 1000)} s fits` });
  }
  return { defs, refused, served };
}

/** The slug a request path names under /ref/, or null. Case, a trailing slash
 *  and percent-encoding are folded the way the router resolves the path: the
 *  wide reading, for the gates that must COUNT every spelling. The gate itself
 *  serves the canonical spelling only (isCanonicalReferralPath). */
export function referralSlugOfPath(path) {
  let p = String(path || "");
  if (p.length > 200) return null;
  try { p = decodeURIComponent(p); } catch { /* a malformed escape stays as written */ }
  p = p.toLowerCase().replace(/\/{2,}/g, "/");
  if (!p.startsWith("/ref/")) return null;
  const slug = p.slice(5).replace(/\/+$/, "");
  return SLUG.test(slug) ? slug : null;
}
/** True for exactly `/ref/<slug>`: no escape, no case change, no extra slash. */
export function isCanonicalReferralPath(path, slug) {
  return typeof path === "string" && typeof slug === "string" && path === `/ref/${slug}`;
}

/** True when `signature` is an ECDSA signature by `auth.from` over the
 *  ReceiveWithAuthorization typed data of Base USDC. A 65-byte signature with
 *  v 27/28 or 0/1 and a 64-byte EIP-2098 compact one are all read (the forms
 *  the facilitator's documents accept). Pure: no network call. */
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
 * `{ auth, signature, validBeforeMs, timeReason }` (`timeReason` a refusal
 * code when the authorization's clock window does not fit, else null). Reads
 * string fields only.
 * `needMs`: the validity the authorization must still carry (the whole run
 * and its settlement); `maxValidityMs`: the furthest ahead it may expire.
 */
export function checkReferralPayment(payment, requirement, { nowMs = Date.now(), needMs = REFERRAL_DEFAULTS.deadlineMs + REFERRAL_DEFAULTS.settleReserveMs + REFERRAL_DEFAULTS.verifyMs, maxValidityMs = REFERRAL_DEFAULTS.maxValidityMs } = {}) {
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
  if (!auth || typeof auth !== "object" || Array.isArray(auth) || typeof signature !== "string" || !HEX.test(signature)) return refuse("invalid_payload");
  // An ECDSA signature in one of its two forms: nothing else can be checked here.
  if (signature.length !== 132 && signature.length !== 130) return refuse("invalid_exact_evm_payload_signature");
  if (!ADDR.test(txt(auth.from)) || !ADDR.test(txt(auth.to)) || !B32.test(txt(auth.nonce))) return refuse("invalid_payload");
  for (const f of ["value", "validAfter", "validBefore"]) if (!UINT.test(txt(auth[f]))) return refuse("invalid_payload");
  // The money checks: the contract named in the 402, and exactly the amount.
  if (lc(auth.to) !== lc(requirement.payTo)) return refuse("invalid_exact_evm_payload_recipient_mismatch");
  if (BigInt(auth.value) !== BigInt(requirement.amount)) return refuse("invalid_exact_evm_payload_authorization_value_mismatch");
  // EIP-2: the upper-half-s twin of a valid signature is refused, as the token does.
  if (signature.length === 132 && BigInt(`0x${signature.slice(66, 130)}`) > SECP256K1_HALF_N) return refuse("invalid_exact_evm_payload_signature");
  const validBeforeSec = BigInt(auth.validBefore);
  // Bounded before it becomes a Number.
  if (validBeforeSec > 4_102_444_800n) return refuse("authorization_validity_too_long");
  const validBeforeMs = Number(validBeforeSec) * 1000;
  // The clock checks are a reason of their own (`timeReason`), read by the
  // caller AFTER it has looked for an answer already kept for this payment:
  // a re-send of a payment that ran is answered whatever the clock says now.
  const nowSec = BigInt(Math.floor(nowMs / 1000));
  let timeReason = null;
  if (BigInt(auth.validAfter) > nowSec) timeReason = "invalid_exact_evm_payload_authorization_valid_after";
  // Long enough for the whole run and its settlement: a shorter one is
  // refused, never run on a shortened budget.
  else if (validBeforeMs - nowMs < needMs) timeReason = "invalid_exact_evm_payload_authorization_valid_before";
  // And no longer than the bound: a held claim always ends soon.
  else if (validBeforeMs - nowMs > maxValidityMs) timeReason = "authorization_validity_too_long";
  return { auth, signature, validBeforeMs, timeReason };
}

/** The replay identity of a referral authorization: the chain consumes a
 *  nonce per (token, from), so that pair on Base is the payment. */
export function referralReplayKey(auth) {
  return `referral:${createHash("sha256").update(`${REFERRAL_NETWORK}\n${lc(auth.from)}\n${lc(auth.nonce)}`).digest("hex")}`;
}

/** Reason codes of this gate's own, with the sentence each answer carries. */
export const REFERRAL_REASONS = Object.freeze({
  invalid_request: "The payment header does not decode to a payment. Nothing was charged.",
  invalid_payload: "The payment carries no usable authorization and signature. Nothing was charged.",
  invalid_network: "This route settles USDC on Base (eip155:8453) only. Nothing was charged.",
  invalid_payment_requirements: "The payment names another asset than the one this route's 402 asks. Nothing was charged.",
  unsupported_scheme: "This route takes the exact scheme only. Nothing was charged.",
  invalid_exact_evm_payload_recipient_mismatch: "The authorization does not pay the address this route's 402 names. Nothing was charged.",
  invalid_exact_evm_payload_authorization_value_mismatch: "The authorization's value is not the amount this request's 402 asks. Nothing was charged.",
  invalid_exact_evm_payload_authorization_valid_before: "The authorization expires too soon for the call to run and settle. Nothing was charged. Request the 402 again and pay it at once.",
  invalid_exact_evm_payload_authorization_valid_after: "The authorization is not valid yet. Nothing was charged.",
  invalid_exact_evm_payload_signature: "The signature is not the payer's own ECDSA signature over this ReceiveWithAuthorization. Nothing was charged.",
  authorization_validity_too_long: "The authorization expires too far ahead for this route. Nothing was charged. Sign one that expires within the time the 402 asks.",
  facilitator_unavailable: "The payment could not be checked right now. Nothing ran and nothing was charged. Retry shortly.",
  settle_outcome_unknown: "The call ran, but whether the payment settled is not known yet. Send the same PAYMENT-SIGNATURE again: if the payment was charged, the answer is returned with its transaction and nothing runs or is charged twice; if it was not, nothing is owed.",
  settle_refused: "The call ran, but the payment was not settled. Nothing was charged.",
  authorization_expired_unused: "This authorization expired without being used. Nothing was charged. Sign a new one to make the call again.",
  answer_unavailable: "This authorization was already used for a call whose answer is no longer held here.",
  authorization_used_unpaid: "This authorization was spent on chain without paying this route (canceled, or used for another transfer), so the answer is not delivered. This route was not paid. Sign a new authorization to make the call again.",
  settlement_unavailable: "The payment could not be settled because of a fault on this server's side. Nothing was charged. If the call ran, its answer is kept: send the same PAYMENT-SIGNATURE again later.",
  settlement_store_unavailable: "The call ran, but the settlement could not be recorded, so the payment was not submitted. Nothing was charged. Send the same PAYMENT-SIGNATURE again shortly: the answer is kept and nothing runs twice.",
  too_many_unsettled_runs: "Too many calls from this payer or address ran without their payment settling. Nothing was charged for this request. Retry later.",
  busy: "Too many paid calls are in flight on this route. Nothing ran and nothing was charged. Retry shortly.",
  draining: "This host is restarting. Nothing ran and nothing was charged. Retry in a minute.",
});

/** A log that prints the first `perMinute` lines of a minute and then one
 *  summary of how many were left out (the shape of src/prepayment-refusal.js's sampler). */
export function createLineSampler({ perMinute = 20, now = Date.now, print = () => {} } = {}) {
  let minute = -1, printed = 0, suppressed = 0;
  const flush = () => { if (suppressed > 0) { try { print(`refusal lines summary: ${suppressed} more in that minute`); } catch { /* a log never throws */ } } printed = 0; suppressed = 0; };
  return {
    line(text) {
      const m = Math.floor(now() / 60_000);
      if (m !== minute) { flush(); minute = m; }
      if (printed < perMinute) { printed++; try { print(text); } catch { /* a log never throws */ } return true; }
      suppressed++;
      return false;
    },
    flush,
    stats: () => ({ printed, suppressed }),
  };
}

/**
 * Build the gate. Every dependency on the server is passed in, so the module
 * can be run against stubs. Required: config, defs, settler, chain, book,
 * replayGuard, priceUsdOf, priceForNetwork, sendToolError, recordSale.
 *
 * @param {object} o
 * @param {object} o.config                    referralConfig()
 * @param {Map<string, object>} o.defs         slug -> catalog definition (referralRoutes)
 * @param {{verify: Function, settle: Function}} o.settler   createReferralSettler()
 * @param {{state: Function}} o.chain          createReferralChainReader()
 * @param {object} o.book                      createReferralBook()
 * @param {object} o.replayGuard               createReplayGuard(): a guard of this gate's own
 * @param {(def, req) => number} o.priceUsdOf  the server's per-request price (stashes the quote on the request)
 * @param {(price: string, network: string) => string} o.priceForNetwork
 * @param {(def, req) => ({status, body}|null)} [o.preValidate]        the pre-payment input check
 * @param {(def, input) => ({status, body}|null)} [o.prePaymentRefusal] the metered pre-payment refusal
 * @param {(req, res) => Promise<boolean>} [o.payerScreen]  the payer screen: false when it answered the refusal itself
 * @param {(req) => void} [o.isolate]          keep this run out of the direct routes' money guards
 * @param {(req, endsAtMs) => void} [o.presentWindow]  present the run's deadline as its payment window
 * @param {(ms, fn) => any} [o.withCeiling]    run fn with handler budgets capped at ms
 * @param {{limited, note}} [o.credentialLimiter]  the refused-credential limiter
 * @param {() => ({active: boolean, leftMs: number})} [o.draining]
 * @param {(tx) => boolean} [o.saleBooked]     whether a sale stands for this transaction
 * @param {(req) => void} [o.onSettledSale]    a settled sale by this client (paid-client allowance)
 */
export function createReferralGate({
  config, defs, settler, chain, book, replayGuard, baseUrl, priceUsdOf, priceForNetwork,
  preValidate, prePaymentRefusal, warmQuote, runAsCaller, sendToolError, recordSale, saleBooked, isSynthetic, salePathOf, requireShared, onRun = null,
  payerScreen, isolate, presentWindow, withCeiling, credentialLimiter, clientKey, draining, onSettledSale,
  log = console, now = Date.now,
} = {}) {
  if (!config || !(defs instanceof Map) || !settler || !chain || !book || !replayGuard) throw new Error("referral gate: config, defs, settler, chain, book and replayGuard are required");
  // Every dependency on the server is REQUIRED: a gate built without one of
  // them would run with a rule silently missing (no payer screen, no
  // deadline on upstream work, no drain check), so it is not built at all.
  const required = { priceUsdOf, priceForNetwork, preValidate, prePaymentRefusal, warmQuote, runAsCaller, sendToolError, recordSale, saleBooked, isSynthetic, salePathOf, requireShared, payerScreen, isolate, presentWindow, withCeiling, clientKey, draining, onSettledSale };
  const missing = Object.entries(required).filter(([, v]) => typeof v !== "function").map(([k]) => k);
  if (!credentialLimiter || typeof credentialLimiter.limited !== "function" || typeof credentialLimiter.note !== "function") missing.push("credentialLimiter");
  if (missing.length) throw new Error(`referral gate: missing ${missing.join(", ")}`);
  const origin = String(baseUrl || "").replace(/\/+$/, "");
  const counters = {
    challenges: 0, refused: 0, signatureRefused: 0, replays: 0, verifyRefused: 0, screened: 0, laneRefused: 0, busy: 0,
    signerRefused: 0, restoredAnswers: 0, runs: 0, exampleRuns: 0, handlerErrors: 0, timeouts: 0, forgivenHangups: 0, settleRefused: 0, settleInDoubt: 0, landedAfterDoubt: 0, usedUnpaid: 0, intentFailed: 0,
    settled: 0, resent: 0, redelivered: 0, chargedNotServed: 0,
  };
  const line = (level, text) => { try { (log[level] || log.log).call(log, `[referral] ${text}`); } catch { /* a log never breaks a call */ } };
  const refusalLog = createLineSampler({ now, print: (text) => line("warn", text) });
  // Faults of this server's own (the signer refused): error lines an operator sees, sampled the same way.
  const faultLog = createLineSampler({ now, print: (text) => line("error", text) });
  const shortPayer = (from) => `${String(from).slice(0, 6)}`;
  const needMs = config.deadlineMs + config.settleReserveMs + config.verifyMs;

  // ---- the unsettled-run lane (per signed payer, per client address) --------------
  // A key holds the runs it has in flight (counted at admission, so a burst
  // cannot all start before the first one ends) and its unsettled outcomes
  // inside the window: a settle the facilitator refused for the payment, a
  // run that timed out, a nonce spent without paying, and a settle whose
  // outcome is not known yet. An outcome is tagged with its authorization, so
  // the note is taken back when that payment is later proven paid.
  const lane = new Map(); // key -> { inflight, notes: [[t, tag]] }
  const LANE_MAX_KEYS = 20_000;
  const laneOf = (key, create) => {
    let l = lane.get(key);
    if (!l && create) {
      if (lane.size >= LANE_MAX_KEYS) { for (const [k, v] of lane) { if (v.inflight === 0) { lane.delete(k); break; } } }
      l = { inflight: 0, notes: [] };
      lane.set(key, l);
    }
    return l || null;
  };
  const laneLoad = (key, t) => {
    const l = lane.get(key);
    if (!l) return 0;
    while (l.notes.length && t - l.notes[0][0] >= config.unsettledWindowMs) l.notes.shift();
    if (!l.notes.length && l.inflight === 0) { lane.delete(key); return 0; }
    return l.notes.length + l.inflight;
  };
  const laneKeysOf = (req, payer) => [`payer:${payer}`, `addr:${clientKey(req)}`];
  /** Admit a run: false when a key is at its bound, else the run is counted in flight under each key. */
  const laneAdmit = (keys) => {
    const t = now();
    if (keys.some((key) => laneLoad(key, t) >= config.unsettledMax)) return false;
    for (const key of keys) laneOf(key, true).inflight++;
    return true;
  };
  const laneLeave = (keys) => { for (const key of keys) { const l = lane.get(key); if (l && l.inflight > 0) l.inflight--; } };
  const laneNote = (keys, tag = null) => { const t = now(); for (const key of keys) { const l = laneOf(key, true); if (tag && l.notes.some((n) => n[1] === tag)) continue; l.notes.push([t, tag]); } };
  const laneClear = (keys, tag) => { if (!tag) return; for (const key of keys) { const l = lane.get(key); if (l) l.notes = l.notes.filter((n) => n[1] !== tag); } };

  // ---- hang-up forgiveness: this route's own budget ---------------------------------
  // The direct routes' rule (a buyer gone before settlement is not charged
  // while the run holds a ticket priced at its charge, against a per-payer,
  // a per-address and a route-wide budget that a paid success never refills),
  // on budgets of this gate's own: a referral run never holds or spends a
  // cent of the budget a direct buyer's hang-up is judged against. Abandoned
  // records are kept in the book, so a restart does not refill them.
  const MICRO = 1e6;
  const forgive = { inflight: new Map(), globalInflight: 0, abandoned: [] };
  const digestKey = (k) => createHash("sha256").update(String(k)).digest("hex").slice(0, 24);
  let forgivenLoaded = false;
  const loadForgiven = () => { if (forgivenLoaded) return; forgivenLoaded = true; try { forgive.abandoned = book.forgiven().map((r) => [Number(r[0]), Number(r[1]), Array.isArray(r[2]) ? r[2] : []]); } catch { forgive.abandoned = []; } };
  Promise.resolve(book.ready).then(() => { forgivenLoaded = false; loadForgiven(); }).catch(() => {});
  function reserveForgiveness(keys, micro) {
    loadForgiven();
    const t = now();
    forgive.abandoned = forgive.abandoned.filter((r) => t - r[0] < config.hangupWindowMs);
    const ids = keys.map(digestKey);
    const ticket = { granted: false, ids, micro, open: false };
    if (!(micro > 0)) return ticket;
    const spentBy = (id) => forgive.abandoned.reduce((a, r) => a + (r[2].includes(id) ? r[1] : 0), 0) + (forgive.inflight.get(id) || 0);
    const spentAll = forgive.abandoned.reduce((a, r) => a + r[1], 0) + forgive.globalInflight;
    if (ids.some((id) => spentBy(id) + micro > config.hangupKeyMicro) || spentAll + micro > config.hangupGlobalMicro) return ticket;
    for (const id of ids) forgive.inflight.set(id, (forgive.inflight.get(id) || 0) + micro);
    forgive.globalInflight += micro;
    ticket.granted = true;
    ticket.open = true;
    return ticket;
  }
  function finishForgiveness(ticket, abandoned) {
    if (!ticket || !ticket.open) return;
    ticket.open = false;
    for (const id of ticket.ids) { const left = (forgive.inflight.get(id) || 0) - ticket.micro; if (left > 0) forgive.inflight.set(id, left); else forgive.inflight.delete(id); }
    forgive.globalInflight = Math.max(0, forgive.globalInflight - ticket.micro);
    if (!abandoned) return;
    const record = [now(), ticket.micro, ticket.ids];
    forgive.abandoned.push(record);
    book.noteForgiven(record, { windowMs: config.hangupWindowMs }).catch(() => {});
  }

  // ---- answers kept for a re-send, by replay key ------------------------------------
  const kept = new Map(); // key -> entry (insertion order = age)
  let keptBytes = 0;
  // One /settle in flight per authorization: the request that is settling
  // holds the slot, and a re-send that arrives meanwhile is told so.
  const settling = new Set();
  let inflight = 0;
  const dropKept = (key) => { const e = kept.get(key); if (e) { keptBytes -= e.bytes; kept.delete(key); } };
  // What an entry still owes its buyer: an answer whose payment landed and was
  // not delivered, or whose settle outcome is not known, is the last to go.
  const owed = (e) => (e.landed && !e.delivered) || e.everInDoubt === true && !e.unpaid && !e.delivered;
  const pruneKept = () => {
    const t = now();
    // Ten minutes past its authorization an answer nothing is owed on goes;
    // an hour past it any answer goes (the book and its sweep hold the case).
    for (const [key, e] of kept) { if ((t > e.validBeforeMs + 10 * 60_000 && !owed(e)) || t > e.validBeforeMs + 60 * 60_000) dropKept(key); }
  };
  const keep = (entry) => {
    pruneKept();
    if (entry.bytes > REFERRAL_ANSWER_MAX_BYTES) return false;
    dropKept(entry.key);
    while (kept.size >= REFERRAL_KEPT_ANSWERS_MAX || keptBytes + entry.bytes > REFERRAL_KEPT_BYTES_MAX) {
      // Delivered and definitively refused answers go first, oldest first.
      let victim = null;
      for (const [key, e] of kept) { if (!owed(e)) { victim = key; break; } }
      if (victim === null) {
        victim = kept.keys().next().value;
        if (victim === undefined) break;
        const e = kept.get(victim);
        // An answer still owed is dropped only when nothing else is left, and the book says so.
        line("error", `kept answers are full of answers still owed; dropping the oldest (${e.slug} payer=${shortPayer(e.payer)} ${e.landed ? "charged, undelivered" : "settle in doubt"}); recorded in the book`);
        book.resolve(victim, { answerEvicted: true }).catch(() => {});
      }
      dropKept(victim);
    }
    kept.set(entry.key, entry);
    keptBytes += entry.bytes;
    return true;
  };

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

  // The ready-to-run call a refusal carries is built for the direct route: it
  // is dropped here. Every other hint that would name a route is left out
  // where it is written (routeHint, src/referral-run.js), not rewritten.
  function scrub(body) {
    if (!body || typeof body !== "object" || !Object.hasOwn(body, "howToCall")) return body;
    const copy = { ...body };
    delete copy.howToCall;
    return copy;
  }

  const refusePayment = (res, reason, { status = 402, retryable = false, retryAfter = null, message = null } = {}) => {
    if (retryAfter) res.setHeader("Retry-After", String(retryAfter));
    const text = message || REFERRAL_REASONS[reason] || (status === 402 ? "The payment was not accepted. Nothing was charged." : null);
    return res.status(status).json({ success: false, errorReason: reason, ...(text ? { errorMessage: text } : {}), ...(retryable ? { retryable: true } : {}) });
  };

  /** Book the sale for a settled authorization, once. Only ever called with
   *  the transaction that paid: the facilitator's own, or the one whose
   *  receipt proved the transfer. */
  function bookSale({ key, slug, amount, payer, tx, sha = null, req = null }) {
    if (!tx) return false;
    const entry = kept.get(key);
    if (entry?.saleBooked) return true;
    if (book.get(key)?.saleBooked === true) { if (entry) entry.saleBooked = true; return true; }
    try { if (saleBooked(tx)) { if (entry) entry.saleBooked = true; return true; } } catch { /* booked below */ }
    const commissionBps = commissionBpsFor(config, slug);
    if (commissionBps === null) { line("error", `sale NOT booked: no commission is configured for ${slug} (tx=${tx})`); return false; }
    const money = referralNet(amount, { commissionBps, feeBps: config.feeBps });
    try {
      recordSale({
        slug, priceUsd: money.netUsd, quoteUsd: money.grossUsd, rail: "referral", wire: "referral", network: "base",
        payer, tx, synthetic: req ? !!isSynthetic(req) : false, responseSha256: sha, via: req ? salePathOf(req) : null,
      });
    } catch { return false; }
    if (entry) entry.saleBooked = true;
    return true;
  }

  /** The 200: the tool's answer with the settle transaction at the top level. */
  function bodyText(entry) {
    const tail = `"transaction":${JSON.stringify(entry.charged)}`;
    if (entry.wrap) return `{"result":${entry.text},${tail}}`;
    return entry.text === "{}" ? `{${tail}}` : `${entry.text.slice(0, -1)},${tail}}`;
  }
  function deliver(res, entry, { redelivery = false } = {}) {
    // No proof of payment, no delivery.
    if (!entry.landed || !entry.charged) return false;
    const text = bodyText(entry);
    const notServed = (why) => { counters.chargedNotServed++; line("error", `CHARGED-BUT-NOT-SERVED: ${why} (${entry.slug} payer=${shortPayer(entry.payer)} tx=${entry.charged}); the answer is kept for a re-send of the same payment`); book.resolve(entry.key, { state: "charged-undelivered", tx: entry.charged, saleBooked: entry.saleBooked === true, landedAt: now() }).catch(() => {}); };
    if (res.destroyed || res.writableEnded) { notServed("the buyer's connection closed before the answer could be sent"); return false; }
    res.once("close", () => {
      if (!res.writableFinished) { notServed("the connection closed before the answer was fully sent"); return; }
      // Delivered: nothing is left open for this authorization.
      entry.delivered = true;
      book.resolve(entry.key, null).catch(() => {});
    });
    try { res.status(200).type("application/json").send(text); if (redelivery) counters.redelivered++; return true; }
    catch (err) { notServed(`the answer could not be written: ${referralLogText(err?.message, 120)}`); return false; }
  }

  /** The payment is proven: book it, keep the case until delivered, take back its lane note. */
  async function markPaid(entry, tx, req, sha = null) {
    entry.charged = tx;
    entry.landed = true;
    entry.unpaid = false;
    bookSale({ key: entry.key, slug: entry.slug, amount: entry.amount, payer: entry.payer, tx, sha: sha || createHash("sha256").update(bodyText(entry), "utf8").digest("hex"), req });
    await book.resolve(entry.key, { state: "charged-undelivered", tx, saleBooked: entry.saleBooked === true, landedAt: now() }).catch(() => {});
    laneClear(entry.laneKeys || [], entry.key);
    try { if (req) onSettledSale(req); } catch { /* a convenience, never a reason to fail */ }
  }

  /**
   * Read the chain for a kept answer and act on its one-word verdict
   * (chainVerdict, src/referral-chain.js). Returns "charged" (the receipt
   * proves the payment), "unpaid" (the nonce was spent without paying us:
   * never delivered, never booked), "expired-unused", "unused" or "unknown".
   */
  async function readChain(entry, req, { wait = false, why = "re-send" } = {}) {
    let c;
    try { c = await chain.state({ from: entry.payer, nonce: entry.auth.nonce, payTo: config.payTo, amount: entry.amount }, { wait }); }
    catch { c = { used: null, paid: null, transaction: null, logsRead: false }; }
    const verdict = chainVerdict(c, { validBeforeMs: entry.validBeforeMs, nowMs: now(), slackMs: 30_000 });
    if (verdict === "paid") {
      await markPaid(entry, c.transaction, req);
      counters.landedAfterDoubt++;
      line("error", `SETTLE-IN-DOUBT resolved by the chain: the payment landed (${entry.slug} payer=${shortPayer(entry.payer)} tx=${c.transaction}; ${why})`);
      return "charged";
    }
    if (verdict === "unpaid") {
      // Spent without paying this route (a cancel, a transfer elsewhere, a
      // short or reverted transaction): no delivery, no sale, and it counts
      // as an unsettled run in the payer's lane.
      entry.unpaid = true;
      entry.inDoubt = false;
      counters.usedUnpaid++;
      laneClear(entry.laneKeys || [], entry.key);
      laneNote(entry.laneKeys || [], null);
      await book.resolve(entry.key, null).catch(() => {});
      line("error", `authorization spent on chain WITHOUT paying this route (${entry.slug} payer=${shortPayer(entry.payer)} tx=${c.transaction || "none of ours"}; ${why}) - nothing delivered, nothing booked`);
      return "unpaid";
    }
    entry.chainUnused = verdict === "unused" || verdict === "expired-unused";
    if (verdict === "expired-unused") return "expired-unused";
    if (entry.inDoubt) {
      await book.resolve(entry.key, { state: "in-doubt", reason: entry.lastReason || null }).catch(() => {});
      line("error", `SETTLE-IN-DOUBT (${entry.slug} payer=${shortPayer(entry.payer)} ${why}; chain reads ${verdict === "unused" ? "unused so far" : "no proof yet"}) - answer kept, authorization held, buyer answered 402`);
    }
    return verdict;
  }

  // Refusals that say the authorization is already spent: the chain decides what that means.
  const USED_STYLE = /(^|_)(used|nonce|replay|replayed|duplicate)(_|$)/;

  /**
   * Ask the facilitator to settle a kept answer's payment and read the
   * outcome to its end. Returns "charged", "refused" (definite, nothing
   * moved; entry.lastReason, entry.lastSide), "unpaid", "expired-unused",
   * "unknown", or "no-intent" (the durable intent could not be written, so
   * nothing was sent). The caller holds the authorization's settle slot.
   */
  async function settleEntry(entry, req) {
    // No durable intent, no settle: a payment that moved with no record of
    // the attempt is the one case nothing could ever reconcile.
    let stored = false;
    // The answer rides in the entry while it is open (a restart must not
    // leave a charged buyer without it); one past the bound is kept in memory only.
    const answer = entry.bytes <= REFERRAL_PERSISTED_ANSWER_MAX_BYTES ? { text: entry.text, wrap: entry.wrap, digest: entry.digest, payment: entry.payment, requirement: entry.requirement } : null;
    if (!answer) line("warn", `an answer of ${entry.bytes} bytes is kept in memory only (${entry.slug}); a restart before it is delivered loses it`);
    try { stored = (await book.intent({ key: entry.key, slug: entry.slug, payer: entry.payer, nonce: entry.auth.nonce, amount: entry.amount, validBefore: Math.floor(entry.validBeforeMs / 1000), answer })) === true; }
    catch { stored = false; }
    if (!stored) {
      counters.intentFailed++;
      line("error", `the intent to settle could not be stored (${entry.slug} payer=${shortPayer(entry.payer)}); /settle NOT called, nothing charged, answer kept`);
      return "no-intent";
    }
    entry.settleAttempts++;
    const d = draining();
    // During a drain the call ends inside what the drain has left; the intent
    // above stands for it if the process stops first.
    const timeoutMs = d.active ? Math.max(2_000, Math.min(config.settleMs, d.leftMs - 5_000)) : config.settleMs;
    let s;
    try { s = await settler.settle(entry.payment, entry.requirement, { timeoutMs }); }
    catch { s = { ok: false, inDoubt: true, reason: "settle_error", status: 0, retryable: false }; }
    if (!s) s = { ok: false, inDoubt: true, reason: "settle_error", status: 0 };
    // A settle that names another payer than the one who signed is not an answer about this payment.
    if (s.ok && s.payer && s.payer !== entry.payer) { line("error", `settle answered for another payer than the signer (${entry.slug} payer=${shortPayer(entry.payer)}); reading the chain`); s = { ok: false, inDoubt: true, reason: "settle_payer_mismatch", status: s.status }; }
    if (s.ok) {
      await markPaid(entry, s.transaction, req);
      counters.settled++;
      line("log", `settled ${entry.slug} payer=${shortPayer(entry.payer)} tx=${s.transaction}`);
      return "charged";
    }
    entry.lastReason = s.reason || "settle_failed";
    entry.lastSide = s.side || null;
    entry.lastRetryable = s.retryable === true;
    const usedStyle = USED_STYLE.test(entry.lastReason);
    if (!s.inDoubt && !entry.everInDoubt && !usedStyle) {
      // A definite refusal of a payment that was never in doubt: nothing
      // moved, and nothing is left open in the book.
      entry.inDoubt = false;
      await book.resolve(entry.key, null).catch(() => {});
      if (entry.lastSide === "ours") {
        counters.signerRefused++;
        faultLog.line(`the facilitator refused THIS SERVER's request at /settle (${entry.slug} reason=${entry.lastReason} status=${s.status}): check REFERRAL_SIGNER_KEY and the signer's role; not charged, answer kept, buyer answered 503`);
      } else {
        counters.settleRefused++;
        line("warn", `settle refused after a successful handler (${entry.slug} payer=${shortPayer(entry.payer)} reason=${entry.lastReason} status=${s.status}) - not charged, authorization held`);
      }
      return "refused";
    }
    // In doubt now, in doubt before, or refused as already spent: the chain
    // says what happened. An entry that was ever in doubt stays in the book
    // until the chain proves it paid, spent elsewhere, or expired unused.
    if (s.inDoubt) counters.settleInDoubt++;
    entry.inDoubt = true;
    entry.everInDoubt = true;
    laneNote(entry.laneKeys || [], entry.key);
    return readChain(entry, req, { wait: s.inDoubt, why: `${entry.lastReason} status=${s.status}` });
  }

  /** The answer for an outcome that is not "charged". */
  function refuseOutcome(res, entry, outcome) {
    if (res.headersSent || res.destroyed) return undefined;
    if (outcome === "unpaid") return refusePayment(res, "authorization_used_unpaid");
    if (outcome === "expired-unused") return refusePayment(res, "authorization_expired_unused");
    if (outcome === "no-intent") return refusePayment(res, "settlement_store_unavailable", { status: 503, retryable: true, retryAfter: 30 });
    // A refusal of OUR request (the signer, a lookup the facilitator could not make) is this server's to fix.
    if (outcome === "refused" && entry.lastSide === "ours") return refusePayment(res, "settlement_unavailable", { status: 503, retryable: true, retryAfter: 60 });
    if (outcome === "refused") return refusePayment(res, entry.lastReason || "settle_refused", { retryable: entry.lastRetryable, message: REFERRAL_REASONS[entry.lastReason] || REFERRAL_REASONS.settle_refused });
    if (entry.everInDoubt) return refusePayment(res, "settle_outcome_unknown", { retryable: true });
    return refusePayment(res, entry.lastReason || "settle_refused", { retryable: entry.lastRetryable, message: REFERRAL_REASONS[entry.lastReason] || REFERRAL_REASONS.settle_refused });
  }

  /** A re-send of a payment whose answer is kept: never a second run. */
  async function resend(req, res, entry) {
    counters.resent++;
    if (settling.has(entry.key)) { res.setHeader("X-Payment-Replay", "inflight"); res.setHeader("Retry-After", "5"); return res.status(409).json({ error: "This payment is being settled by another request. Send it again in a few seconds; nothing runs or is charged twice.", reason: "inflight" }); }
    if (entry.unpaid) return refusePayment(res, "authorization_used_unpaid");
    settling.add(entry.key);
    try {
      let outcome = entry.landed ? "charged" : await readChain(entry, req, { why: "re-send" });
      if (outcome === "expired-unused") {
        // Expired without being used: nothing was charged, and nothing can be.
        dropKept(entry.key);
        await book.resolve(entry.key, null).catch(() => {});
      } else if (outcome === "unused" && now() < entry.validBeforeMs - 2_000 && entry.settleAttempts <= REFERRAL_RESEND_SETTLES_MAX) {
        outcome = await settleEntry(entry, req);
      }
      if (outcome === "charged") return deliver(res, entry, { redelivery: true });
      return refuseOutcome(res, entry, outcome);
    } finally { settling.delete(entry.key); }
  }

  // Every step that can write an answer runs as a referral run, so no hint in
  // it names a route of this server (src/referral-run.js).
  const handler = (req, res) => runAsReferral(() => serve(req, res));

  async function serve(req, res) {
    res.set("X-Robots-Tag", "noindex, nofollow").set("Cache-Control", "no-store");
    const slug = referralSlugOfPath(req.path);
    const def = slug ? defs.get(slug) : null;
    // Only the canonical spelling is served: any other reaches no limiter
    // mounted on the path, so it gets no price and no run.
    if (!def || !isCanonicalReferralPath(req.path, slug)) return res.status(404).json({ error: "Not found" });
    // PAYMENT-SIGNATURE is the only payment evidence this route reads.
    delete req.headers["x-payment"];

    let input = null;
    try {
      input = handlerInputOf(req, def);
      // An EMPTY request (no body or `{}`, and no query) runs the tool's
      // published example: the standard buyer flow probes and pays with no
      // input, and the one paid call it makes has to show the product. The
      // unpaid 402 then quotes that example, and the paid call runs exactly
      // it. A request that carries any input at all is served as sent.
      const example = def.discovery?.input;
      if (input && typeof input === "object" && Object.keys(input).length === 0 && example && typeof example === "object" && !Array.isArray(example) && Object.keys(example).length > 0) {
        req.__handlerInput = structuredClone(example);
        input = handlerInputOf(req, def);
        req.__a402ReferralExample = true;
      }
      // A chat body is always answered as one JSON object here (the answer has
      // to carry the settlement's transaction), so streaming is turned off
      // BEFORE the request is priced: the quote and the run read one input.
      if (def.category === "llm" && input && typeof input === "object") {
        if ("stream" in input) input.stream = false;
        delete input.stream_options;
      }
    } catch { input = null; }
    const hasInput = !!input && typeof input === "object" && Object.keys(input).length > 0;
    if (warmQuote && input) { try { await warmQuote(def, req); } catch { /* priced in place */ } }

    const amount = amountFor(def, req);
    if (amount === null) return res.status(404).json({ error: "Not found" });
    const requirement = requirementFor(def, amount);

    const raw = headerText(req.headers["payment-signature"]);
    if (typeof raw !== "string" || !raw) {
      // A header that did not decode was removed at intake.
      if (req.__droppedPaymentAttempt === true) { counters.refused++; credentialLimiter?.note(req); return refusePayment(res, "invalid_request"); }
      // A body the direct route refuses before any payment is refused here
      // the same way; a probe with no input reads the example's price.
      if (hasInput) {
        let bad = null;
        try { bad = prePaymentRefusal(def, input); } catch { bad = null; }
        if (bad && Number(bad.status) >= 400) { counters.refused++; return res.status(Number(bad.status)).json(scrub(bad.body)); }
      }
      counters.challenges++;
      return res.status(402).json(challengeFor(def, req, requirement));
    }
    // A payment is taken on GET and POST only (a HEAD answer has no body to deliver).
    if (req.method !== "GET" && req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "A paid call is a GET or a POST. Nothing was charged.", tool: def.slug }); }
    if (credentialLimiter?.limited(req)) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({ error: "Too many refused payment credentials from this address; send a payment that verifies, or slow down. Nothing was charged.", retryAfterSeconds: 60 });
    }
    const refuseCredential = (reason) => { counters.refused++; credentialLimiter?.note(req); return refusePayment(res, reason); };

    const payment = decodePaymentHeader(raw);
    if (!payment) return refuseCredential("invalid_request");
    const checked = checkReferralPayment(payment, requirement, { nowMs: now(), needMs, maxValidityMs: config.maxValidityMs });
    if (checked.reason) return refuseCredential(checked.reason);
    const { auth, signature, validBeforeMs, timeReason } = checked;
    const payer = lc(auth.from);
    // The payer's own signature, checked here before any call leaves this
    // server: a forged one costs nothing outbound. A signature that is not an
    // ECDSA one by `from` (a contract wallet's) is not taken on this route.
    if (!(await isLocalReceiveSignature(auth, signature))) { counters.signatureRefused++; return refuseCredential("invalid_exact_evm_payload_signature"); }

    const key = referralReplayKey(auth);
    const digest = createHash("sha256").update(`${signature.toLowerCase()}\n${lc(auth.to)}\n${auth.value}\n${auth.validAfter}\n${auth.validBefore}`).digest("hex");
    // A payment whose answer is kept: the re-send path, never a second run.
    const held = kept.get(key);
    if (held) {
      if (held.digest !== digest || held.slug !== def.slug) { counters.replays++; res.setHeader("X-Payment-Replay", "consumed"); return res.status(409).json({ error: "Payment authorization already used. Each payment authorization (nonce) is single-use - sign a fresh authorization to make another paid call.", reason: "consumed" }); }
      return resend(req, res, held);
    }
    // An authorization the book still holds open with no answer here (the
    // process that ran it is gone, or its answer was dropped): it bought its
    // run, and it runs no second.
    const open = book.get(key);
    if (open && open.answer && open.answer.digest === digest && open.slug === def.slug && typeof open.answer.text === "string") {
      // The answer was stored with the open entry (this process restarted, or
      // dropped it from memory): restored, and served by the re-send path.
      const charged = open.state === "charged-undelivered" && typeof open.tx === "string" && open.tx ? open.tx : null;
      const restored = { key, digest, slug: def.slug, text: open.answer.text, wrap: open.answer.wrap === true, bytes: Buffer.byteLength(open.answer.text), amount: String(open.amount), requirement: open.answer.requirement, payment: open.answer.payment, auth, payer, validBeforeMs: (Number(open.validBefore) || 0) * 1000, laneKeys: laneKeysOf(req, payer), charged, landed: !!charged, unpaid: false, saleBooked: open.saleBooked === true, delivered: false, settleAttempts: Number(open.attempts) || 1, lastReason: open.reason || null, lastSide: null, lastRetryable: false, chainUnused: false, inDoubt: !charged, everInDoubt: true, at: now() };
      keep(restored);
      counters.restoredAnswers++;
      return resend(req, res, restored);
    }
    if (open) {
      counters.replays++;
      res.setHeader("X-Payment-Replay", "consumed");
      return res.status(409).json({ error: REFERRAL_REASONS.answer_unavailable, reason: "answer_unavailable" });
    }
    // The clock: valid now, for the whole run and its settlement, and not too far ahead.
    if (timeReason) return refuseCredential(timeReason);

    // The payer screen the direct route runs before serving.
    let screened = true;
    try { screened = await payerScreen(req, res); } catch { screened = true; }
    if (!screened) { counters.screened++; return undefined; }

    if (draining().active) return refusePayment(res, "draining", { status: 503, retryable: true, retryAfter: 60 });

    // The input, checked the way the direct route checks it before payment: a
    // request that cannot be served is a 4xx with nothing claimed.
    try {
      if (input === null) handlerInputOf(req, def);
      const bad = preValidate(def, req) || prePaymentRefusal(def, input);
      if (bad && Number(bad.status) >= 400) { counters.refused++; return res.status(Number(bad.status)).json(scrub(bad.body)); }
    } catch (err) {
      const status = Number(err?.statusCode);
      if (status >= 400 && status < 500) { counters.refused++; return res.status(status).json(scrub({ error: referralLogText(err?.message), tool: def.slug })); }
      // Anything else is left to the handler, as on the direct route.
    }

    // A bounded number of paid calls in flight: past it nothing runs.
    if (inflight >= config.maxInflight) { counters.busy++; return refusePayment(res, "busy", { status: 503, retryable: true, retryAfter: 5 }); }
    // Unsettled runs by this payer or address, with the runs they have in
    // flight right now: bounded at admission, before anything runs or is sent.
    const laneKeys = laneKeysOf(req, payer);
    if (!laneAdmit(laneKeys)) {
      counters.laneRefused++;
      res.setHeader("Retry-After", String(Math.ceil(config.unsettledWindowMs / 1000)));
      return res.status(429).json({ success: false, errorReason: "too_many_unsettled_runs", errorMessage: REFERRAL_REASONS.too_many_unsettled_runs, retryAfterSeconds: Math.ceil(config.unsettledWindowMs / 1000) });
    }
    inflight++;
    let claimed = false;
    const release = () => { if (!claimed) return; claimed = false; replayGuard.release(key).catch(() => {}); };
    // Spent for running purposes: held while the authorization stays valid.
    const hold = (settled) => { if (!claimed) return; claimed = false; replayGuard.settle(key, undefined, { validBeforeMs, settled }).catch(() => {}); };
    // Post-settlement hooks a handler left on the request (a share link is
    // written only for a settled call): each runs once with the outcome.
    const settledHooks = (ok) => { for (const fn of Array.isArray(req.__onSettled) ? req.__onSettled.splice(0) : []) { try { fn(ok); } catch { /* never break a response */ } } };
    let gone = false;
    let ticket = null;
    let settleSent = false;
    let holdsSlot = false;
    res.once("close", () => { if (!res.writableFinished) gone = true; });
    const clientGone = () => gone || res.destroyed === true || req.socket?.destroyed === true;

    try {
      // One authorization, one run.
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
      claimed = true;

      // The facilitator's own reading of the payment, always, before the handler.
      const v = await settler.verify(payment, requirement);
      if (!v.ok || (v.payer && v.payer !== payer)) {
        release(); // nothing ran
        // The facilitator refused OUR request (the signer, the registration):
        // not the buyer's credential, not the buyer's lane.
        if (!v.ok && v.side === "ours") {
          counters.signerRefused++;
          faultLog.line(`the facilitator refused THIS SERVER's request at /verify (${def.slug} reason=${v.reason} status=${v.status}): check REFERRAL_SIGNER_KEY and the signer's role; nothing ran, buyer answered 503`);
          return refusePayment(res, "settlement_unavailable", { status: 503, retryable: true, retryAfter: 60 });
        }
        counters.verifyRefused++;
        refusalLog.line(`verify refused ${def.slug} payer=${shortPayer(payer)} reason=${v.ok ? "payer_mismatch" : v.reason} status=${v.status}`);
        // No verdict on the payment (the facilitator did not answer): retry later.
        if (!v.ok && v.inDoubt) return refusePayment(res, "facilitator_unavailable", { status: 503, retryable: true, retryAfter: 30 });
        credentialLimiter?.note(req);
        return refusePayment(res, v.ok ? "invalid_payment" : (v.reason || "invalid_payment"), { retryable: v.retryable });
      }
      if (clientGone()) { release(); return undefined; }
      // The whole deadline must still fit before the settle reserve: a run is
      // never started on a shortened budget.
      const left = validBeforeMs - now() - config.settleReserveMs;
      if (left < config.deadlineMs) { release(); counters.refused++; return refusePayment(res, "invalid_exact_evm_payload_authorization_valid_before"); }

      // ---- the handler starts: from here the authorization is spent -------------
      counters.runs++;
      if (req.__a402ReferralExample === true) counters.exampleRuns++;
      const budget = config.deadlineMs;
      try { isolate(req); } catch { /* the lane mark is best effort */ }
      try { presentWindow(req, now() + budget); } catch { /* the handler keeps its own timeouts */ }
      ticket = reserveForgiveness(laneKeys, Number(amount));
      if (onRun) { try { onRun(req, res, def); } catch { /* bookkeeping only */ } }
      let result;
      try {
        if (input === null) input = handlerInputOf(req, def);
        result = await withLoopTimeout(
          Promise.resolve().then(() => withCeiling(Math.max(1, budget - 500), () => runAsCaller(req, () => def.handler(input, req)))),
          budget,
          () => Object.assign(new Error("The call did not finish in time, so it was not settled and nothing was charged. Sign a new authorization to make the call again."), { statusCode: 504, referralTimeout: true }),
        );
      } catch (err) {
        hold(false);
        settledHooks(false);
        const timedOut = err?.referralTimeout === true || Number(err?.statusCode) === 504;
        if (timedOut) { counters.timeouts++; laneNote(laneKeys, null); } else counters.handlerErrors++;
        // A provider refused the buyer's request and no other model took it: a 400, as on the direct route.
        if (err?.upstreamRejected === true && (err.statusCode || 502) === 502) err.statusCode = 400;
        if (!(Number(err?.statusCode) >= 400)) { try { err.statusCode = 500; } catch { /* a frozen error keeps the renderer's default */ } }
        if (!res.headersSent) {
          // The direct route's rendering, with no pointer to a direct route.
          const json = res.json.bind(res);
          res.json = (body) => json(scrub(body));
          sendToolError(res, err, def.slug);
        }
        return undefined;
      }

      // Only a JSON answer can carry the transaction: a stream or raw bytes is refused, uncharged.
      if (result && (result.__binary || typeof result.__sse === "function")) {
        hold(false);
        settledHooks(false);
        counters.handlerErrors++;
        return res.status(500).json({ error: "This tool's answer cannot be served on this route; nothing was charged.", tool: def.slug });
      }
      // The answer is serialized BEFORE the settlement, so a value that
      // cannot be sent is found while nothing has been charged.
      const answer = withIgnoredParams(result, req);
      const wrap = !answer || typeof answer !== "object" || Array.isArray(answer) || Object.hasOwn(answer, "transaction");
      let text;
      try { text = JSON.stringify(answer === undefined ? null : answer); if (typeof text !== "string") throw new Error("not JSON"); }
      catch { text = null; }
      const bytes = text === null ? 0 : Buffer.byteLength(text);
      if (text === null || bytes > REFERRAL_ANSWER_MAX_BYTES) {
        hold(false);
        settledHooks(false);
        counters.handlerErrors++;
        return res.status(500).json({ error: text === null ? "This tool's answer could not be serialized; nothing was charged." : "This tool's answer is too large for this route; nothing was charged.", tool: def.slug });
      }
      const entry = { key, digest, slug: def.slug, text, wrap, bytes, amount, requirement, payment, auth, payer, validBeforeMs, laneKeys, charged: null, landed: false, unpaid: false, saleBooked: false, delivered: false, settleAttempts: 0, lastReason: null, lastSide: null, lastRetryable: false, chainUnused: false, inDoubt: false, everInDoubt: false, at: now() };

      // The buyer left before settlement starts. With a forgiveness ticket the
      // payment is not settled (the direct routes' rule, on this route's own
      // budgets). Without one it is settled as for any other run, and the
      // answer is kept.
      if (clientGone() && ticket && ticket.granted) {
        hold(false);
        settledHooks(false);
        counters.forgivenHangups++;
        line("warn", `client gone before settlement (${def.slug} payer=${shortPayer(payer)}) - not settled, not charged, authorization held`);
        return undefined;
      }

      // From here the answer is kept against the authorization for its life,
      // and this request holds the authorization's one settle slot.
      hold(true);
      keep(entry);
      settling.add(key);
      holdsSlot = true;
      settleSent = true;
      const outcome = await settleEntry(entry, req);
      settledHooks(outcome === "charged");
      if (outcome === "charged") { deliver(res, entry); return undefined; }
      // A verdict on the payment after a served run counts in this route's own lane.
      if (outcome === "refused" && entry.lastSide === "buyer") laneNote(laneKeys, entry.key);
      if (!clientGone()) refuseOutcome(res, entry, outcome);
      return undefined;
    } catch (err) {
      // Nothing above is expected to throw. A claim still held here is given
      // back only if the handler never started (`hold` cleared it otherwise).
      release();
      line("error", `gate error (${def.slug}): ${referralLogText(err?.message)}`);
      if (!res.headersSent) { try { res.status(500).json({ error: "request failed", tool: def.slug }); } catch { /* socket already gone */ } }
      return undefined;
    } finally {
      inflight--;
      laneLeave(laneKeys);
      if (holdsSlot) settling.delete(key);
      // The ticket's end, as on the direct routes: abandoned (its price spent
      // from the forgiveness budgets) when the buyer left and no settlement
      // was sent; returned otherwise.
      finishForgiveness(ticket, clientGone() && !settleSent);
    }
  }

  /** The sweep's booking: a sale for an open book entry whose receipt proves the payment. */
  const bookFromSweep = async (e, transaction) => {
    const booked = bookSale({ key: e.key, slug: e.slug, amount: e.amount, payer: e.payer, tx: transaction });
    const entry = kept.get(e.key);
    if (entry && !entry.landed) { entry.charged = transaction; entry.landed = true; laneClear(entry.laneKeys || [], entry.key); }
    return booked;
  };
  // An intent is left to its own request for the settle timeout and the chain read after it.
  const sweepOnce = () => book.sweep({
    chain, bookSale: bookFromSweep, payTo: config.payTo, graceMs: config.settleMs + 15_000,
    onUnpaid: (e) => { counters.usedUnpaid++; laneNote([`payer:${String(e.payer).toLowerCase()}`], null); const entry = kept.get(e.key); if (entry) { entry.unpaid = true; entry.inDoubt = false; } },
  });

  return {
    handler, sweepOnce,
    stats: () => ({ ...counters, inflight, keptAnswers: kept.size, keptBytes, laneKeys: lane.size, forgivenUsd: forgive.abandoned.reduce((a, r) => a + r[1], 0) / MICRO, book: book.counts() }),
    slugs: () => [...defs.keys()],
  };
}
