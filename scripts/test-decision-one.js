#!/usr/bin/env node
// Microsoft Decision-1 (src/decision-one.js): the shared client, the internal
// fallback at every Jev call site, and the third backend on /v1/judge and
// /v1/decisions. The assertions that matter:
//
//   The fallback fires only when Jev failed, never when it answered.
//   One sale never pays two upstreams: after a call that may have billed (a
//   timeout, a 200 we could not use) no further backend is asked.
//   No private rate, no Decision-1 on the paid route.
//   The body Decision-1 receives is Jev's body with only `model` changed, and
//   it carries the OpenRouter attribution headers.
//
// Offline: every upstream is a stubbed fetch, and the cost table is a test
// table with placeholder rates.
//
//   node scripts/test-decision-one.js
process.env.TYPESAFE_API_KEY = "ts-test-not-real";
process.env.OPENROUTER_API_KEY = "or-test-not-real";
process.env.OPENAI_API_KEY = "sk-test-not-real";
delete process.env.DECIDE_OPENROUTER_API_KEY;
delete process.env.DECIDE_TYPESAFE_API_KEY;
delete process.env.DECISION_ONE;
delete process.env.DECISION_ONE_URL;
delete process.env.JEV_DAILY_MAX_TOKENS;
delete process.env.ROUTE_JUDGE;

const { setUpstreamCostsForTest, upstreamCostsGaps } = await import("../src/upstream-costs.js");
const { OPENROUTER_ATTRIBUTION } = await import("../src/openrouter-attribution.js");
const { askDecisionOne, decisionOneEnabled, DECISION_ONE_MODEL } = await import("../src/decision-one.js");
const toolJudge = await import("../src/tool-judge.js");
const rerank = await import("../src/discovery-rerank.js");
const wish = await import("../src/wish-classify.js");
const { makeJevJudge, jevQuestions } = await import("../services/decide/jev.js");
const kit = await import("../src/tools/judge-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const quiet = console.warn; console.warn = () => {};

const RATE = 1;  // placeholder, the same as docs/example-upstream-costs.json
const SHARE = 1; // placeholder, the same as docs/example-upstream-costs.json
const table = ({ luna = RATE, decisionOne = RATE } = {}) => ({
  models: [["fake/model", { prompt: 1, completion: 1 }]],
  vendor: { decisions: { ...(luna == null ? {} : { luna }), ...(decisionOne == null ? {} : { decisionOne }), maxShare: SHARE } },
});
setUpstreamCostsForTest(table());

const TYPESAFE = "api.typesafe.ai", OPENROUTER = "openrouter.ai", OPENAI = "api.openai.com";
const reply = (status, body) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status < 400, status, text: async () => text, json: async () => JSON.parse(text) };
};
const timeout = () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); };
/** routes: host -> reply | (body) => reply | null (connection refused). */
function stub(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ host: u.host, path: u.pathname, raw: init.body, body: JSON.parse(init.body), headers: init.headers });
    if (!(u.host in routes)) throw new Error(`unexpected ${u.host}`);
    const r = routes[u.host];
    if (r === null) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return typeof r === "function" ? r(JSON.parse(init.body)) : r;
  };
  return { calls, fetchImpl, hosts: () => calls.map((c) => c.host).join() };
}
const withoutModel = (b) => { const { model, ...rest } = b; return JSON.stringify(rest); };

// ---- the client --------------------------------------------------------------
{
  ok(decisionOneEnabled(), "enabled when OPENROUTER_API_KEY is set");
  process.env.DECISION_ONE = "off";
  ok(!decisionOneEnabled(), 'DECISION_ONE=off disables it');
  delete process.env.DECISION_ONE;
  ok(!decisionOneEnabled(""), "no key, not enabled");

  const body = { state: "s", model: "jev-latest", questions: { q: { type: "noul", instructions: "?" } } };
  const s = stub({ [OPENROUTER]: reply(200, { model: `${DECISION_ONE_MODEL}-20261009`, answers: { q: { type: "noul", noul: 0.2 } } }) });
  const j = await askDecisionOne(body, { fetchImpl: s.fetchImpl });
  const c = s.calls[0];
  ok(c.host === OPENROUTER && c.path === "/api/alpha/decisions", "posts to OpenRouter's decisions endpoint");
  ok(c.body.model === DECISION_ONE_MODEL && withoutModel(c.body) === withoutModel(body), "the body sent is the caller's body with only model changed");
  ok(Object.entries(OPENROUTER_ATTRIBUTION).every(([k, v]) => c.headers[k] === v), "every attribution header is sent");
  ok(c.headers.authorization === "Bearer or-test-not-real", "the OpenRouter key rides as a bearer");
  ok(j.answers.q.noul === 0.2, "the parsed answer comes back");

  process.env.DECISION_ONE_URL = "https://example.test/decide";
  const s2 = stub({ "example.test": reply(200, { answers: {} }) });
  await askDecisionOne(body, { fetchImpl: s2.fetchImpl });
  ok(s2.calls[0]?.host === "example.test", "DECISION_ONE_URL overrides the endpoint");
  delete process.env.DECISION_ONE_URL;

  for (const [why, r, code, billed] of [
    ["a 5xx", reply(503, { error: "secret state echoed" }), 502, false],
    ["a 429", reply(429, {}), 503, false],
    ["a 401", reply(401, {}), 503, false],
    ["a 400", reply(400, {}), 400, false],
    ["a refused connection", null, 502, false],
    ["a timeout", timeout, 504, true],
    ["an unreadable 200", reply(200, "not json"), 502, true],
    ["a 200 without answers", reply(200, { model: "x" }), 502, true],
  ]) {
    const s3 = stub({ [OPENROUTER]: r });
    let e = null; try { await askDecisionOne(body, { fetchImpl: s3.fetchImpl }); } catch (x) { e = x; }
    ok(e?.statusCode === code && !!e.mayBeBilled === billed && !/secret/.test(e.message), `${why} throws ${code}${billed ? ", may be billed" : ", not billed"}, and never relays the body`);
  }
}

// ---- internal fallback: tool-judge -------------------------------------------
const A = { slug: "pdf-extract-pages", name: "PDF pages", description: "Extract pages from a PDF" };
const B = { slug: "html-to-json", name: "HTML to JSON", description: "Extract a web page into structured JSON" };
const choiceAnswer = (choice, confidence) => reply(200, { answers: { best: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } } });
{
  for (const [why, jev] of [["a Jev 5xx", reply(503, {})], ["a Jev timeout", timeout], ["a refused Jev connection", null], ["an unusable Jev answer", reply(200, { answers: { best: { choice: 7 } } })]]) {
    toolJudge._jevReset();
    const s = stub({ [TYPESAFE]: jev, [OPENROUTER]: choiceAnswer("html-to-json", 0.93) });
    const r = await toolJudge.judgeTool("extract a web page into structured json", [A, B], { fetchImpl: s.fetchImpl });
    ok(s.hosts() === `${TYPESAFE},${OPENROUTER}` && r?.choice === "html-to-json", `tool-judge: ${why} falls back to Decision-1`);
    ok(withoutModel(s.calls[1].body) === withoutModel(s.calls[0].body) && s.calls[1].body.model === DECISION_ONE_MODEL, "...with Jev's body, only the model changed");
    if (why === "a Jev 5xx") {
      const st = toolJudge.jevSpendStatus();
      const want = Buffer.byteLength(s.calls[0].raw) + Buffer.byteLength(s.calls[1].raw) + 600;
      ok(st.tokens === want && st.calls === 2, `...and both calls are booked against the one daily ceiling (${st.tokens} of ${want})`);
    }
  }
  toolJudge._jevReset();
  const s = stub({ [TYPESAFE]: choiceAnswer("html-to-json", 0.93), [OPENROUTER]: choiceAnswer("pdf-extract-pages", 0.99) });
  const r = await toolJudge.judgeTool("extract a web page", [A, B], { fetchImpl: s.fetchImpl });
  ok(s.hosts() === TYPESAFE && r.choice === "html-to-json", "tool-judge: a Jev answer is used and Decision-1 is never asked");

  // The fallback is booked against the free share too.
  toolJudge._jevReset();
  const probe = stub({ [TYPESAFE]: reply(503, {}), [OPENROUTER]: choiceAnswer("html-to-json", 0.93) });
  await toolJudge.judgeTool("free share probe", [A, B], { fetchImpl: probe.fetchImpl, pool: "free" });
  const jevEst = Buffer.byteLength(probe.calls[0].raw) + 300;
  toolJudge._jevReset();
  process.env.JEV_DAILY_MAX_TOKENS = "100000";
  process.env.ROUTE_JUDGE_FREE_SHARE = String((jevEst + 10) / 100000);
  const sf = stub({ [TYPESAFE]: reply(503, {}), [OPENROUTER]: choiceAnswer("html-to-json", 0.93) });
  const outcome = {};
  const rf = await toolJudge.judgeTool("free share probe", [A, B], { fetchImpl: sf.fetchImpl, pool: "free", outcome });
  ok(rf === null && sf.hosts() === TYPESAFE && outcome.skipped === "budget", "tool-judge: a fallback past the free share is not made, and says budget");
  delete process.env.JEV_DAILY_MAX_TOKENS; delete process.env.ROUTE_JUDGE_FREE_SHARE;

  // Decision-1 alone, when no TypeSafe key is set.
  toolJudge._jevReset();
  delete process.env.TYPESAFE_API_KEY;
  const sa = stub({ [OPENROUTER]: choiceAnswer("html-to-json", 0.93) });
  ok(toolJudge.toolJudgeEnabled() && (await toolJudge.judgeTool("extract a web page", [A, B], { fetchImpl: sa.fetchImpl }))?.choice === "html-to-json" && sa.hosts() === OPENROUTER, "tool-judge: with no TypeSafe key Decision-1 serves alone");
  delete process.env.OPENROUTER_API_KEY;
  ok(!toolJudge.toolJudgeEnabled(), "tool-judge: with neither key the judge is off");
  process.env.TYPESAFE_API_KEY = "ts-test-not-real";
  toolJudge._jevReset();
  const sn = stub({ [TYPESAFE]: reply(503, {}) });
  ok((await toolJudge.judgeTool("x", [A, B], { fetchImpl: sn.fetchImpl })) === null && sn.hosts() === TYPESAFE, "tool-judge: without an OpenRouter key a Jev failure stays a failure");
  process.env.OPENROUTER_API_KEY = "or-test-not-real";
}

// ---- internal fallback: discovery-rerank and wish-classify --------------------
{
  const TOOLS = [{ slug: "extract", name: "Extract", description: "Readable text from a URL." }, { slug: "skill-structured-scrape", name: "Scrape", description: "Web page to JSON." }];
  for (const [why, jev] of [["a Jev 5xx", reply(500, {})], ["a Jev timeout", timeout]]) {
    rerank.__resetCache();
    const s = stub({ [TYPESAFE]: jev, [OPENROUTER]: choiceAnswer("skill-structured-scrape", 0.95) });
    const rows = [{ text: "web page into json" }];
    const sum = await rerank.rerankMisses(rows, () => TOOLS, { fetchImpl: s.fetchImpl });
    ok(s.hosts() === `${TYPESAFE},${OPENROUTER}` && rows[0].rerank?.kind === "index-miss" && sum.failed === 0, `discovery-rerank: ${why} falls back to Decision-1`);
    ok(withoutModel(s.calls[1].body) === withoutModel(s.calls[0].body), "...with Jev's body, only the model changed");
  }
  rerank.__resetCache();
  const s = stub({ [TYPESAFE]: choiceAnswer("extract", 0.95), [OPENROUTER]: choiceAnswer("skill-structured-scrape", 0.95) });
  const rows = [{ text: "readable text" }];
  await rerank.rerankMisses(rows, () => TOOLS, { fetchImpl: s.fetchImpl });
  ok(s.hosts() === TYPESAFE && rows[0].rerank?.kind === "confirmed", "discovery-rerank: a Jev answer is used and Decision-1 is never asked");

  const noul = (p) => reply(200, { answers: { advertises: { type: "noul", noul: p } } });
  for (const [why, jev] of [["a Jev 5xx", reply(502, {})], ["a Jev timeout", timeout]]) {
    wish.__resetCache();
    const s2 = stub({ [TYPESAFE]: jev, [OPENROUTER]: noul(0.95) });
    const rows2 = [{ text: "buy my endpoint for $0.10" }];
    await wish.classifyWishes(rows2, { fetchImpl: s2.fetchImpl });
    ok(s2.hosts() === `${TYPESAFE},${OPENROUTER}` && rows2[0].intent?.kind === "advertisement", `wish-classify: ${why} falls back to Decision-1`);
    ok(withoutModel(s2.calls[1].body) === withoutModel(s2.calls[0].body), "...with Jev's body, only the model changed");
  }
  wish.__resetCache();
  const s3 = stub({ [TYPESAFE]: noul(0.05), [OPENROUTER]: noul(0.95) });
  const rows3 = [{ text: "convert kilowatts to horsepower" }];
  await wish.classifyWishes(rows3, { fetchImpl: s3.fetchImpl });
  ok(s3.hosts() === TYPESAFE && rows3[0].intent?.kind === "not-advertising", "wish-classify: a Jev answer is used and Decision-1 is never asked");
}

// ---- internal fallback: the decide service's judge ---------------------------
{
  const listing = [{ purpose: "fear index", candidates: [{ key: "s1c1", name: "a", description: "fear index", inputs: [] }] }];
  const d1 = reply(200, { model: `${DECISION_ONE_MODEL}-20261009`, answers: { s1c1: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 500, output_tokens: 1 } });
  for (const [why, jev] of [["a Jev 5xx", reply(503, {})], ["a Jev timeout", timeout], ["a Jev 200 without answers", reply(200, { model: "jev" })]]) {
    const s = stub({ [TYPESAFE]: jev, [OPENROUTER]: d1 });
    const meter = [];
    const r = await makeJevJudge({ apiKey: "k", decisionOneKey: "or-k", fetchImpl: s.fetchImpl }).judge("fear", listing, { meter });
    const row = meter.find((m) => m.model === DECISION_ONE_MODEL);
    ok(r?.fits?.s1c1 === 0.9 && s.hosts() === `${TYPESAFE},${OPENROUTER}`, `decide: ${why} falls back to Decision-1`);
    ok(row?.outcome === "ok" && row.promptTokens === 500 && Math.abs(row.costUsd - (500 / 1e6) * RATE) < 1e-15, "...metered under its own model name, priced from the private table");
    ok(withoutModel(s.calls[1].body) === withoutModel(s.calls[0].body) && s.calls[1].headers.authorization === "Bearer or-k", "...with Jev's body and decide's own OpenRouter key");
  }
  setUpstreamCostsForTest(table({ decisionOne: null }));
  const sn = stub({ [TYPESAFE]: reply(503, {}), [OPENROUTER]: d1 });
  const meter = [];
  await makeJevJudge({ apiKey: "k", decisionOneKey: "or-k", fetchImpl: sn.fetchImpl }).judge("fear", listing, { meter });
  ok(meter.find((m) => m.model === DECISION_ONE_MODEL)?.costUsd === null, "decide: without the table's rate the cost is recorded as unknown, never zero");
  setUpstreamCostsForTest(table());
  const ok200 = stub({ [TYPESAFE]: reply(200, { answers: { s1c1: { type: "noul", noul: 0.4 } }, usage: { input_tokens: 9 } }), [OPENROUTER]: d1 });
  const r = await makeJevJudge({ apiKey: "k", decisionOneKey: "or-k", fetchImpl: ok200.fetchImpl }).judge("fear", listing);
  ok(r.fits.s1c1 === 0.4 && ok200.hosts() === TYPESAFE, "decide: a Jev answer is used and Decision-1 is never asked");
  // Room for the Jev call and not for a second one.
  process.env.DECIDE_JEV_DAILY_MAX_TOKENS = String(Buffer.byteLength(JSON.stringify({ state: { task: "fear" }, model: "jev-latest", questions: jevQuestions(listing) })) + 5);
  const capped = stub({ [TYPESAFE]: reply(503, {}), [OPENROUTER]: d1 });
  const cm = [];
  await makeJevJudge({ apiKey: "k", decisionOneKey: "or-k", fetchImpl: capped.fetchImpl }).judge("fear", listing, { meter: cm });
  ok(capped.hosts() === TYPESAFE && cm.some((m) => m.model === DECISION_ONE_MODEL && m.outcome === "skipped_ceiling"), "decide: the fallback is booked against the same daily ceiling and skipped past it");
  delete process.env.DECIDE_JEV_DAILY_MAX_TOKENS;
  const alone = stub({ [OPENROUTER]: d1 });
  ok((await makeJevJudge({ apiKey: "", decisionOneKey: "or-k", fetchImpl: alone.fetchImpl }).judge("fear", listing))?.fits?.s1c1 === 0.9 && alone.hosts() === OPENROUTER, "decide: with no TypeSafe key Decision-1 serves alone");
}

// ---- paid route: /v1/judge and /v1/decisions ---------------------------------
const { judge, decisions, decisionOneOffered, decisionOneFits, DECISION_ONE, LUNA, JUDGE_TOOLS, JUDGE_PRICE_USD } = kit;
const JUDGE_IN = {
  state: "The export button crashes the settings page in Safari.",
  questions: {
    sev: { type: "score", instructions: "How severe?", criteria: ["Cosmetic", "Workaround exists", "Blocking"] },
    repro: { type: "noul", instructions: "Are there repro steps?" },
    team: { type: "choice", instructions: "Which team?", criteria: { frontend: "UI", backend: "APIs" } },
  },
};
const JEV_SHAPE = (model) => ({ model, answers: {
  sev: { type: "score", score: 1.4, confidence: 0.4, legend: { 0: "Cosmetic", 1: "Workaround exists", 2: "Blocking" }, probabilities: { 0: 0, 1: 0.6, 2: 0.4 } },
  repro: { type: "noul", noul: 0.32 },
  team: { type: "choice", choice: "frontend", confidence: 1, probabilities: { frontend: 1, backend: 0 } },
}, usage: { input_tokens: 290, output_tokens: 1 } });
const LUNA_ANSWERS = { answers: [
  { type: "score", name: "q0", score: 1.27, probabilities: [], confidence: 0.15 },
  { type: "predicate", name: "q1", probability: 0.02 },
  { type: "choice", name: "q2", choice: "frontend", probabilities: [], confidence: 0.97 },
], usage: { input_tokens: 300, output_tokens: 0 } };
const D1_OK = reply(200, JEV_SHAPE(`${DECISION_ONE_MODEL}-20261009`));
const JEV_OK = reply(200, JEV_SHAPE("jev-1.13.0"));
const LUNA_OK = reply(200, LUNA_ANSWERS);
const DOWN = reply(503, {});
{
  ok(decisionOneOffered() && decisionOneFits(1000) && !decisionOneFits(1001), `Decision-1 is offered with the key and the table rate, while its worst case fits the share (${(SHARE * JUDGE_PRICE_USD * 1e6) / RATE} bytes at the test values)`);
  ok(JUDGE_TOOLS[0].discovery.inputSchema.properties.model.enum.includes(DECISION_ONE), "the /v1/judge model enum names microsoft-decision-1");
  ok(/Decision-1/.test(JUDGE_TOOLS[0].description) && /Model-backed, not deterministic/.test(JUDGE_TOOLS[0].description) && /Decision-1/.test(JUDGE_TOOLS[1].description), "both descriptions name Decision-1 and say model-backed");

  // Orders: everything down, so every offered backend is tried once.
  for (const [why, input, want] of [
    ["the default", JUDGE_IN, [TYPESAFE, OPENROUTER, OPENAI]],
    ["naming jev-latest", { ...JUDGE_IN, model: "jev-latest" }, [TYPESAFE, OPENROUTER, OPENAI]],
    ["naming gpt-6-luna", { ...JUDGE_IN, model: LUNA }, [OPENAI, TYPESAFE, OPENROUTER]],
    ["naming microsoft-decision-1", { ...JUDGE_IN, model: DECISION_ONE }, [OPENROUTER, TYPESAFE, OPENAI]],
  ]) {
    const s = stub({ [TYPESAFE]: DOWN, [OPENROUTER]: DOWN, [OPENAI]: DOWN });
    let e = null; try { await judge(input, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
    ok(e?.statusCode >= 500 && s.hosts() === want.join(), `/v1/judge ${why}: ${want.join(" -> ")} (${s.hosts()})`);
  }
  {
    const s = stub({ [TYPESAFE]: DOWN, [OPENROUTER]: D1_OK, [OPENAI]: LUNA_OK });
    const r = await judge(JUDGE_IN, { fetchImpl: s.fetchImpl });
    ok(s.hosts() === `${TYPESAFE},${OPENROUTER}` && r.model === `${DECISION_ONE_MODEL}-20261009` && r.fallbackFrom === "jev-latest", "/v1/judge: a Jev outage is answered by Decision-1, fallbackFrom names Jev");
    ok(r.answers.team.choice === "frontend" && r.answers.repro.noul === 0.32 && r.usage.input_tokens === 290, "...in /v1/judge's own answer shape");
    ok(withoutModel(s.calls[1].body) === withoutModel(s.calls[0].body) && s.calls[0].body.model === "jev-latest" && s.calls[1].body.model === DECISION_ONE_MODEL, "...and Decision-1 receives Jev's body with only the model changed");
    ok(Object.entries(OPENROUTER_ATTRIBUTION).every(([k, v]) => s.calls[1].headers[k] === v), "...with the attribution headers");
  }
  {
    const s = stub({ [OPENROUTER]: D1_OK });
    const r = await judge({ ...JUDGE_IN, model: DECISION_ONE }, { fetchImpl: s.fetchImpl });
    ok(s.hosts() === OPENROUTER && !("fallbackFrom" in r), "/v1/judge naming microsoft-decision-1 is served by Decision-1 alone");
  }
  {
    const s = stub({ [OPENROUTER]: DOWN, [TYPESAFE]: JEV_OK });
    const r = await judge({ ...JUDGE_IN, model: DECISION_ONE }, { fetchImpl: s.fetchImpl });
    ok(s.hosts() === `${OPENROUTER},${TYPESAFE}` && r.fallbackFrom === DECISION_ONE && s.calls[1].body.model === "jev-latest", "a Decision-1 outage falls back to Jev, asked as jev-latest; fallbackFrom names Decision-1");
  }
  {
    const s = stub({ [TYPESAFE]: JEV_OK, [OPENROUTER]: D1_OK });
    const r = await judge(JUDGE_IN, { fetchImpl: s.fetchImpl });
    ok(s.hosts() === TYPESAFE && !("fallbackFrom" in r), "/v1/judge: a Jev answer is used and Decision-1 is never asked");
  }
  // After a call that may have billed, no further backend is asked.
  for (const [why, input, routes, want] of [
    ["a Jev timeout", JUDGE_IN, { [TYPESAFE]: timeout, [OPENROUTER]: D1_OK }, TYPESAFE],
    ["an unusable Jev 200", JUDGE_IN, { [TYPESAFE]: reply(200, { answers: {} }), [OPENROUTER]: D1_OK }, TYPESAFE],
    ["a Decision-1 timeout", { ...JUDGE_IN, model: DECISION_ONE }, { [OPENROUTER]: timeout, [TYPESAFE]: JEV_OK }, OPENROUTER],
    ["an unreadable Decision-1 200", { ...JUDGE_IN, model: DECISION_ONE }, { [OPENROUTER]: reply(200, "nope"), [TYPESAFE]: JEV_OK }, OPENROUTER],
    ["a Decision-1 answer of the wrong type", { ...JUDGE_IN, model: DECISION_ONE }, { [OPENROUTER]: reply(200, { answers: { ...JEV_SHAPE("x").answers, repro: { type: "choice", choice: "frontend" } } }), [TYPESAFE]: JEV_OK }, OPENROUTER],
    ["a Decision-1 timeout after Jev failed", JUDGE_IN, { [TYPESAFE]: DOWN, [OPENROUTER]: timeout, [OPENAI]: LUNA_OK }, `${TYPESAFE},${OPENROUTER}`],
  ]) {
    const s = stub(routes);
    let e = null; try { await judge(input, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
    ok(e?.statusCode >= 500 && s.hosts() === want, `${why} ends the call as an uncharged ${e?.statusCode} with no further backend (${s.hosts()})`);
  }

  // /v1/decisions: luna -> jev -> decision-one.
  const DEC_IN = { input: "I was charged twice.", questions: [{ type: "predicate", name: "angry", instructions: "Is the customer angry?" }] };
  {
    const s = stub({ [OPENAI]: DOWN, [TYPESAFE]: DOWN, [OPENROUTER]: DOWN });
    let e = null; try { await decisions(DEC_IN, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
    ok(e?.statusCode >= 500 && s.hosts() === `${OPENAI},${TYPESAFE},${OPENROUTER}`, `/v1/decisions: luna -> jev -> decision-one (${s.hosts()})`);
  }
  {
    const s = stub({ [OPENAI]: DOWN, [TYPESAFE]: DOWN, [OPENROUTER]: reply(200, { model: DECISION_ONE_MODEL, answers: { angry: { type: "noul", noul: 0.4 } }, usage: { input_tokens: 50 } }) });
    const r = await decisions(DEC_IN, { fetchImpl: s.fetchImpl });
    ok(r.fallback_from === LUNA && r.model === DECISION_ONE_MODEL && r.answers[0].type === "predicate" && r.answers[0].probability === 0.4, "/v1/decisions: Decision-1 answers in the Decisions shape; fallback_from names Luna");
    ok(withoutModel(s.calls[2].body) === withoutModel(s.calls[1].body), "...with Jev's body, only the model changed");
  }

  // No private rate, no Decision-1 on the paid route; the table reads partial.
  setUpstreamCostsForTest(table({ decisionOne: null }));
  ok(!decisionOneOffered() && !decisionOneFits(1) && kit.judgeEnabled(), "without vendor.decisions.decisionOne Decision-1 is not offered; Jev still serves");
  ok(upstreamCostsGaps().includes("vendor.decisions.decisionOne"), "a table without the key reads partial (it is a gap)");
  {
    const s = stub({ [TYPESAFE]: DOWN, [OPENROUTER]: D1_OK, [OPENAI]: DOWN });
    let e = null; try { await judge({ ...JUDGE_IN, model: DECISION_ONE }, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
    ok(e?.statusCode >= 500 && !s.hosts().includes(OPENROUTER), `the paid route never calls Decision-1 without the rate, even when named (${s.hosts()})`);
  }
  setUpstreamCostsForTest(table());
  {
    const big = { ...JUDGE_IN, state: "x".repeat(2000) };
    const s = stub({ [TYPESAFE]: DOWN, [OPENROUTER]: D1_OK, [OPENAI]: DOWN });
    let e = null; try { await judge(big, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
    ok(e?.statusCode >= 500 && s.hosts() === TYPESAFE, "a request too large for Decision-1's bound is not sent to it");
  }
  delete process.env.OPENROUTER_API_KEY;
  ok(!decisionOneOffered(), "without the OpenRouter key Decision-1 is not offered");
  process.env.OPENROUTER_API_KEY = "or-test-not-real";
}

console.warn = quiet;
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
