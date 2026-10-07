#!/usr/bin/env node
// /api/tts and /api/tts-hd on ElevenLabs (2026-10-07), and diarize:true on
// the transcription tools (ElevenLabs Scribe v2). Offline: the upstream is a
// stubbed fetch; the format encoding runs the real local ffmpeg.
//
// What it pins:
//   - the money bound: 2,000 chars at the private per-char row (the rate
//     after the launch discount ends) stays within 70% of each tier's price,
//     and each Scribe-backed duration cap within 70% of its tier;
//   - the ten voice names map to ten DISTINCT ElevenLabs voices (the first
//     replacement chain was turned down for folding them onto five or one);
//   - all six formats are served: mp3/pcm from the wire, wav/flac/opus/aac
//     encoded from its PCM;
//   - an ElevenLabs outage falls back to the OpenAI model the tier replaced,
//     named in the answer, and never after OpenAI's shutdown date; a bad
//     request is a 400 and never falls back.
import { TTS_TOOLS, TTS_TIERS, ELEVENLABS_VOICE_MAP, ELEVENLABS_VOICES, OPENAI_TTS_SHUTDOWN, __makeHandlerForTest } from "../src/tools/tts-kit.js";
import { STT_TIERS, STT_MARGIN, STT_TOOLS, upstreamUsdPerMinute } from "../src/tools/stt-kit.js";
import { upstreamCosts } from "../src/upstream-costs.js";
import { requireUpstreamCosts } from "./lib/require-upstream-costs.js";
requireUpstreamCosts("test-tts-elevenlabs");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const bySlug = Object.fromEntries(TTS_TOOLS.map((t) => [t.slug, t]));
const realFetch = globalThis.fetch;
process.env.OPENROUTER_API_KEY = "test-or-key";

// 0.2 s of a 440 Hz tone as 24 kHz 16-bit mono PCM, the shape the wire returns.
const pcm = (() => { const n = 4800, b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000)), i * 2); return b; })();
const audio = (buf) => ({ ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), text: async () => "" });
const err = (status, body = { error: { message: "nope" } }) => ({ ok: false, status, arrayBuffer: async () => new ArrayBuffer(0), text: async () => JSON.stringify(body) });

// Routes each outbound call: OpenRouter speech, OpenAI speech, OpenRouter STT.
const calls = [];
const stub = (routes) => { globalThis.fetch = async (url, init) => { const u = String(url); calls.push({ url: u, init }); for (const [m, r] of routes) if (u.includes(m)) return typeof r === "function" ? r(u, init) : r; throw new Error(`unexpected fetch ${u}`); }; };
const run = async (slug, input, opts) => { calls.length = 0; try { return await (opts ? __makeHandlerForTest(slug, opts) : bySlug[slug].handler)(input); } finally { globalThis.fetch = realFetch; } };
const throwsWith = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// --- the money bound -------------------------------------------------------
for (const slug of ["tts", "tts-hd"]) {
  const t = TTS_TIERS[slug];
  const price = Number(bySlug[slug].price.replace("$", ""));
  ok(t.chain[0] === t.model, `${slug}: the documented model is the first link`);
  for (const model of t.chain) {
    const row = upstreamCosts().speech[model];
    ok(Number.isFinite(row) && row > 0, `${slug}: a private per-char row exists for ${model}`);
    ok(row * t.maxChars <= price * 0.7 + 1e-12, `${slug}: ${t.maxChars} chars on ${model} stays within 70% of $${price}`);
  }
  ok(bySlug[slug].discovery.inputSchema.properties.text.description.includes(`max ${t.maxChars} chars`), `${slug}: the documented cap matches the enforced ${t.maxChars}`);
}
for (const [tier, t] of Object.entries(STT_TIERS)) {
  const rate = upstreamUsdPerMinute(t.diarizeModel);
  ok(Number.isFinite(rate), `${tier}: per-minute row known for ${t.diarizeModel}`);
  ok(t.maxMinutes * rate <= STT_MARGIN * t.priceUsd + 1e-12, `${tier}: diarized worst case within the margin bound of $${t.priceUsd}`);
}

// --- voices ----------------------------------------------------------------
{
  const names = Object.keys(ELEVENLABS_VOICE_MAP);
  const targets = new Set(Object.values(ELEVENLABS_VOICE_MAP));
  ok(names.length === 10 && targets.size === 10, `the ten voice names map to ten distinct ElevenLabs voices (${[...targets].join(", ")})`);
  ok([...targets].every((v) => ELEVENLABS_VOICES.has(v)), "every mapped voice is one ElevenLabs serves");
}

// --- formats ---------------------------------------------------------------
stub([["openrouter.ai/api/v1/audio/speech", (_u, init) => audio(JSON.parse(init.body).response_format === "mp3" ? Buffer.from("ID3fake-mp3") : pcm)]]);
const magic = { wav: "RIFF", flac: "fLaC", opus: "OggS" };
for (const format of ["mp3", "pcm", "wav", "flac", "opus", "aac"]) {
  stub([["openrouter.ai/api/v1/audio/speech", (_u, init) => audio(JSON.parse(init.body).response_format === "mp3" ? Buffer.from("ID3fake-mp3") : pcm)]]);
  const r = await run("tts", { text: "Hello from Agent402!", voice: "nova", format });
  const sent = JSON.parse(calls[0].init.body);
  const out = Buffer.from(r.audio, "base64");
  ok(sent.model === "elevenlabs/eleven-v4-turbo" && sent.voice === "sarah", `${format}: the request pins the model and sends nova's own voice (sarah)`);
  ok(sent.response_format === (format === "mp3" ? "mp3" : "pcm"), `${format}: asks the wire for ${format === "mp3" ? "mp3" : "pcm"}`);
  const head = out.subarray(0, 4).toString("latin1");
  const shaped = format === "mp3" ? head === "ID3f" : format === "pcm" ? out.equals(pcm) : format === "aac" ? out[0] === 0xff && (out[1] & 0xf0) === 0xf0 : head === magic[format];
  ok(r.format === format && shaped && r.provider === "openrouter" && r.voice === "sarah" && r.chars === 20, `${format}: answered as ${format} (${out.length} bytes), naming the voice that spoke`);
}
{
  const outKeys = (o) => Object.keys(o).sort().join(",");
  stub([["openrouter.ai/api/v1/audio/speech", audio(Buffer.from("ID3fake-mp3"))]]);
  const r = await run("tts-hd", { text: "hi" });
  ok(outKeys(r) === outKeys(bySlug["tts-hd"].discovery.output.example), `tts-hd answers the documented fields (${outKeys(r)})`);
  ok(r.model === "elevenlabs/eleven-v4" && r.voice === "river" && r.format === "mp3", "tts-hd defaults: eleven-v4, alloy's voice (river), mp3");
  stub([["openrouter.ai/api/v1/audio/speech", audio(Buffer.from("ID3fake-mp3"))]]);
  const direct = await run("tts", { text: "hi", voice: "George" });
  ok(direct.voice === "george" && JSON.parse(calls[0].init.body).voice === "george", "an ElevenLabs voice can be named directly");
  const e = await throwsWith(() => run("tts", { text: "hi", voice: "kermit" }));
  ok(e?.statusCode === 400 && /ElevenLabs voice/.test(e.message) && calls.length === 0, "an unknown voice is a 400 listing both sets, before any upstream call");
  const lite = await throwsWith(() => run("tts-lite", { text: "hi", voice: "george" }));
  ok(lite?.statusCode === 400, "ElevenLabs names are refused on tts-lite, which is not ElevenLabs");
  const long = await throwsWith(() => run("tts", { text: "x".repeat(2001) }));
  ok(long?.statusCode === 400 && calls.length === 0, "2,001 chars is refused before any upstream call");
}

// --- a full encoder pool queues, never refuses (the speech is already bought) -
{
  const { transcodePcm, __pcmPoolForTest } = await import("../src/tools/media-kit.js");
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => transcodePcm(pcm, "flac")));
  ok(results.every((r) => r.status === "fulfilled" && r.value.subarray(0, 4).toString("latin1") === "fLaC"), "12 concurrent encodes on a 4-slot pool all succeed (queued, not refused)");
  const pool = __pcmPoolForTest();
  ok(pool.active === 0 && pool.waiting === 0, "and the pool drains back to empty");
  const bad = await throwsWith(() => transcodePcm(pcm, "ogg"));
  ok(bad?.statusCode === 400 && __pcmPoolForTest().active === 0, "an unknown format is refused without taking a slot");
}

// --- fallback --------------------------------------------------------------
{
  process.env.OPENAI_API_KEY = "test-openai-key";
  const before = () => OPENAI_TTS_SHUTDOWN - 86_400_000;
  stub([["openrouter.ai", err(503)], ["api.openai.com/v1/audio/speech", audio(Buffer.from("ID3openai"))]]);
  const r = await run("tts-hd", { text: "hi", voice: "george", format: "flac" }, { now: before });
  const oa = JSON.parse(calls.find((c) => c.url.includes("openai.com")).init.body);
  ok(r.provider === "openai" && r.model === "tts-1-hd" && oa.model === "tts-1-hd", "an ElevenLabs 503 falls back to the OpenAI model the tier replaced, named in the answer");
  ok(oa.voice === "fable" && oa.response_format === "flac", "the fallback sends the OpenAI name for the voice asked for (george -> fable) and the format natively");
  stub([["openrouter.ai", err(429)], ["api.openai.com", audio(Buffer.from("ID3openai"))]]);
  ok((await run("tts", { text: "hi" }, { now: before })).model === "tts-1", "a 429 on every link falls back too");
  const tried = calls.filter((c) => c.url.includes("openrouter.ai")).map((c) => JSON.parse(c.init.body).model);
  ok(tried.join(",") === TTS_TIERS.tts.chain.join(","), `every ElevenLabs link is tried in order before OpenAI (${tried.join(" > ")})`);
  let n = 0;
  stub([["openrouter.ai", () => (n++ === 0 ? err(429) : audio(Buffer.from("ID3second")))], ["api.openai.com", audio(Buffer.from("ID3openai"))]]);
  const second = await run("tts-hd", { text: "hi" }, { now: before });
  ok(second.model === TTS_TIERS["tts-hd"].chain[1] && second.provider === "openrouter" && !calls.some((c) => c.url.includes("openai.com")), `a 429 on the first link is served by the second (${second.model}), named in the answer`);
  stub([["openrouter.ai", err(401)], ["api.openai.com", audio(Buffer.from("ID3openai"))]]);
  ok((await run("tts", { text: "hi" }, { now: before })).model === "tts-1", "our key refused (401) is an outage, not the buyer's 400: it falls back");
  stub([["openrouter.ai", () => { throw new Error("socket hang up"); }], ["api.openai.com", audio(Buffer.from("ID3openai"))]]);
  ok((await run("tts", { text: "hi" }, { now: before })).model === "tts-1", "a network failure falls back too");
  stub([["openrouter.ai", err(400)], ["api.openai.com", audio(Buffer.from("ID3openai"))]]);
  const bad = await throwsWith(() => run("tts", { text: "hi" }, { now: before }));
  ok(bad?.statusCode === 400 && !calls.some((c) => c.url.includes("openai.com")), "a 400 is the request's fault: no fallback, a 400 back");
  ok(calls.filter((c) => c.url.includes("openrouter.ai")).length === 1, "and the chain is not walked: one upstream call, not one per link");
  let e1 = 0;
  stub([["openrouter.ai", () => (e1++ === 0 ? audio(Buffer.alloc(0)) : audio(Buffer.from("ID3second")))], ["api.openai.com", audio(Buffer.from("ID3openai"))]]);
  const afterEmpty = await run("tts", { text: "hi" }, { now: before });
  ok(afterEmpty.model === TTS_TIERS.tts.chain[1] && Buffer.from(afterEmpty.audio, "base64").length > 0, "empty audio from a link is an outage: the next link serves, never an empty 200");
  stub([["openrouter.ai", audio(Buffer.alloc(0))]]);
  const allEmpty = await throwsWith(() => run("tts", { text: "hi" }, { now: () => OPENAI_TTS_SHUTDOWN }));
  ok(allEmpty?.statusCode === 502, "empty audio on every link, no fallback left: an uncharged 502");
  stub([["openrouter.ai", err(503)], ["api.openai.com", audio(Buffer.from("ID3openai"))]]);
  const after = await throwsWith(() => run("tts", { text: "hi" }, { now: () => OPENAI_TTS_SHUTDOWN }));
  ok(after?.statusCode === 502 && !calls.some((c) => c.url.includes("openai.com")), "from OpenAI's shutdown date there is no fallback: an uncharged 502");
  delete process.env.OPENAI_API_KEY;
  stub([["openrouter.ai", err(503)]]);
  const nokey = await throwsWith(() => run("tts", { text: "hi" }, { now: before }));
  ok(nokey?.statusCode === 502, "without an OpenAI key an outage is an uncharged 502");
}

// --- diarize ---------------------------------------------------------------
{
  const { makeMultipartHandler } = await import("../src/tools/stt-kit.js");
  const transcribe = STT_TOOLS.find((t) => t.slug === "transcribe");
  ok(transcribe.discovery.inputSchema.properties.diarize?.type === "boolean", "transcribe documents diarize");
  // A 1 s WAV so the duration cap can be read locally.
  const wav = (() => { const sr = 8000, n = sr, d = Buffer.alloc(n * 2), h = Buffer.alloc(44); h.write("RIFF", 0); h.writeUInt32LE(36 + d.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(d.length, 40); return Buffer.concat([h, d]); })();
  const boundary = "x402b";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="diarize"\r\n\r\ntrue\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    wav, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const scribe = { text: "Hello there. Hi.", language: "eng", duration: 1, words: [
    { word: "Hello", start: 0, end: 0.3, speaker: 0 }, { word: "there.", start: 0.3, end: 0.5, speaker: 0 }, { word: "Hi.", start: 0.6, end: 0.9, speaker: 1 }] };
  let form = null;
  globalThis.fetch = async (url, init) => { if (String(url).includes("openrouter.ai/api/v1/audio/transcriptions")) { form = init.body; return { ok: true, status: 200, text: async () => JSON.stringify(scribe) }; } throw new Error(`unexpected ${url}`); };
  const r = await makeMultipartHandler("transcribe")({}, { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body });
  globalThis.fetch = realFetch;
  ok(form?.get("model") === "elevenlabs/scribe-v2" && form.get("diarize") === "true" && form.get("response_format") === "verbose_json", "diarize sends Scribe v2 with speaker labels and verbose output");
  ok(r.model === "elevenlabs/scribe-v2" && r.speakers === 2 && r.words.length === 3 && r.words[2].speaker === 1 && r.words[0].end === 0.3, "the answer carries words with times and speakers, and the speaker count");
  ok(r.text === scribe.text && r.duration === 1, "and the transcript and duration, like the default path");
  const e = await throwsWith(() => transcribe.handler({ url: "https://agent402.tools/fixtures/sample-audio.wav", diarize: "yes" }));
  ok(e?.statusCode === 400 && /diarize/.test(e.message), "a diarize value that is not true/false is a 400 before any fetch");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
