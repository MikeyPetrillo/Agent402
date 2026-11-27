// A large fetched document is parsed off the main loop.
//
// JSON.parse of one document is one uninterrupted stretch: a document of a
// few megabytes that is dense in small objects and distinct keys holds the
// thread for hundreds of milliseconds, and nothing on the main thread can cut
// that stretch short. A document of OFF_LOOP_MIN_CHARS or more is therefore
// parsed in a worker thread (src/crawl-parse-thread.js), which hands the tree
// back in pieces; this thread rebuilds one piece per turn the caller grants
// (the crawl lane), each a few milliseconds, tuned by what the last one took.
// The value is the one JSON.parse returns: the pieces are its own parts, as
// JSON text (or as structured clones, for a document holding a number JSON
// text cannot carry), put back in order. Invalid JSON throws a SyntaxError
// with the text V8 gave in the worker, which is the text it gives here.
//
// Never the only path: when the worker cannot start, dies, answers nothing
// inside the step timeout or will not take a document, `parseOffLoop` answers
// `{ ok: false, reason }` and the caller parses on its own thread as before.
// After FAILS_BEFORE_PAUSE such failures in a row the worker is left alone
// for PAUSE_MS.
//
// MEMORY. One document at a time, through one queue, so the thread's heap is
// one document's tree at most, and the thread is ended as soon as the queue
// is empty: a tree it has handed over is not kept while it idles (a start
// costs this thread a fraction of a millisecond). The thread's heap limit
// (`heapMb`) is NOT what bounds it: a thread that reaches its limit inside
// JSON.parse can end the whole process, not itself. The bound is on the
// input: the thread measures the text before parsing and refuses a document
// whose tree may cost more than half the limit (TREE_SHARE), which then takes
// the in-place path it always took. So the limit is never approached.
//
// SHUTDOWN. `stopCrawlParse()` (the server's drain calls it) ends the thread
// and keeps every later parse in place, so the process's exit does not wait
// on a parse in the thread.
// CRAWL_PARSE_WORKER=off keeps every parse on the caller's thread.
import { Worker } from "node:worker_threads";
import { deserialize } from "node:v8";
import { fileURLToPath } from "node:url";

/** Documents shorter than this (UTF-16 units) are parsed in place: the
 *  densest shape measured costs about 25 ms per 512 KB on a laptop, so half of
 *  that stays a short turn, and almost every crawled document is far smaller. */
export const OFF_LOOP_MIN_CHARS = 256 * 1024;
/** The share of the thread's heap limit a document's estimated tree may take
 *  (src/crawl-parse-thread.js estimateTreeBytes reads 0.86 to 3.2 times the
 *  live cost, so the real tree stays under six tenths of the limit). */
export const TREE_SHARE = 0.5;
const FAILS_BEFORE_PAUSE = 3;
const PAUSE_MS = 10 * 60_000;
const DEFAULTS = Object.freeze({
  minChars: OFF_LOOP_MIN_CHARS,
  workerFile: fileURLToPath(new URL("./crawl-parse-thread.js", import.meta.url)),
  stepTimeoutMs: 60_000, // one answer from the thread (the first carries the whole parse)
  // The thread's old-generation limit, never approached (see TREE_SHARE): half
  // of it admits a 12 MB document of any shape measured except one that is
  // nearly all empty containers, and a registry list of about 37 MB.
  heapMb: 512,
  pieceBytes: 64 * 1024, // the first piece's weight; later ones are tuned to targetMs
  minPieceBytes: 8 * 1024,
  maxPieceBytes: 1024 * 1024,
  targetMs: 6, // what one piece's rebuild should hold this thread
  clone: false, // every document as structured clones (a test's setting)
});
const cfg = { ...DEFAULTS };
/** Test hook: override settings (null restores the defaults); ends the thread so the next parse starts one afresh. */
export function __setCrawlParseForTest(over = null) {
  Object.assign(cfg, DEFAULTS, over || {});
  failsInARow = 0; pausedUntil = 0; stopped = false;
  endWorker();
}
let stopped = false;
/** End the thread now and keep every later parse in place (a draining process). */
export function stopCrawlParse() { stopped = true; endWorker(); }

const stats = { offLoop: 0, pieces: 0, invalid: 0, fallbacks: 0, starts: 0, lastFallback: null };
/** Counters since boot: documents rebuilt from the thread, pieces, invalid documents, fallbacks, thread starts. */
export function crawlParseStats() { return { ...stats, paused: pausedUntil > Date.now(), running: Boolean(current) }; }

/** Whether `text` is parsed off the loop: long enough, and the switch not off. */
export function parsesOffLoop(text) {
  if (stopped || typeof text !== "string" || text.length < cfg.minChars) return false;
  return String(process.env.CRAWL_PARSE_WORKER || "").trim().toLowerCase() !== "off";
}

// ---- rebuilding the value --------------------------------------------------
// A container the thread opened is filled here and put in its place when it
// closes (nothing else is put in its parent meanwhile, so order is kept).
// Until then only the builder holds it, so an open array can be replaced: an
// empty one takes its first run as it arrived (the piece's own array, exact
// and of the right element kind) or its first child as a one-element array.
// Appending to an empty array instead reserves 16 spare slots, and a document
// of millions of small opened arrays would cost several times what
// JSON.parse builds. An array that did grow by appending is put in place as
// an exact copy.
// What an open array is until something is put in it: one shared, never
// written array, so a level of nesting costs the builder a slot, not an array.
const NOTHING_YET = Object.freeze([]);
function place(b, value, key) {
  const at = b.stack.length - 1;
  if (at < 0) { b.root = value; return; }
  const top = b.stack[at];
  if (!Array.isArray(top)) setKey(top, key, value);
  else if (top.length === 0) b.stack[at] = [value];
  else { top.push(value); b.grown[at] = true; }
}
// An own "__proto__" key, as JSON.parse makes one: plain assignment would set the prototype.
function setKey(o, k, v) {
  if (k === "__proto__") Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
}
/** A builder for `applySteps`: `root` is the value once every piece is applied. */
export function newBuilder() { return { root: undefined, stack: [], keys: [], grown: [], key: null }; }
/** Apply one piece's steps (see src/crawl-parse-thread.js for the step list). */
export function applySteps(b, steps) {
  for (const s of steps) {
    switch (s[0]) {
      case "v": place(b, s[1], b.key); break;
      case "a": b.stack.push(NOTHING_YET); b.keys.push(b.key); b.grown.push(false); break;
      case "o": b.stack.push({}); b.keys.push(b.key); b.grown.push(false); break;
      case "k": b.key = s[1]; break;
      case "p": {
        const at = b.stack.length - 1, top = b.stack[at], run = s[1];
        if (top.length === 0) b.stack[at] = run;
        else { for (let i = 0; i < run.length; i++) top.push(run[i]); b.grown[at] = true; }
        break;
      }
      case "s": { const top = b.stack[b.stack.length - 1], run = s[1]; for (let i = 0; i < run.length; i += 2) setKey(top, run[i], run[i + 1]); break; }
      case "c": { const c = b.stack.pop(), key = b.keys.pop(), grown = b.grown.pop(); place(b, c === NOTHING_YET ? [] : grown ? c.slice() : c, key); break; }
      default: throw new Error(`crawl parse: unknown step ${String(s[0])}`);
    }
  }
}

// ---- the thread ------------------------------------------------------------
let current = null; // { worker, waiting: { id, resolve, reject, timer } | null }
let nextId = 0;
let failsInARow = 0, pausedUntil = 0;

function endWorker() {
  const w = current;
  if (!w) return;
  current = null;
  if (w.waiting) { clearTimeout(w.waiting.timer); const { reject } = w.waiting; w.waiting = null; reject(new Error("thread ended")); }
  try { w.worker.terminate().catch(() => {}); } catch { /* already gone */ }
}
function ensureWorker() {
  if (current) return current;
  // No environment and no preloads: the thread reads neither.
  const worker = new Worker(cfg.workerFile, { env: {}, execArgv: [], name: "crawl-parse", resourceLimits: { maxOldGenerationSizeMb: cfg.heapMb } });
  const w = { worker, waiting: null };
  worker.unref(); // a parse in flight holds the loop through its step timer
  const lost = (why) => {
    if (current === w) current = null;
    if (!w.waiting) return;
    clearTimeout(w.waiting.timer);
    const { reject } = w.waiting; w.waiting = null;
    reject(new Error(why));
  };
  worker.on("message", (m) => {
    if (!w.waiting || !m || m.id !== w.waiting.id) return;
    clearTimeout(w.waiting.timer);
    const { resolve } = w.waiting; w.waiting = null;
    resolve(m);
  });
  worker.on("error", (e) => lost(`thread error: ${String(e?.message || e).slice(0, 120)}`));
  worker.on("exit", (code) => lost(`thread exited (${code})`));
  current = w;
  stats.starts++;
  return w;
}
function ask(w, msg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (w.waiting && w.waiting.id === msg.id) w.waiting = null;
      if (current === w) endWorker(); else { try { w.worker.terminate().catch(() => {}); } catch { /* gone */ } }
      reject(new Error(`no answer in ${cfg.stepTimeoutMs} ms`));
    }, cfg.stepTimeoutMs);
    w.waiting = { id: msg.id, resolve, reject, timer };
    try { w.worker.postMessage(msg); }
    catch (e) { clearTimeout(timer); w.waiting = null; reject(e); }
  });
}

let chain = Promise.resolve();
let queued = 0; // documents waiting for the thread or in it
/**
 * Parse `text` in the thread and rebuild its value on this one, a piece per
 * `turn()` (awaited before each piece), each rebuild run through `span(fn)`.
 * Resolves `{ ok: true, value, pieces, longestMs, totalMs }`, or
 * `{ ok: false, reason }` when the thread could not do it (the caller then
 * parses in place). Rejects with a SyntaxError when the document is not JSON.
 */
export function parseOffLoop(text, { turn, span } = {}) {
  queued++;
  const run = chain.then(() => parseOne(text, turn, span || ((fn) => fn())))
    // The queue is empty: the thread goes, and the tree it held with it.
    .finally(() => { if (--queued === 0) endWorker(); });
  chain = run.then(() => {}, () => {});
  return run;
}
function fellBack(reason) {
  stats.fallbacks++;
  stats.lastFallback = reason;
  if (++failsInARow >= FAILS_BEFORE_PAUSE) { pausedUntil = Date.now() + PAUSE_MS; failsInARow = 0; }
  return { ok: false, reason };
}
async function parseOne(text, turn, span) {
  if (stopped) return { ok: false, reason: "stopped" };
  if (pausedUntil > Date.now()) { stats.fallbacks++; stats.lastFallback = "paused after failures"; return { ok: false, reason: "paused after failures" }; }
  let w;
  try { w = ensureWorker(); } catch (e) { return fellBack(`thread did not start: ${String(e?.message || e).slice(0, 120)}`); }
  const id = ++nextId;
  const b = newBuilder();
  let pieceBytes = cfg.pieceBytes, pieces = 0, longestMs = 0, totalMs = 0;
  let invalid = null, unsplit = null;
  try {
    let reply = await ask(w, { op: "parse", id, text, pieceBytes, clone: cfg.clone === true, maxTreeBytes: Math.floor(cfg.heapMb * 1048576 * TREE_SHARE) });
    for (;;) {
      if (reply.invalid) { invalid = reply.invalid; break; }
      // The thread answered that it will not take this document (its tree may
      // not fit the thread): that is the document, not a failing thread, so it
      // does not count toward the pause.
      if (reply.failed) { unsplit = String(reply.failed).slice(0, 160); break; }
      if (turn) await turn();
      const t0 = performance.now();
      span(() => applySteps(b, reply.enc === "json" ? JSON.parse(reply.piece) : deserialize(Buffer.from(reply.piece))));
      const ms = performance.now() - t0;
      pieces++; totalMs += ms; if (ms > longestMs) longestMs = ms;
      if (reply.done) break;
      // The next piece's weight from what this one cost, a factor of two at most per step.
      const wanted = Math.max(reply.weight, 1) * cfg.targetMs / Math.max(ms, 0.25);
      pieceBytes = Math.min(cfg.maxPieceBytes, Math.max(cfg.minPieceBytes, Math.round(Math.min(pieceBytes * 2, Math.max(pieceBytes / 2, wanted)))));
      reply = await ask(w, { op: "next", id, pieceBytes });
    }
  } catch (e) {
    if (current === w && !w.waiting) { try { w.worker.postMessage({ op: "drop", id }); } catch { /* gone */ } }
    return fellBack(String(e?.message || e).slice(0, 160));
  }
  failsInARow = 0;
  if (unsplit) { stats.fallbacks++; stats.lastFallback = unsplit; return { ok: false, reason: unsplit }; }
  if (invalid) { stats.invalid++; throw new SyntaxError(invalid.message); }
  if (b.stack.length) return fellBack("pieces ended with a container open");
  stats.offLoop++; stats.pieces += pieces;
  return { ok: true, value: b.root, pieces, longestMs, totalMs };
}
