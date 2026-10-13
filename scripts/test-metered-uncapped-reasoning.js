#!/usr/bin/env node
// A model whose reasoning bills OUTSIDE max_tokens is quoted and clamped for it.
//
//   UPSTREAM_COSTS_FILE=<private table> node scripts/test-metered-uncapped-reasoning.js
//
// Metered calls to x-ai/grok-4.6 reported completion tokens up to 1.8x the
// request's max_tokens (the provider caps the visible answer and bills the
// reasoning before it on top), and three of twelve came in under a quote
// priced at the cap alone. Pins, against the private cost table (no rate is
// typed here; every figure is derived from the table at run time):
//   - the metered quote for the measured token mixes is at or above the
//     table-rate bill for them, at the full markup;
//   - a model without the flag is priced exactly at its cap (unchanged);
//   - the flat-tier clamp leaves a cap whose worst case, factor included, stays
//     inside the tier's margin budget.
// Under CI the private table is required; a fork's run may skip (UPSTREAM_COSTS_OPTIONAL).
const { worstCaseUpstreamCost, clampToMargin, meteredQuoteUsd, reasoningOutsideMaxTokens, UNCAPPED_REASONING_OUT_FACTOR, TIERS, costFor, MARGIN } = await import("../src/tools/llm-gateway-kit.js");
const { meterMarkup } = await import("../src/gateway-meter.js");
const { upstreamCostsLoaded } = await import("../src/upstream-costs.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

if (!upstreamCostsLoaded() || meterMarkup() == null) {
  const msg = "no private cost table (UPSTREAM_COSTS_JSON or UPSTREAM_COSTS_FILE)";
  if (process.env.CI && !process.env.UPSTREAM_COSTS_OPTIONAL) { console.error(`FAIL - ${msg}: required under CI`); process.exit(1); }
  console.log(`SKIP - ${msg}`);
  process.exit(0);
}

const MODEL = "x-ai/grok-4.6";
const CONTROL = "openai/gpt-4o-mini";
// Measured token mixes (counts only): input tokens the request carried and
// output tokens the provider reported, each on a request capped at 512.
const MIXES = [{ inTokens: 310, outTokens: 715 }, { inTokens: 310, outTokens: 708 }, { inTokens: 278, outTokens: 817 }];
const MAX_TOKENS = 512;

ok(reasoningOutsideMaxTokens(MODEL) && reasoningOutsideMaxTokens("x-ai/grok-4.7") && !reasoningOutsideMaxTokens(CONTROL) && !reasoningOutsideMaxTokens("anthropic/claude-haiku-4.5"), "the grok rows carry the flag; other models do not");
ok(UNCAPPED_REASONING_OUT_FACTOR >= 2, `the worst-case output factor leaves room above the largest measured overrun (${UNCAPPED_REASONING_OUT_FACTOR}x against 1.8x)`);

// A prompt the size of the measured ones, counted by the kit's own tokenizer.
const prompt = (tokens) => {
  let text = "";
  for (let i = 0; text.length < tokens * 6; i++) text += `Summarize the quarterly report line ${i} with its figures and risks. `;
  const body = { model: MODEL, messages: [{ role: "user", content: text }], max_tokens: MAX_TOKENS };
  while (worstCaseUpstreamCost(body, TIERS["v1-chat-metered"]).inTokens > tokens && body.messages[0].content.length > 20) body.messages[0].content = body.messages[0].content.slice(0, -12);
  return body;
};

const metered = TIERS["v1-chat-metered"];
const rate = costFor(MODEL);
const markup = meterMarkup();
ok(rate && rate.prompt > 0 && rate.completion > 0, "the model has a row in the table");
for (const mix of MIXES) {
  const body = prompt(mix.inTokens);
  const wc = worstCaseUpstreamCost(body, metered);
  const q = meteredQuoteUsd(body);
  const tableBill = (wc.inTokens / 1e6) * rate.prompt + (mix.outTokens / 1e6) * rate.completion;
  ok(wc.outFactor === UNCAPPED_REASONING_OUT_FACTOR && wc.outTokens === MAX_TOKENS * UNCAPPED_REASONING_OUT_FACTOR, `the worst case prices ${wc.outTokens} output tokens for a ${MAX_TOKENS} cap`);
  ok(Number.isFinite(q.usd) && q.usd >= tableBill * markup, `quote covers the table-rate bill at the markup for ${wc.inTokens} in, ${mix.outTokens} out (quote/bill ${(q.usd / tableBill).toFixed(2)}x)`);
}
{
  // Unchanged for a model without the flag: the output side is the cap itself.
  const body = { ...prompt(300), model: CONTROL };
  const wc = worstCaseUpstreamCost(body, metered);
  const c = costFor(CONTROL);
  ok(wc.outFactor === 1 && wc.outTokens === MAX_TOKENS && Math.abs(wc.outUsd - (MAX_TOKENS / 1e6) * c.completion) < 1e-12, "a model without the flag is priced at exactly its cap");
}
{
  // The flat tier that serves the model: the clamp's cap, times the factor,
  // still fits the margin budget, and it is a third of what an unflagged
  // model at the same rate would be allowed.
  const [slug, tier] = Object.entries(TIERS).find(([, t]) => !t.metered && !t.router && (t.prefixes || []).some((p) => MODEL.startsWith(p))) || [];
  ok(slug, `a flat tier serves ${MODEL} (${slug})`);
  if (tier) {
    const body = { ...prompt(300), max_tokens: tier.maxTokens };
    clampToMargin(body, tier);
    const after = worstCaseUpstreamCost(body, tier);
    ok(after.totalUsd <= tier.price * MARGIN + 1e-9, `the clamped cap's worst case, factor included, fits the ${slug} margin budget (${body.max_tokens} tokens)`);
    const unflagged = { ...body, model: CONTROL, max_tokens: tier.maxTokens };
    const inUsd = after.inUsd;
    const allowedAtCapOnly = Math.floor(((tier.price * MARGIN - inUsd - after.fixedUsd) * 1e6) / after.cost.completion);
    ok(body.max_tokens <= Math.floor(allowedAtCapOnly / UNCAPPED_REASONING_OUT_FACTOR) + 1, `...and is the cap-only allowance divided by the factor (${body.max_tokens} vs ${allowedAtCapOnly})`);
    void unflagged;
  }
}

console.log(`\ntest-metered-uncapped-reasoning: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
