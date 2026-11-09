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
  const p = await decoded(interlaced);
  ok(p.width === 5 && p.height === 5 && hex(p.getPixelColor(0, 0)) === "404040ff" && hex(p.getPixelColor(4, 4)) === "404040ff", `an interlaced PNG still decodes to its pixels (${p.width}x${p.height}, ${hex(p.getPixelColor(4, 4))})`);
  // A text chunk that spells IHDR in its data is not a second header.
  const q = await decoded(png(ihdr(4, 4), chunk("tEXt", Buffer.from("Comment\0IHDR IHDR")), idat(Buffer.alloc(4 * 5))));
  ok(q.width === 4 && q.height === 4, `a PNG with "IHDR" inside a text chunk still decodes (${q.width}x${q.height})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
