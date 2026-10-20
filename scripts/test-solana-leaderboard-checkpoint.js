#!/usr/bin/env node
// Solana board scans survive a restart (src/solana-leaderboard.js). Offline:
// an in-memory chain plays the RPC; one payTo's read never answers, which is
// what a scan looks like from the inside when the container is replaced
// under it.
//
//   * a scan cut off part-way leaves the cursors of every payTo it already
//     read in the store (a checkpoint, not only the end-of-scan save), and a
//     boot from that store continues: those payTos' transactions are not read
//     again, the backfill resumes at its cursor, nothing is counted twice
//   * a scan starts from the newest stored cursors, not the board it booted
//     with, when a checkpoint postdates them
//   * the drain checkpoint saves during a scan and does nothing outside one
//   * a transaction read that fails the same way scan after scan is skipped
//     visibly, so that payTo's history closes instead of staying open forever
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const guard = setTimeout(() => { console.error("FAIL - the suite did not finish in time (a scan or a read hung)"); process.exit(1); }, 90_000);

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const P1 = "Pay1111111111111111111111111111111111111111";
const P2 = "Pay2222222222222222222222222222222222222222";
const P3 = "Pay3333333333333333333333333333333333333333";
const P4 = "Pay4444444444444444444444444444444444444444";
const FILE = join(mkdtempSync(join(tmpdir(), "solana-lb-ck-")), "lb.json");
process.env.SOLANA_LB_CACHE_FILE = FILE;
process.env.SOLANA_LB_CHECKPOINT_MS = "0";          // every payTo checkpoints (the interval has no part in the mechanism)
process.env.SOLANA_LB_BACKFILL_TX_PER_CYCLE = "4000";
process.env.SOLANA_LB_RETRY_PAUSE_MS = "0";

const lb = await import("../src/solana-leaderboard.js");
const { creditFromTx } = await import("../src/solana-buyer.js");

const nowSec = Math.floor(Date.now() / 1000);
const mkChain = (tag, n, startSec, stepSec) => Array.from({ length: n }, (_, i) => ({ signature: `${tag}${n - i}`, blockTime: startSec - i * stepSec, err: null, buyer: `Buyer${(n - i) % 50}`, amount: 1000 + ((n - i) % 7) }));
// P1: 30 payments in the last hour. P2: 5,000 in the last ~14 hours, past one
// cycle's backfill allowance. P3: no USDC account. P4: 10 payments.
const chains = new Map([[P1, mkChain("a", 30, nowSec - 5, 60)], [P2, mkChain("b", 5000, nowSec - 5, 10)], [P4, mkChain("d", 10, nowSec - 5, 60)]]);
const txOf = new Map();
for (const [payTo, chain] of chains) for (const x of chain) txOf.set(x.signature, { payTo, x });

/** The chain as an RPC. `hang` names payTos whose account and signature reads never answer; `failTx(sig)` makes a read throw. */
function chainRpc({ hang = new Set(), failTx = null } = {}) {
  const calls = { sig: 0, tx: 0, acct: 0, hung: 0, txBy: new Map() };
  const hangIt = () => { calls.hung++; return new Promise(() => {}); };
  const fn = async (method, params) => {
    if (method === "getTokenAccountsByOwner") {
      calls.acct++;
      if (hang.has(params[0])) return hangIt();
      return chains.has(params[0]) ? { value: [{ pubkey: `ATA-${params[0]}` }] } : { value: [] };
    }
    if (method === "getSignaturesForAddress") {
      const payTo = params[0].slice(4);
      if (hang.has(payTo)) return hangIt();
      calls.sig++;
      const chain = chains.get(payTo) || [];
      const { limit = 1000, before, until } = params[1] || {};
      let i = before ? chain.findIndex((x) => x.signature === before) + 1 : 0;
      const out = [];
      for (; i < chain.length && out.length < limit; i++) { if (chain[i].signature === until) break; out.push(chain[i]); }
      return out.map(({ signature, blockTime, err }) => ({ signature, blockTime, err }));
    }
    if (method === "getTransaction") {
      calls.tx++;
      const t = txOf.get(params[0]);
      calls.txBy.set(t.payTo, (calls.txBy.get(t.payTo) || 0) + 1);
      if (failTx && failTx(params[0])) throw new Error("solana history read failed on every lane");
      const { payTo, x } = t;
      return { blockTime: x.blockTime, meta: { err: null,
        preTokenBalances: [{ accountIndex: 0, mint: USDC, owner: payTo, uiTokenAmount: { amount: "0" } }, { accountIndex: 1, mint: USDC, owner: x.buyer, uiTokenAmount: { amount: "999999" } }],
        postTokenBalances: [{ accountIndex: 0, mint: USDC, owner: payTo, uiTokenAmount: { amount: String(x.amount) } }, { accountIndex: 1, mint: USDC, owner: x.buyer, uiTokenAmount: { amount: String(999999 - x.amount) } }] } };
    }
    throw new Error("unknown " + method);
  };
  return { fn, calls };
}
const listPayTos = async () => new Map([[P1, new Set(["https://one.example"])], [P2, new Set(["https://two.example"])], [P3, new Set(["https://three.example"])], [P4, new Set(["https://four.example"])]]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stored = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : null);

// ---- 1. a scan cut off part-way: the cursors already advanced are stored ----
{
  const { fn, calls } = chainRpc({ hang: new Set([P4]) });
  const running = lb.refreshSolanaLeaderboard({ listPayTos, rpc: fn, creditFromTx, prime: () => {}, windowHours: 168 });
  // P1, P2 and P3 are read; P4's account read then hangs for good, which is
  // the scan as a restart leaves it: the refresh promise never settles. The
  // backfill allowance (4,000 a scan) is shared: P1's 30 reads leave 3,970 for P2.
  for (let i = 0; i < 400 && calls.hung < 1; i++) await sleep(25);
  await sleep(50);
  ok(calls.hung === 1 && calls.acct === 4 && calls.tx === 4000, `three payTos read before the cut (${calls.tx} transaction reads: P1's 30 and 3,970 of P2's 5,000)`);
  const doc = stored();
  const st = doc?.state || {};
  ok(!!doc && st[P1]?.lastSig === "a30" && st[P1]?.bfDone === true, `the store holds P1's cursor and finished backfill before the scan ends (${doc ? JSON.stringify({ lastSig: st[P1]?.lastSig, bfDone: st[P1]?.bfDone }) : "no document written"})`);
  ok(st[P2]?.lastSig === "b5000" && st[P2]?.bfBefore === "b1031" && !st[P2]?.bfDone, `P2's backfill cursor is stored where the allowance stopped (${JSON.stringify({ lastSig: st[P2]?.lastSig, bfBefore: st[P2]?.bfBefore })})`);
  ok(st[P3]?.ata === null && Number(st[P3]?.ataCheckedAt) > 0, "the payTo with no USDC account is stored as checked");
  ok(Array.isArray(doc?.rows) && doc.rows.length === 0 && Number(doc?.stateAt) > 0, "the board itself is not replaced by a checkpoint (no rows yet): only the cursors move, dated by stateAt");
  ok(doc?.state?.[P4] === undefined || !doc.state[P4].lastSig, "the payTo cut off mid-read has no cursor stored (nothing of it was folded)");
  void running;
}

// ---- 2. the next boot continues from the checkpoint --------------------------
{
  lb.__resetSolanaLeaderboardForTest();
  ok(lb.loadPersistedSolanaLeaderboard() === true && lb._stateForTest()[P2]?.bfBefore === "b1031", "a boot from the store warm-starts the cursors of the cut-off scan");
  const { fn, calls } = chainRpc();
  await lb.refreshSolanaLeaderboard({ listPayTos, rpc: fn, creditFromTx, prime: () => {}, windowHours: 168 });
  ok(calls.txBy.get(P1) === undefined && calls.txBy.get(P2) === 1030 && calls.txBy.get(P4) === 10, `the scan after the restart reads only what was not yet read: P1 none, P2's remaining 1,030, P4's 10 (${JSON.stringify([...calls.txBy])})`);
  const snap = lb.getSolanaLeaderboardSnapshot({ window: "24h" });
  const by = Object.fromEntries(snap.rows.map((r) => [r.payTo, r]));
  ok(by[P1].inboundTransfers === 30 && by[P2].inboundTransfers === 5000 && by[P4].inboundTransfers === 10, `every payment counted exactly once across the cut (${by[P1].inboundTransfers}, ${by[P2].inboundTransfers}, ${by[P4].inboundTransfers})`);
  ok(snap.windowComplete === true && snap.backfilling === 0, `the window completes once the backfill resumes at its cursor (complete ${snap.windowComplete}, backfilling ${snap.backfilling})`);
  const doc = stored();
  ok(doc.rows.length === 4 && doc.state[P2].bfDone === true && Number(doc.stateAt) >= Number(doc.at), "the finished scan stores the board with its cursors, stateAt at or after at");
}

// ---- 3. a scan starts from newer stored cursors, not the board it booted with
{
  // The store moves on (the other container's checkpoint): P2 gains 100
  // payments it has already folded, cursor included.
  const doc = stored();
  const extra = mkChain("e", 100, nowSec + 100, 1);
  chains.set(P2, [...extra, ...chains.get(P2)]);
  for (const x of extra) txOf.set(x.signature, { payTo: P2, x });
  doc.state[P2].lastSig = extra[0].signature;
  doc.stateAt = Date.now() + 1;
  writeFileSync(FILE, JSON.stringify(doc));
  const { fn, calls } = chainRpc();
  await lb.refreshSolanaLeaderboard({ listPayTos, rpc: fn, creditFromTx, prime: () => {}, windowHours: 168 });
  ok(calls.txBy.get(P2) === undefined, `the scan took the newer cursor from the store and read none of P2's folded payments again (${calls.txBy.get(P2) || 0} reads)`);
  ok(lb.getSolanaLeaderboardSnapshot({ window: "24h" }).rows.find((r) => r.payTo === P2).inboundTransfers === 5000, "and its hours came with the cursor, so nothing is double counted");
}

// ---- 4. the drain checkpoint ------------------------------------------------
{
  const checkpoint = typeof lb.checkpointSolanaLeaderboard === "function" ? lb.checkpointSolanaLeaderboard : () => "no such function";
  ok(checkpoint() === false, "outside a scan the drain checkpoint does nothing");
  const { fn, calls } = chainRpc({ hang: new Set([P4]) });
  const before = stored().stateAt;
  const running = lb.refreshSolanaLeaderboard({ listPayTos, rpc: fn, creditFromTx, prime: () => {}, windowHours: 168 });
  for (let i = 0; i < 400 && calls.hung < 1; i++) await sleep(25);
  await sleep(5);
  const saved = checkpoint();
  ok(calls.hung === 1 && saved !== false && (await saved) === true && stored().stateAt > before, "during a scan the drain checkpoint writes the cursors and resolves once they are stored");
  void running;
  lb.__resetSolanaLeaderboardForTest();
  lb.loadPersistedSolanaLeaderboard();
}

// ---- 5. a read that fails the same way every scan is skipped, visibly -------
{
  const P5 = "Pay5555555555555555555555555555555555555555";
  chains.set(P5, mkChain("f", 40, nowSec - 5, 60));
  for (const x of chains.get(P5)) txOf.set(x.signature, { payTo: P5, x });
  const list5 = async () => new Map([[P5, new Set(["https://five.example"])]]);
  const bad = chainRpc({ failTx: (sig) => sig === "f20" });
  const stuckFor = lb.STUCK_READ_SCANS;
  ok(Number.isInteger(stuckFor) && stuckFor >= 2, `a transaction read is given up after ${stuckFor} scans of the same failure`);
  for (let i = 0; i < stuckFor; i++) {
    await lb.refreshSolanaLeaderboard({ listPayTos: list5, rpc: bad.fn, creditFromTx, prime: () => {}, windowHours: 168 });
    const row = lb.getSolanaLeaderboardSnapshot({ window: "24h" }).rows.find((r) => r.payTo === P5);
    if (i < stuckFor - 1) ok(row.unreadable === true && lb._stateForTest()[P5]?.lastSig === undefined, `scan ${i + 1}: the payTo is unreadable, the cursor has not moved`);
  }
  const row = lb.getSolanaLeaderboardSnapshot({ window: "24h" }).rows.find((r) => r.payTo === P5);
  ok(row && !row.unreadable && row.inboundTransfers === 39 && row.skippedTx === 1 && row.backfilling === false, `after ${stuckFor} scans the failing read is skipped and counted as skipped, the other 39 payments are counted, the history closes (${JSON.stringify({ unreadable: row?.unreadable, inbound: row?.inboundTransfers, skipped: row?.skippedTx, backfilling: row?.backfilling })})`);
  const good = chainRpc();
  await lb.refreshSolanaLeaderboard({ listPayTos: list5, rpc: good.fn, creditFromTx, prime: () => {}, windowHours: 168 });
  ok(good.calls.tx === 0 && lb.getSolanaLeaderboardSnapshot({ window: "24h" }).rows[0].inboundTransfers === 39, "the next scan reads nothing again: the skipped read is not retried behind the cursor");
}

clearTimeout(guard);
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
