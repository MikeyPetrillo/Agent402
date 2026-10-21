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
// Map that lives only in that crawl's stack frame, handed to the probe, and
// dropped. It is never put on a tool row, the crawl cache, the persisted index,
// a log line, an API, page or MCP answer, or an agent's context.
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

/** Record one example under its route. First writer wins, so a seller's own
 *  manifest (read first) is preferred over its OpenAPI. Keys are
 *  "<METHOD> <route>", plus "* <route>" for an entry that names no verb. */
export function noteProbeExample(map, method, route, text) {
  if (!(map instanceof Map) || !text || typeof route !== "string" || !route) return;
  if (map.size >= MAX_EXAMPLES) return;
  const k = `${method ? String(method).toUpperCase() : "*"} ${route}`;
  if (!map.has(k)) map.set(k, text);
}

/** The example for a probe of `route` on `method`, or null. */
export function probeExampleFor(map, method, route) {
  if (!(map instanceof Map) || !map.size) return null;
  const r = String(route || "");
  return map.get(`${String(method || "").toUpperCase()} ${r}`) ?? map.get(`* ${r}`) ?? null;
}
