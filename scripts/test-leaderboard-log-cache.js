#!/usr/bin/env node
// The Base leaderboard's log window cache (src/leaderboard-log-cache.js).
//
// Offline: a stub Bazaar + JSON-RPC on port 0 serves one synthetic chain. Every
// cached scan is compared with a full read of the same window over the same
// chain data (the old behavior), so the published board must be identical,
// across head advances, new and returning wallets, failed reads, a restart
// from the store, a store that does not match its meta, and the switch.
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "lb-log-cache-"));
process.env.LEADERBOARD_FUNDING_SCAN = "off";
delete process.env.STATE_DATABASE_URL;
delete process.env.ALCHEMY_API_KEY;

const LB = await import("../src/leaderboard.js");
const C = await import("../src/leaderboard-log-cache.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const hex = (n) => "0x" + n.toString(16);
const addr = (prefix, i) => "0x" + prefix + i.toString(16).padStart(40 - prefix.length, "0");
const topic = (a) => "0x" + "0".repeat(24) + a.slice(2);

// ---- synthetic chain -----------------------------------------------------
// Deterministic pseudo-random, so a failure reproduces.
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const SELLERS = Array.from({ length: 450 }, (_, i) => addr("5e11", i));
const PAYERS = Array.from({ length: 300 }, (_, i) => addr("ba7e", i));
const AMOUNTS = [1000, 10_000, 50_000, 250_000, 1_000_000, 2_500_000, 30_000_000];
const LOGS = [];
for (let block = 1; block <= 40_000; block++) {
  const n = rnd() < 0.35 ? 1 + Math.floor(rnd() * 3) : 0;
  for (let li = 0; li < n; li++) {
    const to = SELLERS[Math.floor(rnd() * rnd() * SELLERS.length)];
    const from = rnd() < 0.03 ? to : PAYERS[Math.floor(rnd() * PAYERS.length)];
    const micro = AMOUNTS[Math.floor(rnd() * AMOUNTS.length)];
    LOGS.push({ address: USDC, topics: [TRANSFER, topic(from), topic(to)], data: "0x" + micro.toString(16).padStart(64, "0"), blockNumber: hex(block), logIndex: hex(li) });
  }
}
let HEAD = 20_000;
let listed = SELLERS.slice(0, 380);
let failWhen = null;           // (params) => true to fail that eth_getLogs call
const calls = [];

const srv = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith("/bazaar")) {
      const items = listed.map((w, i) => ({ resource: `https://s${i}.example/api`, accepts: [{ network: "eip155:8453", asset: USDC, payTo: w, amount: i % 3 === 0 ? "2500000" : "10000" }] }));
      return send(/offset=0/.test(req.url) ? { items, pagination: { total: items.length } } : { items: [] });
    }
    const j = JSON.parse(body || "{}");
    if (j.method === "eth_blockNumber") return send({ jsonrpc: "2.0", id: j.id, result: hex(HEAD) });
    if (j.method === "eth_getLogs") {
      const p = j.params[0];
      calls.push(p);
      if (failWhen && failWhen(p)) return send({ jsonrpc: "2.0", id: j.id, error: { code: -32000, message: "stub failure" } });
      const from = parseInt(p.fromBlock, 16), to = parseInt(p.toBlock, 16);
      const tos = new Set((p.topics[2] || []).map((t) => t.toLowerCase()));
      const out = LOGS.filter((l) => { const b = parseInt(l.blockNumber, 16); return b >= from && b <= to && b <= HEAD && tos.has(l.topics[2]); });
      return send({ jsonrpc: "2.0", id: j.id, result: out });
    }
    return send({ jsonrpc: "2.0", id: j.id, error: { code: -32601, message: "no" } });
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const SPAN = 12_000;
const opts = { bazaarUrl: `${base}/bazaar`, rpcs: [`${base}/rpc`], spanBlocks: SPAN, chunkBlocks: 1_000, walletChunk: 200, fundingScan: false };

const figures = (snap) => JSON.stringify({ board: snap.leaderboard, evidence: snap.walletEvidence, partial: !!snap.partial });
const fullRead = async () => { calls.length = 0; const s = await LB.runLeaderboard({ ...opts }); return { snap: s, calls: calls.length }; };
const cachedRead = async (cache) => { calls.length = 0; const s = await LB.runLeaderboard({ ...opts, logCache: cache }); await cache.persist(); return { snap: s, calls: calls.length }; };
const newCache = (d = dir, extra = {}) => C.createLogWindowCache({ store: C.createLogCacheStore({ prefix: "lbtest", dir: d }), token: USDC, segmentBlocks: 4_000, reorgMarginBlocks: 50, ...extra });

// Control first: the stub really holds settlements in the window, so equality
// below compares populated boards.
{
  const r = await fullRead();
  const settled = r.snap.leaderboard.reduce((s, row) => s + (row.callsSettled || 0), 0);
  ok(settled > 1000 && r.snap.leaderboard.length > 50, `control: the full read ranks a populated board (${r.snap.leaderboard.length} rows, ${settled} calls)`);
  ok(r.calls === 13 * 2, `control: a full read is one call per block chunk per wallet chunk (${r.calls})`);
}

let cache = newCache();
{
  const cold = await cachedRead(cache);
  const ref = await fullRead();
  ok(figures(cold.snap) === figures(ref.snap), "a cold cached scan publishes the same board as a full read");
  ok(cold.snap.logCacheScan?.mode === "full", "and says it was a full read");
  ok(cache.stats().cursor === HEAD - 50, `the cursor stops short of the head by the reorg margin (${cache.stats().cursor})`);
}
for (const step of [300, 1, 0, 2_400, 7]) {
  HEAD += step;
  const inc = await cachedRead(cache);
  const ref = await fullRead();
  ok(figures(inc.snap) === figures(ref.snap), `head +${step}: incremental board identical to a full read`);
  ok(inc.calls <= 2 * Math.ceil((step + 50) / 1_000) + 2, `head +${step}: ${inc.calls} call(s) instead of ${ref.calls}`);
}

// New sellers: read over the whole window once, only for them.
{
  listed = SELLERS.slice(0, 430);
  HEAD += 100;
  const inc = await cachedRead(cache);
  const ref = await fullRead();
  ok(figures(inc.snap) === figures(ref.snap), "new wallets: board identical to a full read");
  ok(inc.snap.logCacheScan.newWallets === 50, `the 50 new wallets are read over the window (${inc.snap.logCacheScan.newWallets})`);
  ok(inc.calls <= 13 + 2 + 1, `one call per block chunk for the new wallets, plus the head (${inc.calls})`);
  HEAD += 100;
  const again = await cachedRead(cache);
  ok(again.snap.logCacheScan.newWallets === 0 && again.calls <= 3, `next scan: they are covered (${again.calls} call(s))`);
}

// A wallet that leaves and comes back is not double counted.
{
  const gone = SELLERS[3];
  listed = listed.filter((w) => w !== gone);
  HEAD += 200;
  let inc = await cachedRead(cache), ref = await fullRead();
  ok(figures(inc.snap) === figures(ref.snap), "a wallet leaves the listing: identical");
  listed = [...listed, gone];
  HEAD += 200;
  inc = await cachedRead(cache); ref = await fullRead();
  ok(figures(inc.snap) === figures(ref.snap), "it comes back: identical (its old rows were dropped before its new read)");
  ok(inc.snap.logCacheScan.newWallets === 1, "and it was read again as a new wallet");
}

// A failed head read: partial like a full read with the same failure, cursor
// held, and the next scan heals.
{
  const before = cache.stats().cursor;
  HEAD += 900;
  failWhen = (p) => parseInt(p.toBlock, 16) === HEAD && p.topics[2].length === 200;
  const inc = await cachedRead(cache);
  ok(inc.snap.partial === true, "a failed head read marks the board partial");
  ok(cache.stats().cursor === before, `and holds the cursor (${cache.stats().cursor} = ${before})`);
  failWhen = null;
  HEAD += 10;
  const healed = await cachedRead(cache);
  const ref = await fullRead();
  ok(figures(healed.snap) === figures(ref.snap) && !healed.snap.partial, "the next scan re-reads from the held cursor: identical, no gap");
}

// A failed read on a COLD scan (no cursor yet): partial, nothing kept, no
// cursor set, and the next scan reads the whole window again.
{
  const coldDir = mkdtempSync(join(tmpdir(), "lb-log-cache-cold-"));
  const fresh = newCache(coldDir);
  failWhen = (p) => parseInt(p.toBlock, 16) === HEAD && p.topics[2].length === 200;
  const first = await cachedRead(fresh);
  ok(first.snap.partial === true, "a cold scan with a failed read marks the board partial");
  ok(fresh.stats().cursor === null && fresh.stats().rows === 0, `and sets no cursor and keeps nothing (cursor ${fresh.stats().cursor}, ${fresh.stats().rows} rows)`);
  failWhen = null;
  const healed = await cachedRead(fresh);
  const ref = await fullRead();
  ok(figures(healed.snap) === figures(ref.snap) && !healed.snap.partial, "the next scan reads the window again: identical, no gap");
  rmSync(coldDir, { recursive: true, force: true });
}

// A failed backfill for a new wallet batch: that batch stays uncovered and is
// read again; nothing it half-read is kept.
{
  listed = SELLERS.slice(0, 450);
  HEAD += 50;
  const fresh = new Set(SELLERS.slice(430, 450).map((w) => topic(w)));
  failWhen = (p) => p.topics[2].some((t) => fresh.has(t)) && parseInt(p.toBlock, 16) < HEAD - 2_000;
  const inc = await cachedRead(cache);
  ok(inc.snap.partial === true, "a failed backfill marks the board partial");
  failWhen = null;
  HEAD += 20;
  const again = await cachedRead(cache);
  const ref = await fullRead();
  ok(again.snap.logCacheScan.newWallets === 20, `the batch is read again (${again.snap.logCacheScan.newWallets})`);
  ok(figures(again.snap) === figures(ref.snap), "and the board is identical to a full read (no gap, no double count)");
}

// Restart: a fresh process loads the store and resumes from the cursor.
{
  HEAD += 333;
  const restarted = newCache();
  const inc = await cachedRead(restarted);
  const ref = await fullRead();
  ok(inc.snap.logCacheScan.mode === "incremental", "after a restart the cache resumes from the store");
  ok(figures(inc.snap) === figures(ref.snap), "and the board is identical to a full read");
  ok(inc.calls <= 2 * 2, `reading only the head (${inc.calls} call(s))`);
  cache = restarted;
}

// The window slides past old segments: they are deleted from the store.
{
  HEAD += 9_000;
  const inc = await cachedRead(cache);
  const ref = await fullRead();
  ok(figures(inc.snap) === figures(ref.snap), "a long slide: identical");
  const segs = readdirSync(dir).filter((f) => /^lbtest-\d+\.json$/.test(f)).map((f) => Number(f.match(/\d+/)[0]));
  ok(segs.every((s) => s + 4_000 - 1 >= HEAD - SPAN), `segments wholly older than the window are deleted (${segs.join(",")})`);
}

// A segment that does not match its meta (a save that did not land) discards
// the cache: the next scan is a full read, never a gap.
{
  const segFile = readdirSync(dir).filter((f) => /^lbtest-\d+\.json$/.test(f)).sort()[0];
  const body = JSON.parse(readFileSync(join(dir, segFile), "utf8"));
  body.rows = body.rows.slice(0, -5);
  writeFileSync(join(dir, segFile), JSON.stringify(body));
  HEAD += 40;
  const restarted = newCache();
  const inc = await cachedRead(restarted);
  const ref = await fullRead();
  ok(inc.snap.logCacheScan.mode === "full", "a segment that does not match the meta forces a full read");
  ok(figures(inc.snap) === figures(ref.snap), "and the board is identical");
  cache = restarted;
}

// Row cap: over it, the cache resets and the next scan is a full read.
{
  const tiny = newCache(mkdtempSync(join(tmpdir(), "lb-log-cap-")), { maxRows: 10 });
  await cachedRead(tiny);
  const second = await cachedRead(tiny);
  const ref = await fullRead();
  ok(second.snap.logCacheScan.mode === "full" && tiny.stats().overCap >= 1, "over the row cap the cache keeps nothing and reads in full");
  ok(figures(second.snap) === figures(ref.snap), "with the same board");
}

// The switch.
ok(C.logCacheEnabled({}) === true, "the cache is on by default");
ok(C.logCacheEnabled({ LEADERBOARD_LOG_CACHE: "off" }) === false, "LEADERBOARD_LOG_CACHE=off turns it off");
{
  process.env.LEADERBOARD_LOG_CACHE = "off";
  LB._resetLeaderboardCacheForTests();
  ok(LB.leaderboardLogCacheStatus().enabled === false, "the operator view reads the switch");
  delete process.env.LEADERBOARD_LOG_CACHE;
}

srv.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? "FAIL" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
