// Every model-backed kit that bills outside the /v1 chat tiers records its
// per-call upstream spend in the server-side meter (the stats spend table
// behind /__operator/margin.json) and the gateway_usage margin event, priced
// from the private table: characters, audio minutes, tokens or items times
// the rate the table holds for the model that served. Until this suite these
// kits recorded nothing, so the margin view read their upstream as zero.
//
// Offline: the table here is FAKE (no real rate belongs in this repo), every
// upstream is a stubbed fetch, and the meter is redirected to an in-memory
// sink (setMeterSpendSinkForTest), so a kit that stops calling the meter, or
// prices from the wrong row, fails here. The expected figure is always
// units x the fake rate, computed, never typed as a dollar amount.
import { SPEECH_MODELS } from "../src/tools/llm-gateway-kit.js";

delete process.env.UPSTREAM_COSTS_JSON;
delete process.env.UPSTREAM_COSTS_FILE;
process.env.POSTHOG_TEST_CAPTURE = "1";
delete process.env.POSTHOG_API_KEY;
process.env.OPENAI_API_KEY = "sk-test-not-real";
process.env.OPENROUTER_API_KEY = "test-key";
process.env.EXA_API_KEY = "exa-test-not-real";
process.env.EXA_DAILY_MAX_USD = "100"; // the fake card is dollars, not cents; the daily cap is not under test here
process.env.X_BEARER_TOKEN = "x-test-not-real";
delete process.env.TYPESAFE_API_KEY;

const U = await import("../src/upstream-costs.js");
const PH = await import("../src/posthog.js");
const { TTS_TOOLS, TTS_BACKUP_MODELS, __resetTtsBreakerForTest } = await import("../src/tools/tts-kit.js");
const { STT_TIERS, makeMultipartHandler } = await import("../src/tools/stt-kit.js");
const { IMAGE_GEN_TOOLS } = await import("../src/tools/image-gen-kit.js");
const { EMBED_TOOLS } = await import("../src/tools/embed-kit.js");
const { LLM_GATEWAY_TOOLS, EMBEDDINGS_PRICE } = await import("../src/tools/llm-gateway-kit.js");
const { judge, decisions, JUDGE_PRICE_USD, DECISION_ONE } = await import("../src/tools/judge-kit.js");
const { EXA_TOOLS } = await import("../src/tools/exa-kit.js");
const { X_DATA_TOOLS } = await import("../src/tools/x-data-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;
const priceOf = (tools, slug) => Number(tools.find((t) => t.slug === slug).price.replace("$", ""));
const bySlug = (tools, slug) => tools.find((t) => t.slug === slug);

// The meter sink and the event sink: both drained per case.
const metered = [];
PH.setMeterSpendSinkForTest((source, usd) => metered.push({ source, usd }));
const events = PH._testEventsForTest();
const tick = () => new Promise((r) => setTimeout(r, 30)); // a kit that records through a dynamic import resolves it here
const take = async () => { await tick(); const m = metered.splice(0); const e = events.splice(0).filter((x) => x.event === "gateway_usage"); return { m, e }; };
// One metered row of `source` for `usd`, and one event naming tier, model, price and the same figure.
const recorded = ({ m, e }, { source, usd, tier, model, priceUsd }, label) => {
  ok(m.length === 1 && m[0].source === source && near(m[0].usd, usd), `${label}: metered once on "${source}" at units x rate (got ${JSON.stringify(m)})`);
  const ev = e[0]?.properties || {};
  ok(e.length === 1 && ev.tier === tier && ev.model === model && near(ev.priceUsd, priceUsd) && near(ev.upstreamUsd, usd) && ev.upstreamReported === true && ev.source === source,
    `${label}: one gateway_usage event for tier ${tier} (${model}) with the price and the same upstream figure (got ${JSON.stringify(ev)})`);
};

// ---- the fake table: real model ids, made-up rates ----
const SPEECH_FRONT = SPEECH_MODELS[0].id;
const T = {
  models: [["acme/", { completion: 2, prompt: 1 }]],
  speech: { "hexgrad/kokoro-82m": 0.5, "elevenlabs/eleven-v4-turbo": 0.25, "x-ai/grok-voice-tts-1.0": 0.125, [SPEECH_FRONT]: 0.0625 },
  embeddings: { "text-embedding-3-small": 8, "text-embedding-3-large": 16 },
  openai: { "gpt-image-2": { completion: 40, prompt: 5 }, "gpt-4o": { completion: 90, prompt: 10 } },
  sttPerMinute: { "gpt-transcribe": 0.6, "elevenlabs/scribe-v2": 1.2 },
  media: { "fake/image-model": { worstCaseUsd: 1, listedMaxUsd: 1 }, "black-forest-labs/flux-3-image-klein": { worstCaseUsd: 1, listedMaxUsd: 1 } },
  fees: { webSearchPerUse: 0.25, groundedPerCall: 0.125, rerankPerUnit: 5 },
  meter: { markup: 1.25 },
  vendor: { exa: { search: 0.5, instant: 0.25, answer: 1, content: 0.125 }, x: { postRead: 0.5, userRead: 0.25 }, decisions: { luna: 1, decisionOne: 1, jev: 1, maxShare: 0.9 } },
};
U.setUpstreamCostsForTest(T);
ok(U.upstreamCostsStatus() === "ok", "the fake table is complete (every key a serving path reads)");

const realFetch = globalThis.fetch;
const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return ""; } };
const pathOf = (u) => { try { return new URL(String(u)).pathname; } catch { return ""; } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const audio = (bytes = 64) => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(bytes).buffer, text: async () => "", headers: { get: () => "audio/mpeg" } });
const sent = [];
const stub = (fn) => { globalThis.fetch = async (url, init) => { sent.push({ url: String(url), init }); return fn(String(url), init); }; };
const restore = () => { globalThis.fetch = realFetch; sent.length = 0; };

try {
  // ---- tts-lite (Kokoro over the speech wire): chars x the model's rate ----
  {
    const text = "Hello from Agent402!";
    stub(() => audio());
    const out = await bySlug(TTS_TOOLS, "tts-lite").handler({ text, format: "mp3" });
    restore();
    ok(out.chars === text.length && out.model === "hexgrad/kokoro-82m", "tts-lite served the text on Kokoro");
    recorded(await take(), { source: "speech", usd: text.length * T.speech["hexgrad/kokoro-82m"], tier: "tts-lite", model: "hexgrad/kokoro-82m", priceUsd: priceOf(TTS_TOOLS, "tts-lite") }, "tts-lite");
  }
  // ---- tts (ElevenLabs): chars x the link that spoke ----
  {
    const text = "Twenty-one named voices.";
    __resetTtsBreakerForTest();
    stub(() => audio());
    const out = await bySlug(TTS_TOOLS, "tts").handler({ text, format: "mp3" });
    restore();
    ok(out.model === "elevenlabs/eleven-v4-turbo", "tts served on the primary ElevenLabs link");
    recorded(await take(), { source: "speech", usd: text.length * T.speech["elevenlabs/eleven-v4-turbo"], tier: "tts", model: "elevenlabs/eleven-v4-turbo", priceUsd: priceOf(TTS_TOOLS, "tts") }, "tts");
  }
  // ---- tts served by a backup speech model: priced at THAT row ----
  {
    const text = "Backup speaks here.";
    const backup = TTS_BACKUP_MODELS[0];
    __resetTtsBreakerForTest();
    stub((_u, init) => (String(JSON.parse(init.body).model).startsWith("elevenlabs/") ? json({ error: { message: "down" } }, 500) : audio()));
    const out = await bySlug(TTS_TOOLS, "tts").handler({ text, format: "mp3" });
    restore();
    ok(out.model === backup && out.provider === "openrouter", `the backup spoke (${out.model})`);
    recorded(await take(), { source: "speech", usd: text.length * T.speech[backup], tier: "tts", model: backup, priceUsd: priceOf(TTS_TOOLS, "tts") }, "tts backup");
  }
  // ---- no rate row for the model that spoke: served, nothing metered, the event says unreported ----
  {
    U.setUpstreamCostsForTest({ ...T, speech: { "elevenlabs/eleven-v4-turbo": 0.25 } });
    stub(() => audio());
    const out = await bySlug(TTS_TOOLS, "tts-lite").handler({ text: "No row for me", format: "mp3" });
    restore();
    const { m, e } = await take();
    ok(out.model === "hexgrad/kokoro-82m" && m.length === 0 && e.length === 1 && e[0].properties.upstreamReported === false && e[0].properties.upstreamUsd === 0,
      `a model without a rate row is served, meters nothing and reports no figure (metered ${JSON.stringify(m)}, event ${JSON.stringify(e[0]?.properties)})`);
    U.setUpstreamCostsForTest(T);
  }
  // ---- /v1/audio/speech: chars x the front link's rate ----
  {
    const text = "Wire speech";
    stub(() => audio());
    const out = await bySlug(LLM_GATEWAY_TOOLS, "v1-audio-speech").handler({ input: text });
    restore();
    ok(Buffer.isBuffer(out.__binary), "the wire served audio bytes");
    recorded(await take(), { source: "speech", usd: text.length * T.speech[SPEECH_FRONT], tier: "v1-audio-speech", model: SPEECH_FRONT, priceUsd: priceOf(LLM_GATEWAY_TOOLS, "v1-audio-speech") }, "v1-audio-speech");
  }
  // ---- transcribe: minutes x the model's per-minute rate ----
  const B = "----formdata-agent402-spend";
  const CT = `multipart/form-data; boundary=${B}`;
  const p = (s) => Buffer.from(s, "utf8");
  const filePart = (buf) => Buffer.concat([p(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`), buf, p("\r\n")]);
  const field = (n, v) => p(`--${B}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`);
  const multipart = (parts) => Buffer.concat([...parts, p(`--${B}--\r\n`)]);
  // Minimal PCM WAV of the given length: 8 kHz, mono, 8-bit.
  const wav = (seconds) => {
    const sr = 8000, dataLen = Math.round(sr * seconds), buf = Buffer.alloc(44 + dataLen);
    buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write("WAVE", 8);
    buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
    buf.write("data", 36); buf.writeUInt32LE(dataLen, 40);
    return buf;
  };
  {
    const seconds = 30;
    stub(() => json({ text: "hello there" }));
    const out = await makeMultipartHandler("transcribe")({}, { headers: { "content-type": CT }, body: multipart([filePart(wav(seconds))]) });
    restore();
    ok(out.model === "gpt-transcribe" && near(out.duration, seconds), `transcribe served with the probed duration (${out.duration}s)`);
    recorded(await take(), { source: "stt", usd: (seconds / 60) * T.sttPerMinute["gpt-transcribe"], tier: "transcribe", model: "gpt-transcribe", priceUsd: STT_TIERS.transcribe.priceUsd }, "transcribe");
  }
  // ---- transcribe-pro with diarize: the upstream's own duration at the scribe row ----
  {
    const upstreamSeconds = 120;
    stub(() => json({ text: "two speakers", duration: upstreamSeconds, words: [] }));
    const out = await makeMultipartHandler("transcribe-pro")({}, { headers: { "content-type": CT }, body: multipart([filePart(wav(100)), field("diarize", "true")]) });
    restore();
    ok(out.model === "elevenlabs/scribe-v2" && out.duration === upstreamSeconds, "diarized transcription served on scribe with the upstream's duration");
    recorded(await take(), { source: "stt", usd: (upstreamSeconds / 60) * T.sttPerMinute["elevenlabs/scribe-v2"], tier: "transcribe-pro", model: "elevenlabs/scribe-v2", priceUsd: STT_TIERS["transcribe-pro"].priceUsd }, "transcribe-pro diarize");
  }
  // ---- image-gen tiers: text tokens at the prompt rate, image tokens at the completion rate, from the image model's OWN row ----
  for (const slug of ["image-gen", "image-gen-hd", "image-gen-premium"]) {
    const usage = { input_tokens: 20, input_tokens_details: { text_tokens: 20, image_tokens: 0 }, output_tokens: 100 };
    stub(() => json({ data: [{ b64_json: "iVBORw0KGgo" }], usage }));
    const out = await bySlug(IMAGE_GEN_TOOLS, slug).handler({ prompt: "apple" });
    restore();
    ok(out.model === "gpt-image-2" && out.image, `${slug} served an image`);
    const row = T.openai["gpt-image-2"];
    recorded(await take(), { source: "image-gen", usd: (usage.input_tokens * row.prompt + usage.output_tokens * row.completion) / 1e6, tier: slug, model: "gpt-image-2", priceUsd: priceOf(IMAGE_GEN_TOOLS, slug) }, slug);
  }
  // ---- image model without its own row: nothing metered (a chat row's fallback would price image tokens wrong) ----
  {
    U.setUpstreamCostsForTest({ ...T, openai: { "gpt-4o": T.openai["gpt-4o"] } });
    stub(() => json({ data: [{ b64_json: "iVBORw0KGgo" }], usage: { input_tokens: 20, output_tokens: 100 } }));
    await bySlug(IMAGE_GEN_TOOLS, "image-gen").handler({ prompt: "apple" });
    restore();
    const { m, e } = await take();
    ok(m.length === 0 && e.length === 1 && e[0].properties.upstreamReported === false, `without the image model's row nothing is metered and the event says unreported (metered ${JSON.stringify(m)})`);
    U.setUpstreamCostsForTest(T);
  }
  // ---- embed tiers: the upstream's token count x the model's rate per 1M ----
  for (const slug of ["embed", "embed-large"]) {
    const model = slug === "embed" ? "text-embedding-3-small" : "text-embedding-3-large";
    const tokens = 1000;
    stub(() => json({ data: [{ embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: tokens, total_tokens: tokens } }));
    const out = await bySlug(EMBED_TOOLS, slug).handler({ text: "embed me" });
    restore();
    ok(out.model === model && out.dimensions === 3, `${slug} served on ${model}`);
    recorded(await take(), { source: "embeddings", usd: (tokens / 1e6) * T.embeddings[model], tier: slug, model, priceUsd: priceOf(EMBED_TOOLS, slug) }, slug);
  }
  // ---- /v1/embeddings: the same, on the wire route ----
  {
    const tokens = 500;
    stub(() => json({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1] }], model: "text-embedding-3-small", usage: { prompt_tokens: tokens, total_tokens: tokens } }));
    const out = await bySlug(LLM_GATEWAY_TOOLS, "v1-embeddings").handler({ input: "hello", cache: false });
    restore();
    ok(Array.isArray(out.data) && out.data.length === 1, "/v1/embeddings served");
    recorded(await take(), { source: "embeddings", usd: (tokens / 1e6) * T.embeddings["text-embedding-3-small"], tier: "v1-embeddings", model: "text-embedding-3-small", priceUsd: EMBEDDINGS_PRICE }, "v1-embeddings");
  }
  // ---- /v1/judge on Decision-1 and /v1/decisions on Luna: input tokens x the backend's rate per 1M ----
  {
    const tokens = 400;
    const q = { yes: { type: "noul", instructions: "Is it fine?" } };
    const d1 = async (url) => (hostOf(url) === "openrouter.ai" ? json({ answers: { yes: { type: "noul", noul: 0.7 } }, usage: { input_tokens: tokens, output_tokens: 3 }, model: "microsoft/microsoft-decision-1" }) : json({ error: "wrong upstream" }, 500));
    const out = await judge({ state: "a short state", questions: q, model: DECISION_ONE }, { fetchImpl: d1 });
    ok(out.model === DECISION_ONE && out.answers.yes.noul === 0.7, "judge answered on Decision-1");
    recorded(await take(), { source: "judge", usd: (tokens / 1e6) * T.vendor.decisions.decisionOne, tier: "judge", model: DECISION_ONE, priceUsd: JUDGE_PRICE_USD }, "judge on Decision-1");
    const lunaTokens = 250;
    const luna = async (url) => (hostOf(url) === "api.openai.com" ? json({ answers: [{ type: "predicate", name: "fine", probability: 0.6 }], usage: { input_tokens: lunaTokens }, model: "gpt-6-luna" }) : json({ error: "wrong upstream" }, 500));
    const dec = await decisions({ input: "a short state", questions: [{ type: "predicate", name: "fine", instructions: "Is it fine?" }] }, { fetchImpl: luna });
    ok(Array.isArray(dec.answers) && dec.answers[0].probability === 0.6, "decisions answered on Luna");
    recorded(await take(), { source: "judge", usd: (lunaTokens / 1e6) * T.vendor.decisions.luna, tier: "decisions", model: "gpt-6-luna", priceUsd: JUDGE_PRICE_USD }, "decisions on Luna");
  }
  // ---- exa-answer: what Exa says the call cost (costDollars), a vendor fee row, no margin event ----
  {
    const cost = 0.37;
    stub(() => json({ answer: "Forty-two.", citations: [], costDollars: { total: cost } }));
    const out = await bySlug(EXA_TOOLS, "exa-answer").handler({ query: "the answer?" });
    restore();
    const { m, e } = await take();
    ok(out.answer === "Forty-two." && m.length === 1 && m[0].source === "exa" && near(m[0].usd, cost) && e.length === 0, `exa-answer metered Exa's own figure on "exa" (got ${JSON.stringify(m)})`);
    // No costDollars: the card's estimate is what is metered.
    stub(() => json({ answer: "Still forty-two.", citations: [] }));
    await bySlug(EXA_TOOLS, "exa-answer").handler({ query: "the answer?" });
    restore();
    const again = await take();
    ok(again.m.length === 1 && near(again.m[0].usd, T.vendor.exa.answer), `without costDollars the answer card rate is metered (got ${JSON.stringify(again.m)})`);
  }
  // ---- x-user: items returned x the user-read rate ----
  {
    stub(() => json({ data: { id: "12", username: "someone", name: "Some One", public_metrics: { followers_count: 1 } } }));
    const out = await bySlug(X_DATA_TOOLS, "x-user").handler({ username: "someone" });
    restore();
    const { m, e } = await take();
    ok(out.user && m.length === 1 && m[0].source === "x" && near(m[0].usd, T.vendor.x.userRead) && e.length === 0, `x-user metered one user read on "x" (got ${JSON.stringify(m)})`);
  }
  // ---- a failed upstream call meters nothing ----
  {
    stub(() => json({ error: { message: "boom" } }, 500));
    let threw = null;
    try { await bySlug(TTS_TOOLS, "tts-lite").handler({ text: "nope", format: "mp3" }); } catch (e) { threw = e; }
    try { await bySlug(IMAGE_GEN_TOOLS, "image-gen").handler({ prompt: "nope" }); } catch (e) { threw = threw && e; }
    try { await bySlug(EMBED_TOOLS, "embed").handler({ text: "nope" }); } catch (e) { threw = threw && e; }
    restore();
    const { m, e } = await take();
    ok(threw && threw.statusCode >= 500 && m.length === 0 && e.length === 0, `an upstream failure is an uncharged error with nothing metered (metered ${m.length}, events ${e.length})`);
  }
  // ---- the meter helper itself: only a positive finite figure is recorded ----
  {
    ok(PH.meterUpstreamSpend("probe", 0.001) === true && PH.meterUpstreamSpend("probe", 0) === false && PH.meterUpstreamSpend("probe", -1) === false && PH.meterUpstreamSpend("probe", NaN) === false && PH.meterUpstreamSpend("probe", "1") === false, "meterUpstreamSpend records a positive finite number and nothing else");
    const { m } = await take();
    ok(m.length === 1 && m[0].source === "probe", "and the one record landed on its source");
  }
} finally {
  restore();
  PH.setMeterSpendSinkForTest(null);
  U.setUpstreamCostsForTest(null);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
