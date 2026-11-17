#!/usr/bin/env node
// The paid-call funnel (src/funnel.js), its counters on the traffic store, the
// sales ledger's half (funnelLedger) and /__operator/funnel.json, offline.
//
//   node scripts/test-funnel.js
//   node scripts/test-funnel.js --perf <file>   (child mode: 400k-row ledger timing)
//
// Unit half: arrival of a request and of a ledger row, refusal classes, the
// outcome of a finished request, the caller window (retried, paid after a
// probe, never retried, untracked past the cap), the store's bounded funnel
// counts and their persistence.
// Ledger half: per day and arrival path on a fixed ledger (own rows out,
// marketplace at the buyer's price, a storefront sale with no path is direct,
// an x402 row with no path is unknown), and the weekly figures (paying
// wallets, repeat and returning shares, dollars per day).
// Cost half: a 400k-row ledger over 30 days in a child process; the read must
// finish inside a bound and never hold the event loop for long.
// Booted half (the REAL server, x402 paywall on, stub facilitator): probes,
// a Bazaar-named probe, refused credentials by class, a settled buy, an MCP
// loopback buy; /__operator/funnel.json counts each and is operator-only, and
// nothing of it reaches a public surface.
import "./lib/file-mode.js";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { bootServer } from "./lib/boot-server.js";

const SELF = fileURLToPath(import.meta.url);
const DAY = 86_400_000;
const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, slug TEXT NOT NULL, price_usd REAL NOT NULL, rail TEXT NOT NULL, network TEXT, payer TEXT, tx TEXT, internal INTEGER NOT NULL, wire TEXT, quote_usd REAL, response_sha256 TEXT, attest_uid TEXT, attest_tx TEXT, via TEXT)`;

// ---- child mode: the cost of one read on a 400k-row ledger -----------------------------
if (process.argv[2] === "--perf") {
  const file = process.argv[3];
  const f = new Database(file);
  f.exec(LEDGER_DDL);
  const ins = f.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire, via) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const now = Date.now();
  const VIAS = ["http", "mcp", "agent402-mcp/0.13.1", null, "bazaar", "agent402-client/0.8.21"];
  const ROWS = 400_000;
  f.transaction(() => {
    for (let i = 0; i < ROWS; i++) {
      const ts = now - 30 * DAY + Math.floor((i / ROWS) * 30 * DAY);
      const payer = `0x${(i % 6000).toString(16).padStart(40, "0")}`;
      ins.run(ts, `tool-${i % 400}`, 0.005, i % 50 === 0 ? "referral" : "usdc", "base", payer, `0x${i.toString(16)}`, i % 3 === 0 ? 1 : 0, "x402", VIAS[i % VIAS.length]);
    }
  })();
  f.close();
  process.env.SALES_LEDGER_DB = file;
  const sl = await import("../src/sales-ledger.js");
  const { monitorEventLoopDelay } = await import("node:perf_hooks");
  const h = monitorEventLoopDelay({ resolution: 5 });
  // A timer that measures the longest turn directly, beside the histogram.
  let last = performance.now(), maxGap = 0;
  const tick = setInterval(() => { const t = performance.now(); maxGap = Math.max(maxGap, t - last); last = t; }, 2);
  global.gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  h.enable();
  const t0 = performance.now();
  const out = await sl.funnelLedgerAsync({ days: 30, weekDays: 7, now });
  const ms = performance.now() - t0;
  h.disable();
  clearInterval(tick);
  const heapMb = (process.memoryUsage().heapUsed - heap0) / 1e6;
  const sync0 = performance.now();
  sl.funnelLedger({ days: 30, weekDays: 7, now });
  const syncMs = performance.now() - sync0;
  console.log(JSON.stringify({ rows: ROWS, ms: Math.round(ms), syncMs: Math.round(syncMs), maxTurnMs: Math.round(maxGap), loopDelayMaxMs: Math.round(h.max / 1e6), heapMb: +heapMb.toFixed(1), wallets: out.week.outsidePayingWallets, days: out.byDay.length }));
  process.exit(0);
}

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const TMP = mkdtempSync(join(tmpdir(), "funnel-"));
const LEDGER = join(TMP, "sales.db");
process.env.SALES_LEDGER_DB = LEDGER;
process.env.TRAFFIC_DIR = join(TMP, "traffic");
const fn = await import("../src/funnel.js");
const { createTrafficStore } = await import("../src/traffic-classifier.js");
const sl = await import("../src/sales-ledger.js");

// ---- refusal classes ------------------------------------------------------------------
{
  const want = {
    "insufficient-funds": "unfundedWallet", "no-token-account": "unfundedWallet",
    "unsupported-network": "wrongNetwork", "unsupported-scheme": "wrongNetwork",
    "not-checked": "ourSide", "facilitator-quota": "ourSide", "settlement-unconfirmed": "ourSide",
    "malformed-header": "verifyRefused", "version-mismatch": "verifyRefused", "requirements-mismatch": "verifyRefused",
    "amount-below-price": "verifyRefused", "authorization-expired": "verifyRefused", "wrong-recipient": "verifyRefused",
    unclassified: "unclassified",
  };
  for (const [r, c] of Object.entries(want)) ok(fn.refusalClassOf(r) === c, `${r} -> ${c}`);
  ok(fn.refusalClassOf(null) === "noReason" && fn.refusalClassOf("") === "noReason", "no reason recorded -> noReason");
  ok(fn.refusalClassOf("something-new") === "unclassified", "a word outside the vocabulary -> unclassified");
  ok(fn.refusalReasonKey("insufficient-funds") === "insufficient-funds" && fn.refusalReasonKey("x<script>") === "other" && fn.refusalReasonKey(null) === "none", "the per-reason key is a vocabulary word, other or none");
}

// ---- arrival of a ledger row and of a request -------------------------------------------
{
  const s = fn.arrivalOfSale;
  ok(s({ rail: "referral", via: "http" }) === "marketplace" && s({ rail: "referral", via: null }) === "marketplace", "a referral row is marketplace, with or without a path");
  ok(s({ rail: "usdc", via: "mcp" }) === "mcp" && s({ rail: "usdc", via: "x402-mcp" }) === "mcp" && s({ rail: "usdc", via: "agent402-mcp/0.13.1" }) === "mcp", "connector loopback, x402 twin and the MCP package are mcp");
  ok(s({ rail: "usdc", via: "bazaar" }) === "bazaar", "a stored bazaar path is bazaar");
  ok(s({ rail: "usdc", via: "http" }) === "direct" && s({ rail: "usdc", via: "agent402-client/0.8.21" }) === "direct", "plain HTTP and the client packages are direct");
  ok(s({ rail: "card", via: null, wire: "stripe-checkout" }) === "direct" && s({ rail: "usdc", via: null, wire: "mpp-tempo-subscription" }) === "direct", "a storefront sale or a subscription charge with no path is direct");
  ok(s({ rail: "usdc", via: null, wire: "x402" }) === "unknown", "an x402 row with no path is unknown");
  const req = (url, ua, headers = {}) => ({ originalUrl: url, url, path: url, headers: { "user-agent": ua, ...headers } });
  ok(fn.arrivalOfRequest(req("/ref/search", "curl/8")) === "marketplace", "a /ref request is marketplace");
  ok(fn.arrivalOfRequest(req("/api/search", "Coinbase-Bazaar/1.0")) === "bazaar", "a User-Agent naming the Bazaar is bazaar");
  ok(fn.arrivalOfRequest(req("/api/search", "agent402-mcp/0.13.32")) === "mcp", "our MCP package is mcp");
  ok(fn.arrivalOfRequest(req("/api/search", "python-httpx/0.27")) === "direct", "anything else is direct");
  const sp = await import("../src/sale-path.js");
  ok(sp.salePathOf(req("/api/search", "Coinbase-Bazaar/1.0")) === "bazaar" && sp.cleanSalePath("bazaar") === "bazaar" && sp.salePathGroup("bazaar") === "bazaar", "the sale path books, stores and groups bazaar");
}

// ---- the outcome of a finished request --------------------------------------------------
{
  const res = (status, headers = {}) => ({ statusCode: status, headersSent: true, getHeader: (k) => headers[String(k).toLowerCase()] ?? null });
  const req = (headers = {}, extra = {}) => ({ originalUrl: "/api/uuid", headers: { "user-agent": "curl/8", ...headers }, ...extra });
  const e1 = fn.funnelEventOf(req(), res(402));
  ok(e1.outcome === "probe" && e1.status === 402 && e1.arrival === "direct", "no credential, 402 -> probe");
  const e2 = fn.funnelEventOf(req({ "payment-signature": "abc" }, { __paymentRejectReason: "insufficient-funds" }), res(402));
  ok(e2.outcome === "attempt" && !e2.settled && e2.reason === "insufficient-funds", "a credential refused with a reason -> attempt, refused, reason kept");
  const e3 = fn.funnelEventOf(req({ "payment-signature": "abc" }), res(200, { "payment-response": "x" }));
  ok(e3.outcome === "attempt" && e3.settled === true, "a credential answered 200 with a receipt -> settled");
  const e4 = fn.funnelEventOf(req({ authorization: "Payment abc" }), res(400));
  ok(e4.outcome === "attempt" && !e4.settled && e4.reason === null, "an MPP credential answered 400 -> attempt, not settled");
  ok(fn.funnelEventOf(req({}, { __paymentHeaderAsSent: "!!" }), res(402)).outcome === "attempt", "a header removed at intake still counts as an attempt");
  ok(fn.funnelEventOf(req({ "x-pow-solution": "s" }), res(200)).outcome === "free", "proof of work -> free");
  ok(fn.funnelEventOf(req(), res(200)).outcome === "free", "a 200 with no credential (trial) -> free");
  ok(fn.funnelEventOf(req({ "payment-signature": "abc" }), res(200, { "payment-response": "x" }), { ours: true }).outcome === "ours", "our own traffic -> ours");
}

// ---- the counter on a real store: windows, caps, persistence -------------------------------
{
  const dir = join(TMP, "store-a");
  const store = createTrafficStore({ dir, salt: "t", backend: "file" });
  const f = fn.createFunnel({ bump: store.bumpFunnel, retryWindowMs: 30 * 60_000, callerCap: 3, sweepEveryMs: 60_000 });
  const t0 = Date.parse(new Date().toISOString().slice(0, 10) + "T01:00:00Z");
  const day = new Date(t0).toISOString().slice(0, 10);
  const P = { arrival: "direct", outcome: "probe", status: 402 };
  f.record(P, { ip: "198.51.100.1", now: t0 });
  f.record(P, { ip: "198.51.100.1", now: t0 + 1000 }); // a second probe of the same caller: one caller
  f.record({ arrival: "direct", outcome: "attempt", status: 402, settled: false, reason: "insufficient-funds" }, { ip: "198.51.100.1", now: t0 + 2000 });
  f.record({ arrival: "direct", outcome: "attempt", status: 200, settled: true }, { ip: "198.51.100.1", now: t0 + 3000 });
  f.record(P, { ip: "198.51.100.2", now: t0 + 4000 }); // never comes back
  f.record({ arrival: "bazaar", outcome: "probe", status: 400 }, { ip: "198.51.100.3", now: t0 + 5000 });
  f.record({ arrival: "direct", outcome: "attempt", status: 402, settled: false, reason: "unsupported-network" }, { ip: "198.51.100.9", now: t0 + 6000 });
  f.record({ arrival: "direct", outcome: "attempt", status: 502, settled: false }, { ip: "198.51.100.9", now: t0 + 6500 });
  f.record({ arrival: "mcp", outcome: "ours", status: 200 }, { ip: "198.51.100.4", now: t0 + 7000 });
  f.record({ arrival: "direct", outcome: "free", status: 200 }, { ip: "198.51.100.4", now: t0 + 7000 });
  f.record({ arrival: "nowhere", outcome: "probe", status: 402 }, { ip: "198.51.100.4", now: t0 + 7000 });
  f.record(P, { ip: "198.51.100.5", now: t0 + 8000 }); // the cap (3) holds .1 .2 .3; .5 closes .1 early, which keeps its verdict
  f.sweep(t0 + 31 * 60_000);
  const row = store.funnelDays(1)[0];
  const d = row.funnel.direct, bz = row.funnel.bazaar;
  ok(row.day === day, `counts land on the request's UTC day (${row.day})`);
  ok(d.probes === 4 && d.challenges === 6, `direct: 4 probes, 6 challenges (4 unpaid 402s + 2 refused) (${d.probes}, ${d.challenges})`);
  ok(d.attempts === 4 && d.settled === 1 && d.refused === 2 && d.errorAnswered === 1 && !("notCharged" in d), `direct: 4 attempts, 1 settled, 2 refused, 1 answered an error (${JSON.stringify({ a: d.attempts, s: d.settled, r: d.refused, n: d.errorAnswered })})`);
  ok(d.refusal.unfundedWallet === 1 && d.refusal.wrongNetwork === 1 && d.reasons["insufficient-funds"] === 1 && d.reasons["unsupported-network"] === 1, `refusal classes and reasons (${JSON.stringify(d.refusal)} ${JSON.stringify(d.reasons)})`);
  ok(d.probedCallers === 3 && d.retried === 1 && d.paidAfterProbe === 1, `direct callers: 3 probed, 1 retried, 1 paid after its probe (${d.probedCallers}, ${d.retried}, ${d.paidAfterProbe})`);
  ok(d.neverRetried === 2 && !d.untracked, `the two callers that never came back are never retried; an early close of one that did is not untracked (${d.neverRetried}, untracked ${d.untracked})`);
  ok(bz.probes === 1 && bz.challenges === undefined && bz.probedCallers === 1, `a 400 probe is a probe, not a 402 served (${JSON.stringify(bz)})`);
  ok(row.funnel.mcp.ours === 1 && d.free === 1, "ours and free are counted apart");
  ok(!("nowhere" in row.funnel), "an arrival outside the vocabulary is not counted");
  ok(f.size() === 0, "every caller closes when its window ends");
  // Cap: a fourth open caller evicts the oldest as untracked (never a verdict).
  const g = fn.createFunnel({ bump: store.bumpFunnel, retryWindowMs: 30 * 60_000, callerCap: 2 });
  const t1 = t0 + 2 * 3600_000;
  for (let i = 0; i < 3; i++) g.record(P, { ip: `203.0.113.${i}`, now: t1 + i });
  ok(g.size() === 2 && store.funnelDays(1)[0].funnel.direct.untracked === 1, "past the cap the oldest open caller is counted untracked and dropped");
  // Bounds on the store: a key outside the pattern, and the per-group cap.
  ok(store.bumpFunnel(day, "direct", "x y") === false && store.bumpFunnel("2026-13-99x", "direct", "probes") === false && store.bumpFunnel(day, "bad arrival", "probes") === false, "malformed keys are refused");
  for (let i = 0; i < 80; i++) store.bumpFunnel(day, "direct", "reasons", 1, `r${i}`);
  ok(Object.keys(store.funnelDays(1)[0].funnel.direct.reasons).length <= 64, "a group holds at most 64 keys");
  ok(store.persist(t1 + 10) === true, "the funnel counts persist with the day rollup");
  const again = createTrafficStore({ dir, salt: "t", backend: "file" });
  again.load();
  ok(again.funnelDays(1)[0]?.funnel?.direct?.settled === 1, "and read back after a restart");
  ok(!JSON.stringify(store.funnelDays(5)).includes("198.51.100"), "no address is stored");
}

// ---- the ledger half on a fixed ledger --------------------------------------------------
{
  const raw = new Database(LEDGER);
  raw.exec(LEDGER_DDL);
  const ins = raw.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire, quote_usd, via) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const now = Date.now();
  const today = Math.floor(now / DAY);
  const at = (d) => (today - d) * DAY + 3600_000; // 01:00Z on that day
  const A = "0x000000000000000000000000000000000000a001", B = "0x000000000000000000000000000000000000a002", C = "0x000000000000000000000000000000000000a003";
  const D = "0x000000000000000000000000000000000000a004", E = "0x000000000000000000000000000000000000a005", F = "0x000000000000000000000000000000000000a006";
  raw.transaction(() => {
    ins.run(at(1), "uuid", 0.01, "usdc", "base", A, "0x1", 0, "x402", null, "http");
    ins.run(at(3), "uuid", 0.01, "usdc", "base", A, "0x2", 0, "x402", null, "http");
    ins.run(at(20), "uuid", 0.01, "usdc", "base", A, "0x3", 0, "x402", null, "http");
    ins.run(at(2), "search", 0.02, "usdc", "base", B, "0x4", 0, "x402", null, "agent402-mcp/0.13.1");
    ins.run(at(2), "search", 0.009, "referral", "base", C, "0x5", 0, "referral", 0.01, "http");
    ins.run(at(1), "report", 1.0, "card", "stripe", null, "pi_1", 0, "stripe-checkout", null, null);
    ins.run(at(1), "hash", 0.005, "usdc", "base", D, "0x6", 0, "x402", null, null);
    ins.run(at(4), "hash", 0.003, "usdc", "base", E, "0x7", 0, "x402", null, "bazaar");
    ins.run(at(1), "uuid", 0.5, "usdc", "base", "0x902dcf34e53695bdea2ffb354b1a2e58bd598256", "0x8", 1, "x402", null, "http");
    ins.run(now - 60_000, "uuid", 0.01, "usdc", "base", F, "0x9", 0, "x402", null, "http");
  })();
  raw.close();
  const out = sl.funnelLedger({ days: 14, weekDays: 7, now });
  const dk = (d) => new Date((today - d) * DAY).toISOString().slice(0, 10);
  ok(out.byDay.length === 14 && out.byDay[0].day === dk(0) && out.byDay[0].partial === true, "14 days, newest first, today partial");
  const d1 = out.byDay.find((d) => d.day === dk(1));
  ok(d1.sales === 3 && d1.unknownShare === 0.333, `yesterday: 3 outside sales, the internal row left out, a third unknown (${JSON.stringify({ s: d1.sales, u: d1.unknownShare })})`);
  ok(d1.byArrival.direct.sales === 2 && d1.byArrival.direct.payers === 1 && d1.byArrival.direct.revenueUsd === 1.01 && d1.byArrival.unknown.sales === 1, `direct holds the http sale and the card sale (${JSON.stringify(d1.byArrival.direct)})`);
  const d2 = out.byDay.find((d) => d.day === dk(2));
  ok(d2.byArrival.mcp.sales === 1 && d2.byArrival.marketplace.sales === 1 && d2.byArrival.marketplace.revenueUsd === 0.01, `mcp and marketplace (at the buyer's price) (${JSON.stringify(d2.byArrival)})`);
  ok(out.byDay.find((d) => d.day === dk(4)).byArrival.bazaar.sales === 1, "a bazaar row is bazaar");
  const w = out.week;
  ok(w.from === dk(7) && w.to === dk(1) && w.days === 7, `the week is the 7 whole days before today (${w.from}..${w.to})`);
  ok(w.outsidePayingWallets === 5, `5 outside paying wallets (today's and our own excluded) (${w.outsidePayingWallets})`);
  ok(w.repeatShare === 0.2 && w.returningShare === 0.2, `repeat 1/5 (paid on two days), returning 1/5 (paid before the week) (${w.repeatShare}, ${w.returningShare})`);
  ok(w.outsidePayingOperators === null, "operators are not claimed");
  ok(w.salesWithoutPayer === 1, "a sale with no payer is counted apart");
  ok(w.organicUsdPerDay.length === 7 && w.organicUsdPerDay.find((x) => x.day === dk(1)).revenueUsd === 1.015 && w.organicUsdPerDayAvg === 0.1511, `dollars per day without our own buys (${JSON.stringify(w.organicUsdPerDay)}, avg ${w.organicUsdPerDayAvg})`);
  const asy = await sl.funnelLedgerAsync({ days: 14, weekDays: 7, now });
  ok(JSON.stringify(asy) === JSON.stringify(out), "the async read returns the same answer");
  ok(sl.funnelLedger({ days: 400, now }).byDay.length === sl.FUNNEL_MAX_DAYS, "the window is bounded at 30 days");
  ok(!JSON.stringify(out).includes("0x0000"), "no wallet address in the answer");
}

// ---- the cost on a 400k-row ledger ---------------------------------------------------------
{
  const file = join(TMP, "perf.db");
  const r = spawnSync(process.execPath, ["--expose-gc", SELF, "--perf", file], { env: { ...process.env, SALES_LEDGER_DB: file }, encoding: "utf8", timeout: 300_000 });
  let m = null; try { m = JSON.parse(String(r.stdout).trim().split("\n").pop()); } catch { m = null; }
  ok(r.status === 0 && m, `the 400k-row read ran (${m ? JSON.stringify(m) : String(r.stderr).slice(-400)})`);
  if (m) {
    ok(m.rows === 400_000 && m.days === 30 && m.wallets > 0, "it read 30 days of the 400k rows");
    ok(m.ms < 20_000, `it finished inside 20 s (${m.ms} ms)`);
    ok(m.maxTurnMs < 150, `the longest event-loop turn stayed under 150 ms (${m.maxTurnMs} ms; histogram max ${m.loopDelayMaxMs} ms)`);
    ok(m.heapMb < 150, `heap growth stayed bounded (${m.heapMb} MB)`);
  }
}

// ---- booted half ----------------------------------------------------------------------------
const OP = "test-funnel-operator-token-0123456789abcdef";
const TX = `0x${"6b".repeat(32)}`;
let srv = null, facilitator = null;
facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") return reply({ jsonrpc: "2.0", id: 1, result: "0x" + (1_000_000_000).toString(16).padStart(64, "0") });
    let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") return reply({ isValid: true, payer });
    if (req.url === "/settle") return reply({ success: true, transaction: TX, network: "eip155:8453", payer });
    reply({});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;
try {
  const MCP_MARKER = `mcp;k=${"6c".repeat(24)}`;
  srv = await bootServer({
    stores: "funnel",
    env: { FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
      FACILITATOR_URL: FAC, AGENT402_BASE_RPC: `${FAC}/rpc`, PAYMENT_NETWORKS: "base", MCP_LOOPBACK_TEST_SECRET: "6c".repeat(24),
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "", STATE_DATABASE_URL: "",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
      AGENT402_OPERATOR_TOKEN: OP, REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, "boot-sales.db"), HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"),
      TRAFFIC_DIR: join(TMP, "boot-traffic") },
  });
  const B = srv.url;
  const unpaid = await fetch(`${B}/api/uuid`, { headers: { "user-agent": "curl/8.7.1" } });
  ok(unpaid.status === 402, `unpaid uuid -> 402 (${unpaid.status})`);
  await fetch(`${B}/api/uuid`, { headers: { "user-agent": "curl/8.7.1" } });
  const bz = await fetch(`${B}/api/uuid`, { headers: { "user-agent": "Coinbase-Bazaar/1.0" } });
  ok(bz.status === 402, "a Bazaar-named probe -> 402");
  const accepted = (JSON.parse(Buffer.from(unpaid.headers.get("payment-required"), "base64").toString("utf-8")).accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  let nonceN = 0;
  const credential = (payer, over = {}) => Buffer.from(JSON.stringify({
    x402Version: 2, resource: accepted.resource, accepted: { ...accepted, ...over },
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0x9000 + ++nonceN).toString(16).padStart(64, "0") } },
  })).toString("base64");
  const wrongNet = await fetch(`${B}/api/uuid`, { headers: { "user-agent": "curl/8.7.1", "payment-signature": credential("0x00000000000000000000000000000000000c0001", { network: "eip155:1" }) } });
  ok(wrongNet.status === 402, `a payment on a network the route does not offer -> 402 (${wrongNet.status})`);
  const malformed = await fetch(`${B}/api/uuid`, { headers: { "user-agent": "curl/8.7.1", "payment-signature": "not-base64-json" } });
  ok(malformed.status === 402, `a header that does not decode -> 402 (${malformed.status})`);
  const paid = await fetch(`${B}/api/uuid`, { headers: { "user-agent": "curl/8.7.1", "payment-signature": credential("0x00000000000000000000000000000000000c0002") } });
  ok(paid.status === 200, `a valid payment -> 200 (${paid.status})`);
  const viaMcp = await fetch(`${B}/api/uuid`, { headers: { "user-agent": "node", "x-agent402-via": MCP_MARKER, "payment-signature": credential("0x00000000000000000000000000000000000c0003") } });
  ok(viaMcp.status === 200, `a connector loopback payment -> 200 (${viaMcp.status})`);
  const bzPaid = await fetch(`${B}/api/uuid`, { headers: { "user-agent": "Coinbase-Bazaar/1.0", "payment-signature": credential("0x00000000000000000000000000000000000c0004") } });
  ok(bzPaid.status === 200, `a Bazaar-named payment -> 200 (${bzPaid.status})`);
  // The finish hook and the ledger write land after the answer.
  let j = null;
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${B}/__operator/funnel.json?days=3&fresh=${i}`, { headers: { "x-operator-token": OP } });
    ok(i > 0 || (r.status === 200 && /no-store/.test(r.headers.get("cache-control") || "") && /private/.test(r.headers.get("cache-control") || "") && /x-operator-token/i.test(r.headers.get("vary") || "")), "funnel.json answers the operator, private, no-store, varying on the token");
    j = await r.json();
    if (j?.byDay?.[0]?.sales?.sales >= 3) break;
    await new Promise((s) => setTimeout(s, 1100));
  }
  const today = j?.byDay?.[0];
  const dr = today?.requests?.byArrival?.direct, bzr = today?.requests?.byArrival?.bazaar, mr = today?.requests?.byArrival?.mcp;
  ok(dr && dr.probes >= 2 && dr.attempts === 3 && dr.settled === 1 && dr.refused === 2, `direct: probes, three attempts, one settled, two refused (${JSON.stringify(dr && { p: dr.probes, a: dr.attempts, s: dr.settled, r: dr.refused })})`);
  ok(dr && dr.refusal.wrongNetwork === 1 && dr.refusal.verifyRefused === 1 && dr.reasons["unsupported-network"] === 1 && dr.reasons["malformed-header"] === 1, `refusal classes from the paywall's own reasons (${JSON.stringify(dr && { c: dr.refusal, r: dr.reasons })})`);
  ok(dr && dr.challenges === dr.probes + dr.refused, "402s served = unpaid 402s + refused attempts");
  ok(bzr && bzr.probes === 1 && bzr.settled === 1 && mr && mr.settled === 1, `bazaar and mcp arrivals counted (${JSON.stringify({ bz: bzr && [bzr.probes, bzr.settled], mcp: mr && mr.settled })})`);
  ok(today?.sales?.byArrival?.direct?.sales === 1 && today?.sales?.byArrival?.mcp?.sales === 1 && today?.sales?.byArrival?.bazaar?.sales === 1, `the ledger books each sale's arrival (${JSON.stringify(today?.sales?.byArrival)})`);
  ok(j?.conversion?.direct?.paidAfterProbe === 1 && j?.conversion?.direct?.probedCallers === 1, `the probing caller came back and paid (${JSON.stringify(j?.conversion?.direct)})`);
  ok(j?.week && "repeatShare" in j.week && "organicUsdPerDay" in j.week && j.definitions?.probes, "the weekly figures and the definitions ride along");
  ok(!/0x00000000000000000000000000000000000c/i.test(JSON.stringify(j)) && !/127\.0\.0\.1/.test(JSON.stringify(j)), "no wallet or address in the answer");
  const anon = await fetch(`${B}/__operator/funnel.json`);
  ok(anon.status === 404, "funnel.json is 404 without the operator token");
  const routes = await (await fetch(`${B}/__operator/routes.json`, { headers: { "x-operator-token": OP } })).json();
  ok(JSON.stringify(routes).includes("/__operator/funnel.json"), "routes.json lists it");
  const pub = [await (await fetch(`${B}/api/stats`)).text(), await (await fetch(`${B}/api/gateway-status`)).text(), await (await fetch(`${B}/api/sales`)).text()].join("\n");
  ok(!/probedCallers|neverRetried|paidAfterProbe|refusal"|organicUsdPerDay/.test(pub), "nothing of it reaches a public surface");
} catch (e) {
  ok(false, e?.stack || String(e));
  if (srv) console.error(srv.log().slice(-3000));
}
await srv?.stop();
facilitator.close();
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
