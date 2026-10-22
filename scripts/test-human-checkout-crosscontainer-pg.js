// Two containers, one card checkout, on a REAL Postgres. Container A (this
// process, behind a relay the test cuts) generates a report and loses the
// database before its final record lands, so the record waits in A's local
// journal and A does NOT serve it (a record on one container's disk alone
// may yet be superseded by a takeover; the buyer reads "generating"). This
// suite runs the local-disk journal (no REDIS_URL); the Redis journal's
// cross-container cases are in test-ledger-journal-redis-pg.js. Container B (a child process with its
// own store directory and a healthy connection) then polls the same session.
//   - A beats its claim while the job runs: a claim that is OLD (a long
//     generation) but whose owner beat moments ago is never taken over, so B
//     neither generates the report again nor refunds it, with one takeover
//     already used or none; once A reaches the database again its record lands.
//   - A claim whose owner has been silent past the window IS taken over (the
//     owner is gone): B generates it, so a dead container never strands a buyer.
//   - A report made by a container that cannot land its final record is
//     marked generated on the claim by the next heartbeat that lands; a
//     takeover of such a claim generates again, never refunds.
//   - The owner's heartbeat landing between B's read and B's claim: B's claim
//     (the regeneration's, and the one a refund takes first) is guarded on
//     the silence it read, so it fails and B does nothing.
//   - Same container restarted on the same disk: B lands A's journal before it
//     decides, so it neither generates nor refunds.
// Requires STATE_DATABASE_URL (CI fails without it).
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { childJson } from "./lib/child-json.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireTestPg } from "./lib/test-pg.js";
import { startPgRelay } from "./lib/pg-relay.js";
import { hookStatements } from "./lib/pg-statement-hook.js";

const SELF = fileURLToPath(import.meta.url);
const stripeOf = (refunds) => ({
  refunds: { create: async (o) => { refunds.push(o.payment_intent); return { id: `re_${refunds.length}` }; } },
  checkout: { sessions: { retrieve: async (id) => ({ id, mode: "payment", payment_status: "paid", payment_intent: `pi_${id}`, amount_total: 200, customer_details: { email: null }, metadata: { product: "dossier", input: "MSFT" } }) } },
});
delete process.env.ZEPTOMAIL_TOKEN; delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM;

if (process.argv[2] === "child") {
  // Container B: healthy connection; its own store directory unless SAME_DIR.
  process.env.HUMAN_CHECKOUT_REPLAY_MS = "200";
  const { createHumanCheckout } = await import("../src/human-checkout.js");
  const sdb = await import("../src/state-db.js");
  // Statements are hooked on both paths (pool.query and a checked-out client's
  // query): stateQuery runs each statement on a checked-out client, so a hook
  // on pool.query alone never sees the store's own reads and writes.
  if (process.env.XC_BEAT_BEFORE_CLAIM) {
    // The owner's heartbeat lands after B read the claim and before B's claim statement.
    const pool = await sdb.stateDb();
    const orig = pool.query.bind(pool);
    hookStatements(pool, async (sql, values, run) => {
      if (/DO UPDATE SET body = EXCLUDED\.body/.test(sql) && /'beatAt'/.test(sql) && values.length > 1) {
        await orig(`UPDATE ${sdb.stateDbSchema()}.records SET body = body || jsonb_build_object('beatAt', $2::bigint) WHERE collection = 'human-checkout' AND id = $1`, [values[1], Date.now()]);
      }
      return run();
    });
  }
  if (process.env.XC_SLOW_REPLAY) {
    // The boot replay of the journal is slow to land: B's first poll reads the stale claim before it does.
    const pool = await sdb.stateDb();
    hookStatements(pool, async (sql, values, run) => {
      if (/'refundId' IS NULL/.test(sql)) await new Promise((r) => setTimeout(r, 400));
      return run();
    });
  }
  let gens = 0; const refunds = [];
  const hc = createHumanCheckout({ stripe: stripeOf(refunds), baseUrl: "https://example.test", storeDir: process.env.XC_SAME_DIR || mkdtempSync(join(tmpdir(), "hc-xc-B-")), log: () => {}, generate: async () => { gens++; return { report: "# B" }; } });
  await hc.ready();
  await hc.fulfill(process.argv[3]);
  let p; for (let i = 0; i < 60; i++) { p = await hc.peek(process.argv[3]); if (p && p.status !== "generating") break; await new Promise((r) => setTimeout(r, 50)); }
  console.log(JSON.stringify({ gens, refunds: refunds.length, status: p?.status }));
  await sdb.closeStateDb();
  process.exit(0);
}

requireTestPg({ label: "test-human-checkout-crosscontainer-pg" });
delete process.env.REDIS_URL; // B inherits this environment
const DIRECT = process.env.STATE_DATABASE_URL;
const relay = await startPgRelay(DIRECT);
process.env.STATE_DATABASE_URL = relay.url;
process.env.STATE_DB_CONNECT_TIMEOUT_MS = "1500";
process.env.HUMAN_CHECKOUT_REPLAY_MS = "200";
process.env.HUMAN_CHECKOUT_HEARTBEAT_MS = "100";
const sdb = await import("../src/state-db.js");
const { createHumanCheckout } = await import("../src/human-checkout.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const schema = sdb.stateDbSchema();
const pgDirect = async (sql, params) => {
  const pg = (await import("pg")).default; const c = new pg.Client({ connectionString: DIRECT }); await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
};
const rowOf = async (id) => (await pgDirect(`SELECT body FROM ${schema}.records WHERE collection = 'human-checkout' AND id = $1`, [id])).rows[0]?.body ?? null;
const runB = (id, env = {}) => childJson(execFileSync(process.execPath, [SELF, "child", id], { env: { ...process.env, STATE_DATABASE_URL: DIRECT, STATE_DB_SCHEMA: schema, ...env }, encoding: "utf8" }));
// Age the claim as the clock would: `claimMs` ago it was made, `beatMs` ago it last beat (null: leave the beat).
const ageClaim = (id, { claimMs, beatMs = null, takeovers }) => pgDirect(
  `UPDATE ${schema}.records SET body = body || jsonb_build_object('claimedAt', $2::bigint, 'takeovers', $3::int) || CASE WHEN $4::bigint IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('beatAt', $4::bigint) END WHERE collection = 'human-checkout' AND id = $1`,
  [id, Date.now() - claimMs, takeovers, beatMs == null ? null : Date.now() - beatMs]);

// Container A: the generation takes a few heartbeats, then A loses the database.
function containerA({ dir = mkdtempSync(join(tmpdir(), "hc-xc-A-")) } = {}) {
  const st = { gens: 0, refunds: [], cut: false, dir };
  st.hc = createHumanCheckout({ stripe: stripeOf(st.refunds), baseUrl: "https://example.test", storeDir: dir, log: () => {},
    // The job runs until its heartbeat is in the row (not a fixed time: a slow
    // runner can take longer than a few beat intervals to land the first one).
    generate: async () => { st.gens++; await wait(450); for (let i = 0; i < 50 && st.cut; i++) { const r = await rowOf(st.current).catch(() => null); if (Number(r?.beatAt) > Number(r?.claimedAt)) break; await wait(100); } if (st.cut) relay.cut(); return { report: "# A delivered", title: "t", sources: [], tables: [] }; } });
  return st;
}
// A generates while connected, the database goes away as the report is made; A keeps it on its disk and answers "generating".
async function generateThenLoseDb(a, id) {
  a.cut = true;
  a.current = id;
  await a.hc.fulfill(id);
  for (let i = 0; i < 80 && !(existsSync(join(a.dir, "_pending-finals.ndjson")) && readFileSync(join(a.dir, "_pending-finals.ndjson"), "utf8").includes(id)); i++) await wait(50);
  const p = await a.hc.peek(id).catch(() => null);
  a.cut = false;
  const kept = existsSync(join(a.dir, "_pending-finals.ndjson")) && readFileSync(join(a.dir, "_pending-finals.ndjson"), "utf8").includes(id);
  return { served: p?.status, kept };
}
const healAndLand = async (id) => { relay.heal(); for (let i = 0; i < 40; i++) { await wait(100); const r = await rowOf(id); if (r && r.status !== "generating") return r; } return rowOf(id); };

const A = containerA();
await A.hc.ready();
try {
  // ---- 1. old claim, live owner: B leaves it alone --------------------------
  for (const takeovers of [0, 1]) {
    const id = `cs_xl${takeovers}_${randomBytes(3).toString("hex")}`;
    const a = await generateThenLoseDb(A, id);
    ok(a.served === "generating" && a.kept, `live owner, takeovers=${takeovers}: A kept its record on local disk (${a.kept}) and answers ${a.served}, never the report from its disk alone`);
    const r0 = await rowOf(id);
    ok(r0?.status === "generating" && Number(r0.beatAt) > Number(r0.claimedAt), `live owner, takeovers=${takeovers}: A beat its claim while the job ran (beatAt ${r0?.beatAt ?? "absent"}, claimedAt ${r0?.claimedAt})`);
    await ageClaim(id, { claimMs: 11 * 60_000, takeovers }); // a long generation; the last beat stays as A wrote it
    const b = runB(id);
    ok(b.gens === 0 && b.refunds === 0 && b.status === "generating", `live owner, takeovers=${takeovers}: B neither generates nor refunds a claim whose owner beat moments ago (B generations ${b.gens}, refunds ${b.refunds}, answers ${b.status})`);
    const row = await healAndLand(id);
    ok(row?.status === "done" && row.report === "# A delivered" && !row.refundId, `live owner, takeovers=${takeovers}: A's record lands once the database is back (row ${row?.status}, refundId ${row?.refundId ?? null})`);
  }

  // ---- 2. control: an owner silent past the window is taken over -------------
  {
    const id = `cs_xd_${randomBytes(3).toString("hex")}`;
    await generateThenLoseDb(A, id);
    await ageClaim(id, { claimMs: 11 * 60_000, beatMs: 11 * 60_000, takeovers: 0 });
    const b = runB(id);
    ok(b.gens === 1 && b.refunds === 0 && b.status === "done", `silent owner: B takes over a claim silent past the window and generates it (B generations ${b.gens}, refunds ${b.refunds}, answers ${b.status})`);
    const row = await healAndLand(id);
    ok(row?.status === "done" && !row.refundId, `silent owner: the row ends delivered, not refunded (row ${row?.status})`);
  }

  // ---- 3. a made report is marked on the claim; such a claim is never refunded --
  {
    process.env.HUMAN_CHECKOUT_REPLAY_MS = "60000"; // the journal replay waits; the heartbeat does not
    const A2 = containerA();
    await A2.hc.ready();
    process.env.HUMAN_CHECKOUT_REPLAY_MS = "200";
    const id = `cs_xg_${randomBytes(3).toString("hex")}`;
    const a = await generateThenLoseDb(A2, id);
    relay.heal();
    let r = null; for (let i = 0; i < 40; i++) { await wait(50); r = await rowOf(id); if (r?.generatedAt) break; }
    ok(a.kept && r?.status === "generating" && Number(r.generatedAt) > 0, `generated mark: the first heartbeat that lands marks the claim generated while the record still waits (row ${r?.status}, generatedAt ${r?.generatedAt ?? "absent"})`);
    // A2's container is now gone for good (cut off, then silent past the window), its journal with it.
    relay.cut();
    await ageClaim(id, { claimMs: 11 * 60_000, beatMs: 11 * 60_000, takeovers: 1 });
    const b = runB(id);
    ok(b.refunds === 0 && b.gens === 1 && b.status === "done", `generated mark: a takeover past the last regeneration generates again and never refunds a claim marked generated (B generations ${b.gens}, refunds ${b.refunds}, answers ${b.status})`);
    relay.heal();
  }

  // ---- 4. the owner beats between B's read and B's claim -----------------------
  for (const takeovers of [0, 1]) {
    const id = `cs_xb${takeovers}_${randomBytes(3).toString("hex")}`;
    await generateThenLoseDb(A, id);
    await ageClaim(id, { claimMs: 11 * 60_000, beatMs: 11 * 60_000, takeovers });
    const b = runB(id, { XC_BEAT_BEFORE_CLAIM: "1" });
    ok(b.gens === 0 && b.refunds === 0 && b.status === "generating", `beat after B's read, takeovers=${takeovers}: B's guarded claim fails, so it neither generates nor refunds (B generations ${b.gens}, refunds ${b.refunds}, answers ${b.status})`);
    const row = await healAndLand(id);
    ok(row?.status === "done" && row.report === "# A delivered", `beat after B's read, takeovers=${takeovers}: A's record lands (row ${row?.status})`);
  }

  // ---- 5. same container restarted on the same disk ------------------------------
  {
    const id = `cs_xr_${randomBytes(3).toString("hex")}`;
    await generateThenLoseDb(A, id);
    // The old process is gone (silent past the window); the new one boots on its disk.
    await ageClaim(id, { claimMs: 11 * 60_000, beatMs: 11 * 60_000, takeovers: 1 });
    const b = runB(id, { XC_SAME_DIR: A.dir });
    ok(b.gens === 0 && b.refunds === 0 && b.status === "done", `restart on the same disk: the journal lands before any takeover (B generations ${b.gens}, refunds ${b.refunds}, answers ${b.status})`);
    relay.heal();
  }
  {
    const id = `cs_xs_${randomBytes(3).toString("hex")}`;
    await generateThenLoseDb(A, id);
    await ageClaim(id, { claimMs: 11 * 60_000, beatMs: 11 * 60_000, takeovers: 0 });
    const b = runB(id, { XC_SAME_DIR: A.dir, XC_SLOW_REPLAY: "1" });
    ok(b.gens === 0 && b.refunds === 0 && b.status === "done", `restart on the same disk, slow boot replay: the poll waits for the journal before a takeover (B generations ${b.gens}, refunds ${b.refunds}, answers ${b.status})`);
    relay.heal();
  }
} finally {
  relay.heal();
  try { await pgDirect(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch { /* best effort */ }
  await sdb.closeStateDb(); await relay.close();
}
console.log(`\ntest-human-checkout-crosscontainer-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
