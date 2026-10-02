// The decide service against a REAL Postgres: migrations applied once even
// when two boots race, vectors written in batched statements (not one UPDATE
// per row), and a long statement cut off by the pool's statement timeout.
//
// Needs a throwaway database (it creates and drops the decide_* tables):
//   DECIDE_TEST_PG_URL=postgres://user@127.0.0.1:5433/decide_test node scripts/test-decide-pg.js
// Without it the test says so and exits 0, EXCEPT under CI, where a missing
// database is a failure (a skipped integration test is not coverage).

import pg from "pg";
import { migrate, MIGRATIONS } from "../services/decide/migrations.js";
import { PgToolStore } from "../services/decide/tool-store.js";
import { syncIndex } from "../services/decide/sync.js";
import { ToolIndex } from "../services/decide/tool-index.js";

const URL_ = process.env.DECIDE_TEST_PG_URL || "";
if (!URL_) {
  if (process.env.CI) { console.error("FAIL: DECIDE_TEST_PG_URL is not set under CI"); process.exit(1); }
  console.log("SKIP: set DECIDE_TEST_PG_URL to a throwaway Postgres to run this test");
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const mk = () => new pg.Pool({ connectionString: URL_, max: 5, statement_timeout: 1500 });

const admin = mk();
// ---- retention: decisions and feedback older than 30 days are pruned ----
{
  const pool = mk();
  await migrate(pool);
  const { PgDecisionStore } = await import("../services/decide/decision-store.js");
  const store = new PgDecisionStore(pool);
  await pool.query("INSERT INTO decide_decisions (id, created_at, task, depth, result) VALUES ('old', now() - interval '31 days', 't', 'plan', '{}'::jsonb), ('new', now(), 't', 'plan', '{}'::jsonb) ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO decide_decision_steps (decision_id, step, role, tool_id, seller, first_party) VALUES ('old', 1, 'primary', 'x', 's', true) ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO decide_feedback (decision_id, step, outcome, created_at) VALUES ('old', 1, 'ok', now() - interval '31 days'), ('new', 1, 'ok', now())");
  const r = await store.prune(30);
  const left = (await pool.query("SELECT id FROM decide_decisions ORDER BY id")).rows.map((x) => x.id);
  const steps = (await pool.query("SELECT count(*)::int AS n FROM decide_decision_steps WHERE decision_id = 'old'")).rows[0].n;
  const fb = (await pool.query("SELECT decision_id FROM decide_feedback")).rows.map((x) => x.decision_id);
  ok(r.decisions === 1 && left.includes("new") && !left.includes("old") && steps === 0 && fb.join() === "new", `prune drops decisions (and their steps) and feedback older than 30 days (${JSON.stringify(r)})`);
  await pool.end();
}

await admin.query("DROP TABLE IF EXISTS decide_decision_steps, decide_decisions, decide_tools, decide_feedback, decide_tool_reliability, decide_migrations CASCADE");

// ---- two boots racing migrate(): each migration applied exactly once ----
{
  const a = mk(), b = mk();
  const results = await Promise.allSettled([migrate(a), migrate(b)]);
  ok(results.every((r) => r.status === "fulfilled"), `two concurrent migrate() calls both succeed (${results.map((r) => r.status).join(", ")})`);
  const { rows } = await admin.query("SELECT id FROM decide_migrations ORDER BY id");
  ok(rows.map((r) => r.id).join() === MIGRATIONS.map((m) => m.id).join(), `every migration recorded once (${rows.map((r) => r.id).join()})`);
  const cols = await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'decide_decisions' AND column_name = 'cost'");
  ok(cols.rows.length === 1, "migration 3 added the cost column");
  await a.end(); await b.end();
}

// ---- batched vector writes ----
{
  const pool = mk();
  let statements = 0;
  const counting = { query: (...args) => { statements++; return pool.query(...args); } };
  const store = new PgToolStore(counting);
  const rows = Array.from({ length: 1200 }, (_, i) => ({ id: `t${i}`, contentHash: `h${i}`, name: `t${i}` }));
  await store.upsert(rows);
  statements = 0;
  const vec = new Int8Array(512).fill(3);
  await store.setVectors(rows.map((r) => ({ id: r.id, hash: r.contentHash, vec })));
  ok(statements === 3, `1,200 vectors written in ${statements} statements (batches of 500), not 1,200`);
  const { rows: r } = await pool.query("SELECT COUNT(*)::int AS n FROM decide_tools WHERE embedded_hash = content_hash AND octet_length(embedding) = 512");
  ok(r[0].n === 1200, `every vector stored against its content hash (${r[0].n})`);
  const loaded = [];
  await store.load((row, v) => loaded.push(v));
  ok(loaded.length === 1200 && loaded.every((v) => v && v.length === 512 && v[0] === 3), "vectors read back intact");
  await pool.end();
}

// ---- a stream that repeats an id syncs (Postgres refuses to upsert one row twice in a batch) ----
{
  const pool = mk();
  const store = new PgToolStore(pool);
  const row = (id, h) => ({ id, contentHash: h, name: id, description: "d", slug: id, inputSchema: { properties: {} }, rails: ["x402"], priceUsd: 0.001, lastLiveAt: Date.now() });
  const body = [row("dup1", "a"), row("dup1", "b"), row("solo", "c")].map((r) => JSON.stringify(r)).join("\n") + "\n" + JSON.stringify({ __end: true, rows: 3 }) + "\n";
  const res = await syncIndex({ index: new ToolIndex(), store, source: async () => body, embed: async () => { throw new Error("no embed here"); } });
  ok(res.complete && res.duplicates === 1 && res.rows === 2, `a repeated id is skipped and the sync completes (${JSON.stringify({ complete: res.complete, duplicates: res.duplicates, rows: res.rows })})`);
  const { rows } = await pool.query("SELECT content_hash FROM decide_tools WHERE id = 'dup1'");
  ok(rows.length === 1 && rows[0].content_hash === "a", "the first row for an id wins");
  await pool.end();
}

// ---- statement timeout ----
{
  const pool = mk();
  let err = null;
  try { await pool.query("SELECT pg_sleep(3)"); } catch (e) { err = e; }
  ok(err && /statement timeout/i.test(err.message), `a long statement is cut off by the pool's statement_timeout (${err?.message?.slice(0, 60)})`);
  await pool.end();
}

await admin.query("DROP TABLE IF EXISTS decide_decision_steps, decide_decisions, decide_tools, decide_feedback, decide_tool_reliability, decide_migrations CASCADE");
await admin.end();
console.log(`\ntest-decide-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
