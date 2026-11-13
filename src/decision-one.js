// Microsoft Decision-1 over OpenRouter: the second typed-judgment backend.
// The same client also asks Gemini Decision-1 and Jev itself (by OpenRouter's
// id for the pinned TypeSafe version) on that one endpoint: `model` picks.
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
import { upstreamFetch, bodyUnderDeadline, attributed, ATTRIBUTION, KIND } from "./upstream-deadline.js";

export const DECISION_ONE_MODEL = "microsoft/microsoft-decision-1";
// Google's decisions model (2026-11-11), the same wire. Its input list also
// names audio, video and PDF; this client sends the Jev text body only.
export const GEMINI_DECISION_MODEL = "google/gemini-decision-1";
/** OpenRouter's id for a pinned TypeSafe Jev version ("jev-1.14.0" ->
 *  "typesafe/jev-1.14"), or null when the pin names no released version (a
 *  patch release is not listed there, so it is never mapped to its minor). */
export function jevOpenRouterModel(pinned) {
  const m = /^jev-(\d{1,3})\.(\d{1,3})\.0$/.exec(String(pinned || "").trim());
  return m ? `typesafe/jev-${m[1]}.${m[2]}` : null;
}
const JEV_OPENROUTER_ID = /^typesafe\/jev-\d{1,3}\.\d{1,3}$/;
// Each model has its own off switch; any other model id is refused unsent.
const switchOf = (model) => (model === DECISION_ONE_MODEL ? "DECISION_ONE" : model === GEMINI_DECISION_MODEL ? "GEMINI_DECISION" : JEV_OPENROUTER_ID.test(String(model)) ? "JEV_OPENROUTER" : null);
const labelOf = (model) => (model === DECISION_ONE_MODEL ? "Decision-1" : model === GEMINI_DECISION_MODEL ? "Gemini Decision-1" : "Jev on OpenRouter");
// Our data policy on every Decisions request. OpenRouter's Decisions body
// takes the same `provider` preferences as chat (DecisionsRequest.provider,
// read 2026-11-12), so the request states the account's posture itself:
// data_collection "deny" always, and zdr:true only for a model whose every
// endpoint is a zero-data-retention endpoint, so the flag never narrows
// routing or refuses a call (the same rule as src/openrouter-audio-policy.js).
// Decision-1 and TypeSafe's Jev endpoints are ZDR; Gemini Decision-1's is
// not. scripts/test-gateway-model-ids.js checks the set live.
export const DECISIONS_ZDR_MODELS = Object.freeze([DECISION_ONE_MODEL]);
const zdrModel = (model) => DECISIONS_ZDR_MODELS.includes(model) || JEV_OPENROUTER_ID.test(String(model));
/** The `provider` object a Decisions request to `model` carries. */
export function decisionsProviderPolicy(model) {
  return { data_collection: "deny", ...(zdrModel(model) ? { zdr: true } : {}) };
}
/** The exact body sent for `body` to `model` (the caller's body, `model`
 *  set, our provider policy); its byte length is every caller's estimate. */
export function decisionsPayload(body, model) {
  return JSON.stringify({ ...body, model, provider: decisionsProviderPolicy(model) });
}
export const decisionsRequestBytes = (body, model) => Buffer.byteLength(decisionsPayload(body, model));
const ENDPOINT = () => (process.env.DECISION_ONE_URL || "https://openrouter.ai/api/alpha/decisions").trim();
const keyOf = () => (process.env.OPENROUTER_API_KEY || "").trim();
// DEADLINES (src/upstream-deadline.js): the one read runs under its own cap
// and the caller's handler budget (judge-kit walks up to three backends under
// one budget); a read that outlives it is a 503 naming the step, never a 504.
export const DECISION_ONE_READ_MS = 25_000;
const TIMEOUT_MS = DECISION_ONE_READ_MS;
// The spend bound for every caller, paid route and internal judges alike. A
// token can be one byte, so the bytes sent are the worst-case input tokens:
// one call is capped at DECISION_ONE_MAX_BODY_BYTES, and a UTC day's calls at
// DECISION_ONE_DAILY_MAX_BYTES. Past either the call is refused before it is
// sent (a 503, so a paid caller is not charged and an internal judge skips).
// The day's bytes are one count for every model this client asks.
const maxBodyBytes = () => Number(process.env.DECISION_ONE_MAX_BODY_BYTES) || 32_000;
const dailyMaxBytes = () => Number(process.env.DECISION_ONE_DAILY_MAX_BYTES) || 50_000_000;
const spend = { day: "", bytes: 0 };
function bookBytes(n) {
  const day = new Date().toISOString().slice(0, 10);
  if (spend.day !== day) { spend.day = day; spend.bytes = 0; }
  if (spend.bytes + n > dailyMaxBytes()) return false;
  spend.bytes += n;
  return true;
}
export function _decisionOneSpendReset() { spend.day = ""; spend.bytes = 0; }

/** The OpenRouter key is set and `model`'s own switch (DECISION_ONE,
 *  GEMINI_DECISION, JEV_OPENROUTER) is not "off". */
export function openRouterDecisionsEnabled(model, apiKey = keyOf()) {
  const sw = switchOf(model);
  return !!sw && !!String(apiKey || "").trim() && String(process.env[sw] || "").trim().toLowerCase() !== "off";
}
export const decisionOneEnabled = (apiKey = keyOf()) => openRouterDecisionsEnabled(DECISION_ONE_MODEL, apiKey);

/** Our own key refused, or our own balance with the provider spent: ours,
 *  never the caller's input, and never the provider's outage. */
export const JUDGMENT_KEY_REFUSED = "Judgment is unavailable right now: the judgment provider refused this server's key. This is on our side, not your input; nothing was charged. Retry later.";
export const JUDGMENT_BALANCE_OUT = "Judgment is unavailable right now: this server's balance with the judgment provider is spent. This is on our side, not your input; nothing was charged. Retry later.";
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
export async function askDecisionOne(body, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, apiKey = keyOf(), model = DECISION_ONE_MODEL } = {}) {
  const label = labelOf(model);
  if (!openRouterDecisionsEnabled(model, apiKey)) throw fail(`${label} is not configured on this server.`, 503);
  const payload = decisionsPayload(body, model);
  const bytes = Buffer.byteLength(payload);
  if (bytes > maxBodyBytes()) throw fail(`Judgment request is ${bytes} bytes; ${label} accepts ${maxBodyBytes()}.`, 503);
  if (!bookBytes(bytes)) throw fail(`${label}'s daily ceiling is reached on this server.`, 503);
  // A read that outlives its cap, or a host that cannot be reached, is the
  // upstream's 503 class. A timed-out call may still have been billed
  // upstream (mayBeBilled, so the caller tries no other backend); a refused
  // connection was not.
  const ctx = { label: "Judgment upstream", step: "judgment", timeoutMs: Math.max(1, timeoutMs), tag: "[decision-one]", fetchImpl };
  let res;
  try {
    res = await upstreamFetch(ENDPOINT(), {
      method: "POST",
      headers: { ...OPENROUTER_ATTRIBUTION, authorization: `Bearer ${String(apiKey).trim()}`, "content-type": "application/json" },
      body: payload,
    }, ctx);
  } catch (err) {
    // A budget spent before the request left sent nothing, so nothing was billed.
    if (err?.upstreamFailure === "deadline" && !err.budgetSpent) err.mayBeBilled = true;
    throw err;
  }
  let text;
  try { text = await bodyUnderDeadline(res.text(), ctx); }
  catch (err) { if (err?.statusCode) { err.mayBeBilled = true; throw err; } throw fail("Judgment upstream returned an unreadable body.", 502, true); }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw attributed(fail(JUDGMENT_KEY_REFUSED, 503), ATTRIBUTION.OURS, KIND.OUR_KEY);
    if (res.status === 402) throw attributed(fail(JUDGMENT_BALANCE_OUT, 503), ATTRIBUTION.OURS, KIND.OUR_ALLOWANCE);
    if (res.status === 429) throw fail("Judgment upstream is rate limiting. Retry shortly.", 503);
    if (res.status >= 400 && res.status < 500) throw fail(`Judgment upstream refused the request (${res.status}). Check the question shapes against /v1/judge's schema.`, 400);
    throw fail(`Judgment upstream returned ${res.status}.`, 502);
  }
  // From here the upstream answered 200 and billed the call.
  let j; try { j = JSON.parse(text); } catch { throw fail("Judgment upstream returned an unreadable body.", 502, true); }
  if (!j?.answers || typeof j.answers !== "object" || Array.isArray(j.answers)) throw fail("Judgment upstream returned no answers.", 502, true);
  return j;
}

/** The OpenRouter legs an internal judge asks after TypeSafe, in order: the
 *  pinned Jev version by its OpenRouter id (when it has one and its switch is
 *  on), then Decision-1 (when its switch is on). Empty without a key. */
export function openRouterJudgeModels(pinned, apiKey = keyOf()) {
  const jev = jevOpenRouterModel(pinned);
  return [
    ...(jev && openRouterDecisionsEnabled(jev, apiKey) ? [jev] : []),
    ...(openRouterDecisionsEnabled(DECISION_ONE_MODEL, apiKey) ? [DECISION_ONE_MODEL] : []),
  ];
}

/** Ask those legs in turn with the same body under one deadline. Resolves to
 *  { j, model } for the first answer `usable` accepts; otherwise throws the
 *  last leg's error. Every leg is booked by askDecisionOne against the day's
 *  byte ceiling before it is sent. */
export async function askOpenRouterJudge(body, { pinned, deadline, apiKey = keyOf(), fetchImpl = fetch, usable = () => true } = {}) {
  let last = null;
  for (const model of openRouterJudgeModels(pinned, apiKey)) {
    const left = deadline - Date.now();
    if (left < 250) break; // too little time left to be worth another call
    try {
      const j = await askDecisionOne(body, { fetchImpl, timeoutMs: left, apiKey, model });
      if (usable(j)) return { j, model };
      last = fail(`${labelOf(model)} returned an answer this caller cannot read.`, 502, true);
    } catch (e) { last = e; }
  }
  throw last || fail("No judgment backend is configured on this server.", 503);
}
