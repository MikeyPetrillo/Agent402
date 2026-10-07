#!/usr/bin/env node
// One CoinGecko bucket for both kits. crypto-markets-kit had a private 25/min
// bucket and crypto-kit had none, so together they overran the one Demo key.
// Offline: fetch is stubbed; the bucket is exhausted by hand.
import assert from "node:assert/strict";
process.env.X402_INDEX_CRAWL = "off";
const rate = await import("../src/tools/coingecko-rate.js");
const markets = await import("../src/tools/crypto-markets-kit.js");
const { CRYPTO_TOOLS } = await import("../src/tools/crypto-kit.js");
let n = 0; const ok = (c, m) => { n++; assert.ok(c, m); }; const eq = (a, b, m) => { n++; assert.equal(a, b, m); };

// bucket semantics
rate.resetCgRateLimit();
process.env.COINGECKO_MAX_PER_MIN = "3";
const t0 = 1_000_000;
ok(rate.takeCgToken(t0) && rate.takeCgToken(t0) && rate.takeCgToken(t0), "three tokens at cap 3");
ok(!rate.takeCgToken(t0), "the fourth is refused");
ok(rate.takeCgToken(t0 + 20_001), "a third of a minute later one token has refilled");
ok(!rate.takeCgToken(t0 + 20_001), "and only one");
ok(rate.isCoinGeckoHost("api.coingecko.com") && rate.isCoinGeckoHost("pro-api.coingecko.com") && rate.isCoinGeckoHost("COINGECKO.COM") && !rate.isCoinGeckoHost("api.exchange.coinbase.com"), "host test");
ok(!rate.isCoinGeckoHost("evilcoingecko.com") && !rate.isCoinGeckoHost("coingecko.com.attacker.example"), "a host that merely ends in the letters never gets the key (CodeQL js/incomplete-url-substring-sanitization)");
eq(markets.resetCgRateLimit, rate.resetCgRateLimit, "crypto-markets-kit re-exports the SHARED reset (one bucket, not two)");

// crypto-kit refuses before fetching when the bucket is empty
const priceTool = CRYPTO_TOOLS.find((t) => t.slug === "crypto-price");
const orig = globalThis.fetch; let fetched = 0;
globalThis.fetch = async () => { fetched++; return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); };
try {
  rate.resetCgRateLimit();
  while (rate.takeCgToken(Date.now())) { /* drain */ }
  let err = null;
  try { await priceTool.handler({ coins: "BTC" }); } catch (e) { err = e; }
  eq(err?.statusCode, 503, "empty bucket -> 503 before any upstream call");
  ok(/not charged/i.test(String(err?.message)), "the refusal says nobody paid");
  eq(fetched, 0, "no CoinGecko request was made");
} finally { globalThis.fetch = orig; delete process.env.COINGECKO_MAX_PER_MIN; rate.resetCgRateLimit(); }

// ---- daily ceiling (keyed deployments) --------------------------------------
const { PRICE_FEED_TOOLS, clearPriceFeedCache } = await import("../src/tools/price-feed-kit.js");
const { clearCryptoCache } = await import("../src/tools/crypto-kit.js");
const J = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
{
  process.env.COINGECKO_API_KEY = "cg-test-key";
  process.env.COINGECKO_DAILY_MAX = "3";
  rate.resetCgRateLimit();
  const day = Date.UTC(2030, 0, 1, 12);
  ok(rate.takeCgToken(day) && rate.takeCgToken(day + 1000) && rate.takeCgToken(day + 2000), "three calls inside the daily ceiling");
  eq(rate.cgTokenRefusal(day + 60_000), "day", "the fourth in the same UTC day is refused as daily");
  ok(/temporarily unavailable/i.test(rate.cgRefusalMessage("day")) && !/\d/.test(rate.cgRefusalMessage("day")), "daily refusal text says temporarily unavailable and carries no count");
  eq(rate.cgTokenRefusal(day + 86_400_000), null, "the next UTC day starts a fresh count");
  delete process.env.COINGECKO_API_KEY;
  rate.resetCgRateLimit();
  ok(rate.takeCgToken(day) && rate.takeCgToken(day) && rate.takeCgToken(day) && rate.takeCgToken(day), "keyless calls are not held to the daily ceiling");

  // Every CoinGecko caller refuses 503 before any upstream call once the day is spent.
  process.env.COINGECKO_API_KEY = "cg-test-key";
  rate.resetCgRateLimit(); clearCryptoCache(); clearPriceFeedCache(); markets.clearCryptoMarketsCache();
  let fetched = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { fetched++; return J(200, { bitcoin: { usd: 1 } }); };
  try {
    const now = Date.now();
    while (rate.cgTokenRefusal(now) !== "day") { /* spend the day */ }
    fetched = 0;
    const refused = [];
    for (const [fn, input] of [
      [CRYPTO_TOOLS.find((t) => t.slug === "crypto-price").handler, { coins: "BTC" }],
      [markets.CRYPTO_MARKETS_TOOLS.find((t) => t.slug === "coin-search").handler, { query: "btc" }],
      [PRICE_FEED_TOOLS.find((t) => t.slug === "price-coingecko").handler, { ids: ["bitcoin"] }],
    ]) { try { await fn(input); refused.push(null); } catch (e) { refused.push(e); } }
    ok(refused.every((e) => e?.statusCode === 503 && /temporarily unavailable/i.test(e.message)), "crypto-kit, crypto-markets-kit and price-feed-kit all refuse 503 once the day is spent");
    eq(fetched, 0, "and none of them reached the upstream");
  } finally { globalThis.fetch = orig; }
  delete process.env.COINGECKO_DAILY_MAX; delete process.env.COINGECKO_API_KEY;
  rate.resetCgRateLimit();
}

// ---- crypto-kit jsonGet: retry takes a token; key refusals are 503 ----------
{
  const price = CRYPTO_TOOLS.find((t) => t.slug === "crypto-price").handler;
  const orig = globalThis.fetch;
  let fetched = 0, reply = null;
  globalThis.fetch = async () => { fetched++; return reply(); };
  try {
    // One token left: the 429 is not retried.
    process.env.COINGECKO_MAX_PER_MIN = "1";
    rate.resetCgRateLimit(); clearCryptoCache();
    reply = () => J(429, { status: { error_code: 429 } });
    let err = null; try { await price({ coins: "BTC" }); } catch (e) { err = e; }
    eq(err?.statusCode, 503, "429 maps to 503");
    eq(fetched, 1, "the 429 retry takes a token: one token, one upstream request");
    delete process.env.COINGECKO_MAX_PER_MIN;

    // A key error is this server's configuration: 503, no upstream text.
    for (const [status, body] of [[401, { status: { error_code: 10002, error_message: "SECRET-UPSTREAM-TEXT" } }], [401, { status: { error_code: 10010, error_message: "SECRET-UPSTREAM-TEXT" } }], [403, "SECRET-UPSTREAM-TEXT"]]) {
      rate.resetCgRateLimit(); clearCryptoCache();
      reply = () => J(status, body);
      err = null; try { await price({ coins: "BTC" }); } catch (e) { err = e; }
      eq(err?.statusCode, 503, `${status} key refusal -> 503`);
      ok(/not configured/i.test(String(err?.message)) && !/SECRET/.test(String(err?.message)), `${status}: says not configured, relays no upstream text`);
    }
    // A plan/range code stays a 422 about the request.
    rate.resetCgRateLimit(); clearCryptoCache();
    reply = () => J(401, { error: { status: { error_code: 10012, error_message: "range" } } });
    err = null; try { await price({ coins: "BTC" }); } catch (e) { err = e; }
    eq(err?.statusCode, 422, "401 with a plan/range code stays 422");

    // Identical requests inside the cache window make one upstream request.
    rate.resetCgRateLimit(); clearCryptoCache(); fetched = 0;
    reply = () => J(200, { bitcoin: { usd: 1, usd_24h_change: 0, usd_24h_vol: 0, usd_market_cap: 0, last_updated_at: 0 } });
    const a = await price({ coins: "BTC" }); const b = await price({ coins: "BTC" });
    eq(fetched, 1, "crypto-kit: an identical request inside the window is served from the short cache");
    eq(JSON.stringify(a.prices ?? a), JSON.stringify(b.prices ?? b), "and gets the same answer");
    try { await price({ coins: "ETH" }); } catch { /* the stub has no ETH row */ }
    eq(fetched, 2, "a different request still goes upstream");

    clearPriceFeedCache(); fetched = 0;
    reply = () => J(200, { bitcoin: { usd: 1 } });
    const pf = PRICE_FEED_TOOLS.find((t) => t.slug === "price-coingecko").handler;
    await pf({ ids: ["bitcoin"] }); await pf({ ids: ["bitcoin"] });
    eq(fetched, 1, "price-feed-kit: an identical CoinGecko request inside the window is served from the short cache");

    // A body over 256 KB is served but not kept, in both caches.
    const pad = "x".repeat(300 * 1024);
    rate.resetCgRateLimit(); clearCryptoCache(); clearPriceFeedCache(); fetched = 0;
    reply = () => J(200, { bitcoin: { usd: 1, usd_24h_change: 0, usd_24h_vol: 0, usd_market_cap: 0, last_updated_at: 0 }, pad });
    await price({ coins: "BTC" }); await price({ coins: "BTC" });
    eq(fetched, 2, "crypto-kit: a body over 256 KB is not cached");
    fetched = 0;
    await pf({ ids: ["bitcoin"] }); await pf({ ids: ["bitcoin"] });
    eq(fetched, 2, "price-feed-kit: a body over 256 KB is not cached");
  } finally { globalThis.fetch = orig; delete process.env.COINGECKO_MAX_PER_MIN; rate.resetCgRateLimit(); clearCryptoCache(); clearPriceFeedCache(); }
}
console.log(`test-coingecko-rate: ${n} assertions ok`);
