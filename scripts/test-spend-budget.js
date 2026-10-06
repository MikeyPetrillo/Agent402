// Offline unit test for the reserve-before-spend budget used when paying
// third-party x402 sellers.
//
// The bug this pins: the old code counted a buy against its cap only when the
// seller returned a `payment-response` receipt. One seller returned HTTP 502
// with no receipt, the run recorded "not charged", and $0.05 had already left
// the wallet on-chain — pushing that run's true spend to $0.396 against its own
// $0.35 cap.
//
// The invariant: committed spend NEVER exceeds the cap, and a reservation is
// released only on a conclusive on-chain read that found nothing.
//
// Run: node scripts/test-spend-budget.js
import { makeBudget, findSettlement, verifySettlement } from "./spend-budget.js";

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.error(`FAIL - ${name}`); }
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ── Budget arithmetic ────────────────────────────────────────────────────────
{
  const b = makeBudget(1.0);
  check("starts with the full cap", near(b.remaining(), 1.0) && near(b.committedUsd, 0));
  b.reserve(0.4);
  check("reserve commits immediately", near(b.committedUsd, 0.4) && near(b.remaining(), 0.6));
  b.release(0.4);
  check("release returns the headroom", near(b.committedUsd, 0) && near(b.releasedUsd, 0.4));
}

// The overshoot scenario, replayed: a $0.35 cap, $0.346 of confirmed buys, then
// a $0.05 buy that settles silently. Under the OLD rule the $0.05 was invisible
// and total spend hit $0.396. Under reserve-first it cannot even be attempted.
{
  const b = makeBudget(0.35);
  b.reserve(0.346);
  check("replay: the silent $0.05 is refused, cap holds", !b.canAfford(0.05));
  check("replay: committed stays at or under the cap", b.committedUsd <= 0.35 + 1e-9);
}

{
  const b = makeBudget(1.0);
  check("canAfford refuses an amount that would exceed the cap", !b.canAfford(1.01));
  check("canAfford allows exactly the cap", b.canAfford(1.0));
  check("canAfford refuses zero and negatives", !b.canAfford(0) && !b.canAfford(-1));
}

// Committing every attempt, releasing none, must still never breach the cap.
{
  const b = makeBudget(0.10);
  let attempts = 0;
  while (b.canAfford(0.03)) { b.reserve(0.03); attempts++; }
  check("worst case (nothing released) never breaches the cap", b.committedUsd <= 0.10 + 1e-9);
  check("worst case fits 3 x $0.03 under $0.10", attempts === 3);
}

// ── Settlement matching ──────────────────────────────────────────────────────
const PAYER = "PAYERADDR", SELLER = "SELLERADDR";
const txn = (sender, receiver, amount, id) => ({
  id, sender, "asset-transfer-transaction": { "asset-id": 31566704, receiver, amount },
});

{
  const list = [txn(PAYER, SELLER, 50000, "TX1")];
  check("finds an exact payer/payTo/amount match", findSettlement(list, { payer: PAYER, payTo: SELLER, amountAtomic: "50000" }) === "TX1");
  check("rejects a different receiver", findSettlement(list, { payer: PAYER, payTo: "OTHER", amountAtomic: "50000" }) === null);
  check("rejects a different amount", findSettlement(list, { payer: PAYER, payTo: SELLER, amountAtomic: "50001" }) === null);
  check("rejects a payment we did not send", findSettlement(list, { payer: "SOMEONELSE", payTo: SELLER, amountAtomic: "50000" }) === null);
  check("rejects a non-USDC asset", findSettlement([{ id: "TX2", sender: PAYER, "asset-transfer-transaction": { "asset-id": 999, receiver: SELLER, amount: 50000 } }], { payer: PAYER, payTo: SELLER, amountAtomic: "50000" }) === null);
  check("empty/absent list is a clean miss", findSettlement([], { payer: PAYER, payTo: SELLER, amountAtomic: "1" }) === null && findSettlement(undefined, { payer: PAYER, payTo: SELLER, amountAtomic: "1" }) === null);
}

// ── verifySettlement: the conclusive/inconclusive distinction ────────────────
const args = { payer: PAYER, payTo: SELLER, amountAtomic: "50000", sinceIso: "2026-07-25T00:00:00Z" };
const noSleep = () => Promise.resolve();

{
  const ok = async () => ({ ok: true, json: { transactions: [txn(PAYER, SELLER, 50000, "TXA")] } });
  const v = await verifySettlement(args, { getJsonAcross: ok, bases: ["x"], sleep: noSleep });
  check("a found transfer reports settled + conclusive", v.settled === true && v.tx === "TXA" && v.conclusive === true);
}

{
  const empty = async () => ({ ok: true, json: { transactions: [] } });
  const v = await verifySettlement(args, { getJsonAcross: empty, bases: ["x"], sleep: noSleep });
  check("a successful read finding nothing is CONCLUSIVE (safe to release)", v.settled === false && v.conclusive === true);
}

{
  const down = async () => ({ ok: false, status: 503 });
  const v = await verifySettlement(args, { getJsonAcross: down, bases: ["x"], sleep: noSleep });
  check("indexer down is INCONCLUSIVE (must stay committed)", v.settled === false && v.conclusive === false);
}

{
  const throws = async () => { throw new Error("network"); };
  const v = await verifySettlement(args, { getJsonAcross: throws, bases: ["x"], sleep: noSleep });
  check("a throwing indexer is INCONCLUSIVE", v.settled === false && v.conclusive === false);
}

// Indexer lag: the first read misses, a later one finds it. Retrying is the
// whole point — a single immediate read would wrongly release the money.
{
  let n = 0;
  const lagging = async () => {
    n++;
    return n < 3 ? { ok: true, json: { transactions: [] } } : { ok: true, json: { transactions: [txn(PAYER, SELLER, 50000, "TXLATE")] } };
  };
  const v = await verifySettlement(args, { getJsonAcross: lagging, bases: ["x"], sleep: noSleep });
  check("retries catch a settlement the indexer had not yet surfaced", v.settled === true && v.tx === "TXLATE");
}

console.log(`\ntest-spend-budget: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
