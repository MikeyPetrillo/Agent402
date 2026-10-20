#!/usr/bin/env node
// The market tick read (src/tools/market-tick-kit.js), offline.
//
//   node scripts/test-market-tick.js
//
// Part 1 mounts the tool on its own Express app (port 0, bound port read
// back) with both source handlers stubbed, so nothing here reaches a network:
// mixed kinds in one call, the crypto leg batched into ONE source call, the
// per-symbol cache (hit, miss after the window, a window of 0), the symbol
// cap and the equity cap refused rather than clamped, the kind prefix, repeats
// read once, an unknown symbol marked per item with the partial fields, a
// failed source leg never cached, and the all-failed refusal carrying the
// source's status.
// Part 2 derives the price from the two source tools (never typed) and reads
// the slug lists the route depends on.
// Part 3 boots the real server twice: with MARKET_TICK unset the route is
// absent (404, not 410) and no public surface names it; with MARKET_TICK=on
// the route, its pricing row and its OpenAPI path are present.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import { getFreePort } from "./lib/free-port.js";

process.env.MARKET_TICK_CACHE_MS = "300";
delete process.env.REDIS_URL;

const { MARKET_TICK_TOOLS, MAX_SYMBOLS, MAX_EQUITIES, SOURCE_SLUGS, __setMarketTickSources, clearMarketTickCache, marketTickToolsEnabled, parseSymbols } =
  await import("../src/tools/market-tick-kit.js");
const { CRYPTO_TOOLS, resolveCoinId } = await import("../src/tools/crypto-kit.js");
const { FINANCE_TOOLS } = await import("../src/tools/finance-kit.js");
const { METERED_SLUGS } = await import("../src/metered-slugs.js");
const { WALLET_ONLY_SLUGS } = await import("../src/pow.js");
const { MARKET_TICK_SLUG, marketTickEnabled } = await import("../src/market-tick-switch.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- stubbed sources ----------------------------------------------------------------------
const calls = { crypto: [], equity: [] };
const cryptoStub = async (i) => {
  calls.crypto.push(i.coins);
  const coins = {};
  for (const id of String(i.coins).split(",")) {
    if (id === "zzzz") continue;
    coins[id] = { price: id === "bitcoin" ? 67234.12 : 3520.45, change24hPct: 1.42, volume24h: 1, marketCap: 1, lastUpdated: "2026-10-14T13:05:00.000Z" };
  }
  if (!Object.keys(coins).length) throw Object.assign(new Error("unknown coin(s): zzzz"), { statusCode: 404 });
  return { currency: "usd", count: Object.keys(coins).length, coins };
};
const equityStub = async (i) => {
  calls.equity.push(i.symbol);
  if (i.symbol === "ZZQX") throw Object.assign(new Error('"ZZQX" is not a US equity ticker. US equities only'), { statusCode: 422 });
  if (i.symbol === "BOOM") throw Object.assign(new Error("Market data upstream did not answer"), { statusCode: 503 });
  return { symbol: i.symbol, currency: "USD", price: 341.27, previousClose: 340.97, changePct: 0.088, asOf: "2026-10-13", cached: false };
};
__setMarketTickSources({ crypto: cryptoStub, equity: equityStub });
const reset = () => { calls.crypto.length = 0; calls.equity.length = 0; clearMarketTickCache(); };

const tool = MARKET_TICK_TOOLS[0];
const app = express();
app.get("/api/market/tick", async (req, res) => {
  try { res.json(await tool.handler(req.query, req)); }
  catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
});
const srv = app.listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const B = `http://127.0.0.1:${srv.address().port}`;
const get = async (symbols) => {
  const r = await fetch(`${B}/api/market/tick?symbols=${encodeURIComponent(symbols)}`);
  return { status: r.status, body: await r.json() };
};

try {
  // Mixed kinds: one batched coin read, one equity read, every item sourced.
  reset();
  let r = await get("BTC,ETH,AAPL");
  ok(r.status === 200 && r.body.items?.length === 3, `mixed kinds answer 200 with three items (${r.status})`);
  ok(r.body.items?.map((i) => i.kind).join() === "crypto,crypto,equity", `kinds read from the symbol (${r.body.items?.map((i) => i.kind).join()})`);
  ok(r.body.items?.map((i) => i.source).join() === "crypto-price,crypto-price,stock-quote", "each item names the tool it came from");
  ok(calls.crypto.length === 1 && calls.crypto[0] === "bitcoin,ethereum", `both coins went out in ONE crypto-price call (${JSON.stringify(calls.crypto)})`);
  ok(calls.equity.length === 1 && calls.equity[0] === "AAPL", `the equity went out as one stock-quote call (${JSON.stringify(calls.equity)})`);
  ok(r.body.cached === false && r.body.items.every((i) => i.cached === false), "a cold read says cached: false on the answer and every item");
  ok(r.body.complete === true && r.body.returned === 3 && r.body.matched === 3 && r.body.truncated === false && r.body.failed === undefined, "a full answer carries the partial fields as complete");
  ok(r.body.items[0].price === 67234.12 && r.body.items[0].change24hPct === 1.42 && r.body.items[0].id === "bitcoin", "a coin item carries price, 24h change and the coin id");
  ok(r.body.items[2].price === 341.27 && r.body.items[2].changePct === 0.088 && r.body.items[2].change24hPct === null && r.body.items[2].asOf === "2026-10-13", "an equity item carries the close, the session change and the session date; change24hPct is null");
  ok(r.body.sources?.crypto === "crypto-price" && r.body.sources?.equity === "stock-quote" && r.body.cacheSeconds === 1, `the answer names both sources and the cache window (${JSON.stringify(r.body.sources)}, ${r.body.cacheSeconds})`);

  // Cache hit inside the window: no source call at all.
  r = await get("BTC,ETH,AAPL");
  ok(r.status === 200 && r.body.cached === true && r.body.items.every((i) => i.cached === true), "the same symbols inside the window are served from the cache");
  ok(calls.crypto.length === 1 && calls.equity.length === 1, "a cached answer made no source call");
  // A different order and case is the same symbols.
  r = await get("aapl,eth,btc");
  ok(r.body.cached === true && r.body.items.map((i) => i.symbol).join() === "AAPL,ETH,BTC" && calls.crypto.length === 1, "order and case do not miss the cache; items keep the caller's order");
  // A new symbol beside cached ones: only the new one is read.
  r = await get("BTC,SOL");
  ok(r.body.cached === false && r.body.items[0].cached === true && r.body.items[1].cached === false && calls.crypto.length === 2 && calls.crypto[1] === "solana", `only the miss is read (${JSON.stringify(calls.crypto)})`);

  // Miss after the window.
  await sleep(350);
  r = await get("BTC,ETH,AAPL");
  ok(r.body.cached === false && calls.crypto.length === 3 && calls.equity.length === 2, "after the window every symbol is read again");

  // A window of 0 caches nothing.
  process.env.MARKET_TICK_CACHE_MS = "0";
  reset();
  await get("BTC"); await get("BTC");
  ok(calls.crypto.length === 2, "MARKET_TICK_CACHE_MS=0 reads the source on every call");
  process.env.MARKET_TICK_CACHE_MS = "300";

  // Partial: an unknown equity is marked on its item, the rest is served.
  reset();
  r = await get("BTC,ZZQX");
  ok(r.status === 200 && r.body.items.length === 2, `one failed leg still answers 200 (${r.status})`);
  ok(r.body.items[1].ok === false && r.body.items[1].status === 422 && /US equities only/.test(r.body.items[1].error) && r.body.items[1].source === "stock-quote", "the failed item carries the source's error, status and name");
  ok(r.body.complete === false && r.body.truncated === true && r.body.returned === 1 && r.body.matched === 2 && r.body.failed?.join() === "ZZQX", `the partial fields and failed list say what is missing (${JSON.stringify({ c: r.body.complete, r: r.body.returned, m: r.body.matched, f: r.body.failed })})`);
  // The failure is not cached: the next call reads the failed symbol again and only it.
  r = await get("BTC,ZZQX");
  ok(calls.equity.length === 2 && calls.crypto.length === 1 && r.body.items[0].cached === true, "a refusal is read again on the next call while the served coin stays cached");

  // An unknown coin inside a known batch is marked per item.
  reset();
  r = await get("BTC,crypto:ZZZZ");
  ok(r.status === 200 && r.body.items[1].ok === false && r.body.items[1].status === 404 && r.body.items[0].ok === true, "an unknown coin in a batch is a 404 on its item, the known coin is served");

  // A source outage on one leg: partial, the other leg served.
  reset();
  r = await get("ETH,BOOM");
  ok(r.status === 200 && r.body.items[1].status === 503 && r.body.items[0].ok === true && r.body.complete === false, "a source that does not answer is marked 503 on its item");

  // All failed: refused with the source's status, the message lists every symbol.
  reset();
  r = await get("ZZQX");
  ok(r.status === 422 && /ZZQX/.test(r.body.error) && /US equities only/.test(r.body.error), `nothing served is refused with the source's 4xx (${r.status}: ${r.body.error})`);
  r = await get("BOOM");
  ok(r.status === 503, `nothing served because the source did not answer is a 503 (${r.status})`);
  r = await get("crypto:ZZZZ");
  ok(r.status === 404 && /ZZZZ/.test(r.body.error), `an unknown coin alone is a 404 naming it (${r.status})`);

  // Caps are refused, never clamped.
  reset();
  const eleven = ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "DOT", "LINK", "AVAX", "LTC", "UNI"];
  r = await get(eleven.join(","));
  ok(r.status === 400 && new RegExp(`at most ${MAX_SYMBOLS}`).test(r.body.error) && calls.crypto.length === 0, `${eleven.length} symbols are a 400 naming the cap, with no source read (${r.status}: ${r.body.error})`);
  r = await get("AAPL,MSFT,NVDA,AMZN,GOOG,META");
  ok(r.status === 400 && new RegExp(`at most ${MAX_EQUITIES} equities`).test(r.body.error) && calls.equity.length === 0, `six equities are a 400 naming the equity cap (${r.status}: ${r.body.error})`);
  r = await get("BTC,ETH,SOL,XRP,ADA,AAPL,MSFT,NVDA,AMZN,GOOG");
  ok(r.status === 200 && r.body.items.length === 10, `${MAX_SYMBOLS} symbols with ${MAX_EQUITIES} equities is the full allowed call (${r.status})`);

  // Input shapes.
  r = await get("");
  ok(r.status === 400 && /required/.test(r.body.error), "an empty list is a 400 naming the parameter");
  r = await get("BTC,,ETH");
  ok(r.status === 200 && r.body.items.length === 2, "empty entries are dropped");
  r = await get("btc,BTC, Btc ");
  ok(r.status === 200 && r.body.items.length === 1, "repeats of one symbol are read once");
  r = await get("BTC,A$B");
  ok(r.status === 400 && /A\$B/.test(r.body.error), "a symbol with a character outside the set is a 400 naming it");

  // The kind prefix.
  reset();
  r = await get("LINK,equity:LINK,crypto:AAPL");
  ok(r.body.items[0].kind === "crypto" && r.body.items[1].kind === "equity" && r.body.items[2].kind === "crypto", `a known coin reads as crypto; equity: and crypto: force the kind (${r.body.items.map((i) => i.kind).join()})`);
  ok(calls.equity[0] === "LINK" && calls.crypto[0].includes("chainlink"), "the forced equity went to stock-quote and the coin resolved to its id");
  ok(parseSymbols("render-token")[0].kind === "equity" && parseSymbols("crypto:render-token")[0].symbol === "RENDER-TOKEN", "a coin id the map does not list needs the crypto: prefix");
} finally {
  srv.close();
}

// ---- part 2: derived price and the slug lists ---------------------------------------------
const usd = (s) => Number(String(s).replace(/[^0-9.]/g, ""));
const cryptoPrice = CRYPTO_TOOLS.find((t) => t.slug === SOURCE_SLUGS.crypto);
const stockQuote = FINANCE_TOOLS.find((t) => t.slug === SOURCE_SLUGS.equity);
ok(cryptoPrice && stockQuote, "both source tools exist in their kits under the slugs the route names");
ok(usd(tool.price) === Math.min(usd(cryptoPrice.price), usd(stockQuote.price)) && usd(tool.price) >= Math.min(usd(cryptoPrice.price), usd(stockQuote.price)),
  `the route is priced at the cheaper source tool's price and never below it (${tool.price} against ${cryptoPrice.price} and ${stockQuote.price})`);
ok(tool.route === "GET /api/market/tick" && tool.slug === MARKET_TICK_SLUG, "route and slug");
ok(/cached server-side per symbol for up to \d+ seconds/.test(tool.description) && tool.description.includes("crypto-price") && tool.description.includes("stock-quote"),
  "the description states the cache window and names both source tools");
ok(/Nothing is read from a new source/.test(tool.description), "the description says no new source is read");
ok(!/\$\d/.test(tool.description), "no dollar figure is typed in the description");
ok(METERED_SLUGS.has(MARKET_TICK_SLUG), "the slug is metered (the sweeps skip it: its equity leg spends a key)");
ok(WALLET_ONLY_SLUGS.has(MARKET_TICK_SLUG), "the slug is wallet-only (no free tier: it egresses)");
ok(resolveCoinId("BTC") === "bitcoin", "control: the coin resolver the route maps answers back through");
ok(marketTickToolsEnabled({}).length === 0 && marketTickToolsEnabled({ MARKET_TICK: "on" }).length === 1 && marketTickToolsEnabled({ MARKET_TICK: "ON " }).length === 1 && marketTickToolsEnabled({ MARKET_TICK: "true" }).length === 0,
  "the kit lists its tool only for MARKET_TICK=on (case and whitespace tolerant; 'true' is not on)");
ok(marketTickEnabled({}) === false && marketTickEnabled({ MARKET_TICK: "on" }) === true, "the switch module reads the same rule");

// ---- part 3: the real server, switch off and on -------------------------------------------
const ROOT = fileURLToPath(new URL("..", import.meta.url));
async function boot(extraEnv) {
  const port = await getFreePort();
  const env = { ...process.env, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", STATE_DATABASE_URL: "", POSTHOG_API_KEY: "", ...extraEnv };
  delete env.MARKET_TICK;
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, ["src/server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 240 && !up; i++) { try { if ((await fetch(`${base}/health`)).ok) up = true; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) { child.kill("SIGKILL"); throw new Error(`server did not boot:\n${log.slice(-2000)}`); }
  return { base, child, log: () => log };
}
async function surfaces(base) {
  const [route, pricing, openapi, llms, sitemap, tools, find] = await Promise.all([
    // An empty list is refused before any source read, so this probe never egresses.
    fetch(`${base}/api/market/tick?symbols=`),
    fetch(`${base}/api/pricing`).then((r) => r.json()),
    fetch(`${base}/openapi.json`).then((r) => r.json()),
    fetch(`${base}/llms.txt`).then((r) => r.text()),
    fetch(`${base}/sitemap.xml`).then((r) => r.text()),
    fetch(`${base}/tools`).then((r) => r.text()),
    fetch(`${base}/api/find?q=poll%20a%20crypto%20and%20stock%20price`).then((r) => r.text()),
  ]);
  const rows = Array.isArray(pricing) ? pricing : (pricing.tools || pricing.items || Object.values(pricing));
  return {
    routeStatus: route.status,
    priced: JSON.stringify(rows).includes('"market-tick"'),
    openapi: Object.hasOwn(openapi.paths || {}, "/api/market/tick"),
    named: [llms, sitemap, tools, find].map((t) => t.includes("market-tick") || t.includes("/api/market/tick")),
  };
}
{
  const off = await boot({});
  try {
    const s = await surfaces(off.base);
    ok(s.routeStatus === 404, `switch unset: the route is absent (404, not 410; got ${s.routeStatus})`);
    ok(s.priced === false, "switch unset: no pricing row");
    ok(s.openapi === false, "switch unset: no OpenAPI path");
    ok(s.named.every((x) => x === false), `switch unset: llms.txt, the sitemap, /tools and /api/find do not name it (${s.named.join()})`);
  } finally { off.child.kill("SIGTERM"); }
}
{
  const on = await boot({ MARKET_TICK: "on" });
  try {
    const s = await surfaces(on.base);
    ok(s.routeStatus === 400, `MARKET_TICK=on: the route is mounted and refuses an empty list itself (got ${s.routeStatus})`);
    ok(s.priced === true, "MARKET_TICK=on: the pricing row is present");
    ok(s.openapi === true, "MARKET_TICK=on: the OpenAPI path is present");
    const op = (await fetch(`${on.base}/openapi.json`).then((r) => r.json())).paths["/api/market/tick"];
    ok(op && op.get && (op.get.parameters || []).some((p) => p.name === "symbols"), "MARKET_TICK=on: the OpenAPI GET declares the symbols parameter");
    const r = await fetch(`${on.base}/api/market/tick?symbols=${eleven().join(",")}`);
    ok(r.status === 400, `MARKET_TICK=on: the cap is refused through the real route with no source read (${r.status})`);
  } finally { on.child.kill("SIGTERM"); }
}
function eleven() { return ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "DOT", "LINK", "AVAX", "LTC", "UNI"]; }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
