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
import { createWorker } from "tesseract.js";
import { safeFetch } from "./fetch-guard.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const MAX_B64 = 12_000_000; // ~9 MB encoded — same cap as image-kit
const MAX_FETCH = 8 * 1024 * 1024; // 8 MB cap when fetching from a URL

// Lazy-initialized singleton worker. tesseract.js workers load ~12 MB of
// language data on first use; reusing one worker across requests keeps cold
// starts off the per-call hot path. The worker is process-wide and reset on
// crash by the recreate-on-error path inside doRecognize().
let workerPromise = null;
let workerLang = null;

async function getWorker(lang) {
  // If the requested language differs from the cached worker's, build a new
  // one. (English is the default and overwhelmingly common, so the singleton
  // hits in the common case.)
  if (!workerPromise || workerLang !== lang) {
    workerLang = lang;
    workerPromise = createWorker(lang).catch((e) => {
      // Reset so the next request retries instead of permanently failing.
      workerPromise = null;
      workerLang = null;
      throw e;
    });
  }
  return workerPromise;
}

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
// Validate to a conservative whitelist of the common ones so a typo doesn't
// trigger an unbounded model download. The worker downloads the model on
// first use of each language.
const SUPPORTED_LANGS = new Set([
  "eng", "spa", "fra", "deu", "ita", "por", "nld", "rus", "pol", "tur",
  "chi_sim", "chi_tra", "jpn", "kor", "ara", "hin", "tha", "vie", "ukr", "ell",
]);

async function doRecognize(buf, lang) {
  const worker = await getWorker(lang);
  try {
    const { data } = await worker.recognize(buf);
    return data;
  } catch (e) {
    // On a worker-side crash drop the singleton so the next request gets a
    // fresh worker; this avoids one bad input poisoning the process.
    workerPromise = null;
    workerLang = null;
    throw bad(`OCR failed: ${e.message || "unknown"}`, 500);
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
      "Extract text from an image (PNG/JPEG): returns the full text, overall confidence (0-100), and per-line bounding boxes. Send either {image: base64} or {url: 'https://…'}. Pure-CPU Tesseract via tesseract.js — no upstream API, no keys. Default lang 'eng'; pass 'lang' (ISO 639-2) for others.",
    tags: ["ocr", "image", "text-extraction", "tesseract", "scanned-document", "receipt"],
    discovery: {
      bodyType: "json",
      input: { url: "https://tesseract.projectnaptha.com/img/eng_bw.png" },
      inputSchema: {
        properties: {
          image: { type: "string", description: "Base64 PNG/JPEG (data: URL prefix accepted). Either this or url is required." },
          url: { type: "string", description: "HTTPS URL to fetch the image from (max 8 MB). Either this or image is required." },
          lang: { type: "string", description: "Language code, ISO 639-2. Default 'eng'. Supported: eng, spa, fra, deu, ita, por, nld, rus, pol, tur, chi_sim, chi_tra, jpn, kor, ara, hin, tha, vie, ukr, ell." },
        },
      },
      output: {
        example: {
          text: "Mild Splendour of the various-vested Night!\nMother of wildly-working visions! hail!",
          confidence: 91.8,
          lang: "eng",
          lineCount: 2,
          lines: [
            { text: "Mild Splendour of the various-vested Night!", confidence: 92.1, bbox: { x0: 24, y0: 12, x1: 658, y1: 48 } },
            { text: "Mother of wildly-working visions! hail!", confidence: 91.5, bbox: { x0: 24, y0: 56, x1: 612, y1: 92 } },
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
