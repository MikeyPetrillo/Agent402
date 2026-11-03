#!/usr/bin/env node
// A rail we accept money on must have a name, or its revenue reads as a hex id.
//
//   node scripts/test-chain-names.js          (offline)
//
// WHY: Sei and Optimism shipped as payment rails without an entry in
// CAIP2_NAMES, so every settlement on them was booked under its raw CAIP-2 id
// and shown that way on the PUBLIC /api/stats - "eip155:10" rather than
// "optimism". Nothing was lost on-chain, but the named bucket and the id
// bucket are different counters, so per-chain revenue read low for both and a
// reader comparing rails would have drawn the wrong conclusion.
//
// The same gap left older chains split across two rows at once: monad 19
// beside eip155:143 42, celo 35 beside eip155:42220 16, stellar beside
// stellar:pubnet. Those are historical counters from before their entry
// existed, which is why the merge happens at read time.
//
// This is the guard that makes adding a rail without naming it fail loudly.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { KNOWN_CAIP2, mergeNetworkCounters } from "../src/stats.js";
import { NETWORKS } from "../src/payments.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// 1. Every chain the server CAN offer must be nameable. Sourced from the static
//    NETWORKS map rather than railStatus(), which reads boot state and is empty
//    offline - the first version of this test called it and cheerfully passed
//    while checking zero rails, which is the same vacuous-green failure the
//    rest of this audit kept finding.
const mainnet = Object.entries(NETWORKS).filter(([n]) => !/sepolia|devnet|testnet/i.test(n));
ok(mainnet.length >= 12, `NETWORKS lists the mainnet rails to check (${mainnet.length})`);
const unnamed = mainnet.filter(([, caip2]) => caip2 && !KNOWN_CAIP2[caip2]);
ok(unnamed.length === 0,
  `every offerable chain's CAIP-2 id has a name${unnamed.length ? ` (unnamed: ${unnamed.map(([n, c]) => `${n}=${c}`).join(", ")})` : ""}`);

// The two that shipped unnamed, pinned by id so a revert is caught.
ok(KNOWN_CAIP2["eip155:10"] === "optimism", "optimism (eip155:10) is named");
ok(KNOWN_CAIP2["eip155:1329"] === "sei", "sei (eip155:1329) is named");

// 2. The read-time merge folds an id bucket into its named one, so one chain
//    is one row. This is what stops the public surface understating a rail.
const merged = mergeNetworkCounters([
  ["monad", 19], ["eip155:143", 42],
  ["celo", 35], ["eip155:42220", 16],
  ["base", 6828],
]);
ok(merged.monad === 61, `monad's two counters merge to one row (${merged.monad})`);
ok(merged.celo === 51, `celo's two counters merge to one row (${merged.celo})`);
ok(!("eip155:143" in merged) && !("eip155:42220" in merged),
  "the raw id rows are gone, not served alongside the named ones");
ok(merged.base === 6828, "a chain with only one spelling is unchanged");

// 3. An id we genuinely cannot name must still appear rather than vanish.
//    Silently dropping revenue would be far worse than showing a hex id.
const unknown = mergeNetworkCounters([["eip155:99999", 7], ["base", 1]]);
ok(unknown["eip155:99999"] === 7,
  "an unnameable chain still reports its count under the raw id - never dropped");

// 4. Totals are conserved. A merge that loses or duplicates a call would be a
//    worse defect than the split it fixes.
const before = [["monad", 19], ["eip155:143", 42], ["stellar", 71], ["stellar:pubnet", 20], ["x:1", 3]];
const sumBefore = before.reduce((a, [, n]) => a + n, 0);
const sumAfter = Object.values(mergeNetworkCounters(before)).reduce((a, n) => a + n, 0);
ok(sumBefore === sumAfter, `merging conserves the total (${sumBefore} -> ${sumAfter})`);

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
