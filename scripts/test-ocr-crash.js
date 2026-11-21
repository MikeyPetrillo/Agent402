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
// (5) Turns in the engines (src/caller-turns.js): images are read in turn
//     across callers, not requests; one image holds an engine for a bounded
//     time and gives way once another caller's image has waited a turn; an
//     abandoned or failing image frees its turn at once; the line is bounded
//     and the caller that holds places is the one answered busy. The first
//     block there is the reproduction: one party's three wallets on three
//     addresses keep a slow large image in the engine and two more waiting,
//     and another payer's large image is still read.
//
// Needs the language data (scripts/fetch-tessdata.js); under CI a missing
// engine fails, elsewhere it skips the engine-backed assertions.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { Jimp } from "jimp";
import { withPushExceptionText } from "../src/prepayment-refusal.js";
import { PUSH_EXCEPTION } from "../src/tempo-push-debts.js";
import { deflateSync, crc32 } from "node:zlib";
import { OCR_TOOLS, OCR_MAX_PIXELS, OCR_MAX_SIDE, OCR_LARGE_PIXELS, OCR_LARGE_QUEUE_MAX, OCR_LARGE_WAIT_MS, OCR_LARGE_RETIRE_WAIT_MS, OCR_TURN_MS, OCR_RUN_MAX_MS, OCR_QUEUE_MAX, OCR_QUEUE_MAX_BYTES, OCR_UNPAID_WEIGHT, OCR_WORKER_MAX, __ocrLargeTest, ocrDownscaleSide, imageFormatOf, checkImageHeader, tessdataInstalled, __ocrTest } from "../src/tools/ocr-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// A wait that never settles empties the event loop and would end the run
// with exit 0 before the summary: an early exit is a failure.
let finished = false;
process.on("exit", (code) => { if (!finished && code === 0) { console.error("FAIL - the run ended before its summary (a wait never settled)"); process.exitCode = 1; } });

// A wait that never settles while a timer keeps the loop alive would run to
// the job's limit instead: the suite takes well under a minute, so past four
// it is ended as a failure.
setTimeout(() => { console.error("FAIL - the suite ran past four minutes (a wait never settled)"); process.exit(1); }, 240_000).unref();

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

  // --- turns in the engines (src/caller-turns.js) ---
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const L = __ocrLargeTest;
  /** A turn's release function, or the refusal. */
  const got = (p) => p.then((rel) => rel, (e) => e);
  const settledWithin = (p, ms, pending = "pending") => Promise.race([p, sleep(ms).then(() => pending)]);
  /** Release each turn in the order given (each must be granted in that order). */
  const releaseAll = async (list) => { for (const p of list) { const rel = await p; if (typeof rel === "function") rel(); } };
  /** Release every turn as it is granted, whatever the order. */
  const drain = (list) => Promise.all(list.map((p) => Promise.resolve(p).then((rel) => { if (typeof rel === "function") rel(); }, () => {})));
  const forged = (from) => Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: { authorization: { from } } })).toString("base64");
  const wallet = (n) => "0x" + n.toString(16).padStart(40, "0");
  /** A paid request: its caller is the signed payer, then the address. */
  const paidReq = (from, ip) => { const h = forged(from); return { ip, headers: { "x-payment": h }, header: (n) => (String(n).toLowerCase() === "x-payment" ? h : undefined) }; };
  /** The keys such a request is admitted under. */
  const payer = (n, ip) => [`payer:${wallet(n)}`, `ip:${ip}`];
  const pngHeadB64 = (w, h) => pngHead(w, h).toString("base64");
  const hadFreeMode = process.env.FREE_MODE;
  delete process.env.FREE_MODE; // the gate verified the payment: the signed payer is the caller

  // --- the reproduction: one party's wallets and addresses, each with a slow
  // large image in the engine or waiting, against another payer's large image.
  // (Before fair turns the other payer was answered 503 at once, for as long
  // as the party kept sending.)
  {
    L.reset?.();
    const restore = L.limits?.({ turnMs: 150, waitMs: 3_000, runMaxMs: 5_000, retireMs: 200 }) ?? (() => {});
    const SLOW = 4200, QUICK = 4100;
    const widthOf = (buf) => buf.readUInt32BE(16);
    __ocrTest.inject("tur", {
      recognize: (buf) => new Promise((r) => setTimeout(() => r({ data: { text: widthOf(buf) === SLOW ? "slow" : "read", lines: [] } }), widthOf(buf) === SLOW ? 1_200 : 5)),
      terminate: async () => {},
    });
    const slow = pngHeadB64(SLOW, SLOW), quick = pngHeadB64(QUICK, QUICK);
    const party = [1, 2, 3].map((n) => paidReq(wallet(0xa0 + n), `203.0.113.${n}`));
    const honest = paidReq(wallet(0xb0), "198.51.100.200");
    let stop = false;
    const partyGot = [];
    const loops = party.map(async (req) => {
      while (!stop) {
        const st = await ocr.handler({ image: slow, lang: "tur" }, req).then(() => 200, (e) => e.statusCode);
        partyGot.push(st);
        if (st !== 200) await sleep(10);
      }
    });
    await sleep(80); // the party holds the engine and two more of its images wait
    const t0 = Date.now();
    const first = await ocr.handler({ image: quick, lang: "tur" }, honest).then((r) => r, (e) => e);
    const firstMs = Date.now() - t0;
    ok(first?.text === "read" && firstMs <= 3 * (150 + 200) + 400,
      `while one party's three wallets on three addresses keep a slow large image in the engine and two more waiting, another payer's large image is read, within a turn for each caller ahead of it (answered ${first?.statusCode ?? 200} after ${firstMs} ms)`);
    const waits = [];
    for (let i = 0; i < 6; i++) {
      await sleep(60);
      const t = Date.now();
      const r = await ocr.handler({ image: quick, lang: "tur" }, honest).then((x) => x, (e) => e);
      waits.push({ read: r?.text === "read", ms: Date.now() - t, status: r?.statusCode ?? 200 });
    }
    ok(waits.every((w) => w.read && w.ms <= 150 + 200 + 250),
      `...and while the party keeps sending, each of its next six is read within one turn (150 ms) and the engine's retirement of asking (${waits.map((w) => `${w.status}/${w.ms}ms`).join(", ")})`);
    stop = true;
    await Promise.all(loops);
    ok(partyGot.length > 0 && partyGot.every((st) => st === 503 || st === 200) && !L.state().busy && L.state().callers === 0, `the party's images that outran their turn were answered 503 (retryable, uncharged), never an engine fault, and every place is free afterwards (${[...new Set(partyGot)].join(", ")})`);
    restore();
  }

  // --- one image over 16 MP in an engine at a time (one caller alone) ---
  {
    L.reset();
    ok(OCR_LARGE_PIXELS === 16_000_000, "the large-image threshold is 16 megapixels");
    const first = await L.acquire(50);
    ok(L.state().busy, "the first large image takes the engine at once");
    const order = [];
    const second = L.acquire(5_000).then((rel) => { order.push("second"); return rel; });
    const third = L.acquire(5_000).then((rel) => { order.push("third"); return rel; });
    ok(L.state().waiting === 2, `two more wait for it (waiting ${L.state().waiting})`);
    // The line is bounded: past OCR_LARGE_QUEUE_MAX waiting, the caller that
    // holds them all is answered at once.
    const more = [];
    for (let i = 2; i < OCR_LARGE_QUEUE_MAX; i++) more.push(got(L.acquire(5_000)));
    const tOver = Date.now();
    const overflow = await L.acquire(5_000).then(() => null, (e) => e);
    ok(OCR_LARGE_QUEUE_MAX === 8 && Date.now() - tOver < 2_500 && order.length === 0 && L.state().waiting === OCR_LARGE_QUEUE_MAX && overflow?.statusCode === 503 && overflow.retryAfter === 60 && overflow.shed === true && overflow.hint === "large-image-busy" && !/charged/i.test(overflow.message),
      `past ${OCR_LARGE_QUEUE_MAX} waiting, the caller holding them is a 503 at once with Retry-After 60 (got ${overflow?.statusCode})`);
    first();
    const r2 = await second;
    ok(order.join() === "second" && L.state().busy, "release passes the engine to the next waiter, in order");
    r2();
    const r3 = await third;
    r3();
    await releaseAll(more);
    ok(!L.state().busy && L.state().waiting === 0, "the last release frees the engine");
    const hold = await L.acquire(50);
    const t0 = Date.now();
    const late = await L.acquire(80).then(() => null, (e) => e);
    ok(late?.statusCode === 503 && Date.now() - t0 >= 70 && L.state().waiting === 0, `a waiter past its wait is a 503 and leaves the line (after ${Date.now() - t0} ms)`);
    // Through the handler, a large image refused for want of a place says
    // nothing was charged on a route call only. Every waiting place here is
    // the only one its caller holds, so nobody gives way.
    {
      const fill = Array.from({ length: OCR_LARGE_QUEUE_MAX }, (_, i) => got(L.acquire(5_000, `ip:192.0.2.${i + 1}`)));
      const image = pngHeadB64(5000, 4000);
      const busyRoute = await ocr.handler({ image }, { headers: {}, ip: "192.0.2.200" }).then(() => null, (e) => e);
      ok(busyRoute?.statusCode === 503 && busyRoute.hint === "large-image-busy" && /Nothing was charged\./.test(busyRoute.message), `on a route call the busy 503 says nothing was charged (${busyRoute?.statusCode})`);
      const busyStep = await ocr.handler({ image }).then(() => null, (e) => e);
      ok(busyStep?.statusCode === 503 && !/charged/i.test(busyStep.message), `as a skill-pack step the busy 503 makes no charge claim (${busyStep?.statusCode})`);
      hold();
      await releaseAll(fill);
    }

    // A small image never waits on the large engine; a large one does, in an
    // engine of its own that is terminated when the image is done (its grown
    // WASM memory released), while the language's worker stays warm.
    let terminated = 0;
    const stand = () => ({ recognize: async () => ({ data: { text: "x", lines: [] } }), terminate: async () => { terminated++; } });
    const png16 = pngHead(16, 16);
    __ocrTest.inject("tur", stand());
    const blocker = await L.acquire(50);
    const small = await Promise.race([L.recognize(png16, "tur", "png", 4_000_000).then(() => "ran"), sleep(200).then(() => "waited")]);
    ok(small === "ran", "an image at or under 16 MP runs while the large-image engine is held");
    const big = L.recognize(png16, "tur", "png", 16_000_001).then(() => "ran");
    const early = await Promise.race([big, sleep(100).then(() => "waiting")]);
    ok(early === "waiting", "an image over 16 MP waits while the engine is held");
    blocker();
    ok(await big === "ran", "...and runs once it is released");
    await sleep(20);
    ok(terminated === 1 && !L.state().busy, `the engine that read the large image is terminated (terminated ${terminated}), its turn freed`);
    ok(__ocrTest.workerCount() === 1, `the language's own worker stays warm for smaller images (${__ocrTest.workerCount()} engine held)`);

    // The turn passes on only once the large image's engine has terminated.
    let terminatedAt = 0;
    __ocrTest.inject("tur", { recognize: async () => ({ data: { text: "x", lines: [] } }), terminate: () => new Promise((r) => setTimeout(() => { terminatedAt = Date.now(); r(); }, 150)) });
    const slow = L.recognize(png16, "tur", "png", 16_000_001, "ip:198.51.100.1");
    await new Promise((r) => setImmediate(r));
    const nextAt = await L.acquire(5_000, "ip:198.51.100.2").then((rel) => { const at = Date.now(); rel(); return at; });
    await slow;
    ok(terminatedAt > 0 && nextAt >= terminatedAt, `the next large image gets the engine after the first one's engine terminated (terminated ${terminatedAt ? "yes" : "no"}, next ${nextAt - terminatedAt} ms after)`);
    ok(!L.state().busy && L.state().callers === 0, "the engine and every caller's place are free afterwards");
  }

  // --- whose turn: across callers, not requests ---
  {
    L.reset();
    // One caller's later images wait behind another caller's image that
    // arrived before its first one ended.
    const A = "payer:0x00000000000000000000000000000000000000aa", B = "ip:203.0.113.7", C = "ip:203.0.113.8";
    {
      const relA = await L.acquire(50, A);
      const order = [];
      const a2 = L.acquire(5_000, A).then((rel) => { order.push("a2"); return rel; });
      const a3 = L.acquire(5_000, A).then((rel) => { order.push("a3"); return rel; });
      await sleep(10);
      const b1 = L.acquire(5_000, B).then((rel) => { order.push("b1"); return rel; });
      await sleep(20);
      relA();
      (await b1)(); (await a2)(); (await a3)();
      ok(order.join() === "b1,a2,a3", `a caller that queued two more images behind its first is read after another caller's image that came later (${order.join()})`);
    }
    // Callers with one image each are read in the order they arrived.
    {
      const hold = await L.acquire(50, A);
      const order = [];
      const b = L.acquire(5_000, B).then((rel) => { order.push("b"); return rel; });
      await sleep(5);
      const c = L.acquire(5_000, C).then((rel) => { order.push("c"); return rel; });
      await sleep(5);
      hold();
      (await b)(); (await c)();
      ok(order.join() === "b,c", `callers with one image each are read in arrival order (${order.join()})`);
    }
    // Several wallets behind one address share that address's time; one
    // wallet used from several addresses shares the wallet's.
    {
      const X = "198.51.100.77";
      const w1 = await L.acquire(50, payer(1, X));
      const order = [];
      const w2 = L.acquire(5_000, payer(2, X)).then((rel) => { order.push("second wallet, same address"); return rel; });
      await sleep(10);
      const other = L.acquire(5_000, payer(3, "198.51.100.88")).then((rel) => { order.push("another caller"); return rel; });
      await sleep(20);
      w1();
      (await other)(); (await w2)();
      ok(order[0] === "another caller", `a second wallet behind the address whose image just ran waits behind another caller's image that came later (${order.join(" then ")})`);
      const v1 = await L.acquire(50, payer(4, "198.51.100.90"));
      const order2 = [];
      const v2 = L.acquire(5_000, payer(4, "198.51.100.91")).then((rel) => { order2.push("same wallet, second address"); return rel; });
      await sleep(10);
      const other2 = L.acquire(5_000, payer(5, "198.51.100.92")).then((rel) => { order2.push("another caller"); return rel; });
      await sleep(20);
      v1();
      (await other2)(); (await v2)();
      ok(order2[0] === "another caller", `one wallet used from a second address waits behind another caller's image that came later (${order2.join(" then ")})`);
    }
    // Engine time that ended without an answer counts OCR_UNPAID_WEIGHT times.
    {
      ok(OCR_UNPAID_WEIGHT === 4, "engine time that ended unanswered counts four times");
      const run = async (unpaid) => {
        L.reset();
        const a = await L.acquire(50, A);
        await sleep(60);
        a({ unpaid }); // A held the engine 60 ms
        const z = await L.acquire(50, "ip:203.0.113.99");
        const order = [];
        const a2 = L.acquire(5_000, A).then((rel) => { order.push("a2"); return rel; });
        await sleep(40);
        const c = L.acquire(5_000, C).then((rel) => { order.push("c"); return rel; });
        await sleep(10);
        z();
        await drain([a2, c]);
        return order.join();
      };
      const unpaid = await run(true), paid = await run(false);
      ok(unpaid === "c,a2", `a caller whose image left the engine unanswered stands behind a caller that arrives after it (${unpaid})`);
      ok(paid === "a2,c", `control: after an answered image the same caller keeps its arrival order (${paid})`);
    }
    // A call that waited out its time keeps its place in line for its retry.
    {
      L.reset();
      const hold = await L.acquire(50, A);
      const early = await L.acquire(40, B).then(() => null, (e) => e);
      const order = [];
      const c = L.acquire(5_000, C).then((rel) => { order.push("c"); return rel; });
      await sleep(10);
      const again = L.acquire(5_000, B).then((rel) => { order.push("b"); return rel; });
      await sleep(10);
      hold();
      (await again)(); (await c)();
      ok(early?.statusCode === 503 && order.join() === "b,c", `a caller answered busy after its wait stands, on its retry, ahead of a caller that arrived in between (${early?.statusCode}; ${order.join()})`);
      ok(!L.state().busy && L.state().callers === 0, "every place is released");
    }
  }

  // --- a full line: who gives way ---
  {
    L.reset();
    const fillWith = (who) => Array.from({ length: OCR_LARGE_QUEUE_MAX }, (_, i) => got(L.acquire(5_000, who(i))));
    const refusedNow = async (p) => { const r = await settledWithin(got(p), 150, "queued"); return r === "queued" ? { queued: p } : r; };
    // One caller holds the engine and every waiting place: a newcomer takes
    // its newest place, a second newcomer its next, and the caller itself is
    // the one answered busy.
    {
      const A = "payer:0x00000000000000000000000000000000000000aa";
      const hold = await L.acquire(50, A);
      const line = fillWith(() => A);
      const b = L.acquire(5_000, "ip:203.0.113.7");
      const shed = await settledWithin(line[OCR_LARGE_QUEUE_MAX - 1], 200);
      ok(shed?.statusCode === 503 && !/charged/i.test(shed.message) && L.state().waiting === OCR_LARGE_QUEUE_MAX, `a caller with nothing in the line takes the newest waiting place of a caller holding several (that one answered ${shed?.statusCode ?? shed})`);
      const c = L.acquire(5_000, "ip:203.0.113.8");
      const shed2 = await settledWithin(line[OCR_LARGE_QUEUE_MAX - 2], 200);
      ok(shed2?.statusCode === 503, `a second newcomer takes the next (${shed2?.statusCode ?? shed2})`);
      const more = await L.acquire(5_000, A).then(() => null, (e) => e);
      ok(more?.statusCode === 503, `the caller that holds places is the one refused when the line is full (${more?.statusCode})`);
      hold();
      const rb = await b;
      ok(L.state().holder === "ip:203.0.113.7", "the first newcomer's image is read next: it arrived before the holder's image ended");
      rb(); (await c)();
      await releaseAll(line);
      ok(!L.state().busy && L.state().callers === 0, "every place is released");
    }
    // Several wallets on ONE address, one place each: a caller that holds
    // nothing under any key takes the newest of that address's places. (This
    // party held the engine and the whole line before.)
    {
      const X = "198.51.100.120";
      const hold = await L.acquire(50, payer(100, X));
      const line = fillWith((i) => payer(101 + i, X));
      const fresh = await refusedNow(L.acquire(5_000, payer(200, "198.51.100.121")));
      const shed = await settledWithin(line[OCR_LARGE_QUEUE_MAX - 1], 200);
      ok(fresh.queued && shed?.statusCode === 503 && L.state().waiting === OCR_LARGE_QUEUE_MAX, `several wallets on one address are one party at a full line: a new payer from a new address takes that address's newest place (newcomer ${fresh.queued ? "queued" : fresh.statusCode}; the address's newest ${shed?.statusCode ?? shed})`);
      // A payer whose address already holds places takes none from the others there.
      const neighbor = await refusedNow(L.acquire(5_000, payer(300, X)));
      ok(neighbor?.statusCode === 503, `a payer whose address already holds places takes none from the others there (${neighbor?.statusCode ?? "queued"})`);
      hold();
      (await fresh.queued)();
      await releaseAll(line);
      ok(!L.state().busy && L.state().callers === 0, "every place is released");
    }
    // Every waiting place its caller's only one, under every key, and ahead
    // of the newcomer: nobody gives way and it is answered busy. It keeps its
    // place in line: on its retry it takes the place of a call that came
    // after it, and is read before it.
    {
      L.reset();
      const hold = await L.acquire(50, payer(400, "203.0.113.100"));
      const line = fillWith((i) => payer(401 + i, `203.0.113.${101 + i}`));
      const late = payer(500, "203.0.113.200");
      const refused = await L.acquire(5_000, late).then(() => null, (e) => e);
      ok(refused?.statusCode === 503 && refused.retryAfter === 60 && L.state().waiting === OCR_LARGE_QUEUE_MAX, `a newcomer is refused only when every waiting place is its caller's only one under every key and stands ahead of it (got ${refused?.statusCode})`);
      const again = await L.acquire(5_000, late).then(() => null, (e) => e);
      ok(again?.statusCode === 503 && L.state().waiting === OCR_LARGE_QUEUE_MAX, `...and again while they all still wait (got ${again?.statusCode})`);
      hold();
      const head = await line[0]; // the first in line is in the engine; its place in line frees
      const after = got(L.acquire(5_000, payer(501, "203.0.113.201")));
      await sleep(5);
      ok(L.state().waiting === OCR_LARGE_QUEUE_MAX, "a caller that came later takes the free place: the line is full again");
      const back = L.acquire(5_000, late);
      const bumped = await settledWithin(after, 200, "still queued");
      ok(bumped?.statusCode === 503 && L.state().waiting === OCR_LARGE_QUEUE_MAX, `the caller refused earlier comes back and takes the place of the one that came after it (that one answered ${bumped?.statusCode ?? bumped})`);
      head();
      await releaseAll(line.slice(1));
      const rBack = await settledWithin(got(back), 500);
      ok(typeof rBack === "function", "and its image is read once the callers that stood ahead of it have been");
      if (typeof rBack === "function") rBack();
      // The one that gave up its place kept it too: it stands where it stood.
      const hold2 = await L.acquire(50, payer(600, "203.0.113.210"));
      const order = [];
      const newer = L.acquire(5_000, payer(601, "203.0.113.211")).then((rel) => { order.push("newer"); return rel; });
      await sleep(5);
      const bumpedBack = L.acquire(5_000, payer(501, "203.0.113.201")).then((rel) => { order.push("gave up its place"); return rel; });
      await sleep(5);
      hold2();
      await drain([newer, bumpedBack]);
      ok(order.join() === "gave up its place,newer", `a call that gave up its place stands, on its retry, where it stood (${order.join()})`);
      ok(!L.state().busy && L.state().callers === 0, "every place is released");
    }
    // The line is bounded by the bytes its waiting images hold too.
    {
      L.reset();
      ok(OCR_QUEUE_MAX === 64 && OCR_QUEUE_MAX_BYTES === 96 * 1024 * 1024, "at most 64 images wait in all, holding at most 96 MB between them");
      const A = "ip:203.0.113.30";
      const hold = await L.acquire(50, A);
      const big = 40 * 1024 * 1024;
      const a1 = got(L.acquire(5_000, A, big)), a2 = got(L.acquire(5_000, A, big));
      const a3 = await L.acquire(5_000, A, big).then(() => null, (e) => e);
      ok(a3?.statusCode === 503 && L.state().queuedBytes === 2 * big, `a third 40 MB image from the caller holding the other two is refused (${a3?.statusCode}; ${L.state().queuedBytes / 1048576} MB waiting)`);
      const b = L.acquire(5_000, "ip:203.0.113.31", big);
      const shed = await settledWithin(a2, 200);
      ok(shed?.statusCode === 503 && L.state().queuedBytes === 2 * big, `another caller's image takes the newest of them (${shed?.statusCode ?? shed})`);
      hold();
      (await b)();
      await releaseAll([a1]);
      ok(!L.state().busy && L.state().callers === 0 && L.state().queuedBytes === 0, "the bytes leave the line with their images");
    }
    // Shared egress: buyers behind one address (a NAT, a hosted agent
    // platform, an IPv6 /64) share its ip: key, but each is its own caller.
    {
      const { callerKeysOf, admissionCallerOf } = await import("../src/dispatch-caller.js");
      const X = "198.51.100.77";
      const paid = (n, ip = X) => ({ ip, headers: {}, creditsKeyId: `k${n}` });
      ok(JSON.stringify(callerKeysOf(paid(1))) === JSON.stringify(["credits:k1", `ip:${X}`]), `a request's caller keys are its credential and its address (${JSON.stringify(callerKeysOf(paid(1)))})`);
      ok(JSON.stringify(admissionCallerOf(paid(1))) === JSON.stringify(callerKeysOf(paid(1))), "admission holds a place under every one of them");
      // One credential is one caller from several addresses: its newest place
      // is taken by a newcomer.
      L.reset();
      const r1 = await L.acquire(50, admissionCallerOf(paid(5, "198.51.100.10")));
      const line = fillWith((i) => admissionCallerOf(paid(5, `198.51.100.${11 + i}`)));
      const nu = L.acquire(5_000, admissionCallerOf(paid(6, "198.51.100.40")));
      const shed5 = await settledWithin(line[OCR_LARGE_QUEUE_MAX - 1], 200, "still queued");
      ok(shed5?.statusCode === 503 && !/charged/i.test(shed5.message), `one credential used from several addresses is one caller: its newest place is taken (${shed5?.statusCode ?? shed5})`);
      r1(); await drain([nu, ...line]);
      // Unsigned callers are told apart by address alone.
      const u0 = await L.acquire(50, admissionCallerOf({ ip: "203.0.113.50", headers: {} }));
      const uLine = fillWith(() => admissionCallerOf({ ip: "203.0.113.51", headers: {} }));
      const un = L.acquire(5_000, admissionCallerOf({ ip: "203.0.113.52", headers: {} }));
      const shedU = await settledWithin(uLine[OCR_LARGE_QUEUE_MAX - 1], 200, "still queued");
      ok(shedU?.statusCode === 503, `an unsigned address's newest waiting place is taken (${shedU?.statusCode ?? shedU})`);
      u0(); await drain([un, ...uLine]);
      // A buyer that shares an address with a caller holding every place
      // under its own credential is a newcomer like any other, and holding a
      // place, its next call takes none.
      const S = "198.51.100.120";
      const h0 = await L.acquire(50, admissionCallerOf(paid(8, S)));
      const hLine = fillWith(() => admissionCallerOf(paid(8, S)));
      const nb = L.acquire(5_000, admissionCallerOf(paid(9, S)));
      const shedH = await settledWithin(hLine[OCR_LARGE_QUEUE_MAX - 1], 200, "still queued");
      const nbNow = await settledWithin(got(nb), 50, "queued");
      ok(shedH?.statusCode === 503 && nbNow === "queued", `a buyer sharing an address with a caller that holds every place takes that caller's newest waiting place (holder's newest: ${shedH?.statusCode ?? shedH}; newcomer: ${nbNow?.statusCode ?? nbNow})`);
      const nb2 = await L.acquire(5_000, admissionCallerOf(paid(9, S))).then(() => null, (e) => e);
      ok(nb2?.statusCode === 503, `...and holding a place, its next call takes none (got ${nb2?.statusCode})`);
      h0(); await drain([nb, ...hLine]);
      ok(!L.state().busy && L.state().callers === 0, "every place is released after the shared-address cases");
      // A CDN request with no proof of its client's address and no signed
      // key names no caller. Such requests share no holding key: each is a
      // newcomer, so one of them holding every place does not lock out the
      // rest, and a keyed newcomer still takes its newest waiting place.
      const { ANONYMOUS_CALLER } = await import("../src/dispatch-caller.js");
      const anon = (edge) => ({ ip: edge, headers: {}, cdnUnproven: true });
      ok(typeof ANONYMOUS_CALLER === "string" && JSON.stringify(admissionCallerOf(anon("203.0.113.70"))) === JSON.stringify([ANONYMOUS_CALLER]) && JSON.stringify(admissionCallerOf(undefined)) !== JSON.stringify([ANONYMOUS_CALLER]), `an unproven, unsigned request is admitted as an anonymous caller, apart from request-less work (${JSON.stringify(admissionCallerOf(anon("203.0.113.70")))})`);
      const a0 = await L.acquire(50, admissionCallerOf(anon("203.0.113.70")));
      const aLine = fillWith(() => admissionCallerOf(anon("203.0.113.70")));
      const an = L.acquire(5_000, admissionCallerOf(anon("203.0.113.71")));
      const shedA = await settledWithin(aLine[OCR_LARGE_QUEUE_MAX - 1], 200, "still queued");
      const anNow = await settledWithin(got(an), 50, "queued");
      ok(shedA?.statusCode === 503 && anNow === "queued", `another unproven request is not refused because one of them holds every place (the newest: ${shedA?.statusCode ?? shedA}; newcomer: ${anNow?.statusCode ?? anNow})`);
      const keyed = L.acquire(5_000, admissionCallerOf(paid(10, "198.51.100.130")));
      const shedK = await settledWithin(got(an), 200, "still queued");
      ok(shedK?.statusCode === 503, `a keyed newcomer takes the anonymous callers' newest waiting place (${shedK?.statusCode ?? shedK})`);
      a0(); await drain([keyed, an, ...aLine]);
      ok(!L.state().busy && L.state().callers === 0, "every place is released after the anonymous cases");
    }
    // Request-less places fill the engine and the line: they are counted, so
    // a named newcomer still takes the newest waiting one.
    {
      const relU = await L.acquire(50);
      const line = fillWith(() => null);
      const n1 = L.acquire(5_000, "ip:203.0.113.7");
      const shedU = await settledWithin(line[OCR_LARGE_QUEUE_MAX - 1], 300, "still queued");
      ok(shedU?.statusCode === 503 && L.state().waiting === OCR_LARGE_QUEUE_MAX, `a named newcomer takes the newest waiting place of request-less calls holding the engine and the line (that one answered ${shedU?.statusCode || shedU})`);
      relU();
      const rn1 = await n1;
      ok(typeof rn1 === "function", "and its image is read in turn");
      rn1();
      await releaseAll(line);
      ok(!L.state().busy && L.state().callers === 0, "every request-less place is released");
    }
  }

  // --- the scheduler on a clock of its own (src/caller-turns.js) ---
  {
    const { createCallerTurns, TurnRefused } = await import("../src/caller-turns.js");
    let t = 1_000_000;
    const room = createCallerTurns({ maxRunning: 2, ticketMs: 1_000, ticketsMax: 2, unpaidWeight: 4, now: () => t });
    const refusal = (p) => p.then(() => null, (e) => e);
    // Giving way: one turn after the later of the run's start and the waiting
    // call's arrival; the runner's own waiting call never counts.
    const a = await room.acquire("x", ["payer:a", "ip:1"], { waitMs: 50 });
    ok(a.yieldAt(300) === Infinity, "with nobody waiting a run is never asked to give way");
    t += 400;
    const own = room.acquire("x", ["payer:a2", "ip:1"], { waitMs: 60_000 });
    ok(a.yieldAt(300) === Infinity, "a waiting call that shares a key with the run (another wallet on its address) never ends it");
    const b = room.acquire("x", "ip:2", { waitMs: 60_000 });
    ok(a.yieldAt(300) === 1_000_400 + 300, `a run that started before another caller's call arrived gives way one turn after that arrival (${a.yieldAt(300) - 1_000_000})`);
    // Unanswered engine time counts four times: the run held 500 ms, so its
    // keys stand at start + 2,000.
    t += 100;
    a.release({ unpaid: true });
    const bTurn = await b;
    ok(room.state("x").holder === "ip:2", "the other caller's call is next, ahead of the run's own second");
    const c = room.acquire("x", ["payer:a", "ip:9"], { waitMs: 60_000 });
    ok(bTurn.yieldAt(300) === 1_002_000 + 300, `a waiting call whose caller's unanswered time puts it later does not end the run before that time and a turn (${bTurn.yieldAt(300) - 1_000_000})`);
    // At most `maxRunning` lanes run: a third lane's call waits, and counts
    // against the runs that hold the engines.
    const y = await room.acquire("y", "ip:3", { waitMs: 50 });
    t += 50;
    const z = room.acquire("z", "ip:4", { waitMs: 60_000 });
    ok(room.state("z").waiting === 1 && room.state("z").running === 2 && y.yieldAt(300) === 1_000_550 + 300, `a call on a third lane waits for an engine and the runs holding them give way to it in a turn (${y.yieldAt(300) - 1_000_000})`);
    y.release();
    (await z).release();
    // At the same instant, a call standing at its own arrival is read before
    // one standing at its caller's earlier time, whichever was queued first.
    t = 1_002_000;
    const served = [];
    const inTurn = (name, p) => p.then((turn) => { served.push(name); turn.release(); });
    const all = [inTurn("own", own), inTurn("c", c), inTurn("arrives now", room.acquire("x", "ip:5", { waitMs: 60_000 }))];
    bTurn.release();
    await Promise.all(all);
    ok(served.join() === "arrives now,own,c", `a call arriving at the instant another caller's earlier time ends is read first (${served.join()})`);
    ok(room.state("x").running === 0 && room.state("x").callers === 0, "the room empties");
    // Tickets: a call with no time to wait is refused and keeps its place;
    // past ticketMs the place is gone; past ticketsMax the ticket that
    // stands last is the one dropped, expired ones first.
    const hold = await room.acquire("x", "ip:10", { waitMs: 50 });
    const r1 = await refusal(room.acquire("x", "ip:11", { waitMs: 0 })); // stands at t
    t += 10;
    const mid = room.acquire("x", "ip:12", { waitMs: 60_000 });
    t += 10;
    const back = room.acquire("x", "ip:11", { waitMs: 60_000 });
    hold.release();
    const backTurn = await back;
    ok(r1 instanceof TurnRefused && r1.why === "wait" && room.state("x").holder === "ip:11", "a refused caller that returns inside the ticket's life stands where it first stood");
    backTurn.release(); (await mid).release();
    const hold2 = await room.acquire("x", "ip:20", { waitMs: 50 });
    await refusal(room.acquire("x", "ip:21", { waitMs: 0 }));
    t += 2_000; // past the ticket's life
    const mid2 = room.acquire("x", "ip:22", { waitMs: 60_000 });
    t += 10;
    const late = room.acquire("x", "ip:21", { waitMs: 60_000 });
    hold2.release();
    const mid2Turn = await mid2;
    ok(room.state("x").holder === "ip:22", "past the ticket's life it stands where it arrives");
    mid2Turn.release(); (await late).release();
    const hold3 = await room.acquire("x", "ip:30", { waitMs: 50 });
    for (const ip of ["ip:31", "ip:32", "ip:33"]) { await refusal(room.acquire("x", ip, { waitMs: 0 })); t += 10; }
    ok(room.state("x").tickets === 2, `at most ticketsMax places are kept (${room.state("x").tickets})`);
    const order = [];
    const newcomer = room.acquire("x", "ip:40", { waitMs: 60_000 }).then((turn) => { order.push("ip:40"); return turn; });
    t += 10;
    const kept = ["ip:33", "ip:31"].map((ip) => room.acquire("x", ip, { waitMs: 60_000 }).then((turn) => { order.push(ip); return turn; }));
    hold3.release();
    for (const p of [kept[1], newcomer, kept[0]]) (await p).release();
    ok(order.join() === "ip:31,ip:40,ip:33", `the ticket dropped at the cap is the one that stood last: the earlier one keeps its place (${order.join()})`);
    ok(room.state("x").running === 0 && room.state("x").callers === 0, "the room empties after the ticket cases");
  }

  // --- an image holds its engine for a bounded time ---
  {
    L.reset();
    ok(OCR_TURN_MS === 30_000 && OCR_RUN_MAX_MS === 120_000 && OCR_LARGE_WAIT_MS === OCR_TURN_MS + OCR_LARGE_RETIRE_WAIT_MS + 5_000, `one image holds an engine 120 s at most, 30 s once another caller's image waits, and a call waits in line one turn and the engine's retirement (${OCR_LARGE_WAIT_MS} ms)`);
    const restore = L.limits({ turnMs: 150, waitMs: 2_000, runMaxMs: 400, retireMs: 200 });
    const big = pngHead(4100, 4100), small = pngHead(16, 16);
    let terminated = 0;
    const never = () => ({ recognize: () => new Promise(() => {}), terminate: async () => { terminated++; } });
    // Alone, a large image that is never read is ended at the run limit: a
    // 422 that says to downscale it, its engine terminated, the turn freed.
    __ocrTest.inject("tur", never());
    let t0 = Date.now();
    const slowRoute = await ocr.handler({ image: big.toString("base64"), lang: "tur" }, { headers: {}, ip: "203.0.113.20" }).then(() => null, (e) => e);
    ok(slowRoute?.statusCode === 422 && slowRoute.hint === "image-too-slow" && Date.now() - t0 >= 380 && Date.now() - t0 < 1_500 && /Downscale or crop/.test(slowRoute.message) && /Nothing was charged\.$/.test(slowRoute.message),
      `an image not read within the run limit is a 422 image-too-slow that says nothing was charged (${slowRoute?.statusCode} ${slowRoute?.hint} after ${Date.now() - t0} ms)`);
    ok(terminated === 1 && !L.state().busy && L.state().callers === 0, `its engine is terminated and its turn freed (terminated ${terminated})`);
    const slowStep = await ocr.handler({ image: big.toString("base64"), lang: "tur" }).then(() => null, (e) => e);
    ok(slowStep?.statusCode === 422 && !/charged/i.test(slowStep.message), "as a skill-pack step it makes no charge claim");
    // A smaller image is held to the same limit, and its language's worker
    // is replaced: the next image in that language is read.
    terminated = 0;
    const slowSmall = await ocr.handler({ image: small.toString("base64"), lang: "tur" }, { headers: {}, ip: "203.0.113.20" }).then(() => null, (e) => e);
    ok(slowSmall?.statusCode === 422 && slowSmall.hint === "image-too-slow" && terminated === 1 && !L.lane("tur").busy, `an image under 16 MP is held to the same limit (${slowSmall?.statusCode}; engine terminated ${terminated})`);
    __ocrTest.inject("tur", { recognize: async () => ({ data: { text: "after", lines: [] } }), terminate: async () => {} });
    const after = await ocr.handler({ image: small.toString("base64"), lang: "tur" }, { headers: {}, ip: "203.0.113.21" });
    ok(after.text === "after", "the next image in that language is read by a fresh worker");

    // While another caller's image waits, the image in the engine keeps it
    // for one turn from that arrival, then gives way with a retryable 503.
    restore();
    const restore2 = L.limits({ turnMs: 150, waitMs: 2_000, runMaxMs: 5_000, retireMs: 200 });
    L.reset();
    let calls = 0;
    __ocrTest.inject("tur", { recognize: () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve({ data: { text: "second", lines: [] } })), terminate: async () => {} });
    t0 = Date.now();
    const holder = ocr.handler({ image: big.toString("base64"), lang: "tur" }, { headers: {}, ip: "203.0.113.22" }).then(() => null, (e) => e);
    await sleep(100);
    const arrived = Date.now();
    const waiter = await ocr.handler({ image: big.toString("base64"), lang: "tur" }, { headers: {}, ip: "203.0.113.23" }).then((r) => r, (e) => e);
    const waitedMs = Date.now() - arrived;
    const gave = await holder;
    ok(waiter?.text === "second" && waitedMs >= 140 && waitedMs <= 150 + 200 + 250, `another caller's large image is read one turn after it arrived (${waiter?.statusCode ?? 200} after ${waitedMs} ms)`);
    ok(gave?.statusCode === 503 && gave.shed === true && gave.retryAfter === 30 && gave.hint === "large-image-busy" && /gave this image's turn/.test(gave.message) && /Nothing was charged\.$/.test(gave.message), `the image that held the engine gives way with a retryable 503 that says nothing was charged (${gave?.statusCode} ${gave?.hint})`);
    // Control: the caller's OWN second image waiting never ends its first.
    L.reset();
    calls = 0;
    __ocrTest.inject("tur", { recognize: () => (++calls === 1 ? new Promise((r) => setTimeout(() => r({ data: { text: "first", lines: [] } }), 500)) : Promise.resolve({ data: { text: "second", lines: [] } })), terminate: async () => {} });
    const same = { headers: {}, ip: "203.0.113.24" };
    const own1 = ocr.handler({ image: big.toString("base64"), lang: "tur" }, same).then((r) => r, (e) => e);
    await sleep(30);
    const own2 = ocr.handler({ image: big.toString("base64"), lang: "tur" }, same).then((r) => r, (e) => e);
    ok((await own1)?.text === "first" && (await own2)?.text === "second", "control: a caller's own waiting image never ends the one it has in the engine; both are read");
    // Control: alone, an image runs past a turn (to the run limit).
    L.reset();
    __ocrTest.inject("tur", { recognize: () => new Promise((r) => setTimeout(() => r({ data: { text: "long", lines: [] } }), 450)), terminate: async () => {} });
    const alone = await ocr.handler({ image: big.toString("base64"), lang: "tur" }, same).then((r) => r, (e) => e);
    ok(alone?.text === "long", `control: with no other caller waiting, an image that needs three turns' time is read (${alone?.statusCode ?? 200})`);
    // A connection that waits less for an answer (the CDN's window) bounds
    // both: a call does not wait in line past it, and a run ends at it.
    L.reset();
    __ocrTest.inject("tur", never());
    t0 = Date.now();
    const windowed = await ocr.handler({ image: big.toString("base64"), lang: "tur" }, { headers: {}, ip: "203.0.113.25", cdnSyncDeadlineMs: Date.now() + 250 }).then(() => null, (e) => e);
    ok(windowed?.statusCode === 422 && windowed.hint === "image-too-slow" && Date.now() - t0 < 1_200, `a run ends when its own connection's answer window does (${windowed?.statusCode} after ${Date.now() - t0} ms)`);
    const holdW = await L.acquire(50, "ip:203.0.113.26");
    t0 = Date.now();
    const noWait = await ocr.handler({ image: big.toString("base64"), lang: "tur" }, { headers: {}, ip: "203.0.113.27", cdnSyncDeadlineMs: Date.now() + 3_000 }).then(() => null, (e) => e);
    ok(noWait?.statusCode === 503 && noWait.hint === "large-image-busy" && Date.now() - t0 < 500, `a call whose connection leaves no time to read it after a wait is answered busy at once (${noWait?.statusCode} after ${Date.now() - t0} ms)`);
    holdW();
    restore2();
    // A payment authorization that will have expired bounds the run the same
    // way: it ends while the payment could still settle. In FREE_MODE no
    // payment header is verified, so a typed one bounds nothing.
    {
      const restore3 = L.limits({ turnMs: 150, waitMs: 2_000, runMaxMs: 2_000, retireMs: 200 });
      const { SETTLE_RULE_SECONDS, SETTLE_MARGIN_SECONDS } = await import("../src/evm-validity.js");
      const authorized = (validForSeconds, ip) => {
        const h = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network: "eip155:8453" }, payload: { authorization: { from: wallet(0xd0), validBefore: String(Math.floor(Date.now() / 1000) + validForSeconds) } } })).toString("base64");
        return { ip, headers: { "payment-signature": h }, header: (n) => (String(n).toLowerCase() === "payment-signature" ? h : undefined) };
      };
      __ocrTest.inject("tur", never());
      const run = async (req) => { const t = Date.now(); const e = await ocr.handler({ image: big.toString("base64"), lang: "tur" }, req).then(() => null, (x) => x); return { status: e?.statusCode, hint: e?.hint, ms: Date.now() - t, message: String(e?.message) }; };
      // One second of settleable life at most: the facilitator's rule and the settle margin come off first.
      const short = await run(authorized(SETTLE_RULE_SECONDS + SETTLE_MARGIN_SECONDS + 1, "203.0.113.28"));
      ok(short.status === 422 && short.hint === "image-too-slow" && short.ms < 1_300 && /payment authorization/.test(short.message), `a run ends while its payment authorization can still settle (${short.status} after ${short.ms} ms)`);
      const long = await run(authorized(300, "203.0.113.29"));
      ok(long.status === 422 && long.ms >= 1_980 && /spends on one image/.test(long.message), `control: an authorization with minutes left does not shorten the run (${long.status} after ${long.ms} ms)`);
      process.env.FREE_MODE = "true";
      const free = await run(authorized(1, "203.0.113.31"));
      delete process.env.FREE_MODE;
      ok(free.status === 422 && free.ms >= 1_980, `control: in FREE_MODE a typed payment header bounds nothing (${free.status} after ${free.ms} ms)`);
      restore3();
    }
    ok(!L.state().busy && L.state().callers === 0, "every place is released after the time-limit cases");
  }

  // --- abandoned and failing images free their turn ---
  {
    L.reset();
    const { EventEmitter } = await import("node:events");
    const { isClientGoneAbort } = await import("../src/hangup-settlement.js");
    const restore = L.limits({ turnMs: 150, waitMs: 2_000, runMaxMs: 5_000, retireMs: 200 });
    const big = pngHead(4100, 4100).toString("base64");
    /** A request whose connection can be closed before any answer. */
    const live = (ip) => {
      const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, writableEnded: false });
      const req = { headers: {}, ip, res, socket: { destroyed: false } };
      return { req, close: () => { res.destroyed = true; req.socket.destroyed = true; res.emit("close"); } };
    };
    // A waiting call whose caller leaves gives up its place at once.
    const hold = await L.acquire(50, "ip:203.0.113.40");
    const leaver = live("203.0.113.41");
    const left = ocr.handler({ image: big, lang: "tur" }, leaver.req).then(() => null, (e) => e);
    await sleep(30);
    ok(L.state().waiting === 1, "a call waits in line behind the image in the engine");
    leaver.close();
    const leftErr = await settledWithin(left, 200);
    ok(leftErr?.statusCode === 499 && isClientGoneAbort(leftErr) && L.state().waiting === 0, `a waiting call whose connection closes leaves the line at once, as the dispatcher's client-gone 499 (${leftErr?.statusCode ?? leftErr}; waiting ${L.state().waiting})`);
    ok(leaver.req.res.listenerCount("close") === 0, "its close listener is removed");
    hold();
    // An image in the engine whose caller leaves is ended at once: its
    // engine terminated, the turn passed on.
    let terminated = 0;
    __ocrTest.inject("tur", { recognize: () => new Promise(() => {}), terminate: async () => { terminated++; } });
    const runner = live("203.0.113.42");
    const ran = ocr.handler({ image: big, lang: "tur" }, runner.req).then(() => null, (e) => e);
    await sleep(60);
    ok(L.state().busy && L.state().holder === "ip:203.0.113.42", "an image is in the engine");
    const t0 = Date.now();
    runner.close();
    const ranErr = await settledWithin(ran, 500);
    ok(ranErr?.statusCode === 499 && isClientGoneAbort(ranErr) && terminated === 1 && !L.state().busy && Date.now() - t0 < 400, `an image in the engine whose connection closes is ended at once: engine terminated, turn freed (${ranErr?.statusCode ?? ranErr} after ${Date.now() - t0} ms; terminated ${terminated})`);
    // The time it held the engine counts against that caller's place in line:
    // its next image stands behind another caller's that arrives after it.
    {
      const z = await L.acquire(50, "ip:203.0.113.43");
      const order = [];
      __ocrTest.inject("tur", { recognize: async () => { order.push(L.state().holder); return { data: { text: "x", lines: [] } }; }, terminate: async () => {} });
      const again = ocr.handler({ image: big, lang: "tur" }, { headers: {}, ip: "203.0.113.42" }).catch(() => {});
      await sleep(20);
      const other = ocr.handler({ image: big, lang: "tur" }, { headers: {}, ip: "203.0.113.44" }).catch(() => {});
      await sleep(10);
      z();
      await Promise.all([again, other]);
      ok(order.join() === "ip:203.0.113.44,ip:203.0.113.42", `the caller that abandoned an image stands behind a caller that arrives after it (${order.join()})`);
    }
    // A body that does not decode frees its turn the same way and counts the same.
    {
      L.reset();
      __ocrTest.inject("tur", { recognize: () => new Promise((_, reject) => setTimeout(() => reject("Error: Error attempting to read image."), 60)), terminate: async () => {} });
      const failed = await ocr.handler({ image: big, lang: "tur" }, { headers: {}, ip: "203.0.113.45" }).then(() => null, (e) => e);
      ok(failed?.statusCode === 422 && failed.hint === "image-decode-failed" && !L.state().busy && L.state().callers === 0, `a body that does not decode is a 422 and frees its turn (${failed?.statusCode})`);
      const z = await L.acquire(50, "ip:203.0.113.46");
      const order = [];
      __ocrTest.inject("tur", { recognize: async () => { order.push(L.state().holder); return { data: { text: "x", lines: [] } }; }, terminate: async () => {} });
      const again = ocr.handler({ image: big, lang: "tur" }, { headers: {}, ip: "203.0.113.45" }).catch(() => {});
      await sleep(20);
      const other = ocr.handler({ image: big, lang: "tur" }, { headers: {}, ip: "203.0.113.47" }).catch(() => {});
      await sleep(10);
      z();
      await Promise.all([again, other]);
      ok(order.join() === "ip:203.0.113.47,ip:203.0.113.45", `the caller whose body did not decode stands behind a caller that arrives after it (${order.join()})`);
    }
    restore();
    ok(!L.state().busy && L.state().callers === 0, "every place is released after the abandoned and failing cases");
  }

  // --- images at or under 16 MP: one at a time per language, the same turns ---
  {
    L.reset();
    const restore = L.limits({ turnMs: 150, waitMs: 3_000, runMaxMs: 5_000, retireMs: 200 });
    const small = pngHead(16, 16);
    const order = [];
    let inEngine = 0, worst = 0;
    __ocrTest.inject("tur", { recognize: async () => { worst = Math.max(worst, ++inEngine); order.push(L.lane("tur").holder); await sleep(80); inEngine--; return { data: { text: "x", lines: [] } }; }, terminate: async () => {} });
    const hog = "ip:203.0.113.60", other = "ip:203.0.113.61";
    const hogRuns = [1, 2, 3, 4].map(() => L.recognize(small, "tur", "png", 1_000, hog));
    await sleep(20);
    const t0 = Date.now();
    await L.recognize(small, "tur", "png", 1_000, other);
    const otherMs = Date.now() - t0;
    await Promise.all(hogRuns);
    ok(worst === 1, `a language's worker reads one image at a time (worst ${worst})`);
    ok(order[1] === other && otherMs < 2 * 80 + 150, `behind one caller's four slow images in a language, another caller's image is read second, not fifth (order ${order.map((k) => k.slice(-2)).join(",")}; ${otherMs} ms)`);
    ok(order.length === 5 && order.filter((k) => k === hog).length === 4, "and all four of the first caller's images are read in their turn");
    // At most OCR_WORKER_MAX engines run at once; a fourth language waits for one.
    L.limits({ turnMs: 5_000 });
    const gates = [];
    const gated = () => ({ recognize: () => new Promise((r) => gates.push(() => r({ data: { text: "x", lines: [] } }))), terminate: async () => {} });
    for (const lang of ["tur", "ell", "vie", "tha"]) __ocrTest.inject(lang, gated());
    const runs = ["tur", "ell", "vie", "tha"].map((lang, i) => L.recognize(small, lang, "png", 1_000, `ip:203.0.113.${70 + i}`));
    await sleep(40);
    ok(OCR_WORKER_MAX === 3 && gates.length === 3 && L.lane("tha").waiting === 1 && L.lane("tha").running === 3, `three languages run at once and a fourth waits for an engine (in engines ${gates.length}, running ${L.lane("tha").running})`);
    gates.shift()();
    await sleep(40);
    ok(gates.length === 3 && L.lane("tha").busy, "the fourth runs when one ends");
    while (gates.length) gates.shift()();
    await Promise.all(runs);
    ok(__ocrTest.workerCount() <= OCR_WORKER_MAX, `engines held stay at or under ${OCR_WORKER_MAX} (${__ocrTest.workerCount()})`);
    restore();
    ok(L.lane("tur").running === 0 && L.state().callers === 0, "every place is released after the language cases");
  }

  // --- the caller is read from the request ---
  {
    L.reset();
    const D = "ip:203.0.113.9", C = "ip:203.0.113.8";
    // A signed payer first, else the address.
    let seen = null;
    __ocrTest.inject("tur", { recognize: async () => { seen = __ocrLargeTest.state().holder; return { data: { text: "x", lines: [] } }; }, terminate: async () => {} });
    const big = pngHead(4100, 4100);
    const tool = OCR_TOOLS.find((t) => t.slug === "image-ocr");
    await tool.handler({ image: big.toString("base64"), lang: "tur" }, { ip: D.slice(3), headers: {} }).catch(() => {});
    ok(seen === D, `a large image's place is held for the caller's address when no payer is signed (held for ${seen})`);
    seen = null;
    await tool.handler({ image: big.toString("base64"), lang: "tur" }, paidReq(wallet(0xc1), "203.0.113.10")).catch(() => {});
    ok(seen === `payer:${wallet(0xc1)}`, `...and for the signed payer when there is one (held for ${seen})`);
    // An in-process executor calls the handler with no request: the place is
    // held for the caller that dispatched the step (runAsCallerOf), and with
    // no caller at all under one shared key, never uncounted.
    const { runAsCallerOf, IN_PROCESS_CALLER } = await import("../src/dispatch-caller.js");
    seen = null;
    await runAsCallerOf({ ip: C.slice(3), headers: {} }, () => tool.handler({ image: big.toString("base64"), lang: "tur" })).catch(() => {});
    ok(seen === C, `a step dispatched without a request holds its place for the dispatching caller (held for ${seen})`);
    seen = null;
    await tool.handler({ image: big.toString("base64"), lang: "tur" }).catch(() => {});
    ok(seen === IN_PROCESS_CALLER, `a call with no caller at all is held under the shared key (held for ${seen})`);
    // The caller key reads the identity payer: in FREE_MODE no payment header
    // is verified, so a typed x-payment naming a wallet never changes the key.
    {
      const { callerKeyOf } = await import("../src/dispatch-caller.js");
      const withHeader = (ip) => paidReq("0x" + "ab".repeat(20), ip);
      try {
        process.env.FREE_MODE = "true";
        ok(callerKeyOf(withHeader("198.51.100.40")) === "ip:198.51.100.40" && callerKeyOf({ ip: "198.51.100.40", headers: {} }) === "ip:198.51.100.40", `in FREE_MODE a forged x-payment does not change the caller key (${callerKeyOf(withHeader("198.51.100.40"))})`);
        delete process.env.FREE_MODE;
        ok(callerKeyOf(withHeader("198.51.100.40")) === `payer:0x${"ab".repeat(20)}`, `control: on a paid deployment, where the gate verified it, the signed payer is the key (${callerKeyOf(withHeader("198.51.100.40"))})`);
      } finally { delete process.env.FREE_MODE; }
      // An IPv6 caller is its /64 (one host rotating addresses is one caller);
      // an IPv4 caller is its full address.
      const k = (ip) => callerKeyOf({ ip, headers: {} });
      ok(k("2001:db8:1:2::a") === k("2001:db8:1:2:ffff:1:2:3") && k("2001:db8:1:2::a") === "ip:2001:db8:1:2::/64", `addresses in one IPv6 /64 share one caller key (${k("2001:db8:1:2::a")}, ${k("2001:db8:1:2:ffff:1:2:3")})`);
      ok(k("2001:db8:1:3::a") !== k("2001:db8:1:2::a"), "a neighboring /64 is another caller");
      ok(k("198.51.100.40") === "ip:198.51.100.40" && k("198.51.100.41") === "ip:198.51.100.41", "an IPv4 caller is keyed on its full address");
      // The large-image place itself follows the fold.
      seen = null;
      await tool.handler({ image: big.toString("base64"), lang: "tur" }, { ip: "2001:db8:5:6::99", headers: {} }).catch(() => {});
      ok(seen === "ip:2001:db8:5:6::/64", `a large image's place is held for the caller's /64 (held for ${seen})`);
    }
    // A skill pack runs its steps request-less too: each step's place is held
    // for the caller that bought the pack, never under the shared key.
    {
      const { buildSkillTools } = await import("../src/tools/skill-runner.js");
      const { SKILL_PACKS } = await import("../src/skills.js");
      const pack = SKILL_PACKS[0];
      const holders = [];
      __ocrTest.inject("tur", { recognize: async () => { holders.push(__ocrLargeTest.state().holder); return { data: { text: "x", lines: [] } }; }, terminate: async () => {} });
      const probe = async () => tool.handler({ image: big.toString("base64"), lang: "tur" });
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
    ok(!L.state().busy && L.state().callers === 0, "every place is released after the caller cases");
  }
  if (hadFreeMode === undefined) delete process.env.FREE_MODE; else process.env.FREE_MODE = hadFreeMode;
  L.reset();

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
