// The machine-readable AI-generated mark (EU AI Act Art. 50(2): output of a
// system that generates synthetic audio, image, video or text is marked in a
// machine-readable, detectable way). Every model-backed tool's answer carries
// it, in one form per answer shape:
//   - the response header `X-AI-Generated: true`, on every answer of a
//     model-backed route (JSON, bytes and streams alike; server.js
//     markAiAnswer, recorded as an answer header so a refused payment sends
//     none of it). It is the same header the speech tools already send on
//     audio (src/ai-voice.js AI_VOICE_HEADER), so a reader checks one name;
//   - the field `aiGenerated: true` on a JSON object answer, except on the
//     `/v1` wire routes, whose body is a provider's published format (chat
//     completions, Messages, embeddings and the like) and carries the header
//     only;
//   - a byte answer (an image, audio, video) also gets the header in its own
//     headers, and its bytes are passed through as the model returned them:
//     nothing here re-encodes, so content credentials an upstream embeds
//     (C2PA manifests, watermarks) arrive untouched.
// scripts/test-ai-generated.js holds every model-backed tool to it.
import { AI_VOICE_HEADER } from "./ai-voice.js";

export const AI_GENERATED_HEADER = AI_VOICE_HEADER; // "X-AI-Generated"
export const AI_GENERATED_FIELD = "aiGenerated";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** A route whose JSON body is a provider's wire format: header only. */
export function isWireRoute(route) { return /^(GET|POST|PUT|DELETE|PATCH)?\s*\/v1(\/|$)/.test(String(route || "")); }

/** `answer` with the mark: the field on a JSON object (not on a wire route),
 *  the header on a byte answer; anything else (a stream writer, a list, a
 *  non-object) unchanged. Never touches the bytes. */
export function withAiGenerated(answer, { wire = false } = {}) {
  if (!isPlain(answer) || typeof answer.__sse === "function") return answer;
  if (answer.__binary) return { ...answer, headers: { ...(isPlain(answer.headers) ? answer.headers : {}), [AI_GENERATED_HEADER]: "true" } };
  if (wire || Object.hasOwn(answer, AI_GENERATED_FIELD)) return answer;
  return { ...answer, [AI_GENERATED_FIELD]: true };
}

/** Mark every tool in `defs` that is model-backed: its handler's answers and
 *  its published JSON example. Idempotent per tool. */
export function markAiGenerated(defs) {
  for (const def of defs || []) {
    if (!def || def.modelBacked !== true || def.aiGenerated === true) continue;
    def.aiGenerated = true;
    const wire = isWireRoute(def.route);
    const ex = def.discovery?.output?.example;
    if (!wire && isPlain(ex) && !ex.__binary && (!def.mimeType || /json/i.test(def.mimeType))) def.discovery.output.example = withAiGenerated(ex);
    const inner = def.handler;
    if (typeof inner === "function") {
      const wrapped = async function aiGenerated(...args) { return withAiGenerated(await inner.apply(this, args), { wire }); };
      // Keep the marks other modules set on the handler (a budget, a ceiling).
      for (const k of Object.keys(inner)) wrapped[k] = inner[k];
      Object.defineProperty(wrapped, "toString", { value: () => String(inner) });
      def.handler = wrapped;
    }
  }
  return defs;
}
