// B2B enrichment kit - company and contact enrichment over two keyed
// upstreams: Hunter (domain email search, email finder, email verifier,
// company facts) and Apollo (people search, organization enrichment,
// person match).
//
// Env-gated PER PROVIDER: a Hunter tool needs only HUNTER_API_KEY, an Apollo
// tool only APOLLO_API_KEY. `B2B_ENRICH_TOOLS` is exported unconditionally;
// `b2bEnrichEnabled()` returns the SUBSET of tools whose key is present (an
// array the server spreads into the catalog). A handler called without its
// key throws a self-explaining 503. Every tool reaches the network and is
// WALLET-ONLY (both upstreams meter per request).
//
// Output is compact JSON carrying `source` + `fetchedAt`. PII-heavy fields
// the buyer did not ask for (phone numbers, personal emails, street
// addresses, per-person social handles, source URLs) are stripped; the
// work email IS the product for the finder / verifier / match tools and is
// kept there.
//
// Upstream status mapping (never relays upstream error bodies):
//   401/403 -> 503 "not configured" (key rejected / plan lacks the endpoint)
//   402/429 -> 503 quota (credits exhausted or rate cap)
//   404     -> 404 (no record)
//   other 4xx -> 400 (the request itself was invalid)
//   5xx     -> 502, timeout -> 504
//
// Covered by scripts/test-b2b-enrich-kit.js (offline, stubbed fetch). Live
// calls need real keys and are not exercised in CI.

const HUNTER_API = "https://api.hunter.io/v2";
const APOLLO_API = "https://api.apollo.io/api/v1";
const TIMEOUT_MS = 15_000;
const USER_AGENT = "Agent402/1.0 (+https://agent402.tools)";

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}$/;
const NAME_RE = /^[\p{L}\p{M}' .-]{1,80}$/u;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const hunterKey = () => (process.env.HUNTER_API_KEY || "").trim();
const apolloKey = () => (process.env.APOLLO_API_KEY || "").trim();

export function hunterEnabled() { return hunterKey().length > 0; }
export function apolloEnabled() { return apolloKey().length > 0; }

// Provider per slug, kept OUT of the tool objects so the catalog envelope
// stays the standard shape.
const PROVIDER_BY_SLUG = {
  "hunter-domain-search": "hunter",
  "hunter-email-finder": "hunter",
  "hunter-email-verify": "hunter",
  "hunter-company": "hunter",
  "apollo-people-search": "apollo",
  "apollo-org-enrich": "apollo",
  "apollo-person-match": "apollo",
};

export function providerOf(slug) { return PROVIDER_BY_SLUG[slug] || null; }

// --- input helpers ---------------------------------------------------------
function takeDomain(raw, field = "domain") {
  let s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!s) throw bad(`"${field}" is required - a company domain such as "stripe.com"`);
  // Accept a URL or a bare host; reduce to the registrable-looking host.
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try { s = new URL(s).hostname; } catch { throw bad(`"${field}" must be a domain such as "stripe.com"`); }
  } else {
    s = s.split("/")[0];
  }
  s = s.replace(/^www\./, "").replace(/\.$/, "");
  if (!DOMAIN_RE.test(s)) throw bad(`"${field}" must be a domain such as "stripe.com"`);
  return s;
}

function takeEmail(raw, field = "email") {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!s) throw bad(`"${field}" is required`);
  if (!EMAIL_RE.test(s) || !DOMAIN_RE.test(s.split("@")[1])) throw bad(`"${field}" must be a valid email address`);
  return s;
}

function takeName(raw, field) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) throw bad(`"${field}" is required`);
  if (!NAME_RE.test(s)) throw bad(`"${field}" must be a person's name (letters, spaces, apostrophes, hyphens; max 80 chars)`);
  return s;
}

function takeOptionalName(raw, field) {
  if (raw === undefined || raw === null || raw === "") return null;
  return takeName(raw, field);
}

function takeInt(raw, field, { min, max, dflt }) {
  if (raw === undefined || raw === null || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`"${field}" must be an integer between ${min} and ${max}`);
  return n;
}

function takeStringList(raw, field, { max, maxLen = 80 }) {
  if (raw === undefined || raw === null || raw === "") return [];
  let list = raw;
  if (typeof list === "string") list = list.split(",");
  if (!Array.isArray(list)) throw bad(`"${field}" must be an array of strings (or a comma-separated string)`);
  const out = [];
  for (const v of list) {
    if (typeof v !== "string") throw bad(`"${field}" must contain strings only`);
    const s = v.trim();
    if (!s) continue;
    if (s.length > maxLen) throw bad(`"${field}" entries must be at most ${maxLen} chars`);
    out.push(s);
  }
  if (out.length > max) throw bad(`"${field}" has too many entries (${out.length}); the cap is ${max}`);
  return out;
}

const nowIso = () => new Date().toISOString();
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === "string" && v !== "" ? v : null);
const cap = (arr, n) => (Array.isArray(arr) ? arr.filter((x) => typeof x === "string").slice(0, n) : []);

// --- upstream plumbing -----------------------------------------------------
function mapStatus(res, label) {
  if (res.status === 401 || res.status === 403) {
    throw bad(`${label} enrichment is not configured on this deployment (upstream refused the API key)`, 503);
  }
  if (res.status === 402 || res.status === 429) {
    const ra = res.headers?.get?.("retry-after");
    const hint = ra ? ` - retry after ${String(ra).slice(0, 20)}` : " - retry shortly";
    throw bad(`${label} quota reached upstream (credits or rate cap)${hint}`, 503);
  }
  if (res.status === 404) throw bad(`No ${label} record found`, 404);
  if (res.status >= 500) throw bad(`${label} upstream error (HTTP ${res.status})`, 502);
  if (!res.ok) throw bad(`${label} rejected the request (HTTP ${res.status}) - check the parameters`, 400);
}

async function doFetch(url, init, label) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    let host = "?";
    try { host = new URL(url).host; } catch {}
    console.warn(`[b2b-enrich] ${host} unreachable: ${err?.name ?? err?.code ?? err?.message}`);
    throw bad(`${label} did not respond in time - try again shortly`, 504);
  }
  return res;
}

async function readJson(res, label) {
  let data;
  try { data = await res.json(); } catch { throw bad(`${label} returned non-JSON`, 502); }
  if (!data || typeof data !== "object") throw bad(`${label} returned an unexpected payload`, 502);
  return data;
}

async function hunterGet(path, params) {
  const key = hunterKey();
  if (!key) throw bad("Hunter enrichment is not configured on this deployment (HUNTER_API_KEY unset)", 503);
  const url = new URL(HUNTER_API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  url.searchParams.set("api_key", key);
  const res = await doFetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } }, "Hunter");
  // The verifier answers 202 while a slow verification is still running.
  if (res.status === 202) throw bad("Hunter is still verifying this address - retry in a few seconds", 503);
  mapStatus(res, "Hunter");
  return readJson(res, "Hunter");
}

async function apolloCall(path, { method = "GET", query = {}, body } = {}) {
  const key = apolloKey();
  if (!key) throw bad("Apollo enrichment is not configured on this deployment (APOLLO_API_KEY unset)", 503);
  const url = new URL(APOLLO_API + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const init = {
    method,
    headers: {
      "x-api-key": key,
      Accept: "application/json",
      "Cache-Control": "no-cache",
      "User-Agent": USER_AGENT,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const res = await doFetch(url, init, "Apollo");
  mapStatus(res, "Apollo");
  return readJson(res, "Apollo");
}

// --- shaping: Hunter -------------------------------------------------------
function shapeHunterEmail(e) {
  if (!e || typeof e !== "object") return null;
  return {
    email: str(e.value),
    type: str(e.type),
    confidence: num(e.confidence),
    firstName: str(e.first_name),
    lastName: str(e.last_name),
    position: str(e.position),
    seniority: str(e.seniority),
    department: str(e.department),
    verification: e.verification && typeof e.verification === "object" ? { status: str(e.verification.status), date: str(e.verification.date) } : null,
    sourceCount: Array.isArray(e.sources) ? e.sources.length : null,
  };
}

function shapeHunterCompany(c) {
  if (!c || typeof c !== "object") return null;
  const m = c.metrics && typeof c.metrics === "object" ? c.metrics : {};
  const cat = c.category && typeof c.category === "object" ? c.category : {};
  const geo = c.geo && typeof c.geo === "object" ? c.geo : {};
  return {
    name: str(c.name),
    legalName: str(c.legalName),
    domain: str(c.domain),
    domainAliases: cap(c.domainAliases, 10),
    description: str(c.description),
    foundedYear: num(c.foundedYear),
    type: str(c.type),
    ticker: str(c.ticker),
    category: { sector: str(cat.sector), industryGroup: str(cat.industryGroup), industry: str(cat.industry), subIndustry: str(cat.subIndustry) },
    tags: cap(c.tags, 20),
    location: { city: str(geo.city), state: str(geo.state), country: str(geo.country), countryCode: str(geo.countryCode), timeZone: str(c.timeZone) },
    linkedin: str(c.linkedin?.handle),
    twitter: str(c.twitter?.handle),
    emailProvider: typeof c.emailProvider === "boolean" ? c.emailProvider : null,
    metrics: {
      employees: num(m.employees),
      employeesRange: str(m.employeesRange),
      estimatedAnnualRevenue: str(m.estimatedAnnualRevenue),
      annualRevenue: num(m.annualRevenue),
      raised: num(m.raised),
      marketCap: num(m.marketCap),
    },
    tech: cap(c.tech, 30),
    techCategories: cap(c.techCategories, 20),
  };
}

// --- shaping: Apollo -------------------------------------------------------
function shapeApolloOrgBrief(o) {
  if (!o || typeof o !== "object") return null;
  return {
    id: str(o.id),
    name: str(o.name),
    domain: str(o.primary_domain),
    websiteUrl: str(o.website_url),
    linkedinUrl: str(o.linkedin_url),
    industry: str(o.industry),
    estimatedEmployees: num(o.estimated_num_employees),
  };
}

function shapeApolloPerson(p, { withEmail }) {
  if (!p || typeof p !== "object") return null;
  return {
    id: str(p.id),
    name: str(p.name) || [str(p.first_name), str(p.last_name)].filter(Boolean).join(" ") || null,
    firstName: str(p.first_name),
    lastName: str(p.last_name),
    title: str(p.title),
    headline: str(p.headline),
    seniority: str(p.seniority),
    departments: cap(p.departments, 10),
    functions: cap(p.functions, 10),
    city: str(p.city),
    state: str(p.state),
    country: str(p.country),
    linkedinUrl: str(p.linkedin_url),
    emailStatus: str(p.email_status),
    ...(withEmail ? { email: str(p.email) } : {}),
    organization: shapeApolloOrgBrief(p.organization),
  };
}

function shapeApolloOrgFull(o) {
  if (!o || typeof o !== "object") return null;
  const dh = o.departmental_head_count && typeof o.departmental_head_count === "object" ? o.departmental_head_count : null;
  return {
    id: str(o.id),
    name: str(o.name),
    domain: str(o.primary_domain),
    websiteUrl: str(o.website_url),
    linkedinUrl: str(o.linkedin_url),
    twitterUrl: str(o.twitter_url),
    crunchbaseUrl: str(o.crunchbase_url),
    foundedYear: num(o.founded_year),
    industry: str(o.industry),
    industries: cap(o.industries, 10),
    keywords: cap(o.keywords, 25),
    shortDescription: str(o.short_description),
    estimatedEmployees: num(o.estimated_num_employees),
    location: { city: str(o.city), state: str(o.state), country: str(o.country) },
    annualRevenue: num(o.annual_revenue),
    annualRevenuePrinted: str(o.annual_revenue_printed),
    totalFunding: num(o.total_funding),
    totalFundingPrinted: str(o.total_funding_printed),
    latestFundingStage: str(o.latest_funding_stage),
    latestFundingRoundDate: str(o.latest_funding_round_date),
    ticker: str(o.publicly_traded_symbol),
    exchange: str(o.publicly_traded_exchange),
    technologies: cap(o.technology_names, 30),
    departmentalHeadCount: dh ? Object.fromEntries(Object.entries(dh).filter(([, v]) => typeof v === "number").slice(0, 30)) : null,
  };
}

// --- tools -----------------------------------------------------------------
const EXAMPLE_AT = "2026-08-20T14:10:00.000Z";

export const B2B_ENRICH_TOOLS = [
  {
    route: "POST /api/hunter-domain-search",
    name: "Domain email search",
    slug: "hunter-domain-search",
    category: "research",
    price: "$0.030",
    description:
      "Find the public email addresses indexed for a company domain in a B2B contact database: each address with type (personal/generic), confidence score, the person's name, position, seniority and department, plus the domain's email pattern and organization facts. Filter by type or department; page with offset.",
    tags: ["b2b", "enrichment", "email", "domain", "leads", "contacts"],
    discovery: {
      bodyType: "json",
      input: { domain: "stripe.com", limit: 10 },
      inputSchema: {
        properties: {
          domain: { type: "string", description: "Company domain, e.g. stripe.com (a URL is accepted and reduced to its host)." },
          limit: { type: "number", description: "Max addresses to return, 1-100 (default 10)." },
          offset: { type: "number", description: "Skip the first N addresses (paging), default 0." },
          type: { type: "string", description: "personal or generic (omit for both)." },
          department: { type: "string", description: "Comma-separated departments: executive, it, finance, management, sales, legal, support, hr, marketing, communication, education, design, health, operations." },
          seniority: { type: "string", description: "Comma-separated: junior, senior, executive." },
        },
        required: ["domain"],
      },
      output: {
        example: {
          source: "hunter",
          fetchedAt: EXAMPLE_AT,
          domain: "stripe.com",
          organization: "Stripe",
          pattern: "{first}",
          webmail: false,
          acceptAll: false,
          disposable: false,
          industry: "Financial Services",
          country: "US",
          headcount: "1001-5000",
          total: 2870,
          count: 1,
          offset: 0,
          emails: [{ email: "jane@stripe.com", type: "personal", confidence: 92, firstName: "Jane", lastName: "Doe", position: "Engineering Manager", seniority: "senior", department: "it", verification: { status: "valid", date: "2026-08-01" }, sourceCount: 4 }],
        },
      },
    },
    handler: async (i) => {
      const domain = takeDomain(i.domain);
      const limit = takeInt(i.limit, "limit", { min: 1, max: 100, dflt: 10 });
      const offset = takeInt(i.offset, "offset", { min: 0, max: 10_000, dflt: 0 });
      const type = i.type === undefined || i.type === null || i.type === "" ? null : String(i.type).trim().toLowerCase();
      if (type && type !== "personal" && type !== "generic") throw bad('"type" must be "personal" or "generic"');
      const department = takeStringList(i.department, "department", { max: 14, maxLen: 20 }).join(",");
      const seniority = takeStringList(i.seniority, "seniority", { max: 3, maxLen: 12 }).join(",");

      const json = await hunterGet("/domain-search", { domain, limit, offset, type, department, seniority });
      const d = json.data && typeof json.data === "object" ? json.data : {};
      const emails = (Array.isArray(d.emails) ? d.emails : []).map(shapeHunterEmail).filter(Boolean);
      return {
        source: "hunter",
        fetchedAt: nowIso(),
        domain: str(d.domain) || domain,
        organization: str(d.organization),
        pattern: str(d.pattern),
        webmail: typeof d.webmail === "boolean" ? d.webmail : null,
        acceptAll: typeof d.accept_all === "boolean" ? d.accept_all : null,
        disposable: typeof d.disposable === "boolean" ? d.disposable : null,
        industry: str(d.industry),
        country: str(d.country),
        headcount: str(d.headcount),
        total: num(json.meta?.results),
        count: emails.length,
        offset,
        emails,
      };
    },
  },

  {
    route: "POST /api/hunter-email-finder",
    name: "Work email finder",
    slug: "hunter-email-finder",
    category: "research",
    price: "$0.030",
    description:
      "Find the most likely work email for a named person at a company domain from a B2B contact database: the address, a 0-100 confidence score, the person's position and the verification status on record for it. Provide first_name + last_name (or full_name) and domain.",
    tags: ["b2b", "enrichment", "email", "finder", "contact"],
    discovery: {
      bodyType: "json",
      input: { domain: "stripe.com", first_name: "Jane", last_name: "Doe" },
      inputSchema: {
        properties: {
          domain: { type: "string", description: "Company domain, e.g. stripe.com." },
          first_name: { type: "string", description: "First name (with last_name)." },
          last_name: { type: "string", description: "Last name (with first_name)." },
          full_name: { type: "string", description: "Alternative to first_name + last_name." },
        },
        required: ["domain"],
      },
      output: {
        example: {
          source: "hunter",
          fetchedAt: EXAMPLE_AT,
          domain: "stripe.com",
          firstName: "Jane",
          lastName: "Doe",
          email: "jane@example.com",
          score: 97,
          position: "CEO",
          company: "Stripe",
          acceptAll: false,
          verification: { status: "valid", date: "2026-08-01" },
          found: true,
        },
      },
    },
    handler: async (i) => {
      const domain = takeDomain(i.domain);
      const full = takeOptionalName(i.full_name, "full_name");
      const first = takeOptionalName(i.first_name, "first_name");
      const last = takeOptionalName(i.last_name, "last_name");
      if (!full && !(first && last)) throw bad('Provide "first_name" and "last_name", or "full_name"');

      const json = await hunterGet("/email-finder", { domain, first_name: full ? null : first, last_name: full ? null : last, full_name: full });
      const d = json.data && typeof json.data === "object" ? json.data : {};
      return {
        source: "hunter",
        fetchedAt: nowIso(),
        domain: str(d.domain) || domain,
        firstName: str(d.first_name) || first,
        lastName: str(d.last_name) || last,
        email: str(d.email),
        score: num(d.score),
        position: str(d.position),
        company: str(d.company),
        acceptAll: typeof d.accept_all === "boolean" ? d.accept_all : null,
        verification: d.verification && typeof d.verification === "object" ? { status: str(d.verification.status), date: str(d.verification.date) } : null,
        found: Boolean(str(d.email)),
      };
    },
  },

  {
    route: "POST /api/hunter-email-verify",
    name: "Email deliverability verifier",
    slug: "hunter-email-verify",
    category: "research",
    price: "$0.020",
    description:
      "Verify whether an email address is deliverable: result (deliverable/undeliverable/risky/unknown), status (valid/invalid/accept_all/webmail/disposable/unknown), a 0-100 score, and the individual checks (format, gibberish, disposable, webmail, MX records, SMTP server, SMTP check, accept-all, blocked).",
    tags: ["b2b", "enrichment", "email", "verify", "deliverability"],
    discovery: {
      bodyType: "json",
      input: { email: "support@stripe.com" },
      inputSchema: {
        properties: {
          email: { type: "string", description: "Email address to verify." },
        },
        required: ["email"],
      },
      output: {
        example: {
          source: "hunter",
          fetchedAt: EXAMPLE_AT,
          email: "support@stripe.com",
          result: "deliverable",
          status: "valid",
          score: 94,
          checks: { regexp: true, gibberish: false, disposable: false, webmail: false, mxRecords: true, smtpServer: true, smtpCheck: true, acceptAll: false, block: false },
          sourceCount: 3,
        },
      },
    },
    handler: async (i) => {
      const email = takeEmail(i.email);
      const json = await hunterGet("/email-verifier", { email });
      const d = json.data && typeof json.data === "object" ? json.data : {};
      const flag = (v) => (typeof v === "boolean" ? v : null);
      return {
        source: "hunter",
        fetchedAt: nowIso(),
        email: str(d.email) || email,
        result: str(d.result),
        status: str(d.status),
        score: num(d.score),
        checks: {
          regexp: flag(d.regexp),
          gibberish: flag(d.gibberish),
          disposable: flag(d.disposable),
          webmail: flag(d.webmail),
          mxRecords: flag(d.mx_records),
          smtpServer: flag(d.smtp_server),
          smtpCheck: flag(d.smtp_check),
          acceptAll: flag(d.accept_all),
          block: flag(d.block),
        },
        sourceCount: Array.isArray(d.sources) ? d.sources.length : null,
      };
    },
  },

  {
    route: "POST /api/hunter-company",
    name: "Company facts by domain",
    slug: "hunter-company",
    category: "research",
    price: "$0.020",
    description:
      "Company facts for a domain from a B2B company database: name, legal name, description, founded year, industry classification, tags, headquarters location, employee count and range, estimated revenue, funding raised, ticker, LinkedIn and X handles, and the technologies detected on the site.",
    tags: ["b2b", "enrichment", "company", "firmographics"],
    discovery: {
      bodyType: "json",
      input: { domain: "stripe.com" },
      inputSchema: {
        properties: {
          domain: { type: "string", description: "Company domain, e.g. stripe.com." },
        },
        required: ["domain"],
      },
      output: {
        example: {
          source: "hunter",
          fetchedAt: EXAMPLE_AT,
          domain: "stripe.com",
          company: {
            name: "Stripe", legalName: "Stripe, Inc.", domain: "stripe.com", domainAliases: ["stripe.dev"], description: "Financial infrastructure for the internet.", foundedYear: 2010, type: "private", ticker: null,
            category: { sector: "Financials", industryGroup: "Diversified Financials", industry: "Financial Services", subIndustry: "Payments" },
            tags: ["Payments", "Fintech"],
            location: { city: "South San Francisco", state: "California", country: "United States", countryCode: "US", timeZone: "America/Los_Angeles" },
            linkedin: "company/stripe", twitter: "stripe", emailProvider: false,
            metrics: { employees: 8000, employeesRange: "5K-10K", estimatedAnnualRevenue: "$1B-$10B", annualRevenue: null, raised: 8700000000, marketCap: null },
            tech: ["google_analytics", "aws"], techCategories: ["analytics", "hosting"],
          },
        },
      },
    },
    handler: async (i) => {
      const domain = takeDomain(i.domain);
      const json = await hunterGet("/companies/find", { domain });
      const company = shapeHunterCompany(json.data);
      if (!company || !company.name) throw bad("No Hunter record found", 404);
      return { source: "hunter", fetchedAt: nowIso(), domain, company };
    },
  },

  {
    route: "POST /api/apollo-people-search",
    name: "B2B people search",
    slug: "apollo-people-search",
    category: "research",
    price: "$0.020",
    description:
      "Search a B2B people database by company domain(s), job title(s), seniority and location: returns matching people with name, title, headline, seniority, departments, location, LinkedIn URL, email status and their organization (name, domain, size). Up to 25 per page with total count and page count. Emails are not revealed here; use apollo-person-match for one person's email.",
    tags: ["b2b", "enrichment", "people", "prospecting", "leads", "titles"],
    discovery: {
      bodyType: "json",
      input: { domains: ["stripe.com"], titles: ["engineering manager"], per_page: 5 },
      inputSchema: {
        properties: {
          domains: { type: "array", items: { type: "string" }, description: "Company domains to search within (1-25)." },
          titles: { type: "array", items: { type: "string" }, description: "Job titles to match (0-25), e.g. [\"cto\", \"vp engineering\"]." },
          seniorities: { type: "array", items: { type: "string" }, description: "Seniorities: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern." },
          locations: { type: "array", items: { type: "string" }, description: "Person locations, e.g. [\"california, us\"]." },
          keywords: { type: "string", description: "Free-text keywords (max 200 chars)." },
          page: { type: "number", description: "Page number, 1-500 (default 1)." },
          per_page: { type: "number", description: "Results per page, 1-25 (default 10)." },
        },
        required: ["domains"],
      },
      output: {
        example: {
          source: "apollo",
          fetchedAt: EXAMPLE_AT,
          query: { domains: ["stripe.com"], titles: ["engineering manager"], seniorities: [], locations: [], keywords: null },
          page: 1,
          perPage: 5,
          totalEntries: 140,
          numPages: 28,
          partialResultsOnly: false,
          count: 1,
          people: [{ id: "5f1a...", name: "Jane Doe", firstName: "Jane", lastName: "Doe", title: "Engineering Manager", headline: "Engineering Manager at Stripe", seniority: "manager", departments: ["engineering"], functions: ["engineering"], city: "Seattle", state: "Washington", country: "United States", linkedinUrl: "https://www.linkedin.com/in/example-user", emailStatus: "verified", organization: { id: "5e66...", name: "Stripe", domain: "stripe.com", websiteUrl: "http://www.stripe.com", linkedinUrl: "http://www.linkedin.com/company/stripe", industry: "financial services", estimatedEmployees: 8000 } }],
        },
      },
    },
    handler: async (i) => {
      const domainsRaw = takeStringList(i.domains ?? i.domain, "domains", { max: 25, maxLen: 253 });
      if (domainsRaw.length === 0) throw bad('"domains" is required - 1-25 company domains to search within');
      const domains = domainsRaw.map((d) => takeDomain(d, "domains"));
      const titles = takeStringList(i.titles, "titles", { max: 25, maxLen: 80 });
      const seniorities = takeStringList(i.seniorities, "seniorities", { max: 11, maxLen: 20 }).map((s) => s.toLowerCase());
      const locations = takeStringList(i.locations, "locations", { max: 10, maxLen: 80 });
      const keywords = i.keywords === undefined || i.keywords === null || i.keywords === "" ? null : String(i.keywords).trim();
      if (keywords && keywords.length > 200) throw bad('"keywords" must be at most 200 chars');
      const page = takeInt(i.page, "page", { min: 1, max: 500, dflt: 1 });
      const perPage = takeInt(i.per_page, "per_page", { min: 1, max: 25, dflt: 10 });

      const body = {
        q_organization_domains_list: domains,
        page,
        per_page: perPage,
        ...(titles.length ? { person_titles: titles } : {}),
        ...(seniorities.length ? { person_seniorities: seniorities } : {}),
        ...(locations.length ? { person_locations: locations } : {}),
        ...(keywords ? { q_keywords: keywords } : {}),
      };
      const json = await apolloCall("/mixed_people/search", { method: "POST", body });
      const people = (Array.isArray(json.people) ? json.people : []).map((p) => shapeApolloPerson(p, { withEmail: false })).filter(Boolean);
      return {
        source: "apollo",
        fetchedAt: nowIso(),
        query: { domains, titles, seniorities, locations, keywords },
        page: num(json.page) ?? page,
        perPage: num(json.per_page) ?? perPage,
        totalEntries: num(json.total_entries),
        numPages: num(json.num_pages),
        partialResultsOnly: typeof json.partial_results_only === "boolean" ? json.partial_results_only : null,
        count: people.length,
        people,
      };
    },
  },

  {
    route: "POST /api/apollo-org-enrich",
    name: "Organization enrichment",
    slug: "apollo-org-enrich",
    category: "research",
    price: "$0.020",
    description:
      "Enrich a company by domain from a B2B company database: name, website, LinkedIn and X URLs, founded year, industry and keywords, short description, estimated employee count, headquarters city/state/country, annual revenue, total funding and latest round, ticker and exchange, detected technologies, and per-department headcount.",
    tags: ["b2b", "enrichment", "company", "firmographics", "funding"],
    discovery: {
      bodyType: "json",
      input: { domain: "stripe.com" },
      inputSchema: {
        properties: {
          domain: { type: "string", description: "Company domain, e.g. stripe.com." },
        },
        required: ["domain"],
      },
      output: {
        example: {
          source: "apollo",
          fetchedAt: EXAMPLE_AT,
          domain: "stripe.com",
          organization: {
            id: "5e66...", name: "Stripe", domain: "stripe.com", websiteUrl: "http://www.stripe.com", linkedinUrl: "http://www.linkedin.com/company/stripe", twitterUrl: "https://twitter.com/exampleuser", crunchbaseUrl: null,
            foundedYear: 2010, industry: "financial services", industries: ["financial services"], keywords: ["payments", "developer tools"], shortDescription: "Stripe builds financial infrastructure for the internet.",
            estimatedEmployees: 8000, location: { city: "South San Francisco", state: "California", country: "United States" },
            annualRevenue: 16000000000, annualRevenuePrinted: "16B", totalFunding: 8700000000, totalFundingPrinted: "8.7B", latestFundingStage: "Series I", latestFundingRoundDate: "2023-03-15T00:00:00.000+00:00",
            ticker: null, exchange: null, technologies: ["Amazon AWS", "Google Analytics"], departmentalHeadCount: { engineering: 2500, sales: 900 },
          },
        },
      },
    },
    handler: async (i) => {
      const domain = takeDomain(i.domain);
      const json = await apolloCall("/organizations/enrich", { query: { domain } });
      const organization = shapeApolloOrgFull(json.organization);
      if (!organization || !organization.name) throw bad("No Apollo record found", 404);
      return { source: "apollo", fetchedAt: nowIso(), domain, organization };
    },
  },

  {
    route: "POST /api/apollo-person-match",
    name: "B2B person match",
    slug: "apollo-person-match",
    category: "research",
    price: "$0.050",
    description:
      "Match one person in a B2B people database by work email, or by first_name + last_name + company domain, and return their enriched profile: name, title, headline, seniority, departments, location, LinkedIn URL, work email with its verification status, and their organization (name, domain, industry, size). Personal emails and phone numbers are never requested.",
    tags: ["b2b", "enrichment", "person", "email", "contact", "match"],
    discovery: {
      bodyType: "json",
      input: { first_name: "Jane", last_name: "Doe", domain: "stripe.com" },
      inputSchema: {
        properties: {
          email: { type: "string", description: "Work email to match (alternative to name + domain)." },
          first_name: { type: "string", description: "First name (with last_name and domain)." },
          last_name: { type: "string", description: "Last name (with first_name and domain)." },
          domain: { type: "string", description: "Company domain (with first_name + last_name)." },
          organization_name: { type: "string", description: "Optional company name hint." },
        },
      },
      output: {
        example: {
          source: "apollo",
          fetchedAt: EXAMPLE_AT,
          matched: true,
          person: { id: "5f1a...", name: "Jane Doe", firstName: "Jane", lastName: "Doe", title: "CEO", headline: "CEO at Stripe", seniority: "c_suite", departments: ["c_suite"], functions: ["entrepreneurship"], city: "San Francisco", state: "California", country: "United States", linkedinUrl: "https://www.linkedin.com/in/example-user", emailStatus: "verified", email: "jane@example.com", organization: { id: "5e66...", name: "Stripe", domain: "stripe.com", websiteUrl: "http://www.stripe.com", linkedinUrl: "http://www.linkedin.com/company/stripe", industry: "financial services", estimatedEmployees: 8000 } },
        },
      },
    },
    handler: async (i) => {
      const hasEmail = typeof i.email === "string" && i.email.trim() !== "";
      const first = takeOptionalName(i.first_name, "first_name");
      const last = takeOptionalName(i.last_name, "last_name");
      const hasDomain = typeof i.domain === "string" && i.domain.trim() !== "";
      if (!hasEmail && !(first && last && hasDomain)) {
        throw bad('Provide "email", or "first_name" + "last_name" + "domain"');
      }
      const orgName = i.organization_name === undefined || i.organization_name === null || i.organization_name === "" ? null : String(i.organization_name).trim().slice(0, 120);

      const body = {};
      if (hasEmail) body.email = takeEmail(i.email);
      if (first && last) { body.first_name = first; body.last_name = last; }
      if (hasDomain) body.domain = takeDomain(i.domain);
      if (orgName) body.organization_name = orgName;

      const json = await apolloCall("/people/match", {
        method: "POST",
        query: { reveal_personal_emails: "false", reveal_phone_number: "false" },
        body,
      });
      const person = shapeApolloPerson(json.person, { withEmail: true });
      if (!person) throw bad("No Apollo record found", 404);
      return { source: "apollo", fetchedAt: nowIso(), matched: true, person };
    },
  },
];

// The subset of tools whose provider key is present. The server spreads this
// into the catalog so an unconfigured provider's tools are never listed
// (a listed-but-dead route would answer 402 and then 503 - not charged, but
// it wastes the buyer's round trip and pollutes discovery).
export function b2bEnrichEnabled() {
  const h = hunterEnabled();
  const a = apolloEnabled();
  return B2B_ENRICH_TOOLS.filter((t) => {
    const p = PROVIDER_BY_SLUG[t.slug];
    return (p === "hunter" && h) || (p === "apollo" && a);
  });
}

export const __test = { takeDomain, takeEmail, takeName, takeInt, takeStringList, shapeHunterEmail, shapeHunterCompany, shapeApolloPerson, shapeApolloOrgFull, HUNTER_API, APOLLO_API };
