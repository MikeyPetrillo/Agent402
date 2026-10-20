// The router lists, but never buys, routes that sell personal data about
// individuals (src/route-category.js). What this file pins:
//   (a) the classifier, both directions: person-level data products match;
//       company and business data, domain/WHOIS, wallet analytics, sanctions
//       and exclusion-list screening, ID-number validators and "person" words
//       in unrelated APIs do not;
//   (b) dispatchEligibility: a matching route is category_excluded on every
//       chain whatever its history, a business route of the same seller is
//       still eligible, and a seller-level verdict is not decided by one route;
//   (c) routeQuery leaves a matching route out (and counts it), in this thread
//       and in the router worker, which must give the same answer;
//   (d) on a booted server the route stays listed on /api/index?seller= with
//       its category_excluded verdict, /api/route never ranks it, the business
//       route of the same seller is still routed, and no tool in this host's
//       own catalog matches;
//   (e) route-execute names the reason when only excluded routes matched, and
//       the resolver filters every chain's candidates (Tempo and Algorand
//       come from their own catalogs, not from routeQuery).
// Offline: placeholder hosts only, the crawler is off, nothing leaves the machine.
//
//   node scripts/test-router-people-data.js
process.env.X402_INDEX_CRAWL = "off";
process.env.ROUTER_WORKERS = "1";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";
import { personalDataMatch, routeExcludedCategory, PERSONAL_DATA_PATTERNS } from "../src/route-category.js";
import { dispatchEligibility, DISPATCH_REASONS } from "../src/dispatch-eligibility.js";
import { buildRouteExecuteTool } from "../src/tools/route-execute.js";

let pass = 0;
const procs = new Set();
const ok = (c, m) => {
  if (!c) { console.error(`FAIL - ${m}`); for (const p of procs) p.kill("SIGTERM"); process.exit(1); }
  pass++; console.log(`ok - ${m}`);
};

// ------------------------------------------------------------- (a) classifier
const POSITIVES = [
  { route: "/v1/people/search", name: "People search", description: "Find people by name, phone number or street address. Returns current address, age range and phone numbers." },
  { route: "/api/person/enrich", name: "Person enrich", description: "Career history, personal emails and mobile phone for one individual, keyed by name and company or a profile URL." },
  { route: "/background-check", name: "Background check", description: "Instant background check on any individual: criminal records, evictions, liens and address history." },
  { route: "/v1/skiptrace", name: "Skip trace", description: "Locate a debtor from a name and last known address." },
  { route: "/reverse-phone", name: "Phone owner", description: "Reverse phone lookup: who owns this number, with owner name and carrier." },
  { route: "/v2/lookup/email-owner", name: "Reverse email lookup", description: "The person behind an email address." },
  { route: "/records", name: "Records search", description: "Criminal records and arrest history for a named person across state databases." },
  { route: "/x402/search-cases", name: "Court cases", description: "List court cases and filings for a person by full name in one county court system." },
  { route: "/tenant-screening", name: "Tenant screening report", description: "Eviction filings, credit header and identity match for a rental applicant." },
  { route: "/employment/verify", name: "Verify employment", description: "Employment verification for a named employee: employer, title and dates." },
  { route: "/api/relatives", name: "Relatives", description: "Get a person's relatives, associates and past addresses from public records." },
  { route: "/v1/contacts/find", name: "Contact finder", description: "Find someone's email and direct dial from their name and company domain." },
  { route: "/agent/v1/profiles/enrich", name: "Profile enrich", description: "LinkedIn profile enrichment API for one B2B lead." },
  { route: "/email-finder", name: "Find email", description: "The most likely work email from a first name, last name and company domain." },
  { route: "/v1/directory", name: "White pages", description: "Residential listings by surname and city." },
  { route: "/people", name: "People", description: "Looks up a person from an email, name or company and returns a normalized public-data record." },
  { route: "/registry/check", name: "Registry check", description: "Sex offender registry check by name and ZIP code." },
  { route: "/residents", name: "Residents", description: "Who lives at this address: current residents with names and ages." },
  { route: "/v1/lookup", name: "Lookup", description: "Fast lookup.", tags: ["people search", "identity"] },
  { route: "/api/v1/caller-id", name: "Caller ID", description: "CNAM lookup: caller name for any US phone number." },
];
const CONTROLS = [
  { route: "/api/company-enrich", name: "Company enrich", description: "Org enrich / company enrichment by domain or name. Firmographics pack: name, employees, country, industry, website." },
  { route: "/api/company-research", name: "Company research", description: "Company research and firmographics for AI agents. Use before people enrichment." },
  { route: "/v1/company-dossier", name: "Company dossier", description: "Company research from a website domain. Do not use for private financials or people search." },
  { route: "/v1/domain/rdap", name: "Domain RDAP", description: "Domain registration facts from RDAP: registrar, registrant organization, creation and expiry dates." },
  { route: "/whois", name: "WHOIS lookup", description: "WHOIS record for a domain: registrar, name servers, registrant contact where published." },
  { route: "/enrich/email", name: "Email domain check", description: "Validate and classify an email domain from public DNS: MX hosts, SPF and DMARC, disposable and free-webmail flags." },
  { route: "/entrypoints/enrich-wallet-full/invoke", name: "Wallet enrich", description: "DeFi positions, connected wallets and behavioral signals added to a wallet profile." },
  { route: "/v1/compliance/sanctions-screen", name: "Sanctions screen", description: "Screen any person or company against the OFAC SDN and Consolidated lists, with aliases and fuzzy matching." },
  { route: "/v1/check", name: "Exclusion list check", description: "Screen a person or business against federal exclusion lists. Match by name, NPI, UEI or CAGE." },
  { route: "/v1/kyb", name: "KYB", description: "Know-your-business check: registry status, directors and beneficial owners of a company." },
  { route: "/v1/t/cpr_dk_validate", name: "CPR validate", description: "Offline validator for a Danish personal identification number (format DDMMYY-SSSS): checks digit count and date validity." },
  { route: "/us/city/property-check", name: "Property check", description: "Does this address have open building code violations? Returns case numbers and status for tenant screening and landlord diligence." },
  { route: "/interest-by-region", name: "Interest by region", description: "Search interest by region for a keyword: where in a country people search for it most, ranked 0-100." },
  { route: "/v1/name-resolution", name: "Name resolution", description: "ENS and reverse name resolution across EVM chains." },
  { route: "/api/background-remover", name: "Background remover", description: "Removes the background from an image." },
  { route: "/intel", name: "Company intel", description: "Research a company or website in one call: legitimacy verdict, domain age, scam red flags, background checks for agents." },
  { route: "/api/legal/rights", name: "Know your rights", description: "Know-your-rights scripts for traffic stops, arrests, search and seizure." },
  { route: "/v1/json/validate", name: "JSON validate", description: "Validate a JSON document against a schema, for example a Person object with name, email and phone fields." },
  { route: "/v1/fake/person", name: "Fake person generator", description: "A random fake person (name, address, phone) for test fixtures." },
  { route: "/v1/vision/detect", name: "Object detection", description: "Detect people and person bounding boxes in an image." },
  { route: "/entity-extract", name: "Entity extract", description: "Extract named entities from text: people, organizations, locations, dates and emails." },
  { route: "/contacts", name: "Website contacts", description: "Extract public business emails, phone numbers and social profiles from a website. Batch-safe contact enrichment for agents." },
  { route: "/extract/resume", name: "Resume parser", description: "Extract structured data from resume text: name, contact info, skills and work experience, so agents can automate applicant screening." },
  { route: "/api/ip-lookup", name: "IP lookup", description: "IP geolocation, ASN, and proxy detection for any address." },
];
for (const r of POSITIVES) ok(personalDataMatch(r) !== null && routeExcludedCategory(r) === "personal_data", `matches: ${r.route} (${personalDataMatch(r)})`);
for (const r of CONTROLS) ok(personalDataMatch(r) === null && routeExcludedCategory(r) === null, `does not match: ${r.route}${personalDataMatch(r) ? ` (matched ${personalDataMatch(r)})` : ""}`);
{
  const hit = new Set(POSITIVES.map((r) => personalDataMatch(r)));
  const unused = PERSONAL_DATA_PATTERNS.map((p) => p.id).filter((id) => !hit.has(id) && !["individual_lookup", "relatives"].includes(id));
  ok(unused.length === 0, `every pattern family has a positive here (${unused.join(", ") || "all covered"})`);
  ok(personalDataMatch({ route: "/x", name: "x", description: "Relatives of a person by name." }) === "relatives" && personalDataMatch({ route: "/x", name: "Individual lookup", description: "x" }) === "individual_lookup", "the two remaining families match their own wording");
  ok(personalDataMatch("") === null && personalDataMatch(null) === null && personalDataMatch({}) === null, "empty input matches nothing");
}

// ------------------------------------------------------------- (b) dispatchEligibility
const ORIGIN = "https://records-and-companies.example";
const PAYTO = "0x3D7718d5D868AF1Daae41D757244DE73DF72FB53";
const PEOPLE_TOOL = { seller: ORIGIN, method: "POST", route: "/v1/people/search", slug: "people-search", name: "People search", description: "Find people by name, phone number or street address.", category: "data", tags: [], price: "$0.01", networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": PAYTO } };
const COMPANY_TOOL = { seller: ORIGIN, method: "POST", route: "/v1/company/enrich", slug: "company-enrich", name: "Company enrich", description: "Company enrichment by domain: firmographics, employees, industry and website.", category: "data", tags: [], price: "$0.01", networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": PAYTO } };
{
  const proven = { routable: true, networks: ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"], settled: 500, payers: 40, priceUsd: 0.01, spendChains: ["base", "solana"], minSettled: 50, minPayers: 3 };
  const p = dispatchEligibility({ ...proven, routeText: PEOPLE_TOOL });
  ok(p.eligible === false && p.reason === "category_excluded", `a proven, routable people-search route is category_excluded (${p.reason})`);
  ok(p.chains.base?.reason === "category_excluded" && p.chains.solana?.reason === "category_excluded" && !p.chains.base.unprovenTier, "...on every chain it advertises, with no unproven tier");
  const pFail = dispatchEligibility({ ...proven, routable: false, routeText: PEOPLE_TOOL });
  ok(pFail.reason === "category_excluded", "the category outranks a failed crawl (what it sells decides before how it is paid)");
  const c = dispatchEligibility({ ...proven, routeText: COMPANY_TOOL });
  ok(c.eligible === true && c.chains.base?.reason === "eligible", `the same seller's company-enrichment route is eligible (${c.reason})`);
  const s = dispatchEligibility({ ...proven });
  ok(s.eligible === true, "a seller-level verdict (no route text) is not decided by one route's category");
  ok(typeof DISPATCH_REASONS.category_excluded === "string" && /personal data about individuals/.test(DISPATCH_REASONS.category_excluded), "category_excluded is documented in DISPATCH_REASONS");
}

// ------------------------------------------------------------- (c) routeQuery, in-thread and worker
const xi = await import("../src/x402-index.js");
const pool = await import("../src/router-pool.js");
{
  const cache = xi._cacheForTests();
  cache.clear();
  const entry = (origin, tools) => ({ manifest: { name: origin.replace(/^https?:\/\//, ""), homepage: origin }, tools, fetchedAt: Date.now(), error: null, history: [1, 1, 1, 1, 1] });
  cache.set(ORIGIN, entry(ORIGIN, [PEOPLE_TOOL, COMPANY_TOOL]));
  cache.set("https://directory.example", entry("https://directory.example", [{ ...PEOPLE_TOOL, seller: "https://directory.example", route: "/api/person-lookup", slug: "person-lookup", name: "Person lookup", description: "Person lookup by phone or email." }]));
  cache.set("https://firmo.example", entry("https://firmo.example", [{ ...COMPANY_TOOL, seller: "https://firmo.example" }]));
  const ctx = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "agent402.base.eth" };
  const q = (query) => xi.routeQuery({ query, top: 10, include: "external", ...ctx });
  const people = q("people search person lookup");
  ok(people.results.every((r) => !/people-search|person-lookup/.test(r.slug)), `routeQuery never ranks a people-search route (${people.results.map((r) => r.slug).join(", ") || "none"})`);
  ok(people.categoryExcluded === 2, `...and counts the matching routes it left out (categoryExcluded ${people.categoryExcluded})`);
  const firms = q("company enrichment");
  ok(firms.results.some((r) => r.seller === ORIGIN && r.slug === "company-enrich") && firms.results.some((r) => r.seller === "https://firmo.example"), "the same seller's company-enrichment route is still ranked");
  ok(firms.categoryExcluded === undefined, "an answer with nothing left out carries no categoryExcluded field");
  // The memo path (one /api/route call scores once for its page and its shortlist) keeps the count.
  const memo = {};
  xi.routeQuery({ query: "people search", top: 5, include: "external", scoredMemo: memo, ...ctx });
  const again = xi.routeQuery({ query: "people search", top: 25, include: "external", scoredMemo: memo, ...ctx });
  ok(again.categoryExcluded === xi.routeQuery({ query: "people search", top: 25, include: "external", ...ctx }).categoryExcluded && again.categoryExcluded > 0, "a memoized second call reports the same count");

  // The worker imports this same index module and scores with the same
  // toolStatics, so its answer must be byte-identical.
  const workerSrc = readFileSync(new URL("../src/router-worker-thread.js", import.meta.url), "utf8");
  ok(/await import\("\.\/x402-index\.js"\)/.test(workerSrc) && /xi\.routeQuery\(/.test(workerSrc), "the router worker runs routeQuery from src/x402-index.js");
  xi.warmRouteIndex();
  await xi._routeIndexSettledForTest();
  pool.startRouterPool();
  await pool.routerPoolLoaded();
  try {
    for (const query of ["people search person lookup", "company enrichment", "person lookup"]) {
      const a = xi.routeQuery({ query, top: 10, include: "external", ...ctx });
      const b = await xi.routeQueryAsync({ query, top: 10, include: "external", ...ctx });
      ok(JSON.stringify(a) === JSON.stringify(b), `the worker and this thread give the same answer for "${query}" (categoryExcluded ${b.categoryExcluded ?? 0})`);
    }
    ok(pool.routerPoolStatus().served.worker >= 3, `those answers came from the worker (${pool.routerPoolStatus().served.worker})`);
  } finally { await pool.stopRouterPool(); }
  cache.clear();
}

// ------------------------------------------------------------- (e) route-execute and the resolver
{
  const CATALOG = {};
  let paid = false;
  const resolveExternal = async () => { const none = []; Object.defineProperty(none, "__gateDrops", { value: { total: 2, byReason: { category_excluded: 2 } }, enumerable: false }); return none; };
  const tool = buildRouteExecuteTool({ getCatalog: () => CATALOG, tier: { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 }, resolveExternal, payExternal: async () => { paid = true; }, externalEnabled: () => true });
  let err = null;
  try { await tool.handler({ task: "people search by phone", include: "external" }, {}); } catch (e) { err = e; }
  ok(err && err.statusCode === 404 && /personal data about individuals/.test(err.message) && /Nothing was spent/.test(err.message) && !paid, `route-execute names the reason and pays nothing (${err?.statusCode}: ${err?.message})`);

  const serverSrc = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const fn = serverSrc.slice(serverSrc.indexOf("async function resolveExternalSeller("), serverSrc.indexOf("const { probePublicUrl } = await import(\"./tools/fetch-guard.js\");"));
  const filterAt = fn.indexOf("if (!routeExcludedCategory(r)) return true;");
  ok(filterAt > fn.indexOf('} else if (chain === "algorand") {') && filterAt > fn.indexOf('} else if (chain === "solana") {') && filterAt < fn.indexOf("orderByJudgment("), "the resolver filters the candidates of every chain branch, before judging or probing any");
  ok(/description: r\.description, tags: r\.tags,/.test(fn) && /\/\/ The route's own text, for the category filter below\.\n\s+description: r\.description,\n\s+\}\)\);/.test(fn), "Tempo and Algorand candidates carry their own text to that filter");
  ok(/routeText: r, usdcDomain:/.test(fn) && /routeText: r, binding: r\.binding, livePayTo \}\)/.test(serverSrc), "the Base pre-probe gate and the live gate both read the route text");
  ok(/rowLevel \? \{ priceUsd: row\.priceUsd \?\? null, urlTemplate: !!row\.urlTemplate, routeText: row \}/.test(serverSrc), "every public route row's label reads the route text (withDispatchFields)");
}

// ------------------------------------------------------------- (d) a booted server
{
  const dir = mkdtempSync(join(tmpdir(), "a402-people-data-"));
  const now = Date.now();
  const sellerEntry = [ORIGIN, {
    manifest: { name: "Records and companies", homepage: ORIGIN }, fetchedAt: now, source: "manifest", error: null, history: [1, 1, 1, 1, 1],
    payToByNetwork: { "eip155:8453": PAYTO },
    evmDomainByNetwork: { "eip155:8453": { name: "USD Coin", version: "2" } },
    tools: [PEOPLE_TOOL, COMPANY_TOOL],
  }];
  const lbFile = join(dir, "leaderboard-snapshot.json");
  writeFileSync(lbFile, JSON.stringify({
    spec: "x402-leaderboard/1", asOf: new Date(now).toISOString(), windowLabel: "7d",
    leaderboard: [{ rank: 1, homepage: ORIGIN, origins: [ORIGIN], wallet: PAYTO.toLowerCase(), wallets: [PAYTO.toLowerCase()], callsSettled: 500, uniqueBuyers: 40 }],
    walletEvidence: { [PAYTO.toLowerCase()]: { callsSettled: 500, uniqueBuyers: 40, origins: [ORIGIN] } },
  }));
  writeFileSync(join(dir, "x402-index-cache.ndjson"), [JSON.stringify({ savedAt: now, format: "ndjson-v1", origins: 1 }), JSON.stringify(sellerEntry)].join("\n") + "\n");
  const port = await getFreePort();
  const proc = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, FREE_MODE: "true", PORT: String(port), INDEX_CACHE_FILE: join(dir, "x402-index-cache.json"), INDEX_FIRST_CRAWL_DELAY_MS: "999999999", X402_INDEX_CRAWL: "", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", STATE_DATABASE_URL: "", X402_ECONOMY_DB: join(dir, "econ.db"), LEADERBOARD_SNAPSHOT_FILE: lbFile, ROUTER_WORKERS: "1", HUNTER_API_KEY: "test-placeholder", APOLLO_API_KEY: "test-placeholder" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  procs.add(proc);
  const base = `http://127.0.0.1:${port}`;
  try {
    let detail = null;
    for (let i = 0; i < 180 && !detail; i++) {
      try { const r = await fetch(`${base}/api/index?seller=${encodeURIComponent(ORIGIN)}`); if (r.ok) detail = await r.json(); } catch {}
      if (!detail) await new Promise((r) => setTimeout(r, 500));
    }
    ok(detail && detail.origin === ORIGIN && detail.tools?.length === 2, "the seller is listed with both routes on /api/index?seller=");
    const pRow = detail.tools.find((t) => t.slug === "people-search");
    const cRow = detail.tools.find((t) => t.slug === "company-enrich");
    ok(pRow && pRow.routerDispatchEligible === false && pRow.routerDispatchReason === "category_excluded" && pRow.routerDispatchByChain?.base?.reason === "category_excluded", `the people-search row shows category_excluded (${JSON.stringify(pRow?.routerDispatchByChain)})`);
    ok(cRow && cRow.routerDispatchEligible === true && cRow.routerDispatchByChain?.base?.eligible === true, `the company-enrichment row of the same seller is eligible (${JSON.stringify(cRow?.routerDispatchByChain)})`);
    ok(detail.legend?.routerDispatchReason?.category_excluded === DISPATCH_REASONS.category_excluded, "the legend served beside the rows explains category_excluded");

    // /api/route: never ranked; the business route is.
    let people = null;
    for (let i = 0; i < 60 && !people; i++) {
      const r = await fetch(`${base}/api/route?q=${encodeURIComponent("people search")}&include=external&top=10`);
      if (r.ok) { const j = await r.json(); if (!j.indexing) people = j; }
      if (!people) await new Promise((r) => setTimeout(r, 500));
    }
    ok(people && !(people.results || []).some((r) => r.slug === "people-search") && people.categoryExcluded >= 1, `/api/route never ranks the people-search route and says one was left out (categoryExcluded ${people?.categoryExcluded})`);
    const firms = await (await fetch(`${base}/api/route?q=${encodeURIComponent("company enrichment")}&include=external&top=10`)).json();
    const fRow = (firms.results || []).find((r) => r.seller === ORIGIN && r.slug === "company-enrich");
    ok(fRow && fRow.routerDispatchEligible === true && fRow.executeViaCallableNow === true, "/api/route ranks the same seller's company-enrichment route as callable now");

    // The seller's own report reads the same per-route verdicts.
    const trust = await (await fetch(`${base}/api/x402/seller-trust?origin=${encodeURIComponent(ORIGIN)}`)).json();
    ok(trust.lanes?.proven?.eligible === true && trust.lanes.proven.toolCount === 1, `seller-trust counts only the company route as payable (${JSON.stringify(trust.lanes?.proven)})`);

    // The /sell page names the reason in one sentence.
    const sell = await (await fetch(`${base}/sell`)).text();
    ok(sell.includes(">category_excluded<") && sell.includes(DISPATCH_REASONS.category_excluded), "the /sell page lists category_excluded with the router's own reason text");

    // This host's own catalog is never excluded by the rule, even where a
    // tool's words match it (the key-gated lookup tools are booted here with
    // placeholder keys so they are in the catalog): /api/route still ranks them.
    const page = await (await fetch(`${base}/api/index?limit=1&page=0`)).json();
    const self = (page.sellers || []).find((s) => s.origin === "self");
    const local = self?.tools || [];
    const localHits = local.filter((t) => personalDataMatch(t));
    ok(local.length >= 400, `the host's own catalog is in the index (${local.length} tools)`);
    for (const t of localHits) {
      const r = await (await fetch(`${base}/api/route?q=${encodeURIComponent(t.name || t.slug)}&top=10`)).json();
      ok((r.results || []).some((x) => x.slug === t.slug), `own tool ${t.slug} matches the category words and still ranks (categoryExcluded ${r.categoryExcluded})`);
    }
    ok(localHits.length >= 1, `the control set includes an own tool that matches the words (${localHits.map((t) => t.slug).join(", ")})`);
  } finally { proc.kill("SIGTERM"); }
}

assert.ok(pass > 0);
console.log(`OK: ${pass} passed`);
process.exit(0);
