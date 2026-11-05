#!/usr/bin/env node
// Redisplaying a transfer should not re-scan the chain for it.
//
//   node scripts/test-ledger-recent.js          (offline)
//
// WHY: the revenue rail card built its `recent[]` by chunked eth_getLogs across
// six EVM rails on every snapshot refresh. A production egress census measured
// 221 Alchemy calls per refresh, and crawler traffic kept the cache warm up to
// 144 times a day - on the order of a million billed calls a month, to
// redisplay transfers the ledger had already stored.
//
// The ledger is the same data from the same source, indexed once by the
// background sync. Balances still need a live read - a balance is not a
// transfer - but those are single eth_call reads that already went
// publics-first and were never the expensive part.
//
// The assertions below are mostly about the FALLBACK, because that is where
// this can do damage: an empty ledger must mean "go scan", never "no revenue".
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { ledgerRecent } from "../src/revenue-ledger.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// 1. Empty / malformed input can never throw on a page render path.
let threw = null;
try {
  ok(Array.isArray(ledgerRecent("base", [])), "no wallets -> []");
  ok(Array.isArray(ledgerRecent(null, ["0xabc"])), "no chain -> []");
  ok(ledgerRecent("nosuchchain", ["0xabc"]).length === 0, "unknown chain -> []");
  ok(ledgerRecent("base", "0xabc").length >= 0, "a bare string wallet is accepted, not just an array");
} catch (e) { threw = e; }
ok(!threw, `never throws on the render path (${threw?.message || "no throw"})`);

// THE ASSERTION THAT WAS MISSING. The original 11 all passed while the ledger
// path was never taken once in production: EVM addresses are stored lowercase
// and WALLET_ADDRESS is checksummed, so the IN clause matched nothing and every
// rail fell back to the live scan. Testing that a fallback works is not testing
// that the feature works.
const ledgerSrc = readFileSync(new URL("../src/revenue-ledger.js", import.meta.url), "utf8");
const fn = ledgerSrc.slice(ledgerSrc.indexOf("export function ledgerRecent"), ledgerSrc.indexOf("export function ledgerSyncState"));
ok(/toLowerCase\(\)/.test(fn),
  "ledgerRecent normalises EVM wallet case - a checksummed address must match a lowercased row");
ok(/0x\[0-9a-fA-F\]\{40\}/.test(fn),
  "...and only for 0x addresses - base58/base32 are case-sensitive and must never be folded");

// Case-insensitivity for EVM, proven behaviourally rather than by reading code.
const mixed = ledgerRecent("base", ["0xAbF4FaBd7C416Fb67202E5F9002389fC75E2A9d0"]);
const lower = ledgerRecent("base", ["0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0"]);
ok(mixed.length === lower.length,
  `a checksummed and a lowercased address return the same rows (${mixed.length} vs ${lower.length})`);

const live = readFileSync(new URL("../src/revenue-live.js", import.meta.url), "utf8");

// 2. THE SAFETY PROPERTY. An empty ledger must route to the live scan. If it
//    did not, a cold boot or an unsynced chain would render as "no
//    settlements" - a revenue page confidently reporting zero.
const branch = live.slice(live.indexOf("let ledgerRows = []"), live.indexOf("out.recentSource"));
ok(/if \(!viaLedger\)/.test(branch) && /recentInbound\(/.test(branch),
  "an empty ledger falls back to the live chain scan, so zero rows never renders as zero revenue");
ok(/viaLedger = recent\.length > 0/.test(branch),
  "the fallback triggers on EMPTINESS, not on an error flag - a silent empty read is the dangerous case");

// 3. The cycle. revenue-ledger imports revenue-live, so a static import back
//    kills the server at boot ("Cannot access ALGORAND_INDEXER_BASES before
//    initialization"). Verified once the hard way; pinned so it stays fixed.
ok(!/^import \{[^}]*ledgerRecent[^}]*\} from "\.\/revenue-ledger\.js"/m.test(live),
  "revenue-live does NOT statically import the ledger - that closes a cycle and breaks boot");
ok(/await import\("\.\/revenue-ledger\.js"\)/.test(live),
  "...it imports lazily inside the async call, after both modules are evaluated");

// 4. Balances must STILL be read live. The ledger records transfers, not
//    balances; serving a stale balance from it would be wrong, not just cheap.
ok(/eth_call/.test(live) && /0x70a08231/.test(live),
  "the balance is still a live eth_call - a transfer table cannot answer it");

// 5. The source is reported, so a reader can tell which path served them.
ok(/recentSource = viaLedger \? "ledger" : "chain-scan"/.test(live),
  "each rail says whether its transfers came from the ledger or a live scan");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
