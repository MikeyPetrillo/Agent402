// Offline unit test for the strict-source discovery filters (testnet + junk)
// and network-id normalization, used when indexing open facilitator
// registries like PayAI. No network.
import assert from "node:assert";
import { itemHasMainnetAccept, isJunkOrigin, bazaarItemToTool } from "../src/x402-index.js";

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
// TESTNET_CAIP2 was never extended when Monad/Celo/Avalanche/Sei joined as
// rails - none of these testnet ids contain "sepolia"/"testnet"/"devnet",
// so without an explicit set entry they'd pass the string-pattern check.
const monadTestnet = { accepts: [{ network: "eip155:10143" }] };
const celoTestnet = { accepts: [{ network: "eip155:11142220" }] };
const avalancheTestnet = { accepts: [{ network: "eip155:43113" }] };
const seiTestnet = { accepts: [{ network: "eip155:1328" }] };

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
assert.strictEqual(itemHasMainnetAccept(monadTestnet), false, "monad testnet dropped");
assert.strictEqual(itemHasMainnetAccept(celoTestnet), false, "celo sepolia dropped");
assert.strictEqual(itemHasMainnetAccept(avalancheTestnet), false, "avalanche fuji dropped");
assert.strictEqual(itemHasMainnetAccept(seiTestnet), false, "sei testnet (atlantic-2) dropped");

// --- bazaarItemToTool: normalize shorthand network strings to CAIP-2 -------
// PayAI's open registry carries `network` as a bare shorthand string on some
// listings instead of proper CAIP-2 - every downstream CHAIN_PAGES isNetwork
// exact-match then fails silently, so the seller is indexed (shows on
// /marketplace) but invisible on its own chain's page. Fixtures modeled on
// two real, currently-affected sellers found live 2026-08-13: bluepages.fyi
// (network:"base") and 1mpixels-one.vercel.app (network:"solana").
const shorthandBase = bazaarItemToTool(
  { resource: "https://bluepages.fyi/api/lookup", accepts: [{ network: "base", amount: "1000", payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] },
  "https://bluepages.fyi"
);
assert.strictEqual(shorthandBase.networks[0], "eip155:8453", "shorthand \"base\" normalized to eip155:8453");
assert.strictEqual(shorthandBase.payToByNetwork["eip155:8453"], "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "payToByNetwork keyed by the normalized CAIP-2 id, not the raw shorthand");

const shorthandSolana = bazaarItemToTool(
  { resource: "https://1mpixels-one.vercel.app/api/pixels", accepts: [{ network: "solana", amount: "1000", payTo: "9EMAayAfBR32J5d3ApEAG3NdKArRBtAqN7LA8c2WRM5o" }] },
  "https://1mpixels-one.vercel.app"
);
assert.strictEqual(shorthandSolana.networks[0], "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "shorthand \"solana\" normalized to its real CAIP-2 id");

// Already-correct CAIP-2 input must pass through unchanged (no double
// normalization / no regression for the 99%+ of listings already correct).
const alreadyCaip2 = bazaarItemToTool(
  { resource: "https://real-caip2.example/api/x", accepts: [{ network: "eip155:8453", amount: "1000", payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }] },
  "https://real-caip2.example"
);
assert.strictEqual(alreadyCaip2.networks[0], "eip155:8453", "already-CAIP-2 network passes through unchanged");

// An unrecognized string (not a known chain's shorthand, not CAIP-2) is left
// as-is rather than guessed at - it simply won't match any isNetwork check,
// same (safe) behavior as before this fix for genuinely unknown networks.
const unknownShorthand = bazaarItemToTool(
  { resource: "https://mystery-chain.example/api/x", accepts: [{ network: "some-future-chain", amount: "1000", payTo: "0xcccccccccccccccccccccccccccccccccccccc" }] },
  "https://mystery-chain.example"
);
assert.strictEqual(unknownShorthand.networks[0], "some-future-chain", "unrecognized shorthand left untouched, not guessed at");

// --- isJunkOrigin: drop documentation/placeholder hosts ---------------------
assert.strictEqual(isJunkOrigin("https://api.example.com"), true, "example.com dropped");
assert.strictEqual(isJunkOrigin("https://example.org"), true, "example.org dropped");
assert.strictEqual(isJunkOrigin("http://test.dev"), true, "test.dev dropped");
assert.strictEqual(isJunkOrigin("not a url"), true, "unparseable dropped");
assert.strictEqual(isJunkOrigin("https://madeonsol.com"), false, "real host kept");
assert.strictEqual(isJunkOrigin("https://x402email.com"), false, "real host kept");
assert.strictEqual(isJunkOrigin("https://api.xcache.io"), false, "real host kept");

console.log("discovery-filter: all assertions passed");
