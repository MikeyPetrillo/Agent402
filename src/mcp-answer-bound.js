// A ceiling on the size of one free tool answer the hosted connector returns.
//
// A connector answer is serialized twice (the text block and
// structuredContent) and lands in a model's context, so an answer of many
// megabytes costs the caller its context and this process the memory. Past
// the ceiling the answer is cut in one pass, in document order, and stays
// valid JSON: a long list keeps its first rows, a long string its first
// characters, an object its first keys. What was cut is said in FIELDS (the
// partial-answer vocabulary, src/partial-answer.js), never only in prose:
//
//   answerBound: {
//     unit: "bytes", maxBytes,
//     returned, matched, complete: false, truncated: true,   // bytes kept of bytes produced
//     cuts: [{ path, kind: "array" | "string" | "object", returned, matched, complete, truncated }],
//     cutsListed, cutsTotal,
//   }
//
// Only the free (proof-of-work) path is bounded. An answer a buyer paid for is
// delivered whole.
import { partialFields } from "./partial-answer.js";

export const MCP_MAX_ANSWER_DEFAULT_BYTES = 1024 * 1024;
const MAX_CUTS_LISTED = 20;
const MAX_DEPTH = 64;

/** The ceiling this process runs with (AGENT402_MCP_MAX_ANSWER_BYTES; a value
 *  that is not a positive number reads as the default). */
export function mcpMaxAnswerBytes(env = process.env) {
  const n = Number(env.AGENT402_MCP_MAX_ANSWER_BYTES);
  return Number.isFinite(n) && n >= 1024 ? Math.floor(n) : MCP_MAX_ANSWER_DEFAULT_BYTES;
}

const sizeOf = (v) => {
  try { return Buffer.byteLength(JSON.stringify(v) ?? "null"); } catch { return Infinity; }
};

/**
 * Bound one JSON answer.
 *
 * @param {*} result       the tool's answer (any JSON value).
 * @param {number} [maxBytes] the ceiling on the compact serialization.
 * @returns {{ value: *, bound: object|null }} `value` is `result` itself when
 *   it fits (bound null); otherwise a cut copy, with `bound` holding the
 *   answerBound fields above.
 */
export function boundAnswer(result, maxBytes = mcpMaxAnswerBytes()) {
  const fullBytes = sizeOf(result);
  if (fullBytes <= maxBytes) return { value: result, bound: null };
  // Room for the answerBound block itself and the envelope around the answer.
  let budget = Math.max(256, maxBytes - 4096);
  const cuts = [];
  let cutsTotal = 0;
  const note = (path, kind, matched, returned) => {
    cutsTotal++;
    if (cuts.length < MAX_CUTS_LISTED) cuts.push({ path: path || "$", kind, ...partialFields(matched, returned) });
  };
  const copy = (v, path, depth) => {
    if (v === null || typeof v === "number" || typeof v === "boolean") { budget -= 8; return v; }
    if (typeof v === "string") {
      // Worst case a character costs six bytes escaped; counting each as one
      // and re-measuring below keeps this one pass.
      const room = Math.max(0, budget - 2);
      if (v.length <= room) { budget -= Buffer.byteLength(JSON.stringify(v)); return v; }
      const kept = v.slice(0, Math.floor(room / 2));
      budget -= Buffer.byteLength(JSON.stringify(kept));
      note(path, "string", v.length, kept.length);
      return kept;
    }
    if (typeof v !== "object" || depth > MAX_DEPTH) { budget -= 8; return null; }
    if (Array.isArray(v)) {
      const out = [];
      budget -= 2;
      for (let i = 0; i < v.length; i++) {
        if (budget <= 0) { note(path, "array", v.length, out.length); break; }
        out.push(copy(v[i], `${path}[${i}]`, depth + 1));
        budget -= 1;
      }
      return out;
    }
    const out = {};
    const keys = Object.keys(v);
    budget -= 2;
    let kept = 0;
    for (const k of keys) {
      if (budget <= 0) { note(path, "object", keys.length, kept); break; }
      budget -= Buffer.byteLength(JSON.stringify(k)) + 2;
      out[k] = copy(v[k], path ? `${path}.${k}` : k, depth + 1);
      kept++;
    }
    return out;
  };
  let value = copy(result, "", 0);
  // An escape-heavy string can serialize past its estimate: halve the ceiling
  // and copy again until the measured size fits (a handful of passes at most).
  for (let pass = 0, cap = maxBytes; sizeOf(value) > maxBytes - 4096 && pass < 12; pass++) {
    cap = Math.floor(cap / 2);
    budget = Math.max(64, cap - 4096);
    cuts.length = 0; cutsTotal = 0;
    value = copy(result, "", 0);
  }
  const bound = {
    unit: "bytes",
    maxBytes,
    ...partialFields(fullBytes, sizeOf(value)),
    cuts,
    cutsListed: cuts.length,
    cutsTotal,
  };
  return { value, bound };
}

/**
 * The connector result for a bounded answer: the cut answer with `answerBound`
 * riding inside it (an answer that is not a plain object is wrapped as
 * `{ result, answerBound }`), so the text block and structuredContent agree.
 */
export function withAnswerBound(value, bound) {
  if (!bound) return value;
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value, answerBound: bound }
    : { result: value, answerBound: bound };
}
