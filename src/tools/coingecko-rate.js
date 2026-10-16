// One token bucket for EVERY CoinGecko call this service makes.
//
// The Demo plan meters the key at 100 requests a minute, account-wide (docs
// "Demo plan: 100 calls/min", read 2026-09-18; it was 30/min when this shipped
// and the bucket sat at 25 for a month after the plan changed). Two kits
// read it: crypto-markets-kit (the 17 market/RWA tools) kept a private bucket
// at 25/min, and crypto-kit (crypto-price, crypto-market, crypto-history and
// friends) sent the same key with no bucket at all, so under load the two
// together overran the key and every caller of either kit saw 429s. The
// bucket lives here now and both kits draw from it; a caller that finds it
// empty is refused 503 BEFORE any upstream call (a >= 400 cancels settlement,
// nobody pays for the refusal). COINGECKO_MAX_PER_MIN tunes it (default 80,
// under the plan's per-minute limit so the retry-after-429 path keeps a little
// room; the monthly quota is the real ceiling, and CI no longer draws on it).
//
// ONE BUDGET FOR EVERY REPLICA. Both caps are for the whole service: the key is
// metered account-wide, not per container. With a shared store
// (src/shared-limits.js: REDIS_URL set, SHARED_LIMITS not off) cgTake() spends
// them on one sliding minute window and one UTC-day counter that every replica
// reads, in a single script, so two replicas racing cannot both take the last
// token. Without a shared store, or when a command does not answer inside
// COINGECKO_SHARED_DEADLINE_MS, the decision falls to this process's own
// bucket, which holds only this replica's share of each cap
// (RATE_LIMIT_REPLICAS, read at call time): N replicas on their own buckets
// sum to the caps, never to N times them. A grant from the shared store is also
// taken from the local bucket, so a replica that falls back mid-minute
// continues from what it already spent there instead of a fresh share.
import { getSharedRedisClient } from "../shared-limit.js";
import { sharedLimitsEnabled, keyOf, noteSharedLimitsDegraded } from "../shared-limits.js";

const cgRatePerMin = () => Math.max(1, parseInt(process.env.COINGECKO_MAX_PER_MIN || "80", 10) || 80);
let cgTokens = null, cgRefilledAt = 0;

// A hard daily ceiling sits under the minute bucket, so a steady caller cannot
// use up the key's allowance early. Applies while a key is configured.
// Counted per UTC day. COINGECKO_DAILY_MAX tunes it.
const cgDailyMax = () => Math.max(1, parseInt(process.env.COINGECKO_DAILY_MAX || "300", 10) || 300);
const cgDay = { day: "", used: 0 };
const utcDay = (now) => new Date(now).toISOString().slice(0, 10);
const keyed = () => Boolean((process.env.COINGECKO_API_KEY || "").trim());

const replicas = () => Math.max(1, Math.floor(Number(process.env.RATE_LIMIT_REPLICAS) || 1));
/** This process's share of a service-wide cap (RATE_LIMIT_REPLICAS). Never below 1. */
export const cgLocalShare = (cap) => Math.max(1, Math.floor(cap / replicas()));

function localDay(now) {
  const d = utcDay(now);
  if (cgDay.day !== d) { cgDay.day = d; cgDay.used = 0; }
}
function localRefill(now) {
  const cap = cgLocalShare(cgRatePerMin());
  if (cgTokens === null) { cgTokens = cap; cgRefilledAt = now; }
  const elapsed = now - cgRefilledAt;
  if (elapsed > 0) {
    cgTokens = Math.min(cap, cgTokens + (elapsed / 60_000) * cap);
    cgRefilledAt = now;
  }
}

// Attribution the CoinGecko API terms require next to the data (API Terms of
// Service clause 4.1.4, https://www.coingecko.com/en/api_terms, and the brand
// attribution guide, https://brand.coingecko.com/resources/attribution-guide,
// which lists "Data provided by CoinGecko" among the accepted forms). Every
// CoinGecko-backed tool's description ends with it; the vendor-name check in
// scripts/test-no-third-party-names.js allows it there and nowhere else.
export const COINGECKO_ATTRIBUTION = "Data provided by CoinGecko.";

/** This process's bucket alone: the fallback, and the whole decision without
 *  a shared store. Takes one request's worth of budget. Returns null when
 *  taken, else the reason it was refused: "day" (daily ceiling spent) or
 *  "minute". Synchronous; the request path calls cgTake(). */
export function cgTokenRefusal(now = Date.now()) {
  localDay(now);
  if (keyed() && cgDay.used >= cgLocalShare(cgDailyMax())) return "day";
  localRefill(now);
  if (cgTokens < 1) return "minute";
  cgTokens -= 1;
  if (keyed()) cgDay.used += 1;
  return null;
}

/** Take one request's worth of this process's budget; false when the minute or the day is spent. */
export function takeCgToken(now = Date.now()) { return cgTokenRefusal(now) === null; }

// The shared half. KEYS[1] = the minute window (ZSET, score = server time in
// ms), KEYS[2] = the day counter. ARGV: windowMs, minuteCap, dayCap (0 = no
// daily ceiling), member, dayTtlMs. The server's clock scores the window, so
// replicas with skewed clocks still agree on what a minute is. Nothing is
// written unless both caps have room.
const TAKE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local windowMs = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - windowMs)
local dayCap = tonumber(ARGV[3])
if dayCap > 0 and tonumber(redis.call('GET', KEYS[2]) or '0') >= dayCap then return 'day' end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 'minute' end
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], windowMs)
if dayCap > 0 then
  redis.call('INCR', KEYS[2])
  if tonumber(redis.call('PTTL', KEYS[2])) < 0 then redis.call('PEXPIRE', KEYS[2], ARGV[5]) end
end
return 'ok'`;

/** How long one shared command may take before this process decides alone. */
export const CG_SHARED_DEADLINE_MS = () => Math.max(10, Number(process.env.COINGECKO_SHARED_DEADLINE_MS) || 250);
/** Resolve `p`, or reject when it has not answered inside the deadline. */
export function cgWithin(p, ms = CG_SHARED_DEADLINE_MS()) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

let takeSeq = 0;
const counts = { shared: 0, local: 0, fallback: 0 };

/**
 * Take one request's worth of the service-wide budget. Resolves null when
 * taken, else "day" or "minute". Never rejects: a shared store that is not
 * configured, not reachable or slow leaves the decision to this process's
 * share (cgTokenRefusal).
 */
export async function cgTake(now = Date.now()) {
  if (sharedLimitsEnabled()) {
    try {
      const c = await getSharedRedisClient();
      if (!c) throw new Error("redis unavailable");
      const dayCap = keyed() ? cgDailyMax() : 0;
      const member = `${process.pid}:${now}:${++takeSeq}`;
      const r = await cgWithin(c.eval(TAKE_SCRIPT, {
        keys: [keyOf("cg-minute", "all"), keyOf("cg-day", utcDay(now))],
        arguments: ["60000", String(cgRatePerMin()), String(dayCap), member, String(48 * 3_600_000)],
      }));
      if (r === "ok") {
        counts.shared++;
        // Mirror the grant into this process's bucket (floored at empty).
        localDay(now); localRefill(now);
        cgTokens = Math.max(0, cgTokens - 1);
        if (keyed()) cgDay.used += 1;
        return null;
      }
      if (r === "day" || r === "minute") { counts.shared++; return r; }
      throw new Error(`unexpected answer ${String(r).slice(0, 40)}`);
    } catch (e) {
      noteSharedLimitsDegraded("coingecko-rate", { error: e?.message });
    }
    counts.fallback++;
  } else counts.local++;
  return cgTokenRefusal(now);
}

/** Where this process's budget decisions were made: the shared store, its own
 *  bucket without one, or its own bucket because the store did not answer. */
export function cgTakeCounts() { return { ...counts }; }

/** Buyer-facing refusal text for a cgTokenRefusal reason (never a count). */
export function cgRefusalMessage(reason, label = "CoinGecko") {
  return reason === "day"
    ? `${label} is temporarily unavailable, retry later. You were not charged.`
    : `${label} is rate limited right now, retry in a few seconds. You were not charged.`;
}

/** Test seam: refill this process's bucket (offline suites make dozens of
 *  stubbed calls). A test against a shared store namespaces its run with
 *  SHARED_LIMITS_PREFIX instead. */
export function resetCgRateLimit() { cgTokens = null; cgRefilledAt = 0; cgDay.day = ""; cgDay.used = 0; }

/** True for coingecko.com and its subdomains (api., pro-api.) and nothing
 *  else: this decides whether the API KEY rides the request, so a host that
 *  merely ENDS in the letters (evilcoingecko.com) must read false. */
export function isCoinGeckoHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "coingecko.com" || h.endsWith(".coingecko.com");
}
