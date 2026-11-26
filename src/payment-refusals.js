// The payment refusal record: who was refused, why, on which route and rail,
// and when, kept past the hosting provider's log retention so a question like
// "did this buyer stop because we refused them?" can be answered later.
//
// WHAT A RECORD HOLDS. One row per (UTC day, payer, reason, slug, route class,
// rail, network, HTTP status), with the price quoted, a `count` of the
// refusals it stands for, and the first and last time one was seen. The
// reason is the machine code the gate already names (the paywall's
// classifier word, a gate's own `reason`, or the mark a gate set with
// src/refusal-mark.js), never the caller's text. The payer is kept ONLY when
// the payment verified on that request (src/verified-payment.js
// verifiedPayerOf: the facilitator answered isValid for our own
// requirements); an address read from a payment that did not verify is
// whatever the caller typed, so it is never stored (null). An EVM payer is
// kept lowercased; a base58, Stellar or Algorand payer exactly as verified.
// No request body, signature, IP address or User-Agent is kept.
//
// WHICH REFUSALS. A request to a paid route (the catalog routes, through a
// finish hook src/server.js registers before every payment gate, and /ref and
// /aws through their routes) that carried a payment credential (x402, MPP or
// a credits key) and was answered 402, by any gate (the x402 paywall, the
// Tempo, Stripe and credits gates, the settle-first resend limit), or was
// answered another 4xx by a gate that marked it (the settle breaker's 429,
// src/gateway-settle-breaker.js). An MPP problem's code is mpp-<kind>, with
// its details.reason after a dot (src/mpp-problem.js); a credits refusal's is
// the gate's own reason. One record per request. A sanctions screen refusal
// (403) is kept by its own store (src/sanctions-events.js), not here.
//
// BOUNDED. Repeats inside a UTC day add to one row's count. A process opens
// at most PAYMENT_REFUSAL_KEYS_PER_DAY rows a day; every further refusal that
// day is counted in the day's one overflow row (a count per reason, never a
// payer or a slug). Rows are deleted PAYMENT_REFUSAL_RETENTION_DAYS (90)
// after their day, by the daily retention pass (src/ledger-retention.js),
// which always applies this part: the period is the one /privacy states.
//
// NEVER IN THE WAY. recordPaymentRefusal is synchronous and never throws: it
// adds to memory, and a timer writes the changed rows behind it within
// PAYMENT_REFUSAL_FLUSH_MS (and at shutdown, flushStateQueues). A write that
// fails keeps its counts pending for the next one (at most PENDING_MAX rows
// pending; past it the oldest are dropped and counted). Telemetry, not money:
// no journal; a process killed between flushes loses at most that interval.
//
// WHERE IT LIVES. With a state database: the `records` table, collection
// `payment-refusals`, one row per id `<day>:<digest>`, written as an additive
// upsert so replicas add to each other's counts. Without one: a JSON file
// (PAYMENT_REFUSALS_FILE, else agent402-payment-refusals.json under /data or
// the temp directory), holding at most FILE_MAX_ROWS rows, the oldest days
// dropped first.
//
// READ privately on /__operator/refusals.json (operator token only).
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { stateDbEnabled, stateDbSchema, stateQuery } from "./state-db.js";
import { verifiedPayerOf } from "./verified-payment.js";
import { paymentRefusalMarkOf } from "./refusal-mark.js";
import { x402PaymentNetwork } from "./payment-attempt.js";

export const PAYMENT_REFUSALS_COLLECTION = "payment-refusals";
export const PAYMENT_REFUSAL_RETENTION_DAYS = 90;
export const PAYMENT_REFUSAL_KEYS_PER_DAY = 2_000;
export const PAYMENT_REFUSAL_FLUSH_MS = 5_000;
const FILE_MAX_ROWS = 20_000;
const PENDING_MAX = 3 * PAYMENT_REFUSAL_KEYS_PER_DAY;
const BY_REASON_MAX = 64;
const DAY_MS = 86_400_000;
const BATCH = 500;

const CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const SLUG = /^[a-z0-9][a-z0-9._/-]{0,79}$/i;
const CAIP2 = /^[a-z0-9-]{3,16}:[A-Za-z0-9_-]{1,64}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const STELLAR = /^G[A-Z2-7]{55}$/;
const ALGORAND = /^[A-Z2-7]{58}$/;
const RAILS = new Set(["x402", "mpp", "credits"]);
const ROUTE_CLASSES = new Set(["direct", "ref", "aws"]);
const MPP_METHODS = new Set(["tempo", "stripe", "evm"]);

let limits = { keysPerDay: PAYMENT_REFUSAL_KEYS_PER_DAY, pendingMax: PENDING_MAX, fileMaxRows: FILE_MAX_ROWS };
const counts = { recorded: 0, rows: 0, overflowed: 0, dropped: 0, flushFailures: 0, written: 0 };

export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const useDb = () => stateDbEnabled();
const fileOf = (env = process.env) => env.PAYMENT_REFUSALS_FILE || join(existsSync("/data") ? "/data" : "/tmp", "agent402-payment-refusals.json");

/** A payer as stored: an EVM address lowercased, a base58, Stellar or Algorand
 *  address exactly as given (never case-folded), anything else null. */
export function refusalPayerOf(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (EVM.test(s)) return s.toLowerCase();
  if (BASE58.test(s) || STELLAR.test(s) || ALGORAND.test(s)) return s;
  return null;
}
const codeOf = (v) => { const s = String(v ?? "").trim().toLowerCase(); return CODE.test(s) ? s : null; };
const amountOf = (v) => { const n = Number(v); return v != null && v !== "" && Number.isFinite(n) && n >= 0 && n <= 10_000 ? Math.round(n * 1e6) / 1e6 : null; };

// ---- the current day's rows, in memory ---------------------------------------
let today = "";
const dayRows = new Map();   // id -> row (today's)
const pending = new Map();   // id -> { row, delta, byReason }
let flushTimer = null;
let flushing = null;

function rowKeyOf(r) { return JSON.stringify([r.payer, r.reason, r.slug, r.routeClass, r.rail, r.network, r.status]); }
function idOf(day, r) { return `${day}:${createHash("sha256").update(rowKeyOf(r)).digest("hex").slice(0, 24)}`; }

function addPending(row, n, reason) {
  let p = pending.get(row.id);
  if (!p) {
    if (pending.size >= limits.pendingMax) {
      const oldest = pending.keys().next().value;
      const gone = pending.get(oldest);
      pending.delete(oldest);
      counts.dropped += gone?.delta || 0;
    }
    p = { row, delta: 0, firstAt: row.lastAt, lastAt: row.lastAt, byReason: null };
    pending.set(row.id, p);
  }
  p.delta += n;
  p.lastAt = row.lastAt;
  if (reason) { p.byReason ||= {}; p.byReason[reason] = (p.byReason[reason] || 0) + n; }
  scheduleFlush();
}

/**
 * Record one refused paid attempt. `payer` must be a payer the payment's
 * verification proved (callers pass verifiedPayerOf), else null. Synchronous;
 * never throws. Returns the row id counted, or null.
 */
export function recordPaymentRefusal({ slug = null, routeClass = "direct", rail = null, network = null, reason = null, status = 402, amountUsd = null, payer = null } = {}, { now = Date.now() } = {}) {
  try {
    const day = utcDay(now);
    if (day !== today) { today = day; dayRows.clear(); }
    const at = new Date(now).toISOString();
    const st = Number(status);
    const r = {
      payer: refusalPayerOf(payer),
      reason: codeOf(reason) || "unclassified",
      slug: typeof slug === "string" && SLUG.test(slug) ? slug : "-",
      routeClass: ROUTE_CLASSES.has(routeClass) ? routeClass : "direct",
      rail: RAILS.has(rail) ? rail : "other",
      network: typeof network === "string" && (CAIP2.test(network) || MPP_METHODS.has(network)) ? network : null,
      status: Number.isInteger(st) && st >= 400 && st <= 599 ? st : 402,
    };
    counts.recorded++;
    const id = idOf(day, r);
    let row = dayRows.get(id);
    if (row) {
      row.count++; row.lastAt = at;
      addPending(row, 1, null);
      return id;
    }
    if (dayRows.size >= limits.keysPerDay) {
      const oid = `${day}:overflow`;
      let o = dayRows.get(oid);
      if (!o) { o = { id: oid, day, overflow: true, count: 0, firstAt: at, lastAt: at, byReason: {} }; dayRows.set(oid, o); }
      const key = Object.hasOwn(o.byReason, r.reason) || Object.keys(o.byReason).length < BY_REASON_MAX ? r.reason : "other";
      o.count++; o.lastAt = at; o.byReason[key] = (o.byReason[key] || 0) + 1;
      counts.overflowed++;
      addPending(o, 1, key);
      return oid;
    }
    row = { id, day, ...r, amountUsd: amountOf(amountUsd), count: 1, firstAt: at, lastAt: at };
    dayRows.set(id, row);
    counts.rows++;
    addPending(row, 1, null);
    return id;
  } catch { return null; }
}

// ---- reading a finished response ---------------------------------------------
const BODY_CODE = Symbol("a402.refusalBodyCode");
/** Keep the machine code (`reason`, else a code-shaped `error`) of the JSON
 *  body `res` answers with an error status, for the record. Once per response. */
export function watchRefusalBody(res) {
  try {
    if (!res || typeof res.json !== "function" || Object.hasOwn(res, BODY_CODE)) return;
    Object.defineProperty(res, BODY_CODE, { value: null, writable: true, enumerable: false, configurable: true });
    const orig = res.json;
    res.json = function (body) {
      try {
        if (res.statusCode >= 400 && body && typeof body === "object" && !Array.isArray(body)) {
          const c = codeOf(body.reason) || codeOf(body.error) || codeOf(body.code);
          if (c) res[BODY_CODE] = c;
        }
      } catch { /* the record is best effort */ }
      return orig.apply(this, arguments);
    };
  } catch { /* never in the way */ }
}

// The errorReason of a settle receipt (PAYMENT-RESPONSE) the response carries.
function receiptCodeOf(res) {
  try {
    const h = typeof res?.getHeader === "function" ? res.getHeader("payment-response") || res.getHeader("x-payment-response") : null;
    if (typeof h !== "string" || !h || h.length > 8192) return null;
    return codeOf(JSON.parse(Buffer.from(h, "base64").toString("utf8"))?.errorReason);
  } catch { return null; }
}
const header = (req, n) => { try { return String(req?.headers?.[n] || ""); } catch { return ""; } };
/** The rail and network a request's credential names (an x402 network only
 *  when it is one this server sells on). */
export function refusalRailOf(req) {
  const auth = header(req, "authorization");
  if (/^Bearer a402_/.test(auth)) return { rail: "credits", network: null };
  const m = /^Payment\s+(\S+)\s*$/i.exec(auth);
  if (m) {
    let method = null;
    try { method = String(JSON.parse(Buffer.from(m[1], "base64").toString("utf8"))?.challenge?.method || "").toLowerCase(); } catch { method = null; }
    return { rail: "mpp", network: MPP_METHODS.has(method) ? method : null };
  }
  const x = header(req, "payment-signature") || header(req, "x-payment");
  if (x) return { rail: "x402", network: x402PaymentNetwork(x) };
  return { rail: null, network: null };
}

/**
 * The refusal a finished request stands for, or null when it is not one:
 * it carried a payment credential and was answered 402, or another 4xx a
 * gate marked. `hadCredential` is the funnel's test (passed in, so this
 * module stays a leaf of the server).
 */
export function refusalOfResponse(req, res, { hadCredential, slug = null, routeClass = "direct", amountUsd = null } = {}) {
  try {
    const status = res?.statusCode;
    const mark = paymentRefusalMarkOf(req);
    if (!(status === 402 || (mark && status >= 400 && status < 500))) return null;
    if (typeof hadCredential === "function" && !hadCredential(req)) return null;
    const { rail, network } = refusalRailOf(req);
    if (!rail) return null;
    // The gate's own word first; a classifier that named nothing ("unclassified")
    // yields to the settle receipt's code, then to the body's.
    const set = codeOf(req && Object.hasOwn(req, "__paymentRejectReason") ? req.__paymentRejectReason : null);
    const reason = mark || (set && set !== "unclassified" ? set : null) || receiptCodeOf(res) || (res && Object.hasOwn(res, BODY_CODE) ? res[BODY_CODE] : null) || set || "unclassified";
    return { slug, routeClass, rail, network, reason, status, amountUsd, payer: verifiedPayerOf(req) };
  } catch { return null; }
}

// ---- writing -----------------------------------------------------------------
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushPaymentRefusals().catch(() => {}); }, PAYMENT_REFUSAL_FLUSH_MS);
  flushTimer.unref?.();
}

const T = () => `${stateDbSchema()}.records`;
async function upsertBatch(items) {
  const t = T();
  await stateQuery(
    `INSERT INTO ${t} (collection, id, body)
     SELECT $1, e->>'id', e FROM jsonb_array_elements($2::jsonb) AS e
     ON CONFLICT (collection, id) DO UPDATE SET body = ${t}.body || jsonb_build_object(
       'count', COALESCE((${t}.body->>'count')::bigint, 0) + COALESCE((EXCLUDED.body->>'count')::bigint, 0),
       'firstAt', LEAST(${t}.body->>'firstAt', EXCLUDED.body->>'firstAt'),
       'lastAt', GREATEST(${t}.body->>'lastAt', EXCLUDED.body->>'lastAt')
     ) || CASE WHEN EXCLUDED.body ? 'byReason' THEN jsonb_build_object('byReason', (
       SELECT COALESCE(jsonb_object_agg(k, s), '{}'::jsonb) FROM (
         SELECT k, SUM(v::bigint) AS s FROM (
           SELECT * FROM jsonb_each_text(COALESCE(${t}.body->'byReason', '{}'::jsonb))
           UNION ALL SELECT * FROM jsonb_each_text(EXCLUDED.body->'byReason')
         ) u(k, v) GROUP BY k
       ) g
     )) ELSE '{}'::jsonb END, updated_at = now()`,
    [PAYMENT_REFUSALS_COLLECTION, JSON.stringify(items)],
  );
}

let fileRows = null; // file mode: id -> row
function loadFile() {
  if (fileRows) return fileRows;
  fileRows = new Map();
  try {
    const f = fileOf();
    if (existsSync(f)) {
      const doc = JSON.parse(readFileSync(f, "utf8"));
      for (const r of Array.isArray(doc?.rows) ? doc.rows : []) if (r && typeof r.id === "string") fileRows.set(r.id, r);
    }
  } catch (e) { console.error(`[payment-refusals] the file could not be read (${String(e?.message || e).slice(0, 120)}); starting empty`); }
  return fileRows;
}
function saveFile() {
  const rows = loadFile();
  if (rows.size > limits.fileMaxRows) {
    const ids = [...rows.keys()].sort();
    for (const id of ids.slice(0, rows.size - limits.fileMaxRows)) rows.delete(id);
  }
  const f = fileOf();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, rows: [...rows.values()] }));
  renameSync(tmp, f);
}
function applyToFile(item) {
  const rows = loadFile();
  const cur = rows.get(item.id);
  if (!cur) { rows.set(item.id, { ...item }); return; }
  cur.count = (Number(cur.count) || 0) + item.count;
  if (item.firstAt < (cur.firstAt || item.firstAt)) cur.firstAt = item.firstAt;
  if (item.lastAt > (cur.lastAt || "")) cur.lastAt = item.lastAt;
  if (item.byReason) { cur.byReason ||= {}; for (const [k, v] of Object.entries(item.byReason)) cur.byReason[k] = (cur.byReason[k] || 0) + v; }
}

/** Write every pending count. Resolves the rows written; never throws. A
 *  write that fails puts its counts back for the next flush. */
export async function flushPaymentRefusals() {
  while (flushing) await flushing;
  if (!pending.size) return 0;
  const run = (async () => {
    const batch = [...pending.values()];
    pending.clear();
    const items = batch.map((p) => {
      const { byReason: _b, ...base } = p.row;
      return { ...base, count: p.delta, firstAt: p.firstAt, lastAt: p.lastAt, ...(p.row.overflow ? { byReason: p.byReason || {} } : {}) };
    });
    const putBack = (list) => {
      for (const p of list) {
        const q = pending.get(p.row.id);
        if (!q) { pending.set(p.row.id, p); continue; }
        q.delta += p.delta;
        if (p.firstAt < q.firstAt) q.firstAt = p.firstAt;
        if (p.byReason) { q.byReason ||= {}; for (const [k, v] of Object.entries(p.byReason)) q.byReason[k] = (q.byReason[k] || 0) + v; }
      }
    };
    let n = 0;
    if (useDb()) {
      for (let i = 0; i < items.length; i += BATCH) {
        try { await upsertBatch(items.slice(i, i + BATCH)); n += Math.min(BATCH, items.length - i); }
        catch (e) {
          counts.flushFailures++;
          putBack(batch.slice(i, i + BATCH));
          console.error(`[payment-refusals] ${Math.min(BATCH, items.length - i)} rows were not written yet (${String(e?.message || e).slice(0, 120)}); retrying`);
          scheduleFlush();
        }
      }
    } else {
      try { for (const it of items) applyToFile(it); saveFile(); n = items.length; }
      catch (e) { counts.flushFailures++; fileRows = null; putBack(batch); console.error(`[payment-refusals] the file was not written (${String(e?.message || e).slice(0, 120)}); retrying`); scheduleFlush(); }
    }
    counts.written += n;
    return n;
  })();
  flushing = run.finally(() => { flushing = null; });
  return run;
}

// ---- retention ---------------------------------------------------------------
/** Remove rows whose day is more than `days` days old. Dry run unless `apply`. */
export async function prunePaymentRefusals({ apply = false, now = Date.now(), days = PAYMENT_REFUSAL_RETENTION_DAYS } = {}) {
  const keepDays = Number.isFinite(Number(days)) && Number(days) >= 1 ? Math.floor(Number(days)) : PAYMENT_REFUSAL_RETENTION_DAYS;
  const cutDay = utcDay(now - keepDays * DAY_MS);
  const bound = `${cutDay}:`;
  await flushPaymentRefusals();
  if (useDb()) {
    const where = `collection = $1 AND id < $2`;
    const due = Number((await stateQuery(`SELECT count(*)::bigint AS n FROM ${T()} WHERE ${where}`, [PAYMENT_REFUSALS_COLLECTION, bound])).rows[0].n);
    if (!apply || !due) return { due, removed: 0, cutoff: cutDay };
    const r = await stateQuery(`DELETE FROM ${T()} WHERE ${where}`, [PAYMENT_REFUSALS_COLLECTION, bound]);
    return { due, removed: r.rowCount, cutoff: cutDay };
  }
  const rows = loadFile();
  const old = [...rows.keys()].filter((id) => id < bound);
  if (!apply || !old.length) return { due: old.length, removed: 0, cutoff: cutDay };
  for (const id of old) rows.delete(id);
  saveFile();
  return { due: old.length, removed: old.length, cutoff: cutDay };
}

// ---- the operator read -------------------------------------------------------
export const REFUSALS_READ_DEFAULT = 100;
export const REFUSALS_READ_MAX = 1_000;
/** The filters a query string names, normalized. `error` names a bad one. */
export function refusalFiltersOf(q = {}, { now = Date.now() } = {}) {
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const out = { payer: null, slug: null, reason: null, sinceDay: utcDay(now - PAYMENT_REFUSAL_RETENTION_DAYS * DAY_MS), sinceAt: null };
  const payer = one(q.payer), slug = one(q.slug), reason = one(q.reason), since = one(q.since);
  if (payer != null && payer !== "") { out.payer = refusalPayerOf(String(payer)); if (!out.payer) return { error: "payer must be a wallet address" }; }
  if (slug != null && slug !== "") { if (!SLUG.test(String(slug))) return { error: "slug must be a tool slug" }; out.slug = String(slug); }
  if (reason != null && reason !== "") { out.reason = codeOf(reason); if (!out.reason) return { error: "reason must be a reason code" }; }
  if (since != null && since !== "") {
    const s = String(since);
    const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(s) ? Date.parse(s) : NaN;
    if (!Number.isFinite(t)) return { error: "since must be a date (YYYY-MM-DD) or a UTC time (ISO 8601, Z)" };
    out.sinceDay = utcDay(t);
    if (s.length > 10) out.sinceAt = new Date(t).toISOString();
  }
  return out;
}
const matches = (f) => (r) => r && typeof r.id === "string" && r.id >= `${f.sinceDay}:`
  && (!f.sinceAt || String(r.lastAt || "") >= f.sinceAt)
  && (!f.payer || r.payer === f.payer)
  && (!f.slug || r.slug === f.slug)
  && (!f.reason || (r.overflow ? !!r.byReason && Object.hasOwn(r.byReason, f.reason) : r.reason === f.reason));

function summaryOf(rows, f) {
  const days = new Map();
  for (const r of rows) {
    let d = days.get(r.day);
    if (!d) { d = { day: r.day, total: 0, byReason: {} }; days.set(r.day, d); }
    const add = (k, n) => { d.byReason[k] = (d.byReason[k] || 0) + n; d.total += n; };
    if (r.overflow) { for (const [k, v] of Object.entries(r.byReason || {})) if (!f.reason || k === f.reason) add(k, Number(v) || 0); }
    else add(r.reason, Number(r.count) || 0);
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

/** The operator view: matching rows newest first (at most `limit`), with the
 *  match count and a per-day count by reason over every matching row. */
export async function paymentRefusalsView(filters, { limit = REFUSALS_READ_DEFAULT } = {}) {
  const lim = Math.min(REFUSALS_READ_MAX, Math.max(1, Math.floor(Number(limit)) || REFUSALS_READ_DEFAULT));
  await flushPaymentRefusals();
  let rows, matched, summary;
  if (useDb()) {
    const params = [PAYMENT_REFUSALS_COLLECTION, `${filters.sinceDay}:`];
    const conds = ["collection = $1", "id >= $2"];
    if (filters.sinceAt) { params.push(filters.sinceAt); conds.push(`body->>'lastAt' >= $${params.length}`); }
    if (filters.payer) { params.push(filters.payer); conds.push(`body->>'payer' = $${params.length}`); }
    if (filters.slug) { params.push(filters.slug); conds.push(`body->>'slug' = $${params.length}`); }
    if (filters.reason) { params.push(filters.reason); const p = `$${params.length}`; conds.push(`(body->>'reason' = ${p} OR (body ? 'byReason' AND body->'byReason' ? ${p}))`); }
    const where = conds.join(" AND ");
    const t = T();
    matched = Number((await stateQuery(`SELECT count(*)::bigint AS n FROM ${t} WHERE ${where}`, params)).rows[0].n);
    rows = (await stateQuery(`SELECT body FROM ${t} WHERE ${where} ORDER BY body->>'lastAt' DESC, id LIMIT ${lim}`, params)).rows.map((r) => r.body);
    const reasonParam = filters.reason ? `$${params.indexOf(filters.reason) + 1}` : null;
    const s = await stateQuery(
      `SELECT day, reason, SUM(n)::bigint AS n FROM (
         SELECT body->>'day' AS day, body->>'reason' AS reason, (body->>'count')::bigint AS n FROM ${t} WHERE ${where} AND NOT (body ? 'byReason')
         UNION ALL
         SELECT body->>'day', e.k, e.v::bigint FROM ${t}, jsonb_each_text(body->'byReason') AS e(k, v) WHERE ${where} AND body ? 'byReason'${reasonParam ? ` AND e.k = ${reasonParam}` : ""}
       ) x GROUP BY day, reason`,
      params,
    );
    const flat = s.rows.map((r) => ({ day: r.day, reason: r.reason, count: Number(r.n) }));
    summary = summaryOf(flat, {});
  } else {
    const all = [...loadFile().values()].filter(matches(filters));
    matched = all.length;
    rows = all.sort((a, b) => (a.lastAt === b.lastAt ? (a.id < b.id ? -1 : 1) : (a.lastAt < b.lastAt ? 1 : -1))).slice(0, lim);
    summary = summaryOf(all, filters);
  }
  return { rows, matched, returned: rows.length, summary };
}

/** Counts and bounds for the operator view (never a row). */
export function paymentRefusalsStatus() {
  return { store: useDb() ? "database" : "file", retentionDays: PAYMENT_REFUSAL_RETENTION_DAYS, keysPerDay: limits.keysPerDay, rowsToday: dayRows.size, pending: pending.size, ...counts };
}

/** Tests: smaller bounds. */
export function __setPaymentRefusalLimitsForTests(l = {}) { limits = { ...limits, ...l }; }
/** Tests: forget everything in memory (the stored rows stay). */
export function __resetPaymentRefusalsForTests() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  today = ""; dayRows.clear(); pending.clear(); fileRows = null;
  limits = { keysPerDay: PAYMENT_REFUSAL_KEYS_PER_DAY, pendingMax: PENDING_MAX, fileMaxRows: FILE_MAX_ROWS };
  for (const k of Object.keys(counts)) counts[k] = 0;
}
