// Sales ledger — offline unit tests. Throwaway DB via SALES_LEDGER_DB (set
// BEFORE import), no network: exercises the internal/external classification
// (synthetic flag, heartbeat rail, burner payer), the revenue math (money
// rails only — PoW counts as usage, never revenue), the merchant summary
// shape, and the settle-receipt tx parser.
//
//   node scripts/test-sales-ledger.js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-sales-"));
process.env.SALES_LEDGER_DB = join(dir, "test-sales.db");
const { recordSale, salesSummary, txFromPaymentResponse } = await import("../src/sales-ledger.js");
const { OUR_EVM_WALLETS } = await import("../src/revenue-live.js");

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

const BUYER = "0x07FBCA218b0A0a35244e0025A036fA85A6dc97dC"; // checksummed on purpose — must match lowercased
const BURNER = [...OUR_EVM_WALLETS][0];

// --- empty ledger ----------------------------------------------------------------
let s = salesSummary();
ok(s.totals.external.sales === 0 && s.topExternal.length === 0 && s.recordingSince === null, "empty ledger → zero totals, null since");

// --- external USDC sale ------------------------------------------------------------
recordSale({ slug: "code-run-pro", priceUsd: 0.05, rail: "usdc", network: "base", payer: BUYER, tx: "0xabc", synthetic: false });
s = salesSummary();
ok(s.totals.external.sales === 1 && s.totals.external.revenueUsd === 0.05, `external usdc sale counts as revenue (got $${s.totals.external.revenueUsd})`);
ok(s.topExternal[0]?.slug === "code-run-pro" && s.topExternal[0]?.sales === 1, "top external names the slug");
ok(s.recentExternal[0]?.payer === BUYER.toLowerCase() && s.recentExternal[0]?.tx === "0xabc", "recent sale keeps lowercased payer + settle tx");

// --- internal classification: synthetic, heartbeat rail, burner payer -------------
recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: BUYER, tx: null, synthetic: true });
recordSale({ slug: "hash", priceUsd: 0.001, rail: "heartbeat", network: null, payer: null, tx: null, synthetic: false });
recordSale({ slug: "stock-quote", priceUsd: 0.01, rail: "usdc", network: "base", payer: BURNER.toUpperCase().replace("0X", "0x"), tx: "0xdef", synthetic: false });
s = salesSummary();
ok(s.totals.internal.sales === 3, `synthetic + heartbeat + burner-payer all classify internal (got ${s.totals.internal.sales})`);
ok(s.totals.external.sales === 1, "none of them leaked into external");
ok(!s.topExternal.some((r) => r.slug === "stock-quote"), "burner (canary-style) buy never appears in top external");

// --- PoW is usage, not revenue ------------------------------------------------------
recordSale({ slug: "qr", priceUsd: 0.001, rail: "pow", network: null, payer: null, tx: null, synthetic: false });
s = salesSummary();
ok(s.totals.external.sales === 2 && s.totals.external.revenueUsd === 0.05, "pow adds a sale but not revenue");
ok(!s.topExternal.some((r) => r.slug === "qr"), "topExternal is money rails only");
ok(s.totals.byRail["external:pow"] === 1, "rail split exposes pow usage");

// --- marketplace rail is revenue ----------------------------------------------------
recordSale({ slug: "search", priceUsd: 0.02, rail: "marketplace", network: null, payer: null, tx: null, synthetic: false });
s = salesSummary();
ok(s.totals.external.revenueUsd === 0.07, `marketplace revenue counts (got $${s.totals.external.revenueUsd})`);

// --- repeat buyers ------------------------------------------------------------------
recordSale({ slug: "tts", priceUsd: 0.05, rail: "usdc", network: "base", payer: BUYER, tx: "0x123", synthetic: false });
s = salesSummary();
ok(s.repeatBuyers[0]?.payer === BUYER.toLowerCase() && s.repeatBuyers[0]?.sales === 2 && s.repeatBuyers[0]?.revenueUsd === 0.1,
  `repeat buyer aggregates by wallet (got ${JSON.stringify(s.repeatBuyers[0])})`);

// --- never throws on garbage --------------------------------------------------------
recordSale({});
recordSale({ slug: null, priceUsd: NaN, rail: undefined, payer: 42, tx: {}, synthetic: null });
s = salesSummary();
ok(true, "garbage input never throws");
ok(s.totals.external.sales >= 2, "ledger still readable after garbage rows");

// --- days window: old rows age out of the aggregations ------------------------------
{
  const Database = (await import("better-sqlite3")).default;
  const raw = new Database(process.env.SALES_LEDGER_DB);
  raw.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal) VALUES (?,?,?,?,?,?,?,0)")
    .run(Date.now() - 40 * 86_400_000, "ancient-tool", 0.9, "usdc", "base", "0x" + "1".repeat(40), "0xold");
  raw.close();
  s = salesSummary({ days: 30 });
  ok(!s.topExternal.some((r) => r.slug === "ancient-tool"), "40-day-old sale is outside the 30d window");
  const wide = salesSummary({ days: 90 });
  ok(wide.topExternal.some((r) => r.slug === "ancient-tool"), "…but inside a 90d window");
}

// --- settle receipt tx parser --------------------------------------------------------
const rcpt = Buffer.from(JSON.stringify({ transaction: "0xfeed", network: "eip155:8453" })).toString("base64");
ok(txFromPaymentResponse(rcpt) === "0xfeed", "tx extracted from PAYMENT-RESPONSE receipt");
ok(txFromPaymentResponse("not-base64-json") === null && txFromPaymentResponse("") === null && txFromPaymentResponse(undefined) === null,
  "garbage receipts parse to null");

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
