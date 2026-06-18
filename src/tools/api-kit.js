// API-kit — deterministic tools for working with API specs. No network, no
// LLM, no upstream — pure JSON-in / JSON-out, proof-of-work eligible. Covered
// by scripts/test-api-kit.js.
//
// Current:
//   openapi-diff   compare two OpenAPI / Swagger docs → added / removed /
//                  changed endpoints + a conservative "is this breaking?" flag.
//
// Scope notes for v1:
//   - Works against OpenAPI 3.x and Swagger 2.x (both share `paths`).
//   - `$ref` is NOT dereferenced — callers wanting full deref semantics should
//     resolve upstream first. The diff still catches the most common breaking
//     changes (added required field, type change, removed 2xx) without it.
//   - Breaking-change detection is conservative: it flags clear API contract
//     breaks (a caller that worked before will now fail) and ignores cosmetic
//     changes (description, summary, examples). False negatives are possible
//     for deeply nested schema changes — those need a schema-graph walker.

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

const parseMaybeJson = (v, label) => {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  if (typeof v !== "string") throw bad(`"${label}" must be an OpenAPI document (object or JSON string)`);
  try { return JSON.parse(v); } catch (e) { throw bad(`"${label}" is not valid JSON: ${e.message}`); }
};

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

// Flatten an OpenAPI doc into a Map keyed by "METHOD /path" so two specs can
// be compared by their concrete endpoints (not by structural shape). The
// path-item is carried alongside the operation so shared path-level parameters
// remain reachable during the per-endpoint diff.
function indexEndpoints(spec) {
  const out = new Map();
  const paths = spec && spec.paths;
  if (!paths || typeof paths !== "object") return out;
  for (const [p, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== "object") continue;
    for (const [m, op] of Object.entries(methods)) {
      if (!HTTP_METHODS.has(m.toLowerCase())) continue;
      out.set(`${m.toUpperCase()} ${p}`, { op, pathItem: methods });
    }
  }
  return out;
}

// A parameter is uniquely identified by location + name within an operation
// (the OpenAPI spec mandates that pair is unique). Using this key lets us
// detect adds/removes/required-flips without confusing a `query.id` with a
// `path.id`.
const paramKey = (p) => `${String(p.in || "").toLowerCase()}:${p.name}`;

// Merge path-item-level and operation-level parameters. Per OpenAPI rules,
// operation-level overrides path-level when (in, name) match.
function mergeParams(pathItem, op) {
  const map = new Map();
  for (const p of (pathItem && pathItem.parameters) || []) map.set(paramKey(p), p);
  for (const p of (op && op.parameters) || []) map.set(paramKey(p), p);
  return [...map.values()];
}

// Param type — `schema.type` in OpenAPI 3, top-level `type` in Swagger 2.
const paramType = (p) => (p && p.schema && p.schema.type) || (p && p.type) || null;

// Required body fields — only inspect application/json; other content types
// are out of scope for v1.
function jsonBodyRequired(op) {
  const schema = op && op.requestBody && op.requestBody.content && op.requestBody.content["application/json"] && op.requestBody.content["application/json"].schema;
  return Array.isArray(schema && schema.required) ? schema.required : [];
}

// Numeric response status codes only. `default` and `2XX`-style wildcards
// are ignored — they don't represent a concrete contract change.
function statusCodes(op) {
  return Object.keys((op && op.responses) || {}).filter((s) => /^\d+$/.test(s));
}

// Diff a single endpoint that exists in both specs. Returns a list of human
// readable change strings plus a `breaking` flag flipped on if any single
// change would cause a previously-working caller to fail.
function diffEndpoint(route, beforeEntry, afterEntry) {
  const changes = [];
  let breaking = false;

  const bParams = new Map(mergeParams(beforeEntry.pathItem, beforeEntry.op).map((p) => [paramKey(p), p]));
  const aParams = new Map(mergeParams(afterEntry.pathItem, afterEntry.op).map((p) => [paramKey(p), p]));

  // Added params: required = breaking, optional = note only.
  for (const [k, p] of aParams) {
    if (bParams.has(k)) continue;
    if (p.required) { changes.push(`added required ${p.in} param: ${p.name}`); breaking = true; }
    else changes.push(`added optional ${p.in} param: ${p.name}`);
  }
  // Removed params: removing a required one breaks callers that were sending
  // it (the route may have moved/renamed, or the field may now be derived).
  // Removing an optional one doesn't break anyone — they can just omit it.
  for (const [k, p] of bParams) {
    if (aParams.has(k)) continue;
    changes.push(`removed ${p.in} param: ${p.name}`);
    if (p.required) breaking = true;
  }
  // Required-flag transitions + type changes on params present in both.
  for (const [k, ap] of aParams) {
    const bp = bParams.get(k);
    if (!bp) continue;
    if (!bp.required && ap.required) { changes.push(`param '${ap.name}' became required`); breaking = true; }
    if (bp.required && !ap.required) changes.push(`param '${ap.name}' became optional`);
    const bt = paramType(bp), at = paramType(ap);
    if (bt && at && bt !== at) { changes.push(`param '${ap.name}' type changed: ${bt} → ${at}`); breaking = true; }
  }

  // Required JSON body fields. Adding to `required` breaks every existing
  // caller (their payload now misses a now-mandatory field).
  const bReq = new Set(jsonBodyRequired(beforeEntry.op));
  const aReq = new Set(jsonBodyRequired(afterEntry.op));
  for (const f of aReq) if (!bReq.has(f)) { changes.push(`body field '${f}' became required`); breaking = true; }
  for (const f of bReq) if (!aReq.has(f)) changes.push(`body field '${f}' became optional`);

  // Response status codes. Removing a 2xx is a contract break — any caller
  // who specifically branched on that status now sees something unexpected.
  // Removing a 4xx/5xx isn't breaking (callers just stop seeing it).
  const bStat = new Set(statusCodes(beforeEntry.op));
  const aStat = new Set(statusCodes(afterEntry.op));
  for (const s of bStat) if (!aStat.has(s)) {
    changes.push(`response status removed: ${s}`);
    if (s.startsWith("2")) breaking = true;
  }
  for (const s of aStat) if (!bStat.has(s)) changes.push(`response status added: ${s}`);

  return { route, changes, breaking };
}

export const API_TOOLS = [
  {
    route: "POST /api/openapi-diff", name: "OpenAPI / Swagger diff", slug: "openapi-diff", category: "conversion", price: "$0.002",
    description:
      "Compare two OpenAPI 3.x or Swagger 2.x documents and return a structured diff: added / removed / changed endpoints, with a conservative \"is any change breaking?\" flag. Breaking = an endpoint or required-2xx status was removed, a required parameter was added, an optional param became required, a param type changed, or a JSON body field became required. Pure CPU — deterministic, no network, no $ref dereferencing (resolve refs upstream if needed).",
    tags: ["openapi", "swagger", "diff", "breaking-change", "api"],
    discovery: {
      bodyType: "json",
      input: {
        before: {
          openapi: "3.0.0",
          paths: {
            "/users": { get: { responses: { "200": {} } } },
            "/legacy": { get: { responses: { "200": {} } } },
          },
        },
        after: {
          openapi: "3.0.0",
          paths: {
            "/users": { get: { responses: { "200": {} } } },
            "/admin": { post: { responses: { "201": {} } } },
          },
        },
      },
      inputSchema: {
        properties: {
          before: { description: "OpenAPI/Swagger document (object or JSON string) for the previous version" },
          after: { description: "OpenAPI/Swagger document (object or JSON string) for the new version" },
        },
        required: ["before", "after"],
      },
      output: {
        example: {
          added: ["POST /admin"],
          removed: ["GET /legacy"],
          changed: [],
          breaking: true,
          breakingCount: 1,
          summary: { added: 1, removed: 1, changed: 0 },
        },
      },
    },
    handler: (i) => {
      if (!("before" in i)) throw bad('Missing "before"');
      if (!("after" in i)) throw bad('Missing "after"');
      const before = parseMaybeJson(i.before, "before");
      const after = parseMaybeJson(i.after, "after");
      if (!before || typeof before !== "object") throw bad('"before" must be an OpenAPI document');
      if (!after || typeof after !== "object") throw bad('"after" must be an OpenAPI document');

      const bIdx = indexEndpoints(before);
      const aIdx = indexEndpoints(after);

      const added = [];
      const removed = [];
      const changed = [];
      let breakingCount = 0;

      // Added: routes in `after` but not `before`. Never breaking on its own.
      for (const route of aIdx.keys()) if (!bIdx.has(route)) added.push(route);

      // Removed: routes in `before` but not `after`. Always breaking.
      for (const route of bIdx.keys()) if (!aIdx.has(route)) {
        removed.push(route);
        breakingCount++;
      }

      // Present in both — diff the operation.
      for (const route of bIdx.keys()) {
        if (!aIdx.has(route)) continue;
        const d = diffEndpoint(route, bIdx.get(route), aIdx.get(route));
        if (d.changes.length) {
          changed.push(d);
          if (d.breaking) breakingCount++;
        }
      }

      // Sort for stable, deterministic output regardless of paths insertion
      // order in either input.
      added.sort();
      removed.sort();
      changed.sort((x, y) => x.route.localeCompare(y.route));

      return {
        added,
        removed,
        changed,
        breaking: breakingCount > 0,
        breakingCount,
        summary: { added: added.length, removed: removed.length, changed: changed.length },
      };
    },
  },
];
