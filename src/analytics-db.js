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
  // CREATE happens once; the ALTERs are idempotent for older deployments
  // that were on a previous schema. Both errored and status are recorded so
  // legacy rows (status defaults to 0) still aggregate correctly when split
  // by class — we treat status=0 as "unclassified" and fall back to errored.
  //
  // `synthetic` marks calls from a trusted internal source (heartbeat probe,
  // operator-issued test fires) — those that arrived with a valid HMAC-signed
  // X-Heartbeat-Token. The dashboard excludes them by default so a CI canary
  // or manual smoke test can never inflate the public error rate. Legacy rows
  // (which couldn't have been synthetic since the column didn't exist) default
  // to FALSE = "real", which is the honest backfill.
  await p.query(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id          BIGSERIAL PRIMARY KEY,
      ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
      slug        TEXT NOT NULL,
      latency_ms  INT NOT NULL,
      cached      BOOLEAN NOT NULL DEFAULT FALSE,
      errored     BOOLEAN NOT NULL DEFAULT FALSE,
      status      SMALLINT NOT NULL DEFAULT 0,
      synthetic   BOOLEAN NOT NULL DEFAULT FALSE
    );
    ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS status SMALLINT NOT NULL DEFAULT 0;
    ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS synthetic BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS probe BOOLEAN NOT NULL DEFAULT FALSE;
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
// `status` is the HTTP status the caller saw (200 for success, 4xx for caller
// errors like missing fields, 5xx for handler/upstream failures). Splitting on
// status lets the dashboard distinguish "agent sent bad input" from "our tool
// or its upstream is broken" — the same `errored: true` would otherwise hide
// the difference. Defaults to 0 when not provided (older callers).
export async function recordToolCall({ slug, latencyMs, cached, errored, status, synthetic, probe }) {
  if (!ANALYTICS_URL || unavailable) return;
  if (!slug) return;
  try {
    if (!schemaReady) await ensureSchema();
    const p = getPool();
    if (!p) return;
    const statusInt = Math.max(0, Math.min(599, status | 0));
    await p.query(
      "INSERT INTO tool_calls (slug, latency_ms, cached, errored, status, synthetic, probe) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [String(slug).slice(0, 128), Math.max(0, latencyMs | 0), !!cached, !!errored, statusInt, !!synthetic, !!probe]
    );
  } catch (e) {
    // Swallow.
  }
}

// Aggregates for the public dashboard. Bounded by `windowHours` so a query
// can't accidentally scan the whole table.
//
// `includeSynthetic` defaults to false: calls minted by a trusted internal
// source (heartbeat probe, operator test fires — anything carrying a valid
// HMAC-signed X-Heartbeat-Token) are excluded so that CI canaries or manual
// smoke tests can never inflate the public error rate. Pass true to see the
// full picture (useful when verifying that synthetic traffic is being tagged).
export async function getAnalytics({ windowHours = 24, top = 25, includeSynthetic = false, includeProbes = false } = {}) {
  if (!ANALYTICS_URL || unavailable) return { ok: false, enabled: false };
  try {
    await ensureSchema();
    const p = getPool();
    if (!p) return { ok: false, enabled: false };
    const hours = Math.max(1, Math.min(24 * 30, windowHours | 0));
    const topN = Math.max(1, Math.min(200, top | 0));
    const since = `now() - interval '${hours} hours'`;
    // SQL fragments — inlined (no parameterization) because they're a fixed
    // boolean toggled by the caller, not user input.
    const realOnly = (includeSynthetic ? "" : "AND NOT synthetic") + (includeProbes ? "" : " AND NOT probe");
    const realOnlyJoin = (includeSynthetic ? "" : "AND NOT t.synthetic") + (includeProbes ? "" : " AND NOT t.probe");

    // `client_errored` (4xx) = caller mistake (missing field, bad shape) —
    // tool is fine. `server_errored` (5xx) = handler or upstream failure —
    // the thing we actually need to fix.
    //
    // Legacy rows pre-status column have status=0. Best-effort backfill: every
    // `bad()` helper across all kits sets statusCode=400, and the dispatcher
    // only reaches the 500 fallback for genuine exceptions. Empirically all
    // sub-10ms errored rows are sync validation throws (4xx). So legacy errored
    // rows default to client_errored — calling them 5xx would falsely accuse
    // the server of being broken when the data overwhelmingly says otherwise.
    const totals = await p.query(`
      SELECT
        count(*)::int                                                       AS calls,
        count(*) FILTER (WHERE cached)::int                                 AS cached,
        count(*) FILTER (WHERE errored)::int                                AS errored,
        count(*) FILTER (WHERE status BETWEEN 400 AND 499
                            OR (errored AND status = 0))::int               AS client_errored,
        count(*) FILTER (WHERE status BETWEEN 500 AND 599)::int             AS server_errored,
        coalesce(round(avg(latency_ms))::int, 0)                            AS avg_latency_ms,
        coalesce(percentile_disc(0.50) WITHIN GROUP (ORDER BY latency_ms)::int, 0) AS p50_latency_ms,
        coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)::int, 0) AS p95_latency_ms
      FROM tool_calls
      WHERE ts >= ${since} ${realOnly}
    `);

    // Synthetic count is always exposed (regardless of includeSynthetic) so the
    // dashboard can show "N synthetic calls hidden" without a second query.
    const syn = await p.query(`
      SELECT count(*)::int AS synthetic_calls
      FROM tool_calls
      WHERE ts >= ${since} AND synthetic
    `);

    const prb = await p.query(`
      SELECT count(*)::int AS probe_calls
      FROM tool_calls
      WHERE ts >= ${since} AND probe
    `);

    const byTool = await p.query(
      `SELECT
         slug,
         count(*)::int                                                      AS calls,
         count(*) FILTER (WHERE cached)::int                                AS cached,
         count(*) FILTER (WHERE errored)::int                               AS errored,
         count(*) FILTER (WHERE status BETWEEN 400 AND 499
                             OR (errored AND status = 0))::int              AS client_errored,
         count(*) FILTER (WHERE status BETWEEN 500 AND 599)::int            AS server_errored,
         coalesce(percentile_disc(0.50) WITHIN GROUP (ORDER BY latency_ms)::int, 0) AS p50_ms,
         coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)::int, 0) AS p95_ms
       FROM tool_calls
       WHERE ts >= ${since} ${realOnly}
       GROUP BY slug
       ORDER BY calls DESC
       LIMIT $1`,
      [topN]
    );

    // Top tools by error count. Same shape as byTool but sorted by total
    // errored calls and filtered to slugs with ≥1 error. This is the operator
    // triage view — "what's broken right now, ranked" — without paying for an
    // external error tracker. Bounded to topN/2 so the page doesn't dominate
    // when one tool has a flood (the volume table still shows full context).
    const errN = Math.max(1, Math.min(50, Math.floor(topN / 2) || 10));
    const errorTools = await p.query(
      `SELECT
         slug,
         count(*)::int                                                      AS calls,
         count(*) FILTER (WHERE status BETWEEN 400 AND 499
                             OR (errored AND status = 0))::int              AS client_errored,
         count(*) FILTER (WHERE status BETWEEN 500 AND 599)::int            AS server_errored,
         count(*) FILTER (WHERE errored)::int                               AS errored
       FROM tool_calls
       WHERE ts >= ${since} ${realOnly}
       GROUP BY slug
       HAVING count(*) FILTER (WHERE errored) > 0
       ORDER BY count(*) FILTER (WHERE errored) DESC, slug ASC
       LIMIT $1`,
      [errN]
    );

    // Hourly buckets for a sparkline. `date_trunc('hour', ts)` groups every
    // call into its UTC hour; we LEFT JOIN against a generated hour series so
    // empty hours show up as 0 instead of being missing.
    const timeseries = await p.query(`
      WITH hours AS (
        SELECT generate_series(
          date_trunc('hour', now() - interval '${hours} hours'),
          date_trunc('hour', now()),
          interval '1 hour'
        ) AS hour
      )
      SELECT
        h.hour                                                  AS ts,
        coalesce(count(t.id), 0)::int                           AS calls,
        coalesce(count(t.id) FILTER (WHERE t.cached), 0)::int   AS cached,
        coalesce(count(t.id) FILTER (WHERE t.errored), 0)::int  AS errored
      FROM hours h
      LEFT JOIN tool_calls t
        ON date_trunc('hour', t.ts) = h.hour ${realOnlyJoin}
      GROUP BY h.hour
      ORDER BY h.hour ASC
    `);

    return {
      ok: true,
      enabled: true,
      windowHours: hours,
      includeSynthetic,
      includeProbes,
      syntheticHidden: includeSynthetic ? 0 : (syn.rows[0]?.synthetic_calls || 0),
      probesHidden: includeProbes ? 0 : (prb.rows[0]?.probe_calls || 0),
      totals: totals.rows[0],
      topTools: byTool.rows,
      errorTools: errorTools.rows,
      timeseries: timeseries.rows,
    };
  } catch (e) {
    console.error("[analytics-db] query failed:", e.message);
    return { ok: false, enabled: true, error: "query-failed" };
  }
}
