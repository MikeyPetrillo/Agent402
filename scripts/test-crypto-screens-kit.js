import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
// scripts/test-crypto-screens-kit.js
// Offline tests for src/tools/crypto-screens-kit.js. No network and no key:
// globalThis.fetch is a stub that answers each upstream path from a small
// fixture, so every number asserted here is one the handler computed. Covers
//   - the catalog envelope (7 tools, prices, GET routes, the source credit in
//     the description, the published example and every answer),
//   - each tool's computed values on its fixture (weights, medians, shares,
//     deviations, concentration, flags and the thresholds that set them),
//   - the cache: a repeat call inside the window makes no second upstream
//     read, and a large document is kept as its reduced form,
//   - the shared budget: an uncached read with the minute spent is a 503
//     before any upstream call, and a cached answer still serves,
//   - a deployment without a key: the pool endpoints' 401 is a 503, never a
//     relayed body; and the two pool tools sit in METERED_SLUGS,
//   - input validation (400) before any egress, and the 422s,
//   - wording: no advice, rating or trade-direction words in any description,
//     flag or published example.

import { CRYPTO_SCREENS_TOOLS, KEY_ONLY_SCREEN_SLUGS, SCREENS_MAX_TTL_MS, UNKNOWN_NETWORK_MAX, resetUnknownNetworks, __test } from "../src/tools/crypto-screens-kit.js";
import { clearCryptoMarketsCache, resetCgRateLimit, TTL } from "../src/tools/crypto-markets-kit.js";
import { COINGECKO_CREDIT, COINGECKO_API_URL, attributionTailOf } from "../src/data-attribution.js";
import { METERED_SLUGS } from "../src/metered-slugs.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
const near = (a, b, eps = 1e-6) => typeof a === "number" && Math.abs(a - b) <= eps;
const answered = new Set(), uncredited = [];
const h = (slug) => {
  const fn = CRYPTO_SCREENS_TOOLS.find((t) => t.slug === slug).handler;
  return (...args) => { resetCgRateLimit(); return fn(...args).then((r) => { answered.add(slug); if (r?.credit !== COINGECKO_CREDIT) uncredited.push(slug); return r; }); };
};
const raw = (slug) => CRYPTO_SCREENS_TOOLS.find((t) => t.slug === slug).handler;
async function throws(promise, status, label, re) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status && (!re || re.test(e.message))) { pass++; console.log(`ok - ${label} -> ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}${re ? ` /${re.source}/` : ""}, got ${e.statusCode} (${e.message})`); }
  }
}

// ----------------------------------------------------------------------------
// fetch stub: first matching [test, responder] wins; every call is recorded
// ----------------------------------------------------------------------------
const calls = [];
let routes = [];
const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => null },
  json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  calls.push({ url: u, headers: init?.headers || {} });
  for (const [test, responder] of routes) if (test(u)) return typeof responder === "function" ? responder(u) : responder;
  return jsonRes(404, { error: "not found" });
};
const path = (p) => (u) => u.pathname === `/api/v3${p}`;
const reset = () => { calls.length = 0; clearCryptoMarketsCache(); resetCgRateLimit(); resetUnknownNetworks(); };
for (const k of ["COINGECKO_API_KEY", "COINGECKO_API_TIER", "COINGECKO_MAX_PER_MIN", "COINGECKO_DAILY_MAX"]) delete process.env[k];

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
const SLUGS = ["funding-screener", "stablecoin-depeg-watch", "exchange-spread", "defi-screener", "chain-board", "dex-volume-board", "dex-pool-health"];
ok(CRYPTO_SCREENS_TOOLS.length === SLUGS.length && SLUGS.every((s) => CRYPTO_SCREENS_TOOLS.some((t) => t.slug === s)), `the kit exports the ${SLUGS.length} tools`);
// Words that would turn a measurement into advice, a rating or a trade call.
const ADVICE = /\b(buy now|sell now|should (buy|sell)|strong (buy|sell)|recommend\w*|opportunit\w+|rating|rated|safe to|guarantee\w*|profit\w*|undervalued|overvalued|bullish|bearish)\b/i;
for (const t of CRYPTO_SCREENS_TOOLS) {
  ok(t.price === "$0.005", `${t.slug}: priced $0.005`);
  ok(/^GET \/api\/[a-z0-9-]+$/.test(t.route) && t.route === `GET /api/${t.slug}`, `${t.slug}: GET route named after the slug`);
  ok(t.category === "crypto" && Array.isArray(t.tags) && t.tags.length >= 5, `${t.slug}: category and tags`);
  ok(!/\u2014/.test(t.description) && !/\u2014/.test(JSON.stringify(t.discovery)), `${t.slug}: no em dash`);
  ok(t.attribution === "coingecko" && attributionTailOf(t.description) === COINGECKO_CREDIT && t.description.includes(COINGECKO_API_URL), `${t.slug}: description ends with the linked credit`);
  ok(t.credit === COINGECKO_CREDIT && t.discovery.output.example.credit === COINGECKO_CREDIT, `${t.slug}: published example carries the credit`);
  ok(/Deterministic code over market data/.test(t.description) && t.modelBacked !== true, `${t.slug}: says it is deterministic code, and is not marked model-backed`);
  ok(!ADVICE.test(t.description) && !ADVICE.test(JSON.stringify(t.discovery.output.example)) && !ADVICE.test(t.name), `${t.slug}: no advice, rating or trade-direction wording`);
  ok(t.discovery.output.example.source === "coingecko" && typeof t.discovery.output.example.fetchedAt === "string", `${t.slug}: example carries source and fetchedAt`);
  ok(typeof t.handler === "function" && t.handler.__budgetMs > 0, `${t.slug}: handler runs under a budget`);
  ok(t.endsAtCeiling !== true, `${t.slug}: not declared as ending at a run's ceiling (the shared budget read and the retry wait do not)`);
}
ok(ADVICE.test("a strong buy") && ADVICE.test("an arbitrage opportunity") && !ADVICE.test("buy share of trades"), "control: the wording check catches advice and passes a measured buy share");
ok(KEY_ONLY_SCREEN_SLUGS.length === 2 && KEY_ONLY_SCREEN_SLUGS.every((s) => METERED_SLUGS.has(s)), "the two key-only pool tools are in METERED_SLUGS (CI holds no key)");
ok(SLUGS.filter((s) => !KEY_ONLY_SCREEN_SLUGS.includes(s)).every((s) => !METERED_SLUGS.has(s)), "the keyless tools are not in METERED_SLUGS");
ok(SCREENS_MAX_TTL_MS === Math.max(TTL.price, TTL.list, TTL.coinList), "the longest cache window the kit reports is the longest it uses");

// pure helpers
ok(__test.median([3, 1, 2]) === 2 && __test.median([4, 1, 3, 2]) === 2.5 && __test.median([]) === null, "median: odd, even, empty");
ok(near(__test.quantile([0, 10, 20, 30, 40], 0.25), 10) && near(__test.quantile([0, 10], 0.9), 9), "quantile interpolates");
ok(near(__test.hhi([50, 50]), 5000) && near(__test.hhi([100]), 10000) && __test.hhi([0, 0]) === null, "hhi on the 0-10000 scale");
ok(near(__test.weightedMean([{ v: 1, w: 1 }, { v: 3, w: 3 }], (r) => r.v, (r) => r.w), 2.5), "weighted mean");

// ----------------------------------------------------------------------------
// funding-screener
// ----------------------------------------------------------------------------
const perp = (market, symbol, index_id, funding_rate, open_interest, basis = 0.05, extra = {}) =>
  ({ market, symbol, index_id, funding_rate, open_interest, basis, volume_24h: 1_000_000, contract_type: "perpetual", expired_at: null, price: "100", ...extra });
const DERIVATIVES = [
  perp("Alpha Futures", "ETHUSDT", "ETH", 0.01, 6_000_000, 0.04),
  perp("Beta Futures", "ETH-PERP", "ETH", -0.02, 2_000_000, 0.06),
  perp("Gamma Futures", "ETH_USDT", "ETH", 0.05, 2_000_000, 0.1),
  perp("Delta Futures", "ETHUSD", "eth", 0.0, 1_500_000, null),
  perp("Tiny Futures", "ETHUSDT", "ETH", 0.9, 500_000),                                   // under the default floor, above the reduce floor
  perp("Dust Futures", "ETHUSDT", "ETH", 5, 50_000),                                      // under the reduce floor: never kept
  perp("Old Futures", "ETHUSDT", "ETH", 3, 9_000_000, 0.05, { expired_at: 1700000000 }),    // expired
  perp("Dated Futures", "ETH-DEC", "ETH", 3, 9_000_000, 0.05, { contract_type: "futures" }), // not a perpetual
  perp("No Funding", "ETHUSDT", "ETH", null, 9_000_000),                                  // no funding rate
  perp("Alpha Futures", "BTCUSDT", "BTC", 0.01, 10_000_000),
  perp("Beta Futures", "BTC-PERP", "BTC", 0.012, 5_000_000),
  perp("Gamma Futures", "BTC_USDT", "BTC", 0.011, 5_000_000),
  perp("Alpha Futures", "SOLUSDT", "SOL", 0.03, 3_000_000),
  perp("Beta Futures", "SOL-PERP", "SOL", -0.03, 3_000_000), // two venues only: off the board
];
routes = [[path("/derivatives"), () => jsonRes(200, DERIVATIVES)]];
reset();
{
  const kept = __test.reducePerps.fn(DERIVATIVES);
  ok(kept.length === 10 && kept.every((r) => r.length === 7), `the derivatives document is reduced to live perpetuals with funding above the floor (${kept.length} of ${DERIVATIVES.length} rows, 7 fields each)`);
  const out = await h("funding-screener")({ coin: "eth" });
  ok(out.mode === "coin" && out.coin === "ETH" && out.venues === 4 && out.minOpenInterestUsd === 1_000_000, "coin mode: the four venues above the default floor, ticker case-folded");
  // weights 6, 2, 2, 1.5 (millions): (0.01*6 - 0.02*2 + 0.05*2 + 0) / 11.5
  ok(near(out.funding.oiWeightedPct, +(0.12 / 11.5).toFixed(6)), `open-interest-weighted funding (${out.funding.oiWeightedPct})`);
  ok(near(out.funding.medianPct, 0.005) && out.funding.minPct === -0.02 && out.funding.maxPct === 0.05 && near(out.funding.dispersionPct, 0.07), "median, min, max and dispersion");
  ok(near(out.funding.annualizedOiWeightedPct, +((0.12 / 11.5) * 1095).toFixed(4), 1e-3) && /8-hour/.test(out.funding.annualizationAssumes), "annualized at three intervals a day, with the assumption stated");
  ok(out.funding.positiveVenueSharePct === 50, "half the venues pay positive funding");
  ok(out.openInterest.totalUsd === 11_500_000 && near(out.openInterest.topVenueSharePct, 52.17) && out.openInterest.hhi === Math.round(__test.hhi([6, 2, 2, 1.5])), "open interest total, top share and concentration index");
  ok(near(out.basis.oiWeightedPct, +((0.04 * 6 + 0.06 * 2 + 0.1 * 2) / 10).toFixed(4)) && out.basis.minPct === 0.04 && out.basis.maxPct === 0.1, "basis is weighted over the venues that report one");
  ok(out.highest[0].venue === "Gamma Futures" && out.highest[0].rank === 1 && near(out.highest[0].annualizedPct, 54.75) && near(out.highest[0].vsMedianPct, 0.045), "highest venue ranked first, against the median");
  ok(out.lowest[0].venue === "Beta Futures" && near(out.lowest[0].openInterestSharePct, 17.39), "lowest venue first on the other side");
  ok(out.flags.join() === "wide-dispersion,funding-sign-split,concentrated-open-interest", `flags name the measured conditions (${out.flags.join()})`);
  ok(!("price" in out.highest[0]) && !JSON.stringify(out).includes("volume_24h"), "no upstream row is passed through");

  const low = await h("funding-screener")({ coin: "ETH", minOpenInterestUsd: 100000, limit: 1 });
  ok(low.venues === 5 && low.highest.length === 1 && low.highest[0].venue === "Tiny Futures", "a lower floor admits the smaller venue; limit caps each side");
  ok(calls.length === 1, `one upstream read served both calls (${calls.length})`);

  const board = await h("funding-screener")({});
  ok(board.mode === "board" && board.coins.map((c) => c.coin).join() === "BTC,ETH" && board.coins[0].rank === 1, "board mode: coins with three venues or more, by open interest");
  ok(board.matched === 2 && board.returned === 2 && board.complete === true && board.venuesScreened === 9, "board says how many coins matched and how many it returned");
  ok(near(board.coins[0].dispersionPct, 0.002) && near(board.coins[0].openInterestSharePct, +(20 / 37.5 * 100).toFixed(2)), "board rows carry dispersion and the share of screened open interest");
  const byDisp = await h("funding-screener")({ sort: "dispersion", limit: 1 });
  ok(byDisp.coins.length === 1 && byDisp.coins[0].coin === "ETH" && byDisp.truncated === true, "board sorts by dispersion and marks a capped list");
  ok(calls.length === 1, "still one upstream read");

  await throws(h("funding-screener")({ coin: "DOGE" }), 422, "a ticker no venue lists", /DOGE/);
  await throws(h("funding-screener")({ coin: "E T H" }), 400, "a malformed ticker");
  await throws(h("funding-screener")({ coin: "ETH", minOpenInterestUsd: 10 }), 400, "a floor under the minimum");
  await throws(h("funding-screener")({ sort: "best" }), 400, "an unknown sort");
  await throws(h("funding-screener")({ coin: "ETH", limit: 26 }), 400, "limit above 25 in coin mode");
}

// ----------------------------------------------------------------------------
// stablecoin-depeg-watch
// ----------------------------------------------------------------------------
const flat = (p, n = 168) => Array.from({ length: n }, () => p);
const coin = (id, symbol, price, cap, hi, lo, series) => ({ id, symbol, name: symbol.toUpperCase(), current_price: price, market_cap: cap, high_24h: hi, low_24h: lo, sparkline_in_7d: { price: series } });
const STABLES = [
  coin("tether", "usdt", 0.9995, 150e9, 1.0002, 0.9991, flat(1.0)),
  coin("example-usd", "xusd", 0.99, 2e9, 0.999, 0.985, [...flat(1.0, 160), ...flat(0.98, 8)]), // off peg now, 24h and 7d
  coin("wobble-usd", "wusd", 1.0001, 1e9, 1.001, 0.9999, [...flat(1.0, 100), 0.97, ...flat(1.0, 67)]), // on peg now, off in the week
  coin("broken-usd", "busd2", 0.7, 5e8, 0.72, 0.69, [...flat(1.0, 120), ...flat(0.75, 48)]),   // median still $1: assessed, depegged
  coin("euro-coin", "xeur", 1.09, 4e8, 1.1, 1.08, flat(1.09)),                                  // another currency: not assessed
  coin("no-series", "nusd", 1.001, 3e8, 1.002, 1.0, []),                                        // no 7-day series: judged on the price
  coin("small-usd", "susd", 0.95, 5e7, 0.96, 0.94, flat(1.0)),                                  // under the default floor
  coin("spike-usd", "kusd", 1.0, 6e8, 1.004925, 0.9999, [...flat(1.0, 100), 0.996136, ...flat(1.0, 67)]), // a 24h wick the hourly 7-day series missed
  coin("now-usd", "qusd", 0.99, 7e8, 0.9995, 0.9992, flat(0.9993)),                             // a price now outside both ranges
];
routes = [[(u) => u.pathname === "/api/v3/coins/markets" && u.searchParams.get("category") === "stablecoins", () => jsonRes(200, STABLES)]];
reset();
{
  const out = await h("stablecoin-depeg-watch")({});
  ok(calls.length === 1 && calls[0].url.searchParams.get("sparkline") === "true" && calls[0].url.searchParams.get("per_page") === "250", "one read of the stablecoin page with its 7-day series");
  ok(out.minMarketCapUsd === 100_000_000 && out.thresholdBps === 50 && out.screened === 8 && out.assessed === 7, "the floor leaves eight, seven of them USD-pegged");
  ok(out.notAssessed.count === 1 && out.notAssessed.coins[0].symbol === "XEUR" && near(out.notAssessed.coins[0].distanceFromUsdPct, 9) && /2% from \$1/.test(out.notAssessed.reason), "the non-USD coin is listed apart, with its distance and the rule");
  const by = Object.fromEntries(out.coins.map((c) => [c.symbol, c]));
  ok(near(by.XUSD.deviationBps, -100) && near(by.XUSD.maxDeviation24hBps, 150) && near(by.XUSD.maxDeviation7dBps, 200) && by.XUSD.status === "stressed" && by.XUSD.flags.length === 3, "deviation now, over 24 hours and over 7 days, with all three flags");
  ok(near(by.WUSD.deviationBps, 1) && near(by.WUSD.maxDeviation7dBps, 300) && by.WUSD.flags.join() === "off-peg-7d" && by.WUSD.status === "on-peg", "a coin on peg now carries only the 7-day flag");
  ok(near(by.BUSD2.deviationBps, -3000) && by.BUSD2.status === "depegged", "a coin that lost its peg inside the week is assessed, not dropped");
  ok(by.NUSD.maxDeviation7dBps === null && by.NUSD.flags.length === 0, "no 7-day series reads null, never a perfect peg");
  // The 7 days include the last 24 hours, and the 24 hours include now: a wider window never reads a smaller worst deviation.
  ok(near(by.KUSD.maxDeviation24hBps, 49.25) && near(by.KUSD.maxDeviation7dBps, 49.25), `a 24h wick wider than the 7-day series is the 7-day worst too (24h ${by.KUSD.maxDeviation24hBps}, 7d ${by.KUSD.maxDeviation7dBps})`);
  ok(near(by.QUSD.deviationBps, -100) && near(by.QUSD.maxDeviation24hBps, 100) && near(by.QUSD.maxDeviation7dBps, 100) && by.QUSD.flags.length === 3, `a price now outside both ranges is the worst of each (24h ${by.QUSD.maxDeviation24hBps}, 7d ${by.QUSD.maxDeviation7dBps})`);
  ok(out.coins.every((c) => c.maxDeviation24hBps === null || (c.maxDeviation24hBps >= Math.abs(c.deviationBps) - 1e-9 && (c.maxDeviation7dBps === null || c.maxDeviation7dBps >= c.maxDeviation24hBps))), "for every coin: now <= worst over 24 hours <= worst over 7 days");
  ok(out.coins[0].symbol === "BUSD2" && out.coins[1].symbol === "XUSD" && out.coins[0].rank === 1 && out.coins.at(-1).flags.length === 0, "flagged coins first, widest deviation first");
  ok(out.flaggedCount === 4 && out.worstNow.symbol === "BUSD2", "flagged count and the worst deviation now");
  const capAll = 150e9 + 2e9 + 1e9 + 5e8 + 3e8 + 6e8 + 7e8;
  ok(near(out.onPegMarketCapSharePct, +(((150e9 + 1e9 + 3e8 + 6e8) / capAll) * 100).toFixed(2)) && near(by.USDT.marketCapSharePct, +((150e9 / capAll) * 100).toFixed(2)), "share of watched market cap on peg, and each coin's share");
  ok(out.matched === 7 && out.returned === 7 && out.complete === true && !("coverage" in out), "list fields say the answer is whole");
  ok(!JSON.stringify(out).includes("sparkline") && !("price" in by.USDT) && !("marketCap" in by.USDT), "no upstream row or series is passed through");

  const wide = await h("stablecoin-depeg-watch")({ minMarketCapUsd: 1000000, thresholdBps: 400, limit: 2 });
  ok(wide.screened === 9 && wide.assessed === 8 && wide.coins.length === 2 && wide.truncated === true && wide.matched === 8, "a lower floor and a cap: the list says it is partial");
  ok(wide.flaggedCount === 2 && wide.coins.map((c) => c.symbol).join() === "BUSD2,SUSD", "a wider threshold flags only the widest deviations");
  ok(calls.length === 1, "the second answer came from the cached reduced document");
  await throws(h("stablecoin-depeg-watch")({ minMarketCapUsd: 5 }), 400, "a floor under the minimum", /minMarketCapUsd/);
  await throws(h("stablecoin-depeg-watch")({ thresholdBps: 0 }), 400, "a zero threshold");
  await throws(h("stablecoin-depeg-watch")({ limit: 101 }), 400, "limit above 100");

  // A full page whose smallest row is still above the floor says what it did not read.
  reset();
  routes = [[(u) => u.pathname === "/api/v3/coins/markets", () => jsonRes(200, Array.from({ length: 250 }, (_, k) => coin(`c${k}`, `c${k}`, 1, 9e9 - k * 1e6, 1, 1, flat(1))))]];
  const full = await h("stablecoin-depeg-watch")({ limit: 1 });
  ok(typeof full.coverage === "string" && /250 largest/.test(full.coverage), "a floor below the page's last row states the coverage");
}

// ----------------------------------------------------------------------------
// exchange-spread
// ----------------------------------------------------------------------------
const tick = (id, name, target, usd, vol, extra = {}) => ({ base: "ETH", target, market: { name, identifier: id }, converted_last: { usd }, converted_volume: { usd: vol }, bid_ask_spread_percentage: 0.02, is_stale: false, is_anomaly: false, ...extra });
const TICKERS = { name: "Ethereum", tickers: [
  tick("a", "Venue A", "USDC", 1500, 10),                 // Venue A's smaller market, listed first: not used
  tick("a", "Venue A", "USDT", 1000, 500),
  tick("b", "Venue B", "USDT", 1001, 300),
  tick("c", "Venue C", "USD", 999, 100),
  tick("d", "Venue D", "USDC", 1000.5, 60, { bid_ask_spread_percentage: 0.9 }),
  tick("e", "Venue E", "USDT", 1020, 40),                 // 200 bps above the median
  tick("f", "Venue F", "USDT", 900, 999, { is_stale: true }),
  tick("g", "Venue G", "USDT", 2000, 999, { is_anomaly: true }),
  tick("h", "Venue H", "USDT", null, 5),                  // no price
] };
routes = [[path("/coins/ethereum/tickers"), () => jsonRes(200, TICKERS)], [path("/coins/solo/tickers"), () => jsonRes(200, { name: "Solo", tickers: [tick("a", "Venue A", "USDT", 5, 1)] })]];
reset();
{
  const out = await h("exchange-spread")({ coin: "Ethereum" });
  ok(calls.length === 1 && calls[0].url.searchParams.get("order") === "volume_desc", "one read of the coin's tickers, largest first");
  ok(out.coin === "ethereum" && out.name === "Ethereum" && out.venuesCompared === 5 && out.excluded.stale === 1 && out.excluded.anomalous === 1, "five venues compared; stale and anomalous tickers counted and left out");
  ok(out.medianPriceUsd === 1000.5, `the median is over one market per venue (${out.medianPriceUsd})`);
  const by = Object.fromEntries(out.venues.map((v) => [v.venue, v]));
  ok(near(by["Venue E"].deviationBps, +(((1020 - 1000.5) / 1000.5) * 1e4).toFixed(2)) && by["Venue E"].flags.includes("outlier") && by["Venue E"].rank === 1, "the widest venue ranks first and is flagged an outlier");
  ok(near(by["Venue A"].deviationBps, +(((1000 - 1000.5) / 1000.5) * 1e4).toFixed(2)) && by["Venue A"].pair === "ETH/USDT" && near(by["Venue A"].volumeSharePct, 50), "Venue A is read on its largest market, with its share of volume");
  ok(by["Venue D"].flags.join() === "wide-quote" && by["Venue D"].bidAskPct === 0.9, "a quoted spread above 0.5% is flagged");
  ok(out.highest.venue === "Venue E" && out.lowest.venue === "Venue C" && near(out.spread.highLowBps, +(((1020 - 999) / 1000.5) * 1e4).toFixed(2)), "highest, lowest and the high-to-low spread");
  ok(near(out.volumeWeightedPriceUsd, +((1000 * 500 + 1001 * 300 + 999 * 100 + 1000.5 * 60 + 1020 * 40) / 1000).toFixed(4)), "volume-weighted price");
  ok(out.matched === 5 && out.complete === true && !Object.values(by).some((v) => "price" in v || "last" in v), "per-venue rows carry deviations, not prices");
  const usdt = await h("exchange-spread")({ coin: "ethereum", quote: "usdt", limit: 2 });
  ok(usdt.quote === "USDT" && usdt.venuesCompared === 3 && usdt.venues.length === 2 && usdt.truncated === true && usdt.medianPriceUsd === 1001, "a quote filter compares only that quote; a capped list says so");
  ok(calls.length === 1, "the filter was answered from the cached document");
  await throws(h("exchange-spread")({ coin: "solo" }), 422, "one live venue is nothing to compare", /Fewer than two/);
  await throws(h("exchange-spread")({}), 400, "coin is required");
  await throws(h("exchange-spread")({ coin: "ethereum", quote: "US D" }), 400, "a malformed quote");
  await throws(h("exchange-spread")({ coin: "../x" }), 400, "a path-shaped coin id never reaches the URL");
  await throws(h("exchange-spread")({ coin: "nope" }), 422, "an unknown coin (upstream 404)");
}

// ----------------------------------------------------------------------------
// defi-screener and chain-board
// ----------------------------------------------------------------------------
const mk = (id, symbol, cap, vol, ch24, ch7, ath, fdv, rank) => ({ id, symbol, name: id, market_cap: cap, total_volume: vol, price_change_percentage_24h: ch24, price_change_percentage_7d_in_currency: ch7, ath_change_percentage: ath, fully_diluted_valuation: fdv, market_cap_rank: rank });
const DEFI = [
  mk("big", "big", 600, 30, 1, 5, -40, 600, 10),
  mk("churn", "chn", 200, 100, -2, -8, -85, 500, 30),   // turnover 50%, drawdown 85%, fdv 2.5x
  mk("mid", "mid", 150, 3, 4, 2, -10, 150, 40),
  mk("tiny", "tny", 50, 1, null, null, null, null, null),
  mk("zero", "zro", 0, 1, 1, 1, -1, 1, null),           // no market cap: left out
];
const MARKETS = [mk("bitcoin", "btc", 5000, 100, -1, 0, -50, 5000, 1), mk("ethereum", "eth", 1000, 50, 2, 0, -60, 1000, 2), mk("solana", "sol", 200, 40, 5, 0, -70, 220, 6)];
const PLATFORMS = [
  { id: "ethereum", name: "Ethereum", chain_identifier: 1, native_coin_id: "ethereum" },
  { id: "base", name: "Base", chain_identifier: 8453, native_coin_id: "ethereum" },
  { id: "arbitrum-one", name: "Arbitrum One", chain_identifier: 42161, native_coin_id: "ethereum" },
  { id: "solana", name: "Solana", chain_identifier: null, native_coin_id: "solana" },
  { id: "ordinals", name: "Bitcoin", chain_identifier: null, native_coin_id: "bitcoin" },
  { id: "obscure", name: "Obscure", chain_identifier: 7, native_coin_id: "obscure-coin" },
  { id: "nameless", name: "Nameless", chain_identifier: 9, native_coin_id: "" },
];
routes = [
  [(u) => u.pathname === "/api/v3/coins/markets" && u.searchParams.get("category") === "decentralized-finance-defi", () => jsonRes(200, DEFI)],
  [(u) => u.pathname === "/api/v3/coins/markets" && !u.searchParams.get("category"), () => jsonRes(200, MARKETS)],
  [path("/asset_platforms"), () => jsonRes(200, PLATFORMS)],
  [path("/global"), () => jsonRes(200, { data: { total_market_cap: { usd: 10000 }, market_cap_change_percentage_24h_usd: 0.5 } })],
];
reset();
{
  const out = await h("defi-screener")({});
  ok(out.screened === 4 && out.matched === 4 && out.sort === "market_cap" && out.tokens[0].id === "big" && out.tokens[0].capRank === 1, "four tokens with a market cap, by cap");
  ok(out.categoryTotals.marketCapUsd === 1000 && near(out.categoryTotals.turnoverPct, 13.4) && near(out.categoryTotals.top10CapSharePct, 100), "category totals: cap, turnover, top-ten share");
  // cap-weighted 24h change over the three that report one: (600*1 + 200*-2 + 150*4) / 950
  ok(near(out.categoryTotals.capWeightedChange24hPct, +(800 / 950).toFixed(2)) && near(out.categoryTotals.tokensUpSharePct, 66.67), "cap-weighted move and the share of tokens up, over tokens that report a move");
  const by = Object.fromEntries(out.tokens.map((t) => [t.id, t]));
  ok(near(by.churn.capSharePct, 20) && near(by.churn.turnoverPct, 50) && near(by.churn.fdvToCapRatio, 2.5) && near(by.churn.change24hVsCategoryPct, +(-2 - 800 / 950).toFixed(2)), "computed columns: cap share, turnover, dilution, move against the category");
  ok(by.churn.flags.join() === "high-turnover,deep-drawdown,dilution-overhang" && by.big.flags.length === 0, "flags at their thresholds");
  ok(by.tiny.change24hPct === null && by.tiny.change24hVsCategoryPct === null && by.tiny.fdvToCapRatio === null, "a missing input reads null, never zero");
  ok(!("marketCap" in by.big) && !("price" in by.big) && !("volume" in by.big), "token rows carry shares and ratios, not the upstream's cap, price or volume");
  const turn = await h("defi-screener")({ sort: "turnover", minMarketCapUsd: 100, limit: 2 });
  ok(turn.tokens.map((t) => t.id).join() === "churn,big" && turn.matched === 3 && turn.truncated === true && turn.tokens[0].rank === 1 && turn.tokens[0].capRank === 2, "sort by turnover over a cap floor: rank in this order, capRank in the category");
  const dd = await h("defi-screener")({ sort: "ath_drawdown", minTurnoverPct: 2 });
  ok(dd.tokens.map((t) => t.id).join() === "churn,big,mid,tiny", "deepest drawdown first, unknown last");
  ok(calls.length === 1, "three screens, one upstream read");
  await throws(h("defi-screener")({ sort: "tvl" }), 400, "an unknown sort names the choices", /market_cap, turnover/);
  await throws(h("defi-screener")({ limit: 0 }), 400, "limit 0");
  await throws(h("defi-screener")({ minMarketCapUsd: -1 }), 400, "a negative floor");

  const board = await h("chain-board")({});
  ok(calls.length === 4, `chain-board reads three documents (${calls.length - 1})`);
  ok(board.chainsTracked === 6 && board.chainsRanked === 5 && board.chainsOutsideTop250 === 1 && board.matched === 3, "chains with a native coin, those ranked, and those outside the 250 largest");
  ok(board.assets.map((a) => a.nativeCoin).join() === "bitcoin,ethereum,solana" && board.assets[1].symbol === "ETH", "one row per native asset, by market cap");
  const eth = board.assets[1];
  ok(eth.chainCount === 3 && eth.chains[0].id === "ethereum" && eth.chains.map((c) => c.chainId).join() === "1,42161,8453", "the asset's own chain first, then by name");
  ok(near(eth.capSharePct, 10) && near(eth.change24hVsMarketPct, 1.5) && near(eth.turnoverPct, 5) && eth.capRank === 2 && near(eth.athDrawdownPct, -60), "share of the whole market, move against it, turnover");
  ok(near(board.market.nativeAssetsCapSharePct, 62) && board.market.change24hPct === 0.5, "the ranked native assets' share of the market");
  const byChains = await h("chain-board")({ sort: "chains", limit: 1 });
  ok(byChains.assets[0].nativeCoin === "ethereum" && byChains.truncated === true && byChains.returned === 1, "sort by chain count; a capped list says so");
  ok(calls.length === 4, "the second board came from the cache");
  await throws(h("chain-board")({ sort: "tvl" }), 400, "an unknown sort");
}

// ----------------------------------------------------------------------------
// dex-volume-board
// ----------------------------------------------------------------------------
const poolRow = (dex, address, name, vol, liq, buys, sells) => ({ id: `net_${address}`, type: "pool", attributes: { address, name, volume_usd: { h24: String(vol) }, reserve_in_usd: String(liq), transactions: { h24: { buys, sells } } }, relationships: { dex: { data: { id: dex, type: "dex" } } } });
const PAGE1 = { data: [poolRow("alpha", "0xa1", "A / B", 600, 200, 30, 10), poolRow("alpha", "0xa2", "A / C", 200, 100, 5, 5), poolRow("beta", "0xb1", "B / C", 150, 300, 10, 30)], included: [{ id: "alpha", type: "dex", attributes: { name: "Alpha DEX" } }, { id: "beta", type: "dex", attributes: { name: "Beta DEX" } }] };
const PAGE2 = { data: [poolRow("gamma", "0xc1", "C / D", 50, 400, 1, 1), poolRow("alpha", "0xa1", "A / B", 600, 200, 30, 10)], included: [{ id: "gamma", type: "dex", attributes: { name: "Gamma DEX" } }] }; // 0xa1 moved pages mid-read
routes = [[(u) => u.pathname === "/api/v3/onchain/networks/base/pools", (u) => jsonRes(200, u.searchParams.get("page") === "1" ? PAGE1 : u.searchParams.get("page") === "2" ? PAGE2 : { data: [] })]];
reset();
{
  const out = await h("dex-volume-board")({ network: "Base", pools: 40 });
  ok(calls.length === 2 && calls.every((c) => c.url.searchParams.get("sort") === "h24_volume_usd_desc" && c.url.searchParams.get("include") === "dex"), "40 pools is two page reads, by 24h volume, with DEX names");
  ok(out.network === "base" && out.poolsRead === 4 && /4 largest pools/.test(out.scope), "a pool seen on two pages counts once; the scope is stated");
  ok(out.totals.volume24hUsd === 1000 && out.totals.liquidityUsd === 1000 && out.totals.turnover === 1 && out.totals.dexes === 3, "totals over the pools read");
  ok(near(out.totals.topDexSharePct, 80) && out.totals.hhi === Math.round(80 ** 2 + 15 ** 2 + 5 ** 2) && out.flags.join() === "concentrated", "top share, concentration index and the flag above half");
  const a = out.dexes[0];
  ok(a.dex === "alpha" && a.name === "Alpha DEX" && a.rank === 1 && near(a.volumeSharePct, 80) && near(a.liquiditySharePct, 30) && near(a.turnover, 2.67) && a.pools === 2, "a DEX row: volume share, liquidity share, turnover, pool count");
  ok(near(a.buyTradeSharePct, 70) && a.topPool.address === "0xa1" && near(a.topPool.shareOfDexVolumePct, 75), "buy share of trades and the DEX's largest pool");
  ok(out.matched === 3 && out.complete === true, "list fields");
  const one = await h("dex-volume-board")({ network: "base", pools: 40, limit: 1 });
  ok(one.dexes.length === 1 && one.truncated === true && calls.length === 2, "a capped list says so, from the cache");
  await throws(h("dex-volume-board")({ network: "base", pools: 30 }), 400, "pools must be a multiple of 20", /20, 40, 60, 80 or 100/);
  await throws(h("dex-volume-board")({ network: "base", pools: 120 }), 400, "pools above 100");
  await throws(h("dex-volume-board")({}), 400, "network is required");
  await throws(h("dex-volume-board")({ network: "a/b" }), 400, "a path-shaped network never reaches the URL");
  routes = [[(u) => u.pathname.startsWith("/api/v3/onchain/networks/empty/"), () => jsonRes(200, { data: [] })]];
  await throws(h("dex-volume-board")({ network: "empty", pools: 20 }), 422, "a network with no pools", /network id/);
  // The first page is read alone: an unknown network costs one upstream read, whatever `pools` asks for,
  // and is remembered for a short time, so the same id sent again costs none.
  reset();
  routes = [[(u) => u.pathname === "/api/v3/onchain/networks/base/pools", (u) => jsonRes(200, u.searchParams.get("page") === "1" ? PAGE1 : PAGE2)]];
  await throws(h("dex-volume-board")({ network: "nope-net", pools: 100 }), 422, "an unknown network", /network "nope-net"/);
  ok(calls.length === 1 && calls[0].url.searchParams.get("page") === "1", `an unknown network with pools=100 is one upstream read (${calls.length})`);
  await throws(h("dex-volume-board")({ network: "nope-net", pools: 100 }), 422, "the same unknown network again", /network "nope-net"/);
  await throws(h("dex-volume-board")({ network: "NOPE-NET", pools: 20 }), 422, "the same unknown network in another case", /network "nope-net"/);
  ok(calls.length === 1, `an unknown network sent again makes no upstream read (${calls.length - 1} more)`);
  const known = await h("dex-volume-board")({ network: "base", pools: 100 });
  ok(known.poolsRead === 4 && calls.length === 6, `a known network is still read in full: five pages for pools=100 (${calls.length - 1})`);
  // An upstream failure is not a verdict on the network id: nothing is remembered.
  reset();
  routes = [[(u) => u.pathname.startsWith("/api/v3/onchain/networks/flaky/"), () => jsonRes(500, {})]];
  await throws(h("dex-volume-board")({ network: "flaky", pools: 100 }), 502, "an upstream failure on the first page");
  const afterFail = calls.length;
  routes = [[(u) => u.pathname.startsWith("/api/v3/onchain/networks/flaky/"), (u) => jsonRes(200, u.searchParams.get("page") === "1" ? PAGE1 : { data: [] })]];
  ok((await h("dex-volume-board")({ network: "flaky", pools: 20 })).poolsRead === 3 && calls.length === afterFail + 1, "a network whose read failed upstream is read again");
  // The remembered set is bounded.
  reset();
  routes = [];
  for (let k = 0; k < UNKNOWN_NETWORK_MAX + 3; k++) await h("dex-volume-board")({ network: `ghost-${k}`, pools: 20 }).catch(() => {});
  calls.length = 0;
  await h("dex-volume-board")({ network: "ghost-0", pools: 20 }).catch(() => {});
  await h("dex-volume-board")({ network: `ghost-${UNKNOWN_NETWORK_MAX + 2}`, pools: 20 }).catch(() => {});
  ok(calls.length === 1, `the remembered set holds ${UNKNOWN_NETWORK_MAX} ids, oldest dropped first`);
  reset();
}

// ----------------------------------------------------------------------------
// dex-pool-health
// ----------------------------------------------------------------------------
const NOW = Date.now();
const POOL = (over = {}) => ({ data: { id: "eth_0xpool", type: "pool", attributes: { address: "0xpool00000000000000000000000000000000000001", name: "WETH / USDC 0.05%", pool_created_at: new Date(NOW - 400 * 86_400_000).toISOString(), reserve_in_usd: "2000000", volume_usd: { h24: "3000000" }, transactions: { h24: { buys: 60, sells: 40, buyers: 30, sellers: 20 } }, locked_liquidity_percentage: "12.5", ...over }, relationships: { dex: { data: { id: "uniswap_v3", type: "dex" } } } } });
const trade = (usd, kind, wallet, minsAgo, extra = {}) => ({ id: `t${usd}${wallet}${minsAgo}`, type: "trade", attributes: { volume_in_usd: String(usd), kind, tx_from_address: wallet, block_timestamp: new Date(NOW - minsAgo * 60_000).toISOString(), is_anomalous: false, ...extra } });
// 40 trades: wallet w0 makes 16 (40%), w1 makes 4, twenty others one each.
const TRADES = { data: [
  ...Array.from({ length: 16 }, (_, k) => trade(100, k % 2 ? "sell" : "buy", "w0", k)),
  ...Array.from({ length: 4 }, (_, k) => trade(1000, "buy", "w1", 20 + k)),
  ...Array.from({ length: 19 }, (_, k) => trade(200, "sell", `x${k}`, 30 + k)),
  trade(50000, "buy", "x99", 60, { is_anomalous: true }),
] };
const PA = "0xPOOL00000000000000000000000000000000000001";
const poolPath = "/api/v3/onchain/networks/eth/pools/0xpool00000000000000000000000000000000000001";
let poolDoc = POOL(), tradesDoc = TRADES;
routes = [[(u) => u.pathname === poolPath, () => jsonRes(200, poolDoc)], [(u) => u.pathname === `${poolPath}/trades`, () => jsonRes(200, tradesDoc)]];
reset();
{
  const out = await h("dex-pool-health")({ network: "eth", pool: PA });
  ok(calls.length === 2, "two reads: the pool and its latest trades (a hex address is lowercased for the path)");
  ok(out.pool === "0xpool00000000000000000000000000000000000001" && out.name === "WETH / USDC 0.05%" && out.dex === "uniswap_v3" && out.ageDays === 400, "identity and age");
  ok(out.liquidityUsd === 2_000_000 && out.volume24hUsd === 3_000_000 && out.turnover24h === 1.5 && out.lockedLiquidityPct === 12.5, "liquidity, volume, turnover, locked share");
  ok(out.activity24h.trades === 100 && out.activity24h.buyTradeSharePct === 60 && out.activity24h.buyerSharePct === 60, "24h activity: buy share of trades and of traders");
  const r = out.recentTrades;
  ok(r.count === 40 && r.uniqueWallets === 22 && near(r.topWalletTradeSharePct, 40) && near(r.repeatWalletTradeSharePct, 50) && r.anomalous === 1, "wallet mix of the latest trades: top wallet, repeat wallets, anomalous count");
  ok(r.medianUsd === 200 && r.largestUsd === 50000 && near(r.largestShareOfLiquidityPct, 2.5) && r.windowMinutes === 60, "trade sizes and the window they span");
  // buy volume: 8*100 + 4*1000 + 50000 of 16*100 + 4000 + 19*200 + 50000
  ok(near(r.buyVolumeSharePct, +((54800 / 59400) * 100).toFixed(2)), "buy share of recent volume");
  ok(near(out.priceImpactEstimate.per10kUsdPct, +((10000 / 1010000) * 100).toFixed(4)) && near(out.priceImpactEstimate.per1kUsdPct, +((1000 / 1001000) * 100).toFixed(4)) && /constant-product/.test(out.priceImpactEstimate.method), "price-impact estimate and its method");
  ok(out.flags.join() === "wallet-concentration", `one wallet above a quarter of the latest trades is flagged (${out.flags.join()})`);
  ok(!JSON.stringify(out).includes("tx_from_address") && !JSON.stringify(out).includes("w0"), "no trade row or wallet address is passed through");
  const again = await h("dex-pool-health")({ network: "eth", pool: PA.toLowerCase() });
  ok(again.cached === true && calls.length === 2, "a repeat call is served from the cache");

  reset();
  poolDoc = POOL({ reserve_in_usd: "20000", volume_usd: { h24: "200000" }, pool_created_at: new Date(NOW - 2 * 86_400_000).toISOString(), transactions: { h24: { buys: 95, sells: 5, buyers: 3, sellers: 1 } } });
  tradesDoc = { data: Array.from({ length: 30 }, (_, k) => trade(10, "buy", `r${k % 3}`, k)) };
  const thin = await h("dex-pool-health")({ network: "eth", pool: PA });
  ok(thin.flags.join() === "thin-liquidity,new-pool,high-churn,one-sided-flow,wallet-concentration,repeat-wallet-flow", `each threshold sets its flag (${thin.flags.join()})`);
  reset();
  poolDoc = POOL({ transactions: { h24: { buys: 0, sells: 0 } } }); tradesDoc = { data: [] };
  const idle = await h("dex-pool-health")({ network: "eth", pool: PA });
  ok(idle.recentTrades === null && idle.flags.join() === "no-recent-trades" && idle.activity24h.buyTradeSharePct === null, "an idle pool: no trade block, the flag, a null share");
  await throws(h("dex-pool-health")({ network: "eth" }), 400, "pool is required");
  await throws(h("dex-pool-health")({ network: "eth", pool: "0x12/../x" }), 400, "a path-shaped pool never reaches the URL");
  await throws(h("dex-pool-health")({ pool: PA }), 400, "network is required");
  await throws(h("dex-pool-health")({ network: "eth", pool: "0x00000000000000000000000000000000000000ff" }), 422, "an unknown pool (upstream 404)");
}

// ----------------------------------------------------------------------------
// A deployment without a key: the pool endpoints answer 401, which is a 503
// (nothing charged) that relays nothing of the upstream body.
// ----------------------------------------------------------------------------
reset();
routes = [[(u) => u.pathname.startsWith("/api/v3/onchain/"), () => jsonRes(401, { status: { error_code: 401, error_message: "SECRET-UPSTREAM-TEXT sign up at a pricing page" } })]];
await throws(h("dex-pool-health")({ network: "eth", pool: PA }), 503, "keyless pool read", /^((?!SECRET).)*not configured((?!SECRET).)*$/);
await throws(h("dex-volume-board")({ network: "base", pools: 20 }), 503, "keyless board read", /^((?!SECRET).)*not configured((?!SECRET).)*$/);
ok(calls.every((c) => Object.keys(c.headers).every((k) => !/^x-cg-/i.test(k))), "no key header is sent when no key is set");

// With a key and the pro tier, the same reads carry the key header on the pro host.
{
  reset();
  process.env.COINGECKO_API_KEY = "placeholder-not-a-key"; process.env.COINGECKO_API_TIER = "pro";
  routes = [[(u) => u.pathname === poolPath, () => jsonRes(200, POOL())], [(u) => u.pathname === `${poolPath}/trades`, () => jsonRes(200, TRADES)]];
  const out = await h("dex-pool-health")({ network: "eth", pool: PA });
  ok(out.liquidityUsd === 2_000_000 && calls.length === 2 && calls.every((c) => c.url.hostname === "pro-api.coingecko.com" && c.headers["x-cg-pro-api-key"] === "placeholder-not-a-key"), "keyed: the pro host with the key in its header");
  ok(!JSON.stringify(out).includes("placeholder-not-a-key") && calls.every((c) => !c.url.href.includes("placeholder-not-a-key")), "the key is in no URL and no answer");
  delete process.env.COINGECKO_API_KEY; delete process.env.COINGECKO_API_TIER;
}

// ----------------------------------------------------------------------------
// The shared budget: with the minute spent, an uncached read is refused 503
// before any upstream call; an answer already cached still serves.
// ----------------------------------------------------------------------------
{
  reset();
  routes = [[path("/derivatives"), () => jsonRes(200, DERIVATIVES)], [path("/coins/ethereum/tickers"), () => jsonRes(200, TICKERS)]];
  process.env.COINGECKO_MAX_PER_MIN = "1";
  resetCgRateLimit();
  const first = await raw("funding-screener")({ coin: "ETH" });
  ok(first.venues === 4 && calls.length === 1, "the one token of the minute buys the first read");
  let refused = null;
  try { await raw("exchange-spread")({ coin: "ethereum" }); } catch (e) { refused = e; }
  ok(refused?.statusCode === 503 && calls.length === 1, `a second uncached read is a 503 with no upstream call (${refused?.statusCode}, ${calls.length} call)`);
  const cachedAgain = await raw("funding-screener")({ coin: "BTC" });
  ok(cachedAgain.cached === true && cachedAgain.venues === 3 && calls.length === 1, "a different question over the cached document spends no token");
  delete process.env.COINGECKO_MAX_PER_MIN;
  resetCgRateLimit();
}

// A daily ceiling, with a key set, refuses the same way.
{
  reset();
  routes = [[path("/derivatives"), () => jsonRes(200, DERIVATIVES)]];
  process.env.COINGECKO_API_KEY = "placeholder-not-a-key"; process.env.COINGECKO_DAILY_MAX = "1";
  resetCgRateLimit();
  await raw("funding-screener")({ coin: "ETH" });
  clearCryptoMarketsCache();
  let refused = null;
  try { await raw("funding-screener")({ coin: "ETH" }); } catch (e) { refused = e; }
  ok(refused?.statusCode === 503 && calls.length === 1, "past the daily ceiling an uncached read is a 503 with no upstream call");
  delete process.env.COINGECKO_API_KEY; delete process.env.COINGECKO_DAILY_MAX;
  resetCgRateLimit();
}

// Upstream failure mapping rides the shared read: a malformed document is a 502.
{
  reset();
  routes = [[path("/derivatives"), () => jsonRes(200, { not: "a list" })]];
  await throws(h("funding-screener")({ coin: "ETH" }), 502, "a document of the wrong shape", /unexpected shape/);
  routes = [[path("/derivatives"), () => jsonRes(500, "SECRET-UPSTREAM-TEXT")]];
  await throws(h("funding-screener")({ coin: "ETH" }), 502, "upstream 500", /^((?!SECRET).)*$/);
  reset();
  routes = [[path("/derivatives"), () => jsonRes(200, DERIVATIVES)]];
  const out = await h("funding-screener")({ coin: "ETH" });
  ok(out.venues === 4 && out.cached === false, "a failed read was not cached: the next one goes upstream and answers");
}

ok(answered.size === SLUGS.length, `every tool answered at least once here (${answered.size}/${SLUGS.length})`);
ok(uncredited.length === 0, `every answer carried the source credit${uncredited.length ? ` (missing on ${[...new Set(uncredited)].join(", ")})` : ""}`);

console.log(`\ntest-crypto-screens-kit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
