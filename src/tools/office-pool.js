// Main-thread side of the Office builders: a small pool of long-lived workers
// (office-worker.js) plus a bounded queue, the same shape as image-pool.js.
// The builders are synchronous XML and zip work; off the event loop, the
// largest input the caps allow never holds the loop, and a job that overruns
// ends in worker.terminate().
//
//  - POOL_MAX caps resident builders (each keeps its three libraries loaded,
//    so a repeat call does not pay the import).
//  - QUEUE_MAX bounds work waiting behind them, per caller (src/pool-admission.js):
//    past it a caller already holding a place answers 503 with nothing
//    charged (any answer at or above 400 cancels x402 settlement), and a
//    caller holding nothing is queued over it up to OFFICE_QUEUE_HARD_MAX
//    (half again, 24 by default: each waiting job holds a spec of at most the
//    2 MB request body, so 48 MB of request text at most), where it takes the
//    newest place of the party holding the most. A free builder takes the job
//    whose caller holds the fewest places.
//  - JOB_TIMEOUT_MS is a backstop far above the largest input's measured build
//    (scripts/test-office-create.js times it). It also bounds the wait: a job
//    still queued that long is refused with the full queue's 503 before any
//    build, so a call never waits past one deadline and then builds for a
//    client that may have left.
//  - Idle workers end after IDLE_MS, so their heaps are not held for good.
import { Worker } from "node:worker_threads";
import { threadEnv } from "./child-env.js";
import { fileURLToPath } from "node:url";
import { createPoolAdmission, poolCaller } from "../pool-admission.js";
import { claimLater, claimNow, notChargedHere } from "../not-charged.js";

const OFFICE_WORKER = fileURLToPath(new URL("./office-worker.js", import.meta.url));
const intEnv = (v, d) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : d; };
export const OFFICE_POOL_MAX = intEnv(process.env.OFFICE_WORKERS_MAX, 2);
export const OFFICE_QUEUE_MAX = intEnv(process.env.OFFICE_QUEUE_MAX, 16);
export const OFFICE_QUEUE_HARD_MAX = Math.ceil(1.5 * OFFICE_QUEUE_MAX);
export const OFFICE_JOB_TIMEOUT_MS = 15_000;
const IDLE_MS = 30_000;
const HEAP_MB = 512;

const slots = [];
const queue = [];
let nextJobId = 1;

const admission = createPoolAdmission({ soft: OFFICE_QUEUE_MAX, hard: OFFICE_QUEUE_HARD_MAX });

const unavailable = (message, extra = {}) => Object.assign(new Error(message), { statusCode: 503, ...extra });
const busy = () => unavailable(`Office builders are busy; retry in a few seconds.${notChargedHere()}`, { retryAfter: 5, shed: true });
const busyOwn = () => unavailable(`Office builders are busy, with this caller's earlier files already waiting; send this one once one of them is answered.${notChargedHere()}`, { retryAfter: 5, shed: true });

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
  const slot = { worker: new Worker(workerPath, { env: threadEnv(), resourceLimits: { maxOldGenerationSizeMb: HEAP_MB, maxYoungGenerationSizeMb: 64 } }), job: null, idleTimer: null };
  slot.worker.on("message", (msg) => {
    if (!slot.job || msg.id !== slot.job.id) return;
    if (msg.error) settle(slot, slot.job.reject, Object.assign(new Error(msg.error), { statusCode: msg.statusCode || 500 }));
    else settle(slot, slot.job.resolve, msg.result);
    goIdle(slot);
    pump();
  });
  const die = (message, claim = false) => {
    settle(slot, slot.job?.reject, claim ? claimLater(unavailable(message)) : unavailable(message));
    retire(slot);
    pump();
  };
  slot.worker.on("error", (e) => (e?.code === "ERR_WORKER_OUT_OF_MEMORY" ? die("The file is too large to build.", true) : die(`office worker error: ${e?.message || e}`)));
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
    settle(slot, job.reject, claimLater(Object.assign(new Error(`Building the file took longer than ${job.timeoutMs / 1000}s.`), { statusCode: 422 })));
    retire(slot);
    pump();
  }, job.timeoutMs);
  slot.worker.postMessage({ id: job.id, op: job.op, spec: job.spec });
}
function pump() {
  while (queue.length) {
    const slot = slots.find((s) => !s.job) || (slots.length < OFFICE_POOL_MAX ? spawnSlot() : null);
    if (!slot) return;
    assign(slot, queue.splice(admission.next(queue), 1)[0]);
  }
}

/** Workers running and calls waiting, for tests. */
export function officePoolState() { return { workers: slots.length, busy: slots.filter((s) => s.job).length, waiting: queue.length, callers: admission.callers() }; }
let workerPath = OFFICE_WORKER;
/** Tests: run jobs on another worker script (null restores the builder). */
export function __setOfficeWorkerForTest(path) { workerPath = path || OFFICE_WORKER; }

/** Build one file off the main thread. Resolves { base64, bytes, stats? };
 *  rejects with the builder's statusCode and message. */
export function runOfficeOp(op, spec, { timeoutMs = OFFICE_JOB_TIMEOUT_MS } = {}) {
  const who = poolCaller();
  const admitted = admission.admit(queue, who);
  if (admitted.refused) return Promise.reject(admitted.refused === "own" ? busyOwn() : busy());
  for (const v of admitted.evicted) { clearTimeout(v.queueTimer); v.reject(busy()); }
  admission.hold(who);
  return new Promise((resolve0, reject0) => {
    // The caller's place is held until the job is answered, however it ends.
    let held = true;
    const done = (fn) => (v) => { if (held) { held = false; admission.free(who); } fn(v); };
    const job = { id: nextJobId++, op, spec, timeoutMs, who, resolve: done(resolve0), reject: done(reject0), timer: null, queueTimer: null };
    const reject = job.reject;
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
  // A worker's error is built outside this call's async context: its charge
  // sentence is added here, in the caller's (src/not-charged.js).
  }).catch((e) => { throw claimNow(e); });
}
