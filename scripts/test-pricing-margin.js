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
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

// Route PostHog captures to the in-memory test sink BEFORE anything imports
// posthog.js (the module freezes its mode at import time).
process.env.POSTHOG_TEST_CAPTURE = "1";

const {
  TIERS,
  MODEL_COST,
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
  IMAGES_MAX_TOKENS,
  IMAGES_MAX_PRICE,
  IMAGES_MAX_PROMPT_CHARS,
  meteredQuoteUsd,
} = await import("../src/tools/llm-gateway-kit.js");
const { METER_MARKUP } = await import("../src/gateway-meter.js");
const { countTokens } = await import("gpt-tokenizer/model/gpt-4o");
const { assertWithinDurationCap, probeDurationSeconds } = await import("../src/tools/stt-kit.js");
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
const usd = (v) => `$${v.toFixed(6)}`;
const marginPct = (wc, price) => `${((1 - wc / price) * 100).toFixed(0)}%`;

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
        ok(!q.invalid && q.usd >= wc.totalUsd * METER_MARKUP - 1e-9, `${slug} ${v.model} quote ${usd(q.usd)} covers worst-case ${usd(wc.totalUsd)} x ${METER_MARKUP}`);
      } else {
        ok(wc.totalUsd < tier.price, `${slug} ${v.model} worst-case ${usd(wc.totalUsd)} < price $${tier.price}`);
      }
      if (wc.totalUsd > worst) { worst = wc.totalUsd; worstLabel = v.model; }
      if (!body.n) acceptedFull++;
    }
  }
  ok(acceptedFull > 0, `${slug} accepts at least one full-size body (${acceptedFull} accepted, ${rejected} clamp-rejected pre-spend)`);
  table.push({ tier: slug, price: tier.price, worst, model: worstLabel });
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
  ok(preFix.totalUsd > nano.price, `documented: UNclamped fallback body would bill ${usd(preFix.totalUsd)} > $${nano.price} price (why the re-clamp exists)`);

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
  ok(fb.model === "deepseek/deepseek-chat" && fb.max_tokens < 768, `fallback outbound is re-clamped at its own cost (max_tokens ${fb.max_tokens} < 768)`);
  const fbWc = worstCaseUpstreamCost(fb, nano, 0);
  ok(fbWc.totalUsd < nano.price, `re-clamped fallback worst-case ${usd(fbWc.totalUsd)} < price $${nano.price} (margin +${marginPct(fbWc.totalUsd, nano.price)})`);
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
      if (!tier.metered) ok(wc.totalUsd < tier.price, `${slug} chain ${model} re-clamped worst-case ${usd(wc.totalUsd)} < price $${tier.price}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. /v1/embeddings — the char cap alone couldn't bound the bill (dense CJK
//    ≈ 2 cl100k tokens/char → 16k chars ≈ 32k tokens: $0.0042 on 3-large vs
//    the $0.002 price). The token clamp must refuse that BEFORE any spend.
console.log("\n# /v1/embeddings — token-density margin clamp");
{
  // 64-item batches keep each item under OpenAI's 8,191-token/item limit, so
  // the upstream would ACCEPT (and bill) the dense batch — the clamp is ours.
  const denseBatch = Array.from({ length: 8 }, () => denseText(2000)); // 16k chars ≈ 32k tokens
  const preFix = embeddingsUpstreamCost({ model: "text-embedding-3-large", input: denseBatch });
  ok(preFix.totalUsd > EMBEDDINGS_PRICE, `documented: dense 16k-char batch would bill ${usd(preFix.totalUsd)} on 3-large > $${EMBEDDINGS_PRICE} price (${preFix.tokens} tokens)`);
  await rejects(() => validateEmbeddingsRequest({ model: "text-embedding-3-large", input: denseBatch }), "token-dense", "3-large refuses the token-dense batch pre-spend");
  await rejects(() => validateEmbeddingsRequest({ model: "text-embedding-ada-002", input: denseBatch }), "token-dense", "ada-002 refuses the token-dense batch pre-spend");
  const small = validateEmbeddingsRequest({ model: "text-embedding-3-small", input: denseBatch });
  const smallWc = embeddingsUpstreamCost(small);
  ok(smallWc.totalUsd < EMBEDDINGS_PRICE, `3-small serves the dense batch at ${usd(smallWc.totalUsd)} < $${EMBEDDINGS_PRICE} (margin +${marginPct(smallWc.totalUsd, EMBEDDINGS_PRICE)})`);
  for (const model of ["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"]) {
    const v = validateEmbeddingsRequest({ model, input: "the quick brown fox. ".repeat(761) }); // ~16k chars of English
    const wc = embeddingsUpstreamCost(v);
    ok(wc.totalUsd < EMBEDDINGS_PRICE, `${model} full-size English body bills ${usd(wc.totalUsd)} < $${EMBEDDINGS_PRICE}`);
  }
  // The clamp's own ceiling is the margin bound: accepted worst ≤ 70% of price.
  table.push({ tier: "v1-embeddings", price: EMBEDDINGS_PRICE, worst: EMBEDDINGS_PRICE * MARGIN, model: "any (clamp ceiling)" });
  // /v1/rerank: caps keep every call at ONE Cohere search unit (live 2026-08-19:
  // $0.001) - the bound is structural, so the row is the measured unit price.
  {
    const { RERANK_PRICE, validateRerankRequest } = await import("../src/tools/llm-gateway-kit.js");
    const RERANK_UNIT_USD = 0.001;
    ok(RERANK_UNIT_USD <= RERANK_PRICE * MARGIN, `rerank: one search unit (${usd(RERANK_UNIT_USD)}) within the 70% bound of $${RERANK_PRICE}`);
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
// 4. /v1/images/generations — server-owned bounds must sum below the price.
//    Output is IMAGES_MAX_TOKENS at the completion bound (image output is
//    token-metered; the `image` max_price dimension prices INPUT images,
//    which this route does not accept), plus the prompt at its bound, plus
//    the per-request fee allowance — which is the regression this test locks
//    at ≤ $0.005 (it was $0.05: a standing allowance that inverted the sum).
console.log("\n# /v1/images/generations — provider-bound arithmetic");
{
  const promptTokens = Math.ceil(countTokens(denseText(IMAGES_MAX_PROMPT_CHARS)) * 1.15);
  const worst =
    (promptTokens / 1e6) * IMAGES_MAX_PRICE.prompt +
    (IMAGES_MAX_TOKENS / 1e6) * IMAGES_MAX_PRICE.completion +
    IMAGES_MAX_PRICE.request;
  ok(worst < IMAGES_PRICE, `images worst-case ${usd(worst)} < price $${IMAGES_PRICE} (dense prompt ${promptTokens} tok + ${IMAGES_MAX_TOKENS} out + request fee bound)`);
  ok(IMAGES_MAX_PRICE.request <= 0.005, `per-request fee allowance stays tight (${IMAGES_MAX_PRICE.request} ≤ 0.005 — was 0.05, which inverted the sum)`);
  table.push({ tier: "v1-images", price: IMAGES_PRICE, worst, model: "google/gemini-2.5-flash-image" });

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
  await rejects(() => assertWithinDurationCap(wav(320), "audio.wav", "transcribe"), "up to 5 minutes", "transcribe rejects 5.3 min audio (cap 5 min)");
  await rejects(() => assertWithinDurationCap(wav(620), "audio.wav", "transcribe-pro"), "up to 10 minutes", "transcribe-pro rejects 10.3 min audio (cap 10 min)");
  // Deterministic non-audio payload — random bytes occasionally form a
  // valid-looking frame header that music-metadata parses (flaky "did not
  // throw" in CI); a fixed ASCII blob is never a readable container.
  await rejects(() => assertWithinDurationCap(Buffer.from("not-a-media-container ".repeat(200)), "audio.mp3", "transcribe"), "Could not read", "unreadable container rejected (would be an unbounded bill)");
  const dur = await assertWithinDurationCap(wav(280), "audio.wav", "transcribe");
  ok(Math.abs(dur - 280) < 2, `in-cap audio passes the probe (duration ${dur.toFixed(1)}s)`);
  ok((await probeDurationSeconds(wav(60), "audio.wav")) > 58, "probeDurationSeconds reads the header locally");
  ok(fetches === 0, "duration cap enforced with ZERO upstream fetches");
  globalThis.fetch = realFetch;

  // Margin rows from the enforced caps × OpenAI's published per-minute rates
  // (~$0.003/min mini, ~$0.0045/min gpt-transcribe — see the stt-kit header).
  const stt = [
    { tier: "transcribe", price: 0.03, worst: 5 * 0.003 },
    { tier: "transcribe-pro", price: 0.10, worst: 10 * 0.0045 },
  ];
  for (const r of stt) {
    ok(r.worst < r.price, `${r.tier} worst-case ${usd(r.worst)} < price $${r.price} (margin +${marginPct(r.worst, r.price)})`);
    table.push({ ...r, model: "openai transcribe (per-minute)" });
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
  ok(Object.keys(got[0].properties).filter((k) => !k.startsWith("$")).sort().join(",") === "count,replacement,route",
    "properties are exactly {count, route, replacement} — nothing about the caller");

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
  } catch (e) {
    ok(false, `tool_gone integration leg threw: ${e.message}`);
  } finally {
    proc.kill("SIGKILL");
  }
}

// ---------------------------------------------------------------------------
// Pricing table.
console.log("\n# pricing table — worst-case upstream vs price");
for (const r of table) {
  console.log(
    `  ${r.tier.padEnd(18)} price $${String(r.price).padEnd(6)} worst-case ${usd(r.worst)}  margin +${marginPct(r.worst, r.price)}  (${r.model})`
  );
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
