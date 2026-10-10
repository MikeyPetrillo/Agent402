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
 * A durable local queue for ledger writes (a refund owed, a sale, a status
 * change on a debt): a row that cannot land must not vanish. Kept in the
 * ledger's own SQLite file while it is open (table pg_dead_letter), else in an
 * NDJSON file. A money write is put here WHEN IT IS QUEUED (write-ahead,
 * `add(kind, payload, { pending: true })`) and removed once Postgres holds it,
 * so a crash, a kill or a database that hangs past the shutdown flush leaves
 * the entry on disk. An entry is "pending" while this process still has its
 * write queued: the replay skips it (the queued write is about to run), and a
 * failed write `release`s it to the replay. A fresh process has no pending
 * entries. The ledger replays every entry insert-if-absent (or as the same
 * guarded UPDATE) on the next successful load, refresh and on a timer, and
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
        oldest: db.prepare("SELECT min(at) AS at FROM pg_dead_letter"),
      };
    } catch { sqlite = null; }
  }
  // NDJSON: an entry line, or a tombstone line {"removed": id} (so removing an
  // entry appends a line instead of rewriting the file on every landed write);
  // the file is rewritten without the dead lines once enough have gathered.
  let tombstones = 0;
  const readNd = () => {
    try {
      const out = new Map();
      for (const l of readFileSync(file, "utf8").split("\n")) {
        if (!l) continue;
        let e; try { e = JSON.parse(l); } catch { continue; }
        if (e && e.removed) out.delete(e.removed);
        else if (e && e.id && e.kind) out.set(e.id, e);
      }
      return [...out.values()];
    } catch { return []; }
  };
  const rewriteNd = (keep) => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, keep.map((e) => JSON.stringify(e) + "\n").join(""));
    renameSync(tmp, file);
    tombstones = 0;
  };
  const pending = new Set();
  const key = (id) => String(id);
  const all = () => {
    if (sqlite) { try { return sqlite.list.all().map((r) => ({ id: r.id, kind: r.kind, payload: JSON.parse(r.payload), at: r.at })); } catch { return []; } }
    return file ? readNd() : [];
  };
  return {
    kind: sqlite ? "sqlite" : file ? "ndjson" : "none",
    /** The entry's id once it is on local disk, else null. `pending`: this process's write for it is still queued. */
    add(kind, payload, { pending: isPending = false } = {}) {
      try {
        let id;
        if (sqlite) id = Number(sqlite.add.run(String(kind), JSON.stringify(payload), Date.now()).lastInsertRowid);
        else if (file) {
          mkdirSync(dirname(file), { recursive: true });
          id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
          appendFileSync(file, JSON.stringify({ id, kind: String(kind), payload, at: Date.now() }) + "\n");
        } else return null;
        if (isPending) pending.add(key(id));
        return id;
      } catch { return null; }
    },
    /** The queued write for this entry failed: it stays on disk for the replay. */
    release(id) { pending.delete(key(id)); },
    /** Entries the replay may land, oldest first: every entry except those whose write this process still has queued. */
    list() { return all().filter((e) => !pending.has(key(e.id))); },
    remove(id) {
      pending.delete(key(id));
      try {
        if (sqlite) { sqlite.remove.run(id); return; }
        if (!file) return;
        appendFileSync(file, JSON.stringify({ removed: id }) + "\n");
        if (++tombstones >= 200) rewriteNd(readNd());
      } catch { /* replayed again; the replay is insert-if-absent */ }
    },
    /** Every entry on disk, pending ones included. */
    size() {
      if (sqlite) { try { return sqlite.count.get().n; } catch { return 0; } }
      return file ? readNd().length : 0;
    },
    /** When the oldest entry on disk was written (ms), or null when there is none. */
    oldestAt() {
      if (sqlite) { try { return sqlite.oldest.get().at ?? null; } catch { return null; } }
      if (!file) return null;
      let m = null;
      for (const e of readNd()) if (m === null || e.at < m) m = e.at;
      return m;
    },
  };
}
/**
 * A failure that took the full time limit (a statement or connect timeout, a
 * hung database), as opposed to a refusal that answers at once.
 */
export function isSlowFailure(e) {
  return String(e?.code || "") === "57014" || /timeout/i.test(String(e?.message || e || ""));
}
/** How long, after one write timed out, later dead-lettered writes skip Postgres and stay on local disk. */
export const FAIL_FAST_MS = Number(process.env.LEDGER_FAIL_FAST_MS) || 15_000;
/**
 * The write path of one ledger in database mode. `write(label, fn, opts)`
 * queues `fn` behind every earlier write (`enqueue`), after the first load
 * (`ready`) and `before` (the refund ledger lands older dead-lettered entries
 * first, so a status change never runs ahead of the insert it changes). With
 * `kind`, the write is money that must not vanish: `payload` goes to the
 * dead-letter when the write is QUEUED and is removed once `fn` lands. Fail
 * fast: once a write times out (the database hangs rather than refuses),
 * every dead-lettered write queued in the next FAIL_FAST_MS skips Postgres
 * and resolves `onError` at once, so a queue of N writes waits one time limit,
 * not N; the replay timer keeps probing and any statement that answers ends
 * the window. Never rejects; `onFail(e)` runs on a failure.
 */
export function createLedgerWriter({ enqueue, ready, deadLetter, warnOnce, before = null, failFastMs = FAIL_FAST_MS, label = "ledger" }) {
  let fastUntil = 0;
  const writer = {
    failFastActive: () => Date.now() < fastUntil,
    /** A statement answered: the database is not hanging. */
    answered() { fastUntil = 0; },
    /** A statement failed: a timeout opens the fail-fast window. */
    failed(e) { if (isSlowFailure(e)) fastUntil = Date.now() + failFastMs; },
    write(name, fn, { kind = null, payload = null, onError = false, onFail = null } = {}) {
      const ahead = kind && deadLetter;
      const id = ahead ? deadLetter.add(kind, payload, { pending: true }) : null;
      const keep = () => {
        if (!ahead) return;
        if (id != null) deadLetter.release(id);
        else if (deadLetter.add(kind, payload) == null) console.error(`[${label}] a ${kind} could not be written to Postgres or the local dead-letter`);
      };
      return enqueue(async () => {
        if (ahead && writer.failFastActive()) { keep(); return onError; }
        try {
          await ready();
          if (before) await before();
          const v = await fn();
          writer.answered();
          if (id != null) deadLetter.remove(id);
          return v;
        } catch (e) {
          writer.failed(e);
          warnOnce(name, e);
          keep();
          try { onFail?.(e); } catch { /* best effort */ }
          return onError;
        }
      });
    },
  };
  return writer;
}
/** After this long on local disk an entry reads "stuck" (LEDGER_DEAD_LETTER_STUCK_MINUTES). */
export const DEAD_LETTER_STUCK_MINUTES = Number(process.env.LEDGER_DEAD_LETTER_STUCK_MINUTES) || 20;
/**
 * One word for the ledgers' dead-letters together (each state from a ledger's
 * deadLetterState()): "stuck" when any entry has been on local disk longer
 * than `stuckMinutes` (a write that has not reached Postgres in that time,
 * kept only on this container's disk), "pending" when an entry waits for the
 * replay, "none" otherwise; "off" without a state database. An entry whose
 * write is still queued is not "pending" (every write passes through the
 * dead-letter), but it is "stuck" once it is old.
 */
export function deadLetterWord(states, { enabled = true, now = Date.now(), stuckMinutes = DEAD_LETTER_STUCK_MINUTES } = {}) {
  if (!enabled) return "off";
  let waiting = 0, oldest = null;
  for (const s of states) {
    waiting += Number(s?.waiting) || 0;
    if (s?.oldestAt != null && (oldest == null || s.oldestAt < oldest)) oldest = s.oldestAt;
  }
  if (oldest != null && now - oldest > stuckMinutes * 60_000) return "stuck";
  return waiting > 0 ? "pending" : "none";
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
