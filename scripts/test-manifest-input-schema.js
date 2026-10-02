// A route's input schema declared in the seller's /.well-known/x402 manifest
// (`input_schema` or `inputSchema`) becomes its requestContract, labeled
// source "seller_manifest" (issue #1503). OpenAPI still wins when both
// exist. Offline.
import assert from "node:assert/strict";
process.env.X402_INDEX_CRAWL = "off";
const { normaliseManifestTools, mergeManifestIntoTools } = await import("../src/x402-index.js");
const { requestContractProjection, requestContractFromInputSchema, packRequestContract, unpackRequestContract } = await import("../src/request-contract.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const O = "https://seller.example.com";
const contract = (t) => requestContractProjection(t).requestContract;

// snake_case, as issue #1503's manifest publishes it
const snake = normaliseManifestTools({ resources: [
  { resource: `${O}/v1/quote`, method: "POST", price_usd: 0.01, description: "Quote", input_schema: { type: "object", required: ["ticker", "opts"], properties: { ticker: { type: "string" }, opts: { type: "object", required: ["window"], properties: { window: { type: "integer" } } } } } },
  { resource: `${O}/v1/lookup`, method: "GET", price_usd: 0.01, description: "Lookup", input_schema: { type: "object", required: ["q"], properties: { q: { type: "string" } } } },
  { resource: `${O}/v1/free-form`, method: "POST", price_usd: 0.01, description: "No schema", input_schema: null },
] }, O);
const byRoute = Object.fromEntries(snake.map((t) => [t.route, t]));
const q = contract(byRoute["/v1/quote"]);
ok(q && q.source === "seller_manifest" && q.state === "declared" && JSON.stringify(q.required) === JSON.stringify({ body: ["ticker", "opts", "opts.window"] }), `a POST route's input_schema becomes its required body fields (${JSON.stringify(q)})`);
const l = contract(byRoute["/v1/lookup"]);
ok(l && JSON.stringify(l.required) === JSON.stringify({ query: ["q"] }), "a GET route's required names are query parameters");
ok(!contract(byRoute["/v1/free-form"]), "a null input_schema declares nothing (unknown, not absent)");

// camelCase, as the manifest format in the wild also carries it
const camel = normaliseManifestTools({ resources: [{ resource: `${O}/buy`, method: "POST", price: "0.01 USDC", inputSchema: { type: "object", required: ["need"], properties: { need: { type: "string" } } } }] }, O);
ok(JSON.stringify(contract(camel[0])?.required) === JSON.stringify({ body: ["need"] }), "inputSchema (camelCase) is read the same way");

// unsafe or unsupported shapes are never relayed
const weird = requestContractFromInputSchema({ type: "object", required: ["ok", "__proto__", "bad name!"], properties: {} }, "POST");
ok(JSON.stringify(weird.required) === JSON.stringify({ body: ["ok"] }), "names we will not publish are dropped");
ok(requestContractFromInputSchema({ anyOf: [{ required: ["a"] }] }, "POST").state === "partial", "a schema form we do not read is partial, never a guessed list");

// OpenAPI wins; a manifest contract only fills a gap
const fromOpenapi = [{ route: "/buy", method: "POST", seller: O, requestContract: ["declared", { body: ["fromOpenapi"] }] }];
const merged = mergeManifestIntoTools(camel, fromOpenapi);
ok(contract(merged.find((t) => t.route === "/buy")).required.body[0] === "fromOpenapi", "a contract read from OpenAPI outranks the manifest's");
const gap = mergeManifestIntoTools(camel, [{ route: "/buy", method: "POST", seller: O }]);
ok(contract(gap.find((t) => t.route === "/buy"))?.source === "seller_manifest", "a route OpenAPI documents without a body schema takes the manifest's");

// "requires nothing" is published, and only for a real JSON Schema
const empty = normaliseManifestTools({ resources: [
  { resource: `${O}/v1/portfolio`, method: "GET", price_usd: 0.01, description: "No inputs", input_schema: { type: "object", properties: { window: { type: "string" } } } },
  { resource: `${O}/v1/bare`, method: "POST", price_usd: 0.01, description: "Bare object", input_schema: { type: "object" } },
  { resource: `${O}/v1/prose`, method: "GET", price_usd: 0.01, description: "Prose map", input_schema: { payTo: "string, query param, the wallet to read" } },
  { resource: `${O}/v1/typed-prose`, method: "GET", price_usd: 0.01, description: "Prose under properties", input_schema: { type: "object", properties: { payTo: "string" } } },
] }, O);
const byEmpty = Object.fromEntries(empty.map((t) => [t.route, t]));
const pf = contract(byEmpty["/v1/portfolio"]);
ok(pf && pf.state === "absent" && pf.source === "seller_manifest" && Object.keys(pf.required).length === 0, `a JSON Schema with no required list publishes absent (${JSON.stringify(pf)})`);
ok(contract(byEmpty["/v1/bare"])?.state === "absent", "a bare {type:object} schema is absent too");
ok(!contract(byEmpty["/v1/prose"]), "a map of field names to prose is not a JSON Schema and publishes nothing (unknown), never absent");
ok(!contract(byEmpty["/v1/typed-prose"]), "prose values under properties are not JSON Schema either");

// a list of names outranks "requires nothing", whichever side it came from
const namedManifest = normaliseManifestTools({ resources: [{ resource: `${O}/pick`, method: "POST", price: "0.01 USDC", inputSchema: { type: "object", required: ["need"], properties: { need: { type: "string" } } } }] }, O);
const overAbsent = mergeManifestIntoTools(namedManifest, [{ route: "/pick", method: "POST", seller: O, requestContract: ["absent", {}] }]);
ok(JSON.stringify(contract(overAbsent.find((t) => t.route === "/pick"))?.required) === JSON.stringify({ body: ["need"] }), "a manifest's required names fill an OpenAPI operation documented with no parameters");
const absentManifest = normaliseManifestTools({ resources: [{ resource: `${O}/keep`, method: "POST", price: "0.01 USDC", inputSchema: { type: "object" } }] }, O);
const keepNamed = mergeManifestIntoTools(absentManifest, [{ route: "/keep", method: "POST", seller: O, requestContract: ["declared", { body: ["fromOpenapi"] }] }]);
ok(contract(keepNamed.find((t) => t.route === "/keep")).required.body[0] === "fromOpenapi", "a manifest's absent never replaces OpenAPI's names");
const absentFill = mergeManifestIntoTools(absentManifest, [{ route: "/keep", method: "POST", seller: O }]);
ok(contract(absentFill.find((t) => t.route === "/keep"))?.state === "absent", "a manifest's absent fills a route with no contract at all");

// the cache tuple stays compatible
ok(unpackRequestContract({ requestContract: ["declared", { body: ["a"] }] }).source === "seller_openapi", "a two-element tuple (every older cache) still reads as OpenAPI");
ok(unpackRequestContract({ requestContract: ["declared", { body: ["a"] }, "somewhere_else"] }) === null, "an unknown source is refused on the way out");
ok(JSON.stringify(packRequestContract({ state: "declared", source: "seller_manifest", required: { body: ["a"] } })) === JSON.stringify(["declared", { body: ["a"] }, "seller_manifest"]), "a manifest contract packs with its source");

console.log(`test-manifest-input-schema: ${n} passed`);
