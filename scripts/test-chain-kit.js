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
ok(CHAIN_TOOLS.length === 15, `15 tools exported (got ${CHAIN_TOOLS.length})`);
for (const t of CHAIN_TOOLS) {
  ok(typeof t.slug === "string" && t.slug.length > 0, `${t.slug}: has slug`);
  ok(/^(GET|POST) \/api\//.test(t.route ?? ""), `${t.slug}: GET or POST /api/ route`);
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

// evm-rpc — validation runs before any network egress, so all deterministic
await throws(h("evm-rpc")({}), 400, "evm-rpc: missing method");
await throws(h("evm-rpc")({ method: "eth_sendTransaction" }), 400, "evm-rpc: rejects mutating method");
await throws(h("evm-rpc")({ method: "eth_sendRawTransaction" }), 400, "evm-rpc: rejects raw broadcast");
await throws(h("evm-rpc")({ method: "eth_getLogs" }), 400, "evm-rpc: rejects eth_getLogs (unbounded)");
await throws(h("evm-rpc")({ method: "eth_subscribe" }), 400, "evm-rpc: rejects subscriptions");
await throws(h("evm-rpc")({ method: "personal_sign" }), 400, "evm-rpc: rejects signing");
await throws(h("evm-rpc")({ method: "eth_blockNumber", network: "fakechain" }), 400, "evm-rpc: bad network");
await throws(h("evm-rpc")({ method: "eth_blockNumber", params: "latest" }), 400, "evm-rpc: params must be an array");
await throws(h("evm-rpc")({ method: "eth_blockNumber", params: Array(9).fill("0x0") }), 400, "evm-rpc: params capped at 8 entries");
await throws(h("evm-rpc")({ method: "eth_blockNumber", params: ["0x" + "a".repeat(5000)] }), 400, "evm-rpc: params capped at 4KB serialized");
// Case-insensitive method match: uppercased method resolves (so the failure
// below is the params-shape 400, not the whitelist 400).
try {
  await h("evm-rpc")({ method: "ETH_BLOCKNUMBER", params: "nope" });
  fail++; console.error("ASSERT FAIL - evm-rpc: case-insensitive match (did not throw)");
} catch (e) {
  const isParamsError = e.statusCode === 400 && /must be an array/.test(e.message);
  ok(isParamsError, `evm-rpc: case-insensitive method match (got: ${e.message.slice(0, 60)})`);
}
// The whitelist rejection message must list the allowed methods.
try {
  await h("evm-rpc")({ method: "debug_traceTransaction" });
  fail++; console.error("ASSERT FAIL - evm-rpc: whitelist message (did not throw)");
} catch (e) {
  ok(/eth_blockNumber/.test(e.message) && /net_version/.test(e.message), "evm-rpc: 400 lists allowed methods");
}

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

// ----------------------------------------------------------------------------
// Named chain-read primitives (2026-07-29) — pre-RPC validation, no network.
// ----------------------------------------------------------------------------
await throws(h("block-number")({ network: "solana" }), 400, "block-number: unsupported network rejected");
await throws(h("chain-info")({ network: "nope" }), 400, "chain-info: unsupported network rejected");
await throws(h("block-info")({ block: "not-a-block" }), 400, "block-info: malformed block tag rejected");
await throws(h("erc721-owner")({ contract: "0x123", tokenId: "1" }), 400, "erc721-owner: malformed contract rejected");
await throws(h("erc721-owner")({ contract: "0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85", tokenId: "xyz" }), 400, "erc721-owner: malformed tokenId rejected");
await throws(h("contract-code")({ address: "hello" }), 400, "contract-code: malformed address rejected");
await throws(h("event-logs")({ address: "0x123" }), 400, "event-logs: malformed address rejected");
await throws(h("event-logs")({ address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", topic0: "0xshort" }), 400, "event-logs: malformed topic0 rejected");

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
// Provider refusals fall through to the next public node; a revert does not
// (2026-09-06 rule; the archive-token refusal added 2026-09-10 after the
// nightly corpus 502'd a fixed Ethereum block on publicnode's keyless path).
{
  const { publicJsonRpc } = await import("../src/tools/chain-kit.js");
  const savedKey = process.env.ALCHEMY_API_KEY; delete process.env.ALCHEMY_API_KEY;
  const realFetch = globalThis.fetch;
  const net = { name: "ethereum", subdomain: "eth-mainnet", chainId: 1 };
  const answers = (list) => { let i = 0; return async () => ({ status: 200, text: async () => JSON.stringify(list[Math.min(i++, list.length - 1)]) }); };
  try {
    globalThis.fetch = answers([{ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode" } }, { jsonrpc: "2.0", id: 1, result: { number: "0x10" } }]);
    const r = await publicJsonRpc(net, "eth_getBlockByNumber", ["0x10", false]);
    ok(r?.number === "0x10", "publicnode's archive-token refusal falls through to the next node, which answers");
    globalThis.fetch = answers([{ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted: UNAUTHORIZED" } }, { jsonrpc: "2.0", id: 1, result: "0x" }]);
    let e = null; try { await publicJsonRpc(net, "eth_call", [{}]); } catch (x) { e = x; }
    ok(e && e.rpcCode === 3 && /reverted/.test(e.message), "a revert is an ANSWER and is never retried on another node");
    globalThis.fetch = answers([{ jsonrpc: "2.0", id: 1, error: { message: "tenant disabled" } }, { jsonrpc: "2.0", id: 1, error: { message: "Archive requests require a personal token" } }, { jsonrpc: "2.0", id: 1, error: { message: "Archive requests require a personal token" } }]);
    let f = null; try { await publicJsonRpc(net, "eth_getBlockByNumber", ["0x10", false]); } catch (x) { f = x; }
    ok(f && f.statusCode === 502 && /RPC upstream unavailable/.test(f.message), "every node refusing ends in a 502 naming the last refusal, never a hollow answer");
    // A throttle is a refusal whatever its wording: JSON-RPC code 429, or HTTP 429.
    const throttleMsg = "Your app has exceeded its compute units per second capacity.";
    globalThis.fetch = answers([{ jsonrpc: "2.0", id: 1, error: { code: 429, message: throttleMsg } }, { jsonrpc: "2.0", id: 1, result: "0x10" }]);
    let g = null; try { g = await publicJsonRpc(net, "eth_blockNumber", []); } catch (x) { g = x; }
    ok(g === "0x10", "a JSON-RPC 429 falls through to the next node");
    let i = 0;
    globalThis.fetch = async () => (i++ === 0
      ? { status: 429, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: throttleMsg } }) }
      : { status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x11" }) });
    let k = null; try { k = await publicJsonRpc(net, "eth_blockNumber", []); } catch (x) { k = x; }
    ok(k === "0x11", "an HTTP 429 carrying a JSON-RPC error falls through to the next node");
  } finally { globalThis.fetch = realFetch; if (savedKey !== undefined) process.env.ALCHEMY_API_KEY = savedKey; }
}
console.log(`\n${pass} passed, ${fail} failed, live: ${liveOk} ok / ${liveErr} err`);
if (fail) process.exit(1);
