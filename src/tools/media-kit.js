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
import { tmpdir } from "node:os";
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
 *  list, which are formats that name further inputs. */
export function inputFormatOf(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const b = buffer;
  const s4 = b.subarray(0, 4).toString("latin1");
  if (s4 === "OggS") return "ogg";
  if (s4 === "fLaC") return "flac";
  if (s4 === "RIFF") { const k = b.subarray(8, 12).toString("latin1"); return k === "WAVE" ? "wav" : k === "AVI " ? "avi" : null; }
  if (s4 === "FORM") { const k = b.subarray(8, 12).toString("latin1"); return k === "AIFF" || k === "AIFC" ? "aiff" : null; }
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return "mp3";
  if (b[0] === 0xff && (b[1] & 0xe6) === 0xe2) return "mp3";
  if (b.subarray(4, 8).toString("latin1") === "ftyp") return "mov";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "matroska";
  return null;
}

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
  "pcm_s16le", "pcm_s16be", "pcm_s24le", "pcm_s24be", "pcm_s32le", "pcm_s32be",
  "pcm_f32le", "pcm_f32be", "pcm_f64le", "pcm_f64be", "pcm_u8", "pcm_s8", "pcm_alaw", "pcm_mulaw",
].join(",");
const AUDIO_DECODER_SET = new Set(AUDIO_DECODERS.split(","));

/** Input arguments for a downloaded file: local file reads only, the
 *  demuxer named explicitly, audio decoders only. An unrecognized body is
 *  refused before ffmpeg runs. */
export function mediaInputArgs(buffer, inPath) {
  const fmt = inputFormatOf(buffer);
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
// free slot in time, the deadline, a temp-file error).
const MEASURE_MAX_CONCURRENT = 2;
const MEASURE_TIMEOUT_MS = 10_000;
const MEASURE_WAIT_MS = 5_000;
let measureActive = 0;
const measureWaiters = [];
// Resolves true with a slot held, or false when none came free in time.
const measureAcquire = () => {
  if (measureActive < MEASURE_MAX_CONCURRENT) { measureActive++; return Promise.resolve(true); }
  return new Promise((resolve) => {
    const waiter = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { const i = measureWaiters.indexOf(waiter); if (i !== -1) measureWaiters.splice(i, 1); resolve(false); }, MEASURE_WAIT_MS);
    timer.unref?.();
    measureWaiters.push(waiter);
  });
};
const measureRelease = () => { const next = measureWaiters.shift(); if (next) next(); else measureActive--; };
export async function measureAudioSeconds(buffer) {
  const m = await measureAudio(buffer);
  return Number.isFinite(m.seconds) ? m.seconds : null;
}
export async function measureAudio(buffer) {
  let input;
  try { input = mediaInputArgs(buffer, "in"); } catch { return { undecodable: "its container is not one the decoder here reads" }; }
  if (!(await measureAcquire())) return { unavailable: "no decoder slot came free in time" };
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "a402-measure-"));
    const inPath = join(dir, "in");
    input[input.length - 1] = inPath;
    await writeFile(inPath, buffer);
    const ran = await new Promise((resolve) => {
      execImpl("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-progress", "pipe:1", "-nostats", ...input, "-map", "0:a:0", "-vn", "-f", "null", "-"],
        { timeout: MEASURE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: childEnv() },
        (err, out) => resolve(err ? { err } : { stdout: String(out ?? "") }));
    });
    if (ran.err) {
      if (ran.err.code === "ENOENT") return { unavailable: "ffmpeg is not installed on this server" };
      if (ran.err.killed || ran.err.signal) return { unavailable: "the decode outlasted its deadline" };
      return { undecodable: "the decoder could not read its audio" };
    }
    const stdout = ran.stdout;
    // The progress stream repeats out_time_us; the last one is the total.
    let us = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("out_time_us=")) { const n = Number(line.slice(12)); if (Number.isFinite(n) && n >= 0) us = n; }
    }
    return us === null ? { undecodable: "the decoder reported no length for its audio" } : { seconds: us / 1e6 };
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
