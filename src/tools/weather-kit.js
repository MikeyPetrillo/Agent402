// Weather kit: global weather data, deterministic; the buyer needs no key.
// Wraps Open-Meteo (open-source weather API, global coverage; read with
// OPEN_METEO_API_KEY when it is set, see openMeteoRequest below):
//   weather-current     current conditions for any lat/lon on Earth
//   weather-daily       7-day daily forecast (highs, lows, precip, wind, UV)
//   weather-hourly      48-hour hourly forecast (temp, precip, wind, clouds)
//   weather-history     historical daily weather for a date range (up to 1 year)
//   weather-air-quality current air quality index + pollutant breakdown
// Complements the US-only NWS tools (weather-forecast, weather-alerts) in
// data-kit and gov-kit by covering every location worldwide.
// Source: Open-Meteo (CC BY 4.0); air quality from Copernicus CAMS and the
// archive from Copernicus C3S reanalysis, each credited (src/data-attribution.js).
import { safeFetch, retryTransient } from "./fetch-guard.js";
import { markEndsAtCeiling } from "../run-ceiling.js";
import { OPEN_METEO_ATTRIBUTION, ATTRIBUTIONS, CAMS_ATTRIBUTION, C3S_ATTRIBUTION } from "../data-attribution.js";
import { redactSecrets } from "./redact.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Each Open-Meteo API this kit reads, by its public host, and whether a key
// moves it to the keyed host. With OPEN_METEO_API_KEY set, a keyed API is
// read on its keyed host (the public host with a "customer-" prefix) with the
// key as `apikey`; without the key, or for an API marked keyed: false, the
// public host and no key, so a self-hosted server with no key reads exactly
// what it read before.
const OPEN_METEO_APIS = Object.freeze({
  forecast: { host: "api.open-meteo.com", keyed: true },
  archive: { host: "archive-api.open-meteo.com", keyed: true },
  airQuality: { host: "air-quality-api.open-meteo.com", keyed: true },
});

function openMeteoKey(env = process.env) {
  return String(env.OPEN_METEO_API_KEY ?? "").trim();
}

/** The one place an Open-Meteo URL is built. Returns the URL to fetch, the
 *  public host (the only host any message names) and the host fetched. */
export function openMeteoRequest(api, path, params, env = process.env) {
  const spec = OPEN_METEO_APIS[api];
  if (!spec) throw new Error(`unknown Open-Meteo API: ${api}`);
  const publicHost = spec.host;
  const key = spec.keyed ? openMeteoKey(env) : "";
  const q = new URLSearchParams(params);
  if (key) q.set("apikey", key);
  const host = key ? `customer-${publicHost}` : publicHost;
  return { api, url: `https://${host}${path}?${q}`, host, publicHost, keyed: Boolean(key) };
}

// The operator's line for a keyed refusal, at most one a minute per API and status.
const refusalLoggedAt = new Map();
function logKeyedRefusal(req, status) {
  const now = Date.now();
  const k = `${req.api} ${status}`;
  if (now - (refusalLoggedAt.get(k) ?? 0) < 60_000) return;
  refusalLoggedAt.set(k, now);
  console.warn(`[open-meteo] keyed request refused (HTTP ${status}) for the ${req.api} API (${req.publicHost}): OPEN_METEO_API_KEY is not accepted there or does not cover that API; answered 503, not charged`);
}

// The openMeteo word on /api/gateway-status: off (no key), refused (a keyed
// request was refused inside the last OPEN_METEO_REFUSED_WINDOW_MS), ok. Per
// process: production runs one replica, and the word clears on its own once
// the window passes with no new refusal.
export const OPEN_METEO_REFUSED_WINDOW_MS = 15 * 60_000;
let lastKeyedRefusalAt = 0;
export function openMeteoStatus({ now = Date.now(), env = process.env } = {}) {
  if (!openMeteoKey(env)) return { status: "off" };
  return { status: lastKeyedRefusalAt && now - lastKeyedRefusalAt < OPEN_METEO_REFUSED_WINDOW_MS ? "refused" : "ok" };
}
export function _resetOpenMeteoStatus({ logs = false } = {}) { lastKeyedRefusalAt = 0; if (logs) refusalLoggedAt.clear(); }

// Open-Meteo answers a key it does not accept (unknown, revoked, or a plan
// that does not cover the API) with 400 and a JSON reason naming the key or
// the plan, not 401/403. Any other 400 is the buyer's input.
const KEY_REFUSAL_REASON_RE = /\bapi[ _-]?key\b|\bapikey\b|\bplan\b|\bsubscription\b/i;
function keyRefusalReason(body) {
  let reason = "";
  try { reason = String(JSON.parse(String(body || ""))?.reason ?? ""); } catch { return false; }
  return KEY_REFUSAL_REASON_RE.test(reason);
}

// A failed read, restated so no message, field or log line built from it
// names the keyed host or carries the key. A 429 stays what safeFetch makes
// it, a 503 (the call is not charged) with Retry-After, and retryTransient
// does not retry it: keyed traffic is never sent on to the public host. A
// 401 or 403 on the keyed host, or a 400 whose reason names the key or a
// plan, is our refusal: a 503 (not charged) that says so without naming a
// key or plan, an operator log line, and the openMeteo word reads refused.
// It is not marked shed, so the tool-failure monitor counts it.
function openMeteoFailure(err, req) {
  const up = err?.upstreamStatus;
  if (req.keyed && (up === 401 || up === 403 || (up === 400 && keyRefusalReason(err?.upstreamBody)))) {
    lastKeyedRefusalAt = Date.now();
    logKeyedRefusal(req, up);
    return Object.assign(new Error("Weather data is temporarily unavailable because of a service problem on our side, not your input - retry later"), {
      statusCode: 503, upstreamStatus: up, attribution: "ours", noRetry: true, retryAfter: 60,
    });
  }
  if (!req.keyed || !(err instanceof Error)) return err;
  err.message = redactSecrets(String(err.message).split(req.host).join(req.publicHost));
  return err;
}

// One retry on a transient 502/503/504 - added 2026-08-12 after
// weather-hourly hit exactly this shape live in CI (a plain 15s timeout,
// zero retries previously; api.open-meteo.com answered fine on a later
// attempt). retryTransient never retries a deterministic 4xx or a 429.
export async function openMeteoJson(api, path, params, env = process.env) {
  const req = openMeteoRequest(api, path, params, env);
  let html;
  try {
    ({ html } = await retryTransient(() => safeFetch(req.url, { maxBytes: 2 * 1024 * 1024, ownUpstream: true, errorBodyMaxBytes: req.keyed ? 2048 : 0 })));
  } catch (err) {
    throw openMeteoFailure(err, req);
  }
  try {
    return JSON.parse(html);
  } catch {
    throw bad("Upstream returned non-JSON", 502);
  }
}

function requireCoords(i) {
  const lat = Number(i.lat);
  const lon = Number(i.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw bad('"lat" must be a number between -90 and 90');
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw bad('"lon" must be a number between -180 and 180');
  return { lat, lon };
}

// WMO weather interpretation codes → human-readable condition string.
const WMO_CODES = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snowfall", 73: "Moderate snowfall", 75: "Heavy snowfall",
  77: "Snow grains",
  80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};

function weatherCondition(code) {
  return WMO_CODES[code] ?? `Unknown (${code})`;
}


// units: "celsius" (default) | "fahrenheit", with the spellings buyers reach
// for. An unknown value is a 400 - the first cut served celsius for
// units:"imperial" and the buyer could not tell (corpus, 2026-09-06).
function tempUnitOf(raw) {
  const u = String(raw ?? "").trim().toLowerCase();
  if (u === "" || u === "celsius" || u === "c" || u === "metric") return "celsius";
  if (u === "fahrenheit" || u === "f" || u === "imperial") return "fahrenheit";
  const e = new Error('"units" must be celsius or fahrenheit'); e.statusCode = 400; throw e;
}

// Attribution the Open-Meteo licence requires next to its data (CC BY 4.0,
// https://open-meteo.com/en/licence: "Weather data by Open-Meteo.com", linked).
// Every weather tool's description ends with it, and each answer's `source`
// names the API and the licence; the vendor-name check in
// scripts/test-no-third-party-names.js allows it in the descriptions only.
// The sentence lives in src/data-attribution.js (key "open-meteo").
// weather-air-quality and weather-history serve Copernicus data through
// Open-Meteo and carry the combined keys "open-meteo-cams" and
// "open-meteo-c3s": the description ends with both credits, and the answer
// carries the Copernicus one as `credit`.
export { OPEN_METEO_ATTRIBUTION };

export const WEATHER_TOOLS = [
  {
    route: "GET /api/weather-current",
    name: "Current weather (global)",
    slug: "weather-current",
    attribution: "open-meteo",
    category: "data",
    price: "$0.002",
    description:
      `Current weather conditions for any location on Earth: temperature, feels-like, humidity, wind speed/direction/gusts, precipitation, cloud cover, pressure, and human-readable condition. Global coverage; no account needed. ?lat=48.86&lon=2.35. ${OPEN_METEO_ATTRIBUTION}`,
    tags: ["weather", "current", "temperature", "wind", "global"],
    discovery: {
      input: { lat: 48.8566, lon: 2.3522 },
      inputSchema: {
        properties: {
          lat: { type: "number", description: "Latitude, -90 to 90" },
          lon: { type: "number", description: "Longitude, -180 to 180" },
          units: { type: "string", description: "Temperature unit: celsius (default) or fahrenheit" },
        },
        required: ["lat", "lon"],
      },
      output: {
        example: {
          lat: 48.8566, lon: 2.3522,
          current: {
            time: "2026-06-23T14:00",
            temperature: 22.4, feelsLike: 21.8, unit: "°C",
            humidity: 55, precipitation: 0,
            condition: "Partly cloudy", weatherCode: 2,
            cloudCover: 40,
            windSpeed: 12.5, windDirection: 220, windGusts: 18.3, windUnit: "km/h",
            pressure: 1015.2,
            isDay: true,
          },
          source: "api.open-meteo.com (CC BY 4.0)",
        },
      },
    },
    handler: async (i) => {
      const { lat, lon } = requireCoords(i);
      const tempUnit = tempUnitOf(i.units);
      const params = new URLSearchParams({
        latitude: lat, longitude: lon,
        current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
        temperature_unit: tempUnit,
        wind_speed_unit: tempUnit === "fahrenheit" ? "mph" : "kmh",
        timezone: "auto",
      });
      const data = await openMeteoJson("forecast", "/v1/forecast", params);
      if (!data?.current) throw bad("Open-Meteo returned no current data", 502);
      const c = data.current;
      return {
        lat, lon,
        current: {
          time: c.time ?? null,
          temperature: c.temperature_2m ?? null,
          feelsLike: c.apparent_temperature ?? null,
          unit: tempUnit === "fahrenheit" ? "°F" : "°C",
          humidity: c.relative_humidity_2m ?? null,
          precipitation: c.precipitation ?? null,
          condition: weatherCondition(c.weather_code),
          weatherCode: c.weather_code ?? null,
          cloudCover: c.cloud_cover ?? null,
          windSpeed: c.wind_speed_10m ?? null,
          windDirection: c.wind_direction_10m ?? null,
          windGusts: c.wind_gusts_10m ?? null,
          windUnit: tempUnit === "fahrenheit" ? "mph" : "km/h",
          pressure: c.pressure_msl ?? null,
          isDay: c.is_day === 1,
        },
        source: "api.open-meteo.com (CC BY 4.0)",
      };
    },
  },
  {
    route: "GET /api/weather-daily",
    name: "Daily forecast (global)",
    slug: "weather-daily",
    attribution: "open-meteo",
    category: "data",
    price: "$0.002",
    description:
      `7-day daily weather forecast for any location: high/low temp, precipitation sum and probability, max wind, UV index, sunrise/sunset. Global coverage; no account needed. ?lat=35.68&lon=139.69. ${OPEN_METEO_ATTRIBUTION}`,
    tags: ["weather", "forecast", "daily", "global"],
    discovery: {
      input: { lat: 35.6762, lon: 139.6503 },
      inputSchema: {
        properties: {
          lat: { type: "number", description: "Latitude, -90 to 90" },
          lon: { type: "number", description: "Longitude, -180 to 180" },
          days: { type: "number", description: "Forecast days, 1-16 (default 7)" },
          units: { type: "string", description: "Temperature unit: celsius (default) or fahrenheit" },
        },
        required: ["lat", "lon"],
      },
      output: {
        example: {
          lat: 35.6762, lon: 139.6503,
          days: [
            {
              date: "2026-06-23", condition: "Slight rain", weatherCode: 61,
              tempMax: 28.1, tempMin: 21.3, unit: "°C",
              precipSum: 2.4, precipProbability: 65,
              windMax: 15.2, windGusts: 22.1, windUnit: "km/h",
              uvIndex: 7.5, sunrise: "04:25", sunset: "19:01",
            },
          ],
          source: "api.open-meteo.com (CC BY 4.0)",
        },
      },
    },
    handler: async (i) => {
      const { lat, lon } = requireCoords(i);
      const days = Math.min(Math.max(parseInt(i.days, 10) || 7, 1), 16);
      const tempUnit = tempUnitOf(i.units);
      const params = new URLSearchParams({
        latitude: lat, longitude: lon,
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max,sunrise,sunset",
        temperature_unit: tempUnit,
        wind_speed_unit: tempUnit === "fahrenheit" ? "mph" : "kmh",
        timezone: "auto",
        forecast_days: days,
      });
      const data = await openMeteoJson("forecast", "/v1/forecast", params);
      const d = data?.daily;
      if (!d?.time?.length) throw bad("Open-Meteo returned no daily data", 502);
      const result = d.time.map((date, idx) => ({
        date,
        condition: weatherCondition(d.weather_code?.[idx]),
        weatherCode: d.weather_code?.[idx] ?? null,
        tempMax: d.temperature_2m_max?.[idx] ?? null,
        tempMin: d.temperature_2m_min?.[idx] ?? null,
        unit: tempUnit === "fahrenheit" ? "°F" : "°C",
        precipSum: d.precipitation_sum?.[idx] ?? null,
        precipProbability: d.precipitation_probability_max?.[idx] ?? null,
        windMax: d.wind_speed_10m_max?.[idx] ?? null,
        windGusts: d.wind_gusts_10m_max?.[idx] ?? null,
        windUnit: tempUnit === "fahrenheit" ? "mph" : "km/h",
        uvIndex: d.uv_index_max?.[idx] ?? null,
        sunrise: d.sunrise?.[idx]?.split("T")[1] ?? null,
        sunset: d.sunset?.[idx]?.split("T")[1] ?? null,
      }));
      return { lat, lon, days: result, source: "api.open-meteo.com (CC BY 4.0)" };
    },
  },
  {
    route: "GET /api/weather-hourly",
    name: "Hourly forecast (global)",
    slug: "weather-hourly",
    attribution: "open-meteo",
    category: "data",
    price: "$0.002",
    description:
      `48-hour hourly weather forecast for any location: temperature, precipitation probability and amount, wind, cloud cover, humidity. Global coverage; no account needed. ?lat=-33.87&lon=151.21. ${OPEN_METEO_ATTRIBUTION}`,
    tags: ["weather", "forecast", "hourly", "global"],
    discovery: {
      input: { lat: -33.8688, lon: 151.2093 },
      inputSchema: {
        properties: {
          lat: { type: "number", description: "Latitude, -90 to 90" },
          lon: { type: "number", description: "Longitude, -180 to 180" },
          hours: { type: "number", description: "Forecast hours, 1-168 (default 48)" },
          units: { type: "string", description: "Temperature unit: celsius (default) or fahrenheit" },
        },
        required: ["lat", "lon"],
      },
      output: {
        example: {
          lat: -33.8688, lon: 151.2093,
          hours: [
            {
              time: "2026-06-23T14:00", temperature: 18.2, unit: "°C",
              humidity: 62, precipProbability: 10, precipitation: 0,
              condition: "Mainly clear", weatherCode: 1,
              cloudCover: 25, windSpeed: 14.8, windDirection: 195, windUnit: "km/h",
            },
          ],
          source: "api.open-meteo.com (CC BY 4.0)",
        },
      },
    },
    handler: async (i) => {
      const { lat, lon } = requireCoords(i);
      const hours = Math.min(Math.max(parseInt(i.hours, 10) || 48, 1), 168);
      const tempUnit = tempUnitOf(i.units);
      const params = new URLSearchParams({
        latitude: lat, longitude: lon,
        hourly: "temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m",
        temperature_unit: tempUnit,
        wind_speed_unit: tempUnit === "fahrenheit" ? "mph" : "kmh",
        timezone: "auto",
        forecast_hours: hours,
      });
      const data = await openMeteoJson("forecast", "/v1/forecast", params);
      const h = data?.hourly;
      if (!h?.time?.length) throw bad("Open-Meteo returned no hourly data", 502);
      const result = h.time.map((time, idx) => ({
        time,
        temperature: h.temperature_2m?.[idx] ?? null,
        unit: tempUnit === "fahrenheit" ? "°F" : "°C",
        humidity: h.relative_humidity_2m?.[idx] ?? null,
        precipProbability: h.precipitation_probability?.[idx] ?? null,
        precipitation: h.precipitation?.[idx] ?? null,
        condition: weatherCondition(h.weather_code?.[idx]),
        weatherCode: h.weather_code?.[idx] ?? null,
        cloudCover: h.cloud_cover?.[idx] ?? null,
        windSpeed: h.wind_speed_10m?.[idx] ?? null,
        windDirection: h.wind_direction_10m?.[idx] ?? null,
        windUnit: tempUnit === "fahrenheit" ? "mph" : "km/h",
      }));
      return { lat, lon, hours: result, source: "api.open-meteo.com (CC BY 4.0)" };
    },
  },
  {
    route: "GET /api/weather-history",
    name: "Historical weather (global)",
    slug: "weather-history",
    attribution: "open-meteo-c3s",
    category: "data",
    price: "$0.002",
    description:
      `Historical daily weather for any location and date range (up to 1 year): high/low temp, precipitation, wind, conditions. Global reanalysis archive from 1940 to 5 days ago; no account needed. ?lat=51.51&lon=-0.13&start=2025-06-01&end=2025-06-07. ${ATTRIBUTIONS["open-meteo-c3s"]}`,
    tags: ["weather", "historical", "archive", "climate", "global"],
    discovery: {
      input: { lat: 51.5074, lon: -0.1278, start: "2025-06-01", end: "2025-06-07" },
      inputSchema: {
        properties: {
          lat: { type: "number", description: "Latitude, -90 to 90" },
          lon: { type: "number", description: "Longitude, -180 to 180" },
          start: { type: "string", description: "Start date, YYYY-MM-DD" },
          end: { type: "string", description: "End date, YYYY-MM-DD (max 1 year from start)" },
          units: { type: "string", description: "Temperature unit: celsius (default) or fahrenheit" },
        },
        required: ["lat", "lon", "start", "end"],
      },
      output: {
        example: {
          lat: 51.5074, lon: -0.1278,
          days: [
            {
              date: "2025-06-01", condition: "Slight rain", weatherCode: 61,
              tempMax: 19.8, tempMin: 12.1, unit: "°C",
              precipSum: 3.2, windMax: 18.4, windUnit: "km/h",
            },
          ],
          source: "archive-api.open-meteo.com (CC BY 4.0)",
          credit: C3S_ATTRIBUTION,
        },
      },
    },
    handler: async (i) => {
      const { lat, lon } = requireCoords(i);
      const start = String(i.start ?? "").trim();
      const end = String(i.end ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw bad('"start" must be YYYY-MM-DD');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw bad('"end" must be YYYY-MM-DD');
      const startDate = new Date(start);
      const endDate = new Date(end);
      if (isNaN(startDate.getTime())) throw bad('"start" is not a valid date');
      if (isNaN(endDate.getTime())) throw bad('"end" is not a valid date');
      if (endDate < startDate) throw bad('"end" must be on or after "start"');
      if ((endDate - startDate) / 86400000 > 366) throw bad("Date range must be 1 year or less");
      const tempUnit = tempUnitOf(i.units);
      const params = new URLSearchParams({
        latitude: lat, longitude: lon,
        start_date: start, end_date: end,
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
        temperature_unit: tempUnit,
        wind_speed_unit: tempUnit === "fahrenheit" ? "mph" : "kmh",
        timezone: "auto",
      });
      const data = await openMeteoJson("archive", "/v1/archive", params);
      const d = data?.daily;
      if (!d?.time?.length) throw bad("Open-Meteo returned no historical data", 502);
      const result = d.time.map((date, idx) => ({
        date,
        condition: weatherCondition(d.weather_code?.[idx]),
        weatherCode: d.weather_code?.[idx] ?? null,
        tempMax: d.temperature_2m_max?.[idx] ?? null,
        tempMin: d.temperature_2m_min?.[idx] ?? null,
        unit: tempUnit === "fahrenheit" ? "°F" : "°C",
        precipSum: d.precipitation_sum?.[idx] ?? null,
        windMax: d.wind_speed_10m_max?.[idx] ?? null,
        windUnit: tempUnit === "fahrenheit" ? "mph" : "km/h",
      }));
      return { lat, lon, days: result, source: "archive-api.open-meteo.com (CC BY 4.0)", credit: C3S_ATTRIBUTION };
    },
  },
  {
    route: "GET /api/weather-air-quality",
    name: "Air quality (global)",
    slug: "weather-air-quality",
    attribution: "open-meteo-cams",
    category: "data",
    price: "$0.002",
    description:
      `Current air quality index and pollutant concentrations for any location: US AQI, PM2.5, PM10, ozone, NO2, SO2, CO. Global coverage; no account needed. ?lat=28.61&lon=77.23. ${ATTRIBUTIONS["open-meteo-cams"]}`,
    tags: ["weather", "air-quality", "aqi", "pollution", "pm25", "global"],
    discovery: {
      input: { lat: 28.6139, lon: 77.2090 },
      inputSchema: {
        properties: {
          lat: { type: "number", description: "Latitude, -90 to 90" },
          lon: { type: "number", description: "Longitude, -180 to 180" },
        },
        required: ["lat", "lon"],
      },
      output: {
        example: {
          lat: 28.6139, lon: 77.2090,
          airQuality: {
            time: "2026-06-23T14:00",
            usAqi: 142,
            category: "Unhealthy for Sensitive Groups",
            pm25: 52.3, pm10: 88.1,
            ozone: 45.2, nitrogenDioxide: 28.7,
            sulphurDioxide: 12.4, carbonMonoxide: 420,
            units: { pm: "μg/m³", gases: "μg/m³" },
          },
          source: "air-quality-api.open-meteo.com (CC BY 4.0)",
          credit: CAMS_ATTRIBUTION,
        },
      },
    },
    handler: async (i) => {
      const { lat, lon } = requireCoords(i);
      const params = new URLSearchParams({
        latitude: lat, longitude: lon,
        current: "us_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone",
      });
      const data = await openMeteoJson("airQuality", "/v1/air-quality", params);
      if (!data?.current) throw bad("Open-Meteo returned no air quality data", 502);
      const c = data.current;
      const aqi = c.us_aqi ?? null;
      let category = "Unknown";
      if (aqi !== null) {
        if (aqi <= 50) category = "Good";
        else if (aqi <= 100) category = "Moderate";
        else if (aqi <= 150) category = "Unhealthy for Sensitive Groups";
        else if (aqi <= 200) category = "Unhealthy";
        else if (aqi <= 300) category = "Very Unhealthy";
        else category = "Hazardous";
      }
      return {
        lat, lon,
        airQuality: {
          time: c.time ?? null,
          usAqi: aqi,
          category,
          pm25: c.pm2_5 ?? null,
          pm10: c.pm10 ?? null,
          ozone: c.ozone ?? null,
          nitrogenDioxide: c.nitrogen_dioxide ?? null,
          sulphurDioxide: c.sulphur_dioxide ?? null,
          carbonMonoxide: c.carbon_monoxide ?? null,
          units: { pm: "μg/m³", gases: "μg/m³" },
        },
        source: "air-quality-api.open-meteo.com (CC BY 4.0)",
        credit: CAMS_ATTRIBUTION,
      };
    },
  },
];

// These handlers' every upstream wait is a safeFetch (through this kit's own
// read helper and its retry), which ends at a run's ceiling when one is set
// (src/run-ceiling.js): a caller that stops waiting at a deadline of its own
// can serve them. A handler that gains another kind of wait leaves this list.
markEndsAtCeiling(WEATHER_TOOLS, ["weather-air-quality", "weather-current", "weather-daily", "weather-history", "weather-hourly"]);
