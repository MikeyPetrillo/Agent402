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

// --- dependents: packs, retirements, market tick -----------------------------
const { STOCK_PACK_SLUGS, ALL_SKILL_PACKS, SKILL_PACKS } = await import("../src/skills.js");
const running = ALL_SKILL_PACKS.filter((p) => p.toolSlugs.some((s) => SP.STOCK_SLUGS.has(s))).map((p) => p.slug).sort();
ok(running.length >= 1 && JSON.stringify([...STOCK_PACK_SLUGS].sort()) === JSON.stringify(running), `every pack that runs a stock tool is gated (${running.join(", ")})`);
ok(SKILL_PACKS.every((p) => !STOCK_PACK_SLUGS.has(p.slug)) && SKILL_PACKS.length === ALL_SKILL_PACKS.length - STOCK_PACK_SLUGS.size, "with no provider at load the listed packs leave them out");
const { marketTickEnabled } = await import("../src/market-tick-switch.js");
ok(marketTickEnabled({ MARKET_TICK: "on" }) === false && marketTickEnabled({ MARKET_TICK: "on", STOCK_DATA_PROVIDER: "databento", DATABENTO_API_KEY: "k" }) === true, "the market tick (equity leg is stock-quote) needs a provider too");
const { RETIRED_TOOLS } = await import("../src/retired-tools.js");
ok(Object.values(RETIRED_TOOLS).every((e) => !e.replacement || (!SP.STOCK_SLUGS.has(e.replacement) && !STOCK_PACK_SLUGS.has(String(e.replacement).replace(/^skill-/, "")))), "no retirement points at a stock tool or pack while none is listed");
const { selfcheckSlugs } = await import("../src/selfcheck.js");
ok(!selfcheckSlugs().some((s) => SP.STOCK_SLUGS.has(s)), "the self-check reads no stock tool with no provider");
const { mcpInitializeInstructions } = await import("../src/mcp-flagship.js");
ok(!/market\.quote/.test(mcpInitializeInstructions("http://x.test", { stock: false })) && /market\.quote/.test(mcpInitializeInstructions("http://x.test", { stock: true })), "the MCP instructions name market.quote only with a provider");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
