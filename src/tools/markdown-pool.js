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
// The estimate is a first sort, not the guarantee. The guarantee is the
// ordinary budget: a render that started as ordinary gets ORDINARY_BUDGET_MS,
// counted from the worker's start signal (many times what the largest
// ordinary document needs on a busy host). Past it the worker is ended and
// the document MOVES to the costly lane, where it starts again under that
// lane's deadline and room; it is not failed. So whatever the estimate said,
// no document holds the ordinary worker longer than the budget. A spare
// worker is kept started while the pool is in use, so the ordinary lane has
// a worker the moment one is ended.
//
// Waiting is fair by caller. Each caller key (the client address the tool
// passes) has its own line in the ordinary room; the next document comes
// from the caller that has used the least worker time, callers that are
// level taking turns. A caller new to the room starts level with the one
// served last, so nobody is put ahead for being new or behind for having
// been served earlier. One keyed caller holds at most ORDINARY_CALLER_MAX
// places. Callers with one document each are served in arrival order.
//
// Each lane has its own waiting room, so one filling up never refuses the other:
//  - ordinary: ORDINARY_QUEUE_MAX documents wait (each renders in
//    milliseconds); past it, or past one caller's share, a 503.
//  - costly: a document is admitted only while the renders ahead of it (the
//    one running and those waiting) can finish within COSTLY_WAIT_MAX_MS at
//    one deadline each; otherwise a 503 with Retry-After, for this lane only.
//    A moved document meets the same door.
//
// A costly render gets RENDER_DEADLINE_MS from its start signal (not from
// the request, and not from a worker's start-up): room for a large slow
// document such as unfenced source code. Past it the worker is terminated,
// the only lever on a synchronous render, and the answer is a 400 that says
// the render ran out of time. Every refusal here is uncharged.
import { Worker, isMainThread } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { renderMarkdown, markdownLooksCostly } from "./markdown-render.js";

const MARKDOWN_WORKER = fileURLToPath(new URL("./markdown-worker.js", import.meta.url));
export const RENDER_DEADLINE_MS = 10_000;
export const ORDINARY_BUDGET_MS = 1_000;
export const ORDINARY_QUEUE_MAX = 512;
/** Places one keyed caller may hold in the ordinary room. */
export const ORDINARY_CALLER_MAX = 128;
export const COSTLY_WAIT_MAX_MS = 30_000;
/** Costly renders in flight plus waiting; one more would wait past COSTLY_WAIT_MAX_MS. */
export const COSTLY_AHEAD_MAX = Math.floor(COSTLY_WAIT_MAX_MS / RENDER_DEADLINE_MS);
const START_GUARD_MS = 20_000; // a worker that never reports a start
const HEAP_MB = 256;
const IDLE_MS = 30_000;
const CALLERS_KEPT_MAX = 2048; // caller records kept between sweeps

/** What the pool does, for tests: spawned, ready, started, ended, moved (each with `at`, performance.now()). */
export const markdownPoolEvents = new EventEmitter();
const emit = (type, fields) => { if (markdownPoolEvents.listenerCount(type)) markdownPoolEvents.emit(type, { type, at: performance.now(), ...fields }); };

// lanes[0] serves ordinary documents only; lanes[1] serves costly ones first.
const lanes = [{ index: 0, costlyToo: false, worker: null, job: null, idleTimer: null }, { index: 1, costlyToo: true, worker: null, job: null, idleTimer: null }];
const costly = [];
// The ordinary room: caller key -> { key, jobs, used, running }. Map order is the turn order.
const callers = new Map();
let ordinaryWaiting = 0;
let served = 0; // worker time used by the caller served last: where a caller new to the room starts
let spare = null; // a started worker no lane holds yet
let nextJobId = 1, nextWorkerId = 1, movedTotal = 0;

const unavailable = (message) => Object.assign(new Error(message), { statusCode: 503 });
const costlyFull = () => Object.assign(unavailable(`Slow markdown renders are queued ahead of this one (its unclosed emphasis or code markers make it slow to render); nothing was charged, retry in ${COSTLY_WAIT_MAX_MS / 1000} s`), { retryAfter: COSTLY_WAIT_MAX_MS / 1000, shed: true });
const costlyAhead = () => costly.length + lanes.filter((l) => l.job?.costly).length;

function forget(caller) {
  if (!caller.jobs.length && !caller.running && caller.used <= served) callers.delete(caller.key);
}

function nextOrdinary() {
  let pick = null;
  for (const c of callers.values()) if (c.jobs.length && (!pick || c.used < pick.used)) pick = c;
  if (!pick) return null;
  const job = pick.jobs.shift();
  ordinaryWaiting--;
  pick.running++;
  served = Math.max(served, pick.used);
  // To the back of the turn order.
  callers.delete(pick.key);
  callers.set(pick.key, pick);
  return job;
}

/** The render left its worker (finished, failed, moved or stopped): charge its caller the time. */
function ended(lane, job, how) {
  emit("ended", { lane: lane.index, job: job.id, worker: lane.worker?.wid, how, caller: job.caller?.key });
  const c = job.caller;
  if (!c || job.charged) return;
  job.charged = true;
  c.running--;
  if (job.startedAt) c.used += performance.now() - job.startedAt;
  forget(c);
}

function settle(lane, fn, arg) {
  const job = lane.job;
  if (!job) return;
  lane.job = null;
  clearTimeout(job.timer);
  ended(lane, job, fn === "resolve" ? "done" : "failed");
  fn === "resolve" ? job.resolve(arg) : job.reject(arg);
}

function retire(lane) {
  clearTimeout(lane.idleTimer);
  const w = lane.worker;
  lane.worker = null;
  if (w) w.terminate();
}

function dropSpare() {
  const w = spare;
  spare = null;
  if (w) w.terminate();
}

/** The lane's worker has nothing to do: it is let go after IDLE_MS, and the spare with the last one. */
function rest(lane) {
  lane.worker.unref();
  clearTimeout(lane.idleTimer);
  lane.idleTimer = setTimeout(() => {
    if (lane.job) return;
    retire(lane);
    if (!lanes.some((l) => l.worker)) dropSpare();
  }, IDLE_MS);
  lane.idleTimer.unref();
}

/** The lane takes the spare, already started, as its worker. */
function adopt(lane) {
  lane.worker = spare;
  spare = null;
  lane.worker.lane = lane;
  rest(lane);
}

/** A started worker. Its messages go to whichever lane holds it; until one does it is the spare. */
function start() {
  const worker = new Worker(MARKDOWN_WORKER, { resourceLimits: { maxOldGenerationSizeMb: HEAP_MB, maxYoungGenerationSizeMb: 32 } });
  worker.wid = nextWorkerId++;
  worker.lane = null;
  // unref: an idle worker never holds the process open.
  worker.unref();
  emit("spawned", { worker: worker.wid });
  worker.on("message", (msg) => {
    if (msg.ready) { worker.isReady = true; emit("ready", { worker: worker.wid }); return; }
    const lane = worker.lane;
    if (!lane || lane.worker !== worker || !lane.job || msg.id !== lane.job.id) return;
    const job = lane.job;
    if (msg.started) {
      clearTimeout(job.timer);
      job.startedAt = performance.now();
      emit("started", { lane: lane.index, job: job.id, worker: worker.wid, costly: job.costly, caller: job.caller?.key });
      job.timer = setTimeout(() => (job.costly ? stop(lane, job) : move(lane, job)), job.costly ? RENDER_DEADLINE_MS : ORDINARY_BUDGET_MS);
      return;
    }
    if (msg.error) settle(lane, "reject", Object.assign(new Error(msg.error), { statusCode: msg.statusCode || 500 }));
    else settle(lane, "resolve", msg.result);
    rest(lane);
    pump();
  });
  const die = (err) => {
    if (spare === worker) { spare = null; return; }
    const lane = worker.lane;
    if (!lane || lane.worker !== worker) return;
    settle(lane, "reject", err);
    retire(lane);
    pump();
  };
  worker.on("error", (e) => {
    // A render that outgrows the worker heap: the document for a costly-looking one, ours otherwise.
    const memory = e?.code === "ERR_WORKER_OUT_OF_MEMORY" || /memory limit/i.test(String(e?.message));
    die(memory && worker.lane?.job?.costly
      ? Object.assign(new Error('"markdown" needs more memory to render than one call allows (very deep quote or list nesting is the usual cause); flatten the nesting or send the document in parts'), { statusCode: 400 })
      : unavailable(memory ? "The render ran out of memory on our side; nothing was charged, retry shortly" : "Markdown rendering failed on our side; nothing was charged, retry shortly"));
  });
  worker.on("exit", () => die(unavailable("Markdown rendering stopped unexpectedly; nothing was charged, retry shortly")));
  return worker;
}

/** A costly render past its deadline: the document is the cause. */
function stop(lane, job) {
  settle(lane, "reject", Object.assign(new Error(`"markdown" took longer than ${RENDER_DEADLINE_MS / 1000} s to render and was stopped (long runs of unclosed emphasis or code markers, or very deep quote nesting, are the usual cause); close the markers or send the document in parts`), { statusCode: 400 }));
  retire(lane);
  pump();
}

/** An ordinary render past its budget: end the worker, and the document starts again in the costly lane. */
function move(lane, job) {
  if (lane.job !== job) return;
  lane.job = null;
  ended(lane, job, "moved");
  retire(lane);
  // The ordinary lane has a worker again at once, whether or not a document is waiting for it.
  if (!lane.costlyToo && spare) adopt(lane);
  movedTotal++;
  job.costly = true;
  job.moved = true;
  job.startedAt = 0;
  const admitted = costlyAhead() < COSTLY_AHEAD_MAX;
  emit("moved", { lane: lane.index, job: job.id, admitted, caller: job.caller?.key });
  if (admitted) costly.push(job);
  else job.reject(costlyFull());
  pump();
}

function pump() {
  for (const lane of lanes) {
    if (lane.job) continue;
    const job = (lane.costlyToo && costly.shift()) || nextOrdinary();
    if (!job) continue;
    if (!lane.worker) {
      if (!lane.costlyToo && spare) adopt(lane);
      else (lane.worker = start()).lane = lane;
    }
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
  if (lanes.some((l) => l.job)) { if (!spare) spare = start(); }
  else if (!lanes.some((l) => l.worker)) dropSpare();
}

/** Render `text` off the serving thread. Resolves { html }; rejects with a statusCode.
 *  `costly` is the lane (estimated when not given; tests name it). `caller` is
 *  the key the ordinary room is fair by (a client address); calls without one
 *  share a line and are held to the room's size alone. */
export async function runMarkdown(text, { costly: lane = markdownLooksCostly(text), caller: key = "" } = {}) {
  if (!isMainThread) return renderMarkdown(text);
  key = typeof key === "string" ? key.slice(0, 64) : "";
  if (lane) {
    if (costlyAhead() >= COSTLY_AHEAD_MAX) throw costlyFull();
  } else if (ordinaryWaiting >= ORDINARY_QUEUE_MAX || (key && (callers.get(key)?.jobs.length ?? 0) >= ORDINARY_CALLER_MAX)) {
    throw Object.assign(unavailable("Markdown workers are busy; nothing was charged, retry in a few seconds"), { retryAfter: 5, shed: true });
  }
  return new Promise((resolve, reject) => {
    const job = { id: nextJobId++, text, costly: lane, resolve, reject, timer: null, caller: null, startedAt: 0, charged: false, moved: false };
    if (job.costly) costly.push(job);
    else {
      let c = callers.get(key);
      if (!c) {
        if (callers.size >= CALLERS_KEPT_MAX) for (const old of callers.values()) if (!old.jobs.length && !old.running) callers.delete(old.key);
        callers.set(key, c = { key, jobs: [], used: served, running: 0 });
      }
      if (!c.jobs.length && !c.running) c.used = Math.max(c.used, served);
      job.caller = c;
      c.jobs.push(job);
      ordinaryWaiting++;
    }
    pump();
  });
}

/** Pool state for tests and operator views. */
export function markdownPoolState() {
  return { workers: lanes.filter((l) => l.worker).length, busy: lanes.filter((l) => l.job).length, spare: Boolean(spare), queuedOrdinary: ordinaryWaiting, queuedCostly: costly.length, callers: callers.size, moved: movedTotal, deadlineMs: RENDER_DEADLINE_MS, ordinaryBudgetMs: ORDINARY_BUDGET_MS, ordinaryQueueMax: ORDINARY_QUEUE_MAX, ordinaryCallerMax: ORDINARY_CALLER_MAX, costlyAheadMax: COSTLY_AHEAD_MAX };
}
