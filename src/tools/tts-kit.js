// Text-to-speech kit — three tiers of x402-paywalled TTS, one interface.
// Returns base64-encoded audio.
//
// Tiers (prices live on each tool below):
//   tts-lite: Kokoro-82M via OpenRouter (800 chars) [OPENROUTER_API_KEY]
//   tts:      ElevenLabs Eleven v4 Turbo via OpenRouter (2000 chars), OpenAI tts-1 fallback
//   tts-hd:   ElevenLabs Eleven v4 via OpenRouter (2000 chars), OpenAI tts-1-hd fallback
//
// ELEVENLABS (2026-10-07): OpenAI shuts tts-1 and tts-1-hd down on 2027-01-06.
// The first replacement chain was turned down because it folded the ten voice
// names onto five or one and served two of the six formats. ElevenLabs gives
// each of the ten names its own voice (21 to choose from), and the four
// formats the speech wire does not serve are encoded here from its PCM
// (media-kit transcodePcm). The prices moved with the change and the cap
// stayed; the margin bound is pinned in scripts/test-tts-elevenlabs.js against
// the private rate rows.
// Until the OpenAI shutdown, an ElevenLabs outage (5xx, 429, timeout) falls
// back to the OpenAI model this tier used to serve, named in the answer.
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
import { transcodePcm } from "./media-kit.js";

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
  // provider "openrouter" reaches Kokoro; "elevenlabs" is ElevenLabs over the
  // same OpenRouter speech wire, with the OpenAI model it replaced as fallback.
  "tts-lite": { model: "hexgrad/kokoro-82m",         provider: "openrouter", maxChars: 800 },
  // `chain`: ElevenLabs models at the SAME per-char rate, tried in order on an
  // outage (launch day, 2026-10-07: v4 Turbo answered about half of calls 429
  // while the older models answered every one). Same 21 voices on every link.
  tts:        { model: "elevenlabs/eleven-v4-turbo", provider: "elevenlabs", maxChars: 2000, fallback: "tts-1",
                chain: ["elevenlabs/eleven-v4-turbo", "elevenlabs/eleven-turbo-v2.5", "elevenlabs/eleven-flash-v2.5"] },
  "tts-hd":   { model: "elevenlabs/eleven-v4",       provider: "elevenlabs", maxChars: 2000, fallback: "tts-1-hd",
                chain: ["elevenlabs/eleven-v4", "elevenlabs/eleven-v3", "elevenlabs/eleven-multilingual-v2"] },
};
export const TTS_TIERS = TIERS;

// One distinct ElevenLabs voice per OpenAI voice name, chosen by character
// (neutral, warm, deep, British, bright...). Buyers may also name any of the
// ElevenLabs voices directly; the answer always names the voice that spoke.
export const ELEVENLABS_VOICE_MAP = Object.freeze({
  alloy: "river", ash: "chris", ballad: "callum", coral: "jessica", echo: "eric",
  fable: "george", nova: "sarah", onyx: "brian", sage: "matilda", shimmer: "lily",
});
export const ELEVENLABS_VOICES = new Set([
  "george", "sarah", "adam", "alice", "bella", "bill", "brian", "callum", "charlie", "chris", "daniel",
  "eric", "harry", "jessica", "laura", "liam", "lily", "matilda", "river", "roger", "will",
]);
// OpenAI retires tts-1 and tts-1-hd on this date; after it the fallback is gone.
export const OPENAI_TTS_SHUTDOWN = Date.parse("2027-01-06T00:00:00Z");
// The speech wire serves these natively; the rest are encoded from PCM here.
const WIRE_FORMATS = new Set(["mp3", "pcm"]);
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
  const elevenTier = TIERS[tierSlug].provider === "elevenlabs";
  if (!VOICES.has(voice) && !(elevenTier && ELEVENLABS_VOICES.has(voice))) {
    const extra = elevenTier ? `, or an ElevenLabs voice: ${[...ELEVENLABS_VOICES].join(", ")}` : "";
    throw bad(`Unknown voice "${voice}". Supported: ${[...VOICES].join(", ")}${extra}`);
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

async function callOpenAI(text, voice, format, tierSlug, model, timeoutMs = 30_000) {
  const key = OPENAI_KEY();
  if (!key) throw bad("OpenAI not configured", 503);

  let res;
  try {
    res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        response_format: format,
      }),
      signal: AbortSignal.timeout(timeoutMs),
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
    model,
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

/** ElevenLabs over OpenRouter's speech wire. mp3 and pcm come back as is;
 *  wav, flac, opus and aac are encoded here from the PCM.
 *
 *  Only a failure the upstream did not bill moves to the next link or the
 *  OpenAI fallback: a 429, a 5xx, our key refused (401/403), or a connection
 *  that never reached it. Those are marked `outage`. A timeout or an empty
 *  answer may already have been generated and billed, so each is final: an
 *  uncharged 5xx with no further upstream call, which keeps one paid call to
 *  at most one billed generation. A 4xx is the request's fault: a 400.
 *  The whole call, fallback included, runs inside TTS_DEADLINE_MS. */
export const TTS_DEADLINE_MS = 40_000;
const TTS_LINK_TIMEOUT_MS = 25_000;
const CONNECT_FAILURES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
async function callElevenLabs(text, voice, format, tierSlug, deadline) {
  let last;
  for (const model of TIERS[tierSlug].chain) {
    const left = deadline - Date.now();
    if (left < 3_000) break;
    try {
      return await callElevenLabsModel(model, text, voice, format, Math.min(TTS_LINK_TIMEOUT_MS, left));
    } catch (e) {
      if (!e?.outage) throw e;
      last = e;
    }
  }
  throw last || Object.assign(bad("Speech upstream did not answer in time - retry shortly", 504), { outage: false });
}

async function callElevenLabsModel(model, text, voice, format, timeoutMs) {
  const key = OPENROUTER_KEY();
  if (!key) throw Object.assign(bad("Speech gateway not configured (OPENROUTER_API_KEY unset)", 503), { outage: true });
  const nativeVoice = ELEVENLABS_VOICE_MAP[voice] || voice;
  const wireFormat = WIRE_FORMATS.has(format) ? format : "pcm";
  let res;
  try {
    res = await fetch(OPENROUTER_SPEECH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...OPENROUTER_ATTRIBUTION },
      body: JSON.stringify({ model, input: text, voice: nativeVoice, response_format: wireFormat }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // Only a connection that was never set up is certainly unbilled: an outage.
    // Anything later (a timeout, a socket dropped mid-answer) may have been
    // generated and billed, so it is final.
    const code = e?.cause?.code || e?.code;
    const neverConnected = CONNECT_FAILURES.has(code);
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    throw Object.assign(bad(timedOut ? "Speech upstream timed out - retry shortly" : `Upstream request failed: ${String(e?.message || e).slice(0, 120)}`, 504), { outage: neverConnected });
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const safe = redactSecrets(errText);
    let msg = safe.slice(0, 200);
    try { msg = JSON.parse(safe).error?.message || msg; } catch {}
    // Our key refused (401/403) is our configuration, not the buyer's request.
    if (res.status === 401 || res.status === 403) throw Object.assign(bad("Speech upstream auth failed", 502), { outage: true });
    if (res.status >= 500 || res.status === 429) throw Object.assign(bad(`Speech upstream error (HTTP ${res.status}): ${msg}`, 502), { outage: true });
    throw bad(`Upstream rejected the request: ${msg}`, 400);
  }
  let buf = Buffer.from(await res.arrayBuffer());
  // A 200 with no audio may still have been billed: final, no next link.
  if (buf.length === 0) throw bad("Upstream returned no audio - retry, or rephrase the input", 502);
  if (wireFormat !== format) buf = await transcodePcm(buf, format);
  return { model, provider: "openrouter", voice: nativeVoice, format, audio: buf.toString("base64"), chars: text.length };
}

/** The OpenAI voice name for a fallback call: the name the buyer gave, or the
 *  OpenAI name mapped to the ElevenLabs voice they named directly. */
function openAiVoiceFor(voice) {
  if (VOICES.has(voice)) return voice;
  return Object.entries(ELEVENLABS_VOICE_MAP).find(([, v]) => v === voice)?.[0] || "alloy";
}

function makeHandler(tierSlug, { now = () => Date.now() } = {}) {
  return async (input) => {
    const { text, voice, format } = validateInput(input, tierSlug);
    const tier = TIERS[tierSlug];
    if (tier.provider === "openrouter") return callKokoro(text, voice, format, tierSlug);
    const deadline = Date.now() + TTS_DEADLINE_MS;
    try {
      return await callElevenLabs(text, voice, format, tierSlug, deadline);
    } catch (e) {
      if (!e?.outage || !tier.fallback || !OPENAI_KEY() || now() >= OPENAI_TTS_SHUTDOWN) throw e;
      const left = deadline - Date.now();
      if (left < 3_000) throw e;
      return callOpenAI(text, openAiVoiceFor(voice), format, tierSlug, tier.fallback, left);
    }
  };
}
export const __makeHandlerForTest = makeHandler;

// The lite price, read by the /api/tts description so it is never typed twice.
const TTS_LITE_PRICE = "$0.005";
const SHARED_TAGS = ["tts", "text-to-speech", "audio", "voice", "speech"];

export const TTS_TOOLS = [
  {
    route: "POST /api/tts-lite",
    name: "Text-to-speech (lite)",
    slug: "tts-lite",
    aliases: ["cheap-tts", "tts-cheap", "speech-lite"],
    category: "ai",
    price: TTS_LITE_PRICE,
    description:
      "Convert text to speech with Kokoro-82M, a fraction of the price of /api/tts. Returns base64-encoded mp3 or pcm. The same request shape and the same ten voice names as /api/tts, mapped to Kokoro's own voices; the voice is synthetic-sounding where the ElevenLabs tiers are not, which is the whole trade. Use this for high-volume narration, notifications and agent speech where the cost per call matters more than the timbre; use /api/tts or /api/tts-hd when it does not. No API key needed; pay per call via x402. Text capped at 800 chars.",
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
    price: "$0.120",
    description:
      `Convert text to speech with ElevenLabs Eleven v4 Turbo: returns audio (the base64-encoded file in the format asked for: mp3, opus, aac, flac, wav or pcm) with model, voice, format and chars (the characters spoken). The ten OpenAI voice names each map to their own ElevenLabs voice, or name one of 21 ElevenLabs voices directly; the answer names the voice that spoke. 90+ languages. No API key needed; pay per call over x402 or MPP. Text capped at 2000 chars. Model-backed. For high-volume speech where timbre matters less, /api/tts-lite is the same interface on Kokoro-82M at ${TTS_LITE_PRICE}.`,
    tags: [...SHARED_TAGS, "elevenlabs", "eleven-v4-turbo"],
    discovery: {
      bodyType: "json",
      input: { text: "Hello from Agent402!", voice: "alloy", format: "mp3" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to convert to speech (max 2000 chars)" },
          voice: { type: "string", description: "Voice: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer (default: alloy), each mapped to its own ElevenLabs voice, or an ElevenLabs voice by name (george, sarah, adam, alice, bella, bill, brian, callum, charlie, chris, daniel, eric, harry, jessica, laura, liam, lily, matilda, river, roger, will)" },
          format: { type: "string", description: "Audio format: mp3, opus, aac, flac, wav, pcm (default: mp3)" },
        },
        required: ["text"],
      },
      output: {
        example: {
          model: "elevenlabs/eleven-v4-turbo",
          provider: "openrouter",
          voice: "river",
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
    price: "$0.240",
    description:
      "Convert text to speech with ElevenLabs Eleven v4, its most expressive model (inline audio tags such as [whispering] are read as delivery cues). Returns base64-encoded audio. Same interface, voices and formats as /api/tts. No API key needed; pay per call via x402 or MPP. Text capped at 2000 chars. Model-backed.",
    tags: [...SHARED_TAGS, "elevenlabs", "eleven-v4", "hd"],
    discovery: {
      bodyType: "json",
      input: { text: "Hello from Agent402!", voice: "alloy", format: "mp3" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to convert to speech (max 2000 chars)" },
          voice: { type: "string", description: "Voice: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer (default: alloy), each mapped to its own ElevenLabs voice, or an ElevenLabs voice by name (george, sarah, adam, alice, bella, bill, brian, callum, charlie, chris, daniel, eric, harry, jessica, laura, liam, lily, matilda, river, roger, will)" },
          format: { type: "string", description: "Audio format: mp3, opus, aac, flac, wav, pcm (default: mp3)" },
        },
        required: ["text"],
      },
      output: {
        example: {
          model: "elevenlabs/eleven-v4",
          provider: "openrouter",
          voice: "river",
          format: "mp3",
          audio: "<base64-encoded audio>",
          chars: 20,
        },
      },
    },
    handler: makeHandler("tts-hd"),
  },
];
