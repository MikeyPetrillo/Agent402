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
