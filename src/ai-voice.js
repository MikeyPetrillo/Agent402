// AI-generated voice disclosure. The speech provider's terms ask a service
// that offers text-to-speech to tell end users clearly that the voice they
// hear is AI-generated, and to pass that duty on to its own users. Every
// speech tool (tts, tts-lite, tts-hd, v1-audio-speech with each named model
// it serves, and dub) says so before payment, in its description, and in
// every answer: a JSON answer carries `aiGeneratedVoice: true`, and a byte
// answer (the `{ __binary }` sentinel) the header `X-AI-Generated: true`.
// scripts/test-ai-voice.js holds every speech tool to it.
import { attributionTailOf } from "./data-attribution.js";

export const AI_VOICE_SENTENCE = "The voice is AI-generated; disclose that to listeners.";
export const AI_VOICE_HEADER = "X-AI-Generated";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** `answer` with the disclosure: a field on a JSON answer, a header on a byte
 *  answer; anything else (a stream writer, a non-object) unchanged. */
export function withAiVoice(answer) {
  if (!isPlain(answer)) return answer;
  if (answer.__binary) return { ...answer, headers: { ...(isPlain(answer.headers) ? answer.headers : {}), [AI_VOICE_HEADER]: "true" } };
  return Object.hasOwn(answer, "aiGeneratedVoice") ? answer : { ...answer, aiGeneratedVoice: true };
}

/** Mark each tool in `tools` whose slug is in `slugs`: the sentence in its
 *  description (before any attribution tail), the field on its published
 *  example when that is JSON, and every answer through withAiVoice.
 *  Idempotent per tool. */
export function markAiVoice(tools, slugs) {
  for (const tool of tools || []) {
    if (!slugs.includes(tool?.slug) || tool.aiGeneratedVoice === true) continue;
    tool.aiGeneratedVoice = true;
    const d = String(tool.description || "");
    if (!d.includes(AI_VOICE_SENTENCE)) {
      const tail = attributionTailOf(d);
      tool.description = tail ? `${d.slice(0, d.length - tail.length).trimEnd()} ${AI_VOICE_SENTENCE} ${tail}` : `${d.trimEnd()} ${AI_VOICE_SENTENCE}`;
    }
    const ex = tool.discovery?.output?.example;
    if (isPlain(ex) && !ex.__binary && (!tool.mimeType || /json/i.test(tool.mimeType))) tool.discovery.output.example = withAiVoice(ex);
    const inner = tool.handler;
    if (typeof inner === "function") {
      const wrapped = async function aiVoice(...args) { return withAiVoice(await inner.apply(this, args)); };
      // Keep the marks other modules set on the handler (a budget, a ceiling).
      for (const k of Object.keys(inner)) wrapped[k] = inner[k];
      Object.defineProperty(wrapped, "toString", { value: () => String(inner) });
      tool.handler = wrapped;
    }
  }
  return tools;
}
