// Tool-call analytics — Postgres-backed, write-through, opt-in.
//
// Every tool dispatch in src/server.js fires `recordToolCall()` after responding.
// We record: timestamp, slug, latency_ms, cached (cache hit), errored. That's
// enough to drive a public /analytics dashboard (top tools, p50/p95 latency,
// cache hit rate, error rate) without recording any caller-identifying data.
//
// Design notes:
//   - ANALYTICS_DATABASE_URL takes precedence; falls back to DATABASE_URL so a
//     single Postgres instance serves both. If neither is
//     set, every function below is a no-op — the server boots and serves
//     identically. The /analytics route surfaces `{ enabled: false }`.
//   - Schema is created lazily (CREATE TABLE IF NOT EXISTS) — no migration step.
//   - Writes are fire-and-forget: the dispatcher does NOT await them, so even
//     a hung Postgres can't delay an agent's response.
//   - No PII is recorded. No payer wallet, no IP, no request body. Just slug +
//     timing + flags. The dashboard is meant to be public.
import pg from "pg";
import { dbSsl } from "./db-ssl.js";
import { probeDbHost } from "./db-probe.js";
import { leased, leaseStillHeld } from "./state-db.js";

const { Pool } = pg;

const ANALYTICS_URL = process.env.ANALYTICS_DATABASE_URL || process.env.DATABASE_URL || "";
// Test sink: ANALYTICS_TEST_CAPTURE=1 makes recordToolCall print each row as a
// single `[tool-call-test] {json}` line instead of touching a database, so a
// suite reads the exact rows a boot would have written (the same pattern as
// POSTHOG_TEST_CAPTURE in src/posthog.js). Never set in production.
const TEST_CAPTURE = process.env.ANALYTICS_TEST_CAPTURE === "1";
let pool = null;
let schemaReady = false;
// After a failed init the database is not retried for RETRY_AFTER_MS. This
// was a permanent latch (`unavailable = true`) until 2026-08-25: one failed
// connect at boot switched analytics off until the next redeploy, so a
// database outage outlived itself by however long the app ran afterwards.
// Now it backs off and retries; a database that comes back is picked up
// within five minutes, and a database that stays down costs one bounded
// connect attempt per five minutes instead of one per call.
const RETRY_AFTER_MS = 5 * 60_000;
let unavailableUntil = 0;
const unavailable = () => Date.now() < unavailableUntil;

// Server-side limits on every connection of this pool, the same two the state
// database pool sets (src/state-db.js stateDbTimeouts: 10 s a statement, 30 s
// for a transaction left idle): the table shares a Postgres with the state
// schema, so a dashboard aggregate or a retention batch that runs long is
// cancelled by the server instead of holding a connection and its locks.
const envMs = (name, dflt) => {
  const n = Number(String(process.env[name] ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};
export function analyticsDbTimeouts() {
  return {
    statementMs: envMs("ANALYTICS_DB_STATEMENT_TIMEOUT_MS", 10_000),
    idleTxMs: envMs("ANALYTICS_DB_IDLE_TX_TIMEOUT_MS", 30_000),
  };
}

function getPool() {
  if (!ANALYTICS_URL || unavailable()) return null;
  if (pool) return pool;
  const t = analyticsDbTimeouts();
  pool = new Pool({
    connectionString: ANALYTICS_URL,
    ssl: dbSsl(ANALYTICS_URL), // F11: verified TLS on public hosts, relaxed only on the private railway.internal mesh
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000, // outlives the ~10 s post-listen boot stall (2026-08-25)
    statement_timeout: t.statementMs,
    idle_in_transaction_session_timeout: t.idleTxMs,
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
    ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS pre_payment BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS tool_calls_ts_idx ON tool_calls (ts DESC);
    CREATE INDEX IF NOT EXISTS tool_calls_slug_ts_idx ON tool_calls (slug, ts DESC);
  `);
  // One-time backfill: tag historical empty-input probes. Every probe we've
  // observed was a 400 rejected in ≤10ms (instant validation throw, no I/O).
  // Idempotent — only touches rows where probe is still FALSE.
  await p.query(`
    UPDATE tool_calls
       SET probe = TRUE
     WHERE errored = TRUE
       AND status = 400
       AND latency_ms <= 10
       AND probe = FALSE
  `).catch(() => {});
  schemaReady = true;
  return true;
}

export function analyticsEnabled() {
  return !!ANALYTICS_URL && !unavailable();
}

// Live reachability probe for src/db-status.js (see pingLeadsDb). Bypasses
// the backoff on purpose: the alarm must see a database that is down NOW,
// not the app's memory of it.
export async function pingAnalyticsDb() {
  if (!ANALYTICS_URL) return null;
  const p = pool || getPoolIgnoringBackoff();
  await p.query("SELECT 1");
  return true;
}
function getPoolIgnoringBackoff() {
  const saved = unavailableUntil;
  unavailableUntil = 0;
  try { return getPool(); } finally { unavailableUntil = saved; }
}

export async function initAnalyticsDb() {
  if (!ANALYTICS_URL) return { ok: false, reason: "no-db" };
  unavailableUntil = 0; // an explicit init is a deliberate retry
  try {
    const ok = await ensureSchema();
    if (!ok) return { ok: false, reason: "init-failed" };
    return { ok: true };
  } catch (e) {
    console.error("[analytics-db] init failed:", e.message);
    probeDbHost("analytics-db", ANALYTICS_URL).catch(() => {});
    unavailableUntil = Date.now() + RETRY_AFTER_MS;
    return { ok: false, reason: "init-failed" };
  }
}

// Fire-and-forget. Never throws — analytics outages must not affect agents.
// `status` is the HTTP status the caller saw (200 for success, 4xx for caller
// errors like missing fields, 5xx for handler/upstream failures). Splitting on
// status lets the dashboard distinguish "agent sent bad input" from "our tool
// or its upstream is broken" — the same `errored: true` would otherwise hide
// the difference. Defaults to 0 when not provided (older callers).
// `prePayment`: a refusal answered before any payment gate (server.js
// recordPrePaymentRefusal); the buyer was never asked to pay for it.
export async function recordToolCall({ slug, latencyMs, cached, errored, status, synthetic, probe, prePayment = false }) {
  if (TEST_CAPTURE) {
    // The row as it would be inserted, one line per call (see TEST_CAPTURE).
    if (slug) console.log(`[tool-call-test] ${JSON.stringify({ slug: String(slug).slice(0, 128), latencyMs: Math.max(0, latencyMs | 0), cached: !!cached, errored: !!errored, status: Math.max(0, Math.min(599, status | 0)), synthetic: !!synthetic, probe: !!probe, prePayment: !!prePayment })}`);
    return;
  }
  if (!ANALYTICS_URL || unavailable()) return;
  if (!slug) return;
  try {
    if (!schemaReady) {
      // A retry after the backoff: on failure, back off again rather than
      // paying a connect timeout on every call while the database is down.
      const ok = await ensureSchema().catch(() => { unavailableUntil = Date.now() + RETRY_AFTER_MS; return false; });
      if (!ok) return;
    }
    const p = getPool();
    if (!p) return;
    const statusInt = Math.max(0, Math.min(599, status | 0));
    await p.query(
      "INSERT INTO tool_calls (slug, latency_ms, cached, errored, status, synthetic, probe, pre_payment) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [String(slug).slice(0, 128), Math.max(0, latencyMs | 0), !!cached, !!errored, statusInt, !!synthetic, !!probe, !!prePayment]
    );
  } catch (e) {
    // Swallow.
  }
}

// --- Retention ---------------------------------------------------------------
// One row per tool call adds up, and nothing reads a row older than the
// dashboard's widest window (MAX_WINDOW_HOURS below, 30 days). A daily leased
// tick deletes rows older than TOOL_CALLS_RETENTION_DAYS (default 180; never
// under RETENTION_MIN_DAYS, so the widest window always has its rows; `off`
// or 0 keeps everything). Each batch is one short statement that walks the
// ts index from its oldest end, so no statement holds a long lock, and the
// tick pauses between batches so other statements and the event loop get
// their turns. A tick stops at its batch bound; the next day's continues.
export const MAX_WINDOW_HOURS = 24 * 30;
export const RETENTION_DEFAULT_DAYS = 180;
export const RETENTION_MIN_DAYS = MAX_WINDOW_HOURS / 24 + 1;
/** The retention in days, or 0 when retention is off. */
export function toolCallsRetentionDays(env = process.env) {
  const raw = String(env.TOOL_CALLS_RETENTION_DAYS ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0") return 0;
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return RETENTION_DEFAULT_DAYS;
  return Math.max(RETENTION_MIN_DAYS, Math.floor(n));
}
const pause = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
/**
 * Delete rows older than the retention, oldest first, `batchSize` at a time,
 * at most `maxBatches` batches. Never throws: a failed batch (the statement
 * limit, a lost connection) ends the run with `error` set and what was
 * deleted so far stays deleted.
 */
export async function pruneToolCalls({ retentionDays = toolCallsRetentionDays(), batchSize = 5000, maxBatches = 100, pauseMs = 200, now = Date.now(), stillHeld = null } = {}) {
  const out = { ok: true, deleted: 0, batches: 0, more: false, retentionDays };
  if (!ANALYTICS_URL) return { ...out, ok: false, reason: "no-db" };
  if (!(retentionDays > 0)) return { ...out, reason: "off" };
  if (unavailable()) return { ...out, ok: false, reason: "unavailable" };
  const size = Math.max(1, Math.min(50_000, batchSize | 0));
  const cutoff = new Date(now - retentionDays * 86_400_000).toISOString();
  try {
    if (!(await ensureSchema())) return { ...out, ok: false, reason: "unavailable" };
    const p = getPool();
    if (!p) return { ...out, ok: false, reason: "unavailable" };
    for (;;) {
      if (stillHeld && !stillHeld()) { out.more = true; break; } // the lease went to another container
      if (out.batches >= maxBatches) { out.more = true; break; }
      const r = await p.query(
        "DELETE FROM tool_calls WHERE id IN (SELECT id FROM tool_calls WHERE ts < $1 ORDER BY ts ASC LIMIT $2)",
        [cutoff, size]
      );
      out.batches++;
      out.deleted += r.rowCount || 0;
      if ((r.rowCount || 0) < size) break;
      if (pauseMs > 0) await pause(pauseMs);
    }
  } catch (e) {
    return { ...out, ok: false, error: String(e?.message || e).slice(0, 160) };
  }
  return out;
}
const RETENTION_LEASE = "tool-calls-retention";
/** One retention run under its lease: `{ skipped: "leased" }` while another container holds it. */
export const pruneToolCallsLeased = leased(RETENTION_LEASE, { ttlMs: 10 * 60_000, log: (m) => console.warn(`[analytics-db] ${m}`) },
  (opts = {}) => pruneToolCalls({ ...opts, stillHeld: () => leaseStillHeld(RETENTION_LEASE) }));
let retentionTimer = null;
/** The daily retention tick (first run a few minutes after boot); under a lease with the state database. */
export function startToolCallRetention({ firstMs = 7 * 60_000, everyMs = 24 * 3_600_000, log = console.log } = {}) {
  if (retentionTimer || !ANALYTICS_URL || !toolCallsRetentionDays()) return false;
  const tick = pruneToolCallsLeased;
  const run = () => tick().then((r) => {
    if (r?.error) console.warn(`[analytics-db] retention stopped after ${r.deleted} row(s): ${r.error}`);
    else if (r?.deleted) log(`[analytics-db] retention: ${r.deleted} row(s) older than ${r.retentionDays} days deleted in ${r.batches} batch(es)${r.more ? "; more remain for the next run" : ""}`);
  }).catch((e) => console.warn(`[analytics-db] retention failed: ${String(e?.message || e).slice(0, 120)}`));
  retentionTimer = setInterval(run, everyMs); retentionTimer.unref?.();
  const f = setTimeout(run, firstMs); f.unref?.();
  return true;
}
/** For tests: close the pool so a script can end. */
export async function closeAnalyticsDb() {
  const p = pool;
  pool = null; schemaReady = false;
  if (p) await p.end().catch(() => {});
}

// Aggregates for the public dashboard. Bounded by `windowHours` so a query
// can't accidentally scan the whole table.
//
// `includeSynthetic` defaults to false: calls minted by a trusted internal
// source (heartbeat probe, operator test fires — anything carrying a valid
// HMAC-signed X-Heartbeat-Token) are excluded so that CI canaries or manual
// smoke tests can never inflate the public error rate. Pass true to see the
// full picture (useful when verifying that synthetic traffic is being tagged).
// `includePrePayment` defaults to false the same way: an input refusal answered
// before any payment gate (an unknown model id, an input over the cap) is free
// traffic anyone can send, so it is counted apart (`prePaymentHidden`) and
// never moves the published call count or error rate.
export async function getAnalytics({ windowHours = 24, top = 25, includeSynthetic = false, includeProbes = false, includePrePayment = false } = {}) {
  // "Never configured" and "configured but the connection failed" are the same
  // shape to a reader and mean opposite things: one is a deliberate choice, the
  // other is an outage wearing its costume. Both used to return a bare
  // {enabled:false}. The boot line (server.js) does name the reason, but a boot
  // line is only readable while it is still in the log buffer - hours later, a
  // live "not enabled" is unattributable, and the two readings call for opposite
  // responses. Reporting it per-request makes the state observable whenever it
  // is asked about. Same rule /status follows for uptime gaps: absence of data
  // is reported as absence, never as a state.
  if (!ANALYTICS_URL) return { ok: false, enabled: false, reason: "not-configured" };
  if (unavailable()) return { ok: false, enabled: false, reason: "init-failed" };
  try {
    await ensureSchema();
    const p = getPool();
    if (!p) return { ok: false, enabled: false, reason: "no-pool" };
    const hours = Math.max(1, Math.min(MAX_WINDOW_HOURS, windowHours | 0));
    const topN = Math.max(1, Math.min(200, top | 0));
    const since = `now() - interval '${hours} hours'`;
    // SQL fragments — inlined (no parameterization) because they're a fixed
    // boolean toggled by the caller, not user input.
    const realOnly = (includeSynthetic ? "" : "AND NOT synthetic") + (includeProbes ? "" : " AND NOT probe") + (includePrePayment ? "" : " AND NOT pre_payment");
    const realOnlyJoin = (includeSynthetic ? "" : "AND NOT t.synthetic") + (includeProbes ? "" : " AND NOT t.probe") + (includePrePayment ? "" : " AND NOT t.pre_payment");

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

    const pre = await p.query(`
      SELECT count(*)::int AS pre_payment_calls
      FROM tool_calls
      WHERE ts >= ${since} AND pre_payment
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
        ON date_trunc('hour', t.ts) = h.hour
       AND t.ts >= date_trunc('hour', now() - interval '${hours} hours') ${realOnlyJoin}
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
      includePrePayment,
      prePaymentHidden: includePrePayment ? 0 : (pre.rows[0]?.pre_payment_calls || 0),
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

/**
 * Strip the per-tool tables from an analytics payload for unauthenticated
 * callers. ONE implementation, used by both the JSON route and the HTML
 * dashboard, because the first version of this control lived only in the JSON
 * route and named a key (`tools`) that this module never returns: the rest
 * spread copied `topTools` and `errorTools` through untouched, so the gate was
 * a no-op that read as enforced. Deriving the key names here, next to the
 * function that produces them, is what stops the two drifting again.
 *
 * The per-tool table is a ranked demand-and-failure map (which tools have
 * traffic, which are erroring, how slow each upstream is), the same class of
 * data /api/sales and /api/stats were reduced to stop publishing. Aggregate
 * totals and the timeseries stay public - they carry no per-tool attribution.
 */
export function redactAnalytics(data, authed) {
  if (authed || !data || typeof data !== "object") return data;
  const { topTools, errorTools, ...aggregate } = data;

  // The per-tool tables are operator-only (2026-10-01). They were published
  // as alphabetical rates, but WHICH tools make the busiest-N cut, and which
  // are failing, is still a traffic-based selection: demand intelligence. An
  // unauthenticated caller gets the aggregate totals and the timeseries.
  void topTools; void errorTools;
  return {
    ...aggregate,
    perToolNote: "Per-tool tables are operator-only. Public reliability is published on /status and /api/reliability.",
  };
}
