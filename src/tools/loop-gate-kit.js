// Loop gate: one fixed-schema judgment per loop iteration, "continue, stop or
// escalate", priced at the judge floor.
//
// An agent that runs a loop pays this at the end of every iteration instead
// of asking a chat model and parsing prose. The answer is a value its code can
// branch on, with the checks that produced it.
//
// TWO PATHS, ONE PRICE. The budget and iteration checks are computed in code
// before anything else; when either trips the answer is "stop" and no model is
// consulted (the price is the route's one price either way, so a buyer never
// pays more for the cheaper answer and never has to guess which path ran: the
// answer names the model, or null). The lexical checks (an output that repeats
// an earlier one, three near-identical outputs in a row) are also computed in
// code, first, and handed to the model as facts. The model (/v1/judge's
// backends, src/tools/judge-kit.js) then answers the questions code cannot:
// is the goal met, is the loop stuck, is a constraint breached, what next.
//
// MONEY BOUND. The state the model reads is built here from capped fields,
// so its worst case is known before the call and sits inside /v1/judge's own
// byte bound; the built request goes through validateJudgeRequest like any
// other, and every refusal is a 400 that charges nothing. A model failure is
// the judge's uncharged 5xx.
import { judge, judgeEnabled, validateJudgeRequest, JUDGE_PRICE_USD, LIMITS as JUDGE_LIMITS } from "./judge-kit.js";

export const LOOP_GATE_PRICE_USD = JUDGE_PRICE_USD;

export const LOOP_LIMITS = {
  goalChars: 600,
  outputChars: 3_000,        // lastOutput; send the output or a digest of it
  historyEntries: 20,        // compared lexically; the model reads the newest RECENT_HISTORY
  summaryChars: 400,
  constraints: 8,
  constraintChars: 160,
  maxIterations: 1_000_000,
};
// How many history entries the model reads (the rest serve the lexical checks).
export const RECENT_HISTORY = 5;
// Word-set Jaccard at or above this, across the last three outputs, is "stuck".
export const STUCK_SIMILARITY = 0.85;
export const NEXT_STEPS = {
  iterate: "Run the same approach again; the latest output is progress and more of it is likely to finish the goal.",
  change_approach: "Try a different method, tool or source; the current approach is not producing new progress.",
  narrow_scope: "Split the goal or reduce it to the part that can be finished with what is known.",
  verify_result: "Check the latest output before relying on it; it may be complete but unconfirmed.",
  hand_off: "Hand the task to a person or a supervising agent; the loop cannot resolve this on its own.",
};
export const LOOP_DECISIONS = ["continue", "stop", "escalate"];

const bad = (msg) => { const e = new Error(msg); e.statusCode = 400; return e; };
const isInt = (v) => Number.isInteger(v);
const text = (v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

/** Validate and normalize. Throws a self-explaining 400 (uncharged). */
export function validateLoopGateRequest(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("Send a JSON object with goal, lastOutput and iteration.");
  const goal = text(input.goal).trim();
  if (!goal) throw bad('"goal" is required: what the loop is trying to accomplish, as a string.');
  if (goal.length > LOOP_LIMITS.goalChars) throw bad(`"goal" is ${goal.length} characters; this route accepts ${LOOP_LIMITS.goalChars}.`);
  const lastOutput = text(input.lastOutput).trim();
  if (!lastOutput) throw bad('"lastOutput" is required: what the iteration that just finished produced, as a string or an object.');
  if (lastOutput.length > LOOP_LIMITS.outputChars) throw bad(`"lastOutput" is ${lastOutput.length} characters; this route accepts ${LOOP_LIMITS.outputChars}. Send a digest of the output.`);
  const iteration = input.iteration;
  if (!isInt(iteration) || iteration < 1 || iteration > LOOP_LIMITS.maxIterations) throw bad(`"iteration" is the number of iterations completed so far, an integer from 1 to ${LOOP_LIMITS.maxIterations}.`);
  let maxIterations = null;
  if (input.maxIterations != null) {
    maxIterations = input.maxIterations;
    if (!isInt(maxIterations) || maxIterations < 1 || maxIterations > LOOP_LIMITS.maxIterations) throw bad(`"maxIterations" is an integer from 1 to ${LOOP_LIMITS.maxIterations}.`);
  }
  let budget = null;
  if (input.budget != null) {
    const b = input.budget;
    if (!b || typeof b !== "object" || Array.isArray(b)) throw bad('"budget" is { spentUsd, maxUsd }.');
    const spentUsd = Number(b.spentUsd), maxUsd = Number(b.maxUsd);
    if (b.spentUsd == null || !Number.isFinite(spentUsd) || spentUsd < 0) throw bad('"budget.spentUsd" is a number of dollars at or above 0.');
    if (b.maxUsd == null || !Number.isFinite(maxUsd) || maxUsd <= 0) throw bad('"budget.maxUsd" is a number of dollars above 0.');
    budget = { spentUsd, maxUsd };
  }
  let history = [];
  if (input.history != null) {
    if (!Array.isArray(input.history)) throw bad('"history" is a list of { iteration, summary }, oldest first.');
    if (input.history.length > LOOP_LIMITS.historyEntries) throw bad(`"history" has ${input.history.length} entries; this route accepts ${LOOP_LIMITS.historyEntries}. Send the newest ${LOOP_LIMITS.historyEntries}.`);
    history = input.history.map((h, i) => {
      if (!h || typeof h !== "object" || Array.isArray(h)) throw bad(`history[${i}] must be { iteration, summary }.`);
      if (!isInt(h.iteration) || h.iteration < 1 || h.iteration >= iteration) throw bad(`history[${i}].iteration must be an integer from 1 to ${iteration - 1} (an iteration before this one).`);
      const summary = text(h.summary).trim();
      if (!summary) throw bad(`history[${i}].summary is required: that iteration's output or a digest of it.`);
      if (summary.length > LOOP_LIMITS.summaryChars) throw bad(`history[${i}].summary is ${summary.length} characters; this route accepts ${LOOP_LIMITS.summaryChars}.`);
      return { iteration: h.iteration, summary };
    });
    const seen = new Set();
    for (const h of history) { if (seen.has(h.iteration)) throw bad(`history lists iteration ${h.iteration} twice.`); seen.add(h.iteration); }
    history.sort((a, b) => a.iteration - b.iteration);
  }
  let constraints = [];
  if (input.constraints != null) {
    if (!Array.isArray(input.constraints)) throw bad('"constraints" is a list of strings.');
    if (input.constraints.length > LOOP_LIMITS.constraints) throw bad(`"constraints" has ${input.constraints.length} entries; this route accepts ${LOOP_LIMITS.constraints}.`);
    constraints = input.constraints.map((c, i) => {
      const s = text(c).trim();
      if (!s) throw bad(`constraints[${i}] is empty.`);
      if (s.length > LOOP_LIMITS.constraintChars) throw bad(`constraints[${i}] is ${s.length} characters; this route accepts ${LOOP_LIMITS.constraintChars}.`);
      return s;
    });
  }
  return { goal, lastOutput, iteration, maxIterations, budget, history, constraints };
}

// ---- lexical checks: code, before any model ------------------------------
export const normalizeText = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const wordSet = (s) => new Set(normalizeText(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2));
/** Word-set Jaccard similarity, 0 to 1. */
export function similarity(a, b) {
  const A = wordSet(a), B = wordSet(b);
  if (!A.size && !B.size) return normalizeText(a) === normalizeText(b) ? 1 : 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

/** The checks code can make. `repeating`: lastOutput equals (normalized) an
 *  earlier iteration's summary; `repeats` names it. `stuck`: the last three
 *  outputs are pairwise near-identical without being equal. */
export function lexicalChecks(req) {
  const last = normalizeText(req.lastOutput);
  const repeats = req.history.filter((h) => normalizeText(h.summary) === last).map((h) => h.iteration);
  const recent = req.history.slice(-2).map((h) => h.summary);
  let stuck = false;
  if (recent.length === 2 && !repeats.length) {
    const texts = [req.lastOutput, ...recent];
    stuck = similarity(texts[0], texts[1]) >= STUCK_SIMILARITY && similarity(texts[0], texts[2]) >= STUCK_SIMILARITY && similarity(texts[1], texts[2]) >= STUCK_SIMILARITY;
  }
  return { repeating: repeats.length > 0, repeats, stuck };
}

const usd = (n) => `${Math.round(n * 100) / 100} USD`;

/** Everything decided before the model: the validated request, the lexical
 *  checks, and either a deterministic verdict (no model call) or the judge
 *  request the model path sends. Exported so the probe lane can drive the
 *  model path's input stage without a key. */
export function prepareLoopGate(input) {
  const req = validateLoopGateRequest(input);
  const lex = lexicalChecks(req);
  const budgetExceeded = !!req.budget && req.budget.spentUsd >= req.budget.maxUsd;
  const iterationsExhausted = req.maxIterations != null && req.iteration >= req.maxIterations;
  const checks = {
    goalMet: null,
    budgetExceeded,
    iterationsExhausted,
    repeating: lex.repeating,
    stuck: lex.stuck,
    constraintBreached: req.constraints.length ? null : false,
  };
  if (budgetExceeded || iterationsExhausted) {
    const why = [];
    if (budgetExceeded) why.push(`budget exhausted: spent ${usd(req.budget.spentUsd)} of ${usd(req.budget.maxUsd)}`);
    if (iterationsExhausted) why.push(`iteration ${req.iteration} of ${req.maxIterations} completed`);
    const extra = lex.repeating ? `; the output also repeats iteration ${lex.repeats.at(-1)}` : lex.stuck ? "; the last three outputs are near-identical" : "";
    const reason = `${why.join("; ")}${extra}. No model was consulted.`;
    const verdict = {
      decision: "stop",
      reason: reason[0].toUpperCase() + reason.slice(1),
      confidence: 1,
      checks,
      model: null,
    };
    return { req, checks, repeats: lex.repeats, verdict, request: null };
  }
  const state = {
    goal: req.goal,
    ...(req.constraints.length ? { constraints: req.constraints } : {}),
    iteration: req.iteration,
    ...(req.maxIterations != null ? { maxIterations: req.maxIterations, iterationsLeft: req.maxIterations - req.iteration } : {}),
    ...(req.budget ? { budget: { spentUsd: req.budget.spentUsd, maxUsd: req.budget.maxUsd, remainingUsd: Math.max(0, req.budget.maxUsd - req.budget.spentUsd) } } : {}),
    recentHistory: req.history.slice(-RECENT_HISTORY),
    ...(req.history.length > RECENT_HISTORY ? { olderIterations: req.history.length - RECENT_HISTORY } : {}),
    lastOutput: req.lastOutput,
    codeChecks: {
      outputRepeatsIteration: lex.repeats.length ? lex.repeats.at(-1) : null,
      lastThreeOutputsNearIdentical: lex.stuck,
    },
  };
  const questions = {
    goal_met: { type: "noul", instructions: "Does lastOutput fully accomplish goal? Partial progress, a plan, or a promise to do it next is no." },
    stuck: { type: "noul", instructions: "Comparing lastOutput with recentHistory and codeChecks, is the loop failing to make progress toward goal (the same errors, the same content, circling, or drifting off the goal)?" },
    ...(req.constraints.length ? { constraint_breach: { type: "noul", instructions: "Does lastOutput violate any entry of constraints?" } } : {}),
    next_step: { type: "choice", instructions: "Given goal, lastOutput, recentHistory, the budget and iterations left, which next step is right?", criteria: NEXT_STEPS },
  };
  let request;
  try { request = validateJudgeRequest({ state, questions }); }
  catch (e) {
    // The judge's byte bound (one token per byte), in this route's own words.
    if (e?.statusCode === 400) {
      const bytes = Buffer.byteLength(JSON.stringify({ state: JSON.stringify(state), model: "jev-latest", questions }));
      throw bad(`This request is larger than one call of this route covers: ${bytes} bytes against a bound of ${JUDGE_LIMITS.bodyBytes}. Send a shorter lastOutput or shorter history summaries.`);
    }
    throw e;
  }
  return { req, checks, repeats: lex.repeats, verdict: null, request };
}

const prob = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const scaled = (p) => Math.round(Math.abs(p - 0.5) * 2 * 100) / 100;
const pct = (p) => Math.round(p * 100) / 100;
const unreadable = () => { const e = new Error("Judgment upstream returned an answer this route cannot read."); e.statusCode = 502; e.mayBeBilled = true; return e; };

/** The model's answers plus the code checks, as one decision. Exported pure
 *  so the composition is testable without a model. */
export function composeDecision({ req, checks, repeats = [] }, answers, model) {
  const gm = answers?.goal_met, st = answers?.stuck, cb = answers?.constraint_breach, ns = answers?.next_step;
  if (!prob(gm?.noul) || !prob(st?.noul) || !Object.hasOwn(NEXT_STEPS, ns?.choice) || !prob(ns?.confidence)) throw unreadable();
  if (req.constraints.length && !prob(cb?.noul)) throw unreadable();
  const goalMet = gm.noul >= 0.5;
  const breached = req.constraints.length ? cb.noul >= 0.5 : false;
  const modelStuck = st.noul >= 0.5;
  const stuck = checks.stuck || checks.repeating || modelStuck;
  const out = { ...checks, goalMet, stuck, constraintBreached: breached };
  let decision, reason, confidence;
  if (goalMet && !breached) {
    decision = "stop";
    reason = `Goal met (${pct(gm.noul)}).`;
    confidence = scaled(gm.noul);
  } else if (breached) {
    decision = "escalate";
    reason = `A constraint is breached (${pct(cb.noul)})${goalMet ? " although the goal reads as met" : ""}; next step ${ns.choice} (${pct(ns.confidence)}).`;
    confidence = scaled(cb.noul);
  } else if (stuck) {
    const canTurn = ns.choice === "change_approach" || ns.choice === "narrow_scope";
    decision = canTurn ? "continue" : "escalate";
    const why = checks.repeating ? `the output repeats iteration ${repeats.at(-1)}` : checks.stuck ? "the last three outputs are near-identical" : `the model rates the loop stuck (${pct(st.noul)})`;
    reason = `${why[0].toUpperCase()}${why.slice(1)}; next step ${ns.choice} (${pct(ns.confidence)}), so ${canTurn ? "continue on a changed course" : "escalate"}.`;
    confidence = modelStuck && !checks.repeating && !checks.stuck ? Math.min(scaled(st.noul), ns.confidence) : ns.confidence;
  } else {
    decision = "continue";
    reason = `Goal not met (${pct(gm.noul)}), not stuck (${pct(st.noul)}); next step ${ns.choice} (${pct(ns.confidence)}).`;
    confidence = ns.confidence;
  }
  return { decision, reason, confidence: pct(confidence), checks: out, nextStep: ns.choice, model };
}

export async function loopGate(input, { fetchImpl = fetch } = {}) {
  const prepared = prepareLoopGate(input);
  if (prepared.verdict) return prepared.verdict;
  if (!judgeEnabled()) { const e = new Error("Judgment is not configured on this server; only the budget and iteration checks can answer here."); e.statusCode = 503; throw e; }
  // The judge re-validates the request it is handed (the same bounds) and
  // walks its backends under the route's payment-window budget.
  const j = await judge({ state: prepared.request.state, questions: prepared.request.questions }, { fetchImpl, tier: "loop-gate" });
  return composeDecision(prepared, j.answers, j.model);
}

const EXAMPLE_INPUT = {
  goal: "Find three peer-reviewed studies on sleep and memory consolidation published since 2020, with DOIs.",
  lastOutput: "Found two studies with DOIs (Nature Neuroscience 2021, Sleep 2023). A third search of PubMed returned review articles only.",
  iteration: 4,
  maxIterations: 6,
  budget: { spentUsd: 0.52, maxUsd: 0.5 },
  history: [
    { iteration: 2, summary: "One study found (Nature Neuroscience 2021)." },
    { iteration: 3, summary: "Second study found (Sleep 2023); PubMed search for a third in progress." },
  ],
};

export const LOOP_GATE_TOOLS = [{
  route: "POST /api/loop-gate",
  name: "Loop gate",
  slug: "loop-gate",
  category: "ai",
  price: `$${LOOP_GATE_PRICE_USD}`,
  description: `Should the loop run another iteration? Send the goal, the iteration that just finished (lastOutput, iteration), and optionally maxIterations, a budget { spentUsd, maxUsd }, the history of earlier iterations (up to ${LOOP_LIMITS.historyEntries} of { iteration, summary }, oldest first) and constraints; get back decision (continue, stop or escalate), reason, confidence (0 to 1), the checks that produced it (goalMet, budgetExceeded, iterationsExhausted, repeating, stuck, constraintBreached) and nextStep (${Object.keys(NEXT_STEPS).join(", ")}). The budget and iteration checks run in code before anything else: when either trips the answer is stop, no model is consulted, goalMet is null and model is null, at the same price. An output that repeats an earlier summary (repeating) and three near-identical outputs in a row (stuck) are found lexically first. Otherwise a typed judgment model (the /v1/judge backends) answers whether the goal is met, whether the loop is stuck, whether a constraint is breached and what to do next; model names which served. Model-backed, not deterministic, except the budget and iteration checks, which are computed in code before any model call.`,
  tags: ["ai", "agent", "loop", "judgment", "budget", "stop"],
  aliases: ["should-continue", "loop-check", "iteration-gate"],
  discovery: {
    bodyType: "json",
    inputSchema: {
      type: "object",
      required: ["goal", "lastOutput", "iteration"],
      properties: {
        goal: { type: "string", description: `What the loop is trying to accomplish. Up to ${LOOP_LIMITS.goalChars} characters.` },
        lastOutput: { type: ["string", "object"], description: `What the iteration that just finished produced, or a digest of it. Up to ${LOOP_LIMITS.outputChars} characters.` },
        iteration: { type: "integer", minimum: 1, description: "The number of iterations completed so far (the one that produced lastOutput)." },
        maxIterations: { type: "integer", minimum: 1, description: "Optional. At iteration >= maxIterations the answer is stop, decided in code." },
        budget: { type: "object", description: "Optional { spentUsd, maxUsd }. At spentUsd >= maxUsd the answer is stop, decided in code.", properties: { spentUsd: { type: "number", minimum: 0 }, maxUsd: { type: "number", exclusiveMinimum: 0 } } },
        history: { type: "array", description: `Optional, up to ${LOOP_LIMITS.historyEntries} earlier iterations as { iteration, summary }, oldest first; each summary up to ${LOOP_LIMITS.summaryChars} characters. Pass the same kind of text you pass as lastOutput so repeats compare like with like. The model reads the newest ${RECENT_HISTORY}; all are compared lexically.`, items: { type: "object", properties: { iteration: { type: "integer", minimum: 1 }, summary: { type: "string" } }, required: ["iteration", "summary"] } },
        constraints: { type: "array", items: { type: "string" }, description: `Optional, up to ${LOOP_LIMITS.constraints} rules the output must respect, each up to ${LOOP_LIMITS.constraintChars} characters. With constraints the model also answers constraintBreached; a breach escalates.` },
      },
    },
    input: EXAMPLE_INPUT,
    // The documented example trips the budget check, so this answer comes from
    // code and a host without a judgment model answers it too.
    example: {
      decision: "stop",
      reason: "Budget exhausted: spent 0.52 USD of 0.5 USD. No model was consulted.",
      confidence: 1,
      checks: { goalMet: null, budgetExceeded: true, iterationsExhausted: false, repeating: false, stuck: false, constraintBreached: false },
      model: null,
    },
  },
  // Pure, synchronous input check the paid gates can run BEFORE a payment
  // round trip (src/handler-input.js preValidateInput).
  validateInput: (input) => { validateLoopGateRequest(input); },
  handler: (input) => loopGate(input),
}];
