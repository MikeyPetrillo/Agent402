// Attribution sentences a data source's terms require wherever its data is
// served. A tool that serves a source's data carries `attribution: "<key>"`
// (a key of ATTRIBUTIONS) and its catalog description ends with that
// sentence; a skill pack ends with the sentences of the tools it runs
// (packAttributions). The listing cut (bazaarCapDescription in
// src/payments.js) keeps a trailing run of these sentences whole, shortening
// the text before it instead. Each kit that reads a source cites the terms
// that require its sentence next to the tools that carry it.
// Dependency-free: src/payments.js, src/skills.js and the tool kits import it.

// The terms behind each sentence: FRED API Terms of Use
// (https://fred.stlouisfed.org/docs/api/terms_of_use.html, the notice the
// macro kit's FRED routes carry); CoinGecko in src/tools/coingecko-rate.js;
// Jupiter in src/tools/solana-intel-kit.js; Open-Meteo and GeoNames in
// src/tools/weather-kit.js; NVD in
// src/tools/cve-kit.js; the ECB's reuse terms, which ask that the ECB be
// cited as the source of its reference rates
// (https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html),
// in src/tools/frankfurter.js; the U.S. Treasury's yield curve (a U.S.
// government work, credit requested) in src/tools/macro-kit.js. Open-Meteo's
// air quality and reanalysis data come from Copernicus services, whose
// licences ask for their own credit beside Open-Meteo's: the air quality API
// docs (open-meteo.com/en/docs/air-quality-api) require attribution to the
// CAMS ENSEMBLE data provider, and the Copernicus licence (open-meteo.com/en/licence)
// asks for "Contains modified Copernicus ... information" where the data is
// processed (air quality answers carry a computed AQI; the archive is ERA5
// reanalysis) and, in clause 5.1.3, the disclaimer that neither the European
// Commission nor ECMWF is responsible for any use of it. Those tools carry a
// combined key (Open-Meteo's sentence, the Copernicus one, the disclaimer),
// so the run of sentences stays one tail. A tool that serves both and
// GeoNames place data (the weather-risk-brief bundle reads air quality and
// the archive, and resolves a site named by place) carries
// "open-meteo-copernicus-geonames": each source named, both Copernicus
// services in one short sentence, the disclaimer once, so that a listing's
// shortest cut (300 characters, src/payments.js) keeps the run whole; its
// answers carry each full credit.
export const FRED_NOTICE ="This product uses the FRED(R) API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.";
// The same terms ask an application others use to link the Terms of Use and
// to tell its users they are bound by them: every answer that carries FRED
// data says so in its `terms` field (termsAnswers below; the macro kit marks
// each tool whose attribution is "fred").
export const FRED_TERMS_URL = "https://fred.stlouisfed.org/docs/api/terms_of_use.html";
export const FRED_TERMS = `Users of this data are bound by the FRED API Terms of Use: ${FRED_TERMS_URL}`;
// CoinGecko's API terms ask for the credit with a link to its API page,
// shown next to the data: the description sentence carries the link, and
// every CoinGecko-backed answer carries the same sentence as `credit`
// (creditAnswers below).
export const COINGECKO_API_URL = "https://www.coingecko.com/en/api";
export const COINGECKO_ATTRIBUTION = `Data provided by CoinGecko (${COINGECKO_API_URL}).`;
export const COINGECKO_CREDIT = COINGECKO_ATTRIBUTION;
export const JUPITER_ATTRIBUTION = "Powered by Jupiter.";
export const OPEN_METEO_ATTRIBUTION = "Weather data by Open-Meteo.com (CC BY 4.0).";
// The licence (https://open-meteo.com/en/licence) asks for a link to
// Open-Meteo and a link to the licence next to its data: every answer of a
// tool that serves Open-Meteo data carries both (licensedAnswers below), with
// the credit text, beside any `credit` of the sources behind it.
export const OPEN_METEO_SITE_URL = "https://open-meteo.com/";
export const CC_BY_4_URL = "https://creativecommons.org/licenses/by/4.0/";
export const OPEN_METEO_LICENSE_FIELDS = Object.freeze({ attributionText: OPEN_METEO_ATTRIBUTION, sourceUrl: OPEN_METEO_SITE_URL, licenseUrl: CC_BY_4_URL });
// place-lookup reads Open-Meteo's geocoding API, whose place data is
// GeoNames': the same links, with a credit that says what the data is.
export const OPEN_METEO_PLACE_ATTRIBUTION = "Place data by Open-Meteo.com geocoding (GeoNames, CC BY 4.0).";
export const OPEN_METEO_PLACE_LICENSE_FIELDS = Object.freeze({ attributionText: OPEN_METEO_PLACE_ATTRIBUTION, sourceUrl: OPEN_METEO_SITE_URL, licenseUrl: CC_BY_4_URL });
// OpenFEMA's terms (https://www.fema.gov/about/openfema/terms-conditions)
// require this disclaimer wherever its data is used, and ask that the
// endpoint (with its version) and the access date be cited: the
// fema-disasters answer carries all three (src/tools/gov-kit.js).
export const FEMA_NOTICE = "This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA.";
export const NVD_NOTICE = "This product uses the NVD API but is not endorsed or certified by the NVD.";
export const ECB_ATTRIBUTION = "Source: European Central Bank.";
export const US_TREASURY_ATTRIBUTION = "Source: U.S. Treasury.";
// Network sources, each credited by name and link on the answers it serves
// (the `credit` field; no key in ATTRIBUTIONS, so a tool's catalog text and
// listing are unchanged, and the 402 sample is read without the field:
// withoutAnswerOnlyFields below). crt.sh (Sectigo's public Certificate
// Transparency search) on the cert-transparency answers it served and the
// domain-audit-pro reports whose certificate probe it answered
// (src/tools/network-kit2.js, domain-audit-kit.js); Team Cymru's IP to ASN
// Mapping service on every asn-info answer (src/tools/network-kit2.js).
export const CRTSH_ATTRIBUTION = "Certificate data from crt.sh by Sectigo (https://crt.sh).";
export const CYMRU_ATTRIBUTION = "IP to ASN data from Team Cymru IP to ASN Mapping (https://team-cymru.com/community-services/ip-asn-mapping/).";
// fred-series (src/tools/us-macro-series.js, which cites each publisher's
// terms): the publishers named and the New York Fed's disclaimer for a product
// described with its rates; each answer carries its publisher's full credit
// (the BLS statement and retrieval date, the New York Fed's notice).
export const US_AGENCIES_ATTRIBUTION = "Sources: U.S. BLS, the New York Fed and the U.S. Treasury. Agent402 is not affiliated with the New York Fed.";
// The computed macro tools (sahm-rule, cpi-yoy, unemployment-rate, fed-funds
// in src/tools/macro-kit.js) read the same publishers through
// src/tools/us-macro-series.js: each answer's `credit` opens with its
// publisher's source line, then that publisher's own statement or notice.
export const BLS_ATTRIBUTION = "Source: U.S. Bureau of Labor Statistics (https://www.bls.gov).";
export const NYFED_ATTRIBUTION = "Source: Federal Reserve Bank of New York (https://www.newyorkfed.org).";
export const CAMS_ATTRIBUTION = "Contains modified Copernicus Atmosphere Monitoring Service information (CAMS ENSEMBLE data provider).";
export const C3S_ATTRIBUTION = "Contains modified Copernicus Climate Change Service information.";
// GeoNames (CC BY 4.0, geonames.org: "give credit to GeoNames"), the place
// data behind Open-Meteo's geocoding API (open-meteo.com/en/docs/geocoding-api).
export const GEONAMES_ATTRIBUTION = "Place data from GeoNames (CC BY 4.0).";
// Nager.Date (holiday lists, src/tools/holiday-source.js): served under a
// sponsorship held for this service, which its terms require for commercial
// use (https://nagerholidays.com/legal/termsofservice; the v3 and v4 APIs share them);
// the credit names the dataset wherever its rows or answers computed from them are served.
export const NAGER_ATTRIBUTION = "Holiday data by Nager.Date.";
// Wikipedia (search-suggest reads its opensearch API, src/tools/wikipedia-suggest.js):
// the Wikimedia API usage guidelines bar a client that hides the Foundation
// as the provider, and the text is CC BY-SA 4.0, so the description and
// every answer name the source with its link and license.
export const WIKIPEDIA_ATTRIBUTION = "Suggestions from Wikipedia (CC BY-SA 4.0).";
export const WIKIPEDIA_CREDIT = "Suggestions from Wikipedia (https://en.wikipedia.org), CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).";
export const COPERNICUS_DISCLAIMER = "Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains.";
/** The Copernicus credit an answer carries: its sentence, then the disclaimer. */
export const CAMS_CREDIT = `${CAMS_ATTRIBUTION} ${COPERNICUS_DISCLAIMER}`;
export const C3S_CREDIT = `${C3S_ATTRIBUTION} ${COPERNICUS_DISCLAIMER}`;
/** Both Copernicus services in one sentence, for a description whose tool serves both. */
export const CAMS_C3S_ATTRIBUTION = "Contains modified Copernicus CAMS and C3S information.";

// Open data credited on the answers it serves (answer fields only: a tool's
// catalog text and its listing are unchanged).
//   - World Bank: the Terms of Use for Datasets
//     (https://www.worldbank.org/ext/en/legal/terms-conditions/datasets)
//     license datasets under CC BY 4.0 unless one is labeled otherwise, and
//     ask for the credit "The World Bank: Dataset name: Data source"; each
//     series' own license is in its metadata (License_Type), which
//     world-bank-indicator reads before serving it (src/tools/macro-kit.js).
//   - Open Food Facts (https://world.openfoodfacts.org/terms-of-use): the
//     database under the ODbL, its contents under the DbCL, images CC BY-SA;
//     contributors are credited by a link to the product; the API asks for a
//     User-Agent naming the app and a contact, and at most 15 product reads a
//     minute (src/tools/data-kit.js barcode-lookup, DATA_UA in src/user-agents.js).
//   - world-countries (src/data/countries.json, ODbL 1.0): a Produced Work
//     carries the notice, and its recipients are offered the derived database
//     (ODbL 4.3 and 4.6): country-info answers carry both, and the server
//     serves the database and its license (COUNTRIES_DATABASE_PATH, /data/LICENSE).
export const WORLD_BANK_LICENSE = "CC BY 4.0";
export const WORLD_BANK_LICENSE_URL = "https://datacatalog.worldbank.org/public-licenses#cc-by";
/** The World Bank's credit form: "The World Bank: <dataset>: <data source>". */
export function worldBankCredit(dataset, source) {
  const clean = (v) => String(v ?? "").replace(/\s*[\r\n]+\s*/g, " ").replace(/\s+/g, " ").replace(/[;,.\s]+$/, "").trim().slice(0, 300);
  const d = clean(dataset) || "World Development Indicators";
  const src = clean(source);
  return src ? `The World Bank: ${d}: ${src}` : `The World Bank: ${d}`;
}
export const OPEN_FOOD_FACTS_SOURCE = "Open Food Facts";
export const OPEN_FOOD_FACTS_LICENSE = "ODbL 1.0 (database), DbCL 1.0 (contents); images CC BY-SA";
export const openFoodFactsProductUrl = (code) => `https://world.openfoodfacts.org/product/${encodeURIComponent(code)}`;
export const COUNTRIES_DATABASE_PATH = "/data/countries.json";
export const COUNTRIES_LICENSE_PATH = "/data/LICENSE";
export const COUNTRIES_ODBL_NOTICE = "Contains information from world-countries, made available under the ODbL 1.0 (https://opendatacommons.org/licenses/odbl/1-0/).";
/** The address of the served database: this deployment's own copy. */
export const countriesDatabaseUrl = () => `${String(process.env.BASE_URL || "https://agent402.tools").replace(/\/+$/, "")}${COUNTRIES_DATABASE_PATH}`;

// Chain and crypto data sources, each credited with a link wherever its data
// is served. GoPlus's API terms ask for attribution "via a backlink or a
// mention" (src/tools/token-risk-kit.js); the EAS indexer, RugCheck,
// Hyperliquid's info API and Sourcify (verified source and its signature
// database) are public services for builders, credited by name and link
// (src/tools/onchain-identity-kit.js, solana-intel-kit.js, derivatives-kit.js,
// contract-kit.js). Each is credited on the answers it serves, in the `credit`
// field: every answer of a tool served wholly from one of them
// (creditAnswers), and, for a tool that reads one as a leg or whose answer
// another source can serve in its place, the answers that source served
// (addCredit). They have no key in ATTRIBUTIONS: a tool's catalog text and
// its listing are unchanged, and the 402 sample is read without the field
// (withoutAnswerOnlyFields below).
export const GOPLUS_ATTRIBUTION = "Powered by GoPlus Security (https://gopluslabs.io).";
export const EAS_ATTRIBUTION = "Indexed by EASSCAN (https://easscan.org).";
export const RUGCHECK_ATTRIBUTION = "Data from RugCheck (https://rugcheck.xyz).";
export const HYPERLIQUID_ATTRIBUTION = "Data from Hyperliquid (https://hyperliquid.xyz).";
export const SOURCIFY_ATTRIBUTION = "Verified source from Sourcify (https://sourcify.dev).";
export const SOURCIFY_SIGDB_ATTRIBUTION = "Signatures from the Sourcify signature database (https://4byte.sourcify.dev).";

/** Source key (a tool's `attribution` field) -> the sentence its terms require. */
export const ATTRIBUTIONS = Object.freeze({
  fred: FRED_NOTICE,
  coingecko: COINGECKO_ATTRIBUTION,
  jupiter: JUPITER_ATTRIBUTION,
  "open-meteo": OPEN_METEO_ATTRIBUTION,
  nvd: NVD_NOTICE,
  ecb: ECB_ATTRIBUTION,
  "us-treasury": US_TREASURY_ATTRIBUTION,
  "us-agencies": US_AGENCIES_ATTRIBUTION,
  "open-meteo-cams": `${OPEN_METEO_ATTRIBUTION} ${CAMS_CREDIT}`,
  "open-meteo-c3s": `${OPEN_METEO_ATTRIBUTION} ${C3S_CREDIT}`,
  "open-meteo-copernicus-geonames": `${OPEN_METEO_ATTRIBUTION} ${GEONAMES_ATTRIBUTION} ${CAMS_C3S_ATTRIBUTION} ${COPERNICUS_DISCLAIMER}`,
  geonames: GEONAMES_ATTRIBUTION,
  nager: NAGER_ATTRIBUTION,
  fema: FEMA_NOTICE,
  wikipedia: WIKIPEDIA_ATTRIBUTION,
});

/** Every sentence the listing cut keeps when a description ends with it. */
export const ATTRIBUTION_TAILS = Object.freeze(Object.values(ATTRIBUTIONS));

const endsWithSentence = (s, t) => s.endsWith(t) && (s.length === t.length || /\s/.test(s[s.length - t.length - 1]));

/** The run of attribution sentences `s` ends with (one or more, separated by
 *  single spaces), or null. Each step strips one known sentence off the end,
 *  so the walk is bounded by the number of sentences, not the text length. */
export function attributionTailOf(s) {
  if (typeof s !== "string") return null;
  let rest = s, start = s.length;
  for (let n = 0; n < ATTRIBUTION_TAILS.length; n++) {
    const t = ATTRIBUTION_TAILS.find((x) => endsWithSentence(rest, x));
    if (!t) break;
    start = rest.length - t.length;
    rest = rest.slice(0, start).replace(/ $/, "");
  }
  return start < s.length ? s.slice(start) : null;
}

/** Mark `tool` as serving `key`'s data: set its `attribution` field and end
 *  its description with the source's sentence (once). */
export function attribute(tool, key) {
  const sentence = ATTRIBUTIONS[key];
  if (!sentence) throw new Error(`unknown attribution key "${key}"`);
  tool.attribution = key;
  if (!endsWithSentence(String(tool.description || ""), sentence)) tool.description = `${tool.description} ${sentence}`;
  return tool;
}

/** The attribution sentences of the tools a skill pack runs, in the order the
 *  pack first names each source. `toolBySlug(slug)` returns a tool or null. */
export function packAttributions(toolSlugs, toolBySlug) {
  const keys = [];
  for (const slug of toolSlugs || []) {
    const key = toolBySlug(slug)?.attribution;
    if (key && ATTRIBUTIONS[key] && !keys.includes(key)) keys.push(key);
  }
  const sentences = keys.map((k) => ATTRIBUTIONS[k]);
  // A combined key holds a shorter one's sentence: keep only the longer.
  return sentences.filter((x) => !sentences.some((y) => y !== x && y.includes(x)));
}

/** `text` followed by each of `sentences` it does not already end with. */
export function withAttributions(text, sentences) {
  const s = String(text ?? "").trimEnd();
  const tail = attributionTailOf(s) || "";
  const missing = (sentences || []).filter((x) => !tail.includes(x));
  return missing.length ? `${s} ${missing.join(" ")}` : s;
}

/** `text` with every attribution sentence taken out: the text the catalog
 *  search ranks on (src/find.js, catalog.search in src/mcp-http.js). The
 *  sentences are legal notices, not what a tool does, so a query never
 *  matches a tool by its notice. */
export function withoutAttributions(text) {
  let s = String(text ?? "");
  // Longest first, so a combined sentence leaves no part of itself behind.
  for (const t of [...ATTRIBUTION_TAILS].sort((a, b) => b.length - a.length)) if (s.includes(t)) s = s.split(t).join(" ");
  return s;
}

const isPlainAnswer = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !v.__binary;

/** `answer` with `credit` in its `credit` field: a plain-object answer with
 *  no credit gets a copy with the field; one whose credit is a string that
 *  does not already hold this sentence gets a copy with the sentence after
 *  it, so an answer built from several sources credits each. Anything else
 *  (a non-object, a credit that is not a string) is returned as it is. */
export function withCredit(answer, credit) {
  if (!isPlainAnswer(answer)) return answer;
  if (!Object.hasOwn(answer, "credit")) return { ...answer, credit };
  const cur = answer.credit;
  if (typeof cur !== "string" || cur.includes(credit)) return answer;
  return { ...answer, credit: cur ? `${cur} ${credit}` : credit };
}

/** The same as withCredit, for a handler crediting a source one of its legs
 *  read (the leg answered). */
export const addCredit = withCredit;

/** Mark `tool` as one whose answers carry `credit` (a source's credit
 *  sentence with its link): set `tool.credit`, add the field to the published
 *  example, and wrap the handler so every answer carries it. Additive: no
 *  field of the answer is changed or removed. Idempotent per tool. */
export function creditAnswers(tool, credit) {
  if (typeof credit !== "string" || !credit) throw new Error("creditAnswers: credit must be a sentence");
  if (tool.credit === credit) return tool;
  tool.credit = credit;
  const ex = tool.discovery?.output?.example;
  if (isPlainAnswer(ex)) tool.discovery.output.example = withCredit(ex, credit);
  const inner = tool.handler;
  if (typeof inner === "function") {
    tool.handler = async function credited(...args) { return withCredit(await inner.apply(this, args), credit); };
  }
  return tool;
}

/** Mark `tool` as one whose answers carry `terms` (a source's terms-of-use
 *  line with its link): set `tool.terms`, add the field to the published
 *  example, and wrap the handler so every plain-object answer carries it.
 *  Additive, and idempotent per tool. */
export function termsAnswers(tool, terms) {
  if (typeof terms !== "string" || !terms) throw new Error("termsAnswers: terms must be a sentence");
  if (tool.terms === terms) return tool;
  tool.terms = terms;
  const ex = tool.discovery?.output?.example;
  if (isPlainAnswer(ex) && !Object.hasOwn(ex, "terms")) tool.discovery.output.example = { ...ex, terms };
  const inner = tool.handler;
  if (typeof inner === "function") {
    tool.handler = async function withTerms(...args) {
      const answer = await inner.apply(this, args);
      return isPlainAnswer(answer) && !Object.hasOwn(answer, "terms") ? { ...answer, terms } : answer;
    };
    // The guards that read a handler's source for the hosts and helpers it
    // names (scripts/test-bazaar-descriptions.js) read the tool's own code.
    Object.defineProperty(tool.handler, "toString", { value: () => String(inner) });
  }
  return tool;
}

/** Mark `tool` as one whose answers carry `fields` (a source's licence
 *  fields: its credit text and links): set `tool.licenseFields`, add each
 *  field the published example lacks, and wrap the handler so every
 *  plain-object answer carries each field it does not already hold.
 *  Additive (no field is renamed or replaced), and idempotent per tool. */
export function licensedAnswers(tool, fields) {
  if (!fields || typeof fields !== "object" || !Object.keys(fields).length) throw new Error("licensedAnswers: fields must name at least one field");
  if (tool.licenseFields === fields) return tool;
  tool.licenseFields = fields;
  const add = (v) => {
    if (!isPlainAnswer(v)) return v;
    const missing = Object.keys(fields).filter((k) => !Object.hasOwn(v, k));
    return missing.length ? { ...v, ...Object.fromEntries(missing.map((k) => [k, fields[k]])) } : v;
  };
  const ex = tool.discovery?.output?.example;
  if (isPlainAnswer(ex)) tool.discovery.output.example = add(ex);
  const inner = tool.handler;
  if (typeof inner === "function") {
    tool.handler = async function licensed(...args) { return add(await inner.apply(this, args)); };
    Object.defineProperty(tool.handler, "toString", { value: () => String(inner) });
  }
  return tool;
}

/** Every tool in `tools` that serves Open-Meteo data (an "open-meteo"
 *  attribution key) carries the Open-Meteo licence fields on every answer;
 *  each of `placeSlugs` (place data read through its geocoding API) carries
 *  them with the place credit. */
export function openMeteoLicensed(tools, placeSlugs = []) {
  for (const t of tools) {
    if (placeSlugs.includes(t.slug)) licensedAnswers(t, OPEN_METEO_PLACE_LICENSE_FIELDS);
    else if (String(t.attribution || "").startsWith("open-meteo")) licensedAnswers(t, OPEN_METEO_LICENSE_FIELDS);
  }
  return tools;
}

/** `example` without the licence fields licensedAnswers adds (each removed
 *  only where it holds one of those constant values): the sample a 402
 *  listing carries, whose room goes to the description and the answer's own
 *  fields. Anything that is not a plain object is returned as it is. */
export function withoutLicenseFields(example) {
  if (!isPlainAnswer(example)) return example;
  const sets = [OPEN_METEO_LICENSE_FIELDS, OPEN_METEO_PLACE_LICENSE_FIELDS];
  const drop = new Set(Object.keys(example).filter((k) => sets.some((f) => Object.hasOwn(f, k) && example[k] === f[k])));
  return drop.size ? Object.fromEntries(Object.entries(example).filter(([k]) => !drop.has(k))) : example;
}

// The chain and crypto source credits above and the license fields of
// verified source files (contract-source): the same on every answer that
// carries them, and in /openapi.json's example. The 402 sample is read
// without them (withoutAnswerOnlyFields), so they never take room from the
// listing's description or the answer's own fields.
export const SOURCE_LICENSE_NOTE = "Each file is its authors' work, under the license its SPDX-License-Identifier states (licenses, by file; null where a file states none). Reuse of a file follows its license.";
const ANSWER_ONLY_CREDITS = Object.freeze([GOPLUS_ATTRIBUTION, EAS_ATTRIBUTION, RUGCHECK_ATTRIBUTION, HYPERLIQUID_ATTRIBUTION, SOURCIFY_ATTRIBUTION, SOURCIFY_SIGDB_ATTRIBUTION, CRTSH_ATTRIBUTION, CYMRU_ATTRIBUTION]);

/** `example` without a `credit` made only of the credits above, and without
 *  the source license fields (the note and the per-file map beside it).
 *  Anything else is returned as it is. */
export function withoutAnswerOnlyFields(example) {
  if (!isPlainAnswer(example)) return example;
  const drop = new Set();
  if (typeof example.credit === "string") {
    let rest = example.credit;
    for (const t of ANSWER_ONLY_CREDITS) rest = rest.split(t).join(" ");
    if (!rest.trim()) drop.add("credit");
  }
  if (example.licenseNote === SOURCE_LICENSE_NOTE) { drop.add("licenseNote"); drop.add("licenses"); }
  return drop.size ? Object.fromEntries(Object.entries(example).filter(([k]) => !drop.has(k))) : example;
}
