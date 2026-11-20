#!/usr/bin/env node
// The Solana activity scan resumes instead of reading its window again, in one
// process and across a restart, and its reads are background reads
// (src/revenue-live.js `solanaActivity`, src/solana-activity-store.js,
// src/solana-history-rpc.js). Offline: stub lanes on port 0 that count calls.
//
//   * a cold scan of a wallet with an empty store works, public lane first
//   * a refresh reads one signatures page and one transaction per NEW payment
//   * a restart with a stored state reads no transaction again, and the
//     answer served from the store equals the one before the restart
//   * a wallet too busy for one scan continues from its far cursor, and the
//     rows are never read twice
//   * with the public lane down, the keyed lane serves background reads only
//     up to the day's background share; past it the scan keeps what it holds,
//     says when it was last current, and a visitor-facing read is unaffected
//   * a read that keeps failing holds the cursor, then is skipped and counted
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWorld, startLane, addr, direct } from "./lib/solana-rpc-stub.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const dir = mkdtempSync(join(tmpdir(), "solana-activity-"));
process.env.SOLANA_ACTIVITY_FILE = join(dir, "solana-activity.json");
process.env.SOLANA_ACTIVITY_STORE_FLUSH_MS = "3600000"; // the suite flushes by hand
process.env.SOLANA_HISTORY_PUBLIC_RPS = "1000";         // pacing is test-solana-history-rpc.js's subject
process.env.HARDCAP_SYNC_MS = "3600000";

const world = makeWorld();
const pub = await startLane(world, "public");
const keyed = await startLane(world, "keyed");
const head = await startLane(world, "head");

const H = await import("../src/solana-history-rpc.js");
const caps = await import("../src/upstream-hard-caps.js");
const store = await import("../src/solana-activity-store.js");
const { solanaActivity, solanaActivityView } = await import("../src/revenue-live.js");
const { activityAsOfNote } = await import("../src/market-page.js");

// The keyed stub stands for the capped provider, so the background share applies to it.
const LANES = () => [{ url: pub.url, keyed: false }, { url: keyed.url, keyed: true, cap: "alchemy" }];
const read = (m, p, o) => H.solanaHistoryRead(m, p, { ...o, lanes: LANES(), publicTimeoutMs: 400, timeoutMs: 2000 });
const rpc = direct(head);
// Every read queues for the public lane here; the cold scan's unqueued start has its own case (10).
const scan = (wallet, extra = {}) => solanaActivity(wallet, { rpc, read, coldFastReads: 0, ...extra });
const resetCounts = () => { for (const l of [pub, keyed, head]) l.reset(); };
const resetAll = () => { resetCounts(); H.__resetSolanaHistoryForTest(); caps._resetHardCaps(); pub.mode = "ok"; keyed.mode = "ok"; pub.failFor.clear(); keyed.failFor.clear(); };
const callers = () => H.solanaHistoryStatus({ full: true }).callers;
const figures = (a) => JSON.stringify({ buckets: a.buckets, totals: a.totals, truncated: a.truncated });

// ---- 1. cold scan, empty store, public first -------------------------------
const W1 = addr(1);
world.addPayments(W1, 40, { ageSec: 120, gapSec: 3600 });
let a1, st1;
{
  resetAll();
  ok(await store.loadSolanaActivityState(W1) === null, "an empty store answers no state for a wallet (a cold start)");
  a1 = await scan(W1);
  st1 = a1.__scanState;
  ok(!a1.error && a1.totals.tx === 40 && a1.truncated === false, `a cold scan with an empty store reads the wallet's window (${a1.totals.tx} payments, truncated ${a1.truncated})`);
  ok(pub.calls.getTransaction === 40 && keyed.calls.getTransaction === 0, `public first: the public lane served all ${pub.calls.getTransaction} reads, the keyed lane ${keyed.calls.getTransaction}`);
  const c = callers()["activity-cold"];
  ok(c?.public === 40 && c?.keyed === 0, `the reads are counted under activity-cold as public (${JSON.stringify({ public: c?.public, keyed: c?.keyed })})`);
  ok(st1 && st1.covered === true && typeof st1.newestSig === "string" && st1.entries.length === 40 && typeof a1.asOf === "string" && !a1.refreshHeld, "the scan returns its state (cursors, rows) and when its head was current");
  ok(!Object.keys(a1).includes("__scanState") && !JSON.stringify(a1).includes("newestSig"), "the state never reaches the serialized answer");
  ok(head.calls.getTokenAccountsByOwner === 1, "the token account is looked up once");
}

// ---- 2. a refresh reads only what is new -----------------------------------
let a2;
{
  resetCounts(); H.__resetSolanaHistoryForTest();
  const same = await scan(W1, { prior: st1 });
  ok(pub.calls.getTransaction + keyed.calls.getTransaction === 0 && head.calls.getSignaturesForAddress === 1 && head.calls.getTokenAccountsByOwner === 0,
    `a refresh with nothing new reads one signatures page and no transaction (${pub.calls.getTransaction + keyed.calls.getTransaction} tx, ${head.calls.getSignaturesForAddress} sig, ${head.calls.getTokenAccountsByOwner} account)`);
  ok(figures(same) === figures(a1), "and shows the same figures");
  world.addPayments(W1, 3, { ageSec: 10, gapSec: 20 });
  resetCounts();
  a2 = await scan(W1, { prior: same.__scanState });
  ok(pub.calls.getTransaction === 3 && keyed.calls.getTransaction === 0 && a2.totals.tx === 43, `three new payments cost three transaction reads (${pub.calls.getTransaction}) and the total moves to ${a2.totals.tx}`);
  ok(callers()["activity-refresh"]?.public === 3 && !callers()["activity-cold"], "a resumed scan's reads are counted under activity-refresh");
  ok(st1.entries.length === 40, "the prior state is not edited in place");
}

// ---- 3. a restart resumes from the store -----------------------------------
{
  ok(store.noteSolanaActivityState(W1, a2.__scanState) === true && store.solanaActivityStoreStatus().waiting === 1, "a finished scan's state waits for the store's flush (nothing is written on the scan's path)");
  ok(!existsSync(process.env.SOLANA_ACTIVITY_FILE), "control: nothing is on disk before the flush");
  const f = await store.flushSolanaActivityStore();
  ok(f.written === 1 && store.solanaActivityStoreStatus().waiting === 0 && existsSync(process.env.SOLANA_ACTIVITY_FILE), `the flush writes the wallet's row (${JSON.stringify(f)})`);
  const onDisk = readFileSync(process.env.SOLANA_ACTIVITY_FILE, "utf8");
  ok(onDisk.includes(a2.__scanState.newestSig) && !/"when"/.test(onDisk), "the stored row holds the cursor and compact rows");

  // The restart: every in-memory copy is gone (the reader's cache, the store's memory).
  resetAll();
  store.__resetSolanaActivityStoreForTest();
  const stored = await store.loadSolanaActivityState(W1);
  ok(stored && stored.newestSig === a2.__scanState.newestSig && stored.entries.length === 43 && stored.covered === true, `the next process reads the stored state (${stored?.entries.length} rows)`);
  const served = solanaActivityView(W1, stored);
  ok(figures(served) === figures(a2) && served.asOf === a2.asOf, "the answer served from the store equals the one before the restart, with the same as-of time");
  const resumed = await scan(W1, { prior: stored });
  ok(pub.calls.getTransaction + keyed.calls.getTransaction === 0 && head.calls.getTokenAccountsByOwner === 0 && head.calls.getSignaturesForAddress === 1,
    `after a restart with a stored state the scan reads no transaction (${pub.calls.getTransaction + keyed.calls.getTransaction}) and one signatures page`);
  ok(!callers()["activity-cold"], "and makes no activity-cold read");
  ok(figures(resumed) === figures(a2), "the resumed scan shows the same figures");
  // The live control: the same wallet without the stored state reads its whole window again.
  resetAll();
  await scan(W1);
  ok(pub.calls.getTransaction === 43, `control: without the stored state the same wallet costs ${pub.calls.getTransaction} reads again`);
}

// ---- 4. a busy wallet continues from its far cursor ------------------------
{
  resetAll();
  const W2 = addr(2);
  world.addPayments(W2, 25, { ageSec: 300, gapSec: 1800 });
  const first = await scan(W2, { maxTx: 10 });
  ok(first.totals.tx === 10 && first.truncated === true && first.__scanState.covered === false, `a scan cut at ten reads holds ten rows and says it is a floor (${first.totals.tx}, truncated ${first.truncated})`);
  const second = await scan(W2, { prior: first.__scanState, maxTx: 10 });
  const third = await scan(W2, { prior: second.__scanState, maxTx: 10 });
  ok(second.totals.tx === 20 && third.totals.tx === 25 && third.truncated === false, `the next scans continue downward: ${second.totals.tx}, then ${third.totals.tx} and covered`);
  ok(pub.calls.getTransaction === 25, `no transaction is read twice across the three scans (${pub.calls.getTransaction} reads for 25 payments)`);
  const whole = await scan(addr(2), {});
  ok(figures(whole) === figures(third), "the continued scan's figures equal a single whole scan's");
}

// ---- 5. the background share bounds the keyed fallback ---------------------
{
  resetAll();
  process.env.SOLANA_HISTORY_BACKGROUND_KEYED_DAILY_MAX = "3";
  const W3 = addr(3);
  world.addPayments(W3, 6, { ageSec: 4000, gapSec: 3600 });
  const base = await scan(W3);                      // public serves the cold scan
  ok(base.totals.tx === 6 && keyed.calls.getTransaction === 0, "the wallet is read through the public lane while it answers");
  world.addPayments(W3, 8, { ageSec: 30, gapSec: 60 });
  pub.mode = "error";                               // the public lane stops answering
  resetCounts(); H.__resetSolanaHistoryForTest();
  const held = await scan(W3, { prior: base.__scanState });
  ok(keyed.calls.getTransaction === 3, `the keyed lane serves background reads up to the day's share and no further (${keyed.calls.getTransaction} of a share of 3)`);
  const share = caps.hardCapShareStatus()["history-background"];
  ok(share.usedToday === 3 && share.status === "spent" && share.refusedToday >= 1, `the share reads spent (${JSON.stringify(share)})`);
  ok(caps.hardCapStatus().upstreams.alchemy.usedToday === 0, "the ceiling paid tools draw on is not charged by the share's own count");
  ok(held.totals.tx === 9 && held.truncated === true && held.refreshHeld === true && held.heldReason === "budget", `the scan keeps what it read (${held.totals.tx} payments) and says its newest payments are unread (${held.heldReason})`);
  ok(held.asOf === base.asOf && Date.parse(held.asOf) <= Date.now(), "its as-of time is the last full read of the head, not this scan's time");
  ok(/^as of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/.test(activityAsOfNote(held)) && activityAsOfNote(base) === "", `the panel prints the as-of time for a held scan, not for a current one ("${activityAsOfNote(held)}")`);
  // The held mark travels with the stored state: the answer served after a restart says the same.
  const afterRestart = solanaActivityView(W3, store.expandSolanaActivityState(store.compactSolanaActivityState(held.__scanState)));
  ok(afterRestart.refreshHeld === true && afterRestart.heldReason === "budget" && afterRestart.asOf === held.asOf && afterRestart.truncated === true, "a held scan served from the store after a restart is still marked held, with the same as-of time");
  // A current chart served long after it was read (a restart after a long stop) prints its time too.
  ok(activityAsOfNote(base, Date.now() + 31 * 60_000).startsWith("as of ") && activityAsOfNote(base, Date.now() + 29 * 60_000) === "" && activityAsOfNote({ buckets: [], totals: {} }) === "", "a chart last current more than half an hour ago prints its as-of time; one without such a time prints nothing");
  const s = H.solanaHistoryStatus({ full: true });
  ok(s.heldForBudget >= 1 && s.callers["activity-refresh"]?.held >= 1 && s.status !== "failing", `held reads are counted and do not read as failing lanes (${s.heldForBudget} held, word ${s.status})`);
  // Another scan while the share is spent: no keyed call at all, the answer unchanged.
  resetCounts();
  const again = await scan(W3, { prior: held.__scanState });
  ok(keyed.calls.getTransaction === 0 && again.totals.tx === 9 && again.asOf === base.asOf, `with the share spent the keyed lane gets no background read (${keyed.calls.getTransaction}) and the view serves what it holds`);
  // The live control: a read with a visitor waiting on it is not a background read and is served.
  const tx = await H.solanaHistoryRead("getTransaction", [held.__scanState.newestSig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], { lanes: LANES(), keyedFirst: true, caller: "card", timeoutMs: 2000 });
  ok(tx && tx.meta, "control: a visitor-facing read is still served by the keyed lane while the background share is spent");
  // Once the public lane answers again the scan catches up and is current.
  pub.mode = "ok"; H.__resetSolanaHistoryForTest(); resetCounts();
  const caught = await scan(W3, { prior: again.__scanState });
  ok(caught.totals.tx === 14 && caught.truncated === false && !caught.refreshHeld && Date.parse(caught.asOf) > Date.parse(base.asOf) - 1 && pub.calls.getTransaction === 5, `when the public lane answers again the scan reads the remaining ${pub.calls.getTransaction} and is current`);
  delete process.env.SOLANA_HISTORY_BACKGROUND_KEYED_DAILY_MAX;
}

// ---- 6. a cold wallet whose reads are all held shows nothing, honestly ------
{
  resetAll();
  process.env.SOLANA_HISTORY_BACKGROUND_KEYED_DAILY_MAX = "0";
  const W4 = addr(4);
  world.addPayments(W4, 5, { ageSec: 100, gapSec: 100 });
  pub.mode = "error";
  const cold = await scan(W4);
  ok(typeof cold.error === "string" && cold.buckets.length === 0 && keyed.calls.getTransaction === 0, `a cold wallet with no read served is an honest error, never a chart of zeros (${cold.error})`);
  delete process.env.SOLANA_HISTORY_BACKGROUND_KEYED_DAILY_MAX;
}

// ---- 7. a read that keeps failing holds the cursor, then is skipped ---------
{
  resetAll();
  const W5 = addr(5);
  const sigs = world.addPayments(W5, 4, { ageSec: 500, gapSec: 500 });
  const base = await scan(W5);
  const [bad] = world.addPayments(W5, 1, { ageSec: 50 });
  world.addPayments(W5, 1, { ageSec: 5 });
  pub.failFor.add(bad); keyed.failFor.add(bad);
  let st = base.__scanState, last;
  for (let i = 0; i < 2; i++) { H.__resetSolanaHistoryForTest(); last = await scan(W5, { prior: st }); st = last.__scanState; }
  ok(last.totals.tx === 4 && last.refreshHeld === true && st.newestSig === sigs[0], "a transaction that cannot be read holds the head cursor before it (nothing newer is counted past a gap)");
  H.__resetSolanaHistoryForTest();
  last = await scan(W5, { prior: st });
  ok(last.totals.tx === 5 && !last.refreshHeld && last.__scanState.skipped === 1, `after failing in three scans it is skipped and counted, and the newer payment is read (${last.totals.tx} payments, ${last.__scanState.skipped} skipped)`);
}

// ---- 8. the stored form: bounded, and an unknown version is a cold wallet ---
{
  const big = { v: 1, at: Date.now(), ata: "A", newestSig: "n", farSig: "f", covered: false, entries: Array.from({ length: 2500 }, (_, i) => ({ when: new Date(Date.now() - i * 1000).toISOString(), usd: 0.01, from: addr(i % 7, "B") })) };
  const c = store.compactSolanaActivityState(big);
  ok(c.e.length === store.SOLANA_ACTIVITY_MAX_ENTRIES && JSON.stringify(c).length < 200_000, `a stored row is bounded (${c.e.length} rows, ${JSON.stringify(c).length} bytes)`);
  ok(store.expandSolanaActivityState({ ...c, v: 99 }) === null && store.expandSolanaActivityState(null) === null && store.expandSolanaActivityState({ v: 1 }) === null, "a row this build does not read is a cold wallet, never an error");
  const back = store.expandSolanaActivityState(c);
  ok(back.entries.length === 2000 && back.entries[0].usd === 0.01 && back.newestSig === "n", "a stored row expands to the state it was");
  process.env.SOLANA_ACTIVITY_STORE = "off";
  ok(store.noteSolanaActivityState(addr(1), big) === false && await store.loadSolanaActivityState(addr(1)) === null, "SOLANA_ACTIVITY_STORE=off keeps the state in memory only");
  delete process.env.SOLANA_ACTIVITY_STORE;
  ok(store.noteSolanaActivityState("not a wallet", big) === false, "a key that is not a Solana address is never stored");
}

// ---- 8b. a wallet past the row cap is a floor until its dropped rows leave the window
{
  resetAll();
  const W8 = addr(8);
  // 2,030 payments: thirty in the window's oldest two days, the rest in its newest day.
  world.addPayments(W8, 30, { ageSec: 28 * 86400, gapSec: 600 });
  world.addPayments(W8, 2000, { ageSec: 3600, gapSec: 20 });
  const full = await scan(W8, { maxTx: 5000 });
  const st = full.__scanState;
  ok(full.totals.tx === 2000 && full.truncated === true && st.full === true && st.fullFloor > 0, `a window past the row cap is held at the newest ${full.totals.tx} rows and is a floor`);
  const again = await scan(W8, { prior: st, maxTx: 5000 });
  ok(again.truncated === true && again.__scanState.full === true && pub.calls.getTransaction === 2030, "while the dropped rows are inside the window it stays a floor and reads nothing again");
  // Later: the window's edge has passed the oldest row kept, so every dropped row is outside it.
  const later = store.expandSolanaActivityState(store.compactSolanaActivityState({ ...again.__scanState, fullFloor: Date.now() - 31 * 86_400_000 }));
  const healed = await scan(W8, { prior: later });
  ok(healed.truncated === false && healed.__scanState.full === false && healed.__scanState.covered === true && healed.totals.tx === 2000, "once the dropped rows have left the window the rows held cover it and the floor mark goes");
}

// ---- 9. lane order for background reads ------------------------------------
{
  resetAll();
  const W6 = addr(6);
  const [sig] = world.addPayments(W6, 1, { ageSec: 5 });
  await H.solanaHistoryRead("getTransaction", [sig, { encoding: "jsonParsed" }], { lanes: LANES(), background: true, keyedFirst: true, caller: "bg" });
  ok(pub.calls.getTransaction === 1 && keyed.calls.getTransaction === 0, "background wins over keyedFirst: the public lane is asked first");
  // One cache entry per transaction whatever version the caller supports.
  await H.solanaHistoryRead("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }], { lanes: LANES(), background: true, caller: "board" });
  ok(pub.calls.getTransaction === 1 && H.solanaHistoryStatus({ full: true }).cacheHits === 1, "the board and the activity scan share one cached record per transaction");
}

// ---- 10. a cold scan's first reads do not queue; the rest do ----------------
{
  resetAll();
  process.env.SOLANA_HISTORY_PUBLIC_RPS = "50";       // a slot every 20 ms: most unqueued reads find it taken
  const W7 = addr(7);
  world.addPayments(W7, 30, { ageSec: 200, gapSec: 900 });
  const cold = await scan(W7, { coldFastReads: 12 });
  const c = callers()["activity-cold"];
  ok(cold.totals.tx === 30 && keyed.calls.getTransaction >= 1 && keyed.calls.getTransaction <= 12 && pub.calls.getTransaction === 30 - keyed.calls.getTransaction,
    `only the first twelve reads of a cold scan may take the keyed lane without queueing (${keyed.calls.getTransaction} keyed, ${pub.calls.getTransaction} public)`);
  ok(c.keyedBecause.paced === keyed.calls.getTransaction && c.keyedBecause.keyedFirst === 0, "and each is a public slot that was not open, never a keyed-first read");
  ok(caps.hardCapShareStatus()["history-background"].usedToday === keyed.calls.getTransaction, "each keyed read of a cold scan takes a unit of the background share");
  // With the share spent the unqueued start falls back to queueing: no keyed read, the same chart.
  resetAll();
  process.env.SOLANA_HISTORY_BACKGROUND_KEYED_DAILY_MAX = "0";
  const patient = await scan(W7, { coldFastReads: 12 });
  ok(patient.totals.tx === 30 && keyed.calls.getTransaction === 0 && pub.calls.getTransaction === 30 && figures(patient) === figures(cold), `with the share spent a cold scan queues every read for the public lane (${keyed.calls.getTransaction} keyed) and shows the same chart`);
  delete process.env.SOLANA_HISTORY_BACKGROUND_KEYED_DAILY_MAX;
  process.env.SOLANA_HISTORY_PUBLIC_RPS = "1000";
}

for (const l of [pub, keyed, head]) await l.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
