// A memoized public surface built while a state store has not loaded (the
// database was unreachable through the boot wait) says so in fields: partial,
// partialReason, partialNote. Once the stores land, the next build is the
// full answer without them. Boots the server behind a relay that refuses
// every connection until the test heals it.
// Requires STATE_DATABASE_URL (CI fails without it).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
import { startPgRelay } from "./lib/pg-relay.js";
import { getFreePort } from "./lib/free-port.js";
const { url, schema } = requireTestPg({ label: "test-surface-memo-partial-pg" });
const sdb = await import("../src/state-db.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 250) => { const t0 = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t0 > ms) return false; await sleep(step); } };

await sdb.stateDb(); // the schema exists; the server's own connections are what the relay refuses
const relay = await startPgRelay(url);
relay.cut();
const DIR = mkdtempSync(join(tmpdir(), "memo-partial-"));
const PORT = await getFreePort();
let log = "";
const child = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env, STATE_DATABASE_URL: relay.url, STATE_DB_SCHEMA: schema, FREE_MODE: "true", PORT: String(PORT),
    X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", REDIS_URL: "",
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

try {
  ok(await until(async () => (await getJson("/health")).status > 0, 90_000, 500), "the server listens after the boot wait with the database unreachable");
  const during = await getJson("/api/sales");
  ok(during.status === 200 && during.body?.partial === true && during.body?.partialReason === "state-loading" && typeof during.body?.partialNote === "string",
    `a memoized surface built while stores are unloaded carries partial fields (${JSON.stringify({ partial: during.body?.partial, reason: during.body?.partialReason })})`);
  relay.heal();
  ok(await until(async () => (await stateWord()) === "on", 90_000, 500), `every store lands once the database answers (status ${await stateWord()})`);
  let after = null;
  ok(await until(async () => { after = (await getJson("/api/sales")).body; return after && after.partial === undefined; }, 15_000, 500),
    `the next build after the stores land is the full answer, with no partial fields (${JSON.stringify({ partial: after?.partial })})`);
} finally {
  child.kill("SIGKILL");
  await relay.close();
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
if (fail) console.error(log.split("\n").filter((l) => /state-db|json-document|first load/.test(l)).slice(-30).join("\n"));
console.log(`\ntest-surface-memo-partial-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
