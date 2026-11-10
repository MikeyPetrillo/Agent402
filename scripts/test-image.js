// Pure-CPU tests for the image kit: generate an image, then resize / convert /
// thumbnail / crop / palette it and verify the output decodes at the expected
// size and format. The EXIF parser is tested against a hand-crafted TIFF so no
// network is needed (the live URL path is covered by test-all's example check).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { Jimp, JimpMime } from "jimp";
import { IMAGE_TOOLS, extractExifBuffer, parseTiff, sniffFormat } from "../src/tools/image-kit.js";

const tool = (slug) => IMAGE_TOOLS.find((t) => t.slug === slug).handler;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Source: a 200x100 red PNG.
const src = new Jimp({ width: 200, height: 100, color: 0xff0000ff });
const srcB64 = (await src.getBuffer(JimpMime.png)).toString("base64");

// resize to width 50 → proportional height 25
let r = await tool("image-resize")({ image: srcB64, width: 50 });
let img = await Jimp.read(r.__binary);
ok(img.width === 50 && img.height === 25, `resize width=50 → 50x25 proportional (got ${img.width}x${img.height})`);
ok(r.contentType === JimpMime.png, `resize defaults to png (got ${r.contentType})`);

// resize to explicit 80x80
r = await tool("image-resize")({ image: srcB64, width: 80, height: 80 });
img = await Jimp.read(r.__binary);
ok(img.width === 80 && img.height === 80, `resize 80x80 (got ${img.width}x${img.height})`);

// convert to jpeg
r = await tool("image-convert")({ image: srcB64, format: "jpeg", quality: 70 });
ok(r.contentType === JimpMime.jpeg && r.__binary[0] === 0xff && r.__binary[1] === 0xd8, `convert to jpeg (magic ${r.__binary[0].toString(16)} ${r.__binary[1].toString(16)})`);

// thumbnail 64x64 square
r = await tool("image-thumbnail")({ image: srcB64, size: 64 });
img = await Jimp.read(r.__binary);
ok(img.width === 64 && img.height === 64, `thumbnail 64x64 square (got ${img.width}x${img.height})`);

// crop: 50x40 box at (10,10) from the 200x100 source (base64 path — no network)
r = await tool("image-crop")({ image: srcB64, left: 10, top: 10, width: 50, height: 40 });
img = await Jimp.read(r.__binary);
ok(img.width === 50 && img.height === 40, `crop 50x40 (got ${img.width}x${img.height})`);

// crop + rotate 90 → dimensions swap
r = await tool("image-crop")({ image: srcB64, left: 0, top: 0, width: 50, height: 40, rotate: 90 });
img = await Jimp.read(r.__binary);
ok(img.width === 40 && img.height === 50, `crop then rotate 90 swaps dims (got ${img.width}x${img.height})`);

// crop dataUri output
r = await tool("image-crop")({ image: srcB64, left: 0, top: 0, width: 20, height: 10, dataUri: true });
ok(typeof r.dataUri === "string" && r.dataUri.startsWith("data:image/png;base64,") && r.width === 20 && r.height === 10, "crop dataUri:true returns a JSON data URI");

// crop out-of-bounds box → 400
try { await tool("image-crop")({ image: srcB64, left: 190, top: 0, width: 50, height: 40 }); ok(false, "out-of-bounds crop should throw"); }
catch (e) { ok(e.statusCode === 400, "out-of-bounds crop throws 400"); }

// crop with nothing to do → 400
try { await tool("image-crop")({ image: srcB64 }); ok(false, "no-op crop should throw"); }
catch (e) { ok(e.statusCode === 400, "crop with no box/rotate/flip throws 400"); }

// dominant color of a solid red image → one bucket, pure red, ratio 1
r = await tool("image-dominant-color")({ image: srcB64, colors: 3 });
ok(r.colors.length === 1 && r.colors[0].hex === "#ff0000" && r.colors[0].ratio === 1, `dominant color of solid red is #ff0000 @ 1.0 (got ${JSON.stringify(r.colors)})`);
ok(r.width === 200 && r.height === 100, `dominant color reports source dims (got ${r.width}x${r.height})`);

// exif: jimp-generated PNG carries no EXIF → empty result, not an error
r = await tool("image-exif")({ image: srcB64 });
ok(r.format === "png" && r.hasExif === false && Object.keys(r.exif).length === 0, `stripped image → hasExif:false, empty exif (got ${JSON.stringify(r.exif)})`);
ok(r.width === 200 && r.height === 100, `exif reports dims for stripped image (got ${r.width}x${r.height})`);

// exif: hand-crafted little-endian TIFF with Make="Canon" + Orientation=1,
// wrapped in a JPEG APP1 segment — exercises both the extractor and the parser.
{
  const tiff = Buffer.alloc(44);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 at offset 8
  tiff.writeUInt16LE(2, 8); // 2 entries
  // entry 1: Make (0x010f), ASCII, count 6, value at offset 38
  tiff.writeUInt16LE(0x010f, 10); tiff.writeUInt16LE(2, 12); tiff.writeUInt32LE(6, 14); tiff.writeUInt32LE(38, 18);
  // entry 2: Orientation (0x0112), SHORT, count 1, inline value 1
  tiff.writeUInt16LE(0x0112, 22); tiff.writeUInt16LE(3, 24); tiff.writeUInt32LE(1, 26); tiff.writeUInt16LE(1, 30);
  tiff.writeUInt32LE(0, 34); // next IFD: none
  tiff.write("Canon\0", 38, "ascii");
  const parsed = parseTiff(tiff);
  ok(parsed && parsed.exif.Make === "Canon" && parsed.exif.Orientation === 1, `parseTiff reads Make/Orientation (got ${JSON.stringify(parsed && parsed.exif)})`);
  // wrap in a minimal JPEG: SOI + APP1(Exif) + EOI
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const seg = Buffer.alloc(4);
  seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(app1.length + 2, 2);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg, app1, Buffer.from([0xff, 0xd9])]);
  ok(sniffFormat(jpeg) === "jpeg", "sniffFormat detects the crafted JPEG");
  const extracted = extractExifBuffer(jpeg);
  ok(extracted && parseTiff(extracted).exif.Make === "Canon", "extractExifBuffer pulls the APP1 TIFF out of a JPEG");
}

// validation: missing image
try { await tool("image-resize")({ width: 50 }); ok(false, "missing image should throw"); }
catch (e) { ok(e.statusCode === 400, "missing image throws 400"); }
// validation: garbage base64
try { await tool("image-convert")({ image: "not!!an!!image", format: "png" }); ok(false, "garbage should throw"); }
catch (e) { ok(e.statusCode === 400, "garbage image throws 400"); }
// validation: neither url nor image on a URL-capable tool
try { await tool("image-exif")({}); ok(false, "missing url+image should throw"); }
catch (e) { ok(e.statusCode === 400, "image-exif without url/image throws 400"); }

// exif reports size from the container header and never decodes the pixels: a
// small PNG declaring a 12000x12000 canvas answers its size while the event
// loop stays free (an inline decode holds it for most of a second).
{
  const zlib = await import("node:zlib");
  const crc32 = (b) => { let c, crc = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
  const W = 12000;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8;
  const big = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.alloc((W + 1) * W), { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  let last = performance.now(), worst = 0;
  const iv = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; }, 5);
  await new Promise((res) => setTimeout(res, 20));
  const er = await tool("image-exif")({ image: big.toString("base64") });
  await new Promise((res) => setTimeout(res, 20));
  clearInterval(iv);
  ok(er.width === W && er.height === W && er.hasExif === false, `exif reports a large PNG's header size (got ${er.width}x${er.height})`);
  ok(worst < 150, `exif on a 12000x12000 PNG holds the loop under 150 ms (worst ${Math.round(worst)} ms)`);
}

// The three compute-payable tools run in a worker thread (src/tools/image-pool.js),
// so their rejections cross a postMessage boundary. These three pin that the
// crossing preserves both the message and the statusCode: a caller must not be
// able to tell that the work moved off the main thread.
{
  // Parameter validation happens after the decode, inside the worker.
  try { await tool("image-resize")({ image: srcB64 }); ok(false, "resize with no dimensions should throw"); }
  catch (e) { ok(e.statusCode === 400 && e.message === "provide width and/or height", `resize with no dimensions throws 400 (got ${e.statusCode} ${e.message})`); }

  // Encode-side validation, also inside the worker.
  try { await tool("image-convert")({ image: srcB64, format: "tiff" }); ok(false, "unsupported format should throw"); }
  catch (e) { ok(e.statusCode === 400 && /^format must be/.test(e.message), `unsupported output format throws 400 (got ${e.statusCode} ${e.message})`); }

  // Header pre-check: rewrite the IHDR to declare 5000x5000 (25M pixels, over the
  // 16M free-tier cap). This must be refused from the header alone, before any
  // decode, so the worker is never handed the job at all. The CRC is left stale
  // on purpose - reaching the decoder would be the failure this asserts against.
  const png = await src.getBuffer(JimpMime.png);
  const lying = Buffer.from(png);
  lying.writeUInt32BE(5000, 16);
  lying.writeUInt32BE(5000, 20);
  try { await tool("image-resize")({ image: lying.toString("base64"), width: 64 }); ok(false, "oversized declared canvas should throw"); }
  catch (e) { ok(e.statusCode === 400 && /^source image too large \(5000x5000/.test(e.message), `header declaring 25M pixels throws 400 before decoding (got ${e.statusCode} ${e.message})`); }
}

// Event-loop availability, offline. The server-level version of this check lives
// in scripts/test-image-concurrency.js (it measures a real /health during a
// burst); this one needs no server, so it guards the property on every run of
// this file. A timer scheduled every 25ms cannot fire on time while a
// synchronous jimp decode holds the thread, so its worst lag IS the blocking a
// concurrent request would have seen. Source: a solid 4000x4000 PNG, i.e. 67KB
// on the wire but 16M pixels to decode, the most a free caller may send.
// Measured lag with the decode inline: 1154-1231ms, and the probe fired ZERO
// times in the whole 1.3s burst. With the decode in a worker: 2ms, 28 ticks.
{
  const bigB64 = (await new Jimp({ width: 4000, height: 4000, color: 0x3366ffff }).getBuffer(JimpMime.png)).toString("base64");
  let worstLag = 0, ticking = true, due = 0;
  const tick = () => {
    due = Date.now() + 25;
    setTimeout(() => { worstLag = Math.max(worstLag, Date.now() - due); if (ticking) tick(); }, 25);
  };
  tick();
  const burst = await Promise.all([1, 2, 3, 4].map(() => tool("image-resize")({ image: bigB64, width: 256 })));
  ticking = false;
  // Total starvation shows up as a probe that never ran at all, which a
  // callback-only metric would score as a perfect 0ms. The still-pending timer's
  // overdue-by is the honest reading in that case.
  worstLag = Math.max(worstLag, Date.now() - due);
  ok(burst.every((b) => b.__binary.length > 0), `4 concurrent 16M-pixel resizes all returned bytes (${burst.map((b) => b.__binary.length).join(",")})`);
  ok(worstLag < 250, `event loop stayed responsive during the burst (worst timer lag ${worstLag}ms < 250ms)`);
}

// A GIF frame is decoded at its own size, not the logical screen's. A frame
// that reaches past the screen is refused from its header, on every image tool,
// before any decode: a 35-byte body declaring a 10x10 screen and a 30000x30000
// frame once held the decoding thread for seconds.
{
  const gifWithFrame = (w, h) => Buffer.concat([
    Buffer.from("GIF89a"), Buffer.from([10, 0, 10, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]),
    Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0]), // a graphic control extension ahead of the frame
    Buffer.from([0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 2, 2, 0x44, 0x01, 0, 0x3b]),
  ]).toString("base64");
  const calls = [
    ["image-crop", { width: 5, height: 5 }], ["image-dominant-color", {}],
    ["image-resize", { width: 5 }], ["image-convert", { format: "png" }], ["image-thumbnail", {}],
  ];
  for (const [slug, extra] of calls) {
    const t0 = Date.now(); let code = 200, msg = "";
    try { await tool(slug)({ image: gifWithFrame(30000, 30000), ...extra }); } catch (e) { code = e.statusCode; msg = e.message; }
    ok(code === 400 && /gif frame/.test(msg) && Date.now() - t0 < 500, `${slug} refuses a GIF frame larger than its canvas from the header (got ${code} "${msg}" in ${Date.now() - t0}ms)`);
  }
  const fine = await tool("image-dominant-color")({ image: gifWithFrame(10, 10) });
  ok(fine.width === 10 && fine.height === 10, `a GIF whose frame fits its canvas still decodes (got ${fine.width}x${fine.height})`);
}

// image-crop and image-dominant-color decode in the worker pool, like the other
// transforms: a large source must not hold the event loop while it decodes.
{
  const big = new Jimp({ width: 4000, height: 3000, color: 0x3366ccff });
  const bigJpeg = (await big.getBuffer(JimpMime.jpeg)).toString("base64");
  let ticks = 0; const iv = setInterval(() => ticks++, 20);
  const t0 = Date.now();
  const [c, d] = await Promise.all([
    tool("image-crop")({ image: bigJpeg, left: 0, top: 0, width: 32, height: 32, dataUri: true }),
    tool("image-dominant-color")({ image: bigJpeg, colors: 1 }),
  ]);
  const ms = Date.now() - t0; clearInterval(iv);
  ok(c.width === 32 && c.height === 32 && d.width === 4000 && d.colors.length === 1, "crop and dominant-color answer for a 12M-pixel source");
  ok(ticks >= Math.floor(ms / 20 / 2), `event loop kept ticking while both decoded (${ticks} ticks in ${ms}ms)`);
}

// ---------------------------------------------------------------------------
// Header versus decoder. The pixel cap is read from a container's header; it
// bounds the decode only when the decoder sizes its buffers from that same
// field. Each block below builds a small file whose first size field is small
// and whose decoded size is not, and asserts a 400 that names what was wrong,
// answered from the header (no worker, no decode). Each also decodes the
// ordinary shapes of its format, so the checks refuse nothing a buyer sends.
const zlibMod = await import("node:zlib");
const { createRequire } = await import("node:module");
const { assertDeclaredWithinPixelCap } = await import("../src/tools/image-ops.js");
const barcodeDecode = (await import("../src/tools/barcode-kit.js")).BARCODE_TOOLS.find((t) => t.slug === "barcode-decode").handler;
const le16 = (n) => [n & 255, (n >> 8) & 255];
const attempt = async (handler, buf, extra = {}) => {
  const t0 = Date.now();
  try { return { code: 200, r: await handler({ image: buf.toString("base64"), ...extra }), ms: Date.now() - t0 }; }
  catch (e) { return { code: e.statusCode, msg: e.message, ms: Date.now() - t0 }; }
};
// Every transform tool, with the least input each needs.
const TRANSFORMS = [
  ["image-resize", { width: 5 }], ["image-convert", { format: "png" }], ["image-thumbnail", {}],
  ["image-crop", { width: 2, height: 2 }], ["image-dominant-color", {}],
];
const refusedBy = async (label, buf, pattern, handlers = TRANSFORMS.map(([slug, extra]) => [slug, tool(slug), extra])) => {
  for (const [name, handler, extra] of handlers) {
    const a = await attempt(handler, buf, extra);
    ok(a.code === 400 && pattern.test(a.msg || "") && a.ms < 500, `${name} refuses ${label} from its header (got ${a.code} "${a.msg}" in ${a.ms}ms)`);
  }
};
// Decode through image-convert (the worker path) and hand back the pixels.
const decoded = async (buf) => Jimp.read((await tool("image-convert")({ image: buf.toString("base64"), format: "png" })).__binary);
// Valid files each block hands to the seeded fuzz at the end of this file.
const fuzzSeeds = { gif: [], png: [], jpeg: [], bmp: [], tiff: [] };
// CPU the calling thread spends in fn, in ms (best of five): wall time would
// also count whatever else the machine is doing.
const cpuMs = (fn) => { let best = Infinity; for (let k = 0; k < 5; k++) { const c0 = process.cpuUsage(); try { fn(); } catch { /* a refusal is timed too */ } const c = process.cpuUsage(c0); best = Math.min(best, (c.user + c.system) / 1000); } return best; };
const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");

// GIF. Frame 0 is decoded at the FRAME's size, and the decoder steps over an
// application extension whose first sub-block is not 11 bytes by a fixed
// count, not by its sub-block chain. So the frame is read with the decoder's
// own parser, and a 10x10 screen with a 20000x20000 frame behind such an
// extension is refused like any other frame larger than its screen.
{
  const head = (w, h) => Buffer.from([...Buffer.from("GIF89a"), ...le16(w), ...le16(h), 0x80, 0, 0, 0, 0, 0, 255, 255, 255]);
  const frame = (x, y, w, h) => Buffer.from([0x2c, ...le16(x), ...le16(y), ...le16(w), ...le16(h), 0, 2, 2, 0x44, 0x01, 0]);
  const END = Buffer.from([0x3b]);
  const behindExtension = (w, h) => {
    const d = Buffer.alloc(29); d[16] = 0x2c; d.writeUInt16LE(w, 21); d.writeUInt16LE(h, 23); d[26] = 2; d[28] = 0x3b;
    return Buffer.concat([head(10, 10), Buffer.from([0x21, 0xff, 29]), d, Buffer.from([0]), END]);
  };
  const hidden = behindExtension(20000, 20000);
  ok(hidden.length === 53, `the hidden-frame GIF is 53 bytes (got ${hidden.length})`);
  await refusedBy("a GIF frame hidden behind an application extension", hidden, /^gif frame \(20000x20000 at 0,0\) extends past its 10x10 canvas/);

  // Both axes, size and offset, each on its own.
  const convert = [["image-convert", tool("image-convert"), { format: "png" }]];
  await refusedBy("a GIF frame taller than its canvas", Buffer.concat([head(10, 10), frame(0, 0, 10, 30000), END]), /^gif frame \(10x30000 at 0,0\)/, convert);
  await refusedBy("a GIF frame wider than its canvas", Buffer.concat([head(10, 10), frame(0, 0, 30000, 10), END]), /^gif frame \(30000x10 at 0,0\)/, convert);
  await refusedBy("a GIF frame pushed past the bottom edge", Buffer.concat([head(10, 10), frame(0, 5, 10, 10), END]), /^gif frame \(10x10 at 0,5\)/, convert);
  await refusedBy("a GIF frame pushed past the right edge", Buffer.concat([head(10, 10), frame(5, 0, 10, 10), END]), /^gif frame \(10x10 at 5,0\)/, convert);
  await refusedBy("a hidden GIF frame that is only too tall", behindExtension(10, 20000), /^gif frame \(10x20000 at 0,0\)/, convert);
  await refusedBy("a GIF with no frame", Buffer.concat([head(10, 10), END]), /^gif has no image frame/, convert);
  await refusedBy("a GIF the reader rejects", Buffer.concat([head(10, 10), Buffer.from([0]), frame(0, 0, 10, 10), END]), /^gif could not be read: Unknown gif block/, convert);

  // Ordinary GIFs, written with the same library the decoder comes from.
  const viaJimp = createRequire(createRequire(import.meta.url).resolve("jimp"));
  const omggif = createRequire(viaJimp.resolve("@jimp/js-gif"))("omggif");
  const palette = [0x000000, 0xff0000, 0x00ff00, 0x0000ff];
  const write = (w, h, opts, frames) => {
    const out = Buffer.alloc(64 * 1024); const gw = new omggif.GifWriter(out, w, h, opts);
    for (const [x, y, fw, fh, index, fopts] of frames) gw.addFrame(x, y, fw, fh, new Uint8Array(fw * fh).fill(index), fopts);
    return out.subarray(0, gw.end());
  };
  const RED = "ff0000ff";
  let g = await decoded(write(64, 48, { palette, loop: 0 }, [[8, 4, 40, 30, 1, { delay: 5 }], [20, 10, 10, 10, 2, { delay: 5 }], [0, 0, 64, 48, 3, { delay: 5 }]]));
  ok(g.width === 64 && g.height === 48 && hex(g.getPixelColor(10, 10)) === RED && hex(g.getPixelColor(0, 0)) !== RED, `an animated GIF whose first frame is a sub-rectangle decodes (${g.width}x${g.height}, ${hex(g.getPixelColor(10, 10))})`);
  g = await decoded(write(32, 32, {}, [[0, 0, 32, 32, 1, { palette }]]));
  ok(g.width === 32 && hex(g.getPixelColor(5, 5)) === RED, `a GIF with only a local palette decodes (${hex(g.getPixelColor(5, 5))})`);
  g = await decoded(write(32, 32, { palette }, [[16, 16, 16, 16, 1, {}]]));
  ok(g.width === 32 && hex(g.getPixelColor(31, 31)) === RED && hex(g.getPixelColor(15, 15)) !== RED, `a GIF frame flush with the bottom-right edge decodes (${hex(g.getPixelColor(31, 31))})`);
  const plain = write(32, 32, { palette }, [[0, 0, 32, 32, 1, {}]]);
  fuzzSeeds.gif.push(plain, write(64, 48, { palette, loop: 0 }, [[8, 4, 40, 30, 1, { delay: 5 }], [20, 10, 10, 10, 2, { delay: 5 }]]), write(32, 32, {}, [[0, 0, 32, 32, 1, { palette }]]));
  const xmp = Buffer.concat([Buffer.from([0x21, 0xff, 0x0b]), Buffer.from("XMP DataXMP"), Buffer.from([200]), Buffer.alloc(200, 0x20), Buffer.from([0])]);
  g = await decoded(Buffer.concat([plain.subarray(0, 25), xmp, plain.subarray(25)]));
  ok(g.width === 32 && hex(g.getPixelColor(5, 5)) === RED, `a GIF with an XMP application extension decodes (${hex(g.getPixelColor(5, 5))})`);
  g = await decoded(await new Jimp({ width: 120, height: 80, color: 0x3366ccff }).getBuffer("image/gif"));
  ok(g.width === 120 && g.height === 80, `the GIF encoder's own output decodes (${g.width}x${g.height})`);

  // The check runs on the main thread, so it has to stay a walk of the block
  // list: 5 MB of the smallest frames a GIF can hold (measured 8 ms warm).
  const many = Buffer.concat([head(100, 100), ...Array(Math.floor(5e6 / 16)).fill(frame(0, 0, 100, 100)), END]);
  assertDeclaredWithinPixelCap(many.subarray(0, 64), 16e6); // load the parser outside the timing
  const t0 = performance.now(); assertDeclaredWithinPixelCap(many, 16e6); const ms = performance.now() - t0;
  ok(ms < 150, `a 5 MB GIF of 312,500 frames is checked in ${ms.toFixed(1)} ms (< 150 ms)`);
}

// PNG. The decoder takes its size from the LAST IHDR chunk it meets, and it
// inflates an interlaced image with no output bound. So the chunk list is
// walked (one IHDR, and it comes first), and an interlaced image's data is
// inflated in the worker under the size its header declares before the
// decoder sees it.
{
  const crc32 = (b) => { let crc = 0xffffffff; for (let n = 0; n < b.length; n++) { let c = (crc ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
  const ihdr = (w, h, interlace = 0) => { const b = Buffer.alloc(13); b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); b[8] = 8; b[12] = interlace; return chunk("IHDR", b); };
  const png = (...chunks) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks, chunk("IEND", Buffer.alloc(0))]);
  const idat = (raw) => chunk("IDAT", zlibMod.deflateSync(raw, { level: 9 }));
  const everyDecoder = [...TRANSFORMS.map(([slug, extra]) => [slug, tool(slug), extra]), ["barcode-decode", barcodeDecode, {}]];

  const twoHeaders = png(ihdr(4, 4), ihdr(9000, 9000), idat(Buffer.alloc(4 * 5)));
  await refusedBy("a PNG with a second IHDR", twoHeaders, /^png carries 2 IHDR chunks/, everyDecoder);
  await refusedBy("a PNG whose IHDR is not first", png(chunk("tEXt", Buffer.from("a\0b")), ihdr(4, 4), idat(Buffer.alloc(4 * 5))), /IHDR|unreadable header/, everyDecoder);
  const { assertPngWithin } = await import("../src/tools/frame-diff.js");
  let fd = null; try { assertPngWithin(twoHeaders, { maxWidth: 100, maxHeight: 100, label: "still" }); } catch (e) { fd = e; }
  ok(fd && fd.statusCode === 400 && /^still: png carries 2 IHDR chunks/.test(fd.message), `the frame check refuses a PNG with a second IHDR (got ${fd && fd.message})`);

  // Interlaced, 4x4, with image data that inflates to 64 MB. The refusal comes
  // from the worker (it inflates), so the 500 ms bound does not apply here.
  const swollen = png(ihdr(4, 4, 1), idat(Buffer.alloc(64e6)));
  for (const [name, handler, extra] of [["image-convert", tool("image-convert"), { format: "png" }], ["image-crop", tool("image-crop"), { width: 2, height: 2 }], ["barcode-decode", barcodeDecode, {}]]) {
    const a = await attempt(handler, swollen, extra);
    ok(a.code === 400 && /^interlaced png inflates past the 4x4 image its header declares/.test(a.msg || ""), `${name} refuses an interlaced PNG that inflates past its declared size (${swollen.length} bytes in; got ${a.code} "${a.msg}")`);
  }

  // Interlaced PNGs keep working: 5x5 gray, seven Adam7 passes, 11 rows in all
  // (pass widths 1,1,2,1,3,2,5 over 1,1,1,2,1,3,2 rows), every sample 0x40.
  const rows = [[1, 1], [1, 1], [2, 1], [1, 2], [3, 1], [2, 3], [5, 2]].flatMap(([w, n]) => Array(n).fill(Buffer.from([0, ...Array(w).fill(0x40)])));
  const interlaced = png(ihdr(5, 5, 1), idat(Buffer.concat(rows)));
  fuzzSeeds.png.push(interlaced, png(ihdr(4, 4), idat(Buffer.alloc(4 * 5))));
  const p = await decoded(interlaced);
  ok(p.width === 5 && p.height === 5 && hex(p.getPixelColor(0, 0)) === "404040ff" && hex(p.getPixelColor(4, 4)) === "404040ff", `an interlaced PNG still decodes to its pixels (${p.width}x${p.height}, ${hex(p.getPixelColor(4, 4))})`);
  // A text chunk that spells IHDR in its data is not a second header.
  const q = await decoded(png(ihdr(4, 4), chunk("tEXt", Buffer.from("Comment\0IHDR IHDR")), idat(Buffer.alloc(4 * 5))));
  ok(q.width === 4 && q.height === 4, `a PNG with "IHDR" inside a text chunk still decodes (${q.width}x${q.height})`);
}

// JPEG. The decoder keeps the last frame header (SOF) it meets. The marker
// chain is walked by segment length, with entropy-coded data skipped to the
// next real marker, and a second frame header is refused; the decoder is also
// handed the pixel cap, so it applies the cap itself to whichever frame header
// it acts on. A thumbnail inside an EXIF segment has a frame header of its own and is not
// part of the chain.
{
  const seg = (marker, data) => { const b = Buffer.alloc(4); b[0] = 0xff; b[1] = marker; b.writeUInt16BE(data.length + 2, 2); return Buffer.concat([b, data]); };
  const small = Buffer.from(await new Jimp({ width: 16, height: 16, color: 0x336699ff }).getBuffer(JimpMime.jpeg));
  let at = 2; while (small[at + 1] !== 0xc0) at += 2 + small.readUInt16BE(at + 2);
  const sofEnd = at + 2 + small.readUInt16BE(at + 2);
  const bigSof = Buffer.from(small.subarray(at, sofEnd)); bigSof.writeUInt16BE(9000, 5); bigSof.writeUInt16BE(9000, 7);
  const everyDecoder = [...TRANSFORMS.map(([slug, extra]) => [slug, tool(slug), extra]), ["barcode-decode", barcodeDecode, {}]];
  await refusedBy("a JPEG with a second frame header", Buffer.concat([small.subarray(0, sofEnd), bigSof, small.subarray(sofEnd)]), /^jpeg carries more than one frame header/, everyDecoder);

  // A frame header the marker chain does not show: the decoder ends the scan at
  // a restart marker, takes the two bytes after it for a damaged APP1 and jumps
  // by the length that follows, landing inside an APP2 segment. The chain has
  // one frame header, so this one is stopped by the decoder's own cap.
  const inside = Buffer.concat([Buffer.alloc(4), bigSof, Buffer.alloc(4)]);
  const offChain = Buffer.concat([small.subarray(0, small.length - 2), Buffer.from([0xff, 0xd0, 0x00, 0xe1, 0x00, 0x0a]), seg(0xe2, inside), Buffer.from([0xff, 0xd9])]);
  for (const [name, handler, extra] of [["image-convert", tool("image-convert"), { format: "png" }], ["image-crop", tool("image-crop"), { width: 2, height: 2 }], ["barcode-decode", barcodeDecode, {}]]) {
    const a = await attempt(handler, offChain, extra);
    ok(a.code === 400 && /maxResolutionInMP limit exceeded/.test(a.msg || "") && a.ms < 2000, `${name}: the decoder applies the pixel cap to a frame header off the marker chain (got ${a.code} "${a.msg}" in ${a.ms}ms)`);
  }

  // Ordinary JPEGs. A 200x100 picture with a real EXIF block whose second
  // directory points at a 160x120 JPEG thumbnail (tags 0x0201 and 0x0202).
  const picture = new Jimp({ width: 200, height: 100, color: 0x3366ccff });
  const photo = Buffer.from(await picture.getBuffer(JimpMime.jpeg));
  const thumb = Buffer.from(await new Jimp({ width: 160, height: 120, color: 0xcc6633ff }).getBuffer(JimpMime.jpeg));
  const t = Buffer.alloc(54); t.write("II"); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4);
  t.writeUInt16LE(1, 8); t.writeUInt16LE(0x0112, 10); t.writeUInt16LE(3, 12); t.writeUInt32LE(1, 14); t.writeUInt16LE(1, 18); t.writeUInt32LE(26, 22);
  t.writeUInt16LE(2, 26); t.writeUInt16LE(0x0201, 28); t.writeUInt16LE(4, 30); t.writeUInt32LE(1, 32); t.writeUInt32LE(54, 36);
  t.writeUInt16LE(0x0202, 40); t.writeUInt16LE(4, 42); t.writeUInt32LE(1, 44); t.writeUInt32LE(thumb.length, 48);
  const withThumb = Buffer.concat([photo.subarray(0, 2), seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0"), t, thumb])), photo.subarray(2)]);
  const meta = await tool("image-exif")({ image: withThumb.toString("base64") });
  ok(meta.width === 200 && meta.height === 100 && meta.exif.Orientation === 1, `a JPEG with an EXIF thumbnail reports the picture's size, not the thumbnail's (${meta.width}x${meta.height})`);
  let j = await decoded(withThumb);
  ok(j.width === 200 && j.height === 100, `a JPEG with an EXIF thumbnail (its own SOF inside APP1) still decodes (${j.width}x${j.height})`);
  const bc = await attempt(barcodeDecode, withThumb);
  ok(bc.code === 200 && bc.r.found === false, `barcode-decode still reads a JPEG with an EXIF thumbnail (got ${bc.code} ${bc.msg || ""})`);
  j = await decoded(Buffer.concat([photo.subarray(0, 2), seg(0xfe, Buffer.concat([Buffer.from("note "), bigSof])), photo.subarray(2)]));
  ok(j.width === 200 && j.height === 100, `a JPEG whose comment segment holds SOF bytes still decodes (${j.width}x${j.height})`);
  j = await decoded(Buffer.concat([photo, thumb]));
  ok(j.width === 200 && j.height === 100, `a JPEG followed by a second picture (multi-picture file) still decodes as the first (${j.width}x${j.height})`);
  // Bytes after the end-of-image marker are not part of the picture, whatever they spell.
  j = await decoded(Buffer.concat([photo, Buffer.from([0, 2]), bigSof]));
  ok(j.width === 200 && j.height === 100, `a JPEG with frame-header bytes after its end marker still decodes (${j.width}x${j.height})`);
  // Progressive: one SOF2, then a DC scan and an AC scan (8x8 gray, hand-built).
  const table = (cls) => seg(0xc4, Buffer.from([cls << 4, 1, ...Array(15).fill(0), 0]));
  const scan = (from, to) => Buffer.concat([seg(0xda, Buffer.from([1, 1, 0, from, to, 0])), Buffer.from([0x7f])]);
  const progressive = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xdb, Buffer.from([0, ...Array(64).fill(1)])), seg(0xc2, Buffer.from([8, 0, 8, 0, 8, 1, 1, 0x11, 0])), table(0), scan(0, 0), table(1), scan(1, 63), Buffer.from([0xff, 0xd9])]);
  fuzzSeeds.jpeg.push(progressive, withThumb, small);
  j = await decoded(progressive);
  ok(j.width === 8 && j.height === 8 && hex(j.getPixelColor(3, 3)) === "808080ff", `a progressive JPEG (one SOF2, two scans) still decodes (${j.width}x${j.height}, ${hex(j.getPixelColor(3, 3))})`);
}

// TIFF. The tools use the first image of a TIFF, and the decoder reads far
// more than that: every directory in the chain (decoding each page), the
// sub-directories and maker notes, one loop turn per value a tag declares, and
// buffers sized from the sample layout, the tile size and fields inside JPEG
// and deflate data. So the first image's directory is read the way the decoder
// reads it and bounded, and the decoder is handed a copy of the file in which
// that directory is the only one and nothing leads out of it. Every kind of
// TIFF that decoded before still decodes, to the same pixels; what is refused
// is a file whose declared sizes cannot be true of its bytes.
{
  // pages: [[tag, type, count, value | Buffer], ...]; a Buffer is stored after
  // the directory and the entry points at it.
  const tiff = (pages, { lastNext = 0 } = {}) => {
    const out = [Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0])]; let off = 8;
    pages.forEach((tags, idx) => {
      const dir = Buffer.alloc(2 + tags.length * 12 + 4); dir.writeUInt16LE(tags.length, 0);
      let blobAt = off + dir.length; const blobs = [];
      tags.forEach(([tag, type, count, v], k) => {
        const e = 2 + k * 12; dir.writeUInt16LE(tag, e); dir.writeUInt16LE(type, e + 2); dir.writeUInt32LE(count, e + 4);
        if (Buffer.isBuffer(v)) { dir.writeUInt32LE(blobAt, e + 8); blobs.push(v); blobAt += v.length; }
        else if (type === 3) dir.writeUInt16LE(v, e + 8); else dir.writeUInt32LE(v, e + 8);
      });
      dir.writeUInt32LE(idx === pages.length - 1 ? lastNext : blobAt, dir.length - 4);
      out.push(dir, ...blobs); off = blobAt;
    });
    return Buffer.concat(out);
  };
  const samples = (w, h) => { const d = Buffer.alloc(w * h); for (let k = 0; k < d.length; k++) d[k] = (k * 7) & 255; return d; };
  // An 8-bit gray page; `over` replaces or (null) removes tags, by number.
  const page = (w, h, over = {}) => {
    const d = samples(w, h);
    const tags = { 256: [256, 4, 1, w], 257: [257, 4, 1, h], 258: [258, 3, 1, 8], 259: [259, 3, 1, 1], 262: [262, 3, 1, 1], 273: [273, 4, 1, d], 277: [277, 3, 1, 1], 278: [278, 4, 1, h], 279: [279, 4, 1, d.length] };
    for (const [k, v] of Object.entries(over)) { if (v === null) delete tags[k]; else tags[k] = v; }
    return Object.values(tags).sort((a, b) => a[0] - b[0]);
  };
  // A page that declares a size and points its one strip at the file header.
  const hollow = (w, h, over = {}) => page(w, h, { 273: [273, 4, 1, 8], 279: [279, 4, 1, 1], ...over });
  const convert = [["image-convert", tool("image-convert"), { format: "png" }]];
  const viaJimp = createRequire(createRequire(import.meta.url).resolve("jimp"));
  const utif = createRequire(viaJimp.resolve("@jimp/js-tiff"))("utif2");
  const { tiffDecoderView, tiffLayout } = await import("../src/tools/image-headers.js");
  const at = (img, x, y) => hex(img.getPixelColor(x, y));
  const gray = (v) => { const h2 = (v & 255).toString(16).padStart(2, "0"); return h2 + h2 + h2 + "ff"; };
  const SAMPLE = gray(83 * 7); // sample (3,2) of a 40-wide page
  const decodes = async (label, file, check = (f) => f.width === 40 && f.height === 30 && at(f, 3, 2) === SAMPLE) => {
    let f = null, err = ""; try { f = await decoded(file); } catch (e) { err = `${e.statusCode} ${e.message}`; }
    ok(f && check(f), `${label} decodes (${f ? `${f.width}x${f.height} ${at(f, 3, 2)}` : err})`);
  };
  // Refused in the worker, which reads the strip data: no 500 ms bound.
  const refusedInWorker = async (label, file, pattern, slugs = ["image-convert", "image-dominant-color"]) => {
    for (const slug of slugs) {
      const a = await attempt(tool(slug), file, { format: "png" });
      ok(a.code === 400 && pattern.test(a.msg || ""), `${slug} refuses ${label} (${file.length} bytes in; got ${a.code} "${a.msg}" in ${a.ms}ms)`);
    }
  };

  // --- Only the first image is decoded -------------------------------------
  const secondPage = tiff([page(40, 30), hollow(9000, 9000)]);
  await decodes("a TIFF whose second page is 9000x9000", secondPage);
  await decodes("a TIFF whose pages total more than the cap", tiff([page(40, 30), hollow(3000, 3000), hollow(3000, 3000)]));
  await decodes("a 40-page TIFF", tiff(Array.from({ length: 40 }, () => page(40, 30))));
  await decodes("a TIFF whose directory chain points back at itself", tiff([page(40, 30)], { lastNext: 8 }));
  await refusedBy("a TIFF whose first page is past the cap", tiff([hollow(5000, 5000), page(40, 30)]), /^source image too large \(5000x5000; max 16000000 pixels\)/, convert);
  // The decoder drops a directory whose first entry it cannot read and returns
  // the next one, so that next one is the image the cap applies to.
  await refusedBy("a TIFF whose first kept directory is past the cap", tiff([[[200, 6, 1, 0], ...hollow(10, 10)], hollow(5000, 5000)]), /^source image too large \(5000x5000; max 16000000 pixels\)/, convert);
  await decodes("a TIFF whose first directory the decoder drops", tiff([[[200, 6, 1, 0], ...hollow(10, 10)], page(40, 30)]));
  {
    // The decoder's view is a copy: one directory, and the caller's bytes untouched.
    const before = Buffer.from(secondPage);
    const view = tiffDecoderView(secondPage);
    const next = tiffLayout(secondPage).next;
    ok(view !== secondPage && secondPage.equals(before), "the decoder's view of a TIFF leaves the caller's buffer as it was");
    ok(secondPage.readUInt32LE(next) !== 0 && view.readUInt32LE(next) === 0 && utif.decode(view).length === 1 && utif.decode(secondPage).length === 2, "the view ends the directory chain after the first image");
  }

  // --- Maker notes and sub-directories are stored, not followed --------------
  const nikon = Buffer.concat([Buffer.from("Nikon\0\x02\x10\0\0", "latin1"), Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0, 1, 0, 7, 0, 0, 0, 4, 48, 50, 49, 48, 0, 0, 0, 0])]);
  await decodes("a TIFF with a Nikon maker note", tiff([[...page(40, 30), [37500, 7, nikon.length, nikon]]]));
  const olympus = Buffer.concat([Buffer.from("OLYMP\0\x01\0", "latin1"), Buffer.from([1, 0, 0, 2, 3, 0, 1, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0])]);
  await decodes("a TIFF with an Olympus maker note", tiff([[...page(40, 30), [37500, 7, olympus.length, olympus]]]));
  const exif = Buffer.alloc(18); exif.writeUInt16LE(1, 0); exif.writeUInt16LE(0x8827, 2); exif.writeUInt16LE(3, 4); exif.writeUInt32LE(1, 6); exif.writeUInt16LE(100, 10);
  await decodes("a TIFF with an EXIF directory", tiff([[...page(40, 30), [34665, 4, 1, exif]]]));
  {
    const withNote = tiff([[...page(40, 30), [37500, 7, nikon.length, nikon], [34665, 4, 1, exif]]]);
    const kept = utif.decode(tiffDecoderView(withNote))[0];
    ok(kept.makerNote === undefined && kept.exifIFD === undefined && kept.t256[0] === 40, "the view carries the maker note and EXIF tags under a tag number the decoder does not follow");
  }
  // A sub-directory tag that points at its own directory, and a maker note of
  // a type the decoder cannot read but follows anyway: neither is walked.
  await decodes("a TIFF whose sub-directory tag points at itself", tiff([[...page(40, 30), [330, 4, 1, 8]]]));
  await decodes("a TIFF whose maker note has an unreadable type", tiff([[...page(40, 30), [37500, 6, 0, 8]]]));

  // --- Tag counts, sample layout, tiles ----------------------------------------
  await refusedBy("a TIFF tag declaring 2 billion values", tiff([[...hollow(10, 10), [700, 3, 0x7fffffff, 8]]]), /^tiff tag 700 declares 2147483647 values, more than the file holds/, convert);
  await refusedBy("a TIFF whose tags together declare more values than the file holds", tiff([[...hollow(10, 10), ...Array.from({ length: 200 }, (_, k) => [1000 + k, 3, 60, 8])]]), /^tiff tags declare more value bytes than the file holds/, convert);
  await refusedBy("a TIFF with 60000 bits per sample", tiff([hollow(10, 10, { 258: [258, 3, 1, 60000], 277: [277, 3, 1, 60000] })]), /^source image too large \(tiff samples decode to 45000000000 bytes/, convert);
  await refusedBy("a TIFF with a 9000x9000 tile", tiff([hollow(10, 10, { 273: null, 278: null, 279: null, 322: [322, 4, 1, 9000], 323: [323, 4, 1, 9000], 324: [324, 4, 1, 8], 325: [325, 4, 1, 1] })]), /^source image too large \(tiff tile 9000x9000/, convert);
  await refusedBy("a TIFF whose width is a text value", tiff([hollow(10, 10, { 256: [256, 2, 6, Buffer.from("09000\0")], 257: [257, 2, 6, Buffer.from("09000\0")] })]), /^tiff tag 256 is not a BYTE, SHORT or LONG value/, convert);
  await refusedBy("a TIFF in a compression whose stream sizes its own buffers", tiff([hollow(10, 10, { 259: [259, 3, 1, 9] })]), /^tiff compression 9 is not supported/, convert);
  // Raw sensor data decodes; the decoder takes its bits per pixel from the
  // strip byte count there, so a count that implies a gigabyte is refused.
  await decodes("a TIFF of raw sensor data", tiff([page(40, 30, { 262: [262, 3, 1, 32803] })]), (f) => f.width === 40 && f.height === 30);
  await refusedBy("a raw sensor TIFF whose byte count implies a gigabyte of samples", tiff([hollow(10, 10, { 262: [262, 3, 1, 32803], 278: [278, 4, 1, 1], 279: [279, 4, 1, 100000000] })]), /^source image too large \(tiff samples decode to 1000000000 bytes/, convert);
  await decodes("a TIFF with BYTE size tags", tiff([page(40, 30, { 256: [256, 1, 1, 40], 257: [257, 1, 1, 30] })]));
  await decodes("a TIFF with SHORT size tags", tiff([page(40, 30, { 256: [256, 3, 1, 40], 257: [257, 3, 1, 30], 278: [278, 3, 1, 30] })]));
  // A byte count past the end of the file is cut to the file in the view.
  const literal = Buffer.concat(Array.from({ length: 12 }, (_, k) => Buffer.concat([Buffer.from([99]), samples(40, 30).subarray(k * 100, k * 100 + 100)])));
  await decodes("a PackBits TIFF", tiff([page(40, 30, { 259: [259, 3, 1, 32773], 273: [273, 4, 1, literal], 279: [279, 4, 1, literal.length] })]));
  await decodes("a PackBits TIFF whose byte count is 2^31", tiff([page(40, 30, { 259: [259, 3, 1, 32773], 273: [273, 4, 1, literal], 279: [279, 4, 1, 0x7fffffff] })]));

  // --- Deflate: inflated under the page's size first ---------------------------
  const swollen = zlibMod.deflateSync(Buffer.alloc(64e6), { level: 9 });
  await refusedInWorker("a deflate TIFF strip that inflates past its page", tiff([page(10, 10, { 259: [259, 3, 1, 8], 273: [273, 4, 1, swollen], 279: [279, 4, 1, swollen.length] })]), /^tiff strip 0 inflates past the 10x10 page its directory declares/);
  for (const scheme of [8, 32946]) {
    const z = zlibMod.deflateSync(samples(40, 30));
    await decodes(`a deflate TIFF (compression ${scheme})`, tiff([page(40, 30, { 259: [259, 3, 1, scheme], 273: [273, 4, 1, z], 279: [279, 4, 1, z.length] })]));
  }

  // --- JPEG inside a TIFF: every frame header the decoder could read is capped --
  const seg = (marker, data) => { const b = Buffer.alloc(4); b[0] = 0xff; b[1] = marker; b.writeUInt16BE(data.length + 2, 2); return Buffer.concat([b, data]); };
  const jpg = Buffer.from(await new Jimp({ width: 16, height: 16, color: 0x336699ff }).getBuffer(JimpMime.jpeg));
  const jpegPage = (scheme, strip, extra = [], w = 16, h = 16, spp = 3) => tiff([[...page(w, h, { 259: [259, 3, 1, scheme], 262: [262, 3, 1, 6], 277: [277, 3, 1, spp], 273: [273, 4, 1, strip], 279: [279, 4, 1, strip.length] }), ...extra].sort((a, b) => a[0] - b[0])]);
  const blue = (f) => { const c = f.getPixelColor(8, 8) >>> 0; return f.width === 16 && f.height === 16 && Math.abs((c >>> 24) - 0x33) < 6 && Math.abs(((c >>> 16) & 255) - 0x66) < 6 && Math.abs(((c >>> 8) & 255) - 0x99) < 6; };
  await decodes("a JPEG-compressed TIFF (compression 7)", jpegPage(7, jpg), blue);
  await decodes("an old-style JPEG TIFF (compression 6)", jpegPage(6, jpg), blue);
  const segs = []; let sp = 2; while (jpg[sp + 1] !== 0xda) { const n = 2 + jpg.readUInt16BE(sp + 2); segs.push(jpg.subarray(sp, sp + n)); sp += n; }
  const isTable = (s) => s[1] === 0xdb || s[1] === 0xc4, SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);
  const jpegTables = Buffer.concat([SOI, ...segs.filter(isTable), EOI]);
  await decodes("a JPEG TIFF with its tables in the JPEGTables tag", jpegPage(7, Buffer.concat([SOI, ...segs.filter((s) => !isTable(s)), jpg.subarray(sp)]), [[347, 7, jpegTables.length, jpegTables]]), blue);
  let sofAt = 2; while (jpg[sofAt + 1] !== 0xc0) sofAt += 2 + jpg.readUInt16BE(sofAt + 2);
  const wide = Buffer.from(jpg); wide.writeUInt16BE(9000, sofAt + 5); wide.writeUInt16BE(9000, sofAt + 7);
  const frame = wide.subarray(sofAt, sofAt + 2 + wide.readUInt16BE(sofAt + 2));
  await refusedInWorker("a JPEG TIFF whose stream declares 9000x9000 behind a 10x10 page", jpegPage(7, wide, [], 10, 10), /^source image too large \(tiff embedded jpeg frame 9000x9000; max/, ["image-convert", "image-crop"]);
  await refusedInWorker("an old-style JPEG TIFF whose stream declares 9000x9000", jpegPage(6, wide, [], 10, 10), /^source image too large \(tiff embedded jpeg frame 9000x9000; max/, ["image-convert"]);
  await refusedInWorker("a JPEG TIFF with a 9000x9000 frame header inside a comment segment", jpegPage(7, Buffer.concat([jpg.subarray(0, 2), seg(0xfe, frame), jpg.subarray(2)]), [], 10, 10), /^source image too large \(tiff embedded jpeg frame 9000x9000/, ["image-convert"]);
  await refusedInWorker("a JPEG TIFF whose tables end in 0xFF and whose strip begins with the rest of a frame header", jpegPage(7, Buffer.concat([frame.subarray(1), jpg.subarray(sofAt)]), [[347, 7, 5, Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xd9])]], 10, 10), /^source image too large \(tiff embedded jpeg frame 9000x9000/, ["image-convert"]);
  await refusedInWorker("a JPEG TIFF whose tables stop inside a frame header", jpegPage(7, jpg, [[347, 7, 9, Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0xff, 0xd9])]], 10, 10), /^tiff jpeg data ends inside a frame header/, ["image-convert"]);
  const fiveParts = Buffer.from(frame); fiveParts.writeUInt16BE(16, 5); fiveParts.writeUInt16BE(16, 7); fiveParts[9] = 200;
  await refusedInWorker("a JPEG TIFF whose frame header declares 200 components", jpegPage(7, Buffer.concat([jpg.subarray(0, 2), seg(0xfe, fiveParts), jpg.subarray(2)])), /^tiff embedded jpeg frame declares 200 components/, ["image-convert"]);
  await refusedBy("an old-style JPEG TIFF with 200 samples per pixel", jpegPage(6, jpg, [], 16, 16, 200), /^tiff jpeg page declares 200 samples per pixel/, convert);
  await refusedBy("an old-style JPEG TIFF whose interchange stream runs past the file", jpegPage(6, jpg, [[513, 4, 1, 8], [514, 4, 1, 0x7fffffff]]), /^tiff jpeg interchange stream runs past the end of the file/, convert);

  // --- CCITT (fax): decoded in a child process with its own heap ceiling -------
  // Run-length codes come from the decoder's own tables. Rows: white, 8 black, white.
  const [whiteCodes, blackCodes] = utif.decode._lens.map((m) => Object.fromEntries(Object.entries(m).map(([code, n]) => [n, code])));
  const run = (n, black) => { const t = black ? blackCodes : whiteCodes; return (n >= 64 ? t[n - (n % 64)] : "") + t[n % 64]; };
  const pack = (s) => { const b = Buffer.alloc(Math.ceil(s.length / 8)); for (let k = 0; k < s.length; k++) if (s[k] === "1") b[k >> 3] |= 0x80 >> (k & 7); return b; };
  const rowRuns = (w, y) => [2 + 2 * (y % 8), 8, w - 10 - 2 * (y % 8)].map((n, k) => run(n, k === 1)).join("");
  const faxPage = (scheme, w, h, data) => tiff([page(w, h, { 258: [258, 3, 1, 1], 259: [259, 3, 1, scheme], 262: [262, 3, 1, 0], 273: [273, 4, 1, data], 279: [279, 4, 1, data.length] })]);
  const byteAligned = (s) => s + "0".repeat((8 - (s.length % 8)) % 8);
  const stripes = (f, w) => f.width === w && f.height === 24 && at(f, 1, 0) === "ffffffff" && at(f, 5, 0) === "000000ff" && at(f, 11, 0) === "ffffffff" && at(f, 7, 3) === "ffffffff" && at(f, 9, 3) === "000000ff";
  await decodes("a CCITT 1D TIFF (compression 2)", faxPage(2, 64, 24, pack(Array.from({ length: 24 }, (_, y) => byteAligned(rowRuns(64, y))).join(""))), (f) => stripes(f, 64));
  await decodes("a CCITT T.4 TIFF (compression 3)", faxPage(3, 64, 24, pack(Array.from({ length: 24 }, (_, y) => "000000000001" + rowRuns(64, y)).join(""))), (f) => stripes(f, 64));
  await decodes("a CCITT T.6 TIFF (compression 4)", faxPage(4, 32, 24, pack(Array.from({ length: 24 }, () => "001" + run(8, false) + run(8, true) + "1").join(""))), (f) => f.width === 32 && f.height === 24 && at(f, 4, 5) === "ffffffff" && at(f, 12, 5) === "000000ff" && at(f, 20, 5) === "ffffffff");
  // 64 KB of the code for a 2560-pixel run, behind a 100x100 page. The decoder
  // keeps appending to one row; the child reaches its heap ceiling and ends,
  // the worker answers 400, and the pool goes on serving.
  const endless = faxPage(2, 100, 100, pack("000000011111".repeat(43000)));
  for (const slug of ["image-convert", "image-dominant-color"]) {
    const a = await attempt(tool(slug), endless, { format: "png" });
    ok(a.code === 400 && /^tiff fax data does not decode within the memory its page size allows/.test(a.msg || "") && a.ms < 4000, `${slug} contains a fax TIFF whose rows never end (${endless.length} bytes in; got ${a.code} "${a.msg}" in ${a.ms}ms)`);
  }
  await decodes("an uncompressed gray TIFF, after a contained fax decode", tiff([page(40, 30)]));

  fuzzSeeds.tiff.push(secondPage, tiff([page(40, 30)]), tiff([[...page(40, 30), [37500, 7, nikon.length, nikon], [34665, 4, 1, exif]]]), jpegPage(7, jpg), jpegPage(6, jpg),
    tiff([page(40, 30, { 259: [259, 3, 1, 8], 273: [273, 4, 1, zlibMod.deflateSync(samples(40, 30))], 279: [279, 4, 1, zlibMod.deflateSync(samples(40, 30)).length] })]),
    tiff([page(40, 30, { 259: [259, 3, 1, 32773], 273: [273, 4, 1, literal], 279: [279, 4, 1, literal.length] })]),
    faxPage(4, 32, 24, pack(Array.from({ length: 24 }, () => "001" + run(8, false) + run(8, true) + "1").join(""))));

  // --- Two files the fuzz below found (stored deflated) ---------------------------
  // 1: a tile byte count that sits inside the directory itself, so cutting it
  // to the file's length rewrites the width tag the decoder then reads. The
  // view is checked again as the decoder will read it. 2: a CCITT strip offset
  // far past the end of the file, which the decoder would count its way up to.
  for (const [label, packed] of [
    ["a TIFF whose byte count overlaps its directory", "8/TUYuBgYGDgYmBgZGFgZGBgEGFgYGBEYjMxMoPZIFXMUDYIsyGxRZHYTowsDCxA+TYGBgZXKFuAgYHBBWomiO0MZU9jgIBlIMzIwLCMiYFhGTPUIBTMxMzCysbOwcnFzcPLxy8gKCQsIiomLiEpJS0jKyevoKikrKKqpq6hqaWto6unb2BoZGxiamZuYWllbWNrZ+/g6OTs4urm7uHp5e3j6+cfEBgUHBIaFh4RGRUdExsXn5CYlJySmpaekZmVnZObl19QWFRcUlpWXlFZVV1TW1ff0NjU3NLa1t7R2dXd09vXP2HipMlTpk6bPmPmrNlz5s6bv2DhosVLli5bvmLlqtVr1q5bv2Hjps1btm7bvmPnrt179u7bf+DgocNHjh47fuLkqdNnzp47f+HipctXrl67fuPmrdt37t67/+Dho8dPnj57/uLlq9dv3r57/+Hjp89fvn77/uPnr99//v77P1z9RWy8Dld/ERuvw9VfxMYrAA=="],
    ["a CCITT TIFF whose strip offset is past the end of the file", "8/TUYuBgYGDgZGBgZGFgZGBgUGBgYGCEsiUYGBiYGJnBbBBmhrJZGBgY2KBsEBCEqmcwFkvTORM5Y7NhWtKZowwMYkjmiEPZuhAtVQwMDKJwo2d2o+jE4AIA"],
  ]) {
    const a = await attempt(tool("image-convert"), zlibMod.inflateRawSync(Buffer.from(packed, "base64")), { format: "png" });
    ok((a.code === 400 || a.code === 200) && a.ms < 1500, `${label} is answered at once (got ${a.code} "${a.msg || ""}" in ${a.ms}ms)`);
  }

  // --- The main-thread check has a fixed budget -----------------------------------
  // A directory may declare 65,535 entries and a strip table millions of rows.
  // The pool's check reads 4,096 of them and then leaves the file to the
  // worker, which runs the whole check before it decodes.
  {
    const { assertTiffHeader } = await import("../src/tools/image-headers.js");
    const wideDirectory = (count) => {
      const b = Buffer.alloc(8 + 2 + count * 12 + 4 + 16); b.write("II", 0, "latin1"); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4); b.writeUInt16LE(count, 8);
      for (let k = 0; k < count; k++) { const e = 10 + k * 12; b.writeUInt16LE(1000 + (k % 30000), e); b.writeUInt16LE(1, e + 2); }
      const last = 10 + (count - 1) * 12; b.writeUInt16LE(330, last); b.writeUInt16LE(4, last + 2); b.writeUInt32LE(1, last + 4); b.writeUInt32LE(8, last + 8); // a sub-directory tag naming this directory
      b.writeUInt16LE(256, 10); b.writeUInt16LE(3, 12); b.writeUInt32LE(1, 14); b.writeUInt32LE(16, 18);
      return b;
    };
    const rows = 400000, table = Buffer.alloc(rows * 4);
    const longTable = tiff([page(10, 10, { 259: [259, 3, 1, 32773], 273: [273, 4, rows, table], 279: [279, 4, rows, table] })]);
    for (const [label, file] of [["a 65,535-entry directory", wideDirectory(65535)], ["a 400,000-row strip table", longTable]]) {
      const ms = cpuMs(() => assertDeclaredWithinPixelCap(file, 16e6, { mainThread: true }));
      ok(assertTiffHeader(file, 16e6, { mainThread: true }) === false && ms < 5, `the main-thread check leaves ${label} (${file.length} bytes) to the worker after ${ms.toFixed(2)} ms of CPU (< 5 ms)`);
      const a = await attempt(tool("image-convert"), file, { format: "png" });
      ok((a.code === 400 || a.code === 200) && a.ms < 2000, `${label} is then answered by the worker (got ${a.code} "${a.msg || ""}" in ${a.ms}ms)`);
    }
    // The pool's own call is the budgeted one: the synchronous part of handing
    // it the widest directory (its check, before the job is queued) stays small.
    {
      const { runImageOffThread } = await import("../src/tools/image-pool.js");
      const widest = wideDirectory(65535), pending = [];
      const ms = cpuMs(() => { pending.push(runImageOffThread({ op: "convert", buffer: widest, params: { format: "png" } }).catch(() => null)); });
      await Promise.all(pending);
      ok(ms < 5, `the pool queues a 65,535-entry TIFF after ${ms.toFixed(2)} ms of main-thread CPU (< 5 ms)`);
    }
    // What the main thread deferred is still held to every bound.
    const deferredAndTooLarge = wideDirectory(6000); deferredAndTooLarge.writeUInt16LE(257, 22); deferredAndTooLarge.writeUInt16LE(3, 24); deferredAndTooLarge.writeUInt32LE(1, 26); deferredAndTooLarge.writeUInt32LE(16, 30);
    deferredAndTooLarge.writeUInt16LE(258, 34); deferredAndTooLarge.writeUInt16LE(3, 36); deferredAndTooLarge.writeUInt32LE(1, 38); deferredAndTooLarge.writeUInt32LE(60000, 42);
    deferredAndTooLarge.writeUInt16LE(277, 46); deferredAndTooLarge.writeUInt16LE(3, 48); deferredAndTooLarge.writeUInt32LE(1, 50); deferredAndTooLarge.writeUInt32LE(60000, 54);
    const a = await attempt(tool("image-convert"), deferredAndTooLarge, { format: "png" });
    ok(assertTiffHeader(deferredAndTooLarge, 16e6, { mainThread: true }) === false && a.code === 400 && /^source image too large \(tiff samples decode to/.test(a.msg || ""), `a deferred TIFF past the sample cap is refused by the worker (got ${a.code} "${a.msg}")`);
    ok(assertTiffHeader(tiff(Array.from({ length: 40 }, () => page(40, 30))), 16e6, { mainThread: true }) === true, "a real 40-page TIFF is checked in full on the main thread");
  }

  // --- The rest of the ordinary shapes -------------------------------------------
  // Tiled: 20x20 in four 16x16 tiles; tile s holds (k + 40s) at sample k.
  const tiles = Buffer.concat([0, 1, 2, 3].map((s) => Buffer.from(Array.from({ length: 256 }, (_, k) => (k + s * 40) & 255))));
  const tiledDir = (dataAt) => [[256, 4, 1, 20], [257, 4, 1, 20], [258, 3, 1, 8], [259, 3, 1, 1], [262, 3, 1, 1], [277, 3, 1, 1], [322, 4, 1, 16], [323, 4, 1, 16],
    [324, 4, 4, Buffer.from(new Uint32Array([0, 1, 2, 3].map((s) => dataAt + s * 256)).buffer)], [325, 4, 4, Buffer.from(new Uint32Array([256, 256, 256, 256]).buffer)]];
  const tiledLen = tiff([tiledDir(0)]).length;
  await decodes("a tiled TIFF", Buffer.concat([tiff([tiledDir(tiledLen)]), tiles]), (f) => f.width === 20 && f.height === 20 && at(f, 1, 1) === gray(17) && at(f, 17, 17) === gray(17 + 120));
  await decodes("the TIFF encoder's own output", Buffer.from(await new Jimp({ width: 30, height: 20, color: 0x3366ccff }).getBuffer("image/tiff")), (f) => f.width === 30 && f.height === 20 && at(f, 5, 5) === "3366ccff");
}

// BMP and WebP. The BMP decoder reads the width unsigned and treats a negative
// height as top-down, so a "negative" width is a width past 2^31: the header
// reader now answers the same number and the cap refuses it. No WebP decoder
// is installed, so a WebP is answered with a 400 and nothing is allocated.
{
  const bmp = Buffer.from(await new Jimp({ width: 8, height: 8, color: 0x336699ff }).getBuffer(JimpMime.bmp));
  const negativeWidth = Buffer.from(bmp); negativeWidth.writeInt32LE(-8, 18);
  await refusedBy("a BMP with a negative width", negativeWidth, /^source image too large \(4294967288x8; max/);
  const topDown = Buffer.from(bmp); topDown.writeInt32LE(-8, 22);
  fuzzSeeds.bmp.push(bmp, topDown);
  let b = await decoded(topDown);
  ok(b.width === 8 && b.height === 8 && hex(b.getPixelColor(2, 2)) === "336699ff", `a top-down BMP (negative height) still decodes (${b.width}x${b.height}, ${hex(b.getPixelColor(2, 2))})`);
  b = await decoded(Buffer.from(await new Jimp({ width: 33, height: 17, color: 0x336699ff }).getBuffer(JimpMime.bmp)));
  ok(b.width === 33 && b.height === 17 && hex(b.getPixelColor(32, 16)) === "336699ff", `a BMP with padded rows still decodes (${b.width}x${b.height})`);

  const webp = Buffer.alloc(40); webp.write("RIFF", 0); webp.writeUInt32LE(32, 4); webp.write("WEBPVP8X", 8); webp.writeUInt32LE(10, 16); webp.writeUIntLE(9, 24, 3); webp.writeUIntLE(9, 27, 3);
  const w = await attempt(tool("image-convert"), webp, { format: "png" });
  ok(w.code === 400 && /does not support decoding/.test(w.msg || ""), `a WebP is refused before any decoder runs (got ${w.code} "${w.msg}")`);
}

// The pool ends a job at ITS deadline. A 16M-pixel decode takes hundreds of
// milliseconds, so a job given 40 ms is terminated (503, not charged) well
// before the 5 s default would have let it finish.
{
  const { runImageOffThread } = await import("../src/tools/image-pool.js");
  const big = Buffer.from(await new Jimp({ width: 4000, height: 4000, color: 0x3366ffff }).getBuffer(JimpMime.png));
  const t0 = Date.now(); let out = null;
  try { await runImageOffThread({ op: "resize", buffer: big, params: { width: 64 }, timeoutMs: 40 }); out = { code: 200 }; } catch (e) { out = { code: e.statusCode, msg: e.message }; }
  const ms = Date.now() - t0;
  ok(out.code === 503 && /timed out \(>40ms\)/.test(out.msg || "") && ms < 1500, `a job given timeoutMs 40 is terminated at that deadline (got ${out.code} "${out.msg || ""}" in ${ms}ms)`);
  const after = await runImageOffThread({ op: "resize", buffer: Buffer.from(srcB64, "base64"), params: { width: 10 } });
  ok(after.__binary.length > 0, "the pool serves the next job after ending one at its deadline");
}

// The wallet-only tools admit the larger source cap. A 4100x4100 image (16.81M
// pixels) sits between the free cap (16M) and the wallet cap (40M): the free
// resize refuses it from the header, crop and dominant-color decode it.
{
  const zl = await import("node:zlib");
  const crc32 = (b) => { let crc = 0xffffffff; for (let n = 0; n < b.length; n++) { let c = (crc ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
  const W = 4100; const head = Buffer.alloc(13); head.writeUInt32BE(W, 0); head.writeUInt32BE(W, 4); head[8] = 8;
  const raw = Buffer.alloc((W + 1) * W, 0x80); for (let y = 0; y < W; y++) raw[y * (W + 1)] = 0; // filter byte per row
  const between = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", zl.deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]).toString("base64");
  let code = 200, msg = "";
  try { await tool("image-resize")({ image: between, width: 64 }); } catch (e) { code = e.statusCode; msg = e.message; }
  ok(code === 400 && /^source image too large \(4100x4100; max 16000000 pixels\)/.test(msg), `image-resize refuses a 16.81M-pixel image at the free cap (got ${code} "${msg}")`);
  const run = async (slug, input) => { try { return await tool(slug)(input); } catch (e) { return { error: `${e.statusCode} ${e.message}` }; } };
  const d = await run("image-dominant-color", { image: between, colors: 1 });
  ok(d.width === W && d.height === W && d.colors?.[0]?.hex === "#808080", `image-dominant-color accepts it under the wallet cap (${d.error || `${d.width}x${d.height} ${d.colors[0].hex}`})`);
  const c = await run("image-crop", { image: between, left: 4000, top: 4000, width: 32, height: 32, dataUri: true });
  ok(c.width === 32 && c.height === 32, `image-crop accepts it under the wallet cap (${c.error || `${c.width}x${c.height}`})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
