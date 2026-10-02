// Resolve an operation's LOCAL references (`#/components/...`) against its own
// OpenAPI document, so the contract readers can see what a route requires.
//
// The contract readers (request-contract.js, response-contract.js) refuse any
// `$ref` and report "partial". That is right for composed schemas and for
// references to other documents, and wrong for the plain internal reference
// most frameworks emit for every body: FastAPI writes
// `{"$ref": "#/components/schemas/SearchReadInput"}` for each request and
// response model, so every FastAPI seller read "partial, nothing required"
// (reported 2026-09-25 by a seller whose `query` field is required).
//
// Only same-document JSON Pointers are followed. A reference that leaves the
// document, points nowhere, repeats itself (a cycle) or exceeds the depth or
// node budget is left as the original `$ref`, so the readers still refuse it
// and still say "partial". Names the pointer walks are checked against the
// prototype-reserved set before being read.

const MAX_DEPTH = 12;
const MAX_NODES = 20000;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function lookup(doc, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  let node = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (RESERVED.has(key) || !isRecord(node) || !Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/** A copy of `node` with local refs replaced by what they point at. */
export function resolveLocalRefs(node, doc, state = { nodes: 0 }, depth = 0, active = new Set()) {
  if (++state.nodes > MAX_NODES || depth > MAX_DEPTH) return node;
  if (Array.isArray(node)) return node.map((v) => resolveLocalRefs(v, doc, state, depth + 1, active));
  if (!isRecord(node)) return node;
  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    const target = active.has(ref) ? undefined : lookup(doc, ref);
    if (target === undefined) return node;               // external, missing or cyclic: leave it
    active.add(ref);
    const out = resolveLocalRefs(target, doc, state, depth + 1, active);
    active.delete(ref);
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (RESERVED.has(k)) continue;
    out[k] = resolveLocalRefs(v, doc, state, depth + 1, active);
  }
  return out;
}
