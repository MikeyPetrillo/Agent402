// Speech and transcription models a buyer can name, beside the default chains.
//
// Each is a newer model from a provider this server already sends speech or
// transcription to. None is in a default chain: a call reaches one only by
// naming it in `model`, and the route's own chain or model still serves every
// other call.
//
// THE GATE. A model here is served, and listed, only while ALL THREE hold:
//   1. NAMED_AUDIO_MODELS names it (a comma list of model ids, or `all`;
//      unset: none), read at call time;
//   2. its private cost row is present (src/upstream-costs.js: `speech.<id>`
//      per character, `sttPerMinute.<id>` per audio minute); and
//   3. the route's worst case on it stays inside the margin bound: the cap
//      (characters, or minutes) times the row is at most MARGIN of the price.
// Otherwise the model is not offered: a request that names it gets the 400
// every unknown model gets, and no listing, schema or description names it.
// The rows are required keys of the table (it reads partial without them),
// so a complete table does not by itself turn a model on: the switch does,
// after a supervised paid call has proven the model and what it bills.
//
// Voice ids are the provider's own, as its public model listing gives them
// (`supported_voices`); the live guard (scripts/test-gateway-model-ids.js)
// re-reads the listing.
//
// No imports beyond the cost table: llm-gateway-kit.js, stt-kit.js and the
// audio policy all read this file.
import { upstreamCosts } from "./upstream-costs.js";

/** The share of a route's price its worst-case upstream spend may reach
 *  (MARGIN in llm-gateway-kit.js, STT_MARGIN in stt-kit.js; pinned equal by
 *  scripts/test-speech-additions.js). */
export const ADDITION_MARGIN = 0.7;

const ELEVEN_VOICES = ["george","sarah","adam","alice","bella","bill","brian","callum","charlie","chris","daniel","eric","harry","jessica","laura","liam","lily","matilda","river","roger","will"];
// Voxtral TTS 3: the named expressive voices, and its numbered library voices.
const VOXTRAL3_NAMED = [
  "en_paul_sad", "en_paul_neutral", "en_paul_happy", "en_paul_frustrated", "en_paul_excited", "en_paul_confident",
  "en_paul_cheerful", "en_paul_angry", "gb_oliver_neutral", "gb_jane_sarcasm", "gb_jane_confused", "gb_oliver_sad",
  "gb_oliver_excited", "gb_oliver_curious", "gb_oliver_confident", "gb_oliver_cheerful", "gb_oliver_angry",
  "gb_jane_shameful", "gb_jane_sad", "gb_jane_neutral", "gb_jane_jealousy", "gb_jane_frustrated", "gb_jane_curious",
  "gb_jane_confident", "fr_marie_sad", "fr_marie_neutral", "fr_marie_happy", "fr_marie_excited", "fr_marie_curious",
  "fr_marie_angry",
];
const VOXTRAL3_NUMBERED = [447, 478, 479, 480, 481, 482, 483, 485, 589, 590, 591, 592, 1786, 1787, 1788, 3132, 3133, 3134, 3135, 3136, 3137, 3138, 3139, 3140, 3141, 3142, 3143, 3144, 3145, 3146, 3147, 3149, 3150, 3153, 3154, 3155].map((n) => `voice_${n}`);

/** Speech models for POST /v1/audio/speech, named in `model`. `map` gives each
 *  OpenAI voice name one of the model's own voices. */
export const SPEECH_ADDITIONS = Object.freeze([
  Object.freeze({
    id: "elevenlabs/eleven-v3-conversational",
    aliases: Object.freeze(["eleven-v3-conversational"]),
    // The same speaker per OpenAI name as /api/tts gives (ELEVENLABS_VOICE_MAP in tts-kit.js).
    map: Object.freeze({ alloy: "river", ash: "chris", ballad: "callum", coral: "jessica", echo: "eric", fable: "george", onyx: "brian", nova: "sarah", sage: "matilda", shimmer: "lily", verse: "liam" }),
    voices: new Set(ELEVEN_VOICES),
  }),
  Object.freeze({
    id: "mistralai/voxtral-mini-tts-3-0",
    aliases: Object.freeze(["voxtral-mini-tts-3-0", "voxtral-tts-3"]),
    // The same expressive voice per OpenAI name as the chain's Voxtral link.
    map: Object.freeze({ alloy: "en_paul_neutral", ash: "en_paul_confident", ballad: "gb_oliver_neutral", coral: "gb_jane_neutral", echo: "en_paul_happy", fable: "gb_oliver_cheerful", onyx: "gb_oliver_confident", nova: "gb_jane_confident", sage: "gb_jane_neutral", shimmer: "gb_jane_curious", verse: "en_paul_cheerful" }),
    voices: new Set([...VOXTRAL3_NAMED, ...VOXTRAL3_NUMBERED]),
  }),
]);

/** Transcription models for the URL transcribe routes, named in `model`. Each
 *  is sent over the same transcription wire the speaker-label path uses. */
export const STT_ADDITIONS = Object.freeze([
  Object.freeze({ id: "mistralai/voxtral-mini-transcribe-3-0", aliases: Object.freeze(["voxtral-mini-transcribe-3-0", "voxtral-mini-transcribe"]) }),
  Object.freeze({ id: "mistralai/voxtral-small-transcribe-3-0", aliases: Object.freeze(["voxtral-small-transcribe-3-0", "voxtral-small-transcribe"]) }),
  Object.freeze({ id: "microsoft/mai-transcribe-2", aliases: Object.freeze(["mai-transcribe-2"]) }),
]);

/** Every model id here (the audio policy and the live guard read it). */
export const ADDITION_MODEL_IDS = Object.freeze([...SPEECH_ADDITIONS.map((m) => m.id), ...STT_ADDITIONS.map((m) => m.id)]);
/** The private cost rows the additions read, as [section, key]. */
export const ADDITION_COST_KEYS = Object.freeze([
  ...SPEECH_ADDITIONS.map((m) => Object.freeze(["speech", m.id])),
  ...STT_ADDITIONS.map((m) => Object.freeze(["sttPerMinute", m.id])),
]);

/** The model ids NAMED_AUDIO_MODELS turns on: a comma list, or `all`; unset or `off`: none. */
export function namedAudioModelsOn(env = process.env) {
  const raw = String(env?.NAMED_AUDIO_MODELS ?? "").trim().toLowerCase();
  if (!raw || raw === "off") return new Set();
  if (raw === "all") return new Set(ADDITION_MODEL_IDS);
  return new Set(raw.split(",").map((s) => s.trim()).filter((id) => ADDITION_MODEL_IDS.includes(id)));
}

const positive = (x) => typeof x === "number" && Number.isFinite(x) && x > 0;
/** Is a cap times a rate inside the margin bound of a price? */
export function withinMargin(cap, rate, priceUsd) {
  return positive(cap) && positive(rate) && positive(priceUsd) && cap * rate <= ADDITION_MARGIN * priceUsd + 1e-12;
}

const find = (list, name) => {
  const raw = String(name ?? "").trim().toLowerCase();
  return raw ? list.find((m) => m.id === raw || m.aliases.includes(raw)) || null : null;
};
/** The speech addition a `model` value names (admitted or not), or null. */
export const speechAdditionNamed = (name) => find(SPEECH_ADDITIONS, name);
/** The transcription addition a `model` value names (admitted or not), or null. */
export const sttAdditionNamed = (name) => find(STT_ADDITIONS, name);

/** The speech additions this server serves on a route of `priceUsd` and `maxChars`. */
export function admittedSpeechAdditions({ priceUsd, maxChars, costs = upstreamCosts(), env = process.env } = {}) {
  const on = namedAudioModelsOn(env);
  return SPEECH_ADDITIONS.filter((m) => on.has(m.id) && withinMargin(maxChars, costs?.speech?.[m.id], priceUsd));
}
/** The transcription additions this server serves on a tier of `priceUsd` and `maxMinutes`. */
export function admittedSttAdditions({ priceUsd, maxMinutes, costs = upstreamCosts(), env = process.env } = {}) {
  const on = namedAudioModelsOn(env);
  return STT_ADDITIONS.filter((m) => on.has(m.id) && withinMargin(maxMinutes, costs?.sttPerMinute?.[m.id], priceUsd));
}
