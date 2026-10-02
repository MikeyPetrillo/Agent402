#!/usr/bin/env node
// Self-funded payments are not settlement evidence (2026-09-28).
//
// A payment into wallet W is the seller's own money coming home when W had sent
// its payer the USDC that pays it. The scan reads each paid wallet's OWN
// outbound transfers incrementally (a cursor per wallet, persisted pools per
// wallet and payer), works each pool through the payments first in first out,
// nets the per-wallet figures the router reads, and marks a wallet whose
// received DOLLARS were mostly self-funded as circular, whose Bazaar and
// chain-join figures (the same payments, counted by others) the router then
// disregards (src/seller-funding.js, src/leaderboard.js, src/evidence-binding.js,
// and the ranking tie-break in src/x402-index.js).
//
// Offline: fixture logs, a fake RPC that applies the provider's documented
// eth_getLogs rule (a range over 2,000 blocks is refused above 10,000 logs), one
// stub HTTP server playing the Bazaar and a Base RPC for the end-to-end scans,
// and a booted free server for the operator lever. Nothing is spent.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";

const dir = mkdtempSync(join(tmpdir(), "seller-funding-"));
process.env.LEADERBOARD_SNAPSHOT_FILE = join(dir, "leaderboard-snapshot.json");
process.env.LEADERBOARD_HISTORY_FILE = join(dir, "leaderboard-history.json");
process.env.LEADERBOARD_FUNDING_FILE = join(dir, "leaderboard-funding.json");
process.env.LEADERBOARD_FUNDING_SWITCH_FILE = join(dir, "leaderboard-funding-switch.json");
delete process.env.LEADERBOARD_FUNDING_SCAN;
const LB = await import("../src/leaderboard.js");
const SF = await import("../src/seller-funding.js");
const { initWalletAccumulator, foldTransfers, finalizeLeaderboard, applySellerFunding, runLeaderboard } = LB;
const { readSellerFunding, readPayerHistory, readFundingGaps, processSellerFunding, createFundingState, serializeFundingState, parseFundingState, circularWalletsFrom, posOf, isScannableWallet, ZERO_ADDRESS, pruneFundingState } = SF;
const { buildEvidenceBinding, baseLiveGate } = await import("../src/evidence-binding.js");
const { dispatchEligibility, DISPATCH_REASONS, dispatchLegend } = await import("../src/dispatch-eligibility.js");
const { rankingPayersOf } = await import("../src/x402-index.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const FLOORS = { minSettled: 50, minPayers: 3 };
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const addr = (hex2) => "0x" + hex2.repeat(20);
const topic = (a) => "0x" + "0".repeat(24) + a.slice(2);
const hex = (n) => "0x" + n.toString(16);
const usd = (x) => Math.round(x * 1e6);
const log = (from, to, micro, block, idx = 0) => ({ address: USDC, topics: [TRANSFER, topic(from), topic(to)], data: "0x" + BigInt(micro).toString(16).padStart(64, "0"), blockNumber: hex(block), logIndex: hex(idx) });
const P = (i) => "0x" + "a0".repeat(18) + i.toString(16).padStart(4, "0"); // payer i
const seller = (wallet, host) => ({ wallet, name: host, network: "base", origins: [`https://${host}`], homepage: `https://${host}`, endpoints: 1, prices: new Set() });
const NOW = Date.parse("2026-09-28T00:00:00Z");

// eth_getLogs with the real filter semantics, and the provider's documented
// size rule: a range wider than 2,000 blocks is refused above 10,000 logs.
const inTopicSet = (set, t) => set === null || set === undefined || (Array.isArray(set) ? set.some((x) => x.toLowerCase() === t.toLowerCase()) : set.toLowerCase() === t.toLowerCase());
const filterLogs = (list, p) => {
  const lo = parseInt(p.fromBlock, 16), hi = parseInt(p.toBlock, 16);
  const froms = Array.isArray(p.topics?.[1]) ? new Set(p.topics[1].map((x) => x.toLowerCase())) : null;
  const tos = Array.isArray(p.topics?.[2]) ? new Set(p.topics[2].map((x) => x.toLowerCase())) : null;
  return list.filter((l) => {
    const b = parseInt(l.blockNumber, 16);
    return b >= lo && b <= hi && (!p.address || p.address.toLowerCase() === l.address) && inTopicSet(p.topics?.[0], l.topics[0])
      && (!froms || froms.has(l.topics[1].toLowerCase())) && (!tos || tos.has(l.topics[2].toLowerCase()));
  });
};
const SIZE_REFUSAL = "Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response.";
const fakeRpc = (list, { calls = [], transport = 0, refuse = null, rangeLimit = Infinity } = {}) => {
  let transportLeft = transport;
  return async (method, params) => {
    const p = params[0];
    const span = parseInt(p.toBlock, 16) - parseInt(p.fromBlock, 16) + 1;
    calls.push({ ...p, span });
    if (transportLeft > 0) { transportLeft--; throw new Error("All RPCs failed for eth_getLogs: fetch failed"); }
    const refused = refuse && refuse(p, span);
    if (refused) throw new Error(typeof refused === "string" ? `All RPCs failed for eth_getLogs: base.example: ${refused}` : "All RPCs failed for eth_getLogs: base.example: {\"code\":-32000,\"message\":\"temporarily unable to serve\"}");
    if (span > rangeLimit) throw new Error(`block range too large (${span})`);
    const logs = filterLogs(list, p);
    if (span > 2000 && logs.length > 10_000) throw new Error(SIZE_REFUSAL);
    return logs;
  };
};

// One scan's funding step, exactly as runLeaderboard composes it (pinned from
// source in section 11): fold, read the paid wallets' outbound to their known
// payers (floor-clearing wallets first), read every new payer's history, read
// the gap before the window once, work the pools, apply, finalize. The fake
// chain holds the outbound logs AND every payment as a log, so a history or
// gap read (payers to a wallet, before the window) sees what it would.
function paidInOrder(acc, floor = FLOORS) {
  const clears = (w) => ((w.callsSettled || 0) >= floor.minSettled && w.perPayer.size >= floor.minPayers ? 1 : 0);
  return [...acc.values()].filter((w) => w.perPayer.size).sort((a, b) => clears(b) - clears(a) || b.callsSettled - a.callsSettled)
    .map((w) => ({ wallet: w.wallet, payers: new Set([...w.perPayer.keys()].map((p) => p.toLowerCase())) }));
}
const payLog = (t) => log(t.payer, t.wallet, Math.round(t.usd * 1e6), Math.floor(t.pos / 1e6), t.pos % 1e6);
async function scanOnce({ sellers, pays, outs, state, latest, span, historyFrom = 0, rpcOpts = {}, readOpts = {}, now = NOW, previous = null, gaps = true, history = true, chainHidesPaysBefore = 0 }) {
  const start = latest - span;
  const acc = initWalletAccumulator(sellers.map((s) => ({ ...s, origins: [...s.origins] })));
  foldTransfers(acc, pays.filter((t) => Math.floor(t.pos / 1e6) >= start && Math.floor(t.pos / 1e6) <= latest));
  const calls = [];
  const chain = [...outs, ...pays.filter((t) => t.payer !== t.wallet && Math.floor(t.pos / 1e6) >= chainHidesPaysBefore).map(payLog)];
  const rpc = fakeRpc(chain, { ...rpcOpts, calls });
  const paid = paidInOrder(acc);
  const maxCalls = readOpts.maxCalls ?? 400;
  const stats = await readSellerFunding({ rpc, token: USDC, state, wallets: paid, latest, windowStartBlock: start, now, ...readOpts });
  // As runLeaderboard: each later pass spends what the earlier ones left, and
  // a wallet's reads may plan up to the scan's whole budget.
  const hist = history ? await readPayerHistory({ rpc, token: USDC, state, wallets: paid, windowStartBlock: start, historyFromBlock: historyFrom, now, scanMaxCalls: maxCalls, ...readOpts, maxCalls: Math.max(0, maxCalls - stats.calls) }) : { histories: new Map(), stats: { calls: 0 } };
  stats.history = hist.stats;
  const gapRead = gaps ? await readFundingGaps({ rpc, token: USDC, state, wallets: paid.map((w) => w.wallet), windowStartBlock: start, now, scanMaxCalls: readOpts.scanMaxCalls ?? maxCalls, maxCalls: Math.max(0, maxCalls - stats.calls - hist.stats.calls) }) : { gaps: new Map(), stats: {} };
  stats.gap = gapRead.stats;
  processSellerFunding(state, acc, { windowStartBlock: start, gaps: gapRead.gaps, histories: hist.histories, classify: (w, micro) => (micro <= 750_000 ? 1 : 2), ...(readOpts.maxPairsTotal ? { maxPairsTotal: readOpts.maxPairsTotal } : {}) });
  pruneFundingState(state, { now, latest, ...(readOpts.maxPartialLogsPerWallet ? { maxPartialLogsPerWallet: readOpts.maxPartialLogsPerWallet } : {}) });
  applySellerFunding(acc, state, { latest, now, previous });
  const ranked = finalizeLeaderboard(acc);
  return { acc, ranked, ev: ranked.walletEvidence, stats, calls };
}
// A state whose wallets already know some payers (as after an earlier scan),
// with every cursor at `cursor`.
const knownState = (map, cursor) => parseFundingState(JSON.stringify({ v: 2, token: USDC, wallets: Object.fromEntries(Object.entries(map).map(([w, ps]) => [w, { c: cursor, t: posOf(cursor + 1, 0) - 1, s: cursor + 1, x: 0, seen: NOW, lc: null, p: {}, k: Object.fromEntries(ps.map((p) => [p, [0, -1, -1, -1]])), b: {} }])) }), USDC);
const isOutbound = (c) => c.topics[2] === null;

// --- 1. What is never a wallet ----------------------------------------------------
ok(!isScannableWallet(ZERO_ADDRESS, USDC) && !isScannableWallet(USDC, USDC) && !isScannableWallet(USDC.toUpperCase().replace("0X", "0x"), USDC) && isScannableWallet(addr("11"), USDC),
  "the zero address and the token contract are never a scanned payTo or a funding source");

// --- 2. First in, first out, by amount ----------------------------------------------
const LOOP = addr("11"), ECHO = addr("12"), HONEST = addr("22"), MIXED = addr("33"), PART = addr("34"), SIB_A = addr("44"), SIB_B = addr("45");
const SELLERS = [seller(LOOP, "seller-a.example"), seller(ECHO, "seller-e.example"), seller(HONEST, "seller-b.example"), seller(MIXED, "seller-c.example"), seller(PART, "seller-p.example"), seller(SIB_A, "seller-d.example"), seller(SIB_B, "seller-d.example")];
const pays = [], outs = [];
const pay = (wallet, payer, micro, block, idx = 1) => pays.push({ wallet, payer, usd: micro / 1e6, pos: posOf(block, idx) });
// seller-a funds P1..P5 $0.13 each at block 100; each pays 12 x $0.01; two organic payers once each.
for (let i = 1; i <= 5; i++) { outs.push(log(LOOP, P(i), usd(0.13), 100, i)); for (let k = 0; k < 12; k++) pay(LOOP, P(i), usd(0.01), 200 + k, i); }
pay(LOOP, P(90), usd(0.01), 300); pay(LOOP, P(91), usd(0.01), 301);
// seller-a also funds P(40), which then buys from seller-b: another seller's money, not seller-b's.
outs.push(log(LOOP, P(40), usd(1), 150));
// seller-e returns every payment the moment it lands (the loop an "amount equals the payment it follows, so it is a refund" rule would admit).
outs.push(log(ECHO, P(70), usd(0.05), 100));
for (let k = 0; k < 20; k++) { pay(ECHO, P(70), usd(0.05), 200 + 2 * k, 1); outs.push(log(ECHO, P(70), usd(0.05), 201 + 2 * k, 2)); }
pay(ECHO, P(71), usd(0.05), 400);
// seller-b: ten payers x 10 payments of $0.01. It REFUNDS P(20) $0.01 after all
// of P(20)'s payments, and P(21) $0.01 mid-way (P(21) keeps paying after it).
for (let i = 20; i < 30; i++) for (let k = 0; k < 10; k++) pay(HONEST, P(i), usd(0.01), (i === 21 ? 200 : 400) + k * (i === 21 ? 20 : 1), i);
outs.push(log(HONEST, P(20), usd(0.01), 900));
outs.push(log(HONEST, P(21), usd(0.01), 290));
for (let k = 0; k < 6; k++) pay(HONEST, P(40), usd(0.01), 500 + k, 40);
// ZERO-VALUE "funding" logs from seller-b's wallet to its buyers before they pay: anyone can emit one.
for (let i = 22; i < 30; i++) outs.push(log(HONEST, P(i), 0, 50, i));
// seller-c: one whale it funded $0.80 makes 80 payments of $0.01; 16 organic payers make 4 each.
outs.push(log(MIXED, P(60), usd(0.8), 50));
for (let k = 0; k < 80; k++) pay(MIXED, P(60), usd(0.01), 100 + k, 60);
for (let i = 100; i < 116; i++) for (let k = 0; k < 4; k++) pay(MIXED, P(i), usd(0.01), 300 + k, i);
// seller-p funds each payment 80% ($0.04 of $0.05) ten times, and one payer 40% ($0.02 of $0.05) once.
for (let k = 0; k < 10; k++) { outs.push(log(PART, P(80), usd(0.04), 100 + 2 * k)); pay(PART, P(80), usd(0.05), 101 + 2 * k); }
outs.push(log(PART, P(81), usd(0.02), 300)); pay(PART, P(81), usd(0.05), 301);
// seller-d: two wallets listed under one host. SIB_B funds P(50); P(50) pays SIB_A.
outs.push(log(SIB_B, P(50), usd(1), 100));
for (let k = 0; k < 5; k++) pay(SIB_A, P(50), usd(0.01), 200 + k, 50);
for (let i = 51; i < 54; i++) pay(SIB_A, P(i), usd(0.01), 300, i);
// seller-a pays itself once: never a buyer. And a mint (from the zero address) to a seller-b buyer.
pays.push({ wallet: LOOP, payer: LOOP, usd: 0.01, pos: posOf(310, 1) });
outs.push(log(ZERO_ADDRESS, P(25), usd(5), 60));

const state1 = createFundingState(USDC);
const s1 = await scanOnce({ sellers: SELLERS, pays, outs, state: state1, latest: 1000, span: 1000 });
const ev = s1.ev;
ok(s1.stats.calls === 0 && s1.stats.history.calls === 1 && Array.isArray(s1.calls[0].topics[2]) && s1.stats.history.payers === 43 && s1.stats.caughtUp === 6 && !state1.wallets.has(SIB_B),
  "first scan: ONE targeted history read covers all 43 new payers of the 6 paid wallets (no untargeted read: nothing is known yet; a wallet with no payment this window is not read)");
ok(!s1.calls[0].topics[1].includes(topic(ZERO_ADDRESS)) && ![...state1.wallets.keys()].includes(ZERO_ADDRESS), "the zero address is never read as a source (a mint is not a seller's money)");
ok(ev[LOOP].grossCallsSettled === 62 && ev[LOOP].selfFundedCalls === 60 && ev[LOOP].callsSettled === 2 && ev[LOOP].uniqueBuyers === 2 && ev[LOOP].circular === true,
  "FUNDED FLEET: 60 of 62 payments were paid with the seller's own $0.13 per wallet -> net 2 calls / 2 payers, circular");
ok(ev[ECHO].selfFundedCalls === 20 && ev[ECHO].callsSettled === 1 && ev[ECHO].circular === true, "ECHO LOOP: a seller that returns each payment as it lands is netted every time (the return funds the next payment)");
ok(s1.ranked.find((r) => r.wallets.includes(LOOP)).callsSettled === 62, "the public row stays gross (router input only; the self-transfer is skipped as a buyer)");
ok(ev[HONEST].grossCallsSettled === 106 && ev[HONEST].selfFundedCalls === 0 && ev[HONEST].refundedCalls === 2 && ev[HONEST].callsSettled === 104 && ev[HONEST].uniqueBuyers === 11 && ev[HONEST].circular === false,
  "HONEST SELLER WITH REFUNDS: each $0.01 refund to a payer that had already paid removes the payment it returns, nets nothing (106 gross, 2 refunded, 104 net, 11 payers, not circular)");
{
  const pair20 = state1.wallets.get(HONEST).pairs.get(P(20));
  ok(pair20 && pair20.pool === 0 && pair20.recs.length === 0 && pair20.rf.length === 1 && pair20.rf[0][0] === posOf(409, 20) && state1.wallets.get(HONEST).known.get(P(20))[4].length === 27, "a refund AFTER a payer's payments never makes those payments self-funded and adds no pool: it removes the NEWEST payment it returns (P20: block 409 refunded, 9 payments still refundable)");
  ok(!state1.wallets.get(HONEST).pairs.has(P(22)), "a ZERO-VALUE transfer log is never funding (anyone can emit one from any wallet)");
  ok(!state1.wallets.get(HONEST).pairs.has(P(40)) && ev[HONEST].uniqueBuyers === 11, "a payer funded by ANOTHER seller's wallet still counts for this seller");
}
ok(ev[MIXED].grossCallsSettled === 144 && ev[MIXED].selfFundedUsd === 0.8 && ev[MIXED].callsSettled === 64 && ev[MIXED].uniqueBuyers === 16 && ev[MIXED].circular === true,
  "MIXED SELLER: $0.80 of $1.44 self-funded -> circular by dollars, judged on its genuine part: 64 calls / 16 payers");
ok(ev[PART].selfFundedCalls === 10 && ev[PART].callsSettled === 1 && ev[PART].selfFundedUsd === 0.42 && ev[PART].circular === true,
  "PARTLY FUNDED: a payment 80% paid with the seller's money is netted as a call; one 40% funded stays a call, its $0.02 still counts as self-funded dollars");
ok(ev[SIB_A].callsSettled === 8 && ev[SIB_A].selfFundedCalls === 0 && ev[SIB_A].circular === false,
  "ANOTHER WALLET UNDER THE SAME HOST funding a payer does not net it: only the paid wallet's own outbound counts (host grouping comes from listings anyone can write)");
{
  // What the review measured against the branch's first cut: a third party whose
  // listing lands in an honest seller's host group sends dust to its buyers.
  const W = addr("61"), V = addr("62");
  const buyers = Array.from({ length: 6 }, (_, i) => P(200 + i));
  const sp = [], so = [];
  for (let r = 0; r < 20; r++) for (const [i, b] of buyers.entries()) sp.push({ wallet: W, payer: b, usd: 0.01, pos: posOf(1000 + r * 10 + i, 0) });
  for (const [i, b] of buyers.entries()) so.push(log(V, b, 1, 999, i)); // one base unit each, before every payment
  sp.push({ wallet: V, payer: P(250), usd: 0.01, pos: posOf(1500, 0) }); // V is itself a (paid) wallet under the same host
  const st = createFundingState(USDC);
  const r = await scanOnce({ sellers: [seller(W, "seller-a.example"), seller(V, "seller-a.example")], pays: sp, outs: so, state: st, latest: 2000, span: 2000 });
  ok(r.ev[W].callsSettled === 120 && r.ev[W].uniqueBuyers === 6 && r.ev[W].circular === false, "SIBLING DUST: a wallet sharing the seller's host that sends 1 base unit to each of its buyers changes nothing (120 / 6, not circular)");
}

// --- 3. The funding read: incremental, bounded, lineage-local ---------------------
{
  // Same fixtures, a second scan an hour later: every read starts at the cursor.
  const more = [...pays];
  for (let i = 1; i <= 5; i++) more.push({ wallet: LOOP, payer: P(i), usd: 0.01, pos: posOf(1100 + i, 1) }); // pool 0.01 left each: covered
  const s2 = await scanOnce({ sellers: SELLERS, pays: more, outs, state: state1, latest: 1400, span: 1300 });
  ok(s2.calls.length === 1 && s2.calls.every((c) => parseInt(c.fromBlock, 16) === 1001 && parseInt(c.toBlock, 16) === 1400), `a later scan reads only the blocks since the cursor (${s2.calls.map((c) => `${parseInt(c.fromBlock, 16)}-${parseInt(c.toBlock, 16)}`).join(",")})`);
  ok(s2.ev[LOOP].selfFundedCalls === 65 && s2.ev[LOOP].grossCallsSettled === 67, "payments worked through in the first scan keep their verdict in the second (60 remembered + 5 new, from the persisted pools)");
  // Round trip through the volume's format: the same state, the same answer.
  const re = parseFundingState(serializeFundingState(state1), USDC);
  ok(re.wallets.get(LOOP).cursor === 1400 && re.wallets.get(LOOP).pairs.get(P(1)).recs.length === state1.wallets.get(LOOP).pairs.get(P(1)).recs.length && JSON.stringify(re.wallets.get(HONEST).known.get(P(20))) === JSON.stringify(state1.wallets.get(HONEST).known.get(P(20))) && JSON.stringify(re.wallets.get(HONEST).pairs.get(P(20)).rf) === JSON.stringify(state1.wallets.get(HONEST).pairs.get(P(20)).rf) && JSON.stringify([...re.wallets.get(HONEST).refunded]) === JSON.stringify([...state1.wallets.get(HONEST).refunded]) && re.wallets.get(LOOP).known.get(P(1)).length === 4,
    "the state round-trips through its persisted form (cursors, pools, remembered payments, refundable and refunded payments; a payer with none keeps the four-field form)");
  ok(parseFundingState(serializeFundingState(state1), "0x" + "9".repeat(40)).wallets.size === 0 && parseFundingState("{not json", USDC).wallets.size === 0 && parseFundingState(serializeFundingState(state1).replace('"v":2', '"v":1'), USDC).wallets.size === 0,
    "a state for another token, of another version, or an unreadable file, starts empty (every payer's history is read again)");
  ok(re.wallets.get(LOOP).known.has(P(90)) && re.wallets.get(LOOP).known.size === state1.wallets.get(LOOP).known.size, "...the known payers round-trip too");
}
{
  // WAITING IT OUT buys nothing: a buyer funded once, weeks before it pays, is
  // netted until it has spent the money, and not a payment after.
  const W = addr("71"), R = P(300), O = P(301);
  const st = createFundingState(USDC);
  const outsW = [log(W, R, usd(1), 100)];
  const paysW = [{ wallet: W, payer: O, usd: 0.01, pos: posOf(900, 0) }];
  await scanOnce({ sellers: [seller(W, "seller-w.example")], pays: paysW, outs: outsW, state: st, latest: 1000, span: 500 });
  ok(!st.wallets.get(W).pairs.has(R) && !st.wallets.get(W).known.has(R), "scan 1: nothing is kept for a wallet the seller funded that has not paid (its whole history is read if it ever does)");
  for (let k = 0; k < 30; k++) paysW.push({ wallet: W, payer: R, usd: 0.01, pos: posOf(40_000 + k, 0) });
  for (let i = 0; i < 20; i++) paysW.push({ wallet: W, payer: P(310 + i), usd: 0.01, pos: posOf(40_100 + i, 0) });
  const w3 = await scanOnce({ sellers: [seller(W, "seller-w.example")], pays: paysW, outs: outsW, state: st, latest: 40_500, span: 1000 });
  ok(w3.ev[W].selfFundedCalls === 30 && w3.ev[W].callsSettled === 20 && w3.stats.history.funded === 1, "scan 3, ~40,000 blocks later: its first payment brings its whole history in, and all 30 of its payments are still the seller's money");
  for (let k = 0; k < 80; k++) paysW.push({ wallet: W, payer: R, usd: 0.01, pos: posOf(41_600 + k, 0) });
  const w4 = await scanOnce({ sellers: [seller(W, "seller-w.example")], pays: paysW, outs: outsW, state: st, latest: 42_000, span: 1000 });
  ok(w4.ev[W].selfFundedCalls === 70 && w4.ev[W].callsSettled === 10 && st.wallets.get(W).pairs.get(R)?.pool === 0 && w4.stats.gap.read === 1, "scan 4: the remaining $0.70 covers 70 more and the last 10 are its own money: a spent pool nets nothing more (the gap before the window read once)");
  await scanOnce({ sellers: [seller(W, "seller-w.example")], pays: paysW, outs: outsW, state: st, latest: 44_000, span: 1000 });
  ok(!st.wallets.get(W).pairs.has(R) && st.wallets.get(W).known.has(R), "...and once its netted payments leave the window, the spent pool is forgotten (the payer stays known, so no history is read again)");
}
{
  // THE LOOKBACK THE FIRST CUT HAD, WAITED OUT (the review's case, production
  // numbers): the seller funds five wallets from its payTo about 37 days before
  // any of them buys, and the wallet has never been paid before. The first
  // cut's first read started 30 days before a 7-day window and credited all 60
  // payments. Every payer's history is read from the token's deployment now.
  const SPAN = 302_400, LOOKBACK = 1_296_000;
  const latest = 60_000_000, start = latest - SPAN;
  const W = addr("72");
  const fundBlock = start - LOOKBACK - 10_000;
  const o = [], p = [];
  for (let i = 1; i <= 5; i++) { o.push(log(W, P(320 + i), usd(0.2), fundBlock, i)); for (let k = 0; k < 12; k++) p.push({ wallet: W, payer: P(320 + i), usd: 0.01, pos: posOf(start + 100 + k, i) }); }
  const r = await scanOnce({ sellers: [seller(W, "seller-a.example")], pays: p, outs: o, state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221 });
  const histCall = r.calls.find((c) => Array.isArray(c.topics[2]) && c.topics[1].includes(topic(W)));
  ok(r.ev[W].selfFundedCalls === 60 && r.ev[W].callsSettled === 0 && r.ev[W].circular === true && r.ev[W].fundingRead === true, "funded ~37 days before its fleet bought: all 60 payments netted, circular");
  ok(histCall && parseInt(histCall.fromBlock, 16) === 2_797_221 && parseInt(histCall.toBlock, 16) === latest, "...found by a history read from the token's deployment block to the latest block");
  const chunked = await scanOnce({ sellers: [seller(W, "seller-a.example")], pays: p, outs: o, state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221, readOpts: { historyChunkBlocks: 20_000_000 } });
  ok(chunked.ev[W].selfFundedCalls === 60 && chunked.calls.filter((c) => Array.isArray(c.topics[2])).every((c) => c.span <= 20_000_000) && chunked.stats.history.calls === 6, `...and with a bounded history range (FUNDING_HISTORY_CHUNK_BLOCKS) the same 60 are found, each read at most 20M blocks, front to back: three calls each way (${chunked.stats.history.calls} calls)`);
  // The same seller, known to us for months before its fleet is funded: the
  // incremental read catches funding of a payer that already paid once.
  const st = createFundingState(USDC);
  const W2 = addr("73"), F = P(340), X = P(341);
  const o2 = [], p2 = [{ wallet: W2, payer: F, usd: 0.01, pos: posOf(1_000, 0) }, { wallet: W2, payer: X, usd: 0.01, pos: posOf(1_001, 0) }];
  await scanOnce({ sellers: [seller(W2, "seller-b.example")], pays: p2, outs: o2, state: st, latest: 2_000, span: 1_500 });
  o2.push(log(W2, F, usd(0.5), 500_000));
  for (let k = 0; k < 50; k++) p2.push({ wallet: W2, payer: F, usd: 0.01, pos: posOf(900_000 + k, 0) });
  const r2 = await scanOnce({ sellers: [seller(W2, "seller-b.example")], pays: p2, outs: o2, state: st, latest: 1_000_000, span: 200_000 });
  ok(r2.ev[W2].selfFundedCalls === 49 && r2.stats.history.payers === 0 && r2.stats.history.creditReads === 1 && r2.calls.filter(isOutbound).length === 1, `a KNOWN payer funded later is caught by the incremental read (the $0.50 less the $0.01 it had genuinely paid nets 49; one call over the blocks since the cursor; its own earlier transfers read once as credit, ${r2.stats.history.calls} call)`);
  // A wallet whose state was dropped for being idle: every payer is new again.
  const dropped = createFundingState(USDC);
  const r3 = await scanOnce({ sellers: [seller(W2, "seller-b.example")], pays: p2, outs: o2, state: dropped, latest: 1_000_000, span: 200_000 });
  ok(r3.ev[W2].selfFundedCalls === 49 && r3.stats.history.payers === 1, "...and a wallet whose state was dropped reads its payers' history again: the same 49 netted");
}
{
  // THE BUDGET, on the shape the review measured: one wallet sending over
  // 10,000 transfers to its own payers inside a chunk of 250 paid wallets with
  // 1,296 payers, on its first scan. Every other wallet's history is read in
  // full; the heavy one is isolated and read by splitting its payer list.
  const HEAVY = addr("81");
  const lights = Array.from({ length: 249 }, (_, i) => "0x" + (0x1000 + i).toString(16).padStart(40, "0"));
  const sellersB = [seller(HEAVY, "seller-h.example"), ...lights.map((w, i) => seller(w, `light-${i}.example`))];
  const paysB = [], outsB = [];
  const LATEST = 604_800;
  for (let k = 0; k < 51; k++) outsB.push(log(HEAVY, P(1000 + k), usd(2), 1000 + k));
  for (let k = 0; k < 12_000; k++) outsB.push(log(HEAVY, P(1000 + (k % 51)), usd(0.05), 10_000 + k * 49, 1));
  for (let k = 0; k < 51 * 20; k++) paysB.push({ wallet: HEAVY, payer: P(1000 + (k % 51)), usd: 0.05, pos: posOf(LATEST - 300_000 + k * 20, 2) });
  lights.forEach((w, i) => {
    for (let j = 0; j < 5; j++) paysB.push({ wallet: w, payer: P(2000 + i * 5 + j), usd: 0.01, pos: posOf(LATEST - 1000 + j, 3) });
    outsB.push(log(w, P(9000 + i), usd(0.5), 5000 + i, 4)); // to a recipient that never pays: never recorded
  });
  const st = createFundingState(USDC);
  const b1 = await scanOnce({ sellers: sellersB, pays: paysB, outs: outsB, state: st, latest: LATEST, span: 302_400 });
  const full = LATEST + 1;
  const touchesHeavy = (c) => c.topics[1].includes(topic(HEAVY)) || (Array.isArray(c.topics[2]) && c.topics[2].includes(topic(HEAVY)));
  const lightCalls = b1.calls.filter((c) => !touchesHeavy(c));
  const total = b1.stats.calls + b1.stats.history.calls + b1.stats.gap.calls;
  ok(b1.stats.caughtUp === 250 && b1.stats.history.read === 250 && b1.stats.history.payers === 1296 && total <= 25, `ALL 250 wallets' 1,296 new payers read in full within ${total} call(s) of the 400 budget (the heavy source isolated, not the budget spent)`);
  ok(lightCalls.length > 0 && lightCalls.every((c) => c.span === full), "no other wallet's read was narrowed by the heavy wallet's refusals (every call without it spans the whole range)");
  ok(b1.ev[HEAVY].circular === true && b1.ev[HEAVY].selfFundedCalls === 1020 && b1.ev[HEAVY].callsSettled === 0, "and the heavy source is netted: its 1,020 payments were all paid with its own money");
  ok(lights.every((w) => st.wallets.get(w).pairs.size === 0), "a transfer to a recipient that never paid the wallet is never recorded (no pool, nothing to fill a cap with)");
  // A tiny budget reads the wallets that clear the floor on gross first.
  const st2 = createFundingState(USDC);
  const tiny = await scanOnce({ sellers: [...lights.map((w, i) => seller(w, `light-${i}.example`)), seller(HEAVY, "seller-h.example")], pays: paysB, outs: outsB.filter((l) => l.topics[1] !== topic(HEAVY)), state: st2, latest: LATEST, span: 302_400, readOpts: { maxCalls: 1, walletChunk: 10 } });
  ok(tiny.stats.history.budgetExhausted === true && tiny.stats.history.read === 10 && tiny.ev[HEAVY].fundingRead === true && tiny.ev[lights[100]].fundingRead === false,
    "with a budget of one call, the one history read goes to the wallets that clear the floor on gross first (the busiest one included), the rest are behind, and the read says so");
}
{
  // ONE WALLET CANNOT SPEND THE READS (review, 2026-09-28). A payTo whose
  // outbound history to its payers is so dense the provider answers it only
  // over narrow ranges (a busy contract's shape: size refusals down to about
  // 10,000 blocks, all the way through the token's history) sorts FIRST, as
  // the busiest wallet clearing the floor. Before, its range halving spent the
  // whole budget, every wallet packed or queued behind it was left behind, and
  // the same calls were spent again the next hour.
  const D = addr("d7");
  const SPAN = 302_400, latest = 60_000_000, start = latest - SPAN;
  const lights = Array.from({ length: 20 }, (_, i) => "0x" + (0x2000 + i).toString(16).padStart(40, "0"));
  const sells = [seller(D, "dense.example"), ...lights.map((w, i) => seller(w, `lt-${i}.example`))];
  const dPays = [], dOuts = [];
  for (let k = 0; k < 20; k++) for (let c = 0; c < 5; c++) dPays.push({ wallet: D, payer: P(5000 + k), usd: 0.01, pos: posOf(latest - 5_000 + k * 5 + c, 1) });
  // The first four light wallets funded their five payers ~2M blocks before
  // the window, and each of those payers pays 12 times: circular.
  lights.forEach((w, i) => {
    for (let j = 0; j < 5; j++) {
      const p = P(6000 + i * 5 + j);
      if (i < 4) dOuts.push(log(w, p, usd(0.2), start - 2_000_000, j));
      for (let k = 0; k < 12; k++) dPays.push({ wallet: w, payer: p, usd: 0.01, pos: posOf(latest - 20_000 + k, j) });
    }
  });
  const denseRpc = { refuse: (p, span) => (Array.isArray(p.topics?.[1]) && p.topics[1].includes(topic(D)) && span > 10_000 ? SIZE_REFUSAL : false) };
  const touchesD = (c) => (Array.isArray(c.topics[1]) && c.topics[1].includes(topic(D))) || (Array.isArray(c.topics[2]) && c.topics[2].includes(topic(D)));
  const st = createFundingState(USDC);
  const d1 = await scanOnce({ sellers: sells, pays: dPays, outs: dOuts, state: st, latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: denseRpc });
  const circ = lights.filter((w) => d1.ev[w].circular === true);
  ok(d1.stats.history.read === 20 && d1.stats.history.overShare + d1.stats.history.tooLarge === 1 && !d1.stats.history.budgetExhausted && d1.stats.history.calls <= 30,
    `the dense wallet first in line: all 20 other wallets' histories read in ${d1.stats.history.calls} call(s) of the 400, the dense one stopped once the width it learned left more reads than a scan has (read ${d1.stats.history.read}, stopped ${d1.stats.history.overShare + d1.stats.history.tooLarge})`);
  ok(circ.length === 4 && circ.every((w) => lights.indexOf(w) < 4) && d1.ev[lights[4]].circular === false && d1.ev[lights[0]].selfFundedCalls === 60,
    `...and the circular wallets behind it are found (${circ.length} of 4)`);
  ok(d1.ev[D].fundingRead === false && d1.ev[D].callsSettled === 100 && d1.ev[D].circular === false,
    "the dense wallet itself is behind: its payments count as they are (the behaviour without the reader), never netted blind");
  ok(d1.calls.filter(touchesD).length <= 16,
    `...and it narrowed the width it reads before splitting its 20 payers: ${d1.calls.filter(touchesD).length} call(s) touch it (each payer split first doubles them)`);
  ok(lights.every((w) => !st.wallets.get(w).hp.length && !st.wallets.get(w).ep && !st.wallets.get(w).st) && st.wallets.get(D).hp.length === 1,
    "a wallet read and worked keeps no progress and no read accounting; the stopped one keeps where it got to");
  const retryAt = st.wallets.get(D).retryAt;
  ok(retryAt === NOW + 86_400_000 && parseFundingState(serializeFundingState(st), USDC).wallets.get(D).retryAt === retryAt && lights.every((w) => st.wallets.get(w).retryAt === 0),
    "its retry is a day away, persisted with the state (every other wallet has none)");
  // An hour later: it waits, and costs nothing.
  const d2 = await scanOnce({ sellers: sells, pays: dPays, outs: dOuts, state: st, latest: latest + 1_800, span: SPAN, historyFrom: 2_797_221, rpcOpts: denseRpc, now: NOW + 3_600_000 });
  ok(d2.stats.history.waiting === 1 && d2.calls.filter((c) => touchesD(c) && Array.isArray(c.topics[2])).length === 0 && d2.ev[D].callsSettled === 100,
    `an hour later the dense wallet waits: no history read touches it (${d2.calls.filter(touchesD).length} call(s) touching it at all)`);
  // A day later it is NOT read again. It stopped at a width it has never
  // tried, and at that width what is left of its history needs more calls
  // than a scan has: it is not started, costs nothing, keeps that width, and
  // waits again, two days this time. (Before, it came back at twice that
  // width - one it had already been refused at - and learned the same thing
  // again every time it came back.)
  const learned = { ...st.wallets.get(D).hp[0] };
  const d3 = await scanOnce({ sellers: sells, pays: dPays, outs: dOuts, state: st, latest: latest + 45_000, span: SPAN, historyFrom: 2_797_221, rpcOpts: denseRpc, now: NOW + 90_000_000 });
  ok(learned.pg === 0 && d3.calls.filter(touchesD).length === 0 && d3.stats.history.tooLarge === 1 && st.wallets.get(D).hp[0]?.w === learned.w && st.wallets.get(D).retryAt === NOW + 90_000_000 + 2 * 86_400_000,
    `a day later it is not started (${d3.calls.filter(touchesD).length} calls touch it): the width it stopped at (${learned.w}, never tried) leaves more reads than a scan has, and it waits again, two days this time`);

  // A WALLET WHOSE EARLIER READ GOT NOWHERE reads nothing else until that read
  // is answered. Back from a wait with a read of its 20 dense payers refused
  // at every width it tried, and five new payers since: the refused read is
  // probed first, at the width it had not tried yet (not twice it), narrows,
  // and stops - and not one call is spent on the new payers, whose reads it
  // could not use while that one stands. (Before, the new payers were read
  // first, at the narrow width the refused read had learned, every time it
  // came back.)
  const G2 = addr("d9");
  const denseP = Array.from({ length: 20 }, (_, k) => P(5300 + k)), newP = Array.from({ length: 5 }, (_, k) => P(5350 + k));
  const g2Pays = [];
  for (const p of denseP) for (let c = 0; c < 5; c++) g2Pays.push({ wallet: G2, payer: p, usd: 0.01, pos: posOf(latest - 5_000 + c, 1) });
  for (const p of newP) for (let c = 0; c < 3; c++) g2Pays.push({ wallet: G2, payer: p, usd: 0.01, pos: posOf(latest - 3_000 + c, 2) });
  const g2State = (payersInWindow) => parseFundingState(JSON.stringify({ v: 2, token: USDC, wallets: { [G2]: { c: latest, t: posOf(latest - SPAN, 0) - 1, s: latest - SPAN, x: 0, seen: NOW, lc: null, st: 1, ra: NOW - 1, hp: [["o", -1, denseP, 2_797_221, 1_000_000, [], 0]], p: {}, k: {}, b: {} } } }), USDC);
  const g2Rpc = { refuse: (p, span) => (Array.isArray(p.topics?.[2]) && denseP.some((x) => p.topics[2].includes(topic(x))) && span > 10_000 ? SIZE_REFUSAL : false) };
  const namesNew = (c) => Array.isArray(c.topics[2]) && newP.some((x) => c.topics[2].includes(topic(x)));
  const namesDense = (c) => Array.isArray(c.topics[2]) && denseP.some((x) => c.topics[2].includes(topic(x)));
  const g2st = g2State();
  const g2 = await scanOnce({ sellers: [seller(G2, "gate.example")], pays: g2Pays, outs: [], state: g2st, latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: g2Rpc });
  const g2Dense = g2.calls.filter(namesDense);
  ok(g2.calls.filter(namesNew).length === 0 && g2Dense.length >= 1 && g2Dense.length <= 3 && g2Dense[0].span === 1_000_000 && g2.stats.history.tooLarge === 1 && g2.ev[G2].fundingRead === false && g2st.wallets.get(G2).retryAt > NOW,
    `back from a wait, a read refused at every width it tried goes first, at the width it had not tried (${g2Dense[0]?.span}); it stops after ${g2Dense.length} call(s), and its 5 new payers cost nothing (${g2.calls.filter(namesNew).length} calls name them)`);
  const g2Quiet = await scanOnce({ sellers: [seller(G2, "gate.example")], pays: g2Pays.filter((t) => !denseP.includes(t.payer)), outs: [], state: g2State(), latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: g2Rpc });
  ok(g2Quiet.calls.filter(namesNew).length === 1 && g2Quiet.calls.filter(namesDense).length === 0 && g2Quiet.ev[G2].fundingRead === true,
    `(control: with its dense payers not paying this window, that read is not picked up and the new payers are read at once, in ${g2Quiet.calls.filter(namesNew).length} call)`);

  // Several such wallets on a tight budget: the reads go to the jobs whose
  // wallets have overrun least, so every light wallet is read before any
  // dense one gets another turn (a cap alone would let the first dense
  // wallets take their whole share before the light ones were reached).
  const Ds = [addr("d4"), addr("d5"), addr("d6")];
  const manyPays = [...dPays];
  Ds.forEach((d, n) => { for (let k = 0; k < 20; k++) for (let c = 0; c < 6; c++) manyPays.push({ wallet: d, payer: P(5100 + n * 20 + k), usd: 0.01, pos: posOf(latest - 4_000 + k * 6 + c, 2) }); });
  const manyRpc = { refuse: (p, span) => (Array.isArray(p.topics?.[1]) && Ds.some((d) => p.topics[1].includes(topic(d))) && span > 10_000 ? SIZE_REFUSAL : false) };
  const many = await scanOnce({ sellers: [...Ds.map((d, n) => seller(d, `dense-${n}.example`)), ...sells.slice(1)], pays: manyPays, outs: dOuts, state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: manyRpc, readOpts: { maxCalls: 60, walletChunk: 8 } });
  ok(lights.every((w) => many.ev[w].fundingRead === true) && lights.slice(0, 4).every((w) => many.ev[w].circular === true) && Ds.every((d) => many.ev[d].fundingRead === false) && many.stats.history.calls <= 60,
    `three dense wallets first, a 60-call budget: every one of the 20 light wallets is read (${lights.filter((w) => many.ev[w].fundingRead).length}) and the four circular ones found; the dense ones stop on what is left (${many.stats.history.calls} calls)`);

  // AN RPC THAT LIMITS THE BLOCK RANGE (a public endpoint: "eth_getLogs is
  // limited to a 2,000 range"): no split fits a whole history under it.
  // Before, each refusal split the job and the scan spent its whole budget
  // reading nothing, every hour. Now the history read stops at the first such
  // answer and says why; no wallet is made to wait for the RPC's limit.
  const RANGE = "{\"code\":-32614,\"message\":\"eth_getLogs is limited to a 2,000 range\"}";
  const rlLines = [];
  const rl = await scanOnce({ sellers: sells.slice(1), pays: dPays, outs: dOuts, state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: { refuse: (p, span) => (span > 2_000 ? RANGE : false) }, readOpts: { onProgress: (l) => rlLines.push(l) } });
  const rlNote = LB.fundingReadNotes({ readStopped: "range-limited", rangeLimitFits: rl.stats.history.rangeLimitFits });
  ok(rl.stats.history.rangeLimitFits === false && rlLines.some((l) => /primary RPC without that limit/.test(l) && !/FUNDING_HISTORY_CHUNK_BLOCKS/.test(l)) && !/FUNDING_HISTORY_CHUNK_BLOCKS/.test(rlNote) && /primary RPC/.test(rlNote),
    "under a 2,000-block limit the log line and the scan's note name another RPC (or turning the reader off), not FUNDING_HISTORY_CHUNK_BLOCKS: no range that narrow reads a history within a scan");
  ok(rl.stats.history.calls === 1 && rl.stats.history.stopped === "range-limited" && rl.stats.history.read === 0 && rl.stats.history.overShare === 0 && rl.ev[lights[0]].fundingRead === false && rl.ev[lights[0]].callsSettled === 60,
    `a range-limited RPC: the history read stops after ${rl.stats.history.calls} call (not the budget), every wallet counted as it is`);
  const rst = createFundingState(USDC);
  await scanOnce({ sellers: sells.slice(1), pays: dPays, outs: dOuts, state: rst, latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: { refuse: (p, span) => (span > 2_000 ? RANGE : false) } });
  ok([...rst.wallets.values()].every((ws) => !ws.retryAt), "...and no wallet waits a day for it: the limit is the RPC's, not the wallet's");
  const plural = await scanOnce({ sellers: sells.slice(1), pays: dPays, outs: dOuts, state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: { refuse: (p, span) => (span > 10_000 ? "{\"code\":-32600,\"message\":\"eth_getLogs and eth_newFilter are limited to a 10,000 blocks range\"}" : false) } });
  ok(plural.stats.history.calls === 1 && plural.stats.history.stopped === "range-limited", `the same for "limited to a 10,000 blocks range" (${plural.stats.history.calls} call)`);
  // ONE DENSE STRETCH FAR FROM THE HEAD is read in the scan that meets it:
  // 12,000 transfers to one payer over 12,000 blocks about 55M blocks back.
  // Once any read of it has been answered, its width is left to double back
  // past the stretch - projecting the narrow width over the whole rest of the
  // history called it too large, and it was never read.
  const ES = addr("f1");
  const esOuts = [], esPays = [];
  for (let j = 0; j < 5; j++) { const p = P(7200 + j); esOuts.push(log(ES, p, usd(0.2), start - 2_000_000, j)); for (let k = 0; k < 12; k++) esPays.push({ wallet: ES, payer: p, usd: 0.01, pos: posOf(latest - 20_000 + k, j) }); }
  for (let i = 0; i < 12_000; i++) esOuts.push(log(ES, P(7200), 1, 5_000_000 + i, 50));
  const es = await scanOnce({ sellers: [seller(ES, "early-dense.example")], pays: esPays, outs: esOuts, state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221 });
  ok(es.ev[ES].fundingRead === true && es.ev[ES].circular === true && es.ev[ES].selfFundedCalls === 60 && es.stats.history.tooLarge === 0 && es.stats.history.calls <= 33,
    `one dense stretch about 55M blocks before the head: read in one scan (${es.stats.history.calls} calls), all 60 payments netted`);
  const blk = await scanOnce({ sellers: sells.slice(1), pays: dPays, outs: dOuts, state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: { rangeLimit: 100_000 } });
  ok(blk.stats.history.calls === 1 && blk.stats.history.stopped === "range-limited", "the same for a 'block range too large' answer");
  const wideLines = [];
  const wide = await scanOnce({ sellers: sells.slice(1), pays: dPays, outs: dOuts, state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: { refuse: (p, span) => (span > 20_000_000 ? "{\"code\":-32600,\"message\":\"eth_getLogs is limited to a 20,000,000 range\"}" : false) }, readOpts: { onProgress: (l) => wideLines.push(l) } });
  ok(wide.stats.history.rangeLimitFits === true && wideLines.some((l) => /FUNDING_HISTORY_CHUNK_BLOCKS at or under 20000000/.test(l)), "(a limit a bounded history range fits under within a scan names FUNDING_HISTORY_CHUNK_BLOCKS, at the limit it stated)");
  const chunked = await scanOnce({ sellers: sells.slice(1), pays: dPays, outs: dOuts, state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: { rangeLimit: 20_000_000 }, readOpts: { historyChunkBlocks: 20_000_000 } });
  ok(chunked.stats.history.read === 20 && lights.slice(0, 4).every((w) => chunked.ev[w].circular === true), `with FUNDING_HISTORY_CHUNK_BLOCKS under the limit the same histories are read in full (${chunked.stats.history.calls} calls)`);
  const tiny = await scanOnce({ sellers: sells.slice(1), pays: dPays, outs: dOuts, state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221, readOpts: { historyChunkBlocks: 10_000 } });
  ok(tiny.stats.history.calls === 0 && tiny.stats.history.tooLarge === 20 && tiny.stats.history.failed === 20 && lights.every((w) => tiny.ev[w].fundingRead === false), `a range bound so small no history fits one scan's budget is not started (${tiny.stats.history.calls} calls, ${tiny.stats.history.tooLarge} too large), and each counts as history still pending`);
  // A RATE LIMIT stops the read: splitting would only send more requests to a
  // provider that is throttling us.
  const RATE = "{\"code\":429,\"message\":\"Your app has exceeded its compute units per second capacity.\"}";
  const rt = await scanOnce({ sellers: sells.slice(1), pays: dPays, outs: dOuts, state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: { refuse: () => RATE } });
  ok(rt.stats.history.calls === 1 && rt.stats.history.stopped === "rate-limited" && rt.stats.history.read === 0, `a rate-limited RPC: stopped after ${rt.stats.history.calls} call`);
  // AN ERROR THAT NAMES NO CAUSE ("Internal error", on every read) is split
  // like a refusal only three times in a row across the scan's reads, then
  // the read stops. Before, every such answer split its job, so the whole
  // day's allowance went on refused calls and nothing was read.
  const INTERNAL = "{\"code\":-32603,\"message\":\"Internal error\"}";
  const ie = await scanOnce({ sellers: sells.slice(1), pays: dPays, outs: dOuts, state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: { refuse: () => INTERNAL } });
  ok(ie.stats.history.calls === 4 && ie.stats.history.stopped === "errors" && ie.stats.history.read === 0 && ie.ev[lights[0]].fundingRead === false && ie.ev[lights[0]].callsSettled === 60,
    `an RPC that fails every read with an unexplained error: the history read stops after ${ie.stats.history.calls} calls (three splits, then stopped), every wallet counted as it is`);
  const ieKnown = knownState({ [lights[0]]: [P(6000)], [lights[1]]: [P(6005)] }, start - 1);
  const ieCtl = SF.newFundingReadControl();
  const ieOut = await readSellerFunding({ rpc: fakeRpc(dOuts, { refuse: () => INTERNAL }), token: USDC, state: ieKnown, wallets: [{ wallet: lights[0], payers: new Set([P(6000)]) }, { wallet: lights[1], payers: new Set([P(6005)]) }], latest, windowStartBlock: start, ctl: ieCtl });
  ok(ieOut.calls === 4 && ieCtl.stop === "errors" && ieOut.behind === 2, `...and the outbound read the same (${ieOut.calls} calls, then stopped; both wallets left at their cursors)`);
  let flakyOut = 0;
  const ieMany = knownState(Object.fromEntries(lights.slice(0, 5).map((w, i) => [w, [P(6000 + i * 5)]])), start - 1);
  const ieOut2 = await readSellerFunding({ rpc: fakeRpc(dOuts, { refuse: () => (++flakyOut <= 8 && flakyOut % 2 === 1 ? INTERNAL : false) }), token: USDC, state: ieMany, wallets: lights.slice(0, 5).map((w, i) => ({ wallet: w, payers: new Set([P(6000 + i * 5)]) })), latest, windowStartBlock: start, walletChunk: 1, ctl: SF.newFundingReadControl() });
  ok(ieOut2.caughtUp === 5 && !ieOut2.transportError && ieOut2.refusals === 4, `...where, as in the history read, errors each followed by an answer do not add up (${ieOut2.refusals} split, all 5 caught up)`);
  let flaky = 0;
  const onceEach = await scanOnce({ sellers: sells.slice(1), pays: dPays, outs: dOuts, state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: { refuse: () => (++flaky <= 8 && flaky % 2 === 1 ? INTERNAL : false) } });
  ok(onceEach.stats.history.read === 20 && !onceEach.stats.history.stopped && onceEach.stats.history.refusals === 4, `(four such errors, each followed by an answer, are split as before - only errors in a row count: all 20 read, ${onceEach.stats.history.refusals} refusals)`);
  // THE TIMEOUT BOUND IS THE SCAN'S: with one control shared by the passes
  // (as runLeaderboard does), an RPC that times out on everything costs a few
  // calls in all, not a few per pass.
  const W1 = addr("d8");
  const tState = knownState({ [W1]: [P(7000)] }, start - 1);
  const shared = SF.newFundingReadControl();
  const hang = async () => { throw new Error("All RPCs failed for eth_getLogs: The operation was aborted due to timeout"); };
  const wl = [{ wallet: W1, payers: new Set([P(7000), P(7001)]) }];
  const o1 = await readSellerFunding({ rpc: hang, token: USDC, state: tState, wallets: wl, latest, windowStartBlock: start, minRangeBlocks: 100, ctl: shared });
  const o2 = await readPayerHistory({ rpc: hang, token: USDC, state: tState, wallets: wl, windowStartBlock: start, historyFromBlock: 2_797_221, minRangeBlocks: 100, ctl: shared });
  const o3 = await readFundingGaps({ rpc: hang, token: USDC, state: tState, wallets: [W1], windowStartBlock: start, ctl: shared });
  ok(o1.calls + o2.stats.calls + o3.stats.calls === 4 && shared.stop === "timeouts" && o2.stats.failed === 1, `an RPC that times out on everything: ${o1.calls + o2.stats.calls + o3.stats.calls} calls across the three passes, then stopped (was a few per pass)`);
}
// --- 3c. A read resumes where it stopped; its calls count across scans --------------
{
  // LEADERBOARD_FUNDING_WALLET_MAX_CALLS=0 is "no calls past the planned
  // ones", not "read nothing": light wallets are read in full, and a wallet
  // whose first read is refused stops after the calls it was planned.
  const SPAN = 302_400, latest = 60_000_000, start = latest - SPAN;
  const lights = Array.from({ length: 20 }, (_, i) => "0x" + (0x3000 + i).toString(16).padStart(40, "0"));
  const lp = [], lo = [];
  lights.forEach((w, i) => { for (let j = 0; j < 5; j++) { const p = P(6200 + i * 5 + j); if (i < 4) lo.push(log(w, p, usd(0.2), start - 2_000_000, j)); for (let k = 0; k < 12; k++) lp.push({ wallet: w, payer: p, usd: 0.01, pos: posOf(latest - 20_000 + k, j) }); } });
  const sells = lights.map((w, i) => seller(w, `z-${i}.example`));
  const z = await scanOnce({ sellers: sells, pays: lp, outs: lo, state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221, readOpts: { walletMaxCalls: 0 } });
  ok(z.stats.history.read === 20 && lights.slice(0, 4).every((w) => z.ev[w].circular === true) && lights.slice(4).every((w) => z.ev[w].circular === false),
    `walletMaxCalls 0: every light wallet is still read (${z.stats.history.read} of 20) and the four paid with their own money found`);
  const D = addr("e7");
  const dp = [];
  for (let k = 0; k < 20; k++) for (let c = 0; c < 5; c++) dp.push({ wallet: D, payer: P(6400 + k), usd: 0.01, pos: posOf(latest - 5_000 + k * 5 + c, 1) });
  const dcalls = [];
  const zd = await scanOnce({ sellers: [seller(D, "zd.example")], pays: dp, outs: [], state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: { refuse: (p, span) => (Array.isArray(p.topics?.[1]) && p.topics[1].includes(topic(D)) && span > 10_000 ? SIZE_REFUSAL : false) }, readOpts: { walletMaxCalls: 0 } });
  for (const c of zd.calls) if (Array.isArray(c.topics[2])) dcalls.push(c);
  ok(dcalls.length === 1 && zd.stats.history.overShare === 1, `...and a wallet refused on its first read stops after the one call it was planned (${dcalls.length} call, over its share ${zd.stats.history.overShare})`);

  // RESUMES: a wallet whose history holds a dense stretch, on a budget too
  // small to finish it in one scan, stops where the budget ran out, keeps its
  // progress and its episode, and does not wait; the next scan resumes at the
  // block it had reached (nothing below it is read again), and what it read
  // before still counts: all 60 of its funded payers' payments netted.
  const R = addr("e8");
  const ro = [], rp = [];
  for (let j = 0; j < 5; j++) { const p = P(6500 + j); ro.push(log(R, p, usd(0.2), start - 2_000_000, j)); for (let k = 0; k < 12; k++) rp.push({ wallet: R, payer: p, usd: 0.01, pos: posOf(latest - 30_000 + k, j) }); }
  for (let i = 0; i < 25_000; i++) ro.push(log(R, P(6500), 1000 + i, start - 5_000_000 + i * 80, i % 1000));
  let rst = createFundingState(USDC);
  const r1 = await scanOnce({ sellers: [seller(R, "resume.example")], pays: rp, outs: ro, state: rst, latest, span: SPAN, historyFrom: 2_797_221, readOpts: { maxCalls: 6 } });
  const saved = rst.wallets.get(R).hp.find((g) => g.k === "o");
  const epAfter = rst.wallets.get(R).ep;
  ok(r1.stats.history.budgetExhausted && r1.ev[R].fundingRead === false && saved && saved.lo > 2_797_221 && !rst.wallets.get(R).retryAt && !rst.wallets.get(R).st && epAfter?.sp === r1.stats.history.calls,
    `a budget of 6 calls: the dense-history wallet stops at block ${saved?.lo}, keeps where it got to (${saved ? saved.l.length / 3 : 0} transfers below it) and its episode (${epAfter?.sp} spent), and does not wait (${r1.stats.history.calls} calls)`);
  rst = parseFundingState(serializeFundingState(rst), USDC);
  const back = rst.wallets.get(R).hp.find((g) => g.k === "o");
  ok(back && back.lo === saved.lo && back.w === saved.w && back.l.length === saved.l.length && back.pg === saved.pg && !!epAfter && rst.wallets.get(R).ep?.sp === epAfter.sp && rst.wallets.get(R).ep?.pl === epAfter.pl,
    "its progress round-trips through the volume: the next block, the width it learned, the transfers below it, and the episode");
  const r2 = await scanOnce({ sellers: [seller(R, "resume.example")], pays: rp, outs: ro, state: rst, latest: latest + 1_800, span: SPAN, historyFrom: 2_797_221, now: NOW + 3_600_000 });
  const outCalls = r2.calls.filter((c) => Array.isArray(c.topics[2]) && c.topics[1].includes(topic(R)));
  ok(r2.stats.history.resumed >= 1 && outCalls.length && outCalls.every((c) => parseInt(c.fromBlock, 16) >= saved.lo), `the next scan, an hour later, resumes at block ${saved.lo}: none of its ${outCalls.length} outbound history call(s) reads below it`);
  ok(r2.ev[R].fundingRead === true && r2.ev[R].circular === true && r2.ev[R].selfFundedCalls === 60 && !rst.wallets.get(R).hp.length && !rst.wallets.get(R).st,
    "...and what it read before still counts: all 60 payments netted, circular; its progress and its waits are cleared once it is worked");

  // ITS CALLS COUNT ACROSS SCANS: a read resumed within the same episode is
  // not planned again, so a wallet cannot draw a fresh allowance every hour.
  // The same wallet, stopped in the middle of its dense stretch an hour ago
  // with 9 calls spent against 3 planned: on a share of 8 it has 2 left.
  const E = addr("e9");
  const eo = ro.map((l) => (l.topics[1] === topic(R) ? { ...l, topics: [l.topics[0], topic(E), l.topics[2]] } : l));
  const ep = rp.map((t) => ({ ...t, wallet: E }));
  const midway = (episode) => parseFundingState(JSON.stringify({ v: 2, token: USDC, wallets: { [E]: { c: latest, t: posOf(latest - SPAN, 0) - 1, s: latest - SPAN, x: 0, seen: NOW, lc: null, ...(episode ? { ep: episode } : {}), hp: [["o", -1, [P(6500), P(6501), P(6502), P(6503), P(6504)], start - 5_000_000, 447_571, [], 1]], p: {}, k: {}, b: {} } } }), USDC);
  const eCalls = (r) => r.calls.filter((c) => Array.isArray(c.topics[2]) && (c.topics[1].includes(topic(E)) || c.topics[2].includes(topic(E)))).length;
  const e1 = await scanOnce({ sellers: [seller(E, "episode.example")], pays: ep, outs: eo, state: midway([3, 9, NOW - 3_600_000]), latest, span: SPAN, historyFrom: 2_797_221, readOpts: { walletMaxCalls: 8 } });
  ok(e1.stats.history.overShare === 1 && eCalls(e1) === 2 && e1.ev[E].fundingRead === false, `resumed on the same episode it is planned nothing more: 2 calls left of its share (3 planned + 8 - 9 spent), and it stops there (${eCalls(e1)} made)`);
  const e2 = await scanOnce({ sellers: [seller(E, "episode.example")], pays: ep, outs: eo, state: midway(null), latest, span: SPAN, historyFrom: 2_797_221, readOpts: { walletMaxCalls: 8 } });
  ok(e2.ev[E].fundingRead === true && e2.ev[E].circular === true && eCalls(e2) > 2, `(control: the same progress on a new episode is planned what it needs, and read in full on the same share, ${eCalls(e2)} calls)`);

  // THE ACCOUNTING ROUND-TRIPS through the volume: the episode, the waits,
  // a segment read in full, the payers too dense to hold, the targeted
  // outbound mark and the day's record.
  const rt = parseFundingState(JSON.stringify({ v: 2, token: USDC, wallets: { [E]: { c: latest, t: 0, s: 0, x: 0, seen: NOW, lc: null, ep: [3, 9, NOW - 3_600_000], st: 2, ra: NOW + 5, hp: [["o", -1, [P(6501)], 1_000, 0, [], 2]], td: [P(6500), P(6501)], oh: NOW - 5, p: {}, k: {}, b: {} } }, d: [[NOW - 1000, 7]] }), USDC);
  const rt2 = parseFundingState(serializeFundingState(rt), USDC);
  const rw = rt2.wallets.get(E);
  ok(rw.ep?.pl === 3 && rw.ep?.sp === 9 && rw.ep?.t === NOW - 3_600_000 && rw.st === 2 && rw.retryAt === NOW + 5 && rw.hp[0]?.pg === 2 && rw.td?.join() === [P(6500), P(6501)].join() && rw.oh === NOW - 5 && SF.fundingDayCalls(rt2, NOW) === 7,
    "the episode, the waits, a segment read in full, the payers too dense to hold, the targeted outbound mark and the day's record all round-trip through the volume");

  // A READ THAT GOT NO TURN is not marked as having got nowhere: a budget
  // spent before it keeps it as it was, so it is not put last next time.
  const nt = midway([3, 3, NOW - 3_600_000]);
  const ntr = await scanOnce({ sellers: [seller(E, "episode.example")], pays: ep, outs: eo, state: nt, latest, span: SPAN, historyFrom: 2_797_221, readOpts: { maxCalls: 0, scanMaxCalls: 400 } });
  ok(ntr.stats.history.calls === 0 && ntr.stats.history.budgetExhausted && nt.wallets.get(E).hp.find((g) => g.k === "o")?.pg === 1, "a resumed read the budget never reached keeps its mark of progress (not put last next scan)");
  const nf = await scanOnce({ sellers: [seller(E, "episode.example")], pays: ep, outs: eo, state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221, readOpts: { maxCalls: 0 } });
  ok(nf.stats.history.calls === 0 && nf.ev[E].fundingRead === false, "(a new read on no budget: nothing read, the wallet counts as it is)");

  // A WALLET THAT HAS HAD TO WAIT starts a NEW read (payers it had not seen)
  // at the configured width, like any other: how far another read of it had
  // to narrow says nothing about new payers. (Before, it started them at that
  // narrow width and paid for about eight answered reads of each doubling
  // back, every time it came back.)
  const waited = (st) => parseFundingState(JSON.stringify({ v: 2, token: USDC, wallets: { [E]: { c: latest, t: posOf(latest - SPAN, 0) - 1, s: latest - SPAN, x: 0, seen: NOW, lc: null, ...(st ? { st, ra: NOW - 1, hw: 10_000_000 } : {}), p: {}, k: {}, b: {} } } }), USDC);
  const firstOut = (r) => r.calls.find((c) => Array.isArray(c.topics[2]) && c.topics[1].includes(topic(E)));
  const wr = await scanOnce({ sellers: [seller(E, "episode.example")], pays: ep, outs: eo, state: waited(1), latest, span: SPAN, historyFrom: 2_797_221 });
  const wr0 = await scanOnce({ sellers: [seller(E, "episode.example")], pays: ep, outs: eo, state: waited(0), latest, span: SPAN, historyFrom: 2_797_221 });
  ok(firstOut(wr)?.span === latest - 2_797_221 + 1 && firstOut(wr0)?.span === latest - 2_797_221 + 1, `a wallet back from a wait reads new payers across the whole history at once (${firstOut(wr)?.span} blocks), as one that never waited does (${firstOut(wr0)?.span})`);

  // A WALLET WITH MANY NEW PAYERS never keeps the light wallets behind it
  // from being read: first in priority, with 30,000 new payers (150 planned
  // reads), on a budget of 60. The wallets with a little of their plan left
  // go first; the big one takes what is left, and keeps its progress.
  {
    const BIG = addr("ef");
    const bigPays = [...lp];
    for (let j = 0; j < 30_000; j++) bigPays.push({ wallet: BIG, payer: "0x" + (0x20000000 + j).toString(16).padStart(40, "0"), usd: 0.01, pos: posOf(latest - 25_000 + (j % 20_000), 5 + Math.floor(j / 20_000)) });
    const bst = createFundingState(USDC);
    const bg = await scanOnce({ sellers: [seller(BIG, "big.example"), ...sells], pays: bigPays, outs: lo, state: bst, latest, span: SPAN, historyFrom: 2_797_221, readOpts: { maxCalls: 60, scanMaxCalls: 400 } });
    const bigSegs = bst.wallets.get(BIG).hp.filter((g) => g.k === "o");
    ok(lights.every((w) => bg.ev[w].fundingRead === true) && lights.slice(0, 4).every((w) => bg.ev[w].circular === true) && bg.ev[BIG].fundingRead === false && bigSegs.filter((g) => g.pg === 2).length > 0 && bigSegs.length === 150,
      `a wallet with 30,000 new payers first in line, a budget of 60: all 20 light wallets read (${lights.filter((w) => bg.ev[w].fundingRead).length}), the big one reads ${bigSegs.filter((g) => g.pg === 2).length} of its 150 payer chunks and keeps each`);
  }

  // A LIGHT WALLET PACKED WITH A HEAVY ONE is never made to wait for it: the
  // calls that isolate the heavy one are planned for every wallet in the job,
  // so when the budget runs out mid-way no light wallet is over its plan.
  const H2 = addr("ec");
  const h2p = [...lp];
  for (let k = 0; k < 20; k++) for (let c = 0; c < 5; c++) h2p.push({ wallet: H2, payer: P(6800 + k), usd: 0.01, pos: posOf(latest - 5_000 + k * 5 + c, 1) });
  const h2st = createFundingState(USDC);
  const h2 = await scanOnce({ sellers: [seller(H2, "heavy2.example"), ...sells], pays: h2p, outs: lo, state: h2st, latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: { refuse: (p, span) => (Array.isArray(p.topics?.[1]) && p.topics[1].includes(topic(H2)) && span > 10_000 ? SIZE_REFUSAL : false) }, readOpts: { maxCalls: 4 } });
  ok(h2.stats.history.budgetExhausted && lights.every((w) => !h2st.wallets.get(w).retryAt), `four calls, spent isolating the heavy wallet in the packed job: no light wallet waits for it (${lights.filter((w) => h2st.wallets.get(w).retryAt).length} waiting)`);

  // FIRST READS GO BEFORE SPLITS. Three heavy wallets packed together first
  // in line, the twenty light wallets behind them in packs of three, and a
  // budget of exactly the first reads: one refused call for the heavy pack,
  // seven for the light packs, two for the second read of the four light
  // wallets that funded their payers. Every light wallet is read and the four
  // found paying themselves; the heavy pack's splits wait for a later call.
  // (Before, the splits isolating the heavy wallets came first, and the light
  // wallets behind them waited for every one of them.)
  const Hv = [addr("e3"), addr("e4"), addr("e5")];
  const hvPays = [...lp];
  Hv.forEach((h, n) => { for (let k = 0; k < 20; k++) for (let c = 0; c < 5; c++) hvPays.push({ wallet: h, payer: P(7300 + n * 20 + k), usd: 0.01, pos: posOf(latest - 5_000 + k * 5 + c, 1) }); });
  const hvRpc = { refuse: (p, span) => (Array.isArray(p.topics?.[1]) && Hv.some((h) => p.topics[1].includes(topic(h))) && span > 10_000 ? SIZE_REFUSAL : false) };
  const namesHv = (c) => Array.isArray(c.topics[2]) && Hv.some((h) => c.topics[1].includes(topic(h)) || c.topics[2].includes(topic(h)));
  const fr = await scanOnce({ sellers: [...Hv.map((h, n) => seller(h, `hv-${n}.example`)), ...sells], pays: hvPays, outs: lo, state: createFundingState(USDC), latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: hvRpc, readOpts: { maxCalls: 10, walletChunk: 3 } });
  ok(fr.stats.history.calls === 10 && lights.every((w) => fr.ev[w].fundingRead === true) && lights.slice(0, 4).every((w) => fr.ev[w].circular === true) && fr.calls.filter(namesHv).length === 1,
    `first reads before splits: on a budget of the first reads (${fr.stats.history.calls} calls) every light wallet behind a refused heavy pack is read (${lights.filter((w) => fr.ev[w].fundingRead).length} of 20) and the four circular ones found; ${fr.calls.filter(namesHv).length} call names a heavy wallet`);

  // A READ THAT NEVER GOT A TURN is packed with others the next scan, not read
  // alone. A budget of two reads the first two packs of three; the other
  // fourteen wallets' reads never get a turn. The next scan packs those
  // fourteen three to a call (five calls), where it once read each alone.
  const ntst = createFundingState(USDC);
  await scanOnce({ sellers: sells, pays: lp, outs: lo, state: ntst, latest, span: SPAN, historyFrom: 2_797_221, readOpts: { maxCalls: 2, walletChunk: 3, scanMaxCalls: 400 } });
  const late = lights.slice(6);
  const nt2 = await scanOnce({ sellers: sells, pays: lp, outs: lo, state: ntst, latest: latest + 1_800, span: SPAN, historyFrom: 2_797_221, now: NOW + 3_600_000, readOpts: { walletChunk: 3 } });
  const lateCalls = nt2.calls.filter((c) => Array.isArray(c.topics[2]) && late.some((w) => c.topics[1].includes(topic(w))));
  ok(lateCalls.length === 5 && lateCalls.every((c) => c.topics[1].length >= 2) && lights.every((w) => nt2.ev[w].fundingRead === true) && lights.slice(0, 4).every((w) => nt2.ev[w].circular === true),
    `the fourteen wallets whose reads got no turn are read the next scan in ${lateCalls.length} packed calls (none alone), and all 20 are read, the four circular found`);

  // A SPLIT LEFT UNFINISHED goes on where it stopped. One heavy wallet packed
  // with 36 light ones (one job of 37), on a budget of two: the job is refused
  // and so is its half holding the heavy wallet. The three jobs left unread
  // keep their groups, and the next scan reads those, never the whole 37
  // again.
  const Hx = addr("e6");
  const gLights = Array.from({ length: 36 }, (_, i) => "0x" + (0x3100 + i).toString(16).padStart(40, "0"));
  const gp = [];
  for (let k = 0; k < 20; k++) for (let c = 0; c < 5; c++) gp.push({ wallet: Hx, payer: P(7600 + k), usd: 0.01, pos: posOf(latest - 5_000 + k * 5 + c, 1) });
  gLights.forEach((w, i) => { for (let j = 0; j < 5; j++) for (let k = 0; k < 12; k++) gp.push({ wallet: w, payer: P(7400 + i * 5 + j), usd: 0.01, pos: posOf(latest - 20_000 + k, j) }); });
  const gSells = [seller(Hx, "hx.example"), ...gLights.map((w, i) => seller(w, `gl-${i}.example`))];
  const gRpc = { refuse: (p, span) => (Array.isArray(p.topics?.[1]) && p.topics[1].includes(topic(Hx)) && span > 10_000 ? SIZE_REFUSAL : false) };
  const gst2 = createFundingState(USDC);
  const g1 = await scanOnce({ sellers: gSells, pays: gp, outs: [], state: gst2, latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: gRpc, readOpts: { maxCalls: 2, walletChunk: 40, scanMaxCalls: 400 } });
  const groups = new Set([...gst2.wallets.values()].flatMap((ws) => ws.hp.map((g) => g.g)).filter(Boolean));
  const gRound = parseFundingState(serializeFundingState(gst2), USDC);
  const grouped = [...gRound.wallets.values()].flatMap((ws) => ws.hp).filter((g) => g.g).length;
  const g2 = await scanOnce({ sellers: gSells, pays: gp, outs: [], state: gRound, latest: latest + 1_800, span: SPAN, historyFrom: 2_797_221, rpcOpts: gRpc, now: NOW + 3_600_000, readOpts: { walletChunk: 40 } });
  const g2Hist = g2.calls.filter((c) => Array.isArray(c.topics[2]));
  const widest = Math.max(...g2Hist.map((c) => c.topics[1].length));
  ok(g1.stats.history.calls === 2 && g1.calls[0]?.topics[1].length === 37 && groups.size === 3 && grouped === 37,
    `two calls: the job of 37 and its half holding the heavy wallet are refused; the 37 wallets' reads are kept in ${groups.size} groups, through the volume`);
  const lightCalls = g2Hist.filter((c) => gLights.some((w) => c.topics[1].includes(topic(w)))).length;
  ok(widest <= 18 && gLights.every((w) => g2.ev[w].fundingRead === true) && g2.ev[Hx].fundingRead === false && lightCalls <= 9,
    `the next scan reads those groups (the widest call names ${widest} wallets, never the 37 again): all 36 light wallets read in ${lightCalls} calls`);

  // A GAP READ RESUMES the same way. A wallet funded one payer $1; the payer
  // then made 12,000 payments of $0.0001 before the next scan's window, which
  // spend what was left of that dollar. Cut short half-way through that gap,
  // the next attempt resumes where it stopped and still sees the first half:
  // the payer's later payments are its own money (nothing netted). Losing the
  // first half would leave part of the dollar and net them.
  const G = addr("ed"), GP = P(6900);
  const gOuts = [log(G, GP, usd(1), 100, 0)];
  const gPays = [];
  for (let k = 0; k < 12; k++) gPays.push({ wallet: G, payer: GP, usd: 0.01, pos: posOf(900 + k, 0) });
  for (let i = 0; i < 12_000; i++) gPays.push({ wallet: G, payer: GP, usd: 0.0001, pos: posOf(1_001 + i * 4, 1) });
  for (let k = 0; k < 12; k++) gPays.push({ wallet: G, payer: GP, usd: 0.01, pos: posOf(49_500 + k, 0) });
  const gst = createFundingState(USDC);
  await scanOnce({ sellers: [seller(G, "gap.example")], pays: gPays, outs: gOuts, state: gst, latest: 1_000, span: 500 });
  const gb = await scanOnce({ sellers: [seller(G, "gap.example")], pays: gPays, outs: gOuts, state: gst, latest: 50_000, span: 1_000, readOpts: { maxCalls: 4, scanMaxCalls: 400 } });
  const gseg = gst.wallets.get(G).hp.find((g) => g.k === "g");
  ok(gb.stats.gap.calls === 3 && gb.stats.gap.budgetExhausted && gseg && gseg.lo > 1_000 && gseg.l.length > 0 && gb.ev[G].fundingRead === false,
    `a gap read stopped by the budget (${gb.stats.gap.calls} calls): it keeps where it got to (block ${gseg?.lo}) and the ${gseg ? gseg.l.length / 3 : 0} payments below it, and the wallet counts as it is`);
  const afterGb = serializeFundingState(gst);
  const lost = parseFundingState(afterGb, USDC);
  const lostSeg = lost.wallets.get(G).hp.find((g) => g.k === "g");
  if (lostSeg) lostSeg.l = [];
  const gc = await scanOnce({ sellers: [seller(G, "gap.example")], pays: gPays, outs: gOuts, state: gst, latest: 50_000, span: 1_000, now: NOW + 90_000_000 });
  const gapCalls = gc.calls.filter((c) => Array.isArray(c.topics[2]) && c.topics[2].includes(topic(G)) && c.topics[1].includes(topic(GP)));
  ok(!!gseg && gc.stats.gap.resumed === 1 && gapCalls.length && gapCalls.every((c) => parseInt(c.fromBlock, 16) >= gseg.lo) && gc.ev[G].fundingRead === true && gc.ev[G].selfFundedCalls === 0,
    `a day later the gap read resumes at block ${gseg?.lo} (none of its ${gapCalls.length} call(s) below it), and with the first half kept the payer's window payments are its own money (${gc.ev[G].selfFundedCalls} netted)`);
  const gl = await scanOnce({ sellers: [seller(G, "gap.example")], pays: gPays, outs: gOuts, state: lost, latest: 50_000, span: 1_000, now: NOW + 90_000_000 });
  ok(gl.ev[G].selfFundedCalls === 12, `(control: the same resume with the first half's payments lost would net all ${gl.ev[G].selfFundedCalls} of them)`);

  // Gap progress saved for a gap that no longer starts where it did (the
  // wallet's pools have moved since) is not resumed: that gap is read whole.
  const stale = parseFundingState(afterGb, USDC);
  const sw = stale.wallets.get(G);
  sw.hp = [{ k: "g", h: 777, p: [GP], lo: 40_000, w: 0, l: [], pg: 1 }];
  const sc = [];
  const sg = await readFundingGaps({ rpc: fakeRpc([...gOuts, ...gPays.map(payLog)], { calls: sc }), token: USDC, state: stale, wallets: [G], windowStartBlock: 49_000, now: NOW + 90_000_000 });
  const need = Math.floor((sw.through + 1) / 1e6);
  ok(sg.stats.resumed === 0 && sc.length && Math.min(...sc.map((c) => parseInt(c.fromBlock, 16))) === need && !sw.hp.some((g) => g.h === 777),
    `progress kept for another gap (it started at block 777) is dropped: the gap is read from its own start, block ${need}`);

  // A STALE EPISODE starts over: one that nothing was charged to for a day
  // does not count against a wallet's next read.
  const S = addr("ea");
  const sst = parseFundingState(JSON.stringify({ v: 2, token: USDC, wallets: { [S]: { c: latest, t: posOf(latest - SPAN, 0) - 1, s: latest - SPAN, x: 0, seen: NOW, lc: null, ep: [1, 40, NOW - 2 * 86_400_000], p: {}, k: {}, b: {} } } }), USDC);
  const sp_ = [];
  for (let k = 0; k < 12; k++) sp_.push({ wallet: S, payer: P(6600), usd: 0.01, pos: posOf(latest - 1_000 + k, 0) });
  const sr = await scanOnce({ sellers: [seller(S, "stale.example")], pays: sp_, outs: [], state: sst, latest, span: SPAN, historyFrom: 2_797_221 });
  ok(sr.ev[S].fundingRead === true && sr.stats.history.overShare === 0, "an episode idle for a day starts over: 40 calls spent two days ago do not stop today's read");

  // THE PROGRESS IS CAPPED: past its per-wallet cap a wallet loses it and waits.
  const C = addr("eb");
  const cst = parseFundingState(JSON.stringify({ v: 2, token: USDC, wallets: { [C]: { c: latest, t: posOf(latest, 0), s: start, x: 0, seen: NOW, lc: null, hp: [["o", -1, [P(6700)], 5_000_000, 1000, [0, posOf(4_000_000, 0), 5, 0, posOf(4_000_001, 0), 6], 1]], p: {}, k: {}, b: {} } } }), USDC);
  ok(SF.fundingPartialLogCount(cst) === 2, "(a wallet holding two transfers of an unfinished read)");
  const counts = {};
  pruneFundingState(cst, { now: NOW, latest, maxPartialLogsPerWallet: 1, counts });
  ok(counts.progressDropped === 1 && !cst.wallets.get(C).hp.length && cst.wallets.get(C).retryAt === NOW + 86_400_000 && cst.wallets.get(C).td?.join() === P(6700), "progress over its cap (two transfers held, a cap of one) is dropped, that wallet waits, and the payer it could not hold is kept");
  ok(SF.fundingPartialLogCount(cst) === 0, "...so the state holds none of it");

  // TOO DENSE TO HOLD IS NOT READ AGAIN FROM THE START. A wallet whose
  // history with one of its payers is readable, but only in pieces, and holds
  // more transfers than its progress may keep between scans: its first
  // attempt spends its share, its progress is dropped, and it is marked. When
  // it comes back while that payer is still new to it, it is not read at all
  // (before, it read from the token's deployment again every time, spending
  // its plan and its share each time, and never finished). Once that payer is
  // not among its new payers, it is read as any other wallet.
  const M = addr("ee"), Q = P(7100);
  const mo = [], mp = [];
  for (let j = 0; j < 5; j++) { const p = P(7000 + j); mo.push(log(M, p, usd(0.2), start - 2_000_000, j)); for (let k = 0; k < 12; k++) mp.push({ wallet: M, payer: p, usd: 0.01, pos: posOf(latest - 20_000 + k, j) }); }
  for (let i = 0; i < 3_000; i++) mo.push(log(M, Q, 1000 + i, 3_000_000 + i * 10_000, 1));
  const qPays = [];
  for (let k = 0; k < 5; k++) qPays.push({ wallet: M, payer: Q, usd: 0.01, pos: posOf(latest - 10_000 + k, 3) });
  const mRpc = { refuse: (p, span) => (Array.isArray(p.topics?.[2]) && p.topics[2].includes(topic(Q)) && span > 2_000_000 ? SIZE_REFUSAL : false) };
  const mHist = (r) => r.calls.filter((c) => Array.isArray(c.topics[2]) && (c.topics[1].includes(topic(M)) || c.topics[2].includes(topic(M)))).length;
  const mOpts = { walletMaxCalls: 8, maxPartialLogsPerWallet: 100 };
  const mst = createFundingState(USDC);
  const m1 = await scanOnce({ sellers: [seller(M, "dense-hold.example")], pays: [...mp, ...qPays], outs: mo, state: mst, latest, span: SPAN, historyFrom: 2_797_221, rpcOpts: mRpc, readOpts: mOpts });
  ok(m1.stats.history.tooDense === 1 && m1.stats.history.overShare === 0 && mHist(m1) < 1 + mOpts.walletMaxCalls && mst.wallets.get(M).td?.includes(Q) && !mst.wallets.get(M).hp.length && m1.ev[M].fundingRead === false,
    `a history readable only in pieces and too dense to hold: its first attempt stops once it cannot finish on its share and what it would hold is past the cap (${mHist(m1)} calls, not the ${1 + mOpts.walletMaxCalls} of its share), its progress is dropped, and the payer it could not hold is kept`);
  const m2 = await scanOnce({ sellers: [seller(M, "dense-hold.example")], pays: [...mp, ...qPays], outs: mo, state: mst, latest: latest + 45_000, span: SPAN, historyFrom: 2_797_221, rpcOpts: mRpc, readOpts: mOpts, now: NOW + 90_000_000 });
  ok(mHist(m2) === 0 && m2.stats.history.tooDense === 1 && mst.wallets.get(M).retryAt > NOW + 90_000_000 && m2.ev[M].fundingRead === false,
    `back from its wait with that payer still new to it: not read from the start again (${mHist(m2)} calls), it waits again`);
  const mq = parseFundingState(serializeFundingState(mst), USDC);
  mq.wallets.get(M).retryAt = 0;
  const m3 = await scanOnce({ sellers: [seller(M, "dense-hold.example")], pays: mp, outs: mo, state: mq, latest: latest + 45_000, span: SPAN, historyFrom: 2_797_221, rpcOpts: mRpc, readOpts: mOpts, now: NOW + 90_000_000 });
  ok(m3.ev[M].fundingRead === true && m3.ev[M].circular === true && !mq.wallets.get(M).td,
    `(control: with that payer not paying this window, the wallet is read like any other - circular - and its mark is cleared)`);
}
{
  // A transient refusal splits only its own job; a transport failure stops the read.
  const W1 = addr("91"), W2 = addr("92");
  const sp = [{ wallet: W1, payer: P(400), usd: 0.01, pos: posOf(900, 0) }, { wallet: W2, payer: P(401), usd: 0.01, pos: posOf(900, 1) }];
  const so = [log(W1, P(400), usd(0.01), 100), log(W2, P(401), usd(0.01), 100)];
  const SELL = [seller(W1, "seller-x.example"), seller(W2, "seller-y.example")];
  // The history read: one job per wallet here; the refused one splits alone.
  let first = true;
  const r = await scanOnce({ sellers: SELL, pays: sp, outs: so, state: createFundingState(USDC), latest: 1000, span: 500, rpcOpts: { refuse: (p) => { const hit = first && p.topics[1].includes(topic(W1)); first = false; return hit; } }, readOpts: { walletChunk: 1, minRangeBlocks: 100 } });
  const w2calls = r.calls.filter((c) => c.topics[1].includes(topic(W2)));
  ok(r.stats.history.read === 2 && w2calls.length === 1 && w2calls[0].span === 1001 && r.ev[W1].selfFundedCalls === 1, "history read: a refusal of one job narrows that job's range only; the next job still reads its whole range in one call");
  // The incremental read, on wallets that already know their payers.
  let first2 = true;
  const known = () => knownState({ [W1]: [P(400)], [W2]: [P(401)] }, 99);
  const inc = await readSellerFunding({ rpc: fakeRpc(so, { calls: [], refuse: (p) => { const hit = first2 && isOutbound(p) && p.topics[1].includes(topic(W1)); first2 = false; return hit; } }), token: USDC, state: known(), wallets: [{ wallet: W1, payers: new Set([P(400)]) }, { wallet: W2, payers: new Set([P(401)]) }], latest: 1000, windowStartBlock: 500, walletChunk: 1, minRangeBlocks: 100 });
  ok(inc.caughtUp === 2 && inc.refusals === 1, "incremental read: a refusal splits its own job and both wallets still catch up");
  const t = await readSellerFunding({ rpc: fakeRpc(so, { transport: 5 }), token: USDC, state: known(), wallets: [{ wallet: W1, payers: new Set([P(400)]) }, { wallet: W2, payers: new Set([P(401)]) }], latest: 1000, windowStartBlock: 500, walletChunk: 1 });
  ok(t.calls === 2 && t.behind === 2 && /fetch failed/.test(t.transportError || ""), "an unreachable RPC is retried once and then the read stops (no fan-out), every wallet left behind at its cursor");
  const th = await scanOnce({ sellers: SELL, pays: sp, outs: so, state: createFundingState(USDC), latest: 1000, span: 500, rpcOpts: { transport: 5 }, readOpts: { walletChunk: 1 } });
  ok(th.stats.history.calls === 2 && th.stats.history.failed === 2 && th.ev[W1].fundingRead === false && th.ev[W1].callsSettled === 1, "...the same for the history read: stopped after one retry, the wallets left behind (counted as they are, not netted blind)");
  // A read that times out may just be too large: it is split, a few times per
  // scan; an RPC that times out on everything stops the read instead.
  let slow = true;
  const timeoutRpc = async (m, params) => { const p = params[0]; const span = parseInt(p.toBlock, 16) - parseInt(p.fromBlock, 16) + 1; if (slow && span > 600) throw new Error("All RPCs failed for eth_getLogs: The operation was aborted due to timeout"); return filterLogs([...so, ...sp.map(payLog)], p); };
  const ts = await readSellerFunding({ rpc: timeoutRpc, token: USDC, state: knownState({ [W1]: [P(400)] }, 99), wallets: [{ wallet: W1, payers: new Set([P(400)]) }], latest: 1000, windowStartBlock: 100, minRangeBlocks: 100 });
  ok(ts.caughtUp === 1 && ts.refusals === 1 && !ts.transportError, "one slow wide read is split rather than abandoned (caught up after a single timeout)");
  const ts2 = await readSellerFunding({ rpc: async () => { throw new Error("The operation was aborted due to timeout"); }, token: USDC, state: known(), wallets: [{ wallet: W1, payers: new Set([P(400)]) }, { wallet: W2, payers: new Set([P(401)]) }], latest: 1000, windowStartBlock: 100, minRangeBlocks: 100 });
  ok(ts2.calls === 4 && ts2.behind === 2 && /timeout/.test(ts2.transportError || ""), `an RPC that times out on everything stops after a few (${ts2.calls} calls), not after the budget`);
  // The pool caps: only a known payer is ever recorded, zero-value logs never
  // are, dust pools make way, and a recipient paying this scan always is.
  const W3 = addr("93");
  const spray = [];
  for (let i = 0; i < 30; i++) spray.push(log(W3, P(3000 + i), 0, 100, i), log(W3, P(3100 + i), 1, 101, i));
  spray.push(log(W3, P(3200), usd(2), 150, 0), log(W3, P(3201), usd(2), 151, 0));
  const st6 = knownState({ [W3]: [P(3201), ...Array.from({ length: 30 }, (_, i) => P(3000 + i))] }, 49);
  await readSellerFunding({ rpc: fakeRpc(spray), token: USDC, state: st6, wallets: [{ wallet: W3, payers: new Set([P(3201)]) }], latest: 1000, windowStartBlock: 50, maxPairsPerWallet: 10 });
  const pairs6 = st6.wallets.get(W3).pairs;
  ok(pairs6.size === 1 && pairs6.has(P(3201)) && !pairs6.has(P(3200)) && !st6.wallets.get(W3).truncated, `SPRAY: 30 zero-value logs to known payers and 30 one-unit transfers to strangers record nothing; the $2 to a payer is recorded, the $2 to a stranger is not (${pairs6.size} pool)`);
  const big = [];
  for (let i = 0; i < 15; i++) big.push(log(W3, P(3300 + i), usd(0.5), 100, i));
  big.push(log(W3, P(3400), usd(2), 150, 0));
  const st7 = knownState({ [W3]: [...Array.from({ length: 15 }, (_, i) => P(3300 + i)), P(3400)] }, 49);
  await readSellerFunding({ rpc: fakeRpc(big), token: USDC, state: st7, wallets: [{ wallet: W3, payers: new Set([P(3400)]) }], latest: 1000, windowStartBlock: 50, maxPairsPerWallet: 10 });
  ok(st7.wallets.get(W3).truncated === true && st7.wallets.get(W3).pairs.has(P(3400)), "past the cap with real pools, the wallet is flagged truncated, and a recipient paying it this scan is still recorded");
  // A WALLET THAT SENDS TOO MUCH TO OTHERS (an exchange or relayer shape) is
  // read targeted at its known payers, and that is kept: the next scans read
  // such wallets targeted straight away, packed, instead of finding the same
  // split again every hour. Here five of them among twenty quiet wallets, on
  // an RPC that refuses an answer over a thousand results.
  {
    const busy = Array.from({ length: 5 }, (_, i) => "0x" + (0xb000 + i).toString(16).padStart(40, "0"));
    const quiet = Array.from({ length: 20 }, (_, i) => "0x" + (0xc000 + i).toString(16).padStart(40, "0"));
    const payerOf = (w) => "0x" + "f0".repeat(18) + w.slice(-4);
    const chain = [];
    for (const w of busy) for (let b = 1001; b <= 3000; b++) chain.push(log(w, "0x" + "e0".repeat(16) + b.toString(16).padStart(8, "0"), 5, b, 7));
    for (const w of [...busy, ...quiet]) chain.push(log(w, payerOf(w), usd(0.5), 1500, 3), log(w, payerOf(w), usd(0.5), 2500, 3));
    const capRpc = (calls) => fakeRpc(chain, { calls, refuse: (p) => (filterLogs(chain, p).length > 1000 ? "query returned more than 1000 results" : false) });
    const all = [...busy, ...quiet].map((w) => ({ wallet: w, payers: new Set([payerOf(w)]) }));
    const bst = knownState(Object.fromEntries([...busy, ...quiet].map((w) => [w, [payerOf(w)]])), 1000);
    const c1 = [], c2 = [];
    const b1 = await readSellerFunding({ rpc: capRpc(c1), token: USDC, state: bst, wallets: all, latest: 2000, windowStartBlock: 500, now: NOW });
    const b2 = await readSellerFunding({ rpc: capRpc(c2), token: USDC, state: bst, wallets: all, latest: 3000, windowStartBlock: 500, now: NOW + 3_600_000 });
    const pendOf = (w) => bst.wallets.get(w).pairs.get(payerOf(w))?.pend.length || 0;
    ok(b1.caughtUp === 25 && b1.refusals > 0 && busy.every((w) => bst.wallets.get(w).oh === NOW) && quiet.every((w) => !bst.wallets.get(w).oh),
      `the first scan isolates the five (${b1.calls} calls, ${b1.refusals} refused) and keeps that they are read targeted`);
    ok(b2.caughtUp === 25 && b2.refusals === 0 && b2.calls === 2 && b2.targeted === 5 && [...busy, ...quiet].every((w) => pendOf(w) === 2),
      `an hour later: one untargeted call for the twenty quiet wallets and one targeted call for the five, nothing refused (${b2.calls} calls), and every payer's funding recorded`);
    // One with MANY known payers (targeted would cost a call per 200 of
    // them) is read alone instead, its range split as it needs - never
    // isolated from the others again.
    const X = "0x" + "b7".repeat(20), xPayers = Array.from({ length: 500 }, (_, i) => "0x" + "f1".repeat(18) + i.toString(16).padStart(4, "0"));
    const xChain = [...chain];
    for (let b = 1001; b <= 3000; b++) xChain.push(log(X, "0x" + "e1".repeat(16) + b.toString(16).padStart(8, "0"), 5, b, 7), log(X, "0x" + "e2".repeat(16) + b.toString(16).padStart(8, "0"), 5, b, 8));
    xChain.push(log(X, xPayers[7], usd(0.5), 2500, 3));
    const xRpc = (calls) => fakeRpc(xChain, { calls, refuse: (p) => (filterLogs(xChain, p).length > 1000 ? "query returned more than 1000 results" : false) });
    const xAll = [...all, { wallet: X, payers: new Set(xPayers) }];
    const xst = knownState({ ...Object.fromEntries([...busy, ...quiet].map((w) => [w, [payerOf(w)]])), [X]: xPayers }, 1000);
    const xc1 = [], xc2 = [];
    await readSellerFunding({ rpc: xRpc(xc1), token: USDC, state: xst, wallets: xAll, latest: 2000, windowStartBlock: 500, minRangeBlocks: 100, now: NOW });
    const x2 = await readSellerFunding({ rpc: xRpc(xc2), token: USDC, state: xst, wallets: xAll, latest: 3000, windowStartBlock: 500, minRangeBlocks: 100, now: NOW + 3_600_000 });
    const withX = xc2.filter((c) => c.topics[1].includes(topic(X)));
    ok(xst.wallets.get(X).oh >= NOW && x2.caughtUp === 26 && withX.length >= 1 && withX.every((c) => c.topics[1].length === 1 && c.topics[2] === null) && x2.calls - withX.length === 2 && xst.wallets.get(X).pairs.get(xPayers[7])?.pend.length === 1,
      `...and one with 500 known payers is read alone, untargeted, the next hour - its own range splits only (${withX.length} call(s), never in a job with another wallet), the others in 2 - and its payer's funding recorded`);
    const bst3 = parseFundingState(serializeFundingState(bst), USDC);
    for (const w of busy) bst3.wallets.get(w).cursor = 2000;
    for (const w of quiet) bst3.wallets.get(w).cursor = 2000;
    const b3 = await readSellerFunding({ rpc: capRpc([]), token: USDC, state: bst3, wallets: all, latest: 3000, windowStartBlock: 500, now: NOW + 8 * 86_400_000 });
    ok(b3.refusals > 0 && b3.calls > 2, `(control: a week later the mark has lapsed and the split is learned again, ${b3.calls} calls)`);

    // BUSY TOGETHER, NOT ALONE: twenty wallets that each send three transfers
    // a block to others, on an RPC that caps an answer at 10,000 results. An
    // hour of one wallet (5,400) fits; two packed together do not, so the
    // split was learned again every hour and nothing was ever marked. A
    // wallet that sent 1,000 or more in a read answered after its packed job
    // was refused is marked now, and the next hour reads the twenty targeted
    // at their payers, nothing refused.
    const B20 = Array.from({ length: 20 }, (_, i) => "0x" + (0xb100 + i).toString(16).padStart(40, "0"));
    const q20 = Array.from({ length: 20 }, (_, i) => "0x" + (0xc100 + i).toString(16).padStart(40, "0"));
    const payer20 = (w) => "0x" + "f2".repeat(18) + w.slice(-4);
    const small = [];
    for (const w of [...B20, ...q20]) small.push(log(w, payer20(w), usd(0.5), 1500, 3), log(w, payer20(w), usd(0.5), 3300, 3));
    const busySet = new Set(B20.map((w) => topic(w)));
    const busyRpc = (calls) => async (method, params) => {
      const p = params[0];
      const lo = parseInt(p.fromBlock, 16), hi = parseInt(p.toBlock, 16);
      calls.push({ ...p, span: hi - lo + 1 });
      const eager = filterLogs(small, p);
      const busyFroms = p.topics[2] === null ? (p.topics[1] || []).filter((t) => busySet.has(t)) : [];
      if (eager.length + busyFroms.length * 3 * (hi - lo + 1) > 10_000) throw new Error("query returned more than 10000 results");
      const out = [...eager];
      for (const t of busyFroms) for (let b = lo; b <= hi; b++) for (let k = 0; k < 3; k++) out.push(log("0x" + t.slice(-40), "0x" + "e3".repeat(16) + (b * 4 + k).toString(16).padStart(8, "0"), 5, b, 10 + k));
      return out;
    };
    const all20 = [...B20, ...q20].map((w) => ({ wallet: w, payers: new Set([payer20(w)]) }));
    const b20 = () => knownState(Object.fromEntries([...B20, ...q20].map((w) => [w, [payer20(w)]])), 1000);
    const s20 = b20();
    const r1 = await readSellerFunding({ rpc: busyRpc([]), token: USDC, state: s20, wallets: all20, latest: 2800, windowStartBlock: 500, now: NOW });
    const r2 = await readSellerFunding({ rpc: busyRpc([]), token: USDC, state: s20, wallets: all20, latest: 4600, windowStartBlock: 500, now: NOW + 3_600_000 });
    const funded20 = (st) => [...B20, ...q20].every((w) => st.wallets.get(w).pairs.get(payer20(w))?.pend.length === 2);
    ok(r1.refusals > 0 && r1.marked === 20 && B20.every((w) => s20.wallets.get(w).oh === NOW) && q20.every((w) => !s20.wallets.get(w).oh) && r1.caughtUp === 40,
      `twenty wallets busy together but not alone: the first hour isolates them (${r1.calls} calls, ${r1.refusals} refused) and marks each (${r1.marked})`);
    ok(r2.refusals === 0 && r2.targeted === 20 && r2.calls === 2 && r2.caughtUp === 40 && funded20(s20),
      `the next hour: nothing refused, ${r2.calls} calls (the twenty read targeted, packed; the quiet ones untargeted), and every payer's funding recorded`);
    const u20 = b20();
    await readSellerFunding({ rpc: busyRpc([]), token: USDC, state: u20, wallets: all20, latest: 2800, windowStartBlock: 500, now: NOW, outboundBusyLogs: Infinity });
    const u2 = await readSellerFunding({ rpc: busyRpc([]), token: USDC, state: u20, wallets: all20, latest: 4600, windowStartBlock: 500, now: NOW + 3_600_000, outboundBusyLogs: Infinity });
    ok(u2.refusals > 0 && u2.targeted === 0, `(control: with no such mark the next hour is refused and split again, ${u2.calls} calls, ${u2.refusals} refused)`);
  }
  // A single wallet refused even over the narrowest range is read targeted
  // at its known payers: exactly what is recorded anyway, so nothing is lost.
  const st3 = knownState({ [W1]: [P(400)] }, 99);
  const tg = [];
  const g = await readSellerFunding({ rpc: fakeRpc(so, { calls: tg, refuse: (p) => p.topics[2] === null }), token: USDC, state: st3, wallets: [{ wallet: W1, payers: new Set([P(400)]) }], latest: 1000, windowStartBlock: 500, minRangeBlocks: 2000 });
  ok(g.caughtUp === 1 && !st3.wallets.get(W1).truncated && st3.wallets.get(W1).pairs.get(P(400))?.pend.length === 1 && tg.some((c) => Array.isArray(c.topics[2])), "a wallet no untargeted read can serve is read targeted at its known payers (complete, not truncated)");
}

{
  // A payer's history comes in whole: a steady two-way flow (pays $1, gets
  // $0.9946 back, pays $0.0042) must not leave an inflated pool. The history
  // read finds its earlier $1s, which a later transfer from the seller gives
  // back first (credit), so its small payments are its own money.
  const W = addr("c1"), B2 = P(800);
  const so = [], sp = [];
  for (let d = 0; d < 12; d++) {
    const b0 = 1000 + d * 500;
    sp.push({ wallet: W, payer: B2, usd: 1, pos: posOf(b0, 1) }, { wallet: W, payer: B2, usd: 1, pos: posOf(b0 + 10, 1) });
    so.push(log(W, B2, usd(0.9946), b0 + 100, 1), log(W, B2, usd(0.9946), b0 + 120, 1));
    sp.push({ wallet: W, payer: B2, usd: 0.0042, pos: posOf(b0 + 110, 2) }, { wallet: W, payer: B2, usd: 0.0042, pos: posOf(b0 + 130, 2) });
  }
  for (let i = 0; i < 3; i++) for (let k = 0; k < 20; k++) sp.push({ wallet: W, payer: P(810 + i), usd: 0.01, pos: posOf(4200 + i * 30 + k, 3) });
  const withHist = await scanOnce({ sellers: [seller(W, "seller-t.example")], pays: sp, outs: so, state: createFundingState(USDC), latest: 7000, span: 3000 });
  const inCall = withHist.calls.find((c) => Array.isArray(c.topics[2]) && c.topics[2].includes(topic(W)) && c.topics[1].includes(topic(B2)));
  ok(withHist.stats.history.funded === 1 && inCall && parseInt(inCall.toBlock, 16) === 3999 && withHist.ev[W].selfFundedCalls === 0 && withHist.ev[W].callsSettled === 72 && withHist.ev[W].uniqueBuyers === 4,
    "the funded payer's own transfers before the window are read (up to the window), and its small payments are its own money: 72 / 4, nothing netted");
  const noHist = await scanOnce({ sellers: [seller(W, "seller-t.example")], pays: sp, outs: so, state: createFundingState(USDC), latest: 7000, span: 3000, history: false });
  ok(noHist.ev[W].fundingRead === false && noHist.ev[W].callsSettled === 72, "without the history read the wallet is left behind (its pools are never worked on half the story), not netted");
  const blind = await scanOnce({ sellers: [seller(W, "seller-t.example")], pays: sp, outs: so, state: createFundingState(USDC), latest: 7000, span: 3000, chainHidesPaysBefore: 4000 });
  ok(blind.ev[W].selfFundedCalls > 0 && blind.ev[W].uniqueBuyers === 3, `control: had the pools been built blind to the payer's earlier $1s, its small payments would read as the seller's money (${blind.ev[W].selfFundedCalls} netted, a buyer lost)`);
  // CREDIT FOR A KNOWN PAYER: it sent $5 (not a call) before it was first
  // seen paying; the seller refunds the $5 later. That refund is its own money
  // coming back, so its later small payments are genuine.
  const Wc = addr("c2"), C = P(820);
  const so2 = [], sp2 = [{ wallet: Wc, payer: C, usd: 5, pos: posOf(100, 0) }];
  for (let k = 0; k < 20; k++) sp2.push({ wallet: Wc, payer: C, usd: 0.01, pos: posOf(1_000 + k, 0) });
  const stc = createFundingState(USDC);
  await scanOnce({ sellers: [seller(Wc, "seller-c.example")], pays: sp2, outs: so2, state: stc, latest: 1_500, span: 600 });
  ok(stc.wallets.get(Wc).known.has(C) && !stc.wallets.get(Wc).pairs.has(C), "(the payer is known, never funded: no pool)");
  so2.push(log(Wc, C, usd(5), 2_000));
  for (let k = 0; k < 30; k++) sp2.push({ wallet: Wc, payer: C, usd: 0.01, pos: posOf(2_100 + k, 0) });
  const rc = await scanOnce({ sellers: [seller(Wc, "seller-c.example")], pays: sp2, outs: so2, state: stc, latest: 2_500, span: 600 });
  const creditCall = rc.calls.find((c) => Array.isArray(c.topics[2]) && c.topics[1].includes(topic(C)));
  ok(rc.stats.history.creditReads === 1 && creditCall && parseInt(creditCall.toBlock, 16) === 899 && rc.ev[Wc].selfFundedCalls === 0 && rc.ev[Wc].callsSettled === 30 && (stc.wallets.get(Wc).pairs.get(C)?.pool ?? 0) === 0,
    "a known payer's first funding reads its own earlier transfers first: the $5 refund returns its $5, and none of its 30 later payments is netted");
  const blindC = createFundingState(USDC);
  await scanOnce({ sellers: [seller(Wc, "seller-c.example")], pays: sp2, outs: so2, state: blindC, latest: 1_500, span: 600, chainHidesPaysBefore: 1_000 });
  const rcb = await scanOnce({ sellers: [seller(Wc, "seller-c.example")], pays: sp2, outs: so2, state: blindC, latest: 2_500, span: 600, chainHidesPaysBefore: 1_000 });
  ok(rcb.ev[Wc].selfFundedCalls === 30, "control: blind to that $5, the refund would have netted all 30");
}
{
  // THE GLOBAL POOL CAP CANNOT BE FILLED FROM OUTSIDE (the review's cap case):
  // one wallet, already known to have a payer, sprays one base unit to 60
  // strangers (read by its incremental outbound read); another funds five
  // wallets that then buy from it. With a global cap of 60 pools, the funded
  // fleet is still netted: strangers are never recorded.
  const A = addr("e1"), V = addr("e2");
  const logs = [], allPays = [];
  allPays.push({ wallet: A, payer: P(900), usd: 0.01, pos: posOf(500, 1) });
  for (let i = 0; i < 60; i++) logs.push(log(A, "0x" + "d0".repeat(18) + i.toString(16).padStart(4, "0"), 1, 1_500, i));
  allPays.push({ wallet: V, payer: P(901), usd: 0.01, pos: posOf(500, 2) });
  for (let i = 1; i <= 5; i++) logs.push(log(V, P(i), usd(0.12), 700, i));
  for (let i = 1; i <= 5; i++) for (let k = 0; k < 12; k++) allPays.push({ wallet: V, payer: P(i), usd: 0.01, pos: posOf(1100 + k, i) });
  const SELL = [seller(A, "sprayer.example"), seller(V, "seller-v.example")];
  const run = async (maxPairsTotal) => {
    const st = createFundingState(USDC);
    const opts = { readOpts: { maxPairsTotal } };
    await scanOnce({ sellers: SELL, pays: allPays.filter((t) => t.pos < posOf(1001, 0)), outs: logs, state: st, latest: 1000, span: 1000, ...opts });
    const r = await scanOnce({ sellers: SELL, pays: allPays, outs: logs, state: st, latest: 2000, span: 2000, ...opts });
    return { ev: r.ev[V], pairs: SF.fundingPairCount(st) };
  };
  const wide = await run(1000), tight = await run(60);
  ok(wide.ev.selfFundedCalls === 60 && tight.ev.selfFundedCalls === 60 && !tight.ev.fundingTruncated && tight.pairs <= 6, `a global cap of 60 pools: V's funded fleet is netted either way (60 of 61), ${tight.pairs} pool(s) held, none for the 60 strangers`);
}

// --- 4. Behind: known facts net it, and a circular wallet behind credits nothing ----
{
  const behind = await scanOnce({ sellers: SELLERS, pays, outs, state: parseFundingState(serializeFundingState(state1), USDC), latest: 1600, span: 1500, readOpts: { maxCalls: 0 } });
  ok(behind.stats.behind === 6 && behind.stats.calls === 0 && behind.ev[LOOP].fundingRead === false, "no budget: every paid wallet is behind this scan");
  ok(behind.ev[LOOP].callsSettled === 0 && behind.ev[LOOP].uniqueBuyers === 0 && behind.ev[LOOP].fundingPending === true, "a CIRCULAR wallet whose reads are behind is credited nothing until they catch up (its gross 62 is never credited)");
  ok(behind.ev[HONEST].callsSettled === 104 && behind.ev[HONEST].fundingPending === undefined, "a wallet that is not circular keeps what is known netted and counts the rest (absence of evidence never refuses)");
}

// --- 5. The verdict: carried 30 days, and the operator's clearance ------------------
{
  const at = ev[LOOP].lastCircularAt;
  ok(at === new Date(NOW).toISOString(), "a circular wallet carries the scan time as its verdict");
  ok(circularWalletsFrom({ [LOOP]: { lastCircularAt: at } }, { now: NOW + 10 * 86_400_000 }).has(LOOP) && !circularWalletsFrom({ [LOOP]: { lastCircularAt: at } }, { now: NOW + 31 * 86_400_000 }).has(LOOP), "the verdict holds inside the 30-day window, and not after it");
  ok(!circularWalletsFrom(ev, { now: NOW, cleared: new Set([LOOP]) }).has(LOOP) && circularWalletsFrom(ev, { now: NOW, cleared: new Set([LOOP]) }).has(MIXED), "a wallet the operator cleared is never circular; the others are untouched");
}

// --- 6. The gate: netted figures, the circular wallet's Bazaar ignored --------------
const circular = circularWalletsFrom(ev, { now: NOW });
ok(circular.has(LOOP) && circular.has(MIXED) && !circular.has(HONEST) && !circular.has(SIB_A), "circular set: the funded fleet and the mixed seller, never the honest seller or the host sibling");
const bazaar = [
  ["https://seller-a.example", { calls30d: 500, payers30d: 40, payTos: [LOOP] }],
  ["https://seller-c.example", { calls30d: 900, payers30d: 50, payTos: [MIXED] }],
];
const chainProven = new Map([["https://seller-a.example", { settled: 800, payers: 9, payTo: LOOP }]]);
const b = buildEvidenceBinding({ leaderboardRows: s1.ranked, walletEvidence: ev, bazaarQuality: bazaar, chainProven, circularWallets: circular, ...FLOORS });
const control = buildEvidenceBinding({ leaderboardRows: s1.ranked, walletEvidence: ev, bazaarQuality: bazaar, chainProven, ...FLOORS });
const label = (bind, origin, live) => dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: bind.get(origin)?.settled || 0, payers: bind.get(origin)?.payers, spendChains: ["base"], ...FLOORS, evidence: bind.get(origin), livePayTo: live });
ok(label(control, "https://seller-a.example", LOOP).eligible === true, "control: without the circular set, the Bazaar's count of the same self-payments re-admits seller-a");
const la = label(b, "https://seller-a.example", LOOP);
ok(la.eligible === false && la.reason === "settlement_self_funded", "FUNDED FLEET DEMOTED: reads settlement_self_funded");
ok(b.get("https://seller-a.example").byWallet.get(LOOP).settled === 2 && b.get("https://seller-a.example").selfFunded.byWallet.get(LOOP).settled === 800 && b.get("https://seller-a.example").ownSettled === 0, "its Bazaar and chain-join figures are disregarded (kept as selfFunded, never credited, not its own evidence)");
ok(baseLiveGate({ networks: ["eip155:8453"], settled: 800, payers: 40, priceUsd: 0.01, ...FLOORS, binding: b.get("https://seller-a.example"), livePayTo: LOOP }).ok === false, "handed the old figures (800 / 40) the gate still refuses: no wallet clears on genuine evidence");
ok(label(b, "https://seller-b.example", HONEST).eligible === true, "HONEST SELLER WITH REFUNDS KEPT: seller-b stays eligible at its wallet");
const lc = label(b, "https://seller-c.example", MIXED);
ok(lc.eligible === true && b.get("https://seller-c.example").byWallet.get(MIXED).settled === 64 && b.get("https://seller-c.example").selfFunded.byWallet.get(MIXED).settled === 900, "MIXED SELLER: eligible on its genuine 64 / 16, its Bazaar figures (900) disregarded");
{
  const legend = dispatchLegend()["routerDispatchReason.settlement_self_funded"];
  const words = DISPATCH_REASONS.settlement_self_funded + legend;
  ok(typeof DISPATCH_REASONS.settlement_self_funded === "string" && dispatchLegend().routerDispatchReason.settlement_self_funded === DISPATCH_REASONS.settlement_self_funded, "the public reason is published in the legend");
  ok(!/\b[a-z0-9-]+\.(example|com|io|xyz|ai|tools)\b/i.test(words) && !/0x[0-9a-f]{6}/i.test(words), "...and names no one");
  ok(!/same seller|same host|sibling/i.test(words) && /first in first out/i.test(legend) && /its own amount/i.test(legend) && /refunded payments[^.]*not counted/i.test(legend) && /dollars/i.test(legend), "...and says what is measured: the wallet's own outbound, first in first out, refunded payments not counted, the excess only up to its own amount, judged by dollars");
}

// --- 6b. The seller dossier says what was netted, and flags only what matters ----------
// The dossier is a paid read about a named seller: it publishes what the scan
// ACTUALLY netted (never the gross figures that would have counted, most of
// them the payers' own money), and flags only a mostly self-funded wallet or a
// verdict the netting changed. Per-wallet detail stays on the operator surface.
const { composeSellerDossier } = await import("../src/tools/seller-dossier.js");
const dossierOf = (origin, wallet, binding) => {
  const DETAIL = { origin, host: new URL(origin).host, routable: true, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": wallet }, payTosByNetwork: { "eip155:8453": [wallet] }, tools: [] };
  const helpers = { quoteIsStale: () => false, priceDisagreesWithOrigin: () => false, networksNeedLiveVerify: () => false, looksLikeListingInjection: () => false };
  const v = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: binding?.settled || 0, payers: binding?.payers, priceUsd: 0.001, spendChains: ["base"], ...FLOORS, evidence: binding, livePayTo: wallet });
  return composeSellerDossier({ host: DETAIL.host, detail: DETAIL, entry: { origin, tools: [] }, dispatch: { routerDispatchEligible: v.eligible, routerDispatchReason: v.reason, routerDispatchByChain: { base: v.chains.base } }, evidenceBinding: binding, leaderboardRow: null, bazaar: null, solana: null, mpp: null, refusals: [], registration: null, deliveries: new Map(), sharedClaims: {}, helpers, thresholds: { sorThreshold: 50, sorPayers: 3, sorCap: 0.005 }, self: false, now: NOW });
};
const SELF_FLAG = /USDC this seller's wallet had sent its payers|USDC that wallet had sent its payers/;
{
  const d = dossierOf("https://seller-a.example", LOOP, b.get("https://seller-a.example"));
  const sf = d.wallets?.base?.selfFunded;
  const flag = (d.flags || []).find((f) => SELF_FLAG.test(f));
  ok(sf && sf.nettedCalls === 60 && sf.nettedUsd === 0.6 && sf.mostlySelfFunded === true && sf.changesRouterVerdict === true, "FUNDED FLEET: the dossier publishes what was netted (60 calls, $0.60), mostly self-funded, the verdict changed");
  ok(flag && /most of the dollars/.test(flag) && /ask us/.test(flag), "...and flags it, pointing to us for the detail");
  const text = JSON.stringify(d);
  ok(!text.includes("selfFundedAtWallets") && !/"settled":800\b/.test(JSON.stringify(d.wallets)) && !text.includes(P(1)) && !/0x[0-9a-f]{6}|\.example/.test(flag), "...never the gross figures under that heading (the 800 the chain join counted), no payer, and the flag names no one");
}

{
  // THE REVIEW'S HONEST SELLER: 100 calls from 10 payers, one $0.01 refund to
  // a repeat buyer who then buys again. The refund returns a payment the
  // buyer genuinely made: that payment is removed, nothing is netted; the
  // seller stays eligible, and the dossier must not present its history as
  // self-funded.
  const W = addr("f3");
  const sp = [], so = [log(W, P(701), usd(0.01), 205, 50)];
  for (let i = 1; i <= 10; i++) for (let k = 0; k < 10; k++) sp.push({ wallet: W, payer: P(700 + i), usd: 0.01, pos: posOf(200 + k * 10, i) });
  const r = await scanOnce({ sellers: [seller(W, "seller-h.example")], pays: sp, outs: so, state: createFundingState(USDC), latest: 1000, span: 1000 });
  const bind = buildEvidenceBinding({ leaderboardRows: r.ranked, walletEvidence: r.ev, circularWallets: circularWalletsFrom(r.ev, { now: NOW }), ...FLOORS }).get("https://seller-h.example");
  const d = dossierOf("https://seller-h.example", W, bind);
  const sf = d.wallets.base.selfFunded;
  ok(r.ev[W].callsSettled === 99 && r.ev[W].refundedCalls === 1 && r.ev[W].selfFundedCalls === 0 && r.ev[W].uniqueBuyers === 10 && label(new Map([["https://seller-h.example", bind]]), "https://seller-h.example", W).eligible === true, "(a refund of a genuine payment removes it and nets nothing: 99 / 10, eligible)");
  ok(d.wallets.base.refunded?.calls === 1, "...and the dossier shows the refunded payment as refunded, not as self-funded");
  ok(!sf || (sf.nettedCalls === 0 && sf.mostlySelfFunded === false && sf.changesRouterVerdict === false), "HONEST SELLER DOSSIER: nothing netted to publish, not mostly self-funded, verdict unchanged");
  ok(!(d.flags || []).some((f) => SELF_FLAG.test(f)) && !/"settled":100\b/.test(JSON.stringify(sf || {})), "...raises no flag, and nowhere presents its 100 calls as self-funded");
}

// --- 6c. Third-party counts of a wallet are netted by what its own scan found ----
{
  // THE REVIEW'S BYPASS: cheap self-funded calls keep the self-funded share of
  // the DOLLARS small, so the wallet is never judged circular, and the
  // Bazaar's count of the same calls cleared the floor on its own. The wallet
  // sends two fresh wallets $0.03 each, each makes 25 calls at $0.001, and one
  // outside buyer pays $0.50 once. The Bazaar reads 51 calls from 3 payers.
  const W = addr("f1");
  const sp = [], so = [];
  for (const i of [1, 2]) { so.push(log(W, P(600 + i), usd(0.03), 100, i)); for (let k = 0; k < 25; k++) sp.push({ wallet: W, payer: P(600 + i), usd: 0.001, pos: posOf(200 + k, i) }); }
  sp.push({ wallet: W, payer: P(690), usd: 0.5, pos: posOf(300, 0) });
  const r = await scanOnce({ sellers: [seller(W, "seller-f.example")], pays: sp, outs: so, state: createFundingState(USDC), latest: 1000, span: 1000 });
  const e = r.ev[W];
  ok(e.circular === false && e.selfFundedCalls === 50 && e.selfFundedPayers === 2 && e.selfFundedCalls30d === 50 && e.selfFundedPayers30d === 2 && e.callsSettled === 1 && e.uniqueBuyers === 1,
    "the wallet is not circular (9% of its dollars), and its own scan found 50 calls and 2 payers paid only with its money (window and 30 days)");
  const q = { calls30d: 51, payers30d: 3, payTos: [W] };
  Object.defineProperty(q, "byPayTo", { value: { [W]: { calls: 51, payers: 3 } }, enumerable: false });
  const circ = circularWalletsFrom(r.ev, { now: NOW });
  const bind = buildEvidenceBinding({ leaderboardRows: r.ranked, walletEvidence: r.ev, bazaarQuality: [["https://seller-f.example", q]], circularWallets: circ, ...FLOORS });
  const be = bind.get("https://seller-f.example");
  const gate = baseLiveGate({ networks: ["eip155:8453"], settled: be.settled, payers: be.payers, priceUsd: 0.001, ...FLOORS, binding: be, livePayTo: W });
  ok(be.byWallet.get(W).settled === 1 && be.byWallet.get(W).payers === 1 && gate.ok === false, "BYPASS CLOSED: the Bazaar's 51 / 3 at the wallet is netted to 1 / 1, and the live gate refuses");
  ok(label(bind, "https://seller-f.example", W).reason === "settlement_self_funded" && be.selfFunded.byWallet.get(W).settled === 51 && be.selfFunded.netted.get(W)?.calls30d === 50, "...labelled settlement_self_funded, with what would have counted (51) and what was netted (50) kept apart");
  const stripped = Object.fromEntries(Object.entries(r.ev).map(([k, v]) => [k, { callsSettled: v.callsSettled, uniqueBuyers: v.uniqueBuyers, origins: v.origins }]));
  const ctl = buildEvidenceBinding({ leaderboardRows: r.ranked, walletEvidence: stripped, bazaarQuality: [["https://seller-f.example", q]], circularWallets: circ, ...FLOORS }).get("https://seller-f.example");
  ok(baseLiveGate({ networks: ["eip155:8453"], settled: ctl.settled, payers: ctl.payers, priceUsd: 0.001, ...FLOORS, binding: ctl, livePayTo: W }).ok === true, "control: without the scan's netted counts the same Bazaar figures clear the floor (the bypass the review measured)");
  const d = dossierOf("https://seller-f.example", W, be);
  const flag = (d.flags || []).find((f) => SELF_FLAG.test(f));
  ok(d.wallets.base.selfFunded?.nettedCalls === 50 && d.wallets.base.selfFunded.mostlySelfFunded === false && d.wallets.base.selfFunded.changesRouterVerdict === true && flag && /below the router's floor/.test(flag),
    "the dossier: 50 netted, not mostly self-funded, but they are what keeps it below the floor, and the flag says exactly that");
  // The chain join counts the same payments over the scan window.
  const cj = buildEvidenceBinding({ leaderboardRows: r.ranked, walletEvidence: r.ev, chainProven: new Map([["https://seller-f.example", { settled: 60, payers: 4, payTo: W }]]), circularWallets: circ, ...FLOORS }).get("https://seller-f.example");
  ok(cj.byWallet.get(W).settled === 10 && cj.byWallet.get(W).payers === 2 && cj.ownSettled === 10 && baseLiveGate({ networks: ["eip155:8453"], settled: cj.settled, payers: cj.payers, priceUsd: 0.001, ...FLOORS, binding: cj, livePayTo: W }).ok === false,
    "the chain join's 60 / 4 at the wallet is netted by the window's 50 / 2 to 10 / 2: refused");
  // An operator clearance reads the wallet gross: nothing is netted.
  const cleared = buildEvidenceBinding({ leaderboardRows: r.ranked, walletEvidence: { ...r.ev, [W]: { callsSettled: e.grossCallsSettled, uniqueBuyers: e.grossUniqueBuyers, origins: e.origins, selfFundingCleared: true } }, bazaarQuality: [["https://seller-f.example", q]], ...FLOORS }).get("https://seller-f.example");
  ok(cleared.byWallet.get(W).settled === 51 && cleared.selfFunded.netted.size === 0, "a wallet the operator cleared is not netted (its evidence reads gross)");
  // An honest seller with no self-funded payment: its Bazaar figures are untouched.
  const honest = buildEvidenceBinding({ leaderboardRows: s1.ranked, walletEvidence: ev, bazaarQuality: [["https://seller-b.example", Object.defineProperty({ calls30d: 300, payers30d: 20, payTos: [SIB_A] }, "byPayTo", { value: { [SIB_A]: { calls: 300, payers: 20 } }, enumerable: false })]], ...FLOORS }).get("https://seller-b.example");
  ok(honest.byWallet.get(SIB_A).settled === 300 && honest.byWallet.get(SIB_A).payers === 20 && !honest.selfFunded.netted.has(SIB_A), "a wallet whose scan netted nothing keeps its Bazaar figures whole (300 / 20)");
}
{
  // THE 30 DAYS: payments netted in an earlier scan, now outside the 7-day
  // window, still reduce the Bazaar's 30-day count of the same wallet.
  const W = addr("f2"), st = createFundingState(USDC);
  const sp = [], so = [];
  for (const i of [1, 2, 3]) { so.push(log(W, P(640 + i), usd(0.2), 100, i)); for (let k = 0; k < 20; k++) sp.push({ wallet: W, payer: P(640 + i), usd: 0.01, pos: posOf(200 + k, i) }); }
  for (let i = 0; i < 4; i++) for (let k = 0; k < 5; k++) sp.push({ wallet: W, payer: P(660 + i), usd: 0.05, pos: posOf(1_000 + k, i) });
  const first = await scanOnce({ sellers: [seller(W, "seller-g.example")], pays: sp, outs: so, state: st, latest: 2_000, span: 2_000 });
  ok(first.ev[W].circular === false && first.ev[W].selfFundedCalls === 60, "(scan 1: 60 calls netted, $0.60 of $1.60: not circular)");
  for (let i = 0; i < 4; i++) for (let k = 0; k < 5; k++) sp.push({ wallet: W, payer: P(660 + i), usd: 0.01, pos: posOf(399_000 + k, i) });
  const later = await scanOnce({ sellers: [seller(W, "seller-g.example")], pays: sp, outs: so, state: st, latest: 400_000, span: 302_400 });
  const e = later.ev[W];
  ok(e.selfFundedCalls === 0 && e.selfFundedCalls30d === 60 && e.selfFundedPayers30d === 3 && e.callsSettled === 20, "seven days on: nothing netted in the window, 60 calls and 3 payers netted inside the 30 days");
  const q = Object.defineProperty({ calls30d: 100, payers30d: 7, payTos: [W] }, "byPayTo", { value: { [W]: { calls: 100, payers: 7 } }, enumerable: false });
  const b30 = buildEvidenceBinding({ leaderboardRows: later.ranked, walletEvidence: later.ev, bazaarQuality: [["https://seller-g.example", q]], circularWallets: circularWalletsFrom(later.ev, { now: NOW }), ...FLOORS }).get("https://seller-g.example");
  ok(b30.byWallet.get(W).settled === 40 && b30.byWallet.get(W).payers === 4, "the Bazaar's 100 / 7 over 30 days is netted to 40 / 4");
}

// --- 7. Refunds and cheap calls cannot be turned against an honest seller ----------
{
  // A seller refunds its main repeat buyer $0.01 once; the buyer then makes 60
  // more purchases. The refund returns one of its 40 genuine payments: that one
  // is removed, and nothing is netted.
  const W = addr("a1");
  const sp = [], so = [];
  const main = P(500), others = [P(501), P(502), P(503)];
  for (let k = 0; k < 40; k++) sp.push({ wallet: W, payer: main, usd: 0.01, pos: posOf(1000 + k, 0) });
  for (const [i, o] of others.entries()) for (let k = 0; k < 20; k++) sp.push({ wallet: W, payer: o, usd: 0.01, pos: posOf(1100 + i * 30 + k, 0) });
  so.push(log(W, main, usd(0.01), 1300));
  for (let k = 0; k < 60; k++) sp.push({ wallet: W, payer: main, usd: 0.01, pos: posOf(1400 + k, 0) });
  const st = createFundingState(USDC);
  const r = await scanOnce({ sellers: [seller(W, "seller-r.example")], pays: sp, outs: so, state: st, latest: 2000, span: 2000 });
  const bz = [["https://seller-r.example", { calls30d: 400, payers30d: 12, payTos: [W] }]];
  const circ = circularWalletsFrom(r.ev, { now: NOW });
  const bind = buildEvidenceBinding({ leaderboardRows: r.ranked, walletEvidence: r.ev, bazaarQuality: bz, circularWallets: circ, ...FLOORS });
  ok(r.ev[W].selfFundedCalls === 0 && r.ev[W].refundedCalls === 1 && r.ev[W].callsSettled === 159 && r.ev[W].circular === false && !circ.has(W), "ONE $0.01 REFUND to the main buyer after it had paid removes the one payment it returns and nets none of its 60 later payments (159 of 160 counted, not circular)");
  ok(label(bind, "https://seller-r.example", W).eligible === true && bind.get("https://seller-r.example").byWallet.get(W).settled === 399 && bind.get("https://seller-r.example").byWallet.get(W).payers === 12 && rankingPayersOf(bz[0][1], circ) === 12, "...eligible: its Bazaar figures lose only the refunded payment (399 / 12), and its tie-break payers are kept");
}
{
  // Wallets the seller once refunded, each paying the seller's cheapest price
  // again, cannot outweigh its genuine dollars: judged by dollars, not calls.
  const W = addr("a2");
  const sp = [], so = [];
  for (let i = 0; i < 4; i++) for (let k = 0; k < 10; k++) sp.push({ wallet: W, payer: P(600 + i), usd: 0.01, pos: posOf(1000 + i * 20 + k, 0) });
  for (let i = 0; i < 5; i++) { so.push(log(W, P(700 + i), usd(0.001), 1200 + i)); for (let k = 0; k < 40; k++) sp.push({ wallet: W, payer: P(700 + i), usd: 0.001, pos: posOf(1300 + i * 50 + k, 0) }); }
  const st = createFundingState(USDC);
  const r = await scanOnce({ sellers: [seller(W, "seller-v.example")], pays: sp, outs: so, state: st, latest: 2000, span: 2000 });
  const circ = circularWalletsFrom(r.ev, { now: NOW });
  ok(r.ev[W].selfFundedCalls === 5 && r.ev[W].selfFundedUsd === 0.005 && r.ev[W].circular === false && !circ.has(W), "five refunded wallets making 200 calls at $0.001 net five calls ($0.005 of $0.60): the seller is not circular, and keeps its Bazaar tie-break payers");
}

{
  // Many cheap calls paid with a refund cannot outweigh fewer, dearer genuine
  // ones: judged by dollars, a seller with 20 genuine $0.10 calls is not made
  // circular by 100 refunded $0.001 calls (by count it would be 100 of 120).
  const W = addr("a3");
  const sp = [], so = [];
  for (let i = 0; i < 4; i++) for (let k = 0; k < 5; k++) sp.push({ wallet: W, payer: P(900 + i), usd: 0.1, pos: posOf(1000 + i * 10 + k, 0) });
  so.push(log(W, P(950), usd(0.1), 1100));
  for (let k = 0; k < 100; k++) sp.push({ wallet: W, payer: P(950), usd: 0.001, pos: posOf(1200 + k, 0) });
  const r = await scanOnce({ sellers: [seller(W, "seller-u.example")], pays: sp, outs: so, state: createFundingState(USDC), latest: 2000, span: 2000 });
  ok(r.ev[W].selfFundedCalls === 100 && r.ev[W].circular === false && r.ev[W].callsSettled === 20 && r.ev[W].uniqueBuyers === 4, "100 refunded $0.001 calls against 20 genuine $0.10 ones: netted, but the seller is not circular ($0.10 of $2.10 self-funded)");
}

// --- 7a. Bazaar netting is attributed per origin, never double-deducted ----------
{
  // A wallet's own scan: `net` calls/payers genuine in the window, and what it
  // netted over 30 days. Not circular.
  const evAt = (w, { calls = 0, payers = 0, dc = 0, dp = 0 } = {}) => ({ [w]: { callsSettled: calls, uniqueBuyers: payers, grossCallsSettled: calls + dc, grossUniqueBuyers: payers + dp, selfFundedCalls: 0, selfFundedPayers: 0, selfFundedUsd: dc * 0.01, selfFundedCalls30d: dc, selfFundedPayers30d: dp, circular: false } });
  const bz = (w, calls, payers) => ({ calls30d: calls, payers30d: payers, payTos: [w] });
  {
    // Two origins on ONE wallet, 60 Bazaar calls each; the wallet netted 40
    // over 30 days. Together they hold 120 calls, 80 genuine: neither origin
    // must hold more than the 40 netted ones, so each keeps at least 60-40.
    const W = addr("c1");
    const b = buildEvidenceBinding({ walletEvidence: evAt(W, { dc: 40, dp: 2 }), bazaarQuality: [["https://two-a.example", bz(W, 60, 8)], ["https://two-b.example", bz(W, 60, 8)]], ...FLOORS });
    const a = b.get("https://two-a.example").byWallet.get(W), bb = b.get("https://two-b.example").byWallet.get(W);
    ok(a.settled === 60 && bb.settled === 60 && a.payers === 6 && bb.payers === 6, `TWO ORIGINS, ONE WALLET: the 40 netted calls fit in either origin's share, so neither loses them twice over (60 / 6 each, was 20 / 6)`);
    // Where the other origin cannot hold them, they are this origin's.
    const b2 = buildEvidenceBinding({ walletEvidence: evAt(W, { dc: 70, dp: 2 }), bazaarQuality: [["https://two-a.example", bz(W, 60, 8)], ["https://two-b.example", bz(W, 20, 3)]], ...FLOORS });
    ok(b2.get("https://two-a.example").byWallet.get(W).settled === 10 && b2.get("https://two-b.example").byWallet.get(W).settled === 10, "...and the netted calls the other origins cannot hold are deducted (80 calls, 70 netted: 10 genuine, and neither origin credited more)");
  }
  {
    // Bazaar MAX: the top resource had 5 payers and 4 payers paid the wallet
    // only with its own money. Which resource they paid is unknowable; the
    // wallet's own scan measured 5 genuine payers this window, which is exact.
    const W = addr("c2");
    const one = buildEvidenceBinding({ walletEvidence: evAt(W, { calls: 60, payers: 5, dc: 4, dp: 4 }), bazaarQuality: [["https://max.example", bz(W, 80, 5)]], ...FLOORS }).get("https://max.example").byWallet.get(W);
    ok(one.settled === 76 && one.payers === 5, "BAZAAR MAX: 5 payers less 4 wallet-wide self-funded ones is not 1 when the scan itself measured 5 genuine payers (76 / 5)");
    const calls = buildEvidenceBinding({ walletEvidence: evAt(W, { calls: 55, payers: 5, dc: 50, dp: 1 }), bazaarQuality: [["https://max.example", bz(W, 60, 6)]], ...FLOORS }).get("https://max.example").byWallet.get(W);
    ok(calls.settled === 55, "...and the calls likewise: 60 less 50 netted over 30 days is not 10 when the scan measured 55 genuine calls this window");
    const other = buildEvidenceBinding({ walletEvidence: evAt(W, { dc: 4, dp: 4 }), bazaarQuality: [["https://max.example", bz(W, 60, 5)], ["https://max-b.example", bz(W, 2, 2)]], ...FLOORS }).get("https://max.example").byWallet.get(W);
    ok(other.settled === 58 && other.payers === 1, "...and without a scan measurement the payer worst case stands (62 calls at the wallet, 4 netted, at most 2 of them held by the other origin: 58 / 1)");
  }
  {
    // CONTROL: a real business with 2 genuine payers pads its top resource with
    // 4 payers it funded (one cheap call each). Not circular by dollars; the
    // padded payer count must still not clear the floor.
    const W = addr("c3");
    const b = buildEvidenceBinding({ walletEvidence: evAt(W, { calls: 100, payers: 2, dc: 4, dp: 4 }), bazaarQuality: [["https://pad.example", bz(W, 104, 6)]], ...FLOORS });
    const e = b.get("https://pad.example").byWallet.get(W);
    ok(e.payers === 2 && label(b, "https://pad.example", W).eligible === false, "CONTROL: 4 funded payers padding the Bazaar payer count are still deducted (6 -> 2, under the floor of 3: refused)");
    // A circular wallet is still disregarded outright, whatever its share.
    const bc = buildEvidenceBinding({ walletEvidence: evAt(W, { calls: 1, payers: 1, dc: 500, dp: 20 }), bazaarQuality: [["https://pad.example", bz(W, 600, 25)], ["https://pad-b.example", bz(W, 600, 25)]], circularWallets: new Set([W]), ...FLOORS });
    ok(!bc.get("https://pad.example").byWallet.has(W) && label(bc, "https://pad.example", W).eligible === false, "CONTROL: a mostly self-funded (circular) wallet shared by two origins still clears nothing");
  }
}

// --- 7a2. Refunded PAYERS leave third-party payer counts too (2026-09-28) -----------
{
  // A wallet with two genuine buyers pads the Bazaar's payer figure with four
  // wallets that each paid once and were refunded in full. The scan removes
  // those payments and does not count those payers; the Bazaar's payer count
  // of the same wallet must lose them as well, or four refunded $0.01 calls
  // buy the missing payers back.
  const build = async (tag, genuine) => {
    const W = addr(tag);
    const sp = [], so = [];
    for (let i = 0; i < genuine; i++) for (let k = 0; k < 30; k++) sp.push({ wallet: W, payer: P(1700 + i), usd: 0.01, pos: posOf(1000 + i * 40 + k, 0) });
    for (let j = 0; j < 4; j++) { sp.push({ wallet: W, payer: P(1800 + j), usd: 0.01, pos: posOf(1300 + j * 5, 0) }); so.push(log(W, P(1800 + j), usd(0.01), 1302 + j * 5)); }
    const r = await scanOnce({ sellers: [seller(W, `seller-${tag}.example`)], pays: sp, outs: so, state: createFundingState(USDC), latest: 2000, span: 2000 });
    const bz = [[`https://seller-${tag}.example`, { calls30d: genuine * 30 + 4, payers30d: genuine + 4, payTos: [W] }]];
    const bind = buildEvidenceBinding({ walletEvidence: r.ev, bazaarQuality: bz, circularWallets: circularWalletsFrom(r.ev, { now: NOW }), ...FLOORS });
    return { W, r, bind, origin: `https://seller-${tag}.example` };
  };
  const pad = await build("d1", 2);
  ok(pad.r.ev[pad.W].refundedCalls === 4 && pad.r.ev[pad.W].refundedPayers === 4 && pad.r.ev[pad.W].uniqueBuyers === 2, "the scan removes the four refunded payments and reports their four payers as refunded (2 genuine buyers)");
  const e = pad.bind.get(pad.origin).byWallet.get(pad.W);
  ok(e.payers === 2 && label(pad.bind, pad.origin, pad.W).eligible === false, `REFUNDED PAYERS: the Bazaar's 6 payers lose the 4 whose every payment was refunded (got ${e.payers}), under the floor of 3: refused`);
  const cj = buildEvidenceBinding({ walletEvidence: pad.r.ev, chainProven: new Map([[pad.origin, { settled: 64, payers: 6, payTo: pad.W }]]), ...FLOORS }).get(pad.origin).byWallet.get(pad.W);
  ok(cj.payers === 2, "...and the chain join's wallet-wide payer figure loses them too (6 -> 2)");
  const honest = await build("d2", 3);
  const h = honest.bind.get(honest.origin).byWallet.get(honest.W);
  ok(h.payers === 3 && h.settled === 90 && label(honest.bind, honest.origin, honest.W).eligible === true, `CONTROL: three genuine buyers beside the same four refunds keep 90 calls / 3 payers and stay eligible (got ${h.settled} / ${h.payers})`);
}

// --- 7b. Refund-and-retry: a refund gives back genuine payments first -------------
{
  const run = async (pays0, outs0, w) => {
    const st = createFundingState(USDC);
    const r = await scanOnce({ sellers: [seller(w, "seller-rr.example")], pays: pays0, outs: outs0, state: st, latest: 2000, span: 2000 });
    return { ev: r.ev[w], st };
  };
  {
    // A flaky tool: P pays, the seller refunds, P retries; twice.
    const W = addr("b1"), p = P(1500);
    const sp = [{ wallet: W, payer: p, usd: 0.05, pos: posOf(1000, 0) }, { wallet: W, payer: p, usd: 0.05, pos: posOf(1010, 0) }, { wallet: W, payer: p, usd: 0.05, pos: posOf(1020, 0) }];
    const so = [log(W, p, usd(0.05), 1005), log(W, p, usd(0.05), 1015)];
    const { ev: e, st } = await run(sp, so, W);
    ok(e.selfFundedCalls === 0 && e.selfFundedUsd === 0 && e.refundedCalls === 2 && e.callsSettled === 1 && e.uniqueBuyers === 1 && e.circular === false, "HONEST FLAKY TOOL: pay, refund, retry, refund, retry(ok) -> 1 counted call, 2 refunded, 0 self-funded dollars, not circular");
    // The room survives the volume's format and an old four-field state still parses.
    const text = serializeFundingState(st);
    const back = parseFundingState(text, USDC);
    ok(JSON.stringify(back.wallets.get(W).known.get(p)) === JSON.stringify(st.wallets.get(W).known.get(p)) && JSON.stringify(st.wallets.get(W).known.get(p)[4]) === JSON.stringify([posOf(1020, 0), usd(0.05), usd(0.05)]) && JSON.stringify(back.wallets.get(W).pairs.get(p).rf) === JSON.stringify(st.wallets.get(W).pairs.get(p).rf), "refundable and refunded payments round-trip (the unrefunded retry is refundable; the two refunded ones are recorded)");
    const legacy = JSON.parse(text); legacy.wallets[W].k[p] = legacy.wallets[W].k[p].slice(0, 4);
    const old = parseFundingState(JSON.stringify(legacy), USDC);
    ok(old.wallets.get(W).known.get(p).length === 4 && (old.wallets.get(W).known.get(p)[4] || 0) === 0, "a state file written before refund room existed parses, reading as no room");
  }
  {
    // Ping-pong: one dollar paid and refunded N times, then paid once more.
    const W = addr("b5"), p = P(1505);
    const sp = [], so = [];
    for (let k = 0; k < 40; k++) { sp.push({ wallet: W, payer: p, usd: 0.5, pos: posOf(1000 + 2 * k, 0) }); so.push(log(W, p, usd(0.5), 1001 + 2 * k)); }
    sp.push({ wallet: W, payer: p, usd: 0.5, pos: posOf(1200, 0) });
    const { ev: e } = await run(sp, so, W);
    ok(e.callsSettled === 1 && e.refundedCalls === 40 && e.selfFundedCalls === 0 && e.circular === false, "PING-PONG: 40 rounds of pay / refund with one balance leave 1 counted call (the last, unrefunded payment), never 40");
  }
  {
    // Three wallets cycling $1 between them through the seller: each pays
    // $0.50 twice, the seller refunds $1, the wallet hands the dollar on.
    const W = addr("b6");
    const sp = [], so = [];
    let b = 1000;
    for (let round = 0; round < 30; round++) for (let i = 0; i < 3; i++) {
      const p = P(1600 + i);
      sp.push({ wallet: W, payer: p, usd: 0.5, pos: posOf(b++, 0) }, { wallet: W, payer: p, usd: 0.5, pos: posOf(b++, 0) });
      so.push(log(W, p, usd(1), b++));
    }
    const st = createFundingState(USDC);
    const r = await scanOnce({ sellers: [seller(W, "seller-cy.example")], pays: sp, outs: so, state: st, latest: 2000, span: 2000 });
    const bind = buildEvidenceBinding({ leaderboardRows: r.ranked, walletEvidence: r.ev, bazaarQuality: [["https://seller-cy.example", { calls30d: 180, payers30d: 3, payTos: [W] }]], circularWallets: circularWalletsFrom(r.ev, { now: NOW }), ...FLOORS });
    ok(r.ev[W].grossCallsSettled === 180 && r.ev[W].callsSettled === 0 && r.ev[W].refundedCalls === 180 && label(bind, "https://seller-cy.example", W).eligible === false && (bind.get("https://seller-cy.example").byWallet.get(W)?.settled ?? 0) === 0 && (bind.get("https://seller-cy.example").byWallet.get(W)?.payers ?? 0) === 0,
      "CYCLING $1 across three wallets for 180 payments: every one refunded, 0 counted, the Bazaar's 180 calls and 3 payers reduced to 0 (no evidence left at the wallet), and the floor of 50 is never reached");
  }
  {
    // Fund first, then pay: still the seller's money.
    const W = addr("b2"), p = P(1501);
    const { ev: e } = await run([{ wallet: W, payer: p, usd: 0.05, pos: posOf(1010, 0) }, { wallet: W, payer: p, usd: 0.05, pos: posOf(1020, 0) }], [log(W, p, usd(0.1), 1000)], W);
    ok(e.selfFundedCalls === 2 && e.callsSettled === 0, "FUNDED FIRST, THEN PAID: both payments netted (no genuine payment came before the funding)");
  }
  {
    // fund -> pay -> fund -> pay: a netted payment gives no refund room.
    const W = addr("b3"), p = P(1502);
    const sp = [{ wallet: W, payer: p, usd: 0.05, pos: posOf(1010, 0) }, { wallet: W, payer: p, usd: 0.05, pos: posOf(1030, 0) }];
    const { ev: e } = await run(sp, [log(W, p, usd(0.05), 1000), log(W, p, usd(0.05), 1020)], W);
    ok(e.selfFundedCalls === 2 && e.callsSettled === 0 && e.circular === true, "CYCLE fund -> pay -> fund -> pay: fully netted (a netted payment earns no refund room)");
  }
  {
    // A refund larger than what the payer genuinely paid: only the excess is pool.
    const W = addr("b4"), p = P(1503), q = P(1504);
    const sp = [{ wallet: W, payer: p, usd: 0.05, pos: posOf(1000, 0) }];
    for (let k = 0; k < 3; k++) sp.push({ wallet: W, payer: p, usd: 0.05, pos: posOf(1100 + k, 0) });
    for (let k = 0; k < 4; k++) sp.push({ wallet: W, payer: q, usd: 0.05, pos: posOf(1200 + k, 0) });
    const { ev: e } = await run(sp, [log(W, p, usd(0.15), 1050)], W);
    ok(e.refundedCalls === 1 && e.selfFundedCalls === 2 && e.callsSettled === 5, "a $0.15 transfer after $0.05 genuinely paid: that payment is removed as refunded, and the $0.10 excess nets two of the three later payments (5 counted)");
  }
}

// --- 8. The ranking tie-break -------------------------------------------------------
{
  const q = { calls30d: 500, payers30d: 40, payTos: [LOOP] };
  ok(rankingPayersOf(q, circular) === null && rankingPayersOf(q, new Set()) === 40, "a circular wallet's Bazaar payer count never breaks a ranking tie (null = unmeasured, not zero)");
  const split = { calls30d: 510, payers30d: 40, payTos: [LOOP, HONEST] };
  Object.defineProperty(split, "byPayTo", { value: { [LOOP]: { calls: 500, payers: 40 }, [HONEST]: { calls: 10, payers: 6 } }, enumerable: false });
  ok(rankingPayersOf(split, circular) === 6, "with a per-wallet split only the circular wallet's slice is left out");
  const index = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  ok(/p = rankingPayersOf\(bazaarQualityFor\(seller\), circular\.wallets\)/.test(index) && /cacheVersion, circular\.version\]\)/.test(index), "routeQuery reads it for every seller, and its scoring memo is keyed on the circular set's version");
  // ANOTHER WALLET'S VERDICT NEVER MOVES AN HONEST SELLER'S RANK. The review
  // measured the first cut: a seller with a Solana resource at 200 payers and
  // a Base resource at 5 ranked on 200 until any unrelated wallet was found
  // circular, then on 5.
  const { foldBazaarQuality } = await import("../src/x402-index.js");
  const W2 = addr("d2"), W3 = addr("d3"), UNRELATED = addr("d9");
  const fold = (rows) => { const m = new Map(); for (const [q, pay] of rows) foldBazaarQuality(m, "https://seller-s.example", q, pay); return m.get("https://seller-s.example"); };
  const qs = fold([[{ l30DaysTotalCalls: 900, l30DaysUniquePayers: 200 }, null], [{ l30DaysTotalCalls: 40, l30DaysUniquePayers: 5 }, W2]]);
  ok(rankingPayersOf(qs, new Set()) === 200 && rankingPayersOf(qs, new Set([UNRELATED])) === 200, "an origin with no circular wallet ranks on its own payers30d (200) whatever other wallet is circular");
  ok(rankingPayersOf(qs, new Set([W2])) === 200 && !Object.keys(qs).includes("payersOffBase"), "its OWN Base wallet circular: the 5 measured there leave, the 200 on a resource with no Base payTo stay (and that figure is not a public column)");
  const qb = fold([[{ l30DaysTotalCalls: 40, l30DaysUniquePayers: 30 }, W2], [{ l30DaysTotalCalls: 10, l30DaysUniquePayers: 4 }, W3]]);
  ok(rankingPayersOf(qb, new Set([UNRELATED])) === 30 && rankingPayersOf(qb, new Set([W2])) === 4, "a split origin untouched by an unrelated verdict (30), and only its own circular slice left out when it has one (4)");
  // Past the per-origin wallet cap a resource's payers are in payers30d and in
  // no split: an unrelated verdict must not drop them either.
  const capped = fold([...Array.from({ length: 8 }, (_, i) => [{ l30DaysTotalCalls: 3, l30DaysUniquePayers: 1 }, "0x" + (0xe00 + i).toString(16).padStart(40, "0")]), [{ l30DaysTotalCalls: 300, l30DaysUniquePayers: 100 }, addr("e9")]]);
  ok(Object.keys(capped.byPayTo).length === 8 && rankingPayersOf(capped, new Set([UNRELATED])) === 100, "a resource past the 8-wallet cap keeps its 100 payers in the tie-break beside an unrelated circular wallet");
  // Through routeQuery itself: two equal matches, the one with more payers
  // first, with an unrelated circular wallet on the leaderboard.
  const { routeQuery, _cacheForTests, _setBazaarQualityForTest } = await import("../src/x402-index.js");
  LB._resetLeaderboardCacheForTests();
  writeFileSync(process.env.LEADERBOARD_SNAPSHOT_FILE, JSON.stringify({ spec: "x402-leaderboard/1", asOf: new Date(NOW).toISOString(), leaderboard: [{ rank: 1, homepage: "https://seller-z.example", origins: ["https://seller-z.example"], wallet: UNRELATED, wallets: [UNRELATED], callsSettled: 90, uniqueBuyers: 9 }], walletEvidence: { [UNRELATED]: { callsSettled: 1, uniqueBuyers: 1, grossCallsSettled: 90, grossUniqueBuyers: 9, selfFundedCalls: 89, circular: true, lastCircularAt: new Date().toISOString(), origins: [] } } }));
  LB.startLeaderboardRefresh({ intervalMs: 3_600_000, firstDelayMs: 3_600_000 });
  ok(LB.getLeaderboardCircularWallets().wallets.has(UNRELATED), "(the leaderboard holds one unrelated circular wallet)");
  const cache = _cacheForTests(); cache.clear();
  const seedTool = (origin) => cache.set(origin, { manifest: { name: origin, homepage: origin }, openapiSummary: null, tools: [{ seller: origin, method: "POST", route: "/api/ocr", slug: "ocr", name: "ocr", description: "ocr a thing", category: "vision", tags: ["ocr"], price: 0.003 }], fetchedAt: Date.now(), error: null, history: [1, 1, 1, 1, 1] });
  seedTool("https://seller-s.example"); seedTool("https://seller-t.example");
  _setBazaarQualityForTest("https://seller-s.example", qs);
  _setBazaarQualityForTest("https://seller-t.example", fold([[{ l30DaysTotalCalls: 400, l30DaysUniquePayers: 50 }, W3]]));
  const ctx = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "agent402.base.eth" };
  const order = routeQuery({ query: "ocr", top: 10, include: "external", ...ctx }).results.filter((x) => /seller-[st]\.example/.test(x.seller)).map((x) => x.seller);
  ok(order[0] === "https://seller-s.example" && order.length === 2, `routeQuery: the seller with 200 payers (one Solana resource) still ranks first beside an unrelated circular wallet (got ${order.join(", ")})`);
  cache.clear(); _setBazaarQualityForTest("https://seller-s.example", null); _setBazaarQualityForTest("https://seller-t.example", null);
  LB.stopLeaderboardRefresh();
  LB._resetLeaderboardCacheForTests();
}

// --- 9. The operator's clearance, through the leaderboard's getters -----------------
{
  LB._resetLeaderboardCacheForTests();
  writeFileSync(process.env.LEADERBOARD_SNAPSHOT_FILE, JSON.stringify({ spec: "x402-leaderboard/1", asOf: new Date(NOW).toISOString(), leaderboard: s1.ranked, walletEvidence: ev }));
  LB.startLeaderboardRefresh({ intervalMs: 3_600_000, firstDelayMs: 3_600_000 });
  const list = new Set();
  let version = 0;
  const store = { has: (w) => list.has(String(w).toLowerCase()), get version() { return version; } };
  LB.configureSellerFunding({ cleared: store });
  ok(LB.getLeaderboardCircularWallets(NOW).wallets.has(LOOP) && LB.getLeaderboardWalletEvidence()[LOOP].callsSettled === 2, "before: circular, credited its net figures");
  list.add(LOOP); version++;
  ok(!LB.getLeaderboardCircularWallets(NOW).wallets.has(LOOP) && LB.getLeaderboardWalletEvidence()[LOOP].callsSettled === 62 && LB.getLeaderboardWalletEvidence()[LOOP].selfFundingCleared === true, "CLEARED: not circular, and its evidence reads gross, from the next read (no rescan)");
  ok(LB.getLeaderboardCircularWallets(NOW).wallets.has(MIXED) && LB.getLeaderboardWalletEvidence()[MIXED].callsSettled === 64, "...every other wallet untouched");
  list.delete(LOOP); version++;
  ok(LB.getLeaderboardCircularWallets(NOW).wallets.has(LOOP) && LB.getLeaderboardWalletEvidence()[LOOP].callsSettled === 2, "RESTORED: the measurement was never dropped, so the verdict is back at once");
  LB.stopLeaderboardRefresh();
  LB._resetLeaderboardCacheForTests();
}

// --- 9b. THE SWITCH: off is the gross per-wallet evidence, nothing else -------------
// LEADERBOARD_FUNDING_SCAN=off (read at call time) or the operator's runtime
// switch. The router's evidence must then be exactly what it is without this
// reader: every wallet's GROSS figures, no netting, no circular verdict - from
// the next read, not the next scan, so a warm-started snapshot full of netted
// figures stops counting at once.
{
  LB._resetLeaderboardCacheForTests();
  writeFileSync(process.env.LEADERBOARD_SNAPSHOT_FILE, JSON.stringify({ spec: "x402-leaderboard/1", asOf: new Date(NOW).toISOString(), leaderboard: s1.ranked, walletEvidence: { ...ev, [addr("9e")]: { callsSettled: 0, uniqueBuyers: 0, circular: false, lastCircularAt: new Date(NOW).toISOString(), carried: true, origins: [] } } }));
  LB.startLeaderboardRefresh({ intervalMs: 3_600_000, firstDelayMs: 3_600_000 });
  const bazaarQ = [["https://seller-a.example", { calls30d: 500, payers30d: 40, payTos: [LOOP] }], ["https://seller-c.example", { calls30d: 900, payers30d: 50, payTos: [MIXED] }]];
  const chainQ = new Map([["https://seller-a.example", { settled: 800, payers: 9, payTo: LOOP }]]);
  const bindNow = () => buildEvidenceBinding({ leaderboardRows: s1.ranked, walletEvidence: LB.getLeaderboardWalletEvidence(), bazaarQuality: bazaarQ, chainProven: chainQ, circularWallets: LB.getLeaderboardCircularWallets(NOW).wallets, ...FLOORS });
  // What the router reads with no seller-funding reader at all: the scan's
  // gross per-wallet figures and nothing else.
  const grossOnly = {};
  for (const [w, e] of Object.entries(ev)) grossOnly[w] = { callsSettled: e.grossCallsSettled ?? e.callsSettled, uniqueBuyers: e.grossUniqueBuyers ?? e.uniqueBuyers, origins: e.origins };
  const main = buildEvidenceBinding({ leaderboardRows: s1.ranked, walletEvidence: grossOnly, bazaarQuality: bazaarQ, chainProven: chainQ, ...FLOORS });
  const flat = (bind) => JSON.stringify([...bind].map(([o, e]) => [o, [...e.byWallet], [...e.clearing], e.settled, e.payers ?? null, e.ownSettled, [...e.selfFunded.byWallet], [...e.selfFunded.netted]]));
  ok(LB.getLeaderboardCircularWallets(NOW).wallets.has(LOOP) && LB.getLeaderboardWalletEvidence()[LOOP].callsSettled === 2 && flat(bindNow()) !== flat(main), "on (the default): netted figures and the circular verdict");
  process.env.LEADERBOARD_FUNDING_SCAN = "off";
  const offEv = LB.getLeaderboardWalletEvidence();
  ok(JSON.stringify(offEv) === JSON.stringify(grossOnly) && LB.getLeaderboardCircularWallets(NOW).wallets.size === 0 && !LB.sellerFundingEnabled(),
    "LEADERBOARD_FUNDING_SCAN=off, read at call time: every wallet's gross figures and nothing else (no netting, no verdict, not even a carried one)");
  ok(flat(bindNow()) === flat(main), "...so the router's evidence binding is exactly the one built with no seller-funding reader");
  const lbl = (bind) => { const e = bind.get("https://seller-a.example"); return dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: e?.settled || 0, payers: e?.payers, spendChains: ["base"], ...FLOORS, evidence: e, livePayTo: LOOP }); };
  const lOff = lbl(bindNow()), lMain = lbl(main);
  ok(lOff.eligible === true && lOff.reason === lMain.reason && JSON.stringify(lOff.chains) === JSON.stringify(lMain.chains), `...and seller-a reads as it would without the reader (${lOff.reason})`);
  delete process.env.LEADERBOARD_FUNDING_SCAN;
  ok(LB.getLeaderboardWalletEvidence()[LOOP].callsSettled === 2 && LB.getLeaderboardCircularWallets(NOW).wallets.has(LOOP), "back on: the measurement was never dropped");
  // The operator's switch, no redeploy.
  const d = LB.setSellerFundingEnabled(false, { note: "range read unconfirmed", now: NOW });
  ok(d.changed === true && d.enabled === false && d.source === "operator" && d.operator.persisted === true && JSON.stringify(LB.getLeaderboardWalletEvidence()) === JSON.stringify(grossOnly) && flat(bindNow()) === flat(main),
    "the operator's switch turns it off at runtime: the same gross evidence, persisted on the volume");
  LB._resetLeaderboardCacheForTests();
  ok(!LB.sellerFundingEnabled() && LB.sellerFundingSwitch().operator?.note === "range read unconfirmed", "...and it survives a restart (read back from the volume)");
  const e = LB.setSellerFundingEnabled(true, { now: NOW });
  process.env.LEADERBOARD_FUNDING_SCAN = "off";
  ok(e.enabled === true && !LB.sellerFundingEnabled() && LB.sellerFundingSwitch().source === "env", "the env's off wins over the operator's on");
  delete process.env.LEADERBOARD_FUNDING_SCAN;
  ok(LB.sellerFundingEnabled(), "...and with the env unset the operator's on stands");
  let threw = false;
  try { LB.setSellerFundingEnabled("no"); } catch (err) { threw = err.statusCode === 400; }
  ok(threw, "a switch value that is not a boolean is refused");
  LB.stopLeaderboardRefresh();
  LB._resetLeaderboardCacheForTests();
}

// --- 10. End to end: the refresh loop against a stub Bazaar + RPC, twice ------------
{
  let LATEST = 10_000;
  const e2ePays = [], e2eOuts = [];
  const inLog = (to, from, block, idx) => ({ address: USDC, topics: [TRANSFER, topic(from), topic(to)], data: "0x" + (10_000).toString(16).padStart(64, "0"), blockNumber: hex(block), logIndex: hex(idx) });
  // seller-a funds three payers well BEFORE the window, each pays 20x in the
  // window; one organic payer.
  for (let i = 1; i <= 3; i++) { e2eOuts.push(log(LOOP, P(i), usd(3), 8_500, i)); for (let k = 0; k < 20; k++) e2ePays.push(inLog(LOOP, P(i), 9_100 + k, i)); }
  e2ePays.push(inLog(LOOP, P(90), 9_200, 0));
  // seller-b: four payers x 15, a refund to one after its payments.
  for (let i = 20; i < 24; i++) for (let k = 0; k < 15; k++) e2ePays.push(inLog(HONEST, P(i), 9_300 + k, i));
  e2eOuts.push(log(HONEST, P(20), 10_000, 9_900));
  const rpcCalls = [];
  let rangeLimitedTargeted = 0;
  const srv = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url.startsWith("/bazaar")) {
        const items = [
          { resource: "https://seller-a.example/api/x", accepts: [{ network: "eip155:8453", asset: USDC, payTo: LOOP, amount: "10000" }] },
          { resource: "https://seller-b.example/api/y", accepts: [{ network: "eip155:8453", asset: USDC, payTo: HONEST, amount: "10000" }] },
          { resource: "https://burn.example/api/z", accepts: [{ network: "eip155:8453", asset: USDC, payTo: ZERO_ADDRESS, amount: "10000" }] },
        ];
        return send(/offset=0/.test(req.url) ? { items, pagination: { total: items.length } } : { items: [] });
      }
      const j = JSON.parse(body || "{}");
      if (j.method === "eth_blockNumber") return send({ jsonrpc: "2.0", id: j.id, result: hex(LATEST) });
      if (j.method === "eth_getLogs") {
        const p = j.params[0];
        rpcCalls.push(p);
        const spanOf = parseInt(p.toBlock, 16) - parseInt(p.fromBlock, 16) + 1;
        if (rangeLimitedTargeted && Array.isArray(p.topics?.[1]) && Array.isArray(p.topics?.[2]) && spanOf > rangeLimitedTargeted) return send({ jsonrpc: "2.0", id: j.id, error: { code: -32614, message: "eth_getLogs is limited to a 2,000 range" } });
        // One chain: the filter's topics pick inbound payments, outbound
        // funding, or a gap read (funded payers to a wallet) out of it.
        return send({ jsonrpc: "2.0", id: j.id, result: filterLogs([...e2ePays, ...e2eOuts], p) });
      }
      return send({ jsonrpc: "2.0", id: j.id, error: { code: -32601, message: "no" } });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const opts = { bazaarUrl: `${base}/bazaar`, rpcs: [`${base}/rpc`, `${base}/rpc-fallback`], spanBlocks: 1_000, chunkBlocks: 500, fundingHistoryFromBlock: 0, intervalMs: 3_600_000, firstDelayMs: 0 };
  const waitForScan = async (after) => { for (let i = 0; i < 200; i++) { const s = LB.getLeaderboardSnapshot(); if (s.asOf && s.asOf !== after && !s.warming && LB.getLeaderboardFundingScan()) return s; await new Promise((r) => setTimeout(r, 25)); } return null; };
  try {
    const direct = await runLeaderboard({ ...opts, now: NOW });
    ok(direct.walletsQueried === 2 && !direct.leaderboard.some((r) => r.wallets.includes(ZERO_ADDRESS)), "scan: a listing whose payTo is the zero address is not scanned (burns are not sales)");
    ok(direct.walletEvidence[LOOP]?.callsSettled === 1 && direct.walletEvidence[LOOP]?.grossCallsSettled === 61 && direct.walletEvidence[LOOP]?.circular === true, "scan: each new payer's history (funded before the window) nets seller-a to 1 genuine call and marks it circular");
    ok(direct.walletEvidence[HONEST]?.callsSettled === 59 && direct.walletEvidence[HONEST]?.refundedCalls === 1 && direct.walletEvidence[HONEST]?.circular === false, "scan: seller-b's refund after payment removes the one payment it returns (59 of 60 counted, none netted)");
    rpcCalls.length = 0;
    LB._resetLeaderboardCacheForTests();
    LB.startLeaderboardRefresh(opts);
    const first = await waitForScan(null);
    const outbound1 = rpcCalls.filter((p) => Array.isArray(p.topics?.[1]) && p.topics?.[2] === null);
    const hist1 = rpcCalls.filter((p) => Array.isArray(p.topics?.[1]) && Array.isArray(p.topics?.[2]));
    const histOut = hist1.filter((p) => p.topics[1].includes(topic(LOOP)));
    const histIn = hist1.filter((p) => p.topics[2].includes(topic(LOOP)));
    ok(first && outbound1.length === 0 && histOut.length === 1 && parseInt(histOut[0].fromBlock, 16) === 0 && parseInt(histOut[0].toBlock, 16) === LATEST, "refresh 1: nothing known yet, so no outbound read; ONE history read of both wallets' new payers from the history start to the latest block");
    ok(histIn.length === 1 && hist1.length === 2 && parseInt(histIn[0].toBlock, 16) === LATEST - 1_000 - 1, "refresh 1: ONE read of the funded payers' own transfers before the window, so their pools start right");
    ok(LB.getLeaderboardCircularWallets(NOW).wallets.has(LOOP) && LB.getLeaderboardFundingScan()?.walletsCaughtUp === 2 && LB.getLeaderboardFundingScan()?.historyPayers === 8, "refresh 1: the verdict and the read's counts are published to the router");
    await new Promise((r) => setTimeout(r, 50));
    ok(existsSync(process.env.LEADERBOARD_FUNDING_FILE) && parseFundingState(readFileSync(process.env.LEADERBOARD_FUNDING_FILE, "utf8"), USDC).wallets.get(LOOP)?.cursor === LATEST, "refresh 1: the funding state is persisted beside the snapshot with each wallet's cursor");
    const served = LB.getLeaderboardSnapshot();
    ok(!JSON.stringify(served).includes("routerFundingScan") && !JSON.stringify(served).includes("selfFundedCalls") && !JSON.stringify(served).includes("walletEvidence"), "served snapshot: no funding read, no per-wallet evidence");
    // A restart: the next process loads the persisted state and reads only new blocks.
    LB.stopLeaderboardRefresh();
    LB._resetLeaderboardCacheForTests();
    LATEST = 10_400;
    for (let k = 0; k < 5; k++) e2ePays.push(inLog(LOOP, P(1), 10_100 + k, 1));
    rpcCalls.length = 0;
    LB.startLeaderboardRefresh(opts);
    const second = await waitForScan(first?.asOf);
    const outbound2 = rpcCalls.filter((p) => Array.isArray(p.topics?.[1]));
    ok(second && outbound2.length === 1 && parseInt(outbound2[0].fromBlock, 16) === 10_001 && parseInt(outbound2[0].toBlock, 16) === 10_400, `refresh after a restart: the persisted cursors are used, only the new blocks are read (${outbound2.map((p) => `${parseInt(p.fromBlock, 16)}-${parseInt(p.toBlock, 16)}`).join(",")})`);
    ok(LB.getLeaderboardWalletEvidence()[LOOP]?.selfFundedCalls === 5 && LB.getLeaderboardWalletEvidence()[LOOP]?.grossCallsSettled === 5, "...and the pools remembered from the first process (funded before the first window) net the new payments");
    ok(outbound2.every((p) => rpcCalls.includes(p)) && !JSON.stringify(outbound2).includes("rpc-fallback"), "the funding read uses the primary RPC only");
    // A primary that limits the block range of eth_getLogs, through the real
    // scan: the history read stops at once, the scan's counts and log line
    // name it, and the wallets count as they are (not netted, not zero).
    LB.stopLeaderboardRefresh();
    rangeLimitedTargeted = 2_000;
    rpcCalls.length = 0;
    const lines = [];
    const limited = await runLeaderboard({ ...opts, now: NOW, onProgress: (m) => lines.push(m) });
    const f = limited.routerFundingScan || {};
    ok(f.readStopped === "range-limited" && f.historyCalls === 1 && f.partial === true && limited.walletEvidence[LOOP]?.fundingRead === false && limited.walletEvidence[LOOP]?.callsSettled === limited.walletEvidence[LOOP]?.grossCallsSettled && limited.walletEvidence[LOOP]?.grossCallsSettled > 0,
      `scan against a range-limited primary: one history call, then stopped (readStopped ${f.readStopped}, ${f.historyCalls} call); seller-a counted as it is`);
    ok(lines.some((l) => /stopped: range-limited/.test(l) && /FUNDING_HISTORY_CHUNK_BLOCKS/.test(l)) && LB.fundingReadNotes(f).includes("range-limited"), "...and the log line says why and which setting fits a history under the limit");
    rangeLimitedTargeted = 0;
    // Switched off, the scan itself: no funding read at all, the evidence is
    // gross, and no verdict is carried from the previous scan.
    const gone = addr("9f");
    const prevEv = { ...direct.walletEvidence, [gone]: { callsSettled: 0, uniqueBuyers: 0, circular: true, lastCircularAt: new Date(NOW).toISOString(), origins: [] } };
    process.env.LEADERBOARD_FUNDING_SCAN = "off";
    rpcCalls.length = 0;
    const off = await runLeaderboard({ ...opts, now: NOW, previousWalletEvidence: prevEv });
    const offCalls = [...rpcCalls];
    delete process.env.LEADERBOARD_FUNDING_SCAN;
    const on = await runLeaderboard({ ...opts, now: NOW, previousWalletEvidence: prevEv });
    ok(on.walletEvidence[gone]?.carried === true, "(control: switched on, the verdict of a wallet the scan no longer sees is carried)");
    ok(!off.routerFundingScan && offCalls.every((p) => !Array.isArray(p.topics?.[1])) && off.walletEvidence[LOOP]?.grossCallsSettled === undefined && !off.walletEvidence[gone] && Object.values(off.walletEvidence).every((e) => !e.circular && !e.lastCircularAt),
      "switched off, the scan makes no funding read, publishes gross per-wallet evidence and carries no verdict");
  } finally {
    LB.stopLeaderboardRefresh();
    srv.close();
  }
}

// --- 11. The call sites, pinned from source ------------------------------------------
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const at = server.indexOf("function buildEvidenceBindingByOrigin(");
  ok(/circularWallets: getLeaderboardCircularWallets\(\)\.wallets,/.test(server.slice(at, server.indexOf("\n}\n", at))), "the router's evidence binding reads the circular set");
  ok(/configureSellerFunding\(\{ cleared: selfFundingClearedStore\(\), skip: \(w\) => sharedPayToStore\(\)\.has\(w\) \}\)/.test(server), "the server hands the rule the operator's clearances and skips the shared settlement contracts");
  const lbSrc = readFileSync(new URL("../src/leaderboard.js", import.meta.url), "utf8");
  const run = lbSrc.slice(lbSrc.indexOf("export async function runLeaderboard("), lbSrc.indexOf("// --- history persistence"));
  const order = ["await readSellerFunding(", "await readPayerHistory(", "await readFundingGaps(", "processSellerFunding(state, byWallet,", "applySellerFunding(byWallet, state,", "const ranked = finalizeLeaderboard(byWallet"].map((x) => run.indexOf(x));
  ok(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), "runLeaderboard reads the outbound, the new payers' history and the gaps, works the pools, applies, then finalizes (the order scanOnce above mirrors)");
  ok(/processSellerFunding\(state, byWallet, \{[^\n]*histories: history\.histories/.test(run) && /historyFromBlockFor\(chain\.token\)/.test(run), "the pools are worked with the history just read, from the token's own history start");
  ok(/rpcCall\(primary, method, params, \{ passes: 1 \}\)/.test(run) && /\.filter\(\(s\) => isScannableWallet\(s\.wallet, chain\.token\)\)/.test(run), "the funding read uses the primary RPC once per call; non-wallet payTos are dropped from the scan");
  ok(/\.sort\(\(a, b\) => clears\(b\) - clears\(a\) \|\| \(b\.callsSettled \|\| 0\) - \(a\.callsSettled \|\| 0\)\)/.test(run) && /await readPayerHistory\(\{ rpc: fundingRpc,[^\n]*maxCalls: Math\.max\(0, maxCalls - facts\.calls\)/.test(run) && /await readFundingGaps\(\{ rpc: fundingRpc,[^\n]*maxCalls: Math\.max\(0, maxCalls - facts\.calls - history\.stats\.calls\)/.test(run), "wallets that clear the floor on gross are read first, and each later read spends only what the earlier ones left of the one budget");
  ok(/await loadSellerFundingState\(\)/.test(lbSrc) && /await persistSellerFundingState\(fundingState\)/.test(lbSrc), "every refresh loads the persisted state and writes it back");
  ok(/const ctl = newFundingReadControl\(\);/.test(run) && /const share = \{ ctl, scanMaxCalls: maxCalls, now: nowMs/.test(run) && /\n\s+ctl,\n\s+onProgress,\n\s+\}\);/.test(run) && /await readPayerHistory\(\{[^\n]*\.\.\.share, onProgress \}\)/.test(run) && /await readFundingGaps\(\{[^\n]*\.\.\.share, onProgress \}\)/.test(run),
    "one read control per scan, shared by the outbound, history and gap reads (timeouts, the stop, and each wallet's share are the scan's)");
}

// --- 12. The operator lever on a booted server ----------------------------------------
{
  const dir2 = mkdtempSync(join(tmpdir(), "seller-funding-boot-"));
  const W = addr("b1");
  const A = "https://seller-q.example";
  const nowIso = new Date().toISOString();
  writeFileSync(join(dir2, "lb.json"), JSON.stringify({
    spec: "x402-leaderboard/1", asOf: nowIso, windowLabel: "7d",
    leaderboard: [{ rank: 1, homepage: A, origins: [A], wallet: W, wallets: [W], callsSettled: 500, uniqueBuyers: 40 }],
    walletEvidence: { [W]: { callsSettled: 4, uniqueBuyers: 3, grossCallsSettled: 500, grossUniqueBuyers: 40, selfFundedCalls: 496, selfFundedUsd: 4.96, grossUsd: 5, circular: true, lastCircularAt: nowIso, fundingRead: true, origins: [A] } },
  }));
  const TOKEN = "seller-funding-operator-token-for-tests";
  const H = { "x-operator-token": TOKEN, "content-type": "application/json" };
  let proc = null, port = null;
  const serverLog = [];
  const boot = async () => {
    port = await getFreePort();
    proc = spawn(process.execPath, ["src/server.js"], {
      env: {
        ...process.env, PORT: String(port), FREE_MODE: "true", AGENT402_OPERATOR_TOKEN: TOKEN,
        LEADERBOARD_SNAPSHOT_FILE: join(dir2, "lb.json"), LEADERBOARD_FUNDING_FILE: join(dir2, "funding.json"),
        SOR_SELF_FUNDING_CLEARED_FILE: join(dir2, "cleared.json"), SOR_SHARED_PAYTOS_FILE: join(dir2, "shared.json"), LEADERBOARD_FUNDING_SWITCH_FILE: join(dir2, "switch.json"),
        X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false",
        MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) serverLog.push(l.slice(0, 300)); if (serverLog.length > 60) serverLog.splice(0, serverLog.length - 60); };
    proc.stdout.on("data", keep); proc.stderr.on("data", keep);
    for (let i = 0; i < 160; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* booting */ } await new Promise((r) => setTimeout(r, 500)); }
    return false;
  };
  const stop = () => new Promise((r) => { if (!proc) return r(); proc.once("exit", () => r()); proc.kill("SIGKILL"); });
  const get = async (p, h = H) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: h }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const post = async (body, h = H) => { const r = await fetch(`http://127.0.0.1:${port}/__operator/seller-funding`, { method: "POST", headers: h, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  try {
    ok(await boot(), "server booted (free mode, leaderboard warm-started from a fixture with one circular wallet)");
    const before = await get(`/__operator/seller-funding.json?wallet=${W}`);
    ok(before.status === 200 && before.body.circular === true && before.body.cleared === false && before.body.creditedTo.some((x) => x.origin === A && x.settled === 4) && before.body.notCounted.some((x) => x.origin === A && x.grossSettled === 500) && before.body.evidence?.selfFundedCalls === 496,
      "before: circular, credited its net 4; the gross 500 is labelled as what would have counted, and the 496 actually netted is reported as such");
    ok((await get("/__operator/seller-funding.json", { accept: "application/json" })).status === 404 && (await post({ action: "clear", wallet: W }, { "content-type": "application/json" })).status === 404, "without the operator token both routes answer 404");
    const listing = await get("/__operator/seller-funding");
    ok(listing.status === 200 && listing.body.circular.some((x) => x.wallet === W) && !JSON.stringify(listing.body).match(/0xa0a0/), "the listing names the circular wallet and no payer");
    const clear = await post({ action: "clear", wallet: W, note: "rewards program" });
    ok(clear.status === 200 && clear.body.changed === true && clear.body.cleared === true, "POST clear lists the wallet");
    const after = await get(`/__operator/seller-funding.json?wallet=${W}`);
    ok(after.body.cleared === true && after.body.creditedTo.some((x) => x.origin === A && x.settled === 500) && after.body.notCounted.length === 0, "applied from the next read, no redeploy: the gross 500 is credited and nothing is left uncounted");
    ok((await post({ action: "clear", wallet: "0x12" })).status === 400 && (await post({ action: "nope", wallet: W })).status === 400, "a malformed wallet or action is refused 400");
    await stop();
    ok(await boot(), "RESTART: the server boots again over the same /data files");
    const restarted = await get(`/__operator/seller-funding.json?wallet=${W}`);
    ok(restarted.body.cleared === true && restarted.body.entry?.note === "rewards program" && restarted.body.creditedTo.some((x) => x.settled === 500), "the clearance survived the restart");
    const restore = await post({ action: "restore", wallet: W });
    const back = await get(`/__operator/seller-funding.json?wallet=${W}`);
    ok(restore.body.changed === true && back.body.cleared === false && back.body.circular === true && back.body.creditedTo.some((x) => x.settled === 4), "POST restore puts the verdict back at once");
    const dis = await post({ action: "disable", note: "hold" });
    const whileOff = await get(`/__operator/seller-funding.json?wallet=${W}`);
    ok(dis.status === 200 && dis.body.enabled === false && dis.body.changed === true && whileOff.body.switch?.enabled === false && whileOff.body.creditedTo.some((x) => x.origin === A && x.settled === 500) && whileOff.body.notCounted.length === 0,
      "POST disable turns the whole reader off, no redeploy: the gross 500 is credited, nothing is left uncounted");
    await stop();
    ok(await boot(), "RESTART with the reader switched off");
    const offAgain = await get(`/__operator/seller-funding.json?wallet=${W}`);
    ok(offAgain.body.switch?.enabled === false && offAgain.body.switch?.source === "operator" && offAgain.body.creditedTo.some((x) => x.settled === 500), "the switch survived the restart");
    const en = await post({ action: "enable" });
    const onAgain = await get(`/__operator/seller-funding.json?wallet=${W}`);
    ok(en.body.enabled === true && onAgain.body.creditedTo.some((x) => x.settled === 4), "POST enable turns it back on at once");
  } catch (e) {
    ok(false, `booted leg threw: ${e?.stack || e}`);
    for (const l of serverLog.slice(-20)) console.error("  server:", l);
  } finally {
    await stop();
    try { rmSync(dir2, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
// The known-payer set is bounded across wallets, not only per wallet: the
// idlest go first, and a payer with a pool or paying this scan is kept.
{
  const known = (pairs) => new Map(pairs);
  const mkWs = (entries, pairs = new Map()) => ({ known: known(entries), pairs, hp: [] });
  const a = "0x" + "a1".repeat(20), b = "0x" + "b2".repeat(20);
  const pa = (i) => "0x" + i.toString(16).padStart(40, "0");
  const st = { wallets: new Map([
    [a, mkWs([[pa(1), [10, -1, -1, 0]], [pa(2), [50, -1, -1, 0]], [pa(3), [5, -1, -1, 0]]], new Map([[pa(3), { recs: [], pend: [], pool: 1, credit: 0 }]]))],
    [b, mkWs([[pa(4), [20, -1, -1, 0]], [pa(5), [60, -1, -1, 0]], [pa(6), [1, -1, -1, 0]]])],
  ]) };
  processSellerFunding(st, new Map(), { maxKnownTotal: 3 });
  const left = [...st.wallets.values()].flatMap((ws) => [...ws.known.keys()]).sort();
  ok(left.length === 3 && left.includes(pa(3)) && left.includes(pa(2)) && left.includes(pa(5)), `past the total cap the idlest known payers across wallets are forgotten, a pooled one kept (${left.map((x) => parseInt(x, 16)).join(",")})`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
