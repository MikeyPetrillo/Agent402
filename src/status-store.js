// Probe history for the public status page (/status).
//
// WHY THIS EXISTS
//   A status page served by the system it describes cannot honestly report its
//   own outage — if we were down, nothing here was running to notice. So the
//   observations are made OUTSIDE the server, by the heartbeat workflow running
//   on GitHub Actions every 15 minutes, and merely stored here. Uptime on
//   /status is "what an external observer saw", not "what we say about
//   ourselves", and every figure links back to the run that produced it.
//
//   A consequence worth understanding: when production is down, the heartbeat's
//   POST to this store fails too, so the outage appears as a GAP rather than a
//   row of zeros. Gaps are therefore treated as unobserved, never as uptime.
//   `dailyUptime` reports the observation count next to every percentage so a
//   thinly-sampled day can never masquerade as a well-measured one.
//
// The table is idempotent by (source, component, ts) so the one-time GitHub
// Actions backfill can be re-run safely.
//
// TWO BACKENDS, ONE API. Without STATE_DATABASE_URL the rows live in the
// SQLite file below (the volume), exactly as before. With it they live in the
// state database (see "Postgres mode" at the end of this file): the readers
// keep their synchronous signatures by answering from an in-memory mirror of
// the rows the page reads, the writers queue their inserts in order, and the
// SQLite file is imported once at the first boot with the database on.
import Database from "better-sqlite3";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename } from "node:path";
import { stateDbEnabled, stateDbSchema, stateQuery, withStateTx, importOnce, trackStoreReady, withSchemaLock } from "./state-db.js";
import { retryingLoad } from "./store-retry.js";

const HAS_DATA_DIR = existsSync("/data");
// STATUS_DB_PATH lets the offline tests point at a scratch file. Production
// uses the persistent volume; without it we fall back to /tmp, which loses
// history on restart but never blocks a boot.
const DB_PATH = process.env.STATUS_DB_PATH || `${HAS_DATA_DIR ? "/data" : "/tmp"}/status.db`;
// Decided once at load, like every store on this branch: the switch is a
// variable the operator sets, never a merge.
const PG = stateDbEnabled();

let db = null;
function open() {
  if (PG) return null; // Postgres mode never opens the SQLite file for serving (the import opens it read-only)
  if (db) return db;
  try {
    const dir = DB_PATH.replace(/\/[^/]+$/, "");
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS status_probes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL,
        component TEXT NOT NULL,
        ok INTEGER NOT NULL,
        detail TEXT,
        url TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS status_probes_unique ON status_probes (source, component, ts);
      CREATE INDEX IF NOT EXISTS status_probes_ts ON status_probes (component, ts);
      -- earliestObservation() reads MIN(ts) across components; without a ts-led index it scanned every probe.
      CREATE INDEX IF NOT EXISTS status_probes_ts_only ON status_probes (ts);
      CREATE TABLE IF NOT EXISTS status_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `);
    // The row count the page prints, kept by triggers so a render never counts
    // the table. Created with its starting value in ONE transaction, so no
    // insert can land between the count and the first trigger firing. An
    // ignored duplicate fires no AFTER INSERT trigger, so the figure is exactly
    // COUNT(*).
    db.transaction(() => {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS status_probes_count_ins AFTER INSERT ON status_probes
          BEGIN UPDATE status_meta SET value = value + 1 WHERE key = 'probe_count'; END;
        CREATE TRIGGER IF NOT EXISTS status_probes_count_del AFTER DELETE ON status_probes
          BEGIN UPDATE status_meta SET value = value - 1 WHERE key = 'probe_count'; END;
      `);
      db.prepare("INSERT OR IGNORE INTO status_meta (key, value) SELECT 'probe_count', COUNT(*) FROM status_probes").run();
    }).immediate();
  } catch (e) {
    // A status page must never be the reason the server fails to boot.
    console.error("[status-store] disabled (cannot open DB):", e?.message || e);
    db = null;
  }
  return db;
}

/** True when history is being persisted somewhere that survives a restart. */
export function statusPersistent() {
  if (PG) return true;
  return Boolean(open()) && (DB_PATH.startsWith("/data") || Boolean(process.env.STATUS_DB_PATH));
}

/** Insert one observation. Ignores duplicates so a backfill can be re-run.
 *  Synchronous in both modes: with the database on, the row is added to the
 *  mirror at once (the next render shows it) and the insert is queued in
 *  order; `statusStoreFlush()` resolves once queued writes have landed. */
export function recordProbe({ ts, source, component, ok, detail = null, url = null }) {
  if (PG) { if (!normRow({ ts, source, component })) return false; pgRecord([{ ts, source, component, ok, detail, url }]); return true; }
  const d = open();
  if (!d) return false;
  try {
    d.prepare(
      "INSERT OR IGNORE INTO status_probes (ts, source, component, ok, detail, url) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(Math.floor(Number(ts)), String(source), String(component), ok ? 1 : 0, detail ? String(detail).slice(0, 500) : null, url ? String(url).slice(0, 300) : null);
    return true;
  } catch (e) {
    console.error("[status-store] recordProbe failed:", e?.message || e);
    return false;
  }
}

/** Insert many observations in one transaction (the backfill path). With the
 *  database on, the count returned is the rows the mirror did not already
 *  hold (the queued insert ignores the rest, as the SQLite path does). */
export function recordProbes(rows) {
  if (PG) return pgRecord(rows || []);
  const d = open();
  if (!d) return 0;
  const stmt = d.prepare(
    "INSERT OR IGNORE INTO status_probes (ts, source, component, ok, detail, url) VALUES (?, ?, ?, ?, ?, ?)",
  );
  let written = 0;
  const tx = d.transaction((list) => {
    for (const r of list) {
      const res = stmt.run(
        Math.floor(Number(r.ts)), String(r.source), String(r.component), r.ok ? 1 : 0,
        r.detail ? String(r.detail).slice(0, 500) : null, r.url ? String(r.url).slice(0, 300) : null,
      );
      written += res.changes;
    }
  });
  try { tx(rows || []); } catch (e) { console.error("[status-store] recordProbes failed:", e?.message || e); }
  return written;
}

/** Raw observations for a component, oldest first. */
export function probeRows(component, sinceMs) {
  if (PG) return pgProbeRows(component, sinceMs);
  const d = open();
  if (!d) return [];
  return d
    .prepare("SELECT ts, ok, detail, url, source FROM status_probes WHERE component = ? AND ts >= ? ORDER BY ts ASC")
    .all(String(component), Math.floor(sinceMs));
}

/** Observation count and passes for one component since `sinceMs`, counted
 *  in SQLite on the (component, ts) index without materialising rows: the
 *  window figures longer than the strip need a count, not the rows. */
export function probeCounts(component, sinceMs) {
  if (PG) return pgProbeCounts(component, sinceMs);
  const d = open();
  if (!d) return { observed: 0, up: 0 };
  const r = d
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(ok), 0) AS up FROM status_probes WHERE component = ? AND ts >= ?")
    .get(String(component), Math.floor(sinceMs));
  return { observed: Number(r?.n) || 0, up: Number(r?.up) || 0 };
}

// THE READS BELOW COST THE SAME ON ANY SIZE OF HISTORY. status_probes is never
// pruned (the page prints its whole span and count), the Cloudflare observer
// adds a row per component every 5 minutes, and /status rebuilds after every
// probe write, synchronously. So nothing a render runs may scan the table:
// each statement is an index SEARCH that returns one row, and the loops walk
// the few distinct components or sources one index step at a time (the
// loose-index-scan idiom: MIN(x) WHERE x > previous). Only probeRows reads
// many rows, and it is bounded by the window the page shows, not by history.
// scripts/test-status-store-scale.js pins the query plans and the results
// against the whole-table queries these replace, on two million rows.
let reads = null;
function readStatements(d) {
  if (reads?.db === d) return reads;
  reads = {
    db: d,
    firstComponent: d.prepare("SELECT MIN(component) AS v FROM status_probes"),
    nextComponent: d.prepare("SELECT MIN(component) AS v FROM status_probes WHERE component > ?"),
    // Newest by ts; among rows sharing that ts (two observers in the same
    // millisecond), the one recorded last.
    newestOfComponent: d.prepare("SELECT component, ts, ok, detail, url FROM status_probes WHERE component = ? ORDER BY ts DESC, id DESC LIMIT 1"),
    firstSource: d.prepare("SELECT MIN(source) AS v FROM status_probes"),
    nextSource: d.prepare("SELECT MIN(source) AS v FROM status_probes WHERE source > ?"),
    // (source, component, ts) is unique, so there is exactly one newest row.
    newestOfSource: d.prepare("SELECT source, ts, ok, detail, url FROM status_probes WHERE source = ? AND component = ? ORDER BY ts DESC LIMIT 1"),
    earliest: d.prepare("SELECT MIN(ts) AS ts FROM status_probes"),
    count: d.prepare("SELECT value AS n FROM status_meta WHERE key = 'probe_count'"),
    countAll: d.prepare("SELECT COUNT(*) AS n FROM status_probes"),
  };
  return reads;
}
/** Each distinct value of an indexed column, ascending, one index step each. */
function* distinctValues(first, next) {
  for (let v = first.get()?.v; v != null; v = next.get(v)?.v) yield v;
}

/** Components we have ever observed, plus their most recent observation,
 *  ordered by component.
 *
 *  Keyed on MAX(ts), deliberately NOT MAX(id): the backfill inserts historical
 *  observations after live ones, so insertion order does not track time. Using
 *  the newest id would let a backfilled row from weeks ago present itself as
 *  the current state of a component. The id only breaks a tie between rows
 *  with the same ts. */
export function latestByComponent() {
  if (PG) return pgLatestByComponent();
  const d = open();
  if (!d) return [];
  const s = readStatements(d);
  const out = [];
  for (const component of distinctValues(s.firstComponent, s.nextComponent)) {
    const row = s.newestOfComponent.get(component);
    if (row) out.push(row);
  }
  return out;
}

/** The newest observation of ONE component from EACH source that has observed
 *  it, ordered by source. Same MAX(ts) rule as latestByComponent, taken per
 *  (component, source). Read by the components whose observers walk different
 *  paths (see stateFromSources), where one source's newest row says nothing
 *  about the path another source walks. */
export function latestBySource(component) {
  if (PG) return pgLatestBySource(component);
  const d = open();
  if (!d) return [];
  const s = readStatements(d);
  const out = [];
  for (const source of distinctValues(s.firstSource, s.nextSource)) {
    const row = s.newestOfSource.get(source, String(component));
    if (row) out.push(row);
  }
  return out;
}

export function earliestObservation() {
  if (PG) return mirror.earliest;
  const d = open();
  if (!d) return null;
  const r = readStatements(d).earliest.get();
  return r?.ts ?? null;
}

/** Every observation ever recorded. Read from the trigger-kept count (see
 *  open()); a store without that row counts the table instead. */
export function totalObservations() {
  if (PG) return mirror.count;
  const d = open();
  if (!d) return 0;
  const s = readStatements(d);
  const kept = s.count.get()?.n;
  return Number.isInteger(kept) ? kept : (s.countAll.get()?.n ?? 0);
}

// ── Pure aggregation (exported for scripts/test-status-store.js) ─────────────

/** Uptime over a window. `observed` is reported alongside the percentage on
 *  purpose: 100% of two probes is not the same claim as 100% of two thousand,
 *  and a status page that hides the denominator is telling a story rather than
 *  reporting a measurement. Returns pct null when nothing was observed. */
export function uptimeFrom(rows) {
  const observed = rows.length;
  const up = rows.reduce((n, r) => n + (r.ok ? 1 : 0), 0);
  return { observed, up, down: observed - up, pct: observed ? +((up / observed) * 100).toFixed(4) : null };
}

/** Bucket observations into UTC days, newest last. Days with no observation
 *  are emitted with observed:0 and pct:null — rendered as "no data", never as
 *  a green bar, because we did not measure them. */
export function dailyFrom(rows, { days, nowMs }) {
  const DAY = 86400000;
  const endDay = Math.floor(nowMs / DAY);
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const dayIndex = endDay - i;
    buckets.set(dayIndex, { date: new Date(dayIndex * DAY).toISOString().slice(0, 10), observed: 0, up: 0 });
  }
  for (const r of rows) {
    const dayIndex = Math.floor(r.ts / DAY);
    const b = buckets.get(dayIndex);
    if (!b) continue;
    b.observed++;
    if (r.ok) b.up++;
  }
  return [...buckets.values()].map((b) => ({
    ...b,
    down: b.observed - b.up,
    pct: b.observed ? +((b.up / b.observed) * 100).toFixed(4) : null,
  }));
}

/** Collapse consecutive failed observations into incidents. A single failed
 *  probe is still an incident — it means a real request failed — but grouping
 *  keeps a two-hour outage from rendering as eight separate events. */
export function incidentsFrom(rows, { gapMs = 2 * 3600_000 } = {}) {
  const incidents = [];
  let cur = null;
  for (const r of rows) {
    if (r.ok) { cur = null; continue; }
    if (cur && r.ts - cur.endedAt <= gapMs) {
      cur.endedAt = r.ts;
      cur.probes++;
      if (r.detail && !cur.detail) cur.detail = r.detail;
      continue;
    }
    cur = { startedAt: r.ts, endedAt: r.ts, probes: 1, detail: r.detail || null, url: r.url || null };
    incidents.push(cur);
  }
  return incidents
    .map((i) => ({ ...i, durationMs: Math.max(0, i.endedAt - i.startedAt) }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** Current state of a component from its newest observation.
 *  `stale` matters: a component whose last observation is old is NOT
 *  "operational", it is unmeasured, and saying otherwise would be the exact
 *  self-reporting failure this module exists to avoid. */
export function stateFrom(latest, { nowMs, staleAfterMs = 45 * 60_000 }) {
  if (!latest) return { state: "unknown", reason: "never observed" };
  const age = nowMs - latest.ts;
  if (age > staleAfterMs) return { state: "unknown", reason: "no recent observation", ageMs: age };
  return { state: latest.ok ? "operational" : "outage", ageMs: age, detail: latest.detail || null };
}

/** Current state of a component whose observers walk DIFFERENT paths, from the
 *  newest observation of each source (latestBySource).
 *
 *  Newest-row-wins (stateFrom over latestByComponent) is right when every
 *  source checks the same thing: a newer success is evidence of recovery. It
 *  is wrong when they do not. A newer success on one path says nothing about
 *  the other, so letting it overwrite a failure hides that failure for as long
 *  as the first source keeps reporting - every few minutes, indefinitely.
 *
 *  So each source is judged on its own row against its own staleness bound
 *  (`sourceStaleAfterMs[source]`, else `staleAfterMs`, which must track that
 *  observer's cadence), and then:
 *    - any source whose current reading is a failure makes it an outage;
 *    - else any operational source makes it operational;
 *    - else it is unknown (every source stale, or none ever observed).
 *  A stale source does not vote either way: silence is neither health nor a
 *  failure. `sources` carries each source's own reading, so the reason the
 *  component reads as it does is visible rather than inferred. */
export function stateFromSources(rows, { nowMs, staleAfterMs = 45 * 60_000, sourceStaleAfterMs = {} } = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return { state: "unknown", reason: "never observed", sources: [] };
  const sources = list
    .map((r) => {
      const bound = Object.hasOwn(sourceStaleAfterMs, r.source) ? sourceStaleAfterMs[r.source] : staleAfterMs;
      return { source: r.source, ts: r.ts, ...stateFrom(r, { nowMs, staleAfterMs: bound }) };
    })
    .sort((a, b) => b.ts - a.ts);
  const view = sources.map(({ ts, ...s }) => s);
  const failing = sources.find((s) => s.state === "outage");
  if (failing) return { state: "outage", ageMs: failing.ageMs, detail: failing.detail, source: failing.source, sources: view };
  const up = sources.find((s) => s.state === "operational");
  if (up) return { state: "operational", ageMs: up.ageMs, detail: null, source: up.source, sources: view };
  return { state: "unknown", reason: "no recent observation", ageMs: sources[0].ageMs, sources: view };
}

/** EXPLAIN QUERY PLAN for each history-independent read, from the store's own
 *  prepared statements (scripts/test-status-store-scale.js asserts every one is
 *  an index search). The COUNT(*) fallback is left out: it only runs on a store
 *  with no kept count. */
export function _statusReadPlansForTest() {
  const d = open();
  if (!d) return {};
  const s = readStatements(d);
  const out = {};
  for (const [name, stmt] of Object.entries(s)) {
    if (name === "db" || name === "countAll") continue;
    const params = (stmt.source.match(/\?/g) || []).map(() => "x");
    out[name] = d.prepare(`EXPLAIN QUERY PLAN ${stmt.source}`).all(...params).map((r) => r.detail);
  }
  return out;
}

export function _resetForTest() {
  if (db) { try { db.close(); } catch { /* ignore */ } }
  db = null;
  reads = null;
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// ── Postgres mode ────────────────────────────────────────────────────────────
// With STATE_DATABASE_URL set the rows live in `<schema>.status_probes`, so
// two containers (a deploy's overlap) write and read the same history.
//
// The readers above are synchronous (src/status.js builds the page from them
// in one pass), so they answer from a MIRROR held in memory:
//   - every row inside MIRROR_WINDOW_MS (longer than the longest window the
//     page reads, the 90-day count), kept per component and sorted by ts;
//   - the all-time aggregates the page prints: the newest row per component,
//     the newest row per (source, component), the earliest ts and the exact
//     row count.
// The first load (registered with trackStoreReady, so the server listens
// only after it) imports the SQLite file once, then fills the mirror from the
// table inside one REPEATABLE READ snapshot. Each recordProbe adds its rows
// to the mirror at once and queues the insert in order; the count is only
// moved by what the database reports inserted (ON CONFLICT DO NOTHING
// RETURNING), so an ignored duplicate never counts, as the SQLite triggers
// guaranteed. A refresh every STATUS_STORE_REFRESH_MS pulls rows the OTHER
// container wrote (by inserted_at, with a margin, deduplicated by id and by
// key), so the new container of a deploy does not miss the probes the old one
// recorded in its last minute, and prunes the mirror to its window.
const T = (t) => `${stateDbSchema()}.${t}`;
/** The span the mirror holds; the page's longest window (90 days) must fit, with slack. */
export const MIRROR_WINDOW_MS = 92 * 86400000;
const REFRESH_MS = Math.min(Math.max(Number(process.env.STATUS_STORE_REFRESH_MS) || 60_000, 1000), 3600_000);
// A row's inserted_at is its statement's start; the refresh re-reads this far
// behind its last position so a statement that committed after a refresh saw
// past it is still picked up (seen ids make the re-read harmless).
const REFRESH_MARGIN_MS = 10_000;
const IMPORT_BATCH = 2000;
const say = (m) => console.error(`[status-store] ${m}`);

const mirror = {
  byComponent: new Map(), // component -> { rows: [], dirty: boolean }
  keys: new Set(),        // `${source}\u0001${component}\u0001${ts}` of every row in byComponent
  latestComponent: new Map(), // component -> row
  latestSource: new Map(),    // component -> Map(source -> row)
  count: 0,
  earliest: null,
  seen: new Map(),       // database id -> inserted_at (ms, database clock) for rows already counted
  lastDbAt: 0,           // database clock at the last successful load or refresh (ms)
  seq: 2 ** 50,          // local order for rows whose database id is not known yet
};
let loader = null;     // the first load, retried until it lands (Postgres mode)
let refreshTimer = null;
// Rows recorded but not yet written, oldest batch first. A failed insert
// keeps its batch here and is retried (every DRAIN_RETRY_MS, and on the next
// record); the oldest batches are dropped, logged, past PENDING_MAX_ROWS.
const pending = [];
let pendingRows = 0;
let draining = null;
let drainTimer = null;
const DRAIN_RETRY_MS = 5_000;
const PENDING_MAX_ROWS = 50_000;
let refreshing = false;
let lastQueueError = "";

const keyOf = (r) => `${r.source}\u0001${r.component}\u0001${r.ts}`;
const normRow = (r) => {
  const ts = Math.floor(Number(r?.ts));
  if (!Number.isFinite(ts) || !r?.source || !r?.component) return null;
  return {
    ts, source: String(r.source), component: String(r.component), ok: r.ok ? 1 : 0,
    detail: r.detail ? String(r.detail).slice(0, 500) : null, url: r.url ? String(r.url).slice(0, 300) : null,
  };
};
const newer = (a, b) => a.ts > b.ts || (a.ts === b.ts && a.seq > b.seq);

/** Add one row to the mirror. Returns true when the window part did not hold it. */
function addToMirror(r, seq) {
  const row = { ...r, seq };
  // Aggregates are all-time: a row outside the window still moves them.
  const lc = mirror.latestComponent.get(row.component);
  if (!lc || newer(row, lc)) mirror.latestComponent.set(row.component, row);
  let bySrc = mirror.latestSource.get(row.component);
  if (!bySrc) { bySrc = new Map(); mirror.latestSource.set(row.component, bySrc); }
  const ls = bySrc.get(row.source);
  if (!ls || newer(row, ls)) bySrc.set(row.source, row);
  if (mirror.earliest === null || row.ts < mirror.earliest) mirror.earliest = row.ts;
  if (row.ts < Date.now() - MIRROR_WINDOW_MS) return false;
  const k = keyOf(row);
  if (mirror.keys.has(k)) return false;
  mirror.keys.add(k);
  let c = mirror.byComponent.get(row.component);
  if (!c) { c = { rows: [], dirty: false }; mirror.byComponent.set(row.component, c); }
  const last = c.rows[c.rows.length - 1];
  if (last && (last.ts > row.ts || (last.ts === row.ts && last.seq > row.seq))) c.dirty = true;
  c.rows.push(row);
  return true;
}
function sortedRows(component) {
  const c = mirror.byComponent.get(component);
  if (!c) return [];
  if (c.dirty) { c.rows.sort((a, b) => a.ts - b.ts || a.seq - b.seq); c.dirty = false; }
  return c.rows;
}
function pruneMirror(nowMs = Date.now()) {
  const cutoff = nowMs - MIRROR_WINDOW_MS;
  for (const [component, c] of mirror.byComponent) {
    const rows = sortedRows(component);
    if (!rows.length || rows[0].ts >= cutoff) continue;
    let i = 0;
    while (i < rows.length && rows[i].ts < cutoff) { mirror.keys.delete(keyOf(rows[i])); i++; }
    c.rows = rows.slice(i);
  }
}
function pgProbeRows(component, sinceMs) {
  const since = Math.floor(sinceMs);
  const out = [];
  for (const r of sortedRows(String(component))) if (r.ts >= since) out.push({ ts: r.ts, ok: r.ok, detail: r.detail, url: r.url, source: r.source });
  return out;
}
function pgProbeCounts(component, sinceMs) {
  const since = Math.floor(sinceMs);
  let observed = 0, up = 0;
  for (const r of sortedRows(String(component))) if (r.ts >= since) { observed++; up += r.ok; }
  return { observed, up };
}
function pgLatestByComponent() {
  return [...mirror.latestComponent.keys()].sort().map((component) => {
    const r = mirror.latestComponent.get(component);
    return { component, ts: r.ts, ok: r.ok, detail: r.detail, url: r.url };
  });
}
function pgLatestBySource(component) {
  const bySrc = mirror.latestSource.get(String(component));
  if (!bySrc) return [];
  return [...bySrc.keys()].sort().map((source) => {
    const r = bySrc.get(source);
    return { source, ts: r.ts, ok: r.ok, detail: r.detail, url: r.url };
  });
}

const COLS = "ts, source, component, ok, detail, url";
/** One multi-row insert per batch; resolves the rows the database reports inserted. */
async function pgInsert(rows, run = stateQuery) {
  let written = 0;
  for (let i = 0; i < rows.length; i += IMPORT_BATCH) {
    const chunk = rows.slice(i, i + IMPORT_BATCH);
    const params = [];
    const values = chunk.map((r, j) => { params.push(r.ts, r.source, r.component, r.ok, r.detail, r.url); const b = j * 6; return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`; });
    const r = await run(`INSERT INTO ${T("status_probes")} (${COLS}) VALUES ${values.join(", ")} ON CONFLICT (source, component, ts) DO NOTHING RETURNING id, inserted_at`, params);
    for (const x of r.rows) { const id = Number(x.id); if (!mirror.seen.has(id)) { mirror.seen.set(id, new Date(x.inserted_at).getTime()); mirror.count++; } }
    written += r.rowCount;
  }
  return written;
}
/** The synchronous entry for both record functions in Postgres mode. */
function pgRecord(list) {
  const rows = [];
  let fresh = 0;
  for (const raw of list) {
    const r = normRow(raw);
    if (!r) continue;
    rows.push(r);
    if (addToMirror(r, mirror.seq++)) fresh++;
  }
  if (rows.length) {
    pending.push(rows); pendingRows += rows.length;
    let dropped = 0;
    while (pendingRows > PENDING_MAX_ROWS && pending.length > 1) { const old = pending.shift(); pendingRows -= old.length; dropped += old.length; }
    if (dropped) say(`${dropped} unwritten row(s) dropped: more than ${PENDING_MAX_ROWS} were waiting for the database`);
    void drain();
  }
  return fresh;
}
/** Write the pending batches in order; a failure keeps the batch and schedules a retry. Resolves true when nothing is left. */
function drain() {
  if (draining) return draining;
  draining = (async () => {
    try {
      try { await loader.ready(); } catch { scheduleDrain(); return false; } // the tables may not exist yet
      while (pending.length) {
        const rows = pending[0];
        try { await pgInsert(rows); }
        catch (e) {
          const why = String(e?.message || e).slice(0, 120);
          if (why !== lastQueueError) say(`recordProbe failed, kept for retry: ${why}`);
          lastQueueError = why;
          scheduleDrain();
          return false;
        }
        pending.shift(); pendingRows -= rows.length; lastQueueError = "";
      }
      return true;
    } finally { draining = null; }
  })();
  return draining;
}
function scheduleDrain() {
  if (drainTimer) return;
  drainTimer = setTimeout(() => { drainTimer = null; void drain(); }, DRAIN_RETRY_MS);
  drainTimer.unref?.();
}

async function ensureTable() {
  const s = stateDbSchema();
  await withSchemaLock((c) => c.query(`
    CREATE TABLE IF NOT EXISTS ${s}.status_probes (
      id          BIGSERIAL PRIMARY KEY,
      ts          BIGINT NOT NULL,
      source      TEXT NOT NULL,
      component   TEXT NOT NULL,
      ok          SMALLINT NOT NULL,
      detail      TEXT,
      url         TEXT,
      inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS status_probes_unique ON ${s}.status_probes (source, component, ts DESC);
    CREATE INDEX IF NOT EXISTS status_probes_component_ts ON ${s}.status_probes (component, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS status_probes_ts ON ${s}.status_probes (ts);
    CREATE INDEX IF NOT EXISTS status_probes_inserted_at ON ${s}.status_probes (inserted_at);
  `));
}
/** The SQLite file's rows into the table, insert-if-absent (safe to run twice). */
async function importSqlite() {
  if (!existsSync(DB_PATH)) return { bytes: 0, rows: 0 };
  let src = null;
  try {
    src = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const has = src.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'status_probes'").get();
    if (!has) return { bytes: statSync(DB_PATH).size, rows: 0 };
    let rows = 0, batch = [];
    for (const r of src.prepare(`SELECT ${COLS} FROM status_probes ORDER BY id`).iterate()) {
      const n = normRow(r);
      if (!n) continue;
      batch.push(n);
      if (batch.length >= IMPORT_BATCH) { await pgInsert(batch); rows += batch.length; batch = []; }
    }
    if (batch.length) { await pgInsert(batch); rows += batch.length; }
    say(`imported ${rows} row(s) from ${DB_PATH}`);
    return { bytes: statSync(DB_PATH).size, rows };
  } finally { try { src?.close(); } catch { /* read-only handle */ } }
}
async function loadMirror() {
  const cutoff = Date.now() - MIRROR_WINDOW_MS;
  await withStateTx(async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const agg = await c.query(`SELECT count(*)::bigint AS n, min(ts)::bigint AS min_ts, now() AS at FROM ${T("status_probes")}`);
    const win = await c.query(`SELECT id, ${COLS} FROM ${T("status_probes")} WHERE ts >= $1 ORDER BY ts, id`, [cutoff]);
    const latestC = await c.query(`SELECT DISTINCT ON (component) id, ${COLS} FROM ${T("status_probes")} ORDER BY component, ts DESC, id DESC`);
    const latestS = await c.query(`SELECT DISTINCT ON (source, component) id, ${COLS} FROM ${T("status_probes")} ORDER BY source, component, ts DESC`);
    // Rows the snapshot counted that the first refresh will read again.
    const recent = await c.query(`SELECT id, inserted_at FROM ${T("status_probes")} WHERE inserted_at > now() - ($1::bigint * interval '1 millisecond')`, [REFRESH_MARGIN_MS]);
    mirror.byComponent.clear(); mirror.keys.clear(); mirror.latestComponent.clear(); mirror.latestSource.clear(); mirror.seen.clear();
    mirror.count = Number(agg.rows[0].n);
    mirror.earliest = agg.rows[0].min_ts === null ? null : Number(agg.rows[0].min_ts);
    mirror.lastDbAt = new Date(agg.rows[0].at).getTime();
    for (const x of [...win.rows, ...latestC.rows, ...latestS.rows]) addToMirror(normRow(x), Number(x.id));
    for (const x of recent.rows) mirror.seen.set(Number(x.id), new Date(x.inserted_at).getTime());
    // Rows recorded here that are not written yet stay visible.
    for (const batch of pending) for (const row of batch) addToMirror(row, mirror.seq++);
  });
}
/** Pull rows other containers wrote since the last position; prune the mirror. */
async function refreshMirror() {
  if (refreshing) return 0;
  refreshing = true;
  try {
    const now = await stateQuery("SELECT now() AS at");
    const dbNow = new Date(now.rows[0].at).getTime();
    const r = await stateQuery(`SELECT id, inserted_at, ${COLS} FROM ${T("status_probes")} WHERE inserted_at > $1 ORDER BY id`, [new Date(mirror.lastDbAt - REFRESH_MARGIN_MS)]);
    let added = 0;
    for (const x of r.rows) {
      const id = Number(x.id);
      if (mirror.seen.has(id)) continue;
      mirror.seen.set(id, new Date(x.inserted_at).getTime());
      mirror.count++;
      addToMirror(normRow(x), id);
      added++;
    }
    mirror.lastDbAt = dbNow;
    const floor = dbNow - REFRESH_MARGIN_MS;
    for (const [id, at] of mirror.seen) if (at < floor) mirror.seen.delete(id);
    pruneMirror();
    return added;
  } finally { refreshing = false; }
}

if (PG) {
  // Retried until it lands: a failed attempt is forgotten and tried again
  // (on the next call, and by a background timer), so a blip at boot never
  // leaves the history dead until the next deploy.
  loader = retryingLoad("[status-store]", async () => {
    await ensureTable();
    await importOnce(basename(DB_PATH), { source: DB_PATH, run: importSqlite });
    await loadMirror();
    if (!refreshTimer) {
      refreshTimer = setInterval(() => { refreshMirror().catch((e) => say(`refresh failed: ${String(e?.message || e).slice(0, 120)}`)); }, REFRESH_MS);
      refreshTimer.unref?.();
    }
  }, { log: say, onLoaded: () => { if (pending.length) void drain(); } });
  trackStoreReady(loader.eventually);
  loader.ready().catch(() => {});
}

/** Resolves true once the first load has landed (at once without the database); false while it has not. */
export function statusStoreReady() { return PG ? loader.ready().then(() => true, () => false) : Promise.resolve(true); }
/** Resolves once every pending write has been tried (at once without the database). */
export async function statusStoreFlush() { if (PG) await drain(); }
/** Postgres mode only: pull other containers' rows now; resolves how many arrived. */
export async function statusStoreRefresh() { return PG ? refreshMirror() : 0; }
