// Our data policy on every OpenRouter speech and transcription request.
//
// The account already turns off every endpoint that trains on or publishes
// prompts; this states the same posture on the request itself, so it holds
// even if an account setting is changed, and so the request log shows it.
// `data_collection: "deny"` goes on every request. `zdr: true` (zero data
// retention) goes on a model only when EVERY endpoint OpenRouter lists for it
// is a ZDR endpoint, so the flag never narrows routing or refuses a call: a
// model with any non-ZDR endpoint (the xAI voice today) answers 404 under
// zdr:true, which would end a failover walk early. The set is checked live
// against /api/v1/endpoints/zdr by scripts/test-gateway-model-ids.js, so a
// provider that loses ZDR status fails a test instead of a buyer's call.
// Neither field is a buyer input on these routes; the /v1/audio/speech
// `zdr` opt-in a buyer already had still applies on top (it can only add zdr).

export const AUDIO_ZDR_MODELS = new Set([
  "elevenlabs/scribe-v2",
  "mistralai/voxtral-mini-tts-2603",
  "hexgrad/kokoro-82m",
  "microsoft/mai-voice-2-flash",
  "microsoft/mai-voice-2",
  "elevenlabs/eleven-v4-turbo",
  "elevenlabs/eleven-turbo-v2.5",
  "elevenlabs/eleven-flash-v2.5",
  "elevenlabs/eleven-v4",
  "elevenlabs/eleven-v3",
  "elevenlabs/eleven-multilingual-v2",
]);

/** The `provider` object for one OpenRouter audio request to `model`. */
export function audioProviderPolicy(model, { zdr = false } = {}) {
  return { data_collection: "deny", ...(zdr || AUDIO_ZDR_MODELS.has(model) ? { zdr: true } : {}) };
}
