// Macro-kit — live macroeconomic and rates data agents can't get from a frozen
// training set.
//
// Two tiers of sources:
//
//   1. Fully keyless (always works):
//      • US Treasury Daily Treasury Par Yield Curve Rates (home.treasury.gov,
//        keyless CSV per year, public domain) for the yield-curve tools
//      • US Treasury Fiscal Data API (api.fiscaldata.treasury.gov) — public
//        domain, for debt outstanding and average interest rates by security
//      • ECB reference rates via Frankfurter v2 (api.frankfurter.dev/v2, providers=ecb), ECB cited as the source
//      • World Bank Indicators API (api.worldbank.org) — open data
//
//   2. The agencies that publish the US labor, price and rate series
//      (src/tools/us-macro-series.js: the BLS Public Data API, the New York
//      Fed's Markets Data API, Treasury Fiscal Data) for fred-series and the
//      computed tools (sahm-rule, cpi-yoy, unemployment-rate, fed-funds).
//      No FRED data is served.
//
// Covers the cluster of macro/financial routes that show up across the x402
// ecosystem (yield curves, FX time series, GDP/inflation indicators, CPI YoY,
// fed funds, recession signals). Pure HTTP wrappers, deterministic.
import { safeFetch, retryTransient } from "./fetch-guard.js";
import { markEndsAtCeiling, ceilingLeftMs } from "../run-ceiling.js";
import { attribute, US_AGENCIES_ATTRIBUTION, BLS_ATTRIBUTION, NYFED_ATTRIBUTION, WORLD_BANK_LICENSE, WORLD_BANK_LICENSE_URL, worldBankCredit } from "../data-attribution.js";
import { notChargedOn, notChargedHere } from "../not-charged.js";
import { useHeldTreasuryYields, usMacroSeries, unsupportedSeriesError, SUPPORTED_IDS as US_MACRO_SUPPORTED_IDS, SUPPORTED_FREQ as US_MACRO_SUPPORTED_FREQ, TERMS as US_MACRO_TERMS } from "./us-macro-series.js";
import { ratesUrl, latestShape, seriesShape, isUnknownCurrency, ECB_FX_SOURCE, fxSourceUnavailable } from "./frankfurter.js";
import { markResaleCleared } from "../resale-terms.js";

// Moved to fetch-guard.js 2026-08-12 (now used by gov-kit.js and
// weather-kit.js too, not just here) — re-exported so this file's own
// consumers and test-macro-kit.js don't need an import-path change.
export { retryTransient };

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// api.fiscaldata.treasury.gov (and, more rarely, World Bank / Frankfurter)
// intermittently time out or return a transient gateway error on the first hit
// — observed as ~4-7% `504`s on treasury-debt / treasury-avg-rates. safeFetch
// makes ONE attempt, so a single blip becomes a paid caller's error. One retry
// with a short backoff clears the common single-blip case. Retry ONLY transient
// transport failures (504 timeout/network, 502/503 gateway); a 4xx/422 is
// deterministic, so retrying just wastes the caller's ~30s budget. Capped at one
// extra attempt so worst-case latency stays within a tool's time budget
// (2 × the 15s fetch timeout).

// Serve-stale-on-error for slow-moving datasets: the last successful payload
// is a strictly better answer than an error: on a TRANSIENT upstream failure (502/503/504 —
// the same set retryTransient covers) serve the last-good response for the
// same key, marked `stale: true` + `staleAsOf`, for up to maxStaleMs. A
// deterministic 4xx still throws — a caller mistake must never be masked by a
// cached success. Exported so the policy is unit-locked (test-macro-kit.js).
export async function withStaleFallback(lastGood, key, fn, { maxStaleMs, now = Date.now } = {}) {
  try {
    const payload = await fn();
    lastGood.set(key, { payload, at: now() });
    return payload;
  } catch (e) {
    const sc = e?.statusCode;
    const prev = lastGood.get(key);
    if ((sc === 502 || sc === 503 || sc === 504) && prev && now() - prev.at <= maxStaleMs) {
      return {
        ...prev.payload,
        stale: true,
        staleAsOf: new Date(prev.at).toISOString(),
        staleReason: `The upstream failed (${sc}) - serving the last successful snapshot`,
      };
    }
    throw e;
  }
}

// 24h of staleness is acceptable for the wrapped dataset: Treasury average
// rates are monthly; past a day, an error is more honest than a snapshot.
const MACRO_STALE_MAX_MS = 24 * 3600 * 1000;
// Last-good Treasury average-rates payload (no params — one fixed key).
// fiscaldata.treasury.gov still flakes ~1/day past the 3-attempt FISCAL_FETCH
// retry profile; monthly data deserves a snapshot, not a 504.
const treasuryAvgLastGood = new Map();

async function safeFetchRetry(url, opts = {}) {
  const { retries, backoffMs, ...fetchOpts } = opts;
  return retryTransient(() => safeFetch(url, { ...fetchOpts, ownUpstream: true }), {
    ...(retries !== undefined ? { retries } : {}),
    ...(backoffMs !== undefined ? { backoffMs } : {}),
  });
}

// api.fiscaldata.treasury.gov blips arrive in back-to-back pairs (PostHog
// tool_error data, July 2026: the single default retry still lost ~2-4% of
// real calls daily). Three attempts with a shorter per-attempt timeout beat
// one-retry-at-15s on BOTH axes: worst case 3×8s+backoffs ≈ 25s vs 30s, and
// two extra chances at a feed that answers in <1s when it answers at all.
const FISCAL_FETCH = { retries: 2, backoffMs: 400, timeoutMs: 8_000 };

// fx-dashboard's read of the ECB rates gets a short per-attempt leash and
// one retry, for the opposite reason to FISCAL_FETCH above: the host answers
// in ~0.06s warm but took 7.8s and 11.6s cold (measured 2026-08-03), so a
// first attempt that is merely slow is cut at 5s and the retry meets a warm
// host. Worst case 5s + 0.3s + 5s stays inside prod's 12s self-check, which
// recorded a 504 outage on the inherited 15s timeout. The ECB reference rates
// are the only source: past both attempts the dashboard serves its marked
// snapshot (up to a day old) or answers 503 with a retry hint.
const FX_PRIMARY = { retries: 1, timeoutMs: 5_000 };

async function getJson(url, opts = {}) {
  const { html } = await safeFetchRetry(url, { maxBytes: 5 * 1024 * 1024, ...opts });
  try {
    return JSON.parse(html);
  } catch {
    throw bad("Upstream returned non-JSON", 502);
  }
}

// The US Treasury's own Daily Treasury Par Yield Curve Rates (public domain,
// keyless): one CSV per calendar year, newest row first, dates MM/DD/YYYY.
// These are the yields the Federal Reserve's H.15 constant-maturity series
// are taken from, value for value.
//
// Tenor map, by header name (Treasury has added columns over the years, so
// positions are never assumed): the eleven tenors these tools publish come
// from the columns of the same maturity. Treasury also publishes 1.5, 2 and 4
// month columns; no tool publishes those tenors, so they are not read. Every
// published tenor has a Treasury column; an empty cell (a tenor not yet or no
// longer issued on that day) is null.
const TREASURY_YIELD_TENORS = [
  ["1 Mo", "mo1"], ["3 Mo", "mo3"], ["6 Mo", "mo6"],
  ["1 Yr", "yr1"], ["2 Yr", "yr2"], ["3 Yr", "yr3"],
  ["5 Yr", "yr5"], ["7 Yr", "yr7"], ["10 Yr", "yr10"],
  ["20 Yr", "yr20"], ["30 Yr", "yr30"],
];
export const TREASURY_YIELD_SOURCE = "U.S. Treasury Daily Treasury Par Yield Curve Rates";

export function treasuryYieldCsvUrl(year) {
  return `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&_format=csv`;
}

const unquote = (s) => String(s ?? "").trim().replace(/^"|"$/g, "");

// One year's CSV -> rows in the tools' shape ({recordDate, mo1 ... yr30}),
// oldest first. A row with no yield at all is dropped. A file with a header
// and no rows (the first days of January) is an empty year, not an error.
export function parseTreasuryYieldCsv(csv) {
  const text = String(csv || "");
  if (/^\s*</.test(text)) throw bad("U.S. Treasury returned a web page in place of the yield curve file", 502);
  const lines = text.trim().split(/\r?\n/);
  const header = (lines[0] || "").split(",").map(unquote);
  if (header[0] !== "Date") throw bad("U.S. Treasury yield curve file has no Date column", 502);
  const colIdx = TREASURY_YIELD_TENORS.map(([col]) => header.indexOf(col));
  if (lines.length > 1 && colIdx.some((i) => i < 0)) throw bad("U.S. Treasury yield curve file is missing expected tenor columns", 502);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map(unquote);
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(cells[0]);
    if (!m) continue;
    const out = { recordDate: `${m[3]}-${m[1]}-${m[2]}` };
    let hasAny = false;
    TREASURY_YIELD_TENORS.forEach(([, dst], j) => {
      const raw = cells[colIdx[j]];
      const n = raw == null || raw === "" || raw === "N/A" ? NaN : Number(raw);
      if (Number.isFinite(n)) { out[dst] = n; hasAny = true; } else out[dst] = null;
    });
    if (hasAny) rows.push(out);
  }
  rows.sort((a, b) => (a.recordDate < b.recordDate ? -1 : a.recordDate > b.recordDate ? 1 : 0));
  return rows;
}

// The Treasury host takes 15-20 s to build each file (measured 2026-11-15,
// the same for a month or a year), longer than a buyer can wait on a paid
// call. So the files are read in the background and served from memory:
//   - The current year's file is refreshed on a timer (every 30 minutes, and
//     shortly after boot in production; startTreasuryYieldRefresh), one read
//     at a time, never awaited by a request. A request that finds it older
//     than 30 minutes serves what is held and starts the same single read
//     without waiting for it. After a failed read it waits
//     TREASURY_YIELD_FAIL_BACKOFF_MS before starting another, serving what is
//     held meanwhile, so a fast-failing host is not read once per request.
//   - An earlier year's file is kept a day; the timer reads last year's too.
//   - When the latest refresh failed, or the held copy is past two refresh
//     periods, the answer is served marked stale (stale, staleAsOf), the
//     fx-dashboard convention, never a 502 or 504, for up to
//     TREASURY_YIELD_MAX_AGE_MS (3 days) after the held copy's last good
//     read; past that the held rows are not served: the call answers 503
//     with Retry-After (nothing is charged) and starts a read as above.
//   - A request that finds a year it needs not held at all (a cold process)
//     reads every needed year at once and waits at most its budget
//     (TREASURY_YIELD_BUDGET_MS, inside the hosted connector's wait and the
//     payment window); past it, it answers 503 with Retry-After, and nothing
//     is charged (a status of 400 or more is never settled). The read it
//     started runs on, up to TREASURY_YIELD_READ_MS, and fills the cache.
// The cache is this process's memory only, so each replica keeps its own and
// no lease orders the timer: there is no shared state for two to race on.
const TREASURY_YIELD_READ_MS = 45_000;
const TREASURY_YIELD_BUDGET_MS = 20_000;
const TREASURY_YIELD_REFRESH_MS = 30 * 60 * 1000;
const TREASURY_YIELD_PAST_TTL_MS = 24 * 3600 * 1000;
const TREASURY_YIELD_STALE_MS = 2 * TREASURY_YIELD_REFRESH_MS + 5 * 60 * 1000;
const TREASURY_YIELD_RETRY_AFTER_S = 30;
const TREASURY_YIELD_FAIL_BACKOFF_MS = 60_000;
/** The oldest last good read whose rows are still served (marked stale). */
export const TREASURY_YIELD_MAX_AGE_MS = 3 * 24 * 3600 * 1000;
const treasuryYieldYears = new Map(); // year -> { at, rows, failedAt }
const treasuryYieldReads = new Map(); // year -> in-flight read (single flight)
const treasuryYieldTimer = { interval: null, boot: null };
// fred-series' Treasury constant maturities read the years held here.
useHeldTreasuryYields((year) => treasuryYieldYears.get(year) || null);
export function _resetTreasuryYieldCacheForTest() { stopTreasuryYieldRefresh(); treasuryYieldYears.clear(); treasuryYieldReads.clear(); }
// Moves every held year's read and failure times `ms` into the past.
export function _ageTreasuryYieldCacheForTest(ms) {
  for (const e of treasuryYieldYears.values()) { e.at -= ms; if (e.failedAt) e.failedAt -= ms; }
}

const treasuryYieldBudgetMs = () => {
  const n = Number(process.env.TREASURY_YIELD_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : TREASURY_YIELD_BUDGET_MS;
};

// One read of one year's file, shared by everyone who asks while it runs. It
// holds no request's deadline: it ends at its own cap and fills the cache.
function readTreasuryYear(year) {
  const running = treasuryYieldReads.get(year);
  if (running) return running;
  const read = (async () => {
    try {
      const { html } = await safeFetchRetry(treasuryYieldCsvUrl(year), { maxBytes: 5 * 1024 * 1024, retries: 0, timeoutMs: TREASURY_YIELD_READ_MS });
      const rows = parseTreasuryYieldCsv(html);
      treasuryYieldYears.set(year, { at: Date.now(), rows, failedAt: 0 });
      const keep = new Date().getUTCFullYear() - 2;
      for (const y of [...treasuryYieldYears.keys()]) if (y < keep) treasuryYieldYears.delete(y);
      return rows;
    } catch (e) {
      const held = treasuryYieldYears.get(year);
      if (held) held.failedAt = Date.now();
      console.warn(`[treasury-yield] ${year} file read failed (${String(e?.message || e).slice(0, 120)})`);
      throw e;
    } finally {
      treasuryYieldReads.delete(year);
    }
  })();
  treasuryYieldReads.set(year, read);
  read.catch(() => {}); // a background read's failure is logged above, never unhandled
  return read;
}

/** One refresh pass: the current year's file when older than the refresh
 *  period, last year's when older than a day. Never throws. */
export async function refreshTreasuryYields(now = Date.now()) {
  const year = new Date(now).getUTCFullYear();
  const due = [];
  const cur = treasuryYieldYears.get(year);
  if (!cur || now - cur.at >= TREASURY_YIELD_REFRESH_MS - 60_000) due.push(year);
  const prev = treasuryYieldYears.get(year - 1);
  if (!prev || now - prev.at >= TREASURY_YIELD_PAST_TTL_MS) due.push(year - 1);
  const results = await Promise.allSettled(due.map(readTreasuryYear));
  return { read: due, failed: results.filter((r) => r.status === "rejected").length };
}

/** Start the background refresh (idempotent): a first pass shortly after
 *  boot, then every 30 minutes. Timers are unref'd. */
export function startTreasuryYieldRefresh({ firstDelayMs = 5_000 } = {}) {
  if (treasuryYieldTimer.interval) return false;
  const tick = () => { refreshTreasuryYields().catch(() => {}); };
  treasuryYieldTimer.boot = setTimeout(tick, firstDelayMs);
  treasuryYieldTimer.boot.unref?.();
  treasuryYieldTimer.interval = setInterval(tick, TREASURY_YIELD_REFRESH_MS);
  treasuryYieldTimer.interval.unref?.();
  return true;
}
/** True while the background refresh timer is armed. */
export function treasuryYieldRefreshRunning() { return Boolean(treasuryYieldTimer.interval); }
export function stopTreasuryYieldRefresh() {
  if (treasuryYieldTimer.boot) clearTimeout(treasuryYieldTimer.boot);
  if (treasuryYieldTimer.interval) clearInterval(treasuryYieldTimer.interval);
  treasuryYieldTimer.boot = treasuryYieldTimer.interval = null;
}
// Production starts it at import (the image sets NODE_ENV=production; Railway
// sets RAILWAY_ENVIRONMENT_NAME). A FREE_MODE boot and every test leave it off
// unless they ask (TREASURY_YIELD_REFRESH=on, or startTreasuryYieldRefresh());
// TREASURY_YIELD_REFRESH=off disarms it anywhere.
{
  const sw = String(process.env.TREASURY_YIELD_REFRESH || "").toLowerCase();
  const production = process.env.NODE_ENV === "production" || !!process.env.RAILWAY_ENVIRONMENT_NAME;
  if (sw === "on" || (sw !== "off" && production && process.env.FREE_MODE !== "true")) startTreasuryYieldRefresh();
}

function treasuryYieldUnavailable(cause) {
  console.warn(`[treasury-yield] answered 503 (${String(cause?.message || cause).slice(0, 120)})`);
  return Object.assign(
    bad(`The U.S. Treasury yield curve file could not be read in time.${notChargedHere()} Retry in ${TREASURY_YIELD_RETRY_AFTER_S} s.`, 503),
    { retryAfter: TREASURY_YIELD_RETRY_AFTER_S, attribution: "upstream", upstreamFailure: "deadline" },
  );
}

// Business days of `year` up to `now`, less a margin for holidays: how many
// rows the current year's file can hold, before it is read.
function rowsSoFar(now) {
  const d = new Date(now), start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const days = Math.floor((now - start) / 86400_000) + 1;
  return Math.max(0, Math.floor((days * 5) / 7) - 12);
}

// The last `count` published days, oldest first, with the stale marks of the
// years they came from. Held years answer at once. The years not held are
// read together, all under one budget: the current year, plus earlier ones
// while the rows held (or, for a year not held, the rows it can hold) fall
// short of `count`; if a file holds fewer rows than that, the next earlier
// year is read under what is left of the same budget. `count` is at most
// 250, so at most three years are ever needed.
async function fetchTreasuryYields(count = 1) {
  const now = Date.now();
  const year = new Date(now).getUTCFullYear();
  const cur = treasuryYieldYears.get(year);
  // Refresh, not awaited; held off for a while after a failed read.
  if (cur && now - cur.at >= TREASURY_YIELD_REFRESH_MS && !(cur.failedAt > cur.at && now - cur.failedAt < TREASURY_YIELD_FAIL_BACKOFF_MS)) readTreasuryYear(year);
  const budget = Math.max(1, Math.min(treasuryYieldBudgetMs(), ceilingLeftMs()));
  let timer = null, deadline = null;
  try {
    for (;;) {
      const years = [];
      let expect = 0;
      for (let y = year; y >= year - 2 && expect < count; y--) {
        years.push(y);
        const e = treasuryYieldYears.get(y);
        expect += e ? e.rows.length : y === year ? rowsSoFar(now) : 245;
      }
      // Done once every year counted is held: then the held rows cover
      // `count`, or all three years are held.
      const missing = years.filter((y) => !treasuryYieldYears.get(y));
      if (!missing.length) break;
      if (!deadline) {
        deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${budget} ms`)), budget); timer.unref?.(); });
      }
      try {
        await Promise.race([Promise.all(missing.map(readTreasuryYear)), deadline]);
      } catch (e) {
        throw treasuryYieldUnavailable(e);
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Newest year first, until `count` rows: the years the answer is built
  // from, and the stale mark of any of them.
  let rows = [], staleAt = 0;
  for (let y = year; y >= year - 2 && rows.length < count; y--) {
    const e = treasuryYieldYears.get(y);
    if (!e) break;
    if (!e.rows.length) continue;
    // Past the age limit the held rows are not an answer (the read the call
    // started above, or the timer's, brings them back).
    if (now - e.at >= TREASURY_YIELD_MAX_AGE_MS) throw treasuryYieldUnavailable(new Error(`held ${y} yields are ${Math.round((now - e.at) / 3_600_000)} h old, past the ${TREASURY_YIELD_MAX_AGE_MS / 3_600_000} h limit`));
    rows = e.rows.concat(rows);
    const stale = e.failedAt > e.at || now - e.at >= (y === year ? TREASURY_YIELD_STALE_MS : TREASURY_YIELD_PAST_TTL_MS + TREASURY_YIELD_STALE_MS);
    if (stale) staleAt = staleAt ? Math.min(staleAt, e.at) : e.at;
  }
  if (!rows.length) throw treasuryYieldUnavailable(new Error("no usable yield rows"));
  return { rows: rows.slice(-count), stale: staleAt ? { stale: true, staleAsOf: new Date(staleAt).toISOString() } : {} };
}

async function fetchLatestYieldCurve() {
  const { rows, stale } = await fetchTreasuryYields(1);
  return { curve: rows[rows.length - 1], stale };
}

// FRED answers a scheduled maintenance window with an HTML page (HTTP 200) in
// place of data. That is the upstream's own outage: a 503 that says so, with a
// retry hint, never a generic 502. Uncharged like every refusal.
export function isFredMaintenancePage(text) {
  const head = String(text || "").slice(0, 2000);
  return /<html[\s>]/i.test(head) && /maintenance/i.test(head);
}
export function fredMaintenanceError() {
  return Object.assign(bad(`FRED (St. Louis Fed) is in scheduled maintenance and is serving no data right now.${notChargedHere()} Retry later.`, 503), { retryAfter: 900, attribution: "upstream", noRetry: true });
}

// G10 majors quoted vs USD — the standard FX dashboard most callers want.
const G10 = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK"];
// fx-dashboard cache: ECB reference rates change once per business day, so a
// 30-min fresh window serves identical data cheaper, and a 24h serve-stale
// (marked stale:true, Tier-3 convention) covers dual-upstream outages.
const FX_DASH_TTL_MS = 30 * 60 * 1000;
const FX_DASH_STALE_MS = 24 * 60 * 60 * 1000;
let fxDashCache = null;

export const MACRO_TOOLS = [
  {
    route: "GET /api/treasury-yield-curve", name: "US Treasury daily yield curve", slug: "treasury-yield-curve", category: "data", attribution: "us-treasury", price: "$0.001",
    description:
      "Latest US Treasury daily par yield curve in one object: recordDate plus mo1, mo3, mo6, yr1, yr2, yr3, yr5, yr7, yr10, yr20 and yr30, each a yield in percent, from the Treasury's Daily Treasury Par Yield Curve Rates (public domain). No params - always returns the most recent published curve, which trails today by a business day or two; for a date range use treasury-yield-history. Source: U.S. Treasury.",
    tags: ["treasury", "yield-curve", "interest-rates", "rates", "macro", "bonds", "fed", "10-year", "yields"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: { example: { recordDate: "2026-09-22", mo1: 3.97, mo3: 4.16, mo6: 4.26, yr1: 4.43, yr2: 4.71, yr3: 4.81, yr5: 4.83, yr7: 4.89, yr10: 4.96, yr20: 5.33, yr30: 5.29, unit: "percent", source: "U.S. Treasury Daily Treasury Par Yield Curve Rates" } },
    },
    // unit + source were absent: a bare object of numbers did not say what it
    // measured or where it came from.
    handler: async () => {
      const { curve, stale } = await fetchLatestYieldCurve();
      return { ...curve, unit: "percent", source: TREASURY_YIELD_SOURCE, ...stale };
    },
  },
  {
    route: "GET /api/treasury-yield-history", name: "US Treasury yield history", slug: "treasury-yield-history", category: "data", attribution: "us-treasury", price: "$0.005",
    description:
      "Daily history of US Treasury par yields over the last N business days, oldest first: one row per day with recordDate and each maturity's yield in percent, from the Treasury's Daily Treasury Par Yield Curve Rates (public domain). ?days=30 (1-250, default 30). Source: U.S. Treasury.",
    tags: ["treasury", "yield-curve", "history", "interest-rates", "rates", "macro", "bonds", "time-series"],
    discovery: {
      input: { days: 30 },
      inputSchema: {
        properties: { days: { type: "number", description: "Number of business days, 1-250 (default 30)" } },
      },
      output: { example: { days: 30, count: 30, history: [{ recordDate: "2026-05-01", yr2: 3.88, yr10: 4.39 }] } },
    },
    handler: async (i) => {
      const days = Math.min(Math.max(parseInt(i.days, 10) || 30, 1), 250);
      // The last N published days, reading only the years they span.
      const { rows: tail, stale } = await fetchTreasuryYields(days);
      return { days, count: tail.length, history: tail, ...stale };
    },
  },
  {
    route: "GET /api/yield-curve-spread", name: "Treasury yield-curve spreads + inversion", slug: "yield-curve-spread", category: "data", attribution: "us-treasury", price: "$0.005",
    description:
      "Derived 2s10s and 3m10y Treasury yield-curve spreads (in basis points) plus a boolean flag per spread that is true when the curve is inverted. Computed from the Treasury's Daily Treasury Par Yield Curve Rates (public domain). No params. Source: U.S. Treasury.",
    tags: ["yield-curve", "spread", "2s10s", "3m10y", "inversion", "recession", "macro", "treasury", "rates", "bonds"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: { example: { recordDate: "2026-06-12", spread2s10sBps: 39, spread3m10yBps: 70, inverted2s10s: false, inverted3m10y: false, asOf: "U.S. Treasury Daily Treasury Par Yield Curve Rates" } },
    },
    handler: async () => {
      const { curve, stale } = await fetchLatestYieldCurve();
      const { yr2, yr10, mo3 } = curve;
      if (yr2 == null || yr10 == null || mo3 == null) throw bad("Required tenors missing from latest yield curve row", 502);
      const spread2s10sBps = Math.round((yr10 - yr2) * 100);
      const spread3m10yBps = Math.round((yr10 - mo3) * 100);
      return {
        recordDate: curve.recordDate,
        spread2s10sBps, spread3m10yBps,
        inverted2s10s: spread2s10sBps < 0,
        inverted3m10y: spread3m10yBps < 0,
        asOf: TREASURY_YIELD_SOURCE,
        ...stale,
      };
    },
  },
  {
    route: "GET /api/treasury-debt", name: "US total public debt outstanding", slug: "treasury-debt", category: "data", price: "$0.002",
    description:
      "Most recent total US public debt outstanding (the headline national-debt number, daily) from the Treasury \"Debt to the Penny\" feed. Public domain, no key. No params.",
    tags: ["national-debt", "treasury", "fiscal", "public-debt", "macro", "deficit", "government"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: { example: { recordDate: "2026-06-12", totalPublicDebtOutstanding: 35642101888471.22, source: "Treasury Fiscal Data API" } },
    },
    handler: async () => {
      const url = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page[size]=1";
      const j = await getJson(url, FISCAL_FETCH);
      const row = j?.data?.[0];
      if (!row) throw bad("Treasury debt feed unavailable", 502);
      return {
        recordDate: row.record_date ?? null,
        totalPublicDebtOutstanding: row.tot_pub_debt_out_amt != null ? Number(row.tot_pub_debt_out_amt) : null,
        debtHeldByPublic: row.debt_held_public_amt != null ? Number(row.debt_held_public_amt) : null,
        intragovernmentalHoldings: row.intragov_hold_amt != null ? Number(row.intragov_hold_amt) : null,
        source: "Treasury Fiscal Data API (public domain)",
      };
    },
  },
  {
    route: "GET /api/treasury-avg-rates", name: "Average interest rates on Treasury securities", slug: "treasury-avg-rates", category: "data", price: "$0.005",
    description:
      "Latest average interest rates the US Treasury is paying by security type (Bills, Notes, Bonds, TIPS, FRNs, marketable vs non-marketable). Public domain, no key. No params - returns the most recent reporting month.",
    tags: ["treasury", "interest-rates", "bills", "notes", "bonds", "tips", "frn", "macro", "cost-of-debt"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: { example: { recordDate: "2026-05-31", rates: [{ securityType: "Marketable", security: "Treasury Notes", avgInterestRatePct: 2.85 }] } },
    },
    handler: async () => {
      return withStaleFallback(treasuryAvgLastGood, "latest", async () => {
        const url = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates?sort=-record_date&page[size]=20";
        const j = await getJson(url, FISCAL_FETCH);
        const rows = Array.isArray(j?.data) ? j.data : [];
        if (!rows.length) throw bad("Treasury avg-rates feed unavailable", 502);
        // The endpoint returns multiple security-type rows per recordDate; keep
        // only the most recent date so the response is a single snapshot.
        const latest = rows[0].record_date;
        const filtered = rows.filter((r) => r.record_date === latest);
        return {
          recordDate: latest,
          rates: filtered.map((r) => ({
            securityType: r.security_type_desc ?? null,
            security: r.security_desc ?? null,
            avgInterestRatePct: r.avg_interest_rate_amt != null ? Number(r.avg_interest_rate_amt) : null,
          })),
          source: "Treasury Fiscal Data API (public domain)",
        };
      }, { maxStaleMs: MACRO_STALE_MAX_MS });
    },
  },
  {
    route: "GET /api/fx-historical", name: "Historical FX rate by date", slug: "fx-historical", category: "data", attribution: "ecb", price: "$0.002",
    description:
      "Historical foreign-exchange rate for a specific date using European Central Bank reference rates. Returns the rate that was published on (or rolled forward to) the requested date. ?from=USD&to=EUR&date=2024-01-02. Source: European Central Bank.",
    tags: ["forex", "fx", "currency", "historical", "exchange-rate", "ecb", "macro"],
    discovery: {
      input: { from: "USD", to: "EUR", date: "2024-01-02" },
      inputSchema: {
        properties: {
          from: { type: "string", maxLength: 3, description: "3-letter source currency code, e.g. USD" },
          to: { type: "string", maxLength: 3, description: "3-letter target currency code, e.g. EUR" },
          date: { type: "string", description: "ISO date (YYYY-MM-DD)" },
        },
        required: ["from", "to", "date"],
      },
      output: { example: { from: "USD", to: "EUR", date: "2024-01-02", rate: 0.9128, source: "ECB via Frankfurter" } },
    },
    handler: async (i) => {
      const from = String(i.from ?? "").trim().toUpperCase();
      const to = String(i.to ?? "").trim().toUpperCase();
      const date = String(i.date ?? "").trim();
      if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) throw bad("from and to must be 3-letter currency codes");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('"date" must be ISO format YYYY-MM-DD');
      // v2 rows through the v1-shape adapter (src/tools/frankfurter.js). An
      // empty answer is the ECB not publishing that pair on or before that
      // date (a non-ECB code, or a date before 1999-01-04), the input's
      // problem; v1 said so with a 404 the fetch guard turned into a 422.
      let j;
      try {
        j = latestShape(await getJson(ratesUrl({ base: from, quotes: [to], date })), from);
      } catch (e) {
        if (isUnknownCurrency(e)) throw bad(`unknown currency code: ${from}/${to} is not a listed pair (ECB reference currencies only, e.g. USD, EUR, GBP, JPY, CHF)`, 422);
        throw e;
      }
      if (j == null) throw bad(`No ECB reference rate for ${from}→${to} on or before ${date} (ECB reference currencies only; the series starts 1999-01-04)`, 422);
      const rate = j?.rates?.[to];
      if (typeof rate !== "number") throw bad(`Frankfurter returned no rate for ${from}→${to} on ${date}`, 502);
      return { from, to, date: j.date ?? date, rate, source: "ECB via Frankfurter (open data)" };
    },
  },
  {
    route: "GET /api/fx-timeseries", name: "FX rate time series", slug: "fx-timeseries", category: "data", attribution: "ecb", price: "$0.005",
    description:
      "Daily FX rates between two currencies across a date window using European Central Bank reference rates. ?from=USD&to=EUR&startDate=2024-01-02&endDate=2024-01-31. Source: European Central Bank.",
    tags: ["forex", "fx", "currency", "time-series", "exchange-rate", "ecb", "macro", "history"],
    discovery: {
      input: { from: "USD", to: "EUR", startDate: "2024-01-02", endDate: "2024-01-31" },
      inputSchema: {
        properties: {
          from: { type: "string", maxLength: 3, description: "3-letter source currency code" },
          to: { type: "string", maxLength: 3, description: "3-letter target currency code" },
          startDate: { type: "string", description: "ISO start date (YYYY-MM-DD)" },
          endDate: { type: "string", description: "ISO end date (YYYY-MM-DD)" },
        },
        required: ["from", "to", "startDate", "endDate"],
      },
      output: { example: { from: "USD", to: "EUR", startDate: "2024-01-02", endDate: "2024-01-31", count: 22, series: [{ date: "2024-01-02", rate: 0.9128 }] } },
    },
    handler: async (i) => {
      const from = String(i.from ?? "").trim().toUpperCase();
      const to = String(i.to ?? "").trim().toUpperCase();
      const startDate = String(i.startDate ?? "").trim();
      const endDate = String(i.endDate ?? "").trim();
      if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) throw bad("from and to must be 3-letter currency codes");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw bad('"startDate"/"endDate" must be ISO YYYY-MM-DD');
      if (endDate < startDate) throw bad('"endDate" must not precede "startDate"');
      let j;
      try {
        j = seriesShape(await getJson(ratesUrl({ base: from, quotes: [to], from: startDate, to: endDate })), from);
      } catch (e) {
        if (isUnknownCurrency(e)) throw bad(`unknown currency code: ${from}/${to} is not a listed pair (ECB reference currencies only, e.g. USD, EUR, GBP, JPY, CHF)`, 422);
        throw e;
      }
      const rates = j?.rates ?? {};
      const series = Object.keys(rates).sort().map((d) => ({ date: d, rate: rates[d]?.[to] ?? null }))
        .filter((p) => typeof p.rate === "number");
      // The ECB series starts 1999-01-04: a window wholly before it is the
      // input's problem (v1 answered 404 for it), not an outage.
      if (!series.length && endDate < "1999-01-04") throw bad(`No ECB reference rates for ${from}→${to} before 1999-01-04 (the ECB series start)`, 422);
      if (!series.length) throw bad("Frankfurter returned no rates for the requested window", 502);
      return { from, to, startDate, endDate, count: series.length, series, source: "ECB via Frankfurter (open data)" };
    },
  },
  {
    route: "GET /api/fx-dashboard", name: "G10 FX dashboard vs USD", slug: "fx-dashboard", category: "data", attribution: "ecb", price: "$0.005",
    description:
      "Snapshot of all G10 spot exchange rates quoted against USD (EUR, GBP, JPY, CHF, CAD, AUD, NZD, SEK, NOK) using European Central Bank reference rates. Includes the USD-strength index (simple geometric mean of inverse rates). No params. Source: European Central Bank.",
    tags: ["forex", "fx", "dashboard", "g10", "dxy", "usd-strength", "ecb", "macro"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: { example: { base: "USD", date: "2026-06-12", rates: { EUR: 0.91, GBP: 0.78 }, usdStrengthIndex: 1.04, source: "European Central Bank euro foreign exchange reference rates (via Frankfurter)" } },
    },
    handler: async () => {
      // OBSERVED failing from prod (4× 504 on 2026-07-23; sub-second from a
      // laptop). ECB reference rates update once per business day, so a
      // same-day snapshot is simply the answer, and a stale one (marked)
      // beats an error for a dashboard read.
      const fresh = fxDashCache && Date.now() - fxDashCache.at < FX_DASH_TTL_MS;
      if (fresh) return fxDashCache.value;
      let j = null, failure = null;
      try {
        j = latestShape(await getJson(ratesUrl({ base: "USD", quotes: G10 }), FX_PRIMARY), "USD");
        if (!j) throw bad("ECB reference rates returned no G10 rows", 502);
      } catch (e) {
        failure = e;
        console.warn(`[fx-dashboard] ECB reference rates read failed (${String(e?.message || e).slice(0, 80)})`);
      }
      if (!j) {
        // A marked same-day-ish snapshot beats an error.
        if (fxDashCache && Date.now() - fxDashCache.at < FX_DASH_STALE_MS) {
          return { ...fxDashCache.value, stale: true, asOf: new Date(fxDashCache.at).toISOString() };
        }
        throw fxSourceUnavailable(failure);
      }
      const rates = j?.rates ?? {};
      const have = G10.filter((c) => typeof rates[c] === "number");
      if (!have.length) throw bad("Upstream returned no G10 rates", 502);
      // Geometric mean of (1 / rate) — i.e. how strong is USD vs the basket.
      // Values >1 ⇒ USD has strengthened vs an even-weighted G10 basket since
      // the inverses average above 1; intuitive direction without committing
      // to any commercial DXY weighting.
      const inverseProduct = have.reduce((acc, c) => acc * (1 / rates[c]), 1);
      const usdStrengthIndex = Number(Math.pow(inverseProduct, 1 / have.length).toFixed(4));
      const value = {
        base: "USD", date: j.date ?? null,
        rates: Object.fromEntries(have.map((c) => [c, rates[c]])),
        usdStrengthIndex,
        source: ECB_FX_SOURCE,
      };
      fxDashCache = { at: Date.now(), value };
      return value;
    },
  },
  {
    route: "GET /api/world-bank-indicator", name: "World Bank indicator series", slug: "world-bank-indicator", category: "data", price: "$0.005",
    description:
      "Fetch a World Bank indicator time series for a country (e.g. GDP, inflation, unemployment, population). Open data, no key. ?country=US&indicator=NY.GDP.MKTP.CD&startYear=2018&endYear=2022",
    tags: ["world-bank", "gdp", "inflation", "unemployment", "macro", "indicators", "country", "economic-data"],
    discovery: {
      input: { country: "US", indicator: "NY.GDP.MKTP.CD", startYear: 2018, endYear: 2022 },
      inputSchema: {
        properties: {
          country: { type: "string", maxLength: 3, description: "ISO-2 or ISO-3 country code (e.g. US, USA, DE)" },
          indicator: { type: "string", maxLength: 40, description: "World Bank indicator code, e.g. NY.GDP.MKTP.CD (nominal GDP USD)" },
          startYear: { type: "number", description: "First year (default 2018)" },
          endYear: { type: "number", description: `Last year (default: the previous calendar year, ${worldBankDefaultEndYear()} when this catalog was built)` },
        },
        required: ["country", "indicator"],
      },
      output: { example: { country: "US", indicator: "NY.GDP.MKTP.CD", indicatorName: "GDP (current US$)", count: 5, series: [{ year: 2022, value: 25462700000000 }] } },
    },
    handler: async (i, req) => {
      const country = String(i.country ?? "").trim().toUpperCase();
      const indicator = String(i.indicator ?? "").trim().toUpperCase();
      if (!/^[A-Z]{2,3}$/.test(country)) throw bad('"country" must be a 2- or 3-letter ISO country code');
      if (!/^[A-Z0-9.]{3,40}$/.test(indicator)) throw bad('"indicator" must look like a World Bank indicator code (e.g. NY.GDP.MKTP.CD)');
      const startYear = Math.min(Math.max(parseInt(i.startYear, 10) || 2018, 1960), 2100);
      const endYear = Math.min(Math.max(parseInt(i.endYear, 10) || worldBankDefaultEndYear(), startYear), 2100);
      const url = `https://api.worldbank.org/v2/country/${country}/indicator/${indicator}?format=json&date=${startYear}:${endYear}&per_page=200`;
      // The World Bank API routinely takes 15-25 s on a cold indicator: the
      // nightly corpus 504'd this at the 15 s default on two of three nights
      // (2026-09-08/10) and the world-data pack lost both of its steps with it.
      // The indicator's license is read beside the data (both slow on a cold
      // indicator); an indicator not licensed CC BY 4.0 or CC0 is refused
      // with no data in the answer.
      const [j, lic] = await Promise.all([getJson(url, { timeoutMs: 25_000 }), worldBankLicense(indicator).catch((e) => e)]);
      // World Bank's idiosyncratic response: a 2-element array [meta, rows].
      if (!Array.isArray(j) || j.length < 2 || !Array.isArray(j[1])) {
        const msg = Array.isArray(j) && j[0]?.message?.[0]?.value ? j[0].message[0].value : "World Bank returned no series";
        // "The provided parameter value is not valid" is the World Bank
        // refusing OUR INPUT (an unknown indicator or country) - a 400 the
        // buyer can act on, not an upstream outage (corpus, 2026-09-06).
        throw bad(/not valid|invalid/i.test(msg) ? `${msg} (check the indicator and country codes)` : msg, /not valid|invalid/i.test(msg) ? 400 : 502);
      }
      const rows = j[1];
      const series = rows
        .filter((r) => r && r.value != null)
        .map((r) => ({ year: parseInt(r.date, 10), value: Number(r.value) }))
        .sort((a, b) => a.year - b.year);
      if (lic instanceof Error) throw lic;
      if (!lic.servable) {
        throw Object.assign(bad(lic.licenseType
          ? `World Bank indicator ${indicator} is published under "${lic.licenseType}", not CC BY 4.0, so it is not served here.${notChargedOn(req)}`
          : `World Bank indicator ${indicator} states no license in its metadata, so it is not served here.${notChargedOn(req)}`, 422), { license: lic.licenseType || null });
      }
      if (!series.length) throw bad("World Bank returned no values for this country/indicator/window", 502);
      return {
        country, indicator,
        indicatorName: rows[0]?.indicator?.value ?? null,
        countryName: rows[0]?.country?.value ?? null,
        count: series.length, series,
        source: "World Bank Open Data API",
        credit: worldBankCredit(lic.dataset, lic.source),
        license: lic.license,
        licenseUrl: lic.licenseUrl,
      };
    },
  },
  {
    route: "GET /api/world-bank-search", name: "Search World Bank indicators", slug: "world-bank-search", category: "data", price: "$0.002",
    description:
      "Search the World Bank indicator catalog (1,400+ indicators across GDP, demographics, health, environment, education, etc.) by keyword. Returns indicator codes you can feed into /api/world-bank-indicator. ?q=inflation&rows=10",
    tags: ["world-bank", "indicators", "search", "macro", "economic-data", "catalog"],
    discovery: {
      input: { q: "inflation", rows: 5 },
      inputSchema: {
        properties: {
          q: { type: "string", description: "Search keyword" },
          rows: { type: "number", description: "Results to return, 1-20 (default 5)" },
        },
        required: ["q"],
      },
      output: { example: { query: "inflation", count: 5, indicators: [{ code: "FP.CPI.TOTL.ZG", name: "Inflation, consumer prices (annual %)", sourceNote: "Inflation as measured by the consumer price index…" }] } },
    },
    handler: async (i) => {
      const q = String(i.q ?? "").trim();
      if (!q) throw bad('"q" is required');
      const rows = Math.min(Math.max(parseInt(i.rows, 10) || 5, 1), 20);
      // World Bank's indicator endpoint doesn't support free-text search, so we
      // fetch the curated World Development Indicators source (source=2,
      // ~1,500 entries) and filter client-side. The full unfiltered catalog
      // is ~30k indicators, the vast majority of which are niche or duplicate;
      // WDI is the canonical set callers actually want (GDP, inflation,
      // unemployment, population, life expectancy, etc.).
      const url = `https://api.worldbank.org/v2/source/2/indicator?format=json&per_page=2000`;
      const j = await getJson(url);
      if (!Array.isArray(j) || j.length < 2 || !Array.isArray(j[1])) throw bad("World Bank indicator catalog unavailable", 502);
      const needle = q.toLowerCase();
      const matches = j[1]
        .filter((ind) => ind && typeof ind.name === "string" && (
          ind.name.toLowerCase().includes(needle) ||
          (ind.sourceNote ?? "").toLowerCase().includes(needle)
        ))
        .slice(0, rows)
        .map((ind) => ({
          code: ind.id, name: ind.name,
          sourceNote: (ind.sourceNote ?? "").replace(/\s+/g, " ").slice(0, 240),
        }));
      return { query: q, count: matches.length, indicators: matches, source: "World Bank Open Data API", credit: worldBankCredit("World Development Indicators"), license: WORLD_BANK_LICENSE, licenseUrl: WORLD_BANK_LICENSE_URL };
    },
  },
];

// ---- World Bank series licenses ---------------------------------------------
// Each indicator's license, from the World Bank's own series metadata: the
// indicator's source (/v2/indicator/<id>), then that source's metadata for it
// (/v2/sources/<source>/series/<id>/metadata: License_Type, License_URL and
// Source). Kept a day per indicator.
const WB_LICENSE_TTL_MS = 24 * 60 * 60 * 1000;
const WB_LICENSE_MAX = 500;
const wbLicenses = new Map(); // indicator -> { at, value }
const wbLicenseReads = new Map(); // indicator -> in-flight read
/** Test seam: forget every license read. */
export function _resetWorldBankForTest() { wbLicenses.clear(); wbLicenseReads.clear(); }
/** CC BY 4.0 in the forms the metadata writes it, or CC0. */
export function worldBankLicenseServable(type) {
  const t = String(type || "").replace(/\s+/g, " ").trim();
  if (/^CC BY[- ]?4(\.0)?$/i.test(t)) return WORLD_BANK_LICENSE;
  if (/^CC0( 1\.0)?$/i.test(t)) return "CC0";
  return null;
}
async function worldBankLicense(indicator) {
  const hit = wbLicenses.get(indicator);
  if (hit && Date.now() - hit.at < WB_LICENSE_TTL_MS) return hit.value;
  if (wbLicenseReads.has(indicator)) return wbLicenseReads.get(indicator);
  const read = (async () => {
    const ind = await getJson(`https://api.worldbank.org/v2/indicator/${encodeURIComponent(indicator)}?format=json`, { timeoutMs: 25_000 });
    const sourceId = Array.isArray(ind) && Array.isArray(ind[1]) ? String(ind[1][0]?.source?.id ?? "") : "";
    if (!/^\d{1,4}$/.test(sourceId)) {
      const msg = Array.isArray(ind) && ind[0]?.message?.[0]?.value ? ind[0].message[0].value : "";
      if (/not valid|invalid/i.test(msg)) throw bad(`${msg} (check the indicator and country codes)`, 400);
      throw bad("The World Bank did not say which dataset this indicator is in; retry shortly.", 502);
    }
    const meta = await getJson(`https://api.worldbank.org/v2/sources/${sourceId}/series/${encodeURIComponent(indicator)}/metadata?format=json`, { timeoutMs: 25_000 });
    const src = Array.isArray(meta?.source) ? meta.source[0] : null;
    const variable = src?.concept?.[0]?.variable?.find?.((v) => String(v?.id).toUpperCase() === indicator) || src?.concept?.[0]?.variable?.[0];
    if (!variable || !Array.isArray(variable.metatype)) throw bad("The World Bank's metadata for this indicator could not be read; retry shortly.", 502);
    const field = (id) => variable.metatype.find((m) => m?.id === id)?.value ?? null;
    const licenseType = field("License_Type");
    const license = worldBankLicenseServable(licenseType);
    const licenseUrl = String(field("License_URL") || "");
    const value = {
      servable: !!license, licenseType, license,
      licenseUrl: /^https:\/\/[^\s]+$/.test(licenseUrl) ? licenseUrl : WORLD_BANK_LICENSE_URL,
      dataset: src?.name || ind[1][0]?.source?.value || null,
      source: field("Source"),
    };
    if (wbLicenses.size >= WB_LICENSE_MAX) wbLicenses.delete(wbLicenses.keys().next().value);
    wbLicenses.set(indicator, { at: Date.now(), value });
    return value;
  })().finally(() => wbLicenseReads.delete(indicator));
  wbLicenseReads.set(indicator, read);
  return read;
}

/** World Bank annual data lags a year; the default window ends at the
 *  previous calendar year. One value feeds the handler and the description. */
export function worldBankDefaultEndYear(now = new Date()) {
  return now.getUTCFullYear() - 1;
}

// FRED accepts only a controlled set of `units` transformations; reject other
// values up front so the caller gets a clear error instead of an opaque 400
// from the upstream.
const FRED_UNITS = new Set(["lin", "chg", "ch1", "pch", "pc1", "pca", "cca", "log"]);
// --- series with a copyright notice ---------------------------------------------
// FRED's Terms of Use: a series whose notes carry a copyright notice needs
// the copyright owner's permission for use beyond personal use.
// No tool here reads FRED: fred-series and the computed tools read the
// publishing agencies. fredCopyrightOf is the rule a tool that serves a
// caller-chosen FRED series applies to the series' notes first.

/** null when `notes` carry no copyright notice; else { owner } with the owner
 *  the notice names (null when it names none that can be read). Linear in the
 *  text: the notes are cut to a bound first. */
export function fredCopyrightOf(notes) {
  const text = typeof notes === "string" ? notes.slice(0, 20_000).replace(/\s+/g, " ") : "";
  // The first mention that is a notice: one a negation leads ("not subject
  // to copyright", "no copyright restrictions") says the opposite.
  let at = -1, seen = 0;
  for (const m of text.matchAll(/copyright|\u00a9/gi)) {
    if (!/\b(not|no|non|without|free of|free from)\b[^.;]{0,24}$/i.test(text.slice(Math.max(0, m.index - 40), m.index))) { at = m.index; break; }
    if (++seen >= 50) break;
  }
  if (at < 0) return null;
  let rest = text.slice(at, at + 240).replace(/^(copyright|\u00a9)/i, "");
  // The marks, years and joining words a notice puts before the owner's name.
  for (let n = 0; n < 8; n++) {
    const next = rest.replace(/^[\s,:;.\-]+/, "").replace(/^(\u00a9|\(c\)|copyright|by|\d{4}(\s*-\s*\d{4})?)(?![A-Za-z0-9])/i, "");
    if (next === rest) break;
    rest = next;
  }
  const end = rest.search(/\.\s+[A-Z]|\.\s*$|;|\ball rights\b|\breproduction\b|\breprinted\b/i);
  const owner = (end >= 0 ? rest.slice(0, end) : rest.slice(0, 100)).replace(/[\s,.:;]+$/, "").trim();
  return { owner: owner.length >= 2 && owner.length <= 100 && /[A-Za-z]/.test(owner) ? owner : null };
}

MACRO_TOOLS.push(
  {
    // Served from the agencies that publish each series (src/tools/us-macro-series.js),
    // never from FRED: the route keeps FRED's series IDs, inputs and answer shape.
    route: "GET /api/fred-series", name: "US economic time series by FRED series ID", slug: "fred-series", category: "data", attribution: "us-agencies", price: "$0.001",
    upstreamHosts: ["api.bls.gov", "markets.newyorkfed.org", "api.fiscaldata.treasury.gov", "home.treasury.gov", "www.federalreserve.gov", "apps.bea.gov"],
    description:
      `US economic series by FRED ID, from the agency that publishes each: GDP and PCE (GDPC1, PCEPI), jobs and prices (UNRATE, CPIAUCSL), Treasury yields (DGS10, T10YIE), money (M2SL), FX (DEXUSEU), rates (FEDFUNDS). Units and frequencies; other IDs answer 404 listing those served. ${US_AGENCIES_ATTRIBUTION}`,
    tags: ["fred", "series", "time-series", "gdp", "cpi", "inflation", "unemployment", "fed-funds", "sofr", "treasury-yields", "money-supply", "bls", "bea", "macro", "economic-data", "treasury"],
    discovery: {
      input: { seriesId: "GDPC1", startDate: "2024-01-01", endDate: "2024-12-31" },
      inputSchema: {
        properties: {
          seriesId: { type: "string", maxLength: 40, description: `FRED series ID, one of: ${US_MACRO_SUPPORTED_IDS.join(", ")}` },
          startDate: { type: "string", description: "ISO start date (YYYY-MM-DD), optional; without one a Bureau of Labor Statistics series answers its last 10 years, a daily Treasury or exchange-rate series its last 2 calendar years" },
          endDate: { type: "string", description: "ISO end date (YYYY-MM-DD), optional" },
          limit: { type: "number", description: "Max observations, 1-100000 (default 1000)" },
          units: { type: "string", enum: [...FRED_UNITS], description: "Transformation: lin, chg, ch1, pch, pc1 (YoY %), pca, cca, log" },
          frequency: { type: "string", enum: [...US_MACRO_SUPPORTED_FREQ, "wef"], description: "Average to a lower frequency: d, w (weeks ending Friday, also wef), m, q, sa, a (optional)" },
        },
        required: ["seriesId"],
      },
      output: { example: { seriesId: "GDPC1", count: 4, observations: [{ date: "2024-01-01", value: 23115.975 }], source: "U.S. Bureau of Economic Analysis", sourceSeries: "NIPA A191RX (Table 1.1.6, line 1)", terms: US_MACRO_TERMS.bea } },
    },
    handler: async (i) => {
      const seriesId = String(i.seriesId ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9_]{1,40}$/.test(seriesId)) throw bad('"seriesId" must look like a FRED series ID (e.g. UNRATE, CPIAUCSL)');
      const startDate = i.startDate ? String(i.startDate).trim() : undefined;
      const endDate = i.endDate ? String(i.endDate).trim() : undefined;
      if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw bad('"startDate" must be ISO YYYY-MM-DD');
      if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw bad('"endDate" must be ISO YYYY-MM-DD');
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || 1000, 1), 100000);
      const units = i.units ? String(i.units).trim().toLowerCase() : "lin";
      if (!FRED_UNITS.has(units)) throw bad(`"units" must be one of: ${[...FRED_UNITS].join(", ")}`);
      const frequency = i.frequency ? String(i.frequency).trim().toLowerCase() : undefined;
      const freqs = [...US_MACRO_SUPPORTED_FREQ, "wef"];
      if (frequency && !freqs.includes(frequency)) throw bad(`"frequency" must be one of: ${freqs.join(", ")} (w and wef are weeks ending Friday)`);
      const out = await usMacroSeries({ seriesId, startDate, endDate, limit, units, frequency });
      if (!out) throw unsupportedSeriesError(seriesId);
      return out;
    },
  },
  {
    // The four computed tools below read the agencies that publish their
    // inputs through src/tools/us-macro-series.js (BLS and the New York Fed),
    // never FRED; each answer carries the publisher's credit, the retrieval
    // date and the publisher's terms.
    route: "GET /api/sahm-rule", name: "Sahm Rule recession indicator", slug: "sahm-rule", category: "data", attribution: "bls", price: "$0.005",
    upstreamHosts: ["api.bls.gov"],
    description:
      "Sahm Rule recession indicator, computed from the U.S. Bureau of Labor Statistics unemployment rate (series LNS14000000): it triggers when the 3-month moving average of US unemployment rises ≥0.50 percentage points above the lowest 3-month average of the prior 12 months. No params. Each answer carries the BLS retrieval date and the BLS statement on derived data.",
    tags: ["sahm-rule", "recession", "unemployment", "macro", "bls", "indicator", "signal"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: { example: { date: "2026-05-01", value: 0.43, triggered: false, threshold: 0.5, source: "Computed by Agent402 from U.S. Bureau of Labor Statistics data (LNS14000000)", terms: US_MACRO_TERMS.bls } },
    },
    handler: async () => {
      const got = await usMacroSeries({ seriesId: "UNRATE", startDate: monthsBack(30), limit: 100000 });
      const out = sahmFromMonthly(got.observations);
      if (!out) throw bad(`The U.S. Bureau of Labor Statistics unemployment series has too few recent months to compute the Sahm Rule right now; retry later.${notChargedHere()}`, 503);
      return {
        date: out.date, value: out.value,
        triggered: out.value >= 0.5,
        threshold: 0.5,
        source: "Computed by Agent402 from U.S. Bureau of Labor Statistics data (LNS14000000)",
        sourceSeries: got.sourceSeries,
        derived: true,
        method: "The 3-month average of the monthly unemployment rate minus the lowest 3-month average of the 12 months before it, on the series as published today (not the real-time vintages).",
        ...(out.missing.length ? { missingDates: out.missing, note: `No value was published for ${out.missing.join(", ")}; a 3-month average that includes it is taken over the months that have one.` } : {}),
        retrievedAt: got.retrievedAt,
        credit: `${BLS_ATTRIBUTION} ${got.credit}`,
        terms: got.terms,
      };
    },
  },
  {
    route: "GET /api/cpi-yoy", name: "US CPI year-over-year inflation", slug: "cpi-yoy", aliases: ["us-cpi-year-over-year-inflation", "cpi-inflation", "inflation-rate"], category: "data", attribution: "bls", price: "$0.005",
    upstreamHosts: ["api.bls.gov"],
    description:
      "Latest US Consumer Price Index year-over-year inflation rate (headline CPI-U, seasonally adjusted) plus the trailing 12 months of YoY readings - the headline inflation number. A month with no published value is listed in missingDates rather than dropped silently. Computed from the U.S. Bureau of Labor Statistics CPI-U index (series CUSR0000SA0). No params. Each answer carries the BLS retrieval date and the BLS statement on derived data.",
    tags: ["cpi", "inflation", "yoy", "consumer-price-index", "macro", "bls", "headline-inflation"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: { example: { date: "2026-05-01", inflationYoYPct: 3.4, trailing12mo: [{ date: "2025-06-01", value: 3.0 }], source: "Computed by Agent402 from U.S. Bureau of Labor Statistics data (CUSR0000SA0)", missingDates: [], terms: US_MACRO_TERMS.bls } },
    },
    handler: async () => {
      const got = await usMacroSeries({ seriesId: "CPIAUCSL", units: "pc1", startDate: monthsBack(26), limit: 100000 });
      const obs = got.observations;
      if (!obs.length) throw bad(`The U.S. Bureau of Labor Statistics CPI series returned no recent months; retry later.${notChargedHere()}`, 503);
      const last = obs[obs.length - 1];
      // The 12 calendar months ending at the latest; a month with no
      // published value is reported, never dropped silently.
      const window = monthRange(addMonthsIso(last.date, -11), last.date);
      const trailing = obs.filter((o) => o.date >= window[0]);
      const have = new Set(trailing.map((o) => o.date));
      const missing = window.filter((d) => !have.has(d));
      return {
        date: last.date,
        inflationYoYPct: Number(last.value.toFixed(2)),
        trailing12mo: trailing.map((o) => ({ date: o.date, value: Number(o.value.toFixed(2)) })),
        source: "Computed by Agent402 from U.S. Bureau of Labor Statistics data (CUSR0000SA0)",
        sourceSeries: got.sourceSeries,
        derived: true,
        missingDates: missing,
        ...(missing.length ? { note: `No value was published for ${missing.join(", ")}, so trailing12mo has ${trailing.length} readings.` } : {}),
        retrievedAt: got.retrievedAt,
        credit: `${BLS_ATTRIBUTION} ${got.credit}`,
        terms: got.terms,
      };
    },
  },
  {
    route: "GET /api/unemployment-rate", name: "US unemployment rate (UNRATE)", slug: "unemployment-rate", category: "data", attribution: "bls", price: "$0.005",
    upstreamHosts: ["api.bls.gov"],
    description:
      "Latest US unemployment rate (current, as of date) plus a trailing N-month history of {date, value} for trend, seasonally adjusted, in percent. Source: U.S. Bureau of Labor Statistics (series LNS14000000, the series known as UNRATE). A month with no published value is listed in missingDates rather than dropped silently. ?months=12 (1-120, default 12). Each answer carries the BLS retrieval date and statement.",
    tags: ["unemployment", "unrate", "labor", "jobs", "bls", "macro"],
    discovery: {
      input: { months: 12 },
      inputSchema: {
        properties: { months: { type: "number", description: "Trailing months to return (1-120, default 12)" } },
      },
      output: { example: { date: "2026-05-01", current: 4.1, months: 12, history: [{ date: "2025-06-01", value: 4.0 }], source: "U.S. Bureau of Labor Statistics", terms: US_MACRO_TERMS.bls } },
    },
    handler: async (i) => {
      const months = Math.min(Math.max(parseInt(i.months, 10) || 12, 1), 120);
      const got = await usMacroSeries({ seriesId: "UNRATE", startDate: monthsBack(months + 3), limit: 100000 });
      const all = got.observations;
      if (!all.length) throw bad(`The U.S. Bureau of Labor Statistics unemployment series returned no recent months; retry later.${notChargedHere()}`, 503);
      const last = all[all.length - 1];
      const window = monthRange(addMonthsIso(last.date, -(months - 1)), last.date);
      const obs = all.filter((o) => o.date >= window[0]);
      const have = new Set(obs.map((o) => o.date));
      const missing = window.filter((d) => !have.has(d));
      return {
        date: last.date, current: last.value,
        months: obs.length,
        history: obs,
        source: got.source,
        sourceSeries: got.sourceSeries,
        ...(missing.length ? { missingDates: missing, note: `No value was published for ${missing.join(", ")}, so the series has ${obs.length} of the ${months} months asked for.` } : {}),
        retrievedAt: got.retrievedAt,
        credit: `${BLS_ATTRIBUTION} ${got.credit}`,
        terms: got.terms,
      };
    },
  },
  {
    route: "GET /api/fed-funds", name: "Effective federal funds rate", slug: "fed-funds", aliases: ["effective-federal-funds-rate", "federal-funds-rate", "fed-funds-rate"], category: "data", attribution: "nyfed", price: "$0.005",
    upstreamHosts: ["markets.newyorkfed.org"],
    description:
      "Current effective federal funds rate (current, as of date, in percent) plus a trailing N-day history of {date, value} over calendar days, a weekend or holiday carrying the rate of the business day before it. Source: the Federal Reserve Bank of New York's Effective Federal Funds Rate (EFFR), with its notice. ?days=30 (1-365, default 30). Each answer carries the New York Fed notice and the retrieval date.",
    tags: ["fed-funds", "interest-rates", "monetary-policy", "fomc", "fed", "macro", "effr"],
    discovery: {
      input: { days: 30 },
      inputSchema: {
        properties: { days: { type: "number", description: "Trailing days to return (1-365, default 30)" } },
      },
      output: { example: { date: "2026-06-17", current: 5.33, days: 30, history: [{ date: "2026-05-19", value: 5.33 }], source: "Federal Reserve Bank of New York", terms: US_MACRO_TERMS.nyfed } },
    },
    handler: async (i) => {
      const days = Math.min(Math.max(parseInt(i.days, 10) || 30, 1), 365);
      const got = await usMacroSeries({ seriesId: "EFFR", startDate: daysBack(days + 21), limit: 100000 });
      const daily = got.observations;
      if (!daily.length) throw bad(`The New York Fed's EFFR returned no recent business days; retry later.${notChargedHere()}`, 503);
      const last = daily[daily.length - 1];
      const history = carryCalendarDays(daily, days);
      return {
        date: last.date, current: last.value,
        days: history.length, history,
        source: got.source,
        sourceSeries: got.sourceSeries,
        note: "The New York Fed publishes the rate on business days; a weekend or holiday here carries the rate of the business day before it.",
        retrievedAt: got.retrievedAt,
        credit: `${NYFED_ATTRIBUTION} ${got.credit}`,
        terms: got.terms,
      };
    },
  },
);

// The computed tools' descriptions end with their publisher's sentence
// (src/data-attribution.js): BLS for the labor and price series, the New York
// Fed for the funds rate.
for (const t of MACRO_TOOLS) if (t.attribution === "bls" || t.attribution === "nyfed") attribute(t, t.attribution);

// ---- month and day helpers for the computed tools ----------------------------
const isoMonth = (y, m) => new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
/** The first of the month `n` months from `iso` (a YYYY-MM-01 date). */
export function addMonthsIso(iso, n) {
  return isoMonth(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1 + n);
}
/** Every month from `from` to `to` (YYYY-MM-01, inclusive), oldest first. */
export function monthRange(from, to) {
  const out = [];
  for (let m = from; m <= to && out.length < 2000; m = addMonthsIso(m, 1)) out.push(m);
  return out;
}
const monthsBack = (n, now = new Date()) => isoMonth(now.getUTCFullYear(), now.getUTCMonth() - n);
const daysBack = (n, now = new Date()) => new Date(now.getTime() - n * 86_400_000).toISOString().slice(0, 10);

/** The Sahm Rule from monthly unemployment rates (oldest first): the
 *  3-month average of the latest month minus the lowest 3-month average of
 *  the 12 months before it, at two decimals. A 3-month average is taken over
 *  the months in it that have a value (two at least). null when the series
 *  is too short. */
export function sahmFromMonthly(rows) {
  if (!rows.length) return null;
  const byDate = new Map(rows.map((r) => [r.date, r.value]));
  const last = rows[rows.length - 1].date;
  const span = monthRange(addMonthsIso(last, -14), last);
  const missing = span.filter((d) => !byDate.has(d));
  const ma3 = (end) => {
    const vals = [addMonthsIso(end, -2), addMonthsIso(end, -1), end].map((d) => byDate.get(d)).filter((v) => typeof v === "number");
    return vals.length >= 2 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const cur = ma3(last);
  const prior = monthRange(addMonthsIso(last, -12), addMonthsIso(last, -1)).map(ma3).filter((v) => v !== null);
  if (cur === null || prior.length < 10) return null;
  return { date: last, value: Math.round((cur - Math.min(...prior)) * 100) / 100, missing };
}

/** The last `days` calendar days through the latest business day of
 *  `daily` (oldest first), each at the latest rate published on or before it. */
export function carryCalendarDays(daily, days) {
  const out = [];
  if (!daily.length) return out;
  const lastDate = daily[daily.length - 1].date;
  const start = new Date(new Date(`${lastDate}T00:00:00Z`).getTime() - (days - 1) * 86_400_000);
  let i = 0, cur = null;
  for (let d = new Date(start); d.toISOString().slice(0, 10) <= lastDate; d = new Date(d.getTime() + 86_400_000)) {
    const ds = d.toISOString().slice(0, 10);
    while (i < daily.length && daily[i].date <= ds) cur = daily[i++].value;
    if (cur !== null) out.push({ date: ds, value: cur });
  }
  return out;
}

// These handlers' every upstream wait is a safeFetch,
// each under its own timeout and its retry helper, all of which end at a
// run's ceiling when one is set (src/run-ceiling.js): a caller that stops
// waiting at a deadline of its own can serve them.
markEndsAtCeiling(MACRO_TOOLS, ["treasury-avg-rates", "treasury-debt", "treasury-yield-curve", "treasury-yield-history", "yield-curve-spread"]);

// Resale clearance (src/resale-terms.js): cleared for resale through a third party.
markResaleCleared(MACRO_TOOLS, ["treasury-yield-curve", "treasury-yield-history", "yield-curve-spread", "treasury-debt", "treasury-avg-rates"], "US Treasury public data");
