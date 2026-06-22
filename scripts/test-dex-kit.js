// scripts/test-dex-kit.js
// Offline tests for src/tools/dex-kit.js. No Alchemy key required.
//
// Pattern matches scripts/test-chain-kit.js:
//   • Catalog envelope + input validation always runs (no key, no network).
//   • Pure-CPU math (priceFromSqrt, spotQuote, ABI encode/decode) is tested
//     with known-value vectors from Uniswap V3 documentation.
//   • Live calls are opt-in via DEX_LIVE_TEST=1 (so CI doesn't burn quota).

import { DEX_TOOLS, __test } from "../src/tools/dex-kit.js";

const { priceFromSqrt, spotQuote, slots, decodeUint, decodeInt, decodeAddr, pad32, encAddr, encUint, NETWORKS } = __test;

const h = (slug) => DEX_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
ok(DEX_TOOLS.length === 4, `4 tools exported (got ${DEX_TOOLS.length})`);
for (const t of DEX_TOOLS) {
  ok(typeof t.slug === "string" && t.slug.startsWith("dex-"), `${t.slug}: dex- prefix`);
  ok(t.route?.startsWith("POST /api/"), `${t.slug}: POST /api/ route`);
  ok(t.category === "crypto", `${t.slug}: category=crypto`);
  ok(typeof t.price === "string" && /^\$\d/.test(t.price), `${t.slug}: priced`);
  ok(typeof t.handler === "function", `${t.slug}: has handler`);
  const d = t.discovery;
  ok(d && d.input && d.inputSchema && d.output?.example, `${t.slug}: full discovery envelope`);
}

// ----------------------------------------------------------------------------
// ABI helpers
// ----------------------------------------------------------------------------
ok(pad32("0x1") === "0".repeat(63) + "1", "pad32: 0x1 → 63 zeros + 1");
ok(pad32("ABCD").length === 64, "pad32: produces 64-char output");
ok(encAddr("0x" + "a".repeat(40)).length === 64, "encAddr: 64 chars");
ok(encUint(500) === "0".repeat(61) + "1f4", "encUint(500): hex 1f4 right-aligned");
ok(encUint(3000).endsWith("bb8"), "encUint(3000): hex bb8");

ok(slots("0x" + "a".repeat(128)).length === 2, "slots: splits 256 bytes → 2 slots");
ok(decodeUint("0".repeat(60) + "1234") === 0x1234n, "decodeUint: 0x1234");
ok(decodeAddr("0".repeat(24) + "a".repeat(40)) === "0x" + "a".repeat(40), "decodeAddr: low 20 bytes");
// int24 negative: -1 sign-extended to int256 = 0xff..ff
ok(decodeInt("f".repeat(64)) === -1n, "decodeInt: -1 (all f's)");
ok(decodeInt("0".repeat(63) + "5") === 5n, "decodeInt: 5");

// ----------------------------------------------------------------------------
// V3 math
// ----------------------------------------------------------------------------
// Known vector: sqrtPriceX96 = 2^96 means token1/token0 = 1.0 (raw units).
// With equal decimals, human price = 1.0.
const Q96 = 1n << 96n;
ok(Math.abs(priceFromSqrt(Q96, 18, 18) - 1.0) < 1e-9, "priceFromSqrt: sqrt=2^96, equal decimals → 1.0");

// sqrtPriceX96 = 2 * 2^96 → price_raw = 4, equal decimals → human 4.
ok(Math.abs(priceFromSqrt(Q96 * 2n, 18, 18) - 4.0) < 1e-9, "priceFromSqrt: sqrt=2*2^96 → 4.0");

// Decimals adjustment: token0=18, token1=6 with sqrt=2^96 → raw 1, scaled by 10^12 → 1e12.
ok(priceFromSqrt(Q96, 18, 6) === 1e12, "priceFromSqrt: decimals0=18, decimals1=6 → 1e12");

// Decimals adjustment other direction: token0=6, token1=18 with sqrt=2^96 → 1e-12.
ok(Math.abs(priceFromSqrt(Q96, 6, 18) - 1e-12) < 1e-20, "priceFromSqrt: decimals0=6, decimals1=18 → 1e-12");

// spot quote zeroForOne, no fee, equal decimals: 10 in, price 1.0 → 10 out.
const out1 = spotQuote({ amountIn: 10, sqrtPriceX96: Q96, fee: 0, zeroForOne: true, decimals0: 18, decimals1: 18 });
ok(Math.abs(out1 - 10) < 1e-9, "spotQuote: 10 in @ price 1, no fee → 10 out");

// spot quote with 0.30% fee, price 1.0 → 10 * 0.997 = 9.97
const out2 = spotQuote({ amountIn: 10, sqrtPriceX96: Q96, fee: 3000, zeroForOne: true, decimals0: 18, decimals1: 18 });
ok(Math.abs(out2 - 9.97) < 1e-9, "spotQuote: 10 in @ 0.30% fee → 9.97");

// spot quote !zeroForOne with price 1.0 → still 1:1
const out3 = spotQuote({ amountIn: 10, sqrtPriceX96: Q96, fee: 0, zeroForOne: false, decimals0: 18, decimals1: 18 });
ok(Math.abs(out3 - 10) < 1e-9, "spotQuote: !zeroForOne @ price 1, no fee → 10 out");

// ----------------------------------------------------------------------------
// Input validation — all 4 tools
// ----------------------------------------------------------------------------
async function throws(promise, status, label) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status) { pass++; console.log(`ok - ${label} → ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}, got ${e.statusCode} (${e.message})`); }
  }
}

// dex-pair
await throws(h("dex-pair")({}), 400, "dex-pair: missing tokenA");
await throws(h("dex-pair")({ tokenA: "0x" + "a".repeat(40) }), 400, "dex-pair: missing tokenB");
await throws(h("dex-pair")({ tokenA: "0x" + "a".repeat(40), tokenB: "0x" + "b".repeat(40) }), 400, "dex-pair: missing fee");
await throws(h("dex-pair")({ tokenA: "0x" + "a".repeat(40), tokenB: "0x" + "b".repeat(40), fee: 1234 }), 400, "dex-pair: bad fee");
await throws(h("dex-pair")({ tokenA: "not-an-address", tokenB: "0x" + "b".repeat(40), fee: 500 }), 400, "dex-pair: bad tokenA");
await throws(h("dex-pair")({ tokenA: "0x" + "a".repeat(40), tokenB: "0x" + "b".repeat(40), fee: 500, network: "fakechain" }), 400, "dex-pair: bad network");

// dex-pool
await throws(h("dex-pool")({}), 400, "dex-pool: missing poolAddress");
await throws(h("dex-pool")({ poolAddress: "0xshort" }), 400, "dex-pool: bad poolAddress");
await throws(h("dex-pool")({ poolAddress: "0x" + "a".repeat(40), network: "fakechain" }), 400, "dex-pool: bad network");

// dex-quote
await throws(h("dex-quote")({}), 400, "dex-quote: missing poolAddress");
await throws(h("dex-quote")({ poolAddress: "0x" + "a".repeat(40) }), 400, "dex-quote: missing amountIn");
await throws(h("dex-quote")({ poolAddress: "0x" + "a".repeat(40), amountIn: -5, zeroForOne: true }), 400, "dex-quote: negative amountIn");
await throws(h("dex-quote")({ poolAddress: "0x" + "a".repeat(40), amountIn: 1 }), 400, "dex-quote: missing zeroForOne");
await throws(h("dex-quote")({ poolAddress: "0x" + "a".repeat(40), amountIn: 1, zeroForOne: "yes" }), 400, "dex-quote: bad zeroForOne type");

// ----------------------------------------------------------------------------
// Missing key path — every Alchemy-backed tool returns 503 cleanly
// ----------------------------------------------------------------------------
const stashedKey = process.env.ALCHEMY_API_KEY;
delete process.env.ALCHEMY_API_KEY;
await throws(h("dex-pair")({ tokenA: "0x" + "a".repeat(40), tokenB: "0x" + "b".repeat(40), fee: 500 }), 503, "dex-pair: 503 without key");
await throws(h("dex-pool")({ poolAddress: "0x" + "a".repeat(40) }), 503, "dex-pool: 503 without key");
await throws(h("dex-quote")({ poolAddress: "0x" + "a".repeat(40), amountIn: 1, zeroForOne: true }), 503, "dex-quote: 503 without key");
if (stashedKey) process.env.ALCHEMY_API_KEY = stashedKey;

// dex-top-pools is keyless — doesn't require ALCHEMY_API_KEY. We don't hit
// the live DeFiLlama endpoint in CI (slow + flaky); shape covered in canary.

// ----------------------------------------------------------------------------
// Live live opt-in
// ----------------------------------------------------------------------------
if (process.env.DEX_LIVE_TEST === "1" && process.env.ALCHEMY_API_KEY) {
  console.log("\n--- live tests ---");
  try {
    const pair = await h("dex-pair")({
      tokenA: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      tokenB: "0x4200000000000000000000000000000000000006",
      fee: 500,
      network: "base",
    });
    ok(/^0x[0-9a-f]{40}$/.test(pair.poolAddress), `live dex-pair: USDC/WETH 0.05% base → ${pair.poolAddress}`);
    if (pair.poolAddress !== "0x0000000000000000000000000000000000000000") {
      const pool = await h("dex-pool")({ poolAddress: pair.poolAddress, network: "base" });
      ok(pool.fee === 500, `live dex-pool: fee=500 (got ${pool.fee})`);
      ok(typeof pool.spotPrice_1per0 === "number" && pool.spotPrice_1per0 > 0, `live dex-pool: spot price > 0 (got ${pool.spotPrice_1per0})`);
      const quote = await h("dex-quote")({ poolAddress: pair.poolAddress, amountIn: 1, zeroForOne: true, network: "base" });
      ok(quote.amountOut > 0, `live dex-quote: 1 token0 → ${quote.amountOut} token1`);
    }
  } catch (e) {
    console.error(`LIVE ERR: ${e.message}`);
    fail++;
  }
}

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
