// Decide serving cost: every model and embedding attempt is metered per
// decision, kept with the decision in the service's own store, readable only
// on the token-gated /internal/decision-cost route, and NEVER part of the
// decision response the main app forwards to a buyer. Offline: stub model and
// stub embedder.
//
//   node scripts/test-decide-cost.js

import { decide, state, summarizeCost, isReady, handler, plainDbConnection, decideDbSsl } from "../services/decide/server.js";
import { makeLlm } from "../services/decide/llm.js";
import { embedTexts, _resetEmbedBudget } from "../services/decide/embed.js";
import { MemoryDecisionStore, makeDecisionCache } from "../services/decide/decision-store.js";
import { ToolIndex } from "../services/decide/tool-index.js";
import { localToolRow } from "../src/decide/tool-rows.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

// ---- the model meter: tokens, reported cost, fallback, failures ----
{
  const reply = (content, usage) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage }) });
  let n = 0;
  const fetchImpl = async (_u, init) => {
    const model = JSON.parse(init.body).model;
    n++;
    if (model === "primary") return { ok: false, status: 429, json: async () => ({}) };
    return reply('{"x":1}', { prompt_tokens: 120, completion_tokens: 30, cost: 0.00042 });
  };
  const llm = makeLlm({ apiKey: "k", models: ["primary", "fallback"], fetchImpl });
  const meter = [];
  const out = await llm.call("s", "u", { meter, stage: "judge" });
  ok(out?.x === 1 && n === 2, "falls back after a refused primary");
  ok(meter.length === 2 && meter[0].outcome === "http_429" && meter[1].outcome === "ok" && meter[1].attempt === 1, "both attempts are metered, in order, with outcomes");
  ok(meter[1].promptTokens === 120 && meter[1].completionTokens === 30 && meter[1].costUsd === 0.00042, "tokens and the upstream's reported cost are recorded");
  const c = summarizeCost(meter, { depth: "plan" });
  ok(c.modelCalls === 2 && c.fallbackUsed === true && c.modelUsd === 0.00042 && c.failedAttempts[0] === "judge:primary:http_429", "summary: calls, fallback flag, $ and the failed attempt named");
}

// ---- the embedding meter ----
{
  _resetEmbedBudget();
  const fetchImpl = async (_u, init) => {
    const input = JSON.parse(init.body).input;
    return { ok: true, status: 200, json: async () => ({ data: input.map((_, i) => ({ index: i, embedding: [0.1, 0.2] })), usage: { prompt_tokens: 11 * input.length, total_tokens: 11 * input.length } }) };
  };
  const meter = [];
  await embedTexts(["a", "b", "c"], { apiKey: "k", fetchImpl, meter, stage: "embed_query" });
  ok(meter.length === 1 && meter[0].items === 3 && meter[0].tokens === 33, "embedding tokens recorded per batch");
}

// ---- decide(): cost stored beside the decision, absent from the response ----
{
  const NOW = Date.now();
  state.index = new ToolIndex();
  for (const [slug, desc] of [["hash", "sha256 hash of text"], ["qr", "QR code image for a URL"]]) {
    state.index.upsert(localToolRow({ route: `POST /api/${slug}`, slug, name: slug, price: "$0.001", description: desc, discovery: { inputSchema: { properties: { text: { type: "string" } }, required: ["text"] } } }, { now: NOW }));
  }
  state.decisions = new MemoryDecisionStore();
  state.cache = makeDecisionCache(60_000);
  state.llm = {
    call: async (_s, _u, { meter, stage } = {}) => {
      meter?.push({ stage, model: "stub", attempt: 0, outcome: "ok", ms: 1, promptTokens: 100, completionTokens: 10, costUsd: 0.0001 });
      if (stage === "decompose") return { steps: [{ purpose: "hash text", query: "sha256 hash", dependsOn: [] }] };
      if (stage === "judge") return { fits: { s1c1: 0.9, s1c2: 0.1, s2c1: 0.9, s2c2: 0.1 } };
      return { params: { 1: { text: "hello" } } };
    },
  };
  // Stub the embeddings upstream so the plan is complete (a partial plan is never cached).
  process.env.OPENAI_API_KEY = "stub";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (!String(u).includes("api.openai.com/v1/embeddings")) return realFetch(u, init);
    const input = JSON.parse(init.body).input;
    return { ok: true, status: 200, json: async () => ({ data: input.map((_, i) => ({ index: i, embedding: Array.from({ length: 512 }, (_, k) => ((k + i) % 7) / 7) })), usage: { total_tokens: 5 * input.length } }) };
  };
  // Not ready until the index has loaded or synced once: no empty plan is sold.
  state.loadedRows = 0; state.lastSync = null;
  let e0 = null; try { await decide({ task: "hash", depth: "quick" }); } catch (e) { e0 = e; }
  ok(!isReady() && e0?.statusCode === 503, "before the first load or sync, a decision is refused 503");
  const probe = await new Promise((resolve) => { const res = { statusCode: 0, setHeader() {}, writeHead(c) { this.statusCode = c; }, end() { resolve(this.statusCode); } }; handler({ method: "GET", url: "/health?ready=1", headers: {} }, res); });
  ok(probe === 503, "/health?ready=1 answers 503 while not ready (plain /health stays liveness)");
  state.lastSync = { complete: true };
  const res = await decide({ task: "hash the text hello with sha256", depth: "plan" });
  const flat = JSON.stringify(res);
  ok(res.decisionId && Array.isArray(res.plan), "a decision is returned");
  ok(!/costUsd|promptTokens|completionTokens|modelUsd|"calls"/.test(flat), "the decision response carries no cost, token or meter field");
  const cost = await state.decisions.getCost(res.decisionId);
  ok(cost && cost.modelCalls >= 2 && cost.modelUsd > 0 && cost.cached === false && cost.depth === "plan", `cost is stored with the decision (${cost?.modelCalls} calls, $${cost?.modelUsd})`);
  const again = await decide({ task: "hash the text hello with sha256", depth: "plan" });
  const c2 = await state.decisions.getCost(again.decisionId);
  ok(cost.embedTokens > 0, "query embedding tokens are part of the decision's cost");
  ok(again.cached === true && c2.cached === true && c2.modelCalls === 0 && c2.modelUsd === 0, "a cache hit is recorded as a zero-model-cost decision");

  // Re-plan (POST /api/decide/execute replan): the saved task, constraints
  // and depth are planned again into a new decision; the task stays here.
  const { routes } = await import("../services/decide/server.js");
  const asked = await decide({ task: "hash the text hello with sha256", depth: "quick", constraints: { excludeSellers: ["nobody.example"] } });
  // The saved plan is still in the decision cache (well inside its TTL): a
  // re-plan is bought to see current prices and reliability, so it plans fresh.
  const reqOf = (body) => { const b = Buffer.from(JSON.stringify(body)); return { async *[Symbol.asyncIterator]() { yield b; } }; };
  const re = await routes["POST /internal/replan"](reqOf({ decisionId: asked.decisionId, priceUsd: 0.005 }));
  const stored = await state.decisions.get(re.decisionId);
  const reCost = await state.decisions.getCost(re.decisionId);
  ok(re.cached === false && reCost?.cached === false, `a re-plan inside the cache TTL plans fresh, not from the cache (cached ${re.cached})`);
  ok(re.decisionId && re.decisionId !== asked.decisionId && re.depth === "quick" && Array.isArray(re.plan) && re.plan.length > 0, `a re-plan is a new decision at the saved depth (${re.decisionId})`);
  ok(stored?.constraints?.excludeSellers?.[0] === "nobody.example" && stored.result.task === "hash the text hello with sha256", "it plans the saved task with the saved constraints");
  let gone = null; try { await routes["POST /internal/replan"](reqOf({ decisionId: "dec_missing" })); } catch (e) { gone = e; }
  ok(gone?.statusCode === 404, "an unknown or pruned decision is a 404");
}

ok(plainDbConnection("postgres://u@postgres.railway.internal:5432/x") && plainDbConnection("postgres://u@127.0.0.1:5433/x") && !plainDbConnection("postgres://u@db.example.com/x"), "TLS is skipped only on the private network or loopback");

ok(decideDbSsl("postgres://u@postgres.railway.internal:5432/x") === false && decideDbSsl("postgres://u@127.0.0.1:5433/x") === false && decideDbSsl("postgres://u@db.example.com/x?sslmode=disable") === false, "no TLS on the private network, loopback, or an explicit sslmode=disable");
ok(decideDbSsl("postgres://u@db.example.com:5432/x")?.rejectUnauthorized === true && decideDbSsl("postgres://u@abc.proxy.rlwy.net:12345/x")?.rejectUnauthorized === true, "a public database host must present a verified certificate");
ok(decideDbSsl("not a url")?.rejectUnauthorized === true, "an unparseable URL is treated as public and verified");
const decideSrc = (await import("node:fs")).readFileSync(new URL("../services/decide/server.js", import.meta.url), "utf8");
ok(/ssl: decideDbSsl\(DB_URL\)/.test(decideSrc) && !/rejectUnauthorized: false/.test(decideSrc), "the pool uses decideDbSsl and never disables verification itself");

console.log(`\ntest-decide-cost: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
