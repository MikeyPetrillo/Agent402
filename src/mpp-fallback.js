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
  if (!key) return; // no User-Agent: this response only, nothing remembered
  const now = Date.now();
  flagged.set(key, { expiresAt: now + TTL_MS, remaining: MAX_SUPPRESSED });
  prune(now);
}

/** Should this request's 402 carry MPP challenges? Decided ONCE per request:
 *  the evm and tempo hooks both ask, and they must agree AND must not spend
 *  two of the response budget between them. */
export function mppChallengesSuppressed(req) {
  if (!evmDomainFallbackEnabled()) return false;
  if (!req) return false;
  if (req.mppSuppressChallenges) return true;
  if (typeof req.__mppSuppressDecision === "boolean") return req.__mppSuppressDecision;

  const decide = () => {
    // Mid-flow on some payment method: it needs a fresh challenge to retry,
    // and we have no evidence about the method it is actually using.
    if (carriesCredential(req)) return false;
    const key = clientFingerprint(req);
    if (!key) return false;
    const entry = flagged.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now() || entry.remaining <= 0) { flagged.delete(key); return false; }
    entry.remaining -= 1;
    if (entry.remaining <= 0) flagged.delete(key);
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
  return { enabled: evmDomainFallbackEnabled(), suppressedClients: live, ttlMs: TTL_MS, maxResponses: MAX_SUPPRESSED };
}
