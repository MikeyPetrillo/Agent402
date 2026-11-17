// Place names, ensemble probabilities and forecast planning, offline.
// (src/tools/weather-kit.js, weather-probability-kit.js, weather-plan-kit.js)
//
//   1. place-lookup: a name, a qualifier after a comma, a trailing US state
//      code, a country filter; an honest zero; bad input is a 400 before any
//      read; the GeoNames credit rides the answer.
//   2. `place` on the weather tools: lat/lon win and make no lookup; a name
//      is resolved once and echoed; an unknown place is a 404; neither is a 400.
//   3. weather-probability: the share is a count of members across both
//      ensembles, per model and pooled; a range includes both ends; integer
//      rounding happens before the count; a model with an incomplete day is
//      left out and named; no complete model is a 422; negative hourly
//      precipitation reads as zero.
//   4. weather-market-brackets: every bracket's share and the caller's price
//      beside it, members outside every bracket counted, and no field or
//      sentence that compares or rates.
//   5. weather-market-board: one upstream read for every city, a built ladder
//      that covers every member, caller brackets and prices kept per city.
//   6. weather-window and weather-thresholds: runs of qualifying hours, the
//      reason when none fits, hours already past left out, rules evaluated
//      per hour.
//   7. Every tool here ends at a run's ceiling and is wallet-only.
//
//   node scripts/test-weather-probability.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { stubGuardResolver } from "./lib/guard-resolver-stub.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

delete process.env.OPEN_METEO_API_KEY;
const { WEATHER_TOOLS, lookupPlaces, resolveLocation, _resetPlaceCache, PLACE_CACHE_MAX } = await import("../src/tools/weather-kit.js");
const P = await import("../src/tools/weather-probability-kit.js");
const PLAN = await import("../src/tools/weather-plan-kit.js");
const { GEONAMES_ATTRIBUTION, ATTRIBUTIONS, attributionTailOf } = await import("../src/data-attribution.js");
const { WALLET_ONLY_SLUGS, isComputePayable } = await import("../src/pow.js");

const restoreResolver = stubGuardResolver((host, family) => (/(^|\.)open-meteo\.com$/.test(host) ? (family === 4 ? ["93.184.216.34"] : []) : undefined));
const fetched = [];
let reply = () => new Response("{}", { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  const r = await reply(new URL(String(url)));
  Object.defineProperty(r, "url", { value: String(url) });
  return r;
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tool = (slug) => [...WEATHER_TOOLS, ...P.WEATHER_PROBABILITY_TOOLS, ...PLAN.WEATHER_PLAN_TOOLS].find((t) => t.slug === slug);
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---------------------------------------------------------------------------
// 1. place-lookup
// ---------------------------------------------------------------------------
const PLACES = [
  { name: "Springfield", latitude: 37.2, longitude: -93.3, country: "United States", country_code: "US", admin1: "Missouri", admin2: "Greene", timezone: "America/Chicago", population: 169000, postcodes: Array.from({ length: 30 }, (_, k) => String(65800 + k)) },
  { name: "Springfield", latitude: 39.8, longitude: -89.6, country: "United States", country_code: "US", admin1: "Illinois", admin2: "Sangamon", timezone: "America/Chicago", population: 114000 },
  { name: "Springfield", latitude: -27.6, longitude: 152.9, country: "Australia", country_code: "AU", admin1: "Queensland", timezone: "Australia/Brisbane", population: 8000 },
];
reply = (u) => (u.host === "geocoding-api.open-meteo.com" ? json(u.searchParams.get("name") === "Nowhere" ? { generationtime_ms: 1 } : { results: PLACES }) : json({}));
{
  const lookup = tool("place-lookup").handler;
  fetched.length = 0;
  let out = await lookup({ q: "Springfield", count: 2 });
  const u = new URL(fetched[0]);
  ok(fetched.length === 1 && u.host === "geocoding-api.open-meteo.com" && u.pathname === "/v1/search" && u.searchParams.get("name") === "Springfield" && u.searchParams.get("count") === "2", "place-lookup: one read of the geocoding API for the name and count");
  ok(out.found === true && out.count === 2 && out.results[0].region === "Missouri" && out.results[0].lat === 37.2 && out.results[0].lon === -93.3 && out.results[0].countryCode === "US", "place-lookup: results keep the upstream order, with lat/lon, region and country code");
  ok(out.results[0].postcodeCount === 30 && out.results[0].postcodes.length === 20, "place-lookup: a long postcode list is capped at 20 and its full count stated");
  ok(out.credit === GEONAMES_ATTRIBUTION && /GeoNames, CC BY 4\.0/.test(out.source), "place-lookup: the answer carries the GeoNames credit");
  out = await lookup({ q: "Springfield, IL" });
  ok(out.count === 1 && out.results[0].region === "Illinois", "place-lookup: a state code after a comma keeps only that state");
  out = await lookup({ q: "Springfield IL" });
  ok(out.count === 1 && out.results[0].region === "Illinois" && new URL(fetched.at(-1)).searchParams.get("name") === "Springfield", "place-lookup: a trailing US state code with no comma is a qualifier, not part of the name");
  out = await lookup({ q: "Springfield, Australia" });
  ok(out.count === 1 && out.results[0].countryCode === "AU", "place-lookup: a country name after a comma keeps only that country");
  out = await lookup({ q: "Springfield, Texas" });
  ok(out.found === false && out.count === 0 && out.results.length === 0 && typeof out.note === "string", "place-lookup: a qualifier no result carries is an honest zero with a note, never another Springfield");
  await lookup({ q: "Springfield", country: "au" });
  ok(new URL(fetched.at(-1)).searchParams.get("countryCode") === "AU", "place-lookup: the country filter is sent upper-cased");
  out = await lookup({ q: "Nowhere" });
  ok(out.found === false && out.count === 0, "place-lookup: an upstream answer with no results is an honest zero");
  fetched.length = 0;
  for (const [bad, field] of [[{ q: "a" }, "q"], [{ q: "x".repeat(101) }, "q"], [{}, "q"], [{ q: { toString: 1 } }, "q"], [{ q: "Paris", country: "FRA" }, "country"], [{ q: "Paris", language: "english" }, "language"]]) {
    const e = await errOf(() => lookup(bad));
    ok(e?.statusCode === 400 && e.message.includes(`"${field}"`), `place-lookup: ${JSON.stringify(bad).slice(0, 40)} is a 400 naming ${field}`);
  }
  ok(fetched.length === 0, "place-lookup: a refused input makes no upstream read");
  // A place read is kept briefly, hit or miss: the same name asked again makes no upstream read.
  _resetPlaceCache();
  fetched.length = 0;
  await lookup({ q: "Springfield", count: 2 }); await lookup({ q: "springfield", count: 2 });
  ok(fetched.length === 1, `place-lookup: the same name asked twice is one upstream read (${fetched.length})`);
  await lookup({ q: "Nowhere" }); const again = await lookup({ q: "Nowhere" });
  ok(fetched.length === 2 && again.found === false, `place-lookup: a name with no match is remembered too (${fetched.length} reads)`);
  await lookup({ q: "Springfield", count: 3 }); await lookup({ q: "Springfield", count: 2, country: "US" });
  ok(fetched.length === 4, "place-lookup: another count or country is another entry");
  reply = () => json({}, 503);
  const failed = await errOf(() => lookup({ q: "Outage City" }));
  reply = (u) => json(u.searchParams.get("name") === "Nowhere" ? {} : { results: PLACES });
  const after = await lookup({ q: "Outage City" });
  ok(failed && failed.statusCode >= 500 && after.found === true, "place-lookup: a failed read is not remembered");
  _resetPlaceCache();
  for (let k = 0; k < PLACE_CACHE_MAX + 5; k++) await lookup({ q: `Town ${k}` });
  fetched.length = 0;
  await lookup({ q: "Town 0" }); await lookup({ q: `Town ${PLACE_CACHE_MAX + 4}` });
  ok(fetched.length === 1, `place-lookup: the kept set is bounded at ${PLACE_CACHE_MAX}, oldest dropped first`);
  _resetPlaceCache();
  const t = tool("place-lookup");
  ok(t.attribution === "geonames" && attributionTailOf(t.description) === ATTRIBUTIONS.geonames && t.price === "$0.001", "place-lookup: GeoNames attribution on the listing, listed at its decided price");
}

// ---------------------------------------------------------------------------
// 2. `place` on the weather tools
// ---------------------------------------------------------------------------
{
  const FORECAST = { current: { time: "2026-01-01T00:00", temperature_2m: 1, weather_code: 0 } };
  _resetPlaceCache();
  reply = (u) => (u.host === "geocoding-api.open-meteo.com" ? json(u.searchParams.get("name") === "Nowhere" ? {} : { results: PLACES }) : json(FORECAST));
  fetched.length = 0;
  let out = await tool("weather-current").handler({ lat: 1, lon: 2, place: "Springfield" });
  ok(fetched.length === 1 && new URL(fetched[0]).host === "api.open-meteo.com" && out.lat === 1 && out.place === undefined, "weather-current: lat/lon win over place and no lookup is made");
  fetched.length = 0;
  out = await tool("weather-current").handler({ place: "Springfield, IL" });
  const f = new URL(fetched[1]);
  ok(fetched.length === 2 && new URL(fetched[0]).host === "geocoding-api.open-meteo.com" && f.searchParams.get("latitude") === "39.8" && f.searchParams.get("longitude") === "-89.6", "weather-current: a place is resolved once and the forecast is read at its coordinates");
  ok(out.lat === 39.8 && out.lon === -89.6 && out.place?.name === "Springfield" && out.place.region === "Illinois" && out.place.timezone === "America/Chicago" && out.place.credit === GEONAMES_ATTRIBUTION, "weather-current: the answer echoes the resolved place with the GeoNames credit");
  let e = await errOf(() => tool("weather-current").handler({ place: "Nowhere" }));
  ok(e?.statusCode === 404 && /No place matched "Nowhere"/.test(e.message), "weather-current: an unknown place is a 404 that names it");
  e = await errOf(() => tool("weather-current").handler({}));
  ok(e?.statusCode === 400 && /"lat" and "lon", or a "place"/.test(e.message), "weather-current: no location is a 400 naming both ways to give one");
  e = await errOf(() => tool("weather-current").handler({ lat: 5, place: "Springfield" }));
  ok(e?.statusCode === 400 && /"lon"/.test(e.message), "weather-current: a lat with no lon is a 400, never a silent place lookup");
  e = await errOf(() => resolveLocation({ place: ["Paris"] }));
  ok(e?.statusCode === 400, "a place that is not text is a 400");
  for (const slug of ["weather-current", "weather-daily", "weather-hourly", "weather-history", "weather-air-quality"]) {
    const s = tool(slug).discovery.inputSchema;
    ok(Boolean(s.properties.place && s.properties.lat && s.properties.lon) && !s.required.includes("lat"), `${slug}: the schema offers place beside lat/lon and requires neither`);
  }
  ok((await lookupPlaces({ q: "Springfield", count: 99 })).results.length === 3 && new URL(fetched.at(-1)).searchParams.get("count") === "10", "lookupPlaces: count is held at 10");
}

// ---------------------------------------------------------------------------
// 3. weather-probability
// ---------------------------------------------------------------------------
// An ensemble body: `ecmwf` and `gefs` are arrays of per-member daily values;
// each member's 24 hours are flat at its value (so max = min = mean = value).
const hours = (v, n = 24) => Array.from({ length: n }, () => v);
function ensembleBody(variable, ecmwf, gefs, { gefsHours = 24, tz = "America/Chicago" } = {}) {
  const hourly = { time: Array.from({ length: 24 }, (_, h) => `2026-11-18T${String(h).padStart(2, "0")}:00`) };
  ecmwf.forEach((v, k) => { hourly[`${variable}${k ? `_member${String(k).padStart(2, "0")}` : ""}_ecmwf_ifs025_ensemble`] = Array.isArray(v) ? v : hours(v); });
  gefs.forEach((v, k) => { hourly[`${variable}${k ? `_member${String(k).padStart(2, "0")}` : ""}_ncep_gefs_seamless`] = Array.isArray(v) ? v : [...hours(v, gefsHours), ...Array.from({ length: 24 - gefsHours }, () => null)]; });
  return { latitude: 1, longitude: 2, timezone: tz, hourly };
}
const ECMWF = [38, 39, 40, 41, 42, 43];   // 6 members
const GEFS = [39.4, 39.6, 44, 45];          // 4 members
{
  const prob = tool("weather-probability").handler;
  reply = () => json(ensembleBody("temperature_2m", ECMWF, GEFS));
  fetched.length = 0;
  let out = await prob({ lat: 41.9, lon: -87.6, variable: "temperature_max", units: "fahrenheit", op: ">=", value: 40, date: P.targetDate() });
  const u = new URL(fetched[0]);
  ok(fetched.length === 1 && u.host === "ensemble-api.open-meteo.com" && u.pathname === "/v1/ensemble" && u.searchParams.get("hourly") === "temperature_2m" && u.searchParams.get("models") === "ecmwf_ifs025,gfs_seamless" && u.searchParams.get("start_date") === u.searchParams.get("end_date") && u.searchParams.get("temperature_unit") === "fahrenheit", "weather-probability: one read of both ensembles for the one date, in the asked unit");
  ok(out.members.total === 10 && out.members.meeting === 6 && out.probability === 0.6, `weather-probability: the share is members meeting over all members (${out.members.meeting}/${out.members.total} = ${out.probability})`);
  const [e1, g1] = out.members.byModel;
  ok(e1.model === "ECMWF IFS ensemble" && e1.members === 6 && e1.meeting === 4 && e1.probability === 0.6667 && g1.model === "NOAA GEFS ensemble" && g1.members === 4 && g1.meeting === 2 && g1.probability === 0.5, "weather-probability: each model's own count and share");
  ok(out.distribution.min === 38 && out.distribution.max === 45 && out.distribution.median === 40.5 && out.unit === "°F" && out.timezone === "America/Chicago", "weather-probability: the spread of member values, the unit and the timezone");
  ok(/computed from Open-Meteo ensemble data/.test(out.source) && /not calibrated/.test(out.method), "weather-probability: the answer says it is computed from Open-Meteo data and not station-calibrated");
  out = await prob({ lat: 1, lon: 2, min: 39, max: 40 });
  ok(out.members.meeting === 4 && out.condition.min === 39 && out.condition.max === 40, "weather-probability: a range includes both ends (39, 39.4, 39.6, 40)");
  out = await prob({ lat: 1, lon: 2, min: 39, max: 40, rounding: "integer" });
  ok(out.members.meeting === 4 && out.rounding === "integer", "weather-probability: with integer rounding 39.4 counts as 39 and 39.6 as 40");
  out = await prob({ lat: 1, lon: 2, min: 39.5, max: 40, rounding: "integer" });
  ok(out.members.meeting === 2, "weather-probability: rounding is applied before the range (39.6 -> 40 is in, 39.4 -> 39 is out)");
  out = await prob({ lat: 1, lon: 2, op: "lt", value: 39 });
  ok(out.members.meeting === 1 && out.condition.op === "<", "weather-probability: the spelled comparison lt reads as <");
  // The operator is matched against the four listed ones only: a name every object inherits is not one.
  fetched.length = 0;
  for (const op of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "="]) {
    const e = await errOf(() => prob({ lat: 1, lon: 2, op, value: 40 }));
    ok(e?.statusCode === 400 && e.message.includes('"op"'), `weather-probability: op=${op} is a 400 naming op (${e?.statusCode ?? "answered 200"})`);
  }
  ok(fetched.length === 0, "weather-probability: an unknown operator makes no upstream read");
  // max / min / mean aggregate the member's own hours.
  const ramp = Array.from({ length: 24 }, (_, h) => h);
  reply = () => json(ensembleBody("temperature_2m", [ramp], [ramp]));
  ok((await prob({ lat: 1, lon: 2, variable: "temperature_max", value: 23 })).probability === 1 && (await prob({ lat: 1, lon: 2, variable: "temperature_min", op: "<=", value: 0 })).probability === 1 && (await prob({ lat: 1, lon: 2, variable: "temperature_mean", min: 11.5, max: 11.5 })).probability === 1, "weather-probability: max, min and mean are taken over each member's 24 hours");
  // An incomplete model is left out and named.
  reply = () => json(ensembleBody("temperature_2m", ECMWF, GEFS, { gefsHours: 10 }));
  out = await prob({ lat: 1, lon: 2, value: 40 });
  ok(out.members.total === 6 && out.members.byModel.length === 1 && out.modelsExcluded?.[0] === "NOAA GEFS ensemble" && typeof out.modelsExcludedNote === "string", "weather-probability: a model whose day is incomplete is left out of the count and named");
  reply = () => json(ensembleBody("temperature_2m", [hours(null)], [hours(null)]));
  let e = await errOf(() => prob({ lat: 1, lon: 2, value: 40 }));
  ok(e?.statusCode === 422 && /No ensemble has a complete forecast/.test(e.message), "weather-probability: no complete model for the date is a 422, not an empty probability");
  // Precipitation: a negative hour reads as zero, sums are per member.
  reply = () => json(ensembleBody("precipitation", [[...hours(0, 23), -0.3], hours(0.5)], [hours(0)]));
  out = await prob({ lat: 1, lon: 2, variable: "precipitation_sum", op: "<", value: 0 });
  ok(out.probability === 0 && out.distribution.min === 0 && out.distribution.max === 12 && out.unit === "mm", "weather-probability: a negative hourly precipitation reads as zero; the daily value is the sum");
  // Refusals before any read.
  fetched.length = 0;
  for (const [bad, word] of [[{ lat: 1, lon: 2 }, "threshold"], [{ lat: 1, lon: 2, value: 1, min: 0 }, "not both"], [{ lat: 1, lon: 2, min: 5, max: 1 }, "max"], [{ lat: 1, lon: 2, value: "hot" }, "value"], [{ lat: 1, lon: 2, value: 1, op: "~" }, "op"], [{ lat: 1, lon: 2, value: 1, variable: "humidity" }, "variable"], [{ lat: 1, lon: 2, value: 1, units: "kelvin" }, "units"], [{ lat: 1, lon: 2, value: 1, rounding: "up" }, "rounding"], [{ lat: 1, lon: 2, value: 1, date: "2031-01-01" }, "date"], [{ lat: 1, lon: 2, value: 1, date: "2026-02-30" }, "date"], [{ lat: 1, lon: 2, value: 1, date: 20261118 }, "date"]]) {
    e = await errOf(() => prob(bad));
    ok(e?.statusCode === 400 && e.message.includes(word), `weather-probability: ${JSON.stringify(bad).slice(15, 60)} is a 400 (${word})`);
  }
  ok(fetched.length === 0, "weather-probability: a refused input makes no upstream read");
  const now = Date.parse("2026-11-16T12:00:00Z");
  ok(P.targetDate(undefined, now) === "2026-11-17" && P.targetDate("2026-11-15", now) === "2026-11-15" && P.targetDate("2026-12-01", now) === "2026-12-01", "targetDate: tomorrow by default; yesterday through fifteen days ahead accepted");
  ok((await errOf(async () => P.targetDate("2026-12-02", now)))?.statusCode === 400 && (await errOf(async () => P.targetDate("2026-11-14", now)))?.statusCode === 400, "targetDate: a day past either end is a 400");
  ok(tool("weather-probability").price === "$0.01", "weather-probability: listed at its decided price");
}

// ---------------------------------------------------------------------------
// 4. weather-market-brackets
// ---------------------------------------------------------------------------
// Words that would turn two facts into a rating or advice.
const RATING_WORDS = /\b(edge|mispric\w*|underpric\w*|overpric\w*|undervalu\w*|overvalu\w*|arbitrage|opportunit\w*|buy|sell|bet|wager|should|recommend(?:ed|s)?|advice|advis\w*|rating|signal|alpha|profit\w*|diverg\w*|cheap|expensive|value bet)\b/i;
{
  const brackets = tool("weather-market-brackets").handler;
  reply = () => json(ensembleBody("temperature_2m", ECMWF, GEFS));
  const out = await brackets({ lat: 1, lon: 2, units: "fahrenheit", rounding: "integer", brackets: [{ label: "39 or below", max: 39, price: 0.1 }, { min: 40, max: 41, price: 0.35 }, { label: "44 up", min: 44 }] });
  ok(out.brackets.length === 3 && out.brackets[0].membersIn === 3 && out.brackets[0].forecastProbability === 0.3 && out.brackets[1].membersIn === 3 && out.brackets[2].membersIn === 2, `weather-market-brackets: each bracket's member count and share (${out.brackets.map((b) => b.membersIn).join(",")})`);
  ok(out.brackets[0].marketPrice === 0.1 && out.brackets[1].marketPrice === 0.35 && out.brackets[2].marketPrice === null, "weather-market-brackets: the caller's price is echoed beside each share, null where none was sent");
  ok(out.brackets[1].label === "40 to 41" && out.brackets[0].min === null && out.brackets[2].max === null, "weather-market-brackets: a bracket with no label is named by its ends; an open end stays null");
  ok(out.membersOutsideBrackets === 2 && out.members.total === 10, "weather-market-brackets: members in no bracket are counted (42 and 43)");
  ok(Object.keys(out.brackets[0]).sort().join() === "forecastProbability,label,marketPrice,max,membersIn,min", "weather-market-brackets: a bracket row holds the two facts and no field derived from comparing them");
  ok(/reads no market feed/.test(out.marketPriceNote) && /caller sent/.test(out.marketPriceNote), "weather-market-brackets: the answer says the price is the caller's and no market feed is read");
  const whole = JSON.stringify({ ...out, marketPriceNote: undefined });
  ok(!RATING_WORDS.test(whole), "weather-market-brackets: nothing in the answer rates or advises");
  ok(fetched.every((u) => /(^|\.)open-meteo\.com$/.test(new URL(u).host)), "weather-market-brackets: the only host read is Open-Meteo");
  fetched.length = 0;
  for (const [bad, word] of [[{ lat: 1, lon: 2 }, "brackets"], [{ lat: 1, lon: 2, brackets: [] }, "brackets"], [{ lat: 1, lon: 2, brackets: "nope" }, "brackets"], [{ lat: 1, lon: 2, brackets: [{}] }, "brackets[0]"], [{ lat: 1, lon: 2, brackets: [{ min: 5, max: 1 }] }, "brackets[0].max"], [{ lat: 1, lon: 2, brackets: [{ min: 1, price: 42 }] }, "brackets[0].price"], [{ lat: 1, lon: 2, brackets: [{ min: 1, price: -0.1 }] }, "brackets[0].price"], [{ lat: 1, lon: 2, brackets: [{ min: { toString: 1 } }] }, "brackets[0].min"], [{ lat: 1, lon: 2, brackets: Array.from({ length: P.MAX_BRACKETS + 1 }, () => ({ min: 1 })) }, "at most"]]) {
    const e = await errOf(() => brackets(bad));
    ok(e?.statusCode === 400 && e.message.includes(word), `weather-market-brackets: ${JSON.stringify(bad).slice(15, 55)} is a 400 (${word})`);
  }
  ok(fetched.length === 0, "weather-market-brackets: a refused input makes no upstream read");
  ok(tool("weather-market-brackets").price === "$0.02" && tool("weather-market-brackets").route.startsWith("POST "), "weather-market-brackets: listed at its decided price");
}

// ---------------------------------------------------------------------------
// 5. weather-market-board
// ---------------------------------------------------------------------------
{
  const board = tool("weather-market-board").handler;
  _resetPlaceCache();
  const cityBody = (shift) => ensembleBody("temperature_2m", ECMWF.map((v) => v + shift), GEFS.map((v) => v + shift), { tz: "America/New_York" });
  reply = (u) => {
    if (u.host === "geocoding-api.open-meteo.com") return json(u.searchParams.get("name") === "Nowhere" ? {} : { results: PLACES });
    const n = u.searchParams.get("latitude").split(",").length;
    return json(n === 1 ? cityBody(0) : Array.from({ length: n }, (_, k) => cityBody(k)));
  };
  fetched.length = 0;
  let out = await board({});
  const u = new URL(fetched[0]);
  ok(fetched.length === 1 && u.searchParams.get("latitude").split(",").length === P.DEFAULT_BOARD_CITIES.length && u.searchParams.get("temperature_unit") === "fahrenheit", `weather-market-board: the default board is one upstream read for ${P.DEFAULT_BOARD_CITIES.length} cities, in fahrenheit`);
  ok(out.count === P.DEFAULT_BOARD_CITIES.length && out.cities[0].label === "New York" && out.cities[1].distribution.min === out.cities[0].distribution.min + 1, "weather-market-board: each city carries its own members, in the order asked");
  const sums = out.cities.map((c) => c.brackets.reduce((n, b) => n + b.membersIn, 0));
  ok(sums.every((n) => n === 10) && out.cities.every((c) => c.membersOutsideBrackets === 0), "weather-market-board: a built ladder covers every member exactly once");
  const first = out.cities[0].brackets;
  ok(first[0].min === null && first.at(-1).max === null && first.slice(1, -1).every((b, k, a) => b.max - b.min === 1 && (k === 0 || b.min === a[k - 1].max + 1)), "weather-market-board: the ladder is open at both ends with whole-unit steps of the default width and no gap");
  ok(first.every((b) => !("marketPrice" in b)), "weather-market-board: a built ladder carries no market price");
  ok(!RATING_WORDS.test(JSON.stringify({ ...out, marketPriceNote: undefined })) && /city-center point/.test(out.citiesNote), "weather-market-board: nothing rates or advises, and the default cities say they are city-center points");
  fetched.length = 0;
  out = await board({ units: "celsius", width: 5, cities: [{ label: "Mine", place: "Springfield, IL" }, { lat: 10, lon: 20, brackets: [{ label: "all", min: -100, max: 100, price: 0.5 }] }] });
  ok(fetched.length === 2 && new URL(fetched[1]).searchParams.get("latitude") === "39.8,10" && new URL(fetched[1]).searchParams.get("temperature_unit") === "celsius", "weather-market-board: a named city is resolved, then every city is read in one call");
  ok(out.cities[0].label === "Mine" && out.cities[0].place?.region === "Illinois" && out.cities[1].label === "10,20" && out.cities[1].brackets.length === 1 && out.cities[1].brackets[0].forecastProbability === 1 && out.cities[1].brackets[0].marketPrice === 0.5, "weather-market-board: a city's own brackets and prices replace the built ladder for that city only");
  ok(out.cities[0].brackets.slice(1, -1).every((b) => b.max - b.min === 4), "weather-market-board: width sets the built ladder's step");
  fetched.length = 0;
  for (const [bad, word] of [[{ cities: [] }, "cities"], [{ cities: Array.from({ length: 21 }, () => ({ lat: 1, lon: 2 })) }, "at most 20"], [{ cities: [{ label: "x" }] }, "cities[0]"], [{ cities: [{ lat: 95, lon: 0 }] }, "cities[0]"], [{ cities: [{ lat: 1, lon: 2, brackets: [{ min: 1, price: 7 }] }] }, "cities[0]"], [{ width: 0 }, "width"], [{ variable: "snow" }, "variable"]]) {
    const e = await errOf(() => board(bad));
    ok(e?.statusCode === 400 && e.message.includes(word), `weather-market-board: ${JSON.stringify(bad).slice(0, 45)} is a 400 (${word})`);
  }
  ok(fetched.length === 0, "weather-market-board: a refused input makes no upstream read, a place lookup included");
  ok(P.MAX_BOARD_CITIES === 20 && (await board({ cities: Array.from({ length: 20 }, (_, k) => ({ lat: k, lon: 2 })) })).count === 20, "weather-market-board: twenty cities is the most one call takes, and twenty are answered");
  // A name that matches nothing ends the place reads there, and both the hits and the miss are remembered.
  _resetPlaceCache();
  fetched.length = 0;
  const named = Array.from({ length: 20 }, (_, k) => ({ place: k === 2 ? "Nowhere" : `Named City ${k}` }));
  let miss = await errOf(() => board({ cities: named }));
  ok(miss?.statusCode === 404 && miss.message.includes("cities[2]") && fetched.length === 3 && fetched.every((x) => new URL(x).host === "geocoding-api.open-meteo.com"), `weather-market-board: a name with no match is a 404 naming the entry, and no place after it is read (${fetched.length} reads)`);
  miss = await errOf(() => board({ cities: named }));
  ok(miss?.statusCode === 404 && fetched.length === 3, `weather-market-board: the same list sent again makes no upstream read (${fetched.length - 3} more)`);
  fetched.length = 0;
  const lastMiss = [...Array.from({ length: 19 }, (_, k) => ({ place: `Good City ${k}` })), { place: "Nowhere" }];
  await errOf(() => board({ cities: lastMiss })); await errOf(() => board({ cities: lastMiss })); await errOf(() => board({ cities: lastMiss }));
  ok(fetched.length === 19, `weather-market-board: 19 known names and one unknown, sent three times, read each known name once and the unknown never again (${fetched.length} reads)`);
  _resetPlaceCache();
  const ladder = P.ladderFor([0, 0, 0, 0.2, 3, 12], 5, { floorZero: true });
  ok(ladder[0].min === 0 && ladder.at(-1).max === null, "ladderFor: a value that cannot go below zero gets no bracket under zero");
  ok(tool("weather-market-board").price === "$0.10", "weather-market-board: listed at its decided price");
}

// ---------------------------------------------------------------------------
// 6. weather-window and weather-thresholds
// ---------------------------------------------------------------------------
{
  const T = Array.from({ length: 48 }, (_, h) => `2031-05-0${1 + Math.floor(h / 24)}T${String(h % 24).padStart(2, "0")}:00`);
  const day = (h) => (h % 24 >= 6 && h % 24 <= 18 ? 1 : 0);
  const hourly = {
    time: T,
    temperature_2m: T.map((_, h) => 10 + (h % 24)),
    precipitation_probability: T.map((_, h) => (h >= 10 && h <= 12 ? 80 : 5)),
    precipitation: T.map(() => 0),
    wind_speed_10m: T.map((_, h) => (h >= 30 ? 50 : 10)),
    wind_gusts_10m: T.map(() => 20),
    is_day: T.map((_, h) => day(h)),
    weather_code: T.map(() => 1),
  };
  const L = { maxPrecipProbability: 20, maxPrecipitation: null, maxWind: null, maxGusts: null, tempMin: null, tempMax: null, daylightOnly: true };
  let r = PLAN.findWindows(hourly, L, 3);
  ok(r.windows.length === 3 && r.windows[0].from === 6 && r.windows[0].to === 9 && r.windows[1].from === 13 && r.windows[1].to === 18 && r.windows[2].from === 30 && r.windows[2].to === 42, `findWindows: runs of qualifying hours split at a rainy stretch and at night (${JSON.stringify(r.windows)})`);
  ok(r.blockers.daylightOnly === 22 && r.blockers.maxPrecipProbability === 3, "findWindows: each ruled-out hour is counted under the limit that ruled it out");
  r = PLAN.findWindows(hourly, { ...L, maxWind: 30 }, 3);
  ok(r.windows.length === 2 && r.blockers.maxWind === 13, "findWindows: a wind limit removes the windy second day");
  r = PLAN.findWindows(hourly, L, 7);
  ok(r.windows.length === 1 && r.windows[0].from === 30, "findWindows: a run shorter than minHours is not a window");
  r = PLAN.findWindows({ ...hourly, precipitation_probability: T.map(() => null) }, L, 1);
  ok(r.windows.length === 0, "findWindows: an hour with no value for a limit does not meet it");
  r = PLAN.findWindows(hourly, L, 3, 14);
  ok(r.windows[0].from === 14 && r.windows[0].to === 18, "findWindows: hours before the starting index are not searched");
  ok(PLAN.firstHourFrom(T, Date.parse("2031-05-01T09:30:00Z"), 3600) === 10 && PLAN.firstHourFrom(T, Date.parse("2031-06-01T00:00:00Z"), 0) === 48, "firstHourFrom: the first hour at or after the current local hour");

  reply = () => json({ timezone: "Europe/Paris", utc_offset_seconds: 3600, hourly });
  const win = tool("weather-window").handler;
  let out = await win({ lat: 1, lon: 2, days: 2, minHours: 3 });
  ok(out.found === true && out.count === 3 && out.windows[0].hours === 13 && out.windows[0].start === T[30] && out.windows[0].maxWind === 50 && out.windows[0].tempMin === 16, "weather-window: windows are ranked longest first with their own temperature and wind");
  ok(new URL(fetched.at(-1)).searchParams.get("forecast_days") === "2" && /computed from Open-Meteo forecast data/.test(out.source), "weather-window: reads the forecast for the asked days and says it is computed from Open-Meteo data");
  out = await win({ lat: 1, lon: 2, days: 2, minHours: 24 });
  ok(out.found === false && out.count === 0 && out.windows.length === 0 && /daylightOnly ruled out the most hours/.test(out.noWindow.reason) && out.noWindow.hoursRuledOutBy.daylightOnly === 22, "weather-window: no window says so and names the limit that ruled out the most hours");
  for (const [bad, word] of [[{ lat: 1, lon: 2, days: 17 }, "days"], [{ lat: 1, lon: 2, minHours: 0 }, "minHours"], [{ lat: 1, lon: 2, maxPrecipProbability: 101 }, "maxPrecipProbability"], [{ lat: 1, lon: 2, tempMin: 30, tempMax: 10 }, "tempMax"], [{ lat: 1, lon: 2, daylightOnly: "maybe" }, "daylightOnly"]]) {
    const e = await errOf(() => win(bad));
    ok(e?.statusCode === 400 && e.message.includes(word), `weather-window: ${JSON.stringify(bad).slice(15, 50)} is a 400 (${word})`);
  }

  const thr = tool("weather-thresholds").handler;
  fetched.length = 0;
  out = await thr({ lat: 1, lon: 2, hours: 48, rules: [{ variable: "temperature", op: ">=", value: 30 }, { variable: "wind_speed", op: "<", value: 5 }, { variable: "uv_index", op: ">", value: 1 }] });
  const q = new URL(fetched[0]).searchParams;
  ok(q.get("hourly") === "temperature_2m,wind_speed_10m,uv_index" && q.get("forecast_hours") === "48", "weather-thresholds: only the variables the rules name are read");
  const [a, b, c] = out.rules;
  ok(a.met === true && a.firstAt === T[20] && a.lastAt === T[47] && a.hoursMet === 8 && a.highest.value === 33 && a.unit === "°C", `weather-thresholds: a met rule gives its first and last hour, the hours met and the highest value (${JSON.stringify(a)})`);
  ok(b.met === false && b.firstAt === null && b.hoursMet === 0 && b.lowest.value === 10 && b.unit === "km/h", "weather-thresholds: an unmet 'below' rule gives the lowest value it reached");
  ok(c.met === false && c.hoursRead === 0 && typeof c.note === "string" && out.anyMet === true && out.period.hours === 48, "weather-thresholds: a variable the forecast does not carry says so; anyMet and the period are stated");
  fetched.length = 0;
  for (const [bad, word] of [[{ lat: 1, lon: 2 }, "rules"], [{ lat: 1, lon: 2, rules: [{ variable: "vibes", op: ">", value: 1 }] }, "rules[0].variable"], [{ lat: 1, lon: 2, rules: [{ variable: "humidity", op: "=", value: 1 }] }, "rules[0].op"], [{ lat: 1, lon: 2, rules: [{ variable: "humidity", op: ">" }] }, "rules[0].value"], [{ lat: 1, lon: 2, rules: Array.from({ length: PLAN.MAX_RULES + 1 }, () => ({ variable: "humidity", op: ">", value: 1 })) }, "at most"], [{ lat: 1, lon: 2, hours: 500, rules: [{ variable: "humidity", op: ">", value: 1 }] }, "hours"]]) {
    const e = await errOf(() => thr(bad));
    ok(e?.statusCode === 400 && e.message.includes(word), `weather-thresholds: ${JSON.stringify(bad).slice(15, 60)} is a 400 (${word})`);
  }
  for (const op of ["constructor", "__proto__", "toString", "valueOf"]) {
    const e = await errOf(() => thr({ lat: 1, lon: 2, rules: [{ variable: "humidity", op, value: 1 }] }));
    ok(e?.statusCode === 400 && e.message.includes("rules[0].op"), `weather-thresholds: op=${op} is a 400 naming rules[0].op (${e?.statusCode ?? "answered 200"})`);
  }
  ok(fetched.length === 0, "weather-thresholds: a refused input makes no upstream read");
  ok(tool("weather-window").price === "$0.004" && tool("weather-thresholds").price === "$0.003", "weather-window and weather-thresholds: listed at their planned prices");
}

// ---------------------------------------------------------------------------
// 7. Ceiling marks, wallet-only, credits, wording
// ---------------------------------------------------------------------------
for (const slug of ["place-lookup", "weather-probability", "weather-market-brackets", "weather-market-board", "weather-window", "weather-thresholds"]) {
  const t = tool(slug);
  ok(t.endsAtCeiling === true, `${slug}: declares endsAtCeiling (every wait is a guarded fetch)`);
  ok(WALLET_ONLY_SLUGS.has(slug) && !isComputePayable(t), `${slug}: wallet-only, never proof-of-work`);
  if (slug !== "place-lookup") {
    ok(t.attribution === "open-meteo" && attributionTailOf(t.description) === ATTRIBUTIONS["open-meteo"] && t.description.length <= 500, `${slug}: the listing ends with the Open-Meteo attribution and fits a listing whole (${t.description.length} characters)`);
    ok(/^computed from Open-Meteo (ensemble|forecast) data/.test(t.discovery.output.example.source), `${slug}: the answer's source says it is computed from Open-Meteo data`);
    const prose = t.description.replace(/no rating or recommendation/g, "");
    ok(!RATING_WORDS.test(prose) && !RATING_WORDS.test(JSON.stringify(t.discovery.inputSchema)), `${slug}: the listing and schema carry no rating or advice wording`);
  }
  ok(!t.modelBacked, `${slug}: deterministic code, not model-backed`);
}
// The member count is a ceiling, not a constant: the two ensembles reach different horizons, so the
// last days of the range answer from one of them (the answer names the model left out).
{
  const { readFileSync } = await import("node:fs");
  const bare = /(?<!up to )(?<!all )\b82 (?:ensemble |forecast |ensemble forecast )?members|\(82 members/;
  ok(bare.test("from 82 ensemble members") && bare.test("(82 members, A and B)") && !bare.test("from up to 82 ensemble members") && !bare.test("all 82 members reach"), "control: the scan finds a bare member count and passes a ceiling");
  const surfaces = { "src/changelog.js": readFileSync(new URL("../src/changelog.js", import.meta.url), "utf8"), "CHANGELOG.md": readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").replace(/\s+/g, " "), "wiki/Tool-Catalog.md": readFileSync(new URL("../wiki/Tool-Catalog.md", import.meta.url), "utf8") };
  for (const slug of ["weather-probability", "weather-market-brackets", "weather-market-board"]) surfaces[`${slug} listing`] = `${tool(slug).description} ${JSON.stringify(tool(slug).discovery.inputSchema)}`;
  const stated = Object.entries(surfaces).filter(([, text]) => bare.test(text)).map(([name]) => name);
  ok(stated.length === 0, `no surface states the member count as a constant (${stated.join(", ") || "none"})`);
  ok(Object.values(surfaces).every((t) => /up to 82/.test(t)), "each surface says up to 82 members");
  const horizon = /about 13 days/;
  ok(horizon.test(tool("weather-probability").description) && horizon.test(surfaces["src/changelog.js"]) && horizon.test(surfaces["CHANGELOG.md"]) && ["weather-probability", "weather-market-brackets", "weather-market-board"].every((s) => horizon.test(tool(s).discovery.inputSchema.properties.date.description)), "where the 15-day range is stated, so is the shorter reach of the full set");
}
ok(/reads no market feed/.test(tool("weather-market-brackets").description) && /reads no market feed/.test(tool("weather-market-board").description), "the market tools' listings say the caller supplies brackets and prices and no market feed is read");

globalThis.fetch = realFetch;
restoreResolver();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
