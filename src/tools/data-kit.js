// Data kit — live, keyless, commercial-use-OK public data agents can't get from
// a frozen training set. Sources chosen so charging is clean:
//   barcode-lookup    Open Food Facts (open data, ODbL) — UPC/EAN -> product
//                     (100 req/min/IP upstream + shared Railway egress IP →
//                     serve-stale cache below)
//   fx-rate           Frankfurter (European Central Bank reference rates, the
//                     ECB cited as the source; no other publisher)
//   weather-forecast  api.weather.gov (US gov, public domain) — US only
//   public-holidays   Nager.Date v4 community API: holidays by country+year,
//                     read and cached (at most 24 h) by holiday-source.js,
//                     whose header cites the terms (commercial use under an
//                     active sponsorship, which this service holds)
//   country-info      committed world-countries dataset (ODbL) + IANA tz
//                     country map — src/data/countries.json, pure CPU
// All keyless. Network tools are wallet-only (country-info is pure CPU and
// PoW-eligible); covered by scripts/test-data-kit.js.
import { readFileSync } from "node:fs";
import { safeFetch } from "./fetch-guard.js";
import { markEndsAtCeiling, ceilingPassed } from "../run-ceiling.js";
import { ratesUrl, latestShape, isUnknownCurrency, ECB_FX_SOURCE, fxSourceUnavailable } from "./frankfurter.js";
import { attribute } from "../data-attribution.js";
import { publicHolidaysCompat, HOLIDAY_HOSTS, parseCountry, parseYear, parseSubdivision, parseTypes, appliesIn, hasAnyType } from "./holiday-source.js";

// Committed open dataset (see src/data/LICENSE.md — ODbL attribution).
// Regenerate with scripts/build-countries-data.js. Loaded once at module load;
// records carry exactly the fields the country-info response returns.
const COUNTRIES = JSON.parse(readFileSync(new URL("../data/countries.json", import.meta.url), "utf8"));

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function getJson(url, { allowEmpty = false } = {}) {
  let html;
  // Retry once on upstream 5xx/timeout — community-run upstreams
  // intermittently flap on the first attempt then succeed immediately. Same
  // convention as gov-kit/finance-kit getJson.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ({ html } = await safeFetch(url, { maxBytes: 3 * 1024 * 1024, ownUpstream: true }));
      break;
    } catch (e) {
      // No second attempt once a run's ceiling has passed (src/run-ceiling.js; never on a direct route).
      if (attempt === 0 && !ceilingPassed() && (e.statusCode === 502 || e.statusCode === 504)) continue;
      throw e;
    }
  }
  if (allowEmpty && (!html || !html.trim())) return null;
  try {
    return JSON.parse(html);
  } catch {
    throw bad("Upstream returned non-JSON", 502);
  }
}

// ── serve-stale cache (barcode-lookup) ───────────────────────────────────────
// The upstream has no good diverse free alternative (Open Food Facts is the
// only open barcode DB of its kind), so the single-upstream mitigation here is
// caching, not a fallback provider. The dataset is near-static, so the tool
// keeps its last SUCCESSFUL response per
// request identity and (a) serves it for 24h without touching the upstream at
// all — which is also what keeps us under Open Food Facts' 100 req/min/IP cap
// on Railway's shared egress IP — and (b) on upstream failure serves whatever
// cached copy exists, however old, marked `stale: true`. Errors are never
// cached; a fresh fetch always refreshes the entry; only a cold key surfaces
// the upstream error. Bounded at 500 entries each, oldest fetchedAt evicted.
const CACHE_FRESH_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const BARCODE_CACHE = new Map(); // code -> { response, fetchedAt }

function cacheFresh(cache, key) {
  const e = cache.get(key);
  return e && Date.now() - e.fetchedAt < CACHE_FRESH_MS ? e : null;
}

function cachePut(cache, key, response) {
  if (!cache.has(key) && cache.size >= CACHE_MAX_ENTRIES) {
    let oldestKey = null, oldestAt = Infinity;
    for (const [k, v] of cache) if (v.fetchedAt < oldestAt) { oldestAt = v.fetchedAt; oldestKey = k; }
    if (oldestKey !== null) cache.delete(oldestKey);
  }
  cache.set(key, { response, fetchedAt: Date.now() });
}

// Upstream failed: serve any cached copy (even stale) for this exact key, or
// rethrow the (already-mapped) error when the key is cold. Shallow-copied so
// the `stale` flag never leaks into the cached happy-path response.
function serveStaleOrThrow(cache, key, slug, err) {
  const e = cache.get(key);
  if (!e) throw err;
  console.warn(`[${slug}] upstream failed - serving cached copy from ${new Date(e.fetchedAt).toISOString()}`);
  return { ...e.response, stale: true };
}

export const DATA_TOOLS = [
  {
    route: "GET /api/barcode-lookup", name: "Barcode product lookup", slug: "barcode-lookup", category: "data", price: "$0.005",
    description:
      "Look up a product by its UPC/EAN barcode number via Open Food Facts (open data): name, brand, category, quantity, and nutrition grade. Pairs with /api/barcode-decode (image → number → product). ?code=737628064502",
    tags: ["barcode", "upc", "ean", "product", "lookup", "open-food-facts"],
    discovery: {
      input: { code: "737628064502" },
      inputSchema: {
        properties: { code: { type: "string", description: "UPC/EAN barcode digits (8-14)" } },
        required: ["code"],
      },
      output: {
        example: {
          code: "737628064502", found: true,
          product: { name: "Thai peanut noodle kit", brands: "Simply Asia", categories: "Meals", quantity: "155 g", nutritionGrade: "d", countries: "United States" },
        },
      },
    },
    handler: async (i) => {
      const code = String(i.code ?? "").trim();
      if (!/^\d{8,14}$/.test(code)) throw bad("code must be 8-14 digits (a UPC/EAN barcode)");
      const fresh = cacheFresh(BARCODE_CACHE, code);
      if (fresh) return { ...fresh.response };
      const url = `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,categories,quantity,nutrition_grades,countries,image_url`;
      let j;
      try {
        j = await getJson(url);
      } catch (e) {
        return serveStaleOrThrow(BARCODE_CACHE, code, "barcode-lookup", e);
      }
      const p = j.status === 1 && j.product ? j.product : null;
      const response = p
        ? {
            code, found: true,
            product: {
              name: p.product_name || null, brands: p.brands || null, categories: p.categories || null,
              quantity: p.quantity || null, nutritionGrade: p.nutrition_grades || null,
              countries: p.countries || null, imageUrl: p.image_url || null,
            },
          }
        : { code, found: false };
      cachePut(BARCODE_CACHE, code, response);
      return response;
    },
  },
  {
    route: "GET /api/fx-rate", name: "Currency exchange rate", slug: "fx-rate", category: "data", attribution: "ecb", price: "$0.001",
    description:
      "Live currency conversion using European Central Bank reference rates. Converts an amount between two currencies and returns the rate, its date and its source. ?from=USD&to=EUR&amount=100. Source: European Central Bank.",
    tags: ["currency", "forex", "fx", "exchange-rate", "convert", "ecb"],
    discovery: {
      input: { from: "USD", to: "EUR", amount: 100 },
      inputSchema: {
        properties: {
          from: { type: "string", maxLength: 3, description: "3-letter currency code, e.g. USD" },
          to: { type: "string", maxLength: 3, description: "3-letter currency code, e.g. EUR" },
          amount: { type: "number", description: "amount to convert (default 1)" },
        },
        required: ["from", "to"],
      },
      output: { example: { from: "USD", to: "EUR", amount: 100, rate: 0.923, result: 92.3, date: "2026-06-13", source: "European Central Bank euro foreign exchange reference rates (via Frankfurter)" } },
    },
    handler: async (i) => {
      const from = String(i.from ?? "").trim().toUpperCase();
      const to = String(i.to ?? "").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) throw bad("from and to must be 3-letter currency codes (e.g. USD, EUR)");
      const amount = Number(i.amount ?? 1);
      if (!Number.isFinite(amount) || amount <= 0) throw bad('"amount" must be a positive number');
      // Hit the upstream even on the identity branch so the `date` field is
      // always sourced from Frankfurter (the authoritative trading day),
      // never `new Date()`. Keeps the tool deterministic w.r.t. its inputs +
      // upstream state, which the catalog contract requires.
      const unknownPair = () => bad(`unknown currency code: ${from}/${to} is not a listed pair (ECB reference currencies only, e.g. USD, EUR, GBP, JPY, CHF)`);
      try {
        if (from === to) {
          const jId = latestShape(await getJson(ratesUrl({ base: "USD", quotes: ["EUR"] })), "USD");
          if (!jId) throw bad("Frankfurter returned no USD/EUR reference rate", 502);
          return { from, to, amount, rate: 1, result: amount, date: jId.date, source: ECB_FX_SOURCE };
        }
        // v2 has no amount parameter: convert here at full precision
        // (src/tools/frankfurter.js).
        const j = latestShape(await getJson(ratesUrl({ base: from, quotes: [to] })), from);
        const r = j?.rates?.[to];
        if (j == null) throw unknownPair();
        if (typeof r !== "number" || !(r > 0)) throw bad(`unsupported currency pair ${from}/${to}`, 502);
        return { from, to, amount, rate: Number(r.toFixed(6)), result: Number((amount * r).toFixed(6)), date: j.date, source: ECB_FX_SOURCE };
      } catch (e) {
        // The ECB reference rates are the one source. An input 4xx keeps its
        // meaning: an unknown code (v2 answers 422, v1 answered 404) is named
        // as the input, since fetch-guard relabels the upstream refusal as a
        // 422 "check the URL" that blames a URL the buyer never saw (corpus,
        // 2026-09-06). Every other failure of the read (a 5xx, a timeout, a
        // host refusing this server with a 403 or a 429) is the source being
        // unavailable: fxSourceUnavailable answers 503 with Retry-After.
        if (isUnknownCurrency(e)) throw unknownPair();
        if (e.statusCode === 400) throw e;
        console.warn(`[fx-rate] ECB reference rates read failed (${e.message})`);
        throw fxSourceUnavailable(e);
      }
    },
  },
  {
    route: "GET /api/weather-forecast", name: "Weather forecast (US)", slug: "weather-forecast", category: "data", price: "$0.001",
    description:
      "Multi-period weather forecast for a US location from api.weather.gov (NWS, public domain). Give latitude and longitude; returns the place plus upcoming forecast periods (temp, wind, conditions). US coverage only. ?lat=40.71&lon=-74.01",
    tags: ["weather", "forecast", "nws", "noaa", "us"],
    discovery: {
      input: { lat: 40.71, lon: -74.01 },
      inputSchema: {
        properties: {
          lat: { type: "number", description: "latitude (US)" },
          lon: { type: "number", description: "longitude (US)" },
        },
        required: ["lat", "lon"],
      },
      output: {
        example: {
          location: { city: "New York", state: "NY" }, lat: 40.71, lon: -74.01,
          periods: [{ name: "Today", temperature: 72, unit: "F", wind: "10 mph", shortForecast: "Sunny" }],
        },
      },
    },
    handler: async (i) => {
      const lat = Number(i.lat), lon = Number(i.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw bad("lat and lon must be valid coordinates");
      let point;
      try {
        point = await getJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
      } catch (err) {
        // Only an upstream 404 means "outside NWS coverage". A timeout, 5xx,
        // or throttle is weather.gov failing — blaming the caller's coords for
        // that destroyed the evidence (and misled the buyer).
        if (err.upstreamStatus === 404) {
          throw bad("location not covered - weather.gov serves US locations only", 400);
        }
        // Our own side (this server could not look up weather.gov's host): the
        // 503 with its Retry-After and attribution goes out unchanged.
        if (err.statusCode === 503 && err.attribution === "ours") throw err;
        console.warn(`[weather-forecast] weather.gov /points failed: ${err.message ?? err}`);
        throw bad(`weather.gov upstream error - ${err.message ?? "unreachable"}`, 502);
      }
      const forecastUrl = point.properties?.forecast;
      if (!forecastUrl) throw bad("no forecast available for this location (US only)", 400);
      const loc = point.properties?.relativeLocation?.properties || {};
      const fc = await getJson(forecastUrl);
      const periods = (fc.properties?.periods || []).slice(0, 6).map((p) => ({
        name: p.name, temperature: p.temperature, unit: p.temperatureUnit,
        wind: [p.windSpeed, p.windDirection].filter(Boolean).join(" "), shortForecast: p.shortForecast,
      }));
      return { location: { city: loc.city || null, state: loc.state || null }, lat, lon, periods };
    },
  },
  {
    route: "GET /api/public-holidays", name: "Public holidays", slug: "public-holidays", upstreamHosts: HOLIDAY_HOSTS, category: "time", price: "$0.001",
    description:
      "Public holidays for a country and year from an open public-holiday dataset (keyless, 100+ countries): observed date and calendar date, local and English name, nationwide flag, the ISO 3166-2 regions each applies to, and holiday types (Public, Bank, School, Authorities, Optional, Observance). Optional filters: one region, holiday types. Pairs with /api/country-business-days and /api/country-info. ?country=US&year=2026.",
    tags: ["holidays", "public-holidays", "calendar", "country", "time"],
    discovery: {
      input: { country: "US", year: 2026 },
      inputSchema: {
        properties: {
          country: { type: "string", description: "ISO 3166-1 alpha-2 country code, e.g. US, DE, JP" },
          year: { type: "integer", description: "calendar year (1975-2099; years outside the dataset's rolling window are answered until 2027-01-31, then refused)" },
          subdivision: { type: "string", description: "optional ISO 3166-2 region, e.g. DE-BY: nationwide holidays plus that region's" },
          types: { type: "string", description: "optional comma list of holiday types to keep: Public, Bank, School, Authorities, Optional, Observance" },
        },
        required: ["country", "year"],
      },
      output: {
        example: {
          country: "US", year: 2026, count: 17,
          holidays: [{ date: "2026-01-01", calendarDate: "2026-01-01", localName: "New Year's Day", name: "New Year's Day", global: true, counties: null, types: ["Public", "Bank"], nationalHoliday: true, subdivisionCodes: null, holidayTypes: ["Public", "Bank"] }],
        },
      },
    },
    handler: async (i) => {
      const country = parseCountry(i.country);
      const year = parseYear(i.year);
      const subdivision = parseSubdivision(i.subdivision, country);
      const types = parseTypes(i.types);
      const { rows, stale } = await publicHolidaysCompat(country, year);
      // The v3 contract holds: `date` is the observed date (v3's own while it
      // answers, then the published observance rule), `calendarDate` the
      // holiday's calendar date, global/counties/types mirror the v4 fields,
      // and localName is v3's until its end of life (2027-01-31), then null.
      const holidays = rows
        .filter((r) => (!subdivision || appliesIn(r, subdivision)) && hasAnyType(r, types))
        .map((r) => ({
          date: r.date, calendarDate: r.calendarDate, localName: r.localName, name: r.name, global: r.nationalHoliday, counties: r.subdivisionCodes, types: r.holidayTypes,
          nationalHoliday: r.nationalHoliday, subdivisionCodes: r.subdivisionCodes, holidayTypes: r.holidayTypes,
        }));
      return {
        country, year, ...(subdivision ? { subdivision } : {}), ...(types ? { filterTypes: types } : {}),
        count: holidays.length, holidays, ...(stale ? { stale: true } : {}),
      };
    },
  },
  {
    route: "GET /api/country-info", name: "Country info", slug: "country-info", category: "data", price: "$0.001",
    description:
      "Country facts by name or ISO code: official name, capital, region, currencies, languages, timezones, dialing code, TLD, and more. Committed open dataset (world-countries, ODbL, plus the IANA timezone country map) - offline and deterministic. ?name=Japan or ?code=JP",
    tags: ["country", "geography", "currency", "language", "timezone", "dialing-code", "iso-3166"],
    discovery: {
      input: { name: "Japan" },
      inputSchema: {
        properties: {
          name: { type: "string", maxLength: 80, description: "country name (common or official), e.g. Japan" },
          code: { type: "string", maxLength: 3, description: "alternative: ISO 3166-1 alpha-2 or alpha-3 code, e.g. JP or JPN" },
        },
      },
      output: {
        example: {
          query: "Japan", found: true, matches: 1,
          country: {
            name: "Japan", officialName: "Japan", code2: "JP", code3: "JPN", capital: "Tokyo",
            region: "Asia", subregion: "Eastern Asia",
            currencies: [{ code: "JPY", name: "Japanese yen", symbol: "¥" }],
            languages: ["Japanese"], timezones: ["Asia/Tokyo"], callingCode: "+81",
            tld: ".jp", demonym: "Japanese", flag: "🇯🇵", latlng: [36, 138], area: 377930,
            landlocked: false, borders: [], unMember: true,
          },
        },
      },
    },
    handler: async (i) => {
      const code = i.code === undefined || i.code === null ? "" : String(i.code).trim().toUpperCase();
      const name = i.name === undefined || i.name === null ? "" : String(i.name).trim();
      if (!code && !name) throw bad('provide "name" (e.g. Japan) or "code" (ISO 3166-1 alpha-2/3, e.g. JP)');
      if (code && !/^[A-Z]{2,3}$/.test(code)) throw bad("code must be a 2- or 3-letter ISO 3166-1 code (e.g. JP or JPN)");
      if (!code && (name.length < 2 || name.length > 80)) throw bad("name must be 2-80 characters");
      let matches;
      if (code) {
        matches = COUNTRIES.filter((c) => c.code2 === code || c.code3 === code);
      } else {
        const q = name.toLowerCase();
        const exact = COUNTRIES.filter((c) => c.name?.toLowerCase() === q || c.officialName?.toLowerCase() === q);
        matches = exact.length ? exact : COUNTRIES.filter(
          (c) => c.name?.toLowerCase().includes(q) || c.officialName?.toLowerCase().includes(q)
        );
      }
      const query = code || name;
      if (!matches.length) return { query, found: false, matches: 0, country: null };
      // Shallow-copy so callers can never mutate the module-level dataset.
      return { query, found: true, matches: matches.length, country: { ...matches[0] } };
    },
  },
];

// These handlers' every upstream wait is a safeFetch (through this kit's own
// read helper and its retry), which ends at a run's ceiling when one is set
// (src/run-ceiling.js): a caller that stops waiting at a deadline of its own
// can serve them. A handler that gains another kind of wait leaves this list.
markEndsAtCeiling(DATA_TOOLS, ["fx-rate", "public-holidays", "weather-forecast"]);
attribute(DATA_TOOLS.find((t) => t.slug === "public-holidays"), "nager");
