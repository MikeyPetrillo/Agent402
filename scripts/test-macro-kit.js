// Macro-kit tests — same shape as test-data-kit.js: strict on our validation
// logic (offline, deterministic) and tolerant of any single flaky upstream
// (Treasury Fiscal Data, Frankfurter/ECB, or World Bank). Fails only if an
// assertion breaks or if EVERY live call fails (which would mean our
// integration is broken, not one upstream).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { stubGuardResolver, offlineGuardAnswer } from "./lib/guard-resolver-stub.js";
import { MACRO_TOOLS, retryTransient, withStaleFallback, parseTreasuryYieldCsv, treasuryYieldCsvUrl, TREASURY_YIELD_SOURCE, _resetTreasuryYieldCacheForTest, refreshTreasuryYields, startTreasuryYieldRefresh, stopTreasuryYieldRefresh } from "../src/tools/macro-kit.js";

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

// --- FRED throttling is a retryable 503, never a 422 that blames the input
// (stubbed fetch; no key spent) ---
{
  const realFetch = globalThis.fetch, realKey = process.env.FRED_API_KEY;
  const undoDns = stubGuardResolver(offlineGuardAnswer); // stubbed fetch: the guard's lookup answers here too
  process.env.FRED_API_KEY = "fred-test-not-a-key";
  let calls = 0;
  try {
    for (const st of [429, 423]) {
      calls = 0;
      globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error_code: st, error_message: "Too Many Requests.  Exceeded Rate Limit" }), { status: st, headers: { "content-type": "application/json" } }); };
      let e = null;
      try { await h("fred-series")({ seriesId: "UNRATE" }); } catch (x) { e = x; }
      ok(e?.statusCode === 503 && /temporarily unavailable/.test(e.message), `FRED ${st} -> 503 temporarily unavailable (got ${e?.statusCode})`);
      ok(calls === 1, `FRED ${st} is not hammered with retries (calls ${calls})`);
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ error_code: 400, error_message: "Bad Request.  The value for variable api_key is not registered." }), { status: 400, headers: { "content-type": "application/json" } });
    let e = null;
    try { await h("fred-series")({ seriesId: "UNRATE" }); } catch (x) { e = x; }
    ok(e?.statusCode === 503 && /not configured/.test(e.message) && !/registered|api_key/.test(e.message), "a key refusal says not configured and relays no key detail");
  } finally {
    globalThis.fetch = realFetch;
    undoDns();
    if (realKey === undefined) delete process.env.FRED_API_KEY; else process.env.FRED_API_KEY = realKey;
  }
}

// --- FRED's scheduled-maintenance page (HTML, HTTP 200) is an upstream
// outage: a 503 with a retry hint, never a generic 502 (stubbed fetch) ---
{
  const realFetch = globalThis.fetch, realKey = process.env.FRED_API_KEY;
  const undoDns = stubGuardResolver(offlineGuardAnswer); // stubbed fetch: the guard's lookup answers here too
  process.env.FRED_API_KEY = "fred-test-not-a-key";
  const page = '<!doctype html>\n<html lang="en">\n<head>\n    <title>Site Maintenance | St. Louis Fed</title>';
  try {
    globalThis.fetch = async () => new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    for (const slug of ["fred-series"]) {
      let e = null;
      try { await h(slug)({ seriesId: "UNRATE" }); } catch (x) { e = x; }
      ok(e?.statusCode === 503 && /scheduled maintenance/.test(e.message) && e.retryAfter === 900 && e.attribution === "upstream", `${slug}: FRED maintenance page -> 503 with retryAfter (got ${e?.statusCode} ${e?.message})`);
    }
  } finally {
    globalThis.fetch = realFetch;
    undoDns();
    if (realKey === undefined) delete process.env.FRED_API_KEY; else process.env.FRED_API_KEY = realKey;
  }
}

// --- the yield-curve tools read the U.S. Treasury's par yield curve CSV
// (offline: parser and a stubbed fetch) ---
{
  // Columns by header name, extra Treasury tenors ignored, MM/DD/YYYY to ISO,
  // oldest first, an empty cell is null, a row with no yield is dropped.
  const csv = [
    `Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"`,
    "11/13/2026,4.10,4.18,4.26,4.32,4.34,4.42,4.65,4.88,4.92,4.98,5.05,5.15,5.52,5.47",
    "11/12/2026,4.12,4.18,4.26,4.32,4.35,4.42,4.65,4.86,4.90,4.95,5.02,5.10,5.48,",
    "11/11/2026,,,,,,,,,,,,,,",
  ].join("\r\n");
  const rows = parseTreasuryYieldCsv(csv);
  ok(rows.length === 2 && rows[0].recordDate === "2026-11-12" && rows[1].recordDate === "2026-11-13", `Treasury rows are ISO-dated, oldest first, empty days dropped (${rows.map((r) => r.recordDate).join(", ")})`);
  ok(JSON.stringify(rows[1]) === JSON.stringify({ recordDate: "2026-11-13", mo1: 4.10, mo3: 4.32, mo6: 4.42, yr1: 4.65, yr2: 4.88, yr3: 4.92, yr5: 4.98, yr7: 5.05, yr10: 5.15, yr20: 5.52, yr30: 5.47 }),
    `the eleven published tenors map by column name and the 1.5, 2 and 4 month columns are not read (${JSON.stringify(rows[1])})`);
  ok(rows[0].yr30 === null, "an empty tenor cell is null");
  const older = `Date,"1 Mo","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"\n01/02/2024,5.55,5.54,5.46,5.41,5.24,4.80,4.33,4.09,3.93,3.95,3.95,4.25,4.08`;
  ok(parseTreasuryYieldCsv(older)[0].yr10 === 3.95, "a year file without the newer columns parses by name");
  ok(parseTreasuryYieldCsv(csv.split("\r\n")[0]).length === 0, "a year file with a header and no rows is an empty year, not an error");
  for (const [bad, label] of [["<!doctype html><html><title>Down</title>", "a web page"], ["Date,1 Mo\n11/13/2026,4.1", "missing tenor columns"], ["", "an empty body"]]) {
    let e = null; try { parseTreasuryYieldCsv(bad); } catch (x) { e = x; }
    ok(e?.statusCode === 502, `${label} in place of the CSV is a 502 (got ${e?.statusCode})`);
  }
  ok(new URL(treasuryYieldCsvUrl(2026)).host === "home.treasury.gov" && /\/2026\//.test(treasuryYieldCsvUrl(2026)), "the CSV is read from home.treasury.gov, one file per year");

  // Handlers on a stubbed fetch: the current year first, an earlier year only
  // when the window needs more rows; each year read once (cached).
  const realFetch = globalThis.fetch;
  const undoDns = stubGuardResolver(offlineGuardAnswer);
  const Y = new Date().getUTCFullYear();
  const header = `Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"`;
  const line = (mmdd, y, ten) => `${mmdd}/${y},4.1,4.1,4.1,4.3,4.3,4.4,4.6,4.8,4.9,4.9,5.0,${ten},5.5,5.4`;
  const files = {
    [Y]: [header, line("01/06", Y, "5.10"), line("01/05", Y, "5.05"), line("01/02", Y, "5.00")].join("\n"),
    [Y - 1]: [header, line("12/31", Y - 1, "4.90"), line("12/30", Y - 1, "4.80"), line("12/29", Y - 1, "4.70")].join("\n"),
  };
  const reads = [];
  try {
    _resetTreasuryYieldCacheForTest();
    globalThis.fetch = async (url) => {
      const u = new URL(String(url?.url || url));
      const y = Number(u.pathname.split("/").find((p) => /^\d{4}$/.test(p)));
      reads.push(`${u.host}:${y}`);
      return new Response(files[y] ?? header, { status: 200, headers: { "content-type": "text/csv" } });
    };
    const curve = await h("treasury-yield-curve")({});
    ok(curve.recordDate === `${Y}-01-06` && curve.yr10 === 5.1 && curve.source === TREASURY_YIELD_SOURCE && curve.unit === "percent", `curve: the latest row of the current year, with unit and source (${JSON.stringify(curve)})`);
    ok(JSON.stringify(reads) === JSON.stringify([`home.treasury.gov:${Y}`]), `curve: one read, the current year only (${reads.join(", ")})`);
    const two = await h("treasury-yield-history")({ days: 2 });
    ok(two.days === 2 && two.count === 2 && two.history[0].recordDate === `${Y}-01-05` && reads.length === 1, `history inside the current year reads nothing more (${reads.length} reads)`);
    const five = await h("treasury-yield-history")({ days: 5 });
    ok(five.count === 5 && five.history[0].recordDate === `${Y - 1}-12-30` && five.history[4].recordDate === `${Y}-01-06`, `history across New Year joins the earlier year, oldest first (${five.history.map((r) => r.recordDate).join(", ")})`);
    ok(JSON.stringify(reads) === JSON.stringify([`home.treasury.gov:${Y}`, `home.treasury.gov:${Y - 1}`]), `history reads the earlier year only when the window needs it (${reads.join(", ")})`);
    const all = await h("treasury-yield-history")({ days: 250 });
    ok(all.count === 6 && reads.length === 3 && reads[2] === `home.treasury.gov:${Y - 2}`, `a window longer than the files stops after three years (${all.count} rows, ${reads.join(", ")})`);
    const spread = await h("yield-curve-spread")({});
    ok(spread.spread2s10sBps === 30 && spread.spread3m10yBps === 80 && spread.inverted2s10s === false && spread.asOf === TREASURY_YIELD_SOURCE, `spread: computed from the latest row (${JSON.stringify(spread)})`);

    // A slow upstream: every file answers after `delay` ms, under a short
    // budget (TREASURY_YIELD_BUDGET_MS) so the bound is measured, not waited out.
    const fullYear = (y, n) => [header, ...Array.from({ length: n }, (_, k) => {
      const d = new Date(Date.UTC(y, 0, 2 + k)); return line(`${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`, y, "4.50");
    }).reverse()].join("\n");
    const big = { [Y]: fullYear(Y, 230), [Y - 1]: fullYear(Y - 1, 250) };
    let delay = 0, failWith = 0;
    const slowReads = [];
    globalThis.fetch = async (url) => {
      const u = new URL(String(url?.url || url));
      const y = Number(u.pathname.split("/").find((p) => /^\d{4}$/.test(p)));
      slowReads.push(y);
      await new Promise((r) => setTimeout(r, delay));
      if (failWith) return new Response("down", { status: failWith, headers: { "content-type": "text/plain" } });
      return new Response(big[y] ?? header, { status: 200, headers: { "content-type": "text/csv" } });
    };
    const realBudget = process.env.TREASURY_YIELD_BUDGET_MS;
    process.env.TREASURY_YIELD_BUDGET_MS = "700";
    try {
      // 1. Cold, two years needed: read together, so 2 x 400 ms fits a 700 ms bound.
      _resetTreasuryYieldCacheForTest(); delay = 400;
      let t0 = Date.now(), r = null, err = null;
      try { r = await h("treasury-yield-history")({ days: 250 }); } catch (x) { err = x; }
      const coldMs = Date.now() - t0;
      ok(r?.count === 250 && coldMs < 700 && slowReads.slice(-2).sort().join() === [Y - 1, Y].sort().join(), `cold multi-year history reads both years at once and answers inside the bound (${coldMs} ms, ${r?.count ?? err?.message})`);
      // 2. Past the bound: 503 with Retry-After, before any answer (so nothing is
      //    settled); the read runs on and fills the cache for the next call.
      _resetTreasuryYieldCacheForTest(); delay = 1_200;
      t0 = Date.now(); err = null; r = null;
      try { r = await h("treasury-yield-curve")({}); } catch (x) { err = x; }
      const capMs = Date.now() - t0;
      ok(!r && err?.statusCode === 503 && err.retryAfter > 0 && /nothing was charged/.test(err.message) && capMs < 1_000, `a slow upstream past the bound answers 503 with Retry-After at the bound (${capMs} ms, ${err?.statusCode} retryAfter=${err?.retryAfter})`);
      await new Promise((res) => setTimeout(res, 800));
      t0 = Date.now(); r = await h("treasury-yield-curve")({});
      const warmMs = Date.now() - t0;
      ok(r.recordDate && warmMs < 50 && !r.stale, `the read it started filled the cache: the next call answers warm (${warmMs} ms)`);
      // 3. A refresh that fails: the held rows are served, marked stale.
      delay = 0; failWith = 502;
      const pass = await refreshTreasuryYields(Date.now() + 31 * 60_000);
      r = await h("yield-curve-spread")({});
      ok(pass.failed >= 1 && r.stale === true && typeof r.staleAsOf === "string" && typeof r.spread2s10sBps === "number", `a failed refresh serves the held rows marked stale (${JSON.stringify(r)})`);
      r = await h("treasury-yield-history")({ days: 5 });
      ok(r.count === 5 && r.stale === true, "history from a held year whose refresh failed is marked stale too");
      // 4. The background refresh reads with no request: boot pass, single flight.
      _resetTreasuryYieldCacheForTest(); failWith = 0; delay = 50;
      const before = slowReads.length;
      startTreasuryYieldRefresh({ firstDelayMs: 0 });
      ok(startTreasuryYieldRefresh() === false, "starting the refresh twice keeps one timer");
      await new Promise((res) => setTimeout(res, 300));
      stopTreasuryYieldRefresh();
      const bg = slowReads.slice(before).sort();
      ok(bg.join() === [Y - 1, Y].sort().join(), `the boot pass reads this year and last year once each, with no request (${bg.join(", ")})`);
      t0 = Date.now(); r = await h("treasury-yield-history")({ days: 250 });
      ok(r.count === 250 && Date.now() - t0 < 50 && slowReads.length === before + 2, "after the boot pass a 250-day window is served from memory");
    } finally {
      if (realBudget === undefined) delete process.env.TREASURY_YIELD_BUDGET_MS; else process.env.TREASURY_YIELD_BUDGET_MS = realBudget;
    }
  } finally {
    globalThis.fetch = realFetch;
    undoDns();
    _resetTreasuryYieldCacheForTest();
  }
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
  const undoDns = stubGuardResolver(offlineGuardAnswer); // stubbed fetch: the guard's lookup answers here too
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
    undoDns();
    if (realKey === undefined) delete process.env.FRED_API_KEY; else process.env.FRED_API_KEY = realKey;
  }
}

console.log(`\nvalidation asserts failed: ${assertFail} | live ok: ${liveOk} | live upstream-errors (tolerated): ${liveErr}`);
if (assertFail > 0 || liveOk === 0) { console.error("macro-kit: FAILED"); process.exit(1); }
console.log("macro-kit: OK");
