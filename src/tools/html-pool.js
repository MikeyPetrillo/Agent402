// Main-thread side of the HTML worker: every parse of caller-supplied or
// fetched HTML (jsdom, Readability, turndown) runs here, off the event loop,
// with a hard ceiling on time and memory. Same shape as ./image-pool.js.
//
// Why: jsdom's parse is synchronous and superlinear in nesting depth. A page of
// a few thousand nested tags (tens of KB) holds a thread for seconds, and the
// HTML tools include free ones, so on the main thread one such request stalls
// every other request. Here it holds one worker until JOB_TIMEOUT_MS, then the
// worker is terminated (the only lever: a thread inside a synchronous parse
// never reads another message) and the caller gets a 503.
//
// Bounds and why each one exists (measured on a dense 5 MB page, the largest
// html-strip accepts: ~4 s and ~670 MB of heap):
//  - POOL_MAX workers, each with a heap cap, so a parse that outgrows the cap
//    dies in its own thread instead of the process.
//  - LARGE_MAX: at most this many jobs over LARGE_BYTES in flight at once, so a
//    burst of large pages cannot hold POOL_MAX large heaps together.
//  - QUEUE_MAX caps pending jobs; each holds its HTML string on the heap. The
//    bound is per caller (src/pool-admission.js): past it a caller already
//    holding a place is answered busy, and a caller holding nothing is queued
//    over it up to QUEUE_HARD_MAX (half again, 48 by default: each waiting
//    job holds at most the 5 MB page the tools accept, so 240 MB at most,
//    against 160 MB at QUEUE_MAX), where it takes the newest place of the
//    party holding the most. A free worker takes the eligible job whose
//    caller holds the fewest places.
//  - JOB_TIMEOUT_MS sits well above the legitimate worst case (the 5 MB page
//    above, with slower production CPUs) and far below a stall that matters.
//
// Inside a worker (or any non-main thread) runHtml calls the operation
// directly, so code shared with the worker never re-enters the pool.
import { Worker, isMainThread } from "node:worker_threads";
import { threadEnv } from "./child-env.js";
import { fileURLToPath } from "node:url";
import { createPoolAdmission, poolCaller } from "../pool-admission.js";

const HTML_WORKER = fileURLToPath(new URL("./html-worker.js", import.meta.url));
// What the worker's import graph reads (lazy-deps.js, and this module through html-kit.js).
const HTML_WORKER_ENV = ["LAZY_DEPS_WARM_GAP_MS", "HTML_POOL_MAX", "HTML_POOL_QUEUE_MAX", "HTML_PARSE_TIMEOUT_MS"];
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const POOL_MAX = num(process.env.HTML_POOL_MAX, 2);
const LARGE_MAX = 1;
const LARGE_BYTES = 1024 * 1024;
const QUEUE_MAX = num(process.env.HTML_POOL_QUEUE_MAX, 32);
const QUEUE_HARD_MAX = Math.ceil(1.5 * QUEUE_MAX);
const JOB_TIMEOUT_MS = num(process.env.HTML_PARSE_TIMEOUT_MS, 15_000);
const HEAP_MB = 1024;
// Idle workers are terminated so a large page's heap is not kept for the life
// of the process; the next call spawns again.
const IDLE_MS = 30_000;

const slots = [];
const queue = [];
let nextJobId = 1;
let largeInFlight = 0;
let directOps = null;
const admission = createPoolAdmission({ soft: QUEUE_MAX, hard: QUEUE_HARD_MAX });
let workerPath = HTML_WORKER;
/** Tests: run jobs on another worker script (null restores the HTML worker). */
export function __setHtmlWorkerForTest(path) { workerPath = path || HTML_WORKER; }

// Capacity, timeout and worker failure are 503s: the input may be fine and we
// did not serve it. A >= 400 also cancels x402 settlement.
function unavailable(message) {
  return Object.assign(new Error(message), { statusCode: 503 });
}

function settle(slot, fn, arg) {
  const job = slot.job;
  if (!job) return;
  slot.job = null;
  clearTimeout(job.timer);
  if (job.large) largeInFlight--;
  fn(arg);
}

function retire(slot) {
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
  clearTimeout(slot.idleTimer);
  slot.worker.terminate();
}

function goIdle(slot) {
  // unref: an idle worker never holds the process open (scripts that call
  // handlers directly, and the graceful drain, must still exit).
  slot.worker.unref();
  clearTimeout(slot.idleTimer);
  slot.idleTimer = setTimeout(() => retire(slot), IDLE_MS);
  slot.idleTimer.unref();
}

function spawnSlot() {
  const slot = { worker: new Worker(workerPath, { env: threadEnv(HTML_WORKER_ENV), resourceLimits: { maxOldGenerationSizeMb: HEAP_MB, maxYoungGenerationSizeMb: 64 } }), job: null, idleTimer: null };
  slot.worker.on("message", (msg) => {
    if (!slot.job || msg.id !== slot.job.id) return; // a reply from a job already given up on
    if (msg.error) settle(slot, slot.job.reject, Object.assign(new Error(msg.error), { statusCode: msg.statusCode || 500 }, msg.threw ? { threw: msg.threw } : {}));
    else settle(slot, slot.job.resolve, msg.result);
    goIdle(slot);
    pump();
  });
  const die = (message) => {
    settle(slot, slot.job?.reject, unavailable(message));
    retire(slot);
    pump();
  };
  slot.worker.on("error", (e) => die(/memory limit/i.test(e.message) ? "This HTML needs more memory to process than one call allows" : "HTML processing failed on our side"));
  slot.worker.on("exit", () => { if (slot.job) die("HTML processing stopped unexpectedly"); });
  slots.push(slot);
  return slot;
}

function assign(slot, job) {
  slot.job = job;
  if (job.large) largeInFlight++;
  clearTimeout(slot.idleTimer);
  slot.worker.ref();
  job.timer = setTimeout(() => {
    settle(slot, job.reject, unavailable(`HTML processing took longer than ${Math.round(JOB_TIMEOUT_MS / 1000)} s and was stopped (very deeply nested markup is the usual cause)`));
    retire(slot);
    pump();
  }, JOB_TIMEOUT_MS);
  slot.worker.postMessage({ id: job.id, op: job.op, payload: job.payload });
}

function pump() {
  for (;;) {
    // A large job waits while LARGE_MAX large ones run; a small job may still run.
    const i = admission.next(queue, (job) => !(job.large && largeInFlight >= LARGE_MAX));
    if (i < 0) return;
    const slot = slots.find((s) => !s.job) || (slots.length < POOL_MAX ? spawnSlot() : null);
    if (!slot) return;
    assign(slot, queue.splice(i, 1)[0]);
  }
}

/**
 * Run one named HTML operation (see ./html-worker.js) off the main thread.
 * `bytes` is the size of the HTML it parses, used for the large-job bound.
 * Resolves with the operation's result; rejects with its error and statusCode.
 */
export async function runHtml(op, payload, bytes = 0) {
  if (!isMainThread) {
    directOps ||= (await import("./html-worker-ops.js")).runOp;
    return directOps(op, payload);
  }
  const who = poolCaller();
  const admitted = admission.admit(queue, who);
  if (admitted.refused) throw unavailable(admitted.refused === "own" ? "HTML workers are busy, with this caller's earlier pages already waiting; send this one once one of them is answered" : "HTML workers are busy, retry shortly");
  for (const v of admitted.evicted) v.reject(unavailable("HTML workers are busy, retry shortly"));
  admission.hold(who);
  return new Promise((resolve, reject) => {
    // The caller's place is held until the job is answered, however it ends.
    let held = true;
    const done = (fn) => (v) => { if (held) { held = false; admission.free(who); } fn(v); };
    queue.push({ id: nextJobId++, op, payload, large: bytes > LARGE_BYTES, who, resolve: done(resolve), reject: done(reject), timer: null });
    pump();
  });
}

/** Pool state for tests and operator views. */
export function htmlPoolState() {
  return { workers: slots.length, busy: slots.filter((s) => s.job).length, queued: queue.length, largeInFlight, timeoutMs: JOB_TIMEOUT_MS, callers: admission.callers() };
}
