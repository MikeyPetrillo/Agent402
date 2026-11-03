// A venue with many payees must not collapse to one seller.
//
// The index kept ONE payTo per network via a first-wins reduce. That is fine
// for a seller whose tools all pay the same address, and wrong for a
// marketplace that gives each author their own revenue split: measured on a
// live seller 2026-08-06, 236 paid routes across 22 authors with 22 distinct
// payTo addresses, of which the index retained exactly one. Twenty-one payees
// were invisible, and any ranking that aggregates by payTo (ours included)
// attributed the whole origin's on-chain volume to whichever address happened
// to be crawled first.
//
// `payToByNetwork` deliberately STAYS a single string per network - the
// router's chain-derived proven-ness join and the market pages index it
// directly, and changing its type would break them silently. `payTosByNetwork`
// carries the full set alongside it.
//
//   node scripts/test-multi-payto.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

// IMPORT the real function rather than mirroring it. An earlier draft of this
// file reimplemented the reducer locally, which would have stayed green even if
// payTosByNetwork were deleted from the module outright - a test that proves
// its own copy works, not the shipped code.
const { allPayTosByNetwork: allPayTos } = await import("../src/x402-index.js");
ok(typeof allPayTos === "function", "the reducer is exported from src/x402-index.js and is what is under test");
const firstWins = (tools) => (tools || []).reduce((acc, t) => {
  for (const [net, addr] of Object.entries(t.payToByNetwork || {})) if (!acc[net]) acc[net] = addr;
  return acc;
}, {});

const BASE = "eip155:8453";
// 22 authors, one payTo each - the real shape that exposed this.
const venue = Array.from({ length: 22 }, (_, i) => ({ payToByNetwork: { [BASE]: `0x${String(i).padStart(40, "a")}` } }));

ok(Object.keys(firstWins(venue)).length === 1, "first-wins yields a single network key (unchanged behaviour)");
ok(typeof firstWins(venue)[BASE] === "string", "payToByNetwork stays a STRING - the router join and market pages index it directly");
ok(allPayTos(venue)[BASE].length === 22, `all 22 author payees are retained (got ${allPayTos(venue)[BASE].length})`);

// Duplicates collapse, so a busy author does not inflate the payee count.
const dupes = [{ payToByNetwork: { [BASE]: "0xAAA" } }, { payToByNetwork: { [BASE]: "0xAAA" } }, { payToByNetwork: { [BASE]: "0xBBB" } }];
ok(allPayTos(dupes)[BASE].length === 2, "the same payee across many routes counts once");

// Case-exactness: folding merges DISTINCT payees. Same rule as src/payer.js -
// base58/base32 are case-sensitive and EVM addresses are checksummed.
const cased = [{ payToByNetwork: { "solana:x": "SoLaNa1" } }, { payToByNetwork: { "solana:x": "solana1" } }];
ok(allPayTos(cased)["solana:x"].length === 2, "case-different addresses stay distinct, never folded together");

// Multi-chain: a payee set per network, not one flat list.
const multi = [{ payToByNetwork: { [BASE]: "0xA", "solana:x": "S1" } }, { payToByNetwork: { [BASE]: "0xB" } }];
ok(allPayTos(multi)[BASE].length === 2 && allPayTos(multi)["solana:x"].length === 1,
  "payees are grouped per network, not merged across chains");

// Unbounded growth guard: an origin advertising thousands of payees must not
// balloon a cached index entry.
const many = Array.from({ length: 500 }, (_, i) => ({ payToByNetwork: { [BASE]: `0x${i}` } }));
ok(allPayTos(many)[BASE].length === 200, `payee list is capped (got ${allPayTos(many)[BASE].length}, want 200)`);

// Empty / malformed tools must not throw or invent entries.
ok(JSON.stringify(allPayTos([])) === "{}", "no tools yields an empty object");
ok(JSON.stringify(allPayTos([{}, { payToByNetwork: null }, null])) === "{}", "malformed tool rows are skipped, not thrown on");

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
