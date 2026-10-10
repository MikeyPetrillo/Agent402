// Typed judgments as a paid tool: state plus typed questions in, typed answers
// and probabilities out.
//
// WHY THIS IS A PRODUCT HERE. Every other model tool in this catalog returns
// TEXT that the buyer must then parse and hope about. This returns a value the
// caller's code can branch on: one of a named set, a position on a described
// scale, or a probability. That is the shape an agent buying tools actually
// needs, and the /v1 gateway cannot produce it.
//
// MARGIN IS THE INPUT BOUND, not a clamp: the caps below fix the worst-case
// upstream size before the call, like stt-kit's duration cap.
//
// The character caps bound the SHAPE. The byte cap bounds the MONEY: a token
// can be one byte (CJK, emoji, base64), so the outbound body's byte length is
// the worst-case token count, and it is checked before anything is sent.
//
// RESALE. Offered on the operator's determination that redistribution is
// permitted (2026-09-21). That is a commercial judgment, not a verified term,
// and it is recorded here rather than assumed silently because this project has
// retired a data source once already for deriving income without permission.

import { upstreamCosts } from "../upstream-costs.js";
import { askDecisionOne, decisionOneEnabled, DECISION_ONE_MODEL } from "../decision-one.js";

// THREE BACKENDS, one answer shape. On /v1/judge TypeSafe's Jev answers first,
// then Microsoft Decision-1 (over OpenRouter, the Jev wire with another model
// id), then OpenAI's Decisions API (gpt-6-luna); on /v1/decisions, OpenAI's own
// wire, Luna answers first, then Jev, then Decision-1. A buyer of /v1/judge can
// name any one first with "model". All return probabilities over the same three
// question kinds, so a Luna answer is translated into the shape /v1/judge has
// always published, a Decision-1 answer already has it, and the answer names
// the model that served.
const ENDPOINT = (process.env.TYPESAFE_API_URL || "https://api.typesafe.ai/v1/systemone").trim();
const keyOf = () => (process.env.TYPESAFE_API_KEY || "").trim();
export const LUNA = "gpt-6-luna";
const LUNA_ENDPOINT = (process.env.OPENAI_DECISIONS_URL || "https://api.openai.com/v1/decisions").trim();
const openaiKey = () => (process.env.OPENAI_API_KEY || "").trim();
// Luna's input rate (USD per 1M tokens) and the largest share of the price a
// call may cost, both from the private table. Without them Luna is not
// offered: the route never sends a call it cannot price.
const lunaRate = () => upstreamCosts().vendor?.decisions?.luna ?? null;
const lunaMaxShare = () => upstreamCosts().vendor?.decisions?.maxShare ?? null;
// The buyer's name for Decision-1 on /v1/judge.
export const DECISION_ONE = "microsoft-decision-1";
// Decision-1's input rate (USD per 1M tokens), from the private table under
// the same rule as Luna's: no rate, no Decision-1 on the paid route.
const decisionOneRate = () => upstreamCosts().vendor?.decisions?.decisionOne ?? null;
export const jevEnabled = () => !!keyOf();
export const lunaEnabled = () => !!openaiKey() && lunaRate() != null && lunaMaxShare() != null;
export const decisionOneOffered = () => decisionOneEnabled() && decisionOneRate() != null && lunaMaxShare() != null;
export const judgeEnabled = () => jevEnabled() || lunaEnabled() || decisionOneOffered();
// Both routes sell at this price. Luna and Decision-1 are tried only when the
// request's worst case (one token per byte of the body we send) stays within
// the table's share of it; a larger request goes to Jev, whose rate fits the
// byte cap.
export const JUDGE_PRICE_USD = 0.001;
const fits = (r, share, bytes) => r != null && share != null && (bytes * r) / 1e6 <= share * JUDGE_PRICE_USD;
export function lunaFits(bytes) { return fits(lunaRate(), lunaMaxShare(), bytes); }
export function decisionOneFits(bytes) { return fits(decisionOneRate(), lunaMaxShare(), bytes); }

// Every bound below exists to make the upstream token count knowable in advance.
export const LIMITS = {
  stateChars: Number(process.env.JUDGE_MAX_STATE_CHARS || 8_000),
  questions: Number(process.env.JUDGE_MAX_QUESTIONS || 8),
  instructionChars: 600,
  criteriaEntries: 12,          // choice options, or score levels (API caps score at 10)
  criteriaChars: 400,
  scoreLevels: 10,              // the API's own maximum
  bodyBytes: Number(process.env.JUDGE_MAX_BODY_BYTES || 16_000),   // the money bound: one token per byte worst case
};
const MODELS = new Set([LUNA, DECISION_ONE, "jev-latest", "jev-preview"]);
const TIMEOUT_MS = 25_000;

const bad = (msg) => { const e = new Error(msg); e.statusCode = 400; return e; };

/** Validate and normalise. Throws a self-explaining 400 the caller can act on:
 *  a >= 400 cancels settlement, so a refused request is free to the buyer. */
export function validateJudgeRequest(input = {}) {
  const { state, questions, model = "jev-latest" } = input;
  if (!MODELS.has(String(model))) throw bad(`"model" must be one of: ${[...MODELS].join(", ")}`);

  const stateStr = typeof state === "string" ? state : state == null ? "" : JSON.stringify(state);
  if (!stateStr.trim()) throw bad('"state" is required: the content to judge, as a string or an object.');
  if (stateStr.length > LIMITS.stateChars) {
    throw bad(`"state" is ${stateStr.length} characters; this endpoint accepts ${LIMITS.stateChars}. Split the work or summarise upstream.`);
  }
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    throw bad('"questions" must be a map of your own question ids to question objects.');
  }
  const ids = Object.keys(questions);
  if (!ids.length) throw bad('"questions" is empty. Ask at least one.');
  if (ids.length > LIMITS.questions) throw bad(`At most ${LIMITS.questions} questions per call; got ${ids.length}.`);

  const out = {};
  for (const id of ids) {
    const q = questions[id];
    if (!q || typeof q !== "object") throw bad(`Question "${id}" must be an object.`);
    const type = String(q.type || "");
    if (!["choice", "score", "noul"].includes(type)) {
      throw bad(`Question "${id}" has type ${JSON.stringify(q.type)}; must be "choice", "score" or "noul".`);
    }
    const instructions = String(q.instructions || "").trim();
    if (!instructions) throw bad(`Question "${id}" needs "instructions": the question the model answers.`);
    if (instructions.length > LIMITS.instructionChars) {
      throw bad(`Question "${id}" instructions are ${instructions.length} characters; the limit is ${LIMITS.instructionChars}.`);
    }
    const built = { type, instructions };

    if (type === "noul") {
      if (q.criteria !== undefined) throw bad(`Question "${id}" is a noul and takes no "criteria". A noul answers yes/no as a probability.`);
    } else if (type === "choice") {
      const c = q.criteria;
      if (!c || typeof c !== "object" || Array.isArray(c)) throw bad(`Question "${id}" is a choice and needs "criteria": a map of option name to description.`);
      const keys = Object.keys(c);
      if (keys.length < 2) throw bad(`Question "${id}" needs at least 2 options.`);
      if (keys.length > LIMITS.criteriaEntries) throw bad(`Question "${id}" has ${keys.length} options; the limit is ${LIMITS.criteriaEntries}.`);
      built.criteria = {};
      for (const k of keys) built.criteria[k] = String(c[k] ?? "").slice(0, LIMITS.criteriaChars);
    } else {
      const c = q.criteria;
      if (!Array.isArray(c)) throw bad(`Question "${id}" is a score and needs "criteria": an ordered array of level descriptions, lowest first.`);
      if (c.length < 2) throw bad(`Question "${id}" needs at least 2 levels.`);
      if (c.length > LIMITS.scoreLevels) throw bad(`Question "${id}" has ${c.length} levels; the API accepts ${LIMITS.scoreLevels}.`);
      built.criteria = c.map((l) => String(l ?? "").slice(0, LIMITS.criteriaChars));
    }
    out[id] = built;
  }
  const body = { state: stateStr, model: String(model), questions: out };
  const bytes = Buffer.byteLength(JSON.stringify(body));
  if (bytes > LIMITS.bodyBytes) {
    throw bad(`This request is ${bytes} bytes; this endpoint accepts ${LIMITS.bodyBytes}. Shorten the state or the questions.`);
  }
  return body;
}

async function callJev(body, fetchImpl = fetch) {
  const model = body.model === LUNA || body.model === DECISION_ONE ? "jev-latest" : body.model;
  return post(ENDPOINT, keyOf(), { ...body, model }, fetchImpl, (j) => j?.answers && typeof j.answers === "object");
}

// The Jev body with only the model changed. Same error classes as post().
async function callDecisionOne(body, fetchImpl = fetch) {
  return askDecisionOne(body, { fetchImpl, timeoutMs: TIMEOUT_MS });
}
const decisionOneBytes = (body) => Buffer.byteLength(JSON.stringify({ ...body, model: DECISION_ONE_MODEL }));

async function callLuna(request, fetchImpl = fetch) {
  return post(LUNA_ENDPOINT, openaiKey(), request, fetchImpl, (j) => Array.isArray(j?.answers));
}

async function post(url, key, body, fetchImpl, hasAnswers) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Unreachable or slow upstream: theirs, not ours, and a >= 400 cancels
    // settlement. A bare throw here reached the buyer as a 500.
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    const e = new Error(timedOut ? "Judgment upstream timed out." : "Judgment upstream is unreachable.");
    e.statusCode = timedOut ? 504 : 502;
    // A timed-out call may still have been billed upstream; a refused
    // connection was not.
    if (timedOut) e.mayBeBilled = true;
    throw e;
  }
  const text = await res.text();
  if (!res.ok) {
    // Relay the CLASS, never the body: it can echo the buyer's own state back.
    if (res.status === 401 || res.status === 403) { const e = new Error("Judgment upstream rejected our credentials."); e.statusCode = 503; throw e; }
    if (res.status === 402) { const e = new Error("Judgment upstream is unavailable."); e.statusCode = 503; throw e; }
    if (res.status === 429) { const e = new Error("Judgment upstream is rate limiting. Retry shortly."); e.statusCode = 503; throw e; }
    if (res.status >= 400 && res.status < 500) throw bad(`Judgment upstream refused the request (${res.status}). Check the question shapes against /v1/judge's schema.`);
    const e = new Error(`Judgment upstream returned ${res.status}.`); e.statusCode = 502; throw e;
  }
  // From here the upstream answered 200 and billed the call.
  let j; try { j = JSON.parse(text); } catch { const e = new Error("Judgment upstream returned an unreadable body."); e.statusCode = 502; e.mayBeBilled = true; throw e; }
  if (!hasAnswers(j)) { const e = new Error("Judgment upstream returned no answers."); e.statusCode = 502; e.mayBeBilled = true; throw e; }
  return j;
}

const unreadable = () => { const e = new Error("Judgment upstream returned an answer this route cannot read."); e.statusCode = 502; e.mayBeBilled = true; return e; };
const num = (v) => typeof v === "number" && Number.isFinite(v);
const prob = (v) => num(v) && v >= 0 && v <= 1;
const byValue = (list, key = "value") => Object.fromEntries((Array.isArray(list) ? list : []).map((p) => [p?.[key], p?.probability]));

/** A validated /v1/judge body as a Decisions request. Question names are
 *  positional (q0, q1, ...) so a buyer's id never has to satisfy the
 *  upstream's name rules; answers are mapped back by position. */
export function toDecisions(body) {
  const ids = Object.keys(body.questions);
  const questions = ids.map((id, i) => {
    const q = body.questions[id], name = `q${i}`;
    if (q.type === "noul") return { type: "predicate", name, instructions: q.instructions };
    if (q.type === "choice") return { type: "choice", name, instructions: q.instructions, choices: Object.entries(q.criteria).map(([value, description]) => ({ value, description })) };
    return { type: "score", name, instructions: q.instructions, levels: q.criteria.map((description, n) => ({ label: String(n), description })) };
  });
  return { ids, request: { model: LUNA, input: body.state, questions } };
}

/** Decisions answers in /v1/judge's published shape. A refusal or any answer
 *  that does not match its question throws, so the call falls back to Jev. */
export function fromDecisions(j, body, ids) {
  const byName = new Map(j.answers.map((a) => [a?.name, a]));
  const answers = {};
  ids.forEach((id, i) => {
    const a = byName.get(`q${i}`), q = body.questions[id];
    if (q.type === "noul" && a?.type === "predicate" && prob(a.probability)) answers[id] = { type: "noul", noul: a.probability };
    else if (q.type === "choice" && a?.type === "choice" && Object.hasOwn(q.criteria, a.choice)) {
      answers[id] = { type: "choice", choice: a.choice, confidence: a.confidence, probabilities: byValue(a.probabilities) };
    } else if (q.type === "score" && a?.type === "score" && num(a.score) && a.score >= 0 && a.score <= q.criteria.length - 1) {
      answers[id] = { type: "score", score: a.score, confidence: a.confidence, legend: Object.fromEntries(q.criteria.map((d, n) => [n, d])), probabilities: byValue(a.probabilities) };
    } else throw unreadable();
  });
  return answers;
}

/** Jev's answers, only when every question has one of its own type: an empty
 *  or partial answer is an uncharged 502, never a charged 200. */
function checkJev(answers, body) {
  for (const [id, q] of Object.entries(body.questions)) {
    const a = answers?.[id];
    const good = a?.type === q.type && (q.type === "noul" ? prob(a.noul) : q.type === "choice" ? Object.hasOwn(q.criteria, a.choice) : num(a.score));
    if (!good) throw unreadable();
  }
  return answers;
}

/** The order the backends are tried in: the one the buyer named first, the
 *  others as fallbacks, each only when it is configured and (Luna,
 *  Decision-1) fits. Named Luna (and /v1/decisions): luna, jev, decision-one.
 *  Named Decision-1: decision-one, jev, luna. Otherwise jev, decision-one,
 *  luna. */
function backends(body, lunaBytes) {
  const luna = lunaEnabled() && lunaFits(lunaBytes) ? ["luna"] : [];
  const jev = jevEnabled() ? ["jev"] : [];
  const d1 = decisionOneOffered() && decisionOneFits(decisionOneBytes(body)) ? ["decision-one"] : [];
  if (body.model === LUNA) return [...luna, ...jev, ...d1];
  if (body.model === DECISION_ONE) return [...d1, ...jev, ...luna];
  return [...jev, ...d1, ...luna];
}
const nameOf = (b) => (b === "luna" ? LUNA : b === "decision-one" ? DECISION_ONE : "jev-latest");

/** Try each backend in order; the first answer wins. A failure settles
 *  nothing for the buyer, but the next backend is tried only when the failed
 *  one certainly did not bill us (refused, 5xx, 429, credentials, a request
 *  error). After a timeout or a 200 we could not use, the call ends as an
 *  uncharged 5xx, so one sale never pays two upstreams. */
async function firstAnswer(order, attempt) {
  let last = null;
  for (const b of order) {
    try { return { backend: b, out: await attempt(b) }; }
    catch (e) {
      last = e;
      console.warn(`[judge] ${b} failed: ${String(e?.message || e).slice(0, 120)}`);
      if (e?.mayBeBilled) break;
    }
  }
  throw last || Object.assign(new Error("Judgment is not configured on this server."), { statusCode: 503 });
}

export async function judge(input, { fetchImpl = fetch } = {}) {
  if (!judgeEnabled()) { const e = new Error("Judgment is not configured on this server."); e.statusCode = 503; throw e; }
  const body = validateJudgeRequest(input);
  const { ids, request } = toDecisions(body);
  const order = backends(body, Buffer.byteLength(JSON.stringify(request)));
  const { backend, out } = await firstAnswer(order, async (b) => {
    if (b === "jev") { const j = await callJev(body, fetchImpl); return { j, answers: checkJev(j.answers, body), model: j.model || "jev-latest" }; }
    // Decision-1 is named by the buyer's own enum value, not the dated
    // upstream id the router answers with.
    if (b === "decision-one") { const j = await callDecisionOne(body, fetchImpl); return { j, answers: checkJev(j.answers, body), model: DECISION_ONE }; }
    const j = await callLuna(request, fetchImpl);
    return { j, answers: fromDecisions(j, body, ids), model: j.model || LUNA };
  });
  return {
    model: out.model,
    ...(backend !== order[0] ? { fallbackFrom: nameOf(order[0]) } : {}),
    // Answers are shaped by the model over the BUYER'S OWN state, so they are
    // returned as-is. The state came from the caller; we add nothing to it.
    answers: out.answers,
    usage: out.j.usage ? { input_tokens: out.j.usage.input_tokens, output_tokens: out.j.usage.output_tokens ?? 0 } : undefined,
    note: "Typed judgment. choice/score answers carry `probabilities` and `confidence`; a noul carries `noul`, a probability from 0 to 1, and no confidence. Gate on confidence for choice/score and on distance from 0.5 for a noul.",
  };
}

// ---- POST /v1/decisions: OpenAI's Decisions wire --------------------------
// The same judgment on OpenAI's own request and answer shape, so an OpenAI SDK
// pointed at this server works unchanged and pays per call. Text input only
// for now: an image's token count is not bounded by its size the way text is.
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export function validateDecisionsRequest(input = {}) {
  const { model = LUNA, input: content, questions } = input;
  if (model !== LUNA) throw bad(`"model" must be ${LUNA}.`);
  let text;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    const parts = [];
    for (const m of content) {
      if (m?.role !== "user" || !Array.isArray(m?.content)) throw bad('"input" is a string or a list of user messages with "content" parts.');
      for (const c of m.content) {
        if (c?.type === "input_image") throw bad('Images are not accepted on this endpoint yet; send the content as input_text.');
        if (c?.type !== "input_text" || typeof c.text !== "string") throw bad('Each content part is {"type":"input_text","text":"..."}.');
        parts.push(c.text);
      }
    }
    text = parts.join("\n\n");
  } else throw bad('"input" is required: a string, or a list of user messages with input_text parts.');
  if (!text.trim()) throw bad('"input" is empty.');
  if (!Array.isArray(questions) || !questions.length) throw bad('"questions" is a non-empty array.');
  const names = new Set();
  const judgeQuestions = {};
  for (const q of questions) {
    const name = String(q?.name ?? "");
    if (!NAME.test(name)) throw bad(`Each question needs a "name" of letters, digits, "_", "-" or "." (1-64 characters); got ${JSON.stringify(q?.name)}.`);
    if (names.has(name)) throw bad(`Question name "${name}" is used twice.`);
    names.add(name);
    if (typeof q.instructions !== "string") throw bad(`Question "${name}" needs "instructions" as a string.`);
    const base = { instructions: q.instructions };
    const text = (v, field) => {
      if (v == null) return "";
      if (typeof v !== "string") throw bad(`Question "${name}": "${field}" must be a string.`);
      if (v.length > LIMITS.criteriaChars) throw bad(`Question "${name}": "${field}" is ${v.length} characters; the limit is ${LIMITS.criteriaChars}.`);
      return v;
    };
    if (q.type === "predicate") judgeQuestions[name] = { type: "noul", ...base };
    else if (q.type === "choice") {
      if (!Array.isArray(q.choices)) throw bad(`Question "${name}" is a choice and needs "choices": [{"value","description"}].`);
      const criteria = {};
      for (const c of q.choices) {
        if (typeof c?.value !== "string" || !c.value) throw bad(`Question "${name}": each choice needs a string "value".`);
        if (Object.hasOwn(criteria, c.value)) throw bad(`Question "${name}": choice value "${c.value}" is used twice.`);
        criteria[text(c.value, "value")] = text(c.description, "description");
      }
      judgeQuestions[name] = { type: "choice", ...base, criteria };
    } else if (q.type === "score") {
      if (!Array.isArray(q.levels)) throw bad(`Question "${name}" is a score and needs "levels": [{"label","description"}], lowest first.`);
      const criteria = q.levels.map((l) => {
        if (!l || typeof l !== "object" || typeof l.label !== "string" || !l.label) throw bad(`Question "${name}": each level is {"label","description"} with a string label.`);
        const line = [text(l.label, "label"), text(l.description, "description")].filter(Boolean).join(": ");
        if (line.length > LIMITS.criteriaChars) throw bad(`Question "${name}": level "${l.label}" is ${line.length} characters with its description; the limit is ${LIMITS.criteriaChars}.`);
        return line;
      });
      judgeQuestions[name] = { type: "score", ...base, criteria };
    } else throw bad(`Question "${name}" has type ${JSON.stringify(q?.type)}; must be "predicate", "choice" or "score".`);
  }
  // The same bounds as /v1/judge, applied to the translated request.
  const body = validateJudgeRequest({ state: text, questions: judgeQuestions, model: LUNA });
  const request = { model: LUNA, input: text, questions: questions.map((q) => {
    const out = { type: q.type, name: q.name, instructions: String(q.instructions).trim() };
    if (q.type === "choice") out.choices = q.choices.map((c) => ({ value: c.value, description: String(c.description ?? "") }));
    if (q.type === "score") out.levels = q.levels.map((l) => ({ label: String(l?.label ?? ""), description: String(l?.description ?? "") }));
    return out;
  }) };
  return { body, request, levels: Object.fromEntries(questions.filter((q) => q.type === "score").map((q) => [q.name, q.levels])) };
}

/** Luna's answers on the Decisions wire, only when every question has a
 *  usable answer of its own type (a refusal or a missing name is an uncharged
 *  502); returned in the buyer's question order. */
function checkLuna(answers, request) {
  const byName = new Map(answers.map((a) => [a?.name, a]));
  return request.questions.map((q) => {
    const a = byName.get(q.name);
    const good = a?.type === q.type && (q.type === "predicate" ? prob(a.probability)
      : q.type === "choice" ? q.choices.some((c) => c.value === a.choice)
      : num(a.score) && a.score >= 0 && a.score <= q.levels.length - 1);
    if (!good) throw unreadable();
    return a;
  });
}

/** Jev answers in the Decisions shape, for when Jev served this route. */
export function toDecisionsAnswers(answers, request, levels) {
  return request.questions.map((q) => {
    const a = answers?.[q.name];
    if (q.type === "predicate" && num(a?.noul)) return { type: "predicate", name: q.name, probability: a.noul };
    if (q.type === "choice" && typeof a?.choice === "string") {
      return { type: "choice", name: q.name, choice: a.choice, probabilities: q.choices.map((c) => ({ value: c.value, probability: a.probabilities?.[c.value] ?? 0 })), confidence: a.confidence };
    }
    if (q.type === "score" && num(a?.score)) {
      return { type: "score", name: q.name, score: a.score, probabilities: levels[q.name].map((l, n) => ({ value: n, label: l?.label, probability: a.probabilities?.[n] ?? 0 })), confidence: a.confidence };
    }
    throw unreadable();
  });
}

export async function decisions(input, { fetchImpl = fetch } = {}) {
  if (!judgeEnabled()) { const e = new Error("Decisions are not configured on this server."); e.statusCode = 503; throw e; }
  const { body, request, levels } = validateDecisionsRequest(input);
  const order = backends(body, Buffer.byteLength(JSON.stringify(request)));
  const { backend, out } = await firstAnswer(order, async (b) => {
    if (b === "luna") { const j = await callLuna(request, fetchImpl); return { j, answers: checkLuna(j.answers, request), model: j.model || LUNA }; }
    const j = b === "jev" ? await callJev(body, fetchImpl) : await callDecisionOne(body, fetchImpl);
    return { j, answers: toDecisionsAnswers(checkJev(j.answers, body), request, levels), model: b === "jev" ? j.model || "jev-latest" : DECISION_ONE };
  });
  return {
    model: out.model,
    ...(backend !== order[0] ? { fallback_from: nameOf(order[0]) } : {}),
    answers: out.answers,
    usage: out.j.usage ? { input_tokens: out.j.usage.input_tokens, output_tokens: 0, total_tokens: out.j.usage.input_tokens } : undefined,
  };
}

export const JUDGE_TOOLS = [{
  route: "POST /v1/judge",
  name: "Typed judgment",
  slug: "judge",
  category: "ai",
  price: "$0.001",
  description: "Ask a typed question about any content and get an answer your code can branch on, not prose to parse. Send state (the content, a string or object) and questions (your own ids mapped to question objects); get back answers keyed by those ids. Three question types: choice (pick one of your named options: returns choice, probabilities per option and confidence), score (a position on levels you describe, lowest first: returns score as a fractional level index, probabilities per level index, confidence and a legend naming each level), and noul (a yes/no: returns noul, the probability of yes from 0 to 1). Up to 8 questions per call, answered in parallel over one piece of state. Use it for routing, triage, classification and gating decisions. Served by jev-latest, with Microsoft Decision-1 (microsoft-decision-1) and gpt-6-luna as fallbacks (name any one first with model); the answer names the model that served, and fallbackFrom when the first was unavailable. Model-backed, not deterministic.",
  tags: ["ai", "classify", "judgment", "routing", "extraction"],
  discovery: {
    bodyType: "json",
    inputSchema: {
      type: "object",
      required: ["state", "questions"],
      properties: {
        state: { type: ["string", "object", "array"], description: `The content to judge. Up to ${LIMITS.stateChars} characters.` },
        model: { type: "string", enum: [...MODELS], description: "Which model answers first; the others are fallbacks. microsoft-decision-1 is Microsoft Decision-1, a model-backed judgment, not deterministic. Defaults to jev-latest." },
        questions: { type: "object", description: "Your own ids mapped to question objects. Each has type (choice/score/noul), instructions, and criteria for choice/score." },
      },
    },
    input: {
      state: "The export button crashes the settings page in Safari. It works in Chrome, but a few of our customers only use Safari.",
      questions: {
        severity: { type: "score", instructions: "How severe is the reported issue?", criteria: ["Cosmetic; no impact to functionality", "Broken or degraded feature, but a workaround exists", "Blocking issue; no workaround exists"] },
        is_reproducible: { type: "noul", instructions: "Does this report describe steps that would let an engineer reproduce the problem?" },
      },
    },
    // The live answer shape (read from a real call 2026-09-24): score
    // probabilities are keyed by level INDEX with a legend beside them, not an
    // array, and the model echoes its concrete version.
    example: {
      model: "jev-1.13.0",
      answers: {
        severity: {
          type: "score", score: 1.48, confidence: 0.27,
          legend: { 0: "Cosmetic; no impact to functionality", 1: "Broken or degraded feature, but a workaround exists", 2: "Blocking issue; no workaround exists" },
          probabilities: { 0: 0, 1: 0.52, 2: 0.48 },
        },
        is_reproducible: { type: "noul", noul: 0.3 },
      },
      usage: { input_tokens: 363, output_tokens: 37 },
      note: "Typed judgment. choice/score answers carry `probabilities` and `confidence`; a noul carries `noul`, a probability from 0 to 1, and no confidence. Gate on confidence for choice/score and on distance from 0.5 for a noul.",
    },
  },
  // Pure, synchronous input check the paid gates can run BEFORE a payment
  // round trip (the Tempo gate's pre-validation): a body the handler would
  // refuse is refused in milliseconds instead of after relay validation.
  validateInput: (input) => { validateJudgeRequest(input); },
  handler: (input) => judge(input),
}, {
  route: "POST /v1/decisions",
  name: "Decisions (OpenAI wire)",
  slug: "decisions",
  category: "ai",
  price: "$0.001",
  description: "OpenAI's Decisions API on its own wire: point an OpenAI SDK's base URL here and client.decisions.create works unchanged, paid per call. Send input (text, or user messages with input_text parts) and questions; get back answers your code can branch on. predicate returns the probability a condition holds; choice returns one of your values with probabilities and confidence; score returns a probability-weighted position on your ordered levels. Up to 8 questions per call. Served by gpt-6-luna, with jev-latest and Microsoft Decision-1 as fallbacks; the answer names the model that served, and fallback_from when the first was unavailable. Text input only. Model-backed, not deterministic.",
  tags: ["ai", "classify", "judgment", "routing", "openai", "decisions"],
  discovery: {
    bodyType: "json",
    inputSchema: {
      type: "object",
      required: ["input", "questions"],
      properties: {
        model: { type: "string", enum: [LUNA], description: `Defaults to ${LUNA}.` },
        input: { type: ["string", "array"], description: `The content to evaluate: a string, or user messages with input_text parts. Up to ${LIMITS.stateChars} characters.` },
        questions: { type: "array", description: "Each has type (predicate/choice/score), a unique name and instructions; choice adds choices [{value, description}], score adds levels [{label, description}] lowest first." },
      },
    },
    input: {
      input: "I was charged twice for my order.",
      questions: [{
        type: "choice", name: "department", instructions: "Which department should handle this complaint?",
        choices: [
          { value: "billing", description: "Payments, invoices, and refunds." },
          { value: "technical", description: "Problems using the product." },
          { value: "shipping", description: "Delivery and tracking." },
          { value: "other", description: "Requests outside these categories." },
        ],
      }],
    },
    example: {
      model: LUNA,
      answers: [{ type: "choice", name: "department", choice: "billing", probabilities: [{ value: "billing", probability: 1 }, { value: "technical", probability: 0 }, { value: "shipping", probability: 0 }, { value: "other", probability: 0 }], confidence: 1 }],
      usage: { input_tokens: 145, output_tokens: 0, total_tokens: 145 },
    },
  },
  validateInput: (input) => { validateDecisionsRequest(input); },
  handler: (input) => decisions(input),
}];
