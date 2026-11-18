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
import { currentCallerKey } from "../request-timing.js";

const cgRatePerMin = () => Math.max(1, parseInt(process.env.COINGECKO_MAX_PER_MIN || "80", 10) || 80);
let cgTokens = null, cgRefilledAt = 0;

// A hard daily ceiling sits under the minute bucket, so a steady caller cannot
// use up the key's allowance early. Applies while a key is configured.
// Counted per UTC day. COINGECKO_DAILY_MAX tunes it.
const cgDailyMax = () => Math.max(1, parseInt(process.env.COINGECKO_DAILY_MAX || "300", 10) || 300);
const cgDay = { day: "", used: 0, unsettled: 0 };

// THE DAY AND WHAT UNPAID CALLS MAY HOLD OF IT. Every read counts on the day
// counter, and a read is refused only when that counter reaches the whole
// ceiling: a paid call can use every read of the day nobody else used. A read
// is counted before anyone knows how its call ends, and a call that ends in an
// error is never settled, so reads spent on calls nobody pays for (made-up ids,
// a currency the upstream does not list) are also counted on their own
// counter, which holds a share of the day (COINGECKO_UNSETTLED_SHARE, default
// 10%). That share caps those reads only, never the reads of paid calls:
//   - A call whose inputs no list has confirmed reserves one place in the
//     share before its first read (cgReserveUnconfirmed, one atomic step on
//     the shared store, so a parallel burst cannot pass a check that the
//     moves of earlier calls have not reached yet). A call that ends settled
//     gives its place back; one that ends in an error keeps it and adds any
//     further reads it took.
//   - Once the share is full, no place is left: the kit checks each id (and
//     currency) against the list document that names them all before any read
//     (src/tools/crypto-markets-kit.js knownIdsGate), so a made-up id is
//     answered with no read of its own and a real one is read as before.
//   - A call whose inputs were confirmed and still ends in an error (an
//     upstream failure) adds its reads too, so the share fills sooner.
//   - PER CALLER. One caller (its address: the request's caller key,
//     src/request-timing.js) holds at most COINGECKO_UNSETTLED_PER_CALLER_HOUR
//     (default 8) places an hour; past them its unconfirmed ids go to the
//     list first, as when the share is full, so one address cannot fill the
//     share every other caller's new ids are read on. A real id is read and
//     served either way: no call is refused for it.
//   - PER ID. An id the upstream (a 404) or its list called unknown is
//     remembered for the UTC day (cgNoteUnknownId): asked again it is
//     answered with no read of its own unless its list, read at most once an
//     hour, now names it (then it is forgotten and read as asked).
// The market screens read several documents a call; they are held below the
// whole ceiling by a reserve kept for every other CoinGecko tool
// (COINGECKO_OTHERS_RESERVE, default 20% of the day; `ceiling: "screens"` on
// cgScopeAll), so the screens can use the rest of the day when the others are
// quiet and the others always keep that reserve.
const shareOf = (env, dflt) => { const f = Number(process.env[env]); return Number.isFinite(f) && f >= 0 && f < 1 ? f : dflt; };
/** The day's caps: the whole ceiling (every read), the share reads of unpaid
 *  calls may hold, and the ceiling the screens stop at (the day less the
 *  reserve kept for the other tools). */
export function cgDayCaps(dayMax = cgDailyMax()) {
  const unsettled = Math.floor(dayMax * shareOf("COINGECKO_UNSETTLED_SHARE", 0.1));
  const reserve = Math.floor(dayMax * shareOf("COINGECKO_OTHERS_RESERVE", 0.2));
  return { day: dayMax, unsettled, reserve, screens: Math.max(1, dayMax - reserve) };
}
/** The day ceiling a call's reads stop at: the whole day, or a lower one a
 *  kit is held to (`ceiling` on cgScopeAll). */
export function cgCeiling(ceiling = null, dayMax = cgDailyMax()) {
  const caps = cgDayCaps(dayMax);
  return ceiling === "screens" ? caps.screens : caps.day;
}

// The call a read is taken for (cgScoped): how many reads it took, whether it
// holds a place in the unsettled share, and the ceiling it is held to.
const calls = new AsyncLocalStorage();

export const CG_UNSETTLED_PER_CALLER_HOUR_DEFAULT = 8;
const perCallerHour = () => { const n = Number(process.env.COINGECKO_UNSETTLED_PER_CALLER_HOUR); return Number.isInteger(n) && n >= 0 ? n : CG_UNSETTLED_PER_CALLER_HOUR_DEFAULT; };
const CALLERS_MAX = 10_000;
const callerPlaces = new Map(); // `${hour}|${caller}` -> places held this hour (this process)
const hourOf = (now) => Math.floor(now / 3_600_000);
function callerTake(caller, now) {
  const h = hourOf(now);
  for (const k of callerPlaces.keys()) { if (Number(k.slice(0, k.indexOf("|"))) >= h && callerPlaces.size <= CALLERS_MAX) break; callerPlaces.delete(k); }
  const key = `${h}|${caller}`;
  const held = callerPlaces.get(key) || 0;
  if (held >= perCallerHour()) return null;
  callerPlaces.set(key, held + 1);
  return key;
}
function callerGiveBack(key) {
  const held = callerPlaces.get(key);
  if (held > 1) callerPlaces.set(key, held - 1); else callerPlaces.delete(key);
}

// Ids the upstream or a list called unknown today (this process), by kind.
const UNKNOWN_MAX = 20_000;
const unknownToday = new Map(); // `${kind}|${id}` -> UTC day
/** Remember that `id` of `kind` is unknown upstream, for the rest of the UTC day. */
export function cgNoteUnknownId(kind, id, now = Date.now()) {
  if (!kind || typeof id !== "string" || !id || id.length > 200) return;
  const k = `${kind}|${id}`;
  unknownToday.delete(k);
  unknownToday.set(k, utcDay(now));
  while (unknownToday.size > UNKNOWN_MAX) unknownToday.delete(unknownToday.keys().next().value);
}
/** True when `id` of `kind` was called unknown earlier today. */
export function cgUnknownToday(kind, id, now = Date.now()) {
  const k = `${kind}|${id}`;
  const d = unknownToday.get(k);
  if (d === undefined) return false;
  if (d === utcDay(now)) return true;
  unknownToday.delete(k);
  return false;
}
/** Forget a remembered id (its list names it now). */
export function cgForgetUnknownId(kind, id) { unknownToday.delete(`${kind}|${id}`); }
// The coin (or exchange) id a CoinGecko API path reads, for a 404's verdict.
const ID_PATH = /^(?:\/api\/v3)?\/(coins|exchanges)\/([^/?#]+)(?:\/(?:history|ohlc|market_chart(?:\/range)?|tickers))?\/?$/;
const RESERVED_PATH_IDS = new Set(["list", "markets", "categories", "top_gainers_losers", "recently_added", "decentralized", "derivatives"]);
/** The kind and id a 404 for this API path says is unknown, or null. */
export function cgUnknownIdOfPath(path) {
  const m = ID_PATH.exec(String(path || ""));
  if (!m) return null;
  let id;
  try { id = decodeURIComponent(m[2]); } catch { return null; }
  if (RESERVED_PATH_IDS.has(id)) return null;
  return { kind: m[1] === "coins" ? "coin" : "exchange", id };
}
/** Wrap a tool handler: reads taken inside it are counted for the call; a call
 *  that ends in an error (never settled) counts them on the unsettled share,
 *  and a call that ends settled gives back the place it reserved there. */
export function cgScoped(handler, { ceiling = null } = {}) {
  const scoped = async function cgScopedHandler(...args) {
    const ctx = { taken: 0, reserved: 0, ceiling, callerPlace: null };
    let failed = false;
    try {
      return await calls.run(ctx, () => handler.apply(this, args));
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      // A settled call gives back its caller's place too.
      if (!failed && ctx.callerPlace) callerGiveBack(ctx.callerPlace);
      const delta = (failed ? ctx.taken : 0) - ctx.reserved;
      if (delta !== 0) await cgCountUnsettled(delta).catch(() => {});
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
  if (cgDay.day !== d) { cgDay.day = d; cgDay.used = 0; cgDay.unsettled = 0; }
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
export function cgTokenRefusal(now = Date.now(), ceiling = calls.getStore()?.ceiling ?? null) {
  localDay(now);
  if (keyed() && cgDay.used >= cgLocalShare(cgCeiling(ceiling))) return "day";
  localRefill(now);
  if (cgTokens < 1) return "minute";
  cgTokens -= 1;
  if (keyed()) localCount();
  return null;
}
function localCount() {
  cgDay.used += 1;
  const ctx = calls.getStore();
  if (ctx) ctx.taken += 1;
}

/** Take one request's worth of this process's budget; false when the minute or the day is spent. */
export function takeCgToken(now = Date.now()) { return cgTokenRefusal(now) === null; }

// The shared half. KEYS[1] = the minute window (ZSET, score = server time in
// ms), KEYS[2] = the day counter (every read). ARGV: windowMs, minuteCap,
// dayCap (the ceiling this call is held to; 0 = no daily ceiling), member,
// dayTtlMs. The server's clock scores the window, so replicas with skewed
// clocks still agree on what a minute is. Nothing is written unless both caps
// have room.
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

// KEYS[1] = the unsettled counter. ARGV: cap, dayTtlMs. Takes one place when
// the counter is under the cap: the check and the take are one step, so two
// replicas racing for the last place cannot both have it. Returns 1 or 0.
const RESERVE_SCRIPT = `
if tonumber(redis.call('GET', KEYS[1]) or '0') >= tonumber(ARGV[1]) then return 0 end
redis.call('INCR', KEYS[1])
if tonumber(redis.call('PTTL', KEYS[1])) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 1`;

// KEYS[1] = the unsettled counter. ARGV: delta, dayTtlMs. Adds the reads of a
// call that ended unsettled less the place it held (a negative delta gives a
// place back), never below zero. Returns the new count.
const COUNT_SCRIPT = `
local v = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
if v < 0 then redis.call('SET', KEYS[1], '0'); v = 0 end
if tonumber(redis.call('PTTL', KEYS[1])) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return v`;

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
const DAY_TTL_MS = String(48 * 3_600_000);

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
      const dayCap = keyed() ? cgCeiling(calls.getStore()?.ceiling ?? null) : 0;
      const member = `${process.pid}:${now}:${++takeSeq}`;
      const r = await cgWithin(c.eval(TAKE_SCRIPT, {
        keys: [keyOf("cg-minute", "all"), keyOf("cg-day", utcDay(now))],
        arguments: ["60000", String(cgRatePerMin()), String(dayCap), member, DAY_TTL_MS],
      }));
      if (r === "ok") {
        counts.shared++;
        // Mirror the grant into this process's bucket (floored at empty).
        localDay(now); localRefill(now);
        cgTokens = Math.max(0, cgTokens - 1);
        if (keyed()) localCount();
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

/** Reserve the current call's place in the unsettled share before it reads
 *  inputs no list has confirmed. True when the call holds a place (now or
 *  from an earlier gate in the same call), or when no daily ceiling applies
 *  (no key); false when the share is full, or outside a scoped call: the
 *  inputs must then be checked against their lists first. Never rejects. */
export async function cgReserveUnconfirmed(now = Date.now()) {
  if (!keyed()) return true;
  const ctx = calls.getStore();
  if (!ctx) return false;
  if (ctx.reserved > 0) return true;
  const cap = cgDayCaps().unsettled;
  if (cap === 0) return false;
  // The caller's own hourly places first (no caller known: none counted).
  const caller = currentCallerKey();
  let place = null;
  if (caller) { place = callerTake(caller, now); if (!place) return false; }
  localDay(now);
  let got = null;
  if (sharedLimitsEnabled()) {
    try {
      const c = await getSharedRedisClient();
      if (!c) throw new Error("redis unavailable");
      got = Number(await cgWithin(c.eval(RESERVE_SCRIPT, { keys: [keyOf("cg-unsettled", utcDay(now))], arguments: [String(cap), DAY_TTL_MS] }))) === 1;
      if (got) cgDay.unsettled += 1;
    } catch (e) {
      noteSharedLimitsDegraded("coingecko-rate", { error: e?.message });
      got = null;
    }
  }
  if (got === null) {
    got = cgDay.unsettled < cgLocalShare(cap);
    if (got) cgDay.unsettled += 1;
  }
  if (got) { ctx.reserved = 1; ctx.callerPlace = place; } else if (place) callerGiveBack(place);
  return got;
}

/** Count `delta` on the unsettled share: the reads of a call that ended
 *  unsettled less the place it reserved (negative when a settled call gives
 *  its place back). Never below zero; never rejects. Resolves the new count. */
export async function cgCountUnsettled(delta, now = Date.now()) {
  if (!keyed() || !Number.isFinite(delta) || delta === 0) return null;
  localDay(now);
  const local = () => { cgDay.unsettled = Math.max(0, cgDay.unsettled + delta); return cgDay.unsettled; };
  if (sharedLimitsEnabled()) {
    try {
      const c = await getSharedRedisClient();
      if (!c) throw new Error("redis unavailable");
      const v = Number(await cgWithin(c.eval(COUNT_SCRIPT, { keys: [keyOf("cg-unsettled", utcDay(now))], arguments: [String(Math.trunc(delta)), DAY_TTL_MS] })));
      local();
      return v;
    } catch (e) {
      noteSharedLimitsDegraded("coingecko-rate", { error: e?.message });
    }
  }
  return local();
}

/** True when the unsettled share is full: a call whose inputs no list has
 *  confirmed can then no longer reserve a place. False without a key (no
 *  daily ceiling). */
export async function cgUnsettledSpent(now = Date.now()) {
  if (!keyed()) return false;
  const cap = cgDayCaps().unsettled;
  if (cap === 0) return true;
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
export function resetCgRateLimit() { cgTokens = null; cgRefilledAt = 0; cgDay.day = ""; cgDay.used = 0; cgDay.unsettled = 0; callerPlaces.clear(); unknownToday.clear(); }

/** True for coingecko.com and its subdomains (api., pro-api.) and nothing
 *  else: this decides whether the API KEY rides the request, so a host that
 *  merely ENDS in the letters (evilcoingecko.com) must read false. */
export function isCoinGeckoHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "coingecko.com" || h.endsWith(".coingecko.com");
}
