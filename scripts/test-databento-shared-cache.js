#!/usr/bin/env node
// Market data across replicas (src/tools/databento.js), proven on the caller
// path: real servers, a real Redis, a stub upstream behind
// scripts/lib/databento-stub-preload.js (which refuses to load without it).
//
//   node scripts/test-databento-shared-cache.js
//
// REDIS_URL names the Redis when set (CI); otherwise a redis-server on PATH
// (or /opt/homebrew/bin) is started on a free port and stopped afterwards.
// STATE_DATABASE_URL, when set, adds the warmer-lease half. Under CI a
// missing Redis or database fails the run.
//
//   a. every upstream read on the quote and history paths (range lookup,
//      get_cost, get_range) that stalls past its deadline, headers sent and
//      the body never finished, answers 503 with "nothing was charged - retry
//      shortly", never 500; a stalled price check alone still serves;
//   b. two servers on one Redis: what the first read upstream, the second
//      serves from the shared copy with ZERO upstream calls (boundary, price
//      check and bars), and says cached;
//   c. a Redis that does not answer is a miss within the deadline, and the
//      local path still serves;
//   d. (with a database) the warmer runs under a lease: per session one price
//      audit and one read per warmed symbol across both servers, and the
//      server that did not run them serves warm and audited with no upstream
//      call.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getFreePorts } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 100) => { const t0 = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t0 > ms) return false; await sleep(step); } };
const OP = "test-databento-shared-operator-token-0123456789";
const DIR = mkdtempSync(join(tmpdir(), "databento-shared-"));
const procs = [];
let redisProc = null, stub = null;
const openSockets = new Set();

// ---- Redis
let REDIS_URL = String(process.env.REDIS_URL || "").trim();
if (!REDIS_URL) {
  const bin = [spawnSync("which", ["redis-server"]).stdout?.toString().trim(), "/opt/homebrew/bin/redis-server", "/usr/local/bin/redis-server"].find((p) => p && existsSync(p));
  if (!bin) {
    const msg = "test-databento-shared-cache: no REDIS_URL and no redis-server on this machine";
    if (process.env.CI) { console.error(`FAIL - ${msg} (a missing dependency is a failure under CI)`); process.exit(1); }
    console.log(`SKIP - ${msg}`); process.exit(0);
  }
  const [rp] = await getFreePorts(1);
  redisProc = spawn(bin, ["--port", String(rp), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  REDIS_URL = `redis://127.0.0.1:${rp}`;
}
const { createClient } = await import("redis");
const redis = createClient({ url: REDIS_URL });
redis.on("error", () => {});
await until(async () => { try { await redis.connect(); return true; } catch { return false; } }, 10_000, 200);
const PREFIX = `databento-test-${randomBytes(4).toString("hex")}:`;

// ---- stub upstream: counts every call by kind, symbol and session end
const up = { end: "2026-10-09", calls: [], stall: { range: false, cost: new Set(), data: new Set() } };
const count = (pred) => up.calls.filter(pred).length;
const bar = (day, close) => JSON.stringify({ hd: { ts_event: String(Date.parse(day) * 1e6) }, open: "1e11", high: "2e11", low: "5e10", close, volume: "100" });
stub = createServer((req, res) => {
  openSockets.add(req.socket); req.socket.on("close", () => openSockets.delete(req.socket));
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const url = String(req.url || "");
    const p = new URLSearchParams(url.includes("?") ? url.split("?")[1] : b);
    const kind = url.includes("get_dataset_range") ? "range" : url.includes("get_cost") ? "cost" : url.includes("get_range") ? "data" : "other";
    const symbol = p.get("symbols"), end = p.get("end");
    up.calls.push({ kind, symbol, end, dataset: p.get("dataset") });
    // A stall: headers and the first bytes go out, the body never finishes.
    const stalled = (kind === "range" && up.stall.range) || (kind !== "range" && up.stall[kind]?.has(symbol));
    res.writeHead(200, { "Content-Type": "application/json" });
    if (stalled) { res.write(kind === "range" ? '{"end":' : kind === "cost" ? "0." : bar(up.end, "1.5e11").slice(0, 20)); return; }
    if (kind === "range") return res.end(JSON.stringify({ end: up.end }));
    if (kind === "cost") return res.end("0.00001");
    if (kind === "data") return res.end(bar("2026-10-08", "1.4e11") + "\n" + bar(end, "1.5e11") + "\n");
    res.end("{}");
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const STUB_URL = `http://127.0.0.1:${stub.address().port}`;

function boot(tag, extra = {}) {
  mkdirSync(join(DIR, tag), { recursive: true });
  let log = "";
  const port = extra.PORT;
  const child = spawn(process.execPath, ["--import", "./scripts/lib/databento-stub-preload.js", "src/server.js"], {
    env: {
      ...process.env, FREE_MODE: "true", RAILWAY_REPLICA_ID: tag,
      X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", POSTHOG_API_KEY: "",
      DATABENTO_API_KEY: "db-test-key-not-real", DATABENTO_STUB_URL: STUB_URL, DATABENTO_SHARED_PREFIX: PREFIX, REDIS_URL,
      DATABENTO_RANGE_TIMEOUT_MS: "800", DATABENTO_COST_TIMEOUT_MS: "800", DATABENTO_DATA_TIMEOUT_MS: "1200",
      AGENT402_OPERATOR_TOKEN: OP, AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999",
      STATS_DB_DIR: join(DIR, tag), MEMORY_DB_FILE: join(DIR, `${tag}-agent402.db`), POW_DB_PATH: join(DIR, `pow-${tag}.db`), STATUS_DB_PATH: join(DIR, `${tag}-status.db`),
      X402_ECONOMY_DB: join(DIR, `${tag}-economy.db`), SALES_LEDGER_DB: join(DIR, `${tag}-sales.db`), REFUND_DB_DIR: join(DIR, tag), DECIDE_LEDGER_DB: join(DIR, `${tag}-decide.db`),
      REVENUE_LEDGER_DB: join(DIR, `${tag}-revenue.db`), TRAFFIC_DIR: join(DIR, `${tag}-traffic`), WISH_FILE: join(DIR, `${tag}-wishes.jsonl`), OUTBOUND_LEDGER_FILE: join(DIR, `${tag}-outbound.ndjson`),
      HANGUP_FORGIVE_FILE: join(DIR, `${tag}-hangup.json`), WALLET_DAILY_LEDGER_FILE: join(DIR, `${tag}-spend.json`), EMAIL_STATUS_FILE: join(DIR, `${tag}-email.json`), MPP_RECONCILE_FILE: join(DIR, `${tag}-reconcile.json`),
      ...extra, PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const o = { child, port, tag, get log() { return log; } };
  child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  procs.push(o);
  return o;
}
const call = async (srv, path, ms = 10_000) => {
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}${path}`, { headers: { "x-forwarded-for": `10.9.${procs.indexOf(srv)}.${1 + Math.floor(Math.random() * 250)}` }, signal: AbortSignal.timeout(ms) });
    const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body, text };
  } catch (e) { return { status: 0, body: null, text: String(e?.message || e) }; }
};
const perf = (srv) => fetch(`http://127.0.0.1:${srv.port}/__operator/perf.json?top=1`, { headers: { Authorization: `Bearer ${OP}` }, signal: AbortSignal.timeout(5000) }).then((r) => r.json()).then((j) => j.stockQuoteWarmer).catch(() => null);
const healthy = (srv) => until(async () => (await call(srv, "/health", 2000)).status === 200, 120_000, 500);
const errText = (r) => r.body?.error || r.body?.message || r.body?.detail || r.text;
const NOT_CHARGED = /nothing was charged - retry shortly/;
const kill = (srv) => { try { srv.child.kill("SIGKILL"); } catch { /* gone */ } };

try {
  const [PA, PB] = await getFreePorts(2);
  // Warmer off for a and b: every upstream call is a request's own.
  const A = boot("a", { PORT: PA, DATABENTO_WARM: "off" });
  const B = boot("b", { PORT: PB, DATABENTO_WARM: "off" });
  ok(await healthy(A) && await healthy(B), "two servers boot on one Redis with the market-data stub");

  // ---- a. every stalled read is a 503, never a 500
  up.stall.range = true;
  let r = await call(A, "/api/stock-quote?symbol=RNG");
  ok(r.status === 503 && /dataset range read/.test(errText(r)) && NOT_CHARGED.test(errText(r)), `a. a stalled range lookup body is a 503 naming the step (${r.status}: ${errText(r)?.slice(0, 140)})`);
  r = await call(A, "/api/stock-history?symbol=RNG&days=5");
  ok(r.status === 503 && NOT_CHARGED.test(errText(r)), `a. ...on the history path too (${r.status})`);
  up.stall.range = false;

  up.stall.data.add("STALLD");
  r = await call(A, "/api/stock-quote?symbol=STALLD");
  ok(r.status === 503 && /get range read/.test(errText(r)) && NOT_CHARGED.test(errText(r)), `a. a stalled get_range body on a quote is a 503 naming the step, not a 500 (${r.status}: ${errText(r)?.slice(0, 140)})`);
  r = await call(A, "/api/stock-history?symbol=STALLD&days=30");
  ok(r.status === 503 && /get range read/.test(errText(r)) && NOT_CHARGED.test(errText(r)), `a. ...and on a history read (${r.status})`);

  up.stall.cost.add("COSTSLOW");
  r = await call(A, "/api/stock-history?symbol=COSTSLOW&days=30");
  ok(r.status === 200 && Array.isArray(r.body?.bars), `a. a stalled get_cost body alone is the spend guard unavailable: the read still serves (${r.status})`);
  up.stall.cost.add("BOTHSLOW"); up.stall.data.add("BOTHSLOW");
  r = await call(A, "/api/stock-history?symbol=BOTHSLOW&days=30");
  ok(r.status === 503 && NOT_CHARGED.test(errText(r)), `a. a stalled get_cost then a stalled get_range is a 503 (${r.status})`);
  r = await call(A, "/api/stock-quote?symbol=BOTHSLOW");
  ok(r.status === 503 && NOT_CHARGED.test(errText(r)), `a. ...on a quote too, which is priced inline before any audit (${r.status})`);
  ok(!/status=500/.test(A.log) && !/aborted due to timeout"/.test(A.log), "a. no 500 in the server's log for any of them");

  // ---- b. one server reads, the other serves from the shared copy
  const n0 = up.calls.length;
  const first = await call(A, "/api/stock-quote?symbol=MSFT");
  ok(first.status === 200 && first.body?.cached === false && first.body?.price === 150, `b. A reads MSFT upstream (cached ${first.body?.cached})`);
  ok(count((c, i) => i >= n0 && c.kind === "data" && c.symbol === "MSFT") === 1, "b. ...with one data read");
  ok(await until(async () => (await redis.exists(`${PREFIX}bars:EQUS.SUMMARY|MSFT|ohlcv-1d|2026-09-29|2026-10-09`)) === 1, 3000), "b. A wrote the bars to the shared copy under the dataset|symbol|schema|start|end key");
  const ttl = await redis.ttl(`${PREFIX}bars:EQUS.SUMMARY|MSFT|ohlcv-1d|2026-09-29|2026-10-09`);
  ok(ttl > 24 * 3600 && ttl <= 36 * 3600, `b. its TTL outlives a session (${ttl} s)`);
  const n1 = up.calls.length;
  const second = await call(B, "/api/stock-quote?symbol=MSFT");
  ok(second.status === 200 && second.body?.cached === true && second.body?.fetchedAt === first.body?.fetchedAt && second.body?.price === first.body?.price && second.body?.asOf === first.body?.asOf,
    `b. B answers MSFT from the shared copy: cached, same fetchedAt and price (${second.body?.cached}, ${second.body?.fetchedAt})`);
  ok(up.calls.length === n1, `b. B made ZERO upstream calls for it: boundary, price check and bars all shared (${up.calls.length - n1} calls: ${JSON.stringify(up.calls.slice(n1))})`);
  const third = await call(B, "/api/stock-quote?symbol=MSFT");
  ok(third.body?.cached === true && up.calls.length === n1, "b. B's repeat answers from its own memory");
  const sb = await perf(B);
  ok(sb?.shared?.hits >= 2, `b. B's operator counts show the shared hits (${JSON.stringify(sb?.shared)})`);

  // History on B for a range A read: shared too.
  const h1 = await call(A, "/api/stock-history?symbol=IBM&days=30");
  ok(h1.status === 200, "b. A reads IBM history upstream");
  await sleep(300);
  const n2 = up.calls.length;
  const h2 = await call(B, "/api/stock-history?symbol=IBM&days=30");
  ok(h2.status === 200 && JSON.stringify(h2.body?.bars) === JSON.stringify(h1.body?.bars) && up.calls.length === n2, `b. B serves the same history bars with zero upstream calls (${up.calls.length - n2})`);

  // ---- c. a Redis that does not answer is a miss within the deadline
  // A poisoned shared entry (not bars) is ignored, read upstream, overwritten.
  await redis.set(`${PREFIX}bars:EQUS.SUMMARY|ORCL|ohlcv-1d|2026-09-29|2026-10-09`, JSON.stringify({ bars: [{ day: "x" }], fetchedAt: 1 }), { EX: 600 });
  const n3 = up.calls.length;
  const orcl = await call(B, "/api/stock-quote?symbol=ORCL");
  ok(orcl.status === 200 && orcl.body?.price === 150 && count((c, i) => i >= n3 && c.kind === "data" && c.symbol === "ORCL") === 1, "c. a malformed shared entry is a miss: read upstream, served correctly");
  if (redisProc) {
    redisProc.kill("SIGSTOP"); // alive, accepts nothing: every command hangs
    const t0 = Date.now();
    const cold = await call(A, "/api/stock-quote?symbol=NVDA");
    const ms = Date.now() - t0;
    redisProc.kill("SIGCONT");
    ok(cold.status === 200 && cold.body?.cached === false, `c. with Redis not answering, a cold quote still serves from upstream (${cold.status})`);
    ok(ms < 3000, `c. ...bounded by the command deadline, not a hang (${ms} ms)`);
  } else console.log("# c. Redis-stall half needs a Redis this test started (REDIS_URL was given); skipped");

  kill(A); kill(B);

  // ---- d. the warmer under a lease (needs a database)
  const pgUrl = String(process.env.STATE_DATABASE_URL || "").trim();
  if (!pgUrl) {
    const msg = "d. no STATE_DATABASE_URL: the warmer-lease half did not run";
    if (process.env.CI) { ok(false, `${msg} (a missing database is a failure under CI)`); }
    else console.log(`SKIP - ${msg}`);
  } else {
    const schema = `t_${randomBytes(5).toString("hex")}`;
    process.env.STATE_DB_SCHEMA = schema;
    const sdb = await import("../src/state-db.js");
    const P2 = `${PREFIX}d:`;
    const [PC, PD] = await getFreePorts(2);
    const dEnv = (port) => ({ PORT: port, STATE_DATABASE_URL: pgUrl, STATE_DB_SCHEMA: schema, DATABENTO_SHARED_PREFIX: P2,
      DATABENTO_RANGE_REFRESH_MS: "1500", DATABENTO_WARM_RETRY_MS: "300", DATABENTO_WARM_TOP_N: "5" });
    up.end = "2026-10-12";
    const d0 = up.calls.length;
    const C = boot("c", dEnv(PC));
    const D = boot("d", dEnv(PD));
    try {
      ok(await healthy(C) && await healthy(D), "d. two servers boot on one state schema and one Redis, warmer on");
      ok(await until(async () => (await perf(C))?.range?.end === "2026-10-12" && (await perf(D))?.range?.end === "2026-10-12", 30_000, 250), "d. both hold the session boundary after their boot ticks");
      const audits1 = count((c, i) => i >= d0 && c.kind === "cost" && c.symbol === "AAPL" && c.end === "2026-10-12");
      ok(audits1 === 1, `d. one price audit for the session across both servers (${audits1})`);
      // Demand: X on C, Y on D. A quote on the server that did not audit is
      // not priced inline: it adopted the shared audit.
      const q0 = up.calls.length;
      const x = await call(C, "/api/stock-quote?symbol=XOM");
      const y = await call(D, "/api/stock-quote?symbol=CVX");
      // KO is demanded on both, so both warmers want it for the next session.
      const ko1 = await call(C, "/api/stock-quote?symbol=KO");
      await sleep(200); // the write-behind lands
      const ko2 = await call(D, "/api/stock-quote?symbol=KO");
      ok(x.status === 200 && y.status === 200 && ko1.status === 200 && ko2.status === 200 && ko2.body?.cached === true, `d. a quote on each server serves, and KO read on C is shared with D (${ko2.body?.cached})`);
      ok(count((c, i) => i >= q0 && c.kind === "cost") === 0, `d. neither quote was priced inline: both servers hold the session's audit (${count((c, i) => i >= q0 && c.kind === "cost")} cost reads)`);
      // A new session lands.
      const e0 = up.calls.length;
      up.end = "2026-10-13";
      const k = (s) => count((c, i) => i >= e0 && c.kind === "data" && c.symbol === s && c.end === "2026-10-13");
      ok(await until(async () => k("XOM") >= 1 && k("CVX") >= 1 && k("KO") >= 1 && (await perf(C))?.range?.end === "2026-10-13" && (await perf(D))?.range?.end === "2026-10-13", 30_000, 250), "d. the warmers pick up the new session and pre-read both servers' symbols");
      await sleep(4000); // more ticks on both: nothing may be read twice
      ok(k("XOM") === 1 && k("CVX") === 1 && k("KO") === 1, `d. each symbol is read once for the session across both servers, KO included though both warmers want it (XOM ${k("XOM")}, CVX ${k("CVX")}, KO ${k("KO")})`);
      const audits2 = count((c, i) => i >= e0 && c.kind === "cost" && c.symbol === "AAPL" && c.end === "2026-10-13");
      ok(audits2 === 1, `d. one price audit for the new session across both servers (${audits2})`);
      const ranges = count((c, i) => i >= e0 && c.kind === "range");
      const sc = await perf(C), sd = await perf(D);
      ok(sc.shared.hits > 0 && sd.shared.hits > 0 && (sc.adoptedFromShared + sd.adoptedFromShared) >= 1, `d. ticks adopted the boundary, the audit and KO's pre-read from the shared copy instead of reading upstream (hits ${sc.shared.hits}+${sd.shared.hits}, adopted ${sc.adoptedFromShared}+${sd.adoptedFromShared}, lease skips ${sc.leaseSkips}+${sd.leaseSkips}, range reads ${ranges})`);
      const w0 = up.calls.length;
      const xd = await call(D, "/api/stock-quote?symbol=XOM");
      const yc = await call(C, "/api/stock-quote?symbol=CVX");
      ok(xd.body?.cached === true && yc.body?.cached === true && xd.body?.asOf === "2026-10-13" && yc.body?.asOf === "2026-10-13", `d. each server serves the other's symbol warm for the new session (${xd.body?.cached}, ${yc.body?.cached})`);
      ok(up.calls.length === w0, `d. ...with zero upstream calls (${up.calls.length - w0})`);
      // The lease gates the tick: while a third container holds it, neither
      // server's warmer calls the upstream, even across a new session.
      const third = "third-container";
      ok(await until(async () => await sdb.leases.acquire("databento-quote-warmer", { owner: third, ttlMs: 60_000 }), 10_000, 50), "d. a third container takes the warmer's lease");
      const l0 = up.calls.length;
      up.end = "2026-10-14";
      await sleep(4500); // three refresh intervals on each server
      ok(up.calls.length === l0, `d. while another holder has the lease, no tick on either server reads upstream (${up.calls.length - l0} calls)`);
      await sdb.leases.release("databento-quote-warmer", { owner: third });
      ok(await until(async () => (await perf(C))?.range?.end === "2026-10-14" && (await perf(D))?.range?.end === "2026-10-14", 15_000, 250), "d. once released, the warmers move to the new session");
      const ranges3 = count((c, i) => i >= l0 && c.kind === "range");
      ok(ranges3 >= 1 && count((c, i) => i >= l0 && c.kind === "cost" && c.end === "2026-10-14") === 1, `d. ...with one audit for it across both (range reads ${ranges3})`);
    } finally {
      kill(C); kill(D);
      await sleep(300);
      await sdb.__dropStateSchema().catch(() => {});
      await sdb.closeStateDb();
    }
  }
  const logs = procs.map((p) => p.log).join("\n");
  ok(!/\[unhandledRejection\]|\[uncaughtException\]/.test(logs), "no unhandled rejection in any server log");
  if (fail) for (const p of procs) { console.error(`---- ${p.tag} log tail ----`); console.error(p.log.split("\n").filter((l) => /databento|lease|Error|error/.test(l)).slice(-25).join("\n")); }
} catch (e) {
  ok(false, e?.stack || String(e));
} finally {
  for (const p of procs) kill(p);
  for (const s of openSockets) s.destroy();
  stub?.close();
  try { for await (const k of redis.scanIterator({ MATCH: `${PREFIX}*` })) { for (const key of [].concat(k)) await redis.del(key); } } catch { /* best effort */ }
  try { await redis.quit(); } catch { /* gone */ }
  if (redisProc) { redisProc.kill("SIGCONT"); redisProc.kill("SIGTERM"); }
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
