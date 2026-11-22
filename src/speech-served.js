// Which model spoke a speech answer.
//
// Every speech answer (POST /v1/audio/speech, /api/tts, /api/tts-lite,
// /api/tts-hd) names the model that produced it in X-Agent402-Model. A call
// that named a model in `model` and was served by another (the named model
// failed in a way that let the walk go on, and a chain link answered) also
// carries X-Agent402-Model-Fallback: 1, so a buyer can tell without reading
// the audio. Both are answer headers (src/answer-headers.js): a call that
// ends 400 or above sends neither.
//
// One log line per served call names the route, the model asked for (null:
// none named) and the model that served. No payer, input or answer.
import { setAnswerHeader } from "./answer-headers.js";

export const SERVED_MODEL_HEADER = "X-Agent402-Model";
export const MODEL_FALLBACK_HEADER = "X-Agent402-Model-Fallback";

/** The answer headers for a served speech call. */
export function servedModelHeaders({ requested = null, served }) {
  const out = { [SERVED_MODEL_HEADER]: String(served) };
  if (requested && requested !== served) out[MODEL_FALLBACK_HEADER] = "1";
  return out;
}

/** The structured log line of a served speech call. */
export function logSpeechServed({ route, requested = null, served }) {
  try {
    console.log(`[speech-served] ${JSON.stringify({ route: String(route), requested: requested ? String(requested) : null, served: String(served), fallback: Boolean(requested && requested !== served) })}`);
  } catch { /* a log line never fails a served answer */ }
}

/** Set the served-model headers on a JSON answer's response, where the
 *  handler runs inside a route call (req.res is Express's own link). */
export function setServedModelHeaders(req, served, requested = null) {
  const res = req && typeof req === "object" ? req.res : null;
  if (!res || typeof res.setHeader !== "function" || res.headersSent) return;
  for (const [k, v] of Object.entries(servedModelHeaders({ requested, served }))) setAnswerHeader(req, res, k, v);
}
