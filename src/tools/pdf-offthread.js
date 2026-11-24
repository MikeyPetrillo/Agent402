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
// with up to PDF_QUEUE_MAX calls waiting for a slot, bounded per caller
// (src/pool-admission.js): past it a caller already holding a place answers
// 503 with nothing charged, and a caller holding nothing is queued over it up
// to PDF_QUEUE_HARD_MAX calls whose documents hold PDF_QUEUE_HARD_BYTES at
// most together, where it takes the newest place of the party holding the
// most. A free slot goes to the waiting call whose caller holds the fewest
// places. A call's deadline starts when its worker does.
import { Worker } from "node:worker_threads";
import { threadEnv } from "./child-env.js";
import { fileURLToPath } from "node:url";
import { createPoolAdmission, poolCaller } from "../pool-admission.js";
import { notChargedHere } from "../not-charged.js";

const PDF_WORKER = fileURLToPath(new URL("./pdf-worker.js", import.meta.url));
// What the worker's import graph reads (lazy-deps.js).
const PDF_WORKER_ENV = ["LAZY_DEPS_WARM_GAP_MS"];
export const PDF_JOB_TIMEOUT_MS = 20_000;
// Decoded stream bytes one job may allocate (object and cross-reference
// streams, which pdf-lib inflates while loading). Real documents use a tiny
// fraction of this; a compressed stream that inflates past it is refused.
export const PDF_DECODE_CAP_BYTES = 128 * 1024 * 1024;
const HEAP_MB = 1024;
const intEnv = (v, d) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : d; };
export const PDF_WORKERS_MAX = intEnv(process.env.PDF_WORKERS_MAX, 2);
export const PDF_QUEUE_MAX = intEnv(process.env.PDF_QUEUE_MAX, 16);
/** Past PDF_QUEUE_MAX a caller holding nothing is queued up to half again as
 *  many calls, while the documents of every waiting call, its own included,
 *  hold at most 320 MB (sixteen single documents at the 20 MB fetch cap). */
export const PDF_QUEUE_HARD_MAX = Math.ceil(1.5 * PDF_QUEUE_MAX);
export const PDF_QUEUE_HARD_BYTES = 320 * 1024 * 1024;
let running = 0;
const waiting = [];
const admission = createPoolAdmission({ soft: PDF_QUEUE_MAX, hard: PDF_QUEUE_HARD_MAX, hardBytes: PDF_QUEUE_HARD_BYTES });
const shed = (message) => Object.assign(new Error(message), { statusCode: 503, retryAfter: 5, shed: true });
const busy = () => shed(`PDF processing is busy; retry in a few seconds.${notChargedHere()}`);
const busyOwn = () => shed(`PDF processing is busy, with this caller's earlier documents already waiting; send this one once one of them is answered.${notChargedHere()}`);
function acquire(who, bytes) {
  if (running < PDF_WORKERS_MAX && waiting.length === 0) { running++; admission.hold(who); return Promise.resolve(); }
  const admitted = admission.admit(waiting, who, bytes);
  if (admitted.refused) return Promise.reject(admitted.refused === "own" ? busyOwn() : busy());
  for (const v of admitted.evicted) { admission.free(v.who); v.reject(busy()); }
  admission.hold(who);
  return new Promise((resolve, reject) => waiting.push({ who, bytes, resolve, reject }));
}
function release(who) {
  admission.free(who);
  const at = admission.next(waiting);
  if (at >= 0) waiting.splice(at, 1)[0].resolve(); else running--;
}
/** Workers running and calls waiting, for tests and status. */
export function pdfPoolState() { return { running, waiting: waiting.length, callers: admission.callers() }; }
let workerPath = PDF_WORKER;
/** Tests: run jobs on another worker script (null restores the PDF worker). */
export function __setPdfWorkerForTest(path) { workerPath = path || PDF_WORKER; }

function refused(message) {
  return Object.assign(new Error(message), { statusCode: 422 });
}

/** Run one PDF transform (pdf-ops.js PDF_OPS) off the main thread. Resolves
 *  with the transform's answer; rejects with its statusCode and message. */
export async function runPdfOp(op, buffers, args = [], opts = {}) {
  const who = poolCaller();
  const bytes = (Array.isArray(buffers) ? buffers : []).reduce((n, b) => n + (Number(b?.length) || 0), 0);
  await acquire(who, bytes);
  try { return await runPdfWorker(op, buffers, args, opts); } finally { release(who); }
}
function runPdfWorker(op, buffers, args, { timeoutMs = PDF_JOB_TIMEOUT_MS, decodeCapBytes = PDF_DECODE_CAP_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      env: threadEnv(PDF_WORKER_ENV),
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
