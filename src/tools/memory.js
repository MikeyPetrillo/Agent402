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
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = existsSync("/data") ? "/data" : "/tmp";
export const PERSISTENT = DATA_DIR === "/data";

const db = new Database(join(DATA_DIR, "agent402.db"));
db.pragma("journal_mode = WAL");
db.exec(`
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
`);

// Migrate older tables in place if needed.
const kvCols = db.prepare("PRAGMA table_info(kv)").all().map((c) => c.name);
if (!kvCols.includes("exp")) db.exec("ALTER TABLE kv ADD COLUMN exp INTEGER");
const docCols = db.prepare("PRAGMA table_info(docs)").all().map((c) => c.name);
if (!docCols.includes("model")) db.exec("ALTER TABLE docs ADD COLUMN model TEXT");

const MAX_KEY = 256;
const MAX_VALUE = 64 * 1024;
const MAX_KEYS_PER_NS = 10000;
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

// --- statements -----------------------------------------------------------
const kvPut = db.prepare(
  "INSERT INTO kv (ns, k, v, updated, exp) VALUES (@ns, @k, @v, @updated, @exp) " +
    "ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, updated = excluded.updated, exp = excluded.exp"
);
const kvGet = db.prepare("SELECT v, updated, exp FROM kv WHERE ns = ? AND k = ?");
const kvDel = db.prepare("DELETE FROM kv WHERE ns = ? AND k = ?");
const kvList = db.prepare("SELECT k, updated, exp FROM kv WHERE ns = ? ORDER BY updated DESC LIMIT 1000");
const kvCount = db.prepare("SELECT COUNT(*) AS n FROM kv WHERE ns = ?");
const kvPruneExpired = db.prepare("DELETE FROM kv WHERE ns = ? AND exp IS NOT NULL AND exp < ?");

const grantPut = db.prepare(
  "INSERT INTO grants (owner, grantee, mode, created, exp) VALUES (@owner, @grantee, @mode, @created, @exp) " +
    "ON CONFLICT(owner, grantee) DO UPDATE SET mode = excluded.mode, created = excluded.created, exp = excluded.exp"
);
const grantGet = db.prepare("SELECT mode, exp FROM grants WHERE owner = ? AND grantee = ?");
const grantDel = db.prepare("DELETE FROM grants WHERE owner = ? AND grantee = ?");
const grantList = db.prepare("SELECT grantee, mode, created, exp FROM grants WHERE owner = ?");

const logLast = db.prepare("SELECT seq, hash FROM memlog WHERE ns = ? ORDER BY seq DESC LIMIT 1");
const logIns = db.prepare(
  "INSERT INTO memlog (ns, seq, ts, actor, action, key, data, prev_hash, hash) " +
    "VALUES (@ns, @seq, @ts, @actor, @action, @key, @data, @prev_hash, @hash)"
);
const logRead = db.prepare("SELECT seq, ts, actor, action, key, data, prev_hash, hash FROM memlog WHERE ns = ? ORDER BY seq ASC LIMIT ?");

const docPut = db.prepare(
  "INSERT INTO docs (ns, id, text, meta, vec, model, updated) VALUES (@ns, @id, @text, @meta, @vec, @model, @updated) " +
    "ON CONFLICT(ns, id) DO UPDATE SET text = excluded.text, meta = excluded.meta, vec = excluded.vec, model = excluded.model, updated = excluded.updated"
);
const docCount = db.prepare("SELECT COUNT(*) AS n FROM docs WHERE ns = ?");
const docAll = db.prepare("SELECT id, text, meta, vec, model, updated FROM docs WHERE ns = ?");
const docDel = db.prepare("DELETE FROM docs WHERE ns = ? AND id = ?");

// --- access control -------------------------------------------------------

/** True if `actor` may act on `owner`'s namespace at the required level. */
export function authorize(owner, actor, need /* "read" | "write" */) {
  if (owner === actor) return true;
  const g = grantGet.get(owner, actor);
  if (!g) return false;
  if (g.exp && g.exp < nowSec()) return false;
  return need === "write" ? g.mode === "readwrite" : true;
}

function requireAccess(owner, actor, need) {
  if (!authorize(owner, actor, need)) {
    throw bad(
      owner === actor
        ? "No payer identity on this request"
        : `Wallet ${actor} has no ${need} grant on namespace ${owner}`,
      403
    );
  }
}

// --- tamper-evident audit chain ------------------------------------------

function appendLog(ns, actor, action, key, dataObj) {
  const last = logLast.get(ns);
  const seq = (last?.seq ?? 0) + 1;
  const prev = last?.hash ?? "";
  const ts = now();
  const data = dataObj === undefined ? null : JSON.stringify(dataObj);
  const hash = createHash("sha256")
    .update(`${prev}|${seq}|${ts}|${actor}|${action}|${key ?? ""}|${data ?? ""}`)
    .digest("hex");
  logIns.run({ ns, seq, ts, actor, action, key: key ?? null, data, prev_hash: prev, hash });
  return { seq, hash };
}

export function getLog(owner, actor, limit = 100) {
  requireAccess(owner, actor, "read");
  const rows = logRead.all(owner, Math.min(Math.max(limit, 1), 1000));
  return {
    ns: owner,
    entries: rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      actor: r.actor,
      action: r.action,
      key: r.key,
      data: r.data ? JSON.parse(r.data) : null,
      prevHash: r.prev_hash,
      hash: r.hash,
    })),
    verify:
      "hash[i] = sha256(prevHash + '|' + seq + '|' + ts + '|' + actor + '|' + action + '|' + (key||'') + '|' + (JSON.stringify(data)||''))",
    persistent: PERSISTENT,
  };
}

// --- key/value with TTL ---------------------------------------------------

function freshKv(row) {
  if (!row) return null;
  if (row.exp && row.exp < nowSec()) return null;
  return row;
}

export function memoryPut(owner, key, value, { actor = owner, ttlSeconds } = {}) {
  requireAccess(owner, actor, "write");
  if (typeof key !== "string" || !key || key.length > MAX_KEY)
    throw bad(`"key" must be a non-empty string of at most ${MAX_KEY} chars`);
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized === undefined || serialized.length > MAX_VALUE)
    throw bad(`"value" is required and must serialize to at most ${MAX_VALUE} bytes`);
  if (kvCount.get(owner).n >= MAX_KEYS_PER_NS && !kvGet.get(owner, key))
    throw bad(`Namespace is full (${MAX_KEYS_PER_NS} keys)`);
  let exp = null;
  if (ttlSeconds !== undefined && ttlSeconds !== null) {
    const t = parseInt(ttlSeconds, 10);
    if (!Number.isFinite(t) || t <= 0) throw bad('"ttlSeconds" must be a positive integer');
    exp = nowSec() + t;
  }
  const updated = now();
  kvPut.run({ ns: owner, k: key, v: serialized, updated, exp });
  appendLog(owner, actor, "put", key, { bytes: serialized.length, exp });
  return { key, bytes: serialized.length, updated, expiresAt: exp, owner, persistent: PERSISTENT };
}

export function memoryGet(owner, key, { actor = owner } = {}) {
  requireAccess(owner, actor, "read");
  if (!key) {
    kvPruneExpired.run(owner, nowSec());
    return { keys: kvList.all(owner).filter((r) => !(r.exp && r.exp < nowSec())), owner, persistent: PERSISTENT };
  }
  const row = freshKv(kvGet.get(owner, key));
  if (!row) throw bad("Key not found", 404);
  let value;
  try {
    value = JSON.parse(row.v);
  } catch {
    value = row.v;
  }
  return { key, value, updated: row.updated, expiresAt: row.exp, owner, persistent: PERSISTENT };
}

export function memoryDelete(owner, key, { actor = owner } = {}) {
  requireAccess(owner, actor, "write");
  if (!key) throw bad('"key" is required');
  const deleted = kvDel.run(owner, key).changes > 0;
  if (deleted) appendLog(owner, actor, "delete", key);
  return { key, deleted, owner };
}

/** Atomic numeric counter — a coordination primitive only a shared store can offer. */
export const memoryIncr = db.transaction((owner, key, by, actor) => {
  requireAccess(owner, actor, "write");
  if (typeof key !== "string" || !key || key.length > MAX_KEY) throw bad(`Invalid "key"`);
  const amount = by === undefined ? 1 : Number(by);
  if (!Number.isFinite(amount)) throw bad('"by" must be a number');
  const row = freshKv(kvGet.get(owner, key));
  let current = 0;
  if (row) {
    const n = Number(row.v);
    if (!Number.isFinite(n)) throw bad(`Key "${key}" holds a non-numeric value; cannot increment`);
    current = n;
  } else if (kvCount.get(owner).n >= MAX_KEYS_PER_NS) {
    throw bad(`Namespace is full (${MAX_KEYS_PER_NS} keys)`);
  }
  const next = current + amount;
  kvPut.run({ ns: owner, k: key, v: String(next), updated: now(), exp: row?.exp ?? null });
  appendLog(owner, actor, "incr", key, { by: amount, value: next });
  return { key, value: next, owner };
});

// --- grants (cross-agent sharing) ----------------------------------------

const ADDR = /^0x[0-9a-fA-F]{40}$/;

export function grant(owner, grantee, mode, ttlSeconds) {
  if (typeof grantee !== "string" || !ADDR.test(grantee)) throw bad('"grantee" must be a 0x wallet address');
  const g = grantee.toLowerCase();
  if (g === owner) throw bad("You already own this namespace");
  if (mode !== "read" && mode !== "readwrite") throw bad('"mode" must be "read" or "readwrite"');
  let exp = null;
  if (ttlSeconds !== undefined && ttlSeconds !== null) {
    const t = parseInt(ttlSeconds, 10);
    if (!Number.isFinite(t) || t <= 0) throw bad('"ttlSeconds" must be a positive integer');
    exp = nowSec() + t;
  }
  grantPut.run({ owner, grantee: g, mode, created: now(), exp });
  appendLog(owner, owner, "grant", g, { mode, exp });
  return { owner, grantee: g, mode, expiresAt: exp };
}

export function revoke(owner, grantee) {
  if (typeof grantee !== "string" || !ADDR.test(grantee)) throw bad('"grantee" must be a 0x wallet address');
  const g = grantee.toLowerCase();
  const removed = grantDel.run(owner, g).changes > 0;
  if (removed) appendLog(owner, owner, "revoke", g);
  return { owner, grantee: g, revoked: removed };
}

export function listGrants(owner) {
  return {
    owner,
    grants: grantList.all(owner).map((r) => ({
      grantee: r.grantee,
      mode: r.mode,
      created: r.created,
      expiresAt: r.exp,
      active: !r.exp || r.exp >= nowSec(),
    })),
  };
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
  return `${nowSec().toString(36)}${(docSeq++ & 0xffff).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export async function remember(owner, text, meta, { actor = owner } = {}) {
  requireAccess(owner, actor, "write");
  if (typeof text !== "string" || !text.trim()) throw bad('"text" is required');
  if (text.length > MAX_DOC_TEXT) throw bad(`"text" exceeds ${MAX_DOC_TEXT} chars`);
  if (docCount.get(owner).n >= MAX_DOCS_PER_NS) throw bad(`Recall store is full (${MAX_DOCS_PER_NS} docs)`);
  const { vec, model } = await embedText(text);
  const id = newDocId();
  const metaStr = meta === undefined ? null : JSON.stringify(meta);
  docPut.run({ ns: owner, id, text, meta: metaStr, vec: JSON.stringify(vec), model, updated: now() });
  appendLog(owner, actor, "remember", id, { chars: text.length });
  return { id, owner, stored: true, embedder: model };
}

export async function recall(owner, query, k, { actor = owner } = {}) {
  requireAccess(owner, actor, "read");
  if (typeof query !== "string" || !query.trim()) throw bad('"query" is required');
  const topK = Math.min(Math.max(parseInt(k, 10) || 5, 1), 50);
  const { vec: qv, model } = await embedText(query);
  // Only compare against docs embedded by the SAME embedder (a provider switch
  // would otherwise compare incompatible vector spaces).
  const docs = docAll.all(owner);
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

export function forget(owner, id, { actor = owner } = {}) {
  requireAccess(owner, actor, "write");
  if (!id) throw bad('"id" is required');
  const deleted = docDel.run(owner, id).changes > 0;
  if (deleted) appendLog(owner, actor, "forget", id);
  return { id, deleted, owner };
}
