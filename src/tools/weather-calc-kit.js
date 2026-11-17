// Weather calculators: published formulas over the caller's own numbers.
//   sun-times         sunrise, sunset, twilights, solar noon, sun elevation and azimuth
//   heat-index-calc   heat index, wind chill, humidex, dew point, wet bulb
//   aqi-calc          US EPA Air Quality Index from pollutant concentrations
//   degree-days-calc  heating, cooling and growing degree days from a series
//   wmo-weather-code  WMO weather code -> label and category
// All pure CPU: no network, no key, no model -> proof-of-work eligible
// (src/free-tier.js). Nothing here reads a forecast; the weather kit does.
import { WMO_CODES } from "./weather-kit.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// A number from a JSON number or a numeric string; anything else is a 400
// that names the field. `undefined`, null and "" read as absent.
function num(v, name, { min = -Infinity, max = Infinity, required = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) throw bad(`"${name}" is required (a number)`);
    return null;
  }
  if (typeof v !== "number" && typeof v !== "string") throw bad(`"${name}" must be a number`);
  if (typeof v === "string" && (v.length > 40 || !/^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(v))) throw bad(`"${name}" must be a number`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`"${name}" must be a number`);
  if (n < min || n > max) throw bad(`"${name}" must be between ${min} and ${max}`);
  return n;
}
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

function tempUnitOf(raw) {
  if (raw !== undefined && raw !== null && typeof raw !== "string") throw bad('"units" must be celsius or fahrenheit');
  const u = String(raw ?? "").trim().toLowerCase();
  if (u === "" || u === "celsius" || u === "c" || u === "metric") return "celsius";
  if (u === "fahrenheit" || u === "f" || u === "imperial") return "fahrenheit";
  throw bad('"units" must be celsius or fahrenheit');
}
const cToF = (c) => (c * 9) / 5 + 32;
const fToC = (f) => ((f - 32) * 5) / 9;

// ============================================================================
// sun-times: NOAA solar calculator equations (after Meeus, Astronomical
// Algorithms). Times are good to about a minute away from the poles.
// ============================================================================
const RAD = Math.PI / 180;
const julianDay = (ms) => ms / 86400000 + 2440587.5;

function solarCoords(jd) {
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) / RAD;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTime = 4 * (y * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD) + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) - 0.5 * y * y * Math.sin(4 * L0 * RAD) - 1.25 * e * e * Math.sin(2 * M * RAD)) / RAD;
  return { decl, eqTime };
}

// Hour angle (degrees) at which the sun's center sits `altitude` degrees
// above the horizon; null when it never does that day.
function hourAngle(lat, decl, altitude) {
  const cosH = (Math.sin(altitude * RAD) - Math.sin(lat * RAD) * Math.sin(decl * RAD)) / (Math.cos(lat * RAD) * Math.cos(decl * RAD));
  if (cosH > 1 || cosH < -1) return null;
  return Math.acos(cosH) / RAD;
}

function sunPosition(lat, lon, ms) {
  const { decl, eqTime } = solarCoords(julianDay(ms));
  const d = new Date(ms);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const trueSolar = (((minutes + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const ha = trueSolar / 4 - 180;
  const cosZenith = Math.sin(lat * RAD) * Math.sin(decl * RAD) + Math.cos(lat * RAD) * Math.cos(decl * RAD) * Math.cos(ha * RAD);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith))) / RAD;
  const sinZenith = Math.sin(zenith * RAD);
  let azimuth = 0;
  if (Math.abs(sinZenith) > 1e-9 && Math.abs(Math.cos(lat * RAD)) > 1e-9) {
    const cosAz = Math.min(1, Math.max(-1, (Math.sin(lat * RAD) * Math.cos(zenith * RAD) - Math.sin(decl * RAD)) / (Math.cos(lat * RAD) * sinZenith)));
    azimuth = ha > 0 ? (Math.acos(cosAz) / RAD + 180) % 360 : (540 - Math.acos(cosAz) / RAD) % 360;
  }
  return { elevation: r2(90 - zenith), azimuth: r2(azimuth) };
}

function sunTimes(lat, lon, date) {
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  // Solar noon near the meridian's local midday, then the events around it.
  const guess = dayStart + (720 - 4 * lon) * 60000;
  const { eqTime } = solarCoords(julianDay(guess));
  const noonMs = dayStart + (720 - 4 * lon - eqTime) * 60000;
  const { decl, eqTime: eq2 } = solarCoords(julianDay(noonMs));
  const noon = dayStart + (720 - 4 * lon - eq2) * 60000;
  const iso = (ms) => new Date(Math.round(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
  const pair = (altitude) => {
    const h = hourAngle(lat, decl, altitude);
    return h === null ? [null, null] : [iso(noon - h * 4 * 60000), iso(noon + h * 4 * 60000)];
  };
  const [sunrise, sunset] = pair(-0.833);
  const [civilDawn, civilDusk] = pair(-6);
  const [nauticalDawn, nauticalDusk] = pair(-12);
  const [astronomicalDawn, astronomicalDusk] = pair(-18);
  const h0 = hourAngle(lat, decl, -0.833);
  const noonElevation = 90 - Math.abs(lat - decl);
  const polar = h0 === null ? (noonElevation > -0.833 ? "polar day: the sun stays above the horizon" : "polar night: the sun stays below the horizon") : null;
  return {
    sunrise, sunset, solarNoon: iso(noon),
    dayLengthMinutes: h0 === null ? (noonElevation > -0.833 ? 1440 : 0) : Math.round(h0 * 8),
    civilDawn, civilDusk, nauticalDawn, nauticalDusk, astronomicalDawn, astronomicalDusk,
    noonElevation: r2(noonElevation),
    ...(polar ? { note: polar } : {}),
  };
}

function coordsOf(i) {
  const lat = num(i?.lat, "lat", { min: -90, max: 90, required: true });
  const lon = num(i?.lon, "lon", { min: -180, max: 180, required: true });
  return { lat, lon };
}

function dateOf(raw) {
  if (raw === undefined || raw === null || raw === "") return new Date().toISOString().slice(0, 10);
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) throw bad('"date" must be YYYY-MM-DD');
  const date = raw.trim();
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== date) throw bad('"date" is not a valid calendar date');
  const year = Number(date.slice(0, 4));
  if (year < 1900 || year > 2100) throw bad('"date" must be between 1900 and 2100');
  return date;
}

// ============================================================================
// heat-index-calc: US National Weather Service heat index (Rothfusz
// regression with the NWS adjustments) and wind chill (2001 NWS formula),
// Environment Canada humidex, Magnus dew point, Stull (2011) wet bulb.
// ============================================================================
function heatIndexF(T, RH) {
  const simple = 0.5 * (T + 61 + (T - 68) * 1.2 + RH * 0.094);
  if ((simple + T) / 2 < 80) return simple;
  let hi = -42.379 + 2.04901523 * T + 10.14333127 * RH - 0.22475541 * T * RH - 0.00683783 * T * T - 0.05481717 * RH * RH + 0.00122874 * T * T * RH + 0.00085282 * T * RH * RH - 0.00000199 * T * T * RH * RH;
  if (RH < 13 && T >= 80 && T <= 112) hi -= ((13 - RH) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
  else if (RH > 85 && T >= 80 && T <= 87) hi += ((RH - 85) / 10) * ((87 - T) / 5);
  return hi;
}
// The NWS heat index chart's four published bands (degrees Fahrenheit).
function heatBand(hiF) {
  if (hiF >= 125) return "Extreme Danger";
  if (hiF >= 103) return "Danger";
  if (hiF >= 90) return "Extreme Caution";
  if (hiF >= 80) return "Caution";
  return "Below Caution";
}
function dewPointC(tC, RH) {
  const a = 17.625, b = 243.04;
  const g = Math.log(RH / 100) + (a * tC) / (b + tC);
  return (b * g) / (a - g);
}
function wetBulbC(tC, RH) {
  return tC * Math.atan(0.151977 * Math.sqrt(RH + 8.313659)) + Math.atan(tC + RH) - Math.atan(RH - 1.676331) + 0.00391838 * RH ** 1.5 * Math.atan(0.023101 * RH) - 4.686035;
}

// ============================================================================
// aqi-calc: US EPA Air Quality Index. Breakpoints from 40 CFR Part 58
// Appendix G (PM2.5 as revised in 2024). Each concentration is truncated the
// way the rule states before the linear interpolation.
// ============================================================================
const AQI_BANDS = [[0, 50, "Good"], [51, 100, "Moderate"], [101, 150, "Unhealthy for Sensitive Groups"], [151, 200, "Unhealthy"], [201, 300, "Very Unhealthy"], [301, 500, "Hazardous"]];
const POLLUTANTS = Object.freeze({
  pm25: { label: "PM2.5", unit: "µg/m³", averaging: "24-hour", step: 0.1, max: 5000, bp: [[0, 9.0], [9.1, 35.4], [35.5, 55.4], [55.5, 125.4], [125.5, 225.4], [225.5, 325.4]] },
  pm10: { label: "PM10", unit: "µg/m³", averaging: "24-hour", step: 1, max: 10000, bp: [[0, 54], [55, 154], [155, 254], [255, 354], [355, 424], [425, 604]] },
  o3: { label: "Ozone", unit: "ppb", averaging: "8-hour", step: 1, max: 2000, bp: [[0, 54], [55, 70], [71, 85], [86, 105], [106, 200]], note: "8-hour ozone defines no AQI above 200 ppb (the 1-hour table applies there)" },
  co: { label: "Carbon monoxide", unit: "ppm", averaging: "8-hour", step: 0.1, max: 1000, bp: [[0, 4.4], [4.5, 9.4], [9.5, 12.4], [12.5, 15.4], [15.5, 30.4], [30.5, 50.4]] },
  so2: { label: "Sulfur dioxide", unit: "ppb", averaging: "1-hour", step: 1, max: 10000, bp: [[0, 35], [36, 75], [76, 185], [186, 304], [305, 604], [605, 1004]], note: "above 304 ppb the table is defined on 24-hour values" },
  no2: { label: "Nitrogen dioxide", unit: "ppb", averaging: "1-hour", step: 1, max: 10000, bp: [[0, 53], [54, 100], [101, 360], [361, 649], [650, 1249], [1250, 2049]] },
});
const POLLUTANT_NAMES = Object.keys(POLLUTANTS);
const aqiCategory = (aqi) => (AQI_BANDS.find(([lo, hi]) => aqi >= lo && aqi <= hi) ?? AQI_BANDS[AQI_BANDS.length - 1])[2];

export function subIndex(key, concentration) {
  const p = POLLUTANTS[key];
  // Truncate (not round) to the table's precision; the epsilon absorbs binary noise.
  const c = Math.floor(concentration / p.step + 1e-9) * p.step;
  const cT = Math.round(c * 1000) / 1000;
  for (let k = 0; k < p.bp.length; k++) {
    const [lo, hi] = p.bp[k];
    if (cT <= hi) {
      const [iLo, iHi] = AQI_BANDS[k];
      const aqi = Math.round(((iHi - iLo) / (hi - lo)) * (Math.max(cT, lo) - lo) + iLo);
      return { aqi, category: aqiCategory(aqi), beyondScale: false };
    }
  }
  const top = AQI_BANDS[p.bp.length - 1][1];
  return { aqi: top, category: aqiCategory(top), beyondScale: true };
}

// ============================================================================
// degree-days-calc
// ============================================================================
const MAX_DAYS = 400;
function dailyMeans(raw, tempUnit) {
  let list = raw;
  if (typeof list === "string") {
    if (list.length > 20000) throw bad('"days" is too long');
    try { list = JSON.parse(list); } catch { list = list.split(",").map((s) => s.trim()).filter(Boolean); }
  }
  if (!Array.isArray(list) || !list.length) throw bad('"days" is required: an array of daily mean temperatures, or of { min, max } pairs');
  if (list.length > MAX_DAYS) throw bad(`"days" takes at most ${MAX_DAYS} entries`);
  const lim = tempUnit === "fahrenheit" ? { min: -150, max: 160 } : { min: -100, max: 70 };
  return list.map((d, idx) => {
    if (d !== null && typeof d === "object" && !Array.isArray(d)) {
      if (d.mean !== undefined && d.mean !== null && d.mean !== "") return { mean: num(d.mean, `days[${idx}].mean`, lim), min: null, max: null };
      const min = num(d.min, `days[${idx}].min`, { ...lim, required: true }), max = num(d.max, `days[${idx}].max`, { ...lim, required: true });
      if (max < min) throw bad(`days[${idx}].max must be at least its min`);
      return { mean: (min + max) / 2, min, max };
    }
    return { mean: num(d, `days[${idx}]`, { ...lim, required: true }), min: null, max: null };
  });
}

// ============================================================================
// wmo-weather-code
// ============================================================================
function wmoCategory(code) {
  if (code <= 1) return "clear";
  if (code <= 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  return "thunderstorm";
}
const wmoRow = (code) => ({ code, condition: WMO_CODES[code], category: wmoCategory(code), freezing: [56, 57, 66, 67].includes(code), precipitation: code >= 51 });
const WMO_TABLE = Object.keys(WMO_CODES).map(Number).sort((a, b) => a - b).map(wmoRow);

export const WEATHER_CALC_TOOLS = [
  {
    route: "GET /api/sun-times",
    name: "Sun times (sunrise, sunset, twilight)",
    slug: "sun-times",
    category: "data",
    price: "$0.001",
    description:
      "Sunrise, sunset, solar noon, day length and the civil, nautical and astronomical twilights for any point and date, plus the sun's elevation and azimuth at a given time. Computed with the NOAA solar equations; times are UTC, good to about a minute away from the poles. Says so when the sun stays up or down all day. ?lat=40.71&lon=-74.01&date=2026-06-21",
    tags: ["sun", "sunrise", "sunset", "twilight", "solar", "daylight", "astronomy"],
    discovery: {
      input: { lat: 40.7128, lon: -74.006, date: "2026-06-21", time: "2026-06-21T16:00:00Z" },
      inputSchema: {
        properties: {
          lat: { type: "number", description: "Latitude, -90 to 90" },
          lon: { type: "number", description: "Longitude, -180 to 180" },
          date: { type: "string", description: "Date, YYYY-MM-DD (default today, UTC). Events are those around the point's solar noon on that date" },
          time: { type: "string", description: "Optional ISO 8601 time at which to give the sun's elevation and azimuth, for example 2026-06-21T16:00:00Z" },
        },
        required: ["lat", "lon"],
      },
      output: {
        example: {
          lat: 40.7128, lon: -74.006, date: "2026-06-21",
          sunrise: "2026-06-21T09:25:05Z", sunset: "2026-06-22T00:30:42Z", solarNoon: "2026-06-21T16:57:54Z",
          dayLengthMinutes: 906,
          civilDawn: "2026-06-21T08:51:40Z", civilDusk: "2026-06-22T01:04:07Z",
          nauticalDawn: "2026-06-21T08:09:00Z", nauticalDusk: "2026-06-22T01:46:47Z",
          astronomicalDawn: "2026-06-21T07:18:36Z", astronomicalDusk: "2026-06-22T02:37:12Z",
          noonElevation: 72.72,
          position: { time: "2026-06-21T16:00:00.000Z", elevation: 68.88, azimuth: 140.48 },
          timezone: "UTC",
          method: "NOAA solar equations",
        },
      },
    },
    handler: async (i) => {
      const { lat, lon } = coordsOf(i);
      const date = dateOf(i?.date);
      let position;
      if (i?.time !== undefined && i.time !== null && i.time !== "") {
        if (typeof i.time !== "string" || i.time.length > 40) throw bad('"time" must be an ISO 8601 time, for example 2026-06-21T16:00:00Z');
        const ms = Date.parse(i.time);
        if (!Number.isFinite(ms) || ms < Date.parse("1900-01-01T00:00:00Z") || ms > Date.parse("2101-01-01T00:00:00Z")) throw bad('"time" must be an ISO 8601 time between 1900 and 2100, for example 2026-06-21T16:00:00Z');
        position = { time: new Date(ms).toISOString(), ...sunPosition(lat, lon, ms) };
      }
      return { lat, lon, date, ...sunTimes(lat, lon, date), ...(position ? { position } : {}), timezone: "UTC", method: "NOAA solar equations" };
    },
  },
  {
    route: "GET /api/heat-index-calc",
    name: "Heat index and wind chill calculator",
    slug: "heat-index-calc",
    category: "data",
    price: "$0.001",
    description:
      "Heat index, wind chill, humidex, dew point and wet-bulb temperature from the temperature, humidity and wind you supply. Heat index and wind chill follow the US National Weather Service formulas, with the heat index chart's published band; humidex follows Environment Canada; wet bulb is the Stull approximation. Each value says when its formula does not apply. Celsius or Fahrenheit. ?temperature=35&humidity=60&windSpeed=10",
    tags: ["weather", "heat-index", "wind-chill", "humidex", "dew-point", "wet-bulb", "calculator"],
    discovery: {
      input: { temperature: 35, humidity: 60, windSpeed: 10 },
      inputSchema: {
        properties: {
          temperature: { type: "number", description: "Air temperature, in units" },
          humidity: { type: "number", description: "Relative humidity, 1-100 percent" },
          windSpeed: { type: "number", description: "Wind speed for wind chill: km/h, or mph with units=fahrenheit (optional)" },
          units: { type: "string", description: "celsius (default; wind in km/h) or fahrenheit (wind in mph)" },
        },
        required: ["temperature", "humidity"],
      },
      output: {
        example: {
          temperature: 35, humidity: 60, windSpeed: 10, unit: "°C", windUnit: "km/h",
          heatIndex: 45.1, heatIndexBand: "Danger",
          humidex: 48.5, dewPoint: 26.1, wetBulb: 28.5,
          windChill: null, windChillNote: "Wind chill is defined for 10 °C (50 °F) or colder with wind above 4.8 km/h (3 mph).",
          methods: { heatIndex: "US National Weather Service (Rothfusz regression with adjustments)", windChill: "US National Weather Service (2001)", humidex: "Environment Canada", dewPoint: "Magnus formula", wetBulb: "Stull (2011)" },
        },
      },
    },
    handler: async (i) => {
      const unit = tempUnitOf(i?.units);
      const F = unit === "fahrenheit";
      const t = num(i?.temperature ?? i?.temp, "temperature", { min: F ? -130 : -90, max: F ? 150 : 65, required: true });
      const rh = num(i?.humidity ?? i?.rh, "humidity", { min: 1, max: 100, required: true });
      const wind = num(i?.windSpeed ?? i?.wind, "windSpeed", { min: 0, max: 500 });
      const tF = F ? t : cToF(t), tC = F ? fToC(t) : t;
      const out = (c) => r1(F ? cToF(c) : c);
      const hiF = heatIndexF(tF, rh);
      const dewC = dewPointC(tC, rh);
      const humidexC = tC + 0.5555 * (6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / (273.15 + dewC))) - 10);
      const windMph = wind === null ? null : F ? wind : wind / 1.609344;
      const chillApplies = windMph !== null && tF <= 50 && windMph > 3;
      const chillF = chillApplies ? 35.74 + 0.6215 * tF - 35.75 * windMph ** 0.16 + 0.4275 * tF * windMph ** 0.16 : null;
      const wetBulbApplies = rh >= 5 && tC >= -20 && tC <= 50;
      return {
        temperature: t, humidity: rh, windSpeed: wind, unit: F ? "°F" : "°C", windUnit: F ? "mph" : "km/h",
        // The heat index is defined for warm air: below 80 °F it is not reported.
        heatIndex: tF >= 80 ? r1(F ? hiF : fToC(hiF)) : null,
        ...(tF >= 80 ? { heatIndexBand: heatBand(hiF) } : { heatIndexNote: "The heat index is defined for 27 °C (80 °F) or warmer." }),
        humidex: out(humidexC), dewPoint: out(dewC),
        wetBulb: wetBulbApplies ? out(wetBulbC(tC, rh)) : null,
        ...(wetBulbApplies ? {} : { wetBulbNote: "The wet-bulb approximation holds for 5-99% humidity and -20 to 50 °C." }),
        windChill: chillF === null ? null : r1(F ? chillF : fToC(chillF)),
        ...(chillApplies ? {} : { windChillNote: wind === null ? "Give windSpeed for wind chill." : "Wind chill is defined for 10 °C (50 °F) or colder with wind above 4.8 km/h (3 mph)." }),
        methods: { heatIndex: "US National Weather Service (Rothfusz regression with adjustments)", windChill: "US National Weather Service (2001)", humidex: "Environment Canada", dewPoint: "Magnus formula", wetBulb: "Stull (2011)" },
      };
    },
  },
  {
    route: "GET /api/aqi-calc",
    name: "AQI calculator (US EPA)",
    slug: "aqi-calc",
    category: "data",
    price: "$0.001",
    description:
      "US EPA Air Quality Index from the pollutant concentrations you supply: PM2.5 and PM10 (µg/m³, 24-hour), ozone (ppb, 8-hour), carbon monoxide (ppm, 8-hour), sulfur dioxide and nitrogen dioxide (ppb, 1-hour). Returns each pollutant's sub-index and category, the overall AQI (the highest sub-index) and the pollutant that sets it, using the published EPA breakpoint tables with the 2024 PM2.5 revision. ?pm25=35.4&o3=60",
    tags: ["aqi", "air-quality", "pm25", "ozone", "pollution", "epa", "calculator"],
    discovery: {
      input: { pm25: 35.4, pm10: 80, o3: 60 },
      inputSchema: {
        properties: {
          pm25: { type: "number", description: "PM2.5, µg/m³, 24-hour average" },
          pm10: { type: "number", description: "PM10, µg/m³, 24-hour average" },
          o3: { type: "number", description: "Ozone, ppb, 8-hour average" },
          co: { type: "number", description: "Carbon monoxide, ppm, 8-hour average" },
          so2: { type: "number", description: "Sulfur dioxide, ppb, 1-hour average" },
          no2: { type: "number", description: "Nitrogen dioxide, ppb, 1-hour average" },
        },
        required: [],
      },
      output: {
        example: {
          aqi: 100, category: "Moderate", dominantPollutant: "pm25",
          pollutants: [
            { pollutant: "pm25", name: "PM2.5", concentration: 35.4, unit: "µg/m³", averaging: "24-hour", aqi: 100, category: "Moderate" },
            { pollutant: "pm10", name: "PM10", concentration: 80, unit: "µg/m³", averaging: "24-hour", aqi: 63, category: "Moderate" },
            { pollutant: "o3", name: "Ozone", concentration: 60, unit: "ppb", averaging: "8-hour", aqi: 67, category: "Moderate" },
          ],
          scale: "US EPA Air Quality Index (40 CFR Part 58 Appendix G; PM2.5 breakpoints as revised in 2024)",
        },
      },
    },
    handler: async (i) => {
      const rows = [];
      for (const key of POLLUTANT_NAMES) {
        const p = POLLUTANTS[key];
        const c = num(i?.[key] ?? (key === "pm25" ? i?.["pm2_5"] ?? i?.["pm2.5"] : undefined), key, { min: 0, max: p.max });
        if (c === null) continue;
        const s = subIndex(key, c);
        rows.push({ pollutant: key, name: p.label, concentration: c, unit: p.unit, averaging: p.averaging, aqi: s.aqi, category: s.category, ...(s.beyondScale ? { beyondScale: true, note: p.note ?? "Above the table's highest breakpoint; the index is held at the top of the scale." } : {}) });
      }
      if (!rows.length) throw bad(`Give at least one concentration: ${POLLUTANT_NAMES.join(", ")}`);
      const top = rows.reduce((a, b) => (b.aqi > a.aqi ? b : a));
      return {
        aqi: top.aqi, category: top.category, dominantPollutant: top.pollutant,
        pollutants: rows,
        scale: "US EPA Air Quality Index (40 CFR Part 58 Appendix G; PM2.5 breakpoints as revised in 2024)",
      };
    },
  },
  {
    route: "POST /api/degree-days-calc",
    name: "Degree days calculator",
    slug: "degree-days-calc",
    category: "data",
    price: "$0.001",
    description:
      "Heating, cooling and growing degree days from a daily temperature series you supply: daily means, or min/max pairs (the mean is their midpoint). Heating and cooling use one base (default 18 °C or 65 °F); growing degree days use their own base (default 10 °C or 50 °F) and an optional upper cutoff applied to each day's min and max. Returns the totals and each day's values, for up to 400 days.",
    tags: ["degree-days", "hdd", "cdd", "gdd", "energy", "agriculture", "calculator"],
    discovery: {
      input: { days: [{ min: 8, max: 19 }, { min: 12, max: 24 }, { min: 15, max: 29 }], base: 18, growingBase: 10 },
      inputSchema: {
        properties: {
          days: { type: "array", description: "1-400 days: each a daily mean temperature (number), or { min, max }, or { mean }", items: {} },
          units: { type: "string", description: "celsius (default) or fahrenheit" },
          base: { type: "number", description: "Base for heating and cooling degree days (default 18 °C or 65 °F)" },
          growingBase: { type: "number", description: "Base for growing degree days (default 10 °C or 50 °F)" },
          growingCap: { type: "number", description: "Optional upper cutoff for growing degree days: each day's min and max are held at or below it" },
        },
        required: ["days"],
      },
      output: {
        example: {
          count: 3, unit: "°C", base: 18, growingBase: 10, growingCap: null,
          totals: { heatingDegreeDays: 4.5, coolingDegreeDays: 4, growingDegreeDays: 23.5 },
          days: [
            { mean: 13.5, heating: 4.5, cooling: 0, growing: 3.5 },
            { mean: 18, heating: 0, cooling: 0, growing: 8 },
            { mean: 22, heating: 0, cooling: 4, growing: 12 },
          ],
          method: "Degree days per day: heating = max(0, base - mean), cooling = max(0, mean - base), growing = max(0, mean - growingBase); mean is (min + max) / 2 when a pair is given.",
        },
      },
    },
    handler: async (i) => {
      const unit = tempUnitOf(i?.units);
      const F = unit === "fahrenheit";
      const lim = F ? { min: -150, max: 160 } : { min: -100, max: 70 };
      const base = num(i?.base, "base", lim) ?? (F ? 65 : 18);
      const growingBase = num(i?.growingBase, "growingBase", lim) ?? (F ? 50 : 10);
      const growingCap = num(i?.growingCap, "growingCap", lim);
      if (growingCap !== null && growingCap < growingBase) throw bad('"growingCap" must be at least "growingBase"');
      const days = dailyMeans(i?.days, unit);
      let hdd = 0, cdd = 0, gdd = 0;
      const rows = days.map((d) => {
        let gMean = d.mean;
        if (growingCap !== null) gMean = d.min === null ? Math.min(d.mean, growingCap) : (Math.min(d.min, growingCap) + Math.min(d.max, growingCap)) / 2;
        const heating = Math.max(0, base - d.mean), cooling = Math.max(0, d.mean - base), growing = Math.max(0, gMean - growingBase);
        hdd += heating; cdd += cooling; gdd += growing;
        return { mean: r2(d.mean), heating: r2(heating), cooling: r2(cooling), growing: r2(growing) };
      });
      return {
        count: rows.length, unit: F ? "°F" : "°C", base, growingBase, growingCap,
        totals: { heatingDegreeDays: r2(hdd), coolingDegreeDays: r2(cdd), growingDegreeDays: r2(gdd) },
        days: rows,
        method: "Degree days per day: heating = max(0, base - mean), cooling = max(0, mean - base), growing = max(0, mean - growingBase); mean is (min + max) / 2 when a pair is given.",
      };
    },
  },
  {
    route: "GET /api/wmo-weather-code",
    name: "WMO weather code lookup",
    slug: "wmo-weather-code",
    category: "data",
    price: "$0.001",
    description:
      "Turn a WMO weather interpretation code (the weatherCode field of a forecast, 0-99) into its text label and a category: clear, cloudy, fog, drizzle, rain, snow or thunderstorm, with flags for freezing and for precipitation. With no code, returns the whole table. ?code=63",
    tags: ["weather", "wmo", "weather-code", "lookup", "condition"],
    discovery: {
      input: { code: 63 },
      inputSchema: {
        properties: {
          code: { type: "number", description: "WMO weather code, 0-99; leave out for the whole table" },
        },
        required: [],
      },
      output: {
        example: { found: true, code: 63, condition: "Moderate rain", category: "rain", freezing: false, precipitation: true },
      },
    },
    handler: async (i) => {
      const code = num(i?.code, "code", { min: 0, max: 99 });
      if (code === null) return { count: WMO_TABLE.length, codes: WMO_TABLE };
      if (!Number.isInteger(code)) throw bad('"code" must be a whole number from 0 to 99');
      if (!Object.hasOwn(WMO_CODES, code)) return { found: false, code, note: "This code is not one of the WMO interpretation codes weather forecasts use.", knownCodes: WMO_TABLE.map((r) => r.code) };
      return { found: true, ...wmoRow(code) };
    },
  },
];
