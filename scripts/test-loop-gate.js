// The loop gate (src/tools/loop-gate-kit.js): one fixed-schema judgment per
// loop iteration, sold at the judge floor. Offline: the judgment upstream is a
// stubbed fetch that answers whatever questions the route asked.
//
// What is load-bearing here:
//   - the budget and iteration checks answer "stop" in code, with no model
//     call and at the same price, and do so with no key at all;
//   - a repeated output and three near-identical outputs are found lexically
//     before the model, and the model cannot turn a repeat into "continue"
//     without changing course;
//   - every refusal is a 400 and every model failure an uncharged 5xx;
//   - the state built for the model stays inside /v1/judge's own byte bound,
//     and at the private table's Jev rate inside the price's share.
//
//   node scripts/test-loop-gate.js
import { readFileSync } from "node:fs";

delete process.env.OPENROUTER_API_KEY; delete process.env.DECIDE_OPENROUTER_API_KEY; delete process.env.OPENAI_API_KEY;
process.env.TYPESAFE_API_KEY = "ts_test";

const L = await import("../src/tools/loop-gate-kit.js");
const { LOOP_GATE_TOOLS, LOOP_LIMITS, NEXT_STEPS, RECENT_HISTORY, loopGate, prepareLoopGate, validateLoopGateRequest, lexicalChecks, similarity, composeDecision } = L;
const { JUDGE_PRICE_USD, LIMITS: JUDGE_LIMITS, validateJudgeRequest } = await import("../src/tools/judge-kit.js");
const U = await import("../src/upstream-costs.js");

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };
const tool = LOOP_GATE_TOOLS[0];

// ---- the stubbed judgment upstream: answers each question the route asked ----
const calls = [];
function stub({ goalMet = 0.1, stuck = 0.1, breach = 0.1, next = "iterate", confidence = 0.8, model = "jev-1.13.0" } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (id === "goal_met") answers[id] = { type: "noul", noul: goalMet };
      else if (id === "stuck") answers[id] = { type: "noul", noul: stuck };
      else if (id === "constraint_breach") answers[id] = { type: "noul", noul: breach };
      else if (id === "next_step") answers[id] = { type: "choice", choice: next, confidence, probabilities: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === next ? confidence : 0])) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ model, answers, usage: { input_tokens: 300, output_tokens: 20 } }) };
  };
}
const base = { goal: "Collect three sources on sleep and memory with DOIs", lastOutput: "Two sources found with DOIs; still searching for a third.", iteration: 3, maxIterations: 10, budget: { spentUsd: 0.1, maxUsd: 1 } };
const run = (input, opts) => loopGate(input, { fetchImpl: stub(opts) });
const fails = async (input, opts) => { try { await loopGate(input, opts); return null; } catch (e) { return e; } };

// ---- declaration ----------------------------------------------------------------
ok(tool.route === "POST /api/loop-gate" && tool.slug === "loop-gate", "route and slug");
ok(tool.price === `$${JUDGE_PRICE_USD}` && Number(tool.price.slice(1)) === JUDGE_PRICE_USD, `priced at the judge floor (${tool.price}), derived, not typed`);
ok(/model-backed, not deterministic/i.test(tool.description) && /budget and iteration checks/.test(tool.description), "the description says model-backed and scopes the code-only checks");
ok(/same price/.test(tool.description), "the description says the code-only stop costs the same");

// ---- deterministic short-circuits: no model, no key, same price -------------------
{
  calls.length = 0;
  const out = await run({ ...base, budget: { spentUsd: 1, maxUsd: 1 } });
  ok(out.decision === "stop" && out.checks.budgetExceeded === true && out.model === null && out.confidence === 1 && calls.length === 0, `spent >= max stops in code with no model call (${out.reason})`);
  ok(out.checks.goalMet === null, "goalMet is null when no model was consulted (never a guessed false)");
  const it = await run({ ...base, iteration: 10, maxIterations: 10 });
  ok(it.decision === "stop" && it.checks.iterationsExhausted === true && it.checks.budgetExceeded === false && calls.length === 0, `iteration >= maxIterations stops in code (${it.reason})`);
  const both = await run({ ...base, iteration: 10, maxIterations: 10, budget: { spentUsd: 2, maxUsd: 1 }, history: [{ iteration: 9, summary: base.lastOutput }] });
  ok(both.checks.budgetExceeded && both.checks.iterationsExhausted && both.checks.repeating === true && /repeats iteration 9/.test(both.reason), "both trips and the lexical repeat are all reported on the code path");
  // No key at all: the code path still answers, so a host without a judgment model serves the checks.
  const key = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY;
  const nokey = await loopGate({ ...base, budget: { spentUsd: 1, maxUsd: 1 } }, { fetchImpl: async () => { throw new Error("must not be called"); } });
  ok(nokey.decision === "stop" && nokey.model === null, "with no key the budget stop still answers");
  const e = await fails(base, { fetchImpl: async () => { throw new Error("must not be called"); } });
  ok(e?.statusCode === 503 && /not configured/.test(e.message), "with no key the model path is a 503 (ours), not a charged answer");
  process.env.TYPESAFE_API_KEY = key;
}

// ---- the published example answers on the code path and matches its documented shape ----
{
  calls.length = 0;
  const out = await tool.handler(tool.discovery.input);
  const ex = tool.discovery.example;
  ok(JSON.stringify(out) === JSON.stringify(ex), `the documented example is the real answer, byte for byte (${JSON.stringify(out)})`);
  ok(calls.length === 0, "and it is answered with no model call, so a keyless CI satisfies it");
  ok(Object.keys(ex).join() === "decision,reason,confidence,checks,model", "the example carries the fixed top-level schema");
  ok(!/[–—]/.test(JSON.stringify(tool)), "no em or en dash anywhere in the tool's copy");
}

// ---- the model path: continue / stop / escalate --------------------------------
{
  calls.length = 0;
  const c = await run(base);
  ok(c.decision === "continue" && c.nextStep === "iterate" && c.model === "jev-1.13.0" && c.checks.goalMet === false && c.checks.stuck === false, `goal unmet and not stuck: continue (${c.reason})`);
  ok(c.confidence === 0.8, "confidence is the decisive signal's (the next-step choice)");
  ok(calls.length === 1 && calls[0].questions.goal_met && calls[0].questions.stuck && calls[0].questions.next_step && !calls[0].questions.constraint_breach, "one model call; no constraint question without constraints");
  const state = JSON.parse(calls[0].state);
  ok(state.goal === base.goal && state.lastOutput === base.lastOutput && state.iteration === 3 && state.iterationsLeft === 7 && state.budget.remainingUsd === 0.9, "the model reads the goal, the output, the iteration and budget arithmetic");
  ok(Object.keys(calls[0].questions.next_step.criteria).join() === Object.keys(NEXT_STEPS).join(), "the next-step options are the published enum");
  const s = await run(base, { goalMet: 0.92 });
  ok(s.decision === "stop" && s.checks.goalMet === true && s.confidence === 0.84 && /Goal met/.test(s.reason), `goal met: stop, confidence from the noul's distance to 0.5 (${s.confidence})`);
  const e = await run(base, { stuck: 0.9, next: "iterate", confidence: 0.7 });
  ok(e.decision === "escalate" && e.checks.stuck === true && e.confidence === 0.7 && /rates the loop stuck/.test(e.reason), `model says stuck and the next step is more of the same: escalate (${e.reason})`);
  const turn = await run(base, { stuck: 0.9, next: "change_approach", confidence: 0.75 });
  ok(turn.decision === "continue" && turn.nextStep === "change_approach" && turn.checks.stuck === true, "stuck but the model names a changed course: continue on it");
  const breach = await run({ ...base, constraints: ["Only peer-reviewed sources", "No sources before 2020"] }, { breach: 0.8, next: "hand_off" });
  ok(breach.decision === "escalate" && breach.checks.constraintBreached === true && breach.confidence === 0.6 && calls.at(-1).questions.constraint_breach, "a breached constraint escalates and the question was asked");
  const breachMet = await run({ ...base, constraints: ["x"] }, { goalMet: 0.9, breach: 0.9 });
  ok(breachMet.decision === "escalate" && /although the goal reads as met/.test(breachMet.reason), "goal met while breaching a constraint still escalates");
  const noBreach = await run({ ...base, constraints: ["x"] }, { breach: 0.1 });
  ok(noBreach.decision === "continue" && noBreach.checks.constraintBreached === false, "constraints given and respected: constraintBreached false");
  ok(["continue", "stop", "escalate"].every((d) => L.LOOP_DECISIONS.includes(d)), "the three decisions are the published set");
}

// ---- repeating and stuck are found lexically, before the model -------------------
{
  const hist = [{ iteration: 1, summary: "Searching PubMed." }, { iteration: 2, summary: "  two SOURCES found with dois;  still searching for a third. " }];
  const lex = lexicalChecks(validateLoopGateRequest({ ...base, history: hist }));
  ok(lex.repeating === true && lex.repeats.join() === "2" && lex.stuck === false, "an output equal to an earlier summary (case and whitespace aside) is a repeat naming the iteration");
  calls.length = 0;
  const rep = await run({ ...base, history: hist }, { stuck: 0.1, next: "iterate", confidence: 0.9 });
  ok(rep.decision === "escalate" && rep.checks.repeating === true && rep.checks.stuck === true && /repeats iteration 2/.test(rep.reason), `a repeat the model would iterate on escalates (${rep.reason})`);
  ok(JSON.parse(calls[0].state).codeChecks.outputRepeatsIteration === 2, "the model is told the repeat as a fact");
  const rep2 = await run({ ...base, history: hist }, { stuck: 0.1, next: "narrow_scope", confidence: 0.9 });
  ok(rep2.decision === "continue" && rep2.nextStep === "narrow_scope", "a repeat with a changed course continues");
  const near = (n) => `Attempt ${n}: PubMed query returned 14 review articles and no primary study; filters applied: humans, 2020 to 2026, english.`;
  const stuckHist = [{ iteration: 1, summary: near(1) }, { iteration: 2, summary: near(2) }];
  const lx = lexicalChecks(validateLoopGateRequest({ ...base, lastOutput: near(3), history: stuckHist }));
  ok(lx.stuck === true && lx.repeating === false, `three near-identical outputs are stuck, not repeating (similarity ${similarity(near(1), near(3)).toFixed(2)})`);
  const st = await run({ ...base, lastOutput: near(3), history: stuckHist }, { stuck: 0.05, next: "iterate" });
  ok(st.decision === "escalate" && st.checks.stuck === true && /near-identical/.test(st.reason), "lexical stuck holds even when the model rates it not stuck");
  ok(lexicalChecks(validateLoopGateRequest({ ...base, history: [stuckHist[0]] })).stuck === false, "fewer than three outputs are never stuck");
  const differ = [{ iteration: 1, summary: "Found the first source: Nature Neuroscience 2021." }, { iteration: 2, summary: "Found a second: Sleep 2023, with its DOI." }];
  const d = lexicalChecks(validateLoopGateRequest({ ...base, history: differ }));
  ok(!d.stuck && !d.repeating, "progressing outputs are neither");
  ok(similarity("", "") === 1 && similarity("abc def", "") === 0, "similarity edge cases");
  // Newest-first history is sorted, so "the last two" are the newest two.
  const rev = lexicalChecks(validateLoopGateRequest({ ...base, lastOutput: near(3), history: [stuckHist[1], stuckHist[0]] }));
  ok(rev.stuck === true, "history order does not matter: entries are sorted by iteration");
}

// ---- schema rejection: every refusal is a 400 before any model call --------------
{
  const rejects = (input, why) => {
    let e = null;
    try { validateLoopGateRequest(input); } catch (err) { e = err; }
    ok(e?.statusCode === 400 && e.message.length > 10, `${why}: 400 (${e?.message?.slice(0, 70)})`);
  };
  rejects({ ...base, goal: "" }, "empty goal");
  rejects({ ...base, goal: "g".repeat(LOOP_LIMITS.goalChars + 1) }, "goal past the cap");
  rejects({ ...base, lastOutput: "" }, "empty lastOutput");
  rejects({ ...base, lastOutput: "o".repeat(LOOP_LIMITS.outputChars + 1) }, "lastOutput past the cap");
  rejects({ ...base, iteration: 0 }, "iteration 0");
  rejects({ ...base, iteration: 1.5 }, "fractional iteration");
  rejects({ ...base, iteration: "3" }, "iteration as a string");
  rejects({ ...base, maxIterations: 0 }, "maxIterations 0");
  rejects({ ...base, budget: { spentUsd: 1 } }, "budget without maxUsd");
  rejects({ ...base, budget: { spentUsd: -1, maxUsd: 1 } }, "negative spend");
  rejects({ ...base, budget: { spentUsd: 0, maxUsd: 0 } }, "maxUsd 0");
  rejects({ ...base, budget: "1" }, "budget as a string");
  rejects({ ...base, history: {} }, "history as an object");
  rejects({ ...base, history: Array.from({ length: LOOP_LIMITS.historyEntries + 1 }, (_, i) => ({ iteration: i + 1, summary: "s" })), iteration: 99 }, "history past the cap");
  rejects({ ...base, history: [{ iteration: 3, summary: "s" }] }, "a history entry at or after this iteration");
  rejects({ ...base, history: [{ iteration: 1, summary: "" }] }, "a history entry with no summary");
  rejects({ ...base, history: [{ iteration: 1, summary: "s".repeat(LOOP_LIMITS.summaryChars + 1) }] }, "a summary past the cap");
  rejects({ ...base, history: [{ iteration: 1, summary: "a" }, { iteration: 1, summary: "b" }] }, "the same iteration twice");
  rejects({ ...base, constraints: "no" }, "constraints as a string");
  rejects({ ...base, constraints: Array.from({ length: LOOP_LIMITS.constraints + 1 }, () => "c") }, "constraints past the cap");
  rejects({ ...base, constraints: [""] }, "an empty constraint");
  rejects([], "an array body");
  ok(validateLoopGateRequest({ goal: "g", lastOutput: { found: 2 }, iteration: 1 }).lastOutput === '{"found":2}', "an object lastOutput is serialized, not refused");
  const e = await fails({ ...base, iteration: 0 }, { fetchImpl: async () => { throw new Error("must not be called"); } });
  ok(e?.statusCode === 400, "the handler refuses before any model call");
  let pre = null;
  try { tool.validateInput({ ...base, goal: "" }); } catch (err) { pre = err; }
  ok(pre?.statusCode === 400, "validateInput (the paid gates' pre-check) refuses the same shapes");
}

// ---- model failure: an uncharged 5xx, never a decision ----------------------------
{
  const CANARY = "the buyer's own loop state echoed back";
  for (const [status, want] of [[500, 502], [429, 503], [401, 503]]) {
    const e = await fails(base, { fetchImpl: async () => ({ ok: false, status, text: async () => CANARY }) });
    ok(e?.statusCode === want && !e.message.includes(CANARY), `upstream ${status} is a ${want} and the body is not relayed`);
  }
  const t = await fails(base, { fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  ok(t?.statusCode === 503, "an unreachable upstream is a 503");
  const empty = await fails(base, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ model: "jev", answers: {} }) }) });
  ok(empty?.statusCode === 502, "a 200 with no answers is a 502, never a guessed decision");
  const partial = await fails(base, { fetchImpl: async (url, init) => { const b = JSON.parse(init.body); const answers = { goal_met: { type: "noul", noul: 0.2 }, stuck: { type: "noul", noul: 0.2 }, next_step: { type: "choice", choice: "teleport", confidence: 0.9 } }; return { ok: true, status: 200, text: async () => JSON.stringify({ answers, questions: b.questions }) }; } });
  ok(partial?.statusCode === 502, "a next step outside the published enum is a 502");
  let bad = null;
  try { composeDecision({ req: validateLoopGateRequest(base), checks: prepareLoopGate(base).checks }, { goal_met: { type: "noul", noul: 0.1 }, stuck: { type: "noul", noul: 0.1 }, next_step: { type: "choice", choice: "iterate" } }, "m"); } catch (e) { bad = e; }
  ok(bad?.statusCode === 502, "a choice with no confidence cannot be composed into a decision");
}

// ---- the money bound: the worst-case model request fits the judge's own caps ------
{
  const worst = {
    goal: "g".repeat(LOOP_LIMITS.goalChars),
    lastOutput: "o".repeat(LOOP_LIMITS.outputChars),
    iteration: LOOP_LIMITS.historyEntries + 1,
    maxIterations: LOOP_LIMITS.maxIterations,
    budget: { spentUsd: 123456.789, maxUsd: 999999.999 },
    history: Array.from({ length: LOOP_LIMITS.historyEntries }, (_, i) => ({ iteration: i + 1, summary: `${i} `.repeat(LOOP_LIMITS.summaryChars / 4).slice(0, LOOP_LIMITS.summaryChars) })),
    constraints: Array.from({ length: LOOP_LIMITS.constraints }, (_, i) => `${i}`.padEnd(LOOP_LIMITS.constraintChars, "c")),
  };
  const p = prepareLoopGate(worst);
  ok(p.request && p.request.state.length <= JUDGE_LIMITS.stateChars, `the largest state this route builds (${p.request.state.length} chars) stays under the judge's state cap (${JUDGE_LIMITS.stateChars})`);
  const bytes = Buffer.byteLength(JSON.stringify(p.request));
  ok(bytes <= JUDGE_LIMITS.bodyBytes, `and its body (${bytes} bytes) under the judge's byte bound (${JUDGE_LIMITS.bodyBytes})`);
  ok(JSON.parse(p.request.state).recentHistory.length === RECENT_HISTORY && JSON.parse(p.request.state).olderIterations === LOOP_LIMITS.historyEntries - RECENT_HISTORY, "the model reads the newest entries and is told how many older ones there are");
  validateJudgeRequest({ state: p.request.state, questions: p.request.questions });
  ok(true, "the judge accepts it as-is (the handler hands it over unchanged)");
  // Dense text (one token per byte, three bytes per character) past the byte
  // bound is refused in this route's own words, before any call.
  let dense = null;
  const cjk = (n) => "字".repeat(n);
  try {
    prepareLoopGate({ ...worst, goal: cjk(LOOP_LIMITS.goalChars), lastOutput: cjk(LOOP_LIMITS.outputChars), constraints: worst.constraints.map(() => cjk(LOOP_LIMITS.constraintChars)),
      history: worst.history.map((h) => ({ ...h, summary: cjk(LOOP_LIMITS.summaryChars - 4) + String(h.iteration).padStart(4, "0") })) });
  } catch (e) { dense = e; }
  ok(dense?.statusCode === 400 && /shorter lastOutput/.test(dense.message), `a body over the byte bound is a 400 naming this route's fields (${dense?.message?.slice(0, 80)})`);
  // The private table's Jev rate: the worst case must sit inside the price's
  // share. Under CI the table is present; locally this reads only when
  // UPSTREAM_COSTS_FILE or UPSTREAM_COSTS_JSON is set. Nothing prints a rate.
  const d = U.upstreamCosts().vendor?.decisions || {};
  if (U.upstreamCostsLoaded() && d.jev != null && d.maxShare != null) {
    ok((bytes * d.jev) / 1e6 <= d.maxShare * JUDGE_PRICE_USD, `at the table's Jev rate the worst case (${bytes} bytes at one token per byte) fits the price's share`);
  } else if (process.env.CI && process.env.UPSTREAM_COSTS_OPTIONAL !== "1") {
    ok(false, "under CI the private table must be loaded for the margin check (set UPSTREAM_COSTS_JSON or UPSTREAM_COSTS_FILE)");
  } else {
    console.log("SKIP - margin at the table's Jev rate: the private table is not loaded here");
  }
}

// ---- registration: declared model-backed, wallet-only, listed, CI-satisfiable ------
{
  const s = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const mb = s.slice(s.indexOf("const MODEL_BACKED_KITS = ["), s.indexOf("const MODEL_BACKED_KITS = [") + 600);
  ok(/\.\.\.LOOP_GATE_TOOLS/.test(mb), "loop-gate is in MODEL_BACKED_KITS, so /api/pricing publishes modelBacked:true");
  ok(/const ALL_KIT = \[[^\n]*\.\.\.LOOP_GATE_TOOLS/.test(s), "and in ALL_KIT, listed without a key (its code path answers; the model path is a 503 without one)");
  ok(/"loop-gate"/.test(readFileSync(new URL("../src/pow.js", import.meta.url), "utf8")), "wallet-only: it sells a model call, so it is never PoW-payable");
  ok(!/"loop-gate"/.test(readFileSync(new URL("../src/metered-slugs.js", import.meta.url), "utf8")), "not in METERED_SLUGS: the published example answers in code, so the keyless sweeps drive it");
  ok(/scripts\/test-loop-gate\.js/.test(readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8")), "this suite runs in CI");
  const probes = readFileSync(new URL("./test-report-probes.js", import.meta.url), "utf8");
  ok(/loop-gate-kit\.js/.test(probes) && /prepareLoopGate/.test(probes), "the probe lane drives the model path's input stage");
}

console.log(`\n${pass} passed`);
