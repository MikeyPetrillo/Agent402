// scripts/test-filing-watch-kit.js
// Offline tests for src/tools/filing-watch-kit.js (the $4 SEC FILING REPORT and
// the filing watch monitor's probe). No network at all:
//   - globalThis.fetch is replaced by a stub that ONLY answers openrouter.ai and
//     THROWS on any other host, so any accidental egress fails the run loudly;
//   - the two EDGAR seams (resolveCompany, the submissions read) and the
//     document fetch are injected, so a test can count requests exactly and
//     assert that something was NEVER called - which is the whole point of the
//     zero-egress and thin-evidence cases.
// The injected defaults are asserted to BE the real edgar-kit / ticker-pack
// functions, so the seams cannot drift away from the shipped path.
//
// Covers:
//   - catalog envelope (route, slug, price $4, schema, example, tags) and the
//     upstream arithmetic (maxUpstreamUsd <= 1.6 = 40% of $4)
//   - input validation: every bad input 400s with ZERO egress and ZERO EDGAR reads
//   - probe: exactly ONE submissions read, fingerprint stability (reordering and
//     unrelated churn do not move it; a new accession or a changed form does),
//     form allowlist / exclusion, day window
//   - describeFilingChanges: new-filing detection, no false positives on roll-off
//   - thin-evidence refusals: nothing filed in the window (422) and every primary
//     document unreadable (502) - each asserting NO synthesis call was made
//   - upstream mapping: 5xx -> 502, 429 -> 503, transport/timeout -> 504, empty
//     completion -> 502, and no upstream body ever relayed to the buyer
//   - grounding: every number in the evidence half of the prompt traces to
//     fetched data, unread/not-fetched filings are named as such, and the
//     documentation-example numbers never leak in
//   - allowEmpty is honoured only for the scheduler's own pseudo-request
//   - docToText / fetchDocText / selectDocuments primitives

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-key-not-real";

const mod = await import("../src/tools/filing-watch-kit.js");
const {
  FILING_WATCH_TOOLS, FILING_TIERS, FILING_MODELS, probeCompanyFilings, describeFilingChanges,
  docToText, fetchDocText, selectDocuments, normForms, formLabel, makeFilingHandler, __test,
} = mod;
const { resolveCompany } = await import("../src/tools/edgar-kit.js");
const { probeCompanyFilings: tickerPackSubmissions } = await import("../src/tools/ticker-pack-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)})`);
async function throws(p, status, label) {
  try { const r = await p; ok(false, `${label}: expected ${status}, resolved with ${JSON.stringify(r).slice(0, 90)}`); return null; }
  catch (e) { ok(e?.statusCode === status, `${label} -> ${status} (got ${e?.statusCode}: ${String(e?.message).slice(0, 120)})`); return e; }
}

const handler = FILING_WATCH_TOOLS[0].handler;

// ---------------------------------------------------------------------------
// Fixtures. Every number is deliberately distinctive so the grounding
// assertion can trace what reaches the synthesis prompt.
// ---------------------------------------------------------------------------
const CIK = "0000000042";
const ARCH = (acc, doc) => `https://www.sec.gov/Archives/edgar/data/42/${acc.replace(/-/g, "")}/${doc}`;
const F = (form, filed, period, description, acc, doc) => ({ form, filed, period, description, accession: acc, url: doc ? ARCH(acc, doc) : "" });

const TODAY = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

const SUB = {
  cik: CIK, name: "Example Manufacturing Corp", sic: "3674", exchanges: ["Nasdaq"], tickers: ["EXMP"],
  stateOfIncorporation: "DE", fiscalYearEnd: "1231",
  filings: [
    F("8-K", daysAgo(2), daysAgo(3), "Results of Operations and Financial Condition", "0000000042-26-000011", "ex8k.htm"),
    F("10-Q", daysAgo(9), daysAgo(21), "Quarterly report", "0000000042-26-000010", "exmp-20260630.htm"),
    F("4", daysAgo(11), daysAgo(11), "4", "0000000042-26-000009", "form4.xml"),
    F("DEF 14A", daysAgo(19), "", "Definitive proxy statement", "0000000042-26-000008", "proxy.htm"),
    F("SC 13G/A", daysAgo(140), "", "SC 13G/A", "0000000042-26-000004", "sc13ga.htm"),
  ],
  browseUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${CIK}&type=&dateb=&owner=include&count=40`,
};

const DOC_8K = `<html><head><style>.x{color:red}</style><script>var leak=987654321;</script></head>
<ix:header><ix:hidden>0000000042 CONTEXT 555555555</ix:hidden></ix:header>
<body><p>Item 2.02 Results of Operations and Financial Condition.</p>
<p>On ${daysAgo(3)}, Example Manufacturing Corp announced net revenue of $418,300,000 for the quarter,
compared to $377,100,000 in the prior year quarter. Gross margin was 41.7% versus 39.2% a year earlier.</p>
<p>The company said it repaid $52,000,000 of its revolving credit facility.</p></body></html>`;

const DOC_10Q = `<html><body><p>PART I - FINANCIAL INFORMATION</p>
<p>Total assets were $2,140,900,000 at ${daysAgo(21)} compared with $1,988,400,000 at December 31.</p>
<p>Research and development expense was $63,500,000 for the three months ended, an increase of 12.4%.</p>
<p>&amp; the company employed 4,812 people.</p></body></html>`;

const DOC_PROXY = `<html><body><p>NOTICE OF ANNUAL MEETING OF STOCKHOLDERS</p>
<p>The annual meeting will be held on ${daysAgo(-14)}. Stockholders of record as of ${daysAgo(30)} may vote.
Proposal 3 asks stockholders to approve an amendment increasing the share reserve by 3,750,000 shares.</p></body></html>`;

const DOCS = {
  [ARCH("0000000042-26-000011", "ex8k.htm")]: DOC_8K,
  [ARCH("0000000042-26-000010", "exmp-20260630.htm")]: DOC_10Q,
  [ARCH("0000000042-26-000008", "proxy.htm")]: DOC_PROXY,
  [ARCH("0000000042-26-000009", "form4.xml")]: "<ownershipDocument><issuerName>Example Manufacturing Corp</issuerName></ownershipDocument>",
  [ARCH("0000000042-26-000004", "sc13ga.htm")]: "<html><body>Passive holder statement.</body></html>",
};

const SYNTH_TEXT = "## Snapshot\nExample Manufacturing Corp filed four documents [1].\n\nThis is a summary of public SEC filings and is not investment advice.";
const SYNTH_OK = { choices: [{ message: { content: SYNTH_TEXT } }], usage: { cost: 0.19 } };
const LEAK = "SHOULD_NEVER_REACH_BUYER";
const errRes = (status, body = `<html>upstream ${LEAK} sk-or-v1-deadbeef</html>`) => ({ ok: false, status, text: async () => body, json: async () => ({}) });
const jsonRes = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body });

// ---------------------------------------------------------------------------
// Stub plumbing: fetch answers ONLY openrouter.ai; everything else throws.
// EDGAR is injected, and every injected call is counted.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let synthBodies = [], otherHosts = [], calls = {};
const FORM4_XML = `<ownershipDocument><issuer><issuerName>Example Manufacturing Corp</issuerName><issuerTradingSymbol>EXMP</issuerTradingSymbol></issuer><periodOfReport>2026-08-10</periodOfReport><reportingOwner><reportingOwnerId><rptOwnerCik>77</rptOwnerCik><rptOwnerName>Pat Example</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>0</isOfficer></reportingOwnerRelationship></reportingOwner><nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-08-10</value></transactionDate><transactionCoding><transactionCode>S</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>1500</value></transactionShares><transactionPricePerShare><value>42.1</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>20000</value></sharesOwnedFollowingTransaction></postTransactionAmounts><ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>`;

function stub({ synth = SYNTH_OK, sub = SUB, docs = DOCS, docFail = null, resolveErr = null } = {}) {
  synthBodies = []; otherHosts = [];
  calls = { resolve: 0, submissions: 0, doc: [], subArgs: [], form: [] };
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const host = new URL(u).host;
    if (host !== "openrouter.ai") { otherHosts.push(host); throw new Error(`unexpected egress to ${host}`); }
    synthBodies.push(JSON.parse(opts.body));
    return typeof synth === "function" ? synth() : jsonRes(synth);
  };
  return {
    // Routine ownership forms (Form 4 here) are read as raw XML and parsed.
    fetchForm: async (url) => { calls.form.push(String(url)); return FORM4_XML; },
    resolve: async ({ ticker, cik }) => {
      calls.resolve++;
      if (resolveErr) throw resolveErr;
      return { cik: cik ? String(cik).padStart(10, "0") : CIK, name: ticker === "EXMP" || !ticker ? SUB.name : null };
    },
    readSubmissions: async (args) => { calls.submissions++; calls.subArgs.push(args); return typeof sub === "function" ? sub(args) : sub; },
    fetchDocText: async (url, o) => {
      calls.doc.push(url);
      if (docFail) return docFail(url);
      const raw = docs[url];
      if (raw === undefined) throw new Error("EDGAR document HTTP 404");
      const text = docToText(raw).slice(0, o?.maxChars ?? 24_000);
      return { text, bytes: raw.length, truncated: false };
    },
  };
}
const restore = () => { globalThis.fetch = realFetch; };
const SCHED = { headers: { authorization: "sub:sub_abc123" } };

// ---------------------------------------------------------------------------
// 1. Catalog envelope + upstream arithmetic
// ---------------------------------------------------------------------------
{
  const def = FILING_WATCH_TOOLS[0];
  eq(FILING_WATCH_TOOLS.length, 1, "the kit exports exactly one tool");
  eq(def.route, "POST /v1/filing-report", "route is POST /v1/filing-report");
  eq(def.slug, "filing-report", "slug is filing-report");
  eq(def.price, FILING_TIERS["filing-report"].price, "the tool price is the tier price (one source of truth)");
  ok(typeof def.handler === "function", "handler is a function");
  eq(def.category, "llm", "category is llm (one synthesis call)");
  ok(def.discovery?.input?.ticker === "AAPL", "documented example input is a US ticker");
  ok(def.discovery.inputSchema.properties.exclude, "schema exposes the form-exclusion knob");
  ok(def.discovery.inputSchema.properties.forms && def.discovery.inputSchema.properties.focus, "schema exposes forms + focus");
  ok(/not investment advice/i.test(def.description), "catalog description carries the not-investment-advice line");
  ok(/not investment advice/i.test(def.discovery.output.example.meta.disclaimer) || /not investment advice/i.test(JSON.stringify(def.discovery.output.example)), "example carries the disclaimer");
  ok(def.tags.includes("sec") && def.tags.includes("edgar") && def.tags.includes("8-k"), "tags name the source and the flagship form");
  const t = FILING_TIERS["filing-report"];
  ok(t.maxUpstreamUsd <= 1.6, `maxUpstreamUsd ${t.maxUpstreamUsd} <= 1.6`);
  ok(t.maxUpstreamUsd / 4 <= 0.4 + 1e-9, `maxUpstreamUsd is <= 40% of the $4 price (${(t.maxUpstreamUsd / 4 * 100).toFixed(0)}%)`);
  // Worst case priced with the margin clamp's conservative opus row ($15/$75 per M).
  const worstIn = (t.maxDocs * t.docMaxChars + t.indexRows * 200 + 6000) / 3.5;
  // Rates are the LIVE list price for the synthesis model, verified against
  // OpenRouter's catalog on 2026-08-22 (claude-opus-5: $5/M in, $25/M out).
  // They are not a guess and they are not a conservative multiple: the point of
  // this assertion is that the DECLARED cap is honest, and the separate
  // price-vs-cap assertion below is what keeps the sale profitable. Re-verify
  // when the synthesis model changes - scripts/test-gateway-model-ids.js is the
  // guard that notices a model moving.
  const worst = worstIn * 5e-6 + t.synthMaxTokens * 25e-6;
  ok(worst <= t.maxUpstreamUsd, `worst-case synthesis $${worst.toFixed(3)} (${Math.round(worstIn)} in / ${t.synthMaxTokens} out at $5/$25 per M) is within the $${t.maxUpstreamUsd} cap`);
  eq(FILING_MODELS.length, 1, "one synthesis model id is exported for the live-catalog guard");
  eq(FILING_MODELS[0], "anthropic/claude-opus-5", "synthesis model is claude-opus-5");
  // The injected seams ARE the shipped functions.
  ok(__test.defaultResolve === resolveCompany, "the resolve seam defaults to edgar-kit's resolveCompany (cached ticker map)");
  ok(__test.defaultReadSubmissions === tickerPackSubmissions, "the submissions seam defaults to the EXISTING one-read EDGAR helper, not a duplicated fetch");
}

// ---------------------------------------------------------------------------
// 2. Input validation - 400 with ZERO egress and ZERO EDGAR reads
// ---------------------------------------------------------------------------
{
  const d = stub();
  const bad = [
    [null, "null body"], ["AAPL", "string body"], [{}, "no ticker or cik"],
    [{ ticker: "" }, "empty ticker"], [{ ticker: "not a ticker" }, "ticker with spaces"],
    [{ ticker: "TOOLONGTICKER" }, "ticker too long"], [{ ticker: "1ABC" }, "ticker starting with a digit"],
    [{ cik: "abc" }, "non-numeric cik"], [{ cik: "12345678901" }, "cik too long"],
    [{ ticker: "EXMP", forms: "8-K,<script>" }, "form filter with markup"],
    [{ ticker: "EXMP", exclude: ["4", "10-Q; DROP"] }, "exclusion with punctuation"],
    [{ ticker: "EXMP", forms: "A,B,C,D,E,F,G,H,I,J,K,L,M" }, "too many form filters"],
    [{ ticker: "EXMP", focus: "not-an-accession" }, "focus that is not an accession number"],
  ];
  for (const [body, label] of bad) await throws(handler(body, null, d), 400, label);
  eq(otherHosts.length, 0, "no egress to any non-openrouter host on invalid input");
  eq(synthBodies.length, 0, "no synthesis call on invalid input");
  eq(calls.resolve, 0, "no company resolution on invalid input");
  eq(calls.submissions, 0, "no EDGAR submissions read on invalid input");
  eq(calls.doc.length, 0, "no document fetched on invalid input");
  restore();
}

// ---------------------------------------------------------------------------
// 3. normForms / formLabel primitives
// ---------------------------------------------------------------------------
{
  ok(JSON.stringify(normForms("8-k, 10-Q ,8-K", "forms")) === JSON.stringify(["8-K", "10-Q"]), "normForms uppercases, trims and de-duplicates");
  ok(JSON.stringify(normForms(["def 14a"], "forms")) === JSON.stringify(["DEF 14A"]), "normForms accepts an array and keeps internal spaces");
  eq(normForms(null, "forms").length, 0, "normForms of null is empty");
  eq(formLabel("8-K"), "current report (material event)", "8-K carries a plain-language label");
  eq(formLabel("NOPE-99"), null, "an unknown form gets NO invented label");
}

// ---------------------------------------------------------------------------
// 4. The probe: ONE submissions read, stable fingerprint
// ---------------------------------------------------------------------------
let base = null;
{
  const d = stub();
  base = await probeCompanyFilings("EXMP", d);
  eq(calls.submissions, 1, "probe makes exactly ONE EDGAR submissions read");
  eq(calls.resolve, 1, "probe resolves the company exactly once (cached ticker map upstream)");
  eq(calls.doc.length, 0, "probe never fetches a primary document");
  eq(synthBodies.length, 0, "probe never calls the LLM gateway");
  eq(otherHosts.length, 0, "probe makes no unexpected egress");
  eq(base.cik, CIK, "probe returns the resolved CIK");
  eq(base.name, SUB.name, "probe returns the company name as filed with EDGAR");
  eq(base.filings.length, 5, "probe keeps every filing when no filter is given");
  eq(base.ids.length, 5, "five distinct accession numbers");
  ok(base.keys.every((k) => /^\d{10}-\d{2}-\d{6}\|[A-Z0-9 ./-]+$/.test(k)), "each fingerprint key is accession|FORM");
  ok(base.fingerprint === JSON.stringify(base.keys), "fingerprint is the serialized key set");
  eq(base.formCounts["8-K"], 1, "form counts are tallied");
  eq(base.submissionsUrl, `https://data.sec.gov/submissions/CIK${CIK}.json`, "probe reports the exact submissions document it read");
  ok(calls.subArgs[0].limit >= 40, `the submissions read asks for enough raw rows to survive a form filter (${calls.subArgs[0].limit})`);
  restore();
}
{
  // Reordering upstream must NOT move the fingerprint.
  const shuffled = { ...SUB, filings: [SUB.filings[3], SUB.filings[0], SUB.filings[4], SUB.filings[1], SUB.filings[2]] };
  const d = stub({ sub: shuffled });
  const p = await probeCompanyFilings("EXMP", d);
  eq(p.fingerprint, base.fingerprint, "reordering the submissions index does not move the fingerprint");
  restore();
}
{
  // A changed description / period is NOT a filing change.
  const churned = { ...SUB, filings: SUB.filings.map((f) => ({ ...f, description: f.description + " (revised label)" })) };
  const d = stub({ sub: churned });
  const p = await probeCompanyFilings("EXMP", d);
  eq(p.fingerprint, base.fingerprint, "a re-worded description does not move the fingerprint");
  restore();
}
{
  // A NEW accession moves it; so does the same accession under a different form.
  const withNew = { ...SUB, filings: [F("8-K", TODAY, TODAY, "Entry into a Material Definitive Agreement", "0000000042-26-000012", "ex8k2.htm"), ...SUB.filings] };
  let d = stub({ sub: withNew });
  const pNew = await probeCompanyFilings("EXMP", d);
  ok(pNew.fingerprint !== base.fingerprint, "a new accession moves the fingerprint");
  restore();
  const reformed = { ...SUB, filings: [{ ...SUB.filings[0], form: "8-K/A" }, ...SUB.filings.slice(1)] };
  d = stub({ sub: reformed });
  const pRe = await probeCompanyFilings("EXMP", d);
  ok(pRe.fingerprint !== base.fingerprint, "the same accession re-filed under a different form moves the fingerprint");
  restore();
}
{
  // Bounded: the newest N only.
  const many = { ...SUB, filings: Array.from({ length: 90 }, (_, i) => F("4", daysAgo(i), daysAgo(i), "4", `0000000042-26-0000${String(90 - i).padStart(2, "0")}`, "form4.xml")) };
  const d = stub({ sub: many });
  const p = await probeCompanyFilings({ cik: CIK }, { ...d, limit: 40 });
  eq(p.filings.length, 40, "the fingerprint is bounded to the newest 40 filings");
  eq(p.keys.length, 40, "40 keys");
  restore();
}
{
  // Filters + window.
  let d = stub();
  const only8k = await probeCompanyFilings("EXMP", { ...d, forms: ["8-K"] });
  eq(only8k.filings.length, 1, "the forms allowlist keeps only the named forms");
  const noInsider = await probeCompanyFilings("EXMP", { ...d, exclude: ["4", "SC 13G/A"] });
  eq(noInsider.filings.length, 3, "the exclusion list drops the named forms");
  ok(!noInsider.filings.some((f) => f.form === "4"), "excluded forms are absent");
  const windowed = await probeCompanyFilings("EXMP", { ...d, days: 30 });
  eq(windowed.filings.length, 4, "the day window drops the 140-day-old SC 13G/A");
  restore();
}

// ---------------------------------------------------------------------------
// 5. describeFilingChanges - new-filing detection
// ---------------------------------------------------------------------------
{
  const next = { filings: [F("8-K", TODAY, TODAY, "Entry into a Material Definitive Agreement", "0000000042-26-000012", "ex8k2.htm"), ...SUB.filings] };
  next.keys = next.filings.map((f) => `${f.accession}|${f.form}`);
  const lines = describeFilingChanges(base, next);
  eq(lines.length, 1, "exactly one new filing is reported");
  ok(/^8-K \(current report \(material event\)\) filed /.test(lines[0]), "the change line names the form in plain language");
  ok(lines[0].includes("Entry into a Material Definitive Agreement"), "the change line carries EDGAR's own description");
  eq(describeFilingChanges(base, base).length, 0, "an unchanged index reports nothing");
  eq(describeFilingChanges(null, next).length, 0, "the first sight (no prior) reports nothing - that is the welcome run");
  // Roll-off is not news.
  const rolled = { filings: SUB.filings.slice(0, 3) };
  eq(describeFilingChanges(base, rolled).length, 0, "filings ageing out of the index are NOT reported as changes");
  // Bounded.
  const flood = { filings: Array.from({ length: 25 }, (_, i) => F("4", TODAY, TODAY, "4", `0000000042-26-0001${String(i).padStart(2, "0")}`, "form4.xml")) };
  const many = describeFilingChanges(base, flood);
  eq(many.length, 11, "a flood of new filings is capped at 10 lines plus a count");
  ok(/and 15 more$/.test(many[10]), "the overflow line counts the rest");
}

// ---------------------------------------------------------------------------
// 6. Happy path: shape, sources, tables, evidence, ONE synthesis call
// ---------------------------------------------------------------------------
let happy = null;
{
  const d = stub();
  happy = await handler({ ticker: "EXMP", days: 30 }, null, d);
  eq(calls.submissions, 1, "the paid report makes ONE submissions read");
  eq(calls.doc.length, 3, "the paid report fetches at most 3 primary documents");
  eq(synthBodies.length, 1, "exactly ONE synthesis call");
  eq(otherHosts.length, 0, "no unexpected egress on the paid path");
  ok(happy.report.startsWith("# SEC Filing Report: Example Manufacturing Corp (EXMP)"), "report header names the company as filed with EDGAR");
  // Routine ownership forms are parsed (raw XML, not the xsl view) and handed
  // to the synthesis as structured lines, never listed as NOT FETCHED.
  eq(calls.form.length, 1, "the one Form 4 in the window is read as XML");
  ok(calls.form[0].endsWith("/form4.xml") && !/\/xsl/.test(calls.form[0]), "the raw XML url is used (no xsl segment)");
  ok(/=== ROUTINE FORMS PARSED/.test(synthBodies[0].messages[0].content) && /Pat Example \(director\)/.test(synthBodies[0].messages[0].content) && /S\/D 1,500 Common Stock @ \$42\.1 on 2026-08-10, 20,000 owned after/.test(synthBodies[0].messages[0].content), "the prompt carries the parsed Form 4 line with the insider, the sale and the holding after");
  ok(!((synthBodies[0].messages[0].content.split("=== NOT FETCHED")[1] || "").split("===")[0].includes("0000000042-26-000009")), "a parsed form is not also listed as NOT FETCHED");
  eq(happy.meta.routine_forms_parsed, 1, "meta counts the parsed ownership forms");
  ok(/1 ownership form parsed/.test(happy.report.split("\n")[2]), "the report header counts the parsed forms");
  ok(happy.report.includes(SYNTH_TEXT), "report carries the synthesis prose");
  ok(happy.report.includes("## Sources"), "report appends a numbered sources section");
  eq(happy.company, "Example Manufacturing Corp", "company name comes from EDGAR");
  eq(happy.ticker, "EXMP", "ticker echoed");
  eq(happy.cik, CIK, "cik echoed");
  ok(happy.untrustedContent === true, "result is marked untrusted (filing text is third-party content)");
  ok(happy.sources.length === 5 && happy.sources[0].n === 1, `4 filings + the submissions index are cited (${happy.sources.length})`);
  ok(happy.sources.every((s) => /^https:\/\/(www\.sec\.gov|data\.sec\.gov)\//.test(s.url)), "every source URL is on SEC EDGAR");
  ok(happy.sources.at(-1).url.includes("data.sec.gov/submissions"), "the submissions index is the last source");
  const names = happy.tables.map((t) => t.name);
  ok(names.includes("filings") && names.includes("documents"), `appendix has filings + documents (${names.join(",")})`);
  const ft = happy.tables.find((t) => t.name === "filings");
  eq(ft.rows.length, 4, "the filings table lists every filing in the window");
  eq(ft.rows.filter((r) => r[6] === "yes").length, 3, "the filings table marks which documents were read in full");
  const dt = happy.tables.find((t) => t.name === "documents");
  ok(dt.rows.every((r) => Number(r[3]) > 0), "the documents table records bytes read");
  ok(happy.evidence.documents.filter((x) => x.read).length === 3, "evidence records three documents read");
  ok(happy.evidence.fingerprint === JSON.stringify(happy.evidence.filings.map((f) => `${f.accession}|${f.form.toUpperCase()}`).sort()), "evidence carries the same fingerprint the monitor compares");
  eq(happy.meta.tier, "filing-report", "meta records the tier");
  eq(happy.meta.documents_read, 3, "meta records documents read");
  eq(happy.meta.synthesis_model, "anthropic/claude-opus-5", "meta records the synthesis model");
  ok(/not investment advice/i.test(happy.meta.disclaimer), "meta disclaimer says not investment advice");
  eq(synthBodies[0].max_tokens, FILING_TIERS["filing-report"].synthMaxTokens, "synthesis is capped at the tier's token budget");
  eq(synthBodies[0].model, "anthropic/claude-opus-5", "synthesis uses the declared model");
  restore();
}

// ---------------------------------------------------------------------------
// 7. Document SELECTION: substance over routine ownership forms; focus wins
// ---------------------------------------------------------------------------
{
  const picked = selectDocuments(SUB.filings, { max: 3 });
  ok(picked.map((f) => f.form).join(",") === "10-Q,8-K,DEF 14A", `substantive forms are chosen ahead of Form 4 / SC 13G, periodic report first (${picked.map((f) => f.form).join(",")})`);
  const focused = selectDocuments(SUB.filings, { max: 3, focus: ["0000000042-26-000009"] });
  eq(focused[0].form, "4", "an explicit focus accession is read first");
  eq(focused.length, 3, "focus does not widen the document budget");
  eq(selectDocuments([{ ...SUB.filings[0], url: "" }], { max: 3 }).length, 0, "a filing with no primary-document URL is never selected");
  // A leftover slot is NOT filled with a routine ownership form: the appendix
  // already states everything a Form 4 line carries, and the byte budget is
  // better left unspent. (Found live: AAPL's 30-day window spent a slot on a
  // Form 4 and a small-cap spent one on a PDF annual report.)
  const two = selectDocuments([SUB.filings[0], SUB.filings[2], SUB.filings[4]], { max: 3 });
  ok(two.map((f) => f.form).join(",") === "8-K", `a leftover slot is not filled with routine forms (${two.map((f) => f.form).join(",")})`);
  const routineOnly = selectDocuments([SUB.filings[2], SUB.filings[4]], { max: 3 });
  ok(routineOnly.length > 0 && routineOnly[0].form === "4", "when there is nothing narrative, the routine form IS read rather than nothing");
  // Binary attachments are never selected (an ARS exhibit is routinely a PDF).
  const withPdf = [{ ...SUB.filings[0], accession: "0000000042-26-000013", url: "https://www.sec.gov/Archives/edgar/data/42/000000000000000013/ars.pdf", form: "ARS" }, ...SUB.filings];
  ok(!selectDocuments(withPdf, { max: 3 }).some((f) => /\.pdf$/i.test(f.url)), "a .pdf primary document is never selected");
  ok(mod.isTextualDoc("https://www.sec.gov/Archives/edgar/data/42/x.htm") && !mod.isTextualDoc("https://www.sec.gov/Archives/edgar/data/42/x.pdf"), "isTextualDoc admits .htm and refuses .pdf");
  ok(mod.isTextualDoc("https://www.sec.gov/Archives/edgar/data/42/0000000042-26-000011"), "an extensionless EDGAR document is still admitted");
}
{
  // A binary body that slips past the extension filter is refused at READ time,
  // so it is counted as unread rather than summarized as 36,000 chars of noise.
  const pdfFetch = async () => ({ ok: true, status: 200, text: async () => "%PDF-1.4\n525 0 obj endobj xref" + "\u0000".repeat(50) });
  let threw = null;
  try { await fetchDocText("https://www.sec.gov/Archives/edgar/data/42/x.htm", { fetchImpl: pdfFetch }); } catch (e) { threw = e; }
  ok(threw && /not text \(binary or PDF/.test(threw.message), "a PDF body is refused even when the URL looks textual");
}
{
  const d = stub();
  const r = await handler({ ticker: "EXMP", days: 30, focus: "0000000042-26-000009" }, null, d);
  ok(calls.doc[0].endsWith("form4.xml"), "the paid report honours focus (the filing that just landed is read first)");
  ok(r.meta.documents_read >= 1, "focus run still produces a report");
  restore();
}

// ---------------------------------------------------------------------------
// 8. Thin-evidence refusals - never charged, and NO synthesis call
// ---------------------------------------------------------------------------
{
  // (a) nothing filed in the window
  const d = stub({ sub: { ...SUB, filings: [SUB.filings[4]] } });   // only the 140-day-old one
  const e = await throws(handler({ ticker: "EXMP", days: 30 }, null, d), 422, "no filings in the window");
  ok(/Not charged/.test(e.message), "the empty-window refusal says not charged");
  eq(synthBodies.length, 0, "NO synthesis call on an empty window");
  eq(calls.doc.length, 0, "no document is fetched on an empty window");
  restore();
}
{
  // (b) a form filter that matches nothing
  const d = stub();
  const e = await throws(handler({ ticker: "EXMP", days: 30, forms: "S-1" }, null, d), 422, "form filter matches nothing");
  ok(/drop the form filter/.test(e.message), "the refusal tells the buyer how to widen");
  eq(synthBodies.length, 0, "NO synthesis call when the form filter matches nothing");
  restore();
}
{
  // (c) every primary document unreadable = an EDGAR incident, not a product
  const d = stub({ docFail: () => { throw new Error("EDGAR document HTTP 503"); } });
  const e = await throws(handler({ ticker: "EXMP", days: 30 }, null, d), 502, "every primary document unreadable");
  ok(/Not charged/.test(e.message), "the unreadable-documents refusal says not charged");
  eq(synthBodies.length, 0, "NO synthesis call when no document could be read");
  eq(calls.doc.length, 3, "all three selected documents were attempted before refusing");
  restore();
}
{
  // (d) a document that answers but carries no readable text is NOT read
  const d = stub({ docFail: () => ({ text: "tiny", bytes: 4, truncated: false }) });
  const e = await throws(handler({ ticker: "EXMP", days: 30 }, null, d), 502, "documents with no readable text");
  ok(/no readable text/.test(e.message), "the refusal names why the documents were unusable");
  restore();
}
{
  // (e) PARTIAL failure is fine: one document read is enough to sell
  let n = 0;
  const d0 = stub();
  const d = { ...d0, fetchDocText: async (url, o) => { calls.doc.push(url); if (n++ > 0) throw new Error("EDGAR document HTTP 500"); return { text: docToText(DOCS[url]), bytes: DOCS[url].length, truncated: false }; } };
  const r = await handler({ ticker: "EXMP", days: 30 }, null, d);
  eq(r.meta.documents_read, 1, "one readable document is enough");
  eq(synthBodies.length, 1, "the partial run still synthesizes");
  const prompt = synthBodies[0].messages[0].content;
  ok(/=== NOT READ ===/.test(prompt), "the failed documents are NAMED as unread in the prompt");
  ok(/NOT READ \(EDGAR document HTTP 500\)/.test(prompt), "the prompt says why each unread document was unread");
  const dt = r.tables.find((t) => t.name === "documents");
  ok(dt.rows.filter((x) => /^not read/.test(x[6])).length === 2, "the appendix marks the unread documents, never zeroes them silently");
  restore();
}

// ---------------------------------------------------------------------------
// 9. allowEmpty is the SCHEDULER's, never a paying buyer's
// ---------------------------------------------------------------------------
{
  const empty = { ...SUB, filings: [] };
  let d = stub({ sub: empty });
  await throws(handler({ ticker: "EXMP", days: 30, allowEmpty: true }, null, d), 422, "a paying buyer cannot buy an empty report with allowEmpty");
  eq(synthBodies.length, 0, "no synthesis for a buyer's empty window");
  restore();
  d = stub({ sub: empty });
  const r = await handler({ ticker: "EXMP", days: 30, allowEmpty: true }, SCHED, d);
  eq(synthBodies.length, 1, "the scheduler's welcome run on a quiet company still produces a report");
  eq(calls.doc.length, 0, "the welcome run on an empty window fetches no documents");
  ok(/no primary document was read/.test(synthBodies[0].messages[0].content), "the prompt says plainly that no document was read");
  eq(r.meta.filings, 0, "meta reports zero filings honestly");
  restore();
}

// ---------------------------------------------------------------------------
// 10. Grounding: every number in the evidence half traces to fetched data
// ---------------------------------------------------------------------------
{
  const d = stub();
  await handler({ ticker: "EXMP", days: 30 }, null, d);
  const prompt = synthBodies[0].messages[0].content;
  restore();

  const numsIn = (s) => new Set(String(s).match(/\d+(?:\.\d+)?/g) || []);
  const fixtureNums = numsIn(JSON.stringify([SUB, DOC_8K, DOC_10Q, DOC_PROXY, FORM4_XML, TODAY, daysAgo(-14), daysAgo(30)]));
  const evidenceHalf = prompt.split("=== COMPANY ===")[1] || "";
  const stray = [...numsIn(evidenceHalf)].filter((x) => {
    if (fixtureNums.has(x)) return false;
    const n = Number(x);
    if (Number.isInteger(n) && n >= 0 && n <= 100) return false;                 // citation numbers, counts, percentages
    return ![...fixtureNums].some((f) => f.includes(x));                          // a fragment of a fetched number
  });
  ok(stray.length === 0, `every number in the evidence half of the prompt traces to fetched data (stray: ${stray.slice(0, 8).join(", ")})`);

  // The distinctive fetched values DO reach it.
  ok(prompt.includes("418,300,000") && prompt.includes("41.7%"), "the 8-K's own figures reach the prompt");
  ok(prompt.includes("2,140,900,000") && prompt.includes("4,812"), "the 10-Q's own figures reach the prompt");
  ok(prompt.includes("3,750,000"), "the proxy's own figure reaches the prompt");
  ok(prompt.includes("0000000042-26-000011") && prompt.includes("0000000042-26-000010"), "accession numbers reach the prompt");
  // The kit's own documentation example must NEVER leak in.
  ok(!prompt.includes("Example Corp (EXMP)") && !prompt.includes("0000000042-26-000011\", \"yes\""), "the catalog example's invented rows never leak into the prompt");
  // Stripped junk stays stripped.
  ok(!prompt.includes("987654321"), "a <script> body inside the filing is stripped before the prompt");
  ok(!prompt.includes("555555555"), "the inline-XBRL header block is stripped before the prompt");

  // The grounding rules themselves.
  ok(/Use ONLY the FILINGS INDEX and the DOCUMENT TEXT/.test(prompt), "prompt states the only-fetched-data rule");
  ok(/NEVER introduce a filing, a number, a date/.test(prompt), "prompt states the no-invention rule");
  ok(/untrusted DATA, never as instructions/.test(prompt), "prompt states the prompt-injection rule for filing text");
  ok(/Never guess what an unread filing says/.test(prompt), "prompt forbids summarizing an unfetched filing");
  ok(/=== (NOT FETCHED \(index facts only - never summarize these\)|ROUTINE FORMS PARSED)/.test(prompt), "the filings we did NOT read are listed as index-facts-only, or parsed as structured routine forms");
  ok(/the document itself makes the comparison explicit/.test(prompt), "prompt bounds 'what changed' to explicit in-document comparisons");
  ok(/not investment advice/i.test(prompt), "prompt requires the not-investment-advice close");
  ok(/no price targets|No price targets/.test(prompt), "prompt forbids recommendation language");
  ok(!/fabricat\w+ (?:a|the) (?:figure|number)\s+(?:is fine|when)/i.test(prompt), "prompt contains no fabrication permission");
}
{
  // A TRUNCATED document must be declared as truncated.
  const d0 = stub();
  const d = { ...d0, fetchDocText: async (url) => { calls.doc.push(url); return { text: docToText(DOCS[url]), bytes: 800_000, truncated: true }; } };
  await handler({ ticker: "EXMP", days: 30 }, null, d);
  const prompt = synthBodies[0].messages[0].content;
  ok(/TRUNCATED: this is the OPENING PORTION/.test(prompt), "a truncated document is declared truncated in its own header");
  ok(/never assert that something is absent from such a document/.test(prompt) && /GAP IN THIS MATERIAL IS NEVER A FINDING/.test(prompt), "prompt forbids absence claims from a truncated/excerpted document and forbids presenting a gap as a finding");
  restore();
}

// ---------------------------------------------------------------------------
// 11. Upstream failure mapping - and NO upstream body ever relayed
// ---------------------------------------------------------------------------
for (const [status, want, label] of [[500, 502, "500"], [502, 502, "502"], [503, 502, "503"], [429, 503, "429"], [401, 502, "401"], [403, 502, "403"]]) {
  const d = stub({ synth: () => errRes(status) });
  const e = await throws(handler({ ticker: "EXMP", days: 30 }, null, d), want, `synthesis upstream ${label}`);
  ok(e && !String(e.message).includes(LEAK) && !/<html>/.test(e.message) && !/sk-or-v1/.test(e.message), `upstream ${label}: no upstream body, markup or key is relayed ("${String(e?.message).slice(0, 60)}")`);
  restore();
}
{
  const d = stub({ synth: () => { throw new Error("socket hang up"); } });
  const e = await throws(handler({ ticker: "EXMP", days: 30 }, null, d), 504, "synthesis transport failure (timeout / hang up)");
  ok(/Upstream request failed/.test(e.message), "the transport failure is described as an upstream request failure");
  restore();
}
{
  const d = stub({ synth: { choices: [{ message: { content: "" } }] } });
  const e = await throws(handler({ ticker: "EXMP", days: 30 }, null, d), 502, "empty synthesis completion");
  ok(/not charged/i.test(e.message), "empty synthesis says not charged");
  restore();
}
{
  // An EDGAR failure on the submissions read propagates with ITS status, never 200.
  const err = Object.assign(new Error("EDGAR upstream HTTP 503 - try again later"), { statusCode: 502 });
  const d = stub({ sub: () => { throw err; } });
  await throws(handler({ ticker: "EXMP", days: 30 }, null, d), 502, "EDGAR submissions outage");
  eq(synthBodies.length, 0, "no synthesis call when EDGAR is down");
  restore();
}
{
  const d = stub({ resolveErr: Object.assign(new Error("Unknown ticker: ZZZZ"), { statusCode: 404 }) });
  await throws(handler({ ticker: "ZZZZ", days: 30 }, null, d), 404, "an unknown ticker 404s from the resolver");
  eq(synthBodies.length, 0, "no synthesis call for an unknown ticker");
  restore();
}

// ---------------------------------------------------------------------------
// 12. docToText / fetchDocText primitives
// ---------------------------------------------------------------------------
{
  const txt = docToText(DOC_8K);
  ok(!/</.test(txt) && !/>/.test(txt), "docToText leaves no angle brackets");
  ok(!txt.includes("987654321") && !txt.includes("555555555"), "script bodies and the inline-XBRL header are dropped whole");
  ok(txt.includes("Item 2.02 Results of Operations"), "the narrative survives");
  ok(docToText("<p>a &amp; b &nbsp;c &#65;</p>") === "a & b c A", `entities are decoded (got ${JSON.stringify(docToText("<p>a &amp; b &nbsp;c &#65;</p>"))})`);
  ok(!docToText("<scr<script>ipt>alert(1)</script>ipt>").includes("<"), "a nested tag cannot survive the stripper");
  ok(docToText("<p>one</p><p>two</p>").includes("\n"), "block tags become line breaks so paragraphs survive");
}
{
  // Host pinning + byte bound, driven through a fake fetch.
  const body = "x".repeat(50_000);
  const fakeFetch = async () => ({ ok: true, status: 200, text: async () => `<p>${body}</p>` });
  const r = await fetchDocText("https://www.sec.gov/Archives/edgar/data/42/x.htm", { maxBytes: 1_000, maxChars: 400, fetchImpl: fakeFetch });
  ok(r.truncated === true, "a body over the byte cap is reported truncated");
  ok(r.text.length <= 400, `the text is capped at maxChars (${r.text.length})`);
  await throws(fetchDocText("https://evil.example.com/x.htm", { fetchImpl: fakeFetch }), 502, "a document URL off www.sec.gov is refused");
  await throws(fetchDocText("http://www.sec.gov/x.htm", { fetchImpl: fakeFetch }), 502, "a plaintext http document URL is refused");
  await throws(fetchDocText("not a url", { fetchImpl: fakeFetch }), 502, "a non-URL document reference is refused");
  eq(__test.DOC_HOST, "www.sec.gov", "the document host allowlist is exactly www.sec.gov");
}
{
  // Streaming path: the reader is cancelled once the byte cap is hit.
  let cancelled = false, reads = 0;
  const chunk = new TextEncoder().encode("<p>" + "y".repeat(5_000) + "</p>");
  const streamFetch = async () => ({
    ok: true, status: 200,
    body: { getReader: () => ({ read: async () => { reads++; return { done: false, value: chunk }; }, cancel: async () => { cancelled = true; } }) },
  });
  const r = await fetchDocText("https://www.sec.gov/Archives/edgar/data/42/x.htm", { maxBytes: 12_000, maxChars: 100_000, fetchImpl: streamFetch });
  ok(cancelled, "the stream reader is cancelled at the byte cap (the transfer is bounded, not just the slice)");
  ok(reads <= 4, `the cap stops the read quickly (${reads} chunks)`);
  ok(r.bytes >= 12_000 && r.bytes < 20_000, `bytes read stay near the cap (${r.bytes})`);
}

console.log(`\n[filing-watch-kit] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
