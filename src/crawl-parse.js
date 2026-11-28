// A large fetched document is parsed off the main loop.
//
// JSON.parse of one document is one uninterrupted stretch: a document of a
// few megabytes that is dense in small objects and distinct keys holds the
// thread for hundreds of milliseconds, and nothing on the main thread can cut
// that stretch short. A document of OFF_LOOP_MIN_CHARS or more is therefore
// parsed in a child process (src/crawl-parse-child.js), which hands the tree
// back in pieces; this process rebuilds one piece per turn the caller grants
// (the crawl lane), each a few milliseconds, tuned by what the last one took.
// The value is the one JSON.parse returns: the pieces are its own parts, as
// JSON text (or as structured clones, for a document holding a number JSON
// text cannot carry), put back in order. Invalid JSON throws a SyntaxError
// with the text V8 gave in the child, which is the text it gives here.
//
// When the child cannot start, answers nothing inside the step timeout, is
// paused or stopped, or is switched off, `parseOffLoop` answers
// `{ ok: false, reason }` and the caller parses on its own thread as before:
// none of those says anything about the document. After FAILS_BEFORE_PAUSE
// such failures in a row the parser is left alone for PAUSE_MS. A document of
// DECLINED_IN_PLACE_MAX_CHARS or more is the exception on every one of those
// paths (`inPlaceRefusal`): it is answered `keep: KEEP_PREVIOUS.large` and is
// not parsed on the caller's thread, unless CRAWL_PARSE_WORKER=off, the
// operator's choice to parse every document in place.
//
// A DOCUMENT THAT ENDS THE PARSER IS NOT PARSED HERE. A child that ends by a
// signal while it holds a document it had accepted ended through that
// document (its tree did not fit the child's heap), and that tree would take
// the same memory, or more, on this process's heap. The answer is then
// `{ ok: false, reason, keep: KEEP_PREVIOUS.ended }`: the caller does not
// parse the document and keeps what it held from the last read. The same for
// a document the child declined unparsed (its estimate) that is longer than
// DECLINED_IN_PLACE_MAX_CHARS (`keep: KEEP_PREVIOUS.large`); a shorter
// declined one is parsed in place as before. Neither counts toward the pause.
// Each document is known by a hash of its text (taken a chunk per turn
// before the child is asked): one that ended the parser or was declined is
// answered the same way, with no child started, until its text changes or
// RECALL_MS passes.
//
// MEMORY. A parser that runs out of memory inside JSON.parse ends its
// process, so the parser is a process of its own: its heap limit (`heapMb`,
// its --max-old-space-size) is the bound, whatever the document's shape, and
// reaching it ends the child and nothing else. The child also measures the
// text first and refuses a document whose tree plainly will not fit
// (TREE_SHARE of the limit); that only saves a wasted parse. One document at
// a time, through one queue. When the queue empties the child collects the
// last document and says what memory it still holds: under `idleRssMb` it
// stays for `idleMs` (starting one is a fork, which copies this process's
// page tables, so a burst of long documents pays it once), over it the child
// is ended at once, so an idle parser never holds a document's worth of memory.
//
// The text goes to the child in chunks, one per turn the caller grants, and
// each piece comes back as one message, so no transfer is a long stretch.
//
// SHUTDOWN. `stopCrawlParse()` (the server's drain calls it) ends the child
// and keeps every later parse in place; a parse waiting on it is handed back
// at once. The child ends itself when this process goes away.
// CRAWL_PARSE_WORKER=off keeps every parse on the caller's thread.
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { deserialize } from "node:v8";
import { fileURLToPath } from "node:url";
import { childEnv } from "./tools/child-env.js";
import { CHILD_ARG } from "./crawl-parse-child.js";

/** Documents shorter than this (UTF-16 units) are parsed in place: the
 *  densest shape measured costs about 25 ms per 512 KB on a laptop, so half of
 *  that stays a short turn, and almost every crawled document is far smaller. */
export const OFF_LOOP_MIN_CHARS = 256 * 1024;
/** The share of the child's heap limit a document's estimated tree may take
 *  before the child declines to start on it (src/crawl-parse-child.js
 *  estimateTreeBytes; a courtesy, not the bound). */
export const TREE_SHARE = 0.5;
const FAILS_BEFORE_PAUSE = 3;
const PAUSE_MS = 10 * 60_000;
/** Why a document is not parsed in place (the caller keeps its previous read):
 *  it ended the parser, or the parser declined it and it is too long to parse
 *  here. These are the words the crawl records. */
export const KEEP_PREVIOUS = Object.freeze({ ended: "parser-ended", large: "too-large-to-parse" });
/** A declined document this long or longer is not parsed in place. Measured in
 *  place on a heap with room for it, the costliest declined shapes took about
 *  50 bytes of heap per character of text (chains of integer-like keys; 51 at
 *  most over the shape search of scripts/test-crawl-parse-contained.js), so a
 *  document under this many characters stays under about 800 MB: every
 *  seller document (12 MB cap) is still parsed in place when declined, and a
 *  64 MB registry list, which can take about 3 GB, is not. */
export const DECLINED_IN_PLACE_MAX_CHARS = 16 * 1024 * 1024;
/** How long a document that ended or was declined by the parser is answered
 *  from memory (by the hash of its text) instead of handed to it again: until
 *  its text changes, or a day at most, so a cause that has passed (memory the
 *  machine was short of at the time) gets one new attempt a day. */
const RECALL_MS = 24 * 3600_000;
const RECALL_MAX = 1_000; // documents remembered; the oldest goes first
const DEFAULTS = Object.freeze({
  minChars: OFF_LOOP_MIN_CHARS,
  workerFile: fileURLToPath(new URL("./crawl-parse-child.js", import.meta.url)),
  stepTimeoutMs: 60_000, // one answer from the child (the first carries the whole parse)
  // The child's old-generation limit: reaching it ends the child, never this
  // process. Half of it (TREE_SHARE) admits a 12 MB document of any ordinary
  // shape and a registry list of about 37 MB.
  heapMb: 512,
  idleMs: 30_000, // the child ends this long after its queue empties,
  idleRssMb: 128, // or at once when it still holds more than this
  chunkChars: 1024 * 1024, // the text is handed over this much per turn
  pieceBytes: 64 * 1024, // the first piece's weight; later ones are tuned to targetMs
  minPieceBytes: 8 * 1024,
  maxPieceBytes: 1024 * 1024,
  targetMs: 6, // what one piece's rebuild should hold this thread
  clone: false, // every document as structured clones (a test's setting)
  recallMs: RECALL_MS, // a document that ended or was declined by the parser is answered from memory this long
});
const cfg = { ...DEFAULTS };
/** Test hook: override settings (null restores the defaults); ends the child so the next parse starts one afresh. */
export function __setCrawlParseForTest(over = null) {
  Object.assign(cfg, DEFAULTS, over || {});
  failsInARow = 0; pausedUntil = 0; stopped = false;
  recalled.clear();
  endWorker("settings changed");
}
let stopped = false;
/** End the child now and keep every later parse in place (a draining process). */
export function stopCrawlParse() { stopped = true; endWorker("stopped"); }

const stats = { offLoop: 0, pieces: 0, invalid: 0, fallbacks: 0, starts: 0, died: 0, kept: 0, recalled: 0, lastFallback: null };
/** Counters since boot: documents rebuilt from the child, pieces, invalid documents, fallbacks, child starts, children that ended holding a document, documents answered `keep`, documents answered from memory with no child asked. */
export function crawlParseStats() { return { ...stats, paused: pausedUntil > Date.now(), running: Boolean(current) }; }

const switchedOff = () => String(process.env.CRAWL_PARSE_WORKER || "").trim().toLowerCase() === "off";
/** Whether `text` is parsed off the loop: long enough, and the switch not off. */
export function parsesOffLoop(text) {
  if (stopped || typeof text !== "string" || text.length < cfg.minChars) return false;
  return !switchedOff();
}
/** The KEEP_PREVIOUS word when `text`, not parsed off the loop, must not be
 *  parsed in place either: DECLINED_IN_PLACE_MAX_CHARS or longer, whichever
 *  path handed it back (start failure, timeout, pause, stop, decline). Null
 *  when it may be parsed in place, which every text may under
 *  CRAWL_PARSE_WORKER=off. */
export function inPlaceRefusal(text) {
  if (typeof text !== "string" || text.length < DECLINED_IN_PLACE_MAX_CHARS || switchedOff()) return null;
  return KEEP_PREVIOUS.large;
}

// ---- rebuilding the value --------------------------------------------------
// A container the child opened is filled here and put in its place when it
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
/** Apply one piece's steps (see src/crawl-parse-child.js for the step list). */
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

// ---- the child ---------------------------------------------------------------
let current = null; // { child, waiting: { id, resolve, reject, timer } | null, gone: Promise that rejects when it ends, holding: id | null }
let nextId = 0;
let failsInARow = 0, pausedUntil = 0;
let idleTimer = null;

function endWorker(why = "parser ended") {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const w = current;
  if (!w) return;
  current = null;
  w.end(why);
  try { w.child.kill("SIGKILL"); } catch { /* already gone */ }
}
function ensureWorker() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (current) return current;
  // Its own heap limit, and --expose-gc so it can give a finished document's
  // memory back. The environment is the helper allowlist (src/tools/child-env.js):
  // no key, no store address and no NODE_OPTIONS, so neither a flag nor a
  // preload of this process reaches it.
  const child = fork(cfg.workerFile, [CHILD_ARG], {
    env: childEnv(),
    execArgv: [`--max-old-space-size=${cfg.heapMb}`, "--expose-gc"],
    serialization: "advanced", // a chunk of text and a piece travel as bytes, a lone surrogate included
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let lose;
  const gone = new Promise((_, reject) => { lose = reject; });
  gone.catch(() => {});
  const w = { child, waiting: null, gone, holding: null, ended: false, diedHolding: false };
  w.end = (why) => {
    if (w.ended) return;
    w.ended = true;
    if (current === w) current = null;
    if (w.holding !== null) w.diedHolding = true;
    const err = new Error(why);
    if (w.waiting) { clearTimeout(w.waiting.timer); const { reject } = w.waiting; w.waiting = null; reject(err); }
    lose(err);
  };
  // A parse in flight holds the loop through its step timer; an idle child does not.
  child.unref(); child.channel?.unref?.();
  child.on("message", (m) => {
    if (!w.waiting || !m || m.id !== w.waiting.id) return;
    clearTimeout(w.waiting.timer);
    const { resolve } = w.waiting; w.waiting = null;
    resolve(m);
  });
  child.on("error", (e) => w.end(`parser error: ${String(e?.message || e).slice(0, 120)}`));
  child.on("exit", (code, signal) => w.end(`parser exited (${signal || code})`));
  current = w;
  stats.starts++;
  return w;
}
/** One message to the child and its answer, or a rejection: no answer in the step timeout, or the child gone (at once when it already is). */
function ask(w, msg) {
  if (w.ended || current !== w) return Promise.reject(new Error("parser ended"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (w.waiting && w.waiting.id === msg.id) w.waiting = null;
      if (current === w) endWorker(); else { try { w.child.kill("SIGKILL"); } catch { /* gone */ } }
      reject(new Error(`no answer in ${cfg.stepTimeoutMs} ms`));
    }, cfg.stepTimeoutMs);
    w.waiting = { id: msg.id, resolve, reject, timer };
    try { w.child.send(msg, (e) => { if (e && w.waiting && w.waiting.id === msg.id) { clearTimeout(timer); w.waiting = null; reject(e); } }); }
    catch (e) { clearTimeout(timer); w.waiting = null; reject(e); }
  });
}
/** One chunk of the text to the child: resolves when it is written, rejects when the child is gone or the write takes past the step timeout. */
function sendChunk(w, msg) {
  if (w.ended || current !== w) return Promise.reject(new Error("parser ended"));
  let timer;
  const written = new Promise((resolve, reject) => {
    timer = setTimeout(() => { if (current === w) endWorker(); reject(new Error(`no answer in ${cfg.stepTimeoutMs} ms`)); }, cfg.stepTimeoutMs);
    try { w.child.send(msg, (e) => (e ? reject(e) : resolve())); } catch (e) { reject(e); }
  });
  return Promise.race([written, w.gone]).finally(() => clearTimeout(timer));
}

let chain = Promise.resolve();
let queued = 0; // documents waiting for the child or in it
/**
 * Parse `text` in the child and rebuild its value on this thread, a piece per
 * `turn()` (awaited before each chunk sent and each piece), each stretch run
 * through `span(fn)`.
 * Resolves `{ ok: true, value, pieces, longestMs, totalMs }`, or
 * `{ ok: false, reason }` when the child could not do it (the caller then
 * parses in place), or `{ ok: false, reason, keep }` when the caller must not
 * parse it (`keep` is a KEEP_PREVIOUS word). Rejects with a SyntaxError when
 * the document is not JSON.
 */
export function parseOffLoop(text, { turn, span } = {}) {
  queued++;
  const run = chain.then(() => parseOne(text, turn, span || ((fn) => fn())))
    // Handed back unparsed, by any path: too long to parse in place.
    .then((r) => {
      const word = !r.ok && !r.keep ? inPlaceRefusal(text) : null;
      if (!word) return r;
      stats.kept++;
      return { ok: false, reason: r.reason, keep: word };
    })
    // The queue is empty: the child goes, at once or after its idle wait.
    .finally(() => { if (--queued === 0) idle = idleSoon(); });
  chain = run.then(() => idle, () => idle);
  return run;
}
let idle = null; // the idle check in flight; the next document waits for it
/** Resolves when the idle check in flight (if any) has decided: for tests and the drain's callers. */
export function crawlParseIdle() { return Promise.resolve(idle).then(() => {}, () => {}); }
async function idleSoon() {
  const w = current;
  if (!w) return;
  if (!(cfg.idleMs > 0)) { endWorker("idle"); return; }
  let rssMb = Infinity;
  try { rssMb = Number((await ask(w, { op: "idle", id: ++nextId })).rssMb); } catch { /* gone, or no answer: ended below */ }
  if (current !== w) return;
  if (!(rssMb <= cfg.idleRssMb)) { endWorker("idle"); return; }
  if (queued > 0) return; // a document arrived meanwhile: it uses this child
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { idleTimer = null; if (queued === 0) endWorker("idle"); }, cfg.idleMs);
  idleTimer.unref?.();
}
// ---- documents already known --------------------------------------------------
// The hash of a document that ended or was declined by the parser -> how it
// was answered, until when (RECALL_MS).
const recalled = new Map();
function recall(key, now = Date.now()) {
  const r = recalled.get(key);
  if (!r) return null;
  if (r.until <= now) { recalled.delete(key); return null; }
  return r;
}
function remember(key, answer) {
  recalled.delete(key);
  recalled.set(key, { ...answer, until: Date.now() + cfg.recallMs });
  while (recalled.size > RECALL_MAX) recalled.delete(recalled.keys().next().value);
}
/** The text's hash, a chunk per turn: its UTF-16 code units, so two texts that differ anywhere differ here. */
async function textKey(text, turn, span) {
  const h = createHash("sha256");
  const step = Math.max(1024, cfg.chunkChars);
  for (let at = 0; at < text.length; at += step) {
    if (turn && at > 0) await turn();
    span(() => h.update(text.slice(at, at + step), "utf16le"));
  }
  return `${text.length}:${h.digest("hex")}`;
}
function kept(reason, keep) { stats.fallbacks++; stats.kept++; stats.lastFallback = reason; return { ok: false, reason, keep }; }

function fellBack(reason) {
  stats.fallbacks++;
  stats.lastFallback = reason;
  if (++failsInARow >= FAILS_BEFORE_PAUSE) { pausedUntil = Date.now() + PAUSE_MS; failsInARow = 0; }
  return { ok: false, reason };
}
async function parseOne(text, turn, span) {
  if (stopped) return { ok: false, reason: "stopped" };
  // A document this parser already ended on, or declined, is answered as it
  // was then, with no child asked (paused or not).
  const key = await textKey(text, turn, span);
  const known = recall(key);
  if (known) {
    stats.recalled++;
    if (known.keep) return kept(known.reason, known.keep);
    stats.fallbacks++; stats.lastFallback = known.reason;
    return { ok: false, reason: known.reason };
  }
  if (stopped) return { ok: false, reason: "stopped" };
  if (pausedUntil > Date.now()) { stats.fallbacks++; stats.lastFallback = "paused after failures"; return { ok: false, reason: "paused after failures" }; }
  let w;
  try { w = span(() => ensureWorker()); } catch (e) { return fellBack(`parser did not start: ${String(e?.message || e).slice(0, 120)}`); }
  const id = ++nextId;
  const b = newBuilder();
  let pieceBytes = cfg.pieceBytes, pieces = 0, longestMs = 0, totalMs = 0;
  let invalid = null, unsplit = null;
  const timed = (fn) => { const t0 = performance.now(); span(fn); const ms = performance.now() - t0; totalMs += ms; if (ms > longestMs) longestMs = ms; return ms; };
  try {
    // The text, a chunk per turn: the copy into the message is this thread's work.
    const step = Math.max(1024, cfg.chunkChars);
    for (let at = 0; at < text.length; at += step) {
      if (turn) await turn();
      let sent;
      timed(() => { sent = sendChunk(w, { op: "text", id, chunk: text.slice(at, at + step) }); });
      await sent;
    }
    // From here the child holds the document: ending now is the document's doing.
    w.holding = id;
    let reply = await ask(w, { op: "parse", id, pieceBytes, clone: cfg.clone === true, maxTreeBytes: Math.floor(cfg.heapMb * 1048576 * TREE_SHARE) });
    for (;;) {
      if (reply.invalid) { invalid = reply.invalid; break; }
      // The child answered that it will not take this document (its tree may
      // not fit): that is the document, not a failing parser, so it does not
      // count toward the pause.
      if (reply.failed) { unsplit = String(reply.failed).slice(0, 160); break; }
      if (turn) await turn();
      const ms = timed(() => applySteps(b, reply.enc === "json" ? JSON.parse(reply.piece) : deserialize(reply.piece)));
      pieces++;
      if (reply.done) break;
      // The next piece's weight from what this one cost, a factor of two at most per step.
      const wanted = Math.max(reply.weight, 1) * cfg.targetMs / Math.max(ms, 0.25);
      pieceBytes = Math.min(cfg.maxPieceBytes, Math.max(cfg.minPieceBytes, Math.round(Math.min(pieceBytes * 2, Math.max(pieceBytes / 2, wanted)))));
      reply = await ask(w, { op: "next", id, pieceBytes });
    }
    w.holding = null;
  } catch (e) {
    const reason = String(e?.message || e).slice(0, 160);
    // Whatever failed, this child is not handed another document.
    const died = w.diedHolding;
    w.holding = null;
    if (current === w) endWorker(reason);
    // The child ended by itself while it held this document (not stopped, not
    // timed out by us): the tree did not fit its heap. The parser is sound.
    // It is not parsed in place either (see the head of this file).
    if (died && /^parser exited \(SIG(ABRT|KILL|TRAP|ILL|SEGV|BUS)\)/.test(reason)) {
      stats.died++;
      const answer = { reason: `${reason} holding the document`, keep: KEEP_PREVIOUS.ended };
      remember(key, answer);
      return kept(answer.reason, answer.keep);
    }
    return fellBack(reason);
  }
  failsInARow = 0;
  if (unsplit) {
    // Declined by the estimate: parsed in place when short enough to bound
    // (DECLINED_IN_PLACE_MAX_CHARS), else not parsed. Either way the child is
    // not asked again for this text.
    if (/^unsplit:/.test(unsplit)) {
      const answer = text.length >= DECLINED_IN_PLACE_MAX_CHARS ? { reason: unsplit, keep: KEEP_PREVIOUS.large } : { reason: unsplit };
      remember(key, answer);
      if (answer.keep) return kept(answer.reason, answer.keep);
    }
    stats.fallbacks++; stats.lastFallback = unsplit; return { ok: false, reason: unsplit };
  }
  if (invalid) { stats.invalid++; throw new SyntaxError(invalid.message); }
  if (b.stack.length) return fellBack("pieces ended with a container open");
  stats.offLoop++; stats.pieces += pieces;
  return { ok: true, value: b.root, pieces, longestMs, totalMs };
}
