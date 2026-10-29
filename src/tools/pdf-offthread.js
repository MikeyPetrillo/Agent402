// Main-thread side of the PDF worker: one worker thread per call (pdf-worker.js)
// with a heap limit and a wall-clock deadline. pdf-lib parses and decodes
// synchronously, so the only lever on a document that overruns is terminating
// its thread; a fresh thread per call also means each job's decoded-byte count
// starts at zero. Spawning costs tens of milliseconds, small against a fetch.
//
// Refusals here are 422: the input could not be processed within the limits.
// Like every response at or above 400, they cancel x402 settlement.
//
// At most PDF_WORKERS_MAX workers run at once (each may hold its heap limit),
// with up to PDF_QUEUE_MAX calls waiting for a slot; past that a call answers
// 503 with nothing charged. A call's deadline starts when its worker does.
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const PDF_WORKER = fileURLToPath(new URL("./pdf-worker.js", import.meta.url));
export const PDF_JOB_TIMEOUT_MS = 20_000;
// Decoded stream bytes one job may allocate (object and cross-reference
// streams, which pdf-lib inflates while loading). Real documents use a tiny
// fraction of this; a compressed stream that inflates past it is refused.
export const PDF_DECODE_CAP_BYTES = 128 * 1024 * 1024;
const HEAP_MB = 1024;
const intEnv = (v, d) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : d; };
export const PDF_WORKERS_MAX = intEnv(process.env.PDF_WORKERS_MAX, 2);
export const PDF_QUEUE_MAX = intEnv(process.env.PDF_QUEUE_MAX, 16);
let running = 0;
const waiting = [];
function acquire() {
  if (running < PDF_WORKERS_MAX) { running++; return Promise.resolve(); }
  if (waiting.length >= PDF_QUEUE_MAX) {
    return Promise.reject(Object.assign(new Error("PDF processing is busy; retry in a few seconds. Nothing was charged."), { statusCode: 503, retryAfter: 5, shed: true }));
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running--;
}
/** Workers running and calls waiting, for tests and status. */
export function pdfPoolState() { return { running, waiting: waiting.length }; }

function refused(message) {
  return Object.assign(new Error(message), { statusCode: 422 });
}

/** Run one PDF transform (pdf-ops.js PDF_OPS) off the main thread. Resolves
 *  with the transform's answer; rejects with its statusCode and message. */
export async function runPdfOp(op, buffers, args = [], opts = {}) {
  await acquire();
  try { return await runPdfWorker(op, buffers, args, opts); } finally { release(); }
}
function runPdfWorker(op, buffers, args, { timeoutMs = PDF_JOB_TIMEOUT_MS, decodeCapBytes = PDF_DECODE_CAP_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(PDF_WORKER, {
      workerData: { op, buffers, args, decodeCapBytes },
      resourceLimits: { maxOldGenerationSizeMb: HEAP_MB, maxYoungGenerationSizeMb: 64 },
    });
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, refused(`PDF processing took longer than ${timeoutMs / 1000}s`)), timeoutMs);
    worker.on("message", (msg) => {
      if (msg.error) finish(reject, Object.assign(new Error(msg.error), { statusCode: msg.statusCode || 500 }));
      else finish(resolve, msg.result);
    });
    worker.on("error", (e) => {
      // ERR_WORKER_OUT_OF_MEMORY: the document outgrew the worker's heap.
      if (e?.code === "ERR_WORKER_OUT_OF_MEMORY") finish(reject, refused("PDF is too large to process"));
      else finish(reject, Object.assign(new Error(`PDF worker error: ${e?.message || e}`), { statusCode: 500 }));
    });
    worker.on("exit", () => finish(reject, Object.assign(new Error("PDF worker stopped unexpectedly"), { statusCode: 500 })));
  });
}
