// The weather calculators (src/tools/weather-calc-kit.js): published formulas
// over the caller's own numbers, checked against published values. Offline,
// and the kit makes no network call: fetch is replaced by a counter.
//
//   sun-times         against almanac times for two places; polar day and night
//   heat-index-calc   against cells of the NWS heat index and wind chill charts
//   aqi-calc          against the EPA breakpoint tables' edges
//   degree-days-calc  by hand
//   wmo-weather-code  against the forecast kit's own table
//   Every tool: free tier, a 400 that names the field for input it cannot
//   read, never a 500.
//
//   node scripts/test-weather-calc-kit.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

let egress = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { egress++; throw new Error("the weather calculators must not fetch"); };

const { WEATHER_CALC_TOOLS, subIndex } = await import("../src/tools/weather-calc-kit.js");
const { WMO_CODES } = await import("../src/tools/weather-kit.js");
const { FREE_TIER_SLUGS } = await import("../src/free-tier.js");
const { isComputePayable, WALLET_ONLY_SLUGS } = await import("../src/pow.js");
const run = (slug, input) => WEATHER_CALC_TOOLS.find((t) => t.slug === slug).handler(input);
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const minutesApart = (iso, want) => Math.abs(Date.parse(iso) - Date.parse(want)) / 60000;

// --- sun-times ---
{
  // New York City, 2026-06-21: sunrise 05:25 EDT, sunset 20:31 EDT, solar noon 12:58 EDT.
  let o = await run("sun-times", { lat: 40.7128, lon: -74.006, date: "2026-06-21" });
  ok(minutesApart(o.sunrise, "2026-06-21T09:25:00Z") <= 2 && minutesApart(o.sunset, "2026-06-22T00:31:00Z") <= 2 && minutesApart(o.solarNoon, "2026-06-21T16:58:00Z") <= 2, `sun-times: New York at the June solstice within two minutes of the almanac (${o.sunrise}, ${o.sunset})`);
  ok(Math.abs(o.dayLengthMinutes - 906) <= 2 && Math.abs(o.noonElevation - 72.7) < 0.2, "sun-times: day length and noon elevation there");
  ok(o.civilDawn < o.sunrise && o.nauticalDawn < o.civilDawn && o.astronomicalDawn < o.nauticalDawn && o.civilDusk > o.sunset && o.nauticalDusk > o.civilDusk && o.astronomicalDusk > o.nauticalDusk, "sun-times: the three twilights sit outside sunrise and sunset in order");
  // Greenwich at the March equinox: sunrise about 06:03, sunset about 18:13 UTC.
  o = await run("sun-times", { lat: 51.4779, lon: 0, date: "2026-03-20" });
  ok(minutesApart(o.sunrise, "2026-03-20T06:03:00Z") <= 2 && minutesApart(o.sunset, "2026-03-20T18:13:00Z") <= 2, `sun-times: Greenwich at the equinox (${o.sunrise}, ${o.sunset})`);
  // Sydney, 2026-12-21 (southern summer): sunrise 05:41 AEDT = 18:41 UTC the day before.
  o = await run("sun-times", { lat: -33.8688, lon: 151.2093, date: "2026-12-21" });
  ok(minutesApart(o.sunrise, "2026-12-20T18:41:00Z") <= 3 && minutesApart(o.sunset, "2026-12-21T09:05:00Z") <= 3, `sun-times: Sydney at the December solstice (${o.sunrise}, ${o.sunset})`);
  o = await run("sun-times", { lat: 78.22, lon: 15.65, date: "2026-06-21" });
  ok(o.sunrise === null && o.sunset === null && o.dayLengthMinutes === 1440 && /polar day/.test(o.note), "sun-times: midsummer in Svalbard is polar day, said in a note");
  o = await run("sun-times", { lat: 78.22, lon: 15.65, date: "2026-12-21" });
  ok(o.sunrise === null && o.dayLengthMinutes === 0 && /polar night/.test(o.note), "sun-times: midwinter there is polar night");
  // Position: at solar noon the sun is due south (north of the tropics) at the noon elevation.
  const noon = (await run("sun-times", { lat: 40.7128, lon: -74.006, date: "2026-06-21" })).solarNoon;
  o = await run("sun-times", { lat: 40.7128, lon: -74.006, date: "2026-06-21", time: noon });
  ok(Math.abs(o.position.azimuth - 180) < 1 && Math.abs(o.position.elevation - o.noonElevation) < 0.1, `sun-times: at solar noon the sun is due south at the noon elevation (${JSON.stringify(o.position)})`);
  o = await run("sun-times", { lat: 40.7128, lon: -74.006, date: "2026-06-21", time: "2026-06-21T05:00:00Z" });
  ok(o.position.elevation < 0, "sun-times: the sun is below the horizon at local midnight");
  o = await run("sun-times", { lat: "40.7", lon: "-74" });
  ok(/^\d{4}-\d{2}-\d{2}$/.test(o.date) && typeof o.sunrise === "string", "sun-times: numeric strings are read (a GET query) and the date defaults to today");
  for (const [bad, word] of [[{ lon: 1 }, "lat"], [{ lat: 1 }, "lon"], [{ lat: 91, lon: 0 }, "lat"], [{ lat: 1, lon: 2, date: "tomorrow" }, "date"], [{ lat: 1, lon: 2, date: "2026-02-30" }, "date"], [{ lat: 1, lon: 2, date: "0001-01-01" }, "date"], [{ lat: 1, lon: 2, time: "noonish" }, "time"], [{ lat: "1e999", lon: 2 }, "lat"], [{ lat: [1], lon: 2 }, "lat"], [{ lat: 1, lon: 2, time: { toString: 1 } }, "time"]]) {
    const e = await errOf(() => run("sun-times", bad));
    ok(e?.statusCode === 400 && e.message.includes(`"${word}"`), `sun-times: ${JSON.stringify(bad)} is a 400 naming ${word}`);
  }
}

// --- heat-index-calc ---
{
  // NWS heat index chart cells (°F, % RH -> °F).
  for (const [t, rh, want] of [[96, 65, 121], [90, 70, 105], [88, 40, 88], [100, 50, 118], [84, 90, 98]]) {
    const o = await run("heat-index-calc", { temperature: t, humidity: rh, units: "fahrenheit" });
    ok(Math.abs(o.heatIndex - want) <= 1, `heat-index-calc: ${t} F at ${rh}% is ${want} on the NWS chart (got ${o.heatIndex})`);
  }
  // The two NWS adjustments to the regression: 80 F at 95% is 86.4 plus 1.4
  // (humid air, 80-87 F); 100 F at 10% is 94.8 less 0.6 (dry air, 80-112 F).
  ok((await run("heat-index-calc", { temperature: 80, humidity: 95, units: "f" })).heatIndex === 87.8, "heat-index-calc: the high-humidity adjustment is applied (80 F at 95% -> 87.8)");
  ok((await run("heat-index-calc", { temperature: 100, humidity: 10, units: "f" })).heatIndex === 94.1, "heat-index-calc: the low-humidity adjustment is applied (100 F at 10% -> 94.1)");
  // Past the chart the regression extrapolates (150 F at 100% reads 802 F):
  // no number, a field that says so, and the band only inside the air range.
  {
    const hot = await run("heat-index-calc", { temperature: 150, humidity: 100, units: "f" });
    ok(hot.heatIndex === null && hot.heatIndexOutsideChart === true && hot.heatIndexBand === null && /not valid/.test(hot.heatIndexNote), `heat-index-calc: 150 F at 100% gives no heat index and says it is past the chart (${JSON.stringify({ hi: hot.heatIndex, band: hot.heatIndexBand })})`);
    const humid = await run("heat-index-calc", { temperature: 106, humidity: 70, units: "f" });
    ok(humid.heatIndex === null && humid.heatIndexOutsideChart === true && humid.heatIndexBand === "Extreme Danger", "heat-index-calc: 106 F at 70% is past the chart's top cell: no number, the Extreme Danger band");
    const top = await run("heat-index-calc", { temperature: 110, humidity: 40, units: "f" });
    ok(Math.abs(top.heatIndex - 136) <= 1 && top.heatIndexOutsideChart === undefined, `heat-index-calc: the chart's top cell (110 F at 40%) still reads its value (${top.heatIndex})`);
    const c = await run("heat-index-calc", { temperature: 60, humidity: 100 });
    ok(c.heatIndex === null && c.heatIndexOutsideChart === true, "heat-index-calc: in Celsius too (60 C is past the chart's air range)");
  }
  let o = await run("heat-index-calc", { temperature: 96, humidity: 65, units: "f" });
  ok(o.heatIndexBand === "Danger" && (await run("heat-index-calc", { temperature: 84, humidity: 40, units: "f" })).heatIndexBand === "Caution" && (await run("heat-index-calc", { temperature: 90, humidity: 60, units: "f" })).heatIndexBand === "Extreme Caution" && (await run("heat-index-calc", { temperature: 106, humidity: 70, units: "f" })).heatIndexBand === "Extreme Danger", "heat-index-calc: the chart's four published bands");
  // NWS wind chill chart cells (°F, mph -> °F).
  for (const [t, w, want] of [[20, 20, 4], [0, 15, -19], [40, 5, 36], [-10, 30, -39]]) {
    o = await run("heat-index-calc", { temperature: t, humidity: 50, windSpeed: w, units: "fahrenheit" });
    ok(Math.abs(o.windChill - want) <= 1, `heat-index-calc: ${t} F with ${w} mph wind chills to ${want} (got ${o.windChill})`);
  }
  o = await run("heat-index-calc", { temperature: 20, humidity: 40, windSpeed: 20, units: "fahrenheit" });
  ok(o.heatIndex === null && /80 °F/.test(o.heatIndexNote) && !("heatIndexBand" in o), "heat-index-calc: no heat index below 80 F, with the reason");
  o = await run("heat-index-calc", { temperature: 35, humidity: 60, windSpeed: 10 });
  ok(o.windChill === null && /10 °C/.test(o.windChillNote) && o.unit === "°C" && o.windUnit === "km/h", "heat-index-calc: no wind chill in warm air, with the reason");
  ok(Math.abs(o.heatIndex - 45.1) < 0.3 && Math.abs(o.dewPoint - 26.1) < 0.2 && Math.abs(o.humidex - 48.5) < 0.6, `heat-index-calc: 35 C at 60% (heat index ${o.heatIndex}, dew point ${o.dewPoint}, humidex ${o.humidex})`);
  // Celsius and Fahrenheit agree on the same air.
  const c = await run("heat-index-calc", { temperature: 30, humidity: 70, windSpeed: 16.09344 });
  const f = await run("heat-index-calc", { temperature: 86, humidity: 70, windSpeed: 10, units: "fahrenheit" });
  ok(Math.abs((c.heatIndex * 9) / 5 + 32 - f.heatIndex) < 0.2 && Math.abs((c.dewPoint * 9) / 5 + 32 - f.dewPoint) < 0.2 && Math.abs((c.wetBulb * 9) / 5 + 32 - f.wetBulb) < 0.2, "heat-index-calc: the same air gives the same answers in either unit");
  // Stull's own worked example: 20 C at 50% -> 13.7 C.
  ok(Math.abs((await run("heat-index-calc", { temperature: 20, humidity: 50 })).wetBulb - 13.7) < 0.1, "heat-index-calc: wet bulb matches the published worked example (20 C, 50% -> 13.7 C)");
  o = await run("heat-index-calc", { temperature: 30, humidity: 100 });
  ok(Math.abs(o.dewPoint - 30) < 0.05, "heat-index-calc: at 100% humidity the dew point is the air temperature");
  for (const [bad, word] of [[{ humidity: 50 }, "temperature"], [{ temperature: 30 }, "humidity"], [{ temperature: 30, humidity: 0 }, "humidity"], [{ temperature: 30, humidity: 101 }, "humidity"], [{ temperature: 900, humidity: 50 }, "temperature"], [{ temperature: 30, humidity: 50, windSpeed: -1 }, "windSpeed"], [{ temperature: 30, humidity: 50, units: "kelvin" }, "units"], [{ temperature: "warm", humidity: 50 }, "temperature"], [{ temperature: 30, humidity: 50, units: {} }, "units"]]) {
    const e = await errOf(() => run("heat-index-calc", bad));
    ok(e?.statusCode === 400 && e.message.includes(`"${word}"`), `heat-index-calc: ${JSON.stringify(bad)} is a 400 naming ${word}`);
  }
}

// --- aqi-calc ---
{
  // Breakpoint edges from the EPA tables (PM2.5 as revised in 2024).
  for (const [key, c, want] of [["pm25", 0, 0], ["pm25", 9.0, 50], ["pm25", 9.1, 51], ["pm25", 35.4, 100], ["pm25", 35.5, 101], ["pm25", 55.4, 150], ["pm25", 125.4, 200], ["pm25", 225.4, 300], ["pm25", 325.4, 500],
    ["pm10", 54, 50], ["pm10", 55, 51], ["pm10", 154, 100], ["pm10", 604, 500], ["o3", 54, 50], ["o3", 70, 100], ["o3", 85, 150], ["o3", 200, 300],
    ["co", 4.4, 50], ["co", 9.4, 100], ["co", 50.4, 500], ["so2", 35, 50], ["so2", 75, 100], ["so2", 185, 150], ["no2", 53, 50], ["no2", 100, 100], ["no2", 2049, 500]]) {
    ok(subIndex(key, c).aqi === want, `aqi-calc: ${key} ${c} is AQI ${want} (got ${subIndex(key, c).aqi})`);
  }
  ok(subIndex("pm25", 9.09).aqi === 50 && subIndex("pm10", 54.9).aqi === 50 && subIndex("co", 4.49).aqi === 50, "aqi-calc: a concentration is truncated to the table's precision, not rounded");
  ok(subIndex("pm25", 22.2).aqi === 75, `aqi-calc: a mid-band value interpolates (22.2 -> 75, got ${subIndex("pm25", 22.2).aqi})`);
  let o = await run("aqi-calc", { pm25: 35.4, pm10: 80, o3: 60 });
  ok(o.aqi === 100 && o.dominantPollutant === "pm25" && o.category === "Moderate" && o.pollutants.length === 3 && o.pollutants[1].aqi === 63, "aqi-calc: the overall index is the highest sub-index, with the pollutant that sets it");
  o = await run("aqi-calc", { o3: 500, pm25: 1 });
  ok(o.aqi === 300 && o.pollutants.find((p) => p.pollutant === "o3").beyondScale === true && /1-hour/.test(o.pollutants.find((p) => p.pollutant === "o3").note), "aqi-calc: 8-hour ozone above its table holds at 300 and says the 1-hour table applies");
  o = await run("aqi-calc", { "pm2_5": "12" });
  ok(o.pollutants[0].pollutant === "pm25" && o.aqi === 56, "aqi-calc: pm2_5 is read as pm25, and a numeric string as a number");
  for (const [bad, word] of [[{}, "pm25"], [{ pm25: -1 }, "pm25"], [{ pm25: "lots" }, "pm25"], [{ co: 99999 }, "co"], [{ no2: { valueOf: 1 } }, "no2"]]) {
    const e = await errOf(() => run("aqi-calc", bad));
    ok(e?.statusCode === 400 && e.message.includes(word), `aqi-calc: ${JSON.stringify(bad)} is a 400 naming ${word}`);
  }
}

// --- degree-days-calc ---
{
  let o = await run("degree-days-calc", { days: [{ min: 8, max: 19 }, { min: 12, max: 24 }, { min: 15, max: 29 }], base: 18, growingBase: 10 });
  ok(o.totals.heatingDegreeDays === 4.5 && o.totals.coolingDegreeDays === 4 && o.totals.growingDegreeDays === 23.5 && o.days[0].mean === 13.5 && o.count === 3, "degree-days-calc: min/max pairs use their midpoint (4.5 heating, 4 cooling, 23.5 growing)");
  o = await run("degree-days-calc", { days: [40, 65, 90], units: "fahrenheit" });
  ok(o.base === 65 && o.growingBase === 50 && o.totals.heatingDegreeDays === 25 && o.totals.coolingDegreeDays === 25 && o.totals.growingDegreeDays === 55 && o.unit === "°F", "degree-days-calc: fahrenheit defaults are base 65 and growing base 50");
  o = await run("degree-days-calc", { days: [{ min: 60, max: 100 }], units: "fahrenheit", growingCap: 86 });
  ok(o.totals.growingDegreeDays === 23 && o.totals.coolingDegreeDays === 15, "degree-days-calc: the growing cap holds the day's max at 86 (growing 23) and leaves cooling alone");
  o = await run("degree-days-calc", { days: "10, 20,30" });
  ok(o.count === 3 && o.base === 18 && o.totals.heatingDegreeDays === 8 && o.totals.coolingDegreeDays === 14, "degree-days-calc: a comma list of means is read; celsius defaults to base 18");
  o = await run("degree-days-calc", { days: [{ mean: 5 }] });
  ok(o.totals.heatingDegreeDays === 13 && o.totals.growingDegreeDays === 0, "degree-days-calc: growing degree days never go below zero");
  for (const [bad, word] of [[{}, "days"], [{ days: [] }, "days"], [{ days: Array.from({ length: 401 }, () => 1) }, "at most"], [{ days: [{ min: 20, max: 10 }] }, "days[0]"], [{ days: [{ min: 1 }] }, "days[0].max"], [{ days: ["hot"] }, "days[0]"], [{ days: [1], base: 999 }, "base"], [{ days: [1], growingBase: 20, growingCap: 10 }, "growingCap"], [{ days: [null] }, "days[0]"], [{ days: [{ toString: 1 }] }, "days[0]"]]) {
    const e = await errOf(() => run("degree-days-calc", bad));
    ok(e?.statusCode === 400 && e.message.includes(word), `degree-days-calc: ${JSON.stringify(bad).slice(0, 50)} is a 400 (${word})`);
  }
}

// --- wmo-weather-code ---
{
  const all = await run("wmo-weather-code", {});
  ok(all.count === Object.keys(WMO_CODES).length && all.codes.every((r) => r.condition === WMO_CODES[r.code]), "wmo-weather-code: no code returns the forecast kit's whole table");
  const cat = async (code) => (await run("wmo-weather-code", { code })).category;
  ok((await cat(0)) === "clear" && (await cat(3)) === "cloudy" && (await cat(45)) === "fog" && (await cat(53)) === "drizzle" && (await cat(63)) === "rain" && (await cat(81)) === "rain" && (await cat(73)) === "snow" && (await cat(86)) === "snow" && (await cat(96)) === "thunderstorm", "wmo-weather-code: every group of codes has its category");
  const fr = await run("wmo-weather-code", { code: "67" });
  ok(fr.found === true && fr.freezing === true && fr.precipitation === true && fr.condition === "Heavy freezing rain" && (await run("wmo-weather-code", { code: 2 })).precipitation === false, "wmo-weather-code: freezing and precipitation flags");
  const miss = await run("wmo-weather-code", { code: 42 });
  ok(miss.found === false && miss.knownCodes.length === all.count && typeof miss.note === "string", "wmo-weather-code: a code outside the table says so and lists the known ones");
  for (const bad of [{ code: 100 }, { code: -1 }, { code: 1.5 }, { code: "rain" }, { code: {} }]) {
    const e = await errOf(() => run("wmo-weather-code", bad));
    ok(e?.statusCode === 400 && e.message.includes('"code"'), `wmo-weather-code: ${JSON.stringify(bad)} is a 400 naming code`);
  }
}

// --- every tool: free tier, its own example, no egress ---
for (const t of WEATHER_CALC_TOOLS) {
  ok(FREE_TIER_SLUGS.has(t.slug) && !WALLET_ONLY_SLUGS.has(t.slug) && isComputePayable(t), `${t.slug}: on the free tier`);
  ok(t.price === "$0.001" && !t.attribution && !t.modelBacked, `${t.slug}: priced at the free-companion price, no data source to credit`);
  const out = await t.handler(t.discovery.input);
  const want = t.discovery.output.example;
  ok(JSON.stringify(Object.keys(out).sort()) === JSON.stringify(Object.keys(want).sort()), `${t.slug}: the published example has the fields its own input returns`);
  ok(JSON.stringify(out) === JSON.stringify(want), `${t.slug}: the published example is exactly what its own input returns`);
}
ok(egress === 0, `no calculator made a network call (${egress})`);

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
