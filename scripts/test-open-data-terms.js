// The open-data sources whose terms ask for a credit, a license check or a
// pace (offline: fetch is stubbed per host, names resolve in-process):
//   1. World Bank: world-bank-indicator reads each indicator's license from
//      the World Bank's own series metadata (cached a day) and serves only an
//      indicator licensed CC BY 4.0 (or CC0); any other, or none stated, is a
//      422 naming the license, with no data in it. Each answer carries the
//      credit "The World Bank: <dataset>: <source>", the license and its link;
//      world-bank-search carries the dataset credit and license.
//   2. Open Food Facts: barcode-lookup sends a User-Agent naming this service
//      and a contact address, answers with the source, the license and a link
//      to the product, and reads at most 15 products a minute (a cached
//      product is free; past the pace, a 503 with Retry-After).
//   3. world-countries: country-info answers carry the ODbL notice and the
//      address of the database, and the server serves the database and its
//      license at /data/countries.json and /data/LICENSE.
// The credits ride the answers only: no tool's description changes.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { stubGuardResolver, offlineGuardAnswer } from "./lib/guard-resolver-stub.js";
import { MACRO_TOOLS, _resetWorldBankForTest } from "../src/tools/macro-kit.js";
import { DATA_TOOLS, _resetOpenFoodFactsForTest, OFF_READS_PER_MINUTE } from "../src/tools/data-kit.js";
import { WORLD_BANK_LICENSE, WORLD_BANK_LICENSE_URL, OPEN_FOOD_FACTS_LICENSE, COUNTRIES_ODBL_NOTICE, COUNTRIES_DATABASE_PATH, countriesDatabaseUrl } from "../src/data-attribution.js";
import { DATA_UA, DATA_CONTACT } from "../src/user-agents.js";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };
const wb = (slug) => MACRO_TOOLS.find((t) => t.slug === slug);
const data = (slug) => DATA_TOOLS.find((t) => t.slug === slug);

// The credits are answer fields: no description carries them (the 402
// listings stay as they were; scripts/test-bazaar-listing-parity.js).
for (const slug of ["world-bank-indicator", "world-bank-search", "barcode-lookup", "country-info"]) {
  const t = wb(slug) || data(slug);
  ok(t && !/The World Bank:|CC BY 4\.0|DbCL|Contains information from world-countries/.test(t.description) && !t.attribution, `${slug}: the description carries no answer credit`);
}

const realFetch = globalThis.fetch;
const undoDns = stubGuardResolver(offlineGuardAnswer);
const reads = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const LICENSES = { "NY.GDP.MKTP.CD": "CC BY-4.0", "XX.CUSTOM.ONE": "Custom", "XX.CC0.ONE": "CC0", "XX.NONE.ONE": null };
const meta = (id, license) => ({ page: 1, pages: 1, total: 3, source: [{ id: "2", name: "World Development Indicators", concept: [{ id: "Series", variable: [{ id, metatype: [
  { id: "IndicatorName", value: `Name of ${id}` },
  ...(license ? [{ id: "License_Type", value: license }, { id: "License_URL", value: "https://datacatalog.worldbank.org/public-licenses#cc-by" }] : []),
  { id: "Source", value: "Country official statistics,\nNational Accounts data files" },
] }] }] }] });
let offStatus = 200;
globalThis.fetch = async (input, opts = {}) => {
  const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  const headers = new Headers(opts.headers || (input instanceof Request ? input.headers : undefined));
  reads.push({ host: u.hostname, path: u.pathname, ua: headers.get("user-agent") });
  if (u.hostname === "api.worldbank.org") {
    let m;
    if ((m = /^\/v2\/indicator\/([^/]+)$/.exec(u.pathname))) {
      if (!(m[1] in LICENSES)) return json([{ message: [{ id: "120", key: "Invalid value", value: "The provided parameter value is not valid" }] }]);
      return json([{ page: 1 }, [{ id: m[1], name: `Name of ${m[1]}`, source: { id: "2", value: "World Development Indicators" } }]]);
    }
    if ((m = /^\/v2\/sources\/2\/series\/([^/]+)\/metadata$/.exec(u.pathname))) return json(meta(m[1], LICENSES[m[1]]));
    if ((m = /^\/v2\/country\/([^/]+)\/indicator\/([^/]+)$/.exec(u.pathname))) {
      if (!(m[2] in LICENSES)) return json([{ message: [{ id: "120", key: "Invalid value", value: "The provided parameter value is not valid" }] }]);
      return json([{ page: 1 }, [{ indicator: { id: m[2], value: `Name of ${m[2]}` }, country: { id: "US", value: "United States" }, date: "2022", value: 25462700000000 }, { indicator: { id: m[2], value: `Name of ${m[2]}` }, country: { id: "US", value: "United States" }, date: "2021", value: 23315080560000 }]]);
    }
    if (u.pathname === "/v2/source/2/indicator") return json([{ page: 1 }, [{ id: "FP.CPI.TOTL.ZG", name: "Inflation, consumer prices (annual %)", sourceNote: "Inflation as measured by the consumer price index" }]]);
  }
  if (u.hostname === "world.openfoodfacts.org") {
    if (offStatus !== 200) return new Response("busy", { status: offStatus });
    const code = u.pathname.split("/").pop().replace(/\.json$/, "");
    return json({ status: 1, code, product: { product_name: `Product ${code}`, brands: "Brand", categories: "Snacks", quantity: "100 g", nutrition_grades: "c", countries: "France", image_url: `https://images.openfoodfacts.org/images/products/${code}/front.jpg` } });
  }
  return new Response("unexpected host", { status: 599 });
};

try {
  // --- 1. World Bank ------------------------------------------------------------------------
  _resetWorldBankForTest();
  const a = await wb("world-bank-indicator").handler({ country: "US", indicator: "NY.GDP.MKTP.CD", startYear: 2021, endYear: 2022 });
  ok(a.count === 2 && a.series[1].year === 2022 && a.indicatorName && a.source === "World Bank Open Data API", `world-bank-indicator: the series as before (${a.count})`);
  ok(a.credit === "The World Bank: World Development Indicators: Country official statistics, National Accounts data files" && a.license === WORLD_BANK_LICENSE && a.licenseUrl === WORLD_BANK_LICENSE_URL, `world-bank-indicator: the credit in the World Bank's form, with the license and its link (${a.credit})`);
  const metaReads = () => reads.filter((r) => r.host === "api.worldbank.org" && /\/metadata$/.test(r.path)).length;
  const m1 = metaReads();
  await wb("world-bank-indicator").handler({ country: "DE", indicator: "NY.GDP.MKTP.CD" });
  ok(metaReads() === m1, "world-bank-indicator: an indicator's license is read once and kept");
  const custom = await caught(wb("world-bank-indicator").handler({ country: "US", indicator: "XX.CUSTOM.ONE" }, { headers: {} }));
  ok(custom?.statusCode === 422 && /Custom/.test(custom.message) && /CC BY 4\.0/.test(custom.message) && /Nothing was charged/.test(custom.message) && !("series" in custom), `world-bank-indicator: an indicator under another license is a 422 naming it (${custom?.statusCode} ${custom?.message})`);
  const none = await caught(wb("world-bank-indicator").handler({ country: "US", indicator: "XX.NONE.ONE" }));
  ok(none?.statusCode === 422 && /states no license/.test(none.message), `world-bank-indicator: an indicator whose metadata states no license is refused (${none?.message})`);
  const cc0 = await wb("world-bank-indicator").handler({ country: "US", indicator: "XX.CC0.ONE" });
  ok(cc0.license === "CC0" && cc0.count === 2, "world-bank-indicator: a CC0 indicator is served under CC0");
  const unknown = await caught(wb("world-bank-indicator").handler({ country: "US", indicator: "NO.SUCH.ONE" }));
  ok(unknown?.statusCode === 400 && /check the indicator/.test(unknown.message), `world-bank-indicator: an unknown indicator is still the buyer's 400 (${unknown?.statusCode})`);
  const s = await wb("world-bank-search").handler({ q: "inflation" });
  ok(s.count === 1 && /^The World Bank: World Development Indicators/.test(s.credit) && s.license === WORLD_BANK_LICENSE && s.licenseUrl === WORLD_BANK_LICENSE_URL, `world-bank-search: the dataset credit and license (${s.credit})`);

  // --- 2. Open Food Facts --------------------------------------------------------------------
  _resetOpenFoodFactsForTest();
  const b = await data("barcode-lookup").handler({ code: "3017620422003" });
  const offReads = () => reads.filter((r) => r.host === "world.openfoodfacts.org");
  ok(b.product?.name === "Product 3017620422003" && b.source === "Open Food Facts" && b.license === OPEN_FOOD_FACTS_LICENSE && b.productUrl === "https://world.openfoodfacts.org/product/3017620422003", `barcode-lookup: source, license and the product link (${JSON.stringify({ source: b.source, productUrl: b.productUrl })})`);
  ok(offReads().at(-1)?.ua === DATA_UA && DATA_UA.startsWith("Agent402-Data/1.0 (") && DATA_UA.includes(DATA_CONTACT) && /@agent402\.tools/.test(DATA_CONTACT), `barcode-lookup: the User-Agent names this service, its version and a contact (${offReads().at(-1)?.ua})`);
  const n0 = offReads().length;
  await data("barcode-lookup").handler({ code: "3017620422003" });
  ok(offReads().length === n0, "barcode-lookup: a cached product is not read again");
  _resetOpenFoodFactsForTest();
  for (let k = 0; k < OFF_READS_PER_MINUTE; k++) await data("barcode-lookup").handler({ code: String(4000000000000 + k) });
  const n1 = offReads().length;
  const paced = await caught(data("barcode-lookup").handler({ code: "4999999999999" }));
  ok(OFF_READS_PER_MINUTE === 15 && paced?.statusCode === 503 && Number(paced.retryAfter) > 0 && offReads().length === n1, `barcode-lookup: the 16th product read in a minute waits (503, Retry-After ${paced?.retryAfter}), and nothing is read`);
  const cachedUnderPace = await data("barcode-lookup").handler({ code: String(4000000000000) });
  ok(cachedUnderPace.product?.name === "Product 4000000000000", "barcode-lookup: a cached product is served while the pace holds");

  // --- 3. world-countries ---------------------------------------------------------------------
  const c = await data("country-info").handler({ code: "FR" });
  ok(c.license === COUNTRIES_ODBL_NOTICE && c.database === countriesDatabaseUrl() && c.database.endsWith(COUNTRIES_DATABASE_PATH) && c.found === true && /ODbL 1\.0/.test(c.license) && /opendatacommons\.org\/licenses\/odbl\/1-0/.test(c.license), `country-info: the ODbL notice and the database address (${c.database})`);
} catch (err) {
  ok(false, `a stubbed run threw: ${err?.stack || err}`);
} finally {
  globalThis.fetch = realFetch;
  undoDns();
}

// --- the served database and license ------------------------------------------------------------
{
  const srv = await bootServer({ env: { FREE_MODE: "true" } });
  try {
    const db = await fetch(`${srv.url}${COUNTRIES_DATABASE_PATH}`);
    const body = await db.text();
    ok(db.status === 200 && /json/.test(db.headers.get("content-type") || "") && body === readFileSync(new URL("../src/data/countries.json", import.meta.url), "utf8"), `${COUNTRIES_DATABASE_PATH} serves the committed database as it is (${db.status})`);
    const lic = await fetch(`${srv.url}/data/LICENSE`);
    const licBody = await lic.text();
    ok(lic.status === 200 && /text\/plain/.test(lic.headers.get("content-type") || "") && licBody === readFileSync(new URL("../src/data/LICENSE.md", import.meta.url), "utf8") && /ODbL|Open Database License/.test(licBody), `/data/LICENSE serves the license (${lic.status})`);
    const other = await fetch(`${srv.url}/data/../package.json`);
    const other2 = await fetch(`${srv.url}/data/package.json`);
    ok(other2.status === 404 && !(await other.text()).includes('"dependencies"'), "nothing else under /data is served");
  } finally {
    await srv.stop();
  }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
