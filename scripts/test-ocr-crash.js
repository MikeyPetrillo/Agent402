// Regression lock for the OCR DoS surfaced by A402-10, and for what a body the
// engine cannot read answers.
//
// (1) Containment: tesseract.js throws inside its own worker message handler
//     on a decode failure unless an errorHandler is set (see ocr-kit.js); once
//     uncaughtException is fatal, that stray throw would crash the whole
//     server on one bad image. A truncated PNG passes the format check, reaches
//     the engine and aborts its decoder: no uncaughtException may escape.
// (2) Attribution: tesseract.js rejects with a STRING, so the handler once
//     read `e.message` as undefined and answered 500 "OCR failed: unknown"
//     for a buyer's non-image (production, 2026-11-05). A body that is not an
//     image is now a 422 naming what it is, before the engine runs; a body
//     that starts like an image and does not decode is a 422 too; neither
//     says "unknown".
// (3) The formats the check admits really decode (PNG, JPEG, GIF, BMP, TIFF),
//     so the check refuses nothing the engine reads.
//
// Needs the language data (scripts/fetch-tessdata.js); under CI a missing
// engine fails, elsewhere it skips the engine-backed assertions.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { Jimp } from "jimp";
import { OCR_TOOLS, imageFormatOf, tessdataInstalled, __ocrTest } from "../src/tools/ocr-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

let sawUncaught = false;
process.on("uncaughtException", (e) => { sawUncaught = true; console.error("UNCAUGHT (should not happen):", e?.message); });

const ocr = OCR_TOOLS.find((t) => t.slug === "image-ocr");
const b64 = (s, enc) => Buffer.from(s, enc).toString("base64");
async function call(input) {
  try { return { body: await ocr.handler(input) }; } catch (e) { return { err: e }; }
}

(async () => {
  ok(!!ocr && typeof ocr.handler === "function", "image-ocr handler present");

  // --- format check (pure, no engine) ---
  ok(imageFormatOf(Buffer.from("89504e470d0a1a0a0000000d", "hex")) === "png", "PNG magic reads as png");
  ok(imageFormatOf(Buffer.from("ffd8ffe000104a464946", "hex")) === "jpeg", "JPEG magic reads as jpeg");
  ok(imageFormatOf(Buffer.from("GIF89a\x01\x00\x01\x00", "latin1")) === "gif", "GIF magic reads as gif");
  ok(imageFormatOf(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")) === "webp", "WebP magic reads as webp");
  ok(imageFormatOf(Buffer.from("RIFF\0\0\0\0WAVEfmt ", "latin1")) === null, "a RIFF WAVE is not an image");
  ok(imageFormatOf(Buffer.from("P6\n2 2\n255\n", "latin1")) === "pnm", "PNM magic reads as pnm");

  const refusals = [
    ["plain text", b64("this is definitely not a valid PNG or JPEG image payload"), /not a recognized image/],
    ["a PDF", b64("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"), /a PDF \(use pdf-to-markdown/],
    ["an HTML page", b64("<!doctype html><html><body>hello</body></html>"), /an HTML page/],
    ["an SVG", b64('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"></svg>'), /an SVG/],
  ];
  for (const [what, image, re] of refusals) {
    const { err } = await call({ image });
    ok(err?.statusCode === 422, `${what} is a 422 before the engine (got ${err?.statusCode}: ${String(err?.message).slice(0, 80)})`);
    ok(re.test(String(err?.message)) && /image-ocr reads PNG, JPEG/.test(String(err?.message)), `${what}: the message names it and the formats read`);
    ok(err?.hint === "unsupported-image-format", `${what}: hint unsupported-image-format`);
  }

  // --- engine-backed ---
  if (!tessdataInstalled("eng")) {
    if (process.env.CI) { ok(false, "OCR language data is installed (run scripts/fetch-tessdata.js)"); }
    else console.log("ok - skipped engine-backed checks (no tessdata here; run scripts/fetch-tessdata.js tessdata eng)");
  } else {
    // A truncated PNG: right magic, aborts libpng inside the WASM engine.
    const truncated = b64("89504e470d0a1a0a0000000d49484452000000100000001008020000", "hex");
    const { err } = await call({ image: truncated, lang: "eng" });
    ok(err?.statusCode === 422, `a truncated PNG is a 422 (got ${err?.statusCode}: ${String(err?.message).slice(0, 90)})`);
    ok(/could not be decoded: it starts like a PNG file/.test(String(err?.message)), "the message says the PNG did not decode");
    ok(err?.hint === "image-decode-failed", "hint image-decode-failed");
    ok(!/unknown/.test(String(err?.message)), "no 'unknown' in the answer");

    // Every format the check admits (bar WebP, which jimp cannot write) decodes.
    const img = new Jimp({ width: 120, height: 40, color: 0xffffffff });
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/bmp", "image/tiff"]) {
      const buf = await img.getBuffer(mime);
      const r = await call({ image: buf.toString("base64") });
      ok(r.body && typeof r.body.text === "string", `${mime} passes the check and decodes (${r.err ? r.err.statusCode + " " + r.err.message : "ok"})`);
    }
    // A worker survives the failures above: a good image still reads.
    const again = await call({ image: (await img.getBuffer("image/png")).toString("base64") });
    ok(!!again.body, "a good image after a decode failure still reads");
  }

  // Give any stray async worker 'throw' a moment to surface before we assert.
  await new Promise((r) => setTimeout(r, 500));
  ok(!sawUncaught, "no uncaughtException escaped the OCR path (the DoS is contained)");
  await __ocrTest.shutdown();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
