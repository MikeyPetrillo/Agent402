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
import { shared, sharedLimitsEnabled, sharedWrite, noteSharedLimitsDegraded, keyOf as sharedKeyOf, OP_MS } from "./shared-limits.js";
import { getSharedRedisClient } from "./shared-limit.js";
import { withLoopTimeout } from "./loop-deadline.js";

export const BASE_UNPROVEN_DEFAULT_USD = 0.05;
export const BASE_UNPROVEN_SELLER_DAILY_DEFAULT_USD = 0.25;
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

// ---- the per-seller ledger ---------------------------------------------------
const WINDOW = "base-unproven-seller";
const CONTROL = "base-unproven-seller-cap";
const SHARED = sharedLimitsEnabled();
const PROC = `${process.pid}-${randomBytes(3).toString("hex")}`;
// key -> [{ id, micro, at }]
const local = new Map();
let seq = 0;

/** The seller's ledger keys: its EVM payTo (lowercased) and its origin host. */
export function unprovenSellerKeys({ payTo, origin } = {}) {
  const keys = [];
  const w = typeof payTo === "string" ? payTo.trim() : "";
  if (/^0x[0-9a-fA-F]{40}$/.test(w)) keys.push(`payto:${w.toLowerCase()}`);
  let host = null;
  try { host = origin ? new URL(String(origin)).host.toLowerCase() : null; } catch { host = null; }
  if (host) keys.push(`origin:${host}`);
  return keys;
}

function localRows(k, now) {
  const rows = (local.get(k) || []).filter((r) => now - r.at < UNPROVEN_SELLER_WINDOW_MS);
  if (rows.length) local.set(k, rows); else local.delete(k);
  return rows;
}
const localMicro = (k, now) => localRows(k, now).reduce((s, r) => s + r.micro, 0);

// KEYS[1..n] = the seller's windows; ARGV: cutoff, windowMs, encodedMember,
// score, capMicro, weightMicro, then one local floor per key. Prunes every
// window, and adds the entry to all of them only when each one's larger of
// its shared sum and this process's own stays within the cap.
const SELLER_RESERVE = `
local n = #KEYS
local worst = 0
for i = 1, n do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', ARGV[1])
  local items = redis.call('ZRANGE', KEYS[i], 0, -1)
  local sum = 0
  for j = 1, #items do sum = sum + (tonumber(string.match(items[j], '^(%-?%d+)|')) or 1) end
  local base = math.max(sum, tonumber(ARGV[6 + i]))
  if base > worst then worst = base end
end
if worst + tonumber(ARGV[6]) > tonumber(ARGV[5]) then return { 0, worst } end
for i = 1, n do
  redis.call('ZADD', KEYS[i], ARGV[4], ARGV[3])
  redis.call('PEXPIRE', KEYS[i], ARGV[2])
end
return { 1, worst }`;

const refusal = (spentMicro, capUsd) => ({
  ok: false,
  code: "unproven_seller_daily_cap",
  spentUsd: spentMicro / 1e6,
  capUsd,
  reason: `this seller has been paid $${(spentMicro / 1e6).toFixed(2)} through the Base unproven lane in the last 24 hours (cap $${capUsd} per seller); it is tried again as that spend ages out`,
});

/**
 * Check the seller's daily cap and reserve `atomic` (USDC, 6 decimals) in one
 * step. `{ ok: true, handle }` (handle null when the cap is off or the seller
 * has no readable key) or the refusal above. Never throws.
 */
export async function reserveUnprovenSellerSpend({ payTo, origin, atomic, now = Date.now(), capUsd = baseUnprovenSellerDailyUsd() } = {}) {
  if (capUsd == null) return { ok: true, handle: null };
  const keys = unprovenSellerKeys({ payTo, origin });
  let micro = 0;
  try { micro = Number(BigInt(String(atomic))); } catch { micro = NaN; }
  const capMicro = Math.round(capUsd * 1e6);
  // A seller with no key we can read, or an amount we cannot read, is not
  // given the benefit of the doubt: the lane pays only what it can bound.
  if (!keys.length || !Number.isFinite(micro) || micro <= 0) return refusal(0, capUsd);
  const floors = keys.map((k) => localMicro(k, now));
  const id = ++seq;
  const member = `${PROC}:${id}`;
  const book = () => { for (const k of keys) { const rows = localRows(k, now); rows.push({ id, micro, at: now }); local.set(k, rows); } };
  const localWorst = Math.max(...floors);
  let sharedOk = false;
  if (SHARED) {
    let c = null;
    try { c = await getSharedRedisClient(); } catch { c = null; }
    if (!c) noteSharedLimitsDegraded(CONTROL, { ok: false, error: "redis unavailable" });
    else {
      try {
        const r = await withLoopTimeout(c.eval(SELLER_RESERVE, {
          keys: keys.map((k) => sharedKeyOf(WINDOW, k)),
          arguments: [now - UNPROVEN_SELLER_WINDOW_MS, UNPROVEN_SELLER_WINDOW_MS, `${micro}|${member}`, now, capMicro, micro, ...keys.map((k) => localMicro(k, now))].map(String),
        }), OP_MS(), () => new Error("shared-limits: command timed out"));
        if (Number(r?.[0]) !== 1) return refusal(Math.max(localWorst, Number(r?.[1]) || 0), capUsd);
        sharedOk = true;
      } catch (e) {
        noteSharedLimitsDegraded(CONTROL, { ok: false, error: String(e?.message || e).slice(0, 120) });
      }
    }
  }
  // Without the shared store (or when it did not answer) this process's own
  // rows decide. No await between this check and the booking.
  if (!sharedOk) {
    const nowRows = Math.max(...keys.map((k) => localMicro(k, now)));
    if (nowRows + micro > capMicro) return refusal(nowRows, capUsd);
  }
  book();
  return { ok: true, handle: { keys, id, micro, member, shared: sharedOk } };
}

/** Give a reservation back (the payment provably moved nothing). Idempotent. */
export function releaseUnprovenSellerSpend(handle) {
  if (!handle || typeof handle !== "object" || handle.released) return;
  handle.released = true;
  for (const k of handle.keys || []) {
    const rows = (local.get(k) || []).filter((r) => r.id !== handle.id);
    if (rows.length) local.set(k, rows); else local.delete(k);
    if (handle.shared) void sharedWrite(CONTROL, shared.windowRemove(WINDOW, k, { member: handle.member, weight: handle.micro }));
  }
}

/** What the lane has paid a seller in the last 24 h, in USD (this process's rows, or the shared figure when larger). */
export async function unprovenSellerSpentUsd({ payTo, origin, now = Date.now() } = {}) {
  const keys = unprovenSellerKeys({ payTo, origin });
  let worst = Math.max(0, ...keys.map((k) => localMicro(k, now)));
  if (SHARED && keys.length) {
    const r = await shared.windowReadMany(keys.map((k) => ({ name: WINDOW, key: k, windowMs: UNPROVEN_SELLER_WINDOW_MS })), { now });
    if (r.ok) for (const s of r.results) worst = Math.max(worst, Number(s?.sum) || 0);
    else noteSharedLimitsDegraded(CONTROL, r);
  }
  return worst / 1e6;
}

/** Test-only: forget this process's rows (and, with a shared store, the seller's windows). */
export async function __resetUnprovenSellerLedger(sellers = []) {
  if (SHARED) for (const s of sellers) for (const k of unprovenSellerKeys(s)) await shared.windowClear(WINDOW, k);
  local.clear();
  seq = 0;
}
export const __sharedUnprovenSellerLedger = SHARED;
