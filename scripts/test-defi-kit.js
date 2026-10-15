// scripts/test-defi-kit.js
// Offline tests for src/tools/defi-kit.js. No network: globalThis.fetch is
// replaced with a router that answers every DefiLlama endpoint (yields pools
// + chart, protocols, chains, chain TVL history, stablecoins + charts, fees /
// dexs overviews) from fixtures copied from live shapes (2026-08-22), so the
// test pins
//   - the catalog envelope (10 tools, unique slugs, prices, discovery),
//   - input validation (400s) before any egress,
//   - the in-process cache: one fetch per bulk document, concurrent cold
//     callers share one in-flight fetch, TTL expiry refetches, a failed
//     refresh serves the stale copy (marked) inside STALE_MAX and fails past it,
//   - every filter / sort / limit and the trimmed output shapes,
//   - upstream 5xx -> 502, 402 (paywalled) -> 502, 429 -> 503, non-JSON ->
//     502, a deadline -> 503 naming the step, unknown pool/chain/protocol -> 422,
//     and that no upstream body text is ever relayed to the buyer.
// Live coverage is the catalog's answers-its-own-example sweep (test-all.js).

import { DEFI_TOOLS, __test } from "../src/tools/defi-kit.js";

const h = (slug) => DEFI_TOOLS.find((t) => t.slug === slug).handler;
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
const POOL_A = "54e9b138-3146-4c1f-8dce-1cb948f5ef96";
const POOL_B = "6a0fa42d-494e-44d2-adfb-39b3a8eacb5f";
const POOLS = {
  status: "success",
  data: [
    { chain: "Base", project: "aerodrome-slipstream", symbol: "WETH-SAND", tvlUsd: 31431600393, apyBase: 0.00187, apyReward: 0.00128, apy: 0.00315, rewardTokens: ["0x9401"], pool: POOL_B, apyPct1D: -18.3, apyPct7D: -49.9, apyPct30D: -16.6, stablecoin: false, ilRisk: "yes", exposure: "multi", predictions: { predictedClass: "Stable/Up", predictedProbability: 60, binnedConfidence: 1 }, poolMeta: "CL100 - 0.3%", outlier: true, underlyingTokens: ["0x4200", "0xac53"], volumeUsd1d: 3763905.9, volumeUsd7d: 4067917.8, apyMean30d: 47.2 },
    { chain: "Ethereum", project: "sparklend", symbol: "USDS", tvlUsd: 546610322, apyBase: null, apyReward: 3.51122, apy: 3.51122, rewardTokens: ["0xc200"], pool: POOL_A, apyPct1D: -0.04, apyPct7D: 0.5, apyPct30D: -0.05, stablecoin: true, ilRisk: "no", exposure: "single", predictions: { predictedClass: "Stable/Up", predictedProbability: 67 }, poolMeta: "SPK Farming Pool", outlier: false, underlyingTokens: ["0xdC03"], volumeUsd1d: null, volumeUsd7d: null, apyMean30d: 3.2 },
    { chain: "Base", project: "morpho-blue", symbol: "USDC", tvlUsd: 25000000, apyBase: 4.9, apyReward: 1.2, apy: 6.1, rewardTokens: [], pool: "11111111-1111-1111-1111-111111111111", apyPct1D: 0, apyPct7D: 0, apyPct30D: 0, stablecoin: true, ilRisk: "no", exposure: "single", predictions: null, poolMeta: null, outlier: false, underlyingTokens: ["0x8335"], volumeUsd1d: null, volumeUsd7d: null, apyMean30d: 5.8 },
    { chain: "Base", project: "aerodrome-slipstream", symbol: "EURC-USDC", tvlUsd: 2615059, apyBase: 32.1, apyReward: 3.5, apy: 35.6, rewardTokens: ["0x9401"], pool: "22222222-2222-2222-2222-222222222222", stablecoin: true, ilRisk: "yes", exposure: "multi", outlier: false, underlyingTokens: [], apyMean30d: 23.6 },
    { chain: "Optimism", project: "uniswap-v3", symbol: "USDC-WLD", tvlUsd: 23821, apyBase: 12.4, apyReward: null, apy: 12.4, rewardTokens: null, pool: "33333333-3333-3333-3333-333333333333", stablecoin: false, ilRisk: "yes", exposure: "multi", outlier: false },
    { chain: "Ethereum", project: "aave-v3", symbol: "WETH", tvlUsd: 5000, apyBase: 1.9, apyReward: null, apy: 1.9, pool: "44444444-4444-4444-4444-444444444444", stablecoin: false, ilRisk: "no", exposure: "single", outlier: false },
    { chain: "Base", project: "morpho-blue", symbol: "WETH", tvlUsd: 179899854, apyBase: 2.2, apyReward: 0.4, apy: 2.6, pool: "55555555-5555-5555-5555-555555555555", stablecoin: false, ilRisk: "no", exposure: "single", outlier: false },
    { symbol: "BROKEN-ROW-NO-POOL-ID", tvlUsd: 1 },
  ],
};
const CHART = {
  status: "success",
  data: [
    { timestamp: "2026-08-18T23:02:07.561Z", tvlUsd: 543858501, apy: 2.76104, apyBase: 0, apyReward: 2.76104, il7d: null },
    { timestamp: "2026-08-19T23:02:07.561Z", tvlUsd: 543753190, apy: 2.98906, apyBase: 0, apyReward: 2.98906 },
    { timestamp: "2026-08-20T23:02:07.561Z", tvlUsd: 543796221, apy: 3.21793, apyBase: 0, apyReward: 3.21793 },
    { timestamp: "2026-08-21T23:02:07.561Z", tvlUsd: 546663615, apy: 3.68636, apyBase: 0, apyReward: 3.68636 },
    { timestamp: "2026-08-22T23:01:58.916Z", tvlUsd: 546610322, apy: 3.51122, apyBase: null, apyReward: 3.51122 },
  ],
};
const PROTOCOLS = [
  { id: "1599", name: "Aave V3", address: "0x7fc6", symbol: "AAVE", url: "https://aave.com", description: "Earn interest, borrow assets, and build applications", chain: "Multi-Chain", logo: "https://icons.llamao.fi/icons/protocols/aave-v3", audits: "2", gecko_id: null, category: "Lending", chains: ["Ethereum", "Base", "Arbitrum"], twitter: "aave", audit_links: ["https://aave.com/security"], listedAt: 1648776877, parentProtocol: "parent#aave", slug: "aave-v3", tvl: 17023522168, chainTvls: { Ethereum: 12000000000, "Ethereum-borrowed": 9000000000, Base: 514327164, "Base-borrowed": 355317000, Arbitrum: 505028709, borrowed: 9355317000, staking: 12, "Base-staking": 5 }, change_1h: 0.55, change_1d: 1.41, change_7d: 20.5, mcap: 0 },
  { id: "2269", name: "Binance CEX", symbol: "-", url: "https://binance.com", category: "CEX", chains: ["Ethereum", "Bitcoin"], slug: "binance-cex", tvl: 150000000000, chainTvls: { Ethereum: 90000000000, Bitcoin: 60000000000 }, change_1h: 0, change_1d: 0.2, change_7d: 1, mcap: null },
  { id: "182", name: "Lido", symbol: "LDO", url: "https://lido.fi", category: "Liquid Staking", chains: ["Ethereum", "Solana"], slug: "lido", tvl: 23168639477, chainTvls: { Ethereum: 23000000000, Solana: 168639477 }, change_1h: 0.0003, change_1d: 1.45, change_7d: 29.5, mcap: 301182020, gecko_id: "lido-dao", audits: "3", listedAt: 1600000000 },
  { id: "2", name: "Uniswap V3", symbol: "UNI", category: "Dexs", chains: ["Ethereum", "Base", "Arbitrum", "Optimism"], slug: "uniswap-v3", tvl: 3000000000, chainTvls: { Ethereum: 2000000000, Base: 600000000, Arbitrum: 300000000, Optimism: 100000000 }, change_1h: 0.1, change_1d: -0.5, change_7d: 3, mcap: 4000000000, parentProtocol: "parent#uniswap" },
  { id: "5", name: "Morpho Blue", symbol: "MORPHO", category: "Lending", chains: ["Ethereum", "Base"], slug: "morpho-blue", tvl: 9307345237, chainTvls: { Ethereum: 6000000000, Base: 3307345237, "Ethereum-borrowed": 1 }, change_1h: 0.03, change_1d: 1.3, change_7d: 12, mcap: 800000000 },
  { name: "no slug row", tvl: 5 },
];
const CHAINS = [
  { gecko_id: "ethereum", tvl: 48645670928, tokenSymbol: "ETH", cmcId: "1027", name: "Ethereum", chainId: 1 },
  { gecko_id: null, tvl: 5435431217, tokenSymbol: null, cmcId: null, name: "Base", chainId: 8453 },
  { gecko_id: "optimism", tvl: 426854468, tokenSymbol: "OP", cmcId: "11840", name: "OP Mainnet", chainId: 10 },
  { gecko_id: "optimism", tvl: 0, tokenSymbol: "OP", cmcId: "11840", name: "Optimism", chainId: 10 },
  { gecko_id: "binancecoin", tvl: 5531264082, tokenSymbol: "BNB", cmcId: "1839", name: "BSC", chainId: 56 },
];
const HIST_BASE = [{ date: 1787097600, tvl: 4743605826 }, { date: 1787184000, tvl: 4749526555 }, { date: 1787270400, tvl: 5242607753 }, { date: 1787356800, tvl: 5432285625 }];
const HIST_ALL = [{ date: 1787270400, tvl: 84406672120 }, { date: 1787356800, tvl: 86841435021 }];
const HIST_OP = [{ date: 1787270400, tvl: 400531614 }, { date: 1787356800, tvl: 426834732 }];
const circ = (v) => ({ peggedUSD: v });
const STABLES = {
  peggedAssets: [
    { id: "1", name: "Tether", symbol: "USDT", gecko_id: "tether", pegType: "peggedUSD", pegMechanism: "fiat-backed", circulating: circ(183181226868), circulatingPrevDay: circ(183030948691), circulatingPrevWeek: circ(183163921662), circulatingPrevMonth: circ(183156666699), chainCirculating: { Tron: { current: circ(91460004864) }, Ethereum: { current: circ(73510956798) }, BSC: { current: circ(9181746222) }, Base: { current: circ(1) } }, chains: ["Tron", "Ethereum", "BSC", "Base"], price: 0.99976 },
    { id: "2", name: "USD Coin", symbol: "USDC", gecko_id: "usd-coin", pegType: "peggedUSD", pegMechanism: "fiat-backed", circulating: circ(70000000000), circulatingPrevDay: circ(70000000000), circulatingPrevWeek: circ(69000000000), circulatingPrevMonth: circ(65000000000), chainCirculating: { Ethereum: { current: circ(40000000000) }, Base: { current: circ(4000000000) }, Solana: { current: circ(9000000000) } }, chains: ["Ethereum", "Base", "Solana"], price: 0.99988 },
    { id: "50", name: "EURC", symbol: "EURC", gecko_id: "euro-coin", pegType: "peggedEUR", pegMechanism: "fiat-backed", circulating: { peggedEUR: 700000000 }, circulatingPrevDay: { peggedEUR: 690000000 }, circulatingPrevWeek: { peggedEUR: 680000000 }, circulatingPrevMonth: { peggedEUR: 600000000 }, chainCirculating: { Ethereum: { current: { peggedEUR: 500000000 } }, Base: { current: { peggedEUR: 200000000 } } }, chains: ["Ethereum", "Base"], price: 1.17 },
    { id: "12", name: "Neutrino USD", symbol: "USDN", gecko_id: "neutrino", pegType: "peggedUSD", pegMechanism: "algorithmic", circulating: circ(500000), circulatingPrevDay: circ(500000), circulatingPrevWeek: circ(500000), circulatingPrevMonth: circ(500000), chainCirculating: { Waves: { current: circ(500000) } }, chains: ["Waves"], price: 0.02 },
    { id: "77", name: "Typo Mech", symbol: "TYP", pegType: "peggedUSD", pegMechanism: "crytpo-backed", circulating: circ(1000), circulatingPrevDay: circ(1000), circulatingPrevWeek: circ(1000), circulatingPrevMonth: circ(1000), chainCirculating: { Ethereum: { current: circ(1000) } }, chains: ["Ethereum"], price: 1 },
  ],
  chains: [{ totalCirculatingUSD: circ(5930111), name: "Manta" }],
};
const STABLE_CHART_ALL = [
  { date: "1787270400", totalCirculating: { peggedUSD: 307431006074, peggedEUR: 673647475 }, totalCirculatingUSD: { peggedUSD: 307734935324, peggedEUR: 774975617, peggedVAR: 12225459 } },
  { date: "1787356800", totalCirculating: { peggedUSD: 308196096546 }, totalCirculatingUSD: { peggedUSD: 308487484274, peggedEUR: 758568232, peggedVAR: 12260457 } },
];
const STABLE_CHART_ETH = [
  { date: "1787270400", totalCirculatingUSD: { peggedUSD: 148153534765 } },
  { date: "1787356800", totalCirculatingUSD: { peggedUSD: 147655153805 } },
];
const overviewDoc = (chain, rows, totals) => ({
  totalDataChart: [], totalDataChartBreakdown: [], breakdown24h: null, breakdown30d: null,
  chain, allChains: ["Solana", "Ethereum", "Base", "BSC", "OP Mainnet", "Arbitrum"],
  total24h: totals[0], total7d: totals[1], total30d: totals[2], change_1d: 6.68, change_7d: 41.25, change_1m: 33.9,
  protocols: rows,
});
const feeRow = (name, slug, category, chains, t24, t7, t30, extra = {}) => ({ name, displayName: name, module: slug, slug, category, chains, protocolType: "protocol", total24h: t24, total7d: t7, total30d: t30, total1y: t30 * 12, totalAllTime: t30 * 40, change_1d: 0.5, change_7d: -0.03, change_1m: 1.2, ...extra });
const FEES_ALL = overviewDoc(null, [
  feeRow("Tether", "tether", "Stablecoin Issuer", ["Off Chain"], 15900806, 111368600, 481404902),
  feeRow("Ethereum", "ethereum", "Chain", ["Ethereum"], 3000000, 20000000, 90000000, { protocolType: "chain" }),
  feeRow("Hyperliquid Perps", "hyperliquid-perps", "Derivatives", ["Hyperliquid L1"], 5973270, 18745846, 51267364),
  feeRow("Uniswap V3", "uniswap-v3", "Dexs", ["Ethereum", "Base", "Arbitrum"], 2000000, 14000000, 60000000),
], [75393517, 423480844, 1694516049]);
const FEES_REV_ALL = overviewDoc(null, [feeRow("Tether", "tether", "Stablecoin Issuer", ["Off Chain"], 15900806, 111368600, 481404902), feeRow("Uniswap V3", "uniswap-v3", "Dexs", ["Ethereum"], 0, 0, 0)], [41945328, 200000000, 900000000]);
const FEES_REV_OP = overviewDoc("OP Mainnet", [feeRow("EtherFi Cash Liquid", "etherfi-cash-liquid", "Crypto Card Issuer", ["OP Mainnet"], 30000, 200000, 800000), feeRow("Uniswap V3", "uniswap-v3", "Dexs", ["OP Mainnet"], 20000, 100000, 500000)], [80051, 450263, 1855324]);
const DEXS_ALL = overviewDoc(null, [
  feeRow("Uniswap V3", "uniswap-v3", "Dexs", ["Ethereum", "Base", "Arbitrum"], 2000000000, 14000000000, 60000000000),
  feeRow("Aerodrome Slipstream", "aerodrome-slipstream", "Dexs", ["Base"], 822366721, 3177938341, 11111167264),
], [14044733260, 55090170403, 189553895256]);
const DEXS_BASE = overviewDoc("Base", [
  feeRow("Aerodrome Slipstream", "aerodrome-slipstream", "Dexs", ["Base"], 822366721, 3177938341, 11111167264),
  feeRow("Uniswap V3", "uniswap-v3", "Dexs", ["Base"], 400000000, 2800000000, 12000000000),
], [1670535151, 6011352558, 19961165758]);

// ----------------------------------------------------------------------------
// Fetch router. `mode` switches the failure injections; `calls` records egress.
// ----------------------------------------------------------------------------
let mode = "ok";
const calls = [];
const res = (status, body) => ({ status, ok: status < 400, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const SECRET_BODY = "UPSTREAM_SECRET_BODY_TEXT_9f3a";
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push(u);
  ok(opts.signal instanceof AbortSignal, `egress carries an AbortSignal (${u.slice(0, 48)})`);
  ok(String(opts.headers?.["User-Agent"] || "").includes("Agent402"), "egress carries the Agent402 User-Agent");
  if (mode === "timeout") { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; }
  if (mode === "http500") return res(500, SECRET_BODY);
  if (mode === "http402") return res(402, "Upgrade to the paid API plan at https://example.invalid/subscription");
  if (mode === "http429") return res(429, "slow down");
  if (mode === "htmljunk") return res(200, "<html>maintenance</html>");
  if (mode === "slow") await new Promise((r) => setTimeout(r, 30));
  if (u === __test.YIELDS_POOLS) return res(200, POOLS);
  if (u === __test.YIELDS_CHART(POOL_A)) return res(200, CHART);
  if (u === __test.YIELDS_CHART("00000000-0000-0000-0000-000000000000")) return res(200, { status: "success", data: [] });
  if (u.startsWith("https://yields.llama.fi/chart/")) return res(400, JSON.stringify("invalid configID!"));
  if (u === __test.PROTOCOLS) return res(200, PROTOCOLS);
  if (u === __test.CHAINS) return res(200, CHAINS);
  if (u === __test.CHAIN_TVL(null)) return res(200, HIST_ALL);
  if (u === __test.CHAIN_TVL("Base")) return res(200, HIST_BASE);
  if (u === __test.CHAIN_TVL("OP Mainnet")) return res(200, HIST_OP);
  if (u.startsWith("https://api.llama.fi/v2/historicalChainTvl/")) return res(404, "<html><head><title>404 Not Found</title></head></html>");
  if (u === __test.STABLECOINS) return res(200, STABLES);
  if (u === __test.STABLECOIN_CHARTS("all")) return res(200, STABLE_CHART_ALL);
  if (u === __test.STABLECOIN_CHARTS("Ethereum")) return res(200, STABLE_CHART_ETH);
  if (u.startsWith("https://stablecoins.llama.fi/stablecoincharts/")) return res(404, "<html>404</html>");
  if (u === __test.OVERVIEW("fees", null, null)) return res(200, FEES_ALL);
  if (u === __test.OVERVIEW("fees", null, "dailyRevenue")) return res(200, FEES_REV_ALL);
  if (u === __test.OVERVIEW("fees", "OP Mainnet", "dailyRevenue")) return res(200, FEES_REV_OP);
  if (u === __test.OVERVIEW("dexs", null, null)) return res(200, DEXS_ALL);
  if (u === __test.OVERVIEW("dexs", "Base", null)) return res(200, DEXS_BASE);
  if (u.startsWith("https://api.llama.fi/overview/")) return res(500, "Internal server error");
  throw new Error(`unexpected egress in test: ${u}`);
};
const countCalls = (pred) => calls.filter(pred).length;

// ----------------------------------------------------------------------------
// 1. Catalog envelope
// ----------------------------------------------------------------------------
{
  const slugs = DEFI_TOOLS.map((t) => t.slug);
  ok(DEFI_TOOLS.length === 10, `catalog has 10 tools (${DEFI_TOOLS.length})`);
  ok(new Set(slugs).size === slugs.length, "slugs are unique");
  const expected = ["defi-yields", "defi-yield-history", "defi-protocols", "defi-protocol", "defi-chains", "defi-chain-tvl-history", "stablecoins", "stablecoin-supply-history", "defi-fees", "defi-dex-volume"];
  ok(expected.every((s) => slugs.includes(s)), "all expected slugs present");
  ok(!slugs.includes("defi-bridges"), "no bridges tool (endpoint is paywalled upstream)");
  for (const t of DEFI_TOOLS) {
    ok(t.route === `POST /api/${t.slug}`, `${t.slug}: route is POST /api/${t.slug}`);
    ok(t.category === "crypto", `${t.slug}: category crypto`);
    const usd = Number(String(t.price).replace("$", ""));
    ok(usd >= 0.001 && usd <= 0.005, `${t.slug}: price ${t.price} within $0.001-$0.005 (free DefiLlama upstream; the floor is the settlement floor)`);
    ok(typeof t.handler === "function" && t.discovery?.bodyType === "json" && t.discovery.input && t.discovery.inputSchema?.properties && t.discovery.output?.example, `${t.slug}: discovery complete`);
    ok(Array.isArray(t.tags) && t.tags.includes("crypto") && !t.tags.some((g) => /llama/.test(g)), `${t.slug}: tagged by topic, not by upstream`);
    ok(!/\u2014/.test(t.description + t.name), `${t.slug}: no em dash in copy`);
  }
}

// ----------------------------------------------------------------------------
// 2. Validation before egress
// ----------------------------------------------------------------------------
{
  const before = calls.length;
  await throws(h("defi-yields")({ limit: 101 }), 400, "yields limit > 100");
  await throws(h("defi-yields")({ limit: 0 }), 400, "yields limit 0");
  await throws(h("defi-yields")({ sort: "volume" }), 400, "yields bad sort");
  await throws(h("defi-yields")({ chain: "<script>" }), 400, "yields bad chain chars");
  await throws(h("defi-yields")({ project: "Uniswap V3!" }), 400, "yields project must be a slug");
  await throws(h("defi-yields")({ minTvlUsd: -1 }), 400, "yields negative minTvl");
  await throws(h("defi-yields")({ minApy: 10, maxApy: 5 }), 400, "yields maxApy < minApy");
  await throws(h("defi-yields")({ exposure: "both" }), 400, "yields bad exposure");
  await throws(h("defi-yields")({ stablecoinOnly: "yes" }), 400, "yields bad boolean");
  await throws(h("defi-yield-history")({}), 400, "history pool required");
  await throws(h("defi-yield-history")({ pool: "not-a-pool" }), 400, "history pool must be a UUID");
  await throws(h("defi-yield-history")({ pool: POOL_A, limit: 5000 }), 400, "history limit > 3650");
  await throws(h("defi-protocols")({ limit: 1000 }), 400, "protocols limit");
  await throws(h("defi-protocol")({}), 400, "protocol slug required");
  await throws(h("defi-protocol")({ protocol: "Aave V3" }), 400, "protocol must be a slug");
  await throws(h("defi-chains")({ limit: "x" }), 400, "chains limit NaN");
  await throws(h("defi-chain-tvl-history")({ days: 0 }), 400, "chain history days 0");
  await throws(h("stablecoins")({ peg: "US$" }), 400, "stablecoins peg chars");
  await throws(h("stablecoins")({ mechanism: "magic" }), 400, "stablecoins bad mechanism");
  await throws(h("defi-fees")({ metric: "profit" }), 400, "fees bad metric");
  await throws(h("defi-fees")({ type: "everything" }), 400, "fees bad type");
  await throws(h("defi-dex-volume")({ limit: 101 }), 400, "dex limit");
  ok(calls.length === before, "no egress on validation failures");
}

// ----------------------------------------------------------------------------
// 3. defi-yields: filters, sort, trimmed rows, cache
// ----------------------------------------------------------------------------
{
  __test.resetCache();
  calls.length = 0;
  const r = await h("defi-yields")({});
  ok(r.source === "defillama-yields" && typeof r.fetchedAt === "string" && r.cached === false, "yields: source/fetchedAt/cached=false on cold miss");
  ok(r.sort === "tvl" && r.filters.minTvlUsd === 10000 && r.filters.excludeOutliers === true, "yields: defaults sort=tvl, minTvl 10000, excludeOutliers");
  // 7 valid rows; outlier (POOL_B) dropped; aave WETH (5000 tvl) under default floor -> 5
  ok(r.matched === 5 && r.count === 5, `yields: default filter leaves 5 rows (${r.matched})`);
  ok(r.pools[0].pool === POOL_A && r.pools[0].tvlUsd === 546610322, "yields: sorted by TVL desc");
  const row = r.pools[0];
  ok(row.stablecoin === true && row.ilRisk === "no" && row.exposure === "single" && row.apyReward === 3.51122 && row.apyBase === null && row.prediction.class === "Stable/Up" && row.prediction.probability === 67 && row.rewardTokens.length === 1, "yields: trimmed row shape");
  ok(!("predictions" in row) && !("mu" in row) && !("sigma" in row), "yields: raw-only fields not relayed");
  ok(countCalls((u) => u === __test.YIELDS_POOLS) === 1, "yields: one /pools fetch");

  const r2 = await h("defi-yields")({ minTvlUsd: 0, excludeOutliers: false, limit: 100 });
  ok(r2.cached === true && r2.fetchedAt === r.fetchedAt, "yields: second call served from cache (same fetchedAt)");
  ok(r2.matched === 7, `yields: minTvl 0 + outliers gives all 7 valid rows (${r2.matched})`);
  ok(countCalls((u) => u === __test.YIELDS_POOLS) === 1, "yields: still one /pools fetch after cache hit");

  const apy = await h("defi-yields")({ sort: "apy", minTvlUsd: 0, limit: 2 });
  ok(apy.pools[0].symbol === "EURC-USDC" && apy.pools[1].symbol === "USDC-WLD" && apy.count === 2 && apy.matched === 6, "yields: sort=apy desc + limit");

  const chain = await h("defi-yields")({ chain: "base", minTvlUsd: 0 });
  ok(chain.matched === 3 && chain.pools.every((p) => p.chain === "Base"), "yields: chain filter is case-insensitive exact");
  const alias = await h("defi-yields")({ chain: "OP Mainnet", minTvlUsd: 0 });
  ok(alias.matched === 1 && alias.pools[0].chain === "Optimism", "yields: chain alias OP Mainnet -> Optimism");
  const proj = await h("defi-yields")({ project: "morpho", minTvlUsd: 0 });
  ok(proj.matched === 2 && proj.pools.every((p) => p.project === "morpho-blue"), "yields: project substring filter");
  const sym = await h("defi-yields")({ symbol: "usdc", minTvlUsd: 0 });
  ok(sym.matched === 3 && sym.pools.every((p) => /USDC/.test(p.symbol)), "yields: symbol matches any leg (USDC, EURC-USDC, USDC-WLD)");
  const pair = await h("defi-yields")({ symbol: "usdc-eurc", minTvlUsd: 0 });
  ok(pair.matched === 1 && pair.pools[0].symbol === "EURC-USDC", "yields: pair symbol matches legs in any order");
  const stab = await h("defi-yields")({ stablecoinOnly: true, minTvlUsd: 0 });
  ok(stab.matched === 3 && stab.pools.every((p) => p.stablecoin), "yields: stablecoinOnly");
  const minApy = await h("defi-yields")({ minApy: 5, minTvlUsd: 0 });
  ok(minApy.matched === 3, `yields: minApy 5 (${minApy.matched})`);
  const band = await h("defi-yields")({ minApy: 5, maxApy: 20, minTvlUsd: 0 });
  ok(band.matched === 2 && band.pools.every((p) => p.apy >= 5 && p.apy <= 20), "yields: minApy + maxApy band");
  const single = await h("defi-yields")({ exposure: "single", minTvlUsd: 0 });
  ok(single.matched === 4 && single.pools.every((p) => p.exposure === "single"), "yields: exposure single");
  const tvlFloor = await h("defi-yields")({ minTvlUsd: 100000000 });
  ok(tvlFloor.matched === 2, "yields: minTvlUsd floor");
  const none = await h("defi-yields")({ chain: "Narnia" });
  ok(none.matched === 0 && none.count === 0 && Array.isArray(none.pools), "yields: no match is an empty list, not an error");
}

// ----------------------------------------------------------------------------
// 4. Cache behaviour: in-flight dedupe, TTL, stale-serve, stale-expiry
// ----------------------------------------------------------------------------
{
  __test.resetCache();
  calls.length = 0;
  mode = "slow";
  const [a, b, c] = await Promise.all([h("defi-yields")({}), h("defi-yields")({ sort: "apy" }), h("defi-yields")({ chain: "Base" })]);
  mode = "ok";
  ok(countCalls((u) => u === __test.YIELDS_POOLS) === 1, "cache: three concurrent cold callers share ONE /pools fetch");
  ok(a.fetchedAt === b.fetchedAt && b.fetchedAt === c.fetchedAt, "cache: concurrent callers see the same fetchedAt");

  __test.ageCache("pools", __test.CACHE_TTL_MS + 1000);
  const r = await h("defi-yields")({});
  ok(r.cached === false && countCalls((u) => u === __test.YIELDS_POOLS) === 2, "cache: past TTL refetches");

  __test.ageCache("pools", __test.CACHE_TTL_MS + 1000);
  mode = "http500";
  const stale = await h("defi-yields")({});
  mode = "ok";
  ok(stale.stale === true && stale.cached === true && stale.count > 0, "cache: failed refresh inside STALE_MAX serves the stale copy, marked stale:true");
  ok(countCalls((u) => u === __test.YIELDS_POOLS) === 3, "cache: the failed refresh was attempted");

  __test.ageCache("pools", __test.STALE_MAX_MS + 1000);
  mode = "http500";
  await throws(h("defi-yields")({}), 502, "cache: failed refresh past STALE_MAX fails (502)");
  mode = "ok";
  const back = await h("defi-yields")({});
  ok(back.cached === false && back.stale === undefined, "cache: next successful refresh clears stale");
  ok(__test.cacheKeys().includes("pools"), "cache: key registry exposes pools");
}

// ----------------------------------------------------------------------------
// 5. Error mapping (and no upstream body relayed)
// ----------------------------------------------------------------------------
{
  __test.resetCache();
  for (const [m, status, label] of [["timeout", 503, "deadline (503 naming the upstream and the step)"], ["http500", 502, "5xx"], ["http402", 502, "402 paywalled"], ["http429", 503, "429"], ["htmljunk", 502, "non-JSON"]]) {
    mode = m;
    await throws(h("defi-chains")({}), status, `chains on ${label}`);
    await throws(h("defi-yield-history")({ pool: POOL_A }), status, `yield history on ${label}`);
    await throws(h("defi-protocols")({}), status, `protocols on ${label}`);
    await throws(h("stablecoins")({}), status, `stablecoins on ${label}`);
    await throws(h("defi-fees")({}), status, `fees on ${label}`);
    __test.resetCache();
  }
  mode = "http500";
  try { await h("defi-dex-volume")({}); ok(false, "dex 500 threw"); }
  catch (e) { ok(!e.message.includes(SECRET_BODY) && !/subscription/.test(e.message), "no upstream body text relayed to the buyer"); }
  mode = "http402";
  try { await h("defi-dex-volume")({}); ok(false, "dex 402 threw"); }
  catch (e) { ok(e.statusCode === 502 && /paid plan/.test(e.message) && !/example\.invalid/.test(e.message), "402 -> 502 with our own wording, no upstream URL"); }
  mode = "ok";
  __test.resetCache();
}

// ----------------------------------------------------------------------------
// 6. defi-yield-history
// ----------------------------------------------------------------------------
{
  const r = await h("defi-yield-history")({ pool: POOL_A.toUpperCase(), limit: 3 });
  ok(r.pool === POOL_A && r.totalPoints === 5 && r.count === 3, "history: id lowercased, totalPoints, limit slices the most recent");
  ok(r.points[0].date === "2026-08-20" && r.points[2].date === "2026-08-22" && r.points[2].apyBase === null && r.points[2].apyReward === 3.51122, "history: points are date + apy/base/reward/tvl, oldest first");
  ok(r.summary.apy.latest === 3.51122 && r.summary.apy.max === 3.68636 && r.summary.apy.min === 3.21793 && r.summary.tvlUsd.changePct != null, "history: summary latest/min/max/changePct");
  ok(!("il7d" in r.points[0]), "history: raw-only fields dropped");
  const all = await h("defi-yield-history")({ pool: POOL_A });
  ok(all.count === 5, "history: default limit returns everything when shorter than 90");
  await throws(h("defi-yield-history")({ pool: "99999999-9999-9999-9999-999999999999" }), 422, "history: upstream 400 'invalid configID' -> 422", /no yield pool/);
  await throws(h("defi-yield-history")({ pool: "00000000-0000-0000-0000-000000000000" }), 422, "history: empty data -> 422");
}

// ----------------------------------------------------------------------------
// 7. defi-protocols + defi-protocol
// ----------------------------------------------------------------------------
{
  calls.length = 0;
  const r = await h("defi-protocols")({});
  ok(r.source === "defillama-protocols" && r.cached === false, "protocols: source + cold miss");
  ok(r.matched === 4 && r.protocols.every((p) => p.category !== "CEX"), "protocols: CEX excluded by default");
  ok(r.protocols[0].slug === "lido" && r.protocols[0].rank === 2, "protocols: ranked by TVL, rank is the GLOBAL rank (CEX was #1)");
  const aave = r.protocols.find((p) => p.slug === "aave-v3");
  ok(aave.mcapUsd === null && aave.mcapTvl === null, "protocols: mcap 0 reads as null, never mcap/tvl 0");
  ok(aave.parentProtocol === "aave" && aave.chainCount === 3 && aave.symbol === "AAVE", "protocols: parent prefix stripped, chainCount, symbol");
  const lido = r.protocols[0];
  ok(lido.mcapTvl === Number((301182020 / 23168639477).toFixed(4)), "protocols: mcap/tvl computed");
  ok(!("chainTvls" in aave) && !("description" in aave), "protocols: list rows are compact (no chainTvls/description)");
  const cex = await h("defi-protocols")({ includeCex: true });
  ok(cex.matched === 5 && cex.protocols[0].category === "CEX" && cex.protocols[0].rank === 1, "protocols: includeCex");
  const cat = await h("defi-protocols")({ category: "cex" });
  ok(cat.matched === 1 && cat.protocols[0].slug === "binance-cex", "protocols: category CEX explicit (case-insensitive)");
  const lend = await h("defi-protocols")({ category: "Lending", limit: 1 });
  ok(lend.matched === 2 && lend.count === 1 && lend.protocols[0].slug === "aave-v3" && lend.totalTvlUsd === 17023522168 + 9307345237, "protocols: category + limit + totalTvlUsd over matched");
  const base = await h("defi-protocols")({ chain: "base" });
  ok(base.matched === 3 && base.protocols[0].slug === "morpho-blue" && base.protocols[0].chainTvlUsd === 3307345237 && base.filters.chain === "Base", "protocols: chain filter ranks by that chain's TVL and echoes the canonical name");
  ok(base.protocols.every((p) => p.tvlUsd >= p.chainTvlUsd), "protocols: chainTvlUsd <= total tvlUsd");
  const search = await h("defi-protocols")({ search: "uni" });
  ok(search.matched === 1 && search.protocols[0].slug === "uniswap-v3", "protocols: search substring");
  const floor = await h("defi-protocols")({ minTvlUsd: 10000000000 });
  ok(floor.matched === 2, "protocols: minTvlUsd");
  ok(countCalls((u) => u === __test.PROTOCOLS) === 1, "protocols: all of the above from ONE /protocols fetch");

  const p = await h("defi-protocol")({ protocol: "AAVE-V3" });
  ok(p.cached === true && p.protocol.slug === "aave-v3" && p.protocol.rank === 3, "protocol: served from the protocols cache, global rank");
  ok(p.protocol.chainTvls.length === 3 && p.protocol.chainTvls[0].chain === "Ethereum" && p.protocol.chainTvls[0].tvlUsd === 12000000000, "protocol: chainTvls are bare chain keys sorted desc");
  ok(p.protocol.borrowedUsd === 9000000000 + 355317000 + 9355317000 && p.protocol.stakingUsd === 17 && p.protocol.pool2Usd === null, "protocol: borrowed/staking summarised separately, never inside chainTvls");
  ok(p.protocol.url === "https://aave.com" && p.protocol.twitter === "aave" && p.protocol.audits === 2 && p.protocol.auditLinks.length === 1 && p.protocol.listedAt === "2022-04-01" && p.protocol.address === "0x7fc6" && p.protocol.description.length <= 280, "protocol: metadata fields");
  await throws(h("defi-protocol")({ protocol: "aave" }), 422, "protocol: unknown slug -> 422 with suggestions", /did you mean: aave-v3/);
  await throws(h("defi-protocol")({ protocol: "zzzz" }), 422, "protocol: unknown slug without suggestions", /no protocol with slug "zzzz"$/);
  ok(countCalls((u) => u === __test.PROTOCOLS) === 1, "protocol: no extra fetch");
}

// ----------------------------------------------------------------------------
// 8. defi-chains + defi-chain-tvl-history
// ----------------------------------------------------------------------------
{
  calls.length = 0;
  const r = await h("defi-chains")({ limit: 2 });
  const total = CHAINS.reduce((a, c) => a + c.tvl, 0);
  ok(r.totals.chainCount === 5 && r.totals.totalTvlUsd === Number(total.toFixed(2)) && r.matched === 5 && r.count === 2, "chains: totals + limit");
  ok(r.chains[0].name === "Ethereum" && r.chains[0].rank === 1 && r.chains[0].sharePct === Number(((48645670928 / total) * 100).toFixed(4)) && r.chains[0].chainId === 1 && r.chains[0].geckoId === "ethereum", "chains: ranked, sharePct, ids");
  ok(r.chains[1].name === "BSC" && r.chains[1].tokenSymbol === "BNB", "chains: second by TVL");
  const s = await h("defi-chains")({ search: "optimism" });
  ok(s.matched === 2 && s.chains[0].name === "OP Mainnet", "chains: search matches alias (OP Mainnet) and substring");
  const floor = await h("defi-chains")({ minTvlUsd: 1e9 });
  ok(floor.matched === 3, "chains: minTvlUsd");

  const all = await h("defi-chain-tvl-history")({});
  ok(all.chain === "all" && all.totalPoints === 2 && all.points[1].date === "2026-08-22" && all.points[1].tvlUsd === 86841435021, "chain history: default is all-DeFi from the bare endpoint");
  ok(calls.includes(__test.CHAIN_TVL(null)), "chain history: bare URL used for all");
  const base = await h("defi-chain-tvl-history")({ chain: "base", days: 2 });
  ok(base.chain === "Base" && base.count === 2 && base.totalPoints === 4 && base.points[0].date === "2026-08-21" && base.summary.changePct === Number((((5432285625 - 5242607753) / 5242607753) * 100).toFixed(4)), "chain history: canonical name, days slices the most recent, summary change");
  ok(calls.includes(__test.CHAIN_TVL("Base")), "chain history: chain resolved to DefiLlama's spelling in the URL");
  const op = await h("defi-chain-tvl-history")({ chain: "optimism", days: 1 });
  ok(op.chain === "OP Mainnet" && calls.includes(__test.CHAIN_TVL("OP Mainnet")), "chain history: alias optimism -> OP Mainnet (the TVL-bearing row)");
  await throws(h("defi-chain-tvl-history")({ chain: "Narnia" }), 422, "chain history: unknown chain -> 422 before any history fetch", /lists no chain/);
  ok(!calls.some((u) => u.includes("Narnia")), "chain history: unknown chain never reaches the history endpoint");
  ok(countCalls((u) => u === __test.CHAINS) === 1, "chains: one /v2/chains fetch across chains + history calls");
}

// ----------------------------------------------------------------------------
// 9. stablecoins + stablecoin-supply-history
// ----------------------------------------------------------------------------
{
  calls.length = 0;
  const r = await h("stablecoins")({});
  ok(r.filters.peg === "USD" && r.matched === 4 && r.stablecoins[0].symbol === "USDT" && r.stablecoins[0].rank === 1, "stablecoins: default peg USD, ranked by supply");
  const usdt = r.stablecoins[0];
  ok(usdt.circulating === 183181226868 && usdt.circulatingUsd === 183181226868 && usdt.pegCurrency === "USD" && usdt.pegMechanism === "fiat-backed" && usdt.price === 0.99976, "stablecoins: supply + peg fields");
  ok(usdt.pegDeviationPct === Number(((0.99976 - 1) * 100).toFixed(4)), "stablecoins: USD peg deviation from price");
  ok(usdt.change1dPct === Number((((183181226868 - 183030948691) / 183030948691) * 100).toFixed(4)) && usdt.change7dPct != null && usdt.change30dPct != null, "stablecoins: 1d/7d/30d supply change");
  ok(usdt.chainCount === 4 && usdt.chains[0].chain === "Tron" && usdt.chains.length <= 8 && !("chainCirculating" in usdt), "stablecoins: per-chain list sorted, capped, raw map not relayed");
  ok(r.totals.circulatingUsd === Number((183181226868 + 70000000000 + 500000 + 1000).toFixed(2)) && r.totals.assetCount === 4, "stablecoins: totals over matched");
  const typo = r.stablecoins.find((s) => s.symbol === "TYP");
  ok(typo.pegMechanism === "crypto-backed", "stablecoins: upstream 'crytpo-backed' typo normalised");
  const eur = await h("stablecoins")({ peg: "eur" });
  ok(eur.matched === 1 && eur.stablecoins[0].symbol === "EURC" && eur.stablecoins[0].circulating === 700000000 && eur.stablecoins[0].circulatingUsd === 700000000 * 1.17 && eur.stablecoins[0].pegDeviationPct === null, "stablecoins: EUR peg, USD value via price, no USD peg deviation");
  const everything = await h("stablecoins")({ peg: "all" });
  ok(everything.matched === 5 && everything.filters.peg === null, "stablecoins: peg all");
  const algo = await h("stablecoins")({ mechanism: "algorithmic" });
  ok(algo.matched === 1 && algo.stablecoins[0].symbol === "USDN", "stablecoins: mechanism filter");
  const base = await h("stablecoins")({ chain: "base" });
  ok(base.matched === 2 && base.stablecoins[0].symbol === "USDC" && base.stablecoins[0].chainCirculating === 4000000000 && base.filters.chain === "Base", "stablecoins: chain filter ranks by on-chain circulation");
  const search = await h("stablecoins")({ search: "coin" });
  ok(search.matched === 1 && search.stablecoins[0].symbol === "USDC", "stablecoins: search by name");
  ok(countCalls((u) => u === __test.STABLECOINS) === 1, "stablecoins: one fetch for all of the above");

  const hist = await h("stablecoin-supply-history")({ days: 1 });
  ok(hist.chain === "all" && hist.peg === "USD" && hist.totalPoints === 2 && hist.count === 1 && hist.points[0].circulatingUsd === 308487484274 && hist.points[0].date === "2026-08-22", "stablecoin history: default all/USD, most recent");
  const allPegs = await h("stablecoin-supply-history")({ peg: "all" });
  ok(allPegs.peg === "all" && allPegs.points[1].circulatingUsd === 308487484274 + 758568232 + 12260457, "stablecoin history: peg all sums every peg's USD value");
  const eth = await h("stablecoin-supply-history")({ chain: "ethereum" });
  ok(eth.chain === "Ethereum" && eth.points[1].circulatingUsd === 147655153805 && calls.includes(__test.STABLECOIN_CHARTS("Ethereum")), "stablecoin history: chain resolved to DefiLlama's spelling");
  ok(eth.summary.changePct === Number((((147655153805 - 148153534765) / 148153534765) * 100).toFixed(4)), "stablecoin history: summary change");
  await throws(h("stablecoin-supply-history")({ chain: "Narnia" }), 422, "stablecoin history: unknown chain -> 422", /no stablecoin data for chain/);
}

// ----------------------------------------------------------------------------
// 10. defi-fees + defi-dex-volume (overview tools)
// ----------------------------------------------------------------------------
{
  calls.length = 0;
  const r = await h("defi-fees")({});
  ok(r.source === "defillama-fees" && r.metric === "fees" && r.unit === "USD" && r.chain === null, "fees: envelope");
  ok(r.totals.total24hUsd === 75393517 && r.totals.change1dPct === 6.68 && Array.isArray(r.chains) && r.chains.includes("Base"), "fees: sector totals + chains list");
  ok(r.matched === 3 && r.protocols.every((p) => p.protocolType === "protocol"), "fees: chain-level rows excluded by default type=protocol");
  ok(r.protocols[0].slug === "tether" && r.protocols[0].rank === 1 && r.protocols[0].total24hUsd === 15900806 && r.protocols[0].total7dUsd === 111368600 && r.protocols[0].total30dUsd === 481404902 && r.protocols[0].change7dPct === -0.03 && r.protocols[0].total1yUsd === 481404902 * 12, "fees: ranked by 24h, per-row totals + changes");
  ok(!("breakdown24h" in r.protocols[0]) && !("methodology" in r.protocols[0]), "fees: breakdowns/methodology not relayed");
  const chainRows = await h("defi-fees")({ type: "chain" });
  ok(chainRows.matched === 1 && chainRows.protocols[0].slug === "ethereum", "fees: type=chain selects chain-level rows");
  const allRows = await h("defi-fees")({ type: "all" });
  ok(allRows.matched === 4, "fees: type=all");
  const cat = await h("defi-fees")({ category: "dexs" });
  ok(cat.matched === 1 && cat.protocols[0].slug === "uniswap-v3", "fees: category filter");
  const search = await h("defi-fees")({ search: "hyper" });
  ok(search.matched === 1 && search.protocols[0].slug === "hyperliquid-perps", "fees: search");
  ok(countCalls((u) => u === __test.OVERVIEW("fees", null, null)) === 1, "fees: one global fetch for all of the above");

  const rev = await h("defi-fees")({ metric: "revenue", limit: 1 });
  ok(rev.metric === "revenue" && rev.totals.total24hUsd === 41945328 && rev.count === 1 && calls.includes(__test.OVERVIEW("fees", null, "dailyRevenue")), "fees: metric revenue rides dataType=dailyRevenue");
  const revOp = await h("defi-fees")({ metric: "revenue", chain: "optimism", limit: 5 });
  ok(revOp.chain === "OP Mainnet" && revOp.totals.total24hUsd === 80051 && revOp.matched === 2 && revOp.protocols[0].slug === "etherfi-cash-liquid" && revOp.chains === undefined, "fees: chain scope resolves alias to DefiLlama's name and serves the chain document");
  ok(calls.includes(__test.OVERVIEW("fees", "OP Mainnet", "dailyRevenue")), "fees: chain-scoped URL used");
  await throws(h("defi-fees")({ chain: "Narnia" }), 422, "fees: unknown chain -> 422 via allChains, no scoped fetch", /no fees data for chain/);
  ok(!calls.some((u) => u.includes("Narnia")), "fees: unknown chain never reaches the scoped endpoint");

  const dex = await h("defi-dex-volume")({});
  ok(dex.source === "defillama-dexs" && dex.metric === undefined && Array.isArray(dex.dexs) && dex.dexs[0].slug === "uniswap-v3" && dex.totals.total24hUsd === 14044733260, "dex: global ranking under `dexs`");
  const dexBase = await h("defi-dex-volume")({ chain: "Base", limit: 1 });
  ok(dexBase.chain === "Base" && dexBase.matched === 2 && dexBase.count === 1 && dexBase.dexs[0].slug === "aerodrome-slipstream" && dexBase.totals.total24hUsd === 1670535151, "dex: chain scope");
  ok(calls.includes(__test.OVERVIEW("dexs", "Base", null)), "dex: chain-scoped URL used");
  await throws(h("defi-dex-volume")({ chain: "Narnia" }), 422, "dex: unknown chain -> 422", /no DEX volume data/);
}

// ----------------------------------------------------------------------------
// 11. Pure helpers
// ----------------------------------------------------------------------------
{
  ok(__test.chainMatches("OP Mainnet", "optimism") && __test.chainMatches("Optimism", "op mainnet") && __test.chainMatches("BSC", "binance") && __test.chainMatches("Binance", "bnb chain") && __test.chainMatches("Avalanche", "AVAX") && !__test.chainMatches("Base", "Ethereum"), "chainMatches: alias table");
  const split = __test.splitChainTvls({ Ethereum: 10, "Ethereum-borrowed": 5, borrowed: 5, pool2: 1, "Base-pool2": 2, Base: 0, Polygon: "x" });
  ok(split.chains.length === 1 && split.chains[0].chain === "Ethereum" && split.extras.borrowed === 10 && split.extras.pool2 === 3, "splitChainTvls: pseudo keys out, zero/NaN chains dropped");
  const s = __test.summarisePoints([{ v: 1 }, { v: null }, { v: 3 }], "v");
  ok(s.latest === 3 && s.first === 1 && s.min === 1 && s.max === 3 && s.mean === 2 && s.changePct === 200, "summarisePoints: nulls skipped");
  const empty = __test.summarisePoints([], "v");
  ok(empty.latest === null && empty.changePct === null, "summarisePoints: empty");
  const pool = __test.trimPool({ pool: "x", tvlUsd: "12.5", apy: "abc", rewardTokens: [1, 2, 3, 4, 5, 6, 7], predictions: {} });
  ok(pool.tvlUsd === 12.5 && pool.apy === null && pool.rewardTokens.length === 5 && pool.prediction === null && pool.stablecoin === false, "trimPool: coercion, caps, null prediction");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
