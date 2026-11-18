#!/usr/bin/env node
// The accepts reader (paymentFieldsFromAccepts) and the manifest readers that
// feed it, on seller input that is malformed or unusual: which accept prices
// a row, mainnet-only Stellar and Algorand payees, empty or odd fields,
// network names that collide with Object.prototype keys, hex addresses in
// either case, and a catalogue entry whose `network` is not text. Each row of
// a table is one input and the fields expected from it.
import "./lib/offline-stores.js";
import { paymentFieldsFromAccepts, normaliseManifestTools } from "../src/x402-index.js";
import { priceToMicroUsd } from "../src/price-usd.js";

const BASE = "eip155:8453";
const USDC_ON_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ALGORAND_MAIN = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const ALGORAND_TEST = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const PAYEE = "0x1111111111111111111111111111111111111111";
const ORIGIN = "https://fields.example";

let passed = 0;
const failures = [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function verify(label, actual, expected) {
  if (same(actual, expected)) passed++;
  else failures.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// [label, accepts, { field: expected }] read straight off the result.
const readings = [
  ["USDC on Base prices the row ahead of USDC listed first on another chain",
    [{ network: "eip155:137", amount: "50000", payTo: "0xPOLY", extra: { name: "USD Coin" } },
     { network: BASE, asset: USDC_ON_BASE, amount: "20000", payTo: "0xBASE", extra: { name: "USDC" } }],
    { price: 0.02, networks: ["eip155:137", BASE], payToByNetwork: { [BASE]: "0xBASE", "eip155:137": "0xPOLY" } }], // the pricing payee is recorded first
  ["with no USDC label the first accept prices the row; shorthand networks collapse",
    [{ network: "base", amount: "7000" }, { network: "base", amount: "9000" }],
    { price: 0.007, networks: [BASE] }],
  ["a Stellar testnet payee is never the Stellar payee",
    [{ network: "stellar:testnet", payTo: "GTEST" }], { stellarPayTo: null }],
  ["the mainnet Stellar payee is found after a testnet one",
    [{ network: "stellar:testnet", payTo: "GTEST" }, { network: "stellar:pubnet", payTo: "GMAIN" }], { stellarPayTo: "GMAIN" }],
  ["an Algorand testnet payee is never the Algorand payee",
    [{ network: ALGORAND_TEST, payTo: "TESTADDR" }], { algorandPayTo: null }],
  ["the mainnet Algorand payee is found after a testnet one",
    [{ network: ALGORAND_TEST, payTo: "TESTADDR" }, { network: ALGORAND_MAIN, payTo: "MAINADDR" }], { algorandPayTo: "MAINADDR" }],
  ["an amount given as an object is not a figure", [{ network: BASE, amount: { v: 1 } }], { price: null }],
  // A non-string network names no chain and no payee; the element can still
  // price the row as the first accept.
  ["a numeric network is not a chain", [{ network: 8453, payTo: "0xNUM", amount: "10000" }],
    { networks: [], payToByNetwork: {}, price: 0.01 }],
  ["an object network is not a chain", [{ network: { id: BASE }, payTo: "0xOBJ" }], { networks: [], payToByNetwork: {} }],
  // Empty payee text is no payee, on every network.
  ["an empty Stellar payTo reads as null", [{ network: "stellar:pubnet", payTo: "" }], { stellarPayTo: null, payToByNetwork: {} }],
  ["an empty Algorand payTo reads as null", [{ network: ALGORAND_MAIN, payTo: "" }], { algorandPayTo: null, payToByNetwork: {} }],
  ["an empty Base payTo is not recorded", [{ network: BASE, payTo: "", amount: "1000" }], { payToByNetwork: {} }],
  // `amount` is read only as whole base units; otherwise maxAmountRequired.
  ["a decimal amount gives way to maxAmountRequired", [{ network: BASE, amount: "1.5", maxAmountRequired: "20000" }], { price: 0.02 }],
  ["a negative amount gives way to maxAmountRequired", [{ network: BASE, amount: "-5", maxAmountRequired: "30000" }], { price: 0.03 }],
  ["an object amount gives way to maxAmountRequired", [{ network: BASE, amount: { x: 1 }, maxAmountRequired: "40000" }], { price: 0.04 }],
  ["a missing amount gives way to maxAmountRequired", [{ network: BASE, maxAmountRequired: "50000" }], { price: 0.05 }],
  ["a whole-number amount wins over maxAmountRequired", [{ network: BASE, amount: 10000, maxAmountRequired: "90000" }], { price: 0.01 }],
  ["a non-integer amount with no maxAmountRequired prices nothing", [{ network: BASE, amount: "abc" }], { price: null }],
  // Hex addresses match whatever the case of the prefix and the digits.
  ["Base USDC written with 0X and upper-case digits still scales by 6",
    [{ network: BASE, asset: "0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913", amount: "10000" }], { price: 0.01 }],
];
for (const [label, accepts, want] of readings) {
  const got = paymentFieldsFromAccepts(accepts);
  for (const [field, value] of Object.entries(want)) verify(`${label} [${field}]`, got[field], value);
}

// Network names that are also Object.prototype keys stay plain own keys.
{
  const got = paymentFieldsFromAccepts([
    { network: "constructor", payTo: "P1" },
    { network: "__proto__", payTo: "P2" },
    { network: "toString", payTo: "P3" },
  ]);
  verify("prototype-named networks are listed as written", got.networks, ["constructor", "__proto__", "toString"]);
  verify("each prototype-named network is an own key", ["constructor", "__proto__", "toString"].map((k) => Object.hasOwn(got.payToByNetwork, k)), [true, true, true]);
  verify("the payee map keeps the plain object prototype", Object.getPrototypeOf(got.payToByNetwork) === Object.prototype, true);
  verify("its __proto__ entry is the payee", Object.getOwnPropertyDescriptor(got.payToByNetwork, "__proto__")?.value, "P2");
  const lone = paymentFieldsFromAccepts([{ network: "hasOwnProperty", payTo: "P4" }]);
  verify("an inherited name is not mistaken for a recorded network", lone.payToByNetwork.hasOwnProperty, "P4");
}

// EIP-712 domain: present only when an EVM accept supplies one.
verify("no EVM accept gives no evmDomainByNetwork key",
  Object.hasOwn(paymentFieldsFromAccepts([{ network: "stellar:pubnet", payTo: "GMAIN" }]), "evmDomainByNetwork"), false);
verify("a named Base USDC accept gives its domain name",
  paymentFieldsFromAccepts([{ network: BASE, asset: USDC_ON_BASE, amount: "1", extra: { name: "USD Coin", version: "2" } }]).evmDomainByNetwork?.[BASE]?.name, "USD Coin");

// Inputs that are not a list of accepts read as an empty reading.
const emptyReading = { price: null, networks: [], stellarPayTo: null, algorandPayTo: null, payToByNetwork: {} };
for (const input of [undefined, null, "x", 5, {}, [], [null, 3, "s"]]) {
  verify(`empty reading for ${JSON.stringify(input) ?? "undefined"}`, paymentFieldsFromAccepts(input), emptyReading);
}

// The caller's list is not changed.
{
  const list = [{ network: "base", amount: "10000", payTo: "0xA" }];
  const snapshot = JSON.stringify(list);
  paymentFieldsFromAccepts(list);
  verify("the caller's accepts are untouched", JSON.stringify(list), snapshot);
}

// ---- through the manifest readers ----
const rowsOf = (manifest) => normaliseManifestTools(manifest, ORIGIN);
const chainsOf = (row) => (Array.isArray(row?.networks) ? row.networks : []);

// A catalogue entry whose `network` is not text is neither chained nor
// priced from atomic units, even with a `chain` beside it.
for (const [what, network] of [["a number", 8453], ["an object", { id: BASE }], ["true", true]]) {
  const [row] = rowsOf({ resources: [{ resource: `${ORIGIN}/n`, network, chain: "base", payTo: PAYEE, asset: USDC_ON_BASE, amount: "100000" }] });
  verify(`network as ${what}: no chain`, chainsOf(row), []);
  verify(`network as ${what}: no price`, row?.price ?? null, null);
}
{
  const [row] = rowsOf({ resources: [{ resource: `${ORIGIN}/c`, chain: "base", payTo: PAYEE, asset: USDC_ON_BASE, amount: "100000" }] });
  verify("with no network, a chain field is read", chainsOf(row), [BASE]);
  verify("...and the row is priced from its amount", row?.price, "$0.1");
}

// 0X-prefixed hex addresses are addresses wherever one is matched.
{
  const UPPER_USDC = "0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913";
  const [row] = rowsOf({ payment: { network: "base", asset: UPPER_USDC, pay_to: PAYEE }, endpoints: [{ path: "/u", method: "POST", price: "$0.01" }] });
  verify("an 0X asset in the service block is an address, not a ticker name", row?.evmDomainByNetwork?.[BASE]?.name ?? null, null);
  const UPPER_PAYEE = "0XABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD";
  const [own] = rowsOf({ endpoints: [{ path: "/p", method: "POST", price: "$0.02", payment: { networks: ["base"], payTo: UPPER_PAYEE } }] });
  verify("an 0X payTo fits an EVM network", own?.payToByNetwork?.[BASE], UPPER_PAYEE);
  verify("an 0X token contract in currency marks base units", priceToMicroUsd({ amount: "10000", currency: UPPER_USDC }), 10000);
}

for (const f of failures) console.error(`FAIL ${f}`);
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
