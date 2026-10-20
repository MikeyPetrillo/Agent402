// Dub: translate a text and speak the translation in one paid call.
//
// Two steps, both existing tools called in-process (the composition pattern
// pdf-summarize-kit.js uses): the translation runs through the chat gateway's
// base tier handler (the smallest flat tier whose output cap holds a 2,000
// character translation into a dense script; the nano cap does not), with a
// fixed instruction and the tier's own default model, margin clamp and
// failover chain; the speech runs through the tts kit's handler for the tier
// asked for (its voices, formats, cap, chain and backups, unchanged). Neither
// inner call is a second payment: the buyer pays this route's price once.
//
// PRICE. The sum of the two tiers it composes, read from their tool
// definitions at module load, never typed: a tier repriced in its kit
// reprices this route with it. `tier: "hd"` composes /api/tts-hd instead of
// /api/tts, so the route carries a per-request `quote` (the gates price the
// body the handler serves) between the standard sum and the hd sum.
//
// CAP. The speech tier's character cap applies to the translated text. The
// source text is checked against that cap, with the voice and the format,
// before any model call, so a text that cannot be spoken costs nothing; a
// translation that comes out over the cap is a 422 (uncharged).
//
// FAILURE. A failed step answers 4xx/5xx naming the step, and a status of
// 400 or more is never settled (x402 settles after the handler), so a failed
// translation or a failed speech call is not charged on x402, card and credits.
//
// ANSWER. Raw audio bytes by default (Content-Type by format), with the
// translation and what served in the X-Dub-Translation header (base64 JSON).
// `json: 1` or `format: "json"` answers JSON instead, the audio base64 in it.

import { LLM_GATEWAY_TOOLS, TIERS as GATEWAY_TIERS } from "./llm-gateway-kit.js";
import { TTS_TOOLS, TTS_TIERS, VOICES, FORMATS, FORMAT_CONTENT_TYPES, ELEVENLABS_VOICES, validateInput as validateTtsInput, makeTtsHandler } from "./tts-kit.js";
import { underBudgetAll, PAYMENT_WINDOW_BUDGET_MS } from "../upstream-deadline.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// --- the two steps -----------------------------------------------------------
export const TRANSLATE_SLUG = "v1-chat";
const translateDef = LLM_GATEWAY_TOOLS.find((t) => t.slug === TRANSLATE_SLUG);
if (!translateDef) throw new Error(`dub-kit: ${TRANSLATE_SLUG} missing from LLM_GATEWAY_TOOLS - was it renamed?`);

/** The speech tier each dub tier composes. */
export const DUB_TIERS = Object.freeze({ standard: "tts", hd: "tts-hd" });
const ttsDefOf = (tier) => TTS_TOOLS.find((t) => t.slug === DUB_TIERS[tier]);
for (const tier of Object.keys(DUB_TIERS)) if (!ttsDefOf(tier)) throw new Error(`dub-kit: ${DUB_TIERS[tier]} missing from TTS_TOOLS`);

const priceUsdOf = (def) => Number(String(def.price).replace(/[^0-9.]/g, "")) || 0;
/** The price of a dub tier: the translate tier's price plus its speech tier's. */
export function dubPriceUsd(tier = "standard") {
  return Math.round((priceUsdOf(translateDef) + priceUsdOf(ttsDefOf(tier))) * 1e6) / 1e6;
}
const priceLabel = (tier) => `$${dubPriceUsd(tier).toFixed(3)}`;

// The handlers the steps call. Both may be replaced by a test.
const steps = {
  translate: translateDef.handler,
  speak: Object.fromEntries(Object.entries(DUB_TIERS).map(([tier, slug]) => [tier, makeTtsHandler(slug)])),
};
export function __setStepsForTest(next) {
  if (next?.translate) steps.translate = next.translate;
  if (next?.speak) steps.speak = { ...steps.speak, ...next.speak };
  return steps;
}

// --- languages ----------------------------------------------------------------
// A BCP-47 tag or an English language name, normalized to a canonical tag and
// its English name. Names come from the runtime's own language data
// (Intl.DisplayNames), so nothing here is a hand-kept table beyond the few
// spellings buyers use that the data does not carry.
const TAG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const names = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
const NAME_ALIASES = Object.freeze({
  "brazilian portuguese": "pt-BR", brazilian: "pt-BR", "european portuguese": "pt-PT",
  "simplified chinese": "zh-Hans", "traditional chinese": "zh-Hant", mandarin: "zh", "mandarin chinese": "zh", cantonese: "yue",
  "british english": "en-GB", "american english": "en-US", "mexican spanish": "es-MX", "latin american spanish": "es-419", castilian: "es",
  farsi: "fa", persian: "fa", tagalog: "tl", filipino: "fil", flemish: "nl-BE", "swiss german": "gsw", "norwegian bokmal": "nb",
});
let byName = null;
function nameIndex() {
  if (byName) return byName;
  byName = new Map();
  // Every two-letter code the runtime names (the ISO 639-1 set), then the
  // spellings above. A name that two codes share keeps the first (lower) code.
  for (let a = 97; a <= 122; a++) for (let b = 97; b <= 122; b++) {
    const code = String.fromCharCode(a, b);
    const name = names.of(code);
    if (name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), code);
  }
  for (const [alias, tag] of Object.entries(NAME_ALIASES)) byName.set(alias, tag);
  return byName;
}
/** `{ tag, name }` for a BCP-47 tag or an English name; null when unknown. */
export function normalizeLanguage(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (TAG_RE.test(raw)) {
    let tag;
    try { [tag] = Intl.getCanonicalLocales(raw); } catch { tag = null; }
    const name = tag ? names.of(tag) : undefined;
    if (tag && name) return { tag, name };
  }
  const tag = nameIndex().get(raw.toLowerCase().replace(/\s+/g, " "));
  return tag ? { tag, name: names.of(tag) } : null;
}

// --- the translation ------------------------------------------------------------
function instruction(target, source) {
  return `You are a professional translator. Translate the user's message into ${target.name} (${target.tag}).` +
    (source ? ` The source language is ${source.name} (${source.tag}).` : "") +
    ' Answer with a JSON object only, no prose around it: {"source": "<BCP-47 tag of the language the message is written in>", "text": "<the translation>"}.' +
    " The translation keeps the meaning, register, names, numbers and line breaks of the original and adds nothing. If the message is already in the target language, return it unchanged.";
}
/** The translation and the source tag the model reported, read leniently: a
 *  JSON answer as asked for, else the whole answer as the translation. */
export function parseTranslation(content) {
  const raw = String(content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!raw) return { translation: "", source: null };
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j.text === "string") return { translation: j.text.trim(), source: typeof j.source === "string" ? j.source : null };
    } catch { /* not the JSON asked for: the answer is the translation */ }
  }
  return { translation: raw, source: null };
}

const stepError = (step, e) => {
  const inner = Number(e?.statusCode);
  // A throttle or an unavailable upstream keeps its status (the buyer should
  // wait); anything else the step raised is answered as a bad upstream. A 4xx
  // from a step is this route's request to it, never the buyer's.
  const status = inner === 429 || inner === 503 || inner === 504 ? inner : inner === 422 ? 422 : 502;
  return Object.assign(bad(`${step === "translate" ? "Translation" : "Speech"} step failed: ${String(e?.message || e).slice(0, 300)}`, status), { step, cause: e });
};

const truthy = (v) => v === true || v === 1 || /^(1|true|yes)$/i.test(String(v ?? ""));

async function dub(input) {
  const tier = input.tier === undefined ? "standard" : String(input.tier).trim().toLowerCase();
  if (!Object.hasOwn(DUB_TIERS, tier)) throw bad(`Unknown tier "${tier}". Supported: ${Object.keys(DUB_TIERS).join(", ")}`);
  const ttsSlug = DUB_TIERS[tier];
  const cap = TTS_TIERS[ttsSlug].maxChars;

  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw bad('"text" is required - the text to translate and speak');
  const target = normalizeLanguage(input.targetLanguage);
  if (!target) throw bad('"targetLanguage" is required: a BCP-47 tag (es, pt-BR, zh-Hans) or an English language name (Spanish, Brazilian Portuguese)');
  let source = null;
  if (input.sourceLanguage !== undefined && input.sourceLanguage !== null && String(input.sourceLanguage).trim() !== "") {
    source = normalizeLanguage(input.sourceLanguage);
    if (!source) throw bad(`Unknown "sourceLanguage" "${String(input.sourceLanguage).slice(0, 40)}": a BCP-47 tag or an English language name`);
  }
  const jsonMode = truthy(input.json) || (typeof input.format === "string" && input.format.trim().toLowerCase() === "json");
  const formatIn = typeof input.format === "string" && input.format.trim().toLowerCase() !== "json" ? input.format : "mp3";
  // The speech tier's own checks on the SOURCE text, the voice and the format:
  // a text over the cap, an unknown voice or a format the tier cannot serve is
  // a 400 here, before the translation is bought.
  const { voice, format } = validateTtsInput({ text, voice: input.voice, format: formatIn }, ttsSlug);

  let completion;
  try {
    completion = await steps.translate({
      messages: [{ role: "system", content: instruction(target, source) }, { role: "user", content: text }],
      temperature: 0.2,
    });
  } catch (e) { throw stepError("translate", e); }
  const choice = completion?.choices?.[0];
  const { translation, source: reported } = parseTranslation(choice?.message?.content);
  if (!translation) throw stepError("translate", bad("the model returned no translation", 502));
  if (choice?.finish_reason === "length") throw stepError("translate", bad("the translation was cut off at the model's output limit; send a shorter text", 502));
  if (translation.length > cap) {
    throw bad(`The translation is ${translation.length} chars, over the ${cap}-char cap of the ${ttsSlug} tier; send a shorter text. Nothing was charged.`, 422);
  }
  const detected = (reported && normalizeLanguage(reported)?.tag) || source?.tag || null;

  let spoken;
  try { spoken = await steps.speak[tier]({ text: translation, voice, format }); }
  catch (e) { throw stepError("speak", e); }

  const meta = {
    translation,
    detectedSourceLanguage: detected,
    targetLanguage: target.tag,
    tier,
    voice: spoken.voice,
    model: spoken.model,
    translationModel: completion?.model || null,
    format: spoken.format,
    chars: spoken.chars,
  };
  if (jsonMode) return { ...meta, audio: spoken.audio };
  return {
    __binary: Buffer.from(spoken.audio, "base64"),
    contentType: FORMAT_CONTENT_TYPES[spoken.format] || "application/octet-stream",
    headers: { "X-Dub-Translation": Buffer.from(JSON.stringify(meta), "utf8").toString("base64") },
  };
}

const standardCap = TTS_TIERS[DUB_TIERS.standard].maxChars;
export const DUB_TOOLS = [
  {
    route: "POST /api/dub",
    name: "Dub: translate and speak",
    slug: "dub",
    aliases: ["translate-speak", "translate-and-speak", "dubbing"],
    category: "ai",
    price: priceLabel("standard"),
    // Priced by tier: the standard sum, or the hd sum when the body says tier "hd".
    quote: (body) => dubPriceUsd(body && String(body.tier ?? "").trim().toLowerCase() === "hd" ? "hd" : "standard"),
    quoteMaxUsd: dubPriceUsd("hd"),
    modelBacked: true,
    binaryTypes: [...new Set(Object.values(FORMAT_CONTENT_TYPES))],
    description:
      `Translate a text into a target language and speak the translation, in one paid call. The translation runs on the ${translateDef.route.split(" ")[1]} gateway tier and the speech on ${ttsDefOf("standard").route.split(" ")[1]} (tier "standard", ${priceLabel("standard")}) or ${ttsDefOf("hd").route.split(" ")[1]} (tier "hd", ${priceLabel("hd")}); the price is the sum of the two. Answers the audio as raw bytes (mp3, opus, aac, flac, wav or pcm) with the translation, the detected source language and the models that served in the X-Dub-Translation header (base64 JSON); add json: 1 or format "json" for a JSON answer with the audio base64 in it. targetLanguage is a BCP-47 tag or an English name. The same ten standard voice names and named voices as the speech tiers. Text capped at ${standardCap} chars, checked before any model call, and the cap applies to the translation. A failed step answers an error naming the step and is not charged. Model-backed.`,
    tags: ["dub", "translate", "translation", "tts", "text-to-speech", "speech", "audio", "voice", "localization"],
    discovery: {
      bodyType: "json",
      input: { text: "Hello from Agent402! Every tool is paid per call.", targetLanguage: "es", voice: "nova", format: "mp3", json: 1 },
      inputSchema: {
        properties: {
          text: { type: "string", description: `Text to translate and speak (max ${standardCap} chars; the cap also applies to the translation)` },
          targetLanguage: { type: "string", description: "Target language: a BCP-47 tag (es, pt-BR, zh-Hans, ja) or an English name (Spanish, Brazilian Portuguese)" },
          sourceLanguage: { type: "string", description: "Optional source language, same forms; detected when omitted" },
          voice: { type: "string", description: `Voice: ${[...VOICES].join(", ")} (default: alloy), or a named voice (${[...ELEVENLABS_VOICES].join(", ")})` },
          format: { type: "string", description: `Audio format: ${[...FORMATS].join(", ")} (default: mp3), or "json" for a JSON answer carrying the audio base64 as mp3` },
          tier: { type: "string", description: `"standard" (default, speech on ${ttsDefOf("standard").route.split(" ")[1]}) or "hd" (speech on ${ttsDefOf("hd").route.split(" ")[1]}, priced at that tier's sum)` },
          json: { type: "boolean", description: "true (or ?json=1) answers JSON with the audio base64 instead of raw bytes" },
        },
        required: ["text", "targetLanguage"],
      },
      output: {
        example: {
          translation: "Hola desde Agent402. Cada herramienta se paga por llamada.",
          detectedSourceLanguage: "en",
          targetLanguage: "es",
          tier: "standard",
          voice: "sarah",
          model: "elevenlabs/eleven-v4-turbo",
          translationModel: GATEWAY_TIERS[TRANSLATE_SLUG].defaultModel,
          format: "mp3",
          audio: "<base64-encoded audio>",
          chars: 58,
        },
      },
    },
    handler: dub,
  },
];

// The whole call, both steps, runs under the speech tiers' window
// (src/upstream-deadline.js); the speech step's reads spend what is left.
underBudgetAll(DUB_TOOLS, PAYMENT_WINDOW_BUDGET_MS);
