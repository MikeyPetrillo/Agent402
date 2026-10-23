// The USD a request paid on its chain (src/paid-price.js), which sales, hang-up
// debts and charged-failure debts book: a floored or premium chain records what
// moved, every other chain records exactly what it did before (offline).
//
//   node scripts/test-paid-price.js
import assert from "node:assert/strict";

process.env.ROBINHOOD_MIN_PRICE_USD = "0.005";
process.env.NETWORK_PRICE_PREMIUMS = "eip155:10=0.001";
const { paidPriceUsd, signedEvmAmountUsd } = await import("../src/paid-price.js");
const { readFileSync } = await import("node:fs");

const RH = "eip155:4663", BASE = "eip155:8453", OP = "eip155:10", SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const header = (network, value) => Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network, amount: String(value) }, payload: { authorization: { value: String(value) } } })).toString("base64");

let failures = 0;
const check = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); } };

check("a $0.001 tool paid on Robinhood books the floor", () => {
  assert.equal(paidPriceUsd({ basePriceUsd: 0.001, caip2: RH }), 0.005);
  assert.equal(paidPriceUsd({ basePriceUsd: 0.001, caip2: RH, paymentHeader: header(RH, 5000) }), 0.005);
});
check("a tool at or above the floor on Robinhood books its own price", () => {
  assert.equal(paidPriceUsd({ basePriceUsd: 0.07, caip2: RH }), 0.07);
});
check("an Optimism sale books its premium", () => {
  assert.equal(paidPriceUsd({ basePriceUsd: 0.001, caip2: OP }), 0.002);
});
check("a Base sale is unchanged", () => {
  assert.equal(paidPriceUsd({ basePriceUsd: 0.001, caip2: BASE }), 0.001);
  assert.equal(paidPriceUsd({ basePriceUsd: 0.001, caip2: BASE, paymentHeader: header(BASE, 1000) }), 0.001);
});
check("a non-EVM sale with no premium or floor is unchanged", () => {
  assert.equal(paidPriceUsd({ basePriceUsd: 0.005, caip2: SOL }), 0.005);
});
check("a metered Robinhood call books the higher of its quote and the floor", () => {
  assert.equal(paidPriceUsd({ basePriceUsd: 0.0012, caip2: RH }), 0.005);
  assert.equal(paidPriceUsd({ basePriceUsd: 0.03, caip2: RH }), 0.03);
});
check("an upto settle books its metered amount as is", () => {
  assert.equal(paidPriceUsd({ basePriceUsd: 0.02, caip2: BASE, meteredUsd: "0.0034" }), 0.0034);
});
check("the signed EVM amount reads 6-decimal stablecoin units, and only for its own network", () => {
  assert.equal(signedEvmAmountUsd(header(RH, 5000), RH), 0.005);
  assert.equal(signedEvmAmountUsd(header(RH, 5000), BASE), null);
  assert.equal(signedEvmAmountUsd(header(SOL, 5000), SOL), null);
  assert.equal(signedEvmAmountUsd("not base64 json", RH), null);
});
check("no network or no price falls back to the gated price", () => {
  assert.equal(paidPriceUsd({ basePriceUsd: 0.001 }), 0.001);
  assert.equal(paidPriceUsd({ basePriceUsd: 0, caip2: RH }), 0);
});
check("the server books sales, hang-up debts and charged-failure debts through the paid price", () => {
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const live = (re) => (src.match(re) || []).length;
  assert.equal(live(/^\s*priceUsd: paidUsdOf\(def, req, res, decodeSettleReceipt\(settleReceipt\)\?\.network\),/m), 1, "hang-up debt row");
  assert.equal(live(/^\s*\? paidUsdOf\(def, req, res, decodeSettleReceipt\(settleReceipt\)\?\.network\)/m), 1, "sale row");
  assert.equal(live(/^\s*const priceUsd = paidUsdOf\(def, req, res, receipt\?\.network\);/m), 1, "charged-failure debt row");
});

console.log(failures ? `\ntest-paid-price: FAILED (${failures})` : "\ntest-paid-price: all passed");
process.exit(failures ? 1 : 0);
