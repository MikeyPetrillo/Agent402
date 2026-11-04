// FFmpeg video-decode lockout (audit R-06 / CVE-2026-8461 MagicYUV).
//
// The media tools only process AUDIO, but `-vn` alone does not keep a video
// decoder from running: it selects output streams, while ffprobe and ffmpeg's
// stream probing (avformat_find_stream_info) open and run the decoder of every
// input stream, video included. What keeps video decoders closed is
// `-codec_whitelist` with an audio-only list, passed as an input option before
// `-i` on every ffmpeg and ffprobe call (media-kit AUDIO_DECODERS).
//
// This test locks that in three ways:
//   1. a source scan: every ffmpeg/ffprobe call in src/ carries the whitelist
//      (literally, or through mediaInputArgs' `...input`), and every ffmpeg
//      call keeps -vn and selects no video codec;
//   2. the argument lists each kit function actually passes (stub runner):
//      -codec_whitelist precedes -i and names audio decoders only;
//   3. real ffmpeg on a MagicYUV AVI and an MPEG-4 Part 2 MP4: the video
//      decoder is refused by the whitelist, media-info still lists the video
//      stream (decoded: false), the mp4's audio converts, and the video-only
//      file is refused with 422. Under CI a missing ffmpeg is a failure.
//
//   node scripts/test-ffmpeg-novideo.js
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { AUDIO_DECODERS, probeMedia, toMp3, normalizeAudio, transcodePcm, __setExecFileForTest } from "../src/tools/media-kit.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// ---- 1. source scan -------------------------------------------------------
const files = [];
const walk = (d) => {
  for (const name of readdirSync(d)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(d, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (/\.(js|mjs|cjs)$/.test(name) && p !== SELF) files.push(p);
  }
};
walk(join(ROOT, "src"));

const CALL = /(?:run|execFile|execFileSync|spawn|spawnSync)\(\s*["'`](ffmpeg|ffprobe)["'`]\s*,\s*\[([\s\S]*?)\]/g;
let ffmpegCalls = 0, probeCalls = 0;
const offenders = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const rel = f.replace(ROOT + "/", "");
  for (const m of src.matchAll(CALL)) {
    const [, bin, args] = m;
    if (bin === "ffmpeg") ffmpegCalls++; else probeCalls++;
    const flat = args.replace(/\s+/g, " ").slice(0, 90);
    const whitelisted = /["'`]-codec_whitelist["'`]/.test(args) || (/\.\.\.input\b/.test(args) && /mediaInputArgs\(/.test(src));
    if (!whitelisted) offenders.push(`${rel}: ${bin} call without -codec_whitelist -> ${flat}`);
    if (bin === "ffmpeg" && !/["'`]-vn["'`]/.test(args)) offenders.push(`${rel}: ffmpeg call without -vn -> ${flat}`);
    if (bin === "ffmpeg" && /-c:v|-vcodec|-map\s*["'`]?0:v/.test(args)) offenders.push(`${rel}: ffmpeg call selects a VIDEO codec/stream`);
  }
}
ok(ffmpegCalls > 0 && probeCalls > 0, `found ffmpeg (${ffmpegCalls}) and ffprobe (${probeCalls}) invocations to check`);
ok(offenders.length === 0, `every ffmpeg/ffprobe call names an audio-only decoder list; ffmpeg calls keep -vn${offenders.length ? ":\n  " + offenders.join("\n  ") : ""}`);

// ---- 2. the argument lists the kit passes ----------------------------------
const VIDEO_DECODERS = ["magicyuv", "h264", "hevc", "mpeg4", "vp8", "vp9", "av1", "mjpeg", "png", "prores", "rawvideo"];
const allowed = AUDIO_DECODERS.split(",");
ok(allowed.length > 5 && VIDEO_DECODERS.every((d) => !allowed.includes(d)), "AUDIO_DECODERS names no video or image decoder");
const calls = [];
__setExecFileForTest((bin, args, opts, cb) => { calls.push({ bin, args }); cb(Object.assign(new Error("stub"), { code: 1 }), "", ""); });
const settle = async (p) => { try { await p; } catch { /* the stub runner always fails */ } };
const mp4Head = Buffer.concat([Buffer.from("\0\0\0\x20ftypisom", "latin1"), Buffer.alloc(64)]);
for (const [label, run] of [
  ["media-info", () => probeMedia(mp4Head)],
  ["audio-convert", () => toMp3(mp4Head, { bitrate: "128k" })],
  ["audio-normalize", () => normalizeAudio(mp4Head, { targetLufs: -16 })],
  ["speech PCM transcode", () => transcodePcm(Buffer.alloc(4800), "wav")],
]) {
  calls.length = 0;
  await settle(run());
  const a = calls[0]?.args ?? [];
  const i = a.indexOf("-i"), w = a.indexOf("-codec_whitelist");
  const list = w >= 0 ? String(a[w + 1]).split(",") : [];
  ok(calls.length === 1 && w >= 0 && w < i, `${label}: -codec_whitelist precedes -i (${calls[0]?.bin} ${a.slice(0, 4).join(" ")} ...)`);
  ok(list.length > 0 && list.every((d) => allowed.includes(d)), `${label}: the whitelist names audio decoders only`);
}
__setExecFileForTest(null);

// ---- 3. real ffmpeg on video inputs ------------------------------------------
let haveFfmpeg = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { haveFfmpeg = false; }
if (!haveFfmpeg) {
  if (process.env.CI) ok(false, "ffmpeg is installed on this CI runner (install it in the lane rather than skipping)");
  else console.log("SKIP - real-ffmpeg checks (ffmpeg not installed here; CI and production have it)");
} else {
  const dir = mkdtempSync(join(tmpdir(), "a402-novideo-"));
  try {
    const avi = join(dir, "m.avi"), mp4 = join(dir, "v.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=d=1:s=160x120", "-c:v", "magicyuv", avi]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=d=1:s=160x120", "-f", "lavfi", "-i", "sine=d=1", "-c:v", "mpeg4", "-c:a", "aac", "-shortest", mp4]);
    // Keep each real run's stderr: the refusal line proves the decoder never opened.
    const seen = [];
    __setExecFileForTest((bin, args, opts, cb) => execFile(bin, args, opts, (e, so, se) => { seen.push({ bin, stderr: String(se) }); cb(e, so, se); }));
    const aviBuf = readFileSync(avi), mp4Buf = readFileSync(mp4);

    seen.length = 0;
    const info = await probeMedia(aviBuf);
    ok(seen.some((s) => /Codec \(magicyuv\) not on whitelist/.test(s.stderr)), "ffprobe on a MagicYUV AVI: the magicyuv decoder is refused by the whitelist");
    const v = info.streams.find((s) => s.type === "video");
    ok(v && v.codec === "magicyuv" && v.decoded === false && v.width === 160 && v.height === 120 && v.fps === "25/1",
      `media-info still lists the video stream from its headers, marked decoded: false (${JSON.stringify(v)})`);
    ok(info.formatName === "avi" && info.durationSec > 0.9 && info.bytes === aviBuf.length, `media-info keeps formatName/durationSec/bytes (${info.formatName}, ${info.durationSec})`);

    for (const [label, fn] of [["audio-convert", () => toMp3(aviBuf)], ["audio-normalize", () => normalizeAudio(aviBuf)]]) {
      seen.length = 0;
      let err = null;
      try { await fn(); } catch (e) { err = e; }
      ok(err && err.statusCode === 422, `${label} of a video-only AVI is refused with 422 (${err?.statusCode})`);
      ok(seen.some((s) => /Codec \(magicyuv\) not on whitelist/.test(s.stderr)), `${label}: the magicyuv decoder is refused by the whitelist`);
    }

    seen.length = 0;
    const mp3 = await toMp3(mp4Buf, { bitrate: "128k" });
    ok(mp3.bytes > 1000 && Buffer.from(mp3.mp3Base64, "base64").length === mp3.bytes, `the audio track of an MPEG-4 video still converts to mp3 (${mp3.bytes} bytes)`);
    ok(seen.some((s) => /Codec \(mpeg4\) not on whitelist/.test(s.stderr)), "converting the mp4: the mpeg4 video decoder is refused by the whitelist");
    const mi = await probeMedia(mp4Buf);
    ok(mi.streams.some((s) => s.type === "audio" && s.codec === "aac" && s.sampleRate > 0 && s.channels === 1) && mi.streams.some((s) => s.type === "video" && s.decoded === false),
      `media-info on the mp4 reports the aac stream in full and the video stream as not decoded (${JSON.stringify(mi.streams)})`);
  } finally {
    __setExecFileForTest(null);
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed (${ffmpegCalls} ffmpeg + ${probeCalls} ffprobe calls scanned)`);
process.exit(fail ? 1 : 0);
