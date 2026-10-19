// Offline unit test for the strict-source discovery filters (testnet + junk)
// and network-id normalization, used when indexing open facilitator
// registries like PayAI. No network.
import assert from "node:assert";
import { itemHasMainnetAccept, isJunkOrigin, bazaarItemToTool, isMppChallenge } from "../src/x402-index.js";

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
// two real, currently-affected sellers found live 2026-08-13: bluebook.example
// (network:"base") and pixelboard.example (network:"solana").
const shorthandBase = bazaarItemToTool(
  { resource: "https://bluebook.example/api/lookup", accepts: [{ network: "base", amount: "1000", payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] },
  "https://bluebook.example"
);
assert.strictEqual(shorthandBase.networks[0], "eip155:8453", "shorthand \"base\" normalized to eip155:8453");
assert.strictEqual(shorthandBase.payToByNetwork["eip155:8453"], "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "payToByNetwork keyed by the normalized CAIP-2 id, not the raw shorthand");

const shorthandSolana = bazaarItemToTool(
  { resource: "https://pixelboard.example/api/pixels", accepts: [{ network: "solana", amount: "1000", payTo: "9EMAayAfBR32J5d3ApEAG3NdKArRBtAqN7LA8c2WRM5o" }] },
  "https://pixelboard.example"
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

// --- isMppChallenge: detect native MPP dual-stack from a live 402's
// WWW-Authenticate header (the same check src/mpp-shim.js emits and
// scripts/paid-canary.js's mpp leg verifies against a real prod response).
assert.strictEqual(isMppChallenge('Payment evm-charge="0xabc...", network="eip155:8453"'), true, "real-shaped Payment challenge detected");
assert.strictEqual(isMppChallenge("Payment"), true, "bare scheme with no params still detected");
assert.strictEqual(isMppChallenge("  Payment realm=x  "), true, "leading/trailing whitespace tolerated");
assert.strictEqual(isMppChallenge("payment realm=x"), true, "scheme match is case-insensitive");
assert.strictEqual(isMppChallenge(null), false, "no header at all -> not MPP");
assert.strictEqual(isMppChallenge(""), false, "empty header -> not MPP");
assert.strictEqual(isMppChallenge("Basic realm=x"), false, "a different auth scheme is not mistaken for MPP");
assert.strictEqual(isMppChallenge("Bearer"), false, "Bearer is not Payment");
assert.strictEqual(isMppChallenge("PaymentFoo realm=x"), false, "a scheme name merely starting with \"Payment\" does not match (word boundary)");

// --- isJunkOrigin: drop documentation/placeholder hosts ---------------------
assert.strictEqual(isJunkOrigin("https://api.example.com"), true, "example.com dropped");
assert.strictEqual(isJunkOrigin("https://example.org"), true, "example.org dropped");
assert.strictEqual(isJunkOrigin("http://test.dev"), true, "test.dev dropped");
assert.strictEqual(isJunkOrigin("not a url"), true, "unparseable dropped");
assert.strictEqual(isJunkOrigin("https://solmaker.example"), false, "real host kept");
assert.strictEqual(isJunkOrigin("https://mailseller.example"), false, "real host kept");
assert.strictEqual(isJunkOrigin("https://api.cacheseller.example"), false, "real host kept");

// --- the accepts reader: decimals, payTo, host case --------------------------
{
  const { paymentFieldsFromAccepts } = await import("../src/x402-index.js");
  const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const stellar = paymentFieldsFromAccepts([{ network: "stellar:pubnet", asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", amount: "100000", payTo: "GSELLER" }]);
  assert.strictEqual(stellar.price, 0.01, "Stellar USDC (7 decimals) scales by its own decimals");
  const stated = paymentFieldsFromAccepts([{ network: "eip155:8453", asset: "0x" + "ab".repeat(20), amount: "5000000000000000", extra: { name: "Some Token", decimals: 18 } }]);
  assert.strictEqual(stated.price, 0.005, "an accept's stated decimals scale its amount");
  const unknown = paymentFieldsFromAccepts([{ network: "eip155:8453", asset: "0x" + "cd".repeat(20), amount: "1000000000000000000", extra: { name: "Some Token" } }]);
  assert.strictEqual(unknown.price, null, "an asset we cannot scale is left unpriced, never read as USDC");
  assert.strictEqual(paymentFieldsFromAccepts([{ network: "eip155:8453", asset: BASE_USDC, amount: "10000", extra: { name: "USD Coin" } }]).price, 0.01, "Base USDC still scales by 6");
  assert.strictEqual(paymentFieldsFromAccepts([{ network: "base", amount: "10000" }]).price, 0.01, "an accept naming no asset reads as USDC");
  // payTo comes from the accept the price came from.
  const two = paymentFieldsFromAccepts([
    { network: "eip155:8453", asset: "0x" + "cd".repeat(20), amount: "1", payTo: "0xOTHER", extra: { name: "Some Token" } },
    { network: "eip155:8453", asset: BASE_USDC, amount: "10000", payTo: "0xPRICED", extra: { name: "USD Coin" } },
    { network: "eip155:8453", asset: BASE_USDC, amount: "20000", payTo: "0xLATER", extra: { name: "USD Coin" } },
  ]);
  assert.strictEqual(two.price, 0.01, "the preferred Base USDC accept prices the row");
  assert.strictEqual(two.payToByNetwork["eip155:8453"], "0xPRICED", "the row's Base payTo is the priced accept's own");
  // A registry row whose resource spells the host in another case is kept.
  const mixed = bazaarItemToTool({ resource: "https://API.Mixed.example/v1/x", accepts: [{ network: "eip155:8453", asset: BASE_USDC, amount: "10000", extra: { name: "USD Coin" } }] }, "https://api.mixed.example");
  assert.ok(mixed && mixed.route === "/v1/x", "a mixed-case host registry row is filed under the seller");
  assert.strictEqual(bazaarItemToTool({ resource: "https://api.mixed.example.evil/v1/x" }, "https://api.mixed.example"), null, "another host is still refused");
}

console.log("discovery-filter: all assertions passed");
