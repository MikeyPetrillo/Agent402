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

// ---------- openapi-to-curl ----------

// C1. Example round-trips exactly. Same HTTP contract test-all.js asserts.
{
  const t = tool("openapi-to-curl");
  const r = run("openapi-to-curl", t.discovery.input);
  const expected = t.discovery.output.example;
  ok(JSON.stringify(r) === JSON.stringify(expected),
    `to-curl example round-trips exactly (got ${JSON.stringify(r)})`);
}

// C2. method+path locator works when operationId is absent.
{
  const spec = { servers: [{ url: "https://a.test" }], paths: {
    "/p": { get: { responses: { "200": {} } } } } };
  const r = run("openapi-to-curl", { spec, method: "get", path: "/p" });
  ok(r.method === "GET" && r.url === "https://a.test/p"
     && r.curl === "curl -X GET 'https://a.test/p'",
    `method+path locator works (got curl=${r.curl})`);
}

// C3. Unknown operationId rejected.
threw = false; try { run("openapi-to-curl", { spec: { paths: {} }, operationId: "nope" }); } catch { threw = true; }
ok(threw, `unknown operationId rejected`);

// C4. Unknown method+path rejected.
threw = false; try { run("openapi-to-curl", { spec: { paths: { "/x": { get: { responses: {} } } } }, method: "post", path: "/x" }); } catch { threw = true; }
ok(threw, `unknown method+path rejected`);

// C5. No locator at all rejected.
threw = false; try { run("openapi-to-curl", { spec: { paths: {} } }); } catch { threw = true; }
ok(threw, `missing locator rejected`);

// C6. Path param without an example falls back to a typed placeholder.
{
  const spec = { servers: [{ url: "https://a.test" }], paths: {
    "/u/{id}": { get: { operationId: "getU", parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { "200": {} } } } } };
  const r = run("openapi-to-curl", { spec, operationId: "getU" });
  ok(r.url === "https://a.test/u/%3Cid%3E",
    `string path param falls back to <name> placeholder (got ${r.url})`);
}
{
  const spec = { servers: [{ url: "https://a.test" }], paths: {
    "/u/{n}": { get: { operationId: "getN", parameters: [
      { name: "n", in: "path", required: true, schema: { type: "integer" } }],
      responses: { "200": {} } } } } };
  const r = run("openapi-to-curl", { spec, operationId: "getN" });
  ok(r.url === "https://a.test/u/0",
    `integer path param falls back to 0 (got ${r.url})`);
}

// C7. Optional query params are excluded; required ones are included.
{
  const spec = { servers: [{ url: "https://a.test" }], paths: { "/u": { get: {
    operationId: "listU",
    parameters: [
      { name: "limit", in: "query", required: false, schema: { type: "integer", example: 10 } },
      { name: "cursor", in: "query", required: true, schema: { type: "string", example: "abc" } },
    ],
    responses: { "200": {} } } } } };
  const r = run("openapi-to-curl", { spec, operationId: "listU" });
  ok(r.url === "https://a.test/u?cursor=abc" && !r.url.includes("limit"),
    `required query in url, optional omitted (got ${r.url})`);
}

// C8. Required header params land in headers map.
{
  const spec = { servers: [{ url: "https://a.test" }], paths: { "/u": { get: {
    operationId: "listU",
    parameters: [{ name: "Authorization", in: "header", required: true, schema: { type: "string", example: "Bearer xyz" } }],
    responses: { "200": {} } } } } };
  const r = run("openapi-to-curl", { spec, operationId: "listU" });
  ok(r.headers.Authorization === "Bearer xyz"
     && r.curl.includes("-H 'Authorization: Bearer xyz'"),
    `required header in headers + curl (got curl=${r.curl})`);
}

// C9. JSON body — operation example wins over schema example.
{
  const spec = { servers: [{ url: "https://a.test" }], paths: { "/u": { post: {
    operationId: "createU",
    requestBody: { content: { "application/json": {
      example: { name: "from-op" },
      schema: { example: { name: "from-schema" } },
    } } },
    responses: { "201": {} } } } } };
  const r = run("openapi-to-curl", { spec, operationId: "createU" });
  ok(r.body && r.body.name === "from-op"
     && r.headers["content-type"] === "application/json"
     && r.curl.endsWith(`-d '{"name":"from-op"}'`),
    `op example wins; content-type set; -d in curl (got curl=${r.curl})`);
}

// C10. JSON body — schema example used when no op example.
{
  const spec = { servers: [{ url: "https://a.test" }], paths: { "/u": { post: {
    operationId: "createU",
    requestBody: { content: { "application/json": { schema: { example: { from: "schema" } } } } },
    responses: { "201": {} } } } } };
  const r = run("openapi-to-curl", { spec, operationId: "createU" });
  ok(r.body && r.body.from === "schema", `schema example used when op example absent`);
}

// C11. JSON body — empty {} when neither example is provided, so the
// content-type + -d affordance is still visible.
{
  const spec = { servers: [{ url: "https://a.test" }], paths: { "/u": { post: {
    operationId: "createU",
    requestBody: { content: { "application/json": { schema: { type: "object" } } } },
    responses: { "201": {} } } } } };
  const r = run("openapi-to-curl", { spec, operationId: "createU" });
  ok(JSON.stringify(r.body) === "{}" && r.headers["content-type"] === "application/json",
    `no example → empty body + content-type still set`);
}

// C12. Swagger 2.x scheme + host + basePath assembles a base URL.
{
  const spec = { swagger: "2.0", schemes: ["https"], host: "api.test", basePath: "/v1",
    paths: { "/u": { get: { operationId: "listU", responses: { "200": {} } } } } };
  const r = run("openapi-to-curl", { spec, operationId: "listU" });
  ok(r.url === "https://api.test/v1/u", `swagger 2.x base URL assembled (got ${r.url})`);
}

// C13. No servers / no host → fallback host so curl remains pasteable.
{
  const spec = { paths: { "/u": { get: { operationId: "listU", responses: { "200": {} } } } } };
  const r = run("openapi-to-curl", { spec, operationId: "listU" });
  ok(r.url === "https://example.com/u", `placeholder base URL when nothing documented`);
}

// C14. JSON-string spec input is accepted.
{
  const spec = JSON.stringify({ servers: [{ url: "https://a.test" }], paths: {
    "/u": { get: { operationId: "listU", responses: { "200": {} } } } } });
  const r = run("openapi-to-curl", { spec, operationId: "listU" });
  ok(r.url === "https://a.test/u", `string spec accepted`);
}

// C15. Shell-quoting: a single quote in an example value survives end-to-
// end. RFC 3986 considers ' a sub-delim — encodeURIComponent leaves it
// alone, so it lands in the URL literal as `it's`. The shell-quote wrapper
// then escapes it with POSIX `'\''` so the curl is still safe to paste.
{
  const spec = { servers: [{ url: "https://a.test" }], paths: { "/u": { get: {
    operationId: "listU",
    parameters: [{ name: "q", in: "query", required: true, schema: { type: "string", example: "it's a test" } }],
    responses: { "200": {} } } } } };
  const r = run("openapi-to-curl", { spec, operationId: "listU" });
  // URL preserves the apostrophe (valid per RFC 3986).
  ok(r.url === "https://a.test/u?q=it's%20a%20test",
    `apostrophe preserved in URL (got ${r.url})`);
  // Curl wraps the URL with the apostrophe shell-escaped as '\''.
  ok(r.curl === "curl -X GET 'https://a.test/u?q=it'\\''s%20a%20test'",
    `apostrophe shell-escaped via '\\'' in curl (got ${r.curl})`);
}

// C16. Missing "spec" rejected.
threw = false; try { run("openapi-to-curl", { operationId: "x" }); } catch { threw = true; }
ok(threw, `missing "spec" rejected`);

// ---------- openapi-mock-response ----------

// M1. Example round-trips exactly.
{
  const t = tool("openapi-mock-response");
  const r = run("openapi-mock-response", t.discovery.input);
  const expected = t.discovery.output.example;
  ok(JSON.stringify(r) === JSON.stringify(expected),
    `mock example round-trips exactly (got ${JSON.stringify(r)})`);
}

// M2. Operation-level `example` beats schema example.
{
  const spec = { paths: { "/u": { get: { operationId: "u", responses: { "200": {
    content: { "application/json": {
      example: { from: "op" },
      schema: { example: { from: "schema" } } } } } } } } } };
  const r = run("openapi-mock-response", { spec, operationId: "u" });
  ok(r.mock.from === "op" && r.source === "operation-example",
    `op example beats schema example`);
}

// M3. Schema `example` used when no op-level example.
{
  const spec = { paths: { "/u": { get: { operationId: "u", responses: { "200": {
    content: { "application/json": { schema: { example: { from: "schema" } } } } } } } } } };
  const r = run("openapi-mock-response", { spec, operationId: "u" });
  ok(r.mock.from === "schema" && r.source === "schema-example",
    `schema example wins when no op example`);
}

// M4. `examples` (multi-example map): first key alphabetically wins.
{
  const spec = { paths: { "/u": { get: { operationId: "u", responses: { "200": {
    content: { "application/json": { examples: {
      zebra: { value: { pick: "z" } },
      alpha: { value: { pick: "a" } },
    } } } } } } } } };
  const r = run("openapi-mock-response", { spec, operationId: "u" });
  ok(r.mock.pick === "a" && r.source === "operation-example",
    `examples map → first key alphabetically wins (got ${JSON.stringify(r.mock)})`);
}

// M5. Status defaults to the first 2xx when not specified.
{
  const spec = { paths: { "/u": { get: { operationId: "u", responses: {
    "404": { description: "nope" },
    "201": { content: { "application/json": { schema: { example: { ok: true } } } } },
    "200": { content: { "application/json": { schema: { example: { v: 1 } } } } },
  } } } } };
  const r = run("openapi-mock-response", { spec, operationId: "u" });
  ok(r.status === "200" && r.mock.v === 1, `defaults to first 2xx (got ${r.status})`);
}

// M6. Explicit status is honored.
{
  const spec = { paths: { "/u": { get: { operationId: "u", responses: {
    "200": { content: { "application/json": { schema: { example: { v: 1 } } } } },
    "201": { content: { "application/json": { schema: { example: { created: true } } } } },
  } } } } };
  const r = run("openapi-mock-response", { spec, operationId: "u", status: "201" });
  ok(r.status === "201" && r.mock.created === true, `explicit status used`);
}

// M7. Unknown status rejected.
threw = false; try {
  run("openapi-mock-response", { spec: { paths: { "/u": { get: { operationId: "u", responses: { "200": {} } } } } }, operationId: "u", status: "999" });
} catch { threw = true; }
ok(threw, `unknown status rejected`);

// M8. Operation with no documented responses → error.
threw = false; try {
  run("openapi-mock-response", { spec: { paths: { "/u": { get: { operationId: "u", responses: {} } } } }, operationId: "u" });
} catch { threw = true; }
ok(threw, `no responses → error`);

// M9. Response without JSON content → mock:null + source:none (not an error;
// the route exists, just has no JSON shape to mock).
{
  const spec = { paths: { "/u": { get: { operationId: "u", responses: { "204": { description: "gone" } } } } } };
  const r = run("openapi-mock-response", { spec, operationId: "u" });
  ok(r.mock === null && r.source === "none" && r.status === "204",
    `204 with no body → null mock, source:none`);
}

// M10. Generated walk: object with primitive properties uses type defaults
// when no example is given.
{
  const spec = { paths: { "/u": { get: { operationId: "u", responses: { "200": {
    content: { "application/json": { schema: {
      type: "object",
      properties: { s: { type: "string" }, n: { type: "integer" }, b: { type: "boolean" } },
    } } } } } } } } };
  const r = run("openapi-mock-response", { spec, operationId: "u" });
  ok(r.source === "generated" && r.mock.s === "string" && r.mock.n === 0 && r.mock.b === false,
    `type defaults applied (got ${JSON.stringify(r.mock)})`);
}

// M11. Array of primitives → [mock(items)].
{
  const spec = { paths: { "/u": { get: { operationId: "u", responses: { "200": {
    content: { "application/json": { schema: { type: "array", items: { type: "string", example: "hi" } } } } } } } } } };
  const r = run("openapi-mock-response", { spec, operationId: "u" });
  ok(Array.isArray(r.mock) && r.mock.length === 1 && r.mock[0] === "hi",
    `array → [items mock] (got ${JSON.stringify(r.mock)})`);
}

// M12. Enum → first value.
{
  const spec = { paths: { "/u": { get: { operationId: "u", responses: { "200": {
    content: { "application/json": { schema: {
      type: "object",
      properties: { status: { type: "string", enum: ["active", "paused", "deleted"] } },
    } } } } } } } } };
  const r = run("openapi-mock-response", { spec, operationId: "u" });
  ok(r.mock.status === "active", `enum → first value`);
}

// M13. $ref left as a literal { $ref: "..." } — kit doesn't dereference.
{
  const spec = { paths: { "/u": { get: { operationId: "u", responses: { "200": {
    content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } } } } } } };
  const r = run("openapi-mock-response", { spec, operationId: "u" });
  ok(r.mock && r.mock.$ref === "#/components/schemas/User", `$ref surfaced literally`);
}

// M14. oneOf / anyOf / allOf picks the first arm.
{
  const spec = { paths: { "/u": { get: { operationId: "u", responses: { "200": {
    content: { "application/json": { schema: {
      oneOf: [
        { type: "object", properties: { kind: { type: "string", example: "first" } } },
        { type: "object", properties: { kind: { type: "string", example: "second" } } },
      ],
    } } } } } } } } };
  const r = run("openapi-mock-response", { spec, operationId: "u" });
  ok(r.mock.kind === "first", `oneOf picks first arm`);
}

// M15. method+path locator works.
{
  const spec = { paths: { "/u": { post: { responses: { "201": {
    content: { "application/json": { schema: { example: { id: 1 } } } } } } } } } };
  const r = run("openapi-mock-response", { spec, method: "post", path: "/u" });
  ok(r.mock.id === 1 && r.status === "201", `method+path locator works`);
}

// M16. Deep recursion is depth-capped — pathological nested arrays don't
// crash or hang. The cap is internal; we just assert it terminates.
{
  // Build a 10-level deep nested array schema.
  let s = { type: "string" };
  for (let i = 0; i < 10; i++) s = { type: "array", items: s };
  const spec = { paths: { "/u": { get: { operationId: "u", responses: { "200": {
    content: { "application/json": { schema: s } } } } } } } };
  const r = run("openapi-mock-response", { spec, operationId: "u" });
  ok(r.source === "generated" && Array.isArray(r.mock), `deeply nested array terminates`);
}

// M17. Missing "spec" rejected.
threw = false; try { run("openapi-mock-response", { operationId: "x" }); } catch { threw = true; }
ok(threw, `missing "spec" rejected`);

// ---------- openapi-search ----------

// S1. Example round-trips exactly.
{
  const t = tool("openapi-search");
  const r = run("openapi-search", t.discovery.input);
  const expected = t.discovery.output.example;
  ok(JSON.stringify(r) === JSON.stringify(expected),
    `search example round-trips exactly (got ${JSON.stringify(r)})`);
}

// S2. No matches → total:0 + empty results.
{
  const spec = { paths: { "/posts": { get: { operationId: "listPosts", responses: { "200": {} } } } } };
  const r = run("openapi-search", { spec, query: "user" });
  ok(r.total === 0 && r.results.length === 0, `no match → empty result`);
}

// S3. Case-insensitive matching.
{
  const spec = { paths: { "/u": { get: { operationId: "GetUser", responses: { "200": {} } } } } };
  const r = run("openapi-search", { spec, query: "USER" });
  ok(r.total === 1 && r.results[0].matches.includes("operationId"),
    `case-insensitive match (got ${JSON.stringify(r)})`);
}

// S4. operationId match weight is 3; tags-only match is 2.
{
  const spec = { paths: {
    "/op": { get: { operationId: "user", responses: { "200": {} } } },     // opId only: +3
    "/tg": { get: { operationId: "x", tags: ["user"], responses: { "200": {} } } }, // tags only: +2 (and path "/tg" no match)
  } };
  const r = run("openapi-search", { spec, query: "user" });
  ok(r.results[0].path === "/op" && r.results[0].score === 3
     && r.results[1].path === "/tg" && r.results[1].score === 2,
    `opId weight=3 > tags weight=2 (got ${JSON.stringify(r.results.map(x=>[x.path,x.score]))})`);
}

// S5. Path match contributes.
{
  const spec = { paths: { "/users/{id}": { get: { operationId: "x", responses: { "200": {} } } } } };
  const r = run("openapi-search", { spec, query: "user" });
  ok(r.results[0].matches.includes("path") && !r.results[0].matches.includes("operationId"),
    `path match isolated`);
}

// S6. Description match (lowest weight) still ranks.
{
  const spec = { paths: { "/x": { get: { operationId: "x", description: "this is for users", responses: { "200": {} } } } } };
  const r = run("openapi-search", { spec, query: "user" });
  ok(r.results[0].score === 1 && r.results[0].matches[0] === "description",
    `description weight = 1`);
}

// S7. Multi-token query: each token contributes its own field hits.
{
  const spec = { paths: { "/a": { get: { operationId: "createUserSession", responses: { "200": {} } } } } };
  // Both "user" and "session" hit operationId. Per-token, per-field once:
  // "user" → opId +3; "session" → opId +3 → total 6.
  const r = run("openapi-search", { spec, query: "user session" });
  ok(r.results[0].score === 6, `multi-token: 3+3=6 (got ${r.results[0].score})`);
}

// S8. Sort tiebreak: same score → path ascending.
{
  const spec = { paths: {
    "/zebra": { get: { operationId: "user", responses: { "200": {} } } },
    "/alpha": { get: { operationId: "user", responses: { "200": {} } } },
  } };
  const r = run("openapi-search", { spec, query: "user" });
  ok(r.results[0].path === "/alpha" && r.results[1].path === "/zebra",
    `tiebreak: path ascending`);
}

// S9. Limit honored.
{
  const spec = { paths: {
    "/a": { get: { operationId: "userA", responses: { "200": {} } } },
    "/b": { get: { operationId: "userB", responses: { "200": {} } } },
    "/c": { get: { operationId: "userC", responses: { "200": {} } } },
  } };
  const r = run("openapi-search", { spec, query: "user", limit: 2 });
  ok(r.total === 3 && r.results.length === 2,
    `total counts all, results capped at limit`);
}

// S10. Limit clamped to max 100.
{
  const spec = { paths: { "/a": { get: { operationId: "user", responses: { "200": {} } } } } };
  const r = run("openapi-search", { spec, query: "user", limit: 99999 });
  ok(r.total === 1 && r.results.length === 1, `clamp doesn't break tiny result sets`);
}

// S11. Invalid limit rejected.
threw = false; try {
  run("openapi-search", { spec: { paths: {} }, query: "x", limit: 0 });
} catch { threw = true; }
ok(threw, `limit:0 rejected`);
threw = false; try {
  run("openapi-search", { spec: { paths: {} }, query: "x", limit: -5 });
} catch { threw = true; }
ok(threw, `negative limit rejected`);

// S12. Empty / whitespace / token-less query rejected.
threw = false; try { run("openapi-search", { spec: { paths: {} }, query: "" }); } catch { threw = true; }
ok(threw, `empty query rejected`);
threw = false; try { run("openapi-search", { spec: { paths: {} }, query: "   " }); } catch { threw = true; }
ok(threw, `whitespace query rejected`);
threw = false; try { run("openapi-search", { spec: { paths: {} }, query: "!@#$%^&" }); } catch { threw = true; }
ok(threw, `punctuation-only query yields no tokens → rejected`);

// S13. JSON-string spec input is accepted.
{
  const spec = JSON.stringify({ paths: { "/u": { get: { operationId: "getUser", responses: { "200": {} } } } } });
  const r = run("openapi-search", { spec, query: "user" });
  ok(r.total === 1, `string spec accepted`);
}

// S14. Missing "spec" / "query" rejected.
threw = false; try { run("openapi-search", { query: "x" }); } catch { threw = true; }
ok(threw, `missing "spec" rejected`);
threw = false; try { run("openapi-search", { spec: { paths: {} } }); } catch { threw = true; }
ok(threw, `missing "query" rejected`);

// S15. Empty paths spec → total:0.
{
  const r = run("openapi-search", { spec: { paths: {} }, query: "user" });
  ok(r.total === 0, `empty paths → 0`);
}

// ---------- openapi-validate-payload ----------

// Helper: build a spec with one operation + a given request body schema.
const reqSpec = (schema) => ({
  paths: { "/u": { post: {
    operationId: "u",
    requestBody: { content: { "application/json": { schema } } },
    responses: { "201": { description: "ok" } },
  } } },
});

// V1. Example round-trips exactly.
{
  const t = tool("openapi-validate-payload");
  const r = run("openapi-validate-payload", t.discovery.input);
  const expected = t.discovery.output.example;
  ok(JSON.stringify(r) === JSON.stringify(expected),
    `validate example round-trips exactly (got ${JSON.stringify(r)})`);
}

// V2. Valid payload → valid:true, errors:[].
{
  const spec = reqSpec({ type: "object", required: ["name"],
    properties: { name: { type: "string" } } });
  const r = run("openapi-validate-payload", { spec, operationId: "u", part: "request", payload: { name: "ok" } });
  ok(r.valid === true && r.schemaPresent === true && r.errors.length === 0,
    `valid payload passes (got ${JSON.stringify(r)})`);
}

// V3. Type mismatch is flagged.
{
  const spec = reqSpec({ type: "object", properties: { age: { type: "integer" } } });
  const r = run("openapi-validate-payload", { spec, operationId: "u", part: "request", payload: { age: "old" } });
  ok(r.valid === false && r.errors.some((e) => e.rule === "type" && e.path === ".age"),
    `type mismatch flagged at .age`);
}

// V4. Multiple required fields missing → reported in sorted order.
{
  const spec = reqSpec({ type: "object", required: ["zebra", "alpha", "mango"], properties: {} });
  const r = run("openapi-validate-payload", { spec, operationId: "u", part: "request", payload: {} });
  const missing = r.errors.filter((e) => e.rule === "required").map((e) => e.message);
  ok(JSON.stringify(missing) === JSON.stringify([
    "missing required field: alpha",
    "missing required field: mango",
    "missing required field: zebra",
  ]), `required errors sorted alphabetically (got ${JSON.stringify(missing)})`);
}

// V5. Enum violation.
{
  const spec = reqSpec({ type: "object", properties: { role: { type: "string", enum: ["a", "b"] } } });
  const r = run("openapi-validate-payload", { spec, operationId: "u", part: "request", payload: { role: "c" } });
  ok(r.errors.some((e) => e.rule === "enum" && e.path === ".role"), `enum violation flagged`);
}

// V6. additionalProperties:false flags unknown keys.
{
  const spec = reqSpec({ type: "object", properties: { name: { type: "string" } }, additionalProperties: false });
  const r = run("openapi-validate-payload", { spec, operationId: "u", part: "request", payload: { name: "x", junk: 1 } });
  ok(r.errors.some((e) => e.rule === "additionalProperties" && e.path === ".junk"),
    `unknown key flagged at .junk`);
}
// And the opposite: by default additionalProperties is allowed.
{
  const spec = reqSpec({ type: "object", properties: { name: { type: "string" } } });
  const r = run("openapi-validate-payload", { spec, operationId: "u", part: "request", payload: { name: "x", extra: 1 } });
  ok(r.valid === true, `extras silently allowed when additionalProperties omitted`);
}

// V7. Nested object recursion: errors carry the dotted path.
{
  const spec = reqSpec({ type: "object", properties: {
    user: { type: "object", required: ["name"],
      properties: { name: { type: "string" }, age: { type: "integer" } } } } });
  const r = run("openapi-validate-payload", { spec, operationId: "u", part: "request",
    payload: { user: { age: "five" } } });
  ok(r.errors.some((e) => e.path === ".user" && e.rule === "required" && e.message.includes("name"))
     && r.errors.some((e) => e.path === ".user.age" && e.rule === "type"),
    `nested errors carry full path (got ${JSON.stringify(r.errors)})`);
}

// V8. Array items validated; path uses [i] notation.
{
  const spec = reqSpec({ type: "object", properties: {
    tags: { type: "array", items: { type: "string" } } } });
  const r = run("openapi-validate-payload", { spec, operationId: "u", part: "request",
    payload: { tags: ["ok", 123, "also-ok"] } });
  ok(r.errors.length === 1 && r.errors[0].path === ".tags[1]" && r.errors[0].rule === "type",
    `array item type checked at [1] (got ${JSON.stringify(r.errors)})`);
}

// V9. oneOf: passes if any arm passes.
{
  const spec = reqSpec({ oneOf: [
    { type: "object", required: ["a"], properties: { a: { type: "string" } } },
    { type: "object", required: ["b"], properties: { b: { type: "integer" } } },
  ] });
  const r1 = run("openapi-validate-payload", { spec, operationId: "u", part: "request", payload: { a: "x" } });
  const r2 = run("openapi-validate-payload", { spec, operationId: "u", part: "request", payload: { b: 1 } });
  const r3 = run("openapi-validate-payload", { spec, operationId: "u", part: "request", payload: {} });
  ok(r1.valid && r2.valid && !r3.valid,
    `oneOf: a-arm and b-arm pass; empty fails`);
}

// V10. allOf: all arms must pass.
{
  const spec = reqSpec({ allOf: [
    { type: "object", required: ["a"] },
    { type: "object", required: ["b"] },
  ] });
  const r = run("openapi-validate-payload", { spec, operationId: "u", part: "request", payload: { a: 1 } });
  ok(!r.valid && r.errors.some((e) => e.message.includes("b")),
    `allOf: missing one arm's required surfaces error`);
}

// V11. $ref is not dereferenced — surfaced as an error so callers know.
{
  const spec = reqSpec({ $ref: "#/components/schemas/User" });
  const r = run("openapi-validate-payload", { spec, operationId: "u", part: "request", payload: {} });
  ok(r.errors.length === 1 && r.errors[0].rule === "ref-not-resolved",
    `$ref surfaced as ref-not-resolved`);
}

// V12. No schema documented → vacuously valid, schemaPresent:false.
{
  const spec = { paths: { "/u": { post: {
    operationId: "u", responses: { "201": { description: "ok" } } } } } };
  const r = run("openapi-validate-payload", { spec, operationId: "u", part: "request", payload: { anything: 1 } });
  ok(r.valid === true && r.schemaPresent === false && r.errors.length === 0,
    `no schema → schemaPresent:false, errors:[]`);
}

// V13. Response mode: defaults to first 2xx and validates against its schema.
{
  const spec = { paths: { "/u": { get: { operationId: "u", responses: {
    "200": { content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } } } },
    "400": {},
  } } } } };
  const r = run("openapi-validate-payload", { spec, operationId: "u", part: "response", payload: { id: 5 } });
  ok(r.valid === true && r.schemaPresent === true, `response 200 validates`);
}

// V14. Response mode: explicit status honored.
{
  const spec = { paths: { "/u": { get: { operationId: "u", responses: {
    "200": { content: { "application/json": { schema: { type: "object", properties: { v: { type: "integer" } } } } } },
    "201": { content: { "application/json": { schema: { type: "object", properties: { created: { type: "boolean" } } } } } },
  } } } } };
  const r = run("openapi-validate-payload", {
    spec, operationId: "u", part: "response", status: "201", payload: { created: "yes" } });
  ok(r.errors.some((e) => e.path === ".created" && e.rule === "type"),
    `explicit status uses its schema (got ${JSON.stringify(r.errors)})`);
}

// V15. Invalid part rejected.
threw = false; try {
  run("openapi-validate-payload", { spec: { paths: { "/u": { get: { operationId: "u", responses: { "200": {} } } } } },
    operationId: "u", part: "headers", payload: {} });
} catch { threw = true; }
ok(threw, `part:"headers" rejected`);

// V16. Missing spec / part / payload rejected.
threw = false; try { run("openapi-validate-payload", { part: "request", payload: {} }); } catch { threw = true; }
ok(threw, `missing "spec" rejected`);
threw = false; try { run("openapi-validate-payload", { spec: { paths: {} }, payload: {} }); } catch { threw = true; }
ok(threw, `missing "part" rejected`);
threw = false; try { run("openapi-validate-payload", { spec: { paths: {} }, part: "request" }); } catch { threw = true; }
ok(threw, `missing "payload" rejected`);

// V17. Nullable: schema.type array including "null" accepts null.
{
  const spec = reqSpec({ type: "object", properties: { x: { type: ["string", "null"] } } });
  const r1 = run("openapi-validate-payload", { spec, operationId: "u", part: "request", payload: { x: null } });
  const r2 = run("openapi-validate-payload", { spec, operationId: "u", part: "request", payload: { x: "ok" } });
  const r3 = run("openapi-validate-payload", { spec, operationId: "u", part: "request", payload: { x: 5 } });
  ok(r1.valid && r2.valid && !r3.valid,
    `nullable via type:[...] accepts null + string, rejects number`);
}

// V18. integer satisfies number (every int is a number per spec).
{
  const spec = reqSpec({ type: "object", properties: { x: { type: "number" } } });
  const r = run("openapi-validate-payload", { spec, operationId: "u", part: "request", payload: { x: 42 } });
  ok(r.valid === true, `integer satisfies number constraint`);
}

// ============================================================================
// openapi-redact
// ============================================================================

// R1. The discovery example round-trips byte-for-byte through the handler —
// the public contract for every tool in this kit.
{
  const t = tool("openapi-redact");
  const out = t.handler(t.discovery.input);
  const expected = t.discovery.output.example;
  ok(JSON.stringify(out) === JSON.stringify(expected),
    `openapi-redact example round-trips exactly\n  got      ${JSON.stringify(out)}\n  expected ${JSON.stringify(expected)}`);
}

// R2. Default strip removes examples + descriptions when `strip` is omitted.
{
  const spec = {
    openapi: "3.0.0",
    info: { title: "x", version: "1", description: "gone" },
    paths: { "/a": { get: { description: "gone", responses: { "200": { description: "ok" } } } } },
  };
  const r = run("openapi-redact", { spec });
  ok(r.removed.descriptions === 3, `default strips descriptions, got ${r.removed.descriptions}`);
  ok(r.spec.info.description === undefined && r.spec.paths["/a"].get.description === undefined,
    `default strip removed all descriptions in tree`);
}

// R3. Custom strip with a single category leaves other meta-fields alone.
{
  const spec = {
    openapi: "3.0.0",
    info: { title: "x", version: "1", description: "kept" },
    paths: { "/a": { get: { summary: "gone", description: "kept", responses: { "200": { description: "kept" } } } } },
  };
  const r = run("openapi-redact", { spec, strip: ["summaries"] });
  ok(r.removed.summaries === 1, `summaries-only strip count=1, got ${r.removed.summaries}`);
  ok(r.spec.info.description === "kept" && r.spec.paths["/a"].get.description === "kept",
    `summaries-only strip preserves descriptions`);
  ok(r.spec.paths["/a"].get.summary === undefined, `summary actually removed`);
}

// R4. sizeBefore > sizeAfter when anything is removed (and the size matches
// JSON.stringify of the actual returned spec, not some other computation).
{
  const spec = { openapi: "3.0.0", info: { title: "x", version: "1", description: "noise".repeat(50) }, paths: {} };
  const r = run("openapi-redact", { spec });
  ok(r.sizeBefore > r.sizeAfter, `size should shrink, before=${r.sizeBefore} after=${r.sizeAfter}`);
  ok(r.sizeAfter === JSON.stringify(r.spec).length, `sizeAfter matches JSON.stringify(spec).length`);
}

// R5. Empty strip array → spec unchanged, sizes equal, all counts zero.
{
  const spec = { openapi: "3.0.0", info: { title: "x", version: "1", description: "keep" }, paths: { "/a": { get: { summary: "keep", responses: {} } } } };
  const r = run("openapi-redact", { spec, strip: [] });
  ok(JSON.stringify(r.spec) === JSON.stringify(spec), `empty strip leaves spec unchanged`);
  ok(r.sizeBefore === r.sizeAfter, `empty strip → equal sizes`);
  ok(Object.keys(r.removed).length === 0, `empty strip → no categories in removed`);
}

// R6. Unknown strip category is rejected with a helpful message listing
// valid categories.
{
  let err = null;
  try { run("openapi-redact", { spec: { openapi: "3.0.0", paths: {} }, strip: ["bogus"] }); }
  catch (e) { err = e; }
  ok(err && /unknown strip category/i.test(err.message),
    `unknown category should error, got: ${err && err.message}`);
  ok(err && /examples/.test(err.message) && /descriptions/.test(err.message),
    `error should list valid categories`);
}

// R7. User-defined property literally named "example" is PROTECTED. The
// stripper walks `properties: { ... }` with userKeysHere=true so the key
// stays, but it continues recursing into the value, so meta-`example` keys
// inside that schema are still removed.
{
  const spec = {
    openapi: "3.0.0",
    paths: { "/a": { post: { requestBody: { content: { "application/json": { schema: {
      type: "object",
      properties: {
        example: { type: "string", example: "this-meta-example-goes-away" },
        description: { type: "string" },
      },
    } } } }, responses: {} } } },
  };
  const r = run("openapi-redact", { spec, strip: ["examples"] });
  const props = r.spec.paths["/a"].post.requestBody.content["application/json"].schema.properties;
  ok(props.example !== undefined, `user property named "example" preserved under properties:`);
  ok(props.description !== undefined, `user property named "description" preserved under properties:`);
  ok(props.example.example === undefined, `meta-example inside user property's schema is still stripped`);
  ok(r.removed.examples === 1, `exactly one meta-example removed, got ${r.removed.examples}`);
}

// R8. tags strip removes both top-level tags array and per-operation tags.
{
  const spec = {
    openapi: "3.0.0",
    tags: [{ name: "users", description: "User ops" }],
    paths: { "/a": { get: { tags: ["users"], responses: {} } } },
  };
  const r = run("openapi-redact", { spec, strip: ["tags"] });
  ok(r.spec.tags === undefined, `top-level tags removed`);
  ok(r.spec.paths["/a"].get.tags === undefined, `operation tags removed`);
  ok(r.removed.tags === 2, `tags count=2, got ${r.removed.tags}`);
}

// R9. JSON-string input is accepted (matches parseMaybeJson contract used
// by every other tool in this kit).
{
  const spec = { openapi: "3.0.0", info: { title: "x", version: "1", description: "gone" }, paths: {} };
  const r = run("openapi-redact", { spec: JSON.stringify(spec), strip: ["descriptions"] });
  ok(r.spec.info.description === undefined && r.removed.descriptions === 1,
    `JSON-string spec accepted and processed identically`);
}

// R10. Missing "spec" is rejected with a 400-shaped error.
{
  let err = null;
  try { run("openapi-redact", { strip: ["examples"] }); } catch (e) { err = e; }
  ok(err && err.statusCode === 400 && /spec/i.test(err.message),
    `missing spec rejected with 400, got: ${err && err.message}`);
}

// ============================================================================
// openapi-resolve-refs
// ============================================================================

// RR1. Discovery example round-trips byte-for-byte through the handler.
{
  const t = tool("openapi-resolve-refs");
  const out = t.handler(t.discovery.input);
  const expected = t.discovery.output.example;
  ok(JSON.stringify(out) === JSON.stringify(expected),
    `openapi-resolve-refs example round-trips exactly\n  got      ${JSON.stringify(out)}\n  expected ${JSON.stringify(expected)}`);
}

// RR2. Simple one-level ref inlines the target value.
{
  const spec = {
    openapi: "3.0.0",
    paths: { "/u": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/U" } } } } } } } },
    components: { schemas: { U: { type: "string" } } },
  };
  const r = run("openapi-resolve-refs", { spec });
  ok(r.spec.paths["/u"].get.responses["200"].content["application/json"].schema.type === "string",
    `simple ref inlined to the target type`);
  ok(r.resolved === 1, `resolved count=1, got ${r.resolved}`);
}

// RR3. Nested refs: A points to B, both get inlined.
{
  const spec = {
    paths: { "/x": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/A" } } } } } } } },
    components: { schemas: {
      A: { type: "object", properties: { b: { $ref: "#/components/schemas/B" } } },
      B: { type: "integer" },
    } },
  };
  const r = run("openapi-resolve-refs", { spec });
  const schema = r.spec.paths["/x"].get.responses["200"].content["application/json"].schema;
  ok(schema.type === "object" && schema.properties.b.type === "integer",
    `nested ref fully inlined`);
  // A resolves once at /x, B resolves twice: once inside the inlined /x copy and
  // once inside components.schemas.A (we walk components too for consistency).
  ok(r.resolved === 3, `resolved count=3 (A once, B twice — inside /x + inside components.A), got ${r.resolved}`);
}

// RR4. Self-referential schema (A → A) is detected as circular; the inner
// `$ref` stays intact and one occurrence is reported.
{
  const spec = {
    paths: { "/n": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } } } } } } },
    components: { schemas: { Node: { type: "object", properties: { next: { $ref: "#/components/schemas/Node" } } } } },
  };
  const r = run("openapi-resolve-refs", { spec });
  const schema = r.spec.paths["/n"].get.responses["200"].content["application/json"].schema;
  ok(schema.type === "object" && schema.properties.next.$ref === "#/components/schemas/Node",
    `cycle leaves inner $ref intact`);
  ok(r.circular.includes("#/components/schemas/Node"), `circular reports the ref`);
}

// RR5. Two-step cycle A → B → A is also detected. We expect ONE entry per
// distinct ref in `circular`, regardless of how many times we hit it.
{
  const spec = {
    paths: { "/c": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/A" } } } } } } } },
    components: { schemas: {
      A: { type: "object", properties: { b: { $ref: "#/components/schemas/B" } } },
      B: { type: "object", properties: { a: { $ref: "#/components/schemas/A" } } },
    } },
  };
  const r = run("openapi-resolve-refs", { spec });
  ok(r.circular.includes("#/components/schemas/A"), `two-step cycle includes A`);
  ok(r.circular.filter((x) => x === "#/components/schemas/A").length === 1, `each circular ref recorded once`);
}

// RR6. Unresolved ref: the target doesn't exist. We leave the $ref node as-is
// and add it to `unresolved`. Never throws.
{
  const spec = {
    paths: { "/m": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Missing" } } } } } } } },
    components: { schemas: {} },
  };
  const r = run("openapi-resolve-refs", { spec });
  ok(r.spec.paths["/m"].get.responses["200"].content["application/json"].schema.$ref === "#/components/schemas/Missing",
    `unresolved ref left intact`);
  ok(r.unresolved[0] === "#/components/schemas/Missing", `unresolved reports the ref`);
  ok(r.resolved === 0, `nothing actually resolved`);
}

// RR7. External ref (http://) is never fetched — reported and left as-is.
{
  const spec = {
    paths: { "/e": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "http://example.com/schema.json" } } } } } } } },
  };
  const r = run("openapi-resolve-refs", { spec });
  ok(r.spec.paths["/e"].get.responses["200"].content["application/json"].schema.$ref === "http://example.com/schema.json",
    `external ref left intact`);
  ok(r.external[0] === "http://example.com/schema.json", `external reports the ref`);
}

// RR8. Swagger 2.x: `#/definitions/...` resolves the same way as
// `#/components/schemas/...` does for OpenAPI 3 — it's just a different
// JSON pointer, and we follow whatever pointer the spec writes.
{
  const spec = {
    swagger: "2.0",
    paths: { "/u": { get: { responses: { "200": { schema: { $ref: "#/definitions/User" } } } } } },
    definitions: { User: { type: "object", properties: { id: { type: "string" } } } },
  };
  const r = run("openapi-resolve-refs", { spec });
  ok(r.spec.paths["/u"].get.responses["200"].schema.type === "object", `Swagger 2.x definitions ref resolves`);
}

// RR9. Sibling keys of `$ref` are dropped — Draft 7 / OpenAPI 3.0 semantics.
// The `description` and `nullable` next to the $ref do NOT survive the merge.
{
  const spec = {
    paths: { "/s": { get: { responses: { "200": { content: { "application/json": {
      schema: { $ref: "#/components/schemas/U", description: "ignored", nullable: true },
    } } } } } } },
    components: { schemas: { U: { type: "string" } } },
  };
  const r = run("openapi-resolve-refs", { spec });
  const schema = r.spec.paths["/s"].get.responses["200"].content["application/json"].schema;
  ok(schema.type === "string", `target value replaces the $ref node`);
  ok(schema.description === undefined && schema.nullable === undefined, `sibling keys are dropped`);
}

// RR10. JSON pointer escaping: `~1` decodes to `/`, `~0` decodes to `~`. A
// component key literally named `weird/key~1` is reachable via
// `#/components/schemas/weird~1key~01`.
{
  const spec = {
    paths: { "/w": { get: { responses: { "200": { content: { "application/json": {
      schema: { $ref: "#/components/schemas/weird~1key~01" },
    } } } } } } },
    components: { schemas: { "weird/key~1": { type: "boolean" } } },
  };
  const r = run("openapi-resolve-refs", { spec });
  ok(r.spec.paths["/w"].get.responses["200"].content["application/json"].schema.type === "boolean",
    `pointer escapes (~1 → /, ~0 → ~) decoded correctly`);
}

// RR11. Same ref used in two independent branches: BOTH resolve, neither is
// flagged as circular (per-branch tracking, not global).
{
  const spec = {
    paths: {
      "/a": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/X" } } } } } } },
      "/b": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/X" } } } } } } },
    },
    components: { schemas: { X: { type: "number" } } },
  };
  const r = run("openapi-resolve-refs", { spec });
  ok(r.spec.paths["/a"].get.responses["200"].content["application/json"].schema.type === "number"
    && r.spec.paths["/b"].get.responses["200"].content["application/json"].schema.type === "number",
    `sibling refs to same target both resolve`);
  ok(r.circular.length === 0, `sibling reuse is not a cycle`);
}

// RR12. JSON-string input is accepted (matches parseMaybeJson contract).
{
  const spec = {
    paths: { "/j": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/U" } } } } } } } },
    components: { schemas: { U: { type: "string" } } },
  };
  const r = run("openapi-resolve-refs", { spec: JSON.stringify(spec) });
  ok(r.spec.paths["/j"].get.responses["200"].content["application/json"].schema.type === "string",
    `JSON-string spec accepted`);
}

// RR13. Missing "spec" rejected with a 400-shaped error.
{
  let err = null;
  try { run("openapi-resolve-refs", {}); } catch (e) { err = e; }
  ok(err && err.statusCode === 400 && /spec/i.test(err.message),
    `missing spec rejected with 400, got: ${err && err.message}`);
}

// ============================================================================
// openapi-security-summary
// ============================================================================

// SS1. Discovery example round-trips byte-for-byte. This also asserts the
// load-bearing rule that `security: []` on an op renders `open: true` while
// the rest of the doc still inherits the global default.
{
  const t = tool("openapi-security-summary");
  const out = t.handler(t.discovery.input);
  const expected = t.discovery.output.example;
  ok(JSON.stringify(out) === JSON.stringify(expected),
    `openapi-security-summary example round-trips exactly\n  got      ${JSON.stringify(out)}\n  expected ${JSON.stringify(expected)}`);
}

// SS2. A spec with no auth at all → empty schemes, every op open.
{
  const spec = { openapi: "3.0.0", paths: { "/a": { get: { responses: { "200": {} } } } } };
  const r = run("openapi-security-summary", { spec });
  ok(Object.keys(r.schemes).length === 0, `no schemes`);
  ok(r.operations[0].open === true, `op is open`);
  ok(r.summary.securedOperations === 0 && r.summary.openOperations === 1, `summary counts match`);
}

// SS3. Global security only (no op overrides) → every op inherits and shows
// the same `security` array, all are secured.
{
  const spec = {
    openapi: "3.0.0",
    security: [{ apiKey: [] }],
    paths: {
      "/a": { get: { responses: { "200": {} } } },
      "/b": { post: { responses: { "201": {} } } },
    },
    components: { securitySchemes: { apiKey: { type: "apiKey", name: "X-API-Key", in: "header" } } },
  };
  const r = run("openapi-security-summary", { spec });
  ok(r.operations.every((o) => JSON.stringify(o.security) === JSON.stringify([{ apiKey: [] }])),
    `every op inherits global security`);
  ok(r.summary.securedOperations === 2 && r.summary.openOperations === 0,
    `both ops counted as secured`);
  ok(r.summary.schemeUsage.apiKey === 2, `schemeUsage credits both ops`);
}

// SS4. Op-level `security: []` is the load-bearing edge case — explicitly
// open, NOT inheriting the global default. This is exactly the bug an
// agent would otherwise hit (attaching a token to a public endpoint).
{
  const spec = {
    openapi: "3.0.0",
    security: [{ apiKey: [] }],
    paths: {
      "/secure": { get: { responses: { "200": {} } } },
      "/healthz": { get: { security: [], responses: { "200": {} } } },
    },
    components: { securitySchemes: { apiKey: { type: "apiKey", name: "X-API-Key", in: "header" } } },
  };
  const r = run("openapi-security-summary", { spec });
  const healthz = r.operations.find((o) => o.path === "/healthz");
  const secure = r.operations.find((o) => o.path === "/secure");
  ok(healthz.open === true && healthz.security.length === 0,
    `op-level [] overrides global → open`);
  ok(secure.open === false && JSON.stringify(secure.security) === JSON.stringify([{ apiKey: [] }]),
    `other ops still inherit global`);
  ok(r.summary.openOperations === 1 && r.summary.securedOperations === 1, `summary splits the count`);
}

// SS5. Op-level non-empty override replaces the global default for that op.
{
  const spec = {
    openapi: "3.0.0",
    security: [{ apiKey: [] }],
    paths: { "/admin": { post: { security: [{ oauth: ["admin:write"] }], responses: { "201": {} } } } },
    components: { securitySchemes: {
      apiKey: { type: "apiKey", name: "X-API-Key", in: "header" },
      oauth: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "https://x/t", scopes: { "admin:write": "x" } } } },
    } },
  };
  const r = run("openapi-security-summary", { spec });
  ok(JSON.stringify(r.operations[0].security) === JSON.stringify([{ oauth: ["admin:write"] }]),
    `op-level non-empty override wins`);
  ok(r.summary.schemeUsage.oauth === 1 && r.summary.schemeUsage.apiKey === 0,
    `schemeUsage tracks the effective scheme, not the global default`);
}

// SS6. Multi-scheme catalog passes through `securitySchemes` verbatim so
// callers can read type-specific fields (apiKey: name+in; http: scheme;
// oauth2: flows).
{
  const spec = {
    openapi: "3.0.0",
    paths: { "/a": { get: { responses: { "200": {} } } } },
    components: { securitySchemes: {
      apiKey: { type: "apiKey", name: "X-Key", in: "query" },
      bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      oauth: { type: "oauth2", flows: { authorizationCode: { authorizationUrl: "a", tokenUrl: "t", scopes: {} } } },
    } },
  };
  const r = run("openapi-security-summary", { spec });
  ok(r.schemes.apiKey.in === "query" && r.schemes.apiKey.name === "X-Key", `apiKey type fields preserved`);
  ok(r.schemes.bearer.scheme === "bearer" && r.schemes.bearer.bearerFormat === "JWT", `http type fields preserved`);
  ok(r.schemes.oauth.flows.authorizationCode.tokenUrl === "t", `oauth flows preserved`);
}

// SS7. Swagger 2.x uses `securityDefinitions` instead of
// `components.securitySchemes`. Same semantics, different home.
{
  const spec = {
    swagger: "2.0",
    securityDefinitions: { basic: { type: "basic" } },
    security: [{ basic: [] }],
    paths: { "/a": { get: { responses: { "200": {} } } } },
  };
  const r = run("openapi-security-summary", { spec });
  ok(r.schemes.basic && r.schemes.basic.type === "basic", `Swagger 2 securityDefinitions cataloged`);
  ok(r.operations[0].open === false && r.summary.schemeUsage.basic === 1, `usage counted from Swagger global`);
}

// SS8. Multi-scheme single requirement (AND) and multi-requirement (OR)
// both contribute exactly +1 to each named scheme — per-op de-duplication.
{
  const spec = {
    openapi: "3.0.0",
    paths: {
      "/and": { get: { security: [{ a: [], b: [] }], responses: { "200": {} } } },
      "/or":  { get: { security: [{ a: [] }, { b: [] }], responses: { "200": {} } } },
    },
    components: { securitySchemes: { a: { type: "apiKey", name: "A", in: "header" }, b: { type: "apiKey", name: "B", in: "header" } } },
  };
  const r = run("openapi-security-summary", { spec });
  ok(r.summary.schemeUsage.a === 2 && r.summary.schemeUsage.b === 2,
    `each op contributes +1 per referenced scheme regardless of AND/OR shape`);
}

// SS9. JSON-string input is accepted.
{
  const spec = { openapi: "3.0.0", paths: { "/a": { get: { responses: { "200": {} } } } } };
  const r = run("openapi-security-summary", { spec: JSON.stringify(spec) });
  ok(r.operations.length === 1, `JSON-string spec accepted`);
}

// SS10. Missing "spec" rejected with a 400-shaped error.
{
  let err = null;
  try { run("openapi-security-summary", {}); } catch (e) { err = e; }
  ok(err && err.statusCode === 400 && /spec/i.test(err.message),
    `missing spec rejected with 400, got: ${err && err.message}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
