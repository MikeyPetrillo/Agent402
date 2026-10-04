// OpenRouter SERVER TOOLS on the x402 LLM gateway - the bound, not the feature.
//
// Every `tools` entry whose type was not "function" used to be refused,
// because server-tool spend was bounded by neither max_tokens nor
// provider.max_price. OpenRouter has since shipped a per-request loop budget
// (`stop_server_tools_when`, verified against their live OpenAPI document
// 2026-08-22). These assertions pin the parts that keep the flat price honest:
//
//   1. an allowlisted server tool is rewritten with OUR limits pinned on it
//   2. a buyer can never widen those limits, on the tool or on the request
//   3. anything we cannot bound still 400s, with guidance
//   4. the margin arithmetic prices the whole loop, not one turn
//   5. the loop budget is on the outbound body, and billing fields still leave
//
// Offline: no network, stubbed fetch.  node scripts/test-server-tools.js
process.env.POSTHOG_TEST_CAPTURE = "1";

const {
  TIERS, MARGIN, validateRequest, worstCaseUpstreamCost, serverToolWorstCase, serverToolsIn,
  stopServerToolsFor, SERVER_TOOL_POLICY, modelsList, promptCacheKey, LLM_GATEWAY_TOOLS,
} = await import("../src/tools/llm-gateway-kit.js");
const { requireUpstreamCosts } = await import("./lib/require-upstream-costs.js");
requireUpstreamCosts("test-server-tools");
const { _testEventsForTest } = await import("../src/posthog.js");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const throws = (fn, substr, msg) => {
  try { fn(); ok(false, `${msg} (did not throw)`); }
  catch (e) { ok(String(e.message).includes(substr), `${msg} (got: ${String(e.message).slice(0, 110)})`); }
};
const usd = (n) => `$${n.toFixed(4)}`;
const msg = (words = 5) => [{ role: "user", content: "the quick brown fox ".repeat(words) }];
const WS = { type: "openrouter:web_search" };
const WF = { type: "openrouter:web_fetch" };
const DT = { type: "openrouter:datetime" };
const FN = { type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: {} } } };

// Tiers that sell server tools, and the ones that must not.
const SELLING = Object.entries(TIERS).filter(([, t]) => t.serverTools);
const NOT_SELLING = Object.entries(TIERS).filter(([, t]) => !t.serverTools);
const REP = { "v1-chat-pro": "openai/gpt-4o", "v1-chat-premium": "openai/gpt-5" };

console.log("\n# 1. the server-owned limits are PINNED onto every allowlisted entry");
ok(SELLING.length > 0, `at least one tier sells server tools (${SELLING.map(([s]) => s).join(", ")})`);
for (const [slug, tier] of SELLING) {
  const v = validateRequest({ model: REP[slug], messages: msg(), tools: [WS, WF, DT] }, slug);
  const search = v.tools.find((t) => t.type === "openrouter:web_search");
  const fetchT = v.tools.find((t) => t.type === "openrouter:web_fetch");
  const lim = tier.serverTools.tools["openrouter:web_search"];
  // engine is the dollar decision: "auto" falls back to NATIVE provider search,
  // which is priced by the provider and forwards max_uses only to Anthropic.
  ok(search.parameters.engine === "exa", `${slug} web_search engine pinned to exa (never auto/native)`);
  ok(search.parameters.mode === "auto", `${slug} web_search mode pinned to auto ($0.007; deep-reasoning is $0.015)`);
  ok(search.parameters.max_uses === lim.max_uses, `${slug} web_search max_uses pinned to ${lim.max_uses}`);
  ok(search.parameters.max_characters === lim.max_characters, `${slug} web_search max_characters pinned (the token bound)`);
  ok(search.parameters.max_total_results === lim.max_uses * lim.max_results, `${slug} web_search max_total_results derived, not buyer-set`);
  // web_fetch: only the "openrouter" engine is priced Free; exa/parallel bill.
  ok(fetchT.parameters.engine === "openrouter", `${slug} web_fetch engine pinned to openrouter (the free one)`);
  ok(typeof fetchT.parameters.max_content_tokens === "number", `${slug} web_fetch max_content_tokens pinned`);
  ok(v.tools.filter((t) => t.type === "openrouter:datetime").length === 1, `${slug} datetime survives validation`);
}

// Function tools are untouched - the old behaviour must not have moved.
{
  const v = validateRequest({ model: "openai/gpt-4o", messages: msg(), tools: [FN] }, "v1-chat-pro");
  ok(v.tools.length === 1 && v.tools[0] === FN, "a function tool passes through by identity (no rewrite)");
  const mixed = validateRequest({ model: "openai/gpt-4o", messages: msg(), tools: [FN, WS] }, "v1-chat-pro");
  ok(mixed.tools[0] === FN && mixed.tools[1].parameters.engine === "exa", "function and server tools coexist in one request");
}

console.log("\n# 2. a buyer cannot widen the cap - on the tool or on the request");
for (const [slug] of SELLING) {
  const model = REP[slug];
  const lim = TIERS[slug].serverTools.tools["openrouter:web_search"];
  // The pinned object REPLACES the buyer's, so even an accepted key cannot win.
  throws(() => validateRequest({ model, messages: msg(), tools: [{ ...WS, parameters: { max_uses: 50 } }] }, slug),
    "not accepted on server tool", `${slug} buyer max_uses:50 refused by name`);
  throws(() => validateRequest({ model, messages: msg(), tools: [{ ...WS, parameters: { engine: "native" } }] }, slug),
    "not accepted on server tool", `${slug} buyer engine:"native" refused (it changes the price)`);
  throws(() => validateRequest({ model, messages: msg(), tools: [{ ...WS, parameters: { mode: "deep-reasoning" } }] }, slug),
    "not accepted on server tool", `${slug} buyer mode:"deep-reasoning" refused ($0.015 vs $0.007)`);
  throws(() => validateRequest({ model, messages: msg(), tools: [{ ...WS, parameters: { max_results: 25, max_characters: 100000 } }] }, slug),
    "not accepted on server tool", `${slug} buyer result/character widening refused`);
  throws(() => validateRequest({ model, messages: msg(), tools: [{ ...WF, parameters: { max_content_tokens: 100000 } }] }, slug),
    "not accepted on server tool", `${slug} buyer web_fetch max_content_tokens refused`);
  // The request-level loop budget is server-owned exactly like max_price.
  // Silently dropping it would leave the caller believing they set a budget.
  throws(() => validateRequest({ model, messages: msg(), tools: [WS], stop_server_tools_when: [{ type: "max_cost", max_cost_in_dollars: 500 }] }, slug),
    "set by the gateway", `${slug} buyer stop_server_tools_when refused, not ignored`);
  throws(() => validateRequest({ model, messages: msg(), tools: [WS], max_tool_calls: 30 }, slug),
    "set by the gateway", `${slug} buyer max_tool_calls refused, not ignored`);
  // Cost-neutral narrowing is allowed and survives alongside the pins.
  const narrowed = validateRequest({ model, messages: msg(), tools: [{ ...WS, parameters: { allowed_domains: ["arxiv.org"] } }] }, slug);
  const p = narrowed.tools[0].parameters;
  ok(p.allowed_domains[0] === "arxiv.org" && p.engine === "exa" && p.max_uses === lim.max_uses,
    `${slug} domain narrowing kept, pins still win`);
  throws(() => validateRequest({ model, messages: msg(), tools: [{ ...WS, parameters: { allowed_domains: "arxiv.org" } }] }, slug),
    "array of at most 20 domain strings", `${slug} malformed domain filter refused`);
}

console.log("\n# 3. anything we cannot bound still 400s, by name and with guidance");
const UNBOUNDED = [
  ["openrouter:subagent", "another model of your choosing"],
  ["openrouter:advisor", "another model of your choosing"],
  ["openrouter:fusion", "panel of models"],
  ["openrouter:image_generation", "/v1/images/generations"],
  ["openrouter:shell", "no per-call price"],
  ["openrouter:bash", "no per-call price"],
  ["openrouter:apply_patch", "hosted workspace"],
  ["openrouter:files", "workspace, which is ours"],
  ["openrouter:tool_search", "no per-call price"],
  ["openrouter:experimental__search_models", "no per-call price"],
  ["mcp", "unbounded outbound call from our account"],
  ["code_interpreter", "no per-call price"],
  ["computer_use_preview", "no per-call price"],
  ["file_search", "vector stores on our account"],
  // OpenRouter converts the OpenAI-syntax shorthand into openrouter:web_search
  // upstream, which would hand the ENGINE choice back to the caller.
  ["web_search", 'use {type:"openrouter:web_search"} instead'],
  ["web_search_preview", 'use {type:"openrouter:web_search"} instead'],
];
for (const [type, why] of UNBOUNDED) {
  throws(() => validateRequest({ model: "openai/gpt-5", messages: msg(), tools: [{ type }] }, "v1-chat-premium"),
    why, `"${type}" refused on the tier that DOES sell server tools`);
}
throws(() => validateRequest({ model: "openai/gpt-5", messages: msg(), tools: [{ type: "openrouter:not_a_real_tool" }] }, "v1-chat-premium"),
  "Unsupported tools entry", "an unknown openrouter:* type still falls through to the generic refusal");
throws(() => validateRequest({ model: "openai/gpt-4o", messages: msg(), tools: [{ type: "function" }] }, "v1-chat-pro"),
  "function:{name", "a function tool with no function object still 400s");
// Every allowlisted tool must be enumerated in SERVER_TOOL_POLICY and nowhere
// else: a tier config naming a tool with no policy would have no price at all.
for (const [slug, tier] of SELLING) {
  for (const type of Object.keys(tier.serverTools.tools)) {
    ok(Object.hasOwn(SERVER_TOOL_POLICY, type), `${slug} allows only tools that have a priced policy (${type})`);
  }
}

console.log("\n# 4. tiers that cannot afford a loop refuse it, and say where it lives");
for (const [slug, tier] of NOT_SELLING) {
  if (!tier.prefixes || !tier.maxInputChars) continue; // non-chat tiers have no tools array
  const model = tier.lockedModel || (tier.prefixes[0].endsWith("/") ? `${tier.prefixes[0]}x` : tier.prefixes[0]);
  const body = { model, messages: msg(), tools: [WS] };
  if (tier.router) delete body.model;
  throws(() => validateRequest(body, slug), "/v1/pro/chat/completions",
    `${slug} refuses web_search and names a route that sells it`);
}
// The economics behind that refusal, stated as an assertion: one Exa search is
// $0.007, so the budget tiers cannot carry even a single step.
const searchFee = SERVER_TOOL_POLICY["openrouter:web_search"].feeUsdPerUse;
ok(searchFee === 0.007, "web_search is priced at the verified Exa auto rate ($0.007/request)");
for (const [slug, tier] of NOT_SELLING) {
  if (tier.price === undefined || tier.price >= 0.1) continue;
  ok(searchFee * 2 > tier.price * MARGIN || tier.price * MARGIN - searchFee < 0.02,
    `${slug} ($${tier.price}) has no room for a search loop under the ${MARGIN * 100}% bound`);
}

console.log("\n# 5. margin arithmetic prices the LOOP, not one turn");
for (const [slug, tier] of SELLING) {
  const model = REP[slug];
  const plain = validateRequest({ model, messages: msg(), max_tokens: 99999 }, slug);
  const loop = validateRequest({ model, messages: msg(), max_tokens: 99999, tools: [WS, WF, DT] }, slug);
  const wcPlain = worstCaseUpstreamCost(plain, tier, 0);
  const wcLoop = worstCaseUpstreamCost(loop, tier, 0);
  const st = serverToolWorstCase(loop, tier);
  ok(wcPlain.serverTools.turns === 1 && wcPlain.fixedUsd === (tier.fixedUpstreamUsd || 0),
    `${slug} a request with NO server tools is arithmetically unchanged (turns 1, no fee)`);
  ok(st.turns === tier.serverTools.maxSteps + 1,
    `${slug} loop is priced at maxSteps+1 model turns (${st.turns}) - the documented "one final turn" after a stop condition`);
  ok(wcLoop.fixedUsd >= tier.serverTools.tools["openrouter:web_search"].max_uses * searchFee,
    `${slug} the per-use execution fee is inside fixedUsd (${usd(wcLoop.fixedUsd)})`);
  ok(st.injectedTokens > 0 && wcLoop.inTokens > wcPlain.inTokens,
    `${slug} tool results are priced as input tokens on every turn (${wcPlain.inTokens} -> ${wcLoop.inTokens})`);
  // THE invariant: worst case including server-tool spend is inside the price.
  ok(wcLoop.totalUsd < tier.price, `${slug} loop worst-case ${usd(wcLoop.totalUsd)} < price $${tier.price}`);
  ok(wcLoop.totalUsd <= tier.price * MARGIN + 1e-9, `${slug} loop worst-case ${usd(wcLoop.totalUsd)} <= ${MARGIN * 100}% bound ${usd(tier.price * MARGIN)}`);
  ok(loop.max_tokens <= plain.max_tokens, `${slug} a loop never RAISES the output cap (${plain.max_tokens} -> ${loop.max_tokens})`);

  // Exhaustive over the tier's own models: never over the price, and a model
  // too pricey to afford a loop is refused PRE-spend rather than served short.
  // The clamp must also actually bite somewhere on the tier - a cheap model
  // can afford the full cap even inside a loop, but a pricey one cannot, and
  // "never shrinks anywhere" would mean the loop is not being priced at all.
  let served = 0, refused = 0, shrank = 0;
  for (const prefix of tier.prefixes) {
    const m = prefix.endsWith("/") ? `${prefix}family-representative` : prefix;
    for (const words of [5, 200, 1500]) {
      const req = { model: m, messages: msg(words), max_tokens: 99999 };
      let v;
      try { v = validateRequest({ ...req, tools: [WS, WF, DT] }, slug); }
      catch (e) { if (e.statusCode !== 400) throw e; refused++; continue; }
      const wc = worstCaseUpstreamCost(v, tier, 0);
      if (wc.totalUsd >= tier.price) { ok(false, `${slug} ${m} loop worst-case ${usd(wc.totalUsd)} >= price $${tier.price}`); continue; }
      if (v.max_tokens < validateRequest(req, slug).max_tokens) shrank++;
      served++;
    }
  }
  ok(served > 0, `${slug} still serves a real loop request (${served} accepted, ${refused} refused pre-spend)`);
  ok(shrank > 0, `${slug} the clamp shrinks the output cap on ${shrank} loop bodies (the loop is priced, not waved through)`);
  console.log(`   # ${slug}: ${served} loop bodies accepted, ${refused} refused pre-spend, all under $${tier.price}`);
}
// A loop request that no longer fits is refused with guidance, never served at
// a loss: premium's priciest model plus a full loop is over budget by design.
throws(() => validateRequest({ model: "anthropic/claude-fable-5.1", messages: msg(400), max_tokens: 4096, tools: [WS, WF, DT] }, "v1-chat-premium"),
  'drop the "tools" server-tool entries', "an unaffordable loop is refused pre-spend and names the fix");

console.log("\n# 6. the loop budget rides on the OUTBOUND body, and only there");
{
  const tier = TIERS["v1-chat-premium"];
  const v = validateRequest({ model: "openai/gpt-5", messages: msg(), tools: [WS] }, "v1-chat-premium");
  const stop = stopServerToolsFor(v, tier);
  // Shapes verified against OpenRouter's live OpenAPI 2026-08-22:
  // StopServerToolsWhenStepCountIs {type:"step_count_is", step_count} and
  // StopServerToolsWhenMaxCost {type:"max_cost", max_cost_in_dollars}.
  ok(Array.isArray(stop) && stop.length === 2, "stop_server_tools_when is a 2-condition array");
  ok(stop[0].type === "step_count_is" && stop[0].step_count === tier.serverTools.maxSteps, "step_count_is carries the tier's step budget");
  ok(stop[1].type === "max_cost" && stop[1].max_cost_in_dollars === +(tier.price * MARGIN).toFixed(6),
    `max_cost_in_dollars is the tier's own margin budget ($${(tier.price * MARGIN).toFixed(2)}), server-derived`);
  ok(stopServerToolsFor(validateRequest({ model: "openai/gpt-5", messages: msg() }, "v1-chat-premium"), tier) === null,
    "a request with no server tools carries NO stop_server_tools_when (byte-identical to before)");
  // The normalized body (= the cache key) must not carry it: it is call-time,
  // like provider.max_price, and it is deterministic given the tier anyway.
  ok(!("stop_server_tools_when" in v) && !("max_tool_calls" in v), "the loop budget is not in the normalized body");
}

// Live-server-tool answers are never replayed from the prompt cache: they are
// built from a search or a fetch, and the web moves (same rule as the grounded tier).
{
  const base = { model: "openai/gpt-5", messages: msg(), cache: true };
  ok(typeof promptCacheKey("v1-chat-premium", base) === "string", "a plain premium request is still cacheable");
  ok(promptCacheKey("v1-chat-premium", { ...base, tools: [WS] }) === null, "a server-tool request is never cached");
  ok(typeof promptCacheKey("v1-chat-premium", { ...base, tools: [FN] }) === "string", "a function-tool request is still cacheable");
}

console.log("\n# 7. end to end against a stubbed upstream");
{
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const outbound = [];
  const upstream = {
    id: "gen-st", object: "chat.completion", model: "openai/gpt-5",
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 900, completion_tokens: 40, total_tokens: 940,
      cost: 0.031, cost_details: { upstream_inference_prompt_cost: 0.02 }, is_byok: false, cache_discount: 0.001,
      server_tool_use_details: { tool_calls_executed: 2, tool_calls_requested: 2, web_search_requests: 2 },
    },
  };
  globalThis.fetch = async (url, init) => {
    outbound.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify(upstream) };
  };
  const tool = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-premium");
  const res = await tool.handler({ model: "openai/gpt-5", messages: msg(), max_tokens: 256, tools: [WS, DT] });
  const sent = outbound[0];
  ok(sent.stop_server_tools_when?.[0]?.type === "step_count_is", "outbound carries stop_server_tools_when");
  ok(sent.stop_server_tools_when?.[1]?.max_cost_in_dollars === 0.35, "outbound max_cost is the server-derived $0.35");
  ok(sent.tools.find((t) => t.type === "openrouter:web_search").parameters.engine === "exa", "outbound web_search still pinned to exa");
  ok(sent.provider?.max_price !== undefined, "provider.max_price still rides alongside the loop budget");
  // Billing fields must still never reach the buyer, loop or no loop.
  ok(!("cost" in res.usage) && !("cost_details" in res.usage) && !("is_byok" in res.usage) && !("cache_discount" in res.usage),
    "billing fields stripped from a server-tool response");
  ok(res.usage.server_tool_use_details?.tool_calls_executed === 2, "server_tool_use_details survives (a count, not a bill)");
  await new Promise((r) => setTimeout(r, 30)); // telemetry is a lazy dynamic import
  const ev = _testEventsForTest().filter((e) => e.event === "gateway_usage").pop();
  ok(!!ev, "gateway_usage captured for a server-tool call");
  ok(ev?.properties?.upstreamUsd === 0.031, "margin telemetry keeps the exact upstream cost (usage.cost is the total charged to our account)");
  ok(ev?.properties?.serverToolCalls === 2 && ev?.properties?.serverToolSearches === 2,
    "margin telemetry records server-tool execution counts so a margin review can see them");
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
}

console.log("\n# 8. the limits are disclosed on the machine surface");
{
  const data = modelsList().data;
  for (const [slug, tier] of SELLING) {
    const row = data.find((m) => m.x402.tier === slug);
    const st = row?.x402?.serverTools;
    ok(st?.maxSteps === tier.serverTools.maxSteps, `${slug} /v1/models discloses the step budget`);
    ok(st?.tools?.["openrouter:web_search"]?.engine === "exa" && st.tools["openrouter:web_search"].max_uses === tier.serverTools.tools["openrouter:web_search"].max_uses,
      `${slug} /v1/models discloses the pinned per-tool limits`);
  }
  for (const [slug] of NOT_SELLING) {
    const row = data.find((m) => m.x402.tier === slug);
    if (row) ok(row.x402.serverTools === undefined, `${slug} advertises no server tools`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
