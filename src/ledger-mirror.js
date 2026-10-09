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
import { existsSync, statSync } from "node:fs";

/** Server-clock milliseconds, the `updated_at` stamp every write sets. */
export const PG_NOW_MS = "((extract(epoch from clock_timestamp()) * 1000)::bigint)";
/** How often the mirror pulls other containers' writes. */
export const REFRESH_MS = Number(process.env.LEDGER_MIRROR_REFRESH_MS) || 15_000;
/** Rows stamped this much before the newest stamp seen are pulled again (idempotent upserts). */
export const REFRESH_MARGIN_MS = 60_000;
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
export function sqliteFileRows(file, table) {
  if (!file || !existsSync(file)) return { rows: [], bytes: 0 };
  const t = ident(table);
  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch { db = new Database(file, { fileMustExist: true }); } // a WAL file whose -shm cannot be made read-only
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!has) return { rows: [], bytes: statSync(file).size };
    return { rows: db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(), bytes: statSync(file).size };
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

/** After an import that carried the file's ids: the id sequence continues past them. */
export async function syncIdSequence(query, table) {
  const seq = (await query("SELECT pg_get_serial_sequence($1, 'id') AS s", [table])).rows[0]?.s;
  if (!seq) return;
  const max = Number((await query(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`)).rows[0].m) || 0;
  await query("SELECT setval($1::regclass, $2::bigint, $3::boolean)", [seq, Math.max(max, 1), max > 0]);
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
