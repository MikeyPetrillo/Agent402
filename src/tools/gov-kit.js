// Gov-data kit — live US public-domain data, keyless and deterministic. These
// are the data.gov-ecosystem sources agents actually want at runtime:
//   gov-data-search  search 300k+ datasets on catalog.data.gov (CKAN API)
//   weather-alerts   active NWS alerts by state (api.weather.gov)
//   earthquakes      USGS real-time earthquake feed
// All documented public APIs serving public-domain data; no keys, no scraping.
import { safeFetch } from "./fetch-guard.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function getJson(url) {
  let html;
  try {
    ({ html } = await safeFetch(url, { maxBytes: 5 * 1024 * 1024 }));
  } catch (e) {
    // safeFetch maps upstream 4xx → 422 ("check the URL"), designed for user URLs.
    // Gov-kit endpoints are hardcoded — upstream 4xx is a gov-side issue, not caller error.
    if (e.statusCode === 422) throw bad(e.message, 502);
    throw e;
  }
  try {
    return JSON.parse(html);
  } catch {
    throw bad("Upstream returned non-JSON", 502);
  }
}

// Full-name → USPS 2-letter code lookup. Lets weather-alerts accept "California"
// instead of forcing the agent to know "CA". Includes the 50 states plus DC and
// the inhabited territories (the NWS area endpoint covers all of them).
const STATE_NAME_TO_CODE = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC", "puerto rico": "PR", "u.s. virgin islands": "VI",
  guam: "GU", "american samoa": "AS", "northern mariana islands": "MP",
};

export const GOV_TOOLS = [
  {
    route: "GET /api/gov-data", name: "US gov dataset search", slug: "gov-data", category: "data", price: "$0.003",
    description:
      "Search 300,000+ US government datasets on catalog.data.gov (CKAN): titles, publishing org, formats, and direct resource URLs — the index agents need before fetching public data. ?q=electric+vehicles&rows=5.",
    tags: ["data.gov", "datasets", "open-data", "government", "ckan"],
    discovery: {
      input: { q: "electric vehicle charging stations", rows: 5 },
      inputSchema: {
        properties: {
          q: { type: "string", description: "Search query" },
          rows: { type: "number", description: "Results to return, 1-20 (default 5)" },
        },
        required: ["q"],
      },
      output: {
        example: {
          query: "electric vehicle charging stations", totalFound: 312,
          results: [{ title: "Alternative Fueling Station Locator", organization: "Department of Energy", datasetUrl: "https://catalog.data.gov/dataset/…", formats: ["CSV", "JSON"], resources: [{ format: "CSV", url: "https://…" }] }],
        },
      },
    },
    handler: async (i) => {
      const q = String(i.q ?? "").trim();
      if (!q) throw bad('"q" is required');
      const rows = Math.min(Math.max(parseInt(i.rows, 10) || 5, 1), 20);
      const data = await getJson(`https://catalog.data.gov/api/3/action/package_search?q=${encodeURIComponent(q)}&rows=${rows}`);
      // CKAN's shape is { success, result: { count, results } } — but data.gov
      // intermittently returns a 200 with a different/empty body during its
      // (frequent) outages. Treat a missing result block as an honest 502
      // rather than silently returning nulls.
      const result = data?.result;
      if (data?.success !== true || !result || (result.count === undefined && !Array.isArray(result.results))) {
        throw bad("data.gov is not returning results right now (upstream outage) — retry later", 502);
      }
      const results = Array.isArray(result.results) ? result.results : [];
      return {
        query: q,
        totalFound: result.count ?? results.length,
        results: results.map((d) => ({
          title: d.title,
          organization: d.organization?.title ?? null,
          notes: (d.notes ?? "").replace(/\s+/g, " ").slice(0, 240),
          datasetUrl: `https://catalog.data.gov/dataset/${d.name}`,
          formats: [...new Set((d.resources ?? []).map((r) => r.format).filter(Boolean))],
          resources: (d.resources ?? []).slice(0, 3).map((r) => ({ format: r.format || null, url: r.url })),
        })),
      };
    },
  },
  {
    route: "GET /api/weather-alerts", name: "US weather alerts", slug: "weather-alerts", category: "data", price: "$0.003",
    description:
      "Active National Weather Service alerts for a US state as clean JSON: event, severity, headline, affected areas, onset/expiry. Live government data, no key. ?area=CA.",
    tags: ["weather", "alerts", "nws", "noaa", "government"],
    discovery: {
      input: { area: "CA" },
      inputSchema: { properties: { area: { type: "string", description: "Two-letter US state/territory code, e.g. CA, TX, FL" } }, required: ["area"] },
      output: { example: { area: "CA", count: 2, alerts: [{ event: "Red Flag Warning", severity: "Severe", headline: "…", areas: "…", onset: "2026-06-12T12:00:00-07:00", expires: "…" }] } },
    },
    handler: async (i) => {
      // Accept `area`, `state`, OR `region`, and the full state name in any
      // of them. Agents almost always send "California" instead of "CA".
      const raw = String(i.area ?? i.state ?? i.region ?? "").trim();
      let area = raw.toUpperCase();
      if (!/^[A-Z]{2}$/.test(area)) {
        const code = STATE_NAME_TO_CODE[raw.toLowerCase()];
        if (code) area = code;
        else throw bad(`"area" must be a two-letter US state code (e.g. CA) or full state name. Got "${raw}".`);
      }
      const data = await getJson(`https://api.weather.gov/alerts/active?area=${area}`);
      const alerts = (data.features ?? []).slice(0, 20).map((f) => ({
        event: f.properties?.event ?? null,
        severity: f.properties?.severity ?? null,
        headline: f.properties?.headline ?? null,
        areas: f.properties?.areaDesc ?? null,
        onset: f.properties?.onset ?? null,
        expires: f.properties?.expires ?? null,
      }));
      return { area, count: alerts.length, alerts, source: "api.weather.gov (NWS, public domain)" };
    },
  },
  {
    route: "GET /api/earthquakes", name: "Recent earthquakes (USGS)", slug: "earthquakes", category: "data", price: "$0.003",
    description:
      "Real-time USGS earthquake feed: magnitude, place, time, depth, coordinates. Live government data, no key. ?minMag=4.5&period=day (minMag: significant|4.5|2.5|1.0|all; period: hour|day|week|month).",
    tags: ["earthquakes", "usgs", "geology", "government", "real-time"],
    discovery: {
      input: { minMag: "4.5", period: "day" },
      inputSchema: {
        properties: {
          minMag: { type: "string", description: "significant, 4.5, 2.5, 1.0, or all (default 4.5)" },
          period: { type: "string", description: "hour, day, week, or month (default day)" },
        },
      },
      output: { example: { count: 6, quakes: [{ mag: 5.2, place: "120 km SSE of Hihifo, Tonga", time: "2026-06-12T03:14:00.000Z", depthKm: 10, lon: -173.9, lat: -16.9, url: "https://earthquake.usgs.gov/…" }] } },
    },
    handler: async (i) => {
      const mag = ["significant", "4.5", "2.5", "1.0", "all"].includes(String(i.minMag)) ? String(i.minMag) : "4.5";
      const period = ["hour", "day", "week", "month"].includes(String(i.period)) ? String(i.period) : "day";
      const data = await getJson(`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${mag}_${period}.geojson`);
      const quakes = (data.features ?? []).slice(0, 20).map((f) => ({
        mag: f.properties?.mag ?? null,
        place: f.properties?.place ?? null,
        time: f.properties?.time ? new Date(f.properties.time).toISOString() : null,
        depthKm: f.geometry?.coordinates?.[2] ?? null,
        lon: f.geometry?.coordinates?.[0] ?? null,
        lat: f.geometry?.coordinates?.[1] ?? null,
        url: f.properties?.url ?? null,
      }));
      return { minMag: mag, period, count: quakes.length, quakes, source: "earthquake.usgs.gov (public domain)" };
    },
  },
];
