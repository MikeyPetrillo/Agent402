// Tool-call analytics — Postgres-backed, write-through, opt-in.
//
// Every tool dispatch in src/server.js fires `recordToolCall()` after responding.
// We record: timestamp, slug, latency_ms, cached (cache hit), errored. That's
// enough to drive a public /analytics dashboard (top tools, p50/p95 latency,
// cache hit rate, error rate) without recording any caller-identifying data.
//
// Design notes:
//   - ANALYTICS_DATABASE_URL takes precedence; falls back to DATABASE_URL so a
//     single Postgres instance can hold both leads and analytics. If neither is
//     set, every function below is a no-op — the server boots and serves
//     identically. The /analytics route surfaces `{ enabled: false }`.
//   - Schema is created lazily (CREATE TABLE IF NOT EXISTS) — no migration step.
//   - Writes are fire-and-forget: the dispatcher does NOT await them, so even
//     a hung Postgres can't delay an agent's response.
//   - No PII is recorded. No payer wallet, no IP, no request body. Just slug +
//     timing + flags. The dashboard is meant to be public.
import pg from "pg";

const { Pool } = pg;

const ANALYTICS_URL = process.env.ANALYTICS_DATABASE_URL || process.env.DATABASE_URL || "";
let pool = null;
let schemaReady = false;
let unavailable = false;

function getPool() {
  if (!ANALYTICS_URL || unavailable) return null;
  if (pool) return pool;
  pool = new Pool({
    connectionString: ANALYTICS_URL,
    ssl: ANALYTICS_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
  });
  pool.on("error", (err) => {
    console.error("[analytics-db] pool error:", err.message);
  });
  return pool;
}

async function ensureSchema() {
  if (schemaReady) return true;
  const p = getPool();
  if (!p) return false;
  await p.query(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id          BIGSERIAL PRIMARY KEY,
      ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
      slug        TEXT NOT NULL,
      latency_ms  INT NOT NULL,
      cached      BOOLEAN NOT NULL DEFAULT FALSE,
      errored     BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS tool_calls_ts_idx ON tool_calls (ts DESC);
    CREATE INDEX IF NOT EXISTS tool_calls_slug_ts_idx ON tool_calls (slug, ts DESC);
  `);
  schemaReady = true;
  return true;
}

export function analyticsEnabled() {
  return !!ANALYTICS_URL && !unavailable;
}

export async function initAnalyticsDb() {
  if (!ANALYTICS_URL) return { ok: false, reason: "no-db" };
  try {
    await ensureSchema();
    return { ok: true };
  } catch (e) {
    console.error("[analytics-db] init failed:", e.message);
    unavailable = true;
    return { ok: false, reason: "init-failed" };
  }
}

// Fire-and-forget. Never throws — analytics outages must not affect agents.
export async function recordToolCall({ slug, latencyMs, cached, errored }) {
  if (!ANALYTICS_URL || unavailable) return;
  if (!slug) return;
  try {
    if (!schemaReady) await ensureSchema();
    const p = getPool();
    if (!p) return;
    await p.query(
      "INSERT INTO tool_calls (slug, latency_ms, cached, errored) VALUES ($1, $2, $3, $4)",
      [String(slug).slice(0, 128), Math.max(0, latencyMs | 0), !!cached, !!errored]
    );
  } catch (e) {
    // Swallow.
  }
}

// Aggregates for the public dashboard. Bounded by `windowHours` so a query
// can't accidentally scan the whole table.
export async function getAnalytics({ windowHours = 24, top = 25 } = {}) {
  if (!ANALYTICS_URL || unavailable) return { ok: false, enabled: false };
  try {
    await ensureSchema();
    const p = getPool();
    if (!p) return { ok: false, enabled: false };
    const hours = Math.max(1, Math.min(24 * 30, windowHours | 0));
    const topN = Math.max(1, Math.min(200, top | 0));
    const since = `now() - interval '${hours} hours'`;

    const totals = await p.query(`
      SELECT
        count(*)::int                          AS calls,
        count(*) FILTER (WHERE cached)::int    AS cached,
        count(*) FILTER (WHERE errored)::int   AS errored,
        coalesce(round(avg(latency_ms))::int, 0) AS avg_latency_ms,
        coalesce(percentile_disc(0.50) WITHIN GROUP (ORDER BY latency_ms)::int, 0) AS p50_latency_ms,
        coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)::int, 0) AS p95_latency_ms
      FROM tool_calls
      WHERE ts >= ${since}
    `);

    const byTool = await p.query(
      `SELECT
         slug,
         count(*)::int                          AS calls,
         count(*) FILTER (WHERE cached)::int    AS cached,
         count(*) FILTER (WHERE errored)::int   AS errored,
         coalesce(percentile_disc(0.50) WITHIN GROUP (ORDER BY latency_ms)::int, 0) AS p50_ms,
         coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)::int, 0) AS p95_ms
       FROM tool_calls
       WHERE ts >= ${since}
       GROUP BY slug
       ORDER BY calls DESC
       LIMIT $1`,
      [topN]
    );

    return {
      ok: true,
      enabled: true,
      windowHours: hours,
      totals: totals.rows[0],
      topTools: byTool.rows,
    };
  } catch (e) {
    console.error("[analytics-db] query failed:", e.message);
    return { ok: false, enabled: true, error: "query-failed" };
  }
}
