// Lending-rates-kit: supply and borrow rates read from the lending contracts
// themselves. No market-data vendor: each answer is two eth_call reads of
// public contract state through chain-kit's transport (the keyed node first
// when one is configured, then keyless public nodes, under that kit's
// deadlines and the keyed provider's daily ceiling).
//
//   lending-rates  Aave v3 and Compound v3 supply and borrow rates for the
//                  major assets on one network, with the gap between the two
//                  protocols per asset
//
// BOUNDED READS. Every rate on a network rides one Multicall3 aggregate3 call
// (Aave's getReserveData per asset, each Compound market's getUtilization,
// and the block number); the Compound rates need the utilization first, so a
// second aggregate3 carries getSupplyRate and getBorrowRate. Two eth_calls a
// network, whatever the asset count, and the result is kept for 30 seconds
// in this process, so a poller costs the node two reads a half-minute.
//
// RATE MATH. Aave v3 stores an annual rate in ray (1e27). Compound v3 returns
// a per-second rate scaled 1e18. Both are simple annual rates (APR) once
// scaled; the APY compounds that rate every second, which to nine places is
// exp(apr) - 1. Rewards paid in a protocol's own token are not part of either
// number: these are the base rates the contracts report.
//
// The contract addresses below were each read live on 2026-11-16: every Aave
// reserve answered with a listed aToken, and every Compound market's
// baseToken() returned the asset it is filed under.

import { encodeFunctionData, decodeFunctionResult } from "viem";
import { pickNetwork, publicJsonRpc } from "./chain-kit.js";
import { underBudgetAll, PAYMENT_WINDOW_BUDGET_MS } from "../upstream-deadline.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const AGG3_ABI = [{ type: "function", name: "aggregate3", stateMutability: "payable",
  inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "callData", type: "bytes" }] }],
  outputs: [{ name: "returnData", type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }] }];

// keccak256(signature).slice(0, 4), checked against viem's toFunctionSelector.
const SEL = Object.freeze({
  getReserveData: "0x35ea6a75", // Aave v3 Pool.getReserveData(address)
  getUtilization: "0x7eb71131", // Comet.getUtilization()
  getSupplyRate: "0xd955759d",  // Comet.getSupplyRate(uint256)
  getBorrowRate: "0x9fa83b5a",  // Comet.getBorrowRate(uint256)
  getBlockNumber: "0x42cbb15c", // Multicall3.getBlockNumber()
});

// Aave v3 Pool per network (https://aave.com/docs/resources/addresses).
const AAVE_POOL = Object.freeze({
  ethereum: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  base: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  arbitrum: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  optimism: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  polygon: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
});
// The assets read on Aave, by network: symbol -> token contract.
const AAVE_ASSETS = Object.freeze({
  ethereum: { USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7", DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F", WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" },
  base: { USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", WETH: "0x4200000000000000000000000000000000000006", cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
  arbitrum: { USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", WBTC: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" },
  optimism: { USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", USDT: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", WETH: "0x4200000000000000000000000000000000000006", WBTC: "0x68f180fcCe6836688e9084f035309E29Bf0A2095" },
  polygon: { USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6" },
});
// Compound v3 markets (Comet proxies), by network: base asset -> market
// (https://docs.compound.finance/#networks). Polygon's USDC market holds the
// bridged token, filed as USDC.e.
const COMPOUND_MARKETS = Object.freeze({
  ethereum: { USDC: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", USDT: "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840", WETH: "0xA17581A9E3356d9A858b789D68B4d866e593aE94" },
  base: { USDC: "0xb125E6687d4313864e53df431d5425969c15Eb2F", WETH: "0x46e6b214b524310239732D51387075E0e70970bf" },
  arbitrum: { USDC: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", USDT: "0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07", WETH: "0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486" },
  optimism: { USDC: "0x2e44e174f7D53F0212823acC11C01A11d58c5bCB", USDT: "0x995E394b8B2437aC8Ce61Ee0bC610D617962B214", WETH: "0xE36A30D249f7761327fd973001A32010b521b6Fd" },
  polygon: { "USDC.e": "0xF25212E676D1F7F89Cd72fFEe66158f541246445", USDT: "0xaeB318360f27748Acb200CE616E389A6C9409a07" },
});

const SECONDS_PER_YEAR = 31_536_000;
const RAY = 10n ** 27n;
const WAD = 10n ** 18n;
const round = (v, dp = 4) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(dp));
const pad32 = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const word = (hex, n) => { const s = hex.slice(2 + 64 * n, 2 + 64 * (n + 1)); return s.length === 64 ? BigInt("0x" + s) : null; };
/** A scaled integer rate as a fraction, keeping nine decimal places. */
const fraction = (v, scale) => Number((v * 1_000_000_000n) / scale) / 1e9;
/** APR fraction -> { aprPct, apyPct } with per-second compounding. */
const rates = (apr) => ({ aprPct: round(apr * 100, 4), apyPct: round(Math.expm1(apr) * 100, 4) });

async function aggregate(network, calls) {
  const data = encodeFunctionData({ abi: AGG3_ABI, functionName: "aggregate3", args: [calls.map((c) => ({ target: c.target.toLowerCase(), allowFailure: true, callData: c.callData }))] });
  const hex = await publicJsonRpc(network, "eth_call", [{ to: MULTICALL3, data }, "latest"]);
  let rows;
  try { rows = decodeFunctionResult({ abi: AGG3_ABI, functionName: "aggregate3", data: hex }); }
  catch { throw bad("Chain RPC returned a result that does not decode", 502); }
  if (!Array.isArray(rows) || rows.length !== calls.length) throw bad("Chain RPC returned a result of the wrong length", 502);
  return rows;
}

// --- one network's markets, read at most once per CACHE_MS -------------------
const CACHE_MS = 30_000;
const cache = new Map(); // network name -> { at, value }
const inflight = new Map();
export function clearLendingRatesCache() { cache.clear(); inflight.clear(); }

async function readNetwork(network) {
  const aave = Object.entries(AAVE_ASSETS[network.name]);
  const comp = Object.entries(COMPOUND_MARKETS[network.name]);
  const first = await aggregate(network, [
    { target: MULTICALL3, callData: SEL.getBlockNumber },
    ...aave.map(([, token]) => ({ target: AAVE_POOL[network.name], callData: SEL.getReserveData + pad32(token) })),
    ...comp.map(([, market]) => ({ target: market, callData: SEL.getUtilization })),
  ]);
  // Multicall3 on Arbitrum reports the L1 block, not the chain's own: left out there.
  const blockNumber = first[0].success && network.name !== "arbitrum" ? Number(word(first[0].returnData, 0)) : null;
  const markets = [];
  aave.forEach(([asset, token], k) => {
    const r = first[1 + k];
    // ReserveData words: 0 configuration, 1 liquidityIndex, 2 currentLiquidityRate,
    // 3 variableBorrowIndex, 4 currentVariableBorrowRate, ... 8 aTokenAddress.
    if (!r.success) return;
    const supply = word(r.returnData, 2), borrow = word(r.returnData, 4), aToken = word(r.returnData, 8);
    if (supply == null || borrow == null || !aToken) return; // not a listed reserve
    markets.push({ protocol: "aave-v3", asset, contract: AAVE_POOL[network.name], token, supply: fraction(supply, RAY), borrow: fraction(borrow, RAY), utilization: null });
  });
  const utils = comp.map((_, k) => { const r = first[1 + aave.length + k]; return r.success ? word(r.returnData, 0) : null; });
  const live = comp.map(([asset, market], k) => ({ asset, market, util: utils[k] })).filter((m) => m.util != null);
  if (live.length) {
    const second = await aggregate(network, live.flatMap((m) => [
      { target: m.market, callData: SEL.getSupplyRate + pad32(m.util.toString(16)) },
      { target: m.market, callData: SEL.getBorrowRate + pad32(m.util.toString(16)) },
    ]));
    live.forEach((m, k) => {
      const s = second[2 * k], b = second[2 * k + 1];
      if (!s.success || !b.success) return;
      const supply = word(s.returnData, 0), borrow = word(b.returnData, 0);
      if (supply == null || borrow == null) return;
      markets.push({ protocol: "compound-v3", asset: m.asset, contract: m.market, token: null, supply: fraction(supply * BigInt(SECONDS_PER_YEAR), WAD), borrow: fraction(borrow * BigInt(SECONDS_PER_YEAR), WAD), utilization: fraction(m.util, WAD) });
    });
  }
  if (markets.length === 0) throw bad(`No lending market answered on ${network.name} - try again shortly`, 502);
  return { blockNumber, markets, readAt: new Date().toISOString() };
}

async function networkMarkets(network) {
  const hit = cache.get(network.name);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.value, cached: true };
  let p = inflight.get(network.name);
  if (!p) {
    p = readNetwork(network).then((value) => { cache.set(network.name, { at: Date.now(), value }); return value; });
    inflight.set(network.name, p);
    p.then(() => inflight.delete(network.name), () => inflight.delete(network.name));
  }
  return { ...(await p), cached: false };
}

const NETWORKS = Object.keys(AAVE_POOL);
const ASSET_RE = /^[A-Za-z0-9.]{2,10}$/;

export const LENDING_TOOLS = [
  {
    route: "GET /api/lending-rates",
    name: "Lending rates: Aave v3 and Compound v3",
    slug: "lending-rates", aliases: ["lending-yields", "defi-lending-rates", "aave-rates", "compound-rates", "borrow-rates"],
    category: "crypto",
    price: "$0.005",
    description:
      "Supply and borrow rates for the major assets (USDC, USDT, DAI, WETH, WBTC or cbBTC) on Aave v3 and Compound v3, read from the lending contracts on Ethereum, Base, Arbitrum, Optimism or Polygon at the latest block: supply APY and APR, variable borrow APY and APR, the borrow-to-supply spread, Compound's utilization, and per asset the protocol with the higher supply rate, the one with the lower borrow rate and the gap between the two. Base rates as the contracts report them, without token rewards. Pass `asset` for one asset. Two bounded contract reads per network, kept 30 seconds. Deterministic code over on-chain state, no market-data vendor.",
    tags: ["crypto", "defi", "lending", "yield", "yields", "apy", "borrow-rate", "aave", "compound", "onchain", "stablecoin-yield"],
    discovery: {
      input: { network: "ethereum" },
      inputSchema: {
        properties: {
          network: { type: "string", description: `Network: ${NETWORKS.join(", ")} (default ethereum).` },
          asset: { type: "string", maxLength: 10, description: "Only this asset (USDC, USDT, DAI, WETH, WBTC, cbBTC, USDC.e). Omit for every asset read on the network." },
        },
      },
      output: {
        example: {
          source: "onchain", network: "ethereum", chainId: 1, blockNumber: 26431342, fetchedAt: "2026-11-16T12:00:00.000Z", cached: false,
          count: 2,
          markets: [
            { protocol: "aave-v3", asset: "USDC", supplyApyPct: 4.1231, supplyAprPct: 4.0404, borrowApyPct: 4.8832, borrowAprPct: 4.7677, spreadPct: 0.7601, utilizationPct: null, contract: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" },
            { protocol: "compound-v3", asset: "USDC", supplyApyPct: 3.9105, supplyAprPct: 3.836, borrowApyPct: 4.9712, borrowAprPct: 4.8516, spreadPct: 1.0607, utilizationPct: 90.1199, contract: "0xc3d688B66703497DAA19211EEdff47f25384cdc3" },
          ],
          byAsset: [{ asset: "USDC", protocols: 2, higherSupply: { protocol: "aave-v3", apyPct: 4.1231 }, lowerBorrow: { protocol: "aave-v3", apyPct: 4.8832 }, supplyGapPct: 0.2126, borrowGapPct: 0.088 }],
          method: "base rates from Aave v3 getReserveData and Compound v3 getSupplyRate/getBorrowRate at the latest block; APY compounds the annual rate every second; token rewards not included",
        },
      },
    },
    handler: async (i = {}) => {
      const network = pickNetwork(i.network == null || i.network === "" ? "ethereum" : i.network, "ethereum");
      let asset = null;
      if (i.asset != null && i.asset !== "") {
        if (typeof i.asset !== "string" || !ASSET_RE.test(i.asset.trim())) throw bad('"asset" must be a token symbol such as USDC, WETH or WBTC');
        asset = i.asset.trim().toLowerCase();
      }
      const read = await networkMarkets(network);
      const chosen = asset ? read.markets.filter((m) => m.asset.toLowerCase() === asset) : read.markets;
      if (asset && chosen.length === 0) {
        const have = [...new Set(read.markets.map((m) => m.asset))].join(", ");
        throw bad(`"${i.asset.trim()}" is not one of the assets read on ${network.name} (${have})`, 422);
      }
      const markets = chosen.map((m) => {
        const s = rates(m.supply), b = rates(m.borrow);
        return { protocol: m.protocol, asset: m.asset, supplyApyPct: s.apyPct, supplyAprPct: s.aprPct, borrowApyPct: b.apyPct, borrowAprPct: b.aprPct, spreadPct: round(b.apyPct - s.apyPct, 4), utilizationPct: m.utilization == null ? null : round(m.utilization * 100, 4), contract: m.contract };
      });
      const assets = [...new Set(markets.map((m) => m.asset))];
      const byAsset = assets.map((a) => {
        const rows = markets.filter((m) => m.asset === a);
        const bySupply = [...rows].sort((x, y) => y.supplyApyPct - x.supplyApyPct);
        const byBorrow = [...rows].sort((x, y) => x.borrowApyPct - y.borrowApyPct);
        const two = rows.length > 1;
        return {
          asset: a, protocols: rows.length,
          higherSupply: { protocol: bySupply[0].protocol, apyPct: bySupply[0].supplyApyPct },
          lowerBorrow: { protocol: byBorrow[0].protocol, apyPct: byBorrow[0].borrowApyPct },
          supplyGapPct: two ? round(bySupply[0].supplyApyPct - bySupply[bySupply.length - 1].supplyApyPct, 4) : null,
          borrowGapPct: two ? round(byBorrow[byBorrow.length - 1].borrowApyPct - byBorrow[0].borrowApyPct, 4) : null,
        };
      });
      return {
        source: "onchain", network: network.name, chainId: network.chainId, blockNumber: read.blockNumber, fetchedAt: read.readAt, cached: read.cached,
        count: markets.length, markets, byAsset,
        method: "base rates from Aave v3 getReserveData and Compound v3 getSupplyRate/getBorrowRate at the latest block; APY compounds the annual rate every second; token rewards not included",
      };
    },
  },
];

export const __test = { SEL, AAVE_POOL, AAVE_ASSETS, COMPOUND_MARKETS, MULTICALL3, AGG3_ABI, fraction, rates, word, pad32, CACHE_MS };

// Every handler runs under one budget (src/upstream-deadline.js).
underBudgetAll(LENDING_TOOLS, PAYMENT_WINDOW_BUDGET_MS);
