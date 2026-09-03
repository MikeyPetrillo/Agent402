// /v1/.../messages (Anthropic Messages wire) - offline, stub fetch.
process.env.POSTHOG_TEST_CAPTURE = "1";
import { LLM_MESSAGES_TOOLS, validateMessagesRequest, isEmptyMaxTokens, MESSAGES_PATH_BY_TIER, MESSAGES_TIER_BY_PATH } from "../src/tools/llm-messages-kit.js";
import { TIERS, createSseUsageScrubber } from "../src/tools/llm-gateway-kit.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const bySlug = (slug) => LLM_MESSAGES_TOOLS.find((t) => t.slug === slug);
const msg = (text = "hi") => [{ role: "user", content: text }];

// ---- registration ----
ok(LLM_MESSAGES_TOOLS.length === 6 && Object.keys(MESSAGES_PATH_BY_TIER).length === 6, "six Messages routes: one per flat chat tier plus the metered one");
ok(LLM_MESSAGES_TOOLS.every((t) => t.route === `POST ${MESSAGES_PATH_BY_TIER[t.slug.replace(/-messages$/, "")]}`), "routes follow the tier paths (/v1/nano/messages … /v1/premium/messages)");
ok(LLM_MESSAGES_TOOLS.every((t) => WALLET_ONLY_SLUGS.has(t.slug)), "every Messages route is wallet-only (never PoW-free: metered upstream)");
ok(LLM_MESSAGES_TOOLS.every((t) => t.price === (t.slug === "v1-chat-nano-messages" ? "$0.003" : t.slug === "v1-chat-metered-messages" ? "$0.001" : `$${TIERS[t.slug.replace(/-messages$/, "")].price.toFixed(2)}`)), "price strings mirror the sibling chat tier (metered: the $0.001 floor)");
ok(typeof bySlug("v1-chat-metered-messages").quote === "function" && LLM_MESSAGES_TOOLS.filter((t) => typeof t.quote === "function").length === 1, "only the metered Messages route carries a per-request quote function");
ok(MESSAGES_TIER_BY_PATH["/v1/messages"] === "v1-chat" && MESSAGES_TIER_BY_PATH["/v1/pro/messages"] === "v1-chat-pro", "path -> tier map");

// ---- validation ----
const base = "v1-chat", pro = "v1-chat-pro";
const v = validateMessagesRequest({ model: "anthropic/claude-haiku-4.5", max_tokens: 99999, messages: msg(), system: "be terse", temperature: 0.2, stop_sequences: ["END"] }, base);
ok(v.body.model === "anthropic/claude-haiku-4.5" && v.body.max_tokens === TIERS[base].maxTokens && v.body.system === "be terse" && v.body.temperature === 0.2 && v.body.stop_sequences[0] === "END", `valid body: model kept, max_tokens clamped to the tier cap (${v.body.max_tokens}), system/temperature/stop_sequences pass`);
ok(v.chain[0] === "anthropic/claude-haiku-4.5" && v.chain.length >= 1 && v.isRouted === false, "chain = requested model + tier fallbacks");
for (const [label, body, tier] of [
  ["no max_tokens", { model: "anthropic/claude-haiku-4.5", messages: msg() }, base],
  ["empty messages", { model: "anthropic/claude-haiku-4.5", max_tokens: 10, messages: [] }, base],
  ["model on wrong tier", { model: "anthropic/claude-opus-5", max_tokens: 10, messages: msg() }, base],
  ["unknown block type", { model: "anthropic/claude-haiku-4.5", max_tokens: 10, messages: [{ role: "user", content: [{ type: "audio", data: "x" }] }] }, base],
  ["image without source", { model: "anthropic/claude-haiku-4.5", max_tokens: 10, messages: [{ role: "user", content: [{ type: "image" }] }] }, base],
  ["server tool", { model: "anthropic/claude-sonnet-5", max_tokens: 10, messages: msg(), tools: [{ type: "web_search_20250305", name: "web_search" }] }, pro],
  ["tool without input_schema", { model: "anthropic/claude-sonnet-5", max_tokens: 10, messages: msg(), tools: [{ name: "t" }] }, pro],
  ["thinking budget >= max_tokens", { model: "anthropic/claude-sonnet-5", max_tokens: 2000, messages: msg(), thinking: { type: "enabled", budget_tokens: 2000 } }, pro],
  ["thinking budget too small", { model: "anthropic/claude-sonnet-5", max_tokens: 2000, messages: msg(), thinking: { type: "enabled", budget_tokens: 10 } }, pro],
  ["bad thinking type", { model: "anthropic/claude-sonnet-5", max_tokens: 2000, messages: msg(), thinking: { type: "max" } }, pro],
  ["too many images", { model: "anthropic/claude-haiku-4.5", max_tokens: 10, messages: [{ role: "user", content: Array.from({ length: 5 }, () => ({ type: "image", source: { type: "url", url: "https://x.test/a.png" } })) }] }, base],
  ["input too large", { model: "anthropic/claude-haiku-4.5", max_tokens: 10, messages: msg("x".repeat(TIERS[base].maxInputChars + 1)) }, base],
  ["bad cache_control", { model: "anthropic/claude-haiku-4.5", max_tokens: 10, messages: msg(), cache_control: { type: "ephemeral", ttl: "1h" } }, base],
]) {
  let e = null; try { validateMessagesRequest(body, tier); } catch (x) { e = x; }
  ok(e?.statusCode === 400, `${label} -> 400 (${String(e?.message || "").slice(0, 70)})`);
}
{
  // model on the wrong tier points at the right Messages path
  let e = null; try { validateMessagesRequest({ model: "anthropic/claude-opus-5", max_tokens: 10, messages: msg() }, base); } catch (x) { e = x; }
  ok(/\/v1\/premium\/messages/.test(e?.message || ""), `wrong-tier 400 names the serving Messages path (${e?.message})`);
}
{
  const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(200_000) } };
  const r = validateMessagesRequest({ model: "anthropic/claude-haiku-4.5", max_tokens: 64, messages: [{ role: "user", content: [img, { type: "text", text: "what is this?" }] }] }, base);
  ok(r.imageCount === 1 && JSON.stringify(r.probe).length < 2000 && JSON.stringify(r.body).length > 200_000, "probe replaces the base64 image with a marker (billed flat), the outbound body keeps it");
  const tr = validateMessagesRequest({ model: "anthropic/claude-sonnet-5", max_tokens: 64, messages: [msg()[0], { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }] }], tools: [{ name: "f", description: "d", input_schema: { type: "object" } }], thinking: { type: "adaptive" } }, pro);
  ok(tr.body.tools.length === 1 && tr.body.thinking.type === "adaptive" && tr.body.messages.length === 3, "tool_use / tool_result turns + client tools + adaptive thinking validate");
}
{
  // Claude Code's wire (measured 2026-08-27, claude-cli 2.1.250): `tools: []` on
  // the session-naming call, a mid-conversation system message on every turn
  // (mid-conversation-system beta), fields our wire does not carry
  // (output_config, context_management), a dated default model id, and
  // max_tokens far above the tier cap. None of it is a 400.
  const cc = validateMessagesRequest({
    model: "claude-haiku-4-5-20251001", max_tokens: 64000, stream: true, tools: [],
    thinking: { type: "adaptive", display: "omitted" }, output_config: { effort: "high" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=test" }, { type: "text", text: "terse", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }, { role: "system", content: "<system-reminder>be brief</system-reminder>" }, { role: "assistant", content: "ok" }, { role: "system", content: [{ type: "text", text: "again" }] }],
  }, "v1-chat-metered");
  ok(cc.body.tools === undefined && cc.body.model === "anthropic/claude-haiku-4.5" && cc.body.max_tokens === TIERS["v1-chat-metered"].maxTokens && cc.body.thinking.type === "adaptive" && !("output_config" in cc.body) && !("context_management" in cc.body), "Claude Code turn validates: empty tools dropped, dated id resolved, max_tokens clamped, unknown fields not forwarded");
  ok(cc.body.messages.every((m) => m.role === "user" || m.role === "assistant") && cc.body.messages[1].role === "user" && cc.body.messages[1].content[0].text.includes("system-reminder") && cc.body.messages[3].content[0].text === "again" && cc.body.messages.length === 4, "mid-conversation system messages are folded into user turns in place (string and block forms)");
}
{
  const auto = validateMessagesRequest({ max_tokens: 64, messages: msg("Write a python function that reverses a list") }, "v1-chat-auto");
  ok(auto.isRouted && auto.routedCategory === "code" && auto.chain.length >= 2 && auto.body.model === undefined, `auto tier routes by prompt class (${auto.routedCategory}) -> ${auto.chain[0]}`);
}
ok(isEmptyMaxTokens({ stop_reason: "max_tokens", content: [] }) && isEmptyMaxTokens({ stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "..." }] }) && !isEmptyMaxTokens({ stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }] }) && !isEmptyMaxTokens({ stop_reason: "end_turn", content: [] }), "isEmptyMaxTokens: only max_tokens + nothing said (thinking-only counts as nothing)");

// ---- handler: outbound shape, billing strip, failover, paid-empty guard, stream ----
process.env.OPENROUTER_API_KEY = "test-key";
const realFetch = globalThis.fetch;
const fakeReq = { header: (n) => (n === "payment-signature" ? Buffer.from(JSON.stringify({ payload: { authorization: { from: "0xAbCdEf0000000000000000000000000000000003" } } })).toString("base64") : undefined) };
const reply = (model, over = {}) => ({ id: "gen-m", type: "message", role: "assistant", model, content: [{ type: "text", text: "Hi there!" }], stop_reason: "end_turn", usage: { input_tokens: 22, output_tokens: 7, cost: 0.000114, is_byok: false, cost_details: { upstream_inference_cost: 0.000114 }, service_tier: "standard" }, ...over });
let seen = [];
globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); seen.push({ url: String(url), b }); return { ok: true, status: 200, text: async () => JSON.stringify(reply(b.model)) }; };
const proTool = bySlug("v1-chat-pro-messages");
const out = await proTool.handler({ model: "anthropic/claude-sonnet-5", max_tokens: 64, messages: msg(), system: "terse" }, fakeReq);
ok(seen[0].url.endsWith("/api/v1/messages") && seen[0].b.model === "anthropic/claude-sonnet-5" && seen[0].b.system === "terse" && seen[0].b.max_tokens === 64, "upstream call hits OpenRouter /messages with the Anthropic body");
ok(seen[0].b.provider?.max_price?.prompt === TIERS[pro].maxPrice.prompt && seen[0].b.provider?.sort === undefined && typeof seen[0].b.user === "string" && seen[0].b.session_id === seen[0].b.user && seen[0].b.cache_control?.type === "ephemeral", "server-owned provider max_price, per-buyer user + session_id, default cache_control ride; pro does not price-sort");
ok(out.content[0].text === "Hi there!" && out.usage.input_tokens === 22 && !("cost" in out.usage) && !("is_byok" in out.usage) && !("cost_details" in out.usage), "Anthropic response passes through with billing fields stripped");
{
  const { _testEventsForTest } = await import("../src/posthog.js");
  const ev = _testEventsForTest().filter((e) => e.event === "gateway_usage").pop();
  ok(ev?.properties.tier === "v1-chat-pro:messages" && ev?.properties.upstreamUsd === 0.000114 && ev?.properties.promptTokens === 22, "margin telemetry recorded under <tier>:messages");
}
// nano price-sorts; auto discloses the router
seen = [];
await bySlug("v1-chat-nano-messages").handler({ model: "google/gemini-2.5-flash-lite", max_tokens: 32, messages: msg() }, fakeReq);
ok(seen[0].b.provider?.sort === "price" && seen[0].b.service_tier === "flex", "nano: price sort + flex-first attempt on a flex-eligible model");
seen = [];
const autoOut = await bySlug("v1-chat-auto-messages").handler({ max_tokens: 32, messages: msg("hello") }, fakeReq);
ok(autoOut.agent402_router?.category === "general" && typeof autoOut.agent402_router?.served === "string" && seen[0].b.model, `auto tier discloses agent402_router (${JSON.stringify(autoOut.agent402_router)})`);
// failover (nano: the tier with fallbacks; pro/premium explicit-model requests are one-link chains like the chat wire):
// flex attempt 503 -> same model default -> serves
const nanoTool = bySlug("v1-chat-nano-messages");
seen = [];
globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); seen.push(b.model + (b.service_tier ? ":flex" : "")); if (seen.length === 1) return { ok: false, status: 503, text: async () => "busy" }; return { ok: true, status: 200, text: async () => JSON.stringify(reply(b.model)) }; };
const fo = await nanoTool.handler({ model: "google/gemini-2.5-flash-lite", max_tokens: 64, messages: msg() }, fakeReq);
ok(fo.content[0].text === "Hi there!" && seen.join(",") === "google/gemini-2.5-flash-lite:flex,google/gemini-2.5-flash-lite", `upstream 503 on flex walks to the same model on default (${seen.join(" -> ")})`);
// paid-empty guard: max_tokens + no content walks on (same model's default retry skipped); chain exhausted -> 502
seen = [];
globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); seen.push(b.model); return { ok: true, status: 200, text: async () => JSON.stringify(reply(b.model, b.model === "google/gemini-2.5-flash-lite" ? { stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "hmm" }] } : {})) }; };
const pe = await nanoTool.handler({ model: "google/gemini-2.5-flash-lite", max_tokens: 64, messages: msg() }, fakeReq);
ok(pe.content[0].text === "Hi there!" && seen.join(",") === "google/gemini-2.5-flash-lite,deepseek/deepseek-chat", `a max_tokens answer with nothing said is never served: chain walked on, same model's default retry skipped (${seen.join(" -> ")})`);
globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); return { ok: true, status: 200, text: async () => JSON.stringify(reply(b.model, { stop_reason: "max_tokens", content: [] })) }; };
await nanoTool.handler({ model: "google/gemini-2.5-flash-lite", max_tokens: 64, messages: msg() }, fakeReq).then(() => ok(false, "end-to-end empty must not serve"), (e) => ok(e.statusCode === 502 && /thinking consumed it/.test(e.message), "chain empty end-to-end -> 502 (settlement cancelled)"));
globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => "busy" });
await proTool.handler({ model: "anthropic/claude-sonnet-5", max_tokens: 64, messages: msg() }, fakeReq).then(() => ok(false, "pro one-link 503 must not serve"), (e) => ok(e.statusCode === 502, "pro (no fallbacks): upstream 503 -> 502, settlement cancelled"));
// 4xx upstream -> 502 passthrough message, not a chain walk into infinity
globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "bad thing" } }) });
await proTool.handler({ model: "anthropic/claude-sonnet-5", max_tokens: 64, messages: msg() }, fakeReq).then(() => ok(false, "upstream 400 must not serve"), (e) => ok(e.statusCode === 502 && /bad thing/.test(e.message), "upstream 4xx -> 502 with the upstream message"));
// stream: the Anthropic SSE message_delta frame's usage.cost is scrubbed
{
  const sc = createSseUsageScrubber();
  const frame = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":22,"output_tokens":7,"cost":0.000114,"is_byok":false,"cost_details":{"upstream_inference_cost":0.000114}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const outS = sc.push(frame) + sc.flush();
  ok(!/cost|is_byok/.test(outS) && /"output_tokens":7/.test(outS) && /event: message_delta/.test(outS), "SSE scrubber strips billing from the message_delta frame and keeps event lines + token counts");
  const frames = [];
  globalThis.fetch = async (url, init) => ({ ok: true, status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n'); yield Buffer.from(frame); } } });
  const res = { headersSent: false, writeHead() { this.headersSent = true; }, flushHeaders() {}, write(c) { frames.push(String(c)); }, end() { this.ended = true; }, on() {} };
  const h = await proTool.handler({ model: "anthropic/claude-sonnet-5", max_tokens: 64, messages: msg(), stream: true }, fakeReq);
  ok(typeof h.__sse === "function", "stream:true returns the __sse sentinel for the route binder");
  await h.__sse(res);
  const all = frames.join("");
  ok(res.ended && /message_start/.test(all) && /message_stop/.test(all) && !/cost/.test(all), "streamed Anthropic events pass through end to end with billing scrubbed");
}
globalThis.fetch = realFetch;
// ---- metered Messages route: quote from the body, belt, provider bound, meter sentinel ----
{
  const { meteredMessagesQuoteUsd } = await import("../src/tools/llm-messages-kit.js");
  const { costFor } = await import("../src/tools/llm-gateway-kit.js");
  const metered = bySlug("v1-chat-metered-messages");
  const small = { model: "anthropic/claude-haiku-4.5", max_tokens: 16, messages: msg("hi") };
  const bigger = { model: "anthropic/claude-opus-5", max_tokens: 4096, system: "x ".repeat(20_000), messages: msg("y ".repeat(5_000)) };
  const qs = meteredMessagesQuoteUsd(small), qb = meteredMessagesQuoteUsd(bigger);
  ok(!qs.invalid && !qb.invalid && qs.usd >= TIERS["v1-chat-metered"].price && qb.usd > qs.usd * 10, `quote grows with the body: small $${qs.usd}, bigger $${qb.usd}`);
  ok(metered.quote(small) === qs.usd && metered.quote(bigger) === qb.usd, "the tool's quote() is the same function payments.js prices the 402 from");
  // The largest body validation admits (200k chars, Opus, 8192 tokens) quotes
  // under the $2 cap, so the cap is pinned on the shared probe-level quoter.
  const { meteredQuoteForProbe } = await import("../src/tools/llm-gateway-kit.js");
  const huge = validateMessagesRequest({ model: "anthropic/claude-opus-5", max_tokens: 8192, system: "x ".repeat(90_000), messages: msg("y ".repeat(9_000)) }, "v1-chat-metered");
  const qh = meteredQuoteForProbe({ ...huge.probe, max_tokens: 100_000 }, 0);
  ok(qh.overCap === true && qh.usd === TIERS["v1-chat-metered"].maxQuoteUsd && meteredMessagesQuoteUsd({ model: "anthropic/claude-opus-5", max_tokens: 8192, system: "x ".repeat(90_000), messages: msg("y ".repeat(9_000)) }).usd < TIERS["v1-chat-metered"].maxQuoteUsd, `a probe past the cap quotes the cap ($${qh.usd}); the largest admissible Messages body stays under it`);
  const qi = meteredMessagesQuoteUsd({ max_tokens: 16 }); // no messages at all: still invalid (a missing model now defaults)
  ok(qi.invalid && qi.usd === TIERS["v1-chat-metered"].price, "an invalid body quotes the floor and says why (the handler's 400 refuses it)");
  seen = [];
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); seen.push({ url: String(url), b }); return { ok: true, status: 200, text: async () => JSON.stringify(reply(b.model)) }; };
  const quotedReq = { ...fakeReq, __meteredQuoteUsd: qs.usd };
  const mo = await metered.handler(small, quotedReq);
  const row = costFor(small.model);
  ok(seen[0].b.provider?.max_price?.prompt === row.prompt && seen[0].b.provider?.max_price?.completion === row.completion, "metered: provider.max_price is the quoted model's own cost row, not the tier-wide cap");
  ok(mo.__meterUpstreamUsd === 0.000114 && mo.content[0].text === "Hi there!" && !("cost" in mo.usage), "metered: the meter sentinel carries the upstream cost to the route binder; billing fields are stripped");
  ok(!JSON.stringify(mo).includes("__meterUpstreamUsd") && !Object.keys(mo).includes("__meterUpstreamUsd"), "metered: the sentinel is non-enumerable - an in-process caller nesting this result cannot serialize our upstream cost");
  {
    const { _testEventsForTest } = await import("../src/posthog.js");
    const ev = _testEventsForTest().filter((e) => e.event === "gateway_usage").pop();
    ok(ev?.properties.tier === "v1-chat-metered:messages" && ev?.properties.priceUsd === qs.usd, "metered: gateway_usage.priceUsd is the quote, not the floor");
  }
  let belt = null;
  try { await metered.handler(bigger, { ...fakeReq, __meteredQuoteUsd: qs.usd }); } catch (e) { belt = e; }
  ok(belt?.statusCode === 400 && /quoted at/.test(belt.message), "metered belt: a body quoting above the gated price is refused 400 before any upstream call");
  ok(seen.length === 1, "the refused request never reached upstream");
  // Over the per-call cap: the 402 quoted the CAP (not the cost), so the
  // handler must refuse - with a stashed quote, and with no request at all.
  const overCap = { model: "anthropic/claude-opus-4.7-fast", max_tokens: 8192, messages: msg("\u4e2d".repeat(190_000)) };
  const qo = meteredMessagesQuoteUsd(overCap);
  ok(qo.overCap === true && qo.usd === TIERS["v1-chat-metered"].maxQuoteUsd, `an over-cap body quotes the cap ($${qo.usd}) and is flagged overCap`);
  for (const [label, r] of [["with the gate's stashed quote", { ...fakeReq, __meteredQuoteUsd: qo.usd }], ["with no request (in-process caller)", undefined]]) {
    let err = null;
    try { await metered.handler(overCap, r); } catch (e) { err = e; }
    ok(err?.statusCode === 400 && /per-call cap/.test(err.message) && seen.length === 1, `over-cap Messages body refused 400 before upstream ${label}`);
  }
  // The metered quote uses the model's OWN row, which is what rides upstream as the bound.
  const fast = costFor("anthropic/claude-opus-4.7-fast");
  ok(fast.prompt > TIERS["v1-chat-metered"].maxPrice.prompt && meteredMessagesQuoteUsd({ model: "anthropic/claude-opus-4.7-fast", max_tokens: 1000, messages: msg("hi") }).usd > meteredMessagesQuoteUsd({ model: "anthropic/claude-opus-5", max_tokens: 1000, messages: msg("hi") }).usd * 1.5, "metered quote prices an expensive model at its own row, not min'd with the tier-wide max_price");
}
delete process.env.OPENROUTER_API_KEY;

// ---- a missing model is served as the tier default (2026-08-28) ----
{
  const v = validateMessagesRequest({ max_tokens: 16, messages: [{ role: "user", content: "hi" }] }, "v1-chat");
  ok(v.body.model === "openai/gpt-4o-mini" && v.defaultedModel === "openai/gpt-4o-mini", "no model on v1-chat -> the tier default, marked defaultedModel");
  const e = validateMessagesRequest({ model: "openai/gpt-4o-mini", ...{ max_tokens: 16, messages: [{ role: "user", content: "hi" }] } }, "v1-chat");
  ok(e.defaultedModel === null, "an explicit model is not marked as defaulted");
}

// Sampling params Anthropic removed for models after Opus 4.6 (docs read
// 2026-08-28): top_k at any value, temperature != 1, top_p < 0.99. We say so
// ourselves instead of relaying their 400 with no explanation; older models
// keep the old freedom.
{
  const strict = { model: "anthropic/claude-opus-5", max_tokens: 64, messages: msg() };
  const t = (extra) => { try { validateMessagesRequest({ ...strict, ...extra }, "v1-chat-premium"); return null; } catch (e) { return e.message; } };
  ok(/top_k/.test(t({ top_k: 5 }) || ""), "opus-5: top_k is refused with a self-explaining 400");
  ok(/temperature/.test(t({ temperature: 0.2 }) || ""), "opus-5: temperature other than 1 is refused");
  ok(/top_p/.test(t({ top_p: 0.5 }) || ""), "opus-5: top_p under 0.99 is refused");
  ok(t({ temperature: 1 }) === null && t({ top_p: 0.99 }) === null, "opus-5: the values Anthropic still accepts pass through");
  const old = validateMessagesRequest({ model: "anthropic/claude-haiku-4.5", max_tokens: 64, messages: msg(), temperature: 0.2, top_k: 5 }, "v1-chat");
  ok(old.body.temperature === 0.2 && old.body.top_k === 5, "a pre-Opus-4.6 model keeps temperature and top_k");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
