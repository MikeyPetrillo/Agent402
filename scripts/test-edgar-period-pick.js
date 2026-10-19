// company-financials and the dossier's financial lines pick periods by their
// length: the quarterly value is a ~3-month row, not the year-to-date row a
// 10-Q also reports for the same end date; the annual value is a ~12-month
// 10-K row, not the quarter-length rows a 10-K also carries. A fallback tag
// that measures something else is labeled as what it is. Offline fixtures
// shaped like data.sec.gov companyfacts / companyconcept unit rows.
import { financialMetrics, pickLatestPeriods } from "../src/tools/edgar-kit.js";
import { pickDossierPeriods } from "../src/tools/dossier-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// A 10-Q for the quarter ending 2026-06-27 reports Q3 (3 months) and the
// nine-month year to date with the same end; the YTD row is listed first, as
// companyfacts often does. The 10-K reports the year and its Q4.
const rev = [
  { start: "2024-09-29", end: "2025-09-27", val: 400_000, fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-31" },
  { start: "2025-06-29", end: "2025-09-27", val: 100_000, fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-31" },
  { start: "2025-09-28", end: "2026-06-27", val: 310_000, fy: 2026, fp: "Q3", form: "10-Q", filed: "2026-08-01" },
  { start: "2026-03-29", end: "2026-06-27", val: 95_000, fy: 2026, fp: "Q3", form: "10-Q", filed: "2026-08-01" },
  { start: "2025-09-28", end: "2025-12-27", val: 120_000, fy: 2026, fp: "Q1", form: "10-Q", filed: "2026-01-30" },
];
const p = pickLatestPeriods(rev);
ok(p.quarterly?.val === 95_000, `10-Q pick is the 3-month quarter, not the 9-month YTD (got ${p.quarterly?.val})`);
ok(p.annual?.val === 400_000, `10-K pick is the 12-month year (got ${p.annual?.val})`);
// The annual row listed after a same-end Q4 row still wins.
ok(pickLatestPeriods([rev[1], rev[0]]).annual?.val === 400_000, "a 10-K's quarter-length row is never the annual value");

// Cash flow reported only year to date in 10-Qs: falls back, and says so.
const ocf = [
  { start: "2025-09-28", end: "2026-03-28", val: 60_000, form: "10-Q", fp: "Q2" },
  { start: "2025-09-28", end: "2026-06-27", val: 90_000, form: "10-Q", fp: "Q3" },
];
const facts = {
  Revenues: { units: { USD: rev } },
  NetCashProvidedByUsedInOperatingActivities: { units: { USD: ocf } },
  IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: { units: { USD: [{ start: "2024-09-29", end: "2025-09-27", val: 120, form: "10-K", fp: "FY" }] } },
  LiabilitiesCurrent: { units: { USD: [{ end: "2025-09-27", val: 70, form: "10-K", fp: "FY" }] } },
  Liabilities: undefined,
};
const m = Object.fromEntries(financialMetrics(facts).map((x) => [x.tag, x]));
ok(m.Revenues.latestQuarterly.value === 95_000 && m.Revenues.latestQuarterly.months === 3, `company-financials quarterly revenue is the quarter (got ${JSON.stringify(m.Revenues.latestQuarterly)})`);
ok(m.Revenues.latestAnnual.months === 12, "the annual value says it covers 12 months");
const cf = m.NetCashProvidedByUsedInOperatingActivities.latestQuarterly;
ok(cf && cf.value === 90_000 && cf.months === 9, `a YTD-only concept is labeled with its months (got ${JSON.stringify(cf)})`);
const pre = m.IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest;
ok(pre && pre.label !== "Operating Income" && /pre-tax/i.test(pre.label), `the pre-tax fallback is labeled pre-tax income (got ${pre?.label})`);
const cl = m.LiabilitiesCurrent;
ok(cl && cl.label !== "Total Liabilities" && /current liabilities/i.test(cl.label), `the current-liabilities fallback is labeled as such (got ${cl?.label})`);
const rv = financialMetrics({ Revenues: { units: { USD: rev } } }).find((x) => x.tag === "Revenues");
ok(rv.label === "Revenue", "a primary tag keeps its label");

// Dossier: the most recent figure is a quarter or an instant, never a YTD total.
const d = pickDossierPeriods(rev);
ok(d.latest?.val === 95_000, `dossier most recent is the 3-month quarter (got ${d.latest?.val})`);
ok(d.annual?.val === 400_000, `dossier latest annual is the 12-month row (got ${d.annual?.val})`);
const d2 = pickDossierPeriods([rev[3], rev[2], rev[0]]);
ok(d2.latest?.val === 95_000, `dossier most recent is the quarter whichever row comes last (got ${d2.latest?.val})`);
const inst = pickDossierPeriods([{ end: "2025-09-27", val: 5, form: "10-K", fp: "FY" }, { end: "2026-06-27", val: 6, form: "10-Q", fp: "Q3" }]);
ok(inst.annual?.val === 5 && inst.latest?.val === 6, "instant facts (balance sheet) still pick by end date");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
