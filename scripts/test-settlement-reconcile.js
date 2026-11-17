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

// --- Solana: an unmatched row is matched on chain only when it paid us ------
// The revenue ledger can trail the chain (a scan page behind, a history read
// that failed), so a Solana settlement missing from it is read on chain before
// it is counted unconfirmed. A landed signature is not enough: the transaction
// must raise our payTo's USDC by the row's amount, and one signature pays for
// one row. Stubbed readers: no network.
{
  const { createHash } = await import("node:crypto");
  const { SOLANA_CONFIRM_BATCH_MAX, isSolanaSignature } = await import("../src/settlement-reconcile.js");
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const b58 = (buf) => {
    let n = BigInt("0x" + buf.toString("hex")), s = "";
    while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    for (const b of buf) { if (b === 0) s = "1" + s; else break; }
    return s;
  };
  const sig = (label) => b58(createHash("sha512").update(label).digest());
  const S = Object.fromEntries(["LEDGER", "LANDED", "MISSING", "FAILED", "UNRELATED", "WRONGTO", "CASEFOLD", "SHORT", "DUP", "PROCESSED"].map((k) => [k, sig(k)]));
  ok(Object.values(S).every(isSolanaSignature), "the fixture signatures are well-formed base58");

  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const PAYTO = "Pay2ourWa11etXyzABCDEFGHJKLMNPQRSTUVWXYZabc";
  const OTHER = "0therWa11etXyzABCDEFGHJKLMNPQRSTUVWXYZabcde";
  const SOL_NOW = NOW + 30 * 86_400_000; // a window that holds only this section's rows
  const SOL_OLD = SOL_NOW - 3 * 3600_000;
  const credit = (owner, atomic, { mint = USDC, blockTime = SOL_OLD / 1000 } = {}) => ({ blockTime, meta: { err: null,
    preTokenBalances: [{ owner, mint, uiTokenAmount: { amount: "5000" } }, { owner: "Buyer", mint, uiTokenAmount: { amount: "90000" } }],
    postTokenBalances: [{ owner, mint, uiTokenAmount: { amount: String(5000 + atomic) } }, { owner: "Buyer", mint, uiTokenAmount: { amount: String(90000 - atomic) } }] } });
  const LAND = { slot: 9, confirmations: null, err: null, confirmationStatus: "finalized" };
  const onChain = {
    [S.LANDED]: LAND, [S.UNRELATED]: LAND, [S.WRONGTO]: LAND, [S.CASEFOLD]: LAND, [S.SHORT]: LAND, [S.DUP]: LAND,
    [S.FAILED]: { slot: 9, confirmations: null, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "finalized" },
    [S.PROCESSED]: { slot: 9, confirmations: 0, err: null, confirmationStatus: "processed" },
  };
  const txs = {
    [S.LANDED]: credit(PAYTO, 1000),
    [S.UNRELATED]: { blockTime: SOL_OLD / 1000, meta: { err: null, preTokenBalances: [], postTokenBalances: [] } }, // a real transaction that moved no USDC
    [S.WRONGTO]: credit(OTHER, 1000),
    [S.CASEFOLD]: credit(PAYTO.toLowerCase(), 1000),  // base58 is case-sensitive: not our account
    [S.SHORT]: credit(PAYTO, 1000),                    // the row claims 0.002
    [S.DUP]: credit(PAYTO, 1000),
  };

  recordTransfer({ chain: "solana", wallet: "w", txid: `${S.LEDGER}:0`, tx_hash: S.LEDGER, block: 1, when_ts: SOL_OLD / 1000, payer: "P", usd: 0.001, asset: "USDC", external: 1 });
  const sale = (slug, usd, tx) => at(SOL_OLD, () => recordSale({ slug, priceUsd: usd, rail: "usdc", network: "solana", payer: "P", tx, synthetic: false }));
  sale("hash", 0.001, S.LEDGER);
  sale("uuid", 0.001, S.LANDED);
  sale("random", 0.002, S.MISSING);
  sale("hash", 0.001, S.FAILED);
  sale("unrelated", 0.001, S.UNRELATED);
  sale("wrongto", 0.001, S.WRONGTO);
  sale("casefold", 0.001, S.CASEFOLD);
  sale("short", 0.002, S.SHORT);
  sale("dup", 0.001, S.DUP);
  sale("dup", 0.001, S.DUP);
  sale("processed", 0.001, S.PROCESSED);
  sale("malformed", 0.001, "not-a-signature");

  const calls = [], txCalls = [];
  const reader = async (sigs) => {
    if (sigs.some((s) => !isSolanaSignature(s))) throw new Error("Invalid param: not a signature"); // the whole batch fails, as the RPC does
    calls.push([...sigs]); return sigs.map((s) => onChain[s] || null);
  };
  const txReader = async (s) => { txCalls.push(s); return txs[s] ?? null; };
  const pass = (o = {}) => reconcileSettlements({ days: 1, now: SOL_NOW, dailyCalls: () => [], readTransaction: txReader, solanaPayTo: PAYTO, ...o });
  const solOf = (r) => r.chains.find((c) => c.chain === "solana");

  let r = await pass({ confirmSignatures: reader });
  let sol = solOf(r);
  let rd = sol.signatureReads;
  ok(calls.length === 1 && calls[0].length === 9 && !calls[0].includes(S.LEDGER) && new Set(calls[0]).size === 9,
    `only the rows the ledger lacks are read, each signature once, in one batch (got ${calls.map((c) => c.length)})`);
  ok(rd.notSignature === 1 && rd.readsFailed === 0, `a malformed tx is never sent, so its batch still reads (got ${JSON.stringify(rd)})`);
  ok(sol.confirmed === 3, `the ledger row, the correct transfer and the first claim of a shared signature are confirmed (confirmed=${sol.confirmed})`);
  ok(sol.claimed === 12 && sol.unconfirmed === 9, `every other row stays unconfirmed (unconfirmed=${sol.unconfirmed})`);
  ok(!sol.samples.some((s) => s.slug === "uuid"), "a matched row is not listed as an unconfirmed sample");
  ok(rd.matched === 2 && rd.transferMismatch === 4 && rd.duplicate === 1,
    `an unrelated signature, the wrong recipient, a case-folded owner and a short amount do not match; a reused signature counts once (got ${JSON.stringify(rd)})`);
  ok(rd.notFound === 1 && rd.failedOnChain === 1, `not found and failed on chain stay unconfirmed (got ${JSON.stringify(rd)})`);
  ok(rd.unread === 1 && !txCalls.includes(S.PROCESSED), `a processed (not yet confirmed) signature is unread and never matched (got unread=${rd.unread})`);
  ok(txCalls.length === 6 && rd.txReads === 6 && rd.landedUnverified === 0 && sol.landedUnverified === 0,
    `each landed signature's transaction is read once (got ${txCalls.length})`);
  ok(rd.deadlineHit === false, "a pass inside its deadline says so");
  ok(r.status === "ok", `a pass with reads that answered reads ok (got ${r.status})`);
  const base = { confirmed: sol.confirmed, unconfirmed: sol.unconfirmed };

  // A landed signature whose transaction cannot be read is never confirmed.
  txCalls.length = 0;
  r = await pass({ confirmSignatures: reader, readTransaction: async () => { throw new Error("all 2 RPCs failed"); } });
  sol = solOf(r);
  ok(sol.confirmed === 1 && sol.unconfirmed === 11 && sol.signatureReads.landedUnverified === 6 && sol.landedUnverified === 6 && r.totals.landedUnverified === 6,
    `a failed transaction read leaves landed rows landedUnverified, never confirmed (got ${JSON.stringify(sol.signatureReads)})`);
  r = await pass({ confirmSignatures: reader, readTransaction: async () => null });
  ok(solOf(r).confirmed === 1 && solOf(r).signatureReads.landedUnverified === 6, "a transaction not found is landedUnverified too");
  txCalls.length = 0;
  r = await pass({ confirmSignatures: reader, solanaPayTo: null });
  ok(solOf(r).confirmed === 1 && solOf(r).signatureReads.landedUnverified === 6 && txCalls.length === 0,
    "with no payTo to check against, nothing is read and nothing landed is confirmed");
  txCalls.length = 0;
  r = await pass({ confirmSignatures: reader, solanaVerifyMaxReads: 1 });
  ok(txCalls.length === 1 && solOf(r).signatureReads.landedUnverified === 5, `the transaction-read budget holds (got ${txCalls.length})`);

  // RPC down: every row stays as it was, the status word does not move.
  calls.length = 0;
  const down = async (sigs) => { calls.push([...sigs]); throw new Error("all 2 RPCs failed - timeout"); };
  r = await pass({ confirmSignatures: down });
  sol = solOf(r);
  ok(sol.confirmed === 1 && sol.unconfirmed === 11,
    `a failed read leaves every row as it was: neither matched nor dropped (confirmed=${sol.confirmed}, unconfirmed=${sol.unconfirmed})`);
  ok(sol.signatureReads.readsFailed === 1 && sol.signatureReads.unread === 9,
    `...and the rows it could not read are counted as unread (got ${JSON.stringify(sol.signatureReads)})`);
  ok(r.status === "ok" && r.blind === false, `our own RPC failure never moves the status word (got ${r.status})`);

  // A malformed answer (wrong length) is a failed read too, never a verdict.
  r = await pass({ confirmSignatures: async () => [null] });
  sol = solOf(r);
  ok(sol.confirmed === 1 && sol.unconfirmed === 11 && sol.signatureReads.readsFailed === 1,
    `an answer that does not cover the batch is a failed read (got ${JSON.stringify(sol.signatureReads)})`);

  // Batch size and the pass budget: nine signatures, batches of 2, one read allowed.
  calls.length = 0;
  r = await pass({ confirmSignatures: reader, solanaBatchSize: 2, solanaMaxReads: 1 });
  sol = solOf(r);
  ok(calls.length === 1 && calls[0].length === 2, `a pass makes at most its read budget, each at most the batch size (got ${JSON.stringify(calls.map((c) => c.length))})`);
  ok(sol.signatureReads.reads === 1 && sol.signatureReads.unread === 7,
    `rows past the budget are unread and stay as they were (got ${JSON.stringify(sol.signatureReads)})`);
  ok(sol.confirmed + sol.unconfirmed === 12, "every judged row is still in exactly one bucket");

  calls.length = 0;
  r = await pass({ confirmSignatures: reader, solanaBatchSize: 2, solanaMaxReads: 5 });
  ok(calls.length === 5 && calls.every((c) => c.length <= 2), `rows are read in batches of the batch size (got ${JSON.stringify(calls.map((c) => c.length))})`);
  ok(solOf(r).confirmed === base.confirmed && solOf(r).unconfirmed === base.unconfirmed, "...and the result matches the single-batch pass");

  // The pass deadline: a status read that never answers ends at the deadline.
  let t0 = Date.now();
  r = await pass({ confirmSignatures: () => new Promise(() => {}), solanaDeadlineMs: 300 });
  let ms = Date.now() - t0;
  sol = solOf(r);
  ok(ms < 2000 && sol.signatureReads.deadlineHit === true && sol.signatureReads.unread === 9 && sol.confirmed === 1,
    `a hanging status read is cut at the pass deadline and its rows are unread (${ms} ms, ${JSON.stringify(sol.signatureReads)})`);
  // ...and a later batch never starts once the deadline has passed.
  calls.length = 0;
  let first = true;
  const slowOnce = async (sigs) => { if (first) { first = false; await new Promise((res) => setTimeout(res, 400)); } return reader(sigs); };
  r = await pass({ confirmSignatures: slowOnce, solanaBatchSize: 2, solanaDeadlineMs: 200 });
  sol = solOf(r);
  ok(calls.length === 0 && sol.signatureReads.reads === 1 && sol.signatureReads.unread === 9 && sol.signatureReads.deadlineHit,
    `no batch starts past the deadline (got ${JSON.stringify(sol.signatureReads)})`);
  // The deadline is the timer's, not a later clock read: a timer can fire a
  // millisecond before the wall clock reaches the deadline, so a reader that
  // holds the clock still (the worst case of that lag) must still end the pass.
  const stillClock = (fn) => (...a) => { const f = realNow(); Date.now = () => f; return fn(...a); };
  calls.length = 0;
  try {
    r = await pass({ confirmSignatures: stillClock(() => new Promise(() => {})), solanaBatchSize: 2, solanaDeadlineMs: 300 });
  } finally { Date.now = realNow; }
  sol = solOf(r);
  ok(sol.signatureReads.reads === 1 && sol.signatureReads.unread === 9 && sol.signatureReads.deadlineHit === true,
    `a status read cut by the deadline timer ends the pass even when the clock lags (got ${JSON.stringify(sol.signatureReads)})`);
  try {
    r = await pass({ confirmSignatures: reader, readTransaction: stillClock(() => new Promise(() => {})), solanaDeadlineMs: 300 });
  } finally { Date.now = realNow; }
  sol = solOf(r);
  ok(sol.signatureReads.txReads === 4 && sol.signatureReads.landedUnverified === 6 && sol.signatureReads.deadlineHit === true,
    `a transaction read cut by the deadline timer starts no further read even when the clock lags (got ${JSON.stringify(sol.signatureReads)})`);
  // A transaction read that never answers ends at the deadline too.
  t0 = Date.now();
  r = await pass({ confirmSignatures: reader, readTransaction: () => new Promise(() => {}), solanaDeadlineMs: 300 });
  ms = Date.now() - t0;
  sol = solOf(r);
  ok(ms < 2000 && sol.signatureReads.landedUnverified === 6 && sol.confirmed === 1 && sol.signatureReads.deadlineHit,
    `hanging transaction reads end at the pass deadline, landedUnverified (${ms} ms, ${JSON.stringify(sol.signatureReads)})`);

  // The default reader's RPC call honors the deadline across lanes: three
  // lanes that accept and never answer, six seconds each, end at the deadline.
  {
    const { createServer } = await import("node:http");
    const { rpcCall } = await import("../src/revenue-live.js");
    const servers = [];
    for (let i = 0; i < 3; i++) {
      const s = createServer(() => {}); // never answers
      await new Promise((res) => s.listen(0, "127.0.0.1", res));
      servers.push(s);
    }
    const urls = servers.map((s) => `http://127.0.0.1:${s.address().port}/`);
    t0 = Date.now();
    let err = null;
    try { await rpcCall(urls, "getSignatureStatuses", [[S.LANDED]], 6000, { deadline: Date.now() + 400 }); } catch (e) { err = e; }
    ms = Date.now() - t0;
    ok(err && ms < 2000, `rpcCall stops at its deadline across hanging lanes (${ms} ms)`);
    for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  }

  // The batch size is held to the RPC method's own limit (a window with more
  // unmatched rows than one call may carry).
  {
    const BIG_NOW = SOL_NOW + 30 * 86_400_000;
    for (let i = 0; i < SOLANA_CONFIRM_BATCH_MAX + 4; i++) {
      at(BIG_NOW - 3 * 3600_000, () => recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "solana", payer: "P", tx: sig(`BULK_${i}`), synthetic: false }));
    }
    calls.length = 0;
    await reconcileSettlements({ days: 1, now: BIG_NOW, dailyCalls: () => [], confirmSignatures: reader, readTransaction: txReader, solanaPayTo: PAYTO, solanaBatchSize: 10_000 });
    ok(SOLANA_CONFIRM_BATCH_MAX <= 256 && calls.length === 2 && calls[0].length === SOLANA_CONFIRM_BATCH_MAX && calls[1].length === 4,
      `a batch never exceeds the method's signature limit (got ${calls.map((c) => c.length).join(",")})`);
  }

  // The transfer itself must be this row's payment: our USDC (not another
  // mint), a body that carries both balance lists, and a block time near the
  // row's own. Its own window, so the counts above stay as they are.
  {
    const { SOLANA_TX_TIME_WINDOW_MS } = await import("../src/settlement-reconcile.js");
    const W_NOW = SOL_NOW + 60 * 86_400_000;
    const W_OLD = W_NOW - 3 * 3600_000;
    const T = Object.fromEntries(["GOOD", "MINT", "NOPRE", "NOPOST", "EARLY", "LATE", "NOTIME", "EDGE"].map((k) => [k, sig(`WIN_${k}`)]));
    const OTHER_MINT = "AnotherMintXyzABCDEFGHJKLMNPQRSTUVWXYZabcde";
    const good = credit(PAYTO, 1000, { blockTime: W_OLD / 1000 });
    const wtx = {
      [T.GOOD]: good,
      [T.MINT]: credit(PAYTO, 1000, { mint: OTHER_MINT, blockTime: W_OLD / 1000 }), // our owner, another token
      [T.NOPRE]: { blockTime: W_OLD / 1000, meta: { err: null, postTokenBalances: good.meta.postTokenBalances } },
      [T.NOPOST]: { blockTime: W_OLD / 1000, meta: { err: null, preTokenBalances: good.meta.preTokenBalances } },
      [T.EARLY]: credit(PAYTO, 1000, { blockTime: (W_OLD - 3600_000) / 1000 }),    // a real, earlier transfer into our payTo
      [T.LATE]: credit(PAYTO, 1000, { blockTime: (W_OLD + SOLANA_TX_TIME_WINDOW_MS + 60_000) / 1000 }),
      [T.NOTIME]: credit(PAYTO, 1000, { blockTime: null }),
      [T.EDGE]: credit(PAYTO, 1000, { blockTime: (W_OLD - SOLANA_TX_TIME_WINDOW_MS + 1000) / 1000 }), // inside the window
    };
    for (const k of Object.keys(T)) at(W_OLD, () => recordSale({ slug: k.toLowerCase(), priceUsd: 0.001, rail: "usdc", network: "solana", payer: "P", tx: T[k], synthetic: false }));
    const wr = await reconcileSettlements({ days: 1, now: W_NOW, dailyCalls: () => [],
      confirmSignatures: async (sigs) => sigs.map(() => LAND), readTransaction: async (s) => wtx[s] ?? null, solanaPayTo: PAYTO });
    const ws = solOf(wr), wd = ws.signatureReads;
    ok(SOLANA_TX_TIME_WINDOW_MS >= 60_000 && SOLANA_TX_TIME_WINDOW_MS <= 15 * 60_000, `the time window is minutes wide (${SOLANA_TX_TIME_WINDOW_MS} ms)`);
    ok(ws.confirmed === 2 && wd.matched === 2, `only the in-window transfers of our USDC match (got ${JSON.stringify(wd)})`);
    ok(wd.transferMismatch === 1, `our owner credited in another mint does not match (got ${JSON.stringify(wd)})`);
    ok(wd.landedUnverified === 5 && ws.unconfirmed === 6,
      `a body missing either balance list, a transfer outside the row's time and one with no block time are landedUnverified (got ${JSON.stringify(wd)})`);
    ok(!ws.samples.some((x) => x.slug === "good" || x.slug === "edge"), "the matched rows are not listed as unconfirmed");
  }

  // A budget of zero reads nothing and leaves every row as it was.
  calls.length = 0;
  r = await pass({ confirmSignatures: reader, solanaMaxReads: 0 });
  ok(calls.length === 0 && solOf(r).unconfirmed === 11, "a zero budget makes no read and changes no row");

  // Another chain's unmatched rows are never read by signature.
  calls.length = 0;
  await reconcileSettlements({ days: 7, now: NOW, confirmSignatures: reader });
  ok(calls.length === 0, "a window with no unmatched Solana row makes no read");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
