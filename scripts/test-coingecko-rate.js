#!/usr/bin/env node
// One CoinGecko bucket for both kits. crypto-markets-kit had a private 25/min
// bucket and crypto-kit had none, so together they overran the one Demo key.
// Offline: fetch is stubbed; the bucket is exhausted by hand.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/guard-dns-offline.js"; // the guard's name lookups answer here, not from the machine's resolver (see the file)
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
// Without a shared store each process holds its RATE_LIMIT_REPLICAS share of the caps.
rate.resetCgRateLimit();
process.env.RATE_LIMIT_REPLICAS = "2"; process.env.COINGECKO_MAX_PER_MIN = "4";
ok((await rate.cgTake(t0)) === null && (await rate.cgTake(t0)) === null, "two replicas configured: this process takes its half of a cap of 4");
eq(await rate.cgTake(t0), "minute", "and the third is refused");
ok(rate.cgTakeCounts().local === 3 && rate.cgTakeCounts().shared === 0, "decided on this process's bucket (no shared store configured)");
process.env.COINGECKO_API_KEY = "cg-test-key"; process.env.COINGECKO_DAILY_MAX = "4"; process.env.COINGECKO_MAX_PER_MIN = "100";
rate.resetCgRateLimit();
ok((await rate.cgTake(t0)) === null && (await rate.cgTake(t0)) === null, "the daily ceiling is shared out the same way");
eq(await rate.cgTake(t0), "day", "half of a daily ceiling of 4");
eq(rate.cgLocalShare(1), 1, "a share never falls below one");
delete process.env.RATE_LIMIT_REPLICAS; delete process.env.COINGECKO_API_KEY; delete process.env.COINGECKO_DAILY_MAX; process.env.COINGECKO_MAX_PER_MIN = "3";
rate.resetCgRateLimit();
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
  {
    // Both refusals are this server's own: its daily allowance and its own
    // pacing. Neither may say CoinGecko is unavailable or rate limited.
    const dayMsg = rate.cgRefusalMessage("day", "CoinGecko", day + 60_000);
    ok(/This server's daily CoinGecko allowance is used up; it renews at 00:00 UTC/.test(dayMsg) && !/\d/.test(dayMsg.replace("00:00 UTC", "")) && !/temporarily unavailable|rate limited/i.test(dayMsg),
      `daily refusal names OUR allowance and its renewal, carries no count, and names no upstream outage (${dayMsg})`);
    const minMsg = rate.cgRefusalMessage("minute", "Market data", day);
    ok(/^This server paces its Market data requests and has no room this moment; retry in \d+ s\./.test(minMsg) && !/rate limited|temporarily unavailable/i.test(minMsg),
      `pacing refusal names OUR pacing and a retry time, not the upstream (${minMsg})`);
    const de = rate.cgRefusal("day", "CoinGecko", Date.UTC(2030, 0, 1, 23, 0, 0));
    const me = rate.cgRefusal("minute");
    ok(de.statusCode === 503 && de.attribution === "ours" && de.hint === "our-allowance" && de.retryAfter === 3600
      && me.statusCode === 503 && me.attribution === "ours" && me.hint === "our-pacing" && Number.isInteger(me.retryAfter) && me.retryAfter >= 1,
      `the refusals are 503s attributed to our side, kinds our-allowance (Retry-After to 00:00 UTC: ${de.retryAfter} s) and our-pacing (${me.retryAfter} s)`);
  }
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
    ok(refused.every((e) => e?.statusCode === 503 && /daily .* allowance is used up/.test(e.message) && e.attribution === "ours" && e.hint === "our-allowance" && e.retryAfter > 0), "crypto-kit, crypto-markets-kit and price-feed-kit all refuse 503 once the day is spent, naming our own allowance with Retry-After");
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
    clearCryptoCache(); fetched = 0;
    const quick = reply;
    reply = () => new Promise((r) => setTimeout(() => r(quick()), 100)); // still in flight when the second arrives
    const [c1, c2] = await Promise.all([price({ coins: "BTC" }), price({ coins: "BTC" })]);
    reply = quick;
    eq(fetched, 1, "two identical requests in flight together share one upstream request");
    eq(JSON.stringify(c1.prices ?? c1), JSON.stringify(c2.prices ?? c2), "and both get the answer");

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
// ---- reads of calls that end unsettled hold a share of the day; paid calls the whole day --
// Every read counts on the day, and a read is refused only at the whole
// ceiling. A call that ends in an error is never settled; its reads also count
// on the unsettled share (10%), and a call whose ids no list has confirmed
// takes a place there before it reads. Once the share is full, ids and
// currencies are checked against their lists first, so made-up inputs are
// answered with no read and paid calls keep the rest of the day.
{
  const { CRYPTO_MARKETS_TOOLS, clearCryptoMarketsCache } = markets;
  const { CRYPTO_SCREENS_TOOLS } = await import("../src/tools/crypto-screens-kit.js");
  const H = (tools, slug) => tools.find((t) => t.slug === slug).handler;
  const profile = H(CRYPTO_MARKETS_TOOLS, "coin-profile");
  const coinHistory = H(CRYPTO_MARKETS_TOOLS, "coin-history");
  const exTickers = H(CRYPTO_MARKETS_TOOLS, "exchange-tickers");
  const ohlc = H(CRYPTO_MARKETS_TOOLS, "coin-ohlc");
  const spread = H(CRYPTO_SCREENS_TOOLS, "exchange-spread");
  const board = H(CRYPTO_SCREENS_TOOLS, "dex-volume-board");
  const ckPrice = H(CRYPTO_TOOLS, "crypto-price");
  const ckHistory = H(CRYPTO_TOOLS, "crypto-history");
  const ckPeg = H(CRYPTO_TOOLS, "stablecoin-peg");
  const pfPrice = H(PRICE_FEED_TOOLS, "price-coingecko");
  const orig = globalThis.fetch;
  const paths = [];
  const listed = new Set(); // coins the list names later in the day (section 9)
  let slow = 0;
  globalThis.fetch = async (input) => {
    const u = new URL(typeof input === "string" ? input : input.url ?? String(input));
    const p = u.pathname.replace(/^\/api\/v3/, "");
    paths.push(p + u.search);
    if (slow) await new Promise((r) => setTimeout(r, slow));
    if (p === "/coins/list") return J(200, [{ id: "bitcoin", symbol: "btc", name: "Bitcoin" }, { id: "ethereum", symbol: "eth", name: "Ethereum" }, { id: "tether", symbol: "usdt", name: "Tether" }, ...[...listed].map((id) => ({ id, symbol: "x", name: id }))]);
    if (listed.has(p.slice("/coins/".length))) return J(200, { id: p.slice("/coins/".length), symbol: "x", name: "x", market_data: {} });
    if (p === "/exchanges/list") return J(200, [{ id: "gdax", name: "Coinbase Exchange" }]);
    if (p === "/simple/supported_vs_currencies") return J(200, ["usd", "eur", "btc"]);
    if (p === "/simple/price") {
      const vs = u.searchParams.get("vs_currencies");
      const body = {};
      for (const id of String(u.searchParams.get("ids") || "").split(",")) if (id === "bitcoin" || id === "ethereum") body[id] = { [vs]: 1, last_updated_at: 1_700_000_000 };
      return J(200, body);
    }
    if (p === "/coins/bitcoin") return J(200, { id: "bitcoin", symbol: "btc", name: "Bitcoin", market_data: {} });
    if (p === "/coins/ethereum") return J(500, { error: "upstream failure" });
    if (p === "/coins/bitcoin/history") return J(200, { id: "bitcoin", symbol: "btc", name: "Bitcoin" }); // a date with no market data
    if (p === "/coins/bitcoin/market_chart" || p === "/coins/bitcoin/ohlc") return J(200, p.endsWith("ohlc") ? [[1_700_000_000_000, 1, 1, 1, 1]] : { prices: [[1_700_000_000_000, 1]], market_caps: [], total_volumes: [] });
    if (p === "/coins/markets") return J(200, [{ id: "tether", symbol: "usdt", name: "Tether", current_price: 1 }]);
    if (p === "/exchanges/gdax/tickers") return J(200, { name: "Coinbase Exchange", tickers: [] });
    if (/^\/onchain\/networks\/[a-z0-9]+\/pools$/.test(p)) return J(200, { data: [{ id: "x", attributes: { address: `0x${u.searchParams.get("page")}`, name: "A / B", volume_usd: { h24: "1" }, reserve_in_usd: "1", transactions: { h24: { buys: 1, sells: 1 } } }, relationships: { dex: { data: { id: "d" } } } }], included: [] });
    return J(404, { error: "coin not found" });
  };
  const call = async (fn, input) => { try { await fn(input); return 200; } catch (e) { return e?.statusCode ?? 500; } };
  const count = (re) => paths.filter((p) => re.test(p)).length;
  const fresh = () => { rate.resetCgRateLimit(); clearCryptoMarketsCache(); clearCryptoCache(); clearPriceFeedCache(); paths.length = 0; };
  try {
    process.env.COINGECKO_API_KEY = "cg-test-key"; process.env.COINGECKO_DAILY_MAX = "40"; process.env.COINGECKO_MAX_PER_MIN = "100000";
    const caps = rate.cgDayCaps();
    ok(caps.day === 40 && caps.unsettled === 4 && caps.reserve === 8 && caps.screens === 32, `a day of 40 reads: 4 for unsettled calls, 8 kept from the screens (${JSON.stringify(caps)})`);
    eq(rate.cgCeiling(), 40, "every tool but the screens is held to the whole day");

    // 1. With no unpaid use, paid calls use the whole day, not the day less the unsettled share.
    fresh();
    const paid = [];
    for (let k = 0; k < 45; k++) { clearCryptoMarketsCache(); paid.push(await call(profile, { coin: "bitcoin" })); }
    eq(paid.filter((s) => s === 200).length, 40, `paid calls answer until the whole day is spent (${paid.filter((s) => s === 200).length} of 45)`);
    ok(paid.slice(40).every((s) => s === 503), "and only then refuse 503, uncharged");
    ok(!(await rate.cgUnsettledSpent()), "a settled call gives back the place it reserved: the unsettled share is still empty");

    // 2. Made-up coin ids: only the share's reads reach the upstream, then the list answers.
    fresh();
    ok(!(await rate.cgUnsettledSpent()), "control: the unsettled share starts empty");
    const flood = [];
    for (let k = 0; k < 100; k++) flood.push(await call(profile, { coin: `made-up-coin-${k}` }));
    ok(flood.every((s) => s === 422), `100 made-up coin ids are each a 422 (${[...new Set(flood)].join(",")})`);
    eq(count(/^\/coins\/made-up/), caps.unsettled, "only the unsettled share's reads reached the upstream for made-up ids");
    eq(count(/^\/coins\/list/), 1, "the coin list was read once, and only after the share was full");
    ok(await rate.cgUnsettledSpent(), "and the share is full");

    // 3. The same for every CoinGecko path that reads a caller's id or currency.
    const before = paths.length;
    const cases = [
      ["crypto-price", ckPrice, (k) => ({ coins: `madeprice${k}` }), 404],
      ["crypto-price currency", ckPrice, (k) => ({ coins: "BTC", currency: `zz${k}` }), 400],
      ["crypto-history", ckHistory, (k) => ({ coin: `madehist${k}` }), 422],
      ["stablecoin-peg", ckPeg, (k) => ({ coins: `madepeg${k}` }), 422],
      ["price-coingecko", pfPrice, (k) => ({ ids: [`madepf${k}`] }), 404],
      ["price-coingecko vsCurrency", pfPrice, (k) => ({ ids: ["bitcoin"], vsCurrency: `qq${"abcdefghijklmnopqrst"[k]}` }), 400],
      ["coin-ohlc currency", ohlc, (k) => ({ coin: "bitcoin", currency: `zz${k}` }), 422],
      ["exchange-tickers", exTickers, (k) => ({ exchange: `made-up-ex-${k}` }), 422],
      ["exchange-spread", spread, (k) => ({ coin: `made-up-spread-${k}` }), 422],
    ];
    for (const [label, fn, input, want] of cases) {
      const st = [];
      for (let k = 0; k < 20; k++) st.push(await call(fn, input(k)));
      ok(st.every((s) => s === want), `${label}: unknown inputs answer ${want} once the share is full (${[...new Set(st)].join(",")})`);
    }
    const reads = paths.slice(before).filter((p) => !/^\/(coins\/list|simple\/supported_vs_currencies|exchanges\/list)\b/.test(p));
    eq(reads.length, 0, `none of those ${cases.length * 20} calls read anything but a list (${reads.slice(0, 3).join(" ")})`);
    // A batch with one real coin reads only the real one and lists the rest.
    clearCryptoCache(); clearPriceFeedCache();
    const mixed = await ckPrice({ coins: "BTC,madeprice-mixed" });
    ok(mixed.count === 1 && mixed.unknown?.[0] === "madeprice-mixed" && paths.at(-1).includes("ids=bitcoin&"), "crypto-price: a partial miss still answers, and the made-up id is not sent upstream");
    const mixedPf = await pfPrice({ ids: ["bitcoin", "madepf-mixed"] });
    ok(mixedPf.count === 2 && mixedPf.unknown?.[0] === "madepf-mixed" && mixedPf.prices[1].price === null, "price-coingecko: a partial miss keeps its null row and lists the id");

    // 4. A listed coin with no market data that day is a free 422, never a
    // charged empty answer; the miss is kept, so a repeat reads nothing.
    const histReads = () => count(/^\/coins\/bitcoin\/history/);
    eq(await call(coinHistory, { coin: "bitcoin", daysAgo: 3 }), 422, "coin-history: a date with no market data answers 422");
    const firstReads = histReads();
    ok(firstReads >= 1, `control: the first miss read the date upstream (${firstReads})`);
    eq(await call(coinHistory, { coin: "bitcoin", daysAgo: 3 }), 422, "coin-history: the same coin and date again is 422");
    eq(histReads(), firstReads, "and reads nothing upstream");

    // 5. Paid calls for real ids after the flood still answer, and use the rest of the day.
    const after = [];
    for (let k = 0; k < 10; k++) { clearCryptoMarketsCache(); after.push(await call(profile, { coin: "bitcoin" })); }
    ok(after.every((s) => s === 200), `paid calls for a real coin after the flood answer 200 (${[...new Set(after)].join(",")})`);

    // 6. A parallel burst cannot pass the share before any of its calls ends.
    fresh(); slow = 20;
    const burst = await Promise.all(Array.from({ length: 60 }, (_, k) => call(profile, { coin: `burst-${k}` })));
    slow = 0;
    ok(burst.every((s) => s === 422), `60 made-up ids sent together are each a 422 (${[...new Set(burst)].join(",")})`);
    eq(count(/^\/coins\/burst-/), caps.unsettled, "and no more of them read than the share holds: the place is reserved before the read");

    // 6b. A listed id whose read fails upstream (5xx, never settled) counts its
    // reads on the share too: two calls of two reads each (the read and its
    // retry) fill a share of four.
    fresh();
    const failing = [await call(profile, { coin: "ethereum" }), await call(profile, { coin: "ethereum" })];
    ok(failing.every((s) => s === 502) && count(/^\/coins\/ethereum/) === 4, `two upstream failures read twice each (${failing.join(",")}, ${count(/^\/coins\/ethereum/)} reads)`);
    ok(await rate.cgUnsettledSpent(), "and those unsettled reads filled the share");

    // 7. The screens stop at the day less the reserve; the other tools keep the reserve.
    fresh();
    const boards = [];
    for (let k = 0; k < 40; k++) boards.push(await call(board, { network: `net${k}`, pools: 20 }));
    eq(boards.filter((s) => s === 200).length, caps.screens, `dex-volume-board on ${boards.length} networks answers until the day less the reserve is used (${caps.screens})`);
    ok(boards.filter((s) => s !== 200).every((s) => s === 503), "and then refuses 503, uncharged");
    const kept = [];
    for (let k = 0; k < caps.reserve + 2; k++) { clearCryptoMarketsCache(); kept.push(await call(profile, { coin: "bitcoin" })); }
    eq(kept.filter((s) => s === 200).length, caps.reserve, `the other tools keep the reserve (${kept.filter((s) => s === 200).length} of ${caps.reserve})`);
    // When the other tools have used part of the day, the screens stop at the same total.
    fresh();
    for (let k = 0; k < 10; k++) { clearCryptoMarketsCache(); await call(profile, { coin: "bitcoin" }); }
    const boards2 = [];
    for (let k = 0; k < 40; k++) boards2.push(await call(board, { network: `nb${k}`, pools: 20 }));
    eq(boards2.filter((s) => s === 200).length, caps.screens - 10, `after 10 other reads the screens answer ${caps.screens - 10} more: the ceiling is total reads, not a share of their own`);

    // 9. Per caller and per id, with the share NOT full (a day of 400: a share
    //    of 40). Each caller (its address, the request's caller key) holds at
    //    most COINGECKO_UNSETTLED_PER_CALLER_HOUR (default 8) places an hour;
    //    past them its unconfirmed ids go to the list first (a real id is
    //    still read and served: no paid call is refused). An id the upstream
    //    or a list called unknown is remembered for the UTC day: asked again,
    //    it is answered with no read of its own, until its list names it.
    process.env.COINGECKO_DAILY_MAX = "400";
    fresh();
    const { requestTimingMiddleware } = await import("../src/request-timing.js");
    const asCaller = (ip, fn, input) => new Promise((resolve) => {
      requestTimingMiddleware(() => "t")({ ip, socket: {}, headers: {} }, { on() {}, locals: {} }, () => { call(fn, input).then(resolve); });
    });
    const fromA = [];
    for (let k = 0; k < 20; k++) fromA.push(await asCaller("198.51.100.7", profile, { coin: `made-up-a-${k}` }));
    ok(fromA.every((s) => s === 422), `one address's 20 made-up ids are each a 422 (${[...new Set(fromA)].join(",")})`);
    eq(count(/^\/coins\/made-up-a-/), rate.CG_UNSETTLED_PER_CALLER_HOUR_DEFAULT, "only that address's hourly places read upstream; the rest were checked against the list");
    ok(!(await rate.cgUnsettledSpent()), "and the day's share is not full: other callers keep it");
    const fromB = [];
    for (let k = 0; k < 5; k++) fromB.push(await asCaller("203.0.113.20", profile, { coin: `made-up-b-${k}` }));
    ok(fromB.every((s) => s === 422) && count(/^\/coins\/made-up-b-/) === 5, `another address reads its own ids as asked (${count(/^\/coins\/made-up-b-/)} reads)`);
    clearCryptoMarketsCache();
    eq(await asCaller("198.51.100.7", profile, { coin: "bitcoin" }), 200, "the first address's call for a real coin is read and served: never refused");
    // The day's memory of unknown ids.
    let r0 = count(/^\/coins\/made-up-b-0(\?|$)/);
    ok(r0 === 1, `control: that id was read once, when first asked (${r0})`);
    const again = [];
    for (let k = 0; k < 5; k++) again.push(await asCaller("192.0.2.55", profile, { coin: "made-up-b-0" }));
    ok(again.every((s) => s === 422) && count(/^\/coins\/made-up-b-0(\?|$)/) === r0, `an id the upstream called unknown today is answered again with no read of its own (${count(/^\/coins\/made-up-b-0(\?|$)/) - r0} reads in 5 calls)`);
    // A coin listed later the same day: its list names it (the list's cache ended), and it is read again.
    listed.add("made-up-b-1"); clearCryptoMarketsCache();
    r0 = count(/^\/coins\/made-up-b-1(\?|$)/);
    eq(await asCaller("192.0.2.56", profile, { coin: "made-up-b-1" }), 200, "a remembered id that its list now names is read and served");
    ok(count(/^\/coins\/made-up-b-1(\?|$)/) === r0 + 1, "with one read");
    process.env.COINGECKO_DAILY_MAX = "40";

    // 8. The board is sold at its listed price for every pool count (no per-input quote).
    const def = CRYPTO_SCREENS_TOOLS.find((t) => t.slug === "dex-volume-board");
    ok(def.price === "$0.005" && def.quote === undefined && def.quoteMaxUsd === undefined, "dex-volume-board has one listed price for every pool count");
  } finally {
    globalThis.fetch = orig;
    delete process.env.COINGECKO_API_KEY; delete process.env.COINGECKO_DAILY_MAX; delete process.env.COINGECKO_MAX_PER_MIN;
    rate.resetCgRateLimit(); markets.clearCryptoMarketsCache(); clearCryptoCache(); clearPriceFeedCache();
  }
}
console.log(`test-coingecko-rate: ${n} assertions ok`);
