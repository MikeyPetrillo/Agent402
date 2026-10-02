// Block windows and block dates read from the chain, across a block-time change.
//
// Base's Denim upgrade moves blocks from 2 s to 200 ms on a date not known in
// advance. A window written as a block count at 2 s (24h = 43,200) shrinks
// tenfold on that day with nothing failing, and a legacy row dated by stepping
// back from the head at 2 s per block is filed days too early. These cases run
// a simulated chain in three regimes: all 2 s, all 200 ms, and a fork inside
// the window, and require the window start and the dates to be right in all
// three. Offline, no RPC.
import assert from "node:assert/strict";
import { createBlockClock, dateFromAnchors, rpcHeaderReader } from "../src/block-clock.js";
import { resolveScanWindow, fundingWindowBlocks, windowSecondsFromEnv, windowLabelFromSeconds, FUNDING_DEFAULTS } from "../src/leaderboard.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed++; };

const DAY = 86_400;
// A chain: blocks before `fork` every `before` seconds, after it every `after`.
// Timestamps are whole seconds, as block headers carry them.
function chain({ head, fork = Infinity, before = 2, after = 0.2, nowSec = 1_800_000_000 }) {
  const forkN = Math.min(fork, head);
  const tail = (head - forkN) * after;
  const tsAtFork = nowSec - tail;
  const ts = (n) => Math.floor(n >= forkN ? tsAtFork + (n - forkN) * after : tsAtFork - (forkN - n) * before);
  let reads = 0;
  const getHeader = async (n) => {
    reads++;
    const num = n === "latest" ? head : n;
    if (num < 0 || num > head) throw new Error("no such block");
    return { number: num, timestamp: ts(num) };
  };
  // The true answer: first block with ts >= target, by linear scan of a search.
  const truth = (target) => { let lo = 0, hi = head; while (lo < hi) { const m = (lo + hi) >> 1; if (ts(m) >= target) hi = m; else lo = m + 1; } return lo; };
  return { getHeader, ts, truth, nowSec: ts(head), reads: () => reads };
}

const regimes = [
  { name: "2 s blocks (today)", c: chain({ head: 40_000_000, before: 2 }) },
  { name: "200 ms blocks (after Denim)", c: chain({ head: 40_000_000, fork: 0, after: 0.2 }) },
  { name: "fork 30h ago, inside a 7-day window", c: chain({ head: 40_000_000, fork: 40_000_000 - Math.round(30 * 3600 / 0.2) }) },
  { name: "fork 2h ago", c: chain({ head: 40_000_000, fork: 40_000_000 - Math.round(2 * 3600 / 0.2) }) },
];

for (const { name, c } of regimes) {
  for (const secs of [3600, DAY, 7 * DAY]) {
    const clock = createBlockClock(c.getHeader, { maxCalls: 80 });
    const at = await clock.blockAtOrAfter(c.nowSec - secs);
    eq(at.block, c.truth(c.nowSec - secs), `${name}: ${secs}s window starts at the first block inside it`);
    eq(at.source, "chain", `${name}: ...read from the chain, not assumed`);
    ok(clock.calls <= 80, `${name}: ...within the call budget (${clock.calls})`);
  }
}

// The window the leaderboard scans, through its own resolver.
for (const { name, c } of regimes) {
  const clock = createBlockClock(c.getHeader, { maxCalls: 80 });
  const w = await resolveScanWindow(clock, { windowSeconds: 7 * DAY }, async () => "0x0");
  eq(w.start, c.truth(c.nowSec - 7 * DAY), `${name}: the 7-day board scans from the block at now-7d`);
  const covered = c.ts(w.latest) - c.ts(w.start);
  ok(covered >= 7 * DAY - 2 && covered <= 7 * DAY, `${name}: ...and the blocks it scans span 7 days of chain time (${covered}s)`);
}
{
  // CONTROL, the defect this replaces: 302,400 blocks after the fork is 16.8h.
  const c = regimes[1].c;
  const legacy = c.ts(40_000_000) - c.ts(40_000_000 - 302_400);
  ok(legacy < DAY, `control: the old 302,400-block window covers ${Math.round(legacy / 3600)}h at 200 ms blocks, not 7d`);
}
{
  // A pinned block count is taken as given (tests, one-off scripts).
  const c = regimes[0].c;
  const w = await resolveScanWindow(createBlockClock(c.getHeader), { spanBlocks: 1000, windowSeconds: 7 * DAY }, async () => "0x0");
  eq(w.spanBlocks, 1000, "a pinned spanBlocks is honoured");
  eq(w.source, "pinned", "...and says so");
}
{
  // No header readable: head from eth_blockNumber, start estimated, labelled.
  const dead = async () => { throw new Error("rpc down"); };
  const w = await resolveScanWindow(createBlockClock(dead), { windowSeconds: DAY }, async () => "0x" + (1_000_000).toString(16));
  eq(w.latest, 1_000_000, "unreadable headers: the head still comes from eth_blockNumber");
  eq(w.source, "assumed", "...and the start is labelled as assumed, never as read");
  ok(Math.abs(w.spanBlocks - 43_200) <= 1, "...at the fallback rate");
}
{
  // Headers read but the search budget runs out: the recent measured rate.
  const c = regimes[1].c;
  const clock = createBlockClock(c.getHeader, { maxCalls: 3 });
  const at = await clock.blockAtOrAfter(c.nowSec - DAY);
  ok(at.source !== "chain", "a search cut short is not reported as read from the chain");
}

// Configuration: the production SPAN_BLOCKS keeps its meaning across the fork.
eq(windowSecondsFromEnv({ SPAN_BLOCKS: "302400" }), 7 * DAY, "SPAN_BLOCKS=302400 (written at 2 s) reads as 7 days");
eq(windowSecondsFromEnv({ LEADERBOARD_WINDOW_SECONDS: "3600", SPAN_BLOCKS: "302400" }), 3600, "LEADERBOARD_WINDOW_SECONDS wins");
eq(windowSecondsFromEnv({}), DAY, "the default is 24h");
eq(windowLabelFromSeconds(7 * DAY), "7d", "7 days labels 7d");

// Seller-funding windows (30-day Bazaar window, 30/45-day TTLs).
for (const { name, c } of regimes) {
  const clock = createBlockClock(c.getHeader, { maxCalls: 120 });
  const head = (await clock.latest()).number;
  const f = await fundingWindowBlocks(clock, head, c.nowSec);
  eq(f.bazaarWindowBlocks, head - c.truth(c.nowSec - 30 * DAY), `${name}: the 30-day funding window is 30 days of blocks`);
  eq(f.knownTtlBlocks, head - c.truth(c.nowSec - 45 * DAY), `${name}: the 45-day known-payer TTL is 45 days of blocks`);
}
{
  const f = await fundingWindowBlocks(createBlockClock(async () => { throw new Error("down"); }), 50_000_000, 1_800_000_000);
  ok(f.bazaarWindowBlocks >= FUNDING_DEFAULTS.bazaarWindowBlocks && f.knownTtlBlocks >= FUNDING_DEFAULTS.knownTtlBlocks, "unreadable chain: funding windows never narrower than the 2 s constants (a narrow TTL prunes live state)");
}

// Dating a legacy row from the chain's own dated rows.
{
  const c = regimes[2].c; // fork 30h ago
  const anchorsAt = [39_000_000, 39_400_000, 39_700_000, 39_999_000];
  const anchors = anchorsAt.map((b) => [b, c.ts(b) * 1000]);
  for (const b of [39_100_000, 39_800_000]) {
    const got = dateFromAnchors(b, anchors, 2000);
    ok(Math.abs(got - c.ts(b) * 1000) < 1000, `a row at block ${b} between anchors on one side of the fork is dated to the second`);
  }
  {
    // Anchors straddling the fork: the error is bounded by the gap between them.
    const b = 39_450_000, got = dateFromAnchors(b, anchors, 2000);
    ok(Math.abs(got - c.ts(b) * 1000) <= anchors[2][1] - anchors[1][1], "a row between anchors that straddle the fork is dated inside their bracket");
  }
  const legacy = anchors[0][0] - 5000;
  eq(dateFromAnchors(legacy, anchors, 2000), anchors[0][1] - 5000 * 2000, "a row older than every anchor steps back at the table rate from the nearest one");
  eq(dateFromAnchors(5, [], 2000), null, "no anchors: undateable, never guessed");
  // CONTROL: the old method stepped back from the head at 2 s per block.
  const headB = 40_000_000, headMs = c.ts(headB) * 1000, b = 39_100_000;
  const old = headMs - (headB - b) * 2000;
  ok(Math.abs(old - c.ts(b) * 1000) > 5 * 86_400_000, "control: stepping from the head at 2 s files that row more than 5 days early");
}

// The RPC adapter reads hex headers.
{
  const r = rpcHeaderReader(async (m, p) => { assert.equal(m, "eth_getBlockByNumber"); return { number: "0x10", timestamp: "0x64", tag: p[0] }; });
  const h = await r(16);
  eq(h.number, 16, "rpc header: number"); eq(h.timestamp, 100, "rpc header: timestamp");
}

// The revenue ledger's first block for a NEW cursor, by timestamp.
process.env.REVENUE_LEDGER_DB = process.env.REVENUE_LEDGER_DB || join(tmpdir(), `agent402-block-clock-${process.pid}.db`);
{
  const { startBlockFor } = await import("../src/revenue-ledger.js");
  const c = regimes[1].c;
  const epochMs = (c.nowSec - 10 * DAY) * 1000;
  const got = await startBlockFor("base", 40_000_000, { getHeader: c.getHeader, epochMs });
  eq(got, c.truth(c.nowSec - 10 * DAY), "ledger: a new Base cursor starts at the epoch's block, found by timestamp at 200 ms");
  const est = await startBlockFor("base", 40_000_000, { getHeader: async () => { throw new Error("down"); }, epochMs: Date.now() - DAY * 1000 });
  ok(Math.abs(est - (40_000_000 - 43_200)) <= 1, "ledger: unreadable headers fall back to the table-rate estimate");
}

// End to end: an undated row between two dated ones lands on its real day.
{
  const { recordTransfer, ledgerDaily } = await import("../src/revenue-ledger.js");
  const W = "0x00000000000000000000000000000000000b10c6";
  const t = (iso) => Math.floor(Date.parse(iso) / 1000);
  const row = (n, block, when_ts) => recordTransfer({ chain: "base", wallet: W, txid: `0xb6${n}:0`, tx_hash: `0xb6${n}`, block, when_ts, payer: "0x3333333333333333333333333333333333333333", usd: 0.01, asset: "USDC", external: true });
  // 200 ms blocks between the two dated rows (10 days = 4,320,000 blocks).
  row(1, 10_000_000, t("2026-09-10T00:00:00Z"));
  row(2, 14_320_000, t("2026-09-20T00:00:00Z"));
  row(3, 12_160_000, null); // mined 2026-09-15T00:00Z
  const days = ledgerDaily({ walletAddress: W }).filter((d) => d.chain === "base");
  const onDay = (d) => days.find((x) => x.day === d)?.extTx || 0;
  eq(onDay("2026-09-15"), 1, "ledger: the undated row is filed on the day it was mined, from the chain's own dated rows");
  // CONTROL: 2 s per block back from the newer row files it 50 days early.
  eq(new Date((t("2026-09-20T00:00:00Z") - (14_320_000 - 12_160_000) * 2) * 1000).toISOString().slice(0, 10), "2026-08-01", "control: the fixed 2 s estimate would have filed it on 2026-08-01");
}

console.log(`test-block-clock: ${passed} passed`);
