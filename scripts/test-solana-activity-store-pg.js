// The Solana activity scans' stored state against a REAL state database
// (src/solana-activity-store.js): one row per wallet in `records`, written in
// chunks off the scan's path under a lease, read one wallet at a time, bounded.
//
//   * a restart: the next process reads a wallet's row and resumes from it
//   * a flush writes at most FLUSH_CHUNK wallets; the rest wait for the next
//   * another container holding the lease: nothing is written here, nothing lost
//   * the collection is held to SOLANA_ACTIVITY_STORE_MAX_WALLETS rows
//   * a store that cannot be read is a cold wallet, never an error
//   STATE_DATABASE_URL=postgres://... node scripts/test-solana-activity-store-pg.js
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-solana-activity-store-pg" });
import { addr } from "./lib/solana-rpc-stub.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const guard = setTimeout(() => { console.error("FAIL - the suite did not finish in time"); process.exit(1); }, 120_000);

process.env.SOLANA_ACTIVITY_STORE_FLUSH_MS = "3600000"; // the suite flushes by hand
process.env.SOLANA_ACTIVITY_STORE_MAX_WALLETS = "30";

const sdb = await import("../src/state-db.js");
await sdb.stateDb();
const store = await import("../src/solana-activity-store.js");
const { solanaActivityView } = await import("../src/revenue-live.js");

// Whole seconds, as a block time is: the stored form keeps seconds.
const NOW = Math.floor(Date.now() / 1000) * 1000;
const stateOf = (i, rows = 5) => ({
  v: 1, at: NOW - (100 - i) * 1000, ata: `ATA${i}`, newestSig: `new${i}`, farSig: `far${i}`, covered: true, full: false, headAt: NOW - 5000, skipped: 0, stuck: null,
  entries: Array.from({ length: rows }, (_, n) => ({ when: new Date(NOW - (n + 1) * 3600_000).toISOString(), usd: 0.01 * (n + 1), from: addr(n, "B") })),
});
const count = () => sdb.records.count(store.SOLANA_ACTIVITY_COLLECTION);

// ---- chunked writes off the scan's path -------------------------------------
{
  ok(store.solanaActivityStoreStatus().backend === "state-db", "with a state database the store is the records table");
  ok(await store.loadSolanaActivityState(addr(0)) === null, "an empty store answers no state (a cold start)");
  for (let i = 0; i < 25; i++) store.noteSolanaActivityState(addr(i), stateOf(i));
  ok(await count() === 0 && store.solanaActivityStoreStatus().waiting === 25, "noting a state writes nothing (the scan's path makes no store call)");
  const first = await store.flushSolanaActivityStore();
  ok(first.written === store.FLUSH_CHUNK && await count() === store.FLUSH_CHUNK && first.waiting === 5, `one flush writes at most ${store.FLUSH_CHUNK} wallets (${first.written} written, ${first.waiting} waiting)`);
  const second = await store.flushSolanaActivityStore();
  ok(second.written === 5 && await count() === 25 && second.waiting === 0, `the next flush writes the rest (${second.written})`);
}

// ---- a restart resumes from the row -----------------------------------------
{
  const before = solanaActivityView(addr(3), stateOf(3));
  store.__resetSolanaActivityStoreForTest();           // the new process holds nothing
  const st = await store.loadSolanaActivityState(addr(3));
  ok(st && st.newestSig === "new3" && st.farSig === "far3" && st.ata === "ATA3" && st.entries.length === 5 && st.covered === true, "the next process reads the wallet's cursors and rows back");
  const after = solanaActivityView(addr(3), st);
  ok(JSON.stringify(after.buckets) === JSON.stringify(before.buckets) && JSON.stringify(after.totals) === JSON.stringify(before.totals) && after.totals.tx === 5 && after.asOf === before.asOf, "and serves the same chart and totals with the same as-of time");
  const s = store.solanaActivityStoreStatus();
  ok(s.loads === 1 && s.hits === 1, "one wallet's view costs one row read, never the whole collection");
  const row = await sdb.records.get(store.SOLANA_ACTIVITY_COLLECTION, addr(3));
  ok(Array.isArray(row.e) && row.e[0].length === 3 && JSON.stringify(row).length < 1000, `a row is the compact form (${JSON.stringify(row).length} bytes for five payments)`);
}

// ---- another container holds the flush lease --------------------------------
{
  await sdb.leases.acquire("solana-activity-store-flush", { owner: "other-container", ttlMs: 60_000 });
  const changed = { ...stateOf(3, 6), newestSig: "newer3" };
  store.noteSolanaActivityState(addr(3), changed);
  const r = await store.flushSolanaActivityStore();
  const row = await sdb.records.get(store.SOLANA_ACTIVITY_COLLECTION, addr(3));
  ok(r.skipped === "leased" && row.newestSig === "new3" && store.solanaActivityStoreStatus().waiting === 1, "while another container holds the lease nothing is written here and the wallet stays waiting");
  ok((await store.loadSolanaActivityState(addr(3))).newestSig === "newer3", "this process still reads its own newer state meanwhile");
  await sdb.leases.release("solana-activity-store-flush", { owner: "other-container" });
  const again = await store.flushSolanaActivityStore();
  ok(again.written === 1 && (await sdb.records.get(store.SOLANA_ACTIVITY_COLLECTION, addr(3))).newestSig === "newer3", "once the lease is free the waiting wallet is written");
}

// ---- bounded rows -----------------------------------------------------------
{
  store.__resetSolanaActivityStoreForTest();
  for (let i = 25; i < 45; i++) store.noteSolanaActivityState(addr(i), stateOf(i));
  const r = await store.flushSolanaActivityStore();
  const n = await count();
  ok(r.written === 20 && n === 30, `the collection is held to the configured ${process.env.SOLANA_ACTIVITY_STORE_MAX_WALLETS} wallets (${n} rows after 45 were written)`);
  ok(await sdb.records.get(store.SOLANA_ACTIVITY_COLLECTION, addr(44)) !== null && await sdb.records.get(store.SOLANA_ACTIVITY_COLLECTION, addr(0)) === null, "the least recently written wallets are the ones dropped");
  ok(store.solanaActivityStoreStatus().pruned === 15, `the dropped rows are counted (${store.solanaActivityStoreStatus().pruned})`);
}

// ---- a store that cannot be read is a cold wallet ---------------------------
{
  await sdb.records.put(store.SOLANA_ACTIVITY_COLLECTION, addr(44), { v: 99, e: "not rows" });
  store.__resetSolanaActivityStoreForTest();
  ok(await store.loadSolanaActivityState(addr(44)) === null, "a row this build does not read is a cold wallet");
  ok(store.solanaActivityStoreStatus().misses === 1, "and is counted as a miss");
}
await sdb.closeStateDb();

clearTimeout(guard);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
