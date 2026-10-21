// The seller's own published example request, used as the body of ONE unpaid
// quote probe to that seller's own route, and for nothing else.
//
// A POST route that validates its body before its paywall answers the bare
// `{}` probe (and the name-shaped placeholders of probeBodyFor) with a 400, so
// the 402 that names its price and chains is never read. The seller's own
// example request is the one body that route is documented to accept.
//
// PRIVATE BY CONSTRUCTION. request-contract.js projects the shape and never the
// sample, for every projection. This module is the one private use of a
// sample: the example is read from the seller's document during a crawl into a
// Map handed to the probe. It is never put on a tool row, the crawl cache, the
// persisted index, a log line, an API, page or MCP answer, or an agent's
// context.
//
// One copy outlives the crawl, in process memory only: ProbeExampleMemo below
// keeps the last crawl's examples per seller origin (not the documents), so a
// later crawl answered 304 for the OpenAPI, and a re-registration re-price,
// probe with the same body the first crawl did. It is a module-private
// instance in x402-index.js: no exported binding, no persist, snapshot, state
// DB or replica path reads it, and it is bounded in bytes and emptied for an
// origin that is removed. A process restart drops it.
//
// Bounded: a JSON object only (never an array or a scalar), at most
// MAX_EXAMPLE_BYTES serialized and MAX_EXAMPLE_DEPTH deep, no
// prototype-addressing key anywhere, at most MAX_EXAMPLES per seller. Anything
// outside the bounds is refused whole, never trimmed into something the seller
// did not write.

export const MAX_EXAMPLE_BYTES = 8 * 1024;
export const MAX_EXAMPLE_DEPTH = 6;
export const MAX_EXAMPLES = 500;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Depth counts containers: `{}` is depth 1, `{a:{}}` depth 2, `{a:[{}]}` depth 3.
function withinBounds(v, depth) {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "object") return false;
  if (depth > MAX_EXAMPLE_DEPTH) return false;
  if (Array.isArray(v)) return v.every((x) => withinBounds(x, depth + 1));
  // Own keys only, the reserved names refused wherever they sit. JSON.parse
  // makes "__proto__" an own key, so this sees it.
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k !== "string" || RESERVED.has(k)) return false;
    if (!withinBounds(v[k], depth + 1)) return false;
  }
  return true;
}

/** The probe body for a seller example: its JSON text when the value is an
 *  object inside every bound, else null. */
export function boundedProbeExample(value) {
  if (!isRecord(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  if (!withinBounds(value, 1)) return null;
  let text;
  try { text = JSON.stringify(value); } catch { return null; }
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_EXAMPLE_BYTES) return null;
  return text;
}

/** The example request a manifest catalogue entry publishes: its payment
 *  block's `exampleRequest`, else the entry's own `exampleRequest` or
 *  `example`. Bounded; null when none passes. */
export function manifestEntryExample(raw) {
  if (!isRecord(raw)) return null;
  const pay = isRecord(raw.payment) ? raw.payment : null;
  for (const v of [pay ? pay.exampleRequest : undefined, raw.exampleRequest, raw.example]) {
    const text = boundedProbeExample(v);
    if (text) return text;
  }
  return null;
}

// One local "#/..." reference, walked by own keys only, a few hops at most.
function deref(node, doc) {
  for (let hops = 0; hops < 4 && isRecord(node) && typeof node.$ref === "string"; hops++) {
    const ref = node.$ref;
    if (!ref.startsWith("#/")) return null;
    let cur = doc;
    for (const raw of ref.slice(2).split("/")) {
      const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (RESERVED.has(seg) || !isRecord(cur) || !Object.hasOwn(cur, seg)) return null;
      cur = cur[seg];
    }
    node = cur;
  }
  return isRecord(node) ? node : null;
}

/** The example request an OpenAPI operation publishes for a JSON body:
 *  `requestBody.content["application/json"].example`, else the first of its
 *  `examples[*].value`. Bounded; null when none passes. */
export function openapiOperationExample(op, doc) {
  if (!isRecord(op)) return null;
  const rb = deref(op.requestBody, doc);
  const content = rb && isRecord(rb.content) ? rb.content : null;
  const media = content && Object.hasOwn(content, "application/json") ? deref(content["application/json"], doc) : null;
  if (!media) return null;
  if (Object.hasOwn(media, "example")) {
    const text = boundedProbeExample(media.example);
    if (text) return text;
  }
  if (isRecord(media.examples)) {
    const first = Object.keys(media.examples)[0];
    const ex = first != null ? deref(media.examples[first], doc) : null;
    if (ex && Object.hasOwn(ex, "value")) return boundedProbeExample(ex.value);
  }
  return null;
}

/** The path a probe example is matched on: the route without its query and
 *  without trailing slashes (the root stays "/"). The index keys a merge by
 *  pathname (mergeManifestIntoTools), so a row from OpenAPI or a registry may
 *  carry a query string, or a slash, the manifest entry did not. */
export function probeExamplePath(route) {
  const p = String(route ?? "").split("?")[0].split("#")[0].replace(/\/+$/, "");
  return p || "/";
}

/** Record one example under its route. First writer wins, so a seller's own
 *  manifest (read first) is preferred over its OpenAPI. Keys are
 *  "<METHOD> <route>", plus "* <route>" for an entry that names no verb; each
 *  is recorded under the exact route and under its normalised path. */
export function noteProbeExample(map, method, route, text) {
  if (!(map instanceof Map) || !text || typeof route !== "string" || !route) return;
  const m = method ? String(method).toUpperCase() : "*";
  for (const k of new Set([`${m} ${route}`, `${m} ~${probeExamplePath(route)}`])) {
    if (map.size >= MAX_EXAMPLES) return;
    if (!map.has(k)) map.set(k, text);
  }
}

/** The example for a probe of `route` on `method`, or null: the exact route
 *  first, then the same path with any query string or trailing slash. */
export function probeExampleFor(map, method, route) {
  if (!(map instanceof Map) || !map.size) return null;
  const r = String(route || "");
  const m = String(method || "").toUpperCase();
  const p = `~${probeExamplePath(r)}`;
  return map.get(`${m} ${r}`) ?? map.get(`* ${r}`) ?? map.get(`${m} ${p}`) ?? map.get(`* ${p}`) ?? null;
}

/** Copy `from`'s entries into `into` where `into` has none (first writer
 *  wins), within MAX_EXAMPLES. Returns `into`. */
export function mergeProbeExamples(into, from) {
  if (!(into instanceof Map) || !(from instanceof Map)) return into;
  for (const [k, v] of from) {
    if (into.size >= MAX_EXAMPLES) break;
    if (!into.has(k)) into.set(k, v);
  }
  return into;
}

const mapBytes = (m) => {
  let n = 0;
  if (m instanceof Map) for (const [k, v] of m) n += Buffer.byteLength(k, "utf8") + Buffer.byteLength(v, "utf8");
  return n;
};

export const MEMO_MAX_BYTES = 8 * 1024 * 1024;
export const MEMO_MAX_ORIGIN_BYTES = 256 * 1024;

/**
 * The last crawl's examples per seller origin, in process memory only, split by
 * source: `manifest` (read from /.well-known/x402) and `openapi` (from
 * /openapi.json). Least recently written origin evicted first past
 * MEMO_MAX_BYTES; an origin whose examples exceed MEMO_MAX_ORIGIN_BYTES is not
 * kept. `onDrop(origin, part)` runs for each part that leaves (evicted or
 * refused), so the caller can make the next read of that document
 * unconditional: a 304 is then answered only while its examples are here.
 * Holds no document, no row and nothing else about the seller.
 */
export class ProbeExampleMemo {
  #byOrigin = new Map();
  #bytes = 0;
  #onDrop;
  #max;
  #maxOrigin;
  constructor({ onDrop = null, maxBytes = MEMO_MAX_BYTES, maxOriginBytes = MEMO_MAX_ORIGIN_BYTES } = {}) {
    this.#onDrop = typeof onDrop === "function" ? onDrop : null;
    this.#max = maxBytes;
    this.#maxOrigin = maxOriginBytes;
  }
  #drop(origin, e) {
    this.#byOrigin.delete(origin);
    this.#bytes -= e.bytes;
    if (this.#onDrop) for (const part of ["manifest", "openapi"]) if (e[part]) { try { this.#onDrop(origin, part); } catch { /* best-effort */ } }
  }
  /** Replace one source's examples for an origin (an empty or null Map
   *  clears it). Returns false when they were not kept (over the per-origin
   *  bound); onDrop has then run for that part. */
  set(origin, part, examples) {
    if (typeof origin !== "string" || (part !== "manifest" && part !== "openapi")) return false;
    const cur = this.#byOrigin.get(origin);
    const next = { manifest: cur?.manifest ?? null, openapi: cur?.openapi ?? null, bytes: 0 };
    next[part] = examples instanceof Map && examples.size ? new Map(examples) : null;
    next.bytes = mapBytes(next.manifest) + mapBytes(next.openapi);
    let kept = true;
    if (next.bytes > this.#maxOrigin) {
      next[part] = null;
      next.bytes = mapBytes(next.manifest) + mapBytes(next.openapi);
      kept = false;
      if (this.#onDrop) { try { this.#onDrop(origin, part); } catch { /* best-effort */ } }
    }
    if (cur) { this.#byOrigin.delete(origin); this.#bytes -= cur.bytes; }
    if (next.manifest || next.openapi) {
      this.#byOrigin.set(origin, next);
      this.#bytes += next.bytes;
    }
    for (const [o, e] of this.#byOrigin) {
      if (this.#bytes <= this.#max || o === origin) break;
      this.#drop(o, e);
    }
    return kept;
  }
  /** One source's examples for an origin, or null. */
  get(origin, part) { return this.#byOrigin.get(origin)?.[part] ?? null; }
  /** Both sources merged, manifest first, into a new Map. */
  merged(origin) {
    const e = this.#byOrigin.get(origin);
    const out = new Map();
    if (e) { mergeProbeExamples(out, e.manifest); mergeProbeExamples(out, e.openapi); }
    return out;
  }
  /** Forget every origin `match` accepts, with no onDrop (the origin is gone). */
  purge(match) {
    for (const [o, e] of [...this.#byOrigin]) if (match(o)) { this.#byOrigin.delete(o); this.#bytes -= e.bytes; }
  }
  /** Counts only, never content. */
  stats() { return { origins: this.#byOrigin.size, bytes: this.#bytes }; }
}
