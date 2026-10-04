// Unit tests for the Ox Alpha gateway tier (v1-chat-ox, POST /v1/ox/chat/completions).
//
// Everything offline: the OpenRouter upstream is a stubbed global fetch, so no
// key is needed and no request leaves the machine. What is locked here is the
// set of properties that make a FREE, STEALTH, mandatory-reasoning model safe
// to sell at a flat $0.002:
//
//   1. The model is LOCKED to the route (any other model is a self-explaining
//      400 naming the tier that serves it).
//   2. zdr:true is REFUSED, because the model is free precisely BECAUSE the
//      provider retains prompts. Silently dropping the flag would be worse
//      than not offering the tier.
//   3. The prompt-sharing disclosure is present on the catalog description
//      (which is what /api/pricing, /llms.txt and the MCP catalog render) and
//      on GET /v1/models.
//   4. The margin clamp survives a ZERO list price (no NaN, no Infinity, no
//      shrink-to-nothing) AND the worst case AT THE max_price BOUND - the
//      bound that actually protects us if the model is ever repriced - stays
//      under MARGIN x price.
//   5. A mandatory-reasoning model cannot produce a PAID empty answer: a tiny
//      buyer budget is raised to the tier floor, and a response that still
//      comes back "length" with nothing said walks the chain and ends as a
//      502 (which cancels settlement).
//   6. The request that reaches OpenRouter carries the attribution headers,
//      the server-owned provider bound, and reasoning effort "low".
//   7. Upstream billing fields never reach the buyer.
//   8. The vanish gate: when the boot probe finds the id gone, the tier
//      answers 503 (uncharged) and drops off GET /v1/models; an unreadable
//      catalog fails OPEN and changes nothing.
//
//   node scripts/test-ox-tier.js

// Route PostHog captures to the in-memory sink before anything imports it.
process.env.POSTHOG_TEST_CAPTURE = "1";
process.env.OPENROUTER_API_KEY = "test-key";
process.env.OX_ALPHA_ENABLED = "on"; // OFF by default since 2026-09-03; these tests exercise the tier switched on

const {
  TIERS, MARGIN, OX_MODEL, OX_ROUTE, STEALTH_MODEL_IDS,
  validateRequest, clampToMargin, worstCaseUpstreamCost, costFor, tierFor, tierAllows,
  modelsList, LLM_GATEWAY_TOOLS, defaultReasoningFor, isEmptyLength, reasoningProfile,
  oxAlphaAvailable, probeOxAlphaAvailability, _setOxUpstreamMissingForTest,
  oxUpstreamIsFree, oxUpstreamPricing,
} = await import("../src/tools/llm-gateway-kit.js");
const { requireUpstreamCosts } = await import("./lib/require-upstream-costs.js");
requireUpstreamCosts("test-ox-tier");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const throws = (fn, substr, m) => {
  try { fn(); ok(false, `${m} (did not throw)`); }
  catch (e) { ok(String(e.message).includes(substr), `${m} (got: ${String(e.message).slice(0, 110)})`); }
};
const rejects = async (fn, substr, m) => {
  try { await fn(); ok(false, `${m} (did not throw)`); }
  catch (e) { ok(String(e.message).includes(substr), `${m} (got: ${String(e.message).slice(0, 110)})`); }
};
const SLUG = "v1-chat-ox";
const tier = TIERS[SLUG];
const msgs = (content = "hi") => [{ role: "user", content }];
const tool = LLM_GATEWAY_TOOLS.find((t) => t.slug === SLUG);

// ---------------------------------------------------------------------------
console.log("\n# 1. tier shape + locked model");
ok(!!tier, `${SLUG} exists in TIERS`);
ok(tier.route === `POST ${OX_ROUTE}` && OX_ROUTE === "/v1/ox/chat/completions", `route is POST ${OX_ROUTE}`);
ok(tier.price === 0.002, "price is $0.002");
ok(tier.lockedModel === OX_MODEL && OX_MODEL === "stealth/ox-alpha", "model locked to stealth/ox-alpha");
ok(tool && tool.price === "$0.002" && tool.route === `POST ${OX_ROUTE}`, "catalog entry matches the tier route/price");
ok(tierFor(OX_MODEL) === SLUG, "tierFor routes stealth/ox-alpha to the ox tier");
ok(tierAllows(SLUG, OX_MODEL) && !tierAllows(SLUG, "openai/gpt-4o-mini"), "allowlist is exactly the locked model");
ok(STEALTH_MODEL_IDS.includes(OX_MODEL), "the id is declared as a stealth listing (CI-guard tolerance)");

// Omitting the model is the normal path (the route IS the model).
{
  const v = validateRequest({ messages: msgs() }, SLUG);
  ok(v.model === OX_MODEL, "model may be omitted - the route resolves it");
}
// Sending it explicitly is fine.
ok(validateRequest({ model: OX_MODEL, messages: msgs() }, SLUG).model === OX_MODEL, "explicit locked model accepted");
// Anything else is a self-explaining 400 that names the real home.
throws(() => validateRequest({ model: "gpt-4o-mini", messages: msgs() }, SLUG), "locked to this route", "a different model is refused");
throws(() => validateRequest({ model: "gpt-4o-mini", messages: msgs() }, SLUG), "/v1/chat/completions", "the refusal names the tier that DOES serve gpt-4o-mini");
throws(() => validateRequest({ model: "gpt-4o-mini", messages: msgs() }, SLUG), "$0.02/call", "the refusal quotes that tier's price");
// A sub-cent tier must not render as "$0.00" in a self-correcting 400.
throws(() => validateRequest({ model: OX_MODEL, messages: msgs() }, "v1-chat"), "$0.002/call", "the ox tier's sub-cent price renders as $0.002, not $0.00");
throws(() => validateRequest({ model: "made-up/model-9000", messages: msgs() }, SLUG), "/v1/models", "an unknown model is refused pointing at /v1/models");
// Cross-tier: asking for ox on another tier points back here.
throws(() => validateRequest({ model: OX_MODEL, messages: msgs() }, "v1-chat"), OX_ROUTE, "another tier redirects stealth/ox-alpha to /v1/ox/chat/completions");

// ---------------------------------------------------------------------------
console.log("\n# 2. zdr is refused (the provider retains prompts)");
throws(() => validateRequest({ messages: msgs(), zdr: true }, SLUG), '"zdr" is not available', "zdr:true is refused");
throws(() => validateRequest({ messages: msgs(), zdr: true }, SLUG), "RETAINING", "the refusal explains WHY (provider retains prompts)");
throws(() => validateRequest({ messages: msgs(), zdr: true }, SLUG), "/v1/nano/chat/completions", "the refusal names tiers that DO honour zdr");
throws(() => validateRequest({ messages: msgs(), provider: { zdr: true } }, SLUG), '"zdr" is not available', "provider.zdr spelling is refused too");
{
  // Never a silent drop: the flag must not reach upstream as "honoured".
  const v = validateRequest({ messages: msgs() }, SLUG);
  ok(v.zdr === undefined, "a request with no zdr carries no zdr flag");
  // The priced tiers still accept it - the refusal is scoped to this tier.
  ok(validateRequest({ model: "openai/gpt-5-nano", messages: msgs(), zdr: true }, "v1-chat-nano").zdr === true, "zdr still works on a priced tier");
}

// ---------------------------------------------------------------------------
console.log("\n# 3. prompt-sharing disclosure on every buyer-facing surface");
{
  const d = tool.description;
  ok(/PROMPTS ARE SHARED WITH THE MODEL PROVIDER/.test(d), "description states plainly that prompts are shared with the provider");
  ok(/RETAINING/.test(d) && /stealth \(cloaked\)/i.test(d), "description names the retention and the stealth listing");
  ok(/zdr:true is refused/.test(d), "description says zdr is refused here");
  ok(/withdrawn by its provider/.test(d), "description warns the model can be withdrawn");
  // /api/pricing renders exactly this description, so the disclosure travels
  // with the catalog row into every scraper and listing portal.
  ok(d.length > 400, "description is the same string /api/pricing serves (non-trivial)");

  const row = modelsList().data.find((m) => m.id === OX_MODEL);
  ok(!!row, "GET /v1/models lists the model");
  ok(row.x402.dataRetention === "provider-retains-prompts", "/v1/models marks dataRetention on the machine surface");
  ok(row.x402.zdr === false, "/v1/models marks zdr:false");
  ok(row.x402.stealth === true, "/v1/models marks the listing stealth");
  ok(row.x402.endpoint === OX_ROUTE && row.x402.priceUsd === 0.002, "/v1/models points at the route and price");
  // No OTHER tier picks up the disclosure keys by accident.
  const others = modelsList().data.filter((m) => m.x402?.tier && m.x402.tier !== SLUG);
  ok(others.every((m) => m.x402.dataRetention === undefined && m.x402.stealth === undefined), "no priced tier is mislabelled as prompt-sharing");
}

// ---------------------------------------------------------------------------
console.log("\n# 4. margin clamp on a ZERO-cost model, and the max_price bound");
ok(costFor(OX_MODEL).prompt === 0 && costFor(OX_MODEL).completion === 0, "MODEL_COST prices the model 0/0 (true today)");
{
  // The clamp must not divide by zero into NaN/Infinity, and must not shrink
  // the output to nothing: on a free model the tier cap is the only bound.
  const body = { model: OX_MODEL, messages: msgs("x".repeat(1000)), max_tokens: tier.maxTokens };
  clampToMargin(body, tier, 0);
  ok(body.max_tokens === tier.maxTokens, `zero-cost model keeps the full output cap (${body.max_tokens})`);
  ok(Number.isFinite(body.max_tokens), "max_tokens stays a finite number (no Infinity/NaN leak)");
  const wc = worstCaseUpstreamCost(body, tier, 0);
  ok(wc.totalUsd === 0, "worst-case upstream at the real (zero) list price is $0");
  // A full-size body still validates end to end.
  const v = validateRequest({ messages: msgs("the quick brown fox. ".repeat(Math.floor(tier.maxInputChars / 21))), max_tokens: 999999 }, SLUG);
  ok(v.max_tokens === tier.maxTokens, "a full-size request clamps to the tier cap, never rejected");
}
{
  // THE bound that actually protects the margin: if the lab unmasks the model
  // and it stops being free, provider.max_price is what refuses the provider.
  // Price the worst realistic body AT that bound and require it under
  // MARGIN x price. (costFor(null-family) falls back to tier.maxPrice, which
  // is exactly the "repriced to the bound" scenario.)
  const DENSE = "龘龖龍龒龜"; // ~1 token/char - the densest realistic input
  const dense = DENSE.repeat(Math.ceil(tier.maxInputChars / DENSE.length)).slice(0, tier.maxInputChars);
  const atBound = { model: "unpriced-family/repriced-ox", messages: msgs(dense), max_tokens: tier.maxTokens, n: 4 };
  const wc = worstCaseUpstreamCost(atBound, tier, 4);
  const budget = tier.price * MARGIN;
  ok(wc.totalUsd < budget, `worst case AT the max_price bound $${wc.totalUsd.toFixed(6)} < margin budget $${budget.toFixed(6)} (${wc.inTokens} input tokens, n=4, ${tier.maxTokens} out)`);
  ok(tier.maxPrice.prompt <= 0.01 && tier.maxPrice.completion <= 0.01, "max_price bound is far below any real model, so a reprice is refused upstream rather than eaten");
}

// ---------------------------------------------------------------------------
console.log("\n# 5. reasoning defaults, output floor, and the empty-length walk");
{
  const prof = reasoningProfile(OX_MODEL);
  ok(!!prof && prof.efforts.join(",") === "low,high,max", "REASONING_MODELS row matches the live supported_efforts (low/high/max)");
  ok(defaultReasoningFor(OX_MODEL, SLUG)?.effort === "low", 'no buyer preference -> effort "low" (the model default is "max", which eats the budget)');
  // Buyer preference still wins and lands in the normalized body (cache key).
  ok(validateRequest({ messages: msgs(), reasoning: { effort: "high" } }, SLUG).reasoning.effort === "high", "buyer reasoning.effort is honoured");
  ok(validateRequest({ messages: msgs(), reasoning_effort: "max" }, SLUG).reasoning.effort === "max", "OpenAI reasoning_effort alias is honoured");
}
{
  // Measured: a 32-token budget returns content:null + finish_reason "length".
  // The floor raises it instead of serving a guaranteed non-answer.
  ok(validateRequest({ messages: msgs(), max_tokens: 32 }, SLUG).max_tokens === tier.minTokens, `a 32-token budget is raised to the ${tier.minTokens}-token floor`);
  ok(validateRequest({ messages: msgs() }, SLUG).max_tokens === tier.defaultMaxTokens, `no max_tokens -> generous default ${tier.defaultMaxTokens}`);
  ok(validateRequest({ messages: msgs(), max_tokens: 2000 }, SLUG).max_tokens === 2000, "a budget above the floor is left alone");
  ok(tier.minTokens >= 1024 && tier.defaultMaxTokens > 1024, "floor and default are both generous for a reasoning model");
  // The floor must not have leaked onto tiers that never asked for one.
  ok(validateRequest({ model: "gpt-4o-mini", messages: msgs(), max_tokens: 5 }, "v1-chat").max_tokens === 5, "other tiers keep honouring a tiny max_tokens (no cross-tier floor)");
  ok(validateRequest({ model: "gpt-4o-mini", messages: msgs() }, "v1-chat").max_tokens === 1024, "other tiers keep the historical 1024 default");
}
ok(isEmptyLength({ choices: [{ finish_reason: "length", message: { content: null } }] }), "isEmptyLength catches content:null + finish_reason length (the measured shape)");

// ---------------------------------------------------------------------------
console.log("\n# 6-7. outbound request shape, upstream cost stripped, empty-length 502");
const realFetch = globalThis.fetch;
const calls = [];
const stubFetch = (reply) => async (url, init) => {
  calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
  return reply(calls.length, JSON.parse(init.body));
};
const answer = (extra = {}) => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({
    id: "gen-ox", object: "chat.completion", model: OX_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0, cost_details: { upstream_inference_cost: 0 }, is_byok: false, cache_discount: 0 },
    ...extra,
  }),
});
try {
  calls.length = 0;
  globalThis.fetch = stubFetch(() => answer());
  const res = await tool.handler({ messages: msgs("hello") });
  const out = calls[0];
  ok(calls.length === 1, "exactly one upstream call");
  ok(out.url === "https://openrouter.ai/api/v1/chat/completions", "hits the OpenRouter chat endpoint");
  ok(out.headers["HTTP-Referer"] === "https://agent402.tools" && out.headers["X-Title"] === "Agent402.Tools x402 gateway", "attribution headers ride the request (fetchOpenRouter)");
  ok(out.headers.Authorization === "Bearer test-key", "the gateway key is sent, not the buyer's");
  ok(out.body.model === OX_MODEL, "outbound model is the locked id");
  ok(out.body.reasoning?.effort === "low", 'outbound carries reasoning effort "low"');
  ok(out.body.provider?.max_price?.completion === tier.maxPrice.completion, "server-owned provider.max_price rides upstream");
  ok(out.body.zdr === undefined && out.body.provider?.zdr === undefined, "no zdr is ever asserted upstream for this tier");
  ok(out.body.max_tokens === tier.defaultMaxTokens, "outbound max_tokens is the tier default");
  ok(out.body.service_tier === undefined, "not a flex model - no flex attempt is wasted");
  ok(res.usage.cost === undefined && res.usage.cost_details === undefined && res.usage.is_byok === undefined && res.usage.cache_discount === undefined, "upstream billing fields are stripped from the buyer's response");
  ok(res.usage.prompt_tokens === 10 && res.usage.completion_tokens === 2, "standard OpenAI token counts survive");
  ok(res.model === OX_MODEL, "response discloses which model served");

  // Empty answer with finish_reason "length": the chain has one link, so this
  // must surface as a 502. @x402/express cancels settlement for any >=400, so
  // the buyer is NOT charged for nothing.
  calls.length = 0;
  globalThis.fetch = stubFetch(() => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ id: "gen-ox", model: OX_MODEL, choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 4096 } }),
  }));
  await rejects(() => tool.handler({ messages: msgs("think hard") }), "no content within the output cap", "an empty 'length' answer never reaches the buyer as a paid 200");
  try { await tool.handler({ messages: msgs("think hard") }); } catch (e) {
    ok(e.statusCode === 502, `the empty-length walk ends in 502 (got ${e.statusCode}) - settlement cancelled, buyer not charged`);
  }

  // A 400 from our own validation must NOT spend an upstream call.
  calls.length = 0;
  globalThis.fetch = stubFetch(() => answer());
  await rejects(() => tool.handler({ messages: msgs(), zdr: true }), '"zdr" is not available', "zdr refusal happens before any upstream spend");
  ok(calls.length === 0, "a refused request makes zero upstream calls");
} finally {
  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------------------
console.log("\n# 8. vanish tolerance - availability gate and boot probe");
ok(oxAlphaAvailable() === true, "tier is available when switched on (id verified live 2026-08-22)");
{
  process.env.OX_ALPHA_ENABLED = "off";
  ok(oxAlphaAvailable() === false, "OX_ALPHA_ENABLED=off disables the tier (operator kill switch)");
  ok(!modelsList().data.some((m) => m.id === OX_MODEL), "a disabled tier is not advertised on GET /v1/models");
  delete process.env.OX_ALPHA_ENABLED;
  ok(oxAlphaAvailable() === false, "unset = OFF: a fresh self-host never advertises the dead stealth tier");
  process.env.OX_ALPHA_ENABLED = "on";
}
{
  // A successful catalog read that does NOT list the id disables the tier.
  const stubModels = (data) => async () => ({ ok: true, status: 200, json: async () => ({ data }) });
  const many = (n, id) => Array.from({ length: n }, (_, i) => ({ id: i === 0 ? id : `vendor/model-${i}` }));
  ok(await probeOxAlphaAvailability({ fetchImpl: stubModels(many(150, OX_MODEL)) }) === true, "probe reports live when the id is listed");
  ok(oxAlphaAvailable() === true, "a live probe leaves the tier enabled");

  ok(await probeOxAlphaAvailability({ fetchImpl: stubModels(many(150, "vendor/other")) }) === false, "probe reports gone when the id is absent");
  ok(oxAlphaAvailable() === false, "a gone id disables the tier in-process");
  ok(!modelsList().data.some((m) => m.id === OX_MODEL), "a withdrawn model is dropped from GET /v1/models");
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = stubFetch(() => answer());
  try {
    calls.length = 0;
    await rejects(() => tool.handler({ messages: msgs() }), "no longer served upstream", "a withdrawn model answers with a self-explaining error");
    ok(calls.length === 0, "the 503 is raised BEFORE any upstream call (no wasted round-trip)");
    try { await tool.handler({ messages: msgs() }); } catch (e) {
      ok(e.statusCode === 503, `withdrawn model -> 503 (got ${e.statusCode}); >=400 cancels settlement, so no buyer is charged`);
    }
  } finally { globalThis.fetch = realFetch2; }

  // FAIL OPEN: an unreadable catalog must never disable a working tier
  // (our own egress being down looks identical to an upstream deletion).
  _setOxUpstreamMissingForTest(false);
  ok(await probeOxAlphaAvailability({ fetchImpl: async () => { throw new Error("network down"); } }) === null, "an unreachable catalog returns null, not a verdict");
  ok(oxAlphaAvailable() === true, "a network failure leaves the tier enabled (fail open)");
  ok(await probeOxAlphaAvailability({ fetchImpl: stubModels(many(4, "vendor/other")) }) === null, "an implausibly small catalog is a read failure, not a delisting");
  ok(oxAlphaAvailable() === true, "an implausible catalog leaves the tier enabled");
  ok(await probeOxAlphaAvailability({ fetchImpl: async () => ({ ok: false, status: 503 }) }) === null, "an HTTP error is a read failure, not a delisting");
  ok(oxAlphaAvailable() === true, "an upstream 5xx leaves the tier enabled");
}

// ---------------------------------------------------------------------------
// 9. Upstream-price proof for the free-trial exception. The trial path exists
//    for pure-CPU routes so a free call can never give away upstream money;
//    this route is only eligible while the upstream bill is PROVABLY $0, so
//    the proof must fail closed in every direction.
console.log("\n# 9. oxUpstreamIsFree / oxUpstreamPricing - fail closed");
{
  const stubModels = (data) => async () => ({ ok: true, status: 200, json: async () => ({ data }) });
  const catalogWith = (pricing) => [
    { id: OX_MODEL, ...(pricing ? { pricing } : {}) },
    ...Array.from({ length: 149 }, (_, i) => ({ id: `vendor/model-${i}`, pricing: { prompt: "0.0000001", completion: "0.0000004" } })),
  ];

  _setOxUpstreamMissingForTest(false); // also clears any cached pricing
  ok(oxUpstreamIsFree() === false, "false before the first successful probe (never assume free)");
  ok(oxUpstreamPricing() === null, "no pricing reported before the first probe");

  // A network failure must not mint a proof.
  await probeOxAlphaAvailability({ fetchImpl: async () => { throw new Error("down"); } });
  ok(oxUpstreamIsFree() === false, "false after a failed probe");

  // The happy path: the live shape, verified 2026-08-22 (strings "0"/"0").
  await probeOxAlphaAvailability({ fetchImpl: stubModels(catalogWith({ prompt: "0", completion: "0" })) });
  ok(oxUpstreamIsFree() === true, 'true when the record reports prompt "0" and completion "0"');
  const px = oxUpstreamPricing();
  ok(px && px.prompt === "0" && px.completion === "0" && typeof px.checkedAt === "number", "pricing pair + checkedAt are exposed for an operator surface");

  // Any non-zero price - however small - switches it off.
  await probeOxAlphaAvailability({ fetchImpl: stubModels(catalogWith({ prompt: "0.0000001", completion: "0" })) });
  ok(oxUpstreamIsFree() === false, "a repriced prompt side (even 1e-7) is not free");
  await probeOxAlphaAvailability({ fetchImpl: stubModels(catalogWith({ prompt: "0", completion: "0.0000004" })) });
  ok(oxUpstreamIsFree() === false, "a repriced completion side is not free");
  await probeOxAlphaAvailability({ fetchImpl: stubModels(catalogWith(undefined)) });
  ok(oxUpstreamIsFree() === false, "a record with no pricing block is not free");
  await probeOxAlphaAvailability({ fetchImpl: stubModels(catalogWith({ prompt: "", completion: "" })) });
  ok(oxUpstreamIsFree() === false, "empty pricing strings are not free (Number('') is 0 - the string check catches it)");

  // The record vanishing clears the proof outright.
  await probeOxAlphaAvailability({ fetchImpl: stubModels(catalogWith({ prompt: "0", completion: "0" })) });
  ok(oxUpstreamIsFree() === true, "re-proved free");
  await probeOxAlphaAvailability({ fetchImpl: stubModels(Array.from({ length: 150 }, (_, i) => ({ id: `vendor/model-${i}` }))) });
  ok(oxUpstreamIsFree() === false && oxUpstreamPricing() === null, "a withdrawn model clears the price proof");

  // Staleness: a proof nobody has been able to refresh stops counting.
  await probeOxAlphaAvailability({ fetchImpl: stubModels(catalogWith({ prompt: "0", completion: "0" })) });
  const stale = oxUpstreamPricing();
  ok(oxUpstreamIsFree() === true, "fresh proof counts");
  process.env.OX_PRICING_MAX_AGE_MS = "1";
  await new Promise((r) => setTimeout(r, 5));
  ok(oxUpstreamIsFree() === false, "a stale proof does not count (a sustained read failure closes the trial)");
  delete process.env.OX_PRICING_MAX_AGE_MS;
  ok(oxUpstreamPricing()?.checkedAt === stale.checkedAt, "staleness never erases the last-seen values (an operator can still see them)");

  // Leave the module in the state the rest of the process expects.
  _setOxUpstreamMissingForTest(false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
