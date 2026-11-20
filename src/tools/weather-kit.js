// Weather kit: global weather data, deterministic; the buyer needs no key.
// Wraps Open-Meteo (open-source weather API, global coverage; read with
// OPEN_METEO_API_KEY when it is set, see openMeteoRequest below):
//   weather-current     current conditions for any lat/lon on Earth
//   weather-daily       7-day daily forecast (highs, lows, precip, wind, UV)
//   weather-hourly      48-hour hourly forecast (temp, precip, wind, clouds)
//   weather-history     historical daily weather for a date range (up to 1 year)
//   weather-air-quality current air quality index + pollutant breakdown
//   place-lookup        a city or place name -> coordinates, country, timezone
// Every weather tool takes lat/lon or a `place` name; a name is resolved by
// the same geocoding read place-lookup serves (resolveLocation below).
// Complements the US-only NWS tools (weather-forecast, weather-alerts) in
// data-kit and gov-kit by covering every location worldwide.
// Source: Open-Meteo (CC BY 4.0); air quality from Copernicus CAMS and the
// archive from Copernicus C3S reanalysis, each credited (src/data-attribution.js).
import { safeFetch, retryTransient } from "./fetch-guard.js";
import { markEndsAtCeiling } from "../run-ceiling.js";
import { OPEN_METEO_ATTRIBUTION, ATTRIBUTIONS, CAMS_CREDIT, C3S_CREDIT, GEONAMES_ATTRIBUTION } from "../data-attribution.js";
import { redactSecrets } from "./redact.js";

export function bad(message, statusCode = 400) {
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
  geocoding: { host: "geocoding-api.open-meteo.com", keyed: true },
  ensemble: { host: "ensemble-api.open-meteo.com", keyed: true },
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

// The openMeteo word on /api/gateway-status, from the last keyed outcome of
// each Open-Meteo API in this process (production runs one replica): off (no
// key); unknown until the first keyed outcome (a fresh process has not tried
// the key yet, so the pagers neither open nor close on it); refused while any
// API's last keyed outcome is a refusal (two in a row on that API, or one 400
// whose reason names the API key); ok when every API with an outcome last
// succeeded. Each API keeps its own outcome and run, so a key that covers some
// APIs and not others reads refused however many reads succeed on the others.
// A word changes only on the next keyed outcome, never with time.
const keyedOutcomes = new Map(); // api -> { outcome: null | "ok" | "refused", run }
const apiState = (api) => { let st = keyedOutcomes.get(api); if (!st) { st = { outcome: null, run: 0 }; keyedOutcomes.set(api, st); } return st; };
export function openMeteoStatus({ env = process.env } = {}) {
  if (!openMeteoKey(env)) return { status: "off" };
  const outcomes = [...keyedOutcomes.values()].map((st) => st.outcome).filter(Boolean);
  if (outcomes.includes("refused")) return { status: "refused" };
  return { status: outcomes.length ? "ok" : "unknown" };
}
function noteKeyedSuccess(api) { const st = apiState(api); st.outcome = "ok"; st.run = 0; }
function noteKeyedRefusal(api, namesKey) {
  const st = apiState(api);
  st.run += 1;
  if (namesKey || st.run >= 2) st.outcome = "refused";
}
export function _resetOpenMeteoStatus({ logs = false } = {}) { keyedOutcomes.clear(); if (logs) refusalLoggedAt.clear(); }

// Open-Meteo answers a key it does not accept (unknown, revoked, or a plan
// that does not cover the API) with 400 and a JSON reason naming the key or
// the plan, not 401/403. Any other 400 is the buyer's input.
const KEY_REFUSAL_REASON_RE = /\bapi[ _-]?key\b|\bapikey\b|\bplan\b|\bsubscription\b/i;
const NAMES_KEY_RE = /\bapi[ _-]?key\b|\bapikey\b/i;
function refusalReason(body) {
  try { return String(JSON.parse(String(body || ""))?.reason ?? ""); } catch { return ""; }
}

// A failed read, restated so no message, field or log line built from it
// names the keyed host or carries the key. A 429 stays what safeFetch makes
// it, a 503 (the call is not charged) with Retry-After, and retryTransient
// does not retry it: keyed traffic is never sent on to the public host. A
// 401 or 403 on the keyed host, or a 400 whose reason names the key or a
// plan, is our refusal: a 503 (not charged) that says so without naming a
// key or plan, an operator log line, and a refusal toward the openMeteo word.
// It is not marked shed, so the tool-failure monitor counts it.
function openMeteoFailure(err, req) {
  const up = err?.upstreamStatus;
  const reason = up === 400 ? refusalReason(err?.upstreamBody) : "";
  if (req.keyed && (up === 401 || up === 403 || (up === 400 && KEY_REFUSAL_REASON_RE.test(reason)))) {
    noteKeyedRefusal(req.api, up === 400 && NAMES_KEY_RE.test(reason));
    logKeyedRefusal(req, up);
    return Object.assign(new Error("Weather data is temporarily unavailable because of a service problem on our side, not your input - retry later"), {
      statusCode: 503, upstreamStatus: up, attribution: "ours", noRetry: true, retryAfter: 60,
    });
  }
  if (!req.keyed || !(err instanceof Error)) return err;
  err.message = redactSecrets(String(err.message).split(req.host).join(req.publicHost));
  return err;
}

// --- A short read cache (forecast, archive and ensemble reads) ---------------
// A board of cities, a pack's stops or a buyer asking the same question twice
// sends the same request again within minutes; Open-Meteo's own data changes
// more slowly than that. A successful read is kept in this process for its
// API's TTL, keyed on the exact request (API, path and every parameter, never
// the key), so two answers are equal whenever the upstream's would have been.
// Coordinates are not rounded: Open-Meteo downscales to the point's own
// elevation, so a nearby point can read a different temperature. The body is
// kept as text and parsed for every caller, so no answer shares an object with
// another. Bounded by count and by bytes; the oldest entry leaves first.
// Geocoding has its own place cache above; air quality is read fresh.
// OPEN_METEO_READ_CACHE=off reads every request upstream.
//   forecast  5 minutes: current conditions come from 15-minute data and the
//             models refresh hourly
//   ensemble 15 minutes: the ensemble runs refresh every 6 to 12 hours
//   archive  60 minutes: the archive gains a day at a time
export const OPEN_METEO_CACHE_TTL_MS = Object.freeze({ forecast: 5 * 60_000, ensemble: 15 * 60_000, archive: 60 * 60_000 });
export const OPEN_METEO_CACHE_MAX = 2000;
export const OPEN_METEO_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const readCache = new Map(); // key -> { at, ttl, html }
let readCacheBytes = 0;
const readCacheOn = () => String(process.env.OPEN_METEO_READ_CACHE ?? "").trim().toLowerCase() !== "off";
/** The sentence a cached tool's listing carries: how old an answer can be. */
export const cacheNote = (api) => `Cached for up to ${Math.round(OPEN_METEO_CACHE_TTL_MS[api] / 60_000)} minutes.`;
function readCacheKey(api, path, params) {
  const q = [...new URLSearchParams(params)].filter(([k]) => k !== "apikey").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${api} ${path}?${new URLSearchParams(q)}`;
}
function readCacheDrop(key) {
  const hit = readCache.get(key);
  if (!hit) return;
  readCache.delete(key);
  readCacheBytes -= hit.html.length;
}
function readCacheGet(key) {
  const hit = readCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= hit.ttl) { readCacheDrop(key); return null; }
  return hit.html;
}
function readCachePut(key, html, ttl) {
  if (html.length > OPEN_METEO_CACHE_MAX_BYTES / 8) return; // one body never takes most of the room
  readCacheDrop(key);
  readCache.set(key, { at: Date.now(), ttl, html });
  readCacheBytes += html.length;
  while (readCache.size > OPEN_METEO_CACHE_MAX || readCacheBytes > OPEN_METEO_CACHE_MAX_BYTES) readCacheDrop(readCache.keys().next().value);
}
export function _resetOpenMeteoCache() { readCache.clear(); readCacheBytes = 0; }
export function _openMeteoCacheStats() { return { entries: readCache.size, bytes: readCacheBytes, keys: [...readCache.keys()] }; }

// One retry on a transient 502/503/504 - added 2026-08-12 after
// weather-hourly hit exactly this shape live in CI (a plain 15s timeout,
// zero retries previously; api.open-meteo.com answered fine on a later
// attempt). retryTransient never retries a deterministic 4xx or a 429.
export async function openMeteoJson(api, path, params, env = process.env) {
  const req = openMeteoRequest(api, path, params, env);
  const ttl = readCacheOn() ? OPEN_METEO_CACHE_TTL_MS[api] : 0;
  const cacheKey = ttl ? readCacheKey(api, path, params) : null;
  const kept = cacheKey ? readCacheGet(cacheKey) : null;
  if (kept !== null) return JSON.parse(kept);
  let html;
  try {
    ({ html } = await retryTransient(() => safeFetch(req.url, { maxBytes: 2 * 1024 * 1024, ownUpstream: true, errorBodyMaxBytes: req.keyed ? 2048 : 0 })));
  } catch (err) {
    throw openMeteoFailure(err, req);
  }
  if (req.keyed) noteKeyedSuccess(req.api);
  let data;
  try {
    data = JSON.parse(html);
  } catch {
    throw bad("Upstream returned non-JSON", 502);
  }
  // Every answer read here is an object or a list of them. A body that parses
  // to anything else (null, a string, a number) is an upstream failure.
  if (data === null || typeof data !== "object") throw bad("Upstream returned an unexpected body", 502);
  // Only a readable answer is kept; an Open-Meteo error body ({ error: true }) is not.
  if (cacheKey && data.error !== true) readCachePut(cacheKey, html, ttl);
  return data;
}

export function requireCoords(i) {
  // A string of spaces is not a coordinate: Number(" ") is 0, which would
  // answer for 0,0 and be charged. It reads like any other non-number.
  const blank = (v) => v === undefined || v === null || v === "" || (typeof v === "string" && v.trim() === "");
  const lat = blank(i?.lat) ? NaN : Number(i.lat);
  const lon = blank(i?.lon) ? NaN : Number(i.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw bad('"lat" must be a number between -90 and 90');
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw bad('"lon" must be a number between -180 and 180');
  return { lat, lon };
}

// --- Place names (Open-Meteo geocoding; place data from GeoNames, CC BY 4.0) ---
// The geocoding API matches a NAME (a city, town, region or postal code), not
// a street address. "Austin, TX" is read as the name "Austin" plus a
// qualifier: a result is kept only when the qualifier names its country,
// region or district, so a qualified name never resolves to another place of
// the same name without saying so.
const US_STATES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };
const COUNTRY_ALIASES = { uk: "gb", usa: "us", "u.s.": "us", "u.s.a.": "us", "united states of america": "us", "great britain": "gb", england: "gb", scotland: "gb", wales: "gb", uae: "ae" };
const fold = (v) => String(v ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\./g, "").trim().toLowerCase();
export const PLACE_QUERY_MAX = 100;

// A place read is kept in this process for a short time, a name that matched
// nothing included, so a list of names sent again (a board of cities, a pack's
// stops) reads each name upstream once. Only an upstream answer is kept, never
// a failed read; the oldest entry leaves first once the set is full.
export const PLACE_CACHE_TTL_MS = 10 * 60_000;
export const PLACE_CACHE_MAX = 2000;
const placeCache = new Map(); // key -> { at, rows }
// One spelling per name, for the upstream read and the key alike: Unicode
// compatibility forms folded (NFKC: full-width letters, a no-break space, a
// letter and its combining mark as one), runs of whitespace as one space, and
// the key also folds case. No character that can be part of a place name is
// dropped from the name that is sent: "!", "'", "." and "-" stay wherever
// they sit ("Westward Ho!", "St. John's"), so a name is never read as another
// place's. Only a trailing semicolon, colon or question mark leaves a name,
// and a comma separates it from its qualifiers. Qualifiers are compared here
// and never sent, so their trailing punctuation is dropped.
const plainText = (s) => String(s ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
const plainName = (s) => s.replace(/[\s;:?]+$/u, "").trim();
const plainQualifier = (s) => s.replace(/[\s.,;:!?]+$/u, "").trim();
// A sentence's closing "." or "!" after a name ("Paris."): tried only when
// the name as given matched nothing.
const withoutClosingMark = (s) => s.replace(/[\s.!]+$/u, "").trim();
export function _resetPlaceCache() { placeCache.clear(); }
async function placeRows(params) {
  const key = [params.get("name").toLowerCase(), params.get("count"), params.get("language"), params.get("countryCode") ?? ""].join("\n");
  const kept = placeCache.get(key);
  if (kept && Date.now() - kept.at < PLACE_CACHE_TTL_MS) return kept.rows;
  const data = await openMeteoJson("geocoding", "/v1/search", params);
  const rows = (Array.isArray(data?.results) ? data.results : []).filter((r) => r && typeof r === "object").map(placeRow).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  placeCache.delete(key);
  placeCache.set(key, { at: Date.now(), rows });
  while (placeCache.size > PLACE_CACHE_MAX) placeCache.delete(placeCache.keys().next().value);
  return rows;
}

function placeRow(r) {
  const postcodes = Array.isArray(r.postcodes) ? r.postcodes.map(String) : [];
  return {
    name: r.name ?? null,
    lat: r.latitude ?? null,
    lon: r.longitude ?? null,
    country: r.country ?? null,
    countryCode: r.country_code ?? null,
    region: r.admin1 ?? null,
    district: r.admin2 ?? null,
    timezone: r.timezone ?? null,
    population: r.population ?? null,
    elevation: r.elevation ?? null,
    featureCode: r.feature_code ?? null,
    postcodeCount: postcodes.length,
    postcodes: postcodes.slice(0, 20),
  };
}

function qualifierMatches(row, token) {
  const t = fold(token);
  if (!t) return true;
  const cc = fold(row.countryCode);
  if (t === cc || COUNTRY_ALIASES[t] === cc) return true;
  if (t === fold(row.country) || t === fold(row.region) || t === fold(row.district)) return true;
  const state = US_STATES[t.toUpperCase()];
  return Boolean(state) && cc === "us" && fold(row.region) === fold(state);
}

/** Places matching a name, best first. `q` may carry qualifiers after a
 *  comma ("Paris, France", "Austin, TX"); `country` is an ISO 3166-1 alpha-2
 *  filter. Returns { query, name, results } with at most `count` rows. */
export async function lookupPlaces({ q, count = 5, country, language } = {}) {
  if (q !== undefined && q !== null && typeof q !== "string" && typeof q !== "number") throw bad('"q" must be a place name (text)');
  const query = String(q ?? "").trim();
  if (query.length < 2) throw bad('"q" must be a place name of at least 2 characters');
  if (query.length > PLACE_QUERY_MAX) throw bad(`"q" must be at most ${PLACE_QUERY_MAX} characters`);
  const parts = plainText(query).split(",");
  const at = parts.findIndex((p) => plainName(p));
  let name = at < 0 ? "" : plainName(parts[at]);
  let qualifiers = at < 0 ? [] : parts.slice(at + 1).map(plainQualifier).filter(Boolean);
  // "Pittsburgh PA": a trailing US state code with no comma is a qualifier too.
  const tail = qualifiers.length ? null : /^(.{2,}?)\s+([A-Z]{2})[.!]*$/.exec(name);
  if (tail && Object.hasOwn(US_STATES, tail[2])) { name = tail[1].trim(); qualifiers = [tail[2]]; }
  if (!name || name.length < 2) throw bad('"q" must start with a place name of at least 2 characters');
  const n = Math.min(Math.max(parseInt(count, 10) || 5, 1), 10);
  const cc = String(country ?? "").trim().toUpperCase();
  if (cc && !/^[A-Z]{2}$/.test(cc)) throw bad('"country" must be a two-letter ISO 3166-1 country code, for example US');
  const lang = String(language ?? "en").trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(lang)) throw bad('"language" must be a two-letter language code, for example en');
  const params = new URLSearchParams({ name, count: qualifiers.length ? 25 : n, language: lang, format: "json" });
  if (cc) params.set("countryCode", cc);
  let rows = await placeRows(params);
  const bare = rows.length ? name : withoutClosingMark(name);
  if (bare !== name && bare.length >= 2) {
    params.set("name", bare);
    rows = await placeRows(params);
    if (rows.length) name = bare;
  }
  for (const token of qualifiers) rows = rows.filter((r) => qualifierMatches(r, token));
  return { query, name, results: rows.slice(0, n) };
}

/** What a place answer says about itself. */
export const PLACE_SOURCE = "geocoding-api.open-meteo.com (GeoNames, CC BY 4.0)";

/** A tool's location: `lat` and `lon` when both are given (they win), else
 *  the best match for `place`. A resolved place rides the answer as `place`
 *  (name, country, region, timezone, the GeoNames credit). */
export async function resolveLocation(i) {
  const blank = (v) => v === undefined || v === null || v === "";
  if (!blank(i?.lat) || !blank(i?.lon)) return requireCoords(i);
  if (blank(i?.place)) throw bad('Give "lat" and "lon", or a "place" name such as "Paris" or "Austin, TX"');
  if (typeof i.place !== "string") throw bad('"place" must be a place name (text)');
  const { query, results } = await lookupPlaces({ q: i.place, count: 1, country: i.country });
  const hit = results[0];
  if (!hit) throw bad(`No place matched "${query.slice(0, PLACE_QUERY_MAX)}". Give a city, town or region name (not a street address), or pass "lat" and "lon"`, 404);
  return {
    lat: hit.lat, lon: hit.lon,
    place: { query, name: hit.name, country: hit.country, countryCode: hit.countryCode, region: hit.region, timezone: hit.timezone, lat: hit.lat, lon: hit.lon, source: PLACE_SOURCE, credit: GEONAMES_ATTRIBUTION },
  };
}

/** The location fields every weather answer starts with. */
export const locationFields = (loc) => ({ lat: loc.lat, lon: loc.lon, ...(loc.place ? { place: loc.place } : {}) });

/** The three location inputs, for a tool's inputSchema. */
export const LOCATION_PROPERTIES = Object.freeze({
  lat: { type: "number", description: "Latitude, -90 to 90 (with lon; wins over place)" },
  lon: { type: "number", description: "Longitude, -180 to 180 (with lat)" },
  place: { type: "string", description: 'A city, town or region name instead of lat/lon, for example "Paris" or "Austin, TX" (not a street address); the answer echoes the place it resolved to' },
});

// WMO weather interpretation codes → human-readable condition string.
export const WMO_CODES = {
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

export function weatherCondition(code) {
  return WMO_CODES[code] ?? `Unknown (${code})`;
}


// units: "celsius" (default) | "fahrenheit", with the spellings buyers reach
// for. An unknown value is a 400 - the first cut served celsius for
// units:"imperial" and the buyer could not tell (corpus, 2026-09-06).
export function tempUnitOf(raw) {
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
      `Current weather conditions for any location on Earth: temperature, feels-like, humidity, wind speed/direction/gusts, precipitation, cloud cover, pressure, and human-readable condition. Global coverage by coordinates or place name; no account needed. ${cacheNote("forecast")} ?lat=48.86&lon=2.35 or ?place=Paris. ${OPEN_METEO_ATTRIBUTION}`,
    tags: ["weather", "current", "temperature", "wind", "global"],
    discovery: {
      input: { lat: 48.8566, lon: 2.3522 },
      inputSchema: {
        properties: {
          ...LOCATION_PROPERTIES,
          units: { type: "string", description: "Temperature unit: celsius (default) or fahrenheit" },
        },
        required: [],
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
      const loc = await resolveLocation(i);
      const { lat, lon } = loc;
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
        ...locationFields(loc),
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
      `Weather forecast by day for any location, 7 days by default and up to 16: high/low temp, precipitation sum and probability, max wind, UV index, sunrise/sunset. Global coverage by coordinates or place name; no account needed. ${cacheNote("forecast")} ?lat=35.68&lon=139.69 or ?place=Tokyo. ${OPEN_METEO_ATTRIBUTION}`,
    tags: ["weather", "forecast", "daily", "global"],
    discovery: {
      input: { lat: 35.6762, lon: 139.6503 },
      inputSchema: {
        properties: {
          ...LOCATION_PROPERTIES,
          days: { type: "number", description: "Forecast days, 1-16 (default 7)" },
          units: { type: "string", description: "Temperature unit: celsius (default) or fahrenheit" },
        },
        required: [],
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
      const loc = await resolveLocation(i);
      const { lat, lon } = loc;
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
      return { ...locationFields(loc), days: result, source: "api.open-meteo.com (CC BY 4.0)" };
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
      `Hourly weather forecast for any location, 48 hours by default and up to 168: temperature, precipitation probability and amount, wind, cloud cover, humidity. Global coverage by coordinates or place name; no account needed. ${cacheNote("forecast")} ?lat=-33.87&lon=151.21 or ?place=Sydney. ${OPEN_METEO_ATTRIBUTION}`,
    tags: ["weather", "forecast", "hourly", "global"],
    discovery: {
      input: { lat: -33.8688, lon: 151.2093 },
      inputSchema: {
        properties: {
          ...LOCATION_PROPERTIES,
          hours: { type: "number", description: "Forecast hours, 1-168 (default 48)" },
          units: { type: "string", description: "Temperature unit: celsius (default) or fahrenheit" },
        },
        required: [],
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
      const loc = await resolveLocation(i);
      const { lat, lon } = loc;
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
      return { ...locationFields(loc), hours: result, source: "api.open-meteo.com (CC BY 4.0)" };
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
      `Historical weather by day for any location and date range (up to 1 year): high/low temp, precipitation, wind, conditions. Global archive from 1940 to the most recent days (reanalysis, with weather-model data for the latest days); by coordinates or place name; no account needed. ${cacheNote("archive")} ?lat=51.51&lon=-0.13&start=2025-06-01&end=2025-06-07 (or ?place=London). ${ATTRIBUTIONS["open-meteo-c3s"]}`,
    tags: ["weather", "historical", "archive", "climate", "global"],
    discovery: {
      input: { lat: 51.5074, lon: -0.1278, start: "2025-06-01", end: "2025-06-07" },
      inputSchema: {
        properties: {
          ...LOCATION_PROPERTIES,
          start: { type: "string", description: "Start date, YYYY-MM-DD" },
          end: { type: "string", description: "End date, YYYY-MM-DD (max 1 year from start)" },
          units: { type: "string", description: "Temperature unit: celsius (default) or fahrenheit" },
        },
        required: ["start", "end"],
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
          credit: C3S_CREDIT,
        },
      },
    },
    handler: async (i) => {
      const loc = await resolveLocation(i);
      const { lat, lon } = loc;
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
      return { ...locationFields(loc), days: result, source: "archive-api.open-meteo.com (CC BY 4.0)", credit: C3S_CREDIT };
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
      `Air quality index and current pollutant concentrations for any location: US AQI, PM2.5, PM10, ozone, NO2, SO2, CO. Global coverage by coordinates or place name; no account needed. ?lat=28.61&lon=77.23 or ?place=Delhi. ${ATTRIBUTIONS["open-meteo-cams"]}`,
    tags: ["weather", "air-quality", "aqi", "pollution", "pm25", "global"],
    discovery: {
      input: { lat: 28.6139, lon: 77.2090 },
      inputSchema: {
        properties: {
          ...LOCATION_PROPERTIES,
        },
        required: [],
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
          credit: CAMS_CREDIT,
        },
      },
    },
    handler: async (i) => {
      const loc = await resolveLocation(i);
      const { lat, lon } = loc;
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
        ...locationFields(loc),
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
        credit: CAMS_CREDIT,
      };
    },
  },
  {
    route: "GET /api/place-lookup",
    name: "Place lookup (worldwide)",
    slug: "place-lookup",
    attribution: "geonames",
    category: "data",
    price: "$0.001",
    description:
      `Resolve a city, town, region or postal-code name to coordinates worldwide: latitude and longitude, country, region, timezone, population, elevation and postcodes, best match first. Add a qualifier after a comma ("Austin, TX", "Paris, France") or a two-letter country filter. It finds places (cities, towns, regions and postal codes), not street addresses: a street address answers found: false. ?q=Pittsburgh&country=US. ${GEONAMES_ATTRIBUTION}`,
    tags: ["place", "geocode", "city", "coordinates", "timezone", "location"],
    discovery: {
      input: { q: "Pittsburgh", country: "US" },
      inputSchema: {
        properties: {
          q: { type: "string", description: 'Place name, optionally with a qualifier after a comma: "Pittsburgh", "Austin, TX", "Paris, France"' },
          count: { type: "number", description: "Results to return, 1-10 (default 5)" },
          country: { type: "string", description: "Two-letter ISO 3166-1 country code to search within, for example US" },
          language: { type: "string", description: "Two-letter language code for names (default en)" },
        },
        required: ["q"],
      },
      output: {
        example: {
          query: "Pittsburgh", found: true, count: 1,
          results: [
            {
              name: "Pittsburgh", lat: 40.44062, lon: -79.99589,
              country: "United States", countryCode: "US", region: "Pennsylvania", district: "Allegheny County",
              timezone: "America/New_York", population: 304391, elevation: 233, featureCode: "PPLA2",
              postcodeCount: 73, postcodes: ["15201", "15202", "15203"],
            },
          ],
          source: PLACE_SOURCE,
          credit: GEONAMES_ATTRIBUTION,
        },
      },
    },
    handler: async (i) => {
      const { query, results } = await lookupPlaces({ q: i.q ?? i.place ?? i.name, count: i.count ?? i.limit, country: i.country, language: i.language });
      return {
        query,
        found: results.length > 0,
        count: results.length,
        results,
        ...(results.length ? {} : { note: "No place matched. Give a city, town, region or postal-code name (not a street address); a qualifier after a comma must name the place's country, region or district." }),
        source: PLACE_SOURCE,
        credit: GEONAMES_ATTRIBUTION,
      };
    },
  },
];

// These handlers' every upstream wait is a safeFetch (through this kit's own
// read helper and its retry), which ends at a run's ceiling when one is set
// (src/run-ceiling.js): a caller that stops waiting at a deadline of its own
// can serve them. A handler that gains another kind of wait leaves this list.
markEndsAtCeiling(WEATHER_TOOLS, ["place-lookup", "weather-air-quality", "weather-current", "weather-daily", "weather-history", "weather-hourly"]);
