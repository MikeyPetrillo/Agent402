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
//    the same memory-exhaustion failure the pool exists to prevent. The bound
//    is per caller (src/pool-admission.js): past it a caller already holding a
//    place is answered busy, and a caller holding nothing is queued over it up
//    to QUEUE_HARD_MAX (48: each waiting job holds a source of at most the
//    5 MB a fetched image may be, so 240 MB at most, against 160 MB at
//    QUEUE_MAX), where it takes the newest place of the party holding the
//    most. A free worker takes the job whose caller holds the fewest places.
//  - JOB_TIMEOUT_MS is a wall-clock backstop above the worst case the caps allow:
//    measured on a 16M-pixel source, decode was 160-570ms, resize 130-240ms and
//    the largest permitted PNG encode ~600ms-1.3s, so ~2s is the realistic worst
//    case and 5s means a genuine job is never killed while a pathological one
//    frees its slot quickly. It is counted from the moment the worker says it
//    has started the job, once its modules have loaded: a worker's first job
//    spawns the thread and evaluates jimp (and, for a barcode, the decoders),
//    which on a busy host takes seconds of no caller's work, and that time is
//    under its own ceiling (LOAD_TIMEOUT_MS). Nothing the caller sent is read
//    before "started", so no input can spend the load allowance.
import { Worker } from "node:worker_threads";
import { threadEnv } from "./child-env.js";
import { fileURLToPath } from "node:url";
import { assertDeclaredWithinPixelCap, FREE_MAX_SRC_PIXELS } from "./image-ops.js";
import { createPoolAdmission, poolCaller } from "../pool-admission.js";

const IMAGE_WORKER = fileURLToPath(new URL("./image-worker.js", import.meta.url));
// What the worker's import graph reads (lazy-deps.js); the decode helper it
// spawns takes the allowlist's own keys through childEnv().
const IMAGE_WORKER_ENV = ["LAZY_DEPS_WARM_GAP_MS"];
const POOL_MAX = 2;
const QUEUE_MAX = 32;
const QUEUE_HARD_MAX = 48;
const JOB_TIMEOUT_MS = 5_000;
// The wallet-only tools admit MAX_SRC_PIXELS (2.5x the free cap), so their
// deadline scales with it; the pool size still bounds resident bitmaps.
export const LARGE_JOB_TIMEOUT_MS = 15_000;
// A worker's thread start and module loads, before it starts a job: a backstop
// for a load that never finishes, never a job's own budget.
const LOAD_TIMEOUT_MS = 30_000;
// Idle workers are terminated so a burst of large images does not leave its peak
// heap resident for the rest of the process's life; the next call re-spawns.
const IDLE_MS = 30_000;

const slots = [];
const queue = [];
let nextJobId = 1;
const admission = createPoolAdmission({ soft: QUEUE_MAX, hard: QUEUE_HARD_MAX });
let workerPath = IMAGE_WORKER;
/** Tests: run jobs on another worker script (null restores the image worker). */
export function __setImageWorkerForTest(path) { workerPath = path || IMAGE_WORKER; }
/** Workers running and calls waiting, for tests. */
export function imagePoolState() { return { workers: slots.length, busy: slots.filter((s) => s.job).length, waiting: queue.length, callers: admission.callers() }; }

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
  const slot = { worker: new Worker(workerPath, { env: threadEnv(IMAGE_WORKER_ENV), resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 } }), job: null, idleTimer: null };
  slot.worker.on("message", (msg) => {
    if (!slot.job || msg.id !== slot.job.id) return; // stale reply from a job we already gave up on
    if (msg.started) { armJob(slot, slot.job, slot.job.timeoutMs); return; } // modules loaded: the job's own deadline runs from here
    if (msg.error) {
      settle(slot, slot.job.reject, Object.assign(new Error(msg.error), { statusCode: msg.statusCode || 500 }, msg.threw ? { threw: msg.threw } : {}));
    } else if (msg.result !== undefined) {
      settle(slot, slot.job.resolve, msg.result); // a JSON answer (op "barcode", "dominant-color")
    } else {
      settle(slot, slot.job.resolve, {
        __binary: Buffer.from(msg.buffer.buffer, msg.buffer.byteOffset, msg.buffer.byteLength),
        contentType: msg.contentType,
        ...(msg.width ? { width: msg.width, height: msg.height } : {}),
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

function armJob(slot, job, ms, what = `image transform timed out (>${job.timeoutMs}ms)`) {
  clearTimeout(job.timer);
  job.timer = setTimeout(() => {
    // The worker is inside synchronous Jimp code and will not answer another
    // message, so the slot is only recoverable by killing the thread.
    settle(slot, job.reject, unavailable(what));
    retire(slot);
    pump();
  }, ms);
}

function assign(slot, job) {
  slot.job = job;
  clearTimeout(slot.idleTimer);
  slot.worker.ref();
  // Until the worker says "started" it is loading modules, not reading the job.
  armJob(slot, job, LOAD_TIMEOUT_MS, `image worker did not start within ${LOAD_TIMEOUT_MS}ms`);
  slot.worker.postMessage({ id: job.id, op: job.op, buffer: job.buffer, maxPixels: job.maxPixels, params: job.params, deadlineMs: job.timeoutMs });
}

function pump() {
  while (queue.length) {
    const slot = slots.find((s) => !s.job) || (slots.length < POOL_MAX ? spawnSlot() : null);
    if (!slot) return;
    assign(slot, queue.splice(admission.next(queue), 1)[0]);
  }
}

/** Run one decode/transform/encode off the main thread. Resolves with the same
 *  { __binary, contentType } shape the inline implementation returned, and
 *  rejects with the same messages and statusCode values. op "barcode" resolves
 *  with the decoder's JSON answer instead. */
export function runImageOffThread({ op, buffer, params = {}, maxPixels = FREE_MAX_SRC_PIXELS, timeoutMs = JOB_TIMEOUT_MS }) {
  // Kept ahead of the queue on purpose: the header pre-check is a few byte reads,
  // and refusing an oversized image here means a hostile small-file/huge-canvas
  // request never occupies a worker or a queue position either.
  assertDeclaredWithinPixelCap(buffer, maxPixels, { mainThread: true });
  const who = poolCaller();
  const admitted = admission.admit(queue, who);
  if (admitted.refused) {
    return Promise.reject(unavailable(admitted.refused === "own" ? "image workers are busy, with this caller's earlier images already waiting - send this one once one of them is answered" : "image workers are busy - retry shortly"));
  }
  for (const v of admitted.evicted) v.reject(unavailable("image workers are busy - retry shortly"));
  admission.hold(who);
  return new Promise((resolve, reject) => {
    // The caller's place is held until the job is answered, however it ends.
    let held = true;
    const done = (fn) => (v) => { if (held) { held = false; admission.free(who); } fn(v); };
    queue.push({ id: nextJobId++, op, buffer, params, maxPixels, timeoutMs, who, resolve: done(resolve), reject: done(reject), timer: null });
    pump();
  });
}
