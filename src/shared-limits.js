// One counter for every replica: the shared half of the admission and money
// controls.
//
// Every rate limiter, breaker and budget in this service was a Map in one
// process, so the service could run one container only: a second replica
// doubles every limit, a breaker that counts distinct failing buyers never
// trips when the buyers land on different containers, and a money guard lets
// one payer carry its ceiling once per container. This module is the shared
// state those controls read and write when a Redis is in reach, with the same
// interface served from process memory when none is.
//
// Backend, chosen once at boot: Redis when REDIS_URL is set (the same client
// the trial limiter, the replay guard, the idempotency store and the money
// journals share, src/shared-limit.js) and SHARED_LIMITS is not "off"; memory
// otherwise. Nothing about a control's thresholds changes with the backend.
//
// Three shapes, each one Lua script on the server so two replicas racing the
// same key cannot both see the same count:
//   window   a sliding window of weighted entries (ZSET; score = time, member =
//            "<weight>|<id>"): failures inside a breaker window, abandoned
//            micro-dollars inside a budget window, unsettled spend per payer.
//            Adding returns the window's count and sum after the add; a member
//            re-added keeps one entry (distinct counting); an entry is removed
//            by id or ages out.
//   flag     a value with an expiry: a pause or a block "until <time>".
//   counter  a fixed-window integer with an expiry: a day's spend, a minute's
//            spend (INCRBY; a negative delta releases).
//   tally    a hash of named integers with one expiry, set when the key is new
//            (HINCRBY per field): many fixed counters under one key, added to
//            in O(1) per field and read whole. A key holds at most
//            TALLY_FIELD_CAP fields; an add naming a new field past that is
//            dropped (reported as `dropped`).
//
// Every call resolves { ok, ... }. It never throws. `ok: false` means the
// shared store did not answer (not configured, not reachable, or the command
// timed out), and the CONTROL decides its own fallback: an admission limiter
// continues on its own process's counter, a money guard or a breaker decides
// on its own process's counter (which is never looser than one replica was)
// and this module logs one word per control per minute. The word on
// /api/gateway-status (sharedLimits): on (Redis answers), memory (no Redis
// configured), degraded (Redis configured and a command failed inside the
// last minute, or the client has never connected). A second word, alert,
// reads sustained once degraded has held for ten minutes without a break
// (the pagers read that one), else ok.
//
// Keys are `sl:<name>:<key>`, or `sl:<prefix>:<name>:<key>` with
// SHARED_LIMITS_PREFIX (tests running against one Redis set a prefix per run).
// A key is whatever the control counts under: a payer digest, a wallet, a
// chain, "all". No value stored here is a credential.
import { getSharedRedisClient, connectionState } from "./shared-limit.js";
import { withLoopTimeout } from "./loop-deadline.js";

export const SHARED_LIMITS_WORDS = ["on", "memory", "degraded"];

const OFF_RE = /^(0|off|false|no)$/i;
/** True when the shared backend is Redis: REDIS_URL set and SHARED_LIMITS not off. */
export function sharedLimitsConfigured(env = process.env) {
  return Boolean(String(env.REDIS_URL || "").trim()) && !OFF_RE.test(String(env.SHARED_LIMITS ?? "").trim());
}
const MODE = sharedLimitsConfigured() ? "redis" : "memory";
/** "redis" or "memory", fixed at boot. */
export function sharedLimitsMode() { return MODE; }
/** True when a control should write its state through to the shared store. */
export function sharedLimitsEnabled() { return MODE === "redis"; }

/** A Redis command that neither answers nor fails within this is a failure (SHARED_LIMITS_OP_MS). */
export const OP_MS = () => Math.max(50, Number(process.env.SHARED_LIMITS_OP_MS) || 1_000);
/** How long after a failed command the word reads degraded (SHARED_LIMITS_DEGRADED_HOLD_MS). */
export const DEGRADED_HOLD_MS = () => Math.max(1_000, Number(process.env.SHARED_LIMITS_DEGRADED_HOLD_MS) || 60_000);
/** A window read hands back its entries only up to this many (count and sum always). */
const MAX_ENTRIES = 512;
/** Fields one tally key may hold. */
export const TALLY_FIELD_CAP = 1_024;
/** Fields every tally key in one memory backend may hold together. */
export const MEMORY_TALLY_FIELD_CAP = 500_000;

const PREFIX = (() => {
  const p = String(process.env.SHARED_LIMITS_PREFIX || "").trim().replace(/[^A-Za-z0-9_.-]/g, "");
  return p ? `sl:${p}:` : "sl:";
})();
export const keyOf = (name, key) => `${PREFIX}${name}:${key}`;

// ---- entry encoding ---------------------------------------------------------
const encodeMember = (member, weight) => `${Math.trunc(Number(weight) || 0)}|${member}`;
function parseEntries(flat) {
  // [member, score, member, score, ...] -> [{ score, weight, member }]
  const out = [];
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const raw = String(flat[i]);
    const bar = raw.indexOf("|");
    const weight = bar > 0 ? Number(raw.slice(0, bar)) : 1;
    out.push({ score: Number(flat[i + 1]), weight: Number.isFinite(weight) ? weight : 1, member: bar > 0 ? raw.slice(bar + 1) : raw });
  }
  return out;
}
const summarize = (entries) => ({ count: entries.length, sum: entries.reduce((s, e) => s + e.weight, 0) });

// ---- the memory backend -------------------------------------------------------
/** Keys each in-memory map may hold. Past it, expired keys are swept and then
 *  the oldest are evicted, so a fresh key per request (a new payer, a new IP)
 *  cannot grow a process's memory without bound while Redis is away. */
export const MEMORY_KEY_CAP = 50_000;
/** The same interface from process memory. Every call resolves ok: true. */
export function createMemoryLimits({ keyCap = MEMORY_KEY_CAP, tallyFieldCap = MEMORY_TALLY_FIELD_CAP } = {}) {
  const windows = new Map();  // key -> [{ score, weight, member }]
  const tallies = new Map();  // key -> { fields: Map(field -> n), exp }
  let tallyFields = 0;
  const dropTally = (k) => { const v = tallies.get(k); if (v) { tallyFields -= v.fields.size; tallies.delete(k); } };
  const flags = new Map();    // key -> until (ms)
  const counters = new Map(); // key -> { value, exp }
  const windowSpan = new Map(); // key -> the window (ms) it was last written with
  const bound = (map, expired) => {
    if (map.size <= keyCap) return;
    for (const [k, v] of map) if (expired(k, v)) { map.delete(k); if (map === windows) windowSpan.delete(k); }
    // Down to 90% of the cap, so the sweep runs once per tenth of the cap
    // of new keys, not on every add.
    while (map.size > Math.floor(keyCap * 0.9)) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
      if (map === windows) windowSpan.delete(oldest);
    }
  };
  const prune = (key, cutoff) => {
    const list = (windows.get(key) || []).filter((e) => e.score > cutoff);
    if (list.length) windows.set(key, list); else windows.delete(key);
    return list;
  };
  const readOne = (key, windowMs, now) => {
    const list = prune(key, now - windowMs);
    const s = summarize(list);
    return { ...s, entries: list.length <= MAX_ENTRIES ? list.map((e) => ({ ...e })) : null };
  };
  return {
    kind: "memory",
    async windowAdd(name, key, { windowMs, member, weight = 1, now = Date.now(), score = now }) {
      const k = keyOf(name, key);
      const list = prune(k, now - windowMs).filter((e) => e.member !== String(member));
      list.push({ score, weight: Math.trunc(Number(weight) || 0), member: String(member) });
      list.sort((a, b) => a.score - b.score);
      windows.delete(k); // re-insert: Map order is the eviction order
      windows.set(k, list);
      windowSpan.set(k, windowMs);
      bound(windows, (key, l) => !l.length || l[l.length - 1].score <= now - (windowSpan.get(key) || windowMs));
      return { ok: true, ...readOne(k, windowMs, now) };
    },
    async windowRead(name, key, { windowMs, now = Date.now() }) {
      return { ok: true, ...readOne(keyOf(name, key), windowMs, now) };
    },
    async windowReadMany(items, { now = Date.now() } = {}) {
      return { ok: true, results: items.map((it) => readOne(keyOf(it.name, it.key), it.windowMs, now)) };
    },
    async windowRemove(name, key, { member }) {
      const k = keyOf(name, key);
      const list = (windows.get(k) || []).filter((e) => e.member !== String(member));
      if (list.length) windows.set(k, list); else windows.delete(k);
      return { ok: true };
    },
    async windowClear(name, key) { windows.delete(keyOf(name, key)); return { ok: true }; },
    async flagSet(name, key, untilMs, { now = Date.now() } = {}) {
      const k = keyOf(name, key);
      flags.delete(k);
      if (Number(untilMs) > now) flags.set(k, Number(untilMs));
      bound(flags, (_, until) => until <= now);
      return { ok: true };
    },
    async flagGet(name, key, { now = Date.now() } = {}) {
      const k = keyOf(name, key);
      const until = flags.get(k) || 0;
      if (until && until <= now) flags.delete(k);
      return { ok: true, until: until > now ? until : 0 };
    },
    async counterAdd(name, key, delta, ttlMs, { now = Date.now() } = {}) {
      const k = keyOf(name, key);
      let c = counters.get(k);
      if (!c || c.exp <= now) c = { value: 0, exp: now + Math.max(1, Number(ttlMs) || 1) };
      c.value += Math.trunc(Number(delta) || 0);
      counters.delete(k);
      counters.set(k, c);
      bound(counters, (_, v) => v.exp <= now);
      return { ok: true, value: c.value };
    },
    async counterGet(name, key, { now = Date.now() } = {}) {
      const c = counters.get(keyOf(name, key));
      if (!c || c.exp <= now) { counters.delete(keyOf(name, key)); return { ok: true, value: 0 }; }
      return { ok: true, value: c.value };
    },
    async counterClear(name, key) { counters.delete(keyOf(name, key)); return { ok: true }; },
    async tallyAdd(name, key, increments, ttlMs, { now = Date.now() } = {}) {
      const k = keyOf(name, key);
      let v = tallies.get(k);
      if (v && v.exp <= now) { dropTally(k); v = null; }
      if (!v) v = { fields: new Map(), exp: now + Math.max(1, Number(ttlMs) || 1) };
      let dropped = 0;
      for (const [field, delta] of increments || []) {
        const f = String(field);
        const have = v.fields.get(f);
        if (have === undefined && v.fields.size >= TALLY_FIELD_CAP) { dropped++; continue; }
        if (have === undefined) tallyFields++;
        v.fields.set(f, (have || 0) + Math.trunc(Number(delta) || 0));
      }
      tallies.delete(k);
      tallies.set(k, v);
      // Expired keys first, then the oldest written, until the fields fit.
      if (tallies.size > keyCap || tallyFields > tallyFieldCap) for (const [tk, tv] of tallies) if (tv.exp <= now) dropTally(tk);
      while ((tallies.size > keyCap || tallyFields > tallyFieldCap) && tallies.size > 1) dropTally(tallies.keys().next().value);
      return { ok: true, dropped };
    },
    async tallyReadMany(items, { now = Date.now() } = {}) {
      return { ok: true, results: items.map((it) => {
        const k = keyOf(it.name, it.key);
        const v = tallies.get(k);
        if (!v || v.exp <= now) { if (v) dropTally(k); return { fields: {} }; }
        return { fields: Object.fromEntries(v.fields) };
      }) };
    },
    /** Test seam. */
    _clear() { windows.clear(); flags.clear(); counters.clear(); windowSpan.clear(); tallies.clear(); tallyFields = 0; },
    /** Test seam: key counts per map. */
    _sizes() { return { windows: windows.size, flags: flags.size, counters: counters.size, tallies: tallies.size }; },
    /** Test seam: tally keys, fields held, and the most fields in one key. */
    _tallySizes() { let maxFieldsPerKey = 0; for (const v of tallies.values()) maxFieldsPerKey = Math.max(maxFieldsPerKey, v.fields.size); return { keys: tallies.size, fields: tallyFields, maxFieldsPerKey }; },
  };
}

// ---- the Redis backend --------------------------------------------------------
// Each script prunes the window to the cutoff it is given, then answers the
// count, the weighted sum and (when small) the entries, so the caller's local
// view can be checked against the shared one in a single round trip.
const SUM_BLOCK = `
local function summary(key, maxEntries)
  local items = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')
  local count = #items / 2
  local sum = 0
  for i = 1, #items, 2 do
    local w = tonumber(string.match(items[i], '^(%-?%d+)|')) or 1
    sum = sum + w
  end
  if count > maxEntries then return { count, sum } end
  return { count, sum, items }
end`;
// KEYS[1] = window; ARGV: cutoff, windowMs, encodedMember, score, maxEntries
const WINDOW_ADD = `${SUM_BLOCK}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return summary(KEYS[1], tonumber(ARGV[5]))`;
// KEYS[1..n] = windows; ARGV[1..n] = cutoff per key; ARGV[n+1] = maxEntries
const WINDOW_READ_MANY = `${SUM_BLOCK}
local out = {}
local n = #KEYS
for i = 1, n do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', ARGV[i])
  out[i] = summary(KEYS[i], tonumber(ARGV[n + 1]))
end
return out`;
// KEYS[1] = counter; ARGV: delta, ttlMs. The expiry is set when the key is
// new, never refreshed, so a fixed window ends when it should.
const COUNTER_ADD = `
local v = redis.call('INCRBY', KEYS[1], ARGV[1])
if tonumber(redis.call('PTTL', KEYS[1])) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return v`;
// KEYS[1] = tally; ARGV: ttlMs, fieldCap, then field, delta pairs. One HINCRBY
// per field (a new field past the cap is dropped and counted); the expiry is
// set when the key is new, never refreshed.
const TALLY_ADD = `
local cap = tonumber(ARGV[2])
local dropped = 0
for i = 3, #ARGV, 2 do
  if redis.call('HEXISTS', KEYS[1], ARGV[i]) == 1 or redis.call('HLEN', KEYS[1]) < cap then
    redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
  else
    dropped = dropped + 1
  end
end
if tonumber(redis.call('PTTL', KEYS[1])) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return dropped`;
// KEYS[1..n] = tallies: each one's fields and values, flat.
const TALLY_READ_MANY = `
local out = {}
for i = 1, #KEYS do out[i] = redis.call('HGETALL', KEYS[i]) end
return out`;

// Measured in loop time (src/loop-deadline.js): a command whose answer came
// back while boot work held the loop is read, not booked as a store that did
// not answer (which read the word degraded for a minute on a healthy Redis).
function withTimeout(p, ms) {
  return withLoopTimeout(p, ms, () => new Error("shared-limits: command timed out"));
}
/**
 * The shared Redis client with every command bounded: a method that answers a
 * promise rejects "command timed out" when no answer came within `ms` of loop
 * time (default OP_MS), so a connected Redis that stops answering fails the
 * caller's command instead of holding it for as long as the socket lives.
 * Anything else (a property, a method that answers no promise) passes
 * through. Null stays null.
 */
export function boundedRedisClient(c, ms = OP_MS) {
  if (!c || typeof c !== "object") return c ?? null;
  const limit = () => (typeof ms === "function" ? ms() : ms);
  return new Proxy(c, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      return function boundedCommand(...args) {
        const out = v.apply(target, args);
        return out && typeof out.then === "function" ? withTimeout(out, limit()) : out;
      };
    },
  });
}
const parseSummary = (r) => {
  const count = Number(r?.[0]) || 0, sum = Number(r?.[1]) || 0;
  return { count, sum, entries: Array.isArray(r?.[2]) ? parseEntries(r[2]) : null };
};

/**
 * The Redis-backed interface. `getClient` resolves the client or null (not
 * configured, not reachable). Every method resolves `{ ok: false, error }`
 * instead of throwing when the store did not answer.
 */
export function createRedisLimits(getClient = getSharedRedisClient, { opTimeoutMs = OP_MS, onResult = null } = {}) {
  const ms = () => (typeof opTimeoutMs === "function" ? opTimeoutMs() : opTimeoutMs);
  const run = async (fn) => {
    let c = null;
    try { c = await getClient(); } catch (e) { c = null; }
    if (!c) { const r = { ok: false, error: "redis unavailable" }; onResult?.(r); return r; }
    try {
      const out = await withTimeout(fn(c), ms());
      onResult?.(out);
      return out;
    } catch (e) {
      const r = { ok: false, error: String(e?.message || e).slice(0, 120) };
      onResult?.(r);
      return r;
    }
  };
  const evalScript = (c, script, keys, args) => c.eval(script, { keys, arguments: args.map(String) });
  return {
    kind: "redis",
    windowAdd(name, key, { windowMs, member, weight = 1, now = Date.now(), score = now }) {
      return run(async (c) => {
        const r = await evalScript(c, WINDOW_ADD, [keyOf(name, key)], [now - windowMs, Math.max(1, Math.round(windowMs)), encodeMember(member, weight), score, MAX_ENTRIES]);
        return { ok: true, ...parseSummary(r) };
      });
    },
    windowRead(name, key, { windowMs, now = Date.now() }) {
      return run(async (c) => {
        const r = await evalScript(c, WINDOW_READ_MANY, [keyOf(name, key)], [now - windowMs, MAX_ENTRIES]);
        return { ok: true, ...parseSummary(r?.[0]) };
      });
    },
    windowReadMany(items, { now = Date.now() } = {}) {
      if (!items.length) return Promise.resolve({ ok: true, results: [] });
      return run(async (c) => {
        const r = await evalScript(c, WINDOW_READ_MANY, items.map((it) => keyOf(it.name, it.key)), [...items.map((it) => now - it.windowMs), MAX_ENTRIES]);
        return { ok: true, results: (Array.isArray(r) ? r : []).map(parseSummary) };
      });
    },
    windowRemove(name, key, { member, weight = 1 }) {
      return run(async (c) => { await c.zRem(keyOf(name, key), encodeMember(member, weight)); return { ok: true }; });
    },
    windowClear(name, key) {
      return run(async (c) => { await c.del(keyOf(name, key)); return { ok: true }; });
    },
    flagSet(name, key, untilMs, { now = Date.now() } = {}) {
      return run(async (c) => {
        const k = keyOf(name, key);
        if (Number(untilMs) > now) await c.set(k, String(Math.round(untilMs)), { PX: Math.max(1, Math.round(untilMs - now)) });
        else await c.del(k);
        return { ok: true };
      });
    },
    flagGet(name, key, { now = Date.now() } = {}) {
      return run(async (c) => {
        const v = Number(await c.get(keyOf(name, key))) || 0;
        return { ok: true, until: v > now ? v : 0 };
      });
    },
    counterAdd(name, key, delta, ttlMs) {
      return run(async (c) => {
        const v = await evalScript(c, COUNTER_ADD, [keyOf(name, key)], [Math.trunc(Number(delta) || 0), Math.max(1, Math.round(ttlMs))]);
        return { ok: true, value: Number(v) || 0 };
      });
    },
    counterGet(name, key) {
      return run(async (c) => ({ ok: true, value: Number(await c.get(keyOf(name, key))) || 0 }));
    },
    counterClear(name, key) {
      return run(async (c) => { await c.del(keyOf(name, key)); return { ok: true }; });
    },
    tallyAdd(name, key, increments, ttlMs) {
      const pairs = [];
      for (const [field, delta] of increments || []) pairs.push(String(field), Math.trunc(Number(delta) || 0));
      if (!pairs.length) return Promise.resolve({ ok: true, dropped: 0 });
      return run(async (c) => {
        const dropped = await evalScript(c, TALLY_ADD, [keyOf(name, key)], [Math.max(1, Math.round(ttlMs)), TALLY_FIELD_CAP, ...pairs]);
        return { ok: true, dropped: Number(dropped) || 0 };
      });
    },
    tallyReadMany(items) {
      if (!items.length) return Promise.resolve({ ok: true, results: [] });
      return run(async (c) => {
        const r = await evalScript(c, TALLY_READ_MANY, items.map((it) => keyOf(it.name, it.key)), []);
        return { ok: true, results: items.map((_, i) => {
          const flat = Array.isArray(r?.[i]) ? r[i] : [];
          const fields = {};
          for (let j = 0; j + 1 < flat.length; j += 2) fields[String(flat[j])] = Number(flat[j + 1]) || 0;
          return { fields };
        }) };
      });
    },
  };
}

// ---- the process's instance and its word ----------------------------------------
const state = { ops: 0, failures: 0, lastOkAt: 0, lastFailAt: 0, lastError: null, degradedSince: 0 };
const LOADED_AT = Date.now();
/** How long the word must read degraded without a break before `alert` reads sustained. */
export const SHARED_LIMITS_ALERT_AFTER_MS = 10 * 60_000;
const noteResult = (r, now = Date.now()) => {
  state.ops++;
  if (r?.ok) { state.lastOkAt = now; return; }
  state.failures++;
  // A failure after the hold of the one before it starts a new degraded spell.
  if (!state.degradedSince || !state.lastFailAt || now - state.lastFailAt >= DEGRADED_HOLD_MS()) state.degradedSince = now;
  state.lastFailAt = now;
  state.lastError = String(r?.error || "unknown").slice(0, 120);
};
const impl = MODE === "redis" ? createRedisLimits(getSharedRedisClient, { onResult: noteResult }) : createMemoryLimits();

/** The process's shared store (Redis-backed, or memory when none is configured). */
export const shared = {
  mode: MODE,
  windowAdd: (...a) => impl.windowAdd(...a),
  windowRead: (...a) => impl.windowRead(...a),
  windowReadMany: (...a) => impl.windowReadMany(...a),
  windowRemove: (...a) => impl.windowRemove(...a),
  windowClear: (...a) => impl.windowClear(...a),
  flagSet: (...a) => impl.flagSet(...a),
  flagGet: (...a) => impl.flagGet(...a),
  counterAdd: (...a) => impl.counterAdd(...a),
  counterGet: (...a) => impl.counterGet(...a),
  counterClear: (...a) => impl.counterClear(...a),
  tallyAdd: (...a) => impl.tallyAdd(...a),
  tallyReadMany: (...a) => impl.tallyReadMany(...a),
};

/** The word: on / memory / degraded. */
export function sharedLimitsWord(now = Date.now()) {
  if (MODE !== "redis") return "memory";
  if (state.lastFailAt && now - state.lastFailAt < DEGRADED_HOLD_MS()) return "degraded";
  // Never answered yet: the client's own connect state is the only evidence.
  if (!state.lastOkAt && connectionState().connected === false) return "degraded";
  return "on";
}
/**
 * The second word, for the pagers: sustained once the word has read degraded
 * without a break for SHARED_LIMITS_ALERT_AFTER_MS, else ok. One failed
 * command reads degraded for the hold and then on again, so the word alone
 * is not a page. A client that never connected counts from module load.
 */
export function sharedLimitsAlert(now = Date.now()) {
  if (sharedLimitsWord(now) !== "degraded") return "ok";
  const inHold = state.lastFailAt && now - state.lastFailAt < DEGRADED_HOLD_MS();
  const since = inHold ? state.degradedSince : LOADED_AT;
  return since && now - since >= SHARED_LIMITS_ALERT_AFTER_MS ? "sustained" : "ok";
}
/** sharedLimits on /api/gateway-status: two words publicly, counts for the operator. */
export function sharedLimitsStatus({ full = false, now = Date.now() } = {}) {
  const status = sharedLimitsWord(now);
  const alert = sharedLimitsAlert(now);
  if (!full) return { status, alert };
  return {
    status, alert, mode: MODE, ops: state.ops, failures: state.failures,
    lastOkAgoMs: state.lastOkAt ? now - state.lastOkAt : null,
    lastFailAgoMs: state.lastFailAt ? now - state.lastFailAt : null,
    lastError: state.lastError,
  };
}

// One log line per control per minute when the shared store did not answer:
// the control decided on its own process's counters, which is the one-replica
// behaviour, so the line is a word for the operator, not an alarm per call.
const lastDegradedLog = new Map();
export function noteSharedLimitsDegraded(control, r) {
  const now = Date.now();
  const at = lastDegradedLog.get(control) || 0;
  if (now - at < 60_000) return;
  lastDegradedLog.set(control, now);
  console.warn(`[shared-limits] ${control}: the shared store did not answer (${String(r?.error || "unavailable").slice(0, 80)}); deciding on this process's own counters`);
}

/** A fire-and-forget shared write: never rejects, notes a miss under `control`. */
export function sharedWrite(control, p) {
  return Promise.resolve(p).then((r) => { if (!r?.ok) noteSharedLimitsDegraded(control, r); return r; }, (e) => { noteSharedLimitsDegraded(control, { error: e?.message }); return { ok: false, error: String(e?.message || e) }; });
}

/**
 * A shared daily cap for an upstream vendor, per UTC day (a counter per day,
 * kept two days). The unit is dollars stored as micro-dollars (`scale` 1e6);
 * a cap counted in whole units (tokens) passes `scale: 1`. `reserve(amount,
 * cap)` adds the estimate and answers false (giving the estimate back) when the
 * shared total would pass the cap; `book(amount)` corrects the day by a signed
 * amount. A store that does not answer lets the caller's own counter decide
 * (reserve answers true).
 */
export function createSharedDailySpend(name, control, { day = (now) => new Date(now).toISOString().slice(0, 10), scale = 1e6 } = {}) {
  const TTL_MS = 48 * 3_600_000;
  const micro = (usd) => Math.round((Number(usd) || 0) * scale);
  return {
    /** False without a shared store: the caller keeps its synchronous check and book. */
    enabled: sharedLimitsEnabled(),
    async reserve(usd, capUsd, now = Date.now()) {
      if (!sharedLimitsEnabled()) return true;
      const m = micro(usd);
      const r = await shared.counterAdd(name, day(now), m, TTL_MS);
      if (!r.ok) { noteSharedLimitsDegraded(control, r); return true; }
      if (r.value > micro(capUsd)) { void sharedWrite(control, shared.counterAdd(name, day(now), -m, TTL_MS)); return false; }
      return true;
    },
    book(usd, now = Date.now()) {
      if (!sharedLimitsEnabled()) return;
      const m = micro(usd);
      // The write's settled result (never rejects), for a caller that keeps one in flight.
      return m ? sharedWrite(control, shared.counterAdd(name, day(now), m, TTL_MS)) : undefined;
    },
    /** The shared total for the day in the caller's unit, or null. */
    async today(now = Date.now()) {
      if (!sharedLimitsEnabled()) return null;
      const r = await shared.counterGet(name, day(now));
      return r.ok ? r.value / scale : null;
    },
    /** A refusal at the cap, held `holdMs` for every replica's status word (a flag per day). */
    noteRefused(holdMs, now = Date.now()) {
      if (sharedLimitsEnabled()) void sharedWrite(control, shared.flagSet(`${name}-refused`, day(now), now + holdMs, { now }));
    },
    /** One read for a status word: the day's shared total in stored units and
     *  the refusal hold's end, or null when the store did not answer. */
    async view(now = Date.now()) {
      if (!sharedLimitsEnabled()) return null;
      const [c, f] = await Promise.all([shared.counterGet(name, day(now)), shared.flagGet(`${name}-refused`, day(now), { now })]);
      return c.ok && f.ok ? { day: day(now), units: c.value, refusedUntil: f.until } : null;
    },
    /** Test seam: the day's shared counter is dropped (beside the kit's own reset). */
    reset(now = Date.now()) {
      if (!sharedLimitsEnabled()) return;
      void sharedWrite(control, shared.counterClear(name, day(now)));
      void sharedWrite(control, shared.flagSet(`${name}-refused`, day(now), 0, { now }));
    },
  };
}

// A read of the store shortly after boot and then on a timer, so the word is
// measured rather than assumed (a configured URL nobody has contacted yet
// would otherwise read on). Idempotent; never on a request's path.
let probeTimer = null;
export const PROBE_FIRST_MS = () => Math.max(0, Number(process.env.SHARED_LIMITS_PROBE_FIRST_MS ?? 2_000));
export const PROBE_MS = () => Math.max(1_000, Number(process.env.SHARED_LIMITS_PROBE_MS) || 300_000);
export async function probeSharedLimits() {
  if (MODE !== "redis") return { ok: true, skipped: true };
  return shared.flagGet("probe", "boot");
}
export function startSharedLimitsProbe() {
  if (MODE !== "redis" || probeTimer) return;
  const tick = async () => { try { await probeSharedLimits(); } catch { /* recorded by the result */ } };
  probeTimer = setTimeout(() => {
    void tick();
    probeTimer = setInterval(() => { void tick(); }, PROBE_MS());
    probeTimer.unref?.();
  }, PROBE_FIRST_MS());
  probeTimer.unref?.();
}

/** Test seam: the counts behind the word. */
export function _sharedLimitsState() { return { ...state }; }
export function _resetSharedLimitsState() { state.ops = 0; state.failures = 0; state.lastOkAt = 0; state.lastFailAt = 0; state.lastError = null; state.degradedSince = 0; lastDegradedLog.clear(); }
/** Test-only: record one command result at a given time. */
export function _noteSharedLimitsResult(r, now) { noteResult(r, now); }
