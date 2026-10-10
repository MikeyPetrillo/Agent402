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
const callTool = async (ms = 8000) => { try { const r = await fetch(`${base}/api/hash`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "resilience", algo: "sha256" }), signal: AbortSignal.timeout(ms) }); return r.status; } catch (e) { return `0:${String(e?.cause?.code || e?.name || e?.message || e).slice(0, 40)}`; } };
const stateWord = async () => { try { return JSON.parse((await get("/api/gateway-status")).body)?.stateDb?.status; } catch { return "?"; } };
const T = (t) => `${sdb.stateDbSchema()}.${t}`;
// The per-tool counter is exact and uncapped (the recent-calls ring keeps 200), so a dropped batch is visible.
const hashCount = async () => Number((await sdb.stateQuery(`SELECT coalesce(max(n), 0)::bigint AS n FROM ${T("stats_tool_counts")} WHERE slug = 'hash'`)).rows[0].n);

try {
  ok(await until(async () => (await get("/health", 2000)).status === 200, 120_000, 500), "the server boots in database mode behind the relay");
  // The boot waits for every store's first load before it listens.
  const storesAt = log.indexOf("[state-db] stores loaded in");
  const listenAt = log.indexOf("Agent402 listening on");
  ok(storesAt !== -1 && listenAt !== -1 && storesAt < listenAt, `the server listened only after its stores loaded (stores line at ${storesAt}, listen line at ${listenAt})`);
  ok(await until(async () => (await stateWord()) === "on", 20_000), "the status word reads on while the database answers");
  const callsBefore = await hashCount();
  ok(await callTool() === 200, "a deterministic tool answers 200");
  ok(await until(async () => (await hashCount()) === callsBefore + 1, 15_000), "the call's stats bump lands in Postgres");

  // ---- burst ------------------------------------------------------------------
  const t0 = Date.now();
  const statuses = await Promise.all(Array.from({ length: 150 }, () => callTool(20_000)));
  const burstMs = Date.now() - t0;
  const notOk = statuses.filter((s) => s !== 200);
  ok(notOk.length === 0, `150 concurrent calls all answer 200 (${burstMs} ms for the burst)${notOk.length ? `; ${notOk.length} did not: ${JSON.stringify([...new Set(notOk)].slice(0, 4))}` : ""}`);
  ok(await until(async () => (await hashCount()) === callsBefore + 151, 30_000), "the burst's 150 bumps land, exactly");

  // ---- outage -----------------------------------------------------------------
  const landedBeforeCut = await hashCount();
  cutRelay();
  const during = [];
  for (let i = 0; i < 5; i++) during.push(await callTool());
  ok(during.every((s) => s === 200), `with Postgres unreachable the tool still answers 200 (${during.join(",")})`);
  ok((await get("/health")).status === 200, "/health stays 200 during the outage");
  ok(await until(async () => (await stateWord()) === "degraded", 30_000), "the status word turns degraded once a query fails");
  ok(exited === null, "the process is still alive");
  // Hold the outage past the write queue's retry interval: the bumps made
  // during it must stay queued (the counter cannot move) and the flush must
  // have failed at least once, so a retry that drops its batch is caught.
  await sleep(7_000);
  ok((await hashCount()) === landedBeforeCut, "while cut, no bump reaches Postgres (the queue holds them)");
  ok(/write failed, kept for retry/.test(log), "the stats flush failed during the outage and kept its batch");

  // ---- recovery ---------------------------------------------------------------
  healRelay();
  ok(await until(async () => (await stateWord()) === "on", 60_000, 500), "the status word returns to on after the relay heals");
  ok(await callTool() === 200, "a call after recovery answers 200");
  ok(await until(async () => (await hashCount()) === landedBeforeCut + 6, 60_000), "the five outage calls and the recovery call all land, exactly (queued, retried)");

  // ---- cuts during transactions ---------------------------------------------
  // Under traffic the stats flush holds a transaction open most of the time,
  // so cutting the relay now drops connections that are checked out between
  // statements (pg emits "error" on them), not only idle ones.
  let flapping = true;
  const flapCalls = [];
  const traffic = Promise.all(Array.from({ length: 12 }, async () => { while (flapping) flapCalls.push(await callTool(10_000)); }));
  for (let i = 0; i < 10; i++) { await sleep(150); cutRelay(); await sleep(200); healRelay(); }
  flapping = false;
  await traffic;
  ok(exited === null, `ten relay cuts under traffic leave the process alive (${flapCalls.length} calls during the cuts)`);
  ok(!/\[uncaughtException\]/.test(log), "no uncaught exception from a connection dropped mid-transaction");
  ok(flapCalls.length > 0 && flapCalls.every((s) => s === 200), `every call during the cuts answers 200 (${[...new Set(flapCalls)].join(",")})`);
  ok(await until(async () => (await stateWord()) === "on", 60_000, 500), "the status word reads on again after the cuts");
  ok(await callTool() === 200, "a call after the cuts answers 200");

  // ---- drain ------------------------------------------------------------------
  // Loop leases only: a per-boot liveness row (name ":boot:") is not a loop
  // lease and expires on its own, which is how other containers learn it died.
  const liveLeases = async () => (await sdb.stateQuery(`SELECT name FROM ${T("leases")} WHERE expires_at > now() AND name NOT LIKE '%:boot:%'`)).rows.map((r) => r.name);
  const heldBefore = await liveLeases();
  const tKill = Date.now();
  child.kill("SIGTERM");
  ok(await until(async () => exited !== null, 30_000), `SIGTERM drains and exits (${exited ? Date.now() - tKill : "?"} ms)`);
  ok(exited && exited.code === 0, `exit code 0 (got ${exited?.code} ${exited?.signal || ""})`);
  const heldAfter = await liveLeases();
  if (!heldBefore.length) console.log("note - no loop lease was held at SIGTERM; the release is covered by test-state-db.js");
  ok(heldAfter.length === 0, `the drain releases every lease the process held (before: ${heldBefore.join(",") || "none"}; after: ${heldAfter.join(",") || "none"})`);
  ok(!/\[unhandledRejection\]|\[uncaughtException\]/.test(log), "no unhandled rejection or uncaught exception in the log");
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
