// AI-generated voice disclosure (src/ai-voice.js): every speech tool says,
// before payment and in every answer, that the voice is AI-generated.
//   - each speech tool's description carries the sentence (ahead of any
//     attribution tail), and its JSON example the field;
//   - a JSON answer gets `aiGeneratedVoice: true`, a byte answer the
//     `X-AI-Generated: true` header beside its own headers; a stream writer
//     or a non-object passes through untouched;
//   - the class: every catalog tool tagged as speech carries the mark.
//
//   node scripts/test-ai-voice.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const V = await import("../src/ai-voice.js");
const { TTS_TOOLS } = await import("../src/tools/tts-kit.js");
const { DUB_TOOLS } = await import("../src/tools/dub-kit.js");
const { LLM_GATEWAY_TOOLS } = await import("../src/tools/llm-gateway-kit.js");
const all = [...TTS_TOOLS, ...DUB_TOOLS, ...LLM_GATEWAY_TOOLS];
const SPEECH = ["tts-lite", "tts", "tts-hd", "dub", "v1-audio-speech"];

for (const slug of SPEECH) {
  const t = all.find((x) => x.slug === slug);
  ok(t && t.aiGeneratedVoice === true && t.description.includes(V.AI_VOICE_SENTENCE), `${slug}: the description says the voice is AI-generated (read before payment)`);
  const ex = t?.discovery?.output?.example;
  if (ex && typeof ex === "object" && !ex.__binary && (!t.mimeType || /json/.test(t.mimeType))) ok(ex.aiGeneratedVoice === true, `${slug}: the published JSON example carries the field`);
}
// The class: any catalog tool tagged text-to-speech or speech is marked.
{
  const { readdirSync } = await import("node:fs");
  const defs = [];
  for (const f of readdirSync(new URL("../src/tools/", import.meta.url)).filter((x) => x.endsWith(".js") && !/-worker\.js$/.test(x))) {
    let mod; try { mod = await import(`../src/tools/${f}`); } catch { continue; }
    for (const v of Object.values(mod)) if (Array.isArray(v)) for (const d of v) if (d && typeof d === "object" && typeof d.slug === "string" && typeof d.handler === "function") defs.push(d);
  }
  const speech = defs.filter((d) => Array.isArray(d.tags) && d.tags.some((x) => x === "text-to-speech" || x === "tts" || x === "dubbing"));
  const unmarked = [...new Set(speech.filter((d) => d.aiGeneratedVoice !== true).map((d) => d.slug))];
  ok(speech.length >= 4 && unmarked.length === 0, `every speech tool in the catalog carries the disclosure (${speech.length} read; unmarked: ${unmarked.join(", ") || "none"})`);
}
// The answer forms.
{
  ok(V.withAiVoice({ audio: "x" }).aiGeneratedVoice === true, "a JSON answer gets the field");
  const b = V.withAiVoice({ __binary: Buffer.from("x"), contentType: "audio/mpeg", headers: { "X-Dub-Translation": "e30=" } });
  ok(b.headers[V.AI_VOICE_HEADER] === "true" && b.headers["X-Dub-Translation"] === "e30=" && !("aiGeneratedVoice" in b), "a byte answer gets the header beside its own");
  const w = () => {};
  ok(V.withAiVoice(w) === w && V.withAiVoice(null) === null, "a stream writer or a non-object passes through");
  const tool = { slug: "zz", description: "Speaks. Source: X.", handler: async () => ({ audio: "a" }), discovery: { output: { example: { audio: "a" } } } };
  V.markAiVoice([tool], ["zz"]);
  const out = await tool.handler({});
  ok(out.aiGeneratedVoice === true && tool.discovery.output.example.aiGeneratedVoice === true, "a marked handler's answers and example carry it");
  V.markAiVoice([tool], ["zz"]);
  ok(tool.description.split(V.AI_VOICE_SENTENCE).length === 2, "marking twice adds the sentence once");
}

console.log(`\ntest-ai-voice: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
