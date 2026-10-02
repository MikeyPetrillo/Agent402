// Macro-kit tests — same shape as test-data-kit.js: strict on our validation
// logic (offline, deterministic) and tolerant of any single flaky upstream
// (Treasury Fiscal Data, Frankfurter/ECB, or World Bank). Fails only if an
// assertion breaks or if EVERY live call fails (which would mean our
// integration is broken, not one upstream).
import { MACRO_TOOLS, retryTransient, withStaleFallback } from "../src/tools/macro-kit.js";

const h = (slug) => MACRO_TOOLS.find((t) => t.slug === slug).handler;
let assertFail = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) console.log(`ok - ${m}`); else { assertFail++; console.error(`ASSERT FAIL - ${m}`); } };

// --- retry policy (offline, deterministic) — locks the fix for the treasury
// 504s: retry transient transport failures, NEVER a deterministic 4xx. ---
{
  const mk = (failN, sc) => { let n = 0; return async () => { n++; if (n <= failN) throw Object.assign(new Error("boom"), { statusCode: sc }); return { n }; }; };
  const r = await retryTransient(mk(1, 504), { retries: 1, backoffMs: 0 });
  ok(r.n === 2, "retryTransient retries a 504 once, then succeeds (2 attempts)");
  try { await retryTransient(mk(9, 503), { retries: 1, backoffMs: 0 }); ok(false, "persistent 503 should throw after retries exhausted"); }
  catch (e) { ok(e.statusCode === 503, `persistent 503 throws the last error (got ${e.statusCode})`); }
  const det = mk(9, 422);
  try { await retryTransient(det, { retries: 1, backoffMs: 0 }); ok(false, "422 should throw"); }
  catch (e) { ok(e.statusCode === 422, `deterministic 422 throws (got ${e.statusCode})`); }
  // The 422 thunk must have been called EXACTLY once — no retry burned.
  let onceCount = 0;
  try { await retryTransient(async () => { onceCount++; throw Object.assign(new Error("x"), { statusCode: 400 }); }, { retries: 2, backoffMs: 0 }); } catch { /* expected */ }
  ok(onceCount === 1, `a deterministic 4xx is never retried (called ${onceCount}× of a possible 3)`);
}

// --- stale fallback (offline, deterministic) — locks the fix for the
// 2026-07-16 FRED /releases/dates outage: a transient upstream failure serves
// the last-good snapshot (marked stale), a deterministic 4xx never does, and
// snapshots expire. ---
{
  const boom = (sc) => async () => { throw Object.assign(new Error("boom"), { statusCode: sc }); };
  const m = new Map();
  let t = 1_000_000;
  const now = () => t;
  const fresh = await withStaleFallback(m, 14, async () => ({ days: 14, count: 2 }), { maxStaleMs: 1_000, now });
  ok(fresh.count === 2 && fresh.stale === undefined, "success path returns the fresh payload and caches it");
  const stale = await withStaleFallback(m, 14, boom(504), { maxStaleMs: 1_000, now });
  ok(stale.count === 2 && stale.stale === true && typeof stale.staleAsOf === "string", "504 within the window serves last-good marked stale");
  ok(m.get(14).payload.stale === undefined, "the stale flag never contaminates the cached copy");
  try { await withStaleFallback(m, 14, boom(400), { maxStaleMs: 1_000, now }); ok(false, "deterministic 400 must throw, never serve stale"); }
  catch (e) { ok(e.statusCode === 400, `deterministic 400 throws (got ${e.statusCode})`); }
  t += 2_000; // step past maxStaleMs
  try { await withStaleFallback(m, 14, boom(504), { maxStaleMs: 1_000, now }); ok(false, "an expired snapshot must not be served"); }
  catch (e) { ok(e.statusCode === 504, `504 past the stale window rethrows (got ${e.statusCode})`); }
  try { await withStaleFallback(m, 99, boom(504), { maxStaleMs: 1_000, now }); ok(false, "a key with no snapshot must throw"); }
  catch (e) { ok(e.statusCode === 504, `504 with no snapshot rethrows (got ${e.statusCode})`); }
}

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

// --- FRED refusing OUR key is our configuration (503), and a "." month is
// reported, not silently dropped. Stubbed upstream, forced key. ---
{
  const realFetch = globalThis.fetch, realKey = process.env.FRED_API_KEY;
  process.env.FRED_API_KEY = "0123456789abcdef0123456789abcdef";
  try {
    let keyCalls = 0;
    globalThis.fetch = async () => (keyCalls++, new Response(JSON.stringify({ error_code: 400, error_message: "Bad Request.  The value for variable api_key is not a 32 character alpha-numeric lower-case string." }), { status: 400, headers: { "content-type": "application/json" } }));
    try { await h("unemployment-rate")({ months: 3 }); ok(false, "a rejected FRED key should throw"); }
    catch (e) { ok(e.statusCode === 503 && /our configuration/.test(e.message), `a rejected FRED key is a 503 naming our configuration, not a 422 (got ${e.statusCode})`); }
    ok(keyCalls === 1, `a rejected key is not retried: retrying cannot fix it (upstream calls: ${keyCalls})`);
    globalThis.fetch = async () => new Response(JSON.stringify({ observations: [
      { date: "2026-08-01", value: "4.1" }, { date: "2026-07-01", value: "4.1" }, { date: "2025-10-01", value: "." }, { date: "2025-09-01", value: "4.4" },
    ] }), { status: 200, headers: { "content-type": "application/json" } });
    const r = await h("unemployment-rate")({ months: 4 });
    ok(r.months === 3 && r.history[0].date === "2025-09-01" && r.current === 4.1, "unemployment-rate keeps chronological order and the real values");
    ok(Array.isArray(r.missingDates) && r.missingDates[0] === "2025-10-01" && /3 of the 4 months/.test(r.note || ""), "a month FRED published as \".\" is listed in missingDates with a note");
    globalThis.fetch = async () => new Response(JSON.stringify({ observations: [{ date: "2026-09-22", value: "3.88" }] }), { status: 200, headers: { "content-type": "application/json" } });
    const f = await h("fed-funds")({ days: 1 });
    ok(f.current === 3.88 && f.missingDates === undefined, "no missingDates field when nothing is missing");
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.FRED_API_KEY; else process.env.FRED_API_KEY = realKey;
  }
}

console.log(`\nvalidation asserts failed: ${assertFail} | live ok: ${liveOk} | live upstream-errors (tolerated): ${liveErr}`);
if (assertFail > 0 || liveOk === 0) { console.error("macro-kit: FAILED"); process.exit(1); }
console.log("macro-kit: OK");
