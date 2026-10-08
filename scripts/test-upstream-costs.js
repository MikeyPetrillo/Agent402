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
const FULL = { ...FAKE, models: FAKE.models.slice(0, 2), fees: { ...FAKE.fees, rerankPerUnit: 5 }, meter: { markup: 1.25 }, vendor: { exa: { search: 0.5, instant: 0.5, answer: 0.5, content: 0.5 }, x: { postRead: 0.5, userRead: 0.5 }, decisions: { luna: 0.5 } } };
U.setUpstreamCostsForTest(FULL);
ok(U.upstreamCostsStatus() === "ok" && U.upstreamCostsGaps().length === 0, "a complete table reads ok");
U.setUpstreamCostsForTest({ ...FULL, models: [...FULL.models, ["acme/big-pro", { prompt: 0, completion: 9 }]] });
ok(U.upstreamCostsStatus() === "partial" && U.upstreamCostsGaps().join() === "models[acme/big-pro]", "a zero-rate model row (not stealth) is a gap, not a silent fallback to acme/big");
U.setUpstreamCostsForTest({ ...FULL, models: [...FULL.models, ["stealth/x", { prompt: 0, completion: 0 }]] });
ok(U.upstreamCostsStatus() === "ok", "a free stealth row is not a gap");
U.setUpstreamCostsForTest(null);
ok(U.upstreamCostsStatus() === "missing" && U.upstreamCostsGaps().length === 0, "no table reads missing");
U.setUpstreamCostsForTest(FAKE);

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
