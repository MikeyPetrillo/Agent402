// API-kit — deterministic tools for working with API specs. No network, no
// LLM, no upstream — pure JSON-in / JSON-out, proof-of-work eligible. Covered
// by scripts/test-api-kit.js.
//
// Current:
//   openapi-diff   compare two OpenAPI / Swagger docs → added / removed /
//                  changed endpoints + a conservative "is this breaking?" flag.
//   openapi-lint   score a single spec on agent-readiness (does an LLM-driven
//                  caller have what it needs to call this API correctly?) and
//                  return a structured violations list + 0..100 score.
//   openapi-extract  flatten a spec into a structured endpoint list (method,
//                  path, params, response codes, JSON-body flag) plus per-
//                  method and per-tag counts — what an agent wants when
//                  picking what to call next without reading the full doc.
//   openapi-to-curl  build a runnable curl command for a single operation —
//                  locate by operationId or method+path, substitute path
//                  params + required query/header params from examples in
//                  the spec, attach a JSON body if the operation has one.
//   openapi-mock-response  synthesize a JSON response body for one operation
//                  and status code — operation-level example wins, then
//                  schema example, then a type-inferred recursive walk.
//                  Returns a `source` tag so callers know fidelity.
//   openapi-search  rank operations in a spec against a free-text query,
//                  weighted by which field matched (operationId/path >
//                  tags/summary > description). Lets an agent find the
//                  "user invite" flow in a 1000-endpoint spec without
//                  scanning extract output.
//   openapi-validate-payload  check a JSON payload against the request or
//                  response schema for one operation. Deterministic subset
//                  of JSON Schema: type / required / enum / properties /
//                  items / additionalProperties / oneOf|anyOf|allOf /
//                  $ref-detection. Reports `valid`, `schemaPresent` so
//                  callers can distinguish "passed" from "no contract".
//   openapi-redact  strip examples / descriptions / summaries / tags /
//                  externalDocs / deprecated from a spec to shrink it for
//                  LLM context. Walker protects user-defined property
//                  names under `properties` so models aren't damaged.
//                  Returns `sizeBefore` / `sizeAfter` + per-category counts.
//   openapi-resolve-refs  inline every local `$ref` (`#/components/...` for
//                  OpenAPI 3.x, `#/definitions/...` for Swagger 2.x) so
//                  downstream tools (diff / mock-response / validate-payload)
//                  see a self-contained document. Per-branch cycle detection
//                  leaves the `$ref` intact for circular schemas; external
//                  refs (http://, file://) are reported but not fetched.
//                  Sibling keys of `$ref` are dropped per JSON Schema Draft 7
//                  semantics. Returns `resolved` / `circular` / `unresolved`
//                  / `external` so callers know what was and wasn't inlined.
//   openapi-security-summary  resolve auth requirements across a spec:
//                  catalog of `securitySchemes` (OpenAPI 3) / `securityDefinitions`
//                  (Swagger 2), the document-level default, and per-operation
//                  effective security after layering. Honors the OpenAPI rule
//                  that `security: []` on an operation overrides the global
//                  default with "explicitly open" rather than inheriting.
//                  Output is sorted by route for deterministic diffs.
//   openapi-required-params  for one operation, return the minimum set of
//                  inputs needed to make a successful call: required path /
//                  query / header / cookie parameters AND top-level required
//                  fields of a required JSON request body. Flat array tagged
//                  by `in` so an agent can scan one list. Reuses
//                  locateOperation + mergeParams so behavior matches
//                  openapi-to-curl. Path params are always treated as
//                  required (per the OpenAPI spec, they MUST be).
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
//   - openapi-lint emits violations in deterministic spec-traversal order so
//     two runs against the same input produce byte-identical output.

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
  {
    route: "POST /api/openapi-lint", name: "OpenAPI agent-readiness lint", slug: "openapi-lint", category: "validation", price: "$0.002",
    description:
      "Score an OpenAPI 3.x or Swagger 2.x spec on agent-readiness — i.e. does an LLM-driven caller have what it needs to call the API correctly without guessing. Returns a 0..100 score, severity counts, and a structured list of violations with stable rule codes. Checks: documented title/servers/paths, per-operation summary/description/operationId/tags, documented 2xx + error responses, param descriptions/schemas/examples, response descriptions, JSON response schemas. Pure CPU — deterministic, no network, no $ref dereferencing.",
    tags: ["openapi", "swagger", "lint", "score", "agent-readiness", "validation"],
    discovery: {
      bodyType: "json",
      // A nearly-clean spec with one warning (missing operationId) — so the
      // example output is small and the score is high enough to demonstrate
      // a pass while still showing what a violation looks like.
      input: {
        spec: {
          openapi: "3.0.0",
          info: { title: "Demo", version: "1.0.0", description: "An example API" },
          servers: [{ url: "https://api.example.com" }],
          paths: {
            "/users": {
              get: {
                summary: "List users",
                tags: ["users"],
                parameters: [{ name: "limit", in: "query", description: "Max results", schema: { type: "integer", example: 10 } }],
                responses: {
                  "200": { description: "ok", content: { "application/json": { schema: { type: "array" } } } },
                  "400": { description: "bad input" },
                },
              },
            },
          },
        },
      },
      inputSchema: {
        properties: {
          spec: { description: "OpenAPI/Swagger document (object or JSON string)" },
        },
        required: ["spec"],
      },
      output: {
        example: {
          ok: true,
          score: 97,
          counts: { error: 0, warning: 1, info: 0 },
          violations: [
            {
              rule: "operation-missing-operationid",
              severity: "warning",
              location: "GET /users",
              message: "Operation has no operationId — agents can't refer to this call by a stable name.",
            },
          ],
        },
      },
    },
    handler: (i) => {
      if (!("spec" in i)) throw bad('Missing "spec"');
      const spec = parseMaybeJson(i.spec, "spec");
      if (!spec || typeof spec !== "object") throw bad('"spec" must be an OpenAPI document');

      const violations = [];
      const add = (rule, severity, location, message) =>
        violations.push({ rule, severity, location, message });

      // Info-level checks — applied once per document.
      if (!spec.info || typeof spec.info.title !== "string" || !spec.info.title.trim()) {
        add("info-missing-title", "warning", "info", "info.title is empty.");
      }
      if (!spec.info || typeof spec.info.description !== "string" || !spec.info.description.trim()) {
        add("info-missing-description", "info", "info", "info.description is empty.");
      }
      // Swagger 2.x uses `host` instead of `servers`. Accept either.
      const hasServer = (Array.isArray(spec.servers) && spec.servers.length > 0) || (typeof spec.host === "string" && spec.host.trim());
      if (!hasServer) {
        add("no-servers", "warning", "servers", "No servers documented — agents don't know where to call.");
      }

      const idx = indexEndpoints(spec);
      if (idx.size === 0) {
        add("no-paths", "error", "paths", "Spec has no operations.");
      }

      // Per-operation checks. Iteration order = path-insertion order in the
      // input doc, then method-insertion order. Deterministic for any one
      // input; that's the property the example round-trip depends on.
      for (const [route, entry] of idx) {
        const { op, pathItem } = entry;

        if (!op.summary && !op.description) {
          add("operation-missing-summary-or-description", "warning", route,
            "Operation has no summary or description — agents can't tell what it does.");
        }
        if (!op.operationId) {
          add("operation-missing-operationid", "warning", route,
            "Operation has no operationId — agents can't refer to this call by a stable name.");
        }
        if (!Array.isArray(op.tags) || op.tags.length === 0) {
          add("operation-missing-tags", "info", route,
            "Operation has no tags — agents can't browse by category.");
        }

        const responses = op.responses || {};
        const statuses = Object.keys(responses);
        const has2xx = statuses.some((s) => /^2\d\d$/.test(s));
        const hasErr = statuses.some((s) => /^[45]\d\d$/.test(s));
        if (!has2xx) {
          add("operation-missing-2xx-response", "error", route,
            "Operation documents no 2xx response — agents don't know what success looks like.");
        }
        if (has2xx && !hasErr) {
          add("operation-no-error-responses", "info", route,
            "Operation documents no 4xx/5xx response — agents won't know how errors are shaped.");
        }

        for (const p of mergeParams(pathItem, op)) {
          const ploc = `${route} param '${p.name}' (${p.in})`;
          if (typeof p.description !== "string" || !p.description.trim()) {
            add("param-missing-description", "warning", ploc, "Parameter has no description.");
          }
          // OpenAPI 3 uses `schema.type` (or schema.$ref / oneOf / anyOf / allOf);
          // Swagger 2 uses top-level `type`. Accept any of these as "typed".
          const schemaTyped = p.schema && (
            p.schema.type || p.schema.$ref || p.schema.oneOf || p.schema.anyOf || p.schema.allOf
          );
          if (!schemaTyped && !p.type) {
            add("param-missing-schema", "warning", ploc, "Parameter has no schema or type.");
          }
          const hasExample = (p.example !== undefined) || (p.schema && p.schema.example !== undefined);
          if (!hasExample) {
            add("param-missing-example", "info", ploc, "Parameter has no example.");
          }
        }

        for (const [status, r] of Object.entries(responses)) {
          const rloc = `${route} response ${status}`;
          if (!r || typeof r !== "object" || typeof r.description !== "string" || !r.description.trim()) {
            add("response-missing-description", "warning", rloc, "Response has no description.");
          }
          if (/^2\d\d$/.test(status) && r && r.content) {
            const jc = r.content["application/json"];
            if (jc && !jc.schema) {
              add("response-2xx-missing-schema", "info", rloc,
                "2xx JSON response has content but no schema — agents can't predict the body shape.");
            }
          }
        }
      }

      // Score: simple, monotonic, easy to reason about. Errors hurt a lot,
      // warnings moderately, info-level lightly. Clamped to [0, 100] so a
      // pathological spec doesn't return a negative score.
      const counts = { error: 0, warning: 0, info: 0 };
      for (const v of violations) counts[v.severity]++;
      const score = Math.max(0, 100 - counts.error * 10 - counts.warning * 3 - counts.info * 1);
      const ok = counts.error === 0;

      return { ok, score, counts, violations };
    },
  },
  {
    route: "POST /api/openapi-extract", name: "OpenAPI endpoint extractor", slug: "openapi-extract", category: "conversion", price: "$0.002",
    description:
      "Flatten an OpenAPI 3.x or Swagger 2.x spec into a structured list of callable endpoints — one row per operation with method, path, operationId, summary, tags, parameters (name / in / required / type), JSON-body flag, and documented response codes. Includes per-method and per-tag counts so an agent can pick what to call next without parsing the full spec. Output is sorted by path then method for stable, agent-friendly grouping. Pure CPU — deterministic, no network, no $ref dereferencing.",
    tags: ["openapi", "swagger", "extract", "endpoints", "api", "agent-readiness"],
    discovery: {
      bodyType: "json",
      input: {
        spec: {
          openapi: "3.0.0",
          paths: {
            "/users": {
              get: {
                operationId: "listUsers",
                summary: "List users",
                tags: ["users"],
                parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer" } }],
                responses: { "200": { description: "ok" }, "400": { description: "bad" } },
              },
            },
            "/users/{id}": {
              delete: {
                operationId: "deleteUser",
                summary: "Delete user",
                tags: ["users"],
                parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
                responses: { "204": { description: "gone" } },
              },
            },
          },
        },
      },
      inputSchema: {
        properties: {
          spec: { description: "OpenAPI/Swagger document (object or JSON string)" },
        },
        required: ["spec"],
      },
      output: {
        example: {
          endpoints: [
            {
              method: "GET", path: "/users", operationId: "listUsers", summary: "List users", tags: ["users"],
              params: [{ name: "limit", in: "query", required: false, type: "integer" }],
              hasJsonBody: false, responses: ["200", "400"],
            },
            {
              method: "DELETE", path: "/users/{id}", operationId: "deleteUser", summary: "Delete user", tags: ["users"],
              params: [{ name: "id", in: "path", required: true, type: "string" }],
              hasJsonBody: false, responses: ["204"],
            },
          ],
          stats: { total: 2, byMethod: { DELETE: 1, GET: 1 }, byTag: { users: 2 } },
        },
      },
    },
    handler: (i) => {
      if (!("spec" in i)) throw bad('Missing "spec"');
      const spec = parseMaybeJson(i.spec, "spec");
      if (!spec || typeof spec !== "object") throw bad('"spec" must be an OpenAPI document');

      const endpoints = [];
      const byMethod = {};
      const byTag = {};

      for (const [route, entry] of indexEndpoints(spec)) {
        const sp = route.indexOf(" ");
        const method = route.slice(0, sp);
        const path = route.slice(sp + 1);
        const { op, pathItem } = entry;

        const params = mergeParams(pathItem, op).map((p) => ({
          name: p.name,
          in: p.in,
          required: !!p.required,
          type: paramType(p),
        }));
        const hasJsonBody = !!(
          op.requestBody &&
          op.requestBody.content &&
          op.requestBody.content["application/json"]
        );
        // Sort response codes lexically — they're already string keys, and
        // numeric-ascending happens to match lexical for 3-digit HTTP codes.
        const responses = statusCodes(op).sort();
        const tags = Array.isArray(op.tags) ? op.tags.slice() : [];

        endpoints.push({
          method,
          path,
          operationId: op.operationId || null,
          // Prefer summary; fall back to description for a one-line agent hint.
          summary: op.summary || op.description || null,
          tags,
          params,
          hasJsonBody,
          responses,
        });

        byMethod[method] = (byMethod[method] || 0) + 1;
        for (const t of tags) byTag[t] = (byTag[t] || 0) + 1;
      }

      // Sort by path, then method. Grouping endpoints on the same path is
      // what an agent actually wants when scanning an API surface.
      endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

      // Alphabetically-sorted stats keys so two runs against the same input
      // produce byte-identical JSON (the round-trip property).
      const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

      return {
        endpoints,
        stats: {
          total: endpoints.length,
          byMethod: sortKeys(byMethod),
          byTag: sortKeys(byTag),
        },
      };
    },
  },
  {
    route: "POST /api/openapi-to-curl", name: "OpenAPI to curl command", slug: "openapi-to-curl", category: "conversion", price: "$0.002",
    description:
      "Build a runnable curl command for one operation in an OpenAPI 3.x or Swagger 2.x spec. Locate the operation by operationId (preferred) or by method + path, substitute path parameters using the spec's example values, include required query and header parameters with their example values, and attach a JSON body when the operation defines one. Returns the structured request (method, url, headers, body) alongside the assembled curl string with POSIX single-quote escaping. Pure CPU — deterministic, no network, no $ref dereferencing.",
    tags: ["openapi", "swagger", "curl", "client", "api", "agent-readiness"],
    discovery: {
      bodyType: "json",
      input: {
        spec: {
          openapi: "3.0.0",
          servers: [{ url: "https://api.example.com" }],
          paths: {
            "/users/{id}": {
              get: {
                operationId: "getUser",
                parameters: [
                  { name: "id", in: "path", required: true, schema: { type: "string", example: "u_42" } },
                  { name: "fields", in: "query", required: true, schema: { type: "string", example: "name,email" } },
                ],
                responses: { "200": { description: "ok" } },
              },
            },
          },
        },
        operationId: "getUser",
      },
      inputSchema: {
        properties: {
          spec: { description: "OpenAPI/Swagger document (object or JSON string)" },
          operationId: { description: "operationId of the operation to render (preferred)" },
          method: { description: "HTTP method (use with `path` if no operationId)" },
          path: { description: "Path template (use with `method` if no operationId)" },
        },
        required: ["spec"],
      },
      output: {
        example: {
          method: "GET",
          url: "https://api.example.com/users/u_42?fields=name%2Cemail",
          headers: {},
          body: null,
          curl: "curl -X GET 'https://api.example.com/users/u_42?fields=name%2Cemail'",
        },
      },
    },
    handler: (i) => {
      if (!("spec" in i)) throw bad('Missing "spec"');
      const spec = parseMaybeJson(i.spec, "spec");
      if (!spec || typeof spec !== "object") throw bad('"spec" must be an OpenAPI document');

      // Locate the operation. operationId wins if both forms are supplied —
      // it's the stable identifier and avoids ambiguity with case-sensitive
      // method strings.
      const located = locateOperation(spec, i);
      const { method, path: pathTemplate, op, pathItem } = located;

      // Base URL: OpenAPI 3 servers[0].url, else Swagger 2 scheme/host/basePath,
      // else a placeholder example.com so the curl is still pasteable.
      const baseUrl = getBaseUrl(spec);
      const allParams = mergeParams(pathItem, op);

      // Path: substitute every {name} with its example value (URL-encoded).
      let url = baseUrl + pathTemplate;
      for (const p of allParams.filter((q) => q.in === "path")) {
        url = url.replace(new RegExp(`\\{${p.name}\\}`, "g"), encodeURIComponent(String(paramExample(p))));
      }

      // Query string: required params only. Optional ones are deliberately
      // omitted — the goal is shortest-working-invocation.
      const qparams = allParams.filter((q) => q.in === "query" && q.required);
      if (qparams.length) {
        const qs = qparams
          .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(String(paramExample(p)))}`)
          .join("&");
        url += "?" + qs;
      }

      // Headers: required header params, then content-type if there's a body.
      const headers = {};
      for (const p of allParams.filter((q) => q.in === "header" && q.required)) {
        headers[p.name] = String(paramExample(p));
      }

      // Body: only inspect application/json for v1. Prefer the operation's
      // own example, then schema.example, then an empty object so callers
      // see the JSON-body affordance even when nothing else is documented.
      let body = null;
      const jc = op.requestBody && op.requestBody.content && op.requestBody.content["application/json"];
      if (jc) {
        headers["content-type"] = "application/json";
        if (jc.example !== undefined) body = jc.example;
        else if (jc.schema && jc.schema.example !== undefined) body = jc.schema.example;
        else body = {};
      }

      // Assemble curl. POSIX single-quote escaping: '\'' to embed a literal.
      const parts = [`curl -X ${method}`, shellQuote(url)];
      for (const [k, v] of Object.entries(headers)) {
        parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
      }
      if (body !== null) {
        parts.push(`-d ${shellQuote(JSON.stringify(body))}`);
      }
      const curl = parts.join(" ");

      return { method, url, headers, body, curl };
    },
  },
  {
    route: "POST /api/openapi-mock-response", name: "OpenAPI mock response generator", slug: "openapi-mock-response", category: "conversion", price: "$0.002",
    description:
      "Synthesize a JSON response body for one operation + status code in an OpenAPI 3.x or Swagger 2.x spec. Locate the operation by operationId or method+path. Pick the response by explicit `status`, else the first 2xx, else the first documented response. Generation precedence: operation-level `example`/`examples` > schema `example` > recursive type-inferred walk (objects walk properties, arrays return [mock(items)], enums return the first value, $ref is surfaced literally). Returns a `source` tag so callers know the mock's fidelity. Pure CPU — deterministic, no network, no $ref dereferencing.",
    tags: ["openapi", "swagger", "mock", "response", "api", "agent-readiness"],
    discovery: {
      bodyType: "json",
      input: {
        spec: {
          openapi: "3.0.0",
          paths: {
            "/users/{id}": {
              get: {
                operationId: "getUser",
                responses: {
                  "200": {
                    description: "ok",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            id: { type: "string", example: "u_42" },
                            name: { type: "string", example: "Alice" },
                            active: { type: "boolean", example: true },
                            roles: { type: "array", items: { type: "string", example: "admin" } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        operationId: "getUser",
      },
      inputSchema: {
        properties: {
          spec: { description: "OpenAPI/Swagger document (object or JSON string)" },
          operationId: { description: "operationId to mock (preferred)" },
          method: { description: "HTTP method (use with `path` if no operationId)" },
          path: { description: "Path template (use with `method` if no operationId)" },
          status: { description: "Response status to mock (defaults to first 2xx)" },
        },
        required: ["spec"],
      },
      output: {
        example: {
          status: "200",
          contentType: "application/json",
          mock: {
            id: "u_42",
            name: "Alice",
            active: true,
            roles: ["admin"],
          },
          source: "generated",
        },
      },
    },
    handler: (i) => {
      if (!("spec" in i)) throw bad('Missing "spec"');
      const spec = parseMaybeJson(i.spec, "spec");
      if (!spec || typeof spec !== "object") throw bad('"spec" must be an OpenAPI document');

      const { op } = locateOperation(spec, i);
      const { status, response } = pickResponse(op, i.status);

      // Only application/json is in scope for v1 — most APIs an LLM agent
      // calls are JSON, and other types (form-data, XML, octet-stream)
      // don't have a canonical mockable shape.
      const jc = response && response.content && response.content["application/json"];
      if (!jc) {
        return { status, contentType: "application/json", mock: null, source: "none" };
      }

      // Operation-level example wins (a hand-written example always beats a
      // type-inferred one). `examples` (multi-example map) is OpenAPI 3 —
      // pick the first deterministically.
      if (jc.example !== undefined) {
        return { status, contentType: "application/json", mock: jc.example, source: "operation-example" };
      }
      if (jc.examples && typeof jc.examples === "object") {
        const firstKey = Object.keys(jc.examples).sort()[0];
        if (firstKey && jc.examples[firstKey] && jc.examples[firstKey].value !== undefined) {
          return { status, contentType: "application/json", mock: jc.examples[firstKey].value, source: "operation-example" };
        }
      }
      // Schema-level example next.
      if (jc.schema && jc.schema.example !== undefined) {
        return { status, contentType: "application/json", mock: jc.schema.example, source: "schema-example" };
      }
      // Last resort: walk the schema. May produce empty {} for an opaque
      // object — that's a signal to the caller that the spec didn't
      // document its response shape well enough to mock.
      const mock = mockFromSchema(jc.schema);
      return { status, contentType: "application/json", mock, source: "generated" };
    },
  },
  {
    route: "POST /api/openapi-search", name: "OpenAPI operation search", slug: "openapi-search", category: "conversion", price: "$0.002",
    description:
      "Search operations in an OpenAPI 3.x or Swagger 2.x spec against a free-text query. Tokenizes the query (lowercase, alphanumeric runs), scores each operation by which fields the tokens match — operationId +3, path +3, tags +2, summary +2, description +1 per matched token — and returns ranked results with a `matches` array naming the contributing fields. Sort: score descending, then path ascending for stability. Limit defaults to 10 (max 100). Pure CPU — deterministic, no network, no $ref dereferencing.",
    tags: ["openapi", "swagger", "search", "ranking", "api", "agent-readiness"],
    discovery: {
      bodyType: "json",
      input: {
        spec: {
          paths: {
            "/users/{id}/avatar": { put: {
              operationId: "uploadUserAvatar", summary: "Upload user avatar", tags: ["users"],
              responses: { "200": {} } } },
            "/users/{id}": { get: {
              operationId: "getUser", summary: "Get a user", tags: ["users"],
              responses: { "200": {} } } },
            "/posts": { get: {
              operationId: "listPosts", summary: "List posts", tags: ["posts"],
              responses: { "200": {} } } },
          },
        },
        query: "user avatar",
      },
      inputSchema: {
        properties: {
          spec: { description: "OpenAPI/Swagger document (object or JSON string)" },
          query: { description: "Free-text search query (tokenized lowercase)" },
          limit: { description: "Maximum results to return (default 10, max 100)" },
        },
        required: ["spec", "query"],
      },
      output: {
        example: {
          total: 2,
          results: [
            {
              method: "PUT", path: "/users/{id}/avatar",
              operationId: "uploadUserAvatar", summary: "Upload user avatar",
              tags: ["users"], score: 18,
              matches: ["operationId", "path", "summary", "tags"],
            },
            {
              method: "GET", path: "/users/{id}",
              operationId: "getUser", summary: "Get a user",
              tags: ["users"], score: 10,
              matches: ["operationId", "path", "summary", "tags"],
            },
          ],
        },
      },
    },
    handler: (i) => {
      if (!("spec" in i)) throw bad('Missing "spec"');
      if (!("query" in i) || typeof i.query !== "string" || !i.query.trim()) {
        throw bad('"query" must be a non-empty string');
      }
      const spec = parseMaybeJson(i.spec, "spec");
      if (!spec || typeof spec !== "object") throw bad('"spec" must be an OpenAPI document');

      // Limit: default 10, clamp to [1, 100]. The cap exists so a pathological
      // request can't return all 1000 operations in one go.
      let limit = 10;
      if (i.limit !== undefined) {
        const n = Number(i.limit);
        if (!Number.isFinite(n) || n < 1) throw bad('"limit" must be a positive number');
        limit = Math.min(Math.floor(n), 100);
      }

      // Tokenize: lowercase, split on non-alphanumerics, drop empties.
      const tokens = i.query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      if (!tokens.length) throw bad('"query" yields no searchable tokens');

      // Per-field weights. operationId and path are stable identifiers, so
      // a hit there is the strongest signal of relevance.
      const FIELD_WEIGHTS = { operationId: 3, path: 3, tags: 2, summary: 2, description: 1 };

      const scored = [];
      for (const [route, entry] of indexEndpoints(spec)) {
        const sp = route.indexOf(" ");
        const method = route.slice(0, sp);
        const path = route.slice(sp + 1);
        const { op } = entry;

        const fields = {
          operationId: (op.operationId || "").toLowerCase(),
          path: path.toLowerCase(),
          tags: (Array.isArray(op.tags) ? op.tags.join(" ") : "").toLowerCase(),
          summary: (op.summary || "").toLowerCase(),
          description: (op.description || "").toLowerCase(),
        };

        let score = 0;
        const matched = new Set();
        for (const tok of tokens) {
          for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
            if (fields[field] && fields[field].includes(tok)) {
              score += weight;
              matched.add(field);
            }
          }
        }
        if (score > 0) {
          scored.push({
            method,
            path,
            operationId: op.operationId || null,
            summary: op.summary || op.description || null,
            tags: Array.isArray(op.tags) ? op.tags.slice() : [],
            score,
            matches: [...matched].sort(),
          });
        }
      }

      // Sort by score desc, then path asc for deterministic tiebreaks.
      scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

      return {
        total: scored.length,
        results: scored.slice(0, limit),
      };
    },
  },
  {
    route: "POST /api/openapi-validate-payload", name: "OpenAPI payload validator", slug: "openapi-validate-payload", category: "validation", price: "$0.002",
    description:
      "Validate a JSON payload against the request or response schema for one operation in an OpenAPI 3.x or Swagger 2.x spec. Locate the operation by operationId or method+path; choose `part: \"request\"` or `part: \"response\"` (status defaults to the first 2xx). Deterministic subset of JSON Schema: type, required, enum, properties, items, additionalProperties:false, oneOf/anyOf/allOf, $ref-detection (not dereferenced). Returns `valid`, `schemaPresent` (false → no contract to check; result is vacuously valid), and ordered `errors[]` with stable rule codes. Pure CPU — deterministic, no network.",
    tags: ["openapi", "swagger", "validation", "json-schema", "api", "agent-readiness"],
    discovery: {
      bodyType: "json",
      input: {
        spec: {
          openapi: "3.0.0",
          paths: {
            "/users": {
              post: {
                operationId: "createUser",
                requestBody: { content: { "application/json": { schema: {
                  type: "object",
                  required: ["name", "email"],
                  properties: {
                    name: { type: "string" },
                    email: { type: "string" },
                    age: { type: "integer" },
                    role: { type: "string", enum: ["admin", "user"] },
                  },
                  additionalProperties: false,
                } } } },
                responses: { "201": { description: "ok" } },
              },
            },
          },
        },
        operationId: "createUser",
        part: "request",
        payload: { name: "Alice", age: "thirty", extra: "noise" },
      },
      inputSchema: {
        properties: {
          spec: { description: "OpenAPI/Swagger document (object or JSON string)" },
          operationId: { description: "operationId to validate against (preferred)" },
          method: { description: "HTTP method (use with `path` if no operationId)" },
          path: { description: "Path template (use with `method` if no operationId)" },
          part: { description: "Schema to validate against: \"request\" or \"response\"" },
          status: { description: "Response status when part=\"response\" (defaults to first 2xx)" },
          payload: { description: "JSON value to validate" },
        },
        required: ["spec", "part", "payload"],
      },
      output: {
        example: {
          valid: false,
          schemaPresent: true,
          errors: [
            { path: "", rule: "required", message: "missing required field: email" },
            { path: ".age", rule: "type", message: "expected integer, got string" },
            { path: ".extra", rule: "additionalProperties", message: "unexpected property: extra" },
          ],
        },
      },
    },
    handler: (i) => {
      if (!("spec" in i)) throw bad('Missing "spec"');
      if (!("part" in i)) throw bad('Missing "part" (must be "request" or "response")');
      if (!("payload" in i)) throw bad('Missing "payload"');
      const spec = parseMaybeJson(i.spec, "spec");
      if (!spec || typeof spec !== "object") throw bad('"spec" must be an OpenAPI document');

      const { op } = locateOperation(spec, i);
      const { schema } = locateSchemaForPart(op, i.part, i.status);

      // No schema documented for this part → vacuously valid, but mark
      // schemaPresent:false so the caller knows nothing was actually checked.
      if (!schema) {
        return { valid: true, schemaPresent: false, errors: [] };
      }

      const errors = [];
      validatePayload(schema, i.payload, "", errors);
      return { valid: errors.length === 0, schemaPresent: true, errors };
    },
  },
  {
    route: "POST /api/openapi-redact", name: "OpenAPI spec redactor", slug: "openapi-redact", category: "conversion", price: "$0.002",
    description:
      "Shrink an OpenAPI 3.x or Swagger 2.x document for LLM context by stripping verbose meta-fields (examples, descriptions, summaries, tags, externalDocs, deprecated). Categories are explicit; default is `[\"examples\", \"descriptions\"]`. User-defined property names under `properties: { ... }` are protected — only the meta-field `example` keyword inside a property schema is removed, not a user property literally named \"example\". Returns the redacted spec plus `sizeBefore`/`sizeAfter` (JSON byte length) and per-category removal counts so callers can see how much context they saved. Pure CPU — deterministic, no network.",
    tags: ["openapi", "swagger", "redact", "shrink", "llm-context", "api"],
    discovery: {
      bodyType: "json",
      input: {
        spec: {
          openapi: "3.0.0",
          info: { title: "Demo", version: "1.0.0", description: "An example API" },
          paths: { "/users": { get: {
            summary: "List users",
            description: "Returns all users.",
            parameters: [{ name: "limit", in: "query", description: "Max results", schema: { type: "integer", example: 10 } }],
            responses: { "200": { description: "ok" } },
          } } },
        },
        strip: ["examples", "descriptions"],
      },
      inputSchema: {
        properties: {
          spec: { description: "OpenAPI/Swagger document (object or JSON string)" },
          strip: { description: "Categories to remove. Valid: examples, descriptions, summaries, tags, externalDocs, deprecated. Defaults to [\"examples\", \"descriptions\"]." },
        },
        required: ["spec"],
      },
      output: {
        example: {
          spec: {
            openapi: "3.0.0",
            info: { title: "Demo", version: "1.0.0" },
            paths: { "/users": { get: {
              summary: "List users",
              parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
              responses: { "200": {} },
            } } },
          },
          sizeBefore: 334,
          sizeAfter: 209,
          removed: { examples: 1, descriptions: 4 },
        },
      },
    },
    handler: (i) => {
      if (!("spec" in i)) throw bad('Missing "spec"');
      const spec = parseMaybeJson(i.spec, "spec");
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        throw bad('"spec" must be an OpenAPI document');
      }
      const stripList = Array.isArray(i.strip) ? i.strip : ["examples", "descriptions"];
      const stripMap = buildStripMap(stripList);
      const removed = Object.fromEntries(stripList.map((s) => [s, 0]));
      const sizeBefore = JSON.stringify(spec).length;
      const redacted = deepRedact(spec, stripMap, removed, null);
      const sizeAfter = JSON.stringify(redacted).length;
      return { spec: redacted, sizeBefore, sizeAfter, removed };
    },
  },
  {
    route: "POST /api/openapi-resolve-refs", name: "OpenAPI $ref resolver", slug: "openapi-resolve-refs", category: "conversion", price: "$0.002",
    description:
      "Inline every local `$ref` in an OpenAPI 3.x or Swagger 2.x document so downstream tools see a self-contained spec. Resolves `#/components/...` (OpenAPI) and `#/definitions/...` (Swagger) JSON-pointer refs anywhere in the document, including inside components themselves. Per-branch cycle detection: if A→B→A, the second A is left as a `$ref` and recorded under `circular`. External refs (http://, file://, ./other.yaml) are never fetched — they're reported under `external` and left as-is. Sibling keys of `$ref` (e.g. a `description` next to a `$ref`) are dropped to match JSON Schema Draft 7 / OpenAPI 3.0 semantics. Returns the dereffed spec plus `resolved` (count inlined) and arrays of any refs that couldn't be inlined. Pure CPU — deterministic, no network.",
    tags: ["openapi", "swagger", "ref", "dereference", "resolve", "api"],
    discovery: {
      bodyType: "json",
      input: {
        spec: {
          openapi: "3.0.0",
          info: { title: "Demo", version: "1.0.0" },
          paths: {
            "/users/{id}": {
              get: {
                parameters: [{ $ref: "#/components/parameters/UserId" }],
                responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } } },
              },
            },
          },
          components: {
            schemas: { User: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } },
            parameters: { UserId: { name: "id", in: "path", required: true, schema: { type: "string" } } },
          },
        },
      },
      inputSchema: {
        properties: {
          spec: { description: "OpenAPI/Swagger document (object or JSON string)" },
        },
        required: ["spec"],
      },
      output: {
        example: {
          spec: {
            openapi: "3.0.0",
            info: { title: "Demo", version: "1.0.0" },
            paths: {
              "/users/{id}": {
                get: {
                  parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
                  responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } } } } },
                },
              },
            },
            components: {
              schemas: { User: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } },
              parameters: { UserId: { name: "id", in: "path", required: true, schema: { type: "string" } } },
            },
          },
          resolved: 2,
          circular: [],
          unresolved: [],
          external: [],
        },
      },
    },
    handler: (i) => {
      if (!("spec" in i)) throw bad('Missing "spec"');
      const spec = parseMaybeJson(i.spec, "spec");
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        throw bad('"spec" must be an OpenAPI document');
      }
      const report = { resolved: 0, circular: [], unresolved: [], external: [] };
      const resolved = deepResolveRefs(spec, spec, new Set(), report);
      return { spec: resolved, resolved: report.resolved, circular: report.circular, unresolved: report.unresolved, external: report.external };
    },
  },
  {
    route: "POST /api/openapi-security-summary", name: "OpenAPI security summary", slug: "openapi-security-summary", category: "conversion", price: "$0.002",
    description:
      "Resolve authentication requirements across an OpenAPI 3.x or Swagger 2.x document. Returns the catalog of security schemes (`components.securitySchemes` in OpenAPI 3, `securityDefinitions` in Swagger 2) verbatim, the document-level default, and the *effective* security for each operation after layering. Honors the OpenAPI rule that `security: []` on an operation overrides the global default with \"explicitly open\" rather than inheriting it — so an agent sees `open: true` for that op and won't try to attach a token. Includes a `schemeUsage` count so callers know which scheme is actually needed. Operations are sorted `METHOD /path` for deterministic output. Pure CPU — deterministic, no network.",
    tags: ["openapi", "swagger", "security", "auth", "api"],
    discovery: {
      bodyType: "json",
      input: {
        spec: {
          openapi: "3.0.0",
          info: { title: "Demo", version: "1.0.0" },
          security: [{ bearerAuth: [] }],
          paths: {
            "/users": { get: { responses: { "200": {} } } },
            "/public": { get: { security: [], responses: { "200": {} } } },
            "/admin": { post: { security: [{ bearerAuth: ["admin"] }], responses: { "201": {} } } },
          },
          components: {
            securitySchemes: {
              bearerAuth: { type: "http", scheme: "bearer" },
            },
          },
        },
      },
      inputSchema: {
        properties: {
          spec: { description: "OpenAPI/Swagger document (object or JSON string)" },
        },
        required: ["spec"],
      },
      output: {
        example: {
          schemes: { bearerAuth: { type: "http", scheme: "bearer" } },
          globalSecurity: [{ bearerAuth: [] }],
          operations: [
            { method: "GET", path: "/public", security: [], open: true },
            { method: "GET", path: "/users", security: [{ bearerAuth: [] }], open: false },
            { method: "POST", path: "/admin", security: [{ bearerAuth: ["admin"] }], open: false },
          ],
          summary: {
            schemes: 1,
            operations: 3,
            openOperations: 1,
            securedOperations: 2,
            schemeUsage: { bearerAuth: 2 },
          },
        },
      },
    },
    handler: (i) => {
      if (!("spec" in i)) throw bad('Missing "spec"');
      const spec = parseMaybeJson(i.spec, "spec");
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        throw bad('"spec" must be an OpenAPI document');
      }
      const schemes = collectSecuritySchemes(spec);
      const globalSecurity = Array.isArray(spec.security) ? spec.security : [];
      const operations = [];
      const schemeUsage = Object.fromEntries(Object.keys(schemes).map((k) => [k, 0]));
      let openOperations = 0;
      let securedOperations = 0;

      // Index endpoints so we get a uniform per-op iteration that respects
      // path-item-level operations only (path-level parameters and shared
      // fields don't apply to security per the OpenAPI 3 spec).
      for (const [route, { op }] of indexEndpoints(spec)) {
        const [method, path] = route.split(" ");
        const effective = effectiveSecurity(op, globalSecurity);
        const open = effective.length === 0;
        const entry = { method, path };
        if (typeof op.operationId === "string") entry.operationId = op.operationId;
        entry.security = effective;
        entry.open = open;
        operations.push(entry);
        if (open) openOperations++;
        else {
          securedOperations++;
          // Count each scheme referenced in any requirement of this op once
          // per op (multiple requirements naming the same scheme don't
          // inflate the count — usage = "how many ops need this scheme").
          const seen = new Set();
          for (const req of effective) {
            for (const name of Object.keys(req)) {
              if (seen.has(name)) continue;
              seen.add(name);
              if (name in schemeUsage) schemeUsage[name]++;
            }
          }
        }
      }

      operations.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));

      return {
        schemes,
        globalSecurity,
        operations,
        summary: {
          schemes: Object.keys(schemes).length,
          operations: operations.length,
          openOperations,
          securedOperations,
          schemeUsage,
        },
      };
    },
  },
  {
    route: "POST /api/openapi-required-params", name: "OpenAPI required-params extractor", slug: "openapi-required-params", category: "conversion", price: "$0.002",
    description:
      "For one operation, return the minimum set of inputs an agent must provide to make a successful call. Locate the op by `operationId` (preferred) or by `method`+`path`. Output is a single flat array tagged by `in`: `path` (always required), `query` / `header` / `cookie` (only when `required: true`), and `body.field` entries naming the top-level required fields of a required JSON request body. `hasBody` and `bodyContentType` are included separately so callers can decide whether to serialize a payload at all. Merges path-item-level shared parameters with operation-level ones (operation wins on collision), matching openapi-to-curl behavior. Does NOT recurse into nested object schemas — top-level required fields only. Pure CPU.",
    tags: ["openapi", "swagger", "required", "params", "api"],
    discovery: {
      bodyType: "json",
      input: {
        spec: {
          openapi: "3.0.0",
          paths: {
            "/users/{id}": {
              get: {
                operationId: "getUser",
                parameters: [
                  { name: "id", in: "path", required: true, schema: { type: "string" } },
                  { name: "verbose", in: "query", required: false, schema: { type: "boolean" } },
                  { name: "X-Trace-Id", in: "header", required: true, schema: { type: "string" } },
                ],
                responses: { "200": {} },
              },
            },
            "/users": {
              post: {
                operationId: "createUser",
                requestBody: { required: true, content: { "application/json": { schema: {
                  type: "object",
                  required: ["email", "password"],
                  properties: {
                    email: { type: "string" },
                    password: { type: "string" },
                    nickname: { type: "string" },
                  },
                } } } },
                responses: { "201": {} },
              },
            },
          },
        },
        operationId: "createUser",
      },
      inputSchema: {
        properties: {
          spec: { description: "OpenAPI/Swagger document (object or JSON string)" },
          operationId: { description: "Locate by operationId (preferred)" },
          method: { description: "If no operationId, HTTP method (e.g. GET)" },
          path: { description: "If no operationId, exact path (e.g. /users/{id})" },
        },
        required: ["spec"],
      },
      output: {
        example: {
          method: "POST",
          path: "/users",
          operationId: "createUser",
          required: [
            { in: "body.field", name: "email", type: "string" },
            { in: "body.field", name: "password", type: "string" },
          ],
          hasBody: true,
          bodyContentType: "application/json",
        },
      },
    },
    handler: (i) => {
      if (!("spec" in i)) throw bad('Missing "spec"');
      const spec = parseMaybeJson(i.spec, "spec");
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        throw bad('"spec" must be an OpenAPI document');
      }
      const located = locateOperation(spec, {
        operationId: i.operationId,
        method: i.method,
        path: i.path,
      });
      const params = mergeParams(located.pathItem, located.op);
      const required = [];

      // Sort parameters by location bucket so output ordering is stable
      // regardless of how the spec listed them. Within a bucket, sort by name.
      const bucketRank = { path: 0, query: 1, header: 2, cookie: 3 };
      const sortedParams = [...params].sort((a, b) => {
        const ra = bucketRank[String(a.in).toLowerCase()] ?? 99;
        const rb = bucketRank[String(b.in).toLowerCase()] ?? 99;
        if (ra !== rb) return ra - rb;
        return String(a.name).localeCompare(String(b.name));
      });

      for (const p of sortedParams) {
        const where = String(p.in || "").toLowerCase();
        // Path params are always required per the OpenAPI spec — we treat
        // them as required regardless of whether `required: true` was set
        // (spec compliance, not lenience).
        const isRequired = where === "path" ? true : p.required === true;
        if (!isRequired) continue;
        const entry = { in: where, name: p.name };
        const t = paramType(p);
        if (t) entry.type = t;
        required.push(entry);
      }

      // Body — only flag as required if `requestBody.required === true`. We
      // surface the chosen content type (preferring application/json, falling
      // back to the first one declared) so callers know how to serialize.
      let hasBody = false;
      let bodyContentType = null;
      const rb = located.op.requestBody;
      if (rb && typeof rb === "object") {
        const bodyRequired = rb.required === true;
        const contents = (rb.content && typeof rb.content === "object") ? rb.content : null;
        if (contents) {
          if (contents["application/json"]) bodyContentType = "application/json";
          else bodyContentType = Object.keys(contents)[0] || null;
        }
        if (bodyRequired) {
          hasBody = true;
          if (bodyContentType && contents[bodyContentType] && contents[bodyContentType].schema) {
            const schema = contents[bodyContentType].schema;
            const fieldReq = Array.isArray(schema.required) ? schema.required : [];
            const props = (schema.properties && typeof schema.properties === "object") ? schema.properties : {};
            for (const name of fieldReq) {
              const entry = { in: "body.field", name };
              const fieldSchema = props[name];
              if (fieldSchema && typeof fieldSchema === "object" && typeof fieldSchema.type === "string") {
                entry.type = fieldSchema.type;
              }
              required.push(entry);
            }
          }
        } else if (contents) {
          // Body is OPTIONAL but the content type is still useful context
          // for callers planning to send one.
          hasBody = false;
        }
      }

      const out = { method: located.method, path: located.path };
      if (typeof located.op.operationId === "string") out.operationId = located.op.operationId;
      out.required = required;
      out.hasBody = hasBody;
      out.bodyContentType = bodyContentType;
      return out;
    },
  },
];

// ---- openapi-to-curl helpers (kept below API_TOOLS for readability since
// the diff/lint/extract tools don't use them) ----

// Locate an operation by operationId (preferred) or method+path.
function locateOperation(spec, locator) {
  const paths = (spec && spec.paths) || {};
  if (locator.operationId) {
    for (const [p, methods] of Object.entries(paths)) {
      if (!methods || typeof methods !== "object") continue;
      for (const [m, op] of Object.entries(methods)) {
        if (!HTTP_METHODS.has(m.toLowerCase())) continue;
        if (op && op.operationId === locator.operationId) {
          return { method: m.toUpperCase(), path: p, op, pathItem: methods };
        }
      }
    }
    throw bad(`operationId "${locator.operationId}" not found in spec`);
  }
  if (locator.method && locator.path) {
    const m = String(locator.method).toLowerCase();
    if (!HTTP_METHODS.has(m)) throw bad(`unsupported method: ${locator.method}`);
    const pi = paths[locator.path];
    if (!pi || !pi[m]) throw bad(`${String(locator.method).toUpperCase()} ${locator.path} not found in spec`);
    return { method: m.toUpperCase(), path: locator.path, op: pi[m], pathItem: pi };
  }
  throw bad('provide either "operationId" or both "method" and "path"');
}

// Compute a base URL the curl can prefix. Servers wins; falls back to the
// Swagger 2.x triple of schemes/host/basePath; finally a placeholder host
// so the curl string remains pasteable (the user can find/replace).
function getBaseUrl(spec) {
  if (Array.isArray(spec.servers) && spec.servers[0] && typeof spec.servers[0].url === "string") {
    return spec.servers[0].url.replace(/\/+$/, "");
  }
  if (typeof spec.host === "string" && spec.host.trim()) {
    const scheme = (Array.isArray(spec.schemes) && spec.schemes[0]) || "https";
    const basePath = typeof spec.basePath === "string" ? spec.basePath : "";
    return `${scheme}://${spec.host}${basePath}`.replace(/\/+$/, "");
  }
  return "https://example.com";
}

// Pick a representative value for a parameter — prefer `example`, fall back
// to a typed default so the curl is still copy-pasteable. The angle-bracket
// placeholder for strings is a load-bearing UX signal: it makes it obvious
// to the caller "this value is fake — replace it".
function paramExample(p) {
  if (p.example !== undefined) return p.example;
  if (p.schema && p.schema.example !== undefined) return p.schema.example;
  const t = paramType(p);
  if (t === "integer" || t === "number") return 0;
  if (t === "boolean") return false;
  return `<${p.name}>`;
}

// POSIX single-quote shell escape: 'x' is literal, '\'' embeds a single quote.
// Works across bash/zsh/sh without interpolation surprises.
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// ---- openapi-mock-response helpers ----

// Pick the response object to mock. Explicit `status` wins; otherwise prefer
// the first 2xx (lex-sorted, deterministic), then any first documented
// response. Returns { status, response } or throws.
function pickResponse(op, requestedStatus) {
  const responses = (op && op.responses) || {};
  const keys = Object.keys(responses);
  if (requestedStatus) {
    const s = String(requestedStatus);
    if (!responses[s]) throw bad(`response status "${s}" not documented on this operation`);
    return { status: s, response: responses[s] };
  }
  const twoXX = keys.filter((k) => /^2\d\d$/.test(k)).sort();
  if (twoXX.length) return { status: twoXX[0], response: responses[twoXX[0]] };
  if (keys.length) return { status: keys[0], response: responses[keys[0]] };
  throw bad("operation has no documented responses");
}

// Recursive schema-to-mock walker. Depth-capped at 6 — without $ref deref
// there's no real cycle path, but defense in depth keeps a pathological
// nested array from blowing the stack.
function mockFromSchema(schema, depth = 0) {
  if (depth > 6) return null;
  if (!schema || typeof schema !== "object") return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  // Unresolved $ref — surface it literally so the caller sees the gap.
  if (typeof schema.$ref === "string") return { $ref: schema.$ref };
  // Composite schemas: pick the first arm of oneOf/anyOf/allOf. Not
  // semantically complete (a real allOf merges arms) but predictable.
  for (const k of ["oneOf", "anyOf", "allOf"]) {
    if (Array.isArray(schema[k]) && schema[k].length) {
      return mockFromSchema(schema[k][0], depth + 1);
    }
  }
  const t = schema.type;
  if (t === "object" || (schema.properties && !t)) {
    const out = {};
    const props = schema.properties || {};
    for (const [k, sub] of Object.entries(props)) {
      out[k] = mockFromSchema(sub, depth + 1);
    }
    return out;
  }
  if (t === "array") {
    return [mockFromSchema(schema.items || {}, depth + 1)];
  }
  if (t === "string") return "string";
  if (t === "integer") return 0;
  if (t === "number") return 0;
  if (t === "boolean") return false;
  if (t === "null") return null;
  return null;
}

// ---- openapi-validate-payload helpers ----

// JSON type of a value, with "integer" split out of "number" because most
// OpenAPI schemas distinguish them.
function jsonType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "object") return "object";
  return typeof v;
}

// Type-match check, honoring two OpenAPI/JSON-Schema conventions:
// (1) schema.type may be an array of allowed types (OpenAPI 3.1 / nullable),
// (2) an integer value satisfies a "number" constraint (every int is a number).
function typeMatches(expected, actual) {
  if (!expected) return true;
  if (Array.isArray(expected)) {
    return expected.some((t) => typeMatches(t, actual));
  }
  if (expected === "number" && actual === "integer") return true;
  return expected === actual;
}

// Stringly-equal deep equality, sufficient for enum membership in JSON-able
// values. Avoids dragging in a recursive equality helper.
function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Recursive validator. Mutates `errors`. Depth-capped at 8 — defense in
// depth against accidentally circular schemas (we don't deref $ref, so a
// real cycle ends at the $ref node, but a hand-written recursive structure
// could still be deep).
function validatePayload(schema, value, path, errors, depth = 0) {
  if (depth > 8) {
    errors.push({ path, rule: "depth", message: "max validation depth exceeded" });
    return;
  }
  if (!schema || typeof schema !== "object") return;

  // $ref: we don't dereference. Surface it explicitly so the caller knows
  // they need to resolve upstream rather than seeing a silent pass.
  if (typeof schema.$ref === "string") {
    errors.push({ path, rule: "ref-not-resolved", message: `$ref left unresolved: ${schema.$ref}` });
    return;
  }

  // oneOf / anyOf: pick the arm that validates cleanly; if none, surface
  // the arm with the fewest errors (most useful diagnostic).
  for (const k of ["oneOf", "anyOf"]) {
    if (Array.isArray(schema[k]) && schema[k].length) {
      let bestErrs = null;
      for (const arm of schema[k]) {
        const armErrs = [];
        validatePayload(arm, value, path, armErrs, depth + 1);
        if (armErrs.length === 0) { bestErrs = []; break; }
        if (bestErrs === null || armErrs.length < bestErrs.length) bestErrs = armErrs;
      }
      for (const e of bestErrs) errors.push(e);
      return;
    }
  }
  // allOf: every arm must validate against the same value.
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    for (const arm of schema.allOf) validatePayload(arm, value, path, errors, depth + 1);
    // Fall through — allOf can be combined with own type/properties.
  }

  const actualType = jsonType(value);

  // Type check. If it fails, stop — descending into properties/items
  // against the wrong type just produces noisy follow-on errors.
  if (schema.type && !typeMatches(schema.type, actualType)) {
    const expected = Array.isArray(schema.type) ? schema.type.join("|") : schema.type;
    errors.push({ path, rule: "type", message: `expected ${expected}, got ${actualType}` });
    return;
  }

  if (Array.isArray(schema.enum) && schema.enum.length) {
    if (!schema.enum.some((e) => jsonEqual(e, value))) {
      errors.push({ path, rule: "enum", message: `value not in enum: ${JSON.stringify(schema.enum)}` });
    }
  }

  if (actualType === "object" && value !== null) {
    const props = schema.properties || {};
    // Required: sorted so multiple missing fields report deterministically.
    const required = Array.isArray(schema.required) ? schema.required.slice().sort() : [];
    for (const r of required) {
      if (!(r in value)) {
        errors.push({ path, rule: "required", message: `missing required field: ${r}` });
      }
    }
    // Properties: iterate in insertion order of the payload (deterministic
    // for any given input). additionalProperties:false flags strangers.
    for (const [k, v] of Object.entries(value)) {
      const childPath = path + "." + k;
      if (props[k]) {
        validatePayload(props[k], v, childPath, errors, depth + 1);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: childPath, rule: "additionalProperties", message: `unexpected property: ${k}` });
      }
    }
  }

  if (actualType === "array" && schema.items) {
    value.forEach((item, i) => validatePayload(schema.items, item, `${path}[${i}]`, errors, depth + 1));
  }
}

// Locate the schema for a given operation `part` ("request" or "response").
// Returns the schema (or null) plus the resolved status when part="response".
function locateSchemaForPart(op, part, requestedStatus) {
  if (part === "request") {
    const rb = op && op.requestBody && op.requestBody.content && op.requestBody.content["application/json"];
    return { schema: (rb && rb.schema) || null, status: null };
  }
  if (part === "response") {
    const { status, response } = pickResponse(op, requestedStatus);
    const jc = response && response.content && response.content["application/json"];
    return { schema: (jc && jc.schema) || null, status };
  }
  throw bad('"part" must be "request" or "response"');
}

// ---- openapi-redact helpers ----
//
// Categories are coarse buckets, not raw key names, so callers don't have to
// know which fields the OpenAPI spec uses to store free-text. `examples`
// covers both the singular `example` and the plural `examples` keyword;
// `descriptions` covers the lone `description` field at every layer.
const STRIP_KEYS = {
  examples: ["example", "examples"],
  descriptions: ["description"],
  summaries: ["summary"],
  tags: ["tags"],
  externalDocs: ["externalDocs"],
  deprecated: ["deprecated"],
};

function buildStripMap(stripList) {
  const map = new Map();
  for (const category of stripList) {
    const keys = STRIP_KEYS[category];
    if (!keys) {
      throw bad(`unknown strip category: "${category}". Valid: ${Object.keys(STRIP_KEYS).join(", ")}`);
    }
    for (const k of keys) map.set(k, category);
  }
  return map;
}

// Walk the spec, dropping any key whose name is in stripMap and counting it
// against the originating category. The walker tracks `parentKey` so that
// when we descend into a `properties: { ... }` object, we treat its keys as
// user-defined property names — meaning a user property literally named
// "example" or "description" is preserved. We continue recursing into the
// value of that protected key, so an `example` keyword inside the property's
// own schema is still stripped (which is what callers want — they're
// shrinking schema noise, not damaging the user's data model).
function deepRedact(node, stripMap, removed, parentKey) {
  if (Array.isArray(node)) {
    return node.map((n) => deepRedact(n, stripMap, removed, null));
  }
  if (node && typeof node === "object") {
    const out = {};
    const userKeysHere = parentKey === "properties";
    for (const [k, v] of Object.entries(node)) {
      if (!userKeysHere && stripMap.has(k)) {
        removed[stripMap.get(k)]++;
        continue;
      }
      out[k] = deepRedact(v, stripMap, removed, k);
    }
    return out;
  }
  return node;
}

// ---- openapi-resolve-refs helpers ----
//
// JSON pointer (RFC 6901) lookup against the root document. Returns
// `undefined` if any segment of the path doesn't exist or the ref isn't
// a local fragment pointer.
function jsonPointerLookup(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  const segments = ref.slice(2).split("/").map((s) =>
    s.replace(/~1/g, "/").replace(/~0/g, "~"),
  );
  let cur = root;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

// Walk the spec, replacing `{ $ref: "..." }` nodes with the target value.
// `resolvingPath` is the set of refs currently in progress on THIS branch of
// the walk — passing a fresh copy down means sibling refs to the same target
// both resolve, but re-entering the same ref within its own resolution chain
// is detected as a cycle and left intact.
//
// Sibling keys of `$ref` are dropped to match JSON Schema Draft 7 / OpenAPI
// 3.0 semantics. Callers needing OpenAPI 3.1 merge behavior should pre-merge
// upstream — this walker is a "replace, not extend" implementation by design.
function deepResolveRefs(node, root, resolvingPath, report) {
  if (Array.isArray(node)) {
    return node.map((n) => deepResolveRefs(n, root, resolvingPath, report));
  }
  if (node && typeof node === "object") {
    if (typeof node.$ref === "string") {
      const ref = node.$ref;
      if (!ref.startsWith("#/")) {
        if (!report.external.includes(ref)) report.external.push(ref);
        return node;
      }
      if (resolvingPath.has(ref)) {
        if (!report.circular.includes(ref)) report.circular.push(ref);
        return node;
      }
      const target = jsonPointerLookup(root, ref);
      if (target === undefined) {
        if (!report.unresolved.includes(ref)) report.unresolved.push(ref);
        return node;
      }
      report.resolved++;
      const nextPath = new Set(resolvingPath);
      nextPath.add(ref);
      return deepResolveRefs(target, root, nextPath, report);
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = deepResolveRefs(v, root, resolvingPath, report);
    }
    return out;
  }
  return node;
}

// ---- openapi-security-summary helpers ----
//
// OpenAPI 3 puts security schemes under `components.securitySchemes`. Swagger 2
// uses the top-level `securityDefinitions` key — different name, same shape per
// scheme. We return whichever is present (preferring OpenAPI 3 if both exist,
// which shouldn't happen in a sane document) so the catalog reflects how the
// document actually declares its schemes.
function collectSecuritySchemes(spec) {
  const v3 = spec && spec.components && spec.components.securitySchemes;
  if (v3 && typeof v3 === "object") return v3;
  const v2 = spec && spec.securityDefinitions;
  if (v2 && typeof v2 === "object") return v2;
  return {};
}

// Resolve the effective security requirement list for one operation. The
// OpenAPI rule that distinguishes "inherit global" from "explicitly open" is
// the presence (not the contents) of `op.security`:
//   - op.security present (even if []) → that wins, do not consult global
//   - op.security absent → fall back to the document-level default
// An empty list (either source) means the op is open. We return the array
// verbatim so callers can introspect scope strings on OAuth/OpenID flows.
function effectiveSecurity(op, globalSecurity) {
  if (Array.isArray(op.security)) return op.security;
  return globalSecurity;
}
