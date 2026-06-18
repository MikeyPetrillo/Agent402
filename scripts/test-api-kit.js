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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
