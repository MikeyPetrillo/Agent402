// Worker that decodes, transforms and re-encodes an image in an isolated thread,
// so the pure-JS synchronous Jimp pipeline can never occupy the server's event
// loop. Those three tools (resize/convert/thumbnail) are free on the authless
// MCP connector and free via proof-of-work, so an unauthenticated caller could
// otherwise stall PAID traffic and the paywall itself: measured before this
// move, three concurrent calls took /health from 39ms to 6.1s.
//
// Unlike src/tools/regex-worker.js this worker is LONG-LIVED and handles one job
// per message. A per-call worker would be correct too, but importing jimp costs
// ~45ms of module evaluation on every spawn (~75-105ms total wall for a job that
// otherwise takes single-digit ms), and that overhead would be paid by every
// caller to contain a pathological minority. The pool in image-pool.js keeps the
// jimp import warm and terminates the worker outright when a job overruns, so
// the containment property is the same as regex-worker's.
import { parentPort } from "node:worker_threads";
import { runImageOp } from "./image-ops.js";
import { loadJimp } from "./lazy-deps.js";

// jimp is a lazy import on the main thread (lazy-deps.js); this thread has no
// listen to protect, so it loads jimp as soon as it starts and the first job
// finds it warm, as the pool expects.
loadJimp().catch(() => { /* the first job's decode reports the failure */ });

parentPort.on("message", async (job) => {
  try {
    const { __binary, contentType } = await runImageOp({
      op: job.op,
      // Structured clone delivers a Uint8Array view; Jimp and the byte-level
      // header reads both want a real Buffer.
      buffer: Buffer.from(job.buffer.buffer, job.buffer.byteOffset, job.buffer.byteLength),
      maxPixels: job.maxPixels,
      params: job.params,
    });
    parentPort.postMessage({ id: job.id, buffer: __binary, contentType });
  } catch (e) {
    // statusCode rides back with the message so a 400 stays a 400 on the wire.
    // An error without one is a defect in here, not bad input, and must not be
    // billed as a served call, hence the 500 default.
    parentPort.postMessage({ id: job.id, error: e.message, statusCode: e.statusCode || 500 });
  }
});
