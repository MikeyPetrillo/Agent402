// Pricing-margin invariant (audit D6) — for every upstream-cost tool, the
// worst-case upstream spend on a real (max-size) outbound body is STRICTLY
// LESS than the tool's flat price. All computed OFFLINE with the exact same
// functions the runtime margin clamp uses (worstCaseUpstreamCost /
// clampToMargin / embeddingsUpstreamCost are the clamp's own math, imported —
// never re-derived — so this test and production can never disagree).
//
// Also locks two cap-before-spend properties (STT duration cap and the
// images prompt cap throw BEFORE any upstream fetch) and the tool_gone
// telemetry on the retired-converter handlers (a retired convert route must
// fire a PostHog tool_gone event carrying route + replacement, whether the
// request was transparently served 200 or taught with a 410).
//
//   node scripts/test-pricing-margin.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

// Route PostHog captures to the in-memory test sink BEFORE anything imports
// posthog.js (the module freezes its mode at import time).
process.env.POSTHOG_TEST_CAPTURE = "1";

const {
  TIERS,
  MARGIN,
  worstCaseUpstreamCost,
  clampToMargin,
  validateRequest,
  AUTO_RANKINGS,
  LLM_GATEWAY_TOOLS,
  validateEmbeddingsRequest,
  embeddingsUpstreamCost,
  EMBEDDINGS_PRICE,
  IMAGES_PRICE,
  IMAGES_MAX_PROMPT_CHARS,
  meteredQuoteUsd,
} = await import("../src/tools/llm-gateway-kit.js");
const { meterMarkup } = await import("../src/gateway-meter.js");
const METER_MARKUP = meterMarkup();
const { countTokens } = await import("gpt-tokenizer/model/gpt-4o");
const { assertWithinDurationCap, probeDurationSeconds, STT_TIERS, upstreamUsdPerMinute } = await import("../src/tools/stt-kit.js");
const { upstreamCosts } = await import("../src/upstream-costs.js");
const { requireUpstreamCosts } = await import("./lib/require-upstream-costs.js");
requireUpstreamCosts("test-pricing-margin");
const { capturePostHogToolGone, _testEventsForTest, _flushPaywallRollupForTest } = await import("../src/posthog.js");

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};
const rejects = async (fn, substr, msg) => {
  try { await fn(); ok(false, `${msg} (did not throw)`); }
  catch (e) { ok(String(e.message).includes(substr), `${msg} (got: ${String(e.message).slice(0, 100)})`); }
};

// Worst realistic BPE density: rare CJK packs ~2 tokens/char in both o200k
// and cl100k — the exact failure mode the char caps alone can't price.
const DENSE = "龘龖龍龒龜";
const denseText = (chars) => DENSE.repeat(Math.ceil(chars / DENSE.length)).slice(0, chars);
const TINY_IMG = { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(120)}` } };
// A fat tool schema — tools are NOT char-capped, so they must be priced as input.
const BIG_TOOLS = Array.from({ length: 4 }, (_, i) => ({
  type: "function",
  function: {
    name: `tool_${i}`,
    description: "performs a long and thoroughly described operation. ".repeat(40),
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 20 }, (_, j) => [`param_${j}`, { type: "string", description: "a schema field that must be priced as model input" }])
      ),
    },
  },
}));

// ---------------------------------------------------------------------------
// 1. Chat tiers — worst-case upstream < price for every tier, on every
//    representative model, on adversarial max-size bodies. A 400 from
//    validateRequest is the clamp rejecting an unaffordable input BEFORE any
//    spend — the invariant holds either way, but each tier must also accept
//    at least one full-size body (a tier that rejects everything is dead).
console.log("\n# chat tiers — worst-case upstream vs price (same math as the runtime clamp)");
const repModels = (tier) => tier.prefixes.map((p) => (p.endsWith("/") ? `${p}family-representative` : p));
const table = [];
for (const [slug, tier] of Object.entries(TIERS)) {
  let worst = 0, worstLabel = "", acceptedFull = 0, rejected = 0;
  const variants = (model) => [
    // adversarial: dense CJK at the char cap + 4 images + fat tools + n=4 + max output
    { model, messages: [{ role: "user", content: [{ type: "text", text: denseText(tier.maxInputChars) }, TINY_IMG, TINY_IMG, TINY_IMG, TINY_IMG] }], max_tokens: 999999, n: 4, tools: BIG_TOOLS, images: 4 },
    // plain full-size English body at the caps
    { model, messages: [{ role: "user", content: "the quick brown fox. ".repeat(Math.floor(tier.maxInputChars / 21)) }], max_tokens: 999999, images: 0 },
    // the priority service tier (pro/premium, 2026-09-18): the same full-size
    // body priced at PRIORITY_PRICE_FACTOR - the clamp must still land under
    // the price, or refuse pre-spend. Other tiers refuse the knob (a 400).
    ...(tier.priority === true ? [{ model, messages: [{ role: "user", content: "the quick brown fox. ".repeat(Math.floor(tier.maxInputChars / 21)) }], max_tokens: 999999, images: 0, service_tier: "priority" }] : []),
  ];
  const models = [...repModels(tier)];
  if (tier.router === true) models.push(undefined); // routed request (server picks the model)
  for (const model of models) {
    for (const body of variants(model ?? "unused")) {
      const { images, ...input } = body;
      if (model === undefined) delete input.model;
      let v;
      try { v = validateRequest(input, slug); }
      catch (e) { if (e.statusCode !== 400) throw e; rejected++; continue; } // clamp refused pre-spend — invariant upheld
      const wc = worstCaseUpstreamCost(v, tier, images);
      if (tier.metered) {
        // Metered: no flat price to stay under. The invariant is that the per-request
        // QUOTE covers the worst case with the markup on top (an over-cap body never
        // reaches here: validateRequest refused it pre-spend).
        const q = meteredQuoteUsd(v);
        ok(!q.invalid && q.usd >= wc.totalUsd * METER_MARKUP - 1e-9, `${slug} ${v.model} quote covers worst-case x METER_MARKUP`);
      } else {
        ok(wc.totalUsd < tier.price, `${slug} ${v.model} worst-case < price $${tier.price}`);
      }
      if (wc.totalUsd > worst) { worst = wc.totalUsd; worstLabel = v.model; }
      if (!body.n) acceptedFull++;
    }
  }
  ok(acceptedFull > 0, `${slug} accepts at least one full-size body (${acceptedFull} accepted, ${rejected} clamp-rejected pre-spend)`);
  table.push({ tier: slug, price: tier.price, worst, model: worstLabel });
}

// ---------------------------------------------------------------------------
// 1b. Metered input past the 200k floor: a model whose live context window is
//     large takes up to the 1 MB body bound (maxInputCharsFor). At that size
//     the quote must still cover the worst case x the markup (long-context
//     rows included), or the body is refused pre-spend at the per-call cap.
console.log("\n# metered tier at the raised input cap (large context windows)");
{
  const { _setModelCatalogForTest } = await import("../src/model-catalog.js");
  const { maxInputCharsFor, METERED_MAX_INPUT_CHARS_CEILING, canonicalModel } = await import("../src/tools/llm-gateway-kit.js");
  const tier = TIERS["v1-chat-metered"];
  const models = [...new Set(repModels(tier).filter((m) => !m.endsWith("family-representative")).map((m) => canonicalModel(m)))];
  const ids = [...models]; for (let i = 0; i < 120; i++) ids.push(`filler/m-${i}`);
  _setModelCatalogForTest(ids, Date.now(), Object.fromEntries(models.map((m) => [m, 2_000_000])));
  let quoted = 0, refusedCap = 0;
  for (const model of models) {
    const cap = maxInputCharsFor("v1-chat-metered", model);
    ok(cap === METERED_MAX_INPUT_CHARS_CEILING, `${model} takes the ceiling with a large window (${cap})`);
    for (const content of [denseText(cap), "the quick brown fox. ".repeat(Math.ceil(cap / 21)).slice(0, cap)]) {
      let v;
      try { v = validateRequest({ model, messages: [{ role: "user", content }], max_tokens: 999999 }, "v1-chat-metered"); }
      catch (e) { if (e.statusCode !== 400 || !/per-call cap/.test(e.message)) throw e; refusedCap++; continue; }
      const wc = worstCaseUpstreamCost(v, tier, 0);
      const q = meteredQuoteUsd({ model, messages: [{ role: "user", content }], max_tokens: 999999 });
      ok(!q.invalid && !q.overCap && q.usd >= wc.totalUsd * METER_MARKUP - 1e-9, `metered ${model} at ${content.length} chars: quote covers worst-case x METER_MARKUP`);
      quoted++;
    }
    let over = null;
    try { validateRequest({ model, messages: [{ role: "user", content: "x".repeat(cap + 1) }], max_tokens: 5 }, "v1-chat-metered", { clamp: false }); } catch (e) { over = e; }
    ok(over?.statusCode === 400 && over?.maxInputChars === cap, `${model}: one char past its cap is refused with the cap named`);
  }
  ok(quoted > 0, `some full-ceiling bodies quote under the per-call cap (${quoted} quoted, ${refusedCap} refused at the cap pre-spend)`);
  _setModelCatalogForTest(null);
}

// ---------------------------------------------------------------------------
// 2. Failover chain — the margin must hold on EVERY link, not just the
//    requested model. Pre-fix, the clamp ran once against the requested
//    model's cost, so a cheap-model clamp (a no-op) rode unchanged to a
//    pricier fallback and inverted the margin. Documented, then locked.
console.log("\n# failover chain — every candidate model re-clamped at its own cost");
{
  const nano = TIERS["v1-chat-nano"];
  // The inversion the re-clamp closes: gpt-4.1-nano clamp is a no-op at
  // n=4 × 768 out; that body priced at deepseek's bound busts the price.
  const unclamped = { model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "hi" }], max_tokens: 768, n: 4 };
  const preFix = worstCaseUpstreamCost(unclamped, nano, 0);
  ok(preFix.totalUsd > nano.price, `documented: UNclamped fallback body would bill over the $${nano.price} price (why the re-clamp exists)`);

  // Behavioral: primary 502s, the fallback outbound body must be re-clamped.
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const outbounds = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    outbounds.push(body);
    if (body.model === "mistralai/ministral-8b-2512") return { ok: false, status: 502, text: async () => "provider down" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-m", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }) };
  };
  const nanoTool = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-nano");
  const res = await nanoTool.handler({ model: "mistralai/ministral-8b-2512", messages: [{ role: "user", content: "hi" }], max_tokens: 768, n: 4 });
  ok(res.model === "deepseek/deepseek-chat", `failover still serves the buyer (served ${res.model})`);
  ok(outbounds[0].model === "mistralai/ministral-8b-2512" && outbounds[0].max_tokens === 768, "primary model keeps its own clamp (768 out — no behavior change)");
  const fb = outbounds[1];
  ok(fb.model === "deepseek/deepseek-chat" && fb.max_tokens < 768, "fallback outbound is re-clamped at its own cost (max_tokens below 768)");
  const fbWc = worstCaseUpstreamCost(fb, nano, 0);
  ok(fbWc.totalUsd < nano.price, `re-clamped fallback worst-case < price $${nano.price}`);
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;

  // Exhaustive: every fallback / auto-ranking model on every tier, at the
  // tier's full output cap with n=4, re-clamps to under the price.
  for (const [slug, tier] of Object.entries(TIERS)) {
    const chainModels = new Set([
      ...(tier.fallbacks || []),
      ...(tier.router === true ? Object.values(AUTO_RANKINGS).flatMap((byCat) => Object.values(byCat).flat()) : []),
    ]);
    for (const model of chainModels) {
      const attempt = { model, messages: [{ role: "user", content: "hi" }], max_tokens: tier.maxTokens, n: 4 };
      try { clampToMargin(attempt, tier, 0); }
      catch (e) { if (e.statusCode !== 400) throw e; ok(true, `${slug} chain ${model}: clamp-rejected pre-spend`); continue; }
      const wc = worstCaseUpstreamCost(attempt, tier, 0);
      if (!tier.metered) ok(wc.totalUsd < tier.price, `${slug} chain ${model} re-clamped worst-case < price $${tier.price}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. /v1/embeddings — the char cap alone couldn't bound the bill (dense CJK
//    ≈ 2 cl100k tokens/char → 16k chars ≈ 32k tokens, over the price on
//    3-large). The token clamp must refuse that BEFORE any spend.
console.log("\n# /v1/embeddings — token-density margin clamp");
{
  // 64-item batches keep each item under OpenAI's 8,191-token/item limit, so
  // the upstream would ACCEPT (and bill) the dense batch — the clamp is ours.
  const denseBatch = Array.from({ length: 8 }, () => denseText(2000)); // 16k chars ≈ 32k tokens
  const preFix = embeddingsUpstreamCost({ model: "text-embedding-3-large", input: denseBatch });
  ok(preFix.totalUsd > EMBEDDINGS_PRICE, `documented: dense 16k-char batch would bill over the $${EMBEDDINGS_PRICE} price on 3-large (${preFix.tokens} tokens)`);
  await rejects(() => validateEmbeddingsRequest({ model: "text-embedding-3-large", input: denseBatch }), "token-dense", "3-large refuses the token-dense batch pre-spend");
  await rejects(() => validateEmbeddingsRequest({ model: "text-embedding-ada-002", input: denseBatch }), "token-dense", "ada-002 refuses the token-dense batch pre-spend");
  const small = validateEmbeddingsRequest({ model: "text-embedding-3-small", input: denseBatch });
  const smallWc = embeddingsUpstreamCost(small);
  ok(smallWc.totalUsd < EMBEDDINGS_PRICE, `3-small serves the dense batch under $${EMBEDDINGS_PRICE}`);
  for (const model of ["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"]) {
    const v = validateEmbeddingsRequest({ model, input: "the quick brown fox. ".repeat(761) }); // ~16k chars of English
    const wc = embeddingsUpstreamCost(v);
    ok(wc.totalUsd < EMBEDDINGS_PRICE, `${model} full-size English body bills under $${EMBEDDINGS_PRICE}`);
  }
  // The clamp's own ceiling is the margin bound: accepted worst ≤ MARGIN x price.
  table.push({ tier: "v1-embeddings", price: EMBEDDINGS_PRICE, worst: EMBEDDINGS_PRICE * MARGIN, model: "any (clamp ceiling)" });
  // /v1/rerank: caps keep every call at ONE Cohere search unit (live
  // 2026-08-19) - the bound is structural, so the row is the measured unit price.
  {
    const { RERANK_PRICE, validateRerankRequest } = await import("../src/tools/llm-gateway-kit.js");
    const RERANK_UNIT_USD = upstreamCosts().fees.rerankPerUnit;
    ok(Number.isFinite(RERANK_UNIT_USD) && RERANK_UNIT_USD <= RERANK_PRICE * MARGIN, `rerank: one search unit within the margin bound of $${RERANK_PRICE}`);
    const maxed = validateRerankRequest({ query: "q".repeat(500), documents: Array.from({ length: 25 }, () => "x".repeat(1600)) });
    ok(maxed.documents.length <= 100 && maxed.documents.every((d) => d.length <= 1600), "rerank: the largest accepted body is still one Cohere search unit (<=100 docs, short docs)");
    table.push({ tier: "v1-rerank", price: RERANK_PRICE, worst: RERANK_UNIT_USD, model: "cohere/rerank-v3.5 (1 search unit)" });
  }

  // Cap-before-spend: the handler must throw with ZERO upstream fetches.
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("unexpected upstream fetch"); };
  const embTool = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-embeddings");
  await rejects(() => embTool.handler({ model: "text-embedding-3-large", input: denseBatch }), "token-dense", "embeddings handler rejects over-budget input");
  ok(fetches === 0, "…and made zero upstream fetches doing it");
  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------------------
// 4. /v1/images/generations - served by flat per-image links on OpenRouter's
//    Image API (IMAGE_TIERS["v1-images"]), each pinned to one provider with a
//    fixed bound and a live-listing re-check. Every link's bound must sit
//    within MARGIN x the route price, like the fast/pro image tiers.
console.log("\n# /v1/images/generations - per-link bounds");
{
  const { IMAGE_TIERS, withinMargin, linkBounds } = await import("../src/tools/llm-images-fast-kit.js");
  const tier = IMAGE_TIERS["v1-images"];
  ok(tier && tier.price === IMAGES_PRICE && tier.chain.length >= 1, `images route price comes from the gateway constant ($${IMAGES_PRICE})`);
  for (const link of tier.chain) {
    const b = linkBounds(link);
    ok(b && withinMargin(IMAGES_PRICE, b.worstCaseUsd) && b.listedMaxUsd > 0 && link.provider, `images link ${link.model}: bound within ${MARGIN} x $${IMAGES_PRICE}, provider-pinned, live price re-checked`);
  }
  const worst = Math.max(...tier.chain.map((l) => linkBounds(l)?.worstCaseUsd ?? Infinity));
  table.push({ tier: "v1-images", price: IMAGES_PRICE, worst, model: tier.chain[0].model });

  // Cap-before-spend: over-cap prompt throws with zero fetches.
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("unexpected upstream fetch"); };
  const imgTool = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-images");
  await rejects(() => imgTool.handler({ prompt: "x".repeat(IMAGES_MAX_PROMPT_CHARS + 1) }), "Prompt too long", "images handler rejects an over-cap prompt");
  ok(fetches === 0, "…and made zero upstream fetches doing it");
  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------------------
// 5. STT — the duration cap is enforced from a LOCAL header probe before the
//    file ever reaches OpenAI (upstream bills per audio minute). Over-cap and
//    unreadable audio must throw with zero fetches.
console.log("\n# STT — cap-before-spend (local duration probe)");
{
  const wav = (sec, rate = 8000) => {
    const n = Math.round(sec * rate);
    const b = Buffer.alloc(44 + n);
    b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8);
    b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
    b.write("data", 36); b.writeUInt32LE(n, 40);
    return b;
  };
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("unexpected upstream fetch"); };
  // Caps and rates are READ from the kit (STT_TIERS / upstreamUsdPerMinute),
  // never retyped here: this block once carried a stale cap and rate for the standard
  // tier after the kit had moved to gpt-transcribe at 4 min (2026-09-18), and a
  // hand copy of the truth is how a margin guard goes stale in the safe-looking
  // direction. The over-cap probe is the cap plus 20 s; the in-cap probe is 40 s under it.
  const capS = (slug) => STT_TIERS[slug].maxMinutes * 60;
  await rejects(() => assertWithinDurationCap(wav(capS("transcribe") + 20), "audio.wav", "transcribe"), `up to ${STT_TIERS.transcribe.maxMinutes} minutes`, `transcribe rejects audio 20 s past its ${STT_TIERS.transcribe.maxMinutes}-min cap`);
  await rejects(() => assertWithinDurationCap(wav(capS("transcribe-pro") + 20), "audio.wav", "transcribe-pro"), `up to ${STT_TIERS["transcribe-pro"].maxMinutes} minutes`, `transcribe-pro rejects audio 20 s past its ${STT_TIERS["transcribe-pro"].maxMinutes}-min cap`);
  // Deterministic non-audio payload: random bytes occasionally form a
  // valid-looking frame header that music-metadata parses (flaky "did not
  // throw" in CI); a fixed ASCII blob is never a readable container.
  await rejects(() => assertWithinDurationCap(Buffer.from("not-a-media-container ".repeat(200)), "audio.mp3", "transcribe"), "Could not read", "unreadable container rejected (would be an unbounded bill)");
  const inCap = capS("transcribe") - 40;
  const dur = await assertWithinDurationCap(wav(inCap), "audio.wav", "transcribe");
  ok(Math.abs(dur - inCap) < 2, `in-cap audio passes the probe (duration ${dur.toFixed(1)}s)`);
  ok((await probeDurationSeconds(wav(60), "audio.wav")) > 58, "probeDurationSeconds reads the header locally");
  ok(fetches === 0, "duration cap enforced with ZERO upstream fetches");
  globalThis.fetch = realFetch;

  // Margin rows from the enforced caps x OpenAI's published per-minute rate for
  // the model each tier actually sends (both gpt-transcribe since 2026-09-18).
  for (const [tier, t] of Object.entries(STT_TIERS)) {
    const rate = upstreamUsdPerMinute(t.model);
    ok(Number.isFinite(rate), `${tier}: per-minute rate known for ${t.model}`);
    const r = { tier, price: t.priceUsd, worst: t.maxMinutes * rate };
    ok(r.worst <= MARGIN * r.price + 1e-12, `${r.tier} worst-case within the margin bound of $${r.price}`);
    table.push({ ...r, model: `openai ${t.model} (per-minute)` });
  }
}

// ---------------------------------------------------------------------------
// 5b. onchain-sql: the query service meters every query, and one call may
//     send SQL_QUERY_BUDGET of them (the buyer's query, then the row-size
//     measure and the filtered run or one small re-run). That many at the
//     table's rate, plus one facilitator settlement when the table prices
//     one, must sit within SQL_WORST_CASE_BOUND x the price. The
//     onchain-analyst pack runs the tool once and its price follows the
//     tool's through the pack rule, so its bundle price is held to the same
//     bound. Figures stay in the process: the rate is private, and only
//     PASS/FAIL/SKIP is printed.
console.log("\n# onchain-sql: the call's query budget vs price");
// Owner decision (2026-11-07): onchain-sql is the one tool held to its own
// worst-case bound instead of the shared MARGIN. Its worst case (every query
// of SQL_QUERY_BUDGET spent, plus a settlement) must keep at least 15% of the
// list price: cost <= 0.85 x price. Queries 2 and 3 run only for the 64 KB
// row-size recovery, so a typical call sends one query and sits far inside
// MARGIN. Every other tool keeps MARGIN.
const SQL_WORST_CASE_BOUND = 0.85;
{
  const { CDP_TOOLS, SQL_QUERY_BUDGET } = await import("../src/tools/cdp-kit.js");
  const { PACK_PRICES, SKILL_PACKS } = await import("../src/skills.js");
  const { vendorRate } = await import("../src/upstream-costs.js");
  const rate = vendorRate("cdp", "sqlQuery");
  if (rate == null) {
    if (process.env.CI && process.env.UPSTREAM_COSTS_OPTIONAL !== "1") ok(false, "onchain-sql: the private table has no vendor.cdp.sqlQuery rate (required under CI)");
    else console.log("SKIP - onchain-sql margin: the private table has no vendor.cdp.sqlQuery rate yet");
  } else {
    // A settlement fee is optional in the table (fees.settlementPerCall); without one the term is zero.
    const settle = upstreamCosts().fees.settlementPerCall ?? 0;
    const priceOf = (s) => Number(String(CDP_TOOLS.find((t) => t.slug === s)?.price ?? "").replace(/[^0-9.]/g, ""));
    const cost = SQL_QUERY_BUDGET * rate + settle;
    const sqlPrice = priceOf("onchain-sql");
    ok(SQL_QUERY_BUDGET >= 3 && Number.isFinite(sqlPrice) && sqlPrice > 0, `onchain-sql: a list price and a query budget of ${SQL_QUERY_BUDGET} to price against`);
    ok(cost <= SQL_WORST_CASE_BOUND * sqlPrice + 1e-12, `onchain-sql: ${SQL_QUERY_BUDGET} queries at the table rate plus a settlement keep at least 15% of the list price: ${cost <= SQL_WORST_CASE_BOUND * sqlPrice + 1e-12 ? "PASS" : "FAIL"}`);
    table.push({ tier: "onchain-sql", price: sqlPrice, worst: cost, model: `${SQL_QUERY_BUDGET} queries (query service)` });
    // The only other route that sends a buyer's query to the query service is
    // the onchain-analyst pack (skill-runner.js runs onchain-sql once); the
    // schema step reads the schema endpoint, which is not a query.
    const packs = SKILL_PACKS.filter((p) => (p.toolSlugs || []).includes("onchain-sql"));
    ok(packs.length === 1 && packs[0].slug === "onchain-analyst", `one skill pack runs onchain-sql (${packs.map((p) => p.slug).join(", ") || "none"})`);
    for (const p of packs) {
      const packPrice = Number(PACK_PRICES[p.slug]);
      ok(cost <= SQL_WORST_CASE_BOUND * packPrice + 1e-12, `${p.slug} pack: ${SQL_QUERY_BUDGET} queries plus a settlement keep at least 15% of its bundle price: ${cost <= SQL_WORST_CASE_BOUND * packPrice + 1e-12 ? "PASS" : "FAIL"}`);
      table.push({ tier: p.slug, price: packPrice, worst: cost, model: `${SQL_QUERY_BUDGET} queries (one onchain-sql step)` });
    }
  }
}

// ---------------------------------------------------------------------------
// 5c. X data tools: X bills per object returned, the objects under
//     `includes` from an expansion among them (X notice, 2026-11-05). Each
//     tool's worst case for each body shape that changes what it reads (every
//     read its handler sends, at its largest page, one expanded author per
//     post) comes from the kit's own estimator (xToolWorstCases) and must sit
//     within the MARGIN bound of the tool's fixed price. Every X tool stays
//     fixed-price. Figures stay in the process: only PASS/FAIL is printed.
//
//     DATED EXCEPTION (2026-11-07), x-search-recent: its rows carry author
//     usernames from the author expansion, and with one expanded user per
//     post billed at the user-read rate its worst case falls under MARGIN at
//     the current price. X's notice of 2026-11-05 says expansions will count
//     toward usage but gives no effective date and no rate, and X's billing
//     docs still meter posts only. Until X publishes both, only the worst case
//     WITHOUT expansion billing is held to MARGIN here. When X publishes an
//     effective date and rate, reprice x-search-recent from those real numbers
//     and remove this exception. The kit's daily cap and spend meter already
//     count expanded objects either way.
const X_EXPANSION_BILLING_PENDING = new Map([["x-search-recent", "2026-11-07"]]);
console.log("\n# X data tools: worst-case reads, expansions included, vs price");
{
  const { X_DATA_TOOLS, xToolWorstCases } = await import("../src/tools/x-data-kit.js");
  if (upstreamCosts().vendor?.x?.postRead == null || upstreamCosts().vendor?.x?.userRead == null) {
    if (process.env.CI && process.env.UPSTREAM_COSTS_OPTIONAL !== "1") ok(false, "x data: the private table has no vendor.x rates (required under CI)");
    else console.log("SKIP - x data margin: the private table has no vendor.x rates");
  } else {
    for (const t of X_DATA_TOOLS) {
      const price = Number(String(t.price).replace(/[^0-9.]/g, ""));
      ok(Number.isFinite(price) && price > 0 && t.quote === undefined && t.tierQuote === undefined, `${t.slug}: a fixed list price`);
      const cases = xToolWorstCases(t.slug);
      ok(cases.length >= 1, `${t.slug}: at least one worst-case body`);
      const pending = X_EXPANSION_BILLING_PENDING.get(t.slug);
      for (const { body, usd, usdWithoutExpansions } of cases) {
        const label = `${t.slug} ${JSON.stringify(body)}`;
        if (pending) {
          ok(Number.isFinite(usdWithoutExpansions) && usdWithoutExpansions < usd, `${label}: the worst case without expansion billing is computed`);
          const within = usdWithoutExpansions <= MARGIN * price + 1e-12;
          ok(within, `${label}: worst-case reads without expansion billing within the margin bound of the list price: ${within ? "PASS" : "FAIL"}`);
          console.log(`EXCEPTION - ${label}: expansion billing not yet priced (dated ${pending}; reprice when X publishes an effective date and rate): ${usd <= MARGIN * price + 1e-12 ? "within" : "outside"} the bound with expansions`);
          table.push({ tier: t.slug, price, worst: usdWithoutExpansions, model: "X reads (expansions unbilled, dated exception)" });
        } else {
          const within = usd <= MARGIN * price + 1e-12;
          ok(within, `${label}: worst-case reads, expansions included, within the margin bound of the list price: ${within ? "PASS" : "FAIL"}`);
          table.push({ tier: t.slug, price, worst: usd, model: `X reads ${JSON.stringify(body)}` });
        }
      }
    }
    // The exception list names only live X tools.
    for (const slug of X_EXPANSION_BILLING_PENDING.keys()) ok(X_DATA_TOOLS.some((t) => t.slug === slug), `expansion-billing exception names a live X tool (${slug})`);
  }
}

// ---------------------------------------------------------------------------
// 6. tool_gone telemetry — every retired-route hit (transparently served 200
// or teaching 410) must be visible in PostHog.
console.log("\n# tool_gone — retired-route telemetry");
{
  const events = _testEventsForTest();
  events.splice(0, events.length);
  capturePostHogToolGone({ route: "/api/convert-meters-to-feet", replacement: "POST /api/unit-convert" });
  capturePostHogToolGone({ route: "/api/convert-meters-to-feet", replacement: "POST /api/unit-convert" });
  ok(events.length === 0, "tool_gone is rolled up (no event before the flush)");
  _flushPaywallRollupForTest();
  const got = events.splice(0, events.length).filter((e) => e.event === "tool_gone");
  ok(got.length === 1 && got[0].event === "tool_gone" && got[0].properties.count === 2, "flush emits one tool_gone event per route with the hit count");
  ok(got[0].properties.route === "/api/convert-meters-to-feet" && got[0].properties.replacement === "POST /api/unit-convert",
    "event carries route + replacement");
  ok(Object.keys(got[0].properties).filter((k) => !k.startsWith("$")).sort().join(",") === "client,count,payment,refererHost,replacement,route,surface,uaFamily",
    "properties are {count, route, replacement} plus the coarse source fields only (no address, wallet or full User-Agent)");

  // Integration: a real retired-route hit on a booted server fires the event.
  const PORT = 3179, B = `http://127.0.0.1:${PORT}`;
  const proc = spawn("node", ["src/server.js"], {
    env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), POSTHOG_TEST_CAPTURE: "1", POSTHOG_PAYWALL_FLUSH_MS: "1000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  proc.stdout.on("data", (d) => { serverLog += d; });
  proc.stderr.on("data", (d) => { serverLog += d; });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let up = false;
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) { up = true; break; } } catch {} await sleep(500); }
    ok(up, "free-mode server booted");

    // Retired routes we CAN answer are transparently served (200 + shim
    // markers) and emit NO event — tool_gone is reserved for the teaching
    // 410s, so it means "a caller we could not serve". (A marketplace crawler
    // sweeping the ~650 cached converter listings hourly was burning ~425k
    // served-fine events/mo before this split, 2026-07-16.)
    const res = await fetch(`${B}/api/convert-meters-to-feet?value=5`);
    const body = await res.json();
    ok(res.status === 200, `retired convert route transparently serves 200 (got ${res.status})`);
    ok(Math.abs((body.result ?? NaN) - 5 / 0.3048) < 1e-6 && body._retired === true && body._replacement === "unit-convert",
      "served body carries the real conversion + shim markers");
    const res2 = await fetch(`${B}/api/convert/kilograms-to-pounds`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: 2 }),
    });
    ok(res2.status === 200, `slash-form retired route transparently serves 200 (got ${res2.status})`);
    // A valueless hit can't be served — the teaching 410 path, which DOES emit.
    const res410 = await fetch(`${B}/api/convert/kilograms-to-pounds`);
    ok(res410.status === 410, `valueless retired route teaches with a 410 (got ${res410.status})`);

    await sleep(1800); // let the rollup flush (1s window) + stdout drain
    const captured = serverLog.split("\n")
      .filter((l) => l.includes("[posthog-test]"))
      .map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } })
      .filter((e) => e && e.event === "tool_gone");
    const routes = captured.map((e) => e.properties.route);
    ok(!routes.includes("/api/convert-meters-to-feet"), `served slug-form hit emits NO tool_gone (got: ${routes.join(", ") || "none"})`);
    ok(routes.filter((r) => r === "/api/convert/kilograms-to-pounds").length === 1 && captured.find((e) => e.properties.route === "/api/convert/kilograms-to-pounds")?.properties.count === 1,
      "only the unservable (410) hit emits tool_gone (one rolled-up row, count 1)");
    ok(captured.every((e) => e.properties.replacement === "POST /api/unit-convert"), "every tool_gone names the replacement route");

    // Source attribution on the wire: a retired-tool hit names its client
    // coarsely (UA family, library hint, payment header family, Referer host,
    // surface), and nothing finer.
    const gone = await fetch(`${B}/api/workday-count`, { headers: { "User-Agent": "x402-fetch/0.6.1 (node)", Referer: "https://list.example.org/old/catalog?k=v", "X-PAYMENT": "eyJub3QiOiJyZWFsIn0" } });
    ok(gone.status === 410, `a retired tool answers 410 (got ${gone.status})`);
    // ...and a retired slug over the MCP connector is named as retired, with the
    // replacement, and counted on the mcp surface.
    const mcpCall = await fetch(`${B}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "User-Agent": "python-httpx/0.27" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "catalog.call", arguments: { slug: "workday-count", params: {} } } }) });
    const mcpText = await mcpCall.text();
    ok(/retired on 2026-08-25/.test(mcpText) && /business-days/.test(mcpText), `catalog.call on a retired slug names the retirement and the replacement (got ${mcpText.slice(0, 160)})`);
    await sleep(1800);
    const rows = serverLog.split("\n").filter((l) => l.includes("[posthog-test]"))
      .map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } })
      .filter((e) => e && e.event === "tool_gone" && e.properties.route === "/api/workday-count");
    const http = rows.find((e) => e.properties.surface === "http");
    const mcp = rows.find((e) => e.properties.surface === "mcp");
    ok(http && http.properties.uaFamily === "x402-fetch" && http.properties.client === "x402-fetch" && http.properties.payment === "x402" && http.properties.refererHost === "list.example.org",
      `the HTTP hit carries its coarse source (got ${JSON.stringify(http?.properties || null)})`);
    ok(mcp && mcp.properties.uaFamily === "python-httpx" && mcp.properties.payment === "none", `the MCP hit is counted on the mcp surface (got ${JSON.stringify(mcp?.properties || null)})`);
    ok(!/127\.0\.0\.1|\/old\/catalog|k=v|0\.6\.1|eyJub3Qi/.test(JSON.stringify(rows)), "no address, Referer path or query, UA version or payment value in any row");
  } catch (e) {
    ok(false, `tool_gone integration leg threw: ${e.message}`);
  } finally {
    proc.kill("SIGKILL");
  }
}

// ---------------------------------------------------------------------------
// Pricing table.
// Figures stay in the process: CI logs are public, and upstream cost is not.
console.log(`\n# pricing table — ${table.length} rows checked (worst-case upstream vs price)`);
for (const r of table) {
  console.log(`  ${r.tier.padEnd(18)} price $${String(r.price).padEnd(6)} within bound: ${r.worst < r.price ? "yes" : "NO"}  (${r.model})`);
}

// ---- price by model keeps every tier's margin bound (2026-09-22) -----------
// A flat route asked for another flat tier's model is priced at the model's
// HOME tier and served under that tier's config, so its margin is the home
// tier's, which the sweeps above already bound. The invariant to hold is that
// the price charged and the config served are ALWAYS the same tier: for every
// flat route and every flat-tier model, the quote equals the tier that serves
// it, and a stash below the home price never unlocks the home config.
{
  const { flatTierQuoteUsd, servedTierFor, isFlatTier, tierFor } = await import("../src/tools/llm-gateway-kit.js");
  const flat = Object.keys(TIERS).filter(isFlatTier);
  let pairs = 0, mismatches = [];
  for (const route of flat) {
    for (const home of flat) {
      for (const p of TIERS[home].prefixes) {
        if (p.endsWith("/")) continue; // a family prefix is not a model id
        if (tierFor(p) !== home) continue; // admitted by an earlier tier: that tier is its home
        pairs++;
        const q = flatTierQuoteUsd(route, p);
        const served = servedTierFor(route, p, { __meteredQuoteUsd: q });
        if (TIERS[served].price !== q) mismatches.push(`${route} + ${p}: quoted ${q}, served ${served}`);
        if (route !== home && TIERS[route].price < TIERS[home].price && servedTierFor(route, p, { __meteredQuoteUsd: TIERS[route].price }) !== route) {
          mismatches.push(`${route} + ${p}: a stash at the route price unlocked ${home}`);
        }
      }
    }
  }
  ok(pairs > 50 && mismatches.length === 0, `price by model: across ${pairs} route x model pairs the quoted price is always the price of the tier that serves (${mismatches.slice(0, 3).join("; ") || "no mismatch"})`);
  // A crossed call is clamped by the SERVED tier: the premium bound holds for a premium model reached through the base route.
  const probe = { model: "anthropic/claude-opus-5", messages: [{ role: "user", content: "x".repeat(4000) }], max_tokens: 8192 };
  clampToMargin(probe, TIERS[servedTierFor("v1-chat", probe.model, { __meteredQuoteUsd: TIERS["v1-chat-premium"].price })], 0);
  const wc = worstCaseUpstreamCost(probe, TIERS["v1-chat-premium"], 0).totalUsd;
  ok(wc <= MARGIN * TIERS["v1-chat-premium"].price + 1e-9, `a premium model reached through the base route is clamped under the premium bound`);
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
