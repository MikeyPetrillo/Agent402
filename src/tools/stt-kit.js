// Speech-to-text kit — two tiers of x402-paywalled transcription via OpenAI.
// Accepts an audio URL, fetches it, sends to OpenAI, returns transcript.
// Env-gated: missing OPENAI_API_KEY → 503.
//
// Tiers:
//   transcribe      $0.03  - gpt-transcribe  (4 min max)
//   transcribe-pro  $0.10  - gpt-transcribe  (10 min max)
//
// The per-tier duration cap is a MARGIN bound, not just a UX limit: OpenAI
// bills per audio minute, so an unchecked 25 MB file (~26 min at 128 kbps
// mp3) would cost more upstream than the tool charges. Duration is probed
// locally (header parse, no upstream call) and enforced BEFORE the file is
// sent to OpenAI. The cap is sized so worst case stays under STT_MARGIN of
// the price. Pinned in scripts/test-stt-cap.js.
//
// transcribe-pro moved gpt-4o-transcribe -> gpt-transcribe 2026-08-04
// (OpenAI's 2026-07-28 release and the recommended replacement).
// transcribe moved gpt-4o-mini-transcribe -> gpt-transcribe 2026-09-18: OpenAI
// shuts down gpt-4o-mini-transcribe, gpt-4o-transcribe and whisper-1 on
// 2027-02-26 and names gpt-transcribe the successor. The two tiers now run
// the SAME model and differ only in the duration cap (and price); the pro
// tier is the longer-recording tier, not a higher-accuracy one.
//
// SPEAKERS AND WORD TIMES (2026-10-07): `diarize: true` sends the audio to
// ElevenLabs Scribe v2 over OpenRouter instead and adds `words` (each with
// start, end and a speaker number) and `speakers` to the answer. Same caps and
// prices; its per-minute rate row is pinned by the same margin test.

import { parseMultipartFile } from "../multipart.js";
import { parseBuffer } from "music-metadata";
import { safeFetch } from "./fetch-guard.js";
import { redactSecrets } from "./redact.js";
import { upstreamCosts } from "../upstream-costs.js";
import { OPENROUTER_ATTRIBUTION } from "../openrouter-attribution.js";
import { assertUpstreamBody } from "./llm-gateway-kit.js";

const OPENAI_KEY = () => (process.env.OPENAI_API_KEY || "").trim();
const OPENROUTER_KEY = () => (process.env.OPENROUTER_API_KEY || "").trim();
const OPENROUTER_STT_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
export const DIARIZE_MODEL = "elevenlabs/scribe-v2";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Max audio file size in bytes (25 MB — OpenAI's limit).
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Per-audio-minute upstream rate for the model each tier sends, from the
 *  private table (src/upstream-costs.js, never committed). The margin test
 *  derives the cap bound from it: maxMinutes x rate <= STT_MARGIN x price. A
 *  model missing there fails that test rather than being assumed free. */
export function upstreamUsdPerMinute(model) { return upstreamCosts().sttPerMinute[model] ?? null; }
/** Worst-case upstream spend may not exceed this share of the tier price - the
 *  same bound the LLM gateway's margin clamp holds. */
export const STT_MARGIN = 0.7;
export const STT_TIERS = Object.freeze({
  transcribe:       Object.freeze({ model: "gpt-transcribe", diarizeModel: DIARIZE_MODEL, maxMinutes: 4, priceUsd: 0.03 }),
  "transcribe-pro": Object.freeze({ model: "gpt-transcribe", diarizeModel: DIARIZE_MODEL, maxMinutes: 10, priceUsd: 0.10 }),
});
const TIERS = STT_TIERS;

function validateInput(input) {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!url) throw bad('"url" is required - a URL pointing to an audio file (mp3, wav, m4a, etc.)');
  if (!/^https?:\/\//i.test(url)) throw bad('"url" must be an HTTP(S) URL');

  const language = typeof input.language === "string" ? input.language.trim().toLowerCase() : undefined;
  return { url, language, diarize: diarizeFlag(input.diarize) };
}

/** `diarize` as JSON true or the multipart string "true". Anything else that
 *  is set is a 400, so a typo never silently drops the speaker labels. */
function diarizeFlag(v) {
  if (v === undefined || v === null || v === "" || v === false || v === "false") return false;
  if (v === true || v === "true") return true;
  throw bad('"diarize" must be true or false');
}

function guessFilename(url, contentType) {
  // Try to get extension from URL path
  const path = new URL(url).pathname;
  const ext = path.split(".").pop()?.toLowerCase();
  const audioExts = new Set(["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"]);
  if (ext && audioExts.has(ext)) return `audio.${ext}`;

  // Fall back to content-type
  const ct = (contentType || "").split(";")[0].trim();
  const ctMap = {
    "audio/mpeg": "audio.mp3", "audio/mp3": "audio.mp3",
    "audio/mp4": "audio.mp4", "audio/m4a": "audio.m4a",
    "audio/wav": "audio.wav", "audio/x-wav": "audio.wav",
    "audio/ogg": "audio.ogg", "audio/flac": "audio.flac",
    "audio/webm": "audio.webm",
  };
  return ctMap[ct] || "audio.mp3";
}

async function fetchAudio(url) {
  const { buffer: buf, contentType } = await safeFetch(url, { binary: true, maxBytes: MAX_AUDIO_BYTES });
  if (buf.length === 0) throw bad("Audio URL returned empty response", 422);

  const filename = guessFilename(url, contentType);
  return { buf, filename };
}

/** Audio duration in seconds from the container headers, or null when it
 *  cannot be determined. Pure local parse — no upstream call, no cost. */
export async function probeDurationSeconds(buf, filename) {
  try {
    const meta = await parseBuffer(buf, { path: filename }, { duration: true });
    const d = meta?.format?.duration;
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/** Throws 422 when the audio exceeds the tier's advertised duration cap, or
 *  when the duration cannot be read at all (an unreadable container would
 *  otherwise be an unbounded upstream bill). Small tolerance for container
 *  rounding. Exported for tests. */
export async function assertWithinDurationCap(buf, filename, tierSlug) {
  const tier = TIERS[tierSlug];
  const durationSec = await probeDurationSeconds(buf, filename);
  if (durationSec === null) {
    throw bad("Could not read the audio duration from the file - send a standard mp3, wav, m4a, ogg, flac, or webm file", 422);
  }
  const capSec = tier.maxMinutes * 60;
  if (durationSec > capSec + 2) {
    const mins = (durationSec / 60).toFixed(1);
    const upsell = tierSlug === "transcribe" ? " For up to 10 minutes, use /api/transcribe-pro." : "";
    throw bad(`Audio is ${mins} minutes - this tier accepts up to ${tier.maxMinutes} minutes.${upsell} Split longer recordings into chunks.`, 422);
  }
  return durationSec;
}

async function callOpenAI(audioBuffer, filename, model, language, probedDuration = null) {
  const key = OPENAI_KEY();
  if (!key) throw bad("OpenAI not configured", 503);

  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), filename);
  form.append("model", model);
  form.append("response_format", "json");
  if (language) form.append("language", language);

  let res;
  try {
    res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw bad(`OpenAI request failed: ${e.message}`, 504);
  }

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw bad("OpenAI upstream auth failed", 502);
    if (res.status === 429) throw bad("OpenAI rate-limited - retry shortly", 503);
    if (res.status >= 500) throw bad(`OpenAI upstream error (HTTP ${res.status})`, 502);
    // Redact the FULL body BEFORE slicing/parsing (a secret straddling the
    // 200-char cut leaves an unredactable prefix); the route binder returns
    // err.message verbatim to buyers and logs it.
    const safe = redactSecrets(text);
    let msg = safe.slice(0, 200);
    try { msg = JSON.parse(safe).error?.message || msg; } catch {}
    // Reaching here means a remaining 4xx - the REQUEST was invalid (bad
    // temperature, unknown language code, oversized input), not the upstream.
    // Surfacing it as 502 taught buyers to retry the identical bad request
    // (observed 2026-07-26: paired retries ~1s apart on temperature:100) and
    // polluted upstream-failure telemetry. A self-explaining 400 teaches the
    // agent to fix the request; settlement is cancelled either way.
    throw bad(`OpenAI rejected the request: ${msg}`, 400);
  }

  let data;
  try { data = JSON.parse(text); } catch { throw bad("OpenAI returned non-JSON", 502); }
  if (typeof data?.text !== "string") throw bad("OpenAI returned no transcript - retry", 502);

  return {
    model,
    provider: "openai",
    text: data.text ?? "",
    language: data.language ?? null,
    // OpenAI's json response carries no duration; we measured it locally for
    // the cap, so the promised field is populated (corpus, 2026-09-06).
    duration: data.duration ?? (Number.isFinite(probedDuration) ? Math.round(probedDuration * 100) / 100 : null),
  };
}

/** ElevenLabs Scribe v2 over OpenRouter, asked for speaker labels and word
 *  timestamps. Same answer fields as the default path plus `words` and
 *  `speakers`; a failure is a 4xx/5xx that cancels settlement, never a quiet
 *  fall back to a transcript without the speakers the buyer asked for. */
async function callScribe(audioBuffer, filename, model, language, probedDuration = null) {
  const key = OPENROUTER_KEY();
  if (!key) throw bad("Speech gateway not configured (OPENROUTER_API_KEY unset)", 503);
  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), filename);
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("diarize", "true");
  form.append("timestamp_granularities[]", "word");
  if (language) form.append("language", language);
  let res;
  try {
    res = await fetch(OPENROUTER_STT_URL, { method: "POST", headers: { Authorization: `Bearer ${key}`, ...OPENROUTER_ATTRIBUTION }, body: form, signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw bad(`Transcription upstream request failed: ${String(e?.message || e).slice(0, 120)}`, 504);
  }
  const text = await res.text();
  if (!res.ok) {
    const safe = redactSecrets(text);
    let msg = safe.slice(0, 200);
    try { msg = JSON.parse(safe).error?.message || msg; } catch {}
    if (res.status === 429) throw bad("Transcription upstream rate-limited - retry shortly", 503);
    if (res.status === 402) throw bad("Transcription gateway temporarily unavailable - retry shortly", 503);
    if (res.status >= 500 || res.status === 401 || res.status === 403) throw bad(`Transcription upstream error (HTTP ${res.status})`, 502);
    throw bad(`Transcription upstream rejected the request: ${msg}`, 400);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw bad("Transcription upstream returned non-JSON", 502); }
  assertUpstreamBody(data);
  // Silent audio is an empty transcript; a body with no transcript field is not an answer.
  if (typeof data.text !== "string") throw bad("Transcription upstream returned no transcript - retry", 502);
  const words = (Array.isArray(data.words) ? data.words : []).map((w) => ({
    word: String(w.word ?? ""),
    start: Number.isFinite(w.start) ? w.start : null,
    end: Number.isFinite(w.end) ? w.end : null,
    speaker: Number.isInteger(w.speaker) ? w.speaker : null,
  }));
  const speakers = new Set(words.map((w) => w.speaker).filter((n) => n !== null)).size;
  return {
    model,
    provider: "openrouter",
    text: data.text ?? "",
    language: data.language ?? null,
    duration: Number.isFinite(data.duration) ? data.duration : (Number.isFinite(probedDuration) ? Math.round(probedDuration * 100) / 100 : null),
    speakers,
    words,
  };
}

function transcribeBuffer(buf, filename, tierSlug, language, diarize, probedDuration) {
  const tier = TIERS[tierSlug];
  return diarize
    ? callScribe(buf, filename, tier.diarizeModel, language, probedDuration)
    : callOpenAI(buf, filename, tier.model, language, probedDuration);
}

function makeHandler(tierSlug) {
  return async (input) => {
    const { url, language, diarize } = validateInput(input);
    const { buf, filename } = await fetchAudio(url);
    const probedDuration = await assertWithinDurationCap(buf, filename, tierSlug); // measured for the margin cap; also the answer's duration
    return transcribeBuffer(buf, filename, tierSlug, language, diarize, probedDuration);
  };
}

/** OpenAI's own transcription wire: multipart/form-data with `file`.
 *
 *  We served /v1/audio/speech, /v1/rerank and /v1/embeddings on OpenAI's paths
 *  while /v1/audio/transcriptions answered 404, so an SDK pointed at this
 *  gateway spoke to three routes and then looked broken on the fourth - the
 *  same "the handler is here, the URL is not" defect the Gemini wire fixed.
 *
 *  It joins the existing handler ONE LAYER IN, at the bytes: everything that
 *  bounds this tool (the duration cap that holds the margin, the model lock,
 *  the upstream call) is downstream of `buf` and is reached unchanged. The
 *  only difference is where the bytes came from - an upload instead of a
 *  fetch - so an uploaded file skips the SSRF-guarded fetch entirely.
 */
export function makeMultipartHandler(tierSlug) {
  return async (_input, req) => {
    const ct = req?.headers?.["content-type"] || "";
    const body = req?.body;
    if (!/^multipart\/form-data/i.test(String(ct)) || !Buffer.isBuffer(body)) {
      throw bad(`This route takes OpenAI's transcription wire: multipart/form-data with a "file" part (and an optional "language"). To transcribe a URL instead, POST JSON {"url":"..."} to ${tierSlug === "transcribe-pro" ? "/api/transcribe-pro" : "/api/transcribe"}.`);
    }
    const { fields, file } = parseMultipartFile(body, ct);
    if (!file) throw bad('multipart body has no "file" part');
    const language = typeof fields.language === "string" && fields.language ? fields.language : undefined;
    const diarize = diarizeFlag(fields.diarize);
    const probedDuration = await assertWithinDurationCap(file.buf, file.filename, tierSlug);
    return transcribeBuffer(file.buf, file.filename, tierSlug, language, diarize, probedDuration);
  };
}

const SHARED_TAGS = ["stt", "speech-to-text", "transcription", "audio", "whisper", "openai"];

export const STT_TOOLS = [
  {
    route: "POST /api/transcribe",
    name: "Speech-to-text",
    slug: "transcribe", aliases: ["speech-to-text", "stt", "transcription"],
    category: "ai",
    price: "$0.030",
    description:
      "Transcribe audio to text using OpenAI (gpt-transcribe). Provide a URL to an audio file (mp3, wav, m4a, etc.) and get back the transcript. Add diarize:true for speaker labels and word timestamps (ElevenLabs Scribe v2, same price). No API key needed; pay per call via x402. Max 4 minutes of audio, 25 MB file size; /api/transcribe-pro takes the same models to 10 minutes.",
    tags: [...SHARED_TAGS, "gpt-transcribe"],
    discovery: {
      bodyType: "json",
      input: { url: "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "URL of the audio file to transcribe (mp3, wav, m4a, ogg, flac, webm)" },
          language: { type: "string", description: "Optional ISO-639-1 language code (e.g. 'en', 'es', 'fr') for better accuracy" },
          diarize: { type: "boolean", description: "true: transcribe with ElevenLabs Scribe v2 and add speaker labels and word timestamps (`words`, `speakers`). Same price and cap. Default false" },
        },
        required: ["url"],
      },
      output: {
        example: {
          model: "gpt-transcribe",
          provider: "openai",
          text: "Hello, this is a sample transcription.",
          language: "en",
          duration: 3.5,
        },
      },
    },
    handler: makeHandler("transcribe"),
  },
  {
    route: "POST /api/transcribe-pro",
    name: "Speech-to-text (Pro)",
    slug: "transcribe-pro",
    category: "ai",
    price: "$0.100",
    description:
      "Transcribe audio to text using OpenAI (gpt-transcribe) - the same model as /api/transcribe with a longer cap. Provide a URL to an audio file and get back the transcript; add diarize:true for speaker labels and word timestamps (ElevenLabs Scribe v2). No API key needed; pay per call via x402. Max 10 minutes of audio, 25 MB file size.",
    tags: [...SHARED_TAGS, "gpt-transcribe", "pro"],
    discovery: {
      bodyType: "json",
      input: { url: "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "URL of the audio file to transcribe (mp3, wav, m4a, ogg, flac, webm)" },
          language: { type: "string", description: "Optional ISO-639-1 language code (e.g. 'en', 'es', 'fr') for better accuracy" },
          diarize: { type: "boolean", description: "true: transcribe with ElevenLabs Scribe v2 and add speaker labels and word timestamps (`words`, `speakers`). Same price and cap. Default false" },
        },
        required: ["url"],
      },
      output: {
        example: {
          model: "gpt-transcribe",
          provider: "openai",
          text: "Hello, this is a sample transcription.",
          language: "en",
          duration: 3.5,
        },
      },
    },
    handler: makeHandler("transcribe-pro"),
  },
  {
    route: "POST /v1/audio/transcriptions",
    name: "Speech-to-text (OpenAI transcription wire)",
    slug: "v1-audio-transcriptions",
    category: "ai",
    price: "$0.030",
    description:
      "OpenAI's own transcription wire: POST multipart/form-data with a `file` part and get the transcript back. Point any Whisper-shaped SDK at this gateway and pay per call with USDC, no account and no API key. Same model and same four-minute cap as /api/transcribe, which takes a URL instead of an upload; /v1/pro/audio/transcriptions takes it to ten minutes.",
    tags: [...SHARED_TAGS],
    discovery: {
      bodyType: "form-data",
      input: { file: "<audio bytes, multipart part named file>", language: "en" },
      inputSchema: { type: "object", required: ["file"], properties: { file: { type: "string", description: "The audio file, as a multipart part named `file`" }, language: { type: "string", description: "Optional ISO-639-1 hint" }, diarize: { type: "string", description: "\"true\" for speaker labels and word timestamps (ElevenLabs Scribe v2)" } } },
      output: { example: { text: "Example transcript.", duration: 3.2, model: "gpt-transcribe" } },
    },
    handler: makeMultipartHandler("transcribe"),
  },
  {
    route: "POST /v1/pro/audio/transcriptions",
    name: "Speech-to-text, long audio (OpenAI transcription wire)",
    slug: "v1-audio-transcriptions-pro",
    category: "ai",
    price: "$0.100",
    description:
      "OpenAI's transcription wire on the ten-minute tier: POST multipart/form-data with a `file` part. Same model as /v1/audio/transcriptions with a longer cap, for a recording a four-minute route refuses.",
    tags: [...SHARED_TAGS],
    discovery: {
      bodyType: "form-data",
      input: { file: "<audio bytes, multipart part named file>" },
      inputSchema: { type: "object", required: ["file"], properties: { file: { type: "string", description: "The audio file, as a multipart part named `file`" }, language: { type: "string", description: "Optional ISO-639-1 hint" }, diarize: { type: "string", description: "\"true\" for speaker labels and word timestamps (ElevenLabs Scribe v2)" } } },
      output: { example: { text: "Example transcript.", duration: 420.5, model: "gpt-transcribe" } },
    },
    handler: makeMultipartHandler("transcribe-pro"),
  },
];
