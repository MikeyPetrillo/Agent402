// The wholesale surface: a stable, versioned JSON read per tool family for a
// reseller that builds on this catalog. Each tool row carries the same price
// the public route charges (no wholesale discount: one price for everyone),
// its source credit, and its measured reliability: success rate over the last
// 24 hours of outside calls and latency percentiles, both from the counters
// the server already keeps (src/tool-failure-monitor.js, src/request-timing.js).
//
// Only families whose sources allow their answers to be passed on are
// listed: public-domain government data (SEC EDGAR, the US Treasury, the
// National Weather Service), CC BY 4.0 weather data with its credit, and our
// own computation. Licensed market data, search results and model output are
// not offered here.
//
// Honest by construction: a rate needs WHOLESALE_MIN_SAMPLE calls in its
// window or it reads null with the reason; a rate is rounded down and a
// latency rounded up, never in the tool's favor; call volume is a band, never
// a count. The v1 field set only grows (scripts/test-wholesale.js pins it).
import { TOOL_CLASSES } from "./tool-failure-monitor.js";
import { ERROR_CODES } from "./stable-error-code.js";
import { OPEN_METEO_ATTRIBUTION, US_TREASURY_ATTRIBUTION } from "./data-attribution.js";

export const WHOLESALE_VERSION = "v1";
export const WHOLESALE_MIN_SAMPLE = 20;
const WINDOW_MS = 24 * 3600_000;
const BUCKET_MS = 5 * 60_000; // the failure monitor's bucket size

/** Families: id, title, source, redistribution basis, the credit a reseller
 *  keeps with every answer, and the slugs (a function of the server's facts). */
export const WHOLESALE_FAMILIES = Object.freeze([
  {
    id: "compute", title: "Computation tools", source: "our own code; no outside data source",
    redistribution: "own-computation", credit: null,
    slugs: ({ powSlugs }) => [...powSlugs],
  },
  {
    id: "sec-filings", title: "SEC filings and company financials", source: "SEC EDGAR (data.sec.gov, efts.sec.gov)",
    redistribution: "public-domain", credit: "Source: SEC EDGAR.",
    slugs: () => ["edgar-company-lookup", "edgar-filings", "edgar-company-concept", "edgar-company-facts", "edgar-xbrl-frame", "company-financials", "edgar-insider-trades", "edgar-13f-holdings", "edgar-recent-ipos", "edgar-search", "edgar-13f-datasets", "edgar-13f-dataset-head", "filings-brief"],
  },
  {
    id: "us-treasury", title: "US Treasury rates and debt", source: "US Treasury (fiscaldata.treasury.gov, home.treasury.gov)",
    redistribution: "public-domain", credit: US_TREASURY_ATTRIBUTION,
    slugs: () => ["treasury-yield-curve", "treasury-yield-history", "yield-curve-spread", "treasury-debt", "treasury-avg-rates"],
  },
  {
    id: "weather", title: "Weather forecasts, history, air quality and risk", source: "Open-Meteo (CC BY 4.0) and the National Weather Service",
    redistribution: "cc-by-4.0", credit: OPEN_METEO_ATTRIBUTION,
    slugs: () => ["weather-current", "weather-daily", "weather-hourly", "weather-history", "weather-air-quality", "weather-window", "weather-thresholds", "weather-probability", "place-lookup", "weather-forecast", "weather-alerts", "weather-risk-brief"],
  },
]);

export const RELIABILITY_DEFINITION = Object.freeze({
  window: "24h",
  successRate: `answers under 400 divided by answers under 400 plus server-side failures (5xx and timeouts), over outside calls (buyers and free-tier callers; our own probes are left out) in the last 24 hours, rounded down to 0.001. Caller mistakes (4xx), refused payments and callers who hung up are not counted either way. Null with a reason below ${WHOLESALE_MIN_SAMPLE} counted calls.`,
  calls: `a band of the counted calls in the window ("<${WHOLESALE_MIN_SAMPLE}", "20-99", "100-999", "1000+"), never an exact count`,
  latencyMs: `p50 and p95 of server time per call (handler start to the last byte, payment round trip excluded) over the most recent calls this server answered (up to 512 per route since it started, every caller), rounded up to 10 ms. Null below ${WHOLESALE_MIN_SAMPLE} calls.`,
});

const roundDown3 = (x) => Math.floor(x * 1000) / 1000;
const roundUp10 = (x) => (Number.isFinite(x) ? Math.ceil(x / 10) * 10 : null);
export function callsBand(n) {
  if (!(n >= WHOLESALE_MIN_SAMPLE)) return `<${WHOLESALE_MIN_SAMPLE}`;
  if (n < 100) return "20-99";
  if (n < 1000) return "100-999";
  return "1000+";
}

/** Outside outcome counts for one slug over the last 24 hours, from the
 *  failure monitor's merged rows ({ bucket: { o, s, f } } of TOOL_CLASSES). */
export function outsideCounts(rows, now = Date.now()) {
  const floor = Math.floor((now - WINDOW_MS) / BUCKET_MS);
  const out = Object.fromEntries(TOOL_CLASSES.map((k) => [k, 0]));
  for (const [b, row] of Object.entries(rows || {})) {
    if (!(Number(b) > floor)) continue;
    for (const lane of ["o", "f"]) {
      const arr = Array.isArray(row?.[lane]) ? row[lane] : [];
      TOOL_CLASSES.forEach((k, i) => { const v = Number(arr[i]); if (Number.isFinite(v) && v > 0) out[k] += v; });
    }
  }
  return out;
}

/** The reliability block for one tool (pure). `timing` is a routeTimings()
 *  row for its route or null. */
export function reliabilityOf(rows, timing, now = Date.now()) {
  const c = outsideCounts(rows, now);
  const counted = c.ok + c.fail + c.timeout;
  const enough = counted >= WHOLESALE_MIN_SAMPLE;
  const latencyOk = timing && Number(timing.window) >= WHOLESALE_MIN_SAMPLE && Number.isFinite(timing.totalMs?.p50) && Number.isFinite(timing.totalMs?.p95);
  return {
    window: RELIABILITY_DEFINITION.window,
    calls: callsBand(counted),
    successRate: enough ? roundDown3(c.ok / counted) : null,
    ...(enough ? {} : { successRateNote: `fewer than ${WHOLESALE_MIN_SAMPLE} counted calls in the window` }),
    latencyMs: latencyOk ? { p50: roundUp10(timing.totalMs.p50), p95: roundUp10(timing.totalMs.p95) } : null,
    ...(latencyOk ? {} : { latencyNote: `fewer than ${WHOLESALE_MIN_SAMPLE} timed calls since this server started` }),
  };
}

const priceUsd = (p) => { const n = Number(String(p ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : null; };

/** One tool's wholesale row (pure). */
export function toolRow(key, def, { baseUrl, rows, timing, now }) {
  const [method, path] = key.split(" ");
  const quoted = def.quoteRange && Number.isFinite(def.quoteRange.minUsd) && Number.isFinite(def.quoteRange.maxUsd);
  return {
    slug: def.slug, name: def.name, method, path, url: `${baseUrl}${path}`,
    price: {
      text: def.price, usd: priceUsd(def.price),
      perRequest: quoted ? { minUsd: def.quoteRange.minUsd, maxUsd: def.quoteRange.maxUsd, note: "quoted in each 402 from the request body" } : null,
    },
    modelBacked: def.modelBacked === true,
    docs: `${baseUrl}/openapi.json`,
    reliability: reliabilityOf(rows, timing, now),
  };
}

function familyTools(family, ctx) {
  const wanted = new Set(family.slugs(ctx));
  return Object.entries(ctx.catalog)
    .filter(([, d]) => d && wanted.has(d.slug) && !d.modelBacked)
    .sort(([, a], [, b]) => a.slug.localeCompare(b.slug));
}

const COMMON = (baseUrl) => ({
  version: WHOLESALE_VERSION,
  stability: "Within v1, fields are only added, never renamed, retyped or removed. A breaking change ships as v2 beside v1.",
  pricing: "Every price here is the public route's own price, the same for every buyer (a payment network's premium, where one applies, applies here as it does there); there is no wholesale discount. Pay per call as on the public route.",
  errorCodes: { field: "errorCode", note: "every tool error answer carries errorCode beside the message; branch on the code, not the text", codes: ERROR_CODES },
  reliabilityDefinition: RELIABILITY_DEFINITION,
  docs: `${baseUrl}/wholesale`,
});

/** GET /api/wholesale/v1: the families and the contract. */
export function wholesaleIndex(ctx) {
  return {
    ...COMMON(ctx.baseUrl),
    asOf: new Date(ctx.now ?? Date.now()).toISOString(),
    families: WHOLESALE_FAMILIES.map((f) => ({
      id: f.id, title: f.title, source: f.source, redistribution: f.redistribution, credit: f.credit,
      tools: familyTools(f, ctx).length, url: `${ctx.baseUrl}/api/wholesale/v1/${f.id}`,
    })),
    notOffered: "Market data under a vendor license, search results and model output are not offered on this surface.",
  };
}

/** GET /api/wholesale/v1/:family, or null for an unknown family. */
export function wholesaleFamily(id, ctx) {
  const f = WHOLESALE_FAMILIES.find((x) => x.id === id);
  if (!f) return null;
  const now = ctx.now ?? Date.now();
  const tools = familyTools(f, ctx).map(([key, def]) => toolRow(key, def, { baseUrl: ctx.baseUrl, rows: ctx.toolRows?.[def.slug], timing: ctx.timingByRoute?.get(key) || null, now }));
  return {
    ...COMMON(ctx.baseUrl),
    asOf: new Date(now).toISOString(),
    family: { id: f.id, title: f.title, source: f.source, redistribution: f.redistribution, credit: f.credit },
    count: tools.length,
    tools,
  };
}
