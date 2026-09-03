// Unit tests for the OpenAI-compatible x402 LLM gateway — the pure validation
// layer that gates what reaches the paid OpenRouter upstream: model → tier
// routing (incl. bare-name mapping and self-correcting cross-tier errors),
// input/output caps, stream rejection, and the env-gated 503. No network.
import { TIERS, canonicalModel, PREFIX_CANONICAL, meteredQuoteUsd, METERED_MAX_QUOTE_USD, tierAllows, tierFor, validateRequest, modelsList, LLM_GATEWAY_TOOLS, stableStringify, promptCacheKey, promptCacheGet, promptCacheStore, GATEWAY_TIER_BY_PATH, AUTO_RANKINGS, classifyPrompt, validateEmbeddingsRequest, embeddingsCacheKey, EMBEDDINGS_PATH, isEmptyRefusal, tokenizerFactor, NEW_TOKENIZER_FACTOR } from "../src/tools/llm-gateway-kit.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const throws = (fn, substr, msg) => {
  try { fn(); ok(false, `${msg} (did not throw)`); }
  catch (e) { ok(String(e.message).includes(substr), `${msg} (got: ${String(e.message).slice(0, 90)})`); }
};

const msg1 = (content = "hi") => [{ role: "user", content }];

// Route PostHog captures to the in-memory test sink. Must be set before the
// FIRST handler call in this file — the gateway loads posthog.js lazily on
// first use, and the module freezes its mode at import time.
process.env.POSTHOG_TEST_CAPTURE = "1";

// Bare OpenAI-style names map to OpenRouter ids — drop-in SDK compatibility.
ok(canonicalModel("gpt-4o-mini") === "openai/gpt-4o-mini", "bare gpt name maps to openai/");
ok(canonicalModel("claude-opus-4") === "anthropic/claude-opus-4", "bare claude name maps to anthropic/");
ok(canonicalModel("gemini-2.5-flash") === "google/gemini-2.5-flash", "bare gemini name maps to google/");
ok(canonicalModel("o3-mini") === "openai/o3-mini", "bare o3 name maps to openai/");
ok(canonicalModel("claude-haiku-4-5-20251001") === "anthropic/claude-haiku-4.5" && canonicalModel("claude-sonnet-4-5-20250929") === "anthropic/claude-sonnet-4.5" && canonicalModel("claude-opus-4-1-20250805") === "anthropic/claude-opus-4.1", "Anthropic dated ids (what Claude Code / the SDKs send) resolve to the OpenRouter family id");
ok(canonicalModel("claude-sonnet-5") === "anthropic/claude-sonnet-5" && canonicalModel("claude-opus-5") === "anthropic/claude-opus-5" && canonicalModel("claude-3-5-sonnet-20241022") === "anthropic/claude-3-5-sonnet", "undated ids untouched; legacy claude-3-5-sonnet-<date> only loses the date");
// A family prefix that is not an upstream id resolves to its concrete model
// (2026-08-26: "anthropic/claude-opus" was advertised on /v1/models and
// OpenRouter rejected it verbatim). Bare and OpenRouter forms, any case.
ok(canonicalModel("anthropic/claude-opus") === "anthropic/claude-opus-5" && canonicalModel("claude-opus") === "anthropic/claude-opus-5" && canonicalModel("Anthropic/Claude-Opus") === "anthropic/claude-opus-5", "bare family prefix claude-opus resolves to the concrete claude-opus-5");
ok(canonicalModel("anthropic/claude-opus-5-fast") === "anthropic/claude-opus-5-fast", "a concrete id under the family is left alone");
ok(tierAllows("v1-chat-premium", "anthropic/claude-opus") && tierFor("anthropic/claude-opus") === "v1-chat-premium", "the resolved family id is still premium-allowlisted");
{
  const listed = modelsList().data.map((m) => m.id);
  ok(listed.includes("anthropic/claude-opus-5") && !listed.includes("anthropic/claude-opus"), "/v1/models advertises the concrete id, never the bare family prefix");
  const bare = Object.keys(PREFIX_CANONICAL).filter((p) => listed.includes(p));
  ok(bare.length === 0, `no PREFIX_CANONICAL key is listed bare on /v1/models${bare.length ? ` (${bare.join(", ")})` : ""}`);
  ok(Object.values(PREFIX_CANONICAL).every((id) => tierFor(id) !== null), "every canonical target is allowlisted on some tier");
}
ok(canonicalModel("deepseek/deepseek-chat") === "deepseek/deepseek-chat", "OpenRouter ids pass through");

// Tier routing.
ok(tierAllows("v1-chat", "gpt-4o-mini"), "gpt-4o-mini allowed on base tier");
ok(tierAllows("v1-chat", "deepseek/deepseek-chat"), "vendor-family prefix (deepseek/) allowed on base tier");
ok(!tierAllows("v1-chat", "openai/gpt-4o"), "gpt-4o NOT on base tier");
ok(tierAllows("v1-chat-pro", "openai/gpt-4o"), "gpt-4o on pro tier");
ok(tierAllows("v1-chat-premium", "claude-opus-4"), "claude opus on premium tier");
ok(tierFor("openai/gpt-4o") === "v1-chat-pro", "tierFor routes gpt-4o to pro");
ok(tierFor("not-a-real/model") === null, "tierFor null for unknown models");

// gpt-4o must not leak onto the base tier via the gpt-4o-mini prefix rules.
ok(!tierAllows("v1-chat", "openai/gpt-4o-2024-08-06"), "dated gpt-4o snapshot NOT on base tier");
ok(tierAllows("v1-chat", "openai/gpt-4o-mini-2024-07-18"), "dated gpt-4o-mini snapshot on base tier");

// 2026-08 model refresh — every new family resolves to its intended home,
// and gpt-5.6 ids do NOT ride the "openai/gpt-5" prefix (boundary-aware
// matching: "gpt-5" + "-" never matches "gpt-5.6-…").
ok(tierFor("openai/gpt-5.6-luna") === "v1-chat-nano", "gpt-5.6-luna homes on nano");
// gpt-5.6-terra came OFF the base tier 2026-08-28: it lists at $2/$12, over
// that tier's completion bound, so max_price refused every non-flex attempt.
ok(tierFor("openai/gpt-5.6-terra") === null || tierFor("openai/gpt-5.6-terra") !== "v1-chat", `gpt-5.6-terra no longer homes on base (got ${tierFor("openai/gpt-5.6-terra")})`);
ok(!tierAllows("v1-chat", "openai/gpt-5.6-terra"), "the base tier refuses terra rather than sending a request max_price will reject");
ok(tierFor("openai/gpt-5.6-sol") === "v1-chat-premium", "gpt-5.6-sol homes on premium");
ok(tierFor("anthropic/claude-sonnet-5") === "v1-chat-pro", "claude-sonnet-5 homes on pro via the sonnet prefix");
ok(tierFor("anthropic/claude-opus-5") === "v1-chat-premium", "claude-opus-5 homes on premium via the opus prefix");
ok(tierFor("poolside/laguna-xs-2.1") === "v1-chat-nano", "laguna-xs homes on nano");
ok(!tierAllows("v1-chat-premium", "openai/gpt-5.6-luna-pro") || tierFor("openai/gpt-5.6-luna-pro") === "v1-chat-nano", "luna-pro variant still resolves to nano first");

// validateRequest — happy path clamps and passthrough.
const v = validateRequest({ model: "gpt-4o-mini", messages: msg1(), max_tokens: 999999, temperature: 0.2, stream: false }, "v1-chat");
ok(v.model === "openai/gpt-4o-mini", "request model canonicalised");
ok(v.max_tokens === TIERS["v1-chat"].maxTokens, "max_tokens clamped to tier cap");
ok(v.temperature === 0.2, "temperature passed through");
ok(!("stream" in v), "stream:false dropped from upstream body");

// Self-correcting cross-tier error names the right endpoint + price.
throws(() => validateRequest({ model: "gpt-4o", messages: msg1() }, "v1-chat"), "/v1/pro/chat/completions", "cross-tier error points at the pro endpoint");
throws(() => validateRequest({ model: "gpt-4o", messages: msg1() }, "v1-chat"), "$0.10", "cross-tier error names the pro price");
throws(() => validateRequest({ model: "made-up-model-9000", messages: msg1() }, "v1-chat"), "/v1/models", "unknown model error points at the models list");

// Hard rejections.
{
  const v = validateRequest({ model: "gpt-4o-mini", messages: msg1(), stream: true, stream_options: { include_usage: true } }, "v1-chat");
  ok(v.stream === true && v.stream_options?.include_usage === true, "stream:true accepted and carried to the upstream body (with stream_options)");
  const nv = validateRequest({ model: "gpt-4o-mini", messages: msg1() }, "v1-chat");
  ok(nv.stream === undefined, "non-stream requests carry no stream flag");
}
throws(() => validateRequest({ model: "gpt-4o-mini", messages: [] }, "v1-chat"), "non-empty", "empty messages rejected");
ok(validateRequest({ messages: msg1() }, "v1-chat").model === "openai/gpt-4o-mini", "missing model is served as the tier default (was a 400 until 2026-08-28)");
throws(() => validateRequest({ model: "gpt-4o-mini", messages: msg1("x".repeat(40_000)) }, "v1-chat"), "Input too large", "input char cap enforced");
throws(() => validateRequest({ model: "gpt-4o-mini", messages: Array.from({ length: 101 }, () => ({ role: "user", content: "x" })) }, "v1-chat"), "Too many messages", "message count cap enforced");

// Billing-changing model variants are refused with a self-explaining 400:
// ":online" attaches per-request web-search billing outside max_price, and
// ":batch" is the async batch API. Routing-only variants (":nitro") still pass
// the allowlist as before.
{
  const rej = (m) => { try { validateRequest({ model: m, messages: msg1() }, "v1-chat"); return null; } catch (e) { return e; } };
  const on = rej("openai/gpt-4o-mini:online");
  ok(on?.statusCode === 400 && /:online/.test(on.message) && /web search/.test(on.message) && /openai\/gpt-4o-mini"/.test(on.message), `":online" refused with a self-explaining 400 naming the plain id (${on?.message})`);
  const ba = rej("openai/gpt-4o-mini:batch");
  ok(ba?.statusCode === 400 && /:batch/.test(ba.message) && /asynchronous/.test(ba.message), `":batch" refused with a self-explaining 400 (${ba?.message})`);
  ok(rej("openai/gpt-4o-mini:nitro") === null, "routing-only variant :nitro still admitted");
}

// Env-gated 503 before any network I/O (no OPENROUTER_API_KEY in this test env).
delete process.env.OPENROUTER_API_KEY;
const gatewayTool = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat");
await gatewayTool.handler({ model: "gpt-4o-mini", messages: msg1(), max_tokens: 5 }).then(
  () => ok(false, "handler without key must throw"),
  (e) => ok(e.statusCode === 503, `handler without key throws 503 (got ${e.statusCode})`)
);

// Models list — OpenAI-compatible envelope, every tier represented, priced.
const list = modelsList();
ok(list.object === "list" && Array.isArray(list.data) && list.data.length > 10, "models list has OpenAI shape");
ok(list.data.every((m) => m.object === "model" && m.x402?.priceUsd > 0 && m.x402?.endpoint?.startsWith("/v1")), "every model entry carries x402 tier metadata");
ok(new Set(list.data.map((m) => m.x402.tier)).size === 10, "all five chat tiers + grounded + ox + embeddings + images + speech represented");

// Catalog invariants: wallet-only-priced routes at OpenAI wire paths.
ok(LLM_GATEWAY_TOOLS.length === 12, "twelve gateway routes (five chat tiers + grounded + ox + metered, embeddings, rerank, images, speech)");

// Nano tier — priced for loops; nano models keep working on the base tier
// (drop-in callers can overpay) but tierFor leads with the cheapest home.
ok(TIERS["v1-chat-nano"].price === 0.003, "nano tier priced at $0.003");
ok(tierAllows("v1-chat-nano", "gpt-5-nano"), "gpt-5-nano allowed on nano tier");
ok(tierAllows("v1-chat", "gpt-5-nano"), "gpt-5-nano STILL allowed on base tier (non-breaking)");
ok(tierFor("openai/gpt-5-nano") === "v1-chat-nano", "tierFor leads with the nano tier");
ok(!tierAllows("v1-chat-nano", "openai/gpt-4o"), "gpt-4o NOT on nano tier");
ok(tierAllows("v1-chat-nano", "deepseek/deepseek-chat"), "deepseek-chat on nano tier");
{
  const v = validateRequest({ model: "gpt-5-nano", messages: [{ role: "user", content: "hi" }], max_tokens: 99999 }, "v1-chat-nano");
  ok(v.max_tokens === TIERS["v1-chat-nano"].maxTokens, "nano output cap clamps");
}
ok(LLM_GATEWAY_TOOLS.every((t) => t.route.startsWith("POST /v1/")), "routes live at OpenAI wire paths");

// Upstream failover: a provider error on the requested model must not become
// the buyer's 502 when the tier has a fallback chain (payment already settled).
{
  process.env.OPENROUTER_API_KEY = "test-key";
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    if (body.model === "mistralai/ministral-8b-2512") {
      return { ok: false, status: 502, text: async () => JSON.stringify({ error: { message: "Provider returned error" } }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-1", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }) };
  };
  const nano = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-nano");
  // A NON-flex nano model: a flex-eligible one is tried twice (flex, then default) before the chain.
  const res = await nano.handler({ model: "mistralai/ministral-8b-2512", messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
  ok(res.choices?.[0]?.message?.content === "OK", "failover serves the buyer despite the requested model's provider error");
  ok(res.model === "deepseek/deepseek-chat", `response discloses the serving model (got ${res.model})`);
  ok(calls.join(",") === "mistralai/ministral-8b-2512,deepseek/deepseek-chat", `tried requested model first, then the chain (got ${calls.join(",")})`);

  // Validation errors must NOT trigger the chain — the buyer's input is wrong.
  calls.length = 0;
  let threw = null;
  try { await nano.handler({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }); } catch (e) { threw = e; }
  ok(threw?.statusCode === 400 && calls.length === 0, "tier-allowlist 400 throws before any upstream call — no silent substitution");
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
}

// Streaming: stream:true returns an __sse writer; SSE passes through verbatim
// with correct headers; pre-stream provider errors walk the failover chain.
{
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const sseBody = (lines) => ({
    async *[Symbol.asyncIterator]() { for (const l of lines) yield Buffer.from(l); },
  });
  const fakeRes = () => {
    const r = {
      headersSent: false, headers: null, chunks: [], ended: false, listeners: {},
      writeHead(status, headers) { r.headersSent = true; r.status = status; r.headers = headers; },
      flushHeaders() {},
      write(c) { r.chunks.push(String(c)); },
      end() { r.ended = true; },
      on(ev, cb) { r.listeners[ev] = cb; },
    };
    return r;
  };
  const nano = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-nano");

  // Happy path — deepseek streams (it's in the nano allowlist). The upstream
  // final frame carries OpenRouter's billing fields (it always does now, no
  // opt-in): they must be stripped in flight, split across chunks or not.
  const usageFrame = 'data: {"id":"gen-s","model":"deepseek/deepseek-chat","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4,"cost":0.0000049,"is_byok":false,"cost_details":{"upstream_inference_cost":0.000004}}}\n\n';
  let seenStreamBody = null;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seenStreamBody = body;
    ok(body.stream === true, "stream flag reaches the upstream body");
    // Split the usage frame mid-JSON across two chunks on purpose.
    const cut = usageFrame.indexOf('"cost"') + 3;
    return { ok: true, status: 200, body: sseBody(['data: {"choices":[{"delta":{"content":"O"}}]}\n\n', usageFrame.slice(0, cut), usageFrame.slice(cut), "data: [DONE]\n\n"]) };
  };
  const fakeReq = { header: (n) => (n.toLowerCase() === "payment-signature" ? Buffer.from(JSON.stringify({ payload: { authorization: { from: "0xAbCdEf0000000000000000000000000000000001" } } })).toString("base64") : undefined) };
  const streamResult = await nano.handler({ model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true }, fakeReq);
  ok(typeof streamResult.__sse === "function", "stream:true returns the __sse writer sentinel");
  const res1 = fakeRes();
  await streamResult.__sse(res1);
  ok(res1.status === 200 && res1.headers["Content-Type"].startsWith("text/event-stream"), "SSE headers written");
  const streamed = res1.chunks.join("");
  ok(streamed.includes('data: {"choices":[{"delta":{"content":"O"}}]}') && streamed.includes("[DONE]") && res1.ended, "content frames pass through verbatim and the stream ends");
  ok(!/"cost"|cost_details|is_byok/.test(streamed), "OpenRouter billing fields are stripped from the streamed usage frame (even split across chunks)");
  ok(/"usage":\{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4\}/.test(streamed), "standard token counts still reach the streaming buyer");
  ok(typeof seenStreamBody.user === "string" && /^a402:[0-9a-f]{32}$/.test(seenStreamBody.user), `per-buyer user id rides upstream on streams (${seenStreamBody.user})`);

  // An upstream stream that only ever sends keep-alive comments and then
  // closes (measured live: ": OPENROUTER PROCESSING" x N, no data frame) must
  // NOT become a paid 200: no status is written, the __sse writer rejects 502,
  // and the chain moves on. A comment followed by a real frame still serves.
  {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return { ok: true, status: 200, body: sseBody([": OPENROUTER PROCESSING\n\n", ": OPENROUTER PROCESSING\n\n"]) }; };
    const r = await nano.handler({ model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true }, fakeReq);
    const resEmpty = fakeRes();
    let err = null; try { await r.__sse(resEmpty); } catch (e) { err = e; }
    ok(err?.statusCode === 502 && resEmpty.headersSent === false && resEmpty.chunks.length === 0 && resEmpty.ended === false,
      `a comment-only upstream stream is a 502 with nothing written, never a paid empty 200 (got status ${err?.statusCode}, headersSent ${resEmpty.headersSent})`);
    ok(calls >= 2, `the chain was walked after the empty stream (${calls} upstream attempts)`);
    globalThis.fetch = async () => ({ ok: true, status: 200, body: sseBody([": OPENROUTER PROCESSING\n\n", 'data: {"choices":[{"delta":{"content":"O"}}]}\n\n', "data: [DONE]\n\n"]) });
    const r2 = await nano.handler({ model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true }, fakeReq);
    const resOk = fakeRes();
    await r2.__sse(resOk);
    const got = resOk.chunks.join("");
    ok(resOk.status === 200 && got.startsWith(": OPENROUTER PROCESSING") && got.includes('"content":"O"') && got.includes("[DONE]") && resOk.ended, "a keep-alive comment followed by a data frame is served in order, comment included");
  }
  {
    const { _testEventsForTest } = await import("../src/posthog.js");
    await new Promise((r) => setTimeout(r, 20));
    const ev = _testEventsForTest().filter((e) => e.event === "gateway_usage").pop();
    ok(ev?.properties.upstreamUsd === 0.0000049 && ev?.properties.tier === "v1-chat-nano" && ev?.properties.completionTokens === 1, "streams now carry margin telemetry (cost captured from the scrubbed frame)");
  }
  // No req (non-HTTP caller) → no user field; the same payer → the same id.
  globalThis.fetch = async (url, init) => { seenStreamBody = JSON.parse(init.body); return { ok: true, status: 200, body: sseBody(["data: [DONE]\n\n"]) }; };
  await (await nano.handler({ model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true })).__sse(fakeRes());
  ok(seenStreamBody.user === undefined, "no request context → no user field");
  const { upstreamUserId } = await import("../src/tools/llm-gateway-kit.js");
  ok(upstreamUserId(fakeReq) === upstreamUserId(fakeReq) && upstreamUserId(fakeReq) !== upstreamUserId({ header: (n) => (n === "authorization" ? "Payment abc" : undefined) }), "user id is stable per payer and distinct per credential");
  ok(!upstreamUserId(fakeReq).includes("0xAbCdEf"), "the user id is a hash, never the raw wallet");

  // Pre-stream failover: requested model 502s before any bytes → fallback streams.
  const tried = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    tried.push(body.model);
    if (body.model === "mistralai/ministral-8b-2512") return { ok: false, status: 502, text: async () => "provider down" };
    return { ok: true, status: 200, body: sseBody(["data: [DONE]\n\n"]) };
  };
  const res2 = fakeRes();
  await (await nano.handler({ model: "mistralai/ministral-8b-2512", messages: [{ role: "user", content: "hi" }], stream: true })).__sse(res2);
  ok(tried.join(",") === "mistralai/ministral-8b-2512,deepseek/deepseek-chat" && res2.ended, `pre-stream failover walks the chain (tried ${tried.join(",")})`);

  // An upstream HTTP 200 whose body is an error with NO output (OpenRouter's
  // shape for a provider rate limit after the response line) is an upstream
  // failure, not an answer: the chain walks, and a chain that ends that way
  // surfaces 503/502 (never a paid empty 200). Measured on the auto tier's own
  // example 2026-09-02.
  {
    const { assertUpstreamBody } = await import("../src/tools/llm-gateway-kit.js");
    let e1 = null; try { assertUpstreamBody({ id: "gen-1", error: { message: "openai/gpt-5.6-luna is temporarily rate-limited upstream. Please retry shortly" } }); } catch (e) { e1 = e; }
    ok(e1?.statusCode === 503 && /rate-limited/.test(e1.message), "200 + {error: rate-limited} + no choices -> 503 (walkable)");
    let e2 = null; try { assertUpstreamBody({ error: { code: 500, message: "provider exploded" } }); } catch (e) { e2 = e; }
    ok(e2?.statusCode === 502, "200 + a non-rate-limit error + no output -> 502");
    ok(assertUpstreamBody({ error: { message: "partial" }, choices: [{ message: { content: "x" } }] })?.choices?.length === 1, "an error beside real output is returned as-is (partial answers are the buyer's)");
    ok(assertUpstreamBody({ choices: [] })?.choices?.length === 0 && assertUpstreamBody(null) === null, "no error field -> untouched (the empty-refusal / empty-length walks judge those)");
    const walked = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body); walked.push(body.model);
      if (walked.length === 1) return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-1", error: { message: "temporarily rate-limited upstream" } }), headers: { get: () => "application/json" } };
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-2", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), headers: { get: () => "application/json" } };
    };
    const out = await nano.handler({ model: "gpt-5-nano", messages: [{ role: "user", content: "hi" }] }, { header: () => undefined, headers: {}, ip: "127.0.0.1" });
    ok(walked.length === 2 && out?.choices?.[0]?.message?.content === "ok", `a 200-with-error link is walked past, the next link answers (tried ${walked.join(",")})`);
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-x", error: { message: "temporarily rate-limited upstream" } }), headers: { get: () => "application/json" } });
    let all = null; try { await nano.handler({ model: "gpt-5-nano", messages: [{ role: "user", content: "hi" }] }, { header: () => undefined, headers: {}, ip: "127.0.0.1" }); } catch (e) { all = e; }
    ok(all && all.statusCode >= 500 && all.statusCode < 600, `a chain that is rate-limited end to end surfaces ${all?.statusCode}, never a paid empty 200`);
  }

  // Validation still precedes everything: wrong-tier model rejects with 400.
  let threw = null;
  try { await nano.handler({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }); } catch (e) { threw = e; }
  ok(threw?.statusCode === 400, "stream requests still validate before any upstream call");

  // The scrubber itself: byte-exact pass-through for non-usage frames, a
  // buffered partial line, and a usage frame with nothing to strip left alone.
  const { createSseUsageScrubber } = await import("../src/tools/llm-gateway-kit.js");
  const sc = createSseUsageScrubber();
  ok(sc.push("data: {\"a\":1}\n\ndata: {\"b\"") === "data: {\"a\":1}\n\n" && sc.push(":2}\n") === "data: {\"b\":2}\n", "complete lines forwarded as-is, partial line held until complete");
  ok(sc.flush() === "" && sc.push("data: [DONE]") === "" && sc.flush() === "data: [DONE]", "flush forwards a trailing unterminated line");
  const clean = 'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}';
  ok(createSseUsageScrubber().push(clean + "\n") === clean + "\n", "a usage frame with no billing fields passes through byte-for-byte");
  {
    // fetch's body yields Uint8Array chunks (never Buffers): the scrubber must
    // decode them as UTF-8 text, and a multibyte character split across two
    // chunks must survive. Before 2026-08-27 String(Uint8Array) turned every
    // streamed frame into comma-joined digits and the relay never saw "data:".
    const frame = 'data: {"choices":[{"delta":{"content":"héllo"}}]}\n';
    const bytes = new TextEncoder().encode(frame);
    const cut = frame.indexOf("é") + 1; // byte index inside the 2-byte "é"
    const u8 = createSseUsageScrubber();
    const first = u8.push(new Uint8Array(bytes.subarray(0, cut)));
    const rest = u8.push(new Uint8Array(bytes.subarray(cut)));
    ok(first === "" && rest === frame, "Uint8Array chunks decode as UTF-8 text (never comma-joined digits), a split multibyte char is reassembled");
    ok(createSseUsageScrubber().push(new Uint8Array(bytes)) === frame, "a whole Uint8Array frame passes through byte-for-byte");
  }
  // NESTED usage (Responses API final frame) must be scrubbed too - the
  // first scrubber only looked at top-level obj.usage, which would have
  // forwarded response.usage.cost on every streamed /v1/.../responses call.
  let nestedSeen = null;
  const scN = createSseUsageScrubber({ onUsage: (u, cost) => { nestedSeen = { u, cost }; } });
  const nestedOut = scN.push('data: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":6,"output_tokens":3,"cost":0.0000018,"is_byok":false,"cost_details":{"upstream_inference_cost":0.0000018}}}}\n');
  ok(!/cost|is_byok/.test(nestedOut) && /"input_tokens":6/.test(nestedOut) && nestedSeen?.cost === 0.0000018 && nestedSeen.u.input_tokens === 6, "scrubber strips response.usage billing fields in a Responses completed frame and reports the cost");
  ok(!/cost/.test(createSseUsageScrubber().push('data: {"type":"message_start","message":{"usage":{"input_tokens":1,"cost":0.1}}}\n')), "scrubber strips message.usage billing fields (Anthropic message_start) too");
  // SSE permits "data:" with no space; a format change upstream must not re-open the stream leak.
  const noSpace = createSseUsageScrubber().push('data:{"id":"x","usage":{"prompt_tokens":2,"cost":0.5,"cache_discount":-0.1}}\n');
  ok(!/cost|cache_discount/.test(noSpace) && /"prompt_tokens":2/.test(noSpace), "scrubber handles a 'data:' frame with no space after the colon");

  // Flex-first on eligible links: gemini-2.5-flash-lite (nano allowlist) is
  // tried on flex, falls to default on a capacity error, and only THEN does
  // the chain move on; deepseek (not eligible) never sees service_tier.
  const { flexAttempts, flexEligible, FLEX_MODELS } = await import("../src/tools/llm-gateway-kit.js");
  ok(flexEligible("google/gemini-2.5-flash-lite") && flexEligible("openai/gpt-5.6-luna") && !flexEligible("openai/gpt-4o-mini") && !flexEligible("deepseek/deepseek-chat"), "flex eligibility follows the live-verified table");
  ok(JSON.stringify(flexAttempts(["google/gemini-2.5-flash-lite", "deepseek/deepseek-chat"])) === JSON.stringify([{ model: "google/gemini-2.5-flash-lite", flex: true }, { model: "google/gemini-2.5-flash-lite", flex: false }, { model: "deepseek/deepseek-chat", flex: false }]), "attempts = [flex, default] for eligible links, [default] otherwise");
  process.env.OPENROUTER_FLEX = "off";
  ok(!flexEligible("google/gemini-2.5-flash-lite") && FLEX_MODELS.includes("google/gemini-2.5-flash-lite"), "OPENROUTER_FLEX=off disables flex without touching the table");
  delete process.env.OPENROUTER_FLEX;
  const flexTried = [];
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body); flexTried.push(`${b.model}:${b.service_tier || "default"}`);
    if (b.service_tier === "flex") return { ok: false, status: 503, text: async () => "flex capacity" };
    return { ok: true, status: 200, body: sseBody(["data: [DONE]\n\n"]) };
  };
  const resF = fakeRes();
  await (await nano.handler({ model: "google/gemini-2.5-flash-lite", messages: [{ role: "user", content: "hi" }], stream: true })).__sse(resF);
  ok(flexTried.join(",") === "google/gemini-2.5-flash-lite:flex,google/gemini-2.5-flash-lite:default" && resF.ended, `stream: flex capacity error → same model on default, chain not advanced (tried ${flexTried.join(",")})`);
  flexTried.length = 0;
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body); flexTried.push(`${b.model}:${b.service_tier || "default"}`);
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "g", model: b.model, service_tier: b.service_tier || "default", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.0000001 } }) };
  };
  const outF = await nano.handler({ model: "google/gemini-2.5-flash-lite", messages: [{ role: "user", content: "hi" }] });
  ok(flexTried.join(",") === "google/gemini-2.5-flash-lite:flex" && outF.service_tier === "flex", "non-stream: a flex success is served first time, one upstream call");
  {
    const { _testEventsForTest } = await import("../src/posthog.js");
    const ev = _testEventsForTest().filter((e) => e.event === "gateway_usage").pop();
    ok(ev?.properties.serviceTier === "flex", "chat telemetry records the flex tier");
  }
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
}

// Prompt cache: explicit opt-in, normalized keying, opt-in-only writes.
{
  ok(stableStringify({ b: 1, a: [{ y: 2, x: 1 }] }) === stableStringify({ a: [{ x: 1, y: 2 }], b: 1 }), "stableStringify is key-order independent");

  const msgs = [{ role: "user", content: "hi" }];
  const k1 = promptCacheKey("v1-chat-nano", { model: "gpt-5-nano", messages: msgs, cache: true });
  const k2 = promptCacheKey("v1-chat-nano", { cache: true, messages: msgs, model: "openai/gpt-5-nano" });
  ok(k1 && k1 === k2, "model alias + field order collapse to one cache key");
  const k3 = promptCacheKey("v1-chat-nano", { model: "gpt-5-nano", messages: msgs, temperature: 0.7, cache: true });
  ok(k3 !== k1, "sampling params (temperature) change the key");
  ok(promptCacheKey("v1-chat-nano", { model: "gpt-5-nano", messages: msgs, stream: true, cache: true }) === null, "streamed requests are never cacheable");

  promptCacheStore(k1, { id: "gen-cached", choices: [] });
  ok(promptCacheGet(k1)?.id === "gen-cached", "store/get roundtrip");
  ok(promptCacheGet(k3) === null, "different key misses");

  ok(GATEWAY_TIER_BY_PATH["/v1/nano/chat/completions"] === "v1-chat-nano", "path -> tier map covers nano");
  ok(Object.keys(GATEWAY_TIER_BY_PATH).length === 8, "path -> tier map covers the five tiers + grounded + ox + metered");

  // The handler writes the cache ONLY when the buyer opted in.
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    ok(body.cache === undefined, "cache flag never rides to the upstream");
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-fresh", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }) };
  };
  const nano = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-nano");
  const optIn = { model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "cache me" }], cache: true };
  await nano.handler(optIn);
  ok(promptCacheGet(promptCacheKey("v1-chat-nano", optIn))?.id === "gen-fresh", "opted-in success is stored under the normalized key");
  const noOpt = { model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "do not cache me" }] };
  await nano.handler(noOpt);
  ok(promptCacheGet(promptCacheKey("v1-chat-nano", { ...noOpt, cache: true })) === null, "without cache:true nothing is stored");
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
}

// Auto tier — eval-ranked routing: deterministic classification, optional
// model, ranking-as-failover-chain, disclosure, and the tier-ordering lock.
{
  ok(TIERS["v1-chat-auto"].price === 0.01, "auto tier priced at $0.01");
  ok(
    Object.values(AUTO_RANKINGS).every((byCategory) => Object.values(byCategory).every((list) => list.includes("openai/gpt-4o-mini"))),
    "every ranking in every quality band contains the canary-proven terminal model"
  );

  // Classification is lexical and deterministic.
  ok(classifyPrompt([{ role: "user", content: "Refactor this function:\n```js\nreturn 1\n```" }]) === "code", "code prompts classify as code");
  ok(classifyPrompt([{ role: "user", content: "Solve the equation 3x + 5 = 20 step by step" }]) === "reasoning", "math prompts classify as reasoning");
  ok(classifyPrompt([{ role: "user", content: "x".repeat(9000) }]) === "long", "big plain prompts classify as long");
  ok(classifyPrompt([{ role: "user", content: `Refactor this function:\n\`\`\`js\nreturn 1\n\`\`\`\n${"x".repeat(9000)}` }]) === "code", "code signal outranks raw length");
  ok(classifyPrompt([{ role: "user", content: "What is the capital of France?" }]) === "general", "plain prompts classify as general");
  ok(classifyPrompt("not-an-array") === "general", "malformed messages tolerate as general (validation 400s right after)");

  // Model resolution: omitted or "auto" routes; explicit ranked models honored.
  const noModel = validateRequest({ messages: msg1("What is the capital of France?") }, "v1-chat-auto");
  ok(noModel.model === AUTO_RANKINGS.balanced.general[0], `missing model resolves to the balanced general head (got ${noModel.model})`);
  const autoModel = validateRequest({ model: "auto", messages: msg1("Solve the equation 3x + 5 = 20 step by step") }, "v1-chat-auto");
  ok(autoModel.model === AUTO_RANKINGS.balanced.reasoning[0], "model:'auto' resolves via the classifier");

  // Quality knob: band selection is deterministic, price-neutral, and only
  // valid when the gateway is picking the model.
  ok(validateRequest({ messages: msg1("hello"), quality: "fast" }, "v1-chat-auto").model === AUTO_RANKINGS.fast.general[0], "quality:'fast' resolves from the fast band");
  ok(validateRequest({ messages: msg1("hello"), quality: "best" }, "v1-chat-auto").model === AUTO_RANKINGS.best.general[0], "quality:'best' resolves from the best band");
  ok(validateRequest({ messages: msg1("hello"), quality: "balanced" }, "v1-chat-auto").model === AUTO_RANKINGS.balanced.general[0], "explicit quality:'balanced' matches the default");
  throws(() => validateRequest({ messages: msg1("hello"), quality: "supreme" }, "v1-chat-auto"), "must be one of", "unknown quality rejected with the option list");
  throws(() => validateRequest({ model: "gpt-4o-mini", messages: msg1(), quality: "best" }, "v1-chat-auto"), "applies only", "quality with an explicit model is rejected, not silently ignored");
  {
    const v = validateRequest({ messages: msg1("hello"), quality: "best" }, "v1-chat-auto");
    ok(v.quality === undefined, "quality never rides to the upstream body");
  }
  ok(validateRequest({ model: "gpt-4o-mini", messages: msg1() }, "v1-chat-auto").model === "openai/gpt-4o-mini", "explicit ranked model honored on the auto tier");
  throws(() => validateRequest({ model: "openai/gpt-4o", messages: msg1() }, "v1-chat-auto"), "/v1/pro/chat/completions", "off-ranking model still self-corrects to its home tier");
  {
    const v = validateRequest({ messages: msg1(), max_tokens: 99999 }, "v1-chat-auto");
    ok(v.max_tokens === TIERS["v1-chat-auto"].maxTokens, "auto output cap clamps");
  }

  // Ordering lock: the auto tier is listed LAST, so tierFor keeps resolving
  // explicit models to their pre-existing home tiers.
  ok(tierFor("openai/gpt-4o-mini") === "v1-chat", "tierFor: gpt-4o-mini's home stays the base tier");
  ok(tierFor("deepseek/deepseek-chat") === "v1-chat-nano", "tierFor: deepseek-chat's home stays the nano tier");

  // Handler: routed request uses the category ranking as the failover chain
  // and discloses the decision; explicit-model requests stay unannotated.
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    if (body.model === AUTO_RANKINGS.balanced.code[0]) return { ok: false, status: 502, text: async () => "provider down" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-a", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }) };
  };
  const auto = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-auto");
  const routed = await auto.handler({ messages: [{ role: "user", content: "Refactor this function:\n```js\nreturn 1\n```" }], max_tokens: 5 });
  ok(routed.agent402_router?.category === "code", `routed response discloses the category (got ${routed.agent402_router?.category})`);
  ok(routed.agent402_router?.quality === "balanced", `routed response discloses the default quality (got ${routed.agent402_router?.quality})`);
  ok(routed.agent402_router?.served === AUTO_RANKINGS.balanced.code[1], `provider error walks DOWN the ranking (served ${routed.agent402_router?.served})`);
  ok(calls.join(",") === AUTO_RANKINGS.balanced.code.slice(0, 2).join(","), `chain follows the ranking order (got ${calls.join(",")})`);

  // quality:'fast' code prompt — the chain must come from the fast band.
  calls.length = 0;
  const fastRouted = await auto.handler({ messages: [{ role: "user", content: "Refactor this function:\n```js\nreturn 1\n```" }], quality: "fast", max_tokens: 5 });
  ok(fastRouted.agent402_router?.quality === "fast" && fastRouted.agent402_router?.category === "code", "fast-band routing disclosed");
  ok(calls.join(",") === AUTO_RANKINGS.fast.code[0], `fast band serves its own ranking head (got ${calls.join(",")})`);

  calls.length = 0;
  const explicit = await auto.handler({ model: "gpt-4o-mini", messages: msg1(), max_tokens: 5 });
  ok(explicit.agent402_router === undefined, "explicit-model requests carry no router annotation");
  ok(calls.join(",") === "openai/gpt-4o-mini", `explicit model goes straight upstream (got ${calls.join(",")})`);
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;

  // Prompt cache composes: model-less requests key on the RESOLVED model, so
  // identical routed requests collapse to one entry and ranking-table changes
  // invalidate cleanly.
  const kAuto1 = promptCacheKey("v1-chat-auto", { messages: msg1("hello there"), cache: true });
  const kAuto2 = promptCacheKey("v1-chat-auto", { cache: true, messages: msg1("hello there") });
  ok(kAuto1 && kAuto1 === kAuto2, "auto-tier cache key is stable without a model field");
  ok(kAuto1 === promptCacheKey("v1-chat-auto", { model: AUTO_RANKINGS.balanced.general[0], messages: msg1("hello there"), cache: true }), "routed and explicit-equivalent requests share one cache entry");
  ok(kAuto1 !== promptCacheKey("v1-chat-auto", { messages: msg1("hello there"), quality: "best", cache: true }), "a quality band that resolves a different model gets its own cache entry");
  ok(GATEWAY_TIER_BY_PATH["/v1/auto/chat/completions"] === "v1-chat-auto", "path -> tier map covers auto");
}

// Upstream price caps: every chat tier declares a maxPrice catastrophe bound,
// it rides to OpenRouter as provider.max_price on every call (stream included),
// and a buyer-supplied provider object can never replace it.
{
  const chatTiers = Object.entries(TIERS);
  ok(chatTiers.every(([, t]) => t.maxPrice && t.maxPrice.prompt > 0 && t.maxPrice.completion > 0), "every chat tier carries a positive maxPrice bound");

  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-p", model: seen.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }) };
  };
  const nano = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-nano");
  await nano.handler({ model: "deepseek/deepseek-chat", messages: msg1(), max_tokens: 5 });
  ok(seen.provider?.max_price?.prompt === TIERS["v1-chat-nano"].maxPrice.prompt, "non-stream upstream call carries the tier's provider.max_price");

  // A buyer-sent provider object must not replace the cap.
  seen = null;
  await nano.handler({ model: "deepseek/deepseek-chat", messages: msg1(), max_tokens: 5, provider: { max_price: { prompt: 999999, completion: 999999 } } });
  ok(seen.provider?.max_price?.completion === TIERS["v1-chat-nano"].maxPrice.completion, "buyer-supplied provider cannot loosen the cap");

  // Stream path carries it too.
  seen = null;
  globalThis.fetch = async (url, init) => {
    seen = JSON.parse(init.body);
    return { ok: true, status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from("data: [DONE]\n\n"); } } };
  };
  const streamRes = { headersSent: false, writeHead() { this.headersSent = true; }, flushHeaders() {}, write() {}, end() {}, on() {} };
  await (await nano.handler({ model: "deepseek/deepseek-chat", messages: msg1(), stream: true })).__sse(streamRes);
  ok(seen.provider?.max_price?.prompt === TIERS["v1-chat-nano"].maxPrice.prompt, "streamed upstream call carries the tier's provider.max_price");
  ok(seen.usage === undefined, "streams never request usage accounting (cost would ride the buyer's raw SSE)");
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
}

// zdr — zero-data-retention provider routing: the ONE provider field a buyer
// may set. Rides upstream as provider.zdr next to the server-owned max_price
// cap; part of the normalized body so zdr/non-zdr never share a cache entry.
{
  const withZdr = validateRequest({ model: "gpt-4o-mini", messages: msg1(), zdr: true }, "v1-chat");
  ok(withZdr.zdr === true, "top-level zdr:true lands in the normalized body");
  ok(validateRequest({ model: "gpt-4o-mini", messages: msg1(), provider: { zdr: true } }, "v1-chat").zdr === true, "provider.zdr form accepted too");
  ok(validateRequest({ model: "gpt-4o-mini", messages: msg1(), zdr: false }, "v1-chat").zdr === undefined, "zdr:false is a no-op");
  ok(validateRequest({ model: "gpt-4o-mini", messages: msg1(), zdr: "yes" }, "v1-chat").zdr === undefined, "non-boolean zdr never sneaks in");
  ok(promptCacheKey("v1-chat", { model: "gpt-4o-mini", messages: msg1(), zdr: true }) !== promptCacheKey("v1-chat", { model: "gpt-4o-mini", messages: msg1() }),
    "zdr and non-zdr requests get distinct cache entries");

  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-z", model: seen.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }) };
  };
  const nano = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-nano");
  await nano.handler({ model: "deepseek/deepseek-chat", messages: msg1(), max_tokens: 5, provider: { zdr: true, max_price: { prompt: 999999, completion: 999999 } } });
  ok(seen.provider?.zdr === true, "zdr rides upstream as provider.zdr");
  ok(seen.provider?.max_price?.prompt === TIERS["v1-chat-nano"].maxPrice.prompt, "zdr cannot loosen the server-owned price cap");
  ok(!("zdr" in seen) || seen.zdr === undefined, "top-level zdr is stripped from the outbound body");

  seen = null;
  globalThis.fetch = async (url, init) => {
    seen = JSON.parse(init.body);
    return { ok: true, status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from("data: [DONE]\n\n"); } } };
  };
  const streamRes = { headersSent: false, writeHead() { this.headersSent = true; }, flushHeaders() {}, write() {}, end() {}, on() {} };
  await (await nano.handler({ model: "deepseek/deepseek-chat", messages: msg1(), stream: true, zdr: true })).__sse(streamRes);
  ok(seen.provider?.zdr === true && seen.provider?.max_price, "streamed calls carry zdr AND the price cap");

  // Prompt-cache levers (2026-08-19): top-level cache_control rides by
  // default, session_id = the per-buyer id (sticky provider routing so
  // implicit/explicit caches get hit), provider.sort:"price" on the budget
  // tiers only. All call-time: never in the normalized body / cache key.
  const { cacheControlPref, cacheWriteFactor, worstCaseUpstreamCost, validateRequest: vr } = await import("../src/tools/llm-gateway-kit.js");
  ok(JSON.stringify(cacheControlPref({})) === '{"type":"ephemeral"}' && cacheControlPref({ cache_control: false }) === null && cacheControlPref({ cache_control: null }) === null, "cache_control defaults on (ephemeral), false/null turns it off");
  for (const badCc of [{ type: "ephemeral", ttl: "1h" }, { type: "persistent" }, "yes", 1]) {
    let e = null; try { cacheControlPref({ cache_control: badCc }); } catch (x) { e = x; }
    ok(e?.statusCode === 400 && /cache_control/.test(e.message), `cache_control ${JSON.stringify(badCc)} -> self-explaining 400 (${e?.message?.slice(0, 60)})`);
  }
  ok(cacheWriteFactor("anthropic/claude-sonnet-5") === 1.25 && cacheWriteFactor("openai/gpt-4o-mini") === 1 && cacheWriteFactor("deepseek/deepseek-chat") === 1, "cache-write factor: 1.25x on Anthropic input, 1x elsewhere");
  {
    const b = { model: "anthropic/claude-sonnet-5", messages: msg1(), max_tokens: 64 };
    const withCache = worstCaseUpstreamCost(b, TIERS["v1-chat-premium"]);
    const plain = (withCache.inTokens / 1e6) * withCache.cost.prompt;
    // TWO factors, not one. 1.25x is the Anthropic cache-write premium; 1.35x is
    // the newer tokenizer Claude 4.7 and later use, which their own pricing page
    // says produces "approximately 30% more tokens for the same text" than the
    // o200k count this clamp does. Dropping either makes the bound dishonest in
    // the unsafe direction.
    ok(Math.abs(withCache.inUsd - plain * 1.25 * NEW_TOKENIZER_FACTOR) < 1e-12, "worst-case input prices BOTH the cache write (1.25x) and the newer tokenizer (the clamp stays an honest bound)");
    ok(tokenizerFactor("anthropic/claude-sonnet-4.6") === 1 && tokenizerFactor("anthropic/claude-opus-4.1") === 1 && tokenizerFactor("openai/gpt-4o") === 1,
      "models on the OLD tokenizer, and every non-Anthropic model, take no correction");
    ok(tokenizerFactor("anthropic/claude-opus-5") === NEW_TOKENIZER_FACTOR && tokenizerFactor("anthropic/claude-sonnet-5") === NEW_TOKENIZER_FACTOR,
      "Claude 4.7 and later take the newer-tokenizer correction");
  }
  ok(JSON.stringify(vr({ model: "deepseek/deepseek-chat", messages: msg1(), cache_control: false }, "v1-chat-nano")) === JSON.stringify(vr({ model: "deepseek/deepseek-chat", messages: msg1() }, "v1-chat-nano")), "cache_control never reaches the normalized body (same cache key either way)");
  seen = null;
  globalThis.fetch = async (url, init) => {
    seen = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-c", model: seen.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0001, cache_discount: -0.00005 } }) };
  };
  const fakeReqC = { header: (n) => (n === "payment-signature" ? Buffer.from(JSON.stringify({ payload: { authorization: { from: "0xAbCdEf0000000000000000000000000000000001" } } })).toString("base64") : undefined) };
  const outC = await nano.handler({ model: "deepseek/deepseek-chat", messages: msg1(), max_tokens: 5 }, fakeReqC);
  ok(seen.cache_control?.type === "ephemeral" && typeof seen.session_id === "string" && seen.session_id === seen.user && seen.session_id.startsWith("a402:"), `default outbound carries cache_control ephemeral + session_id = the per-buyer id (${seen.session_id?.slice(0, 12)}...)`);
  ok(seen.provider?.sort === "price", "nano (budget tier) asks for the cheapest provider under the cap");
  ok(outC.usage && !("cache_discount" in outC.usage) && !("cost" in outC.usage), "cache_discount is stripped with the other billing fields");
  seen = null;
  await nano.handler({ model: "deepseek/deepseek-chat", messages: msg1(), max_tokens: 5, cache_control: false }, fakeReqC);
  ok(!("cache_control" in seen) || seen.cache_control === undefined, "cache_control:false -> no cache_control upstream");
  seen = null;
  const pro = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-pro");
  await pro.handler({ model: "openai/gpt-4o", messages: msg1(), max_tokens: 5 }, fakeReqC);
  ok(seen.provider?.sort === undefined && seen.provider?.max_price, "pro tier does NOT sort by price (a quantized provider is a buyer-visible quality change); cap still rides");
  process.env.OPENROUTER_PROVIDER_SORT = "off";
  seen = null;
  await nano.handler({ model: "deepseek/deepseek-chat", messages: msg1(), max_tokens: 5 }, fakeReqC);
  ok(seen.provider?.sort === undefined, "OPENROUTER_PROVIDER_SORT=off disables price sort");
  delete process.env.OPENROUTER_PROVIDER_SORT;
  {
    const { createSseUsageScrubber: mkScrub } = await import("../src/tools/llm-gateway-kit.js");
    const sc = mkScrub();
    const line = 'data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0.001,"cache_discount":-0.0002}}\n';
    ok(!sc.push(line).includes("cache_discount"), "stream scrubber strips cache_discount too");
  }

  // Reasoning defaults + wire compat (2026-08-19). Measured live: gpt-5-nano at
  // max_tokens 64/256 with default or "low" effort -> finish_reason "length",
  // EMPTY content (a paid empty answer); "minimal" answered.
  const { validateReasoning, defaultReasoningFor, isEmptyLength, REASONING_MODELS, reasoningProfile } = await import("../src/tools/llm-gateway-kit.js");
  ok(REASONING_MODELS.length >= 6 && REASONING_MODELS.every((r) => (r.id || r.prefix) && Array.isArray(r.efforts) && r.efforts.length), "reasoning table has entries with efforts");
  ok(reasoningProfile("google/gemini-3.5-flash-lite").id === "google/gemini-3.5-flash-lite" && reasoningProfile("google/gemini-3.5-flash").id === "google/gemini-3.5-flash" && reasoningProfile("google/gemini-3.1-flash-lite-image") === null && reasoningProfile("openai/gpt-5-nano:batch")?.id === "openai/gpt-5-nano" && reasoningProfile("openai/gpt-5.6-sol-pro")?.prefix === "openai/gpt-5.6-", "exact-id rows never bleed into sibling models (flash-lite-image), :variants match, family prefix rows match the family");
  ok(JSON.stringify(defaultReasoningFor("openai/gpt-5-nano", "v1-chat-nano")) === '{"effort":"minimal"}' && JSON.stringify(defaultReasoningFor("openai/gpt-5.6-luna", "v1-chat-auto")) === '{"effort":"low"}' && JSON.stringify(defaultReasoningFor("anthropic/claude-sonnet-5", "v1-chat-pro")) === '{"effort":"low"}' && defaultReasoningFor("anthropic/claude-opus-5", "v1-chat-premium") === null && defaultReasoningFor("deepseek/deepseek-chat", "v1-chat-nano") === null, "default effort: budget tiers lowest non-none, pro low, premium model default, non-reasoning models untouched");
  ok(JSON.stringify(validateReasoning({ reasoning_effort: "low" }, TIERS["v1-chat-nano"])) === '{"effort":"low"}' && validateReasoning({}, TIERS["v1-chat-nano"]) === undefined, "reasoning_effort (OpenAI wire) folds into reasoning.effort; absent -> undefined");
  for (const badR of [{ reasoning: { effort: "ultra" } }, { reasoning: { budget: 5 } }, { reasoning: { max_tokens: 99999 } }, { reasoning: "low" }]) {
    let e = null; try { validateReasoning(badR, TIERS["v1-chat-nano"]); } catch (x) { e = x; }
    ok(e?.statusCode === 400 && /reasoning/.test(e.message), `reasoning ${JSON.stringify(badR.reasoning)} -> self-explaining 400 (${e?.message?.slice(0, 50)})`);
  }
  ok(vr({ model: "deepseek/deepseek-chat", messages: msg1(), max_completion_tokens: 77 }, "v1-chat-nano").max_tokens === 77, "max_completion_tokens (newer OpenAI SDKs) is honoured as the output cap");
  ok(promptCacheKey("v1-chat-nano", { model: "openai/gpt-5-nano", messages: msg1(), reasoning: { effort: "high" } }) !== promptCacheKey("v1-chat-nano", { model: "openai/gpt-5-nano", messages: msg1() }), "a buyer reasoning preference is part of the cache key (it changes the answer)");
  // outbound: default injected per link, buyer preference wins, non-reasoning link carries none
  seen = null;
  const seenAll = [];
  globalThis.fetch = async (url, init) => {
    seen = JSON.parse(init.body); seenAll.push(seen);
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-r", model: seen.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
  await nano.handler({ model: "openai/gpt-5-nano", messages: msg1(), max_tokens: 64 }, fakeReqC);
  ok(seen.reasoning?.effort === "minimal", "gpt-5-nano on nano gets reasoning.effort minimal by default");
  await nano.handler({ model: "openai/gpt-5-nano", messages: msg1(), max_tokens: 64, reasoning: { effort: "high", exclude: true } }, fakeReqC);
  ok(seen.reasoning?.effort === "high" && seen.reasoning?.exclude === true, "a buyer reasoning object rides through unchanged");
  await nano.handler({ model: "deepseek/deepseek-chat", messages: msg1(), max_tokens: 64 }, fakeReqC);
  ok(seen.reasoning === undefined && seen.plugins === undefined && seen.provider?.require_parameters === undefined, "non-reasoning, unstructured call: no reasoning, no plugins, no require_parameters");
  const rf = { type: "json_schema", json_schema: { name: "a", strict: true, schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"], additionalProperties: false } } };
  await nano.handler({ model: "deepseek/deepseek-chat", messages: msg1(), max_tokens: 64, response_format: rf }, fakeReqC);
  ok(seen.provider?.require_parameters === true && JSON.stringify(seen.plugins) === '[{"id":"response-healing"}]' && seen.provider?.max_price, "json_schema: require_parameters + response-healing plugin (cap still rides)");
  seen = null;
  await (await nano.handler({ model: "deepseek/deepseek-chat", messages: msg1(), response_format: rf, stream: true }, fakeReqC)).__sse({ headersSent: false, writeHead() { this.headersSent = true; }, flushHeaders() {}, write() {}, end() {}, on() {} }).catch(() => {});
  ok(seen && seen.provider?.require_parameters === true && seen.plugins === undefined, "streamed json_schema: require_parameters yes, response-healing (non-stream only) no");
  // paid-empty guard: "length" + empty content walks the chain; end-to-end empty -> 502
  ok(isEmptyLength({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "" } }] }) && !isEmptyLength({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }) && !isEmptyLength({ choices: [{ finish_reason: "stop", message: { content: "" } }] }), "isEmptyLength: only length + nothing said");
  seenAll.length = 0;
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body); seenAll.push(b.model);
    const empty = b.model === "openai/gpt-5-nano";
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-e", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: empty ? "" : "answer" }, finish_reason: empty ? "length" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 64, completion_tokens_details: { reasoning_tokens: empty ? 64 : 0 } } }) };
  };
  const outE = await nano.handler({ model: "openai/gpt-5-nano", messages: msg1(), max_tokens: 64 }, fakeReqC);
  ok(outE.choices[0].message.content === "answer" && JSON.stringify(seenAll) === JSON.stringify(["openai/gpt-5-nano", "deepseek/deepseek-chat"]), `a length+empty answer is never served: the chain walked on, and the same model's default-tier retry was skipped (tried ${seenAll.join(" -> ")})`);
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-e2", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 64 } }) };
  };
  await nano.handler({ model: "openai/gpt-5-nano", messages: msg1(), max_tokens: 64 }, fakeReqC).then(
    () => ok(false, "an end-to-end empty chain must not serve"),
    (e) => ok(e.statusCode === 502 && /no content within the output cap/.test(e.message), `chain empty end-to-end -> 502 (settlement cancelled), self-explaining (${e.message.slice(0, 60)})`),
  );
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
}

// Tools guard — only OpenAI function tools pass. OpenRouter's server-side
// tool types (openrouter:subagent delegates to up to 10 worker models billed
// at their own rates; openrouter:advisor consults pricier models) create
// upstream spend bounded by neither max_tokens nor provider.max_price, so a
// buyer smuggling one through the verbatim `tools` passthrough would buy
// work the flat per-call price never covered. The guard is proven at the
// HANDLER (the caller path), not only on validateRequest — a green
// validateRequest test alone could hide a handler that skips validation.
{
  const fnTool = { type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } };
  const v = validateRequest({ model: "gpt-4o-mini", messages: msg1(), tools: [fnTool] }, "v1-chat");
  ok(Array.isArray(v.tools) && v.tools[0].function.name === "get_weather", "function tools still pass through verbatim");
  throws(() => validateRequest({ model: "gpt-4o-mini", messages: msg1(), tools: [{ type: "openrouter:subagent" }] }, "v1-chat"), "openrouter:*", "openrouter:subagent rejected with the reason");
  throws(() => validateRequest({ model: "gpt-4o-mini", messages: msg1(), tools: [{ type: "openrouter:advisor" }] }, "v1-chat"), "function", "openrouter:advisor rejected, error names the accepted shape");
  throws(() => validateRequest({ model: "gpt-4o-mini", messages: msg1(), tools: [fnTool, { type: "openrouter:subagent" }] }, "v1-chat"), "openrouter:*", "one bad entry poisons the whole array - no partial acceptance");
  throws(() => validateRequest({ model: "gpt-4o-mini", messages: msg1(), tools: [{ type: "function" }] }, "v1-chat"), "function", "type:function without a function object rejected");
  throws(() => validateRequest({ model: "gpt-4o-mini", messages: msg1(), tools: "web" }, "v1-chat"), "array", "non-array tools rejected");
  throws(() => validateRequest({ model: "gpt-4o-mini", messages: msg1(), tools: [] }, "v1-chat"), "non-empty", "empty tools array rejected, not silently passed");

  // tool_choice mirrors the guard - only the OpenAI wire shapes pass.
  for (const good of ["none", "auto", "required"]) {
    ok(validateRequest({ model: "gpt-4o-mini", messages: msg1(), tools: [fnTool], tool_choice: good }, "v1-chat").tool_choice === good, `tool_choice "${good}" passes`);
  }
  ok(validateRequest({ model: "gpt-4o-mini", messages: msg1(), tools: [fnTool], tool_choice: { type: "function", function: { name: "get_weather" } } }, "v1-chat").tool_choice.function.name === "get_weather", "named function tool_choice passes");
  throws(() => validateRequest({ model: "gpt-4o-mini", messages: msg1(), tools: [fnTool], tool_choice: { type: "openrouter:subagent" } }, "v1-chat"), "tool_choice", "server-tool tool_choice rejected");
  throws(() => validateRequest({ model: "gpt-4o-mini", messages: msg1(), tools: [fnTool], tool_choice: "any" }, "v1-chat"), "tool_choice", "unknown string tool_choice rejected");
  throws(() => validateRequest({ model: "gpt-4o-mini", messages: msg1(), tools: [fnTool], tool_choice: { type: "function" } }, "v1-chat"), "tool_choice", "function tool_choice without a name rejected");

  // Caller path: the handler must refuse BEFORE any upstream fetch.
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("unexpected upstream fetch"); };
  const base = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat");
  try {
    await base.handler({ model: "gpt-4o-mini", messages: msg1(), tools: [{ type: "openrouter:subagent" }] });
    ok(false, "handler accepted a server-side tool type");
  } catch (e) {
    ok(e.statusCode === 400 && String(e.message).includes("openrouter:*"), `handler 400s on server-side tools (got ${e.statusCode}: ${String(e.message).slice(0, 60)})`);
  }
  ok(fetches === 0, "...and made zero upstream fetches doing it");
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
}

// Refusal walk — a safety-classifier refusal is an HTTP 200 with no content
// (Claude 5-class models via OpenRouter). The chain must walk it like a
// provider error; a refusal WITH partial content is served as-is; a chain
// that refuses end-to-end surfaces 502 (settlement cancelled - nobody pays
// for an empty answer).
{
  const refusal = (model) => JSON.stringify({ id: "gen-r", model, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter", native_finish_reason: "refusal" }] });
  ok(isEmptyRefusal(JSON.parse(refusal("m"))), "empty content_filter/refusal detected");
  ok(!isEmptyRefusal({ choices: [{ message: { content: "partial answer" }, finish_reason: "content_filter" }] }), "refusal WITH content is not walkable - the buyer gets the partial");
  ok(!isEmptyRefusal({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }), "empty content with a normal finish_reason is not a refusal");
  ok(!isEmptyRefusal({ choices: [{ message: { content: "", tool_calls: [{ id: "t1" }] }, finish_reason: "content_filter" }] }), "tool_calls count as content");

  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    if (calls.length === 1) return { ok: true, status: 200, text: async () => refusal(body.model) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-s", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }) };
  };
  const auto = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-auto");
  const served = await auto.handler({ messages: [{ role: "user", content: "hello" }], max_tokens: 5 });
  ok(calls.length === 2 && served.choices[0].message.content === "OK", `refusal walks the chain and the next model serves (${calls.join(" -> ")})`);

  // Whole chain refuses -> 502, never a paid empty 200.
  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    return { ok: true, status: 200, text: async () => refusal(body.model) };
  };
  try {
    await auto.handler({ messages: [{ role: "user", content: "hello" }], max_tokens: 5 });
    ok(false, "all-refused chain returned a 200");
  } catch (e) {
    ok(e.statusCode === 502 && String(e.message).includes("safety"), `all-refused chain surfaces 502 after walking every link (${calls.length} links tried)`);
  }
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
}

// Margin telemetry: non-stream calls request OpenRouter usage accounting, the
// exact upstream cost is captured for the operator and STRIPPED before the
// response reaches the buyer (or the prompt cache).
{
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = JSON.parse(init.body);
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        id: "gen-u", model: seen.model,
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.00042, cost_details: { upstream_inference_cost: 0.0004 }, is_byok: false },
      }),
    };
  };
  const nano = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-nano");
  const out = await nano.handler({ model: "deepseek/deepseek-chat", messages: msg1(), max_tokens: 5, cache: true });
  ok(seen.usage?.include === true, "non-stream upstream call requests usage accounting");
  ok(out.usage.prompt_tokens === 10 && out.usage.total_tokens === 15, "standard token counts still reach the buyer");
  ok(out.usage.cost === undefined && out.usage.cost_details === undefined && out.usage.is_byok === undefined, "upstream cost never reaches the buyer");
  const cached = promptCacheGet(promptCacheKey("v1-chat-nano", { model: "deepseek/deepseek-chat", messages: msg1(), max_tokens: 5, cache: true }));
  ok(cached && cached.usage.cost === undefined, "the cached copy is the sanitized one");
  const { _testEventsForTest } = await import("../src/posthog.js");
  const ev = _testEventsForTest().filter((e) => e.event === "gateway_usage").pop();
  ok(ev?.properties.upstreamUsd === 0.00042 && ev?.properties.tier === "v1-chat-nano", "gateway_usage event carries the exact upstream cost");
  ok(ev?.properties.priceUsd === TIERS["v1-chat-nano"].price && Math.abs(ev.properties.marginUsd - (0.003 - 0.00042)) < 1e-9, "event pairs price with cost → margin");
  ok(ev?.properties.upstreamReported === true && ev?.properties.promptTokens === 10, "token volume and reporting flag captured");
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
}

// /v1/embeddings — wire-path validation, default model, batching caps,
// default-ON cache (deterministic output), and the wire-shape passthrough.
{
  ok(EMBEDDINGS_PATH === "/v1/embeddings", "embeddings path constant");
  const v = validateEmbeddingsRequest({ input: "hello" });
  ok(v.model === "text-embedding-3-small", "model defaults to text-embedding-3-small");
  ok(Array.isArray(v.input) && v.input.length === 1 && v.input[0] === "hello", "string input normalizes to a one-item array");
  ok(validateEmbeddingsRequest({ input: "x", model: "openai/text-embedding-3-large" }).model === "text-embedding-3-large", "openai/ prefix accepted and stripped");
  ok(validateEmbeddingsRequest({ input: ["a", "b"], dimensions: 256 }).dimensions === 256, "dimensions passes through");
  throws(() => validateEmbeddingsRequest({ input: "x", model: "text-embedding-9000" }), "must be one of", "off-allowlist model rejected");
  throws(() => validateEmbeddingsRequest({ model: "text-embedding-3-small" }), "required", "missing input rejected");
  throws(() => validateEmbeddingsRequest({ input: [] }), "required", "empty array rejected");
  throws(() => validateEmbeddingsRequest({ input: ["a", 42] }), "non-empty string", "non-string item rejected");
  throws(() => validateEmbeddingsRequest({ input: Array.from({ length: 65 }, () => "x") }), "Too many inputs", "item-count cap enforced");
  throws(() => validateEmbeddingsRequest({ input: "x".repeat(17_000) }), "Input too large", "char cap enforced");
  throws(() => validateEmbeddingsRequest({ input: "x", model: "text-embedding-ada-002", dimensions: 256 }), "not supported", "dimensions rejected on ada-002");
  throws(() => validateEmbeddingsRequest({ input: "x", encoding_format: "hex" }), "encoding_format", "bad encoding_format rejected");

  // Cache policy: DEFAULT-ON, cache:false opts out, keys are normalized.
  const k1 = embeddingsCacheKey({ input: "same text" });
  const k2 = embeddingsCacheKey({ input: ["same text"], model: "openai/text-embedding-3-small" });
  ok(k1 && k1 === k2, "string vs [string] vs explicit-default-model collapse to one cache key");
  ok(embeddingsCacheKey({ input: "same text", cache: false }) === null, "cache:false opts out (returns null)");
  ok(embeddingsCacheKey({ input: "same text", model: "text-embedding-3-large" }) !== k1, "model changes the key");
  ok(embeddingsCacheKey({ input: "same text", dimensions: 256 }) !== k1, "dimensions change the key");

  // Handler: 503 without the key; upstream body carries the normalized
  // request; success is stored under the default-on cache key.
  const embed = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-embeddings");
  delete process.env.OPENAI_API_KEY;
  await embed.handler({ input: "hi" }).then(
    () => ok(false, "embeddings handler without key must throw"),
    (e) => ok(e.statusCode === 503, `embeddings handler without key throws 503 (got ${e.statusCode})`)
  );
  process.env.OPENAI_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  let upstreamBody = null, authHeader = null;
  globalThis.fetch = async (url, init) => {
    upstreamBody = JSON.parse(init.body);
    authHeader = init.headers.Authorization;
    ok(String(url).includes("api.openai.com/v1/embeddings"), "embeddings go to the OpenAI upstream");
    return { ok: true, status: 200, text: async () => JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], model: upstreamBody.model, usage: { prompt_tokens: 2, total_tokens: 2 } }) };
  };
  const out = await embed.handler({ input: "cache me by default" });
  ok(out.object === "list" && Array.isArray(out.data[0].embedding), "OpenAI wire shape passes through untouched");
  ok(authHeader === "Bearer test-key", "upstream call carries the OpenAI bearer");
  ok(upstreamBody.model === "text-embedding-3-small" && Array.isArray(upstreamBody.input), "upstream body is the normalized request");
  ok(upstreamBody.cache === undefined, "cache flag never rides to the upstream");
  ok(promptCacheGet(embeddingsCacheKey({ input: "cache me by default" }))?.object === "list", "success stored WITHOUT any opt-in (default-on)");
  await embed.handler({ input: "do not cache me", cache: false });
  ok(promptCacheGet(embeddingsCacheKey({ input: "do not cache me" })) === null, "cache:false skips the store");
  globalThis.fetch = realFetch;
  delete process.env.OPENAI_API_KEY;
}

// Margin clamp: every request is priced before it goes upstream — max_tokens
// shrinks so input + output can never exceed MARGIN × tier price for the
// actual model requested. This closes the flat-price/metered-upstream
// arbitrage on the pricey families (opus, o3-pro) without touching cheap ones.
{
  const { costFor } = await import("../src/tools/llm-gateway-kit.js");
  ok(costFor("claude-opus-4")?.completion === 75, "costFor resolves opus by prefix (bare name canonicalized)");
  ok(costFor("openai/o3-pro-2026")?.prompt === 20, "longest prefix wins (o3-pro, not o3)");
  ok(costFor("acme/unknown-model") === null, "unknown family → null (callers fall back to the tier max_price bound)");

  const ascii = "The quick brown fox jumps over the lazy dog. ".repeat(1300); // ~58k chars
  const opusFull = validateRequest({ model: "anthropic/claude-opus-4", messages: msg1(ascii), max_tokens: 8192 }, "v1-chat-premium");
  ok(opusFull.max_tokens < 8192 && opusFull.max_tokens >= 64, `opus at full input is clamped below the tier cap (got ${opusFull.max_tokens})`);
  const gpt5Full = validateRequest({ model: "gpt-5", messages: msg1(ascii), max_tokens: 8192 }, "v1-chat-premium");
  ok(gpt5Full.max_tokens === 8192, "a cheap frontier model with the same input keeps the full tier cap");

  // Worst-case arithmetic: the clamped opus request must cost under the price.
  const worstUsd = (58_500 / 3 / 1e6) * 15 + (opusFull.max_tokens / 1e6) * 75;
  ok(worstUsd < 0.5, `clamped opus worst case stays under the $0.50 price (est $${worstUsd.toFixed(3)})`);

  // Token-dense text is priced by TOKENS, not chars — CJK that fits the char
  // cap but busts the token budget is rejected, not silently served at a loss.
  throws(() => validateRequest({ model: "anthropic/claude-opus-4", messages: msg1("漢字".repeat(15_000)), max_tokens: 8192 }, "v1-chat-premium"), "too large", "CJK token-density arbitrage → self-explaining 400");
  const asciiSame = validateRequest({ model: "anthropic/claude-opus-4", messages: msg1("a".repeat(30_000)), max_tokens: 8192 }, "v1-chat-premium");
  ok(asciiSame.max_tokens >= 64, "the same char count in ASCII still serves (tokens are what's priced)");

  // A giant tool schema is input too — it must tighten the clamp.
  const bigTools = [{ type: "function", function: { name: "f", parameters: { description: "x".repeat(40_000) } } }];
  const withTools = validateRequest({ model: "anthropic/claude-opus-4", messages: msg1(), max_tokens: 8192, tools: bigTools }, "v1-chat-premium");
  const withoutTools = validateRequest({ model: "anthropic/claude-opus-4", messages: msg1(), max_tokens: 8192 }, "v1-chat-premium");
  ok(withTools.max_tokens < withoutTools.max_tokens, "tool schemas count as priced input");

  // n multiplies output cost: bounded, and priced into the clamp.
  throws(() => validateRequest({ model: "gpt-4o-mini", messages: msg1(), n: 9 }, "v1-chat"), "between 1 and 4", "n is bounded at 4");
  const n1 = validateRequest({ model: "anthropic/claude-opus-4", messages: msg1("write a poem"), max_tokens: 8192 }, "v1-chat-premium");
  const n4 = validateRequest({ model: "anthropic/claude-opus-4", messages: msg1("write a poem"), max_tokens: 8192, n: 4 }, "v1-chat-premium");
  ok(n4.max_tokens <= Math.ceil(n1.max_tokens / 4) + 1, `n=4 tightens the per-completion clamp ~4x (${n1.max_tokens} → ${n4.max_tokens})`);

  // Determinism: the clamp is part of the normalized body, so the prompt-cache
  // key must be identical across repeat validations.
  const again = validateRequest({ model: "anthropic/claude-opus-4", messages: msg1(ascii), max_tokens: 8192 }, "v1-chat-premium");
  ok(again.max_tokens === opusFull.max_tokens, "clamp is deterministic (cache keys stay stable)");

  // Cheap tiers keep today's behavior: the tier's own cap is the binding one.
  const nanoBody = validateRequest({ model: "gpt-5-nano", messages: msg1(), max_tokens: 768 }, "v1-chat-nano");
  ok(nanoBody.max_tokens === 768, "nano-tier small input is untouched by the margin clamp");
}

// /v1/images/generations — OpenAI images wire over OpenRouter chat modalities.
// Cost knobs are server-owned: model locked, n locked to 1, max_tokens and
// provider.max_price bound the upstream bill.
{
  const { validateImagesRequest, IMAGES_PATH, LLM_GATEWAY_TOOLS: tools } = await import("../src/tools/llm-gateway-kit.js");
  ok(IMAGES_PATH === "/v1/images/generations", "images path constant");
  const imagesTool = tools.find((t) => t.slug === "v1-images");
  ok(imagesTool && imagesTool.route === "POST /v1/images/generations" && imagesTool.price === "$0.080", "images tool registered at the OpenAI wire path");

  ok(validateImagesRequest({ prompt: "a fox" }).prompt === "a fox", "prompt-only request validates");
  ok(validateImagesRequest({ prompt: "a fox", model: "gemini-2.5-flash-image" }).prompt === "a fox", "the locked model id is accepted (bare form canonicalized)");
  throws(() => validateImagesRequest({}), '"prompt" is required', "missing prompt rejected");
  throws(() => validateImagesRequest({ prompt: "x".repeat(5000) }), "Prompt too long", "prompt cap enforced");
  throws(() => validateImagesRequest({ prompt: "a fox", model: "dall-e-3" }), "fixed to", "other models rejected with the locked id");
  throws(() => validateImagesRequest({ prompt: "a fox", n: 2 }), "locked to 1", "n>1 rejected — output cost is metered");
  throws(() => validateImagesRequest({ prompt: "a fox", response_format: "url" }), "b64_json", "url response_format rejected (images are inline)");
  ok(validateImagesRequest({ prompt: "a fox", size: "1024x1024", quality: "hd" }).prompt === "a fox", "cost-neutral OpenAI params (size/quality) are ignored, not rejected");

  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const PNG_B64 = Buffer.from("fake-png-bytes".repeat(4)).toString("base64");
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = JSON.parse(init.body);
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        id: "gen-i", model: seen.model,
        choices: [{ index: 0, message: { role: "assistant", content: "", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } }] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 14, completion_tokens: 1290, total_tokens: 1304, cost: 0.039, cost_details: {}, is_byok: false, cache_discount: 0 },
      }),
    };
  };
  const out = await imagesTool.handler({ prompt: "a fox", zdr: true });
  ok(seen.model === "google/gemini-2.5-flash-image" && Array.isArray(seen.modalities) && seen.modalities.includes("image"), "upstream call is chat-shaped with image modality and the locked model");
  ok(seen.service_tier === "flex", "images try the flex tier first (half price on this model's endpoints)");
  ok(seen.max_tokens === 1600 && seen.provider?.max_price?.completion === 35, "upstream response is token- and price-bounded");
  ok(seen.provider?.zdr === true, "zdr folds into the images provider prefs too");
  ok(seen.usage?.include === true, "images calls request usage accounting");
  ok(out.data[0].b64_json === PNG_B64 && out.data[0].media_type === "image/png" && typeof out.created === "number", "data URI translated to the OpenAI images shape");
  ok(out.usage.cost === undefined && out.usage.cost_details === undefined && out.usage.is_byok === undefined && out.usage.cache_discount === undefined, "upstream cost (incl. is_byok + cache_discount) stripped from the images response");
  const { _testEventsForTest } = await import("../src/posthog.js");
  const ev = _testEventsForTest().filter((e) => e.event === "gateway_usage").pop();
  ok(ev?.properties.tier === "v1-images" && ev?.properties.upstreamUsd === 0.039 && ev?.properties.priceUsd === 0.08, "images margin telemetry captured");
  ok(ev?.properties.serviceTier === "flex", "telemetry records which service tier served");

  // Flex has no capacity (or returns no image) → the SAME model is retried on
  // the default tier before anyone sees a 502.
  const tiersTried = [];
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body); tiersTried.push(b.service_tier || "default");
    if (b.service_tier === "flex") return { ok: false, status: 503, text: async () => "flex capacity" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-i3", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: "", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } }] }, finish_reason: "stop" }], usage: { prompt_tokens: 14, completion_tokens: 1290, total_tokens: 1304, cost: 0.078 } }) };
  };
  const out2 = await imagesTool.handler({ prompt: "a fox" });
  ok(tiersTried.join(",") === "flex,default" && out2.data.length === 1, `flex capacity error → default-tier retry on the same model (tried ${tiersTried.join(",")})`);
  const ev2 = _testEventsForTest().filter((e) => e.event === "gateway_usage").pop();
  ok(ev2?.properties.serviceTier === "default", "telemetry records the default tier when flex was unavailable");

  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-i2", model: "x", choices: [{ index: 0, message: { role: "assistant", content: "no can do" }, finish_reason: "stop" }] }) });
  await imagesTool.handler({ prompt: "a fox" }).then(
    () => ok(false, "an imageless upstream response must not serve"),
    (e) => ok(e.statusCode === 502 && /no image/i.test(e.message), "imageless upstream response (both tiers) → 502")
  );
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
}

// Grounded tier (2026-08-19) - the auto router + OpenRouter's web plugin on
// every call. Search is billed per REQUEST (measured: Exa auto $0.007 in
// usage.cost, ~700 injected prompt tokens per result), so the tier carries it
// as fixedUpstreamUsd + extraInputTokens in the clamp; never cached.
{
  const { worstCaseUpstreamCost, promptCacheKey: pck, MARGIN } = await import("../src/tools/llm-gateway-kit.js");
  const g = TIERS["v1-chat-grounded"];
  const grounded = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-grounded");
  ok(grounded && grounded.route === "POST /v1/grounded/chat/completions" && grounded.price === "$0.03" && g.router === true && g.web?.id === "web" && g.noCache === true, "grounded tier registered: router, web plugin, no cache, $0.03");
  const wc = worstCaseUpstreamCost({ model: "openai/gpt-4o-mini", messages: msg1(), max_tokens: 1024 }, g);
  const plain = worstCaseUpstreamCost({ model: "openai/gpt-4o-mini", messages: msg1(), max_tokens: 1024 }, TIERS["v1-chat-auto"]);
  ok(wc.fixedUsd === 0.007 && wc.inTokens - plain.inTokens === 4500 && wc.totalUsd > plain.totalUsd + 0.007, "worst-case cost on the grounded tier adds the search fee and the injected-result tokens");
  const big = worstCaseUpstreamCost({ model: "google/gemini-2.5-flash", messages: [{ role: "user", content: "x ".repeat(8000) }], max_tokens: 1024 }, g);
  ok(big.totalUsd <= g.price * MARGIN, `largest grounded call (16k chars in on the priciest ranked model, 1024 out, 5 results) stays under the 70% bound (${big.totalUsd.toFixed(5)} <= ${(g.price * MARGIN).toFixed(5)})`);
  ok(pck("v1-chat-grounded", { messages: msg1(), cache: true }) === null, "grounded answers are never cacheable (the web moves)");
  ok(tierFor("openai/gpt-4o-mini") === "v1-chat" && tierFor("google/gemini-2.5-flash") !== "v1-chat-grounded", "grounded is listed last: explicit models still resolve to their home tiers");
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => { seen = JSON.parse(init.body); return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-g", model: seen.model, choices: [{ index: 0, message: { role: "assistant", content: "Node 24 [1]", annotations: [{ type: "url_citation", url_citation: { url: "https://nodejs.org", title: "Node.js" } }] }, finish_reason: "stop" }], usage: { prompt_tokens: 1987, completion_tokens: 47, cost: 0.0072175 } }) }; };
  const gout = await grounded.handler({ messages: msg1(), max_tokens: 64 }, { header: () => undefined });
  ok(JSON.stringify(seen.plugins) === '[{"id":"web","engine":"exa","max_results":5}]' && seen.provider?.sort === "price" && seen.provider?.max_price, "grounded outbound carries the web plugin (exa, 5 results) next to the server-owned provider prefs");
  ok(gout.agent402_router?.category === "general" && Array.isArray(gout.choices[0].message.annotations) && !("cost" in gout.usage), "grounded reply keeps url_citation annotations, discloses the router, strips cost");
  await grounded.handler({ messages: msg1(), max_tokens: 64, response_format: { type: "json_object" } }, { header: () => undefined });
  ok(seen.plugins.length === 2 && seen.plugins[0].id === "web" && seen.plugins[1].id === "response-healing", "web + response-healing plugins merge for structured output");
  let e = null; try { validateRequest({ model: "openai/gpt-4o-mini:online", messages: msg1() }, "v1-chat"); } catch (x) { e = x; }
  ok(e?.statusCode === 400 && /:online/.test(e.message), ":online stays refused on the other tiers (the grounded tier is the sanctioned home)");
  // Every attempt re-runs the $0.007 search, so the grounded chain is capped
  // at two attempts (cost audit 2026-08-19): a chain failing end-to-end costs
  // at most $0.014 in search fees, not 8 x $0.007.
  let tries = 0;
  globalThis.fetch = async () => { tries++; return { ok: false, status: 503, text: async () => JSON.stringify({ error: { message: "capacity" } }) }; };
  let ge = null; try { await grounded.handler({ messages: msg1(), max_tokens: 64 }, { header: () => undefined }); } catch (x) { ge = x; }
  ok(g.maxAttempts === 2 && tries === 2 && ge?.statusCode === 502, `grounded chain makes at most 2 upstream attempts on failure (made ${tries}, surfaced ${ge?.statusCode})`);
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
}

// /v1/rerank (2026-08-19) - Cohere wire over OpenRouter's /rerank, one locked
// model, caps that keep every call at exactly one Cohere search unit ($0.001
// upstream vs $0.002 price), default-on cache (deterministic ranker), billing
// fields stripped, telemetry captured.
{
  const { validateRerankRequest, rerankCacheKey, RERANK_MODEL, RERANK_PRICE, RERANK_PATH } = await import("../src/tools/llm-gateway-kit.js");
  const rerank = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-rerank");
  ok(rerank && rerank.route === "POST /v1/rerank" && rerank.price === "$0.002" && RERANK_PATH === "/v1/rerank" && RERANK_PRICE === 0.002, "v1-rerank tool registered at POST /v1/rerank, $0.002");
  const good = validateRerankRequest({ query: "capital of France?", documents: ["Paris", "Berlin", "Madrid"], top_n: 10 });
  ok(validateRerankRequest({ query: "q".repeat(400), documents: Array.from({ length: 25 }, () => "english words repeated ".repeat(68)) }).documents.length === 25, "rerank: 25 x ~1,560 chars of English (39k total) at the query cap is still one search unit (accepted)");
  ok(good.model === RERANK_MODEL && good.top_n === 3 && good.documents.length === 3, "valid body: model locked, top_n clamped to the document count");
  for (const [label, body] of [
    ["no query", { documents: ["a"] }],
    ["empty docs", { query: "q", documents: [] }],
    ["51 docs", { query: "q", documents: Array.from({ length: 51 }, (_, i) => `d${i}`) }],
    ["1601-char doc", { query: "q", documents: ["x".repeat(1601)] }],
    ["501-char query", { query: "q".repeat(501), documents: ["a"] }],
    ["structured doc", { query: "q", documents: [{ text: "a" }] }],
    ["other model", { query: "q", documents: ["a"], model: "cohere/rerank-english-v3.0" }],
    ["bad top_n", { query: "q", documents: ["a"], top_n: 0 }],
    ["too many chars total", { query: "q", documents: Array.from({ length: 30 }, () => "y".repeat(1500)) }],
    // Under every char cap (26 x 1,500 = 39,000) but CJK tokenizes ~1/char:
    // 26 x 4 chunks = 104 chunks -> a second search unit upstream.
    ["over one search unit (CJK tokens)", { query: "問題", documents: Array.from({ length: 26 }, () => "漢".repeat(1500)) }],
  ]) {
    let e = null; try { validateRerankRequest(body); } catch (x) { e = x; }
    ok(e?.statusCode === 400, `rerank ${label} -> 400 (${e?.message?.slice(0, 60)})`);
  }
  ok(rerankCacheKey({ query: "q", documents: ["b", "a"] }) === rerankCacheKey({ documents: ["b", "a"], query: "q" }) && rerankCacheKey({ query: "q", documents: ["a", "b"] }) !== rerankCacheKey({ query: "q", documents: ["b", "a"] }) && rerankCacheKey({ query: "q", documents: ["a"], cache: false }) === null, "cache key: field order collapses, document order matters, cache:false opts out");
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-rerank-1", model: "rerank-v3.5", results: [{ index: 0, relevance_score: 0.9, document: { text: "Paris" } }], usage: { search_units: 1, cost: 0.001 }, provider: "Cohere" }) };
  };
  const fakeReqR = { header: (n) => (n === "payment-signature" ? Buffer.from(JSON.stringify({ payload: { authorization: { from: "0xAbCdEf0000000000000000000000000000000002" } } })).toString("base64") : undefined) };
  const out = await rerank.handler({ query: "capital of France?", documents: ["Paris", "Berlin"], top_n: 1 }, fakeReqR);
  ok(seen.url.endsWith("/api/v1/rerank") && seen.body.model === RERANK_MODEL && seen.body.top_n === 1 && typeof seen.body.user === "string" && seen.body.user.startsWith("a402:"), "upstream call hits /rerank with the locked model, top_n and the per-buyer user id");
  ok(Array.isArray(out.results) && out.results[0].relevance_score === 0.9 && out.usage.search_units === 1 && !("cost" in out.usage), "Cohere-wire result passes through; usage.cost stripped, search_units kept");
  ok(Array.isArray(fakeReqR.__deferredCache) && fakeReqR.__deferredCache.length === 1, "result is queued for the post-settlement cache commit (default-on)");
  {
    const { _testEventsForTest } = await import("../src/posthog.js");
    await new Promise((r) => setTimeout(r, 20));
    const ev = _testEventsForTest().filter((e) => e.event === "gateway_usage").pop();
    ok(ev?.properties.tier === "v1-rerank" && ev?.properties.upstreamUsd === 0.001 && ev?.properties.priceUsd === 0.002, "rerank margin telemetry captured ($0.001 vs $0.002)");
  }
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => "down" });
  await rerank.handler({ query: "q", documents: ["a"] }).then(() => ok(false, "upstream 503 must not serve"), (e) => ok(e.statusCode === 502, "upstream 5xx -> 502 (settlement cancelled)"));
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
}

// Gateway credits status — the low-balance alarm feed. Bucketed statuses
// only (no numbers leak), fail-safe "unknown" on upstream trouble, and a
// cache so the public endpoint can't hammer OpenRouter through us.
{
  const { gatewayCreditsStatus } = await import("../src/tools/llm-gateway-kit.js");
  delete process.env.OPENROUTER_API_KEY;
  const un = await gatewayCreditsStatus();
  ok(un.configured === false && un.status === "unconfigured", "no key → unconfigured, no fetch");

  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_LOW_CREDITS_USD = "5";
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return { ok: true, status: 200, json: async () => ({ data: { total_credits: 20, total_usage: 17.5 } }) };
  };
  const low = await gatewayCreditsStatus();
  ok(low.status === "low" && low.configured === true, `$2.50 remaining under a $5 mark → low (got ${low.status})`);
  ok(!JSON.stringify(low).match(/\d\.\d|20|17/), "no balance numbers in the public payload");
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { total_credits: 100, total_usage: 1 } }) });
  const cached = await gatewayCreditsStatus();
  ok(cached.status === "low" && fetches === 2, "result is cached — the endpoint can't be used to hammer OpenRouter (one read per leg)");
  // Second ceiling: the key's own USD limit. Credits fine, limit nearly spent → low.
  const { _resetCreditsCacheForTest } = await import("../src/tools/llm-gateway-kit.js");
  _resetCreditsCacheForTest();
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).endsWith("/key")
    ? { data: { label: "k", limit: 250, limit_remaining: 40, limit_reset: "monthly" } }
    : { data: { total_credits: 100, total_usage: 1 } }) });
  const keyLow = await gatewayCreditsStatus();
  ok(keyLow.status === "low" && keyLow.credits === "ok" && keyLow.keyLimit === "low", `key limit under 25% remaining → low even with a healthy balance (got ${JSON.stringify(keyLow)})`);
  ok(!JSON.stringify(keyLow).match(/250|40|100/), "no limit numbers in the public payload");
  _resetCreditsCacheForTest();
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).endsWith("/key")
    ? { data: { label: "k", limit: 250, limit_remaining: 200 } }
    : { data: { total_credits: 100, total_usage: 1 } }) });
  const bothOk = await gatewayCreditsStatus();
  ok(bothOk.status === "ok" && bothOk.unknownForMinutes === undefined, "both legs healthy → ok, no unknown duration");
  // Balance unreadable but key readable: NOT ok (the key cannot vouch for the
  // balance) - unknown, with a duration the heartbeat can page on.
  _resetCreditsCacheForTest();
  globalThis.fetch = async (url) => (String(url).endsWith("/key")
    ? { ok: true, status: 200, json: async () => ({ data: { label: "k", limit: 250, limit_remaining: 200 } }) }
    : { ok: false, status: 401, json: async () => ({}) });
  const unk = await gatewayCreditsStatus();
  ok(unk.status === "unknown" && unk.credits === "unknown" && unk.keyLimit === "ok" && unk.unknownForMinutes === 0, `unreadable balance → unknown with unknownForMinutes (got ${JSON.stringify(unk)})`);
  // Management key: the documented credential for /credits rides that leg
  // when set; /key is ALWAYS read with the API key (it describes the caller,
  // and the management key has no limit of its own).
  _resetCreditsCacheForTest();
  process.env.OPENROUTER_MANAGEMENT_KEY = "mgmt-key";
  const bearers = {};
  globalThis.fetch = async (url, init) => {
    bearers[String(url).endsWith("/key") ? "key" : "credits"] = init.headers.Authorization;
    return { ok: true, status: 200, json: async () => (String(url).endsWith("/key")
      ? { data: { label: "k", limit: 250, limit_remaining: 200 } }
      : { data: { total_credits: 100, total_usage: 1 } }) };
  };
  const viaMgmt = await gatewayCreditsStatus();
  ok(viaMgmt.status === "ok" && bearers.credits === "Bearer mgmt-key" && bearers.key === "Bearer test-key", `management key reads /credits, API key reads /key (got ${JSON.stringify(bearers)})`);
  delete process.env.OPENROUTER_MANAGEMENT_KEY;
  _resetCreditsCacheForTest();
  await gatewayCreditsStatus();
  ok(bearers.credits === "Bearer test-key", "without a management key the API key reads /credits (fallback)");
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_LOW_CREDITS_USD;
}

// /v1/audio/speech — OpenAI TTS wire over OpenRouter, raw bytes out via the
// route binder's __binary sentinel. Payment settles before the handler, so
// the tier serves a five-model failover chain (every link canary-proven);
// OpenAI voice names map per-model, native ids pass through.
{
  const { validateSpeechRequest, SPEECH_PATH, SPEECH_MODELS, LLM_GATEWAY_TOOLS: tools } = await import("../src/tools/llm-gateway-kit.js");
  ok(SPEECH_PATH === "/v1/audio/speech", "speech path constant");
  const speechTool = tools.find((t) => t.slug === "v1-audio-speech");
  ok(speechTool && speechTool.route === "POST /v1/audio/speech" && speechTool.price === "$0.060", "speech tool registered at the OpenAI wire path");
  ok(SPEECH_MODELS.length === 5 && SPEECH_MODELS[0].id === "mistralai/voxtral-mini-tts-2603" && !SPEECH_MODELS.some((m) => /zonos/.test(m.id)), "five-model chain, Voxtral primary, Zonos (zero endpoints upstream) gone");
  ok(SPEECH_MODELS.every((e) => e.map.alloy && Object.values(e.map).every((voice) => e.voices.has(voice))), "every chain link maps each OpenAI voice name to one of its own native voices");

  const v = validateSpeechRequest({ input: "hello world" });
  ok(v.bodies.length === 5 && v.bodies[0].model === "mistralai/voxtral-mini-tts-2603" && v.bodies[0].voice === "en_paul_neutral" && v.bodies[0].response_format === "mp3" && v.contentType === "audio/mpeg", "defaults: full chain, alloy maps to the primary's neutral voice, mp3");
  ok(v.bodies.map((b) => b.model).join() === SPEECH_MODELS.map((e) => e.id).join(), "default chain order = SPEECH_MODELS order");
  const pinned = validateSpeechRequest({ input: "hi", model: "kokoro" });
  ok(pinned.bodies[0].model === "hexgrad/kokoro-82m" && pinned.bodies.length === 5, "explicit model pins that link first — the rest stay as fallbacks");
  ok(validateSpeechRequest({ input: "hi", model: "voxtral-mini-tts" }).bodies[0].model === "mistralai/voxtral-mini-tts-2603", "bare family alias accepted");
  const nova = validateSpeechRequest({ input: "hi", voice: "nova" });
  ok(nova.bodies[0].voice === "gb_jane_confident" && nova.bodies[2].voice === "af_nova", "OpenAI voice name maps per-model down the chain");
  const native = validateSpeechRequest({ input: "hi", voice: "en_paul_cheerful" });
  ok(native.bodies[0].voice === "en_paul_cheerful" && native.bodies[2].voice === "af_alloy", "native voice id passes through on its model, remaps to alloy elsewhere");
  ok(validateSpeechRequest({ input: "hi", response_format: "pcm" }).contentType === "audio/pcm", "pcm supported");
  ok(validateSpeechRequest({ input: "hi", speed: 0.5 }).bodies[0].speed === 0.5, "speed 0.25-4 accepted — upstream bills per input char, so speed is cost-neutral");
  throws(() => validateSpeechRequest({}), '"input" is required', "missing input rejected");
  throws(() => validateSpeechRequest({ input: "x".repeat(2100) }), "Input too long", "char cap enforced");
  throws(() => validateSpeechRequest({ input: "hi", instructions: "warm tone" }), "not supported", "instructions rejected — serving models have no instructions channel");
  throws(() => validateSpeechRequest({ input: "hi", model: "tts-1-hd" }), '"model" must be one of', "unknown models rejected");
  throws(() => validateSpeechRequest({ input: "hi", voice: "morgan-freeman" }), '"voice" must be', "unknown voice rejected");
  throws(() => validateSpeechRequest({ input: "hi", response_format: "flac" }), "response_format", "unsupported format rejected");
  throws(() => validateSpeechRequest({ input: "hi", speed: 5 }), '"speed"', "speed above 4 rejected");
  ok(validateSpeechRequest({ input: "hi", zdr: true }).bodies.every((b) => b.provider?.zdr === true), "zdr folds into every chain link");

  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const FAKE_MP3 = Buffer.from("ID3fake-mp3-bytes".repeat(50));
  const audioRes = { ok: true, status: 200, arrayBuffer: async () => FAKE_MP3.buffer.slice(FAKE_MP3.byteOffset, FAKE_MP3.byteOffset + FAKE_MP3.byteLength) };
  let seen = null, seenUrl = null;
  globalThis.fetch = async (url, init) => {
    seenUrl = String(url);
    seen = JSON.parse(init.body);
    return audioRes;
  };
  const out = await speechTool.handler({ input: "hello", voice: "nova" });
  ok(seenUrl.includes("openrouter.ai/api/v1/audio/speech"), "hits OpenRouter's audio speech endpoint");
  ok(seen.model === "mistralai/voxtral-mini-tts-2603" && seen.voice === "gb_jane_confident", "upstream body carries the primary model and mapped voice");
  ok(Buffer.isBuffer(out.__binary) && out.__binary.length === FAKE_MP3.length && out.contentType === "audio/mpeg", "raw bytes returned via the __binary sentinel");

  // A provider outage never becomes the buyer's failure: 502 on the primary
  // walks to the next link; empty audio walks too.
  let calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body).model);
    if (calls.length === 1) return { ok: false, status: 502, text: async () => "provider down" };
    if (calls.length === 2) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    return audioRes;
  };
  const walked = await speechTool.handler({ input: "hello", voice: "nova" });
  ok(calls.length === 3 && calls[1] === "x-ai/grok-voice-tts-1.0" && calls[2] === "hexgrad/kokoro-82m", "chain walks past a 502 AND past empty audio");
  ok(Buffer.isBuffer(walked.__binary) && walked.__binary.length === FAKE_MP3.length, "fallback link serves the bytes");

  // Only exhausting every link surfaces an error.
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body).model);
    return { ok: false, status: 503, text: async () => "everything is down" };
  };
  await speechTool.handler({ input: "hello" }).then(
    () => ok(false, "all links down must not serve"),
    (e) => ok(calls.length === 5 && [502, 503].includes(e.statusCode), "all five links tried before the buyer sees an error")
  );
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
}


// ---- metered tier: the 402 price is a per-request quote (2026-08-26) ----
{
  const M = TIERS["v1-chat-metered"];
  ok(M.metered === true && M.route === "POST /v1/metered/chat/completions" && Object.keys(TIERS).at(-1) === "v1-chat-metered", "metered tier exists and is listed LAST (tierFor keeps home tiers first)");
  ok(tierFor("anthropic/claude-opus-5") === "v1-chat-premium" && tierAllows("v1-chat-metered", "anthropic/claude-opus-5") && tierAllows("v1-chat-metered", "openai/gpt-5-nano"), "explicit models still resolve to their home tier, and the metered tier admits every flat-tier model");
  const tiny = meteredQuoteUsd({ model: "openai/gpt-5-nano", messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
  ok(tiny.usd === M.price && !tiny.invalid, `a nano "hi" quotes the floor ($${M.price})`);
  const mid = meteredQuoteUsd({ model: "anthropic/claude-opus-5", messages: [{ role: "user", content: "write an essay" }], max_tokens: 2000 });
  const more = meteredQuoteUsd({ model: "anthropic/claude-opus-5", messages: [{ role: "user", content: "write an essay" }], max_tokens: 4000 });
  ok(mid.usd > M.price && more.usd > mid.usd, `the quote grows with max_tokens on a priced model ($${mid.usd} -> $${more.usd})`);
  const huge = meteredQuoteUsd({ model: "anthropic/claude-opus-4.7-fast", messages: [{ role: "user", content: "x ".repeat(95000) }], max_tokens: 8192, n: 2 });
  ok(huge.overCap === true && huge.usd === METERED_MAX_QUOTE_USD, `a body over the cap quotes the cap ($${METERED_MAX_QUOTE_USD}) and is flagged`);
  let refused = null; try { validateRequest({ model: "anthropic/claude-opus-4.7-fast", messages: [{ role: "user", content: "x ".repeat(95000) }], max_tokens: 8192, n: 2 }, "v1-chat-metered"); } catch (e) { refused = e; }
  ok(refused?.statusCode === 400 && /per-call cap/.test(refused.message), "the handler refuses an over-cap body with a 400 (nothing charged) naming the cap");
  const bad = meteredQuoteUsd({ model: "nope/x", messages: [{ role: "user", content: "hi" }] });
  ok(bad.invalid === true && bad.usd === M.price, "an invalid body quotes the floor and is flagged (the handler's own 400 refuses it)");
  const tool = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-metered");
  ok(typeof tool.quote === "function" && tool.quote({ model: "openai/gpt-5-nano", messages: [{ role: "user", content: "hi" }], max_tokens: 5 }) === M.price, "the catalog entry exposes quote() for payments.js");
  const listed = modelsList().data;
  ok(!listed.some((m) => m.x402.tier === "v1-chat-metered") && listed.filter((m) => m.x402.meteredEndpoint === "/v1/metered/chat/completions").length > 30, "/v1/models lists no duplicate metered ids; chat entries carry meteredEndpoint instead");
}


// ---- reasoning budget must sit under the priced output cap (audit 2026-08-26) ----
{
  const base = { model: "anthropic/claude-opus-5", messages: [{ role: "user", content: "hi" }] };
  let e = null; try { validateRequest({ ...base, max_tokens: 64, reasoning: { max_tokens: 8000 } }, "v1-chat-premium"); } catch (x) { e = x; }
  ok(e?.statusCode === 400 && /below "max_tokens"/.test(e.message), "reasoning.max_tokens >= max_tokens is refused pre-spend (the quote priced max_tokens as the whole output)");
  let e2 = null; try { validateRequest({ ...base, max_tokens: 64, reasoning: { max_tokens: 64 } }, "v1-chat-premium"); } catch (x) { e2 = x; }
  ok(e2?.statusCode === 400, "equal budgets are refused too (strictly below)");
  const v = validateRequest({ ...base, max_tokens: 2000, reasoning: { max_tokens: 1000 } }, "v1-chat-metered");
  ok(v.reasoning?.max_tokens === 1000 && v.max_tokens === 2000, "a reasoning budget under max_tokens passes on the metered tier");
}

// ---- a missing model is served as the tier default, never refused (2026-08-28) ----
{
  const { validateRequest: vr, TIERS: T } = await import("../src/tools/llm-gateway-kit.js");
  for (const [slug, expect] of [["v1-chat-nano", "openai/gpt-5.6-luna"], ["v1-chat", "openai/gpt-4o-mini"], ["v1-chat-pro", "openai/gpt-4o"], ["v1-chat-premium", "anthropic/claude-opus-5"], ["v1-chat-metered", "anthropic/claude-haiku-4.5"]]) {
    const b = vr({ messages: [{ role: "user", content: "hi" }], max_tokens: 16 }, slug, { clamp: false });
    ok(b.model === expect && b.__defaultedModel === expect && !Object.keys(b).includes("__defaultedModel") && T[slug].defaultModel === expect, `${slug}: no model -> ${expect} (marker non-enumerable)`);
    ok(T[slug].prefixes.some((p) => expect === p || expect.startsWith(p.endsWith("/") ? p : p + "-") || expect === p), `${slug}: the default is inside the tier's own allowlist`);
  }
  const explicit = vr({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }, "v1-chat", { clamp: false });
  ok(explicit.model === "openai/gpt-4o-mini" && explicit.__defaultedModel === undefined, "an explicit model is never marked as defaulted");
  const routed = vr({ messages: [{ role: "user", content: "hi" }], max_tokens: 16 }, "v1-chat-auto", { clamp: false });
  ok(routed.__defaultedModel === undefined, "the auto tier routes; it does not default");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
