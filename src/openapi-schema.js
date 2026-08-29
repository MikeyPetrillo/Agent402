// Typed 200 response schemas for /openapi.json, derived from each tool's own
// documented example.
//
// Every JSON tool used to declare `schema: { type: "object" }` with a rich
// `example` beside it. A human reads the example; a MACHINE reads the schema,
// and an untyped object promises nothing - an outside audit of
// /api/unemployment-rate on 2026-08-29 reported `properties_missing` +
// `required_fields_missing` and could not confirm the response carries the
// `current`, `history` and `source` fields our own example shows. That was a
// fair finding about all 560 routes, not one of them.
//
// `required` is a PROMISE, so it is only made where CI already keeps it: the
// catalog sweeps assert that every 200 carries its documented top-level keys
// (missingDocumentedKeys), with SHAPE_HAPPY_PATH_ONLY excusing the handful of
// tools whose shape legitimately varies with the outcome. Those declare typed
// properties and require nothing. Nested objects are typed but never required -
// only the top level is CI-enforced.

// Paths whose documented example is the HAPPY PATH and whose live shape varies
// (a lookup that finds nothing, a probe whose target behaves differently). The
// catalog sweeps skip the shape check here, so we must not promise `required`.
export const SHAPE_HAPPY_PATH_ONLY = new Set([
  "/api/x402-quote",   // example shows 402-detected case; placeholder URL may not 402
  "/api/x402-audit",   // example shows a graded 402; live target's grade/checks vary by seller
  "/api/tx-status",    // example shows success; 0x0…0 hash returns {status:"not_found"}
  "/api/x402-verify",  // example shows verified settlement; 0x0…0 hash returns {status:"not_found"}
  "/api/mev-block-payment", // example shows found=true; placeholder block 22000000 returns {found:false}
  "/api/x402-market-pulse", // example shows populated providers/categories; a cold test boot (crawler + leaderboard not warm) returns empty arrays
]);

const MAX_DEPTH = 4;      // deep enough for our shapes, shallow enough to bound the doc
const MAX_PROPS = 40;     // a wide map (per-chain totals, per-model rows) is data, not shape
const MAX_ARRAY_PROBE = 1; // items are homogeneous in every example we ship


const ARRAY_SAMPLE = 8; // enough to catch a mixed array, cheap to walk

/** Widest schema that BOTH inputs satisfy.
 *
 *  An array's element type cannot be read off element 0. A list of numbers can
 *  open with an integer, a list of records can carry a null where the first row
 *  had a string, and declaring the first element's type is a promise the rest
 *  of the array breaks - @x402/core validates the declaration against the
 *  example and rejected six routes outright when this merged nothing. `{}`
 *  (no constraint) is the honest answer whenever the samples disagree. */
function widen(a, b) {
  if (!a || !Object.keys(a).length) return {};
  if (!b || !Object.keys(b).length) return {};
  if (a.type !== b.type) {
    // integer and number are the same JSON type family: number covers both.
    if ((a.type === "integer" || a.type === "number") && (b.type === "integer" || b.type === "number")) return { type: "number" };
    return {};
  }
  if (a.type === "object") {
    if (!a.properties || !b.properties) return { type: "object" };
    const out = { type: "object", properties: {} };
    // Union, never intersection: a key absent from one sample still exists,
    // and nothing nested is ever declared required.
    for (const k of new Set([...Object.keys(a.properties), ...Object.keys(b.properties)])) {
      const av = a.properties[k], bv = b.properties[k];
      out.properties[k] = av && bv ? widen(av, bv) : (av || bv || {});
    }
    return out;
  }
  if (a.type === "array") {
    if (!a.items || !b.items) return { type: "array" };
    const items = widen(a.items, b.items);
    return Object.keys(items).length ? { type: "array", items } : { type: "array" };
  }
  return a;
}

/** JSON Schema for one example value. Types only: no enums, no formats, no
 *  constraints - anything we cannot guarantee at runtime is not declared. */
export function schemaFromExample(value, depth = 0) {
  if (value === null || value === undefined) return {}; // unconstrained: the example says nothing about the type
  if (Array.isArray(value)) {
    const schema = { type: "array" };
    if (value.length && depth < MAX_DEPTH) {
      let item = schemaFromExample(value[0], depth + 1);
      for (let i = 1; i < Math.min(value.length, ARRAY_SAMPLE); i++) item = widen(item, schemaFromExample(value[i], depth + 1));
      if (Object.keys(item).length) schema.items = item;
    }
    return schema;
  }
  const t = typeof value;
  if (t === "string") return { type: "string" };
  if (t === "boolean") return { type: "boolean" };
  if (t === "number") return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
  if (t !== "object") return {};
  const schema = { type: "object" };
  if (depth >= MAX_DEPTH) return schema;
  const keys = Object.keys(value).slice(0, MAX_PROPS);
  if (!keys.length) return schema;
  const properties = {};
  for (const k of keys) {
    const sub = schemaFromExample(value[k], depth + 1);
    properties[k] = Object.keys(sub).length ? sub : {};
  }
  schema.properties = properties;
  return schema;
}

function addRequiredForRoute(path, example, schema) {
  if (!path || SHAPE_HAPPY_PATH_ONLY.has(path)) return schema;
  if (!example || typeof example !== "object" || Array.isArray(example)) return schema;
  if (schema?.type !== "object" || !schema.properties) return schema;
  // Promise only fields that both survived the byte-bounded projection and
  // are covered by the catalog's response-shape sweep. Null examples still
  // say nothing about a value's type, so keep the OpenAPI rule here too.
  const required = Object.keys(schema.properties)
    .filter((k) => example[k] !== null && example[k] !== undefined);
  if (required.length) schema.required = required;
  return schema;
}

/** The 200 schema for a tool: typed properties from its example, and a
 *  `required` list only where the sweeps enforce it. */
export function responseSchemaFor(path, example) {
  if (!example || typeof example !== "object" || Array.isArray(example)) return { type: "object" };
  const schema = schemaFromExample(example);
  if (schema.type !== "object" || !schema.properties) return { type: "object" };
  return addRequiredForRoute(path, example, schema);
}

/** A typed schema for a tool's output that fits a byte budget.
 *
 *  The 402 challenge is echoed back by the buyer inside its payment payload, so
 *  bytes here are bytes on every buyer's request header (see
 *  scripts/test-challenge-size.js). A full schema is affordable on most routes
 *  and not on the widest ones, so this shallows the schema a level at a time
 *  and gives up rather than blow the budget: the complete typed schema always
 *  lives in /openapi.json, which the listing links.
 *
 *  Returns null when even a depth-1 schema does not fit. */
export function boundedSchemaFromExample(example, maxBytes = 1500) {
  if (!example || typeof example !== "object" || Array.isArray(example)) return null;
  return boundedResponseSchemaFor(null, example, maxBytes);
}

/** The challenge-side response schema. It uses the same route-aware required
 *  policy as /openapi.json, but keeps the 402's stricter byte budget. Arrays
 *  and scalar/raw outputs are schemas too: treating a speech response string
 *  as an object makes the official Bazaar validator reject the declaration. */
export function boundedResponseSchemaFor(path, example, maxBytes = 1500) {
  if (example === null || example === undefined) return null;
  for (let depth = MAX_DEPTH; depth >= 1; depth--) {
    const schema = addRequiredForRoute(path, example, schemaAtDepth(example, depth));
    if (!schema || !Object.keys(schema).length) return null;
    if (JSON.stringify(schema).length <= maxBytes) return schema;
  }
  return null;
}

/** schemaFromExample with a shallower ceiling than the default. Handles any
 *  JSON value because Bazaar output examples are not necessarily objects. */
function schemaAtDepth(value, limit, depth = 0) {
  if (value === null || value === undefined) return {};
  if (Array.isArray(value)) {
    const schema = { type: "array" };
    if (value.length && depth < limit) {
      let item = schemaAtDepth(value[0], limit, depth + 1);
      for (let i = 1; i < Math.min(value.length, ARRAY_SAMPLE); i++) item = widen(item, schemaAtDepth(value[i], limit, depth + 1));
      if (Object.keys(item).length) schema.items = item;
    }
    return schema;
  }
  const t = typeof value;
  if (t === "string") return { type: "string" };
  if (t === "boolean") return { type: "boolean" };
  if (t === "number") return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
  if (t !== "object") return {};
  const schema = { type: "object" };
  if (depth >= limit) return schema;
  const keys = Object.keys(value).slice(0, MAX_PROPS);
  if (!keys.length) return schema;
  const properties = {};
  for (const k of keys) {
    const sub = schemaAtDepth(value[k], limit, depth + 1);
    properties[k] = Object.keys(sub).length ? sub : {};
  }
  schema.properties = properties;
  return schema;
}
