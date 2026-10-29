// Unit-test the PDF transforms on in-memory buffers (no network — the fetch
// layer is SSRF-guarded and tested separately). Covers the new pdf-* tools.
import { PDFDocument } from "pdf-lib";
import zlib from "node:zlib";
import { pdfInfo, mergePdfs, extractPages, rotatePdf, imagesToPdf, parsePages } from "../src/tools/pdf-kit.js";
import { runPdfOp } from "../src/tools/pdf-offthread.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

async function makePdf(pageCount, title) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  for (let i = 0; i < pageCount; i++) doc.addPage([300, 400]);
  return Buffer.from(await doc.save());
}
const png1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6360000002000001e221bc330000000049454e44ae426082",
  "hex"
);

const a = await makePdf(3, "Doc A");
const b = await makePdf(2, "Doc B");

const info = await pdfInfo(a);
if (info.pages !== 3 || info.title !== "Doc A") fail(`pdf-info wrong: ${JSON.stringify(info)}`);
console.log("pdf-info ✓ (3 pages, title)");

// A read reports the document's own metadata. pdf-lib stamps itself as
// Creator/Producer and the dates as now on load unless told not to, so every
// PDF used to read as made by pdf-lib a moment ago.
{
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  doc.setCreator("Fixture Writer");
  doc.setProducer("Fixture Press");
  doc.setCreationDate(new Date("2020-01-02T03:04:05Z"));
  const own = await pdfInfo(Buffer.from(await doc.save({ updateFieldAppearances: false })));
  if (own.creator !== "Fixture Writer" || own.producer !== "Fixture Press") fail(`pdf-info overwrote creator/producer: ${JSON.stringify(own)}`);
  if (own.created !== "2020-01-02T03:04:05.000Z") fail(`pdf-info overwrote the creation date: ${own.created}`);
  console.log("pdf-info ✓ (reports the document's own creator, producer and date)");
}

const merged = await mergePdfs([a, b]);
if (merged.pages !== 5) fail(`pdf-merge wrong: ${merged.pages}`);
if ((await PDFDocument.load(Buffer.from(merged.pdfBase64, "base64"))).getPageCount() !== 5) fail("merged base64 did not reload as 5 pages");
console.log("pdf-merge ✓ (3+2 → 5, base64 reloads)");

const ex = await extractPages(a, "1-2");
if (ex.pages !== 2) fail(`pdf-extract-pages wrong: ${ex.pages}`);
console.log("pdf-extract-pages ✓ (1-2 → 2 pages)");

const rot = await rotatePdf(a, 90);
const rotDoc = await PDFDocument.load(Buffer.from(rot.pdfBase64, "base64"));
if (rotDoc.getPage(0).getRotation().angle !== 90) fail("pdf-rotate did not apply 90°");
console.log("pdf-rotate ✓ (90° applied, reloads)");

const i2p = await imagesToPdf([png1x1, png1x1]);
if (i2p.pages !== 2) fail(`images-to-pdf wrong: ${i2p.pages}`);
console.log("images-to-pdf ✓ (2 PNGs → 2 pages)");

// parsePages + validation
if (JSON.stringify(parsePages("1-3,5", 10)) !== JSON.stringify([0, 1, 2, 4])) fail("parsePages wrong");
let threw = false;
try { parsePages("9", 3); } catch { threw = true; }
if (!threw) fail("parsePages should reject out-of-range");
try { await rotatePdf(a, 45); fail("rotate should reject 45°"); } catch {}
try { await pdfInfo(Buffer.from("not a pdf")); fail("pdfInfo should reject non-PDF"); } catch {}
console.log("validation ✓ (ranges, bad angle, non-PDF rejected)");

// Decompression bound and the event loop. A small object stream that inflates
// to hundreds of MB is refused with a 422 from the worker's decode cap, while
// the main thread's loop stays free; the type name is also written with a
// #-escape, which pdf-lib decodes, to show the cap does not depend on it.
function objStmBomb(mb, typeName) {
  const header = "1 0 ";
  const comp = zlib.deflateSync(Buffer.concat([Buffer.from(header), Buffer.alloc(mb * 1048576, 0x20), Buffer.from("null")]), { level: 9 });
  return Buffer.concat([
    Buffer.from("%PDF-1.7\n2 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj\n3 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n"),
    Buffer.from(`4 0 obj\n<< /Type /${typeName} /N 1 /First ${header.length} /Filter /FlateDecode /Length ${comp.length} >>\nstream\n`),
    comp, Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 2 0 R >>\n%%EOF\n"),
  ]);
}
for (const typeName of ["ObjStm", "Obj#53tm"]) {
  const bomb = objStmBomb(200, typeName);
  let worst = 0, last = performance.now();
  const iv = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; }, 5);
  let err = null;
  try { await pdfInfo(bomb); } catch (e) { err = e; }
  clearInterval(iv);
  if (!err || err.statusCode !== 422 || !/decode past/.test(err.message)) fail(`${typeName} bomb (${bomb.length} bytes) should be refused 422 by the decode cap (got ${err ? `${err.statusCode} ${err.message}` : "an answer"})`);
  if (worst >= 150) fail(`${typeName} bomb held the event loop ${Math.round(worst)} ms (bound 150)`);
}
// The deadline terminates a job that overruns it.
try { await runPdfOp("info", [a], [], { timeoutMs: 1 }); fail("a job past its deadline should be refused"); }
catch (e) { if (e.statusCode !== 422 || !/longer than/.test(e.message)) fail(`deadline refusal should be 422 (got ${e.statusCode} ${e.message})`); }
console.log("bounds ✓ (inflation bomb refused off-thread, deadline enforced)");

console.log("\nPDF toolkit: all assertions passed");
process.exit(0);
