#!/usr/bin/env node
// The weekly operator scoreboard: its ledger half (scoreboardLedger in
// src/sales-ledger.js), its composition (src/scoreboard.js), the operator
// route, and the local script's pure parts (scripts/scoreboard.js). Offline.
//
//   node scripts/test-scoreboard.js
//
// Ledger: our own rows stay out, the 30-day shares (largest wallet, largest
// tool), new paying wallets per day with Arc left out and earlier payers not
// new, the week's payers handed over for resolution. Route: operator only,
// private and no-store, listed in routes.json, counts only (no address, name
// or hash), nothing on a public surface. Script: Bazaar position, MPP rank,
// the private report directory (never under CI, never inside the repository),
// the markdown report.
import "./lib/file-mode.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { bootServer } from "./lib/boot-server.js";

const DAY = 86_400_000;
const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, slug TEXT NOT NULL, price_usd REAL NOT NULL, rail TEXT NOT NULL, network TEXT, payer TEXT, tx TEXT, internal INTEGER NOT NULL, wire TEXT, quote_usd REAL, response_sha256 TEXT, attest_uid TEXT, attest_tx TEXT, via TEXT)`;
let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const TMP = mkdtempSync(join(tmpdir(), "scoreboard-"));
const LEDGER = join(TMP, "sales.db");
process.env.SALES_LEDGER_DB = LEDGER;
const sl = await import("../src/sales-ledger.js");
const { composeScoreboard, summarizeOperators } = await import("../src/scoreboard.js");
const script = await import("./scoreboard.js");

// ---- the ledger half ---------------------------------------------------------------
{
  const raw = new Database(LEDGER);
  raw.exec(LEDGER_DDL);
  const ins = raw.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire, via) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const now = Date.now();
  const today = Math.floor(now / DAY);
  const at = (d) => (today - d) * DAY + 3600_000;
  const P = (n) => `0x${n.toString(16).padStart(40, "0")}`;
  raw.transaction(() => {
    ins.run(at(40), "uuid", 0.01, "usdc", "eip155:8453", P(1), "t0", 0, "x402", "http"); // P1 paid before the window
    ins.run(at(2), "uuid", 0.01, "usdc", "eip155:8453", P(1), "t1", 0, "x402", "http");
    ins.run(at(2), "search", 0.6, "usdc", "eip155:8453", P(2), "t2", 0, "x402", "http"); // new on day 3 (its first sale)
    ins.run(at(3), "search", 0.2, "usdc", "eip155:8453", P(2), "t3", 0, "x402", "http");
    ins.run(at(10), "hash", 0.1, "usdc", "eip155:8453", P(3), "t4", 0, "x402", "http"); // new on day 10, not in the week
    ins.run(at(5), "hash", 0.09, "usdc", "eip155:5042", P(4), "t5", 0, "x402", "http"); // Arc only: not new
    ins.run(at(1), "uuid", 5, "usdc", "eip155:8453", "0x902dcf34e53695bdea2ffb354b1a2e58bd598256", "t6", 1, "x402", "http"); // ours
    ins.run(now - 60_000, "uuid", 3, "usdc", "eip155:8453", P(5), "t7", 0, "x402", "http"); // today: outside the window
  })();
  raw.close();
  const out = sl.scoreboardLedger({ days: 30, weekDays: 7, now });
  const dk = (d) => new Date((today - d) * DAY).toISOString().slice(0, 10);
  ok(out.window.days === 30 && out.window.to === dk(1) && out.week.from === dk(7), "30 whole days and the 7 before today");
  const c = out.concentration;
  ok(c.outsideUsd === 1 && c.payingWallets === 4 && c.toolsSold === 3, `outside dollars and counts, our own and today's rows left out (${JSON.stringify(c)})`);
  ok(c.topWalletShare === 0.8 && c.topToolShare === 0.8 && c.topTool === "search", "the largest wallet and tool shares");
  const np = Object.fromEntries(out.newPayersPerDay.map((d) => [d.day, d.newPayers]));
  ok(np[dk(3)] === 1 && np[dk(2)] === 0 && np[dk(10)] === 1 && np[dk(5)] === 0 && Object.values(np).reduce((a, b) => a + b, 0) === 2, `new payers per day: a payer from before the window is not new, an Arc-only payer is not counted (${JSON.stringify(Object.entries(np).filter(([, v]) => v))})`);
  ok(out.weekPayers.length === 3 && out.weekPayers.find((p) => p.payer === P(2)).days === 2, "the week's payers with their paying days");
  ok(JSON.stringify(await sl.scoreboardLedgerAsync({ days: 30, weekDays: 7, now })) === JSON.stringify(out), "the async read returns the same answer");
  const sb = composeScoreboard({ now, ledger: out, operators: summarizeOperators(out.weekPayers, new Map()), funnelWeek: { outsidePayingWallets: 3, repeatShare: 0.33, returningShare: 0.33, organicUsdPerDay: [], organicUsdPerDayAvg: 0 } });
  ok(sb.operators.operators === 3 && sb.concentration.topToolShare === 0.8 && sb.newPayersPerDay.excludedNetworks.includes("eip155:5042"), "the composed scoreboard carries each part");
  ok(!/0x[0-9a-f]{40}/i.test(JSON.stringify(sb)), "no wallet address in the composed answer");
}

// ---- the script's pure parts -------------------------------------------------------
{
  const routes = new Set(["/api/search", "/api/uuid"]);
  const host = "agent402.tools";
  ok(script.positionIn({ resources: [{ resource: "https://other.example/api/search" }, { resource: "https://agent402.tools/api/search" }] }, routes, host) === 2, "position of our first route, 1-based");
  ok(script.positionIn({ resources: [{ resource: "https://agent402.tools.evil.example/api/search" }] }, routes, host) === null, "a look-alike host is not ours: absent");
  ok(script.positionIn({ partialResults: true, resources: [] }, routes, host) === undefined, "a partial reply is unreadable");
  ok(script.mppRankOf({ rows: [{ rank: 1 }, { rank: 2, self: true }] }).rank === 2, "MPP rank is our own row's rank");
  ok(script.mppRankOf({ rows: [{ rank: 1 }] }).why === "not ranked" && script.mppRankOf(null).why === "unreadable", "not ranked and unreadable are said");
  let pauses = 0;
  const fakeFetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes("web+search") || String(url).includes("web%20search") ? { resources: [{ resource: "https://agent402.tools/api/search" }] } : { resources: [] }) });
  const ranks = await script.bazaarRanks([{ query: "web search", flagship: true }, { query: "uuid" }], routes, host, { fetchImpl: fakeFetch, sleep: async () => { pauses++; }, pauseMs: 0 });
  ok(ranks[0].position === 1 && ranks[0].ok && ranks[1].position === null && ranks[1].ok && pauses === 2, `Bazaar positions per query (${JSON.stringify(ranks)})`);
  const root = resolve("/repo/checkout");
  ok(script.privateDirFor({ env: { CI: "true" }, root, home: "/home/u" }) === null, "no report under CI");
  ok(script.privateDirFor({ env: { GITHUB_ACTIONS: "true" }, root, home: "/home/u" }) === null, "no report under Actions");
  ok(script.privateDirFor({ env: { SCOREBOARD_PRIVATE_DIR: "/repo/checkout/private" }, root, home: "/home/u" }) === null, "never inside the repository");
  ok(script.privateDirFor({ env: {}, root, home: "/home/u" }) === resolve("/home/u/.claude/projects/-repo-checkout/private/scoreboard"), "the default is the checkout's private project folder");
  const md = script.markdownOf({ generatedAt: "2026-11-18T00:00:00Z", week: { from: "a", to: "b" }, operators: { operators: 3, wallets: 4, resolvedWallets: 1, bySource: { ens: 1 }, pendingWallets: 0, unreadableWallets: 0, repeatShare: 0.5, topOperatorShare: 0.2 }, bazaarRank: [{ query: "web search", flagship: true, ok: true, position: 3 }], mppRank: { rank: 4, of: 100 } });
  ok(/Outside paying operators: 3/.test(md) && /web search: #3/.test(md) && /Rank 4 of 100/.test(md), "the markdown report");
}

// ---- the route ---------------------------------------------------------------------
const OP = "scoreboard-op-token-" + "z".repeat(24);
let srv;
try {
  srv = await bootServer({
    stores: "scoreboard",
    env: { FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", AGENT402_OPERATOR_TOKEN: OP, SALES_LEDGER_DB: join(TMP, "boot-sales.db"), REFUND_DB_DIR: TMP, TRAFFIC_DIR: join(TMP, "boot-traffic"), STATE_DATABASE_URL: "" },
  });
  const B = srv.url;
  const anon = await fetch(`${B}/__operator/scoreboard.json`);
  ok(anon.status === 404, `scoreboard.json is 404 without the token (${anon.status})`);
  const r = await fetch(`${B}/__operator/scoreboard.json`, { headers: { "x-operator-token": OP } });
  const cc = r.headers.get("cache-control") || "";
  ok(r.status === 200 && /private/.test(cc) && /no-store/.test(cc) && /x-operator-token/i.test(r.headers.get("vary") || ""), `the operator reads it, private, no-store, varying on the token (${r.status}, ${cc})`);
  const j = await r.json();
  ok(j.week && j.operators && j.concentration && j.listing?.catalogRoutes > 400 && j.definitions?.operators && "firstCallAllowance" in j && "refunds" in j, `every part is present (${Object.keys(j).join(",")})`);
  ok(!/0x[0-9a-f]{40}/i.test(JSON.stringify(j)), "no wallet address in the answer");
  const routes = await (await fetch(`${B}/__operator/routes.json`, { headers: { "x-operator-token": OP } })).json();
  ok(JSON.stringify(routes).includes("/__operator/scoreboard.json"), "routes.json lists it");
  const pub = [await (await fetch(`${B}/api/stats`)).text(), await (await fetch(`${B}/api/gateway-status`)).text(), await (await fetch(`${B}/llms.txt`)).text()].join("\n");
  ok(!/topOperatorShare|topWalletShare|newPayersPerDay|scoreboard\.json/.test(pub), "nothing of it reaches a public surface");
} catch (e) {
  ok(false, e?.stack || String(e));
  if (srv) console.error(srv.log().slice(-3000));
}
await srv?.stop();
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
