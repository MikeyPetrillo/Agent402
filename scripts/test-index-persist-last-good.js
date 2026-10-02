#!/usr/bin/env node
// A seller whose last crawl failed still holds the catalogue an earlier good
// crawl produced, and that listing must survive a restart.
//
// crawlSeller keeps the last good manifest + tools on a failure on purpose
// ("so a transient outage doesn't drop the seller from the Index"), but the
// persist skipped every errored entry, so one failed crawl before a restart
// deleted the listing outright. Measured 2026-10-02: six path sellers on one
// shared host were healthy at 09:06, their prefix documents answered 402 on
// the next crawls, the 10:26 persist wrote 4,240 origins without them, and
// after the 10:35 restart five answered "seller not found in the index" (the
// sixth came back only because the per-operator cap happened to crawl it,
// with health 0 and no history). Offline: the real register + crawl pipeline
// through the __setCrawlFetchForTest seam, then persist -> reset -> warm start.
process.env.X402_INDEX_CRAWL = "off";
const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dir = mkdtempSync(join(tmpdir(), "persist-last-good-"));
process.env.REMOVED_ORIGINS_FILE = join(dir, "removed-origins.json");
const {
  validateOriginInput, registerOrigin, sellerDetail, persistIndexCache, loadPersistedIndexCache,
  __setCrawlFetchForTest, __testResetSubmitted, __resetRobotsCacheForTest, __crawlSellerForTest, __testSeedCache,
} = await import("../src/x402-index.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const H = "https://apps.example.invalid";
const A = `${H}/app/alpha-1`;
const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "5000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x" + "a1".repeat(20), maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];

const served = new Map();
let paywalled = false;
__setCrawlFetchForTest(async (url) => {
  // The seller's later shape: a catch-all paywall answers every document 402.
  if (paywalled && !url.endsWith("/robots.txt")) throw Object.assign(new Error("Source URL returned HTTP 402 - check the URL is correct and publicly reachable"), { statusCode: 422 });
  const hit = served.get(url);
  if (!hit) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422 });
  return { html: typeof hit === "string" ? hit : JSON.stringify(hit), finalUrl: url, validators: null };
});
served.set(`${H}/robots.txt`, "User-agent: *\nAllow: /\n");
served.set(`${A}/.well-known/x402`, {
  x402Version: 2, name: "Alpha screen",
  resources: [{ resource: `${A}/api/screen`, method: "GET", description: "Screen a name.", price: "$0.005", accepts }],
});

__testResetSubmitted();
__resetRobotsCacheForTest();
const v = validateOriginInput(A, { selfOrigin: "https://agent402.tools", allowPath: true });
const r = await registerOrigin(v.origin);
ok(r.listed === true, "the path seller registers from its own manifest");

paywalled = true;
await __crawlSellerForTest(A);
const before = sellerDetail(A);
ok(before && before.error && before.toolCount === 1, "a failed crawl keeps the last good catalogue in memory (error set, 1 tool)");

// A never-worked origin: errored with nothing to show. And a healthy one, so
// the file is written either way and the assertions below are what decide.
__testSeedCache([
  ["https://dead.example.invalid", { error: "timeout", tools: [], manifest: null, history: [0] }],
  ["https://healthy.example.invalid", { error: null, manifest: { name: "ok" }, tools: [{ route: "/x", price: "$0.001" }], history: [1] }],
]);

const file = join(dir, "index-cache.json");
ok(persistIndexCache(file) === true, "persist writes the cache");
const written = JSON.parse(readFileSync(file, "utf8")).entries;
ok(written.some(([o]) => o === A), "the errored seller holding a last good catalogue is persisted");
ok(!written.some(([o]) => o === "https://dead.example.invalid"), "an errored origin with no catalogue is still not persisted");

// Restart.
__testResetSubmitted();
ok(sellerDetail(A) === null, "control: the reset empties the cache");
loadPersistedIndexCache(file);
const after = sellerDetail(A);
ok(after !== null, "after a restart the seller is still in the index");
ok(after?.toolCount === 1, "with its last good catalogue");
ok(after?.error && /402/.test(after.error), "and the error that made it unhealthy");
ok(after?.routable === false, "still unroutable: the last crawl failed");
ok(after?.health > 0 && after?.health < 1, "health carries the history across the restart");

__setCrawlFetchForTest(null);
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
