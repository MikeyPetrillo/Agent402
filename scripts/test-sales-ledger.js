// Sales ledger — offline unit tests. Throwaway DB via SALES_LEDGER_DB (set
// BEFORE import), no network: exercises the internal/external classification
// (synthetic flag, heartbeat rail, burner payer), the revenue math (money
// rails only — PoW counts as usage, never revenue), the merchant summary
// shape, and the settle-receipt tx parser.
//
// The accounting tests read the ITEMIZED shape (detailed:true) because that is
// where the per-tool and per-payer rows live. The last block is a LEAK test on
// the DEFAULT (public) shape - it must stay aggregate-only.
//
//   node scripts/test-sales-ledger.js
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-sales-"));
process.env.SALES_LEDGER_DB = join(dir, "test-sales.db");
const { recordSale, salesSummary, externalByNetwork, topByBuyers, txFromPaymentResponse, mppTxHashes, mppSales, cardSales } = await import("../src/sales-ledger.js");
const { OUR_EVM_WALLETS } = await import("../src/revenue-live.js");

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

const BUYER = "0xDeaDBeef00000000000000000000000000000001"; // checksummed on purpose — must match lowercased
const BURNER = [...OUR_EVM_WALLETS][0];

// --- empty ledger ----------------------------------------------------------------
let s = salesSummary({ detailed: true });
ok(s.totals.external.sales === 0 && s.topExternal.length === 0 && s.recordingSince === null, "empty ledger → zero totals, null since");

// --- external USDC sale ------------------------------------------------------------
recordSale({ slug: "code-run-pro", priceUsd: 0.05, rail: "usdc", network: "base", payer: BUYER, tx: "0xabc", synthetic: false });
s = salesSummary({ detailed: true });
ok(s.totals.external.sales === 1 && s.totals.external.revenueUsd === 0.05, `external usdc sale counts as revenue (got $${s.totals.external.revenueUsd})`);
ok(s.topExternal[0]?.slug === "code-run-pro" && s.topExternal[0]?.sales === 1, "top external names the slug");
ok(s.recentExternal[0]?.payer === BUYER.toLowerCase() && s.recentExternal[0]?.tx === "0xabc", "recent sale keeps lowercased payer + settle tx");

// --- internal classification: synthetic, heartbeat rail, burner payer -------------
recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: BUYER, tx: null, synthetic: true });
recordSale({ slug: "hash", priceUsd: 0.001, rail: "heartbeat", network: null, payer: null, tx: null, synthetic: false });
recordSale({ slug: "stock-quote", priceUsd: 0.01, rail: "usdc", network: "base", payer: BURNER.toUpperCase().replace("0X", "0x"), tx: "0xdef", synthetic: false });
s = salesSummary({ detailed: true });
ok(s.totals.internal.sales === 3, `synthetic + heartbeat + burner-payer all classify internal (got ${s.totals.internal.sales})`);
ok(s.totals.external.sales === 1, "none of them leaked into external");
ok(!s.topExternal.some((r) => r.slug === "stock-quote"), "burner (canary-style) buy never appears in top external");

// --- PoW is usage, not revenue ------------------------------------------------------
recordSale({ slug: "qr", priceUsd: 0.001, rail: "pow", network: null, payer: null, tx: null, synthetic: false });
s = salesSummary({ detailed: true });
ok(s.totals.external.sales === 2 && s.totals.external.revenueUsd === 0.05, "pow adds a sale but not revenue");
ok(!s.topExternal.some((r) => r.slug === "qr"), "topExternal is money rails only");
ok(s.totals.byRail["external:pow"] === 1, "rail split exposes pow usage");

// --- marketplace rail is revenue ----------------------------------------------------
recordSale({ slug: "search", priceUsd: 0.02, rail: "marketplace", network: null, payer: null, tx: null, synthetic: false });
s = salesSummary({ detailed: true });
ok(s.totals.external.revenueUsd === 0.07, `marketplace revenue counts (got $${s.totals.external.revenueUsd})`);

// --- repeat buyers ------------------------------------------------------------------
recordSale({ slug: "tts", priceUsd: 0.05, rail: "usdc", network: "base", payer: BUYER, tx: "0x123", synthetic: false });
s = salesSummary({ detailed: true });
ok(s.repeatBuyers[0]?.payer === BUYER.toLowerCase() && s.repeatBuyers[0]?.sales === 2 && s.repeatBuyers[0]?.revenueUsd === 0.1,
  `repeat buyer aggregates by wallet (got ${JSON.stringify(s.repeatBuyers[0])})`);

// --- never throws on garbage --------------------------------------------------------
recordSale({});
recordSale({ slug: null, priceUsd: NaN, rail: undefined, payer: 42, tx: {}, synthetic: null });
s = salesSummary({ detailed: true });
ok(true, "garbage input never throws");
ok(s.totals.external.sales >= 2, "ledger still readable after garbage rows");

// --- days window: old rows age out of the aggregations ------------------------------
{
  const Database = (await import("better-sqlite3")).default;
  const raw = new Database(process.env.SALES_LEDGER_DB);
  raw.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal) VALUES (?,?,?,?,?,?,?,0)")
    .run(Date.now() - 40 * 86_400_000, "ancient-tool", 0.9, "usdc", "base", "0x" + "1".repeat(40), "0xold");
  raw.close();
  s = salesSummary({ days: 30, detailed: true });
  ok(!s.topExternal.some((r) => r.slug === "ancient-tool"), "40-day-old sale is outside the 30d window");
  const wide = salesSummary({ days: 90, detailed: true });
  ok(wide.topExternal.some((r) => r.slug === "ancient-tool"), "…but inside a 90d window");
}

// --- topByBuyers: distinct verified wallets per tool (the /index demand widget) -----
{
  const P1 = "0x1111111111111111111111111111111111111111";
  const P2 = "0x2222222222222222222222222222222222222222";
  recordSale({ slug: "dns-lookup", priceUsd: 0.005, rail: "usdc", network: "base", payer: P1, tx: "0xa1", synthetic: false });
  recordSale({ slug: "dns-lookup", priceUsd: 0.005, rail: "usdc", network: "base", payer: P1, tx: "0xa2", synthetic: false }); // repeat: same wallet
  recordSale({ slug: "dns-lookup", priceUsd: 0.005, rail: "usdc", network: "base", payer: P2, tx: "0xa3", synthetic: false });
  recordSale({ slug: "dns-lookup", priceUsd: 0.005, rail: "usdc", network: "base", payer: BURNER, tx: "0xa4", synthetic: false }); // internal: must not count
  const buyers = topByBuyers({ days: 30, limit: 8 });
  const dns = buyers.find((r) => r.slug === "dns-lookup");
  ok(dns && dns.buyers === 2 && dns.sales === 3, `distinct buyers counts unique wallets, excludes burner (got ${JSON.stringify(dns)})`);
  ok(buyers[0]?.slug === "dns-lookup", "ranked by distinct buyers desc (dns-lookup leads with 2)");
  ok(!buyers.some((r) => r.buyers === 0), "no zero-buyer rows");
  ok(!buyers.some((r) => r.slug === "search" || r.slug === "qr"), "payer-null sales (marketplace/pow) excluded from the buyer ranking");
}

// --- MPP wire -> tx hashes (the join key for the revenue chart's wire filter) -------
{
  const MPP_PAYER = "0x1111111111111111111111111111111111111111";
  const H_MPP = "0xAbCdEf0000000000000000000000000000000000000000000000000000000001"; // mixed-case hex, as an explorer renders it
  const H_SOL = "5Kd3NBUAdUnhyzhWCbNCcMzTPFtLBUAdUnhyzhWCbNCc"; // base58: case-SENSITIVE, must stay verbatim
  recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "base", payer: MPP_PAYER, tx: H_MPP, synthetic: false, wire: "mpp" });
  recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "solana", payer: null, tx: H_SOL, synthetic: false, wire: "mpp" });
  recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "base", payer: MPP_PAYER, tx: "0x0402", synthetic: false, wire: "x402" });
  recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "base", payer: MPP_PAYER, tx: "0x0f00", synthetic: false });
  const hashes = mppTxHashes();
  ok(hashes.has(H_MPP) && hashes.has(H_SOL), "MPP-wire sales expose their tx hashes");
  ok(!hashes.has("0x0402"), "x402-wire sales are excluded");
  ok(!hashes.has("0x0f00"), "sales recorded before the wire column (null wire) are excluded");
  // EVM hex is case-insensitive, so both forms join; base58 is NOT, so it is
  // never case-folded (a lowercased Solana signature is a different signature).
  ok(hashes.has(H_MPP.toLowerCase()), "EVM hashes are carried in lowercase form too");
  ok(!hashes.has(H_SOL.toLowerCase()), "base58 signatures are never lowercased");
  ok(mppSales({ limit: 10 }).count === 2, "mppSales agrees with the hash set");
}

// --- MPP wire includes "mpp-tempo" too (regression lock: qMppRecent/qMppTx
// originally hardcoded wire = 'mpp' only, silently excluding every real
// Tempo settlement from /api/revenue/mpp — caught in the post-launch Tempo
// audit, 2026-08-17) -------------------------------------------------------
{
  const TEMPO_PAYER = "0x2222222222222222222222222222222222222222";
  const H_TEMPO = "0xTempo000000000000000000000000000000000000000000000000000000001";
  const before = mppSales({ limit: 100 }).count;
  recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "tempo", payer: TEMPO_PAYER, tx: H_TEMPO, synthetic: false, wire: "mpp-tempo" });
  const hashes = mppTxHashes();
  ok(hashes.has(H_TEMPO), "a mpp-tempo settlement's tx hash is exposed alongside evm-translated mpp ones");
  const after = mppSales({ limit: 100 });
  ok(after.count === before + 1, "mppSales count includes the mpp-tempo settlement");
  ok(after.byNetwork.tempo === 1, "mppSales byNetwork breaks out the tempo settlement by its own network label");
}

// --- Public MPP aggregate is ALL-TIME and external-first, never "the 30 newest
// rows" (cost audit 2026-08-19: the Tempo volume runner settles ~1,000 internal
// buys/day, so the 30 newest rows are always ours and the public view read
// "externalCount 0" with only our hashes on the Tempo card) ------------------
{
  const base = mppSales({ limit: 30 });
  for (let i = 0; i < 40; i++) recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "tempo", payer: null, tx: `0xInternal${String(i).padStart(56, "0")}`, synthetic: true, wire: "mpp-tempo" });
  const pub = mppSales({ limit: 30 });
  ok(pub.count === base.count + 40 && pub.internalCount === (base.internalCount || 0) + 40, `count is all-time incl. the 40 internal rows (${pub.count}), internalCount names them (${pub.internalCount})`);
  ok(pub.externalCount === base.externalCount, `externalCount is unchanged by 40 newer internal rows (${pub.externalCount})`);
  ok(pub.rails.tempo.external === base.rails.tempo.external && pub.rails.tempo.internal === (base.rails.tempo.internal || 0) + 40, "the tempo rail card keeps its external count and gains an internal count");
  ok(pub.rails.tempo.txs[0] === "0xTempo000000000000000000000000000000000000000000000000000000001" && pub.rails.tempo.txsInternal === false, "the tempo rail's hashes are the EXTERNAL settlement's, not the 40 newer internal ones");
  ok(pub.txs.every((t) => !/^0xInternal/.test(t)), "the flat txs list is external-only");
  const det = mppSales({ limit: 100, detailed: true });
  ok(det.settlements.filter((r) => r.internal).length >= 40, `operator view still lists the internal rows (${det.settlements.length} rows)`);
}

// --- settle receipt tx parser --------------------------------------------------------
const rcpt = Buffer.from(JSON.stringify({ transaction: "0xfeed", network: "eip155:8453" })).toString("base64");
ok(txFromPaymentResponse(rcpt) === "0xfeed", "tx extracted from PAYMENT-RESPONSE receipt");
ok(txFromPaymentResponse("not-base64-json") === null && txFromPaymentResponse("") === null && txFromPaymentResponse(undefined) === null,
  "garbage receipts parse to null");

// --- PUBLIC SHAPE: aggregate only, no customer list, no per-tool ranking -------
// /api/sales is public. Three things must never appear in the default shape:
// payer addresses (a customer list, however public the chain is - the /revenue
// Buyers metric is counts-only for the same reason), per-call rows, and the
// per-tool ranking (that is what the PAID bestsellers tool sells; serving it
// free undercut our own product). This is a leak test, so it asserts on the
// SERIALIZED payload, not just the field names - a nested address would slip
// past a key check.
{
  const BUYER = "0x1111111111111111111111111111111111111111";
  const SVM_BUYER = "TeStKWyNre9PW8XbLfvuBm9f6EnTBYqS5GXTzciCnHw";
  recordSale({ slug: "leak-probe", priceUsd: 0.002, rail: "usdc", network: "base", payer: BUYER, tx: "0xleak1", synthetic: false });
  recordSale({ slug: "leak-probe", priceUsd: 0.002, rail: "usdc", network: "solana", payer: SVM_BUYER, tx: "sigleak", synthetic: false });

  const pub = salesSummary();
  const json = JSON.stringify(pub);
  ok(!json.includes(BUYER) && !json.includes(BUYER.toLowerCase()), "public summary leaks no EVM payer address");
  ok(!json.includes(SVM_BUYER), "public summary leaks no base58 payer address");
  ok(!/0x[0-9a-f]{40}/i.test(json), "public summary contains no EVM-address-shaped string anywhere");
  for (const field of ["recentExternal", "recentInternal", "repeatBuyers", "topExternal"]) {
    ok(!(field in pub), `public summary omits ${field}`);
  }
  ok(!json.includes("0xleak1") && !json.includes("sigleak"), "public summary leaks no settlement tx hashes");
  ok(!json.includes("leak-probe"), "public summary names no individual tool");
  // What it SHOULD carry: proof the market is real, in counts and totals.
  ok(pub.totals?.external?.sales >= 2, "public summary still reports external sale totals");
  ok(pub.distinctExternalBuyers >= 2, `public summary reports a distinct-buyer COUNT (got ${pub.distinctExternalBuyers})`);
  ok(pub.distinctToolsSoldExternal >= 1, "public summary reports a distinct-tools-sold count");
  ok(pub.recordingSince !== undefined, "public summary still states when recording began");

  // Operator mode keeps everything - the itemized view still has to work.
  const op = salesSummary({ detailed: true });
  ok(Array.isArray(op.repeatBuyers) && op.repeatBuyers.some((r) => r.payer === BUYER), "detailed mode still itemizes repeat buyers");
  ok(op.repeatBuyers.some((r) => r.payer === SVM_BUYER), "detailed mode never case-folds a base58 payer");
  ok(Array.isArray(op.topExternal) && op.topExternal.some((r) => r.slug === "leak-probe"), "detailed mode still ranks tools");
  ok(op.recentExternal.some((r) => r.tx === "0xleak1"), "detailed mode still carries per-call rows");
  // Counts must agree across modes, or the public beacon is lying.
  ok(op.repeatBuyers.length === pub.distinctExternalBuyers, "the public buyer COUNT equals the detailed roster length");
  ok(op.topExternal.length === pub.distinctToolsSoldExternal, "the public tool count equals the detailed ranking length");
}

// --- mppSales is PUBLIC: no payer, ever -------------------------------------
// /api/revenue/mpp and the /revenue MPP section render this. It shipped a payer
// address on every settlement row, which is the same customer-list leak the
// salesSummary contract above refuses - found only after the sales fix, because
// nothing asserted the rule across surfaces. Seeded here so the assertion is
// real even on an empty database, where the HTTP-level gate is vacuous.
{
  const MPPW = "0x5555555555555555555555555555555555555555";
  recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "base", payer: MPPW, tx: "0xmpp1", synthetic: false, wire: "mpp" });
  // PUBLIC view: adoption evidence, never a purchase feed. Dropping the payer
  // was not sufficient - a row pairing slug with priceUsd is itself a per-call
  // purchase list, which is what salesSummary was reduced for.
  const feed = mppSales({ limit: 10 });
  const blob = JSON.stringify(feed);
  ok(feed.count > 0, "public mpp feed still reports that settlements exist");
  ok(feed.settlements === undefined, "public mpp feed carries NO per-settlement rows");
  ok(!/"slug"/.test(blob) && !/"priceUsd"/.test(blob), "public mpp feed pairs no tool name with a price");
  ok(Array.isArray(feed.txs) && feed.txs.includes("0xmpp1"), "the settlement tx is still published (that is the on-chain proof)");
  ok(!blob.includes(MPPW) && !blob.includes(MPPW.toLowerCase()), "mpp feed carries no payer address");
  ok(!/0x[0-9a-f]{40}(?![0-9a-f])/i.test(blob), "mpp feed contains no EVM-address-shaped value");

  // OPERATOR view: the itemized rows survive, still without a payer.
  const opFeed = mppSales({ limit: 100, detailed: true });
  const opBlob = JSON.stringify(opFeed);
  ok(Array.isArray(opFeed.settlements) && opFeed.settlements.length > 0, "operator mpp feed keeps the per-settlement rows");
  ok(opFeed.settlements.every((r) => !("payer" in r)), "no mpp settlement row has a payer field at all, even for the operator");
  ok(!/0x[0-9a-f]{40}(?![0-9a-f])/i.test(opBlob), "operator mpp feed contains no EVM-address-shaped value either");
  ok(Boolean(opFeed.settlements.find((r) => r.tx === "0xmpp1")), "the seeded settlement is present in the operator view");
}

// --- EVERY paying rail counts, not just the busy one --------------------------------
// The paying set lives in src/paid-rails.js and this module's nine queries now
// interpolate it, so a new rail cannot be added to some readers and forgotten
// in others. That only holds if this suite notices when a rail LEAVES the set,
// and it did not: dropping "marketplace" was mutation-tested and every
// assertion here stayed green while the ledger silently stopped counting that
// revenue. Silent under-counting of real money is the worse direction of this
// bug, so the quiet rail gets an explicit assertion.
//
// Deliberately last, with its own payer: an earlier draft inserted this in the
// middle of the fixture and moved a downstream repeat-buyer total, which is a
// good reminder that this file's assertions share one accumulating ledger.
// Asserted as a DELTA for the same reason - an absolute total would break the
// next time a sale is added above.
{
  const MKT_BUYER = "0x1111111111111111111111111111111111111111";
  const before = salesSummary({ detailed: true }).totals.external.revenueUsd;
  recordSale({ slug: "extract", priceUsd: 0.02, rail: "marketplace", network: "base", payer: MKT_BUYER, tx: "0x777", synthetic: false });
  const after = salesSummary({ detailed: true });
  ok(Math.abs((after.totals.external.revenueUsd - before) - 0.02) < 1e-9,
    `a marketplace sale adds revenue like usdc does (delta $${(after.totals.external.revenueUsd - before).toFixed(3)}, want $0.020)`);
  ok(after.topExternal.some((r) => r.slug === "extract"), "a marketplace sale reaches top external");
}

// cardSales: the /revenue card line reads external card + credits sales only.
const cardBefore = cardSales({ days: 30 });
recordSale({ slug: "domain-audit", priceUsd: 2, rail: "card", network: "stripe", payer: null, tx: "pi_test_card", synthetic: false, wire: "stripe-checkout" });
recordSale({ slug: "domain-audit", priceUsd: 2, rail: "card", network: "stripe", payer: null, tx: "pi_test_internal", synthetic: true, wire: "stripe-checkout" });
const cardAfter = cardSales({ days: 30 });
ok(cardAfter.count === cardBefore.count + 1 && cardAfter.allTimeCount === cardBefore.allTimeCount + 1, "cardSales counts the external card sale and not the internal one");
ok(Math.abs(cardAfter.usd - cardBefore.usd - 2) < 1e-9, "cardSales adds its dollars");
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(cardAfter.lastAt || ""), "cardSales lastAt is hour-truncated ISO");

rmSync(dir, { recursive: true, force: true });

// externalByNetwork (2026-08-28): per-rail external settlements + distinct buyers, internal rows never counted, CAIP ids collapsed
{
  const nowTs = Date.now();
  recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "eip155:8453", payer: "0x" + "a".repeat(40), tx: "0xnetA1", synthetic: false });
  recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: "0x" + "a".repeat(40), tx: "0xnetA2", synthetic: false });
  recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "solana", payer: "SoLPayer111", tx: "solnet1", synthetic: false });
  recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: "0x" + "b".repeat(40), tx: "0xnetInt", synthetic: true });
  const m = externalByNetwork({ days: 1 });
  ok(m.base && m.base.settlements >= 2 && m.solana && m.solana.settlements >= 1, `per-network external settlements (base ${m.base?.settlements}, solana ${m.solana?.settlements})`);
  ok(!Object.keys(m).includes("eip155:8453"), "CAIP-2 ids collapse onto the rail key");
  const before = m.base.settlements;
  recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: "0x" + "c".repeat(40), tx: "0xnetInt2", synthetic: true });
  ok(externalByNetwork({ days: 1 }).base.settlements === before, "an internal sale never moves the per-network external count");
}

// A COUNT must never be the length of a ranked, LIMITed list.
//
// `distinctToolsSoldExternal` was `qExtBySlug.all(since).length` and that query
// carries LIMIT 20; `distinctExternalBuyers` was `qExtByPayer.all(since).length`
// with LIMIT 10. So both were min(actual, limit) and could never report more,
// however many tools sold or buyers paid. Both are PUBLISHED (host-entry.js ->
// /marketplace, /leaderboard, every chain page, /api/index), and the capped
// figure "20 of 627 priced tools had any external use" was the measurement that
// justified retiring 40 tools and 29 skill packs on 2026-08-25. Eleven of those
// packs had real outside buyers inside the window.
//
// A ceiling that looks like a count is worse than no count: it reads as a
// finding. Source-level, because a fixture small enough to unit-test would sit
// under both limits and pass either way - which is exactly why nothing caught it.
{
  const src = await readFile(new URL("../src/sales-ledger.js", import.meta.url), "utf8");
  const summary = src.slice(src.indexOf("distinctExternalBuyers:"), src.indexOf("distinctExternalBuyers:") + 400);
  ok(!/\.all\([^)]*\)\.length/.test(summary),
    "neither published count is the .length of a query result list");
  ok(/qExtDistinctPayers\.get\(/.test(summary) && /qExtDistinctSlugs\.get\(/.test(summary),
    "both counts come from dedicated COUNT(DISTINCT ...) queries");
  for (const q of ["qExtDistinctSlugs", "qExtDistinctPayers"]) {
    const decl = src.slice(src.indexOf(`const ${q} = `), src.indexOf(`const ${q} = `) + 260);
    ok(/COUNT\(DISTINCT/.test(decl), `${q} uses COUNT(DISTINCT ...)`);
    ok(!/LIMIT/i.test(decl), `${q} carries no LIMIT`);
  }
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
