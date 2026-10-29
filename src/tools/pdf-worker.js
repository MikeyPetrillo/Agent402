// Runs one PDF transform (pdf-ops.js) per thread, for pdf-offthread.js. Before
// the transform runs, pdf-lib's DecodeStream buffer growth is capped: every
// stream filter pdf-lib decodes (Flate, LZW, RunLength, ASCII85, ASCIIHex)
// grows its output through DecodeStream.prototype.ensureBuffer, so one check
// there bounds the decoded bytes whatever the filter chain or object type.
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { PDF_OPS, bad } from "./pdf-ops.js";

const { op, buffers, args, decodeCapBytes } = workerData;
const require = createRequire(import.meta.url);
// pdf-lib has no "exports" map, so `import("pdf-lib")` (lazy-deps.js) loads its
// CJS build: this require returns the same module instance it uses.
const DecodeStream = require("pdf-lib/cjs/core/streams/DecodeStream.js").default;
let allocated = 0;
let capHit = false;
const ensureBuffer = DecodeStream.prototype.ensureBuffer;
DecodeStream.prototype.ensureBuffer = function capped(requested) {
  const before = this.buffer ? this.buffer.byteLength : 0;
  if (requested > before) {
    // The same sizing the original applies (doubling from minBufferLength), so
    // the count is the bytes the next allocation will actually take.
    let size = this.minBufferLength || 512;
    while (size < requested) size *= 2;
    allocated += size;
    if (allocated > decodeCapBytes) {
      capHit = true;
      throw bad(`PDF streams decode past ${Math.round(decodeCapBytes / 1048576)} MB`, 422);
    }
  }
  return ensureBuffer.call(this, requested);
};

const fn = PDF_OPS[op];
try {
  if (!fn) throw bad(`unknown PDF operation: ${op}`, 500);
  // Structured clone delivers Uint8Array views; pdf-lib and the magic-byte
  // checks want Buffers.
  const bufs = buffers.map((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength));
  const result = op === "merge" || op === "imagesToPdf" ? await fn(bufs, ...args) : await fn(bufs[0], ...args);
  // pdf-lib's parser can swallow an error thrown while decoding an object it
  // treats as invalid, so the cap is checked again once the transform returns.
  if (capHit) throw bad(`PDF streams decode past ${Math.round(decodeCapBytes / 1048576)} MB`, 422);
  parentPort.postMessage({ result });
} catch (e) {
  if (capHit) parentPort.postMessage({ error: `PDF streams decode past ${Math.round(decodeCapBytes / 1048576)} MB`, statusCode: 422 });
  else parentPort.postMessage({ error: e.message, statusCode: e.statusCode || 500 });
}
