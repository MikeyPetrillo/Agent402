// Memory v2 — the stateful coordination layer for stateless agents.
//
// A single, ephemeral, sandboxed agent cannot give itself any of this: durable
// state, a portable identity (the paying wallet IS the account — no signup),
// a place OTHER agents can reach (shared namespaces via grants), atomic
// coordination primitives (counters/locks), tamper-evident history, or a
// similarity index. That is the part that is not vibe-codable.
//
// Everything is namespaced by a wallet address. Access to a namespace you do
// not own requires an explicit grant from the owner — so cross-agent sharing is
// opt-in and authenticated by x402 payment identity.
//
// Two backends behind one API:
//   - SQLite (better-sqlite3) in the agent402.db file on the volume: every
//     export is synchronous, exactly as before.
//   - The state database (src/state-db.js) when STATE_DATABASE_URL is set:
//     the same four tables live in Postgres, the SQLite file is imported once
//     at the first boot, and EVERY export returns a promise (buyers pay per
//     write, so a write resolves only after the database has it; nothing is
//     queued or fire-and-forget). The route handlers in src/server.js await
//     each call, so they serve both shapes unchanged. After each committed
//     write the same statements are replayed into the SQLite file (when its
//     directory exists; best effort, never the verdict), so a rollback to the
//     file-only build serves current memory. Reads stay on Postgres.
import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanPgText, stateDbEnabled, stateDbSchema, stateQuery, withStateTx, importOnce, trackStoreReady, withSchemaLock } from "../state-db.js";
import { retryingLoad } from "../store-retry.js";

// Memory is the WORST case for a silent /data → /tmp fallback: agents pay
// USDC per write, and the value of that storage is precisely its durability
// across restarts. Mirror the same fail-loud contract as pow.js + stats.js —
// refuse to boot in production without /data unless an explicit opt-out is
// set (local tests, FREE_MODE sweeps, edge runners). Without this gate a
// misconfigured deploy would charge buyers for memory that vanishes on the
// next container restart. With the state database on, durability is the
// database's, so the volume is not required.
const USE_PG = stateDbEnabled();
const HAS_DATA_DIR = existsSync("/data");
const ALLOW_EPHEMERAL =
  process.env.MEMORY_ALLOW_EPHEMERAL === "true" ||
  process.env.FREE_MODE === "true" ||
  process.env.NODE_ENV !== "production";
if (!USE_PG && !HAS_DATA_DIR && !ALLOW_EPHEMERAL) {
  console.error(
    "Memory DB has no persistent volume (/data missing) and NODE_ENV=production. Mount /data, or set MEMORY_ALLOW_EPHEMERAL=true to accept losing paid agent memory on restart."
  );
  process.exit(1);
}
const DATA_DIR = HAS_DATA_DIR ? "/data" : "/tmp";
// The SQLite file: the store without a database, the one-time import source with one.
const DB_FILE = String(process.env.MEMORY_DB_FILE || "").trim() || join(DATA_DIR, "agent402.db");
export const PERSISTENT = USE_PG || HAS_DATA_DIR;
/** "pg" when the state database holds memory, "sqlite" otherwise. */
export const BACKEND = USE_PG ? "pg" : "sqlite";

const MAX_KEY = 256;
const MAX_VALUE = 64 * 1024;
// Per-namespace key cap. Env-tunable and read at call time (same contract as
// MAX_NS_BYTES below) so tests can exercise the quota without 10k writes.
// 413, not 400: the request is well-formed — the store is full.
const MAX_KEYS_PER_NS = () => Number(process.env.MEMORY_MAX_NS_KEYS) || 10000;
const MAX_DOCS_PER_NS = 2000;
const MAX_DOC_TEXT = 8 * 1024;
const EMBED_DIM = 256;

const now = () => Date.now();
const nowSec = () => Math.floor(Date.now() / 1000);

function bad(message, code = 400) {
  const err = new Error(message);
  err.statusCode = code;
  return err;
}

// The key-count cap alone doesn't bound DISK: 10k keys × 64KB values is
// 640MB per wallet, and a handful of cheap wallets could fill the /data
// volume — which the stats/PoW/memory databases all share, so a full disk
// takes down the serving path, not just memory. Budget the namespace's
// TOTAL stored value bytes too. Env-tunable (read at call time so tests can
// shrink it); expired rows are reclaimed before rejecting, same as the
// key-count path. 413 = the request is fine, the store is full.
const MAX_NS_BYTES = () => Number(process.env.MEMORY_MAX_NS_BYTES) || 32 * 1024 * 1024;

// --- shared pure helpers (both backends) ----------------------------------

const VERIFY_RULE =
  "hash[i] = sha256(prevHash + '|' + seq + '|' + ts + '|' + actor + '|' + action + '|' + (key||'') + '|' + (JSON.stringify(data)||''))";

function chainHash(prev, seq, ts, actor, action, key, data) {
  return createHash("sha256")
    .update(`${prev}|${seq}|${ts}|${actor}|${action}|${key ?? ""}|${data ?? ""}`)
    .digest("hex");
}

function accessError(owner, actor, need) {
  return bad(
    owner === actor
      ? "No payer identity on this request"
      : `Wallet ${actor} has no ${need} grant on namespace ${owner}`,
    403
  );
}

function grantAllows(g, need) {
  if (!g) return false;
  if (g.exp && g.exp < nowSec()) return false;
  return need === "write" ? g.mode === "readwrite" : true;
}

// The state database stores no U+0000 and no unpaired surrogate (state-db.js
// cleans both out of every parameter). Written text that cleaning would change
// is refused (400) in both backends, so a stored value always reads back as
// written and a namespace moves between backends unchanged.
function storable(s, what) {
  if (typeof s === "string" && cleanPgText(s) !== s) throw bad(`${what} must not contain NUL (U+0000) characters or unpaired surrogates`);
  return s;
}

function checkKey(key, message = `"key" must be a non-empty string of at most ${MAX_KEY} chars`) {
  if (typeof key !== "string" || !key || key.length > MAX_KEY) throw bad(message);
  storable(key, '"key"');
}

function serializeValue(value, message = `"value" is required and must serialize to at most ${MAX_VALUE} bytes`) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized === undefined || serialized.length > MAX_VALUE) throw bad(message);
  return storable(serialized, '"value"');
}

function expiryOf(ttlSeconds) {
  if (ttlSeconds === undefined || ttlSeconds === null) return null;
  const t = parseInt(ttlSeconds, 10);
  if (!Number.isFinite(t) || t <= 0) throw bad('"ttlSeconds" must be a positive integer');
  return nowSec() + t;
}

function parseStored(v) {
  try { return JSON.parse(v); } catch { return v; }
}

function freshKv(row) {
  if (!row) return null;
  if (row.exp && row.exp < nowSec()) return null;
  return row;
}

function logEntry(r) {
  return {
    seq: r.seq,
    ts: r.ts,
    actor: r.actor,
    action: r.action,
    key: r.key,
    data: r.data ? JSON.parse(r.data) : null,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

function grantEntry(r) {
  return { grantee: r.grantee, mode: r.mode, created: r.created, expiresAt: r.exp, active: !r.exp || r.exp >= nowSec() };
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
function checkGrant(owner, grantee, mode, ttlSeconds) {
  if (typeof grantee !== "string" || !ADDR.test(grantee)) throw bad('"grantee" must be a 0x wallet address');
  const g = grantee.toLowerCase();
  if (g === owner) throw bad("You already own this namespace");
  if (mode !== "read" && mode !== "readwrite") throw bad('"mode" must be "read" or "readwrite"');
  return { g, exp: expiryOf(ttlSeconds) };
}
function checkGrantee(grantee) {
  if (typeof grantee !== "string" || !ADDR.test(grantee)) throw bad('"grantee" must be a 0x wallet address');
  return grantee.toLowerCase();
}

// --- similarity recall (local embeddings; pluggable provider) -------------

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function l2normalize(arr) {
  let norm = 0;
  for (const x of arr) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return arr.map((x) => +(x / norm).toFixed(6));
}

/**
 * Deterministic local embedding: L2-normalized hashed bag of unigrams+bigrams
 * (the hashing trick with signed buckets). No external service or key.
 */
function embedLocal(text) {
  const vec = new Float64Array(EMBED_DIM);
  const tokens = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  const grams = [...tokens];
  for (let i = 0; i < tokens.length - 1; i++) grams.push(tokens[i] + "_" + tokens[i + 1]);
  for (const tok of grams) {
    const h = fnv1a(tok) % EMBED_DIM;
    const sign = fnv1a(tok + "#") & 1 ? 1 : -1;
    vec[h] += sign;
  }
  return l2normalize(Array.from(vec));
}

// Optional real embeddings provider (OpenAI-compatible /embeddings shape:
// Voyage, OpenAI, Together, DeepInfra, etc.). Configure to upgrade recall from
// lexical to true semantic similarity without touching callers.
const EMBEDDINGS_URL = process.env.EMBEDDINGS_URL || "";
const EMBEDDINGS_MODEL = process.env.EMBEDDINGS_MODEL || "text-embedding-3-small";
const EMBEDDINGS_KEY = process.env.EMBEDDINGS_API_KEY || "";
export const EMBEDDER = EMBEDDINGS_URL ? `provider:${EMBEDDINGS_MODEL}` : "local-v1";

async function embedRemote(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(EMBEDDINGS_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(EMBEDDINGS_KEY ? { Authorization: `Bearer ${EMBEDDINGS_KEY}` } : {}),
      },
      body: JSON.stringify({ model: EMBEDDINGS_MODEL, input: text }),
    });
    if (!res.ok) throw new Error(`embeddings provider HTTP ${res.status}`);
    const json = await res.json();
    const vec = json?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || !vec.length) throw new Error("embeddings provider returned no vector");
    return l2normalize(vec);
  } catch (e) {
    throw Object.assign(new Error(`Embedding failed: ${e.message}`), { statusCode: 502 });
  } finally {
    clearTimeout(timer);
  }
}

/** Embed text into an L2-normalized vector. Returns { vec, model }. */
async function embedText(text) {
  if (EMBEDDINGS_URL) return { vec: await embedRemote(text), model: EMBEDDER };
  return { vec: embedLocal(text), model: EMBEDDER };
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length && i < b.length; i++) dot += a[i] * b[i];
  return dot; // both are L2-normalized
}

let docSeq = 0;
function newDocId() {
  // Crypto-random entropy segment so doc IDs don't collide (collisions would
  // ON CONFLICT-overwrite a prior doc in the same namespace).
  return `${nowSec().toString(36)}${(docSeq++ & 0xffff).toString(36)}${randomBytes(6).toString("hex")}`;
}

function checkDocText(text) {
  if (typeof text !== "string" || !text.trim()) throw bad('"text" is required');
  if (text.length > MAX_DOC_TEXT) throw bad(`"text" exceeds ${MAX_DOC_TEXT} chars`);
  storable(text, '"text"');
}

/** Rank stored docs against a query vector; only docs from the same embedder compare. */
function rankDocs(docs, qv, model, topK, owner, query) {
  const comparable = docs.filter((d) => (d.model ?? "local-v1") === model);
  const scored = comparable.map((d) => ({
    id: d.id,
    score: +cosine(qv, JSON.parse(d.vec)).toFixed(4),
    text: d.text,
    meta: d.meta ? JSON.parse(d.meta) : null,
    updated: d.updated,
  }));
  scored.sort((a, b) => b.score - a.score);
  const out = { owner, query, embedder: model, results: scored.slice(0, topK).filter((r) => r.score > 0) };
  const skipped = docs.length - comparable.length;
  if (skipped > 0) out.note = `${skipped} doc(s) embedded with a different model were skipped; re-remember them to use ${model}.`;
  return out;
}

const topKOf = (k) => Math.min(Math.max(parseInt(k, 10) || 5, 1), 50);
const logLimitOf = (limit) => Math.min(Math.max(limit, 1), 1000);

// SQLite table DDL. The file backend creates it; the Postgres import reads
// the same tables from the file.
const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS kv (
    ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL,
    updated INTEGER NOT NULL, exp INTEGER,
    PRIMARY KEY (ns, k)
  );
  CREATE TABLE IF NOT EXISTS grants (
    owner TEXT NOT NULL, grantee TEXT NOT NULL, mode TEXT NOT NULL,
    created INTEGER NOT NULL, exp INTEGER,
    PRIMARY KEY (owner, grantee)
  );
  CREATE TABLE IF NOT EXISTS memlog (
    ns TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
    actor TEXT NOT NULL, action TEXT NOT NULL, key TEXT,
    data TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
    PRIMARY KEY (ns, seq)
  );
  CREATE TABLE IF NOT EXISTS docs (
    ns TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL,
    meta TEXT, vec TEXT NOT NULL, model TEXT, updated INTEGER NOT NULL,
    PRIMARY KEY (ns, id)
  );
  CREATE TABLE IF NOT EXISTS requests (
    ns TEXT NOT NULL, rid TEXT NOT NULL, fp TEXT NOT NULL, result TEXT NOT NULL, ts INTEGER NOT NULL,
    PRIMARY KEY (ns, rid)
  );
`;

// ---- client request ids (retry-safe writes) ----------------------------------
// A paid write whose answer was lost (the commit landed, the reply did not) is
// retried by the client; without an id the retry applies again (an incr counts
// twice). With an optional client request id (body "requestId" or header
// X-Memory-Request-Id) the first write stores its answer under (namespace,
// actor + id) in the same transaction as the write, and a repeat returns that
// answer marked `replayed`, applying nothing. The same id for a different
// write is refused (409). Ids are kept REQUEST_ID_TTL_MS.
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const REQUEST_ID_TTL_MS = 24 * 3600 * 1000;
function requestIdOf(v) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v);
  if (!REQUEST_ID_RE.test(s)) throw bad('"requestId" must be 1-128 characters: letters, digits, ".", "_", ":" or "-"');
  return s;
}
const requestKey = (actor, rid) => `${actor}\n${rid}`;
const requestFp = (op, key, args) => createHash("sha256").update(JSON.stringify([op, key ?? null, args ?? null])).digest("hex");
function replayStored(row, fp) {
  if (row.fp !== fp) throw bad('"requestId" was already used for a different write; use a new id for each new write', 409);
  return { ...JSON.parse(row.result), replayed: true };
}

// =========================================================================
// SQLite backend: the file on the volume, synchronous, as it always was.
// =========================================================================
/** Open the SQLite file read-write with the tables in place (older files migrated). */
function openSqlite() {
  const db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");
  db.exec(SQLITE_DDL);

  // Migrate older tables in place if needed.
  const kvCols = db.prepare("PRAGMA table_info(kv)").all().map((c) => c.name);
  if (!kvCols.includes("exp")) db.exec("ALTER TABLE kv ADD COLUMN exp INTEGER");
  const docCols = db.prepare("PRAGMA table_info(docs)").all().map((c) => c.name);
  if (!docCols.includes("model")) db.exec("ALTER TABLE docs ADD COLUMN model TEXT");
  // After migrations so the column is guaranteed to exist on older databases.
  db.exec("CREATE INDEX IF NOT EXISTS kv_exp ON kv (exp) WHERE exp IS NOT NULL");
  return db;
}

// The SQLite statements, by name: the file backend runs them directly; the
// Postgres backend replays them into the file after each commit.
function sqliteStatements(db) {
  return {
    kvPut: db.prepare(
      "INSERT INTO kv (ns, k, v, updated, exp) VALUES (@ns, @k, @v, @updated, @exp) " +
        "ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, updated = excluded.updated, exp = excluded.exp"
    ),
    kvDel: db.prepare("DELETE FROM kv WHERE ns = ? AND k = ?"),
    kvPruneExpired: db.prepare("DELETE FROM kv WHERE ns = ? AND exp IS NOT NULL AND exp < ?"),
    kvPruneAll: db.prepare("DELETE FROM kv WHERE exp IS NOT NULL AND exp < ?"),
    grantPut: db.prepare(
      "INSERT INTO grants (owner, grantee, mode, created, exp) VALUES (@owner, @grantee, @mode, @created, @exp) " +
        "ON CONFLICT(owner, grantee) DO UPDATE SET mode = excluded.mode, created = excluded.created, exp = excluded.exp"
    ),
    grantDel: db.prepare("DELETE FROM grants WHERE owner = ? AND grantee = ?"),
    logIns: db.prepare(
      "INSERT INTO memlog (ns, seq, ts, actor, action, key, data, prev_hash, hash) " +
        "VALUES (@ns, @seq, @ts, @actor, @action, @key, @data, @prev_hash, @hash)"
    ),
    docPut: db.prepare(
      "INSERT INTO docs (ns, id, text, meta, vec, model, updated) VALUES (@ns, @id, @text, @meta, @vec, @model, @updated) " +
        "ON CONFLICT(ns, id) DO UPDATE SET text = excluded.text, meta = excluded.meta, vec = excluded.vec, model = excluded.model, updated = excluded.updated"
    ),
    docDel: db.prepare("DELETE FROM docs WHERE ns = ? AND id = ?"),
  };
}

function sqliteBackend() {
  const db = openSqlite();

  function assertByteBudget(owner, key, incomingBytes) {
    const existing = kvGet.get(owner, key);
    const delta = incomingBytes - (existing ? existing.v.length : 0);
    if (delta <= 0) return; // shrinking or same-size overwrite always allowed
    if (kvBytes.get(owner).b + delta > MAX_NS_BYTES()) {
      kvPruneExpired.run(owner, nowSec());
      if (kvBytes.get(owner).b + delta > MAX_NS_BYTES()) {
        throw bad(`Namespace byte budget exceeded (${MAX_NS_BYTES()} bytes of stored values) - delete keys, shrink values, or let TTLs expire`, 413);
      }
    }
  }

  // --- statements -----------------------------------------------------------
  const { kvPut, kvDel, kvPruneExpired, kvPruneAll, grantPut, grantDel, logIns, docPut, docDel } = sqliteStatements(db);
  const kvGet = db.prepare("SELECT v, updated, exp FROM kv WHERE ns = ? AND k = ?");
  const kvList = db.prepare("SELECT k, updated, exp FROM kv WHERE ns = ? ORDER BY updated DESC LIMIT 1000");
  const kvCount = db.prepare("SELECT COUNT(*) AS n FROM kv WHERE ns = ?");
  const kvBytes = db.prepare("SELECT COALESCE(SUM(LENGTH(v)), 0) AS b FROM kv WHERE ns = ?");
  const reqGet = db.prepare("SELECT fp, result FROM requests WHERE ns = ? AND rid = ?");
  const reqPut = db.prepare("INSERT INTO requests (ns, rid, fp, result, ts) VALUES (?, ?, ?, ?, ?)");
  const reqPrune = db.prepare("DELETE FROM requests WHERE ns = ? AND ts < ?");
  /** Run a write once per client request id (see requestIdOf); without an id, just run it. */
  const once = (op, owner, actor, key, args, requestId, fn) => {
    const rid = requestIdOf(requestId);
    if (!rid) return fn();
    return db.transaction(() => {
      const k = requestKey(actor, rid), fp = requestFp(op, key, args);
      const hit = reqGet.get(owner, k);
      if (hit) return replayStored(hit, fp);
      const out = fn();
      reqPrune.run(owner, now() - REQUEST_ID_TTL_MS);
      reqPut.run(owner, k, fp, JSON.stringify(out), now());
      return out;
    })();
  };

  // Expired rows in namespaces nobody reads anymore would otherwise live forever
  // on the persistent volume — sweep globally on a timer (cheap: exp is indexed).
  setInterval(() => {
    try {
      kvPruneAll.run(nowSec());
    } catch {
      /* best-effort */
    }
  }, 10 * 60 * 1000).unref();

  const grantGet = db.prepare("SELECT mode, exp FROM grants WHERE owner = ? AND grantee = ?");
  const grantList = db.prepare("SELECT grantee, mode, created, exp FROM grants WHERE owner = ?");

  const logLast = db.prepare("SELECT seq, hash FROM memlog WHERE ns = ? ORDER BY seq DESC LIMIT 1");
  const logRead = db.prepare("SELECT seq, ts, actor, action, key, data, prev_hash, hash FROM memlog WHERE ns = ? ORDER BY seq ASC LIMIT ?");

  const docCount = db.prepare("SELECT COUNT(*) AS n FROM docs WHERE ns = ?");
  const docAll = db.prepare("SELECT id, text, meta, vec, model, updated FROM docs WHERE ns = ?");

  // --- access control -------------------------------------------------------

  function authorize(owner, actor, need /* "read" | "write" */) {
    if (owner === actor) return true;
    return grantAllows(grantGet.get(owner, actor), need);
  }

  function requireAccess(owner, actor, need) {
    if (!authorize(owner, actor, need)) throw accessError(owner, actor, need);
  }

  // --- tamper-evident audit chain ------------------------------------------

  function appendLog(ns, actor, action, key, dataObj) {
    const last = logLast.get(ns);
    const seq = (last?.seq ?? 0) + 1;
    const prev = last?.hash ?? "";
    const ts = now();
    const data = dataObj === undefined ? null : JSON.stringify(dataObj);
    const hash = chainHash(prev, seq, ts, actor, action, key, data);
    logIns.run({ ns, seq, ts, actor, action, key: key ?? null, data, prev_hash: prev, hash });
    return { seq, hash };
  }

  function getLog(owner, actor, limit = 100) {
    requireAccess(owner, actor, "read");
    const rows = logRead.all(owner, logLimitOf(limit));
    return { ns: owner, entries: rows.map(logEntry), verify: VERIFY_RULE, persistent: PERSISTENT };
  }

  // --- key/value with TTL ---------------------------------------------------

  function memoryPut(owner, key, value, { actor = owner, ttlSeconds, requestId } = {}) {
    return once("put", owner, actor, key, [value === undefined ? null : value, ttlSeconds ?? null], requestId, () => memoryPutNow(owner, key, value, { actor, ttlSeconds }));
  }
  function memoryPutNow(owner, key, value, { actor = owner, ttlSeconds } = {}) {
    requireAccess(owner, actor, "write");
    checkKey(key);
    const serialized = serializeValue(value);
    if (kvCount.get(owner).n >= MAX_KEYS_PER_NS() && !kvGet.get(owner, key)) {
      // Expired rows must not consume quota — reclaim before rejecting.
      kvPruneExpired.run(owner, nowSec());
      if (kvCount.get(owner).n >= MAX_KEYS_PER_NS()) throw bad(`Namespace is full (${MAX_KEYS_PER_NS()} keys)`, 413);
    }
    assertByteBudget(owner, key, serialized.length);
    const exp = expiryOf(ttlSeconds);
    const updated = now();
    kvPut.run({ ns: owner, k: key, v: serialized, updated, exp });
    appendLog(owner, actor, "put", key, { bytes: serialized.length, exp });
    return { key, bytes: serialized.length, updated, expiresAt: exp, owner, persistent: PERSISTENT };
  }

  function memoryGet(owner, key, { actor = owner } = {}) {
    requireAccess(owner, actor, "read");
    if (!key) {
      kvPruneExpired.run(owner, nowSec());
      return { keys: kvList.all(owner).filter((r) => !(r.exp && r.exp < nowSec())), owner, persistent: PERSISTENT };
    }
    const row = freshKv(kvGet.get(owner, key));
    if (!row) throw bad("Key not found", 404);
    return { key, value: parseStored(row.v), updated: row.updated, expiresAt: row.exp, owner, persistent: PERSISTENT };
  }

  function memoryDelete(owner, key, { actor = owner, requestId } = {}) {
    return once("delete", owner, actor, key, null, requestId, () => memoryDeleteNow(owner, key, { actor }));
  }
  function memoryDeleteNow(owner, key, { actor = owner } = {}) {
    requireAccess(owner, actor, "write");
    if (!key) throw bad('"key" is required');
    const deleted = kvDel.run(owner, key).changes > 0;
    if (deleted) appendLog(owner, actor, "delete", key);
    return { key, deleted, owner };
  }

  /** Atomic numeric counter — a coordination primitive only a shared store can offer. */
  const memoryIncr = (owner, key, by, actor, { requestId } = {}) => once("incr", owner, actor, key, [by === undefined ? 1 : by], requestId, () => memoryIncrNow(owner, key, by, actor));
  const memoryIncrNow = db.transaction((owner, key, by, actor) => {
    requireAccess(owner, actor, "write");
    checkKey(key, `Invalid "key"`);
    const amount = by === undefined ? 1 : Number(by);
    if (!Number.isFinite(amount)) throw bad('"by" must be a number');
    const row = freshKv(kvGet.get(owner, key));
    let current = 0;
    if (row) {
      const n = Number(row.v);
      if (!Number.isFinite(n)) throw bad(`Key "${key}" holds a non-numeric value; cannot increment`);
      current = n;
    } else if (kvCount.get(owner).n >= MAX_KEYS_PER_NS()) {
      kvPruneExpired.run(owner, nowSec());
      if (kvCount.get(owner).n >= MAX_KEYS_PER_NS()) throw bad(`Namespace is full (${MAX_KEYS_PER_NS()} keys)`, 413);
    }
    const next = current + amount;
    kvPut.run({ ns: owner, k: key, v: String(next), updated: now(), exp: row?.exp ?? null });
    appendLog(owner, actor, "incr", key, { by: amount, value: next });
    return { key, value: next, owner };
  });

  /** Atomic compare-and-set (see the export's doc comment). */
  const memoryCas = (owner, key, expected, value, { actor = owner, ttlSeconds, hasValue = false, requestId } = {}) =>
    once("cas", owner, actor, key, [expected ?? null, hasValue ? value ?? null : "\u0000absent", ttlSeconds ?? null], requestId, () => memoryCasNow(owner, key, expected, value, { actor, ttlSeconds, hasValue }));
  const memoryCasNow = db.transaction((owner, key, expected, value, { actor = owner, ttlSeconds, hasValue = false } = {}) => {
    requireAccess(owner, actor, "write");
    checkKey(key);
    const row = freshKv(kvGet.get(owner, key));
    const current = row ? parseStored(row.v) : null;
    const want = expected === undefined ? null : expected;
    if (JSON.stringify(current) !== JSON.stringify(want)) {
      return { key, swapped: false, value: current, owner };
    }
    // Matched → release (no value supplied) or write the new value.
    if (!hasValue || value === undefined) {
      const deleted = kvDel.run(owner, key).changes > 0;
      if (deleted) appendLog(owner, actor, "cas-del", key, { expected: want });
      return { key, swapped: true, value: null, owner };
    }
    const serialized = serializeValue(value, `"value" must serialize to at most ${MAX_VALUE} bytes`);
    if (!row && kvCount.get(owner).n >= MAX_KEYS_PER_NS()) {
      kvPruneExpired.run(owner, nowSec());
      if (kvCount.get(owner).n >= MAX_KEYS_PER_NS()) throw bad(`Namespace is full (${MAX_KEYS_PER_NS()} keys)`, 413);
    }
    assertByteBudget(owner, key, serialized.length);
    const exp = expiryOf(ttlSeconds);
    kvPut.run({ ns: owner, k: key, v: serialized, updated: now(), exp });
    appendLog(owner, actor, "cas-set", key, { expected: want, bytes: serialized.length, exp });
    return { key, swapped: true, value, owner, expiresAt: exp };
  });

  // --- grants (cross-agent sharing) ----------------------------------------

  function grant(owner, grantee, mode, ttlSeconds) {
    const { g, exp } = checkGrant(owner, grantee, mode, ttlSeconds);
    grantPut.run({ owner, grantee: g, mode, created: now(), exp });
    appendLog(owner, owner, "grant", g, { mode, exp });
    return { owner, grantee: g, mode, expiresAt: exp };
  }

  function revoke(owner, grantee) {
    const g = checkGrantee(grantee);
    const removed = grantDel.run(owner, g).changes > 0;
    if (removed) appendLog(owner, owner, "revoke", g);
    return { owner, grantee: g, revoked: removed };
  }

  function listGrants(owner) {
    return { owner, grants: grantList.all(owner).map(grantEntry) };
  }

  // --- similarity recall -----------------------------------------------------

  async function remember(owner, text, meta, { actor = owner } = {}) {
    requireAccess(owner, actor, "write");
    checkDocText(text);
    if (docCount.get(owner).n >= MAX_DOCS_PER_NS) throw bad(`Recall store is full (${MAX_DOCS_PER_NS} docs)`);
    const { vec, model } = await embedText(text);
    const id = newDocId();
    const metaStr = meta === undefined ? null : storable(JSON.stringify(meta), '"meta"');
    docPut.run({ ns: owner, id, text, meta: metaStr, vec: JSON.stringify(vec), model, updated: now() });
    appendLog(owner, actor, "remember", id, { chars: text.length });
    return { id, owner, stored: true, embedder: model };
  }

  async function recall(owner, query, k, { actor = owner } = {}) {
    requireAccess(owner, actor, "read");
    if (typeof query !== "string" || !query.trim()) throw bad('"query" is required');
    const topK = topKOf(k);
    const { vec: qv, model } = await embedText(query);
    // Only compare against docs embedded by the SAME embedder (a provider switch
    // would otherwise compare incompatible vector spaces).
    return rankDocs(docAll.all(owner), qv, model, topK, owner, query);
  }

  function forget(owner, id, { actor = owner } = {}) {
    requireAccess(owner, actor, "write");
    if (!id) throw bad('"id" is required');
    const deleted = docDel.run(owner, id).changes > 0;
    if (deleted) appendLog(owner, actor, "forget", id);
    return { id, deleted, owner };
  }

  return { ready: () => Promise.resolve(), mirrorStatus: () => "n/a", authorize, getLog, memoryPut, memoryGet, memoryDelete, memoryIncr, memoryCas, grant, revoke, listGrants, remember, recall, forget };
}

// =========================================================================
// Postgres backend: the same tables in the state database. Every write runs
// in one transaction under a per-namespace advisory lock, so the audit chain
// (seq, prev_hash) stays contiguous across concurrent requests and across two
// containers, and incr / cas are atomic read-modify-write steps.
// =========================================================================
const IMPORT_NAME = "agent402.db";
const LOCK_SPACE = 4020; // advisory lock namespace for memory (int4, paired with hashtext(owner))
const IMPORT_CHUNK = 500;
const ROLL_FORWARD_GRACE_MS = 60_000; // the mirror writes the file within milliseconds of a commit

function pgBackend() {
  const T = (t) => `${stateDbSchema()}.${t}`;
  const num = (x) => (x === null || x === undefined ? null : Number(x));
  const kvRow = (r) => (r ? { v: r.v, updated: num(r.updated), exp: num(r.exp) } : null);

  const DDL = () => `
    CREATE TABLE IF NOT EXISTS ${T("memory_kv")} (
      ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL,
      updated BIGINT NOT NULL, exp BIGINT,
      PRIMARY KEY (ns, k)
    );
    CREATE INDEX IF NOT EXISTS memory_kv_exp ON ${T("memory_kv")} (exp) WHERE exp IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ${T("memory_grants")} (
      owner TEXT NOT NULL, grantee TEXT NOT NULL, mode TEXT NOT NULL,
      created BIGINT NOT NULL, exp BIGINT,
      PRIMARY KEY (owner, grantee)
    );
    CREATE TABLE IF NOT EXISTS ${T("memory_memlog")} (
      ns TEXT NOT NULL, seq BIGINT NOT NULL, ts BIGINT NOT NULL,
      actor TEXT NOT NULL, action TEXT NOT NULL, key TEXT,
      data TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
      PRIMARY KEY (ns, seq)
    );
    CREATE TABLE IF NOT EXISTS ${T("memory_docs")} (
      ns TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL,
      meta TEXT, vec TEXT NOT NULL, model TEXT, updated BIGINT NOT NULL,
      PRIMARY KEY (ns, id)
    );
    CREATE TABLE IF NOT EXISTS ${T("memory_requests")} (
      ns TEXT NOT NULL, rid TEXT NOT NULL, fp TEXT NOT NULL, result TEXT NOT NULL, ts BIGINT NOT NULL,
      PRIMARY KEY (ns, rid)
    );
  `;

  // Insert rows in chunks. `conflict` is the ON CONFLICT clause: DO NOTHING
  // for the first import (idempotent, so two containers importing at once,
  // or a boot that crashed mid-import, are safe); a conditional DO UPDATE for
  // the roll-forward, where the file wins per row and only a changed row counts.
  async function insertRows(table, cols, rows, conflict = "ON CONFLICT DO NOTHING") {
    let n = 0;
    for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
      const chunk = rows.slice(i, i + IMPORT_CHUNK);
      const params = [];
      const tuples = chunk.map((row) => {
        const ph = cols.map((c) => { params.push(row[c] ?? null); return `$${params.length}`; });
        return `(${ph.join(",")})`;
      });
      const r = await stateQuery(`INSERT INTO ${T(table)} (${cols.join(",")}) VALUES ${tuples.join(",")} ${conflict}`, params);
      n += r.rowCount;
    }
    return n;
  }

  const KV_COLS = ["ns", "k", "v", "updated", "exp"];
  const GRANT_COLS = ["owner", "grantee", "mode", "created", "exp"];
  const LOG_COLS = ["ns", "seq", "ts", "actor", "action", "key", "data", "prev_hash", "hash"];
  const DOC_COLS = ["ns", "id", "text", "meta", "vec", "model", "updated"];
  // The file wins per row; a row already equal is not counted.
  const FILE_WINS = {
    memory_kv: `ON CONFLICT (ns, k) DO UPDATE SET v = EXCLUDED.v, updated = EXCLUDED.updated, exp = EXCLUDED.exp
      WHERE ${T("memory_kv")}.v IS DISTINCT FROM EXCLUDED.v OR ${T("memory_kv")}.updated IS DISTINCT FROM EXCLUDED.updated OR ${T("memory_kv")}.exp IS DISTINCT FROM EXCLUDED.exp`,
    memory_grants: `ON CONFLICT (owner, grantee) DO UPDATE SET mode = EXCLUDED.mode, created = EXCLUDED.created, exp = EXCLUDED.exp
      WHERE ${T("memory_grants")}.mode IS DISTINCT FROM EXCLUDED.mode OR ${T("memory_grants")}.created IS DISTINCT FROM EXCLUDED.created OR ${T("memory_grants")}.exp IS DISTINCT FROM EXCLUDED.exp`,
    memory_docs: `ON CONFLICT (ns, id) DO UPDATE SET text = EXCLUDED.text, meta = EXCLUDED.meta, vec = EXCLUDED.vec, model = EXCLUDED.model, updated = EXCLUDED.updated
      WHERE ${T("memory_docs")}.updated IS DISTINCT FROM EXCLUDED.updated OR ${T("memory_docs")}.text IS DISTINCT FROM EXCLUDED.text`,
    memory_memlog: "ON CONFLICT (ns, seq) DO NOTHING", // a chain row never changes; the file's extra rows continue it
  };

  // Read every table of the SQLite file (read-only; an older file may lack
  // the exp / model columns, which read as null).
  function readSqlite() {
    const src = new Database(DB_FILE, { readonly: true, fileMustExist: true });
    try {
      const cols = (t) => src.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      const has = (t) => src.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      const sel = (t, want) => (has(t) ? src.prepare(`SELECT ${want.map((c) => (cols(t).includes(c) ? c : `NULL AS ${c}`)).join(", ")} FROM ${t}`).all() : []);
      return { kv: sel("kv", KV_COLS), grants: sel("grants", GRANT_COLS), memlog: sel("memlog", LOG_COLS), docs: sel("docs", DOC_COLS) };
    } finally {
      src.close();
    }
  }

  async function applySqlite(fileWins) {
    const { kv, grants, memlog, docs } = readSqlite();
    const c = (t) => (fileWins ? FILE_WINS[t] : undefined);
    const n = {
      kv: await insertRows("memory_kv", KV_COLS, kv, c("memory_kv")),
      grants: await insertRows("memory_grants", GRANT_COLS, grants, c("memory_grants")),
      log: await insertRows("memory_memlog", LOG_COLS, memlog, c("memory_memlog")),
      docs: await insertRows("memory_docs", DOC_COLS, docs, c("memory_docs")),
    };
    return { rows: n.kv + n.grants + n.log + n.docs, n, read: { kv: kv.length, grants: grants.length, log: memlog.length, docs: docs.length } };
  }

  // The first boot with the database on: insert what is absent.
  async function importSqlite() {
    if (!existsSync(DB_FILE)) return { bytes: 0, rows: 0, skipped: "no file" };
    const { rows, read } = await applySqlite(false);
    const bytes = statSync(DB_FILE).size;
    console.log(`[memory] imported ${rows} row(s) (${read.kv} kv, ${read.grants} grants, ${read.log} log, ${read.docs} docs read) from ${DB_FILE} into the state database`);
    return { bytes, rows };
  }

  // Roll-forward after a rollback: while the file-only build served, it wrote
  // memory rows the database lacks, and the import mark keeps the first-boot
  // import from reading them. When the file (or its WAL) was modified later
  // than the database's newest chain row by more than the grace (the mirror
  // lands within milliseconds), the file is re-read and wins per row: kv,
  // grants and docs upsert; chain rows insert where absent, so the chain
  // continues from the file's last hash. Idempotent, so two containers may
  // both run it.
  const fileMtimeMs = () => Math.max(...[DB_FILE, `${DB_FILE}-wal`].map((f) => { try { return statSync(f).mtimeMs; } catch { return 0; } }));
  async function rollForwardIfFileNewer() {
    if (!existsSync(DB_FILE)) return null;
    const mtime = fileMtimeMs();
    const r = await stateQuery(`SELECT MAX(ts) AS ts FROM ${T("memory_memlog")}`);
    const newest = r.rows[0]?.ts == null ? 0 : Number(r.rows[0].ts);
    if (mtime - newest <= ROLL_FORWARD_GRACE_MS) return null;
    const { rows, n, read } = await applySqlite(true);
    console.log(`[memory] rolled forward ${rows} row(s) from ${DB_FILE} (${n.kv} kv, ${n.grants} grants, ${n.log} log, ${n.docs} docs changed of ${read.kv}/${read.grants}/${read.log}/${read.docs} read): the file was written ${Math.round((mtime - newest) / 1000)} s after the database's newest chain row`);
    return rows;
  }

  // The first load is retried until it lands (src/store-retry.js): the next
  // call tries again after a failure, and a backoff timer retries when
  // nothing calls, so the status reads the store as loading until it lands.
  const loader = retryingLoad("memory", async () => {
    await withSchemaLock((c) => c.query(DDL()));
    const { imported } = await importOnce(IMPORT_NAME, { source: DB_FILE, run: importSqlite });
    if (!imported) await rollForwardIfFileNewer(); // a first import already read the whole file
  }, { log: (m) => console.error(`[memory] ${m}`) });
  const ready = () => loader.ready();
  trackStoreReady(loader.eventually);
  ready().catch(() => {});

  // --- the SQLite mirror ------------------------------------------------------
  // When the file's directory exists (the volume is still mounted), every
  // committed write is replayed into the file with the same statements the
  // file backend runs, memlog rows with the same seq and hashes included, so a
  // rollback to the file-only build serves current memory. Best effort: a
  // failure is logged once and never changes the answer. Reads never touch it.
  let mirror = null;
  let mirrorFailed = false;
  function mirrorDb() {
    if (mirror || mirrorFailed || !existsSync(dirname(DB_FILE))) return mirror;
    try {
      const db = openSqlite();
      const st = sqliteStatements(db);
      mirror = { db, st, apply: db.transaction((ops) => { for (const [name, ...args] of ops) st[name].run(...args); }) };
    } catch (e) {
      mirrorFailed = true;
      console.error(`[memory] SQLite mirror could not open ${DB_FILE}: ${String(e?.message || e).slice(0, 160)}; the file will not follow the database`);
    }
    return mirror;
  }
  function mirrorApply(ops) {
    if (!ops.length) return;
    const mdb = mirrorDb();
    if (!mdb) return;
    try { mdb.apply(ops); }
    catch (e) {
      if (!mirrorFailed) console.error(`[memory] SQLite mirror write failed: ${String(e?.message || e).slice(0, 160)}; later failures are not logged`);
      mirrorFailed = true;
    }
  }
  /** Tests only: the mirror state. */
  const mirrorStatus = () => (mirrorFailed ? "failed" : mirror ? "on" : existsSync(dirname(DB_FILE)) ? "idle" : "off");

  // Expired rows in namespaces nobody reads anymore: sweep on a timer, as the file backend does.
  setInterval(() => {
    const t = nowSec();
    ready().then(() => stateQuery(`DELETE FROM ${T("memory_kv")} WHERE exp IS NOT NULL AND exp < $1`, [t])).then(() => mirrorApply([["kvPruneAll", t]])).catch(() => {});
  }, 10 * 60 * 1000).unref();

  // Every write: one transaction, the owner's advisory lock first. `q` is the
  // transaction client's query (or stateQuery for a plain read); `q.mirror`
  // collects the SQLite statements to replay once the transaction commits.
  const lock = (c, owner) => c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [LOCK_SPACE, owner]);
  // One write per owner at a time in this process: later writes wait here, not
  // on a pooled connection parked on the database lock, so a burst to one
  // namespace holds at most one connection. The database lock still orders
  // writes between processes.
  const ownerTails = new Map();
  async function locked(owner, fn) {
    const prev = ownerTails.get(owner) || Promise.resolve();
    let done;
    const mine = new Promise((r) => { done = r; });
    const tail = prev.then(() => mine);
    ownerTails.set(owner, tail);
    try {
      await prev;
      return await lockedNow(owner, fn);
    } finally {
      done();
      if (ownerTails.get(owner) === tail) ownerTails.delete(owner);
    }
  }
  async function lockedNow(owner, fn) {
    await ready();
    const ops = [];
    const out = await withStateTx(async (c) => {
      await lock(c, owner);
      const q = (text, params) => c.query(text, params);
      q.mirror = ops;
      return fn(q);
    });
    mirrorApply(ops);
    return out;
  }
  async function read(fn) {
    await ready();
    return fn(stateQuery);
  }
  /**
   * A locked write, once per client request id: the stored answer and the
   * write commit in one transaction, so a retry after a lost commit reply
   * finds the answer and applies nothing (see requestIdOf).
   */
  function lockedOnce(op, owner, actor, key, args, requestId, fn) {
    const rid = requestIdOf(requestId);
    if (!rid) return locked(owner, fn);
    return locked(owner, async (q) => {
      const k = requestKey(actor, rid), fp = requestFp(op, key, args);
      const hit = (await q(`SELECT fp, result FROM ${T("memory_requests")} WHERE ns = $1 AND rid = $2`, [owner, k])).rows[0];
      if (hit) return replayStored(hit, fp);
      const out = await fn(q);
      await q(`DELETE FROM ${T("memory_requests")} WHERE ns = $1 AND ts < $2`, [owner, now() - REQUEST_ID_TTL_MS]);
      await q(`INSERT INTO ${T("memory_requests")} (ns, rid, fp, result, ts) VALUES ($1, $2, $3, $4, $5)`, [owner, k, fp, JSON.stringify(out), now()]);
      return out;
    });
  }

  // --- statement helpers over an executor ---------------------------------
  const kvGet = async (q, ns, k) => kvRow((await q(`SELECT v, updated, exp FROM ${T("memory_kv")} WHERE ns = $1 AND k = $2`, [ns, k])).rows[0]);
  const kvPut = (q, row) => {
    q.mirror?.push(["kvPut", row]);
    return q(
      `INSERT INTO ${T("memory_kv")} (ns, k, v, updated, exp) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (ns, k) DO UPDATE SET v = EXCLUDED.v, updated = EXCLUDED.updated, exp = EXCLUDED.exp`,
      [row.ns, row.k, row.v, row.updated, row.exp],
    );
  };
  const kvDel = async (q, ns, k) => { q.mirror?.push(["kvDel", ns, k]); return (await q(`DELETE FROM ${T("memory_kv")} WHERE ns = $1 AND k = $2`, [ns, k])).rowCount > 0; };
  const kvCount = async (q, ns) => Number((await q(`SELECT COUNT(*)::bigint AS n FROM ${T("memory_kv")} WHERE ns = $1`, [ns])).rows[0].n);
  const kvBytes = async (q, ns) => Number((await q(`SELECT COALESCE(SUM(LENGTH(v)), 0)::bigint AS b FROM ${T("memory_kv")} WHERE ns = $1`, [ns])).rows[0].b);
  const kvPruneExpired = (q, ns) => { const t = nowSec(); q.mirror?.push(["kvPruneExpired", ns, t]); return q(`DELETE FROM ${T("memory_kv")} WHERE ns = $1 AND exp IS NOT NULL AND exp < $2`, [ns, t]); };
  const grantGet = async (q, owner, grantee) => {
    const r = (await q(`SELECT mode, exp FROM ${T("memory_grants")} WHERE owner = $1 AND grantee = $2`, [owner, grantee])).rows[0];
    return r ? { mode: r.mode, exp: num(r.exp) } : null;
  };
  const docCount = async (q, ns) => Number((await q(`SELECT COUNT(*)::bigint AS n FROM ${T("memory_docs")} WHERE ns = $1`, [ns])).rows[0].n);

  async function assertKeyQuota(q, owner, key, rowKnownAbsent = false) {
    if ((await kvCount(q, owner)) < MAX_KEYS_PER_NS()) return;
    if (!rowKnownAbsent && (await kvGet(q, owner, key))) return; // overwriting never counts against the cap
    // Expired rows must not consume quota: reclaim before rejecting.
    await kvPruneExpired(q, owner);
    if ((await kvCount(q, owner)) >= MAX_KEYS_PER_NS()) throw bad(`Namespace is full (${MAX_KEYS_PER_NS()} keys)`, 413);
  }

  async function assertByteBudget(q, owner, key, incomingBytes) {
    const existing = await kvGet(q, owner, key);
    const delta = incomingBytes - (existing ? existing.v.length : 0);
    if (delta <= 0) return; // shrinking or same-size overwrite always allowed
    if ((await kvBytes(q, owner)) + delta > MAX_NS_BYTES()) {
      await kvPruneExpired(q, owner);
      if ((await kvBytes(q, owner)) + delta > MAX_NS_BYTES()) {
        throw bad(`Namespace byte budget exceeded (${MAX_NS_BYTES()} bytes of stored values) - delete keys, shrink values, or let TTLs expire`, 413);
      }
    }
  }

  // --- access control -------------------------------------------------------

  async function authorizeWith(q, owner, actor, need) {
    if (owner === actor) return true;
    return grantAllows(await grantGet(q, owner, actor), need);
  }
  async function requireAccess(q, owner, actor, need) {
    if (!(await authorizeWith(q, owner, actor, need))) throw accessError(owner, actor, need);
  }
  const authorize = (owner, actor, need) => read((q) => authorizeWith(q, owner, actor, need));

  // --- tamper-evident audit chain (inside the caller's locked transaction) ---

  async function appendLog(q, ns, actor, action, key, dataObj) {
    const last = (await q(`SELECT seq, hash FROM ${T("memory_memlog")} WHERE ns = $1 ORDER BY seq DESC LIMIT 1`, [ns])).rows[0];
    const seq = (last ? Number(last.seq) : 0) + 1;
    const prev = last?.hash ?? "";
    const ts = now();
    const data = dataObj === undefined ? null : JSON.stringify(dataObj);
    const hash = chainHash(prev, seq, ts, actor, action, key, data);
    q.mirror?.push(["logIns", { ns, seq, ts, actor, action, key: key ?? null, data, prev_hash: prev, hash }]);
    await q(
      `INSERT INTO ${T("memory_memlog")} (ns, seq, ts, actor, action, key, data, prev_hash, hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [ns, seq, ts, actor, action, key ?? null, data, prev, hash],
    );
    return { seq, hash };
  }

  function getLog(owner, actor, limit = 100) {
    return read(async (q) => {
      await requireAccess(q, owner, actor, "read");
      const r = await q(`SELECT seq, ts, actor, action, key, data, prev_hash, hash FROM ${T("memory_memlog")} WHERE ns = $1 ORDER BY seq ASC LIMIT $2`, [owner, logLimitOf(limit)]);
      return { ns: owner, entries: r.rows.map((x) => logEntry({ ...x, seq: num(x.seq), ts: num(x.ts) })), verify: VERIFY_RULE, persistent: PERSISTENT };
    });
  }

  // --- key/value with TTL ---------------------------------------------------

  function memoryPut(owner, key, value, { actor = owner, ttlSeconds, requestId } = {}) {
    return lockedOnce("put", owner, actor, key, [value === undefined ? null : value, ttlSeconds ?? null], requestId, async (q) => {
      await requireAccess(q, owner, actor, "write");
      checkKey(key);
      const serialized = serializeValue(value);
      await assertKeyQuota(q, owner, key);
      await assertByteBudget(q, owner, key, serialized.length);
      const exp = expiryOf(ttlSeconds);
      const updated = now();
      await kvPut(q, { ns: owner, k: key, v: serialized, updated, exp });
      await appendLog(q, owner, actor, "put", key, { bytes: serialized.length, exp });
      return { key, bytes: serialized.length, updated, expiresAt: exp, owner, persistent: PERSISTENT };
    });
  }

  function memoryGet(owner, key, { actor = owner } = {}) {
    return read(async (q) => {
      await requireAccess(q, owner, actor, "read");
      if (!key) {
        await kvPruneExpired(q, owner);
        const r = await q(`SELECT k, updated, exp FROM ${T("memory_kv")} WHERE ns = $1 ORDER BY updated DESC LIMIT 1000`, [owner]);
        const keys = r.rows.map((x) => ({ k: x.k, updated: num(x.updated), exp: num(x.exp) })).filter((x) => !(x.exp && x.exp < nowSec()));
        return { keys, owner, persistent: PERSISTENT };
      }
      const row = freshKv(await kvGet(q, owner, key));
      if (!row) throw bad("Key not found", 404);
      return { key, value: parseStored(row.v), updated: row.updated, expiresAt: row.exp, owner, persistent: PERSISTENT };
    });
  }

  function memoryDelete(owner, key, { actor = owner, requestId } = {}) {
    return lockedOnce("delete", owner, actor, key, null, requestId, async (q) => {
      await requireAccess(q, owner, actor, "write");
      if (!key) throw bad('"key" is required');
      const deleted = await kvDel(q, owner, key);
      if (deleted) await appendLog(q, owner, actor, "delete", key);
      return { key, deleted, owner };
    });
  }

  function memoryIncr(owner, key, by, actor, { requestId } = {}) {
    return lockedOnce("incr", owner, actor, key, [by === undefined ? 1 : by], requestId, async (q) => {
      await requireAccess(q, owner, actor, "write");
      checkKey(key, `Invalid "key"`);
      const amount = by === undefined ? 1 : Number(by);
      if (!Number.isFinite(amount)) throw bad('"by" must be a number');
      const row = freshKv(await kvGet(q, owner, key));
      let current = 0;
      if (row) {
        const n = Number(row.v);
        if (!Number.isFinite(n)) throw bad(`Key "${key}" holds a non-numeric value; cannot increment`);
        current = n;
      } else {
        await assertKeyQuota(q, owner, key, true);
      }
      const next = current + amount;
      await kvPut(q, { ns: owner, k: key, v: String(next), updated: now(), exp: row?.exp ?? null });
      await appendLog(q, owner, actor, "incr", key, { by: amount, value: next });
      return { key, value: next, owner };
    });
  }

  function memoryCas(owner, key, expected, value, { actor = owner, ttlSeconds, hasValue = false, requestId } = {}) {
    return lockedOnce("cas", owner, actor, key, [expected ?? null, hasValue ? value ?? null : "\u0000absent", ttlSeconds ?? null], requestId, async (q) => {
      await requireAccess(q, owner, actor, "write");
      checkKey(key);
      const row = freshKv(await kvGet(q, owner, key));
      const current = row ? parseStored(row.v) : null;
      const want = expected === undefined ? null : expected;
      if (JSON.stringify(current) !== JSON.stringify(want)) {
        return { key, swapped: false, value: current, owner };
      }
      if (!hasValue || value === undefined) {
        const deleted = await kvDel(q, owner, key);
        if (deleted) await appendLog(q, owner, actor, "cas-del", key, { expected: want });
        return { key, swapped: true, value: null, owner };
      }
      const serialized = serializeValue(value, `"value" must serialize to at most ${MAX_VALUE} bytes`);
      if (!row) await assertKeyQuota(q, owner, key, true);
      await assertByteBudget(q, owner, key, serialized.length);
      const exp = expiryOf(ttlSeconds);
      await kvPut(q, { ns: owner, k: key, v: serialized, updated: now(), exp });
      await appendLog(q, owner, actor, "cas-set", key, { expected: want, bytes: serialized.length, exp });
      return { key, swapped: true, value, owner, expiresAt: exp };
    });
  }

  // --- grants (cross-agent sharing) ----------------------------------------

  function grant(owner, grantee, mode, ttlSeconds) {
    const { g, exp } = checkGrant(owner, grantee, mode, ttlSeconds);
    return locked(owner, async (q) => {
      const created = now();
      q.mirror.push(["grantPut", { owner, grantee: g, mode, created, exp }]);
      await q(
        `INSERT INTO ${T("memory_grants")} (owner, grantee, mode, created, exp) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (owner, grantee) DO UPDATE SET mode = EXCLUDED.mode, created = EXCLUDED.created, exp = EXCLUDED.exp`,
        [owner, g, mode, created, exp],
      );
      await appendLog(q, owner, owner, "grant", g, { mode, exp });
      return { owner, grantee: g, mode, expiresAt: exp };
    });
  }

  function revoke(owner, grantee) {
    const g = checkGrantee(grantee);
    return locked(owner, async (q) => {
      q.mirror.push(["grantDel", owner, g]);
      const removed = (await q(`DELETE FROM ${T("memory_grants")} WHERE owner = $1 AND grantee = $2`, [owner, g])).rowCount > 0;
      if (removed) await appendLog(q, owner, owner, "revoke", g);
      return { owner, grantee: g, revoked: removed };
    });
  }

  function listGrants(owner) {
    return read(async (q) => {
      const r = await q(`SELECT grantee, mode, created, exp FROM ${T("memory_grants")} WHERE owner = $1`, [owner]);
      return { owner, grants: r.rows.map((x) => grantEntry({ ...x, created: num(x.created), exp: num(x.exp) })) };
    });
  }

  // --- similarity recall (vectors stay JSON text; cosine runs in JS) ---------

  async function remember(owner, text, meta, { actor = owner } = {}) {
    await read((q) => requireAccess(q, owner, actor, "write"));
    checkDocText(text);
    const metaStr = meta === undefined ? null : storable(JSON.stringify(meta), '"meta"');
    const { vec, model } = await embedText(text); // the provider call stays outside the transaction
    return locked(owner, async (q) => {
      await requireAccess(q, owner, actor, "write");
      if ((await docCount(q, owner)) >= MAX_DOCS_PER_NS) throw bad(`Recall store is full (${MAX_DOCS_PER_NS} docs)`);
      const id = newDocId();
      const doc = { ns: owner, id, text, meta: metaStr, vec: JSON.stringify(vec), model, updated: now() };
      q.mirror.push(["docPut", doc]);
      await q(
        `INSERT INTO ${T("memory_docs")} (ns, id, text, meta, vec, model, updated) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (ns, id) DO UPDATE SET text = EXCLUDED.text, meta = EXCLUDED.meta, vec = EXCLUDED.vec, model = EXCLUDED.model, updated = EXCLUDED.updated`,
        [doc.ns, doc.id, doc.text, doc.meta, doc.vec, doc.model, doc.updated],
      );
      await appendLog(q, owner, actor, "remember", id, { chars: text.length });
      return { id, owner, stored: true, embedder: model };
    });
  }

  async function recall(owner, query, k, { actor = owner } = {}) {
    await read((q) => requireAccess(q, owner, actor, "read"));
    if (typeof query !== "string" || !query.trim()) throw bad('"query" is required');
    const topK = topKOf(k);
    const { vec: qv, model } = await embedText(query);
    const docs = (await stateQuery(`SELECT id, text, meta, vec, model, updated FROM ${T("memory_docs")} WHERE ns = $1`, [owner])).rows
      .map((d) => ({ ...d, updated: num(d.updated) }));
    return rankDocs(docs, qv, model, topK, owner, query);
  }

  function forget(owner, id, { actor = owner } = {}) {
    return locked(owner, async (q) => {
      await requireAccess(q, owner, actor, "write");
      if (!id) throw bad('"id" is required');
      q.mirror.push(["docDel", owner, id]);
      const deleted = (await q(`DELETE FROM ${T("memory_docs")} WHERE ns = $1 AND id = $2`, [owner, id])).rowCount > 0;
      if (deleted) await appendLog(q, owner, actor, "forget", id);
      return { id, deleted, owner };
    });
  }

  return { ready, mirrorStatus, authorize, getLog, memoryPut, memoryGet, memoryDelete, memoryIncr, memoryCas, grant, revoke, listGrants, remember, recall, forget };
}

const impl = USE_PG ? pgBackend() : sqliteBackend();

// --- exports --------------------------------------------------------------
// SQLite backend: synchronous, except remember/recall (embedding). Postgres
// backend: every one of these returns a promise, resolved only after the
// database has the write (paid memory is never fire-and-forget).

/** Resolves when the backend is ready (tables created, the SQLite file imported); immediate on SQLite. */
export function memoryReady() { return impl.ready(); }

/** Tests only: "on" | "idle" | "failed" | "off" for the Postgres backend's SQLite mirror, "n/a" on SQLite. */
export function __memoryMirrorStatus() { return impl.mirrorStatus(); }

/** True if `actor` may act on `owner`'s namespace at the required level ("read" | "write"). */
export function authorize(owner, actor, need) { return impl.authorize(owner, actor, need); }

export function getLog(owner, actor, limit = 100) { return impl.getLog(owner, actor, limit); }

export function memoryPut(owner, key, value, opts) { return impl.memoryPut(owner, key, value, opts); }

export function memoryGet(owner, key, opts) { return impl.memoryGet(owner, key, opts); }

export function memoryDelete(owner, key, opts) { return impl.memoryDelete(owner, key, opts); }

/** Atomic numeric counter — a coordination primitive only a shared store can offer.
 *  `opts.requestId`: a client request id makes a retry return the first answer instead of counting again. */
export function memoryIncr(owner, key, by, actor, opts) { return impl.memoryIncr(owner, key, by, actor, opts); }

/**
 * Atomic compare-and-set — the general coordination primitive. Writes (or, when
 * no value is supplied, deletes) a key only if its current value equals
 * `expected`. This is what distributed locks and optimistic concurrency are
 * built from:
 *   - acquire a lock:  expected = null (key absent/expired), value = <token>, ttlSeconds = <lease>
 *   - release a lock:  expected = <token>, no value  → deletes on match
 *   - safe update:     expected = <old value>, value = <new value>
 * `hasValue` distinguishes "set to a value" (even null) from "no value = delete".
 * Values are compared as JSON values (same canonicalization on both sides).
 */
export function memoryCas(owner, key, expected, value, opts) { return impl.memoryCas(owner, key, expected, value, opts); }

export function grant(owner, grantee, mode, ttlSeconds) { return impl.grant(owner, grantee, mode, ttlSeconds); }

export function revoke(owner, grantee) { return impl.revoke(owner, grantee); }

export function listGrants(owner) { return impl.listGrants(owner); }

export function remember(owner, text, meta, opts) { return impl.remember(owner, text, meta, opts); }

export function recall(owner, query, k, opts) { return impl.recall(owner, query, k, opts); }

export function forget(owner, id, opts) { return impl.forget(owner, id, opts); }
