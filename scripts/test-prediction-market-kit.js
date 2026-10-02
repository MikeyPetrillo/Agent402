// scripts/test-prediction-market-kit.js
// Offline tests for src/tools/prediction-market-kit.js. No keys, no network
// by default. Live calls are opt-in via PREDICTION_LIVE_TEST=1.
//
// Pattern matches scripts/test-dex-kit.js:
//   • Catalog envelope + input validation always runs (no key, no network).
//   • Pure-CPU helpers (asNumber, shape*) covered with vectors.
//   • Live calls are opt-in (Kalshi is keyless,
//     but live tests share the rate-limit pool so CI doesn't burn them).

import { PREDICTION_MARKET_TOOLS, __test } from "../src/tools/prediction-market-kit.js";

import { readFileSync } from "node:fs";
const { asNumber, shapeKalshiMarket, shapeKalshiLiveData, shapeWeatherPoint, shapeWeatherCalibration, WEATHER_CITIES } = __test;

const h = (slug) => PREDICTION_MARKET_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
ok(PREDICTION_MARKET_TOOLS.length === 4, `4 tools exported (got ${PREDICTION_MARKET_TOOLS.length})`);

const expectedSlugs = ["kalshi-markets", "kalshi-event", "kalshi-live-data", "kalshi-weather-index"];
for (const slug of expectedSlugs) {
  ok(!!PREDICTION_MARKET_TOOLS.find((t) => t.slug === slug), `slug present: ${slug}`);
}

for (const t of PREDICTION_MARKET_TOOLS) {
  ok(typeof t.slug === "string" && t.slug.length > 0, `${t.slug}: has slug`);
  ok(t.route?.startsWith("POST /api/"), `${t.slug}: POST /api/ route`);
  ok(t.category === "crypto", `${t.slug}: category=crypto`);
  ok(typeof t.price === "string" && /^\$\d/.test(t.price), `${t.slug}: priced (${t.price})`);
  ok(typeof t.handler === "function", `${t.slug}: has handler`);
  const d = t.discovery;
  ok(d && d.input && d.inputSchema && d.output?.example, `${t.slug}: full discovery envelope`);
  ok(d.bodyType === "json", `${t.slug}: bodyType=json`);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
ok(asNumber("0.45") === 0.45, "asNumber: '0.45' → 0.45");
ok(asNumber(0.6) === 0.6, "asNumber: 0.6 → 0.6");
ok(asNumber(null) === null, "asNumber: null → null");
ok(asNumber("not-a-number") === null, "asNumber: bad string → null");
ok(asNumber(undefined, 42) === 42, "asNumber: fallback honored");


// Kalshi shape
const kraw = {
  ticker: "TEST-25",
  event_ticker: "TEST",
  title: "Test market",
  subtitle: "Subtitle",
  status: "open",
  open_time: "2026-01-01T00:00:00Z",
  close_time: "2026-12-31T23:59:00Z",
  expiration_time: "2027-01-01T00:00:00Z",
  yes_bid: 45,
  yes_ask: 47,
  no_bid: 53,
  no_ask: 55,
  last_price: 46,
  volume: 12345,
  open_interest: 5678,
};
const kshaped = shapeKalshiMarket(kraw);
ok(kshaped.ticker === "TEST-25", "shapeKalshiMarket: ticker passthrough");
ok(kshaped.eventTicker === "TEST", "shapeKalshiMarket: event_ticker → eventTicker camelCase");
ok(kshaped.yesBid === 45, "shapeKalshiMarket: yes_bid → yesBid");
ok(kshaped.venue === "kalshi", "shapeKalshiMarket: venue tag");
ok(kshaped.venueUrl === "https://kalshi.com/markets/test-25", "shapeKalshiMarket: venueUrl lowercased");

// Kalshi removed the integer-cents fields (verified live 2026-08-28): the
// current API sends STRING DOLLARS and fixed-point volume. Both paid Kalshi
// tools were returning 200 with every one of these null. The shaper reads the
// new names, keeps the buyer-facing values in CENTS, and publishes the dollar
// figures alongside; the legacy fallback above must keep working so a rollback
// on their side cannot break us a second time.
const knew = {
  ticker: "NEW-26", event_ticker: "NEW", title: "t", status: "active",
  yes_bid_dollars: "0.4700", yes_ask_dollars: "0.4900",
  no_bid_dollars: "0.5100", no_ask_dollars: "0.5300",
  last_price_dollars: "0.4800", volume_fp: "12345.00",
  open_interest_fp: "5678.00", liquidity_dollars: "910.5000",
};
const kn = shapeKalshiMarket(knew);
ok(kn.yesBid === 47 && kn.yesAsk === 49 && kn.noBid === 51 && kn.noAsk === 53 && kn.lastPrice === 48,
  `dollar strings become cents (yesBid ${kn.yesBid}, lastPrice ${kn.lastPrice})`);
ok(kn.yesBidUsd === 0.47 && kn.lastPriceUsd === 0.48, "the dollar values ride alongside under their own names");
ok(kn.volume === 12345 && kn.openInterest === 5678 && kn.liquidityUsd === 910.5, "volume, open interest and liquidity come from the fixed-point fields");
ok(![kn.yesBid, kn.yesAsk, kn.noBid, kn.noAsk, kn.lastPrice, kn.volume, kn.openInterest].includes(null),
  "no field is null on a market the API describes fully (the failure this fixes was 200 with every value null)");
const kzero = shapeKalshiMarket({ ticker: "Z-26", yes_bid_dollars: "0.0000", volume_fp: "0.00" });
ok(kzero.yesBid === 0 && kzero.volume === 0, "a genuinely untraded market reads 0, never null");
const kmissing = shapeKalshiMarket({ ticker: "M-26" });
ok(kmissing.yesBid === null && kmissing.volume === null, "an absent field is still null, never a fabricated 0");

// Kalshi retires liquidity_dollars on 2026-10-01, and it already reads 0 on
// markets with a live book. liquidityUsd is Kalshi's own figure only when it
// carries one; otherwise null with a reason. Depth is the top-of-book size, in
// contracts, under its own names, never relabelled as "liquidity".
const kbook = shapeKalshiMarket({ ticker: "B-26", liquidity_dollars: "0.0000", yes_bid_size_fp: "471.53", yes_ask_size_fp: "323.10" });
ok(kbook.yesBidSize === 471.53 && kbook.yesAskSize === 323.1, "top-of-book sizes come from the *_size_fp fields");
ok(kbook.liquidityUsd === null && /yesBidSize/.test(kbook.liquidityUsdNote || ""),
  "a zero liquidity_dollars beside a live book is null with a note, not a false 0");
const kgone = shapeKalshiMarket({ ticker: "G-26", yes_bid_size_fp: "10.00" });
ok(kgone.liquidityUsd === null && typeof kgone.liquidityUsdNote === "string", "after removal the field reads null and says why");
const kempty = shapeKalshiMarket({ ticker: "E-26", liquidity_dollars: "0.0000", yes_bid_size_fp: "0.00", yes_ask_size_fp: "0.00" });
ok(kempty.liquidityUsd === 0 && kempty.yesBidSize === 0 && !("liquidityUsdNote" in kempty), "an empty book with a zero figure still reads 0");
ok(kn.liquidityUsdNote === undefined, "a nonzero legacy figure is kept with no note");
ok(kmissing.yesBidSize === null, "an absent size field is null");

// ----------------------------------------------------------------------------
// Input validation — all 6 tools
// ----------------------------------------------------------------------------
async function throws(promise, status, label) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status) { pass++; console.log(`ok - ${label} → ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}, got ${e.statusCode} (${e.message})`); }
  }
}

// kalshi-markets
await throws(h("kalshi-markets")({ status: "invalid-status" }), 400, "kalshi-markets: bad status");

// kalshi-event
await throws(h("kalshi-event")({}), 400, "kalshi-event: missing eventTicker");
await throws(h("kalshi-event")({ eventTicker: "" }), 400, "kalshi-event: empty eventTicker");
await throws(h("kalshi-event")({ eventTicker: "   " }), 400, "kalshi-event: whitespace eventTicker");

// ----------------------------------------------------------------------------
// Live tests (opt-in)
// ----------------------------------------------------------------------------
if (process.env.PREDICTION_LIVE_TEST === "1") {
  console.log("\n--- live tests ---");
  try {
    const km = await h("kalshi-markets")({ status: "open", limit: 3 });
    ok(typeof km.count === "number", `live kalshi-markets: count returned (${km.count})`);
    ok(Array.isArray(km.markets), `live kalshi-markets: markets array`);
  } catch (e) {
    console.error(`LIVE ERR: ${e.message}`);
    fail++;
  }
}

// ----------------------------------------------------------------------------
// Kalshi live_data (2026-09-18): the feed BEHIND an event and the city
// temperature index. Fixtures are trimmed copies of the live responses read
// that day (docs.kalshi.com/api-reference/live-data). The shaper rule under
// test is the shapeKalshiMarket rule: an absent field reads null, never 0,
// and the two array shapes Kalshi actually serves are normalised while
// whatever else the type carries rides through under `details`.
// ----------------------------------------------------------------------------
{
  // GET /live_data/events/KXBTC-26SEP1813?range=15min (crypto type)
  const btcLive = { live_data: { default_range: "1h", details: {
    candlesticks: {
      "15M": [{ open_ts_ms: 1789747466000, open: 80695.74, high: 81009.59, low: 80695.74, close: 81009.59 }, { open_ts_ms: 1789748366000, open: 81009.82, high: 81210.11, low: 80877.87, close: 81210.11 }],
      "1M": [{ open_ts_ms: 1789749180000, open: 81108.81, high: 81198.23, low: 81108.81, close: 81198.23 }],
    },
    coin: "BTC", event_ticker: "KXBTC-26SEP1813", maturity_ts_ms: 1789750800000,
    timeseries: [{ t: 1789749264000, v: 81209.399 }, { t: 1789749265000, v: 81210.119 }, { t: 1789749266000, v: 81210.682 }],
  }, is_historical: false, range_options: ["15min", "1h", "3h"], type: "crypto" } };
  const s = shapeKalshiLiveData(btcLive, { eventTicker: "KXBTC-26SEP1813", limit: 200 });
  ok(s.type === "crypto" && s.coin === "BTC" && s.isHistorical === false && s.defaultRange === "1h", "live-data crypto: type, coin, is_historical and default_range ride through");
  ok(s.maturityTime === "2026-09-18T17:00:00.000Z", "live-data crypto: maturity_ts_ms becomes an ISO time");
  ok(s.seriesCount === 3 && s.series[2].value === 81210.682 && s.series[0].time === "2026-09-18T16:34:24.000Z", "live-data crypto: the {t, v} series is normalised to {time, value}");
  ok(s.latest && s.latest.value === 81210.682, "live-data crypto: latest is the newest series point");
  ok(s.candlesticks.length === 2 && s.candlesticks[0].interval === "15M" && s.candlesticks[0].count === 2 && s.candlesticks[0].candles[1].close === 81210.11 && s.candlesticks[0].candles[0].time === "2026-09-18T16:04:26.000Z", "live-data crypto: candlesticks become [{interval, count, candles:[{time, open, high, low, close}]}]");
  ok(!("timeseries" in s.details) && !("candlesticks" in s.details) && s.details.coin === "BTC" && s.details.maturity_ts_ms === 1789750800000, "live-data crypto: details carries the rest of the type's fields and not the two shaped arrays");
  const s2 = shapeKalshiLiveData(btcLive, { eventTicker: "KXBTC-26SEP1813", limit: 1 });
  ok(s2.seriesCount === 1 && s2.series[0].value === 81210.682 && s2.candlesticks[0].count === 1 && s2.candlesticks[0].candles[0].close === 81210.11, "live-data: limit keeps the NEWEST points per series and per interval");

  // GET /live_data/events/KXCPI-26SEP (timeseries type: BLS CPI, monthly, labelled points, no range fields)
  const cpiLive = { live_data: { details: {
    default_period: "1y", event_ticker: "KXCPI-26SEP", frequency: "monthly", graph_type: "bar", is_historical: false,
    last_refreshed: "2026-09-18T16:33:45Z", latest_period: "2026-08-01", latest_value: 0.4, measure: "pct_change_1",
    period_end: "2026-09-30", period_pending: true, provider: "bls", selectable_periods: ["1y", "5y", "all"],
    series_id: "CUSR0000SA0", target_label: "September 2026", target_period: "2026-09-01",
    timeseries: [{ label: "June 2026", t: "2026-06-01", v: -0.4 }, { label: "July 2026", t: "2026-07-01", v: 0.1 }, { label: "August 2026", t: "2026-08-01", v: 0.4 }],
    unit: "%", y_axis_max: 1.03, y_axis_min: -0.53,
  }, type: "timeseries" } };
  const c = shapeKalshiLiveData(cpiLive, { eventTicker: "KXCPI-26SEP", limit: 200 });
  ok(c.type === "timeseries" && c.coin === null && c.maturityTime === null && c.defaultRange === null && c.rangeOptions.length === 0, "live-data timeseries: fields the type does not carry read null (or an empty list), never a fabricated value");
  ok(c.isHistorical === false, "live-data timeseries: is_historical is read from details when the top level lacks it");
  ok(c.seriesCount === 3 && c.series[0].time === "2026-06-01" && c.series[0].label === "June 2026" && c.series[2].value === 0.4, "live-data timeseries: string dates and labels ride through the series unchanged");
  ok(c.candlesticks.length === 0 && c.details.provider === "bls" && c.details.series_id === "CUSR0000SA0" && c.details.target_period === "2026-09-01", "live-data timeseries: no candlesticks, and the provider/series/target fields stay in details");
  const empty = shapeKalshiLiveData({ live_data: { type: "weather", details: {} } }, { eventTicker: "X", limit: 10 });
  ok(empty.seriesCount === 0 && empty.latest === null && empty.series.length === 0 && empty.candlesticks.length === 0 && empty.isHistorical === null, "live-data: a type with no arrays is an empty series with a null latest and a null is_historical");

  // GET /live_data/weather/miami?last_sec=...&detailed=true (one point) + /calibrations (one record)
  const wp = shapeWeatherPoint({ contributors: 5, status: "normal", t: 1789742040000, v: 86.36, stations: [{ code: "ok", received_at_ms: 1789742183062, source: "hf_asos", station_id: "KFLL1M", temp_f: 86 }] }, true);
  ok(wp.time === "2026-09-18T14:34:00.000Z" && wp.valueF === 86.36 && wp.contributors === 5 && wp.status === "normal", "weather point: t/v/contributors/status are shaped");
  ok(wp.stations.length === 1 && wp.stations[0].stationId === "KFLL1M" && wp.stations[0].tempF === 86 && wp.stations[0].code === "ok" && wp.stations[0].receivedAt === "2026-09-18T14:36:23.062Z", "weather point: detailed station rows carry station id, reading, QC code and receipt time");
  ok(!("stations" in shapeWeatherPoint({ t: 1, v: 2, stations: [{ station_id: "X" }] }, false)), "weather point: stations are dropped unless detailed was asked for");
  ok(shapeWeatherPoint({ t: 1789742040000 }, false).valueF === null && shapeWeatherPoint({ t: 1789742040000 }, false).contributors === null, "weather point: an absent value reads null, never 0");
  const cal = shapeWeatherCalibration({ calibration_window_end_ms: 1786924800000, calibration_window_start_ms: 1786320000000, change_reason: "weekly offset calibration", city_reference_c: -0.1, config_version: "miami-temperature-v1.0-cal-20260817", effective_at_ms: 1786925160000, published_at_ms: 1786925119661, stations: [{ offset_c: -0.5, station_id: "KOPF1M", update_note: "insufficient residuals", weight: 0.2 }] });
  ok(cal.configVersion === "miami-temperature-v1.0-cal-20260817" && cal.cityReferenceC === -0.1 && cal.effectiveAt === "2026-08-17T00:06:00.000Z" && cal.calibrationWindow.start === "2026-08-10T00:00:00.000Z", "weather calibration: version, reference, effective time and window are shaped");
  ok(cal.stations[0].stationId === "KOPF1M" && cal.stations[0].offsetC === -0.5 && cal.stations[0].weight === 0.2 && cal.stations[0].updateNote === "insufficient residuals", "weather calibration: station weights and offsets ride through");
  ok(Array.isArray(WEATHER_CITIES) && WEATHER_CITIES.includes("miami") && WEATHER_CITIES.includes("nyc") && WEATHER_CITIES.length === 13, "the supported-cities hint matches the 13 cities Kalshi named on 2026-09-18");

  // Validation: every refusal happens before any egress.
  const realFetch = globalThis.fetch;
  let egress = 0;
  globalThis.fetch = async () => { egress++; throw new Error("no egress expected"); };
  await throws(h("kalshi-live-data")({}), 400, "kalshi-live-data: neither eventTicker nor seriesTicker");
  await throws(h("kalshi-live-data")({ eventTicker: "bad ticker!" }), 400, "kalshi-live-data: malformed eventTicker");
  await throws(h("kalshi-live-data")({ seriesTicker: "KXBTC", range: "2h" }), 400, "kalshi-live-data: unknown range");
  await throws(h("kalshi-weather-index")({}), 400, "kalshi-weather-index: missing city");
  await throws(h("kalshi-weather-index")({ city: "Mia mi" }), 400, "kalshi-weather-index: malformed city");
  await throws(h("kalshi-weather-index")({ city: "miami", from: 1 }), 400, "kalshi-weather-index: from without to");
  await throws(h("kalshi-weather-index")({ city: "miami", lastSec: 99999999 }), 400, "kalshi-weather-index: window over 7 days");
  ok(egress === 0, "every live_data refusal above happened before any egress");

  // Handler wiring against a stubbed Kalshi: series resolution, the query
  // string, the unknown-city 422 and the calibrations option.
  const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) }, json: async () => body, text: async () => JSON.stringify(body) });
  let urls = [];
  globalThis.fetch = async (url) => {
    const u = String(url); urls.push(u);
    if (u.includes("/events?")) return json({ events: [{ event_ticker: "KXBTC-26SEP1817", title: "BTC price range on Sep 18, 2026 at 5pm EDT?", strike_date: "2026-09-18T21:00:00Z" }] });
    if (u.includes("/live_data/events/KXBTC-26SEP1817")) return json(btcLive);
    if (u.includes("/live_data/weather/nowhere")) return json({ error: { code: "invalid_parameter:_unknown_weather_index_city_\"nowhere\"", message: "invalid parameter: unknown weather index city \"nowhere\"; supported cities: [miami]" } }, 400);
    if (u.includes("/live_data/weather/miami/calibrations")) return json({ city: "miami", units: "celsius", calibrations: [{ config_version: "miami-temperature-v1.0", effective_at_ms: 1786665600000, city_reference_c: -0.1, stations: [] }] });
    if (u.includes("/live_data/weather/miami")) return json({ city: "miami", config_version: "miami-temperature-v1.0-cal-20260914", units: "fahrenheit", timeseries: [{ contributors: 5, status: "normal", t: 1789748280000, v: 85.28 }, { contributors: 5, status: "normal", t: 1789748340000, v: 84.92 }] });
    return json({ error: "unexpected" }, 404);
  };
  let r = await h("kalshi-live-data")({ seriesTicker: "kxbtc", range: "15min", limit: 2 });
  ok(urls[0].includes("/events?series_ticker=KXBTC&status=open&limit=1"), "kalshi-live-data: a series ticker resolves the soonest open event with one events call");
  ok(urls[1].endsWith("/live_data/events/KXBTC-26SEP1817?range=15min"), `kalshi-live-data: the live_data call carries the resolved ticker and the range (${urls[1]})`);
  ok(r.eventTicker === "KXBTC-26SEP1813" && r.resolvedFrom.seriesTicker === "KXBTC" && r.resolvedFrom.title.includes("BTC price") && r.range === "15min" && r.source === "kalshi", "kalshi-live-data: the answer names what it resolved from");
  ok(r.seriesCount === 2 && r.candlesticks[0].count === 2, "kalshi-live-data: limit applies through the handler");
  urls = [];
  r = await h("kalshi-weather-index")({ city: "MIAMI", lastSec: 120, includeCalibrations: true });
  ok(urls[0].endsWith("/live_data/weather/miami?last_sec=120") && urls[1].endsWith("/live_data/weather/miami/calibrations"), `kalshi-weather-index: city is lowercased, last_sec is sent, calibrations are a second call only when asked (${urls.join(" ")})`);
  ok(r.city === "miami" && r.units === "fahrenheit" && r.count === 2 && r.totalInWindow === 2 && r.latest.valueF === 84.92 && r.minF === 84.92 && r.maxF === 85.28 && r.configVersion === "miami-temperature-v1.0-cal-20260914", "kalshi-weather-index: count, latest, min and max come from the window");
  ok(r.calibrations.length === 1 && r.calibrations[0].configVersion === "miami-temperature-v1.0" && r.calibrationUnits === "celsius", "kalshi-weather-index: includeCalibrations appends the shaped timeline");
  urls = [];
  r = await h("kalshi-weather-index")({ city: "miami", from: 1789748280000, to: 1789748340000, detailed: true });
  ok(urls[0].includes("from=1789748280000&to=1789748340000&detailed=true") && urls.length === 1 && !("calibrations" in r), "kalshi-weather-index: from/to/detailed ride the query and no calibrations call is made unless asked");
  try { await h("kalshi-weather-index")({ city: "nowhere" }); ok(false, "kalshi-weather-index: unknown city did not throw"); }
  catch (e) { ok(e.statusCode === 422 && /supported cities: miami/.test(e.message), `kalshi-weather-index: a city Kalshi does not index is a 422 naming the supported cities (${e.statusCode}: ${e.message.slice(0, 60)})`); }
  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
