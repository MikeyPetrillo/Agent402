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
// inside the step timeout or cannot split a document, `parseOffLoop` answers
// `{ ok: false, reason }` and the caller parses on its own thread as before.
// After FAILS_BEFORE_PAUSE such failures in a row the worker is left alone
// for PAUSE_MS. One document at a time; the thread is ended after IDLE_MS
// with nothing to parse, so its heap is held only while documents arrive.
// CRAWL_PARSE_WORKER=off keeps every parse on the caller's thread.
import { Worker } from "node:worker_threads";
import { deserialize } from "node:v8";
import { fileURLToPath } from "node:url";

/** Documents shorter than this (UTF-16 units) are parsed in place: the
 *  densest shape measured costs about 25 ms per 512 KB on a laptop, so half of
 *  that stays a short turn, and almost every crawled document is far smaller. */
export const OFF_LOOP_MIN_CHARS = 256 * 1024;
const FAILS_BEFORE_PAUSE = 3;
const PAUSE_MS = 10 * 60_000;
const DEFAULTS = Object.freeze({
  minChars: OFF_LOOP_MIN_CHARS,
  workerFile: fileURLToPath(new URL("./crawl-parse-thread.js", import.meta.url)),
  stepTimeoutMs: 60_000, // one answer from the thread (the first carries the whole parse)
  idleMs: 20_000,
  heapMb: 1024, // the thread's old-generation limit; a document past it ends the thread and is parsed in place
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
  failsInARow = 0; pausedUntil = 0;
  endWorker();
}

const stats = { offLoop: 0, pieces: 0, invalid: 0, fallbacks: 0, starts: 0, lastFallback: null };
/** Counters since boot: documents rebuilt from the thread, pieces, invalid documents, fallbacks, thread starts. */
export function crawlParseStats() { return { ...stats, paused: pausedUntil > Date.now(), running: Boolean(current) }; }

/** Whether `text` is parsed off the loop: long enough, and the switch not off. */
export function parsesOffLoop(text) {
  if (typeof text !== "string" || text.length < cfg.minChars) return false;
  return String(process.env.CRAWL_PARSE_WORKER || "").trim().toLowerCase() !== "off";
}

// ---- rebuilding the value --------------------------------------------------
function place(b, value) {
  const top = b.stack.length ? b.stack[b.stack.length - 1] : null;
  if (top === null) b.root = value;
  else if (Array.isArray(top)) top.push(value);
  else setKey(top, b.key, value);
}
// An own "__proto__" key, as JSON.parse makes one: plain assignment would set the prototype.
function setKey(o, k, v) {
  if (k === "__proto__") Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
}
/** A builder for `applySteps`: `root` is the value once every piece is applied. */
export function newBuilder() { return { root: undefined, stack: [], key: null }; }
/** Apply one piece's steps (see src/crawl-parse-thread.js for the step list). */
export function applySteps(b, steps) {
  for (const s of steps) {
    switch (s[0]) {
      case "v": place(b, s[1]); break;
      case "a": { const c = []; place(b, c); b.stack.push(c); break; }
      case "o": { const c = {}; place(b, c); b.stack.push(c); break; }
      case "k": b.key = s[1]; break;
      case "p": { const top = b.stack[b.stack.length - 1], run = s[1]; for (let i = 0; i < run.length; i++) top.push(run[i]); break; }
      case "s": { const top = b.stack[b.stack.length - 1], run = s[1]; for (let i = 0; i < run.length; i += 2) setKey(top, run[i], run[i + 1]); break; }
      case "c": b.stack.pop(); break;
      default: throw new Error(`crawl parse: unknown step ${String(s[0])}`);
    }
  }
}

// ---- the thread ------------------------------------------------------------
let current = null; // { worker, waiting: { id, resolve, reject, timer } | null, idleTimer }
let nextId = 0;
let failsInARow = 0, pausedUntil = 0;

function endWorker() {
  const w = current;
  if (!w) return;
  current = null;
  clearTimeout(w.idleTimer);
  if (w.waiting) { clearTimeout(w.waiting.timer); const { reject } = w.waiting; w.waiting = null; reject(new Error("thread ended")); }
  try { w.worker.terminate().catch(() => {}); } catch { /* already gone */ }
}
function ensureWorker() {
  if (current) { clearTimeout(current.idleTimer); return current; }
  // No environment and no preloads: the thread reads neither.
  const worker = new Worker(cfg.workerFile, { env: {}, execArgv: [], name: "crawl-parse", resourceLimits: { maxOldGenerationSizeMb: cfg.heapMb } });
  const w = { worker, waiting: null, idleTimer: null };
  worker.unref(); // a parse in flight holds the loop through its step timer
  const lost = (why) => {
    if (current === w) current = null;
    clearTimeout(w.idleTimer);
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
/**
 * Parse `text` in the thread and rebuild its value on this one, a piece per
 * `turn()` (awaited before each piece), each rebuild run through `span(fn)`.
 * Resolves `{ ok: true, value, pieces, longestMs, totalMs }`, or
 * `{ ok: false, reason }` when the thread could not do it (the caller then
 * parses in place). Rejects with a SyntaxError when the document is not JSON.
 */
export function parseOffLoop(text, { turn, span } = {}) {
  const run = chain.then(() => parseOne(text, turn, span || ((fn) => fn())));
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
  if (pausedUntil > Date.now()) { stats.fallbacks++; stats.lastFallback = "paused after failures"; return { ok: false, reason: "paused after failures" }; }
  let w;
  try { w = ensureWorker(); } catch (e) { return fellBack(`thread did not start: ${String(e?.message || e).slice(0, 120)}`); }
  const id = ++nextId;
  const b = newBuilder();
  let pieceBytes = cfg.pieceBytes, pieces = 0, longestMs = 0, totalMs = 0;
  let invalid = null, unsplit = null;
  try {
    let reply = await ask(w, { op: "parse", id, text, pieceBytes, minPieceBytes: cfg.minPieceBytes, clone: cfg.clone === true });
    for (;;) {
      if (reply.invalid) { invalid = reply.invalid; break; }
      // The thread answered that it cannot split this document: that is the
      // document's shape, not a failing thread, so it does not count toward the pause.
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
  } finally {
    if (current === w) { clearTimeout(w.idleTimer); w.idleTimer = setTimeout(() => { if (current === w && !w.waiting) endWorker(); }, cfg.idleMs); w.idleTimer.unref?.(); }
  }
  failsInARow = 0;
  if (unsplit) { stats.fallbacks++; stats.lastFallback = unsplit; return { ok: false, reason: unsplit }; }
  if (invalid) { stats.invalid++; throw new SyntaxError(invalid.message); }
  if (b.stack.length) return fellBack("pieces ended with a container open");
  stats.offLoop++; stats.pieces += pieces;
  return { ok: true, value: b.root, pieces, longestMs, totalMs };
}
