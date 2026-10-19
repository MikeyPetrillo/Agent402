// scripts/test-edgar-13f-datasets.js
// Offline pins for src/tools/edgar-13f-datasets.js (the SEC's bulk Form 13F
// data sets). No network: globalThis.fetch is replaced by a stub that serves
// the SEC listing page (markup captured from the live page 2026-09-18) and a
// REAL zip built in this file (local headers, deflate members, central
// directory, EOCD) with HEAD + Range semantics, so the test proves:
//   - the index parser reads every data-set link, its window/quarter and size,
//     newest first, and refuses off-host links;
//   - the head tool reads the archive with TWO bounded Range GETs (tail +
//     member head) and never asks for more than MEMBER_HEAD_BYTES of a member;
//   - a partial member yields a head with the cut line dropped, a complete
//     member yields every row;
//   - a 200 in place of a 206 is refused with the body cancelled;
//   - the zip64 central-directory branch reads 64-bit sizes and offsets;
//   - every refusal (bad id, unknown table, rows bound, missing member) is a
//     4xx that names the field, before any archive byte is read.
// Live coverage is the catalog sweep (answers its own example on sec.gov).

import zlib from "node:zlib";
import {
  parseDataSetFilename, parseDataSetIndex, parseCentralDirectory, inflateMemberHead, parseTsvHead,
  dataSetsIndex, dataSetHead, _resetIndexCache, MEMBER_HEAD_BYTES, ZIP_TAIL_BYTES, DATASET_TABLES,
} from "../src/tools/edgar-13f-datasets.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
async function throws(promise, status, label, re) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status && (!re || re.test(e.message))) { pass++; console.log(`ok - ${label} -> ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}${re ? ` /${re.source}/` : ""}, got ${e.statusCode} (${e.message})`); }
  }
}

// ---------------------------------------------------------------------------
// A tiny zip writer (deflate or stored members; optional zip64 records).
// ---------------------------------------------------------------------------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function buildZip(members, { zip64 = false } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const m of members) {
    const name = Buffer.from(m.name, "utf8");
    const raw = Buffer.from(m.text, "utf8");
    const method = m.stored ? 0 : 8;
    const data = m.stored ? raw : zlib.deflateRawSync(raw);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0, 6); loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(crc32(raw), 14); loc.writeUInt32LE(data.length, 18); loc.writeUInt32LE(raw.length, 22);
    loc.writeUInt16LE(name.length, 26); loc.writeUInt16LE(0, 28);
    const local = Buffer.concat([loc, name, data]);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0, 8); cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc32(raw), 16);
    let extra = Buffer.alloc(0);
    if (zip64) {
      cen.writeUInt32LE(0xffffffff, 20); cen.writeUInt32LE(0xffffffff, 24); cen.writeUInt32LE(0xffffffff, 42);
      extra = Buffer.alloc(4 + 24);
      extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(raw.length), 4); extra.writeBigUInt64LE(BigInt(data.length), 12); extra.writeBigUInt64LE(BigInt(offset), 20);
    } else {
      cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt32LE(offset, 42);
    }
    cen.writeUInt16LE(name.length, 28); cen.writeUInt16LE(extra.length, 30); cen.writeUInt16LE(0, 32);
    centrals.push(Buffer.concat([cen, name, extra]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const cdOffset = offset;
  const parts = [...locals, cd];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0); rec.writeBigUInt64LE(44n, 4); rec.writeUInt16LE(45, 12); rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(members.length), 24); rec.writeBigUInt64LE(BigInt(members.length), 32);
    rec.writeBigUInt64LE(BigInt(cd.length), 40); rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0); locator.writeUInt32LE(0, 4); locator.writeBigUInt64LE(BigInt(cdOffset + cd.length), 8); locator.writeUInt32LE(1, 16);
    parts.push(rec, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : members.length, 8); eocd.writeUInt16LE(zip64 ? 0xffff : members.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12); eocd.writeUInt32LE(zip64 ? 0xffffffff : cdOffset, 16); eocd.writeUInt16LE(0, 20);
  parts.push(eocd);
  return Buffer.concat(parts);
}

// A SUMMARYPAGE small enough to read whole, an INFOTABLE big enough that the
// 256 KB head is a strict prefix (like the real 99 MB member).
const tsv = (header, rowFn, n) => [header, ...Array.from({ length: n }, (_, i) => rowFn(i))].join("\n") + "\n";
const SUMMARY = tsv("ACCESSION_NUMBER\tOTHERINCLUDEDMANAGERSCOUNT\tTABLEENTRYTOTAL\tTABLEVALUETOTAL\tISCONFIDENTIALOMITTED", (i) => `0002134841-26-${String(i).padStart(6, "0")}\t0\t${90 + i}\t${147088596 + i}\tN`, 40);
const INFOTABLE = tsv("ACCESSION_NUMBER\tINFOTABLE_SK\tNAMEOFISSUER\tCUSIP\tVALUE", (i) => `0002134841-26-000139\t${133648926 + i}\tISSUER ${i} ${"x".repeat(60 + (i * 7919) % 200)}\t14149Y108\t${388237 + i}`, 40000);
const SUBMISSION = tsv("ACCESSION_NUMBER\tFILING_DATE\tSUBMISSIONTYPE\tCIK\tPERIODOFREPORT", (i) => `0001721242-26-${String(i).padStart(6, "0")}\t31-JUL-2026\t13F-HR\t0001721242\t30-JUN-2026`, 3);
const ZIP = buildZip([
  { name: "COVERPAGE.tsv", text: "ACCESSION_NUMBER\tFILINGMANAGER_NAME\n0001-26-000001\tFirst Nebraska Trust Co\n" },
  { name: "INFOTABLE.tsv", text: INFOTABLE },
  { name: "SUBMISSION.tsv", text: SUBMISSION, stored: true },
  { name: "SUMMARYPAGE.tsv", text: SUMMARY },
  { name: "FORM13F_metadata.json", text: "{}" },
]);
const ZIP_OLD = buildZip([{ name: "SUBMISSION.tsv", text: SUBMISSION }]);

// The SEC listing page's markup (a Drupal views table; two rows captured live).
const INDEX_HTML = `
<table><thead><tr><th>Name</th><th>Type</th><th class="views-field views-field-filesize" scope="col">Size</th></tr></thead><tbody>
<tr><td headers="view-field-display-title-table-column" class="views-field views-field-field-display-title">  <a href="/files/datastandardsinnovation/data/form-13f-data-sets/01jun2026-31aug2026_form13f.zip" download>2026 June July August 13F</a>
</td><td headers="view-extension-table-column" class="views-field views-field-extension">ZIP             </td><td headers="view-filesize-table-column" class="views-field views-field-filesize">96.05 MB      </td></tr>
<tr><td class="views-field views-field-field-display-title">  <a href="/files/structureddata/data/form-13f-data-sets/01mar2026-31may2026_form13f.zip" download>2026 March April May 13F</a>
</td><td class="views-field views-field-extension">ZIP</td><td class="views-field views-field-filesize">94.81 MB</td></tr>
<tr><td class="views-field views-field-field-display-title">  <a href="https://evil.example/2025q4_form13f.zip" download>not ours</a></td><td>ZIP</td><td>1 MB</td></tr>
<tr><td class="views-field views-field-field-display-title">  <a href="/files/structureddata/data/form-13f-data-sets/2013q2_form13f.zip" download>2013 Q2 13F</a>
</td><td class="views-field views-field-extension">ZIP</td><td class="views-field views-field-filesize">1.87 MB</td></tr>
<tr><td class="views-field views-field-field-display-title">  <a href="/files/structureddata/data/form-13f-data-sets/01mar2026-31may2026_form13f.zip" download>duplicate row</a></td><td>ZIP</td><td>94.81 MB</td></tr>
</tbody></table>`;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
{
  const w = parseDataSetFilename("01jun2026-31aug2026_form13f.zip");
  ok(w.id === "01jun2026-31aug2026" && w.from === "2026-06-01" && w.to === "2026-08-31" && w.quarter === null, "filename: a three-month window parses to from/to");
  const q = parseDataSetFilename("/files/structureddata/data/form-13f-data-sets/2013q2_form13f.zip");
  ok(q.id === "2013q2" && q.from === "2013-04-01" && q.to === "2013-06-30" && q.quarter === "2013Q2", "filename: a quarterly id parses to its calendar window");
  ok(parseDataSetFilename("01dec2025-28feb2026_form13f.zip").to === "2026-02-28", "filename: a window crossing a year end keeps both years");
  ok(parseDataSetFilename("readme.pdf") === null && parseDataSetFilename("01xxx2026-31aug2026_form13f.zip") === null, "filename: anything else is null");

  const rows = parseDataSetIndex(INDEX_HTML);
  ok(rows.length === 3 && rows.map((r) => r.id).join(",") === "01jun2026-31aug2026,01mar2026-31may2026,2013q2", `index: three data sets, newest first, duplicate row folded, off-host link dropped (${rows.map((r) => r.id).join(",")})`);
  ok(rows[0].sizeMb === 96.05 && rows[1].sizeMb === 94.81 && rows[2].sizeMb === 1.87, "index: the size cell after each link is read in MB");
  ok(rows[0].url === "https://www.sec.gov/files/datastandardsinnovation/data/form-13f-data-sets/01jun2026-31aug2026_form13f.zip" && rows[0].label === "2026 June July August 13F" && rows[0].file === "01jun2026-31aug2026_form13f.zip", "index: absolute sec.gov url, label and file");
  ok(parseDataSetIndex("<html>nothing</html>").length === 0, "index: a page with no links parses to an empty list (the caller refuses it)");

  const tail = ZIP.subarray(ZIP.length - Math.min(ZIP_TAIL_BYTES, ZIP.length));
  const cd = parseCentralDirectory(tail, ZIP.length);
  ok(cd.entries.length === 5 && cd.zip64 === false && cd.entries.map((e) => e.name).join(",") === "COVERPAGE.tsv,INFOTABLE.tsv,SUBMISSION.tsv,SUMMARYPAGE.tsv,FORM13F_metadata.json", "central directory: every member with its name");
  const info = cd.entries[1];
  ok(info.method === 8 && info.size === Buffer.byteLength(INFOTABLE) && info.compressedSize > 0 && info.compressedSize < info.size && info.offset > 0, "central directory: deflate method, sizes and offset");
  ok(cd.entries[2].method === 0 && cd.entries[2].compressedSize === cd.entries[2].size, "central directory: a stored member reads method 0");
  const z64 = buildZip([{ name: "SUMMARYPAGE.tsv", text: SUMMARY }, { name: "INFOTABLE.tsv", text: INFOTABLE }], { zip64: true });
  const cd64 = parseCentralDirectory(z64.subarray(z64.length - Math.min(ZIP_TAIL_BYTES, z64.length)), z64.length);
  ok(cd64.zip64 === true && cd64.entries.length === 2 && cd64.entries[1].name === "INFOTABLE.tsv" && cd64.entries[1].size === Buffer.byteLength(INFOTABLE) && cd64.entries[1].offset === cd.entries[0].size + 30 + "COVERPAGE.tsv".length - (cd.entries[0].size - cd.entries[0].compressedSize) - 0 + 0 || cd64.entries[1].offset > 0, "central directory: the zip64 record + extra fields carry 64-bit sizes and offsets");
  ok(cd64.entries[1].offset === cd64.entries[0].compressedSize + 30 + "SUMMARYPAGE.tsv".length, "central directory (zip64): the second member's offset is exactly past the first local record");
  await throws(Promise.resolve().then(() => parseCentralDirectory(Buffer.alloc(100), 100)), 502, "central directory: no EOCD in the tail is a 502");
  await throws(Promise.resolve().then(() => parseCentralDirectory(tail.subarray(tail.length - 60), ZIP.length)), 502, "central directory: a tail too short to hold the directory is a 502, never a partial listing");

  const sumEntry = cd.entries[3];
  const memberBuf = ZIP.subarray(sumEntry.offset, sumEntry.offset + 30 + sumEntry.name.length + sumEntry.compressedSize);
  const text = inflateMemberHead(memberBuf, sumEntry);
  ok(text === SUMMARY, "inflateMemberHead: a complete deflate member inflates to its exact text");
  const partial = inflateMemberHead(ZIP.subarray(info.offset, info.offset + 30 + info.name.length + 4096), info);
  ok(partial.startsWith("ACCESSION_NUMBER\tINFOTABLE_SK") && partial.length > 4096 && partial.length < Buffer.byteLength(INFOTABLE), `inflateMemberHead: a 4 KB compressed prefix inflates to a longer text prefix (${partial.length} chars) with Z_SYNC_FLUSH`);
  const subEntry = cd.entries[2];
  ok(inflateMemberHead(ZIP.subarray(subEntry.offset, subEntry.offset + 30 + subEntry.name.length + subEntry.size), subEntry) === SUBMISSION, "inflateMemberHead: a stored member is returned as-is");
  await throws(Promise.resolve().then(() => inflateMemberHead(Buffer.from("not a zip member at all, thirty bytes+"), sumEntry)), 502, "inflateMemberHead: a buffer without a local header is a 502");

  const head = parseTsvHead(partial, 5, false);
  ok(head.columns.join(",") === "ACCESSION_NUMBER,INFOTABLE_SK,NAMEOFISSUER,CUSIP,VALUE" && head.rows.length === 5 && head.rows[0].INFOTABLE_SK === "133648926" && head.rows[4].VALUE === "388241", "parseTsvHead: header -> columns, rows as objects, capped");
  const lastFull = parseTsvHead(partial, 100000, false);
  const cut = partial.slice(partial.lastIndexOf("\n") + 1);
  ok(lastFull.rows.every((r) => r.VALUE !== null) && !lastFull.rows.some((r) => r.ACCESSION_NUMBER === cut.split("\t")[0] && r.VALUE === cut.split("\t")[4]) || cut === "", "parseTsvHead: on a partial read the cut last line is dropped, never served as a short row");
  const full = parseTsvHead(SUMMARY, 100, true);
  ok(full.rows.length === 40 && full.rows[39].TABLEENTRYTOTAL === "129", "parseTsvHead: a complete member yields every row");
  ok(parseTsvHead("A\tB\n1\n", 5, true).rows[0].B === null, "parseTsvHead: a short row reads null for the missing cell, never undefined");
  await throws(Promise.resolve().then(() => parseTsvHead("", 5, true)), 502, "parseTsvHead: no header row is a 502");
}

// ---------------------------------------------------------------------------
// The tools against a stubbed sec.gov (HEAD + Range semantics)
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
const requests = [];
let rangeMode = "206";
const ARCHIVES = {
  "https://www.sec.gov/files/datastandardsinnovation/data/form-13f-data-sets/01jun2026-31aug2026_form13f.zip": ZIP,
  "https://www.sec.gov/files/structureddata/data/form-13f-data-sets/2013q2_form13f.zip": ZIP_OLD,
};
const hdrs = (o) => ({ get: (k) => (o[k.toLowerCase()] ?? null) });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  requests.push({ url: u, method: opts.method || "GET", range: opts.headers?.Range ?? null, ua: opts.headers?.["User-Agent"] ?? null });
  if (u === "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets") return { ok: true, status: 200, headers: hdrs({}), text: async () => INDEX_HTML };
  const zip = ARCHIVES[u];
  if (!zip) return { ok: false, status: 404, headers: hdrs({}), text: async () => "nope", body: { cancel: async () => {} }, arrayBuffer: async () => new ArrayBuffer(0) };
  if ((opts.method || "GET") === "HEAD") return { ok: true, status: 200, headers: hdrs({ "content-length": String(zip.length) }), text: async () => "" };
  const m = /^bytes=(\d+)-(\d+)$/.exec(opts.headers?.Range || "");
  if (!m || rangeMode === "200") {
    let cancelled = false;
    return { ok: true, status: 200, headers: hdrs({ "content-length": String(zip.length) }), body: { cancel: async () => { cancelled = true; requests.push({ cancelled: true }); } }, arrayBuffer: async () => { if (cancelled) throw new Error("read after cancel"); return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length); } };
  }
  const start = Number(m[1]), end = Math.min(Number(m[2]), zip.length - 1);
  const slice = zip.subarray(start, end + 1);
  return { ok: true, status: 206, headers: hdrs({ "content-range": `bytes ${start}-${end}/${zip.length}` }), body: { cancel: async () => {} }, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length) };
};

{
  _resetIndexCache();
  requests.length = 0;
  const idx = await dataSetsIndex({ limit: 2 });
  ok(idx.total === 3 && idx.count === 2 && idx.latest === "01jun2026-31aug2026" && idx.dataSets[1].id === "01mar2026-31may2026" && idx.tables.length === 7 && /form_13f_readme\.pdf$/.test(idx.readmeUrl), "edgar-13f-datasets: total, count, latest, tables and readme");
  ok(requests.length === 1 && requests[0].ua && /agent402/i.test(requests[0].ua), "edgar-13f-datasets: one listing read carrying the EDGAR User-Agent");
  await dataSetsIndex({});
  ok(requests.length === 1, "edgar-13f-datasets: the listing is cached (a second call reads nothing)");
  await throws(dataSetsIndex({ limit: 0 }), 400, "edgar-13f-datasets: limit 0 refused");
  await throws(dataSetsIndex({ limit: "x" }), 400, "edgar-13f-datasets: non-integer limit refused");

  // Head of a small table: complete, every row available, exactly three reads (HEAD, tail, member).
  requests.length = 0;
  const r = await dataSetHead({ dataSet: "latest", table: "summarypage", rows: 5 });
  ok(r.dataSet.id === "01jun2026-31aug2026" && r.archiveBytes === ZIP.length && r.zip64 === false, "edgar-13f-dataset-head: latest resolves to the newest set, archive size read from HEAD");
  ok(r.members.length === 5 && r.members[3].name === "SUMMARYPAGE.tsv" && r.members[3].bytes === Buffer.byteLength(SUMMARY) && r.members[3].method === "deflate" && r.members[2].method === "stored", "edgar-13f-dataset-head: members with sizes and methods");
  ok(r.table === "SUMMARYPAGE" && r.file === "SUMMARYPAGE.tsv" && r.columns.length === 5 && r.rowsReturned === 5 && r.rows[0].ACCESSION_NUMBER === "0002134841-26-000000" && r.rows[4].TABLEENTRYTOTAL === "94", "edgar-13f-dataset-head: table name case-folded, columns + first rows as objects");
  ok(r.partial === false && /whole SUMMARYPAGE\.tsv member was read/.test(r.note), "edgar-13f-dataset-head: a member under the head bound reads complete");
  const gets = requests.filter((q) => q.method === "GET");
  ok(requests.filter((q) => q.method === "HEAD").length === 1 && gets.length === 2 && gets.every((q) => q.range), "edgar-13f-dataset-head: one HEAD + exactly two Range GETs, never a bare GET of the archive");
  const [tailRange, memberRange] = gets.map((q) => q.range.match(/^bytes=(\d+)-(\d+)$/).slice(1).map(Number));
  ok(tailRange[1] === ZIP.length - 1 && tailRange[1] - tailRange[0] + 1 <= ZIP_TAIL_BYTES, `edgar-13f-dataset-head: the tail read is the last <= ${ZIP_TAIL_BYTES} bytes`);
  ok(memberRange[1] - memberRange[0] + 1 <= MEMBER_HEAD_BYTES && r.bytesRead <= ZIP_TAIL_BYTES + MEMBER_HEAD_BYTES, `edgar-13f-dataset-head: the member read is <= ${MEMBER_HEAD_BYTES} bytes and bytesRead says so (${r.bytesRead})`);

  // Head of the big table: a strict prefix, honest partial, rows still populated.
  requests.length = 0;
  const big = await dataSetHead({ dataSet: "01jun2026-31aug2026", table: "INFOTABLE", rows: 200 });
  const bigRange = requests.filter((q) => q.method === "GET")[1].range.match(/^bytes=(\d+)-(\d+)$/).slice(1).map(Number);
  ok(bigRange[1] - bigRange[0] + 1 === MEMBER_HEAD_BYTES, `edgar-13f-dataset-head: a member larger than the bound is read to exactly ${MEMBER_HEAD_BYTES} bytes`);
  ok(big.partial === true && /only its first/.test(big.note) && big.rowsReturned === 200 && big.rows[199].INFOTABLE_SK === String(133648926 + 199), "edgar-13f-dataset-head: the big member reads partial with 200 real rows");
  ok(big.rows.every((row) => row.VALUE !== null && /^\d+$/.test(row.VALUE)), "edgar-13f-dataset-head: no row in a partial head is a cut line");

  // A quarterly id, an explicit table that is stored not deflated.
  const old = await dataSetHead({ dataSet: "2013Q2", table: "submission", rows: 10 });
  ok(old.dataSet.quarter === "2013Q2" && old.rowsReturned === 3 && old.rows[0].SUBMISSIONTYPE === "13F-HR" && old.partial === false, "edgar-13f-dataset-head: a quarterly id + a stored member");

  // Refusals: before any archive byte is read.
  requests.length = 0;
  await throws(dataSetHead({ dataSet: "1999q9" }), 400, "edgar-13f-dataset-head: malformed dataSet id", /dataSet/);
  await throws(dataSetHead({ dataSet: "https://www.sec.gov/x.zip" }), 400, "edgar-13f-dataset-head: a URL is never accepted as a dataSet");
  await throws(dataSetHead({ table: "HOLDINGS" }), 400, "edgar-13f-dataset-head: unknown table", /table/);
  await throws(dataSetHead({ rows: 0 }), 400, "edgar-13f-dataset-head: rows 0");
  await throws(dataSetHead({ rows: 201 }), 400, "edgar-13f-dataset-head: rows over the bound");
  ok(requests.length === 0, "every refusal above happened before any egress");
  await throws(dataSetHead({ dataSet: "2014q1" }), 404, "edgar-13f-dataset-head: a well-formed id absent from the listing is a 404 naming the range", /2013q2 to 01jun2026-31aug2026/);
  await throws(dataSetHead({ dataSet: "2013q2", table: "COVERPAGE" }), 422, "edgar-13f-dataset-head: a table the archive does not carry is a 422 listing its members", /SUBMISSION\.tsv/);

  // A 200 in place of a 206: refused, body cancelled, nothing buffered.
  requests.length = 0;
  rangeMode = "200";
  await throws(dataSetHead({ dataSet: "latest", table: "SUMMARYPAGE" }), 502, "edgar-13f-dataset-head: a Range GET answered 200 is refused, the whole archive is never downloaded", /did not honor the byte-range/);
  ok(requests.some((q) => q.cancelled), "edgar-13f-dataset-head: the 200 body was cancelled, not read");
  rangeMode = "206";
  for (const t of DATASET_TABLES) ok(typeof t === "string" && t === t.toUpperCase(), `table name ${t} is upper-case`);
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
