// The DATABASE_URL Postgres: reachability ping, and the one-time removal of
// the retired tollbooth waitlist table.
//
// The tollbooth waitlist intake is closed (POST /api/tollbooth/waitlist
// answers 410 and writes nothing), and the rows it stored are deleted: on
// every boot with DATABASE_URL set, initLeadsDb drops `tollbooth_leads` if it
// still exists and logs only how many rows it held. Nothing in this tree
// creates that table, so once it is gone the boot step is a no-op.
//
// Design notes:
//   - DATABASE_URL is the Railway convention (auto-injected by the Postgres
//     plugin). If absent, every function below is a no-op that returns
//     { ok: false, reason: "no-db" }. Lets the server boot anywhere without a DB.
//   - Two containers booting together are safe: the drop runs in one
//     transaction behind an ACCESS EXCLUSIVE lock, and a table another
//     container dropped first reads as already removed.
//   - A failure is logged and returned; src/db-init-retry.js retries it on
//     its schedule, and the next boot tries again. It never throws into boot.
//   - The pool stays for pingLeadsDb: /api/gateway-status `databases.leads`
//     reports this database's reachability (analytics falls back to it).
import pg from "pg";
import { dbSsl } from "./db-ssl.js";
import { probeDbHost } from "./db-probe.js";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || "";
const TABLE = "tollbooth_leads";
let pool = null;

function getPool() {
  if (!DATABASE_URL) return null;
  if (pool) return pool;
  pool = new Pool({
    connectionString: DATABASE_URL,
    // F11: TLS policy by route. Private Railway mesh (*.railway.internal) keeps
    // the working relaxed setting (no MITM position there); any public/proxied
    // host verifies the cert and fails closed. See src/db-ssl.js.
    ssl: dbSsl(DATABASE_URL),
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000, // outlives the ~10 s post-listen boot stall (2026-08-25)
  });
  pool.on("error", (err) => {
    // Don't crash the server on a dropped idle client — Postgres on Railway
    // recycles them. Log and let the next acquire reconnect.
    console.error("[leads-db] pool error:", err.message);
  });
  return pool;
}

// Drop the retired table if it exists. Resolves { ok, removed } where
// `removed` is the row count it held (null when it was already gone). Only the
// count is logged; no row is ever read.
export async function purgeLeadsTable({ log = console.log } = {}) {
  const p = getPool();
  if (!p) return { ok: false, reason: "no-db" };
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const exists = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [TABLE]);
    if (!exists.rows[0].present) { await client.query("ROLLBACK"); return { ok: true, removed: null }; }
    let n;
    try {
      await client.query(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE`);
      n = (await client.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n;
    } catch (e) {
      // Another container dropped it while this one waited for the lock.
      if (e?.code === "42P01") { await client.query("ROLLBACK"); return { ok: true, removed: null }; }
      throw e;
    }
    await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await client.query("COMMIT");
    log(`[leads-db] removed ${TABLE} (${n} rows)`);
    return { ok: true, removed: n };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* connection may be gone */ }
    throw e;
  } finally {
    client.release();
  }
}

export async function initLeadsDb({ log = console.log } = {}) {
  if (!DATABASE_URL) return { ok: false, reason: "no-db" };
  try {
    return await purgeLeadsTable({ log });
  } catch (e) {
    console.error("[leads-db] purge failed:", e?.code || e?.message || "error");
    probeDbHost("leads-db", DATABASE_URL).catch(() => {});
    return { ok: false, reason: "purge-failed" };
  }
}

// Live reachability probe for src/db-status.js: SELECT 1 through the pool,
// null when no database is configured. Throws on any failure - the caller
// buckets it; nothing about the failure leaves this process.
export async function pingLeadsDb() {
  const p = getPool();
  if (!p) return null;
  await p.query("SELECT 1");
  return true;
}

// For tests: close the pool so the process can exit.
export async function closeLeadsDb() {
  const p = pool;
  pool = null;
  if (p) await p.end();
}
