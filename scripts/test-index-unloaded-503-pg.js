// The seller index's removal list is unread while the database is down at
// boot. A registration and an operator restore cannot be answered then:
// both say so with a 503 and a Retry-After (a retry is the remedy), instead
// of a 200 that reads like a final "not listed" or a 400 that reads like a
// bad request. Once the database answers, the restore is a plain 200.
// Boots the server behind a relay that refuses every connection until the
// test heals it.
// Requires STATE_DATABASE_URL (CI fails without it).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
import { startPgRelay } from "./lib/pg-relay.js";
import { getFreePort } from "./lib/free-port.js";
const { url, schema } = requireTestPg({ label: "test-index-unloaded-503-pg" });
const sdb = await import("../src/state-db.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 250) => { const t0 = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t0 > ms) return false; await sleep(step); } };

await sdb.stateDb(); // the schema exists; the server's own connections are what the relay refuses
const relay = await startPgRelay(url);
relay.cut();
const DIR = mkdtempSync(join(tmpdir(), "index-unloaded-"));
const PORT = await getFreePort();
let log = "";
const child = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env, STATE_DATABASE_URL: relay.url, STATE_DB_SCHEMA: schema, FREE_MODE: "true", PORT: String(PORT),
    X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", REDIS_URL: "", AGENT402_OPERATOR_TOKEN: "op-test-token-unloaded",
    STATE_DB_CONNECT_TIMEOUT_MS: "1000", STATE_STORE_RETRY_MS: "500", STATE_STORE_RETRY_MAX_MS: "1000",
    STATS_DB_DIR: DIR, MEMORY_DB_FILE: join(DIR, "agent402.db"), POW_DB_PATH: join(DIR, "pow.db"), STATUS_DB_PATH: join(DIR, "status.db"),
    X402_ECONOMY_DB: join(DIR, "economy.db"), SALES_LEDGER_DB: join(DIR, "sales.db"), REFUND_DB_DIR: DIR, DECIDE_LEDGER_DB: join(DIR, "decide.db"),
    REVENUE_LEDGER_DB: join(DIR, "revenue.db"), TRAFFIC_DIR: join(DIR, "traffic"), WISH_FILE: join(DIR, "wishes.jsonl"), OUTBOUND_LEDGER_FILE: join(DIR, "outbound.ndjson"),
    HANGUP_FORGIVE_FILE: join(DIR, "hangup.json"), WALLET_DAILY_LEDGER_FILE: join(DIR, "spend.json"), EMAIL_STATUS_FILE: join(DIR, "email.json"), MPP_RECONCILE_FILE: join(DIR, "reconcile.json"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
const base = `http://127.0.0.1:${PORT}`;
const getJson = async (p) => { try { const r = await fetch(base + p, { signal: AbortSignal.timeout(8000) }); return { status: r.status, body: await r.json() }; } catch (e) { return { status: 0, body: null, error: String(e?.message || e) }; } };
const stateWord = async () => (await getJson("/api/gateway-status")).body?.stateDb?.status;

const post = async (p, body, headers = {}) => {
  try {
    const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    return { status: r.status, retryAfter: r.headers.get("retry-after"), body: await r.json().catch(() => null) };
  } catch (e) { return { status: 0, body: null, error: String(e?.message || e) }; }
};
const OP = { "x-operator-token": "op-test-token-unloaded" };

try {
  ok(await until(async () => (await getJson("/health")).status > 0, 90_000, 500), "the server listens after the boot wait with the database unreachable");
  const reg = await post("/api/index/register", { origin: "https://seller-unloaded.example" });
  ok(reg.status === 503 && Number(reg.retryAfter) > 0 && /not loaded yet/.test(reg.body?.error || ""),
    `a registration while the removal list is unread answers 503 with Retry-After (${reg.status} ${reg.retryAfter} ${JSON.stringify(reg.body)})`);
  let all503 = true;
  for (let i = 0; i < 6; i++) { const r = await post("/api/index/register", { origin: `https://seller-unloaded-${i}.example` }); if (r.status !== 503) { all503 = false; console.error(`attempt ${i}: ${r.status}`); } }
  ok(all503, "a refused registration gives back its slot: six more in a row still answer 503, not the hourly limit");
  const rs = await post("/__operator/sellers/restore", { origin: "https://seller-unloaded.example" }, OP);
  ok(rs.status === 503 && Number(rs.retryAfter) > 0 && /not loaded yet/.test(rs.body?.error || ""),
    `an operator restore while the removal list is unread answers 503 with Retry-After (${rs.status} ${rs.retryAfter} ${JSON.stringify(rs.body)})`);
  const bad = await post("/__operator/sellers/restore", { origin: "not an origin" }, OP);
  ok(bad.status === 400, `a malformed origin is still a 400 (${bad.status})`);
  relay.heal();
  ok(await until(async () => (await stateWord()) === "on", 90_000, 500), `every store lands once the database answers (status ${await stateWord()})`);
  const rs2 = await post("/__operator/sellers/restore", { origin: "https://seller-unloaded.example" }, OP);
  ok(rs2.status === 200 && rs2.body?.restored === false, `after the list is read, the restore answers 200 (${rs2.status} ${JSON.stringify(rs2.body)})`);
} finally {
  child.kill("SIGKILL");
  await relay.close();
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
if (fail) console.error(log.split("\n").filter((l) => /state-db|json-document|first load|index/.test(l)).slice(-30).join("\n"));
console.log(`\ntest-index-unloaded-503-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
