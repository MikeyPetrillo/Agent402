import { readFileSync } from "node:fs";
// scripts/test-crypto-markets-kit.js
// Offline tests for src/tools/crypto-markets-kit.js. No network: globalThis.fetch
// is stubbed. Covers the catalog envelope (12 tools, prices, GET routes, no
// em dashes, source + fetchedAt on every example), the Demo key header (sent
// when COINGECKO_API_KEY is set, absent otherwise), the in-process cache (a
// repeat call inside the TTL makes no second fetch; a different input does),
// the upstream status mapping (404 -> 422, 429 -> 503 after one retry, 5xx ->
// 502, 401 -> 422, non-JSON -> 502, timeout -> 504, body never relayed),
// input validation (400), and fixture output shapes per tool. Live coverage
// is the examples themselves (every example answers live; see test-all).

import { CRYPTO_MARKETS_TOOLS, clearCryptoMarketsCache, __test , resetCgRateLimit } from "../src/tools/crypto-markets-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
// The Demo-plan token bucket is a live guard (25/min); an offline suite makes
// dozens of stubbed calls, so refill before each one. The bucket itself is
// covered by its own case below.
const h = (slug) => {
  const fn = CRYPTO_MARKETS_TOOLS.find((t) => t.slug === slug).handler;
  return (...args) => { resetCgRateLimit(); return fn(...args); };
};

async function throws(promise, status, label, re) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status && (!re || re.test(e.message))) { pass++; console.log(`ok - ${label} -> ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}${re ? ` /${re.source}/` : ""}, got ${e.statusCode} (${e.message})`); }
  }
}

// ----------------------------------------------------------------------------
// fetch stub: routes by URL path, records every call
// ----------------------------------------------------------------------------
const calls = [];
let routes = {};
const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => null },
  json: async () => { if (typeof body === "string") throw new Error("not json"); return body; },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  calls.push({ url: u, headers: init?.headers || {}, signal: init?.signal });
  for (const [prefix, responder] of Object.entries(routes)) {
    if (u.pathname.startsWith(prefix)) return typeof responder === "function" ? responder(u) : responder;
  }
  return jsonRes(404, { error: "coin not found" });
};
const reset = () => { calls.length = 0; clearCryptoMarketsCache(); };

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
const EXPECTED = {
  "coin-price-by-contract": "$0.005", "coin-profile": "$0.008", "coin-history": "$0.005", "coin-ohlc": "$0.008",
  "coin-market-chart-range": "$0.008", "coin-categories": "$0.005", "global-defi": "$0.005", "exchanges": "$0.005",
  "exchange-tickers": "$0.008", "exchange-rates": "$0.005", "coin-search": "$0.005", "coins-list": "$0.005",
  "rwa-list": "$0.003", "rwa-markets": "$0.006", "rwa-asset": "$0.006", "rwa-issuers": "$0.003", "rwa-issuer": "$0.006",
};
ok(CRYPTO_MARKETS_TOOLS.length === 17, `17 tools exported (got ${CRYPTO_MARKETS_TOOLS.length})`);
const slugs = new Set();
for (const t of CRYPTO_MARKETS_TOOLS) {
  ok(EXPECTED[t.slug] === t.price, `${t.slug}: priced ${t.price}`);
  ok(!slugs.has(t.slug), `${t.slug}: unique slug`); slugs.add(t.slug);
  ok(t.route === `GET /api/${t.slug}`, `${t.slug}: GET /api/${t.slug}`);
  ok(t.category === "crypto" && typeof t.handler === "function" && typeof t.name === "string" && Array.isArray(t.tags) && t.tags.length >= 3, `${t.slug}: envelope`);
  ok(t.discovery?.input && t.discovery?.inputSchema?.properties && t.discovery?.output?.example, `${t.slug}: discovery input + schema + example`);
  ok(t.discovery.output.example.source === "coingecko" && typeof t.discovery.output.example.fetchedAt === "string", `${t.slug}: example carries source + fetchedAt`);
  ok(!/\u2014/.test(t.description) && !/\u2014/.test(t.name), `${t.slug}: no em dashes`);
  ok(/cached/i.test(t.description), `${t.slug}: description notes the cache`);
}
// No slug collides with the sibling kits' CoinGecko tools.
for (const taken of ["crypto-price", "crypto-market", "crypto-history", "crypto-trending", "crypto-global", "stablecoin-peg", "price-coingecko"]) {
  ok(!slugs.has(taken), `does not duplicate existing slug ${taken}`);
}

// ----------------------------------------------------------------------------
// Key header: sent when set, absent otherwise; read at call time
// ----------------------------------------------------------------------------
const stashed = process.env.COINGECKO_API_KEY;
routes = { "/api/v3/global/decentralized_finance_defi": jsonRes(200, { data: { defi_market_cap: "1", eth_market_cap: "2", defi_to_eth_ratio: "50", trading_volume_24h: "3", defi_dominance: "4", top_coin_name: "X", top_coin_defi_dominance: 5 } }) };
delete process.env.COINGECKO_API_KEY;
reset();
await h("global-defi")({});
ok(calls.length === 1 && !("x-cg-demo-api-key" in calls[0].headers), "no env key: header absent");
ok(calls[0].headers.Accept === "application/json" && /Agent402/.test(calls[0].headers["User-Agent"]), "Accept + UA headers sent");
ok(calls[0].signal && typeof calls[0].signal.aborted === "boolean", "AbortSignal attached");
process.env.COINGECKO_API_KEY = " demo-key-123 ";
reset();
await h("global-defi")({});
ok(calls.length === 1 && calls[0].headers["x-cg-demo-api-key"] === "demo-key-123", "env key: x-cg-demo-api-key sent (trimmed), read at call time");
ok(calls[0].url.hostname === "api.coingecko.com" && calls[0].url.pathname === "/api/v3/global/decentralized_finance_defi", "fixed upstream host + path");
if (stashed === undefined) delete process.env.COINGECKO_API_KEY; else process.env.COINGECKO_API_KEY = stashed;

// ----------------------------------------------------------------------------
// Cache: repeat call = no second fetch, cached:true, same fetchedAt; different
// input = fetch; clear = fetch
// ----------------------------------------------------------------------------
reset();
routes = { "/api/v3/exchange_rates": jsonRes(200, { rates: { btc: { name: "Bitcoin", unit: "BTC", value: 1, type: "crypto" }, usd: { name: "US Dollar", unit: "$", value: 77000, type: "fiat" }, xau: { name: "Gold", unit: "XAU", value: 22.9, type: "commodity" } } }) };
const a1 = await h("exchange-rates")({});
const a2 = await h("exchange-rates")({});
ok(calls.length === 1, "cache: identical repeat makes no second fetch");
ok(a1.cached === false && a2.cached === true && a1.fetchedAt === a2.fetchedAt, "cache: second answer flagged cached with the original fetchedAt");
ok(a2.count === 3 && a2.rates.find((r) => r.code === "usd").perBtc === 77000, "exchange-rates: shape");
const a3 = await h("exchange-rates")({ type: "fiat" });
ok(calls.length === 1 && a3.count === 1 && a3.rates[0].code === "usd" && a3.cached === true, "exchange-rates: type filter projects from the same cached upstream answer");
const a4 = await h("exchange-rates")({ currencies: "xau,btc" });
ok(a4.count === 2 && a4.rates.map((r) => r.code).sort().join() === "btc,xau", "exchange-rates: currencies filter");
await throws(h("exchange-rates")({ type: "metal" }), 400, "exchange-rates: bad type");
clearCryptoMarketsCache();
await h("exchange-rates")({});
ok(calls.length === 2, "cache: cleared cache fetches again");
// different query params -> different key
reset();
routes = { "/api/v3/coins/bitcoin/ohlc": jsonRes(200, [[1787319000000, 1, 2, 0.5, 1.5], [1787320800000, 1.5, 3, 1, 2]]) };
await h("coin-ohlc")({ coin: "bitcoin", days: 1 });
await h("coin-ohlc")({ coin: "bitcoin", days: 7 });
ok(calls.length === 2 && calls[0].url.searchParams.get("days") === "1" && calls[1].url.searchParams.get("days") === "7", "cache: a different input is a different key");
// TTL expiry honoured
ok(__test.TTL.price === 60_000 && __test.TTL.list === 300_000 && __test.TTL.coinList === 600_000, "TTL classes: 60s prices, 5min lists, 10min coin list");
{
  reset();
  const realNow = Date.now;
  await h("coin-ohlc")({ coin: "bitcoin", days: 1 });
  Date.now = () => realNow() + 61_000;
  try { await h("coin-ohlc")({ coin: "bitcoin", days: 1 }); } finally { Date.now = realNow; }
  ok(calls.length === 2, "cache: a 60s price entry expires after its TTL");
}

// ----------------------------------------------------------------------------
// Real-world assets (/rwas, live shapes captured 2026-09-02)
// ----------------------------------------------------------------------------
{
  reset();
  const gold = { id: "gold", symbol: "xau", name: "Gold", asset_type: "commodity", image: "https://img/gold.png", tokenized_market_data: { current_price: 4376.6, market_cap: 5219552133, total_volume: 557496353, high_24h: 4394.94, low_24h: 4289.36, price_change_24h: 42.77, price_change_percentage_24h: 0.98698, market_cap_change_24h: 44135859, market_cap_change_percentage_24h: 0.8528, last_updated: "2026-09-02T18:49:00Z" } };
  routes = {
    "/api/v3/rwas/list": jsonRes(200, [{ id: "gold", symbol: "xau", name: "Gold", asset_type: "commodity" }, { id: "nvidia", symbol: "nvda", name: "Nvidia", asset_type: "stock" }, { id: "spdr-gold", symbol: "gld", name: "SPDR Gold Shares", asset_type: "etf" }]),
    "/api/v3/rwas/markets": jsonRes(200, [gold]),
    "/api/v3/rwas/issuers/list": jsonRes(200, [{ id: "coinbase-ecosystem", name: "Coinbase" }]),
    "/api/v3/rwas/issuers/coinbase-ecosystem": jsonRes(200, { id: "coinbase-ecosystem", name: "Coinbase", market_cap: 9982908.5, market_cap_change_24h: 100918.3, volume_24h: 20001148, updated_at: "2026-09-02T17:00:00Z", tokens: [{ id: "nvidia-coinbase-tokenized-stock", symbol: "nvdac", name: "NVIDIA (Coinbase Tokenized Stock)", platforms: { base: "0xb20000000000000000000078ee7ce2fe4908108c", junk: null } }] }),
    "/api/v3/rwas/gold": jsonRes(200, { id: "gold", symbol: "xau", name: "Gold", asset_type: "commodity", image: { large: "https://img/gold-large.png" }, web_slug: "gold", last_updated: "2026-09-02T18:49:00Z" }),
  };
  const l = await h("rwa-list")({ type: "commodity" });
  ok(l.total === 3 && l.byType.stock === 1 && l.byType.etf === 1 && l.count === 1 && l.assets[0].id === "gold" && l.assets[0].symbol === "XAU", "rwa-list: type filter + counts by type + upper-cased symbol");
  const lq = await h("rwa-list")({ q: "nvda" });
  ok(calls.length === 1 && lq.count === 1 && lq.assets[0].id === "nvidia" && lq.cached === true, "rwa-list: q matches symbol, projected from the cached list");
  await throws(h("rwa-list")({ type: "bond" }), 400, "rwa-list: unknown type");
  const m = await h("rwa-markets")({ type: "stock", order: "volume_desc", perPage: 10, currency: "eur" });
  const mu = calls.at(-1).url.searchParams;
  ok(mu.get("vs_currency") === "eur" && mu.get("asset_type") === "stock" && mu.get("order") === "volume_desc" && mu.get("per_page") === "10" && mu.get("page") === "1", "rwa-markets: every filter rides as a query parameter");
  ok(m.count === 1 && m.markets[0].price === 4376.6 && m.markets[0].change24hPct === 0.98698 && m.markets[0].symbol === "XAU" && m.markets[0].currency === "eur", "rwa-markets: tokenized_market_data flattened");
  await throws(h("rwa-markets")({ order: "alphabetical" }), 400, "rwa-markets: unknown order");
  await throws(h("rwa-markets")({ perPage: 500 }), 400, "rwa-markets: perPage bound");
  const ids = await h("rwa-markets")({ ids: "gold,nvidia" });
  ok(calls.at(-1).url.searchParams.get("ids") === "gold,nvidia" && ids.ids.length === 2, "rwa-markets: ids list");
  const a = await h("rwa-asset")({ id: "gold" });
  ok(a.id === "gold" && a.webSlug === "gold" && a.image === "https://img/gold-large.png" && a.market?.price === 4376.6 && a.market.currency === "usd", "rwa-asset: metadata joined with its market row");
  ok(calls.filter((c) => c.url.pathname === "/api/v3/rwas/gold").length === 1 && calls.filter((c) => c.url.pathname === "/api/v3/rwas/markets").length === 3, "rwa-asset: two upstream reads, both through the cache");
  await throws(h("rwa-asset")({}), 400, "rwa-asset: id required");
  const is = await h("rwa-issuers")({});
  ok(is.count === 1 && is.issuers[0].id === "coinbase-ecosystem", "rwa-issuers: list");
  const one = await h("rwa-issuer")({ id: "coinbase-ecosystem" });
  ok(one.name === "Coinbase" && one.marketCap === 9982908.5 && one.count === 1 && one.tokens[0].symbol === "NVDAC" && one.tokens[0].platforms.base === "0xb20000000000000000000078ee7ce2fe4908108c" && !("junk" in one.tokens[0].platforms), "rwa-issuer: aggregate + tokens with contracts, empty platforms dropped");
  routes["/api/v3/rwas/issuers/nope"] = jsonRes(404, {});
  await throws(h("rwa-issuer")({ id: "nope" }), 422, "rwa-issuer: unknown id -> 422");
  for (const t of CRYPTO_MARKETS_TOOLS.filter((x) => x.slug.startsWith("rwa-"))) ok(!/\u2014/.test(t.description) && t.discovery.output.example.source === "coingecko" && typeof t.discovery.output.example.fetchedAt === "string", `${t.slug}: description + example envelope`);
}

// ----------------------------------------------------------------------------
// Status mapping (body never relayed)
// ----------------------------------------------------------------------------
reset();
routes = { "/api/v3/coins/nosuch/ohlc": jsonRes(404, { error: "coin not found" }) };
await throws(h("coin-ohlc")({ coin: "nosuch", days: 1 }), 422, "404 -> 422");
reset();
routes = { "/api/v3/coins/bitcoin/ohlc": jsonRes(429, { status: { error_code: 429, error_message: "SECRET-UPSTREAM-TEXT" } }) };
await throws(h("coin-ohlc")({ coin: "bitcoin", days: 1 }), 503, "429 -> 503 with retry hint", /retry/i);
ok(calls.length === 2, "429: exactly one retry before mapping");
try { await h("coin-ohlc")({ coin: "bitcoin", days: 1 }); } catch (e) { ok(!/SECRET-UPSTREAM-TEXT/.test(e.message), "429: upstream body not relayed"); }
reset();
let n = 0;
routes = { "/api/v3/coins/bitcoin/ohlc": () => (++n === 1 ? jsonRes(503, "down") : jsonRes(200, [[1787319000000, 1, 2, 0.5, 1.5]])) };
const rec = await h("coin-ohlc")({ coin: "bitcoin", days: 1 });
ok(rec.count === 1 && calls.length === 2, "5xx then 200: retry recovers");
reset();
routes = { "/api/v3/coins/bitcoin/ohlc": jsonRes(502, "<html>SECRET-UPSTREAM-TEXT</html>") };
await throws(h("coin-ohlc")({ coin: "bitcoin", days: 1 }), 502, "persistent 5xx -> 502", /^((?!SECRET).)*$/);
reset();
routes = { "/api/v3/coins/bitcoin/history": jsonRes(401, { error: { status: { error_code: 10012, error_message: "SECRET-UPSTREAM-TEXT" } } }) };
await throws(h("coin-history")({ coin: "bitcoin", daysAgo: 10 }), 422, "401 (plan limit) -> 422", /^((?!SECRET).)*$/);
reset();
routes = { "/api/v3/global/decentralized_finance_defi": jsonRes(200, "not-json") };
await throws(h("global-defi")({}), 502, "non-JSON 200 -> 502");
reset();
routes = { "/api/v3/global/decentralized_finance_defi": jsonRes(200, { nope: true }) };
await throws(h("global-defi")({}), 502, "unexpected shape -> 502");
reset();
routes = { "/api/v3/exchange_rates": () => { const e = new Error("aborted"); e.name = "TimeoutError"; throw e; } };
await throws(h("exchange-rates")({}), 504, "timeout -> 504", /timed out/);
reset();
routes = { "/api/v3/exchange_rates": () => { throw new Error("ECONNRESET"); } };
await throws(h("exchange-rates")({}), 504, "network error -> 504");
ok(calls.length === 1, "network error: no retry loop (timeout budget stays bounded)");

// ----------------------------------------------------------------------------
// Validation (400, no fetch)
// ----------------------------------------------------------------------------
reset();
routes = {};
const CASES = [
  ["coin-price-by-contract", {}, /platform/],
  ["coin-price-by-contract", { platform: "ethereum" }, /contracts/],
  ["coin-price-by-contract", { platform: "ethereum", contracts: "0xabc def" }, /contract/],
  ["coin-price-by-contract", { platform: "ethereum", contracts: Array(26).fill("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48").join(",") }, /at most 25/],
  ["coin-price-by-contract", { platform: "eth/../x", contracts: "0xabc" }, /platform/],
  ["coin-price-by-contract", { platform: "ethereum", contracts: "0xabc", currency: "U$D" }, /currency/],
  ["coin-profile", {}, /coin/],
  ["coin-profile", { coin: "bit coin" }, /coin/],
  ["coin-history", { coin: "bitcoin", date: "2020-01-01" }, /365/],
  ["coin-history", { coin: "bitcoin", date: "01/01/2026" }, /YYYY-MM-DD/],
  ["coin-history", { coin: "bitcoin", date: "2099-01-01" }, /future/],
  ["coin-history", { coin: "bitcoin", daysAgo: 0 }, /daysAgo/],
  ["coin-history", { coin: "bitcoin", daysAgo: 366 }, /daysAgo/],
  ["coin-ohlc", { coin: "bitcoin", days: 3 }, /one of/],
  ["coin-ohlc", { coin: "bitcoin", days: "max" }, /days/],
  ["coin-market-chart-range", { coin: "bitcoin", from: "2026-08-02", to: "2026-08-01" }, /before/],
  ["coin-market-chart-range", { coin: "bitcoin", from: "2020-01-01", to: "2020-01-02" }, /365/],
  ["coin-market-chart-range", { coin: "bitcoin", lookback: "3y" }, /lookback/],
  ["coin-market-chart-range", { coin: "bitcoin", from: "yesterday" }, /from/],
  ["coin-categories", { order: "volume_desc" }, /order/],
  ["coin-categories", { limit: 101 }, /limit/],
  ["exchanges", { limit: 0 }, /limit/],
  ["exchanges", { exchange: "bin ance" }, /exchange/],
  ["exchange-tickers", {}, /exchange/],
  ["exchange-tickers", { exchange: "binance", coins: Array(11).fill("bitcoin").join(",") }, /at most 10/],
  ["exchange-tickers", { exchange: "binance", limit: 101 }, /limit/],
  ["coin-search", {}, /query/],
  ["coin-search", { query: "x".repeat(65) }, /64/],
  ["coin-search", { query: "usdc", limit: 51 }, /limit/],
  ["coins-list", { perPage: 501 }, /perPage/],
  ["coins-list", { includePlatforms: "maybe" }, /true\/false/],
  ["coins-list", { symbol: "usd c" }, /symbol/],
];
for (const [slug, input, re] of CASES) await throws(h(slug)(input), 400, `${slug} ${JSON.stringify(input).slice(0, 70)}`, re);
ok(calls.length === 0, "validation failures make no upstream call");

// ----------------------------------------------------------------------------
// Fixture shapes
// ----------------------------------------------------------------------------
reset();
routes = {
  "/api/v3/simple/token_price/ethereum": (u) => {
    ok(u.searchParams.get("contract_addresses") === "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,0xdead" && u.searchParams.get("vs_currencies") === "eur", "coin-price-by-contract: query built");
    return jsonRes(200, { "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { eur: 0.91, eur_market_cap: 1e9, eur_24h_vol: 2e8, eur_24h_change: 0.0123456, last_updated_at: 1787404540 } });
  },
};
const tp = await h("coin-price-by-contract")({ platform: "Ethereum", contracts: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 0xdead", currency: "EUR" });
ok(tp.platform === "ethereum" && tp.currency === "eur" && tp.count === 1 && tp.tokens.length === 2, "coin-price-by-contract: count = priced tokens, unknown kept as null row");
ok(tp.tokens[0].contract === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" && tp.tokens[0].price === 0.91 && tp.tokens[0].change24hPct === 0.0123 && tp.tokens[0].lastUpdated === "2026-08-22T13:15:40.000Z", "coin-price-by-contract: checksummed input matches lowercase upstream key + fields");
ok(tp.tokens[1].contract === "0xdead" && tp.tokens[1].price === null, "coin-price-by-contract: unknown contract -> null fields");

reset();
routes = {
  "/api/v3/coins/ethereum": (u) => {
    ok(u.searchParams.get("localization") === "false" && u.searchParams.get("tickers") === "false" && u.searchParams.get("market_data") === "true", "coin-profile: trimmed upstream query");
    return jsonRes(200, {
      id: "ethereum", symbol: "eth", name: "Ethereum", market_cap_rank: 2, hashing_algorithm: "Ethash", genesis_date: "2015-07-30",
      description: { en: "Ethereum is   a global,\n open-source platform. " + "x".repeat(1000) },
      categories: ["Smart Contract Platform", null, "Layer 1 (L1)"],
      detail_platforms: { "": { decimal_place: null, contract_address: "" }, ethereum: { decimal_place: 18, contract_address: "" }, base: { decimal_place: 18, contract_address: "0x42" } },
      links: { homepage: ["", "https://www.ethereum.org/"], blockchain_site: ["https://etherscan.io/", "", "https://a", "https://b", "https://c"], repos_url: { github: ["https://github.com/ethereum/go-ethereum"] }, twitter_screen_name: "ethereum", subreddit_url: "https://www.reddit.com/r/ethereum", whitepaper: "" },
      market_data: { current_price: { usd: 2424.5, eur: 2100 }, market_cap: { usd: 2.9e11 }, fully_diluted_valuation: { usd: 2.9e11 }, total_volume: { usd: 1.4e10 }, high_24h: { usd: 2480.1 }, low_24h: { usd: 2390.2 }, price_change_percentage_24h_in_currency: { usd: 1.23456 }, price_change_percentage_7d: -3.1, price_change_percentage_30d_in_currency: { usd: 8.4 }, price_change_percentage_1y_in_currency: { usd: -12.9 }, ath: { usd: 4878.26 }, ath_date: { usd: "2021-11-10T14:24:19.604Z" }, ath_change_percentage: { usd: -50.3 }, atl: { usd: 0.432979 }, atl_date: { usd: "2015-10-20T00:00:00.000Z" }, circulating_supply: 120700000, total_supply: 120700000, max_supply: null, last_updated: "2026-08-22T13:19:00.000Z" },
      sentiment_votes_up_percentage: 71.4, watchlist_portfolio_users: 2200000,
    });
  },
};
const prof = await h("coin-profile")({ coin: "ethereum" });
ok(prof.id === "ethereum" && prof.symbol === "ETH" && prof.rank === 2 && prof.currency === "usd", "coin-profile: identity");
ok(prof.description.startsWith("Ethereum is a global, open-source platform.") && prof.description.length <= 600, "coin-profile: description whitespace-collapsed + trimmed to 600");
ok(prof.categories.length === 2 && prof.platforms.length === 2 && prof.platforms.find((p) => p.platform === "base").contract === "0x42" && prof.platforms.find((p) => p.platform === "ethereum").contract === null, "coin-profile: categories filtered, platforms without the empty key");
ok(prof.links.homepage === "https://www.ethereum.org/" && prof.links.explorers.length === 3 && prof.links.repos.length === 1 && prof.links.twitter === "ethereum" && prof.links.whitepaper === null, "coin-profile: links picked (first non-empty, top 3 explorers)");
ok(prof.market.price === 2424.5 && prof.market.change24hPct === 1.2346 && prof.market.change7dPct === -3.1 && prof.market.ath === 4878.26 && prof.market.maxSupply === null && prof.market.lastUpdated === "2026-08-22T13:19:00.000Z", "coin-profile: market block (per-currency with scalar fallback)");
ok(prof.sentimentUpPct === 71.4 && prof.watchlistUsers === 2200000, "coin-profile: sentiment + watchlist");

reset();
routes = {
  "/api/v3/coins/bitcoin/history": (u) => {
    ok(/^\d{2}-\d{2}-\d{4}$/.test(u.searchParams.get("date")) && u.searchParams.get("localization") === "false", `coin-history: date sent dd-mm-yyyy (${u.searchParams.get("date")})`);
    return jsonRes(200, { id: "bitcoin", symbol: "btc", name: "Bitcoin", market_data: { current_price: { usd: 118412.55, eur: 100812.3, btc: 1 }, market_cap: { usd: 2.356e12 }, total_volume: { usd: 4.1e10 } } });
  },
};
const hist = await h("coin-history")({ coin: "bitcoin", daysAgo: "30" });
ok(hist.id === "bitcoin" && hist.symbol === "BTC" && /^\d{4}-\d{2}-\d{2}$/.test(hist.date) && hist.price === 118412.55 && hist.marketCap === 2.356e12 && hist.volume24h === 4.1e10, "coin-history: snapshot fields (daysAgo as a query string)");
ok(hist.allCurrencies.price.eur === 100812.3 && hist.allCurrencies.price.btc === 1 && Object.keys(hist.allCurrencies.marketCap).join() === "usd", "coin-history: allCurrencies maps");
const expectDate = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
ok(hist.date === expectDate, `coin-history: daysAgo 30 -> ${expectDate}`);
const histByDate = await h("coin-history")({ coin: "bitcoin", date: expectDate });
ok(histByDate.cached === true && histByDate.date === expectDate, "coin-history: explicit date hits the same cache entry as daysAgo");
reset();
routes = { "/api/v3/coins/bitcoin/history": jsonRes(200, { id: "bitcoin", symbol: "btc", name: "Bitcoin" }) };
await throws(h("coin-history")({ coin: "bitcoin", daysAgo: 5 }), 422, "coin-history: no market_data on that date -> 422");

reset();
routes = { "/api/v3/coins/bitcoin/ohlc": jsonRes(200, [[1787319000000, 100, 110, 90, 105], [1787320800000, 105, 120, 100, 115], [1787322600000, 115, 118, 95, 98], ["junk"]]) };
const ohlc = await h("coin-ohlc")({ coin: "BITCOIN", days: "7", currency: "Usd" });
ok(ohlc.coin === "bitcoin" && ohlc.days === 7 && ohlc.currency === "usd" && ohlc.count === 3 && ohlc.granularity === "30m", "coin-ohlc: inputs normalized, junk row dropped, granularity derived from spacing");
ok(ohlc.bars[0].time === "2026-08-21T13:30:00.000Z" && ohlc.bars[0].open === 100 && ohlc.bars[0].close === 105, "coin-ohlc: bar shape");
ok(ohlc.summary.first === 100 && ohlc.summary.last === 98 && ohlc.summary.high === 120 && ohlc.summary.low === 90 && ohlc.summary.changePct === -2, "coin-ohlc: summary");
ok(calls[0].url.searchParams.get("vs_currency") === "usd" && calls[0].url.searchParams.get("days") === "7", "coin-ohlc: upstream query");

reset();
routes = {
  "/api/v3/coins/ethereum/market_chart/range": (u) => {
    const from = Number(u.searchParams.get("from")), to = Number(u.searchParams.get("to"));
    ok(to - from === 3 * 86_400 && Math.abs(to - Date.now() / 1000) < 5, "coin-market-chart-range: lookback 3d -> from/to in unix seconds ending now");
    return jsonRes(200, { prices: [[1787148000000, 1900], [1787151600000, 1950], [1787155200000, 2000]], market_caps: [[1787148000000, 1], [1787151600000, 2], [1787155200000, 3]], total_volumes: [[1787148000000, 10], [1787151600000, 20]] });
  },
};
const rng = await h("coin-market-chart-range")({ coin: "ethereum", lookback: "3d" });
ok(rng.count === 3 && rng.granularity === "1h" && rng.points[2].marketCap === 3 && rng.points[2].volume === null && rng.summary.first === 1900 && rng.summary.last === 2000 && rng.summary.changePct === 5.2632, "coin-market-chart-range: zipped points + summary + derived granularity");
reset();
const fromIso = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
const fromSec = Math.floor(Date.parse(fromIso + "T00:00:00Z") / 1000), toSec = fromSec + 86_400;
routes = { "/api/v3/coins/ethereum/market_chart/range": (u) => { ok(u.searchParams.get("from") === String(fromSec) && u.searchParams.get("to") === String(toSec), "coin-market-chart-range: ISO from + unix-string to -> unix seconds"); return jsonRes(200, { prices: [], market_caps: [], total_volumes: [] }); } };
const rng2 = await h("coin-market-chart-range")({ coin: "ethereum", from: fromIso, to: String(toSec) });
ok(rng2.count === 0 && rng2.summary.first === null && rng2.granularity === null, "coin-market-chart-range: empty series is a valid answer");

reset();
routes = {
  "/api/v3/coins/categories": (u) => {
    ok(u.searchParams.get("order") === "market_cap_change_24h_desc", "coin-categories: order forwarded");
    return jsonRes(200, [
      { id: "meme-token", name: "Meme", market_cap: 3.3e10, market_cap_change_24h: 7.18951, volume_24h: 8.5e9, content: "long " + "x".repeat(5000), top_3_coins_id: ["dogecoin", "shiba-inu", "memecore"], top_3_coins: ["https://coin-images/x/thumb/doge.png?1"], updated_at: "2026-08-22T13:18:16.000Z" },
      { id: "ai", name: "Artificial Intelligence (AI)", market_cap: 2e10, market_cap_change_24h: 3, volume_24h: 1e9, top_3_coins: ["https://coin-images/x/thumb/tao.png?1"], updated_at: "2026-08-22T13:18:16.000Z" },
      { id: "layer-2", name: "Layer 2 (L2)", market_cap: 1e10, market_cap_change_24h: -1, volume_24h: 5e8, top_3_coins_id: [], updated_at: null },
    ]);
  },
};
const cats = await h("coin-categories")({ order: "MARKET_CAP_CHANGE_24H_DESC", limit: 2 });
ok(cats.count === 2 && cats.totalCategories === 3 && cats.categories[0].rank === 1 && cats.categories[0].id === "meme-token" && cats.categories[0].marketCapChange24hPct === 7.1895 && cats.categories[0].topCoins.join() === "dogecoin,shiba-inu,memecore", "coin-categories: ranked rows, content stripped, top coin ids");
ok(!("content" in cats.categories[0]) && cats.categories[1].topCoins.join() === "tao", "coin-categories: no content field; image-stem fallback for top coins");
const catsQ = await h("coin-categories")({ order: "market_cap_change_24h_desc", query: "LAYER" });
ok(catsQ.cached === true && catsQ.count === 1 && catsQ.categories[0].id === "layer-2" && catsQ.categories[0].rank === 3 && catsQ.categories[0].topCoins.length === 0, "coin-categories: query filter keeps global rank, from cache");

reset();
routes = { "/api/v3/global/decentralized_finance_defi": jsonRes(200, { data: { defi_market_cap: "112237506811.10075", eth_market_cap: "292876442962.28284", defi_to_eth_ratio: "38.331686303254564", trading_volume_24h: "10184726070.56023", defi_dominance: "4.156593154239217", top_coin_name: "Lido Staked Ether", top_coin_defi_dominance: 20.7086236328179 } }) };
const gd = await h("global-defi")({});
ok(gd.defiMarketCapUsd === 112237506811.10075 && gd.defiToEthRatioPct === 38.3317 && gd.defiDominancePct === 4.1566 && gd.topCoin.name === "Lido Staked Ether" && gd.topCoin.defiDominancePct === 20.7086, "global-defi: numeric strings parsed, pcts rounded");

reset();
routes = {
  "/api/v3/exchanges/kraken": jsonRes(200, { name: "Kraken", year_established: 2011, country: "United States", description: "Kraken   is\n an exchange.", url: "https://www.kraken.com/", centralized: true, trust_score: 10, trust_score_rank: 3, trade_volume_24h_btc: 31000.5, trade_volume_24h_btc_normalized: 30000.1, coins: 500, pairs: 1200, has_trading_incentive: false, twitter_handle: "krakenfx", facebook_url: "", reddit_url: null, telegram_url: "", tickers: [{}, {}, {}] }),
  "/api/v3/exchanges": (u) => { ok(u.searchParams.get("per_page") === "2" && u.searchParams.get("page") === "3", "exchanges: per_page + page forwarded"); return jsonRes(200, [{ id: "gdax", name: "Coinbase Exchange", country: "United States", year_established: 2012, trust_score: 10, trust_score_rank: 1, trade_volume_24h_btc: 28651.7, trade_volume_24h_btc_normalized: 28651.7, centralized: true, url: "https://www.coinbase.com/" }, { id: "binance", name: "Binance", country: null, year_established: 2017, trust_score: 10, trust_score_rank: 2, trade_volume_24h_btc: 1e5, trade_volume_24h_btc_normalized: 9e4, centralized: true, url: "https://www.binance.com/" }]); },
};
const exl = await h("exchanges")({ limit: "2", page: "3" });
ok(exl.mode === "list" && exl.page === 3 && exl.count === 2 && exl.exchanges[0].rank === 5 && exl.exchanges[1].rank === 6 && exl.exchanges[0].id === "gdax" && exl.exchanges[0].trustScore === 10 && exl.exchanges[1].country === null, "exchanges: list mode shape + absolute rank across pages");
const exp = await h("exchanges")({ exchange: "Kraken" });
ok(exp.mode === "profile" && exp.exchange.id === "kraken" && exp.exchange.description === "Kraken is an exchange." && exp.exchange.tickerCount === 3 && exp.exchange.coinsCount === 500 && exp.exchange.links.twitter === "krakenfx" && exp.exchange.links.facebook === null && exp.exchange.volume24hBtcNormalized === 30000.1, "exchanges: profile mode shape");
ok(!("tickers" in exp.exchange), "exchanges: profile does not relay the 70KB tickers array");

reset();
routes = {
  "/api/v3/exchanges/binance/tickers": (u) => {
    ok(u.searchParams.get("coin_ids") === "ethereum,bitcoin" && u.searchParams.get("page") === "2" && u.searchParams.get("include_exchange_logo") === "false", "exchange-tickers: coin_ids + page forwarded");
    return jsonRes(200, { name: "Binance", tickers: [
      { base: "ETH", target: "USDT", coin_id: "ethereum", target_coin_id: "tether", last: 2424.51, volume: 412000.5, converted_last: { btc: 0.0314, usd: 2424.6 }, converted_volume: { usd: 998000000 }, bid_ask_spread_percentage: 0.010004, trust_score: "green", is_anomaly: false, is_stale: false, trade_url: "https://www.binance.com/en/trade/ETH_USDT", last_traded_at: "2026-08-22T13:19:30+00:00" },
      { base: "BTC", target: "USDT", coin_id: "bitcoin", last: 77000, volume: 1, converted_last: {}, converted_volume: {}, trust_score: null, is_anomaly: true, is_stale: true },
      { base: "X", target: "Y" },
    ] });
  },
};
const tk = await h("exchange-tickers")({ exchange: "binance", coins: "ethereum, bitcoin", page: 2, limit: 2 });
ok(tk.exchangeName === "Binance" && tk.count === 2 && tk.coins.join() === "ethereum,bitcoin" && tk.page === 2, "exchange-tickers: limit trims, filters echoed");
ok(tk.tickers[0].base === "ETH" && tk.tickers[0].lastUsd === 2424.6 && tk.tickers[0].lastBtc === 0.0314 && tk.tickers[0].spreadPct === 0.01 && tk.tickers[0].trustScore === "green" && tk.tickers[0].anomaly === false && tk.tickers[0].lastTradedAt === "2026-08-22T13:19:30.000Z", "exchange-tickers: ticker shape");
ok(tk.tickers[1].lastUsd === null && tk.tickers[1].anomaly === true && tk.tickers[1].stale === true && tk.tickers[1].trustScore === null, "exchange-tickers: sparse ticker -> nulls, flags boolean");

reset();
routes = { "/api/v3/search": (u) => { ok(u.searchParams.get("query") === "usd coin", "coin-search: query forwarded (whitespace collapsed)"); return jsonRes(200, { coins: [{ id: "zzz-usdc", symbol: "zusdc", name: "Z", market_cap_rank: null }, { id: "usd-coin", symbol: "usdc", name: "USDC", market_cap_rank: 6 }, { id: "other", symbol: "o", name: "O", market_cap_rank: 900 }], exchanges: [{ id: "ex1", name: "Ex One", market_type: "spot" }], icos: [], categories: [{ id: "usdc-stablecoins", name: "USDC Stablecoins" }], nfts: [{ id: "n1", symbol: "N1", name: "NFT One" }] }); } };
const srch = await h("coin-search")({ query: "  usd   coin ", limit: 2 });
ok(srch.query === "usd coin" && srch.counts.coins === 2 && srch.coins[0].id === "usd-coin" && srch.coins[0].symbol === "USDC" && srch.coins[1].id === "other" && srch.counts.exchanges === 1 && srch.categories[0].id === "usdc-stablecoins" && srch.nfts[0].id === "n1", "coin-search: ranked coins (unranked last), per-group limit, groups shaped");

reset();
routes = {
  "/api/v3/coins/list": (u) => jsonRes(200, u.searchParams.get("include_platform") === "true"
    ? [{ id: "usd-coin", symbol: "usdc", name: "USDC", platforms: { ethereum: "0xa0b8", base: "0x8335", "": "" } }, { id: "bridged-usdc", symbol: "USDC", name: "Bridged", platforms: { base: "0x1" } }, { id: "bitcoin", symbol: "btc", name: "Bitcoin", platforms: {} }, { id: "sol-only", symbol: "zzz", name: "Z", platforms: { solana: "abc" } }]
    : [{ id: "usd-coin", symbol: "usdc", name: "USDC" }, { id: "bridged-usdc", symbol: "USDC", name: "Bridged" }, { id: "bitcoin", symbol: "btc", name: "Bitcoin" }, { id: "sol-only", symbol: "zzz", name: "Z" }]),
};
const cl = await h("coins-list")({ perPage: 2, page: 2 });
ok(cl.total === 4 && cl.totalPages === 2 && cl.page === 2 && cl.count === 2 && cl.coins[0].id === "bitcoin" && !("platforms" in cl.coins[0]), "coins-list: local paging, platforms omitted by default");
ok(calls[0].url.searchParams.get("include_platform") === null, "coins-list: include_platform not sent unless asked");
const cl2 = await h("coins-list")({ perPage: 2, page: 1 });
ok(cl2.cached === true && calls.length === 1 && cl2.coins[0].id === "usd-coin", "coins-list: paging through the list reuses one cached upstream answer");
const cl3 = await h("coins-list")({ symbol: "USDC", includePlatforms: "true" });
ok(calls.length === 2 && cl3.total === 2 && cl3.coins[0].platforms.ethereum === "0xa0b8" && !("" in cl3.coins[0].platforms) && cl3.coins[1].platforms.base === "0x1" && cl3.filters.symbol === "usdc", "coins-list: symbol filter (case-insensitive) + platforms (empty key dropped)");
const cl4 = await h("coins-list")({ platform: "base" });
ok(calls.length === 2 && cl4.total === 2 && cl4.coins.every((c) => c.platforms.base) && cl4.filters.platform === "base", "coins-list: platform filter implies platforms, served from cache");
const cl5 = await h("coins-list")({ platform: "solana", symbol: "zzz" });
ok(cl5.total === 1 && cl5.coins[0].id === "sol-only", "coins-list: platform + symbol filters combine");

// ----------------------------------------------------------------------------
// Cache bound
// ----------------------------------------------------------------------------
reset();
routes = { "/api/v3/coins/": (u) => jsonRes(200, [[1, 1, 1, 1, 1]]) };
for (let k = 0; k < __test.MAX_ENTRIES + 5; k++) await h("coin-ohlc")({ coin: `c${k}`, days: 1 });
await h("coin-ohlc")({ coin: "c0", days: 1 });
ok(calls.length === __test.MAX_ENTRIES + 6, "cache: bounded (oldest entry evicted past MAX_ENTRIES)");

// --- the Demo-plan token bucket refuses past the per-minute budget ------------
{
  const raw = CRYPTO_MARKETS_TOOLS.find((t) => t.slug === "coin-search").handler;
  process.env.COINGECKO_MAX_PER_MIN = "2";
  resetCgRateLimit();
  clearCryptoMarketsCache();
  let last = null;
  globalThis.fetch = async () => jsonRes(200, { coins: [] });
  for (let i = 0; i < 3; i++) {
    try { await raw({ query: `q${i}` }); last = null; } catch (e) { last = e; }
  }
  ok(last && last.statusCode === 503, "rate bucket: past the per-minute budget the caller gets 503, never a charge");
  delete process.env.COINGECKO_MAX_PER_MIN;
  resetCgRateLimit();
}

// --- the coin profile does not depend on a block CoinGecko is removing --------
// community_data and developer_data disappear from /coins/{id} on 2026-08-28.
// Our two figures are top-level and survive; this pins that we neither ask for
// the doomed block nor read from it.
{
  const src = readFileSync(new URL("../src/tools/crypto-markets-kit.js", import.meta.url), "utf8");
  ok(!/community_data: "true"/.test(src), "the profile call does not request the community_data block");
  ok(!/\.community_data\b/.test(src), "no field is read out of community_data");
  ok(/sentiment_votes_up_percentage/.test(src) && /watchlist_portfolio_users/.test(src),
    "sentiment and watchlist come from the TOP-LEVEL fields that survive the removal");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
