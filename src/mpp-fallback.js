import { createHash } from "node:crypto";
import { mppOffersWithheldFor, mppOfferGateStatus } from "./mpp-offer-gate.js";
// "Stop offering this client an MPP challenge so it falls through to x402."
//
// Companion to src/mpp-evm-domain.js. Once a client has PROVEN (by a signature
// that recovers to its own payload `from`) that it signs EIP-3009 under the
// wrong token domain name, its MPP evm path cannot work here - but its x402
// path demonstrably can (measured on the AgentCore instrument, Base tx
// 0x9b48b7fe...). The remedy is to withhold the `WWW-Authenticate: Payment`
// challenges from that client for a short while: a manager that prefers MPP
// then has nothing to select, and falls back to the x402 offer already sitting
// in the same 402's PAYMENT-REQUIRED header.
//
// WHY IT IS STICKY AT ALL. Suppressing only on the response to the failing
// credential is not enough: an agent that retries the tool call starts a FRESH
// request that carries no credential, sees the challenge again, and loops. So a
// client is remembered briefly, keyed by remote address + User-Agent - the only
// identity a bare unpaid request has.
//
// WHY THAT KEY IS DANGEROUS, AND WHAT BOUNDS IT. The flag cannot be planted on
// a victim (setting it needs a signature that recovers to the sender's own
// `from`), but the key itself is not exclusive: anyone can self-sign a
// wrong-domain credential with a throwaway wallet while choosing their own
// User-Agent, and co-locating behind a shared egress IP (cloud NAT, corporate
// proxy, an agent host) is ordinary. A collateral hit is therefore possible,
// and for one buyer it is worse than a downgrade: this predicate also gates the
// TEMPO challenge, and a wallet funded only in USDC.e/PathUSD has no x402 offer
// it can pay, so a blanket suppression would be a total payment denial for a
// client we have no evidence about. The suppression is bounded so that can
// never be more than a blip:
//
//   - a request that CARRIES a Payment credential is never suppressed. Such a
//     client is mid-flow on some method and needs a fresh challenge to retry;
//     only bare requests, plus the wrong-domain rejection itself, are steered.
//   - stickiness requires a non-empty User-Agent. An empty UA is the widest
//     possible net (Node's fetch sends none), so it gets the immediate response
//     only and is never remembered.
//   - it lapses after MAX_SUPPRESSED responses as well as after the TTL. A
//     manager that is going to fall back does so on its next attempt, so a
//     handful is generous for the client we mean and a blip for anyone else.
//
// Bounded map, single process; MPP_EVM_DOMAIN_FALLBACK=off disables it all.
const TTL_MS = Number(process.env.MPP_EVM_DOMAIN_FALLBACK_TTL_MS || 30 * 60 * 1000);
const MAX_SUPPRESSED = Number(process.env.MPP_EVM_DOMAIN_FALLBACK_MAX_RESPONSES || 5);
const MAX_ENTRIES = 500;

/** key -> { expiresAt, remaining } */
const flagged = new Map();

// Observability, added 2026-09-14 after a hold that did not engage could not be
// traced: a proven wrong-domain signer was flagged, its very next bare request
// still carried the MPP challenge, and every later repeat was withheld as
// designed. Nothing here logged, so the miss stayed unexplained. Every line
// below is COUNTS AND REASONS ONLY: the fingerprint is never written, only a
// short digest of it (`clientTag`) so a flag line and the decision lines that
// follow it can be correlated in the log without revealing the address or the
// User-Agent. Bare requests from clients that were never flagged log nothing,
// so this cannot become a per-request firehose.
let logger = (line) => console.log(line);
/** Test seam only. */
export function _setMppFallbackLogger(fn) { logger = typeof fn === "function" ? fn : (line) => console.log(line); }
function clientTag(key) {
  return key ? createHash("sha256").update(key).digest("hex").slice(0, 8) : "-";
}
function logLine(event, fields) {
  try {
    const kv = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ");
    logger(`[mpp-fallback] ${event} ${kv}`);
  } catch { /* logging never affects the decision */ }
}

/** Call-time read, like every other rollout knob here. */
export function evmDomainFallbackEnabled() {
  return String(process.env.MPP_EVM_DOMAIN_FALLBACK || "").trim().toLowerCase() !== "off";
}

/** Remote address + User-Agent. Never logged, never surfaced - it is only ever
 *  compared against itself. Null when there is no User-Agent to narrow it with:
 *  address alone is too broad a thing to withhold a payment method from. */
export function clientFingerprint(req) {
  const ua = String(req?.headers?.["user-agent"] || "").trim().slice(0, 80);
  if (!ua) return null;
  const ip = String(req?.ip || req?.socket?.remoteAddress || "").slice(0, 64);
  if (!ip) return null;
  return `${ip}|${ua}`;
}

/** Is this request presenting a payment credential of any method? */
function carriesCredential(req) {
  const auth = req?.headers?.authorization;
  return typeof auth === "string" && /^payment\s/i.test(auth);
}

function prune(now) {
  for (const [k, v] of flagged) if (v.expiresAt <= now) flagged.delete(k);
  // Bound the map even under a pathological spread of fingerprints: oldest
  // insertion order first (Map preserves it), never unbounded growth.
  while (flagged.size > MAX_ENTRIES) flagged.delete(flagged.keys().next().value);
}

/** Record that this client signs under the wrong token domain, and suppress
 *  challenges on THIS response too. */
export function noteWrongDomainSigner(req) {
  if (req) req.mppSuppressChallenges = true;
  if (!evmDomainFallbackEnabled()) return;
  const key = clientFingerprint(req);
  if (!key) { logLine("flagged", { client: "-", remembered: false, reason: "no-user-agent" }); return; } // this response only, nothing remembered
  const now = Date.now();
  flagged.set(key, { expiresAt: now + TTL_MS, remaining: MAX_SUPPRESSED });
  prune(now);
  logLine("flagged", { client: clientTag(key), remembered: true, ttlMs: TTL_MS, budget: MAX_SUPPRESSED, live: flagged.size });
}

/** Should this request's 402 be sent WITHOUT MPP challenges? The one question
 *  the evm, tempo and card appenders ask, answering both rules: the
 *  wrong-domain steering below, then the User-Agent gate
 *  (src/mpp-offer-gate.js). Each is decided once per request. */
export function mppChallengesSuppressed(req) {
  if (!req) return false;
  return wrongDomainSuppressed(req) || mppOffersWithheldFor(req);
}

/** The wrong-domain steering. Decided ONCE per request: the appenders all
 *  ask, and they must agree AND must not spend more than one of the response
 *  budget between them. */
function wrongDomainSuppressed(req) {
  if (!evmDomainFallbackEnabled()) return false;
  if (req.mppSuppressChallenges) return true;
  if (typeof req.__mppSuppressDecision === "boolean") return req.__mppSuppressDecision;

  const decide = () => {
    const key = clientFingerprint(req);
    const entry = key ? flagged.get(key) : undefined;
    // Mid-flow on some payment method: it needs a fresh challenge to retry,
    // and we have no evidence about the method it is actually using.
    if (carriesCredential(req)) {
      if (entry) logLine("challenged", { client: clientTag(key), reason: "carries-credential", remaining: entry.remaining });
      return false;
    }
    if (!key) return false;
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      logLine("challenged", { client: clientTag(key), reason: "expired" });
      flagged.delete(key);
      return false;
    }
    entry.remaining -= 1;
    // A spent budget removes the entry here, so a later bare request finds
    // nothing and logs nothing: "remaining=0" on this line IS the spent notice.
    if (entry.remaining <= 0) flagged.delete(key);
    logLine("withheld", { client: clientTag(key), remaining: entry.remaining, live: flagged.size });
    return true;
  };
  const verdict = decide();
  Object.defineProperty(req, "__mppSuppressDecision", { value: verdict, enumerable: false, configurable: true });
  return verdict;
}

/** Test seam only. */
export function _resetMppFallback() {
  flagged.clear();
}

/** Operator visibility: how many clients are currently falling back. Counts
 *  only - a fingerprint is never exposed. */
export function mppFallbackStatus() {
  const now = Date.now();
  let live = 0;
  for (const v of flagged.values()) if (v.expiresAt > now && v.remaining > 0) live++;
  return { enabled: evmDomainFallbackEnabled(), suppressedClients: live, ttlMs: TTL_MS, maxResponses: MAX_SUPPRESSED, offerGate: mppOfferGateStatus() };
}
