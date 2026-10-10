// Microsoft Decision-1 over OpenRouter: the second typed-judgment backend.
//
// The request and answer are the TypeSafe System One shapes (state plus typed
// questions in; answers keyed by question id out, with the same noul, choice
// and score kinds), so a Jev body is sent here with only `model` changed and a
// Decision-1 answer is read by the same code that reads Jev's. The endpoint is
// labeled alpha upstream; the model shipped 2026-10-09.
//
// Enabled when OPENROUTER_API_KEY is set and DECISION_ONE is not "off".
// Model-backed: an answer is a model's judgment, not a computed value.
import { OPENROUTER_ATTRIBUTION } from "./openrouter-attribution.js";

export const DECISION_ONE_MODEL = "microsoft/microsoft-decision-1";
const ENDPOINT = () => (process.env.DECISION_ONE_URL || "https://openrouter.ai/api/alpha/decisions").trim();
const keyOf = () => (process.env.OPENROUTER_API_KEY || "").trim();
const TIMEOUT_MS = 25_000;

export const decisionOneEnabled = (apiKey = keyOf()) =>
  !!String(apiKey || "").trim() && String(process.env.DECISION_ONE || "").trim().toLowerCase() !== "off";

const fail = (msg, statusCode, mayBeBilled = false) => {
  const e = new Error(msg);
  e.statusCode = statusCode;
  if (mayBeBilled) e.mayBeBilled = true;
  return e;
};

/** Post a Jev-shaped body to Decision-1. Resolves to the parsed answer when it
 *  carries an `answers` object; otherwise throws an Error with `statusCode`
 *  (the same classes as judge-kit's post()), and `mayBeBilled` when the call
 *  may have been billed (a timeout, or a 200 we could not use). The upstream
 *  body is never relayed: it can echo the caller's own state back. */
export async function askDecisionOne(body, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, apiKey = keyOf() } = {}) {
  if (!decisionOneEnabled(apiKey)) throw fail("Decision-1 is not configured on this server.", 503);
  let res;
  try {
    res = await fetchImpl(ENDPOINT(), {
      method: "POST",
      headers: { ...OPENROUTER_ATTRIBUTION, authorization: `Bearer ${String(apiKey).trim()}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, model: DECISION_ONE_MODEL }),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
  } catch (err) {
    // A timed-out call may still have been billed upstream; a refused
    // connection was not.
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw fail(timedOut ? "Judgment upstream timed out." : "Judgment upstream is unreachable.", timedOut ? 504 : 502, timedOut);
  }
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw fail("Judgment upstream rejected our credentials.", 503);
    if (res.status === 402) throw fail("Judgment upstream is unavailable.", 503);
    if (res.status === 429) throw fail("Judgment upstream is rate limiting. Retry shortly.", 503);
    if (res.status >= 400 && res.status < 500) throw fail(`Judgment upstream refused the request (${res.status}). Check the question shapes against /v1/judge's schema.`, 400);
    throw fail(`Judgment upstream returned ${res.status}.`, 502);
  }
  // From here the upstream answered 200 and billed the call.
  let j; try { j = JSON.parse(text); } catch { throw fail("Judgment upstream returned an unreadable body.", 502, true); }
  if (!j?.answers || typeof j.answers !== "object" || Array.isArray(j.answers)) throw fail("Judgment upstream returned no answers.", 502, true);
  return j;
}
