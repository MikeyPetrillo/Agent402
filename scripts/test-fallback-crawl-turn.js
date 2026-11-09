// A registry-fallback crawl of a seller whose registry lists far more rows
// than the per-seller tool cap keeps (77,071, the largest seen) never holds
// the event loop for its whole-list passes in one turn. The registry rows are
// read before the cap applies, so each pass (merge, the non-product filter,
// the declared stamp, the quote carry-forward, the live-quote candidate pick,
// the synthesized manifest, the paywall pick) walks every row; run back to
// back they held one turn for ~200-300 ms locally. Offline: every fetch is a
// stub that answers 404 on a later turn, as a network read would.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/loopback-only-preload.js"; // nothing here reaches a real host
import assert from "node:assert/strict";
import { bound, gapMeter, OURS_READING } from "./lib/ours-clock.js";

process.env.X402_INDEX_CRAWL = "off";
process.env.ROUTER_WORKERS = "0";
const idx = await import("../src/x402-index.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };

const ROWS = Number(process.env.FALLBACK_TURN_ROWS || 77_071);
const LIMIT = bound(Number(process.env.FALLBACK_TURN_MS || 120), 6);
console.log(`# ${ROWS} registry rows; ${LIMIT.note}`);

// Registry rows in the shape bazaarItemToTool builds and the largest seller
// carries (every row priced and described, ~390-character descriptions, a
// quality block and the USDC domain on each; one in 24 with a live quote):
// seeded, so every run builds the same rows.
const ORIGIN = "https://registry-heavy.example.invalid";
let seed = 11;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const WORDS = ["price", "token", "quote", "weather", "search", "lookup", "convert", "image", "text", "data", "wallet", "chain", "news", "stock", "workflow", "configuration", "quality", "agent", "report", "score"];
const word = () => WORDS[Math.floor(rnd() * WORDS.length)];
const prose = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(word()); return out.join(" "); };
const PAYTO = "0x" + "ab".repeat(20);
const DOMAIN = { "eip155:8453": { name: "USD Coin", version: "2", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } };
const proven = Date.now() - 3_600_000;
const rows = [];
for (let i = 0; i < ROWS; i++) {
  const route = i % 997 === 0 ? `/api/${word()}/health` : `/api/${word()}/${word()}-${word()}-${i}`;
  rows.push({
    name: `${word()} ${word()}`, slug: route.slice(1).replace(/\//g, "-"), tags: [word(), word(), word()],
    price: Math.round((0.001 + rnd() * 0.05) * 1e6) / 1e6, route, method: "POST", seller: ORIGIN,
    quality: { calls30d: 1 + (i % 9), payers30d: 1, lastCalledAt: "2026-10-30T21:29:03.014Z", payersMeasured: true },
    category: "ai", declared: false, networks: ["eip155:8453"], provenance: "bazaar", description: prose(52),
    stellarPayTo: null, algorandPayTo: null, methodInferred: true, payToByNetwork: { "eip155:8453": PAYTO }, evmDomainByNetwork: DOMAIN,
    ...(i % 24 === 0 ? { quoteSource: "live-402", liveProvenAt: proven, networksVerifiedAt: proven, payToSourceByNetwork: { "eip155:8453": "live" }, networksVerifiedMethod: "POST" } : {}),
  });
}
// The entry the crawl replaces: the last read, as stored (capped).
idx.__testSeedCache([[ORIGIN, { manifest: { name: "registry-heavy", synthesized: true }, tools: rows.map((t) => ({ ...t })), fetchedAt: proven, error: null, source: "bazaar-fallback", history: [1, 1, 1], paywall: null }]]);
idx.__testSetBazaarTools(ORIGIN, rows);
const later = () => new Promise((r) => setImmediate(r));
const notFound = async (url) => { await later(); throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422 }); };
idx.__setCrawlFetchForTest(notFound);
idx.__setProbeFetchForTest(notFound);

async function crawlTurn() {
  idx.__resetRobotsCacheForTest();
  await new Promise((r) => setTimeout(r, 30));
  const g = gapMeter(1);
  await idx.__crawlSellerForTest(ORIGIN);
  await new Promise((r) => setTimeout(r, 20));
  return g.stop();
}
// The first crawl compiles the code; the second is the one every cycle repeats.
await crawlTurn();
const r = await crawlTurn();
const v = idx.sellerEntry(ORIGIN);
ok(v?.source === "bazaar-fallback" && v.toolsCapped === true && v.toolsTotal === ROWS && v.tools.length === 5000,
  `the crawl stored the registry fallback, capped (${v?.tools?.length} of ${v?.toolsTotal}, source ${v?.source})`);
ok(r.worst < LIMIT.ms, `a ${ROWS}-row registry fallback crawl holds the loop under ${LIMIT.ms} ms per turn (longest ${r.worst.toFixed(1)} ms ${OURS_READING}, wall ${r.worstWall.toFixed(1)} ms)`);

// A small listing takes no extra turns: the threshold is the row count.
{
  const SMALL = "https://registry-light.example.invalid";
  idx.__testSetBazaarTools(SMALL, rows.slice(0, 50).map((t) => ({ ...t, seller: SMALL })));
  await idx.__crawlSellerForTest(SMALL);
  const s = idx.sellerEntry(SMALL);
  ok(s?.source === "bazaar-fallback" && s.tools.length === 50 && !s.toolsCapped, `a 50-row registry fallback is stored whole (${s?.tools?.length})`);
}
console.log(`\n${n} checks passed`);
process.exit(0);
