// Finance-kit tests — same shape as test-edgar-kit.js: strict on validation
// (offline, deterministic) and tolerant of upstream errors on live calls.
// Fails only if an assertion breaks or every live call fails (which would
// indicate our integration is broken, not Yahoo/Nasdaq's).
//
// Upstreams reverse-engineered against undocumented JSON, so live-call
// tolerance matters more here than in EDGAR-kit — Yahoo has broken twice
// in the last 5 years (May 2023 crumb migration, 2021 schema flip). If the
// live block is reporting many tolerated errors but assertions pass, that's
// our signal to add a fallback before the next regression hits.
import { FINANCE_TOOLS } from "../src/tools/finance-kit.js";

const h = (slug) => FINANCE_TOOLS.find((t) => t.slug === slug).handler;
let assertFail = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) console.log(`ok - ${m}`); else { assertFail++; console.error(`ASSERT FAIL - ${m}`); } };

// --- deterministic validation (no network) ---
for (const [slug, args, label] of [
  ["stock-quote", {}, "stock-quote rejects missing symbol"],
  ["stock-quote", { symbol: "" }, "stock-quote rejects empty symbol"],
  ["stock-quote", { symbol: "BAD SYMBOL!" }, "stock-quote rejects symbol with spaces/punctuation"],
  ["stock-quote", { symbol: "A".repeat(17) }, "stock-quote rejects 17-char symbol"],
  ["stock-history", {}, "stock-history rejects missing symbol"],
  ["stock-history", { symbol: "AAPL", interval: "30s" }, "stock-history rejects invalid interval"],
  ["stock-history", { symbol: "AAPL", range: "decade" }, "stock-history rejects invalid range"],
  ["earnings-calendar", { date: "20260622" }, "earnings-calendar rejects YYYYMMDD date"],
  ["earnings-calendar", { date: "June 22, 2026" }, "earnings-calendar rejects human-readable date"],
]) {
  try { await h(slug)(args); ok(false, label); }
  catch (e) { ok(e.statusCode === 400, label + ` (got ${e.statusCode})`); }
}

// --- live calls (tolerant of upstream rate-limiting / breakage) ---
async function live(slug, args, check, label) {
  try {
    const r = await h(slug)(args);
    if (check(r)) { liveOk++; console.log(`ok - ${label}: ${JSON.stringify(r).slice(0, 140)}`); }
    else { assertFail++; console.error(`ASSERT FAIL - ${label}: unexpected shape ${JSON.stringify(r).slice(0, 240)}`); }
  } catch (e) {
    liveErr++;
    console.warn(`warn - ${label}: upstream error (${e.statusCode || "?"}) ${e.message} — tolerated`);
  }
}

// Apple is the canonical live-quote test — extreme liquidity, always reports
// a price during US market hours and the last close out of hours. Currency
// must be USD; price must be > 0.
await live("stock-quote", { symbol: "AAPL" },
  (r) => r.symbol === "AAPL" && r.currency === "USD" && typeof r.price === "number" && r.price > 0,
  "stock-quote AAPL");

// Index symbol (^GSPC = S&P 500) exercises the non-equity path — Yahoo
// returns the same chart shape but with `instrumentType: "INDEX"`. No bars
// expected from the chart endpoint with our minimal range, but the meta
// block populates.
await live("stock-quote", { symbol: "^GSPC" },
  (r) => r.symbol === "^GSPC" && typeof r.price === "number" && r.price > 0,
  "stock-quote ^GSPC (S&P 500 index)");

// Daily bars over the last month — should always return 18-23 trading-day
// bars (rough month). We just assert > 5 to ride out month-boundary edge
// cases when the range slides over a holiday week.
await live("stock-history", { symbol: "AAPL", interval: "1d", range: "1mo" },
  (r) => r.symbol === "AAPL" && r.interval === "1d" && Array.isArray(r.bars) && r.bars.length > 5 && r.bars.every((b) => typeof b.close === "number"),
  "stock-history AAPL 1d/1mo");

// Earnings calendar — Nasdaq's API serves all dates including weekends
// (which return empty). Pick today; if there's nothing reporting today the
// API still returns 200 with an empty rows array, which our handler
// surfaces as count: 0. Either populated or empty is a valid pass.
const today = new Date().toISOString().slice(0, 10);
await live("earnings-calendar", { date: today },
  (r) => r.date === today && typeof r.count === "number" && Array.isArray(r.entries),
  `earnings-calendar ${today}`);

console.log(`\nvalidation asserts failed: ${assertFail} | live ok: ${liveOk} | live upstream-errors (tolerated): ${liveErr}`);
if (assertFail > 0 || liveOk === 0) { console.error("finance-kit: FAILED"); process.exit(1); }
console.log("finance-kit: OK");
