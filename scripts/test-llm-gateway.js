// Unit tests for the OpenAI-compatible x402 LLM gateway — the pure validation
// layer that gates what reaches the paid OpenRouter upstream: model → tier
// routing (incl. bare-name mapping and self-correcting cross-tier errors),
// input/output caps, stream rejection, and the env-gated 503. No network.
import { TIERS, canonicalModel, tierAllows, tierFor, validateRequest, modelsList, LLM_GATEWAY_TOOLS } from "../src/tools/llm-gateway-kit.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const throws = (fn, substr, msg) => {
  try { fn(); ok(false, `${msg} (did not throw)`); }
  catch (e) { ok(String(e.message).includes(substr), `${msg} (got: ${String(e.message).slice(0, 90)})`); }
};

const msg1 = (content = "hi") => [{ role: "user", content }];

// Bare OpenAI-style names map to OpenRouter ids — drop-in SDK compatibility.
ok(canonicalModel("gpt-4o-mini") === "openai/gpt-4o-mini", "bare gpt name maps to openai/");
ok(canonicalModel("claude-opus-4") === "anthropic/claude-opus-4", "bare claude name maps to anthropic/");
ok(canonicalModel("gemini-2.5-flash") === "google/gemini-2.5-flash", "bare gemini name maps to google/");
ok(canonicalModel("o3-mini") === "openai/o3-mini", "bare o3 name maps to openai/");
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
throws(() => validateRequest({ model: "gpt-4o-mini", messages: msg1(), stream: true }, "v1-chat"), "Streaming", "stream:true rejected with guidance");
throws(() => validateRequest({ model: "gpt-4o-mini", messages: [] }, "v1-chat"), "non-empty", "empty messages rejected");
throws(() => validateRequest({ messages: msg1() }, "v1-chat"), "required", "missing model rejected");
throws(() => validateRequest({ model: "gpt-4o-mini", messages: msg1("x".repeat(40_000)) }, "v1-chat"), "Input too large", "input char cap enforced");
throws(() => validateRequest({ model: "gpt-4o-mini", messages: Array.from({ length: 101 }, () => ({ role: "user", content: "x" })) }, "v1-chat"), "Too many messages", "message count cap enforced");

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
ok(new Set(list.data.map((m) => m.x402.tier)).size === 3, "all three tiers represented");

// Catalog invariants: three wallet-only-priced routes at OpenAI wire paths.
ok(LLM_GATEWAY_TOOLS.length === 3, "three gateway routes");
ok(LLM_GATEWAY_TOOLS.every((t) => t.route.startsWith("POST /v1/") && t.route.endsWith("/chat/completions") || t.route === "POST /v1/chat/completions", ), "routes live at OpenAI wire paths");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
