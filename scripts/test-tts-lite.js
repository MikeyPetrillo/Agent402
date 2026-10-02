#!/usr/bin/env node
// The lite TTS tier (2026-09-11): Kokoro-82M over OpenRouter behind the same
// request/response contract as the two OpenAI tiers, at a tenth of the price.
// Offline - the upstream is a stubbed fetch, so this asserts the contract and
// the money bound, never a live voice.
import { TTS_TOOLS } from "../src/tools/tts-kit.js";
import { SPEECH_MODELS } from "../src/tools/llm-gateway-kit.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const bySlug = Object.fromEntries(TTS_TOOLS.map((t) => [t.slug, t]));
const lite = bySlug["tts-lite"], full = bySlug.tts;
const realFetch = globalThis.fetch;
const call = async (input, res) => {
  globalThis.fetch = async (url, init) => { call.last = { url: String(url), init, body: JSON.parse(init.body) }; return res; };
  try { return await lite.handler(input); } finally { globalThis.fetch = realFetch; }
};
const audio = (bytes = 64) => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(bytes).buffer, text: async () => "" });
const err = (status, body) => ({ ok: false, status, arrayBuffer: async () => new ArrayBuffer(0), text: async () => JSON.stringify(body) });
process.env.OPENROUTER_API_KEY = "test-key";

// --- the money bound -------------------------------------------------------
{
  const kokoro = SPEECH_MODELS.find((m) => m.id === "hexgrad/kokoro-82m");
  ok(!!kokoro, "the Kokoro entry the lite tier pins is still in SPEECH_MODELS (one table, so the voice map cannot drift)");
  const price = Number(lite.price.replace("$", ""));
  const cap = Number(lite.discovery.inputSchema.properties.text.description.match(/max (\d+) chars/)[1]);
  ok(cap === 800, `the lite cap is 800 chars (cut from 2,000 on 2026-09-18 when Kokoro gained a dearer endpoint we cannot route away from; got ${cap})`);
  const worst = kokoro.costPerChar * cap;
  ok(price === 0.005, `the lite tier is $0.005 (got ${lite.price})`);
  ok(worst <= price * 0.7, `worst case at the ${cap}-char cap is within the margin rule on $${price}`);
  ok(worst * 10 < Number(full.price.replace("$", "")), "and an order of magnitude under the premium tier it sits beside");
}

// --- the contract: same shape in, same shape out ---------------------------
{
  const outKeys = (o) => Object.keys(o).sort().join(",");
  const r = await call({ text: "Hello from Agent402!", voice: "alloy", format: "mp3" }, audio());
  ok(outKeys(r) === outKeys(full.discovery.output.example), `the response carries the same fields as /api/tts (${outKeys(r)})`);
  ok(r.provider === "openrouter" && r.model === "hexgrad/kokoro-82m", "it names the model and provider that served it");
  ok(r.voice === "af_alloy", `the OpenAI voice name is mapped to Kokoro's own and NAMED BACK, so a buyer knows what spoke (got ${r.voice})`);
  ok(typeof r.audio === "string" && r.audio.length > 0 && r.chars === 20, "audio is base64 and chars counts the input");
  ok(call.last.url.includes("openrouter.ai") && call.last.body.model === "hexgrad/kokoro-82m" && call.last.body.voice === "af_alloy" && call.last.body.response_format === "mp3", "the outbound request pins the model and sends the native voice");
  ok(call.last.init.headers["X-Title"], "attribution headers ride along (the same ones the gateway sends)");
  const dflt = await call({ text: "hi" }, audio());
  ok(dflt.voice === "af_alloy" && dflt.format === "mp3", "voice and format default exactly like the other tiers");
}

// --- refusals teach, and never silently downgrade --------------------------
{
  const throws = async (input, substr, msg, res = audio()) => {
    let e = null; try { await call(input, res); } catch (x) { e = x; }
    ok(e && String(e.message).includes(substr), `${msg} (got ${e ? String(e.message).slice(0, 80) : "no throw"})`);
    return e;
  };
  await throws({ text: "hi", format: "flac" }, "/api/tts", "a format Kokoro cannot serve is a 400 naming the tier that can, never a silent mp3");
  await throws({ text: "x".repeat(801) }, "800", "the 800-char cap is enforced before any upstream call");
  ok((await call({ text: "x".repeat(800) }, audio())).chars === 800, "and exactly 800 chars is served");
  await throws({ text: "hi", voice: "bogus" }, "Unknown voice", "an unknown voice is refused by name");
  await throws({}, '"text" is required', "empty input is refused");
  const e429 = await throws({ text: "hi" }, "Speech upstream error", "a 429 from upstream is an upstream error (their capacity, not the buyer's request)", err(429, { error: { message: "rate limited" } }));
  ok(e429?.statusCode === 502, "and carries statusCode 502 so settlement is cancelled");
  const e400 = await throws({ text: "hi" }, "Upstream rejected", "a 4xx from upstream surfaces as a 400 the agent can act on", err(400, { error: { message: "bad voice" } }));
  ok(e400?.statusCode === 400, "with statusCode 400");
  const e500 = await throws({ text: "hi" }, "Speech upstream error", "a 5xx is an upstream error", err(503, { error: { message: "down" } }));
  ok(e500?.statusCode === 502, "with statusCode 502");
  let empty = null; try { await call({ text: "hi" }, audio(0)); } catch (x) { empty = x; }
  ok(empty?.statusCode === 502, "zero bytes back is a 502, never a paid empty answer");
  const saved = process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_API_KEY;
  let noKey = null; try { await call({ text: "hi" }, audio()); } catch (x) { noKey = x; }
  process.env.OPENROUTER_API_KEY = saved;
  ok(noKey?.statusCode === 503, "with no key configured it is a 503 (our configuration, uncharged), not a 4xx blaming the buyer");
}

// --- the premium tiers are untouched --------------------------------------
{
  ok(full.price === "$0.050" && bySlug["tts-hd"].price === "$0.100", "the OpenAI tiers keep their prices");
  ok(/tts-lite/.test(full.description), "the premium description names the cheaper sibling, so a buyer can find it");
  ok(full.discovery.output.example.provider === "openai", "and still documents the OpenAI provider");
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
