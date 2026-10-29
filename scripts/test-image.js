// Pure-CPU tests for the image kit: generate an image, then resize / convert /
// thumbnail / crop / palette it and verify the output decodes at the expected
// size and format. The EXIF parser is tested against a hand-crafted TIFF so no
// network is needed (the live URL path is covered by test-all's example check).
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
