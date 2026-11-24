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
// WHAT A UNIT IS: a call the upstream may have served. The unit is taken
// before the call (so a burst cannot pass the ceiling while calls are in
// flight) and given back when the call provably never left this process (the
// name did not resolve, the connection was refused or never opened, or the
// caller's signal was already aborted when the call was made:
// neverReachedUpstream), or when the upstream refused it before doing any work
// (a 4xx answer: bad request, our key refused, rate limited; also an SDK's
// named busy refusal that is documented as changing nothing:
// upstreamRefusedBeforeWork). Everything else keeps its unit: a 2xx or 3xx
// answer, a 5xx, a timeout or a reset after the request was written may all
// have been served and metered there. Giving a unit back only ever lowers the
// day's count, so this never refuses a call the old count would have let by.
//
// THE 4xx GIVE-BACKS ARE BOUNDED (releaseHardCapRefused): a caller (the
// dispatch's caller key, src/dispatch-caller.js) gives back at most
// HARDCAP_REFUSED_RELEASES_PER_CALLER_HOUR units an hour per upstream, and an
// upstream at most HARDCAP_REFUSED_RELEASES_PER_HOUR across callers; past
// either, the refused call keeps its unit. So inputs an upstream refuses
// cannot make calls the ceiling never counts. A call that never left this
// process is given back whatever the bounds.
//
// A ceiling of `0` refuses every call; `off` disables one. A malformed value
// falls back to the default, never to disabled.

import { createSharedDailySpend } from "./shared-limits.js";
import { useHeldUnit } from "./settle-first.js";
import { notChargedHere } from "./not-charged.js";

// `match` is a host suffix the fetch hook checks; null means the kit counts
// its own units (one unit per network a multichain read asks for).
export const HARD_CAPS = [
  { name: "alchemy", match: "alchemy.com", env: "HARDCAP_ALCHEMY_CALLS", dflt: 300000 },
  { name: "brave", match: "api.search.brave.com", env: "HARDCAP_BRAVE_CALLS", dflt: 6000 },
  { name: "openai", match: "api.openai.com", env: "HARDCAP_OPENAI_CALLS", dflt: 6000 },
  // Network reads by the Alchemy multichain transfers read (alchemy-data-kit.js
  // wallet-transfers-multichain): one unit per network a call asks for.
  { name: "alchemy-multichain", match: null, env: "HARDCAP_ALCHEMY_MULTICHAIN_NETWORKS", dflt: 30000 },
];

// BOUNDED SHARES. An internal reader of a capped upstream that must never
// spend the ceiling paid tools need gets a daily budget of its own under it:
// `cover-reads`, the balance reads behind the in-flight coverage check
// (src/inflight-cover.js), counted only for a read whose RPC list reaches the
// ceiling's host. Default: `fraction` of the ceiling; a set value is held to
// at most half of it (the ceiling off: the set value, or no budget). A unit is
// taken before the read, from the same day's count shared across replicas as
// the ceilings are; past the budget the caller makes no read (the coverage
// check then judges as when reads are down). The ceiling itself still counts
// every call that reaches the host, these included.
//
// `history-background`: the keyed fallback of the Solana history reads nobody
// is waiting on (the activity scans and the Solana board;
// src/solana-history-rpc.js). Those reads go to the public lane first; past
// this budget the keyed lane is not tried for them, and the views serve what
// they hold with its age.
export const HARD_CAP_SHARES = [
  { name: "cover-reads", of: "alchemy", env: "INFLIGHT_COVER_READS_DAILY_MAX", fraction: 0.2 },
  { name: "history-background", of: "alchemy", env: "SOLANA_HISTORY_BACKGROUND_KEYED_DAILY_MAX", fraction: 0.05 },
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
  if (!s) { s = { day: d, local: 0, unflushed: 0, shared: null, refused: 0, released: 0, refusedKept: 0, store: createSharedDailySpend(`hardcap-${c.name}`, "upstream-hard-caps", { scale: 1 }) }; state.set(c.name, s); }
  if (s.day !== d) { s.day = d; s.local = 0; s.unflushed = 0; s.shared = null; s.refused = 0; s.released = 0; s.refusedKept = 0; }
  return s;
}

const byName = new Map(HARD_CAPS.map((c) => [c.name, c]));
const shareByName = new Map(HARD_CAP_SHARES.map((c) => [c.name, c]));

/** A share's daily budget: a number (0 makes no read), or null (no budget). */
export function hardCapShareOf(sh, env = process.env) {
  const ceiling = hardCapOf(byName.get(sh.of), env);
  const raw = String(env[sh.env] ?? "").trim();
  const n = raw === "" ? NaN : Number(raw);
  const own = Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  if (ceiling === null) return own;
  return own === null ? Math.floor(ceiling * sh.fraction) : Math.min(own, Math.floor(ceiling / 2));
}

/**
 * Take one unit of share `name` for a call that reaches the capped upstream
 * `capName` (null or another upstream: nothing to take, true). False when the
 * day's share is spent (counted as a refusal). Synchronous.
 */
export function takeHardCapShare(name, capName, now = Date.now()) {
  const sh = shareByName.get(name);
  if (!sh || !capName || sh.of !== capName) return true;
  const budget = hardCapShareOf(sh);
  if (budget === null) return true;
  const s = rowOf(sh, now);
  if (seenToday(s) >= budget) { s.refused++; return false; }
  s.local++; s.unflushed++;
  return true;
}

/** Give back a share unit taken at `takenAt` for a call that was not made. */
export function releaseHardCapShare(name, capName, takenAt = Date.now(), now = Date.now()) {
  const sh = shareByName.get(name);
  if (!sh || !capName || sh.of !== capName || hardCapShareOf(sh) === null) return false;
  const s = rowOf(sh, now);
  if (utcDay(takenAt) !== s.day || s.local <= 0) return false;
  s.local--; s.unflushed--; s.released++;
  return true;
}

/** Counts only, for the operator view: each share's day. */
export function hardCapShareStatus(now = Date.now()) {
  const rows = {};
  for (const sh of HARD_CAP_SHARES) {
    const s = rowOf(sh, now);
    const budget = hardCapShareOf(sh);
    rows[sh.name] = { of: sh.of, usedToday: seenToday(s), budget, refusedToday: s.refused, releasedToday: s.released, status: budget === null ? "unbounded" : seenToday(s) >= budget ? "spent" : "ok" };
  }
  return rows;
}
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
  // A unit the call's settle point already took for it (hardCapHold): used,
  // not taken again.
  if (useHeldUnit(name)) return true;
  const s = rowOf(c, now);
  if (seenToday(s) >= cap) { s.refused++; return false; }
  s.local++; s.unflushed++;
  return true;
}

/** What a settle point takes ahead of its payment (src/settle-first.js
 *  settleBeforeUpstreamHolding): one unit of `name`, given back when the
 *  payment does not settle or the unit goes unused; past the ceiling, the
 *  refusal before any payment. */
export function hardCapHold(name) {
  return { name, take: () => takeHardCap(name), release: (takenAt) => releaseHardCap(name, takenAt), refusal: hardCapError };
}

/** True when `name`'s ceiling is already reached today (nothing is taken or
 *  counted): a check made before a payment is settled ahead of the call. */
export function hardCapReached(name, now = Date.now()) {
  try {
    const c = byName.get(name);
    if (!c) return false;
    const cap = hardCapOf(c);
    if (cap === null) return false;
    return seenToday(rowOf(c, now)) >= cap;
  } catch { return false; }
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
 * True only when `x` (a fetch Response, or a thrown error and up to four
 * causes) shows the upstream refused the call before doing any work: an HTTP
 * status from 400 to 499, or an SDK's AuthenticationError (401), RateLimitError
 * (429) or ServiceBusyError (503, "nothing was changed by the refused call").
 * A 5xx in general, a 2xx or a 3xx is not: the call may have been served.
 */
const REFUSED_ERROR_NAMES = new Set(["AuthenticationError", "RateLimitError", "ServiceBusyError"]);
export function upstreamRefusedBeforeWork(x) {
  let e = x;
  for (let i = 0; i < 5 && e && typeof e === "object"; i++) {
    const status = Number(e.status ?? e.statusCode);
    if (Number.isInteger(status) && status >= 400 && status <= 499) return true;
    if (typeof e.name === "string" && REFUSED_ERROR_NAMES.has(e.name)) return true;
    e = e.cause;
  }
  return false;
}

/**
 * Give back the unit a call took at `takenAt`, for a call that never reached
 * the upstream or that the upstream refused before any work. A unit taken on an earlier UTC day is not given back to today.
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

// The hourly bounds on 4xx give-backs. A caller with no key shares one.
const REFUSED_PER_CALLER_HOUR_DEFAULT = 30;
const REFUSED_PER_HOUR_DEFAULT = 600;
const REFUSED_CALLERS_MAX = 5000;
const boundOf = (name, dflt, env = process.env) => {
  const n = Number(String(env[name] ?? "").trim() || NaN);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
};
const refusedReleases = new Map(); // cap name -> { hour, total, byCaller: Map }
/**
 * Give back the unit of a call the upstream refused before any work (a 4xx),
 * within the hourly bounds above; past them the unit is kept and counted
 * (refusedReleasesKept). `caller` is the dispatch's caller key (null: the
 * shared unkeyed caller). A caller that would be new while the hour's table
 * already holds REFUSED_CALLERS_MAX callers keeps its unit.
 */
export function releaseHardCapRefused(name, takenAt = Date.now(), { caller = null, now = Date.now() } = {}) {
  const c = byName.get(name);
  if (!c || hardCapOf(c) === null) return false;
  const hour = Math.floor(now / 3_600_000);
  let r = refusedReleases.get(name);
  if (!r || r.hour !== hour) { r = { hour, total: 0, byCaller: new Map() }; refusedReleases.set(name, r); }
  const who = typeof caller === "string" && caller ? caller.slice(0, 200) : "unkeyed";
  const mine = r.byCaller.get(who) || 0;
  const keep = () => { rowOf(c, now).refusedKept++; return false; };
  if (r.total >= boundOf("HARDCAP_REFUSED_RELEASES_PER_HOUR", REFUSED_PER_HOUR_DEFAULT)) return keep();
  if (mine >= boundOf("HARDCAP_REFUSED_RELEASES_PER_CALLER_HOUR", REFUSED_PER_CALLER_HOUR_DEFAULT)) return keep();
  if (!r.byCaller.has(who) && r.byCaller.size >= REFUSED_CALLERS_MAX) return keep();
  if (!releaseHardCap(name, takenAt, now)) return false;
  r.total++;
  r.byCaller.set(who, mine + 1);
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
  const e = new Error(`This tool's upstream has reached today's usage limit - retry after 00:00 UTC.${notChargedHere()}`);
  e.statusCode = 503;
  e.hardCap = true;
  return e;
}

/** Flush local increments to the shared counter and read the day's total back. */
export async function syncHardCaps(now = Date.now()) {
  for (const c of [...HARD_CAPS, ...HARD_CAP_SHARES]) {
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
    rows[c.name] = { usedToday: seenToday(s), ceiling: cap, refusedToday: s.refused, releasedToday: s.released, refusedReleasesKept: s.refusedKept, status, shared: s.store.enabled };
  }
  return { day: utcDay(now), status: worst, upstreams: rows };
}

/** Test seam. */
export function _resetHardCaps() { state.clear(); hostCache.clear(); refusedReleases.clear(); }
