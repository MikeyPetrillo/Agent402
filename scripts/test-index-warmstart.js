#!/usr/bin/env node
// Offline test: the x402 index crawl cache survives a restart.
//
// Why this exists: the index cache used to be memory-only, documented as
// "restart-tolerant by design; no persistence needed". It does self-heal, but
// re-crawling ~2,200 origins takes minutes, and for that whole window
// /marketplace, /api/index and the indexed-tool catalog render a PARTIAL
// ecosystem with nothing telling the visitor it is still filling. On a day with
// ten deploys that is most of the day — a visitor saw 569 sellers while the
// index actually held 2,169. Warm-starting from /data is the same fix the
// leaderboard already applies for the same reason.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { strict as assert } from "node:assert";
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPersistedIndexCache,
  persistIndexCache,
  indexSnapshot,
  seedList,
  mppDualStackOrigins,
} from "../src/x402-index.js";

const dir = mkdtempSync(join(tmpdir(), "a402-idx-"));
const file = join(dir, "index-cache.json");
const snapArgs = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "test" };
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log("index warm-start");

// Guards first: nothing on disk, nothing in memory.
check("load from a missing file returns 0, never throws", () => {
  assert.equal(loadPersistedIndexCache(join(dir, "nope.json")), 0);
});
check("an empty cache never overwrites a good file with nothing", () => {
  assert.equal(persistIndexCache(file), false);
});
check("a corrupt file returns 0, never throws", () => {
  writeFileSync(file, "{not json");
  assert.equal(loadPersistedIndexCache(file), 0);
});

// Round trip.
const entries = [
  ["https://seller-a.example", { manifest: { x402Version: 1 }, tools: [{ route: "/a", price: "$0.001" }, { route: "/b", price: "$0.002" }], fetchedAt: Date.now(), error: null, source: "bazaar", history: [] }],
  ["https://seller-b.example", { manifest: { x402Version: 1 }, tools: [{ route: "/c", price: "$0.01" }], fetchedAt: Date.now(), error: null, source: "crawl", history: [],
    // A probed paywall that also answered WWW-Authenticate: Payment - the live
    // signal that feeds the MPP index's x402-crawl seed.
    paywall: { ok: true, status: 402, url: "https://seller-b.example/c", at: Date.now(), mpp: true } }],
];
writeFileSync(file, JSON.stringify({ savedAt: Date.now(), entries }));

check("a cold boot serves the persisted crawl immediately", () => {
  assert.equal(loadPersistedIndexCache(file), 2);
  const sellers = indexSnapshot(snapArgs).sellers;
  // 2 warm-started + this host.
  assert.equal(sellers.length, 3);
  assert.ok(sellers.some((s) => s.origin === "https://seller-a.example"));
  assert.equal(sellers.reduce((n, s) => n + (s.toolCount || 0), 0), 3);
});

check("a second load never clobbers what the live crawl already refreshed", () => {
  assert.equal(loadPersistedIndexCache(file), 0);
});

check("warm-started origins re-enter the crawl seed list (no orphans)", () => {
  // The crawl loop only visits seeds. A warm-started cache entry whose origin
  // is in no seed set would be served forever and re-crawled never — a seller
  // who fixes their manifest stays wrong for eternity (live incident
  // 2026-07-27). registerOrigin also early-returns on cached entries, so the
  // seed set is the ONLY path back to freshness.
  const seeds = seedList();
  assert.ok(seeds.includes("https://seller-a.example"), "warm-started origin missing from the crawl seeds");
  assert.ok(seeds.includes("https://seller-b.example"), "warm-started origin missing from the crawl seeds");
});

check("persist writes the warm cache back out", () => {
  assert.equal(persistIndexCache(file), true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).entries.length, 2);
});

check("the paywall probe (with its MPP flag) survives the round trip", () => {
  // Before 2026-08-19 persist dropped `paywall`, so every deploy reset the
  // budgeted probe pass and mppDualStackOrigins() was empty for hours after
  // each boot - the MPP index's x402-crawl seed reported 0 origins.
  const written = JSON.parse(readFileSync(file, "utf8")).entries;
  const b = written.find(([o]) => o === "https://seller-b.example")[1];
  assert.equal(b.paywall?.mpp, true, "persisted entry lost paywall.mpp");
  assert.equal(b.paywall?.status, 402);
  const a = written.find(([o]) => o === "https://seller-a.example")[1];
  assert.equal(a.paywall, null, "an unprobed origin persists paywall: null, never a fake probe");
  assert.deepEqual(mppDualStackOrigins(), ["https://seller-b.example"], "warm-started MPP flag must seed the MPP index");
});

check("failed origins are not re-seeded from disk", () => {
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ savedAt: Date.now(), entries: [["https://dead.example", { error: "timeout", tools: [], manifest: null }]] }));
  loadPersistedIndexCache(bad);
  // It loads into the cache (so the crawler sees the origin), but contributes
  // no tools and no phantom seller row beyond what the crawl re-decides.
  const dead = indexSnapshot(snapArgs).sellers.find((s) => s.origin === "https://dead.example");
  assert.ok(!dead || (dead.toolCount || 0) === 0, "a dead origin must not surface as a live seller");
});

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
