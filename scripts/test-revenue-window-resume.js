#!/usr/bin/env node
// The live revenue view's window scan (src/revenue-live.js `recentInbound`)
// resumes from its stored state: a rescan reads the blocks after the stored
// head (plus a reorg overlap) instead of the whole window, and answers
// exactly what a full scan of the same chain answers. Offline: the EVM stub
// (scripts/lib/evm-rpc-stub-preload.mjs) answers every RPC in process.
//
//   * dense and sparse chains: resumed answer === full answer (JSON bytes),
//     after the head moves and after the window slides
//   * a reorganized tail inside the overlap is read again, never kept stale
//   * more transfers than a state keeps: still the same answer
//   * a state whose wallet or token differs, that is corrupt, or that the
//     window has slid past entirely: a full scan, the same answer
//   * the state survives a restart: written to the store, read back by a
//     process that never scanned, resumed from there
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const dir = mkdtempSync(join(tmpdir(), "revenue-window-"));
process.env.REVENUE_WINDOW_SCAN_FILE = join(dir, "revenue-window-scan.json");
process.env.REVENUE_LEDGER_DB = join(dir, "revenue-ledger.db");
delete process.env.ALCHEMY_API_KEY; // the public lanes; the stub answers them all
globalThis.__evmStub = { frozen: true, advanceAll: 0 };
const { evmStub } = await import("./lib/evm-rpc-stub-preload.mjs");
// Count the getLogs the scans send (the stub patched fetch first).
let getLogs = 0, blockReads = 0;
const stubFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  try { const m = JSON.parse(init?.body || "{}").method; if (m === "eth_getLogs") getLogs++; if (m === "eth_getBlockByNumber") blockReads++; } catch { /* not an RPC body */ }
  return stubFetch(url, init);
};
const live = await import("../src/revenue-live.js");
const { recentInbound, EVM } = live;
const resumable = typeof live.recentWindowPlan === "function";
ok(resumable, "recentInbound has a resumable window plan");

const W = "0x00000000000000000000000000000000000a4020";
const H0 = Object.fromEntries(evmStub.chains.map((c) => [c.name, c.head0]));
const stored = (st) => JSON.parse(JSON.stringify(st ?? null)); // what a store hands back
async function scan(chain, latest, prior = null) {
  getLogs = 0; blockReads = 0;
  // The stub chain's head is the head this scan reads.
  globalThis.__evmStub = { ...globalThis.__evmStub, frozen: true, advance: { [chain]: latest - H0[chain] } };
  const r = await recentInbound(EVM[chain], W, latest, { prior: stored(prior), chainKey: chain });
  return { r, calls: getLogs, blockReads, body: JSON.stringify({ recent: r.recent, missed: r.missed }) };
}
const windowBlocks = (chain, latest) => (resumable ? latest - live.recentWindowPlan(EVM[chain], latest).lowest + 1 : EVM[chain].span);

for (const chain of ["base", "polygon", "arc", "robinhood", "sei"]) {
  for (const [label, step] of [["dense", 4000], ["sparse", null], ["crowded", 40]]) {
    const L = H0[chain];
    const span = windowBlocks(chain, L);
    // sparse: two or three transfers in the whole window, so the eight are never filled
    globalThis.__evmStub = { frozen: true, step: step ?? Math.ceil(span / 3) };
    const first = await scan(chain, L);
    ok(first.r.recent.length > 0, `${chain} ${label}: the first scan finds transfers`);
    // The head moves a little: one chunk read, same answer as a full scan.
    const plan = live.recentWindowPlan ? live.recentWindowPlan(EVM[chain], L) : { chunk: span };
    const L2 = L + Math.min(Math.floor(span / 20), Math.floor(plan.chunk / 2));
    const full2 = await scan(chain, L2);
    const res2 = await scan(chain, L2, first.r.state);
    ok(res2.body === full2.body, `${chain} ${label}: resumed answer equals the full scan after the head moves`);
    ok(res2.calls >= 1 && res2.calls <= 2 && res2.calls <= full2.calls, `${chain} ${label}: the resumed scan read ${res2.calls} range(s) (full scan: ${full2.calls})`);
    ok(res2.blockReads <= full2.blockReads && (label === "crowded" || res2.blockReads < full2.blockReads), `${chain} ${label}: timestamps the state holds are not read again (${res2.blockReads} of ${full2.blockReads})`);
    // The window slides by a third: still the same answer.
    const L3 = L2 + Math.floor(span / 3);
    const full3 = await scan(chain, L3);
    const res3 = await scan(chain, L3, res2.r.state);
    ok(res3.body === full3.body, `${chain} ${label}: resumed answer equals the full scan after the window slides`);
    ok(res3.calls <= full3.calls && (label !== "sparse" || res3.calls < full3.calls), `${chain} ${label}: the slid scan read ${res3.calls} range(s), the full one ${full3.calls}`);
    // A reorganized tail inside the overlap: re-read, never kept stale.
    const L4 = L3 + 50;
    globalThis.__evmStub = { ...globalThis.__evmStub, reorgFrom: L3 - Math.min(40, Math.floor(span / 100)), reorgSalt: 3 };
    const full4 = await scan(chain, L4);
    const res4 = await scan(chain, L4, res3.r.state);
    ok(res4.body === full4.body, `${chain} ${label}: a reorganized tail inside the overlap reads the same as a full scan`);
    globalThis.__evmStub = { frozen: true, step: globalThis.__evmStub.step };
  }
}

// A first scan that lost a range part-way keeps only what it read above the
// loss; the next scan reads on down from there, as a full scan would.
for (const chain of ["base", "polygon"]) {
  const L = H0[chain];
  const plan = live.recentWindowPlan ? live.recentWindowPlan(EVM[chain], L) : { chunk: 9000, lowest: L - 30000 };
  globalThis.__evmStub = { frozen: true, step: Math.ceil((L - plan.lowest) / 3), failBlock: L - plan.chunk - 1 };
  const lossy = await scan(chain, L);
  ok(lossy.r.missed >= 1, `${chain}: the first scan lost a range (${lossy.r.missed} missed)`);
  ok(!lossy.r.state || lossy.r.state.lo > L - plan.chunk, `${chain}: its state claims only the blocks above the loss`);
  globalThis.__evmStub = { frozen: true, step: globalThis.__evmStub.step };
  const L2 = L + 10;
  const full = await scan(chain, L2);
  const res = await scan(chain, L2, lossy.r.state);
  ok(res.body === full.body && res.r.missed === 0, `${chain}: the next scan reads on down and answers what a full scan does`);
  ok(res.calls <= full.calls, `${chain}: it reads ${res.calls} range(s), a full scan ${full.calls}`);
}

// States a scan must not trust: each is a full scan with the full answer.
{
  globalThis.__evmStub = { frozen: true, step: 4000 };
  const L = H0.base;
  const first = await scan("base", L);
  const full = await scan("base", L + 100);
  const bad = {
    "another wallet": { ...first.r.state, wallet: "0x00000000000000000000000000000000000b0b00" },
    "another token": { ...first.r.state, token: "0x0000000000000000000000000000000000000001" },
    "a corrupt row list": { ...first.r.state, rows: "rows" },
    "a row outside its range": { ...first.r.state, rows: [{ block: L + 5, logIndex: 0, usd: 1, from: null, hash: "0x1" }] },
    "a head past the chain's": { ...first.r.state, head: L + 10_000 },
    "another version": { ...first.r.state, v: 99 },
  };
  for (const [what, st] of Object.entries(bad)) {
    const r = await scan("base", L + 100, st);
    ok(r.body === full.body && r.calls === full.calls, `${what}: a full scan with the full answer`);
  }
  const slid = await scan("base", L + 10 * windowBlocks("base", L), first.r.state);
  const slidFull = await scan("base", L + 10 * windowBlocks("base", L));
  ok(slid.body === slidFull.body && slid.calls === slidFull.calls, "a state the window slid past entirely: a full scan");
}

// Across a restart: the snapshot refresh writes the state to its store, and a
// process that never scanned reads it back and resumes.
if (resumable && typeof live._forgetWindowScansForTest === "function") {
  globalThis.__evmStub = { frozen: true, step: 4000, advanceAll: 0 };
  // A fresh scan (not the saved last-good copy a cold call may serve first).
  const freshSnapshot = async () => {
    live._setRevenueSnapshotDepsForTest({ store: null });
    for (let i = 0; i < 400; i++) {
      const s = await live.revenueSnapshot({ walletAddress: W, solanaWallet: "" }).catch(() => null);
      if (s?.rails?.some((r) => r.recentSource)) return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  };
  const snap1 = await freshSnapshot();
  ok(Array.isArray(snap1?.rails) && snap1.rails.some((r) => r.rail === "Base" && r.recentSource === "chain-scan"), "the snapshot read Base by its window scan");
  // The refresh saves without waiting; give the file write a turn.
  for (let i = 0; i < 50 && !existsSync(process.env.REVENUE_WINDOW_SCAN_FILE); i++) await new Promise((r) => setTimeout(r, 20));
  const saved = existsSync(process.env.REVENUE_WINDOW_SCAN_FILE) ? JSON.parse(readFileSync(process.env.REVENUE_WINDOW_SCAN_FILE, "utf8")) : null;
  ok(saved?.chains?.base?.head >= H0.base, "the window state is written to its store");
  live._forgetWindowScansForTest();
  const before = live.recentWindowStatus();
  globalThis.__evmStub = { frozen: true, step: 4000, advanceAll: 200 };
  const states = new Map(Object.entries(saved?.chains || {}));
  const L = H0.base + 200;
  const resumedFromStore = await scan("base", L, states.get("base"));
  const fullNow = await scan("base", L);
  ok(resumedFromStore.body === fullNow.body && resumedFromStore.calls <= 1, `a state read back from the store resumes (${resumedFromStore.calls} range read) with the full answer`);
  ok(live.recentWindowStatus().resumed > before.resumed, "the operator counters count the resume");
  // A store body this build does not read: the refresh reads whole windows and says so once.
  writeFileSync(process.env.REVENUE_WINDOW_SCAN_FILE, JSON.stringify({ v: 1, chains: [1, 2] }));
  live._forgetWindowScansForTest();
  const warn = console.warn; const lines = [];
  console.warn = (...a) => { lines.push(a.join(" ")); };
  try {
    await freshSnapshot();
  } finally { console.warn = warn; }
  ok(lines.filter((l) => /window scan state unreadable/.test(l)).length === 1, "an unreadable store is one log line and full scans");
} else ok(false, "the window state is stored and read back across a restart");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
