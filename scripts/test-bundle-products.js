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
  weatherSiteRow, filingCompanyRow, candleStats, tokenRow, yearEarlier, WEATHER_RISK_WEIGHTS, LEG_RETRY_PAUSE_MS,
} from "../src/tools/bundle-kit.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";

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
  const ex = t.discovery.input;
  const n = (ex.sites || ex.tickers || ex.coins).length;
  ok(t.quote(ex) === bundlePriceUsd(n, legs, priceOf), `${t.slug}: the example (${n} units) is quoted at ${t.quote(ex)}`);
  ok(t.discovery.output.example.pricing.priceUsd === t.quote(ex) && t.discovery.output.example.pricing.units === n, `${t.slug}: the example answer's pricing block is the quote, derived`);
  const key = ex.sites ? "sites" : ex.tickers ? "tickers" : "coins";
  const many = Array.from({ length: max + 5 }, (_, i) => (key === "sites" ? { lat: i % 80, lon: i % 170 } : key === "tickers" ? `T${String.fromCharCode(65 + (i % 26))}${i}` : `coin-${i}`));
  ok(t.quote({ [key]: many }) <= t.quoteMaxUsd, `${t.slug}: a body over the cap is never quoted past the ceiling (the handler refuses it, uncharged)`);
  ok(t.quote({}) === bundlePriceUsd(1, legs, priceOf) && t.quote({ [key]: "x" }) > 0, `${t.slug}: an unreadable body is quoted at one unit (the handler then refuses it)`);
  ok(t.modelBacked !== true && !/\bmodel-backed\b/.test(t.description) && /no model/.test(t.description), `${t.slug}: deterministic, says so, not model-backed`);
  ok(!FREE_TIER_SLUGS.has(t.slug), `${t.slug}: not on the free tier (wallet-only)`);
  examples[t.slug] = ex;
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
  // a source failure on one site fails the call (never a partial 200)
  stub("weather-air-quality", async (i) => { if (i.lat === 3) throw err(502, "upstream broke"); return { airQuality: { usAqi: 30 } }; });
  await throwsStatus(() => tool("weather-risk-brief").handler({ sites: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] }), 502, /1 of 2 unit.*weather-air-quality.*Nothing was charged/, "weather: one site's source failure answers 502, uncharged, naming the leg");
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
  restore();

  // filings: a caller mistake is one 422 naming each unit
  stub("company-financials", async (i) => { if (i.ticker === "ZZZZ") throw err(404, "unknown ticker ZZZZ"); return fin; });
  stub("edgar-filings", async () => filings);
  stub("edgar-insider-trades", async () => ({ total: 3, trades: [] }));
  await throwsStatus(() => tool("filings-brief").handler({ tickers: ["MSFT", "ZZZZ"] }), 422, /1 of 2 input.*ZZZZ.*nothing was charged/, "filings: an unknown ticker is a 422 naming it, uncharged");
  const f = await tool("filings-brief").handler({ tickers: ["MSFT", "AAPL"] });
  ok(f.companies === 2 && f.peers.byRevenue.length === 2 && f.rows.every((r) => r.financials.ratios.netMargin === -0.05), "filings: a complete answer ranks every company");
  restore();

  // tokens
  stub("coin-profile", async (i) => ({ id: i.coin, symbol: i.coin.toUpperCase(), market: { marketCap: 1000, fullyDilutedValuation: 1000, volume24h: 100 } }));
  stub("coin-ohlc", async () => ({ bars, summary: { changePct: 5 }, days: 365, granularity: "1d" }));
  const k = await tool("token-diligence").handler({ coins: ["a", "b", "a"] });
  ok(k.coins === 2 && k.comparison.byMarketCap.length === 2 && k.pricing.units === 2, "tokens: a complete answer, duplicates read once and priced once");
  restore();
} finally { restore(); }

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
