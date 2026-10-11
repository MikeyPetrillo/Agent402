// Tollbooth leads: read-only access to the `tollbooth_leads` table on the
// Postgres instance pointed to by DATABASE_URL.
//
// The intake that wrote this table is closed (POST /api/tollbooth/waitlist
// answers 410 and writes nothing). Rows stored before it closed stay readable
// on the operator page until they are removed by hand.
//
// Design notes:
//   - DATABASE_URL is the Railway convention (auto-injected by the Postgres
//     plugin). If absent, every function below is a no-op that returns
//     { ok: false, reason: "no-db" }. Lets the server boot anywhere without a DB.
//   - Schema is created lazily on first use (idempotent CREATE IF NOT EXISTS),
//     so no migration step is required during deploy.
//   - Reads are gated to the operator token (see operator-leads.js +
//     /__operator/leads in server.js). No public read surface.
import pg from "pg";
import { dbSsl } from "./db-ssl.js";
import { probeDbHost } from "./db-probe.js";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || "";
let pool = null;
let schemaReady = false;

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

async function ensureSchema() {
  if (schemaReady) return true;
  const p = getPool();
  if (!p) return false;
  await p.query(`
    CREATE TABLE IF NOT EXISTS tollbooth_leads (
      id          BIGSERIAL PRIMARY KEY,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      kind        TEXT NOT NULL,
      plan        TEXT NOT NULL,
      name        TEXT NOT NULL,
      email       TEXT NOT NULL,
      org         TEXT,
      sites       TEXT,
      message     TEXT,
      ip          TEXT,
      ua          TEXT
    );
    CREATE INDEX IF NOT EXISTS tollbooth_leads_created_at_idx
      ON tollbooth_leads (created_at DESC);
    CREATE INDEX IF NOT EXISTS tollbooth_leads_plan_idx
      ON tollbooth_leads (plan);
  `);
  schemaReady = true;
  return true;
}

export function leadsDbEnabled() {
  return !!DATABASE_URL;
}

export async function initLeadsDb() {
  if (!DATABASE_URL) return { ok: false, reason: "no-db" };
  try {
    await ensureSchema();
    return { ok: true };
  } catch (e) {
    console.error("[leads-db] init failed:", e.message);
    probeDbHost("leads-db", DATABASE_URL).catch(() => {});
    return { ok: false, reason: "init-failed" };
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

export async function listLeads({ limit = 200 } = {}) {
  if (!DATABASE_URL) return { ok: false, reason: "no-db", rows: [] };
  try {
    await ensureSchema();
    const p = getPool();
    const r = await p.query(
      `SELECT id, created_at, kind, plan, name, email, org, sites, message, ip, ua
       FROM tollbooth_leads
       ORDER BY created_at DESC
       LIMIT $1`,
      [Math.max(1, Math.min(1000, limit | 0))]
    );
    return { ok: true, rows: r.rows };
  } catch (e) {
    console.error("[leads-db] list failed:", e.message);
    return { ok: false, reason: "list-failed", rows: [] };
  }
}

export async function countLeads() {
  if (!DATABASE_URL) return { ok: false, total: 0, byPlan: {} };
  try {
    await ensureSchema();
    const p = getPool();
    const total = await p.query("SELECT count(*)::int AS n FROM tollbooth_leads");
    const byPlan = await p.query("SELECT plan, count(*)::int AS n FROM tollbooth_leads GROUP BY plan");
    const map = {};
    for (const r of byPlan.rows) map[r.plan] = r.n;
    return { ok: true, total: total.rows[0].n, byPlan: map };
  } catch (e) {
    console.error("[leads-db] count failed:", e.message);
    return { ok: false, total: 0, byPlan: {} };
  }
}
