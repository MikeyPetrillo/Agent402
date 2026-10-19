// parse13GCover reads the share count and percent from whichever cover tag
// the filing uses. An absent first tag falls through to the second, and a
// cover with neither reads as unknown (null), never as 0 shares or 0%, which
// would show a 5%+ holder as having fallen below 5%. Offline fixtures shaped
// like EDGAR primary_doc.xml covers.
import { parse13GCover } from "../src/tools/ticker-pack-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const modern = `<edgarSubmission><headerData><submissionType>SCHEDULE 13G</submissionType></headerData><formData><coverPageHeader><securitiesClassTitle>Common Stock</securitiesClassTitle><eventDateRequiresFilingThisStatement>09/30/2026</eventDateRequiresFilingThisStatement><issuerInfo><issuerCik>0000050863</issuerCik><issuerCusipNumber>458140100</issuerCusipNumber></issuerInfo></coverPageHeader><coverPageHeaderReportingPersonDetails><reportingPersonName>Example Advisers LP</reportingPersonName><reportingPersonBeneficiallyOwnedAggregateNumberOfShares>312,450,118</reportingPersonBeneficiallyOwnedAggregateNumberOfShares><classPercent>7.2</classPercent><typeOfReportingPerson>IA</typeOfReportingPerson></coverPageHeaderReportingPersonDetails></formData></edgarSubmission>`;
const m = parse13GCover(modern);
ok(m.shares === 312450118 && m.percent === 7.2, `first tag read (${m.shares}, ${m.percent})`);

const alt = `<edgarSubmission><headerData><submissionType>SCHEDULE 13D</submissionType></headerData><formData><coverPageHeader><issuerInfo><issuerCik>50863</issuerCik></issuerInfo></coverPageHeader><reportingPersons><reportingPersonInfo><reportingPersonName>Example Holdings LLC</reportingPersonName><aggregateAmountBeneficiallyOwned>48,000,000</aggregateAmountBeneficiallyOwned><percentOfClass>11.0</percentOfClass></reportingPersonInfo></reportingPersons></formData></edgarSubmission>`;
const a = parse13GCover(alt);
ok(a.shares === 48000000, `the second share tag is read when the first is absent (got ${a.shares})`);
ok(a.percent === 11, `the second percent tag is read when the first is absent (got ${a.percent})`);

const empty = `<edgarSubmission><formData><reportingPersonName>Example Fund</reportingPersonName><reportingPersonBeneficiallyOwnedAggregateNumberOfShares></reportingPersonBeneficiallyOwnedAggregateNumberOfShares><aggregateAmountBeneficiallyOwned>1,200,000</aggregateAmountBeneficiallyOwned></formData></edgarSubmission>`;
ok(parse13GCover(empty).shares === 1200000, "an empty first tag falls through to the second");

const none = `<edgarSubmission><formData><reportingPersonName>Example Fund</reportingPersonName></formData></edgarSubmission>`;
const n = parse13GCover(none);
ok(n.shares === null && n.percent === null, `no share or percent tag reads as unknown, not 0 (got ${n.shares}, ${n.percent})`);

const below = `<edgarSubmission><formData><reportingPersonName>Example Fund</reportingPersonName><reportingPersonBeneficiallyOwnedAggregateNumberOfShares>0</reportingPersonBeneficiallyOwnedAggregateNumberOfShares><classPercent>0</classPercent></formData></edgarSubmission>`;
const b = parse13GCover(below);
ok(b.shares === 0 && b.percent === 0, "a disclosed 0 (fell below 5%) stays 0");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
