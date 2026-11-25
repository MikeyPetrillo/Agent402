#!/usr/bin/env node
// The bundle products (src/tools/bundle-kit.js), offline:
//   - the price rule is the skill-pack rule (same discount and floor), every
//     price is derived from the leg tools' own catalog prices (a repriced leg
//     moves the bundle), the 402 quote is per unit and capped at the ceiling;
//   - no product is model-backed or on the free tier;
//   - inputs are refused before any read, with the field named;
//   - the computed rows (scores, ratios, drawdown, volatility, flags) are
//     right on fixed inputs;
//   - through the real handlers, with the legs stubbed: a complete answer, a
//     caller mistake answered 422 naming the unit, a source failure answered
//     5xx (never a partial 200), one retry of a throttled leg.
//   node scripts/test-bundle-products.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { PACK_DISCOUNT, PACK_FLOOR_USD } from "./pack-prices.js";
import { BUNDLE_DISCOUNT, BUNDLE_FLOOR_USD, bundlePriceUsd, unitPartsUsd, usdText, priceUsdOf } from "../src/bundle-pricing.js";
import {
  BUNDLE_TOOLS, BUNDLE_LEGS, BUNDLE_MAX_UNITS, legTool, weatherSitesOf, filingTickersOf, coinIdsOf,
  weatherSiteRow, filingCompanyRow, candleStats, tokenRow, yearEarlier, WEATHER_RISK_WEIGHTS, LEG_RETRY_PAUSE_MS, WEATHER_CONCURRENCY,
  TOKEN_CONCURRENCY, FILINGS_CONCURRENCY,
} from "../src/tools/bundle-kit.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";
import { bundleLegAnswer, accessRefusalStatus, upstreamHostsForSlug } from "./lib/upstream-outage.js";
import { stubGuardResolver } from "./lib/guard-resolver-stub.js";
import { ATTRIBUTIONS, attributionTailOf, OPEN_METEO_ATTRIBUTION, CAMS_CREDIT, C3S_CREDIT, GEONAMES_ATTRIBUTION, COPERNICUS_DISCLAIMER } from "../src/data-attribution.js";
import { runAsRouteCall } from "../src/not-charged.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const throwsStatus = async (fn, status, re, m) => {
  try { await fn(); ok(false, `${m} (did not throw)`); } catch (e) { ok(e.statusCode === status && (!re || re.test(e.message)), `${m} (${e.statusCode}: ${String(e.message).slice(0, 120)})`); }
};

// ---- the rule
ok(BUNDLE_DISCOUNT === PACK_DISCOUNT && BUNDLE_FLOOR_USD === PACK_FLOOR_USD, `the bundle rule uses the pack rule's discount and floor (${BUNDLE_DISCOUNT}, ${BUNDLE_FLOOR_USD})`);
const fake = { a: "$0.002", b: "$0.003" };
ok(bundlePriceUsd(1, ["a", "b"], (s) => fake[s]) === 0.005 && bundlePriceUsd(10, ["a", "b"], (s) => fake[s]) === 0.045, "price = ceil(units x parts x 0.9) to $0.001 (1 unit 0.005, 10 units 0.045)");
ok(bundlePriceUsd(1, ["a"], () => "$0.0001") === 0.001, "never below the settlement floor");
ok(bundlePriceUsd(3, ["a", "b"], (s) => ({ a: "$0.02", b: "$0.003" })[s]) === 0.063, "a repriced leg moves the bundle price (3 units of 0.023 = 0.063)");

ok(BUNDLE_TOOLS.length === 3 && Object.keys(BUNDLE_LEGS).length === 3, `three products (${BUNDLE_TOOLS.map((t) => t.slug).join(", ")})`);
const examples = {};
for (const t of BUNDLE_TOOLS) {
  const legs = BUNDLE_LEGS[t.slug];
  const priceOf = (s) => legTool(s).price;
  const parts = unitPartsUsd(legs, priceOf);
  ok(legs.length >= 2 && legs.every((s) => priceUsdOf(legTool(s).price) > 0), `${t.slug}: every leg is a priced catalog tool (${legs.map((s) => `${s} ${legTool(s).price}`).join(", ")})`);
  ok(t.price === usdText(bundlePriceUsd(1, legs, priceOf)), `${t.slug}: list price ${t.price} is one unit by the rule (parts ${parts.toFixed(3)})`);
  ok(!/\$\d/.test(JSON.stringify(t.description).replace(usdText(bundlePriceUsd(1, legs, priceOf)), "")), `${t.slug}: the only price in the description is the derived per-unit price`);
  const max = BUNDLE_MAX_UNITS[t.slug];
  ok(t.quoteMaxUsd === bundlePriceUsd(max, legs, priceOf), `${t.slug}: the published ceiling is ${max} units (${t.quoteMaxUsd})`);
  // The listing tells a buyer the real most units one call takes, whatever
  // the size of the published example.
  const listProp = Object.values(t.discovery.inputSchema.properties)[0];
  ok(new RegExp(`\\bup to ${max} `).test(t.description) && new RegExp(`^1 to ${max} `).test(listProp.description),
    `${t.slug}: the description and the input schema state the most units one call takes (${max})`);
  const ex = t.discovery.input;
  const n = (ex.sites || ex.tickers || ex.coins).length;
  ok(n >= 2 && n <= max, `${t.slug}: the published example is a list (${n} units), inside the maximum`);
  ok(t.quote(ex) === bundlePriceUsd(n, legs, priceOf), `${t.slug}: the example (${n} units) is quoted at ${t.quote(ex)}`);
  ok(t.discovery.output.example.pricing.priceUsd === t.quote(ex) && t.discovery.output.example.pricing.units === n, `${t.slug}: the example answer's pricing block is the quote, derived`);
  const key = ex.sites ? "sites" : ex.tickers ? "tickers" : "coins";
  const many = Array.from({ length: max + 5 }, (_, i) => (key === "sites" ? { lat: i % 80, lon: i % 170 } : key === "tickers" ? `T${String.fromCharCode(65 + (i % 26))}${i}` : `coin-${i}`));
  ok(t.quote({ [key]: many }) <= t.quoteMaxUsd, `${t.slug}: a body over the cap is never quoted past the ceiling (the handler refuses it, uncharged)`);
  ok(t.quote({}) === bundlePriceUsd(1, legs, priceOf) && t.quote({ [key]: "x" }) > 0, `${t.slug}: an unreadable body is quoted at one unit (the handler then refuses it)`);
  // The starting input: the smallest request, one unit, quoted at the list
  // price. A surface that shows or buys one price for the tool reads it (a
  // referral copy's request with no input runs it).
  {
    const start = t.discovery.startingInput;
    const units = start ? Object.values(start)[0] : null;
    ok(start && Object.keys(start).join() === key && Array.isArray(units) && units.length === 1 && JSON.stringify(units[0]) === JSON.stringify(ex[key][0]), `${t.slug}: declares a one-unit starting input, the example's first unit`);
    ok(usdText(t.quote(structuredClone(start))) === t.price && t.quote(start) < t.quote(ex), `${t.slug}: the starting input is quoted at the list price (${usdText(t.quote(start))}), under the example's quote`);
    ok(t.endsAtCeiling === true, `${t.slug}: declares that its upstream work ends at a run's ceiling (scripts/test-run-ceiling.js drives it)`);
  }
  ok(t.modelBacked !== true && !/\bmodel-backed\b/.test(t.description) && /no model/.test(t.description), `${t.slug}: deterministic, says so, not model-backed`);
  ok(!FREE_TIER_SLUGS.has(t.slug), `${t.slug}: not on the free tier (wallet-only)`);
  ok(WALLET_ONLY_SLUGS.has(t.slug) && Array.isArray(t.upstreamHosts) && t.upstreamHosts.length > 0 && t.upstreamHosts.every((h) => upstreamHostsForSlug(t.slug).has(h)),
    `${t.slug}: a network tool (WALLET_ONLY_SLUGS) that declares the hosts its legs read (${(t.upstreamHosts || []).join(", ")})`);
  examples[t.slug] = ex;
}

// ---- the changelog announces each product, in both files (CHANGELOG.md and
// the /changelog page, src/changelog.js): its slug and the most units one call
// takes, read from the same constant the handler refuses past. It types no
// price: the price is the rule's, quoted in the 402.
{
  const { readFileSync } = await import("node:fs");
  // A markdown item runs from its "- " to the next item or heading.
  const mdItems = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split(/\n(?=- |#|[A-Z][A-Za-z ]{0,40}:\n)/).map((s) => s.replace(/\s+/g, " "));
  const { CHANGELOG_ENTRIES } = await import("../src/changelog.js");
  const unitWord = { "weather-risk-brief": "sites", "filings-brief": "US public companies", "token-diligence": "coins" };
  for (const [label, items] of [["CHANGELOG.md", mdItems], ["src/changelog.js", CHANGELOG_ENTRIES.flatMap((e) => e.items || [])]]) {
    for (const t of BUNDLE_TOOLS) {
      const item = items.find((i) => i.includes(t.slug) && /bundle/i.test(i)) || "";
      const at = item.indexOf(t.slug);
      const told = item.slice(at, at + 160);
      ok(at >= 0 && new RegExp(`up to ${BUNDLE_MAX_UNITS[t.slug]} ${unitWord[t.slug]}`).test(told),
        `${label} announces ${t.slug} with the most ${unitWord[t.slug]} one call takes (${BUNDLE_MAX_UNITS[t.slug]})`);
    }
    const bundleItem = items.find((i) => BUNDLE_TOOLS.every((t) => i.includes(t.slug))) || "";
    ok(bundleItem && !/\$\d/.test(bundleItem), `${label}: one item names all three products and types no price`);
  }
}

// ---- inputs
await throwsStatus(() => weatherSitesOf({}), 400, /"sites"/, "weather: no sites is a 400 naming the field");
await throwsStatus(() => weatherSitesOf({ sites: [{ lat: 91, lon: 0 }] }), 400, /sites\[0\]\.lat/, "weather: a latitude out of range names the site");
await throwsStatus(() => weatherSitesOf({ sites: [{ lat: " ", lon: 1 }] }), 400, /lat/, "weather: a blank coordinate is refused, never read as 0");
await throwsStatus(() => weatherSitesOf({ sites: Array.from({ length: 51 }, () => ({ lat: 1, lon: 1 })) }), 400, /at most 50/, "weather: over the cap is refused with the cap");
await throwsStatus(() => weatherSitesOf({ sites: [{ name: "x" }] }), 400, /sites\[0\]/, "weather: a site with no coordinates and no place names the site");
ok(weatherSitesOf({ sites: ["Paris", { place: " Austin, TX ", name: "HQ" }] }).map((s) => s.place).join("|") === "Paris|Austin, TX", "weather: a place string and a place object both read");
await throwsStatus(() => filingTickersOf({ tickers: ["MSFT", "<x>"] }), 400, /tickers\[1\]/, "filings: a bad ticker names its index");
ok(filingTickersOf({ tickers: "msft, aapl,MSFT" }).join(",") === "MSFT,AAPL", "filings: a comma string reads, upper-cased and deduplicated (the quote counts the same units)");
await throwsStatus(() => coinIdsOf({ coins: ["Bitcoin!"] }), 400, /coins\[0\]/, "tokens: a bad id names its index");
ok(coinIdsOf({ coins: ["bitcoin", "BITCOIN", "ethereum"] }).length === 2, "tokens: deduplicated");
ok(yearEarlier("2026-11-18") === "2025-11-18" && yearEarlier("2028-02-29") === "2027-03-01", "the same calendar date a year earlier");

// ---- computed rows
const daily = { days: [
  { date: "2026-11-18", tempMax: 10, tempMin: -2, precipSum: 1, precipProbability: 20, windGusts: 30, uvIndex: 2, unit: "°C", windUnit: "km/h" },
  { date: "2026-11-19", tempMax: 14, tempMin: 3, precipSum: 12, precipProbability: 80, windGusts: 75, uvIndex: 3, unit: "°C", windUnit: "km/h" },
] };
const thresholds = { rules: [
  { key: "frost", variable: "temperature", op: "<", value: 0, unit: "°C", met: true, firstAt: "2026-11-18T05:00", hoursMet: 4 },
  { key: "highGusts", variable: "wind_gusts", op: ">=", value: 70, unit: "km/h", met: true, firstAt: "2026-11-19T12:00", hoursMet: 2 },
  { key: "heat", variable: "temperature", op: ">=", value: 35, unit: "°C", met: false, firstAt: null, hoursMet: 0 },
] };
const row = weatherSiteRow({ name: "Site A", lat: 1, lon: 2 }, { lat: 1, lon: 2 }, {
  daily, thresholds, air: { airQuality: { usAqi: 151, category: "Unhealthy", pm25: 60, time: "2026-11-18T00:00" } },
  history: { days: [{ date: "2025-11-18", tempMax: 8, precipSum: 0 }, { date: "2025-11-19", tempMax: 10, precipSum: 2 }] },
  probability: { date: "2026-11-19", probability: 0.62, members: { total: 82 } },
});
const expectScore = WEATHER_RISK_WEIGHTS.frost + WEATHER_RISK_WEIGHTS.highGusts + WEATHER_RISK_WEIGHTS.heavyRainLikely + WEATHER_RISK_WEIGHTS.poorAir;
ok(row.riskScore === expectScore && row.flags.join(",") === "frost,highGusts,heavyRainLikely,poorAir", `weather: score adds the weights of the signals present (${row.riskScore}, ${row.flags})`);
ok(row.forecast.wettestDay.date === "2026-11-19" && row.forecast.gustiestDay.windGusts === 75 && row.forecast.tempMin === -2 && row.forecast.precipTotal === 13, "weather: wettest, gustiest, min and rain total read from the days");
ok(row.vsLastYear.tempMaxMeanDelta === 3 && row.vsLastYear.precipTotalDelta === 11, "weather: last year's comparison (mean high +3, rain +11 mm)");
const calm = weatherSiteRow({ lat: 0, lon: 0 }, { lat: 0, lon: 0 }, { daily, thresholds: { rules: [] }, air: { airQuality: { usAqi: 20 } }, history: { days: [] }, probability: { probability: 0.1 } });
ok(calm.riskScore === 0 && calm.flags.length === 0 && calm.vsLastYear.tempMaxMeanDelta === null, "weather: no signal is a zero score, and no history reads null, not zero");
ok(Object.values(WEATHER_RISK_WEIGHTS).reduce((a, b) => a + b, 0) >= 100, "weather: the cap at 100 can bind (weights sum past it)");

const now = Date.parse("2026-11-18T12:00:00Z");
const fin = { cik: "1", entityName: "Co", metrics: [
  { label: "Revenue", latestAnnual: { value: 1000, period: "2026-06-30" }, latestQuarterly: { value: 300, period: "2026-09-30" } },
  { label: "Net Income", latestAnnual: { value: -50 } }, { label: "Operating Income", latestAnnual: { value: 100 } },
  { label: "Total Assets", latestAnnual: { value: 2000 } }, { label: "Total Liabilities", latestAnnual: { value: 1900 } }, { label: "Stockholders Equity", latestAnnual: { value: 100 } },
] };
const filings = { filings: [
  { form: "8-K", filingDate: "2026-11-01" }, { form: "10-Q", filingDate: "2026-10-28" }, { form: "8-K", filingDate: "2026-09-01" }, { form: "8-K", filingDate: "2026-05-01" }, { form: "10-K", filingDate: "2026-07-29" },
  { form: "4", filingDate: "2026-07-01" },
], sicDescription: "Software" };
const fr = filingCompanyRow("CO", { financials: fin, filings, insiders: { total: 61, windowDays: 90, trades: [{ displayNames: ["A B (CIK 1)"] }, { displayNames: ["A B (CIK 1)"] }] } }, now);
ok(fr.financials.ratios.netMargin === -0.05 && fr.financials.ratios.operatingMargin === 0.1 && fr.financials.ratios.liabilitiesToAssets === 0.95, "filings: margins and leverage from annual values");
ok(fr.flags.join(",") === "netLoss,highLeverage,busyInsiderFiling", `filings: flags (${fr.flags})`);
ok(fr.filingActivity.last10K === "2026-07-29" && fr.filingActivity.last10Q === "2026-10-28" && fr.filingActivity.daysSinceLatestPeriodicReport === 21 && fr.filingActivity.eightKLast90Days === 2, "filings: latest reports, days since, 8-Ks in 90 days");
ok(fr.filingActivity.recentFilings.length === 5 && fr.filingActivity.recentFilingsPartial.truncated === true && fr.filingActivity.recentFilingsPartial.matched === 6, "filings: the recent list says it is a sample, in fields");
ok(fr.insiderActivity.filers.length === 1 && fr.insiderActivity.form4Filings === 61, "filings: insider filers deduplicated, the count is the source's total");
const stale = filingCompanyRow("OLD", { financials: { metrics: [] }, filings: { filings: [{ form: "10-K", filingDate: "2025-01-01" }] }, insiders: {} }, now);
ok(stale.flags.includes("noPeriodicReport120d") && stale.financials.ratios.netMargin === null, "filings: an old periodic report flags; missing facts read null, not zero");
const busy = filingCompanyRow("BUSY", { financials: { metrics: [] }, filings: { filings: Array.from({ length: 200 }, () => ({ form: "4", filingDate: "2026-11-01" })) }, insiders: {} }, now);
ok(!busy.flags.includes("noPeriodicReport120d") && busy.filingActivity.last10K === null && busy.filingActivity.oldestFilingRead === "2026-11-01", "filings: a full window that reaches back less than 120 days leaves the report date unknown, not flagged late");

const bars = [
  { time: "2026-01-01T00:00:00Z", high: 10, low: 9, close: 10 },
  { time: "2026-01-02T00:00:00Z", high: 10, low: 5, close: 5 },
  { time: "2026-01-03T00:00:00Z", high: 11, low: 5, close: 10 },
];
const st = candleStats(bars);
ok(st.maxDrawdownPct === 50 && st.bars === 3, `tokens: drawdown is running high to later low (${st.maxDrawdownPct}%)`);
const sdDaily = Math.sqrt(((Math.log(0.5) - 0) ** 2 + (Math.log(2) - 0) ** 2) / 1);
ok(Math.abs(st.volatilityAnnualizedPct - Math.round(sdDaily * Math.sqrt(365) * 1000) / 10) < 0.11, `tokens: volatility annualized from the bar spacing (${st.volatilityAnnualizedPct}%)`);
ok(candleStats([]).maxDrawdownPct === null && candleStats([]).volatilityAnnualizedPct === null, "tokens: no candles read null, not zero");
const tr = tokenRow("x", { profile: { symbol: "X", name: "X", market: { marketCap: 100, fullyDilutedValuation: 300, volume24h: 0.5, athChangePct: -80, circulatingSupply: 50, totalSupply: 100, maxSupply: null }, platforms: [{ platform: "ethereum", contract: "0xabc" }, { platform: "x" }] }, ohlc: { bars, summary: { changePct: 0 }, days: 365 } });
ok(tr.flags.join(",") === "highDilution,thinTurnover,farBelowATH,highVolatility" && tr.supply.circulatingShare === 0.5 && tr.computed.fdvToMarketCap === 3 && tr.profile.chains === 1, `tokens: flags and ratios (${tr.flags})`);

// ---- through the handlers, legs stubbed
const stubs = new Map();
const realHandler = new Map();
function stub(slug, fn) { const t = legTool(slug); if (!realHandler.has(slug)) realHandler.set(slug, t.handler); t.handler = fn; stubs.set(slug, fn); }
function restore() { for (const [slug, h] of realHandler) legTool(slug).handler = h; realHandler.clear(); }
const tool = (slug) => BUNDLE_TOOLS.find((t) => t.slug === slug);
const err = (status, message, extra = {}) => Object.assign(new Error(message), { statusCode: status, ...extra });

try {
  // weather, complete
  stub("weather-daily", async (i) => ({ lat: i.lat, lon: i.lon, ...daily }));
  stub("weather-thresholds", async (i) => ({ rules: i.rules.map((r) => ({ ...r, unit: "", met: r.variable === "temperature" && r.op === "<", firstAt: null, hoursMet: 1 })) }));
  stub("weather-air-quality", async () => ({ airQuality: { usAqi: 30, category: "Good" } }));
  let histArgs = null;
  stub("weather-history", async (i) => { histArgs = i; return { days: [{ date: i.start, tempMax: 5, precipSum: 0 }] }; });
  let probArgs = null;
  stub("weather-probability", async (i) => { probArgs = i; return { date: i.date, probability: 0.7, members: { total: 82 } }; });
  const w = await tool("weather-risk-brief").handler({ sites: [{ name: "A", lat: 1, lon: 2 }, { lat: 3, lon: 4 }] });
  ok(w.sites === 2 && w.rows.length === 2 && w.rows[0].flags.includes("frost") && w.rows[0].flags.includes("heavyRainLikely"), "weather: a complete answer holds every site");
  ok(probArgs.date === "2026-11-19" && probArgs.variable === "precipitation_sum" && probArgs.value === 10, "weather: the ensemble leg reads the wettest forecast day");
  ok(histArgs.start === "2025-11-18" && histArgs.end === "2025-11-19", "weather: history reads the same dates a year earlier");
  ok(w.pricing.units === 2 && w.pricing.priceUsd === tool("weather-risk-brief").quote({ sites: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] }), "weather: the answer's pricing block is the 402 quote");
  ok(w.portfolio.sitesWithFlag.frost === 2 && w.ranking.length === 2, "weather: the portfolio counts and ranking cover every site");
  // Credits: the published example's are what the handler returns for the
  // example input; a site named by place adds the GeoNames credit (its
  // coordinates and place name are GeoNames data), a lat/lon site does not;
  // the description's attribution run names every credit an answer can carry.
  {
    const wt = tool("weather-risk-brief");
    const ex = await wt.handler(wt.discovery.input);
    ok(JSON.stringify(wt.discovery.output.example.credits) === JSON.stringify(ex.credits), `weather: the example's credits are the handler's for the example input (example ${JSON.stringify(wt.discovery.output.example.credits)}, handler ${JSON.stringify(ex.credits)})`);
    ok([OPEN_METEO_ATTRIBUTION, CAMS_CREDIT, C3S_CREDIT].every((c) => ex.credits.includes(c)) && !ex.credits.includes(GEONAMES_ATTRIBUTION), "weather: sites by coordinates carry the Open-Meteo, CAMS and C3S credits and no GeoNames credit");
    const keyBefore = process.env.OPEN_METEO_API_KEY;
    delete process.env.OPEN_METEO_API_KEY;
    const restoreResolver = stubGuardResolver((host, family) => (/(^|\.)open-meteo\.com$/.test(host) ? (family === 4 ? ["93.184.216.34"] : []) : undefined));
    const realFetch = globalThis.fetch;
    const geocoded = [];
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      if (u.host !== "geocoding-api.open-meteo.com") throw new TypeError(`unexpected fetch to ${u.host}`);
      geocoded.push(u.searchParams.get("name"));
      const r = new Response(JSON.stringify({ results: [{ name: "Springfield", latitude: 39.8, longitude: -89.6, country: "United States", country_code: "US", admin1: "Illinois", timezone: "America/Chicago" }] }), { status: 200, headers: { "content-type": "application/json" } });
      Object.defineProperty(r, "url", { value: String(url) });
      return r;
    };
    try {
      const wp = await wt.handler({ sites: [{ name: "Plant", place: "Springfield, IL" }, { lat: 1, lon: 2 }] });
      ok(geocoded.length === 1 && wp.rows[0].site.place === "Springfield, Illinois, US" && wp.credits.includes(GEONAMES_ATTRIBUTION) && [OPEN_METEO_ATTRIBUTION, CAMS_CREDIT, C3S_CREDIT].every((c) => wp.credits.includes(c)),
        `weather: a site named by place carries the GeoNames place data and its credit (${JSON.stringify(wp.rows[0].site)}, ${wp.credits.length} credits)`);
    } finally {
      globalThis.fetch = realFetch;
      restoreResolver();
      if (keyBefore !== undefined) process.env.OPEN_METEO_API_KEY = keyBefore;
    }
    const tail = attributionTailOf(wt.description) || "";
    ok(tail === ATTRIBUTIONS[wt.attribution] && tail.includes(OPEN_METEO_ATTRIBUTION) && tail.includes(GEONAMES_ATTRIBUTION) && /Copernicus\b[^.]*\bCAMS\b/.test(tail) && /\bC3S\b/.test(tail) && tail.includes(COPERNICUS_DISCLAIMER),
      `weather: the description ends with every credit an answer can carry: Open-Meteo, GeoNames, CAMS and C3S, and the Copernicus disclaimer (${JSON.stringify(tail)})`);
  }
  // pacing: one read per upstream host per site at a time, so no host holds
  // more than WEATHER_CONCURRENCY of one call's reads, and five reads a site.
  {
    const HOST_OF = { "weather-daily": "forecast", "weather-thresholds": "forecast", "weather-air-quality": "air", "weather-history": "archive", "weather-probability": "ensemble" };
    const open = new Map(), peak = new Map(), perSite = new Map(), peakSite = new Map();
    let reads = 0;
    const paced = (slug, answer) => {
      const real = stubs.get(slug);
      stub(slug, async (i) => {
        const host = HOST_OF[slug], site = `${host} ${i.lat},${i.lon}`;
        reads++;
        open.set(host, (open.get(host) || 0) + 1); peak.set(host, Math.max(peak.get(host) || 0, open.get(host)));
        perSite.set(site, (perSite.get(site) || 0) + 1); peakSite.set(site, Math.max(peakSite.get(site) || 0, perSite.get(site)));
        await new Promise((r) => setTimeout(r, 15));
        open.set(host, open.get(host) - 1); perSite.set(site, perSite.get(site) - 1);
        return answer ? answer(i) : real(i);
      });
    };
    for (const slug of Object.keys(HOST_OF)) paced(slug);
    const six = Array.from({ length: 6 }, (_, k) => ({ lat: 10 + k, lon: 20 + k }));
    const w6 = await tool("weather-risk-brief").handler({ sites: six });
    ok(w6.sites === 6 && reads === 6 * BUNDLE_LEGS["weather-risk-brief"].length, `weather: six sites make five reads each, none repeated (${reads} reads)`);
    ok([...peak.values()].every((n) => n <= WEATHER_CONCURRENCY) && peak.get("forecast") >= 2, `weather: no upstream host holds more than ${WEATHER_CONCURRENCY} of the call's reads at once (peaks ${[...peak].map(([h, n]) => `${h} ${n}`).join(", ")})`);
    ok([...peakSite.values()].every((n) => n === 1), "weather: a site's two forecast-host reads are never in flight together");
  }
  // a source failure on one site fails the call (never a partial 200)
  stub("weather-air-quality", async (i) => { if (i.lat === 3) throw err(502, "upstream broke"); return { airQuality: { usAqi: 30 } }; });
  await throwsStatus(() => runAsRouteCall(() => tool("weather-risk-brief").handler({ sites: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] })), 502, /1 of 2 unit.*weather-air-quality.*\. Nothing was charged\. Retry later\.$/, "weather: one site's source failure answers 502, uncharged, naming the leg");
  // a throttled leg is tried once more
  let calls = 0;
  stub("weather-air-quality", async () => { calls++; if (calls === 1) throw err(503, "throttled", { retryAfter: 5 }); return { airQuality: { usAqi: 30 } }; });
  const t0 = Date.now();
  const w2 = await tool("weather-risk-brief").handler({ sites: [{ lat: 1, lon: 2 }] });
  ok(w2.sites === 1 && calls === 2 && Date.now() - t0 >= LEG_RETRY_PAUSE_MS - 50, `weather: a throttled leg is retried once after a pause (${calls} calls)`);
  calls = 0;
  stub("weather-air-quality", async () => { calls++; throw err(503, "key refused", { noRetry: true, retryAfter: 60 }); });
  await throwsStatus(() => tool("weather-risk-brief").handler({ sites: [{ lat: 1, lon: 2 }] }), 503, /key refused/, "weather: a leg marked noRetry is not retried and stays a 503");
  ok(calls === 1, "weather: noRetry means one call");
  // The source's rate limit (its 429, answered by the read helper as a 503
  // marked upstreamStatus 429): the leg is run once, with no second run after
  // the pause, and no further site is started.
  {
    const limited429 = () => err(503, "The host rate-limited or timed out this server (HTTP 429) - the URL is fine, this is throttling at api.example.org; retry in 60s", { upstreamStatus: 429, attribution: "upstream", retryAfter: 60 });
    const runs = [];
    stub("weather-daily", async (i) => { runs.push(`${i.lat}`); throw limited429(); });
    const tThrottle = Date.now();
    let refused = null;
    try { await tool("weather-risk-brief").handler({ sites: Array.from({ length: 9 }, (_, k) => ({ lat: 50 + k, lon: 1 })) }); } catch (e) { refused = e; }
    ok(refused?.statusCode === 503 && refused.retryAfter === 60 && /^9 of 9 unit\(s\) could not be completed on the source's side \(first: 50,1, weather-daily: /.test(refused.message),
      `weather: a rate-limited leg fails the call 503, uncharged, with the source's retry time (${refused?.statusCode}, retryAfter ${refused?.retryAfter})`);
    ok(runs.length === WEATHER_CONCURRENCY && new Set(runs).size === WEATHER_CONCURRENCY, `weather: a rate-limited leg is run once and no further site is started (${runs.length} runs for 9 sites, ${WEATHER_CONCURRENCY} in flight when the limit was met)`);
    ok(Date.now() - tThrottle < LEG_RETRY_PAUSE_MS, "weather: no pause is spent waiting to re-send refused reads");
  }
  restore();
  restore();

  // filings: a caller mistake is one 422 naming each unit
  stub("company-financials", async (i) => { if (i.ticker === "ZZZZ") throw err(404, "unknown ticker ZZZZ"); return fin; });
  stub("edgar-filings", async () => filings);
  stub("edgar-insider-trades", async () => ({ total: 3, trades: [] }));
  await throwsStatus(() => runAsRouteCall(() => tool("filings-brief").handler({ tickers: ["MSFT", "ZZZZ"] })), 422, /1 of 2 input.*ZZZZ.*send again\. Nothing was charged\.$/, "filings: an unknown ticker is a 422 naming it, uncharged");
  const f = await tool("filings-brief").handler({ tickers: ["MSFT", "AAPL"] });
  ok(f.companies === 2 && f.peers.byRevenue.length === 2 && f.rows.every((r) => r.financials.ratios.netMargin === -0.05), "filings: a complete answer ranks every company");
  restore();

  // tokens
  stub("coin-profile", async (i) => ({ id: i.coin, symbol: i.coin.toUpperCase(), market: { marketCap: 1000, fullyDilutedValuation: 1000, volume24h: 100 } }));
  stub("coin-ohlc", async () => ({ bars, summary: { changePct: 5 }, days: 365, granularity: "1d" }));
  const k = await tool("token-diligence").handler({ coins: ["a", "b", "a"] });
  ok(k.coins === 2 && k.comparison.byMarketCap.length === 2 && k.pricing.units === 2, "tokens: a complete answer, duplicates read once and priced once");
  {
    // The source's own figures per coin (price, market cap, FDV, volume,
    // all-time high, changes, supply counts, its global rank) are read to
    // compute and are never answered, on any surface: the public answer is the
    // one resold through a third party (/ref, /aws), credit included.
    const { refAnswerOf, RAW_MARKET_FIELDS } = await import("../src/resale-terms.js");
    const pub = tool("token-diligence").discovery.output.example;
    const rawKey = /"(?:price|marketCap|fullyDilutedValuation|volume24h|ath|athChangePct|change7dPct|change30dPct|change1yPct|circulating|total|max)":/;
    for (const [label, ans] of [["published example", pub], ["handler answer", k]]) {
      const text = JSON.stringify({ rows: ans.rows, comparison: { byMarketCap: ans.comparison.byMarketCap } });
      ok(ans.rows.every((r) => !("market" in r) && Object.keys(r.supply || {}).join() === "circulatingShare" && r.computed && r.flags), `${label}: rows carry no market block or supply counts (${Object.keys(ans.rows[0]).join(",")}; supply ${Object.keys(ans.rows[0].supply || {}).join(",")})`);
      ok(ans.comparison.byMarketCap.every((x) => !("value" in x) && x.rank && x.id) && ans.comparison.byReturn1y.every((x) => "value" in x), `${label}: the market-cap ranking keeps rank and id, never the market cap`);
      ok(!rawKey.test(text) && !RAW_MARKET_FIELDS.some((f) => text.includes(`"${f}":`)) && Array.isArray(ans.credits) && ans.credits.length > 0, `${label}: no raw CoinGecko field, and the credit stays`);
    }
    ok(typeof tool("token-diligence").refAnswer !== "function" && JSON.stringify(refAnswerOf(tool("token-diligence"), pub)) === JSON.stringify(pub), "no resale trim: the resold answer is the public one");
    ok(/byMarketCap orders the coins by market cap/.test(k.method) && /return1yPct/.test(k.method), "the answer states its formulas");
  }
  // pacing: both legs read one host, so a coin holds one read at a time and
  // the call at most TOKEN_CONCURRENCY; two reads a coin, none repeated.
  {
    let open = 0, peak = 0, reads = 0; const perCoin = new Map(), peakCoin = new Map();
    const paced = (slug) => { const real = stubs.get(slug); stub(slug, async (i) => {
      reads++; open++; peak = Math.max(peak, open);
      perCoin.set(i.coin, (perCoin.get(i.coin) || 0) + 1); peakCoin.set(i.coin, Math.max(peakCoin.get(i.coin) || 0, perCoin.get(i.coin)));
      await new Promise((r) => setTimeout(r, 15));
      open--; perCoin.set(i.coin, perCoin.get(i.coin) - 1);
      return real(i);
    }); };
    paced("coin-profile"); paced("coin-ohlc");
    const ten = Array.from({ length: 10 }, (_, n) => `coin-${n}`);
    const k10 = await tool("token-diligence").handler({ coins: ten });
    ok(k10.coins === 10 && reads === 20, `tokens: ten coins make two reads each, none repeated (${reads} reads)`);
    ok(peak <= TOKEN_CONCURRENCY && peak >= 2 && [...peakCoin.values()].every((n) => n === 1), `tokens: at most ${TOKEN_CONCURRENCY} reads open at once, one per coin (peak ${peak})`);
  }
  // The source's rate limit, in the market kit's own words (marked throttled):
  // each leg is run once, the coin's second read is not sent, and no further
  // coin is started.
  {
    const sent = [];
    const limitedCg = () => err(503, "Market data upstream rate-limited this request - retry in about 60 seconds", { throttled: true });
    stub("coin-profile", async (i) => { sent.push(`profile ${i.coin}`); throw limitedCg(); });
    stub("coin-ohlc", async (i) => { sent.push(`ohlc ${i.coin}`); throw limitedCg(); });
    const tCg = Date.now();
    let refused = null;
    try { await tool("token-diligence").handler({ coins: Array.from({ length: 12 }, (_, n) => `coin-${n}`) }); } catch (e) { refused = e; }
    ok(refused?.statusCode === 503 && /^12 of 12 unit\(s\) could not be completed on the source's side \(first: coin-0, coin-profile: Market data upstream rate-limited this request/.test(refused.message),
      `tokens: a rate-limited leg fails the call 503, uncharged, naming the leg (${refused?.statusCode})`);
    ok(sent.length === TOKEN_CONCURRENCY && sent.every((x) => x.startsWith("profile ")) && new Set(sent).size === sent.length,
      `tokens: a rate-limited call sends one read per coin in flight and nothing after (${sent.length} reads for 12 coins: ${sent.join(", ")})`);
    ok(Date.now() - tCg < LEG_RETRY_PAUSE_MS, "tokens: no pause is spent waiting to re-send refused reads");
  }
  restore();
  // ---- token-diligence through the REAL legs, the market host stubbed ----
  // The published example is two coins; the multi-coin path is held here,
  // offline: 4 and 12 coins through coin-profile and coin-ohlc as shipped,
  // with the requests the market host receives counted where it answers.
  {
    const { clearCryptoMarketsCache, resetCgRateLimit } = await import("../src/tools/crypto-markets-kit.js");
    const DAY = 86_400_000, T0 = Date.parse("2026-01-01T00:00:00Z");
    // Three daily candles: open 100, a high of 120, a low of 60, last close 99.
    const candles = [[T0, 100, 120, 90, 110], [T0 + DAY, 110, 115, 60, 66], [T0 + 2 * DAY, 66, 99, 66, 99]];
    const capOf = (n) => (n + 1) * 1e9;
    const coinBody = (id, n) => ({
      id, symbol: `s${n}`, name: `Coin ${n}`, market_cap_rank: 100 - n, genesis_date: "2020-01-01", categories: ["Stub"],
      detail_platforms: { ethereum: { contract_address: `0x${String(n).padStart(40, "0")}`, decimal_place: 18 } }, links: { homepage: [`https://coin-${n}.example/`] },
      market_data: {
        current_price: { usd: 10 + n }, market_cap: { usd: capOf(n) }, fully_diluted_valuation: { usd: capOf(n) * (n === 1 ? 3 : 1) }, total_volume: { usd: capOf(n) * 0.05 },
        ath: { usd: 100 }, ath_change_percentage: { usd: n === 2 ? -80 : -10 }, circulating_supply: 500, total_supply: 1000, max_supply: 1000,
      },
    });
    const realFetch = globalThis.fetch;
    // `refuseAfter`: the host answers 429 to every coin read after that many.
    const marketHost = (ids, { refuseAfter = Infinity } = {}) => {
      const seen = { reads: [], refused: [], open: 0, peak: 0, perCoin: new Map(), peakCoin: 0 };
      globalThis.fetch = async (input, init) => {
        const url = String(typeof input === "string" ? input : input?.url ?? input);
        if (!/^https:\/\/(pro-)?api\.coingecko\.com\//.test(url)) return realFetch(input, init);
        const path = new URL(url).pathname.replace("/api/v3", "");
        const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (path === "/coins/list") return J(200, ids.map((id) => ({ id, symbol: id, name: id })));
        if (path === "/simple/supported_vs_currencies") return J(200, ["usd"]);
        const [, , id, tail] = path.split("/");
        const n = ids.indexOf(id);
        if (n < 0) return J(404, { error: "coin not found" });
        if (seen.reads.length + seen.refused.length >= refuseAfter) { seen.refused.push(path); return J(429, { status: { error_code: 429 } }); }
        seen.reads.push(path);
        seen.open++; seen.peak = Math.max(seen.peak, seen.open);
        seen.perCoin.set(id, (seen.perCoin.get(id) || 0) + 1); seen.peakCoin = Math.max(seen.peakCoin, seen.perCoin.get(id));
        await new Promise((r) => setTimeout(r, 15));
        seen.open--; seen.perCoin.set(id, seen.perCoin.get(id) - 1);
        return tail === "ohlc" ? J(200, candles) : J(200, coinBody(id, n));
      };
      return seen;
    };
    const fresh = () => { clearCryptoMarketsCache(); resetCgRateLimit(); };
    try {
      for (const ids of [["bitcoin", "ethereum", "chainlink", "uniswap"], Array.from({ length: 12 }, (_, n) => `real-coin-${n}`)]) {
        fresh();
        const seen = marketHost(ids);
        const out = await tool("token-diligence").handler({ coins: ids });
        const N = ids.length;
        ok(out.coins === N && out.rows.length === N && out.pricing.units === N && out.pricing.priceUsd === tool("token-diligence").quote({ coins: ids }) && out.rows.every((r, n) => r.id === ids[n]),
          `tokens (real legs, ${N} coins): every coin is answered, in order, priced per coin`);
        const r1 = out.rows[1], r2 = out.rows[2];
        ok(out.rows.every((r, n) => !("market" in r) && !("rank" in r) && r.supply.circulatingShare === 0.5 && r.computed.turnover24h === 0.05 && r.symbol === `S${n}` && r.profile.homepage === `https://coin-${n}.example/` && r.profile.chains === 1),
          `tokens (real legs, ${N} coins): each row carries its own coin's computed ratios and profile values, never its market figures`);
        ok(out.rows.every((r) => r.computed.return1yPct === -1 && r.computed.maxDrawdown1yPct === 50 && r.computed.candles.bars === 3 && r.computed.volatilityAnnualizedPct === candleStats(candles.map(([t, o, h, l, c]) => ({ time: new Date(t).toISOString(), open: o, high: h, low: l, close: c }))).volatilityAnnualizedPct && r.computed.volatilityAnnualizedPct > 1000),
          `tokens (real legs, ${N} coins): the candles reduce to return -1%, drawdown 50% and the annualized volatility (${out.rows[0].computed.volatilityAnnualizedPct}%)`);
        ok(r1.computed.fdvToMarketCap === 3 && r1.flags.includes("highDilution") && r2.flags.includes("farBelowATH") && !out.rows[0].flags.includes("highDilution") && out.rows.every((r) => r.flags.includes("highVolatility")),
          `tokens (real legs, ${N} coins): flags follow each coin's own values (${r1.flags.join(",")} / ${r2.flags.join(",")})`);
        ok(out.comparison.byMarketCap.length === N && out.comparison.byMarketCap[0].id === ids[N - 1] && out.comparison.byMarketCap[N - 1].id === ids[0] && out.comparison.flagged.length === N,
          `tokens (real legs, ${N} coins): the list is ranked by market cap across every coin`);
        const profiles = seen.reads.filter((x) => !x.endsWith("/ohlc")), ohlcs = seen.reads.filter((x) => x.endsWith("/ohlc"));
        ok(seen.reads.length === 2 * N && new Set(seen.reads).size === 2 * N && profiles.length === N && ohlcs.length === N && seen.refused.length === 0,
          `tokens (real legs, ${N} coins): the market host receives two reads a coin, each once (${seen.reads.length} reads)`);
        ok(seen.peak <= TOKEN_CONCURRENCY && seen.peak >= Math.min(2, N) && seen.peakCoin === 1,
          `tokens (real legs, ${N} coins): at most ${TOKEN_CONCURRENCY} reads are open at the market host at once, one per coin (peak ${seen.peak})`);
      }
      // The host starts refusing mid-call: the call fails uncharged, each refused
      // read is sent once more by the market kit's own helper and never again,
      // and the coins not yet started are never read.
      {
        fresh();
        const ids = Array.from({ length: 12 }, (_, n) => `stop-coin-${n}`);
        const seen = marketHost(ids, { refuseAfter: 6 });
        let refused = null;
        try { await tool("token-diligence").handler({ coins: ids }); } catch (e) { refused = e; }
        const touched = new Set([...seen.reads, ...seen.refused].map((x) => x.split("/")[2]));
        const perPath = new Map(); for (const x of seen.refused) perPath.set(x, (perPath.get(x) || 0) + 1);
        ok(refused?.statusCode === 503 && /unit\(s\) could not be completed on the source's side \(first: stop-coin-\d+, coin-(profile|ohlc): Market data upstream rate-limited this request/.test(refused.message) && /^12 of 12 /.test(refused.message) === false,
          `tokens (real legs): the market host refusing mid-call fails the call 503, uncharged, naming the leg (${String(refused?.message).slice(0, 80)})`);
        ok(seen.reads.length === 6 && [...perPath.values()].every((k) => k <= 2) && perPath.size <= TOKEN_CONCURRENCY && seen.refused.length <= TOKEN_CONCURRENCY * 2,
          `tokens (real legs): each refused read goes out at most twice (the kit's own re-read) and no more than ${TOKEN_CONCURRENCY} reads are refused (${seen.refused.length} refused requests over ${perPath.size} reads)`);
        ok(touched.size <= TOKEN_CONCURRENCY * 2 && ids.slice(TOKEN_CONCURRENCY * 2).every((id) => !touched.has(id)),
          `tokens (real legs): coins not started when the limit was met are never read (${touched.size} of 12 coins read)`);
      }
      // The host refusing from the first read: one profile read per coin in
      // flight and the kit's own re-read of each; no candles, no further coin.
      {
        fresh();
        const ids = Array.from({ length: 12 }, (_, n) => `stub-coin-${n}`);
        const seen = marketHost(ids, { refuseAfter: 0 });
        let refused = null;
        try { await tool("token-diligence").handler({ coins: ids }); } catch (e) { refused = e; }
        const coinsRead = new Set(seen.refused.map((x) => x.split("/")[2]));
        ok(refused?.statusCode === 503 && /^12 of 12 unit\(s\) could not be completed on the source's side \(first: stub-coin-0, coin-profile: Market data upstream rate-limited this request/.test(refused.message), `tokens (real legs): the market host's 429 on every read fails the call 503, uncharged, naming the leg (${refused?.statusCode})`);
        ok(seen.refused.length === TOKEN_CONCURRENCY * 2 && coinsRead.size === TOKEN_CONCURRENCY && seen.refused.every((x) => !x.endsWith("/ohlc")) && seen.reads.length === 0,
          `tokens (real legs): a 12-coin call the host refuses sends it ${seen.refused.length} requests (${TOKEN_CONCURRENCY} coins' profile reads and the kit's own re-read of each), no candles read and no further coin`);
      }
    } finally { globalThis.fetch = realFetch; fresh(); }
  }
  // filings pacing: the two data.sec.gov legs of a company are never in
  // flight together; the Form 4 search (its own host) runs beside them.
  {
    const hostOf = { "company-financials": "data", "edgar-filings": "data", "edgar-insider-trades": "efts" };
    const openBy = new Map(), peakBy = new Map(); let reads = 0;
    for (const slug of Object.keys(hostOf)) stub(slug, async (i) => {
      const key = `${hostOf[slug]} ${i.ticker}`; reads++;
      openBy.set(key, (openBy.get(key) || 0) + 1); peakBy.set(key, Math.max(peakBy.get(key) || 0, openBy.get(key)));
      await new Promise((r) => setTimeout(r, 15));
      openBy.set(key, openBy.get(key) - 1);
      return slug === "company-financials" ? fin : slug === "edgar-filings" ? filings : { total: 3, trades: [] };
    });
    const eight = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"];
    const f8 = await tool("filings-brief").handler({ tickers: eight });
    ok(f8.companies === 8 && reads === 24 && [...peakBy.values()].every((n) => n === 1) && FILINGS_CONCURRENCY === 6,
      `filings: eight companies make three reads each and a company holds one read per host at a time (${reads} reads)`);
  }
  restore();

  // A leg the source rate-limits on every unit: the answer names the leg and
  // carries the leg's own message whole, which is what a sweep reads to hold
  // the failure against the runner's direct read (scripts/lib/upstream-outage.js).
  const limited = "The host rate-limited or timed out this server (HTTP 429) - the URL is fine, this is throttling at api.example.org; retry later";
  const inputs = { "weather-risk-brief": { sites: [{ name: "Chicago, IL", lat: 1, lon: 2 }, { lat: 3, lon: 4 }] }, "filings-brief": { tickers: ["MSFT", "AAPL"] }, "token-diligence": { coins: ["a", "b"] } };
  for (const t of BUNDLE_TOOLS) {
    for (const leg of BUNDLE_LEGS[t.slug]) stub(leg, async () => { throw err(503, limited, { noRetry: true, retryAfter: 60 }); });
    let thrown = null;
    try { await t.handler(inputs[t.slug]); } catch (e) { thrown = e; }
    const inner = bundleLegAnswer(thrown?.statusCode, { error: thrown?.message }, BUNDLE_LEGS[t.slug]);
    ok(thrown?.statusCode === 503 && BUNDLE_LEGS[t.slug].includes(inner?.leg) && inner.body.error === limited && accessRefusalStatus(inner.status, inner.body) === 429,
      `${t.slug}: a rate-limited leg answers 503 naming the leg (${inner?.leg}) with its message whole, read back as the leg's 429`);
    restore();
  }
} finally { restore(); }

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
