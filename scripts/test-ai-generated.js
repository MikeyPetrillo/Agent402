// The machine-readable AI-generated mark (src/ai-generated.js; EU AI Act
// Art. 50(2)): every model-backed tool's answer carries it.
//   - unit: a JSON answer gets `aiGenerated: true`, a byte answer the
//     `X-AI-Generated: true` header beside its own (bytes untouched), a /v1
//     wire answer and a stream writer keep their body; marking twice adds once;
//   - the class, on a booted server: every catalog row marked modelBacked is
//     marked aiGenerated (its handler wrapped, its JSON example carrying the
//     field), and no deterministic tool is;
//   - the send path: server.js sets the header on every success form (cache
//     hit, bytes, stream, JSON) through markAiAnswer, as an answer header.
// The header and field on a real paid answer are read in
// scripts/test-settlement-event.js (a paid image-gen-premium call).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const G = await import("../src/ai-generated.js");
const { AI_VOICE_HEADER } = await import("../src/ai-voice.js");
ok(G.AI_GENERATED_HEADER === AI_VOICE_HEADER && G.AI_GENERATED_HEADER === "X-AI-Generated", "one header name for every model-backed answer, the one speech already sends");
{
  ok(G.withAiGenerated({ text: "x" }).aiGenerated === true, "a JSON answer gets aiGenerated: true");
  const bytes = Buffer.from([1, 2, 3, 4]);
  const b = G.withAiGenerated({ __binary: bytes, contentType: "image/png", headers: { "X-Other": "1" } });
  ok(b.headers["X-AI-Generated"] === "true" && b.headers["X-Other"] === "1" && b.__binary === bytes && !("aiGenerated" in b), "a byte answer gets the header beside its own, the same bytes untouched");
  const chat = { id: "c", object: "chat.completion", choices: [] };
  ok(G.withAiGenerated(chat, { wire: true }) === chat, "a /v1 wire answer keeps the provider's body as it is (header only)");
  const sse = { __sse: () => {} };
  ok(G.withAiGenerated(sse) === sse && G.withAiGenerated(null) === null && Array.isArray(G.withAiGenerated([1])), "a stream writer, null and a list pass through");
  ok(G.isWireRoute("POST /v1/chat/completions") && !G.isWireRoute("POST /api/answer"), "wire routes are the /v1 ones");
  const def = { slug: "zz", route: "POST /api/zz", modelBacked: true, handler: async () => ({ a: 1 }), discovery: { output: { example: { a: 1 } } } };
  def.handler.__budget = 5;
  G.markAiGenerated([def]);
  ok((await def.handler({})).aiGenerated === true && def.discovery.output.example.aiGenerated === true && def.handler.__budget === 5, "a marked handler's answers and example carry it; the handler keeps its own marks");
  const h = def.handler; G.markAiGenerated([def]);
  ok(def.handler === h, "marking twice wraps once");
  const plain = { slug: "pp", route: "POST /api/pp", handler: async () => ({ a: 1 }) };
  G.markAiGenerated([plain]);
  ok(!("aiGenerated" in (await plain.handler({}))), "a deterministic tool is not marked");
}
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const packs = src.indexOf("for (const slug of modelBackedPackSlugs(");
  const mark = src.indexOf("markAiGenerated(ALL_KIT);");
  ok(packs > 0 && mark > packs, "server.js marks the catalog after the model-backed packs are known");
  ok(/function markAiAnswer\(req, res, tool\) \{\n  if \(tool\?\.modelBacked === true\) setAnswerHeader\(req, res, AI_GENERATED_HEADER, "true"\);/.test(src), "the header is an answer header (a refused payment sends none of it)");
  const hit = src.indexOf('res.setHeader("X-Cache", "hit");\n          markAiAnswer(req, res, tool);');
  const send = src.indexOf("markAiAnswer(req, res, tool);\n      if (result && result.__binary) {");
  ok(hit > 0 && send > 0, "every success form of the route binder sets it: a cache hit, and before bytes, a stream and JSON");
}
{
  const srv = await bootServer({ stores: "ai-generated", env: { FREE_MODE: "true", NODE_ENV: "test", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", TEMPO_API_KEY: "", MPP_SECRET_KEY: "", OPENROUTER_API_KEY: "sk-or-test-never-used", OPENAI_API_KEY: "sk-test-never-used" } });
  try {
    const pricing = await (await fetch(`${srv.url}/api/pricing`)).json();
    const rows = (pricing.tools || pricing.endpoints || []).filter((r) => r && typeof r === "object");
    const mb = rows.filter((r) => r.modelBacked === true);
    ok(mb.length >= 20, `the catalog lists model-backed tools (${mb.length})`);
    const unmarked = mb.filter((r) => r.aiGenerated !== true).map((r) => r.slug);
    ok(unmarked.length === 0, `every model-backed row is marked aiGenerated (unmarked: ${unmarked.slice(0, 12).join(", ") || "none"})`);
    const stray = rows.filter((r) => r.modelBacked !== true && r.aiGenerated === true).map((r) => r.slug);
    ok(stray.length === 0, `no deterministic tool is marked (${stray.join(", ") || "none"})`);
  } finally { await srv.stop(); }
}

console.log(`\ntest-ai-generated: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
