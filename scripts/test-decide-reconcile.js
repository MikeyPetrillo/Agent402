// Plan-execution reconciliation (scripts/decide-reconcile.mjs): what the ledger
// booked against what left the spending wallet. Offline, pure function.
//
//   node scripts/test-decide-reconcile.js

import { reconcile } from "./decide-reconcile.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const T = 1_800_000_000_000;
const runs = [
  { id: "r1", created_at: T, finished_at: T + 30_000, spent_usd: 0.0105, steps: [
    { status: "ok", tool: { firstParty: false, seller: "s.example" }, costUsd: 0.0105, routingFeeUsd: 0.0005, receipt: { settleTx: "0xAAA", settleNetwork: "eip155:8453" } },
  ] },
  { id: "r2", created_at: T + 3_600_000, finished_at: T + 3_660_000, spent_usd: 0.0315, steps: [
    { status: "ok", tool: { firstParty: true, slug: "ours" }, costUsd: 0.0015 },
    { status: "failed", attempts: [{ id: "x", mayHavePaid: true, error: "timeout", bookedUsd: 0.03 }] },
  ] },
  { id: "r3", created_at: T + 7_200_000, finished_at: T + 7_210_000, spent_usd: 0.0105, steps: [
    { status: "ok", tool: { firstParty: false, seller: "t.example" }, costUsd: 0.0105, routingFeeUsd: 0.0005, receipt: { settleTx: "0xBBB", settleNetwork: "eip155:8453" } },
  ] },
];
const receipts = new Map([["0xaaa", 10_000], ["0xbbb", 12_000]]);
const transfers = [
  { tx: "0xAAA", to: "0xs", micro: 10_000, at: T + 10_000 },
  { tx: "0xCCC", to: "0xu", micro: 30_000, at: T + 3_620_000 },   // the uncertain leg did pay
  { tx: "0xBBB", to: "0xt", micro: 12_000, at: T + 7_205_000 },
];
const out = reconcile({ runs, receipts, transfers });
ok(out.confirmedLegs === 2 && out.bookedConfirmedUsd === 0.02 && out.onChainConfirmedUsd === 0.022, `confirmed legs read back from the chain (booked $${out.bookedConfirmedUsd}, on chain $${out.onChainConfirmedUsd})`);
ok(out.mismatches.length === 1 && out.mismatches[0].tx === "0xBBB" && /more than booked/.test(out.mismatches[0].note), "a leg that paid more than booked is listed");
ok(out.uncertainLegs === 1 && out.uncertainFound.length === 1 && out.uncertainFound[0].tx === "0xCCC" && out.uncertainTransfersFoundUsd === 0.03, "an uncertain leg is matched to the unexplained transfer in its window");
ok(!out.uncertainFound.some((f) => f.tx === "0xAAA" || f.tx === "0xBBB"), "a transfer a confirmed leg explains is never attributed to an uncertain one");
const quiet = reconcile({ runs: [runs[1]], receipts: new Map(), transfers: [] });
ok(quiet.uncertainFound.length === 0 && quiet.uncertainBookedAtWorstCaseUsd === 0.03, `an uncertain leg with no transfer in its window: its own booked worst case, not first-party spend or fees (${quiet.uncertainBookedAtWorstCaseUsd})`);

{
  const legacy = reconcile({ runs: [{ id: "L", created_at: T, finished_at: T + 1000, spent_usd: 1, steps: [{ status: "failed", attempts: [{ id: "y", mayHavePaid: true }] }] }], receipts: new Map(), transfers: [] });
  ok(legacy.uncertainBookedAtWorstCaseUsd === 0 && legacy.uncertainLegsWithoutBookedAmount === 1, "a leg recorded without its booked amount is counted as unknown, not guessed from run spend");
}

console.log(`\ntest-decide-reconcile: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
