// 13F-HR/A amendments are applied in filing order, oldest first. The
// submissions list is newest first; applied in that order, a restatement
// filed before a NEW HOLDINGS amendment would wipe the added rows. Offline,
// rows shaped like parse13fInformationTable output.
import { apply13fAmendments } from "../src/tools/edgar-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const row = (name, valueUsd) => ({ nameOfIssuer: name, cusip: name.slice(0, 9).padEnd(9, "0"), valueUsd, shares: 1 });

const original = [row("ALPHA", 100), row("BETA", 50)];
// Newest first, as data.sec.gov submissions lists them.
const amendments = [
  { accessionNumber: "0000950123-25-000300", filedDate: "2025-08-14", amendmentType: "NEW HOLDINGS", rows: [row("DELTA", 30)] },
  { accessionNumber: "0000950123-25-000200", filedDate: "2025-06-02", amendmentType: "RESTATEMENT", rows: [row("ALPHA", 110), row("GAMMA", 40)] },
];
const r = apply13fAmendments(original, amendments);
const names = r.holdings.map((x) => x.nameOfIssuer).sort().join();
ok(names === "ALPHA,DELTA,GAMMA", `restatement first, then the later added holding (got ${names})`);
ok(r.holdings.find((x) => x.nameOfIssuer === "ALPHA").valueUsd === 110, "the restated value replaces the original");
ok(r.amendments.map((a) => a.filedDate).join() === "2025-06-02,2025-08-14" && r.amendments.every((a) => a.applied), "amendments are reported oldest first, all applied");

// Same date: accession order breaks the tie.
const tie = apply13fAmendments(original, [
  { accessionNumber: "0000950123-25-000002", filedDate: "2025-06-02", amendmentType: "NEW HOLDINGS", rows: [row("EPS", 5)] },
  { accessionNumber: "0000950123-25-000001", filedDate: "2025-06-02", amendmentType: "RESTATEMENT", rows: [row("ZETA", 9)] },
]);
ok(tie.holdings.map((x) => x.nameOfIssuer).join() === "ZETA,EPS", `same-day amendments apply in accession order (got ${tie.holdings.map((x) => x.nameOfIssuer)})`);

// An unreadable amendment is listed and not applied.
const un = apply13fAmendments(original, [{ accessionNumber: "a", filedDate: "2025-07-01", amendmentType: "NEW HOLDINGS", rows: null }]);
ok(un.holdings.length === 2 && un.amendments[0].applied === false && un.amendments[0].rows === null, "an unreadable amendment is reported, not applied");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
