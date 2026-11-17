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
import { withLoopTimeout } from "../loop-deadline.js";
import { AsyncLocalStorage } from "node:async_hooks";

const cgRatePerMin = () => Math.max(1, parseInt(process.env.COINGECKO_MAX_PER_MIN || "80", 10) || 80);
let cgTokens = null, cgRefilledAt = 0;

// A hard daily ceiling sits under the minute bucket, so a steady caller cannot
// use up the key's allowance early. Applies while a key is configured.
// Counted per UTC day. COINGECKO_DAILY_MAX tunes it.
const cgDailyMax = () => Math.max(1, parseInt(process.env.COINGECKO_DAILY_MAX || "300", 10) || 300);
const cgDay = { day: "", used: 0, unsettled: 0, shares: Object.create(null) };

// SHARES OF THE DAY. A read is counted on the day when it is taken, before
// anyone knows how the call ends. A call that ends in a 4xx is never settled,
// so reads spent on calls nobody pays for (made-up ids, refused inputs) would
// otherwise use up the allowance paid calls run on. Those reads are moved, when
// the call ends, from the day counter to their own counter, which holds a small
// share of the day (COINGECKO_UNSETTLED_SHARE, default 10%); the day counter
// keeps the rest, so the reads of calls that end unsettled can never take more
// than that share from paid calls. Once that share is spent, an id that a list
// document can confirm (a coin, an exchange, a platform) is checked against
// that list before any read (src/tools/crypto-markets-kit.js knownIdGate).
// A kit can also be held to a share of the day (`share` on cgScopeAll): the
// market screens read several documents a call, and their share
// (COINGECKO_SCREENS_SHARE, default 40% of the paid part) keeps the other
// CoinGecko tools' part whatever the screens are asked.
const shareOf = (env, dflt) => { const f = Number(process.env[env]); return Number.isFinite(f) && f >= 0 && f < 1 ? f : dflt; };
/** The day's caps: the whole ceiling, the part reads of unsettled calls may
 *  hold, and what is left for every other read. */
export function cgDayCaps(dayMax = cgDailyMax()) {
  const unsettled = Math.floor(dayMax * shareOf("COINGECKO_UNSETTLED_SHARE", 0.1));
  return { day: dayMax, unsettled, paid: Math.max(1, dayMax - unsettled) };
}
const SHARES = { screens: () => shareOf("COINGECKO_SCREENS_SHARE", 0.4) };
/** A kit share's cap: a fraction of the paid part, never below one read. */
export function cgShareCap(share, dayMax = cgDailyMax()) {
  const f = SHARES[share]?.();
  return f == null ? 0 : Math.max(1, Math.floor(cgDayCaps(dayMax).paid * f));
}

// The call a read is taken for (cgScoped): how many day reads it took, and
// the kit share it draws on.
const calls = new AsyncLocalStorage();
/** Wrap a tool handler: reads taken inside it are counted for the call, and a
 *  call that ends in a 4xx (never settled) moves them to the unsettled share. */
export function cgScoped(handler, { share = null } = {}) {
  const scoped = async function cgScopedHandler(...args) {
    const ctx = { taken: 0, share };
    try {
      return await calls.run(ctx, () => handler.apply(this, args));
    } catch (err) {
      const s = Number(err?.statusCode);
      if (ctx.taken > 0 && s >= 400 && s < 500) await cgMoveUnsettled(ctx.taken, share).catch(() => {});
      throw err;
    }
  };
  return Object.assign(scoped, { __cgScoped: true });
}
/** Wrap every handler of a kit's tool array, in place (once). */
export function cgScopeAll(tools, opts = {}) {
  for (const t of tools) if (t && typeof t.handler === "function" && !t.handler.__cgScoped) t.handler = cgScoped(t.handler, opts);
  return tools;
}
const utcDay = (now) => new Date(now).toISOString().slice(0, 10);
const keyed = () => Boolean((process.env.COINGECKO_API_KEY || "").trim());

const replicas = () => Math.max(1, Math.floor(Number(process.env.RATE_LIMIT_REPLICAS) || 1));
/** This process's share of a service-wide cap (RATE_LIMIT_REPLICAS). Never below 1. */
export const cgLocalShare = (cap) => Math.max(1, Math.floor(cap / replicas()));

function localDay(now) {
  const d = utcDay(now);
  if (cgDay.day !== d) { cgDay.day = d; cgDay.used = 0; cgDay.unsettled = 0; cgDay.shares = Object.create(null); }
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
// The sentence lives in src/data-attribution.js (key "coingecko").
export { COINGECKO_ATTRIBUTION } from "../data-attribution.js";

/** This process's bucket alone: the fallback, and the whole decision without
 *  a shared store. Takes one request's worth of budget. Returns null when
 *  taken, else the reason it was refused: "day" (daily ceiling spent) or
 *  "minute". Synchronous; the request path calls cgTake(). */
export function cgTokenRefusal(now = Date.now(), share = calls.getStore()?.share ?? null) {
  localDay(now);
  if (keyed() && cgDay.used >= cgLocalShare(cgDayCaps().paid)) return "day";
  if (keyed() && share && (cgDay.shares[share] || 0) >= cgLocalShare(cgShareCap(share))) return "day";
  localRefill(now);
  if (cgTokens < 1) return "minute";
  cgTokens -= 1;
  if (keyed()) localCount(share);
  return null;
}
function localCount(share) {
  cgDay.used += 1;
  if (share) cgDay.shares[share] = (cgDay.shares[share] || 0) + 1;
  const ctx = calls.getStore();
  if (ctx) ctx.taken += 1;
}

/** Take one request's worth of this process's budget; false when the minute or the day is spent. */
export function takeCgToken(now = Date.now()) { return cgTokenRefusal(now) === null; }

// The shared half. KEYS[1] = the minute window (ZSET, score = server time in
// ms), KEYS[2] = the day counter (the paid part), KEYS[3] = the kit share's
// counter. ARGV: windowMs, minuteCap, dayCap (0 = no daily ceiling), member,
// dayTtlMs, shareCap (0 = no kit share). The server's clock scores the window,
// so replicas with skewed clocks still agree on what a minute is. Nothing is
// written unless every cap has room.
const TAKE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local windowMs = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - windowMs)
local dayCap = tonumber(ARGV[3])
local shareCap = tonumber(ARGV[6])
if dayCap > 0 and tonumber(redis.call('GET', KEYS[2]) or '0') >= dayCap then return 'day' end
if dayCap > 0 and shareCap > 0 and tonumber(redis.call('GET', KEYS[3]) or '0') >= shareCap then return 'day' end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 'minute' end
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], windowMs)
if dayCap > 0 then
  redis.call('INCR', KEYS[2])
  if tonumber(redis.call('PTTL', KEYS[2])) < 0 then redis.call('PEXPIRE', KEYS[2], ARGV[5]) end
  if shareCap > 0 then
    redis.call('INCR', KEYS[3])
    if tonumber(redis.call('PTTL', KEYS[3])) < 0 then redis.call('PEXPIRE', KEYS[3], ARGV[5]) end
  end
end
return 'ok'`;

// KEYS[1] = the day counter, KEYS[2] = the unsettled counter, KEYS[3] = the
// kit share's counter. ARGV: reads, unsettledCap, dayTtlMs, hasShare. Moves as
// many of the reads as the unsettled share has room for; returns how many.
const MOVE_SCRIPT = `
local n = tonumber(ARGV[1])
local room = tonumber(ARGV[2]) - tonumber(redis.call('GET', KEYS[2]) or '0')
local m = math.min(n, room, tonumber(redis.call('GET', KEYS[1]) or '0'))
if m <= 0 then return 0 end
redis.call('DECRBY', KEYS[1], m)
redis.call('INCRBY', KEYS[2], m)
if tonumber(redis.call('PTTL', KEYS[2])) < 0 then redis.call('PEXPIRE', KEYS[2], ARGV[3]) end
if ARGV[4] == '1' then
  local s = tonumber(redis.call('GET', KEYS[3]) or '0')
  redis.call('DECRBY', KEYS[3], math.min(m, s))
end
return m`;

/** How long one shared command may take before this process decides alone. */
export const CG_SHARED_DEADLINE_MS = () => Math.max(10, Number(process.env.COINGECKO_SHARED_DEADLINE_MS) || 250);
/** Resolve `p`, or reject when it has not answered inside the deadline,
 *  counted in loop time (src/loop-deadline.js): an answer that landed while
 *  the loop was held is taken, not decided alone. */
export function cgWithin(p, ms = CG_SHARED_DEADLINE_MS()) {
  return withLoopTimeout(p, ms, () => new Error(`no answer in ${ms} ms`));
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
      const dayCap = keyed() ? cgDayCaps().paid : 0;
      const share = calls.getStore()?.share ?? null;
      const shareCap = keyed() && share ? cgShareCap(share) : 0;
      const member = `${process.pid}:${now}:${++takeSeq}`;
      const r = await cgWithin(c.eval(TAKE_SCRIPT, {
        keys: [keyOf("cg-minute", "all"), keyOf("cg-day", utcDay(now)), keyOf(`cg-share-${share || "none"}`, utcDay(now))],
        arguments: ["60000", String(cgRatePerMin()), String(dayCap), member, String(48 * 3_600_000), String(shareCap)],
      }));
      if (r === "ok") {
        counts.shared++;
        // Mirror the grant into this process's bucket (floored at empty).
        localDay(now); localRefill(now);
        cgTokens = Math.max(0, cgTokens - 1);
        if (keyed()) localCount(share);
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

/** Move `n` reads of a call that ended unsettled from the day counter to the
 *  unsettled share, as far as that share has room (the rest stay counted on
 *  the day). Resolves how many moved. Never rejects. */
export async function cgMoveUnsettled(n, share = null, now = Date.now()) {
  if (!keyed() || !(n > 0)) return 0;
  const cap = cgDayCaps().unsettled;
  localDay(now);
  if (sharedLimitsEnabled()) {
    try {
      const c = await getSharedRedisClient();
      if (!c) throw new Error("redis unavailable");
      const d = utcDay(now);
      const m = Number(await cgWithin(c.eval(MOVE_SCRIPT, {
        keys: [keyOf("cg-day", d), keyOf("cg-unsettled", d), keyOf(`cg-share-${share || "none"}`, d)],
        arguments: [String(n), String(cap), String(48 * 3_600_000), share ? "1" : "0"],
      }))) || 0;
      localMove(Math.min(m, n), share, Number.MAX_SAFE_INTEGER);
      return m;
    } catch (e) {
      noteSharedLimitsDegraded("coingecko-rate", { error: e?.message });
    }
  }
  return localMove(n, share, cgLocalShare(cap));
}
function localMove(n, share, cap) {
  const m = Math.max(0, Math.min(n, cap - cgDay.unsettled, cgDay.used));
  cgDay.used -= m; cgDay.unsettled += m;
  if (share) cgDay.shares[share] = Math.max(0, (cgDay.shares[share] || 0) - m);
  return m;
}

/** True when the reads of calls that ended unsettled have used up their share
 *  of the day: an id a list can confirm is then checked before it is read.
 *  False without a key (no daily ceiling) or with a share of zero. */
export async function cgUnsettledSpent(now = Date.now()) {
  if (!keyed()) return false;
  const cap = cgDayCaps().unsettled;
  if (cap === 0) return false;
  localDay(now);
  if (sharedLimitsEnabled()) {
    try {
      const c = await getSharedRedisClient();
      if (!c) throw new Error("redis unavailable");
      const v = Number(await cgWithin(c.get(keyOf("cg-unsettled", utcDay(now))))) || 0;
      return v >= cap;
    } catch (e) {
      noteSharedLimitsDegraded("coingecko-rate", { error: e?.message });
    }
  }
  return cgDay.unsettled >= cgLocalShare(cap);
}

/** Where this process's budget decisions were made: the shared store, its own
 *  bucket without one, or its own bucket because the store did not answer. */
export function cgTakeCounts() { return { ...counts }; }

/** Seconds until 00:00 UTC, when the daily allowance renews. */
export function secondsToUtcMidnight(now = Date.now()) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}
/** Seconds until the pacing has room again: this process's bucket refills
 *  continuously, so the next token is (1 - tokens) / rate away; with a
 *  shared store, one token's spacing at the service-wide rate. */
export function cgPacingRetrySeconds(now = Date.now()) {
  const perMs = cgLocalShare(cgRatePerMin()) / 60_000;
  const missing = cgTokens === null ? 0 : Math.max(0, 1 - cgTokens);
  const localMs = missing > 0 ? missing / perMs : 0;
  const spacingMs = 60_000 / cgRatePerMin();
  return Math.max(1, Math.ceil(Math.max(localMs, spacingMs) / 1000));
}

/** Buyer-facing refusal text for a cgTokenRefusal reason (never a count).
 *  Both reasons are this server's own: its share of the daily allowance, or
 *  its own request pacing. Neither says the upstream is down or throttling. */
export function cgRefusalMessage(reason, label = "CoinGecko", now = Date.now()) {
  return reason === "day"
    ? `This server's daily ${label} allowance is used up; it renews at 00:00 UTC. This is on our side, not your input. You were not charged.`
    : `This server paces its ${label} requests and has no room this moment; retry in ${cgPacingRetrySeconds(now)} s. This is on our side, not your input. You were not charged.`;
}

/** The 503 for a cgTokenRefusal reason: attributed to this server, with the
 *  kind (our-allowance or our-pacing) and Retry-After (src/upstream-deadline.js). */
export function cgRefusal(reason, label = "CoinGecko", now = Date.now()) {
  const day = reason === "day";
  return Object.assign(new Error(cgRefusalMessage(reason, label, now)), {
    statusCode: 503,
    attribution: "ours",
    hint: day ? "our-allowance" : "our-pacing",
    retryAfter: day ? secondsToUtcMidnight(now) : cgPacingRetrySeconds(now),
  });
}

/** Test seam: refill this process's bucket (offline suites make dozens of
 *  stubbed calls). A test against a shared store namespaces its run with
 *  SHARED_LIMITS_PREFIX instead. */
export function resetCgRateLimit() { cgTokens = null; cgRefilledAt = 0; cgDay.day = ""; cgDay.used = 0; cgDay.unsettled = 0; cgDay.shares = Object.create(null); }

/** True for coingecko.com and its subdomains (api., pro-api.) and nothing
 *  else: this decides whether the API KEY rides the request, so a host that
 *  merely ENDS in the letters (evilcoingecko.com) must read false. */
export function isCoinGeckoHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "coingecko.com" || h.endsWith(".coingecko.com");
}
