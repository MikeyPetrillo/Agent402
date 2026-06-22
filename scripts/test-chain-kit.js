// scripts/test-chain-kit.js
// Offline tests for src/tools/chain-kit.js. No Alchemy key required.
//
// Pattern matches scripts/test-search-kit.js:
//   • Deterministic input validation always runs (no key, no network).
//   • Live calls are opt-in via ALCHEMY_LIVE_TEST=1 (so CI doesn't burn quota).
//
// Without ALCHEMY_API_KEY in env, valid-shaped inputs return a 503
// "not configured" error — also asserted here.

import { CHAIN_TOOLS } from "../src/tools/chain-kit.js";

const h = (slug) => CHAIN_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
ok(CHAIN_TOOLS.length === 8, `8 tools exported (got ${CHAIN_TOOLS.length})`);
for (const t of CHAIN_TOOLS) {
  ok(typeof t.slug === "string" && t.slug.length > 0, `${t.slug}: has slug`);
  ok(t.route?.startsWith("POST /api/"), `${t.slug}: POST /api/ route`);
  ok(t.category === "crypto", `${t.slug}: category=crypto`);
  ok(typeof t.price === "string" && /^\$\d/.test(t.price), `${t.slug}: priced`);
  ok(typeof t.handler === "function", `${t.slug}: has handler`);
  const d = t.discovery;
  ok(d && d.input && d.inputSchema && d.output?.example, `${t.slug}: full discovery envelope`);
}

// ----------------------------------------------------------------------------
// Input validation — all 8 tools (no key needed, runs deterministically)
// ----------------------------------------------------------------------------
async function throws(promise, status, label) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status) { pass++; console.log(`ok - ${label} → ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}, got ${e.statusCode} (${e.message})`); }
  }
}

// wallet-balance
await throws(h("wallet-balance")({}), 400, "wallet-balance: missing address");
await throws(h("wallet-balance")({ address: "not-an-address" }), 400, "wallet-balance: bad address");
await throws(h("wallet-balance")({ address: "0x" + "a".repeat(40), network: "fakechain" }), 400, "wallet-balance: bad network");

// token-metadata
await throws(h("token-metadata")({}), 400, "token-metadata: missing contract");
await throws(h("token-metadata")({ contract: "0xshort" }), 400, "token-metadata: bad contract");

// token-price
await throws(h("token-price")({ contract: "nope" }), 400, "token-price: bad contract");

// wallet-transactions
await throws(h("wallet-transactions")({}), 400, "wallet-transactions: missing address");

// nft-holdings
await throws(h("nft-holdings")({}), 400, "nft-holdings: missing address");

// nft-metadata
await throws(h("nft-metadata")({}), 400, "nft-metadata: missing contract");
await throws(h("nft-metadata")({ contract: "0x" + "a".repeat(40) }), 400, "nft-metadata: missing tokenId");
await throws(h("nft-metadata")({ contract: "0x" + "a".repeat(40), tokenId: "" }), 400, "nft-metadata: empty tokenId");

// gas-snapshot
await throws(h("gas-snapshot")({ network: "fakechain" }), 400, "gas-snapshot: bad network");

// eth-call
await throws(h("eth-call")({}), 400, "eth-call: missing method");
await throws(h("eth-call")({ method: "eth_sendTransaction" }), 400, "eth-call: rejects mutating method");
await throws(h("eth-call")({ method: "eth_sendRawTransaction" }), 400, "eth-call: rejects raw broadcast");
await throws(h("eth-call")({ method: "personal_sign" }), 400, "eth-call: rejects non-whitelisted method");

// ----------------------------------------------------------------------------
// 503 path — valid input + no key → "not configured"
// ----------------------------------------------------------------------------
const origKey = process.env.ALCHEMY_API_KEY;
delete process.env.ALCHEMY_API_KEY;
await throws(
  h("wallet-balance")({ address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "base" }),
  503,
  "wallet-balance: valid input, no key → 503"
);
await throws(
  h("gas-snapshot")({ network: "base" }),
  503,
  "gas-snapshot: valid input, no key → 503"
);
await throws(
  h("eth-call")({ method: "eth_blockNumber", network: "base" }),
  503,
  "eth-call: valid input, no key → 503"
);
if (origKey) process.env.ALCHEMY_API_KEY = origKey;

// ----------------------------------------------------------------------------
// Live opt-in — exercises real Alchemy with a real key.
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

if (process.env.ALCHEMY_LIVE_TEST === "1" && process.env.ALCHEMY_API_KEY) {
  const ADDR = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0"; // agent402 receiving wallet
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; // USDC on Base
  await live("wallet-balance", { address: ADDR, network: "base" },
    (r) => r.address === ADDR.toLowerCase() && r.native && Array.isArray(r.tokens), "wallet-balance base");
  await live("token-metadata", { contract: USDC, network: "base" },
    (r) => r.symbol === "USDC" && r.decimals === 6, "token-metadata USDC base");
  await live("token-price", { contract: USDC, network: "base" },
    (r) => typeof r.priceUsd === "number" || r.priceUsd === null, "token-price USDC base");
  await live("gas-snapshot", { network: "base" },
    (r) => typeof r.baseFeeGwei === "number" && r.standard?.totalGwei != null, "gas-snapshot base");
  await live("eth-call", { method: "eth_blockNumber", network: "base" },
    (r) => typeof r.result === "string" && r.result.startsWith("0x"), "eth-call eth_blockNumber base");
}

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed, live: ${liveOk} ok / ${liveErr} err`);
if (fail) process.exit(1);
