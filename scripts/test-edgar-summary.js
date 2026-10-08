// src/edgar-summary.js: the company-specific content on the free SEC filing
// pages. Offline: every EDGAR read is a stub. Proves the figures are read, not
// made up: only 10-K full-year values count, a restatement wins, a revenue tag
// the company stopped using is passed over for a current one, a missing concept
// is left out (never zero), a throttled read marks the page partial, offering
// paperwork does not bury the filings a reader wants, and every sentence uses
// only numbers that came from the input.
import {
  annualSeries, keyFinancials, filingActivity, dossierNarrative, insiderSummary, insiderNarrative, fundNarrative,
  fmtMoney, fiscalYearEndText, stateName, filingUrl, REVENUE_TAGS,
} from "../src/edgar-summary.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const NOW = Date.parse("2026-10-08T12:00:00Z");
const yearBefore = (end) => new Date(Date.parse(end) - 364 * 86_400_000).toISOString().slice(0, 10);
const fy = (end, val, filed, extra = {}) => ({ start: yearBefore(end), end, val, form: "10-K", fp: "FY", filed, accn: `a-${filed}`, ...extra });
const concept = (rows) => ({ units: { USD: rows } });

// --- formatting
ok(fmtMoney(1.81e12) === "$1.81T" && fmtMoney(58.3e9) === "$58.3B" && fmtMoney(102e6) === "$102M" && fmtMoney(-7.5e6) === "-$7.5M" && fmtMoney(NaN) === "", "fmtMoney scales to T/B/M and keeps the sign");
ok(fiscalYearEndText("0930") === "September 30" && fiscalYearEndText("1399") === "" && fiscalYearEndText(null) === "", "fiscal year end reads as a date, junk reads as nothing");
ok(stateName("DE") === "Delaware" && stateName("zz") === "", "state codes map to names; unknown codes stay unnamed");
ok(filingUrl("0000886982", "0000886982-26-000091", "gs-10k.htm") === "https://www.sec.gov/Archives/edgar/data/886982/000088698226000091/gs-10k.htm", "filing links point at the document on sec.gov");

// --- annualSeries
{
  const s = annualSeries(concept([
    { ...fy("2025-12-31", 25, "2026-03-01"), start: "2025-10-01" },  // a quarter inside a later 10-K/A-style filing: must not count
    fy("2025-12-31", 100, "2026-02-20"),
    fy("2024-12-31", 90, "2025-02-20"),
    fy("2024-12-31", 91, "2026-02-20"),            // restated in the later 10-K
    { ...fy("2025-06-30", 50, "2025-08-01"), form: "10-Q", fp: "Q2" },
  ]));
  ok(s.length === 2 && s[0].end === "2025-12-31" && s[0].val === 100, "only full-year 10-K values count, newest first");
  ok(s[1].val === 91, "when two 10-Ks report the same year, the later one (the restatement) wins");
  const inst = annualSeries(concept([{ end: "2025-12-31", val: 5, form: "10-K", fp: "FY", filed: "2026-02-20" }]), { instant: true });
  ok(inst.length === 1 && inst[0].val === 5, "an instant concept (assets) needs no start date");
  ok(annualSeries(null).length === 0 && annualSeries({}).length === 0, "an empty or missing concept yields nothing");
}

// --- keyFinancials
{
  const reads = [];
  const data = {
    RevenueFromContractWithCustomerExcludingAssessedTax: null,                                  // not reported
    Revenues: concept([fy("2020-12-31", 10, "2021-02-01")]),                                     // stale tag
    RevenuesNetOfInterestExpense: concept([fy("2025-12-31", 200, "2026-02-20"), fy("2024-12-31", 160, "2025-02-20")]),
    NetIncomeLoss: concept([fy("2025-12-31", -5, "2026-02-20"), fy("2024-12-31", 3, "2025-02-20")]),
    Assets: concept([{ end: "2025-12-31", val: 900, form: "10-K", fp: "FY", filed: "2026-02-20" }]),
  };
  const getJson = async (url) => {
    const tag = url.split("/").pop().replace(".json", "");
    reads.push(tag);
    if (!data[tag]) throw Object.assign(new Error("404"), { statusCode: 422, upstreamStatus: 404 });
    return data[tag];
  };
  const f = await keyFinancials("0000000042", getJson, { now: NOW });
  ok(f.revenueTag === "RevenuesNetOfInterestExpense" && f.rows[0].revenue === 200, `a stale revenue tag is passed over for a current one (picked ${f.revenueTag})`);
  ok(f.rows[0].netIncome === -5 && f.rows[0].assets === 900 && f.rows[1].revenue === 160 && f.rows[1].assets === null, "figures line up by fiscal year; a year with no assets figure reads null, never zero");
  ok(f.partial === false && f.stale === false, "404s are 'not reported', not a partial read");
  ok(reads.length <= REVENUE_TAGS.length + 2, `reads are bounded (${reads.length})`);
  ok(!reads.includes("SalesRevenueNet"), "the revenue search stops at the first current tag");

  const throttled = await keyFinancials("0000000042", async () => { throw Object.assign(new Error("403"), { statusCode: 422, upstreamStatus: 403 }); }, { now: NOW });
  ok(throttled.partial === true && throttled.rows.length === 0, "a throttled read marks the result partial (cached briefly), with no figures");

  const old = await keyFinancials("1", async (url) => (url.includes("NetIncomeLoss") ? concept([fy("2022-12-31", 1, "2023-02-01")]) : (() => { throw Object.assign(new Error("404"), { upstreamStatus: 404 }); })()), { now: NOW });
  ok(old.stale === true, "figures older than about 18 months are flagged stale");
}

// --- filingActivity
{
  const SUB = { filings: { recent: {
    form: ["424B2", "FWP", "8-K", "4", "10-Q", "8-K", "10-K", "8-K"],
    filingDate: ["2026-10-07", "2026-10-06", "2026-08-01", "2026-07-15", "2026-07-31", "2026-02-10", "2026-02-20", "2025-09-01"],
    reportDate: ["", "", "2026-08-01", "", "2026-06-30", "2026-02-10", "2025-12-31", "2025-09-01"],
    accessionNumber: ["n1", "n2", "a1", "a2", "a3", "a4", "a5", "a6"],
    primaryDocument: ["p.htm", "f.htm", "e.htm", "x.xml", "q.htm", "e2.htm", "k.htm", "old.htm"],
    primaryDocDescription: ["", "", "8-K", "", "10-Q", "8-K", "10-K", "8-K"],
    items: ["", "", "2.02,9.01", "", "", "5.02,2.02", "", "1.01"],
  } } };
  const a = filingActivity(SUB, "0000000042", { now: NOW });
  ok(a.total === 7 && a.since === "2025-10-08", `twelve-month window counts filings since ${a.since} (got ${a.total}; the 2025-09-01 8-K is outside)`);
  ok(a.offeringNoise === 2 && a.recent.every((r) => r.form !== "424B2" && r.form !== "FWP"), "prospectus supplements are counted but kept out of the recent-filings list");
  const items = Object.fromEntries(a.eightKItems.map((x) => [x.item, x.n]));
  ok(items["2.02"] === 2 && items["5.02"] === 1 && !("9.01" in items) && !("1.01" in items), "8-K reasons are counted inside the window, exhibits (9.01) excluded");
  ok(a.recent[0].form === "8-K" && a.recent[0].url.endsWith("/a1/e.htm"), "recent filings link to their documents");
}

// --- narratives use only the input's numbers
{
  const d = {
    name: "Example Corp", tickers: ["EXMP", "EXMP"], exchanges: ["Nasdaq", "Nasdaq"], category: "Large accelerated filer",
    stateOfIncorporation: "DE", sic: "3571", industry: "Electronic Computers", fiscalYearEnd: "0930", formerNames: [{ name: "Example Computer Inc" }],
    financials: { rows: [{ end: "2025-09-27", revenue: 400e9, netIncome: -2e9, assets: 350e9 }, { end: "2024-09-28", revenue: 380e9, netIncome: 90e9, assets: null }] },
    asOf: "2026-10-08",
    activity: { total: 120, offeringNoise: 0, byForm: [{ form: "4", n: 80 }, { form: "8-K", n: 9 }, { form: "10-Q", n: 3 }, { form: "10-K", n: 1 }], eightKItems: [{ item: "2.02", n: 4, label: "results of operations" }] },
  };
  const t = dossierNarrative(d).join(" ");
  ok(/Example Corp \(EXMP\) is a large accelerated filer incorporated in Delaware/.test(t) && /lists on Nasdaq\./.test(t), "identity sentence dedupes tickers and exchanges");
  ok(/revenue of \$400B, up 5\.3% from the year before/.test(t) && /a net loss of \$2\.0B/.test(t) && /total assets of \$350B/.test(t), "results sentence carries the reported figures, the change, and a loss as a loss");
  ok(/1 annual report, 3 quarterly reports, 9 current reports on Form 8-K, and 80 Form 4 insider filings/.test(t), "activity sentence leads with the forms a reader looks for");
  ok(/results of operations \(4\)/.test(t) && /also filed as Example Computer Inc/.test(t), "8-K reasons and former names are stated");
  const bare = dossierNarrative({ name: "Bare Inc", tickers: [], exchanges: [], financials: { rows: [] }, activity: { total: 0 } }).join(" ");
  ok(bare === "Bare Inc is an SEC registrant." , `with nothing reported, nothing is invented (got: ${bare})`);
}
{
  const rows = [
    { insider: "Doe Jane", role: "CFO", code: "S", shares: 1000, price: 50 },
    { insider: "Doe Jane", role: "CFO", code: "S", shares: 500, price: 52 },
    { insider: "Roe Rich", role: "director", code: "P", shares: 100, price: 49 },
    { insider: "Poe Pat", role: "officer", code: "A", shares: 9999, price: 0 },
  ];
  const s = insiderSummary(rows);
  ok(s.sells.lines === 2 && s.sells.shares === 1500 && s.sells.value === 76000 && s.buys.value === 4900 && s.insiders === 3, "insider totals are shares times price on open-market lines only");
  ok(s.top.insider === "Doe Jane" && s.top.sold === 76000, "the largest insider is ranked by open-market value");
  const t = insiderNarrative("Example Corp", "EXMP", { rows, filingsRead: 3, filingsInWindow: 9, windowDays: 90, endDate: "2026-10-08" }, s).join(" ");
  ok(/2 open-market sales of 1,500 shares worth about \$76,000/.test(t) && /1 open-market purchase of 100 shares worth about \$4,900/.test(t) && /9 Form 4 filings were made/.test(t), "insider sentences carry the computed totals");
  ok(insiderNarrative("X", "X", { rows: [], filingsRead: 0 }, insiderSummary([])).length === 0, "no rows, no insider sentences");
}
{
  const data = { holdingsAvailable: true, reportDate: "2026-06-30", totalValueUsd: 1000, totalHoldings: 5, holdings: [{ issuer: "ALPHA", weight: 0.5 }, { issuer: "BETA", weight: 0.3 }] };
  const t = fundNarrative("Example Capital", data).join(" ");
  ok(/largest reported position at June 30, 2026 was ALPHA at 50\.0% of the \$1,000 it reported, followed by BETA \(30\.0%\)/.test(t) && /make up 80\.0% of reported value across 5 positions/.test(t), "fund sentences carry the weights from the table");
  ok(fundNarrative("X", { holdingsAvailable: false }).length === 0, "no holdings, no fund sentences");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
