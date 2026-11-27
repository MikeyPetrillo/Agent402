// Crawl parse thread (the other half of src/crawl-parse.js).
//
// Parses one fetched document with JSON.parse, so validity and the error text
// are V8's own, then hands the parsed tree back in pieces: a list of steps
// that rebuild the same value, cut so that each piece is a small share of the
// document. The main thread asks for one piece at a time, so it never
// rebuilds more than one piece in a loop turn.
//
// BEFORE the parse the text is measured (estimateTreeBytes): a document whose
// parsed tree may not fit this thread's heap is answered "unsplit" unparsed,
// and the main thread parses it itself as it always did. A thread that
// reaches its heap limit inside JSON.parse does not end alone, so the limit
// is never approached: the main thread sends the most the tree may cost
// (`maxTreeBytes`, a share of the heap limit it started this thread with).
//
// A piece travels as JSON text, which the main thread parses at JSON.parse's
// own speed (rebuilding a structured clone costs it two to five times that).
// JSON text cannot carry two numbers a parsed document may hold: negative
// zero, and the infinity an out-of-range literal becomes. A piece holding
// either travels as a structured clone instead ("clone"), which carries both.
//
// Nothing here recurses on the document's depth: the tree is walked with an
// explicit stack, and a subtree is sent whole only when it is both light and
// shallow (MAX_WHOLE_HEIGHT), since serializing a value does recurse. A
// document nested millions deep is split like any other.
//
// Imports nothing from the application and reads no environment.
import { parentPort } from "node:worker_threads";
import { serialize } from "node:v8";

// The deepest subtree sent as one value (JSON.stringify and the structured
// clone recurse on depth; both pass several thousand levels).
const MAX_WHOLE_HEIGHT = 64;
// What an object key adds to a piece's weight beyond its text: a distinct key
// is interned and added to its object's table when the piece is rebuilt.
const KEY_WEIGHT = 40;

/**
 * About what parsing `text` costs this thread's heap, from one pass over its
 * characters, erring high: the text twice (the copy held here and the strings
 * made from it; twice that when any character is past Latin-1), 72 bytes per
 * container opened (an empty object or array with its backing store), 16 per
 * comma (a slot and a boxed number), 40 per colon (a key that may be the only
 * one of its name: its interned string and its object's own shape), 8 per
 * quote (a string's header), and 256 per level of the deepest nesting (the
 * parser's own record of each open container, which is memory outside the
 * heap and outside any limit on it). Characters inside strings are counted
 * as structure too. Measured against the live heap after a parse it reads
 * 0.86 (objects of one distinct key each) to 3.2 times the real cost; the
 * caller allows half the heap limit, so the lowest reading still leaves room.
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
// pieces (the main thread tunes it): each container is judged when reached.
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
  if (!clone) { parentPort.postMessage({ id, enc: "json", piece: JSON.stringify(steps), weight, done }); return; }
  const buf = serialize(steps);
  // The bytes are moved, not copied: the piece is this thread's no longer.
  const ab = buf.buffer.byteLength === buf.byteLength ? buf.buffer : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  parentPort.postMessage({ id, enc: "clone", piece: ab, weight, done }, [ab]);
}

// Imported on a main thread (a test reading the estimate) there is no port.
parentPort?.on("message", (m) => {
  if (!m || typeof m !== "object") return;
  try {
    if (m.op === "parse") {
      job = null;
      const most = Number(m.maxTreeBytes) > 0 ? Number(m.maxTreeBytes) : Infinity;
      const estimate = estimateTreeBytes(m.text);
      if (estimate > most) { parentPort.postMessage({ id: m.id, failed: `unsplit: about ${Math.round(estimate / 1048576)} MB parsed, past the thread's ${Math.round(most / 1048576)} MB` }); return; }
      let value;
      try { value = JSON.parse(m.text); }
      catch (e) { parentPort.postMessage({ id: m.id, invalid: { name: String(e?.name || "SyntaxError"), message: String(e?.message || e) } }); return; }
      const state = { limit: Math.max(1024, Number(m.pieceBytes) || 65536), clone: m.clone === true };
      job = { id: m.id, it: stepsFor(value, state), state };
      sendPiece();
    } else if (m.op === "next" && job && job.id === m.id) {
      if (Number(m.pieceBytes) > 0) job.state.limit = Math.max(1024, Number(m.pieceBytes));
      sendPiece();
    } else if (m.op === "drop" && job && job.id === m.id) {
      job = null;
    }
  } catch (e) {
    job = null;
    parentPort.postMessage({ id: m.id, failed: String(e?.message || e).slice(0, 200) });
  }
});
