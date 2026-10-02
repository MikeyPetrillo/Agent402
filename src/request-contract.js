// What a buyer must SEND to a paid route, from the seller's own OpenAPI.
//
// A route can be discoverable, priced and payable while a buyer still cannot
// construct the request. That was observed live as `missing_required_input` on
// an external x402 call: the index said "here is a payable endpoint" and the
// caller had no way to know what it wanted. We already crawl the document that
// answers it.
//
// Sibling of response-contract.js and deliberately the same vocabulary
// (declared / partial / absent / unknown), the same refusal of composed
// schemas, and the same runtimeVerified:false. Reporting only: it never
// re-ranks and never gates payment.

// WE REPORT THE SHAPE, NOT THE SAMPLE.
//
// A seller-authored example is friendlier and carries every risk in this file:
// people paste live API keys into their specs, examples contain personal data,
// and an example string is third-party text heading for an agent's context. The
// alternative is to detect secrets by signature and hope, which is a losing
// game against a corpus nobody controls.
//
// So no example VALUES are projected, ever. Names and locations are enough to
// construct a request, they are already public in the seller's document, and
// they are cheap to constrain: a legitimate parameter or JSON field name fits a
// tiny charset, so an allowlist bounds them structurally rather than by
// pattern-matching what an attacker chose to write.
const SAFE_NAME = /^[A-Za-z0-9_.\-\[\]]{1,64}$/;

const LOCATIONS = ["path", "query", "header", "cookie"];
const MAX_PER_LOCATION = 16;
const MAX_BODY_DEPTH = 6;
const UNSUPPORTED = new Set([
  "$ref", "$dynamicRef", "allOf", "anyOf", "oneOf", "not",
  "if", "then", "else", "dependentSchemas", "patternProperties", "unevaluatedProperties",
]);
const MAX_SCAN_NODES = 20000;
const MAX_SCAN_DEPTH = 64;

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const typesOf = (s) => new Set(Array.isArray(s?.type) ? s.type.map(String) : s?.type === undefined ? [] : [String(s.type)]);

/** A name we are willing to publish. Anything else is dropped rather than
 *  escaped or truncated: we are not obliged to relay every string a seller
 *  wrote, and a name that does not look like a name is not evidence. */
// Names that address an object's prototype rather than a property on it. The
// charset allowlist passes them, and a caller that walks these names into an
// object (probeBodyFor did) writes onto Object.prototype for the whole process.
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);
export function safeName(n) {
  return typeof n === "string" && SAFE_NAME.test(n) && !RESERVED_NAMES.has(n) ? n : null;
}

function hasUnsupported(node, state = { seen: 0 }, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) return true;
  if (++state.seen > MAX_SCAN_NODES) return true;
  if (Array.isArray(node)) return node.some((n) => hasUnsupported(n, state, depth + 1));
  if (!isRecord(node)) return false;
  for (const [k, v] of Object.entries(node)) {
    if (UNSUPPORTED.has(k)) return true;
    if (hasUnsupported(v, state, depth + 1)) return true;
  }
  return false;
}

/** Dotted paths a request body REQUIRES. Truncation is reported, never
 *  returned as a short list - the sibling module shipped that bug once. */
function requiredBodyPaths(schema, prefix = "", depth = 0, out = [], state = { truncated: false }) {
  if (!isRecord(schema)) return { paths: out, truncated: state.truncated };
  if (depth > MAX_BODY_DEPTH) { state.truncated = true; return { paths: out, truncated: true }; }
  const props = isRecord(schema.properties) ? schema.properties : {};
  for (const raw of Array.isArray(schema.required) ? schema.required : []) {
    if (out.length >= MAX_PER_LOCATION) { state.truncated = true; break; }
    const name = safeName(typeof raw === "string" ? raw.trim() : "");
    if (!name) continue;
    const child = props[name];
    const path = prefix ? `${prefix}.${name}` : name;
    out.push(path);
    if (isRecord(child) && typesOf(child).has("object")) requiredBodyPaths(child, path, depth + 1, out, state);
  }
  return { paths: out, truncated: state.truncated };
}

// Optional inputs a buyer MAY send, by location: query parameters and the
// JSON body's top-level properties. Kept beside the required names so a
// planner can fill a parameter the seller declared but did not require (a
// route whose inputs are all optional is not a route that takes no input).
const OPTIONAL_LOCATIONS = ["query", "body"];
function optionalBodyNames(schema, required) {
  const out = [];
  if (!isRecord(schema?.properties)) return out;
  for (const raw of Object.keys(schema.properties)) {
    const n = safeName(raw);
    if (!n || required.includes(raw)) continue;
    if (out.length >= MAX_PER_LOCATION) break;
    out.push(n);
  }
  return out;
}

/**
 * What this operation requires a buyer to send.
 *
 * @returns {{state:"declared"|"partial"|"absent"|"unknown", source:"seller_openapi",
 *            required:object, runtimeVerified:false}}
 */
export function requestContractOf(operation) {
  // UNKNOWN is not ABSENT. No operation to read means we never looked; an
  // operation we DID read that requires nothing is a real and useful answer
  // ("just call it"). Collapsing the two would tell a buyer a route needs no
  // input when the truth is that we have no idea.
  const unknown = { state: "unknown", source: "seller_openapi", required: {}, runtimeVerified: false };
  if (!isRecord(operation)) return unknown;
  const hasEvidence = Array.isArray(operation.parameters) || isRecord(operation.requestBody);
  if (!hasEvidence) return unknown;

  const required = {};
  let partial = false;

  for (const loc of LOCATIONS) {
    const names = [];
    for (const p of Array.isArray(operation.parameters) ? operation.parameters : []) {
      if (!isRecord(p) || p.required !== true || String(p.in) !== loc) continue;
      if (isRecord(p) && hasUnsupported(p)) { partial = true; continue; }
      const n = safeName(p.name);
      if (!n) { partial = true; continue; }   // a name we will not publish is evidence we did not relay
      if (names.length >= MAX_PER_LOCATION) { partial = true; break; }
      if (!names.includes(n)) names.push(n);
    }
    if (names.length) required[loc] = names;
  }
  const optional = {};
  {
    const names = [];
    for (const p of Array.isArray(operation.parameters) ? operation.parameters : []) {
      if (!isRecord(p) || p.required === true || String(p.in) !== "query") continue;
      const n = safeName(p.name);
      if (!n || names.includes(n) || names.length >= MAX_PER_LOCATION) continue;
      names.push(n);
    }
    if (names.length) optional.query = names;
  }

  const body = operation.requestBody;
  if (isRecord(body)) {
    // Exact media type only, same rule as the response side.
    const schema = isRecord(body.content?.["application/json"]?.schema)
      ? body.content["application/json"].schema : null;
    if (!schema) {
      // A body the seller declared but described in a form we do not read.
      if (body.required === true) partial = true;
    } else if (hasUnsupported(schema)) {
      partial = true;
    } else {
      const walk = requiredBodyPaths(schema);
      if (walk.truncated) partial = true;
      else if (walk.paths.length) required.body = walk.paths;
      const opt = optionalBodyNames(schema, Array.isArray(schema.required) ? schema.required : []);
      if (opt.length) optional.body = opt;
    }
  }

  const any = Object.keys(required).length > 0;
  const state = any ? (partial ? "partial" : "declared") : (partial ? "partial" : "absent");
  return { state, source: "seller_openapi", required, ...(Object.keys(optional).length ? { optional } : {}), runtimeVerified: false };
}

/**
 * The same contract, read from a JSON Schema a seller declares beside a route
 * in its /.well-known/x402 manifest (`input_schema` / `inputSchema`). The
 * manifest does not say where the fields go, so a GET/HEAD/DELETE route's
 * top-level required names are query parameters and any other verb's are the
 * JSON body (nested required objects walked, as on the OpenAPI side).
 */
function looksLikeJsonSchema(schema) {
  if (Array.isArray(schema.required)) return true;
  // A composed schema is still a schema; it reads as partial below.
  if (Object.keys(schema).some((k) => UNSUPPORTED.has(k))) return true;
  if (isRecord(schema.properties) && Object.values(schema.properties).every(isRecord)) return true;
  return typesOf(schema).has("object") && schema.properties === undefined;
}

export function requestContractFromInputSchema(schema, method = "POST") {
  const unknown = { state: "unknown", source: "seller_manifest", required: {}, runtimeVerified: false };
  if (!isRecord(schema)) return unknown;
  // Only a JSON Schema is evidence. A map of field names to prose (issue
  // #1503's first manifest) has no `required` list and would otherwise read
  // as "requires nothing", which is a claim the seller never made.
  if (!looksLikeJsonSchema(schema)) return unknown;
  if (hasUnsupported(schema)) return { state: "partial", source: "seller_manifest", required: {}, runtimeVerified: false };
  const required = {};
  let partial = false;
  const optionalNames = optionalBodyNames(schema, Array.isArray(schema.required) ? schema.required : []);
  const isQuery = ["GET", "HEAD", "DELETE"].includes(String(method).toUpperCase());
  const optional = optionalNames.length ? { [isQuery ? "query" : "body"]: optionalNames } : null;
  if (isQuery) {
    const names = [];
    for (const raw of Array.isArray(schema.required) ? schema.required : []) {
      const n = safeName(typeof raw === "string" ? raw.trim() : "");
      if (!n) { partial = true; continue; }
      if (names.length >= MAX_PER_LOCATION) { partial = true; break; }
      if (!names.includes(n)) names.push(n);
    }
    if (names.length) required.query = names;
  } else {
    const walk = requiredBodyPaths(schema);
    if (walk.truncated) partial = true;
    else if (walk.paths.length) required.body = walk.paths;
  }
  const any = Object.keys(required).length > 0;
  return { state: any ? (partial ? "partial" : "declared") : (partial ? "partial" : "absent"), source: "seller_manifest", required, ...(optional ? { optional } : {}), runtimeVerified: false };
}

const SOURCES = new Set(["seller_openapi", "seller_manifest"]);

/** Compact tuple for the crawl cache. `unknown` stores nothing, so a row with
 *  no tuple is one we have no evidence about. `absent` IS stored: a route the
 *  seller declared as needing no input is a different answer from a route the
 *  seller said nothing about, and a row without the field cannot tell them
 *  apart. */
export function packRequestContract(c) {
  if (!c || c.state === "unknown") return null;
  const required = c.state === "absent" ? {} : c.required;
  // A fourth element carries optional names (the source is then always
  // written). A third element names a source other than OpenAPI; two elements
  // stay the OpenAPI form every cache written before it holds.
  if (isRecord(c.optional) && Object.keys(c.optional).length) return [c.state, required, c.source || "seller_openapi", c.optional];
  return c.source && c.source !== "seller_openapi" ? [c.state, required, c.source] : [c.state, required];
}

export function unpackRequestContract(t) {
  let descriptor;
  try {
    descriptor = t && typeof t === "object"
      ? Object.getOwnPropertyDescriptor(t, "requestContract")
      : undefined;
  } catch {
    return null;
  }
  const v = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (!Array.isArray(v) || v.length < 2 || v.length > 4) return null;
  const [state, required] = v;
  const source = v.length >= 3 ? v[2] : "seller_openapi";
  if (!SOURCES.has(source)) return null;
  if (state !== "declared" && state !== "partial" && state !== "absent") return null;
  if (!isRecord(required)) return null;
  const clean = {};
  for (const loc of [...LOCATIONS, "body"]) {
    const names = Array.isArray(required[loc]) ? required[loc] : null;
    if (!names) continue;
    // Re-validate on the way OUT as well as in. A cache file is state we
    // persist and reload, and a value that was safe when written is not
    // self-evidently safe when read back by a later version of this code.
    const safe = names.map((n) => (loc === "body" ? (String(n).split(".").every((seg) => safeName(seg)) ? n : null) : safeName(n)))
      .filter(Boolean).slice(0, MAX_PER_LOCATION);
    if (safe.length) clean[loc] = safe;
  }
  // An absent contract carries no required names; one that arrives with them
  // is not what we wrote.
  if (state === "absent" && Object.keys(clean).length) return null;
  const optional = {};
  if (v.length === 4) {
    if (!isRecord(v[3])) return null;
    for (const loc of OPTIONAL_LOCATIONS) {
      const names = Array.isArray(v[3][loc]) ? v[3][loc] : null;
      if (!names) continue;
      const safe = names.map((n) => safeName(n)).filter((n) => n && !(clean[loc] || []).includes(n)).slice(0, MAX_PER_LOCATION);
      if (safe.length) optional[loc] = safe;
    }
  }
  return { state, source, required: clean, ...(Object.keys(optional).length ? { optional } : {}), runtimeVerified: false };
}

/** How much a stored tuple tells a buyer: 0 nothing, 1 "requires nothing",
 *  2 required names (or a declaration we could only partly read). A merge
 *  that fills gaps must not let a "requires nothing" block a list of names. */
export function requestContractStrength(t) {
  if (!Array.isArray(t)) return 0;
  // Optional names (a fourth element) are more to go on than none at the same state.
  const base = t[0] === "absent" ? 1 : (t[0] === "declared" || t[0] === "partial") ? 2 : 0;
  return base && t.length === 4 ? base + 0.5 : base;
}

/** Spread into a public tool row, or nothing. */
export function requestContractProjection(t) {
  const c = unpackRequestContract(t);
  return c ? { requestContract: c } : {};
}
