import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
// scripts/test-lending-rates-kit.js
// Offline tests for src/tools/lending-rates-kit.js. No network: globalThis.fetch
// is a JSON-RPC stub that decodes each Multicall3 aggregate3 request and
// answers every inner call from a table of rates, so the test pins
//   - the catalog envelope (one tool, price, GET route, no vendor credit),
//   - the selectors and the contract tables (every network has both protocols;
//     addresses are well-formed and distinct),
//   - the rate math: Aave's ray annual rate and Compound's per-second rate
//     both come out as the APR that was put in, and the APY compounds it,
//   - bounded reads: two eth_calls a network whatever the asset count, one of
//     them when no Compound market answers, none inside the cache window,
//   - the comparison per asset, the asset filter, a reserve that is not listed
//     and a market whose call fails being left out, and the refusals.

import { encodeFunctionData, decodeFunctionData, encodeFunctionResult, toFunctionSelector } from "viem";
import { LENDING_TOOLS, clearLendingRatesCache, __test } from "../src/tools/lending-rates-kit.js";
import { METERED_SLUGS } from "../src/metered-slugs.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
const near = (a, b, eps = 1e-3) => typeof a === "number" && Math.abs(a - b) <= eps;
async function throws(promise, status, label, re) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status && (!re || re.test(e.message))) { pass++; console.log(`ok - ${label} -> ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}, got ${e.statusCode} (${e.message})`); }
  }
}
delete process.env.ALCHEMY_API_KEY;
const { SEL, AAVE_POOL, AAVE_ASSETS, COMPOUND_MARKETS, MULTICALL3, AGG3_ABI } = __test;
const tool = LENDING_TOOLS[0];
const h = tool.handler;

// ----------------------------------------------------------------------------
// Catalog envelope and tables
// ----------------------------------------------------------------------------
ok(LENDING_TOOLS.length === 1 && tool.slug === "lending-rates" && tool.route === "GET /api/lending-rates" && tool.price === "$0.005", "one tool: lending-rates, GET, $0.005");
ok(tool.attribution === undefined && tool.credit === undefined && !/CoinGecko/i.test(tool.description) && tool.discovery.output.example.source === "onchain", "contract reads carry no market-data credit");
ok(!/—/.test(tool.description) && /Deterministic code over on-chain state/.test(tool.description) && tool.modelBacked !== true, "description: no em dash, says deterministic code");
ok(!/\b(best|recommend\w*|should|opportunit\w+|safe)\b/i.test(tool.description + JSON.stringify(tool.discovery.output.example)), "no advice wording: the comparison is higher/lower, never best");
ok(!METERED_SLUGS.has("lending-rates") && tool.endsAtCeiling !== true, "keyless public nodes serve it, so it stays in the sweeps; not declared as ending at a run's ceiling");
for (const [name, sig] of [["getReserveData", "getReserveData(address)"], ["getUtilization", "getUtilization()"], ["getSupplyRate", "getSupplyRate(uint256)"], ["getBorrowRate", "getBorrowRate(uint256)"], ["getBlockNumber", "getBlockNumber()"]]) {
  ok(SEL[name] === toFunctionSelector(`function ${sig}`), `selector ${name} is keccak of ${sig}`);
}
const NETS = ["ethereum", "base", "arbitrum", "optimism", "polygon"];
const ADDR = /^0x[0-9a-fA-F]{40}$/;
ok(NETS.every((n) => ADDR.test(AAVE_POOL[n]) && Object.keys(AAVE_ASSETS[n]).length >= 3 && Object.keys(COMPOUND_MARKETS[n]).length >= 2), "every network has an Aave pool, three assets or more, and two Compound markets or more");
ok(NETS.every((n) => [...Object.values(AAVE_ASSETS[n]), ...Object.values(COMPOUND_MARKETS[n])].every((a) => ADDR.test(a))), "every token and market address is well-formed");
ok(NETS.every((n) => { const all = [...Object.values(AAVE_ASSETS[n]), ...Object.values(COMPOUND_MARKETS[n])].map((a) => a.toLowerCase()); return new Set(all).size === all.length; }), "no address is listed twice on a network");
ok(near(__test.rates(0.05).aprPct, 5) && near(__test.rates(0.05).apyPct, 5.1271) && __test.rates(0).apyPct === 0, "APY compounds the APR every second (5% -> 5.1271%)");

// ----------------------------------------------------------------------------
// JSON-RPC stub
// ----------------------------------------------------------------------------
const RAY = 10n ** 27n, WAD = 10n ** 18n, YEAR = 31_536_000n;
const w = (v) => BigInt(v).toString(16).padStart(64, "0");
// table: token (lowercase) -> { supply, borrow } APR fractions on Aave; market
// (lowercase) -> { util, supply, borrow } on Compound. A missing entry fails
// the inner call; `unlisted` answers zeros with no aToken.
let aave = {}, comp = {}, block = 26_431_342n;
const rpcCalls = [];
const frac = (x, scale) => (BigInt(Math.round(x * 1e9)) * scale) / 1_000_000_000n;
function answerInner(target, callData) {
  const t = target.toLowerCase(), sel = callData.slice(0, 10), arg = callData.slice(10);
  if (t === MULTICALL3.toLowerCase() && sel === SEL.getBlockNumber) return { success: true, returnData: `0x${w(block)}` };
  if (sel === SEL.getReserveData) {
    const row = aave[`0x${arg.slice(24)}`];
    if (!row) return { success: false, returnData: "0x" };
    const words = Array.from({ length: 15 }, () => w(0));
    if (!row.unlisted) { words[2] = w(frac(row.supply, RAY)); words[4] = w(frac(row.borrow, RAY)); words[8] = w(0xa70c3n); }
    return { success: true, returnData: `0x${words.join("")}` };
  }
  const m = comp[t];
  if (!m) return { success: false, returnData: "0x" };
  if (sel === SEL.getUtilization) return { success: true, returnData: `0x${w(frac(m.util, WAD))}` };
  if (BigInt(`0x${arg}`) !== frac(m.util, WAD)) return { success: false, returnData: "0x" }; // the rate is asked at the utilization just read
  if (sel === SEL.getSupplyRate) return { success: true, returnData: `0x${w(frac(m.supply, WAD) / YEAR)}` };
  if (sel === SEL.getBorrowRate) return { success: true, returnData: `0x${w(frac(m.borrow, WAD) / YEAR)}` };
  return { success: false, returnData: "0x" };
}
let rpcMode = "ok";
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  rpcCalls.push({ url: String(url), method: body.method, to: body.params?.[0]?.to });
  const res = (obj, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(obj), json: async () => obj });
  if (rpcMode === "revert") return res({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } });
  if (rpcMode === "junk") return res({ jsonrpc: "2.0", id: 1, result: "0x1234" });
  const { args } = decodeFunctionData({ abi: AGG3_ABI, data: body.params[0].data });
  const rows = args[0].map((c) => answerInner(c.target, c.callData));
  return res({ jsonrpc: "2.0", id: 1, result: encodeFunctionResult({ abi: AGG3_ABI, functionName: "aggregate3", result: rows }) });
};
const lower = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toLowerCase()]));
const reset = () => { rpcCalls.length = 0; clearLendingRatesCache(); rpcMode = "ok"; };
ok(typeof encodeFunctionData === "function", "viem encodes the stub's answers");

// ----------------------------------------------------------------------------
// Ethereum: five Aave assets, three Compound markets
// ----------------------------------------------------------------------------
{
  const A = lower(AAVE_ASSETS.ethereum), C = lower(COMPOUND_MARKETS.ethereum);
  aave = { [A.USDC]: { supply: 0.04, borrow: 0.05 }, [A.USDT]: { supply: 0.03, borrow: 0.045 }, [A.DAI]: { supply: 0.02, borrow: 0.06 }, [A.WETH]: { supply: 0.015, borrow: 0.02 }, [A.WBTC]: { supply: 0.0001, borrow: 0.003 } };
  comp = { [C.USDC]: { util: 0.9, supply: 0.045, borrow: 0.048 }, [C.USDT]: { util: 0.88, supply: 0.02, borrow: 0.05 }, [C.WETH]: { util: 0.7, supply: 0.012, borrow: 0.025 } };
  reset();
  const out = await h({});
  ok(rpcCalls.length === 2 && rpcCalls.every((c) => c.method === "eth_call" && c.to === MULTICALL3), `eight markets, two eth_calls, both to Multicall3 (${rpcCalls.length})`);
  ok(out.source === "onchain" && out.network === "ethereum" && out.chainId === 1 && out.blockNumber === 26431342 && out.cached === false && out.count === 8, "default network, chain id, block and count");
  const row = (p, a) => out.markets.find((m) => m.protocol === p && m.asset === a);
  const au = row("aave-v3", "USDC"), cu = row("compound-v3", "USDC");
  ok(near(au.supplyAprPct, 4) && near(au.borrowAprPct, 5) && near(au.supplyApyPct, 4.0811) && near(au.borrowApyPct, 5.1271) && near(au.spreadPct, 5.1271 - 4.0811), "Aave: the ray rate reads back as the APR put in, with APY and the spread");
  ok(near(cu.supplyAprPct, 4.5, 2e-3) && near(cu.borrowAprPct, 4.8, 2e-3) && near(cu.supplyApyPct, 4.6028, 2e-3) && near(cu.utilizationPct, 90), "Compound: the per-second rate reads back as the APR put in, with utilization");
  ok(au.utilizationPct === null && au.contract === AAVE_POOL.ethereum && cu.contract === COMPOUND_MARKETS.ethereum.USDC, "each row names the contract it was read from");
  const usdc = out.byAsset.find((a) => a.asset === "USDC"), weth = out.byAsset.find((a) => a.asset === "WETH"), dai = out.byAsset.find((a) => a.asset === "DAI");
  ok(usdc.protocols === 2 && usdc.higherSupply.protocol === "compound-v3" && usdc.lowerBorrow.protocol === "compound-v3" && near(usdc.supplyGapPct, 4.6028 - 4.0811, 3e-3), "per asset: the protocol with the higher supply rate, the lower borrow rate, and the gap");
  ok(weth.higherSupply.protocol === "aave-v3" && weth.lowerBorrow.protocol === "aave-v3" && near(weth.borrowGapPct, (Math.expm1(0.025) - Math.expm1(0.02)) * 100, 3e-3), "the comparison follows the numbers, either way");
  ok(dai.protocols === 1 && dai.supplyGapPct === null && dai.borrowGapPct === null, "an asset on one protocol has no gap");
  ok(/token rewards not included/.test(out.method), "the method says what the rates leave out");

  const again = await h({ network: "ethereum", asset: "weth" });
  ok(rpcCalls.length === 2 && again.cached === true && again.count === 2 && again.byAsset.length === 1 && again.byAsset[0].asset === "WETH", "an asset filter inside the cache window reads nothing");
  await throws(h({ asset: "DOGE" }), 422, "an asset not read on the network names what is", /USDC, USDT, DAI, WETH, WBTC/);
  await throws(h({ asset: "not a symbol!" }), 400, "a malformed asset");
  await throws(h({ network: "solana" }), 400, "an unsupported network names the supported ones", /ethereum, base/);
  ok(rpcCalls.length === 2, "refusals read nothing");
}

// ----------------------------------------------------------------------------
// Left out, never invented: an unlisted reserve, a failed market, no Compound
// ----------------------------------------------------------------------------
{
  const A = lower(AAVE_ASSETS.base), C = lower(COMPOUND_MARKETS.base);
  aave = { [A.USDC]: { supply: 0.06, borrow: 0.07 }, [A.WETH]: { unlisted: true } }; // cbBTC: the inner call fails
  comp = { [C.USDC]: { util: 0.5, supply: 0.03, borrow: 0.04 } };                     // the WETH market fails
  reset();
  const out = await h({ network: "base" });
  ok(out.count === 2 && out.markets.map((m) => `${m.protocol}:${m.asset}`).join() === "aave-v3:USDC,compound-v3:USDC", "an unlisted reserve and a failed call are left out; the rest answers");
  ok(out.chainId === 8453 && rpcCalls.length === 2, "base: two reads");

  comp = {};
  reset();
  const noComp = await h({ network: "base" });
  ok(noComp.count === 1 && rpcCalls.length === 1, "with no Compound market answering there is no second read");

  aave = {}; comp = {};
  reset();
  await throws(h({ network: "base" }), 502, "no market answering at all is a 502, never an empty 200", /No lending market answered/);
  reset();
  aave = { [A.USDC]: { supply: 0.06, borrow: 0.07 } };
  const after = await h({ network: "base" });
  ok(after.cached === false && after.count === 1, "a failed read was not cached");
}

// Arbitrum's Multicall3 reports the L1 block, so the answer leaves it out.
{
  const A = lower(AAVE_ASSETS.arbitrum);
  aave = { [A.USDC]: { supply: 0.1, borrow: 0.12 } }; comp = {};
  reset();
  const out = await h({ network: "arbitrum" });
  ok(out.blockNumber === null && out.count === 1 && out.chainId === 42161, "arbitrum: block number left out");
}

// Polygon's bridged-USDC market is its own asset.
{
  const A = lower(AAVE_ASSETS.polygon), C = lower(COMPOUND_MARKETS.polygon);
  aave = { [A.USDC]: { supply: 0.03, borrow: 0.06 } };
  comp = { [C["USDC.e"]]: { util: 0.9, supply: 0.0, borrow: 0.17 } };
  reset();
  const out = await h({ network: "polygon" });
  ok(out.byAsset.map((a) => a.asset).join() === "USDC,USDC.e" && out.byAsset.every((a) => a.protocols === 1), "USDC and USDC.e are compared apart");
  const one = await h({ network: "polygon", asset: "usdc.e" });
  ok(one.count === 1 && one.markets[0].supplyApyPct === 0, "the bridged asset is addressable; a zero rate reads zero");
}

// A node's own error and a result that does not decode are 502s.
{
  reset(); rpcMode = "revert";
  await throws(h({ network: "optimism" }), 502, "a node error");
  reset(); rpcMode = "junk";
  await throws(h({ network: "optimism" }), 502, "a result that does not decode", /does not decode/);
}

console.log(`\ntest-lending-rates-kit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
