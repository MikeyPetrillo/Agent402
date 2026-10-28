// scripts/test-b2b-enrich-kit.js
// Offline tests for src/tools/b2b-enrich-kit.js. No keys, no network: every
// upstream call is served by a stubbed globalThis.fetch. Covers: the catalog
// envelope, per-provider gating (b2bEnrichEnabled() returns the subset whose
// key is present), no-key -> 503, input validation (400), fixture output
// shapes with PII stripping, and the 401/403 / 402/429 / 404 / 5xx / timeout
// mapping. Live calls need real HUNTER_API_KEY / APOLLO_API_KEY and are not
// exercised here.

import { B2B_ENRICH_TOOLS, b2bEnrichEnabled, hunterEnabled, apolloEnabled, providerOf, __test } from "../src/tools/b2b-enrich-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
const h = (slug) => B2B_ENRICH_TOOLS.find((t) => t.slug === slug).handler;

async function throws(promise, status, label, re) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status && (!re || re.test(e.message))) { pass++; console.log(`ok - ${label} -> ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}${re ? ` /${re.source}/` : ""}, got ${e.statusCode} (${e.message})`); }
  }
}

const realFetch = globalThis.fetch;
const jsonRes = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const stashedH = process.env.HUNTER_API_KEY;
const stashedA = process.env.APOLLO_API_KEY;
const HUNTER_SLUGS = ["hunter-domain-search", "hunter-email-finder", "hunter-email-verify", "hunter-company"];
const APOLLO_SLUGS = ["apollo-people-search", "apollo-org-enrich", "apollo-person-match"];

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
const EXPECTED = {
  "hunter-domain-search": "$0.030", "hunter-email-finder": "$0.030", "hunter-email-verify": "$0.020", "hunter-company": "$0.020",
  "apollo-people-search": "$0.020", "apollo-org-enrich": "$0.020", "apollo-person-match": "$0.050",
};
ok(B2B_ENRICH_TOOLS.length === 7, `7 tools exported (got ${B2B_ENRICH_TOOLS.length})`);
for (const t of B2B_ENRICH_TOOLS) {
  ok(EXPECTED[t.slug] === t.price, `${t.slug}: priced ${t.price}`);
  ok(t.route === `POST /api/${t.slug}`, `${t.slug}: POST /api/${t.slug}`);
  ok(typeof t.handler === "function" && typeof t.name === "string" && typeof t.description === "string" && Array.isArray(t.tags), `${t.slug}: envelope`);
  ok(t.discovery?.input && t.discovery?.inputSchema?.properties && t.discovery?.output?.example, `${t.slug}: discovery input + schema + example`);
  ok(t.discovery.output.example.source && t.discovery.output.example.fetchedAt, `${t.slug}: example carries source + fetchedAt`);
  ok(!/\u2014/.test(t.description), `${t.slug}: no em dashes in description`);
  ok(providerOf(t.slug) === (t.slug.startsWith("hunter-") ? "hunter" : "apollo"), `${t.slug}: provider resolved`);
}

// ----------------------------------------------------------------------------
// Gating reflects env, per provider
// ----------------------------------------------------------------------------
delete process.env.HUNTER_API_KEY;
delete process.env.APOLLO_API_KEY;
ok(hunterEnabled() === false && apolloEnabled() === false, "no keys: both providers disabled");
ok(Array.isArray(b2bEnrichEnabled()) && b2bEnrichEnabled().length === 0, "no keys: b2bEnrichEnabled() is an empty array");
process.env.HUNTER_API_KEY = "hunter-test-key-0123456789";
{
  const en = b2bEnrichEnabled().map((t) => t.slug);
  ok(en.length === 4 && HUNTER_SLUGS.every((s) => en.includes(s)) && APOLLO_SLUGS.every((s) => !en.includes(s)), `HUNTER only: 4 Hunter tools listed, no Apollo (${en.join(",")})`);
}
delete process.env.HUNTER_API_KEY;
process.env.APOLLO_API_KEY = "apollo-test-key-0123456789";
{
  const en = b2bEnrichEnabled().map((t) => t.slug);
  ok(en.length === 3 && APOLLO_SLUGS.every((s) => en.includes(s)) && HUNTER_SLUGS.every((s) => !en.includes(s)), `APOLLO only: 3 Apollo tools listed, no Hunter (${en.join(",")})`);
}
process.env.HUNTER_API_KEY = "hunter-test-key-0123456789";
ok(b2bEnrichEnabled().length === 7, "both keys: all 7 listed");
process.env.HUNTER_API_KEY = "  ";
ok(b2bEnrichEnabled().length === 3, "whitespace-only Hunter key counts as unset");
ok(b2bEnrichEnabled().every((t) => B2B_ENRICH_TOOLS.includes(t)), "enabled subset is the same tool objects (spreadable)");

// ----------------------------------------------------------------------------
// No key -> 503 (never reaches fetch); the OTHER provider's key does not help
// ----------------------------------------------------------------------------
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; return jsonRes(200, {}); };
delete process.env.HUNTER_API_KEY;
process.env.APOLLO_API_KEY = "apollo-test-key-0123456789";
await throws(h("hunter-domain-search")({ domain: "stripe.com" }), 503, "hunter-domain-search: 503 without HUNTER_API_KEY (Apollo key present)", /HUNTER_API_KEY/);
await throws(h("hunter-email-finder")({ domain: "stripe.com", first_name: "Jane", last_name: "Doe" }), 503, "hunter-email-finder: 503 without key");
await throws(h("hunter-email-verify")({ email: "a@stripe.com" }), 503, "hunter-email-verify: 503 without key");
await throws(h("hunter-company")({ domain: "stripe.com" }), 503, "hunter-company: 503 without key");
process.env.HUNTER_API_KEY = "hunter-test-key-0123456789";
delete process.env.APOLLO_API_KEY;
await throws(h("apollo-people-search")({ domains: ["stripe.com"] }), 503, "apollo-people-search: 503 without APOLLO_API_KEY (Hunter key present)", /APOLLO_API_KEY/);
await throws(h("apollo-org-enrich")({ domain: "stripe.com" }), 503, "apollo-org-enrich: 503 without key");
await throws(h("apollo-person-match")({ email: "a@stripe.com" }), 503, "apollo-person-match: 503 without key");
ok(fetchCalls === 0, "no-key path never calls fetch");

// ----------------------------------------------------------------------------
// Input validation (400) - before the key check
// ----------------------------------------------------------------------------
delete process.env.HUNTER_API_KEY;
delete process.env.APOLLO_API_KEY;
await throws(h("hunter-domain-search")({}), 400, "hunter-domain-search: missing domain");
await throws(h("hunter-domain-search")({ domain: "not a domain" }), 400, "hunter-domain-search: bad domain");
await throws(h("hunter-domain-search")({ domain: "localhost" }), 400, "hunter-domain-search: bare host without TLD");
await throws(h("hunter-domain-search")({ domain: "stripe.com", limit: 0 }), 400, "hunter-domain-search: limit 0");
await throws(h("hunter-domain-search")({ domain: "stripe.com", limit: 101 }), 400, "hunter-domain-search: limit over 100");
await throws(h("hunter-domain-search")({ domain: "stripe.com", type: "work" }), 400, "hunter-domain-search: bad type");
await throws(h("hunter-domain-search")({ domain: "stripe.com", department: 42 }), 400, "hunter-domain-search: non-string department");
await throws(h("hunter-email-finder")({ domain: "stripe.com" }), 400, "hunter-email-finder: no name");
await throws(h("hunter-email-finder")({ domain: "stripe.com", first_name: "Jane" }), 400, "hunter-email-finder: first_name without last_name");
await throws(h("hunter-email-finder")({ domain: "stripe.com", first_name: "<script>", last_name: "Doe" }), 400, "hunter-email-finder: name with markup");
await throws(h("hunter-email-finder")({ first_name: "Jane", last_name: "Doe" }), 400, "hunter-email-finder: missing domain");
await throws(h("hunter-email-verify")({}), 400, "hunter-email-verify: missing email");
await throws(h("hunter-email-verify")({ email: "not-an-email" }), 400, "hunter-email-verify: bad email");
await throws(h("hunter-email-verify")({ email: "a@b" }), 400, "hunter-email-verify: email without TLD");
await throws(h("hunter-company")({}), 400, "hunter-company: missing domain");
await throws(h("apollo-people-search")({}), 400, "apollo-people-search: missing domains");
await throws(h("apollo-people-search")({ domains: [] }), 400, "apollo-people-search: empty domains");
await throws(h("apollo-people-search")({ domains: ["stripe.com", "bad domain"] }), 400, "apollo-people-search: one bad domain rejects");
await throws(h("apollo-people-search")({ domains: Array.from({ length: 26 }, (_, i) => `d${i}.com`) }), 400, "apollo-people-search: over 25 domains");
await throws(h("apollo-people-search")({ domains: ["stripe.com"], per_page: 26 }), 400, "apollo-people-search: per_page over 25");
await throws(h("apollo-people-search")({ domains: ["stripe.com"], page: 0 }), 400, "apollo-people-search: page 0");
await throws(h("apollo-people-search")({ domains: ["stripe.com"], titles: "a".repeat(81) }), 400, "apollo-people-search: title over 80 chars");
await throws(h("apollo-people-search")({ domains: ["stripe.com"], keywords: "k".repeat(201) }), 400, "apollo-people-search: keywords over 200 chars");
await throws(h("apollo-org-enrich")({}), 400, "apollo-org-enrich: missing domain");
await throws(h("apollo-org-enrich")({ domain: "http://" }), 400, "apollo-org-enrich: unparseable URL");
await throws(h("apollo-person-match")({}), 400, "apollo-person-match: neither email nor name+domain");
await throws(h("apollo-person-match")({ first_name: "Jane", last_name: "Doe" }), 400, "apollo-person-match: name without domain");
await throws(h("apollo-person-match")({ email: "nope" }), 400, "apollo-person-match: bad email");
ok(fetchCalls === 0, "validation failures never call fetch");

// Pure helpers
ok(__test.takeDomain("https://www.Stripe.com/about") === "stripe.com", "takeDomain: URL reduced to host, www stripped, lowercased");
ok(__test.takeDomain("WWW.EXAMPLE.CO.UK/") === "example.co.uk", "takeDomain: bare host with path");
ok(__test.takeEmail("  Jane@Stripe.COM ") === "jane@stripe.com", "takeEmail: trimmed + lowercased");
ok(JSON.stringify(__test.takeStringList("a, b ,,c", "x", { max: 5 })) === JSON.stringify(["a", "b", "c"]), "takeStringList: comma string split + trimmed + empties dropped");

// ----------------------------------------------------------------------------
// Fixtures: Hunter
// ----------------------------------------------------------------------------
process.env.HUNTER_API_KEY = "hunter-test-key-0123456789";
process.env.APOLLO_API_KEY = "apollo-test-key-0123456789";
let lastUrl = null, lastInit = null;
const DOMAIN_SEARCH_FIXTURE = {
  data: {
    domain: "stripe.com", disposable: false, webmail: false, accept_all: false, pattern: "{first}", organization: "Stripe", industry: "Financial Services", country: "US", headcount: "1001-5000",
    emails: [
      { value: "jane@stripe.com", type: "personal", confidence: 92, sources: [{ domain: "x.com", uri: "https://x.com/1" }, { domain: "y.com", uri: "https://y.com/2" }], first_name: "Jane", last_name: "Doe", position: "Engineering Manager", seniority: "senior", department: "it", linkedin: "https://linkedin.com/in/janedoe", twitter: "janedoe", phone_number: "+1 555 0100", verification: { date: "2026-08-01", status: "valid" } },
      { value: "info@stripe.com", type: "generic", confidence: 70, sources: [], first_name: null, last_name: null, position: null, seniority: null, department: null, linkedin: null, twitter: null, phone_number: null, verification: { date: null, status: null } },
    ],
  },
  meta: { results: 2870, limit: 10, offset: 0, params: { domain: "stripe.com" } },
};
globalThis.fetch = async (url, init) => { fetchCalls++; lastUrl = new URL(String(url)); lastInit = init; return jsonRes(200, DOMAIN_SEARCH_FIXTURE); };
{
  fetchCalls = 0;
  const out = await h("hunter-domain-search")({ domain: "https://www.stripe.com", limit: 10, type: "personal", department: ["it", "sales"], seniority: "senior" });
  ok(lastUrl.origin + lastUrl.pathname === "https://api.hunter.io/v2/domain-search", "domain-search: hits /v2/domain-search");
  ok(lastUrl.searchParams.get("domain") === "stripe.com" && lastUrl.searchParams.get("limit") === "10" && lastUrl.searchParams.get("type") === "personal" && lastUrl.searchParams.get("department") === "it,sales" && lastUrl.searchParams.get("seniority") === "senior", "domain-search: domain/limit/type/department/seniority on the wire");
  ok(lastUrl.searchParams.get("api_key") === "hunter-test-key-0123456789", "domain-search: api_key rides the query");
  ok(lastInit.signal instanceof AbortSignal, "domain-search: abort signal (timeout) set");
  ok(out.source === "hunter" && !Number.isNaN(Date.parse(out.fetchedAt)), "domain-search: source + fetchedAt");
  ok(out.domain === "stripe.com" && out.organization === "Stripe" && out.pattern === "{first}" && out.acceptAll === false && out.webmail === false && out.industry === "Financial Services" && out.headcount === "1001-5000", "domain-search: domain facts");
  ok(out.total === 2870 && out.count === 2 && out.offset === 0, "domain-search: total/count/offset");
  const e0 = out.emails[0];
  ok(e0.email === "jane@stripe.com" && e0.type === "personal" && e0.confidence === 92 && e0.firstName === "Jane" && e0.position === "Engineering Manager" && e0.seniority === "senior" && e0.department === "it" && e0.verification.status === "valid" && e0.sourceCount === 2, "domain-search: email row shaped");
  const flat = JSON.stringify(out);
  ok(!flat.includes("+1 555 0100") && !/"[^"]*linkedin\.com\/in\/janedoe"/.test(flat) && !flat.includes("janedoe") && !/"[^"]*x\.com\/1"/.test(flat), "domain-search: phone, personal social handles and source URLs stripped");
  ok(out.emails[1].firstName === null && out.emails[1].verification.status === null, "domain-search: generic row nulls preserved");
  ok(fetchCalls === 1, "domain-search: one upstream call");
}

const FINDER_FIXTURE = { data: { first_name: "Jane", last_name: "Doe", email: "jane@example.com", score: 97, domain: "stripe.com", accept_all: false, position: "CEO", twitter: "exampleuser", linkedin_url: "https://linkedin.com/in/example-user", phone_number: "+1 555 0199", company: "Stripe", sources: [{ uri: "https://z.com" }], verification: { date: "2026-08-01", status: "valid" } }, meta: { params: {} } };
globalThis.fetch = async (url) => { fetchCalls++; lastUrl = new URL(String(url)); return jsonRes(200, FINDER_FIXTURE); };
{
  const out = await h("hunter-email-finder")({ domain: "stripe.com", first_name: "Jane", last_name: "Doe" });
  ok(lastUrl.pathname === "/v2/email-finder" && lastUrl.searchParams.get("first_name") === "Jane" && lastUrl.searchParams.get("last_name") === "Doe" && lastUrl.searchParams.get("domain") === "stripe.com" && lastUrl.searchParams.get("full_name") === null, "email-finder: /v2/email-finder with first/last/domain");
  ok(out.email === "jane@example.com" && out.score === 97 && out.position === "CEO" && out.company === "Stripe" && out.verification.status === "valid" && out.found === true, "email-finder: shaped");
  const flat = JSON.stringify(out);
  ok(!flat.includes("+1 555 0199") && !flat.includes("exampleuser") && !/"[^"]*linkedin\.com\/in\/[^"]*"/.test(flat) && !/"[^"]*z\.com[^"]*"/.test(flat), "email-finder: phone/social/source stripped");
  await h("hunter-email-finder")({ domain: "stripe.com", full_name: "Jane Doe" });
  ok(lastUrl.searchParams.get("full_name") === "Jane Doe" && lastUrl.searchParams.get("first_name") === null, "email-finder: full_name alternative on the wire");
}
globalThis.fetch = async () => jsonRes(200, { data: { first_name: "No", last_name: "Body", email: null, score: null, domain: "stripe.com", position: null, verification: null }, meta: {} });
{
  const out = await h("hunter-email-finder")({ domain: "stripe.com", first_name: "No", last_name: "Body" });
  ok(out.found === false && out.email === null, "email-finder: no match -> found:false, not an error");
}

const VERIFY_FIXTURE = { data: { status: "valid", result: "deliverable", score: 94, email: "support@stripe.com", regexp: true, gibberish: false, disposable: false, webmail: false, mx_records: true, smtp_server: true, smtp_check: true, accept_all: false, block: false, sources: [{}, {}, {}] }, meta: { params: {} } };
globalThis.fetch = async (url) => { lastUrl = new URL(String(url)); return jsonRes(200, VERIFY_FIXTURE); };
{
  const out = await h("hunter-email-verify")({ email: "Support@Stripe.com" });
  ok(lastUrl.pathname === "/v2/email-verifier" && lastUrl.searchParams.get("email") === "support@stripe.com", "email-verify: /v2/email-verifier?email= (lowercased)");
  ok(out.result === "deliverable" && out.status === "valid" && out.score === 94 && out.checks.mxRecords === true && out.checks.smtpCheck === true && out.checks.acceptAll === false && out.checks.block === false && out.sourceCount === 3, "email-verify: shaped with checks");
}
// Hunter deprecated `result`: an answer carrying only `status` still fills it.
for (const [status, result] of [["valid", "deliverable"], ["webmail", "deliverable"], ["invalid", "undeliverable"], ["accept_all", "risky"], ["disposable", "risky"], ["unknown", "unknown"]]) {
  const { result: _drop, ...noResult } = VERIFY_FIXTURE.data;
  globalThis.fetch = async () => jsonRes(200, { data: { ...noResult, status }, meta: {} });
  const out = await h("hunter-email-verify")({ email: "support@stripe.com" });
  ok(out.status === status && out.result === result, `email-verify: status ${status} with no result field -> result ${result}`);
}
{
  globalThis.fetch = async () => jsonRes(200, { data: { ...VERIFY_FIXTURE.data, status: "accept_all", result: "deliverable" }, meta: {} });
  const out = await h("hunter-email-verify")({ email: "support@stripe.com" });
  ok(out.result === "deliverable", "email-verify: a result the source sends is kept as sent");
}
globalThis.fetch = async () => jsonRes(202, {});
await throws(h("hunter-email-verify")({ email: "slow@stripe.com" }), 503, "email-verify: 202 still verifying -> 503 retry hint", /retry/);

const COMPANY_FIXTURE = { data: { id: "abc", name: "Stripe", legalName: "Stripe, Inc.", domain: "stripe.com", domainAliases: ["stripe.dev"], site: { phoneNumbers: ["+1 555 0100"], emailAddresses: ["legal@stripe.com"] }, category: { sector: "Financials", industryGroup: "Diversified Financials", industry: "Financial Services", subIndustry: "Payments" }, tags: ["Payments", "Fintech"], description: "Financial infrastructure for the internet.", foundedYear: 2010, location: "354 Oyster Point Blvd", timeZone: "America/Los_Angeles", geo: { streetNumber: "354", streetName: "Oyster Point Blvd", city: "South San Francisco", state: "California", country: "United States", countryCode: "US", lat: 37.6, lng: -122.4 }, linkedin: { handle: "company/stripe" }, twitter: { handle: "stripe", id: "1", followers: 10 }, emailProvider: false, type: "private", ticker: null, phone: "+1 555 0100", metrics: { employees: 8000, employeesRange: "5K-10K", marketCap: null, raised: 8700000000, annualRevenue: null, estimatedAnnualRevenue: "$1B-$10B" }, tech: ["google_analytics", "aws"], techCategories: ["analytics", "hosting"] }, meta: {} };
globalThis.fetch = async (url) => { lastUrl = new URL(String(url)); return jsonRes(200, COMPANY_FIXTURE); };
{
  const out = await h("hunter-company")({ domain: "stripe.com" });
  ok(lastUrl.pathname === "/v2/companies/find" && lastUrl.searchParams.get("domain") === "stripe.com", "company: /v2/companies/find?domain=");
  const c = out.company;
  ok(c.name === "Stripe" && c.legalName === "Stripe, Inc." && c.foundedYear === 2010 && c.category.industry === "Financial Services" && c.location.city === "South San Francisco" && c.location.countryCode === "US" && c.metrics.employees === 8000 && c.metrics.raised === 8700000000 && c.linkedin === "company/stripe" && c.tech.length === 2, "company: shaped");
  const flat = JSON.stringify(out);
  ok(!flat.includes("+1 555 0100") && !flat.includes("Oyster Point") && !flat.includes("legal@stripe.com"), "company: phone, street address and site emails stripped");
}
globalThis.fetch = async () => jsonRes(200, { data: null, meta: {} });
await throws(h("hunter-company")({ domain: "nobody.example" }), 404, "company: 200 with null data -> 404");

// ----------------------------------------------------------------------------
// Fixtures: Apollo
// ----------------------------------------------------------------------------
const PEOPLE_FIXTURE = {
  breadcrumbs: [], partial_results_only: false, total_entries: 140, page: 1, per_page: 5, num_pages: 28,
  people: [{ id: "5f1a", first_name: "Jane", last_name: "Doe", name: "Jane Doe", linkedin_url: "https://www.linkedin.com/in/janedoe", title: "Engineering Manager", email_status: "verified", photo_url: "https://img/x.jpg", twitter_url: "https://twitter.com/janedoe", github_url: null, facebook_url: "https://facebook.com/janedoe", headline: "Engineering Manager at Stripe", email: "jane@stripe.com", organization_id: "5e66", employment_history: [{ organization_name: "Old Co", title: "Dev" }], state: "Washington", city: "Seattle", country: "United States", seniority: "manager", departments: ["engineering"], functions: ["engineering"], organization: { id: "5e66", name: "Stripe", website_url: "http://www.stripe.com", primary_domain: "stripe.com", linkedin_url: "http://www.linkedin.com/company/stripe", industry: "financial services", estimated_num_employees: 8000, phone: "+1 555 0100" } }],
  contacts: [],
};
globalThis.fetch = async (url, init) => { fetchCalls++; lastUrl = new URL(String(url)); lastInit = init; return jsonRes(200, PEOPLE_FIXTURE); };
{
  fetchCalls = 0;
  const out = await h("apollo-people-search")({ domains: "stripe.com, Www.Stripe.dev", titles: ["engineering manager"], seniorities: ["Manager"], locations: ["seattle, us"], keywords: "payments", page: 1, per_page: 5 });
  ok(lastUrl.origin + lastUrl.pathname === "https://api.apollo.io/api/v1/mixed_people/search" && lastInit.method === "POST", "people-search: POST /api/v1/mixed_people/search");
  ok(lastInit.headers["x-api-key"] === "apollo-test-key-0123456789" && lastInit.headers["Content-Type"] === "application/json", "people-search: x-api-key header + JSON body");
  const body = JSON.parse(lastInit.body);
  ok(JSON.stringify(body.q_organization_domains_list) === JSON.stringify(["stripe.com", "stripe.dev"]) && JSON.stringify(body.person_titles) === JSON.stringify(["engineering manager"]) && JSON.stringify(body.person_seniorities) === JSON.stringify(["manager"]) && JSON.stringify(body.person_locations) === JSON.stringify(["seattle, us"]) && body.q_keywords === "payments" && body.page === 1 && body.per_page === 5, "people-search: body carries domains/titles/seniorities/locations/keywords/page/per_page");
  ok(out.source === "apollo" && out.totalEntries === 140 && out.numPages === 28 && out.page === 1 && out.perPage === 5 && out.partialResultsOnly === false && out.count === 1, "people-search: paging meta");
  const p = out.people[0];
  ok(p.id === "5f1a" && p.name === "Jane Doe" && p.title === "Engineering Manager" && p.seniority === "manager" && p.departments[0] === "engineering" && p.city === "Seattle" && p.linkedinUrl === "https://www.linkedin.com/in/janedoe" && p.emailStatus === "verified", "people-search: person shaped");
  ok(p.organization.name === "Stripe" && p.organization.domain === "stripe.com" && p.organization.estimatedEmployees === 8000, "people-search: organization brief");
  const flat = JSON.stringify(out);
  ok(!("email" in p) && !flat.includes("jane@stripe.com") && !flat.includes("img/x.jpg") && !/"[^"]*twitter\.com\/janedoe"/.test(flat) && !/"[^"]*facebook\.com[^"]*"/.test(flat) && !flat.includes("Old Co") && !flat.includes("+1 555 0100"), "people-search: email, photo, social handles, employment history and org phone stripped");
  ok(fetchCalls === 1, "people-search: one upstream call");
  const out2 = await h("apollo-people-search")({ domains: ["stripe.com"] });
  const body2 = JSON.parse(lastInit.body);
  ok(!("person_titles" in body2) && !("q_keywords" in body2) && body2.per_page === 10 && out2.query.titles.length === 0, "people-search: optional filters omitted from the body when empty; default per_page 10");
}

const ORG_FIXTURE = { organization: { id: "5e66", name: "Stripe", website_url: "http://www.stripe.com", linkedin_url: "http://www.linkedin.com/company/stripe", twitter_url: "https://twitter.com/stripe", primary_phone: { number: "+1 555 0100" }, phone: "+1 555 0100", founded_year: 2010, publicly_traded_symbol: null, publicly_traded_exchange: null, primary_domain: "stripe.com", industry: "financial services", keywords: ["payments", "developer tools"], estimated_num_employees: 8000, industries: ["financial services"], raw_address: "354 Oyster Point Blvd, South San Francisco", street_address: "354 Oyster Point Blvd", city: "South San Francisco", state: "California", postal_code: "94080", country: "United States", short_description: "Stripe builds financial infrastructure for the internet.", annual_revenue_printed: "16B", annual_revenue: 16000000000, total_funding: 8700000000, total_funding_printed: "8.7B", latest_funding_round_date: "2023-03-15T00:00:00.000+00:00", latest_funding_stage: "Series I", technology_names: ["Amazon AWS", "Google Analytics"], departmental_head_count: { engineering: 2500, sales: 900, bogus: "x" } } };
globalThis.fetch = async (url, init) => { lastUrl = new URL(String(url)); lastInit = init; return jsonRes(200, ORG_FIXTURE); };
{
  const out = await h("apollo-org-enrich")({ domain: "stripe.com" });
  ok(lastUrl.pathname === "/api/v1/organizations/enrich" && lastUrl.searchParams.get("domain") === "stripe.com" && (lastInit.method === "GET"), "org-enrich: GET /api/v1/organizations/enrich?domain=");
  const o = out.organization;
  ok(o.name === "Stripe" && o.domain === "stripe.com" && o.foundedYear === 2010 && o.industry === "financial services" && o.keywords.length === 2 && o.estimatedEmployees === 8000 && o.location.city === "South San Francisco" && o.annualRevenue === 16000000000 && o.totalFunding === 8700000000 && o.latestFundingStage === "Series I" && o.technologies.length === 2, "org-enrich: shaped");
  ok(o.departmentalHeadCount.engineering === 2500 && !("bogus" in o.departmentalHeadCount), "org-enrich: departmental head count numeric-only");
  const flat = JSON.stringify(out);
  ok(!flat.includes("+1 555 0100") && !flat.includes("Oyster Point") && !flat.includes("94080"), "org-enrich: phone, street address and postal code stripped");
}
globalThis.fetch = async () => jsonRes(200, { organization: null });
await throws(h("apollo-org-enrich")({ domain: "nobody.example" }), 404, "org-enrich: 200 with null organization -> 404");

const MATCH_FIXTURE = { person: { id: "5f1a", first_name: "Jane", last_name: "Doe", name: "Jane Doe", linkedin_url: "https://www.linkedin.com/in/example-user", title: "CEO", email_status: "verified", email: "jane@example.com", headline: "CEO at Stripe", photo_url: "https://img/p.jpg", twitter_url: "https://twitter.com/exampleuser", personal_emails: ["jane.personal@example.net"], phone_numbers: [{ raw_number: "+1 555 0111" }], city: "San Francisco", state: "California", country: "United States", seniority: "c_suite", departments: ["c_suite"], functions: ["entrepreneurship"], organization: { id: "5e66", name: "Stripe", primary_domain: "stripe.com", website_url: "http://www.stripe.com", linkedin_url: "http://www.linkedin.com/company/stripe", industry: "financial services", estimated_num_employees: 8000 } } };
globalThis.fetch = async (url, init) => { lastUrl = new URL(String(url)); lastInit = init; return jsonRes(200, MATCH_FIXTURE); };
{
  const out = await h("apollo-person-match")({ first_name: "Jane", last_name: "Doe", domain: "stripe.com", organization_name: "Stripe" });
  ok(lastUrl.pathname === "/api/v1/people/match" && lastInit.method === "POST", "person-match: POST /api/v1/people/match");
  ok(lastUrl.searchParams.get("reveal_personal_emails") === "false" && lastUrl.searchParams.get("reveal_phone_number") === "false", "person-match: personal emails + phone numbers never requested");
  const body = JSON.parse(lastInit.body);
  ok(body.first_name === "Jane" && body.last_name === "Doe" && body.domain === "stripe.com" && body.organization_name === "Stripe" && !("email" in body), "person-match: name + domain body");
  const p = out.person;
  ok(out.matched === true && p.name === "Jane Doe" && p.title === "CEO" && p.email === "jane@example.com" && p.emailStatus === "verified" && p.seniority === "c_suite" && p.linkedinUrl === "https://www.linkedin.com/in/example-user" && p.organization.domain === "stripe.com", "person-match: person shaped with work email");
  const flat = JSON.stringify(out);
  ok(!flat.includes("jane.personal@example.net") && !flat.includes("+1 555 0111") && !flat.includes("img/p.jpg") && !/"[^"]*twitter\.com\/exampleuser"/.test(flat), "person-match: personal emails, phones, photo, social handles stripped");
  await h("apollo-person-match")({ email: "Jane@Example.com" });
  const body2 = JSON.parse(lastInit.body);
  ok(body2.email === "jane@example.com" && !("domain" in body2) && !("first_name" in body2), "person-match: email-only body");
}
globalThis.fetch = async () => jsonRes(200, { person: null });
await throws(h("apollo-person-match")({ email: "nobody@stripe.com" }), 404, "person-match: 200 with null person -> 404");

// ----------------------------------------------------------------------------
// Upstream status mapping (both providers)
// ----------------------------------------------------------------------------
for (const [label, call] of [["hunter", () => h("hunter-domain-search")({ domain: "stripe.com" })], ["apollo", () => h("apollo-org-enrich")({ domain: "stripe.com" })]]) {
  globalThis.fetch = async () => jsonRes(401, { errors: [{ details: "SECRET-UPSTREAM-TEXT" }] });
  await throws(call(), 503, `${label}: 401 -> 503 not configured`, /not configured/);
  globalThis.fetch = async () => jsonRes(403, { error: "SECRET-UPSTREAM-TEXT" });
  await throws(call(), 503, `${label}: 403 -> 503 not configured`, /not configured/);
  globalThis.fetch = async () => jsonRes(402, { errors: [{ details: "SECRET-UPSTREAM-TEXT" }] });
  await throws(call(), 503, `${label}: 402 -> 503 quota`, /quota/);
  globalThis.fetch = async () => jsonRes(429, {}, { "retry-after": "30" });
  await throws(call(), 503, `${label}: 429 -> 503 quota with retry-after`, /quota.*retry after 30/);
  globalThis.fetch = async () => jsonRes(404, {});
  await throws(call(), 404, `${label}: 404 -> 404`);
  globalThis.fetch = async () => jsonRes(422, { errors: [{ details: "SECRET-UPSTREAM-TEXT" }] });
  await throws(call(), 400, `${label}: 422 -> 400 bad request`, /check the parameters/);
  globalThis.fetch = async () => jsonRes(500, { error: "SECRET-UPSTREAM-TEXT" });
  await throws(call(), 502, `${label}: 500 -> 502`);
  globalThis.fetch = async () => jsonRes(502, {});
  await throws(call(), 502, `${label}: 502 -> 502`);
  globalThis.fetch = async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); };
  await throws(call(), 503, `${label}: deadline -> 503 naming the upstream and the step`);
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error("bad json"); } });
  await throws(call(), 502, `${label}: non-JSON 200 -> 502`);
  const msgs = [];
  for (const st of [401, 402, 422, 500]) {
    globalThis.fetch = async () => jsonRes(st, { errors: [{ details: "SECRET-UPSTREAM-TEXT" }], error: "SECRET-UPSTREAM-TEXT" });
    try { await call(); } catch (e) { msgs.push(e.message); }
  }
  ok(msgs.length === 4 && msgs.every((m) => !m.includes("SECRET-UPSTREAM-TEXT")), `${label}: upstream error bodies never reach the buyer message`);
}

// ----------------------------------------------------------------------------
globalThis.fetch = realFetch;
if (stashedH === undefined) delete process.env.HUNTER_API_KEY; else process.env.HUNTER_API_KEY = stashedH;
if (stashedA === undefined) delete process.env.APOLLO_API_KEY; else process.env.APOLLO_API_KEY = stashedA;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
