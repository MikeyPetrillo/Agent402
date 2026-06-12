// Unit-test the PDF transforms on in-memory buffers (no network — the fetch
// layer is SSRF-guarded and tested separately). Covers the new pdf-* tools.
import { PDFDocument } from "pdf-lib";
import { pdfInfo, mergePdfs, extractPages, rotatePdf, imagesToPdf, parsePages } from "../src/tools/pdf-kit.js";

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

console.log("\nPDF toolkit: all assertions passed");
process.exit(0);
