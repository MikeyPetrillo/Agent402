// OCR kit — extract text from images. Pure-CPU via tesseract.js (WASM
// Tesseract bundled, no native bins, no API keys, no upstream calls). Agents
// constantly need to OCR a scanned doc, screenshot, or receipt before any
// downstream text tool can run — Bazaar has zero coverage here, Agent402 had
// zero coverage here, so this is the canonical gap filler.
//
// Accepts either a base64-encoded image (same contract as image-kit) OR a URL
// to fetch via safeFetch. Returns extracted text + confidence + per-line boxes
// so a caller can pick up coordinates for hit-testing (receipts, invoices).
//
// Pricing tier $0.01 — OCR is meaningfully more compute than a hash but less
// than browser/PDF tooling. PoW-eligible (pure CPU, no network in the hot path).
import { loadTesseract } from "./lazy-deps.js";
import { safeFetch } from "./fetch-guard.js";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const MAX_B64 = 12_000_000; // ~9 MB encoded — same cap as image-kit
const MAX_FETCH = 8 * 1024 * 1024; // 8 MB cap when fetching from a URL

// Language data is read from a local directory, never fetched at request time:
// scripts/fetch-tessdata.js installs the pinned, hash-checked files there (the
// Dockerfile runs it at build time). OCR_TESSDATA_DIR overrides the default
// <repo>/tessdata. tesseract.js caches nothing (cacheMethod "none"), and its
// cachePath points at a private temp directory so no code path writes into the
// working directory.
export const TESSDATA_DIR = resolve(process.env.OCR_TESSDATA_DIR || fileURLToPath(new URL("../../tessdata", import.meta.url)));
const TESS_CACHE_DIR = join(tmpdir(), "agent402-tessdata-cache");

export function tessdataInstalled(lang) {
  return existsSync(join(TESSDATA_DIR, `${lang}.traineddata.gz`));
}

// One tesseract.js worker per language, in a small map with least-recently-used
// eviction. tesseract.js workers load the language model on first use, so a
// warm worker keeps model loading off the per-call path. Every worker that
// leaves the map (evicted, or dropped after a failure) is terminated once its
// in-flight recognitions finish, so a caller alternating languages never grows
// the thread count past the cap.
export const OCR_WORKER_MAX = 3;
const OCR_INIT_TIMEOUT_MS = Number(process.env.OCR_INIT_TIMEOUT_MS) || 30_000;
const workers = new Map(); // lang -> { promise, active, retired }

function retireEntry(entry) {
  entry.retired = true;
  if (entry.active === 0) {
    entry.promise.then((w) => w.terminate()).catch(() => { /* never started */ });
  }
}

function dropEntry(lang, entry) {
  if (workers.get(lang) === entry) workers.delete(lang);
  retireEntry(entry);
}

function getWorkerEntry(lang) {
  let entry = workers.get(lang);
  if (entry) {
    workers.delete(lang); // re-insert to mark most recently used
    workers.set(lang, entry);
    return entry;
  }
  if (!tessdataInstalled(lang)) {
    throw bad(`OCR language data for "${lang}" is not installed on this server`, 503);
  }
  mkdirSync(TESS_CACHE_DIR, { recursive: true });
  entry = { promise: null, active: 0, retired: false };
  const started = loadTesseract().then(({ createWorker }) => createWorker(lang, undefined, {
    langPath: TESSDATA_DIR,
    cachePath: TESS_CACHE_DIR,
    cacheMethod: "none",
    gzip: true,
    // CRITICAL: on a worker 'reject' (e.g. a malformed image tesseract can't
    // decode) tesseract.js rejects the recognize() promise AND, when no
    // errorHandler is set, `throw`s inside its own message handler, which
    // escapes as an uncaughtException and, with the A402-10 fatal handler,
    // would let one bad image crash the whole server (a DoS). Providing a
    // handler routes that error here instead of throwing; the same error
    // still rejects recognize(), which the caller below try/catches into a
    // clean 500. So this contains the stray throw without hiding the failure.
    errorHandler: (e) => {
      console.error("[ocr] tesseract worker error (contained):", (e && e.message) || e);
    },
  }));
  // tesseract.js never settles createWorker when language initialization fails
  // (an unreadable data file), so startup carries its own deadline. A worker
  // that starts after the deadline is terminated as soon as it appears.
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(bad(`OCR engine for "${lang}" did not start`, 503)), OCR_INIT_TIMEOUT_MS);
    timer.unref?.();
  });
  entry.promise = Promise.race([started, deadline]);
  entry.promise.finally(() => clearTimeout(timer)).catch(() => {});
  started.then((w) => { if (entry.retired && entry.active === 0) w.terminate(); }).catch(() => {});
  // A worker that fails to start leaves the map so the next request retries.
  entry.promise.catch(() => dropEntry(lang, entry));
  workers.set(lang, entry);
  while (workers.size > OCR_WORKER_MAX) {
    const [oldLang, oldest] = workers.entries().next().value;
    dropEntry(oldLang, oldest);
  }
  return entry;
}

/** Test hook: how many language workers are held, and terminate them all. */
export const __ocrTest = {
  workerCount: () => workers.size,
  async shutdown() { for (const [lang, entry] of [...workers]) dropEntry(lang, entry); },
};

function decodeImageInput(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw bad('Missing "image" (base64 PNG/JPEG, optionally a data: URL)');
  }
  let b64 = input.trim();
  const m = b64.match(/^data:image\/[a-z+]+;base64,(.*)$/is);
  if (m) b64 = m[1];
  b64 = b64.replace(/\s+/g, "");
  if (b64.length > MAX_B64) throw bad(`image too large (${b64.length} base64 chars; max ${MAX_B64})`);
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 8) throw bad("image data too small");
  return buf;
}

// Tesseract supports a long list of languages by 3-letter ISO 639-2 code.
// Validate to a conservative whitelist of the common ones; each has pinned,
// locally installed language data (scripts/fetch-tessdata.js).
export const SUPPORTED_LANGS = new Set([
  "eng", "spa", "fra", "deu", "ita", "por", "nld", "rus", "pol", "tur",
  "chi_sim", "chi_tra", "jpn", "kor", "ara", "hin", "tha", "vie", "ukr", "ell",
]);

async function doRecognize(buf, lang) {
  const entry = getWorkerEntry(lang);
  entry.active++;
  try {
    const worker = await entry.promise;
    const { data } = await worker.recognize(buf);
    return data;
  } catch (e) {
    // On a worker-side crash drop this language's worker so the next request
    // gets a fresh one; this avoids one bad input poisoning the process.
    dropEntry(lang, entry);
    if (e?.statusCode === 503) throw e;
    throw bad(`OCR failed: ${e.message || "unknown"}`, 500);
  } finally {
    entry.active--;
    if (entry.retired) retireEntry(entry);
  }
}

export const OCR_TOOLS = [
  {
    route: "POST /api/image-ocr",
    name: "Image OCR",
    slug: "image-ocr",
    category: "data",
    price: "$0.01",
    description:
      "Extract text from an image (PNG/JPEG): returns the full text, overall confidence (0-100), and per-line bounding boxes. Send either {image: base64} or {url: 'https://…'}. Pure-CPU Tesseract via tesseract.js - no upstream API, no keys. Default lang 'eng'; pass 'lang' (ISO 639-2) for others.",
    tags: ["ocr", "image", "text-extraction", "tesseract", "scanned-document", "receipt", "extract", "text"],
    discovery: {
      bodyType: "json",
      input: { url: "https://agent402.tools/fixtures/sample-text.png" },
      inputSchema: {
        properties: {
          image: { type: "string", description: "Base64 PNG/JPEG (data: URL prefix accepted). Either this or url is required." },
          url: { type: "string", description: "HTTPS URL to fetch the image from (max 8 MB). Either this or image is required." },
          lang: { type: "string", description: "Language code, ISO 639-2. Default 'eng'. Supported: eng, spa, fra, deu, ita, por, nld, rus, pol, tur, chi_sim, chi_tra, jpn, kor, ara, hin, tha, vie, ukr, ell." },
        },
      },
      output: {
        example: {
          text: "Agent402 sample text for OCR.\nInvoice 402-0001 total 12.34 USD.",
          confidence: 94,
          lang: "eng",
          lineCount: 2,
          lines: [
            { text: "Agent402 sample text for OCR.", confidence: 94.34, bbox: { x0: 24, y0: 29, x1: 469, y1: 60 } },
            { text: "Invoice 402-0001 total 12.34 USD.", confidence: 96.31, bbox: { x0: 27, y0: 81, x1: 514, y1: 106 } },
          ],
          source: "tesseract.js (Tesseract WASM, Apache-2.0)",
        },
      },
    },
    handler: async (i) => {
      const lang = String(i.lang ?? "eng").toLowerCase();
      if (!SUPPORTED_LANGS.has(lang)) {
        throw bad(`unsupported lang "${lang}". Supported: ${[...SUPPORTED_LANGS].join(", ")}`);
      }

      let buf;
      if (i.image) {
        buf = decodeImageInput(i.image);
      } else if (i.url) {
        const url = String(i.url).trim();
        if (!/^https?:\/\//i.test(url)) throw bad('"url" must be http(s)');
        const { buffer } = await safeFetch(url, { binary: true, maxBytes: MAX_FETCH });
        if (!buffer || buffer.length < 8) throw bad("fetched image too small or empty", 502);
        buf = buffer;
      } else {
        throw bad('Provide either "image" (base64) or "url"');
      }

      const data = await doRecognize(buf, lang);
      const lines = (data.lines ?? []).map((l) => ({
        text: (l.text ?? "").replace(/\s+$/g, ""),
        confidence: typeof l.confidence === "number" ? +l.confidence.toFixed(2) : null,
        bbox: l.bbox ? { x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1 } : null,
      }));
      return {
        text: (data.text ?? "").replace(/\s+$/g, ""),
        confidence: typeof data.confidence === "number" ? +data.confidence.toFixed(2) : null,
        lang,
        lineCount: lines.length,
        lines,
        source: "tesseract.js (Tesseract WASM, Apache-2.0)",
      };
    },
  },
];
