// Text-to-speech kit — two tiers of x402-paywalled TTS via OpenAI.
// Returns base64-encoded audio. Env-gated: missing OPENAI_API_KEY → 503.
//
// Tiers:
//   tts      $0.05  — tts-1       (2000 chars, fast)
//   tts-hd   $0.10  — tts-1-hd    (2000 chars, higher fidelity)

const OPENAI_KEY = () => (process.env.OPENAI_API_KEY || "").trim();

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"]);
const FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"]);

const TIERS = {
  tts:      { model: "tts-1",    maxChars: 2000 },
  "tts-hd": { model: "tts-1-hd", maxChars: 2000 },
};

function validateInput(input, tierSlug) {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw bad('"text" is required — the text to convert to speech');
  const cap = TIERS[tierSlug].maxChars;
  if (text.length > cap) {
    throw bad(`Text too long (${text.length} chars). The ${tierSlug} tier allows up to ${cap} chars`);
  }

  const voice = typeof input.voice === "string" ? input.voice.trim().toLowerCase() : "alloy";
  if (!VOICES.has(voice)) {
    throw bad(`Unknown voice "${voice}". Supported: ${[...VOICES].join(", ")}`);
  }

  const format = typeof input.format === "string" ? input.format.trim().toLowerCase() : "mp3";
  if (!FORMATS.has(format)) {
    throw bad(`Unknown format "${format}". Supported: ${[...FORMATS].join(", ")}`);
  }

  return { text, voice, format };
}

async function callOpenAI(text, voice, format, tierSlug) {
  const key = OPENAI_KEY();
  if (!key) throw bad("OpenAI not configured", 503);

  const tier = TIERS[tierSlug];
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: tier.model,
        input: text,
        voice,
        response_format: format,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw bad(`OpenAI request failed: ${e.message}`, 504);
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw bad("OpenAI upstream auth failed", 502);
    if (res.status === 429) throw bad("OpenAI rate-limited — retry shortly", 503);
    if (res.status >= 500) throw bad(`OpenAI upstream error (HTTP ${res.status})`, 502);
    const errText = await res.text().catch(() => "");
    let msg = errText.slice(0, 200);
    try { msg = JSON.parse(errText).error?.message || msg; } catch {}
    throw bad(`OpenAI error: ${msg}`, 502);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return {
    model: tier.model,
    provider: "openai",
    voice,
    format,
    audio: buf.toString("base64"),
    chars: text.length,
  };
}

function makeHandler(tierSlug) {
  return async (input) => {
    const { text, voice, format } = validateInput(input, tierSlug);
    return callOpenAI(text, voice, format, tierSlug);
  };
}

const SHARED_TAGS = ["tts", "text-to-speech", "audio", "voice", "speech", "openai"];

export const TTS_TOOLS = [
  {
    route: "POST /api/tts",
    name: "Text-to-speech",
    slug: "tts",
    category: "ai",
    price: "$0.050",
    description:
      "Convert text to speech using OpenAI TTS-1. Returns base64-encoded audio (mp3/opus/aac/flac/wav/pcm). 10 voices available. No API key needed; pay per call via x402. Text capped at 2000 chars.",
    tags: [...SHARED_TAGS, "tts-1"],
    discovery: {
      bodyType: "json",
      input: { text: "Hello from Agent402!", voice: "alloy", format: "mp3" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to convert to speech (max 2000 chars)" },
          voice: { type: "string", description: "Voice: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer (default: alloy)" },
          format: { type: "string", description: "Audio format: mp3, opus, aac, flac, wav, pcm (default: mp3)" },
        },
        required: ["text"],
      },
      output: {
        example: {
          model: "tts-1",
          provider: "openai",
          voice: "alloy",
          format: "mp3",
          audio: "<base64-encoded audio>",
          chars: 20,
        },
      },
    },
    handler: makeHandler("tts"),
  },
  {
    route: "POST /api/tts-hd",
    name: "Text-to-speech (HD)",
    slug: "tts-hd",
    category: "ai",
    price: "$0.100",
    description:
      "Convert text to speech using OpenAI TTS-1-HD (higher fidelity). Returns base64-encoded audio. Same interface as /api/tts but with better audio quality. No API key needed; pay per call via x402. Text capped at 2000 chars.",
    tags: [...SHARED_TAGS, "tts-1-hd", "hd"],
    discovery: {
      bodyType: "json",
      input: { text: "Hello from Agent402!", voice: "alloy", format: "mp3" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to convert to speech (max 2000 chars)" },
          voice: { type: "string", description: "Voice: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer (default: alloy)" },
          format: { type: "string", description: "Audio format: mp3, opus, aac, flac, wav, pcm (default: mp3)" },
        },
        required: ["text"],
      },
      output: {
        example: {
          model: "tts-1-hd",
          provider: "openai",
          voice: "alloy",
          format: "mp3",
          audio: "<base64-encoded audio>",
          chars: 20,
        },
      },
    },
    handler: makeHandler("tts-hd"),
  },
];
