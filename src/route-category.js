// Route categories the router lists but never buys.
//
// The router buys from outside sellers with this host's own wallet on behalf
// of buyers it cannot identify. A route whose product is personal data about
// an individual (people search, background checks, skip tracing, reverse
// phone or email lookup, enrichment of a named person, a person's criminal or
// court records, tenant or employment screening, a person's address or
// relatives) stays LISTED in the index like any other route, but it is not
// router-dispatchable: dispatchEligibility labels it `category_excluded`,
// routeQuery never ranks it, and route-execute never selects or pays it.
//
// The decision reads only the route's own text as the index stores it: its
// path, slug, name, tags and the first sentence of its description (the
// product, not every use it lists). Deterministic, no model, no network.
//
// THE PATTERN LIST IS HERE AND NOWHERE ELSE. Each pattern names the product,
// not a word that merely occurs in one: company enrichment, firmographics,
// domain or WHOIS data, wallet analytics, sanctions and KYB screening of a
// person or entity, ID-number format validators and the "person" fields of
// unrelated APIs must not match (scripts/test-router-people-data.js holds
// controls for each, and runs every tool in this host's own catalog as one).
// A change here changes what the router buys: add a positive AND a control.

// Normalized text: lowercase, apostrophes dropped ("person's" -> "persons"),
// every other run of non-letter/digit characters one space, so a path
// "/v1/people-search" and prose "People Search" read the same.
const NORM_MAX = 2000;
function normalize(s) {
  return ` ${String(s || "").slice(0, NORM_MAX).toLowerCase().replace(/[\u2019']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

// A cheaper gate first, on the raw text: lowercased, apostrophes dropped and
// cut exactly as normalize() does, with no word boundaries. normalize() only
// turns other characters into spaces, which splits words and never joins
// them, so text holding none of these stems cannot pass PREFILTER either, and
// most routes skip the Unicode pass altogether.
const RAW_STEMS = /people|person|individual|someone|somebody|background|skip|reverse|white|criminal|arrest|conviction|mugshot|inmate|offender|tenant|renter|applicant|employ|relative|associate|live|reside|enrich|caller|cnam|finder|linkedin|prospect|lead/;
function rawGate(s) {
  return RAW_STEMS.test(String(s || "").slice(0, NORM_MAX).toLowerCase().replace(/[\u2019']/g, ""));
}

// A cheap gate: no pattern below can match text that carries none of these.
const PREFILTER = /\b(?:people|person|persons|individual|individuals|someone|somebody|someones|background|skip|reverse|white ?pages|criminal|arrest|conviction|convictions|mugshots?|inmate|inmates|offender|offenders|tenant|tenants|renter|applicant|applicants|employment|employee|employees|relatives|associates|lives|lived|resides|enrich|enrichment|caller|cnam|finder|linkedin|prospect|prospects|leads?)\b/;

// Words that turn "people search" into prose about a crowd ("where people
// search for it most"): a product name is not followed by these.
const NOT_A_PRODUCT = "(?! (?:for|on|in|it|alongside|the|by|and|across|online|more|most|each|through|run|use|ask|want|need)\\b)";
// A background check of a company, a website or a wallet is not about a person.
const NOT_A_PERSON_SUBJECT = /\b(?:company|companies|business|businesses|website|websites|domain|domains|wallet|wallets|token|tokens|seller|sellers|vendor|vendors|merchant|merchants|contract|contracts|organization|organizations|firm|firms|brand|brands|project|projects)\b/;
const PERSON_SUBJECT = /\b(?:person|persons|people|individual|individuals|someone|somebody|tenant|tenants|renter|renters|applicant|applicants|employee|employees|candidate|candidates|name|names)\b/;

export const PERSONAL_DATA_PATTERNS = Object.freeze([
  // People search / person lookup as a product: "people search", "person
  // lookup", "people finder", "person enrich", "person discovery".
  { id: "people_search", re: new RegExp(`(?<!(?:company|org|business) )\\b(?:people|person|persons) (?:search|searches|finder|lookup|look up|locator|enrich|enrichment|discovery|records|record|background)\\b${NOT_A_PRODUCT}`) },
  { id: "individual_lookup", re: /\bindividuals? (?:search|lookup|look up|locator|enrichment|background check)\b/ },
  // Person lookup by an identifier: "looks up a person from an email".
  { id: "person_by_identifier", re: /\b(?:look up|looks up|lookup|resolve|resolves|identify|identifies) (?:a |an |any )?(?:person|individual|someone) (?:from|by|with) (?:an |a |their |his |her )?(?:email|e mail|phone|phone number|name|full name|home address|linkedin)\b/ },
  // Background checks (of a person, not a company or a wallet) and
  // white-pages style directories of private people.
  { id: "background_check", re: /\bbackground (?:check|checks|screening|screenings|report|reports|search)\b/, personOnly: true },
  { id: "white_pages", re: /\bwhite ?pages\b/ },
  // Skip tracing.
  { id: "skip_trace", re: /\bskip ?(?:trace|traces|tracing|tracer)\b/ },
  // Reverse lookups that return who is behind a number or an inbox.
  { id: "reverse_lookup", re: /\breverse (?:phone|cell|mobile|telephone|email|e mail)(?: number| address)?(?: lookup| look up| search| check)?\b/ },
  { id: "caller_name", re: /\b(?:caller name|cnam) (?:lookup|look up|data|search)\b/ },
  { id: "who_lives_at", re: /\bwho (?:lives|lived|resides) at\b/ },
  // A person's criminal or court history.
  { id: "criminal_records", re: /\b(?:criminal|arrest|conviction|incarceration|mugshot) (?:record|records|history|histories|report|reports|sentence|sentences|lookup|look up|check|checks)\b|\binmate (?:search|lookup|look up|locator|records?)\b/ },
  { id: "offender_registry", re: /\bsex offenders?\b|\bmugshots?\b/ },
  { id: "court_records_of_person", re: /\b(?:court|case|cases|docket|dockets|judgment|judgments|eviction|evictions|bankruptcy|bankruptcies|lien|liens|records)\b[^.]{0,80}\b(?:for|of|on) (?:a |an |any )?(?:person|individual|named person|private person) (?:by name|by full name|by first and last name)\b/ },
  // Tenant and employment screening of an applicant.
  { id: "tenant_employment_screening", re: /\b(?:tenant|renter|rental applicant|applicant|pre employment|preemployment|employment) screening (?:report|reports|check|checks|api|search|lookup)\b|\bscreen (?:a |an |any )?(?:tenant|renter|applicant|job applicant|candidate|employee)s?\b|\b(?:employment|employee) (?:verification|history check|background)\b|\b(?:tenant|applicant) background\b/ },
  // A person's address, phone, email, contact details or relatives.
  { id: "person_contact", re: /\b(?:find|finds|locate|locates|search for|get|gets|returns?) (?:a |an |the |any )?(?:person|persons|people|peoples|someone|someones|somebody|somebodys|individual|individuals) (?:current |home |residential |personal |mobile |direct )?(?:address|addresses|relatives|phone|phones|phone number|phone numbers|email|emails|email address|email addresses|contact|contact info|contact information|contact details)\b|\b(?:contact details|contact info|contact information|phone numbers|personal emails?) (?:for|of) (?:a |an |any )?(?:prospects?|people|persons?|individuals?|leads?|someone)\b/ },
  { id: "relatives", re: /\b(?:possible|known|likely) (?:relatives|associates)\b|\brelatives (?:of|for) (?:a |an |any )?(?:person|individual|someone)\b/ },
  // Enrichment of a named individual keyed on a person (not a company, a
  // domain or a website), and finders of one person's email or phone.
  { id: "profile_enrichment", re: /\blinkedin profile (?:enrich|enrichment|lookup|look up|scrape|scraper|scraping|finder|search)\b|\bprofile enrichment\b/ },
  { id: "email_finder", re: /\b(?:email|phone number) finder\b|\bfind (?:a |an |any )?(?:persons|someones|individuals|professionals) (?:work |personal )?(?:email|phone)\b/ },
]);

// The first sentence of a description: the product, not every task it
// mentions ("use before people enrichment", "not for tenant screening").
const LEAD_MAX = 300;
function leadOf(description) {
  const d = String(description || "").slice(0, NORM_MAX);
  const m = d.match(/[.!?](?:\s|$)/);
  return (m ? d.slice(0, m.index) : d).slice(0, LEAD_MAX);
}

/** The text the classifier reads for one route row, as the index stores it:
 *  its path, slug, name, tags and the first sentence of its description. */
export function routeTextOf(row) {
  if (!row || typeof row !== "object") return "";
  let path = String(row.route || row.path || "");
  if (!path && typeof row.url === "string") { try { path = new URL(row.url).pathname; } catch { path = ""; } }
  const tags = Array.isArray(row.tags) ? row.tags.map((x) => String(x || "")).join(" ") : "";
  return [path, row.slug, row.name, tags, leadOf(row.description)].map((x) => String(x || "")).join(" | ");
}

/** The id of the first personal-data pattern the route's own text matches, or null. */
export function personalDataMatch(row) {
  const raw = typeof row === "string" ? row : routeTextOf(row);
  if (!rawGate(raw)) return null;
  const t = normalize(raw);
  if (!PREFILTER.test(t)) return null;
  for (const p of PERSONAL_DATA_PATTERNS) {
    if (!p.re.test(t)) continue;
    if (p.personOnly && NOT_A_PERSON_SUBJECT.test(t) && !PERSON_SUBJECT.test(t)) continue;
    return p.id;
  }
  return null;
}

/**
 * The excluded category a route falls in, or null. The one question every
 * reader asks: dispatchEligibility (labels and the resolver's Base gate),
 * routeQuery (in-thread and in the router worker, which imports the same
 * index module) and route-execute's candidate filter for every chain.
 */
/** Both gates, for the test that holds the raw one to be a superset. */
export const __routeCategoryGatesForTests = Object.freeze({ rawGate, prefilter: (s) => PREFILTER.test(normalize(s)), prefilterSource: PREFILTER.source });

export function routeExcludedCategory(row) {
  return personalDataMatch(row) ? "personal_data" : null;
}
