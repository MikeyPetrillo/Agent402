import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Use a Railway volume at /data when present; otherwise fall back to /tmp
// (ephemeral across deploys — documented as best-effort).
const DATA_DIR = existsSync("/data") ? "/data" : "/tmp";
export const PERSISTENT = DATA_DIR === "/data";

const db = new Database(join(DATA_DIR, "agent402.db"));
db.pragma("journal_mode = WAL");
db.exec(
  "CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (ns, k))"
);

const MAX_KEY = 256;
const MAX_VALUE = 64 * 1024;
const MAX_KEYS_PER_NS = 10000;

const putStmt = db.prepare(
  "INSERT INTO kv (ns, k, v, updated) VALUES (?, ?, ?, ?) ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, updated = excluded.updated"
);
const getStmt = db.prepare("SELECT v, updated FROM kv WHERE ns = ? AND k = ?");
const delStmt = db.prepare("DELETE FROM kv WHERE ns = ? AND k = ?");
const listStmt = db.prepare("SELECT k, updated FROM kv WHERE ns = ? ORDER BY updated DESC LIMIT 1000");
const countStmt = db.prepare("SELECT COUNT(*) AS n FROM kv WHERE ns = ?");

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

export function memoryPut(ns, key, value) {
  if (typeof key !== "string" || !key || key.length > MAX_KEY) {
    throw bad(`"key" must be a non-empty string of at most ${MAX_KEY} chars`);
  }
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized === undefined || serialized.length > MAX_VALUE) {
    throw bad(`"value" is required and must serialize to at most ${MAX_VALUE} bytes`);
  }
  if (countStmt.get(ns).n >= MAX_KEYS_PER_NS && !getStmt.get(ns, key)) {
    throw bad(`Namespace is full (${MAX_KEYS_PER_NS} keys)`);
  }
  const updated = Date.now();
  putStmt.run(ns, key, serialized, updated);
  return { key, bytes: serialized.length, updated, persistent: PERSISTENT };
}

export function memoryGet(ns, key) {
  if (!key) {
    return { keys: listStmt.all(ns), persistent: PERSISTENT };
  }
  const row = getStmt.get(ns, key);
  if (!row) {
    const err = new Error("Key not found");
    err.statusCode = 404;
    throw err;
  }
  let value;
  try {
    value = JSON.parse(row.v);
  } catch {
    value = row.v;
  }
  return { key, value, updated: row.updated, persistent: PERSISTENT };
}

export function memoryDelete(ns, key) {
  if (!key) throw bad('"key" is required');
  return { key, deleted: delStmt.run(ns, key).changes > 0 };
}
