// scripts/test-derivatives-kit.js
// Offline tests for src/tools/derivatives-kit.js. No network: globalThis.fetch
// is replaced with a router that answers each upstream (Hyperliquid info,
// Deribit public, DefiLlama options overview) from fixtures, so the test pins
//   - the catalog envelope (11 tools, prices, discovery),
//   - input validation (400s) before any egress,
//   - the output shape of every tool on fixture data,
//   - upstream 5xx -> 502, 429 -> 503, a deadline -> 503 naming the step,
//   - the "unknown coin" shapes Hyperliquid really returns (500 "null",
//     200 "null") -> 422, and Deribit's 400 error envelope -> 422 with no
//     upstream body relayed.
// Live coverage is the catalog's answers-its-own-example sweep (test-all.js).

import { DERIVATIVES_TOOLS, __test } from "../src/tools/derivatives-kit.js";

const h = (slug) => DERIVATIVES_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
async function throws(promise, status, label, msgRe) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status && (!msgRe || msgRe.test(e.message))) { pass++; console.log(`ok - ${label} -> ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}${msgRe ? ` /${msgRe.source}/` : ""}, got ${e.statusCode} (${e.message})`); }
  }
}

// ----------------------------------------------------------------------------
// Fixtures (shapes copied from live responses 2026-08-22)
// ----------------------------------------------------------------------------
const NOW = Date.now();
const META = {
  universe: [
    { szDecimals: 5, name: "BTC", maxLeverage: 40 },
    { szDecimals: 4, name: "ETH", maxLeverage: 25 },
    { szDecimals: 0, name: "kPEPE", maxLeverage: 10 },
    { szDecimals: 1, name: "OLD", maxLeverage: 3, isDelisted: true },
  ],
};
const CTXS = [
  { funding: "0.0000125", openInterest: "36000", prevDayPx: "76968.0", dayNtlVlm: "4679441788.67", premium: "0.00038842", oraclePx: "77236.0", markPx: "77267.0", midPx: "77266.5" },
  { funding: "-0.00005", openInterest: "754447", prevDayPx: "2380.3", dayNtlVlm: "3396726206.45", premium: "-0.0002", oraclePx: "2428.77", markPx: "2429.3", midPx: "2429.35" },
  { funding: "0.0003", openInterest: "1000000000", prevDayPx: "0.004", dayNtlVlm: "500000", premium: "0.001", oraclePx: "0.00400", markPx: "0.00404", midPx: "0.00404" },
  { funding: "0", openInterest: "0", prevDayPx: "1", dayNtlVlm: "0", premium: "0", oraclePx: "1", markPx: "1", midPx: "1" },
];
const FUNDING_HISTORY = Array.from({ length: 30 }, (_, k) => ({ coin: "BTC", fundingRate: k % 2 ? "0.00002" : "-0.00001", premium: "0.0001", time: NOW - (30 - k) * 3_600_000 }));
const CANDLES = Array.from({ length: 10 }, (_, k) => ({ t: NOW - (10 - k) * 3_600_000, T: NOW - (9 - k) * 3_600_000 - 1, s: "ETH", i: "1h", o: String(2400 + k), c: String(2401 + k), h: String(2410 + k), l: String(2390 + k), v: "10.5", n: 100 + k }));
const BOOK = {
  coin: "BTC", time: NOW,
  levels: [
    [{ px: "77279.0", sz: "3.0", n: 10 }, { px: "77278.0", sz: "1.0", n: 1 }, { px: "77277.0", sz: "1.0", n: 1 }],
    [{ px: "77280.0", sz: "1.0", n: 4 }, { px: "77281.0", sz: "1.0", n: 2 }, { px: "77282.0", sz: "1.0", n: 2 }],
  ],
};
const PREDICTED = [
  ["BTC", [["VenueA", { fundingRate: "0.00005", nextFundingTime: NOW + 3_600_000, fundingIntervalHours: 4 }], ["HlPerp", { fundingRate: "0.0000125", nextFundingTime: NOW + 600_000, fundingIntervalHours: 1 }]]],
  ["ETH", [["HlPerp", { fundingRate: "-0.00005", nextFundingTime: NOW + 600_000, fundingIntervalHours: 1 }]]],
];
const DERIBIT_BOOK = [
  { instrument_name: "BTC-25SEP26-120000-P", bid_price: 0.543, ask_price: 0.551, open_interest: 174.5, mark_price: 0.5476, mark_iv: 62.03, underlying_price: 77577.16, volume: 0, volume_usd: 0, estimated_delivery_price: 77233 },
  { instrument_name: "BTC-26AUG26-80000-C", bid_price: 0.0065, ask_price: 0.008, open_interest: 12.5, mark_price: 0.0073, mark_iv: 48.03, underlying_price: 77317.91, volume: 3.1, volume_usd: 1800, estimated_delivery_price: 77242 },
  { instrument_name: "BTC-26AUG26-77000-C", bid_price: 0.0115, ask_price: 0.0125, open_interest: 85.2, mark_price: 0.0121, mark_iv: 47.5, underlying_price: 77317.91, volume: 120.5, volume_usd: 112000, estimated_delivery_price: 77242 },
  { instrument_name: "BTC-26AUG26-77000-P", bid_price: 0.011, ask_price: 0.012, open_interest: 40, mark_price: 0.0115, mark_iv: 47.9, underlying_price: 77317.91, volume: 10, volume_usd: 9000, estimated_delivery_price: 77242 },
  { instrument_name: "BTC-26AUG26-70000-P", bid_price: 0.001, ask_price: 0.002, open_interest: 300, mark_price: 0.0015, mark_iv: 55, underlying_price: 77317.91, volume: 1, volume_usd: 700, estimated_delivery_price: 77242 },
];
const DERIBIT_TICKER = {
  timestamp: NOW, state: "open",
  stats: { high: 0.013, low: 0.011, price_change: -4.2, volume: 120.5, volume_usd: 112000 },
  greeks: { delta: 0.52, gamma: 0.00012, vega: 30.1, theta: -190.2, rho: 2.1 },
  index_price: 77242.3, instrument_name: "BTC-26AUG26-77000-C", last_price: 0.012, open_interest: 85.2, mark_price: 0.0121,
  best_ask_price: 0.0125, best_bid_price: 0.0115, mark_iv: 47.5, bid_iv: 46.1, ask_iv: 48.9, underlying_price: 77317.91,
  underlying_index: "BTC-26AUG26", best_ask_amount: 28.8, best_bid_amount: 40.2,
};
const DERIBIT_PERP = {
  timestamp: NOW, state: "open", stats: { high: 78838.5, low: 76231.5, price_change: 0.59, volume: 8581.8, volume_usd: 664803850 },
  index_price: 77232.62, instrument_name: "BTC-PERPETUAL", last_price: 77263.5, open_interest: 903679080, mark_price: 77263.43,
  current_funding: 0.000149, funding_8h: 0.000195, best_ask_price: 77264, best_bid_price: 77263.5, best_ask_amount: 30000, best_bid_amount: 133980,
};
const LLAMA = {
  allChains: ["Derive Chain", "Arbitrum"], total24h: 5093016, total7d: 11148265.31, total30d: 30971390.66, change_1d: 10.03, change_7d: 4.1,
  protocols: [
    { name: "Hegic", displayName: "Hegic", module: "hegic", category: "Options", chains: ["Arbitrum"], total24h: 7682, total7d: 12818.58, total30d: 23795.88, change_1d: 67.36, change_7d: 63916.67 },
    { name: "Derive", displayName: "Derive", module: "derive", category: "Options", chains: ["Derive Chain"], total24h: 3000000, total7d: 7000000, total30d: 20000000, change_1d: 12.5, change_7d: 3.2 },
  ],
};

// HIP-3 builder-deployed dexs (hyperliquid.gitbook.io Info endpoint > Perpetuals,
// probed live 2026-09-18): `perpDexs` is [null, dex...] with the native dex as
// the null at index 0; dex-scoped `meta` rows carry growthMode / onlyIsolated /
// marginMode / deployerFeeScale and the document carries collateralToken.
const PERP_DEXS = [
  null,
  { name: "xyz", fullName: "XYZ", deployer: "0x88806a71d74ad0a510b350545c9ae490912f0888", oracleUpdater: null, feeRecipient: "0x83ffcfb1f2ad843c474b2e28df86c721cb869d3a", assetToStreamingOiCap: [["xyz:AAPL", "200000000.0"], ["xyz:TSLA", "100000000.0"]], subDeployers: ["0xaaa"], assetToFundingMultiplier: [["xyz:AAPL", "1.0"]], assetToFundingInterestRate: [], assetToFundingClamp: [] },
  { name: "flx", fullName: "Felix Exchange", deployer: "0x2fab552502a6d45920d5741a2f3ebf4c35536352", oracleUpdater: "0x94757f8dcb4bf73b850195660e959d1105cfedd5", feeRecipient: "0xe2872b5ae7dcbba40cc4510d08c8bbea95b42d43", assetToStreamingOiCap: [], assetToFundingMultiplier: [] },
];
const DEX_META = {
  universe: [
    { szDecimals: 3, name: "xyz:TSLA", maxLeverage: 20, marginTableId: 20, growthMode: "enabled", deployerFeeScale: "1.0" },
    { szDecimals: 3, name: "xyz:HOOD", maxLeverage: 10, marginTableId: 10, onlyIsolated: true, marginMode: "noCross", growthMode: "enabled", deployerFeeScale: "1.0" },
    { szDecimals: 4, name: "xyz:GOLD", maxLeverage: 25, marginTableId: 25, deployerFeeScale: "1.0", isDelisted: true },
  ],
  marginTables: [[50, { description: "", marginTiers: [{ lowerBound: "0.0", maxLeverage: 50 }] }]],
  collateralToken: 0,
};
const DEX_CTXS = [
  { funding: "0.00000625", openInterest: "8837.246", prevDayPx: "425.0", dayNtlVlm: "158407743.45", premium: "-0.0000510343", oraclePx: "431.1", markPx: "431.2", midPx: "431.15", impactPxs: ["431.1", "431.2"], dayBaseVlm: "5374.1" },
  { funding: "0.0000125", openInterest: "1000", prevDayPx: "100.0", dayNtlVlm: "5000000", premium: "0.0001", oraclePx: "101.0", markPx: "101.0", midPx: "101.0", impactPxs: ["101.0", "101.0"], dayBaseVlm: "50000" },
  { funding: "0", openInterest: "0", prevDayPx: "1", dayNtlVlm: "0", premium: "0", oraclePx: "1", markPx: "1", midPx: "1" },
];
const DEAD_META = { universe: [{ szDecimals: 2, name: "flx:TSLA", maxLeverage: 10, isDelisted: true, growthMode: "enabled", deployerFeeScale: "1.0" }], marginTables: [], collateralToken: 360 };
const DEX_LIMITS = { totalOiCap: "10000000000.0", oiSzCapPerPerp: "20000000000.0", maxTransferNtl: "3000000000.0", coinToOiCap: [["xyz:AAPL", "200000000.0"], ["xyz:SP500", "1250000000.0"], ["xyz:TSLA", "100000000.0"]] };

// ----------------------------------------------------------------------------
// Fetch router. `mode` switches the failure injections.
// ----------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let mode = "ok";
const calls = [];
const res = (status, body) => ({ status, ok: status < 400, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, method: opts.method || "GET", body: opts.body || null });
  ok(opts.signal instanceof AbortSignal, `egress carries an AbortSignal (${u.slice(0, 40)})`);
  ok(String(opts.headers?.["User-Agent"] || "").includes("Agent402"), "egress carries the Agent402 User-Agent");
  if (mode === "timeout") { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; }
  if (mode === "http500") return res(500, "Internal Error");
  if (mode === "http429") return res(429, "slow down");
  if (mode === "htmljunk") return res(200, "<html>maintenance</html>");
  if (u === __test.HL_INFO) {
    const body = JSON.parse(opts.body);
    if (mode === "hl-unknown-500") return res(500, "null");
    if (mode === "hl-unknown-200") return res(200, "null");
    // HIP-3 dex-scoped reads (shapes copied from live responses 2026-09-18).
    // An unknown dex answers HTTP 500 "null" on Hyperliquid, the same shape
    // as an unknown coin.
    if (body.dex !== undefined) {
      // "dead" is a dex whose every market is delisted (six of ten live dexs
      // read that way on 2026-09-18).
      if (body.dex === "dead" && body.type === "metaAndAssetCtxs") return res(200, [DEAD_META, [DEX_CTXS[2]]]);
      if (body.dex !== "xyz") return res(500, "null");
      switch (body.type) {
        case "metaAndAssetCtxs": return res(200, [DEX_META, DEX_CTXS]);
        case "meta": return res(200, DEX_META);
        case "perpDexLimits": return res(200, DEX_LIMITS);
        case "perpDexStatus": return res(200, { totalNetDeposit: "1089269477.9947810173" });
        case "perpsAtOpenInterestCap": return res(200, ["xyz:HOOD"]);
        default: return res(422, "Failed to deserialize the JSON body into the target type");
      }
    }
    switch (body.type) {
      case "perpDexs": return res(200, PERP_DEXS);
      case "allPerpMetas": return mode === "no-all-metas" ? res(500, "boom") : res(200, [META, DEX_META, DEAD_META]);
      case "perpDeployAuctionStatus": return res(200, { startTimeSeconds: 1789729200, durationSeconds: 111600, startGas: "500.0", currentGas: null, endGas: "500.0" });
      case "metaAndAssetCtxs": return res(200, [META, CTXS]);
      case "meta": return res(200, META);
      case "fundingHistory": return res(200, FUNDING_HISTORY.filter((f) => f.time >= body.startTime));
      case "candleSnapshot": return res(200, CANDLES);
      case "l2Book": return res(200, BOOK);
      case "predictedFundings": return res(200, PREDICTED);
      default: return res(422, "Failed to deserialize the JSON body into the target type");
    }
  }
  if (u.startsWith(__test.DERIBIT)) {
    const { pathname, searchParams } = new URL(u);
    const method = pathname.split("/").pop();
    const errEnv = (reason, param) => res(400, { jsonrpc: "2.0", error: { code: -32602, data: { reason, param }, message: "Invalid params" } });
    if (mode === "deribit-invalid") return errEnv("invalid currency", "currency");
    if (mode === "deribit-weird-reason") return errEnv("<script>alert(1)</script> SECRET_TOKEN_abc", "currency");
    const wrap = (result) => res(200, { jsonrpc: "2.0", result });
    switch (method) {
      case "get_index_price": return searchParams.get("index_name") === "btc_usd" ? wrap({ index_price: 77232.62, estimated_delivery_price: 77232.62 }) : errEnv("invalid index", "index_name");
      case "get_book_summary_by_currency": return searchParams.get("currency") === "BTC" ? wrap(DERIBIT_BOOK) : wrap([]);
      case "get_volatility_index_data": return wrap({ data: [[NOW - 3_600_000, 41.5, 41.7, 41.4, 41.6], [NOW, 41.6, 41.9, 41.6, 41.88]], continuation: null });
      case "ticker": {
        const name = searchParams.get("instrument_name");
        if (name === "BTC-PERPETUAL") return wrap(DERIBIT_PERP);
        if (name === "BTC-26AUG26-77000-C") return wrap(DERIBIT_TICKER);
        return errEnv("instrument not found", "instrument_name");
      }
      default: return errEnv("unknown method", "method");
    }
  }
  if (u === __test.LLAMA_OPTIONS) return res(200, LLAMA);
  throw new Error(`unexpected egress in test: ${u}`);
};

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
const EXPECTED = {
  "perp-markets": "$0.003", "perp-funding": "$0.002", "perp-funding-screener": "$0.002", "perp-open-interest": "$0.001",
  "perp-klines": "$0.001", "perp-orderbook": "$0.002", "perp-basis": "$0.002",
  "perp-dexs": "$0.002", "perp-dex-markets": "$0.003", "perp-dex-limits": "$0.002",
  "options-summary": "$0.005", "crypto-options-chain": "$0.004", "options-ticker": "$0.002", "options-volume": "$0.002",
};
ok(DERIVATIVES_TOOLS.length === Object.keys(EXPECTED).length, `${Object.keys(EXPECTED).length} tools exported (got ${DERIVATIVES_TOOLS.length})`);
ok(new Set(DERIVATIVES_TOOLS.map((t) => t.slug)).size === DERIVATIVES_TOOLS.length, "slugs unique");
for (const t of DERIVATIVES_TOOLS) {
  ok(EXPECTED[t.slug] === t.price, `${t.slug}: price ${t.price}`);
  ok(t.route === `POST /api/${t.slug}`, `${t.slug}: POST /api/${t.slug}`);
  ok(t.category === "crypto", `${t.slug}: category=crypto`);
  ok(typeof t.handler === "function", `${t.slug}: has handler`);
  ok(typeof t.name === "string" && typeof t.description === "string" && t.description.length > 40, `${t.slug}: name + description`);
  ok(Array.isArray(t.tags) && t.tags.includes("derivatives"), `${t.slug}: tagged derivatives`);
  const d = t.discovery;
  ok(d && d.bodyType === "json" && d.input && d.inputSchema?.properties && Array.isArray(d.inputSchema.required) && d.output?.example, `${t.slug}: full discovery envelope`);
  ok(!/\u2014/.test(`${t.name}${t.description}${JSON.stringify(d.inputSchema)}`), `${t.slug}: no em dashes in copy`);
  for (const k of Object.keys(d.input)) ok(k in d.inputSchema.properties, `${t.slug}: example input "${k}" is declared in inputSchema`);
}

// ----------------------------------------------------------------------------
// Input validation (400s) - none of these may egress
// ----------------------------------------------------------------------------
const before = calls.length;
await throws(h("perp-markets")({ limit: 0 }), 400, "perp-markets: limit 0");
await throws(h("perp-markets")({ limit: 501 }), 400, "perp-markets: limit 501");
await throws(h("perp-markets")({ limit: 2.5 }), 400, "perp-markets: fractional limit");
await throws(h("perp-markets")({ sort: "bogus" }), 400, "perp-markets: bad sort");
await throws(h("perp-markets")({ coins: 42 }), 400, "perp-markets: coins not a string");
await throws(h("perp-markets")({ coins: "BTC, ETH$" }), 400, "perp-markets: coins bad chars");
await throws(h("perp-funding")({}), 400, "perp-funding: missing coin");
await throws(h("perp-funding")({ coin: "BTC", limit: 9999 }), 400, "perp-funding: limit too big");
await throws(h("perp-funding")({ coin: "BTC ETH" }), 400, "perp-funding: coin with space");
await throws(h("perp-funding-screener")({ limit: 101 }), 400, "perp-funding-screener: limit > 100");
await throws(h("perp-funding-screener")({ minVolumeUsd: -1 }), 400, "perp-funding-screener: negative minVolumeUsd");
await throws(h("perp-open-interest")({ limit: "abc" }), 400, "perp-open-interest: limit NaN");
await throws(h("perp-klines")({}), 400, "perp-klines: missing coin");
await throws(h("perp-klines")({ coin: "BTC", interval: "7m" }), 400, "perp-klines: bad interval");
await throws(h("perp-klines")({ coin: "BTC", limit: 501 }), 400, "perp-klines: limit 501");
await throws(h("perp-orderbook")({}), 400, "perp-orderbook: missing coin");
await throws(h("perp-orderbook")({ coin: "BTC", depth: 21 }), 400, "perp-orderbook: depth > 20");
await throws(h("perp-basis")({}), 400, "perp-basis: missing coin");
await throws(h("perp-basis")({ coin: "x".repeat(40) }), 400, "perp-basis: coin too long");
await throws(h("options-summary")({ currency: "B" }), 400, "options-summary: currency too short");
await throws(h("options-summary")({ currency: "BTC-USD" }), 400, "options-summary: currency bad chars");
await throws(h("crypto-options-chain")({ expiry: "2026-08-26" }), 400, "options-chain: expiry wrong format");
await throws(h("crypto-options-chain")({ type: "straddle" }), 400, "options-chain: bad type");
await throws(h("crypto-options-chain")({ limit: 0 }), 400, "options-chain: limit 0");
await throws(h("options-ticker")({}), 400, "options-ticker: neither instrument nor currency");
await throws(h("options-ticker")({ instrument: "btc perpetual" }), 400, "options-ticker: instrument with space");
await throws(h("options-ticker")({ instrument: "BTC-PERPETUAL; DROP" }), 400, "options-ticker: instrument bad chars");
await throws(h("options-ticker")({ currency: "BTC", type: "call-spread" }), 400, "options-ticker: bad type");
await throws(h("options-volume")({ limit: 101 }), 400, "options-volume: limit > 100");
await throws(h("options-volume")({ chain: "<b>arb</b>" }), 400, "options-volume: chain bad chars");
ok(calls.length === before, "input validation rejected before any egress");

// ----------------------------------------------------------------------------
// Output shapes on fixture data
// ----------------------------------------------------------------------------
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

{
  const out = await h("perp-markets")({ limit: 2 });
  ok(out.source === "hyperliquid" && typeof out.fetchedAt === "string", "perp-markets: source + fetchedAt");
  ok(out.totalMarkets === 3, `perp-markets: delisted market dropped (totalMarkets ${out.totalMarkets})`);
  ok(out.count === 2 && out.markets.length === 2 && out.markets[0].coin === "BTC", "perp-markets: sorted by volume, limited to 2");
  const btc = out.markets[0];
  ok(near(btc.fundingHourly, 0.0000125) && near(btc.funding8h, 0.0001) && near(btc.fundingAprPct, 10.95, 1e-3), "perp-markets: funding hourly/8h/apr");
  ok(near(btc.openInterestUsd, 36000 * 77267, 1), "perp-markets: openInterestUsd = oi * mark");
  ok(near(btc.change24hPct, ((77267 - 76968) / 76968) * 100, 1e-3), "perp-markets: 24h change vs prevDayPx");
  ok(btc.maxLeverage === 40 && near(btc.premiumPct, 0.038842, 1e-5), "perp-markets: maxLeverage + premiumPct");
  const byFunding = await h("perp-markets")({ sort: "funding", limit: 1 });
  ok(byFunding.markets[0].coin === "kPEPE", "perp-markets: sort=funding puts the highest funding first");
  const filtered = await h("perp-markets")({ coins: "eth,btc" });
  ok(filtered.count === 2 && filtered.markets.every((m) => ["BTC", "ETH"].includes(m.coin)), "perp-markets: coins filter is case-insensitive");
}

{
  __test.resetMetaCache();
  const out = await h("perp-funding")({ coin: "btc", limit: 5 });
  ok(out.coin === "BTC", "perp-funding: coin resolved case-insensitively against the universe");
  ok(out.history.length === 5 && out.stats.points === 5, "perp-funding: history sliced to limit");
  ok(typeof out.history[0].time === "string" && typeof out.history[0].fundingRate === "number", "perp-funding: history rows typed");
  ok(near(out.current.hourly, 0.0000125) && near(out.current.per8h, 0.0001), "perp-funding: current hourly/per8h");
  ok(out.stats.minHourly === -0.00001 && out.stats.maxHourly === 0.00002, "perp-funding: min/max over window");
  ok(out.stats.positiveSharePct === 60 || out.stats.positiveSharePct === 40, `perp-funding: positive share computed (${out.stats.positiveSharePct})`);
  const sent = JSON.parse(calls.filter((c) => c.url === __test.HL_INFO).pop().body);
  ok(sent.type === "fundingHistory" && sent.coin === "BTC" && NOW - sent.startTime <= 7 * 3_600_000, "perp-funding: fundingHistory window sized to limit");
}

{
  const out = await h("perp-funding-screener")({ limit: 1, minVolumeUsd: 0 });
  ok(out.highest[0].coin === "kPEPE" && out.lowest[0].coin === "ETH", "perp-funding-screener: highest/lowest by funding");
  ok(out.screened === 3 && out.minVolumeUsd === 0, "perp-funding-screener: screened count + echo of filter");
  const strict = await h("perp-funding-screener")({ limit: 5 });
  ok(strict.screened === 2 && !strict.highest.some((r) => r.coin === "kPEPE"), "perp-funding-screener: default $1M volume floor drops thin markets");
}

{
  const ranked = await h("perp-open-interest")({ limit: 2 });
  ok(ranked.markets.length === 2 && ranked.markets[0].coin === "BTC" && ranked.markets[1].coin === "ETH", "perp-open-interest: ranked by USD open interest (BTC, ETH, then kPEPE)");
  ok(ranked.markets.every((m) => typeof m.shareOfTotalPct === "number"), "perp-open-interest: share of total per row");
  const all = await h("perp-open-interest")({ limit: 10 });
  ok(all.count === 3 && near(all.markets.reduce((a, m) => a + m.shareOfTotalPct, 0), 100, 0.01), "perp-open-interest: shares sum to 100");
  const one = await h("perp-open-interest")({ coin: "eth" });
  ok(one.market.coin === "ETH" && one.market.openInterest === 754447 && typeof one.totalOpenInterestUsd === "number", "perp-open-interest: single coin view");
}

{
  __test.resetMetaCache();
  const out = await h("perp-klines")({ coin: "eth", interval: "1h", limit: 4 });
  ok(out.coin === "ETH" && out.interval === "1h" && out.count === 4, "perp-klines: coin/interval/count");
  ok(out.candles[0].o === 2406 && out.candles[3].c === 2410 && out.candles[0].trades === 106, "perp-klines: newest-last, sliced to limit, typed");
  ok(out.summary.open === 2406 && out.summary.close === 2410 && out.summary.high === 2419 && out.summary.low === 2396, "perp-klines: window summary");
  const sent = JSON.parse(calls.filter((c) => c.url === __test.HL_INFO).pop().body);
  ok(sent.type === "candleSnapshot" && sent.req.coin === "ETH" && sent.req.endTime - sent.req.startTime === 4 * 3_600_000, "perp-klines: window = limit * interval");
  ok(Object.keys(__test.INTERVALS).length === 14, "perp-klines: 14 intervals");
}

{
  const out = await h("perp-orderbook")({ coin: "BTC", depth: 2 });
  ok(out.bestBid === 77279 && out.bestAsk === 77280 && out.spread === 1 && near(out.mid, 77279.5), "perp-orderbook: best bid/ask/spread/mid");
  ok(near(out.spreadBps, (1 / 77279.5) * 10_000, 1e-3), "perp-orderbook: spread bps");
  ok(out.bids.length === 2 && out.asks.length === 2 && out.bidDepth.levels === 2, "perp-orderbook: depth applied per side");
  ok(near(out.bidDepth.size, 4) && near(out.askDepth.size, 2) && out.imbalance > 0.3, "perp-orderbook: depth sizes + positive imbalance (bid heavy)");
}

{
  const out = await h("perp-basis")({ coin: "BTC" });
  ok(near(out.markOraclePremiumPct, ((77267 - 77236) / 77236) * 100, 1e-4) && near(out.markOraclePremiumBps, ((77267 - 77236) / 77236) * 10_000, 1e-3), "perp-basis: mark vs oracle premium");
  ok(out.predictedFunding.length === 2, "perp-basis: predicted funding per venue");
  const a = out.predictedFunding.find((v) => v.venue === "VenueA");
  ok(a.fundingIntervalHours === 4 && near(a.per8h, 0.0001) && typeof a.nextFundingTime === "string", "perp-basis: 4h venue normalized to 8h");
  ok(near(out.funding.hourly, 0.0000125) && near(out.impactPremiumPct, 0.038842, 1e-5), "perp-basis: funding + impact premium");
}

{
  const out = await h("options-summary")({});
  ok(out.currency === "BTC" && out.indexPrice === 77232.62 && out.source === "deribit", "options-summary: default currency BTC + index");
  ok(out.dvol.value === 41.88 && typeof out.dvol.time === "string", "options-summary: DVOL = latest close");
  const o = out.options;
  ok(o.instruments === 5 && near(o.callOpenInterest, 97.7) && near(o.putOpenInterest, 514.5) && near(o.putCallOiRatio, 514.5 / 97.7, 1e-3), "options-summary: call/put OI + ratio");
  ok(near(o.volume24hUsd, 123500) && o.expiries.length === 2 && o.expiries[0].expiry === "26AUG26", "options-summary: volume + expiries sorted by date");
  ok(o.topByOpenInterest[0].instrument === "BTC-26AUG26-70000-P" && o.topByOpenInterest[0].type === "put", "options-summary: top by OI");
  ok(out.perpetual.instrument === "BTC-PERPETUAL" && out.perpetual.funding8h === 0.000195, "options-summary: perpetual block");
  const eth = await h("options-summary")({ currency: "eth" });
  ok(eth.currency === "ETH" && eth.options.instruments === 0 && eth.indexPrice === null && eth.perpetual === null, "options-summary: empty book degrades to zeros/nulls, not an error");
}

{
  const out = await h("crypto-options-chain")({ currency: "btc", limit: 10 });
  ok(out.expiry === "26AUG26" && out.expiresAt === new Date(Date.UTC(2026, 7, 26, 8)).toISOString(), "options-chain: nearest expiry by default, 08:00 UTC");
  ok(out.expiries.join(",") === "26AUG26,25SEP26", "options-chain: available expiries listed");
  ok(out.count === 4 && out.options[0].strike === 70000 && out.options[3].strike === 80000, "options-chain: sorted by strike");
  ok(out.options[1].type === "call" && out.options[2].type === "put" && out.underlyingPrice === 77317.91, "options-chain: call before put at equal strike + underlying");
  const puts = await h("crypto-options-chain")({ currency: "BTC", expiry: "26aug26", type: "put", limit: 1 });
  ok(puts.count === 1 && puts.options[0].instrument === "BTC-26AUG26-70000-P", "options-chain: expiry case-folded + type filter + limit");
  await throws(h("crypto-options-chain")({ currency: "BTC", expiry: "31DEC30" }), 422, "options-chain: unlisted expiry", /available: 26AUG26/);
  await throws(h("crypto-options-chain")({ currency: "ETH" }), 422, "options-chain: currency with no options");
}

{
  const out = await h("options-ticker")({ instrument: "btc-perpetual" });
  ok(out.resolvedFrom === "instrument" && out.ticker.instrument === "BTC-PERPETUAL" && out.ticker.funding8h === 0.000195 && out.ticker.greeks === null, "options-ticker: explicit instrument (perpetual, no greeks)");
  const atm = await h("options-ticker")({ currency: "BTC" });
  ok(atm.resolvedFrom === "nearest-expiry-atm" && atm.ticker.instrument === "BTC-26AUG26-77000-C", "options-ticker: currency resolves nearest-expiry ATM call");
  ok(atm.ticker.greeks.delta === 0.52 && atm.ticker.markIv === 47.5 && atm.ticker.stats.volume24hUsd === 112000, "options-ticker: greeks + IV + stats");
  await throws(h("options-ticker")({ instrument: "BTC-99JAN99-80000-C" }), 422, "options-ticker: unknown instrument", /instrument not found/);
}

{
  const out = await h("options-volume")({ limit: 1 });
  ok(out.source === "defillama-options" && out.totals.volume24hUsd === 5093016 && out.chains.length === 2, "options-volume: totals + chains");
  ok(out.count === 1 && out.protocols[0].slug === "derive" && out.protocols[0].volume24hUsd === 3000000, "options-volume: ranked by 24h volume");
  const arb = await h("options-volume")({ chain: "arbitrum" });
  ok(arb.count === 1 && arb.protocols[0].slug === "hegic", "options-volume: chain filter");
}

// ----------------------------------------------------------------------------
// HIP-3 builder-deployed perp dexs (2026-09-18)
// ----------------------------------------------------------------------------
{
  // perp-dexs: the null native-dex slot is not a row; auction is shaped.
  calls.length = 0;
  const out = await h("perp-dexs")({});
  ok(out.count === 2 && out.dexs.map((d) => d.dex).join(",") === "xyz,flx", `perp-dexs: the null at index 0 is not a row (${out.count} rows)`);
  const xyz = out.dexs[0];
  ok(xyz.fullName === "XYZ" && xyz.deployer === "0x88806a71d74ad0a510b350545c9ae490912f0888" && xyz.oracleUpdater === null && xyz.feeRecipient.startsWith("0x83ff"), "perp-dexs: identity fields ride through, an absent oracleUpdater reads null");
  ok(xyz.assetsWithOiCap === 2 && xyz.totalStreamingOiCapUsd === 300000000 && xyz.subDeployers === 1 && xyz.fundingMultipliers === 1, "perp-dexs: streaming OI caps are counted and summed, sub-deployers and multipliers counted");
  ok(out.dexs[1].assetsWithOiCap === 0 && out.dexs[1].totalStreamingOiCapUsd === null && out.dexs[1].subDeployers === null, "perp-dexs: a dex with no caps reads a null total (never a fabricated 0) and an absent subDeployers reads null");
  ok(out.deployAuction.startTime === "2026-09-18T11:00:00.000Z" && out.deployAuction.endTime === "2026-09-19T18:00:00.000Z" && out.deployAuction.startGas === 500 && out.deployAuction.currentGas === null && out.deployAuction.active === false, "perp-dexs: the deploy auction is shaped and a null currentGas reads inactive");
  ok(calls.filter((c) => c.url === __test.HL_INFO).length === 3, "perp-dexs: exactly three info reads (perpDexs + perpDeployAuctionStatus + allPerpMetas)");
  ok(xyz.markets === 3 && xyz.activeMarkets === 2 && xyz.delistedMarkets === 1, "perp-dexs: market counts are read from allPerpMetas by coin prefix (active vs delisted)");
  ok(out.dexs[1].markets === 1 && out.dexs[1].activeMarkets === 0 && out.dexs[1].delistedMarkets === 1, "perp-dexs: a wound-down dex reads 1 market, 0 active, 1 delisted");
  mode = "no-all-metas";
  const noMetas = await h("perp-dexs")({});
  ok(noMetas.count === 2 && noMetas.dexs[0].markets === null && noMetas.dexs[0].deployer === xyz.deployer, "perp-dexs: an unreadable allPerpMetas leaves the rows with null counts, never fails the call");
  mode = "ok";

  // perp-dex-markets on a wound-down dex: an honest empty, never a hollow 200.
  const dead = await h("perp-dex-markets")({ dex: "dead" });
  ok(dead.count === 0 && dead.totalMarkets === 0 && dead.delistedMarkets === 1 && /delisted/.test(dead.note) && dead.collateralToken === 360, "perp-dex-markets: a dex whose every market is delisted says so (note + delistedMarkets), count 0");

  // perp-dex-markets: dex-scoped metaAndAssetCtxs through the perp-markets shaper + the dex-only fields.
  calls.length = 0;
  const m = await h("perp-dex-markets")({ dex: "XYZ", limit: 5 });
  ok(m.dex === "xyz" && m.collateralToken === 0 && m.totalMarkets === 2 && m.count === 2 && m.delistedMarkets === 1 && m.sort === "volume" && !("note" in m), "perp-dex-markets: dex lowercased, collateral token read, delisted rows dropped and counted, no note on a live dex");
  ok(JSON.parse(calls[0].body).dex === "xyz" && JSON.parse(calls[0].body).type === "metaAndAssetCtxs", "perp-dex-markets: the info call carries the dex");
  const tsla = m.markets[0];
  ok(tsla.coin === "xyz:TSLA" && tsla.markPx === 431.2 && tsla.volume24hUsd === 158407743.45 && tsla.openInterestUsd === 3810620.48 && tsla.funding8h === 0.00005, "perp-dex-markets: the perp-markets row shape (mark, volume, OI usd, 8h funding) on a dex coin");
  ok(tsla.dex === "xyz" && tsla.growthMode === "enabled" && tsla.onlyIsolated === false && tsla.marginMode === null && tsla.deployerFeeScale === 1, "perp-dex-markets: dex-only fields, absent marginMode reads null");
  ok(m.markets[1].coin === "xyz:HOOD" && m.markets[1].onlyIsolated === true && m.markets[1].marginMode === "noCross", "perp-dex-markets: isolated-only + margin mode ride through");
  const byOi = await h("perp-dex-markets")({ dex: "xyz", sort: "openInterest", limit: 1 });
  ok(byOi.count === 1 && byOi.markets[0].coin === "xyz:TSLA", "perp-dex-markets: sort + limit");
  await throws(h("perp-dex-markets")({}), 400, "perp-dex-markets: missing dex");
  await throws(h("perp-dex-markets")({ dex: "not a dex!" }), 400, "perp-dex-markets: malformed dex");
  await throws(h("perp-dex-markets")({ dex: "xyz", sort: "nope" }), 400, "perp-dex-markets: bad sort");
  await throws(h("perp-dex-markets")({ dex: "zzz" }), 422, "perp-dex-markets: unknown dex (HL 500 null) -> 422 naming the dex", /Unknown perp dex "zzz"/);

  // perp-dex-limits: three reads, caps ranked largest first, at-cap coins listed.
  calls.length = 0;
  const l = await h("perp-dex-limits")({ dex: "xyz", limit: 2 });
  ok(l.totalOiCapUsd === 10000000000 && l.oiSzCapPerPerpUsd === 20000000000 && l.maxTransferNtlUsd === 3000000000 && l.totalNetDepositUsd === 1089269477.99, "perp-dex-limits: limits + net deposit are numbers");
  ok(l.totalCoins === 3 && l.count === 2 && l.coinOiCaps[0].coin === "xyz:SP500" && l.coinOiCaps[0].oiCapUsd === 1250000000 && l.coinOiCaps[1].coin === "xyz:AAPL", "perp-dex-limits: per-coin caps ranked largest first and limited");
  ok(l.atOiCap.count === 1 && l.atOiCap.coins[0] === "xyz:HOOD", "perp-dex-limits: coins at their OI cap are listed");
  ok(calls.filter((c) => c.url === __test.HL_INFO).length === 3, "perp-dex-limits: exactly three info reads");
  await throws(h("perp-dex-limits")({ dex: "zzz" }), 422, "perp-dex-limits: unknown dex -> 422");

  // Pure shapers.
  const { shapePerpDex, shapeDeployAuction, pairsToRows, takeDex } = __test;
  ok(JSON.stringify(pairsToRows([["xyz:A", "1.5"], ["xyz:B", null], [null, "2"], "junk"], "cap")) === JSON.stringify([{ coin: "xyz:A", cap: 1.5 }, { coin: "xyz:B", cap: null }]), "pairsToRows: reads [coin, value] pairs, drops malformed rows, keeps a null value as null");
  ok(shapeDeployAuction(null) === null && shapeDeployAuction({}).startTime === null && shapeDeployAuction({ startTimeSeconds: 10, durationSeconds: 5, currentGas: "1.0" }).active === true, "shapeDeployAuction: null in, null out; missing fields read null; a currentGas reads active");
  ok(shapePerpDex({ name: "q" }).assetsWithOiCap === 0 && shapePerpDex({ name: "q" }).totalStreamingOiCapUsd === null, "shapePerpDex: a dex with no cap list reads 0 assets and a null total");
  ok(takeDex(" XYZ ") === "xyz", "takeDex: trims and lowercases");
  for (const bad of [undefined, "", "a b", "x".repeat(13), "x-y"]) { try { takeDex(bad); fail++; console.error(`ASSERT FAIL - takeDex accepted ${JSON.stringify(bad)}`); } catch (e) { ok(e.statusCode === 400, `takeDex refuses ${JSON.stringify(bad)}`); } }
}

// ----------------------------------------------------------------------------
// Pure helpers
// ----------------------------------------------------------------------------
ok(JSON.stringify(__test.parseOptionName("ETH-27MAR26-3000-P")) === JSON.stringify({ underlying: "ETH", expiry: "27MAR26", strike: 3000, type: "put" }), "parseOptionName: option");
ok(__test.parseOptionName("BTC-PERPETUAL") === null && __test.parseOptionName("BTC-26AUG26") === null, "parseOptionName: non-options are null");
ok(__test.parseOptionName("XRP_USDC-26AUG26-0d5-C")?.strike === 0.5, "parseOptionName: decimal strike (0d5)");
ok(__test.expiryToTs("1JAN27") === Date.UTC(2027, 0, 1, 8) && __test.expiryToTs("26XXX26") === null, "expiryToTs: parses + rejects");

// ----------------------------------------------------------------------------
// Upstream failure mapping
// ----------------------------------------------------------------------------
__test.resetMetaCache();
mode = "http500";
await throws(h("perp-markets")({}), 502, "HL 500 -> 502");
await throws(h("options-summary")({}), 502, "Deribit 500 -> 502 (book summary is load-bearing)");
await throws(h("options-ticker")({ instrument: "BTC-PERPETUAL" }), 502, "Deribit 500 -> 502 (ticker)");
await throws(h("options-volume")({}), 502, "DefiLlama 500 -> 502");
mode = "http429";
await throws(h("perp-orderbook")({ coin: "BTC" }), 503, "HL 429 -> 503");
await throws(h("options-volume")({}), 503, "DefiLlama 429 -> 503");
mode = "timeout";
await throws(h("perp-klines")({ coin: "BTC" }), 503, "HL deadline -> 503 naming the upstream and the step");
await throws(h("crypto-options-chain")({}), 503, "Deribit deadline -> 503");
await throws(h("options-volume")({}), 503, "DefiLlama deadline -> 503");
mode = "htmljunk";
await throws(h("perp-markets")({}), 502, "HL non-JSON 200 -> 502");
await throws(h("options-ticker")({ instrument: "BTC-PERPETUAL" }), 502, "Deribit non-JSON 200 -> 502");
await throws(h("options-volume")({}), 502, "DefiLlama non-JSON 200 -> 502");
mode = "hl-unknown-500";
__test.resetMetaCache();
await throws(h("perp-klines")({ coin: "ZZZZ" }), 422, "HL 500 \"null\" (unknown coin) -> 422, not 502");
mode = "hl-unknown-200";
await throws(h("perp-orderbook")({ coin: "ZZZZ" }), 422, "HL 200 \"null\" (unknown coin) -> 422");
mode = "ok";
__test.resetMetaCache();
await throws(h("perp-funding")({ coin: "ZZZZ" }), 422, "unknown coin rejected against the universe -> 422", /Unknown perp market/);
mode = "deribit-invalid";
await throws(h("options-summary")({ currency: "ZZZ" }), 422, "Deribit invalid params -> 422", /invalid currency/);
mode = "deribit-weird-reason";
try { await h("crypto-options-chain")({}); fail++; console.error("ASSERT FAIL - weird reason did not throw"); }
catch (e) {
  ok(e.statusCode === 422 && !/script|SECRET/.test(e.message) && /invalid params/.test(e.message), `Deribit error body never relayed verbatim (${e.message})`);
}
mode = "ok";

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
