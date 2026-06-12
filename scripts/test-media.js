// Media-kit tests: generate a real 2s sine-wave WAV with ffmpeg (present on CI
// runners and in the production image), then exercise the pure transforms on
// buffers. Skips cleanly where ffmpeg is unavailable (e.g. local sandboxes).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeMedia, toMp3, normalizeAudio } from "../src/tools/media-kit.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  console.log("SKIP: ffmpeg not installed in this environment (CI and production have it)");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "a402-media-test-"));
const wavPath = join(dir, "tone.wav");
execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", wavPath], { stdio: "ignore" });
const wav = readFileSync(wavPath);
console.log(`generated test tone: ${wav.length} bytes`);

const info = await probeMedia(wav);
if (!info.durationSec || Math.abs(info.durationSec - 4) > 0.3) fail(`probe duration wrong: ${JSON.stringify(info)}`);
if (info.streams[0]?.type !== "audio") fail("probe missed the audio stream");
console.log(`media-info ✓ (duration ${info.durationSec}s, codec ${info.streams[0].codec})`);

const mp3 = await toMp3(wav, { bitrate: "128k" });
if (!mp3.mp3Base64 || mp3.bytes < 1000) fail(`toMp3 output too small: ${mp3.bytes}`);
const mp3buf = Buffer.from(mp3.mp3Base64, "base64");
const mp3info = await probeMedia(mp3buf);
if (!/mp3/.test(mp3info.formatName ?? "")) fail(`mp3 round-trip not mp3: ${mp3info.formatName}`);
console.log(`audio-convert ✓ (${mp3.bytes} bytes, probes back as ${mp3info.formatName})`);

// Measure a buffer's REAL integrated loudness (LUFS) with ffmpeg's ebur128 —
// this is what proves audio-normalize actually changed the loudness, not just
// "returned a valid mp3".
async function measureLufs(buffer) {
  const dir = mkdtempSync(join(tmpdir(), "a402-lufs-"));
  const p = join(dir, "m");
  writeFileSync(p, buffer);
  let stderr = "";
  try {
    execFileSync("ffmpeg", ["-i", p, "-af", "ebur128=framelog=verbose", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    stderr = (e.stderr || "").toString();
  }
  rmSync(dir, { recursive: true, force: true });
  // ffmpeg prints a summary block ending with "I:  -23.0 LUFS"
  const matches = [...stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

// A 440Hz sine at default amplitude measures around -3 LUFS (very loud).
const beforeLufs = await measureLufs(wav);
const norm = await normalizeAudio(wav, { targetLufs: -16 });
if (!norm.mp3Base64 || norm.targetLufs !== -16) fail(`normalize wrong: ${JSON.stringify({ ...norm, mp3Base64: "…" })}`);
const normBuf = Buffer.from(norm.mp3Base64, "base64");
const ninfo = await probeMedia(normBuf);
if (!ninfo.durationSec || ninfo.durationSec < 1.5) fail("normalized audio lost its duration");
const afterLufs = await measureLufs(normBuf);
if (afterLufs === null) fail("could not measure output loudness");
// The output must actually sit near the -16 target (loudnorm one-pass tolerance
// is generous, so allow ±3 LU) AND be quieter than the loud input.
if (Math.abs(afterLufs - -16) > 3) fail(`audio-normalize did NOT hit target: asked -16 LUFS, output measured ${afterLufs} LUFS (input was ${beforeLufs})`);
if (beforeLufs !== null && afterLufs >= beforeLufs) fail(`loudness did not change: ${beforeLufs} -> ${afterLufs}`);
console.log(`audio-normalize ✓ REALLY normalized: input ${beforeLufs} LUFS → output ${afterLufs} LUFS (target -16)`);

// audio-convert must preserve the actual audio (duration within 0.1s), not
// just emit bytes.
const conv = await toMp3(wav, { bitrate: "192k" });
const convInfo = await probeMedia(Buffer.from(conv.mp3Base64, "base64"));
if (Math.abs((convInfo.durationSec ?? 0) - (info.durationSec ?? 0)) > 0.15) fail(`audio-convert changed duration: ${info.durationSec} -> ${convInfo.durationSec}`);
console.log(`audio-convert ✓ preserved audio (${info.durationSec}s in → ${convInfo.durationSec}s out)`);

// validation
let threw = false;
try { await toMp3(wav, { bitrate: "lots" }); } catch { threw = true; }
if (!threw) fail("bad bitrate should be rejected");
try { await normalizeAudio(wav, { targetLufs: 5 }); fail("LUFS +5 should be rejected"); } catch {}
try { await probeMedia(Buffer.from("not media")); fail("garbage should be rejected"); } catch {}
console.log("validation ✓ (bitrate, LUFS range, non-media rejected)");

rmSync(dir, { recursive: true, force: true });
console.log("\nmedia-kit: all assertions passed");
process.exit(0);
