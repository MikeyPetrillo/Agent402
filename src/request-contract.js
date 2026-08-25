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
export function safeName(n) {
  return typeof n === "string" && SAFE_NAME.test(n) ? n : null;
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
    }
  }

  const any = Object.keys(required).length > 0;
  const state = any ? (partial ? "partial" : "declared") : (partial ? "partial" : "absent");
  return { state, source: "seller_openapi", required, runtimeVerified: false };
}

/** Compact tuple for the crawl cache. `absent` and `unknown` store nothing:
 *  the projection reconstructs "unknown" from the missing row, which is the
 *  honest default for a row we have no evidence about. */
export function packRequestContract(c) {
  if (!c || c.state === "absent" || c.state === "unknown") return null;
  return [c.state, c.required];
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
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [state, required] = v;
  if (state !== "declared" && state !== "partial") return null;
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
  return { state, source: "seller_openapi", required: clean, runtimeVerified: false };
}

/** Spread into a public tool row, or nothing. */
export function requestContractProjection(t) {
  const c = unpackRequestContract(t);
  return c ? { requestContract: c } : {};
}
