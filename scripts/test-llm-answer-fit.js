// A buyer's reasoning setting is fitted to their output cap before the
// upstream call, and an answer that still comes back empty for length gets one
// same-model try at the lowest effort before the chain walks on. Chat
// completions, Messages and Responses, buffered and streamed. Offline: every
// upstream is a stub fetch, and no figure from a cost table is written here.
//
//   node scripts/test-llm-answer-fit.js
process.env.POSTHOG_TEST_CAPTURE = "1";
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import {
  TIERS, LLM_GATEWAY_TOOLS, MARGIN, meteredQuoteUsd, validateRequest, tierAllows, reasoningProfile, worstCaseUpstreamCost,
  smallBudgetEffort, smallBudgetThreshold, fitEffortToBudget, fitBudgetForAnswer, lowestEffortFor, lowestEffortRetry, reasoningForLink,
  recoveryRunAffordable, retryEmptyAtLowestEffort, timedOutBudget, REASONING_ADJUSTED_HEADER, EMPTY_LENGTH_MESSAGE, DEFAULT_MAX_TOKENS,
} from "../src/tools/llm-gateway-kit.js";
import { LLM_MESSAGES_TOOLS, meteredMessagesQuoteUsd, EMPTY_MAX_TOKENS_MESSAGE } from "../src/tools/llm-messages-kit.js";
import { LLM_RESPONSES_TOOLS, meteredResponsesQuoteUsd, EMPTY_INCOMPLETE_MESSAGE } from "../src/tools/llm-responses-kit.js";
import { LLM_GEMINI_TOOLS } from "../src/tools/llm-gemini-kit.js";
import { CORS_EXPOSE_HEADERS } from "../src/cors.js";
const { requireUpstreamCosts } = await import("./lib/require-upstream-costs.js");
requireUpstreamCosts("test-llm-answer-fit");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const realFetch = globalThis.fetch;
process.env.OPENROUTER_API_KEY = "test-key";

const payHeader = (from, extra = {}) => Buffer.from(JSON.stringify({ payload: { authorization: { from, ...extra } } })).toString("base64");
let payerSeq = 0x7000;
// A fresh payer per call: no per-payer state carries between checks.
const req = (extra) => { const h = payHeader(`0xAbCdEf000000000000000000000000000000${(payerSeq++).toString(16)}`, extra); return { header: (n) => (n === "payment-signature" ? h : undefined) }; };
const msgs = (t = "hi") => [{ role: "user", content: t }];

const chat = (slug) => LLM_GATEWAY_TOOLS.find((t) => t.slug === slug);
const messages = (slug) => LLM_MESSAGES_TOOLS.find((t) => t.slug === `${slug}-messages`);
const responses = (slug) => LLM_RESPONSES_TOOLS.find((t) => t.slug === `${slug}-responses`);

// Stub answers per wire. `empty` = the whole cap spent before any content.
// EMPTY_COST is what the stub reports for an empty run: small against every
// tier price, so the retry's price check passes unless a check raises it.
const EMPTY_COST = 0.000001;
const chatReply = (b, { empty = false, cost = EMPTY_COST } = {}) => ({ id: "gen-c", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: empty ? "" : "answer" }, finish_reason: empty ? "length" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: empty ? b.max_tokens : 3, cost } });
const msgReply = (b, { empty = false, cost = EMPTY_COST } = {}) => ({ id: "gen-m", type: "message", role: "assistant", model: b.model, content: empty ? [{ type: "thinking", thinking: "hmm" }] : [{ type: "text", text: "answer" }], stop_reason: empty ? "max_tokens" : "end_turn", usage: { input_tokens: 1, output_tokens: empty ? b.max_tokens : 3, cost } });
const respReply = (b, { empty = false, cost = EMPTY_COST } = {}) => ({ id: "resp_x", object: "response", model: b.model, status: empty ? "incomplete" : "completed", ...(empty ? { incomplete_details: { reason: "max_output_tokens" } } : {}), output: empty ? [{ type: "reasoning", summary: [] }] : [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "answer", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: empty ? b.max_output_tokens : 3, cost } });
const WIRES = {
  chat: { tool: chat, reply: chatReply, cap: "max_tokens", effortOf: (b) => b.reasoning?.effort, body: (model, cap, effort, more = {}) => ({ model, messages: msgs(), max_tokens: cap, ...(effort ? { reasoning: { effort } } : {}), ...more }), field: "reasoning.effort", said: (d) => d?.choices?.[0]?.message?.content === "answer", emptyMessage: EMPTY_LENGTH_MESSAGE },
  messages: { tool: messages, reply: msgReply, cap: "max_tokens", effortOf: (b) => b.effort, body: (model, cap, effort, more = {}) => ({ model, messages: msgs(), max_tokens: cap, ...(effort ? { effort } : {}), ...more }), field: "effort", said: (d) => d?.content?.[0]?.text === "answer", emptyMessage: EMPTY_MAX_TOKENS_MESSAGE },
  responses: { tool: responses, reply: respReply, cap: "max_output_tokens", effortOf: (b) => b.reasoning?.effort, body: (model, cap, effort, more = {}) => ({ model, input: "hi", max_output_tokens: cap, ...(effort ? { reasoning: { effort } } : {}), ...more }), field: "reasoning.effort", said: (d) => d?.output?.[0]?.content?.[0]?.text === "answer", emptyMessage: EMPTY_INCOMPLETE_MESSAGE },
};
/** Stub upstream: records each sent body; `plan(body, index)` returns the
 *  reply options for that call. */
const stub = (wire, plan = () => ({})) => {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    sent.push(b);
    return { ok: true, status: 200, text: async () => JSON.stringify(wire.reply(b, plan(b, sent.length - 1))) };
  };
  return sent;
};
// A rejection becomes a value, so a check that expected an answer prints FAIL
// instead of ending the run.
const settled = (p) => p.catch((e) => ({ __threw: e }));
const trail = (wire, sent) => sent.map((b) => `${b.model}@${wire.effortOf(b) ?? "-"}`).join(" > ");

// ---- the rule itself ----
const PREMIUM = "v1-chat-premium";
const OPUS = "anthropic/claude-opus-5";       // premium, reasoning mandatory, no "none"
const NANO = "v1-chat-nano";
const GPT5N = "openai/gpt-5-nano";            // nano, reasoning mandatory, lowest effort "minimal"
ok(tierAllows(PREMIUM, OPUS) && tierAllows(NANO, GPT5N) && !reasoningProfile(OPUS).efforts.includes("none") && lowestEffortFor(GPT5N) === "minimal" && lowestEffortFor(OPUS) === "low", "fixture models: premium Opus 5 and nano gpt-5-nano reason on every call");
{
  const t = TIERS[PREMIUM].defaultMaxTokens;
  ok(smallBudgetThreshold(PREMIUM) === t && smallBudgetThreshold(NANO) === Math.min(DEFAULT_MAX_TOKENS, TIERS[NANO].maxTokens), "the threshold is the tier's own default output budget, within its maximum");
  // One rule, both callers: the effort a buyer with no preference gets is the
  // effort a too-high buyer effort is fitted to, at the same budgets.
  let agree = true;
  for (const cap of [1, 64, t - 1, t, t + 1, TIERS[PREMIUM].maxTokens]) {
    const noPref = smallBudgetEffort(OPUS, PREMIUM, cap);
    const fitted = fitEffortToBudget(OPUS, PREMIUM, "high", cap);
    if ((noPref === "low") !== (fitted === "low") || (noPref === null) !== (fitted === "high")) agree = false;
  }
  ok(agree, "a buyer effort is fitted at exactly the budgets where a buyer with no preference gets the small-budget effort");
  ok(fitEffortToBudget(OPUS, PREMIUM, "xhigh", t - 1) === "low" && fitEffortToBudget(OPUS, PREMIUM, "max", 64) === "low" && fitEffortToBudget(OPUS, PREMIUM, "medium", t - 1) === "low", "under the threshold every effort above low is sent as low");
  ok(fitEffortToBudget(OPUS, PREMIUM, "low", 64) === "low" && fitEffortToBudget(GPT5N, NANO, "minimal", 64) === "minimal" && fitEffortToBudget("openai/gpt-5.6-luna", NANO, "none", 64) === "none", "an effort at or below low is never changed (the fit only lowers)");
  ok(fitEffortToBudget(OPUS, PREMIUM, "high", t) === "high" && fitEffortToBudget(OPUS, PREMIUM, "max", TIERS[PREMIUM].maxTokens) === "max", "at or above the threshold the buyer's effort is sent as given");
  ok(fitEffortToBudget("deepseek/deepseek-chat", NANO, "high", 64) === "high", "a model with no table row keeps the buyer's effort");
  ok(fitEffortToBudget("x-ai/grok-4.6", "v1-chat-pro", "high", 64) === "high" && reasoningForLink({ effort: "high", max_tokens: 60 }, "x-ai/grok-4.6", "v1-chat-pro", 64).note === null, "a model whose reasoning bills outside the cap keeps the buyer's effort and budget (the cap bounds only its answer)");
  ok(fitBudgetForAnswer(8000, 8192) === 8192 - 2048 && fitBudgetForAnswer(1000, 8192) === 1000 && fitBudgetForAnswer(1024, 1100, { floor: 1024 }) === 1024 && fitBudgetForAnswer(3, 4) === 3 && fitBudgetForAnswer(1, 2) === 1, "a budget is lowered to leave a quarter of the cap, never raised and never under the provider floor");
  let neverUp = true;
  for (let cap = 2; cap <= 9000; cap += 37) for (const b of [1, Math.floor(cap / 2), cap - 1]) { const f = fitBudgetForAnswer(b, cap); if (!(f <= b && f >= 1 && f < cap)) neverUp = false; }
  ok(neverUp, "a fitted budget is never above the buyer's and always under the cap");
  const r = reasoningForLink({ effort: "high", exclude: true }, OPUS, PREMIUM, 512);
  ok(same(r.reasoning, { effort: "low", exclude: true }) && same(r.note, { field: "reasoning.effort", requested: "high", used: "low", reason: "max_tokens" }), "reasoningForLink: fitted effort, other fields kept, disclosure shaped {field, requested, used, reason}");
  const rb = reasoningForLink({ max_tokens: 500 }, OPUS, PREMIUM, 512);
  ok(same(rb.reasoning, { max_tokens: 384 }) && same(rb.note, { field: "reasoning.max_tokens", requested: 500, used: 384, reason: "max_tokens" }), "reasoningForLink: a budget that leaves no room is lowered and disclosed");
  ok(same(reasoningForLink(undefined, GPT5N, NANO, 64), { reasoning: { effort: "minimal" }, note: null }), "a buyer with no preference gets the tier default and no disclosure");
  ok(lowestEffortRetry({ effort: "minimal" }, undefined, GPT5N) === null && lowestEffortRetry({ effort: "low" }, { effort: "low" }, OPUS) === null && lowestEffortRetry({ effort: "high" }, { effort: "high" }, "deepseek/deepseek-chat") === null && lowestEffortRetry({ enabled: false }, { enabled: false }, OPUS) === null, "no recovery plan when the attempt was already at the model's lowest effort, reasoning was off, or the model has no row");
  ok(same(lowestEffortRetry({ effort: "low" }, { effort: "high" }, "openai/gpt-5.6-luna"), { reasoning: { effort: "none" }, note: { field: "reasoning.effort", requested: "high", used: "none", reason: "empty_answer_retry" } }), 'the recovery plan is the lowest listed effort, "none" where the table lists it');
  ok(same(lowestEffortRetry(undefined, undefined, OPUS).note, { field: "reasoning.effort", requested: "default", used: "low", reason: "empty_answer_retry" }) && same(lowestEffortRetry({ max_tokens: 300 }, { max_tokens: 400 }, OPUS), { reasoning: { effort: "low" }, note: { field: "reasoning.max_tokens", requested: 400, used: "low", reason: "empty_answer_retry" } }), 'a buyer with no effort reads requested "default"; a budget is replaced by the effort');
}

// ---- (a) (b) (e): fit before spending, on every wire ----
for (const [name, w] of Object.entries(WIRES)) {
  const tool = w.tool(PREMIUM);
  const small = 1024;
  ok(small < smallBudgetThreshold(PREMIUM), `${name}: fixture cap is under the premium threshold`);
  // (a) too high for the cap: sent at the fitted effort, disclosed
  let sent = stub(w);
  const fitted = await settled(tool.handler(w.body(OPUS, small, "high"), req()));
  ok(sent.length === 1 && w.effortOf(sent[0]) === "low" && same(fitted.agent402_reasoning_adjusted, { field: w.field, requested: "high", used: "low", reason: w.cap }) && w.said(fitted), `${name} (a): effort high at a small cap on a mandatory-reasoning model goes upstream as low, and the answer says so (${JSON.stringify(fitted.agent402_reasoning_adjusted)})`);
  // (e) the cap is the buyer's, exactly
  ok(sent[0][w.cap] === small, `${name} (e): the fitted request carries the buyer's own cap, not a larger one (${sent[0][w.cap]})`);
  // (b) fits: sent unchanged, no field
  sent = stub(w);
  const cap = smallBudgetThreshold(PREMIUM);
  const asGiven = await tool.handler(w.body(OPUS, cap, "high"), req());
  ok(sent.length === 1 && w.effortOf(sent[0]) === "high" && asGiven.agent402_reasoning_adjusted === undefined && sent[0][w.cap] === cap, `${name} (b): an effort that fits its cap is sent unchanged and the field is absent`);
  sent = stub(w);
  const lowAsGiven = await tool.handler(w.body(OPUS, small, "low"), req());
  ok(w.effortOf(sent[0]) === "low" && lowAsGiven.agent402_reasoning_adjusted === undefined, `${name} (b): an effort already at low is not reported as adjusted`);
  // (e) the fitted request differs from the unfitted one ONLY in the effort:
  // same cap, same provider price bound, same service tier, no added field.
  sent = stub(w);
  await tool.handler(w.body(OPUS, small, "low"), req());
  const asLow = sent[0];
  sent = stub(w);
  await tool.handler(w.body(OPUS, small, "high"), req());
  const strip = (b) => { const c = JSON.parse(JSON.stringify(b)); delete c.user; delete c.session_id; return c; };
  ok(same(strip(asLow), strip(sent[0])) && same(asLow.provider?.max_price, sent[0].provider?.max_price) && !!sent[0].provider?.max_price, `${name} (e): a fitted "high" goes upstream as the very body a buyer "low" does (same cap, price bound and service tier)`);
}

// ---- (e): the metered quote does not read the effort; the served body keeps the quoted cap ----
{
  const M = "v1-chat-metered";
  const model = TIERS[M].defaultModel;
  const prof = reasoningProfile(model);
  ok(!!prof && prof.efforts.includes("high"), "metered fixture model takes an effort");
  const quotes = {
    chat: (effort) => meteredQuoteUsd(WIRES.chat.body(model, 256, effort)),
    messages: (effort) => meteredMessagesQuoteUsd(WIRES.messages.body(model, 256, effort)),
    responses: (effort) => meteredResponsesQuoteUsd(WIRES.responses.body(model, 256, effort)),
  };
  for (const [name, w] of Object.entries(WIRES)) {
    const high = quotes[name]("high"), low = quotes[name]("low"), none = quotes[name](undefined);
    ok(!high.invalid && high.usd === low.usd && none.usd <= high.usd, `${name} (e): the metered quote for a body is the same at effort high and at low, and no higher with none set`);
    const sent = stub(w);
    const r = req(); r.__meteredQuoteUsd = high.usd;
    const out = await w.tool(M).handler(w.body(model, 256, "high"), r);
    ok(sent.length === 1 && sent[0][w.cap] === 256 && w.effortOf(sent[0]) === "low" && out.agent402_reasoning_adjusted?.used === "low", `${name} (e): gated at that quote, the metered call is served with the quoted cap at the fitted effort`);
    const wcHigh = worstCaseUpstreamCost({ model, max_tokens: sent[0][w.cap], messages: msgs() }, TIERS[M], 0).totalUsd;
    const wcBuyer = worstCaseUpstreamCost({ model, max_tokens: 256, messages: msgs() }, TIERS[M], 0).totalUsd;
    ok(wcHigh <= wcBuyer, `${name} (e): the worst case priced for the sent body is not above the buyer's own`);
  }
  ok(validateRequest(WIRES.chat.body(model, 256, "high"), M).reasoning.effort === "high", "the normalized body (cache key, quote input) keeps the buyer's own effort; only the outbound link is fitted");
}

// ---- (c): one same-model retry at the lowest effort, served once ----
for (const [name, w] of Object.entries(WIRES)) {
  const tool = w.tool(NANO);
  // gpt-5-nano at 64 tokens, buyer effort high: fitted to low; low comes back
  // empty; the one retry at minimal answers.
  let sent = stub(w, (b) => ({ empty: w.effortOf(b) !== "minimal", cost: w.effortOf(b) === "minimal" ? 0.000002 : EMPTY_COST }));
  let resolved = 0;
  const out = await settled(tool.handler(w.body(GPT5N, 64, "high"), req()).then((d) => { resolved++; return d; }));
  ok(sent.length === 2 && sent.every((b) => b.model === GPT5N) && w.effortOf(sent[0]) === "low" && w.effortOf(sent[1]) === "minimal", `${name} (c): an empty-for-length first answer gets exactly one same-model try at the lowest effort (${trail(w, sent)})`);
  ok(resolved === 1 && w.said(out) && same(out.agent402_reasoning_adjusted, { field: w.field, requested: "high", used: "minimal", reason: "empty_answer_retry" }), `${name} (c): the second answer is the one served, once, with the field (${JSON.stringify(out.agent402_reasoning_adjusted)})`);
  ok(out.__meterUpstreamUsd === 0.000002 && out.usage?.cost === undefined && !out.__threw, `${name} (c): the answer is metered at the served run alone, and no billing field leaves`);
  // (e) the retry is the same request with a lower effort: never a larger cap
  ok(sent[1][w.cap] === sent[0][w.cap] && sent[1][w.cap] === 64 && same(sent[1].provider, sent[0].provider) && sent[1].service_tier === sent[0].service_tier, `${name} (e): the retry carries the same cap, provider bound and service tier as the first try`);
  // a buyer with no preference on a model already at its lowest effort: no retry, the chain walks as before
  sent = stub(w, (b) => ({ empty: b.model === GPT5N }));
  if (name !== "messages") {
    const walked = await settled(tool.handler(w.body(GPT5N, 64), req()));
    ok(sent.filter((b) => b.model === GPT5N).length === 1 && w.said(walked) && walked.agent402_reasoning_adjusted === undefined, `${name}: an attempt already at the lowest effort is not retried (${trail(w, sent)})`);
  }
}

// ---- (d): two empties walk the chain as before; never a second retry ----
for (const [name, w] of Object.entries(WIRES)) {
  const tool = w.tool(NANO);
  let sent = stub(w, (b) => ({ empty: b.model === GPT5N }));
  const out = await settled(tool.handler(w.body(GPT5N, 64, "high"), req()));
  const own = sent.filter((b) => b.model === GPT5N);
  ok(own.length === 2 && w.effortOf(own[1]) === "minimal" && sent.length === 3 && sent[2].model !== GPT5N && w.said(out) && out.model !== GPT5N, `${name} (d): a second empty answer walks the chain, and the same model's default-tier attempt stays skipped (${trail(w, sent)})`);
  ok(out.agent402_reasoning_adjusted === undefined || out.agent402_reasoning_adjusted.reason !== "empty_answer_retry", `${name} (d): an answer served by a later link does not claim the retry`);
  // every link empty: the existing uncharged 502, and one retry in the whole call
  sent = stub(w, () => ({ empty: true }));
  const e = await tool.handler(w.body(GPT5N, 64, "high"), req()).then(() => null, (x) => x);
  ok(e?.statusCode === 502 && e.message === w.emptyMessage, `${name} (d): end-to-end empty is the 502 with its message (${String(e?.message).slice(0, 60)})`);
  const models = [...new Set(sent.map((b) => b.model))];
  ok(sent.length === models.length + 1 && sent.filter((b) => b.model === GPT5N).length === 2, `${name} (d): ${sent.length} upstream runs for ${models.length} chain models, one recovery try in the whole call`);
}
// A routed chain (auto tier) walks several reasoning models: the retry is
// spent on the first link that comes back empty and no later link gets one.
for (const [name, w] of Object.entries(WIRES)) {
  const sent = stub(w, () => ({ empty: true }));
  const body = w.body(undefined, 64, "high", { quality: "fast" });
  delete body.model;
  const e = await w.tool("v1-chat-auto").handler(body, req()).then(() => null, (x) => x);
  const perModel = {};
  for (const b of sent) perModel[b.model] = (perModel[b.model] || 0) + 1;
  const reasoners = Object.keys(perModel).filter((m) => reasoningProfile(m)).length;
  const twice = Object.values(perModel).filter((n) => n === 2).length;
  ok(e?.statusCode === 502 && reasoners >= 2 && twice === 1 && Math.max(...Object.values(perModel)) === 2, `${name} (d): of ${reasoners} reasoning models walked, exactly one is run a second time (runs per model: ${Object.values(perModel).join(",")})`);
}

// ---- the retry's conditions: price and time ----
for (const [name, w] of Object.entries(WIRES)) {
  const tool = w.tool(NANO);
  // The empty run reports a cost of the whole tier price: another run is not
  // covered, so the chain walks without a retry.
  let sent = stub(w, (b) => ({ empty: b.model === GPT5N, cost: b.model === GPT5N ? TIERS[NANO].price : EMPTY_COST }));
  const out = await settled(tool.handler(w.body(GPT5N, 64, "high"), req()));
  ok(sent.filter((b) => b.model === GPT5N).length === 1 && w.said(out), `${name}: no retry when the call's price does not cover another run (${trail(w, sent)})`);
  // Ten settleable seconds left on the payment: the first attempt runs, a
  // further one is not started (PAYMENT_WINDOW_MIN_START_MS).
  sent = stub(w, () => ({ empty: true }));
  const shortWindow = req({ validBefore: String(Math.floor(Date.now() / 1000) + 6 + 10) });
  const e = await tool.handler(w.body(GPT5N, 64, "high"), shortWindow).then(() => null, (x) => x);
  ok(sent.length === 1 && e?.statusCode === 504, `${name}: no retry when the payment window leaves no time for another attempt (${sent.length} run, ${e?.statusCode})`);
}
{
  const probe = { model: GPT5N, max_tokens: 64, messages: msgs() };
  const tier = TIERS[NANO];
  const worst = worstCaseUpstreamCost(probe, tier, 0).totalUsd;
  const budget = tier.price * MARGIN;
  ok(recoveryRunAffordable(probe, tier, 0, 0) === (worst <= budget) && recoveryRunAffordable(probe, tier, 0, budget) === false && recoveryRunAffordable(probe, tier, 0, budget - worst + budget / 1e3) === false, "the price check is the margin clamp's own budget: the empty run's cost plus one worst-case run must fit under it");
  ok(recoveryRunAffordable(probe, tier, 0, undefined) === (2 * worst <= budget) && recoveryRunAffordable(probe, tier, 0, NaN) === (2 * worst <= budget) && recoveryRunAffordable(probe, tier, 0, -1) === (2 * worst <= budget), "an unreported cost counts as a worst-case run");
  // retryEmptyAtLowestEffort: once per call, and never when a condition fails
  const once = { used: false };
  let runs = 0;
  const args = (over = {}) => ({ once, plan: { reasoning: { effort: "low" } }, affordable: () => true, req: req(), timeouts: timedOutBudget(), run: async () => { runs++; return { fine: true }; }, usable: () => true, ...over });
  ok(await retryEmptyAtLowestEffort(args({ plan: null })) === null && await retryEmptyAtLowestEffort(args({ affordable: () => false })) === null && runs === 0 && once.used === false, "no plan or no price cover: nothing is run and the try is not spent");
  ok((await retryEmptyAtLowestEffort(args()))?.fine === true && runs === 1 && once.used === true, "the try runs once");
  ok(await retryEmptyAtLowestEffort(args()) === null && runs === 1, "a second try in the same call is never run");
  const walk = { used: false };
  ok(await retryEmptyAtLowestEffort(args({ once: walk, run: async () => { throw Object.assign(new Error("upstream"), { statusCode: 502 }); } })) === null && walk.used === true, "an upstream failure on the try is walkable: null, and the chain goes on");
  const refused = await retryEmptyAtLowestEffort(args({ once: { used: false }, run: async () => { throw Object.assign(new Error("gone"), { statusCode: 499 }); } })).then(() => null, (x) => x);
  ok(refused?.statusCode === 499, "a non-upstream error on the try is not swallowed");
  ok(await retryEmptyAtLowestEffort(args({ once: { used: false }, usable: () => false })) === null, "an unusable second answer is not served");
}

// ---- (f) Messages: thinking.budget_tokens ----
{
  const w = WIRES.messages;
  const tool = messages(PREMIUM);
  const HAIKU = "anthropic/claude-haiku-4.5"; // takes a thinking budget, no effort table
  const base = messages("v1-chat");
  ok(tierAllows("v1-chat", HAIKU) && reasoningProfile(HAIKU) === null, "fixture: a budget-taking Claude with no effort row on the base tier");
  let sent = stub(w);
  const cap = TIERS["v1-chat"].maxTokens;
  const lowered = await base.handler({ model: HAIKU, max_tokens: cap, messages: msgs(), thinking: { type: "enabled", budget_tokens: cap - 1 } }, req());
  const want = cap - Math.floor(cap / 4);
  ok(sent[0].thinking?.budget_tokens === want && sent[0].max_tokens === cap && same(lowered.agent402_reasoning_adjusted, { field: "thinking.budget_tokens", requested: cap - 1, used: want, reason: "max_tokens" }), `Messages (a): a thinking budget that leaves no room is sent a quarter of the cap lower and disclosed (${JSON.stringify(lowered.agent402_reasoning_adjusted)})`);
  sent = stub(w);
  const kept = await base.handler({ model: HAIKU, max_tokens: cap, messages: msgs(), thinking: { type: "enabled", budget_tokens: 1024 } }, req());
  ok(sent[0].thinking?.budget_tokens === 1024 && kept.agent402_reasoning_adjusted === undefined, "Messages (b): a budget that leaves room is sent unchanged and the field is absent");
  // (c) an empty answer with a budget: thinking is switched off for the one retry
  sent = stub(w, (b) => ({ empty: b.thinking?.type === "enabled" }));
  const off = await settled(base.handler({ model: HAIKU, max_tokens: cap, messages: msgs(), thinking: { type: "enabled", budget_tokens: 1024 } }, req()));
  ok(sent.length === 2 && sent[1].model === HAIKU && sent[1].thinking?.type === "disabled" && sent[1].max_tokens === cap && w.said(off) && same(off.agent402_reasoning_adjusted, { field: "thinking.budget_tokens", requested: 1024, used: "disabled", reason: "empty_answer_retry" }), `Messages (c): an empty answer under a thinking budget is retried once with thinking off (${JSON.stringify(off.agent402_reasoning_adjusted)})`);
  // premium small-budget effort the gateway chose itself, then empty: the retry has nothing lower (low is Opus's lowest)
  sent = stub(w, (b) => ({ empty: b.model === OPUS }));
  await tool.handler({ model: OPUS, max_tokens: 1024, messages: msgs() }, req()).catch(() => null);
  ok(sent.filter((b) => b.model === OPUS).length === 1, "Messages: the gateway's own small-budget effort at the model's lowest is not retried");
}

// ---- (g) streams are shaped by the same rule, disclosed in a header ----
{
  const sse = {
    chat: 'data: {"id":"c","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
    messages: 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    responses: 'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r"}}\n\n',
  };
  for (const [name, w] of Object.entries(WIRES)) {
    const run = async (body) => {
      const sent = [];
      globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(sse[name]); } } }; };
      const headers = {};
      const res = { headersSent: false, setHeader(k, v) { headers[k] = v; }, removeHeader(k) { delete headers[k]; }, writeHead() { this.headersSent = true; }, flushHeaders() {}, write() {}, end() { this.ended = true; }, on() {}, once() {}, off() {} };
      const h = await w.tool(PREMIUM).handler(body, req());
      await h.__sse(res);
      return { sent, headers, res };
    };
    const a = await run(w.body(OPUS, 1024, "high", { stream: true }));
    ok(a.res.ended && a.sent.length === 1 && a.sent[0].stream === true && w.effortOf(a.sent[0]) === "low" && a.sent[0][w.cap] === 1024, `${name} (g): a streamed request is fitted before the upstream call (effort ${w.effortOf(a.sent[0])}, cap ${a.sent[0][w.cap]})`);
    ok(a.headers[REASONING_ADJUSTED_HEADER] === JSON.stringify({ field: w.field, requested: "high", used: "low", reason: w.cap }), `${name} (g): the stream says so in ${REASONING_ADJUSTED_HEADER}`);
    const b = await run(w.body(OPUS, smallBudgetThreshold(PREMIUM), "high", { stream: true }));
    ok(w.effortOf(b.sent[0]) === "high" && b.headers[REASONING_ADJUSTED_HEADER] === undefined, `${name} (g): a streamed effort that fits is sent unchanged, with no header`);
  }
  // A walk that ends before any byte leaves no header behind on the error answer.
  for (const [name, w] of Object.entries(WIRES)) {
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => "busy" });
    const headers = {};
    const res = { headersSent: false, setHeader(k, v) { headers[k] = v; }, removeHeader(k) { delete headers[k]; }, writeHead() { this.headersSent = true; }, flushHeaders() {}, write() {}, end() {}, on() {}, once() {}, off() {} };
    const h = await w.tool(PREMIUM).handler(w.body(OPUS, 1024, "high", { stream: true, model_fallback: false }), req());
    const e = await h.__sse(res).then(() => null, (x) => x);
    ok(!!e && res.headersSent === false && headers[REASONING_ADJUSTED_HEADER] === undefined, `${name} (g): a stream walk that fails before its first byte clears the header (${e?.statusCode})`);
  }
  ok(CORS_EXPOSE_HEADERS.includes(REASONING_ADJUSTED_HEADER), "a browser client can read the stream header (CORS exposes it)");
}

// ---- no refusal was added: a too-high effort is served, never refused ----
for (const [name, w] of Object.entries(WIRES)) {
  stub(w);
  let refused = 0;
  for (const effort of reasoningProfile(OPUS).efforts) for (const cap of [64, 256, 1024, 4096, 8192]) {
    const r = await w.tool(PREMIUM).handler(w.body(OPUS, cap, effort), req()).then(() => null, (x) => x);
    if (r) refused++;
  }
  ok(refused === 0, `${name}: every supported effort at every cap is served (the fit refuses nothing)`);
}

// ---- the generateContent wire carries the chat handler's disclosure ----
// This wire takes no reasoning field (thinkingConfig is refused), so the one
// adjustment it can serve is the recovery try: no buyer effort, a cap at the
// tier default (no small-budget effort is added), an empty first answer, then
// the same model at its lowest effort.
{
  const tool = LLM_GEMINI_TOOLS.find((t) => t.slug === `${PREMIUM}-gemini`);
  const cap = smallBudgetThreshold(PREMIUM);
  const sent = stub(WIRES.chat, (b, i) => ({ empty: i === 0 }));
  const out = await settled(tool.handler({ model: OPUS, contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: cap } }, req()));
  ok(sent.length === 2 && sent.every((b) => b.model === OPUS) && sent[0].reasoning === undefined && sent[1].reasoning?.effort === "low" && sent[1].max_tokens === cap, `gemini: an empty-for-length first answer gets one same-model try at the lowest effort (${trail(WIRES.chat, sent)})`);
  ok(out?.candidates?.[0]?.content?.parts?.[0]?.text === "answer" && same(out.agent402_reasoning_adjusted, { field: "reasoning.effort", requested: "default", used: "low", reason: "empty_answer_retry" }), `gemini: the generateContent answer carries the adjustment the chat handler made (${JSON.stringify(out?.agent402_reasoning_adjusted)})`);
  stub(WIRES.chat);
  const plain = await settled(tool.handler({ model: OPUS, contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: cap } }, req()));
  ok(plain?.candidates?.[0]?.content?.parts?.[0]?.text === "answer" && plain.agent402_reasoning_adjusted === undefined, "gemini: an answer served on the first try carries no adjustment field");
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
