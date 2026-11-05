// Locks the MPP_CHALLENGE_NETWORKS default (2026-08-16 audit) against the
// INSTALLED mppx package rather than trusting a code comment. The claim in
// src/mpp-shim.js is: "a stock mppx client can only natively sign assets in
// its built-in registry (Base + Celo mainnets)" - that used to be an
// unverified assertion. This test reads mppx's real exported Chains/Assets
// and asserts our DEFAULT_CHALLENGE_CHAIN_IDS ({8453, 42220}) is EXACTLY the
// set of mainnet chain ids mppx has a known USDC/USDT asset for - no more,
// no fewer.
//
// This is a drift guard, not a one-time check: a future mppx version bump
// that adds a new mainnet to its registry (their roadmap could add one) SHOULD
// fail this test, prompting a deliberate review of whether
// DEFAULT_CHALLENGE_CHAIN_IDS needs to grow with it - silently missing that
// would mean stock clients on the new chain never get offered an MPP
// challenge even though they could pay one.
//
//   node scripts/test-mpp-shim-mppx-registry.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { Chains, Assets } from "mppx/evm";
import { challengeEnabledForChain } from "../src/mpp-shim.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Which of mppx's known chain ids are MAINNETS (name doesn't contain "Sepolia").
const mppxMainnetChainIds = Object.entries(Chains)
  .filter(([name]) => !/sepolia/i.test(name))
  .map(([, id]) => id);

ok(mppxMainnetChainIds.length > 0, "mppx exports at least one mainnet chain id");
// Calls the REAL production function (no MPP_CHALLENGE_NETWORKS env set, so
// this exercises the actual default, not a value duplicated in this file).
ok(mppxMainnetChainIds.every((id) => challengeEnabledForChain(id)), `challengeEnabledForChain() (real default) is true for every mppx mainnet (${mppxMainnetChainIds.join(",")})`);
// A chain mppx does NOT know natively (Polygon) must stay OFF by default -
// proves the default doesn't just always return true.
ok(!challengeEnabledForChain(137), "challengeEnabledForChain() (real default) is false for a chain mppx has no known asset for (Polygon, 137)");

// Assets registry: each of those mainnets must actually have a known USDC
// asset (a mainnet chain id with no asset would be pointless to challenge —
// a stock client has nothing to sign against it even though the chain id exists).
const assetGroupForChainId = (chainId) => Object.values(Assets).find((v) => v && typeof v === "object" && v.USDC?.network === `eip155:${chainId}`);
for (const id of mppxMainnetChainIds) {
  ok(!!assetGroupForChainId(id), `mppx has a known USDC asset for mainnet chain ${id}`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
