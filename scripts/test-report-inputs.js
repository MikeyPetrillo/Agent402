// Report INPUT sufficiency, round 2 (2026-08-26 cross-report review): the
// recall feeds and the domain audit. Each assertion here is a defect a paying
// reader would have been misled by, verified live before it was fixed.
import { recallRow, fdaDate } from "../src/tools/gov-kit.js";
import { tlsScoreOf, certCoversHost } from "../src/tools/domain-audit-kit.js";
import { readFileSync } from "node:fs";
import { itemLabels, exhibitFromIndexHeaders, sliceForBudget, docMaxBytesFor, PERIODIC_DOC_MAX_BYTES, __test as fw } from "../src/tools/filing-watch-kit.js";
import { parseForm4 } from "../src/tools/insider-flow-kit.js";
import { parse13fCover } from "../src/tools/edgar-kit.js";
import { classifyFromSubmissions } from "../src/tools/ipo-report-kit.js";
import { parse13GCover } from "../src/tools/ticker-pack-kit.js";
import { shapeGoPlus, privilegedFunctions } from "../src/tools/token-risk-kit.js";
import { auditCitations } from "../src/tools/research-deep-kit.js";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// ---- openFDA rows -----------------------------------------------------------
{
  const long = "x".repeat(1200);
  const r = { recalling_firm: "Acme", classification: "Class I", status: "Ongoing", reason_for_recall: `Devices could poten${long}tially connect`, product_description: `${"Losartan ".repeat(30)}NDC 00591-3746-00`, distribution_pattern: "Nationwide", recall_initiation_date: "20240507", recall_number: "D-1-2024", event_id: "94001", termination_date: "20250101", code_info: "Lots A1, A2", product_quantity: "2,924,000 tablets", voluntary_mandated: "Voluntary: Firm initiated" };
  const pub = recallRow(r, false);
  ok(pub.reason.length === 220 && pub.product.length === 180 && pub.lots === undefined, "public $0.004 tool keeps its small caps (220/180) and no lot list");
  ok(pub.eventId === "94001" && pub.terminated === "2025-01-01", "event id and termination date ride on the public row too (zero cost)");
  const full = recallRow(r, true);
  ok(full.reason.endsWith("tially connect") && /NDC 00591-3746-00$/.test(full.product), "full rows keep the whole reason and the NDC at the end of the product description");
  ok(full.lots === "Lots A1, A2" && full.quantity === "2,924,000 tablets" && full.voluntary === "Voluntary: Firm initiated", "full rows carry lots, quantity and voluntary/mandated");
  ok(fdaDate("20240507") === "2024-05-07" && fdaDate(undefined) === null, "FDA dates render ISO; missing stays null");
}

// ---- TLS grade --------------------------------------------------------------
{
  const good = { chainTrusted: true, daysRemaining: 200, subject: "github.com", altNames: ["github.com", "www.github.com"] };
  ok(tlsScoreOf(good, "github.com") === 100, "trusted, matching, long-lived -> 100");
  ok(tlsScoreOf({ ...good, chainTrusted: false, authorizationError: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "github.com") === 0, "an untrusted chain scores 0 however many days remain (self-signed.badssl.com graded 100 before)");
  ok(tlsScoreOf({ ...good, subject: "badssl.com", altNames: ["badssl.com"] }, "wrong.host.badssl.com") === 0, "a certificate for a different host scores 0 (wrong.host.badssl.com graded 100 before)");
  ok(tlsScoreOf({ chainTrusted: true, daysRemaining: 20, subject: "*.example.com", altNames: ["*.example.com"] }, "www.example.com") === 60, "wildcard covers one label; 20 days -> 60");
  ok(certCoversHost({ subject: "*.example.com", altNames: [] }, "a.b.example.com") === false, "wildcard does not cover two labels");
  ok(certCoversHost({ subject: null, altNames: [] }, "example.com") === null && tlsScoreOf({ chainTrusted: true, daysRemaining: 100 }, "example.com") === 100, "no names seen -> unknown, never penalised");
  ok(tlsScoreOf({ chainTrusted: true, daysRemaining: 0 }) === 0 && tlsScoreOf(null) === null, "expired -> 0; no probe -> null (unassessed)");
}

// ---- filing-report ----------------------------------------------------------
{
  ok(itemLabels("2.02,9.01") === "2.02 results of operations and financial condition; 9.01 financial statements and exhibits" && itemLabels("") === "", "8-K item codes render with their Regulation S-K meaning");
  ok(docMaxBytesFor("10-Q", 800_000) === PERIODIC_DOC_MAX_BYTES && docMaxBytesFor("10-K/A", 800_000) === PERIODIC_DOC_MAX_BYTES && docMaxBytesFor("8-K", 800_000) === 800_000 && docMaxBytesFor("S-1", 800_000) === 800_000, "periodic reports get the 8 MB byte cap; everything else keeps the small one");
  ok(["FWP", "424B5", "SCHEDULE 13G/A", "S-8"].every((f) => fw.ROUTINE.has(f)) && fw.SUBSTANTIVE.indexOf("10-Q") < fw.SUBSTANTIVE.indexOf("8-K"), "deal paperwork and ownership schedules are routine; the periodic report outranks the 8-K for a document slot");
  const hdr = "<pre>&lt;TYPE&gt;8-K\n&lt;FILENAME&gt;intc-20260723.htm\n&lt;TYPE&gt;EX-99.1\n&lt;FILENAME&gt;q226earningsrelease.htm\n&lt;TYPE&gt;EX-101.SCH\n&lt;FILENAME&gt;intc.xsd</pre>";
  const ex = exhibitFromIndexHeaders(hdr, 50863, "0000050863-26-000155");
  ok(ex && ex.type === "EX-99.1" && ex.url === "https://www.sec.gov/Archives/edgar/data/50863/000005086326000155/q226earningsrelease.htm", "the EX-99 press release is found in the entity-escaped SGML index headers");
  ok(exhibitFromIndexHeaders("<TYPE>8-K\n<FILENAME>a.htm\n<TYPE>EX-101.SCH\n<FILENAME>b.xsd", 1, "0000000001-26-000001") === null, "no EX-99 -> null (never a taxonomy file)");
  // A synthetic 10-Q shaped like INTC's: TOC + glossary decoys for MD&A, page headers repeating "Notes to Financial Statements", the real MD&A late, the index at the END.
  const filler = (w, n) => Array.from({ length: n }, (_, i) => `${w} ${i} `).join("");
  const doc = [
    "Cover page. Table of Contents: Financial Statements 3, Notes to Financial Statements 9, Management's Discussion and Analysis (MD&A) 27, Risk Factors 41, Quantitative and Qualitative Disclosures About Market Risk 41.",
    filler("statement line", 600),
    "Notes to Financial Statements 9 Table of Contents Note 1: Basis of presentation. " + filler("note text", 900),
    "Notes to Financial Statements 13 Table of Contents Escrowed Shares Issued to the U.S. Government. We recognized $12.5 billion of losses related to the net change in fair value of Escrowed Shares. " + filler("more notes", 900),
    "Note 14: Contingencies Legal Proceedings We are regularly party to various ongoing claims. " + filler("legal text", 400),
    "Key Terms MD&A Management's Discussion and Analysis Mentee Robotics Mentee Robotics Ltd. " + filler("glossary", 300),
    "Management's Discussion and Analysis Overview This report should be read in conjunction with our 2025 Form 10-K. " + filler("mdna text", 3000),
    "Risk Factors The risks described within Risk Factors in our 2025 Form 10-K could materially affect us. " + filler("risk", 150),
    "Quantitative and Qualitative Disclosures About Market Risk We are affected by changes in currency. " + filler("q", 100),
    "Form 10-Q Cross-Reference Index Item 2. Management's Discussion and Analysis of Financial Condition and Results of Operations Pages 27-40 Item 3. Quantitative and Qualitative Disclosures About Market Risk Page 41",
  ].join("\n");
  const sl = sliceForBudget(doc, 12_000, "10-Q");
  const labels = sl.sections.map((x) => x.label);
  ok(sl.excerpted && sl.total === doc.length && sl.text.length <= 13_500, `a periodic report over budget is EXCERPTED by section (${sl.text.length} of ${doc.length} chars)`);
  ok(labels.some((l) => l.startsWith("management's discussion")) && /Overview This report should be read/.test(sl.text) && !/Mentee Robotics/.test(sl.text.split("management's discussion")[1] || ""), "MD&A is the real late section, not the TOC or glossary decoy");
  ok(/\$12\.5 billion of losses related to the net change in fair value of Escrowed Shares/.test(sl.text), "the notes windows reach the note that explains the quarter (vocabulary: escrow / fair value)");
  ok(/regularly party to various ongoing claims/.test(sl.text) && labels.includes("legal proceedings"), "Legal Proceedings is taken from the late note, not the TOC");
  ok(labels.includes("risk factors") && /could materially affect us/.test(sl.text), "the 10-Q's short Risk Factors item (last late heading) is included");
  ok(sliceForBudget("short doc", 100, "10-Q").excerpted === false, "a document that fits is returned whole");
  const s1 = sliceForBudget("x".repeat(5000), 1000, "S-1");
  ok(s1.excerpted && s1.sections[0].label === "opening portion" && s1.text.length === 1000, "non-periodic forms keep the opening-portion cut");
}

// ---- filing-report: routine ownership forms are parsed, not "NOT FETCHED" ----
{
  const { parseForm144, describeRoutineForm, rawXmlUrl, ROUTINE_PARSE_FORMS } = await import("../src/tools/filing-watch-kit.js");
  const { parseForm4 } = await import("../src/tools/insider-flow-kit.js");
  ok(rawXmlUrl("https://www.sec.gov/Archives/edgar/data/320193/000114036126034741/xslF345X06/form4.xml") === "https://www.sec.gov/Archives/edgar/data/320193/000114036126034741/form4.xml" && rawXmlUrl("https://www.sec.gov/Archives/edgar/data/1/2/xsl144X01/primary_doc.xml") === "https://www.sec.gov/Archives/edgar/data/1/2/primary_doc.xml", "the raw XML sits at the index URL without the xsl segment");
  ok(["3", "4", "5", "144"].every((f) => ROUTINE_PARSE_FORMS.has(f)) && !ROUTINE_PARSE_FORMS.has("8-K"), "Forms 3/4/5/144 are parsed; substantive forms are read as documents");
  const x144 = "<edgarSubmission><formData><issuerInfo><issuerName>Apple Inc.</issuerName></issuerInfo><securitiesInformation><securitiesClassTitle>Common Stock</securitiesClassTitle><brokerOrMarketmakerDetails><name>Morgan Stanley</name></brokerOrMarketmakerDetails><noOfUnitsSold>50000</noOfUnitsSold><aggregateMarketValue>11500000</aggregateMarketValue><noOfUnitsOutstanding>14900000000</noOfUnitsOutstanding><approxSaleDate>08/12/2026</approxSaleDate><securitiesExchangeName>NASDAQ</securitiesExchangeName></securitiesInformation><securitiesToBeSold><natureOfAcquisitionTransaction>Restricted Stock Vesting</natureOfAcquisitionTransaction><nameOfPersonfromWhomAcquired>Issuer</nameOfPersonfromWhomAcquired><amountOfSecuritiesAcquired>50000</amountOfSecuritiesAcquired></securitiesToBeSold><relationshipsToIssuer><relationshipToIssuer>Officer</relationshipToIssuer></relationshipsToIssuer><nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold>Jane Example</nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold><planAdoptionDates><planAdoptionDate>05/01/2026</planAdoptionDate></planAdoptionDates></formData></edgarSubmission>";
  const r = parseForm144(x144);
  ok(r && r.seller === "Jane Example" && r.relationship === "Officer" && r.units === 50000 && r.aggregateValueUsd === 11500000 && r.approxSaleDate === "08/12/2026" && /Morgan Stanley/.test(r.broker) && r.planAdoptionDate === "05/01/2026", `Form 144 fields parse (${JSON.stringify(r).slice(0, 120)})`);
  ok(parseForm144("<html>not a form</html>") === null, "a non-144 document parses to null, never a hollow record");
  const line144 = describeRoutineForm({ f: { form: "144", filed: "2026-08-11", accession: "0001950047-26-007959" }, r144: r });
  ok(/Jane Example \(Officer\) proposes to sell 50,000 Common Stock \(aggregate market value \$11,500,000\) on or about 08\/12\/2026 on NASDAQ via Morgan Stanley/.test(line144) && /10b5-1 plan adopted 05\/01\/2026/.test(line144), "the Form 144 prompt line names seller, size, value, date, broker and the plan");
  const x4 = "<ownershipDocument><issuer><issuerName>Apple Inc.</issuerName><issuerTradingSymbol>AAPL</issuerTradingSymbol></issuer><periodOfReport>2026-08-25</periodOfReport><reportingOwner><reportingOwnerId><rptOwnerCik>1</rptOwnerCik><rptOwnerName>Sam Example</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>0</isDirector><isOfficer>1</isOfficer><officerTitle>SVP, General Counsel</officerTitle></reportingOwnerRelationship></reportingOwner><nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-08-25</value></transactionDate><transactionCoding><transactionCode>S</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>4000</value></transactionShares><transactionPricePerShare><value>231.5</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>120000</value></sharesOwnedFollowingTransaction></postTransactionAmounts><ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction></nonDerivativeTable><footnotes><footnote id=\"F1\">Sale effected pursuant to a Rule 10b5-1 trading plan.</footnote></footnotes></ownershipDocument>";
  const line4 = describeRoutineForm({ f: { form: "4", filed: "2026-08-27", period: "2026-08-25", accession: "0001140361-26-034741" }, form4: parseForm4(x4) });
  ok(/Sam Example \(SVP, General Counsel\)/.test(line4) && /S\/D 4,000 Common Stock @ \$231\.5 on 2026-08-25, 120,000 owned after \(D\)/.test(line4) && /Rule 10b5-1 plan/.test(line4) && /Transaction codes/.test(line4), `the Form 4 prompt line names the insider, the sale, the price, what is owned after and the plan (${line4.slice(0, 100)})`);
  const src = readFileSync(new URL("../src/tools/filing-watch-kit.js", import.meta.url), "utf8");
  ok(/=== ROUTINE FORMS PARSED/.test(src) && /!routineAcc\.has\(f\.accession\)/.test(src) && /deps\.fetchForm \|\| fetchXmlText/.test(src), "the prompt carries the parsed block, parsed forms leave NOT FETCHED, and the reader is injectable");
  const tb = readFileSync(new URL("../src/tools/token-brief-kit.js", import.meta.url), "utf8");
  ok(/TODAY is \$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}/.test(tb) && /has already passed/.test(tb), "token brief: the prompt states today's date so a past unlock date is never called upcoming (JUP sample, 2026-08-28)");
}

// ---- Form 4 derivative + holdings -------------------------------------------
{
  const xml = `<ownershipDocument><issuer><issuerName>Meta Platforms, Inc.</issuerName><issuerTradingSymbol>META</issuerTradingSymbol></issuer><periodOfReport>2026-06-15</periodOfReport>
  <reportingOwner><reportingOwnerId><rptOwnerCik>0001736236</rptOwnerCik><rptOwnerName>Alford Peggy</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>0</isOfficer></reportingOwnerRelationship></reportingOwner>
  <nonDerivativeTable><nonDerivativeHolding><securityTitle><value>Class A Common Stock</value></securityTitle><postTransactionAmounts><sharesOwnedFollowingTransaction><value>4100</value></sharesOwnedFollowingTransaction></postTransactionAmounts><ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership><natureOfOwnership><value>By Trust</value></natureOfOwnership></ownershipNature></nonDerivativeHolding></nonDerivativeTable>
  <derivativeTable><derivativeTransaction><securityTitle><value>Restricted Stock Units (RSU) (Class A)</value></securityTitle><conversionOrExercisePrice><footnoteId id="F1"/></conversionOrExercisePrice><transactionDate><value>2026-06-15</value></transactionDate><transactionCoding><transactionFormType>4</transactionFormType><transactionCode>A</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>612</value></transactionShares><transactionPricePerShare><value>0</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts><expirationDate><footnoteId id="F2"/></expirationDate><underlyingSecurity><underlyingSecurityTitle><value>Class A Common Stock</value></underlyingSecurityTitle><underlyingSecurityShares><value>612</value></underlyingSecurityShares></underlyingSecurity><postTransactionAmounts><sharesOwnedFollowingTransaction><value>612</value></sharesOwnedFollowingTransaction></postTransactionAmounts><ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></derivativeTransaction></derivativeTable>
  <footnotes><footnote id="F1">RSUs convert one-for-one.</footnote></footnotes></ownershipDocument>`;
  const p = parseForm4(xml);
  ok(p.transactions.length === 0 && p.derivativeTransactions.length === 1 && p.derivativeCount === 1, "a derivative-only Form 4 yields a derivative row instead of nothing (11 of META's 41 filings were this shape)");
  const d = p.derivativeTransactions[0];
  ok(d.code === "A" && d.shares === 612 && d.underlying === "Class A Common Stock" && d.underlyingShares === 612 && d.ownedAfter === 612 && d.derivative === true, "derivative row carries code, units, underlying and owned-after");
  ok(d.expires === "" && d.exercisePrice === 0, "a footnote reference inside a value never leaks as XML text");
  ok(p.holdings.length === 1 && p.holdings[0].shares === 4100 && p.holdings[0].ownership === "I" && p.holdings[0].nature === "By Trust", "the holdings table (positions without a transaction) is read");
}

// ---- 13F cover + 13G cover + IPO classification -----------------------------
{
  const c = parse13fCover("<edgarSubmission><headerData><filerInfo><periodOfReport>03-31-2025</periodOfReport></filerInfo></headerData><formData><coverPage><isAmendment>true</isAmendment><amendmentNo>1</amendmentNo><amendmentInfo><amendmentType>NEW HOLDINGS</amendmentType></amendmentInfo></coverPage><summaryPage><otherIncludedManagersCount>2</otherIncludedManagersCount><tableEntryTotal>4</tableEntryTotal><tableValueTotal>1106550356</tableValueTotal><isConfidentialOmitted>false</isConfidentialOmitted></summaryPage></formData></edgarSubmission>");
  ok(c.isAmendment && c.amendmentType === "NEW HOLDINGS" && c.tableEntryTotal === 4 && c.tableValueTotal === 1106550356 && c.isConfidentialOmitted === false, "13F-HR/A cover: amendment type + totals (Berkshire 2025-08-14)");
  ok(parse13fCover("<x><isConfidentialOmitted>true</isConfidentialOmitted><tableEntryTotal>110</tableEntryTotal></x>").isConfidentialOmitted === true, "original cover with confidential treatment is flagged");
  const g = parse13GCover("<edgarSubmission><headerData><issuerInfo><issuerCik>0000050863</issuerCik><issuerName>Intel Corp</issuerName><issuerCusipNumber>458140100</issuerCusipNumber></issuerInfo><submissionType>SCHEDULE 13G/A</submissionType></headerData><formData><coverPageHeader><securitiesClassTitle>Common Stock</securitiesClassTitle><eventDateRequiresFilingThisStatement>03/13/2026</eventDateRequiresFilingThisStatement><designateRulePursuantThisScheduleFiled>Rule 13d-1(b)</designateRulePursuantThisScheduleFiled></coverPageHeader><coverPageHeaderReportingPersonDetails><reportingPersonName>The Vanguard Group</reportingPersonName><reportingPersonBeneficiallyOwnedAggregateNumberOfShares>0</reportingPersonBeneficiallyOwnedAggregateNumberOfShares><classPercent>0</classPercent><typeOfReportingPerson>IA</typeOfReportingPerson></coverPageHeaderReportingPersonDetails></formData></edgarSubmission>");
  ok(g.filer === "The Vanguard Group" && g.shares === 0 && g.percent === 0 && g.eventDate === "03/13/2026" && g.issuerCik === "0000050863" && g.form === "SCHEDULE 13G/A", "13G/A cover: filer, shares, percent, event date, issuer (Vanguard reporting it fell below 5% of INTC)");
  const pub = { sic: "3674", filings: { recent: { form: ["10-Q", "8-K", "10-K"], filingDate: ["2026-05-01", "2026-04-02", "2026-02-01"] } } };
  ok(classifyFromSubmissions(pub, "2026-08-20").klass === "follow-on", "a filer with periodic reports on file BEFORE the filing is already public (follow-on / resale, not an IPO)");
  ok(classifyFromSubmissions({ sic: "1234", filings: { recent: { form: ["S-1", "S-1/A"], filingDate: ["2026-08-20", "2026-08-01"] } } }, "2026-08-20").klass === "ipo", "a filer with no periodic report before the filing is a first-time registrant (IPO)");
  ok(classifyFromSubmissions({ sic: "6770", filings: { recent: { form: [], filingDate: [] } } }, "2026-08-20").klass === "spac", "SIC 6770 is a blank-check company");
  ok(classifyFromSubmissions({ sic: "1234", filings: { recent: { form: ["10-Q"], filingDate: ["2026-09-01"] } } }, "2026-08-20").klass === "ipo", "a periodic report filed AFTER the S-1 (the company listed since) does not make the S-1 a follow-on");
  ok(classifyFromSubmissions(null, "2026-08-20").klass === "unclassified", "unreadable submissions -> unclassified, never guessed");
}

// ---- token-risk control plane + research citation audit (round 3) ----------
{
  const g = shapeGoPlus({ is_open_source: "1", is_proxy: "0", is_mintable: "0", is_honeypot: "0", owner_address: "0x0000000000000000000000000000000000000000", hidden_owner: "0", buy_tax: "0.05", sell_tax: "0", transfer_pausable: "1", is_blacklisted: "0", lp_holder_count: "39", lp_holders: [{ address: "0xa", percent: "0.4", is_locked: 1 }, { address: "0xb", percent: "0.1", is_locked: 0 }], dex: [{ name: "UniswapV3", liquidity_type: "UniV3", liquidity: "120348.9", pair: "0xp" }], creator_percent: "0.02", fake_token: { value: 0 } });
  ok(g.proxy === false && g.mintable === false && g.honeypot === false && g.ownerRenounced === true && g.buyTaxPct === 5 && g.sellTaxPct === 0 && g.transferPausable === true, "GoPlus flags are typed booleans and taxes are percentages (BRETT-shaped record)");
  ok(g.lpLockedPct === 40 && g.lpHolderCount === 39 && g.dexes[0].liquidityUsd > 120000 && g.creatorPct === 2, "LP lock share is summed from locked LP holders; DEX liquidity and creator share ride along");
  ok(shapeGoPlus({ is_proxy: "", owner_address: "" }).proxy === null && shapeGoPlus({ is_proxy: "" }).ownerRenounced === null, "an absent flag is unknown, never false");
  const abi = [{ type: "function", name: "transfer", stateMutability: "nonpayable" }, { type: "function", name: "balanceOf", stateMutability: "view" }, { type: "function", name: "excludeFromFees", stateMutability: "nonpayable" }, { type: "function", name: "enableTrading" }, { type: "function", name: "upgradeTo" }, { type: "event", name: "Transfer" }];
  const pf = privilegedFunctions(abi);
  ok(pf.total === 5 && pf.writable === 4 && pf.privileged.join(",") === "enableTrading,excludeFromFees,upgradeTo", "privileged function names are read off the ABI (the owner privileges the prompt used to call invisible)");
  ok(privilegedFunctions(null).total === 0, "no ABI -> empty, never a claim");
  const src = [{ n: 1, title: "A", url: "https://a", snippet: "Revenue grew 23% to $1.2 billion in 2025." }, { n: 2, title: "B", url: "https://b", snippet: "no numbers here", body: "Gross margin was 41 percent in the quarter." }];
  const r = auditCitations("Revenue grew 23% to $1.2 billion [1]. Margin was 41% [2]. Users hit 5,000,000 [2]. Bogus [7] and range [1-2].", src, "");
  ok(r.cited.join(",") === "1,2" && r.stripped === 1 && !/\[7\]/.test(r.prose) && /\[1\]\[2\]/.test(r.prose), "citations outside the source range are stripped, ranges expand, and cited = the set actually used");
  ok(r.unverified.length === 1 && r.unverified[0].numbers.includes("5,000,000") && !r.unverified.some((u) => u.numbers.includes("41%")), "a number absent from the cited source's text is flagged; one present in its FULL TEXT is not");
  ok(auditCitations("Revenue grew 23% [1].", src, "sub-answer says 23% growth").unverified.length === 0, "a number supported by the sub-answers passes");
}
console.log(`${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
