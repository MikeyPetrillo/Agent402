// Main-thread side of the image worker: a tiny pool of long-lived workers plus a
// bounded queue, so the synchronous Jimp pipeline runs off the event loop with a
// hard ceiling on both time and memory.
//
// Why a pool rather than the per-call worker used by src/tools/kit.js's regex
// path: a fresh worker pays ~45ms to evaluate the jimp module (~75-105ms wall for
// a job that is otherwise single-digit ms), and image tools are ordinary paid
// traffic, not a rare hostile case. Reusing workers keeps that import warm. The
// containment property is unchanged, because a job that overruns still ends in
// worker.terminate() - terminate is the only lever that works, since a worker
// stuck inside a synchronous decode never reads another message.
//
// Bounds and why each one exists:
//  - POOL_MAX caps resident bitmaps. FREE_MAX_SRC_PIXELS allows 16M pixels, i.e.
//    a 64MB RGBA bitmap per in-flight job plus decode/encode intermediates
//    (measured ~900MB RSS with two 16M-pixel bitmaps live in one process), so the
//    pool size is the memory ceiling, not a throughput knob.
//  - QUEUE_MAX caps the pending work behind those workers. Without it a burst
//    would park an unbounded number of ~9MB source buffers on the heap, which is
//    the same memory-exhaustion failure the pool exists to prevent.
//  - JOB_TIMEOUT_MS is a wall-clock backstop above the worst case the caps allow:
//    measured on a 16M-pixel source, decode was 160-570ms, resize 130-240ms and
//    the largest permitted PNG encode ~600ms-1.3s, so ~2s is the realistic worst
//    case and 5s means a genuine job is never killed while a pathological one
//    frees its slot quickly.
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { assertDeclaredWithinPixelCap, FREE_MAX_SRC_PIXELS } from "./image-ops.js";

const IMAGE_WORKER = fileURLToPath(new URL("./image-worker.js", import.meta.url));
const POOL_MAX = 2;
const QUEUE_MAX = 32;
const JOB_TIMEOUT_MS = 5_000;
// Idle workers are terminated so a burst of large images does not leave its peak
// heap resident for the rest of the process's life; the next call re-spawns.
const IDLE_MS = 30_000;

const slots = [];
const queue = [];
let nextJobId = 1;

// Capacity and internal failure are deliberately NOT 400s: the caller's input was
// acceptable, we could not serve it. A >=400 response also cancels x402
// settlement, so a busy or crashed worker never charges the buyer.
function unavailable(message) {
  return Object.assign(new Error(message), { statusCode: 503 });
}

function settle(slot, fn, arg) {
  const job = slot.job;
  if (!job) return;
  slot.job = null;
  clearTimeout(job.timer);
  fn(arg);
}

function retire(slot) {
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
  clearTimeout(slot.idleTimer);
  slot.worker.terminate();
}

function goIdle(slot) {
  // unref so a pooled worker can never hold the process open: scripts that call
  // these handlers directly, and the server's graceful drain, must both still be
  // able to exit. A busy slot is re-ref'd in assign() so an in-flight job is
  // never abandoned mid-decode.
  slot.worker.unref();
  clearTimeout(slot.idleTimer);
  slot.idleTimer = setTimeout(() => retire(slot), IDLE_MS);
  slot.idleTimer.unref();
}

function spawnSlot() {
  // resourceLimits: a decoder that outgrows the limit dies in its own thread
  // (terminate + 503) instead of taking the process down with it.
  const slot = { worker: new Worker(IMAGE_WORKER, { resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 } }), job: null, idleTimer: null };
  slot.worker.on("message", (msg) => {
    if (!slot.job || msg.id !== slot.job.id) return; // stale reply from a job we already gave up on
    if (msg.error) {
      settle(slot, slot.job.reject, Object.assign(new Error(msg.error), { statusCode: msg.statusCode || 500 }));
    } else {
      settle(slot, slot.job.resolve, {
        __binary: Buffer.from(msg.buffer.buffer, msg.buffer.byteOffset, msg.buffer.byteLength),
        contentType: msg.contentType,
      });
    }
    goIdle(slot);
    pump();
  });
  const die = (message) => {
    settle(slot, slot.job?.reject, unavailable(message));
    retire(slot);
    pump();
  };
  slot.worker.on("error", (e) => die(`image worker error: ${e.message}`));
  slot.worker.on("exit", () => { if (slot.job) die("image worker stopped unexpectedly"); });
  slots.push(slot);
  return slot;
}

function assign(slot, job) {
  slot.job = job;
  clearTimeout(slot.idleTimer);
  slot.worker.ref();
  job.timer = setTimeout(() => {
    // The worker is inside synchronous Jimp code and will not answer another
    // message, so the slot is only recoverable by killing the thread.
    settle(slot, job.reject, unavailable(`image transform timed out (>${JOB_TIMEOUT_MS}ms)`));
    retire(slot);
    pump();
  }, JOB_TIMEOUT_MS);
  slot.worker.postMessage({ id: job.id, op: job.op, buffer: job.buffer, maxPixels: job.maxPixels, params: job.params });
}

function pump() {
  while (queue.length) {
    const slot = slots.find((s) => !s.job) || (slots.length < POOL_MAX ? spawnSlot() : null);
    if (!slot) return;
    assign(slot, queue.shift());
  }
}

/** Run one decode/transform/encode off the main thread. Resolves with the same
 *  { __binary, contentType } shape the inline implementation returned, and
 *  rejects with the same messages and statusCode values. */
export function runImageOffThread({ op, buffer, params = {}, maxPixels = FREE_MAX_SRC_PIXELS }) {
  // Kept ahead of the queue on purpose: the header pre-check is a few byte reads,
  // and refusing an oversized image here means a hostile small-file/huge-canvas
  // request never occupies a worker or a queue position either.
  assertDeclaredWithinPixelCap(buffer, maxPixels);
  if (queue.length >= QUEUE_MAX) {
    return Promise.reject(unavailable("image workers are busy - retry shortly"));
  }
  return new Promise((resolve, reject) => {
    queue.push({ id: nextJobId++, op, buffer, params, maxPixels, resolve, reject, timer: null });
    pump();
  });
}
