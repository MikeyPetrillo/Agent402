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
import { createRedisJournal, redisJournalConfigured, journalRedisGateStatus, JOURNAL_LEASE_MS } from "./ledger-journal-redis.js";
import { registerMemoryStore } from "./memory-stores.js";

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
 * One mirror pull in flight per process. `run()` is the timer's call: it
 * starts a pull, or returns null while one is running. `fresh()` is for a
 * caller that needs rows written before it asked: with nothing running it
 * starts a pull; with one running (it may have read the table before the
 * caller's row landed) it waits for that pull, then joins the one follow-up
 * pull every concurrent waiter shares. Nothing here adds a timeout; each
 * query is bounded by the pool's own timeouts.
 */
export function singleFlight(fn) {
  let inflight = null, followUp = null;
  const start = () => {
    const p = Promise.resolve().then(fn).finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
    return p;
  };
  return {
    run: () => (inflight ? null : start()),
    fresh() {
      if (!inflight) return start();
      if (!followUp) followUp = inflight.then(() => {}, () => {}).then(() => { followUp = null; return inflight || start(); });
      return followUp;
    },
    busy: () => !!inflight,
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
// Every local money journal by name (sales, refunds, checkout finals,
// subscriptions, decide, outbound), so the dead-letter word on /api/gateway-status
// covers each of them. A name may have several journals (one per store
// directory); their states are summed, and two instances over the same file
// count it once (the newest instance is kept).
const journals = new Map(); // name -> Map(file -> dead letter)
/** The state of every named journal: { name: { waiting, total, oldestAt, local } } (`local`: entries on this container's disk while Redis holds the journal). */
export function journalStates() {
  const out = {};
  for (const [name, set] of journals) {
    const acc = { waiting: 0, total: 0, oldestAt: null, local: 0 };
    const seen = new Set(); // shared journals: their Redis entries counted once per key
    for (const dl of set.values()) {
      const st = dl.state();
      let { waiting, total } = st;
      if (dl.journalKey && st.shared) {
        if (seen.has(dl.journalKey)) { waiting -= st.shared.waiting; total -= st.shared.total; }
        seen.add(dl.journalKey);
      }
      acc.waiting += waiting; acc.total += total; acc.local += Number(st.local) || 0;
      if (st.oldestAt != null && (acc.oldestAt == null || st.oldestAt < acc.oldestAt)) acc.oldestAt = st.oldestAt;
    }
    out[name] = acc;
  }
  return out;
}
/** `name`: the journal's name on the dead-letter word (see journalStates). */
function createLocalDeadLetter({ db = null, file = "" } = {}) {
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
  const dl = {
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
    /** Entries waiting for the replay, every entry on disk, and when the oldest was written (null when none), from one read. */
    state() {
      if (sqlite) {
        try {
          const total = sqlite.count.get().n;
          // A queued id is on disk until its write lands (remove drops it from both).
          return { waiting: Math.max(0, total - pending.size), total, oldestAt: sqlite.oldest.get().at ?? null };
        } catch { return { waiting: 0, total: 0, oldestAt: null }; }
      }
      const entries = file ? readNd() : [];
      let oldestAt = null;
      for (const e of entries) if (oldestAt === null || e.at < oldestAt) oldestAt = e.at;
      return { waiting: entries.filter((e) => !pending.has(key(e.id))).length, total: entries.length, oldestAt };
    },
  };
  // The same surface as the shared journal (createDeadLetter), answered from disk.
  Object.assign(dl, {
    /** Entries for a replay to land (every local entry; one process owns its disk). */
    claim: async () => dl.list(),
    endClaim: async () => {},
    hasWaiting: () => dl.list().length > 0,
    entries: async () => all(),
    durable: async (id) => (id == null ? null : "local"),
    async addAsync(kind, payload, { pending: p = false, localPayload } = {}) {
      const id = dl.add(kind, localPayload ?? payload, { pending: p });
      return { id, where: id == null ? null : "local" };
    },
  });
  return dl;
}
/**
 * A money journal (see the note above createLocalDeadLetter). `name`: the
 * journal's name on the dead-letter word. `journalKey`: its identity across
 * containers (the state schema and the journal); with REDIS_URL set
 * (src/ledger-journal-redis.js) the entries live in Redis under it, shared by
 * every container on that database, and local disk (`db` / `file`) is the
 * fallback for an entry Redis did not take. Without REDIS_URL, or without a
 * key, the journal is the local one, exactly as before.
 *
 * The replay surface, the same in both modes: `drain(apply)` claims the
 * entries (in Redis: atomically, one drainer per journal, each entry leased
 * to it), runs `apply(entry)` on each in order, and removes an entry only
 * after `apply` resolved "landed" or "drop" (its database write committed, or
 * it can never land); "keep" leaves it, "stop" (or a throw) ends the pass.
 * Entries it did not remove are freed for the next claim.
 */
export function createDeadLetter({ db = null, file = "", name = "", journalKey = "" } = {}) {
  const local = createLocalDeadLetter({ db, file });
  const dl = journalKey && redisJournalConfigured() ? createSharedDeadLetter(local, createRedisJournal({ key: journalKey })) : local;
  dl.drain = (apply) => drainJournal(dl, apply);
  if (name) { if (!journals.has(name)) journals.set(name, new Map()); journals.get(name).set(String(db?.name || "") + "\u0000" + String(file || "") + "\u0000" + String(journalKey || ""), dl); }
  return dl;
}
/** See createDeadLetter. Resolves how many entries landed. */
export async function drainJournal(dl, apply) {
  const entries = await dl.claim();
  let landed = 0;
  try {
    for (const e of entries) {
      const r = await apply(e);
      if (r === "stop") break;
      if (r !== "landed" && r !== "drop") continue; // "keep"
      // Removed only now: the entry's write has committed (or never can).
      await dl.remove(e.id);
      if (r === "landed") landed++;
    }
  } finally { await dl.endClaim(); }
  return landed;
}
// Journal writes to Redis not answered yet, across every shared journal.
const journalWrites = new Set();
/** Resolves once every journal write this process started has landed in Redis or on local disk (shutdown). */
export function flushJournals() { return Promise.allSettled([...journalWrites]).then(() => {}); }
/** How often a shared journal renews what it holds and re-reads its counts. */
const sharedTickMs = () => Math.max(50, Math.min(5_000, Math.floor(JOURNAL_LEASE_MS() / 3)));
/**
 * The Redis-backed journal (see createDeadLetter): an entry goes to Redis,
 * else to `local`. Ids of entries on local disk read "L:<id>". The counts the
 * dead-letter word reads are kept from the last read of Redis plus the
 * changes this process made since.
 */
function createSharedDeadLetter(local, rj) {
  const held = new Map(); // id -> { pending, settled, where (Promise), at, localId }
  const claimed = new Set(); // Redis ids this process holds for a replay
  let snap = { total: 0, pending: 0, oldestAt: null };
  let opSeq = 0;
  let deltas = []; // { seq, dt, dp, at } committed in Redis after the snapshot's read began
  const delta = (dt, dp, at = null) => { deltas.push({ seq: ++opSeq, dt, dp, at }); };
  let refreshing = null;
  const refresh = () => {
    if (refreshing) return refreshing;
    const mark = opSeq;
    refreshing = rj.state().then((s) => { snap = s; deltas = deltas.filter((d) => d.seq > mark); }, () => {}).finally(() => { refreshing = null; });
    return refreshing;
  };
  const isLocal = (id) => typeof id === "string" && id.startsWith("L:");
  const localIdOf = (id) => { const v = String(id).slice(2); return /^\d+$/.test(v) ? Number(v) : v; };
  const tick = setInterval(() => {
    const ids = [...claimed];
    for (const [id, h] of held) if (h.pending && h.settled === "redis") ids.push(id);
    rj.renew(ids).catch(() => {}).finally(() => { refresh(); });
  }, sharedTickMs());
  tick.unref?.();
  refresh();
  const dl = {
    kind: "redis",
    journalKey: rj.key,
    add(kind, payload, { pending = false, localPayload } = {}) {
      const at = Date.now();
      const id = `${at.toString(36)}-${randomBytes(6).toString("hex")}`;
      const h = { pending, settled: null, at, localId: null };
      held.set(id, h);
      h.where = (async () => {
        if (!rj.down()) {
          try { await rj.add({ id, kind: String(kind), payload, at }, { pending: h.pending }); delta(1, h.pending ? 1 : 0, at); return "redis"; }
          catch { /* local disk below */ }
        }
        const lid = local.add(kind, localPayload ?? payload, { pending: h.pending });
        if (lid == null) return null;
        h.localId = lid;
        return "local";
      })().then((w) => {
        journalWrites.delete(h.where);
        h.settled = w;
        if (w === null) { held.delete(id); console.error(`[ledger-journal] a ${kind} could not be kept in Redis or on local disk`); }
        return w;
      });
      journalWrites.add(h.where);
      return id;
    },
    /** Where the entry landed: "redis" (shared), "local" (this container's disk) or null. */
    durable: (id) => (held.get(id)?.where ?? Promise.resolve(isLocal(id) ? "local" : null)),
    async addAsync(kind, payload, opts = {}) {
      const id = dl.add(kind, payload, opts);
      const where = await dl.durable(id);
      return { id: where ? (where === "local" ? `L:${held.get(id)?.localId}` : id) : null, where };
    },
    release(id) {
      const h = held.get(id);
      if (!h) return;
      const was = h.pending;
      h.pending = false;
      h.where.then((w) => {
        held.delete(id);
        if (w === "local") local.release(h.localId);
        else if (w === "redis" && was) return rj.release([id]).then(() => delta(0, -1));
      }).catch(() => { /* the entry's lease lapses and the next claim takes it */ });
    },
    async remove(id) {
      try {
        if (isLocal(id)) { local.remove(localIdOf(id)); return; }
        const h = held.get(id);
        if (h) {
          held.delete(id);
          const w = await h.where;
          if (w === "local") { local.remove(h.localId); return; }
          if (w !== "redis") return;
        }
        claimed.delete(id);
        await rj.remove([id]);
        delta(-1, h?.pending ? -1 : 0);
      } catch { /* left in the journal: the replay lands it again, insert-if-absent */ }
    },
    /** Entries on this container's disk (ids "L:<id>"), excluding writes still queued here. */
    list: () => local.list().map((e) => ({ ...e, id: `L:${e.id}` })),
    async claim() {
      let shared = [];
      try { shared = await rj.claim(); for (const e of shared) claimed.add(e.id); } catch { shared = []; }
      const disk = dl.list();
      if (!disk.length) return shared;
      // Oldest first across both (each is in its own order already).
      const out = [];
      let i = 0, j = 0;
      while (i < shared.length || j < disk.length) {
        if (j >= disk.length || (i < shared.length && Number(shared[i].at) <= Number(disk[j].at))) out.push(shared[i++]);
        else out.push(disk[j++]);
      }
      return out;
    },
    async endClaim() {
      const ids = [...claimed];
      claimed.clear();
      try { await rj.release(ids, { unlock: true }); } catch { /* their leases lapse */ }
      await refresh();
    },
    /** Every entry (Redis and this disk), without claiming any; `strict`: throws when Redis cannot be read. */
    async entries({ strict = false } = {}) {
      let shared = [];
      try { shared = await rj.entries(); } catch (e) { if (strict) throw e; shared = []; }
      return [...shared, ...(await local.entries()).map((e) => ({ ...e, id: `L:${e.id}` }))];
    },
    hasWaiting: () => dl.state().waiting > 0,
    size: () => dl.state().total,
    oldestAt: () => dl.state().oldestAt,
    /** { waiting, total, oldestAt, local }: `local` counts entries on this container's disk that wait for the replay (not a write still queued here). */
    state() {
      const ls = local.state();
      let dt = 0, dp = 0, oldest = snap.oldestAt;
      for (const d of deltas) { dt += d.dt; dp += d.dp; if (d.at != null && (oldest == null || d.at < oldest)) oldest = d.at; }
      let inflight = 0, inflightPending = 0;
      for (const h of held.values()) {
        if (h.settled !== null) continue;
        inflight++; if (h.pending) inflightPending++;
        if (oldest == null || h.at < oldest) oldest = h.at;
      }
      const rTotal = Math.max(0, snap.total + dt) + inflight;
      const rPending = Math.min(rTotal, Math.max(0, snap.pending + dp) + inflightPending);
      if (ls.oldestAt != null && (oldest == null || ls.oldestAt < oldest)) oldest = ls.oldestAt;
      if (rTotal === 0 && ls.total === 0) oldest = null;
      return { waiting: rTotal - rPending + ls.waiting, total: rTotal + ls.total, oldestAt: oldest, local: ls.waiting, shared: { waiting: rTotal - rPending, total: rTotal } };
    },
    /** Re-read the shared counts now (tests; the timer does this). */
    refresh,
  };
  return dl;
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
        // The fail-fast shortcut only for a write already on local disk: one
        // whose append failed is kept nowhere else, so it tries Postgres.
        if (ahead && id != null && writer.failFastActive()) { keep(); return onError; }
        try {
          // A shared journal's write-ahead entry is in Redis (or on local
          // disk) before the write it guards runs.
          if (id != null) await deadLetter.durable?.(id);
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
 * One word for the ledgers' dead-letters together (each state from
 * journalStates(), one per journal's dead-letter): "stuck" when any entry has been on local disk longer
 * than `stuckMinutes` (a write that has not reached Postgres in that time,
 * kept only on this container's disk), "pending" when an entry waits for the
 * replay, "none" otherwise; "off" without a state database. An entry whose
 * write is still queued is not "pending" (every write passes through the
 * dead-letter), but it is "stuck" once it is old. "local": the journals are
 * kept in Redis (REDIS_URL) but an entry sits on this container's disk
 * because Redis did not take it, so it dies with the container; it pages
 * like "stuck" (after "stuck", before "pending").
 */
export function deadLetterWord(states, { enabled = true, now = Date.now(), stuckMinutes = DEAD_LETTER_STUCK_MINUTES } = {}) {
  if (!enabled) return "off";
  let waiting = 0, oldest = null, onLocalDisk = 0;
  for (const s of states) {
    waiting += Number(s?.waiting) || 0;
    onLocalDisk += Number(s?.local) || 0;
    if (s?.oldestAt != null && (oldest == null || s.oldestAt < oldest)) oldest = s.oldestAt;
  }
  if (oldest != null && now - oldest > stuckMinutes * 60_000) return "stuck";
  if (onLocalDisk > 0) return "local";
  return waiting > 0 ? "pending" : "none";
}
/** The journals the dead-letter word always names (zeros when one is not open). */
export const MONEY_JOURNALS = ["sales", "refunds", "checkoutFinals", "subscriptions", "decide", "outbound"];
/**
 * ledgerDeadLetter on /api/gateway-status: one word over every money
 * journal (see deadLetterWord); `full` (the operator) adds the counts per
 * journal (`onDisk`: every entry kept, in Redis or on disk; `onLocalDisk`:
 * the ones on this container's disk) and `journalRedis`: where a new entry
 * lands now and, when that is local disk with the Redis journal configured,
 * why (the persistence gate, src/ledger-journal-redis.js). Never an id, an
 * amount or a payload.
 */
export function ledgerDeadLetterStatus({ full = false, enabled = true, now = Date.now(), stuckMinutes = DEAD_LETTER_STUCK_MINUTES } = {}) {
  const states = journalStates();
  for (const n of MONEY_JOURNALS) if (!states[n]) states[n] = { waiting: 0, total: 0, oldestAt: null };
  const status = deadLetterWord(Object.values(states), { enabled, now, stuckMinutes });
  if (!full) return { status };
  const age = (s) => (s.oldestAt == null ? null : Math.floor((now - s.oldestAt) / 60_000));
  const out = { status, stuckMinutes, journalRedis: journalRedisGateStatus({ now }) };
  for (const [n, s] of Object.entries(states)) out[n] = { waiting: s.waiting, onDisk: s.total, onLocalDisk: Number(s.local) || 0, oldestMinutes: age(s) };
  return out;
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

// Operator heap read (/__operator/heap.json `stores`).
registerMemoryStore("ledger-mirror.journals", () => journals, { note: "dead-letter journals" });
