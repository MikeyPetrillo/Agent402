// filing-watch's form filter reads past the newest 250 filings: with a filter
// it asks for every row of the index's recent block and then reads the older
// submissions files the index names, newest first, until it has `limit`
// matches (or a days window ends). Without a filter the probe reads exactly as
// before. ticker-pack's submissions reader passes the older file names on.
// Offline: the readers are injected with data shaped like EDGAR's
// submissions JSON (columnar arrays) and its older files.
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
dnsPromises.lookup = async () => ({ address: "1.1.1.1", family: 4 });
syncBuiltinESMExports();
const { probeCompanyFilings, FORM_FILTER_SCAN_ROWS, MAX_OLDER_FILES } = await import("../src/tools/filing-watch-kit.js");
const { probeCompanyFilings: readIndex } = await import("../src/tools/ticker-pack-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const CIK = "0000123456";
const day = (n) => new Date(Date.UTC(2026, 9, 19) - n * 86400_000).toISOString().slice(0, 10);
const acc = (n) => `0000123456-26-${String(n).padStart(6, "0")}`;
// Recent block: 1000 rows, all Form 4 except one 10-K at row 900.
const recent = Array.from({ length: 1000 }, (_, i) => ({ form: i === 900 ? "10-K" : "4", filed: day(i), accession: acc(i), url: `https://www.sec.gov/x/${i}` }));
// Older files (columnar), newest first: each holds one 10-K and many Form 4s.
const columns = (rows) => ({
  accessionNumber: rows.map((r) => r.accession), filingDate: rows.map((r) => r.filed), reportDate: rows.map(() => ""),
  form: rows.map((r) => r.form), primaryDocument: rows.map((r, i) => `doc${i}.htm`), primaryDocDescription: rows.map(() => ""), items: rows.map(() => ""),
});
const olderRows = (k) => Array.from({ length: 300 }, (_, i) => ({ form: i === 10 ? "10-K" : "4", filed: day(1000 + k * 300 + i), accession: acc(1000 + k * 300 + i) }));
const olderFiles = Array.from({ length: 6 }, (_, k) => ({ name: `CIK${CIK}-submissions-${String(k + 1).padStart(3, "0")}.json`, filingFrom: day(1000 + k * 300 + 299), filingTo: day(1000 + k * 300) }));

let subArgs = [], olderReads = [];
const deps = {
  resolve: async () => ({ cik: CIK, name: "Example Corp" }),
  readSubmissions: async (args) => { subArgs.push(args); return { name: "Example Corp", filings: recent.slice(0, args.limit), olderFiles }; },
  readOlderFile: async (name) => { olderReads.push(name); const k = parseInt(name.slice(-8, -5), 10) - 1; return columns(olderRows(k)); },
};

// A 10-K filter: one match in the recent block (row 900, beyond the newest 250),
// then one per older file.
{
  subArgs = []; olderReads = [];
  const r = await probeCompanyFilings({ cik: CIK }, { ...deps, forms: ["10-K"], limit: 3 });
  ok(subArgs[0].limit === FORM_FILTER_SCAN_ROWS, `a form filter reads the whole recent block (asked for ${subArgs[0].limit} rows)`);
  ok(r.filings[0]?.accession === acc(900), "the match beyond the newest 250 rows is found");
  ok(r.filings.length === 3 && r.filings.every((f) => f.form === "10-K"), `older files fill the filter to its limit (${r.filings.length})`);
  ok(olderReads.length === 2 && olderReads[0].endsWith("-001.json"), `older files are read newest first and only as needed (${olderReads.join(",")})`);
  ok(!!r.filings[1]?.url?.startsWith("https://www.sec.gov/Archives/edgar/data/123456/"), "an older file's row gets its document URL");
  ok(r.olderFilesRead === 2, "the answer says how many older files were read");
}

// The older-file reads are bounded.
{
  olderReads = [];
  const r = await probeCompanyFilings({ cik: CIK }, { ...deps, forms: ["10-K"], limit: 40 });
  ok(olderReads.length === MAX_OLDER_FILES && r.filings.length === 1 + MAX_OLDER_FILES, `at most ${MAX_OLDER_FILES} older files are read (${olderReads.length})`);
}

// A days window stops before older files outside it.
{
  olderReads = [];
  const r = await probeCompanyFilings({ cik: CIK }, { ...deps, forms: ["8-K"], limit: 5, days: 30 });
  ok(olderReads.length === 0 && r.filings.length === 0, "a days window that ends inside the recent block reads no older file");
}

// No filter: the read is the same size as before and no older file is read.
{
  subArgs = []; olderReads = [];
  const r = await probeCompanyFilings({ cik: CIK }, { ...deps, limit: 40 });
  ok(subArgs[0].limit === 250 && olderReads.length === 0 && r.filings.length === 40 && !("olderFilesRead" in r), "without a form filter the probe reads 250 rows and nothing older");
}

// ticker-pack's reader names the older files from the submissions JSON.
{
  globalThis.fetch = async () => new Response(JSON.stringify({
    name: "Example Corp", tickers: ["EXMP"],
    filings: { recent: columns(recent.slice(0, 3)), files: [{ name: `CIK${CIK}-submissions-001.json`, filingCount: 1000, filingFrom: "2001-01-01", filingTo: "2020-12-31" }, { name: "../evil.json" }] },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const idx = await readIndex({ cik: CIK, limit: 10 });
  ok(Array.isArray(idx.olderFiles) && idx.olderFiles.length === 1 && idx.olderFiles[0].name === `CIK${CIK}-submissions-001.json` && idx.olderFiles[0].filingTo === "2020-12-31", `the index reader passes older file names on, well-formed names only (${JSON.stringify(idx.olderFiles)})`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
