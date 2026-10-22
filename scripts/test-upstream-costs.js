// The private upstream-cost table (src/upstream-costs.js): parsing, and the
// safe path every caller takes without it. Offline, and the table here is
// FAKE: no real rate belongs in this repo.
delete process.env.UPSTREAM_COSTS_JSON;
delete process.env.UPSTREAM_COSTS_FILE;

const U = await import("../src/upstream-costs.js");
const G = await import("../src/tools/llm-gateway-kit.js");
const I = await import("../src/tools/llm-images-fast-kit.js");
const K = await import("../src/tools/llm-kit.js");
const S = await import("../src/tools/stt-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const status = (fn) => { try { fn(); return 0; } catch (e) { return e.statusCode || -1; } };
const msg = [{ role: "user", content: "hi" }];

// ---- without the table: every caller takes its safe path ----
U.setUpstreamCostsForTest(null);
ok(!U.upstreamCostsLoaded() && U.upstreamCosts().models.length === 0, "no env, no file: not loaded, empty table");
ok(G.costFor("openai/gpt-4o") === null, "costFor answers null (flat tiers price at their max_price bound)");
ok(status(() => G.validateRequest({ model: "openai/gpt-4o-mini", messages: msg }, "v1-chat-metered")) === 503, "metered tier refuses 503 before any charge");
ok(status(() => G.assertMeteredAvailable(G.TIERS["v1-chat-metered"])) === 503 && status(() => G.assertMeteredAvailable(G.TIERS["v1-chat"])) === 0, "assertMeteredAvailable gates the metered tier only");
const flat = G.validateRequest({ model: "openai/gpt-4o-mini", messages: msg }, "v1-chat");
ok(flat && flat.max_tokens > 0, "a flat tier still serves, clamped against its own bound");
ok(G.TIERS["v1-chat-grounded"].fixedUpstreamUsd === null, "the grounded fee reads null, and reading it never throws");
ok(status(() => G.worstCaseUpstreamCost({ model: "openai/gpt-4o-mini", messages: msg, max_tokens: 64 }, G.TIERS["v1-chat-grounded"])) === 503, "grounded pricing refuses 503 without its fee");
ok(status(() => G.validateEmbeddingsRequest({ input: "hello" })) === 503, "embeddings refuse 503 without a rate");
ok(I.linkBounds(I.IMAGE_TIERS["v1-images-fast"].chain[0]) === null && I.videosWorstCaseUsd() === null, "image links and video read no bounds");
ok(I.linkRepriced(I.IMAGE_TIERS["v1-images-fast"].chain[0], [{ provider_tag: "black-forest-labs", pricing: [{ billable: "output_image", unit: "megapixel", cost_usd: 1 }] }]), "a link without bounds counts as repriced (skipped)");
ok(K.openaiCostRow("gpt-4o") === null && K.openaiCostUsd("gpt-4o", { prompt_tokens: 10, completion_tokens: 10 }) === null, "OpenAI telemetry cost is null, never a guess");
ok(S.upstreamUsdPerMinute("gpt-transcribe") === null, "STT rate is null");

// ---- a fake table ----
const FAKE = {
  models: [["acme/", { prompt: 1, completion: 2 }], ["acme/big", { prompt: 3, completion: 4 }], ["bad/", { prompt: "x" }]],
  speech: { "acme/voice": 0.5 },
  fees: { webSearchPerUse: 0.25, groundedPerCall: 0.125 },
  embeddings: { "text-embedding-3-small": 7 },
  openai: { "gpt-4o": { prompt: 1, completion: 9 } },
  sttPerMinute: { "gpt-transcribe": 0.5 },
  media: { "black-forest-labs/flux.2-klein-4b": { worstCaseUsd: 0.5, listedMaxUsd: 0.5 } },
};
U.setUpstreamCostsForTest(FAKE);
ok(U.upstreamCostsLoaded(), "a table with model rows counts as loaded");
ok(G.costFor("acme/big-2") === U.upstreamCosts().models.find(([p]) => p === "acme/big")[1], "longest prefix wins");
ok(G.costFor("bad/x") === null, "a malformed row is dropped, not read as zero");
ok(G.TIERS["v1-chat-grounded"].fixedUpstreamUsd === 0.125 && G.SERVER_TOOL_POLICY["openrouter:web_search"].feeUsdPerUse === 0.25, "fees read through");
ok(K.openaiCostRow("gpt-4o").cached === 1, "an OpenAI row without a cached rate falls back to its prompt rate");
ok(I.linkBounds(I.IMAGE_TIERS["v1-images-fast"].chain[0])?.worstCaseUsd === 0.5 && I.linkBounds(I.IMAGE_TIERS["v1-images-fast"].chain[1]) === null, "media bounds per model; a model without a row has none");

// ---- gaps: a loaded table that lacks a key, or drops a model row, reads "partial" ----
ok(U.upstreamCostsStatus() === "partial", "a table missing required keys reads partial");
{
  const g = U.upstreamCostsGaps();
  ok(g.includes("fees.rerankPerUnit") && g.includes("meter.markup") && g.includes("vendor.exa.search") && g.includes("vendor.x.userRead") && g.includes("models[bad/]"), "gaps name the missing keys and the dropped row");
  ok(!g.includes("fees.webSearchPerUse") && !g.includes("speech"), "gaps leave out what is present");
  ok(g.every((x) => !/[0-9]\.[0-9]/.test(x)), "gaps carry names, never a value");
}
const FULL = { ...FAKE, models: FAKE.models.slice(0, 2), speech: { ...FAKE.speech }, openai: { ...FAKE.openai, "gpt-image-2": { completion: 9, prompt: 1 } }, media: { ...FAKE.media, "black-forest-labs/flux-3-image-klein": { worstCaseUsd: 0.5, listedMaxUsd: 0.5 } }, fees: { ...FAKE.fees, rerankPerUnit: 5 }, meter: { markup: 1.25 }, vendor: { exa: { search: 0.5, instant: 0.5, answer: 0.5, content: 0.5 }, x: { postRead: 0.5, userRead: 0.5 }, decisions: { luna: 0.5, decisionOne: 0.5, jev: 0.5, maxShare: 0.5 } } };
U.setUpstreamCostsForTest(FULL);
ok(U.upstreamCostsStatus() === "ok" && U.upstreamCostsGaps().length === 0, "a complete table reads ok");
U.setUpstreamCostsForTest({ ...FULL, models: [...FULL.models, ["acme/big-pro", { prompt: 0, completion: 9 }]] });
ok(U.upstreamCostsStatus() === "partial" && U.upstreamCostsGaps().join() === "models[acme/big-pro]", "a zero-rate model row (not stealth) is a gap, not a silent fallback to acme/big");
U.setUpstreamCostsForTest({ ...FULL, models: [...FULL.models, ["stealth/x", { prompt: 0, completion: 0 }]] });
ok(U.upstreamCostsStatus() === "ok", "a free stealth row is not a gap");
U.setUpstreamCostsForTest(null);
ok(U.upstreamCostsStatus() === "missing" && U.upstreamCostsGaps().length === 0, "no table reads missing");
U.setUpstreamCostsForTest(FAKE);

// ---- long-context tiers: schema ----
// Placeholder numbers only. R builds a row so no rate literal sits on a line.
const R = (prompt, completion, tiers) => (tiers === undefined ? { prompt, completion } : { prompt, completion, tiers });
const T = (aboveTokens, prompt, completion) => ({ aboveTokens, prompt, completion });
{
  const rows = [
    ["acme/plain", R(1, 2)],
    ["acme/tiered", R(1, 2, [T(100, 2, 4), T(200, 3, 6)])],
    ["acme/unsorted", R(1, 2, [T(200, 3, 6), T(100, 2, 4)])],
    ["acme/dup", R(1, 2, [T(100, 2, 4), T(100, 3, 6)])],
    ["acme/below-base", R(1, 2, [T(100, 0.5, 4)])],
    ["acme/below-prev", R(1, 2, [T(100, 3, 6), T(200, 2, 6)])],
    ["acme/zero", R(1, 2, [T(0, 2, 4)])],
    ["acme/fraction", R(1, 2, [T(100.5, 2, 4)])],
    ["acme/no-rate", R(1, 2, [T(100, 2)])],
    ["acme/not-array", R(1, 2, { aboveTokens: 100, prompt: 2, completion: 4 })],
    ["acme/equal", R(1, 2, [T(100, 1, 2)])],
  ];
  U.setUpstreamCostsForTest({ ...FULL, models: rows });
  const kept = U.upstreamCosts().models.map(([p]) => p);
  ok(JSON.stringify(kept) === JSON.stringify(["acme/plain", "acme/tiered", "acme/equal"]), `valid tiers load; unsorted, duplicate, below-base, below-previous, zero, fractional, rate-less and non-array tiers drop the row (${kept.join(", ")})`);
  const gaps = U.upstreamCostsGaps();
  ok(["unsorted", "dup", "below-base", "below-prev", "zero", "fraction", "no-rate", "not-array"].every((n) => gaps.includes(`models[acme/${n}]`)) && U.upstreamCostsStatus() === "partial", "each dropped tiered row is a named gap, so the table reads partial");
  const plain = U.upstreamCosts().models.find(([p]) => p === "acme/plain")[1];
  ok(!("tiers" in plain) && Object.keys(plain).join() === "prompt,completion", "a row without tiers parses to exactly the old shape");
  const tiered = U.upstreamCosts().models.find(([p]) => p === "acme/tiered")[1];
  ok(Object.isFrozen(tiered.tiers) && tiered.tiers.every(Object.isFrozen), "parsed tiers are frozen");
  // rowRateAt: inclusive at each threshold, the base row object below them.
  ok(U.rowRateAt(tiered, 99) === tiered && U.rowRateAt(tiered, undefined) === tiered && U.rowRateAt(tiered, NaN) === tiered, "below the first tier, or with no size, the base row itself answers");
  ok(U.rowRateAt(tiered, 100) === tiered.tiers[0] && U.rowRateAt(tiered, 199) === tiered.tiers[0], "a prompt AT the threshold takes that tier (min_prompt_tokens is inclusive)");
  ok(U.rowRateAt(tiered, 200) === tiered.tiers[1] && U.rowRateAt(tiered, 1e9) === tiered.tiers[1], "the last tier reached wins");
  ok(U.rowRateAt(plain, 1e9) === plain, "a row without tiers answers itself at any size");
  ok(G.costFor("acme/tiered") === tiered && G.costFor("acme/tiered", 150) === tiered.tiers[0] && G.costFor("acme/plain", 1e9) === plain, "costFor selects by prompt size and keeps the base row's identity without one");
  // The fingerprint of a table without tiers is unchanged by the new field.
  U.setUpstreamCostsForTest({ ...FULL, models: [["acme/plain", R(1, 2)]] });
  const fp1 = U.upstreamCostsSummary().fingerprint;
  U.setUpstreamCostsForTest({ ...FULL, models: [["acme/plain", { prompt: 1, completion: 2 }]] });
  ok(fp1 === U.upstreamCostsSummary().fingerprint && fp1 !== null, "a row without tiers fingerprints the same");
}

// ---- long-context tiers: quote, bound and clamp at the boundary ----
{
  const model = "openai/gpt-4o-mini";
  const metered = G.TIERS["v1-chat-metered"], flatSlug = "v1-chat", flatTier = G.TIERS[flatSlug];
  const long = [{ role: "user", content: "word ".repeat(3000) }];
  const body = (max_tokens = 64) => ({ model, messages: long, max_tokens });
  // Size the boundary from the gateway's own estimate, so the test cannot drift from it.
  U.setUpstreamCostsForTest({ ...FULL, models: [[model, R(1, 2)]] });
  const n = G.promptTokensFor(body(), metered);
  ok(Number.isInteger(n) && n > 1000, `the long body estimates ${n} prompt tokens`);
  const baseQuote = G.meteredQuoteUsd(body()).usd;
  const baseWc = G.worstCaseUpstreamCost(body(), metered);
  ok(baseWc.promptTokens === n && baseWc.longContext === false, "without tiers the worst case reports its prompt size and no long-context tier");
  const withTier = (above) => U.setUpstreamCostsForTest({ ...FULL, models: [[model, R(1, 2, [T(above, 4, 8)])]] });
  // One token past the estimate: the base row prices it (unchanged quote).
  withTier(n + 1);
  ok(G.meteredQuoteUsd(body()).usd === baseQuote && G.worstCaseUpstreamCost(body(), metered).cost.prompt === 1, "a tier one token above the prompt leaves the quote exactly as a row without tiers");
  ok(G.meteredBoundFor(body(), metered) === G.costFor(model), "and the metered max_price bound stays the base row");
  // At the estimate: the tier prices the whole call.
  withTier(n);
  const wc = G.worstCaseUpstreamCost(body(), metered);
  ok(wc.longContext === true && wc.cost.prompt === 4 && wc.cost.completion === 8, "a tier AT the prompt size prices both units of the call");
  const q = G.meteredQuoteUsd(body()).usd;
  ok(q > baseQuote, `the quote rises with the tier (${q} > ${baseQuote})`);
  // Never below the cost at the tier rate: the quote covers prompt plus max output billed at the tier.
  const trueCost = (wc.inTokens / 1e6) * 4 * G.cacheWriteFactor(model) * G.tokenizerFactor(model) + (64 / 1e6) * 8;
  ok(q >= trueCost * U.upstreamCosts().meter.markup, "the quote is never below the tier-rate cost of the prompt it admits");
  const bound = G.meteredBoundFor(body(), metered);
  ok(bound.prompt === 4 && bound.completion === 8, "the metered max_price bound is the tier row");
  // The served-body belt and the quote use the same row: the quote of the
  // same body is stable across calls.
  ok(G.meteredQuoteUsd(body()).usd === q, "the quote is deterministic at the boundary");
  // Flat tier: the clamp prices the tier rate, never the bound-min'd base.
  U.setUpstreamCostsForTest({ ...FULL, models: [[model, R(0.01, 0.01)]] });
  const nf = G.promptTokensFor(body(), flatTier);
  const capBase = G.validateRequest(body(100000), flatSlug).max_tokens;
  U.setUpstreamCostsForTest({ ...FULL, models: [[model, R(0.01, 0.01, [T(nf, 0.02, 10)])]] });
  const clamped = G.validateRequest(body(100000), flatSlug);
  ok(clamped.max_tokens < capBase, `the flat clamp tightens output once a long-context tier applies (${clamped.max_tokens} < ${capBase})`);
  const after = G.worstCaseUpstreamCost(clamped, flatTier);
  ok(after.longContext && after.cost.completion === 10 && after.totalUsd <= flatTier.price * G.MARGIN + 1e-12, "after the clamp the tier-rate worst case fits the flat budget");
  U.setUpstreamCostsForTest({ ...FULL, models: [[model, R(0.01, 0.01, [T(nf + 1, 0.02, 10)])]] });
  ok(G.validateRequest(body(100000), flatSlug).max_tokens === capBase, "one token under the threshold the flat clamp is unchanged");
  // A tier dear enough that the input alone busts the flat budget is refused (400, uncharged).
  const huge = flatTier.price * G.MARGIN * 1e6 / nf * 2;
  U.setUpstreamCostsForTest({ ...FULL, models: [[model, R(0.01, 0.01, [T(nf, huge, huge)])]] });
  ok(status(() => G.validateRequest(body(100000), flatSlug)) === 400, "a long prompt whose tier rate busts the flat budget is refused 400 before any charge");
  U.setUpstreamCostsForTest(FAKE);
}

// ---- long-context tiers at serve time: the max_price bound each metered wire sends ----
{
  const { LLM_MESSAGES_TOOLS } = await import("../src/tools/llm-messages-kit.js");
  const { LLM_RESPONSES_TOOLS } = await import("../src/tools/llm-responses-kit.js");
  const model = "anthropic/claude-haiku-4.5";
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const seen = [];
  const fakeReq = { header: (h) => (String(h).toLowerCase() === "payment-signature" ? Buffer.from(JSON.stringify({ payload: { authorization: { from: "0xAbCdEf0000000000000000000000000000000009" } } })).toString("base64") : undefined) };
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    seen.push(b);
    const u = String(url);
    const usage = { prompt_tokens: 1, completion_tokens: 1, input_tokens: 1, output_tokens: 1, total_tokens: 2, cost: 0.0000001 };
    const body = u.endsWith("/responses")
      ? { id: "r", object: "response", status: "completed", model: b.model, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage }
      : u.endsWith("/messages")
        ? { id: "m", type: "message", role: "assistant", model: b.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage }
        : { id: "g", object: "chat.completion", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage };
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(body), json: async () => body };
  };
  const wires = [
    ["chat", G.LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-metered"), (text) => ({ model, max_tokens: 16, messages: [{ role: "user", content: text }] })],
    ["messages", LLM_MESSAGES_TOOLS.find((t) => t.slug === "v1-chat-metered-messages"), (text) => ({ model, max_tokens: 16, messages: [{ role: "user", content: text }] })],
    ["responses", LLM_RESPONSES_TOOLS.find((t) => t.slug === "v1-chat-metered-responses"), (text) => ({ model, max_output_tokens: 16, input: text })],
  ];
  const longText = "word ".repeat(3000);
  for (const [wire, tool, mk] of wires) {
    if (!tool) { ok(false, `${wire}: metered tool found`); continue; }
    // Threshold just under the long body's prompt, far above the short one's.
    U.setUpstreamCostsForTest({ ...FULL, models: [[model, R(1, 2)]] });
    const longQuote = tool.quote(mk(longText));
    U.setUpstreamCostsForTest({ ...FULL, models: [[model, R(1, 2, [T(1000, 4, 8)])]] });
    ok(tool.quote(mk(longText)) > longQuote, `${wire}: the 402 quote of a long prompt rises with the tier`);
    for (const [label, text, want] of [["short", "hi", [1, 2]], ["long", longText, [4, 8]]]) {
      seen.length = 0;
      const input = mk(text);
      let err = null;
      try { await tool.handler(input, { ...fakeReq, __meteredQuoteUsd: tool.quote(input) }); } catch (e) { err = e; }
      const mp = seen[0]?.provider?.max_price;
      ok(!err && mp?.prompt === want[0] && mp?.completion === want[1] && Object.keys(mp).join() === "prompt,completion", `${wire}: a ${label} prompt sends max_price at the ${label === "long" ? "long-context tier" : "base row"}${err ? ` (threw ${err.message})` : ""}`);
    }
  }
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
  U.setUpstreamCostsForTest(FAKE);
}

// ---- the published format example loads complete, so it cannot drift from REQUIRED ----
{
  const { readFileSync } = await import("node:fs");
  const ex = JSON.parse(readFileSync(new URL("../docs/example-upstream-costs.json", import.meta.url), "utf8"));
  U.setUpstreamCostsForTest(ex);
  ok(U.upstreamCostsStatus() === "ok" && U.upstreamCostsGaps().length === 0, `docs/example-upstream-costs.json reads ok (gaps: ${U.upstreamCostsGaps().join(", ") || "none"})`);
  U.setUpstreamCostsForTest(null);
}

// ---- environment parsing ----
U.setUpstreamCostsForTest(null);
process.env.UPSTREAM_COSTS_JSON = Buffer.from(JSON.stringify(FAKE)).toString("base64");
ok(U.upstreamCostsLoaded() && U.upstreamCosts().speech["acme/voice"] === 0.5, "UPSTREAM_COSTS_JSON accepts base64");
U.setUpstreamCostsForTest(null);
process.env.UPSTREAM_COSTS_JSON = "{not json";
const warns = [];
const realWarn = console.warn;
console.warn = (m) => warns.push(String(m));
ok(!U.upstreamCostsLoaded(), "an unreadable value runs without the table");
console.warn = realWarn;
ok(warns.length === 1 && !/not json/.test(warns[0]), "the warning names no value");
delete process.env.UPSTREAM_COSTS_JSON;
U.setUpstreamCostsForTest(null);

// ---- no upstream rate is committed: scan the shipped trees for the shapes the tables had ----
{
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { if (n === "node_modules" || n.startsWith(".")) continue; const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else if (/\.(js|mjs|md|json)$/.test(f)) files.push(f); } };
  const root = new URL("..", import.meta.url).pathname;
  for (const d of ["src", "scripts", "wiki", "docs", "openclaw", "mcp", "client", "adapters", "tollbooth", "workers"]) { try { if (statSync(join(root, d)).isDirectory()) walk(join(root, d)); } catch { /* absent */ } }
  const SHAPES = [
    [/\{ ?prompt: ?[0-9.]+, ?(cached: ?[0-9.]+, ?)?completion: ?[0-9.]+ ?\}/, (l) => !/maxPrice|max_price/.test(l)], // a model rate row (tier caps are ours)
    [/costPerChar: ?[0-9.]/, () => true],
    [/(worstCaseUsd|maxCostUsd|listedMaxUsd): ?[0-9.]/, () => true],
    [/feeUsdPerUse: ?0\.[0-9]*[1-9]/, () => true], // a non-zero fee; zero means "no fee"
    [/fixedUpstreamUsd: ?[0-9.]/, () => true],
    [/METER_MARKUP ?= ?[0-9]/, () => true],
    [/(usage|price|cost|quote|upstream)[^.]{0,60}\b(times|x|×) ?1\.\d{1,3}\b|\b(times|x|×) ?1\.\d{1,3}\b[^.]{0,80}(markup|usage|floor)|\bmarkup (of |is |= ?)?1\.\d+/i, () => true], // a written-out markup
  ];
  const hits = [];
  // Fake tables in tests are named as such: this file, and rows under "fake/".
  const self = new URL(import.meta.url).pathname;
  for (const f of files) {
    if (f === self) continue;
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((l, i) => { if (/["']fake\//.test(l)) return; for (const [re, keep] of SHAPES) if (re.test(l) && keep(l)) hits.push(`${f.slice(root.length)}:${i + 1}`); });
  }
  ok(files.length > 100, `the scan read the shipped trees (${files.length} files) - a handful would mean it is blind`);
  ok(hits.length === 0, `no upstream rate literal in the shipped trees (the table is private)${hits.length ? `: ${hits.slice(0, 10).join(", ")}` : ""}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
