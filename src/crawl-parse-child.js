// Crawl parse process (the other half of src/crawl-parse.js).
//
// A child process of the server, started for the documents the crawl has
// parsed off its loop. It parses one fetched document with JSON.parse, so
// validity and the error text are V8's own, then hands the parsed tree back in
// pieces: a list of steps that rebuild the same value, cut so that each piece
// is a small share of the document. The server asks for one piece at a time,
// so it never rebuilds more than one piece in a loop turn.
//
// WHY A PROCESS. A parser that runs out of memory inside JSON.parse does not
// fail a call: V8 ends the process it runs in. In a thread of the server that
// process is the server. No measure of the text read before the parse bounds
// what the tree costs for every shape (an object's integer-like key reserves
// a slot for every index below it), so nothing here depends on one: this
// process has its own heap limit (the --max-old-space-size the server starts
// it with), and when a document's tree passes it, this process ends and the
// server parses the document itself, as it did before there was a parser.
// On Linux it also marks itself the first process the kernel ends when the
// machine is out of memory, ahead of the server.
//
// The estimate below is kept as a courtesy, not a bound: a document whose
// tree plainly will not fit (`maxTreeBytes`) is answered "unsplit" unparsed,
// which saves starting a parse that would end this process.
//
// The text arrives in chunks ("text") and is joined here; a piece travels
// back as JSON text, which the server parses at JSON.parse's own speed
// (rebuilding a structured clone costs it two to five times that). JSON text
// cannot carry two numbers a parsed document may hold: negative zero, and the
// infinity an out-of-range literal becomes. A piece holding either travels as
// a structured clone instead ("clone"), which carries both.
//
// Nothing here recurses on the document's depth: the tree is walked with an
// explicit stack, and a subtree is sent whole only when it is both light and
// shallow (MAX_WHOLE_HEIGHT), since serializing a value does recurse. A
// document nested millions deep is split like any other.
//
// Imports nothing from the application and reads no environment: the server
// starts it with an allowlisted environment (src/tools/child-env.js childEnv,
// no NODE_OPTIONS, so no flag or preload of the server's reaches it) and with
// the two flags it needs on its command line.
import { writeFileSync } from "node:fs";
import { serialize } from "node:v8";

/** The argument the server starts this file with; imported anywhere else (a test reading the estimate) it does nothing. */
export const CHILD_ARG = "crawl-parse-child";
const isChild = process.argv[2] === CHILD_ARG && typeof process.send === "function";
const post = (m) => { try { process.send(m); } catch { /* the server is gone: the disconnect handler ends this process */ } };

// The deepest subtree sent as one value (JSON.stringify and the structured
// clone recurse on depth; both pass several thousand levels).
const MAX_WHOLE_HEIGHT = 64;
// What an object key adds to a piece's weight beyond its text: a distinct key
// is interned and added to its object's table when the piece is rebuilt.
const KEY_WEIGHT = 40;

/**
 * About what parsing `text` costs this process's heap, from one pass over its
 * characters: the text twice (the copy held here and the strings made from
 * it; twice that when any character is past Latin-1), 72 bytes per container
 * opened, 16 per comma, 40 per colon, 8 per quote, and 256 per level of the
 * deepest nesting. Characters inside strings are counted as structure too.
 * For ordinary documents it reads high (up to about three times the live
 * cost); for some shapes it reads low (integer-like keys, which reserve a
 * slot per index below them, cost several times this). It decides only
 * whether a parse is worth starting; what holds when it is wrong is the
 * process boundary (see the head of this file).
 */
export function estimateTreeBytes(text) {
  let containers = 0, commas = 0, colons = 0, quotes = 0, wide = false, depth = 0, deepest = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 91 || c === 123) { containers++; if (++depth > deepest) deepest = depth; }
    else if (c === 93 || c === 125) { if (depth > 0) depth--; }
    else if (c === 44) commas++;
    else if (c === 58) colons++;
    else if (c === 34) quotes++;
    else if (c > 255) wide = true;
  }
  return text.length * (wide ? 4 : 2) + containers * 72 + commas * 16 + colons * 40 + quotes * 8 + deepest * 256;
}

// JSON text cannot carry these; a piece that holds one is sent as a clone.
const exoticNumber = (v) => (v === 0 ? 1 / v < 0 : !Number.isFinite(v));

/**
 * The weight of `v` when it may be sent whole, else -1: heavier than `budget`
 * or taller than MAX_WHOLE_HEIGHT. Stops as soon as either is known, so a
 * heavy container costs no more than the budget to refuse. Recursion here is
 * bounded by the height limit. `probe.exotic` is set when a number JSON text
 * cannot carry is seen.
 */
const probe = { left: 0, exotic: false };
function wholeWeight(v, budget) {
  probe.left = budget;
  return spend(v, 0) ? budget - probe.left : -1;
}
function spend(v, depth) {
  if (typeof v === "string") { probe.left -= v.length + 2; return probe.left >= 0; }
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && exoticNumber(v)) probe.exotic = true;
    probe.left -= 8;
    return probe.left >= 0;
  }
  if (depth >= MAX_WHOLE_HEIGHT) return false;
  probe.left -= 2;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { probe.left -= 1; if (probe.left < 0 || !spend(v[i], depth + 1)) return false; }
  } else {
    for (const k in v) { probe.left -= k.length + 4 + KEY_WEIGHT; if (probe.left < 0 || !spend(v[k], depth + 1)) return false; }
  }
  return probe.left >= 0;
}
const scalarWeight = (v) => (typeof v === "string" ? v.length + 2 : 8);
const isContainer = (v) => v !== null && typeof v === "object";

// The steps that rebuild a value (applied by src/crawl-parse.js applySteps):
//   ["v", value]        the value for the open slot
//   ["a"] / ["o"]       open an array / object in the open slot
//   ["p", [values]]     append values to the open array
//   ["s", [k, v, ...]]  set keys on the open object, in order
//   ["k", key]          the next opened container goes under this key
//   ["c"]               close the open container
// Each yield is [step, weight, exotic]. A container that is light and shallow
// (wholeWeight against `state.limit`) goes whole; any other is opened and its
// children sent in runs of about that weight. `state.limit` may change between
// pieces (the server tunes it): each container is judged when reached.
// The open containers are an explicit stack, so depth costs no call, held as
// three parallel lists (the container, its keys, the next index): a document
// nested millions deep costs a few bytes a level here, not an object each.
// Only the innermost open container gathers a run (an outer one's was sent
// before its child was opened), so one run serves them all.
function* stepsFor(root, state) {
  probe.exotic = false;
  if (!isContainer(root)) { yield [["v", root], scalarWeight(root), typeof root === "number" && exoticNumber(root)]; return; }
  const w = wholeWeight(root, state.limit);
  if (w >= 0) { yield [["v", root], w, probe.exotic]; return; }
  const open = [], keysOf = [], at = [];
  const push = (v) => { open.push(v); keysOf.push(Array.isArray(v) ? null : Object.keys(v)); at.push(0); return [[Array.isArray(v) ? "a" : "o"], 8, false]; };
  let run = [], runWeight = 0, runExotic = false;
  const takeRun = (isArray) => { const step = [[isArray ? "p" : "s", run], runWeight, runExotic]; run = []; runWeight = 0; runExotic = false; return step; };
  yield push(root);
  while (open.length) {
    const top = open.length - 1;
    const v = open[top], keys = keysOf[top], isArray = keys === null;
    const n = isArray ? v.length : keys.length;
    const i = at[top];
    if (i >= n || runWeight >= state.limit) {
      if (run.length) yield takeRun(isArray);
      if (i >= n) { open.pop(); keysOf.pop(); at.pop(); yield [["c"], 8, false]; }
      continue;
    }
    const key = isArray ? null : keys[i];
    const child = isArray ? v[i] : v[key];
    at[top] = i + 1;
    let cw;
    if (isContainer(child)) {
      probe.exotic = false;
      cw = wholeWeight(child, state.limit);
      if (cw < 0) {
        if (run.length) yield takeRun(isArray);
        if (!isArray) yield [["k", key], key.length + 8, false];
        yield push(child);
        continue;
      }
      if (probe.exotic) runExotic = true;
    } else {
      cw = scalarWeight(child);
      if (typeof child === "number" && exoticNumber(child)) runExotic = true;
    }
    if (!isArray) run.push(key);
    run.push(child);
    runWeight += cw + (isArray ? 1 : key.length + 4 + KEY_WEIGHT);
  }
}

let job = null; // { id, it, state }
let parts = null; // { id, chunks } : the text of the document being received
const release = () => { job = null; parts = null; };
// With nothing left to do, the last document's tree is collected (the server
// starts this process with --expose-gc) and the memory still held is
// reported: the server keeps a small idle parser and ends a large one.
const collect = () => { try { globalThis.gc?.(); globalThis.gc?.(); } catch { /* best-effort */ } return Math.round(process.memoryUsage.rss() / 1048576); };

function sendPiece() {
  const { id, it, state } = job;
  const steps = [];
  let weight = 0, done = false, clone = state.clone;
  while (weight < state.limit) {
    const r = it.next();
    if (r.done) { done = true; break; }
    steps.push(r.value[0]);
    weight += r.value[1];
    if (r.value[2]) clone = true;
  }
  if (done) job = null;
  if (!clone) post({ id, enc: "json", piece: JSON.stringify(steps), weight, done });
  else post({ id, enc: "clone", piece: serialize(steps), weight, done });
  if (done) release();
}

if (isChild) {
  // The kernel's first choice when memory runs out (Linux; elsewhere there is no such file).
  try { writeFileSync("/proc/self/oom_score_adj", "1000"); } catch { /* not Linux, or not permitted */ }
  process.on("disconnect", () => process.exit(0));
  process.on("message", (m) => {
    if (!m || typeof m !== "object") return;
    try {
      if (m.op === "text") {
        if (!parts || parts.id !== m.id) { job = null; parts = { id: m.id, chunks: [] }; }
        parts.chunks.push(String(m.chunk));
      } else if (m.op === "parse") {
        job = null;
        let text = parts && parts.id === m.id ? parts.chunks.join("") : "";
        parts = null;
        const most = Number(m.maxTreeBytes) > 0 ? Number(m.maxTreeBytes) : Infinity;
        const estimate = estimateTreeBytes(text);
        if (estimate > most) { post({ id: m.id, failed: `unsplit: about ${Math.round(estimate / 1048576)} MB parsed, past the parser's ${Math.round(most / 1048576)} MB` }); release(); return; }
        let value;
        try { value = JSON.parse(text); }
        catch (e) { post({ id: m.id, invalid: { name: String(e?.name || "SyntaxError"), message: String(e?.message || e) } }); release(); return; }
        text = null;
        const state = { limit: Math.max(1024, Number(m.pieceBytes) || 65536), clone: m.clone === true };
        job = { id: m.id, it: stepsFor(value, state), state };
        sendPiece();
      } else if (m.op === "next" && job && job.id === m.id) {
        if (Number(m.pieceBytes) > 0) job.state.limit = Math.max(1024, Number(m.pieceBytes));
        sendPiece();
      } else if (m.op === "idle") {
        release();
        post({ id: m.id, rssMb: collect() });
      } else if (m.op === "drop" && ((job && job.id === m.id) || (parts && parts.id === m.id))) {
        release();
      }
    } catch (e) {
      release();
      post({ id: m.id, failed: String(e?.message || e).slice(0, 200) });
    }
  });
}
