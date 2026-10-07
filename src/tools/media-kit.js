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

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
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
    await writeFile(inPath, buffer);
    const { stdout } = await run("ffprobe", [
      "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", inPath,
    ]);
    let data;
    try { data = JSON.parse(stdout); } catch { throw bad("ffprobe returned no metadata", 422); }
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

export async function toMp3(buffer, { bitrate = "192k" } = {}) {
  if (!/^\d{2,3}k$/.test(bitrate)) throw bad('"bitrate" must look like "128k"/"192k"/"320k"');
  return withTmp(async (dir) => {
    const inPath = join(dir, "in");
    const outPath = join(dir, "out.mp3");
    await writeFile(inPath, buffer);
    await run("ffmpeg", ["-y", "-i", inPath, "-vn", "-map_metadata", "-1", "-b:a", bitrate, outPath]);
    const out = await readFile(outPath);
    return { format: "mp3", bitrate, bytes: out.length, mp3Base64: out.toString("base64") };
  });
}

export async function normalizeAudio(buffer, { targetLufs = -16 } = {}) {
  const lufs = Number(targetLufs);
  if (!Number.isFinite(lufs) || lufs < -36 || lufs > -8) throw bad('"targetLufs" must be between -36 and -8 (default -16)');
  return withTmp(async (dir) => {
    const inPath = join(dir, "in");
    const outPath = join(dir, "out.mp3");
    await writeFile(inPath, buffer);
    // EBU R128 two-in-one: loudnorm in dynamic mode, then encode to mp3.
    await run("ffmpeg", [
      "-y", "-i", inPath, "-vn", "-map_metadata", "-1",
      "-af", `loudnorm=I=${lufs}:TP=-1.5:LRA=11`,
      "-b:a", "192k", outPath,
    ]);
    const out = await readFile(outPath);
    return { format: "mp3", targetLufs: lufs, truePeakDb: -1.5, bytes: out.length, mp3Base64: out.toString("base64") };
  });
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
      "Inspect any audio/video URL with ffprobe: container, duration, bitrate, and per-stream codec details (sample rate/channels for audio, resolution/fps for video) as JSON. Body: {\"url\":\"https://…/file.mp4\"}.",
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
