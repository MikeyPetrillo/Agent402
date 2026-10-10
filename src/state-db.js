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
import { randomBytes, createHash } from "node:crypto";
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
// lastError is the last failure of any kind (the operator's clue); connFault
// is a connection-class failure (refused, reset, terminated, timed out) or a
// failed schema setup since the last good statement, which is what turns the
// status word "degraded". A constraint violation is the caller's answer, not
// an outage, so it never flips the word.
let lastError = null;
let connFault = false;

const CONN_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ECONNABORTED",
  "57P01", "57P02", "57P03", "57014", "53300", "25P03", "LEASE_ACQUIRE_TIMEOUT",
]);
const CONN_MSG = /Connection terminated|terminating connection|Query read timeout|timeout exceeded when trying to connect|encountered a connection error|not queryable|Connection ended/i;
/** True for a failure that says the database is unreachable, hung or cut off (not a refusal of the statement). */
export function isConnectionError(e) {
  if (!e) return false;
  const code = String(e.code || "");
  if (CONN_CODES.has(code) || /^08/.test(code)) return true;
  return CONN_MSG.test(String(e.message || e));
}
function noteFailure(e) {
  lastError = String(e?.message || e).slice(0, 160);
  if (isConnectionError(e)) connFault = true;
}
function noteSuccess() { connFault = false; }
/** The last state-database failure message (any kind), or null. Never a value from a row. */
export function lastStateDbError() { return lastError; }

// Timeouts, so a database that hangs instead of refusing is detected rather
// than pinning every pooled connection: a server-side statement limit, a
// client-side read limit a little above it (a black-holed socket never
// answers the server's cancel), a limit on a transaction left idle, TCP
// keepalive, and a connect limit that also bounds waiting for a free client.
const envMs = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
export function stateDbTimeouts() {
  const statementMs = envMs("STATE_DB_STATEMENT_TIMEOUT_MS", 10_000);
  return {
    statementMs,
    queryMs: envMs("STATE_DB_QUERY_TIMEOUT_MS", statementMs + 2_000),
    idleTxMs: envMs("STATE_DB_IDLE_TX_TIMEOUT_MS", 30_000),
    connectMs: envMs("STATE_DB_CONNECT_TIMEOUT_MS", 10_000),
    leaseAcquireMs: envMs("STATE_DB_LEASE_ACQUIRE_MS", 10_000),
  };
}

// ---- text Postgres refuses ----------------------------------------------------
// Postgres stores no NUL (U+0000) in text or jsonb, and jsonb refuses a lone
// UTF-16 surrogate written as an escape; SQLite and the JSON files took both.
// Every parameter is cleaned here, once, before it is sent: a raw NUL is
// dropped, a lone surrogate becomes U+FFFD, and in JSON text the escape
// \u0000 is dropped and an escaped lone surrogate becomes \ufffd. Escapes are
// read pairwise, so an escaped backslash followed by "u0000" is left alone.
const JSON_BAD_ESC = /\\u(?:0000|[dD][89a-fA-F][0-9a-fA-F]{2})/;
const JSON_ESC_TOKENS = /\\u([dD][89abAB][0-9a-fA-F]{2})\\u([dD][c-fC-F][0-9a-fA-F]{2})|\\u(0000|[dD][89a-fA-F][0-9a-fA-F]{2})|\\[\s\S]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
function cleanJsonEscapes(s) {
  return s.replace(JSON_ESC_TOKENS, (m, hi, _lo, bad) => {
    if (hi) return m; // an escaped surrogate pair is one valid character
    if (bad !== undefined) return bad === "0000" ? "" : "\\ufffd";
    return m;
  });
}
/** A string as Postgres will take it (see above). Exported for stores that build SQL text themselves. */
export function cleanPgText(s) {
  if (typeof s !== "string") return s;
  let out = s;
  if (out.indexOf("\u0000") !== -1) out = out.replaceAll("\u0000", "");
  if (typeof out.isWellFormed === "function" ? !out.isWellFormed() : LONE_SURROGATE.test(out)) {
    out = typeof out.toWellFormed === "function" ? out.toWellFormed() : out.replace(LONE_SURROGATE, "\ufffd");
  }
  if (out.indexOf("\\u") !== -1 && JSON_BAD_ESC.test(out)) {
    const c = out.trimStart()[0];
    if (c === "{" || c === "[" || c === "\"") out = cleanJsonEscapes(out);
  }
  return out;
}
/** One query parameter cleaned; arrays element-wise, plain objects as the JSON text pg would send. */
export function cleanPgParam(v) {
  if (typeof v === "string") return cleanPgText(v);
  if (Array.isArray(v)) {
    let changed = null;
    for (let i = 0; i < v.length; i++) {
      const c = cleanPgParam(v[i]);
      if (c !== v[i]) { if (!changed) changed = v.slice(); changed[i] = c; }
    }
    return changed || v;
  }
  if (v && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v) && !ArrayBuffer.isView(v) && typeof v.toPostgres !== "function") {
    return cleanPgText(JSON.stringify(v));
  }
  return v;
}
const cleanParams = (params) => (Array.isArray(params) ? cleanPgParam(params) : params);

function schema() {
  if (!schemaName) schemaName = stateDbSchema();
  return schemaName;
}
function getPool() {
  if (!stateDbEnabled()) return null;
  if (pool) return pool;
  const url = stateDbUrl();
  const t = stateDbTimeouts();
  pool = new Pool({
    connectionString: url,
    ssl: dbSsl(url),
    max: Number(process.env.STATE_DB_POOL_MAX) || 6,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: t.connectMs,
    statement_timeout: t.statementMs,
    query_timeout: t.queryMs,
    idle_in_transaction_session_timeout: t.idleTxMs,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  pool.on("error", (err) => { noteFailure(err); console.error("[state-db] pool error:", lastError); });
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
  -- A line restored from the volume file by reconcileLogFile carries a stable
  -- key, so two containers restoring the same line add it once. Lines written
  -- by append have none.
  ALTER TABLE ${s}.log_lines ADD COLUMN IF NOT EXISTS line_key TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS log_lines_stream_key ON ${s}.log_lines (stream, line_key) WHERE line_key IS NOT NULL;
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
    ready = p.query(DDL(schema())).then(() => p).catch((e) => { ready = null; noteFailure(e); connFault = true; throw e; });
  }
  return ready;
}

/** Run one statement against the state database. Throws when no database is configured. */
export async function stateQuery(text, params = []) {
  const p = await stateDb();
  if (!p) throw new Error("state database not configured");
  try {
    const r = await p.query(text, cleanParams(params));
    noteSuccess(); // the status word reads "on" again after a good query
    return r;
  } catch (e) {
    noteFailure(e); // and "degraded" after a connection-class failure
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
 * it holds lines the stream lacks. When the file holds more valid lines than
 * the stream, each file line is matched to the stream by content (key order
 * and the cleaning above do not matter; a repeated line is counted by
 * occurrence), and every line the stream lacks is added once: it carries a
 * stable key (content hash plus occurrence), so two containers restoring the
 * same gap at once add it once. A restored line lands at the stream's end.
 * Returns how many were added.
 */
const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]); return o; }
  return v;
};
const lineHash = (body) => createHash("sha256").update(JSON.stringify(sortKeys(body))).digest("hex").slice(0, 32);
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
  // What the stream holds, by content.
  const inStream = new Map();
  for (let after = 0; ;) {
    const page = await logLines.read(stream, { afterId: after, limit: 5000 });
    for (const row of page) inStream.set(lineHash(row.body), (inStream.get(lineHash(row.body)) || 0) + 1);
    if (page.length < 5000) break;
    after = page[page.length - 1].id;
  }
  const seen = new Map();
  let n = 0;
  for (const rec of recs) {
    // The body as it will be stored (cleaned), so the match is against the row.
    const body = JSON.parse(cleanPgText(JSON.stringify(rec)));
    const h = lineHash(body);
    const k = (seen.get(h) || 0) + 1;
    seen.set(h, k);
    if ((inStream.get(h) || 0) >= k) continue;
    const r = await stateQuery(
      `INSERT INTO ${T("log_lines")} (stream, body, line_key) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (stream, line_key) WHERE line_key IS NOT NULL DO NOTHING`,
      [checkName(stream, "stream"), JSON.stringify(body), `${h}:${k}`],
    );
    n += r.rowCount;
  }
  if (n) log(`[state-db] ${stream}: added ${n} line(s) the file held and the stream lacked (written while rolled back)`);
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
// The owner carries a random per-boot nonce: a replica id and pid can repeat
// across deployments (pid 1 in every container), and two processes that
// shared an owner would each take and release the other's lease.
const bootNonce = randomBytes(4).toString("hex");
const leaseOwnerDefault = `${process.env.RAILWAY_REPLICA_ID || process.env.RAILWAY_DEPLOYMENT_ID || "local"}:${process.pid}:${bootNonce}`;
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
  /** Extend our own row. Resolves false when the row is gone or another owner has it (the lease is lost). */
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

// The leases this process holds or is acquiring, keyed by owner and name. It
// is the in-process re-entry guard (a second call for a name already running
// here answers "busy" and never touches the row, so it can never release the
// first call's lease), the fencing state a running tick reads, and the list
// shutdown releases.
const heldLeases = new Map();
const leaseKey = (owner, name) => `${owner}\u0001${name}`;
let leasesStopped = false;
const TRIVIAL_CTX = Object.freeze({ signal: new AbortController().signal, stillHeld: () => true });

function entryHeld(e) {
  if (!e || e.lost || e.released || e.controller.signal.aborted) return false;
  if (e.failOpen) return true;
  // Held while the last confirmed acquire or renew is within its ttl: past
  // that, another container may have taken the row even if no renew failed yet.
  return e.acquired && Date.now() < e.confirmedAt + e.ttlMs;
}
/**
 * Whether this process still holds the named lease. A loop calls it right
 * before an external effect (a send, a charge, a post) and stops when it
 * reads false. Without a database the lease is held trivially.
 */
export function leaseStillHeld(name, { owner = leaseOwnerDefault } = {}) {
  if (!stateDbEnabled()) return true;
  return entryHeld(heldLeases.get(leaseKey(owner, String(name))));
}

/**
 * Run `fn(ctx)` only while holding the named lease. Without a database the
 * lease is held trivially (one process, as before). When another holder has
 * it the call returns `{ ran: false, reason: "held" }`; when this process is
 * already running it, `{ ran: false, reason: "busy" }` (the row is not
 * touched); after shutdown began, `reason: "shutdown"`; a database error or a
 * timed-out acquire skips the run (`reason: "db"`) rather than running twice.
 * The lease is renewed on a timer while `fn` runs and released after.
 *
 * Fencing: `ctx.signal` aborts and `ctx.stillHeld()` (or `leaseStillHeld(name)`)
 * reads false once the lease is lost: a renew finds the row gone or taken, or
 * no renew has succeeded for a full ttl. The run's answer then carries
 * `lost: true`. `fn` should check before every external effect.
 */
// Fail-open is opt-in (`failOpen: true`), for loops whose effects stay
// inside our own state (crawls, leaderboards, the revenue tail, backups):
// when the database cannot answer, a container up for longer than a
// deploy's overlap is the only container (one replica; the overlap is
// seconds), so it runs its tick as it did before the database existed. A
// young container defers: it may be the new half of a deploy whose old half
// is still running. STATE_DB_LEASE_FAILOPEN_MS sets the age. A loop with
// external effects (mail, posts, charges, reports) never opts in.
export function leaseFailOpenMs(env = process.env) {
  const n = Number(env.STATE_DB_LEASE_FAILOPEN_MS);
  return Number.isFinite(n) && n >= 0 ? n : 10 * 60_000;
}
async function acquireWithin(name, owner, ttlMs, limitMs) {
  let timer;
  let timedOut = false;
  const attempt = leases.acquire(name, { owner, ttlMs });
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const e = new Error(`lease acquire timed out after ${limitMs} ms`);
      e.code = "LEASE_ACQUIRE_TIMEOUT";
      reject(e);
    }, limitMs);
    timer.unref?.();
  });
  // An acquire that lands after we gave up is handed back at once, so the
  // row does not sit unused until its ttl.
  attempt.then((won) => { if (timedOut && won) leases.release(name, { owner }).catch(() => {}); }, () => {});
  try { return await Promise.race([attempt, deadline]); }
  catch (e) { if (timedOut) noteFailure(e); throw e; }
  finally { clearTimeout(timer); }
}
export async function withLease(name, opts = {}, fn) {
  if (typeof opts === "function" && fn === undefined) { fn = opts; opts = {}; }
  if (typeof fn !== "function") throw new Error("withLease needs a function");
  const {
    ttlMs = 120_000, owner = leaseOwnerDefault, log = console.warn, uptimeMs = process.uptime() * 1000,
    failOpen = false, acquireTimeoutMs = stateDbTimeouts().leaseAcquireMs,
  } = opts || {};
  if (!stateDbEnabled()) return { ran: true, result: await fn(TRIVIAL_CTX) };
  if (leasesStopped) return { ran: false, reason: "shutdown" };
  const key = leaseKey(owner, String(name));
  if (heldLeases.has(key)) return { ran: false, reason: "busy" };
  const controller = new AbortController();
  const entry = { name: String(name), owner, ttlMs: Math.max(1000, Number(ttlMs) || 120_000), controller, acquired: false, confirmedAt: 0, lost: false, released: false, failOpen: false, log };
  const ctx = Object.freeze({ signal: controller.signal, stillHeld: () => entryHeld(entry) });
  heldLeases.set(key, entry); // reserved before the first await, so a concurrent call here reads busy
  try {
    const startedAt = Date.now();
    let held = false;
    try { held = await acquireWithin(entry.name, owner, entry.ttlMs, acquireTimeoutMs); }
    catch (e) {
      const why = String(e?.message || e).slice(0, 120);
      if (failOpen && uptimeMs >= leaseFailOpenMs()) {
        log(`[state-db] lease ${name}: acquire failed (${why}); running without it as the only container (up ${Math.round(uptimeMs / 60_000)} min)`);
        entry.failOpen = true;
        return { ran: true, result: await fn(ctx), reason: "db-failopen" };
      }
      log(`[state-db] lease ${name}: acquire failed (${why}); this tick is skipped${failOpen ? ` (container up ${Math.round(uptimeMs / 1000)} s, under the fail-open age)` : ""}`);
      return { ran: false, reason: "db" };
    }
    if (!held) return { ran: false, reason: "held" };
    if (leasesStopped) { await leases.release(entry.name, { owner }).catch(() => {}); return { ran: false, reason: "shutdown" }; }
    entry.acquired = true;
    entry.confirmedAt = startedAt; // the row's expiry counts from no earlier than this
    let renewing = false;
    const beat = setInterval(async () => {
      if (renewing || entry.lost || entry.released) return;
      renewing = true;
      const t = Date.now();
      try {
        if (await leases.renew(entry.name, { owner, ttlMs: entry.ttlMs })) entry.confirmedAt = t;
        else markLeaseLost(entry, "another holder has it");
      } catch (e) {
        if (Date.now() >= entry.confirmedAt + entry.ttlMs) markLeaseLost(entry, `no renew for a full ttl (${String(e?.message || e).slice(0, 80)})`);
      } finally { renewing = false; }
    }, Math.max(250, Math.floor(entry.ttlMs / 3)));
    beat.unref?.();
    try {
      const result = await fn(ctx);
      if (!entry.lost && !entry.released && Date.now() >= entry.confirmedAt + entry.ttlMs) markLeaseLost(entry, "the ttl passed with no renew");
      return entry.lost ? { ran: true, result, lost: true } : { ran: true, result };
    } finally {
      clearInterval(beat);
      if (!entry.released) await leases.release(entry.name, { owner }).catch(() => {});
    }
  } finally { heldLeases.delete(key); }
}
function markLeaseLost(entry, why) {
  if (entry.lost) return;
  entry.lost = true;
  try { entry.log(`[state-db] lease ${entry.name}: lost (${why}); the running tick is told to stop`); } catch { /* logging never throws here */ }
  entry.controller.abort(new Error(`lease ${entry.name} lost`));
}

/**
 * Shutdown, first step: no new leased tick starts in this process, and every
 * running one is told (its signal aborts, stillHeld() reads false). The rows
 * stay until releaseHeldLeases, so another container does not start the same
 * tick while this one is still finishing.
 */
export function stopLeases() {
  leasesStopped = true;
  for (const e of heldLeases.values()) if (!e.controller.signal.aborted) e.controller.abort(new Error("shutting down"));
}
/**
 * Shutdown, last step: release every lease this process holds (bounded by
 * `timeoutMs`), so a container stopped mid-tick does not hold its loops to
 * their ttl. Resolves how many rows were released.
 */
export async function releaseHeldLeases({ timeoutMs = 3_000 } = {}) {
  stopLeases();
  if (!stateDbEnabled()) return 0;
  const work = [...heldLeases.values()].filter((e) => e.acquired && !e.released).map(async (e) => {
    e.released = true;
    try { return (await leases.release(e.name, { owner: e.owner })) ? 1 : 0; } catch { return 0; }
  });
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); });
  const r = await Promise.race([Promise.all(work), deadline]);
  clearTimeout(timer);
  return Array.isArray(r) ? r.reduce((a, b) => a + b, 0) : 0;
}

// ---- boot ordering --------------------------------------------------------
// Each store registers the promise of its first load; the server awaits them
// all before it listens, so no request sees a store that is still empty
// because its row has not arrived yet. A store is "loaded" when that promise
// resolves, "failed" when it rejects. A store that retries its own load calls
// markStoreLoaded(name) when a retry succeeds; a store whose first-load
// promise resolves even though the load failed calls markStoreFailed(name).
// After the boot wait, any store not loaded reads "degraded".
const readyPromises = new Set();
const storeStates = new Map();
let anonStores = 0;
let bootWaitDone = false;
export function trackStoreReady(p, name) {
  if (!p || typeof p.then !== "function") return p;
  const n = name ? String(name) : `store-${++anonStores}`;
  storeStates.set(n, "loading");
  const wrapped = Promise.resolve(p).then(
    () => { if (storeStates.get(n) === "loading") storeStates.set(n, "loaded"); },
    () => { if (storeStates.get(n) === "loading") storeStates.set(n, "failed"); },
  );
  readyPromises.add(wrapped);
  wrapped.finally(() => readyPromises.delete(wrapped));
  return p;
}
export function markStoreLoaded(name) { storeStates.set(String(name), "loaded"); }
export function markStoreFailed(name) { storeStates.set(String(name), "failed"); }
/** Whether every registered store has loaded. Always true without a database. */
export function stateStoresLoaded() {
  if (!stateDbEnabled()) return true;
  for (const s of storeStates.values()) if (s !== "loaded") return false;
  return true;
}
/**
 * Resolves when every registered store has settled its first load (bounded
 * by `timeoutMs`): "ready" when all loaded, "failed" when one rejected,
 * "timeout" when the bound was reached first.
 */
export async function stateStoresReady({ timeoutMs = 15_000 } = {}) {
  const all = Promise.all([...readyPromises]);
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); timer.unref?.(); });
  const r = await Promise.race([all.then(() => "settled"), deadline]);
  clearTimeout(timer);
  bootWaitDone = true;
  if (r === "timeout") return r;
  return stateStoresLoaded() ? "ready" : "failed";
}

/**
 * Run `fn(client)` inside one transaction on a dedicated connection; commits
 * on return, rolls back on throw. The client's query() is the pg client's,
 * with its parameters cleaned as stateQuery's are.
 *
 * While the client is checked out it carries an `error` listener: pg emits
 * `error` on a connection that drops between statements, and the pool only
 * listens while the client is idle, so without one a Postgres restart or a
 * network reset mid-transaction is an uncaught exception. A client whose
 * connection broke is released with the error, so the pool discards it.
 * `timeoutMs` raises the statement limit for this transaction (a large import).
 */
export async function withStateTx(fn, { timeoutMs = 0 } = {}) {
  const p = await stateDb();
  if (!p) throw new Error("state database not configured");
  let client;
  try { client = await p.connect(); }
  catch (e) { noteFailure(e); throw e; }
  let broken = null;
  const onError = (err) => { broken = broken || err || new Error("connection error"); noteFailure(err); };
  client.on("error", onError);
  const hadOwnQuery = Object.prototype.hasOwnProperty.call(client, "query");
  const ownQuery = client.query;
  const queryTimeout = timeoutMs > 0 ? timeoutMs + 2_000 : 0;
  client.query = function cleanedQuery(config, values, cb) {
    if (typeof config === "string") {
      return queryTimeout
        ? ownQuery.call(this, { text: config, values: typeof values === "function" ? undefined : cleanParams(values), query_timeout: queryTimeout }, typeof values === "function" ? values : cb)
        : ownQuery.call(this, config, typeof values === "function" ? values : cleanParams(values), typeof values === "function" ? undefined : cb);
    }
    if (config && typeof config === "object" && typeof config.submit !== "function") {
      const c = { ...config };
      if (Array.isArray(c.values)) c.values = cleanParams(c.values);
      if (queryTimeout && !c.query_timeout) c.query_timeout = queryTimeout;
      return ownQuery.call(this, c, typeof values === "function" ? values : cleanParams(values), cb);
    }
    return ownQuery.call(this, config, values, cb);
  };
  try {
    await client.query("BEGIN");
    if (timeoutMs > 0) await client.query(`SET LOCAL statement_timeout = ${Math.floor(Number(timeoutMs))}`);
    const out = await fn(client);
    await client.query("COMMIT");
    noteSuccess();
    return out;
  } catch (e) {
    noteFailure(e);
    // A connection that dropped or hung cannot roll back; the pool discards
    // it below and Postgres rolls the transaction back when the session ends.
    if (!broken && isConnectionError(e) && e?.code !== "57014") broken = e;
    if (!broken) { try { await client.query("ROLLBACK"); } catch (re) { broken = re || e; } }
    throw e;
  } finally {
    if (hadOwnQuery) client.query = ownQuery; else delete client.query;
    if (broken) {
      // The listener stays on a discarded client: it may still emit while it closes.
      client.release(broken instanceof Error ? broken : true);
    } else {
      client.removeListener("error", onError);
      client.release();
    }
  }
}

/**
 * Run an import exactly once per name (the imports table remembers it):
 * `run()` is called when no mark exists and the mark is written after it
 * returns, so a crash mid-import runs it again at the next boot. Two
 * containers booting at once both see no mark; `run` must therefore be
 * idempotent (insert-if-absent), which the SQLite-to-table imports are.
 */
export async function importOnce(name, { source = "", run }) {
  if (typeof run !== "function") throw new Error("importOnce needs run()");
  if (await imports.done(name)) return { imported: false };
  const out = await run();
  await imports.mark(name, { source, bytes: Number(out?.bytes) || 0 });
  return { imported: true, ...(out && typeof out === "object" ? out : {}) };
}

/**
 * Wrap a scheduled tick so it runs under a lease: `leased(name, opts, fn)`
 * returns a function with fn's signature that answers `{ skipped: "leased" }`
 * when another holder has the lease, this process is already running it
 * (`reason: "busy"`), or the database could not say; fn's own result
 * otherwise. Without a database it is fn. `failOpen: true` only for loops
 * with no external effects (see withLease). Inside fn, `leaseStillHeld(name)`
 * is the fencing check before an external effect.
 */
export function leased(name, { ttlMs = 120_000, log = console.warn, failOpen = false, uptimeMs } = {}, fn) {
  if (typeof fn !== "function") throw new Error("leased needs a function");
  return async (...args) => {
    const r = await withLease(name, { ttlMs, log, failOpen, ...(uptimeMs !== undefined ? { uptimeMs } : {}) }, () => fn(...args));
    return r.ran ? r.result : { skipped: "leased", reason: r.reason };
  };
}

/** For /api/gateway-status: one word, never a number. */
export function stateDbStatus() {
  if (!stateDbEnabled()) return "off";
  if (connFault) return "degraded"; // a connection-class failure or a failed setup, until the next good statement
  if (bootWaitDone && !stateStoresLoaded()) return "degraded"; // a store whose first load never landed
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
