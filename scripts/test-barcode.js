// Round-trip tests for barcode-decode: generate a QR with the qrcode dep, encode
// it as PNG and JPEG, and confirm the decoder reads it back. Also checks the
// not-found path and input validation. Pure functions, no server needed.
import QR from "qrcode";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import zlib from "node:zlib";
import { BARCODE_TOOLS } from "../src/tools/barcode-kit.js";

const handler = BARCODE_TOOLS[0].handler;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const PAYLOAD = "https://agent402.tools/x402";
const pngBuf = await QR.toBuffer(PAYLOAD, { type: "png", margin: 2, width: 300 });

// PNG path
let r = await handler({ image: pngBuf.toString("base64") });
ok(r.found && r.text === PAYLOAD, `decode QR from PNG base64 (got ${JSON.stringify(r.text)}, ${r.decoder})`);

// data: URL prefix
r = await handler({ image: "data:image/png;base64," + pngBuf.toString("base64") });
ok(r.found && r.text === PAYLOAD, `decode QR from data: URL`);

// JPEG path (re-encode the PNG pixels as JPEG, high quality so the QR survives)
const png = PNG.sync.read(pngBuf);
const jpgBuf = jpeg.encode({ data: Buffer.from(png.data), width: png.width, height: png.height }, 92).data;
r = await handler({ image: jpgBuf.toString("base64") });
ok(r.found && r.text === PAYLOAD, `decode QR from JPEG base64 (got ${JSON.stringify(r.text)}, ${r.decoder})`);

// not-found: a blank white PNG
const blank = new PNG({ width: 64, height: 64 });
blank.data.fill(255);
r = await handler({ image: PNG.sync.write(blank).toString("base64") });
ok(r.found === false && r.text === null, `blank image returns found:false`);

// validation
try { await handler({}); ok(false, "missing image should throw"); } catch (e) { ok(e.statusCode === 400, "missing image throws 400"); }
try { await handler({ image: "not!!base64!!@@" }); ok(true, "garbage input handled without crash"); } catch (e) { ok(e.statusCode === 400, "garbage input throws 400"); }

// Size bounds and the event loop. A small PNG can declare a huge canvas; the
// cap must be read from the header (refused before any decode), and an image
// inside the cap must be decoded and scanned off the main thread. The loop is
// sampled every 5 ms while each call runs; the bound is far above a healthy
// sample and far below an inline decode of these images.
function crc32(b) { let c, crc = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
function blankPng(w, h, bitDepth) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = bitDepth;
  const rowBytes = Math.ceil((w * bitDepth) / 8) + 1;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.alloc(rowBytes * h), { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
async function withLoopLag(fn) {
  let last = performance.now(), worst = 0;
  const iv = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; }, 5);
  await new Promise((r) => setTimeout(r, 20));
  let out;
  try { out = { value: await fn() }; } catch (e) { out = { error: e }; }
  await new Promise((r) => setTimeout(r, 20));
  clearInterval(iv);
  return { ...out, lagMs: Math.round(worst) };
}
const LAG_BOUND_MS = 150;
const bomb = blankPng(16000, 16000, 1);
let m = await withLoopLag(() => handler({ image: bomb.toString("base64") }));
ok(m.error?.statusCode === 400 && /too large/.test(m.error.message), `1-bit 16000x16000 PNG refused 400 from its header (${m.error?.message})`);
ok(m.lagMs < LAG_BOUND_MS, `oversized PNG holds the loop under ${LAG_BOUND_MS} ms (worst ${m.lagMs} ms)`);
m = await withLoopLag(() => handler({ image: blankPng(4096, 4096, 8).toString("base64") }));
ok(m.value?.found === false, `4096x4096 blank PNG is decoded and scanned (found ${m.value?.found}, ${m.error?.message || "no error"})`);
ok(m.lagMs < LAG_BOUND_MS, `4096x4096 decode and scan hold the loop under ${LAG_BOUND_MS} ms (worst ${m.lagMs} ms)`);
// A PNG whose header cannot be read is refused before decoding.
const noIhdr = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IDAT", zlib.deflateSync(Buffer.alloc(64)))]);
try { await handler({ image: noIhdr.toString("base64") }); ok(false, "unreadable PNG header should throw"); }
catch (e) { ok(e.statusCode === 400 && /unreadable header/.test(e.message), `unreadable PNG header refused 400 (${e.message})`); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
