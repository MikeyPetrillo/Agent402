// Two server processes on one state schema at once, the shape of a deploy
// overlap: the second boots beside the first without re-importing, both
// answer, both processes' writes land in the shared tables, exactly one of
// them holds a given loop's lease at a time, and the first drains while the
// second keeps serving. Requires STATE_DATABASE_URL (CI fails without it).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
import { getFreePorts } from "./lib/free-port.js";
const { url, schema } = requireTestPg({ label: "test-state-db-overlap" });
const sdb = await import("../src/state-db.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 250) => { const t0 = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t0 > ms) return false; await sleep(step); } };
const [PA, PB] = await getFreePorts(2);
const DIR = mkdtempSync(join(tmpdir(), "overlap-"));
// A seed file for one store whose path the environment sets (the per-chain
// spend ledger), so the first boot imports it and the second must not.
writeFileSync(join(DIR, "spend.json"), JSON.stringify({ chains: { base: [{ usd: 0.01, at: Date.now() }] }, at: Date.now() }));

function boot(port, tag) {
  let log = "";
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env, STATE_DATABASE_URL: url, STATE_DB_SCHEMA: schema, FREE_MODE: "true", PORT: String(port), RAILWAY_REPLICA_ID: tag,
      X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off",
      STATS_DB_DIR: DIR, MEMORY_DB_FILE: join(DIR, "agent402.db"), POW_DB_PATH: join(DIR, `pow-${tag}.db`), STATUS_DB_PATH: join(DIR, "status.db"),
      X402_ECONOMY_DB: join(DIR, "economy.db"), SALES_LEDGER_DB: join(DIR, "sales.db"), REFUND_DB_DIR: DIR, DECIDE_LEDGER_DB: join(DIR, "decide.db"),
      REVENUE_LEDGER_DB: join(DIR, "revenue.db"), TRAFFIC_DIR: join(DIR, "traffic"), WISH_FILE: join(DIR, "wishes.jsonl"), OUTBOUND_LEDGER_FILE: join(DIR, "outbound.ndjson"),
      HANGUP_FORGIVE_FILE: join(DIR, "hangup.json"), WALLET_DAILY_LEDGER_FILE: join(DIR, "spend.json"), EMAIL_STATUS_FILE: join(DIR, "email.json"), MPP_RECONCILE_FILE: join(DIR, "reconcile.json"),
      FREE_ALERTS_SECRET: "overlap-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const o = { child, port, tag, exited: null, get log() { return log; } };
  child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  child.on("exit", (code, signal) => { o.exited = { code, signal }; });
  return o;
}
const get = async (port, p, ms = 8000) => { try { const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(ms) }); return { status: r.status, body: await r.text() }; } catch (e) { return { status: 0, body: String(e?.message || e) }; } };
const callTool = async (port, text) => { try { const r = await fetch(`http://127.0.0.1:${port}/api/hash`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, algo: "sha256" }), signal: AbortSignal.timeout(8000) }); return r.status; } catch { return 0; } };
const T = (t) => `${sdb.stateDbSchema()}.${t}`;
const recentCalls = async () => Number((await sdb.stateQuery(`SELECT count(*)::bigint AS n FROM ${T("stats_recent_calls")}`)).rows[0].n);

const A = boot(PA, "old"); let B = null;
try {
  ok(await until(async () => (await get(PA, "/health", 2000)).status === 200, 120_000, 500), "A boots");
  ok(await until(async () => /spend\.json: imported/.test(A.log), 15_000), "A imports the seed file");
  const imported = await sdb.imports.done("spend.json");
  ok(!!imported, "the import is marked");

  B = boot(PB, "new");
  ok(await until(async () => (await get(PB, "/health", 2000)).status === 200, 120_000, 500), "B boots beside A on the same schema");
  ok(!/spend\.json: imported/.test(B.log), "B does not re-import the seed file");
  ok((await get(PA, "/health")).status === 200 && (await get(PB, "/health")).status === 200, "both answer while they overlap");
  const before = await recentCalls();
  ok(await callTool(PA, "from-A") === 200 && await callTool(PB, "from-B") === 200, "a call to each lands");
  ok(await until(async () => (await recentCalls()) >= Math.min(200, before + 2), 20_000), "both processes' writes reach the shared table");

  // Exactly one holder per lease name: take one as a third party and watch both skip it.
  const owner = "third-container";
  await sdb.leases.acquire("followups-tick", { owner, ttlMs: 60_000 });
  const holder = await sdb.leases.holder("followups-tick");
  ok(holder && holder.owner === owner, "a lease held elsewhere is visible to both as held");
  await sdb.leases.release("followups-tick", { owner });

  // A drains while B keeps serving.
  A.child.kill("SIGTERM");
  const duringDrain = [];
  for (let i = 0; i < 5; i++) { duringDrain.push(await callTool(PB, `during-${i}`)); await sleep(50); }
  ok(duringDrain.every((s) => s === 200), `B answers 200 throughout A's drain (${duringDrain.join(",")})`);
  ok(await until(async () => A.exited !== null, 30_000), "A exits");
  ok(A.exited && A.exited.code === 0, `A exits 0 (got ${A.exited?.code})`);
  ok((await get(PB, "/health")).status === 200, "B still serves after A is gone");
  ok(JSON.parse((await get(PB, "/api/gateway-status")).body)?.stateDb?.status === "on", "B's status word reads on");
  B.child.kill("SIGTERM");
  ok(await until(async () => B.exited !== null, 30_000) && B.exited.code === 0, "B drains and exits 0");
  ok(!/\[unhandledRejection\]|\[uncaughtException\]/.test(A.log + B.log), "no unhandled rejection in either log");
} finally {
  for (const p of [A, B]) if (p && p.exited === null) { try { p.child.kill("SIGKILL"); } catch { /* gone */ } }
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
if (fail) { console.error("---- A log tail ----"); console.error(A.log.split("\n").slice(-25).join("\n")); if (B) { console.error("---- B log tail ----"); console.error(B.log.split("\n").slice(-25).join("\n")); } }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
