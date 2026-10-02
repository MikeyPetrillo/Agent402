// A seller's request and response contracts are read through LOCAL $refs
// (#/components/...), the shape FastAPI emits for every body. Before this every
// such seller read "partial, nothing required" (reported 2026-09-25: a required
// `query` field was invisible). Pinned offline:
//   1. a request body behind a local $ref reads "declared" with its required field;
//   2. a response body behind a local $ref yields guaranteed paths;
//   3. an external, dangling or cyclic $ref is left in place and still reads partial;
//   4. a pointer through a prototype-reserved name resolves to nothing.
import assert from "node:assert/strict";
process.env.X402_INDEX_CRAWL = "off";
const { normaliseOpenapiTools } = await import("../src/x402-index.js");
const { resolveLocalRefs } = await import("../src/openapi-deref.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const ORIGIN = "https://seller.example.com";
const paid = { "x-payment-info": { price: "0.02", network: "base" } };
const doc = (paths, schemas) => ({ openapi: "3.1.0", info: { title: "t", version: "1" }, paths, components: { schemas } });
const opBody = (ref, resRef) => ({
  post: {
    operationId: "search_live_web_readable_content", summary: "Search live web", ...paid,
    requestBody: { required: true, content: { "application/json": { schema: { $ref: ref } } } },
    responses: { 200: { description: "ok", content: { "application/json": { schema: { $ref: resRef } } } } },
  },
});
const rowFor = (d) => normaliseOpenapiTools(d, ORIGIN).find((t) => t.route === "/search-read");

// --- 1 + 2. FastAPI shape
const fast = doc({ "/search-read": opBody("#/components/schemas/SearchReadInput", "#/components/schemas/SearchReadOutput") }, {
  SearchReadInput: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
  SearchReadOutput: { type: "object", required: ["results"], properties: { results: { type: "array", items: { type: "object" } } } },
});
const row = rowFor(fast);
const rc = row?.requestContract;
ok(rc && JSON.stringify(rc).includes("query") && !JSON.stringify(rc).includes("partial"), `a required field behind a local $ref is declared (${JSON.stringify(rc)})`);
ok(row?.responseContract && JSON.stringify(row.responseContract).includes("results"), `a response behind a local $ref yields its guaranteed path (${JSON.stringify(row?.responseContract)})`);

// --- 3. what is NOT followed
const external = rowFor(doc({ "/search-read": opBody("https://other.example.com/schemas.json#/X", "#/components/schemas/Missing") }, {}));
ok(!external?.requestContract || JSON.stringify(external.requestContract).includes("partial"), `an external $ref is not fetched and reads partial (${JSON.stringify(external?.requestContract)})`);
const cyc = { A: { type: "object", required: ["a"], properties: { a: { $ref: "#/components/schemas/A" } } } };
const resolved = resolveLocalRefs({ $ref: "#/components/schemas/A" }, { components: { schemas: cyc } });
ok(resolved.properties.a.$ref === "#/components/schemas/A", "a cyclic $ref is left in place instead of looping");
ok(resolveLocalRefs({ $ref: "#/components/schemas/Nope" }, { components: { schemas: {} } }).$ref === "#/components/schemas/Nope", "a dangling $ref is left in place");

// --- 4. prototype-reserved names
const poisoned = resolveLocalRefs({ $ref: "#/__proto__/polluted" }, { components: {} });
ok(poisoned.$ref === "#/__proto__/polluted" && ({}).polluted === undefined, "a pointer through __proto__ resolves to nothing and pollutes nothing");
const withProtoKey = resolveLocalRefs(JSON.parse('{"type":"object","__proto__":{"x":1}}'), {});
ok(!Object.prototype.hasOwnProperty.call(withProtoKey, "__proto__") && ({}).x === undefined, "a __proto__ key in a schema is dropped");

console.log(`test-openapi-local-refs: ${n} passed`);
