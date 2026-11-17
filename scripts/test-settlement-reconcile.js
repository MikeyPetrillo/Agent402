// Settlement reconciliation — did the money we were told arrived actually arrive?
//
// Both ledgers are pointed at temp files BEFORE import so this touches no real
// data. Offline: no RPC, no network. The whole check is a join between two
// SQLite files we already keep.
//
// The defect being guarded: a facilitator reports a settlement succeeded, we
// return the buyer's answer, and no transfer ever lands. Measured on Solana
// 2026-08-06 at 11% of one day's settlements and 25% of the next.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-reconcile-"));
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
process.env.REVENUE_LEDGER_DB = join(dir, "revenue.db");
process.env.RECONCILE_GRACE_MS = "3600000";

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

const { recordSale } = await import("../src/sales-ledger.js");
const { recordTransfer } = await import("../src/revenue-ledger.js");
const { reconcileSettlements } = await import("../src/settlement-reconcile.js");

const NOW = 1_800_000_000_000;
const OLD = NOW - 3 * 3600_000;   // outside the grace window, judged
const BUYER = "0x1234567890123456789012345678901234567890";

// Helper: recordSale stamps Date.now(), so freeze it for deterministic ages.
const realNow = Date.now;
const at = (ms, fn) => { Date.now = () => ms; try { return fn(); } finally { Date.now = realNow; } };

// --- a settlement that DID land ---------------------------------------------
at(OLD, () => recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: BUYER, tx: "0xLANDED", synthetic: false }));
recordTransfer({ chain: "base", wallet: "w", txid: "0xLANDED:0", tx_hash: "0xLANDED", block: 1, when_ts: OLD / 1000, payer: BUYER, usd: 0.001, asset: "USDC", external: 1 });

// --- a settlement the facilitator claimed but that never landed --------------
at(OLD, () => recordSale({ slug: "random", priceUsd: 0.001, rail: "usdc", network: "base", payer: BUYER, tx: "0xGHOST", synthetic: false }));

let r = await reconcileSettlements({ days: 7, now: NOW });
const base = r.chains.find((c) => c.chain === "base");
ok(base.claimed === 2, `both settlements counted as claimed (got ${base.claimed})`);
ok(base.confirmed === 1, `the transfer seen on-chain is confirmed (got ${base.confirmed})`);
ok(base.unconfirmed === 1, `the one that never landed is UNCONFIRMED (got ${base.unconfirmed})`);
ok(base.unconfirmedPct === 50, `reported as a RATE, not a dollar total (got ${base.unconfirmedPct}%)`);
ok(base.samples.length === 1 && base.samples[0].slug === "random", "an unconfirmed sample names the tool, so it is actionable");

// --- the grace window: a fresh settlement is PENDING, never "missing" --------
// A settle recorded seconds ago has not had time to be scanned. Counting it as
// unconfirmed would make every healthy run look like a leak.
at(NOW - 60_000, () => recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "base", payer: BUYER, tx: "0xFRESH", synthetic: false }));
r = await reconcileSettlements({ days: 7, now: NOW });
const base2 = r.chains.find((c) => c.chain === "base");
ok(base2.pending === 1, `a settlement inside the grace window is PENDING (got ${base2.pending})`);
ok(base2.unconfirmed === 1, "...and is NOT counted as unconfirmed (that would cry leak on every healthy run)");

// --- an unscanned chain is UNVERIFIABLE, never "clean" ----------------------
// The failure this repo keeps re-learning: an unreadable result treated as a
// good one. A chain with no cursor cannot be reconciled, and must say so.
at(OLD, () => recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "monad", payer: BUYER, tx: "0xNOSCAN", synthetic: false }));
r = await reconcileSettlements({ days: 7, now: NOW });
const monad = r.chains.find((c) => c.chain === "monad");
ok(monad.scanned === false, "a chain with no on-chain cursor is flagged scanned=false");
ok(monad.unconfirmed === 0 && monad.confirmed === 0, "...and its settlements are neither confirmed nor reported as missing");
ok(/NOT RECONCILED/.test(monad.note || ""), `...and the note says so plainly (got ${JSON.stringify(monad.note)})`);
ok(r.totals.unscannedChains.includes("monad"), "unscanned chains are named in the totals, not silently dropped");

// --- free rails carry no claim and must not enter the reconciliation ---------
at(OLD, () => recordSale({ slug: "hash", priceUsd: 0.001, rail: "pow", network: null, payer: null, tx: null, synthetic: false }));
r = await reconcileSettlements({ days: 7, now: NOW });
ok(!r.chains.some((c) => c.chain === "(unknown)" && c.claimed > 1),
  "a free proof-of-work call is not a settlement claim and never appears as one");

// --- a settlement with no tx is counted separately, not assumed good ---------
at(OLD, () => recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "solana", payer: null, tx: null, synthetic: false }));
r = await reconcileSettlements({ days: 7, now: NOW });
const sol = r.chains.find((c) => c.chain === "solana");
ok(sol.noTx === 1, `a receipt without a tx hash is counted as noTx (got ${sol.noTx})`);
ok(sol.confirmed === 0, "...and is NOT counted as confirmed - there is no claim to check");

// --- internal (canary/burner) traffic is our own money, not a leak ----------
at(OLD, () => recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: BUYER, tx: "0xINTERNAL", synthetic: true }));
r = await reconcileSettlements({ days: 7, now: NOW });
const base3 = r.chains.find((c) => c.chain === "base");
ok(base3.unconfirmed === 1, "a synthetic (canary) settlement is excluded - paying ourselves is not revenue to reconcile");

// --- the check must know when it is looking at NOTHING ----------------------
// The reconciliation reads the sales ledger off /data. If that volume were lost
// or never written, the join finds nothing and reports zero unconfirmed, which
// renders identically to a healthy service. That is this repo's oldest failure
// shape (a charged-failure alarm sat dead for months reporting success),
// reappearing inside the module built to avoid it. An independent counter in a
// different SQLite file decides.
{
  const { recordServedCall } = await import("../src/stats.js");
  // A window with settlements present is NOT blind, whatever the odometer says.
  let r = await reconcileSettlements({ days: 7, now: NOW });
  ok(r.blind === false && r.status === "ok", `a window with settlements to judge is not blind (status=${r.status})`);

  // Now the dangerous case: the odometer records paid calls, the ledger has
  // none to show for them — exactly what an emptied /data volume looks like.
  //
  // The odometer buckets by the REAL UTC day (recordServedCall stamps its own
  // clock), while every sale above was recorded against a frozen synthetic
  // clock years away. So a window around the real present contains the counter
  // and none of the sales, which is the blind case with no mocking needed.
  recordServedCall("hash", "usdc", "eip155:8453");
  r = await reconcileSettlements({ days: 1, now: realNow() });
  ok(r.totals.claimed === 0, "the empty window genuinely has nothing to reconcile");
  ok(r.blind === true, "...and that is reported as BLIND, not as a clean zero");
  ok(r.status === "BLIND", `...on a top-level status field an alarm can read (got ${r.status})`);
  ok(/looking at nothing/.test(r.blindReason || ""),
    `...with a reason that distinguishes it from finding nothing wrong (got ${JSON.stringify(r.blindReason)})`);
  ok(r.paidCallsInWindow > 0, `...naming the independent counter that contradicts it (${r.paidCallsInWindow})`);
  ok(r.counterReadable === true, "...and reports that the cross-check counter was readable");
}

// --- an UNREADABLE cross-check is not a clean result either ------------------
// The first cut of the blindness guard stored the unreadable case as -1 and
// then tested `> 0`, so a dead counter fell straight through to status "ok" -
// this module's own failure mode, reintroduced inside the fix for it, three
// lines below a comment promising otherwise. If the counter cannot be read AND
// there is nothing to judge, "no traffic" and "no data" are indistinguishable
// and the result must say so.
{
  const dead = () => { throw new Error("daily_calls unreadable"); };
  // Nothing to judge AND no way to cross-check: must be BLIND.
  let r = await reconcileSettlements({ days: 1, now: realNow(), dailyCalls: dead });
  ok(r.counterReadable === false, `an unreadable counter is reported as such (got ${r.counterReadable})`);
  ok(r.blind === true, "...and a window with nothing to judge is BLIND, never ok");
  ok(r.status === "BLIND", `...on the top-level status too (got ${r.status})`);
  ok(/cannot be told apart/.test(r.blindReason || ""),
    `...with a reason naming the ambiguity (got ${JSON.stringify(r.blindReason)})`);

  // ...but an unreadable counter is NOT blindness when there ARE settlements to
  // judge: the cross-check only exists to catch an empty ledger, so it must not
  // invalidate a window that plainly has data.
  r = await reconcileSettlements({ days: 7, now: NOW, dailyCalls: dead });
  ok(r.totals.claimed > 0 && r.blind === false,
    `a window with real settlements survives an unreadable counter (claimed=${r.totals.claimed}, blind=${r.blind})`);
}

// --- Solana: an unmatched row is confirmed by its signature first -----------
// The revenue ledger can trail the chain (a scan page behind, a history read
// that failed), so a Solana settlement missing from it is read on chain by its
// signature before it is counted unconfirmed. Confirmed there = matched; not
// found = unconfirmed; a read that fails leaves the row as it was and never
// moves the top-level status. Stubbed reader: no network.
{
  const { SOLANA_CONFIRM_BATCH_MAX } = await import("../src/settlement-reconcile.js");
  const SOL_NOW = NOW + 30 * 86_400_000; // a window that holds only this section's rows
  const SOL_OLD = SOL_NOW - 3 * 3600_000;
  // The chain is scanned: one transfer seen, matched by the ledger directly.
  recordTransfer({ chain: "solana", wallet: "w", txid: "SIG_LEDGER:0", tx_hash: "SIG_LEDGER", block: 1, when_ts: SOL_OLD / 1000, payer: "P", usd: 0.001, asset: "USDC", external: 1 });
  at(SOL_OLD, () => recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "solana", payer: "P", tx: "SIG_LEDGER", synthetic: false }));
  at(SOL_OLD, () => recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "solana", payer: "P", tx: "SIG_LANDED", synthetic: false }));
  at(SOL_OLD, () => recordSale({ slug: "random", priceUsd: 0.002, rail: "usdc", network: "solana", payer: "P", tx: "SIG_MISSING", synthetic: false }));
  at(SOL_OLD, () => recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "solana", payer: "P", tx: "SIG_FAILED", synthetic: false }));
  const onChain = {
    SIG_LANDED: { slot: 9, confirmations: null, err: null, confirmationStatus: "finalized" },
    SIG_FAILED: { slot: 9, confirmations: null, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "finalized" },
  };
  const calls = [];
  const reader = async (sigs) => { calls.push([...sigs]); return sigs.map((s) => onChain[s] || null); };
  const pass = (o = {}) => reconcileSettlements({ days: 1, now: SOL_NOW, dailyCalls: () => [], ...o });

  let r = await pass({ confirmSignatures: reader });
  let sol = r.chains.find((c) => c.chain === "solana");
  ok(calls.length === 1 && calls[0].length === 3 && !calls[0].includes("SIG_LEDGER"),
    `only the rows the ledger lacks are read, in one batch (got ${JSON.stringify(calls)})`);
  ok(sol.confirmed === 2, `a signature confirmed on chain is matched, not unconfirmed (confirmed=${sol.confirmed})`);
  ok(sol.unconfirmed === 2, `not found, and found but failed, stay unconfirmed (unconfirmed=${sol.unconfirmed})`);
  ok(sol.unconfirmedUsd === 0.003, `the unconfirmed amount drops the matched row (got ${sol.unconfirmedUsd})`);
  ok(!sol.samples.some((s) => s.slug === "uuid"), "a matched row is not listed as an unconfirmed sample");
  ok(sol.signatureReads && sol.signatureReads.matched === 1 && sol.signatureReads.notFound === 1 && sol.signatureReads.failedOnChain === 1 && sol.signatureReads.unread === 0,
    `the per-signature reads are counted on the chain (got ${JSON.stringify(sol.signatureReads)})`);
  ok(r.status === "ok", `a pass with reads that answered reads ok (got ${r.status})`);

  // RPC down: every row stays as it was, the status word does not move.
  calls.length = 0;
  const down = async (sigs) => { calls.push([...sigs]); throw new Error("all 2 RPCs failed - timeout"); };
  r = await pass({ confirmSignatures: down });
  sol = r.chains.find((c) => c.chain === "solana");
  ok(sol.confirmed === 1 && sol.unconfirmed === 3,
    `a failed read leaves every row as it was: neither matched nor dropped (confirmed=${sol.confirmed}, unconfirmed=${sol.unconfirmed})`);
  ok(sol.signatureReads.readsFailed === 1 && sol.signatureReads.unread === 3,
    `...and the rows it could not read are counted as unread (got ${JSON.stringify(sol.signatureReads)})`);
  ok(r.status === "ok" && r.blind === false, `our own RPC failure never moves the status word (got ${r.status})`);

  // A malformed answer (wrong length) is a failed read too, never a verdict.
  r = await pass({ confirmSignatures: async () => [null] });
  sol = r.chains.find((c) => c.chain === "solana");
  ok(sol.confirmed === 1 && sol.unconfirmed === 3 && sol.signatureReads.readsFailed === 1,
    `an answer that does not cover the batch is a failed read (got ${JSON.stringify(sol.signatureReads)})`);

  // Batch size and the pass budget: 3 rows, batches of 2, one read allowed.
  calls.length = 0;
  r = await pass({ confirmSignatures: reader, solanaBatchSize: 2, solanaMaxReads: 1 });
  sol = r.chains.find((c) => c.chain === "solana");
  ok(calls.length === 1 && calls[0].length === 2, `a pass makes at most its read budget, each at most the batch size (got ${JSON.stringify(calls)})`);
  ok(sol.signatureReads.reads === 1 && sol.signatureReads.unread === 1,
    `rows past the budget are unread and stay as they were (got ${JSON.stringify(sol.signatureReads)})`);
  ok(sol.confirmed + sol.unconfirmed === 4, "every judged row is still in exactly one bucket");

  // Batches of 2 with budget: the three rows take two reads.
  calls.length = 0;
  r = await pass({ confirmSignatures: reader, solanaBatchSize: 2, solanaMaxReads: 5 });
  ok(calls.length === 2 && calls.every((c) => c.length <= 2), `rows are read in batches of the batch size (got ${JSON.stringify(calls)})`);
  ok(r.chains.find((c) => c.chain === "solana").confirmed === 2, "...and the result matches the single-batch pass");

  // The batch size is held to the RPC method's own limit (a window with more
  // unmatched rows than one call may carry).
  {
    const BIG_NOW = SOL_NOW + 30 * 86_400_000;
    for (let i = 0; i < SOLANA_CONFIRM_BATCH_MAX + 4; i++) {
      at(BIG_NOW - 3 * 3600_000, () => recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "solana", payer: "P", tx: `SIG_BULK_${i}`, synthetic: false }));
    }
    calls.length = 0;
    await reconcileSettlements({ days: 1, now: BIG_NOW, dailyCalls: () => [], confirmSignatures: reader, solanaBatchSize: 10_000 });
    ok(SOLANA_CONFIRM_BATCH_MAX <= 256 && calls.length === 2 && calls[0].length === SOLANA_CONFIRM_BATCH_MAX && calls[1].length === 4,
      `a batch never exceeds the method's signature limit (got ${calls.map((c) => c.length).join(",")})`);
  }

  // A budget of zero reads nothing and leaves every row as it was.
  calls.length = 0;
  r = await pass({ confirmSignatures: reader, solanaMaxReads: 0 });
  ok(calls.length === 0 && r.chains.find((c) => c.chain === "solana").unconfirmed === 3, "a zero budget makes no read and changes no row");

  // Another chain's unmatched rows are never read by signature.
  calls.length = 0;
  await reconcileSettlements({ days: 7, now: NOW, confirmSignatures: reader });
  ok(calls.length === 0, "a window with no unmatched Solana row makes no read");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
