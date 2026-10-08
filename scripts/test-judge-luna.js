#!/usr/bin/env node
// /v1/judge and /v1/decisions: OpenAI's Decisions API (gpt-6-luna) first, Jev
// as the fallback, one answer shape per route. Offline: both upstreams are a
// stubbed fetch, and the cost table is a test table with placeholder rates.
import { readFileSync } from "node:fs";

process.env.OPENAI_API_KEY = "sk-test-not-real";
process.env.TYPESAFE_API_KEY = "ts-test-not-real";
const { setUpstreamCostsForTest, upstreamCostsGaps } = await import("../src/upstream-costs.js");
const kit = await import("../src/tools/judge-kit.js");
const { judge, decisions, lunaFits, lunaEnabled, judgeEnabled, LUNA, JUDGE_TOOLS, JUDGE_PRICE_USD } = kit;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const quiet = console.warn; console.warn = () => {};

const RATE = 1; // placeholder, the same as docs/example-upstream-costs.json
const table = (luna) => ({ models: [["fake/model", { prompt: 1, completion: 1 }]], vendor: luna == null ? {} : { decisions: { luna } } });
setUpstreamCostsForTest(table(RATE));

const OPENAI = "api.openai.com", TYPESAFE = "api.typesafe.ai";
const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
function stub(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const host = new URL(url).host;
    calls.push({ host, body: JSON.parse(init.body) });
    if (!(host in routes)) throw new Error(`unexpected ${host}`);
    const r = routes[host];
    if (r === null) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return typeof r === "function" ? r(JSON.parse(init.body)) : r;
  };
  return { calls, fetchImpl, hosts: () => calls.map((c) => c.host) };
}

const JUDGE_IN = {
  state: "The export button crashes the settings page in Safari.",
  questions: {
    "sev.level": { type: "score", instructions: "How severe?", criteria: ["Cosmetic", "Workaround exists", "Blocking"] },
    "repro?": { type: "noul", instructions: "Are there repro steps?" },
    team: { type: "choice", instructions: "Which team?", criteria: { frontend: "UI", backend: "APIs" } },
  },
};
const LUNA_ANSWERS = { answers: [
  { type: "score", name: "q0", score: 1.27, probabilities: [{ value: 0, label: "0", probability: 0.15 }, { value: 1, label: "1", probability: 0.43 }, { value: 2, label: "2", probability: 0.42 }], confidence: 0.15 },
  { type: "predicate", name: "q1", probability: 0.02 },
  { type: "choice", name: "q2", choice: "frontend", probabilities: [{ value: "frontend", probability: 0.98 }, { value: "backend", probability: 0.02 }], confidence: 0.97 },
], usage: { input_tokens: 300, output_tokens: 0 } };
const JEV_ANSWERS = { model: "jev-1.13.0", answers: {
  "sev.level": { type: "score", score: 1.4, confidence: 0.4, legend: { 0: "Cosmetic", 1: "Workaround exists", 2: "Blocking" }, probabilities: { 0: 0, 1: 0.6, 2: 0.4 } },
  "repro?": { type: "noul", noul: 0.32 },
  team: { type: "choice", choice: "frontend", confidence: 1, probabilities: { frontend: 1, backend: 0 } },
}, usage: { input_tokens: 290, output_tokens: 37 } };

// ---- configuration and the cost bound -------------------------------------
{
  ok(judgeEnabled() && lunaEnabled(), "with both keys and the Luna rate, both backends are enabled");
  const cap = Math.floor((0.7 * JUDGE_PRICE_USD * 1e6) / RATE);
  ok(lunaFits(cap) && !lunaFits(cap + 1), `Luna is tried only while its worst case fits the price with 30% margin (${cap} bytes at the test rate)`);
  setUpstreamCostsForTest(table(null));
  ok(!lunaEnabled() && judgeEnabled(), "without the Luna rate Luna is not offered, and Jev still serves");
  ok(upstreamCostsGaps().includes("vendor.decisions.luna"), "a table without the Luna rate reads partial (vendor.decisions.luna is a gap)");
  setUpstreamCostsForTest(table(RATE));
}

// ---- /v1/judge: Luna first ------------------------------------------------
{
  const s = stub({ [OPENAI]: json(200, LUNA_ANSWERS) });
  const r = await judge(JUDGE_IN, { fetchImpl: s.fetchImpl });
  ok(s.hosts().join() === OPENAI, "the default call goes to Luna only");
  const sent = s.calls[0].body;
  ok(sent.model === LUNA && sent.input === JUDGE_IN.state, "Luna receives the state as input");
  ok(sent.questions.map((q) => `${q.name}:${q.type}`).join() === "q0:score,q1:predicate,q2:choice", "question ids go positional (q0..), noul becomes predicate");
  ok(sent.questions[0].levels.map((l) => l.description).join("|") === "Cosmetic|Workaround exists|Blocking", "score criteria become ordered levels");
  ok(JSON.stringify(sent.questions[2].choices) === JSON.stringify([{ value: "frontend", description: "UI" }, { value: "backend", description: "APIs" }]), "choice criteria become value/description choices");
  ok(r.model === LUNA && !("fallbackFrom" in r), "the answer names Luna and no fallback");
  ok(r.answers["repro?"].type === "noul" && r.answers["repro?"].noul === 0.02, "a predicate answer comes back as a noul under the buyer's own id");
  ok(r.answers.team.choice === "frontend" && r.answers.team.probabilities.backend === 0.02, "a choice answer keeps probabilities keyed by option");
  ok(r.answers["sev.level"].score === 1.27 && r.answers["sev.level"].probabilities[1] === 0.43 && r.answers["sev.level"].legend[2] === "Blocking", "a score answer carries probabilities by level index and the legend");
  ok(r.usage.input_tokens === 300 && r.usage.output_tokens === 0, "usage is reported");
}

// ---- /v1/judge: fallback ---------------------------------------------------
for (const [why, lunaReply] of [
  ["a Luna 5xx", json(503, { error: { message: "down" } })],
  ["a Luna 429", json(429, { error: { message: "slow down" } })],
  ["a Luna 401", json(401, {})],
  ["a refused Luna connection", null],
]) {
  const s = stub({ [OPENAI]: lunaReply, [TYPESAFE]: json(200, JEV_ANSWERS) });
  const r = await judge(JUDGE_IN, { fetchImpl: s.fetchImpl });
  ok(s.hosts().join() === `${OPENAI},${TYPESAFE}` && r.model === "jev-1.13.0" && r.fallbackFrom === LUNA, `${why} falls back to Jev, named in fallbackFrom`);
  ok(s.calls[1].body.model === "jev-latest", "...and Jev is asked as jev-latest, never with Luna's name");
}
// After Luna answered 200 (billed) or timed out (maybe billed), the call ends
// as an uncharged 502/504 and Jev is never asked: one sale, one upstream.
for (const [why, lunaReply, code] of [
  ["a Luna refusal answer", json(200, { answers: [{ type: "refusal", name: "q0" }, ...LUNA_ANSWERS.answers.slice(1)] }), 502],
  ["an unreadable Luna body", { ok: true, status: 200, text: async () => "not json" }, 502],
  ["a Luna choice outside the options", json(200, { answers: [LUNA_ANSWERS.answers[0], LUNA_ANSWERS.answers[1], { ...LUNA_ANSWERS.answers[2], choice: "zzz" }] }), 502],
  ["a Luna answer missing a question", json(200, { answers: LUNA_ANSWERS.answers.slice(0, 2) }), 502],
  ["a Luna probability above 1", json(200, { answers: [LUNA_ANSWERS.answers[0], { type: "predicate", name: "q1", probability: 1.4 }, LUNA_ANSWERS.answers[2]] }), 502],
]) {
  const s = stub({ [OPENAI]: lunaReply, [TYPESAFE]: json(200, JEV_ANSWERS) });
  let e = null; try { await judge(JUDGE_IN, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
  ok(e?.statusCode === code && s.hosts().join() === OPENAI, `${why} is an uncharged ${code} and Jev is not called`);
}
{
  const s = stub({ [OPENAI]: () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }, [TYPESAFE]: json(200, JEV_ANSWERS) });
  let e = null; try { await judge(JUDGE_IN, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
  ok(e?.statusCode === 504 && s.hosts().join() === OPENAI, "a Luna timeout is an uncharged 504 and Jev is not called (the timed-out call may be billed)");
}
{
  const s = stub({ [TYPESAFE]: json(200, { model: "jev-1.13.0", answers: {} }) });
  let e = null; try { await judge({ ...JUDGE_IN, model: "jev-latest" }, { fetchImpl: (u, i) => new URL(u).host === OPENAI ? Promise.reject(new Error("no")) : s.fetchImpl(u, i) }); } catch (x) { e = x; }
  ok(e?.statusCode === 502, "an empty Jev answer is an uncharged 502, never a charged 200");
}
{
  const s = stub({ [OPENAI]: json(200, LUNA_ANSWERS), [TYPESAFE]: json(503, {}) });
  const r = await judge({ ...JUDGE_IN, model: "jev-latest" }, { fetchImpl: s.fetchImpl });
  ok(s.hosts().join() === `${TYPESAFE},${OPENAI}` && r.model === LUNA && r.fallbackFrom === "jev-latest", "a buyer who names jev-latest gets Jev first and Luna as fallback");
}
{
  const s = stub({ [OPENAI]: json(503, {}), [TYPESAFE]: json(503, {}) });
  let e = null; try { await judge(JUDGE_IN, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
  ok(e?.statusCode >= 500 && s.calls.length === 2, "both down is an uncharged 5xx after one try each");
}
{
  const big = { ...JUDGE_IN, state: "x".repeat(7500) };
  const s = stub({ [OPENAI]: json(200, LUNA_ANSWERS), [TYPESAFE]: json(200, JEV_ANSWERS) });
  const r = await judge(big, { fetchImpl: s.fetchImpl });
  ok(s.hosts().join() === TYPESAFE && r.model === "jev-1.13.0" && !("fallbackFrom" in r), "a request too large for Luna's margin goes to Jev only, and is not a fallback");
}
{
  const s = stub({ [OPENAI]: json(400, { error: { message: "bad" } }) });
  let e = null; try { await judge({ ...JUDGE_IN, model: "nope" }, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
  ok(e?.statusCode === 400 && s.calls.length === 0, "an invalid request is a 400 before any upstream call");
}

// ---- /v1/decisions ---------------------------------------------------------
const DEC_IN = {
  input: "I was charged twice for my order.",
  questions: [
    { type: "choice", name: "department", instructions: "Which department?", choices: [{ value: "billing", description: "Payments." }, { value: "technical", description: "Product problems." }] },
    { type: "predicate", name: "angry", instructions: "Is the customer angry?" },
    { type: "score", name: "urgency", instructions: "How urgent?", levels: [{ label: "Low", description: "Can wait." }, { label: "High", description: "Today." }] },
  ],
};
{
  const reply = { answers: [{ type: "choice", name: "department", choice: "billing", probabilities: [{ value: "billing", probability: 0.95 }, { value: "technical", probability: 0.05 }], confidence: 0.93 }, { type: "predicate", name: "angry", probability: 0.4 }, { type: "score", name: "urgency", score: 0.7, probabilities: [{ value: 0, label: "Low", probability: 0.3 }, { value: 1, label: "High", probability: 0.7 }], confidence: 0.4 }], usage: { input_tokens: 150, output_tokens: 0, total_tokens: 150 } };
  const s = stub({ [OPENAI]: json(200, reply) });
  const r = await decisions(DEC_IN, { fetchImpl: s.fetchImpl });
  ok(s.hosts().join() === OPENAI && s.calls[0].body.questions[0].name === "department", "the Decisions wire sends the buyer's own question names to Luna");
  ok(JSON.stringify(r.answers) === JSON.stringify(reply.answers) && r.model === LUNA, "Luna's answers come back unchanged");
}
{
  const jev = { model: "jev-1.13.0", answers: { department: { type: "choice", choice: "billing", confidence: 0.9, probabilities: { billing: 0.95, technical: 0.05 } }, angry: { type: "noul", noul: 0.4 }, urgency: { type: "score", score: 0.7, confidence: 0.4, legend: {}, probabilities: { 0: 0.3, 1: 0.7 } } }, usage: { input_tokens: 140 } };
  const s = stub({ [OPENAI]: json(500, {}), [TYPESAFE]: json(200, jev) });
  const r = await decisions(DEC_IN, { fetchImpl: s.fetchImpl });
  const [d, a, u] = r.answers;
  ok(r.fallback_from === LUNA && r.model === "jev-1.13.0", "a Luna outage falls back to Jev, named in fallback_from");
  ok(d.type === "choice" && d.name === "department" && d.probabilities.map((p) => p.value).join() === "billing,technical" && d.confidence === 0.9, "Jev's choice comes back in the Decisions shape, probabilities in the buyer's choice order");
  ok(a.type === "predicate" && a.probability === 0.4, "Jev's noul comes back as a predicate probability");
  ok(u.type === "score" && u.probabilities[1].label === "High" && u.probabilities[1].probability === 0.7, "Jev's score comes back with the buyer's level labels");
  ok(s.calls[1].body.questions.urgency.criteria.join("|") === "Low: Can wait.|High: Today.", "Jev reads each level as label plus description");
}
for (const [why, input] of [
  ["an image part", { ...DEC_IN, input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA" }] }] }],
  ["a duplicate name", { ...DEC_IN, questions: [DEC_IN.questions[1], DEC_IN.questions[1]] }],
  ["a bad name", { ...DEC_IN, questions: [{ ...DEC_IN.questions[1], name: "has space" }] }],
  ["another model", { ...DEC_IN, model: "gpt-6" }],
  ["an unknown type", { ...DEC_IN, questions: [{ type: "rank", name: "x", instructions: "?" }] }],
  ["no questions", { input: "x", questions: [] }],
  ["non-string instructions", { ...DEC_IN, questions: [{ type: "predicate", name: "x", instructions: { a: 1 } }] }],
  ["string levels", { ...DEC_IN, questions: [{ type: "score", name: "x", instructions: "?", levels: ["low", "high"] }] }],
  ["a duplicate choice value", { ...DEC_IN, questions: [{ type: "choice", name: "x", instructions: "?", choices: [{ value: "a" }, { value: "a" }, { value: "b" }] }] }],
  ["an over-long description", { ...DEC_IN, questions: [{ type: "choice", name: "x", instructions: "?", choices: [{ value: "a", description: "d".repeat(5000) }, { value: "b" }] }] }],
]) {
  const s = stub({});
  let e = null; try { await decisions(input, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
  ok(e?.statusCode === 400 && s.calls.length === 0, `the Decisions wire refuses ${why} with a 400 before any upstream call`);
}
{
  const s = stub({ [OPENAI]: json(200, {}) });
  const r = await decisions({ input: [{ role: "user", content: [{ type: "input_text", text: "Part one." }, { type: "input_text", text: "Part two." }] }], questions: [DEC_IN.questions[1]] }, { fetchImpl: s.fetchImpl }).catch((e) => e);
  ok(s.calls[0]?.body.input === "Part one.\n\nPart two.", "message parts are joined into one text input");
  ok(r?.statusCode >= 500, "a Luna body with no answers is a failure, not an empty 200");
}

for (const [why, answers] of [
  ["an empty answer list", []],
  ["a refusal", [{ type: "refusal", name: "department" }, { type: "predicate", name: "angry", probability: 0.4 }, { type: "score", name: "urgency", score: 0.7, probabilities: [], confidence: 0.4 }]],
  ["a missing question", [{ type: "predicate", name: "angry", probability: 0.4 }]],
]) {
  const s = stub({ [OPENAI]: json(200, { answers }), [TYPESAFE]: json(200, {}) });
  let e = null; try { await decisions(DEC_IN, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
  ok(e?.statusCode === 502 && s.hosts().join() === OPENAI, `the Decisions wire turns ${why} into an uncharged 502, without a second upstream`);
}

// ---- registration ----------------------------------------------------------
{
  const t = JUDGE_TOOLS.find((x) => x.slug === "decisions");
  ok(t?.route === "POST /v1/decisions" && t.price === "$0.001" && /Model-backed/.test(t.description), "/v1/decisions is declared at the judge price and says it is model-backed");
  ok(JUDGE_TOOLS[0].slug === "judge", "judge stays the first entry");
  const pow = readFileSync(new URL("../src/pow.js", import.meta.url), "utf8");
  const metered = readFileSync(new URL("../src/metered-slugs.js", import.meta.url), "utf8");
  ok(/"decisions"/.test(pow) && /"decisions"/.test(metered), "decisions is wallet-only and kept out of the CI sweeps (it spends upstream)");
}

console.warn = quiet;
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
