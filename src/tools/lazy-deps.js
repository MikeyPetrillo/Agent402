// Heavy, tool-only dependencies load on first use instead of at boot.
//
// A static `import` of jsdom, pdf-parse (pdfjs plus its native canvas), jimp,
// turndown, tesseract or the barcode decoders is evaluated before the server
// can listen, on every boot, whether or not a tool that needs it is ever
// called. Each loader below is a dynamic import() cached after the first call:
// the first caller pays the load, every later caller gets the same module. A
// load that fails is not cached, so the next call tries again instead of
// failing forever. scripts/test-lazy-deps.js keeps these packages out of the
// boot graph; warmLazyDeps() loads them after listen so the first buyer of each
// tool does not pay the import.

/** A cached dynamic import: `load` runs once; a rejection clears the cache. */
export function lazyImport(load) {
  let p = null;
  return () => (p ??= load().catch((e) => { p = null; throw e; }));
}

export const loadJsdom = lazyImport(() => import("jsdom").then((m) => m.JSDOM));
export const loadReadability = lazyImport(() => import("@mozilla/readability").then((m) => m.Readability));
export const loadTurndown = lazyImport(() => import("turndown").then((m) => m.default ?? m));
export const loadPdfParse = lazyImport(() => import("pdf-parse").then((m) => m.PDFParse));
export const loadPdfLib = lazyImport(() => import("pdf-lib"));
export const loadZxing = lazyImport(() => import("@zxing/library").then((m) => m.default ?? m));
export const loadJsQR = lazyImport(() => import("jsqr").then((m) => m.default ?? m));
export const loadJimp = lazyImport(() => import("jimp"));
export const loadMusicMetadata = lazyImport(() => import("music-metadata"));
export const loadTesseract = lazyImport(() => import("tesseract.js"));

/** The packages above, by name: the boot-graph test asserts none is loaded at listen. */
export const LAZY_PACKAGES = [
  "jsdom", "@mozilla/readability", "turndown", "@mixmark-io/domino", "pdf-parse", "pdfjs-dist",
  "@napi-rs/canvas", "pdf-lib", "@zxing/library", "jsqr", "jimp", "music-metadata", "tesseract.js",
];

const WARMERS = [loadJsdom, loadReadability, loadTurndown, loadPdfParse, loadPdfLib, loadZxing, loadJsQR, loadJimp, loadMusicMetadata, loadTesseract];

/** Load every lazy package in the background, one at a time with a pause
 *  between them (`gapMs`, LAZY_DEPS_WARM_GAP_MS, default 1 s): each import is
 *  synchronous CPU for the loop, so the pause keeps the loads from forming one
 *  burst while requests are being served. Called after listen; a failure is
 *  logged and left for the first real caller to retry. */
export async function warmLazyDeps({ log = console.error, gapMs = Number(process.env.LAZY_DEPS_WARM_GAP_MS ?? 1000) } = {}) {
  const t0 = Date.now();
  let loaded = 0;
  for (const load of WARMERS) {
    try { await load(); loaded++; } catch (e) { log(`[lazy-deps] warm-up load failed: ${e?.message || e}`); }
    await new Promise((r) => (gapMs > 0 ? setTimeout(r, gapMs).unref() : setImmediate(r)));
  }
  return { loaded, ms: Date.now() - t0 };
}
