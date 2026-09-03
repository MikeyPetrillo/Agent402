// Gov-data kit — live US public-domain data, keyless and deterministic. These
// are the data.gov-ecosystem sources agents actually want at runtime:
//   gov-data            search 300k+ datasets on catalog.data.gov (Catalog API v4)
//   weather-alerts      active NWS alerts by state (api.weather.gov)
//   earthquakes         USGS real-time earthquake feed
//   drug-recalls        FDA drug recall/enforcement (openFDA)
//   food-recalls        FDA food recall/enforcement (openFDA)
//   drug-adverse-events top FAERS adverse reactions for a drug (openFDA)
//   vin-decode          decode a VIN (NHTSA vPIC)
//   vehicle-recalls     NHTSA safety recalls by make/model/year
//   device-recalls      FDA medical-device recall/enforcement (openFDA)
//   college-lookup      US colleges via the Dept of Ed College Scorecard
//   fec-candidates      US federal election candidates (FEC)
//   federal-awards      US federal contract awards (USAspending, POST search)
//   geo-lookup          lat/lon -> county/state/census block (FCC Area API)
//   fema-disasters      FEMA disaster declarations by state (openFEMA)
// All documented public APIs serving public-domain data; no scraping. gov-data,
// College Scorecard + FEC use the api.data.gov key (DATA_GOV_API_KEY, DEMO_KEY
// fallback); the rest are keyless. (Treasury debt/rates live in macro-kit; don't
// dup here.)
import { safeFetch } from "./fetch-guard.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Catalog API v4 descriptions are often HTML; strip tags for the notes field.
function plainNotes(html) {
  return String(html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}

// DCAT distributions use format and/or mediaType, and either downloadURL or
// accessURL. Normalize to the {format, url} shape buyers already expect.
function dcatResources(dists) {
  const list = Array.isArray(dists) ? dists : [];
  return list
    .map((r) => ({
      format: r.format || (typeof r.mediaType === "string" ? r.mediaType.split("/").pop() : null) || null,
      url: r.downloadURL || r.accessURL || null,
    }))
    .filter((r) => r.url);
}

async function getJson(url, opts = {}) {
  let html;
  // Retry once — data.gov and weather.gov intermittently 404/502 on first
  // attempt then succeed immediately. Without this, Bazaar registration and
  // paid-canary fail on the same tools every run.
  //
  // 504 added 2026-08-12: this condition never covered a plain timeout, so
  // any tool whose upstream took a hair over safeFetch's fixed 15s window
  // (vehicle-recalls/NHTSA, fec-candidates/FEC — both observed live in CI,
  // ~10-16s responses) got zero retries while 422/502 got one. The upstream
  // wasn't dead, this loop just didn't give it the same second chance.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ({ html } = await safeFetch(url, { maxBytes: 5 * 1024 * 1024, ...opts }));
      break;
    } catch (e) {
      // An upstream 404 is an ANSWER for openFDA (no matches) - never retried,
      // and the upstream code rides on the re-labelled error so
      // getJsonAllowEmpty can read it (it was lost here until 2026-08-27).
      if (attempt === 0 && e.upstreamStatus !== 404 && (e.statusCode === 422 || e.statusCode === 502 || e.statusCode === 504)) continue;
      if (e.statusCode === 422) throw Object.assign(bad(e.message, 502), { upstreamStatus: e.upstreamStatus });
      throw e;
    }
  }
  try {
    return JSON.parse(html);
  } catch {
    throw bad("Upstream returned non-JSON", 502);
  }
}

// openFDA returns HTTP 404 with {error:{code:"NOT_FOUND"}} when a query simply
// has no matches — that's an empty result, not an outage. Swallow 404 to null so
// the tool returns count:0 instead of erroring; real 5xx/timeouts still throw.
async function getJsonAllowEmpty(url, opts = {}) {
  try {
    return await getJson(url, opts);
  } catch (e) {
    // fetch-guard re-labels an upstream 4xx as OUR 422 and keeps the upstream
    // code in `upstreamStatus` - so `statusCode === 404` never matched, every
    // no-match query threw "Source URL returned HTTP 404", and recall-report
    // (which needs 2 of 3 feeds) 502'd for any drug name absent from the food
    // and device feeds, i.e. most of them (found 2026-08-27 generating the
    // losartan sample; the buyer was refunded, the product was unsellable).
    if (e.statusCode === 404 || e.upstreamStatus === 404) return null;
    throw e;
  }
}

// FDA dates are YYYYMMDD strings; render as ISO YYYY-MM-DD (null if unparseable).
export const fdaDate = (s) => (/^\d{8}$/.test(s || "") ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s || null);


// openFDA enforcement row -> our shape. `full` (set by in-process composites
// such as recall-report) lifts the per-field caps: the public $0.004 tools keep
// them small, but a report that quotes "the FDA reason wording" must not
// reproduce a sentence cut at 220 chars as if it were complete (measured:
// 20 of 20 insulin-pump reasons exceed 220; the NDC sits at the END of drug
// product descriptions and was the part cut). Also carried: the lot list
// (code_info - what a reader checks a bottle against), the event id (117
// losartan RECORDS are 51 recall EVENTS), termination date and quantity.
const cut = (v, n) => (v == null ? null : String(v).replace(/\s+/g, " ").slice(0, n));
export function recallRow(r, full = false) {
  const n = (short, long) => (full ? long : short);
  return {
    firm: r.recalling_firm ?? null,
    classification: r.classification ?? null,
    status: r.status ?? null,
    reason: cut(r.reason_for_recall ?? "", n(220, 1500)),
    product: cut(r.product_description ?? "", n(180, 900)),
    distribution: cut(r.distribution_pattern, n(120, 900)),
    recallInitiated: fdaDate(r.recall_initiation_date),
    recallNumber: r.recall_number ?? null,
    eventId: r.event_id ?? null,
    terminated: fdaDate(r.termination_date),
    lots: full ? cut(r.code_info, 1500) : undefined,
    quantity: full ? cut(r.product_quantity, 200) : undefined,
    voluntary: full ? (r.voluntary_mandated ?? null) : undefined,
  };
}
// openFDA returns rows in RELEVANCE order unless told otherwise; a "most recent
// recall" read off an unsorted page is wrong (measured: losartan's newest was
// 2024-05-07 Ongoing, absent from the unsorted top 20 which ended in 2022).
const FDA_SORT = "&sort=recall_initiation_date:desc";

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

// openFDA: keyless is 1,000 req/day/IP (shared by every tool on this host and
// the recall monitor's probes); OPENFDA_API_KEY raises it to 120k/day. Appended
// as a query param only when set - never logged (the URL is never surfaced).
const openFdaKeyParam = () => (process.env.OPENFDA_API_KEY ? `&api_key=${encodeURIComponent(process.env.OPENFDA_API_KEY.trim())}` : "");
export const GOV_TOOLS = [
  {
    route: "GET /api/gov-data", name: "US gov dataset search", slug: "gov-data", category: "data", price: "$0.003",
    description:
      "Search 300,000+ US government datasets on catalog.data.gov (Catalog API): titles, publishing org, formats, and direct resource URLs - the index agents need before fetching public data. ?q=electric+vehicles&rows=5.",
    tags: ["data.gov", "datasets", "open-data", "government", "catalog"],
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
          query: "electric vehicle charging stations", totalFound: 5,
          results: [{ title: "Electric Vehicle Charging Stations", organization: "Town of Cary, North Carolina", datasetUrl: "https://catalog.data.gov/dataset/…", formats: ["json", "csv"], resources: [{ format: "csv", url: "https://…" }] }],
        },
      },
    },
    handler: async (i) => {
      const q = String(i.q ?? "").trim();
      if (!q) throw bad('"q" is required');
      const rows = Math.min(Math.max(parseInt(i.rows, 10) || 5, 1), 20);
      // data.gov retired the CKAN Action API (catalog.data.gov/api/3 and the
      // api.gsa.gov/.../datagov/v3 proxy both 404 — the proxy still names
      // catalog-old.data.gov). Current surface is Catalog API v4:
      // https://api.gsa.gov/technology/datagov/v4/search (docs:
      // resources.data.gov/catalog-api/). Needs X-Api-Key; DATA_GOV_API_KEY on
      // Railway, DEMO_KEY fallback for keyless boots.
      const key = process.env.DATA_GOV_API_KEY || "DEMO_KEY";
      const data = await getJson(
        `https://api.gsa.gov/technology/datagov/v4/search?q=${encodeURIComponent(q)}&per_page=${rows}`,
        { headers: { "x-api-key": key } },
      );
      // v4 shape is { results, after?, sort } — no CKAN success envelope, and
      // no catalog-wide count (cursor pagination). Missing results → 502.
      if (!Array.isArray(data?.results)) {
        throw bad("data.gov is not returning results right now (upstream outage) - retry later", 502);
      }
      const results = data.results;
      return {
        query: q,
        // v4 has no total hit count; report this page's size (hasMore when
        // the cursor says more pages exist).
        totalFound: results.length,
        hasMore: Boolean(data.after),
        results: results.map((d) => {
          const resources = dcatResources(d.dcat?.distribution).slice(0, 3);
          return {
            title: d.title,
            organization: d.organization?.name ?? d.publisher ?? null,
            notes: plainNotes(d.description ?? d.dcat?.description),
            datasetUrl: d.slug ? `https://catalog.data.gov/dataset/${d.slug}` : null,
            formats: [...new Set(resources.map((r) => r.format).filter(Boolean))],
            resources,
          };
        }),
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
    tags: ["earthquakes", "earthquake", "feed", "usgs", "geology", "government", "real-time"],
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

  // ---- openFDA (api.fda.gov) — drug/food safety, keyless -------------------
  {
    route: "GET /api/drug-recalls", name: "FDA drug recalls", slug: "drug-recalls", category: "data", price: "$0.004",
    description:
      "Search FDA drug recall / enforcement records (openFDA): recalling firm, classification (Class I/II/III), reason, distribution, and dates. Live FDA data, no key. ?q=losartan&limit=5",
    tags: ["fda", "drug", "recall", "openfda", "health", "safety", "government"],
    discovery: {
      input: { q: "losartan", limit: 5 },
      inputSchema: {
        properties: {
          q: { type: "string", description: "Drug name or product term to search recalls for" },
          limit: { type: "number", description: "Max results 1-20 (default 5)" },
        },
        required: ["q"],
      },
      output: {
        example: {
          query: "losartan", count: 1,
          total: 117,
          recalls: [{ firm: "Torrent Pharmaceuticals", classification: "Class II", status: "Ongoing", reason: "Presence of an impurity", product: "Losartan Potassium Tablets", distribution: "Nationwide", recallInitiated: "2019-11-08", recallNumber: "D-123-2020", eventId: "84000", terminated: null }],
          source: "api.fda.gov (openFDA, public domain)",
        },
      },
    },
    handler: async (i) => {
      const q = String(i.q ?? i.drug ?? "").trim();
      if (!q) throw bad('"q" (drug name or product term) is required');
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || 5, 1), 20);
      const search = encodeURIComponent(`product_description:"${q}"`);
      const data = await getJsonAllowEmpty(`https://api.fda.gov/drug/enforcement.json?search=${search}&limit=${limit}${FDA_SORT}${openFdaKeyParam()}`);
      const results = data?.results ?? [];
      return {
        query: q,
        count: results.length,
        total: data?.meta?.results?.total ?? results.length,
        recalls: results.map((r) => recallRow(r, i.full === true)),
        source: "api.fda.gov (openFDA, public domain)",
      };
    },
  },
  {
    route: "GET /api/food-recalls", name: "FDA food recalls", slug: "food-recalls", category: "data", price: "$0.004",
    description:
      "Search FDA food recall / enforcement records (openFDA): recalling firm, classification, reason (allergen, contamination, etc.), distribution, and dates. Live FDA data, no key. ?q=peanut&limit=5",
    tags: ["fda", "food", "recall", "openfda", "allergen", "safety", "government"],
    discovery: {
      input: { q: "undeclared peanut", limit: 5 },
      inputSchema: {
        properties: {
          q: { type: "string", description: "Product or reason term to search food recalls for" },
          limit: { type: "number", description: "Max results 1-20 (default 5)" },
        },
        required: ["q"],
      },
      output: {
        example: {
          query: "undeclared peanut", count: 1,
          total: 12,
          recalls: [{ firm: "Example Foods Inc", classification: "Class I", status: "Ongoing", reason: "Undeclared peanut", product: "Chocolate chip cookies", distribution: "CA, NV, OR", recallInitiated: "2026-05-01", recallNumber: "F-1234-2026", eventId: "95001", terminated: null }],
          source: "api.fda.gov (openFDA, public domain)",
        },
      },
    },
    handler: async (i) => {
      const q = String(i.q ?? "").trim();
      if (!q) throw bad('"q" (product or reason term) is required');
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || 5, 1), 20);
      // Search both the product description and the reason so "peanut" matches an
      // undeclared-allergen recall even when the product name doesn't say peanut.
      const search = encodeURIComponent(`product_description:"${q}"+reason_for_recall:"${q}"`);
      const data = await getJsonAllowEmpty(`https://api.fda.gov/food/enforcement.json?search=${search}&limit=${limit}${FDA_SORT}${openFdaKeyParam()}`);
      const results = data?.results ?? [];
      return {
        query: q,
        count: results.length,
        total: data?.meta?.results?.total ?? results.length,
        recalls: results.map((r) => recallRow(r, i.full === true)),
        source: "api.fda.gov (openFDA, public domain)",
      };
    },
  },
  {
    route: "GET /api/drug-adverse-events", name: "FDA drug adverse events", slug: "drug-adverse-events", category: "data", price: "$0.004",
    description:
      "Top reported adverse reactions for a drug from the FDA FAERS database (openFDA), ranked by report count - a fast read on a drug's real-world safety signal. Live FDA data, no key. ?drug=aspirin&limit=10",
    tags: ["fda", "drug", "adverse-events", "faers", "openfda", "health", "government"],
    discovery: {
      input: { drug: "aspirin", limit: 10 },
      inputSchema: {
        properties: {
          drug: { type: "string", description: "Drug/medicinal product name" },
          limit: { type: "number", description: "How many top reactions, 1-25 (default 10)" },
        },
        required: ["drug"],
      },
      output: {
        example: {
          drug: "aspirin", count: 2,
          topReactions: [{ reaction: "NAUSEA", reports: 4211 }, { reaction: "DYSPNOEA", reports: 3987 }],
          source: "api.fda.gov (openFDA FAERS, public domain)",
        },
      },
    },
    handler: async (i) => {
      const drug = String(i.drug ?? i.q ?? "").trim();
      if (!drug) throw bad('"drug" is required');
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || 10, 1), 25);
      const search = encodeURIComponent(`patient.drug.medicinalproduct:"${drug}"`);
      const data = await getJsonAllowEmpty(
        `https://api.fda.gov/drug/event.json?search=${search}&count=patient.reaction.reactionmeddrapt.exact&limit=${limit}`,
      );
      const results = data?.results ?? [];
      return {
        drug,
        count: results.length,
        topReactions: results.map((r) => ({ reaction: r.term ?? null, reports: r.count ?? null })),
        source: "api.fda.gov (openFDA FAERS, public domain)",
      };
    },
  },

  // ---- NHTSA (vpic + api.nhtsa.gov) — vehicles, keyless --------------------
  {
    route: "GET /api/vin-decode", name: "VIN decoder (NHTSA)", slug: "vin-decode", category: "data", price: "$0.004",
    description:
      "Decode a vehicle VIN via NHTSA vPIC: make, model, year, trim, body class, engine, fuel, plant, and vehicle type. Accepts full or partial VINs (partial needs modelYear). Live gov data, no key. ?vin=1HGCM82633A004352",
    tags: ["nhtsa", "vin", "vehicle", "car", "decoder", "government"],
    discovery: {
      input: { vin: "1HGCM82633A004352" },
      inputSchema: {
        properties: {
          vin: { type: "string", description: "17-char VIN (or a partial VIN with * wildcards)" },
          modelYear: { type: "number", description: "Model year - helps decode a partial VIN" },
        },
        required: ["vin"],
      },
      output: {
        example: {
          vin: "1HGCM82633A004352",
          vehicle: { make: "HONDA", model: "Accord", year: "2003", trim: null, bodyClass: "Coupe", vehicleType: "PASSENGER CAR", engineCylinders: "6", fuelType: "Gasoline", plantCity: "MARYSVILLE", manufacturer: "AMERICAN HONDA MOTOR CO., INC." },
          source: "vpic.nhtsa.dot.gov (public domain)",
        },
      },
    },
    handler: async (i) => {
      const vin = String(i.vin ?? "").trim();
      if (!vin || !/^[A-Za-z0-9*]{6,17}$/.test(vin)) throw bad('"vin" must be a 6-17 character VIN (letters, digits, * wildcards)');
      const my = parseInt(i.modelYear, 10);
      const yr = Number.isFinite(my) ? `&modelyear=${my}` : "";
      const data = await getJson(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${encodeURIComponent(vin)}?format=json${yr}`);
      const v = {};
      for (const row of data.Results ?? []) {
        if (row?.Value && row.Value !== "Not Applicable") v[row.Variable] = row.Value;
      }
      if (!v.Make && !v.Model) throw bad("NHTSA could not decode that VIN (check the VIN, or supply modelYear for a partial VIN)", 422);
      return {
        vin,
        vehicle: {
          make: v.Make ?? null, model: v.Model ?? null, year: v["Model Year"] ?? null, trim: v.Trim ?? null,
          bodyClass: v["Body Class"] ?? null, vehicleType: v["Vehicle Type"] ?? null,
          engineCylinders: v["Engine Number of Cylinders"] ?? null, fuelType: v["Fuel Type - Primary"] ?? null,
          plantCity: v["Plant City"] ?? null, manufacturer: v["Manufacturer Name"] ?? null,
        },
        source: "vpic.nhtsa.dot.gov (public domain)",
      };
    },
  },
  {
    route: "GET /api/vehicle-recalls", name: "Vehicle recalls (NHTSA)", slug: "vehicle-recalls", category: "data", price: "$0.004",
    description:
      "NHTSA safety recalls for a vehicle by make/model/year: campaign number, affected component, summary, consequence, and remedy. Live gov data, no key. ?make=honda&model=accord&year=2019",
    tags: ["nhtsa", "recall", "vehicle", "car", "safety", "government"],
    discovery: {
      input: { make: "honda", model: "accord", year: 2019 },
      inputSchema: {
        properties: {
          make: { type: "string", description: "Vehicle make, e.g. honda" },
          model: { type: "string", description: "Vehicle model, e.g. accord" },
          year: { type: "number", description: "Model year, e.g. 2019" },
        },
        required: ["make", "model", "year"],
      },
      output: {
        example: {
          make: "honda", model: "accord", year: 2019, count: 1,
          recalls: [{ campaign: "20V314000", component: "FUEL SYSTEM, GASOLINE:DELIVERY:FUEL PUMP", summary: "…", consequence: "…", remedy: "…", reportReceived: "28/05/2020", parkOutside: false }],
          source: "api.nhtsa.gov (public domain)",
        },
      },
    },
    handler: async (i) => {
      const make = String(i.make ?? "").trim();
      const model = String(i.model ?? "").trim();
      const year = parseInt(i.year, 10);
      if (!make || !model || !Number.isFinite(year)) throw bad('"make", "model", and "year" are all required');
      const data = await getJson(
        `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${year}`,
      );
      const results = Array.isArray(data.results) ? data.results : [];
      return {
        make, model, year,
        count: results.length,
        recalls: results.slice(0, 25).map((r) => ({
          campaign: r.NHTSACampaignNumber ?? null,
          component: r.Component ?? null,
          summary: (r.Summary ?? "").replace(/\s+/g, " ").slice(0, 220),
          consequence: (r.Consequence ?? "").replace(/\s+/g, " ").slice(0, 200),
          remedy: (r.Remedy ?? "").replace(/\s+/g, " ").slice(0, 200),
          reportReceived: r.ReportReceivedDate ?? null,
          parkOutside: r.parkOutSide === "True",
        })),
        source: "api.nhtsa.gov (public domain)",
      };
    },
  },

  // ---- openFDA device recalls (api.fda.gov) — keyless ---------------------
  {
    route: "GET /api/device-recalls", name: "FDA medical device recalls", slug: "device-recalls", category: "data", price: "$0.004",
    description:
      "Search FDA medical-device recall / enforcement records (openFDA): recalling firm, classification (Class I/II/III), reason, distribution, and dates. Live FDA data, no key. ?q=insulin+pump&limit=5",
    tags: ["fda", "device", "recall", "openfda", "medical", "safety", "government"],
    discovery: {
      input: { q: "insulin pump", limit: 5 },
      inputSchema: {
        properties: {
          q: { type: "string", description: "Device name or product term to search recalls for" },
          limit: { type: "number", description: "Max results 1-20 (default 5)" },
        },
        required: ["q"],
      },
      output: {
        example: {
          query: "insulin pump", count: 1,
          total: 83,
          recalls: [{ firm: "Example Medical Inc", classification: "Class II", status: "Ongoing", reason: "Software error", product: "Insulin infusion pump", distribution: "Nationwide", recallInitiated: "2025-03-14", recallNumber: "Z-1234-2025", eventId: "96001", terminated: null }],
          source: "api.fda.gov (openFDA, public domain)",
        },
      },
    },
    handler: async (i) => {
      const q = String(i.q ?? "").trim();
      if (!q) throw bad('"q" (device name or product term) is required');
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || 5, 1), 20);
      const search = encodeURIComponent(`product_description:"${q}"`);
      const data = await getJsonAllowEmpty(`https://api.fda.gov/device/enforcement.json?search=${search}&limit=${limit}${FDA_SORT}${openFdaKeyParam()}`);
      const results = data?.results ?? [];
      return {
        query: q,
        count: results.length,
        total: data?.meta?.results?.total ?? results.length,
        recalls: results.map((r) => recallRow(r, i.full === true)),
        source: "api.fda.gov (openFDA, public domain)",
      };
    },
  },

  // ---- College Scorecard (api.data.gov) — our DATA_GOV_API_KEY -------------
  {
    route: "GET /api/college-lookup", name: "US college lookup (Scorecard)", slug: "college-lookup", category: "data", price: "$0.004",
    description:
      "Look up US colleges by name via the Dept. of Education College Scorecard: state, out-of-state tuition, overall admission rate, and undergraduate size. Live gov data. ?name=Stanford&limit=5",
    tags: ["education", "college", "scorecard", "tuition", "admissions", "government"],
    discovery: {
      input: { name: "Stanford", limit: 5 },
      inputSchema: {
        properties: {
          name: { type: "string", description: "College name (or part of it) to search" },
          limit: { type: "number", description: "Max results 1-20 (default 5)" },
        },
        required: ["name"],
      },
      output: {
        example: {
          query: "Stanford", count: 1,
          colleges: [{ name: "Stanford University", state: "CA", tuitionOutOfStateUsd: 65910, admissionRate: 0.0361, undergraduateSize: 7554 }],
          source: "api.data.gov / collegescorecard (public domain)",
        },
      },
    },
    handler: async (i) => {
      const name = String(i.name ?? i.q ?? "").trim();
      if (!name) throw bad('"name" is required');
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || 5, 1), 20);
      const key = process.env.DATA_GOV_API_KEY || "DEMO_KEY";
      const fields = "school.name,school.state,latest.cost.tuition.out_of_state,latest.admissions.admission_rate.overall,latest.student.size";
      const data = await getJson(
        `https://api.data.gov/ed/collegescorecard/v1/schools?api_key=${encodeURIComponent(key)}&school.name=${encodeURIComponent(name)}&fields=${encodeURIComponent(fields)}&per_page=${limit}`,
      );
      const results = Array.isArray(data.results) ? data.results : [];
      return {
        query: name,
        count: results.length,
        colleges: results.map((r) => ({
          name: r["school.name"] ?? null,
          state: r["school.state"] ?? null,
          tuitionOutOfStateUsd: r["latest.cost.tuition.out_of_state"] ?? null,
          admissionRate: r["latest.admissions.admission_rate.overall"] ?? null,
          undergraduateSize: r["latest.student.size"] ?? null,
        })),
        source: "api.data.gov / collegescorecard (public domain)",
      };
    },
  },

  // ---- FEC campaign finance (api.open.fec.gov) — our DATA_GOV_API_KEY ------
  {
    route: "GET /api/fec-candidates", name: "US federal candidates (FEC)", slug: "fec-candidates", category: "data", price: "$0.004",
    description:
      "Search US federal election candidates via the FEC: name, party, office (House/Senate/President), state, incumbent/challenger status, and FEC candidate ID. Live gov data. ?q=warren&limit=5",
    tags: ["fec", "elections", "candidates", "campaign-finance", "politics", "government"],
    discovery: {
      input: { q: "warren", limit: 5 },
      inputSchema: {
        properties: {
          q: { type: "string", description: "Candidate name to search" },
          limit: { type: "number", description: "Max results 1-20 (default 5)" },
        },
        required: ["q"],
      },
      output: {
        example: {
          query: "warren", count: 1,
          candidates: [{ name: "WARREN, ELIZABETH", party: "DEMOCRATIC PARTY", office: "Senate", state: "MA", status: "Incumbent", candidateId: "S2MA00170" }],
          source: "api.open.fec.gov (public domain)",
        },
      },
    },
    handler: async (i) => {
      const q = String(i.q ?? i.name ?? "").trim();
      if (!q) throw bad('"q" (candidate name) is required');
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || 5, 1), 20);
      const key = process.env.DATA_GOV_API_KEY || "DEMO_KEY";
      const data = await getJson(
        `https://api.open.fec.gov/v1/candidates/search/?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&per_page=${limit}&sort=name`,
      );
      const results = Array.isArray(data.results) ? data.results : [];
      return {
        query: q,
        count: results.length,
        candidates: results.map((r) => ({
          name: r.name ?? null,
          party: r.party_full ?? null,
          office: r.office_full ?? null,
          state: r.state ?? null,
          status: r.incumbent_challenge_full ?? null,
          candidateId: r.candidate_id ?? null,
        })),
        source: "api.open.fec.gov (public domain)",
      };
    },
  },

  // ---- USAspending.gov — federal awards (keyless, POST search) -------------
  {
    route: "GET /api/federal-awards", name: "US federal awards search (USAspending)", slug: "federal-awards", category: "data", price: "$0.005",
    description:
      "Search US federal contract awards via USAspending.gov by keyword: recipient, award amount, awarding agency, and description - largest awards first. Live gov data, no key. ?q=Lockheed&limit=5",
    tags: ["usaspending", "federal-spending", "contracts", "procurement", "government", "awards"],
    discovery: {
      input: { q: "Lockheed", limit: 5 },
      inputSchema: {
        properties: {
          q: { type: "string", description: "Keyword to search awards (recipient, program, or description text)" },
          limit: { type: "number", description: "Max results 1-20 (default 5)" },
        },
        required: ["q"],
      },
      output: {
        example: {
          query: "Lockheed", count: 2,
          awards: [{ recipient: "LOCKHEED MARTIN CORP", amountUsd: 48063737196.35, agency: "Department of Energy", awardId: "…", description: "…" }],
          source: "api.usaspending.gov (public domain)",
        },
      },
    },
    handler: async (i) => {
      const q = String(i.q ?? "").trim();
      if (!q) throw bad('"q" (keyword) is required');
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || 5, 1), 20);
      const body = JSON.stringify({
        filters: { award_type_codes: ["A", "B", "C", "D"], keywords: [q] }, // A-D = contract award types
        fields: ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Description"],
        limit, sort: "Award Amount", order: "desc",
      });
      const data = await getJson("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
        method: "POST", body, headers: { "Content-Type": "application/json", Accept: "application/json" },
      });
      const results = Array.isArray(data.results) ? data.results : [];
      return {
        query: q,
        count: results.length,
        awards: results.map((r) => ({
          recipient: r["Recipient Name"] ?? null,
          amountUsd: r["Award Amount"] != null ? Number(r["Award Amount"]) : null,
          agency: r["Awarding Agency"] ?? null,
          awardId: r["Award ID"] ?? null,
          description: (r["Description"] ?? "").replace(/\s+/g, " ").slice(0, 160),
        })),
        source: "api.usaspending.gov (public domain)",
      };
    },
  },

  // ---- Location intelligence — reliable documented gov geo APIs -----------
  // (Deliberately NOT random ArcGIS FeatureServers: several EPA/USGS ArcGIS
  // mirrors 400/503 intermittently, which fails the "must work when an agent
  // wants it" bar. These two are stable, documented, keyless endpoints.)
  {
    route: "GET /api/geo-lookup", name: "US location lookup (lat/lon)", slug: "geo-lookup", category: "data", price: "$0.003",
    description:
      "Resolve a US latitude/longitude to its county, state, and census block FIPS via the FCC Area API - the geographic context agents need for any coordinate. Live gov data, no key. ?lat=34.0522&lon=-118.2437",
    tags: ["geo", "location", "county", "census", "fips", "fcc", "government"],
    discovery: {
      input: { lat: 34.0522, lon: -118.2437 },
      inputSchema: {
        properties: {
          lat: { type: "number", description: "Latitude (-90..90)" },
          lon: { type: "number", description: "Longitude (-180..180)" },
        },
        required: ["lat", "lon"],
      },
      output: {
        example: { lat: 34.0522, lon: -118.2437, county: "Los Angeles County", state: "CA", stateName: "California", blockFips: "060372074001024", source: "geo.fcc.gov (public domain)" },
      },
    },
    handler: async (i) => {
      const lat = Number(i.lat), lon = Number(i.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        throw bad('"lat" and "lon" must be valid coordinates (lat -90..90, lon -180..180)');
      }
      const data = await getJson(`https://geo.fcc.gov/api/census/block/find?latitude=${lat}&longitude=${lon}&format=json`, { headers: { Accept: "application/json" } });
      const state = data?.State?.code ?? null;
      if (!state) throw bad("no US location found for those coordinates (is the point inside the United States?)", 422);
      return {
        lat, lon,
        county: data?.County?.name ?? null,
        state,
        stateName: data?.State?.name ?? null,
        blockFips: data?.Block?.FIPS ?? null,
        source: "geo.fcc.gov (public domain)",
      };
    },
  },
  {
    route: "GET /api/fema-disasters", name: "FEMA disaster declarations", slug: "fema-disasters", category: "data", price: "$0.004",
    description:
      "Recent FEMA disaster declarations for a US state (openFEMA): title, incident type, declaration type, and date - the federal emergency picture by state, de-duplicated by disaster. Live gov data, no key. ?state=CA&limit=5",
    tags: ["fema", "disaster", "emergency", "declarations", "openfema", "government"],
    discovery: {
      input: { state: "CA", limit: 5 },
      inputSchema: {
        properties: {
          state: { type: "string", description: "Two-letter US state/territory code (or full state name), e.g. CA" },
          limit: { type: "number", description: "Max distinct disasters 1-20 (default 5)" },
        },
        required: ["state"],
      },
      output: {
        example: {
          state: "CA", count: 1,
          disasters: [{ title: "WILDFIRES", incidentType: "Fire", declarationType: "Major Disaster", declared: "2026-01-08", disasterNumber: 4812 }],
          source: "fema.gov openFEMA (public domain)",
        },
      },
    },
    handler: async (i) => {
      const raw = String(i.state ?? "").trim();
      let st = raw.toUpperCase();
      if (!/^[A-Z]{2}$/.test(st)) {
        const code = STATE_NAME_TO_CODE[raw.toLowerCase()];
        if (code) st = code;
        else throw bad(`"state" must be a two-letter US state code (e.g. CA) or full state name. Got "${raw}".`);
      }
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || 5, 1), 20);
      // openFEMA returns one row PER COUNTY per disaster, so over-fetch the recent
      // window and de-duplicate by disasterNumber to get N distinct disasters.
      const window = Math.min(limit * 25, 300);
      const url = `https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$filter=state eq '${st}'&$top=${window}&$orderby=declarationDate desc&$select=declarationTitle,incidentType,declarationType,declarationDate,disasterNumber`;
      const data = await getJson(encodeURI(url), { headers: { Accept: "application/json" } });
      const items = Array.isArray(data?.DisasterDeclarationsSummaries) ? data.DisasterDeclarationsSummaries : [];
      const seen = new Set();
      const disasters = [];
      for (const r of items) {
        const n = r.disasterNumber;
        if (n == null || seen.has(n)) continue;
        seen.add(n);
        disasters.push({
          title: r.declarationTitle ?? null,
          incidentType: r.incidentType ?? null,
          declarationType: r.declarationType ?? null,
          declared: (r.declarationDate || "").slice(0, 10) || null,
          disasterNumber: n,
        });
        if (disasters.length >= limit) break;
      }
      return { state: st, count: disasters.length, disasters, source: "fema.gov openFEMA (public domain)" };
    },
  },
];
