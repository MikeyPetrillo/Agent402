#!/usr/bin/env node
// /api/tts and /api/tts-hd on ElevenLabs (2026-10-07), and diarize:true on
// the transcription tools (ElevenLabs Scribe v2). Offline: the upstream is a
// stubbed fetch; the format encoding runs the real local ffmpeg.
//
// What it pins:
//   - the money bound: 2,000 chars at the private per-char row stays within
//     70% of each tier's price,
//     and each Scribe-backed duration cap within 70% of its tier;
//   - the ten voice names map to ten DISTINCT ElevenLabs voices (the first
//     replacement chain was turned down for folding them onto five or one);
//   - all six formats are served: mp3/pcm from the wire, wav/flac/opus/aac
//     encoded from its PCM;
//   - an ElevenLabs outage is served by the backup speech models on the same
//     wire (TTS_BACKUP_MODELS, in order: Voxtral, then Grok voice, then
//     MAI-Voice-2), named in the answer, with the voice asked for mapped to
//     the backup's nearest and every format still served; the first backup
//     gives nine of the ten names their own voice id (coral and sage share
//     one); a bad request is a 400 and never reaches a backup.
import { TTS_TOOLS, TTS_TIERS, ELEVENLABS_VOICE_MAP, ELEVENLABS_VOICES, TTS_BACKUP_MODELS, ELEVEN_MAX_IN_FLIGHT, __makeHandlerForTest, __resetTtsBreakerForTest, __ttsBreakerForTest, elevenLabsBreakerState } from "../src/tools/tts-kit.js";
import { SPEECH_MODELS } from "../src/tools/llm-gateway-kit.js";
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

// Routes each outbound call: OpenRouter speech (ElevenLabs and the backups
// share the wire, told apart by the model sent) and OpenRouter STT.
const calls = [];
const hostOf = (u) => new URL(u).host;
const modelOf = (init) => String(JSON.parse(init.body).model);
const isEleven = (init) => modelOf(init).startsWith("elevenlabs/");
// The wire answer of a backup model: mp3 as is, anything else as PCM to encode.
const backupAudio = (init) => audio(JSON.parse(init.body).response_format === "mp3" ? Buffer.from("ID3backup") : pcm);
// An ElevenLabs outcome (a response or a thrown error) with every backup serving.
const withBackups = (eleven) => (u, init) => (isEleven(init) ? (typeof eleven === "function" ? eleven(u, init) : eleven) : backupAudio(init));
const backupCalls = () => calls.filter((c) => !isEleven(c.init)).map((c) => modelOf(c.init));
const FIRST_BACKUP = TTS_BACKUP_MODELS[0];
const firstBackup = SPEECH_MODELS.find((m) => m.id === FIRST_BACKUP);
const stub = (routes) => { globalThis.fetch = async (url, init) => { const u = String(url); calls.push({ url: u, init }); const hp = (() => { const x = new URL(u); return x.host + x.pathname; })(); for (const [m, r] of routes) if (hp === m || hp.startsWith(m.endsWith("/") ? m : `${m}/`) || (!m.includes("/") && hp.split("/")[0] === m)) return typeof r === "function" ? r(u, init) : r; throw new Error(`unexpected fetch ${u}`); }; };
// Each case starts with a closed breaker unless it says otherwise.
let keepBreaker = false;
const run = async (slug, input) => { calls.length = 0; if (!keepBreaker) __resetTtsBreakerForTest(); try { return await bySlug[slug].handler(input); } finally { globalThis.fetch = realFetch; } };
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
  if (format === "mp3") ok(sent.provider?.data_collection === "deny" && sent.provider?.zdr === true && !("instructions" in sent), "the ElevenLabs request carries our data policy (data_collection deny, zdr)");
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
  ok(e?.statusCode === 400 && /or a named voice: .*george/.test(e.message) && calls.length === 0, "an unknown voice is a 400 listing both sets, before any upstream call");
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

// --- backups ---------------------------------------------------------------
{
  ok(TTS_BACKUP_MODELS.join() === "mistralai/voxtral-mini-tts-2603,x-ai/grok-voice-tts-1.0,microsoft/mai-voice-2" && TTS_BACKUP_MODELS.every((id) => SPEECH_MODELS.some((m) => m.id === id)), `the backups are Voxtral, then Grok voice, then MAI-Voice-2, each a model the speech wire serves (${TTS_BACKUP_MODELS.join(", ")})`);
  ok(Object.keys(ELEVENLABS_VOICE_MAP).every((v) => firstBackup.map?.[v] && firstBackup.voices.has(firstBackup.map[v])), "the first backup maps every one of the ten voice names to a voice it serves");
  {
    const names = Object.keys(ELEVENLABS_VOICE_MAP);
    const ids = names.map((v) => firstBackup.map[v]);
    const shared = names.filter((v) => ids.filter((id) => id === firstBackup.map[v]).length > 1).sort().join("+");
    ok(new Set(ids).size === 9 && shared === "coral+sage", `the first backup gives nine of the ten names their own voice id; coral and sage share ${firstBackup.map.coral} (shared: ${shared})`);
    const speakers = new Set(ids.map((id) => id.replace(/_[a-z]+$/, "")));
    ok(speakers.size === 3, `across three speakers (${[...speakers].join(", ")})`);
  }
  ok(!("fallback" in TTS_TIERS.tts) && !("fallback" in TTS_TIERS["tts-hd"]), "no tier names a direct fallback model outside the wire");
  stub([["openrouter.ai", withBackups(err(503))]]);
  const r = await run("tts-hd", { text: "hi", voice: "george", format: "flac" });
  const bk = calls.find((c) => !isEleven(c.init));
  const sent = JSON.parse(bk.init.body);
  ok(r.provider === "openrouter" && r.model === FIRST_BACKUP && sent.model === FIRST_BACKUP, `an ElevenLabs 503 is served by the first backup (${r.model}), named in the answer`);
  ok(sent.voice === firstBackup.map.fable && r.voice === sent.voice, `the backup gets the nearest voice for the one asked for (george -> fable -> ${sent.voice})`);
  const flac = Buffer.from(r.audio, "base64");
  ok(sent.response_format === "pcm" && r.format === "flac" && flac.subarray(0, 4).toString("latin1") === "fLaC", "and the format asked for is still served, encoded from the backup's PCM");
  stub([["openrouter.ai", withBackups(err(429))]]);
  ok((await run("tts", { text: "hi" })).model === FIRST_BACKUP, "a 429 is served by a backup");
  const tried = calls.filter((c) => isEleven(c.init)).map((c) => modelOf(c.init));
  ok(tried.length === 1, `a 429 is never answered with another ElevenLabs call: one ElevenLabs request, not one per link (${tried.join(" > ")})`);
  let n = 0;
  stub([["openrouter.ai", withBackups(() => (n++ === 0 ? err(503) : audio(Buffer.from("ID3second"))))]]);
  const second = await run("tts-hd", { text: "hi" });
  ok(second.model === TTS_TIERS["tts-hd"].chain[1] && second.provider === "openrouter" && backupCalls().length === 0, `a server error on the first link (unbilled) is served by the second (${second.model}), named in the answer, before any backup`);
  stub([["openrouter.ai", withBackups(err(401))]]);
  ok((await run("tts", { text: "hi" })).model === FIRST_BACKUP, "our key refused (401) is an outage, not the buyer's 400: a backup serves");
  stub([["openrouter.ai", withBackups(() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); })]]);
  ok((await run("tts", { text: "hi" })).model === FIRST_BACKUP, "a DNS failure (never connected) goes to a backup too");
  stub([["openrouter.ai", withBackups(() => { throw new Error("socket hang up"); })]]);
  const dropped = await throwsWith(() => run("tts", { text: "hi" }));
  ok(dropped?.statusCode === 503 && /^Speech upstream is unreachable from here/.test(dropped?.message || "") && calls.length === 1, `a socket dropped mid-answer may have been billed: final, one upstream call, a 503 (got ${dropped?.statusCode} "${dropped?.message}")`);
  stub([["openrouter.ai", withBackups(err(400))]]);
  const bad = await throwsWith(() => run("tts", { text: "hi" }));
  ok(bad?.statusCode === 400 && backupCalls().length === 0, "a 400 is the request's fault: no backup, a 400 back");
  ok(calls.length === 1, "and the chain is not walked: one upstream call, not one per link");
  // Empty audio and a timeout may already have been billed upstream: each is
  // final, one upstream call and an uncharged 5xx, never another link or a backup.
  stub([["openrouter.ai", withBackups(audio(Buffer.alloc(0)))]]);
  const empty = await throwsWith(() => run("tts", { text: "hi" }));
  ok(empty?.statusCode === 502 && calls.length === 1, `empty audio is a final uncharged 502 after one upstream call (calls: ${calls.length})`);
  stub([["openrouter.ai", withBackups(() => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); })]]);
  const slow = await throwsWith(() => run("tts-hd", { text: "hi" }));
  ok(slow?.statusCode === 503 && /^Speech upstream did not answer the speech read within \d+ s \(upstream deadline\)/.test(slow?.message || "") && calls.length === 1, `a deadline is a final uncharged 503 naming the step after one upstream call (calls: ${calls.length}, got ${slow?.statusCode} "${slow?.message}")`);
  stub([["openrouter.ai", withBackups(() => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); })]]);
  ok((await run("tts", { text: "hi" })).model === FIRST_BACKUP, "a connection that never reached the upstream is an outage: the chain and then a backup run");
  // Each later backup serves only after the one before failed unbilled.
  stub([["openrouter.ai", (_u, init) => (modelOf(init) === TTS_BACKUP_MODELS[1] ? backupAudio(init) : err(503))]]);
  const secondBackup = await run("tts", { text: "hi" });
  ok(secondBackup.model === TTS_BACKUP_MODELS[1] && backupCalls().join() === TTS_BACKUP_MODELS.slice(0, 2).join(), `the second backup serves after the first failed (${backupCalls().join(" > ")})`);
  stub([["openrouter.ai", (_u, init) => (modelOf(init) === TTS_BACKUP_MODELS.at(-1) ? backupAudio(init) : err(503))]]);
  const last = await run("tts", { text: "hi" });
  ok(last.model === TTS_BACKUP_MODELS.at(-1) && backupCalls().join() === TTS_BACKUP_MODELS.join(), `the backups are walked in order to the last (${backupCalls().join(" > ")})`);
  // With every model on the wire down, what the buyer reads names no vendor text.
  stub([["openrouter.ai", err(503, { error: { message: "vendor-internal-detail" } })]]);
  const down = await throwsWith(() => run("tts", { text: "hi" }));
  ok(down?.statusCode === 502 && !/vendor-internal-detail/.test(down.message) && backupCalls().join() === TTS_BACKUP_MODELS.join(), `a 5xx on every link and backup is an uncharged 502 without the vendor's error text (got "${down?.message}")`);
  // Our gateway credit running out (402) is shared by every model on the wire:
  // no backup call, no 400 blaming the buyer, and no account state in the text.
  stub([["openrouter.ai", err(402, { error: { message: "Insufficient credits on account" } })]]);
  const broke = await throwsWith(() => run("tts", { text: "hi" }));
  ok(broke?.statusCode === 503 && !/credit/i.test(broke.message) && calls.length === 1, `a gateway 402 ends the walk after one call and names no account state (got ${broke?.statusCode} "${broke?.message}", calls ${calls.length})`);
}

// --- the breaker: a throttle never becomes more ElevenLabs traffic ----------
{
  const elevenCalls = () => calls.filter((c) => isEleven(c.init)).length;
  for (const [status, label] of [[429, "a 429"], [401, "a 401 (our credential refused)"]]) {
    __resetTtsBreakerForTest(); keepBreaker = true;
    stub([["openrouter.ai", withBackups(err(status))]]);
    await run("tts", { text: "hi" });
    ok(elevenLabsBreakerState() === "cooling", `${label} opens the breaker`);
    stub([["openrouter.ai", withBackups(audio(Buffer.from("ID3eleven")))]]);
    const during = await run("tts-hd", { text: "hi" });
    ok(elevenCalls() === 0 && during.model === FIRST_BACKUP, `while it is open, both tiers skip ElevenLabs entirely and serve from the backup (${during.model})`);
    keepBreaker = false;
  }
  // Retry-After is honored when it asks for longer than the cooldown.
  __resetTtsBreakerForTest(); keepBreaker = true;
  stub([["openrouter.ai", withBackups(() => ({ ...err(429), headers: { get: (h) => (h.toLowerCase() === "retry-after" ? "600" : null) } }))]]);
  await run("tts", { text: "hi" });
  ok(__ttsBreakerForTest().openUntil - Date.now() > 590_000, "a Retry-After longer than the cooldown is honored");
  // After the cooldown exactly one call probes; a success closes the breaker.
  __resetTtsBreakerForTest(); keepBreaker = true;
  stub([["openrouter.ai", withBackups(err(429))]]);
  await run("tts", { text: "hi" });
  const b = __ttsBreakerForTest();
  ok(b.trips === 1, "one trip recorded");
  let release;
  const slow = new Promise((r) => { release = r; });
  stub([["openrouter.ai", withBackups(async () => { await slow; return audio(Buffer.from("ID3eleven")); })]]);
  const realNow = Date.now; Date.now = () => realNow() + 10 * 60_000; // past a 60 s cooldown
  const probe = run("tts", { text: "probe" });
  await new Promise((r) => setTimeout(r, 10));
  ok(elevenLabsBreakerState(Date.now()) === "probing", "after the cooldown the breaker lets a probe through");
  release();
  const probed = await probe;
  Date.now = realNow;
  ok(probed.model === "elevenlabs/eleven-v4-turbo" && elevenLabsBreakerState() === "ok", "a successful probe closes the breaker");
  keepBreaker = false;
  // Three server errors in a row open it; fewer do not.
  __resetTtsBreakerForTest(); keepBreaker = true;
  stub([["openrouter.ai", withBackups(err(503))]]);
  await run("tts", { text: "hi" });
  ok(elevenLabsBreakerState() === "ok", "a single server error does not open the breaker");
  for (let i = 0; i < 2; i++) { stub([["openrouter.ai", withBackups(err(503))]]); await run("tts", { text: "hi" }); }
  ok(elevenLabsBreakerState() === "cooling", "three server errors in a row do");
  keepBreaker = false;
  // Burst cap: calls beyond ELEVEN_MAX_IN_FLIGHT use a backup instead of piling on.
  __resetTtsBreakerForTest(); keepBreaker = true;
  let open = 0, peak = 0, gateRelease; const gate = new Promise((r) => { gateRelease = r; });
  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url); calls.push({ url: u, init });
    if (!isEleven(init)) return backupAudio(init);
    open++; peak = Math.max(peak, open); await gate; open--; return audio(Buffer.from("ID3eleven"));
  };
  const handler = __makeHandlerForTest("tts");
  const burst = Array.from({ length: ELEVEN_MAX_IN_FLIGHT + 4 }, () => handler({ text: "hi" }));
  await new Promise((r) => setTimeout(r, 20));
  gateRelease();
  const outs = await Promise.all(burst);
  globalThis.fetch = realFetch;
  ok(peak <= ELEVEN_MAX_IN_FLIGHT, `never more than ${ELEVEN_MAX_IN_FLIGHT} ElevenLabs calls in flight (peak ${peak})`);
  ok(outs.every((o) => o.audio) && outs.filter((o) => o.model === FIRST_BACKUP).length === 4, "the overflow is served by the backup, not refused");
  keepBreaker = false;
  // A call in flight when another tripped the breaker must not close it.
  __resetTtsBreakerForTest(); keepBreaker = true;
  { let rel; const hold = new Promise((r) => { rel = r; }); let k = 0;
    calls.length = 0;
    globalThis.fetch = async (url, init) => { const u = String(url); calls.push({ url: u, init }); if (!isEleven(init)) return backupAudio(init); if (k++ === 0) { await hold; return audio(Buffer.from("ID3late")); } return err(429); };
    const h = __makeHandlerForTest("tts");
    const slowOk = h({ text: "slow" });
    await new Promise((r) => setTimeout(r, 5));
    await h({ text: "throttled" });
    ok(elevenLabsBreakerState() === "cooling", "the 429 opened the breaker");
    rel(); await slowOk;
    globalThis.fetch = realFetch;
    ok(elevenLabsBreakerState() === "cooling", "a success from a call that started before the trip does not close it");
  }
  // A burst of 429s from calls in flight together is one trip, not one each.
  __resetTtsBreakerForTest(); keepBreaker = true;
  { let rel; const hold = new Promise((r) => { rel = r; });
    globalThis.fetch = async (_url, init) => { if (!isEleven(init)) return backupAudio(init); await hold; return err(429); };
    const h = __makeHandlerForTest("tts");
    const burst = Array.from({ length: 5 }, () => h({ text: "hi" }));
    await new Promise((r) => setTimeout(r, 5)); rel(); await Promise.all(burst);
    globalThis.fetch = realFetch;
    const st = __ttsBreakerForTest();
    ok(st.trips === 1 && st.openUntil - Date.now() <= 61_000, `five simultaneous 429s are one trip with the base cooldown (trips ${st.trips})`);
  }
  keepBreaker = false;
  // Timeouts and empty answers stay final for that call but count toward the breaker.
  __resetTtsBreakerForTest(); keepBreaker = true;
  for (let i = 0; i < 3; i++) { stub([["openrouter.ai", withBackups(audio(Buffer.alloc(0)))]]); await throwsWith(() => run("tts", { text: "hi" })); }
  ok(elevenLabsBreakerState() === "cooling", "three empty answers in a row open the breaker, so later buyers go to the backups");
  stub([["openrouter.ai", withBackups(audio(Buffer.from("ID3eleven")))]]);
  ok((await run("tts", { text: "hi" })).model === FIRST_BACKUP, "and the next buyer is served by a backup");
  keepBreaker = false;
  // A backup answering 200 with no audio may have been billed: final, no next backup.
  __resetTtsBreakerForTest();
  stub([["openrouter.ai", (_u, init) => (isEleven(init) ? err(429) : audio(Buffer.alloc(0)))]]);
  const bkEmpty = await throwsWith(() => run("tts", { text: "hi" }));
  ok(bkEmpty?.statusCode >= 500 && backupCalls().length === 1, `an empty backup answer is an uncharged 5xx after one backup call (got ${bkEmpty?.statusCode}, backups ${backupCalls().join(" > ")})`);
  // ElevenLabs voices outside the ten keep their character on the backup.
  __resetTtsBreakerForTest();
  stub([["openrouter.ai", withBackups(err(429))]]);
  await run("tts", { text: "hi", voice: "daniel" });
  const dv = JSON.parse(calls.find((c) => !isEleven(c.init)).init.body).voice;
  ok(dv !== firstBackup.map.alloy && dv === firstBackup.map.fable, `a directly named ElevenLabs voice (daniel) keeps its character on the backup (${dv})`);
  // PCM is encoded at the rate the wire reports.
  __resetTtsBreakerForTest();
  stub([["openrouter.ai", () => ({ ...audio(pcm), headers: { get: (h) => (h.toLowerCase() === "content-type" ? "audio/pcm;rate=48000;channels=1" : null) } })]]);
  const at48 = await run("tts", { text: "hi", format: "wav" });
  const wavBuf = Buffer.from(at48.audio, "base64");
  ok(wavBuf.readUInt32LE(24) === 48000, `a 48 kHz wire answer is encoded as 48 kHz (header says ${wavBuf.readUInt32LE(24)})`);
  // A backup timeout may have been billed: final, no further backup.
  __resetTtsBreakerForTest();
  stub([["openrouter.ai", (_u, init) => { if (isEleven(init)) return err(429); if (modelOf(init) === FIRST_BACKUP) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); return backupAudio(init); }]]);
  const bkSlow = await throwsWith(() => run("tts", { text: "hi" }));
  ok(bkSlow?.statusCode === 503 && /^Speech upstream did not answer the speech read within/.test(bkSlow?.message || "") && backupCalls().join() === FIRST_BACKUP, `a backup that timed out is final: no further backup is called after it (backups ${backupCalls().join(" > ")})`);
  // A throttle is served by the first backup with the mapped voice, within price.
  __resetTtsBreakerForTest();
  stub([["openrouter.ai", withBackups(err(429))]]);
  const served = await run("tts", { text: "hi", voice: "nova" });
  ok(served.model === FIRST_BACKUP && served.voice === firstBackup.map.nova, `a throttle is served by ${served.model} (voice ${served.voice}), never an error`);
  for (const slug of ["tts", "tts-hd"]) {
    const price = Number(bySlug[slug].price.replace("$", ""));
    for (const id of TTS_BACKUP_MODELS) {
      const row = upstreamCosts().speech[id];
      ok(Number.isFinite(row) && row * TTS_TIERS[slug].maxChars <= price * 0.7 + 1e-12, `${slug}: backup ${id} fits within 70% of $${price}`);
    }
  }
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
  const scribe = { text: "Hello there. Hi.", language: "eng", language_confidence: 0.96041744, duration: 1, words: [
    { word: "Hello", start: 0, end: 0.3, speaker: 0 }, { word: "there.", start: 0.3, end: 0.5, speaker: 0 }, { word: "Hi.", start: 0.6, end: 0.9, speaker: 1 }] };
  let form = null;
  globalThis.fetch = async (url, init) => { const x = new URL(String(url)); if (x.host === "openrouter.ai" && x.pathname === "/api/v1/audio/transcriptions") { form = init.body; return { ok: true, status: 200, text: async () => JSON.stringify(scribe) }; } throw new Error(`unexpected ${url}`); };
  const r = await makeMultipartHandler("transcribe")({}, { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body });
  globalThis.fetch = realFetch;
  ok(form?.get("model") === "elevenlabs/scribe-v2" && form.get("diarize") === "true" && form.get("response_format") === "verbose_json", "diarize sends Scribe v2 with speaker labels and verbose output");
  ok(r.model === "elevenlabs/scribe-v2" && r.speakers === 2 && r.words.length === 3 && r.words[2].speaker === 1 && r.words[0].end === 0.3, "the answer carries words with times and speakers, and the speaker count");
  ok(r.text === scribe.text && r.duration === 1, "and the transcript and duration, like the default path");
  ok(r.language_confidence === 0.9604, `Scribe's language confidence passes through, rounded (got ${r.language_confidence})`);
  let policy = null; try { policy = JSON.parse(form?.get("provider")); } catch {}
  ok(policy?.data_collection === "deny" && policy?.zdr === true && Object.keys(policy).length === 2, "the Scribe request carries our data policy as the multipart provider field");
  ok(!form?.has("keyterms") && !form?.has("keyterms[]") && !form?.has("entities"), "and sends no keyterms or entity fields");
  const scribeWith = async (status, answer) => {
    globalThis.fetch = async (url) => { const x = new URL(String(url)); if (x.host === "openrouter.ai") return { ok: status === 200, status, text: async () => JSON.stringify(answer) }; throw new Error("unexpected"); };
    try { return await makeMultipartHandler("transcribe")({}, { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body }); }
    catch (x) { return x; } finally { globalThis.fetch = realFetch; }
  };
  const c402 = await scribeWith(402, { error: { message: "Insufficient credits" } });
  ok(c402?.statusCode === 503 && !/credit/i.test(c402.message), `a gateway 402 is a 503 that names no account state (got ${c402?.statusCode})`);
  const errBody = await scribeWith(200, { error: { message: "provider failed", code: 502 } });
  ok(errBody?.statusCode >= 500, "a 200 carrying an error body is a 5xx, not a charged empty transcript");
  const noText = await scribeWith(200, { words: [] });
  ok(noText?.statusCode === 502, "a 200 with no transcript field is a 502");
  const silent = await scribeWith(200, { text: "", words: [], duration: 1 });
  ok(silent?.text === "" && silent?.speakers === 0, "silent audio is still a valid empty transcript");
  ok(silent?.language_confidence === null, "an unscored language is a null confidence, never an invented one");
  const outOfRange = await scribeWith(200, { text: "hi", words: [], duration: 1, language_confidence: 7 });
  ok(outOfRange?.language_confidence === null, "a confidence outside 0..1 is dropped to null");
  const e = await throwsWith(() => transcribe.handler({ url: "https://agent402.tools/fixtures/sample-audio.wav", diarize: "yes" }));
  ok(e?.statusCode === 400 && /diarize/.test(e.message), "a diarize value that is not true/false is a 400 before any fetch");

  // keyterms and entities: no serving model honors them (every listed model
  // refuses keyterms upstream; entity detection is not forwarded), so a set
  // value is a 400 before any fetch, never a transcript that ignored it.
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error("no fetch expected"); };
  const pro = STT_TOOLS.find((t) => t.slug === "transcribe-pro");
  for (const [label, extra] of [["keyterms list", { keyterms: ["Agent402"] }], ["keyterms string", { keyterms: "Agent402" }], ["entities", { entities: true }], ["entities string", { entities: "true" }]]) {
    for (const tool of [transcribe, pro]) {
      const x = await throwsWith(() => tool.handler({ url: "https://agent402.tools/fixtures/sample-speech.wav", ...extra }));
      ok(x?.statusCode === 400 && /not supported/.test(x.message) && /nothing was charged/.test(x.message), `${tool.slug}: ${label} is a self-explaining 400`);
    }
  }
  const mp = (name, value) => Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    wav, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  for (const [name, value] of [["keyterms[]", "Agent402"], ["keyterms", "Agent402"], ["entities", "true"]]) {
    const x = await throwsWith(() => makeMultipartHandler("transcribe")({}, { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body: mp(name, value) }));
    ok(x?.statusCode === 400 && /not supported/.test(x.message), `multipart ${name} is a 400`);
  }
  globalThis.fetch = realFetch;
  ok(fetched === 0, "no refused request fetched audio or called an upstream");
  // Asking for nothing passes validation (it fails later, on the stubbed fetch, not on the field).
  const { refuseUnservedFields } = await import("../src/tools/stt-kit.js");
  let passed = true;
  for (const extra of [{}, { keyterms: [] }, { keyterms: "" }, { entities: false }, { entities: "false" }, { keyterms: null, entities: null }]) { try { refuseUnservedFields(extra); } catch { passed = false; } }
  ok(passed, "an empty keyterms list or entities:false asks for nothing and passes");
  ok(!("keyterms" in transcribe.discovery.inputSchema.properties) && !("entities" in transcribe.discovery.inputSchema.properties), "the schema advertises neither field");
  ok(/language confidence/.test(transcribe.description) && /language_confidence/.test(transcribe.discovery.inputSchema.properties.diarize.description), "the description and the diarize schema name the language confidence it adds");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
