// Media kit — ffmpeg-backed audio tools for two of the biggest observed unmet
// agent demands: "ffmpeg normalize audio" and "mp4 to mp3".
// Deterministic, no AI; ffmpeg is invoked
// directly (execFile, no shell) on temp files with hard limits:
//   • input capped at 30MB (SSRF-guarded fetch)
//   • 90s processing timeout, process killed on breach
//   • at most 2 concurrent jobs (busy callers get 429 + Retry-After)
// Transforms are pure functions over Buffers (unit-testable); the catalog
// handlers fetch then delegate.
import { execFile } from "node:child_process";
import { childEnv } from "./child-env.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir, availableParallelism } from "node:os";
import { join } from "node:path";
import { safeFetch } from "./fetch-guard.js";

const MAX_MEDIA_BYTES = 30 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 90_000;
const MAX_CONCURRENT = 2;
let active = 0;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
function need(input, field) {
  const v = input[field];
  if (v === undefined || v === null || v === "") throw bad(`Missing or invalid "${field}"`);
  return v;
}

let execImpl = execFile;
/** Test seam: replace the process runner (args are recorded, nothing spawns). */
export function __setExecFileForTest(fn) { execImpl = fn || execFile; }

/** The demuxer for a downloaded body, named from its magic bytes, or null.
 *  Naming it stops ffmpeg from probing the body as a playlist or a concat
 *  list, which are formats that name further inputs. An ID3v2 tag at the
 *  start is skipped by its declared size and what follows it is named (ADTS
 *  AAC and FLAC carry such tags too; MP3 when nothing else is recognized). A
 *  body whose start names nothing is scanned, up to MPEG_SCAN_BYTES, for two
 *  consecutive MPEG audio frames (an MP3 with leading padding). */
export function inputFormatOf(buffer) {
  if (!buffer || buffer.length < 12) return null;
  let at = 0, tagged = false;
  // Tags can be stacked; a few are skipped, never an unbounded walk.
  for (let i = 0; i < 4 && at + 10 <= buffer.length && buffer[at] === 0x49 && buffer[at + 1] === 0x44 && buffer[at + 2] === 0x33; i++) {
    const size = id3v2Size(buffer, at);
    if (size === null) break;
    at += size;
    tagged = true;
  }
  if (tagged) {
    const rest = at < buffer.length ? buffer.subarray(at) : Buffer.alloc(0);
    const after = rest.length >= 12 ? magicFormatOf(rest) : null;
    return after || mpegScanFormatOf(rest) || "mp3";
  }
  return magicFormatOf(buffer) || mpegScanFormatOf(buffer);
}
/** The size of the ID3v2 tag at `at` (header, body and footer), or null when
 *  the header is malformed (its size bytes are syncsafe: high bit clear). */
function id3v2Size(b, at) {
  const flags = b[at + 5];
  const sz = [b[at + 6], b[at + 7], b[at + 8], b[at + 9]];
  if (sz.some((x) => x === undefined || x & 0x80) || b[at + 3] === 0xff || b[at + 4] === 0xff) return null;
  const body = (sz[0] << 21) | (sz[1] << 14) | (sz[2] << 7) | sz[3];
  return 10 + body + (flags & 0x10 ? 10 : 0);
}
/** How far into a body the MPEG frame scan looks. */
const MPEG_SCAN_BYTES = 64 * 1024;
const MPEG_BITRATES_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG_BITRATES_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MPEG_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
/** The length of the MPEG layer III frame whose header is at `i`, or 0. */
function mp3FrameLength(b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return 0;
  const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3;
  const br = (b[i + 2] >> 4) & 15, sr = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
  if (ver === 1 || layer !== 1 || br === 0 || br === 15 || sr === 3) return 0;
  const kbps = (ver === 3 ? MPEG_BITRATES_V1L3 : MPEG_BITRATES_V2L3)[br];
  const rate = MPEG_RATES[ver][sr];
  return Math.floor(((ver === 3 ? 144 : 72) * kbps * 1000) / rate) + pad;
}
/** "mp3" when the first MPEG_SCAN_BYTES of a body hold a layer III frame
 *  header followed, at that frame's length, by another; else null. */
function mpegScanFormatOf(b) {
  const end = Math.min(b.length - 4, MPEG_SCAN_BYTES);
  for (let i = 0; i < end; i++) {
    if (b[i] !== 0xff) continue;
    const len = mp3FrameLength(b, i);
    if (len >= 24 && mp3FrameLength(b, i + len) > 0) return "mp3";
  }
  return null;
}
/** The demuxer named by the magic bytes at the start of a body, or null. */
function magicFormatOf(b) {
  const s4 = b.subarray(0, 4).toString("latin1");
  if (s4 === "OggS") return "ogg";
  if (s4 === "fLaC") return "flac";
  if (s4 === "RIFF") { const k = b.subarray(8, 12).toString("latin1"); return k === "WAVE" ? "wav" : k === "AVI " ? "avi" : null; }
  if (s4 === "FORM") { const k = b.subarray(8, 12).toString("latin1"); return k === "AIFF" || k === "AIFC" ? "aiff" : null; }
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return "mp3";
  if (b[0] === 0xff && (b[1] & 0xe6) === 0xe2) return "mp3";
  if (b.subarray(4, 8).toString("latin1") === "ftyp") return "mov";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "matroska";
  // Common recorder outputs: ASF (WMA, Windows recorders), raw ADTS AAC
  // (sync word with layer 00), AMR (phone voice memos and call recordings),
  // CAF (Apple recording apps). None of these demuxers names a further input.
  if (b.subarray(0, 16).equals(ASF_HEADER_GUID)) return "asf";
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return "aac";
  if (b.subarray(0, 6).toString("latin1") === "#!AMR\n" || b.subarray(0, 9).toString("latin1") === "#!AMR-WB\n") return "amr";
  if (s4 === "caff") return "caf";
  return null;
}
const ASF_HEADER_GUID = Buffer.from("3026b2758e66cf11a6d900aa0062ce6c", "hex");

/** The decoders an input may open: audio only. `-vn` selects output streams;
 *  it does not stop ffprobe or ffmpeg's stream probing from opening and
 *  running a video stream's decoder on the input. This list, passed before
 *  `-i`, applies to that probing and to every decoder the run opens, so a
 *  video, subtitle or image stream inside a container is never decoded. */
export const AUDIO_DECODERS = [
  "aac", "aac_fixed", "aac_latm", "ac3", "ac3_fixed", "eac3", "alac", "flac",
  "mp1", "mp1float", "mp2", "mp2float", "mp3", "mp3float", "mp3adu", "mp3adufloat",
  "opus", "libopus", "vorbis", "libvorbis", "dca", "wavpack", "amrnb", "amrwb",
  "adpcm_ms", "adpcm_ima_wav", "adpcm_ima_qt", "gsm_ms",
  "wmav1", "wmav2", "wmapro", "wmalossless", "wmavoice",
  "pcm_s16le", "pcm_s16be", "pcm_s24le", "pcm_s24be", "pcm_s32le", "pcm_s32be",
  "pcm_f32le", "pcm_f32be", "pcm_f64le", "pcm_f64be", "pcm_u8", "pcm_s8", "pcm_alaw", "pcm_mulaw",
].join(",");
const AUDIO_DECODER_SET = new Set(AUDIO_DECODERS.split(","));

/** Input arguments for a downloaded file: local file reads only, the
 *  demuxer named explicitly, audio decoders only. An unrecognized body is
 *  refused before ffmpeg runs. */
export function mediaInputArgs(buffer, inPath, format = null) {
  const fmt = format || inputFormatOf(buffer);
  if (!fmt) throw bad("media could not be processed (unrecognized container; send an audio/video file such as mp3, mp4, wav, ogg, flac or webm)", 422);
  return ["-codec_whitelist", AUDIO_DECODERS, "-protocol_whitelist", "file", "-f", fmt, "-i", inPath];
}

function run(bin, args, { keepFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execImpl(bin, args, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: childEnv() }, (err, stdout, stderr) => {
      if (err && keepFailure && err.code !== "ENOENT" && !err.killed) return resolve({ failed: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      if (err) {
        // A missing binary is OUR configuration, never the buyer's file: say
        // so as a 503 (uncharged). The 422 wording blamed the file for a
        // runner without ffmpeg (corpus nightly, 2026-09-06).
        if (err.code === "ENOENT") return reject(bad(`${bin} is not installed on this server - the media tools are unavailable here`, 503));
        const why = err.killed ? "processing timed out" : "media could not be processed";
        return reject(bad(`${why} (is the input a valid audio/video file?)`, 422));
      }
      resolve({ stdout, stderr });
    });
  });
}

async function withTmp(fn) {
  if (active >= MAX_CONCURRENT) {
    throw Object.assign(bad("Media workers busy - retry in a few seconds", 429), { retryAfter: 5 });
  }
  active++;
  const dir = await mkdtemp(join(tmpdir(), "a402-media-"));
  try {
    return await fn(dir);
  } finally {
    active--;
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- pure transforms over Buffers (no network) ----------------------------
export async function probeMedia(buffer) {
  return withTmp(async (dir) => {
    const inPath = join(dir, "in");
    const input = mediaInputArgs(buffer, inPath);
    await writeFile(inPath, buffer);
    const res = await run("ffprobe", [
      "-hide_banner", "-v", "info", "-print_format", "json", "-show_format", "-show_streams", ...input,
    ], { keepFailure: true });
    if (res.failed) {
      // ffprobe stops when a stream's decoder is outside AUDIO_DECODERS (a
      // video track, cover art, subtitles). Its input summary, printed before
      // that stop, still names every stream from the container headers.
      const summary = /not on whitelist/.test(res.stderr) ? probeSummaryOf(res.stderr, buffer.length) : null;
      if (summary) return summary;
      throw bad("media could not be processed (is the input a valid audio/video file?)", 422);
    }
    let data;
    try { data = JSON.parse(res.stdout); } catch { throw bad("ffprobe returned no metadata", 422); }
    const f = data.format ?? {};
    return {
      formatName: f.format_name ?? null,
      durationSec: f.duration ? Number(f.duration) : null,
      bitrate: f.bit_rate ? Number(f.bit_rate) : null,
      bytes: buffer.length,
      streams: (data.streams ?? []).map((s) => ({
        type: s.codec_type,
        codec: s.codec_name,
        ...(s.codec_type === "audio" ? { sampleRate: Number(s.sample_rate) || null, channels: s.channels ?? null } : {}),
        ...(s.codec_type === "video" ? { width: s.width ?? null, height: s.height ?? null, fps: s.avg_frame_rate ?? null } : {}),
      })),
    };
  });
}

const CHANNEL_LAYOUTS = { mono: 1, stereo: 2, "2.1": 3, "3.0": 3, quad: 4, "4.0": 4, "5.0": 5, "5.0(side)": 5, "5.1": 6, "5.1(side)": 6, "6.1": 7, "7.1": 8 };
/** "25 fps" / "29.97 fps" as the rational string ffprobe reports. */
const NTSC_RATES = { "23.98": "24000/1001", "23.976": "24000/1001", "29.97": "30000/1001", "59.94": "60000/1001" };
const fpsRational = (v) => {
  if (!v) return null;
  if (NTSC_RATES[v]) return NTSC_RATES[v];
  const [w, d = ""] = v.split(".");
  return `${Number(w + d)}/${10 ** d.length}`;
};
/** The answer for an input holding a stream ffprobe would not decode, read
 *  from its input summary (container headers only). Such a stream carries
 *  `decoded: false`. Exported for the test. */
export function probeSummaryOf(stderr, bytes) {
  const lines = String(stderr).split("\n");
  const first = (re) => { for (const l of lines) { const m = re.exec(l); if (m) return m; } return null; };
  const head = first(/^Input #0, (.+?), from /);
  if (!head) return null;
  const dur = first(/^\s*Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/);
  const br = first(/^\s*Duration: .*bitrate: (\d+) kb\/s/);
  const streams = [];
  for (const l of lines) {
    const m = /^\s*Stream #0:\d+\S*: (Video|Audio|Subtitle|Data|Attachment): (\w+)(.*)$/.exec(l);
    if (!m) continue;
    const type = m[1].toLowerCase(), codec = m[2], rest = m[3];
    const s = { type, codec };
    if (type === "audio") {
      s.sampleRate = Number(/(\d+) Hz/.exec(rest)?.[1]) || null;
      const ch = /Hz, ([^,]+)/.exec(rest)?.[1]?.trim();
      s.channels = ch ? (CHANNEL_LAYOUTS[ch] ?? (Number(/^(\d+) channels/.exec(ch)?.[1]) || null)) : null;
    }
    if (type === "video") {
      const wh = /, (\d{1,5})x(\d{1,5})/.exec(rest);
      s.width = wh ? Number(wh[1]) : null;
      s.height = wh ? Number(wh[2]) : null;
      s.fps = fpsRational(/([\d.]+) fps/.exec(rest)?.[1]);
    }
    if (type !== "audio" || !AUDIO_DECODER_SET.has(codec)) s.decoded = false;
    streams.push(s);
  }
  return {
    formatName: head[1],
    durationSec: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null,
    bitrate: br ? Number(br[1]) * 1000 : null,
    bytes,
    streams,
  };
}

export async function toMp3(buffer, { bitrate = "192k" } = {}) {
  if (!/^\d{2,3}k$/.test(bitrate)) throw bad('"bitrate" must look like "128k"/"192k"/"320k"');
  return withTmp(async (dir) => {
    const inPath = join(dir, "in");
    const outPath = join(dir, "out.mp3");
    const input = mediaInputArgs(buffer, inPath);
    await writeFile(inPath, buffer);
    await run("ffmpeg", ["-y", ...input, "-vn", "-map_metadata", "-1", "-b:a", bitrate, outPath]);
    const out = await readFile(outPath);
    return { format: "mp3", bitrate, bytes: out.length, mp3Base64: out.toString("base64") };
  });
}

// Speech PCM (16-bit little-endian, mono) to a container format. The speech
// wire we buy from serves mp3 and pcm only, so /api/tts encodes the other four
// formats it has always offered here. Its own small pool: a transcode of known,
// bounded input takes milliseconds and must not queue behind a 30 MB media job.
const PCM_FORMATS = {
  wav: ["-c:a", "pcm_s16le", "-f", "wav"],
  flac: ["-c:a", "flac", "-f", "flac"],
  opus: ["-c:a", "libopus", "-b:a", "64k", "-f", "ogg"],
  aac: ["-c:a", "aac", "-b:a", "128k", "-f", "adts"],
};
//
// A full pool QUEUES, it never refuses: the speech was already bought when this
// runs, so a "busy" refusal would discard paid-for audio. A slot is handed straight to
// the next waiter on release.
const PCM_MAX_CONCURRENT = 4;
let pcmActive = 0;
const pcmWaiters = [];
const pcmAcquire = () => (pcmActive < PCM_MAX_CONCURRENT ? (pcmActive++, Promise.resolve()) : new Promise((resolve) => pcmWaiters.push(resolve)));
const pcmRelease = () => { const next = pcmWaiters.shift(); if (next) next(); else pcmActive--; };
export const __pcmPoolForTest = () => ({ active: pcmActive, waiting: pcmWaiters.length });
export async function transcodePcm(buffer, format, { sampleRate = 24000 } = {}) {
  const out = PCM_FORMATS[format];
  if (!out) throw bad(`Cannot encode speech as "${format}"`);
  await pcmAcquire();
  const dir = await mkdtemp(join(tmpdir(), "a402-pcm-"));
  try {
    const inPath = join(dir, "in.pcm");
    const outPath = join(dir, `out.${format}`);
    await writeFile(inPath, buffer);
    await run("ffmpeg", ["-y", "-codec_whitelist", "pcm_s16le", "-protocol_whitelist", "file", "-f", "s16le", "-ar", String(sampleRate), "-ac", "1", "-i", inPath, "-vn", "-map_metadata", "-1", ...out, outPath]);
    return await readFile(outPath);
  } finally {
    pcmRelease();
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function normalizeAudio(buffer, { targetLufs = -16 } = {}) {
  const lufs = Number(targetLufs);
  if (!Number.isFinite(lufs) || lufs < -36 || lufs > -8) throw bad('"targetLufs" must be between -36 and -8 (default -16)');
  return withTmp(async (dir) => {
    const inPath = join(dir, "in");
    const outPath = join(dir, "out.mp3");
    const input = mediaInputArgs(buffer, inPath);
    await writeFile(inPath, buffer);
    // EBU R128 two-in-one: loudnorm in dynamic mode, then encode to mp3.
    await run("ffmpeg", [
      "-y", ...input, "-vn", "-map_metadata", "-1",
      "-af", `loudnorm=I=${lufs}:TP=-1.5:LRA=11`,
      "-b:a", "192k", outPath,
    ]);
    const out = await readFile(outPath);
    return { format: "mp3", targetLufs: lufs, truePeakDb: -1.5, bytes: out.length, mp3Base64: out.toString("base64") };
  });
}

// The length of the audio a file actually holds, measured by decoding its
// first audio stream to nowhere and reading how far the decoder got. A
// container's own duration field is a claim the file makes about itself (an
// MP3's frame count, an MP4's movie header); this is what a decoder plays.
//
// Returns seconds, or null when it cannot be measured here (no ffmpeg on this
// server, an unrecognized container, a decode that fails or outlasts its
// deadline). It never throws and never refuses: a full pool queues, and the
// caller decides what an unmeasured file means. measureAudio says which of
// those it was: { seconds }, { undecodable } when the file itself cannot be
// decoded here (a container the decoder is not given, or a decode that ran
// and failed or reported no length), or { unavailable } when the measurement
// did not run to an answer for a reason of this server's (no ffmpeg, no
// free slot in the time the caller gave, the deadline, a temp-file error).
//
// The pool holds one decode per CPU the process may use (at least 2, at most
// MEASURE_POOL_MAX); AUDIO_DECODE_SLOTS overrides it. A caller that passes
// `deadlineAt` (the epoch ms by which its decode must be done) waits for a
// slot for as long as that still leaves MEASURE_MIN_DECODE_MS to decode, and
// its decode may run to that deadline (at most MEASURE_MAX_DECODE_MS). A
// caller without one keeps the short fixed wait and deadline.
export const MEASURE_MIN_DECODE_MS = 10_000;
export const MEASURE_MAX_DECODE_MS = 60_000;
const MEASURE_WAIT_MS = 5_000;
const MEASURE_POOL_MAX = 8;
/** Decode slots: AUDIO_DECODE_SLOTS (1 to 64) when set, else the CPUs this
 *  process may use, held to 2..MEASURE_POOL_MAX. Read on every acquire. */
export function measurePoolSize(env = process.env) {
  const n = Number(env.AUDIO_DECODE_SLOTS);
  if (Number.isInteger(n) && n >= 1 && n <= 64) return n;
  let cpus = 2;
  try { cpus = availableParallelism(); } catch { /* keep the floor */ }
  return Math.max(2, Math.min(MEASURE_POOL_MAX, Number.isInteger(cpus) ? cpus : 2));
}
let measureActive = 0;
const measureWaiters = [];
// Resolves true with a slot held, or false when none came free within `waitMs`.
const measureAcquire = (waitMs) => {
  if (measureActive < measurePoolSize()) { measureActive++; return Promise.resolve(true); }
  if (!(waitMs > 0)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const waiter = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { const i = measureWaiters.indexOf(waiter); if (i !== -1) measureWaiters.splice(i, 1); resolve(false); }, waitMs);
    timer.unref?.();
    measureWaiters.push(waiter);
  });
};
const measureRelease = () => { const next = measureWaiters.shift(); if (next) next(); else measureActive--; };
/** Slots in use and calls waiting, for tests. */
export const __measurePoolForTest = () => ({ active: measureActive, waiting: measureWaiters.length, size: measurePoolSize() });
export async function measureAudioSeconds(buffer) {
  const m = await measureAudio(buffer);
  return Number.isFinite(m.seconds) ? m.seconds : null;
}
/** { seconds, format, audioTracks? } (format: the demuxer that read it). With
 *  `cutSeconds`, the same run also writes the first audio stream as 16 kHz
 *  mono FLAC cut at that length (transcodeSpeech's output), answered as
 *  `audio`: one decode measures the whole file and converts it, instead of a
 *  measurement followed by a second decode for the conversion. */
export async function measureAudio(buffer, { cutSeconds = null, format = null, deadlineAt = null } = {}) {
  if (Number.isFinite(cutSeconds) && cutSeconds > 0) {
    let outPath = null;
    return decodeInMeasurePool(buffer, "a402-measure-", (dir) => {
      outPath = join(dir, "out.flac");
      // Output 0: the cut. Output 1: the whole stream at 100 one-byte samples
      // a second on stdout, so its byte count is the length (the progress
      // clock of a run with two outputs follows the shorter one).
      return ["-t", String(cutSeconds), "-ac", "1", "-ar", "16000", "-c:a", "flac", "-f", "flac", "-y", outPath,
        "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", String(COUNTER_RATE), "-c:a", "pcm_u8", "-f", "u8", "pipe:1"];
    }, async (seconds) => {
      const audio = await readFile(outPath);
      return audio.length > 0 ? { seconds, audio } : { seconds };
    }, { format, counter: true, deadlineAt });
  }
  return decodeInMeasurePool(buffer, "a402-measure-", () => ["-f", "null", "-"], (seconds) => ({ seconds }), { format, deadlineAt });
}
/** Samples a second of the length counter (one byte each): 10 ms resolution. */
const COUNTER_RATE = 100;

/** The first audio stream as 16 kHz mono FLAC, cut at `maxSeconds` (ffmpeg
 *  `-t`), for a speech upstream: FLAC is on its documented input list, and
 *  16 kHz mono FLAC holds at most 32 KB a second, so a ten-minute cut stays
 *  under the 25 MB upload limit. It runs in the measurement's pool, under the
 *  same wait and deadline rules (`deadlineAt`); a cut reads only up to `maxSeconds` of audio, so it can
 *  finish where a full measurement outlasted the deadline. Answers
 *  { audio, seconds } (seconds: the length written, which is the file's whole
 *  length when it is shorter than the cut), or measureAudio's { undecodable }
 *  or { unavailable }. Never throws. */
export async function transcodeSpeech(buffer, { maxSeconds, format = null, deadlineAt = null }) {
  if (!(Number.isFinite(maxSeconds) && maxSeconds > 0)) return { unavailable: "no length to cut at was given" };
  let outPath = null;
  return decodeInMeasurePool(buffer, "a402-speech-", (dir) => {
    outPath = join(dir, "out.flac");
    return ["-t", String(maxSeconds), "-ac", "1", "-ar", "16000", "-c:a", "flac", "-f", "flac", "-y", outPath];
  }, async (seconds) => {
    const audio = await readFile(outPath);
    return audio.length > 0 ? { audio, seconds } : { undecodable: "the decoder wrote no audio" };
  }, { format, deadlineAt });
}

/** Every demuxer the sniffer can name: each reads local bytes only and names
 *  no further input. A decode under the sniffed one that fails is tried once
 *  under each of the others (DECODE_FALLBACKS), never under autodetection. */
export const AUDIO_DEMUXERS = Object.freeze(["mp3", "aac", "mov", "matroska", "ogg", "flac", "wav", "asf", "amr", "caf", "aiff", "avi"]);

// One ffmpeg run over a buffer's first audio stream, in the measurement pool:
// staged to a temp file, read through mediaInputArgs (named demuxer, audio
// decoders only), bounded by the decode deadline (MEASURE_MIN_DECODE_MS, or up
// to `deadlineAt` within MEASURE_MAX_DECODE_MS). `outArgs(dir)` is the output
// side; `done(seconds)` turns the length the run read into the answer: the
// last out_time it reported, or (`counter`) the bytes of its one-byte-per-
// sample stdout at COUNTER_RATE. When the demuxer the sniffer named (or the
// caller's `format`) cannot decode the file, or the sniffer named none, the
// run is tried once under each other demuxer of AUDIO_DEMUXERS, inside the same
// slot and the same overall deadline, before the file is called undecodable;
// the answer's `format` names the demuxer that read it.
async function decodeInMeasurePool(buffer, prefix, outArgs, done, { format = null, counter = false, deadlineAt = null } = {}) {
  const first = format || inputFormatOf(buffer);
  const order = [...(first ? [first] : []), ...AUDIO_DEMUXERS.filter((f) => f !== first)];
  const budgeted = Number.isFinite(deadlineAt);
  // A budgeted caller waits while its deadline still leaves a whole minimum decode.
  const waitMs = budgeted ? deadlineAt - Date.now() - MEASURE_MIN_DECODE_MS : MEASURE_WAIT_MS;
  if (!(await measureAcquire(waitMs))) return { unavailable: budgeted ? "no decoder slot came free in the time this call has left" : "no decoder slot came free in time", busy: true };
  const decodeMs = budgeted ? Math.max(MEASURE_MIN_DECODE_MS, Math.min(MEASURE_MAX_DECODE_MS, deadlineAt - Date.now())) : MEASURE_MIN_DECODE_MS;
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), prefix));
    const inPath = join(dir, "in");
    await writeFile(inPath, buffer);
    const deadline = Date.now() + decodeMs;
    let failure = { undecodable: first ? "the decoder could not read its audio" : "its container is not one the decoder here reads" };
    for (const fmt of order) {
      const left = deadline - Date.now();
      if (left <= 0) return fmt === order[0] ? { unavailable: "the decode outlasted its deadline" } : failure;
      const input = mediaInputArgs(buffer, inPath, fmt);
      const ran = await new Promise((resolve) => {
        execImpl("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", ...(counter ? [] : ["-progress", "pipe:1"]), "-nostats", ...input, "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1", ...outArgs(dir)],
          { timeout: Math.min(decodeMs, left), maxBuffer: 8 * 1024 * 1024, env: childEnv(), ...(counter ? { encoding: "buffer" } : {}) },
          (err, out) => resolve(err ? { err } : { stdout: out }));
      });
      if (ran.err) {
        if (ran.err.code === "ENOENT") return { unavailable: "ffmpeg is not installed on this server" };
        // The sniffed demuxer outlasting its deadline is ours (a retry may
        // finish); another demuxer doing so says nothing more about the file.
        if (ran.err.killed || ran.err.signal) return fmt === order[0] && first ? { unavailable: "the decode outlasted its deadline" } : failure;
        if (fmt === first) failure = { undecodable: "the decoder could not read its audio" };
        continue;
      }
      let seconds = null;
      if (counter) {
        const n = Buffer.isBuffer(ran.stdout) ? ran.stdout.length : Buffer.byteLength(String(ran.stdout ?? ""), "latin1");
        seconds = n > 0 ? n / COUNTER_RATE : null;
      } else {
        // The progress stream repeats out_time_us; the last one is the total.
        for (const line of String(ran.stdout ?? "").split("\n")) {
          if (line.startsWith("out_time_us=")) { const n = Number(line.slice(12)); if (Number.isFinite(n) && n >= 0) seconds = n / 1e6; }
        }
      }
      if (seconds === null) {
        if (fmt === first) failure = { undecodable: "the decoder reported no length for its audio" };
        continue;
      }
      // A demuxer other than the sniffed one counts only when it read audio.
      if (fmt !== first && !(seconds > 0)) continue;
      const answer = await done(seconds);
      return answer && typeof answer === "object" && !answer.undecodable ? { ...answer, format: fmt } : answer;
    }
    return failure;
  } catch {
    return { unavailable: "the file could not be staged for the decoder" };
  } finally {
    measureRelease();
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Fetch and pre-screen: ffprobe is happy to chew on anything, but if the URL
// obviously points to a webpage / JSON / a script (a common caller mistake —
// pasting an article URL instead of a direct media file URL), fail fast with a
// message that names the actual problem. Saves ~1s of ffprobe and a worker
// slot, and turns a generic "media could not be processed" into a specific
// "you passed a webpage URL." Status 422 → counts as client_errored on the
// dashboard, which is the honest attribution.
const NON_MEDIA_CT = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|x-javascript|ld\+json))/i;
/** Does the body START like a media container? Magic bytes for the formats
 *  ffmpeg is asked to read here: Ogg, MP3 (ID3 or a frame sync), FLAC, WAV/AVI
 *  (RIFF), MP4/M4A/MOV (ftyp at offset 4), WebM/MKV (EBML), AIFF (FORM), AAC
 *  ADTS, Opus-in-Ogg is Ogg. Exported for the test. A host that answers a
 *  media URL with an HTML block page and HTTP 200 (Wikimedia does this to
 *  GitHub runners) used to reach ffmpeg and be reported as "media could not
 *  be processed (is the input a valid audio/video file?)" - blaming the
 *  buyer's file for the source's refusal (corpus nightly, 2026-09-06). */
export function looksLikeMedia(buffer) {
  if (!buffer || buffer.length < 12) return false;
  const b = buffer;
  const s4 = b.subarray(0, 4).toString("latin1");
  if (s4 === "OggS" || s4 === "fLaC" || s4 === "RIFF" || s4 === "FORM") return true;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return true; // ID3
  if (b[0] === 0xff && (b[1] & 0xe6) === 0xe2) return true; // MPEG audio frame sync (MP3/AAC ADTS)
  if (b.subarray(4, 8).toString("latin1") === "ftyp") return true; // MP4 family
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true; // EBML (WebM/MKV)
  return false;
}
const fetchMedia = async (url) => {
  const { buffer, contentType } = await safeFetch(url, { binary: true, maxBytes: MAX_MEDIA_BYTES });
  if (contentType && NON_MEDIA_CT.test(contentType)) {
    throw bad(
      `Source URL returned Content-Type "${contentType.split(";")[0]}", not audio/video - did you pass a webpage URL instead of a direct media file URL?`,
      422
    );
  }
  if (!looksLikeMedia(buffer)) {
    const head = buffer.subarray(0, 16).toString("latin1").replace(/[^\x20-\x7e]/g, ".");
    // The source answered, but not with a media file: an HTML block page, an
    // error page with a media Content-Type, a truncated body. That is the
    // SOURCE's doing, so it is a 502 (never charged), and the message names
    // what came back instead of asking whether the buyer's file is valid.
    throw bad(`Source URL did not serve a media file (HTTP 200, ${buffer.length} bytes starting "${head}") - the host may be refusing this fetch or serving a webpage; try a direct file URL`, 502);
  }
  return buffer;
};

// ---- catalog tools ---------------------------------------------------------
export const MEDIA_TOOLS = [
  {
    route: "POST /api/media-info", name: "Media info (ffprobe)", slug: "media-info", category: "web", price: "$0.005",
    description:
      "Inspect any audio/video URL with ffprobe: container, duration, bitrate, and per-stream codec details (sample rate/channels for audio, resolution/fps for video) as JSON. Only audio is decoded: a video, image or subtitle stream is read from the container headers and carries decoded: false, with null for a resolution only its decoder would know. Body: {\"url\":\"https://…/file.mp4\"}.",
    tags: ["ffmpeg", "ffprobe", "audio", "video", "metadata"],
    discovery: {
      bodyType: "json",
      input: { url: "https://agent402.tools/fixtures/sample-audio.wav" },
      inputSchema: { properties: { url: { type: "string", description: "Public URL of the media file (max 30MB)" } }, required: ["url"] },
      output: { example: { formatName: "wav", durationSec: 2, bitrate: 128312, bytes: 32078, streams: [{ type: "audio", codec: "pcm_s16le", sampleRate: 8000, channels: 1 }] } },
    },
    handler: async (i) => probeMedia(await fetchMedia(need(i, "url"))),
  },
  {
    route: "POST /api/audio-convert", name: "Audio convert (to MP3)", slug: "audio-convert", category: "web", price: "$0.02",
    description:
      "Extract/convert the audio track of any media URL (mp4, mov, wav, m4a, ogg…) to MP3 - the \"mp4 to mp3\" conversion, deterministic ffmpeg, no AI. Body: {\"url\":\"https://…/video.mp4\",\"bitrate\":\"192k\"?}. Returns the MP3 as base64.",
    tags: ["ffmpeg", "mp4-to-mp3", "audio", "convert", "mp3"],
    discovery: {
      bodyType: "json",
      input: { url: "https://agent402.tools/fixtures/sample-audio.wav" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "Public URL of the media file (max 30MB)" },
          bitrate: { type: "string", description: 'MP3 bitrate, e.g. "128k", "192k" (default), "320k"' },
        },
        required: ["url"],
      },
      output: { example: { format: "mp3", bitrate: "192k", bytes: 18765, mp3Base64: "SUQzBAAAAA…" } },
    },
    handler: async (i) => toMp3(await fetchMedia(need(i, "url")), { bitrate: i.bitrate ?? "192k" }),
  },
  {
    route: "POST /api/audio-normalize", name: "Audio normalize (EBU R128)", slug: "audio-normalize", category: "web", price: "$0.02",
    description:
      "Loudness-normalize any audio/video URL to a target LUFS with ffmpeg's loudnorm (EBU R128) and return MP3 - consistent levels for podcasts, clips, and TTS output. Body: {\"url\":\"https://…/audio.wav\",\"targetLufs\":-16?}.",
    tags: ["ffmpeg", "normalize", "loudnorm", "audio", "lufs"],
    discovery: {
      bodyType: "json",
      input: { url: "https://agent402.tools/fixtures/sample-audio.wav" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "Public URL of the media file (max 30MB)" },
          targetLufs: { type: "number", description: "Integrated loudness target, -36 to -8 (default -16)" },
        },
        required: ["url"],
      },
      output: { example: { format: "mp3", targetLufs: -16, truePeakDb: -1.5, bytes: 49581, mp3Base64: "SUQzBAAAAA…" } },
    },
    handler: async (i) => normalizeAudio(await fetchMedia(need(i, "url")), { targetLufs: i.targetLufs ?? -16 }),
  },
];
