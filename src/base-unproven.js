// The Base twin of the unproven Solana tier (2026-09-30).
//
// On Base the router pays only sellers whose own wallet clears the settlement
// floor, so a new seller could never earn its first routed settlement: it had
// to bring its own buyers first. A seller below the floor is now tried under a
// small per-call ceiling, only after every proven candidate for the task, only
// when the floor is the ONLY thing standing in the way (a self-funded history,
// a shared or mismatched wallet, a wrong EIP-712 domain or a failing delivery
// still refuse), paid only at the wallet its own live 402 names, and flagged
// `sellerProof: "unproven"` on the receipt. The ceiling is re-checked against
// the quote the router signs (payX402).
//
// Env SOR_BASE_UNPROVEN_MAX_USD, default $0.05 (raised from $0.01 on
// 2026-11-05, so a seller whose deliberate floor is five cents can be tried);
// `0` or `off` restores the hard floor. A malformed value reads as the
// default, never as a wider ceiling.
//
// PER-SELLER DAILY CAP (2026-11-05). The wider ceiling comes with a bound on
// what the lane can pay any one seller: the unproven spend booked against a
// seller over a rolling 24 hours, keyed on BOTH the wallet its live 402 names
// and its origin host (whichever is fuller decides), so neither a second
// origin in front of one wallet nor a second wallet behind one origin buys a
// fresh day. Env SOR_BASE_UNPROVEN_SELLER_DAILY_USD, default $0.25; `0` or
// `off` removes this cap (the per-call ceiling and the Base wallet's own daily
// ceiling still hold); a malformed value reads as the default.
//
// PATH-SCOPED SELLERS. The index keeps a seller hosted under a path prefix on
// a shared host (`https://host/app/<name>`) as its own seller, keyed on the
// origin plus that prefix (src/x402-index.js, normalizeSellerKey). Such a
// seller's origin key is that same identity, `origin:host/app/<name>`, so two
// tenants on one host each get their own day and one cannot spend its
// neighbors' cap. The key comes from the index's seller key (route-execute
// hands it to payX402 as `sellerKey`), never from the URL being paid, so a
// tenant cannot buy a fresh day by varying the path below its own prefix; a
// paid URL that is not at or under that prefix gives the seller no key at
// all, and the lane does not pay it. A bare origin, or a call with no seller
// key, keeps the host key exactly as before.
//
// A payTo the operator lists as shared (src/shared-paytos.js: a split or
// router contract many sellers are paid through) is not one seller's wallet,
// so it is not a ledger key: a seller paid at one is keyed on its origin
// alone, and the sellers behind it do not share one day's cap. The list is
// the server's store, handed in with configureUnprovenSharedPayTos.
//
// LANE DAILY CAP. The whole lane's unproven spend over a rolling 24 hours,
// across every seller, is bounded too: env SOR_BASE_UNPROVEN_DAILY_USD,
// default $5; `0` or `off` removes it; a malformed value reads as the
// default. It is one more window in the same store, reserved in the same
// script as the seller's windows and booked and given back under the same
// rules, so a seller under its own cap is still refused (the same pre-commit
// 409) once the lane is full, and the router moves on.
//
// The cap is checked and the signed amount reserved in ONE step right before
// payX402 signs; the reservation is given back when the payment provably
// moved nothing (refused before signing, or the chain shows the credential
// expired unused) and otherwise stays as the day's booking, so a settled buy,
// and one whose outcome cannot be read, both count. Shared across replicas the
// way the per-payer spend ceiling is (src/external-spend-guard.js): with a
// Redis (src/shared-limits.js) each seller key is a sliding window of
// micro-dollar entries, and the reservation is one script on the server, so
// two replicas reserving for one seller at once queue there and the window
// never holds more than the cap. Each process also keeps its own rows, the
// floor under the shared figure, and decides on them alone when the store does
// not answer. Redis keeps the window across restarts; without one the day is
// this process's.
import { randomBytes } from "node:crypto";
import { shared, sharedLimitsEnabled, noteSharedLimitsDegraded, keyOf as sharedKeyOf, OP_MS } from "./shared-limits.js";
import { getSharedRedisClient } from "./shared-limit.js";
import { withLoopTimeout } from "./loop-deadline.js";
import { usdFigure } from "./price-usd.js";

export const BASE_UNPROVEN_DEFAULT_USD = 0.05;
export const BASE_UNPROVEN_SELLER_DAILY_DEFAULT_USD = 0.25;
export const BASE_UNPROVEN_LANE_DAILY_DEFAULT_USD = 5;
export const UNPROVEN_SELLER_WINDOW_MS = 24 * 60 * 60_000;

export function baseUnprovenAllowanceUsd() {
  const raw = String(process.env.SOR_BASE_UNPROVEN_MAX_USD ?? "").trim().toLowerCase();
  if (raw === "") return BASE_UNPROVEN_DEFAULT_USD;
  if (raw === "off") return 0;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0) return BASE_UNPROVEN_DEFAULT_USD;
  return usd;
}

/** The same ceiling in USDC atomic units (6 decimals). */
export function baseUnprovenAllowanceAtomic() {
  return BigInt(Math.round(baseUnprovenAllowanceUsd() * 1e6));
}

/** The per-seller rolling 24-hour cap in USD, or null when switched off. Read at call time. */
export function baseUnprovenSellerDailyUsd() {
  const raw = String(process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD ?? "").trim().toLowerCase();
  if (raw === "") return BASE_UNPROVEN_SELLER_DAILY_DEFAULT_USD;
  if (raw === "off") return null;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0) return BASE_UNPROVEN_SELLER_DAILY_DEFAULT_USD;
  return usd === 0 ? null : usd;
}

/** The lane's rolling 24-hour cap across all sellers in USD, or null when switched off. Read at call time. */
export function baseUnprovenLaneDailyUsd() {
  const raw = String(process.env.SOR_BASE_UNPROVEN_DAILY_USD ?? "").trim().toLowerCase();
  if (raw === "") return BASE_UNPROVEN_LANE_DAILY_DEFAULT_USD;
  if (raw === "off") return null;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0) return BASE_UNPROVEN_LANE_DAILY_DEFAULT_USD;
  return usd === 0 ? null : usd;
}

// ---- the per-seller ledger ---------------------------------------------------
const WINDOW = "base-unproven-seller-v2";
const CONTROL = "base-unproven-seller-cap";
const SHARED = sharedLimitsEnabled();
const PROC = `${process.pid}-${randomBytes(3).toString("hex")}`;
// key -> [{ id, micro, at }]
const local = new Map();
let seq = 0;
const LANE_KEY = "lane:base";

// The operator's shared-payTo list (src/shared-paytos.js), handed in by the
// server. A predicate that throws reads as "not shared", so the seller keeps
// the stricter pair of keys.
let sharedPayToCheck = null;
/** Hand in the shared-payTo predicate (wallet -> boolean); null clears it. */
export function configureUnprovenSharedPayTos(isShared) {
  sharedPayToCheck = typeof isShared === "function" ? isShared : null;
}
function payToIsShared(w) {
  if (!sharedPayToCheck) return false;
  try { return sharedPayToCheck(w) === true; } catch { return false; }
}

// The seller's origin key. `url` is what is paid; `sellerKey` is the index's
// seller key (origin, or origin plus a path prefix). Undefined when the seller
// cannot be keyed: no readable URL, or a URL outside its own seller key.
function originKeyOf(url, sellerKey) {
  let u = null;
  try { u = url ? new URL(String(url)) : null; } catch { u = null; }
  if (!sellerKey) return u ? `origin:${u.host.toLowerCase()}` : undefined;
  let s = null;
  try { s = new URL(String(sellerKey)); } catch { return undefined; }
  if (!u) u = s;
  const host = s.host.toLowerCase();
  if (u.protocol !== s.protocol || u.host.toLowerCase() !== host) return undefined;
  const prefix = s.pathname.replace(/\/+$/, "");
  if (!prefix) return `origin:${host}`;
  // A segment boundary, never a substring: /app/x does not own /app/x2.
  if (u.pathname !== prefix && !u.pathname.startsWith(`${prefix}/`)) return undefined;
  return `origin:${host}${prefix}`;
}

/** The seller's ledger keys: its EVM payTo (lowercased; not when the payTo is
 *  a listed shared one) and its origin key: the host, or for a path-scoped
 *  seller (`sellerKey` carries a prefix) the host plus that prefix. */
export function unprovenSellerKeys({ payTo, origin, sellerKey } = {}) {
  const keys = [];
  const w = typeof payTo === "string" ? payTo.trim() : "";
  const originKey = originKeyOf(origin, sellerKey);
  // A paid URL outside its own seller key is not bounded by any origin key,
  // so the seller gets no key at all and the lane refuses it.
  if (sellerKey && !originKey) return keys;
  if (/^0x[0-9a-fA-F]{40}$/.test(w) && !payToIsShared(w.toLowerCase())) keys.push(`payto:${w.toLowerCase()}`);
  if (originKey) keys.push(originKey);
  return keys;
}

function localRows(k, now) {
  const rows = (local.get(k) || []).filter((r) => now - r.at < UNPROVEN_SELLER_WINDOW_MS);
  if (rows.length) local.set(k, rows); else local.delete(k);
  return rows;
}
const localMicro = (k, now) => localRows(k, now).reduce((s, r) => s + r.micro, 0);

// RUNNING SUMS. Each window (a sorted set of `<micro>|<member>` entries) has
// a running sum beside it, under its own name (SUM_WINDOW), so a reserve
// never walks the window: the sum is raised on an add, lowered on a release
// that removed an entry, and lowered by exactly what the expiry prune takes
// out (ZRANGEBYSCORE over the expired head only). A reserve is O(log n) plus
// the entries that expired since the last touch, not O(n): the lane window at
// 50,000 entries was summed in full on every reserve, holding Redis.
//
// The sum is a cache of its window, never the other way round:
// - It is rebuilt from the window (in the same script call) whenever it is
//   missing, not an integer, negative, or larger than the window could hold
//   (its entry count times the window's cap: no admitted entry is above the
//   cap it was admitted under). An empty window's sum is zero and its key is
//   dropped.
// - Its expiry is set only when it is (re)built, never renewed by a reserve,
//   so it is rebuilt from the window at least once per window period and an
//   error in it cannot outlive a day.
// - The window and sum names carry the format version (`-v2`). A build that
//   kept no running sum, or one that renewed the sum's expiry, never writes a
//   window this build sums: during a deploy overlap or after a rollback the
//   older build keeps its own window, so its adds and prunes cannot move this
//   build's sums away from their windows. Those two windows are independent
//   only while both builds serve; a rebuild here folds in the unexpired
//   entries of the older build's window (LEGACY_WINDOW, read only, never
//   written), so a deploy does not hand every seller a fresh day, and an entry
//   the older build added after this build's last rebuild is seen at the next
//   one. Members are unique per process and reservation, so folding the same
//   entry twice adds it once.
//
// Every script that touches a window keeps its sum, and nothing else writes
// these windows (the reads below settle through SETTLE, not the shared-limits
// window read, which would prune without lowering the sum).
const LEGACY_WINDOW = "base-unproven-seller";
const SUM_WINDOW = "base-unproven-seller-v2-sum";
// settle(window, sum, legacyWindow, cutoff, windowMs, capMicro): prune the
// expired head, lower the sum by what it held, rebuild it when it cannot be
// right, and answer the window's current sum. capMicro 0 skips the
// upper-bound check (a read that knows no cap).
const SETTLE = `
local function weight(e) return tonumber(string.match(e, '^(%-?%d+)|')) or 1 end
local function rebuild(z, s, lz, cutoff, windowMs)
  redis.call('ZREMRANGEBYSCORE', z, '-inf', cutoff)
  local prior = redis.call('ZRANGEBYSCORE', lz, '(' .. cutoff, '+inf', 'WITHSCORES')
  for j = 1, #prior, 2 do redis.call('ZADD', z, 'NX', prior[j + 1], prior[j]) end
  local items = redis.call('ZRANGE', z, 0, -1)
  if #items == 0 then
    redis.call('DEL', s)
    return 0
  end
  local sum = 0
  for j = 1, #items do sum = sum + weight(items[j]) end
  redis.call('SET', s, sum, 'PX', windowMs)
  if redis.call('PTTL', z) < 0 then redis.call('PEXPIRE', z, windowMs) end
  return sum
end
local function settle(z, s, lz, cutoff, windowMs, capMicro)
  local cur = tonumber(redis.call('GET', s))
  if not cur or cur < 0 or cur ~= math.floor(cur) then return rebuild(z, s, lz, cutoff, windowMs) end
  local old = redis.call('ZRANGEBYSCORE', z, '-inf', cutoff)
  if #old > 0 then
    local d = 0
    for j = 1, #old do d = d + weight(old[j]) end
    redis.call('ZREMRANGEBYSCORE', z, '-inf', cutoff)
    cur = tonumber(redis.call('DECRBY', s, d))
  end
  local count = redis.call('ZCARD', z)
  if count == 0 or cur < 0 then return rebuild(z, s, lz, cutoff, windowMs) end
  local cap = tonumber(capMicro) or 0
  if cap > 0 and cur > count * cap then return rebuild(z, s, lz, cutoff, windowMs) end
  return cur
end
`;

// KEYS[1..n] = the windows (the seller's, then the lane's), KEYS[n+1..2n] =
// their sums, KEYS[2n+1..3n] = the older build's windows (read on a rebuild
// only); ARGV: cutoff, windowMs, encodedMember, score, weightMicro, then a
// local floor and a cap per window. Settles every window, and adds the entry
// to all of them only when each one's larger of its shared sum and this
// process's own stays within its own cap; otherwise answers the first window
// that refused and its figure. A sum created by the add (an empty window)
// gets the window period as its expiry; an existing sum keeps its own.
const SELLER_RESERVE = `${SETTLE}
local n = #KEYS / 3
local w = tonumber(ARGV[5])
for i = 1, n do
  local sum = settle(KEYS[i], KEYS[n + i], KEYS[2 * n + i], ARGV[1], ARGV[2], ARGV[5 + 2 * i])
  local base = math.max(sum, tonumber(ARGV[4 + 2 * i]))
  if base + w > tonumber(ARGV[5 + 2 * i]) then return { 0, i, base } end
end
for i = 1, n do
  if redis.call('ZADD', KEYS[i], ARGV[4], ARGV[3]) == 1 then
    if redis.call('EXISTS', KEYS[n + i]) == 1 then redis.call('INCRBY', KEYS[n + i], ARGV[5])
    else redis.call('SET', KEYS[n + i], ARGV[5], 'PX', ARGV[2]) end
  end
  redis.call('PEXPIRE', KEYS[i], ARGV[2])
end
return { 1, 0, 0 }`;

// KEYS[1..n] = the windows, KEYS[n+1..2n] = their sums; ARGV: encodedMember,
// weightMicro. Removes the entry and lowers each sum only where the entry was
// still there (a release after the entry expired, or a second release, lowers
// nothing). A sum lowered below zero is rebuilt by the next settle.
const SELLER_RELEASE = `
local n = #KEYS / 2
for i = 1, n do
  if redis.call('ZREM', KEYS[i], ARGV[1]) == 1 then
    if redis.call('EXISTS', KEYS[i]) == 0 then redis.call('DEL', KEYS[n + i])
    elseif redis.call('EXISTS', KEYS[n + i]) == 1 then redis.call('DECRBY', KEYS[n + i], ARGV[2]) end
  end
end
return 1`;

// KEYS as for SELLER_RESERVE; ARGV: cutoff, windowMs, then a cap per window
// (0 = none). Each window's current sum.
const SELLER_READ = `${SETTLE}
local n = #KEYS / 3
local out = {}
for i = 1, n do out[i] = settle(KEYS[i], KEYS[n + i], KEYS[2 * n + i], ARGV[1], ARGV[2], ARGV[2 + i]) end
return out`;

const sumKeys = (keys) => [...keys.map((k) => sharedKeyOf(WINDOW, k)), ...keys.map((k) => sharedKeyOf(SUM_WINDOW, k))];
const windowKeys = (keys) => [...sumKeys(keys), ...keys.map((k) => sharedKeyOf(LEGACY_WINDOW, k))];
const capMicroOf = (k) => { const usd = k === LANE_KEY ? baseUnprovenLaneDailyUsd() : baseUnprovenSellerDailyUsd(); return usd == null ? 0 : Math.round(usd * 1e6); };

/** The shared sums of these windows at `now` (settling each), or null when the store does not answer. */
async function sharedSums(keys, now) {
  let c = null;
  try { c = await getSharedRedisClient(); } catch { c = null; }
  if (!c) { noteSharedLimitsDegraded(CONTROL, { ok: false, error: "redis unavailable" }); return null; }
  try {
    const r = await withLoopTimeout(c.eval(SELLER_READ, { keys: windowKeys(keys), arguments: [now - UNPROVEN_SELLER_WINDOW_MS, UNPROVEN_SELLER_WINDOW_MS, ...keys.map(capMicroOf)].map(String) }), OP_MS(), () => new Error("shared-limits: command timed out"));
    return Array.isArray(r) ? r.map((x) => Number(x) || 0) : null;
  } catch (e) {
    noteSharedLimitsDegraded(CONTROL, { ok: false, error: String(e?.message || e).slice(0, 120) });
    return null;
  }
}

export const _sellerCapRefusal = (spentMicro, capUsd) => refusal(spentMicro, capUsd);
export const _laneCapRefusal = (spentMicro, capUsd) => laneRefusal(spentMicro, capUsd);
const refusal = (spentMicro, capUsd) => ({
  ok: false,
  code: "unproven_seller_daily_cap",
  spentUsd: spentMicro / 1e6,
  capUsd,
  reason: `this seller has been paid ${usdFigure(spentMicro / 1e6)} through the Base unproven lane in the last 24 hours (cap ${usdFigure(capUsd)} per seller); it is tried again as that spend ages out`,
});
const laneRefusal = (spentMicro, capUsd) => ({
  ok: false,
  code: "unproven_lane_daily_cap",
  spentUsd: spentMicro / 1e6,
  capUsd,
  reason: `the Base unproven lane has paid ${usdFigure(spentMicro / 1e6)} across all sellers in the last 24 hours (cap ${usdFigure(capUsd)}); unproven sellers are tried again as that spend ages out`,
});

/**
 * Check the seller's daily cap and the lane's, and reserve `atomic` (USDC, 6
 * decimals) against both in one step. `{ ok: true, handle }` (handle null
 * when both caps are off) or one of the refusals above (the seller's when
 * both refuse). Never throws.
 */
export async function reserveUnprovenSellerSpend({ payTo, origin, sellerKey = null, atomic, now = Date.now(), capUsd = baseUnprovenSellerDailyUsd(), laneCapUsd = baseUnprovenLaneDailyUsd() } = {}) {
  if (capUsd == null && laneCapUsd == null) return { ok: true, handle: null };
  const sellerKeys = capUsd == null ? [] : unprovenSellerKeys({ payTo, origin, sellerKey });
  let micro = 0;
  try { micro = Number(BigInt(String(atomic))); } catch { micro = NaN; }
  // A seller with no key we can read, or an amount we cannot read, is not
  // given the benefit of the doubt: the lane pays only what it can bound.
  if ((capUsd != null && !sellerKeys.length) || !Number.isFinite(micro) || micro <= 0) return capUsd != null ? refusal(0, capUsd) : laneRefusal(0, laneCapUsd);
  const keys = laneCapUsd == null ? sellerKeys : [...sellerKeys, LANE_KEY];
  const caps = keys.map((k) => Math.round((k === LANE_KEY ? laneCapUsd : capUsd) * 1e6));
  const refuse = (i, spentMicro) => (keys[i] === LANE_KEY ? laneRefusal(spentMicro, laneCapUsd) : refusal(spentMicro, capUsd));
  const id = ++seq;
  const member = `${PROC}:${id}`;
  const book = () => { for (const k of keys) { const rows = localRows(k, now); rows.push({ id, micro, at: now }); local.set(k, rows); } };
  let sharedOk = false;
  if (SHARED) {
    let c = null;
    try { c = await getSharedRedisClient(); } catch { c = null; }
    if (!c) noteSharedLimitsDegraded(CONTROL, { ok: false, error: "redis unavailable" });
    else {
      try {
        const r = await withLoopTimeout(c.eval(SELLER_RESERVE, {
          keys: windowKeys(keys),
          arguments: [now - UNPROVEN_SELLER_WINDOW_MS, UNPROVEN_SELLER_WINDOW_MS, `${micro}|${member}`, now, micro, ...keys.flatMap((k, i) => [localMicro(k, now), caps[i]])].map(String),
        }), OP_MS(), () => new Error("shared-limits: command timed out"));
        if (Number(r?.[0]) !== 1) {
          const i = Math.min(keys.length, Math.max(1, Number(r?.[1]) || 1)) - 1;
          return refuse(i, Math.max(localMicro(keys[i], now), Number(r?.[2]) || 0));
        }
        sharedOk = true;
      } catch (e) {
        noteSharedLimitsDegraded(CONTROL, { ok: false, error: String(e?.message || e).slice(0, 120) });
      }
    }
  }
  // Without the shared store (or when it did not answer) this process's own
  // rows decide. No await between this check and the booking.
  if (!sharedOk) {
    for (let i = 0; i < keys.length; i++) {
      const rows = localMicro(keys[i], now);
      if (rows + micro > caps[i]) return refuse(i, rows);
    }
  }
  book();
  return { ok: true, handle: { keys, id, micro, member, shared: sharedOk } };
}

/** Give a reservation back (the payment provably moved nothing). Idempotent.
 *  Answers the shared write's promise (callers need not wait on it). */
export function releaseUnprovenSellerSpend(handle) {
  if (!handle || typeof handle !== "object" || handle.released) return;
  handle.released = true;
  for (const k of handle.keys || []) {
    const rows = (local.get(k) || []).filter((r) => r.id !== handle.id);
    if (rows.length) local.set(k, rows); else local.delete(k);
  }
  if (handle.shared && Array.isArray(handle.keys) && handle.keys.length) {
    return (async () => {
      const c = await getSharedRedisClient();
      if (!c) throw new Error("redis unavailable");
      await withLoopTimeout(c.eval(SELLER_RELEASE, { keys: sumKeys(handle.keys), arguments: [`${handle.micro}|${handle.member}`, String(handle.micro)] }), OP_MS(), () => new Error("shared-limits: command timed out"));
    })().catch((e) => noteSharedLimitsDegraded(CONTROL, { ok: false, error: String(e?.message || e).slice(0, 120) }));
  }
}

/** What the lane has paid a seller in the last 24 h, in USD (this process's rows, or the shared figure when larger). */
export async function unprovenSellerSpentUsd({ payTo, origin, sellerKey = null, now = Date.now() } = {}) {
  const keys = unprovenSellerKeys({ payTo, origin, sellerKey });
  let worst = Math.max(0, ...keys.map((k) => localMicro(k, now)));
  if (SHARED && keys.length) {
    const sums = await sharedSums(keys, now);
    if (sums) for (const v of sums) worst = Math.max(worst, v);
  }
  return worst / 1e6;
}

/** What the lane has paid across all sellers in the last 24 h, in USD (this process's rows, or the shared figure when larger). */
export async function unprovenLaneSpentUsd({ now = Date.now() } = {}) {
  let worst = localMicro(LANE_KEY, now);
  if (SHARED) {
    const sums = await sharedSums([LANE_KEY], now);
    if (sums) worst = Math.max(worst, sums[0]);
  }
  return worst / 1e6;
}

/** Test-only: forget this process's rows (and, with a shared store, the seller's windows and the lane's). */
export async function __resetUnprovenSellerLedger(sellers = []) {
  if (SHARED) { for (const k of [...sellers.flatMap((s) => unprovenSellerKeys(s)), LANE_KEY]) for (const name of [WINDOW, SUM_WINDOW, LEGACY_WINDOW]) await shared.windowClear(name, k); }
  local.clear();
  seq = 0;
}
export const __sharedUnprovenSellerLedger = SHARED;
/** Test-only: the shared sums of these ledger keys at `now`, settled (null without the store). */
export const __unprovenWindowSums = (keys, now = Date.now()) => (SHARED ? sharedSums(keys, now) : Promise.resolve(null));
/** Test-only: the shared store's key names for a ledger key (its window and its sum). */
export const __unprovenStoreKeys = (k) => ({ window: sharedKeyOf(WINDOW, k), sum: sharedKeyOf(SUM_WINDOW, k), legacy: sharedKeyOf(LEGACY_WINDOW, k) });
