// The IPO filings tool lists each filing once. Its pages are offset reads of
// a window that ends today, and a filing that lands between two reads shifts
// the next page by one, repeating the boundary filing; a filing whose several
// documents match would also repeat. Offline hits shaped like efts.sec.gov.
import { dedupeByAccession } from "../src/tools/edgar-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const hit = (adsh, doc, fileType = "S-1") => ({ _id: `${adsh}:${doc}`, _source: { adsh, form: "S-1", file_type: fileType, ciks: ["0001999888"], file_date: "2026-10-01" } });

const page1 = Array.from({ length: 100 }, (_, i) => hit(`0001213900-26-${String(1000 + i).padStart(6, "0")}`, "s1.htm"));
// A new filing arrived before page 2 was read: page 2 starts with page 1's last hit.
const page2 = [page1[99], ...Array.from({ length: 99 }, (_, i) => hit(`0001213900-26-${String(2000 + i).padStart(6, "0")}`, "s1.htm"))];
const merged = dedupeByAccession(page1.concat(page2));
ok(merged.length === 199, `the repeated boundary filing is listed once (got ${merged.length})`);
ok(new Set(merged.map((h) => h._source.adsh)).size === merged.length, "every accession appears once");
const docs = dedupeByAccession([hit("0001213900-26-000001", "s1.htm"), hit("0001213900-26-000001", "ex99-1.htm", "EX-99.1"), hit("0001213900-26-000002", "s1.htm")]);
ok(docs.length === 2 && docs[0]._id.endsWith("s1.htm"), "several documents of one filing list the filing once, first hit kept");
const noAdsh = dedupeByAccession([{ _id: "0001-26-1:a.htm", _source: {} }, { _id: "0001-26-1:b.htm", _source: {} }]);
ok(noAdsh.length === 1, "the accession is read from _id when _source has none");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
