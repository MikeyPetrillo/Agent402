// scripts/test-ticker-pack-kit.js
// Offline tests for src/tools/ticker-pack-kit.js (the $15 TICKER PACK bundle).
// No network: every leg is injected through the handler's `deps` seam, so the
// two part composites (dossier, insider flow), the three EDGAR probes and the
// ONE pack synthesis call are all stubs, and a test can assert something was
// NEVER called - which is the whole point of the thin-evidence cases.
//
// Covers:
//   - catalog envelope (route, slug, price $15, schema, example, tags)
//   - the upstream ARITHMETIC: the tier's cap is derived from the parts' caps
//     and stays <= $5.50 (<= 37% of the $15 price)
//   - input validation: a bad/absent ticker 400s with ZERO work done
//   - an unresolvable ticker 404s before any part runs
//   - the thin-evidence refusal (fewer than 2 of the 3 legs have data): 422,
//     and NEITHER part handler NOR the synthesis is ever called
//   - the post-run refusal (2 of 3 content legs failed): 502, not charged
//   - the merged shape: one report with every section, sources merged AND
//     deduped, sub-report citations renumbered into the merged list, tables
//     namespaced per part, per-leg `evidence`, the disclaimer
//   - a failed leg is NAMED as failed and never zeroed (no 0s stand in for
//     missing numbers, and its table is absent)
//   - upstream failure mapping: a synthesis upstream error degrades to the
//     deterministic summary instead of selling nothing, and NO upstream body
//     is relayed to the buyer anywhere
//   - the synthesis prompt carries ONLY fetched facts (every number traces to
//     a stubbed fetch; the kit's own documentation-example numbers never leak)
//   - the pure stitching helpers and the holders primitives (name
//     normalization, URL construction refuses traversal, streaming scan)

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-key-not-real";
process.env.RESEARCH_DEBUG = "1"; // exposes the synthesis prompt for the grounding assertion

const mod = await import("../src/tools/ticker-pack-kit.js");
const {
  TICKER_PACK_TOOLS, TICKER_PACK_TIERS, TICKER_PACK_MODELS, makeTickerPackHandler,
  normIssuerName, infoTableUrl, scanInfoTableForIssuer,
  stripSourcesSection, demoteHeadings, mergeSources, remapCitations, foldSubReport, buyerReason, summarizeIssuerRows, __test,
} = mod;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)})`);
async function throws(fn, wantStatus, m) {
  try { await fn(); ok(false, `${m} (did not throw)`); return null; }
  catch (e) { ok(e?.statusCode === wantStatus, `${m} -> ${wantStatus} (got ${e?.statusCode}: ${String(e?.message).slice(0, 120)})`); return e; }
}

// ---------------------------------------------------------------------------
// 1. Catalog envelope
// ---------------------------------------------------------------------------
const def = TICKER_PACK_TOOLS[0];
eq(TICKER_PACK_TOOLS.length, 1, "the kit exports exactly one tool");
eq(def.route, "POST /v1/ticker-pack", "route is POST /v1/ticker-pack");
eq(def.slug, "ticker-pack", "slug is ticker-pack");
eq(def.price, TICKER_PACK_TIERS["ticker-pack"].price, "the tool price is the tier price (one source of truth)");
eq(def.price, TICKER_PACK_TIERS["ticker-pack"].price, "the catalog price comes from the tier table");
ok(typeof def.handler === "function", "the tool has a handler");
ok(def.discovery?.inputSchema?.required?.includes("ticker"), "the schema requires a ticker");
ok(def.discovery?.input?.ticker === "AAPL", "the documented example uses a real ticker");
ok(def.discovery?.output?.example?.report?.startsWith("# Ticker Pack:"), "the output example is a ticker pack report");
ok(/not investment advice/i.test(def.discovery.output.example.meta.disclaimer || __test.DISCLAIMER), "the not-investment-advice line is part of the product");
ok(def.tags.includes("13f") && def.tags.includes("insider") && def.tags.includes("bundle"), "tags name the bundle's three legs");
ok(TICKER_PACK_MODELS.includes("anthropic/claude-opus-5"), "the synthesis model id is exported for the live-catalog guard");

// ---------------------------------------------------------------------------
// 2. Upstream arithmetic vs price
// ---------------------------------------------------------------------------
const T = TICKER_PACK_TIERS["ticker-pack"];
const { DOSSIER_TIERS } = await import("../src/tools/dossier-kit.js");
const { INSIDER_TIERS } = await import("../src/tools/insider-flow-kit.js");
const partSum = DOSSIER_TIERS["dossier"].maxUpstreamUsd + INSIDER_TIERS["insider-report"].maxUpstreamUsd + __test.PACK_SYNTH_MAX_UPSTREAM_USD;
ok(Math.abs(T.maxUpstreamUsd - partSum) < 1e-9, `the tier cap is DERIVED from the parts' caps, not hand-typed (${T.maxUpstreamUsd} = ${DOSSIER_TIERS["dossier"].maxUpstreamUsd} + ${INSIDER_TIERS["insider-report"].maxUpstreamUsd} + ${__test.PACK_SYNTH_MAX_UPSTREAM_USD})`);
ok(T.maxUpstreamUsd <= 5.5, `worst-case upstream ${T.maxUpstreamUsd} is within the $5.50 bound`);
ok(T.maxUpstreamUsd / 15 <= 0.37, `worst-case upstream is ${(T.maxUpstreamUsd / 15 * 100).toFixed(1)}% of the $15 price (<= 37%)`);
eq(T.partCaps.holders, 0, "the holders leg costs no upstream money (SEC EDGAR only)");
eq(T.partCaps.filings, 0, "the filings digest costs no upstream money (SEC EDGAR only)");
ok(T.insiderDays === 90, "the insider leg runs a 90-day window by default");

// ---------------------------------------------------------------------------
// 3. Pure helpers
// ---------------------------------------------------------------------------
eq(normIssuerName("Apple Inc."), "APPLE", "issuer normalization drops corporate suffixes");
eq(normIssuerName("APPLE INC"), "APPLE", "a manager's free-text issuer name normalizes to the same key");
ok(normIssuerName("Apple Hospitality REIT, Inc.") !== normIssuerName("Apple Inc."), "a different issuer does NOT normalize to the same key");
ok(infoTableUrl("320193", "0001193125-26-352200", "56757.xml") === "https://www.sec.gov/Archives/edgar/data/320193/000119312526352200/56757.xml", "info-table URLs are assembled from the accession and attachment name");
eq(infoTableUrl("320193", "0001193125-26-352200", "../../../etc/passwd.xml"), null, "a traversal attempt in the attachment name yields no URL");
eq(infoTableUrl("320193", "not-an-accession", "a.xml"), null, "a malformed accession yields no URL");
eq(infoTableUrl("320193", "0001193125-26-352200", "a/b.xml"), null, "a slash in the attachment name yields no URL");

eq(stripSourcesSection("body\n\n## Sources\n[1] x - http://a"), "body", "a sub-report's own Sources block is stripped before merging");
eq(demoteHeadings("# Title\n## Sub", 2), "### Title\n#### Sub", "sub-report headings are demoted so they nest");
const ms = mergeSources([
  { sources: [{ n: 1, title: "A", url: "http://a" }, { n: 2, title: "B", url: "http://b" }] },
  { sources: [{ n: 1, title: "B again", url: "http://b" }, { n: 2, title: "C", url: "http://c" }] },
]);
eq(ms.merged.length, 3, "merged sources dedupe by URL");
eq(ms.maps[1].get(1), 2, "the second part's [1] remaps onto the shared URL's global number");
eq(ms.maps[1].get(2), 3, "the second part's [2] remaps to a new global number");
eq(remapCitations("see [1] and [2]", ms.maps[1]), "see [2] and [3]", "citations are renumbered into the merged list");
eq(remapCitations("stale [9]", ms.maps[1]), "stale ", "an unmappable citation is REMOVED, never left pointing at another source");
eq(remapCitations("[link](http://x)", ms.maps[0]), "[link](http://x)", "markdown links are not mistaken for citations");
eq(foldSubReport("# T\ncite [2]\n\n## Sources\n[1] a - http://a", ms.maps[0]), "### T\ncite [2]", "fold = strip sources, renumber, demote");
eq(buyerReason(new Error("Upstream error (HTTP 502) <html>provider trace</html>")), "Upstream error (HTTP 502)", "our own words survive; everything from the first markup tag on is dropped");
eq(buyerReason(new Error("<html><body>secret</body></html>")), "upstream error (details withheld)", "a reason that is ONLY an upstream body is withheld entirely");

// per-manager fold: shares vs principal vs options (found live on a real 13F -
// the issuer's bonds carry the same CUSIP prefix, and one 2026 filer still
// reported values in thousands)
{
  const sum = summarizeIssuerRows([
    { cusip: "037833100", titleOfClass: "COM", shares: 100, valueUsd: 28900, sharesOrPrincipalAmountType: "SH" },
    { cusip: "037833100", titleOfClass: "COM", shares: 50, valueUsd: 14450, sharesOrPrincipalAmountType: "SH" },
    { cusip: "037833BX8", titleOfClass: "NOTE", shares: 5000000, valueUsd: 4800000, sharesOrPrincipalAmountType: "PRN" },
    { cusip: "037833100", titleOfClass: "COM", shares: 900, valueUsd: 1000, sharesOrPrincipalAmountType: "SH", putCall: "Call" },
  ]);
  eq(sum.shares, 150, "a PRN principal amount is NEVER summed into a share count");
  eq(sum.principalRows, 1, "principal rows are counted and reported separately");
  eq(sum.optionRows, 1, "option rows are separated from the share position");
  eq(sum.optionShares, 900, "option share counts are kept on their own");
  eq(sum.impliedPriceUsd, 289, "the implied price per share is derived from the share rows only");
  eq(summarizeIssuerRows([{ cusip: "x", shares: 0, valueUsd: 0, sharesOrPrincipalAmountType: "SH" }]).impliedPriceUsd, null, "no implied price is invented when there are no shares");
}

// streaming scan of an information table
const XML = `<?xml version="1.0"?><informationTable>
<infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>037833100</cusip><value>65950296923</value><shrsOrPrnAmt><sshPrnamt>227917808</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt><investmentDiscretion>DFND</investmentDiscretion></infoTable>
<infoTable><nameOfIssuer>MICROSOFT CORP</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>594918104</cusip><value>1000</value><shrsOrPrnAmt><sshPrnamt>10</sshPrnamt></shrsOrPrnAmt></infoTable>
<infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><titleOfClass>NOTE</titleOfClass><cusip>037833BX8</cusip><value>500</value><shrsOrPrnAmt><sshPrnamt>5</sshPrnamt></shrsOrPrnAmt><putCall>Call</putCall></infoTable>
</informationTable>`;
const chunkedRes = (text, chunkSize = 64) => {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i >= bytes.length ? { done: true } : { done: false, value: bytes.slice(i, (i += chunkSize)) }), cancel: async () => {} }) } };
};
{
  const state = { want: normIssuerName("Apple Inc."), cusip6: null };
  const r = await scanInfoTableForIssuer("http://stub", state, { fetchImpl: async () => chunkedRes(XML), reportDate: "2026-08-14" });
  eq(r.totalRows, 3, "the streaming scan counts every position in the table");
  eq(r.rows.length, 2, "the scan keeps only this issuer's rows (both share classes), across chunk boundaries");
  eq(r.rows[0].cusip, "037833100", "the CUSIP is read from the filing, never assumed");
  eq(state.cusip6, "037833", "the issuer's CUSIP prefix is learned from a name match and reused");
  eq(r.rows[1].putCall, "Call", "an option row is kept and flagged, not silently summed into share counts");
}
{
  const state = { want: "NO SUCH ISSUER", cusip6: null };
  const r = await scanInfoTableForIssuer("http://stub", state, { fetchImpl: async () => chunkedRes(XML), reportDate: "2026-08-14" });
  eq(r.rows.length, 0, "a table that does not name the issuer contributes nothing");
  eq(r.totalRows, 3, "and its position count is still reported honestly");
}
{
  const state = { want: normIssuerName("Apple Inc."), cusip6: null };
  const r = await scanInfoTableForIssuer("http://stub", state, { fetchImpl: async () => chunkedRes(XML, 32), maxBytes: 100, reportDate: "2026-08-14" });
  ok(r.truncated === true, "a table past the byte bound stops streaming and says it was truncated");
}

// ---------------------------------------------------------------------------
// 4. Stub fixtures for the handler. Every number here is deliberately
//    distinctive so the prompt-grounding assertion can trace what appears.
// ---------------------------------------------------------------------------
const CIK = "0000320193";
const FILINGS = {
  cik: CIK, name: "Apple Inc.", sic: "Electronic Computers", exchanges: ["Nasdaq"], tickers: ["AAPL"],
  stateOfIncorporation: "CA", fiscalYearEnd: "0927",
  filings: [
    { form: "10-Q", filed: "2026-08-01", period: "2026-06-27", description: "Quarterly report", accession: "0000320193-26-000077", url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000077/aapl-20260627.htm" },
    { form: "8-K", filed: "2026-07-31", period: "2026-07-31", description: "Current report", accession: "0000320193-26-000075", url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000075/aapl-20260731.htm" },
  ],
  browseUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${CIK}`,
};
const INSIDER_PROBE = { cik: CIK, name: "Apple Inc.", days: 90, total: 11, filings: [{ accessionNumber: "0000320193-26-000090", filedDate: "2026-08-05", url: "https://www.sec.gov/Archives/edgar/data/1/000032019326000090/form4.xml" }], ids: ["0000320193-26-000090"], fingerprint: "x" };
const HOLDERS = {
  query: '"Apple Inc."', startDate: "2026-03-25", endDate: "2026-08-22",
  matchingFilings: 10000, matchingRelation: "gte", cusipPrefix: "037833",
  candidates: 12, scanned: 12, failedScans: 1,
  managers: [
    { manager: "BERKSHIRE HATHAWAY INC", cik: "0001067983", period: "2026-06-30", filed: "2026-08-14", url: "https://www.sec.gov/Archives/edgar/data/1067983/000119312526352200/56757.xml", shares: 227917808, valueUsd: 65950296923, impliedPriceUsd: 289.36, optionRows: 0, optionShares: 0, principalRows: 0, rows: 12, classes: ["COM"], totalPositions: 89, truncated: false },
    { manager: "ZEGA Investments, LLC", cik: "0002045703", period: "2026-06-30", filed: "2026-08-11", url: "https://www.sec.gov/Archives/edgar/data/2045703/000204570326000001/informationtable06302026.xml", shares: 444198, valueUsd: 128533232, impliedPriceUsd: 289.36, optionRows: 3, optionShares: 1200, principalRows: 1, rows: 22, classes: ["COM"], totalPositions: 730, truncated: false },
  ],
  failures: [{ manager: "BNP PARIBAS FINANCIAL MARKETS", cik: "0001166588", error: "EDGAR XML HTTP 503" }],
  searchUrl: "https://efts.sec.gov/LATEST/search-index?q=%22Apple%20Inc.%22&forms=13F-HR",
};
const DOSSIER_OUT = {
  dossier: "# Due-Diligence Dossier: Apple Inc. (AAPL)\n\n## Snapshot\nThe issuer filed a 10-Q [1] and an 8-K [2].\n\n## Sources\n[1] 10-Q filed 2026-08-01 - SEC EDGAR - https://www.sec.gov/dossier-1\n[2] 8-K filed 2026-07-31 - SEC EDGAR - https://www.sec.gov/dossier-2",
  company: "Apple Inc.", ticker: "AAPL",
  sources: [{ n: 1, title: "10-Q filed 2026-08-01 - SEC EDGAR", url: "https://www.sec.gov/dossier-1" }, { n: 2, title: "8-K filed 2026-07-31 - SEC EDGAR", url: "https://www.sec.gov/dossier-2" }],
  tables: [{ name: "financials", label: "SEC XBRL financials", columns: ["Metric"], rows: [["Total revenue"]] }],
  meta: { tier: "dossier", filings_10k: 1, filings_10q: 3, filings_8k: 6, insider_filings: 8, web_angles: 4, sources_cited: 20, synthesis_model: "anthropic/claude-opus-5" },
};
const INSIDER_OUT = {
  report: "# Insider Flow Report: Apple Inc. (AAPL)\n\n## Snapshot\nOne Form 4 [1] and the search [2].\n\n## Sources\n[1] Form 4 filed 2026-08-05 - SEC EDGAR - https://www.sec.gov/insider-1\n[2] SEC EDGAR full-text search - https://www.sec.gov/dossier-1",
  company: "Apple Inc.", ticker: "AAPL", cik: CIK,
  sources: [{ n: 1, title: "Form 4 filed 2026-08-05 - SEC EDGAR", url: "https://www.sec.gov/insider-1" }, { n: 2, title: "SEC EDGAR full-text search", url: "https://www.sec.gov/dossier-1" }],
  tables: [{ name: "transactions", label: "Form 4 transactions", columns: ["Date"], rows: [["2026-08-04"]] }],
  meta: { tier: "insider-report", window_days: 90, start: "2026-05-24", end: "2026-08-22", filings_in_window: 11, filings_read: 11, transactions: 18, open_market_buys: 1, buy_usd: 240000, distinct_buyers: 1, open_market_sells: 3, sell_usd: 1850000, distinct_sellers: 2, net_open_market_usd: -1610000, awards: 4, option_exercises: 2, tax_withholding: 5, sources_cited: 7, synthesis_model: "anthropic/claude-opus-5" },
};
const SYNTH_OUT = { choices: [{ message: { content: "Apple Inc. is an electronic computers issuer.\n===NEXT===\n- Read the 10-Q filed 2026-08-01." } }], usage: { cost: 0.041 } };

function stubs(over = {}) {
  const calls = { resolve: 0, filings: 0, insiderProbe: 0, holders: 0, dossier: 0, insider: 0, synth: 0 };
  const prompts = [];
  const deps = {
    resolveCompany: async () => { calls.resolve++; return { cik: CIK, name: "Apple Inc." }; },
    probeCompanyFilings: async () => { calls.filings++; return FILINGS; },
    probeInsiderFilings: async () => { calls.insiderProbe++; return INSIDER_PROBE; },
    probeHolders: async () => { calls.holders++; return HOLDERS; },
    probe13G: async () => ({ cik: CIK, startDate: "2025-07-22", endDate: "2026-08-26", matching: 2, searchUrl: "https://efts.sec.gov/LATEST/search-index?q=&forms=SCHEDULE%2013G&ciks=" + CIK, filers: [
      { filerCik: "0000102909", filer: "The Vanguard Group", form: "SCHEDULE 13G/A", filed: "2026-02-10", accession: "0000102909-26-000001", url: "https://www.sec.gov/Archives/edgar/data/102909/000010290926000001/primary_doc.xml", parsed: true, shares: 1_390_000_000, percent: 9.21, eventDate: "12/31/2025", securityClass: "Common Stock", personType: "IA", belowThreshold: false },
      { filerCik: "0001364742", filer: "BlackRock, Inc.", form: "SCHEDULE 13G/A", filed: "2026-01-26", accession: "0001364742-26-000002", url: "https://www.sec.gov/Archives/edgar/data/1364742/000136474226000002/primary_doc.xml", parsed: true, shares: 0, percent: 0, eventDate: "12/31/2025", securityClass: "Common Stock", personType: "HC", belowThreshold: true },
    ] }),
    runDossier: async () => { calls.dossier++; return DOSSIER_OUT; },
    runInsider: async () => { calls.insider++; return INSIDER_OUT; },
    synthesize: async (body) => { calls.synth++; prompts.push(body.messages[0].content); return SYNTH_OUT; },
    now: () => 1_755_000_000_000,
    ...over,
  };
  return { calls, prompts, handler: makeTickerPackHandler("ticker-pack", deps) };
}

// ---------------------------------------------------------------------------
// 5. Validation: 400 with ZERO work
// ---------------------------------------------------------------------------
{
  const s = stubs();
  await throws(() => s.handler(null), 400, "a non-object body 400s");
  await throws(() => s.handler({}), 400, "a missing ticker 400s");
  await throws(() => s.handler({ ticker: "not a ticker!!" }), 400, "a malformed ticker 400s");
  eq(s.calls.resolve + s.calls.filings + s.calls.holders + s.calls.dossier + s.calls.insider + s.calls.synth, 0, "validation does ZERO work: no probe, no part, no synthesis");
}
{
  const s = stubs({ resolveCompany: async () => { const e = new Error("Unknown ticker: ZZZZ"); e.statusCode = 404; throw e; } });
  await throws(() => s.handler({ ticker: "ZZZZ" }), 404, "an unresolvable ticker 404s");
  eq(s.calls.dossier + s.calls.insider + s.calls.synth, 0, "an unresolvable ticker never reaches a paid leg");
}

// ---------------------------------------------------------------------------
// 6. Thin-evidence refusal: fewer than 2 of the 3 legs have data
// ---------------------------------------------------------------------------
{
  const s = stubs({
    probeInsiderFilings: async () => ({ ...INSIDER_PROBE, filings: [] }),
    probeHolders: async () => ({ ...HOLDERS, managers: [] }),
  });
  const e = await throws(() => s.handler({ ticker: "AAPL" }), 422, "only one leg with data refuses the sale");
  ok(/at least two of the three legs/i.test(e.message), "the refusal explains the two-of-three rule");
  ok(/Not charged/i.test(e.message), "the refusal says the buyer is not charged");
  eq(s.calls.synth, 0, "the thin-evidence refusal NEVER calls the synthesis");
  eq(s.calls.dossier + s.calls.insider, 0, "the thin-evidence refusal never runs a paid part handler");
}
{
  const s = stubs({ probeHolders: async () => { throw new Error("<html>EDGAR is down</html>"); } });
  const out = await s.handler({ ticker: "AAPL" });
  ok(!out.evidence.holders.ok, "a failed holders probe leaves the leg marked failed");
  ok(!/</.test(out.evidence.holders.error), "the failed holders probe reports no upstream markup");
  eq(out.meta.legs.holders, false, "meta names the holders leg as absent");
  ok(!("managers" in out.evidence.holders), "a failed holders leg reports no manager count at all, not zero");
  ok(!out.tables.some((t) => t.name === "holders"), "a failed holders leg contributes no table");
}

// ---------------------------------------------------------------------------
// 7. Post-run refusal: two of the three CONTENT legs failed
// ---------------------------------------------------------------------------
{
  const s = stubs({
    runDossier: async () => { throw Object.assign(new Error("Upstream error (HTTP 502)"), { statusCode: 502 }); },
    runInsider: async () => { throw Object.assign(new Error("Upstream rate-limited - retry shortly"), { statusCode: 503 }); },
  });
  const e = await throws(() => s.handler({ ticker: "AAPL" }), 502, "dossier AND insider failing refuses the sale");
  ok(/dossier leg failed/.test(e.message) && /insider leg failed/.test(e.message), "the refusal names BOTH failed legs");
  ok(/Not charged/i.test(e.message), "the post-run refusal says the buyer is not charged");
  eq(s.calls.synth, 0, "a refused pack never pays for the connective synthesis");
}

// ---------------------------------------------------------------------------
// 8. The merged happy path
// ---------------------------------------------------------------------------
const s = stubs();
const out = await s.handler({ ticker: "aapl" }, null);
eq(s.calls.synth, 1, "exactly ONE pack synthesis call is made");
eq(s.calls.dossier, 1, "the dossier composite is called in-process once");
eq(s.calls.insider, 1, "the insider composite is called in-process once");
eq(out.ticker, "AAPL", "the ticker is upper-cased");
eq(out.cik, CIK, "the resolved CIK rides on the output");
for (const h of ["## Executive summary", "## Company", "## Filings", "## Insider flow (last 90 days)", "## Institutional holders (13F)", "## What to check next", "## Sources"]) {
  ok(out.report.includes(h), `the report carries the "${h.replace(/^## /, "")}" section`);
}
ok(out.report.startsWith("# Ticker Pack: Apple Inc. (AAPL)"), "the report is titled for the company and ticker");
ok(out.report.includes(__test.DISCLAIMER), "the not-investment-advice line is in the report");
ok(out.report.includes("### Due-Diligence Dossier"), "the dossier sub-report is demoted under the pack's own heading");
ok(out.report.includes("### Insider Flow Report"), "the insider sub-report is demoted too");
ok(!/\n## Sources\n[\s\S]*\n## Sources\n/.test(out.report), "there is exactly ONE Sources section in the stitched report");

// merged + deduped sources, renumbered citations
const urls = out.sources.map((x) => x.url);
eq(new Set(urls).size, urls.length, "the merged source list has no duplicate URLs");
ok(urls.some((u) => u === "https://www.sec.gov/dossier-1") && urls.some((u) => u === "https://www.sec.gov/insider-1"), "both parts' sources are merged in");
ok(urls.includes(HOLDERS.managers[0].url) && urls.includes(HOLDERS.searchUrl), "the holders leg contributes its information tables and its search");
ok(urls.includes(FILINGS.browseUrl), "the EDGAR filing history is a source");
eq(out.sources.map((x) => x.n).join(","), out.sources.map((_x, i) => i + 1).join(","), "the merged source list is numbered 1..N with no gaps");
{
  const dosN = out.sources.find((x) => x.url === "https://www.sec.gov/dossier-1").n;
  const insN = out.sources.find((x) => x.url === "https://www.sec.gov/insider-1").n;
  ok(out.report.includes(`The issuer filed a 10-Q [${dosN}]`), "the dossier's [1] was renumbered into the merged list");
  ok(out.report.includes(`One Form 4 [${insN}]`), "the insider report's [1] was renumbered into the merged list");
  ok(out.report.includes(`and the search [${dosN}]`), "a URL shared by two parts collapses to ONE merged source number");
  const maxCited = Math.max(...[...out.report.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])));
  ok(maxCited <= out.sources.length, `no citation points past the merged list (max [${maxCited}] of ${out.sources.length})`);
}

// tables
const tnames = out.tables.map((t) => t.name);
ok(tnames.includes("filings"), "the deterministic filings digest is a table");
ok(tnames.includes("dossier-financials"), "the dossier's appendix is namespaced");
ok(tnames.includes("insider-transactions"), "the insider appendix is namespaced");
ok(tnames.includes("holders"), "the new institutional-holders table is present");
eq(new Set(tnames).size, tnames.length, "no two tables share a name");
{
  const h = out.tables.find((t) => t.name === "holders");
  eq(h.rows.length, 2, "the holders table has one row per manager that reported a position");
  eq(h.rows[0][0], "BERKSHIRE HATHAWAY INC", "the holders table is ranked by share count (the one field comparable across filers)");
  eq(h.rows[0][4], "227917808", "share counts come straight from the parsed filing");
  eq(h.rows[0][6], "289.3600", "the implied price per share is carried so a filer still reporting THOUSANDS is visible");
  ok(h.columns.includes("Principal rows"), "principal (PRN) rows are reported separately from share counts");
}
{
  ok(/rows marked PRN are principal amounts/.test(out.report), "the report says PRN rows are excluded from share counts");
  ok(/not summed here/.test(out.report), "the report refuses to sum a dollar column whose units differ across filers");
  ok(!("valueReportedUsd" in out.evidence.holders), "no cross-filer dollar total is invented in evidence");
}

// honesty of the holders section
ok(/sample of holders, not the complete holder list/i.test(out.report), "the holders section says plainly that it is a sample");
ok(out.report.includes("at least 10,000"), "an EDGAR 'at least N' result count is reported as at-least, never as an exact figure");
ok(/45 days after quarter end/.test(out.report), "the 13F lag caveat is stated");
eq(out.meta.holder_sample_complete, false, "meta marks the holder sample as incomplete");
eq(out.evidence.holders.complete, false, "evidence marks the holder sample as incomplete");

// evidence
eq(out.evidence.dossier.ok, true, "evidence records the dossier leg as produced");
eq(out.evidence.insider.filingsRead, 11, "evidence carries the insider leg's measured filings-read count");
eq(out.evidence.insider.netOpenMarketUsd, -1610000, "evidence carries the measured net open-market flow, sign intact");
eq(out.evidence.holders.managers, 2, "evidence carries the holder sample size");
eq(out.evidence.holders.failedScans, 1, "evidence reports information tables that could not be read");
eq(out.evidence.packSynthesis.ok, true, "evidence records the pack synthesis");
eq(out.meta.legs_produced, 3, "all three content legs produced on the happy path");

// ---------------------------------------------------------------------------
// 9. The synthesis prompt carries only fetched facts
// ---------------------------------------------------------------------------
{
  const p = s.prompts[0];
  ok(p.includes("Apple Inc.") && p.includes("AAPL") && p.includes(CIK), "the prompt identifies the company from the resolved fetch");
  ok(p.includes("Electronic Computers"), "the SIC description comes from the fetched submissions JSON");
  ok(p.includes("10-Q filed 2026-08-01"), "the filing dates in the prompt are the fetched ones");
  ok(p.includes("227917808"), "the holder share counts in the prompt are the parsed ones");
  ok(p.includes("11") && p.includes("18"), "the insider counts in the prompt are the measured ones");
  ok(p.includes("$1.9M") || p.includes("1850000") || p.includes("$1.85M"), "the insider sale total in the prompt traces to the measured value");
  ok(/must not be summed/.test(p), "the prompt tells the model reported 13F dollar values are not comparable across filers");
  ok(/SAMPLE, NOT THE COMPLETE HOLDER LIST/i.test(p), "the prompt tells the model the holder list is a sample");
  ok(/NEVER introduce a figure/.test(p), "the prompt carries the absolute grounding rule");
  ok(!/not investment advice.*recommend/i.test(p) || /not investment advice/i.test(p), "the prompt forbids recommendations");
  // The kit's own documentation-example numbers must never reach the model.
  for (const leak of ["Example Corp", "EXMP", "3509184", "12025", "566000000"]) {
    ok(!p.includes(leak), `the documentation example value "${leak}" does not leak into the prompt`);
  }
  ok(!p.includes("Due-Diligence Dossier"), "the sub-reports' model-written prose is NOT fed back into the pack prompt");
}

// ---------------------------------------------------------------------------
// 10. A failed leg is named as failed and never zeroed
// ---------------------------------------------------------------------------
{
  const s2 = stubs({ runInsider: async () => { throw Object.assign(new Error("Upstream error (HTTP 502) <html>provider trace</html>"), { statusCode: 502 }); } });
  const o2 = await s2.handler({ ticker: "AAPL" });
  eq(o2.meta.legs_produced, 2, "two produced legs still ships a pack");
  eq(o2.meta.legs.insider, false, "meta names the insider leg as failed");
  eq(o2.evidence.insider.ok, false, "evidence marks the insider leg failed");
  ok(!("openMarketBuys" in o2.evidence.insider), "a failed insider leg reports NO buy count, not a zero");
  ok(!("netOpenMarketUsd" in o2.evidence.insider), "a failed insider leg reports NO net flow, not a zero");
  ok(!o2.tables.some((t) => t.name.startsWith("insider-")), "a failed insider leg contributes no table");
  ok(/insider-flow leg did not produce/i.test(o2.report), "the report says the insider leg did not produce");
  ok(/none should be inferred/i.test(o2.report), "the report tells the reader not to infer insider activity");
  ok(!/provider trace/.test(o2.report) && !/<html>/.test(o2.report), "no upstream body is relayed into the report");
  ok(/UNAVAILABLE/.test(o2.report), "the header line flags the unavailable leg");
  ok(s2.prompts[0].includes("INSIDER FLOW LEG: FAILED"), "the prompt tells the model the leg FAILED");
  ok(/do NOT state or imply any insider buying, selling or amount/.test(s2.prompts[0]), "the prompt forbids inventing the missing leg");
}

// ---------------------------------------------------------------------------
// 11. Upstream failure mapping for the pack's own synthesis
// ---------------------------------------------------------------------------
{
  const s3 = stubs({ synthesize: async () => { throw Object.assign(new Error("Upstream error: <html>bad gateway body</html>"), { statusCode: 502 }); } });
  const o3 = await s3.handler({ ticker: "AAPL" });
  eq(o3.evidence.packSynthesis.ok, false, "a failed pack synthesis is recorded as failed");
  ok(!/bad gateway body/.test(JSON.stringify(o3)), "the upstream body never reaches the buyer");
  ok(o3.report.includes("## Executive summary"), "the pack still ships with a deterministic summary");
  ok(o3.report.includes("Form 4 filings in the window: 11"), "the fallback summary quotes only measured values");
  ok(o3.report.includes("## What to check next"), "the fallback check-next list is deterministic");
  ok(o3.report.includes("### Due-Diligence Dossier") && o3.report.includes("### Insider Flow Report"), "both paid parts still ship when only the connective pass fails");
}
{
  // the run deadline: if the parts ate the payment window, the pack ships
  // without paying for a synthesis it cannot finish
  let t = 1_755_000_000_000;
  const s4 = stubs({ now: () => t, runDossier: async () => { t += 280_000; return DOSSIER_OUT; } });
  const o4 = await s4.handler({ ticker: "AAPL" });
  eq(s4.calls.synth, 0, "past the run deadline the pack synthesis is skipped, not started");
  ok(/payment window/.test(o4.evidence.packSynthesis.error), "and the reason is recorded");
  ok(o4.report.includes("## Executive summary"), "the pack still ships");
}

// ---------------------------------------------------------------------------
// 12. The pack prompt hands over counts, not lists to count, and knows the
//     dossier ships alongside it
// ---------------------------------------------------------------------------
{
  const s5 = stubs();
  await s5.handler({ ticker: "AAPL" });
  const p = s5.prompts[0];
  ok(p.includes("counted by form: 10-Q x1, 8-K x1"), "the prompt carries the per-form tally of the filing list");
  ok(p.includes("10-Q filed 2026-08-01") && p.includes("8-K filed 2026-07-31"), "every listed filing reaches the prompt, not a slice of them");
  ok(/never say the pack or this material lacks a business description/.test(p), "the prompt says the Company section carries the business narrative");
  ok(/listed 8 Form 4 filings as metadata \(a capped listing/.test(p), "the dossier's Form 4 figure is labeled a capped listing, not a window count");
  eq(__test.formCounts([{ form: "4" }, { form: "144" }, { form: "4" }]), "4 x2, 144 x1", "formCounts tallies in order of first appearance");
}
// ---------------------------------------------------------------------------
// 13. A pack synthesis that stops for length never ships a cut sentence
// ---------------------------------------------------------------------------
{
  const cut = { choices: [{ message: { content: "Apple Inc. is an electronic computers issuer.\n===NEXT===\n- Read the 10-Q filed 2026-08-01.\n- Re-run the insider window after the next" }, finish_reason: "length" }], usage: { cost: 0.04 } };
  const s6 = stubs({ synthesize: async () => cut });
  const o6 = await s6.handler({ ticker: "AAPL" });
  ok(o6.report.includes("- Read the 10-Q filed 2026-08-01."), "the complete bullets before the cut are kept");
  ok(!o6.report.includes("after the next\n") && !/after the next$/m.test(o6.report), "the bullet cut for length is dropped");
  const cut2 = { choices: [{ message: { content: "Apple Inc. is an electronic computers issuer.\n\nThe insider window shows three sales across two insiders and" }, finish_reason: "length" }], usage: { cost: 0.04 } };
  const s7 = stubs({ synthesize: async () => cut2 });
  const o7 = await s7.handler({ ticker: "AAPL" });
  ok(o7.report.includes("Apple Inc. is an electronic computers issuer.") && !o7.report.includes("two insiders and"), "a summary cut mid-paragraph keeps its complete paragraphs only");
  ok(o7.report.includes("## What to check next") && /Re-run the insider leg/.test(o7.report), "the check-next list that never arrived comes from the deterministic fallback");
}

console.log(`\n[ticker-pack] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
