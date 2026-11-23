// Weather planning kit: answers computed from the hourly forecast,
// deterministic code over Open-Meteo's forecast API (CC BY 4.0).
//   weather-window      the stretches of hours that meet the caller's limits
//   weather-thresholds  when each of the caller's rules is met in the forecast
// Both take lat/lon or a place name (src/tools/weather-kit.js).
import { markEndsAtCeiling } from "../run-ceiling.js";
import { OPEN_METEO_ATTRIBUTION, openMeteoLicensed } from "../data-attribution.js";
import { bad, openMeteoJson, resolveLocation, locationFields, tempUnitOf, LOCATION_PROPERTIES, cacheNote } from "./weather-kit.js";

export const PLAN_SOURCE = "computed from Open-Meteo forecast data, api.open-meteo.com (CC BY 4.0)";
export const MAX_RULES = 8;
const MAX_WINDOWS = 10;

const numberOf = (v, name, { min = -Infinity, max = Infinity } = {}) => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "number" && typeof v !== "string") throw bad(`"${name}" must be a number`);
  // Number(" ") is 0: a string of spaces is refused, never read as zero.
  if (typeof v === "string" && v.trim() === "") throw bad(`"${name}" must be a number`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`"${name}" must be a number`);
  if (n < min || n > max) throw bad(`"${name}" must be between ${min} and ${max}`);
  return n;
};
const intOf = (v, name, dflt, min, max) => {
  const n = numberOf(v, name);
  if (n === null) return dflt;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`"${name}" must be a whole number from ${min} to ${max}`);
  return n;
};
const boolOf = (v, name, dflt) => {
  if (v === undefined || v === null || v === "") return dflt;
  if (v === true || v === "true" || v === "1" || v === 1) return true;
  if (v === false || v === "false" || v === "0" || v === 0) return false;
  throw bad(`"${name}" must be true or false`);
};

async function hourlyForecast(loc, vars, tempUnit, extra) {
  const params = new URLSearchParams({
    latitude: loc.lat, longitude: loc.lon,
    hourly: vars.join(","),
    temperature_unit: tempUnit,
    wind_speed_unit: tempUnit === "fahrenheit" ? "mph" : "kmh",
    timezone: "auto",
    ...extra,
  });
  const data = await openMeteoJson("forecast", "/v1/forecast", params);
  const h = data?.hourly;
  if (!h?.time?.length) throw bad("Open-Meteo returned no hourly data", 502);
  return { hourly: h, timezone: data.timezone ?? null, utcOffsetSeconds: Number.isFinite(data.utc_offset_seconds) ? data.utc_offset_seconds : 0 };
}

// --- weather-thresholds ---
// A rule's variable -> the hourly field it reads and the unit it is stated in.
const RULE_VARIABLES = Object.freeze({
  temperature: { field: "temperature_2m", unit: "temp" },
  feels_like: { field: "apparent_temperature", unit: "temp" },
  humidity: { field: "relative_humidity_2m", unit: "%" },
  precipitation: { field: "precipitation", unit: "mm" },
  precipitation_probability: { field: "precipitation_probability", unit: "%" },
  snowfall: { field: "snowfall", unit: "cm" },
  wind_speed: { field: "wind_speed_10m", unit: "wind" },
  wind_gusts: { field: "wind_gusts_10m", unit: "wind" },
  cloud_cover: { field: "cloud_cover", unit: "%" },
  uv_index: { field: "uv_index", unit: "index" },
});
const RULE_NAMES = Object.keys(RULE_VARIABLES);
// Own keys only (no prototype): an operator is one of the four listed, never a
// name every object inherits.
const OPS = Object.freeze(Object.assign(Object.create(null), { ">=": (v, x) => v >= x, ">": (v, x) => v > x, "<=": (v, x) => v <= x, "<": (v, x) => v < x }));
const OP_ALIASES = Object.freeze(Object.assign(Object.create(null), { gte: ">=", gt: ">", lte: "<=", lt: "<", above: ">", below: "<" }));
const unitText = (unit, tempUnit) => (unit === "temp" ? (tempUnit === "fahrenheit" ? "°F" : "°C") : unit === "wind" ? (tempUnit === "fahrenheit" ? "mph" : "km/h") : unit);

function rulesOf(raw) {
  let list = raw;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch { throw bad('"rules" must be a JSON array of { variable, op, value }'); } }
  if (!Array.isArray(list) || !list.length) throw bad('"rules" is required: an array of { variable, op, value }, for example [{"variable":"wind_gusts","op":">","value":60}]');
  if (list.length > MAX_RULES) throw bad(`"rules" takes at most ${MAX_RULES} entries`);
  return list.map((r, idx) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) throw bad(`rules[${idx}] must be an object { variable, op, value }`);
    const variable = typeof r.variable === "string" ? r.variable.trim().toLowerCase() : "";
    if (!Object.hasOwn(RULE_VARIABLES, variable)) throw bad(`rules[${idx}].variable must be one of: ${RULE_NAMES.join(", ")}`);
    const rawOp = typeof r.op === "string" ? r.op.trim().toLowerCase() : "";
    const op = OPS[rawOp] ? rawOp : OP_ALIASES[rawOp];
    if (!op) throw bad(`rules[${idx}].op must be one of: >=, >, <=, <`);
    const value = numberOf(r.value, `rules[${idx}].value`);
    if (value === null) throw bad(`rules[${idx}].value is required (a number)`);
    return { variable, op, value };
  });
}

function evaluateRule(rule, hourly, tempUnit) {
  const spec = RULE_VARIABLES[rule.variable];
  const series = Array.isArray(hourly[spec.field]) ? hourly[spec.field] : [];
  const wantsHigh = rule.op === ">" || rule.op === ">=";
  let firstAt = null, lastAt = null, hoursMet = 0, hoursRead = 0, extreme = null, extremeAt = null;
  for (let k = 0; k < hourly.time.length; k++) {
    const v = series[k];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    hoursRead += 1;
    if (extreme === null || (wantsHigh ? v > extreme : v < extreme)) { extreme = v; extremeAt = hourly.time[k]; }
    if (OPS[rule.op](v, rule.value)) { hoursMet += 1; firstAt ??= hourly.time[k]; lastAt = hourly.time[k]; }
  }
  return {
    variable: rule.variable, op: rule.op, value: rule.value, unit: unitText(spec.unit, tempUnit),
    met: hoursMet > 0, firstAt, lastAt, hoursMet, hoursRead,
    [wantsHigh ? "highest" : "lowest"]: extreme === null ? null : { value: extreme, at: extremeAt },
    ...(hoursRead === 0 ? { note: "The forecast carries no values for this variable at this location." } : {}),
  };
}

// --- weather-window ---
const WINDOW_VARS = ["temperature_2m", "precipitation_probability", "precipitation", "wind_speed_10m", "wind_gusts_10m", "is_day", "weather_code"];

function limitsOf(i) {
  const limits = {
    maxPrecipProbability: numberOf(i.maxPrecipProbability ?? i.maxPrecipProb, "maxPrecipProbability", { min: 0, max: 100 }) ?? 20,
    maxPrecipitation: numberOf(i.maxPrecipitation, "maxPrecipitation", { min: 0, max: 1000 }),
    maxWind: numberOf(i.maxWind, "maxWind", { min: 0, max: 1000 }),
    maxGusts: numberOf(i.maxGusts, "maxGusts", { min: 0, max: 1000 }),
    tempMin: numberOf(i.tempMin, "tempMin", { min: -150, max: 150 }),
    tempMax: numberOf(i.tempMax, "tempMax", { min: -150, max: 150 }),
    daylightOnly: boolOf(i.daylightOnly, "daylightOnly", true),
  };
  if (limits.tempMin !== null && limits.tempMax !== null && limits.tempMax < limits.tempMin) throw bad('"tempMax" must be at least "tempMin"');
  return limits;
}

// The limit an hour fails first, or null when it meets all of them. A limit
// whose value is missing for the hour is not met.
function failing(h, k, L) {
  const at = (f) => (typeof h[f]?.[k] === "number" && Number.isFinite(h[f][k]) ? h[f][k] : null);
  if (L.daylightOnly && at("is_day") !== 1) return "daylightOnly";
  const pp = at("precipitation_probability");
  if (pp === null || pp > L.maxPrecipProbability) return "maxPrecipProbability";
  if (L.maxPrecipitation !== null) { const v = at("precipitation"); if (v === null || v > L.maxPrecipitation) return "maxPrecipitation"; }
  if (L.maxWind !== null) { const v = at("wind_speed_10m"); if (v === null || v > L.maxWind) return "maxWind"; }
  if (L.maxGusts !== null) { const v = at("wind_gusts_10m"); if (v === null || v > L.maxGusts) return "maxGusts"; }
  if (L.tempMin !== null || L.tempMax !== null) {
    const v = at("temperature_2m");
    if (v === null) return L.tempMin !== null ? "tempMin" : "tempMax";
    if (L.tempMin !== null && v < L.tempMin) return "tempMin";
    if (L.tempMax !== null && v > L.tempMax) return "tempMax";
  }
  return null;
}

/** Runs of consecutive hours that meet every limit, at least `minHours` long. */
export function findWindows(h, limits, minHours, fromIndex = 0) {
  const blockers = {};
  const windows = [];
  let start = -1;
  const close = (endExclusive) => {
    if (start >= 0 && endExclusive - start >= minHours) windows.push({ from: start, to: endExclusive - 1 });
    start = -1;
  };
  for (let k = fromIndex; k < h.time.length; k++) {
    const why = failing(h, k, limits);
    if (why) { blockers[why] = (blockers[why] ?? 0) + 1; close(k); } else if (start < 0) start = k;
  }
  close(h.time.length);
  return { windows, blockers };
}

/** Index of the first hour at or after the current local hour. */
export function firstHourFrom(times, now, utcOffsetSeconds) {
  const localHour = new Date(now + utcOffsetSeconds * 1000).toISOString().slice(0, 13) + ":00";
  const k = times.findIndex((t) => t >= localHour);
  return k < 0 ? times.length : k;
}

function describeWindow(h, w) {
  const stat = (f, pick) => {
    let out = null;
    for (let k = w.from; k <= w.to; k++) { const v = h[f]?.[k]; if (typeof v === "number" && Number.isFinite(v)) out = out === null ? v : pick(out, v); }
    return out;
  };
  return {
    start: h.time[w.from], end: h.time[w.to], hours: w.to - w.from + 1,
    tempMin: stat("temperature_2m", Math.min), tempMax: stat("temperature_2m", Math.max),
    maxPrecipProbability: stat("precipitation_probability", Math.max),
    precipitation: stat("precipitation", (a, b) => Math.round((a + b) * 100) / 100),
    maxWind: stat("wind_speed_10m", Math.max), maxGusts: stat("wind_gusts_10m", Math.max),
  };
}

export const WEATHER_PLAN_TOOLS = [
  {
    route: "GET /api/weather-window",
    name: "Weather window finder",
    slug: "weather-window",
    upstreamHosts: ["api.open-meteo.com", "geocoding-api.open-meteo.com"],
    attribution: "open-meteo",
    category: "data",
    price: "$0.004",
    description:
      `Find hours in the next 1-16 days that meet your limits for an outdoor plan: rain chance, rain amount, wind, gusts, a temperature range, daylight only. Returns each run of qualifying hours from now on, longest first, with its temperature range, rain chance and wind, or names the limit that ruled out the most hours when none fits. Any place by coordinates or name. ${cacheNote("forecast")} ?place=Austin, TX&days=10&minHours=4&maxPrecipProbability=20. ${OPEN_METEO_ATTRIBUTION}`,
    tags: ["weather", "forecast", "window", "planning", "outdoor", "schedule"],
    discovery: {
      input: { lat: 30.2672, lon: -97.7431, days: 10, minHours: 4, maxPrecipProbability: 30 },
      inputSchema: {
        properties: {
          ...LOCATION_PROPERTIES,
          days: { type: "number", description: "Forecast days to search, 1-16 (default 7)" },
          minHours: { type: "number", description: "Shortest stretch to report, 1-24 hours (default 3)" },
          maxPrecipProbability: { type: "number", description: "Highest rain chance allowed in any hour, 0-100 percent (default 20)" },
          maxPrecipitation: { type: "number", description: "Highest precipitation allowed in any hour, mm (no limit by default)" },
          maxWind: { type: "number", description: "Highest wind speed allowed, km/h (mph with units=fahrenheit)" },
          maxGusts: { type: "number", description: "Highest wind gust allowed, km/h (mph with units=fahrenheit)" },
          tempMin: { type: "number", description: "Lowest temperature allowed" },
          tempMax: { type: "number", description: "Highest temperature allowed" },
          daylightOnly: { type: "boolean", description: "Only daylight hours (default true)" },
          units: { type: "string", description: "celsius (default; wind in km/h) or fahrenheit (wind in mph)" },
        },
        required: [],
      },
      output: {
        example: {
          lat: 30.2672, lon: -97.7431, timezone: "America/Chicago", days: 10, minHours: 4,
          limits: { maxPrecipProbability: 30, maxPrecipitation: null, maxWind: null, maxGusts: null, tempMin: null, tempMax: null, daylightOnly: true },
          units: { temperature: "°C", wind: "km/h", precipitation: "mm" },
          found: true, count: 9,
          windows: [
            { start: "2026-11-18T07:00", end: "2026-11-18T17:00", hours: 11, tempMin: 12.4, tempMax: 22.9, maxPrecipProbability: 3, precipitation: 0, maxWind: 14.2, maxGusts: 27.4 },
          ],
          hoursSearched: 240, hoursMeetingLimits: 96,
          source: PLAN_SOURCE,
        },
      },
    },
    handler: async (i) => {
      const days = intOf(i.days, "days", 7, 1, 16);
      const minHours = intOf(i.minHours, "minHours", 3, 1, 24);
      const limits = limitsOf(i);
      const tempUnit = tempUnitOf(i.units);
      const loc = await resolveLocation(i);
      const { hourly, timezone, utcOffsetSeconds } = await hourlyForecast(loc, WINDOW_VARS, tempUnit, { forecast_days: days });
      // The forecast starts at local midnight; hours already past are not searched.
      const from = firstHourFrom(hourly.time, Date.now(), utcOffsetSeconds);
      const { windows, blockers } = findWindows(hourly, limits, minHours, from);
      const ranked = windows.map((w) => describeWindow(hourly, w)).sort((a, b) => b.hours - a.hours || (a.start < b.start ? -1 : 1));
      const blocked = Object.values(blockers).reduce((a, b) => a + b, 0);
      const top = Object.entries(blockers).sort((a, b) => b[1] - a[1])[0];
      return {
        ...locationFields(loc), timezone, days, minHours, limits,
        units: { temperature: tempUnit === "fahrenheit" ? "°F" : "°C", wind: tempUnit === "fahrenheit" ? "mph" : "km/h", precipitation: "mm" },
        found: ranked.length > 0, count: ranked.length,
        windows: ranked.slice(0, MAX_WINDOWS),
        ...(ranked.length > MAX_WINDOWS ? { truncated: true, returned: MAX_WINDOWS } : {}),
        hoursSearched: hourly.time.length - from, hoursMeetingLimits: hourly.time.length - from - blocked,
        ...(ranked.length ? {} : { noWindow: { reason: top ? `No stretch of ${minHours} consecutive hours meets every limit; ${top[0]} ruled out the most hours.` : "The forecast holds no hours.", hoursRuledOutBy: blockers } }),
        source: PLAN_SOURCE,
      };
    },
  },
  {
    route: "POST /api/weather-thresholds",
    name: "Weather threshold check",
    slug: "weather-thresholds",
    upstreamHosts: ["api.open-meteo.com", "geocoding-api.open-meteo.com"],
    attribution: "open-meteo",
    category: "data",
    price: "$0.003",
    description:
      `Check the hourly forecast against your own rules: for each rule (variable, comparison, value) get whether it is met in the next 1-168 hours, the first and last hour it is met, how many hours, and the highest or lowest value. Up to ${MAX_RULES} rules over temperature, feels-like, humidity, precipitation and its probability, snowfall, wind, gusts, cloud cover and UV, such as frost (temperature < 0). Any place by coordinates or name. ${cacheNote("forecast")} ${OPEN_METEO_ATTRIBUTION}`,
    tags: ["weather", "forecast", "threshold", "frost", "wind", "alert"],
    discovery: {
      bodyType: "json",
      input: { place: "Denver", hours: 72, rules: [{ variable: "temperature", op: "<", value: 0 }, { variable: "wind_gusts", op: ">", value: 60 }] },
      inputSchema: {
        properties: {
          ...LOCATION_PROPERTIES,
          hours: { type: "number", description: "Forecast hours to check, 1-168 (default 72)" },
          units: { type: "string", description: "celsius (default; wind in km/h) or fahrenheit (wind in mph); precipitation mm, snowfall cm" },
          rules: {
            type: "array",
            description: `1-${MAX_RULES} rules, each { variable, op, value }`,
            items: {
              type: "object",
              properties: {
                variable: { type: "string", description: `One of: ${RULE_NAMES.join(", ")}` },
                op: { type: "string", description: "Comparison: >=, >, <= or <" },
                value: { type: "number", description: "Value in the variable's unit" },
              },
              required: ["variable", "op", "value"],
            },
          },
        },
        required: ["rules"],
      },
      output: {
        example: {
          lat: 39.73915, lon: -104.9847,
          place: { query: "Denver", name: "Denver", country: "United States", countryCode: "US", region: "Colorado", timezone: "America/Denver", lat: 39.73915, lon: -104.9847, source: "geocoding-api.open-meteo.com (GeoNames, CC BY 4.0)", credit: "Place data from GeoNames (CC BY 4.0)." },
          timezone: "America/Denver", period: { from: "2026-11-17T09:00", to: "2026-11-20T08:00", hours: 72 },
          rules: [
            { variable: "temperature", op: "<", value: 0, unit: "°C", met: true, firstAt: "2026-11-18T02:00", lastAt: "2026-11-20T07:00", hoursMet: 14, hoursRead: 72, lowest: { value: -4.1, at: "2026-11-19T06:00" } },
            { variable: "wind_gusts", op: ">", value: 60, unit: "km/h", met: false, firstAt: null, lastAt: null, hoursMet: 0, hoursRead: 72, highest: { value: 38.9, at: "2026-11-18T14:00" } },
          ],
          anyMet: true,
          source: PLAN_SOURCE,
        },
      },
    },
    handler: async (i) => {
      const rules = rulesOf(i.rules);
      const hours = intOf(i.hours, "hours", 72, 1, 168);
      const tempUnit = tempUnitOf(i.units);
      const loc = await resolveLocation(i);
      const vars = [...new Set(rules.map((r) => RULE_VARIABLES[r.variable].field))];
      const { hourly, timezone } = await hourlyForecast(loc, vars, tempUnit, { forecast_hours: hours });
      const out = rules.map((r) => evaluateRule(r, hourly, tempUnit));
      return {
        ...locationFields(loc), timezone,
        period: { from: hourly.time[0], to: hourly.time[hourly.time.length - 1], hours: hourly.time.length },
        rules: out,
        anyMet: out.some((r) => r.met),
        source: PLAN_SOURCE,
      };
    },
  },
];

// Every upstream wait here is a safeFetch through the weather kit's read
// helper (the forecast read, and a place lookup before it), so each ends at a
// run's ceiling (src/run-ceiling.js).
// Open-Meteo's licence asks for links to Open-Meteo and to the licence beside
// its data: every answer of these tools carries them (src/data-attribution.js).
openMeteoLicensed(WEATHER_PLAN_TOOLS);
markEndsAtCeiling(WEATHER_PLAN_TOOLS, ["weather-thresholds", "weather-window"]);
