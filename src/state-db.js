// Shared state in Postgres: the stores that lived as files on the /data volume.
//
// A service with a volume cannot run two deployments at once, so every deploy
// is a window with no container. Moving the volume's stores into Postgres is
// what lets the old and the new container overlap. This module is the one
// connection and the four generic shapes the file stores map onto:
//
//   documents   one JSON body per name (the whole-file JSON stores)
//   records     one JSON body per (collection, id) (the one-file-per-record dirs)
//   log_lines   append-only lines per stream (the NDJSON logs)
//   leases      a named lease one process holds at a time (the scheduled loops,
//               which must not run twice while two containers overlap)
//
// STATE_DATABASE_URL names the database and is the switch: unset, every call
// reports `enabled: false` and the callers keep their file or in-memory
// behaviour, so a deploy of this code changes nothing until the operator sets
// it (to the same Postgres DATABASE_URL already points at, by design). There
// is deliberately no fallback to DATABASE_URL: the cutover is a variable the
// operator sets, never a merge. Tables live in the `state` schema
// (STATE_DB_SCHEMA; tests use one schema per run and drop it).
//
// TLS follows src/db-ssl.js: relaxed on Railway's private mesh, verified and
// fail-closed on any public host.
import pg from "pg";
import { dbSsl } from "./db-ssl.js";

const { Pool } = pg;
const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,40}$/;
const NAME_MAX = 200;

export function stateDbUrl(env = process.env) {
  return String(env.STATE_DATABASE_URL || "").trim();
}
export function stateDbSchema(env = process.env) {
  const s = String(env.STATE_DB_SCHEMA || "state").trim();
  if (!SCHEMA_RE.test(s)) throw new Error(`STATE_DB_SCHEMA must match ${SCHEMA_RE}`);
  return s;
}
export function stateDbEnabled(env = process.env) {
  return Boolean(stateDbUrl(env));
}

let pool = null;
let ready = null;
let schemaName = null;
let lastError = null;

function schema() {
  if (!schemaName) schemaName = stateDbSchema();
  return schemaName;
}
function getPool() {
  if (!stateDbEnabled()) return null;
  if (pool) return pool;
  const url = stateDbUrl();
  pool = new Pool({
    connectionString: url,
    ssl: dbSsl(url),
    max: Number(process.env.STATE_DB_POOL_MAX) || 6,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000,
  });
  pool.on("error", (err) => { lastError = String(err?.message || err).slice(0, 160); console.error("[state-db] pool error:", lastError); });
  return pool;
}

const DDL = (s) => `
  CREATE SCHEMA IF NOT EXISTS ${s};
  CREATE TABLE IF NOT EXISTS ${s}.documents (
    name        TEXT PRIMARY KEY,
    body        JSONB NOT NULL,
    version     BIGINT NOT NULL DEFAULT 1,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS ${s}.records (
    collection  TEXT NOT NULL,
    id          TEXT NOT NULL,
    body        JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (collection, id)
  );
  CREATE TABLE IF NOT EXISTS ${s}.log_lines (
    id          BIGSERIAL PRIMARY KEY,
    stream      TEXT NOT NULL,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    body        JSONB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS log_lines_stream_id ON ${s}.log_lines (stream, id);
  CREATE TABLE IF NOT EXISTS ${s}.leases (
    name        TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ${s}.imports (
    name        TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    bytes       BIGINT NOT NULL DEFAULT 0,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

/** The pool with the schema in place, or null when no database is configured. */
export async function stateDb() {
  const p = getPool();
  if (!p) return null;
  if (!ready) {
    ready = p.query(DDL(schema())).then(() => p).catch((e) => { ready = null; lastError = String(e?.message || e).slice(0, 160); throw e; });
  }
  return ready;
}

/** Run one statement against the state database. Throws when no database is configured. */
export async function stateQuery(text, params = []) {
  const p = await stateDb();
  if (!p) throw new Error("state database not configured");
  try {
    const r = await p.query(text, params);
    lastError = null; // the status word reads "on" again after a good query
    return r;
  } catch (e) {
    lastError = String(e?.message || e).slice(0, 160); // and "degraded" after a failed one
    throw e;
  }
}

const checkName = (name, what = "name") => {
  const n = String(name ?? "");
  if (!n || n.length > NAME_MAX) throw new Error(`${what} must be 1-${NAME_MAX} characters`);
  return n;
};
const T = (table) => `${schema()}.${table}`;

export const documents = {
  async get(name) {
    const r = await stateQuery(`SELECT body, version, updated_at FROM ${T("documents")} WHERE name = $1`, [checkName(name)]);
    return r.rows[0] ? { body: r.rows[0].body, version: Number(r.rows[0].version), updatedAt: new Date(r.rows[0].updated_at) } : null;
  },
  /** Upsert the whole body. */
  async put(name, body) {
    const r = await stateQuery(
      `INSERT INTO ${T("documents")} (name, body) VALUES ($1, $2::jsonb)
       ON CONFLICT (name) DO UPDATE SET body = EXCLUDED.body, version = ${T("documents")}.version + 1, updated_at = now()
       RETURNING version`,
      [checkName(name), JSON.stringify(body ?? null)],
    );
    return Number(r.rows[0].version);
  },
  /** Insert only when no row exists (the import path). Resolves true when this call created the row. */
  async putIfAbsent(name, body) {
    const r = await stateQuery(
      `INSERT INTO ${T("documents")} (name, body) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO NOTHING RETURNING version`,
      [checkName(name), JSON.stringify(body ?? null)],
    );
    return r.rowCount > 0;
  },
  /** Shallow-merge object keys into the body; `dropKeys` are removed. The body is created as {} when absent. */
  async mergeKeys(name, patch = {}, dropKeys = []) {
    const r = await stateQuery(
      `INSERT INTO ${T("documents")} (name, body) VALUES ($1, $2::jsonb)
       ON CONFLICT (name) DO UPDATE SET body = (${T("documents")}.body || $2::jsonb) - $3::text[], version = ${T("documents")}.version + 1, updated_at = now()
       RETURNING body, version`,
      [checkName(name), JSON.stringify(patch ?? {}), dropKeys.map(String)],
    );
    return { body: r.rows[0].body, version: Number(r.rows[0].version) };
  },
  async del(name) {
    const r = await stateQuery(`DELETE FROM ${T("documents")} WHERE name = $1`, [checkName(name)]);
    return r.rowCount > 0;
  },
  async list(prefix = "") {
    // The prefix is literal: backslash, percent and underscore are escaped, with the escape character named.
    const r = await stateQuery(`SELECT name, version, updated_at FROM ${T("documents")} WHERE name LIKE $1 ESCAPE '\\' ORDER BY name`, [`${String(prefix).replace(/[\\%_]/g, "\\$&")}%`]);
    return r.rows.map((x) => ({ name: x.name, version: Number(x.version), updatedAt: x.updated_at }));
  },
};

export const records = {
  async get(collection, id) {
    const r = await stateQuery(`SELECT body FROM ${T("records")} WHERE collection = $1 AND id = $2`, [checkName(collection, "collection"), checkName(id, "id")]);
    return r.rows[0] ? r.rows[0].body : null;
  },
  async put(collection, id, body) {
    await stateQuery(
      `INSERT INTO ${T("records")} (collection, id, body) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (collection, id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
      [checkName(collection, "collection"), checkName(id, "id"), JSON.stringify(body ?? null)],
    );
    return true;
  },
  async del(collection, id) {
    const r = await stateQuery(`DELETE FROM ${T("records")} WHERE collection = $1 AND id = $2`, [checkName(collection, "collection"), checkName(id, "id")]);
    return r.rowCount > 0;
  },
  async list(collection, { limit = 1000, after = "" } = {}) {
    const r = await stateQuery(
      `SELECT id, body FROM ${T("records")} WHERE collection = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [checkName(collection, "collection"), String(after), Math.max(1, Math.min(100_000, Number(limit) || 1000))],
    );
    return r.rows.map((x) => ({ id: x.id, body: x.body }));
  },
  async count(collection) {
    const r = await stateQuery(`SELECT count(*)::bigint AS n FROM ${T("records")} WHERE collection = $1`, [checkName(collection, "collection")]);
    return Number(r.rows[0].n);
  },
};

export const logLines = {
  async append(stream, body) {
    const r = await stateQuery(`INSERT INTO ${T("log_lines")} (stream, body) VALUES ($1, $2::jsonb) RETURNING id`, [checkName(stream, "stream"), JSON.stringify(body ?? null)]);
    return Number(r.rows[0].id);
  },
  /** Lines after `afterId`, oldest first. */
  async read(stream, { afterId = 0, limit = 1000 } = {}) {
    const r = await stateQuery(
      `SELECT id, at, body FROM ${T("log_lines")} WHERE stream = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [checkName(stream, "stream"), Number(afterId) || 0, Math.max(1, Math.min(100_000, Number(limit) || 1000))],
    );
    return r.rows.map((x) => ({ id: Number(x.id), at: x.at, body: x.body }));
  },
  /** The newest lines, newest first. */
  async tail(stream, limit = 100) {
    const r = await stateQuery(
      `SELECT id, at, body FROM ${T("log_lines")} WHERE stream = $1 ORDER BY id DESC LIMIT $2`,
      [checkName(stream, "stream"), Math.max(1, Math.min(100_000, Number(limit) || 100))],
    );
    return r.rows.map((x) => ({ id: Number(x.id), at: x.at, body: x.body }));
  },
  async count(stream) {
    const r = await stateQuery(`SELECT count(*)::bigint AS n FROM ${T("log_lines")} WHERE stream = $1`, [checkName(stream, "stream")]);
    return Number(r.rows[0].n);
  },
};

/**
 * Roll-forward for an append log: the file on the volume is written through
 * on every line, so after a rollback (the old build appends to the file only)
 * it holds lines the stream lacks. Any line past the stream's count is
 * appended, in order. Returns how many were added.
 */
export async function reconcileLogFile(stream, file, { maxBytes = 64 * 1024 * 1024, log = console.log } = {}) {
  if (!file) return 0;
  let text;
  try {
    const { readFileSync, statSync } = await import("node:fs");
    const size = statSync(file).size;
    if (size > maxBytes) return 0; // a file that large is not a rollback window; left for the operator
    text = readFileSync(file, "utf8");
  } catch { return 0; }
  // Count the file's VALID lines against the stream: an unparseable line was
  // never a row, so it must not shift the comparison.
  const recs = [];
  for (const line of text.split("\n").filter(Boolean)) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec && typeof rec === "object") recs.push(rec);
  }
  const have = await logLines.count(stream);
  if (recs.length <= have) return 0;
  let n = 0;
  for (const rec of recs.slice(have)) { await logLines.append(stream, rec); n++; }
  if (n) log(`[state-db] ${stream}: appended ${n} line(s) the file held past the stream (written while rolled back)`);
  return n;
}

export const imports = {
  async done(name) {
    const r = await stateQuery(`SELECT source, bytes, imported_at FROM ${T("imports")} WHERE name = $1`, [checkName(name)]);
    return r.rows[0] ? { source: r.rows[0].source, bytes: Number(r.rows[0].bytes), importedAt: r.rows[0].imported_at } : null;
  },
  async mark(name, { source, bytes = 0 } = {}) {
    await stateQuery(
      `INSERT INTO ${T("imports")} (name, source, bytes) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
      [checkName(name), String(source || "file"), Math.max(0, Number(bytes) || 0)],
    );
    return true;
  },
};

// ---- leases -----------------------------------------------------------------
// One row per lease name. Acquire wins when the row is absent, expired, or
// already ours; release deletes only our own row. A holder that dies leaves a
// row that expires on its own, so a lease is never stuck past its ttl.
const leaseOwnerDefault = `${process.env.RAILWAY_REPLICA_ID || process.env.RAILWAY_DEPLOYMENT_ID || "local"}:${process.pid}`;
export function leaseOwnerId() { return leaseOwnerDefault; }

export const leases = {
  async acquire(name, { owner = leaseOwnerDefault, ttlMs = 60_000 } = {}) {
    const r = await stateQuery(
      `INSERT INTO ${T("leases")} (name, owner, expires_at) VALUES ($1, $2, now() + ($3::bigint * interval '1 millisecond'))
       ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
       WHERE ${T("leases")}.expires_at < now() OR ${T("leases")}.owner = EXCLUDED.owner
       RETURNING owner`,
      [checkName(name), String(owner), Math.max(1000, Number(ttlMs) || 60_000)],
    );
    return r.rowCount > 0;
  },
  async renew(name, { owner = leaseOwnerDefault, ttlMs = 60_000 } = {}) {
    const r = await stateQuery(
      `UPDATE ${T("leases")} SET expires_at = now() + ($3::bigint * interval '1 millisecond') WHERE name = $1 AND owner = $2`,
      [checkName(name), String(owner), Math.max(1000, Number(ttlMs) || 60_000)],
    );
    return r.rowCount > 0;
  },
  async release(name, { owner = leaseOwnerDefault } = {}) {
    const r = await stateQuery(`DELETE FROM ${T("leases")} WHERE name = $1 AND owner = $2`, [checkName(name), String(owner)]);
    return r.rowCount > 0;
  },
  async holder(name) {
    const r = await stateQuery(`SELECT owner, expires_at FROM ${T("leases")} WHERE name = $1 AND expires_at >= now()`, [checkName(name)]);
    return r.rows[0] ? { owner: r.rows[0].owner, expiresAt: r.rows[0].expires_at } : null;
  },
};

/**
 * Run `fn` only while holding the named lease. Without a database the lease
 * is held trivially (one process, as before). When another holder has it the
 * call returns `{ ran: false, reason: "held" }`; a database error also skips
 * the run (`reason: "db"`) rather than running twice. The lease is renewed on
 * a timer while `fn` runs, so a long tick keeps it; it is released after.
 */
// When the database cannot answer a lease, a container that has been up for
// longer than a deploy's overlap is the only container (one replica; the
// overlap is seconds), so it runs its tick as it did before the database
// existed. A young container defers: it may be the new half of a deploy whose
// old half is still running. STATE_DB_LEASE_FAILOPEN_MS sets the age.
export function leaseFailOpenMs(env = process.env) {
  const n = Number(env.STATE_DB_LEASE_FAILOPEN_MS);
  return Number.isFinite(n) && n >= 0 ? n : 10 * 60_000;
}
export async function withLease(name, { ttlMs = 120_000, owner = leaseOwnerDefault, log = console.warn, uptimeMs = process.uptime() * 1000 } = {}, fn) {
  if (typeof fn !== "function") throw new Error("withLease needs a function");
  if (!stateDbEnabled()) return { ran: true, result: await fn() };
  let held = false;
  try { held = await leases.acquire(name, { owner, ttlMs }); }
  catch (e) {
    const why = String(e?.message || e).slice(0, 120);
    if (uptimeMs >= leaseFailOpenMs()) {
      log(`[state-db] lease ${name}: acquire failed (${why}); running without it as the only container (up ${Math.round(uptimeMs / 60_000)} min)`);
      return { ran: true, result: await fn(), reason: "db-failopen" };
    }
    log(`[state-db] lease ${name}: acquire failed (${why}); this tick is skipped (container up ${Math.round(uptimeMs / 1000)} s, under the fail-open age)`);
    return { ran: false, reason: "db" };
  }
  if (!held) return { ran: false, reason: "held" };
  const beat = setInterval(() => { leases.renew(name, { owner, ttlMs }).catch(() => {}); }, Math.max(1000, Math.floor(ttlMs / 3)));
  beat.unref?.();
  try { return { ran: true, result: await fn() }; }
  finally { clearInterval(beat); await leases.release(name, { owner }).catch(() => {}); }
}

// ---- boot ordering --------------------------------------------------------
// Each store registers the promise of its first load; the server awaits them
// all before it listens, so no request sees a store that is still empty
// because its row has not arrived yet.
const readyPromises = new Set();
export function trackStoreReady(p) {
  if (!p || typeof p.then !== "function") return p;
  const wrapped = Promise.resolve(p).catch(() => {});
  readyPromises.add(wrapped);
  wrapped.finally(() => readyPromises.delete(wrapped));
  return p;
}
/** Resolves when every registered store has finished its first load (bounded by `timeoutMs`). */
export async function stateStoresReady({ timeoutMs = 15_000 } = {}) {
  const all = Promise.all([...readyPromises]);
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); timer.unref?.(); });
  const r = await Promise.race([all.then(() => "ready"), deadline]);
  clearTimeout(timer);
  return r;
}

/**
 * Wrap a scheduled tick so it runs under a lease: `leased(name, opts, fn)`
 * returns a function with fn's signature that answers `{ skipped: "leased" }`
 * when another holder has the lease (or the database could not say), and
 * fn's own result otherwise. Without a database it is fn.
 */
export function leased(name, { ttlMs = 120_000, log = console.warn } = {}, fn) {
  if (typeof fn !== "function") throw new Error("leased needs a function");
  return async (...args) => {
    const r = await withLease(name, { ttlMs, log }, () => fn(...args));
    return r.ran ? r.result : { skipped: "leased", reason: r.reason };
  };
}

/** For /api/gateway-status: one word, never a number. */
export function stateDbStatus() {
  if (!stateDbEnabled()) return "off";
  if (lastError) return "degraded"; // a failed connect, setup or query, until the next good one
  if (!ready) return "idle";
  return "on";
}

/** Tests only: drop the configured schema and close the pool. */
export async function __dropStateSchema() {
  const p = getPool();
  if (!p) return;
  await p.query(`DROP SCHEMA IF EXISTS ${schema()} CASCADE`);
}
export async function closeStateDb() {
  const p = pool;
  pool = null; ready = null;
  if (p) await p.end().catch(() => {});
}
