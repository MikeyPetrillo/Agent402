#!/usr/bin/env node
// Offline: a referral sale (a /ref/<slug> sale booked on the private rail
// "referral", src/paid-rails.js) is a sale of its tool in every sales figure:
// counted once, as an outside sale, under its slug, at what its buyer paid,
// never at the net (the commission is nobody's to read), and never named.
// The on-chain buyer figures name the buyer behind the split contract's
// payout. The operator's reconciliation matches a seeded book and ledger.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-refcount-"));
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
process.env.REVENUE_LEDGER_DB = join(dir, "ledger.db");
process.env.STATS_DB_DIR = dir;
process.env.REVENUE_DAILY_START = "2026-01-01";
const ROUTER = "0x" + "5e".repeat(20);
process.env.REFERRAL_PAY_TO = ROUTER;

const ledger = await import("../src/sales-ledger.js");
const { recordSale, salesSummary, externalSlugWindow, topByBuyers, externalByNetwork, buyerScorecard, externalDailyRevenue, payerHasPaidSale, privateRailSlugWindow, claimedSettlements, proofFeed, payerReceipts } = ledger;
const { recordTransfer, ledgerBuyerConcentration, ledgerSummary } = await import("../src/revenue-ledger.js");
const { recordReferralAnswer, referralAnswersByDay } = await import("../src/stats.js");
const { referralReconciliation, reconcileDays } = await import("../src/referral-reconcile.js");
const { createReferralBook } = await import("../src/referral-book.js");
const { createJsonDocument } = await import("../src/json-document.js");
const { paidExternalSettlements } = await import("../src/host-entry.js");
const { isCountedRail, isPaidRail, publicRailName } = await import("../src/paid-rails.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20), OURS = "0x" + "d4".repeat(20);
const T1 = "0x" + "11".repeat(32), T2 = "0x" + "22".repeat(32), T3 = "0x" + "33".repeat(32), T4 = "0x" + "44".repeat(32), TD = "0x" + "dd".repeat(32);
// One direct sale; two outside referral sales (net below gross); one of ours through the referral copy.
recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: A, tx: TD, synthetic: false });
recordSale({ slug: "hash", priceUsd: 0.00075, quoteUsd: 0.001, rail: "referral", wire: "referral", network: "base", payer: B, tx: T1, synthetic: false });
recordSale({ slug: "whois", priceUsd: 0.0075, quoteUsd: 0.01, rail: "referral", wire: "referral", network: "base", payer: C, tx: T2, synthetic: false });
recordSale({ slug: "whois", priceUsd: 0.0075, quoteUsd: 0.01, rail: "referral", wire: "referral", network: "base", payer: OURS, tx: T3, synthetic: true });
const GROSS_EXT = 0.001 + 0.001 + 0.01;

// --- the rail sets ---
ok(isCountedRail("referral") && !isPaidRail("referral") && isCountedRail("usdc") && !isCountedRail("pow") && publicRailName("referral") === "marketplace" && publicRailName("usdc") === "usdc", "referral is a counted rail, never a paying one, and a public figure names it marketplace");

// --- the public summary ---
const sum = salesSummary({ days: 30 });
const text = JSON.stringify(sum);
ok(sum.totals.external.sales === 3 && near(sum.totals.external.revenueUsd, +GROSS_EXT.toFixed(4)), `the summary counts each outside referral sale once, at the gross (${sum.totals.external.sales} sales, $${sum.totals.external.revenueUsd})`);
ok(sum.totals.byRail["external:marketplace"] === 2 && sum.totals.byRail["external:usdc"] === 1 && sum.totals.byRail["internal:marketplace"] === 1 && !/referral/.test(text), `its rail split names the marketplace, never the private rail (${JSON.stringify(sum.totals.byRail)})`);
ok(!/0\.00075|0\.0075/.test(text) && sum.totals.internal.sales === 1, "no net amount reaches the summary, and our own referral buy is internal");
ok(sum.distinctExternalBuyers === 3 && sum.distinctToolsSoldExternal === 2, `distinct outside buyers and tools include the referral buyers (${sum.distinctExternalBuyers} buyers, ${sum.distinctToolsSoldExternal} tools)`);
ok(paidExternalSettlements(sum) === 3, `the host entry's settlement count includes them (${paidExternalSettlements(sum)})`);
const det = salesSummary({ days: 30, detailed: true });
const opHash = det.topExternal.find((r) => r.slug === "hash");
ok(opHash?.sales === 2 && near(opHash.revenueUsd, 0.002) && det.recentExternal.filter((r) => r.rail === "referral").every((r) => r.priceUsd === 0.001 || r.priceUsd === 0.01), `the operator's detailed view ranks it under its slug at the gross (${JSON.stringify(opHash)})`);

// --- rankings, bestsellers, per-network, scorecard ---
const win = Object.fromEntries(externalSlugWindow(0, Date.now() + 1000).map((r) => [r.slug, r]));
ok(win.hash?.sales === 2 && near(win.hash.revenue, 0.002) && win.hash.buyers === 2 && win.whois?.sales === 1 && near(win.whois.revenue, 0.01), `the bestsellers feed counts it under its slug at the gross (hash ${win.hash?.sales}/$${win.hash?.revenue}, whois ${win.whois?.sales}/$${win.whois?.revenue})`);
const top = topByBuyers({ days: 30, limit: 10 });
ok(top.some((r) => r.slug === "whois" && r.buyers === 1 && near(r.revenueUsd, 0.01)) && top.find((r) => r.slug === "hash")?.buyers === 2, `the buyers ranking counts the referral buyer (${JSON.stringify(top)})`);
const net = externalByNetwork({ days: 30 });
ok(net.base?.settlements === 3 && net.base?.buyers === 3, `the per-network split counts it on Base (${JSON.stringify(net)})`);
const sc = buyerScorecard({ months: 2, minGroup: 1 });
const scCalls = sc.months.reduce((a, m) => a + m.calls, 0), scUsd = sc.months.reduce((a, m) => a + m.usd, 0);
ok(scCalls === 3 && near(+scUsd.toFixed(4), +GROSS_EXT.toFixed(4)) && sc.months.reduce((a, m) => a + m.wallets, 0) === 3, `the scorecard counts it once at the gross (${scCalls} calls, $${scUsd})`);

// --- readers that stay on the direct routes ---
ok(payerHasPaidSale(B) === false && payerHasPaidSale(A) === true, "a referral buyer is not a direct paying buyer to the allowance and gate logic");
ok(claimedSettlements(0, Date.now() + 1000).every((r) => r.tx === TD) && proofFeed({ slug: "hash" }).external.count === 1, "the settle reconciliation against the chain and the metered proof feed read the direct sale only");
ok(payerReceipts(B.toLowerCase()).rows.length === 1 && payerReceipts(B.toLowerCase()).rows[0].amountUsd === 0.001, "the buyer's own receipts still show the gross, once");

// --- the operator margin view reads what reached us ---
const daily = externalDailyRevenue({ days: 30 });
const dailyUsd = daily.reduce((a, r) => a + r.revenueUsd, 0), dailySales = daily.reduce((a, r) => a + r.sales, 0);
ok(dailySales === 3 && near(+dailyUsd.toFixed(6), +(0.001 + 0.00075 + 0.0075).toFixed(6)), `the operator's margin revenue counts the net received (${dailySales} sales, $${dailyUsd})`);

// --- the on-chain buyer figures: the buyer behind the split contract ---
{
  const WALLET = "0x" + "77".repeat(20);
  const when = Math.floor(Date.now() / 1000) - 3600;
  let seq = 0;
  const give = (payer, tx, usd) => recordTransfer({ chain: "base", wallet: WALLET, txid: `r${++seq}`, tx_hash: tx, block: 5000 + seq, when_ts: when, payer, usd, asset: "USDC", external: 1 });
  give(A, TD, 0.001); // the direct sale
  give(ROUTER, T1, 0.00075); // the contract's payout for B's sale
  give(ROUTER, T2, 0.0075); // for C's
  give(ROUTER, T3, 0.0075); // for our own buy
  give(ROUTER, T4, 0.0075); // a payout with no sale booked yet
  const wallets = { walletAddress: WALLET };
  const conc = ledgerBuyerConcentration(wallets);
  ok(conc.buyers === 3 && conc.payments === 3, `the split contract is never a buyer: the payouts count as the buyers booked behind them, our own buy is left out, an unbooked one is unattributed (${conc.buyers} buyers over ${conc.payments} attributed payments)`);
  const ls = ledgerSummary(wallets);
  ok(ls.allTimeExternalCount === 5 && ls.tempoExternal.count === 0, `the on-chain total counts each payout once as it landed, and nothing is folded in again from the sales ledger (${ls.allTimeExternalCount} external, tempo ${ls.tempoExternal.count})`);
}

// --- the operator reconciliation against a seeded book ---
{
  const book = createReferralBook({ doc: createJsonDocument({ name: `refcount-${process.pid}`, file: join(dir, "book.json"), log: () => {} }), log: { log() {}, warn() {}, error() {} } });
  const soon = Math.floor(Date.now() / 1000) + 600;
  const put = (key, slug, state) => book.intent({ key, slug, payer: B, nonce: "0x" + key.padStart(64, "0"), amount: "1000", validBefore: soon }).then(() => (state ? book.resolve(key, { state }) : true));
  await put("e1", "hash", "charged-undelivered");
  await put("e2", "hash", "unconfirmed");
  await put("e3", "whois", "in-doubt");
  await put("e4", "whois", null);
  await book.noteSold("s1", { tx: T1, payer: B, slug: "hash" });
  await book.noteSold("s2", { tx: T2, payer: C, slug: "whois" });
  for (let i = 0; i < 3; i++) recordReferralAnswer("hash");
  recordReferralAnswer("whois");
  const days = reconcileDays(undefined);
  const now = Date.now() + 1000;
  const since = now - days * 86_400_000;
  const r = referralReconciliation({
    days, now, slugs: ["hash", "whois", "vin-decode"],
    served: referralAnswersByDay(new Date(since).toISOString().slice(0, 10), new Date(now).toISOString().slice(0, 10)),
    sales: privateRailSlugWindow("referral", since, now),
    open: book.list(), sold: book.soldMarks(),
  });
  const row = (s) => r.tools.find((t) => t.slug === s);
  const h = row("hash"), w = row("whois"), v = row("vin-decode");
  ok(days === 30 && reconcileDays("7") === 7 && reconcileDays("0") === 1 && reconcileDays("999") === 90 && r.window.days === 30, "the window defaults to 30 days and is bounded");
  ok(h.served === 3 && h.booked.sales === 1 && h.booked.external === 1 && near(h.booked.grossUsd, 0.001) && near(h.booked.netUsd, 0.00075) && h.servedMinusBooked === 2, `hash: 3 answers served against 1 sale booked, gross and net (${JSON.stringify(h)})`);
  ok(h.book.open === 2 && h.book.charged === 1 && h.book.unconfirmed === 1 && h.book.settled === 1, `hash: the book's charged, unconfirmed and settled entries (${JSON.stringify(h.book)})`);
  ok(w.served === 1 && w.booked.sales === 2 && w.booked.external === 1 && w.booked.internal === 1 && w.booked.payers === 2 && w.book.inDoubt === 1 && w.book.intent === 1 && w.book.settled === 1 && w.servedMinusBooked === -1, `whois: one served against two booked (one ours), an in-doubt and an intent entry (${JSON.stringify(w)})`);
  ok(v && v.served === 0 && v.booked.sales === 0 && v.book.open === 0, "a listed tool with nothing in the window is still listed, at zero");
  ok(r.totals.served === 4 && r.totals.booked.sales === 3 && near(r.totals.booked.grossUsd, 0.021) && r.totals.book.open === 4 && r.totals.book.settled === 2 && !("payers" in r.totals.booked) && JSON.stringify(r.attention.sort()) === JSON.stringify(["hash", "whois"]), `the totals add the tools (distinct payers excepted) and the mismatches are named (${JSON.stringify(r.totals)})`);
  const old = referralReconciliation({ days: 1, now: now + 3 * 86_400_000, slugs: [], served: {}, sales: {}, open: book.list(), sold: book.soldMarks() });
  ok(old.totals.book.open === 0 && old.totals.book.settled === 0, "entries opened before the window are not counted in it");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
