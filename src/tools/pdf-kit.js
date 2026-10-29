// PDF toolkit — deterministic, pure-JS (pdf-lib) PDF manipulation, no AI and no
// native binaries. Directly serves the marketplace's top unmet demand
// ("convert pdf", 0% supply). Inputs are public URLs (SSRF-guarded via
// safeFetch); manipulation tools return the new PDF as base64 so agents can
// chain them. The transforms are pure functions over Buffers (testable in
// isolation); the handlers just fetch then delegate.
import { safeFetch } from "./fetch-guard.js";
import { bad, parsePages } from "./pdf-ops.js";
import { runPdfOp } from "./pdf-offthread.js";

export { parsePages };

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_INPUTS = 20;

function need(input, field) {
  const v = input[field];
  if (v === undefined || v === null || v === "") throw bad(`Missing or invalid "${field}"`);
  return v;
}
async function fetchBuf(url, label = "url") {
  if (typeof url !== "string" || !url) throw bad(`Missing or invalid "${label}"`);
  const { buffer } = await safeFetch(url, { binary: true, maxBytes: MAX_PDF_BYTES });
  return buffer;
}

// ---- transforms, each run in a worker thread (src/tools/pdf-worker.js) -----
// pdf-lib parses and decodes synchronously, so a hostile document would hold
// the event loop and grow without bound. The worker caps decoded stream bytes,
// carries a heap limit and is terminated at a deadline.
export const pdfInfo = (buffer) => runPdfOp("info", [buffer]);
export const mergePdfs = (buffers) => runPdfOp("merge", buffers);
export const extractPages = (buffer, spec) => runPdfOp("extract", [buffer], [spec]);
export const rotatePdf = (buffer, deg, spec) => runPdfOp("rotate", [buffer], [deg, spec]);
export const imagesToPdf = (buffers) => runPdfOp("imagesToPdf", buffers);

// ---- catalog tools (fetch + delegate) -------------------------------------
export const PDF_TOOLS = [
  {
    route: "POST /api/pdf-info", name: "PDF info", slug: "pdf-info", category: "web", price: "$0.001",
    description:
      "Inspect a PDF without downloading the whole thing into your model: page count, title, author, subject, creator, producer, creation/modification dates, encryption flag, and byte size. Body: {\"url\":\"https://…/file.pdf\"}.",
    tags: ["pdf", "documents", "metadata", "convert-pdf"],
    discovery: {
      bodyType: "json",
      input: { url: "https://agent402.tools/fixtures/sample-invoice.pdf" },
      inputSchema: { properties: { url: { type: "string", description: "Public URL of the PDF" } }, required: ["url"] },
      output: { example: { pages: 1, title: null, encrypted: false, bytes: 634 } },
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
      input: { urls: ["https://agent402.tools/fixtures/sample-invoice.pdf", "https://agent402.tools/fixtures/sample-invoice.pdf"] },
      inputSchema: { properties: { urls: { type: "array", description: "2–20 public PDF URLs, merged in order" } }, required: ["urls"] },
      output: { example: { pages: 2, bytes: 944, pdfBase64: "JVBERi0xLjcK…" } },
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
      input: { url: "https://agent402.tools/fixtures/sample-invoice.pdf", pages: "1" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "Public URL of the PDF" },
          pages: { type: "string", description: 'Page selector, 1-based, e.g. "1-3,5,8-10"' },
        },
        required: ["url", "pages"],
      },
      output: { example: { pages: 1, bytes: 772, pdfBase64: "JVBERi0xLjcK…" } },
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
      input: { url: "https://agent402.tools/fixtures/sample-invoice.pdf", degrees: 90 },
      inputSchema: {
        properties: {
          url: { type: "string", description: "Public URL of the PDF" },
          degrees: { type: "number", description: "90, 180, or 270 (clockwise)" },
          pages: { type: "string", description: "Optional page selector; default all" },
        },
        required: ["url", "degrees"],
      },
      output: { example: { pages: 1, bytes: 774, pdfBase64: "JVBERi0xLjcK…" } },
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
      input: { urls: ["https://agent402.tools/fixtures/sample-image.png", "https://agent402.tools/fixtures/sample-image.png"] },
      inputSchema: { properties: { urls: { type: "array", description: "1–20 public PNG/JPEG image URLs" } }, required: ["urls"] },
      output: { example: { pages: 2, bytes: 16753, pdfBase64: "JVBERi0xLjcK…" } },
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
