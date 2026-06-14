// Data kit — live, keyless, commercial-use-OK public data agents can't get from
// a frozen training set. Sources chosen so charging is clean:
//   barcode-lookup    Open Food Facts (open data, ODbL) — UPC/EAN -> product
//   fx-rate           Frankfurter (European Central Bank reference rates)
//   weather-forecast  api.weather.gov (US gov, public domain) — US only
// All keyless. Network tools (wallet-only); covered by scripts/test-data-kit.js.
import { safeFetch } from "./fetch-guard.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function getJson(url) {
  const { html } = await safeFetch(url, { maxBytes: 3 * 1024 * 1024 });
  try {
    return JSON.parse(html);
  } catch {
    throw bad("Upstream returned non-JSON", 502);
  }
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
      const url = `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,categories,quantity,nutrition_grades,countries,image_url`;
      const j = await getJson(url);
      if (j.status !== 1 || !j.product) return { code, found: false };
      const p = j.product;
      return {
        code, found: true,
        product: {
          name: p.product_name || null, brands: p.brands || null, categories: p.categories || null,
          quantity: p.quantity || null, nutritionGrade: p.nutrition_grades || null,
          countries: p.countries || null, imageUrl: p.image_url || null,
        },
      };
    },
  },
  {
    route: "GET /api/fx-rate", name: "Currency exchange rate", slug: "fx-rate", category: "data", price: "$0.003",
    description:
      "Live currency conversion using European Central Bank reference rates (via Frankfurter). Converts an amount between two currencies and returns the rate and date. ?from=USD&to=EUR&amount=100",
    tags: ["currency", "forex", "fx", "exchange-rate", "convert", "ecb"],
    discovery: {
      input: { from: "USD", to: "EUR", amount: 100 },
      inputSchema: {
        properties: {
          from: { type: "string", description: "3-letter currency code, e.g. USD" },
          to: { type: "string", description: "3-letter currency code, e.g. EUR" },
          amount: { type: "number", description: "amount to convert (default 1)" },
        },
        required: ["from", "to"],
      },
      output: { example: { from: "USD", to: "EUR", amount: 100, rate: 0.923, result: 92.3, date: "2026-06-13" } },
    },
    handler: async (i) => {
      const from = String(i.from ?? "").trim().toUpperCase();
      const to = String(i.to ?? "").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) throw bad("from and to must be 3-letter currency codes (e.g. USD, EUR)");
      const amount = Number(i.amount ?? 1);
      if (!Number.isFinite(amount) || amount <= 0) throw bad('"amount" must be a positive number');
      if (from === to) return { from, to, amount, rate: 1, result: amount, date: new Date().toISOString().slice(0, 10) };
      const j = await getJson(`https://api.frankfurter.app/latest?from=${from}&to=${to}&amount=${amount}`);
      const result = j.rates?.[to];
      if (result == null) throw bad(`unsupported currency pair ${from}/${to}`, 502);
      return { from, to, amount, rate: Number((result / amount).toFixed(6)), result, date: j.date };
    },
  },
  {
    route: "GET /api/weather-forecast", name: "Weather forecast (US)", slug: "weather-forecast", category: "data", price: "$0.003",
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
      } catch {
        throw bad("location not covered — weather.gov serves US locations only", 400);
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
];
