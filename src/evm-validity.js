// Verify-time EVM validity floor: an authorization must outlive the run it pays for.
//
// Settlement runs AFTER the handler, and the facilitator re-verifies at settle
// time, refusing an EIP-3009 authorization (or a Permit2 deadline) within six
// seconds of its expiry. A paid run is therefore started only when the
// buyer's authorization will still be valid when the work ends. On the routes
// whose measured run is long this is checked here, BEFORE the handler; an
// authorization that will not last is refused with a 422: nothing runs,
// nothing is charged, and the message says how much validity the route needs.
// Same model as the Algorand guard (src/avm-validity.js), for the EVM rails.
//
// WHICH ROUTES, AND HOW MUCH. Only routes whose run is long enough that a short
// credential predictably cannot settle get an entry, sized from measured run
// times (tool_call latency of settled calls, 60 days to 2026-09-28):
//   - the report composites finished in 38 to 139 s, and the storefront says
//     one to three minutes: 180 s;
//   - v1-videos polls its job for up to its wait cap and downloads the clip
//     after it, so its floor is the cap (240 s, which the slack cap below
//     holds to what a stock client carries); image-gen-premium 35 to 46 s
//     under a 75 s upstream cap since it renders the larger frame (75 s).
// Every other route has no floor. Short windows are an honest pattern there -
// this server's own router signs 30 s authorizations - and a fast handler
// settles well inside them. A handler that pays an outside seller before the
// buyer settles (route-execute's external leg, seller-payability) pays only
// while the buyer's authorization keeps EVM_SELLER_ALLOWANCE_MS of settleable
// life, and bounds its waits (and seller-payability its paid leg) by
// evmCredentialBudgetMs, so a short window gets a shorter run rather than a
// refusal, and a window too short to settle pays nobody.
//
// NEVER ABOVE WHAT A STOCK CLIENT CARRIES. The stock x402 EVM client signs
// validBefore = now + maxTimeoutSeconds (300 s on every route here) at the
// moment it pays, and a native MPP evm client signs the challenge's expiry,
// minted at the same 300 s. The floor is therefore capped at maxTimeoutSeconds
// minus CLIENT_SLACK_SECONDS (60), so a stock client, and an MPP client that
// pays within a minute of its 402, always passes whatever a route's run time.
// A client that signs a shorter window of its own choosing, or an MPP client
// that pays later than that, is below the floor on these routes.
//
// MODES. EVM_VALIDITY_FLOOR unset or =log records what would have been refused
// and refuses nothing, so the floors can be sized from logged arrivals before
// any buyer meets them; =enforce refuses with the 422; =off disables the check.

import { paymentHeaderOf } from "./payer.js";
import { EXPENSIVE_COMPOSITE_SLUGS } from "./composite-spend-guard.js";

/** The reference facilitator refuses at verify AND at settle once validBefore < now + 6 s. */
export const SETTLE_RULE_SECONDS = 6;
/** The floor never exceeds maxTimeoutSeconds minus this, so honest clients always pass. */
export const CLIENT_SLACK_SECONDS = 60;
/** @x402/core's default, and the value every route here advertises. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 300;

const MEDIA_SLUGS = new Set(["v1-images-fast", "v1-images-pro", "v1-videos"]);
/** Measured run time (seconds) a route needs before its settlement can happen. */
export const EVM_RUN_SECONDS = Object.freeze({
  ...Object.fromEntries([...EXPENSIVE_COMPOSITE_SLUGS].filter((s) => !MEDIA_SLUGS.has(s)).map((s) => [s, 180])),
  "v1-videos": 240,
  "image-gen-premium": 75,
});

/** The sentence a slow route's description carries (server.js appends it). */
export function runTimeNote(seconds) {
  const s = Number(seconds);
  const span = s >= 120 && s % 60 === 0 ? `${s / 60} minutes` : `${s} seconds`;
  return `Takes up to ${span} to answer: keep the connection open for at least ${s + 30} seconds, because a client that disconnects first loses the answer, or send the paid call with "Prefer: respond-async" to get a job link at once and collect the answer from it (payment still settles only on a delivered result).`;
}

const UINT = /^\d{1,20}$/;

/**
 * The expiry the buyer signed, from an x402 payment header value: an EIP-3009
 * authorization's validBefore, or a Permit2 authorization's deadline (the
 * `upto` scheme and exact-over-Permit2). Returns
 * { expiresAt (unix seconds), form, maxTimeoutSeconds|null } or null when the
 * header is not an EVM authorization or will not parse. Read only after the
 * paywall verified the signature that covers these fields.
 */
export function evmCredentialExpiry(headerValue) {
  if (typeof headerValue !== "string" || !headerValue) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8")); } catch { return null; }
  if (!payload || typeof payload !== "object") return null;
  const network = String(payload?.accepted?.network || payload?.network || "");
  if (network.startsWith("solana:") || network.startsWith("stellar:") || network.startsWith("algorand:")) return null;
  const inner = payload?.payload;
  if (!inner || typeof inner !== "object") return null;
  let raw = null, form = null;
  if (inner.authorization && typeof inner.authorization === "object") { raw = inner.authorization.validBefore; form = "eip3009"; }
  else if (inner.permit2Authorization && typeof inner.permit2Authorization === "object") { raw = inner.permit2Authorization.deadline; form = "permit2"; }
  if (form === null || !UINT.test(String(raw ?? ""))) return null;
  const expiresAt = Number(raw);
  if (!Number.isSafeInteger(expiresAt)) return null;
  const mts = Number(payload?.accepted?.maxTimeoutSeconds);
  return { expiresAt, form, maxTimeoutSeconds: Number.isFinite(mts) && mts > 0 ? mts : null };
}

/** Seconds of validity a payment for `slug` must still carry when it arrives,
 *  or 0 when the route has no floor. */
export function requiredEvmSecondsFor(slug, maxTimeoutSeconds = DEFAULT_MAX_TIMEOUT_SECONDS) {
  const run = Object.hasOwn(EVM_RUN_SECONDS, slug) ? EVM_RUN_SECONDS[slug] : 0;
  if (!(run > 0)) return 0;
  const cap = (Number(maxTimeoutSeconds) > 0 ? Number(maxTimeoutSeconds) : DEFAULT_MAX_TIMEOUT_SECONDS) - CLIENT_SLACK_SECONDS;
  const required = Math.min(run + SETTLE_RULE_SECONDS, cap);
  // Nothing to demand beyond what the facilitator already demands.
  return required > SETTLE_RULE_SECONDS ? required : 0;
}

export function evmValidityMode() {
  const v = String(process.env.EVM_VALIDITY_FLOOR || "").trim().toLowerCase();
  return v === "off" ? "off" : v === "enforce" ? "enforce" : "log";
}

/**
 * Pure decision: returns null when the payment may run, else the refusal
 * { remaining, required, message }. Exported for offline tests.
 */
export function evmValidityShortfall(headerValue, slug, { nowMs = Date.now() } = {}) {
  const exp = evmCredentialExpiry(headerValue);
  if (!exp) return null;
  const required = requiredEvmSecondsFor(slug, exp.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS);
  if (!required) return null;
  const remaining = exp.expiresAt - nowMs / 1000;
  if (remaining >= required) return null;
  const field = exp.form === "permit2" ? "deadline" : "validBefore";
  return {
    remaining, required,
    message: `Payment authorization expires too soon for this route: about ${Math.max(0, Math.floor(remaining))} s remain before its ${field}, and ${slug} settles only after its work is done, which needs about ${required} s. It would expire before it could settle. You have not been charged. Request a fresh 402 and pay it at once, or sign with ${field} at least ${required} s ahead.`,
  };
}

/** Seconds allowed, after a handler's work ends, for the response to reach the
 *  paywall and the facilitator's settle-time verify, on top of its own 6 s. */
export const SETTLE_MARGIN_SECONDS = 4;

/**
 * Milliseconds until this request's EVM authorization meets the facilitator's
 * settle-time rule (validBefore less 6 s), after which it can no longer
 * settle; null when the request carries no EVM authorization. May be zero or
 * negative.
 */
export function evmCredentialSettleableMs(req, { nowMs = Date.now() } = {}) {
  const exp = evmCredentialExpiry(paymentHeaderOf(req));
  if (!exp) return null;
  return exp.expiresAt * 1000 - nowMs - SETTLE_RULE_SECONDS * 1000;
}

/** A handler that buys from an outside seller for a buyer's request SIGNS only while
 *  the buyer's authorization keeps at least this much settleable life: the
 *  settle margin (SETTLE_MARGIN_SECONDS) plus a few seconds for the seller to
 *  answer. Checked before resolution AND again at the moment of signing
 *  (evmSellerSignBy), so time spent reading the seller's bare 402 cannot push
 *  a signature past it. */
export const EVM_SELLER_ALLOWANCE_MS = 8000;

/** The epoch ms after which a seller payment made for this request must not be
 *  signed (null when the request carries no EVM authorization). */
export function evmSellerSignBy(req, { nowMs = Date.now() } = {}) {
  const ms = evmCredentialSettleableMs(req, { nowMs });
  return ms == null ? null : nowMs + ms - EVM_SELLER_ALLOWANCE_MS;
}

/**
 * Milliseconds of this request's EVM authorization left for work that must end
 * before its settlement can happen (validBefore, less the facilitator's rule
 * and the settle margin), or null when the request carries no EVM
 * authorization. May be zero or negative. A handler that spends before the
 * buyer settles bounds its own deadlines by it.
 */
export function evmCredentialBudgetMs(req, { nowMs = Date.now() } = {}) {
  const ms = evmCredentialSettleableMs(req, { nowMs });
  return ms == null ? null : ms - SETTLE_MARGIN_SECONDS * 1000;
}

/** Express-side entry, called by the dispatcher before the handler. Throws a
 *  422 (nothing runs, nothing is charged) only when the mode is enforce. */
export function assertEvmValidityCovers(req, slug, { nowMs = Date.now() } = {}) {
  const mode = evmValidityMode();
  if (mode === "off") return;
  const short = evmValidityShortfall(paymentHeaderOf(req), slug, { nowMs });
  if (!short) return;
  if (mode === "log") {
    console.warn(`[evm-validity] would refuse ${slug}: ${Math.max(0, Math.floor(short.remaining))} s of validity left, ${short.required} s needed (EVM_VALIDITY_FLOOR is log; enforce refuses)`);
    return;
  }
  throw Object.assign(new Error(short.message), { statusCode: 422 });
}
