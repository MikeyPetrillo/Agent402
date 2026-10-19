// Form 13F Data Sets - the SEC's bulk, structured 13F extracts
// (sec.gov/data-research/sec-markets-data/form-13f-data-sets, read 2026-09-18).
//
// What the SEC publishes: one ZIP per period (quarterly 2013Q2-2023Q4, then a
// rolling three-month window ending Feb/May/Aug/Nov), each holding seven TSV
// tables flattened from the XML portion of every 13F submission in the window
// (SUBMISSION, COVERPAGE, OTHERMANAGER, OTHERMANAGER2, SIGNATURE, SUMMARYPAGE,
// INFOTABLE) plus a readme and a CSVW metadata file. There is NO row-level API:
// the zip IS the product. Measured 2026-09-18 on the newest set
// (01jun2026-31aug2026_form13f.zip): 100,719,015 bytes, INFOTABLE.tsv alone
// 99.3 MB compressed / 396 MB inflated, the other six tables 83-585 KB
// compressed. A multi-hundred-MB download per paid call is out of the question,
// so this module never reads a whole zip:
//
//   1. the INDEX tool parses the SEC's own listing page (one HTML read, cached
//      6 h) into the data sets available and their sizes;
//   2. the HEAD tool reads a data set with TWO bounded Range requests - the
//      zip's tail (the central directory, 64 KB) to learn where each member
//      starts, then the first `MEMBER_HEAD_BYTES` (256 KB) of the ONE member
//      asked for - and inflates that prefix with Z_SYNC_FLUSH, which yields
//      whatever rows the prefix decodes to. sec.gov honours Range (206 +
//      Accept-Ranges: bytes, probed live), and a 200 in place of a 206 is
//      refused with the body cancelled rather than buffered, so the worst
//      case per call is ~320 KB on the wire whatever the archive weighs.
//
// The data set is chosen by ID from the parsed index, never by a caller URL:
// the only host these tools ever fetch is www.sec.gov, and the URL comes from
// the SEC's own page.
//
// Pure helpers (index parser, central-directory parser, TSV head) are exported
// for scripts/test-edgar-13f-datasets.js, which builds a real zip in memory.

import zlib from "node:zlib";
import { upstreamFetch, bodyUnderDeadline } from "../upstream-deadline.js";
import { assertPublicUrl } from "./fetch-guard.js";

export const DATASETS_INDEX_URL = "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets";
export const DATASETS_README_URL = "https://www.sec.gov/files/form_13f_readme.pdf";
export const DATASET_TABLES = ["SUBMISSION", "COVERPAGE", "OTHERMANAGER", "OTHERMANAGER2", "SIGNATURE", "SUMMARYPAGE", "INFOTABLE"];
export const ZIP_TAIL_BYTES = 64 * 1024;
export const MEMBER_HEAD_BYTES = 256 * 1024;
export const MAX_HEAD_ROWS = 200;
const INDEX_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = Math.max(2_000, parseInt(process.env.EDGAR_FETCH_TIMEOUT_MS || "12000", 10) || 12_000);

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
function userAgent() {
  return (process.env.EDGAR_USER_AGENT || "").trim() || "Agent402 mike@agent402.tools";
}

// ---------------------------------------------------------------------------
// Index page -> data sets
// ---------------------------------------------------------------------------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad2 = (n) => String(n).padStart(2, "0");

/** "01jun2026-31aug2026_form13f.zip" | "2013q2_form13f.zip" -> {id, from, to, quarter}. */
export function parseDataSetFilename(file) {
  const base = String(file || "").replace(/^.*\//, "");
  let m = /^(\d{2})([a-z]{3})(\d{4})-(\d{2})([a-z]{3})(\d{4})_form13f\.zip$/i.exec(base);
  if (m) {
    const [, d1, m1, y1, d2, m2, y2] = m;
    const mo1 = MONTHS[m1.toLowerCase()], mo2 = MONTHS[m2.toLowerCase()];
    if (!mo1 || !mo2) return null;
    return { id: base.replace(/_form13f\.zip$/i, "").toLowerCase(), from: `${y1}-${pad2(mo1)}-${d1}`, to: `${y2}-${pad2(mo2)}-${d2}`, quarter: null };
  }
  m = /^(\d{4})q([1-4])_form13f\.zip$/i.exec(base);
  if (m) {
    const y = Number(m[1]), q = Number(m[2]);
    const from = `${y}-${pad2((q - 1) * 3 + 1)}-01`;
    const lastMonth = q * 3;
    const lastDay = new Date(Date.UTC(y, lastMonth, 0)).getUTCDate();
    return { id: `${y}q${q}`, from, to: `${y}-${pad2(lastMonth)}-${pad2(lastDay)}`, quarter: `${y}Q${q}` };
  }
  return null;
}

/** The SEC listing page -> [{id, label, file, url, from, to, quarter, sizeMb}], newest first. */
export function parseDataSetIndex(html, baseUrl = "https://www.sec.gov") {
  const out = [];
  const seen = new Set();
  const re = /<a\s+[^>]*href="([^"]*form13f[^"]*\.zip)"[^>]*>([^<]*)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const href = m[1];
    const parsed = parseDataSetFilename(href);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    // The size sits in the next table cell; read a bounded window after the anchor.
    const window = html.slice(m.index + m[0].length, m.index + m[0].length + 600);
    const size = /([\d.]+)\s*(MB|KB|GB)\b/i.exec(window);
    let sizeMb = null;
    if (size) {
      const n = Number(size[1]);
      const unit = size[2].toUpperCase();
      sizeMb = Number.isFinite(n) ? Number((unit === "GB" ? n * 1024 : unit === "KB" ? n / 1024 : n).toFixed(2)) : null;
    }
    let url;
    try { url = new URL(href, baseUrl).href; } catch { continue; }
    if (!url.startsWith("https://www.sec.gov/")) continue;
    out.push({ ...parsed, label: m[2].replace(/\s+/g, " ").trim(), file: href.replace(/^.*\//, ""), url, sizeMb });
  }
  // Newest first by the window's end date (the page is newest first already;
  // sorting makes "latest" a property of the data, not of the page's order).
  out.sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : 0));
  return out;
}

let indexCache = { at: 0, rows: null };
export function _resetIndexCache() { indexCache = { at: 0, rows: null }; }

async function edgarText(url, accept) {
  const safeUrl = await assertPublicUrl(url);
  const ctx = { label: "SEC", step: "data-set listing", timeoutMs: FETCH_TIMEOUT_MS, tag: "[edgar-13f]" };
  const res = await upstreamFetch(safeUrl, { headers: { "User-Agent": userAgent(), Accept: accept } }, ctx);
  const text = await bodyUnderDeadline(res.text(), ctx);
  if (!res.ok) {
    if (res.status >= 500) throw Object.assign(bad(`SEC upstream HTTP ${res.status} - try again later`, 502), { upstreamStatus: res.status });
    throw Object.assign(bad(`SEC upstream HTTP ${res.status}`, 502), { upstreamStatus: res.status });
  }
  return text;
}

export async function listDataSets({ force = false } = {}) {
  if (!force && indexCache.rows && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.rows;
  const html = await edgarText(DATASETS_INDEX_URL, "text/html");
  const rows = parseDataSetIndex(html);
  if (!rows.length) throw bad("The SEC's Form 13F data-set listing carried no data-set links - the page may have changed shape", 502);
  indexCache = { at: Date.now(), rows };
  return rows;
}

// ---------------------------------------------------------------------------
// Bounded Range reads
// ---------------------------------------------------------------------------
/** One Range GET. Requires a 206; a 200 (Range ignored) is refused with the body cancelled. */
export async function rangeBytes(url, start, end, { fetchImpl = fetch } = {}) {
  const safeUrl = await assertPublicUrl(url);
  const ctx = { label: "SEC", step: "range read", timeoutMs: FETCH_TIMEOUT_MS, tag: "[edgar-13f]", fetchImpl };
  const res = await upstreamFetch(safeUrl, {
    headers: { "User-Agent": userAgent(), Accept: "application/octet-stream", Range: `bytes=${start}-${end}` },
  }, ctx);
  if (res.status !== 206) {
    try { await res.body?.cancel?.(); } catch { /* nothing to release */ }
    if (res.status === 200) throw bad("SEC did not honor the byte-range request (answered 200 for a Range GET); refusing to download the whole archive", 502);
    if (res.status === 404) throw bad("That data set is no longer at the URL the SEC's listing gave for it", 422);
    throw Object.assign(bad(`SEC upstream HTTP ${res.status}`, res.status >= 500 ? 502 : 502), { upstreamStatus: res.status });
  }
  const cr = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(res.headers.get("content-range") || "");
  const total = cr ? Number(cr[3]) : null;
  const buf = Buffer.from(await bodyUnderDeadline(res.arrayBuffer(), ctx));
  if (buf.length > end - start + 1) throw bad("SEC returned more bytes than the range asked for", 502);
  return { buf, total };
}

/** Content-Length via HEAD (sec.gov answers it); used to place the tail read. */
async function contentLength(url, { fetchImpl = fetch } = {}) {
  const safeUrl = await assertPublicUrl(url);
  const res = await upstreamFetch(safeUrl, { method: "HEAD", headers: { "User-Agent": userAgent() } }, { label: "SEC", step: "archive size", timeoutMs: FETCH_TIMEOUT_MS, tag: "[edgar-13f]", fetchImpl });
  if (res.status === 404) throw bad("That data set is no longer at the URL the SEC's listing gave for it", 422);
  if (!res.ok) throw Object.assign(bad(`SEC upstream HTTP ${res.status}`, 502), { upstreamStatus: res.status });
  const n = Number(res.headers.get("content-length"));
  if (!Number.isFinite(n) || n <= 0) throw bad("SEC did not report the archive size", 502);
  return n;
}

// ---------------------------------------------------------------------------
// ZIP central directory (from the tail bytes) and a member's inflated head
// ---------------------------------------------------------------------------
const SIG_EOCD = 0x06054b50, SIG_EOCD64 = 0x06064b50, SIG_EOCD64_LOC = 0x07064b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;

/** tail = the LAST `tail.length` bytes of a zip of `totalSize` bytes -> {entries:[{name, method, compressedSize, size, offset}], zip64}. */
export function parseCentralDirectory(tail, totalSize) {
  if (!Buffer.isBuffer(tail) || tail.length < 22) throw bad("zip tail too short to hold an end-of-central-directory record", 502);
  const tailStart = totalSize - tail.length;
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) { if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; } }
  if (eocd < 0) throw bad("no zip end-of-central-directory record in the archive tail", 502);
  let entries = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  let zip64 = false;
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== SIG_EOCD64_LOC) throw bad("zip64 archive without a zip64 locator", 502);
    const rec64 = Number(tail.readBigUInt64LE(loc + 8)) - tailStart;
    if (rec64 < 0 || rec64 + 56 > tail.length || tail.readUInt32LE(rec64) !== SIG_EOCD64) throw bad("zip64 end-of-central-directory record outside the archive tail", 502);
    entries = Number(tail.readBigUInt64LE(rec64 + 32));
    cdSize = Number(tail.readBigUInt64LE(rec64 + 40));
    cdOffset = Number(tail.readBigUInt64LE(rec64 + 48));
    zip64 = true;
  }
  const cdStart = cdOffset - tailStart;
  if (cdStart < 0 || cdStart + cdSize > tail.length) throw bad(`the archive's central directory (${cdSize} bytes) does not fit in the ${tail.length}-byte tail read`, 502);
  const out = [];
  let p = cdStart;
  for (let k = 0; k < entries && p + 46 <= tail.length; k++) {
    if (tail.readUInt32LE(p) !== SIG_CEN) break;
    const method = tail.readUInt16LE(p + 10);
    let compressedSize = tail.readUInt32LE(p + 20);
    let size = tail.readUInt32LE(p + 24);
    const nl = tail.readUInt16LE(p + 28), el = tail.readUInt16LE(p + 30), cl = tail.readUInt16LE(p + 32);
    let offset = tail.readUInt32LE(p + 42);
    const name = tail.toString("utf8", p + 46, p + 46 + nl);
    // zip64 extra field (0x0001): uncompressed, compressed, offset - only the
    // fields whose 32-bit twin reads 0xFFFFFFFF are present, in that order.
    if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) {
      let q = p + 46 + nl;
      const qEnd = q + el;
      while (q + 4 <= qEnd) {
        const id = tail.readUInt16LE(q), len = tail.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (size === 0xffffffff) { size = Number(tail.readBigUInt64LE(r)); r += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(tail.readBigUInt64LE(r)); r += 8; }
          if (offset === 0xffffffff) { offset = Number(tail.readBigUInt64LE(r)); r += 8; }
          break;
        }
        q += 4 + len;
      }
    }
    out.push({ name, method, compressedSize, size, offset });
    p += 46 + nl + el + cl;
  }
  if (!out.length) throw bad("the archive's central directory holds no entries", 502);
  return { entries: out, zip64 };
}

/** Bytes from a member's local header onward -> the inflated (or stored) prefix as text. */
export function inflateMemberHead(buf, entry) {
  if (!Buffer.isBuffer(buf) || buf.length < 30 || buf.readUInt32LE(0) !== SIG_LOC) throw bad("zip member does not start with a local file header", 502);
  const nl = buf.readUInt16LE(26), el = buf.readUInt16LE(28);
  const data = buf.subarray(30 + nl + el);
  const method = entry?.method ?? buf.readUInt16LE(8);
  if (method === 0) return data.toString("utf8");
  if (method !== 8) throw bad(`zip member uses compression method ${method}; only deflate (8) and stored (0) are read`, 502);
  try {
    return zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString("utf8");
  } catch (e) {
    throw bad(`could not inflate the member's head: ${e.message}`, 502);
  }
}

/** TSV text -> {columns, rows (objects), truncatedLastLine}. `complete` = the whole member was read. */
export function parseTsvHead(text, maxRows, complete) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  if (!complete) lines.pop(); // the last line of a prefix may be cut mid-row
  else if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const columns = (lines.shift() || "").split("\t").map((c) => c.trim()).filter(Boolean);
  if (!columns.length) throw bad("the table's head carried no header row", 502);
  const rows = [];
  for (const line of lines) {
    if (rows.length >= maxRows) break;
    if (!line) continue;
    const cells = line.split("\t");
    const row = {};
    for (let i = 0; i < columns.length; i++) row[columns[i]] = i < cells.length ? cells[i] : null;
    rows.push(row);
  }
  return { columns, rows, decodedRows: lines.filter(Boolean).length };
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------
function takeRows(raw, dflt = 25) {
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_HEAD_ROWS) throw bad(`"rows" must be an integer from 1 to ${MAX_HEAD_ROWS}`);
  return n;
}
function takeTable(raw) {
  if (raw == null || raw === "") return "SUMMARYPAGE";
  const t = String(raw).trim().toUpperCase().replace(/\.TSV$/, "");
  if (!DATASET_TABLES.includes(t)) throw bad(`"table" must be one of ${DATASET_TABLES.join(", ")}`);
  return t;
}
function takeDataSetId(raw) {
  if (raw == null || raw === "" || String(raw).trim().toLowerCase() === "latest") return "latest";
  const s = String(raw).trim().toLowerCase().replace(/_form13f\.zip$/, "");
  if (!/^(\d{2}[a-z]{3}\d{4}-\d{2}[a-z]{3}\d{4}|\d{4}q[1-4])$/.test(s)) throw bad('"dataSet" must be "latest", a window id such as "01jun2026-31aug2026", or a quarter id such as "2013q2" (see edgar-13f-datasets)');
  return s;
}

export async function dataSetsIndex({ limit } = {}) {
  const lim = limit == null || limit === "" ? 60 : Number(limit);
  if (!Number.isInteger(lim) || lim < 1 || lim > 200) throw bad('"limit" must be an integer from 1 to 200');
  const rows = await listDataSets();
  return {
    total: rows.length,
    count: Math.min(rows.length, lim),
    latest: rows[0]?.id ?? null,
    dataSets: rows.slice(0, lim),
    tables: DATASET_TABLES,
    readmeUrl: DATASETS_README_URL,
    source: DATASETS_INDEX_URL,
    note: "Each data set is one zip of seven TSV tables flattened from every 13F filed in the window (the newest is about 100 MB, INFOTABLE.tsv alone 400 MB inflated). edgar-13f-dataset-head reads a bounded head of one table without downloading the archive.",
  };
}

export async function dataSetHead({ dataSet, table, rows } = {}, { fetchImpl = fetch } = {}) {
  const id = takeDataSetId(dataSet);
  const tableName = takeTable(table);
  const maxRows = takeRows(rows);
  const index = await listDataSets();
  const set = id === "latest" ? index[0] : index.find((r) => r.id === id);
  if (!set) throw bad(`No Form 13F data set "${id}" on the SEC's listing - ids run ${index[index.length - 1]?.id} to ${index[0]?.id} (see edgar-13f-datasets)`, 404);

  const total = await contentLength(set.url, { fetchImpl });
  const tailLen = Math.min(ZIP_TAIL_BYTES, total);
  const { buf: tail } = await rangeBytes(set.url, total - tailLen, total - 1, { fetchImpl });
  const { entries, zip64 } = parseCentralDirectory(tail, total);
  const members = entries.map((e) => ({ name: e.name, bytes: e.size, compressedBytes: e.compressedSize, method: e.method === 8 ? "deflate" : e.method === 0 ? "stored" : String(e.method) }));
  const entry = entries.find((e) => e.name.replace(/\.[a-z]+$/i, "").toUpperCase() === tableName);
  if (!entry) throw bad(`This data set carries no ${tableName} table; its members are ${entries.map((e) => e.name).join(", ")}`, 422);

  const headerLen = 30 + Buffer.byteLength(entry.name) + 1024; // local header + name + generous extra-field room
  const want = Math.min(entry.compressedSize + headerLen, MEMBER_HEAD_BYTES);
  const { buf: head } = await rangeBytes(set.url, entry.offset, entry.offset + want - 1, { fetchImpl });
  const complete = want >= entry.compressedSize + headerLen;
  const text = inflateMemberHead(head, entry);
  const parsed = parseTsvHead(text, maxRows, complete);
  return {
    dataSet: { id: set.id, label: set.label, from: set.from, to: set.to, quarter: set.quarter, url: set.url, sizeMb: set.sizeMb },
    archiveBytes: total,
    zip64,
    members,
    table: tableName,
    file: entry.name,
    columns: parsed.columns,
    rowsReturned: parsed.rows.length,
    rows: parsed.rows,
    partial: !complete,
    bytesRead: tailLen + head.length,
    note: complete
      ? `The whole ${entry.name} member was read (${entry.size} bytes inflated); rows is the first ${maxRows} of it.`
      : `${entry.name} is ${entry.compressedSize} bytes compressed (${entry.size} inflated); only its first ${MEMBER_HEAD_BYTES} bytes were read, so rows is a head of the table, not the table. Download the archive for the rest.`,
    readmeUrl: DATASETS_README_URL,
    source: set.url,
  };
}
