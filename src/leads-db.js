// Tollbooth waitlist + partner leads — minimal Postgres-backed intake.
//
// Storage layer for /api/tollbooth/waitlist submissions. The form on
// /tollbooth/waitlist captures structured intent (name, email, org, sites,
// plan, message); this module persists each submission into a single
// `tollbooth_leads` table on the Postgres instance pointed to by DATABASE_URL.
//
// Design notes:
//   - DATABASE_URL is the Railway convention (auto-injected by the Postgres
//     plugin). If absent, every function below is a no-op that returns
//     { ok: false, reason: "no-db" } — the form falls back to the GitHub
//     pre-fill flow it had before. Lets the server boot anywhere without a DB.
//   - Schema is created lazily on first use (idempotent CREATE IF NOT EXISTS),
//     so no migration step is required during deploy.
//   - Reads are gated to the operator token (see operator-leads.js +
//     /__operator/leads in server.js). No public read surface.
//   - Inputs are length-capped before INSERT so a single bad request can't
//     blow up disk. IP + UA are recorded for spam triage.
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || "";
let pool = null;
let schemaReady = false;

function getPool() {
  if (!DATABASE_URL) return null;
  if (pool) return pool;
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Railway's internal proxy already does TLS; for the public proxy URL,
    // require SSL with a relaxed verify so self-signed certs pass. This
    // mirrors what every Railway Postgres tutorial recommends.
    ssl: DATABASE_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
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

const cap = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");

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
    return { ok: false, reason: "init-failed" };
  }
}

export async function insertLead(lead) {
  if (!DATABASE_URL) return { ok: false, reason: "no-db" };
  try {
    await ensureSchema();
    const p = getPool();
    const row = {
      kind: cap(lead.kind || "waitlist", 32),
      plan: cap(lead.plan || "team", 32),
      name: cap(lead.name, 200),
      email: cap(lead.email, 320),
      org: cap(lead.org, 200),
      sites: cap(lead.sites, 1000),
      message: cap(lead.message, 4000),
      ip: cap(lead.ip, 64),
      ua: cap(lead.ua, 500),
    };
    const r = await p.query(
      `INSERT INTO tollbooth_leads (kind, plan, name, email, org, sites, message, ip, ua)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, created_at`,
      [row.kind, row.plan, row.name, row.email, row.org, row.sites, row.message, row.ip, row.ua]
    );
    return { ok: true, id: r.rows[0].id, createdAt: r.rows[0].created_at };
  } catch (e) {
    console.error("[leads-db] insert failed:", e.message);
    return { ok: false, reason: "insert-failed" };
  }
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
