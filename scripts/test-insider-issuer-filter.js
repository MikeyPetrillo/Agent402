// Insider reports list the Form 4 filings whose ISSUER is the company. The
// full-text search matches a CIK as any party, so a company that is itself a
// reporting owner (its trades in another issuer) comes back too; the hit
// lists owners first and the issuer last, and the filing XML names its
// issuer. Both the edgar-insider-trades tool and the insider report keep only
// the company's own issuer filings. Offline fixtures shaped like
// efts.sec.gov search-index hits and Form 4 XML.
import { eftsIssuerCik, issuerHits } from "../src/tools/edgar-kit.js";
import { form4FilingsFromHits, parseForm4 } from "../src/tools/insider-flow-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const CO = "0001067983";
const hit = (adsh, ciks, names) => ({ _id: `${adsh}:ownership.xml`, _source: { ciks, display_names: names, form: "4", root_forms: ["4"], adsh, file_date: "2025-10-01", file_num: ["001-00001"] } });
const hits = [
  hit("0000315090-25-000001", ["0000315090", CO], ["OWNER ONE  (CIK 0000315090)", "EXAMPLE HOLDINGS INC  (CIK 0001067983)"]),
  hit("0001193125-25-000002", ["0000315090", CO, "0000927066"], ["OWNER ONE  (CIK 0000315090)", "EXAMPLE HOLDINGS INC  (CIK 0001067983)", "OTHER ISSUER INC.  (CIK 0000927066)"]),
  hit("0001193125-25-000003", [CO, "0000070858"], ["EXAMPLE HOLDINGS INC  (CIK 0001067983)", "SECOND ISSUER CORP  (CIK 0000070858)"]),
  hit("0001728451-25-000004", ["0001728451", CO], ["OWNER TWO  (CIK 0001728451)", "EXAMPLE HOLDINGS INC  (CIK 0001067983)"]),
];
ok(eftsIssuerCik(hits[1]) === "0000927066", "the issuer is the last CIK of a hit");
const mine = issuerHits(hits, "1067983");
ok(mine.map((h) => h._source.adsh).join() === "0000315090-25-000001,0001728451-25-000004", `edgar-insider-trades keeps only filings where the company is the issuer (got ${mine.map((h) => h._source.adsh)})`);
const filings = form4FilingsFromHits(hits, CO, 40);
ok(filings.length === 2 && filings.every((f) => f.ownerCik !== CO), `the insider report probe lists the company's own issuer filings only (got ${filings.map((f) => f.accessionNumber)})`);
ok(filings[0].url === "https://www.sec.gov/Archives/edgar/data/315090/000031509025000001/ownership.xml", "the owner's archive path is kept for the XML read");

const xml = (issuerCik) => `<?xml version="1.0"?><ownershipDocument><issuer><issuerCik>${issuerCik}</issuerCik><issuerName>Example</issuerName><issuerTradingSymbol>EXH</issuerTradingSymbol></issuer><reportingOwner><reportingOwnerId><rptOwnerCik>0000315090</rptOwnerCik><rptOwnerName>OWNER ONE</rptOwnerName></reportingOwnerId></reportingOwner></ownershipDocument>`;
ok(parseForm4(xml("0001067983")).issuerCik === CO, "the Form 4 XML issuer CIK is read and padded");
ok(parseForm4(xml("927066")).issuerCik === "0000927066", "a short issuer CIK is padded");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
