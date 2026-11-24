// The sanctions events store: every screen hit, compliance refusal, blocked
// refund and geo-refused payment, kept in full (address, rail, network,
// amount, route, time, list date) for the records rule (31 CFR 501.601: ten
// years after the transaction) and for the reports OFAC requires within ten
// business days (501.603 blocked property, 501.604 rejected transactions).
//
// PRIVATE. Nothing here is ever on a public surface: /api/gateway-status
// carries one word (`sanctionsReport`: clear, due, unknown), and the rows are
// read only on the token-authed /__operator/sanctions-events.json.
//
// WHERE IT LIVES. With a state database: the `records` table, collection
// `sanctions-events` (one row per event; ids sort by time). Without one: a
// JSON-lines file (SANCTIONS_EVENTS_FILE, else agent402-sanctions-events.jsonl
// under /data or the temp directory), read once and rewritten on a change.
//
// THE REPORT WORD. An event that needs a report (`report`: "rejected" or
// "blocked") is due from its time until an operator marks it filed
// (POST /__operator/sanctions-events/filed, with the filing reference). The
// word reads `due` while any reportable event is unfiled, whatever its age;
// the operator view adds each one's deadline (ten business days, weekends
// skipped; a federal holiday only moves the true deadline later) and an
// overdue count.
//
// RETENTION. pruneSanctionsEvents removes events older than ten years
// (SANCTIONS_EVENTS_RETENTION_YEARS, never less than 10), dry run by default;
// an unfiled reportable event is never removed.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { stateDbEnabled, stateDbSchema, stateQuery, records } from "./state-db.js";

export const SANCTIONS_EVENTS_COLLECTION = "sanctions-events";
export const REPORT_BUSINESS_DAYS = 10;
export const SANCTIONS_RETENTION_MIN_YEARS = 10;

/** Event kinds and the report each needs (null: kept as a record only). */
export const SANCTIONS_EVENT_KINDS = Object.freeze({
  "screen-hit": "rejected",        // a listed payer refused before settlement
  "provider-refusal": "rejected",  // a settlement provider refused on compliance grounds
  "own-screen-refusal": "rejected", // our own settler's screen refused it
  "payout-refused": "rejected",    // a payout (router purchase, refund) to a listed address not sent
  "blocked-refund": "blocked",     // a refund owed to a wallet listed later: held as blocked property
  "geo-payment": "rejected",       // a paid request from a sanctioned region, refused before verification
});

const useDb = () => stateDbEnabled();
const fileOf = (env = process.env) => env.SANCTIONS_EVENTS_FILE || join(existsSync("/data") ? "/data" : "/tmp", "agent402-sanctions-events.jsonl");

let fileRows = null; // file mode: every row, oldest first
let dbCache = { at: 0, unfiled: null, error: null };
const DB_CACHE_MS = 60_000;

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
// A location code is kept only in its code form; anything else is dropped.
const codeOf = (v, re) => { const s = v == null ? "" : String(v).trim().toUpperCase(); return re.test(s) ? s : null; };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function newId(now) {
  return `se_${String(now).padStart(14, "0")}_${randomBytes(5).toString("hex")}`;
}

function loadFile() {
  if (fileRows) return fileRows;
  fileRows = [];
  const f = fileOf();
  try {
    if (existsSync(f)) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); if (r && typeof r.id === "string") fileRows.push(r); } catch { /* a torn line is skipped */ }
      }
    }
  } catch (e) { console.warn(`[sanctions-events] could not read ${f}: ${String(e?.message || e).slice(0, 120)}`); }
  return fileRows;
}
function saveFile() {
  const f = fileOf();
  try { mkdirSync(dirname(f), { recursive: true }); } catch { /* exists */ }
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, fileRows.map((r) => JSON.stringify(r)).join("\n") + (fileRows.length ? "\n" : ""), { mode: 0o600 });
  renameSync(tmp, f);
}

/** Add `days` business days (Monday to Friday) to a time, in UTC. */
export function addBusinessDays(ms, days = REPORT_BUSINESS_DAYS) {
  const d = new Date(ms);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.getTime();
}

/**
 * Record one event. Never throws into a serving path: resolves the stored
 * row, or null when the store did not take it (logged).
 * Fields: kind (required, a SANCTIONS_EVENT_KINDS key), address, rail,
 * network, amount (atomic units or USD as `amountUsd`), asset, route,
 * ip, country, region, listPublishDate, via, refundId, detail. A geo-payment
 * event keeps the sanctioned country (ISO 3166-1 alpha-2) or region (ISO
 * 3166-2) code that was the refusal's reason, so a report can state it; no
 * other location value (city, coordinates, a header's own text) is stored.
 */
export async function recordSanctionsEvent(ev = {}, { now = Date.now() } = {}) {
  try {
    const kind = String(ev.kind || "");
    if (!Object.prototype.hasOwnProperty.call(SANCTIONS_EVENT_KINDS, kind)) throw new Error(`unknown kind ${kind}`);
    const row = {
      id: newId(now),
      at: new Date(now).toISOString(),
      kind,
      report: SANCTIONS_EVENT_KINDS[kind],
      address: clip(ev.address, 128),      // case preserved: base58 and Stellar addresses are case-sensitive
      rail: clip(ev.rail, 32),
      network: clip(ev.network, 80),
      amount: clip(ev.amount, 40),
      amountUsd: num(ev.amountUsd),
      asset: clip(ev.asset, 80),
      route: clip(ev.route, 200),
      ip: clip(ev.ip, 64),
      country: codeOf(ev.country, /^[A-Z]{2}$/),
      region: codeOf(ev.region, /^[A-Z]{2}-[A-Z0-9]{1,3}$/),
      listPublishDate: clip(ev.listPublishDate, 40),
      via: clip(ev.via, 80),
      refundId: num(ev.refundId),
      detail: clip(ev.detail, 300),
      dueBy: SANCTIONS_EVENT_KINDS[kind] ? new Date(addBusinessDays(now)).toISOString() : null,
      filedAt: null,
      filedRef: null,
    };
    if (useDb()) {
      await records.put(SANCTIONS_EVENTS_COLLECTION, row.id, row);
      if (row.report && Array.isArray(dbCache.unfiled)) dbCache.unfiled.push(row);
    } else {
      loadFile().push(row);
      saveFile();
    }
    console.warn(`[sanctions-events] recorded ${kind}${row.report ? ` (a ${row.report === "blocked" ? "blocked-property" : "rejected-transaction"} report is due by ${row.dueBy.slice(0, 10)})` : ""}`);
    return row;
  } catch (e) {
    console.error(`[sanctions-events] event NOT recorded (${String(e?.message || e).slice(0, 160)}); the log line above this one is the only record`);
    return null;
  }
}

async function dbUnfiled() {
  const t = `${stateDbSchema()}.records`;
  const r = await stateQuery(
    `SELECT body FROM ${t} WHERE collection = $1 AND body->>'report' IS NOT NULL AND body->>'filedAt' IS NULL ORDER BY id LIMIT 5000`,
    [SANCTIONS_EVENTS_COLLECTION],
  );
  return r.rows.map((x) => x.body);
}

/** Refresh the database view of unfiled reportable events (file mode: no-op). */
export async function refreshSanctionsEvents() {
  if (!useDb()) return;
  try { dbCache = { at: Date.now(), unfiled: await dbUnfiled(), error: null }; }
  catch (e) { dbCache = { ...dbCache, at: Date.now(), error: String(e?.message || e).slice(0, 160) }; }
}

function unfiledNow() {
  if (!useDb()) return loadFile().filter((r) => r.report && !r.filedAt);
  if (Date.now() - dbCache.at > DB_CACHE_MS) refreshSanctionsEvents().catch(() => {});
  return Array.isArray(dbCache.unfiled) ? dbCache.unfiled : null;
}

/**
 * The public word: `due` while a reportable event is unfiled, `clear` when
 * none is, `unknown` before the database has been read (or when it cannot be).
 */
export function sanctionsReportStatus() {
  const list = unfiledNow();
  if (!list) return "unknown";
  return list.length ? "due" : "clear";
}

/** The operator view: the unfiled reportable events in full, deadlines, and recent events. */
export async function sanctionsEventsOperatorView({ now = Date.now(), recent = 100 } = {}) {
  let unfiled, latest;
  if (useDb()) {
    await refreshSanctionsEvents();
    unfiled = dbCache.unfiled || [];
    const t = `${stateDbSchema()}.records`;
    const r = await stateQuery(`SELECT body FROM ${t} WHERE collection = $1 ORDER BY id DESC LIMIT $2`, [SANCTIONS_EVENTS_COLLECTION, Math.max(1, Math.min(1000, recent))]);
    latest = r.rows.map((x) => x.body);
  } else {
    unfiled = loadFile().filter((r) => r.report && !r.filedAt);
    latest = loadFile().slice(-recent).reverse();
  }
  const overdue = unfiled.filter((r) => r.dueBy && Date.parse(r.dueBy) < now).length;
  return {
    status: sanctionsReportStatus(),
    backend: useDb() ? "db" : "file",
    unfiled,
    overdue,
    recent: latest,
    rule: { reportBusinessDays: REPORT_BUSINESS_DAYS, retentionYears: sanctionsRetentionYears() },
  };
}

/**
 * Mark events filed. `ids` (array) or `all: true` (every unfiled reportable
 * event), with `reference` (the filing's confirmation, required).
 * Resolves { marked, ids } or throws a 400-shaped error.
 */
export async function markSanctionsEventsFiled({ ids = null, all = false, reference = "", now = Date.now() } = {}) {
  const ref = typeof reference === "string" ? reference.trim().slice(0, 200) : "";
  if (!ref) throw Object.assign(new Error("reference required (the filing confirmation)"), { statusCode: 400 });
  const want = all === true ? null : new Set((Array.isArray(ids) ? ids : []).map(String));
  if (want && !want.size) throw Object.assign(new Error("ids (array) or all: true required"), { statusCode: 400 });
  const filedAt = new Date(now).toISOString();
  const marked = [];
  if (useDb()) {
    const list = await dbUnfiled();
    for (const r of list) {
      if (want && !want.has(r.id)) continue;
      await records.put(SANCTIONS_EVENTS_COLLECTION, r.id, { ...r, filedAt, filedRef: ref });
      marked.push(r.id);
    }
    await refreshSanctionsEvents();
  } else {
    for (const r of loadFile()) {
      if (!r.report || r.filedAt || (want && !want.has(r.id))) continue;
      r.filedAt = filedAt; r.filedRef = ref;
      marked.push(r.id);
    }
    if (marked.length) saveFile();
  }
  return { marked: marked.length, ids: marked };
}

export function sanctionsRetentionYears(env = process.env) {
  const n = Number(env.SANCTIONS_EVENTS_RETENTION_YEARS);
  return Number.isFinite(n) && n >= SANCTIONS_RETENTION_MIN_YEARS ? Math.floor(n) : SANCTIONS_RETENTION_MIN_YEARS;
}

/**
 * Remove events past the retention period. Dry run unless `apply: true`.
 * An unfiled reportable event is never removed. Resolves { due, removed }.
 */
export async function pruneSanctionsEvents({ apply = false, now = Date.now(), years = sanctionsRetentionYears() } = {}) {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - Math.max(SANCTIONS_RETENTION_MIN_YEARS, years));
  const cutIso = cutoff.toISOString();
  const keep = (r) => !(typeof r.at === "string" && r.at < cutIso) || (r.report && !r.filedAt);
  if (useDb()) {
    const t = `${stateDbSchema()}.records`;
    const where = `collection = $1 AND body->>'at' < $2 AND NOT (body->>'report' IS NOT NULL AND body->>'filedAt' IS NULL)`;
    const n = Number((await stateQuery(`SELECT count(*)::bigint AS n FROM ${t} WHERE ${where}`, [SANCTIONS_EVENTS_COLLECTION, cutIso])).rows[0].n);
    if (!apply || !n) return { due: n, removed: 0, cutoff: cutIso };
    const r = await stateQuery(`DELETE FROM ${t} WHERE ${where}`, [SANCTIONS_EVENTS_COLLECTION, cutIso]);
    return { due: n, removed: r.rowCount, cutoff: cutIso };
  }
  const rows = loadFile();
  const due = rows.filter((r) => !keep(r)).length;
  if (!apply || !due) return { due, removed: 0, cutoff: cutIso };
  fileRows = rows.filter(keep);
  saveFile();
  return { due, removed: due, cutoff: cutIso };
}

/** Tests: forget the file view and the database cache. */
export function __resetSanctionsEventsForTests() { fileRows = null; dbCache = { at: 0, unfiled: null, error: null }; }
