// The credits two data sources' terms require in every answer (offline:
// fetch is stubbed and names resolve in-process):
//   1. Open-Meteo (CC BY 4.0, https://open-meteo.com/en/licence): every tool
//      that serves its data carries the credit text, a link to Open-Meteo and
//      a link to the licence in each answer and in its published example,
//      beside the GeoNames and Copernicus credits it already had, on the
//      public route and on a /ref copy alike;
//   2. OpenFEMA: fema-disasters' description ends with the disclaimer its
//      terms require, and each answer carries the disclaimer, the endpoint it
//      read (with its version) and the access date, on both datasets, and
//      no license wording beside it.
// Additive: no field an answer had is renamed or removed.
//
//   node scripts/test-source-credits.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { stubGuardResolver, offlineGuardAnswer } from "./lib/guard-resolver-stub.js";
import { WEATHER_TOOLS } from "../src/tools/weather-kit.js";
import { WEATHER_PROBABILITY_TOOLS } from "../src/tools/weather-probability-kit.js";
import { WEATHER_PLAN_TOOLS } from "../src/tools/weather-plan-kit.js";
import { BUNDLE_TOOLS } from "../src/tools/bundle-kit.js";
import { GOV_TOOLS } from "../src/tools/gov-kit.js";
import { refAnswerOf } from "../src/resale-terms.js";
import { OPEN_METEO_LICENSE_FIELDS, OPEN_METEO_PLACE_LICENSE_FIELDS, OPEN_METEO_PLACE_ATTRIBUTION, withoutLicenseFields, OPEN_METEO_ATTRIBUTION, OPEN_METEO_SITE_URL, CC_BY_4_URL, GEONAMES_ATTRIBUTION, C3S_CREDIT, FEMA_NOTICE, ATTRIBUTIONS } from "../src/data-attribution.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

ok(OPEN_METEO_SITE_URL === "https://open-meteo.com/" && CC_BY_4_URL === "https://creativecommons.org/licenses/by/4.0/", "the links are Open-Meteo's site and the CC BY 4.0 licence");
ok(FEMA_NOTICE === "This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA." && ATTRIBUTIONS.fema === FEMA_NOTICE, "the FEMA disclaimer is the sentence its terms require, under the key fema");

// --- 1. Open-Meteo ---------------------------------------------------------------
const ALL = [...WEATHER_TOOLS, ...WEATHER_PROBABILITY_TOOLS, ...WEATHER_PLAN_TOOLS, ...BUNDLE_TOOLS];
const meteo = ALL.filter((t) => String(t.attribution || "").startsWith("open-meteo") || t.slug === "place-lookup");
const EXPECT = ["weather-current", "weather-daily", "weather-hourly", "weather-history", "weather-air-quality", "place-lookup", "weather-probability", "weather-market-brackets", "weather-market-board", "weather-window", "weather-thresholds", "weather-risk-brief"];
ok(EXPECT.every((s) => meteo.some((t) => t.slug === s)) && meteo.length === EXPECT.length, `the twelve tools that serve Open-Meteo data are found (${meteo.map((t) => t.slug).join(", ")})`);
const carries = (a, text = OPEN_METEO_ATTRIBUTION) => a && a.attributionText === text && a.sourceUrl === OPEN_METEO_SITE_URL && a.licenseUrl === CC_BY_4_URL;
const textOf = (t) => (t.slug === "place-lookup" ? OPEN_METEO_PLACE_ATTRIBUTION : OPEN_METEO_ATTRIBUTION);
const missingEx = meteo.filter((t) => !carries(t.discovery?.output?.example, textOf(t))).map((t) => t.slug);
ok(missingEx.length === 0, `every one's published example carries the credit text and both links (missing: ${missingEx.join(", ") || "none"})`);
ok(meteo.every((t) => typeof t.discovery.output.example.source === "string" || t.slug === "weather-risk-brief"), "the examples keep their source field");
ok(ALL.filter((t) => !meteo.includes(t)).every((t) => !("licenseUrl" in (t.discovery?.output?.example || {}))), "a tool on another source carries no Open-Meteo links");

// The 402 sample is read without these constant fields, so they never take
// room from a listing's description or sample; /openapi.json keeps them.
{
  const ex = { lat: 1, days: [], source: "x", ...OPEN_METEO_LICENSE_FIELDS };
  const w = withoutLicenseFields(ex);
  ok(!("licenseUrl" in w) && !("sourceUrl" in w) && !("attributionText" in w) && w.source === "x" && "licenseUrl" in ex, "withoutLicenseFields drops the three fields from a copy and keeps the rest");
  const p = withoutLicenseFields({ q: 1, ...OPEN_METEO_PLACE_LICENSE_FIELDS });
  ok(Object.keys(p).join() === "q", "and the place credit's fields");
  const own = { sourceUrl: "https://example.com/x", licenseUrl: "https://example.com/l" };
  ok(withoutLicenseFields(own) === own, "a field of the same name with another value is the answer's own and stays");
  const { readFileSync } = await import("node:fs");
  ok(/const example = withoutAnswerOnlyFields\(withoutLicenseFields\(slim\.output\.example\)\);/.test(readFileSync(new URL("../src/payments.js", import.meta.url), "utf8")), "the 402 listing builder reads the sample without them, before its byte bounds");
}

// Real handlers against a stubbed upstream.
const realFetch = globalThis.fetch;
const undoDns = stubGuardResolver(offlineGuardAnswer);
const seen = [];
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  seen.push(u.host + u.pathname);
  if (u.pathname === "/v1/forecast") return json({ latitude: 48.86, longitude: 2.35, timezone: "Europe/Paris", current: { time: "2026-11-23T12:00", temperature_2m: 8.1, relative_humidity_2m: 80, apparent_temperature: 6, is_day: 1, precipitation: 0, weather_code: 3, cloud_cover: 90, pressure_msl: 1012, wind_speed_10m: 10, wind_direction_10m: 200, wind_gusts_10m: 20 } });
  if (u.pathname === "/v1/archive") return json({ latitude: 51.5, longitude: -0.13, timezone: "Europe/London", daily: { time: ["2025-06-01"], temperature_2m_max: [20], temperature_2m_min: [11], precipitation_sum: [0], wind_speed_10m_max: [15], weather_code: [1] } });
  if (u.pathname === "/v1/search") return json({ results: [{ name: "Paris", latitude: 48.85, longitude: 2.35, country: "France", country_code: "FR", admin1: "Ile-de-France", timezone: "Europe/Paris" }] });
  if (u.pathname.endsWith("/DisasterDeclarationsSummaries")) return json({ DisasterDeclarationsSummaries: u.searchParams.get("$filter")?.includes("'TX'") ? [] : [{ declarationTitle: "WILDFIRES", incidentType: "Fire", declarationType: "DR", declarationDate: "2026-01-08T00:00:00Z", disasterNumber: 4812 }] });
  if (u.pathname.endsWith("/FemaWebDisasterDeclarations")) return json({ FemaWebDisasterDeclarations: [{ disasterName: "SEVERE STORMS", incidentType: "Severe Storm", declarationType: "DR", declarationDate: "2026-02-01T00:00:00Z", disasterNumber: 4820 }] });
  return new Response("not stubbed", { status: 404 });
};
const tool = (slug) => [...ALL, ...GOV_TOOLS].find((t) => t.slug === slug);
try {
  const cur = await tool("weather-current").handler({ lat: 48.86, lon: 2.35 });
  ok(carries(cur) && cur.source === "api.open-meteo.com (CC BY 4.0)" && cur.current?.temperature === 8.1, `weather-current: the answer carries the credit and both links beside its own fields (${JSON.stringify({ sourceUrl: cur.sourceUrl, licenseUrl: cur.licenseUrl })})`);
  const ref = refAnswerOf(tool("weather-current"), cur);
  ok(carries(ref), "weather-current: a /ref copy serves the same credit and links");
  const hist = await tool("weather-history").handler({ lat: 51.5, lon: -0.13, start: "2025-06-01", end: "2025-06-01" });
  ok(carries(hist) && hist.credit === C3S_CREDIT, "weather-history: the Open-Meteo credit and links sit beside the Copernicus credit");
  const place = await tool("place-lookup").handler({ q: "Paris", query: "Paris", name: "Paris" });
  ok(carries(place, OPEN_METEO_PLACE_ATTRIBUTION) && /^Place data/.test(place.attributionText) && place.credit === GEONAMES_ATTRIBUTION, `place-lookup: the GeoNames credit is unchanged and the Open-Meteo links are added (${JSON.stringify(place).slice(0, 160)})`);
  ok(carries(refAnswerOf(tool("place-lookup"), place), OPEN_METEO_PLACE_ATTRIBUTION), "place-lookup: a /ref copy serves them too");

  // --- 2. OpenFEMA ---------------------------------------------------------------
  const fema = tool("fema-disasters");
  ok(fema.attribution === "fema" && fema.description.endsWith(FEMA_NOTICE), "fema-disasters: the description ends with the OpenFEMA disclaimer");
  const ex = fema.discovery.output.example;
  ok(ex.disclaimer === FEMA_NOTICE && /\/api\/open\/v\d+\/DisasterDeclarationsSummaries$/.test(ex.endpoint) && /^\d{4}-\d{2}-\d{2}$/.test(ex.accessed) && typeof ex.source === "string", "fema-disasters: the published example carries the disclaimer, the versioned endpoint and an access date");
  const today = new Date().toISOString().slice(0, 10);
  const a = await fema.handler({ state: "CA", limit: 1 });
  ok(a.disclaimer === FEMA_NOTICE && a.endpoint === "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries" && a.accessed === today && a.count === 1 && typeof a.source === "string", `fema-disasters: the answer cites the v2 summaries endpoint read and today's date (${JSON.stringify({ endpoint: a.endpoint, accessed: a.accessed })})`);
  const b = await fema.handler({ state: "TX", limit: 1 });
  ok(b.disclaimer === FEMA_NOTICE && b.endpoint === "https://www.fema.gov/api/open/v1/FemaWebDisasterDeclarations" && b.accessed === today && b.count === 1, `fema-disasters: the fallback answer cites the v1 dataset it read (${b.endpoint})`);
  ok(refAnswerOf(fema, a).disclaimer === FEMA_NOTICE, "fema-disasters: a /ref copy serves the disclaimer");
  // The credit is the sentence OpenFEMA's terms require, and nothing in the
  // answer states a license those terms do not use.
  const noLicenseWords = (v) => !/public domain/i.test(JSON.stringify(v));
  ok(noLicenseWords(ex) && noLicenseWords(a) && noLicenseWords(b) && /OpenFEMA/.test(a.source) && /OpenFEMA/.test(b.source), `fema-disasters: the example and both answers name OpenFEMA with no license wording beside the disclaimer (${a.source} | ${b.source})`);
} catch (e) {
  ok(false, `a stubbed run threw: ${e?.stack || e}`);
} finally {
  globalThis.fetch = realFetch;
  undoDns();
}
ok(seen.length >= 5, `the handlers read the stubbed upstream (${seen.length} reads)`);
// 3. The government credit lines: USGS on earthquakes, the FDA on every
// openFDA tool, and the Census Bureau's statement on a geo-lookup answer the
// Census geocoder served (an answer from another agency is not credited to it).
{
  const { USGS_CREDIT, CENSUS_CREDIT, OPENFDA_CREDIT } = await import("../src/data-attribution.js");
  const gt = (slug) => GOV_TOOLS.find((t) => t.slug === slug);
  ok(gt("earthquakes").credit === USGS_CREDIT && gt("earthquakes").discovery.output.example.credit === USGS_CREDIT && USGS_CREDIT === "Credit: U.S. Geological Survey.", "earthquakes: every answer and the example credit USGS");
  const fda = ["drug-adverse-events", "drug-label", "drug-ndc", "drug-recalls", "device-510k", "device-adverse-events", "device-recalls", "food-recalls"];
  ok(fda.every((s) => gt(s)?.credit === OPENFDA_CREDIT), `the openFDA tools credit the FDA (${fda.filter((s) => gt(s)?.credit !== OPENFDA_CREDIT).join(",") || "all"})`);
  ok(/not endorsed or certified by the Census Bureau/.test(CENSUS_CREDIT) && gt("geo-lookup").discovery.output.example.credit === CENSUS_CREDIT, "geo-lookup: the Census statement rides the example the Census geocoder served");
  const realFetch2 = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (/census\.gov/.test(u)) return new Response(JSON.stringify({ result: { geographies: { "2020 Census Blocks": [{ GEOID: "060372074001024", STATE: "06", COUNTY: "037" }], Counties: [{ NAME: "Los Angeles County", STATE: "06" }], States: [{ STUSAB: "CA", NAME: "California" }] } } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 500 });
    };
    let a; try { a = await gt("geo-lookup").handler({ lat: 34.0522, lon: -118.2437 }); } catch (e) { a = { error: e.message }; }
    ok(!/census\.gov/.test(String(a.source || "")) || a.credit === CENSUS_CREDIT, `a Census-served geo-lookup answer carries the statement (${JSON.stringify(a).slice(0, 160)})`);
  } finally { globalThis.fetch = realFetch2; }
}

console.log(`\ntest-source-credits: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
