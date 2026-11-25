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
// under /data or the temp directory), read once; a new event is appended, a
// filed or pruned one rewrites the file.
//
// THE REPORT WORD. An event that needs a report (`report`: "rejected" or
// "blocked") is due from its time until an operator marks it filed
// (POST /__operator/sanctions-events/filed, with the filing reference). The
// word reads `due` while any reportable event is unfiled, whatever its age;
// the operator view adds each one's deadline (ten business days, weekends
// skipped; a federal holiday only moves the true deadline later) and an
// overdue count.
//
// REPEATS AND AGGREGATES. Nothing a screen refuses is dropped from the record.
//   - An event that names an address (every proven payer, payee or refund
//     wallet) is one row per (kind, address, route class, and for a location
//     refusal its country or region) for SANCTIONS_EVENT_DEDUPE_MS (a day): a
//     repeat inside it adds one to the row's `attempts` and moves its
//     `lastSeenAt`, never a second row. A row an operator marked filed takes no
//     more attempts; the next one opens a new row. There is no cap on these
//     rows: an address must be on the fixed list (or proven by its signature
//     from a sanctioned region, bounded by src/sanctioned-regions.js), so the
//     day's rows are bounded by the list and the dedupe.
//   - recordSanctionsAggregate keeps what has no address worth keeping: one
//     row per (kind, rail, route class, country, region) per clock hour with a
//     `count` and a count per reason (`byReason`), never an address; at most
//     SANCTIONS_AGGREGATE_KEYS_PER_HOUR such rows an hour, every further key
//     counted in the hour's one overflow row per kind (`overflow: true`). Kind
//     `unproven-refusal` (a record, no report): a refusal on an address no
//     signature proves, so the attacker-chosen address is never stored; and a
//     `geo-payment` aggregate (a report) for the proven paid requests from a
//     sanctioned region past that module's bounds.
//   - DURABLE BEFORE IT IS WRITTEN. Every change (a new row, an attempt, an
//     aggregate count) is first kept in the store's journal as a snapshot of
//     the whole row (src/ledger-mirror.js createDeadLetter: a file beside the
//     store, `<file>.pending.ndjson`; with the state database and
//     LEDGER_JOURNAL_REDIS on, the shared Redis journal, local disk its
//     fallback), the journal the money ledgers use. The row is then written
//     behind, within SANCTIONS_EVENT_FLUSH_MS, and at once before any operator
//     read, filing, prune or a graceful shutdown (flushStateQueues); a write
//     that fails stays pending here, its snapshots held until it lands. A
//     journal entry is removed only after the row write that covers it
//     committed. At boot, and on every operator read, replaySanctionsJournal
//     lands what a killed process left: a snapshot is merged into the stored
//     row by maximum (attempts, count, each reason's count, last seen), so a
//     snapshot replayed twice, or an older one after a newer, never counts
//     twice; a filed row is never changed by a replay. After a restart the
//     dedupe keys start empty, so a repeat opens a new row and the counts add
//     up across rows.
//
// RETENTION. pruneSanctionsEvents removes events older than ten years
// (SANCTIONS_EVENTS_RETENTION_YEARS, never less than 10), dry run by default;
// an unfiled reportable event is never removed.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { stateDbEnabled, stateDbSchema, stateQuery } from "./state-db.js";
import { createDeadLetter, everyMs } from "./ledger-mirror.js";

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
  "unproven-refusal": null,        // aggregate only: refusals on an address no signature proves (no address kept)
});

/** One row per key in this window (24 hours); a repeat adds to its attempts. */
export const SANCTIONS_EVENT_DEDUPE_MS = 24 * 60 * 60 * 1000;
/** An aggregate row covers one clock hour. */
export const SANCTIONS_AGGREGATE_MS = 60 * 60 * 1000;
/** New aggregate rows per clock hour; past it, the hour's one overflow row. */
export const SANCTIONS_AGGREGATE_KEYS_PER_HOUR = 200;
/** Increments reach the store within this time. */
export const SANCTIONS_EVENT_FLUSH_MS = 2_000;
const DEDUPE_KEYS_MAX = 10_000;
const AGGREGATE_REASON_RE = /^[a-z][a-z0-9-]{0,39}$/;

const useDb = () => stateDbEnabled();
const fileOf = (env = process.env) => env.SANCTIONS_EVENTS_FILE || join(existsSync("/data") ? "/data" : "/tmp", "agent402-sanctions-events.jsonl");

let fileRows = null; // file mode: every row, oldest first
let dbCache = { at: 0, unfiled: null, error: null };
const DB_CACHE_MS = 60_000;

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
// A location code is kept only in its code form; anything else is dropped.
const codeOf = (v, re) => { const s = v == null ? "" : String(v).trim().toUpperCase(); return re.test(s) ? s : null; };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

const counts = { recorded: 0, repeats: 0, aggregated: 0, flushFailures: 0 };
const seenKeys = new Map();  // dedupe key -> { row, at }
const aggregates = new Map(); // aggregate key -> row (this hour's)
let aggregateHour = 0, aggregateKeysThisHour = 0;
const pending = new Set();    // rows changed since the last write
let flushTimer = null;
let flushing = null;
// The journal (see DURABLE BEFORE IT IS WRITTEN above), opened for the
// store's current file and database; `meta` holds, per row id, the version of
// the row's last change and the journal entries not yet covered by a write.
let journalImpl = null, journalAt = "";
const meta = new Map(); // row id -> { v, onDisk, ids: [{ id, v, j }] }
function journal() {
  const file = `${fileOf()}.pending.ndjson`;
  const key = useDb() ? `${stateDbSchema()}:sanctionsEvents` : "";
  const at = `${file}\u0000${key}`;
  if (!journalImpl || journalAt !== at) { journalImpl = createDeadLetter({ file, name: "sanctionsEvents", journalKey: key }); journalAt = at; }
  return journalImpl;
}
/** Keep a change: a snapshot of `row` in the journal first, then the row pending for its write. */
// A shared journal's durability answers still on their way (each one drops the
// older copies of its row when it lands); tests wait on them before counting.
const acksInFlight = new Set();
export async function __sanctionsJournalSettledForTests() { while (acksInFlight.size) await Promise.all([...acksInFlight]); }
function keep(row, { onDisk = true } = {}) {
  let m = meta.get(row.id);
  if (!m) { m = { v: 0, onDisk, ids: [] }; meta.set(row.id, m); }
  m.v++;
  let id = null, j = null;
  try { j = journal(); id = j.add("sanctions-row", JSON.parse(JSON.stringify(row)), { pending: true }); } catch { id = null; }
  if (id == null) console.error(`[sanctions-events] a change to ${row.id} could not be kept in the journal; it is held in memory until written`);
  else {
    const v = m.v;
    m.ids.push({ id, v, j });
    // The journal holds the newest copy of each row only: once this copy is
    // durable, the older ones are removed (the replay takes maxima, so the
    // newest copy covers them). The journal is bounded by rows, not attempts.
    const dropOlder = () => {
      const older = m.ids.filter((x) => x.v < v);
      m.ids = m.ids.filter((x) => x.v >= v);
      for (const x of older) { try { Promise.resolve(x.j.remove(x.id)).catch(() => {}); } catch { /* replayed again: idempotent */ } }
    };
    // A local journal wrote the line already; a shared one says when it is durable.
    if (j.kind !== "redis") dropOlder();
    else {
      const ack = Promise.resolve(j.durable(id)).then((where) => { if (where) dropOlder(); }, () => {});
      acksInFlight.add(ack);
      ack.finally(() => acksInFlight.delete(ack));
    }
  }
  markDirty(row);
}
/** The write of version `v` of `row` committed: drop the journal entries it covers. */
function landed(row, v) {
  const m = meta.get(row.id);
  if (!m) return;
  m.onDisk = true;
  const done = m.ids.filter((x) => x.v <= v);
  m.ids = m.ids.filter((x) => x.v > v);
  for (const x of done) { try { Promise.resolve(x.j.remove(x.id)).catch(() => {}); } catch { /* replayed again: the merge is idempotent */ } }
  if (!m.ids.length && m.v === v && !pending.has(row)) meta.delete(row.id);
}
// A write that fails leaves the row pending here, and its journal entries
// held by this process (never released to the replay): this process writes it
// on a later flush and then removes them; if the process dies first, its hold
// ends with it (a shared journal's lease lapses, a local one's is in memory)
// and the next replay lands them. Releasing them too would let a shared
// journal forget where an entry landed, so the later removal could miss it.

// The route class: the referral copies apart from the direct routes.
const routeClassOf = (route) => {
  const path = String(route ?? "").replace(/^[A-Z]+\s+/, "");
  if (!path) return "-";
  return /^(?:https?:\/\/[^/]+)?\/ref\//.test(path) ? "ref" : "direct";
};
// An EVM address is one key whatever its case; any other is kept exactly.
const addressKeyOf = (a) => (a == null ? "-" : /^0x[0-9a-fA-F]{40}$/.test(String(a)) ? String(a).toLowerCase() : String(a));
const COUNTRY_RE = /^[A-Z]{2}$/, REGION_RE = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushSanctionsEvents().catch(() => {}); }, SANCTIONS_EVENT_FLUSH_MS);
  flushTimer.unref?.();
}
function markDirty(row) { pending.add(row); scheduleFlush(); }

/** Write every row changed since the last write (new rows, repeats,
 *  aggregates, a failed write). Resolves the number written; a row whose
 *  write fails stays pending, its journal entries kept. Never throws. */
export async function flushSanctionsEvents() {
  while (flushing) await flushing;
  if (!pending.size) return 0;
  const run = (async () => {
    const rows = [...pending];
    pending.clear();
    const version = new Map(rows.map((r) => [r, meta.get(r.id)?.v ?? 0]));
    let n = 0;
    const failed = (r, e) => { pending.add(r); counts.flushFailures++; console.error(`[sanctions-events] a change to ${r.id} was not written yet (${String(e?.message || e).slice(0, 120)}); retrying`); };
    if (useDb()) {
      for (const row of rows) {
        try { if (storeHook) await storeHook("flush", row); await upsertMaxRow(JSON.parse(JSON.stringify(row))); n++; landed(row, version.get(row)); }
        catch (e) { failed(row, e); }
      }
    } else {
      let hookError = null;
      try { if (storeHook) await storeHook("flush", rows[0]); } catch (e) { hookError = e; }
      loadFile();
      if (hookError) for (const r of rows) failed(r, hookError);
      else if (rows.some((r) => meta.get(r.id)?.onDisk !== false)) {
        // A change to a stored row: one rewrite, which holds every row in memory.
        try { saveFile(); n = rows.length; for (const r of rows) landed(r, version.get(r)); }
        catch (e) { for (const r of rows) failed(r, e); }
      } else {
        // Only new rows: one line each, each landed on its own.
        for (const r of rows) {
          try { appendFileRow(r); n++; landed(r, version.get(r)); }
          catch (e) { failed(r, e); }
        }
      }
    }
    if (pending.size) scheduleFlush();
    return n;
  })();
  flushing = run;
  try { return await run; } finally { flushing = null; }
}

// A journaled snapshot merged into the stored row: by maximum, so a replay is
// idempotent; a filed row is left as filed. Resolves the row to write, or null.
function mergedRow(stored, snap) {
  if (!stored) return snap;
  if (stored.filedAt) return null;
  const out = { ...stored };
  let changed = false;
  for (const f of ["attempts", "count"]) {
    if (Number.isFinite(Number(snap[f])) && Number(snap[f]) > (Number(stored[f]) || 0)) { out[f] = Number(snap[f]); changed = true; }
  }
  if (snap.byReason && typeof snap.byReason === "object") {
    out.byReason = { ...(stored.byReason || {}) };
    for (const [k, v] of Object.entries(snap.byReason)) if (Number(v) > (Number(out.byReason[k]) || 0)) { out.byReason[k] = Number(v); changed = true; }
  }
  if (typeof snap.lastSeenAt === "string" && (!stored.lastSeenAt || snap.lastSeenAt > stored.lastSeenAt)) { out.lastSeenAt = snap.lastSeenAt; changed = true; }
  return changed ? out : null;
}
// One statement, so no other write can land between its read and its write:
// a new row is inserted whole; a stored row that is not filed takes the
// maximum of each counter (attempts, count, each reason's count) and the later
// last-seen time, and keeps every other field; a filed row is never touched.
// The flush and the replay both write through it (database mode), so a write
// from an older copy can never lower what a newer one stored.
async function upsertMaxRow(row) {
  const t = `${stateDbSchema()}.records`;
  await stateQuery(
    `INSERT INTO ${t} (collection, id, body) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (collection, id) DO UPDATE SET body = ${t}.body || jsonb_strip_nulls(jsonb_build_object(
       'attempts', GREATEST((${t}.body->>'attempts')::numeric, (EXCLUDED.body->>'attempts')::numeric),
       'count', GREATEST((${t}.body->>'count')::numeric, (EXCLUDED.body->>'count')::numeric),
       'lastSeenAt', GREATEST(${t}.body->>'lastSeenAt', EXCLUDED.body->>'lastSeenAt'),
       'byReason', CASE WHEN ${t}.body ? 'byReason' OR EXCLUDED.body ? 'byReason' THEN (
         SELECT COALESCE(jsonb_object_agg(k, GREATEST(COALESCE((${t}.body->'byReason'->>k)::numeric, 0), COALESCE((EXCLUDED.body->'byReason'->>k)::numeric, 0))), '{}'::jsonb)
         FROM (SELECT jsonb_object_keys(COALESCE(${t}.body->'byReason', '{}'::jsonb)) AS k UNION SELECT jsonb_object_keys(COALESCE(EXCLUDED.body->'byReason', '{}'::jsonb))) keys
       ) END
     )), updated_at = now()
     WHERE ${t}.body->>'filedAt' IS NULL`,
    [SANCTIONS_EVENTS_COLLECTION, row.id, JSON.stringify(row)],
  );
}

// File mode: one process owns the file, and the merge below reads and writes
// the in-memory rows in one synchronous step (no await between), so neither a
// flush nor another replay can land between its read and its write.
async function mergeIntoStore(snap) {
  if (storeHook) await storeHook("replay", snap);
  if (useDb()) { await upsertMaxRow(snap); return; }
  const rows = loadFile();
  const i = rows.findIndex((r) => r.id === snap.id);
  const row = mergedRow(i >= 0 ? rows[i] : null, snap);
  if (!row) return;
  if (i >= 0) {
    // This process's own copy of the row is updated in place, so its next write keeps the merge.
    Object.assign(rows[i], row);
    saveFile();
  } else { rows.push(row); appendFileRow(row); }
}

let replaying = null;
/**
 * Land every journaled change a write has not covered (left by a process that
 * was killed, or by a write that failed): each snapshot merged into its row
 * (see mergedRow), then removed from the journal. One replay at a time.
 * Resolves the number landed. Never throws.
 */
export function replaySanctionsJournal() {
  if (replaying) return replaying;
  replaying = (async () => {
    let n = 0;
    try {
      n = await journal().drain(async (e) => {
        const snap = e?.payload;
        if (!snap || typeof snap !== "object" || typeof snap.id !== "string" || !snap.id.startsWith("se_") || !Object.prototype.hasOwnProperty.call(SANCTIONS_EVENT_KINDS, snap.kind)) return "drop";
        await mergeIntoStore(snap);
        return "landed";
      });
    } catch (e) { console.error(`[sanctions-events] the journal replay stopped (${String(e?.message || e).slice(0, 120)}); the next one retries`); }
    if (n) {
      console.warn(`[sanctions-events] landed ${n} journaled change(s)`);
      if (useDb()) await refreshSanctionsEvents();
    }
    return n;
  })().finally(() => { replaying = null; });
  return replaying;
}

let replayTimer = null;
/** Boot: replay the journal now, then while it holds entries (every `everyMs`). */
export function startSanctionsJournalReplay({ everyMsInterval = 30_000 } = {}) {
  replaySanctionsJournal().catch(() => {});
  if (!replayTimer) replayTimer = everyMs(() => (journal().size() ? replaySanctionsJournal() : null), everyMsInterval);
  return replayTimer;
}

/** The counts for the operator view: never an address. */
export function sanctionsEventWriteLimits() {
  return {
    recorded: counts.recorded, repeats: counts.repeats, aggregated: counts.aggregated,
    pending: pending.size, flushFailures: counts.flushFailures,
    dedupeMs: SANCTIONS_EVENT_DEDUPE_MS, aggregateMs: SANCTIONS_AGGREGATE_MS,
  };
}

function newId(now) {
  return `se_${String(now).padStart(14, "0")}_${randomBytes(5).toString("hex")}`;
}

function loadFile() {
  if (fileRows) return fileRows;
  fileRows = [];
  const byId = new Map();
  const f = fileOf();
  try {
    if (existsSync(f)) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); if (r && typeof r.id === "string") byId.set(r.id, r); } catch { /* a torn line is skipped */ }
      }
      // A row written twice (a write retried after it landed) is read once, as last written.
      fileRows.push(...byId.values());
    }
  } catch (e) { console.warn(`[sanctions-events] could not read ${f}: ${String(e?.message || e).slice(0, 120)}`); }
  return fileRows;
}
// A new row is appended (one line); a change to earlier rows (filed, pruned)
// rewrites the file.
function appendFileRow(row) {
  const f = fileOf();
  try { mkdirSync(dirname(f), { recursive: true }); } catch { /* exists */ }
  appendFileSync(f, JSON.stringify(row) + "\n", { mode: 0o600 });
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
 * row (for a repeat inside the dedupe window, the existing row with one more
 * attempt; see REPEATS AND AGGREGATES above), or null when the store did not
 * take it yet (logged; the write is retried at the next flush).
 * Fields: kind (required, a SANCTIONS_EVENT_KINDS key), address, rail,
 * network, amount (atomic units or USD as `amountUsd`), asset, route,
 * ip, country, region, listPublishDate, via, refundId, detail. A geo-payment
 * event keeps the sanctioned country (ISO 3166-1 alpha-2) or region (ISO
 * 3166-2) code that was the refusal's reason, so a report can state it; no
 * other location value (city, coordinates, a header's own text) is stored.
 */
export async function recordSanctionsEvent(ev = {}, { now = Date.now() } = {}) {
  let row = null, key = null;
  try {
    const kind = String(ev.kind || "");
    if (!Object.prototype.hasOwnProperty.call(SANCTIONS_EVENT_KINDS, kind) || kind === "unproven-refusal") throw new Error(`unknown kind ${kind}`);
    key = [kind, addressKeyOf(ev.address), routeClassOf(ev.route), codeOf(ev.country, COUNTRY_RE) || "", codeOf(ev.region, REGION_RE) || "", ev.address == null ? String(ev.ip ?? "") : "", ev.refundId == null ? "" : String(ev.refundId)].join("|");
    const seen = seenKeys.get(key);
    if (seen && now >= seen.at && now - seen.at < SANCTIONS_EVENT_DEDUPE_MS && !seen.row.filedAt) {
      seen.row.attempts = (Number(seen.row.attempts) || 1) + 1;
      seen.row.lastSeenAt = new Date(Math.max(now, Date.parse(seen.row.lastSeenAt || seen.row.at) || 0)).toISOString();
      counts.repeats++;
      keep(seen.row);
      return seen.row;
    }
    row = {
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
      attempts: 1,
      lastSeenAt: new Date(now).toISOString(),
    };
    // Keyed before the write, so a repeat arriving meanwhile adds to this row.
    seenKeys.delete(key); seenKeys.set(key, { row, at: now });
    while (seenKeys.size > DEDUPE_KEYS_MAX) seenKeys.delete(seenKeys.keys().next().value);
    if (useDb()) { if (row.report && Array.isArray(dbCache.unfiled)) dbCache.unfiled.push(row); }
    else loadFile().push(row);
    // In the journal first; then written now (a failure stays pending and journaled).
    keep(row, { onDisk: false });
    await flushSanctionsEvents();
    if (pending.has(row)) { console.error(`[sanctions-events] ${kind} kept in the journal, not written yet; retrying`); return null; }
    counts.recorded++;
    console.warn(`[sanctions-events] recorded ${kind}${row.report ? ` (a ${row.report === "blocked" ? "blocked-property" : "rejected-transaction"} report is due by ${row.dueBy.slice(0, 10)})` : ""}`);
    return row;
  } catch (e) {
    // A row built but not kept is held pending and written at the next flush.
    if (row) { if (!pending.has(row) && !meta.has(row.id)) keep(row, { onDisk: false }); console.error(`[sanctions-events] event not written yet (${String(e?.message || e).slice(0, 160)}); retrying at the next flush`); }
    else console.error(`[sanctions-events] event NOT recorded (${String(e?.message || e).slice(0, 160)}); the log line above this one is the only record`);
    return null;
  }
}

/**
 * Count one refusal in this hour's aggregate row for (kind, rail, route
 * class, country, region): `count` and `byReason[reason]` grow, `lastSeenAt`
 * moves. No address is kept. `kind`: "unproven-refusal" (a refusal on an
 * address no signature proves; a record, no report) or "geo-payment" (proven
 * paid requests from a sanctioned region past that module's bounds; a
 * report). Resolves the row, or null when the kind or reason is not one this
 * store takes. Never throws.
 */
export async function recordSanctionsAggregate(ev = {}, { now = Date.now() } = {}) {
  try {
    const kind = String(ev.kind || "");
    if (kind !== "unproven-refusal" && kind !== "geo-payment") throw new Error(`no aggregate for kind ${kind}`);
    const reason = String(ev.reason || "");
    if (!AGGREGATE_REASON_RE.test(reason)) throw new Error("an aggregate needs a reason word");
    const hourStart = Math.floor(now / SANCTIONS_AGGREGATE_MS) * SANCTIONS_AGGREGATE_MS;
    const rail = clip(ev.rail, 32), routeClass = routeClassOf(ev.route);
    const country = codeOf(ev.country, COUNTRY_RE), region = codeOf(ev.region, REGION_RE);
    let key = [kind, rail || "", routeClass, country || "", region || "", hourStart].join("|");
    // A bounded number of new rows per hour: past it, every new key of the
    // hour is counted in one overflow row per kind (no rail, route or place).
    if (!aggregates.has(key)) {
      if (aggregateHour !== hourStart) { aggregateHour = hourStart; aggregateKeysThisHour = 0; }
      if (aggregateKeysThisHour >= SANCTIONS_AGGREGATE_KEYS_PER_HOUR) key = [kind, "overflow", hourStart].join("|");
      else aggregateKeysThisHour++;
    }
    const overflow = key === [kind, "overflow", hourStart].join("|");
    let row = aggregates.get(key);
    if (row && !row.filedAt) {
      row.count += 1;
      row.byReason[reason] = (row.byReason[reason] || 0) + 1;
      row.lastSeenAt = new Date(Math.max(now, Date.parse(row.lastSeenAt) || 0)).toISOString();
      counts.aggregated++;
      keep(row);
      return row;
    }
    if (aggregates.size > SANCTIONS_AGGREGATE_KEYS_PER_HOUR) for (const [k, r] of aggregates) if (Date.parse(r.hourStart) < hourStart) aggregates.delete(k);
    const report = SANCTIONS_EVENT_KINDS[kind];
    row = {
      id: newId(now), at: new Date(now).toISOString(), kind, report, aggregate: true, ...(overflow ? { overflow: true } : {}),
      hourStart: new Date(hourStart).toISOString(), address: null,
      rail: overflow ? null : rail, routeClass: overflow ? null : routeClass, country: overflow ? null : country, region: overflow ? null : region,
      count: 1, byReason: { [reason]: 1 }, lastSeenAt: new Date(now).toISOString(),
      dueBy: report ? new Date(addBusinessDays(now)).toISOString() : null, filedAt: null, filedRef: null,
    };
    aggregates.set(key, row);
    counts.aggregated++;
    if (useDb()) {
      if (row.report && Array.isArray(dbCache.unfiled)) dbCache.unfiled.push(row);
    } else loadFile().push(row);
    keep(row, { onDisk: false });
    return row;
  } catch (e) {
    console.error(`[sanctions-events] aggregate NOT recorded (${String(e?.message || e).slice(0, 160)})`);
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
  await replaySanctionsJournal();
  await flushSanctionsEvents();
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
    writeLimits: sanctionsEventWriteLimits(),
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
  // Every change reaches the store first, and later attempts open new rows,
  // so a filed row never changes after its filing.
  seenKeys.clear(); aggregates.clear();
  await replaySanctionsJournal();
  await flushSanctionsEvents();
  if (useDb()) {
    const list = await dbUnfiled();
    const t = `${stateDbSchema()}.records`;
    for (const r of list) {
      if (want && !want.has(r.id)) continue;
      // Only the two filing fields change, in one statement: an attempt merged
      // meanwhile is kept, and a row already filed keeps its first filing.
      const u = await stateQuery(
        `UPDATE ${t} SET body = body || jsonb_build_object('filedAt', $3::text, 'filedRef', $4::text), updated_at = now() WHERE collection = $1 AND id = $2 AND body->>'filedAt' IS NULL`,
        [SANCTIONS_EVENTS_COLLECTION, r.id, filedAt, ref],
      );
      if (u.rowCount) marked.push(r.id);
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
  await flushSanctionsEvents();
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
// Tests: awaited before each store write ("flush" or "replay"); it may delay or throw.
let storeHook = null;
export function __setSanctionsStoreHookForTests(fn = null) { storeHook = typeof fn === "function" ? fn : null; }
/** Tests: forget the dedupe keys, the aggregates, pending changes, the journal handle and counts. */
export function __resetSanctionsEventLimitsForTests() {
  seenKeys.clear(); aggregates.clear(); pending.clear(); meta.clear(); journalImpl = null; journalAt = ""; aggregateHour = 0; aggregateKeysThisHour = 0;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  counts.recorded = 0; counts.repeats = 0; counts.aggregated = 0; counts.flushFailures = 0;
}
