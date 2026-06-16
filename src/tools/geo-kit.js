// Geocoding kit — address ↔ coordinates ↔ places, keyless and deterministic.
// Wraps Nominatim (OpenStreetMap, ODbL): the canonical public geocoder. Agents
// constantly need lat/lon from an address (or vice versa) before they can call
// a maps/places/weather/distance tool — this kit closes that gap.
//   geocode          address → lat/lon, display_name, bbox, place type
//   reverse-geocode  lat/lon → structured address (road, city, state, country)
//   place-search     keyword → ranked places, optional bbox/country filter
// Source: nominatim.openstreetmap.org, ODbL-licensed OpenStreetMap data.
import { safeFetch } from "./fetch-guard.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function getJson(url) {
  const { html } = await safeFetch(url, { maxBytes: 5 * 1024 * 1024 });
  try {
    return JSON.parse(html);
  } catch {
    throw bad("Upstream returned non-JSON", 502);
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function shapeHit(h) {
  const lat = num(h.lat);
  const lon = num(h.lon);
  const bb = Array.isArray(h.boundingbox) ? h.boundingbox.map(Number) : null;
  return {
    displayName: h.display_name ?? null,
    lat, lon,
    type: h.type ?? null,
    class: h.class ?? h.category ?? null,
    importance: h.importance ?? null,
    osm: h.osm_type && h.osm_id ? `${h.osm_type}/${h.osm_id}` : null,
    boundingBox: bb && bb.length === 4 ? { south: bb[0], north: bb[1], west: bb[2], east: bb[3] } : null,
  };
}

export const GEO_TOOLS = [
  {
    route: "GET /api/geocode",
    name: "Geocode address",
    slug: "geocode",
    category: "data",
    price: "$0.003",
    description:
      "Resolve a free-form address or place name to coordinates: lat/lon, display name, bounding box, place type. OpenStreetMap/Nominatim, no key. ?q=1600+Pennsylvania+Ave+Washington+DC&limit=1.",
    tags: ["geocoding", "address", "lat-lon", "openstreetmap", "nominatim", "maps"],
    discovery: {
      input: { q: "1600 Pennsylvania Ave NW, Washington, DC", limit: 1 },
      inputSchema: {
        properties: {
          q: { type: "string", description: "Free-form address or place name" },
          limit: { type: "number", description: "Results to return, 1-10 (default 1)" },
          countryCodes: { type: "string", description: "Comma-separated ISO-3166-1 alpha-2 codes to restrict, e.g. us,ca (optional)" },
        },
        required: ["q"],
      },
      output: {
        example: {
          query: "1600 Pennsylvania Ave NW, Washington, DC",
          count: 1,
          results: [{
            displayName: "White House, 1600, Pennsylvania Avenue Northwest, Washington, District of Columbia, 20500, United States",
            lat: 38.8976633, lon: -77.0365739,
            type: "attraction", class: "tourism", importance: 0.78,
            osm: "way/238241022",
            boundingBox: { south: 38.8974908, north: 38.897829, west: -77.0368537, east: -77.0362519 },
          }],
          source: "nominatim.openstreetmap.org (ODbL)",
        },
      },
    },
    handler: async (i) => {
      const q = String(i.q ?? "").trim();
      if (!q) throw bad('"q" is required');
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || 1, 1), 10);
      const cc = String(i.countryCodes ?? "").trim();
      const params = new URLSearchParams({ q, format: "jsonv2", limit: String(limit), addressdetails: "0" });
      if (cc) {
        if (!/^[A-Za-z]{2}(,[A-Za-z]{2})*$/.test(cc)) throw bad('"countryCodes" must be comma-separated ISO-3166-1 alpha-2 codes');
        params.set("countrycodes", cc.toLowerCase());
      }
      const data = await getJson(`https://nominatim.openstreetmap.org/search?${params}`);
      if (!Array.isArray(data)) throw bad("Nominatim returned an unexpected response", 502);
      const results = data.map(shapeHit);
      return {
        query: q,
        count: results.length,
        results,
        source: "nominatim.openstreetmap.org (ODbL)",
      };
    },
  },
  {
    route: "GET /api/reverse-geocode",
    name: "Reverse geocode",
    slug: "reverse-geocode",
    category: "data",
    price: "$0.003",
    description:
      "Resolve a lat/lon to a structured postal address: road, house number, city, state, postcode, country (with ISO code). OpenStreetMap/Nominatim, no key. ?lat=38.8977&lon=-77.0365.",
    tags: ["reverse-geocoding", "address", "lat-lon", "openstreetmap", "nominatim", "maps"],
    discovery: {
      input: { lat: 38.8977, lon: -77.0365 },
      inputSchema: {
        properties: {
          lat: { type: "number", description: "Latitude, -90 to 90" },
          lon: { type: "number", description: "Longitude, -180 to 180" },
          zoom: { type: "number", description: "Detail level, 3 (country) to 18 (building). Default 18." },
        },
        required: ["lat", "lon"],
      },
      output: {
        example: {
          lat: 38.8977, lon: -77.0365,
          displayName: "White House, 1600, Pennsylvania Avenue Northwest, Washington, District of Columbia, 20500, United States",
          address: {
            houseNumber: "1600",
            road: "Pennsylvania Avenue Northwest",
            city: "Washington",
            state: "District of Columbia",
            postcode: "20500",
            country: "United States",
            countryCode: "us",
          },
          type: "attraction", class: "tourism",
          osm: "way/238241022",
          source: "nominatim.openstreetmap.org (ODbL)",
        },
      },
    },
    handler: async (i) => {
      const lat = num(i.lat);
      const lon = num(i.lon);
      if (lat === null || lat < -90 || lat > 90) throw bad('"lat" must be a number between -90 and 90');
      if (lon === null || lon < -180 || lon > 180) throw bad('"lon" must be a number between -180 and 180');
      const zoom = Math.min(Math.max(parseInt(i.zoom, 10) || 18, 3), 18);
      const params = new URLSearchParams({
        lat: String(lat), lon: String(lon),
        format: "jsonv2", zoom: String(zoom), addressdetails: "1",
      });
      const data = await getJson(`https://nominatim.openstreetmap.org/reverse?${params}`);
      if (!data || typeof data !== "object") throw bad("Nominatim returned an unexpected response", 502);
      if (data.error) throw bad(`Nominatim: ${data.error}`, 404);
      const a = data.address ?? {};
      return {
        lat, lon,
        displayName: data.display_name ?? null,
        address: {
          houseNumber: a.house_number ?? null,
          road: a.road ?? null,
          neighbourhood: a.neighbourhood ?? a.suburb ?? null,
          city: a.city ?? a.town ?? a.village ?? a.hamlet ?? null,
          county: a.county ?? null,
          state: a.state ?? null,
          postcode: a.postcode ?? null,
          country: a.country ?? null,
          countryCode: a.country_code ?? null,
        },
        type: data.type ?? null,
        class: data.class ?? data.category ?? null,
        osm: data.osm_type && data.osm_id ? `${data.osm_type}/${data.osm_id}` : null,
        source: "nominatim.openstreetmap.org (ODbL)",
      };
    },
  },
  {
    route: "GET /api/place-search",
    name: "Place search",
    slug: "place-search",
    category: "data",
    price: "$0.003",
    description:
      "Search OpenStreetMap for places by keyword, optionally restricted to a bounding box or country. Returns ranked hits with coordinates and place type — e.g. coffee shops in a city, airports in a region. ?q=coffee&viewbox=-122.52,37.81,-122.35,37.70&bounded=1.",
    tags: ["places", "poi", "search", "openstreetmap", "nominatim", "maps"],
    discovery: {
      input: { q: "Eiffel Tower", limit: 3 },
      inputSchema: {
        properties: {
          q: { type: "string", description: "Free-form place query" },
          limit: { type: "number", description: "Results to return, 1-20 (default 5)" },
          countryCodes: { type: "string", description: "Comma-separated ISO-3166-1 alpha-2 codes (optional)" },
          viewbox: { type: "string", description: "Bounding box as 'west,north,east,south' (lon/lat). Optional." },
          bounded: { type: "string", description: "If '1' and viewbox set, restrict strictly to box (default 0)" },
        },
        required: ["q"],
      },
      output: {
        example: {
          query: "Eiffel Tower",
          count: 1,
          results: [{
            displayName: "Eiffel Tower, 5, Avenue Anatole France, Quartier du Gros-Caillou, Paris 7e Arrondissement, Paris, …, France",
            lat: 48.8582599, lon: 2.2945006,
            type: "attraction", class: "tourism", importance: 0.84,
            osm: "way/5013364",
            boundingBox: { south: 48.8574753, north: 48.8590453, west: 2.2933342, east: 2.2956671 },
          }],
          source: "nominatim.openstreetmap.org (ODbL)",
        },
      },
    },
    handler: async (i) => {
      const q = String(i.q ?? "").trim();
      if (!q) throw bad('"q" is required');
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || 5, 1), 20);
      const params = new URLSearchParams({ q, format: "jsonv2", limit: String(limit), addressdetails: "0" });
      const cc = String(i.countryCodes ?? "").trim();
      if (cc) {
        if (!/^[A-Za-z]{2}(,[A-Za-z]{2})*$/.test(cc)) throw bad('"countryCodes" must be comma-separated ISO-3166-1 alpha-2 codes');
        params.set("countrycodes", cc.toLowerCase());
      }
      const vb = String(i.viewbox ?? "").trim();
      if (vb) {
        const parts = vb.split(",").map(Number);
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
          throw bad('"viewbox" must be 4 comma-separated numbers: west,north,east,south');
        }
        params.set("viewbox", parts.join(","));
        if (String(i.bounded ?? "") === "1") params.set("bounded", "1");
      }
      const data = await getJson(`https://nominatim.openstreetmap.org/search?${params}`);
      if (!Array.isArray(data)) throw bad("Nominatim returned an unexpected response", 502);
      return {
        query: q,
        count: data.length,
        results: data.map(shapeHit),
        source: "nominatim.openstreetmap.org (ODbL)",
      };
    },
  },
];
