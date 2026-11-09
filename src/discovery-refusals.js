// Who the free search routes turn away.
//
// /api/find and /api/route refuse an uncached search under several rules (the
// per-client rate, the per-client compute share, the shared compute budget,
// the in-flight bound, the compute deadline and the server-wide load gate).
// The call log stores no caller, so a month of refusals could not be read as
// a few looping scanners or as hundreds of separate agents. This counts each
// refusal per UTC day under a client key and a User-Agent family, by route and
// by the rule that refused, and marks a refused client that is later served a
// search or completes a paid or free tool call the same day.
//
// Never an address. A client is HMAC-SHA256(secret, limiterKey(address) | day)
// cut to 16 hex characters: keyed (a plain hash of an IPv4 address is found by
// trying them all), scoped to the day (one client's keys on two days do not
// match), and an IPv6 /64 is one client, as in the limiter. The secret is one
// the deployment already holds (HANGUP_FORGIVE_SALT, else POW_SECRET, else
// MPP_SECRET_KEY, the order src/hangup-forgiveness.js reads); with none set a
// per-process random key is used, so keys then last only as long as the
// process. The User-Agent is reduced to a family (uaFamilyOf): never the
// string. The address itself is held only in this process's memory, as the
// key of the map that finds a refused client again, like a limiter bucket.
//
// Bounded. Each day tracks at most MAX_CLIENTS clients; when a new one arrives
// past that, the client with the fewest refusals is folded into the day's
// `other` bucket, so every total stays exact while the per-client rows are the
// largest ones. `other.clients` counts folded clients; one that returns is
// counted again, so the distinct count is an upper bound once anything folded.
//
// Stored as one state document (src/json-document.js), like
// src/x-search-stats.js: the request path adds to memory synchronously, and a
// timer (and shutdown) folds the increments into the document with update(),
// which never drops another container's increments. KEEP_DAYS days are kept.
import { createHmac, randomBytes } from "node:crypto";
import { createJsonDocument } from "./json-document.js";
import { limiterKey } from "./rate-limit.js";

export const DISCOVERY_REFUSALS_DOC = "discovery-refusals";
export const KEEP_DAYS = 8;
export const MAX_CLIENTS = () => { const n = Number(process.env.DISCOVERY_REFUSALS_MAX_CLIENTS); return Number.isFinite(n) && n >= 1 ? Math.min(5000, Math.floor(n)) : 500; };
export const FLUSH_MS = () => Math.max(1_000, Number(process.env.DISCOVERY_REFUSALS_FLUSH_MS) || 300_000);
const MAX_UA_FAMILIES = 60;
const MAX_ADDRESSES = () => MAX_CLIENTS() * 4;
const MEMO_MAX = 20_000;
export const ROUTES = ["find", "route"];
// The rules, in the order a request meets them.
export const RULES = ["load-gate", "client-rate", "client-compute", "shared-compute", "inflight", "deadline"];
// What a refused client went on to do: bits of `ok`.
export const OK_SEARCH = 1, OK_FREE_CALL = 2, OK_PAID_CALL = 4;

const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

let processSecret = null;
function secret(env = process.env) {
  const s = String(env.HANGUP_FORGIVE_SALT || env.POW_SECRET || env.MPP_SECRET_KEY || "").trim();
  if (s) return s;
  if (!processSecret) processSecret = randomBytes(32).toString("hex");
  return processSecret;
}
/** The day-scoped keyed digest of a client address (an IPv6 /64 is one client). Never the address. */
export function clientKeyOf(address, now = Date.now()) {
  return createHmac("sha256", secret()).update(`discovery-refusal|${limiterKey(String(address ?? "?").trim())}|${utcDay(now)}`).digest("hex").slice(0, 16);
}
/**
 * A User-Agent reduced to a family: its first product token, lowercased, the
 * version dropped (after the slash, and a trailing number on the name), at
 * most 40 characters of [a-z0-9._+-]. "none" for a missing or unreadable one.
 */
export function uaFamilyOf(ua) {
  const first = String(ua ?? "").trim().split(/\s+/)[0] || "";
  const name = first.split("/")[0].toLowerCase().replace(/[^a-z0-9._+-]/g, "")
    .replace(/[-_.+]?v?\d+(?:[._]\d+)*$/, "").replace(/[-_.+]+$/, "");
  return name.slice(0, 40) || "none";
}

const zero = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
const emptyDay = () => ({
  refused: 0,
  byRoute: Object.fromEntries(ROUTES.map((r) => [r, zero(RULES)])),
  byUa: {},
  clients: {},
  other: { refused: 0, clients: 0, served: 0, succeeded: 0, paid: 0 },
});
const ruleOf = (r) => (RULES.includes(r) ? r : "load-gate");
const routeOf = (r) => (ROUTES.includes(r) ? r : "route");

/** Fold the smallest clients into `other` until at most `cap` remain. Totals are unchanged. */
export function enforceCap(day, cap = MAX_CLIENTS()) {
  const keys = Object.keys(day.clients);
  if (keys.length <= cap) return day;
  keys.sort((a, b) => (day.clients[a].r - day.clients[b].r) || (a < b ? -1 : 1));
  for (const k of keys.slice(0, keys.length - cap)) foldClient(day, k);
  return day;
}
function foldClient(day, key) {
  const c = day.clients[key];
  if (!c) return;
  day.other.refused += c.r;
  day.other.served += c.s;
  if (c.r > 0) day.other.clients++;
  if (c.ok) day.other.succeeded++;
  if (c.ok & OK_PAID_CALL) day.other.paid++;
  delete day.clients[key];
}
function bumpUa(day, family, n) {
  if (!n) return;
  const k = Object.prototype.hasOwnProperty.call(day.byUa, family) || Object.keys(day.byUa).length < MAX_UA_FAMILIES ? family : "other";
  day.byUa[k] = (Number(day.byUa[k]) || 0) + n;
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
function normalDay(d) {
  const out = emptyDay();
  if (!d || typeof d !== "object") return out;
  out.refused = num(d.refused);
  for (const r of ROUTES) for (const u of RULES) out.byRoute[r][u] = num(d.byRoute?.[r]?.[u]);
  for (const [k, v] of Object.entries(d.byUa || {})) out.byUa[String(k).slice(0, 40)] = num(v);
  for (const [k, c] of Object.entries(d.clients || {})) {
    if (!/^[0-9a-f]{16}$/.test(k) || !c || typeof c !== "object") continue;
    out.clients[k] = { u: String(c.u || "none").slice(0, 40), r: num(c.r), s: num(c.s), ok: num(c.ok) & 7 };
  }
  for (const k of Object.keys(out.other)) out.other[k] = num(d.other?.[k]);
  return out;
}
/** Add one day's increments to a stored day. Sums stay exact; the cap is applied after. */
export function mergeDay(into, add, cap = MAX_CLIENTS()) {
  const day = normalDay(into), from = normalDay(add);
  day.refused += from.refused;
  for (const r of ROUTES) for (const u of RULES) day.byRoute[r][u] += from.byRoute[r][u];
  for (const [k, v] of Object.entries(from.byUa)) bumpUa(day, k, v);
  for (const k of Object.keys(day.other)) day.other[k] += from.other[k];
  for (const [k, c] of Object.entries(from.clients)) {
    const have = day.clients[k];
    if (have) { have.r += c.r; have.s += c.s; have.ok |= c.ok; continue; }
    // A served or success mark for a client the stored day already folded
    // away: it has no row to land on, so it lands on the folded bucket.
    if (c.r === 0) { day.other.served += c.s; if (c.ok) day.other.succeeded++; if (c.ok & OK_PAID_CALL) day.other.paid++; continue; }
    day.clients[k] = { ...c };
  }
  return enforceCap(day, cap);
}

let doc = null;
const docOf = () => {
  if (!doc) doc = createJsonDocument({ name: DISCOVERY_REFUSALS_DOC, file: process.env.DISCOVERY_REFUSALS_FILE || "/data/discovery-refusals.json", log: () => {} });
  return doc;
};
const bodyOf = (b) => (b && typeof b === "object" && b.days && typeof b.days === "object" ? b : { days: {} });

// Increments not yet folded into the document: day -> day shape.
let pending = {};
// Today's refused clients, found again by address without a digest: the
// limiter's key -> the client key. Memory only.
let tracked = { day: "", byAddress: new Map(), orphans: new Set(), memo: new Map() };
let timer = null;
let flushing = null;

function trackedFor(now) {
  const d = utcDay(now);
  if (tracked.day !== d) tracked = { day: d, byAddress: new Map(), orphans: new Set(), memo: new Map() };
  return tracked;
}
function pendingClient(day, key, ua) {
  let c = day.clients[key];
  if (!c) {
    const keys = Object.keys(day.clients);
    if (keys.length >= MAX_CLIENTS()) {
      let low = keys[0];
      for (const k of keys) if (day.clients[k].r < day.clients[low].r) low = k;
      foldClient(day, low);
    }
    c = day.clients[key] = { u: ua, r: 0, s: 0, ok: 0 };
  }
  return c;
}

/**
 * Count one refusal. Synchronous; the store write is deferred.
 * @param {object} o
 * @param {string} o.address  the client address the limiter keys on (never stored)
 * @param {string} [o.userAgent]
 * @param {"find"|"route"} o.route
 * @param {string} o.rule  one of RULES
 */
export function noteDiscoveryRefusal({ address, userAgent = "", route, rule, now = Date.now() } = {}) {
  try {
    const t = trackedFor(now);
    const addr = limiterKey(String(address ?? "?").trim());
    let key = t.byAddress.get(addr);
    if (!key) {
      key = clientKeyOf(addr, now);
      if (t.byAddress.size >= MAX_ADDRESSES()) t.byAddress.delete(t.byAddress.keys().next().value);
      t.byAddress.set(addr, key);
      t.orphans.delete(key);
    }
    const family = uaFamilyOf(userAgent);
    const day = (pending[t.day] ||= emptyDay());
    day.refused++;
    day.byRoute[routeOf(route)][ruleOf(rule)]++;
    bumpUa(day, family, 1);
    pendingClient(day, key, family).r++;
    startTimer();
    return key;
  } catch { return null; } // a counter never breaks the answer it counts
}

// The client key of an address refused earlier today, or null. A Map lookup;
// a digest is computed only while clients read back from the store after a
// restart have not been seen again, and then once per address.
function trackedKey(address, now) {
  const t = trackedFor(now);
  if (!t.byAddress.size && !t.orphans.size) return null;
  const addr = limiterKey(String(address ?? "?").trim());
  const key = t.byAddress.get(addr);
  if (key) return key;
  if (!t.orphans.size) return null;
  let k = t.memo.get(addr);
  if (!k) {
    k = clientKeyOf(addr, now);
    if (t.memo.size >= MEMO_MAX) t.memo.delete(t.memo.keys().next().value);
    t.memo.set(addr, k);
  }
  if (!t.orphans.has(k)) return null;
  t.orphans.delete(k);
  if (t.byAddress.size >= MAX_ADDRESSES()) t.byAddress.delete(t.byAddress.keys().next().value);
  t.byAddress.set(addr, k);
  return k;
}
function mark(address, bit, served, now) {
  try {
    const key = trackedKey(address, now);
    if (!key) return false;
    const day = (pending[tracked.day] ||= emptyDay());
    const c = pendingClient(day, key, "none");
    c.s += served;
    c.ok |= bit;
    startTimer();
    return true;
  } catch { return false; }
}
/** A search was served (200) to this address: counted only for a client refused earlier today. */
export function noteDiscoveryServed(address, now = Date.now()) { return mark(address, OK_SEARCH, 1, now); }
/** A tool call from this address finished with a final 200, paid or free: marked only for a client refused earlier today. */
export function noteDiscoveryClientCall(address, { paid = false, now = Date.now() } = {}) { return mark(address, paid ? OK_PAID_CALL : OK_FREE_CALL, 0, now); }

function prune(days, now = Date.now()) {
  const cutoff = utcDay(now - (KEEP_DAYS - 1) * 86_400_000);
  for (const d of Object.keys(days)) if (d < cutoff) delete days[d];
  return days;
}
function mergePending(a, b) {
  for (const [d, day] of Object.entries(b)) a[d] = a[d] ? mergeDay(a[d], day) : day;
  return a;
}

/** Fold the pending increments into the document. Never throws; a failed write keeps them for the next flush. */
export async function flushDiscoveryRefusals({ now = Date.now() } = {}) {
  if (flushing) return flushing;
  const batch = pending;
  if (!Object.keys(batch).length) return { ok: true, flushed: false };
  pending = {};
  flushing = (async () => {
    try {
      const r = await docOf().update((b) => {
        const x = bodyOf(b);
        for (const [d, day] of Object.entries(batch)) x.days[d] = mergeDay(x.days[d], day);
        prune(x.days, now);
        return x;
      }, { fallback: null });
      if (!r?.ok) { pending = mergePending(batch, pending); return { ok: false }; }
      return { ok: true, flushed: true };
    } catch {
      pending = mergePending(batch, pending);
      return { ok: false };
    } finally { flushing = null; }
  })();
  return flushing;
}

/**
 * After a start: read today's stored client keys, so a client refused before
 * the restart is still found when it is served afterwards. Off the request
 * path; never throws.
 */
export async function loadDiscoveryRefusals({ now = Date.now() } = {}) {
  try {
    const r = await docOf().read({ quiet: true });
    if (!r?.ok) return { ok: false };
    const t = trackedFor(now);
    const known = new Set(t.byAddress.values());
    for (const k of Object.keys(bodyOf(r.body).days[t.day]?.clients || {})) if (!known.has(k)) t.orphans.add(k);
    return { ok: true, clients: t.orphans.size };
  } catch { return { ok: false }; }
}

function startTimer() {
  if (timer) return;
  timer = setInterval(() => { flushDiscoveryRefusals().catch(() => {}); }, FLUSH_MS());
  timer.unref?.();
}

const share = (n, total) => (total > 0 ? Number((n / total).toFixed(4)) : 0);
function dayReport(d, day, top) {
  const rows = Object.entries(day.clients).filter(([, c]) => c.r > 0)
    .sort((a, b) => (b[1].r - a[1].r) || (a[0] < b[0] ? -1 : 1));
  const sumTop = (n) => rows.slice(0, n).reduce((s, [, c]) => s + c.r, 0);
  const byRule = zero(RULES), byRoute = zero(ROUTES);
  for (const r of ROUTES) for (const u of RULES) { byRule[u] += day.byRoute[r][u]; byRoute[r] += day.byRoute[r][u]; }
  const shown = rows.slice(0, top);
  const restRefused = day.refused - shown.reduce((s, [, c]) => s + c.r, 0);
  return {
    day: d,
    refused: day.refused,
    byRoute,
    byRule,
    byRouteAndRule: day.byRoute,
    byUserAgentFamily: Object.fromEntries(Object.entries(day.byUa).sort((a, b) => b[1] - a[1])),
    distinctRefusedClients: rows.length + day.other.clients,
    distinctIsUpperBound: day.other.clients > 0,
    refusedThenSucceeded: rows.filter(([, c]) => c.ok).length + day.other.succeeded,
    refusedThenPaid: rows.filter(([, c]) => c.ok & OK_PAID_CALL).length + day.other.paid,
    topClients: shown.map(([key, c]) => ({
      client: key,
      userAgentFamily: c.u,
      refused: c.r,
      servedAfterRefusal: c.s,
      wentOnToSucceed: c.ok > 0,
      searchServed: Boolean(c.ok & OK_SEARCH),
      freeCall: Boolean(c.ok & OK_FREE_CALL),
      paidCall: Boolean(c.ok & OK_PAID_CALL),
    })),
    // Everything outside topClients: the tracked clients below the top rows
    // plus the folded bucket. refused + the top rows' refusals = the day's total.
    other: { refused: restRefused, clients: Math.max(0, rows.length - shown.length) + day.other.clients, untrackedRefused: day.other.refused },
    topShare: { top1: share(sumTop(1), day.refused), top5: share(sumTop(5), day.refused), top20: share(sumTop(20), day.refused) },
  };
}

/** The operator view: stored days plus this process's unflushed counts, newest first. No address. */
export async function discoveryRefusalsReport({ now = Date.now(), top = 20 } = {}) {
  let stored = { days: {} }, scope = "stored";
  try {
    const r = await docOf().read({ quiet: true });
    if (r?.ok) stored = bodyOf(r.body); else scope = "unread";
  } catch { scope = "unread"; }
  const days = {};
  for (const d of new Set([...Object.keys(stored.days), ...Object.keys(pending)])) days[d] = mergeDay(stored.days[d], pending[d]);
  prune(days, now);
  return {
    keepDays: KEEP_DAYS,
    maxClientsPerDay: MAX_CLIENTS(),
    rules: RULES,
    scope,
    note: "client is a keyed digest of the limiter's client key and the UTC day (an IPv6 /64 is one client); it does not match across days. servedAfterRefusal and the success marks count from a client's first refusal of the day.",
    days: Object.keys(days).sort().reverse().map((d) => dayReport(d, days[d], Math.max(1, top))),
  };
}

/** Test seams. */
export function _resetDiscoveryRefusals() { pending = {}; tracked = { day: "", byAddress: new Map(), orphans: new Set(), memo: new Map() }; if (timer) { clearInterval(timer); timer = null; } doc = null; }
export function _discoveryRefusalsMemory() { return { pendingDays: Object.keys(pending).length, pendingClients: Object.values(pending).reduce((n, d) => n + Object.keys(d.clients).length, 0), addresses: tracked.byAddress.size, orphans: tracked.orphans.size, memo: tracked.memo.size }; }
