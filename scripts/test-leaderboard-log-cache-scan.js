#!/usr/bin/env node
// The Base board's log window cache, scan and persist cost
// (src/leaderboard-log-cache.js).
//
// Offline, no RPC, no store but an in-memory double that keeps each document
// as JSON text (what a real store hands back is a parsed copy):
//   1. A synthetic cache at the row cap's scale and a scan with a few new logs:
//      the transfers are the same, in the same order, as a full read of the
//      window (and as a fingerprint recorded from the implementation that
//      built one object per kept row); the scan holds a few bytes per kept row,
//      not an object per row; persist saves only the segments that changed.
//      Heap figures are printed.
//   2. A changed segment gets a new digest; an unchanged one keeps its stored
//      digest; the meta always names the digest of the body actually stored.
//   3. Every way a segment's rows change or go away (a wallet dropped and
//      read again, the window sliding, the row cap, a cursor out of the
//      window, a store that does not match its meta, a scan while a save is in
//      flight) leaves no stale digest: the meta matches the store and a fresh
//      process loads it and folds the same transfers as a full read.
//   4. State written by the earlier implementation loads, and the meta and
//      segment bodies written now are the same bytes it wrote.
// Ties on (block, logIndex) keep the order the old single sorted array had.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

if (typeof globalThis.gc !== "function") {
  const r = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

delete process.env.STATE_DATABASE_URL;
const C = await import("../src/leaderboard-log-cache.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };
const MB = (n) => (n / 1048576).toFixed(1);
const used = () => { const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
const sha16 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// ---- store double --------------------------------------------------------
function memStore({ onSave = null } = {}) {
  const docs = new Map();
  const log = { saves: [], dels: [] };
  return {
    persistent: true, docs, log,
    async read(k) { return { ok: true, body: docs.has(k) ? JSON.parse(docs.get(k)) : null }; },
    async save(k, body) { const text = JSON.stringify(body); if (onSave) await onSave(k, body); docs.set(k, text); log.saves.push(k); return true; },
    async del(k) { docs.delete(k); log.dels.push(k); return true; },
  };
}
const metaOf = (store) => (store.docs.has("meta") ? JSON.parse(store.docs.get("meta")) : null);
// Every segment the meta names is stored, with that digest and row count.
function consistent(store) {
  const m = metaOf(store);
  if (!m) return "no meta";
  for (const [k, want] of Object.entries(m.segs)) {
    const text = store.docs.get(k);
    if (!text) return `segment ${k} missing`;
    if (sha16(text) !== want.digest) return `segment ${k}: meta digest ${want.digest}, stored body ${sha16(text)}`;
    if (JSON.parse(text).rows.length / 5 !== want.rows) return `segment ${k}: row count`;
  }
  return "ok";
}

// ---- small chain ---------------------------------------------------------
const W = Array.from({ length: 6 }, (_, i) => "0x" + "a".repeat(39) + i);
const P = Array.from({ length: 4 }, (_, i) => "0x" + "b".repeat(39) + i);
const CHAIN = [];
{
  let x = 7; const r = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
  for (let block = 1; block <= 2_000; block++) {
    const n = Math.floor(r() * 3);
    for (let li = 0; li < n; li++) CHAIN.push({ wallet: W[Math.floor(r() * W.length)], payer: r() < 0.1 ? null : P[Math.floor(r() * P.length)], micro: 1000 + Math.floor(r() * 9) * 1000, block, logIndex: li });
  }
}
const smallReader = (chain = CHAIN) => async (a, b, list) => { const s = new Set(list); return chain.filter((t) => t.block >= a && t.block <= b && s.has(t.wallet)).map((t) => ({ ...t })); };
const key = (t) => `${t.wallet}|${t.payer}|${t.micro}|${t.block}|${t.logIndex}`;
const seqOf = (iter) => { const out = []; for (const t of iter) out.push(key(t)); return out.join("\n"); };
const fullRead = (start, latest, wallets, chain = CHAIN) => { const s = new Set(wallets); return seqOf(chain.filter((t) => t.block >= start && t.block <= latest && s.has(t.wallet)).sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)); };
const SPAN = 600;
const smallScan = (cache, latest, wallets = W, extra = {}) => cache.scan({ wallets, start: latest - SPAN + 1, latest, chunkBlocks: 97, walletChunk: 4, pad: (w) => w, readLogs: smallReader(), ...extra });
const newSmall = (store, extra = {}) => C.createLogWindowCache({ store, token: "0xUSDC", segmentBlocks: 100, reorgMarginBlocks: 5, ...extra });
// A fresh process: loads the store, scans, and must fold a full read's transfers.
async function reloads(store, latest, wallets = W) {
  const c = newSmall(store);
  const r = await smallScan(c, latest, wallets);
  const st = c.stats();
  return { same: seqOf(r.transfers) === fullRead(latest - SPAN + 1, latest, wallets), mode: r.mode, resets: st.resets, reason: st.lastReason };
}

// ---- 1. scale: a cache at the row cap and a scan with a few new logs -------
{
  const SEG = 18_000, WIN = 302_400, START = 30_000_000, NW = 1500;
  const wallets = Array.from({ length: NW }, (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0"));
  const payers = Array.from({ length: 4000 }, (_, i) => "0x" + "f" + (i + 1).toString(16).padStart(39, "0"));
  const rowsAt = (block) => {
    let x = (block * 2654435761) >>> 0; const r = () => { x = (x * 1103515245 + 12345) >>> 0; return x / 4294967296; };
    const n = Math.floor(r() * 12.8); const out = [];
    for (let li = 0; li < n; li++) out.push({ wallet: wallets[Math.floor(r() * r() * NW)], payer: r() < 0.02 ? null : payers[Math.floor(r() * payers.length)], micro: [1000, 10000, 2500000][Math.floor(r() * 3)], block, logIndex: li * 3 });
    return out;
  };
  const readLogs = async (a, b, list) => { const s = new Set(list); const out = []; for (let k = a; k <= b; k++) for (const t of rowsAt(k)) if (s.has(t.wallet)) out.push(t); return out; };
  const fingerprint = (iter) => { const h = createHash("sha256"); let n = 0; for (const t of iter) { const f = C.transferForFold(t); h.update(`${f.wallet}|${f.payer}|${f.usd}|${f.pos};`); n++; } return { digest: h.digest("hex").slice(0, 16), n }; };
  const reference = (start, latest, list) => fingerprint((function* () { const s = new Set(list); for (let k = start; k <= latest; k++) for (const t of rowsAt(k)) if (s.has(t.wallet)) yield t; })());
  const store = memStore();
  const cache = C.createLogWindowCache({ store, token: "0xusdc", segmentBlocks: SEG, reorgMarginBlocks: 300 });
  const base = { chunkBlocks: 2_000, walletChunk: NW, pad: (w) => w, readLogs };
  let latest = START + WIN - 1;
  await cache.scan({ ...base, wallets, start: START, latest });
  await cache.persist();
  const kept = cache.stats().rows;
  ok(kept > 1_500_000 && kept <= C.LOG_CACHE_DEFAULTS.maxRows, `the synthetic cache holds ${kept} rows in ${cache.stats().segments} segments (cap ${C.LOG_CACHE_DEFAULTS.maxRows})`);

  globalThis.gc(); globalThis.gc();
  const before = used();
  let peak = before; const sample = () => { const u = used(); if (u > peak) peak = u; };
  latest += 150;
  store.log.saves.length = 0;
  const r = await cache.scan({ ...base, wallets, start: latest - WIN + 1, latest });
  sample();
  globalThis.gc();
  const held = used() - before;
  let n = 0;
  const h = createHash("sha256");
  for (const t of r.transfers) { const f = C.transferForFold(t); h.update(`${f.wallet}|${f.payer}|${f.usd}|${f.pos};`); if (++n % 50_000 === 0) sample(); }
  sample();
  const got = { digest: h.digest("hex").slice(0, 16), n };
  const iterPeak = peak - before;
  globalThis.gc();
  const persistBase = used(); peak = persistBase;
  await cache.persist();
  sample();
  const persistPeak = peak - persistBase;
  console.log(`# heap above the post-gc baseline (${MB(before)} MB, ${kept} kept rows): scan holds ${MB(held)} MB (${(held / kept).toFixed(1)} bytes/row); peak while folding ${MB(iterPeak)} MB (short-lived objects included); persist peak ${MB(persistPeak)} MB`);
  ok(held / kept < 16, `the scan holds an index per kept row, not an object (${(held / kept).toFixed(1)} bytes/row)`);
  ok(r.transfers.length === n && n > kept, `the view's length is what it yields (${n})`);
  const ref = reference(latest - WIN + 1, latest, wallets);
  ok(got.digest === ref.digest && got.n === ref.n, `the incremental scan folds exactly a full read's transfers, in order (${got.digest})`);
  // Recorded from the implementation that built one object per kept row, on
  // this same synthetic chain and scan sequence.
  ok(got.digest === "5f1089b15374ae2d" && got.n === 1_786_065, "and matches the fingerprint recorded from the earlier implementation");
  const segSaves = store.log.saves.filter((k) => k !== "meta");
  ok(segSaves.length >= 1 && segSaves.length <= 2, `persist saved only the segment(s) the head reached (${segSaves.join(",")}), not all ${cache.stats().segments}`);
  ok(consistent(store) === "ok", `the meta names every stored segment's digest (${consistent(store)})`);
  ok(persistPeak < 64 * 1048576, `persist serializes only what changed (peak ${MB(persistPeak)} MB)`);

  // New wallets read over the window land in kept segments: same order.
  const more = [...wallets, ...Array.from({ length: 20 }, (_, i) => "0x" + "e" + (i + 1).toString(16).padStart(39, "0"))];
  latest += 40;
  const r2 = await cache.scan({ ...base, wallets: more, start: latest - WIN + 1, latest });
  const g2 = fingerprint(r2.transfers), ref2 = reference(latest - WIN + 1, latest, more);
  ok(g2.digest === ref2.digest && g2.n === ref2.n, "a scan with new wallets folds exactly a full read's transfers");
  // A wallet leaves: its kept rows are no longer folded.
  const fewer = wallets.slice(1);
  latest += 10;
  const r3 = await cache.scan({ ...base, wallets: fewer, start: latest - WIN + 1, latest });
  const g3 = fingerprint(r3.transfers), ref3 = reference(latest - WIN + 1, latest, fewer);
  ok(g3.digest === ref3.digest && g3.n === ref3.n, "a scan without a listed wallet folds exactly a full read's transfers");
  await cache.persist();
  ok(consistent(store) === "ok", "the meta still matches the store");
}

// ---- ties keep the old order ---------------------------------------------
{
  // Kept rows, then a new wallet's backfill, then the head, stable-sorted by
  // (block, logIndex): what the old single array did with duplicate keys.
  const A = W[0], B = W[1];
  const chain = [
    { wallet: A, payer: P[0], micro: 1, block: 410, logIndex: 2 },
    { wallet: A, payer: P[1], micro: 2, block: 410, logIndex: 2 },
    { wallet: A, payer: P[2], micro: 3, block: 420, logIndex: 0 },
  ];
  const store = memStore();
  const c = newSmall(store);
  await c.scan({ wallets: [A], start: 401, latest: 500, chunkBlocks: 1000, walletChunk: 4, pad: (w) => w, readLogs: smallReader(chain) });
  const back = [{ wallet: B, payer: P[3], micro: 4, block: 410, logIndex: 2 }, { wallet: B, payer: P[0], micro: 5, block: 405, logIndex: 9 }];
  const head = [{ wallet: A, payer: P[0], micro: 6, block: 498, logIndex: 1 }, { wallet: B, payer: P[1], micro: 7, block: 497, logIndex: 1 }];
  const r = await c.scan({ wallets: [A, B], start: 401, latest: 500, chunkBlocks: 1000, walletChunk: 1, pad: (w) => w,
    readLogs: async (a, b, list) => (list[0] === B && b <= 495 ? back : a > 495 && list[0] === A ? head.slice(0, 1) : a > 495 ? head.slice(1) : []) });
  const want = [...chain, ...back, ...head].filter((t) => t.block <= 500).sort((x, y) => x.block - y.block || x.logIndex - y.logIndex).map(key).join("\n");
  ok(seqOf(r.transfers) === want, "ties on (block, logIndex) keep kept-then-backfill-then-head order");
  ok(seqOf(r.transfers) === seqOf(r.transfers), "the view can be read twice");
}

// ---- 2. dirty segments get new digests, clean ones keep theirs ------------
{
  const store = memStore();
  const c = newSmall(store);
  let latest = 1_000;
  await smallScan(c, latest);
  await c.persist();
  const m1 = metaOf(store);
  ok(consistent(store) === "ok" && Object.keys(m1.segs).length >= 6, `cold persist: ${Object.keys(m1.segs).length} segments, meta matches the store`);
  latest += 40;              // the head stays inside segment 1000
  store.log.saves.length = 0;
  const r = await smallScan(c, latest);
  await c.persist();
  const m2 = metaOf(store);
  const changed = Object.keys(m2.segs).filter((k) => m1.segs[k]?.digest !== m2.segs[k].digest);
  const touched = [...new Set(CHAIN.filter((t) => t.block > 995 && t.block <= latest - 5).map((t) => String(Math.floor(t.block / 100) * 100)))];
  ok(touched.length && changed.sort().join() === touched.sort().join(), `the segment(s) the head added rows to got a new digest (${changed.join(",")})`);
  ok(Object.keys(m2.segs).filter((k) => !changed.includes(k)).every((k) => m2.segs[k].digest === m1.segs[k].digest), "every other segment kept its stored digest");
  ok(store.log.saves.filter((k) => k !== "meta").sort().join() === touched.sort().join(), "and only the changed segment(s) were saved");
  ok(consistent(store) === "ok", "the meta matches the store");
  ok(seqOf(r.transfers) === fullRead(latest - SPAN + 1, latest, W), "the fold is a full read's");
  const re = await reloads(store, latest + 3);
  ok(re.mode === "incremental" && re.resets === 0 && re.same, `a fresh process loads it and folds a full read (${re.reason || "loaded"})`);
}

// ---- 3. no stale digest after any invalidation ----------------------------
{
  const store = memStore();
  const c = newSmall(store);
  let latest = 1_000;
  await smallScan(c, latest); await c.persist();

  // A wallet leaves and is read again: its rows are dropped from clean segments.
  latest += 10; await smallScan(c, latest, W.slice(1)); await c.persist();
  const hadW0 = Object.keys(metaOf(store).segs).filter((k) => JSON.parse(store.docs.get(k)).wallets.includes(W[0]));
  store.log.saves.length = 0;
  latest += 10; const r = await smallScan(c, latest, W); await c.persist();
  ok(r.newWallets === 1 && consistent(store) === "ok", `a returning wallet: rows dropped and read again, meta matches the store (${consistent(store)})`);
  ok(hadW0.length > 1 && hadW0.every((k) => store.log.saves.includes(k)), `and every segment its rows were dropped from was saved again (${hadW0.join(",")})`);
  let re = await reloads(store, latest + 1);
  ok(re.resets === 0 && re.mode === "incremental" && re.same, "a fresh process loads it and folds a full read");

  // The window slides: segments wholly older are deleted and leave the meta.
  latest += 450; await smallScan(c, latest); await c.persist();
  const m3 = metaOf(store);
  ok(Object.keys(m3.segs).every((k) => Number(k) + 99 >= latest - SPAN + 1) && [...store.docs.keys()].filter((k) => k !== "meta").every((k) => k in m3.segs), "a slide: old segments leave the meta and the store");
  ok(consistent(store) === "ok", "the meta matches the store");
  re = await reloads(store, latest + 1);
  ok(re.resets === 0 && re.same, "a fresh process loads it and folds a full read");

  // A store that does not match its meta: the cache resets, reads in full, and
  // what it persists next names no digest from before.
  const k0 = Object.keys(m3.segs)[0];
  const body = JSON.parse(store.docs.get(k0)); body.rows[2] += 1; store.docs.set(k0, JSON.stringify(body));
  const c2 = newSmall(store);
  latest += 3;
  const r2 = await smallScan(c2, latest);
  ok(r2.mode === "full" && c2.stats().resets === 1, "a segment that does not match the meta resets the cache");
  await c2.persist();
  ok(consistent(store) === "ok", "and the meta written after it matches the store");
  re = await reloads(store, latest + 1);
  ok(re.resets === 0 && re.same, "a fresh process loads it and folds a full read");

  // The cursor falls out of the window (a long idle): reset, then consistent.
  latest += 2 * SPAN;
  const r3 = await smallScan(c2, latest);
  await c2.persist();
  ok(r3.mode === "full" && consistent(store) === "ok", "a cursor older than the window resets, and the meta matches the store");
  ok([...store.docs.keys()].filter((k) => k !== "meta").every((k) => k in metaOf(store).segs), "no segment from before the reset is left in the store");

  // The row cap: reset, nothing named, everything deleted.
  const capStore = memStore();
  const capped = newSmall(capStore, { maxRows: 50 });
  await smallScan(capped, 1_000); await capped.persist();
  ok(capped.stats().overCap === 1 && Object.keys(metaOf(capStore).segs).length === 0 && capStore.docs.size === 1, "over the row cap: the meta names no segment and none is stored");

  // A scan while a save is in flight: the segment changed after it was
  // serialized, so it stays dirty and the next persist saves it again.
  // The save of segment 1000 is held; the scan adds head rows to it meanwhile.
  let gate = null, hold = false;
  const raceStore = memStore({ onSave: async (k) => { if (hold && k === "1000") { hold = false; await new Promise((res) => { gate = res; }); } } });
  const rc = newSmall(raceStore);
  let rl = 1_000;
  await smallScan(rc, rl); await rc.persist();
  rl += 30; await smallScan(rc, rl);
  hold = true;
  const p1 = rc.persist();
  while (!gate) await new Promise((res) => setImmediate(res));
  const rowsIn1000 = () => CHAIN.filter((t) => t.block >= 1000 && t.block <= 1099).length;
  rl += 30; await smallScan(rc, rl);
  const added = CHAIN.filter((t) => t.block > 1025 && t.block <= rl - 5).length;
  gate();
  await p1;
  ok(added > 0 && rowsIn1000() > 0, `the scan during the save added ${added} row(s) to the segment being saved`);
  await rc.persist();
  ok(consistent(raceStore) === "ok", `a scan during a save: the meta matches the store after the next persist (${consistent(raceStore)})`);
  re = await reloads(raceStore, rl + 1);
  ok(re.resets === 0 && re.mode === "incremental" && re.same, "and a fresh process loads it and folds a full read");
}

// ---- 4. state written by the earlier implementation -----------------------
{
  // Written by the earlier implementation (one cold scan of the rows below,
  // segmentBlocks 100, reorg margin 5).
  const FIXTURE = {
    "100": "{\"v\":1,\"start\":100,\"wallets\":[\"0x00000000000000000000000000000000000000a1\",\"0x00000000000000000000000000000000000000a2\"],\"payers\":[\"0x00000000000000000000000000000000000000b1\",\"0x00000000000000000000000000000000000000b2\"],\"rows\":[0,0,10000,120,3,1,-1,2500000,150,0,0,1,10000,150,1]}",
    "200": "{\"v\":1,\"start\":200,\"wallets\":[\"0x00000000000000000000000000000000000000a2\"],\"payers\":[\"0x00000000000000000000000000000000000000b1\"],\"rows\":[0,0,1000,230,7]}",
    "meta": "{\"v\":1,\"token\":\"0xusdc\",\"segmentBlocks\":100,\"cursor\":295,\"covered\":{\"0x00000000000000000000000000000000000000a1\":101,\"0x00000000000000000000000000000000000000a2\":101},\"segs\":{\"100\":{\"rows\":3,\"digest\":\"fc5e15dc80b0ed5a\"},\"200\":{\"rows\":1,\"digest\":\"7454610a28eee017\"}}}",
  };
  const FW = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2"];
  const FP = ["0x00000000000000000000000000000000000000b1", "0x00000000000000000000000000000000000000b2"];
  const rows = [
    { wallet: FW[0], payer: FP[0], micro: 10000, block: 120, logIndex: 3 },
    { wallet: FW[1], payer: null, micro: 2500000, block: 150, logIndex: 0 },
    { wallet: FW[0], payer: FP[1], micro: 10000, block: 150, logIndex: 1 },
    { wallet: FW[1], payer: FP[0], micro: 1000, block: 230, logIndex: 7 },
    { wallet: FW[0], payer: FP[0], micro: 10000, block: 298, logIndex: 2 },
  ];
  const args = { wallets: FW, start: 101, latest: 300, chunkBlocks: 1000, walletChunk: 10, pad: (w) => w, readLogs: async (a, b) => rows.filter((t) => t.block >= a && t.block <= b).map((t) => ({ ...t })) };
  const store = memStore();
  for (const [k, v] of Object.entries(FIXTURE)) store.docs.set(k, v);
  const c = C.createLogWindowCache({ store, token: "0xUSDC", segmentBlocks: 100, reorgMarginBlocks: 5 });
  const r = await c.scan(args);
  ok(r.mode === "incremental" && c.stats().resets === 0 && c.stats().rows === 4, "state written by the earlier implementation loads");
  ok(seqOf(r.transfers) === seqOf(rows), "and folds the same transfers as a full read");
  await c.persist();
  ok(store.docs.get("meta") === FIXTURE.meta && store.docs.get("100") === FIXTURE["100"] && store.docs.get("200") === FIXTURE["200"], "its meta is rewritten byte for byte, its segments untouched");
  const fresh = memStore();
  const c2 = C.createLogWindowCache({ store: fresh, token: "0xUSDC", segmentBlocks: 100, reorgMarginBlocks: 5 });
  await c2.scan(args); await c2.persist();
  ok([...Object.keys(FIXTURE)].every((k) => fresh.docs.get(k) === FIXTURE[k]) && fresh.docs.size === 3, "a cold scan now writes the same bytes the earlier implementation wrote");
}

console.log(`\n${fail ? "FAIL" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
