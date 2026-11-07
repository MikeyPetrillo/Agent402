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
// (4) The header's dimensions are read before the engine runs: a canvas over
//     the pixel cap (a pixel bomb) and a header that does not give its size or,
//     for a BMP, would send the converter past the end of the bytes, are 422s
//     before the engine decodes anything; an engine fault on an image that
//     checked out is a 500 without the engine's text.
//
// Needs the language data (scripts/fetch-tessdata.js); under CI a missing
// engine fails, elsewhere it skips the engine-backed assertions.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { Jimp } from "jimp";
import { deflateSync, crc32 } from "node:zlib";
import { OCR_TOOLS, imageFormatOf, checkImageHeader, tessdataInstalled, __ocrTest } from "../src/tools/ocr-kit.js";

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

  // --- (4) header dimensions: pixel bombs and unreadable headers (no engine) ---
  const pngHead = (w, h) => {
    const b = Buffer.alloc(33);
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(b, 0);
    b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8;
    return b;
  };
  const jpegHead = (w, h) => Buffer.concat([
    Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex"),
    Buffer.from([0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]),
  ]);
  const gifHead = (sw, sh, iw, ih) => {
    const b = Buffer.alloc(24);
    b.write("GIF89a", 0, "latin1"); b.writeUInt16LE(sw, 6); b.writeUInt16LE(sh, 8);
    b[13] = 0x2c; b.writeUInt16LE(iw, 18); b.writeUInt16LE(ih, 20);
    return b;
  };
  const tiffHead = (w, h) => {
    const b = Buffer.alloc(8 + 2 + 24 + 4);
    b.write("II*\0", 0, "latin1"); b.writeUInt32LE(8, 4); b.writeUInt16LE(2, 8);
    b.writeUInt16LE(256, 10); b.writeUInt16LE(4, 12); b.writeUInt32LE(1, 14); b.writeUInt32LE(w, 18);
    b.writeUInt16LE(257, 22); b.writeUInt16LE(3, 24); b.writeUInt32LE(1, 26); b.writeUInt16LE(h, 30);
    return b;
  };
  const webpX = (w, h) => {
    const b = Buffer.alloc(30);
    b.write("RIFF", 0, "latin1"); b.write("WEBPVP8X", 8, "latin1");
    b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
    return b;
  };
  const webpL = (w, h) => {
    const b = Buffer.alloc(30);
    b.write("RIFF", 0, "latin1"); b.write("WEBPVP8L", 8, "latin1"); b[20] = 0x2f;
    b.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 21);
    return b;
  };
  const bmpHead = (w, h, bpp = 24, rows = true) => {
    const stride = Math.ceil((w * bpp) / 32) * 4;
    const b = Buffer.alloc(54 + (rows ? stride * h : 4));
    b.write("BM", 0, "latin1"); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(54, 10);
    b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22);
    b.writeUInt16LE(1, 26); b.writeUInt16LE(bpp, 28);
    return b;
  };
  const sizeOf = (buf) => { try { return checkImageHeader(buf, imageFormatOf(buf)); } catch (e) { return e; } };
  const fits = [
    ["PNG", pngHead(640, 480)], ["JPEG", jpegHead(640, 480)], ["GIF", gifHead(640, 480, 640, 480)],
    ["TIFF", tiffHead(640, 480)], ["WebP VP8X", webpX(640, 480)], ["WebP VP8L", webpL(640, 480)],
    ["PNM", Buffer.from("P5\n# c\n640 480\n255\n", "latin1")], ["BMP", bmpHead(64, 48)],
  ];
  for (const [what, buf] of fits) {
    const r = sizeOf(buf);
    const want = what === "BMP" ? "64x48" : "640x480";
    ok(r && `${r.width}x${r.height}` === want, `${what} header reads ${want} (got ${r instanceof Error ? r.message : `${r?.width}x${r?.height}`})`);
  }
  const bombs = [
    ["PNG", pngHead(30000, 30000)], ["JPEG", jpegHead(65000, 65000)], ["GIF screen", gifHead(60000, 60000, 1, 1)],
    ["GIF image", gifHead(1, 1, 60000, 60000)], ["TIFF", tiffHead(100000, 40000)], ["WebP VP8X", webpX(20000, 20000)],
    ["WebP VP8L", webpL(16000, 16000)], ["PNM", Buffer.from("P4\n90000 90000\n", "latin1")],
    ["PNG one long side", pngHead(40000, 10)],
  ];
  for (const [what, buf] of bombs) {
    const r = sizeOf(buf);
    ok(r?.statusCode === 422 && r?.hint === "image-too-large" && /megapixels/.test(r.message), `${what} over the cap is a 422 image-too-large (got ${r?.statusCode} ${r?.hint})`);
  }
  // A BMP declaring a huge canvas with no rows behind it: bmp-js would allocate
  // width x height x 4 bytes before reading a row.
  const bmpBomb = sizeOf(bmpHead(40000, 30000, 24, false));
  ok(bmpBomb?.statusCode === 422, `a BMP declaring 40000x30000 with no rows is a 422 (got ${bmpBomb?.statusCode})`);
  const unreadable = [
    ["PNG without IHDR", Buffer.from("89504e470d0a1a0a0000000d4e4f5045000000100000001008020000", "hex")],
    ["JPEG without a frame header", Buffer.from("ffd8ffe000104a464946000101ffd9", "hex")],
    ["GIF without an image", Buffer.from("GIF89a\x10\x00\x10\x00\x00\x00\x00\x3b", "latin1")],
    ["BMP with bit depth 7", (() => { const b = bmpHead(4, 4); b.writeUInt16LE(7, 28); return b; })()],
    ["BMP with truncated rows", bmpHead(400, 400).subarray(0, 600)],
  ];
  for (const [what, buf] of unreadable) {
    const r = sizeOf(buf);
    ok(r?.statusCode === 422 && r?.hint === "image-decode-failed", `${what} is a 422 image-decode-failed (got ${r?.statusCode} ${r?.hint}: ${String(r?.message).slice(0, 80)})`);
  }

  // The reviewer's probe: "BM" then text. It answered 500 with the BMP
  // reader's RangeError [ERR_OUT_OF_RANGE] text; now a 422 that names the
  // problem and carries no internal error text. Refused before any engine.
  {
    const { err } = await call({ image: b64("BM hello this is not a bitmap at all") });
    ok(err?.statusCode === 422 && err?.hint === "image-decode-failed", `"BM hello..." is a 422 image-decode-failed (got ${err?.statusCode}: ${String(err?.message).slice(0, 90)})`);
    ok(/starts like a BMP file but is shorter than a BMP header/.test(String(err?.message)), "the message names the BMP problem");
    ok(!/RangeError|ERR_|offset/.test(String(err?.message)), "no internal error text in the answer");
  }

  // A real pixel bomb (150 KB PNG declaring 30000x30000) is refused before the
  // engine decodes it: no memory growth to speak of (it grew the process by
  // about 400 MB before the check).
  {
    const W = 30000, H = 30000, row = Math.ceil(W / 8) + 1;
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
      const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0);
      return Buffer.concat([len, td, c]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 1;
    const raw = Buffer.alloc(row * H, 0xff); for (let y = 0; y < H; y++) raw[y * row] = 0;
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
    const before = process.memoryUsage().rss;
    let peak = before;
    const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
    const { err } = await call({ image: png.toString("base64") });
    clearInterval(t);
    ok(err?.statusCode === 422 && err?.hint === "image-too-large" && err?.width === W, `a ${png.length}-byte PNG declaring 30000x30000 is a 422 image-too-large (got ${err?.statusCode} ${err?.hint})`);
    ok(peak - before < 64 * 1048576, `the refusal grew RSS by under 64 MB (${((peak - before) / 1048576).toFixed(1)} MB)`);
  }

  // An engine fault on an image whose header checked out is the server's: a
  // 500 without the engine's text, never a 422 that blames the caller.
  {
    const good = pngHead(16, 16);
    for (const reason of ["RuntimeError: memory access out of bounds", "RuntimeError: unreachable"]) {
      __ocrTest.inject("ell", { recognize: () => Promise.reject(reason), terminate: async () => {} });
      const { err } = await call({ image: good.toString("base64"), lang: "ell" });
      ok(err?.statusCode === 500, `an engine fault (${reason}) is a 500 (got ${err?.statusCode}: ${String(err?.message).slice(0, 80)})`);
      ok(!/RuntimeError|memory access|unreachable/.test(String(err?.message)), "the 500 carries no engine text");
    }
    __ocrTest.inject("ell", { recognize: () => Promise.reject("RangeError [ERR_OUT_OF_RANGE]: The value of \"offset\" is out of range."), terminate: async () => {} });
    const { err } = await call({ image: good.toString("base64"), lang: "ell" });
    ok(err?.statusCode === 422 && err?.hint === "image-decode-failed" && !/RangeError|ERR_/.test(String(err?.message)), `a reader running past the end of the bytes is a 422 without its text (got ${err?.statusCode})`);
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

    // An RLE BMP whose header checks out and whose runs end early: the BMP
    // reader inside the engine worker runs past the end of the bytes
    // (ERR_OUT_OF_RANGE), a 422 without the reader's text.
    {
      const b = Buffer.alloc(54 + 1024 + 2);
      b.write("BM", 0, "latin1"); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(54 + 1024, 10);
      b.writeUInt32LE(40, 14); b.writeInt32LE(64, 18); b.writeInt32LE(64, 22);
      b.writeUInt16LE(1, 26); b.writeUInt16LE(8, 28); b.writeUInt32LE(1, 30);
      b[54 + 1024] = 4; b[54 + 1025] = 1; // one run of 4, then the bytes end
      const r = await call({ image: b.toString("base64"), lang: "eng" });
      ok(r.err?.statusCode === 422 && r.err?.hint === "image-decode-failed", `a truncated RLE BMP is a 422 (got ${r.err?.statusCode}: ${String(r.err?.message).slice(0, 90)})`);
      ok(!/RangeError|ERR_/.test(String(r.err?.message)), "no reader text in the answer");
    }

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
