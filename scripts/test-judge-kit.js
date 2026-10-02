// Typed judgment as a paid tool. The assertions that matter are the ones about
// MONEY and CLAIMS, because both are load-bearing here:
//
//   Margin is the input bound: the caps fix the worst-case upstream size before
//   the call.
//
//   It is model-backed and must say so. /api/pricing publishes `modelBacked` on
//   every row and the x402 manifest names what is excluded from the determinism
//   claim. A model-backed tool that is not declared makes both false.
//
//   node scripts/test-judge-kit.js
let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

const { validateJudgeRequest, judge, judgeEnabled, LIMITS, JUDGE_TOOLS } = await import("../src/tools/judge-kit.js");
const MAX_TOKENS_PER_CALL = 16_600;   // the per-call token budget the price allows

// --- the caps ARE the margin guard -------------------------------------------
{
  // ~3.6 chars per token is the conservative direction for English; the point is
  // the order of magnitude, not a tokenizer.
  const worstStateTokens = LIMITS.stateChars / 3.6;
  const worstQuestionTokens = LIMITS.questions * ((LIMITS.instructionChars + LIMITS.criteriaEntries * LIMITS.criteriaChars) / 3.6);
  const worst = worstStateTokens + worstQuestionTokens;
  ok(worst <= MAX_TOKENS_PER_CALL, `the admitted worst case stays inside the per-call token budget (~${Math.round(worst)} tok)`);
  ok(LIMITS.stateChars <= 20_000 && LIMITS.questions <= 16,
    "the caps are set at all, so worst-case upstream is knowable before the call");
  // A token can be ONE BYTE (CJK, emoji, base64), so the byte bound is the money
  // bound and the character caps only bound the shape.
  ok(LIMITS.bodyBytes <= MAX_TOKENS_PER_CALL, `the byte bound holds at one token per byte (${LIMITS.bodyBytes} bytes)`);
}

// --- validation refuses BEFORE any upstream call ------------------------------
const base = { state: "x", questions: { a: { type: "noul", instructions: "Is this a test?" } } };
const rejects = (input, why) => {
  let msg = null;
  try { validateJudgeRequest(input); } catch (e) { msg = e.message; ok(e.statusCode === 400, `${why}: refused as a 400 (so settlement is cancelled and nobody pays)`); }
  ok(msg, `${why}: refused`);
  return msg;
};
ok(validateJudgeRequest(base).questions.a.type === "noul", "control: a valid noul passes");
rejects({ ...base, state: "" }, "empty state");
rejects({ ...base, state: "x".repeat(LIMITS.stateChars + 1) }, "state past the cap");
rejects({ ...base, state: "\u5b57".repeat(6_000) }, "a state under the character cap but over the byte bound");
rejects({ state: "x", questions: {} }, "no questions");
rejects({ state: "x", questions: Object.fromEntries(Array.from({ length: LIMITS.questions + 1 }, (_, i) => [i, { type: "noul", instructions: "q" }])) }, "too many questions");
rejects({ state: "x", questions: { a: { type: "noul" } } }, "no instructions");
rejects({ state: "x", questions: { a: { type: "bogus", instructions: "q" } } }, "unknown type");
rejects({ state: "x", questions: { a: { type: "choice", instructions: "q" } } }, "choice with no criteria");
rejects({ state: "x", questions: { a: { type: "choice", instructions: "q", criteria: { only: "one" } } } }, "choice with one option");
rejects({ state: "x", questions: { a: { type: "score", instructions: "q", criteria: { not: "an array" } } } }, "score with a map instead of an array");
rejects({ state: "x", questions: { a: { type: "score", instructions: "q", criteria: Array.from({ length: 11 }, (_, i) => `l${i}`) } } }, "score past the API's own 10 levels");
// A noul takes no criteria, and silently dropping them would hide a caller's bug.
rejects({ state: "x", questions: { a: { type: "noul", instructions: "q", criteria: ["a", "b"] } } }, "noul given criteria");

// --- truncation is bounded, not unbounded -------------------------------------
{
  const v = validateJudgeRequest({ state: "x", questions: { a: { type: "choice", instructions: "q", criteria: { one: "y".repeat(9_999), two: "z" } } } });
  ok(v.questions.a.criteria.one.length === LIMITS.criteriaChars, "an oversized option description is truncated to the cap, never passed through");
}
{
  const v = validateJudgeRequest({ state: { nested: { object: true } }, questions: base.questions });
  ok(typeof v.state === "string" && v.state.includes("nested"), "an object state is serialised rather than refused");
}

// --- no key, no call ----------------------------------------------------------
delete process.env.TYPESAFE_API_KEY;
ok(judgeEnabled() === false, "control: no key, feature off");
{
  let code = null, called = false;
  try { await judge(base, { fetchImpl: async () => { called = true; } }); } catch (e) { code = e.statusCode; }
  ok(code === 503, "with no key it is a 503 (our configuration), not a 4xx blaming the caller");
  ok(!called, "and NOT ONE upstream call is made");
}

// --- upstream failures are relayed by CLASS, never by body --------------------
process.env.TYPESAFE_API_KEY = "ts_test";
const CANARY = "the buyer's own confidential state echoed back";
const stubStatus = (status) => async () => ({ ok: false, status, text: async () => CANARY });
for (const [status, want, why] of [[401, 503, "a refused key is OUR problem, a 503"], [403, 503, "same for a forbidden"], [429, 503, "upstream throttling is a 503, retryable"], [400, 400, "an upstream 4xx is the caller's request shape"], [500, 502, "an upstream 5xx is a 502"]]) {
  let e = null;
  try { await judge(base, { fetchImpl: stubStatus(status) }); } catch (err) { e = err; }
  ok(e?.statusCode === want, `${why} (${status} -> ${e?.statusCode})`);
  ok(!e.message.includes(CANARY), `and the upstream body is NOT relayed to the buyer (${status})`);
}
{
  let e = null;
  try { await judge(base, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => "not json" }) }); } catch (err) { e = err; }
  ok(e?.statusCode === 502, "an unreadable body is a 502, never a silent empty answer");
  e = null;
  try { await judge(base, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ model: "jev-latest" }) }) }); } catch (err) { e = err; }
  ok(e?.statusCode === 502, "a 200 with no answers is a 502, never returned as a successful judgment");
}
{
  let e = null;
  try { await judge(base, { fetchImpl: async () => { throw new TypeError("fetch failed"); } }); } catch (err) { e = err; }
  ok(e?.statusCode === 502, "an unreachable upstream is a 502 (theirs), not a bare 500 (ours)");
  const t = new Error("The operation was aborted due to timeout"); t.name = "TimeoutError";
  e = null;
  try { await judge(base, { fetchImpl: async () => { throw t; } }); } catch (err) { e = err; }
  ok(e?.statusCode === 504, "a timed-out upstream is a 504");
}

// --- the answer passes through intact -----------------------------------------
{
  const live = { model: "jev-1.13.0", answers: { severity: { type: "score", score: 1.46, probabilities: [0.1, 0.5, 0.4], confidence: 0.3 } }, usage: { input_tokens: 363, output_tokens: 37 } };
  const out = await judge(base, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(live) }) });
  ok(out.answers.severity.score === 1.46 && out.answers.severity.confidence === 0.3, "the typed answer reaches the buyer unchanged");
  ok(out.usage.input_tokens === 363, "usage rides along so a buyer can budget their own calls");
  ok(/noul carries/.test(out.note) && /no confidence/.test(out.note),
    "and the note states the one thing the docs make easy to get wrong: a noul has no confidence");
}

// --- the tool declares itself honestly ----------------------------------------
{
  const t = JUDGE_TOOLS[0];
  ok(t.slug === "judge" && t.route === "POST /v1/judge" && t.price === "$0.001", "route, slug and price are declared");
  ok(/not deterministic|model-backed/i.test(t.description),
    "the description says it is MODEL-BACKED: this catalog's headline claim is that its tools are deterministic, and this one is not");
  const ex = t.discovery.example;
  ok(ex.answers.severity.confidence !== undefined && ex.answers.is_reproducible.noul !== undefined,
    "the published example shows a score WITH confidence and a noul WITHOUT, matching the real wire");
  ok(ex.answers.is_reproducible.confidence === undefined, "and never invents a confidence on the noul");
  const sev = ex.answers.severity;
  ok(sev.probabilities && !Array.isArray(sev.probabilities) && typeof sev.probabilities === "object"
    && Object.keys(sev.probabilities).length === 3 && sev.legend && Object.keys(sev.legend).length === 3,
    "score probabilities are keyed by level index with a legend beside them, as the real wire returns (the typed schema is derived from this example)");
}

// --- registration: a model-backed tool must be DECLARED so ---------------------
{
  const { readFileSync } = await import("node:fs");
  const s = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const mb = s.slice(s.indexOf("const MODEL_BACKED_KITS = ["), s.indexOf("const MODEL_BACKED_KITS = [") + 400);
  ok(/JUDGE_TOOLS/.test(mb), "judge is in MODEL_BACKED_KITS, so /api/pricing publishes modelBacked:true and the manifest claim stays true");
  ok(/const JUDGE_TOOLS_ENABLED = judgeEnabled\(\)/.test(s), "listing is gated on the key: a tool we cannot serve is not advertised");
  ok(s.indexOf("const JUDGE_TOOLS_ENABLED") < s.indexOf("const ALL_KIT = ["),
    "and it is declared BEFORE ALL_KIT uses it (a const used above its declaration is a TDZ crash at boot, which node --check cannot see)");
  const pow = readFileSync(new URL("../src/pow.js", import.meta.url), "utf8");
  ok(/"judge"/.test(pow), "judge is wallet-only: it spends upstream, so it is never PoW-payable on the free tier");
  const sweep = readFileSync(new URL("../src/metered-slugs.js", import.meta.url), "utf8"); // METERED_SLUGS lives in src/
  ok(/"judge"/.test(sweep), "and it is in METERED_SLUGS, because CI holds no key and a 503 there is a hard failure");
}

console.log(`\n${pass} passed`);
