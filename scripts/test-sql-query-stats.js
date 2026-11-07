#!/usr/bin/env node
// onchain-sql query-count histogram (src/sql-query-stats.js), offline.
//
// Proves the caller path: a local express app with the real request-scope
// middleware (src/request-timing.js) in front of the real onchain-sql handler
// (query service stubbed), and a settlement stand-in that, like the x402
// middleware, turns the handler's 200 into a 402 after the handler ran. A
// call is counted by the queries it used only on a FINAL 200; a budget
// refusal is counted when its 422 finished; a settle failure and a call
// outside a request count nothing. The counts land in the state document
// (file backend here), survive a fresh module state, never hold SQL text, and
// days past the keep window are pruned.
//
//   node scripts/test-sql-query-stats.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

const dir = mkdtempSync(join(tmpdir(), "a402-sql-stats-"));
const STATS_FILE = join(dir, "onchain-sql-query-stats.json");
process.env.SQL_QUERY_STATS_FILE = STATS_FILE;
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.CDP_API_KEY_ID = "organizations/test/apiKeys/test";
process.env.CDP_API_KEY_SECRET = privateKey.export({ type: "pkcs8", format: "pem" });

const { CDP_TOOLS, SQL_QUERY_BUDGET, QUERY_HEALTH_SQL, _setQueryHealthForTest } = await import("../src/tools/cdp-kit.js");
const { requestTimingMiddleware, currentRequestScope } = await import("../src/request-timing.js");
const stats = await import("../src/sql-query-stats.js");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

// --- the bucket rule, pure ----------------------------------------------------
ok(stats.bucketOf({ status: 200, queries: 1 }) === "q1" && stats.bucketOf({ status: 200, queries: 3 }) === "q3", "a final 200 is bucketed by the queries it used");
ok(stats.bucketOf({ status: 402, queries: 1 }) === null && stats.bucketOf({ status: 499, queries: 2 }) === null, "a 402 (settle failed) or a hang-up is not counted");
ok(stats.bucketOf({ status: 422, queries: 3, budgetSpent: true }) === "budgetSpent", "a budget refusal is counted as one");
ok(stats.bucketOf({ status: 200, queries: 0 }) === null && stats.bucketOf({ status: 200, queries: 4 }) === null, "a count outside 1..3 is not bucketed");
ok(SQL_QUERY_BUDGET === 3, "the histogram's buckets cover the call budget");

// --- the query service, stubbed -------------------------------------------------
const realFetch = globalThis.fetch;
const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const isHealth = (sql) => Object.values(QUERY_HEALTH_SQL).includes(sql);
const isMeasure = (q) => /countIf\(length\(toString\(tuple\(\*\)\)\)/.test(String(q || ""));
let answer = null, sent = 0;
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).includes("api.cdp.coinbase.com")) return realFetch(url, init);
  const q = JSON.parse(init.body || "{}").sql;
  if (isHealth(q)) return J(200, { result: [{ block_number: 1 }] });
  sent++;
  return answer(q, sent);
};
_setQueryHealthForTest(true);
const fitRows = Array.from({ length: 18 }, (_, i) => ({ ix: i, sk: "a" }));
const ONE = () => J(200, { result: [{ n: 1 }] });
const ROW_SIZE = (q, n) => (n === 1 ? J(500, {}) : isMeasure(q) ? J(200, { result: [{ n: 22, big: 4, maxRow: 65972 }] }) : J(200, { result: fitRows }));
const WORST = (q) => (isMeasure(q) ? J(200, { result: [{ n: 50, big: 3, maxRow: 70000 }] }) : J(500, { errorMessage: "An internal server error occurred." }));

// --- the caller path: request scope, handler, settlement stand-in ---------------
const tool = CDP_TOOLS.find((t) => t.slug === "onchain-sql");
const app = express();
app.use(requestTimingMiddleware((req) => req.path));
app.use(express.json());
app.use((req, res, next) => {
  if (req.headers["x-synthetic"] === "1") { const s = currentRequestScope(); if (s) s.synthetic = true; }
  // Like @x402/express: the handler's answer is held, then settled; a failed
  // settle discards it and answers 402.
  const orig = res.json.bind(res);
  res.json = (body) => (res.statusCode < 400 && req.headers["x-settle"] === "fail" ? orig.call(res.status(402), { error: "settlement failed" }) : orig(body));
  next();
});
app.post("/api/onchain-sql", async (req, res) => {
  try { res.json(await tool.handler(req.body)); }
  catch (e) { res.status(e.statusCode || 502).json({ error: e.message }); }
});
const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (sql, fn, headers = {}) => {
  answer = fn; sent = 0;
  const r = await realFetch(`${base}/api/onchain-sql`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ sql }) });
  await r.text();
  await new Promise((res) => setTimeout(res, 20)); // the finish hook runs after the body is sent
  return { status: r.status, sent };
};

try {
  const a = await call("SELECT 1 AS n FROM base.blocks", ONE);
  ok(a.status === 200 && a.sent === 1, `a one-query call answers 200 (${a.status}, ${a.sent} sent)`);
  const b = await call("SELECT ix, sk FROM base.blocks", ROW_SIZE);
  ok(b.status === 200 && b.sent === 3, `the row-size recovery answers 200 on three queries (${b.status}, ${b.sent})`);
  const c = await call("SELECT 1 AS n FROM base.blocks", ONE, { "x-settle": "fail" });
  ok(c.status === 402 && c.sent === 1, `a handler 200 whose settlement fails is a final 402 (${c.status})`);
  const d = await call("SELECT i FROM base.blocks", WORST);
  ok(d.status === 422 && d.sent === SQL_QUERY_BUDGET, `the worst path is the budget refusal (${d.status}, ${d.sent})`);
  const e = await call("SELECT 1 AS n FROM base.blocks", ONE, { "x-synthetic": "1" });
  ok(e.status === 200, "a synthetic call answers 200");
  // A call outside any request (the economy panel's refresh) is not counted.
  answer = ONE; sent = 0;
  await tool.handler({ sql: "SELECT 1 AS n FROM base.blocks" });

  let rep = await stats.sqlQueryStatsReport();
  const t = rep.totals;
  ok(t.outside.q1 === 1 && t.outside.q3 === 1 && t.outside.q2 === 0 && t.outside.budgetSpent === 1, `outside lane: one 1-query call, one 3-query call, one budget refusal; the settle failure and the out-of-request call add nothing (${JSON.stringify(t.outside)})`);
  ok(t.synthetic.q1 === 1 && t.synthetic.q3 === 0, `synthetic lane counted apart (${JSON.stringify(t.synthetic)})`);
  ok(rep.days.length === 1 && rep.days[0].day === new Date().toISOString().slice(0, 10), "counts sit under today's UTC day");

  // Stored, then read back by a fresh module state (a deploy).
  const f = await stats.flushSqlQueryStats();
  ok(f.ok && f.flushed && existsSync(STATS_FILE), "a flush writes the state document");
  const raw = readFileSync(STATS_FILE, "utf8");
  ok(!/base\.blocks|SELECT|organizations|0x/i.test(raw), "the stored document holds counts only (no SQL, no key, no address)");
  stats._resetSqlQueryStats();
  rep = await stats.sqlQueryStatsReport();
  ok(rep.totals.outside.q1 === 1 && rep.totals.outside.q3 === 1 && rep.totals.outside.budgetSpent === 1 && rep.scope === "stored", "the counts survive a fresh process state");

  // Increments from two writers add up (read-modify-write, never a whole-body replace).
  stats.noteSqlCall({ status: 200, queries: 2 });
  await stats.flushSqlQueryStats();
  stats.noteSqlCall({ status: 200, queries: 2 });
  rep = await stats.sqlQueryStatsReport();
  ok(rep.totals.outside.q2 === 2 && rep.totals.outside.q1 === 1, `stored and unflushed counts merge on read (q2 ${rep.totals.outside.q2})`);
  await stats.flushSqlQueryStats();

  // Days past the keep window are pruned on the next write.
  const old = Date.now() - (stats.SQL_STATS_KEEP_DAYS + 5) * 86_400_000;
  stats.noteSqlCall({ status: 200, queries: 1, now: old });
  await stats.flushSqlQueryStats();
  const body = JSON.parse(readFileSync(STATS_FILE, "utf8"));
  const days = Object.keys((body.body ?? body).days || {});
  ok(days.length === 1 && !days.includes(new Date(old).toISOString().slice(0, 10)), `a day past the keep window is pruned (${days.join(", ")})`);
} finally {
  server.close();
  globalThis.fetch = realFetch;
  stats._resetSqlQueryStats();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
