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

const ENDPOINT = (process.env.TYPESAFE_API_URL || "https://api.typesafe.ai/v1/systemone").trim();
const keyOf = () => (process.env.TYPESAFE_API_KEY || "").trim();
export const judgeEnabled = () => !!keyOf();

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
const MODELS = new Set(["jev-latest", "jev-preview"]);
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

async function call(body, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${keyOf()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Unreachable or slow upstream: theirs, not ours, and a >= 400 cancels
    // settlement. A bare throw here reached the buyer as a 500.
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    const e = new Error(timedOut ? "Judgment upstream timed out." : "Judgment upstream is unreachable.");
    e.statusCode = timedOut ? 504 : 502;
    throw e;
  }
  const text = await res.text();
  if (!res.ok) {
    // Relay the CLASS, never the body: it can echo the buyer's own state back.
    if (res.status === 401 || res.status === 403) { const e = new Error("Judgment upstream rejected our credentials."); e.statusCode = 503; throw e; }
    if (res.status === 429) { const e = new Error("Judgment upstream is rate limiting. Retry shortly."); e.statusCode = 503; throw e; }
    if (res.status >= 400 && res.status < 500) throw bad(`Judgment upstream refused the request (${res.status}). Check the question shapes against /v1/judge's schema.`);
    const e = new Error(`Judgment upstream returned ${res.status}.`); e.statusCode = 502; throw e;
  }
  let j; try { j = JSON.parse(text); } catch { const e = new Error("Judgment upstream returned an unreadable body."); e.statusCode = 502; throw e; }
  if (!j?.answers || typeof j.answers !== "object") { const e = new Error("Judgment upstream returned no answers."); e.statusCode = 502; throw e; }
  return j;
}

export async function judge(input, { fetchImpl = fetch } = {}) {
  if (!judgeEnabled()) { const e = new Error("Judgment is not configured on this server."); e.statusCode = 503; throw e; }
  const body = validateJudgeRequest(input);
  const j = await call(body, fetchImpl);
  return {
    model: j.model || body.model,
    // Answers are shaped by the model over the BUYER'S OWN state, so they are
    // returned as-is. The state came from the caller; we add nothing to it.
    answers: j.answers,
    usage: j.usage ? { input_tokens: j.usage.input_tokens, output_tokens: j.usage.output_tokens } : undefined,
    note: "Typed judgment. choice/score answers carry `probabilities` and `confidence`; a noul carries `noul`, a probability from 0 to 1, and no confidence. Gate on confidence for choice/score and on distance from 0.5 for a noul.",
  };
}

export const JUDGE_TOOLS = [{
  route: "POST /v1/judge",
  name: "Typed judgment",
  slug: "judge",
  category: "ai",
  price: "$0.001",
  description: "Ask a typed question about any content and get an answer your code can branch on, not prose to parse. Send state (the content, a string or object) and questions (your own ids mapped to question objects); get back answers keyed by those ids. Three question types: choice (pick one of your named options: returns choice, probabilities per option and confidence), score (a position on levels you describe, lowest first: returns score as a fractional level index, probabilities per level index, confidence and a legend naming each level), and noul (a yes/no: returns noul, the probability of yes from 0 to 1). Up to 8 questions per call, answered in parallel over one piece of state. Use it for routing, triage, classification and gating decisions. Model-backed, not deterministic.",
  tags: ["ai", "classify", "judgment", "routing", "extraction"],
  discovery: {
    bodyType: "json",
    inputSchema: {
      type: "object",
      required: ["state", "questions"],
      properties: {
        state: { type: ["string", "object", "array"], description: `The content to judge. Up to ${LIMITS.stateChars} characters.` },
        model: { type: "string", enum: [...MODELS], description: "Defaults to jev-latest." },
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
}];
