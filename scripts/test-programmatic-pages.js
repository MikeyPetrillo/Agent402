#!/usr/bin/env node
// Programmatic SEO landing pages (/reports/insider/:ticker,
// /reports/fund/:manager, /reports/dossier/:ticker) - offline unit tests.
// No network, no server: the teaser builders take injectable EDGAR deps and
// the page builders are pure functions of a data object.
//
// What these assertions are actually protecting:
//
//  - COST. These pages are free and public, so the guards that keep a crawler
//    (or a scanner spraying four-letter slugs) from turning them into an EDGAR
//    amplifier are load-bearing: shape validation BEFORE any upstream call, a
//    12-hour positive cache, a negative cache on misses, and a hard entry cap
//    with eviction so the cache itself cannot grow without bound.
//  - HONESTY. Prices come from HUMAN_PRODUCTS and the catalog tier tables, so
//    a price change never leaves a stale number on a landing page.
//  - SEO. Every page needs its OWN title, description and canonical, and its
//    JSON-LD has to actually parse - a malformed block is worse than none.
//  - SAFETY. Filer names come from third-party XML. They are shown as filed,
//    which means they must be ESCAPED, not trusted.
//
//   node scripts/test-programmatic-pages.js
import {
  TICKER_RE, MANAGER_SLUG_RE, normalizeTicker, normalizeManagerSlug, slugToName,
  createTeaserCache, loadTeaser, buildInsiderTeaser, buildFundTeaser, buildDossierTeaser,
  insiderPage, fundPage, dossierPage, hubPage, FAMILIES, isUnresolvable,
} from "../src/programmatic-pages.js";
import { SEED_TICKERS, SEED_MANAGERS, seededProgrammaticPaths, seededManager, isSeededTicker } from "../src/programmatic-seeds.js";
import { HUMAN_PRODUCTS } from "../src/human-checkout.js";
import { sitemapReports, sitemapXml, sitemapIndex } from "../src/seo.js";

const BASE = "https://agent402.tools";
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const eq = (a, b, msg) => ok(a === b, `${msg}${a === b ? "" : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`);

// ---------------------------------------------------------------------------
// 1. Slug validation - the cheapest guard, and the one that has to hold.
// ---------------------------------------------------------------------------
for (const t of ["AAPL", "aapl", "BRK-B", "F", "T", "BRK.B", " msft "]) ok(normalizeTicker(t) !== null, `ticker accepted: ${JSON.stringify(t)}`);
for (const t of ["", "TOOLONGX", "AAPL1", "AA PL", "../etc", "AAPL/../x", "<script>", "%2e%2e", "aapl.js"]) ok(normalizeTicker(t) === null, `ticker rejected: ${JSON.stringify(t)}`);
eq(normalizeTicker("aapl"), "AAPL", "ticker is upper-cased before matching");
ok(TICKER_RE.source === "^[A-Z.\\-]{1,6}$", "ticker regex is the documented one (anchored, 1-6 chars, no digits)");

for (const s of ["berkshire-hathaway", "d-e-shaw", "point72-asset-management", "ab"]) ok(normalizeManagerSlug(s) !== null, `manager slug accepted: ${s}`);
for (const s of ["", "a", "-leading", "trailing-", "Has Space", "x".repeat(61), "../../etc/passwd", "a/b"]) ok(normalizeManagerSlug(s) === null, `manager slug rejected: ${JSON.stringify(s)}`);
// Case is normalized rather than refused: a hand-typed link should work, and
// the route 301s anything that is not already the canonical form.
eq(normalizeManagerSlug("Berkshire-Hathaway"), "berkshire-hathaway", "a mixed-case manager slug normalizes to the canonical lowercase form");
ok(MANAGER_SLUG_RE.source === "^[a-z0-9-]{2,60}$", "manager slug regex is the documented one");
eq(slugToName("pershing-square-capital-management"), "Pershing Square Capital Management", "slugToName rebuilds a searchable name");
eq(slugToName("d-e-shaw"), "D E Shaw", "slugToName keeps short tokens upper-cased");

// ---------------------------------------------------------------------------
// 2. Cache: TTL, negative entries, and the hard entry cap.
// ---------------------------------------------------------------------------
{
  let t = 1_000;
  const c = createTeaserCache({ ttlMs: 100, negTtlMs: 10, max: 3, now: () => t });
  c.setValue("a", { v: 1 });
  eq(c.get("a").value.v, 1, "cache returns a stored value");
  t += 99;
  ok(c.get("a"), "value is still live just inside the TTL");
  t += 2;
  ok(c.get("a") === null, "value expires at the TTL");
  eq(c.size, 0, "an expired entry is deleted on read, not merely hidden");

  c.setMiss("gone");
  ok(c.get("gone")?.miss === true, "a negative entry is stored and readable");
  t += 11;
  ok(c.get("gone") === null, "a negative entry expires on its own shorter TTL");

  for (const k of ["k1", "k2", "k3", "k4", "k5"]) c.setValue(k, k);
  ok(c.size <= 3, `cache never exceeds its entry cap (size ${c.size} <= 3)`);
  ok(c.get("k1") === null && c.get("k5") !== null, "eviction is oldest-first (the newest survives)");
  // A flood of unresolvable slugs must not be able to evict more than the cap.
  for (let i = 0; i < 500; i++) c.setMiss(`junk${i}`);
  ok(c.size <= 3, `a 500-slug negative flood still leaves the cache bounded (size ${c.size})`);
}

// ---------------------------------------------------------------------------
// 3. loadTeaser: cache reuse, missing vs degraded, negative caching.
// ---------------------------------------------------------------------------
{
  const c = createTeaserCache({ ttlMs: 10_000, negTtlMs: 10_000, max: 50 });
  let calls = 0;
  const builders = { insider: async (slug) => { calls++; return { kind: "insider", ticker: slug }; } };
  const a = await loadTeaser("insider", "AAPL", { builders, teaserCache: c });
  const b = await loadTeaser("insider", "AAPL", { builders, teaserCache: c });
  eq(a.status, "ok", "first load builds");
  eq(b.status, "ok", "second load is served");
  eq(calls, 1, "a cached entity is served WITHOUT a second EDGAR build");
}
{
  const c = createTeaserCache({ ttlMs: 10_000, negTtlMs: 10_000, max: 50 });
  let calls = 0;
  const notFound = () => { calls++; const e = new Error("Unknown ticker"); e.statusCode = 404; throw e; };
  const r1 = await loadTeaser("insider", "ZZZZZZ", { builders: { insider: notFound }, teaserCache: c });
  const r2 = await loadTeaser("insider", "ZZZZZZ", { builders: { insider: notFound }, teaserCache: c });
  eq(r1.status, "missing", "an unresolvable slug reports missing (the caller renders the 404 page)");
  eq(r2.status, "missing", "the miss is remembered");
  eq(calls, 1, "a negative-cached slug does NOT hit EDGAR again");
}
{
  // EDGAR unreadable is NOT the same answer as "this entity does not exist".
  const c = createTeaserCache({ ttlMs: 10_000, negTtlMs: 10_000, max: 50 });
  const boom = () => { const e = new Error("EDGAR upstream HTTP 503"); e.statusCode = 502; throw e; };
  const seededRes = await loadTeaser("insider", "AAPL", { seeded: true, builders: { insider: boom }, teaserCache: c });
  eq(seededRes.status, "degraded", "a KNOWN entity still gets its page when EDGAR cannot be read");
  ok(c.get("insider:AAPL") === null, "a read failure on a known entity is never cached as a miss");
  const offList = await loadTeaser("insider", "QQQQQ", { seeded: false, builders: { insider: boom }, teaserCache: c });
  eq(offList.status, "missing", "an off-list slug we cannot verify is refused");
  ok(c.get("insider:QQQQQ")?.miss === true, "that refusal is negative-cached (briefly) so a scanner cannot re-drive it");
}
{
  // A build that resolved the entity but could not read part of its data must
  // not be frozen onto the page for the full 12 hours.
  let seenTtl = "unset";
  const spy = { get: () => null, setValue: (_k, v, ttl) => { seenTtl = ttl; return v; }, setMiss: () => null };
  await loadTeaser("insider", "X", { builders: { insider: async () => ({ partial: false }) }, teaserCache: spy });
  eq(seenTtl, undefined, "a COMPLETE teaser is cached with the default (long) TTL");
  await loadTeaser("insider", "Y", { builders: { insider: async () => ({ partial: true }) }, teaserCache: spy });
  ok(typeof seenTtl === "number" && seenTtl > 0 && seenTtl <= 30 * 60_000, `a PARTIAL teaser gets a short explicit TTL (${seenTtl}ms)`);
}
{
  const c = createTeaserCache({ ttlMs: 10_000, negTtlMs: 10_000, max: 50 });
  const r = await loadTeaser("nonsense", "AAPL", { teaserCache: c });
  eq(r.status, "missing", "an unknown page family reports missing rather than throwing");
}
{
  // EDGAR collapses every non-5xx upstream status onto 422, so a rate-limit
  // (403) is indistinguishable from an unknown CIK unless upstreamStatus is
  // read. Caching a throttle as a miss 404s real tickers - measured live.
  ok(isUnresolvable(Object.assign(new Error("x"), { statusCode: 404 })), "a 404 is treated as unresolvable");
  ok(isUnresolvable(Object.assign(new Error("x"), { statusCode: 422, upstreamStatus: 404 })), "a 422 whose upstream said 404 is unresolvable");
  ok(!isUnresolvable(Object.assign(new Error("x"), { statusCode: 422, upstreamStatus: 403 })), "an EDGAR RATE LIMIT (403) is never treated as unresolvable");
  ok(!isUnresolvable(Object.assign(new Error("x"), { statusCode: 422, upstreamStatus: 429 })), "an EDGAR 429 is never treated as unresolvable");
  ok(!isUnresolvable(Object.assign(new Error("x"), { statusCode: 502, upstreamStatus: 503 })), "an EDGAR outage is never treated as unresolvable");
  ok(!isUnresolvable(Object.assign(new Error("x"), { gateBusy: true })), "our own saturated gate is never treated as unresolvable");
  ok(!isUnresolvable(Object.assign(new Error("timeout"), { statusCode: 504 })), "a timeout is never treated as unresolvable");
  // The live incident in one assertion: a throttled seeded ticker must not 404.
  const c2 = createTeaserCache({ ttlMs: 10_000, negTtlMs: 10_000, max: 50 });
  const throttled = () => { throw Object.assign(new Error("EDGAR upstream HTTP 403"), { statusCode: 422, upstreamStatus: 403 }); };
  const r2 = await loadTeaser("insider", "AAPL", { seeded: true, builders: { insider: throttled }, teaserCache: c2 });
  eq(r2.status, "degraded", "a seeded ticker throttled by EDGAR degrades, it never 404s");
  eq(c2.size, 0, "and nothing about that throttle is cached");
}

// ---------------------------------------------------------------------------
// 4. Teaser builders against fixtures (no network).
// ---------------------------------------------------------------------------
const FORM4 = (name, title, code, shares, price) => `<?xml version="1.0"?><ownershipDocument>
<issuerName>Example Corp</issuerName><issuerTradingSymbol>EXMP</issuerTradingSymbol>
<reportingOwner><reportingOwnerId><rptOwnerCik>0000000009</rptOwnerCik><rptOwnerName>${name}</rptOwnerName></reportingOwnerId>
<reportingOwnerRelationship><isDirector>0</isDirector><isOfficer>1</isOfficer><officerTitle>${title}</officerTitle></reportingOwnerRelationship></reportingOwner>
<nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle>
<transactionDate><value>2026-08-10</value></transactionDate>
<transactionCoding><transactionCode>${code}</transactionCode></transactionCoding>
<transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare><value>${price}</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
<postTransactionAmounts><sharesOwnedFollowingTransaction><value>12345</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
</nonDerivativeTransaction></ownershipDocument>`;

{
  const filings = [
    { accessionNumber: "0000000000-26-000001", filedDate: "2026-08-12", ownerCik: "0000000009", displayNames: ["A"], url: "https://www.sec.gov/x/1.xml" },
    { accessionNumber: "0000000000-26-000002", filedDate: "2026-08-11", ownerCik: "0000000009", displayNames: ["A"], url: "https://www.sec.gov/x/2.xml" },
    { accessionNumber: "0000000000-26-000003", filedDate: "2026-08-10", ownerCik: "0000000007", displayNames: ["B"], url: "https://www.sec.gov/x/3.xml" },
    { accessionNumber: "0000000000-26-000004", filedDate: "2026-08-09", ownerCik: "0000000005", displayNames: ["C"], url: "https://www.sec.gov/x/4.xml" },
  ];
  const fetched = [];
  const data = await buildInsiderTeaser("EXMP", {
    probeInsiderFilings: async () => ({ cik: "0000000042", name: "Example Corp", startDate: "2026-05-24", endDate: "2026-08-22", total: 17, filings }),
    fetchXmlText: async (url) => { fetched.push(url); return FORM4("Doe Jane", "Chief Financial Officer", "S", "5000", "120.5"); },
  });
  eq(data.kind, "insider", "insider teaser is tagged");
  eq(data.cik, "0000000042", "insider teaser carries the issuer CIK from EDGAR");
  eq(data.filingsInWindow, 17, "insider teaser reports the FULL window count, not just what it read");
  ok(fetched.length <= 4, `insider teaser reads at most 4 filing XMLs (read ${fetched.length})`);
  // Distinct-owner preference: the two same-owner filings must not both take a
  // slot ahead of the other owners.
  eq(fetched[0], "https://www.sec.gov/x/1.xml", "the newest filing is always shown");
  ok(fetched.includes("https://www.sec.gov/x/3.xml") && fetched.includes("https://www.sec.gov/x/4.xml"), "other insiders are preferred over a second filing from the same person");
  eq(data.rows[0].code, "S", "transaction code is parsed");
  eq(data.rows[0].shares, 5000, "share count is parsed");
  eq(data.rows[0].price, 120.5, "price is parsed");
  eq(data.rows[0].role, "Chief Financial Officer", "officer title is used as the role");
  // One Form 4 can carry a dozen VWAP fill lines; one person must not fill the
  // whole teaser table.
  const MANY = `<?xml version="1.0"?><ownershipDocument><issuerName>Example Corp</issuerName><issuerTradingSymbol>EXMP</issuerTradingSymbol>
<reportingOwner><reportingOwnerId><rptOwnerCik>0000000009</rptOwnerCik><rptOwnerName>Busy Person</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>1</isDirector></reportingOwnerRelationship></reportingOwner>
${Array.from({ length: 15 }, (_, i) => `<nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-08-0${(i % 9) + 1}</value></transactionDate><transactionCoding><transactionCode>S</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${100 + i}</value></transactionShares><transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction>`).join("")}</ownershipDocument>`;
  const crowded = await buildInsiderTeaser("EXMP", {
    probeInsiderFilings: async () => ({ cik: "1", name: "X", startDate: "a", endDate: "b", total: 1, filings: [filings[0]] }),
    fetchXmlText: async () => MANY,
  });
  ok(crowded.rows.length <= 5, `one filing contributes at most 5 transaction rows (got ${crowded.rows.length})`);
  // A filing that cannot be read must not sink the page.
  let n = 0;
  const partial = await buildInsiderTeaser("EXMP", {
    probeInsiderFilings: async () => ({ cik: "1", name: "X", startDate: "a", endDate: "b", total: 2, filings: filings.slice(0, 2) }),
    fetchXmlText: async () => { if (n++ === 0) throw new Error("EDGAR 500"); return FORM4("Ok Person", "CEO", "P", "10", "1"); },
  });
  eq(partial.rows.length, 1, "one unreadable filing does not fail the whole teaser");
  eq(partial.partial, false, "a teaser with rows is not marked partial");
  const allDead = await buildInsiderTeaser("EXMP", {
    probeInsiderFilings: async () => ({ cik: "1", name: "X", startDate: "a", endDate: "b", total: 2, filings: filings.slice(0, 2) }),
    fetchXmlText: async () => { throw new Error("EDGAR 403"); },
  });
  eq(allDead.partial, true, "filings that existed but could not be read mark the teaser PARTIAL (short cache)");
}

{
  const INFO = (rows) => `<informationTable>${rows.map((r) => `<infoTable><nameOfIssuer>${r.n}</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>${r.c}</cusip><value>${r.v}</value><shrsOrPrnAmt><sshPrnamt>${r.s}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>`).join("")}</informationTable>`;
  const deps = {
    seededManager: () => ({ slug: "example-capital", name: "Example Capital", cik: "0000000123" }),
    latest13fFiling: async () => ({ cik: "0000000123", managerName: "EXAMPLE CAPITAL MANAGEMENT LLC", accessionNumber: "0000000123-26-000001", filedDate: "2026-08-14", reportDate: "2026-06-30" }),
    findInformationTable: async () => ({ name: "informationtable.xml", size: 40_000, url: "https://www.sec.gov/x/it.xml" }),
    fetchXmlText: async () => INFO([
      { n: "ALPHA CORP", c: "000000001", v: 300, s: 30 },
      { n: "ALPHA CORP", c: "000000001", v: 200, s: 20 },   // same security, second manager row
      { n: "BETA INC", c: "000000002", v: 400, s: 40 },
    ]),
  };
  const d = await buildFundTeaser("example-capital", deps);
  eq(d.name, "Example Capital", "a seeded manager keeps its curated display name, not EDGAR's upper-cased entity name");
  eq(d.reportDate, "2026-06-30", "13F period comes from the filing");
  eq(d.filedDate, "2026-08-14", "13F filed date comes from the filing");
  eq(d.lineItems, 3, "the raw line-item count is preserved");
  eq(d.totalHoldings, 2, "line items are folded by CUSIP into distinct positions");
  eq(d.totalValueUsd, 900, "reported value totals the folded positions");
  eq(d.holdings[0].issuer, "ALPHA CORP", "positions are ranked by folded value");
  eq(d.holdings[0].valueUsd, 500, "the two ALPHA rows are summed, not shown twice");
  ok(Math.abs(d.holdings[0].weight - 500 / 900) < 1e-9, "weight is the folded share of the reported total");
  ok(d.holdings.length <= 5, "at most five holdings are given away free");

  // The size cap is the whole point: the biggest filers publish tables in the
  // tens of megabytes and a free page must be able to decline the read.
  let fetchedBig = false;
  const big = await buildFundTeaser("example-capital", { ...deps, findInformationTable: async () => ({ name: "it.xml", size: 40_000_000, url: "u" }), fetchXmlText: async () => { fetchedBig = true; return ""; } });
  ok(!fetchedBig, "an oversized information table is NEVER fetched");
  eq(big.holdingsAvailable, false, "an oversized table yields no holdings");
  ok(/MB/.test(big.holdingsNote) && big.reportDate === "2026-06-30", "the page still reports the filing itself and says why the table was skipped");

  const noTable = await buildFundTeaser("example-capital", { ...deps, findInformationTable: async () => null });
  eq(noTable.holdingsAvailable, false, "a filing with no information table still renders its identity");
  ok(!noTable.partial && !big.partial, "a structural absence (no table, table too large) is NOT partial - it will not change on a retry");
  const readFail = await buildFundTeaser("example-capital", { ...deps, fetchXmlText: async () => { throw new Error("EDGAR 403"); } });
  eq(readFail.partial, true, "a holdings table we could not READ marks the teaser PARTIAL (short cache)");

  // An off-list slug must NEVER reach EDGAR full-text search: that is one live
  // SEC query per unique slug on an unbounded slug space, pointed at the same
  // egress our paid EDGAR products use. Off-list resolves to nothing and the
  // route 404s; the paid tool still takes any manager by name or CIK.
  let resolveCalls = 0;
  const offList = await buildFundTeaser("some-other-fund", { ...deps, seededManager: () => null, resolveManager: async () => { resolveCalls++; return { cik: "1", name: "x" }; } });
  eq(offList, null, "an off-list fund slug builds nothing");
  eq(resolveCalls, 0, "an off-list fund slug never calls the EDGAR resolver (no full-text-search amplifier)");
}

{
  const SUB = {
    name: "Example Corp", sic: "3571", sicDescription: "Electronic Computers",
    stateOfIncorporation: "DE", exchanges: ["Nasdaq"], tickers: ["EXMP"], fiscalYearEnd: "0930",
    addresses: { business: { stateOrCountry: "CA" } },
    filings: { recent: {
      form: ["4", "8-K", "10-Q", "4", "10-K"],
      filingDate: ["2026-08-20", "2026-07-30", "2026-07-31", "2026-07-01", "2025-10-31"],
      reportDate: ["2026-08-18", "2026-07-30", "2026-06-27", "2026-06-29", "2025-09-27"],
      accessionNumber: ["a1", "a2", "a3", "a4", "a5"],
    } },
  };
  let asked = 0, conceptReads = 0;
  const notFound = () => Object.assign(new Error("EDGAR returned 404"), { statusCode: 422, upstreamStatus: 404 });
  const d = await buildDossierTeaser("EXMP", {
    resolveCompany: async () => ({ cik: "0000000042", name: "Example Corp" }),
    edgarGetJson: async (url) => {
      asked++; ok(url.includes("0000000042"), "every dossier read is for the resolved CIK");
      if (url.includes("/companyconcept/")) { conceptReads++; throw notFound(); }
      return SUB;
    },
  });
  eq(asked - conceptReads, 1, "the dossier teaser reads the submissions index exactly once");
  ok(conceptReads <= 6, `XBRL concept reads are bounded (${conceptReads} <= 6: four revenue tags, net income, assets)`);
  ok(d.financials.rows.length === 0 && d.partial === false, "a company with no XBRL concepts (404s) gets no financials and is NOT marked partial");
  eq(d.cik, "0000000042", "dossier carries the CIK");
  eq(d.industry, "Electronic Computers", "dossier carries the SIC description");
  eq(d.latest10K.filingDate, "2025-10-31", "dossier finds the latest 10-K");
  eq(d.latest10Q.filingDate, "2026-07-31", "dossier finds the latest 10-Q");
  eq(d.latest8K.filingDate, "2026-07-30", "dossier finds the latest 8-K");
  eq(d.form4Count, 2, "dossier counts the Form 4 filings in the recent index");
  eq(d.filingsIndexed, 5, "dossier reports how many filings the index carries");
}

// ---------------------------------------------------------------------------
// 5. Page builders: SEO shape, escaping, prices, uniqueness.
// ---------------------------------------------------------------------------
const titleOf = (html) => (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
const descOf = (html) => (html.match(/<meta name="description" content="([\s\S]*?)">/) || [])[1] || "";
const canonOf = (html) => (html.match(/<link rel="canonical" href="([^"]*)">/) || [])[1] || "";
const robotsOf = (html) => (html.match(/<meta name="robots" content="([^"]*)">/) || [])[1] || "";
const h1Of = (html) => (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || "";
const ldOf = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);

const insiderData = {
  kind: "insider", ticker: "EXMP", name: "Example Corp", cik: "0000000042",
  startDate: "2026-05-24", endDate: "2026-08-22", windowDays: 90, filingsInWindow: 17, filingsRead: 3,
  latestFiledDate: "2026-08-12",
  rows: [{ insider: "Doe Jane", role: "Chief Financial Officer", date: "2026-08-10", filedDate: "2026-08-12", code: "S", kind: "open-market sale", shares: 5000, price: 120.5, ownedAfter: 12345, url: "https://www.sec.gov/x/1.xml" }],
};
const fundData = {
  kind: "fund", slug: "example-capital", name: "Example Capital", cik: "0000000123",
  reportDate: "2026-06-30", filedDate: "2026-08-14", accession: "0000000123-26-000001",
  filingUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000000123",
  holdingsAvailable: true, lineItems: 3, totalHoldings: 2, totalValueUsd: 900, holdingsNote: "",
  holdings: [{ issuer: "ALPHA CORP", titleOfClass: "COM", cusip: "000000001", valueUsd: 500, shares: 50, weight: 0.5556 }],
};
const dossierData = {
  kind: "dossier", ticker: "EXMP", cik: "0000000042", name: "Example Corp", sic: "3571",
  industry: "Electronic Computers", state: "CA", stateOfIncorporation: "DE", exchanges: ["Nasdaq"],
  tickers: ["EXMP"], fiscalYearEnd: "0930", entityType: "operating",
  latest10K: { form: "10-K", filingDate: "2025-10-31", reportDate: "2025-09-27", accession: "a5" },
  latest10Q: { form: "10-Q", filingDate: "2026-07-31", reportDate: "2026-06-27", accession: "a3" },
  latest8K: null, form4Count: 2, filingsIndexed: 5,
};

const pages = {
  insider: insiderPage({ ticker: "EXMP", data: insiderData, baseUrl: BASE }),
  fund: fundPage({ slug: "example-capital", data: fundData, baseUrl: BASE }),
  dossier: dossierPage({ ticker: "EXMP", data: dossierData, baseUrl: BASE }),
  hubInsider: hubPage({ kind: "insider", baseUrl: BASE }),
  hubFund: hubPage({ kind: "fund", baseUrl: BASE }),
  hubDossier: hubPage({ kind: "dossier", baseUrl: BASE }),
};

const titles = new Set(), descs = new Set(), canons = new Set();
for (const [name, html] of Object.entries(pages)) {
  const t = titleOf(html), d = descOf(html), c = canonOf(html);
  ok(t.length > 20 && t.length < 120, `${name}: title is a real, length-sane title (${t.length} chars)`);
  ok(d.length > 60 && d.length < 320, `${name}: meta description is a real, length-sane description (${d.length} chars)`);
  ok(c.startsWith(BASE + "/reports/"), `${name}: canonical points at this page under /reports (${c})`);
  ok(!/noindex/.test(robotsOf(html)), `${name}: page is indexable (robots "${robotsOf(html)}")`);
  ok(h1Of(html).length > 0, `${name}: has an h1`);
  ok((html.match(/<h1[\s>]/g) || []).length === 1, `${name}: exactly one h1`);
  ok((html.match(/<main[\s>]/g) || []).length === 1, `${name}: exactly one main landmark`);
  ok(!/—/.test(html), `${name}: no em dashes in the copy`);
  // Case-insensitive and attribute-tolerant: an inline block can be <SCRIPT>,
  // <script >, or <script type="...">, and a bare /<script>/ misses all three.
  // What must never appear is EXECUTABLE inline script: no src, and not one of
  // the data types a browser never runs (ld+json carries our structured data).
  const inlineExec = [...html.matchAll(/<script\b([^>]*)>/gi)]
    .map((m) => m[1])
    .filter((attrs) => !/\bsrc\s*=/i.test(attrs) && !/type\s*=\s*["']application\/(ld\+)?json["']/i.test(attrs));
  ok(inlineExec.length === 0, `${name}: no inline executable script (site CSP drops it)${inlineExec.length ? ` - found ${inlineExec.length}` : ""}`);
  ok(html.includes('<script src="/js/report-buy.js">') || name.startsWith("hub"), `${name}: the buy button ships as an external script`);
  titles.add(t); descs.add(d); canons.add(c);
  for (const raw of ldOf(html)) {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* reported below */ }
    ok(parsed !== null, `${name}: every JSON-LD block parses`);
  }
}
eq(titles.size, Object.keys(pages).length, "every page has a UNIQUE title");
eq(descs.size, Object.keys(pages).length, "every page has a UNIQUE meta description");
eq(canons.size, Object.keys(pages).length, "every page has a UNIQUE canonical");

// Titles carry the search intent the page is built for.
ok(/EXMP insider buying and selling/.test(titleOf(pages.insider)), "insider title carries '<TICKER> insider buying and selling'");
ok(/Example Capital 13F holdings/.test(titleOf(pages.fund)), "fund title carries '<MANAGER> 13F holdings'");
ok(/EXMP due diligence/.test(titleOf(pages.dossier)), "dossier title carries '<TICKER> due diligence'");
ok(h1Of(pages.insider).includes("Example Corp"), "insider h1 names the entity, not the slug");
ok(h1Of(pages.fund).includes("Example Capital"), "fund h1 names the manager");

// Required structured data.
for (const [name, want] of [["insider", "Dataset"], ["fund", "Dataset"], ["dossier", "Dataset"]]) {
  const types = ldOf(pages[name]).map((r) => JSON.parse(r)["@type"]);
  ok(types.includes(want), `${name}: carries a ${want} JSON-LD block`);
  ok(types.includes("BreadcrumbList"), `${name}: carries a BreadcrumbList`);
  ok(types.includes("Product"), `${name}: carries the paid report's Product offer`);
}
for (const name of ["hubInsider", "hubFund", "hubDossier"]) {
  const types = ldOf(pages[name]).map((r) => JSON.parse(r)["@type"]);
  ok(types.includes("ItemList") && types.includes("BreadcrumbList"), `${name}: hub carries an ItemList and a BreadcrumbList`);
}
{
  const crumbs = ldOf(pages.insider).map((r) => JSON.parse(r)).find((j) => j["@type"] === "BreadcrumbList");
  eq(crumbs.itemListElement.length, 3, "insider breadcrumb is Reports > Insider filings > entity");
  eq(crumbs.itemListElement[2].item, `${BASE}/reports/insider/EXMP`, "the last breadcrumb is this page");
  const product = ldOf(pages.insider).map((r) => JSON.parse(r)).find((j) => j["@type"] === "Product");
  eq(product.offers.price, (HUMAN_PRODUCTS["insider-report"].price / 100).toFixed(2), "the Product offer price comes from HUMAN_PRODUCTS");
  eq(product.offers.seller.name, "Havok Holdings LLC", "the seller is the operating entity");
}

// Prices: read from the product tables, never typed into the page.
for (const [name, key] of [["insider", "insider-report"], ["fund", "fund-report"], ["dossier", "dossier"]]) {
  const want = `$${(HUMAN_PRODUCTS[key].price / 100).toFixed(0)}`;
  ok(pages[name].includes(`Get the full report, ${want}`), `${name}: card CTA shows ${want}, straight from HUMAN_PRODUCTS`);
  ok(pages[name].includes(`data-buy-product="${key}"`), `${name}: the buy button posts the right product`);
  ok(pages[name].includes(FAMILIES[name].route), `${name}: the agent line names the paid route (${FAMILIES[name].route})`);
  ok(pages[name].includes(`over x402 or MPP, ${FAMILIES[name].agentPrice()}`), `${name}: the agent line prices from the catalog tier table`);
}
ok(pages.insider.includes('data-buy-input="EXMP"'), "insider buy button prefills the ticker");
ok(pages.fund.includes('data-buy-input="Example Capital"'), "fund buy button prefills the manager");

// Internal linking between the three families for the same entity, plus /reports.
ok(pages.insider.includes('href="/reports/dossier/EXMP"'), "insider page links to the same company's dossier page");
ok(pages.dossier.includes('href="/reports/insider/EXMP"'), "dossier page links to the same company's insider page");
for (const n of ["insider", "fund", "dossier"]) {
  ok(pages[n].includes('href="/reports"'), `${n}: links back to /reports`);
  ok(pages[n].includes(`href="/reports/${n}"`), `${n}: links back to its own hub`);
}
ok(pages.hubInsider.includes('href="/reports/insider/AAPL"'), "the insider hub links every seeded ticker");
ok(pages.hubFund.includes('href="/reports/fund/berkshire-hathaway"'), "the fund hub links every seeded manager");

// Provenance and the disclaimer are on every page.
for (const [n, html] of Object.entries(pages)) {
  ok(/SEC EDGAR/.test(html), `${n}: says plainly where the data comes from`);
  ok(/not investment advice/.test(html), `${n}: carries the not-investment-advice line`);
}
ok(descOf(pages.fund).includes("2026-06-30") || pages.fund.includes("2026-06-30"), "the fund page shows the data's own period date");
ok(pages.insider.includes("2026-08-12"), "the insider page shows the newest filing's own date");

// ESCAPING: a filer name is third-party XML shown as filed. It must be escaped.
{
  const hostile = '<script>alert("xss")</script> & "quoted"';
  const html = insiderPage({ ticker: "EXMP", data: { ...insiderData, name: hostile, rows: [{ ...insiderData.rows[0], insider: hostile, role: hostile }] }, baseUrl: BASE });
  ok(!html.includes('<script>alert'), "a hostile filer name never reaches the page as markup");
  ok(html.includes("&lt;script&gt;alert"), "the hostile name is HTML-escaped and still shown as filed");
  ok(!/content="[^"]*<script/.test(html), "the hostile name cannot break out of the meta description attribute");
  const lds = ldOf(html);
  ok(lds.length > 0 && lds.every((r) => { try { JSON.parse(r); return true; } catch { return false; } }), "JSON-LD still parses with a hostile name in it");
  ok(!lds.some((r) => r.includes("</script>")), "JSON-LD never carries a raw closing script tag");
}

// A page with NO data still renders (EDGAR unreadable on a known entity).
for (const [n, html] of Object.entries({
  insider: insiderPage({ ticker: "AAPL", data: null, baseUrl: BASE, degraded: true }),
  fund: fundPage({ slug: "berkshire-hathaway", data: null, baseUrl: BASE, degraded: true }),
  dossier: dossierPage({ ticker: "AAPL", data: null, baseUrl: BASE, degraded: true }),
})) {
  ok(titleOf(html).length > 20 && h1Of(html).length > 0, `${n}: degraded page still has a title and an h1`);
  ok(/could not be read/.test(html), `${n}: degraded page says plainly that EDGAR could not be read`);
  ok(html.includes("data-buy-product"), `${n}: degraded page still offers the paid report`);
  ok(ldOf(html).every((r) => { try { JSON.parse(r); return true; } catch { return false; } }), `${n}: degraded page JSON-LD parses`);
}

// ---------------------------------------------------------------------------
// 6. Seeds and the sitemap.
// ---------------------------------------------------------------------------
ok(SEED_TICKERS.length >= 60 && SEED_TICKERS.length <= 120, `ticker seed list is a curated size (${SEED_TICKERS.length})`);
ok(SEED_MANAGERS.length >= 30 && SEED_MANAGERS.length <= 60, `manager seed list is a curated size (${SEED_MANAGERS.length})`);
eq(new Set(SEED_TICKERS).size, SEED_TICKERS.length, "no duplicate seeded tickers");
eq(new Set(SEED_MANAGERS.map((m) => m.slug)).size, SEED_MANAGERS.length, "no duplicate seeded manager slugs");
ok(SEED_TICKERS.every((t) => normalizeTicker(t) === t), "every seeded ticker passes the route's own validation unchanged");
ok(SEED_MANAGERS.every((m) => normalizeManagerSlug(m.slug) === m.slug), "every seeded manager slug passes the route's own validation unchanged");
ok(SEED_MANAGERS.every((m) => /^\d{10}$/.test(m.cik)), "every seeded manager carries a 10-digit zero-padded CIK");
ok(SEED_MANAGERS.every((m) => m.name && m.name.length > 2), "every seeded manager carries a display name");
ok(isSeededTicker("aapl") && isSeededTicker("AAPL"), "seeded-ticker lookup is case-insensitive");
ok(!isSeededTicker("ZZZZZZ"), "an unseeded ticker is reported as unseeded");
ok(seededManager("berkshire-hathaway")?.cik === "0001067983", "seeded manager lookup returns the CIK");
ok(seededManager("nope") === null, "an unseeded manager slug returns null");

{
  const paths = seededProgrammaticPaths();
  eq(paths.length, 3 + SEED_TICKERS.length * 2 + SEED_MANAGERS.length, "the advertised path set is exactly the hubs plus one page per seeded entity");
  eq(new Set(paths).size, paths.length, "no duplicate advertised paths");
  const sm = sitemapReports(BASE);
  for (const p of paths) ok(sm.includes(`<loc>${BASE}${p}</loc>`), `sitemap-reports.xml advertises ${p}`);
  const full = sitemapXml(BASE, {});
  ok(paths.every((p) => full.includes(`<loc>${BASE}${p}</loc>`)), "sitemap.xml carries every advertised programmatic URL too");
  ok(sitemapIndex(BASE).includes("sitemap-reports.xml"), "the sitemap index points at the reports sub-sitemap");
  ok(!/<loc>[^<]*\/reports\/(insider|dossier)\/[A-Z.\-]{1,6}<\/loc>[\s\S]*<priority>1\.0/.test(sm), "entity pages never claim top priority");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
