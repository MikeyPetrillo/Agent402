// Hard daily call ceilings for the pay-as-you-go upstreams that have no
// spend cap of their own on our side.
//
// src/upstream-budgets.js ALARMS when a host's daily call count passes its
// budget; it never refuses. This module refuses: past a host's ceiling for the
// UTC day, an outbound call is not made and the caller gets a 503 (uncharged,
// since a status of 400 or more is never settled). The ceilings sit well above
// the alarm budgets, so the alarm pages first and this is the backstop.
//
// SHARED ACROSS REPLICAS WITHOUT A HOT-PATH AWAIT. Each process counts its own
// calls synchronously, flushes the increments to the shared daily counter
// (src/shared-limits.js) on a short timer, and reads the shared total back on
// the same timer. A call is refused when this process's view of the day's
// total (the last shared read plus what it has not flushed yet, or its own
// count, whichever is larger) has reached the ceiling. Overshoot is bounded by
// one sync interval of traffic. Without a shared store the per-process count
// is the bound, and it survives nothing a restart resets.
//
// WHAT A UNIT IS: a call that may have reached the upstream. The unit is taken
// before the call (so a burst cannot pass the ceiling while calls are in
// flight) and given back only when the call provably never left this process:
// the name did not resolve, the connection was refused or never opened, or the
// caller's signal was already aborted when the call was made
// (neverReachedUpstream). Everything else keeps its unit, whatever came back:
// an upstream that answered an error, a timeout or a reset after the request
// was written may all have been metered there.
//
// A ceiling of `0` refuses every call; `off` disables one. A malformed value
// falls back to the default, never to disabled.

import { createSharedDailySpend } from "./shared-limits.js";

// `match` is a host suffix the fetch hook checks; null means the kit counts
// its own units (E2B: one unit per sandbox started, whatever hosts it uses).
export const HARD_CAPS = [
  { name: "alchemy", match: "alchemy.com", env: "HARDCAP_ALCHEMY_CALLS", dflt: 300000 },
  { name: "brave", match: "api.search.brave.com", env: "HARDCAP_BRAVE_CALLS", dflt: 6000 },
  { name: "openai", match: "api.openai.com", env: "HARDCAP_OPENAI_CALLS", dflt: 6000 },
  { name: "e2b", match: null, env: "HARDCAP_E2B_SANDBOXES", dflt: 1500 },
];

const SYNC_MS = () => Math.max(1_000, Number(process.env.HARDCAP_SYNC_MS) || 5_000);
const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** The day's ceiling: a number, 0 (refuse all) or null (disabled). */
export function hardCapOf(c, env = process.env) {
  const raw = String(env[c.env] ?? "").trim().toLowerCase();
  if (raw === "off") return null;
  if (raw === "") return c.dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : c.dflt;
}

const state = new Map(); // name -> { day, local, unflushed, shared, refused, released, store }
function rowOf(c, now = Date.now()) {
  let s = state.get(c.name);
  const d = utcDay(now);
  if (!s) { s = { day: d, local: 0, unflushed: 0, shared: null, refused: 0, released: 0, store: createSharedDailySpend(`hardcap-${c.name}`, "upstream-hard-caps", { scale: 1 }) }; state.set(c.name, s); }
  if (s.day !== d) { s.day = d; s.local = 0; s.unflushed = 0; s.shared = null; s.refused = 0; s.released = 0; }
  return s;
}

const byName = new Map(HARD_CAPS.map((c) => [c.name, c]));
const hostCache = new Map(); // host -> cap entry or null
const HOST_CACHE_MAX = 4000;
function capForHost(host) {
  if (hostCache.has(host)) return hostCache.get(host);
  const c = HARD_CAPS.find((x) => x.match && (host === x.match || host.endsWith("." + x.match))) || null;
  if (hostCache.size < HOST_CACHE_MAX) hostCache.set(host, c);
  return c;
}

function seenToday(s) { return Math.max(0, s.local, (s.shared ?? 0) + s.unflushed); }

/**
 * Take one unit of `name`'s ceiling. Returns true when the call may go ahead
 * (and counts it), false when the ceiling is reached (and counts a refusal).
 * Synchronous: no store round trip on the caller's path.
 */
export function takeHardCap(name, now = Date.now()) {
  const c = byName.get(name);
  if (!c) return true;
  const cap = hardCapOf(c);
  if (cap === null) return true;
  const s = rowOf(c, now);
  if (seenToday(s) >= cap) { s.refused++; return false; }
  s.local++; s.unflushed++;
  return true;
}

// Failures that happen before a request is written: name resolution, and a
// connection that was refused, unroutable or never opened. A reset, a body
// timeout or a closed socket is not here: the request may have been read.
const NEVER_SENT_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "EAI_NODATA", "EAI_NONAME",
  "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);
/**
 * True only when `err` shows the call never left this process. Reads the
 * error and up to four causes (fetch wraps the socket error as `cause`).
 * `abortedAtCall`: the caller's signal was already aborted when the call was made.
 */
export function neverReachedUpstream(err, { abortedAtCall = false } = {}) {
  if (abortedAtCall) return true;
  let e = err;
  for (let i = 0; i < 5 && e && typeof e === "object"; i++) {
    if (typeof e.code === "string" && NEVER_SENT_CODES.has(e.code)) return true;
    // A happy-eyeballs failure carries one error per address tried.
    if (Array.isArray(e.errors) && e.errors.length && e.errors.every((x) => typeof x?.code === "string" && NEVER_SENT_CODES.has(x.code))) return true;
    e = e.cause;
  }
  return false;
}

/**
 * Give back the unit a call took at `takenAt`, for a call that never reached
 * the upstream. A unit taken on an earlier UTC day is not given back to today.
 */
export function releaseHardCap(name, takenAt = Date.now(), now = Date.now()) {
  const c = byName.get(name);
  if (!c || hardCapOf(c) === null) return false;
  const s = rowOf(c, now);
  if (utcDay(takenAt) !== s.day || s.local <= 0) return false;
  // unflushed may pass below zero when the unit was already flushed: the next
  // sync books the difference to the shared counter.
  s.local--; s.unflushed--; s.released++;
  return true;
}

/** The capped upstream a host belongs to, or null. */
export function hardCapNameForHost(host) {
  try { return host ? (capForHost(String(host).toLowerCase())?.name ?? null) : null; } catch { return null; }
}

/** The fetch hook's check: null when the host is not capped or the call may go ahead. */
export function hardCapRefusalForHost(host, now = Date.now()) {
  try {
    if (!host) return null;
    const c = capForHost(String(host).toLowerCase());
    if (!c) return null;
    return takeHardCap(c.name, now) ? null : hardCapError();
  } catch { return null; } // the guard must never break a call it cannot read
}

export function hardCapError() {
  const e = new Error("This tool's upstream has reached today's usage limit - retry after 00:00 UTC. This call is not charged on x402.");
  e.statusCode = 503;
  e.hardCap = true;
  return e;
}

/** Flush local increments to the shared counter and read the day's total back. */
export async function syncHardCaps(now = Date.now()) {
  for (const c of HARD_CAPS) {
    const s = rowOf(c, now);
    if (!s.store.enabled) continue;
    const n = s.unflushed;
    if (n) { s.unflushed = 0; s.store.book(n, now); }
    try {
      const v = await s.store.today(now);
      // A read that predates the flush landing undercounts; the shared total
      // only grows within a day, so never step it back.
      if (v !== null) s.shared = Math.max(v, s.shared ?? 0);
    } catch { /* keep the last reading */ }
  }
}

let timer = null;
export function startHardCapSync() {
  if (timer) return;
  timer = setInterval(() => { void syncHardCaps().catch(() => {}); }, SYNC_MS());
  timer.unref?.();
}

/** Counts only, for the operator view. */
export function hardCapStatus(now = Date.now()) {
  const rows = {};
  let worst = "ok";
  for (const c of HARD_CAPS) {
    const s = rowOf(c, now);
    const cap = hardCapOf(c);
    // From the day's total, not this process's own refusals: with two
    // replicas each answering the status in turn, a per-process refusal count
    // made the word (and the heartbeat issue) flip on every read.
    const status = cap === null ? "disabled" : (seenToday(s) >= cap ? "capped" : "ok");
    if (status === "capped") worst = "capped";
    rows[c.name] = { usedToday: seenToday(s), ceiling: cap, refusedToday: s.refused, releasedToday: s.released, status, shared: s.store.enabled };
  }
  return { day: utcDay(now), status: worst, upstreams: rows };
}

/** Test seam. */
export function _resetHardCaps() { state.clear(); hostCache.clear(); }
