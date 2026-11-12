#!/usr/bin/env node
// boundedSchema trims a JSON schema to a byte budget for the 402 challenge:
// descriptions first, then nested detail, down to names and types. Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { boundedSchema, schemaFromExample, responseSchemaFor, boundedResponseSchemaFor } from "../src/openapi-schema.js";
import { boundDiscoveryBlock } from "../src/payments.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const size = (s) => JSON.stringify(s).length;

const small = { type: "object", properties: { q: { type: "string", description: "the query" } }, required: ["q"] };
ok(boundedSchema(small, 900) === small, "a schema inside the budget is returned untouched (same object)");

const big = { type: "object", required: ["messages"], properties: {
  model: { type: "string", description: "x".repeat(300) },
  messages: { type: "array", description: "y".repeat(300), items: { type: "object", properties: { role: { type: "string", enum: ["system", "user", "assistant", "tool"], description: "z".repeat(200) }, content: { type: "string", description: "w".repeat(200) }, tool_calls: { type: "array", items: { type: "object", properties: { id: { type: "string" }, function: { type: "object", properties: { name: { type: "string" }, arguments: { type: "string" } } } } } } } } },
  tools: { type: "array", items: { type: "object", properties: { type: { type: "string" }, function: { type: "object", properties: { name: { type: "string" }, parameters: { type: "object" } } } } } },
  max_tokens: { type: "integer", description: "v".repeat(100) },
} };
ok(size(big) > 1500, `the fixture is well over budget (${size(big)} bytes)`);
const b = boundedSchema(big, 900);
ok(b && size(b) <= 900, `bounded to the budget (${size(b)} bytes)`);
ok(Object.keys(b.properties).join(",") === "model,messages,tools,max_tokens" && JSON.stringify(b.required) === '["messages"]', "top-level property names and required survive");
ok(!JSON.stringify(b).includes("description"), "descriptions go first");
ok(b.properties.messages.type === "array" && b.properties.max_tokens.type === "integer", "top-level types survive");
ok(JSON.stringify(b).includes('"enum"') && JSON.stringify(b).includes("tool_calls"), "stripping descriptions alone met this budget, so enums and nesting are intact");
const b3 = boundedSchema(big, 400);
ok(b3 && size(b3) <= 400 && size(b3) < size(b) && !JSON.stringify(b3).includes("tool_calls"), `a tighter budget drops nested detail before names and types (${size(b3)} < ${size(b)})`);
const bare = boundedSchema(big, 60);
ok(bare && bare.type === "object" && JSON.stringify(bare.required) === '["messages"]' && !bare.properties, "a tiny budget leaves type and required only");
ok(boundedSchema(big, 10) === null && boundedSchema(null, 900) === null && boundedSchema("x", 900) === null, "an impossible budget or a non-schema answers null");
const enumy = { type: "object", properties: { n: { type: "string", enum: Array.from({ length: 40 }, (_, i) => `v${i}`), description: "q".repeat(400) } } };
const be = boundedSchema(enumy, 300);
ok(be && be.properties.n.enum.length === 12, `a long enum is cut to twelve values (${be?.properties?.n?.enum?.length})`);
const proto = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string","description":"' + "p".repeat(400) + '"},"a":{"type":"string"}}}');
const bp = boundedSchema(proto, 200);
ok(bp && Object.hasOwn(bp.properties, "__proto__") && ({}).type === undefined && Object.getPrototypeOf(bp.properties) === Object.prototype, "a __proto__ property name stays an own key and pollutes nothing");

// ---- the whole discovery block: schema first, then the example, never a schema without its example
{
  const example = { plan: Array.from({ length: 12 }, (_, i) => ({ step: i + 1, tool: "t".repeat(60) })) };
  const block = { bodyType: "json", input: { task: "x" }, inputSchema: { type: "object", properties: { task: { type: "string" } } }, output: { type: "json", example, schema: { type: "object", properties: { plan: { type: "array" } } } } };
  ok(boundDiscoveryBlock(block, 5000) === block, "a block inside the budget is returned untouched");
  const mid = boundDiscoveryBlock(block, size(block) - 20);
  ok(mid.output.schema === undefined && mid.output.example === example, "just over the budget: the output schema goes, the example stays");
  const tight = boundDiscoveryBlock(block, 300);
  ok(tight.output.schema === undefined && tight.output.example.truncated === true && /openapi\.json/.test(tight.output.example.note), "well over the budget: the example becomes the truncation note and no schema survives");
  ok(block.output.schema && block.output.example === example, "the caller's block is not mutated");
  ok(boundDiscoveryBlock(null, 100) === null, "no block, no change");
}
// An inferred number is `number`: an example's 1 (a confidence, a
// probability, a price that landed whole) never declares `integer`, which a
// fractional answer would break. Hand-declared input schemas keep `integer`.
{
  const ex = { confidence: 1, probabilities: [{ value: "a", probability: 1 }], mean: 3, nested: { temp: 20 }, list: [1, 2] };
  const walk = (x, out = []) => { if (x && typeof x === "object") { if (x.type === "integer") out.push(x); for (const v of Object.values(x)) walk(v, out); } return out; };
  ok(walk(schemaFromExample(ex)).length === 0 && schemaFromExample(ex).properties.confidence.type === "number", "inferred: a whole-number example is typed number, at every depth");
  ok(walk(responseSchemaFor("/api/loop-gate", ex)).length === 0, "inferred: the /openapi.json 200 schema declares no integer");
  ok(walk(boundedResponseSchemaFor("/api/loop-gate", ex, 500)).length === 0, "inferred: the 402's bounded output schema declares no integer");
  ok(boundedResponseSchemaFor(null, 7, 500)?.type === "number", "inferred: a raw whole-number output is typed number");
  ok(boundedSchema({ type: "object", properties: { n: { type: "integer", minimum: 1 } } }, 900).properties.n.type === "integer", "declared: a hand-written integer input stays integer");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
