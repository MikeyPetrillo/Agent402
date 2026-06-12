// PDF toolkit — deterministic, pure-JS (pdf-lib) PDF manipulation, no AI and no
// native binaries. Directly serves the marketplace's top unmet demand
// ("convert pdf", 0% supply). Inputs are public URLs (SSRF-guarded via
// safeFetch); manipulation tools return the new PDF as base64 so agents can
// chain them. The transforms are pure functions over Buffers (testable in
// isolation); the handlers just fetch then delegate.
import { PDFDocument, degrees } from "pdf-lib";
import { safeFetch } from "./fetch-guard.js";

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_INPUTS = 20;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
function need(input, field) {
  const v = input[field];
  if (v === undefined || v === null || v === "") throw bad(`Missing or invalid "${field}"`);
  return v;
}
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

async function load(buffer, label = "url") {
  try {
    return await PDFDocument.load(buffer, { ignoreEncryption: true });
  } catch {
    throw bad(`"${label}" is not a readable PDF`);
  }
}
async function fetchBuf(url, label = "url") {
  if (typeof url !== "string" || !url) throw bad(`Missing or invalid "${label}"`);
  const { buffer } = await safeFetch(url, { binary: true, maxBytes: MAX_PDF_BYTES });
  return buffer;
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

// ---- pure transforms over Buffers (no network) ----------------------------
export async function pdfInfo(buffer) {
  const doc = await load(buffer);
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
export async function mergePdfs(buffers) {
  const out = await PDFDocument.create();
  for (const [idx, buf] of buffers.entries()) {
    const doc = await load(buf, `urls[${idx}]`);
    const pages = await out.copyPages(doc, doc.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  const bytes = await out.save();
  return { pages: out.getPageCount(), bytes: bytes.length, pdfBase64: b64(bytes) };
}
export async function extractPages(buffer, spec) {
  const doc = await load(buffer);
  const indices = parsePages(spec, doc.getPageCount());
  if (!indices.length) throw bad("No pages selected");
  const out = await PDFDocument.create();
  const pages = await out.copyPages(doc, indices);
  for (const p of pages) out.addPage(p);
  const bytes = await out.save();
  return { pages: out.getPageCount(), bytes: bytes.length, pdfBase64: b64(bytes) };
}
export async function rotatePdf(buffer, deg, spec) {
  if (![90, 180, 270].includes(deg)) throw bad('"degrees" must be 90, 180, or 270');
  const doc = await load(buffer);
  const indices = new Set(parsePages(spec, doc.getPageCount()));
  doc.getPages().forEach((page, idx) => {
    if (indices.has(idx)) page.setRotation(degrees((page.getRotation().angle + deg) % 360));
  });
  const bytes = await doc.save();
  return { pages: doc.getPageCount(), bytes: bytes.length, pdfBase64: b64(bytes) };
}
export async function imagesToPdf(buffers) {
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

// ---- catalog tools (fetch + delegate) -------------------------------------
export const PDF_TOOLS = [
  {
    route: "POST /api/pdf-info", name: "PDF info", slug: "pdf-info", category: "web", price: "$0.002",
    description:
      "Inspect a PDF without downloading the whole thing into your model: page count, title, author, subject, creator, producer, creation/modification dates, encryption flag, and byte size. Body: {\"url\":\"https://…/file.pdf\"}.",
    tags: ["pdf", "documents", "metadata", "convert-pdf"],
    discovery: {
      bodyType: "json",
      input: { url: "https://arxiv.org/pdf/1706.03762" },
      inputSchema: { properties: { url: { type: "string", description: "Public URL of the PDF" } }, required: ["url"] },
      output: { example: { pages: 15, title: "Attention Is All You Need", encrypted: false, bytes: 2215244 } },
    },
    handler: async (i) => pdfInfo(await fetchBuf(need(i, "url"))),
  },
  {
    route: "POST /api/pdf-merge", name: "Merge PDFs", slug: "pdf-merge", category: "web", price: "$0.004",
    description:
      "Combine several PDFs into one, in order. Body: {\"urls\":[\"https://…/a.pdf\",\"https://…/b.pdf\"]}. Returns the merged PDF as base64 plus page count and size.",
    tags: ["pdf", "merge", "combine", "convert-pdf", "documents"],
    discovery: {
      bodyType: "json",
      input: { urls: ["https://example.com/a.pdf", "https://example.com/b.pdf"] },
      inputSchema: { properties: { urls: { type: "array", description: "2–20 public PDF URLs, merged in order" } }, required: ["urls"] },
      output: { example: { pages: 8, bytes: 51234, pdfBase64: "JVBERi0xLjcK…" } },
    },
    handler: async (i) => {
      const urls = i.urls;
      if (!Array.isArray(urls) || urls.length < 2) throw bad('"urls" must be an array of at least 2 PDF URLs');
      if (urls.length > MAX_INPUTS) throw bad(`At most ${MAX_INPUTS} PDFs per merge`);
      const buffers = [];
      for (const [idx, u] of urls.entries()) buffers.push(await fetchBuf(u, `urls[${idx}]`));
      return mergePdfs(buffers);
    },
  },
  {
    route: "POST /api/pdf-extract-pages", name: "Extract / split PDF pages", slug: "pdf-extract-pages", category: "web", price: "$0.003",
    description:
      "Pull a subset of pages into a new PDF (split). Body: {\"url\":\"https://…/file.pdf\",\"pages\":\"1-3,5\"}. Returns the new PDF as base64.",
    tags: ["pdf", "split", "extract", "pages", "convert-pdf", "documents"],
    discovery: {
      bodyType: "json",
      input: { url: "https://arxiv.org/pdf/1706.03762", pages: "1-2" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "Public URL of the PDF" },
          pages: { type: "string", description: 'Page selector, 1-based, e.g. "1-3,5,8-10"' },
        },
        required: ["url", "pages"],
      },
      output: { example: { pages: 2, bytes: 12044, pdfBase64: "JVBERi0xLjcK…" } },
    },
    handler: async (i) => extractPages(await fetchBuf(need(i, "url")), need(i, "pages")),
  },
  {
    route: "POST /api/pdf-rotate", name: "Rotate PDF", slug: "pdf-rotate", category: "web", price: "$0.003",
    description:
      "Rotate pages by 90/180/270°. Body: {\"url\":\"https://…/file.pdf\",\"degrees\":90,\"pages\":\"1-3\"?}. Omit \"pages\" to rotate all. Returns the new PDF as base64.",
    tags: ["pdf", "rotate", "convert-pdf", "documents"],
    discovery: {
      bodyType: "json",
      input: { url: "https://arxiv.org/pdf/1706.03762", degrees: 90 },
      inputSchema: {
        properties: {
          url: { type: "string", description: "Public URL of the PDF" },
          degrees: { type: "number", description: "90, 180, or 270 (clockwise)" },
          pages: { type: "string", description: "Optional page selector; default all" },
        },
        required: ["url", "degrees"],
      },
      output: { example: { pages: 15, bytes: 2215300, pdfBase64: "JVBERi0xLjcK…" } },
    },
    handler: async (i) => rotatePdf(await fetchBuf(need(i, "url")), parseInt(i.degrees, 10), i.pages),
  },
  {
    route: "POST /api/images-to-pdf", name: "Images to PDF", slug: "images-to-pdf", category: "web", price: "$0.004",
    description:
      "Combine PNG/JPEG images into a single PDF, one image per page. Body: {\"urls\":[\"https://…/1.png\",\"https://…/2.jpg\"]}. Returns the PDF as base64.",
    tags: ["pdf", "images", "convert", "convert-pdf", "documents"],
    discovery: {
      bodyType: "json",
      input: { urls: ["https://example.com/a.png", "https://example.com/b.jpg"] },
      inputSchema: { properties: { urls: { type: "array", description: "1–20 public PNG/JPEG image URLs" } }, required: ["urls"] },
      output: { example: { pages: 2, bytes: 88123, pdfBase64: "JVBERi0xLjcK…" } },
    },
    handler: async (i) => {
      const urls = i.urls;
      if (!Array.isArray(urls) || urls.length < 1) throw bad('"urls" must be a non-empty array of image URLs');
      if (urls.length > MAX_INPUTS) throw bad(`At most ${MAX_INPUTS} images`);
      const buffers = [];
      for (const [idx, u] of urls.entries()) buffers.push(await fetchBuf(u, `urls[${idx}]`));
      return imagesToPdf(buffers);
    },
  },
];
