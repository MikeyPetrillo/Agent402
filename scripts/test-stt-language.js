// Transcription answers carry a language even though the upstream json
// response format names none: the upstream's own language when it sends one,
// else the caller's hint, else a guess from the transcript's words, else null.
// /api/transcribe-long's published example shows "en"; the answer used to be
// null on every call. Offline: fetch is a stub; no vendor is called.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)

process.env.OPENAI_API_KEY = "sk-test-not-real";
process.env.OPENROUTER_API_KEY = "or-test-not-real";

const { guessTextLanguage, answerLanguage } = await import("../src/text-language.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// ---- the guess on its own ----
ok(guessTextLanguage("Hi, this is the Agent402 sample recording. Can you hear me clearly? Yes, loud and clear. There are two of us on this clip, so the transcript can tell us apart.") === "en", "English sample transcript reads en");
ok(guessTextLanguage("Hola, esta es la grabacion de prueba y los dos estamos en el clip para que se pueda ver quien habla.") === "es", "Spanish transcript reads es");
ok(guessTextLanguage("Bonjour, ceci est un enregistrement et nous sommes deux, mais le texte ne dit pas qui parle avec qui.") === "fr", "French transcript reads fr");
ok(guessTextLanguage("Guten Tag, das ist eine Aufnahme und wir sind zu zweit, aber es ist nicht sehr lang.") === "de", "German transcript reads de");
ok(guessTextLanguage("ok") === null && guessTextLanguage("") === null && guessTextLanguage(null) === null, "too few words: null, never a guess");
ok(guessTextLanguage("こんにちは、これはテストです") === null, "a language outside the list: null");
ok(answerLanguage("english", "fr", "the and is") === "english", "the upstream's own language wins");
ok(answerLanguage(undefined, " FR ", "the and is the and you") === "fr", "then the caller's hint, normalized");
ok(answerLanguage(null, "not a code", "the and is you this that") === "en", "a hint that is not a code is ignored");
{
  const long = Array.from({ length: 5000 }, () => "le la les et the").join(" ");
  const t0 = performance.now(); guessTextLanguage(long); const ms = performance.now() - t0;
  ok(ms < 50, `bounded on a long transcript (${ms.toFixed(1)} ms)`);
}

// ---- through the transcribe-long handler, upstream json without language ----
const AUDIO_URL = "http://93.184.216.34/audio.wav";
function makeWav(seconds) {
  const sr = 8000, n = Math.round(sr * seconds), b = Buffer.alloc(44 + n, 0x80);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  return b;
}
let reply = {};
const sentLanguage = [];
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith(AUDIO_URL)) return new Response(makeWav(3), { status: 200, headers: { "content-type": "audio/wav" } });
  if (!(init?.body instanceof FormData)) throw new Error(`unexpected fetch in an offline suite: ${url}`);
  sentLanguage.push(init.body.get("language"));
  return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
};
const { STT_LONG_TOOL, STT_TOOLS, __setMeasureForTest } = await import("../src/tools/stt-kit.js");
__setMeasureForTest(async (b) => ({ seconds: (b.length - 44) / 8000 }));
const EXAMPLE_TEXT = STT_LONG_TOOL.discovery.output.example.text;
ok(STT_LONG_TOOL.discovery.output.example.language === "en", "control: the published example shows en");

for (const tool of [STT_LONG_TOOL, ...STT_TOOLS.filter((t) => t.slug === "transcribe")]) {
  reply = { text: EXAMPLE_TEXT };
  const a = await tool.handler({ url: AUDIO_URL }, { headers: {} });
  ok(a.language === "en", `${tool.slug}: no upstream language, no hint: the transcript's language (got ${a.language})`);
  reply = { text: "Hola, esta es la grabacion de prueba y los dos estamos en el clip." };
  const b = await tool.handler({ url: AUDIO_URL, language: "es" }, { headers: {} });
  ok(b.language === "es" && sentLanguage.at(-1) === "es", `${tool.slug}: the hint is sent upstream and answered back`);
  reply = { text: EXAMPLE_TEXT, language: "english" };
  const c = await tool.handler({ url: AUDIO_URL }, { headers: {} });
  ok(c.language === "english", `${tool.slug}: an upstream language is passed through unchanged`);
  reply = { text: "ok" };
  const d = await tool.handler({ url: AUDIO_URL }, { headers: {} });
  ok(d.language === null, `${tool.slug}: nothing to go on: null`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
