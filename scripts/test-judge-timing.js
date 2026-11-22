#!/usr/bin/env node
// Judge timing (src/judge-timing.js): every backend read of a judgment is
// timed, and so is the whole walk across backends, so a deadline can be sized
// from what the backends take. p50 and p95 per backend, how each read ended,
// how long a served call took end to end and how many backends it tried, and
// how often the first backend was not the one that answered. Operator view
// only; an hourly log line keeps the figures across deploys.
// Offline: both upstreams are a stubbed fetch on a test cost table.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";

process.env.OPENAI_API_KEY = "sk-test-not-real";
process.env.TYPESAFE_API_KEY = "ts-test-not-real";
delete process.env.OPENROUTER_API_KEY;
const { setUpstreamCostsForTest } = await import("../src/upstream-costs.js");
setUpstreamCostsForTest({ models: [["fake/model", { prompt: 1, completion: 1 }]], vendor: { decisions: { luna: 1, maxShare: 1 } } });
const kit = await import("../src/tools/judge-kit.js");
const T = await import("../src/judge-timing.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

// --- the percentile math on fixed samples ---------------------------------------
T.__resetJudgeTiming();
for (let i = 1; i <= 100; i++) T.noteJudgeBackend("jev", i * 10, "ok", 1_000);
{
  const s = T.judgeTimingReport({ now: 2_000 });
  ok(s.backends.jev.n === 100 && s.backends.jev.p50Ms === 500 && s.backends.jev.p95Ms === 950 && s.backends.jev.maxMs === 1000, `p50, p95 and the slowest read come from the kept samples (${JSON.stringify(s.backends.jev)})`);
  ok(s.backends.jev.outcomes.ok === 100 && s.backends.jev.outcomes.failed === 0 && s.backends.jev.outcomes.unconfirmed === 0, "each read's outcome is counted");
}
T.__resetJudgeTiming();
for (let i = 0; i < T.JUDGE_TIMING_SAMPLES + 50; i++) T.noteJudgeBackend("luna", i < 50 ? 99_999 : 100, "ok", 1_000);
{
  const s = T.judgeTimingReport({ now: 2_000 });
  ok(s.backends.luna.n === T.JUDGE_TIMING_SAMPLES && s.backends.luna.maxMs === 100 && s.backends.luna.total === T.JUDGE_TIMING_SAMPLES + 50, "the newest samples are kept, bounded, and the total keeps counting");
}
T.__resetJudgeTiming();
T.noteJudgeBackend("nonsense", 5, "ok", 1); T.noteJudgeBackend("jev", -1, "ok", 1); T.noteJudgeBackend("jev", NaN, "ok", 1); T.noteJudgeBackend("jev", 5, "strange", 1);
{
  const s = T.judgeTimingReport({ now: 2 });
  ok(Object.keys(s.backends).length === 1 && s.backends.jev.n === 1 && s.backends.jev.outcomes.failed === 1, `only a known backend and a real duration are recorded; an unknown outcome counts as failed (${JSON.stringify(s.backends)})`);
  ok(s.walks.n === 0 && s.walks.p50Ms === null && s.walks.p95Ms === null, "no walk yet: no figure, never a zero");
}

// --- the real walk: Jev answers ---------------------------------------------------
const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const JUDGE_IN = { state: "The export button crashes the settings page.", questions: { team: { type: "choice", instructions: "Which team?", criteria: { frontend: "UI", backend: "APIs" } } } };
const JEV_OK = { model: "jev-1.14.0", answers: { team: { type: "choice", choice: "frontend", confidence: 1, probabilities: { frontend: 1, backend: 0 } } }, usage: { input_tokens: 10, output_tokens: 1 } };
const LUNA_OK = { answers: [{ type: "choice", name: "q0", choice: "frontend", probabilities: [{ value: "frontend", probability: 0.98 }, { value: "backend", probability: 0.02 }], confidence: 0.97 }], usage: { input_tokens: 10, output_tokens: 0 } };
const stub = (routes) => async (url) => { const r = routes[new URL(url).host]; return typeof r === "function" ? r() : r; };
const quiet = console.warn; console.warn = () => {};

T.__resetJudgeTiming();
{
  const out = await kit.judge(JUDGE_IN, { fetchImpl: stub({ "api.typesafe.ai": async () => { await wait(30); return json(200, JEV_OK); } }) });
  const s = T.judgeTimingReport();
  ok(out.answers.team.choice === "frontend" && s.backends.jev?.n === 1 && s.backends.jev.outcomes.ok === 1 && s.backends.jev.p50Ms >= 25, `a served judgment times the backend that answered (${JSON.stringify(s.backends.jev)})`);
  ok(s.walks.n === 1 && s.walks.served === 1 && s.walks.fallbackServed === 0 && s.walks.byBackendsTried["1"] === 1 && s.walks.p50Ms >= 25, `and the walk: one backend tried, no fallback (${JSON.stringify(s.walks)})`);
}
// --- Jev refuses, Luna answers: both reads are timed and the walk is a fallback ---
{
  const out = await kit.judge(JUDGE_IN, { fetchImpl: stub({ "api.typesafe.ai": async () => { await wait(20); return json(503, { error: "down" }); }, "api.openai.com": async () => { await wait(20); return json(200, LUNA_OK); } }) });
  const s = T.judgeTimingReport();
  ok(out.fallbackFrom === "jev-latest" && s.backends.jev.outcomes.failed === 1 && s.backends.luna?.outcomes.ok === 1, `a failed read and the read that answered are both timed (${JSON.stringify({ jev: s.backends.jev.outcomes, luna: s.backends.luna?.outcomes })})`);
  ok(s.walks.n === 2 && s.walks.fallbackServed === 1 && s.walks.byBackendsTried["2"] === 1 && s.walks.fallbacks["jev>luna"] === 1 && s.walks.maxMs >= 35, `the walk counts the fallback, from the first backend to the one that answered, and its whole time (${JSON.stringify(s.walks)})`);
}
// --- every backend fails: the walk is counted as not served --------------------------
{
  let e = null;
  try { await kit.judge(JUDGE_IN, { fetchImpl: stub({ "api.typesafe.ai": json(503, {}), "api.openai.com": json(503, {}) }) }); } catch (x) { e = x; }
  const s = T.judgeTimingReport();
  ok(e && s.walks.n === 3 && s.walks.served === 2 && s.walks.notServed === 1, `a walk no backend answered is counted, not served (${JSON.stringify({ n: s.walks.n, served: s.walks.served, notServed: s.walks.notServed })})`);
}
// --- the OpenAI-wire route is timed through the same walk ------------------------------
{
  const before = T.judgeTimingReport().walks.n;
  await kit.decisions({ model: "gpt-6-luna", input: "hello", questions: [{ name: "q", type: "predicate", instructions: "Is it a greeting?" }] }, { fetchImpl: stub({ "api.openai.com": json(200, { answers: [{ type: "predicate", name: "q", probability: 0.9 }], usage: { input_tokens: 5, output_tokens: 0 } }) }) }).catch(() => {});
  ok(T.judgeTimingReport().walks.n === before + 1, "a /v1/decisions call is one more walk");
}
console.warn = quiet;

// --- the hourly log line ---------------------------------------------------------------
T.__resetJudgeTiming();
{
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    T.noteJudgeBackend("jev", 100, "ok", 0); T.noteJudgeWalk({ ms: 100, tried: ["jev"], served: "jev", now: 0 });
    T.noteJudgeBackend("jev", 300, "ok", 30 * 60_000); T.noteJudgeWalk({ ms: 300, tried: ["jev"], served: "jev", now: 30 * 60_000 });
    const early = lines.filter((l) => l.startsWith("[judge] timing")).length;
    T.noteJudgeBackend("luna", 700, "ok", 61 * 60_000); T.noteJudgeWalk({ ms: 900, tried: ["jev", "luna"], served: "luna", now: 61 * 60_000 });
    T.noteJudgeWalk({ ms: 100, tried: ["jev"], served: "jev", now: 62 * 60_000 });
    console.log = realLog;
    const timing = lines.filter((l) => l.startsWith("[judge] timing"));
    ok(early === 0 && timing.length === 1, `one line an hour at most (${timing.length})`);
    ok(/jev n=2 p50=\d+ms p95=\d+ms/.test(timing[0] || "") && /luna n=1/.test(timing[0] || "") && /walks n=3 p50=\d+ms p95=\d+ms fallback=1/.test(timing[0] || ""), `the line carries each backend's count, p50 and p95, and the walk's (${timing[0]})`);
  } finally { console.log = realLog; }
}

// --- operator only, and judge stays off the referral routes -----------------------------
{
  const server = read("../src/server.js");
  ok(/app\.get\("\/__operator\/judge-timing\.json", \(req, res\) => \{\s*if \(!operatorAuthed\(req\)\) return operatorNotFound\(req, res\);/.test(server), "the figures are served on a token-authed operator route registered on the app");
  ok(!/judgeTiming/.test(read("../src/discovery.js")) && !/judge-timing/.test(read("../src/seo.js")), "no public surface carries them");
  const judgeTool = kit.JUDGE_TOOLS.find((t) => t.slug === "judge");
  ok(!!judgeTool && judgeTool.endsAtCeiling !== true && kit.JUDGE_TOOLS.every((t) => t.endsAtCeiling !== true), "no judge route carries the mark a referral copy needs: judge is not sold on the referral routes");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
