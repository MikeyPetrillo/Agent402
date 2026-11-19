// bundle-kit - finished multi-unit deliverables that buy many catalog answers
// in one call and return one computed report:
//   weather-risk-brief  every site's 7-day risk read (forecast, threshold
//                       hits, air quality, last year's same dates, ensemble
//                       heavy-rain probability), scored and ranked
//   filings-brief       a peer set's SEC picture (latest annual and quarterly
//                       financials with ratios, filing activity, Form 4
//                       activity), flagged and ranked
//   token-diligence     a coin list's market diligence (profile and supply,
//                       one-year candles reduced to return, drawdown and
//                       volatility, turnover and dilution), flagged and ranked
//
// Each unit runs the same catalog tools a buyer could call one by one (the
// LEGS below, run in process through their own handlers, so validation, keys,
// pacing and source credits are theirs). The price is per request: the
// skill-pack rule over each unit's legs times the number of units
// (src/bundle-pricing.js), quoted in the 402 from the body.
//
// Deterministic code over the legs' answers: no model writes any part of a
// brief. A 200 always carries every unit complete. A unit the caller named
// wrong (a ticker or coin the source does not know) answers 422 naming it, and
// a leg that fails on the source's side answers 502 or 503: neither is
// charged (x402 settles only an answer under 400).
import { mapLimit } from "./map-limit.js";
import { bad as weatherBad, resolveLocation, WEATHER_TOOLS } from "./weather-kit.js";
import { WEATHER_PLAN_TOOLS } from "./weather-plan-kit.js";
import { WEATHER_PROBABILITY_TOOLS } from "./weather-probability-kit.js";
import { EDGAR_TOOLS } from "./edgar-kit.js";
import { CRYPTO_MARKETS_TOOLS } from "./crypto-markets-kit.js";
import { partialFields } from "../partial-answer.js";
import { withBudgetCeiling } from "../upstream-deadline.js";
import { bundlePriceUsd, unitPartsUsd, usdText, BUNDLE_DISCOUNT } from "../bundle-pricing.js";
import { OPEN_METEO_ATTRIBUTION, CAMS_CREDIT, C3S_CREDIT, COINGECKO_ATTRIBUTION } from "../data-attribution.js";

const bad = weatherBad;

// The whole bundle's upstream work ends inside this (every leg's reads are
// cut off by then); a unit whose leg is cut off fails the call, uncharged.
export const BUNDLE_CEILING_MS = 45_000;

const LEG_TOOLS = [...WEATHER_TOOLS, ...WEATHER_PLAN_TOOLS, ...WEATHER_PROBABILITY_TOOLS, ...EDGAR_TOOLS, ...CRYPTO_MARKETS_TOOLS];
const legBySlug = new Map(LEG_TOOLS.map((t) => [t.slug, t]));
/** A leg tool's catalog entry (its handler and its price). */
export function legTool(slug) {
  const t = legBySlug.get(slug);
  if (!t) throw new Error(`bundle-kit: leg tool '${slug}' is not in the imported kits`);
  return t;
}
const legPrice = (slug) => legTool(slug).price;

const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const ratio = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const statusOf = (e) => (Number.isInteger(e?.statusCode) ? e.statusCode : 502);

// Run one leg through its own handler. The leg's own error (status, message,
// fields) is kept so the bundle can name the unit and the cause. A leg the
// source throttled or failed on its side (429, 502, 503, 504, not marked
// noRetry) is tried once more after a short pause: one bundle sends many
// reads at once, and a burst refusal for one of them should not fail the call.
export const LEG_RETRY_PAUSE_MS = 1_500;
const RETRYABLE = new Set([429, 502, 503, 504]);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function runLeg(slug, input, ctx, { retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await legTool(slug).handler(input, ctx);
    } catch (e) {
      if (attempt < retries && RETRYABLE.has(statusOf(e)) && e?.noRetry !== true && !ctx?.signal?.aborted) { await pause(LEG_RETRY_PAUSE_MS); continue; }
      throw Object.assign(new Error(String(e?.message || "leg failed").slice(0, 300)), { statusCode: statusOf(e), leg: slug, retryAfter: Number.isInteger(e?.retryAfter) ? e.retryAfter : undefined });
    }
  }
}

// Run every unit (at most `concurrency` at once) under the bundle ceiling.
// Any unit's failure fails the call: the caller's input (4xx) as one 422 that
// names every such unit, the source's side (5xx) as the worst status seen.
async function runUnits(units, concurrency, runUnit, label) {
  const results = await withBudgetCeiling(BUNDLE_CEILING_MS, () => mapLimit(units, concurrency, async (u, i) => {
    try { return { ok: true, value: await runUnit(u, i) }; } catch (e) { return { ok: false, error: e, unit: u }; }
  }));
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) return results.map((r) => r.value);
  const callers = failed.filter((r) => statusOf(r.error) < 500 && statusOf(r.error) !== 429);
  if (callers.length) {
    const named = callers.slice(0, 10).map((r) => `${label(r.unit)} (${r.error.message})`).join("; ");
    throw Object.assign(new Error(`${callers.length} of ${units.length} input(s) could not be read: ${named}. Fix or remove them and send again; nothing was charged`), { statusCode: 422, attribution: "caller" });
  }
  const worst = failed.map((r) => statusOf(r.error)).sort((a, b) => b - a)[0];
  const first = failed[0];
  const retryAfter = failed.map((r) => r.error.retryAfter).filter(Number.isInteger).sort((a, b) => b - a)[0];
  throw Object.assign(new Error(`${failed.length} of ${units.length} unit(s) could not be completed on the source's side (first: ${label(first.unit)}, ${first.error.leg || "leg"}: ${first.error.message}). Nothing was charged; retry later`), {
    statusCode: worst === 429 ? 503 : worst >= 500 ? worst : 502, attribution: "upstream", ...(Number.isInteger(retryAfter) ? { retryAfter } : {}),
  });
}

function pricingFields(units, legs) {
  return {
    units,
    unitPartsUsd: round(unitPartsUsd(legs, legPrice), 6),
    priceUsd: bundlePriceUsd(units, legs, legPrice),
    rule: `the sum of each unit's tools (${legs.join(", ")}) times the units, less ${Math.round(BUNDLE_DISCOUNT * 100)}%, rounded up to $0.001`,
  };
}

// ---------------------------------------------------------------- weather
export const WEATHER_RISK_LEGS = Object.freeze(["weather-daily", "weather-thresholds", "weather-air-quality", "weather-history", "weather-probability"]);
export const WEATHER_RISK_MAX_SITES = 50;
const HEAVY_RAIN_MM = 10;
// The fixed risk rules, in each unit system; read by weather-thresholds.
const RISK_RULES = Object.freeze({
  celsius: [
    { key: "frost", variable: "temperature", op: "<", value: 0 },
    { key: "heat", variable: "temperature", op: ">=", value: 35 },
    { key: "highGusts", variable: "wind_gusts", op: ">=", value: 70 },
    { key: "intenseRain", variable: "precipitation", op: ">=", value: 4 },
    { key: "snow", variable: "snowfall", op: ">=", value: 1 },
  ],
  fahrenheit: [
    { key: "frost", variable: "temperature", op: "<", value: 32 },
    { key: "heat", variable: "temperature", op: ">=", value: 95 },
    { key: "highGusts", variable: "wind_gusts", op: ">=", value: 43 },
    { key: "intenseRain", variable: "precipitation", op: ">=", value: 4 },
    { key: "snow", variable: "snowfall", op: ">=", value: 1 },
  ],
});
// Score weights (points out of 100) for each signal present.
export const WEATHER_RISK_WEIGHTS = Object.freeze({ frost: 15, heat: 20, highGusts: 25, intenseRain: 15, snow: 15, heavyRainLikely: 15, poorAir: 10 });
const POOR_AIR_AQI = 100;
// Sites read at once: each runs five reads, and the keyless upstream refuses
// bursts, so a site waits its turn rather than draw a 429 for the call.
const WEATHER_CONCURRENCY = 3;
const HEAVY_RAIN_LIKELY = 0.5;

const numIn = (v, name, min, max) => {
  if (typeof v === "string" && v.trim() === "") throw bad(`"${name}" must be a number`);
  const n = typeof v === "number" || typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`"${name}" must be a number from ${min} to ${max}`);
  return n;
};

/** The sites a weather-risk-brief body names, validated before any read. */
export function weatherSitesOf(input) {
  const raw = input?.sites;
  if (!Array.isArray(raw) || raw.length === 0) throw bad(`"sites" must be a list of 1 to ${WEATHER_RISK_MAX_SITES} sites, each {"lat","lon"} or {"place"} with an optional "name"`);
  if (raw.length > WEATHER_RISK_MAX_SITES) throw bad(`"sites" holds ${raw.length} sites; one call takes at most ${WEATHER_RISK_MAX_SITES}. Split the list across calls`);
  return raw.map((s, i) => {
    const site = typeof s === "string" ? { place: s } : s;
    if (!isPlainObject(site)) throw bad(`sites[${i}] must be {"lat","lon"} or {"place"}, or a place name`);
    const name = site.name === undefined || site.name === null ? null : String(typeof site.name === "string" ? site.name : "").slice(0, 80) || null;
    const hasCoords = site.lat !== undefined && site.lat !== null && site.lat !== "" || site.lon !== undefined && site.lon !== null && site.lon !== "";
    if (hasCoords) return { name, lat: numIn(site.lat, `sites[${i}].lat`, -90, 90), lon: numIn(site.lon, `sites[${i}].lon`, -180, 180) };
    if (typeof site.place !== "string" || !site.place.trim()) throw bad(`sites[${i}] needs "lat" and "lon", or a "place" name`);
    return { name, place: site.place.trim().slice(0, 120) };
  });
}
const weatherUnitsCount = (input) => { try { return weatherSitesOf(input).length; } catch { return 1; } };

/** The same calendar date a year earlier (29 February reads as 1 March). */
export function yearEarlier(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}
const mean = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const sum = (xs) => xs.filter(Number.isFinite).reduce((a, b) => a + b, 0);

/** One site's risk row from its legs' answers (pure; exported for tests). */
export function weatherSiteRow(site, loc, { daily, thresholds, air, history, probability }) {
  const days = Array.isArray(daily?.days) ? daily.days : [];
  const hist = Array.isArray(history?.days) ? history.days : [];
  const wettest = days.reduce((w, d) => (Number(d.precipSum) > Number(w?.precipSum ?? -1) ? d : w), null);
  const gustiest = days.reduce((w, d) => (Number(d.windGusts) > Number(w?.windGusts ?? -1) ? d : w), null);
  const risks = {};
  for (const r of thresholds?.rules || []) {
    const key = r.key;
    if (!key) continue;
    risks[key] = { rule: `${r.variable} ${r.op} ${r.value} ${r.unit || ""}`.trim(), met: !!r.met, firstAt: r.firstAt ?? null, hoursMet: Number(r.hoursMet) || 0 };
  }
  const aq = air?.airQuality || null;
  const usAqi = Number.isFinite(aq?.usAqi) ? aq.usAqi : null;
  const pHeavy = Number.isFinite(probability?.probability) ? probability.probability : null;
  const flags = Object.entries(risks).filter(([, r]) => r.met).map(([k]) => k);
  if (pHeavy !== null && pHeavy >= HEAVY_RAIN_LIKELY) flags.push("heavyRainLikely");
  if (usAqi !== null && usAqi > POOR_AIR_AQI) flags.push("poorAir");
  const score = Math.min(100, flags.reduce((s, f) => s + (WEATHER_RISK_WEIGHTS[f] || 0), 0));
  const fcMax = mean(days.map((d) => Number(d.tempMax))), lyMax = mean(hist.map((d) => Number(d.tempMax)));
  const fcRain = sum(days.map((d) => Number(d.precipSum))), lyRain = sum(hist.map((d) => Number(d.precipSum)));
  return {
    site: { ...(site.name ? { name: site.name } : {}), lat: loc.lat, lon: loc.lon, ...(loc.place ? { place: loc.place.name ? `${loc.place.name}${loc.place.region ? `, ${loc.place.region}` : ""}${loc.place.countryCode ? `, ${loc.place.countryCode}` : ""}` : site.place } : {}) },
    riskScore: score,
    flags,
    forecast: {
      from: days[0]?.date ?? null, to: days[days.length - 1]?.date ?? null, days: days.length,
      tempMax: days.length ? Math.max(...days.map((d) => Number(d.tempMax)).filter(Number.isFinite)) : null,
      tempMin: days.length ? Math.min(...days.map((d) => Number(d.tempMin)).filter(Number.isFinite)) : null,
      precipTotal: round(fcRain, 1),
      wettestDay: wettest ? { date: wettest.date, precipSum: wettest.precipSum, precipProbability: wettest.precipProbability ?? null } : null,
      gustiestDay: gustiest ? { date: gustiest.date, windGusts: gustiest.windGusts } : null,
      uvMax: days.length ? Math.max(...days.map((d) => Number(d.uvIndex)).filter(Number.isFinite)) : null,
      unit: days[0]?.unit ?? null, windUnit: days[0]?.windUnit ?? null,
    },
    risks,
    heavyRain: pHeavy === null ? null : { date: probability.date, thresholdMm: HEAVY_RAIN_MM, probability: pHeavy, members: probability.members?.total ?? null },
    airQuality: aq ? { usAqi, category: aq.category ?? null, pm25: aq.pm25 ?? null, at: aq.time ?? null } : null,
    vsLastYear: {
      from: hist[0]?.date ?? null, to: hist[hist.length - 1]?.date ?? null,
      tempMaxMeanDelta: fcMax !== null && lyMax !== null ? round(fcMax - lyMax, 1) : null,
      precipTotalDelta: hist.length ? round(fcRain - lyRain, 1) : null,
    },
  };
}

async function weatherRiskBrief(input, ctx) {
  const sites = weatherSitesOf(input);
  const units = input?.units === "fahrenheit" ? "fahrenheit" : "celsius";
  if (input?.units !== undefined && input.units !== "celsius" && input.units !== "fahrenheit") throw bad('"units" must be celsius or fahrenheit');
  const rules = RISK_RULES[units];
  const rows = await runUnits(sites, WEATHER_CONCURRENCY, async (site) => {
    // One place lookup per site; every leg then reads the same coordinates.
    const loc = await resolveLocation(site.place ? { place: site.place } : { lat: site.lat, lon: site.lon });
    const at = { lat: loc.lat, lon: loc.lon };
    const [daily, thresholds, air] = await Promise.all([
      runLeg("weather-daily", { ...at, days: 7, units }, ctx),
      runLeg("weather-thresholds", { ...at, hours: 168, units, rules: rules.map(({ variable, op, value }) => ({ variable, op, value })) }, ctx),
      runLeg("weather-air-quality", at, ctx),
    ]);
    const dates = (daily?.days || []).map((d) => d.date).filter(Boolean);
    if (!dates.length) throw Object.assign(new Error("the forecast came back with no days"), { statusCode: 502, leg: "weather-daily" });
    const wettest = daily.days.reduce((w, d) => (Number(d.precipSum) > Number(w.precipSum) ? d : w), daily.days[0]);
    const [history, probability] = await Promise.all([
      runLeg("weather-history", { ...at, start: yearEarlier(dates[0]), end: yearEarlier(dates[dates.length - 1]), units }, ctx),
      runLeg("weather-probability", { ...at, date: wettest.date, variable: "precipitation_sum", op: ">=", value: HEAVY_RAIN_MM }, ctx),
    ]);
    // Name each threshold row by its rule (the leg answers in rule order).
    const named = { ...thresholds, rules: (thresholds?.rules || []).map((r, i) => ({ ...r, key: rules[i]?.key })) };
    return weatherSiteRow(site, loc, { daily, thresholds: named, air, history, probability });
  }, (s) => s.name || s.place || `${s.lat},${s.lon}`);
  const ranking = rows.map((r, i) => ({ index: i, site: r.site.name || r.site.place || `${r.site.lat},${r.site.lon}`, riskScore: r.riskScore, flags: r.flags }))
    .sort((a, b) => b.riskScore - a.riskScore || a.index - b.index);
  const portfolio = {};
  for (const f of Object.keys(WEATHER_RISK_WEIGHTS)) portfolio[f] = rows.filter((r) => r.flags.includes(f)).length;
  return {
    product: "weather-risk-brief",
    generatedAt: new Date().toISOString(),
    units, sites: rows.length,
    portfolio: { sitesWithFlag: portfolio, highestRisk: ranking[0] ?? null, meanRiskScore: round(mean(rows.map((r) => r.riskScore)), 1) },
    ranking,
    rows,
    method: `riskScore adds ${Object.entries(WEATHER_RISK_WEIGHTS).map(([k, v]) => `${k} ${v}`).join(", ")} points (capped at 100) for each signal present: the threshold rules over the next 168 forecast hours, heavyRainLikely when at least ${HEAVY_RAIN_LIKELY * 100}% of ensemble members give ${HEAVY_RAIN_MM} mm or more on the wettest forecast day, poorAir when the current US AQI is above ${POOR_AIR_AQI}. vsLastYear compares the forecast days with the same dates a year earlier. Forecasts and ensemble output are raw model data, not station-calibrated.`,
    pricing: pricingFields(rows.length, WEATHER_RISK_LEGS),
    source: "computed from Open-Meteo forecast, air quality, archive and ensemble data (CC BY 4.0)",
    credits: [OPEN_METEO_ATTRIBUTION, CAMS_CREDIT, C3S_CREDIT],
  };
}

// ---------------------------------------------------------------- filings
export const FILINGS_BRIEF_LEGS = Object.freeze(["company-financials", "edgar-filings", "edgar-insider-trades"]);
export const FILINGS_BRIEF_MAX_COMPANIES = 40;
const TICKER_RE = /^[A-Za-z][A-Za-z0-9.-]{0,9}$/;
const FILINGS_READ = 100;
const RECENT_SHOWN = 5;

/** The tickers a filings-brief body names, validated and deduplicated. */
export function filingTickersOf(input) {
  const raw = typeof input?.tickers === "string" ? input.tickers.split(",") : input?.tickers;
  if (!Array.isArray(raw) || raw.length === 0) throw bad(`"tickers" must be a list of 1 to ${FILINGS_BRIEF_MAX_COMPANIES} US stock tickers, for example ["MSFT","AAPL"]`);
  const out = [];
  for (const [i, t] of raw.entries()) {
    const s = typeof t === "string" ? t.trim().toUpperCase() : "";
    if (!TICKER_RE.test(s)) throw bad(`tickers[${i}] must be a ticker such as "MSFT" (letters, digits, "." or "-", up to 10 characters)`);
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > FILINGS_BRIEF_MAX_COMPANIES) throw bad(`"tickers" holds ${out.length} companies; one call takes at most ${FILINGS_BRIEF_MAX_COMPANIES}. Split the list across calls`);
  return out;
}
const filingUnitsCount = (input) => { try { return filingTickersOf(input).length; } catch { return 1; } };

const metric = (fin, label) => (fin?.metrics || []).find((m) => m.label === label) || null;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** One company's row from its legs' answers (pure; exported for tests). */
export function filingCompanyRow(ticker, { financials, filings, insiders }, now = Date.now()) {
  const annual = (label) => metric(financials, label)?.latestAnnual?.value ?? null;
  const quarterly = (label) => metric(financials, label)?.latestQuarterly?.value ?? null;
  const rev = annual("Revenue"), ni = annual("Net Income"), oi = annual("Operating Income");
  const assets = annual("Total Assets"), liab = annual("Total Liabilities"), eq = annual("Stockholders Equity");
  const list = Array.isArray(filings?.filings) ? filings.filings : [];
  const today = new Date(now).toISOString().slice(0, 10);
  const within = (f, d) => f.filingDate && daysBetween(f.filingDate, today) <= d;
  const latestOf = (forms) => list.find((f) => forms.includes(f.form))?.filingDate ?? null;
  const last10K = latestOf(["10-K", "10-K/A", "20-F", "40-F"]), last10Q = latestOf(["10-Q", "10-Q/A"]);
  const lastPeriodic = [last10K, last10Q].filter(Boolean).sort().pop() || null;
  const daysSincePeriodic = lastPeriodic ? daysBetween(lastPeriodic, today) : null;
  const eightK90 = list.filter((f) => f.form === "8-K" && within(f, 90)).length;
  const form4Total = Number.isFinite(insiders?.total) ? insiders.total : null;
  const netMargin = ratio(ni, rev), opMargin = ratio(oi, rev), leverage = ratio(liab, assets);
  const flags = [];
  if (Number.isFinite(ni) && ni < 0) flags.push("netLoss");
  if (Number.isFinite(eq) && eq < 0) flags.push("negativeEquity");
  if (leverage !== null && leverage > 0.8) flags.push("highLeverage");
  if (daysSincePeriodic === null || daysSincePeriodic > 120) flags.push("noPeriodicReport120d");
  if (form4Total !== null && form4Total >= 60) flags.push("busyInsiderFiling");
  if (eightK90 >= 5) flags.push("frequent8K");
  return {
    ticker, cik: financials?.cik ?? filings?.cik ?? null, name: financials?.entityName ?? filings?.name ?? null,
    industry: filings?.sicDescription ?? null, exchanges: filings?.exchanges ?? [],
    flags,
    financials: {
      annual: { revenue: rev, netIncome: ni, operatingIncome: oi, totalAssets: assets, totalLiabilities: liab, stockholdersEquity: eq, epsBasic: annual("EPS (Basic)"), operatingCashFlow: annual("Operating Cash Flow"), period: metric(financials, "Revenue")?.latestAnnual?.period ?? metric(financials, "Total Assets")?.latestAnnual?.period ?? null },
      quarterly: { revenue: quarterly("Revenue"), netIncome: quarterly("Net Income"), period: metric(financials, "Revenue")?.latestQuarterly?.period ?? null },
      ratios: { netMargin: round(netMargin, 4), operatingMargin: round(opMargin, 4), liabilitiesToAssets: round(leverage, 4), equityToAssets: round(ratio(eq, assets), 4) },
    },
    filingActivity: {
      last10K, last10Q, daysSinceLatestPeriodicReport: daysSincePeriodic,
      eightKLast90Days: eightK90,
      recentFilings: list.slice(0, RECENT_SHOWN).map((f) => ({ form: f.form, filingDate: f.filingDate, url: f.url })),
      recentFilingsPartial: partialFields(list.length, Math.min(RECENT_SHOWN, list.length)),
      filingsRead: list.length,
    },
    insiderActivity: {
      windowDays: insiders?.windowDays ?? 90, form4Filings: form4Total,
      filers: [...new Set((insiders?.trades || []).map((t) => (t.displayNames || [])[0]).filter(Boolean))].slice(0, 5),
      note: "Form 4 filings counted, not shares or direction",
    },
  };
}

async function filingsBrief(input, ctx) {
  const tickers = filingTickersOf(input);
  const rows = await runUnits(tickers, 6, async (ticker) => {
    const [financials, filings, insiders] = await Promise.all([
      runLeg("company-financials", { ticker }, ctx),
      runLeg("edgar-filings", { ticker, limit: FILINGS_READ }, ctx),
      runLeg("edgar-insider-trades", { ticker, days: 90, limit: 20 }, ctx),
    ]);
    return filingCompanyRow(ticker, { financials, filings, insiders });
  }, (t) => t);
  const rankBy = (pick) => rows.map((r) => ({ ticker: r.ticker, value: pick(r) })).filter((x) => Number.isFinite(x.value)).sort((a, b) => b.value - a.value).map((x, i) => ({ rank: i + 1, ...x }));
  return {
    product: "filings-brief",
    generatedAt: new Date().toISOString(),
    companies: rows.length,
    peers: {
      byRevenue: rankBy((r) => r.financials.annual.revenue),
      byNetMargin: rankBy((r) => r.financials.ratios.netMargin),
      flagged: rows.filter((r) => r.flags.length).map((r) => ({ ticker: r.ticker, flags: r.flags })),
    },
    rows,
    method: "Values are the latest annual and quarterly XBRL facts as filed; ratios divide annual values. noPeriodicReport120d: no 10-K, 10-Q, 20-F or 40-F among the latest 100 filings within 120 days. busyInsiderFiling: 60 or more Form 4 filings in 90 days. frequent8K: 5 or more 8-K filings in 90 days. highLeverage: liabilities above 80% of assets. Facts only; nothing here is investment advice.",
    pricing: pricingFields(rows.length, FILINGS_BRIEF_LEGS),
    source: "computed from SEC EDGAR (data.sec.gov submissions and XBRL company facts, efts.sec.gov full-text search; public domain)",
  };
}

// ---------------------------------------------------------------- tokens
export const TOKEN_DILIGENCE_LEGS = Object.freeze(["coin-profile", "coin-ohlc"]);
export const TOKEN_DILIGENCE_MAX_COINS = 20;
const COIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** The coin ids a token-diligence body names, validated and deduplicated. */
export function coinIdsOf(input) {
  const raw = typeof input?.coins === "string" ? input.coins.split(",") : input?.coins;
  if (!Array.isArray(raw) || raw.length === 0) throw bad(`"coins" must be a list of 1 to ${TOKEN_DILIGENCE_MAX_COINS} coin ids, for example ["bitcoin","chainlink"] (coin-search finds an id)`);
  const out = [];
  for (const [i, c] of raw.entries()) {
    const s = typeof c === "string" ? c.trim().toLowerCase() : "";
    if (!COIN_ID_RE.test(s)) throw bad(`coins[${i}] must be a coin id such as "chainlink" (lowercase letters, digits and "-")`);
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > TOKEN_DILIGENCE_MAX_COINS) throw bad(`"coins" holds ${out.length} coins; one call takes at most ${TOKEN_DILIGENCE_MAX_COINS}. Split the list across calls`);
  return out;
}
const coinUnitsCount = (input) => { try { return coinIdsOf(input).length; } catch { return 1; } };

/** Max peak-to-trough fall (percent) and annualized close-to-close volatility
 *  (percent) from candles (pure; exported for tests). */
export function candleStats(bars) {
  const closes = (bars || []).map((b) => Number(b.close)).filter((x) => Number.isFinite(x) && x > 0);
  let peak = -Infinity, maxDd = 0;
  // A bar's low is measured against the highs of the bars BEFORE it (and its
  // own open): within one bar the order of its high and low is unknown.
  for (const b of bars || []) {
    const hi = Number(b.high), lo = Number(b.low), open = Number(b.open);
    if (Number.isFinite(open) && open > peak) peak = open;
    if (Number.isFinite(lo) && peak > 0) maxDd = Math.max(maxDd, (peak - lo) / peak);
    if (Number.isFinite(hi) && hi > peak) peak = hi;
  }
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  let vol = null;
  if (rets.length >= 2 && bars.length >= 2) {
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
    const spanMs = Date.parse(bars[bars.length - 1].time) - Date.parse(bars[0].time);
    const stepDays = spanMs > 0 ? spanMs / 86_400_000 / (bars.length - 1) : null;
    vol = stepDays ? sd * Math.sqrt(365 / stepDays) * 100 : null;
  }
  return { maxDrawdownPct: closes.length ? round(maxDd * 100, 1) : null, volatilityAnnualizedPct: round(vol, 1), bars: (bars || []).length };
}

/** One coin's row from its legs' answers (pure; exported for tests). */
export function tokenRow(id, { profile, ohlc }) {
  const m = profile?.market || {};
  const stats = candleStats(ohlc?.bars);
  const turnover = ratio(m.volume24h, m.marketCap), dilution = ratio(m.fullyDilutedValuation, m.marketCap);
  const supplyCap = Number.isFinite(m.maxSupply) && m.maxSupply > 0 ? m.maxSupply : m.totalSupply;
  const circulatingShare = ratio(m.circulatingSupply, supplyCap);
  const flags = [];
  if (dilution !== null && dilution > 2) flags.push("highDilution");
  if (turnover !== null && turnover < 0.01) flags.push("thinTurnover");
  if (Number.isFinite(m.athChangePct) && m.athChangePct <= -70) flags.push("farBelowATH");
  if (stats.volatilityAnnualizedPct !== null && stats.volatilityAnnualizedPct > 100) flags.push("highVolatility");
  if (stats.maxDrawdownPct !== null && stats.maxDrawdownPct > 60) flags.push("deepDrawdown1y");
  if (!Number.isFinite(m.marketCap) || m.marketCap <= 0) flags.push("noMarketCap");
  const contracts = Array.isArray(profile?.platforms) ? profile.platforms.filter((p) => p?.contract) : [];
  return {
    id, symbol: profile?.symbol ?? null, name: profile?.name ?? null, rank: profile?.rank ?? null,
    flags,
    market: { price: m.price ?? null, marketCap: m.marketCap ?? null, fullyDilutedValuation: m.fullyDilutedValuation ?? null, volume24h: m.volume24h ?? null, change7dPct: m.change7dPct ?? null, change30dPct: m.change30dPct ?? null, change1yPct: m.change1yPct ?? null, ath: m.ath ?? null, athChangePct: m.athChangePct ?? null, currency: profile?.currency ?? "usd" },
    supply: { circulating: m.circulatingSupply ?? null, total: m.totalSupply ?? null, max: m.maxSupply ?? null, circulatingShare: round(circulatingShare, 4) },
    computed: {
      turnover24h: round(turnover, 4), fdvToMarketCap: round(dilution, 3),
      return1yPct: Number.isFinite(ohlc?.summary?.changePct) ? round(ohlc.summary.changePct, 1) : null,
      maxDrawdown1yPct: stats.maxDrawdownPct, volatilityAnnualizedPct: stats.volatilityAnnualizedPct,
      candles: { days: ohlc?.days ?? 365, bars: stats.bars, granularity: ohlc?.granularity ?? null },
    },
    profile: { genesisDate: profile?.genesisDate ?? null, categories: (profile?.categories || []).slice(0, 5), homepage: profile?.links?.homepage ?? null, chains: contracts.length, contracts: contracts.slice(0, 5).map((p) => ({ platform: p.platform, contract: p.contract })), contractsPartial: partialFields(contracts.length, Math.min(5, contracts.length)) },
  };
}

async function tokenDiligence(input, ctx) {
  const coins = coinIdsOf(input);
  const rows = await runUnits(coins, 4, async (coin) => {
    const [profile, ohlc] = await Promise.all([
      runLeg("coin-profile", { coin }, ctx),
      runLeg("coin-ohlc", { coin, days: 365 }, ctx),
    ]);
    return tokenRow(coin, { profile, ohlc });
  }, (c) => c);
  const rankBy = (pick, asc = false) => rows.map((r) => ({ id: r.id, value: pick(r) })).filter((x) => Number.isFinite(x.value)).sort((a, b) => (asc ? a.value - b.value : b.value - a.value)).map((x, i) => ({ rank: i + 1, ...x }));
  return {
    product: "token-diligence",
    generatedAt: new Date().toISOString(),
    coins: rows.length,
    comparison: {
      byMarketCap: rankBy((r) => r.market.marketCap),
      byReturn1y: rankBy((r) => r.computed.return1yPct),
      byVolatilityLowFirst: rankBy((r) => r.computed.volatilityAnnualizedPct, true),
      flagged: rows.filter((r) => r.flags.length).map((r) => ({ id: r.id, flags: r.flags })),
    },
    rows,
    method: "turnover24h is 24h volume over market cap; fdvToMarketCap is fully diluted value over market cap; maxDrawdown1yPct is the largest fall from a running high to a later candle's low over the one-year candles; volatilityAnnualizedPct is the standard deviation of close-to-close log returns scaled to a year. Flags: highDilution (fdvToMarketCap above 2), thinTurnover (below 0.01), farBelowATH (70% or more under the all-time high), highVolatility (above 100%), deepDrawdown1y (above 60%). Market facts only; nothing here is investment advice.",
    pricing: pricingFields(rows.length, TOKEN_DILIGENCE_LEGS),
    source: "computed from CoinGecko coin profiles and OHLC candles",
    credits: [COINGECKO_ATTRIBUTION],
  };
}

// ---------------------------------------------------------------- catalog
// Price per request: the rule over the units the body names (the 402 quotes
// the body); the list price is one unit's, the ceiling the most units a call takes.
const quoted = (legs, count, max) => ({
  price: usdText(bundlePriceUsd(1, legs, legPrice)),
  quote: (body) => bundlePriceUsd(Math.min(max, count(body)), legs, legPrice),
  quoteMaxUsd: bundlePriceUsd(max, legs, legPrice),
});
const perUnit = (legs) => usdText(bundlePriceUsd(1, legs, legPrice));

const WEATHER_EXAMPLE_SITES = [
  { name: "Chicago DC", lat: 41.88, lon: -87.63 }, { name: "Houston DC", lat: 29.76, lon: -95.37 },
  { name: "Denver DC", lat: 39.74, lon: -104.99 }, { name: "Miami DC", lat: 25.76, lon: -80.19 },
  { name: "Seattle DC", lat: 47.61, lon: -122.33 }, { name: "Phoenix DC", lat: 33.45, lon: -112.07 },
];
const FILINGS_EXAMPLE = ["MSFT", "AAPL", "GOOGL", "AMZN", "META"];
const COINS_EXAMPLE = ["bitcoin", "ethereum", "chainlink", "uniswap"];

export const BUNDLE_TOOLS = [
  {
    route: "POST /api/weather-risk-brief",
    name: "Weather risk brief (many sites)",
    slug: "weather-risk-brief",
    category: "data",
    attribution: "open-meteo",
    ...quoted(WEATHER_RISK_LEGS, weatherUnitsCount, WEATHER_RISK_MAX_SITES),
    description:
      `One 7-day weather risk read for up to ${WEATHER_RISK_MAX_SITES} sites in one call: per site the daily forecast, hour-by-hour checks for frost, heat, high gusts, intense rain and snow over the next 168 hours, current air quality, the same dates a year earlier, and the ensemble probability of ${HEAVY_RAIN_MM} mm or more of rain on the wettest forecast day; each site gets a 0-100 risk score from the signals present and the sites are ranked. Priced per site: the five weather tools it runs (${WEATHER_RISK_LEGS.join(", ")}) less ${Math.round(BUNDLE_DISCOUNT * 100)}%, ${perUnit(WEATHER_RISK_LEGS)} a site, quoted in the 402 for the sites you send. A site is {"lat","lon"} or {"place"} with an optional "name". Deterministic code over the forecast data, no model. ${OPEN_METEO_ATTRIBUTION}`,
    tags: ["weather", "risk", "portfolio", "sites", "logistics", "insurance", "forecast", "bundle"],
    discovery: {
      bodyType: "json",
      input: { sites: WEATHER_EXAMPLE_SITES },
      inputSchema: {
        properties: {
          sites: { type: "array", description: `1 to ${WEATHER_RISK_MAX_SITES} sites, each {"lat","lon"} or {"place"} with an optional "name" (a place name string also works)`, items: { type: "object", properties: { name: { type: "string", description: "Your label for the site (up to 80 characters)" }, lat: { type: "number", description: "Latitude, -90 to 90" }, lon: { type: "number", description: "Longitude, -180 to 180" }, place: { type: "string", description: "A city, town or region name instead of lat/lon" } } } },
          units: { type: "string", description: "celsius (default; wind km/h) or fahrenheit (wind mph); rain is always mm" },
        },
        required: ["sites"],
      },
      output: {
        example: {
          product: "weather-risk-brief", generatedAt: "2026-11-18T23:40:00.000Z", units: "celsius", sites: 6,
          portfolio: { sitesWithFlag: { frost: 2, heat: 0, highGusts: 1, intenseRain: 1, snow: 1, heavyRainLikely: 1, poorAir: 0 }, highestRisk: { index: 2, site: "Denver DC", riskScore: 55, flags: ["frost", "highGusts", "snow"] }, meanRiskScore: 20.8 },
          ranking: [{ index: 2, site: "Denver DC", riskScore: 55, flags: ["frost", "highGusts", "snow"] }, { index: 0, site: "Chicago DC", riskScore: 30, flags: ["frost", "heavyRainLikely"] }],
          rows: [{
            site: { name: "Denver DC", lat: 39.74, lon: -104.99 }, riskScore: 55, flags: ["frost", "highGusts", "snow"],
            forecast: { from: "2026-11-18", to: "2026-11-24", days: 7, tempMax: 14.2, tempMin: -9.1, precipTotal: 6.3, wettestDay: { date: "2026-11-21", precipSum: 4.8, precipProbability: 61 }, gustiestDay: { date: "2026-11-21", windGusts: 74.2 }, uvMax: 3.1, unit: "°C", windUnit: "km/h" },
            risks: { frost: { rule: "temperature < 0 °C", met: true, firstAt: "2026-11-19T03:00", hoursMet: 41 }, highGusts: { rule: "wind_gusts >= 70 km/h", met: true, firstAt: "2026-11-21T13:00", hoursMet: 3 } },
            heavyRain: { date: "2026-11-21", thresholdMm: 10, probability: 0.0732, members: 82 },
            airQuality: { usAqi: 41, category: "Good", pm25: 6.2, at: "2026-11-18T23:00" },
            vsLastYear: { from: "2025-11-19", to: "2025-11-25", tempMaxMeanDelta: -2.4, precipTotalDelta: 3.1 },
          }],
          method: "riskScore adds frost 15, heat 20, highGusts 25, intenseRain 15, snow 15, heavyRainLikely 15, poorAir 10 points (capped at 100) for each signal present.",
          pricing: pricingFields(WEATHER_EXAMPLE_SITES.length, WEATHER_RISK_LEGS),
          source: "computed from Open-Meteo forecast, air quality, archive and ensemble data (CC BY 4.0)",
          credits: [OPEN_METEO_ATTRIBUTION],
        },
      },
    },
    handler: weatherRiskBrief,
  },
  {
    route: "POST /api/filings-brief",
    name: "SEC filings brief (peer set)",
    slug: "filings-brief",
    category: "data",
    ...quoted(FILINGS_BRIEF_LEGS, filingUnitsCount, FILINGS_BRIEF_MAX_COMPANIES),
    description:
      `One SEC EDGAR brief for up to ${FILINGS_BRIEF_MAX_COMPANIES} US public companies in one call: per company the latest annual and quarterly financials as filed (revenue, net and operating income, assets, liabilities, equity, EPS, operating cash flow) with margins and leverage computed, filing activity (latest 10-K and 10-Q, days since the latest periodic report, 8-K count over 90 days, the newest filings with links) and Form 4 filing activity over 90 days; flags for net loss, negative equity, high leverage, a missing periodic report, busy insider filing and frequent 8-Ks, with the set ranked by revenue and net margin. Priced per company: the three EDGAR tools it runs (${FILINGS_BRIEF_LEGS.join(", ")}) less ${Math.round(BUNDLE_DISCOUNT * 100)}%, ${perUnit(FILINGS_BRIEF_LEGS)} a company, quoted in the 402 for the tickers you send. Deterministic code over public-domain SEC data, no model; facts, not investment advice.`,
    tags: ["sec", "edgar", "filings", "financials", "peers", "10-k", "insider", "bundle"],
    discovery: {
      bodyType: "json",
      input: { tickers: FILINGS_EXAMPLE },
      inputSchema: {
        properties: { tickers: { type: "array", items: { type: "string" }, description: `1 to ${FILINGS_BRIEF_MAX_COMPANIES} US stock tickers (a comma-separated string also works)` } },
        required: ["tickers"],
      },
      output: {
        example: {
          product: "filings-brief", generatedAt: "2026-11-18T23:40:00.000Z", companies: 5,
          peers: { byRevenue: [{ rank: 1, ticker: "AMZN", value: 716924000000 }, { rank: 2, ticker: "AAPL", value: 416161000000 }], byNetMargin: [{ rank: 1, ticker: "MSFT", value: 0.4031 }], flagged: [{ ticker: "META", flags: ["busyInsiderFiling"] }] },
          rows: [{
            ticker: "MSFT", cik: "0000789019", name: "MICROSOFT CORP", industry: "Services-Prepackaged Software", exchanges: ["Nasdaq"], flags: [],
            financials: { annual: { revenue: 331839000000, netIncome: 133749000000, operatingIncome: 155237000000, totalAssets: 758376000000, totalLiabilities: 315989000000, stockholdersEquity: 442387000000, epsBasic: 18, operatingCashFlow: 151893000000, period: "2026-06-30" }, quarterly: { revenue: 92279000000, netIncome: 36629000000, period: "2026-09-30" }, ratios: { netMargin: 0.4031, operatingMargin: 0.4678, liabilitiesToAssets: 0.4167, equityToAssets: 0.5833 } },
            filingActivity: { last10K: "2026-07-29", last10Q: "2026-10-28", daysSinceLatestPeriodicReport: 21, eightKLast90Days: 4, recentFilings: [{ form: "4", filingDate: "2026-11-16", url: "https://www.sec.gov/Archives/edgar/data/789019/000078901926000236/xslF345X06/form4.xml" }], recentFilingsPartial: { returned: 5, matched: 100, complete: false, truncated: true }, filingsRead: 100 },
            insiderActivity: { windowDays: 90, form4Filings: 45, filers: ["Coleman Amy  (CIK 0002062356)"], note: "Form 4 filings counted, not shares or direction" },
          }],
          method: "Values are the latest annual and quarterly XBRL facts as filed; ratios divide annual values.",
          pricing: pricingFields(FILINGS_EXAMPLE.length, FILINGS_BRIEF_LEGS),
          source: "computed from SEC EDGAR (data.sec.gov submissions and XBRL company facts, efts.sec.gov full-text search; public domain)",
        },
      },
    },
    handler: filingsBrief,
  },
  {
    route: "POST /api/token-diligence",
    name: "Token diligence (coin list)",
    slug: "token-diligence",
    category: "crypto",
    attribution: "coingecko",
    ...quoted(TOKEN_DILIGENCE_LEGS, coinUnitsCount, TOKEN_DILIGENCE_MAX_COINS),
    description:
      `One market diligence read for up to ${TOKEN_DILIGENCE_MAX_COINS} coins in one call: per coin the profile and market snapshot (price, market cap, fully diluted value, volume, supply, all-time high) with turnover, dilution and circulating share computed, one year of candles reduced to return, largest drawdown and annualized volatility, and contract addresses per chain; flags for high dilution, thin turnover, far below the all-time high, high volatility and a deep drawdown, with the list ranked by market cap, one-year return and volatility. Priced per coin: the two tools it runs (${TOKEN_DILIGENCE_LEGS.join(", ")}) less ${Math.round(BUNDLE_DISCOUNT * 100)}%, ${perUnit(TOKEN_DILIGENCE_LEGS)} a coin, quoted in the 402 for the coins you send. Coins by coin id (coin-search finds one). Deterministic code, no model; market facts, not investment advice. ${COINGECKO_ATTRIBUTION}`,
    tags: ["crypto", "token", "diligence", "volatility", "drawdown", "dilution", "portfolio", "bundle"],
    discovery: {
      bodyType: "json",
      input: { coins: COINS_EXAMPLE },
      inputSchema: {
        properties: { coins: { type: "array", items: { type: "string" }, description: `1 to ${TOKEN_DILIGENCE_MAX_COINS} coin ids as coin-search returns them (a comma-separated string also works)` } },
        required: ["coins"],
      },
      output: {
        example: {
          product: "token-diligence", generatedAt: "2026-11-18T23:40:00.000Z", coins: 4,
          comparison: { byMarketCap: [{ rank: 1, id: "bitcoin", value: 1810000000000 }], byReturn1y: [{ rank: 1, id: "bitcoin", value: -1.2 }], byVolatilityLowFirst: [{ rank: 1, id: "bitcoin", value: 41.7 }], flagged: [{ id: "chainlink", flags: ["farBelowATH", "deepDrawdown1y"] }] },
          rows: [{
            id: "chainlink", symbol: "LINK", name: "Chainlink", rank: 17, flags: ["farBelowATH"],
            market: { price: 9.05, marketCap: 6942568367, fullyDilutedValuation: 9053359373, volume24h: 183294158, change7dPct: -11.1, change30dPct: -24.87, change1yPct: -34.28, ath: 52.7, athChangePct: -82.82, currency: "usd" },
            supply: { circulating: 766849970.42, total: 1000000000, max: 1000000000, circulatingShare: 0.7668 },
            computed: { turnover24h: 0.0264, fdvToMarketCap: 1.304, return1yPct: -34.1, maxDrawdown1yPct: 55.5, volatilityAnnualizedPct: 71.3, candles: { days: 365, bars: 92, granularity: "4d" } },
            profile: { genesisDate: "2017-09-16", categories: ["Infrastructure", "Oracle"], homepage: "https://chain.link/", chains: 89, contracts: [{ platform: "ethereum", contract: "0x514910771af9ca656af840dff83e8264ecf986ca" }], contractsPartial: { returned: 5, matched: 89, complete: false, truncated: true } },
          }],
          method: "turnover24h is 24h volume over market cap; fdvToMarketCap is fully diluted value over market cap.",
          pricing: pricingFields(COINS_EXAMPLE.length, TOKEN_DILIGENCE_LEGS),
          source: "computed from CoinGecko coin profiles and OHLC candles",
          credits: [COINGECKO_ATTRIBUTION],
        },
      },
    },
    handler: tokenDiligence,
  },
];

export const BUNDLE_LEGS = Object.freeze({ "weather-risk-brief": WEATHER_RISK_LEGS, "filings-brief": FILINGS_BRIEF_LEGS, "token-diligence": TOKEN_DILIGENCE_LEGS });
export const BUNDLE_MAX_UNITS = Object.freeze({ "weather-risk-brief": WEATHER_RISK_MAX_SITES, "filings-brief": FILINGS_BRIEF_MAX_COMPANIES, "token-diligence": TOKEN_DILIGENCE_MAX_COINS });
