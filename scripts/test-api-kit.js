// Exact-output tests for api-kit (openapi-diff). Pure functions, no server.
import { API_TOOLS } from "../src/tools/api-kit.js";

const tool = (slug) => API_TOOLS.find((t) => t.slug === slug);
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const run = (slug, input) => tool(slug).handler(input);

// 1. Example round-trip — the input/output documented in discovery must match
// what the handler actually returns. This is the same contract test-all.js
// asserts at the HTTP layer; checking it here gives a faster signal.
{
  const t = tool("openapi-diff");
  const r = run("openapi-diff", t.discovery.input);
  const expected = t.discovery.output.example;
  ok(JSON.stringify(r) === JSON.stringify(expected),
    `example round-trips exactly (got ${JSON.stringify(r)})`);
}

// 2. Identical specs → empty diff, not breaking.
{
  const spec = { openapi: "3.0.0", paths: { "/users": { get: { responses: { "200": {} } } } } };
  const r = run("openapi-diff", { before: spec, after: spec });
  ok(r.added.length === 0 && r.removed.length === 0 && r.changed.length === 0 && r.breaking === false && r.breakingCount === 0,
    `identical specs → empty, not breaking`);
}

// 3. Removed endpoint is breaking; added is not.
{
  const before = { paths: { "/a": { get: { responses: { "200": {} } } } } };
  const after = { paths: { "/b": { post: { responses: { "201": {} } } } } };
  const r = run("openapi-diff", { before, after });
  ok(r.added[0] === "POST /b" && r.removed[0] === "GET /a", `tracks add/remove`);
  ok(r.breaking === true && r.breakingCount === 1, `removed endpoint flags breaking`);
}

// 4. Adding a required parameter → breaking.
{
  const before = { paths: { "/u": { get: { parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer" } }], responses: { "200": {} } } } } };
  const after = { paths: { "/u": { get: { parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer" } }, { name: "token", in: "query", required: true, schema: { type: "string" } }], responses: { "200": {} } } } } };
  const r = run("openapi-diff", { before, after });
  ok(r.changed.length === 1 && r.changed[0].breaking === true && r.changed[0].changes.some((c) => c.includes("added required query param: token")),
    `added required param → breaking (got ${JSON.stringify(r.changed)})`);
}

// 5. Optional → required transition is breaking.
{
  const before = { paths: { "/u": { get: { parameters: [{ name: "id", in: "query", required: false, schema: { type: "string" } }], responses: { "200": {} } } } } };
  const after = { paths: { "/u": { get: { parameters: [{ name: "id", in: "query", required: true, schema: { type: "string" } }], responses: { "200": {} } } } } };
  const r = run("openapi-diff", { before, after });
  ok(r.changed[0].breaking === true && r.changed[0].changes.some((c) => c.includes("became required")),
    `optional → required flagged breaking`);
}

// 6. JSON body required field added → breaking.
{
  const before = { paths: { "/u": { post: { requestBody: { content: { "application/json": { schema: { required: ["name"] } } } }, responses: { "201": {} } } } } };
  const after = { paths: { "/u": { post: { requestBody: { content: { "application/json": { schema: { required: ["name", "email"] } } } }, responses: { "201": {} } } } } };
  const r = run("openapi-diff", { before, after });
  ok(r.changed[0].breaking === true && r.changed[0].changes.some((c) => c.includes("body field 'email' became required")),
    `body required field added → breaking`);
}

// 7. Removing a 2xx status is breaking; removing a 4xx is not.
{
  const before = { paths: { "/u": { get: { responses: { "200": {}, "404": {} } } } } };
  const after = { paths: { "/u": { get: { responses: { "200": {} } } } } };
  const r = run("openapi-diff", { before, after });
  ok(r.changed[0].breaking === false && r.changed[0].changes.some((c) => c.includes("response status removed: 404")),
    `removed 4xx is non-breaking note`);
}
{
  const before = { paths: { "/u": { get: { responses: { "200": {}, "201": {} } } } } };
  const after = { paths: { "/u": { get: { responses: { "200": {} } } } } };
  const r = run("openapi-diff", { before, after });
  ok(r.changed[0].breaking === true,
    `removed 2xx is breaking`);
}

// 8. Param type change is breaking.
{
  const before = { paths: { "/u": { get: { parameters: [{ name: "id", in: "query", schema: { type: "string" } }], responses: { "200": {} } } } } };
  const after = { paths: { "/u": { get: { parameters: [{ name: "id", in: "query", schema: { type: "integer" } }], responses: { "200": {} } } } } };
  const r = run("openapi-diff", { before, after });
  ok(r.changed[0].breaking === true && r.changed[0].changes.some((c) => c.includes("type changed: string → integer")),
    `param type change → breaking`);
}

// 9. Swagger 2.x (parameter `type` at top level, not `schema.type`) is supported.
{
  const before = { swagger: "2.0", paths: { "/u": { get: { parameters: [{ name: "id", in: "query", type: "string", required: false }], responses: { "200": {} } } } } };
  const after = { swagger: "2.0", paths: { "/u": { get: { parameters: [{ name: "id", in: "query", type: "integer", required: false }], responses: { "200": {} } } } } };
  const r = run("openapi-diff", { before, after });
  ok(r.changed[0].breaking === true && r.changed[0].changes.some((c) => c.includes("type changed: string → integer")),
    `Swagger 2.x param type change detected`);
}

// 10. JSON-string inputs are accepted (callers paste raw spec text).
{
  const before = '{"paths":{"/a":{"get":{"responses":{"200":{}}}}}}';
  const after = '{"paths":{"/a":{"get":{"responses":{"200":{}}}},"/b":{"get":{"responses":{"200":{}}}}}}';
  const r = run("openapi-diff", { before, after });
  ok(r.added[0] === "GET /b" && r.breaking === false, `string inputs parse + diff`);
}

// 11. Path-level parameters are merged with operation-level.
{
  const before = { paths: { "/u": { parameters: [{ name: "v", in: "header", required: false, schema: { type: "string" } }], get: { responses: { "200": {} } } } } };
  const after = { paths: { "/u": { parameters: [{ name: "v", in: "header", required: true, schema: { type: "string" } }], get: { responses: { "200": {} } } } } };
  const r = run("openapi-diff", { before, after });
  ok(r.changed[0].breaking === true && r.changed[0].changes.some((c) => c.includes("became required")),
    `path-level params merged + required flip detected`);
}

// 12. Missing input rejected.
let threw = false; try { run("openapi-diff", { before: { paths: {} } }); } catch { threw = true; }
ok(threw, `missing "after" rejected`);

threw = false; try { run("openapi-diff", { before: "not json", after: { paths: {} } }); } catch { threw = true; }
ok(threw, `invalid JSON string rejected`);

// ---------- openapi-lint ----------

// L1. Example round-trips exactly. Same contract test-all.js runs at HTTP.
{
  const t = tool("openapi-lint");
  const r = run("openapi-lint", t.discovery.input);
  const expected = t.discovery.output.example;
  ok(JSON.stringify(r) === JSON.stringify(expected),
    `lint example round-trips exactly (got ${JSON.stringify(r)})`);
}

// L2. Fully-clean spec → ok:true, score 100, no violations.
{
  const spec = {
    openapi: "3.0.0",
    info: { title: "Clean", version: "1", description: "fully documented" },
    servers: [{ url: "https://x" }],
    paths: {
      "/u": {
        get: {
          operationId: "listU", summary: "list", tags: ["u"],
          responses: {
            "200": { description: "ok", content: { "application/json": { schema: { type: "array" } } } },
            "400": { description: "bad" },
          },
        },
      },
    },
  };
  const r = run("openapi-lint", { spec });
  ok(r.ok === true && r.score === 100 && r.violations.length === 0,
    `clean spec → 100 (got score=${r.score}, violations=${JSON.stringify(r.violations)})`);
}

// L3. Spec with no servers and no host → "no-servers" warning.
{
  const spec = { openapi: "3.0.0", info: { title: "x", description: "y" }, paths: {
    "/u": { get: { operationId: "u", summary: "s", tags: ["t"], responses: { "200": { description: "ok" }, "400": { description: "bad" } } } } } };
  const r = run("openapi-lint", { spec });
  ok(r.violations.some((v) => v.rule === "no-servers"), `no servers → no-servers warning`);
}

// L4. Swagger 2.x `host` satisfies the server check.
{
  const spec = { swagger: "2.0", info: { title: "x", description: "y" }, host: "api.example.com", paths: {
    "/u": { get: { operationId: "u", summary: "s", tags: ["t"], responses: { "200": { description: "ok" }, "400": { description: "bad" } } } } } };
  const r = run("openapi-lint", { spec });
  ok(!r.violations.some((v) => v.rule === "no-servers"), `Swagger 2.x host satisfies server check`);
}

// L5. No paths → error + ok:false.
{
  const spec = { openapi: "3.0.0", info: { title: "x", description: "y" }, servers: [{ url: "https://x" }], paths: {} };
  const r = run("openapi-lint", { spec });
  ok(r.ok === false && r.violations.some((v) => v.rule === "no-paths" && v.severity === "error"),
    `empty paths → ok:false + no-paths error`);
}

// L6. Operation missing 2xx → error.
{
  const spec = { openapi: "3.0.0", info: { title: "x", description: "y" }, servers: [{ url: "https://x" }], paths: {
    "/u": { get: { operationId: "u", summary: "s", tags: ["t"], responses: { "404": { description: "nope" } } } } } };
  const r = run("openapi-lint", { spec });
  ok(r.violations.some((v) => v.rule === "operation-missing-2xx-response" && v.severity === "error"),
    `no 2xx → error`);
}

// L7. Param missing description, schema, and example → three distinct violations.
{
  const spec = { openapi: "3.0.0", info: { title: "x", description: "y" }, servers: [{ url: "https://x" }], paths: {
    "/u": { get: { operationId: "u", summary: "s", tags: ["t"], parameters: [{ name: "id", in: "query" }],
      responses: { "200": { description: "ok" }, "400": { description: "bad" } } } } } };
  const r = run("openapi-lint", { spec });
  const rules = new Set(r.violations.map((v) => v.rule));
  ok(rules.has("param-missing-description") && rules.has("param-missing-schema") && rules.has("param-missing-example"),
    `bare param triggers all three param checks (got ${[...rules].join(",")})`);
}

// L8. Swagger 2.x top-level `type` on a param counts as typed.
{
  const spec = { swagger: "2.0", info: { title: "x", description: "y" }, host: "h", paths: {
    "/u": { get: { operationId: "u", summary: "s", tags: ["t"],
      parameters: [{ name: "id", in: "query", description: "the id", type: "string", "x-example": "abc" }],
      responses: { "200": { description: "ok" }, "400": { description: "bad" } } } } } };
  const r = run("openapi-lint", { spec });
  ok(!r.violations.some((v) => v.rule === "param-missing-schema"),
    `Swagger 2.x top-level type is recognized`);
}

// L9. JSON-string input is accepted.
{
  const spec = JSON.stringify({ openapi: "3.0.0", info: { title: "x", description: "y" }, servers: [{ url: "https://x" }], paths: {
    "/u": { get: { operationId: "u", summary: "s", tags: ["t"], responses: { "200": { description: "ok" }, "400": { description: "bad" } } } } } });
  const r = run("openapi-lint", { spec });
  ok(r.ok === true && r.score === 100, `JSON string input parses + scores`);
}

// L10. Missing "spec" rejected.
threw = false; try { run("openapi-lint", {}); } catch { threw = true; }
ok(threw, `missing "spec" rejected`);

// L11. Score formula: 1 error + 2 warnings + 3 info = 100 - 10 - 6 - 3 = 81.
{
  // Path with no 2xx (error), no servers (warning), no operationId on the op
  // (warning), no tags (info), no description on info (info), no error
  // response — but we don't have a 2xx so "no-error-responses" won't fire.
  // Build a precise spec:
  //   - missing servers      → warning
  //   - operation no 2xx     → error
  //   - operation no tags    → info
  //   - operation no opId    → warning
  //   - info no description  → info
  //   - param no example     → info
  const spec = { openapi: "3.0.0", info: { title: "x" }, paths: {
    "/u": { get: { summary: "s",
      parameters: [{ name: "id", in: "query", description: "the id", schema: { type: "string" } }],
      responses: { "404": { description: "nope" } } } } } };
  const r = run("openapi-lint", { spec });
  // error=1 (no 2xx), warning=2 (no-servers, no-operationid), info=3 (no info description, no tags, no param example)
  ok(r.counts.error === 1 && r.counts.warning === 2 && r.counts.info === 3,
    `expected 1e/2w/3i, got ${JSON.stringify(r.counts)}`);
  ok(r.score === 100 - 10 - 6 - 3,
    `score should be 81, got ${r.score}`);
}

// ---------- openapi-extract ----------

// E1. Example round-trips exactly. Same HTTP contract test-all.js asserts.
{
  const t = tool("openapi-extract");
  const r = run("openapi-extract", t.discovery.input);
  const expected = t.discovery.output.example;
  ok(JSON.stringify(r) === JSON.stringify(expected),
    `extract example round-trips exactly (got ${JSON.stringify(r)})`);
}

// E2. Empty spec → empty list + zero stats.
{
  const r = run("openapi-extract", { spec: { openapi: "3.0.0", paths: {} } });
  ok(r.endpoints.length === 0 && r.stats.total === 0
     && Object.keys(r.stats.byMethod).length === 0
     && Object.keys(r.stats.byTag).length === 0,
    `empty paths → empty extract`);
}

// E3. JSON-string input parses + extracts.
{
  const spec = JSON.stringify({ paths: { "/a": { get: { responses: { "200": {} } } } } });
  const r = run("openapi-extract", { spec });
  ok(r.endpoints.length === 1 && r.endpoints[0].method === "GET" && r.endpoints[0].path === "/a",
    `string spec extracted`);
}

// E4. Path-level params merge with operation-level (path-level appears in extract).
{
  const spec = { paths: { "/u": {
    parameters: [{ name: "trace", in: "header", required: true, schema: { type: "string" } }],
    get: { responses: { "200": {} } } } } };
  const r = run("openapi-extract", { spec });
  const params = r.endpoints[0].params;
  ok(params.some((p) => p.name === "trace" && p.in === "header" && p.required === true),
    `path-level params merged into extract (got ${JSON.stringify(params)})`);
}

// E5. Swagger 2.x top-level `type` on a param surfaces as the type.
{
  const spec = { swagger: "2.0", paths: { "/u": { get: {
    parameters: [{ name: "id", in: "query", type: "integer" }],
    responses: { "200": {} } } } } };
  const r = run("openapi-extract", { spec });
  ok(r.endpoints[0].params[0].type === "integer",
    `Swagger 2.x top-level type captured (got ${JSON.stringify(r.endpoints[0].params)})`);
}

// E6. JSON request body detected.
{
  const spec = { paths: { "/u": { post: {
    requestBody: { content: { "application/json": { schema: { type: "object" } } } },
    responses: { "201": {} } } } } };
  const r = run("openapi-extract", { spec });
  ok(r.endpoints[0].hasJsonBody === true, `json body flagged`);
}
{
  const spec = { paths: { "/u": { post: {
    requestBody: { content: { "application/xml": { schema: {} } } },
    responses: { "201": {} } } } } };
  const r = run("openapi-extract", { spec });
  ok(r.endpoints[0].hasJsonBody === false, `non-json body not flagged`);
}

// E7. Multi-tag operation counts in each tag bucket.
{
  const spec = { paths: { "/u": { get: {
    tags: ["users", "admin"], responses: { "200": {} } } } } };
  const r = run("openapi-extract", { spec });
  ok(r.stats.byTag.users === 1 && r.stats.byTag.admin === 1,
    `multi-tag counted per tag (got ${JSON.stringify(r.stats.byTag)})`);
}

// E8. Output is sorted by path, then method.
{
  const spec = { paths: {
    "/z": { get: { responses: { "200": {} } } },
    "/a": { post: { responses: { "200": {} } } },
    "/m": { put: { responses: { "200": {} } }, get: { responses: { "200": {} } } },
  } };
  const r = run("openapi-extract", { spec });
  const order = r.endpoints.map((e) => `${e.method} ${e.path}`);
  ok(JSON.stringify(order) === JSON.stringify(["POST /a", "GET /m", "PUT /m", "GET /z"]),
    `sorted by path-then-method (got ${JSON.stringify(order)})`);
}

// E9. summary falls back to description when summary is missing.
{
  const spec = { paths: { "/u": { get: {
    description: "Get a user record", responses: { "200": {} } } } } };
  const r = run("openapi-extract", { spec });
  ok(r.endpoints[0].summary === "Get a user record",
    `summary falls back to description`);
}

// E10. Operations with no operationId / summary / tags get null/[] placeholders.
{
  const spec = { paths: { "/u": { get: { responses: { "200": {} } } } } };
  const r = run("openapi-extract", { spec });
  const e = r.endpoints[0];
  ok(e.operationId === null && e.summary === null && Array.isArray(e.tags) && e.tags.length === 0,
    `missing op metadata → null/[] (got ${JSON.stringify(e)})`);
}

// E11. Missing "spec" rejected.
threw = false; try { run("openapi-extract", {}); } catch { threw = true; }
ok(threw, `missing "spec" rejected`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
