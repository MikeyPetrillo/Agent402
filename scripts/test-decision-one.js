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
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
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
const { askDecisionOne, decisionOneEnabled, DECISION_ONE_MODEL, GEMINI_DECISION_MODEL, jevOpenRouterModel, openRouterDecisionsEnabled, _decisionOneSpendReset, decisionsRequestBytes, decisionsProviderPolicy, openRouterJudgeModels } = await import("../src/decision-one.js");
const JEV_OR = "typesafe/jev-1.14";
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
const table = ({ luna = RATE, decisionOne = RATE, jev = null } = {}) => ({
  models: [["fake/model", { prompt: 1, completion: 1 }]],
  vendor: { decisions: { ...(luna == null ? {} : { luna }), ...(decisionOne == null ? {} : { decisionOne }), ...(jev == null ? {} : { jev }), maxShare: SHARE } },
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
// The OpenRouter body is the caller's with `model` set and our provider policy
// added (asserted on its own below), so both are set aside to compare the rest.
const withoutModel = (b) => { const { model, provider, ...rest } = b; return JSON.stringify(rest); };

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
    // A refused connection and a deadline are the upstream's 503 classes
    // (src/upstream-deadline.js); only the deadline may have been billed.
    ["a refused connection", null, 503, false],
    ["a timeout", timeout, 503, true],
    ["an unreadable 200", reply(200, "not json"), 502, true],
    ["a 200 without answers", reply(200, { model: "x" }), 502, true],
  ]) {
    const s3 = stub({ [OPENROUTER]: r });
    let e = null; try { await askDecisionOne(body, { fetchImpl: s3.fetchImpl }); } catch (x) { e = x; }
    ok(e?.statusCode === code && !!e.mayBeBilled === billed && !/secret/.test(e.message), `${why} throws ${code}${billed ? ", may be billed" : ", not billed"}, and never relays the body`);
  }
}

// ---- our data policy on every Decisions request --------------------------------
{
  const body = { state: "s", model: "jev-latest", questions: { q: { type: "noul", instructions: "?" } } };
  const s = stub({ [OPENROUTER]: reply(200, { answers: { q: { type: "noul", noul: 0.5 } } }) });
  for (const m of [DECISION_ONE_MODEL, JEV_OR, GEMINI_DECISION_MODEL]) await askDecisionOne(body, { fetchImpl: s.fetchImpl, model: m });
  const prov = s.calls.map((c) => JSON.stringify(c.body.provider));
  const zdr = JSON.stringify({ data_collection: "deny", zdr: true }), deny = JSON.stringify({ data_collection: "deny" });
  ok(prov[0] === zdr && prov[1] === zdr, `Decision-1 and Jev over OpenRouter are sent data_collection deny and zdr (${prov[0]}, ${prov[1]})`);
  ok(prov[2] === deny, `Gemini Decision-1 is sent data_collection deny without zdr, since its endpoint is not ZDR (${prov[2]})`);
  ok(s.calls.every((c, i) => Buffer.byteLength(c.raw) === decisionsRequestBytes(body, [DECISION_ONE_MODEL, JEV_OR, GEMINI_DECISION_MODEL][i])), "every caller's byte estimate is the exact body sent");
  const s2 = stub({ [OPENROUTER]: reply(200, { answers: { q: { type: "noul", noul: 0.5 } } }) });
  await askDecisionOne({ ...body, provider: { data_collection: "allow" } }, { fetchImpl: s2.fetchImpl });
  ok(JSON.stringify(s2.calls[0].body.provider) === zdr, "a provider field already in the body is replaced by ours");
  ok(JSON.stringify(decisionsProviderPolicy("typesafe/jev-1.13")) === zdr, "every TypeSafe Jev id on OpenRouter gets zdr");
  ok(openRouterJudgeModels("jev-1.14.0").join() === `${JEV_OR},${DECISION_ONE_MODEL}` && openRouterJudgeModels("jev-preview").join() === DECISION_ONE_MODEL && openRouterJudgeModels("jev-1.14.0", "").length === 0,
    "the internal legs: the pinned Jev over OpenRouter, then Decision-1; none without a key");
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
    ok(s.hosts() === `${TYPESAFE},${OPENROUTER}` && r?.choice === "html-to-json", `tool-judge: ${why} falls back to OpenRouter`);
    ok(withoutModel(s.calls[1].body) === withoutModel(s.calls[0].body) && s.calls[1].body.model === JEV_OR, "...asking the same Jev version there first, with Jev's body, only the model changed");
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
  const D_OR = (m) => m; // readability: the OpenRouter models in the order asked
  const TOOLS = [{ slug: "extract", name: "Extract", description: "Readable text from a URL." }, { slug: "skill-structured-scrape", name: "Scrape", description: "Web page to JSON." }];
  const pick = (map) => (body) => (body.model in map ? (typeof map[body.model] === "function" ? map[body.model]() : map[body.model]) : reply(503, {}));
  const orOf = (s) => s.calls.filter((c) => c.host === OPENROUTER).map((c) => c.body.model).join();
  for (const [why, jev] of [["a Jev 5xx", reply(500, {})], ["a Jev timeout", timeout]]) {
    rerank.__resetCache();
    const s = stub({ [TYPESAFE]: jev, [OPENROUTER]: choiceAnswer("skill-structured-scrape", 0.95) });
    const rows = [{ text: "web page into json" }];
    const sum = await rerank.rerankMisses(rows, () => TOOLS, { fetchImpl: s.fetchImpl });
    ok(s.hosts() === `${TYPESAFE},${OPENROUTER}` && rows[0].rerank?.kind === "index-miss" && sum.failed === 0, `discovery-rerank: ${why} falls back to OpenRouter`);
    ok(withoutModel(s.calls[1].body) === withoutModel(s.calls[0].body) && s.calls[1].body.model === JEV_OR, "...asking the same Jev version there first, with Jev's body, only the model changed");
  }
  {
    rerank.__resetCache();
    const s = stub({ [TYPESAFE]: reply(500, {}), [OPENROUTER]: pick({ [JEV_OR]: reply(503, {}), [DECISION_ONE_MODEL]: choiceAnswer("skill-structured-scrape", 0.95) }) });
    const rows = [{ text: "web page into json, again" }];
    await rerank.rerankMisses(rows, () => TOOLS, { fetchImpl: s.fetchImpl });
    ok(orOf(s) === D_OR(`${JEV_OR},${DECISION_ONE_MODEL}`) && rows[0].rerank?.kind === "index-miss", "discovery-rerank: Jev over OpenRouter down too, Decision-1 answers");
    rerank.__resetCache();
    const u = stub({ [TYPESAFE]: reply(500, {}), [OPENROUTER]: pick({ [JEV_OR]: reply(200, { answers: { best: { choice: 7 } } }), [DECISION_ONE_MODEL]: choiceAnswer("skill-structured-scrape", 0.95) }) });
    const rows2 = [{ text: "page to json" }];
    const sumU = await rerank.rerankMisses(rows2, () => TOOLS, { fetchImpl: u.fetchImpl });
    ok(orOf(u) === JEV_OR && !rows2[0].rerank && sumU.failed === 1, `discovery-rerank: an unreadable Jev answer over OpenRouter (a billed 200) ends the walk; Decision-1 is not asked (${orOf(u)})`);
    rerank.__resetCache();
    const t = stub({ [TYPESAFE]: reply(500, {}), [OPENROUTER]: pick({ [JEV_OR]: timeout, [DECISION_ONE_MODEL]: choiceAnswer("skill-structured-scrape", 0.95) }) });
    const rowsT = [{ text: "page to json, timed out" }];
    const sumT = await rerank.rerankMisses(rowsT, () => TOOLS, { fetchImpl: t.fetchImpl });
    ok(orOf(t) === JEV_OR && !rowsT[0].rerank && sumT.failed === 1, `discovery-rerank: a timed-out Jev over OpenRouter ends the walk; Decision-1 is not asked (${orOf(t)})`);
    rerank.__resetCache();
    delete process.env.TYPESAFE_API_KEY;
    const a = stub({ [OPENROUTER]: choiceAnswer("skill-structured-scrape", 0.95) });
    const rows3 = [{ text: "json from a page" }];
    ok(rerank.rerankEnabled(), "discovery-rerank: enabled with only the OpenRouter key");
    await rerank.rerankMisses(rows3, () => TOOLS, { fetchImpl: a.fetchImpl });
    ok(a.hosts() === OPENROUTER && orOf(a) === JEV_OR && rows3[0].rerank?.kind === "index-miss", "discovery-rerank: with no TypeSafe key, Jev over OpenRouter serves first");
    process.env.TYPESAFE_API_KEY = "ts-test-not-real";
    process.env.JEV_OPENROUTER = "off";
    rerank.__resetCache();
    const off = stub({ [TYPESAFE]: reply(500, {}), [OPENROUTER]: choiceAnswer("skill-structured-scrape", 0.95) });
    await rerank.rerankMisses([{ text: "html to json" }], () => TOOLS, { fetchImpl: off.fetchImpl });
    ok(orOf(off) === DECISION_ONE_MODEL, "discovery-rerank: JEV_OPENROUTER=off goes straight to Decision-1");
    delete process.env.JEV_OPENROUTER;
  }
  rerank.__resetCache();
  const s = stub({ [TYPESAFE]: choiceAnswer("extract", 0.95), [OPENROUTER]: choiceAnswer("skill-structured-scrape", 0.95) });
  const rows = [{ text: "readable text" }];
  await rerank.rerankMisses(rows, () => TOOLS, { fetchImpl: s.fetchImpl });
  ok(s.hosts() === TYPESAFE && rows[0].rerank?.kind === "confirmed", "discovery-rerank: a Jev answer is used and Decision-1 is never asked");

  const noul = (p) => reply(200, { answers: { advertises: { type: "noul", noul: p } } });
  for (const [why, jev] of [["a Jev 5xx", reply(502, {})], ["a Jev timeout", timeout], ["a Jev answer with no probability", noul(null)]]) {
    wish.__resetCache();
    const s2 = stub({ [TYPESAFE]: jev, [OPENROUTER]: noul(0.95) });
    const rows2 = [{ text: "buy my endpoint for $0.10" }];
    await wish.classifyWishes(rows2, { fetchImpl: s2.fetchImpl });
    ok(s2.hosts() === `${TYPESAFE},${OPENROUTER}` && rows2[0].intent?.kind === "advertisement", `wish-classify: ${why} falls back to OpenRouter`);
    ok(withoutModel(s2.calls[1].body) === withoutModel(s2.calls[0].body) && s2.calls[1].body.model === JEV_OR, "...asking the same Jev version there first, with Jev's body, only the model changed");
  }
  {
    wish.__resetCache();
    const s2 = stub({ [TYPESAFE]: reply(502, {}), [OPENROUTER]: pick({ [JEV_OR]: noul(null), [DECISION_ONE_MODEL]: noul(0.95) }) });
    const rows2 = [{ text: "buy my api for $0.20" }];
    await wish.classifyWishes(rows2, { fetchImpl: s2.fetchImpl });
    ok(orOf(s2) === JEV_OR && rows2[0].intent?.kind !== "advertisement", `wish-classify: no probability from Jev over OpenRouter (a billed 200) ends the walk; Decision-1 is not asked (${orOf(s2)})`);
    wish.__resetCache();
    const s2b = stub({ [TYPESAFE]: reply(502, {}), [OPENROUTER]: pick({ [JEV_OR]: reply(503, {}), [DECISION_ONE_MODEL]: noul(0.95) }) });
    const rows2b = [{ text: "buy my api for $0.25" }];
    await wish.classifyWishes(rows2b, { fetchImpl: s2b.fetchImpl });
    ok(orOf(s2b) === `${JEV_OR},${DECISION_ONE_MODEL}` && rows2b[0].intent?.kind === "advertisement", "wish-classify: control: a 503 from Jev over OpenRouter (not billed) goes on to Decision-1");
    wish.__resetCache();
    delete process.env.TYPESAFE_API_KEY;
    const a = stub({ [OPENROUTER]: noul(0.95) });
    const rows3 = [{ text: "my endpoint, $0.30 a call" }];
    ok(wish.wishClassifyEnabled(), "wish-classify: enabled with only the OpenRouter key");
    await wish.classifyWishes(rows3, { fetchImpl: a.fetchImpl });
    ok(a.hosts() === OPENROUTER && orOf(a) === JEV_OR && rows3[0].intent?.kind === "advertisement", "wish-classify: with no TypeSafe key, Jev over OpenRouter serves first");
    process.env.TYPESAFE_API_KEY = "ts-test-not-real";
  }
  wish.__resetCache();
  const s3 = stub({ [TYPESAFE]: noul(0.05), [OPENROUTER]: noul(0.95) });
  const rows3 = [{ text: "convert kilowatts to horsepower" }];
  await wish.classifyWishes(rows3, { fetchImpl: s3.fetchImpl });
  ok(s3.hosts() === TYPESAFE && rows3[0].intent?.kind === "not-advertising", "wish-classify: a Jev answer is used and Decision-1 is never asked");
}

// ---- internal fallback: the decide service's judge ---------------------------
{
  setUpstreamCostsForTest(table({ jev: RATE })); // Jev over OpenRouter is metered at Jev's rate
  const listing = [{ purpose: "fear index", candidates: [{ key: "s1c1", name: "a", description: "fear index", inputs: [] }] }];
  const d1 = reply(200, { model: `${DECISION_ONE_MODEL}-20261009`, answers: { s1c1: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 500, output_tokens: 1 } });
  for (const [why, jev] of [["a Jev 5xx", reply(503, {})], ["a Jev timeout", timeout], ["a Jev 200 without answers", reply(200, { model: "jev" })]]) {
    const s = stub({ [TYPESAFE]: jev, [OPENROUTER]: d1 });
    const meter = [];
    const r = await makeJevJudge({ apiKey: "k", decisionOneKey: "or-k", fetchImpl: s.fetchImpl }).judge("fear", listing, { meter });
    const row = meter.find((m) => m.model === JEV_OR);
    ok(r?.fits?.s1c1 === 0.9 && s.hosts() === `${TYPESAFE},${OPENROUTER}` && s.calls[1].body.model === JEV_OR, `decide: ${why} falls back to the same Jev version over OpenRouter`);
    ok(row?.outcome === "ok" && row.promptTokens === 500 && Math.abs(row.costUsd - (500 / 1e6) * RATE) < 1e-15, "...metered under its own model name, priced at Jev's rate from the private table");
    ok(withoutModel(s.calls[1].body) === withoutModel(s.calls[0].body) && s.calls[1].headers.authorization === "Bearer or-k", "...with Jev's body and decide's own OpenRouter key");
  }
  {
    // Jev over OpenRouter down: Decision-1 answers, each leg metered and booked.
    const orPick = (body) => (body.model === JEV_OR ? reply(503, {}) : d1);
    const s = stub({ [TYPESAFE]: reply(503, {}), [OPENROUTER]: orPick });
    const meter = [];
    const judgeD = makeJevJudge({ apiKey: "k", decisionOneKey: "or-k", fetchImpl: s.fetchImpl });
    const r = await judgeD.judge("fear", listing, { meter });
    const d1row = meter.find((m) => m.model === DECISION_ONE_MODEL), jrow = meter.find((m) => m.model === JEV_OR);
    ok(r?.fits?.s1c1 === 0.9 && s.calls.map((c) => c.body.model).join() === `jev-1.14.0,${JEV_OR},${DECISION_ONE_MODEL}`, "decide: Jev, then Jev over OpenRouter, then Decision-1");
    ok(jrow?.outcome === "failed" && jrow.costUsd === 0 && d1row?.outcome === "ok" && Math.abs(d1row.costUsd - (500 / 1e6) * RATE) < 1e-15, "...each leg metered under its own model name");
    const booked = Buffer.byteLength(s.calls[0].raw) + Buffer.byteLength(s.calls[1].raw) + Buffer.byteLength(s.calls[2].raw);
    ok(judgeD.status().bookedTokens === booked, `...and all three are booked against the one daily ceiling (${judgeD.status().bookedTokens} of ${booked})`);
  }
  for (const [why, leg] of [["a timed-out", timeout], ["an unreadable 200 from", reply(200, "nope")]]) {
    // Jev over OpenRouter may have billed us: the walk ends, Decision-1 is not asked.
    const s = stub({ [TYPESAFE]: reply(503, {}), [OPENROUTER]: (body) => (body.model === JEV_OR ? (typeof leg === "function" ? leg() : leg) : d1) });
    const r = await makeJevJudge({ apiKey: "k", decisionOneKey: "or-k", fetchImpl: s.fetchImpl }).judge("fear", listing);
    ok(r === null && s.calls.map((c) => c.body.model).join() === `jev-1.14.0,${JEV_OR}`, `decide: ${why} Jev over OpenRouter ends the walk; Decision-1 is not asked (${s.calls.map((c) => c.body.model).join()})`);
  }
  setUpstreamCostsForTest(table());
  const sn = stub({ [TYPESAFE]: reply(503, {}), [OPENROUTER]: d1 });
  const meter = [];
  await makeJevJudge({ apiKey: "k", decisionOneKey: "or-k", fetchImpl: sn.fetchImpl }).judge("fear", listing, { meter });
  ok(meter.find((m) => m.model === JEV_OR)?.costUsd === null, "decide: without the table's rate the cost is recorded as unknown, never zero");
  setUpstreamCostsForTest(table({ jev: RATE }));
  const ok200 = stub({ [TYPESAFE]: reply(200, { answers: { s1c1: { type: "noul", noul: 0.4 } }, usage: { input_tokens: 9 } }), [OPENROUTER]: d1 });
  const r = await makeJevJudge({ apiKey: "k", decisionOneKey: "or-k", fetchImpl: ok200.fetchImpl }).judge("fear", listing);
  ok(r.fits.s1c1 === 0.4 && ok200.hosts() === TYPESAFE, "decide: a Jev answer is used and Decision-1 is never asked");
  // Room for the Jev call and not for a second one.
  process.env.DECIDE_JEV_DAILY_MAX_TOKENS = String(Buffer.byteLength(JSON.stringify({ state: { task: "fear" }, model: "jev-latest", questions: jevQuestions(listing) })) + 5);
  const capped = stub({ [TYPESAFE]: reply(503, {}), [OPENROUTER]: d1 });
  const cm = [];
  await makeJevJudge({ apiKey: "k", decisionOneKey: "or-k", fetchImpl: capped.fetchImpl }).judge("fear", listing, { meter: cm });
  ok(capped.hosts() === TYPESAFE && cm.some((m) => m.model === JEV_OR && m.outcome === "skipped_ceiling"), "decide: the fallback is booked against the same daily ceiling and skipped past it");
  delete process.env.DECIDE_JEV_DAILY_MAX_TOKENS;
  const alone = stub({ [OPENROUTER]: d1 });
  ok((await makeJevJudge({ apiKey: "", decisionOneKey: "or-k", fetchImpl: alone.fetchImpl }).judge("fear", listing))?.fits?.s1c1 === 0.9 && alone.hosts() === OPENROUTER && alone.calls[0].body.model === JEV_OR, "decide: with no TypeSafe key Jev over OpenRouter serves first");
  setUpstreamCostsForTest(table());
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
const JEV_OK = reply(200, JEV_SHAPE("jev-1.14.0"));
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
    ok(s.hosts() === `${TYPESAFE},${OPENROUTER}` && r.model === DECISION_ONE && r.fallbackFrom === "jev-latest", `/v1/judge: a Jev outage is answered by Decision-1, named by the buyer's model value (${r.model}), fallbackFrom names Jev`);
    ok(r.answers.team.choice === "frontend" && r.answers.repro.noul === 0.32 && r.usage.input_tokens === 290, "...in /v1/judge's own answer shape");
    ok(withoutModel(s.calls[1].body) === withoutModel(s.calls[0].body) && s.calls[0].body.model === "jev-1.14.0" && s.calls[1].body.model === DECISION_ONE_MODEL, "...and Decision-1 receives Jev's body with only the model changed");
    ok(Object.entries(OPENROUTER_ATTRIBUTION).every(([k, v]) => s.calls[1].headers[k] === v), "...with the attribution headers");
  }
  {
    const s = stub({ [OPENROUTER]: D1_OK });
    const r = await judge({ ...JUDGE_IN, model: DECISION_ONE }, { fetchImpl: s.fetchImpl });
    ok(s.hosts() === OPENROUTER && !("fallbackFrom" in r), "/v1/judge naming microsoft-decision-1 is served by Decision-1 alone");
    ok(r.model === DECISION_ONE && JUDGE_TOOLS[0].discovery.inputSchema.properties.model.enum.includes(r.model), `...and the answer's model is the enum value the buyer named (${r.model}), not the dated upstream id`);
  }
  {
    const s = stub({ [OPENROUTER]: DOWN, [TYPESAFE]: JEV_OK });
    const r = await judge({ ...JUDGE_IN, model: DECISION_ONE }, { fetchImpl: s.fetchImpl });
    ok(s.hosts() === `${OPENROUTER},${TYPESAFE}` && r.fallbackFrom === DECISION_ONE && s.calls[1].body.model === "jev-1.14.0", "a Decision-1 outage falls back to Jev, asked for the pinned version; fallbackFrom names Decision-1");
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
    const s = stub({ [OPENAI]: DOWN, [TYPESAFE]: DOWN, [OPENROUTER]: reply(200, { model: `${DECISION_ONE_MODEL}-20261009`, answers: { angry: { type: "noul", noul: 0.4 } }, usage: { input_tokens: 50 } }) });
    const r = await decisions(DEC_IN, { fetchImpl: s.fetchImpl });
    ok(r.fallback_from === LUNA && r.model === DECISION_ONE && r.answers[0].type === "predicate" && r.answers[0].probability === 0.4, "/v1/decisions: Decision-1 answers in the Decisions shape; fallback_from names Luna");
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

// ---- the spend bound: per-call size and a daily byte ceiling -----------------
{
  const answer = reply(200, { answers: { q: { type: "noul", noul: 0.5 } } });
  const small = { state: "s", questions: { q: { type: "noul", instructions: "?" } } };
  const big = { state: "x".repeat(40_000), questions: small.questions };
  _decisionOneSpendReset();
  let s = stub({ [OPENROUTER]: answer });
  let e = null; try { await askDecisionOne(big, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
  ok(e?.statusCode === 503 && s.calls.length === 0, "a body over the per-call cap is refused before anything is sent");

  const bytes = decisionsRequestBytes(small, DECISION_ONE_MODEL);
  process.env.DECISION_ONE_DAILY_MAX_BYTES = String(bytes * 2);
  _decisionOneSpendReset();
  s = stub({ [OPENROUTER]: answer });
  await askDecisionOne(small, { fetchImpl: s.fetchImpl });
  await askDecisionOne(small, { fetchImpl: s.fetchImpl });
  e = null; try { await askDecisionOne(small, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
  ok(s.calls.length === 2 && e?.statusCode === 503, `the daily ceiling admits what fits and refuses the next call unsent (sent ${s.calls.length})`);
  delete process.env.DECISION_ONE_DAILY_MAX_BYTES;
  _decisionOneSpendReset();
}

// ---- the OpenRouter models: Gemini Decision-1 and Jev there ------------------
// The same client, `model` picking; one day's bytes for every model.
const { GEMINI_DECISION, JEV_PINNED, geminiDecisionOffered, geminiDecisionFits, jevOpenRouterOffered, JUDGE_NOTE } = kit;
const fullTable = (over = {}) => ({
  models: [["fake/model", { prompt: 1, completion: 1 }]],
  vendor: { decisions: { luna: RATE, decisionOne: RATE, gemini: RATE, jev: RATE, maxShare: SHARE, ...over } },
});
/** OpenRouter replies chosen by the model the body names. */
const byModel = (map) => (body) => (body.model in map ? (typeof map[body.model] === "function" ? map[body.model]() : map[body.model]) : DOWN);
const orModels = (s) => s.calls.filter((c) => c.host === OPENROUTER).map((c) => c.body.model).join();
{
  ok(jevOpenRouterModel("jev-1.14.0") === JEV_OR && jevOpenRouterModel("jev-1.14.2") === null && jevOpenRouterModel("jev-preview") === null && jevOpenRouterModel("") === null,
    "the pinned Jev version maps to OpenRouter's id; a patch release or the preview maps to none");
  ok(JEV_PINNED === "jev-1.14.0" && jevOpenRouterModel(JEV_PINNED) === JEV_OR, "the pin stays jev-1.14.0, and its OpenRouter id is typesafe/jev-1.14");
  const body = { state: "s", model: "jev-latest", questions: { q: { type: "noul", instructions: "?" } } };
  const s = stub({ [OPENROUTER]: reply(200, { answers: { q: { type: "noul", noul: 0.7 } } }) });
  await askDecisionOne(body, { fetchImpl: s.fetchImpl, model: GEMINI_DECISION_MODEL });
  ok(s.calls[0].body.model === GEMINI_DECISION_MODEL && withoutModel(s.calls[0].body) === withoutModel(body) && s.calls[0].path === "/api/alpha/decisions", "Gemini Decision-1 is asked on the same endpoint with only the model changed");
  process.env.GEMINI_DECISION = "off";
  ok(!openRouterDecisionsEnabled(GEMINI_DECISION_MODEL) && decisionOneEnabled() && openRouterDecisionsEnabled(JEV_OR), "GEMINI_DECISION=off turns off Gemini alone");
  delete process.env.GEMINI_DECISION;
  process.env.JEV_OPENROUTER = "off";
  ok(!openRouterDecisionsEnabled(JEV_OR) && decisionOneEnabled(), "JEV_OPENROUTER=off turns off Jev over OpenRouter alone");
  delete process.env.JEV_OPENROUTER;
  let e = null; const s2 = stub({ [OPENROUTER]: reply(200, { answers: {} }) });
  try { await askDecisionOne(body, { fetchImpl: s2.fetchImpl, model: "other/model" }); } catch (x) { e = x; }
  ok(e?.statusCode === 503 && s2.calls.length === 0, "a model this client does not list is refused unsent");

  const bytes = Math.max(decisionsRequestBytes(body, DECISION_ONE_MODEL), decisionsRequestBytes(body, JEV_OR));
  process.env.DECISION_ONE_DAILY_MAX_BYTES = String(bytes * 2 + 10);
  _decisionOneSpendReset();
  const s3 = stub({ [OPENROUTER]: reply(200, { answers: { q: { type: "noul", noul: 0.5 } } }) });
  await askDecisionOne(body, { fetchImpl: s3.fetchImpl });
  await askDecisionOne(body, { fetchImpl: s3.fetchImpl, model: JEV_OR });
  e = null; try { await askDecisionOne(body, { fetchImpl: s3.fetchImpl, model: GEMINI_DECISION_MODEL }); } catch (x) { e = x; }
  ok(s3.calls.length === 2 && e?.statusCode === 503, "the daily byte ceiling is one count across every OpenRouter model");
  delete process.env.DECISION_ONE_DAILY_MAX_BYTES;
  _decisionOneSpendReset();
}
{
  setUpstreamCostsForTest(fullTable());
  {
    // The /v1/judge Bazaar listing names no fallback count: the backend list
    // grows (Gemini Decision-1 and Jev over OpenRouter joined), and a typed
    // count goes stale the day it does.
    const { BAZAAR_DESCRIPTIONS } = await import("../src/payments.js");
    const COUNT = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:more\s+)?(?:fallbacks?|backups?|backends?)\b/i;
    ok(typeof BAZAAR_DESCRIPTIONS.judge === "string" && /fallbacks/.test(BAZAAR_DESCRIPTIONS.judge) && !COUNT.test(BAZAAR_DESCRIPTIONS.judge), `the /v1/judge listing says it has fallbacks and names no count (${(BAZAAR_DESCRIPTIONS.judge || "").match(/Served by[^.]*\./)?.[0]})`);
    ok(COUNT.test("Served by jev-latest with two fallbacks; name one first with model.") && COUNT.test("with 3 fallbacks"), "control: the count pattern reads a typed count");
  }
  ok(geminiDecisionOffered() && jevOpenRouterOffered(), "with their table rates both new models are offered");
  ok(JUDGE_TOOLS[0].discovery.inputSchema.properties.model.enum.includes(GEMINI_DECISION) && /Gemini Decision-1/.test(JUDGE_TOOLS[0].description) && /Gemini Decision-1/.test(JUDGE_TOOLS[1].description), "the /v1/judge enum names gemini-decision-1 and both descriptions name it");
  ok(JUDGE_TOOLS[1].discovery.inputSchema.properties.model.enum.join() === LUNA, "/v1/decisions keeps its one-model enum");

  // Every backend down: each is tried once, in order.
  for (const [why, input, want] of [
    ["the default", JUDGE_IN, `${TYPESAFE},${OPENROUTER},${OPENROUTER},${OPENROUTER},${OPENAI}`, `${JEV_OR},${DECISION_ONE_MODEL},${GEMINI_DECISION_MODEL}`],
    ["naming gemini-decision-1", { ...JUDGE_IN, model: GEMINI_DECISION }, `${OPENROUTER},${TYPESAFE},${OPENROUTER},${OPENROUTER},${OPENAI}`, `${GEMINI_DECISION_MODEL},${JEV_OR},${DECISION_ONE_MODEL}`],
    ["naming jev-preview", { ...JUDGE_IN, model: "jev-preview" }, `${TYPESAFE},${OPENROUTER},${OPENROUTER},${OPENAI}`, `${DECISION_ONE_MODEL},${GEMINI_DECISION_MODEL}`],
  ].map(([a, b, c, d]) => [a, b, [c, d]])) {
    const s = stub({ [TYPESAFE]: DOWN, [OPENROUTER]: DOWN, [OPENAI]: DOWN });
    let e = null; try { await judge(input, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
    ok(e?.statusCode >= 500 && s.hosts() === want[0] && orModels(s) === want[1], `/v1/judge ${why}: ${s.hosts()} (${orModels(s)})`);
  }
  {
    const s = stub({ [TYPESAFE]: DOWN, [OPENROUTER]: byModel({ [JEV_OR]: reply(200, JEV_SHAPE("typesafe/jev-1.14-20261014")) }), [OPENAI]: LUNA_OK });
    const r = await judge(JUDGE_IN, { fetchImpl: s.fetchImpl });
    ok(s.hosts() === `${TYPESAFE},${OPENROUTER}` && s.calls[1].body.model === JEV_OR && withoutModel(s.calls[1].body) === withoutModel(s.calls[0].body),
      "/v1/judge: a TypeSafe outage is answered by the same Jev version over OpenRouter, with Jev's body, only the model changed");
    ok(r.model === JEV_PINNED && !("fallbackFrom" in r) && r.answers.repro.noul === 0.32, `...the answer names the model that served (${r.model}) and no fallback, since the model is the same`);
  }
  {
    const s = stub({ [TYPESAFE]: DOWN, [OPENROUTER]: byModel({ [JEV_OR]: timeout, [DECISION_ONE_MODEL]: D1_OK }) });
    let e = null; try { await judge(JUDGE_IN, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
    ok(e?.statusCode >= 500 && orModels(s) === JEV_OR, "a timed-out Jev over OpenRouter ends the call uncharged; no further backend is asked");
  }
  {
    const s = stub({ [OPENROUTER]: byModel({ [GEMINI_DECISION_MODEL]: reply(200, JEV_SHAPE("google/gemini-decision-1-20261111")) }) });
    const r = await judge({ ...JUDGE_IN, model: GEMINI_DECISION }, { fetchImpl: s.fetchImpl });
    ok(orModels(s) === GEMINI_DECISION_MODEL && r.model === GEMINI_DECISION && !("fallbackFrom" in r), "/v1/judge naming gemini-decision-1 is served by Gemini Decision-1, named by the buyer's enum value");
  }
  {
    const DEC_IN = { input: "I was charged twice.", questions: [{ type: "predicate", name: "angry", instructions: "Is the customer angry?" }] };
    const s = stub({ [OPENAI]: DOWN, [TYPESAFE]: DOWN, [OPENROUTER]: byModel({ [JEV_OR]: reply(200, { answers: { angry: { type: "noul", noul: 0.6 } }, usage: { input_tokens: 40 } }) }) });
    const r = await decisions(DEC_IN, { fetchImpl: s.fetchImpl });
    ok(r.model === JEV_PINNED && r.fallback_from === LUNA && r.answers[0].probability === 0.6, "/v1/decisions: after Luna and TypeSafe, Jev over OpenRouter answers; fallback_from names Luna");
  }
  // The price bound: a model is sent a request only while its worst case fits.
  setUpstreamCostsForTest(fullTable({ gemini: RATE * 4 }));
  ok(geminiDecisionFits(250) && !geminiDecisionFits(251), "Gemini Decision-1 is held to the table's share of the price at its own rate");
  {
    const mid = { ...JUDGE_IN, state: "x".repeat(300) };
    const s = stub({ [OPENROUTER]: DOWN, [TYPESAFE]: DOWN, [OPENAI]: DOWN });
    let e = null; try { await judge({ ...mid, model: GEMINI_DECISION }, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
    ok(!orModels(s).includes(GEMINI_DECISION_MODEL), `a request past Gemini's bound is never sent to it, even when named (${orModels(s)})`);
  }
  setUpstreamCostsForTest(fullTable({ gemini: undefined }));
  ok(!geminiDecisionOffered() && upstreamCostsGaps().includes("vendor.decisions.gemini"), "without vendor.decisions.gemini Gemini is not offered, and the table reads partial");
  setUpstreamCostsForTest(fullTable({ jev: undefined }));
  ok(!jevOpenRouterOffered(), "without vendor.decisions.jev Jev over OpenRouter is not offered on the paid route");
  setUpstreamCostsForTest(fullTable());
  process.env.JEV_OPENROUTER = "off";
  {
    const s = stub({ [TYPESAFE]: DOWN, [OPENROUTER]: DOWN, [OPENAI]: DOWN });
    try { await judge(JUDGE_IN, { fetchImpl: s.fetchImpl }); } catch { /* expected */ }
    ok(!orModels(s).includes(JEV_OR), "JEV_OPENROUTER=off keeps the paid route off that leg");
  }
  delete process.env.JEV_OPENROUTER;

  // With the private table (UPSTREAM_COSTS_FILE), each OpenRouter model's
  // largest admitted request costs at most the table's share of the price.
  if (process.env.UPSTREAM_COSTS_FILE) {
    setUpstreamCostsForTest(null);
    const { upstreamCosts } = await import("../src/upstream-costs.js");
    const d = upstreamCosts().vendor?.decisions || {};
    for (const [k, fitsFn] of [["gemini", geminiDecisionFits], ["jev", kit.jevOpenRouterFits], ["decisionOne", decisionOneFits]]) {
      const okAll = [1, 1000, 4000, kit.LIMITS.bodyBytes].every((b) => !fitsFn(b) || (b * d[k]) / 1e6 <= d.maxShare * JUDGE_PRICE_USD);
      ok(d[k] != null ? okAll : true, `private table: every ${k} request admitted stays within the price share${d[k] == null ? " (key absent: not offered)" : ""}`);
    }
    setUpstreamCostsForTest(fullTable());
  }
}

// ---- null probabilities: one null never drops the other answers ----------------
{
  setUpstreamCostsForTest(fullTable());
  const withNull = (shape) => { const j = JEV_SHAPE(shape); j.answers.repro = { type: "noul", noul: null }; return reply(200, j); };
  {
    const s = stub({ [TYPESAFE]: withNull("jev-1.14.0") });
    const r = await judge(JUDGE_IN, { fetchImpl: s.fetchImpl });
    ok(r.answers.repro.noul === null && r.answers.repro.noProbability === true && r.answers.team.choice === "frontend" && r.answers.sev.score === 1.4,
      "/v1/judge: a null noul is an explicit no-probability answer and every other answer is kept");
    ok(r.note === JUDGE_NOTE && /noProbability/.test(r.note) && s.hosts() === TYPESAFE, "...the note documents it, and no other backend is asked");
  }
  {
    const s = stub({ [TYPESAFE]: DOWN, [OPENROUTER]: byModel({ [JEV_OR]: withNull("typesafe/jev-1.14") }) });
    const r = await judge(JUDGE_IN, { fetchImpl: s.fetchImpl });
    ok(r.answers.repro.noProbability === true && r.answers.team.choice === "frontend", "the same over OpenRouter's Decisions endpoint");
  }
  {
    const s = stub({ [TYPESAFE]: reply(200, { answers: { repro: { type: "noul", noul: null } } }), [OPENROUTER]: D1_OK });
    let e = null; try { await judge({ state: "s", questions: { repro: { type: "noul", instructions: "?" } } }, { fetchImpl: s.fetchImpl }); } catch (x) { e = x; }
    ok(e?.statusCode === 502 && e.mayBeBilled && s.hosts() === TYPESAFE, "an answer set with no probability at all is an uncharged 502, as before");
  }
  {
    const s = stub({ [TYPESAFE]: withNull("jev-1.14.0") });
    let e = null; try { await judge(JUDGE_IN, { fetchImpl: s.fetchImpl, strictProbabilities: true }); } catch (x) { e = x; }
    ok(e?.statusCode === 502, "a caller that needs every number (the loop gate) still reads a null as unreadable");
  }
  {
    const luna = { answers: [
      { type: "score", name: "q0", score: 1.27, probabilities: [], confidence: 0.15 },
      { type: "predicate", name: "q1", probability: null },
      { type: "choice", name: "q2", choice: "frontend", probabilities: [{ value: "frontend", probability: null }], confidence: 0.97 },
    ], usage: { input_tokens: 300 } };
    const s = stub({ [OPENAI]: reply(200, luna) });
    const r = await judge({ ...JUDGE_IN, model: LUNA }, { fetchImpl: s.fetchImpl });
    ok(r.model === LUNA && r.answers.repro.noProbability === true && r.answers.repro.noul === null && r.answers.team.choice === "frontend" && r.answers.sev.score === 1.27,
      "/v1/judge from the Decisions shape: a null predicate probability is kept as no probability beside the other answers");
    ok(r.answers.team.probabilities.frontend === null, "...and a null option probability stays null, never a number");
  }
  {
    const DEC_IN = { input: "I was charged twice.", questions: [
      { type: "predicate", name: "angry", instructions: "Is the customer angry?" },
      { type: "choice", name: "dept", instructions: "Which team?", choices: [{ value: "billing", description: "money" }, { value: "tech", description: "bugs" }] },
    ] };
    const s = stub({ [OPENAI]: reply(200, { answers: [{ type: "predicate", name: "angry", probability: null }, { type: "choice", name: "dept", choice: "billing", probabilities: [{ value: "billing", probability: 0.9 }, { value: "tech", probability: 0.1 }], confidence: 0.8 }] }) });
    const r = await decisions(DEC_IN, { fetchImpl: s.fetchImpl });
    ok(r.answers[0].probability === null && r.answers[1].choice === "billing", "/v1/decisions: a null predicate probability passes through beside the other answers");
    const s2 = stub({ [OPENAI]: DOWN, [TYPESAFE]: reply(200, { answers: { angry: { type: "noul", noul: null }, dept: { type: "choice", choice: "billing", confidence: 0.8, probabilities: { billing: 0.9, tech: null } } } }) });
    const r2 = await decisions(DEC_IN, { fetchImpl: s2.fetchImpl });
    ok(r2.answers[0].probability === null && r2.answers[1].probabilities.find((p) => p.value === "tech").probability === null && r2.answers[1].probabilities.find((p) => p.value === "billing").probability === 0.9,
      "/v1/decisions from Jev: no probability reads null, never 0");
    const s3 = stub({ [OPENAI]: reply(200, { answers: [{ type: "predicate", name: "only", probability: null }] }), [TYPESAFE]: JEV_OK });
    let e = null; try { await decisions({ input: "x", questions: [{ type: "predicate", name: "only", instructions: "?" }] }, { fetchImpl: s3.fetchImpl }); } catch (x) { e = x; }
    ok(e?.statusCode === 502 && s3.hosts() === OPENAI, "/v1/decisions: every answer null is an uncharged 502, and no second backend is paid");
  }
}

// ---- tool-judge: Jev over OpenRouter is booked like every other leg -------------
{
  toolJudge._jevReset();
  const s = stub({ [TYPESAFE]: reply(503, {}), [OPENROUTER]: byModel({ [JEV_OR]: reply(503, {}), [DECISION_ONE_MODEL]: choiceAnswer("html-to-json", 0.93) }) });
  const r = await toolJudge.judgeTool("extract a web page into structured json, three legs", [A, B], { fetchImpl: s.fetchImpl });
  const st = toolJudge.jevSpendStatus();
  const want = s.calls.reduce((n, c) => n + Buffer.byteLength(c.raw) + 300, 0);
  ok(r?.choice === "html-to-json" && orModels(s) === `${JEV_OR},${DECISION_ONE_MODEL}`, "tool-judge: TypeSafe down, then Jev over OpenRouter down, then Decision-1 answers");
  ok(st.calls === 3 && st.openRouterCalls === 2 && st.tokens === want, `...every leg is booked against the one daily ceiling (${st.tokens} of ${want}; ${st.openRouterCalls} over OpenRouter)`);

  for (const [why, leg] of [["a timed-out", timeout], ["an unreadable 200 from", reply(200, { answers: { best: { choice: 7 } } })]]) {
    toolJudge._jevReset();
    const sb = stub({ [TYPESAFE]: reply(503, {}), [OPENROUTER]: byModel({ [JEV_OR]: leg, [DECISION_ONE_MODEL]: choiceAnswer("html-to-json", 0.93) }) });
    const rb = await toolJudge.judgeTool(`extract a web page into structured json, ${why}`, [A, B], { fetchImpl: sb.fetchImpl });
    ok(rb === null && orModels(sb) === JEV_OR, `tool-judge: ${why} Jev over OpenRouter ends the walk; Decision-1 is not asked (${orModels(sb)})`);
  }
  toolJudge._jevReset();
  // Room for TypeSafe and Jev over OpenRouter, not for Decision-1.
  process.env.JEV_DAILY_MAX_TOKENS = String(Buffer.byteLength(s.calls[0].raw) + Buffer.byteLength(s.calls[1].raw) + 600 + 5);
  const sc = stub({ [TYPESAFE]: reply(503, {}), [OPENROUTER]: byModel({ [JEV_OR]: reply(503, {}), [DECISION_ONE_MODEL]: choiceAnswer("html-to-json", 0.93) }) });
  const outcome = {};
  const rc = await toolJudge.judgeTool("extract a web page into structured json, three legs", [A, B], { fetchImpl: sc.fetchImpl, outcome });
  ok(rc === null && orModels(sc) === JEV_OR && outcome.skipped === "budget", "tool-judge: a leg past the ceiling is not sent, and says budget");
  delete process.env.JEV_DAILY_MAX_TOKENS;

  toolJudge._jevReset();
  delete process.env.TYPESAFE_API_KEY;
  const sa = stub({ [OPENROUTER]: byModel({ [JEV_OR]: choiceAnswer("pdf-extract-pages", 0.95) }) });
  const ra = await toolJudge.judgeTool("pages from a pdf", [A, B], { fetchImpl: sa.fetchImpl });
  ok(ra?.choice === "pdf-extract-pages" && orModels(sa) === JEV_OR && toolJudge.jevSpendStatus().openRouterCalls === 1, "tool-judge: with no TypeSafe key, Jev over OpenRouter serves first");
  process.env.TYPESAFE_API_KEY = "ts-test-not-real";
  toolJudge._jevReset();
}

console.warn = quiet;
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
