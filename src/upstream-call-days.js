// Which module made the calls, per UTC day, for the metered upstreams the
// operator asks that of.
//
// The egress meter (src/egress-meter.js) counts calls per host in memory and
// names up to four callers per host with no counts, and both reset on every
// deploy. That answers "who talks to this host" and not "who made most of
// today's calls", which is the question when a daily budget is passed. This
// keeps, per UTC day and upstream, the total and a count per caller, for the
// last KEEP_DAYS days.
//
// A caller is the label the calling module set for its own fetch
// (`egressCaller`, a synchronous scope around the call, used by the Solana
// history reader so its counts name the reader's own caller), or else the
// first file of ours on the stack (the meter's own rule, `callerOf`).
//
// Counts only: never a URL, a path, a key, an address or a payer.
//
// Stored as one state document (src/json-document.js): the state database
// when one is configured (shared across replicas, kept across deploys), a
// file otherwise. Each process counts in memory synchronously and folds its
// increments into the document with update() on a timer and at shutdown, so
// no call waits on the store. A failed write keeps the increments for the
// next flush.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonDocument } from "./json-document.js";

export const UPSTREAM_CALL_DAYS_DOC = "upstream-call-days";
/** UTC days kept, today included: a week of history beside today. */
export const KEEP_DAYS = 8;
/** Callers kept per upstream and day; the smallest fold into "other". */
export const MAX_CALLERS = 40;
/** The upstreams counted by caller (names from src/upstream-hard-caps.js). */
export const CALLER_COUNTED = new Set(["alchemy"]);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
const flushMs = () => Math.max(1_000, Number(process.env.UPSTREAM_CALL_DAYS_FLUSH_MS) || 60_000);

let doc = null;
const docOf = () => (doc ||= createJsonDocument({ name: UPSTREAM_CALL_DAYS_DOC, file: process.env.UPSTREAM_CALL_DAYS_FILE || join(existsSync("/data") ? "/data" : tmpdir(), "upstream-call-days.json"), log: () => {} }));
const bodyOf = (b) => (b && typeof b === "object" && b.days && typeof b.days === "object" ? b : { days: {} });

let pending = {};   // day -> upstream -> { total, callers: { label: n } }
let timer = null;
let flushing = null;
let failures = 0;
let label = null;   // the caller label in scope for a fetch being made now

/**
 * Run `fn` (which makes its fetch call synchronously) with `name` as the
 * caller the meter counts that call under. The label covers only the
 * synchronous part of `fn`, which is where the call is made.
 */
export function egressCaller(name, fn) {
  const prev = label;
  label = typeof name === "string" && name ? name.slice(0, 60) : null;
  try { return fn(); } finally { label = prev; }
}
/** The label in scope, or null (the meter then reads the stack). */
export function egressCallerLabel() { return label; }

/** Count one call. Synchronous; never throws. */
export function noteUpstreamCall(upstream, caller, now = Date.now()) {
  try {
    if (!CALLER_COUNTED.has(upstream)) return false;
    const d = utcDay(now);
    const row = ((pending[d] ||= {})[upstream] ||= { total: 0, callers: {} });
    row.total++;
    const k = String(caller || "?").slice(0, 60);
    row.callers[k] = (row.callers[k] || 0) + 1;
    if (!timer) { timer = setInterval(() => { flushUpstreamCallDays().catch(() => {}); }, flushMs()); timer.unref?.(); }
    return true;
  } catch { failures++; return false; }
}

function foldCallers(callers) {
  const rows = Object.entries(callers).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (rows.length <= MAX_CALLERS) return Object.fromEntries(rows);
  const keep = rows.filter(([k]) => k !== "other").slice(0, MAX_CALLERS - 1);
  const kept = new Set(keep.map(([k]) => k));
  const other = rows.reduce((a, [k, n]) => a + (kept.has(k) ? 0 : n), 0);
  return { ...Object.fromEntries(keep), other };
}
function mergeInto(days, add) {
  for (const [d, ups] of Object.entries(add || {})) {
    if (!DAY_RE.test(d) || !ups || typeof ups !== "object") continue;
    const day = (days[d] && typeof days[d] === "object") ? days[d] : (days[d] = {});
    for (const [u, row] of Object.entries(ups)) {
      const into = (day[u] && typeof day[u] === "object") ? day[u] : (day[u] = { total: 0, callers: {} });
      into.total = num(into.total) + num(row?.total);
      const callers = { ...(into.callers && typeof into.callers === "object" ? into.callers : {}) };
      for (const [k, n] of Object.entries(row?.callers || {})) callers[k] = num(callers[k]) + num(n);
      into.callers = foldCallers(callers);
    }
  }
  return days;
}
function prune(days, now = Date.now()) {
  const cutoff = utcDay(now - (KEEP_DAYS - 1) * 86_400_000);
  for (const d of Object.keys(days)) if (!DAY_RE.test(d) || d < cutoff) delete days[d];
  return days;
}

/** Fold the pending increments into the document. Never throws. */
export async function flushUpstreamCallDays({ now = Date.now() } = {}) {
  if (flushing) return flushing;
  const batch = pending;
  if (!Object.keys(batch).length) return { ok: true, flushed: false };
  pending = {};
  const keepBatch = () => { pending = prune(mergeInto(pending, batch), now); failures++; return { ok: false }; };
  flushing = (async () => {
    try {
      const r = await docOf().update((b) => ({ ...bodyOf(b), days: prune(mergeInto(mergeInto({}, bodyOf(b).days), batch), now) }), { fallback: null });
      if (r?.ok) { cached = null; return { ok: true, flushed: true }; }
      return keepBatch();
    } catch { return keepBatch(); } finally { flushing = null; }
  })();
  return flushing;
}

let cached = null; // { at, days }
const READ_REUSE_MS = 30_000;
/**
 * The last `days` UTC days before today and today, newest first, for one
 * upstream: stored counts plus what this process has not written yet.
 * `{ stored: false }` on a row when the document could not be read (this
 * process's own counts alone). Operator view only.
 */
export async function upstreamCallDaysReport(upstream = "alchemy", { days = 7, now = Date.now() } = {}) {
  let stored = null;
  if (cached && now - cached.at < READ_REUSE_MS && now >= cached.at) stored = cached.days;
  else {
    try {
      const r = await docOf().read({ quiet: true });
      if (r?.ok) { stored = bodyOf(r.exists ? r.body : null).days; cached = { at: now, days: stored }; }
    } catch { /* this process's counts alone */ }
  }
  const all = mergeInto(mergeInto({}, stored || {}), pending);
  const out = [];
  for (let i = 0; i <= days; i++) {
    const d = utcDay(now - i * 86_400_000);
    const row = all[d]?.[upstream];
    out.push({ day: d, calls: num(row?.total), callers: foldCallers(row?.callers || {}) });
  }
  return { upstream, stored: stored !== null, keepDays: KEEP_DAYS, failures, days: out };
}

/** Test seam. */
export function __resetUpstreamCallDaysForTest() {
  pending = {}; cached = null; doc = null; failures = 0; label = null; flushing = null;
  if (timer) { clearInterval(timer); timer = null; }
}
