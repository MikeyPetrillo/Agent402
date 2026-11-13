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
import { admissionCallerOf } from "../dispatch-caller.js";
import { createCallerPlaces } from "../caller-places.js";
import { notChargedOn } from "../not-charged.js";
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

// Each entry carries `gone`, settled once its worker has terminated (or never
// started), so a caller that must wait for the thread to be gone can await it.
function newEntry(promise) {
  const entry = { promise, active: 0, retired: false, terminated: null };
  entry.gone = new Promise((r) => { entry.markGone = r; });
  return entry;
}
function terminateEntry(entry, worker) {
  if (!entry.terminated) {
    entry.terminated = Promise.resolve(worker ?? entry.promise).then((w) => w.terminate()).catch(() => { /* never started */ });
    entry.terminated.finally(() => entry.markGone?.());
  }
  return entry.terminated;
}
function retireEntry(entry) {
  entry.retired = true;
  if (entry.active === 0) terminateEntry(entry);
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
  entry = newEntry(null);
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
    // clean 422 (undecodable image) or 500 (engine failure). So this contains
    // the stray throw without hiding the failure.
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
  /** Put a stand-in engine in a language's slot (fault-path tests). */
  inject(lang, worker) { workers.set(lang, newEntry(Promise.resolve(worker))); },
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

// The image formats the bundled Leptonica reads, by magic bytes. Anything
// else is refused before the engine sees it: Leptonica answers a PDF, a
// webpage or an SVG with a bare decode failure, which used to surface as a
// 500 "OCR failed: unknown" (2026-11-05).
export function imageFormatOf(buf) {
  if (!buf || buf.length < 8) return null;
  const b = buf;
  if (b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG") return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  const s4 = b.subarray(0, 4).toString("latin1");
  if (s4 === "GIF8") return "gif";
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  if (s4 === "II*\0" || s4 === "MM\0*") return "tiff";
  if (s4 === "RIFF" && b.length >= 12 && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (b[0] === 0x50 && b[1] >= 0x31 && b[1] <= 0x36 && /\s/.test(String.fromCharCode(b[2]))) return "pnm";
  return null;
}

export const OCR_FORMATS_TEXT = "PNG, JPEG, GIF, BMP, TIFF, WebP or PNM";

// The engine decodes the whole image into memory before it reads a line, and a
// small file can declare a huge canvas (a 150 KB PNG declaring 30000x30000
// grew the process by about 400 MB and kept it). The header's dimensions are
// read here and an image over the cap is refused before the engine sees it.
export const OCR_MAX_PIXELS = 64_000_000; // 64 megapixels, e.g. 8000x8000 or 9792x6528
export const OCR_MAX_SIDE = 32_767;
const OCR_MAX_MEGAPIXELS = OCR_MAX_PIXELS / 1e6;

/**
 * The longest side, in pixels, to downscale an image to so that it fits both
 * caps at its own aspect ratio. A resizer rounds the short side to a whole
 * pixel, so it is taken as rounded up, which keeps the result under the cap
 * whichever way the caller's resizer rounds.
 */
export function ocrDownscaleSide(width, height) {
  const long = Math.max(width, height), short = Math.min(width, height);
  // One above the floating-point estimate, then down to the first side that fits.
  let side = Math.min(OCR_MAX_SIDE, long, Math.floor(long * Math.sqrt(OCR_MAX_PIXELS / (width * height))) + 1);
  while (side > 1 && side * Math.max(1, Math.ceil((short * side) / long)) > OCR_MAX_PIXELS) side--;
  return side;
}

/** The 422 for an image over the cap: the limits, the image's own size and the
 *  side to downscale to, in fields and in the message (a connector shows the
 *  message alone). The handler adds the charge sentence on a route call only
 *  (`chargeClaim`, src/not-charged.js). */
function tooLarge(width, height) {
  const megapixels = Math.round((width * height) / 1e4) / 100;
  const side = ocrDownscaleSide(width, height);
  const fix = `Downscale the image so its longest side is at most ${side} pixels (that keeps its aspect ratio and lands under ${OCR_MAX_MEGAPIXELS} megapixels) and send it again. Text that stays about 20 pixels tall or more reads as well at that size as at full size.`;
  return Object.assign(
    bad(`the image is ${width}x${height} pixels (${megapixels} megapixels); image-ocr reads images up to ${OCR_MAX_MEGAPIXELS} megapixels and ${OCR_MAX_SIDE} pixels a side. ${fix}`, 422),
    {
      chargeClaim: true,
      hint: "image-too-large",
      width, height, megapixels,
      maxMegapixels: OCR_MAX_MEGAPIXELS, maxSide: OCR_MAX_SIDE, maxPixels: OCR_MAX_PIXELS,
      downscaleToLongestSide: side,
      fix,
      howToCallNote: `Send this request again with the image downscaled so its longest side is at most ${side} pixels.`,
    },
  );
}

/** A 422 for bytes that start like an image and do not hold a readable one. */
function undecodable(fmt, why) {
  return Object.assign(
    bad(`the image could not be decoded: it starts like a ${fmt.toUpperCase()} file but ${why}`, 422),
    { hint: "image-decode-failed" },
  );
}

const u16le = (b, o) => (o + 2 <= b.length ? b.readUInt16LE(o) : null);
const u16be = (b, o) => (o + 2 <= b.length ? b.readUInt16BE(o) : null);
const u32le = (b, o) => (o + 4 <= b.length ? b.readUInt32LE(o) : null);
const u32be = (b, o) => (o + 4 <= b.length ? b.readUInt32BE(o) : null);

function pngSize(b) {
  if (b.length < 24 || b.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegSize(b) {
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const m = b[o + 1];
    if (m === 0xff) { o++; continue; } // fill byte
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; } // no length
    if (m === 0xd9 || m === 0xda) return null; // end, or scan data before any frame header
    const len = b.readUInt16BE(o + 2);
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (o + 9 > b.length) return null;
      return { height: b.readUInt16BE(o + 5), width: b.readUInt16BE(o + 7) };
    }
    o += 2 + len;
  }
  return null;
}

// The logical screen and the first image's own size (the engine reads the
// first image; take the larger of the two).
function gifSize(b) {
  if (b.length < 13) return null;
  let width = b.readUInt16LE(6), height = b.readUInt16LE(8);
  let o = 13;
  if (b[10] & 0x80) o += 3 * (1 << ((b[10] & 7) + 1));
  while (o < b.length) {
    const t = b[o];
    if (t === 0x2c) {
      const w = u16le(b, o + 5), h = u16le(b, o + 7);
      if (w == null || h == null) return null;
      return { width: Math.max(width, w), height: Math.max(height, h) };
    }
    if (t !== 0x21) break; // trailer or junk before any image
    o += 2;
    while (o < b.length && b[o] !== 0) o += b[o] + 1; // sub-blocks
    o++;
  }
  return null; // no image in the file
}

// tesseract.js converts every BMP with bmp-js before the engine sees it, and
// bmp-js reads a 40-byte info header, then a palette, then pixel rows from the
// end of the palette, allocating width x height x 4 bytes first. So a BMP is
// checked against what that reader will touch: an unchecked one answered 500
// with the reader's RangeError text (2026-11-07).
const BMP_DEPTHS = new Set([1, 4, 8, 16, 24, 32]);
function bmpCheck(b) {
  if (b.length < 54) return { problem: "is shorter than a BMP header" };
  const headerSize = b.readUInt32LE(14);
  if (headerSize < 40 || headerSize > 124) return { problem: "its header type is not one this reader takes" };
  const width = b.readInt32LE(18);
  const rawHeight = b.readInt32LE(22);
  const height = Math.abs(rawHeight);
  const bpp = b.readUInt16LE(28);
  const compress = b.readUInt32LE(30);
  const colors = b.readUInt32LE(46);
  if (width <= 0 || height === 0) return { problem: "its header gives no width or height" };
  if (!BMP_DEPTHS.has(bpp)) return { problem: `its bit depth (${bpp}) is not one this reader takes` };
  let pos = 54;
  if (bpp < 15) {
    const entries = colors === 0 ? 1 << bpp : colors;
    if (entries > 1 << bpp) return { problem: "its palette is larger than its bit depth allows" };
    pos += entries * 4;
    if (pos > b.length) return { problem: "is truncated (the palette runs past the end)" };
  }
  const rle = (bpp === 8 && compress === 1) || (bpp === 4 && compress === 2);
  if (!rle) {
    if (compress !== 0 && compress !== 3) return { problem: "uses a compression this reader does not take" };
    const stride = Math.ceil((width * bpp) / 32) * 4;
    if (pos + stride * height > b.length) return { problem: "is truncated (its pixel rows run past the end)", width, height };
  }
  return { width, height };
}

function tiffSize(b) {
  const le = b[0] === 0x49;
  const r16 = le ? u16le : u16be, r32 = le ? u32le : u32be;
  const ifd = r32(b, 4);
  if (ifd == null) return null;
  const n = r16(b, ifd);
  if (n == null) return null;
  let width = null, height = null;
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = r16(b, e), type = r16(b, e + 2);
    if (tag == null || type == null) return null;
    if (tag !== 256 && tag !== 257) continue;
    const v = type === 3 ? r16(b, e + 8) : type === 4 ? r32(b, e + 8) : null;
    if (v == null) return null;
    if (tag === 256) width = v; else height = v;
  }
  return width != null && height != null ? { width, height } : null;
}

function webpSize(b) {
  if (b.length < 30) return null;
  const kind = b.subarray(12, 16).toString("latin1");
  if (kind === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (kind === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X") {
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

function pnmSize(b) {
  const head = b.subarray(2, 1024).toString("latin1").replace(/#[^\n]*/g, " ");
  const m = /^\s+(\d{1,9})\s+(\d{1,9})/.exec(head);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * Read the dimensions an image declares, and refuse one that the engine would
 * choke on: a header that does not give its size, a BMP the converter would
 * read past the end of, or a canvas over OCR_MAX_PIXELS / OCR_MAX_SIDE.
 */
export function checkImageHeader(buf, fmt) {
  let size;
  if (fmt === "bmp") {
    const r = bmpCheck(buf);
    if (r.problem) throw undecodable(fmt, r.problem);
    size = r;
  } else {
    const read = { png: pngSize, jpeg: jpegSize, gif: gifSize, tiff: tiffSize, webp: webpSize, pnm: pnmSize }[fmt];
    size = read ? read(buf) : null;
    if (!size) throw undecodable(fmt, "its header does not give the image's size");
  }
  const { width, height } = size;
  if (!(width > 0) || !(height > 0)) throw undecodable(fmt, "its header gives no width or height");
  if (width > OCR_MAX_SIDE || height > OCR_MAX_SIDE || width * height > OCR_MAX_PIXELS) throw tooLarge(width, height);
  return { width, height };
}

/** What a non-image body looks like, for the refusal's wording. */
function describeNonImage(buf) {
  const head = buf.subarray(0, 512).toString("latin1").trimStart();
  if (head.startsWith("%PDF-")) return "a PDF (use pdf-to-markdown for a PDF's text)";
  if (/^<\?xml[\s\S]*<svg|^<svg/i.test(head)) return "an SVG (a vector format; render it to PNG first)";
  if (/^<(!doctype html|html|head|body)/i.test(head)) return "an HTML page, not an image";
  if (/^[{[]/.test(head)) return "JSON, not an image";
  if (buf.subarray(4, 8).toString("latin1") === "ftyp") return "an HEIC/AVIF or video file (convert it to PNG or JPEG first)";
  return "not a recognized image";
}

/** A 422 for a body that is not an image the engine reads. */
function notAnImage(buf, from) {
  return Object.assign(
    bad(`${from} is ${describeNonImage(buf)}; image-ocr reads ${OCR_FORMATS_TEXT}`, 422),
    { hint: "unsupported-image-format" },
  );
}

// tesseract.js rejects with a STRING (its worker posts err.toString()), so a
// rejection has no .message: read both shapes.
const rejectionText = (e) => String((e && typeof e === "object" && e.message) || e || "").slice(0, 200);
// Leptonica's read failure, the WASM abort a malformed body causes (a
// truncated PNG aborts libpng) and the BMP converter reading past the end of
// its buffer: the bytes start like an image but do not decode. A bare WASM
// RuntimeError (a trap) is not here: on an image whose header checked out it
// is an engine fault, a 5xx, never the caller's.
export const DECODE_FAILURE = /attempting to read image|pixRead|Aborted\(|ERR_OUT_OF_RANGE|ERR_BUFFER_OUT_OF_BOUNDS/i;

// A large image costs the engine several bytes a pixel while it reads (a 64 MP
// photo grew the process by about 560 MB), and the language workers (one per
// language, OCR_WORKER_MAX of them) run side by side, so three at once would
// hold gigabytes. Only one image above OCR_LARGE_PIXELS is in the engine at a
// time; the next waits up to OCR_LARGE_WAIT_MS for its turn (at most
// OCR_LARGE_QUEUE_MAX waiting), then answers 503 with Retry-After. Smaller
// images never wait here. The slot is held until the worker that read the
// image has terminated (its memory is gone), up to OCR_LARGE_RETIRE_WAIT_MS.
//
// Admission is per caller (the signed payer, a credits key, a Tempo sender,
// else the client address; for a step an in-process executor runs, the caller
// of the call that dispatched it, src/dispatch-caller.js): a caller with nothing in the slot or its queue
// is never refused for want of room while a queued place belongs to a caller
// that already holds the slot or another place. That place goes to it, and
// the caller it was taken from is answered 503 (not charged), so one caller's
// run of large images cannot hold every place.
export const OCR_LARGE_PIXELS = 16_000_000;
export const OCR_LARGE_WAIT_MS = 15_000;
export const OCR_LARGE_QUEUE_MAX = 2;
export const OCR_LARGE_RETIRE_WAIT_MS = 10_000;
let largeBusy = false;
let largeHolder = null;
const largeWaiters = [];
const largeCallers = createCallerPlaces(); // caller -> places held (the slot and queued)

function largeBusyError() {
  return Object.assign(
    bad(`image-ocr is reading another image over ${OCR_LARGE_PIXELS / 1e6} megapixels; retry in a minute, or send this one downscaled below ${OCR_LARGE_PIXELS / 1e6} megapixels to be read at once.`, 503),
    { retryAfter: 60, shed: true, hint: "large-image-busy", chargeClaim: true },
  );
}

// A place with no caller key is counted under the one shared key, never not
// at all, so the eviction rule below sees it (src/caller-places.js).
const holdPlace = (who) => largeCallers.hold(who);
const freePlace = (who) => largeCallers.free(who);

/** Wait for the large-image slot; resolves to its release function. */
function acquireLargeSlot(waitMs = OCR_LARGE_WAIT_MS, who = null) {
  const release = () => releaseLargeSlot(who);
  if (!largeBusy) { largeBusy = true; largeHolder = who; holdPlace(who); return Promise.resolve(release); }
  if (largeWaiters.length >= OCR_LARGE_QUEUE_MAX) {
    // A newcomer takes the last queued place of a caller holding more than one.
    const victimAt = largeCallers.victims(largeWaiters, who)?.[0] ?? -1;
    if (victimAt < 0) return Promise.reject(largeBusyError());
    const [victim] = largeWaiters.splice(victimAt, 1);
    clearTimeout(victim.timer);
    freePlace(victim.who);
    victim.reject(largeBusyError());
  }
  holdPlace(who);
  return new Promise((resolve, reject) => {
    const waiter = { who, reject, resolve: () => { clearTimeout(waiter.timer); largeHolder = who; resolve(release); } };
    waiter.timer = setTimeout(() => {
      const i = largeWaiters.indexOf(waiter);
      if (i >= 0) largeWaiters.splice(i, 1);
      freePlace(who);
      reject(largeBusyError());
    }, waitMs);
    largeWaiters.push(waiter);
  });
}

function releaseLargeSlot(who = null) {
  freePlace(who);
  const next = largeWaiters.shift();
  if (next) next.resolve(); // the slot passes straight to the next waiter
  else { largeBusy = false; largeHolder = null; }
}

/** Test hook for the large-image slot. */
export const __ocrLargeTest = {
  acquire: acquireLargeSlot,
  state: () => ({ busy: largeBusy, waiting: largeWaiters.length, holder: largeHolder, callers: largeCallers.callers() }),
  recognize: doRecognize,
};

/** The caller a large image's place is held for: the request's, else the
 *  caller an in-process executor runs this call for (src/dispatch-caller.js),
 *  else one shared key, so a place is never held uncounted. */
function ocrCallerOf(req) {
  return admissionCallerOf(req);
}

async function doRecognize(buf, lang, fmt, pixels = 0, who = null) {
  const release = pixels > OCR_LARGE_PIXELS ? await acquireLargeSlot(OCR_LARGE_WAIT_MS, who) : null;
  const used = {};
  try {
    return await recognizeOn(buf, lang, fmt, used);
  } finally {
    if (release) {
      // The engine's WASM memory grows to fit the largest image it read and
      // never shrinks (a 64 MP image left a worker about 560 MB larger), so
      // the worker that read a large image is retired once its calls finish,
      // and the slot passes on once that worker has terminated.
      const entry = used.entry;
      if (entry) {
        dropEntry(lang, entry);
        let timer;
        await Promise.race([entry.gone, new Promise((r) => { timer = setTimeout(r, OCR_LARGE_RETIRE_WAIT_MS); timer.unref?.(); })]);
        clearTimeout(timer);
      }
      release();
    }
  }
}

async function recognizeOn(buf, lang, fmt, used = {}) {
  const entry = getWorkerEntry(lang);
  used.entry = entry;
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
    const why = rejectionText(e);
    if (DECODE_FAILURE.test(why)) throw undecodable(fmt, "is corrupt or truncated");
    // An engine fault on an image that passed the header check: the reason
    // goes to the log, the caller gets a 5xx (not charged) without it.
    console.error("[ocr] engine failed:", why || "no reason given");
    throw bad("OCR engine failed on this image; retry the call", 500);
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
      `Extract text from an image (${OCR_FORMATS_TEXT}, up to ${OCR_MAX_MEGAPIXELS} megapixels and ${OCR_MAX_SIDE.toLocaleString("en-US")} pixels a side): returns the full text, overall confidence (0-100), and per-line bounding boxes. Send either {image: base64} or {url: 'https://…'}. Pure-CPU Tesseract via tesseract.js - no upstream API, no keys. Default lang 'eng'; pass 'lang' (ISO 639-2) for others.`,
    tags: ["ocr", "image", "text-extraction", "tesseract", "scanned-document", "receipt", "extract", "text"],
    discovery: {
      bodyType: "json",
      input: { url: "https://agent402.tools/fixtures/sample-text.png" },
      inputSchema: {
        properties: {
          image: { type: "string", description: `Base64 ${OCR_FORMATS_TEXT} (data: URL prefix accepted), up to ${OCR_MAX_MEGAPIXELS} megapixels and ${OCR_MAX_SIDE} pixels a side. Either this or url is required.` },
          url: { type: "string", description: `HTTPS URL to fetch the image from (max 8 MB, same pixel limits). Either this or image is required.` },
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
    handler: async (i, req) => {
      try { return await readImageText(i, req); } catch (err) {
        if (err?.chargeClaim && typeof err.message === "string") { err.message += notChargedOn(req); delete err.chargeClaim; }
        throw err;
      }
    },
  },
];

/** The image-ocr handler's body; the handler adds the charge sentence. */
async function readImageText(i, req) {
  const lang = String(i.lang ?? "eng").toLowerCase();
  if (!SUPPORTED_LANGS.has(lang)) {
    throw bad(`unsupported lang "${lang}". Supported: ${[...SUPPORTED_LANGS].join(", ")}`);
  }

  let buf;
  let from;
  if (i.image) {
    buf = decodeImageInput(i.image);
    from = '"image"';
  } else if (i.url) {
    const url = String(i.url).trim();
    if (!/^https?:\/\//i.test(url)) throw bad('"url" must be http(s)');
    const { buffer } = await safeFetch(url, { binary: true, maxBytes: MAX_FETCH });
    if (!buffer || buffer.length < 8) throw bad("fetched image too small or empty", 502);
    buf = buffer;
    from = "The file at that URL";
  } else {
    throw bad('Provide either "image" (base64) or "url"');
  }

  const fmt = imageFormatOf(buf);
  if (!fmt) throw notAnImage(buf, from);
  const { width, height } = checkImageHeader(buf, fmt);
  const data = await doRecognize(buf, lang, fmt, width * height, ocrCallerOf(req));
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
}
