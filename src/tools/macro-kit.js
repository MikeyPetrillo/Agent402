// Macro-kit — live macroeconomic and rates data agents can't get from a frozen
// training set.
//
// Two tiers of sources:
//
//   1. Fully keyless (always works):
//      • US Treasury constant-maturity yields via FRED CSV download (DGS*
//        series, St. Louis Fed; the CSV endpoint is keyless even though the
//        JSON API requires a key). When FRED_API_KEY is set, an upstream
//        failure of the CSV scrape falls back to the keyed JSON API — the
//        keyless endpoint shares prod's Railway egress IP with other tenants
//        and intermittently throttles it.
//      • US Treasury Fiscal Data API (api.fiscaldata.treasury.gov) — public
//        domain, for debt outstanding and average interest rates by security
//      • ECB reference rates via Frankfurter (api.frankfurter.dev) — open data
//      • World Bank Indicators API (api.worldbank.org) — open data
//
//   2. Keyed FRED JSON API (requires FRED_API_KEY env var, free to obtain at
//      fred.stlouisfed.org). Without the key the handlers return 503
//      "not configured" — same pattern as the BRAVE_API_KEY-backed search
//      tool. The key unlocks ~800k series with date windowing, units
//      transformation, and full-text catalog search.
//
// Covers the cluster of macro/financial routes that show up across the x402
// ecosystem (yield curves, FX time series, GDP/inflation indicators, CPI YoY,
// fed funds, recession signals). Pure HTTP wrappers, deterministic.
import { safeFetch, assertPublicUrl, retryTransient } from "./fetch-guard.js";
import { redactSecrets } from "./redact.js";

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

// Serve-stale-on-error for slow-moving datasets. FRED's /releases/dates
// endpoint runs 15-60s under load and sometimes blows FRED's own 60s gateway
// limit (2026-07-15/16: our then-15s fetch ceiling turned that slowness into
// an 8-hour manufactured outage of fred-release-calendar — every 30-min poll
// a buyer-facing 504). A release calendar barely moves intra-day, so even
// with the fetch budget fixed, the last successful payload is a strictly
// better answer than an error: on a TRANSIENT upstream failure (502/503/504 —
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
        staleReason: `FRED upstream failed (${sc}) - serving the last successful snapshot`,
      };
    }
    throw e;
  }
}

// 24h of staleness is acceptable for both wrapped datasets — release dates
// are scheduled weeks ahead and Treasury average rates are monthly; past a
// day, an error is more honest than a snapshot.
const MACRO_STALE_MAX_MS = 24 * 3600 * 1000;
// Last-good release-calendar payloads, keyed by the `days` window (1-90, so
// the map is bounded).
const releaseCalLastGood = new Map();
// Last-good Treasury average-rates payload (no params — one fixed key).
// fiscaldata.treasury.gov still flakes ~1/day past the 3-attempt FISCAL_FETCH
// retry profile; monthly data deserves a snapshot, not a 504.
const treasuryAvgLastGood = new Map();

async function safeFetchRetry(url, opts = {}) {
  const { retries, backoffMs, ...fetchOpts } = opts;
  return retryTransient(() => safeFetch(url, fetchOpts), {
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

// The FX primary gets a SHORT leash, for the opposite reason to FISCAL_FETCH
// above: this tool has a fast keyless fallback, and the fallback only fires
// when the primary THROWS. A primary that is merely slow blocks the whole call
// and the fallback never gets its turn.
//
// Measured 2026-08-03: api.frankfurter.dev answers in ~0.06s warm but 7.8s and
// 11.6s cold, while the fallback open.er-api.com answers in ~0.08s every time.
// On the default 15s timeout with a retry, a cold primary could hold a PAID
// $0.015 call for up to 30s before failing over - and prod's self-check, which
// gives up at 12s, was recording fx-dashboard as a 504 outage while a healthy
// second publisher sat unused.
//
// 2.5s and no retry: if the spec'd primary cannot beat a host that answers in
// under a tenth of a second, it has already lost. Retrying it is worse than
// falling through, because the fallback IS the retry. The two publishers agree
// to 4dp on ECB daily reference rates and the response names which one served,
// so failing over costs the buyer nothing but is never silent.
const FX_PRIMARY = { retries: 0, timeoutMs: 2_500 };

async function getJson(url, opts = {}) {
  const { html } = await safeFetchRetry(url, { maxBytes: 5 * 1024 * 1024, ...opts });
  try {
    return JSON.parse(html);
  } catch {
    throw bad("Upstream returned non-JSON", 502);
  }
}

async function getText(url) {
  const { html } = await safeFetchRetry(url, { maxBytes: 5 * 1024 * 1024 });
  return html;
}

// Constant-maturity tenors FRED publishes daily as the DGS* series. Order
// matters — it's the column order of the CSV we fetch, and the order of the
// output object keys.
const FRED_YIELD_SERIES = [
  ["DGS1MO", "mo1"], ["DGS3MO", "mo3"], ["DGS6MO", "mo6"],
  ["DGS1", "yr1"], ["DGS2", "yr2"], ["DGS3", "yr3"],
  ["DGS5", "yr5"], ["DGS7", "yr7"], ["DGS10", "yr10"],
  ["DGS20", "yr20"], ["DGS30", "yr30"],
];

// Parse FRED's two-column-per-series CSV download. The first column is
// observation_date, then one column per series in the requested order. Empty
// cells mean "no observation" (weekend, holiday, or series gap) and become
// null. We trim to rows that have *any* yield value so callers don't see a
// trailing weekend with all-null values from a midweek pull.
function parseFredYieldsCsv(csv) {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) throw bad("FRED returned no rows", 502);
  const header = lines[0].split(",");
  const seriesIds = FRED_YIELD_SERIES.map(([id]) => id);
  // Defensive: map column positions by header name in case FRED ever reorders.
  const colIdx = seriesIds.map((id) => header.indexOf(id));
  if (colIdx.some((i) => i < 0)) throw bad("FRED CSV missing expected columns", 502);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const recordDate = cells[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) continue;
    const out = { recordDate };
    let hasAny = false;
    FRED_YIELD_SERIES.forEach(([, dst], j) => {
      const raw = cells[colIdx[j]];
      if (raw == null || raw === "" || raw === ".") {
        out[dst] = null;
      } else {
        const n = Number(raw);
        if (Number.isFinite(n)) { out[dst] = n; hasAny = true; }
        else { out[dst] = null; }
      }
    });
    if (hasAny) rows.push(out);
  }
  if (!rows.length) throw bad("FRED returned no usable yield rows", 502);
  return rows;
}

// Keyed-API fallback for the yield-curve tools. fredgraph.csv is a keyless
// scrape endpoint, and prod shares one Railway egress IP with other tenants —
// a per-IP throttle or anti-bot block upstream turns into OUR intermittent
// failure. When the CSV path fails with an upstream error AND FRED_API_KEY is
// configured, refetch the same DGS* series via the keyed JSON API (one
// /series/observations call per series, concurrency-bounded) and reassemble
// the exact row shape parseFredYieldsCsv produces, so the three handlers
// (latest curve / history / spreads) never notice which path served them.
// Window: the handlers only ever read the trailing 250 business days
// (`?days` caps at 250), so ~550 calendar days of lookback covers the worst
// case (weekends + holidays) with margin — no need to mirror the CSV's
// full-since-1962 history.
const FRED_YIELD_FALLBACK_LOOKBACK_DAYS = 550;
const FRED_YIELD_FALLBACK_CONCURRENCY = 4;

export async function assembleFredYieldRows(observationsBySeries) {
  // observationsBySeries: array aligned with FRED_YIELD_SERIES, each an array
  // of {date, value} (missing "." observations already filtered out — the
  // fredObservations contract). Merge into fredgraph-CSV row shape: one row
  // per date, every tenor key present, null where a series has no observation.
  const byDate = new Map();
  FRED_YIELD_SERIES.forEach(([, dst], j) => {
    for (const { date, value } of observationsBySeries[j] || []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(value)) continue;
      let row = byDate.get(date);
      if (!row) {
        row = { recordDate: date };
        for (const [, d] of FRED_YIELD_SERIES) row[d] = null;
        byDate.set(date, row);
      }
      row[dst] = value;
    }
  });
  // Same trim semantics as the CSV parser: keep only rows with ≥1 observation
  // (guaranteed by construction here), chronological order.
  const rows = [...byDate.values()].sort((a, b) => (a.recordDate < b.recordDate ? -1 : 1));
  if (!rows.length) throw bad("FRED returned no usable yield rows", 502);
  return rows;
}

async function fetchFredYieldsViaKeyedApi() {
  const startDate = new Date(Date.now() - FRED_YIELD_FALLBACK_LOOKBACK_DAYS * 86400_000)
    .toISOString().slice(0, 10);
  const results = new Array(FRED_YIELD_SERIES.length);
  let next = 0;
  const worker = async () => {
    while (next < FRED_YIELD_SERIES.length) {
      const idx = next++;
      results[idx] = await fredObservations({ seriesId: FRED_YIELD_SERIES[idx][0], startDate });
    }
  };
  await Promise.all(Array.from({ length: FRED_YIELD_FALLBACK_CONCURRENCY }, worker));
  return assembleFredYieldRows(results);
}

// Is a fetchFredYields failure an UPSTREAM problem the keyed API could route
// around? 502/503/504 cover gateway errors, timeouts, and the CSV parser's
// "no rows / missing columns" throws. `upstreamStatus` covers safeFetch's 4xx
// mapping: our fredgraph URL is fixed and correct, so an upstream 403/429
// (per-IP throttle — the exact shared-egress failure mode) is never a caller
// error here even though safeFetch attributes it as 422.
function isYieldCsvUpstreamFailure(e) {
  const sc = e?.statusCode;
  return sc === 502 || sc === 503 || sc === 504 || e?.upstreamStatus !== undefined;
}

async function fetchFredYields() {
  const ids = FRED_YIELD_SERIES.map(([id]) => id).join(",");
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${ids}`;
  try {
    const csv = await getText(url);
    return parseFredYieldsCsv(csv);
  } catch (e) {
    // Fall back only on upstream failures, and only when the keyed API is
    // configured — with no key, behavior is exactly as before.
    if (!isYieldCsvUpstreamFailure(e) || !(process.env.FRED_API_KEY || "").trim()) throw e;
    console.warn(`[macro] fredgraph.csv failed (${e.message}) - falling back to keyed FRED API`);
    return fetchFredYieldsViaKeyedApi();
  }
}

async function fetchLatestYieldCurve() {
  const rows = await fetchFredYields();
  return rows[rows.length - 1];
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
    route: "GET /api/treasury-yield-curve", name: "US Treasury daily yield curve", slug: "treasury-yield-curve", category: "data", price: "$0.010",
    description:
      "Latest US Treasury daily constant-maturity yields (1mo, 3mo, 6mo, 1y, 2y, 3y, 5y, 7y, 10y, 20y, 30y) as clean JSON. Source: FRED DGS* series (St. Louis Fed), public domain, no key. No params - always returns the most recent published curve.",
    tags: ["treasury", "yield-curve", "interest-rates", "rates", "macro", "bonds", "fed", "10-year", "yields"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: { example: { recordDate: "2026-06-12", mo1: 5.42, mo3: 5.39, yr1: 4.91, yr2: 4.78, yr5: 4.45, yr10: 4.51, yr30: 4.68 } },
    },
    handler: async () => fetchLatestYieldCurve(),
  },
  {
    route: "GET /api/treasury-yield-history", name: "US Treasury yield history", slug: "treasury-yield-history", category: "data", price: "$0.015",
    description:
      "Last N business days of US Treasury constant-maturity yields, oldest→newest. Source: FRED DGS* series (St. Louis Fed), public domain. ?days=30 (1-250, default 30).",
    tags: ["treasury", "yield-curve", "history", "interest-rates", "rates", "macro", "bonds", "time-series"],
    discovery: {
      input: { days: 30 },
      inputSchema: {
        properties: { days: { type: "number", description: "Number of business days, 1-250 (default 30)" } },
      },
      output: { example: { days: 30, count: 30, history: [{ recordDate: "2026-05-01", yr2: 4.71, yr10: 4.46 }] } },
    },
    handler: async (i) => {
      const days = Math.min(Math.max(parseInt(i.days, 10) || 30, 1), 250);
      const rows = await fetchFredYields();
      // FRED returns the full history; slice the tail to N business days.
      const tail = rows.slice(-days);
      return { days, count: tail.length, history: tail };
    },
  },
  {
    route: "GET /api/yield-curve-spread", name: "Treasury yield-curve spreads + inversion", slug: "yield-curve-spread", category: "data", price: "$0.015",
    description:
      "Derived 2s10s and 3m10y Treasury yield-curve spreads (in basis points) plus a boolean recession-signal flag when the curve is inverted. Source: FRED constant-maturity yields (public domain). No params.",
    tags: ["yield-curve", "spread", "2s10s", "3m10y", "inversion", "recession", "macro", "treasury", "rates", "bonds"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: { example: { recordDate: "2026-06-12", spread2s10sBps: -27, spread3m10yBps: -88, inverted2s10s: true, inverted3m10y: true, asOf: "FRED constant-maturity Treasury yields" } },
    },
    handler: async () => {
      const curve = await fetchLatestYieldCurve();
      const { yr2, yr10, mo3 } = curve;
      if (yr2 == null || yr10 == null || mo3 == null) throw bad("Required tenors missing from latest yield curve row", 502);
      const spread2s10sBps = Math.round((yr10 - yr2) * 100);
      const spread3m10yBps = Math.round((yr10 - mo3) * 100);
      return {
        recordDate: curve.recordDate,
        spread2s10sBps, spread3m10yBps,
        inverted2s10s: spread2s10sBps < 0,
        inverted3m10y: spread3m10yBps < 0,
        asOf: "FRED constant-maturity Treasury yields (public domain)",
      };
    },
  },
  {
    route: "GET /api/treasury-debt", name: "US total public debt outstanding", slug: "treasury-debt", category: "data", price: "$0.005",
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
    route: "GET /api/treasury-avg-rates", name: "Average interest rates on Treasury securities", slug: "treasury-avg-rates", category: "data", price: "$0.010",
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
    route: "GET /api/fx-historical", name: "Historical FX rate by date", slug: "fx-historical", category: "data", price: "$0.003",
    description:
      "Historical foreign-exchange rate for a specific date using European Central Bank reference rates (via Frankfurter). Returns the rate that was published on (or rolled forward to) the requested date. ?from=USD&to=EUR&date=2024-01-02",
    tags: ["forex", "fx", "currency", "historical", "exchange-rate", "ecb", "macro"],
    discovery: {
      input: { from: "USD", to: "EUR", date: "2024-01-02" },
      inputSchema: {
        properties: {
          from: { type: "string", description: "3-letter source currency code, e.g. USD" },
          to: { type: "string", description: "3-letter target currency code, e.g. EUR" },
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
      const j = await getJson(`https://api.frankfurter.dev/v1/${date}?from=${from}&to=${to}`);
      const rate = j?.rates?.[to];
      if (typeof rate !== "number") throw bad(`Frankfurter returned no rate for ${from}→${to} on ${date}`, 502);
      return { from, to, date: j.date ?? date, rate, source: "ECB via Frankfurter (open data)" };
    },
  },
  {
    route: "GET /api/fx-timeseries", name: "FX rate time series", slug: "fx-timeseries", category: "data", price: "$0.010",
    description:
      "Daily FX rates between two currencies across a date window using European Central Bank reference rates (via Frankfurter). ?from=USD&to=EUR&startDate=2024-01-02&endDate=2024-01-31",
    tags: ["forex", "fx", "currency", "time-series", "exchange-rate", "ecb", "macro", "history"],
    discovery: {
      input: { from: "USD", to: "EUR", startDate: "2024-01-02", endDate: "2024-01-31" },
      inputSchema: {
        properties: {
          from: { type: "string", description: "3-letter source currency code" },
          to: { type: "string", description: "3-letter target currency code" },
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
      const j = await getJson(`https://api.frankfurter.dev/v1/${startDate}..${endDate}?from=${from}&to=${to}`);
      const rates = j?.rates ?? {};
      const series = Object.keys(rates).sort().map((d) => ({ date: d, rate: rates[d]?.[to] ?? null }))
        .filter((p) => typeof p.rate === "number");
      if (!series.length) throw bad("Frankfurter returned no rates for the requested window", 502);
      return { from, to, startDate, endDate, count: series.length, series, source: "ECB via Frankfurter (open data)" };
    },
  },
  {
    route: "GET /api/fx-dashboard", name: "G10 FX dashboard vs USD", slug: "fx-dashboard", category: "data", price: "$0.015",
    description:
      "Snapshot of all G10 spot exchange rates quoted against USD (EUR, GBP, JPY, CHF, CAD, AUD, NZD, SEK, NOK) using ECB reference rates. Includes the USD-strength index (simple geometric mean of inverse rates). No params.",
    tags: ["forex", "fx", "dashboard", "g10", "dxy", "usd-strength", "ecb", "macro"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: { example: { base: "USD", date: "2026-06-12", rates: { EUR: 0.91, GBP: 0.78 }, usdStrengthIndex: 1.04, source: "ECB via Frankfurter" } },
    },
    handler: async () => {
      // OBSERVED failing from prod (4× 504 on 2026-07-23; sub-second from a
      // laptop) — the shared-egress-IP pattern. Two remedies, both justified
      // by the data's own cadence (ECB reference rates update once daily):
      //   1. serve-stale cache: a same-day snapshot is simply the answer, and
      //      a stale one (marked) beats a 504 for a dashboard read.
      //   2. keyless fallback host (open.er-api.com, the fx-rate fallback) —
      //      different publisher, same quotes to 4dp; source says which served.
      const fresh = fxDashCache && Date.now() - fxDashCache.at < FX_DASH_TTL_MS;
      if (fresh) return fxDashCache.value;
      let j = null, source = "ECB via Frankfurter (open data)";
      try {
        j = await getJson(`https://api.frankfurter.dev/v1/latest?from=USD&to=${G10.join(",")}`, FX_PRIMARY);
      } catch (e) {
        console.warn(`[fx-dashboard] frankfurter failed (${String(e?.message || e).slice(0, 80)}) - walking to open.er-api.com`);
        try {
          const alt = await getJson("https://open.er-api.com/v6/latest/USD");
          if (alt?.result === "success" && alt?.rates) {
            j = { date: String(alt.time_last_update_utc || "").slice(0, 16) || null, rates: alt.rates };
            source = "Open ER-API (open data; Frankfurter unavailable)";
          }
        } catch (e2) {
          console.warn(`[fx-dashboard] open.er-api.com also failed (${String(e2?.message || e2).slice(0, 80)})`);
        }
      }
      if (!j) {
        // Both hosts down: a marked same-day-ish snapshot beats a 504.
        if (fxDashCache && Date.now() - fxDashCache.at < FX_DASH_STALE_MS) {
          return { ...fxDashCache.value, stale: true, asOf: new Date(fxDashCache.at).toISOString() };
        }
        throw bad("FX upstreams unavailable (Frankfurter and Open ER-API)", 502);
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
        source,
      };
      fxDashCache = { at: Date.now(), value };
      return value;
    },
  },
  {
    route: "GET /api/world-bank-indicator", name: "World Bank indicator series", slug: "world-bank-indicator", category: "data", price: "$0.010",
    description:
      "Fetch a World Bank indicator time series for a country (e.g. GDP, inflation, unemployment, population). Open data, no key. ?country=US&indicator=NY.GDP.MKTP.CD&startYear=2018&endYear=2022",
    tags: ["world-bank", "gdp", "inflation", "unemployment", "macro", "indicators", "country", "economic-data"],
    discovery: {
      input: { country: "US", indicator: "NY.GDP.MKTP.CD", startYear: 2018, endYear: 2022 },
      inputSchema: {
        properties: {
          country: { type: "string", description: "ISO-2 or ISO-3 country code (e.g. US, USA, DE)" },
          indicator: { type: "string", description: "World Bank indicator code, e.g. NY.GDP.MKTP.CD (nominal GDP USD)" },
          startYear: { type: "number", description: "First year (default 2018)" },
          endYear: { type: "number", description: "Last year (default 2023)" },
        },
        required: ["country", "indicator"],
      },
      output: { example: { country: "US", indicator: "NY.GDP.MKTP.CD", indicatorName: "GDP (current US$)", count: 5, series: [{ year: 2022, value: 25462700000000 }] } },
    },
    handler: async (i) => {
      const country = String(i.country ?? "").trim().toUpperCase();
      const indicator = String(i.indicator ?? "").trim().toUpperCase();
      if (!/^[A-Z]{2,3}$/.test(country)) throw bad('"country" must be a 2- or 3-letter ISO country code');
      if (!/^[A-Z0-9.]{3,40}$/.test(indicator)) throw bad('"indicator" must look like a World Bank indicator code (e.g. NY.GDP.MKTP.CD)');
      const startYear = Math.min(Math.max(parseInt(i.startYear, 10) || 2018, 1960), 2100);
      const endYear = Math.min(Math.max(parseInt(i.endYear, 10) || 2023, startYear), 2100);
      const url = `https://api.worldbank.org/v2/country/${country}/indicator/${indicator}?format=json&date=${startYear}:${endYear}&per_page=200`;
      const j = await getJson(url);
      // World Bank's idiosyncratic response: a 2-element array [meta, rows].
      if (!Array.isArray(j) || j.length < 2 || !Array.isArray(j[1])) {
        const msg = Array.isArray(j) && j[0]?.message?.[0]?.value ? j[0].message[0].value : "World Bank returned no series";
        throw bad(msg, 502);
      }
      const rows = j[1];
      const series = rows
        .filter((r) => r && r.value != null)
        .map((r) => ({ year: parseInt(r.date, 10), value: Number(r.value) }))
        .sort((a, b) => a.year - b.year);
      if (!series.length) throw bad("World Bank returned no values for this country/indicator/window", 502);
      return {
        country, indicator,
        indicatorName: rows[0]?.indicator?.value ?? null,
        countryName: rows[0]?.country?.value ?? null,
        count: series.length, series,
        source: "World Bank Open Data API",
      };
    },
  },
  {
    route: "GET /api/world-bank-search", name: "Search World Bank indicators", slug: "world-bank-search", category: "data", price: "$0.005",
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
      return { query: q, count: matches.length, indicators: matches, source: "World Bank Open Data API" };
    },
  },
];

// ---------------------------------------------------------------------------
// Keyed FRED tools (require FRED_API_KEY env var).
// Without the key, each handler returns 503 "not configured" — same shape as
// the BRAVE_API_KEY-backed /api/search tool, so the universal "answers its own
// example" CI check tolerates the unconfigured deployment path.
// ---------------------------------------------------------------------------

const FRED_BASE = "https://api.stlouisfed.org/fred";

function requireFredKey() {
  // GitHub Secrets sometimes pick up a trailing newline when pasted; URLSearchParams
  // would percent-encode that into the request, and FRED would reject the resulting
  // key as unregistered. Trim once at read time so every callsite is safe.
  const key = (process.env.FRED_API_KEY || "").trim();
  if (!key) throw bad("FRED is not configured on this deployment (set FRED_API_KEY)", 503);
  return key;
}

// FRED API v2 (launched Nov 4, 2025) issues a separate API key from v1 — they
// share the same account but are independent credentials. v2 calls must use
// FRED_API_KEY_V2; never substitute the v1 key (v2 will reject it).
function requireFredV2Key() {
  const key = (process.env.FRED_API_KEY_V2 || "").trim();
  if (!key) throw bad("FRED v2 is not configured on this deployment (set FRED_API_KEY_V2 - distinct from v1 key)", 503);
  return key;
}

// FRED's JSON API puts diagnostics in the 4xx response body
// (v1: `{"error_code":400,"error_message":"Variable api_key is not registered."}`,
//  v2: `{"code":401,"message":"Missing or invalid credentials."}`).
// safeFetch discards 4xx bodies on principle (right for HTML scrapers, wrong here),
// so we use a dedicated helper that still calls assertPublicUrl for SSRF protection
// but surfaces FRED's error message verbatim.
//
// `extraHeaders` lets v2 callsites pass `Authorization: Bearer <key>` — v2 dropped
// query-param auth in favor of headers.
// One retry on transient upstream failures: FRED's own gateway 504s in short
// bursts (four on 2026-07-15 alone, per tool_error telemetry) and the raw
// fetch previously had no second chance — and no timeout, so a hung FRED
// connection held the caller's request open indefinitely.
// `timeoutMs`/`retries` exist because FRED endpoints have wildly different
// latency profiles: /series/observations answers in well under a second, but
// /releases/dates runs 15-60s under load. The blanket 15s ceiling added in the
// 2026-07-15 resilience pass MANUFACTURED a full outage of
// fred-release-calendar the morning it deployed (every >15s response became a
// guaranteed 504 at 2×15s, while the old un-timed-out fetch had been quietly
// succeeding at 30-60s). Per FRED's error docs the API fails fast with real
// codes (400/404/423/429/500) — a slow response is a response in progress,
// not an outage, so slow endpoints get a budget that matches, not a retry.
async function fredGetJson(url, extraHeaders = {}, { timeoutMs, retries } = {}) {
  return retryTransient(() => fredGetJsonOnce(url, extraHeaders, timeoutMs), retries !== undefined ? { retries } : {});
}

async function fredGetJsonOnce(url, extraHeaders = {}, timeoutMs = 15_000) {
  const safeUrl = await assertPublicUrl(url);
  let res;
  try {
    res = await fetch(safeUrl, { headers: { Accept: "application/json", ...extraHeaders }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw bad(`FRED unreachable: ${e.name === "TimeoutError" ? `no response within ${Math.round(timeoutMs / 1000)}s` : e.message}`, 504);
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  if (!res.ok) {
    // Redact the full body/message before slicing — FRED_API_KEY(_V2) rides the
    // query string (v1) and could be reflected in an upstream diagnostic.
    const msg = redactSecrets(body?.error_message || body?.message || text || `HTTP ${res.status}`).slice(0, 200);
    // FRED 4xx with a key set almost always means a bad/expired/whitespace key —
    // attribute as caller-fixable (422) so it shows up in client_errored.
    throw bad(`FRED upstream HTTP ${res.status}: ${msg}`, res.status >= 500 ? 502 : 422);
  }
  if (!body) throw bad("FRED returned non-JSON response", 502);
  return body;
}

// FRED accepts only a controlled set of `units` transformations; reject other
// values up front so the caller gets a clear error instead of an opaque 400
// from the upstream.
const FRED_UNITS = new Set(["lin", "chg", "ch1", "pch", "pc1", "pca", "cca", "log"]);
// Likewise for frequency aggregation (daily series rolled up to weekly,
// monthly, quarterly, etc.).
const FRED_FREQ = new Set(["d", "w", "bw", "m", "q", "sa", "a", "wef", "weth", "wew", "wetu", "wem", "wesu", "wesa", "bwew", "bwem"]);

async function fredObservations({ seriesId, startDate, endDate, limit, units, frequency, latest = false }) {
  const key = requireFredKey();
  const qs = new URLSearchParams({ series_id: seriesId, api_key: key, file_type: "json" });
  if (startDate) qs.set("observation_start", startDate);
  if (endDate) qs.set("observation_end", endDate);
  if (limit) qs.set("limit", String(limit));
  if (units) qs.set("units", units);
  if (frequency) qs.set("frequency", frequency);
  // Default to ascending (caller wants a chronological window). For "trailing N
  // most-recent" callers (cpi-yoy, fed-funds, etc.), `latest: true` flips to
  // descending so the limit slices the *newest* N, then we reverse client-side
  // to restore chronological order for the consumer.
  qs.set("sort_order", latest ? "desc" : "asc");
  const j = await fredGetJson(`${FRED_BASE}/series/observations?${qs}`);
  if (j?.error_code) throw bad(`FRED upstream error: ${j.error_message || "unknown"}`, 502);
  let obs = (j?.observations ?? [])
    .filter((o) => o.value !== ".")
    .map((o) => ({ date: o.date, value: Number(o.value) }));
  if (latest) obs = obs.reverse();
  return obs;
}

MACRO_TOOLS.push(
  {
    route: "GET /api/fred-series", name: "FRED time series", slug: "fred-series", category: "data", price: "$0.015",
    description:
      "Fetch any of FRED's ~800,000 economic time series by series ID - GDP (GDPC1), CPI (CPIAUCSL), unemployment (UNRATE), fed funds (DFF), and so on. Supports date windowing and the standard FRED units transformations (lin, chg, ch1, pch, pc1, pca, cca, log). ?seriesId=GDPC1&startDate=2018-01-01&endDate=2023-12-31&units=pc1 This product uses the FRED(R) API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
    tags: ["fred", "series", "time-series", "gdp", "cpi", "inflation", "unemployment", "fed", "macro", "economic-data", "st-louis-fed"],
    discovery: {
      input: { seriesId: "GDPC1", startDate: "2018-01-01", endDate: "2022-12-31" },
      inputSchema: {
        properties: {
          seriesId: { type: "string", description: "FRED series ID, e.g. GDPC1, CPIAUCSL, UNRATE, DFF" },
          startDate: { type: "string", description: "ISO start date (YYYY-MM-DD), optional" },
          endDate: { type: "string", description: "ISO end date (YYYY-MM-DD), optional" },
          limit: { type: "number", description: "Max observations, 1-100000 (default 1000)" },
          units: { type: "string", description: "Transformation: lin, chg, ch1, pch, pc1 (YoY %), pca, cca, log" },
          frequency: { type: "string", description: "Aggregate to d/w/m/q/sa/a, etc. (optional)" },
        },
        required: ["seriesId"],
      },
      output: { example: { seriesId: "GDPC1", count: 20, observations: [{ date: "2018-01-01", value: 18733.0 }], source: "FRED (St. Louis Fed)" } },
    },
    handler: async (i) => {
      const seriesId = String(i.seriesId ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9_]{1,40}$/.test(seriesId)) throw bad('"seriesId" must look like a FRED series ID (e.g. GDPC1, CPIAUCSL)');
      const startDate = i.startDate ? String(i.startDate).trim() : undefined;
      const endDate = i.endDate ? String(i.endDate).trim() : undefined;
      if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw bad('"startDate" must be ISO YYYY-MM-DD');
      if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw bad('"endDate" must be ISO YYYY-MM-DD');
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || 1000, 1), 100000);
      const units = i.units ? String(i.units).trim().toLowerCase() : undefined;
      if (units && !FRED_UNITS.has(units)) throw bad(`"units" must be one of: ${[...FRED_UNITS].join(", ")}`);
      const frequency = i.frequency ? String(i.frequency).trim().toLowerCase() : undefined;
      if (frequency && !FRED_FREQ.has(frequency)) throw bad(`"frequency" must be one of: ${[...FRED_FREQ].join(", ")}`);
      const observations = await fredObservations({ seriesId, startDate, endDate, limit, units, frequency });
      return { seriesId, units: units ?? "lin", count: observations.length, observations, source: "FRED (St. Louis Fed)" };
    },
  },
  {
    route: "GET /api/fred-search", name: "FRED catalog search", slug: "fred-search", category: "data", price: "$0.005",
    description:
      "Full-text search across FRED's ~800,000 economic time series. Returns series IDs (use with /api/fred-series), titles, frequency, units, and a popularity score. ?q=unemployment+rate&limit=10 This product uses the FRED(R) API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
    tags: ["fred", "search", "catalog", "economic-data", "st-louis-fed", "macro", "time-series"],
    discovery: {
      input: { q: "consumer price index", limit: 5 },
      inputSchema: {
        properties: {
          q: { type: "string", description: "Search text" },
          limit: { type: "number", description: "Results to return, 1-100 (default 10)" },
        },
        required: ["q"],
      },
      output: { example: { query: "consumer price index", count: 5, results: [{ id: "CPIAUCSL", title: "Consumer Price Index for All Urban Consumers: All Items", frequency: "Monthly", units: "Index 1982-1984=100", popularity: 95 }] } },
    },
    handler: async (i) => {
      const q = String(i.q ?? "").trim();
      if (!q) throw bad('"q" is required');
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || 10, 1), 100);
      const key = requireFredKey();
      const qs = new URLSearchParams({ search_text: q, api_key: key, file_type: "json", limit: String(limit), order_by: "popularity", sort_order: "desc" });
      const j = await fredGetJson(`${FRED_BASE}/series/search?${qs}`);
      if (j?.error_code) throw bad(`FRED upstream error: ${j.error_message || "unknown"}`, 502);
      const results = (j?.seriess ?? []).map((s) => ({
        id: s.id, title: s.title,
        frequency: s.frequency ?? null, units: s.units ?? null,
        seasonalAdjustment: s.seasonal_adjustment_short ?? null,
        observationStart: s.observation_start ?? null,
        observationEnd: s.observation_end ?? null,
        popularity: typeof s.popularity === "number" ? s.popularity : null,
      }));
      return { query: q, count: results.length, results, source: "FRED (St. Louis Fed)" };
    },
  },
  {
    route: "GET /api/fred-series-info", name: "FRED series metadata", slug: "fred-series-info", category: "data", price: "$0.005",
    description:
      "Metadata for a FRED series: title, frequency, units, seasonal adjustment, observation date range, and popularity. Use before /api/fred-series to confirm the series fits your needs. ?seriesId=UNRATE This product uses the FRED(R) API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
    tags: ["fred", "series", "metadata", "economic-data", "st-louis-fed", "macro"],
    discovery: {
      input: { seriesId: "UNRATE" },
      inputSchema: {
        properties: { seriesId: { type: "string", description: "FRED series ID, e.g. UNRATE" } },
        required: ["seriesId"],
      },
      output: { example: { id: "UNRATE", title: "Unemployment Rate", frequency: "Monthly", units: "Percent", observationStart: "1948-01-01", observationEnd: "2026-05-01", popularity: 94 } },
    },
    handler: async (i) => {
      const seriesId = String(i.seriesId ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9_]{1,40}$/.test(seriesId)) throw bad('"seriesId" must look like a FRED series ID');
      const key = requireFredKey();
      const qs = new URLSearchParams({ series_id: seriesId, api_key: key, file_type: "json" });
      const j = await fredGetJson(`${FRED_BASE}/series?${qs}`);
      if (j?.error_code) throw bad(`FRED upstream error: ${j.error_message || "unknown"}`, 502);
      const s = j?.seriess?.[0];
      if (!s) throw bad(`FRED has no series with ID "${seriesId}"`, 404);
      return {
        id: s.id, title: s.title,
        frequency: s.frequency ?? null, units: s.units ?? null,
        seasonalAdjustment: s.seasonal_adjustment_short ?? null,
        observationStart: s.observation_start ?? null,
        observationEnd: s.observation_end ?? null,
        lastUpdated: s.last_updated ?? null,
        popularity: typeof s.popularity === "number" ? s.popularity : null,
        notes: (s.notes ?? "").replace(/\s+/g, " ").slice(0, 480),
        source: "FRED (St. Louis Fed)",
      };
    },
  },
  {
    route: "GET /api/fred-release-calendar", name: "FRED economic release calendar", slug: "fred-release-calendar", category: "data", price: "$0.005",
    description:
      "Upcoming and very-recent US economic data release dates - CPI, employment, GDP, FOMC minutes, Treasury auctions, etc. Useful for scheduling agents around event-driven moves. ?days=14 (default 14, range 1-90). This product uses the FRED(R) API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
    tags: ["fred", "calendar", "releases", "cpi", "jobs", "gdp", "fomc", "macro", "economic-data"],
    discovery: {
      input: { days: 14 },
      inputSchema: {
        properties: { days: { type: "number", description: "Window in days from today (1-90, default 14)" } },
      },
      output: { example: { days: 14, count: 12, releases: [{ releaseId: 10, releaseName: "Consumer Price Index", date: "2026-06-12" }] } },
    },
    handler: async (i) => {
      const days = Math.min(Math.max(parseInt(i.days, 10) || 14, 1), 90);
      // Key check stays OUTSIDE the stale wrapper: an unconfigured deployment
      // must keep 503ing, never serve a snapshot it couldn't have fetched.
      const key = requireFredKey();
      return withStaleFallback(releaseCalLastGood, days, async () => {
        const today = new Date();
        const end = new Date(today.getTime() + days * 86400 * 1000);
        const fmt = (d) => d.toISOString().slice(0, 10);
        // include_release_dates_with_no_data=true is essential — without it FRED
        // hides scheduled-but-not-yet-published releases, which is exactly the
        // forward-looking calendar callers want.
        const qs = new URLSearchParams({
          api_key: key, file_type: "json",
          realtime_start: fmt(today), realtime_end: fmt(end),
          include_release_dates_with_no_data: "true",
          order_by: "release_date", sort_order: "asc",
          limit: "1000",
        });
        // /releases/dates is FRED's slowest query — 15-60s under load (observed
        // 2026-07-15/16). One attempt with a budget that fits: slow is a state,
        // not a blip, so a retry only doubles the wait for the same answer —
        // the stale fallback covers a miss instead.
        const j = await fredGetJson(`${FRED_BASE}/releases/dates?${qs}`, {}, { timeoutMs: 45_000, retries: 0 });
        if (j?.error_code) throw bad(`FRED upstream error: ${j.error_message || "unknown"}`, 502);
        const releases = (j?.release_dates ?? []).map((r) => ({
          releaseId: r.release_id,
          releaseName: r.release_name,
          date: r.date,
        }));
        return { days, count: releases.length, releases, source: "FRED (St. Louis Fed)" };
      }, { maxStaleMs: MACRO_STALE_MAX_MS });
    },
  },
  {
    route: "GET /api/sahm-rule", name: "Sahm Rule recession indicator", slug: "sahm-rule", category: "data", price: "$0.015",
    description:
      "Real-time Sahm Rule recession indicator from FRED (SAHMREALTIME series). The Sahm Rule triggers when the 3-month moving average of US unemployment rises ≥0.50 percentage points above its prior-12-month low - historically a clean recession signal. No params.",
    tags: ["sahm-rule", "recession", "unemployment", "macro", "fred", "indicator", "signal"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: { example: { date: "2026-05-01", value: 0.43, triggered: false, threshold: 0.5, source: "FRED SAHMREALTIME" } },
    },
    handler: async () => {
      const obs = await fredObservations({ seriesId: "SAHMREALTIME", limit: 1, latest: true });
      if (!obs.length) throw bad("FRED SAHMREALTIME returned no observations", 502);
      const last = obs[obs.length - 1];
      return {
        date: last.date, value: last.value,
        triggered: last.value >= 0.5,
        threshold: 0.5,
        source: "FRED SAHMREALTIME (real-time Sahm Rule, St. Louis Fed)",
      };
    },
  },
  {
    route: "GET /api/cpi-yoy", name: "US CPI year-over-year inflation", slug: "cpi-yoy", category: "data", price: "$0.015",
    description:
      "Latest US Consumer Price Index year-over-year inflation rate (headline CPI-U) plus the trailing 12 months of YoY readings - the headline inflation number. Source: FRED CPIAUCSL with pc1 transformation. No params.",
    tags: ["cpi", "inflation", "yoy", "consumer-price-index", "macro", "fred", "bls", "headline-inflation"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: { example: { date: "2026-05-01", inflationYoYPct: 3.4, trailing12mo: [{ date: "2025-06-01", value: 3.0 }], source: "FRED CPIAUCSL (BLS)" } },
    },
    handler: async () => {
      const obs = await fredObservations({ seriesId: "CPIAUCSL", units: "pc1", limit: 13, latest: true });
      if (!obs.length) throw bad("FRED CPIAUCSL returned no observations", 502);
      const last = obs[obs.length - 1];
      return {
        date: last.date,
        inflationYoYPct: Number(last.value.toFixed(2)),
        trailing12mo: obs.slice(-12).map((o) => ({ date: o.date, value: Number(o.value.toFixed(2)) })),
        source: "FRED CPIAUCSL with year-over-year transform (Bureau of Labor Statistics)",
      };
    },
  },
  {
    route: "GET /api/unemployment-rate", name: "US unemployment rate (UNRATE)", slug: "unemployment-rate", category: "data", price: "$0.010",
    description:
      "Latest US unemployment rate plus a trailing N-month series for trend. Source: FRED UNRATE (Bureau of Labor Statistics). ?months=12 (1-120, default 12).",
    tags: ["unemployment", "unrate", "labor", "jobs", "bls", "fred", "macro"],
    discovery: {
      input: { months: 12 },
      inputSchema: {
        properties: { months: { type: "number", description: "Trailing months to return (1-120, default 12)" } },
      },
      output: { example: { date: "2026-05-01", current: 4.1, months: 12, history: [{ date: "2025-06-01", value: 4.0 }], source: "FRED UNRATE (BLS)" } },
    },
    handler: async (i) => {
      const months = Math.min(Math.max(parseInt(i.months, 10) || 12, 1), 120);
      const obs = await fredObservations({ seriesId: "UNRATE", limit: months, latest: true });
      if (!obs.length) throw bad("FRED UNRATE returned no observations", 502);
      const last = obs[obs.length - 1];
      return {
        date: last.date, current: last.value,
        months: obs.length,
        history: obs,
        source: "FRED UNRATE (Bureau of Labor Statistics)",
      };
    },
  },
  {
    route: "GET /api/fed-funds", name: "Effective federal funds rate", slug: "fed-funds", category: "data", price: "$0.010",
    description:
      "Current effective federal funds rate plus a trailing N-day series. Source: FRED DFF (Board of Governors). ?days=30 (1-365, default 30).",
    tags: ["fed-funds", "interest-rates", "monetary-policy", "fomc", "fed", "macro", "fred"],
    discovery: {
      input: { days: 30 },
      inputSchema: {
        properties: { days: { type: "number", description: "Trailing days to return (1-365, default 30)" } },
      },
      output: { example: { date: "2026-06-17", current: 5.33, days: 30, history: [{ date: "2026-05-19", value: 5.33 }], source: "FRED DFF" } },
    },
    handler: async (i) => {
      const days = Math.min(Math.max(parseInt(i.days, 10) || 30, 1), 365);
      const obs = await fredObservations({ seriesId: "DFF", limit: days, latest: true });
      if (!obs.length) throw bad("FRED DFF returned no observations", 502);
      const last = obs[obs.length - 1];
      return {
        date: last.date, current: last.value,
        days: obs.length, history: obs,
        source: "FRED DFF (Board of Governors of the Federal Reserve System)",
      };
    },
  },
  {
    // FRED API v2 (launched Nov 4, 2025) introduced bulk release/observations:
    // one call returns observations for EVERY series in a given release. Saves
    // an agent from making N round-trips (e.g. one call gets every series in
    // the Employment Situation report; one call gets every CPI subseries).
    // Uses cursor pagination instead of offset/limit — caller passes the
    // {lastSeriesId, lastObservationDate} from a previous response back in to
    // get the next page.
    //
    // Common release IDs:
    //   10  = Consumer Price Index           18  = H.15 Selected Interest Rates
    //   50  = Employment Situation           53  = Gross Domestic Product
    //   91  = G.17 Industrial Production     151 = JOLTS
    // Full release list: https://fred.stlouisfed.org/releases
    route: "GET /api/fred-release-observations", name: "FRED bulk release observations (v2)", slug: "fred-release-observations", category: "data", price: "$0.025",
    description:
      "Bulk-fetch observations for every series in a FRED release in one call. Use it to grab an entire economic report (jobs report, CPI report, GDP release) without enumerating constituent series IDs first. Returns paginated; pass lastSeriesId + lastObservationDate back to fetch the next page. ?releaseId=18 for H.15 (Selected Interest Rates), 10 for CPI, 50 for Employment Situation, 53 for GDP. Source: FRED API v2 /release/observations endpoint. This product uses the FRED(R) API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
    tags: ["fred", "release", "bulk", "observations", "v2", "cpi", "jobs", "gdp", "h15", "interest-rates", "employment", "macro", "economic-data"],
    discovery: {
      input: { releaseId: 18, startDate: "2026-05-01", endDate: "2026-06-01" },
      inputSchema: {
        properties: {
          releaseId: { type: "number", description: "FRED release ID (e.g. 18 for H.15, 10 for CPI, 50 for jobs, 53 for GDP)" },
          startDate: { type: "string", description: "ISO start date (YYYY-MM-DD), optional" },
          endDate: { type: "string", description: "ISO end date (YYYY-MM-DD), optional" },
          lastSeriesId: { type: "string", description: "Pagination cursor: lastSeriesId from previous response (optional)" },
          lastObservationDate: { type: "string", description: "Pagination cursor: lastObservationDate from previous response (optional)" },
        },
        required: ["releaseId"],
      },
      output: { example: { releaseId: 18, releaseName: "H.15 Selected Interest Rates", count: 16, series: [{ seriesId: "DGS10", title: "10-Year Treasury Constant Maturity Rate", units: "Percent", observations: [{ date: "2026-06-17", value: 4.49 }] }], cursor: { hasMore: false }, source: "FRED API v2" } },
    },
    handler: async (i) => {
      const releaseId = parseInt(i.releaseId, 10);
      if (!Number.isFinite(releaseId) || releaseId < 1 || releaseId > 100000) throw bad('"releaseId" must be a positive integer (see https://fred.stlouisfed.org/releases)');
      const startDate = i.startDate ? String(i.startDate).trim() : undefined;
      const endDate = i.endDate ? String(i.endDate).trim() : undefined;
      if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw bad('"startDate" must be ISO YYYY-MM-DD');
      if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw bad('"endDate" must be ISO YYYY-MM-DD');
      const key = requireFredV2Key();
      // FRED API v2 dropped query-param api_key auth — credentials must be passed
      // as `Authorization: Bearer <key>` instead (modern OAuth-style).
      const qs = new URLSearchParams({ release_id: String(releaseId), file_type: "json" });
      if (startDate) qs.set("observation_start", startDate);
      if (endDate) qs.set("observation_end", endDate);
      if (i.lastSeriesId) qs.set("last_series_id", String(i.lastSeriesId));
      if (i.lastObservationDate) qs.set("last_observation_date", String(i.lastObservationDate));
      const j = await fredGetJson(`${FRED_BASE}/v2/release/observations?${qs}`, { Authorization: `Bearer ${key}` });
      if (j?.error_code) throw bad(`FRED v2 upstream error: ${j.error_message || j.message || "unknown"}`, 502);
      // FRED v2 response shape (per docs): { release: {release_id, name, ...}, series: [{series_id, title, units, observations: [...]}], cursor or pagination fields }.
      // We pass through verbatim with minimal normalization so callers see what FRED returned.
      const series = (j?.series ?? []).map((s) => ({
        seriesId: s.series_id,
        title: s.title,
        frequency: s.frequency,
        units: s.units,
        seasonalAdjustment: s.seasonal_adjustment,
        lastUpdated: s.last_updated,
        observations: (s.observations ?? [])
          .filter((o) => o.value !== ".")
          .map((o) => ({ date: o.date, value: Number(o.value) })),
      }));
      return {
        releaseId: j?.release?.release_id ?? releaseId,
        releaseName: j?.release?.name ?? null,
        count: series.length,
        series,
        cursor: {
          hasMore: Boolean(j?.has_more ?? j?.cursor?.has_more ?? false),
          lastSeriesId: j?.last_series_id ?? j?.cursor?.last_series_id ?? null,
          lastObservationDate: j?.last_observation_date ?? j?.cursor?.last_observation_date ?? null,
        },
        source: "FRED API v2 /release/observations (St. Louis Fed, launched Nov 2025)",
      };
    },
  },
);
