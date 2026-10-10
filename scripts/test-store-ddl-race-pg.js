// Two processes booting at once on an EMPTY schema: every store creates its
// tables with CREATE ... IF NOT EXISTS, and two of those racing on the
// catalog can fail with a unique violation on pg_type or pg_class. The DDL
// runs under one advisory lock (withSchemaLock), so both processes' first
// loads succeed, every round, with no retry needed (retries are pushed past
// the test's horizon here, so a failed first attempt shows).
// The shared base tables (state-db's own) are created by the parent first:
// this test is about the stores' DDL.
// Requires STATE_DATABASE_URL (CI fails without it).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { requireTestPg } from "./lib/test-pg.js";
const { url } = requireTestPg({ label: "test-store-ddl-race-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROOT = new URL("..", import.meta.url).pathname;
const ROUNDS = Number(process.env.DDL_RACE_ROUNDS || 5);
const boot = `
  const res = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const H = process.env.H_DIR;
  // Wait for the start line so both processes issue their DDL together.
  while (Date.now() < Number(process.env.START_AT)) await wait(5);
  const st = await import("./src/stats.js");
  const ss = await import("./src/status-store.js");
  const ec = await import("./src/x402-economy.js");
  const pw = await import("./src/pow.js");
  const sh = await import("./src/stripe-shadow-ledger.js");
  const wi = await import("./src/wish.js");
  const rv = await import("./src/revenue-ledger.js");
  const sl = await import("./src/sales-ledger.js");
  const rl = await import("./src/refund-ledger.js");
  const mem = await import("./src/tools/memory.js");
  const { createCredits } = await import("./src/credits.js");
  const { openDecideLedger } = await import("./src/decide/ledger.js");
  const { createHumanCheckout } = await import("./src/human-checkout.js");
  const credits = createCredits({ stripe: {}, baseUrl: "https://agent402.tools", storeDir: H + "/credits", log: () => {} });
  const decide = openDecideLedger(H + "/decide.db");
  const hc = createHumanCheckout({ stripe: {}, generate: async () => ({}), baseUrl: "https://agent402.tools", storeDir: H + "/checkout", onSale: () => {}, log: () => {} });
  const shadow = sh.createShadowLedger({ env: { ...process.env, STRIPE_SHADOW_LEDGER: "on", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_SHADOW_INTERVAL_MS: "0" }, dbFile: H + "/shadow.db", log: () => {} });
  const { stateStoresReady } = await import("./src/state-db.js");
  await stateStoresReady({ timeoutMs: 20000 });
  console.log("DONE");
  process.exit(0);
`;
function child(env) {
  return new Promise((res) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", boot], { cwd: ROOT, env });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    const kill = setTimeout(() => c.kill("SIGKILL"), 60_000);
    c.on("exit", () => { clearTimeout(kill); res(out + err); });
  });
}
const FAILED = /first load failed|load failed|setup failed|store unavailable|import into the state database failed|could not rebuild|duplicate key value|already exists/;
// The stores this test covers: every store whose first load runs its own DDL.
const MINE = /^(\[(stats|status-store|pow|stripe-shadow|wish|credits|decide|human-checkout|sales-ledger|refund-ledger|memory)\]|x402-economy:|revenue-ledger:|sales ledger |refund ledger |memory )/;
const pg = (await import("pg")).default;
for (let i = 0; i < ROUNDS; i++) {
  const schema = `t_race_${randomBytes(4).toString("hex")}`;
  const dirs = [mkdtempSync(join(tmpdir(), "ddl-race-")), mkdtempSync(join(tmpdir(), "ddl-race-"))];
  // The base tables, so only the stores' own DDL races.
  process.env.STATE_DB_SCHEMA = schema;
  const sdb = await import(`../src/state-db.js?r${i}`);
  await sdb.stateDb(); await sdb.closeStateDb();
  const START_AT = String(Date.now() + 1500);
  const envs = dirs.map((d) => ({
    ...process.env, STATE_DATABASE_URL: url, STATE_DB_SCHEMA: schema, NODE_ENV: "test", FREE_MODE: "true", H_DIR: d, START_AT,
    STATE_STORE_RETRY_MS: "600000", STATS_DB_DIR: d, POW_DB_PATH: join(d, "pow.db"), POW_ALLOW_EPHEMERAL: "true", STATUS_DB_PATH: join(d, "status.db"),
    X402_ECONOMY_DB: join(d, "econ.db"), WISH_FILE: join(d, "wishes.jsonl"), REVENUE_LEDGER_DB: join(d, "rev.db"), SALES_LEDGER_DB: join(d, "sales.db"), REFUND_DB_DIR: d,
    MEMORY_DB_FILE: join(d, "agent402.db"), MEMORY_ALLOW_EPHEMERAL: "true",
  }));
  const outs = await Promise.all(envs.map(child));
  for (const [j, o] of outs.entries()) {
    const bad = o.split("\n").filter((l) => FAILED.test(l) && MINE.test(l.trim()));
    ok(/DONE/.test(o) && bad.length === 0, `round ${i + 1} process ${j + 1}: every store's first load succeeded${bad.length ? ` (${bad.slice(0, 3).join(" | ").slice(0, 300)})` : ""}`);
  }
  const c = new pg.Client({ connectionString: url }); await c.connect(); await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await c.end();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
console.log(`\ntest-store-ddl-race-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
