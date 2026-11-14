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
//     hang-up forgiveness ticket (the direct routes' own budgets,
//     src/hangup-forgiveness.js). Without a ticket the payment is settled and
//     the answer is kept for the buyer's re-send.
//   - Before /settle is called, the intent is written to a durable book
//     (src/referral-book.js). An answer that does not say whether the payment
//     moved is settled by the chain (src/referral-chain.js), not by a guess.
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
 * @param {{reserve, forgiven, finish}} [o.hangup]     the direct routes' hang-up forgiveness
 * @param {(req) => void} [o.isolate]          keep this run out of the direct routes' money guards
 * @param {(req, endsAtMs) => void} [o.presentWindow]  present the run's deadline as its payment window
 * @param {(ms, fn) => any} [o.withCeiling]    run fn with handler budgets capped at ms
 * @param {{limited, note}} [o.credentialLimiter]  the refused-credential limiter
 * @param {() => ({active: boolean, leftMs: number})} [o.draining]
 * @param {(tx) => boolean} [o.saleBooked]     whether a sale stands for this transaction
 * @param {(req) => void} [o.onSettledSale]    a settled sale by this client (paid-client allowance)
 * @param {Map<string,string>} [o.directPaths] direct route path -> its /ref path, for answers
 */
export function createReferralGate({
  config, defs, settler, chain, book, replayGuard, baseUrl, priceUsdOf, priceForNetwork,
  preValidate = () => null, prePaymentRefusal = () => null, warmQuote = null, runAsCaller = (_req, fn) => fn(),
  sendToolError, recordSale, saleBooked = () => false, isSynthetic = () => false, salePathOf = () => null, requireShared = () => false, onRun = null,
  payerScreen = async () => true, hangup = null, isolate = () => {}, presentWindow = () => {}, withCeiling = (_ms, fn) => fn(),
  credentialLimiter = null, clientKey = (req) => String(req.ip || ""), draining = () => ({ active: false, leftMs: Infinity }), onSettledSale = () => {},
  directPaths = new Map(), log = console, now = Date.now,
} = {}) {
  if (!config || !(defs instanceof Map) || !settler || !chain || !book || !replayGuard) throw new Error("referral gate: config, defs, settler, chain, book and replayGuard are required");
  if (typeof priceUsdOf !== "function" || typeof priceForNetwork !== "function" || typeof sendToolError !== "function" || typeof recordSale !== "function") throw new Error("referral gate: priceUsdOf, priceForNetwork, sendToolError and recordSale are required");
  const origin = String(baseUrl || "").replace(/\/+$/, "");
  const counters = {
    challenges: 0, refused: 0, signatureRefused: 0, replays: 0, verifyRefused: 0, screened: 0, laneRefused: 0, busy: 0,
    runs: 0, handlerErrors: 0, timeouts: 0, forgivenHangups: 0, settleRefused: 0, settleInDoubt: 0, landedAfterDoubt: 0,
    settled: 0, resent: 0, redelivered: 0, chargedNotServed: 0,
  };
  const line = (level, text) => { try { (log[level] || log.log).call(log, `[referral] ${text}`); } catch { /* a log never breaks a call */ } };
  const refusalLog = createLineSampler({ now, print: (text) => line("warn", text) });
  const shortPayer = (from) => `${String(from).slice(0, 6)}`;
  const needMs = config.deadlineMs + config.settleReserveMs + config.verifyMs;

  // ---- the unsettled-run lane (per signed payer, per client address) --------------
  const lane = new Map(); // key -> timestamps
  const LANE_MAX_KEYS = 20_000;
  const laneCount = (key, t) => {
    const list = lane.get(key);
    if (!list) return 0;
    while (list.length && t - list[0] >= config.unsettledWindowMs) list.shift();
    if (!list.length) lane.delete(key);
    return list.length;
  };
  const laneKeys = (req, payer) => [`payer:${payer}`, `addr:${clientKey(req)}`];
  const laneNote = (req, payer) => {
    const t = now();
    for (const key of laneKeys(req, payer)) {
      if (!lane.has(key) && lane.size >= LANE_MAX_KEYS) lane.delete(lane.keys().next().value);
      const list = lane.get(key) || [];
      list.push(t);
      lane.set(key, list);
    }
  };
  const laneBlocked = (req, payer) => { const t = now(); return laneKeys(req, payer).some((key) => laneCount(key, t) >= config.unsettledMax); };

  // ---- answers kept for a re-send, by replay key ------------------------------------
  const kept = new Map(); // key -> entry (insertion order = age)
  let keptBytes = 0;
  const resending = new Set();
  let inflight = 0;
  const dropKept = (key) => { const e = kept.get(key); if (e) { keptBytes -= e.bytes; kept.delete(key); } };
  const pruneKept = () => {
    const t = now();
    for (const [key, e] of kept) { if (t > e.validBeforeMs + 10 * 60_000) dropKept(key); else break; }
  };
  const keep = (entry) => {
    pruneKept();
    if (entry.bytes > REFERRAL_ANSWER_MAX_BYTES) return false;
    dropKept(entry.key);
    while (kept.size >= REFERRAL_KEPT_ANSWERS_MAX || keptBytes + entry.bytes > REFERRAL_KEPT_BYTES_MAX) {
      const oldest = kept.keys().next().value;
      if (oldest === undefined) break;
      line("warn", `kept answers are full; dropping the oldest (${kept.get(oldest)?.slug})`);
      dropKept(oldest);
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

  // No answer of this route points at a direct route: a path of a served
  // tool's direct route is written as its /ref path, and the ready-to-run
  // call (built for the direct route) is dropped.
  const pathPairs = [...directPaths].sort((a, b) => b[0].length - a[0].length);
  function scrub(body) {
    if (!body || typeof body !== "object") return body;
    let copy = body;
    if (Object.hasOwn(body, "howToCall")) { copy = { ...body }; delete copy.howToCall; }
    if (!pathPairs.length) return copy;
    let text;
    try { text = JSON.stringify(copy); } catch { return copy; }
    let changed = false;
    for (const [direct, ref] of pathPairs) {
      if (text.includes(direct)) { text = text.split(direct).join(ref); changed = true; }
    }
    if (!changed) return copy;
    try { return JSON.parse(text); } catch { return copy; }
  }

  const refusePayment = (res, reason, { status = 402, retryable = false, retryAfter = null, message = null } = {}) => {
    if (retryAfter) res.setHeader("Retry-After", String(retryAfter));
    const text = message || REFERRAL_REASONS[reason] || (status === 402 ? "The payment was not accepted. Nothing was charged." : null);
    return res.status(status).json({ success: false, errorReason: reason, ...(text ? { errorMessage: text } : {}), ...(retryable ? { retryable: true } : {}) });
  };

  /** Book the sale for a settled authorization, once. */
  function bookSale({ key, slug, amount, payer, tx, sha = null, req = null }) {
    const entry = kept.get(key);
    if (entry?.saleBooked) return true;
    if (book.get(key)?.saleBooked === true) { if (entry) entry.saleBooked = true; return true; }
    try { if (tx && saleBooked(tx)) { if (entry) entry.saleBooked = true; return true; } } catch { /* booked below */ }
    const commissionBps = commissionBpsFor(config, slug);
    if (commissionBps === null) { line("error", `sale NOT booked: no commission is configured for ${slug} (tx=${tx || "not found"})`); return false; }
    const money = referralNet(amount, { commissionBps, feeBps: config.feeBps });
    try {
      recordSale({
        slug, priceUsd: money.netUsd, quoteUsd: money.grossUsd, rail: "referral", wire: "referral", network: "base",
        payer, tx: tx || null, synthetic: req ? !!isSynthetic(req) : false, responseSha256: sha, via: req ? salePathOf(req) : null,
      });
    } catch { return false; }
    if (entry) entry.saleBooked = true;
    return true;
  }

  /** The 200: the tool's answer with the settle transaction at the top level. */
  function bodyText(entry) {
    const tx = entry.charged ? JSON.stringify(entry.charged) : "null";
    // The payment landed on chain and its transaction could not be found: said in a field.
    const tail = entry.charged ? `"transaction":${tx}` : `"transaction":null,"settlement":"charged-transaction-not-found"`;
    if (entry.wrap) return `{"result":${entry.text},${tail}}`;
    return entry.text === "{}" ? `{${tail}}` : `${entry.text.slice(0, -1)},${tail}}`;
  }
  function deliver(res, entry, { redelivery = false } = {}) {
    const text = bodyText(entry);
    const notServed = (why) => { counters.chargedNotServed++; line("error", `CHARGED-BUT-NOT-SERVED: ${why} (${entry.slug} payer=${shortPayer(entry.payer)} tx=${entry.charged || "not found"}); the answer is kept for a re-send of the same payment`); book.resolve(entry.key, { state: "charged-undelivered", tx: entry.charged || null, saleBooked: entry.saleBooked === true, landedAt: now() }).catch(() => {}); };
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

  /**
   * Ask the facilitator to settle a kept answer's payment and read the
   * outcome to its end. Returns "charged" (entry.charged holds the
   * transaction, or null when the chain says it landed and the log was not
   * found), "refused" (definite; entry.lastReason, entry.lastSide) or
   * "unknown". The intent is in the book before the call leaves.
   */
  async function settleEntry(entry, req) {
    entry.settleAttempts++;
    await book.intent({ key: entry.key, slug: entry.slug, payer: entry.payer, nonce: entry.auth.nonce, amount: entry.amount, validBefore: Math.floor(entry.validBeforeMs / 1000) }).catch(() => false);
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
      entry.charged = s.transaction;
      entry.landed = true;
      bookSale({ key: entry.key, slug: entry.slug, amount: entry.amount, payer: entry.payer, tx: s.transaction, sha: createHash("sha256").update(bodyText(entry), "utf8").digest("hex"), req });
      await book.resolve(entry.key, { state: "charged-undelivered", tx: s.transaction, saleBooked: entry.saleBooked === true, landedAt: now() }).catch(() => {});
      counters.settled++;
      try { if (req) onSettledSale(req); } catch { /* a convenience, never a reason to fail */ }
      line("log", `settled ${entry.slug} payer=${shortPayer(entry.payer)} tx=${s.transaction}`);
      return "charged";
    }
    entry.lastReason = s.reason || "settle_failed";
    entry.lastSide = s.side || null;
    entry.lastRetryable = s.retryable === true;
    if (!s.inDoubt) {
      // A definite refusal: nothing moved. Nothing is left open in the book.
      entry.inDoubt = false;
      await book.resolve(entry.key, null).catch(() => {});
      counters.settleRefused++;
      line("warn", `settle refused after a successful handler (${entry.slug} payer=${shortPayer(entry.payer)} reason=${entry.lastReason} status=${s.status}) - not charged, authorization held`);
      return "refused";
    }
    // In doubt: the chain says whether the authorization was used.
    counters.settleInDoubt++;
    entry.inDoubt = true;
    return readChain(entry, req, { wait: true, why: `${entry.lastReason} status=${s.status}` });
  }

  /** Read the chain for a kept answer whose payment may have moved. */
  async function readChain(entry, req, { wait = false, why = "re-send" } = {}) {
    let c;
    try { c = await chain.state({ from: entry.payer, nonce: entry.auth.nonce }, { wait }); } catch { c = { used: null, transaction: null }; }
    if (c.used === true) {
      entry.charged = c.transaction || null;
      entry.landed = true;
      bookSale({ key: entry.key, slug: entry.slug, amount: entry.amount, payer: entry.payer, tx: c.transaction || null, req });
      await book.resolve(entry.key, { state: "charged-undelivered", tx: c.transaction || null, saleBooked: entry.saleBooked === true, landedAt: now() }).catch(() => {});
      counters.landedAfterDoubt++;
      try { if (req) onSettledSale(req); } catch { /* a convenience */ }
      line("error", `SETTLE-IN-DOUBT resolved by the chain: the payment landed (${entry.slug} payer=${shortPayer(entry.payer)} tx=${c.transaction || "not found"}; ${why})`);
      return "charged";
    }
    entry.chainUnused = c.used === false;
    // Only a settle that left the outcome open is in doubt; a refused one whose
    // re-send reads the chain is simply still unpaid.
    if (entry.inDoubt) {
      await book.resolve(entry.key, { state: "in-doubt", reason: entry.lastReason || null }).catch(() => {});
      line("error", `SETTLE-IN-DOUBT (${entry.slug} payer=${shortPayer(entry.payer)} ${why}; chain reads ${c.used === false ? "unused so far" : "unreadable"}) - answer kept, authorization held, buyer answered 402`);
    }
    return "unknown";
  }

  /** A re-send of a payment whose answer is kept: never a second run. */
  async function resend(req, res, entry) {
    counters.resent++;
    if (resending.has(entry.key)) { res.setHeader("X-Payment-Replay", "inflight"); return res.status(409).json({ error: "This payment is being settled by another request. Retry in a few seconds.", reason: "inflight" }); }
    resending.add(entry.key);
    try {
      let outcome = entry.landed ? "charged" : await readChain(entry, req, { why: "re-send" });
      if (outcome !== "charged") {
        const t = now();
        if (entry.chainUnused && t > entry.validBeforeMs + 30_000) {
          // Expired without being used: nothing was charged, and nothing can be.
          dropKept(entry.key);
          await book.resolve(entry.key, null).catch(() => {});
          return refusePayment(res, "authorization_expired_unused");
        }
        if (entry.chainUnused && t < entry.validBeforeMs - 2_000 && entry.settleAttempts <= REFERRAL_RESEND_SETTLES_MAX) {
          outcome = await settleEntry(entry, req);
        }
      }
      if (outcome === "charged") return deliver(res, entry, { redelivery: true });
      if (outcome === "refused" || !entry.inDoubt) return refusePayment(res, entry.lastReason || "settle_refused", { retryable: entry.lastRetryable, message: REFERRAL_REASONS[entry.lastReason] || REFERRAL_REASONS.settle_refused });
      return refusePayment(res, "settle_outcome_unknown", { retryable: true });
    } finally { resending.delete(entry.key); }
  }

  async function handler(req, res) {
    res.set("X-Robots-Tag", "noindex, nofollow").set("Cache-Control", "no-store");
    const slug = referralSlugOfPath(req.path);
    const def = slug ? defs.get(slug) : null;
    // Only the canonical spelling is served: any other reaches no limiter
    // mounted on the path, so it gets no price and no run.
    if (!def || !isCanonicalReferralPath(req.path, slug)) return res.status(404).json({ error: "Not found" });
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
      // the same way; a bare probe (no input at all) still reads the price.
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
    // process that ran it is gone): it bought its run, and it runs no second.
    const open = book.get(key);
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

    // Unsettled runs by this payer or address, bounded before anything runs.
    if (laneBlocked(req, payer)) {
      counters.laneRefused++;
      res.setHeader("Retry-After", String(Math.ceil(config.unsettledWindowMs / 1000)));
      return res.status(429).json({ success: false, errorReason: "too_many_unsettled_runs", errorMessage: REFERRAL_REASONS.too_many_unsettled_runs, retryAfterSeconds: Math.ceil(config.unsettledWindowMs / 1000) });
    }
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
    inflight++;
    let claimed = false;
    const release = () => { if (!claimed) return; claimed = false; replayGuard.release(key).catch(() => {}); };
    // Spent for running purposes: held while the authorization stays valid.
    const hold = (settled) => { if (!claimed) return; claimed = false; replayGuard.settle(key, undefined, { validBeforeMs, settled }).catch(() => {}); };
    // Post-settlement hooks a handler left on the request (a share link is
    // written only for a settled call): each runs once with the outcome.
    const settledHooks = (ok) => { for (const fn of Array.isArray(req.__onSettled) ? req.__onSettled.splice(0) : []) { try { fn(ok); } catch { /* never break a response */ } } };
    let gone = false;
    let ticket = false;
    let settleSent = false;
    res.once("close", () => { if (!res.writableFinished) gone = true; });
    const clientGone = () => gone || res.destroyed === true || req.socket?.destroyed === true;
    const finishTicket = (abandoned) => { if (!ticket) return; ticket = false; try { hangup.finish(req, abandoned); } catch { /* the budget is bookkeeping */ } };

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
      const budget = config.deadlineMs;
      try { isolate(req); } catch { /* the lane mark is best effort */ }
      try { presentWindow(req, now() + budget); } catch { /* the handler keeps its own timeouts */ }
      if (hangup) { try { await hangup.reserve(req, { priceUsd: Number(amount) / 1e6, slug: def.slug }); ticket = true; } catch { ticket = false; } }
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
        if (timedOut) { counters.timeouts++; laneNote(req, payer); } else counters.handlerErrors++;
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
      const entry = { key, digest, slug: def.slug, text, wrap, bytes, amount, requirement, payment, auth, payer, validBeforeMs, charged: null, landed: false, saleBooked: false, delivered: false, settleAttempts: 0, lastReason: null, lastSide: null, lastRetryable: false, chainUnused: false, inDoubt: false, at: now() };

      // The buyer left before settlement starts. With a forgiveness ticket the
      // payment is not settled (the direct routes' rule and budgets). Without
      // one it is settled as for any other run, and the answer is kept.
      if (clientGone()) {
        let forgiven = false;
        try { forgiven = !!hangup && hangup.forgiven(req) === true; } catch { forgiven = false; }
        if (forgiven || !hangup) {
          hold(false);
          settledHooks(false);
          counters.forgivenHangups++;
          line("warn", `client gone before settlement (${def.slug} payer=${shortPayer(payer)}) - not settled, not charged, authorization held`);
          return undefined;
        }
      }

      // From here the answer is kept against the authorization for its life.
      hold(true);
      keep(entry);
      settleSent = true;
      const outcome = await settleEntry(entry, req);
      settledHooks(outcome === "charged");
      if (outcome === "charged") { deliver(res, entry); return undefined; }
      if (outcome === "refused") {
        // A verdict on the payment after a served run counts in this route's own lane.
        if (entry.lastSide === "buyer") laneNote(req, payer);
        if (!res.headersSent && !clientGone()) refusePayment(res, entry.lastReason || "settle_refused", { retryable: entry.lastRetryable, message: REFERRAL_REASONS[entry.lastReason] || REFERRAL_REASONS.settle_refused });
        return undefined;
      }
      if (!res.headersSent && !clientGone()) refusePayment(res, "settle_outcome_unknown", { retryable: true });
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
      // The ticket's end, as on the direct routes: abandoned (its price spent
      // from the forgiveness budgets) when the buyer left and no settlement
      // was sent; returned otherwise.
      finishTicket(clientGone() && !settleSent);
    }
  }

  /** The sweep's booking: a sale for an open book entry the chain says landed. */
  const bookFromSweep = async (e, transaction) => bookSale({ key: e.key, slug: e.slug, amount: e.amount, payer: e.payer, tx: transaction || null });
  // An intent is left to its own request for the settle timeout and the chain read after it.
  const sweepOnce = () => book.sweep({ chain, bookSale: bookFromSweep, graceMs: config.settleMs + 15_000 });

  return {
    handler, sweepOnce,
    stats: () => ({ ...counters, inflight, keptAnswers: kept.size, keptBytes, laneKeys: lane.size, book: book.counts() }),
    slugs: () => [...defs.keys()],
  };
}
