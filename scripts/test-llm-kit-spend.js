// The legacy /api/llm* kit meters its upstream spend (2026-09-15).
//
// Until this date the three direct-to-OpenAI tools recorded nothing: no
// gateway_usage event, no daily_upstream_spend row. A buyer settled fifteen
// $0.10 llm-pro calls in one evening and /__operator/margin.json showed the
// revenue against $0 upstream. OpenAI returns token counts and never a cost,
// so the kit prices the usage block itself from a table read off OpenAI's
// pricing page, and feeds the SAME meter and PostHog event the gateway uses.
//
// Offline: fetch is stubbed with an OpenAI-shaped body; the assertion on the
// meter reads the stats DB's spend rows before and after, so a handler that
// stopped calling the meter (or priced at zero) fails here.
import assert from "node:assert/strict";

delete process.env.POSTHOG_API_KEY; // telemetry off; the METER must still run
process.env.OPENAI_API_KEY = "sk-test-not-real";

const { LLM_TOOLS, openaiCostUsd, openaiCostRow } = await import("../src/tools/llm-kit.js");
const stats = await import("../src/stats.js");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// --- the cost table: list prices, longest prefix, cached rate, unknown errs HIGH
{
  const u = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
  ok(openaiCostUsd("gpt-4o", u) === 12.5, "gpt-4o: list input + output rates");
  ok(openaiCostUsd("gpt-4.1", u) === 10, "gpt-4.1: list rates");
  ok(openaiCostUsd("gpt-4o-mini", u) === 0.75, "gpt-4o-mini: list rates");
  ok(openaiCostUsd("gpt-4.1-mini-2025-04-14", u) === 2, "a dated id resolves by LONGEST prefix (mini, not 4.1)");
  ok(openaiCostUsd("gpt-4o-2024-08-06", u) === 12.5, "gpt-4o dated id");
  ok(openaiCostUsd("o3-mini", u) === 5.5 && openaiCostUsd("o3", u) === 10, "o3 family");
  const cached = { prompt_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 1_000_000 }, completion_tokens: 0 };
  ok(openaiCostUsd("gpt-4o", cached) === 1.25, "cached prompt tokens bill at the cached rate");
  ok(openaiCostRow("gpt-9-unheard-of") === openaiCostRow("gpt-4o"),
     "a model the table does not know is priced at the DEAREST row - the meter errs high, never silently low");
  ok(openaiCostUsd("gpt-4o", { prompt_tokens: 4000, completion_tokens: 300 }) === 0.013,
     "a typical pro call: 4k in + 300 out on gpt-4o is ~$0.013 against the $0.10 price");
}

// --- the handler feeds the meter -------------------------------------------
{
  const spendOf = () => stats.getDailyUpstreamSpend()
    .filter((r) => r.source === "gateway" && r.day === new Date().toISOString().slice(0, 10))
    .reduce((a, r) => a + Number(r.usd_micro || 0), 0);
  const before = spendOf();

  globalThis.fetch = async () => new Response(JSON.stringify({
    model: "gpt-4o-2024-08-06",
    usage: { prompt_tokens: 4000, completion_tokens: 300, total_tokens: 4300 },
    choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  }), { status: 200, headers: { "content-type": "application/json" } });

  const pro = LLM_TOOLS.find((t) => t.slug === "llm-pro");
  const out = await pro.handler({ model: "gpt-4o", messages: [{ role: "user", content: "hello" }] });
  ok(out.choices[0].message.content === "hi", "the buyer's answer is unchanged");
  ok(out.usage.prompt_tokens === 4000, "usage still rides to the buyer");
  // The capture is a lazy import that resolves off the handler's own promise.
  await new Promise((r) => setTimeout(r, 200));
  const delta = spendOf() - before;
  ok(delta === 13_000, `the meter recorded 13,000 micro-USD ($0.013) for the call under source "gateway" (got ${delta})`);
}

console.log(`test-llm-kit-spend: ${n} assertions OK`);
