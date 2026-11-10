// The pre-payment check of the metered /v1 routes: a request that cannot be
// served is answered 400 BEFORE any payment gate, so the buyer is never quoted
// for it and never signs for it. One function reads every wire (OpenAI chat
// completions, Anthropic Messages, OpenAI Responses, Google generateContent):
// the model id against the upstream's live list (meteredModelVerdict), then
// the input against the model's character cap. A wire differs only in the
// three things its row below names: where its model id is, how its input is
// counted (each wire's own validation is the counter), and the error object
// its SDKs parse. server.js mounts the check ahead of the gates and records
// every refusal through one recorder (src/prepayment-refusal.js).
//
// It refuses nothing the handler would serve: both verdicts are the ones the
// handler's own validation throws, read earlier. It fails open (no fresh
// model list, a body another rule refuses, a throw): the gates and the
// handler then answer as they always have.
import { canonicalModel, meteredModelVerdict, meteredInputSizeRefusal } from "./tools/llm-gateway-kit.js";
import { meteredMessagesInputSizeRefusal } from "./tools/llm-messages-kit.js";
import { meteredResponsesInputSizeRefusal } from "./tools/llm-responses-kit.js";
import { meteredGeminiInputSizeRefusal, modelOf as geminiModelOf } from "./tools/llm-gemini-kit.js";
import { toolErrorFields } from "./tool-error-fields.js";

const TYPE = "invalid_request_error";
// OpenAI's error object (chat completions and Responses).
const openAiError = (code, message, fields) => ({ error: { message, type: TYPE, code, ...fields } });
// Anthropic's error envelope (Messages).
const anthropicError = (code, message, fields) => ({ type: "error", error: { type: TYPE, message, code, ...fields } });
// Google's error object (generateContent): a numeric code and a status word.
const googleError = (code, message, fields) => ({ error: { code: 400, message, status: "INVALID_ARGUMENT", reason: code, ...fields } });
const namedModel = (input) => canonicalModel(input?.model);

/** Catalog slug -> how that wire is read. Adding a metered wire is one row. */
export const PRE_PAYMENT_WIRES = Object.freeze({
  "v1-chat-metered": { modelOf: namedModel, sizeRefusal: meteredInputSizeRefusal, errorBody: openAiError },
  "v1-chat-metered-messages": { modelOf: namedModel, sizeRefusal: meteredMessagesInputSizeRefusal, errorBody: anthropicError },
  "v1-chat-metered-responses": { modelOf: namedModel, sizeRefusal: meteredResponsesInputSizeRefusal, errorBody: openAiError },
  // The Google-shaped path folds its model into the body before any gate.
  "v1-chat-metered-gemini": { modelOf: (input) => (input?.model ? geminiModelOf(input, "v1-chat-metered") : ""), sizeRefusal: meteredGeminiInputSizeRefusal, errorBody: googleError },
});

/**
 * The refusal for a metered body on the route `slug`, or null (servable, a
 * route this check does not read, or a body another rule refuses).
 * `{ status: 400, code, message, fields, suggestions, body }`: `fields` are
 * the machine-readable fields that ride on the answer (suggestions, and for
 * a size refusal maxInputChars, inputChars and hint), `body` the wire's own
 * error object carrying them. May throw on a body it cannot read; the caller
 * treats that as no refusal.
 */
export function meteredPrePaymentRefusal(slug, input) {
  const wire = Object.hasOwn(PRE_PAYMENT_WIRES, slug) ? PRE_PAYMENT_WIRES[slug] : null;
  if (!wire || !input || typeof input !== "object") return null;
  const refusal = (code, message, fields) => ({ status: 400, code, message, fields, suggestions: fields.suggestions || [], body: wire.errorBody(code, message, fields) });
  // An id the live list does not carry: named, with the closest served ids.
  const model = wire.modelOf(input);
  const verdict = model ? meteredModelVerdict(model) : null;
  if (verdict) return refusal("unknown_model", verdict.message, verdict.suggestions?.length ? { suggestions: verdict.suggestions } : {});
  // An input over the model's character cap: the cap, the size read and
  // models whose window takes it.
  const tooLarge = wire.sizeRefusal(input);
  if (tooLarge) return refusal("input_too_large", tooLarge.message, toolErrorFields(tooLarge));
  return null;
}
