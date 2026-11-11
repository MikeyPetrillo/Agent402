// Margin-cap tests for the STT kit. The per-tier duration cap is what keeps
// transcribe/transcribe-pro profitable (OpenAI bills per audio minute, the
// tool charges per call) - these tests prove the cap is enforced locally,
// before any upstream spend, and that the cap itself is sized to the model's
// live per-minute rate (2026-09-18: the standard tier moved off
// gpt-4o-mini-transcribe, which OpenAI retires 2027-02-26, onto gpt-transcribe,
// and its cap dropped 5 -> 4 minutes to stay inside the margin rule). Offline: synthetic WAV buffers, no network.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { probeDurationSeconds, assertWithinDurationCap, STT_TIERS, upstreamUsdPerMinute, STT_MARGIN, STT_TOOLS, byteFloorSeconds, __setMeasureForTest, sttUnmeasuredSinceBoot } from "../src/tools/stt-kit.js";
import { measureAudioSeconds } from "../src/tools/media-kit.js";
import { execFileSync } from "node:child_process";
import { requireUpstreamCosts } from "./lib/require-upstream-costs.js";
requireUpstreamCosts("test-stt-cap");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// ---- the cap is a margin bound, derived from the model's rate ----
for (const [slug, tier] of Object.entries(STT_TIERS)) {
  const rate = upstreamUsdPerMinute(tier.model);
  ok(Number.isFinite(rate) && rate > 0, `${slug}: the model it sends (${tier.model}) has a known per-minute rate`);
  const worst = tier.maxMinutes * rate;
  ok(worst <= STT_MARGIN * tier.priceUsd + 1e-12, `${slug}: worst case at the ${tier.maxMinutes}-min cap is under ${STT_MARGIN * 100}% of $${tier.priceUsd}`);
  const tool = STT_TOOLS.find((t) => t.slug === slug);
  ok(Math.abs(Number(tool.price.replace("$", "")) - tier.priceUsd) < 1e-9, `${slug}: the catalog price string matches the tier price the margin is computed on`);
  ok(new RegExp(`Max ${tier.maxMinutes} minutes`).test(tool.description) && tool.description.includes(tier.model) && tool.discovery.output.example.model === tier.model, `${slug}: description states the ${tier.maxMinutes}-minute cap and the model; the example names the model actually sent`);
}
// The retiring models are gone from every tier (OpenAI shutdown 2027-02-26).
ok(!Object.values(STT_TIERS).some((t) => /gpt-4o(-mini)?-transcribe|whisper-1/.test(t.model)), "no tier sends gpt-4o-mini-transcribe, gpt-4o-transcribe or whisper-1");
ok(STT_TIERS.transcribe.model === "gpt-transcribe" && STT_TIERS["transcribe-pro"].model === "gpt-transcribe", "both tiers send gpt-transcribe (they differ in cap and price only, and the pro copy says so)");
ok(!/[Hh]igher accuracy/.test(STT_TOOLS.find((t) => t.slug === "transcribe-pro").description), "the pro tier no longer claims higher accuracy than a tier on the same model");

// Minimal valid PCM WAV of the given length: 8 kHz, mono, 8-bit.
function makeWav(seconds) {
  const sr = 8000;
  const dataLen = Math.round(sr * seconds);
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataLen, 40);
  return buf;
}

const short = makeWav(10);          // 10 s - fine on both tiers
const justOver = makeWav(4.5 * 60); // 4.5 min - over the 4-min standard cap (the old 5-min cap let it through), under the pro cap
const mid = makeWav(6.5 * 60);      // 6.5 min - over the standard cap, under the 10-min pro cap
const long = makeWav(11 * 60);      // 11 min - over both caps
const junk = Buffer.from("definitely not an audio container ".repeat(200));

const d = await probeDurationSeconds(short, "audio.wav");
ok(d !== null && Math.abs(d - 10) < 0.5, `probe reads WAV duration from the header (got ${d}s)`);
ok((await probeDurationSeconds(junk, "audio.mp3")) === null, "unreadable bytes probe to null, never throw");

ok((await assertWithinDurationCap(short, "audio.wav", "transcribe")) > 0, "short clip passes the standard tier");
ok((await assertWithinDurationCap(justOver, "audio.wav", "transcribe-pro")) > 0, "4.5-min clip passes the pro tier");
ok((await assertWithinDurationCap(mid, "audio.wav", "transcribe-pro")) > 0, "6.5-min clip passes the pro tier");

await assertWithinDurationCap(justOver, "audio.wav", "transcribe").then(
  () => ok(false, "4.5-min clip must be rejected by the 4-min standard cap (worst case would be 68% of the price and rising with the clip)"),
  (e) => ok(e.statusCode === 422 && /up to 4 minutes/.test(e.message), `4.5-min clip rejected 422 by the standard cap, message states 4 minutes (${e.message})`)
);

await assertWithinDurationCap(mid, "audio.wav", "transcribe").then(
  () => ok(false, "6.5-min clip must be rejected by the standard cap"),
  (e) => {
    ok(e.statusCode === 422, `standard cap rejects with 422 (got ${e.statusCode})`);
    ok(/transcribe-pro/.test(e.message), "standard-tier rejection points at the pro tier");
  }
);

await assertWithinDurationCap(long, "audio.wav", "transcribe-pro").then(
  () => ok(false, "11-min clip must be rejected by the 10-min pro cap"),
  (e) => ok(e.statusCode === 422 && /10 minutes/.test(e.message), "pro cap rejects with 422 and states its limit")
);

await assertWithinDurationCap(junk, "audio.mp3", "transcribe").then(
  () => ok(false, "unreadable duration must be rejected (unbounded upstream bill otherwise)"),
  (e) => ok(e.statusCode === 422 && /duration/i.test(e.message), "unreadable container -> self-explaining 422")
);

// ---- the cap holds the audio a file plays, not the length it declares ----
// An MP3 of `seconds` at 128 kbps (MPEG-1 Layer III, 44.1 kHz: 417-byte
// frames of silence). `declaredFrames` writes a Xing header into the first
// frame that claims that many frames (and their bytes), whatever the file holds.
function makeMp3(seconds, declaredFrames = null) {
  const FRAME = 417, PER_SEC = 44100 / 1152;
  const n = Math.round(seconds * PER_SEC);
  const buf = Buffer.alloc(n * FRAME);
  for (let i = 0; i < n; i++) buf.writeUInt32BE(0xfffb9000, i * FRAME);
  if (declaredFrames !== null) { buf.write("Xing", 36, "latin1"); buf.writeUInt32BE(3, 40); buf.writeUInt32BE(declaredFrames, 44); buf.writeUInt32BE(declaredFrames * FRAME, 48); }
  return buf;
}
const reject = (p) => p.then(() => null, (e) => e);
{
  const honest = makeMp3(180);
  const lying = makeMp3(330, 100);          // plays 5.5 minutes, declares about 2.6 seconds
  const declared = await probeDurationSeconds(lying, "audio.mp3");
  ok(declared !== null && declared < 10, `the lying MP3's header declares a few seconds (${declared}s)`);

  // The measurement is the longer of the two readings.
  let calls = 0;
  __setMeasureForTest(async () => { calls++; return 330; });
  let e = await reject(assertWithinDurationCap(lying, "audio.mp3", "transcribe"));
  ok(e?.statusCode === 422 && /5\.5 minutes/.test(e.message) && /up to 4 minutes/.test(e.message), `a file that plays 5.5 minutes and declares seconds is refused by the 4-minute cap on what it plays (${e?.message ?? "passed"})`);
  ok(Math.abs((await assertWithinDurationCap(lying, "audio.mp3", "transcribe-pro")) - 330) < 0.01, "the same file passes the 10-minute tier, and the duration returned is the measured one (the margin math reads it)");
  __setMeasureForTest(async () => 1200);
  e = await reject(assertWithinDurationCap(lying, "audio.mp3", "transcribe-pro"));
  ok(e?.statusCode === 422 && /10 minutes/.test(e.message), "a file that plays 20 minutes is refused by the 10-minute tier whatever its header declares");
  __setMeasureForTest(async () => 5);
  ok(Math.abs((await assertWithinDurationCap(short, "audio.wav", "transcribe")) - 10) < 0.5, "a measurement shorter than the declared length never shortens it");
  calls = 0;
  __setMeasureForTest(async () => { calls++; return 1; });
  await reject(assertWithinDurationCap(long, "audio.wav", "transcribe-pro"));
  ok(calls === 0, "a file its own header puts over the cap is refused without a decode");

  // Unmeasured (no ffmpeg here, a failed decode): nothing inside the cap is refused.
  for (const [label, impl] of [["null", async () => null], ["a throw", async () => { throw new Error("spawn failed"); }], ["zero", async () => 0], ["NaN", async () => NaN]]) {
    __setMeasureForTest(impl);
    const before = sttUnmeasuredSinceBoot();
    ok(Math.abs((await assertWithinDurationCap(short, "audio.wav", "transcribe")) - 10) < 0.5 && (await assertWithinDurationCap(honest, "audio.mp3", "transcribe")) > 170, `an unmeasured file inside the cap still passes on its declared length (measure gave ${label})`);
    ok(sttUnmeasuredSinceBoot() === before + 2, "and each unmeasured file is counted");
  }
  // Unmeasured and lossy: held to the shortest its bytes can play.
  __setMeasureForTest(async () => null);
  const heavy = makeMp3(1300, 100);         // about 20.8 MB declaring seconds
  e = await reject(assertWithinDurationCap(heavy, "audio.mp3", "transcribe"));
  ok(e?.statusCode === 422 && /up to 4 minutes/.test(e.message), `unmeasured, a lossy file too large to play under the cap is refused (${e?.message ?? "passed"})`);
  ok(Math.abs(byteFloorSeconds(640_000 / 8 * 100 + 256 * 1024) - 100) < 1e-9 && byteFloorSeconds(1000) === 0 && byteFloorSeconds(10_000_000, 9_900_000) === 0, "the byte floor is bytes over the highest lossy bitrate, less embedded pictures and an allowance");
  // A lossless file is never held to the lossy floor: 96 kHz 24-bit stereo
  // PCM plays one minute in 34 MB, far above any lossy bitrate.
  const hi = (() => { const sr = 96000, bps = 3, ch = 2, secs = 30, dataLen = sr * bps * ch * secs; const b = Buffer.alloc(44 + dataLen); b.write("RIFF", 0); b.writeUInt32LE(36 + dataLen, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * bps * ch, 28); b.writeUInt16LE(bps * ch, 32); b.writeUInt16LE(24, 34); b.write("data", 36); b.writeUInt32LE(dataLen, 40); return b; })();
  ok(Math.abs((await assertWithinDurationCap(hi, "audio.wav", "transcribe")) - 30) < 0.5, `unmeasured, a 30-second lossless file of ${(hi.length / 1e6).toFixed(0)} MB passes (the floor is for lossy audio only)`);
  __setMeasureForTest(null);

  // The real decode. Under CI a missing ffmpeg fails the suite: the lane installs it.
  let ffmpeg = true;
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { ffmpeg = false; }
  if (!ffmpeg) {
    if (process.env.CI) ok(false, "ffmpeg is not installed on this CI runner: the decode measurement cannot be tested (install it in the lane)");
    else console.log("SKIP: ffmpeg not installed here; the decode measurement ran on stubs only");
  } else {
    const m = await measureAudioSeconds(lying);
    ok(Number.isFinite(m) && Math.abs(m - 330) < 3, `the decode measures what the lying MP3 plays (${m}s of 330)`);
    e = await reject(assertWithinDurationCap(lying, "audio.mp3", "transcribe"));
    ok(e?.statusCode === 422 && /up to 4 minutes/.test(e.message), `end to end: the lying MP3 is refused by the 4-minute cap (${e?.message ?? "passed"})`);
    ok((await assertWithinDurationCap(lying, "audio.mp3", "transcribe-pro")) > 320, "end to end: and passes the 10-minute tier at its measured length");
    // No new refusal inside the cap: honest files of each kind, up to the cap's edge.
    ok(Math.abs((await assertWithinDurationCap(short, "audio.wav", "transcribe")) - 10) < 0.5, "end to end: a 10-second WAV passes");
    ok((await assertWithinDurationCap(makeWav(4 * 60), "audio.wav", "transcribe")) > 239, "end to end: a WAV exactly at the 4-minute cap passes");
    ok((await assertWithinDurationCap(makeMp3(239), "audio.mp3", "transcribe")) > 238, "end to end: an honest MP3 just under the cap passes");
    ok((await assertWithinDurationCap(makeMp3(599), "audio.mp3", "transcribe-pro")) > 598, "end to end: an honest MP3 just under the 10-minute cap passes the pro tier");
    ok((await measureAudioSeconds(junk)) === null, "bytes that are no container measure to null, never a throw");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
