// Text-to-speech kit — three tiers of x402-paywalled TTS, one interface.
// Returns base64-encoded audio.
//
// Tiers (prices live on each tool below):
//   tts-lite: Kokoro-82M via OpenRouter (800 chars) [OPENROUTER_API_KEY]
//   tts:      ElevenLabs Eleven v4 Turbo via OpenRouter (2000 chars)
//   tts-hd:   ElevenLabs Eleven v4 via OpenRouter (2000 chars)
//
// ELEVENLABS (2026-10-07): the two premium tiers moved from OpenAI speech to
// ElevenLabs over the OpenRouter speech wire. The first replacement chain was
// turned down because it folded the ten voice names onto five or one and
// served two of the six formats. ElevenLabs gives each of the ten names its
// own voice (21 to choose from), and the four formats the speech wire does
// not serve are encoded here from its PCM (media-kit transcodePcm). The
// prices moved with the change and the cap stayed; the margin bound is pinned
// in scripts/test-tts-elevenlabs.js against the private rate rows.
// When ElevenLabs is busy, throttling or erroring, a backup speech model on
// the same wire serves the call (see the breaker below); a timeout or empty
// answer is final instead, since it may have been billed. The answer always
// names the model that spoke. Every tier runs on OPENROUTER_API_KEY alone.
//
// WHY A LITE TIER (2026-09-11): a cheaper MODEL - Kokoro-82M, already a
// proven link in the /v1/audio/speech failover chain (SPEECH_MODELS,
// live-verified by the TTS probe workflow) - rather than a cut on the premium
// voice. The premium tiers are untouched - a buyer who wants the premium voice
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
// Our data policy on every OpenRouter speech request: data_collection deny,
// and zdr on the models whose every endpoint is ZDR (see the module).
import { audioProviderPolicy } from "../openrouter-audio-policy.js";
import { transcodePcm } from "./media-kit.js";
import { upstreamCosts } from "../upstream-costs.js";
import { capturePostHogGatewayUsage } from "../posthog.js";
import { upstreamFetch, upstreamDeadline, bodyUnderDeadline, underBudgetAll, PAYMENT_WINDOW_BUDGET_MS } from "../upstream-deadline.js";

const OPENROUTER_KEY = () => (process.env.OPENROUTER_API_KEY || "").trim();
const OPENROUTER_SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";
// The same Kokoro entry the /v1 speech chain uses, so the voice map and the
// native voice set cannot drift between the two surfaces (the TTS probe
// workflow re-verifies that table against OpenRouter's live model list).
const KOKORO = SPEECH_MODELS.find((m) => m.id === "hexgrad/kokoro-82m");

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export const VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"]);
export const FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"]);

const TIERS = {
  // provider "openrouter" reaches Kokoro; "elevenlabs" is ElevenLabs over the
  // same OpenRouter speech wire, with TTS_BACKUP_MODELS behind it.
  "tts-lite": { model: "hexgrad/kokoro-82m",         provider: "openrouter", maxChars: 800 },
  // `chain`: ElevenLabs models at the SAME per-char rate, tried in order after
  // a server error or a connection that never opened (both unbilled). A 429
  // or a refusal stops the walk and opens the breaker. Same 21 voices on every link.
  tts:        { model: "elevenlabs/eleven-v4-turbo", provider: "elevenlabs", maxChars: 2000,
                chain: ["elevenlabs/eleven-v4-turbo", "elevenlabs/eleven-turbo-v2.5", "elevenlabs/eleven-flash-v2.5"] },
  "tts-hd":   { model: "elevenlabs/eleven-v4",       provider: "elevenlabs", maxChars: 2000,
                chain: ["elevenlabs/eleven-v4", "elevenlabs/eleven-v3", "elevenlabs/eleven-multilingual-v2"] },
};
export const TTS_TIERS = TIERS;

// One distinct ElevenLabs voice per standard voice name, chosen by character
// (neutral, warm, deep, British, bright...). Buyers may also name any of the
// ElevenLabs voices directly; the answer always names the voice that spoke.
export const ELEVENLABS_VOICE_MAP = Object.freeze({
  alloy: "river", ash: "chris", ballad: "callum", coral: "jessica", echo: "eric",
  fable: "george", nova: "sarah", onyx: "brian", sage: "matilda", shimmer: "lily",
});
// The standard voice name a backup uses for each ElevenLabs voice: the ten
// mapped ones invert ELEVENLABS_VOICE_MAP; the rest by voice character.
const ELEVEN_TO_STANDARD = Object.freeze({
  adam: "onyx", alice: "shimmer", bella: "coral", bill: "ash", charlie: "echo", daniel: "fable",
  harry: "echo", laura: "sage", liam: "ash", roger: "onyx", will: "echo",
});
export const ELEVENLABS_VOICES = new Set([
  "george", "sarah", "adam", "alice", "bella", "bill", "brian", "callum", "charlie", "chris", "daniel",
  "eric", "harry", "jessica", "laura", "liam", "lily", "matilda", "river", "roger", "will",
]);
// The speech wire serves these natively; the rest are encoded from PCM here.
const WIRE_FORMATS = new Set(["mp3", "pcm"]);
// The lite tier serves what the speech wire serves natively; the ElevenLabs
// tiers encode the rest from PCM. A format this tier cannot serve is a
// self-explaining 400, never a silent downgrade to mp3 (a documented default
// is a contract - 2026-09-06).
export const LITE_FORMATS = new Set(["mp3", "pcm"]);

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
    const extra = elevenTier ? `, or a named voice: ${[...ELEVENLABS_VOICES].join(", ")}` : "";
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

/** Kokoro over OpenRouter's OpenAI-shaped speech wire. Same request/response
 *  contract as the ElevenLabs tiers, so the three are one interface to a buyer.
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
  // One read under its cap; a read that outlives it is the upstream's 503
  // (src/upstream-deadline.js), never a 504. Kokoro's measured tail runs past
  // 30 s, so its cap stays at 60 s.
  const res = await upstreamFetch(OPENROUTER_SPEECH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...OPENROUTER_ATTRIBUTION },
    body: JSON.stringify({ model: tier.model, input: text, voice: nativeVoice, response_format: format, provider: audioProviderPolicy(tier.model) }),
  }, { label: "Speech upstream", step: "speech", timeoutMs: KOKORO_READ_MS, tag: "[tts]" });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const safe = redactSecrets(errText);
    let msg = safe.slice(0, 200);
    try { msg = JSON.parse(safe).error?.message || msg; } catch {}
    // 5xx and 429 are the provider's; anything else is this request being
    // wrong, and a 400 teaches the agent to fix it (same rule as the
    // ElevenLabs tiers). Either way a >= 400 cancels settlement: nobody is charged.
    // Our key refused or our gateway credit gone is ours, not the request's.
    if (res.status === 401 || res.status === 403) throw bad("Speech upstream temporarily unavailable - retry shortly", 502);
    if (res.status === 402) throw bad("Speech gateway temporarily unavailable - retry shortly", 503);
    if (res.status >= 500 || res.status === 429) {
      console.warn(`[tts] upstream HTTP ${res.status}: ${msg}`);
      throw bad(`Speech upstream error (HTTP ${res.status}) - retry shortly`, 502);
    }
    throw bad(`Upstream rejected the request: ${msg}`, 400);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw bad("Upstream returned no audio - retry, or rephrase the input", 502);
  return { model: tier.model, provider: "openrouter", voice: nativeVoice, format, audio: buf.toString("base64"), chars: text.length };
}

/** ElevenLabs over OpenRouter's speech wire. mp3 and pcm come back as is;
 *  wav, flac, opus and aac are encoded here from the PCM.
 *
 *  Only a failure the upstream did not bill moves to the next link or a
 *  backup model: a 429, a 5xx, our key refused (401/403), or a connection
 *  that never reached it. Those are marked `outage`. A timeout or an empty
 *  answer may already have been generated and billed, so each is final: an
 *  uncharged 5xx with no further upstream call, which keeps one paid call to
 *  at most one billed generation. A 4xx is the request's fault: a 400.
 *  The whole call, backups included, runs inside TTS_DEADLINE_MS, and the
 *  handler under the route's payment-window budget (src/upstream-deadline.js,
 *  PAYMENT_WINDOW_BUDGET_MS), never the 20 s data-kit budget: the measured
 *  speech tail runs past it. Each link gets TTS_LINK_TIMEOUT_MS or what is
 *  left; a link that outlives its cap is a 503 naming the step. */
export const TTS_DEADLINE_MS = 40_000;
const TTS_LINK_TIMEOUT_MS = 25_000;
const KOKORO_READ_MS = 60_000;
const CONNECT_FAILURES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

// --- ElevenLabs traffic control --------------------------------------------
// A throttle is never answered with more ElevenLabs calls:
//   - a 429 or an auth refusal (401/403) stops the ElevenLabs walk at once and
//     opens a breaker shared by both tiers (one credential): for the cooldown
//     every call goes straight to the backups, then ONE call probes;
//   - three failed calls in a row open it too; a server error or a connection
//     that never opened still tries the next ElevenLabs model (unbilled);
//   - at most ELEVEN_MAX_IN_FLIGHT calls run at once; the rest use a backup.
// Backups, in order: the non-ElevenLabs speech models in TTS_BACKUP_MODELS,
// each on the same wire. The answer always names the model that spoke.
export const ELEVEN_MAX_IN_FLIGHT = 6;
const BREAKER_BASE_MS = 60_000;
const BREAKER_MAX_MS = 15 * 60_000;
// `epoch` bumps on every trip: an outcome from a call that passed the gate
// before the latest trip says nothing about ElevenLabs now and is ignored
// (a call in flight when another tripped must not close the breaker).
const breaker = { openUntil: 0, trips: 0, serverErrors: 0, probing: false, epoch: 0 };
let elevenInFlight = 0;
// Voxtral first: its SPEECH_MODELS map (shared with /v1/audio/speech, so the
// two surfaces cannot drift) gives nine of the ten names their own voice id,
// three English speakers across their delivery variants; coral and sage share
// gb_jane_neutral, the one calm variant that speaker has. Then Grok: five
// distinct voices, so the ten names fold onto five; then MAI-Voice-2, one
// English voice. Every backup serves all six formats (mp3 and pcm from the
// wire, the rest encoded here), so a backup never loses a buyer a format,
// only voice distinctness.
export const TTS_BACKUP_MODELS = ["mistralai/voxtral-mini-tts-2603", "x-ai/grok-voice-tts-1.0", "microsoft/mai-voice-2"];

/** Whether this call may use ElevenLabs, and if so whether it is the probe. */
function elevenGate(now = Date.now()) {
  if (elevenInFlight >= ELEVEN_MAX_IN_FLIGHT) return { ok: false, why: "busy" };
  if (now < breaker.openUntil) return { ok: false, why: "cooling" };
  if (breaker.trips > 0) {
    if (breaker.probing) return { ok: false, why: "probing" };
    breaker.probing = true;
    return { ok: true, probe: true, epoch: breaker.epoch };
  }
  return { ok: true, probe: false, epoch: breaker.epoch };
}
function tripBreaker(retryAfterMs = 0, now = Date.now()) {
  // Already open (a burst of failures from calls in flight together): one
  // trip, not one per call. A longer Retry-After still extends it.
  if (now < breaker.openUntil) { breaker.openUntil = Math.max(breaker.openUntil, now + (retryAfterMs || 0)); return; }
  breaker.trips++;
  breaker.epoch++;
  const cooldown = Math.max(retryAfterMs || 0, Math.min(BREAKER_BASE_MS * 2 ** (breaker.trips - 1), BREAKER_MAX_MS));
  breaker.openUntil = now + cooldown;
  breaker.serverErrors = 0;
  breaker.probing = false;
}
/** `e` null = served. Throttles trip at once; server errors, timeouts and
 *  empty answers (`unhealthy`) trip after three in a row, so a hanging
 *  ElevenLabs moves later buyers to the backups. */
function noteElevenOutcome(gate, e) {
  const stale = gate.epoch !== breaker.epoch;
  if (!e) {
    if (gate.probe || (!stale && breaker.trips === 0)) Object.assign(breaker, { trips: 0, serverErrors: 0, probing: false, openUntil: 0 });
    return;
  }
  if (e.throttle) return tripBreaker(e.retryAfterMs);
  if (stale && !gate.probe) return;
  if (gate.probe) return tripBreaker(); // a failed probe re-opens, longer
  if ((e.outage || e.unhealthy) && ++breaker.serverErrors >= 3) tripBreaker();
}
/** Bucketed state for status surfaces: ok | cooling | probing. */
export function elevenLabsBreakerState(now = Date.now()) {
  if (now < breaker.openUntil) return "cooling";
  return breaker.trips > 0 ? "probing" : "ok";
}
export function __resetTtsBreakerForTest() { Object.assign(breaker, { openUntil: 0, trips: 0, serverErrors: 0, probing: false, epoch: 0 }); elevenInFlight = 0; }
export function __ttsBreakerForTest() { return { ...breaker, inFlight: elevenInFlight }; }

async function callElevenLabs(text, voice, format, tierSlug, deadline) {
  let last;
  for (const model of TIERS[tierSlug].chain) {
    const left = deadline - Date.now();
    if (left < 3_000) break;
    try {
      return await callSpeechModel(model, ELEVENLABS_VOICE_MAP[voice] || voice, text, format, Math.min(TTS_LINK_TIMEOUT_MS, left));
    } catch (e) {
      // A throttle or a refusal is never answered with another ElevenLabs call.
      if (!e?.outage || e.throttle) throw e;
      last = e;
    }
  }
  throw last || Object.assign(upstreamDeadline("Speech upstream", "speech", TTS_DEADLINE_MS), { outage: false });
}

/** One model over OpenRouter's speech wire. mp3 and pcm come back as is; wav,
 *  flac, opus and aac are encoded here from the PCM. Errors carry `outage`
 *  (certainly unbilled: may try elsewhere) and `throttle` (429/401/403). */
async function callSpeechModel(model, nativeVoice, text, format, timeoutMs) {
  const key = OPENROUTER_KEY();
  if (!key) throw Object.assign(bad("Speech gateway not configured (OPENROUTER_API_KEY unset)", 503), { outage: true });
  const wireFormat = WIRE_FORMATS.has(format) ? format : "pcm";
  // The cause is read before the shared helper maps the failure, because only
  // a connection that was never set up is certainly unbilled (an outage, so
  // a backup may be tried). Anything later (a deadline, a socket dropped
  // mid-answer) may have been generated and billed, so it is final. Both are
  // the upstream's 503 classes (src/upstream-deadline.js), never a 504.
  let neverConnected = false;
  const probe = (url, init) => fetch(url, init).catch((e) => { neverConnected = CONNECT_FAILURES.has(e?.cause?.code || e?.code); throw e; });
  let res;
  try {
    res = await upstreamFetch(OPENROUTER_SPEECH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...OPENROUTER_ATTRIBUTION },
      body: JSON.stringify({ model, input: text, voice: nativeVoice, response_format: wireFormat, provider: audioProviderPolicy(model) }),
    }, { label: "Speech upstream", step: "speech", timeoutMs, tag: "[tts]", fetchImpl: probe });
  } catch (e) {
    throw Object.assign(e, { outage: neverConnected, unhealthy: true });
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const safe = redactSecrets(errText);
    let msg = safe.slice(0, 200);
    try { msg = JSON.parse(safe).error?.message || msg; } catch {}
    // 402 is our gateway credit running out: ours, unbilled, and every
    // OpenRouter model shares it, so stop and use what does not.
    if (res.status === 402) throw Object.assign(bad("Speech gateway temporarily unavailable - retry shortly", 503), { outage: true, throttle: true, credit: true });
    const ra = Number(res.headers?.get?.("retry-after"));
    const retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) * 1000 : 0;
    // Our key refused (401/403) is our configuration, not the buyer's request.
    if (res.status === 401 || res.status === 403) throw Object.assign(bad("Speech upstream temporarily unavailable - retry shortly", 502), { outage: true, throttle: true, retryAfterMs });
    if (res.status === 429) throw Object.assign(bad("Speech upstream rate-limited - retry shortly", 503), { outage: true, throttle: true, retryAfterMs });
    if (res.status >= 500) {
      console.warn(`[tts] upstream HTTP ${res.status}: ${msg}`);
      throw Object.assign(bad(`Speech upstream error (HTTP ${res.status}) - retry shortly`, 502), { outage: true });
    }
    throw bad(`Upstream rejected the request: ${msg}`, 400);
  }
  let buf = Buffer.from(await res.arrayBuffer());
  // A 200 with no audio may still have been billed: final, no next link.
  if (buf.length === 0) throw Object.assign(bad("Upstream returned no audio - retry, or rephrase the input", 502), { unhealthy: true });
  // Encode at the rate the wire reports (every speech model checked answers 24 kHz).
  const rate = Number(/rate=(\d+)/.exec(res.headers?.get?.("content-type") || "")?.[1]) || 24000;
  if (wireFormat !== format) buf = await transcodePcm(buf, format, { sampleRate: rate });
  return { model, provider: "openrouter", voice: nativeVoice, format, audio: buf.toString("base64"), chars: text.length };
}

/** The standard voice name for a backup call: the name the buyer gave, or
 *  the standard name mapped to the ElevenLabs voice they named directly, so
 *  a backup keeps the character of the voice asked for. */
function standardVoiceFor(voice) {
  if (VOICES.has(voice)) return voice;
  return Object.entries(ELEVENLABS_VOICE_MAP).find(([, v]) => v === voice)?.[0] || ELEVEN_TO_STANDARD[voice] || "alloy";
}

/** The backups after ElevenLabs, in order, each tried only after the one
 *  before failed in a way that was certainly unbilled. A gateway credit
 *  refusal (402) is shared by every model on the wire, so it ends the walk. */
async function callBackups(text, voice, format, deadline, first) {
  if (first?.credit) throw first;
  let last = first;
  const name = standardVoiceFor(voice);
  for (const id of TTS_BACKUP_MODELS) {
    const entry = SPEECH_MODELS.find((m) => m.id === id);
    const left = deadline - Date.now();
    if (!entry || left < 3_000) continue;
    try { return await callSpeechModel(id, entry.map?.[name] || entry.map?.alloy, text, format, Math.min(TTS_LINK_TIMEOUT_MS, left)); }
    catch (e) { if (!e?.outage) throw e; last = e; }
  }
  throw last || Object.assign(bad("Speech upstream unavailable - retry shortly", 503), { outage: false });
}

// The list price of a tier, read from its own tool def so it is never typed twice.
const tierPriceUsd = (slug) => { const t = TTS_TOOLS.find((x) => x.slug === slug); return t ? Number(String(t.price).replace("$", "")) || 0 : 0; };

/** Speech bills per character at the private rate of the model that SPOKE
 *  (a backup link bills at its own row), so the spend is
 *  priced from the served answer, after every served call, into the same
 *  meter and margin event as the /v1 tiers. Without a row for that model the
 *  call is recorded with no figure: the meter never invents one. */
function recordSpeechSpend(tierSlug, out) {
  try {
    const rate = upstreamCosts().speech?.[out?.model];
    const chars = Number(out?.chars) || 0;
    const upstreamUsd = rate != null && chars > 0 ? Math.round(chars * rate * 1e6) / 1e6 : null;
    capturePostHogGatewayUsage({ tier: tierSlug, model: out?.model, priceUsd: tierPriceUsd(tierSlug), upstreamUsd, source: "speech" });
  } catch { /* telemetry must never fail a served response */ }
}

function makeHandler(tierSlug) {
  const serve = makeServe(tierSlug);
  return async (input) => {
    const out = await serve(input);
    recordSpeechSpend(tierSlug, out);
    return out;
  };
}

function makeServe(tierSlug) {
  return async (input) => {
    const { text, voice, format } = validateInput(input, tierSlug);
    const tier = TIERS[tierSlug];
    if (tier.provider === "openrouter") return callKokoro(text, voice, format, tierSlug);
    const deadline = Date.now() + TTS_DEADLINE_MS;
    const gate = elevenGate();
    if (!gate.ok) return callBackups(text, voice, format, deadline, null);
    elevenInFlight++;
    let failure = null;
    try {
      return await callElevenLabs(text, voice, format, tierSlug, deadline);
    } catch (e) {
      failure = e;
      if (!e?.outage) throw e;
      return callBackups(text, voice, format, deadline, e);
    } finally {
      elevenInFlight--;
      if (!failure || failure.outage || failure.throttle || failure.unhealthy) noteElevenOutcome(gate, failure);
      else if (gate.probe) breaker.probing = false; // the request's own fault says nothing about ElevenLabs
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
      "Convert text to speech with Kokoro-82M, a fraction of the price of /api/tts. Returns base64-encoded mp3 or pcm. The same request shape and the same ten voice names as /api/tts, mapped to Kokoro's own voices; the voice is synthetic-sounding where the /api/tts and /api/tts-hd tiers are not, which is the whole trade. Use this for high-volume narration, notifications and agent speech where the cost per call matters more than the timbre; use /api/tts or /api/tts-hd when it does not. No API key needed; pay per call via x402. Text capped at 800 chars.",
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
      `Convert text to speech with the eleven-v4-turbo model: returns audio (the base64-encoded file in the format asked for: mp3, opus, aac, flac, wav or pcm) with model, voice, format and chars (the characters spoken). The ten standard voice names each map to their own voice, or name one of 21 named voices directly; the answer names the voice that spoke. 90+ languages. If the primary speech model is busy, throttling or down, a backup speech model with fewer voices and languages serves the call and the answer's model field names it. No API key needed; pay per call over x402 or MPP. Text capped at 2000 chars. Model-backed. For high-volume speech where timbre matters less, /api/tts-lite is the same interface on Kokoro-82M at ${TTS_LITE_PRICE}.`,
    tags: [...SHARED_TAGS, "eleven-v4-turbo"],
    discovery: {
      bodyType: "json",
      input: { text: "Hello from Agent402!", voice: "alloy", format: "mp3" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to convert to speech (max 2000 chars)" },
          voice: { type: "string", description: "Voice: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer (default: alloy), each mapped to its own voice, or a named voice (george, sarah, adam, alice, bella, bill, brian, callum, charlie, chris, daniel, eric, harry, jessica, laura, liam, lily, matilda, river, roger, will)" },
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
      "Convert text to speech with the eleven-v4 model, the most expressive speech tier (inline audio tags such as [whispering] are read as delivery cues). Returns base64-encoded audio. Same interface, voices, formats and backups as /api/tts. No API key needed; pay per call via x402 or MPP. Text capped at 2000 chars. Model-backed.",
    tags: [...SHARED_TAGS, "eleven-v4", "hd"],
    discovery: {
      bodyType: "json",
      input: { text: "Hello from Agent402!", voice: "alloy", format: "mp3" },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to convert to speech (max 2000 chars)" },
          voice: { type: "string", description: "Voice: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer (default: alloy), each mapped to its own voice, or a named voice (george, sarah, adam, alice, bella, bill, brian, callum, charlie, chris, daniel, eric, harry, jessica, laura, liam, lily, matilda, river, roger, will)" },
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

// Every handler runs under one budget (src/upstream-deadline.js).
underBudgetAll(TTS_TOOLS, PAYMENT_WINDOW_BUDGET_MS);
