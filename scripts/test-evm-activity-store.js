#!/usr/bin/env node
// The EVM activity scans' state survives a restart (src/evm-activity-store.js,
// src/revenue-live.js `evmActivity`). Offline: the EVM stub
// (scripts/lib/evm-rpc-stub-preload.mjs) answers alchemy_getAssetTransfers.
//
//   * a state written and read back resumes: the next scan reads one page
//     where a cold scan reads the whole 30-day window
//   * the resumed answer equals a cold scan's at the same head (buckets,
//     totals, truncated), after the head moves and after a reorganized tail
//   * a truncated scan continues its far end from the stored state
//   * a state over the row bound is not kept (that wallet reads cold, as
//     before); a corrupt or foreign body is a cold scan
//   * the stored form keeps row ids only where a resumed read can meet them
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const dir = mkdtempSync(join(tmpdir(), "evm-activity-"));
process.env.EVM_ACTIVITY_FILE = join(dir, "evm-activity.json");
process.env.EVM_ACTIVITY_STORE_FLUSH_MS = "3600000"; // the suite flushes by hand
process.env.ALCHEMY_API_KEY = "stubkey";
process.env.MARKET_SCAN_BUDGET_MS = "60000";
globalThis.__evmStub = { frozen: true };
const { evmStub } = await import("./lib/evm-rpc-stub-preload.mjs");
let calls = 0;
const stubFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  try { if (JSON.parse(init?.body || "{}").method === "alchemy_getAssetTransfers") calls++; } catch { /* not an RPC body */ }
  return stubFetch(url, init);
};
const live = await import("../src/revenue-live.js");
let store = null;
try { store = await import("../src/evm-activity-store.js"); } catch { /* not on this build */ }
ok(!!store, "the EVM activity store exists");

const W = "0x00000000000000000000000000000000000a4020";
const H0 = Object.fromEntries(evmStub.chains.map((c) => [c.name, c.head0]));
const at = (chain, blocks) => { globalThis.__evmStub = { ...globalThis.__evmStub, frozen: true, advance: { [chain]: blocks } }; };
const view = (a) => JSON.stringify({ buckets: a.buckets, totals: a.totals, truncated: a.truncated, error: a.error });
async function run(chain, prior, opts = {}) { calls = 0; const a = await live.evmActivity(chain, W, { prior, ...opts }); return { a, calls, st: a.__scanState }; }
// The trip a state takes through the store: written, read back by another process.
async function throughStore(chain, st) {
  if (!store) return st;
  store.noteEvmActivityState(chain, W, st);
  await store.flushEvmActivityStore({ max: 100 });
  store.__resetEvmActivityStoreForTest();
  return store.loadEvmActivityState(chain, W);
}

for (const chain of ["base", "polygon", "arbitrum"]) {
  at(chain, 0);
  const cold = await run(chain, null);
  ok(!cold.a.error && cold.a.totals.tx > 1000 && !cold.a.truncated, `${chain}: a cold scan covers the window (${cold.a.totals.tx} transfers, ${cold.calls} pages)`);
  const back = await throughStore(chain, cold.st);
  ok(back && back.entries?.length === cold.st.entries.length, `${chain}: the state is read back after a restart`);
  // The head moves a few minutes.
  const move = Math.round(600_000 / evmStub.chains.find((c) => c.name === chain).ms);
  at(chain, move);
  const resumed = await run(chain, back);
  const fresh = await run(chain, null);
  ok(resumed.a.resumed === true && resumed.calls === 1, `${chain}: the scan after a restart reads ${resumed.calls} page (a cold one reads ${fresh.calls})`);
  ok(view(resumed.a) === view(fresh.a), `${chain}: the resumed chart equals a cold scan's`);
  // A reorganized tail inside the resume overlap: read again, never kept stale.
  // The newest transfer's block (the stub's activity step at its default 240 s).
  const step = Math.round(240_000 / evmStub.chains.find((c) => c.name === chain).ms);
  const head = H0[chain] + move;
  const newest = Math.floor(head / step) * step;
  globalThis.__evmStub = { ...globalThis.__evmStub, reorgFrom: newest, reorgSalt: 7 };
  const back2 = await throughStore(chain, resumed.st);
  at(chain, move + 3);
  const r2 = await run(chain, back2);
  const f2 = await run(chain, null);
  ok(view(r2.a) === view(f2.a) && view(f2.a) !== view(fresh.a), `${chain}: a reorganized tail reads the same as a cold scan`);
  globalThis.__evmStub = { frozen: true };
}

// A truncated scan (a page bound) continues its far end from the stored state.
{
  const chain = "polygon";
  at(chain, 0);
  const part = await run(chain, null, { maxPages: 3 });
  ok(part.a.truncated && part.st.farBlock != null, "a scan cut by its page bound is truncated with a far block");
  let st = await throughStore(chain, part.st);
  ok(st?.truncated === true && st?.farBlock === part.st.farBlock, "the far block survives the store");
  let last = null;
  for (let i = 0; i < 10 && st?.truncated; i++) { last = await run(chain, st, { farPages: 3 }); st = await throughStore(chain, last.st); }
  const fresh = await run(chain, null);
  ok(last && !last.a.truncated && view(last.a) === view(fresh.a), "continued from the store, the far end covers the window and equals a cold scan");
}

if (store) {
  // Bounds and bodies it must not trust.
  at("base", 0);
  const cold = await run("base", null);
  const big = store.compactEvmActivityState(cold.st, { rowsMax: 10 });
  ok(big === null, "a state over the row bound is not kept");
  const c = store.compactEvmActivityState(cold.st, { uidBlocks: 600 });
  const withUid = c.e.filter((r) => typeof r[5] === "string").length;
  ok(withUid > 0 && withUid < c.e.length / 4, `row ids are kept only near the newest block (${withUid} of ${c.e.length})`);
  ok(JSON.stringify(c).length < cold.st.entries.length * 45, `the stored form is compact (${Math.round(JSON.stringify(c).length / cold.st.entries.length)} bytes a row)`);
  ok(store.expandEvmActivityState({ ...c, v: 9 }) === null && store.expandEvmActivityState({ ...c, e: [[1, 2]] }) === null && store.expandEvmActivityState("x") === null, "a foreign or corrupt body is no state");
  ok(store.evmActivityKey("base", "0xABC") === null && store.evmActivityKey("base", W) === `base:${W}`, "only a chain and an address make a key");
  writeFileSync(process.env.EVM_ACTIVITY_FILE, JSON.stringify({ v: 1, wallets: { [`base:${W}`]: { v: 1, e: "rows" } } }));
  store.__resetEvmActivityStoreForTest();
  ok(await store.loadEvmActivityState("base", W) === null, "a corrupt stored row reads as a cold wallet");
  const st = store.evmActivityStoreStatus();
  ok(st.backend === "file" && st.misses >= 1, "the operator counters count the miss");
  // EVM_ACTIVITY_STORE=off: memory only, as before.
  process.env.EVM_ACTIVITY_STORE = "off";
  ok(store.noteEvmActivityState("base", W, cold.st) === false && await store.loadEvmActivityState("base", W) === null, "EVM_ACTIVITY_STORE=off keeps nothing");
  delete process.env.EVM_ACTIVITY_STORE;
  ok(existsSync(process.env.EVM_ACTIVITY_FILE) && readFileSync(process.env.EVM_ACTIVITY_FILE, "utf8").length > 0, "the file store holds the states");
}

// /privacy names what this store keeps (the sending wallet of each payment),
// for how many wallets and for how long, from the store's own figures, and
// only while the store is on.
if (store) {
  const { privacyPage } = await import("../src/privacy.js");
  const { pageText } = await import("./lib/html-text.js");
  const text = (html) => pageText(html).replace(/\s+/g, " ");
  const on = text(privacyPage("https://agent402.tools"));
  ok(on.includes("EVM wallet activity") && on.includes(`up to ${store.evmActivityMaxWallets()} wallets across those chains`) && on.includes("sending wallet address of each payment") && on.includes(`for ${store.EVM_ACTIVITY_KEEP_DAYS} days`) && store.EVM_ACTIVITY_KEEP_DAYS === 35 && store.evmActivityMaxWallets() === 500, "/privacy names the EVM activity store: the sending wallet, 500 wallets, 35 days");
  // Every field a stored row holds is named: the block, the flag for our own
  // wallets, the transaction id kept at the scan's edges, and the file the
  // store writes when there is no state database.
  ok(on.includes("the block number, time, amount and sending wallet address of each payment") && on.includes("whether that sending wallet is one of ours")
    && on.includes("the transaction id of payments in the newest and oldest blocks read") && on.includes("or in a file on the server when it runs without one"),
    "/privacy names every stored field (block, our-wallet flag, edge transaction ids) and the file fallback");
  process.env.EVM_ACTIVITY_STORE_MAX_WALLETS = "120";
  ok(text(privacyPage("https://agent402.tools")).includes("up to 120 wallets across those chains"), "/privacy prints the configured bound");
  delete process.env.EVM_ACTIVITY_STORE_MAX_WALLETS;
  process.env.EVM_ACTIVITY_STORE = "off";
  ok(!text(privacyPage("https://agent402.tools")).includes("EVM wallet activity"), "with the store off, /privacy does not describe it");
  delete process.env.EVM_ACTIVITY_STORE;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
