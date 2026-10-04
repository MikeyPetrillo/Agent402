// The legacy /api/llm* kit meters its upstream spend (2026-09-15).
//
// Until this date the three direct-to-OpenAI tools recorded nothing: no
// gateway_usage event, no daily_upstream_spend row. A buyer settled fifteen
// $0.10 llm-pro calls in one evening and /__operator/margin.json showed the
// revenue against $0 upstream. OpenAI returns token counts and never a cost,
// so the kit prices the usage block itself from the private rate table, and feeds the SAME meter and PostHog event the gateway uses.
//
// Offline: fetch is stubbed with an OpenAI-shaped body; the assertion on the
// meter reads the stats DB's spend rows before and after, so a handler that
// stopped calling the meter (or priced at zero) fails here.
import assert from "node:assert/strict";

delete process.env.POSTHOG_API_KEY; // telemetry off; the METER must still run
process.env.OPENAI_API_KEY = "sk-test-not-real";

const { LLM_TOOLS, openaiCostUsd, openaiCostRow } = await import("../src/tools/llm-kit.js");
const { upstreamCosts } = await import("../src/upstream-costs.js");
const { requireUpstreamCosts } = await import("./lib/require-upstream-costs.js");
requireUpstreamCosts("test-llm-kit-spend");
const stats = await import("../src/stats.js");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// --- the cost table: longest prefix, cached rate, unknown errs HIGH.
// Expectations are computed from the private table, never typed here.
{
  const R = upstreamCosts().openai;
  const both = (k) => Math.round((R[k].prompt + R[k].completion) * 1e6) / 1e6;
  const u = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
  for (const k of ["gpt-4o", "gpt-4.1", "gpt-4o-mini", "o3-mini", "o3"]) ok(openaiCostUsd(k, u) === both(k), `${k}: input + output rates from its row`);
  ok(openaiCostUsd("gpt-4.1-mini-2025-04-14", u) === both("gpt-4.1-mini"), "a dated id resolves by LONGEST prefix (mini, not 4.1)");
  ok(openaiCostUsd("gpt-4o-2024-08-06", u) === both("gpt-4o"), "gpt-4o dated id");
  const cached = { prompt_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 1_000_000 }, completion_tokens: 0 };
  ok(openaiCostUsd("gpt-4o", cached) === R["gpt-4o"].cached, "cached prompt tokens bill at the cached rate");
  const dearest = Object.values(R).reduce((a, b) => (b.completion > a.completion ? b : a));
  ok(openaiCostRow("gpt-9-unheard-of") === dearest,
     "a model the table does not know is priced at the DEAREST row - the meter errs high, never silently low");
  ok(openaiCostUsd("gpt-4o", { prompt_tokens: 4000, completion_tokens: 300 }) < 0.1 * 0.7,
     "a typical pro call (4k in + 300 out on gpt-4o) stays inside the margin on the $0.10 price");
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
