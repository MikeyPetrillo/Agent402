// Speech-to-text kit — two tiers of x402-paywalled transcription via OpenAI.
// Accepts an audio URL, fetches it, sends to OpenAI, returns transcript.
// Env-gated: missing OPENAI_API_KEY → 503.
//
// Tiers:
//   transcribe      $0.03  — gpt-4o-mini-transcribe  (5 min max)
//   transcribe-pro  $0.10  — gpt-4o-transcribe        (10 min max)

const OPENAI_KEY = () => (process.env.OPENAI_API_KEY || "").trim();

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Max audio file size in bytes (25 MB — OpenAI's limit).
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const TIERS = {
  transcribe:       { model: "gpt-4o-mini-transcribe", maxMinutes: 5 },
  "transcribe-pro": { model: "gpt-4o-transcribe",      maxMinutes: 10 },
};

function validateInput(input) {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!url) throw bad('"url" is required — a URL pointing to an audio file (mp3, wav, m4a, etc.)');
  if (!/^https?:\/\//i.test(url)) throw bad('"url" must be an HTTP(S) URL');

  const language = typeof input.language === "string" ? input.language.trim().toLowerCase() : undefined;
  return { url, language };
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
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw bad(`Failed to fetch audio: ${e.message}`, 422);
  }
  if (!res.ok) throw bad(`Audio URL returned HTTP ${res.status}`, 422);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw bad("Audio URL returned empty response", 422);
  if (buf.length > MAX_AUDIO_BYTES) {
    throw bad(`Audio file too large (${(buf.length / 1024 / 1024).toFixed(1)} MB). Maximum is 25 MB`);
  }

  const filename = guessFilename(url, res.headers.get("content-type"));
  return { buf, filename };
}

async function callOpenAI(audioBuffer, filename, model, language) {
  const key = OPENAI_KEY();
  if (!key) throw bad("OpenAI not configured", 503);

  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), filename);
  form.append("model", model);
  form.append("response_format", "verbose_json");
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
    if (res.status === 429) throw bad("OpenAI rate-limited — retry shortly", 503);
    if (res.status >= 500) throw bad(`OpenAI upstream error (HTTP ${res.status})`, 502);
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).error?.message || msg; } catch {}
    throw bad(`OpenAI error: ${msg}`, 502);
  }

  let data;
  try { data = JSON.parse(text); } catch { throw bad("OpenAI returned non-JSON", 502); }

  return {
    model,
    provider: "openai",
    text: data.text ?? "",
    language: data.language ?? null,
    duration: data.duration ?? null,
  };
}

function makeHandler(tierSlug) {
  return async (input) => {
    const { url, language } = validateInput(input);
    const { buf, filename } = await fetchAudio(url);
    const tier = TIERS[tierSlug];
    return callOpenAI(buf, filename, tier.model, language);
  };
}

const SHARED_TAGS = ["stt", "speech-to-text", "transcription", "audio", "whisper", "openai"];

export const STT_TOOLS = [
  {
    route: "POST /api/transcribe",
    name: "Speech-to-text",
    slug: "transcribe",
    category: "ai",
    price: "$0.030",
    description:
      "Transcribe audio to text using OpenAI (gpt-4o-mini-transcribe). Provide a URL to an audio file (mp3, wav, m4a, etc.) and get back the transcript. No API key needed; pay per call via x402. Max 5 minutes of audio, 25 MB file size.",
    tags: [...SHARED_TAGS, "gpt-4o-mini-transcribe"],
    discovery: {
      bodyType: "json",
      input: { url: "https://example.com/audio.mp3" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "URL of the audio file to transcribe (mp3, wav, m4a, ogg, flac, webm)" },
          language: { type: "string", description: "Optional ISO-639-1 language code (e.g. 'en', 'es', 'fr') for better accuracy" },
        },
        required: ["url"],
      },
      output: {
        example: {
          model: "gpt-4o-mini-transcribe",
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
      "Transcribe audio to text using OpenAI (gpt-4o-transcribe). Higher accuracy than the standard tier. Provide a URL to an audio file and get back the transcript. No API key needed; pay per call via x402. Max 10 minutes of audio, 25 MB file size.",
    tags: [...SHARED_TAGS, "gpt-4o-transcribe", "pro"],
    discovery: {
      bodyType: "json",
      input: { url: "https://example.com/audio.mp3" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "URL of the audio file to transcribe (mp3, wav, m4a, ogg, flac, webm)" },
          language: { type: "string", description: "Optional ISO-639-1 language code (e.g. 'en', 'es', 'fr') for better accuracy" },
        },
        required: ["url"],
      },
      output: {
        example: {
          model: "gpt-4o-transcribe",
          provider: "openai",
          text: "Hello, this is a sample transcription.",
          language: "en",
          duration: 3.5,
        },
      },
    },
    handler: makeHandler("transcribe-pro"),
  },
];
