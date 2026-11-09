// Main-thread side of the markdown worker: a document too long to render on
// the serving thread renders here, in a worker of its own kind, so a slow
// render never holds the event loop and never takes a worker or a queue place
// from the HTML tools (./html-pool.js).
//
// Two lanes, one worker each. The renderer's cost can grow with the square of
// a block that is dense with unclosed emphasis markers; markdownLooksCostly()
// estimates that in one pass and sorts each document:
//  - ordinary documents wait for the ordinary worker, and for the other one
//    whenever it has nothing costly to do;
//  - costly-looking documents wait for the second worker only.
// So a run of slow renders delays other slow renders, and ordinary documents
// keep a worker to themselves. Callers wait in the queue; nothing is refused
// until QUEUE_MAX documents are pending.
//
// A render gets RENDER_DEADLINE_MS, counted from the moment the worker says
// it started (not from the request, and not from a worker's start-up). Past
// it the worker is terminated, the only lever on a synchronous render. The
// answer then depends on the lane: a costly-looking document is told its
// shape is the cause (400); an ordinary-looking one is told we did not
// finish (503, retryable), since a busy host must never read as bad input.
// Both are uncharged.
import { Worker, isMainThread } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { renderMarkdown, markdownLooksCostly } from "./markdown-render.js";

const MARKDOWN_WORKER = fileURLToPath(new URL("./markdown-worker.js", import.meta.url));
export const RENDER_DEADLINE_MS = 3_000;
const START_GUARD_MS = 20_000; // a worker that never reports a start
const QUEUE_MAX = 512;
const HEAP_MB = 256;
const IDLE_MS = 30_000;

// lanes[0] serves ordinary documents only; lanes[1] serves costly ones first.
const lanes = [{ costlyToo: false, worker: null, job: null, idleTimer: null }, { costlyToo: true, worker: null, job: null, idleTimer: null }];
const ordinary = [];
const costly = [];
let nextJobId = 1;

const unavailable = (message) => Object.assign(new Error(message), { statusCode: 503 });

function settle(lane, fn, arg) {
  const job = lane.job;
  if (!job) return;
  lane.job = null;
  clearTimeout(job.timer);
  fn === "resolve" ? job.resolve(arg) : job.reject(arg);
}

function retire(lane) {
  clearTimeout(lane.idleTimer);
  const w = lane.worker;
  lane.worker = null;
  if (w) w.terminate();
}

function spawn(lane) {
  const worker = new Worker(MARKDOWN_WORKER, { resourceLimits: { maxOldGenerationSizeMb: HEAP_MB, maxYoungGenerationSizeMb: 32 } });
  lane.worker = worker;
  worker.on("message", (msg) => {
    if (lane.worker !== worker || !lane.job || msg.id !== lane.job.id) return;
    const job = lane.job;
    if (msg.started) {
      clearTimeout(job.timer);
      job.timer = setTimeout(() => {
        settle(lane, "reject", job.costly
          ? Object.assign(new Error(`"markdown" took longer than ${RENDER_DEADLINE_MS / 1000} s to render and was stopped (long runs of unclosed emphasis or code markers, or very deep quote nesting, are the usual cause); close the markers or send the document in parts`), { statusCode: 400 })
          : unavailable(`The render did not finish within ${RENDER_DEADLINE_MS / 1000} s on our side and was stopped; nothing was charged, retry shortly`));
        retire(lane);
        pump();
      }, RENDER_DEADLINE_MS);
      return;
    }
    if (msg.error) settle(lane, "reject", Object.assign(new Error(msg.error), { statusCode: msg.statusCode || 500 }));
    else settle(lane, "resolve", msg.result);
    // unref: an idle worker never holds the process open.
    worker.unref();
    clearTimeout(lane.idleTimer);
    lane.idleTimer = setTimeout(() => { if (!lane.job) retire(lane); }, IDLE_MS);
    lane.idleTimer.unref();
    pump();
  });
  const die = (err) => {
    if (lane.worker !== worker) return;
    settle(lane, "reject", err);
    retire(lane);
    pump();
  };
  worker.on("error", (e) => {
    // A render that outgrows the worker heap: the document for a costly-looking one, ours otherwise.
    const memory = e?.code === "ERR_WORKER_OUT_OF_MEMORY" || /memory limit/i.test(String(e?.message));
    die(memory && lane.job?.costly
      ? Object.assign(new Error('"markdown" needs more memory to render than one call allows (very deep quote or list nesting is the usual cause); flatten the nesting or send the document in parts'), { statusCode: 400 })
      : unavailable(memory ? "The render ran out of memory on our side; nothing was charged, retry shortly" : "Markdown rendering failed on our side; nothing was charged, retry shortly"));
  });
  worker.on("exit", () => die(unavailable("Markdown rendering stopped unexpectedly; nothing was charged, retry shortly")));
}

function pump() {
  for (const lane of lanes) {
    if (lane.job) continue;
    const job = (lane.costlyToo && costly.shift()) || ordinary.shift();
    if (!job) continue;
    if (!lane.worker) spawn(lane);
    lane.job = job;
    clearTimeout(lane.idleTimer);
    lane.worker.ref();
    job.timer = setTimeout(() => {
      settle(lane, "reject", unavailable("A markdown worker did not start in time; nothing was charged, retry shortly"));
      retire(lane);
      pump();
    }, START_GUARD_MS);
    lane.worker.postMessage({ id: job.id, text: job.text });
  }
}

/** Render `text` off the serving thread. Resolves { html }; rejects with a statusCode.
 *  `costly` is the lane (estimated when not given; tests name it). */
export async function runMarkdown(text, { costly: lane = markdownLooksCostly(text) } = {}) {
  if (!isMainThread) return renderMarkdown(text);
  if (ordinary.length + costly.length >= QUEUE_MAX) throw unavailable("Markdown workers are busy, retry shortly");
  return new Promise((resolve, reject) => {
    const job = { id: nextJobId++, text, costly: lane, resolve, reject, timer: null };
    (job.costly ? costly : ordinary).push(job);
    pump();
  });
}

/** Pool state for tests and operator views. */
export function markdownPoolState() {
  return { workers: lanes.filter((l) => l.worker).length, busy: lanes.filter((l) => l.job).length, queuedOrdinary: ordinary.length, queuedCostly: costly.length, deadlineMs: RENDER_DEADLINE_MS, queueMax: QUEUE_MAX };
}
