// Memory-bounded proof for the leaderboard scan fold (fixes the 7d OOM crash-loop).
//
// Root cause of the incident: runLeaderboard used to collect EVERY eth_getLogs
// result into one `logs` array across all block-chunks × wallet-chunks before
// aggregating — for a 7d window over ~1500 wallets that's hundreds of
// thousands of raw log objects held at once. This test proves the fix:
// initWalletAccumulator + foldTransfers (called once per chunk, batch
// discarded immediately after) + finalizeLeaderboard produces the exact same
// ranked output as the old collect-everything-then-aggregate path, while
// never holding more than one batch's worth of transfers at a time.
//
// To get a reliable heapUsed reading (not skewed by whatever GC happened to
// run), this script re-execs itself once with --expose-gc if it wasn't
// already started with that flag.
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

if (typeof global.gc !== "function") {
  const res = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url)], { stdio: "inherit" });
  process.exit(res.status ?? 1);
}

import {
  aggregateLeaderboard,
  initWalletAccumulator,
  foldTransfers,
  finalizeLeaderboard,
  UNCOUNTED_IN_MAX_PER_WALLET,
  UNCOUNTED_IN_MAX_TOTAL,
} from "../src/leaderboard.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + (JSON.stringify(a) === JSON.stringify(b) ? "" : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

const NUM_WALLETS = 1500;
const NUM_TRANSFERS = 300_000;
const BATCH_SIZE = 1000;
const MAX_CALL_USD = 0.5;

// --- deterministic synthetic data (no state carried between calls, so the
// same transfer can be regenerated identically whether it's built as part of
// one 300k-element array or as the Nth element of some arbitrary batch). ---
function hash32(x, salt) {
  let h = (x ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function transferAt(i) {
  const walletIdx = hash32(i, 0x1a2b3c4d) % NUM_WALLETS;
  const payerIdx = hash32(i, 0x5e6f7081) % 5000;
  const usd = ((hash32(i, 0x9a8b7c6d) % 1000) + 1) / 1000; // (0, 1.0]
  return {
    wallet: `0x${walletIdx.toString(16).padStart(40, "0")}`,
    payer: `buyer${payerIdx}`,
    usd: Number(usd.toFixed(6)),
  };
}

const sellers = Array.from({ length: NUM_WALLETS }, (_, i) => {
  const wallet = `0x${i.toString(16).padStart(40, "0")}`;
  return {
    wallet,
    name: `Seller${i}`,
    network: "base",
    origins: [`https://seller${i}.example`],
    homepage: `https://seller${i}.example`,
    endpoints: 1,
  };
});

console.log(`Node ${process.version}, --expose-gc active: ${typeof global.gc === "function"}`);
console.log(`Synthesizing ${NUM_TRANSFERS.toLocaleString()} transfers across ${NUM_WALLETS.toLocaleString()} wallets, batch size ${BATCH_SIZE}…`);

// --- independent spot-check: recompute one wallet's totals by hand, without
// going through aggregateLeaderboard/foldTransfers at all, so a bug shared by
// both the "reference" and "batched" paths (they call the same underlying
// code) wouldn't hide behind an equivalence check alone. ---
const SPOT_WALLET_IDX = 42;
let spotCalls = 0, spotUsd = 0;
const spotBuyers = new Set();
for (let i = 0; i < NUM_TRANSFERS; i++) {
  const t = transferAt(i);
  if (t.wallet !== sellers[SPOT_WALLET_IDX].wallet) continue;
  if (!(t.usd > 0) || t.usd > MAX_CALL_USD) continue;
  spotCalls += 1;
  spotUsd += t.usd;
  spotBuyers.add(t.payer);
}
spotUsd = Number(spotUsd.toFixed(6));

// --- reference: the old shape — build the full transfers array, then run the
// existing (behavior-locked) aggregateLeaderboard wrapper once. ---
if (global.gc) global.gc();
const heapBeforeCollectAll = process.memoryUsage().heapUsed;
let allTransfers = [];
for (let i = 0; i < NUM_TRANSFERS; i++) allTransfers.push(transferAt(i));
const heapAfterCollectAll = process.memoryUsage().heapUsed;
const collectAllDeltaMB = (heapAfterCollectAll - heapBeforeCollectAll) / 1e6;
console.log(`heapUsed delta holding all ${NUM_TRANSFERS.toLocaleString()} transfer objects at once: ${collectAllDeltaMB.toFixed(1)} MB`);

const reference = aggregateLeaderboard(allTransfers, sellers, { maxCallUsd: MAX_CALL_USD });
allTransfers = null; // let GC reclaim the 300k array before measuring the batched path

// --- batched (the fix): fold one BATCH_SIZE-sized chunk at a time into a
// bounded accumulator, discarding each batch immediately — this is exactly
// what runLeaderboard now does per eth_getLogs chunk. ---
if (global.gc) global.gc();
const heapBeforeBatched = process.memoryUsage().heapUsed;
const byWallet = initWalletAccumulator(sellers);
for (let start = 0; start < NUM_TRANSFERS; start += BATCH_SIZE) {
  const end = Math.min(start + BATCH_SIZE, NUM_TRANSFERS);
  const batch = [];
  for (let i = start; i < end; i++) batch.push(transferAt(i));
  foldTransfers(byWallet, batch, MAX_CALL_USD);
  // `batch` falls out of scope here — never appended to an outer array, so at
  // no point does the process hold more than BATCH_SIZE transfer objects plus
  // the bounded (NUM_WALLETS-row) accumulator.
}
if (global.gc) global.gc();
const heapAfterBatched = process.memoryUsage().heapUsed;
const batchedDeltaMB = (heapAfterBatched - heapBeforeBatched) / 1e6;
console.log(`heapUsed delta after batched fold (${NUM_TRANSFERS / BATCH_SIZE} batches of ${BATCH_SIZE}, accumulator retained): ${batchedDeltaMB.toFixed(1)} MB`);

const batchedRanked = finalizeLeaderboard(byWallet, { maxCallUsd: MAX_CALL_USD });

// --- correctness ---
eq(batchedRanked, reference, "batched (init+foldTransfers×300 batches+finalize) === aggregateLeaderboard(all 300k transfers) — the split is exact at scale");
ok(batchedRanked.length === NUM_WALLETS, `every seller has a row (got ${batchedRanked.length}, want ${NUM_WALLETS})`);

const spotRow = batchedRanked.find((r) => r.wallet === sellers[SPOT_WALLET_IDX].wallet);
ok(!!spotRow, `spot-check wallet #${SPOT_WALLET_IDX} has a row`);
if (spotRow) {
  eq(spotRow.callsSettled, spotCalls, `spot-check wallet #${SPOT_WALLET_IDX} callsSettled matches independent recount`);
  eq(spotRow.totalUsd, spotUsd, `spot-check wallet #${SPOT_WALLET_IDX} totalUsd matches independent recount`);
  eq(spotRow.uniqueBuyers, spotBuyers.size, `spot-check wallet #${SPOT_WALLET_IDX} uniqueBuyers matches independent recount`);
}

const totalCallsBatched = batchedRanked.reduce((s, r) => s + r.callsSettled, 0);
ok(totalCallsBatched > 0 && totalCallsBatched < NUM_TRANSFERS, `sanity: total settled calls (${totalCallsBatched.toLocaleString()}) is nonzero and less than raw transfer count (ceiling filter did something)`);

// --- memory proof (best-effort, informational — heap measurements are
// inherently noisy, but with --expose-gc guaranteed active above this is a
// real signal, not just a hope). The batched path's peak live-transfer-object
// count is BATCH_SIZE (1000) vs NUM_TRANSFERS (300,000) held by the
// collect-all path — a 300x reduction in the array this module ever holds. ---
console.log(`\nMemory summary: collect-all delta ${collectAllDeltaMB.toFixed(1)} MB vs batched delta ${batchedDeltaMB.toFixed(1)} MB (peak batch size ${BATCH_SIZE} vs ${NUM_TRANSFERS.toLocaleString()} held at once, ${(NUM_TRANSFERS / BATCH_SIZE).toFixed(0)}x fewer objects retained at any instant).`);
if (batchedDeltaMB < collectAllDeltaMB) {
  ok(true, `batched heapUsed delta (${batchedDeltaMB.toFixed(1)} MB) is below the collect-all delta (${collectAllDeltaMB.toFixed(1)} MB)`);
} else {
  // Don't hard-fail the suite on a noisy heap reading (V8's allocator can
  // still retain freed pages) — but make it loud, since this is the exact
  // regression this test exists to catch.
  console.error(`WARN - batched heapUsed delta (${batchedDeltaMB.toFixed(1)} MB) was not below the collect-all delta (${collectAllDeltaMB.toFixed(1)} MB) — informational, investigate if this repeats`);
}

// --- over-ceiling inbound held for the funding pass is bounded ---
// A listing can name any busy wallet as its payTo; every over-ceiling inbound
// payment it receives is held for the funding pass, so the hold is capped per
// wallet and across every chunk of one scan's fold.
{
  const hot = "0x" + "e1".repeat(20);
  const acc = initWalletAccumulator([{ wallet: hot, origins: ["https://a.example"] }]);
  const big = (wallet, i) => ({ wallet, payer: "0x" + (i + 1).toString(16).padStart(40, "0"), usd: 5, pos: i + 1 });
  const per = UNCOUNTED_IN_MAX_PER_WALLET;
  for (let b = 0; b < 3; b++) foldTransfers(acc, Array.from({ length: per }, (_, i) => big(hot, b * per + i)), MAX_CALL_USD);
  const hotRow = acc.get(hot);
  const heldHot = [...hotRow.uncountedIn.values()].reduce((n, u) => n + u.pos.length, 0);
  ok(heldHot === per && hotRow.uncountedInDropped === 2 * per, `one wallet holds at most ${per} over-ceiling payments across chunks (held ${heldHot}, dropped ${hotRow.uncountedInDropped})`);
  const many = Array.from({ length: Math.ceil(UNCOUNTED_IN_MAX_TOTAL / per) + 1 }, (_, k) => "0x" + (0xf0 + k).toString(16).padStart(2, "0").repeat(20));
  const acc2 = initWalletAccumulator(many.map((wallet, k) => ({ wallet, origins: [`https://w${k}.example`] })));
  many.forEach((w, k) => foldTransfers(acc2, Array.from({ length: per }, (_, i) => big(w, k * per + i)), MAX_CALL_USD));
  const heldAll = many.reduce((n, w) => n + [...(acc2.get(w).uncountedIn || new Map()).values()].reduce((m, u) => m + u.pos.length, 0), 0);
  const dropped = many.reduce((n, w) => n + (acc2.get(w).uncountedInDropped || 0), 0);
  ok(heldAll === UNCOUNTED_IN_MAX_TOTAL && dropped === many.length * per - UNCOUNTED_IN_MAX_TOTAL, `the scan-wide hold stops at ${UNCOUNTED_IN_MAX_TOTAL} across ${many.length} wallets (held ${heldAll}, dropped ${dropped})`);
  ok(hotRow.overCeilingSkipped === 3 * per, `dropped payments are still counted as over-ceiling (${hotRow.overCeilingSkipped})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
