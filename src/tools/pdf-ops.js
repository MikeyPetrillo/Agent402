// Pure PDF transforms over Buffers (pdf-lib), split out of pdf-kit.js so they
// run inside src/tools/pdf-worker.js. Nothing here touches the network or the
// filesystem: the handlers fetch through safeFetch on the main thread and hand
// the bytes to the worker, which runs one of these per job.
import { loadPdfLib } from "./lazy-deps.js";

export function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

// pdf-lib stamps itself as Creator and Producer and sets both dates to now on
// load unless told not to. Harmless for a PDF we produce, wrong for a read:
// pdf-info reported every document as made by pdf-lib a moment ago.
async function load(buffer, label = "url", { readOnly = false } = {}) {
  const { PDFDocument } = await loadPdfLib();
  try {
    return await PDFDocument.load(buffer, { ignoreEncryption: true, ...(readOnly ? { updateMetadata: false } : {}) });
  } catch {
    throw bad(`"${label}" is not a readable PDF`);
  }
}
// Parse a 1-based page selector like "1-3,5,8-10" into 0-based indices.
export function parsePages(spec, pageCount) {
  if (spec === undefined || spec === null || spec === "") return [...Array(pageCount).keys()];
  const out = [];
  for (const part of String(spec).split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw bad(`Invalid page range "${part}" (use e.g. "1-3,5")`);
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (a < 1 || b < 1 || a > pageCount || b > pageCount) throw bad(`Page out of range in "${part}" (document has ${pageCount} pages)`);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i - 1);
  }
  return out;
}

async function pdfInfo(buffer) {
  const doc = await load(buffer, "url", { readOnly: true });
  const d = (fn) => { try { const v = fn(); return v instanceof Date ? v.toISOString() : v || null; } catch { return null; } };
  return {
    pages: doc.getPageCount(),
    title: d(() => doc.getTitle()),
    author: d(() => doc.getAuthor()),
    subject: d(() => doc.getSubject()),
    keywords: d(() => doc.getKeywords()),
    creator: d(() => doc.getCreator()),
    producer: d(() => doc.getProducer()),
    created: d(() => doc.getCreationDate()),
    modified: d(() => doc.getModificationDate()),
    encrypted: doc.isEncrypted,
    bytes: buffer.length,
  };
}
async function mergePdfs(buffers) {
  const { PDFDocument } = await loadPdfLib();
  const out = await PDFDocument.create();
  for (const [idx, buf] of buffers.entries()) {
    const doc = await load(buf, `urls[${idx}]`);
    const pages = await out.copyPages(doc, doc.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  const bytes = await out.save();
  return { pages: out.getPageCount(), bytes: bytes.length, pdfBase64: b64(bytes) };
}
async function extractPages(buffer, spec) {
  const { PDFDocument } = await loadPdfLib();
  const doc = await load(buffer);
  const indices = parsePages(spec, doc.getPageCount());
  if (!indices.length) throw bad("No pages selected");
  const out = await PDFDocument.create();
  const pages = await out.copyPages(doc, indices);
  for (const p of pages) out.addPage(p);
  const bytes = await out.save();
  return { pages: out.getPageCount(), bytes: bytes.length, pdfBase64: b64(bytes) };
}
async function rotatePdf(buffer, deg, spec) {
  if (![90, 180, 270].includes(deg)) throw bad('"degrees" must be 90, 180, or 270');
  const { degrees } = await loadPdfLib();
  const doc = await load(buffer);
  const indices = new Set(parsePages(spec, doc.getPageCount()));
  doc.getPages().forEach((page, idx) => {
    if (indices.has(idx)) page.setRotation(degrees((page.getRotation().angle + deg) % 360));
  });
  const bytes = await doc.save();
  return { pages: doc.getPageCount(), bytes: bytes.length, pdfBase64: b64(bytes) };
}
async function imagesToPdf(buffers) {
  const { PDFDocument } = await loadPdfLib();
  const out = await PDFDocument.create();
  for (const [idx, buf] of buffers.entries()) {
    const head = buf.subarray(0, 4).toString("hex");
    let img;
    try {
      if (head.startsWith("89504e47")) img = await out.embedPng(buf); // PNG magic
      else if (head.startsWith("ffd8")) img = await out.embedJpg(buf); // JPEG magic
      else throw new Error("unsupported");
    } catch {
      throw bad(`urls[${idx}] is not a PNG or JPEG image`);
    }
    const page = out.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  const bytes = await out.save();
  return { pages: out.getPageCount(), bytes: bytes.length, pdfBase64: b64(bytes) };
}


/** The transforms by name; the worker runs exactly one per job. */
export const PDF_OPS = { info: pdfInfo, merge: mergePdfs, extract: extractPages, rotate: rotatePdf, imagesToPdf };
