// Exact-output tests for the agent-kit (token-count, text-chunk, json-validate,
// jsonl). Pure functions, no server needed.
import { AGENT_TOOLS } from "../src/tools/agent-kit.js";

const tool = (slug) => AGENT_TOOLS.find((t) => t.slug === slug);
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const run = (slug, input) => tool(slug).handler(input);

// token-count: exact BPE
let r = await run("token-count", { text: "hello world", model: "gpt-4o" });
ok(r.tokens === 2 && r.encoding === "o200k_base", `token-count gpt-4o "hello world" = 2 (got ${r.tokens}, ${r.encoding})`);
r = await run("token-count", { text: "hello world", model: "gpt-4" });
ok(r.tokens === 2 && r.encoding === "cl100k_base", `token-count gpt-4 cl100k (got ${r.tokens}, ${r.encoding})`);
r = await run("token-count", { text: "The quick brown fox jumps over the lazy dog", model: "gpt-4o" });
ok(r.tokens === 9 && r.characters === 43, `token-count sentence = 9 tokens / 43 chars (got ${r.tokens}/${r.characters})`);

// text-chunk: chars with overlap
r = await run("text-chunk", { text: "abcdefghij", size: 4, overlap: 1, unit: "chars" });
ok(JSON.stringify(r.chunks) === JSON.stringify(["abcd", "defg", "ghij", "j"]), `text-chunk chars size4 overlap1 (got ${JSON.stringify(r.chunks)})`);
// text-chunk: tokens round-trips back to original text when concatenated without overlap
r = await run("text-chunk", { text: "The quick brown fox jumps over the lazy dog", size: 3, overlap: 0, unit: "tokens" });
ok(r.chunks.join("") === "The quick brown fox jumps over the lazy dog", `text-chunk tokens reassembles original (got ${r.count} chunks)`);

// json-validate: pass + fail
r = run("json-validate", { data: { name: "x", age: 3 }, schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, age: { type: "integer", minimum: 0 } } } });
ok(r.valid === true && r.errors.length === 0, `json-validate valid object`);
r = run("json-validate", { data: { age: -1 }, schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, age: { type: "integer", minimum: 0 } } } });
ok(r.valid === false && r.errors.length === 2, `json-validate catches missing required + minimum (got ${JSON.stringify(r.errors)})`);
r = run("json-validate", { data: "nope@", schema: { type: "string", format: "email" } });
ok(r.valid === false, `json-validate rejects bad email format`);
r = run("json-validate", { data: "red", schema: { enum: ["red", "green", "blue"] } });
ok(r.valid === true, `json-validate enum pass`);
r = run("json-validate", { data: { a: 1, b: 2 }, schema: { type: "object", properties: { a: { type: "integer" } }, additionalProperties: false } });
ok(r.valid === false, `json-validate additionalProperties:false rejects extra key`);

// jsonl round-trip
r = run("jsonl", { data: [{ a: 1 }, { a: 2 }], mode: "to-jsonl" });
ok(r.result === '{"a":1}\n{"a":2}' && r.count === 2, `jsonl to-jsonl (got ${JSON.stringify(r.result)})`);
r = run("jsonl", { data: '{"a":1}\n{"a":2}\n', mode: "from-jsonl" });
ok(JSON.stringify(r.result) === '[{"a":1},{"a":2}]' && r.count === 2, `jsonl from-jsonl (got ${JSON.stringify(r.result)})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
