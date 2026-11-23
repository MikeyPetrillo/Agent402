// The AWS Marketplace listing's tool groups (src/aws-marketplace-gate.js).
//
// One list feeds three readers: the gate's default slug set
// (AWS_DEFAULT_SLUGS, used when AWS_MARKETPLACE_SLUGS is unset), the buyer
// setup page at /aws/start (src/aws-start-page.js) and the listing's OpenAPI
// document at /aws/openapi.json (src/aws-openapi.js). A group carries the
// notice every tool in it is sold under; the page prints it above the group's
// table and the OpenAPI document repeats it on each operation.
//
// A slug listed here is still checked at boot like any other: one the gate
// refuses is left out with its reason, and drops off the page and the
// document with it. A tool served through AWS_MARKETPLACE_SLUGS that no group
// names is shown under OTHER_GROUP.
//
// Held from the first submission until AWS Seller Operations answers:
// edgar-insider-trades (names people and their securities trades) and
// fec-candidates (names candidates with their party).

const FINANCIAL = "Informational market and public-filing data; not investment, trading, tax or legal advice. No trading, custody or order execution.";

export const AWS_LISTING_GROUPS = Object.freeze([
  {
    id: "guards",
    title: "Compliance and safety guards",
    slugs: ["redact", "sql-guard", "email-guard", "sanctions-name", "sanctions-wallet"],
    notice: "Best-effort automated checks; review results before acting. The sanctions screens are a screening aid against the published OFAC SDN list: not a compliance determination, legal advice or clearance. A miss is not a clearance; confirm a hit against the official list.",
  },
  {
    id: "sec",
    title: "SEC filings",
    slugs: ["edgar-13f-dataset-head", "edgar-13f-datasets", "edgar-13f-holdings", "edgar-company-concept", "edgar-company-facts", "edgar-company-lookup", "edgar-filings", "edgar-recent-ipos", "edgar-search", "edgar-xbrl-frame"],
    notice: `${FINANCIAL} Data from SEC EDGAR.`,
  },
  {
    id: "treasury",
    title: "Treasury rates and FX",
    slugs: ["treasury-avg-rates", "treasury-debt", "treasury-yield-curve", "treasury-yield-history", "yield-curve-spread", "fx-rate"],
    notice: `${FINANCIAL} Data from the US Treasury and European Central Bank reference rates; exchange rates are for information, not for transactions.`,
  },
  {
    id: "fda",
    title: "FDA data",
    slugs: ["device-510k", "device-adverse-events", "device-recalls", "drug-adverse-events", "drug-label", "drug-ndc", "drug-recalls", "food-recalls"],
    notice: "Informational, not medical advice. Data from openFDA; not endorsed by FDA. Adverse event reports do not establish that a product caused an event.",
  },
  {
    id: "records",
    title: "Public records and geography",
    slugs: ["earthquakes", "federal-awards", "fema-disasters", "geo-lookup", "vehicle-recalls", "vin-decode"],
    notice: "Public government records as each source publishes them: USGS, USAspending, openFEMA, the US Census Bureau and NHTSA.",
  },
  {
    id: "weather",
    title: "Weather",
    slugs: ["weather-current", "weather-daily", "weather-hourly", "weather-history", "weather-air-quality", "place-lookup", "weather-window", "weather-thresholds", "weather-probability", "weather-market-brackets", "weather-market-board", "weather-forecast", "weather-alerts"],
    notice: "Forecasts and probabilities are estimates, not for safety-critical decisions, and not trading or investment advice. Weather data by Open-Meteo.com (CC BY 4.0); US forecasts and alerts from the National Weather Service.",
  },
  {
    id: "calendars",
    title: "Calendars and settlement",
    slugs: ["next-holidays", "long-weekends", "country-business-days", "business-day-planner", "settlement-calendar"],
    notice: "Holiday data from Nager.Date. Settlement dates are expected dates from each rail's published rules; confirm with your bank.",
  },
  {
    id: "network",
    title: "Network",
    slugs: ["dns", "tls-cert", "ip-info"],
    notice: "Passive reads of the host or address you name, as its resolver or server answers at the time of the call.",
  },
  {
    id: "crypto",
    title: "Crypto market analytics",
    slugs: ["stablecoin-peg", "funding-screener", "stablecoin-depeg-watch", "exchange-spread", "defi-screener", "chain-board", "dex-volume-board", "dex-pool-health"],
    notice: FINANCIAL,
  },
  {
    id: "perps",
    title: "Perpetuals market data",
    slugs: ["perp-basis", "perp-dex-limits", "perp-dex-markets", "perp-dexs", "perp-funding", "perp-funding-screener", "perp-klines", "perp-markets", "perp-open-interest", "perp-orderbook"],
    notice: `Read-only market data. ${FINANCIAL}`,
  },
].map((g) => Object.freeze({ ...g, slugs: Object.freeze([...g.slugs]) })));

/** Where a served tool that no group names is shown. */
export const OTHER_GROUP = Object.freeze({ id: "other", title: "Other tools", slugs: Object.freeze([]), notice: "Informational; review results before acting." });

/** Every listed slug, in listing order. */
export const AWS_LISTING_SLUGS = Object.freeze(AWS_LISTING_GROUPS.flatMap((g) => g.slugs));

/** The groups that hold a served slug, each with its served slugs in listing
 *  order, then OTHER_GROUP for any served slug no group names. */
export function awsServedGroups(servedSlugs) {
  const served = new Set(servedSlugs || []);
  const out = [];
  for (const g of AWS_LISTING_GROUPS) {
    const slugs = g.slugs.filter((s) => served.has(s));
    if (slugs.length) out.push({ ...g, slugs });
  }
  const listed = new Set(AWS_LISTING_SLUGS);
  const rest = [...served].filter((s) => !listed.has(s));
  if (rest.length) out.push({ ...OTHER_GROUP, slugs: rest });
  return out;
}

/** The group a slug is shown under. */
export function awsGroupOf(slug) {
  return AWS_LISTING_GROUPS.find((g) => g.slugs.includes(slug)) || OTHER_GROUP;
}

// ---- the AWS-facing description -------------------------------------------
// A catalog description can point past the listing: a sentence that names
// another tool (dns names the mail checks), a route this server answers on,
// or this server's host. Sold through AWS Marketplace, each tool is described
// by its own sentences only: a sentence that names a catalog slug the gate
// does not serve, one of this server's paths or its host is left out, and so
// is one carrying a sales word.

const ABBREVIATIONS = /(?:\be\.g|\bi\.e|\bvs|\betc|\bU\.S|\bNo)\.$/i;
/** A description cut into sentences (an abbreviation such as "e.g." never ends one). */
export function sentencesOf(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const out = [];
  let start = 0;
  const re = /[.?!](?=\s+[A-Z(?'"`])/g;
  let m;
  while ((m = re.exec(t))) {
    const head = t.slice(start, m.index + 1);
    if (ABBREVIATIONS.test(head)) continue;
    out.push(head.trim());
    start = m.index + 1;
  }
  const tail = t.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** Words a listing description does not carry. */
export const AWS_SALES_WORDS = /\b(?:killer|best-in-class|world-class|blazing|game-chang\w*|unbeatable|cheapest|revolutionary)\b/i;
const PATH_TOKEN = /(?:^|[\s"'`(,;:=])(\/[A-Za-z0-9._~\-/]{1,200})/g;

/** What in `sentence` points past the listing (empty when nothing does). */
export function awsPointersIn(sentence, { servedSlugs = [], catalogSlugs = [], ownPaths = [], ownHosts = [] } = {}) {
  const s = String(sentence || "");
  const lc = s.toLowerCase();
  const out = [];
  const served = new Set(servedSlugs);
  for (const slug of catalogSlugs) {
    // A one-word slug ("search", "hash") reads as an ordinary word; only a
    // hyphenated one is a name.
    if (!slug || served.has(slug) || !slug.includes("-")) continue;
    const re = new RegExp(`(?<![a-z0-9-])${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9-])`);
    if (re.test(lc)) out.push(slug);
  }
  const paths = new Set(ownPaths.map((p) => String(p || "").toLowerCase().replace(/\/+$/, "")).filter((p) => p.startsWith("/")));
  for (const m of lc.matchAll(PATH_TOKEN)) {
    const p = m[1].replace(/[.,;:)]+$/, "").replace(/\/+$/, "");
    if (paths.has(p) || /^\/(?:api|v1|mcp|ref)(?:\/|$)/.test(p)) out.push(p);
  }
  for (const h of ownHosts) if (h && lc.includes(String(h).toLowerCase())) out.push(String(h));
  if (AWS_SALES_WORDS.test(s)) out.push(s.match(AWS_SALES_WORDS)[0]);
  return out;
}

/** The description a tool is sold under on /aws: its catalog description less
 *  every sentence that points past the listing (the tool's name when none is left). */
export function awsDescriptionOf(def, ctx = {}) {
  const kept = sentencesOf(def?.description).filter((s) => awsPointersIn(s, ctx).length === 0);
  return kept.length ? kept.join(" ") : String(def?.name || def?.slug || "");
}
