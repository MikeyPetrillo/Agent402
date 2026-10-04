// /v1/.../responses (OpenAI Responses wire) - offline, stub fetch.
process.env.POSTHOG_TEST_CAPTURE = "1";
import { LLM_RESPONSES_TOOLS, validateResponsesRequest, isEmptyIncomplete, RESPONSES_PATH_BY_TIER } from "../src/tools/llm-responses-kit.js";
import { TIERS, createSseUsageScrubber } from "../src/tools/llm-gateway-kit.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";
const { requireUpstreamCosts } = await import("./lib/require-upstream-costs.js");
requireUpstreamCosts("test-llm-responses");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const bySlug = (slug) => LLM_RESPONSES_TOOLS.find((t) => t.slug === slug);
const base = "v1-chat", nanoT = "v1-chat-nano";

ok(LLM_RESPONSES_TOOLS.length === 6 && LLM_RESPONSES_TOOLS.every((t) => t.route === `POST ${RESPONSES_PATH_BY_TIER[t.slug.replace(/-responses$/, "")]}` && WALLET_ONLY_SLUGS.has(t.slug)), "five Responses routes on the tier paths, all wallet-only");

// ---- validation ----
const v = validateResponsesRequest({ model: "openai/gpt-4o-mini", input: "hi", instructions: "terse", max_output_tokens: 99999, temperature: 0.1, text: { format: { type: "text" } } }, base);
ok(v.body.model === "openai/gpt-4o-mini" && v.body.max_output_tokens === TIERS[base].maxTokens && v.body.store === false && v.body.instructions === "terse" && v.body.text.format.type === "text", `valid body: max_output_tokens clamped to the cap (${v.body.max_output_tokens}), store forced false, instructions/text pass`);
ok(validateResponsesRequest({ model: "openai/gpt-4o-mini", input: "hi" }, base).body.max_output_tokens === Math.min(TIERS[base].defaultMaxTokens || 1024, TIERS[base].maxTokens), "max_output_tokens defaults to the tier's own budget, like the chat wire");
{
  const reasoning = "v1-chat-premium";
  const model = TIERS[reasoning].defaultModel;
  const v = validateResponsesRequest({ model, input: "hi" }, reasoning);
  ok(v.body.max_output_tokens === Math.min(TIERS[reasoning].defaultMaxTokens, TIERS[reasoning].maxTokens) && v.body.max_output_tokens > 1024, `a tier whose model reasons before it speaks gets its generous default (${reasoning}: ${v.body.max_output_tokens}), not a hardcoded 1024 that reasoning consumes`);
}
for (const [label, body] of [
  ["no input", { model: "openai/gpt-4o-mini" }],
  ["previous_response_id", { model: "openai/gpt-4o-mini", input: "hi", previous_response_id: "resp_1" }],
  ["background", { model: "openai/gpt-4o-mini", input: "hi", background: true }],
  ["server tool web_search", { model: "openai/gpt-4o-mini", input: "hi", tools: [{ type: "web_search_preview" }] }],
  ["server tool mcp", { model: "openai/gpt-4o-mini", input: "hi", tools: [{ type: "mcp", server_label: "x" }] }],
  ["input_file part", { model: "openai/gpt-4o-mini", input: [{ role: "user", content: [{ type: "input_file", file_id: "f" }] }] }],
  ["bad role", { model: "openai/gpt-4o-mini", input: [{ role: "tool", content: "x" }] }],
  ["unknown item type", { model: "openai/gpt-4o-mini", input: [{ type: "computer_call", id: "x" }] }],
  ["bad reasoning effort", { model: "openai/gpt-4o-mini", input: "hi", reasoning: { effort: "ultra" } }],
  ["model on wrong tier", { model: "anthropic/claude-opus-5", input: "hi" }],
  ["too large", { model: "openai/gpt-4o-mini", input: "x".repeat(TIERS[base].maxInputChars + 1) }],
]) {
  let e = null; try { validateResponsesRequest(body, base); } catch (x) { e = x; }
  ok(e?.statusCode === 400, `${label} -> 400 (${String(e?.message || "").slice(0, 70)})`);
}
{
  const r = validateResponsesRequest({ model: "openai/gpt-4o-mini", input: [
    { role: "developer", content: "be terse" },
    { role: "user", content: [{ type: "input_text", text: "what is in this image?" }, { type: "input_image", image_url: "data:image/png;base64," + "A".repeat(100_000) }] },
    { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "42" },
  ], tools: [{ type: "function", name: "f", parameters: { type: "object" } }] }, base);
  // Tool namespaces on the Responses wire (2026-09-10): flattened outbound,
  // the name -> namespace map puts `namespace` back on each function_call in
  // the non-streamed output (OpenAI's FunctionCall item carries that field).
  {
    const { attributeNamespaces } = await import("../src/tools/tool-namespaces.js");
    const ns = { type: "namespace", name: "crm", description: "CRM tools", tools: [{ type: "function", name: "get_customer", parameters: { type: "object" } }] };
    const rv = validateResponsesRequest({ model: "openai/gpt-4o-mini", input: "hi", tools: [ns, { type: "function", name: "plain", parameters: { type: "object" } }] }, base);
    ok(rv.body.tools.length === 2 && rv.body.tools[0].type === "function" && rv.body.tools[0].name === "get_customer" && /^\[crm\] CRM tools\./.test(rv.body.tools[0].description), "a namespace flattens into Responses-shaped function tools with the namespace context in the description");
    ok(rv.namespaceOf?.get_customer === "crm" && rv.namespaceOf.plain === undefined, "the validator returns the name -> namespace map for the functions that came from a namespace only");
    const out = [{ type: "function_call", name: "get_customer", call_id: "c1", arguments: "{}" }, { type: "function_call", name: "plain", call_id: "c2", arguments: "{}" }, { type: "function_call", name: "get_customer", call_id: "c3", arguments: "{}", namespace: "theirs" }];
    attributeNamespaces(out, rv.namespaceOf);
    ok(out[0].namespace === "crm" && out[1].namespace === undefined && out[2].namespace === "theirs", "output attribution: a namespaced function_call gets namespace, a plain one does not, an existing namespace is never overwritten");
    let e = null; try { validateResponsesRequest({ model: "openai/gpt-4o-mini", input: "hi", tools: [{ type: "namespace", name: "crm", tools: [{ type: "web_search_preview" }] }] }, base); } catch (x) { e = x; }
    ok(e && /not served inside a namespace/.test(e.message), "a server tool nested in a namespace is refused by name");
    const items = (n) => Array.from({ length: n }, () => ({ role: "user", content: "x" }));
    ok(validateResponsesRequest({ model: "openai/gpt-4o-mini", input: items(600) }, "v1-chat-metered").body.input.length === 600, "the metered Responses route accepts 600 input items");
    let f = null; try { validateResponsesRequest({ model: "openai/gpt-4o-mini", input: items(201) }, base); } catch (x) { f = x; }
    ok(f && /\/v1\/metered\/responses allows 1000/.test(f.message), "a flat tier's 200-item refusal names the metered route that would serve it");
  }
  ok(r.imageCount === 1 && JSON.stringify(r.probe).length < 2000 && r.body.tools.length === 1 && r.body.input.length === 4, "item-list input with an image, function tools and tool outputs validates; probe drops the image payload");
  const auto = validateResponsesRequest({ input: "Write a python function that reverses a list" }, "v1-chat-auto");
  ok(auto.isRouted && auto.routedCategory === "code" && auto.body.model === undefined, `auto tier routes by prompt class (${auto.routedCategory})`);
}
ok(isEmptyIncomplete({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning", summary: [] }] }) && !isEmptyIncomplete({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }] }) && !isEmptyIncomplete({ status: "completed", output: [] }), "isEmptyIncomplete: only max_output_tokens + nothing said");

// ---- handler ----
process.env.OPENROUTER_API_KEY = "test-key";
const realFetch = globalThis.fetch;
const fakeReq = { header: (n) => (n === "payment-signature" ? Buffer.from(JSON.stringify({ payload: { authorization: { from: "0xAbCdEf0000000000000000000000000000000004" } } })).toString("base64") : undefined) };
const reply = (model, over = {}) => ({ id: "resp_1", object: "response", status: "completed", model, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello there.", annotations: [] }] }], usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12, cost: 0.0000021, is_byok: false, cost_details: { upstream_inference_cost: 0.0000021 } }, service_tier: "default", ...over });
let seen = [];
globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); seen.push({ url: String(url), b }); return { ok: true, status: 200, text: async () => JSON.stringify(reply(b.model)) }; };
const baseTool = bySlug("v1-chat-responses");
const out = await baseTool.handler({ model: "openai/gpt-4o-mini", input: "hi", max_output_tokens: 64, text: { format: { type: "json_schema", name: "a", schema: { type: "object" } } } }, fakeReq);
ok(seen[0].url.endsWith("/api/v1/responses") && seen[0].b.model === "openai/gpt-4o-mini" && seen[0].b.store === false && seen[0].b.max_output_tokens === 64, "upstream call hits OpenRouter /responses with store:false and the cap");
ok(seen[0].b.provider?.max_price && seen[0].b.provider?.require_parameters === true && seen[0].b.session_id === seen[0].b.user && seen[0].b.cache_control?.type === "ephemeral", "server-owned max_price + require_parameters (json_schema) + session_id + cache_control ride");
ok(out.output[0].content[0].text === "Hello there." && !("cost" in out.usage) && !("is_byok" in out.usage), "Responses body passes through with billing fields stripped");
{
  const { _testEventsForTest } = await import("../src/posthog.js");
  const ev = _testEventsForTest().filter((e) => e.event === "gateway_usage").pop();
  ok(ev?.properties.tier === "v1-chat:responses" && ev?.properties.upstreamUsd === 0.0000021 && ev?.properties.promptTokens === 9, "margin telemetry recorded under <tier>:responses");
}
seen = [];
await bySlug("v1-chat-nano-responses").handler({ model: "openai/gpt-5-nano", input: "hi", max_output_tokens: 64 }, fakeReq);
ok(seen[0].b.reasoning?.effort === "minimal" && seen[0].b.provider?.sort === "price" && seen[0].b.service_tier === "flex", "nano + gpt-5-nano: default reasoning effort minimal, price sort, flex-first");
seen = [];
await bySlug("v1-chat-nano-responses").handler({ model: "openai/gpt-5-nano", input: "hi", max_output_tokens: 64, reasoning: { effort: "high" } }, fakeReq);
ok(seen[0].b.reasoning?.effort === "high", "buyer reasoning preference wins");
// failover + paid-empty on nano (has fallbacks)
seen = [];
globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); seen.push(b.model + (b.service_tier ? ":flex" : "")); return { ok: true, status: 200, text: async () => JSON.stringify(b.model === "openai/gpt-5-nano" ? reply(b.model, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning", summary: [] }] }) : reply(b.model)) }; };
const pe = await bySlug("v1-chat-nano-responses").handler({ model: "openai/gpt-5-nano", input: "hi", max_output_tokens: 64 }, fakeReq);
ok(pe.output[0].content[0].text === "Hello there." && seen.join(",") === "openai/gpt-5-nano:flex,deepseek/deepseek-chat", `incomplete-with-nothing-said is never served: chain walked on, same-model default retry skipped (${seen.join(" -> ")})`);
globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); return { ok: true, status: 200, text: async () => JSON.stringify(reply(b.model, { status: "failed", error: { code: "server_error", message: "boom" } })) }; };
await baseTool.handler({ model: "openai/gpt-4o-mini", input: "hi" }, fakeReq).then(() => ok(false, "failed status must not serve"), (e) => ok(e.statusCode === 502 && /boom/.test(e.message), "status failed -> 502 with the upstream message"));
// stream: nested response.usage scrubbed end to end
{
  const frames = [];
  const completed = 'data: {"type":"response.completed","response":{"id":"r","model":"openai/gpt-4o-mini","status":"completed","output":[],"usage":{"input_tokens":6,"output_tokens":3,"cost":0.0000018,"is_byok":false,"cost_details":{"upstream_inference_cost":0.0000018}}},"sequence_number":11}\n\n';
  globalThis.fetch = async () => ({ ok: true, status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from('data: {"type":"response.created","response":{"id":"r","usage":null},"sequence_number":0}\n\n'); yield Buffer.from('data: {"type":"response.output_text.delta","delta":"Hello","sequence_number":4}\n\n'); yield Buffer.from(completed); } } });
  const res = { headersSent: false, writeHead() { this.headersSent = true; }, flushHeaders() {}, write(c) { frames.push(String(c)); }, end() { this.ended = true; }, on() {} };
  const h = await baseTool.handler({ model: "openai/gpt-4o-mini", input: "hi", stream: true }, fakeReq);
  await h.__sse(res);
  const all = frames.join("");
  ok(res.ended && /response.created/.test(all) && /output_text.delta/.test(all) && /response.completed/.test(all) && /"input_tokens":6/.test(all) && !/cost|is_byok/.test(all), "streamed Responses events pass through end to end; nested response.usage billing scrubbed");
}
// ---- metered Responses route: quote from the body, belt, provider bound, meter sentinel ----
{
  const { meteredResponsesQuoteUsd } = await import("../src/tools/llm-responses-kit.js");
  const { costFor, meteredQuoteForProbe } = await import("../src/tools/llm-gateway-kit.js");
  const metered = bySlug("v1-chat-metered-responses");
  ok(!!metered && metered.route === "POST /v1/metered/responses" && metered.price === "$0.001" && typeof metered.quote === "function" && LLM_RESPONSES_TOOLS.filter((t) => typeof t.quote === "function").length === 1, "only the metered Responses route carries a per-request quote() and the floor price");
  ok(Object.keys(RESPONSES_PATH_BY_TIER).at(-1) === "v1-chat-metered", "the metered tier is LAST in the path map (tierFor keeps home tiers first)");
  const small = { model: "anthropic/claude-haiku-4.5", max_output_tokens: 16, input: "hi" };
  const bigger = { model: "anthropic/claude-opus-5", max_output_tokens: 4096, instructions: "x ".repeat(20_000), input: "y ".repeat(5_000) };
  const qs = meteredResponsesQuoteUsd(small), qb = meteredResponsesQuoteUsd(bigger);
  ok(!qs.invalid && !qb.invalid && qs.usd >= TIERS["v1-chat-metered"].price && qb.usd > qs.usd * 10, `quote grows with the body: small $${qs.usd}, bigger $${qb.usd}`);
  ok(metered.quote(small) === qs.usd && metered.quote(bigger) === qb.usd, "the tool's quote() is the same function payments.js prices the 402 from");
  const qi = meteredResponsesQuoteUsd({ max_output_tokens: 16 });
  ok(qi.invalid && qi.usd === TIERS["v1-chat-metered"].price, "an invalid body quotes the floor and says why (the handler's 400 refuses it)");
  seen = [];
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); seen.push({ url: String(url), b }); return { ok: true, status: 200, text: async () => JSON.stringify(reply(b.model)) }; };
  const mo = await metered.handler(small, { ...fakeReq, __meteredQuoteUsd: qs.usd });
  const row = costFor(small.model);
  ok(seen[0].url.endsWith("/api/v1/responses") && seen[0].b.provider?.max_price?.prompt === row.prompt && seen[0].b.provider?.max_price?.completion === row.completion && seen[0].b.store === false, "metered: provider.max_price is the quoted model's own cost row, not the tier-wide cap; store stays false");
  ok(mo.__meterUpstreamUsd === 0.0000021 && mo.output[0].content[0].text === "Hello there." && !("cost" in mo.usage), "metered: the meter sentinel carries the upstream cost to the route binder; billing fields stripped");
  ok(!JSON.stringify(mo).includes("__meterUpstreamUsd") && !Object.keys(mo).includes("__meterUpstreamUsd"), "metered: the sentinel is non-enumerable");
  {
    const { _testEventsForTest } = await import("../src/posthog.js");
    const ev = _testEventsForTest().filter((e) => e.event === "gateway_usage").pop();
    ok(ev?.properties.tier === "v1-chat-metered:responses" && ev?.properties.priceUsd === qs.usd, "metered: gateway_usage.priceUsd is the quote, not the floor");
  }
  let belt = null;
  try { await metered.handler(bigger, { ...fakeReq, __meteredQuoteUsd: qs.usd }); } catch (e) { belt = e; }
  ok(belt?.statusCode === 400 && /quoted at/.test(belt.message) && seen.length === 1, "metered belt: a body quoting above the gated price is refused 400 before any upstream call");
  // gpt-5-pro ($15/$120): the -fast Claude ids left the catalog 2026-07-24, and a
  // model that fell back to a cheaper family row would quote UNDER the cap here.
  const overCap = { model: "openai/gpt-5-pro", max_output_tokens: 8192, input: "\u4e2d".repeat(190_000) };
  const qo = meteredResponsesQuoteUsd(overCap);
  ok(qo.overCap === true && qo.usd === TIERS["v1-chat-metered"].maxQuoteUsd, `an over-cap body quotes the cap ($${qo.usd}) and is flagged overCap`);
  for (const [label, r] of [["with the gate's stashed quote", { ...fakeReq, __meteredQuoteUsd: qo.usd }], ["with no request (in-process caller)", undefined]]) {
    let err = null;
    try { await metered.handler(overCap, r); } catch (e) { err = e; }
    ok(err?.statusCode === 400 && /per-call cap/.test(err.message) && seen.length === 1, `over the cap ${label}: refused 400 before any upstream call`);
  }
  const { meteredQuoteForProbe: mq } = { meteredQuoteForProbe };
  ok(typeof mq === "function", "probe-level quoter shared with the chat and Messages wires");
}
{
  seen = [];
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); seen.push({ url: String(url), b }); return { ok: true, status: 200, text: async () => JSON.stringify(reply(b.model)) }; };
  const out = await bySlug("v1-chat-responses").handler({ input: "hi", max_output_tokens: 16 }, fakeReq);
  const { _testEventsForTest } = await import("../src/posthog.js");
  const ev = _testEventsForTest().filter((e) => e.event === "gateway_usage").pop();
  ok(seen[0].b.model === "openai/gpt-4o-mini" && out.agent402_default_model === "openai/gpt-4o-mini" && ev?.properties.defaulted === true, "a defaulted call serves the tier default, says so in the reply, and gateway_usage records defaulted:true");
  // A retiring id is served by its successor and the reply names the swap.
  {
    const { RETIRING_MODELS, tierFor: tf } = await import("../src/tools/llm-gateway-kit.js");
    const [id, { use }] = Object.entries(RETIRING_MODELS)[0];
    seen = [];
    const out2 = await bySlug(`${tf(use)}-responses`).handler({ model: id, input: "hi", max_output_tokens: 16 }, fakeReq);
    ok(seen[0].b.model === use && out2.agent402_model_substituted?.requested === id && out2.agent402_model_substituted?.served === use,
      `a retiring id (${id}) is served as ${use} and the reply names the swap`);
  }
  globalThis.fetch = realFetch;
}
globalThis.fetch = realFetch;
delete process.env.OPENROUTER_API_KEY;

// ---- a missing model is served as the tier default (2026-08-28) ----
{
  const v = validateResponsesRequest({ input: "hi", max_output_tokens: 16 }, "v1-chat");
  ok(v.body.model === "openai/gpt-4o-mini" && v.defaultedModel === "openai/gpt-4o-mini", "no model on v1-chat -> the tier default, marked defaultedModel");
  const e = validateResponsesRequest({ model: "openai/gpt-4o-mini", ...{ input: "hi", max_output_tokens: 16 } }, "v1-chat");
  ok(e.defaultedModel === null, "an explicit model is not marked as defaulted");
}

// ---- priority service tier on the Responses wire (2026-09-18) ----
// service_tier "priority" / "fast" on pro/premium: normalized, carried on the
// clamp probe (priced at PRIORITY_PRICE_FACTOR), sent upstream as ONE service_tier with no flex
// attempt; refused with the routes named on the other tiers; "flex" refused.
{
  const vp = validateResponsesRequest({ model: "openai/gpt-4o", input: "hi", max_output_tokens: 64, service_tier: "fast" }, "v1-chat-pro");
  ok(vp.body.service_tier === "priority" && vp.probe.service_tier === "priority", 'pro: service_tier "fast" normalizes to "priority" on the body and on the clamp probe');
  let e = null; try { validateResponsesRequest({ model: "openai/gpt-5.6-luna", input: "hi", service_tier: "priority" }, nanoT); } catch (x) { e = x; }
  ok(e?.statusCode === 400 && /priority service tier is not offered on/.test(e.message) && /\/v1\/premium\/chat\/completions/.test(e.message), "nano: priority refused 400 naming the routes that price it");
  let f = null; try { validateResponsesRequest({ model: "openai/gpt-4o", input: "hi", service_tier: "flex" }, "v1-chat-pro"); } catch (x) { f = x; }
  ok(f?.statusCode === 400 && /not a buyer knob/.test(f.message), '"flex" is refused: the gateway applies it itself');
  const sent = [];
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); sent.push(b); return { ok: true, status: 200, text: async () => JSON.stringify(reply(b.model, { service_tier: "priority" })) }; };
  process.env.OPENROUTER_API_KEY = "test-key";
  const outP = await bySlug("v1-chat-pro-responses").handler({ model: "google/gemini-3.6-flash", input: "hi", max_output_tokens: 64, service_tier: "priority" }, fakeReq);
  ok(sent.length === 1 && sent[0].service_tier === "priority" && outP.service_tier === "priority", "pro responses: one upstream call carrying service_tier priority (no flex attempt on a flex-eligible model); the served tier reported back");
  delete process.env.OPENROUTER_API_KEY;
}

// ---- price by model on the Responses wire (2026-09-22) ---------------------
// Same rule as the chat wire: a flat route's 402 quotes the model's home tier
// price, and only a request gated at that price is served under that tier.
{
  const { TIERS: T } = await import("../src/tools/llm-gateway-kit.js");
  const baseR = bySlug("v1-chat-responses"), nanoR = bySlug("v1-chat-nano-responses");
  const OPUS = "anthropic/claude-opus-5";
  ok(typeof baseR.tierQuote === "function" && typeof baseR.quote !== "function" && typeof bySlug("v1-chat-auto-responses").tierQuote !== "function" && typeof bySlug("v1-chat-metered-responses").tierQuote !== "function", "flat Responses routes carry tierQuote (never quote); auto and metered do not");
  ok(baseR.tierQuote({ model: OPUS, input: "hi" }) === T["v1-chat-premium"].price && baseR.tierQuote({ model: "openai/gpt-4o-mini", input: "hi" }) === T["v1-chat"].price, "base Responses route: premium model quotes premium, base model keeps base");
  ok(nanoR.tierQuote({ model: OPUS, input: "hi" }) === T["v1-chat-premium"].price && baseR.tierQuote({ model: "not-a-real/model", input: "hi" }) === T["v1-chat"].price, "nano route + premium model quotes premium; an unknown model quotes the route price");
  ok(baseR.price === "$0.02", "the base Responses route's catalog price is unchanged");
  process.env.OPENROUTER_API_KEY = "test-key";
  const pbmReal = globalThis.fetch;
  let pbmSeen = [];
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); pbmSeen.push(b); return { ok: true, status: 200, text: async () => JSON.stringify(reply(b.model)) }; };
  const reqAt = (usd) => ({ header: () => undefined, headers: {}, ip: "127.0.0.1", ...(usd == null ? {} : { __meteredQuoteUsd: usd }) });
  try {
    pbmSeen = [];
    const out = await baseR.handler({ model: OPUS, input: "hi", max_output_tokens: 6000 }, reqAt(0.5)).catch((e) => ({ threw: `${e?.statusCode} ${e?.message}` }));
    ok(JSON.stringify(pbmSeen[0]?.provider?.max_price) === JSON.stringify(T["v1-chat-premium"].maxPrice) && pbmSeen[0]?.max_output_tokens === 6000 && 6000 > T["v1-chat"].maxTokens && pbmSeen[0]?.reasoning === undefined, `served under premium's config (max_price ${JSON.stringify(pbmSeen[0]?.provider?.max_price)}, max_output_tokens ${pbmSeen[0]?.max_output_tokens}, no base reasoning default)`);
    ok(out.agent402_tier?.served === "v1-chat-premium" && out.agent402_tier?.route === "/v1/responses" && out.agent402_tier?.priceUsd === 0.5, `the answer names the served tier on this wire (${JSON.stringify(out.agent402_tier)})`);
    const { _testEventsForTest } = await import("../src/posthog.js");
    const ev = _testEventsForTest().filter((e) => e.event === "gateway_usage").pop();
    ok(ev?.properties.tier === "v1-chat-premium:responses" && ev?.properties.routeTier === "v1-chat:responses" && ev?.properties.priceUsd === 0.5, "telemetry records the served tier and the route");
    for (const [label, r] of [["gated at the base price", reqAt(0.02)], ["no request (route-execute)", undefined]]) {
      pbmSeen = [];
      let e = null; try { await baseR.handler({ model: OPUS, input: "hi" }, r); } catch (x) { e = x; }
      ok(e?.statusCode === 400 && /\/v1\/premium\/responses/.test(e.message) && pbmSeen.length === 0, `${label}: the 400 naming the premium Responses path, nothing sent upstream`);
    }
    pbmSeen = [];
    const same = await baseR.handler({ model: "openai/gpt-4o-mini", input: "hi" }, reqAt(0.02)).catch((e) => ({ threw: `${e?.statusCode} ${e?.message}` }));
    ok(JSON.stringify(pbmSeen[0]?.provider?.max_price) === JSON.stringify(T["v1-chat"].maxPrice) && same.agent402_tier === undefined, "a same-tier model keeps the base config and carries no agent402_tier");
    // model "auto" (2026-09-29): quoted and served as the auto tier on this wire
    ok(baseR.tierQuote({ model: "auto", input: "hi" }) === T["v1-chat-auto"].price && nanoR.tierQuote({ model: "auto", input: "hi" }) === T["v1-chat-auto"].price, "model \"auto\" quotes the auto price on flat Responses routes");
    pbmSeen = [];
    const au = await bySlug("v1-chat-pro-responses").handler({ model: "auto", input: "hi", max_output_tokens: 3000 }, reqAt(T["v1-chat-auto"].price));
    ok(pbmSeen[0]?.max_output_tokens <= T["v1-chat-auto"].maxTokens && au.agent402_router?.quality === "balanced" && au.agent402_tier?.served === "v1-chat-auto" && au.agent402_tier?.route === "/v1/pro/responses", `auto body served under auto caps with agent402_router (${pbmSeen[0]?.model}, max_output_tokens ${pbmSeen[0]?.max_output_tokens})`);
    pbmSeen = [];
    let ae = null; try { await baseR.handler({ model: "auto", input: "hi" }, undefined); } catch (x) { ae = x; }
    ok(ae?.statusCode === 400 && /\/v1\/auto\/responses/.test(ae.message) && pbmSeen.length === 0, "not gated at the auto price: 400 naming /v1/auto/responses, nothing sent upstream");
  } finally { globalThis.fetch = pbmReal; }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
