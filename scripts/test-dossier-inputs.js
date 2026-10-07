// Dossier INPUT sufficiency: the operating-to-net bridge and the verbatim
// filing excerpts. Built from a real report (INTC, Q2 2026): the synthesis was
// handed +$1.80B operating income and -$11.03B net income with nothing between
// them and called the loss "unexplained" as a red flag; the 10-Q explains it
// (a $12.5B fair-value loss on escrowed shares issued to the US Government) and
// XBRL carries it as NonoperatingIncomeExpense -$12.58B. Fixture values are the
// figures SEC companyfacts reported for CIK 50863 on 2026-08-26.
import { incomeBridge, bridgeLines, filingText, extractFilingExcerpts, EXCERPT_TERMS } from "../src/tools/dossier-kit.js";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const q = (start, end, val, extra = {}) => ({ start, end, val, form: "10-Q", fy: 2026, fp: "Q2", filed: "2026-07-24", ...extra });
const facts = {
  OperatingIncomeLoss: [q("2025-12-28", "2026-06-27", -1_340_000_000), q("2026-03-29", "2026-06-27", 1_796_000_000), { start: "2024-12-29", end: "2025-12-27", val: -4_000_000_000, form: "10-K", fp: "FY", fy: 2025, filed: "2026-01-30" }],
  NetIncomeLoss: [q("2025-12-28", "2026-06-27", -14_761_000_000), q("2026-03-29", "2026-06-27", -11_033_000_000), { start: "2024-12-29", end: "2025-12-27", val: -19_000_000_000, form: "10-K", fp: "FY", fy: 2025, filed: "2026-01-30" }],
  NonoperatingIncomeExpense: [q("2025-12-28", "2026-06-27", -13_314_000_000), q("2026-03-29", "2026-06-27", -12_576_000_000)],
  IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: [q("2026-03-29", "2026-06-27", -10_819_000_000)],
  IncomeTaxExpenseBenefit: [q("2025-12-28", "2026-06-27", 364_000_000), q("2026-03-29", "2026-06-27", 29_000_000)],
};

// ---- bridge -------------------------------------------------------------------
{
  const b = incomeBridge(facts);
  ok(b && b.period.start === "2026-03-29" && b.period.end === "2026-06-27", `bridge picks the newest period with both ends, shortest span (quarter over YTD): ${b && `${b.period.start}..${b.period.end}`}`);
  ok(b.operating === 1_796_000_000 && b.net === -11_033_000_000 && b.gap === -12_829_000_000, "operating, net and gap are the reported figures");
  ok(b.lines.some((l) => l.label.startsWith("Non-operating") && l.val === -12_576_000_000), "the non-operating line (the escrowed-shares loss lives here) is in the bridge");
  ok(b.lines.some((l) => l.label.startsWith("Income tax") && l.val === -29_000_000), "tax rides as a negative contribution to net");
  // -12,829 - (-12,576 - 29) = -224M remainder (noncontrolling interest + equity investments), within 15% of the gap.
  ok(Math.abs(b.remainder - (-224_000_000)) < 1e6 && b.explained === true, `the reported lines account for the gap (remainder ${b.remainder}) -> explained`);
  const text = bridgeLines(b).join("\n");
  ok(/OPERATING-TO-NET BRIDGE \(2026-03-29 to 2026-06-27, 10-Q\)/.test(text) && /-\$12\.58B/.test(text) && /REPORTED non-operating\/tax item, not an unexplained loss/.test(text), "bridge lines hand the synthesis the reconciliation in words");
  ok(incomeBridge({ OperatingIncomeLoss: [q("2026-03-29", "2026-06-27", 1_000_000_000)], NetIncomeLoss: [q("2026-03-29", "2026-06-27", 950_000_000)] }) === null, "no bridge when operating and net agree within tolerance (nothing to explain)");
  ok(incomeBridge({ OperatingIncomeLoss: [q("2026-03-29", "2026-06-27", 1_000_000_000)] }) === null, "no bridge when one end is missing");
  const thin = incomeBridge({ OperatingIncomeLoss: [q("2026-03-29", "2026-06-27", 1_796_000_000)], NetIncomeLoss: [q("2026-03-29", "2026-06-27", -11_033_000_000)] });
  ok(thin && thin.explained === false && thin.lines.length === 0 && /unaccounted for in the XBRL bridge/.test(bridgeLines(thin).join("\n")), "without the bridging concepts the bridge says the gap is UNACCOUNTED in XBRL (not explained) and points at the excerpts");
  ok(bridgeLines(null).length === 0, "bridgeLines(null) is empty (no block when there is nothing to explain)");
}

// ---- excerpts -----------------------------------------------------------------
{
  // Sections spaced the way a filing is (statements, then notes pages later).
  const filler = "<p>" + "The following discussion should be read in conjunction with our consolidated condensed financial statements. ".repeat(12) + "</p>";
  const html = `<html><body><ix:header><ix:hidden>0000050863 intc:SharesInEscrowMember 2026-03-29 2026-06-27 0000050863 intc:DepartmentOfCommerceMember 2025-12-28</ix:hidden></ix:header><div><p>Operating income (loss) 1,796 ( 3,176 )</p><table><tr><td>Interest and other, net</td><td>( 12,576 )</td></tr></table>${filler}
  <p>Note 4: Escrowed Shares Issued to the U.S. Government. Under the terms of our previously-disclosed U.S. Government Agreement that we entered into with the DOC on August 22, 2025, upon receipt of cash proceeds for our performance under Secure Enclave, we released 7 million Escrowed Shares. For the three and six months ended June 27, 2026, we recognized $12.5 billion and $13.6 billion, respectively, of losses related to the net change in fair value of both Escrowed Shares released and Escrowed Shares remaining in escrow.</p>
  ${filler}<script>var x = "mark-to-market";</script><p>Cash flow: Mark-to-market (gains) losses on Escrowed Shares 13,619 &#8212;</p></div></body></html>`;
  const text = filingText(html);
  ok(!/<[a-z]/i.test(text) && !/var x/.test(text) && !/SharesInEscrowMember/.test(text), "filingText strips tags, script bodies and the hidden iXBRL header (context soup)");
  ok(filingText("<p>R&amp;D &amp;lt;b&amp;gt; &lt;i&gt;</p>") === "R&D &lt;b&gt; <i>", "entity decoding is single-pass: an encoded &amp;lt; never becomes a tag (double-unescape)");
  const ex = extractFilingExcerpts(text, { maxChars: 6_000, extraTerms: ["interest and other"] });
  ok(ex.length >= 3, `excerpts found: ${ex.length}`);
  ok(ex[0].term === "interest and other" && /12,576/.test(ex[0].text), "extraTerms (from the bridge) take the budget first");
  ok(ex.some((x) => x.term === "escrow" || x.term === "fair value of") && ex.some((x) => /\$12\.5 billion/.test(x.text)), "the escrowed-shares loss sentence is captured verbatim");
  const budget = extractFilingExcerpts(text, { maxChars: 300 });
  const used = budget.reduce((n, x) => n + x.text.length, 0);
  ok(budget.length === 1 || used <= 300, `maxChars bounds the total (${used} chars, ${budget.length} windows; a single window may exceed it, a second never does)`);
  ok(extractFilingExcerpts("intc:SharesInEscrowMember 2026-03-29 2026-06-27 0000050863 intc:DepartmentOfCommerceMember 2025-12-28 0000050863 us-gaap:EscrowDepositMember escrow 2026-06-27 0000050863 intc:X 2026-01-01").length === 0, "a window that is mostly XBRL ids is not the filing's words and is dropped");
  const spans = ex.map((x) => x.text);
  ok(new Set(spans).size === spans.length, "no duplicate windows (overlap dedupe)");
  ok(EXCERPT_TERMS[0] === "mark-to-market" && EXCERPT_TERMS.includes("going concern") && EXCERPT_TERMS.includes("material weakness"), "vocabulary leads with the bottom-line movers and carries the diligence disclosures");
  ok(extractFilingExcerpts("nothing here").length === 0, "no vocabulary hit -> no excerpts (the prompt then says the text was silent)");
}
// ---- SEC outage vs unknown ticker (stubbed fetch, no network) --------------------
{
  const { DOSSIER_TOOLS } = await import("../src/tools/dossier-kit.js");
  const run = DOSSIER_TOOLS.find((t) => t.slug === "dossier").handler;
  const realFetch = globalThis.fetch;
  const J = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  try {
    globalThis.fetch = async () => J(503, "unavailable");
    let e = await run({ ticker: "AAPL" }).catch((x) => x);
    ok(e?.statusCode === 502 && /SEC EDGAR unavailable/.test(e.message), `SEC reads failing upstream -> 502 retry, not a 422 that blames the ticker (got ${e?.statusCode}: ${String(e?.message).slice(0, 80)})`);
    globalThis.fetch = async (url) => (String(url).includes("company_tickers") ? J(200, { 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } }) : J(503, "unavailable"));
    e = await run({ ticker: "ZZZZQ" }).catch((x) => x);
    ok(e?.statusCode === 422 && /No SEC EDGAR filings found/.test(e.message), `an unknown ticker still answers the 422 that names it (got ${e?.statusCode})`);
  } finally { globalThis.fetch = realFetch; }
}
console.log(`${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
