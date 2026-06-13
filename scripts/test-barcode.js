// Round-trip tests for barcode-decode: generate a QR with the qrcode dep, encode
// it as PNG and JPEG, and confirm the decoder reads it back. Also checks the
// not-found path and input validation. Pure functions, no server needed.
import QR from "qrcode";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { BARCODE_TOOLS } from "../src/tools/barcode-kit.js";

const handler = BARCODE_TOOLS[0].handler;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const PAYLOAD = "https://agent402.tools/x402";
const pngBuf = await QR.toBuffer(PAYLOAD, { type: "png", margin: 2, width: 300 });

// PNG path
let r = handler({ image: pngBuf.toString("base64") });
ok(r.found && r.text === PAYLOAD, `decode QR from PNG base64 (got ${JSON.stringify(r.text)}, ${r.decoder})`);

// data: URL prefix
r = handler({ image: "data:image/png;base64," + pngBuf.toString("base64") });
ok(r.found && r.text === PAYLOAD, `decode QR from data: URL`);

// JPEG path (re-encode the PNG pixels as JPEG, high quality so the QR survives)
const png = PNG.sync.read(pngBuf);
const jpgBuf = jpeg.encode({ data: Buffer.from(png.data), width: png.width, height: png.height }, 92).data;
r = handler({ image: jpgBuf.toString("base64") });
ok(r.found && r.text === PAYLOAD, `decode QR from JPEG base64 (got ${JSON.stringify(r.text)}, ${r.decoder})`);

// not-found: a blank white PNG
const blank = new PNG({ width: 64, height: 64 });
blank.data.fill(255);
r = handler({ image: PNG.sync.write(blank).toString("base64") });
ok(r.found === false && r.text === null, `blank image returns found:false`);

// validation
try { handler({}); ok(false, "missing image should throw"); } catch (e) { ok(e.statusCode === 400, "missing image throws 400"); }
try { handler({ image: "not!!base64!!@@" }); ok(true, "garbage input handled without crash"); } catch (e) { ok(e.statusCode === 400, "garbage input throws 400"); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
