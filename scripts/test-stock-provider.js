// The stock-provider seam (src/tools/stock-provider.js), offline: the switch,
// the adapter contract every provider must meet, and that the stock tools,
// packs and copy follow the switch. A stub adapter stands in for a provider,
// so nothing here reaches a market-data host.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
delete process.env.STOCK_DATA_PROVIDER;
delete process.env.DATABENTO_API_KEY;

const SP = await import("../src/tools/stock-provider.js");
const { databentoAdapter } = await import("../src/tools/databento.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- the switch ---------------------------------------------------------------
ok(SP.selectedStockProvider({}) === "off" && SP.selectedStockProvider({ STOCK_DATA_PROVIDER: " Databento " }) === "databento", "unset reads off; the name is trimmed and case-folded");
ok(SP.stockDataEnabled({}) === false, "off by default");
ok(SP.stockDataEnabled({ STOCK_DATA_PROVIDER: "off", DATABENTO_API_KEY: "k" }) === false, "a key alone does not turn a provider on");
ok(SP.stockDataEnabled({ STOCK_DATA_PROVIDER: "databento" }) === false && SP.stockDataEnabled({ STOCK_DATA_PROVIDER: "databento", DATABENTO_API_KEY: "  " }) === false, "a selected provider without its key is not active");
ok(SP.stockDataEnabled({ STOCK_DATA_PROVIDER: "databento", DATABENTO_API_KEY: "k" }) === true, "control: selected AND keyed is active");
ok(SP.stockDataEnabled({ STOCK_DATA_PROVIDER: "nope", DATABENTO_API_KEY: "k" }) === false, "an unregistered name is not active");
ok(SP.stockProviderNames().includes("databento"), "databento is registered");
// The one boot warning: an unknown name or a missing key, never a key's value.
{
  const SECRET = "sk-live-ShouldNeverPrint-1234";
  ok(SP.stockProviderWarning({}) === null && SP.stockProviderWarning({ STOCK_DATA_PROVIDER: "off" }) === null, "no warning with the switch off");
  ok(SP.stockProviderWarning({ STOCK_DATA_PROVIDER: "databento", DATABENTO_API_KEY: SECRET }) === null, "control: no warning for an active provider");
  const unknown = SP.stockProviderWarning({ STOCK_DATA_PROVIDER: "polygon", DATABENTO_API_KEY: SECRET });
  ok(/names no registered provider/.test(unknown || "") && /"polygon"/.test(unknown) && /databento/.test(unknown) && !unknown.includes(SECRET), `an unknown name warns, naming the registered ones (${unknown})`);
  const keyless = SP.stockProviderWarning({ STOCK_DATA_PROVIDER: "databento", DATABENTO_API_KEY: " " });
  ok(/DATABENTO_API_KEY is not set/.test(keyless || ""), `a selected provider without its key warns, naming the variable (${keyless})`);
  const odd = SP.stockProviderWarning({ STOCK_DATA_PROVIDER: `x\u001b[31m${"y".repeat(200)}` }) || "";
  ok(!/\u001b/.test(odd) && odd.length < 300, "a strange name is echoed bounded, control characters replaced");
}
ok(await SP.activeStockAdapter({}) === null, "no active adapter with the switch off");
for (const [name, fn] of [["quote", () => SP.quote("AAPL")], ["dailyBars", () => SP.dailyBars("AAPL", { sessions: 5 })]]) {
  try { await fn(); ok(false, `${name} refuses with no provider`); }
  catch (e) { ok(e.statusCode === 503 && e.notOffered === true && /not currently offered/.test(e.message), `${name} refuses 503 not-offered with no provider (got ${e.statusCode})`); }
}

// --- the adapter contract -----------------------------------------------------
function checkContract(a, label) {
  ok(typeof a?.name === "string" && a.name.length > 0, `${label}: has a name`);
  ok(typeof a?.quote === "function" && typeof a?.dailyBars === "function", `${label}: has quote() and dailyBars()`);
  const d = a?.describe || {};
  ok(typeof d.coverageCopy === "string" && d.exampleProvenance && typeof d.exampleProvenance === "object", `${label}: describes its coverage and example provenance`);
  for (const k of ["dataset", "coverage", "venues", "source", "note"]) ok(typeof d.exampleProvenance?.[k] === "string", `${label}: example provenance carries ${k}`);
  ok(!/—/.test(JSON.stringify(d)), `${label}: copy has no em dash`);
}
checkContract(databentoAdapter, "databento adapter");

// A stub provider registered the way a new adapter would be.
const bar = (day, close) => ({ day, open: close - 1, high: close + 1, low: close - 2, close, volume: 1000, venueVolume: 1000 });
const stubProvenance = { dataset: "STUB.EOD", coverage: "consolidated", venues: "All US exchanges (stub)", source: "stub.invalid STUB.EOD", note: "Stub end-of-day bars." };
const calls = [];
const stub = {
  name: "stub",
  describe: { coverageCopy: "Stub coverage sentence.", barsCopy: "", exampleProvenance: stubProvenance },
  async quote(symbol, opts) { calls.push(["quote", symbol, opts]); return { bars: [bar("2026-10-12", 100), bar("2026-10-13", 101)], provenance: stubProvenance, cached: false, fetchedAt: "2026-10-14T00:00:00.000Z", rangeCheckedAt: "2026-10-14T00:00:00.000Z" }; },
  async dailyBars(symbol, opts) { calls.push(["dailyBars", symbol, opts]); return { bars: Array.from({ length: 40 }, (_, i) => bar(new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), 100 + i)), provenance: stubProvenance, cached: false, fetchedAt: "2026-10-14T00:00:00.000Z", rangeCheckedAt: "2026-10-14T00:00:00.000Z" }; },
};
checkContract(stub, "stub adapter");
const undo = SP.__registerStockProvider("stub", { keyEnv: "STUB_STOCK_KEY", adapter: stub });
ok(SP.stockDataEnabled({ STOCK_DATA_PROVIDER: "stub" }) === false && SP.stockDataEnabled({ STOCK_DATA_PROVIDER: "stub", STUB_STOCK_KEY: "k" }) === true, "a new adapter follows the same rule: its name and its own key");

// --- the kit follows the switch ----------------------------------------------
process.env.STOCK_DATA_PROVIDER = "stub";
process.env.STUB_STOCK_KEY = "k";
const { FINANCE_TOOLS, financeToolsEnabled } = await import("../src/tools/finance-kit.js");
ok(financeToolsEnabled({}).length === 0, "with no provider the kit lists nothing");
ok(financeToolsEnabled(process.env).length === 2 && FINANCE_TOOLS.every((t) => SP.STOCK_SLUGS.has(t.slug)), "with a provider the kit lists exactly the stock slugs");
ok(FINANCE_TOOLS.every((t) => t.description.includes("Stub coverage sentence.")), "descriptions carry the provider's coverage copy");
for (const t of FINANCE_TOOLS) {
  const r = await t.handler(t.discovery.input, {});
  const ex = t.discovery.output.example;
  const missing = Object.keys(ex).filter((k) => !(k in r) && !["cached", "fetchedAt", "rangeCheckedAt"].includes(k));
  ok(missing.length === 0, `${t.slug}: its published example answers through the stub with every documented field (missing: ${missing.join(", ") || "none"})`);
  ok(r.source === stubProvenance.source && r.dataset === stubProvenance.dataset, `${t.slug}: the answer names the provider's source`);
}
ok(calls.some(([k, s, o]) => k === "quote" && s === "AAPL" && o.demand === true) && calls.some(([k, s, o]) => k === "dailyBars" && s === "AAPL" && o.sessions === 30 && o.maxUsd > 0), "the kit calls quote(symbol) and dailyBars(symbol, { sessions, maxUsd })");
calls.length = 0;
await FINANCE_TOOLS[0].handler({ symbol: "MSFT" }, { selfcheck: true });
ok(calls[0]?.[2]?.demand === false && calls[0]?.[2]?.lastGoodOk === false, "a self-check read is no demand and never served stale");
try { await FINANCE_TOOLS[0].handler({ symbol: "BAD SYMBOL!" }, {}); ok(false, "a malformed ticker is refused"); }
catch (e) { ok(e.statusCode === 400 && calls.length === 1, "a malformed ticker is a 400 before any provider read"); }
process.env.STOCK_DATA_PROVIDER = "off";
try { await FINANCE_TOOLS[0].handler({ symbol: "AAPL" }, {}); ok(false, "switched off mid-run refuses"); }
catch (e) { ok(e.statusCode === 503, `switched off, an in-process call (a composite's step) is a 503, never a read (got ${e.statusCode})`); }
undo();
delete process.env.STUB_STOCK_KEY;

// --- dependents: packs and retirements ---------------------------------------
const { STOCK_PACK_SLUGS, STOCK_CORE_PACK_SLUGS, STOCK_TRIMMED_PACK_SLUGS, ALL_SKILL_PACKS, SKILL_PACKS, PACK_PRICES, PACK_PRICE_TABLE, PACK_PRICES_WITHOUT_STOCK, packWithoutStock } = await import("../src/skills.js");
const running = ALL_SKILL_PACKS.filter((p) => p.toolSlugs.some((s) => SP.STOCK_SLUGS.has(s))).map((p) => p.slug).sort();
ok(running.length >= 1 && JSON.stringify([...STOCK_PACK_SLUGS].sort()) === JSON.stringify(running), `every pack that runs a stock tool is classified (${running.join(", ")})`);
ok(STOCK_CORE_PACK_SLUGS.size + STOCK_TRIMMED_PACK_SLUGS.size === STOCK_PACK_SLUGS.size && [...STOCK_CORE_PACK_SLUGS].every((s) => !STOCK_TRIMMED_PACK_SLUGS.has(s)), `each one is hidden or trimmed, never both (hidden: ${[...STOCK_CORE_PACK_SLUGS].join(", ")})`);
ok(SKILL_PACKS.every((p) => !STOCK_CORE_PACK_SLUGS.has(p.slug)) && SKILL_PACKS.length === ALL_SKILL_PACKS.length - STOCK_CORE_PACK_SLUGS.size, "with no provider at load the packs whose answer is stock data are not listed");
const trimmed = SKILL_PACKS.filter((p) => STOCK_TRIMMED_PACK_SLUGS.has(p.slug));
ok(trimmed.length === STOCK_TRIMMED_PACK_SLUGS.size && trimmed.every((p) => p.toolSlugs.length >= 2 && !p.toolSlugs.some((s) => SP.STOCK_SLUGS.has(s))), "the other packs are listed with their stock step removed, two tools or more each");
const PROMISE = /stock-quote|stock-history|latest close|live quote|stock quote|current quote|price history|daily close/i;
ok(trimmed.every((p) => !PROMISE.test(JSON.stringify(p))), `no trimmed pack's copy, workflow, prompt or example promises a quote or price data (${trimmed.filter((p) => PROMISE.test(JSON.stringify(p))).map((p) => p.slug).join(", ") || "none"})`);
ok(trimmed.every((p) => PACK_PRICES[p.slug] === PACK_PRICES_WITHOUT_STOCK[p.slug] && PACK_PRICES_WITHOUT_STOCK[p.slug] <= PACK_PRICE_TABLE[p.slug]), "each trimmed pack sells at the rule's price for the tools it keeps, never above its full price");
ok(ALL_SKILL_PACKS.every((p) => !STOCK_TRIMMED_PACK_SLUGS.has(p.slug) || packWithoutStock(p) !== p) && packWithoutStock(ALL_SKILL_PACKS.find((p) => !STOCK_PACK_SLUGS.has(p.slug))) === ALL_SKILL_PACKS.find((p) => !STOCK_PACK_SLUGS.has(p.slug)), "control: a pack with no stock step is listed unchanged");
{
  const { PACK_STEPS, __test } = await import("../src/tools/skill-runner.js");
  const off = [...STOCK_TRIMMED_PACK_SLUGS].every((s) => !__test.getStepConfig(s, { stock: false }).steps.some((st) => SP.STOCK_SLUGS.has(st.slug)));
  const on = [...STOCK_TRIMMED_PACK_SLUGS].every((s) => __test.getStepConfig(s, { stock: true }) === PACK_STEPS[s]);
  ok(off && on, "a trimmed pack runs without its stock step with no provider, and exactly its own steps with one");
}
{
  // A trimmed series pack answers a FRED id end to end with no stock leg (stub tools, offline).
  const { __test } = await import("../src/tools/skill-runner.js");
  const values = Array.from({ length: 120 }, (_, i) => 4 + Math.sin(i / 6) + i * 0.01);
  const seen = [];
  const stub = (slug, out) => (input) => { seen.push(slug); return out(input); };
  const inline = Object.fromEntries(["stats-summary", "moving-average", "linear-regression", "outliers", "correlation", "forecast-eval", "forecast-naive", "forecast-ses", "forecast-holt", "forecast-holt-winters"].map((s) => [s, stub(s, () => ({ rmse: 1 }))]));
  inline["us-macro-series"] = stub("us-macro-series", () => ({ observations: values.map((v, i) => ({ date: String(i), value: v })) }));
  for (const st of SP.STOCK_SLUGS) inline[st] = stub(st, () => { throw new Error("a stock step ran"); });
  const packIndex = new Map(SKILL_PACKS.map((p) => [p.slug, p]));
  for (const slug of ["trend-analysis", "forecasting-bake-off"]) {
    seen.length = 0;
    const r = await __test.runPack(slug, { series: "UNRATE", horizon: "12" }, { packIndex, catalog: {}, inlineHandlers: inline });
    ok(!r.steps.some((st) => SP.STOCK_SLUGS.has(st.slug)) && !seen.some((s) => SP.STOCK_SLUGS.has(s)) && r.steps.find((st) => st.slug === "us-macro-series")?.ok === true && r.steps.every((st) => st.ok),
      `${slug} with no provider: us-macro-series serves the series and every step answers (${r.summary})`);
  }
}
const { RETIRED_TOOLS } = await import("../src/retired-tools.js");
ok(Object.values(RETIRED_TOOLS).every((e) => !e.replacement || (!SP.STOCK_SLUGS.has(e.replacement) && !STOCK_CORE_PACK_SLUGS.has(String(e.replacement).replace(/^skill-/, "")))), "no retirement points at a stock tool or pack while none is listed");
const { selfcheckSlugs } = await import("../src/selfcheck.js");
ok(!selfcheckSlugs().some((s) => SP.STOCK_SLUGS.has(s)), "the self-check reads no stock tool with no provider");
const { mcpInitializeInstructions } = await import("../src/mcp-flagship.js");
ok(!/market\.quote/.test(mcpInitializeInstructions("http://x.test", { stock: false })) && /market\.quote/.test(mcpInitializeInstructions("http://x.test", { stock: true })), "the MCP instructions name market.quote only with a provider");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
