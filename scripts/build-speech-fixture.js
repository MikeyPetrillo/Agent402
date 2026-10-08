// Builds assets/fixtures/sample-speech.wav: a short spoken exchange between two
// voices, the published example for the transcription tools and the
// subtitle-pipeline pack (diarize:true labels the two speakers).
//
// Spoken by Kokoro-82M (Apache-2.0 weights) through our own tts-lite handler,
// so the audio carries no third-party license, and the text is ours. Unlike
// scripts/build-fixtures.js this is not byte-reproducible (the model runs
// upstream), so the file is committed and this script records exactly how it
// was made. Run with an OpenRouter key:
//   OPENROUTER_API_KEY=... node scripts/build-speech-fixture.js
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TTS_TOOLS } from "../src/tools/tts-kit.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "fixtures", "sample-speech.wav");
const LINES = [
  ["nova", "Hi, this is the Agent402 sample recording. Can you hear me clearly?"],
  ["onyx", "Yes, loud and clear. There are two of us on this clip, so the transcript can tell us apart."],
];
const IN_RATE = 24000; // the speech wire's PCM rate
const OUT_RATE = 16000; // plenty for speech, a third smaller
const GAP_MS = 400;

const lite = TTS_TOOLS.find((t) => t.slug === "tts-lite");
const parts = [];
for (const [voice, text] of LINES) {
  const r = await lite.handler({ text, voice, format: "pcm" });
  parts.push(Buffer.from(r.audio, "base64"));
  parts.push(Buffer.alloc(Math.round((IN_RATE * GAP_MS) / 1000) * 2));
}
const pcm24 = Buffer.concat(parts.slice(0, -1));

// Linear resample 24 kHz -> 16 kHz, 16-bit mono.
const inSamples = pcm24.length / 2;
const outSamples = Math.floor((inSamples * OUT_RATE) / IN_RATE);
const pcm16 = Buffer.alloc(outSamples * 2);
for (let i = 0; i < outSamples; i++) {
  const x = (i * IN_RATE) / OUT_RATE, j = Math.floor(x), f = x - j;
  const a = pcm24.readInt16LE(j * 2), b = j + 1 < inSamples ? pcm24.readInt16LE((j + 1) * 2) : a;
  pcm16.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * f))), i * 2);
}

const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + pcm16.length, 4); header.write("WAVE", 8);
header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(OUT_RATE, 24); header.writeUInt32LE(OUT_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write("data", 36); header.writeUInt32LE(pcm16.length, 40);
writeFileSync(OUT, Buffer.concat([header, pcm16]));
console.log(`wrote ${OUT}: ${(pcm16.length / 2 / OUT_RATE).toFixed(1)} s, ${44 + pcm16.length} bytes`);
