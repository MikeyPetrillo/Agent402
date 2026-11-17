#!/usr/bin/env node
// Behavior checks for the accepts reader (paymentFieldsFromAccepts) that no
// other suite pins: which accept prices a row, the mainnet-only Stellar and
// Algorand receiving addresses, an absent EIP-712 domain key, odd inputs, and
// that the caller's list is left as it was.
import "./lib/offline-stores.js";
import assert from "node:assert/strict";
import { paymentFieldsFromAccepts } from "../src/x402-index.js";

const BASE = "eip155:8453";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ALGO_MAIN = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const ALGO_TEST = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const results = [];
const check = (name, fn) => { try { fn(); results.push([name, null]); } catch (e) { results.push([name, e]); } };

check("a Base USDC accept prices the row even after another chain's USDC", () => {
  const f = paymentFieldsFromAccepts([
    { network: "eip155:137", amount: "50000", payTo: "0xPOLY", extra: { name: "USD Coin" } },
    { network: BASE, asset: BASE_USDC, amount: "20000", payTo: "0xBASE", extra: { name: "USDC" } },
  ]);
  assert.equal(f.price, 0.02);
  assert.deepEqual(f.networks, ["eip155:137", BASE]);
  assert.equal(f.payToByNetwork[BASE], "0xBASE");
  assert.equal(f.payToByNetwork["eip155:137"], "0xPOLY");
});

check("with no USDC-named accept, the first accept prices the row", () => {
  const f = paymentFieldsFromAccepts([{ network: "base", amount: "7000" }, { network: "base", amount: "9000" }]);
  assert.equal(f.price, 0.007);
  assert.deepEqual(f.networks, [BASE]);
});

check("the Stellar address is taken from a mainnet accept only", () => {
  assert.equal(paymentFieldsFromAccepts([{ network: "stellar:testnet", payTo: "GTEST" }]).stellarPayTo, null);
  const f = paymentFieldsFromAccepts([{ network: "stellar:testnet", payTo: "GTEST" }, { network: "stellar:pubnet", payTo: "GMAIN" }]);
  assert.equal(f.stellarPayTo, "GMAIN");
});

check("the Algorand address is taken from a mainnet accept only", () => {
  assert.equal(paymentFieldsFromAccepts([{ network: ALGO_TEST, payTo: "TESTADDR" }]).algorandPayTo, null);
  const f = paymentFieldsFromAccepts([{ network: ALGO_TEST, payTo: "TESTADDR" }, { network: ALGO_MAIN, payTo: "MAINADDR" }]);
  assert.equal(f.algorandPayTo, "MAINADDR");
});

check("no EVM accept: no evmDomainByNetwork key at all", () => {
  const f = paymentFieldsFromAccepts([{ network: "stellar:pubnet", payTo: "GMAIN" }]);
  assert.equal(Object.prototype.hasOwnProperty.call(f, "evmDomainByNetwork"), false);
  const g = paymentFieldsFromAccepts([{ network: BASE, asset: BASE_USDC, amount: "1", extra: { name: "USD Coin", version: "2" } }]);
  assert.equal(g.evmDomainByNetwork?.[BASE]?.name, "USD Coin");
});

check("odd inputs answer an empty reading and never throw", () => {
  for (const input of [undefined, null, "x", 5, {}, [], [null, 3, "s"]]) {
    const f = paymentFieldsFromAccepts(input);
    assert.equal(f.price, null);
    assert.deepEqual(f.networks, []);
    assert.equal(f.stellarPayTo, null);
    assert.equal(f.algorandPayTo, null);
    assert.deepEqual(f.payToByNetwork, {});
  }
  assert.equal(paymentFieldsFromAccepts([{ network: BASE, amount: { v: 1 } }]).price, null);
});

check("the caller's accepts are not changed", () => {
  const list = [{ network: "base", amount: "10000", payTo: "0xA" }];
  const before = JSON.stringify(list);
  paymentFieldsFromAccepts(list);
  assert.equal(JSON.stringify(list), before);
});

let failed = 0;
for (const [name, err] of results) {
  if (err) { failed++; console.error(`FAIL ${name}: ${err.message}`); } else console.log(`ok ${name}`);
}
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
