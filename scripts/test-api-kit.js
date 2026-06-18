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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
