// scripts/test-contract-kit.js
// Offline tests for src/tools/contract-kit.js. No network required.
//
// Pattern matches scripts/test-chain-kit.js:
//   • Catalog envelope + input validation always run (deterministic).
//   • Pure-CPU handlers (solidity-scan, address-label, calldata-decode with a
//     supplied ABI/signature) are exercised end-to-end offline.
//   • Live upstream calls are opt-in via CONTRACT_LIVE_TEST=1.

import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { CONTRACT_TOOLS, selectorOf, classifyRpcError } from "../src/tools/contract-kit.js";

const h = (slug) => CONTRACT_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
ok(CONTRACT_TOOLS.length === 7, `7 tools exported (got ${CONTRACT_TOOLS.length})`);
const PRICES = {
  "contract-source": "$0.005", "contract-abi": "$0.003", "solidity-scan": "$0.01",
  "calldata-decode": "$0.003", "selector-lookup": "$0.002", "tx-simulate": "$0.005",
  "address-label": "$0.002",
};
for (const t of CONTRACT_TOOLS) {
  ok(typeof t.slug === "string" && t.slug.length > 0, `${t.slug}: has slug`);
  ok(t.route === `POST /api/${t.slug}`, `${t.slug}: POST /api/${t.slug} route`);
  ok(t.category === "crypto", `${t.slug}: category=crypto`);
  ok(t.price === PRICES[t.slug], `${t.slug}: priced ${PRICES[t.slug]} (got ${t.price})`);
  ok(typeof t.handler === "function", `${t.slug}: has handler`);
  const d = t.discovery;
  ok(d && d.input && d.inputSchema && d.output?.example, `${t.slug}: full discovery envelope`);
}

// ----------------------------------------------------------------------------
async function throws(promise, status, label) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status) { pass++; console.log(`ok - ${label} → ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}, got ${e.statusCode} (${e.message})`); }
  }
}
async function returns(promise, check, label) {
  try {
    const r = await promise;
    ok(check(r), `${label}: ${JSON.stringify(r).slice(0, 160)}`);
    return r;
  } catch (e) {
    fail++; console.error(`ASSERT FAIL - ${label}: threw ${e.statusCode} ${e.message}`);
    return null;
  }
}

const ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base

// ----------------------------------------------------------------------------
// Input validation — deterministic, no network
// ----------------------------------------------------------------------------
// contract-source
await throws(h("contract-source")({}), 400, "contract-source: missing address");
await throws(h("contract-source")({ address: "0xshort" }), 400, "contract-source: bad address");
await throws(h("contract-source")({ address: ADDR, network: "fakechain" }), 400, "contract-source: bad network");

// contract-abi
await throws(h("contract-abi")({}), 400, "contract-abi: missing address");
await throws(h("contract-abi")({ address: ADDR, network: "solana" }), 400, "contract-abi: non-EVM network rejected");

// solidity-scan
await throws(h("solidity-scan")({}), 400, "solidity-scan: missing source");
await throws(h("solidity-scan")({ source: "   " }), 400, "solidity-scan: blank source");
await throws(h("solidity-scan")({ source: "x".repeat(513 * 1024) }), 413, "solidity-scan: 512KB cap");

// calldata-decode
await throws(h("calldata-decode")({}), 400, "calldata-decode: missing data");
await throws(h("calldata-decode")({ data: "0xa9" }), 400, "calldata-decode: shorter than a selector");
await throws(h("calldata-decode")({ data: "nothex" }), 400, "calldata-decode: not hex");
await throws(h("calldata-decode")({ data: "0xa9059cbb0" }), 400, "calldata-decode: odd hex digits");
await throws(h("calldata-decode")({ data: "0x" + "a".repeat(200_020) }), 413, "calldata-decode: 100KB cap");
await throws(
  h("calldata-decode")({ data: "0xa9059cbb", signature: "not a signature" }),
  400, "calldata-decode: malformed signature"
);
await throws(
  h("calldata-decode")({ data: "0xdeadbeef", signature: "transfer(address,uint256)" }),
  400, "calldata-decode: signature/selector mismatch"
);
await throws(
  h("calldata-decode")({ data: "0xdeadbeef", abi: [{ type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }] }] }),
  400, "calldata-decode: selector not in supplied ABI"
);

// selector-lookup
await throws(h("selector-lookup")({}), 400, "selector-lookup: missing selector");
await throws(h("selector-lookup")({ selector: "0xa9059c" }), 400, "selector-lookup: wrong length");
await throws(h("selector-lookup")({ selector: "a9059cbb" }), 400, "selector-lookup: missing 0x");

// tx-simulate
await throws(h("tx-simulate")({}), 400, "tx-simulate: missing to");
await throws(h("tx-simulate")({ to: "0xshort" }), 400, "tx-simulate: bad to");
await throws(h("tx-simulate")({ to: ADDR, network: "fakechain" }), 400, "tx-simulate: bad network");
await throws(h("tx-simulate")({ to: ADDR, data: "zzz" }), 400, "tx-simulate: bad data hex");
await throws(h("tx-simulate")({ to: ADDR, value: "not-a-number" }), 400, "tx-simulate: bad value");
await throws(h("tx-simulate")({ to: ADDR, value: "-5" }), 400, "tx-simulate: negative value");
await throws(h("tx-simulate")({ to: ADDR, from: "0xnope" }), 400, "tx-simulate: bad from");

// address-label
await throws(h("address-label")({}), 400, "address-label: missing address");
await throws(h("address-label")({ address: "0x123" }), 400, "address-label: bad address");

// ----------------------------------------------------------------------------
// Pure-CPU behavior — full offline round trips
// ----------------------------------------------------------------------------
// selectorOf: canonical ERC-20 selectors
ok(selectorOf("transfer(address,uint256)") === "0xa9059cbb", "selectorOf: transfer → 0xa9059cbb");
ok(selectorOf("approve(address,uint256)") === "0x095ea7b3", "selectorOf: approve → 0x095ea7b3");
ok(selectorOf("balanceOf(address)") === "0x70a08231", "selectorOf: balanceOf → 0x70a08231");

// solidity-scan: the discovery example fires the expected rules
const scanExample = CONTRACT_TOOLS.find((t) => t.slug === "solidity-scan").discovery.input;
const scan = await returns(h("solidity-scan")(scanExample), (r) => Array.isArray(r.findings) && r.findings.length > 0, "solidity-scan: example yields findings");
if (scan) {
  const rules = new Set(scan.findings.map((f) => f.rule));
  ok(rules.has("tx-origin"), "solidity-scan: flags tx.origin");
  ok(rules.has("unchecked-low-level-call"), "solidity-scan: flags unchecked .call()");
  ok(rules.has("floating-pragma"), "solidity-scan: flags floating pragma");
  ok(rules.has("missing-spdx"), "solidity-scan: flags missing SPDX");
  ok(rules.has("reentrancy-surface"), "solidity-scan: flags value-call reentrancy surface");
  ok(scan.summary.high >= 2, `solidity-scan: summary counts highs (got ${scan.summary.high})`);
  const txo = scan.findings.find((f) => f.rule === "tx-origin");
  ok(txo && txo.line === 4, `solidity-scan: tx-origin anchored to line 4 (got ${txo?.line})`);
  ok(/heuristic/.test(scan.disclaimer) && /not an audit/.test(scan.disclaimer), "solidity-scan: disclaimer present");
}
// Clean source stays clean (checked call, pinned pragma, SPDX)
const clean = await returns(
  h("solidity-scan")({ source: "// SPDX-License-Identifier: MIT\npragma solidity 0.8.24;\ncontract C { function f() external pure returns (uint256) { return 1; } }" }),
  (r) => r.summary.high === 0 && r.summary.medium === 0,
  "solidity-scan: clean source → no high/medium findings"
);
// Checked low-level call downgrades to info, not high
const checked = await returns(
  h("solidity-scan")({ source: "// SPDX-License-Identifier: MIT\npragma solidity 0.8.24;\ncontract C { function f(address a) external { (bool okk,) = a.call(\"\"); require(okk); } }" }),
  (r) => !r.findings.some((f) => f.rule === "unchecked-low-level-call") && r.findings.some((f) => f.rule === "low-level-call" && f.severity === "info"),
  "solidity-scan: checked .call() downgrades to info"
);
void clean; void checked;

// calldata-decode: offline via signature
const XFER = "0xa9059cbb000000000000000000000000abf4fabd7c416fb67202e5f9002389fc75e2a9d000000000000000000000000000000000000000000000000000000000000f4240";
await returns(
  h("calldata-decode")({ data: XFER, signature: "transfer(address,uint256)" }),
  (r) => r.decoded === true && r.source === "provided-signature" &&
    r.params[0].value === "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0" && r.params[1].value === "1000000",
  "calldata-decode: signature decode (address + uint256)"
);
// offline via ABI, with parameter names
await returns(
  h("calldata-decode")({
    data: XFER,
    abi: [{ type: "function", name: "transfer", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }] }],
  }),
  (r) => r.source === "abi" && r.params[0].name === "to" && r.params[1].name === "amount",
  "calldata-decode: ABI decode carries param names"
);
// dynamic types: transferAndCall(address,uint256,bytes)
// 0x4000aea0 = selector of transferAndCall(address,uint256,bytes)
const DYN =
  "0x4000aea0" +
  "000000000000000000000000abf4fabd7c416fb67202e5f9002389fc75e2a9d0" + // to
  "0000000000000000000000000000000000000000000000000000000000000001" + // value 1
  "0000000000000000000000000000000000000000000000000000000000000060" + // offset of bytes
  "0000000000000000000000000000000000000000000000000000000000000004" + // len 4
  "deadbeef00000000000000000000000000000000000000000000000000000000";
await returns(
  h("calldata-decode")({ data: DYN, signature: "transferAndCall(address,uint256,bytes)" }),
  (r) => r.decoded && r.params[2].type === "bytes" && r.params[2].value === "0xdeadbeef",
  "calldata-decode: dynamic bytes param"
);
// string + dynamic array
const STRSEL = selectorOf("f(string,uint256[])");
const STR =
  STRSEL +
  "0000000000000000000000000000000000000000000000000000000000000040" + // offset string
  "0000000000000000000000000000000000000000000000000000000000000080" + // offset array
  "0000000000000000000000000000000000000000000000000000000000000002" + // strlen 2
  "6869000000000000000000000000000000000000000000000000000000000000" + // "hi"
  "0000000000000000000000000000000000000000000000000000000000000002" + // arr len 2
  "0000000000000000000000000000000000000000000000000000000000000007" +
  "000000000000000000000000000000000000000000000000000000000000002a";
await returns(
  h("calldata-decode")({ data: STR, signature: "f(string,uint256[])" }),
  (r) => r.decoded && r.params[0].value === "hi" && Array.isArray(r.params[1].value) &&
    r.params[1].value[0] === "7" && r.params[1].value[1] === "42",
  "calldata-decode: string + uint256[] params"
);
// negative int decodes via two's complement
const NEG = selectorOf("g(int256)") + "f".repeat(64);
await returns(
  h("calldata-decode")({ data: NEG, signature: "g(int256)" }),
  (r) => r.decoded && r.params[0].value === "-1",
  "calldata-decode: int256 two's complement (-1)"
);
// tuple param
const TUP =
  selectorOf("h((address,uint256))") +
  "000000000000000000000000abf4fabd7c416fb67202e5f9002389fc75e2a9d0" +
  "0000000000000000000000000000000000000000000000000000000000000005";
await returns(
  h("calldata-decode")({ data: TUP, signature: "h((address,uint256))" }),
  (r) => r.decoded && Array.isArray(r.params[0].value) && r.params[0].value[1] === "5",
  "calldata-decode: static tuple param"
);
// bool + bytes32
const BB =
  selectorOf("k(bool,bytes32)") +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "aa00000000000000000000000000000000000000000000000000000000000000";
await returns(
  h("calldata-decode")({ data: BB, signature: "k(bool,bytes32)" }),
  (r) => r.decoded && r.params[0].value === true && r.params[1].value.startsWith("0xaa"),
  "calldata-decode: bool + bytes32"
);
// truncated calldata against the declared types → 400, not a crash
await throws(
  h("calldata-decode")({ data: "0xa9059cbb00", signature: "transfer(address,uint256)" }),
  400, "calldata-decode: truncated calldata → 400"
);

// ---- decoder coverage: hand-encoded calldata, expected values are constants
// (never derived from the decoder itself). W() left-pads a hex value to one
// 32-byte word.
const W = (hexVal) => hexVal.padStart(64, "0");

// nested static tuple ((uint8,uint8),uint256) — three flat static words
const NESTED =
  selectorOf("n(((uint8,uint8),uint256))") +
  W("1") + // inner tuple .0 = 1
  W("2") + // inner tuple .1 = 2
  W("4d"); // outer uint256 = 77
await returns(
  h("calldata-decode")({ data: NESTED, signature: "n(((uint8,uint8),uint256))" }),
  (r) => r.decoded && JSON.stringify(r.params[0].value) === '[["1","2"],"77"]',
  "calldata-decode: nested static tuple ((uint8,uint8),uint256)"
);

// dynamic tuple (uint256,bytes) — head offset, then tuple-relative bytes offset
const DYNTUP =
  selectorOf("d((uint256,bytes))") +
  W("20") +   // offset to the tuple
  W("5") +    // .0 = 5
  W("40") +   // offset of bytes, relative to the tuple start
  W("3") +    // bytes length 3
  "abcdef" + "0".repeat(58); // 0xabcdef right-padded to a word
await returns(
  h("calldata-decode")({ data: DYNTUP, signature: "d((uint256,bytes))" }),
  (r) => r.decoded && JSON.stringify(r.params[0].value) === '["5","0xabcdef"]',
  "calldata-decode: dynamic tuple (uint256,bytes)"
);

// bytes[] — array of dynamic elements: len, per-element offsets, then payloads
const BYTESARR =
  selectorOf("b(bytes[])") +
  W("20") +  // offset to the array
  W("2") +   // 2 elements
  W("40") +  // elem 0 offset (relative to the element area)
  W("80") +  // elem 1 offset
  W("1") + "aa" + "0".repeat(62) +  // elem 0 = 0xaa
  W("2") + "bbcc" + "0".repeat(60); // elem 1 = 0xbbcc
await returns(
  h("calldata-decode")({ data: BYTESARR, signature: "b(bytes[])" }),
  (r) => r.decoded && JSON.stringify(r.params[0].value) === '["0xaa","0xbbcc"]',
  "calldata-decode: bytes[] (dynamic array of dynamic elements)"
);

// uint256[2] — fixed static array, two inline words
const FIXARR = selectorOf("a(uint256[2])") + W("7") + W("2a");
await returns(
  h("calldata-decode")({ data: FIXARR, signature: "a(uint256[2])" }),
  (r) => r.decoded && JSON.stringify(r.params[0].value) === '["7","42"]',
  "calldata-decode: uint256[2] fixed array"
);

// fail-safe: bogus dynamic offset (garbage pointer word) → 400, not a crash
await throws(
  h("calldata-decode")({ data: selectorOf("d2(bytes)") + "f".repeat(64), signature: "d2(bytes)" }),
  400, "calldata-decode: bogus dynamic offset → 400"
);
// fail-safe: absurd declared array length (1,048,576 elements) → 400
await throws(
  h("calldata-decode")({ data: selectorOf("d3(uint256[])") + W("20") + W("100000"), signature: "d3(uint256[])" }),
  400, "calldata-decode: absurd declared array length → 400"
);
// fail-safe: dynamic array truncated mid-elements → 400
await throws(
  h("calldata-decode")({ data: selectorOf("t(uint256[])") + W("20") + W("2") + W("7"), signature: "t(uint256[])" }),
  400, "calldata-decode: truncated dynamic array → 400"
);

// ----------------------------------------------------------------------------
// tx-simulate revert classification — pure, offline. A node error only counts
// as the simulation's verdict when it is revert-shaped (or JSON-RPC code 3);
// node-side failures must surface as 502s, never {success:false, revertReason}.
// ----------------------------------------------------------------------------
ok(classifyRpcError("execution reverted: ERC20: transfer amount exceeds balance", -32000) === "revert",
  "classifyRpcError: execution reverted → revert");
ok(classifyRpcError("out of gas", -32000) === "revert", "classifyRpcError: out of gas → revert");
ok(classifyRpcError("insufficient funds for gas * price + value", -32000) === "revert",
  "classifyRpcError: insufficient funds → revert");
ok(classifyRpcError("some ABI-encoded revert payload", 3) === "revert",
  "classifyRpcError: JSON-RPC code 3 → revert regardless of message");
ok(classifyRpcError("rate limit exceeded", -32005) === "error",
  "classifyRpcError: rate limit is a node failure, NOT a revert");
ok(classifyRpcError("the method eth_call does not exist/is not available", -32601) === "error",
  "classifyRpcError: method not found is a node failure, NOT a revert");
ok(classifyRpcError("connection refused", undefined) === "error",
  "classifyRpcError: connection trouble is a node failure, NOT a revert");
ok(classifyRpcError("", undefined) === "error", "classifyRpcError: empty message → error");

// address-label: hits + misses, case-insensitive
await returns(
  h("address-label")({ address: ADDR }),
  (r) => r.found === true && r.labels[0].label === "USDC" && r.labels[0].network === "base" &&
    r.provenance?.updated && r.provenance.entries > 20,
  "address-label: USDC on Base found (checksummed input)"
);
await returns(
  h("address-label")({ address: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" }),
  (r) => r.found && /Uniswap V2/.test(r.labels[0].label) && r.labels[0].category === "router",
  "address-label: Uniswap V2 router labeled"
);
await returns(
  h("address-label")({ address: "0x0000000000000000000000000000000000000000" }),
  (r) => r.found && r.labels[0].category === "system",
  "address-label: zero address labeled system"
);
await returns(
  h("address-label")({ address: "0x1234567890123456789012345678901234567890" }),
  (r) => r.found === false && Array.isArray(r.labels) && r.labels.length === 0,
  "address-label: unknown address → structured miss"
);

// ----------------------------------------------------------------------------
// Live opt-in — exercises the real upstreams (Sourcify / openchain / RPC pool).
// ----------------------------------------------------------------------------
async function live(slug, args, check, label) {
  try {
    const r = await h(slug)(args);
    if (check(r)) { liveOk++; console.log(`ok - LIVE ${label}: ${JSON.stringify(r).slice(0, 140)}`); }
    else { fail++; console.error(`ASSERT FAIL - LIVE ${label}: shape ${JSON.stringify(r).slice(0, 240)}`); }
  } catch (e) {
    liveErr++;
    console.warn(`warn - LIVE ${label}: upstream ${e.statusCode || "?"} ${e.message} — tolerated`);
  }
}

if (process.env.CONTRACT_LIVE_TEST === "1") {
  await live("contract-source", { address: ADDR, network: "base" },
    (r) => r.verified === true && r.sourceCount > 0 && Object.keys(r.sources).length > 0, "contract-source USDC base");
  await live("contract-source", { address: "0x0000000000000000000000000000000000000001", network: "base" },
    (r) => r.verified === false, "contract-source unverified → structured miss");
  await live("contract-abi", { address: ADDR, network: "base" },
    (r) => r.verified === true && Array.isArray(r.abi) && r.functions.length > 0, "contract-abi USDC base");
  await live("selector-lookup", { selector: "0xa9059cbb" },
    (r) => r.found && r.signatures.includes("transfer(address,uint256)"), "selector-lookup transfer");
  await live("calldata-decode", { data: XFER },
    (r) => r.decoded && r.signature === "transfer(address,uint256)" && r.params[1].value === "1000000", "calldata-decode via selector DB");
  await live("tx-simulate", { network: "base", to: ADDR, data: "0x70a08231000000000000000000000000abf4fabd7c416fb67202e5f9002389fc75e2a9d0" },
    (r) => r.success === true && /^0x[0-9a-f]{64}$/.test(r.returnData) && r.gasEstimate > 0, "tx-simulate balanceOf base");
}

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed, live: ${liveOk} ok / ${liveErr} err`);
if (fail) process.exit(1);
