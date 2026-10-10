// src/stats.js against a REAL Postgres (STATE_DATABASE_URL; CI fails without it):
//   1. the SQLite file is imported once at the first boot with the database on,
//      the import is marked, and a second boot (a child process) does not
//      import again;
//   2. writes go to Postgres through the ordered queue and a fresh process sees
//      them (and so does a direct read through stateQuery);
//   3. the invariants: every charged_failures row lands, in order, pruned to the
//      newest RECENT_KEEP like the file; daily_upstream_spend sums are exact
//      integers in micro-dollars;
//   4. the schema is dropped and the pool closed at the end.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-stats-pg" });

const DIR = mkdtempSync(join(tmpdir(), "stats-pg-"));
process.env.STATS_DB_DIR = DIR;
process.env.FREE_MODE = "true";
const FILE = join(DIR, "agent402-stats.db");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const today = new Date().toISOString().slice(0, 10);
const FIRST_SERVED = 1_700_000_000_000;
const A = "https://a.seller.test", B = "https://b.seller.test", C = "https://c.seller.test", D = "https://d.seller.test";

// ---- the SQLite file a volume would hold ------------------------------------
{
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(FILE);
  db.exec(`
    CREATE TABLE counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL);
    CREATE TABLE tool_counts (slug TEXT PRIMARY KEY, n INTEGER NOT NULL);
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE recent_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, method TEXT NOT NULL, ts INTEGER NOT NULL);
    CREATE TABLE paid_tool_counts (slug TEXT PRIMARY KEY, n INTEGER NOT NULL);
    CREATE TABLE heartbeat_tool_counts (slug TEXT PRIMARY KEY, n INTEGER NOT NULL);
    CREATE TABLE charged_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, status INTEGER NOT NULL, ts INTEGER NOT NULL);
    CREATE TABLE daily_calls (day TEXT NOT NULL, method TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, method));
    CREATE TABLE daily_upstream_calls (day TEXT NOT NULL, upstream TEXT NOT NULL, caller TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, upstream, caller));
    CREATE TABLE daily_upstream_spend (day TEXT NOT NULL, source TEXT NOT NULL, usd_micro INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, source));
    CREATE TABLE seller_registrations (origin TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_routable_seen INTEGER, last_settled_seen INTEGER);
  `);
  for (const [k, n] of [["total", 10], ["viaUSDC", 4], ["usdcNet:base", 4], ["viaProofOfWork", 6], ["chargedButFailedTotal", 2]]) db.prepare("INSERT INTO counters VALUES (?, ?)").run(k, n);
  for (const [s, n] of [["hash", 7], ["whois", 3]]) db.prepare("INSERT INTO tool_counts VALUES (?, ?)").run(s, n);
  db.prepare("INSERT INTO paid_tool_counts VALUES (?, ?)").run("whois", 4);
  db.prepare("INSERT INTO meta VALUES (?, ?)").run("firstServed", String(FIRST_SERVED));
  for (let i = 1; i <= 3; i++) db.prepare("INSERT INTO recent_calls (slug, method, ts) VALUES (?, ?, ?)").run(i === 2 ? "whois" : "hash", i === 2 ? "usdc" : "pow", FIRST_SERVED + i);
  db.prepare("INSERT INTO charged_failures (slug, status, ts) VALUES (?, ?, ?)").run("whois", 402, FIRST_SERVED + 1);
  db.prepare("INSERT INTO charged_failures (slug, status, ts) VALUES (?, ?, ?)").run("whois", 500, FIRST_SERVED + 2);
  db.prepare("INSERT INTO daily_calls VALUES (?, ?, ?)").run("2026-01-01", "pow", 6);
  db.prepare("INSERT INTO daily_calls VALUES (?, ?, ?)").run("2026-01-01", "usdc", 4);
  db.prepare("INSERT INTO daily_upstream_calls VALUES (?, ?, ?, ?)").run("2026-01-01", "brave", "search", 9);
  db.prepare("INSERT INTO daily_upstream_spend VALUES (?, ?, ?, ?)").run(today, "x402-buyer", 2500, 2);
  db.prepare("INSERT INTO seller_registrations VALUES (?, ?, ?, ?)").run(A, 1, 2, null);
  db.close();
}

const sdb = await import("../src/state-db.js");
const T = (t) => `${sdb.stateDbSchema()}.stats_${t}`;
const one = async (sql, params = []) => (await sdb.stateQuery(sql, params)).rows[0];
const n = (v) => Number(v);

try {
  const stats = await import("../src/stats.js");
  const { getStats, getOperatorBreakdown, recordServedCall, recordChargedFailure, recordUpstreamCall, recordUpstreamSpend, recordSellerRegistrationSeen, ensureSellerRegistrations, deleteSellerRegistration, getSellerRegistrations, sellerRegistrationFirstSeen, getDailyUpstreamSpend, getDailyUpstreamCalls, getDailyCalls, chargedFailuresGenuineSince, statsFlush, statsReady, statsBackend, statsPersistent, dbHealthy } = stats;
  const snap = () => getStats({ wallet: "0x1", network: "base", toolCount: 2, baseUrl: "http://x", prices: { whois: 0.01 } });

  // ---- 1. the first boot imports the file once -----------------------------
  ok(statsBackend === "pg" && statsPersistent === true, "the database is the backend and the tally counts as persistent without /data");
  await statsReady();
  const mark = await sdb.imports.done("agent402-stats.db");
  ok(mark && mark.source === FILE, `the import is marked under the file's basename (source ${mark?.source})`);
  const s0 = snap();
  ok(s0.toolCallsServed.total === 10 && s0.toolCallsServed.viaUSDC === 4 && s0.toolCallsServed.viaUSDCByNetwork.base === 4, "counters are read from the mirror the import filled");
  ok(s0.servingSince === new Date(FIRST_SERVED).toISOString(), "meta (firstServed) came from the file, not from this boot");
  ok(s0.topTools.map((t) => `${t.slug}:${t.n}`).join(",") === "hash:7,whois:3" && s0.topToolsScope.toolsWithAnyCalls === 2, "tool counts and their population are imported");
  ok(s0.recentCalls.length === 3 && s0.recentCalls[0].slug === "hash" && s0.recentCalls[1].paidWith === "usdc", "the recent-calls feed is imported newest first");
  ok(s0.chargedButFailed === 2 && s0.chargedButFailedGenuine === 1 && s0.chargedButFailedGenuineScope.eventsRetained === 2, "charged failures are imported and the 402 row is not genuine");
  ok(s0.estimatedRevenueUsd === 0.04, "paid tool counts are imported (4 x 0.01)");
  ok(getDailyCalls().length === 1 && getDailyCalls()[0].pow === 6 && getDailyCalls()[0].usdc === 4, "the daily series is imported");
  ok(getDailyUpstreamCalls("brave")[0]?.n === 9, "the upstream call meter is imported");
  ok(getDailyUpstreamSpend()[0]?.usd_micro === 2500 && getDailyUpstreamSpend()[0]?.n === 2, "the upstream spend meter is imported");
  ok(getSellerRegistrations().length === 1 && getSellerRegistrations()[0].last_settled_seen === null && sellerRegistrationFirstSeen(A) === 1, "seller registrations are imported with their nulls");
  ok(n((await one(`SELECT n FROM ${T("counters")} WHERE k = 'total'`)).n) === 10, "the rows are in Postgres");
  ok(dbHealthy() === true, "dbHealthy reads true once the first load landed");

  // ---- 2. writes land in Postgres through the queue -------------------------
  for (let i = 0; i < 3; i++) recordServedCall("hash", "pow");
  recordServedCall("whois", "usdc", "base", "mpp");
  recordServedCall("hash", "usdc", "base", "mpp", { internal: true });
  recordUpstreamCall("brave", "search");
  recordUpstreamCall("brave", "answer");
  ok((await recordUpstreamSpend("x402-buyer", 0.001234)) === true, "recordUpstreamSpend resolves true once the row has landed");
  ok((await recordChargedFailure("whois", 500)) === true, "recordChargedFailure resolves true once the row has landed");
  recordSellerRegistrationSeen(B, { settled: true });
  recordSellerRegistrationSeen(C, { inheritFirstSeenFrom: A });
  ok(ensureSellerRegistrations([D, B]) === 1, "ensureSellerRegistrations counts only the row it added");
  ok(deleteSellerRegistration(A) === true && deleteSellerRegistration(A) === false, "deleteSellerRegistration answers whether a row went");
  const s1 = snap();
  ok(s1.toolCallsServed.total === 15 && s1.toolCallsServed.viaUSDC === 5 && s1.toolCallsServed.viaMPPWire === 1 && s1.toolCallsServed.viaUSDCInternal === 1 && s1.toolCallsServed.viaMPPWireInternal === 1, "the mirror reflects a write at once (synchronous readers)");
  ok(s1.recentCalls[0].paidWith === "heartbeat" && s1.recentCalls[1].slug === "whois", "our own paid call reaches the feed as a heartbeat row, newest first");
  ok(await statsFlush(), "statsFlush resolves true once the queue is empty");
  const c = async (k) => n((await one(`SELECT n FROM ${T("counters")} WHERE k = $1`, [k]))?.n ?? 0);
  ok((await c("total")) === 15 && (await c("viaUSDC")) === 5 && (await c("usdcNet:base")) === 5 && (await c("viaMPPWire")) === 1 && (await c("viaUSDCInternal")) === 1, "counters in Postgres carry the imported value plus the writes");
  ok(n((await one(`SELECT n FROM ${T("tool_counts")} WHERE slug = 'hash'`)).n) === 11 && n((await one(`SELECT n FROM ${T("heartbeat_tool_counts")} WHERE slug = 'hash'`)).n) === 1, "tool and heartbeat counts landed");
  ok(n((await one(`SELECT n FROM ${T("daily_calls")} WHERE day = $1 AND method = 'pow'`, [today])).n) === 3 && n((await one(`SELECT n FROM ${T("daily_calls")} WHERE day = $1 AND method = 'heartbeat'`, [today])).n) === 1, "the daily series landed");
  ok(n((await one(`SELECT n FROM ${T("daily_upstream_calls")} WHERE day = $1 AND upstream = 'brave' AND caller = 'search'`, [today])).n) === 1, "the upstream call meter landed");
  const sp = await one(`SELECT usd_micro, n FROM ${T("daily_upstream_spend")} WHERE day = $1 AND source = 'x402-buyer'`, [today]);
  ok(n(sp.usd_micro) === 3734 && n(sp.n) === 3, `spend adds to the imported row exactly (${sp.usd_micro} micro, n ${sp.n})`);
  const feed = n((await one(`SELECT count(*) AS n FROM ${T("recent_calls")}`)).n);
  ok(feed === 8, `eight feed rows: 3 imported + 5 served (${feed})`);
  const sellers = (await sdb.stateQuery(`SELECT origin, first_seen, last_routable_seen, last_settled_seen FROM ${T("seller_registrations")} ORDER BY origin`)).rows;
  ok(sellers.map((r) => r.origin).join(",") === [B, C, D].join(","), "seller rows: A deleted, B, C and D present");
  ok(n(sellers[0].last_settled_seen) > 0 && n(sellers[1].first_seen) === 1 && sellers[2].last_routable_seen === null, "B settled, C inherited A's first_seen (succession), D is a bare slot");

  // ---- 1b. a second boot does not import again -------------------------------
  {
    // A row added to the file after the first boot is what a re-import would bring in.
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(FILE);
    db.prepare("INSERT INTO tool_counts VALUES (?, ?)").run("sneaky", 99);
    db.prepare("UPDATE counters SET n = 1000 WHERE k = 'total'").run();
    db.close();
    const code = `
      const m = await import(${JSON.stringify(new URL("../src/stats.js", import.meta.url).href)});
      const sdb = await import(${JSON.stringify(new URL("../src/state-db.js", import.meta.url).href)});
      await m.statsReady();
      const s = m.getStats({ wallet: "0x1", network: "base", toolCount: 2, baseUrl: "http://x", prices: {} });
      console.log(JSON.stringify({ total: s.toolCallsServed.total, tools: s.topTools.map((t) => t.slug), firstSeenC: m.sellerRegistrationFirstSeen(${JSON.stringify(C)}), spend: m.getDailyUpstreamSpend(), failures: s.chargedButFailedGenuineScope.eventsRetained, mark: Boolean(await sdb.imports.done("agent402-stats.db")) }));
      await sdb.closeStateDb();
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: process.env, encoding: "utf8", timeout: 60_000 });
    let out = null; try { out = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* reported below */ }
    ok(r.status === 0 && out, `a second boot runs (status ${r.status}) ${r.status === 0 ? "" : r.stderr.slice(0, 300)}`);
    ok(out?.mark === true, "the second boot finds the import mark");
    ok(out?.total === 15 && !out?.tools.includes("sneaky"), `the second boot reads the rows, not the file again (total ${out?.total}, tools ${out?.tools?.join(",")})`);
    ok(out?.firstSeenC === 1 && out?.failures === 3 && out?.spend?.[0]?.usd_micro === 3734, "the second boot sees every write the first one queued");
  }

  // ---- 3. invariants -------------------------------------------------------
  // Every charged failure lands, in call order, and the table keeps the newest
  // RECENT_KEEP like the file did.
  const statuses = [500, 502, 503, 504, 599];
  for (const st of statuses) recordChargedFailure("tool-x", st);
  await statsFlush();
  const tailRows = (await sdb.stateQuery(`SELECT id, status FROM ${T("charged_failures")} ORDER BY id DESC LIMIT 5`)).rows.reverse();
  ok(tailRows.map((r) => n(r.status)).join(",") === statuses.join(",") && tailRows.every((r, i) => i === 0 || n(r.id) === n(tailRows[i - 1].id) + 1), "five charged failures recorded back to back land in order with consecutive ids");
  ok(chargedFailuresGenuineSince(0) === 7 && snap().chargedButFailed === 8, "the mirror counts them (6 genuine + 1 imported genuine; the lifetime counter is 8)");
  for (let i = 0; i < 250; i++) recordChargedFailure("burst", 500);
  await statsFlush();
  const cf = await one(`SELECT count(*) AS n, max(id) - min(id) + 1 AS span FROM ${T("charged_failures")}`);
  ok(n(cf.n) === 200 && n(cf.span) === 200, `a burst past RECENT_KEEP leaves exactly the newest 200 rows (${cf.n}, span ${cf.span})`);
  ok(snap().chargedButFailedGenuineScope.eventsRetained === 200 && snap().chargedButFailed === 258, "the mirror's window and lifetime counter agree with the table");
  const fc = n((await one(`SELECT n FROM ${T("counters")} WHERE k = 'chargedButFailedTotal'`)).n);
  ok(fc === 258, `chargedButFailedTotal in Postgres counts every one (${fc})`);
  ok(getOperatorBreakdown({ prices: {}, walletOnlySet: new Set() }).chargedFailures.length === 200, "the operator log reads the retained window");
  // Spend sums are exact integers: a thousand micro-dollar units add up to
  // exactly a thousand, with no float drift, in the mirror and in the table.
  for (let i = 0; i < 1000; i++) recordUpstreamSpend("meter", 0.000001);
  await statsFlush();
  const m1 = getDailyUpstreamSpend().find((r) => r.source === "meter");
  const m2 = await one(`SELECT usd_micro, n FROM ${T("daily_upstream_spend")} WHERE day = $1 AND source = 'meter'`, [today]);
  ok(m1?.usd_micro === 1000 && m1?.n === 1000 && n(m2.usd_micro) === 1000 && n(m2.n) === 1000, `1000 x 1 micro = 1000 exactly (mirror ${m1?.usd_micro}, table ${m2?.usd_micro})`);
  ok(recordUpstreamSpend("meter", 0) === undefined && recordUpstreamSpend("meter", -1) === undefined, "zero and negative spend are not recorded");
  // The feed keeps the newest RECENT_KEEP rows in the table and in the mirror.
  for (let i = 0; i < 260; i++) recordServedCall(`feed-${i % 7}`, "pow");
  await statsFlush();
  const rc = await one(`SELECT count(*) AS n FROM ${T("recent_calls")}`);
  const ob = getOperatorBreakdown({ prices: {}, walletOnlySet: new Set() });
  ok(n(rc.n) === 200 && ob.recentCalls.length === 200 && ob.recentCalls[0].slug === "feed-0", `the feed is pruned to 200 in the table and the mirror, newest first (${rc.n})`);
  ok((await c("total")) === 275 && snap().toolCallsServed.total === 275, "lifetime total after everything: 15 + 260 in both");
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb().catch(() => {});
  rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
