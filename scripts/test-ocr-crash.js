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
import { withPushExceptionText } from "../src/prepayment-refusal.js";
import { PUSH_EXCEPTION } from "../src/tempo-push-debts.js";
import { deflateSync, crc32 } from "node:zlib";
import { OCR_TOOLS, OCR_MAX_PIXELS, OCR_MAX_SIDE, OCR_LARGE_PIXELS, OCR_LARGE_QUEUE_MAX, __ocrLargeTest, ocrDownscaleSide, imageFormatOf, checkImageHeader, tessdataInstalled, __ocrTest } from "../src/tools/ocr-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// A wait that never settles empties the event loop and would end the run
// with exit 0 before the summary: an early exit is a failure.
let finished = false;
process.on("exit", (code) => { if (!finished && code === 0) { console.error("FAIL - the run ended before its summary (a wait never settled)"); process.exitCode = 1; } });

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
  // The cap's edge: exactly 64 MP passes the header check, one pixel more is
  // refused with the limits, the image's size and the side to downscale to.
  ok(OCR_MAX_PIXELS === 64_000_000 && OCR_MAX_SIDE === 32_767, "the caps are 64 megapixels and 32,767 pixels a side");
  for (const [w, h] of [[8000, 8000], [16000, 4000], [32000, 2000]]) {
    const r = sizeOf(pngHead(w, h));
    ok(r && !(r instanceof Error) && r.width === w && r.height === h, `exactly 64 MP (${w}x${h}) passes the pre-check (got ${r instanceof Error ? r.message : `${r?.width}x${r?.height}`})`);
  }
  {
    const r = sizeOf(pngHead(12277, 5213)); // 64,000,001 pixels
    ok(r?.statusCode === 422 && r?.hint === "image-too-large", `64 MP plus one pixel (12277x5213) is a 422 image-too-large (got ${r?.statusCode} ${r?.hint})`);
    ok(r?.maxMegapixels === 64 && r?.maxSide === 32767 && r?.width === 12277 && r?.height === 5213 && r?.megapixels === 64,
      `...naming maxMegapixels, maxSide, width, height and megapixels (${JSON.stringify({ maxMegapixels: r?.maxMegapixels, maxSide: r?.maxSide, width: r?.width, height: r?.height, megapixels: r?.megapixels })})`);
    ok(Number.isInteger(r?.downscaleToLongestSide) && r.downscaleToLongestSide < 12277 && r.fix.includes(`at most ${r.downscaleToLongestSide} pixels`) && r.message.includes(r.fix),
      `...and the side to downscale to (${r?.downscaleToLongestSide}), in the fix and the message`);
    ok(!/charged/i.test(r?.message) && /downscaled/.test(r?.howToCallNote || ""), "...with no charge claim of its own (the handler adds it on a route call), and a howToCall note to resend it downscaled");
    // The charge sentence is the shared one, made on a route call only: a
    // skill-pack step runs the handler request-less inside a charged answer.
    const image = pngHead(12277, 5213).toString("base64");
    const onRoute = await ocr.handler({ image }, { headers: {} }).then(() => null, (e) => e);
    ok(onRoute?.statusCode === 422 && /Nothing was charged\.$/.test(onRoute.message) && !("chargeClaim" in onRoute), `on a route call the 422 ends "Nothing was charged." (${onRoute?.message?.slice(-40)})`);
    ok(withPushExceptionText(onRoute?.message, true).includes(`Nothing was charged${PUSH_EXCEPTION}.`), "...which a Tempo push buyer reads with the exception the route binder adds");
    const step = await ocr.handler({ image }).then(() => null, (e) => e);
    ok(step?.statusCode === 422 && !/charged/i.test(step.message), `as a skill-pack step (no request) it makes no charge claim (${step?.message?.slice(-40)})`);
  }
  // The hint's longest side lands under the cap at the image's own aspect
  // ratio, whichever way a resizer rounds the short side, and is the largest
  // such side (one pixel more would not fit).
  {
    const fitsAt = (w, h, side) => {
      const long = Math.max(w, h), short = Math.min(w, h);
      return side <= OCR_MAX_SIDE && side * Math.ceil((short * side) / long) <= OCR_MAX_PIXELS;
    };
    const shapes = [[12277, 5213], [9000, 9000], [12000, 9000], [9000, 12000], [16000, 9000], [30000, 30000], [32767, 32767], [32767, 3000], [40000, 10], [100000, 40000], [65000, 65000], [10001, 6400], [8001, 8000]];
    const bad = [];
    for (const [w, h] of shapes) {
      const side = ocrDownscaleSide(w, h);
      const long = Math.max(w, h), short = Math.min(w, h);
      const fl = Math.floor((short * side) / long), rnd = Math.round((short * side) / long);
      if (!fitsAt(w, h, side) || side * fl > OCR_MAX_PIXELS || side * rnd > OCR_MAX_PIXELS) bad.push(`${w}x${h} -> ${side} does not fit`);
      else if (side < OCR_MAX_SIDE && side < long && fitsAt(w, h, side + 1)) bad.push(`${w}x${h} -> ${side} is not the largest side that fits`);
      else if (w * h <= OCR_MAX_PIXELS && w <= OCR_MAX_SIDE && h <= OCR_MAX_SIDE && side !== long) bad.push(`${w}x${h} already fits but -> ${side}`);
    }
    ok(bad.length === 0, `the downscale side lands under 64 MP for ${shapes.length} aspect ratios, and is the largest that does${bad.length ? `: ${bad.join("; ")}` : ""}`);
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
    const image = png.toString("base64");
    const t0 = process.hrtime.bigint();
    const { err } = await call({ image });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    clearInterval(t);
    ok(err?.statusCode === 422 && err?.hint === "image-too-large" && err?.width === W, `a ${png.length}-byte PNG declaring 30000x30000 is a 422 image-too-large (got ${err?.statusCode} ${err?.hint})`);
    ok(peak - before < 64 * 1048576, `the refusal grew RSS by under 64 MB (${((peak - before) / 1048576).toFixed(1)} MB)`);
    ok(ms < 25, `...refused in ${ms.toFixed(2)} ms, before any decode (under 25 ms)`);
    ok(err?.maxMegapixels === 64 && err?.megapixels === 900 && err?.downscaleToLongestSide === 8000, `...naming 900 megapixels against 64 and a longest side of 8000 (got ${err?.megapixels}, ${err?.downscaleToLongestSide})`);
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

  // --- the large-image slot: one image over 16 MP in the engine at a time ---
  {
    ok(OCR_LARGE_PIXELS === 16_000_000, "the large-image threshold is 16 megapixels");
    const first = await __ocrLargeTest.acquire(50);
    ok(__ocrLargeTest.state().busy, "the first large image takes the slot at once");
    const order = [];
    const second = __ocrLargeTest.acquire(5_000).then((rel) => { order.push("second"); return rel; });
    const third = __ocrLargeTest.acquire(5_000).then((rel) => { order.push("third"); return rel; });
    ok(__ocrLargeTest.state().waiting === OCR_LARGE_QUEUE_MAX, `two more wait for it (waiting ${__ocrLargeTest.state().waiting})`);
    // "At once" is read against the wait it would otherwise serve (the 5 s it
    // asked for) and against the queue: it is refused while both waiters
    // ahead of it still wait.
    const tOver = Date.now();
    const overflow = await __ocrLargeTest.acquire(5_000).then(() => null, (e) => e);
    ok(Date.now() - tOver < 2_500 && order.length === 0 && __ocrLargeTest.state().waiting === OCR_LARGE_QUEUE_MAX && overflow?.statusCode === 503 && overflow.retryAfter === 60 && overflow.shed === true && overflow.hint === "large-image-busy" && !/charged/i.test(overflow.message),
      `past ${OCR_LARGE_QUEUE_MAX} waiting, a large image is a 503 at once with Retry-After 60 (got ${overflow?.statusCode})`);
    first();
    const r2 = await second;
    ok(order.join() === "second" && __ocrLargeTest.state().busy, "release passes the slot to the next waiter, in order");
    r2();
    const r3 = await third;
    r3();
    ok(!__ocrLargeTest.state().busy && __ocrLargeTest.state().waiting === 0, "the last release frees the slot");
    const hold = await __ocrLargeTest.acquire(50);
    const t0 = Date.now();
    const late = await __ocrLargeTest.acquire(80).then(() => null, (e) => e);
    ok(late?.statusCode === 503 && Date.now() - t0 >= 70 && __ocrLargeTest.state().waiting === 0, `a waiter past its wait is a 503 and leaves the queue (after ${Date.now() - t0} ms)`);
    // Through the handler, a large image refused for want of a place says
    // nothing was charged on a route call only.
    {
      const fill = [__ocrLargeTest.acquire(5_000, "ip:192.0.2.1"), __ocrLargeTest.acquire(5_000, "ip:192.0.2.2")].map((p) => p.then((rel) => rel, () => null));
      const image = pngHead(5000, 4000).toString("base64");
      const busyRoute = await ocr.handler({ image }, { headers: {}, ip: "192.0.2.3" }).then(() => null, (e) => e);
      ok(busyRoute?.statusCode === 503 && busyRoute.hint === "large-image-busy" && /Nothing was charged\./.test(busyRoute.message), `on a route call the busy 503 says nothing was charged (${busyRoute?.statusCode})`);
      const busyStep = await ocr.handler({ image }).then(() => null, (e) => e);
      ok(busyStep?.statusCode === 503 && !/charged/i.test(busyStep.message), `as a skill-pack step the busy 503 makes no charge claim (${busyStep?.statusCode})`);
      hold();
      for (const rel of await Promise.all(fill)) if (rel) rel();
    }

    // A small image never waits on the slot; a large one does, and the worker
    // that read it is retired (its grown WASM memory released).
    let terminated = 0;
    const stand = () => ({ recognize: async () => ({ data: { text: "x", lines: [] } }), terminate: async () => { terminated++; } });
    const png16 = pngHead(16, 16);
    __ocrTest.inject("tur", stand());
    const blocker = await __ocrLargeTest.acquire(50);
    const small = await Promise.race([__ocrLargeTest.recognize(png16, "tur", "png", 4_000_000).then(() => "ran"), new Promise((r) => setTimeout(() => r("waited"), 200))]);
    ok(small === "ran", "an image at or under 16 MP runs while the large-image slot is held");
    const big = __ocrLargeTest.recognize(png16, "tur", "png", 16_000_001).then(() => "ran");
    const early = await Promise.race([big, new Promise((r) => setTimeout(() => r("waiting"), 100))]);
    ok(early === "waiting", "an image over 16 MP waits while the slot is held");
    blocker();
    ok(await big === "ran", "...and runs once it is released");
    await new Promise((r) => setTimeout(r, 20));
    ok(terminated === 1 && !__ocrLargeTest.state().busy, `the worker that read the large image is retired (terminated ${terminated}), the slot freed`);

    // The slot passes on only once the retired worker has terminated.
    let terminatedAt = 0;
    __ocrTest.inject("tur", { recognize: async () => ({ data: { text: "x", lines: [] } }), terminate: () => new Promise((r) => setTimeout(() => { terminatedAt = Date.now(); r(); }, 150)) });
    const slow = __ocrLargeTest.recognize(png16, "tur", "png", 16_000_001, "ip:198.51.100.1");
    await new Promise((r) => setImmediate(r));
    const nextAt = await __ocrLargeTest.acquire(5_000, "ip:198.51.100.2").then((rel) => { const at = Date.now(); rel(); return at; });
    await slow;
    ok(terminatedAt > 0 && nextAt >= terminatedAt, `the next large image gets the slot after the retired worker terminated (terminated ${terminatedAt ? "yes" : "no"}, next ${nextAt - terminatedAt} ms after)`);
    ok(!__ocrLargeTest.state().busy && __ocrLargeTest.state().callers === 0, "the slot and every caller's place are free afterwards");
  }

  // --- the large-image slot is admitted per caller ---
  {
    const A = "payer:0x00000000000000000000000000000000000000aa", B = "ip:203.0.113.7", C = "ip:203.0.113.8", D = "ip:203.0.113.9";
    const relA = await __ocrLargeTest.acquire(50, A);
    const a2 = __ocrLargeTest.acquire(5_000, A).then((rel) => rel, (e) => e);
    const a3 = __ocrLargeTest.acquire(5_000, A).then((rel) => rel, (e) => e);
    ok(__ocrLargeTest.state().waiting === OCR_LARGE_QUEUE_MAX, "one caller alone may hold the slot and both queued places");
    const b1 = __ocrLargeTest.acquire(5_000, B).then((rel) => rel, (e) => e);
    const shed = await a3;
    ok(shed?.statusCode === 503 && !/charged/i.test(shed.message) && __ocrLargeTest.state().waiting === OCR_LARGE_QUEUE_MAX, `a caller with nothing in the slot takes the last queued place of a caller holding several (that one answered ${shed?.statusCode})`);
    const c1 = __ocrLargeTest.acquire(5_000, C).then((rel) => rel, (e) => e);
    const shed2 = await a2;
    ok(shed2?.statusCode === 503 && __ocrLargeTest.state().waiting === OCR_LARGE_QUEUE_MAX, `a second newcomer takes the caller's queued place too, while it holds the slot (that one answered ${shed2?.statusCode})`);
    const d1 = await __ocrLargeTest.acquire(5_000, D).then(() => null, (e) => e);
    ok(d1?.statusCode === 503, `a newcomer is refused only when every queued place is a caller's only one (got ${d1?.statusCode})`);
    relA();
    const rb = await b1;
    ok(typeof rb === "function" && __ocrLargeTest.state().holder === B, "the first newcomer's image is read next, in order");
    rb();
    const rc = await c1;
    ok(typeof rc === "function" && __ocrLargeTest.state().holder === C, "then the second's");
    rc();
    ok(!__ocrLargeTest.state().busy && __ocrLargeTest.state().callers === 0, "every place is released");
    // The caller is read from the request: a signed payer first, else the address.
    let seen = null;
    __ocrTest.inject("tur", { recognize: async () => { seen = __ocrLargeTest.state().holder; return { data: { text: "x", lines: [] } }; }, terminate: async () => {} });
    const big = pngHead(4100, 4100);
    const tool = OCR_TOOLS.find((t) => t.slug === "image-ocr");
    await tool.handler({ image: big.toString("base64"), lang: "tur" }, { ip: D.slice(3), headers: {} }).catch(() => {});
    ok(seen === D, `a large image's place is held for the caller's address when no payer is signed (held for ${seen})`);
    // An in-process executor calls the handler with no request: the place is
    // held for the caller that dispatched the step (runAsCallerOf), and with
    // no caller at all under one shared key, never uncounted.
    const { runAsCallerOf, IN_PROCESS_CALLER } = await import("../src/dispatch-caller.js");
    seen = null;
    __ocrTest.inject("tur", { recognize: async () => { seen = __ocrLargeTest.state().holder; return { data: { text: "x", lines: [] } }; }, terminate: async () => {} });
    await runAsCallerOf({ ip: C.slice(3), headers: {} }, () => tool.handler({ image: big.toString("base64"), lang: "tur" })).catch(() => {});
    ok(seen === C, `a step dispatched without a request holds its place for the dispatching caller (held for ${seen})`);
    seen = null;
    __ocrTest.inject("tur", { recognize: async () => { seen = __ocrLargeTest.state().holder; return { data: { text: "x", lines: [] } }; }, terminate: async () => {} });
    await tool.handler({ image: big.toString("base64"), lang: "tur" }).catch(() => {});
    ok(seen === IN_PROCESS_CALLER, `a call with no caller at all is held under the shared key (held for ${seen})`);
    // The caller key reads the identity payer: in FREE_MODE no payment header
    // is verified, so a typed x-payment naming a wallet never changes the key.
    {
      const { callerKeyOf } = await import("../src/dispatch-caller.js");
      const forged = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: { authorization: { from: "0x" + "ab".repeat(20) } } })).toString("base64");
      const withHeader = (ip) => ({ ip, headers: { "x-payment": forged }, header: (n) => (String(n).toLowerCase() === "x-payment" ? forged : undefined) });
      const had = process.env.FREE_MODE;
      try {
        process.env.FREE_MODE = "true";
        ok(callerKeyOf(withHeader("198.51.100.40")) === "ip:198.51.100.40" && callerKeyOf({ ip: "198.51.100.40", headers: {} }) === "ip:198.51.100.40", `in FREE_MODE a forged x-payment does not change the caller key (${callerKeyOf(withHeader("198.51.100.40"))})`);
        delete process.env.FREE_MODE;
        ok(callerKeyOf(withHeader("198.51.100.40")) === `payer:0x${"ab".repeat(20)}`, `control: on a paid deployment, where the gate verified it, the signed payer is the key (${callerKeyOf(withHeader("198.51.100.40"))})`);
      } finally { if (had === undefined) delete process.env.FREE_MODE; else process.env.FREE_MODE = had; }
    }
    // A skill pack runs its steps request-less too: each step's place is held
    // for the caller that bought the pack, never under the shared key.
    {
      const { buildSkillTools } = await import("../src/tools/skill-runner.js");
      const { SKILL_PACKS } = await import("../src/skills.js");
      const pack = SKILL_PACKS[0];
      const holders = [];
      const probe = async () => {
        __ocrTest.inject("tur", { recognize: async () => { holders.push(__ocrLargeTest.state().holder); return { data: { text: "x", lines: [] } }; }, terminate: async () => {} });
        return tool.handler({ image: big.toString("base64"), lang: "tur" });
      };
      const inlineHandlers = Object.fromEntries(pack.toolSlugs.map((s) => [s, probe]));
      const packTool = buildSkillTools({ getCatalog: () => ({}), inlineHandlers }).find((t) => t.slug === `skill-${pack.slug}`);
      await packTool.handler(packTool.discovery.input, { ip: D.slice(3), headers: {} }).catch(() => {});
      ok(holders.length > 0 && holders.every((h) => h === D), `a skill pack's steps hold their places for the caller that bought the pack (${holders.length} steps, held for ${[...new Set(holders)].join(", ")})`);
      // Every generic dispatch (the HTTP route and the hosted MCP connector)
      // runs the handler inside its caller's key, so any tool that calls other
      // tools' handlers in-process passes the caller on.
      const { readFileSync } = await import("node:fs");
      const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
      const mcp = readFileSync(new URL("../src/mcp-http.js", import.meta.url), "utf8");
      ok(!/[^>] tool\.handler\(input, req\)/.test(server.replace(/runAsCallerOf\(req, \(\) => tool\.handler\(input, req\)\)/g, "")) && /runAsCallerOf\(req, \(\) => tool\.handler\(input, req\)\)/.test(server), "the HTTP tool route runs every handler inside its caller's key");
      ok(/runAsCallerOf\(callReq, \(\) => entry\.def\.handler\(params, callReq\)\)/.test(mcp) && !/await entry\.def\.handler\(/.test(mcp), "the MCP connector runs every handler inside its caller's key");
    }
    // Request-less places fill the slot and both queued places: they are
    // counted, so a named newcomer still takes the last queued one.
    const relU = await __ocrLargeTest.acquire(50);
    const u2 = __ocrLargeTest.acquire(5_000).then((rel) => rel, (e) => e);
    const u3 = __ocrLargeTest.acquire(5_000).then((rel) => rel, (e) => e);
    const n1 = __ocrLargeTest.acquire(5_000, B).then((rel) => rel, (e) => e);
    const shedU = await Promise.race([u3, new Promise((r) => setTimeout(() => r("still queued"), 300))]);
    ok(shedU?.statusCode === 503 && __ocrLargeTest.state().waiting === OCR_LARGE_QUEUE_MAX, `a named newcomer takes the last queued place of request-less calls holding the slot and the queue (that one answered ${shedU?.statusCode || shedU})`);
    relU();
    const ru2 = await u2; ru2(); const rn1 = await n1;
    ok(typeof rn1 === "function", "and its image is read in turn");
    rn1();
    ok(!__ocrLargeTest.state().busy && __ocrLargeTest.state().callers === 0, "every request-less place is released");
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

  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
