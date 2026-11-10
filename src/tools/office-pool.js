// Main-thread side of the Office builders: a small pool of long-lived workers
// (office-worker.js) plus a bounded queue, the same shape as image-pool.js.
// The builders are synchronous XML and zip work; off the event loop, the
// largest input the caps allow never holds the loop, and a job that overruns
// ends in worker.terminate().
//
//  - POOL_MAX caps resident builders (each keeps its three libraries loaded,
//    so a repeat call does not pay the import).
//  - QUEUE_MAX caps work waiting behind them; past it a call answers 503 with
//    nothing charged (any answer at or above 400 cancels x402 settlement).
//  - JOB_TIMEOUT_MS is a backstop far above the largest input's measured build
//    (scripts/test-office-create.js times it). It also bounds the wait: a job
//    still queued that long is refused with the full queue's 503 before any
//    build, so a call never waits past one deadline and then builds for a
//    client that may have left.
//  - Idle workers end after IDLE_MS, so their heaps are not held for good.
import { Worker } from "node:worker_threads";
import { threadEnv } from "./child-env.js";
import { fileURLToPath } from "node:url";

const OFFICE_WORKER = fileURLToPath(new URL("./office-worker.js", import.meta.url));
const intEnv = (v, d) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : d; };
export const OFFICE_POOL_MAX = intEnv(process.env.OFFICE_WORKERS_MAX, 2);
export const OFFICE_QUEUE_MAX = intEnv(process.env.OFFICE_QUEUE_MAX, 16);
export const OFFICE_JOB_TIMEOUT_MS = 15_000;
const IDLE_MS = 30_000;
const HEAP_MB = 512;

const slots = [];
const queue = [];
let nextJobId = 1;

const unavailable = (message, extra = {}) => Object.assign(new Error(message), { statusCode: 503, ...extra });
const busy = () => unavailable("Office builders are busy; retry in a few seconds. Nothing was charged.", { retryAfter: 5, shed: true });

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
  // unref: a pooled worker never holds the process open (drain, direct-call scripts).
  slot.worker.unref();
  clearTimeout(slot.idleTimer);
  slot.idleTimer = setTimeout(() => retire(slot), IDLE_MS);
  slot.idleTimer.unref();
}
function spawnSlot() {
  const slot = { worker: new Worker(OFFICE_WORKER, { env: threadEnv(), resourceLimits: { maxOldGenerationSizeMb: HEAP_MB, maxYoungGenerationSizeMb: 64 } }), job: null, idleTimer: null };
  slot.worker.on("message", (msg) => {
    if (!slot.job || msg.id !== slot.job.id) return;
    if (msg.error) settle(slot, slot.job.reject, Object.assign(new Error(msg.error), { statusCode: msg.statusCode || 500 }));
    else settle(slot, slot.job.resolve, msg.result);
    goIdle(slot);
    pump();
  });
  const die = (message) => {
    settle(slot, slot.job?.reject, unavailable(message));
    retire(slot);
    pump();
  };
  slot.worker.on("error", (e) => die(e?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "The file is too large to build. Nothing was charged." : `office worker error: ${e?.message || e}`));
  slot.worker.on("exit", () => { if (slot.job) die("office worker stopped unexpectedly"); });
  slots.push(slot);
  return slot;
}
function assign(slot, job) {
  clearTimeout(job.queueTimer);
  slot.job = job;
  clearTimeout(slot.idleTimer);
  slot.worker.ref();
  job.timer = setTimeout(() => {
    settle(slot, job.reject, Object.assign(new Error(`Building the file took longer than ${job.timeoutMs / 1000}s. Nothing was charged.`), { statusCode: 422 }));
    retire(slot);
    pump();
  }, job.timeoutMs);
  slot.worker.postMessage({ id: job.id, op: job.op, spec: job.spec });
}
function pump() {
  while (queue.length) {
    const slot = slots.find((s) => !s.job) || (slots.length < OFFICE_POOL_MAX ? spawnSlot() : null);
    if (!slot) return;
    assign(slot, queue.shift());
  }
}

/** Workers running and calls waiting, for tests. */
export function officePoolState() { return { workers: slots.length, busy: slots.filter((s) => s.job).length, waiting: queue.length }; }

/** Build one file off the main thread. Resolves { base64, bytes, stats? };
 *  rejects with the builder's statusCode and message. */
export function runOfficeOp(op, spec, { timeoutMs = OFFICE_JOB_TIMEOUT_MS } = {}) {
  if (queue.length >= OFFICE_QUEUE_MAX) return Promise.reject(busy());
  return new Promise((resolve, reject) => {
    const job = { id: nextJobId++, op, spec, timeoutMs, resolve, reject, timer: null, queueTimer: null };
    queue.push(job);
    pump();
    if (queue.includes(job)) {
      job.queueTimer = setTimeout(() => {
        const i = queue.indexOf(job);
        if (i < 0) return;
        queue.splice(i, 1);
        reject(busy());
      }, timeoutMs);
      job.queueTimer.unref();
    }
  });
}
