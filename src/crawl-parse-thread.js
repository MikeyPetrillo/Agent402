// Crawl parse thread (the other half of src/crawl-parse.js).
//
// Parses one fetched document with JSON.parse, so validity and the error text
// are V8's own, then hands the parsed tree back in pieces: a list of steps
// that rebuild the same value, cut so that each piece is a small share of the
// document. The main thread asks for one piece at a time, so it never
// rebuilds more than one piece in a loop turn.
//
// A piece travels as JSON text, which the main thread parses at JSON.parse's
// own speed (rebuilding a structured clone costs it two to five times that).
// JSON text cannot carry two numbers a parsed document may hold: negative
// zero, and the infinity an out-of-range literal becomes. A document holding
// either travels as structured clones instead ("clone"), which carry both.
//
// Imports nothing from the application and reads no environment.
import { parentPort } from "node:worker_threads";
import { serialize } from "node:v8";

// A document nested past this many containers that each outweigh a piece is
// answered "unsplit": the main thread then parses it itself, as before.
const MAX_HEAVY_DEPTH = 64;
const MAX_WEIGH_DEPTH = 2000;

/** The rough serialized size of `v`; containers heavier than `limit` are noted in `heavy`. */
function weigh(v, limit, heavy, depth) {
  if (typeof v === "string") return v.length + 2;
  if (typeof v === "number") {
    if (heavy && (v === 0 ? 1 / v < 0 : !Number.isFinite(v))) heavy.exotic = true;
    return 8;
  }
  if (v === null || typeof v !== "object") return 8;
  if (depth > MAX_WEIGH_DEPTH) throw new Error("unsplit: nested too deep to weigh");
  let w = 2;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) w += weigh(v[i], limit, heavy, depth + 1) + 1;
  } else {
    for (const k of Object.keys(v)) w += k.length + 4 + weigh(v[k], limit, heavy, depth + 1);
  }
  if (heavy && w > limit) heavy.set(v, w);
  return w;
}
/** The weight of a child: noted when heavy, weighed again when light (a light
 *  child is never opened, so each is weighed here once). */
function weightOf(child, heavy) {
  if (typeof child === "string") return child.length + 2;
  if (child === null || typeof child !== "object") return 8;
  const noted = heavy.get(child);
  return noted === undefined ? weigh(child, Infinity, null, 0) : noted;
}

// The steps that rebuild a value (applied by src/crawl-parse.js applySteps):
//   ["v", value]        the value for the open slot
//   ["a"] / ["o"]       open an array / object in the open slot
//   ["p", [values]]     append values to the open array
//   ["s", [k, v, ...]]  set keys on the open object, in order
//   ["k", key]          the next opened or given value goes under this key
//   ["c"]               close the open container
// Each yield is [step, weight]. A container no heavier than `state.limit` goes
// whole; a heavier one is opened and its children sent in runs of about that
// weight. `state.limit` may change between pieces (the main thread tunes it).
function* stepsFor(v, heavy, state, depth) {
  const w = weightOf(v, heavy);
  if (w <= state.limit || v === null || typeof v !== "object") { yield [["v", v], w]; return; }
  if (depth > MAX_HEAVY_DEPTH) throw new Error("unsplit: heavy containers nested too deep");
  const isArray = Array.isArray(v);
  yield [[isArray ? "a" : "o"], 8];
  let run = [], runWeight = 0;
  const flush = function* () { if (run.length) { yield [[isArray ? "p" : "s", run], runWeight]; run = []; runWeight = 0; } };
  const keys = isArray ? null : Object.keys(v);
  const n = isArray ? v.length : keys.length;
  for (let i = 0; i < n; i++) {
    const child = isArray ? v[i] : v[keys[i]];
    const cw = weightOf(child, heavy);
    if (cw > state.limit && child !== null && typeof child === "object") {
      yield* flush();
      if (!isArray) yield [["k", keys[i]], keys[i].length + 8];
      yield* stepsFor(child, heavy, state, depth + 1);
      continue;
    }
    if (!isArray) run.push(keys[i]);
    run.push(child);
    runWeight += cw + (isArray ? 1 : keys[i].length + 4);
    if (runWeight >= state.limit) yield* flush();
  }
  yield* flush();
  yield [["c"], 8];
}

let job = null; // { id, it, state }

function sendPiece() {
  const { id, it, state } = job;
  const steps = [];
  let weight = 0, done = false;
  while (weight < state.limit) {
    const r = it.next();
    if (r.done) { done = true; break; }
    steps.push(r.value[0]);
    weight += r.value[1];
  }
  if (done) job = null;
  if (!state.clone) { parentPort.postMessage({ id, enc: "json", piece: JSON.stringify(steps), weight, done }); return; }
  const buf = serialize(steps);
  // The bytes are moved, not copied: the piece is this thread's no longer.
  const ab = buf.buffer.byteLength === buf.byteLength ? buf.buffer : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  parentPort.postMessage({ id, enc: "clone", piece: ab, weight, done }, [ab]);
}

parentPort.on("message", (m) => {
  if (!m || typeof m !== "object") return;
  try {
    if (m.op === "parse") {
      job = null;
      let value;
      try { value = JSON.parse(m.text); }
      catch (e) { parentPort.postMessage({ id: m.id, invalid: { name: String(e?.name || "SyntaxError"), message: String(e?.message || e) } }); return; }
      const state = { limit: Math.max(1024, Number(m.pieceBytes) || 65536) };
      // Weighed against the smallest piece the main thread may ask for, so a
      // later, smaller limit still finds the containers it must open.
      const heavy = new Map();
      weigh(value, Math.max(1024, Number(m.minPieceBytes) || state.limit), heavy, 0);
      state.clone = heavy.exotic === true || m.clone === true;
      job = { id: m.id, it: stepsFor(value, heavy, state, 0), state };
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
