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
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";

const HAS_DATA_DIR = existsSync("/data");
// STATUS_DB_PATH lets the offline tests point at a scratch file. Production
// uses the persistent volume; without it we fall back to /tmp, which loses
// history on restart but never blocks a boot.
const DB_PATH = process.env.STATUS_DB_PATH || `${HAS_DATA_DIR ? "/data" : "/tmp"}/status.db`;

let db = null;
function open() {
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
  return Boolean(open()) && (DB_PATH.startsWith("/data") || Boolean(process.env.STATUS_DB_PATH));
}

/** Insert one observation. Ignores duplicates so a backfill can be re-run. */
export function recordProbe({ ts, source, component, ok, detail = null, url = null }) {
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

/** Insert many observations in one transaction (the backfill path). */
export function recordProbes(rows) {
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
  const d = open();
  if (!d) return null;
  const r = readStatements(d).earliest.get();
  return r?.ts ?? null;
}

/** Every observation ever recorded. Read from the trigger-kept count (see
 *  open()); a store without that row counts the table instead. */
export function totalObservations() {
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
}
