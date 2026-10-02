#!/usr/bin/env node
// A PUBLISHED FIGURE CARRIES ITS OWN SCOPE.
//
// The defect class: a number that is capped, sampled, windowed or filtered,
// served so that a consumer can reasonably read it as a total. The data is
// right and the contract is quiet, so nothing looks broken and the reader
// acts on a figure that means something narrower than it says. This repo has
// shipped it three times that we know of:
//
//   • a LIMIT-20 query's .length published as "tools with any external use",
//     which justified retiring 40 tools and 29 skill packs (eleven of the
//     retired packs had real outside buyers inside the same window);
//   • GET /api/index returning 250 sellers of 4,473 while llms.txt called it
//     "a JSON snapshot of every seller indexed", so a seller's own checker
//     searched page 1, missed itself and reported the listing broken;
//   • retired routes answering a generic 404, which an outside census graded
//     as a broken seller until they became a 410 naming the replacement.
//
// PROSE IN A NOTE DOES NOT COUNT AS STATED - that is what failed twice. The
// scope has to be a field, a header or a status code a machine reads, and it
// has to sit ON the figure rather than somewhere else in the document.
//
// Everything below is behavioural against the real modules, not a source
// grep: a scope that is present but wrong passes a grep and fails here.
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), "a402-scope-")); dirs.push(d); return join(d, p); };

// ---------------------------------------------------------------------------
// 1. A DISTINCT COUNT IS NEVER SUMMED.  src/sales-ledger.js externalByNetwork
//
// The per-rail host card on every chain page reports "N distinct buyers".
// That query grouped by the RAW network and the answer is keyed by the
// CANONICAL rail, so one chain recorded under two spellings ("base" and
// "eip155:8453" - the reason canonRail exists) arrived as two rows and the
// buyers were ADDED. Reproduced on this fixture before the fix: one wallet,
// one rail, two spellings, reported as 2 distinct buyers.
//
// This is the shape we decline to publish about anyone else. A third-party
// index summed a per-resource unique-payer metric across our resources and
// mailed us 701 payers against our real 158; foldBazaarQuality folds payers
// with MAX for exactly this reason, with the reason written beside it.
// ---------------------------------------------------------------------------
{
  process.env.SALES_LEDGER_DB = tmp("sales.db");
  const { recordSale, externalByNetwork, salesSummary } = await import("../src/sales-ledger.js");
  const A = "0x" + "a".repeat(40);
  const B = "0x" + "b".repeat(40);
  recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "eip155:8453", payer: A, tx: "x1" });
  recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: A, tx: "x2" });
  recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: B, tx: "x3" });
  const m = externalByNetwork({ days: 1 });
  ok(m.base.settlements === 3, `settlements still ADD across spellings of one rail (${m.base.settlements})`);
  ok(m.base.buyers === 2, `distinct buyers are counted, not added, across spellings of one rail (${m.base.buyers}, not 3)`);
  ok(m.base.buyers === salesSummary({ days: 1 }).distinctExternalBuyers,
    "the per-rail buyer count agrees with the ledger's own uncapped COUNT(DISTINCT payer)");

  // A payer the chain does not expose still counts as a settlement and never
  // as a buyer - the behaviour COUNT(DISTINCT payer) had, kept exactly.
  recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "solana", payer: null, tx: "s1" });
  const m2 = externalByNetwork({ days: 1 });
  ok(m2.solana.settlements === 1 && m2.solana.buyers === 0,
    "a settlement with no readable payer counts as a settlement and never as a buyer");

  // ---- 2. "ALL TIME" NAMES THE DAY IT STARTS.  src/host-entry.js ----
  //
  // The widest host figure is the whole SALES LEDGER, and the sales ledger is
  // younger than the service. Measured on prod 2026-09-22: the ledger starts
  // 2026-07-03 while /api/stats servingSince reads 2026-06-12 and the lifetime
  // viaUSDC counter stood at 35,947 against 11,825 settlements in the ledger.
  // The card said "11,825 settlements, all time" and named no start, so a
  // reader takes a figure beginning three weeks in as the whole history.
  const { hostFigures, hostCardHtml, hostRowHtml, hostIndexEntry } = await import("../src/host-entry.js");
  const summary = ({ days }) => ({
    recordingSince: Date.parse("2026-07-03T22:45:23.470Z"),
    totals: { external: { sales: days === 30 ? 5032 : 11825 } },
    distinctExternalBuyers: days === 30 ? 222 : 443,
    distinctToolsSoldExternal: days === 30 ? 166 : 554,
  });
  const f = hostFigures({ summaryFn: summary, toolCount: 606, baseUrl: "https://agent402.tools" });
  ok(f.externalAllTime.since === "2026-07-03", "the widest figure carries its own start date as a field");
  ok(f.external30d.windowDays === 30, "the 30-day figure carries its own window as a field");
  const card = hostCardHtml(f), row = hostRowHtml(f);
  ok(card.includes("settlements, since 2026-07-03") && card.includes("distinct buyers, since 2026-07-03"),
    "the marketplace card labels the widest figures with the day they start");
  ok(!/settlements, all time/.test(card) && !/distinct buyers, all time/.test(card),
    "the card no longer calls a ledger-scoped figure 'all time'");
  ok(row.includes("since 2026-07-03"), "the leaderboard host row labels its widest figure the same way");
  ok(card.includes("not lifetime totals") && row.includes("not lifetime totals"),
    "both surfaces say in words that these are not lifetime totals");
  const me = hostIndexEntry(f);
  ok(me.external.allTime.since === "2026-07-03" && typeof me.external.scopeNote === "string" && me.external.scopeNote.includes("2026-07-03"),
    "the JSON answer carries the start INSIDE the allTime object, not only beside it");

  // A ledger that cannot report its own start says nothing rather than
  // guessing a date - the honest failure, and the one a mutation that
  // hardcodes a date would break.
  const blind = hostFigures({ summaryFn: () => ({ totals: { external: { sales: 3 } }, distinctExternalBuyers: 1, distinctToolsSoldExternal: 1 }), toolCount: 1, baseUrl: "https://agent402.tools" });
  ok(blind.externalAllTime.since === null && hostCardHtml(blind).includes("settlements, all time"),
    "an unknown start yields a null `since` and the unqualified label, never an invented date");
  ok(hostIndexEntry(blind).external.scopeNote.includes("not a lifetime total"),
    "even with no start date the JSON refuses to claim a lifetime total");

  // Per-rail figures inherit the same start: the chain pages render this shape.
  const perRail = hostFigures({ summaryFn: summary, byNetworkFn: () => ({ base: { settlements: 5044, buyers: 393 } }), network: "base", networkLabel: "Base", toolCount: 606, baseUrl: "https://agent402.tools" });
  ok(perRail.externalAllTime.since === "2026-07-03" && hostCardHtml(perRail).includes("since 2026-07-03"),
    "a chain page's host card carries the start date too");
}

// ---------------------------------------------------------------------------
// 3. /api/stats SAYS WHAT ITS CAPPED FIGURES CAN AND CANNOT REPORT.
//
// `chargedButFailedGenuine` is a WINDOW: charged_failures is pruned to
// RECENT_KEEP rows, so the figure can never exceed that however many failures
// there were, and it is not a lifetime count. It was published as a bare 0
// beside a lifetime counter under a note calling it "current quality".
// ---------------------------------------------------------------------------
{
  process.env.STATS_ALLOW_EPHEMERAL = "true";
  process.env.STATS_DB_DIR = tmp("");
  const { getStats } = await import("../src/stats.js");
  const s = getStats({ wallet: "0x1", network: "base", toolCount: 3, baseUrl: "http://x", prices: {} });
  const sc = s.chargedButFailedGenuineScope;
  ok(sc && Number.isFinite(sc.maxReportable) && sc.maxReportable > 0,
    `chargedButFailedGenuine states the ceiling it can never exceed (${sc?.maxReportable})`);
  ok(Number.isFinite(sc.eventsRetained) && /not all time/i.test(sc.of),
    "it states how many events it is measured over, and that it is not all time");
  ok(s.chargedButFailedGenuine <= sc.maxReportable, "the figure is within the ceiling it publishes");
  ok(/WINDOW/.test(s.chargedButFailedNote) && s.chargedButFailedNote.includes(String(sc.maxReportable)),
    "the note beside it names the window rather than calling it current quality full stop");
  // The cut must be the REAL cut and the population the REAL population, or
  // the field is decoration: drive enough distinct tools past the limit and
  // check the list stops at it while the population figure does not.
  const { recordServedCall } = await import("../src/stats.js");
  for (let i = 0; i < 14; i++) recordServedCall(`scope-tool-${i}`, "pow");
  const s2 = getStats({ wallet: "0x1", network: "base", toolCount: 3, baseUrl: "http://x", prices: {} });
  ok(s2.topTools.length === s2.topToolsScope.limit,
    `topTools returns exactly its published limit once there are more tools than the cut (${s2.topTools.length})`);
  ok(s2.topToolsScope.toolsWithAnyCalls > s2.topToolsScope.limit,
    `the population it was cut from is published and is larger than the cut (${s2.topToolsScope.toolsWithAnyCalls} > ${s2.topToolsScope.limit})`);
  ok(s2.recentCalls.length <= s2.recentCallsScope.shown && /not a period total/i.test(s2.recentCallsScope.of)
    && s2.recentCallsScope.retainedMax >= s2.recentCallsScope.shown,
    "recentCalls says it is a feed of retained rows, never a period total, and the two bounds are consistent");
  ok(/TODAY/.test(s.estimatedRevenueNote) && /Card/.test(s.estimatedRevenueNote),
    "estimatedRevenueUsd says it is valued at today's prices and excludes the non-USDC rails");
}

// ---------------------------------------------------------------------------
// 4. TWO "buyers" FIELDS, TWO POPULATIONS, BOTH STATED.
//
// /api/revenue/daily serves concentration.buyers and retention.buyers side by
// side. On prod 2026-09-22 they read 495 and 496 - identically named, one
// apart, neither saying why: concentration starts at REVENUE_DAILY_START and
// retention is deliberately all-time. A third figure, the host entry's
// allTime.buyers, read 443 the same day over a different source again.
// ---------------------------------------------------------------------------
{
  process.env.REVENUE_LEDGER_DB = tmp("ledger.db");
  process.env.REVENUE_DAILY_START = "2026-06-15";
  const { recordTransfer, ledgerBuyerConcentration, ledgerBuyerRetention } = await import("../src/revenue-ledger.js");
  const W = "0xwallet";
  const at = (d) => Math.floor(Date.parse(`${d}T12:00:00Z`) / 1000);
  let n = 0;
  const give = (d, payer) => recordTransfer({ chain: "base", wallet: W, txid: `t${++n}`, tx_hash: `0x${n}`, block: 1000 + n, when_ts: at(d), payer, usd: 0.01, asset: "USDC", external: 1 });
  give("2026-06-01", "0xearly");            // before the chart epoch
  give("2026-07-01", "0xone");
  give("2026-07-02", "0xone");
  give("2026-08-01", "0xtwo");
  const wallets = { walletAddress: W };
  const conc = ledgerBuyerConcentration(wallets);
  const ret = ledgerBuyerRetention(wallets);
  ok(conc.scope?.since === "2026-06-15", `concentration names the epoch its count starts at (${conc.scope?.since})`);
  ok(ret.scope?.since === null, "retention says it is all-time by carrying a null start rather than borrowing the epoch");
  ok(conc.buyers === 2 && ret.buyers === 3,
    `the two figures really are different populations (${conc.buyers} vs ${ret.buyers}) - which is why both must say so`);
  for (const [name, o] of [["concentration", conc], ["retention", ret]]) {
    ok(Array.isArray(o.scope?.excludes) && o.scope.excludes.some((e) => /card/i.test(e)) && o.scope.excludes.some((e) => /payer/i.test(e)),
      `${name} names what its source cannot see (card/credits buyers, payerless settlements)`);
    ok(/floor/i.test(o.scope?.note || ""), `${name} says outright that it is a floor, not a total`);
  }
  // An empty ledger must not drop the scope: a zero with no scope is the same
  // defect, and it is the shape a cold boot serves.
  process.env.REVENUE_LEDGER_DB = tmp("empty.db");
  const url = new URL("../src/revenue-ledger.js", import.meta.url);
  const fresh = await import(`${url.href}?empty=1`);
  const e = fresh.ledgerBuyerConcentration({ walletAddress: "0xnobody" });
  ok(e.buyers === 0 && e.scope?.since === "2026-06-15", "an empty result still carries its scope");
}

// ---------------------------------------------------------------------------
// 5. THE PAGE THAT RENDERS THE WALLET COUNT READS THE SCOPE.
//
// Pinned from source because the alternative is a human retyping the date
// into the copy, which is how a derived figure and its caption drift apart.
// ---------------------------------------------------------------------------
{
  const src = await readFile(new URL("../src/revenue-live.js", import.meta.url), "utf8");
  const hero = src.slice(src.indexOf("distinct agent"), src.indexOf("distinct agent") + 400);
  ok(/scope\?\.since/.test(hero), "/revenue's wallet-count caption reads scope.since rather than a typed date");
  ok(/paid us on-chain/.test(hero), "/revenue says the wallet count is on-chain, not simply 'have paid us'");
  ok(/floor, not a lifetime total/.test(src), "/revenue says in words what the wallet count cannot see");
}

// ---------------------------------------------------------------------------
// 6. /api/leaderboard's TOTAL COUNTS THE POPULATION ITS ROWS CAME FROM.
//
// `totalSellers` counted the UNFILTERED board while `leaderboard` was the
// filtered one, so on the DEFAULT include=external a consumer comparing "rows
// I got" against "rows there are" compared two populations and could not tell.
// ---------------------------------------------------------------------------
{
  const src = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("leaderboard: board.slice(0, top)"), src.indexOf("leaderboard: board.slice(0, top)") + 900);
  ok(/totalSellers: board\.length/.test(block), "totalSellers counts the filtered population the rows came from");
  ok(/totalSellersUnfiltered/.test(block), "the unfiltered board is still published, under its own name");
  ok(/moreRowsAvailable: board\.length > top/.test(block), "the answer says whether rows exist beyond the page served");
  ok(!/\btruncated: board\.length > top/.test(block),
    "`truncated` keeps its one existing meaning (?top was clamped) - two meanings on one field is the defect, not the fix");
}

// ---------------------------------------------------------------------------
// 7. A CAPPED LEADERBOARD SCAN IS A SAMPLE AND SAYS SO.
// ---------------------------------------------------------------------------
{
  const src = await readFile(new URL("../src/leaderboard.js", import.meta.url), "utf8");
  ok(/sellersSampled: true/.test(src) && /unmeasured, not zero/.test(src),
    "a MAX_WALLETS_SCAN-capped scan flags itself as a sample and says an omitted seller is unmeasured, not zero");
}


// ---------------------------------------------------------------------------
// 8. A RANKING SAYS HOW MANY MATCHED, not just how many it handed back.
//
// `count: 5` against a 600-row catalog and `sellers: 16` against a page of 25
// are both "what this answer carries" published under a name a reader takes
// for the population - the 250-of-4,473 shape, one field over. Behavioural
// against the real ranker, and every query below is chosen so that matched is
// STRICTLY greater than the cap: on a narrow query `matched: results.length`
// is indistinguishable from the correct value, so a passing assertion there
// would prove nothing.
// ---------------------------------------------------------------------------
{
  const { findTools, FIND_TOP_MAX } = await import("../src/find.js");
  const catalog = {};
  for (let i = 0; i < 40; i++) {
    catalog[`GET /api/crypto-${i}`] = {
      route: `GET /api/crypto-${i}`, slug: `crypto-${i}`, name: `Crypto tool ${i}`,
      category: "crypto", price: "$0.001", description: "crypto price data for a token",
      tags: ["crypto", "price"], discovery: { inputSchema: { properties: {}, required: [] }, input: {} },
      handler: () => ({}),
    };
  }
  const r = findTools(catalog, "crypto", { k: 5 });
  ok(r.count === 5, `count is what the answer carries (${r.count})`);
  ok(r.matched >= 20, `matched is how many scored, not how many were returned (${r.matched})`);
  ok(r.matched > r.count, "the two are different numbers on a query wider than the cap");
  ok(r.complete === false && r.truncated === true, "and the answer says it is a part");

  // The clamp has to announce itself: ?k=500 answering 25 rows in silence
  // reads as "there are only 25".
  const big = findTools(catalog, "crypto", { k: 500 });
  ok(big.requestedExceededMax === true && big.requestedMax === 500,
    "a k above the ceiling is reported as clamped, not silently honoured");
  ok(big.count <= FIND_TOP_MAX, `and the ceiling actually binds (${big.count} <= ${FIND_TOP_MAX})`);
  // Asserting the UNCLAMPED case alone would pass against a stub that always
  // returns {} - so it is asserted only beside the clamped one above.
  ok(findTools(catalog, "crypto", { k: 5 }).requestedExceededMax === undefined,
    "...and nothing is claimed when nothing was clamped");

  // The miss carries the same shape as the hit: presence of the keys, never
  // their values - partialFields(0,0) gives complete:true, which is also the
  // pre-fix default and so proves nothing on its own.
  const miss = findTools(catalog, "", { k: 5 });
  ok("matched" in miss && "returned" in miss && "complete" in miss,
    "the empty answer carries the same envelope as a hit");
}

// ---------------------------------------------------------------------------
// 9. THE ROUTER'S DIVERSITY CAP REORDERS THE RANKING, and says so.
//
// perSellerCap suppresses higher-scoring rows so one domain cannot own the
// shortlist (a real registry measured one owning 77.5%). That is a deliberate
// reordering a caller cannot see and would never infer from a ranking, so a
// seller can be routable, score above the rows you got, and be absent.
// ---------------------------------------------------------------------------
{
  const src = await readFile(new URL("../src/x402-index.js", import.meta.url), "utf8");
  const ret = src.slice(src.indexOf("query: q, include: inc, count: results.length"),
                        src.indexOf("query: q, include: inc, count: results.length") + 1400);
  ok(/sellersMatched: sellersScored\.size/.test(ret),
    "sellersMatched counts sellers that MATCHED, never the origins present in this page");
  ok(!/sellersMatched: sellersSeen\.size/.test(ret),
    "...and is not the page-local count wearing the new name");
  ok(/partialFields\(scored\.length, results\.length\)/.test(ret),
    "matched is fed from the scored set, not from the rows returned");
  ok(/count: results\.length, sellers: sellersSeen\.size/.test(ret),
    "`count` and `sellers` keep their exact existing meaning - a live field rename is a second, worse break");
  const decl = src.slice(src.indexOf("const diversityCapped"), src.indexOf("const diversityCapped") + 200);
  ok(/capApplies && leftover\.length > 0/.test(decl),
    "diversityCapped is true exactly when a row was pushed down for its seller rather than its score");
  ok(/diversityNote: `at most \$\{perSellerCap\}/.test(ret),
    "...and the note names the cap that did it, so the caller can raise ?top");
}

// ---------------------------------------------------------------------------
// 10. A FILTERED SERIES NAMES WHAT IT DROPPED.  src/revenue-ledger.js
//
// /api/revenue/daily drops undateable rows, internal transfers over
// maxCallUsd and everything before the chart epoch, then /revenue headlines it
// as "every settled on-chain transaction, ours included". Measured on prod
// 2026-09-22 the days summed $92.89 short of /api/revenue's own allTime, 24 of
// the missing rows real outside customers, with nothing in either response to
// reconcile them.
//
// The clean-ledger leg and the dropped-row leg are written together on
// purpose: `complete: true` on a clean ledger is also what a hardcoded `true`
// gives, so neither leg is believable without the other.
// ---------------------------------------------------------------------------
{
  process.env.REVENUE_LEDGER_DB = tmp("rev.db");
  process.env.REVENUE_DAILY_START = "2026-06-15";
  // A fresh module instance bound to the fresh db - the same cache-busting
  // import section 4 uses. A plain re-import returns the cached module still
  // holding the previous section's database, and the rows below would be
  // written somewhere this read cannot see.
  const revUrl = new URL("../src/revenue-ledger.js", import.meta.url);
  const { recordTransfer, ledgerDaily } = await import(`${revUrl.href}?daily=1`);
  const W = "0x" + "c".repeat(40);
  const day = (d) => Math.floor(Date.parse(`${d}T12:00:00Z`) / 1000);
  const wallets = { algorandWallet: W };
  const tx = (o) => recordTransfer({ chain: "algorand", wallet: W, asset: "USDC", ...o });
  tx({ txid: "t1", tx_hash: "t1", block: 10, when_ts: day("2026-07-01"), usd: 0.01, external: true });
  const clean = ledgerDaily(wallets, null, { withScope: true });
  ok(clean.scope.complete === true, "a ledger with nothing dropped reports complete");
  ok(clean.scope.excluded.beforeSeriesStart.transactions === 0
     && clean.scope.excluded.internalOverMaxCallUsd.transactions === 0
     && clean.scope.excluded.undateable.transactions === 0, "...and every excluded bucket is zero");
  ok(clean.scope.recordingSince === "2026-07-01", `...and recordingSince is the ledger's own first day (${clean.scope.recordingSince})`);

  tx({ txid: "t2", tx_hash: "t2", block: 2, when_ts: day("2026-05-01"), usd: 0.02, external: true });   // pre-epoch
  tx({ txid: "t3", tx_hash: "t3", block: 11, when_ts: day("2026-07-02"), usd: 5.00, external: false });  // internal over cap
  tx({ txid: "t4", tx_hash: "t4", block: null, when_ts: null, usd: 0.03, external: true });              // undateable
  const d = ledgerDaily(wallets, null, { withScope: true });
  ok(d.scope.complete === false, "one dropped row makes the series incomplete");
  ok(d.scope.excluded.beforeSeriesStart.transactions === 1, `pre-epoch rows are counted (${d.scope.excluded.beforeSeriesStart.transactions})`);
  ok(d.scope.excluded.internalOverMaxCallUsd.transactions === 1
     && d.scope.excluded.internalOverMaxCallUsd.usd === 5,
     "an internal transfer over maxCallUsd is named as funding, not silently missing");
  ok(typeof d.scope.excluded.internalOverMaxCallUsd.maxCallUsd === "number",
     "...beside the threshold that excluded it");
  ok(d.scope.excluded.undateable.transactions === 1, `undateable rows are counted (${d.scope.excluded.undateable.transactions})`);
  ok(/will not reconcile/.test(d.scope.note), "...and the note says the two totals will not reconcile without it");
  // The whole point: days + excluded accounts for every external row.
  const shown = d.days.reduce((a, b) => a + b.extTx, 0);
  const accounted = shown + d.scope.excluded.beforeSeriesStart.transactions + d.scope.excluded.undateable.transactions;
  ok(accounted === 3, `every external row is either shown or named as excluded (${shown} shown + ${d.scope.excluded.beforeSeriesStart.transactions} pre-epoch + ${d.scope.excluded.undateable.transactions} undateable = ${accounted}, of 3)`);
  // The bare-array contract every other caller relies on is unchanged.
  ok(Array.isArray(ledgerDaily(wallets)), "without withScope the function still returns the bare array");
}

// ---------------------------------------------------------------------------
// 11. THE HANDLER PUBLISHES THE SCOPE, and the homepage stopped claiming the
//     whole board over a band that renders twelve rows.
// ---------------------------------------------------------------------------
{
  const srv = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  // The series is built by buildRevenueDaily (split across turns) and served by the route.
  const h = srv.slice(srv.indexOf("async function buildRevenueDaily()"), srv.indexOf("async function buildRevenueDaily()") + 1600) + srv.slice(srv.indexOf('app.get("/api/revenue/daily"'), srv.indexOf('app.get("/api/revenue/daily"') + 1200);
  ok(/withScope: true/.test(h) && /daysScope: daily\.scope/.test(h),
    "/api/revenue/daily publishes the scope object rather than the bare array");

  const home = await readFile(new URL("../src/ledger-home.js", import.meta.url), "utf8");
  ok(!/Every x402 seller we can crawl/i.test(home),
    "the homepage no longer claims the whole board over a band that renders twelve rows");
  ok(/head of the board/.test(home),
    "...and uses the same sentence /leaderboard does, so one shape is swept, not two");
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
