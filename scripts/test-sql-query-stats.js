#!/usr/bin/env node
// onchain-sql query-count histogram (src/sql-query-stats.js), offline.
//
// Proves the caller path: a local express app with the real request-scope
// middleware (src/request-timing.js) in front of the real onchain-sql handler
// (query service stubbed), and a settlement stand-in that, like the x402
// middleware, turns the handler's 200 into a 402 after the handler ran. A
// call is counted by the queries it sent (0 to the call budget) and by how
// its response ENDED: charged (a final 200 the stand-in settled), free (a
// final 200 nothing was asked for), uncharged (a 4xx, a settle failure's 402,
// a buyer who left). A call outside a request counts nothing. The counts land
// in the state document (file backend here), survive a fresh module state,
// never hold SQL text, read a day stored before the outcome split, and a day
// past the keep window is dropped. A store that throws changes no answer.
// The booted server's own wiring (a real paywall, a stub facilitator, the
// operator route) is scripts/test-onchain-sql-queries-route.js.
//
//   node scripts/test-sql-query-stats.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

// --- the outcome and bucket rules, pure ----------------------------------------
ok(stats.outcomeOf({ status: 200, sale: "charged" }) === "charged" && stats.outcomeOf({ status: 200, sale: "free" }) === "free", "a final 200 is charged or free by what the server read from it");
ok(stats.outcomeOf({ status: 402, sale: "charged" }) === "uncharged" && stats.outcomeOf({ status: 499, sale: "charged" }) === "uncharged" && stats.outcomeOf({ status: 422 }) === "uncharged" && stats.outcomeOf({ status: 502, sale: "free" }) === "uncharged", "a 402 (settle failed), a hang-up, a 422 and a 502 are uncharged whatever else is claimed");
ok(stats.outcomeOf({ status: 200 }) === "uncharged" && stats.outcomeOf({ status: 200, sale: "none" }) === "uncharged", "a 200 with no settle evidence is not read as charged");
ok(stats.bucketOf(0) === "q0" && stats.bucketOf(1) === "q1" && stats.bucketOf(3) === "q3" && stats.bucketOf(9) === "q3" && stats.bucketOf(-1) === "q0", "a call is bucketed by the queries it sent, inside the buckets");
ok(SQL_QUERY_BUDGET === 3 && stats.BUCKETS.length === SQL_QUERY_BUDGET + 1, "the histogram's buckets cover zero to the call budget");
ok(stats.SQL_STATS_KEEP_DAYS() === 121, `today and the 120 days before it are kept by default, as earlier builds kept (${stats.SQL_STATS_KEEP_DAYS()})`);

// --- the query service, stubbed -------------------------------------------------
const realFetch = globalThis.fetch;
const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const isHealth = (sql) => Object.values(QUERY_HEALTH_SQL).includes(sql);
const isMeasure = (q) => /countIf\(length\(toString\(tuple\(\*\)\)\)/.test(String(q || ""));
let answer = null, sent = 0;
globalThis.fetch = async (url, init = {}) => {
  const host = (() => { try { return new URL(String(url)).hostname; } catch { return ""; } })();
  if (host !== "api.cdp.coinbase.com") return realFetch(url, init);
  const q = JSON.parse(init.body || "{}").sql;
  if (isHealth(q)) return J(200, { result: [{ block_number: 1 }] });
  sent++;
  return answer(q, sent);
};
_setQueryHealthForTest(true);
const fitRows = Array.from({ length: 18 }, (_, i) => ({ ix: i, sk: "a" }));
const ONE = () => J(200, { result: [{ n: 1 }] });
const SLOW_ONE = async () => { await new Promise((r) => setTimeout(r, 300)); return ONE(); };
const REJECTED = () => J(400, { errorMessage: "Unknown identifier nope" });
const ROW_SIZE = (q, n) => (n === 1 ? J(500, {}) : isMeasure(q) ? J(200, { result: [{ n: 22, big: 4, maxRow: 65972 }] }) : J(200, { result: fitRows }));
const WORST = (q) => (isMeasure(q) ? J(200, { result: [{ n: 50, big: 3, maxRow: 70000 }] }) : J(500, { errorMessage: "An internal server error occurred." }));

// --- the caller path: request scope, handler, settlement stand-in ---------------
const tool = CDP_TOOLS.find((t) => t.slug === "onchain-sql");
const app = express();
app.use(requestTimingMiddleware((req) => req.path));
app.use(express.json());
app.use((req, res, next) => {
  const s = currentRequestScope();
  if (s && req.headers["x-synthetic"] === "1") s.synthetic = true;
  // Like @x402/express: the handler's answer is held, then settled; a failed
  // settle discards it and answers 402.
  let settled = false;
  const orig = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400) return orig(body);
    if (req.headers["x-settle"] === "fail") return orig.call(res.status(402), { error: "settlement failed" });
    settled = true;
    return orig(body);
  };
  // Like the server (the catalog middleware): what the FINAL response says
  // about the sale, read only after the response ended.
  if (s) s.saleOutcome = () => (req.headers["x-free"] === "1" ? "free" : settled && res.statusCode === 200 ? "charged" : "none");
  next();
});
app.post("/api/onchain-sql", async (req, res) => {
  try { res.json(await tool.handler(req.body)); }
  catch (e) { res.status(e.statusCode || 502).json({ error: e.message }); }
});
const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const settle = () => new Promise((res) => setTimeout(res, 20)); // the finish hook runs after the body is sent
const call = async (sql, fn, headers = {}) => {
  answer = fn; sent = 0;
  const r = await realFetch(`${base}/api/onchain-sql`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ sql }) });
  const text = await r.text();
  await settle();
  return { status: r.status, sent, text };
};
const today = new Date().toISOString().slice(0, 10);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const H = (h) => stats.BUCKETS.map((b) => h[b]).join("/"); // q0/q1/q2/q3

try {
  const a = await call("SELECT 1 AS n FROM base.blocks", ONE);
  ok(a.status === 200 && a.sent === 1, `a one-query call answers 200 (${a.status}, ${a.sent} sent)`);
  let rep = await stats.sqlQueryStatsReport();
  ok(H(rep.totals.outside.charged) === "0/1/0/0" && H(rep.totals.outside.uncharged) === "0/0/0/0", `a settled one-query call is charged/1 (${JSON.stringify(rep.totals.outside)})`);

  const b = await call("SELECT ix, sk FROM base.blocks", ROW_SIZE);
  ok(b.status === 200 && b.sent === 3, `the row-size recovery answers 200 on three queries (${b.status}, ${b.sent})`);
  rep = await stats.sqlQueryStatsReport();
  ok(H(rep.totals.outside.charged) === "0/1/0/1", `the recovered call is charged with its true count, 3 (${H(rep.totals.outside.charged)})`);

  const c = await call("SELECT 1 AS n FROM base.blocks", ONE, { "x-settle": "fail" });
  ok(c.status === 402 && c.sent === 1, `a handler 200 whose settlement fails is a final 402 (${c.status})`);
  rep = await stats.sqlQueryStatsReport();
  ok(H(rep.totals.outside.uncharged) === "0/1/0/0" && H(rep.totals.outside.charged) === "0/1/0/1", `the settle failure is uncharged/1, never charged (${JSON.stringify(rep.totals.outside)})`);

  const d = await call("SELECT i FROM base.blocks", WORST);
  ok(d.status === 422 && d.sent === SQL_QUERY_BUDGET, `the worst path is the budget refusal (${d.status}, ${d.sent})`);
  const r1 = await call("SELECT nope FROM base.blocks", REJECTED);
  ok(r1.status === 422 && r1.sent === 1, `a query the service rejects is a 422 after one query (${r1.status}, ${r1.sent})`);
  const r0 = await call("DROP TABLE base.blocks", ONE);
  ok(r0.status === 400 && r0.sent === 0, `a statement that is not a SELECT is refused before any query (${r0.status}, ${r0.sent})`);
  rep = await stats.sqlQueryStatsReport();
  ok(H(rep.totals.outside.uncharged) === "1/2/0/1" && rep.totals.outside.budgetSpent === 1, `uncharged: one refusal before any query (0), the settle failure and the rejected query (1 each), the budget refusal (3) (${H(rep.totals.outside.uncharged)}, budgetSpent ${rep.totals.outside.budgetSpent})`);

  const e = await call("SELECT 1 AS n FROM base.blocks", ONE, { "x-synthetic": "1" });
  ok(e.status === 200, "a synthetic call answers 200");
  const f0 = await call("SELECT 1 AS n FROM base.blocks", ONE, { "x-free": "1" });
  ok(f0.status === 200, "a call nothing is asked for answers 200");
  // A buyer who leaves while the query runs: the handler finishes after the
  // response ended, and its query is still counted, as uncharged.
  {
    answer = SLOW_ONE; sent = 0;
    const ctl = new AbortController();
    const p = realFetch(`${base}/api/onchain-sql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: "SELECT 1 AS n FROM base.blocks" }), signal: ctl.signal }).then((r) => r.text(), () => "aborted");
    setTimeout(() => ctl.abort(), 80);
    ok((await p) === "aborted", "the buyer left before the answer");
    await new Promise((r) => setTimeout(r, 400));
  }
  // A call outside any request (the economy panel's refresh) is not counted.
  answer = ONE; sent = 0;
  await tool.handler({ sql: "SELECT 1 AS n FROM base.blocks" });

  rep = await stats.sqlQueryStatsReport();
  const t = rep.totals;
  ok(H(t.outside.charged) === "0/1/0/1" && H(t.outside.free) === "0/1/0/0" && H(t.outside.uncharged) === "1/3/0/1", `outside lane: charged 1 and 3, free 1, uncharged 0, 1 x3 (the hang-up included), 3; the out-of-request call adds nothing (${JSON.stringify(t.outside)})`);
  ok(H(t.synthetic.charged) === "0/1/0/0" && H(t.synthetic.uncharged) === "0/0/0/0", `synthetic lane counted apart (${JSON.stringify(t.synthetic)})`);
  ok(rep.days.length === 1 && rep.days[0].day === today, "counts sit under today's UTC day");
  const sum = rep.summary.outside;
  ok(sum.calls.charged === 2 && sum.queries.charged === 4 && sum.queries.uncharged === 6 && sum.queries.free === 1, `calls and queries by outcome (${JSON.stringify(sum)})`);
  ok(sum.queriesPerChargedCall === 2 && rep.queriesPerChargedCall === 2 && sum.allQueriesPerChargedCall === 5.5, `queries per charged call: 4 over 2, and every query sent (11) over 2 (${sum.queriesPerChargedCall}, ${sum.allQueriesPerChargedCall})`);
  ok(rep.summary.synthetic.queriesPerChargedCall === 1 && (await stats.sqlQueryStatsReport({ days: 1, now: Date.now() + 5 * 86_400_000 })).queriesPerChargedCall === null, "a window with no charged call reads null, never a division by zero");

  // Stored, then read back by a fresh module state (a deploy).
  const f = await stats.flushSqlQueryStats();
  ok(f.ok && f.flushed && existsSync(STATS_FILE), "a flush writes the state document");
  const raw = readFileSync(STATS_FILE, "utf8");
  ok(!/base\.blocks|SELECT|DROP|nope|organizations|0x/i.test(raw), "the stored document holds counts only (no SQL, no key, no address)");
  ok(!/base\.blocks|SELECT|DROP|nope|organizations|0x/i.test(JSON.stringify(rep)), "the report holds counts only");
  stats._resetSqlQueryStats();
  rep = await stats.sqlQueryStatsReport();
  ok(H(rep.totals.outside.charged) === "0/1/0/1" && H(rep.totals.outside.uncharged) === "1/3/0/1" && rep.totals.outside.budgetSpent === 1 && rep.scope === "stored", "the counts survive a fresh process state");

  // Increments from two writers add up (read-modify-write, never a whole-body replace).
  stats.noteSqlCall({ status: 200, queries: 2, sale: "charged" });
  await stats.flushSqlQueryStats();
  stats.noteSqlCall({ status: 200, queries: 2, sale: "charged" });
  rep = await stats.sqlQueryStatsReport();
  ok(rep.totals.outside.charged.q2 === 2 && rep.totals.outside.charged.q1 === 1, `stored and unflushed counts merge on read (q2 ${rep.totals.outside.charged.q2})`);
  await stats.flushSqlQueryStats();

  // A day stored before the outcome split (a lane of q1..q3 for final-200
  // calls) reads as charged and is rewritten in the current shape.
  {
    const stored = JSON.parse(readFileSync(STATS_FILE, "utf8"));
    const body = stored.body ?? stored;
    const y = dayOf(Date.now() - 86_400_000);
    body.days[y] = { outside: { q1: 5, q2: 1, q3: 2, budgetSpent: 3 }, synthetic: { q1: 4, q2: 0, q3: 0, budgetSpent: 0 } };
    writeFileSync(STATS_FILE, JSON.stringify(stored));
    stats._resetSqlQueryStats();
    rep = await stats.sqlQueryStatsReport();
    const row = rep.days.find((r) => r.day === y);
    ok(row && H(row.outside.charged) === "0/5/1/2" && row.outside.budgetSpent === 3 && H(row.synthetic.charged) === "0/4/0/0" && row.outside.q1 === undefined, `an earlier build's day reads as charged calls (${JSON.stringify(row?.outside)})`);
    stats.noteSqlCall({ status: 200, queries: 1, sale: "charged", now: Date.now() - 86_400_000 });
    await stats.flushSqlQueryStats();
    const after = JSON.parse(readFileSync(STATS_FILE, "utf8"));
    const lane = (after.body ?? after).days[y].outside;
    ok(H(lane.charged) === "0/6/1/2" && lane.q1 === undefined && lane.budgetSpent === 3, `and is stored in the current shape, counted once (${JSON.stringify(lane)})`);
  }

  // Retention: today and the 120 days before it stay (what every earlier
  // build kept: a day dropped only once it is older than 120 days); the day
  // before that is dropped on the next write. No setting keeps fewer.
  {
    const KEEP = stats.SQL_STATS_KEEP_DAYS();
    const now = Date.now();
    const oldest = now - (KEEP - 1) * 86_400_000, past = now - KEEP * 86_400_000;
    ok(dayOf(oldest) === dayOf(now - 120 * 86_400_000), "the oldest day kept is the one 120 days before today, as earlier builds kept");
    stats.noteSqlCall({ status: 200, queries: 1, sale: "charged", now: oldest });
    stats.noteSqlCall({ status: 200, queries: 1, sale: "charged", now: now - 40 * 86_400_000 });
    stats.noteSqlCall({ status: 200, queries: 1, sale: "charged", now: past });
    await stats.flushSqlQueryStats({ now });
    const stored = JSON.parse(readFileSync(STATS_FILE, "utf8"));
    const days = Object.keys((stored.body ?? stored).days || {});
    ok(days.includes(dayOf(oldest)) && days.includes(dayOf(now - 40 * 86_400_000)) && !days.includes(dayOf(past)) && days.includes(today), `days up to 120 back are kept and day 121 back is dropped (${days.sort().join(", ")})`);
    rep = await stats.sqlQueryStatsReport({ now });
    ok(rep.keepDays === 121 && rep.windowDays === 121 && rep.days.some((r) => r.day === dayOf(oldest)) && !rep.days.some((r) => r.day === dayOf(past)), "the report's window is the keep window");
    for (const low of ["2", "35", "120", "0", "-3", "abc", ""]) {
      process.env.SQL_QUERY_STATS_KEEP_DAYS = low;
      ok(stats.SQL_STATS_KEEP_DAYS() === 121, `SQL_QUERY_STATS_KEEP_DAYS=${JSON.stringify(low)} keeps the default (no setting keeps fewer days)`);
    }
    process.env.SQL_QUERY_STATS_KEEP_DAYS = "35";
    stats.noteSqlCall({ status: 200, queries: 1, sale: "charged", now });
    await stats.flushSqlQueryStats({ now });
    const again = Object.keys(((JSON.parse(readFileSync(STATS_FILE, "utf8"))).body ?? JSON.parse(readFileSync(STATS_FILE, "utf8"))).days || {});
    ok(again.includes(dayOf(oldest)) && again.includes(dayOf(now - 40 * 86_400_000)), "a flush under a low setting deletes no stored day an earlier build kept");
    process.env.SQL_QUERY_STATS_KEEP_DAYS = "200";
    ok(stats.SQL_STATS_KEEP_DAYS() === 200, "a longer setting keeps longer");
    process.env.SQL_QUERY_STATS_KEEP_DAYS = "9999";
    ok(stats.SQL_STATS_KEEP_DAYS() === 400, "at most 400 days");
    delete process.env.SQL_QUERY_STATS_KEEP_DAYS;
  }

  // A store that throws changes no answer: the same status and body as with a
  // working store, the count kept in memory, the failure counted and logged once.
  {
    stats._resetSqlQueryStats();
    const good = await call("SELECT 1 AS n FROM base.blocks", ONE);
    stats._resetSqlQueryStats();
    let storeCalls = 0;
    stats._setSqlQueryStatsDocForTest({ update: async () => { storeCalls++; throw new Error("store down"); }, read: async () => { storeCalls++; throw new Error("store down"); } });
    const warns = []; const realWarn = console.warn; console.warn = (m) => warns.push(String(m));
    try {
      const broken = await call("SELECT 1 AS n FROM base.blocks", ONE);
      ok(broken.status === 200 && broken.text === good.text && broken.sent === 1, "with a throwing store the call answers the same status and body");
      const refused = await call("DROP TABLE base.blocks", ONE);
      ok(refused.status === 400, "and a refusal is still the same refusal");
      const f1 = await stats.flushSqlQueryStats(), f2 = await stats.flushSqlQueryStats();
      ok(f1.ok === false && f2.ok === false && storeCalls === 2, "a failed write reports not ok and never throws");
      rep = await stats.sqlQueryStatsReport();
      ok(rep.scope === "unread" && rep.totals.outside.charged.q1 === 1 && rep.totals.outside.uncharged.q0 === 1 && rep.failures === 2, `the counts stay in memory for the next write and the failures are counted (${rep.failures})`);
      ok(warns.filter((w) => /sql-query-stats/.test(w)).length === 1 && !/store down|SELECT/.test(warns.join(" ")), `one log line a day, with no detail (${warns.length})`);
    } finally { console.warn = realWarn; }
    // A count that cannot be taken is swallowed too.
    ok(stats.noteSqlCall({ status: 200, queries: 1, sale: "charged", now: NaN }) === false, "a count that throws returns false, never the throw");
  }
} finally {
  server.close();
  globalThis.fetch = realFetch;
  stats._resetSqlQueryStats();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
