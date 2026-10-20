#!/usr/bin/env node
// /api/dub (src/tools/dub-kit.js): translate, then speak, one paid call.
// Offline: both steps are stubbed handlers installed through the kit's test
// seam, so this pins the composition, not the upstreams (those have their own
// suites: test-llm-gateway, test-tts-elevenlabs).
//
// What it pins:
//   - the price is the SUM of the two tiers it composes, read from their tool
//     definitions (standard and hd), and the per-request quote follows `tier`;
//   - the happy path: raw audio bytes typed by format, the translation and what
//     served in X-Dub-Translation (base64 JSON), and the same facts as JSON
//     when the call says json: 1 or format "json";
//   - a failed translation or a failed speech call is a 5xx naming the step
//     (uncharged: settlement never runs for a status of 400 or more), a
//     throttle keeps its status, and the speech step never runs after a
//     failed translation;
//   - a text over the speech cap, an unknown voice or a missing target
//     language is a 400 before ANY step runs, and a translation that comes
//     out over the cap is a 422 before the speech step;
//   - language forms: BCP-47 tags (any case) and English names normalize to
//     one canonical tag; unknown ones are refused;
//   - the lists a wallet-only, metered, slow route must be on;
//   - with the private cost table: each tier's worst case (the chat tier's
//     bound for a translation at the cap, plus every speech link at the cap)
//     stays within MARGIN of the summed price.
import { DUB_TOOLS, DUB_TIERS, TRANSLATE_SLUG, dubPriceUsd, normalizeLanguage, parseTranslation, __setStepsForTest } from "../src/tools/dub-kit.js";
import { TTS_TOOLS, TTS_TIERS, FORMAT_CONTENT_TYPES } from "../src/tools/tts-kit.js";
import { LLM_GATEWAY_TOOLS, TIERS, MARGIN, validateRequest, worstCaseUpstreamCost } from "../src/tools/llm-gateway-kit.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";
import { METERED_SLUGS } from "../src/metered-slugs.js";
import { SLOW_TOOL_SECONDS } from "../src/avm-validity.js";
import { upstreamCosts, upstreamCostsLoaded, upstreamCostsGaps } from "../src/upstream-costs.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const throwsWith = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const priceOf = (def) => Number(String(def.price).replace(/[^0-9.]/g, ""));

const dub = DUB_TOOLS[0];
const translateDef = LLM_GATEWAY_TOOLS.find((t) => t.slug === TRANSLATE_SLUG);
const ttsOf = (tier) => TTS_TOOLS.find((t) => t.slug === DUB_TIERS[tier]);

// --- the steps, stubbed -------------------------------------------------------
const calls = [];
const TRANSLATION = "Hola desde Agent402. Cada herramienta se paga por llamada.";
let translateAnswer = () => ({ model: "stub/translator", choices: [{ message: { content: JSON.stringify({ source: "en", text: TRANSLATION }) }, finish_reason: "stop" }] });
const speakStub = (slug) => async (input) => {
  calls.push(["speak", slug, input]);
  return { model: `stub/${slug}`, provider: "openrouter", voice: "sarah", format: input.format, audio: Buffer.from(`ID3${slug}`).toString("base64"), chars: input.text.length };
};
__setStepsForTest({
  translate: async (body) => { calls.push(["translate", body]); return translateAnswer(body); },
  speak: { standard: speakStub("tts"), hd: speakStub("tts-hd") },
});
const run = async (input) => { calls.length = 0; return dub.handler(input); };
const header = (r) => JSON.parse(Buffer.from(r.headers["X-Dub-Translation"], "base64").toString("utf8"));

// --- the price is the sum, derived ----------------------------------------------
{
  const standard = priceOf(translateDef) + priceOf(ttsOf("standard"));
  const hd = priceOf(translateDef) + priceOf(ttsOf("hd"));
  ok(Math.abs(dubPriceUsd("standard") - standard) < 1e-9 && Math.abs(dubPriceUsd("hd") - hd) < 1e-9, `the tier sums read the two tool definitions (${TRANSLATE_SLUG} + ${DUB_TIERS.standard}, ${TRANSLATE_SLUG} + ${DUB_TIERS.hd})`);
  ok(priceOf(dub) === dubPriceUsd("standard"), "the catalog price is the standard sum");
  ok(dub.quote({}) === dubPriceUsd("standard") && dub.quote({ tier: "standard" }) === dubPriceUsd("standard"), "the quote for a body without a tier, or tier standard, is the standard sum");
  ok(dub.quote({ tier: "hd" }) === dubPriceUsd("hd") && dub.quote({ tier: " HD " }) === dubPriceUsd("hd"), "the quote for tier hd is the hd sum");
  ok(dub.quoteMaxUsd === dubPriceUsd("hd") && dubPriceUsd("hd") > dubPriceUsd("standard"), "the quote ceiling is the hd sum");
  ok(dub.description.includes(`$${dubPriceUsd("standard").toFixed(3)}`) && dub.description.includes(`$${dubPriceUsd("hd").toFixed(3)}`), "the description quotes both derived sums");
  ok(dub.modelBacked === true && dub.binaryTypes.includes("audio/mpeg"), "model-backed, and declares its audio media types");
  ok(TIERS[TRANSLATE_SLUG].maxTokens >= Math.ceil(TTS_TIERS[DUB_TIERS.hd].maxChars * 0.9), `the translate tier's output cap (${TIERS[TRANSLATE_SLUG].maxTokens} tokens) holds a translation at the speech cap (${TTS_TIERS[DUB_TIERS.hd].maxChars} chars)`);
}

// --- the happy path: raw bytes with the header ------------------------------------
{
  const text = "Hello from Agent402! Every tool is paid per call.";
  const r = await run({ text, targetLanguage: "es", voice: "nova", format: "mp3" });
  ok(Buffer.isBuffer(r.__binary) && r.__binary.toString() === "ID3tts" && r.contentType === FORMAT_CONTENT_TYPES.mp3, "answers the speech step's bytes, typed by format");
  ok(calls.map((c) => c[0]).join(">") === "translate>speak" && calls[1][1] === "tts", "translate runs first, then the standard speech tier");
  const body = calls[0][1];
  ok(body.messages?.[0]?.role === "system" && /Spanish \(es\)/.test(body.messages[0].content) && body.messages[1]?.content === text, "the translation request carries the fixed instruction naming the target and the text as the user message");
  ok(!("model" in body), "the translate tier's own default model serves (no model named)");
  const spoke = calls[1][2];
  ok(spoke.text === TRANSLATION && spoke.voice === "nova" && spoke.format === "mp3", "the speech step gets the translation, the voice and the format asked for");
  const h = header(r);
  ok(h.translation === TRANSLATION && h.detectedSourceLanguage === "en" && h.targetLanguage === "es", "X-Dub-Translation carries the translation and both languages");
  ok(h.voice === "sarah" && h.model === "stub/tts" && h.translationModel === "stub/translator" && h.chars === TRANSLATION.length && h.tier === "standard" && h.format === "mp3", "and names what served, with the characters spoken");
  const flac = await run({ text, targetLanguage: "es", format: "flac" });
  ok(flac.contentType === FORMAT_CONTENT_TYPES.flac && calls[1][2].format === "flac", "another format is passed through and typed");
}

// --- json mode ---------------------------------------------------------------------
{
  const text = "Hello from Agent402!";
  const r = await run({ text, targetLanguage: "Spanish", json: "1" });
  ok(!r.__binary && r.audio === Buffer.from("ID3tts").toString("base64") && r.translation === TRANSLATION && r.format === "mp3", "json: 1 (a query string value) answers JSON with the audio base64");
  const keys = (o) => Object.keys(o).sort().join(",");
  ok(keys(r) === keys(dub.discovery.output.example), `the JSON answer has the documented fields (${keys(r)})`);
  const f = await run({ text, targetLanguage: "es", format: "json" });
  ok(!f.__binary && f.format === "mp3" && calls[1][2].format === "mp3" && typeof f.audio === "string", 'format "json" answers JSON with the audio as mp3');
  const b = await run({ text, targetLanguage: "es", json: true });
  ok(!b.__binary && b.detectedSourceLanguage === "en", "json: true (a JSON body value) works the same");
  const ex = await run(dub.discovery.input);
  ok(!ex.__binary && ex.translation === TRANSLATION, "the published example asks for the JSON answer the example output shows");
}

// --- the hd tier -------------------------------------------------------------------
{
  const r = await run({ text: "hi", targetLanguage: "fr", tier: "hd" });
  ok(calls[1][1] === "tts-hd" && header(r).tier === "hd" && header(r).model === "stub/tts-hd", "tier hd speaks on the hd speech tier");
  const e = await throwsWith(() => run({ text: "hi", targetLanguage: "fr", tier: "ultra" }));
  ok(e?.statusCode === 400 && calls.length === 0, "an unknown tier is a 400 before any step");
}

// --- a failed translation is uncharged, and the speech step never runs --------------
{
  const saved = translateAnswer;
  translateAnswer = () => { throw Object.assign(new Error("upstream fell over"), { statusCode: 500 }); };
  let e = await throwsWith(() => run({ text: "hi", targetLanguage: "de" }));
  ok(e?.statusCode === 502 && e.step === "translate" && /^Translation step failed: upstream fell over/.test(e.message), "a translation failure is a 502 naming the step");
  ok(calls.length === 1 && calls[0][0] === "translate", "and the speech step does not run");
  translateAnswer = () => { throw Object.assign(new Error("rate-limited"), { statusCode: 429 }); };
  e = await throwsWith(() => run({ text: "hi", targetLanguage: "de" }));
  ok(e?.statusCode === 429 && e.step === "translate", "a throttle keeps its 429");
  translateAnswer = () => { throw Object.assign(new Error("bad body"), { statusCode: 400 }); };
  e = await throwsWith(() => run({ text: "hi", targetLanguage: "de" }));
  ok(e?.statusCode === 502, "a 400 the step raised is this route's fault, answered as a 502, never the buyer's");
  translateAnswer = () => ({ model: "stub/translator", choices: [{ message: { content: "   " }, finish_reason: "stop" }] });
  e = await throwsWith(() => run({ text: "hi", targetLanguage: "de" }));
  ok(e?.statusCode === 502 && e.step === "translate" && calls.length === 1, "an empty translation is a 502 with no speech call");
  translateAnswer = () => ({ model: "stub/translator", choices: [{ message: { content: '{"source":"en","text":"Hal' }, finish_reason: "length" }] });
  e = await throwsWith(() => run({ text: "hi", targetLanguage: "de" }));
  ok(e?.statusCode === 502 && /cut off/.test(e.message) && calls.length === 1, "a translation cut off at the output limit is a 502 with no speech call");
  translateAnswer = saved;
}

// --- a failed speech call is uncharged -------------------------------------------
{
  __setStepsForTest({ speak: { standard: async (i) => { calls.push(["speak", "tts", i]); throw Object.assign(new Error("Speech upstream error (HTTP 503) - retry shortly"), { statusCode: 502, outage: true }); } } });
  let e = await throwsWith(() => run({ text: "hi", targetLanguage: "de" }));
  ok(e?.statusCode === 502 && e.step === "speak" && /^Speech step failed: Speech upstream error/.test(e.message), "a speech failure is a 502 naming the step");
  ok(calls.map((c) => c[0]).join(">") === "translate>speak", "after one translation (one spend, bounded by that tier)");
  __setStepsForTest({ speak: { standard: async (i) => { calls.push(["speak", "tts", i]); throw Object.assign(new Error("Speech upstream rate-limited - retry shortly"), { statusCode: 503 }); } } });
  e = await throwsWith(() => run({ text: "hi", targetLanguage: "de" }));
  ok(e?.statusCode === 503 && e.step === "speak", "an unavailable speech upstream keeps its 503");
  __setStepsForTest({ speak: { standard: speakStub("tts") } });
}

// --- refusals before any step ------------------------------------------------------
{
  const cap = TTS_TIERS[DUB_TIERS.standard].maxChars;
  let e = await throwsWith(() => run({ text: "x".repeat(cap + 1), targetLanguage: "es" }));
  ok(e?.statusCode === 400 && /Text too long/.test(e.message) && calls.length === 0, `${cap + 1} chars is refused before any step`);
  const atCap = await run({ text: "x".repeat(cap), targetLanguage: "es" });
  ok(Buffer.isBuffer(atCap.__binary), `${cap} chars is served`);
  e = await throwsWith(() => run({ text: "hi", targetLanguage: "es", voice: "kermit" }));
  ok(e?.statusCode === 400 && /Unknown voice/.test(e.message) && calls.length === 0, "an unknown voice is refused before any step");
  e = await throwsWith(() => run({ text: "hi", targetLanguage: "es", format: "ogg" }));
  ok(e?.statusCode === 400 && /Unknown format/.test(e.message) && calls.length === 0, "an unknown format is refused before any step");
  e = await throwsWith(() => run({ text: "hi" }));
  ok(e?.statusCode === 400 && /targetLanguage/.test(e.message) && calls.length === 0, "a missing target language is refused before any step");
  e = await throwsWith(() => run({ text: "hi", targetLanguage: "Klingon" }));
  ok(e?.statusCode === 400 && /targetLanguage/.test(e.message) && calls.length === 0, "an unknown target language is refused before any step");
  e = await throwsWith(() => run({ text: "hi", targetLanguage: "es", sourceLanguage: "zz-ZZ" }));
  ok(e?.statusCode === 400 && /sourceLanguage/.test(e.message) && calls.length === 0, "an unknown source language is refused before any step");
  e = await throwsWith(() => run({ text: "   ", targetLanguage: "es" }));
  ok(e?.statusCode === 400 && calls.length === 0, "an empty text is refused before any step");
  // The cap applies to the translation: one that comes out over it ends before the speech step.
  const saved = translateAnswer;
  translateAnswer = () => ({ model: "stub/translator", choices: [{ message: { content: JSON.stringify({ source: "en", text: "y".repeat(cap + 1) }) }, finish_reason: "stop" }] });
  e = await throwsWith(() => run({ text: "hi", targetLanguage: "es" }));
  ok(e?.statusCode === 422 && /over the \d+-char cap/.test(e.message) && calls.length === 1, "a translation over the cap is a 422 with no speech call");
  translateAnswer = saved;
}

// --- language normalization --------------------------------------------------------
{
  const tag = (v) => normalizeLanguage(v)?.tag ?? null;
  ok(tag("es") === "es" && tag("ES") === "es" && tag("pt-br") === "pt-BR" && tag("zh-hans") === "zh-Hans", "tags canonicalize in any case");
  ok(tag("Spanish") === "es" && tag("spanish") === "es" && tag("Japanese") === "ja" && tag("German") === "de", "English names resolve to their tag");
  ok(tag("Brazilian Portuguese") === "pt-BR" && tag("Simplified Chinese") === "zh-Hans" && tag("Mandarin") === "zh" && tag("Farsi") === "fa", "the common spellings the runtime data lacks resolve too");
  ok(tag("xx") === null && tag("Klingon") === null && tag("") === null && tag(undefined) === null && tag("en us") === null, "unknown tags, names and blanks are null");
  ok(normalizeLanguage("fr").name === "French" && normalizeLanguage("pt-BR").name === "Brazilian Portuguese", "and carry the English name the instruction uses");
  const r = await run({ text: "hi", targetLanguage: "Japanese", sourceLanguage: "French" });
  ok(/Japanese \(ja\)/.test(calls[0][1].messages[0].content) && /French \(fr\)/.test(calls[0][1].messages[0].content) && header(r).targetLanguage === "ja", "the instruction names both languages by name and tag, and the answer carries the canonical target");
  const saved = translateAnswer;
  translateAnswer = () => ({ model: "stub/translator", choices: [{ message: { content: "Bonjour" }, finish_reason: "stop" }] });
  const plain = await run({ text: "hi", targetLanguage: "fr", sourceLanguage: "en-US" });
  ok(header(plain).translation === "Bonjour" && header(plain).detectedSourceLanguage === "en-US", "a plain-text answer is the translation, and the source given stands in for one the model did not report");
  const none = await run({ text: "hi", targetLanguage: "fr" });
  ok(header(none).detectedSourceLanguage === null, "with no source given and none reported, the detected source is null");
  translateAnswer = () => ({ model: "stub/translator", choices: [{ message: { content: '{"source":"Klingon","text":"Bonjour"}' }, finish_reason: "stop" }] });
  const odd = await run({ text: "hi", targetLanguage: "fr" });
  ok(header(odd).detectedSourceLanguage === null && header(odd).translation === "Bonjour", "a source the model reported that is no language is dropped, never echoed");
  translateAnswer = saved;
}

// --- parseTranslation --------------------------------------------------------------
{
  ok(parseTranslation('```json\n{"source":"en","text":"Hola"}\n```').translation === "Hola" && parseTranslation('```json\n{"source":"en","text":"Hola"}\n```').source === "en", "a fenced JSON answer is read");
  ok(parseTranslation("Hola, mundo.").translation === "Hola, mundo." && parseTranslation("Hola, mundo.").source === null, "a plain answer is the translation");
  ok(parseTranslation('{"translation":"Hola"}').translation === '{"translation":"Hola"}', "JSON without the text field is kept whole rather than read as empty");
  ok(parseTranslation("").translation === "" && parseTranslation(null).translation === "", "nothing is nothing");
}

// --- the lists a wallet-only, metered, slow route is on ---------------------------
{
  ok(WALLET_ONLY_SLUGS.has("dub"), "wallet-only (no proof-of-work tier)");
  ok(METERED_SLUGS.has("dub"), "excluded from the catalog sweeps as metered");
  ok(SLOW_TOOL_SECONDS.dub >= SLOW_TOOL_SECONDS.tts, "the Algorand validity floor is at least the speech tier's");
  ok(dub.handler.__underBudget === true, "the handler runs under a budget");
}

// --- the money bound, with the private table -------------------------------------
{
  const gaps = upstreamCostsLoaded() ? upstreamCostsGaps() : null;
  if (gaps && !gaps.length) {
    const cap = TTS_TIERS[DUB_TIERS.hd].maxChars;
    const body = validateRequest({ messages: [{ role: "system", content: "x".repeat(600) }, { role: "user", content: "y".repeat(cap) }], temperature: 0.2 }, TRANSLATE_SLUG);
    const translateWorst = worstCaseUpstreamCost(body, TIERS[TRANSLATE_SLUG]).totalUsd;
    ok(translateWorst <= priceOf(translateDef) * MARGIN + 1e-12, `a translation at the cap stays within the translate tier's own bound (${TRANSLATE_SLUG})`);
    for (const tier of Object.keys(DUB_TIERS)) {
      const t = TTS_TIERS[DUB_TIERS[tier]];
      const rows = t.chain.map((m) => upstreamCosts().speech?.[m]);
      ok(rows.every((r) => Number.isFinite(r) && r > 0), `${tier}: a private per-char row exists for every speech link`);
      const speechWorst = Math.max(...rows) * t.maxChars;
      ok(translateWorst + speechWorst <= dubPriceUsd(tier) * MARGIN + 1e-12, `${tier}: translation plus ${t.maxChars} chars on the dearest speech link stays within ${MARGIN * 100}% of the summed price`);
    }
  } else if (process.env.CI && process.env.UPSTREAM_COSTS_OPTIONAL !== "1") {
    ok(false, `the private upstream-cost table is ${gaps ? `incomplete (missing: ${gaps.join(", ")})` : "not loaded"}; the margin bound was not checked`);
  } else {
    console.log(`SKIP - margin bound: the private upstream-cost table is ${gaps ? "incomplete" : "not loaded"} (set UPSTREAM_COSTS_FILE)`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
