// EDGAR-kit tests — same shape as test-macro-kit.js: strict on our validation
// logic (offline, deterministic) and tolerant of SEC EDGAR rate-limiting or
// outages on live calls. Fails only if an assertion breaks or if EVERY live
// call fails (which would mean our integration is broken, not SEC's network).
//
// Note: EDGAR enforces a User-Agent header — set EDGAR_USER_AGENT to your own
// "Name email@domain" string for friendlier rate treatment. The kit ships a
// generic Agent402 fallback that works out-of-the-box.
import { EDGAR_TOOLS } from "../src/tools/edgar-kit.js";

const h = (slug) => EDGAR_TOOLS.find((t) => t.slug === slug).handler;
let assertFail = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) console.log(`ok - ${m}`); else { assertFail++; console.error(`ASSERT FAIL - ${m}`); } };

// --- deterministic validation (no network) ---
// Each row asserts the handler throws a 400 Error on bad input — we never
// touch SEC for these.
for (const [slug, args, label] of [
  ["edgar-company-lookup", {}, "edgar-company-lookup rejects missing ticker"],
  ["edgar-company-lookup", { ticker: "@@@@@@" }, "edgar-company-lookup rejects malformed ticker"],
  ["edgar-filings", {}, "edgar-filings rejects when neither ticker nor cik provided"],
  ["edgar-filings", { cik: "not-a-number" }, "edgar-filings rejects malformed cik"],
  ["edgar-company-concept", { ticker: "AAPL" }, "edgar-company-concept rejects missing tag"],
  ["edgar-company-concept", { ticker: "AAPL", tag: "Has Spaces" }, "edgar-company-concept rejects malformed tag"],
  ["edgar-company-facts", {}, "edgar-company-facts rejects when neither ticker nor cik provided"],
  ["edgar-xbrl-frame", { tag: "Revenues", unit: "USD" }, "edgar-xbrl-frame rejects missing period"],
  ["edgar-xbrl-frame", { tag: "Revenues", unit: "USD", period: "2023Q1" }, "edgar-xbrl-frame rejects non-CY period"],
  ["edgar-xbrl-frame", { tag: "Revenues", unit: "USD", period: "CY2023Q5" }, "edgar-xbrl-frame rejects invalid quarter"],
  ["edgar-insider-trades", {}, "edgar-insider-trades rejects when neither ticker nor cik provided"],
  ["edgar-13f-holdings", {}, "edgar-13f-holdings rejects when neither ticker nor cik provided"],
  ["edgar-recent-ipos", { form: "@@bad@@" }, "edgar-recent-ipos rejects malformed form"],
  ["edgar-search", {}, "edgar-search rejects missing q"],
  ["edgar-search", { q: "test", locationCode: "USA" }, "edgar-search rejects non-2-letter locationCode"],
]) {
  try { await h(slug)(args); ok(false, label); }
  catch (e) { ok(e.statusCode === 400, label + ` (got ${e.statusCode})`); }
}

// --- live calls (tolerant of SEC rate-limiting / outages) ---
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

// Apple is the canonical EDGAR test case — CIK 320193, ticker AAPL — and it
// reports rich XBRL across decades, so single-test invariants are stable.
await live("edgar-company-lookup", { ticker: "AAPL" },
  (r) => r.cik === "0000320193" && r.cikInt === 320193 && /apple/i.test(r.name || ""),
  "edgar-company-lookup AAPL → CIK 0000320193");

await live("edgar-filings", { ticker: "AAPL", form: "10-K", limit: 3 },
  (r) => r.cik === "0000320193" && Array.isArray(r.filings) && r.filings.length > 0 && r.filings.every((f) => f.form === "10-K") && typeof r.filings[0].url === "string",
  "edgar-filings AAPL 10-K limit=3");

await live("edgar-filings", { cik: "320193", limit: 5 },
  (r) => r.cik === "0000320193" && Array.isArray(r.filings) && r.filings.length === 5,
  "edgar-filings via CIK (unpadded) limit=5");

await live("edgar-company-concept", { ticker: "AAPL", taxonomy: "us-gaap", tag: "Revenues" },
  (r) => r.cik === "0000320193" && r.tag === "Revenues" && r.units && Array.isArray(r.units.USD) && r.units.USD.length > 0,
  "edgar-company-concept AAPL us-gaap/Revenues");

await live("edgar-company-facts", { ticker: "AAPL" },
  (r) => r.cik === "0000320193" && r.mode === "summary" && r.taxonomies && r.taxonomies["us-gaap"] && r.taxonomies["us-gaap"].count > 0,
  "edgar-company-facts AAPL summary mode");

await live("edgar-company-facts", { ticker: "AAPL", tags: "Revenues,Assets" },
  (r) => r.mode === "full" && r.taxonomies && r.taxonomies["us-gaap"] && r.taxonomies["us-gaap"].Revenues && r.taxonomies["us-gaap"].Assets,
  "edgar-company-facts AAPL full mode (tags=Revenues,Assets)");

// XBRL frames — pick a period far enough in the past that filings are
// definitely settled. CY2022Q4 is safe.
await live("edgar-xbrl-frame", { taxonomy: "us-gaap", tag: "Revenues", unit: "USD", period: "CY2022Q4", limit: 10 },
  (r) => r.tag === "Revenues" && Array.isArray(r.data) && r.data.length > 0 && r.totalCompanies >= r.returned,
  "edgar-xbrl-frame us-gaap/Revenues/USD/CY2022Q4 limit=10");

// Instantaneous balance-sheet period (suffix "I")
await live("edgar-xbrl-frame", { taxonomy: "us-gaap", tag: "Assets", unit: "USD", period: "CY2022Q4I", limit: 5 },
  (r) => r.tag === "Assets" && Array.isArray(r.data) && r.data.length > 0,
  "edgar-xbrl-frame us-gaap/Assets/USD/CY2022Q4I (instantaneous)");

// --- Form 4 / 13F / IPO / full-text search ---
// Insider trades: Apple is a high-volume issuer; a 90-day window should always
// have multiple Form 4s. If SEC's efts.sec.gov is rate-limiting our IP this
// will return 504 — tolerated.
await live("edgar-insider-trades", { ticker: "AAPL", days: 90, limit: 5 },
  (r) => r.cik === "0000320193" && Array.isArray(r.trades) && r.trades.every((t) => t.form === "4"),
  "edgar-insider-trades AAPL days=90");

// 13F holdings: Berkshire Hathaway (CIK 1067983) is the canonical 13F filer —
// always has a recent 13F-HR with a parseable informationtable.xml.
await live("edgar-13f-holdings", { cik: "1067983", limit: 5 },
  (r) => r.cik === "0001067983" && Array.isArray(r.holdings) && r.holdings.length > 0 && r.holdings[0].valueUsd > 0 && r.holdings[0].cusip,
  "edgar-13f-holdings Berkshire top-5");

// Recent IPOs: S-1 filings in last 30 days. There are always S-1 filings —
// this should never be empty on a normal week.
// EDGAR's full-text search treats forms=S-1 as a prefix match, so the response
// includes both S-1 and S-1/A (amendments). That's the intended behavior for
// "recent IPO activity" — accept either in the form column.
await live("edgar-recent-ipos", { form: "S-1", days: 30, limit: 5 },
  (r) => r.form === "S-1" && Array.isArray(r.filings) && r.filings.every((f) => /^S-1(\/A)?$/.test(f.form || "")),
  "edgar-recent-ipos S-1 days=30");

// Full-text search: "going concern" in 10-Q filings — always has plenty of
// hits given how many small companies disclose this.
await live("edgar-search", { q: "going concern", forms: "10-Q", days: 90, limit: 5 },
  (r) => r.q === "going concern" && Array.isArray(r.hits) && r.hits.length > 0 && r.hits.every((h) => h.form === "10-Q"),
  "edgar-search 'going concern' forms=10-Q days=90");

// Full-text search with company filter: searching Apple's own filings.
await live("edgar-search", { q: "revenue", ticker: "AAPL", forms: "10-K", limit: 3 },
  (r) => r.q === "revenue" && r.ciks === "0000320193" && Array.isArray(r.hits),
  "edgar-search 'revenue' ticker=AAPL forms=10-K");

console.log(`\nvalidation asserts failed: ${assertFail} | live ok: ${liveOk} | live upstream-errors (tolerated): ${liveErr}`);
if (assertFail > 0 || liveOk === 0) { console.error("edgar-kit: FAILED"); process.exit(1); }
console.log("edgar-kit: OK");
