// The wholesale surface: a stable, versioned JSON read per tool family for a
// reseller that builds on this catalog. Each tool row carries the same price
// the public route charges (no wholesale discount: one price for everyone),
// its source credit, and its reliability: success rate and p50/p95 latency
// over the last seven days, marked "measured" or "not enough data".
//
// Only families whose sources allow their answers to be passed on are
// listed: public-domain government data (SEC EDGAR, the US Treasury, the
// National Weather Service), CC BY 4.0 weather data with its credit, and our
// own computation. Licensed market data, search results and model output are
// not offered here.
//
// Reliability agrees with GET /api/reliability/tools: the same tool-call
// outcomes (the server hands in that table's cached read), the same window
// (WHOLESALE_WINDOW_HOURS) and minimum sample (WHOLESALE_MIN_SAMPLE), the
// same status words and the same rounding. No call volume in any form (no
// count, no band) and no ranking: per-tool volume stays operator-only. The
// v1 field set only grows (scripts/test-wholesale.js pins it).
import { ERROR_CODES } from "./stable-error-code.js";
import { OPEN_METEO_ATTRIBUTION, US_TREASURY_ATTRIBUTION } from "./data-attribution.js";

export const WHOLESALE_VERSION = "v1";
export const WHOLESALE_MIN_SAMPLE = 20;
export const WHOLESALE_WINDOW_HOURS = 168;
export const STATUS_MEASURED = "measured";
export const STATUS_THIN = "not enough data";

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
  windowHours: WHOLESALE_WINDOW_HOURS,
  minSample: WHOLESALE_MIN_SAMPLE,
  successRate: "answers below 400 over answers below 400 plus answers of 500 or above, in the last seven days; a 4xx (the caller's input, a payment refusal) is not counted either way; floored to three places",
  latency: "p50Ms and p95Ms: milliseconds inside the server, from the request reaching the tool to its answer, over the same calls",
  status: `measured, or not enough data when the tool had fewer than ${WHOLESALE_MIN_SAMPLE} calls in the window (its figures are then null)`,
  excluded: "this server's own monitoring and test calls, empty-input probes and refusals answered before payment",
  sameAs: "/api/reliability/tools",
});

const floorRate = (okCount, n) => (n ? Math.floor((okCount / n) * 1000) / 1000 : null);

/** The reliability block for one tool (pure), from its outcome row
 *  ({ n, ok, p50, p95 }, or none) and whether the outcomes could be read.
 *  The count is read to decide "measured" and never published. */
export function reliabilityOf(outcome, available) {
  const n = outcome ? Number(outcome.n) || 0 : 0;
  const measured = !!available && n >= WHOLESALE_MIN_SAMPLE;
  return {
    windowHours: WHOLESALE_WINDOW_HOURS,
    status: measured ? STATUS_MEASURED : STATUS_THIN,
    measured,
    successRate: measured ? floorRate(Number(outcome.ok) || 0, n) : null,
    p50Ms: measured && Number.isFinite(Number(outcome.p50)) ? Number(outcome.p50) : null,
    p95Ms: measured && Number.isFinite(Number(outcome.p95)) ? Number(outcome.p95) : null,
  };
}

const priceUsd = (p) => { const n = Number(String(p ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : null; };

/** One tool's wholesale row (pure). */
export function toolRow(key, def, { baseUrl, outcome, available }) {
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
    reliability: reliabilityOf(outcome, available),
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
  const available = !!ctx.outcomes?.ok;
  const bySlug = new Map((available ? ctx.outcomes.rows || [] : []).map((r) => [r.slug, r]));
  const tools = familyTools(f, ctx).map(([key, def]) => toolRow(key, def, { baseUrl: ctx.baseUrl, outcome: bySlug.get(def.slug), available }));
  return {
    ...COMMON(ctx.baseUrl),
    asOf: new Date(now).toISOString(),
    family: { id: f.id, title: f.title, source: f.source, redistribution: f.redistribution, credit: f.credit },
    reliabilityAvailable: available,
    ...(available ? {} : { reliabilityReason: String(ctx.outcomes?.reason || "not-configured").slice(0, 40) }),
    toolCount: tools.length,
    tools,
  };
}
