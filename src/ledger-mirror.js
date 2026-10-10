// Shared pieces for the two SQLite ledgers (src/refund-ledger.js,
// src/sales-ledger.js) when the state database is on.
//
// Each ledger keeps its prepared read queries exactly as they are; with the
// database on they run against an in-memory SQLite MIRROR of the Postgres
// table instead of the file on the volume. Postgres is the record: every
// write is a single statement with RETURNING, the returned row is written
// into the mirror when it lands, and a timer pulls rows another container
// changed (by their `updated_at`, with a margin, so a statement that committed
// after a neighbour with an earlier stamp is never skipped). A reader is
// therefore exact for this process's own writes as soon as they land and at
// most one refresh interval behind another container's.
import Database from "better-sqlite3";
import { existsSync, statSync, readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/** Server-clock milliseconds, the `updated_at` stamp every write sets. */
export const PG_NOW_MS = "((extract(epoch from clock_timestamp()) * 1000)::bigint)";
/** How often the mirror pulls other containers' writes. */
export const REFRESH_MS = Number(process.env.LEDGER_MIRROR_REFRESH_MS) || 15_000;
/**
 * The refresh watermark trails the database clock by this much: a refresh
 * pulls rows stamped after (the previous refresh's database now() minus the
 * margin), so a write stamped just before a refresh and committed just after
 * it is pulled by the next one. Every ledger write is one autocommit
 * statement that commits within milliseconds of its stamp. Kept below
 * REFRESH_MS so a burst (a 55k-row import shares one stamp range) is pulled
 * at most once more, not on every refresh until the next sale lands.
 */
export const REFRESH_MARGIN_MS = Number(process.env.LEDGER_MIRROR_MARGIN_MS) || 10_000;
/** The database clock in ms (the same clock as every `updated_at`). */
export async function pgNowMs(query) {
  return Number((await query(`SELECT ${PG_NOW_MS} AS n`)).rows[0]?.n) || 0;
}
/** Postgres refuses U+0000 in text; SQLite and JSON accept it. Stripped from every value a ledger writes or imports. */
export function noNul(v) {
  return typeof v === "string" && v.includes("\u0000") ? v.replace(/\u0000/g, "") : v;
}
/** noNul over every value of a row object (a new object). */
export function cleanRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = noNul(v);
  return out;
}
/**
 * A file written this much later than the table's newest row was written by
 * a build that used the file alone (a rollback); write-through lands within
 * milliseconds. Same grace as json-document.js.
 */
export const NEWER_FILE_GRACE_MS = 60_000;
/**
 * When the ledger file was last written: the newer of the file and its -wal
 * (a WAL-mode build that was killed before its checkpoint left its last
 * writes in the -wal, and the main file's mtime behind). NaN when absent.
 */
export function ledgerFileMtime(file) {
  let m = NaN;
  for (const f of [file, `${file}-wal`]) {
    try { const t = statSync(f).mtimeMs; if (!(t <= m)) m = t; } catch { /* absent */ }
  }
  return m;
}
/** True when a file mtime (ms) is past the table's reference stamp (ms) by more than the grace; a missing stamp is never "older". */
export function fileNewerThan(mtimeMs, stampMs, grace = NEWER_FILE_GRACE_MS) {
  return Boolean(stampMs) && Number.isFinite(mtimeMs) && mtimeMs > stampMs + grace;
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => { if (!IDENT_RE.test(String(s))) throw new Error(`bad identifier ${JSON.stringify(s)}`); return s; };

/**
 * Every row of `table` in a SQLite file, opened read-only (the import source);
 * `{ rows: [], bytes: 0 }` when the file or the table is missing. Never
 * creates the file.
 */
export function sqliteFileRows(file, table, { where = "", params = [] } = {}) {
  if (!file || !existsSync(file)) return { rows: [], bytes: 0 };
  const t = ident(table);
  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch { db = new Database(file, { fileMustExist: true }); } // a WAL file whose -shm cannot be made read-only
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!has) return { rows: [], bytes: statSync(file).size };
    return { rows: db.prepare(`SELECT * FROM ${t}${where ? ` WHERE ${where}` : ""} ORDER BY rowid`).all(...params), bytes: statSync(file).size };
  } finally { db.close(); }
}

/**
 * One queue per ledger: writes land in call order. Each job's own promise
 * carries its result or error; the chain itself never rejects.
 */
export function serialQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const p = tail.then(fn, fn);
    tail = p.then(() => {}, () => {});
    return p;
  };
}

/**
 * Multi-row INSERT in batches. `columns` are the Postgres column names (an
 * identifier each); each row is an object keyed by them. `conflict` is the
 * ON CONFLICT clause (the import uses `ON CONFLICT DO NOTHING`, so two
 * containers importing the same file at once cannot fail on each other).
 * Returns how many rows the statements reported inserted.
 */
export async function insertRows(query, table, columns, rows, { conflict = "", batch = 500 } = {}) {
  const cols = columns.map(ident);
  let n = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const params = [];
    const tuples = chunk.map((r) => `(${cols.map((c) => { params.push(r[c] ?? null); return `$${params.length}`; }).join(",")})`);
    const res = await query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${tuples.join(",")} ${conflict}`, params);
    n += res.rowCount || 0;
  }
  return n;
}

/**
 * After an import that carried the file's ids: the id sequence continues past
 * them. One statement, and never backwards: the sequence's own last value
 * (which already counts an insert that has taken an id but not committed) is
 * kept when it is ahead of MAX(id).
 */
export async function syncIdSequence(query, table) {
  const seq = (await query("SELECT pg_get_serial_sequence($1, 'id') AS s", [table])).rows[0]?.s;
  if (!seq) return;
  await query(
    `SELECT CASE WHEN t.v > 0 THEN setval($1::regclass, t.v, true) ELSE setval($1::regclass, 1, false) END
       FROM (SELECT GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${ident2(table)}), COALESCE(pg_sequence_last_value($1::regclass), 0)) AS v) t`,
    [seq],
  );
}
const ident2 = (t) => String(t).split(".").map(ident).join(".");

/**
 * A durable local queue for ledger writes Postgres refused or never answered
 * (a refund owed, a sale): a row that cannot land must not vanish. Kept in
 * the ledger's own SQLite file while it is open (table pg_dead_letter), else
 * in an NDJSON file. The ledger replays every entry insert-if-absent (by its
 * natural key) on the next successful load, refresh and on a timer, and
 * removes an entry only once Postgres holds it.
 */
export function createDeadLetter({ db = null, file = "" } = {}) {
  let sqlite = null;
  if (db) {
    try {
      db.exec("CREATE TABLE IF NOT EXISTS pg_dead_letter (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL)");
      sqlite = {
        add: db.prepare("INSERT INTO pg_dead_letter (kind, payload, at) VALUES (?, ?, ?)"),
        list: db.prepare("SELECT id, kind, payload, at FROM pg_dead_letter ORDER BY id"),
        remove: db.prepare("DELETE FROM pg_dead_letter WHERE id = ?"),
        count: db.prepare("SELECT count(*) AS n FROM pg_dead_letter"),
      };
    } catch { sqlite = null; }
  }
  const readNd = () => {
    try {
      return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.id && e.kind);
    } catch { return []; }
  };
  return {
    kind: sqlite ? "sqlite" : file ? "ndjson" : "none",
    /** True when the entry is on local disk. */
    add(kind, payload) {
      try {
        if (sqlite) { sqlite.add.run(String(kind), JSON.stringify(payload), Date.now()); return true; }
        if (!file) return false;
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, JSON.stringify({ id: `${Date.now()}-${randomBytes(4).toString("hex")}`, kind: String(kind), payload, at: Date.now() }) + "\n");
        return true;
      } catch { return false; }
    },
    list() {
      if (sqlite) { try { return sqlite.list.all().map((r) => ({ id: r.id, kind: r.kind, payload: JSON.parse(r.payload), at: r.at })); } catch { return []; } }
      return file ? readNd() : [];
    },
    remove(id) {
      try {
        if (sqlite) { sqlite.remove.run(id); return; }
        if (!file) return;
        const keep = readNd().filter((e) => e.id !== id);
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, keep.map((e) => JSON.stringify(e) + "\n").join(""));
        renameSync(tmp, file);
      } catch { /* replayed again; the replay is insert-if-absent */ }
    },
    size() {
      if (sqlite) { try { return sqlite.count.get().n; } catch { return 0; } }
      return file ? readNd().length : 0;
    },
  };
}
/** A Postgres error about the row itself (bad data, a constraint), not the connection: retrying the same row cannot help. */
export function isRowError(e) {
  const c = String(e?.code || "");
  return /^(22|23)/.test(c);
}

/** An unref'd interval whose callback's failure is swallowed (the next tick retries). */
export function everyMs(fn, ms) {
  const t = setInterval(() => { try { Promise.resolve(fn()).catch(() => {}); } catch { /* next tick */ } }, ms);
  t.unref?.();
  return t;
}

/** A warning per label at most once a minute, so a database outage is one line, not one per write. */
export function makeWarnOnce(prefix, log = console.warn) {
  const last = new Map();
  return (label, e) => {
    const now = Date.now();
    if ((last.get(label) || 0) > now - 60_000) return;
    last.set(label, now);
    try { log(`[${prefix}] ${label} failed: ${String(e?.message || e).slice(0, 160)}`); } catch { /* logging never throws */ }
  };
}
