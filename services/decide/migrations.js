// Schema for the decide service, applied in order at boot. Credits and
// execution runs are money state and live in the main app's ledger
// (src/decide/ledger.js), not here. Each entry runs once
// (decide_migrations records it). Additive only: a migration never drops or
// rewrites a column another deploy may still be reading.

export const MIGRATIONS = [
  {
    id: 1,
    name: "tool index, decisions, feedback, reliability",
    sql: `
      CREATE TABLE IF NOT EXISTS decide_tools (
        id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        row JSONB NOT NULL,
        embedding BYTEA,
        embedded_hash TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS decide_decisions (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        task TEXT NOT NULL,
        constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
        depth TEXT NOT NULL,
        cache_key TEXT,
        payer TEXT,
        rail TEXT,
        price_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
        confidence REAL,
        result JSONB NOT NULL,
        ranking_weights JSONB
      );
      CREATE INDEX IF NOT EXISTS decide_decisions_cache ON decide_decisions (cache_key, created_at DESC);
      CREATE TABLE IF NOT EXISTS decide_decision_steps (
        decision_id TEXT NOT NULL REFERENCES decide_decisions(id) ON DELETE CASCADE,
        step INT NOT NULL,
        role TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        seller TEXT NOT NULL,
        first_party BOOLEAN NOT NULL,
        score JSONB,
        PRIMARY KEY (decision_id, step, role, tool_id)
      );
      CREATE TABLE IF NOT EXISTS decide_feedback (
        id BIGSERIAL PRIMARY KEY,
        decision_id TEXT NOT NULL,
        step INT NOT NULL,
        tool_id TEXT,
        outcome TEXT NOT NULL,
        quality SMALLINT,
        latency_ms INT,
        reporter TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS decide_feedback_tool ON decide_feedback (tool_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS decide_tool_reliability (
        tool_id TEXT PRIMARY KEY,
        successes INT NOT NULL DEFAULT 0,
        failures INT NOT NULL DEFAULT 0,
        latency_p95_ms INT,
        last_success_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: 2,
    name: "separate buyer-report counts on reliability",
    sql: `
      ALTER TABLE decide_tool_reliability ADD COLUMN IF NOT EXISTS fb_successes INT NOT NULL DEFAULT 0;
      ALTER TABLE decide_tool_reliability ADD COLUMN IF NOT EXISTS fb_failures INT NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 3,
    name: "per-decision serving cost",
    sql: `
      ALTER TABLE decide_decisions ADD COLUMN IF NOT EXISTS cost JSONB;
    `,
  },
];

// Two deploys of this service can overlap (it has no volume), and both run
// migrate at boot: a session advisory lock makes them take turns.
const MIGRATE_LOCK = 402020;

export async function migrate(pool) {
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK]);
    await migrateLocked(pool);
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [MIGRATE_LOCK]).catch(() => {});
    lock.release();
  }
}

async function migrateLocked(pool) {
  await pool.query("CREATE TABLE IF NOT EXISTS decide_migrations (id INT PRIMARY KEY, name TEXT, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const { rows } = await pool.query("SELECT id FROM decide_migrations");
  const done = new Set(rows.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(m.sql);
      await c.query("INSERT INTO decide_migrations (id, name) VALUES ($1, $2)", [m.id, m.name]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
}
