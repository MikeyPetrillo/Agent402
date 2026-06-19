// Macro-kit tests — same shape as test-data-kit.js: strict on our validation
// logic (offline, deterministic) and tolerant of any single flaky upstream
// (Treasury Fiscal Data, Frankfurter/ECB, or World Bank). Fails only if an
// assertion breaks or if EVERY live call fails (which would mean our
// integration is broken, not one upstream).
import { MACRO_TOOLS } from "../src/tools/macro-kit.js";

const h = (slug) => MACRO_TOOLS.find((t) => t.slug === slug).handler;
let assertFail = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) console.log(`ok - ${m}`); else { assertFail++; console.error(`ASSERT FAIL - ${m}`); } };

// --- deterministic validation (no network) ---
for (const [slug, args, label] of [
  ["fx-historical", { from: "US", to: "EUR", date: "2024-01-02" }, "fx-historical rejects bad currency code"],
  ["fx-historical", { from: "USD", to: "EUR", date: "01/02/2024" }, "fx-historical rejects non-ISO date"],
  ["fx-timeseries", { from: "USD", to: "EUR", startDate: "2024-01-31", endDate: "2024-01-02" }, "fx-timeseries rejects inverted window"],
  ["world-bank-indicator", { country: "USA1", indicator: "NY.GDP.MKTP.CD" }, "world-bank-indicator rejects bad country code"],
  ["world-bank-indicator", { country: "US", indicator: "not an indicator" }, "world-bank-indicator rejects malformed indicator"],
  ["world-bank-search", { q: "" }, "world-bank-search rejects empty query"],
]) {
  try { await h(slug)(args); ok(false, label); }
  catch (e) { ok(e.statusCode === 400, label + ` (got ${e.statusCode})`); }
}

// --- live calls (tolerant of upstream flake) ---
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

// Treasury Fiscal Data — three independent endpoints
await live("treasury-yield-curve", {}, (r) => r.recordDate && typeof r.yr10 === "number", "treasury-yield-curve");
await live("treasury-yield-history", { days: 5 }, (r) => Array.isArray(r.history) && r.history.length > 0, "treasury-yield-history N=5");
await live("yield-curve-spread", {}, (r) => typeof r.spread2s10sBps === "number" && typeof r.inverted2s10s === "boolean", "yield-curve-spread");
await live("treasury-debt", {}, (r) => r.recordDate && typeof r.totalPublicDebtOutstanding === "number" && r.totalPublicDebtOutstanding > 0, "treasury-debt");
await live("treasury-avg-rates", {}, (r) => r.recordDate && Array.isArray(r.rates) && r.rates.length > 0, "treasury-avg-rates");

// Frankfurter / ECB
await live("fx-historical", { from: "USD", to: "EUR", date: "2024-01-02" }, (r) => typeof r.rate === "number" && r.rate > 0, "fx-historical USD→EUR 2024-01-02");
await live("fx-timeseries", { from: "USD", to: "EUR", startDate: "2024-01-02", endDate: "2024-01-15" }, (r) => Array.isArray(r.series) && r.series.length >= 5, "fx-timeseries USD→EUR Jan 2024");
await live("fx-dashboard", {}, (r) => r.base === "USD" && typeof r.rates?.EUR === "number" && typeof r.usdStrengthIndex === "number", "fx-dashboard G10");

// World Bank — stable historical window
await live("world-bank-indicator", { country: "US", indicator: "NY.GDP.MKTP.CD", startYear: 2018, endYear: 2022 },
  (r) => Array.isArray(r.series) && r.series.length > 0 && typeof r.series[0].value === "number", "world-bank-indicator US GDP 2018-2022");
await live("world-bank-search", { q: "inflation", rows: 5 },
  (r) => Array.isArray(r.indicators) && r.indicators.length > 0 && /^[A-Z0-9.]+$/.test(r.indicators[0].code), "world-bank-search inflation");

// --- keyed FRED tools ------------------------------------------------------
// Two modes:
//   (a) FRED_API_KEY set    → live-call every FRED tool, expect real data
//   (b) FRED_API_KEY unset  → assert each FRED tool returns 503 "not configured"
// Mode (b) is what CI sees if the secret isn't wired up; it must still pass so
// the structural change can ship (and operators get a clear signal to add the
// key on the deployment).
console.log("\nFRED-keyed tools:");
if (process.env.FRED_API_KEY) {
  console.log("  FRED_API_KEY is set — running live calls");
  await live("fred-series", { seriesId: "GDPC1", startDate: "2018-01-01", endDate: "2022-12-31" },
    (r) => r.seriesId === "GDPC1" && Array.isArray(r.observations) && r.observations.length > 0, "fred-series GDPC1");
  await live("fred-search", { q: "consumer price index", limit: 5 },
    (r) => Array.isArray(r.results) && r.results.length > 0 && r.results[0].id === "CPIAUCSL", "fred-search 'consumer price index' → CPIAUCSL");
  await live("fred-series-info", { seriesId: "UNRATE" },
    (r) => r.id === "UNRATE" && r.frequency && r.observationStart, "fred-series-info UNRATE");
  await live("fred-release-calendar", { days: 14 },
    (r) => Array.isArray(r.releases), "fred-release-calendar 14d (may be empty on quiet weeks)");
  // For the "latest reading" tools, assert the returned date is recent (within the
  // last 18 months). Catches the bug where sort_order=asc + limit=N returned the
  // *oldest* N observations (1948-vintage data) instead of the newest.
  const RECENT_FLOOR = new Date(Date.now() - 18 * 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const recent = (d) => typeof d === "string" && d >= RECENT_FLOOR;
  await live("sahm-rule", {},
    (r) => typeof r.value === "number" && typeof r.triggered === "boolean" && recent(r.date), "sahm-rule SAHMREALTIME (date must be recent)");
  await live("cpi-yoy", {},
    (r) => typeof r.inflationYoYPct === "number" && Array.isArray(r.trailing12mo) && recent(r.date), "cpi-yoy CPIAUCSL pc1 (date must be recent)");
  await live("unemployment-rate", { months: 6 },
    (r) => typeof r.current === "number" && Array.isArray(r.history) && r.history.length > 0 && recent(r.date), "unemployment-rate UNRATE 6mo (date must be recent)");
  await live("fed-funds", { days: 10 },
    (r) => typeof r.current === "number" && Array.isArray(r.history) && r.history.length > 0 && recent(r.date), "fed-funds DFF 10d (date must be recent)");

  // FRED API v2 — bulk release/observations. Uses a SEPARATE key (FRED_API_KEY_V2).
  // If FRED_API_KEY_V2 isn't set, the tool returns 503 — tolerated below.
  if (process.env.FRED_API_KEY_V2) {
    console.log("  FRED_API_KEY_V2 is set — testing v2 bulk endpoint");
    await live("fred-release-observations", { releaseId: 18, startDate: "2026-05-01", endDate: "2026-06-01" },
      (r) => r.releaseId === 18 && Array.isArray(r.series) && r.series.length > 0 && r.series.some((s) => Array.isArray(s.observations) && s.observations.length > 0),
      "fred-release-observations releaseId=18 (H.15 Selected Interest Rates)");
  } else {
    console.log("  FRED_API_KEY_V2 is NOT set — verifying v2 tool returns 503");
    try {
      await h("fred-release-observations")({ releaseId: 18 });
      ok(false, "fred-release-observations should 503 without FRED_API_KEY_V2");
    } catch (e) {
      ok(e.statusCode === 503, `fred-release-observations returns 503 without v2 key (got ${e.statusCode})`);
    }
  }
} else {
  console.log("  FRED_API_KEY is NOT set — verifying each FRED tool returns the documented 503");
  for (const slug of ["fred-series", "fred-search", "fred-series-info", "fred-release-calendar", "sahm-rule", "cpi-yoy", "unemployment-rate", "fed-funds"]) {
    try {
      // fred-series / fred-search / fred-series-info require inputs; supply
      // plausible ones so we hit the requireFredKey() check, not validation.
      const args = slug === "fred-series" ? { seriesId: "GDPC1" }
        : slug === "fred-search" ? { q: "gdp" }
        : slug === "fred-series-info" ? { seriesId: "UNRATE" }
        : {};
      await h(slug)(args);
      ok(false, `${slug} should 503 without FRED_API_KEY`);
    } catch (e) {
      ok(e.statusCode === 503, `${slug} returns 503 "not configured" without key (got ${e.statusCode})`);
    }
  }
}

console.log(`\nvalidation asserts failed: ${assertFail} | live ok: ${liveOk} | live upstream-errors (tolerated): ${liveErr}`);
if (assertFail > 0 || liveOk === 0) { console.error("macro-kit: FAILED"); process.exit(1); }
console.log("macro-kit: OK");
