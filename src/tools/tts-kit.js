// Text-to-speech kit — three tiers of x402-paywalled TTS, one interface.
// Returns base64-encoded audio.
//
// Tiers:
//   tts-lite $0.005 — Kokoro-82M via OpenRouter (800 chars)   [OPENROUTER_API_KEY]
//   tts      $0.05  — OpenAI tts-1              (2000 chars)  [OPENAI_API_KEY]
//   tts-hd   $0.10  — OpenAI tts-1-hd           (2000 chars)  [OPENAI_API_KEY]
//
// WHY A LITE TIER (2026-09-11): a cheaper MODEL - Kokoro-82M, already a
// proven link in the /v1/audio/speech failover chain (SPEECH_MODELS,
// live-verified by the TTS probe workflow) - rather than a cut on the premium
// voice. The premium tiers are untouched - a buyer who wants the OpenAI voice
// still pays for it.
//
// CAP CUT 2,000 -> 800 CHARS (2026-09-18): Kokoro gained a second, dearer
// OpenRouter endpoint, and the worst case has to be the DEAREST endpoint
// because nothing we send can keep a call off it - `provider.order`/`max_price`
// are ignored on /audio/speech. At 2,000 chars that worst case broke the
// margin bound; found by an upstream audit, not by any guard (the live model
// guard now pins speech cost rows against the dearest endpoint). The price
// stays; at 800 chars the worst case is back under the bound. Billing unit is
// the JS string length (measured: ASCII, CJK, emoji and accented text of equal
// .length each billed the same 100 "tokens" = 400 chars), so `text.length`
// counts exactly what OpenRouter bills.

import { redactSecrets } from "./redact.js";
import { SPEECH_MODELS, OPENROUTER_ATTRIBUTION } from "./llm-gateway-kit.js";

const OPENAI_KEY = () => (process.env.OPENAI_API_KEY || "").trim();
const OPENROUTER_KEY = () => (process.env.OPENROUTER_API_KEY || "").trim();
const OPENROUTER_SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";
// The same Kokoro entry the /v1 speech chain uses, so the voice map and the
// native voice set cannot drift between the two surfaces (the TTS probe
// workflow re-verifies that table against OpenRouter's live model list).
const KOKORO = SPEECH_MODELS.find((m) => m.id === "hexgrad/kokoro-82m");

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"]);
const FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"]);

const TIERS = {
  // provider "openrouter" reaches Kokoro; "openai" is the original pair.
  "tts-lite": { model: "hexgrad/kokoro-82m", provider: "openrouter", maxChars: 800 },
  tts:        { model: "tts-1",              provider: "openai",     maxChars: 2000 },
  "tts-hd":   { model: "tts-1-hd",           provider: "openai",     maxChars: 2000 },
};
// OpenRouter's speech wire serves mp3 and pcm only; the OpenAI tiers keep the
// full set. A format this tier cannot serve is a self-explaining 400, never a
// silent downgrade to mp3 (a documented default is a contract - 2026-09-06).
const LITE_FORMATS = new Set(["mp3", "pcm"]);

function validateInput(input, tierSlug) {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw bad('"text" is required - the text to convert to speech');
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
  // A format this tier's upstream cannot serve is a self-explaining 400 naming
  // the tier that can, never a silent downgrade to mp3 (a documented default is
  // a contract, 2026-09-06).
  if (TIERS[tierSlug].provider === "openrouter" && !LITE_FORMATS.has(format)) {
    throw bad(`The ${tierSlug} tier serves ${[...LITE_FORMATS].join(" and ")} only - "${format}" is available on /api/tts and /api/tts-hd`);
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
    if (res.status === 429) throw bad("OpenAI rate-limited - retry shortly", 503);
    if (res.status >= 500) throw bad(`OpenAI upstream error (HTTP ${res.status})`, 502);
    const errText = await res.text().catch(() => "");
    // Redact the FULL body BEFORE slicing/parsing (a secret straddling the
    // 200-char cut leaves an unredactable prefix); the route binder returns
    // err.message verbatim to buyers and logs it.
    const safe = redactSecrets(errText);
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

/** Kokoro over OpenRouter's OpenAI-shaped speech wire. Same request/response
 *  contract as callOpenAI, so the three tiers are one interface to a buyer.
 *  No failover: the chain belongs to /v1/audio/speech, which is what a buyer
 *  pays $0.06 for; this tier is one model at one price and says so, and an
 *  upstream failure is a 502 that cancels settlement rather than a silent
 *  walk onto a model this price does not cover. */
async function callKokoro(text, voice, format, tierSlug) {
  const key = OPENROUTER_KEY();
  if (!key) throw bad("Speech gateway not configured (OPENROUTER_API_KEY unset)", 503);
  const tier = TIERS[tierSlug];
  // OpenAI voice name -> Kokoro's own id, from the shared table.
  const nativeVoice = KOKORO?.map?.[voice] || KOKORO?.map?.alloy || "af_alloy";
  let res;
  try {
    res = await fetch(OPENROUTER_SPEECH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...OPENROUTER_ATTRIBUTION },
      body: JSON.stringify({ model: tier.model, input: text, voice: nativeVoice, response_format: format }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw bad(`Upstream request failed: ${String(e?.message || e).slice(0, 120)}`, 504);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const safe = redactSecrets(errText);
    let msg = safe.slice(0, 200);
    try { msg = JSON.parse(safe).error?.message || msg; } catch {}
    // 5xx and 429 are the provider's; anything else is this request being
    // wrong, and a 400 teaches the agent to fix it (same rule as the OpenAI
    // tiers). Either way a >= 400 cancels settlement: nobody is charged.
    if (res.status >= 500 || res.status === 429) throw bad(`Speech upstream error (HTTP ${res.status}): ${msg}`, 502);
    throw bad(`Upstream rejected the request: ${msg}`, 400);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw bad("Upstream returned no audio - retry, or rephrase the input", 502);
  return { model: tier.model, provider: "openrouter", voice: nativeVoice, format, audio: buf.toString("base64"), chars: text.length };
}

function makeHandler(tierSlug) {
  return async (input) => {
    const { text, voice, format } = validateInput(input, tierSlug);
    return TIERS[tierSlug].provider === "openrouter"
      ? callKokoro(text, voice, format, tierSlug)
      : callOpenAI(text, voice, format, tierSlug);
  };
}

const SHARED_TAGS = ["tts", "text-to-speech", "audio", "voice", "speech", "openai"];

export const TTS_TOOLS = [
  {
    route: "POST /api/tts-lite",
    name: "Text-to-speech (lite)",
    slug: "tts-lite",
    aliases: ["cheap-tts", "tts-cheap", "speech-lite"],
    category: "ai",
    price: "$0.005",
    description:
      "Convert text to speech with Kokoro-82M, ten times cheaper than /api/tts. Returns base64-encoded mp3 or pcm. The same request shape and the same ten OpenAI voice names as /api/tts, mapped to Kokoro's own voices; the voice is synthetic-sounding where the OpenAI tiers are not, which is the whole trade. Use this for high-volume narration, notifications and agent speech where the cost per call matters more than the timbre; use /api/tts or /api/tts-hd when it does not. No API key needed; pay per call via x402. Text capped at 800 chars.",
    tags: [...SHARED_TAGS, "kokoro", "cheap", "lite"],
    discovery: {
      bodyType: "json",
      input: { text: "Hello from Agent402!", voice: "alloy", format: "mp3" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to convert to speech (max 800 chars)" },
          voice: { type: "string", description: "Voice: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer (default: alloy) - mapped to the nearest Kokoro voice, which is named back in the response" },
          format: { type: "string", description: "Audio format: mp3 or pcm (default: mp3). The other formats are on /api/tts" },
        },
        required: ["text"],
      },
      output: {
        example: {
          model: "hexgrad/kokoro-82m",
          provider: "openrouter",
          voice: "af_alloy",
          format: "mp3",
          audio: "<base64-encoded audio>",
          chars: 20,
        },
      },
    },
    handler: makeHandler("tts-lite"),
  },
  {
    route: "POST /api/tts",
    name: "Text-to-speech",
    slug: "tts",
    category: "ai",
    price: "$0.050",
    description:
      "Convert text to speech using OpenAI TTS-1: returns audio (the base64-encoded file in the format asked for: mp3, opus, aac, flac, wav or pcm) with model, voice, format and chars (the characters spoken). 10 voices available. No API key needed; pay per call over x402 or MPP. Text capped at 2000 chars. Model-backed. For high-volume speech where timbre matters less, /api/tts-lite is the same interface on Kokoro-82M at $0.005.",
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
