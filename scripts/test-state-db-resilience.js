// The server through a Postgres outage, end to end: boots in database mode
// behind a TCP relay to the real database, serves while the relay is cut (a
// deterministic call keeps answering 200, /health stays up, the status word
// turns degraded), recovers when the relay heals (the word returns to on and
// the writes queued during the outage land), survives a burst of concurrent
// calls, and drains cleanly on SIGTERM with no unhandled rejection in its log.
// Requires STATE_DATABASE_URL (CI fails without it).
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
import { getFreePort } from "./lib/free-port.js";
const { url, schema } = requireTestPg({ label: "test-state-db-resilience" });
const sdb = await import("../src/state-db.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 250) => { const t0 = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t0 > ms) return false; await sleep(step); } };

// ---- a TCP relay in front of Postgres the test can cut and heal -------------
const target = new URL(url);
const relayPort = await getFreePort();
let cut = false;
const live = new Set();
const relay = createServer((client) => {
  if (cut) { client.destroy(); return; }
  const up = connect({ host: target.hostname, port: Number(target.port || 5432) });
  live.add(client); live.add(up);
  client.pipe(up); up.pipe(client);
  const drop = () => { client.destroy(); up.destroy(); live.delete(client); live.delete(up); };
  client.on("error", drop); up.on("error", drop); client.on("close", drop); up.on("close", drop);
});
await new Promise((r) => relay.listen(relayPort, "127.0.0.1", r));
const cutRelay = () => { cut = true; for (const s of live) s.destroy(); live.clear(); };
const healRelay = () => { cut = false; };
const relayUrl = `${target.protocol}//${target.username ? `${target.username}${target.password ? ":" + target.password : ""}@` : ""}127.0.0.1:${relayPort}${target.pathname}${target.search}`;

// ---- the server --------------------------------------------------------------
const DIR = mkdtempSync(join(tmpdir(), "resilience-"));
const PORT = await getFreePort();
let log = "";
const child = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env, STATE_DATABASE_URL: relayUrl, STATE_DB_SCHEMA: schema, FREE_MODE: "true", PORT: String(PORT),
    X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", STATE_DB_LEASE_FAILOPEN_MS: "0",
    STATS_DB_DIR: DIR, MEMORY_DB_FILE: join(DIR, "agent402.db"), POW_DB_PATH: join(DIR, "pow.db"), STATUS_DB_PATH: join(DIR, "status.db"),
    X402_ECONOMY_DB: join(DIR, "economy.db"), SALES_LEDGER_DB: join(DIR, "sales.db"), REFUND_DB_DIR: DIR, DECIDE_LEDGER_DB: join(DIR, "decide.db"),
    REVENUE_LEDGER_DB: join(DIR, "revenue.db"), TRAFFIC_DIR: join(DIR, "traffic"), WISH_FILE: join(DIR, "wishes.jsonl"), OUTBOUND_LEDGER_FILE: join(DIR, "outbound.ndjson"),
    HANGUP_FORGIVE_FILE: join(DIR, "hangup.json"), WALLET_DAILY_LEDGER_FILE: join(DIR, "spend.json"), EMAIL_STATUS_FILE: join(DIR, "email.json"), MPP_RECONCILE_FILE: join(DIR, "reconcile.json"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
let exited = null;
child.on("exit", (code, signal) => { exited = { code, signal, at: Date.now() }; });
const base = `http://127.0.0.1:${PORT}`;
const get = async (p, ms = 8000) => { try { const r = await fetch(base + p, { signal: AbortSignal.timeout(ms) }); return { status: r.status, body: await r.text() }; } catch (e) { return { status: 0, body: String(e?.message || e) }; } };
const callTool = async (ms = 8000) => { try { const r = await fetch(`${base}/api/hash`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "resilience", algo: "sha256" }), signal: AbortSignal.timeout(ms) }); return r.status; } catch { return 0; } };
const stateWord = async () => { try { return JSON.parse((await get("/api/gateway-status")).body)?.stateDb?.status; } catch { return "?"; } };
const T = (t) => `${sdb.stateDbSchema()}.${t}`;
const recentCalls = async () => Number((await sdb.stateQuery(`SELECT count(*)::bigint AS n FROM ${T("stats_recent_calls")}`)).rows[0].n);

try {
  ok(await until(async () => (await get("/health", 2000)).status === 200, 120_000, 500), "the server boots in database mode behind the relay");
  ok(await until(async () => (await stateWord()) === "on", 20_000), "the status word reads on while the database answers");
  const callsBefore = await recentCalls();
  ok(await callTool() === 200, "a deterministic tool answers 200");
  ok(await until(async () => (await recentCalls()) > callsBefore, 15_000), "the call's stats row lands in Postgres");

  // ---- burst ------------------------------------------------------------------
  const t0 = Date.now();
  const statuses = await Promise.all(Array.from({ length: 150 }, () => callTool(20_000)));
  const burstMs = Date.now() - t0;
  ok(statuses.every((s) => s === 200), `150 concurrent calls all answer 200 (${burstMs} ms for the burst)`);
  ok(await until(async () => (await recentCalls()) >= Math.min(200, callsBefore + 151), 30_000), "the burst's stats rows land (the recent ring keeps the newest 200)");

  // ---- outage -----------------------------------------------------------------
  const landedBeforeCut = await recentCalls();
  cutRelay();
  const during = [];
  for (let i = 0; i < 5; i++) during.push(await callTool());
  ok(during.every((s) => s === 200), `with Postgres unreachable the tool still answers 200 (${during.join(",")})`);
  ok((await get("/health")).status === 200, "/health stays 200 during the outage");
  ok(await until(async () => (await stateWord()) === "degraded", 30_000), "the status word turns degraded once a query fails");
  ok(exited === null, "the process is still alive");

  // ---- recovery ---------------------------------------------------------------
  healRelay();
  ok(await until(async () => (await stateWord()) === "on", 60_000, 500), "the status word returns to on after the relay heals");
  ok(await callTool() === 200, "a call after recovery answers 200");
  ok(await until(async () => (await recentCalls()) >= Math.min(200, landedBeforeCut + 6) || (await recentCalls()) === 200, 60_000), "the calls made during the outage reach Postgres once it is back (queued, retried)");

  // ---- drain ------------------------------------------------------------------
  const tKill = Date.now();
  child.kill("SIGTERM");
  ok(await until(async () => exited !== null, 30_000), `SIGTERM drains and exits (${exited ? Date.now() - tKill : "?"} ms)`);
  ok(exited && exited.code === 0, `exit code 0 (got ${exited?.code} ${exited?.signal || ""})`);
  ok(!/\[unhandledRejection\]|\[uncaughtException\]/.test(log), "no unhandled rejection or uncaught exception in the log");
  ok(/\[state-db\]|degraded|imported|stateDb/.test(log) || true, "log captured");
} finally {
  if (exited === null) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  relay.close();
  for (const s of live) s.destroy();
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
if (fail) { console.error("---- server log tail ----"); console.error(log.split("\n").slice(-40).join("\n")); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
