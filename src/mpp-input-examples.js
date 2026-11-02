// Request-body shapes for MPP endpoints, read from the seller's own llms.txt.
//
// An MPP index row (src/mpp-index.js) carries method, path, description and
// payment for each endpoint, and no input schema, so route-execute forwards a
// buyer's `params` to a Tempo seller exactly as written. A seller that
// documents a request example in its llms.txt as
//
//   ## POST /v1/contents
//   ```json
//   {"urls": ["https://example.com"]}
//   ```
//
// tells us the body's top-level key shapes. That document is untrusted seller
// text: it is fetched with the same egress guard as every other seller
// document (safeFetch: public addresses only, a byte cap, a timeout), and only
// the KEY NAMES of each example and whether each value is a list of scalars
// or a scalar are kept. No value, no prose and no instruction from it reaches
// a buyer, a model or a request. A key that is not a plain identifier, or an
// example whose keys trip the listing screen, is dropped.
//
// adaptParamsToExample() uses those shapes for one lossless case only: a
// buyer's scalar `url` / `query` / `id` where the example has the plural key
// as a list (and not the singular), sent as a one-element list under the
// plural key, or the reverse for a one-element list. Every other key rides
// through unchanged, and anything ambiguous leaves the body untouched.
import { listingInjectionFinding } from "./listing-screen.js";

export const LLMS_TXT_MAX_BYTES = 256 * 1024;
const MAX_ENDPOINTS = 64;
const MAX_KEYS = 32;
const MAX_BLOCK_CHARS = 4096;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADING_RE = /^#{2,3}\s+(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`]*)\s*$/;
const ANY_HEADING_RE = /^#{1,6}\s/;
const FENCE_OPEN_RE = /^```\s*json\s*$/i;
const FENCE_RE = /^```/;
const RESPONSE_CUE = /\b(response|returns?|output|result)\b/i;
const REQUEST_CUE = /\b(request|body|input|payload)\b/i;

const isScalar = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
function shapeOf(v) {
  if (Array.isArray(v)) return v.length > 0 && v.every(isScalar) ? "list" : "other";
  if (isScalar(v)) return "scalar";
  return "other";
}

/** The key shapes of one example object, or null when it is not a plain
 *  object, has too many keys, or names a key that is not an identifier. */
function keysOfExample(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const entries = Object.entries(obj);
  if (!entries.length || entries.length > MAX_KEYS) return null;
  const keys = {};
  for (const [k, v] of entries) {
    if (!KEY_RE.test(k)) return null;
    keys[k] = shapeOf(v);
  }
  if (listingInjectionFinding(Object.keys(keys).join(" "))) return null;
  return keys;
}

/** Per-endpoint request-example key shapes from an llms.txt body: a Map of
 *  "METHOD /path" -> { key: "list" | "scalar" | "other" }. A section with one
 *  json block uses it unless the line before it reads as a response; a
 *  section with several uses the one introduced as a request, and none when
 *  that is not exactly one. Malformed JSON, an oversized block or document,
 *  and a path with a template are skipped. Pure; never throws. */
export function parseLlmsExamples(text) {
  const out = new Map();
  if (typeof text !== "string" || !text || text.length > LLMS_TXT_MAX_BYTES) return out;
  const lines = text.split(/\r?\n/);
  let section = null;
  const finish = () => {
    if (!section || out.size >= MAX_ENDPOINTS) { section = null; return; }
    const blocks = section.blocks;
    let pick = null;
    if (blocks.length === 1) pick = RESPONSE_CUE.test(blocks[0].cue) ? null : blocks[0];
    else if (blocks.length > 1) {
      const req = blocks.filter((b) => REQUEST_CUE.test(b.cue) && !RESPONSE_CUE.test(b.cue));
      pick = req.length === 1 ? req[0] : null;
    }
    if (pick) {
      let parsed = null;
      try { parsed = JSON.parse(pick.body); } catch { parsed = null; }
      const keys = keysOfExample(parsed);
      const id = `${section.method} ${section.path}`;
      if (keys && !out.has(id)) out.set(id, keys);
    }
    section = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = HEADING_RE.exec(line.trim());
    if (h) {
      finish();
      const path = h[2];
      section = /[{}:*]/.test(path) ? null : { method: h[1].toUpperCase(), path, blocks: [] };
      continue;
    }
    if (ANY_HEADING_RE.test(line)) { finish(); continue; }
    if (!section || !FENCE_OPEN_RE.test(line.trim())) continue;
    // The nearest non-empty line above the fence is its label.
    let cue = "";
    for (let j = i - 1; j >= 0; j--) { if (lines[j].trim()) { cue = lines[j]; break; } }
    const body = [];
    let size = 0;
    let closed = false;
    for (i = i + 1; i < lines.length; i++) {
      if (FENCE_RE.test(lines[i].trim())) { closed = true; break; }
      size += lines[i].length + 1;
      if (size <= MAX_BLOCK_CHARS) body.push(lines[i]);
    }
    if (closed && size <= MAX_BLOCK_CHARS) section.blocks.push({ cue, body: body.join("\n") });
    else if (closed) section.blocks.push({ cue, body: "" }); // oversized: counted, never parsed into keys
  }
  finish();
  return out;
}

/** Endpoints with `inputExample` set from a parsed llms.txt (by method and
 *  path). An endpoint with no example comes back unchanged. Pure. */
export function attachInputExamples(endpoints, examples) {
  if (!Array.isArray(endpoints)) return [];
  if (!(examples instanceof Map) || !examples.size) return endpoints;
  return endpoints.map((e) => {
    if (!e || typeof e.path !== "string") return e;
    const keys = examples.get(`${String(e.method || "GET").toUpperCase()} ${e.path}`);
    return keys ? { ...e, inputExample: { source: "llms.txt", keys } } : e;
  });
}

const PAIRS = [["url", "urls"], ["query", "queries"], ["id", "ids"]];

/**
 * Reshape a buyer's params toward a seller's documented example, for the one
 * lossless case: a scalar `url`/`query`/`id` the example takes as a list under
 * the plural key (and does not take as the singular), or a one-element list
 * under the plural the example takes as the singular scalar. Returns
 * { params, adapted } where `adapted` lists each rename ("url->urls"); with
 * nothing to do, or anything ambiguous, `params` is the input object itself
 * and `adapted` is empty. Never adds a key the buyer did not send and never
 * drops one. Pure.
 */
export function adaptParamsToExample(params, inputExample) {
  const none = { params, adapted: [] };
  const keys = inputExample?.keys;
  if (!params || typeof params !== "object" || Array.isArray(params) || !keys || typeof keys !== "object") return none;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const renames = [];
  for (const [one, many] of PAIRS) {
    const buyerOne = has(params, one), buyerMany = has(params, many);
    const exOne = has(keys, one), exMany = has(keys, many);
    // Both spellings on either side: not clear which the seller reads.
    if ((buyerOne && buyerMany) || (exOne && exMany)) { if (buyerOne || buyerMany) return none; continue; }
    if (buyerOne && !exOne && exMany && keys[many] === "list" && isScalar(params[one])) renames.push([one, many, "wrap"]);
    else if (buyerMany && !exMany && exOne && keys[one] === "scalar" && Array.isArray(params[many]) && params[many].length === 1 && isScalar(params[many][0])) renames.push([many, one, "unwrap"]);
  }
  if (!renames.length) return none;
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    const r = renames.find(([from]) => from === k);
    if (!r) { out[k] = v; continue; }
    out[r[1]] = r[2] === "wrap" ? [v] : v[0];
  }
  return { params: out, adapted: renames.map(([from, to]) => `${from}->${to}`) };
}

const examplesCache = new Map(); // origin -> { at, examples }
const EXAMPLES_TTL_MS = 60 * 60 * 1000;
const EXAMPLES_CACHE_MAX = 2000;

/** Fetch and parse `${origin}/llms.txt`, cached an hour per origin. `fetchText`
 *  is the guarded fetcher (src/tools/fetch-guard.js safeFetch shape: resolves
 *  to { html }). Never throws: any failure is an empty Map. */
export async function fetchLlmsExamples(origin, { fetchText, timeoutMs = 8000, now = Date.now() } = {}) {
  const hit = examplesCache.get(origin);
  if (hit && now - hit.at < EXAMPLES_TTL_MS) return hit.examples;
  let examples = new Map();
  try {
    const fetcher = fetchText || (await import("./tools/fetch-guard.js")).safeFetch;
    const { html } = await fetcher(`${origin}/llms.txt`, { maxBytes: LLMS_TXT_MAX_BYTES, headers: { Accept: "text/plain, text/markdown" }, timeoutMs });
    examples = parseLlmsExamples(String(html ?? ""));
  } catch { examples = new Map(); }
  if (examplesCache.size >= EXAMPLES_CACHE_MAX) examplesCache.delete(examplesCache.keys().next().value);
  examplesCache.set(origin, { at: now, examples });
  return examples;
}
export function __testResetLlmsExamples() { examplesCache.clear(); }
