#!/usr/bin/env node
// The router's reliability floor must not be clearable by one wallet.
//
//   node scripts/test-sor-breadth.js
//
// WHY: the gate compared a settlement COUNT and nothing else, so 50 settlements
// from a single buyer cleared it exactly like 50 buyers settling once. A count
// is manufacturable by a seller paying itself, and volume of exactly that shape
// exists in this ecosystem: one funder cycling USDC through wallets it controls,
// back to its own payTo, with only gas consumed.
//
// The question that produced this came from a seller asking whether repeated
// settlements from one buyer count equally. They did. Now breadth counts too.
//
// The rule, and its limits stated honestly:
//   * count AND distinct payers, where payer data exists
//   * the floor is LOW (3). It defeats the single-wallet loop, which is the
//     cheap attack. It does NOT defeat a funded fleet of wallets, which needs
//     funding-graph analysis this does not attempt.
//   * an origin with NO payer evidence is unknown, not failing. It keeps the
//     old behaviour rather than being refused for a gap in OUR data.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { provenByChain, meetsRouterGate } from "../src/settlement-proof.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const BASE = "eip155:8453";
const seller = (origin, payTo) => ({ origin, payToByNetwork: { [BASE]: payTo } });
const merchant = (m, payments, payers) => ({ merchant: m, payments, payers, volumeUsd: 1 });

// THE ROUTER'S OWN PREDICATE, imported — not a copy.
//
// The first version of this file re-implemented the rule inline. Deleting the
// router's filter then left every assertion green, which is precisely the
// "fixture is fiction" failure the shape contract exists to stop. One
// implementation, imported by both, is the only version that cannot drift.
const passes = (x) => meetsRouterGate({ ...x, minSettled: 50, minPayers: 3 }).ok;

// --- the manufactured-volume case, which is the whole point -----------------
ok(!passes({ settled: 198_543, payers: 1 }),
  "198k settlements from ONE payer is refused — a count one wallet can manufacture is not proof");
ok(!passes({ settled: 50, payers: 2 }), "two payers is still under the breadth floor");
ok(passes({ settled: 50, payers: 3 }), "the floor itself passes");
ok(passes({ settled: 1200, payers: 69 }), "real breadth passes comfortably");

// --- absence of payer data is UNKNOWN, never a failure ----------------------
// Refusing here would punish a seller for a gap in our own evidence, and would
// silently narrow the router the moment a payer source went quiet.
ok(passes({ settled: 500, payers: undefined }),
  "no payer evidence keeps the previous behaviour rather than refusing");
ok(!passes({ settled: 10, payers: undefined }),
  "...but the count floor still applies when breadth is unknown");

// --- breadth never rescues a seller below the count floor -------------------
ok(!passes({ settled: 49, payers: 500 }), "many payers does not substitute for the settlement floor");

// --- the chain join carries payers through, so the gate can see them --------
{
  const A = "0x" + "a".repeat(40);
  const proven = provenByChain({
    sellers: [seller("https://solo.test", A)],
    merchants: [merchant(A, 198_543, 1)],
  });
  const ev = proven.get("https://solo.test");
  ok(ev?.settled === 198543, "chain evidence carries the settlement count");
  ok(ev?.payers === 1, "chain evidence carries the DISTINCT PAYER count the gate needs");
  ok(!passes({ settled: ev.settled, payers: ev.payers }),
    "and an origin whose whole history is one payer is refused end to end");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
