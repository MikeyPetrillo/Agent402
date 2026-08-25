// What a seller's OpenAPI GUARANTEES about a paid route's response.
//
// A route can be discoverable, priced and payable while its declared contract
// does not promise the field a buyer actually needs. That is a buyer's problem
// before they spend, and we already hold the evidence: we crawl seller OpenAPI
// documents and throw this part away.
//
// This REPORTS. It never re-ranks, never gates payment, and never claims a
// response was delivered - every projection carries runtimeVerified:false,
// because a schema is a promise and we have not tested it.
//
// The conservative rule that makes the report worth anything: a path counts as
// guaranteed only when EVERY explicit 2xx variant guarantees it. A route whose
// 200 requires `data` and whose 201 does not, guarantees nothing - reporting
// `data` there would tell a buyer they are safe on a success path where they
// are not, which is worse than reporting nothing at all.

// We deliberately do NOT resolve $ref, and that decision buys two things. A
// composed schema is refused rather than half-understood, so we never report a
// guarantee we inferred from a fragment we did not read; and because an OpenAPI
// document reaches us through JSON.parse it is a tree, so with no ref
// resolution there is no cycle to defend against and no visited-set to get
// wrong. The bound is depth and breadth alone.
const UNSUPPORTED = new Set([
  "$ref", "$dynamicRef", "allOf", "anyOf", "oneOf", "not",
  "if", "then", "else", "dependentSchemas", "patternProperties", "unevaluatedProperties",
]);

const MAX_DEPTH = 8;         // deeper than any real payload nests
const MAX_PATHS = 64;        // a report, not a schema dump
const MAX_FIELD_CHARS = 128; // a field name, not a document
const MAX_VARIANTS = 8;      // explicit 2xx variants worth reading

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const typesOf = (schema) => {
  const t = schema?.type;
  return new Set(Array.isArray(t) ? t.map(String) : t === undefined ? [] : [String(t)]);
};

/** True when anything in this schema is a construct we refuse to interpret, or
 *  when the schema is too large for us to have read all of it.
 *
 *  This walks the raw OBJECT GRAPH, not schema nesting - one schema level costs
 *  at least two steps (`properties`, then the named child), plus a step per
 *  array element. So it must NOT share MAX_DEPTH with requiredPaths: doing that
 *  exhausted the budget at about four schema levels and refused ordinary
 *  documents, while the test that was supposed to prove the deep-schema bound
 *  passed for the wrong reason because it only ever asserted the refusal.
 *
 *  A node BUDGET is the right bound for a flat scan looking for forbidden keys.
 *  Exhausting it refuses the schema, on the same principle as everything else
 *  here: we do not report on a document we stopped reading. */
const MAX_SCAN_NODES = 20000;   // far beyond any real response schema
const MAX_SCAN_DEPTH = 64;      // a backstop; the node budget is the real bound

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

/** Dotted paths a schema REQUIRES, descending only into required objects.
 *
 *  Reports TRUNCATION rather than silently returning a short list. Hitting a
 *  cap means we stopped reading, and a caller that treats a truncated walk as a
 *  complete one publishes "these paths are guaranteed" about a document it only
 *  partly read - the same half-report this module refuses everywhere else.
 *  Truncation makes the variant inadmissible, exactly like a composed schema. */
function requiredPaths(schema, prefix = "", depth = 0, out = [], state = { truncated: false }) {
  if (!isRecord(schema)) return { paths: out, truncated: state.truncated };
  if (depth > MAX_DEPTH) { state.truncated = true; return { paths: out, truncated: true }; }
  const props = isRecord(schema.properties) ? schema.properties : {};
  for (const raw of Array.isArray(schema.required) ? schema.required : []) {
    if (out.length >= MAX_PATHS) { state.truncated = true; break; }
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name || name.length > MAX_FIELD_CHARS) continue;
    const child = props[name];
    if (!isRecord(child)) continue;          // required but undescribed: not a guarantee we can name
    const path = prefix ? `${prefix}.${name}` : name;
    out.push(path);
    if (typesOf(child).has("object")) requiredPaths(child, path, depth + 1, out, state);
  }
  return { paths: out, truncated: state.truncated };
}

/** The JSON schema of one response variant, or null. */
function jsonSchemaOf(variant) {
  const content = isRecord(variant?.content) ? variant.content : null;
  if (!content) return null;
  // Exact media type only. A seller writing `application/vnd.x+json` may well
  // return JSON, but guessing at media types is how a report starts asserting
  // things the document did not say.
  const entry = content["application/json"];
  return isRecord(entry?.schema) ? entry.schema : null;
}

/**
 * Report what a seller's OpenAPI operation guarantees on success.
 *
 * @returns {{state:"declared"|"partial"|"absent", source:"seller_openapi",
 *            successVariants:number, jsonSchemas:number,
 *            guaranteedPaths:string[], runtimeVerified:false}}
 */
export function responseContractOf(operation) {
  const empty = {
    state: "absent", source: "seller_openapi",
    successVariants: 0, jsonSchemas: 0, guaranteedPaths: [], runtimeVerified: false,
  };
  if (!isRecord(operation) || !isRecord(operation.responses)) return empty;

  // EXPLICIT 2xx only. `default` is a catch-all the seller wrote for everything
  // including errors; treating it as a success guarantee would manufacture one.
  // OpenAPI's `2XX` range is also an explicit success declaration. Ignoring it
  // would let a narrower numeric response speak for statuses the range covers.
  const allCodes = Object.keys(operation.responses)
    .filter((c) => /^(?:2\d\d|2XX)$/.test(c))
    .sort();
  const codes = allCodes.slice(0, MAX_VARIANTS);
  if (!codes.length) return empty;

  let jsonSchemas = 0;
  let intersection = null;
  // A capped walk is not complete evidence. Refuse guarantees exactly as the
  // depth and breadth bounds do, while retaining the seller's truthful count.
  let everyVariantAdmissible = allCodes.length <= MAX_VARIANTS;

  for (const code of codes) {
    const schema = jsonSchemaOf(operation.responses[code]);
    if (!schema || hasUnsupported(schema)) { everyVariantAdmissible = false; continue; }
    jsonSchemas++;
    const walk = requiredPaths(schema);
    if (walk.truncated) { everyVariantAdmissible = false; continue; }
    const paths = new Set(walk.paths);
    intersection = intersection === null ? paths : new Set([...intersection].filter((p) => paths.has(p)));
  }

  const guaranteedPaths = everyVariantAdmissible && intersection ? [...intersection].sort() : [];
  const state = jsonSchemas === 0 ? "absent"
    : everyVariantAdmissible && guaranteedPaths.length ? "declared"
    : "partial";
  return {
    state, source: "seller_openapi",
    successVariants: allCodes.length, jsonSchemas,
    guaranteedPaths, runtimeVerified: false,
  };
}

/** Compact tuple for the crawl cache. The public object repeats a constant
 *  source string and a constant false on every row; a cache holding tens of
 *  thousands of rows should not carry either. */
export function packResponseContract(c) {
  if (!c || c.state === "absent") return null;
  return [c.state, c.successVariants, c.jsonSchemas, c.guaranteedPaths];
}

/** Rehydrate for a public projection. Anything unrecognised reads as absent
 *  rather than throwing: a stale cache entry must not break a listing. */
export function unpackResponseContract(t) {
  const v = t?.responseContract;
  if (!Array.isArray(v) || v.length !== 4) return null;
  const [state, successVariants, jsonSchemas, guaranteedPaths] = v;
  if (state !== "declared" && state !== "partial") return null;
  return {
    state,
    source: "seller_openapi",
    successVariants: Number(successVariants) || 0,
    jsonSchemas: Number(jsonSchemas) || 0,
    guaranteedPaths: (Array.isArray(guaranteedPaths) ? guaranteedPaths : [])
      .filter((p) => typeof p === "string").slice(0, MAX_PATHS),
    runtimeVerified: false,
  };
}

/** Spread into a public tool row: `{ responseContract }` or nothing at all.
 *  One helper so the three surfaces cannot drift, and so a row is not
 *  rehydrated twice to answer "is there one?" and then "what is it?". */
export function responseContractProjection(t) {
  const c = unpackResponseContract(t);
  return c ? { responseContract: c } : {};
}
