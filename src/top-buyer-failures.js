// Failures our top paying buyers get, known within minutes.
//
// WHY: our largest outside buyer took nine 502s in five minutes on one tool,
// retried, and left; nothing read the failures per buyer, so nobody knew for
// hours. The failure monitor counts by tool and the sales ledger records only
// settled sales, so a buyer whose verified, paid calls fail was in neither.
//
// What is recorded: every paid request that passed its gate (x402 on every
// rail, the MPP shim, Tempo) and reached our dispatcher, whose final
// answer was not a 2xx, under the payer that gate proved (server.js reads it:
// the signed EVM `from`, the Solana, Algorand or Stellar signer of the signed
// transaction, the Tempo sender the gate proved). Credits and card payments
// name no payer in the sales ledger, so they cannot rank and are not
// recorded. An unpaid
// 402 challenge and a refusal before the gate never reach here. Each failure
// keeps the slug, the status, the time and the first 160 characters of the
// error text we sent (scrubbed), in this process (bounded) and, when the
// shared store is Redis, in a per-payer window there, so every container
// reads every container's failures. A payer with nothing inside the window
// plus the hold is swept from this process on the refresh timer.
//
// The word (topBuyerFailures on /api/gateway-status): alert while any of the
// top outside payers by paid spend over the last TOP_BUYERS_DAYS has
// TOP_BUYER_FAIL_MIN or more failures inside TOP_BUYER_FAIL_WINDOW_MS, held
// TOP_BUYER_FAIL_HOLD_MS after the failure that met the rule so a pager on a
// 5- or 15-minute schedule reads it; ok otherwise; unknown before the first
// read of the top payers; off in FREE_MODE. The top payers are read from the
// sales ledger on a timer, never on a request's path. Publicly the word only;
// the operator view names each alerting payer by its first characters, its
// spend rank, and the failures (slug, status, time, our error text).
//
// onchainSqlBusy (also on /api/gateway-status): alert while a watched payer
// got onchain-sql's busy refusal (the server-wide in-flight query cap,
// src/tools/cdp-kit.js: a 429, never charged) inside TOP_BUYER_FAIL_HOLD_MS;
// one refusal is enough, since a top payer sends one query at a time. The
// refusal is kept as one of the payer's failures with its kind ("sql-busy"),
// so it is read from the same per-payer window. ok otherwise; unknown before
// the first read of the top payers; off in FREE_MODE. Publicly the word only;
// the operator view names each alerting payer by its first characters, its
// spend rank and the refusal times.
//
// An alarm only: nothing here refuses, slows or changes a call.
import { shared, sharedLimitsEnabled } from "./shared-limits.js";
import { shortPayer } from "./verify-failure-log.js";
import { redactSecrets } from "./tools/redact.js";

const NAME = "top-buyer-fail";
const intEnv = (v, def, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= lo && n <= hi ? n : def;
};
/** Failures inside the window that raise the word (TOP_BUYER_FAIL_MIN, default 3). */
export const failMin = (env = process.env) => intEnv(env.TOP_BUYER_FAIL_MIN, 3, 1, 1000);
/** The window those failures fall in (TOP_BUYER_FAIL_WINDOW_MS, default 10 minutes). */
export const failWindowMs = (env = process.env) => intEnv(env.TOP_BUYER_FAIL_WINDOW_MS, 600_000, 1_000, 6 * 3_600_000);
/** How long alert holds after the failure that met the rule (TOP_BUYER_FAIL_HOLD_MS, default 20 minutes). */
export const failHoldMs = (env = process.env) => intEnv(env.TOP_BUYER_FAIL_HOLD_MS, 1_200_000, 0, 6 * 3_600_000);
/** How many top payers are watched (TOP_BUYERS_COUNT, default 10). */
export const topCount = (env = process.env) => intEnv(env.TOP_BUYERS_COUNT, 10, 1, 100);
/** The spend window the top payers are ranked over, in days (TOP_BUYERS_DAYS, default 7). */
export const topDays = (env = process.env) => intEnv(env.TOP_BUYERS_DAYS, 7, 1, 90);
/** How often the top payers are read again (TOP_BUYERS_REFRESH_MS, default 5 minutes). */
export const topRefreshMs = (env = process.env) => intEnv(env.TOP_BUYERS_REFRESH_MS, 300_000, 1_000, 24 * 3_600_000);

const ERROR_CHARS = 160;
const MAX_PAYERS = 2_000;   // payers held in this process; the oldest written is dropped past it
const MAX_EVENTS = 50;      // failures held per payer
const SHOWN_EVENTS = 20;    // failures the operator view lists per payer
const STATUS_CACHE_MS = 5_000;
const PROC = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let seq = 0;

const local = new Map(); // payer -> [{ id, at, slug, status, error }], oldest first
const pending = new Set();
let top = null; // { payers: [payer, ...] in rank order, at }
let sharedCache = { at: 0, key: "", byPayer: null };
let counts = { recorded: 0, sharedWrites: 0, sharedWriteFailures: 0, sharedReadFailures: 0 };

const sharedKey = (payer) => String(payer).replace(/\s/g, "_");
const keepSpan = (env) => failWindowMs(env) + failHoldMs(env);

/** The first ERROR_CHARS characters of the error text a failing answer carried, scrubbed. */
export function errorTextOf(body) {
  let t = null;
  try {
    if (typeof body === "string") t = body;
    else if (body && typeof body === "object") {
      const e = body.error;
      t = typeof e === "string" ? e : (e && typeof e.message === "string" ? e.message : (typeof body.message === "string" ? body.message : (typeof body.detail === "string" ? body.detail : null)));
    }
  } catch { t = null; }
  if (typeof t !== "string" || !t) return null;
  let s = "";
  try { s = String(redactSecrets(t.slice(0, 4 * ERROR_CHARS)) ?? ""); } catch { return null; }
  let out = "";
  for (let i = 0; i < s.length && out.length < ERROR_CHARS; i++) {
    const c = s.charCodeAt(i);
    out += c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029 ? " " : s[i];
  }
  return out || null;
}

/** The kind a busy refusal of onchain-sql is kept under (onchainSqlBusy). */
export const SQL_BUSY_KIND = "sql-busy";
const okKind = (k) => (k === SQL_BUSY_KIND ? k : null);
const okPayer = (p) => typeof p === "string" && p.length >= 1 && p.length <= 160;
// The caller's own input refused (a malformed body, a missing resource, a
// conflict, a body too large or of the wrong type, a value out of range):
// never settled, and a looping client of the payer's could page us with it.
// One of these statuses is the caller's only when the answer attributes it to
// the caller or to no one: a 422 attributed to a third party refusing our
// access (upstream-access, src/tools/fetch-guard.js), to an upstream, to us
// or to an unknown side is a failed answer and is kept.
export const CALLER_INPUT_STATUSES = Object.freeze([400, 404, 409, 413, 415, 422]);
const CALLER_INPUT = new Set(CALLER_INPUT_STATUSES);
const ATTRIBUTION_RE = /^[a-z][a-z-]{0,23}$/;
const isFailure = (status, attribution = null) => !(Number.isInteger(status) && status >= 200 && status < 300)
  && !(CALLER_INPUT.has(status) && (attribution == null || attribution === "caller"));
/** The attribution field of a JSON error answer (src/tool-error-fields.js),
 *  or null. */
export function attributionTextOf(body) {
  try {
    const a = body && typeof body === "object" ? (typeof body.attribution === "string" ? body.attribution : (body.error && typeof body.error === "object" && typeof body.error.attribution === "string" ? body.error.attribution : null)) : null;
    return a && ATTRIBUTION_RE.test(a) ? a : null;
  } catch { return null; }
}

/**
 * Records one final answer to a verified paid request. Only a non-2xx that
 * is not the caller's own input refused (CALLER_INPUT_STATUSES attributed to
 * the caller or to no one) is kept; a 2xx costs one comparison. Never
 * throws, never awaits on the caller.
 */
export function noteVerifiedPaidOutcome({ payer, slug, status, error = null, attribution = null, kind = null, at = Date.now() } = {}, env = process.env) {
  try {
    if (!isFailure(status, typeof attribution === "string" ? attribution : null) || !okPayer(payer)) return false;
    const ev = { id: `${PROC}-${++seq}`, at: Number(at) || Date.now(), slug: String(slug || "unknown").slice(0, 80), status: Number.isInteger(status) ? status : 0, error: typeof error === "string" ? error.slice(0, ERROR_CHARS) : null, kind: okKind(kind) };
    const cutoff = ev.at - keepSpan(env);
    let list = local.get(payer);
    if (list) local.delete(payer); // re-insert: Map order is the eviction order
    list = (list || []).filter((e) => e.at > cutoff);
    list.push(ev);
    while (list.length > MAX_EVENTS) list.shift();
    local.set(payer, list);
    while (local.size > MAX_PAYERS) local.delete(local.keys().next().value);
    counts.recorded++;
    if (sharedLimitsEnabled()) {
      const p = shared.windowAdd(NAME, sharedKey(payer), { windowMs: keepSpan(env), member: JSON.stringify({ i: ev.id, s: ev.slug, c: ev.status, e: ev.error, ...(ev.kind ? { k: ev.kind } : {}) }), now: ev.at, score: ev.at })
        .then((r) => { if (r?.ok) counts.sharedWrites++; else counts.sharedWriteFailures++; }, () => { counts.sharedWriteFailures++; })
        .finally(() => pending.delete(p));
      pending.add(p);
    }
    return true;
  } catch { return false; }
}

/** Drops every payer whose newest kept failure is older than the window
 *  plus the hold (nothing it holds can raise the word again). Run on the
 *  refresh timer, so an idle payer's list never outlives its use. */
export function sweepIdleTopBuyerFailures(now = Date.now(), env = process.env) {
  const cutoff = now - keepSpan(env);
  let dropped = 0;
  for (const [payer, list] of local) {
    if (!list.length || list[list.length - 1].at <= cutoff) { local.delete(payer); dropped++; }
  }
  return dropped;
}

/** Sets the watched payers, highest spend first (the refresh does this). */
export function setTopBuyers(payers, at = Date.now()) {
  const list = [];
  for (const p of Array.isArray(payers) ? payers : []) if (okPayer(p) && !list.includes(p)) list.push(p);
  top = { payers: list, at };
  sharedCache = { at: 0, key: "", byPayer: null };
}
/** Whether a payer is one of the watched top payers now (exact match: an address is never case-folded). */
export function isWatchedTopBuyer(payer) { return !!top && okPayer(payer) && top.payers.includes(payer); }
/** The watched payers (test and operator seam). */
export function topBuyers() { return top ? { payers: [...top.payers], at: top.at } : null; }

/**
 * Reads the top payers once: `read` resolves [{ payer }] highest first (the
 * sales ledger's topExternalPayersAsync); `isOwn` drops any wallet of ours a
 * row still names. A failed read keeps the last list.
 */
export async function refreshTopBuyers({ read, isOwn = () => false, env = process.env, now = Date.now } = {}) {
  const rows = await read({ days: topDays(env), limit: topCount(env) + 20 });
  const payers = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const p = r?.payer;
    if (!okPayer(p)) continue;
    let own = false;
    try { own = !!isOwn(p); } catch { own = false; }
    if (!own) payers.push(p);
    if (payers.length >= topCount(env)) break;
  }
  setTopBuyers(payers, now());
  return payers;
}

let timer = null, warned = 0;
/** Reads the top payers now (after `firstMs`) and every TOP_BUYERS_REFRESH_MS, off the request path. */
export function startTopBuyerRefresh({ read, isOwn, firstMs = 5_000, env = process.env, log = console } = {}) {
  if (timer) return;
  const tick = async () => {
    try { sweepIdleTopBuyerFailures(Date.now(), env); } catch { /* bookkeeping only */ }
    try { await refreshTopBuyers({ read, isOwn, env }); }
    catch (e) {
      const t = Date.now();
      if (t - warned > 3_600_000) { warned = t; try { log.warn(`[top-buyers] read failed (${String(e?.message || e).slice(0, 120)}); keeping the last list`); } catch { /* logging only */ } }
    }
  };
  const first = setTimeout(() => {
    void tick();
    timer = setInterval(() => { void tick(); }, topRefreshMs(env));
    timer.unref?.();
  }, Math.max(0, firstMs));
  first.unref?.();
  timer = first;
}

function parseMember(m) {
  try {
    const o = JSON.parse(m);
    if (!o || typeof o !== "object" || typeof o.i !== "string") return null;
    return { id: o.i, slug: typeof o.s === "string" ? o.s.slice(0, 80) : "unknown", status: Number.isInteger(o.c) ? o.c : 0, error: typeof o.e === "string" ? o.e.slice(0, ERROR_CHARS) : null, kind: okKind(o.k) };
  } catch { return null; }
}

// The shared windows of the watched payers: one round trip, reused a few
// seconds. null when the store is memory or did not answer.
async function sharedEvents(payers, now, env) {
  if (!sharedLimitsEnabled() || !payers.length) return null;
  const key = payers.join("\n");
  // A read (or a failed one) is reused a few seconds, so a store that does
  // not answer costs one bounded wait per few seconds, not one per status read.
  if (sharedCache.key === key && now - sharedCache.at >= 0 && now - sharedCache.at < STATUS_CACHE_MS) return sharedCache.byPayer;
  const r = await shared.windowReadMany(payers.map((p) => ({ name: NAME, key: sharedKey(p), windowMs: keepSpan(env) })), { now });
  if (!r?.ok) { counts.sharedReadFailures++; sharedCache = { at: now, key, byPayer: null }; return null; }
  const byPayer = new Map();
  payers.forEach((p, i) => {
    const entries = r.results?.[i]?.entries || [];
    const list = [];
    for (const e of entries) { const ev = parseMember(e.member); if (ev) list.push({ ...ev, at: Number(e.score) || 0 }); }
    byPayer.set(p, list);
  });
  sharedCache = { at: now, key, byPayer };
  return byPayer;
}

// The time of the newest failure that met the rule (MIN failures inside the
// window ending at it), or 0.
function lastTrigger(events, min, windowMs) {
  let last = 0;
  for (let i = 0, lo = 0; i < events.length; i++) {
    while (events[i].at - events[lo].at >= windowMs) lo++;
    if (i - lo + 1 >= min) last = events[i].at;
  }
  return last;
}

/**
 * topBuyerFailures for /api/gateway-status. Public: { status } only.
 * Operator (`full`): the rule, and per alerting payer its short id, its spend
 * rank and its failures (slug, status, time, our error text). Never a full
 * address, never a spend figure. Never rejects.
 */
export async function topBuyerFailuresStatus({ full = false, now = Date.now(), off = false, env = process.env } = {}) {
  try {
    if (off) return { status: "off" };
    if (!top) return { status: "unknown" };
    const min = failMin(env), windowMs = failWindowMs(env), holdMs = failHoldMs(env);
    const cutoff = now - windowMs - holdMs;
    let fromShared = null, sharedRead = sharedLimitsEnabled() ? "unread" : "memory";
    try { fromShared = await sharedEvents(top.payers, now, env); if (fromShared) sharedRead = "on"; } catch { fromShared = null; }
    const alerting = [];
    top.payers.forEach((payer, i) => {
      const seen = new Map();
      for (const e of [...(local.get(payer) || []), ...(fromShared?.get(payer) || [])]) if (e.at > cutoff && e.at <= now && !seen.has(e.id)) seen.set(e.id, e);
      if (seen.size < min) return;
      const events = [...seen.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
      const t = lastTrigger(events, min, windowMs);
      if (!t || now - t > holdMs) return;
      alerting.push({ payer, rank: i + 1, events });
    });
    const status = alerting.length ? "alert" : "ok";
    if (!full) return { status };
    return {
      status,
      rule: { failures: min, windowMinutes: windowMs / 60_000, holdMinutes: holdMs / 60_000, topBuyers: topCount(env), days: topDays(env) },
      watched: top.payers.length,
      topReadAt: top.at ? new Date(top.at).toISOString() : null,
      sharedStore: sharedRead,
      alerting: alerting.map((a) => ({
        payer: shortPayer(a.payer),
        rank: a.rank,
        failures: a.events.slice(-SHOWN_EVENTS).map((e) => ({ at: new Date(e.at).toISOString(), slug: e.slug, status: e.status, error: e.error })),
      })),
      recorded: counts.recorded,
      sharedWriteFailures: counts.sharedWriteFailures,
      sharedReadFailures: counts.sharedReadFailures,
    };
  } catch { return { status: "unknown" }; }
}

/**
 * onchainSqlBusy for /api/gateway-status. alert while a watched payer has a
 * busy refusal of onchain-sql inside TOP_BUYER_FAIL_HOLD_MS (one is enough);
 * ok otherwise; unknown before the first read of the top payers; off in
 * FREE_MODE. Public: { status } only. Operator (`full`): the rule and, per
 * alerting payer, its short id, its spend rank and the refusal times. Never
 * a full address, never a spend figure. Never rejects.
 */
export async function onchainSqlBusyStatus({ full = false, now = Date.now(), off = false, env = process.env } = {}) {
  try {
    if (off) return { status: "off" };
    if (!top) return { status: "unknown" };
    const holdMs = failHoldMs(env);
    const cutoff = now - holdMs;
    let fromShared = null, sharedRead = sharedLimitsEnabled() ? "unread" : "memory";
    try { fromShared = await sharedEvents(top.payers, now, env); if (fromShared) sharedRead = "on"; } catch { fromShared = null; }
    const alerting = [];
    top.payers.forEach((payer, i) => {
      const seen = new Map();
      for (const e of [...(local.get(payer) || []), ...(fromShared?.get(payer) || [])]) if (e.kind === SQL_BUSY_KIND && e.at >= cutoff && e.at <= now && !seen.has(e.id)) seen.set(e.id, e);
      if (!seen.size) return;
      alerting.push({ payer, rank: i + 1, events: [...seen.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)) });
    });
    const status = alerting.length ? "alert" : "ok";
    if (!full) return { status };
    return {
      status,
      rule: { refusals: 1, holdMinutes: holdMs / 60_000, topBuyers: topCount(env), days: topDays(env) },
      watched: top.payers.length,
      topReadAt: top.at ? new Date(top.at).toISOString() : null,
      sharedStore: sharedRead,
      alerting: alerting.map((a) => ({ payer: shortPayer(a.payer), rank: a.rank, refusals: a.events.slice(-SHOWN_EVENTS).map((e) => ({ at: new Date(e.at).toISOString(), slug: e.slug, status: e.status })) })),
    };
  } catch { return { status: "unknown" }; }
}

/** Test seams. */
export async function _flushTopBuyerWrites() { while (pending.size) await Promise.allSettled([...pending]); }
export function _resetTopBuyerFailures() {
  local.clear(); top = null; sharedCache = { at: 0, key: "", byPayer: null };
  counts = { recorded: 0, sharedWrites: 0, sharedWriteFailures: 0, sharedReadFailures: 0 };
  if (timer) { clearTimeout(timer); clearInterval(timer); timer = null; }
}
export function _localSizes() { let events = 0; for (const l of local.values()) events += l.length; return { payers: local.size, events }; }
