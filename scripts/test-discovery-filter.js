// Offline unit test for the strict-source discovery filters (testnet + junk),
// used when indexing open facilitator registries like PayAI. No network.
import assert from "node:assert";
import { itemHasMainnetAccept, isJunkOrigin } from "../src/x402-index.js";

// --- itemHasMainnetAccept: keep mainnet, drop testnet-only ------------------
const mainnetBase = { accepts: [{ network: "eip155:8453" }] };
const mainnetSol = { accepts: [{ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }] };
const testnetOnly = { accepts: [{ network: "eip155:84532" }] };          // base sepolia
const namedTestnet = { accepts: [{ network: "xlayer-testnet" }] };
const devnet = { accepts: [{ network: "solana-devnet" }] };
const mixed = { accepts: [{ network: "eip155:84532" }, { network: "eip155:8453" }] }; // testnet + mainnet
const noAccepts = { accepts: [] };
// Algorand's CAIP-2 ids are genesis hashes, not "testnet"-labeled strings -
// the EVM-shaped regex/set above can't see them, which is exactly the gap
// that let the GoPlausible source run unpaginated+unfiltered for weeks
// (src/x402-index.js's DISCOVERY_SOURCES). Real mainnet/testnet genesis ids.
const algorandMainnet = { accepts: [{ network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=" }] };
const algorandTestnet = { accepts: [{ network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=" }] };
const algorandMixed = { accepts: [{ network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=" }, { network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=" }] };

assert.strictEqual(itemHasMainnetAccept(mainnetBase), true, "base mainnet kept");
assert.strictEqual(itemHasMainnetAccept(mainnetSol), true, "solana mainnet kept");
assert.strictEqual(itemHasMainnetAccept(testnetOnly), false, "base-sepolia-only dropped");
assert.strictEqual(itemHasMainnetAccept(namedTestnet), false, "named testnet dropped");
assert.strictEqual(itemHasMainnetAccept(devnet), false, "devnet dropped");
assert.strictEqual(itemHasMainnetAccept(mixed), true, "mixed testnet+mainnet kept (mainnet leg)");
assert.strictEqual(itemHasMainnetAccept(noAccepts), true, "no accepts info → not over-filtered");
assert.strictEqual(itemHasMainnetAccept(algorandMainnet), true, "algorand mainnet kept");
assert.strictEqual(itemHasMainnetAccept(algorandTestnet), false, "algorand testnet-only dropped (genesis-hash id, not string-pattern-matchable)");
assert.strictEqual(itemHasMainnetAccept(algorandMixed), true, "algorand mixed testnet+mainnet kept (mainnet leg)");

// --- isJunkOrigin: drop documentation/placeholder hosts ---------------------
assert.strictEqual(isJunkOrigin("https://api.example.com"), true, "example.com dropped");
assert.strictEqual(isJunkOrigin("https://example.org"), true, "example.org dropped");
assert.strictEqual(isJunkOrigin("http://test.dev"), true, "test.dev dropped");
assert.strictEqual(isJunkOrigin("not a url"), true, "unparseable dropped");
assert.strictEqual(isJunkOrigin("https://madeonsol.com"), false, "real host kept");
assert.strictEqual(isJunkOrigin("https://x402email.com"), false, "real host kept");
assert.strictEqual(isJunkOrigin("https://api.xcache.io"), false, "real host kept");

console.log("discovery-filter: all assertions passed");
