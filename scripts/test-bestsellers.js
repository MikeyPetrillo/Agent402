// Offline unit tests for the bestsellers catalog-demand tool
// (src/tools/x402-kit.js computeBestsellers + sales-ledger externalSlugWindow)
// — ranking lenses, trend-vs-previous-window math, organic score, revenue
// share, clamps, empty-ledger resilience, the isSelf honesty flag, the
// window query's internal/rail filtering, and the wallet-only (pay-per-call)
// registration in pow.js. No network; DB tests use a throwaway SQLite file
// via SALES_LEDGER_DB (set BEFORE import, same pattern as test-sales-ledger).
//
//   node scripts/test-bestsellers.js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-bestsellers-"));
process.env.SALES_LEDGER_DB = join(dir, "test-bestsellers.db");

const { computeBestsellers, clampBestsellerDays } = await import("../src/tools/x402-kit.js");
const { recordSale, externalSlugWindow, firstRecordedTs } = await import("../src/sales-ledger.js");
const { WALLET_ONLY_SLUGS } = await import("../src/pow.js");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// Synthetic externalSlugWindow-shaped rows.
const row = (slug, sales, revenue, buyers, over = {}) => ({
  slug, sales, revenue, buyers,
  first_ts: Date.parse("2026-07-05T00:00:00Z"),
  last_ts: Date.parse("2026-07-14T00:00:00Z"),
  ...over,
});
const NOW = Date.parse("2026-07-16T00:00:00Z");

// --- ranking lenses (the differentiator over the free /api/sales feed) ---------
{
  const rows = [
    row("whale-magnet", 40, 0.40, 1),   // huge volume, one wallet
    row("crowd-pick", 10, 0.05, 9),     // small volume, nine wallets
    row("big-ticket", 5, 0.50, 3),      // few sales, most revenue
  ];
  const byBuyers = computeBestsellers(rows, [], {}, { now: NOW });
  ok(byBuyers.sort === "buyers", "default sort is buyers (whale-resistant)");
  ok(byBuyers.bestsellers[0].slug === "crowd-pick", "sort=buyers ranks the nine-wallet tool over the one-whale tool");
  const bySales = computeBestsellers(rows, [], { sort: "sales" }, { now: NOW });
  ok(bySales.bestsellers[0].slug === "whale-magnet", "sort=sales ranks by volume");
  const byUsd = computeBestsellers(rows, [], { sort: "usd" }, { now: NOW });
  ok(byUsd.bestsellers[0].slug === "big-ticket", "sort=usd ranks by revenue");
  const byOrganic = computeBestsellers(rows, [], { sort: "organic" }, { now: NOW });
  ok(byOrganic.bestsellers[0].slug === "crowd-pick", "sort=organic ranks by buyer diversity");
  ok(computeBestsellers(rows, [], { sort: "bogus" }, { now: NOW }).sort === "buyers", "unknown sort falls back to buyers (echoed)");
  ok(byBuyers.bestsellers.every((r, i) => r.rank === i + 1), "rows carry 1-based rank");
}

// --- per-row analysis fields ----------------------------------------------------
{
  const out = computeBestsellers([row("vin-decode", 14, 0.056, 6), row("hash", 6, 0.006, 6)], [], {}, { now: NOW });
  const vd = out.bestsellers.find((r) => r.slug === "vin-decode");
  ok(vd.organicScore === 0.4286, `organicScore = buyers/sales (got ${vd.organicScore})`);
  ok(vd.avgTicketUsd === 0.004, `avgTicketUsd = revenue/sales (got ${vd.avgTicketUsd})`);
  ok(vd.revenueShare === Number((0.056 / 0.062).toFixed(4)), `revenueShare is the slice of window revenue (got ${vd.revenueShare})`);
  ok(vd.firstAt === "2026-07-05T00:00:00.000Z" && vd.lastAt === "2026-07-14T00:00:00.000Z", "first/last sale timestamps ride each row");
  ok(out.totals.sales === 20 && out.totals.revenueUsd === 0.062 && out.totals.distinctTools === 2, "totals aggregate over ALL rows, not just the top-N");
  // organicScore clamps at 1 even if buyers somehow exceeds sales.
  const clamped = computeBestsellers([row("odd", 2, 0.01, 5)], [], {}, { now: NOW });
  ok(clamped.bestsellers[0].organicScore === 1, "organicScore clamps to 1");
}

// --- trend vs the previous same-length window ------------------------------------
{
  const cur = [row("grower", 30, 0.3, 3), row("fader", 5, 0.05, 2), row("steady", 20, 0.2, 4), row("debut", 4, 0.04, 2)];
  const prev = [row("grower", 10, 0.1, 2), row("fader", 20, 0.2, 3), row("steady", 20, 0.2, 4)];
  const out = computeBestsellers(cur, prev, { sort: "sales" }, { now: NOW });
  const by = (s) => out.bestsellers.find((r) => r.slug === s);
  ok(by("grower").trend === "rising" && by("grower").deltaSales === 20 && by("grower").prevSales === 10, "sales up past the band → rising, with delta + prevSales");
  ok(by("fader").trend === "cooling" && by("fader").deltaSales === -15, "sales down past the band → cooling");
  ok(by("steady").trend === "flat" && by("steady").deltaSales === 0, "unchanged sales → flat");
  ok(by("debut").trend === "new" && by("debut").prevSales === 0, "no prior-window sales → new (never faked as rising)");
  // ±5%-of-prev band, min 1: prev 10 → band 1, so ±1 is flat, ±2 crosses.
  const bandOut = computeBestsellers([row("edge", 11, 0.1, 1), row("edge2", 12, 0.1, 1)], [row("edge", 10, 0.1, 1), row("edge2", 10, 0.1, 1)], {}, { now: NOW });
  ok(bandOut.bestsellers.find((r) => r.slug === "edge").trend === "flat", "delta within the min-1 band → flat");
  ok(bandOut.bestsellers.find((r) => r.slug === "edge2").trend === "rising", "delta past the min-1 band → rising");
}

// --- isSelf honesty flag ----------------------------------------------------------
{
  const out = computeBestsellers([row("bestsellers", 3, 0.015, 2), row("hash", 2, 0.002, 2)], [], { sort: "sales" }, { now: NOW });
  ok(out.bestsellers.find((r) => r.slug === "bestsellers")?.isSelf === true, "this tool's own row is flagged isSelf:true, never hidden");
  ok(out.bestsellers.find((r) => r.slug === "hash")?.isSelf === undefined, "other rows carry no isSelf key");
}

// --- clamps + echo -----------------------------------------------------------------
{
  ok(clampBestsellerDays(30) === 30 && clampBestsellerDays(undefined) === 30, "days defaults to 30");
  ok(clampBestsellerDays(-5) === 1 && clampBestsellerDays(9999) === 90 && clampBestsellerDays("14") === 14, "days clamps to 1-90, string parses");
  ok(clampBestsellerDays(0) === 30 && clampBestsellerDays("junk") === 30, "zero/unparseable days falls back to the default (house || convention)");
  const rows = Array.from({ length: 60 }, (_, i) => row(`t-${String(i).padStart(2, "0")}`, 60 - i, (60 - i) / 1000, 60 - i));
  ok(computeBestsellers(rows, [], {}, { now: NOW }).bestsellers.length === 10, "default limit is 10");
  ok(computeBestsellers(rows, [], { limit: 999 }, { now: NOW }).bestsellers.length === 50, "limit caps at 50");
  ok(computeBestsellers(rows, [], { limit: "3" }, { now: NOW }).bestsellers.length === 3, "string limit (GET query) parses");
  ok(computeBestsellers(rows, [], { days: "7" }, { now: NOW }).days === 7, "days is echoed in the envelope");
}

// --- deterministic tiebreak ---------------------------------------------------------
{
  const out = computeBestsellers([row("b-tool", 5, 0.05, 3), row("a-tool", 5, 0.05, 3)], [], {}, { now: NOW });
  ok(out.bestsellers[0].slug === "a-tool", "full metric tie breaks by slug (deterministic ordering)");
}

// --- empty ledger: clean envelope, never throws --------------------------------------
{
  const empty = computeBestsellers([], [], {}, { now: NOW });
  ok(empty.totals.sales === 0 && empty.totals.distinctTools === 0 && empty.bestsellers.length === 0, "empty rows → zero totals, empty list");
  ok(empty.recordingSince === null && typeof empty.note === "string" && typeof empty.generatedAt === "string", "empty envelope keeps recordingSince/note/generatedAt keys");
  const junk = computeBestsellers([{}, null, { slug: "ok", sales: "3", revenue: null, buyers: undefined }], null, {}, { now: NOW });
  ok(junk.bestsellers.every((r) => Number.isFinite(r.sales) && Number.isFinite(r.revenueUsd)), "malformed rows coerce cleanly (no NaN)");
}

// --- externalSlugWindow: the data feed's filtering (throwaway DB) ---------------------
{
  ok(firstRecordedTs() === null, "fresh ledger → firstRecordedTs null");
  const BUYER_A = "0xdeadbeef00000000000000000000000000000001";
  const BUYER_B = "0x1111111111111111111111111111111111111111";
  recordSale({ slug: "vin-decode", priceUsd: 0.004, rail: "usdc", network: "base", payer: BUYER_A, tx: "0x1" });
  recordSale({ slug: "vin-decode", priceUsd: 0.004, rail: "usdc", network: "base", payer: BUYER_A, tx: "0x2" });
  recordSale({ slug: "vin-decode", priceUsd: 0.004, rail: "usdc", network: "base", payer: BUYER_B, tx: "0x3" });
  recordSale({ slug: "vin-decode", priceUsd: 0.004, rail: "usdc", network: "solana", payer: null, tx: "sig1" }); // SVM: no payer
  recordSale({ slug: "vin-decode", priceUsd: 0.004, rail: "pow", network: null, payer: null, tx: null });        // free tier: usage, not a sale
  recordSale({ slug: "vin-decode", priceUsd: 0.004, rail: "usdc", network: "base", payer: BUYER_A, tx: "0x4", synthetic: true }); // canary
  recordSale({ slug: "hash", priceUsd: 0.001, rail: "heartbeat", network: null, payer: null, tx: null });        // probe
  const rows = externalSlugWindow(Date.now() - 86400000, Date.now() + 1);
  ok(rows.length === 1 && rows[0].slug === "vin-decode", "pow/heartbeat/synthetic rows never reach the window (external money rails only)");
  ok(rows[0].sales === 4, `SVM sale counts toward sales (got ${rows[0].sales})`);
  ok(rows[0].buyers === 2, `buyers counts DISTINCT payers, NULL (SVM) excluded (got ${rows[0].buyers})`);
  ok(Math.abs(rows[0].revenue - 0.016) < 1e-9, `window revenue sums external money rows (got ${rows[0].revenue})`);
  ok(externalSlugWindow(Date.now() + 1000, Date.now() + 2000).length === 0, "out-of-window query → no rows (half-open [since, until))");
  ok(typeof firstRecordedTs() === "number", "firstRecordedTs reports the ledger's first row");
}

// --- wallet-only registration (paid-intelligence layer, never PoW-farmable) -----------
{
  ok(WALLET_ONLY_SLUGS.has("bestsellers"), "bestsellers is in WALLET_ONLY_SLUGS (wallet-only, not compute-payable)");
  ok(WALLET_ONLY_SLUGS.has("demand-radar") && WALLET_ONLY_SLUGS.has("x402-trending"), "sibling paid-intelligence layers still wallet-only (sanity)");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
