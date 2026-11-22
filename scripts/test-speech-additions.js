#!/usr/bin/env node
// Named speech and transcription models beside the chains
// (src/speech-additions.js; POST /v1/audio/speech, the URL transcribe routes).
//
// A model there is served, and listed, only while NAMED_AUDIO_MODELS names it,
// its private cost row is present AND the route's cap on it stays inside the
// margin bound of the price. This suite installs cost tables whose rates are derived from each
// route's own price and cap (no rate is typed here) and reads:
//   - with no row: the model is refused like any unknown one and is in no
//     listing or schema; the loader names the missing rows;
//   - with a row past the bound: the same;
//   - with a row inside the bound: the model is served first with the whole
//     chain behind it, its voices are accepted, and it is listed;
//   - a default request (no `model`) is unchanged in every case;
//   - a named transcription model goes over the transcription wire with no
//     speaker-label fields, per tier, and never beside diarize.
// Offline: fetch is a stub; no vendor is called.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";

process.env.OPENAI_API_KEY = "sk-test-not-real";
process.env.OPENROUTER_API_KEY = "or-test-not-real";
process.env.OPENROUTER_TTS_ENABLED = "true";
// The switch is on for every model in the sections below; "the switch" reads it off and per model.
process.env.NAMED_AUDIO_MODELS = "all";

const U = await import("../src/upstream-costs.js");
const A = await import("../src/speech-additions.js");
const G = await import("../src/tools/llm-gateway-kit.js");
const S = await import("../src/tools/stt-kit.js");
const { AUDIO_ZDR_MODELS, audioProviderPolicy } = await import("../src/openrouter-audio-policy.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`FAIL - ${m}`); } };
const thrown = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const EXAMPLE = JSON.parse(readFileSync(new URL("../docs/example-upstream-costs.json", import.meta.url), "utf8"));
const speechTool = G.LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-audio-speech");
const SPEECH_PRICE = Number(speechTool.price.replace("$", ""));
const CHAIN = G.SPEECH_MODELS.map((m) => m.id);
const EL = "elevenlabs/eleven-v3-conversational", VOX = "mistralai/voxtral-mini-tts-3-0";
const STT_IDS = A.STT_ADDITIONS.map((m) => m.id);
// A per-character rate at a share of the speech route's margin bound at a
// model's own cap (the route's where it declares none), and a per-minute one
// at a share of a tier's.
const speechCap = (id) => A.speechMaxCharsFor(A.speechAdditionNamed(id), G.SPEECH_MAX_CHARS);
const speechRate = (share, id = VOX) => share * A.ADDITION_MARGIN * SPEECH_PRICE / speechCap(id);
const sttRate = (tier, share) => share * A.ADDITION_MARGIN * S.STT_TIERS[tier].priceUsd / S.STT_TIERS[tier].maxMinutes;
const install = ({ speech = {}, stt = {} } = {}) => U.setUpstreamCostsForTest({ ...EXAMPLE, speech: { "your/speech-model": EXAMPLE.speech["your/speech-model"], ...speech }, sttPerMinute: { "gpt-transcribe": EXAMPLE.sttPerMinute["gpt-transcribe"], ...stt } });
const speechListed = () => G.modelsList().data.filter((m) => m.x402?.tier === "v1-audio-speech").map((m) => m.id);

// ---- the registry ---------------------------------------------------------------
{
  ok(A.ADDITION_MARGIN === G.MARGIN && A.ADDITION_MARGIN === S.STT_MARGIN, "the additions hold the same margin as the gateway and the transcribe tiers");
  ok(A.SPEECH_ADDITIONS.length === 2 && A.STT_ADDITIONS.length === 3, "two speech and three transcription models");
  for (const a of A.SPEECH_ADDITIONS) {
    ok(G.OPENAI_SPEECH_VOICES.every((v) => a.voices.has(a.map[v])), `${a.id} maps every OpenAI voice name to one of its own voices`);
    ok(!CHAIN.includes(a.id), `${a.id} is not a default chain link`);
    ok(a.voices.size >= 21 && [...a.voices].every((v) => /^[A-Za-z0-9_:-]{1,64}$/.test(v)), `${a.id} lists its voices`);
  }
  const before = new Set(G.SPEECH_MODELS.flatMap((m) => [...m.voices]));
  const added = A.SPEECH_ADDITIONS.flatMap((a) => [...a.voices]).filter((v) => !before.has(v));
  ok(new Set(added).size >= 50, `the two models bring voices the chain does not have (${new Set(added).size})`);
  for (const id of A.ADDITION_MODEL_IDS) ok(AUDIO_ZDR_MODELS.has(id) && audioProviderPolicy(id).zdr === true && audioProviderPolicy(id).data_collection === "deny", `${id} is sent under the zdr data policy`);
  ok(A.ADDITION_COST_KEYS.length === 5 && A.ADDITION_COST_KEYS.every(([sec]) => sec === "speech" || sec === "sttPerMinute"), "one cost row per model");
  ok(A.speechAdditionNamed("ELEVEN-V3-CONVERSATIONAL")?.id === EL && A.sttAdditionNamed(" mai-transcribe-2 ")?.id === "microsoft/mai-transcribe-2" && A.speechAdditionNamed("nope") === null && A.sttAdditionNamed("") === null, "names and aliases resolve without regard to case");
  ok(A.withinMargin(10, 1, 100) && !A.withinMargin(10, 8, 100) && !A.withinMargin(10, undefined, 100) && !A.withinMargin(10, 0, 100) && !A.withinMargin(10, NaN, 100) && !A.withinMargin(0, 1, 100), "the bound needs a positive cap, rate and price");
}

// ---- the loader names the rows, and the example file carries placeholders ---------
{
  U.setUpstreamCostsForTest(EXAMPLE);
  ok(U.upstreamCostsGaps().length === 0, `the example table is complete (${U.upstreamCostsGaps().join(", ")})`);
  for (const [sec, key] of A.ADDITION_COST_KEYS) ok(typeof EXAMPLE[sec]?.[key] === "number", `docs/example-upstream-costs.json has a placeholder for ${sec}.${key}`);
  install();
  const gaps = U.upstreamCostsGaps();
  for (const [sec, key] of A.ADDITION_COST_KEYS) ok(gaps.includes(`${sec}.${key}`), `a table without ${sec}.${key} names it as a gap`);
  ok(U.upstreamCostsStatus() === "partial", "and reads partial");
}

// ---- the switch: a complete table turns nothing on by itself -------------------------
{
  const [MINI] = STT_IDS;
  const rows = () => install({ speech: { [EL]: speechRate(0.5, EL), [VOX]: speechRate(0.5) }, stt: Object.fromEntries(STT_IDS.map((id) => [id, Math.min(...Object.keys(S.STT_TIERS).map((t) => sttRate(t, 0.5)))])) });
  rows();
  ok(G.speechAdditions().length === 2 && S.sttAdditions("transcribe").length === 3, "control: with the switch on all and every row inside the bound, every model is served");
  for (const off of [undefined, "", "off", "none-of-these", "gpt-transcribe"]) {
    if (off === undefined) delete process.env.NAMED_AUDIO_MODELS; else process.env.NAMED_AUDIO_MODELS = off;
    ok(G.speechAdditions().length === 0 && Object.keys(S.STT_TIERS).every((t) => S.sttAdditions(t).length === 0), `NAMED_AUDIO_MODELS ${JSON.stringify(off)}: no model is served, rows or not`);
    ok(thrown(() => G.validateSpeechRequest({ input: "hi", model: EL }))?.statusCode === 400 && thrown(() => S.sttModelOf({ model: MINI }, "transcribe"))?.statusCode === 400, `NAMED_AUDIO_MODELS ${JSON.stringify(off)}: a named model is refused`);
    ok(speechListed().join() === CHAIN.join() && Object.keys(S.sttModelProperty("transcribe")).length === 0, `NAMED_AUDIO_MODELS ${JSON.stringify(off)}: nothing is listed`);
  }
  process.env.NAMED_AUDIO_MODELS = ` ${VOX} , ${MINI.toUpperCase()} `;
  ok(G.speechAdditions().map((m) => m.id).join() === VOX && S.sttAdditions("transcribe").map((m) => m.id).join() === MINI, "a list turns on the models it names, and only those");
  ok([...A.namedAudioModelsOn({ NAMED_AUDIO_MODELS: "all" })].join() === A.ADDITION_MODEL_IDS.join() && A.namedAudioModelsOn({}).size === 0, "all names every model; unset names none");
  process.env.NAMED_AUDIO_MODELS = "all";
}

// ---- no row: not served, not listed ---------------------------------------------
{
  install();
  ok(G.speechAdditions().length === 0, "no row: no speech model beside the chain");
  for (const name of [EL, VOX, "eleven-v3-conversational", "voxtral-tts-3"]) {
    const e = thrown(() => G.validateSpeechRequest({ input: "hi", model: name }));
    ok(e?.statusCode === 400 && e.message.includes(CHAIN.join(", ")) && !e.message.includes(EL) && !e.message.includes(VOX), `no row: "${name}" is refused, and the answer lists the chain only`);
  }
  const e = thrown(() => G.validateSpeechRequest({ input: "hi", voice: "voice_3150" }));
  ok(e?.statusCode === 400, "no row: a voice only an unserved model has is refused");
  ok(G.validateSpeechRequest({ input: "hi" }).bodies.map((b) => b.model).join() === CHAIN.join(), "no row: the default chain is the chain");
  ok(speechListed().join() === CHAIN.join(), "no row: /v1/models lists the chain only");
  for (const tier of Object.keys(S.STT_TIERS)) {
    ok(S.sttAdditions(tier).length === 0 && Object.keys(S.sttModelProperty(tier)).length === 0, `no row: ${tier} offers no named model and its schema has no model property`);
    const r = thrown(() => S.sttModelOf({ model: STT_IDS[0] }, tier));
    ok(r?.statusCode === 400 && /is not a choice on this route/.test(r.message) && !r.message.includes(STT_IDS[0]), `no row: ${tier} refuses a named model without listing it`);
    ok(S.sttModelOf({}, tier) === null && S.sttModelOf({ model: "" }, tier) === null && S.sttModelOf({ model: S.STT_TIERS[tier].model }, tier) === null, `${tier}: no model, or the tier's own, is the tier's own`);
  }
}

// ---- a row past the bound: the same as no row ---------------------------------------
{
  install({ speech: { [EL]: speechRate(1.01, EL), [VOX]: speechRate(50) }, stt: Object.fromEntries(STT_IDS.map((id) => [id, sttRate("transcribe", 1.01)])) });
  ok(G.speechAdditions().length === 0 && speechListed().join() === CHAIN.join(), "a row past the bound: not served, not listed");
  ok(thrown(() => G.validateSpeechRequest({ input: "hi", model: EL }))?.statusCode === 400, "a row past the bound: refused");
  ok(S.sttAdditions("transcribe").length === 0 && thrown(() => S.sttModelOf({ model: STT_IDS[0] }, "transcribe"))?.statusCode === 400, "a transcription row past the tier's bound: refused");
}

// ---- a row inside the bound: served and listed ---------------------------------------
{
  install({ speech: { [EL]: speechRate(1, EL), [VOX]: speechRate(0.5) } });
  ok(G.speechAdditions().map((m) => m.id).join() === [EL, VOX].join(), "rows inside the bound (one exactly on it): both speech models are served");
  const v = G.validateSpeechRequest({ input: "hello", model: EL });
  ok(v.bodies.map((b) => b.model).join() === [EL, ...CHAIN].join(), "a named model goes first and the whole chain stays behind it");
  ok(v.bodies[0].voice === "river" && v.bodies[0].provider.zdr === true && v.bodies[0].provider.data_collection === "deny" && v.bodies[0].input === "hello", "its body maps alloy to its own voice under the data policy");
  ok(G.validateSpeechRequest({ input: "hi", model: "Eleven-V3-Conversational" }).bodies[0].model === EL && G.validateSpeechRequest({ input: "hi", model: "voxtral-tts-3" }).bodies[0].model === VOX, "aliases name them");
  const own = G.validateSpeechRequest({ input: "hi", model: VOX, voice: "voice_3150" });
  ok(own.bodies[0].voice === "voice_3150" && own.bodies[1].voice === G.SPEECH_MODELS[0].map.alloy, "a model's own voice is sent to it, and a fallback link gets its default");
  const liam = G.validateSpeechRequest({ input: "hi", model: EL, voice: "liam" });
  ok(liam.bodies[0].voice === "liam", "a named voice of the model is accepted");
  // A voice only a named model has is refused unless that model is the one named.
  for (const req of [{ input: "hi", voice: "liam" }, { input: "hi", voice: "liam", model: VOX }, { input: "hi", voice: "voice_3150", model: CHAIN[0] }]) {
    const e = thrown(() => G.validateSpeechRequest(req));
    ok(e?.statusCode === 400 && /name that model in "model"/.test(e.message), `${JSON.stringify(req)} is refused, naming the model that has the voice`);
  }
  ok(G.validateSpeechRequest({ input: "hi", voice: "en_paul_cheerful" }).bodies[0].voice === "en_paul_cheerful", "a voice the chain has too needs no model");
  ok(G.validateSpeechRequest({ input: "hi", model: EL, zdr: true }).bodies[0].model === EL, "a zdr request keeps the named model (its endpoint is ZDR)");
  ok(G.validateSpeechRequest({ input: "hi" }).bodies.map((b) => b.model).join() === CHAIN.join(), "a request that names no model still walks the chain alone");
  ok(G.validateSpeechRequest({ input: "hi", model: CHAIN[2] }).bodies.map((b) => b.model).join() === [CHAIN[2], ...CHAIN.filter((x) => x !== CHAIN[2])].join(), "pinning a chain link is unchanged");
  const e = thrown(() => G.validateSpeechRequest({ input: "hi", model: "nope/none" }));
  ok(e?.statusCode === 400 && e.message.includes(EL) && e.message.includes(VOX), "an unknown model's refusal now lists the served ones");
  const listed = G.modelsList().data.filter((m) => m.x402?.tier === "v1-audio-speech");
  ok(listed.map((m) => m.id).join() === [...CHAIN, EL, VOX].join() && listed.find((m) => m.id === EL).x402.voices.includes("liam") && listed.find((m) => m.id === VOX).x402.voices.includes("voice_3150"), "/v1/models lists them after the chain, with their voices");
  // One row only: only that model.
  install({ speech: { [VOX]: speechRate(0.5) } });
  ok(G.speechAdditions().map((m) => m.id).join() === VOX && thrown(() => G.validateSpeechRequest({ input: "hi", model: EL }))?.statusCode === 400 && thrown(() => G.validateSpeechRequest({ input: "hi", voice: "liam" }))?.statusCode === 400, "each model is gated by its own row");
}

// ---- transcription: per tier, over the wire, never beside diarize ---------------------
{
  const [MINI, SMALL, MAI] = STT_IDS;
  // MINI fits every tier; SMALL fits the two shorter tiers only; MAI has no row.
  const tightest = Math.min(...Object.keys(S.STT_TIERS).map((t) => sttRate(t, 1)));
  const between = (sttRate("transcribe-long", 1) + Math.min(sttRate("transcribe", 1), sttRate("transcribe-pro", 1))) / 2;
  ok(sttRate("transcribe-long", 1) < Math.min(sttRate("transcribe", 1), sttRate("transcribe-pro", 1)), "control: the long tier's bound per minute is the tightest");
  install({ stt: { [MINI]: tightest, [SMALL]: between } });
  ok(S.sttAdditions("transcribe").map((m) => m.id).join() === [MINI, SMALL].join() && S.sttAdditions("transcribe-pro").map((m) => m.id).join() === [MINI, SMALL].join(), "the two shorter tiers serve both models that have a row");
  ok(S.sttAdditions("transcribe-long").map((m) => m.id).join() === MINI, "the long tier serves only the model its price covers at thirty minutes");
  ok(S.sttModelOf({ model: SMALL }, "transcribe") === SMALL && S.sttModelOf({ model: "VOXTRAL-MINI-TRANSCRIBE" }, "transcribe-long") === MINI, "a served name resolves, by id or alias");
  const notLong = thrown(() => S.sttModelOf({ model: SMALL }, "transcribe-long"));
  ok(notLong?.statusCode === 400 && notLong.message.includes(`gpt-transcribe, ${MINI}`) && !notLong.message.includes(SMALL), "a model the tier does not serve is a 400 that lists what it does");
  ok(thrown(() => S.sttModelOf({ model: MAI }, "transcribe"))?.statusCode === 400, "a model with no row is a 400");
  const both = thrown(() => S.sttModelOf({ model: MINI }, "transcribe", null, true));
  ok(both?.statusCode === 400 && /cannot be combined/.test(both.message), "a named model beside diarize is a 400");
  const prop = S.sttModelProperty("transcribe");
  ok(prop.model?.type === "string" && prop.model.description.includes(MINI) && prop.model.description.includes(SMALL) && !prop.model.description.includes(MAI) && /model-backed/.test(prop.model.description), "the schema property names the served models and says they are model-backed");
  ok(!/\$\d|\d+\.\d{3,}/.test(prop.model.description), "and types no price or rate");

  // The served call: the URL route's handler, with the audio fetch and the upstream stubbed.
  const AUDIO_URL = "http://93.184.216.34/audio.wav"; // a public literal: validated without DNS, served by the stub
  const sr = 8000, n = sr * 3, wav = Buffer.alloc(44 + n, 0x80);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + n, 4); wav.write("WAVE", 8); wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write("data", 36); wav.writeUInt32LE(n, 40);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(AUDIO_URL)) return new Response(wav, { status: 200, headers: { "content-type": "audio/wav" } });
    if (!(init?.body instanceof FormData)) throw new Error(`unexpected fetch in an offline suite: ${String(url).slice(0, 60)}`);
    calls.push({ url: String(url), fields: Object.fromEntries([...init.body.entries()].filter(([, v]) => typeof v === "string")) });
    return new Response(JSON.stringify({ text: "hello there", language: "en", duration: 3 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  S.__setMeasureForTest(async (b) => ({ seconds: (b.length - 44) / sr }));
  try {
    const tool = S.STT_TOOLS.find((t) => t.slug === "transcribe");
    const out = await tool.handler({ url: AUDIO_URL, model: MINI });
    ok(calls.length === 1 && new URL(calls[0].url).host === "openrouter.ai" && new URL(calls[0].url).pathname === "/api/v1/audio/transcriptions", "a named model goes to the transcription wire, once");
    ok(calls[0].fields.model === MINI && calls[0].fields.response_format === "json" && !("diarize" in calls[0].fields) && !("timestamp_granularities[]" in calls[0].fields), "with its model id and no speaker-label fields");
    ok(JSON.parse(calls[0].fields.provider).zdr === true && JSON.parse(calls[0].fields.provider).data_collection === "deny", "under the zdr data policy");
    ok(out.model === MINI && out.provider === "openrouter" && out.text === "hello there" && out.language === "en" && out.duration === 3 && !("words" in out) && !("speakers" in out), "the answer names the model that served it and has the transcript fields");
    // The default call still goes to the tier's own model on its own wire.
    calls.length = 0;
    const own = await tool.handler({ url: AUDIO_URL });
    ok(calls.length === 1 && new URL(calls[0].url).host === "api.openai.com" && calls[0].fields.model === S.STT_TIERS.transcribe.model && own.model === S.STT_TIERS.transcribe.model, "a call that names no model is served by the tier's own, as before");
    // diarize keeps its own model and its fields.
    calls.length = 0;
    await tool.handler({ url: AUDIO_URL, diarize: true });
    ok(calls.length === 1 && calls[0].fields.model === S.DIARIZE_MODEL && calls[0].fields.diarize === "true" && calls[0].fields.response_format === "verbose_json", "diarize still sends the speaker-label model with its fields");
    // An unserved name never fetches the audio or reaches an upstream.
    calls.length = 0;
    let refused = null;
    try { await tool.handler({ url: AUDIO_URL, model: MAI }); } catch (e) { refused = e; }
    ok(refused?.statusCode === 400 && calls.length === 0, "an unserved model is refused before any upstream call");
    // With no row at all the same request is refused the same way.
    install();
    refused = null;
    try { await tool.handler({ url: AUDIO_URL, model: MINI }); } catch (e) { refused = e; }
    ok(refused?.statusCode === 400 && calls.length === 0, "with its row gone the model is refused again");
  } finally { globalThis.fetch = realFetch; S.__setMeasureForTest(null); }
}

// ---- per-model caps: a model held to its own cap, under the route's ---------------------
{
  // The speech model with its own cap is served at a row the route's cap would not fit.
  const elCap = speechCap(EL);
  ok(elCap < G.SPEECH_MAX_CHARS && speechCap(VOX) === G.SPEECH_MAX_CHARS, `${EL} declares its own cap under the route's (${elCap} < ${G.SPEECH_MAX_CHARS}); ${VOX} keeps the route's`);
  const overRoute = 0.9 * A.ADDITION_MARGIN * SPEECH_PRICE / elCap; // inside the bound at its cap, past it at the route's
  ok(!A.withinMargin(G.SPEECH_MAX_CHARS, overRoute, SPEECH_PRICE) && A.withinMargin(elCap, overRoute, SPEECH_PRICE), "control: the row fits the model's cap and not the route's");
  install({ speech: { [EL]: overRoute, [VOX]: speechRate(0.5) } });
  ok(G.speechAdditions().map((m) => m.id).join() === [EL, VOX].join(), "a model whose own cap fits the bound is served");
  ok(G.validateSpeechRequest({ input: "x".repeat(elCap), model: EL }).bodies[0].model === EL, `${EL} takes an input at its cap (${elCap} chars)`);
  const over = thrown(() => G.validateSpeechRequest({ input: "x".repeat(elCap + 1), model: EL }));
  ok(over?.statusCode === 400 && over.message.includes(EL) && over.message.includes(`up to ${elCap} chars`) && over.message.includes(`${G.SPEECH_MAX_CHARS} chars`), `one char past its cap is a 400 naming the model and its cap (${over?.message?.slice(0, 120)})`);
  ok(G.validateSpeechRequest({ input: "x".repeat(G.SPEECH_MAX_CHARS), model: VOX }).bodies[0].model === VOX && G.validateSpeechRequest({ input: "x".repeat(G.SPEECH_MAX_CHARS) }).bodies[0].model === CHAIN[0], "the other named model and the default chain keep the route's cap");
  ok(thrown(() => G.validateSpeechRequest({ input: "x".repeat(G.SPEECH_MAX_CHARS + 1), model: VOX }))?.statusCode === 400, "and are refused past it as before");
  const listed = G.modelsList().data.filter((m) => m.x402?.tier === "v1-audio-speech");
  ok(listed.find((m) => m.id === EL)?.x402.maxInputChars === elCap && listed.find((m) => m.id === VOX)?.x402.maxInputChars === G.SPEECH_MAX_CHARS && listed.filter((m) => CHAIN.includes(m.id)).every((m) => m.x402.maxInputChars === G.SPEECH_MAX_CHARS), "/v1/models lists each model's own cap");
  const unknown = thrown(() => G.validateSpeechRequest({ input: "hi", model: "nope/none" }));
  ok(unknown?.message.includes(`${EL} (up to ${elCap.toLocaleString("en-US")} chars)`) && !unknown.message.includes(`${VOX} (up to`), "the unknown-model refusal names the cap beside the model that has one");
  // Past the bound at its own cap: not served.
  install({ speech: { [EL]: speechRate(1.01, EL) } });
  ok(G.speechAdditions().length === 0, "a row past the bound at the model's own cap: not served");

  // Transcription: a model given its own cap on a tier (through the test seam;
  // none is declared today) is admitted at a row the tier's cap would not fit,
  // takes audio to its cap and refuses audio past it with a 400 naming it.
  const [MINI] = STT_IDS;
  const tier = "transcribe", T = S.STT_TIERS[tier];
  const ownMin = 1;
  const row = 0.9 * A.ADDITION_MARGIN * T.priceUsd / ownMin;
  ok(!A.withinMargin(T.maxMinutes, row, T.priceUsd), "control: the row does not fit the tier's own cap");
  install({ stt: { [MINI]: row } });
  ok(S.sttAdditions(tier).length === 0, "without its own cap the model is not served on the tier");
  A.__setAdditionCapsForTest({ [MINI]: { maxMinutes: { [tier]: ownMin } } });
  try {
    ok(S.sttAdditions(tier).map((m) => m.id).join() === MINI && S.sttCapMinutesFor(tier, MINI) === ownMin && S.sttCapMinutesFor(tier) === T.maxMinutes, "with its own cap it is served, at that cap; the tier's own model keeps the tier's");
    ok(S.sttAdditions("transcribe-pro").length === 0 || A.withinMargin(S.STT_TIERS["transcribe-pro"].maxMinutes, row, S.STT_TIERS["transcribe-pro"].priceUsd), "a per-tier cap applies to its tier only");
    const desc = S.sttModelProperty(tier).model?.description || "";
    ok(desc.includes(`${MINI} (up to 1 minute of audio)`) && !desc.includes("same price and cap"), `the schema names the model's own cap (${desc.slice(0, 160)})`);
    const sr = 8000;
    const wavOf = (sec) => { const n = sr * sec, b = Buffer.alloc(44 + n, 0x80); b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40); return b; };
    const AUDIO = "http://93.184.216.34/";
    let audio = wavOf(60);
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith(AUDIO)) return new Response(audio, { status: 200, headers: { "content-type": "audio/wav" } });
      if (!(init?.body instanceof FormData)) throw new Error(`unexpected fetch in an offline suite: ${String(url).slice(0, 60)}`);
      calls.push(Object.fromEntries([...init.body.entries()].filter(([, v]) => typeof v === "string")));
      return new Response(JSON.stringify({ text: "ok", language: "en", duration: 60 }), { status: 200, headers: { "content-type": "application/json" } });
    };
    S.__setMeasureForTest(async (b) => ({ seconds: (b.length - 44) / sr }));
    try {
      const tool = S.STT_TOOLS.find((t) => t.slug === tier);
      const at = await tool.handler({ url: `${AUDIO}a.wav`, model: MINI });
      ok(at.model === MINI && calls.length === 1 && calls[0].model === MINI, `a ${ownMin}-minute file is served by ${MINI} at its cap`);
      audio = wavOf(70); calls.length = 0;
      let refused = null;
      try { await tool.handler({ url: `${AUDIO}b.wav`, model: MINI }); } catch (e) { refused = e; }
      ok(refused?.statusCode === 400 && refused.message.includes(MINI) && refused.message.includes("up to 1 minute") && refused.message.includes(`${T.maxMinutes} minutes`) && calls.length === 0, `a longer file is a 400 naming the model's cap, with no upstream call (${refused?.message?.slice(0, 140)})`);
      calls.length = 0;
      const own = await tool.handler({ url: `${AUDIO}c.wav` });
      ok(own.model === T.model && calls.length === 1, "the same file without \"model\" is served on the tier's own cap");
    } finally { globalThis.fetch = realFetch; S.__setMeasureForTest(null); }
  } finally { A.__setAdditionCapsForTest(null); }
}

// ---- the tools stay marked model-backed ------------------------------------------------
{
  // server.js marks a tool model-backed by its kit: the speech wire and the
  // transcribe tools are in the list of model-backed kits.
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const kits = server.slice(server.indexOf("const MODEL_BACKED_KITS = ["), server.indexOf("const MODEL_BACKED_SLUGS = "));
  ok(kits.length > 0 && /\.\.\.STT_TOOLS\b/.test(kits) && /\.\.\.GATEWAY_TOOLS_ENABLED\b/.test(kits), "the transcribe tools and the gateway's speech wire are in the model-backed kits");
  ok(/model-backed/.test(S.STT_TOOLS.find((t) => t.slug === "transcribe-pro").description), "and a transcribe description says so");
}

U.setUpstreamCostsForTest(null);
if (fail) { console.error(`\nspeech additions: ${pass} passed, ${fail} failed`); process.exit(1); }
console.log(`speech additions: ${pass} passed`);
