// The re-registration cooldowns (document re-read, re-price window, hourly
// route allowance) bound what anyone can make us fetch from one origin. They
// are kept per origin in the shared store (src/shared-limits.js), so a second
// container honours a window the first one opened. Two module instances stand
// in for two containers; in memory mode they share one store, as two
// containers share Redis. Offline: stubbed fetch, injected crawler.
process.env.X402_INDEX_CRAWL = "off";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const accepts = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", payTo: "0x9fb365E4E9385E2a39FeBAd70368267e6f571d9A", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }] };
const header = Buffer.from(JSON.stringify(accepts)).toString("base64");
let hits = 0;
const orig = globalThis.fetch;
globalThis.fetch = async () => { hits++; return new Response("{}", { status: 402, headers: { "payment-required": header, "content-type": "application/json" } }); };
const quiet = console.log; console.log = () => {};
const say = (c, m) => { console.log = quiet; ok(c, m); console.log = () => {}; };

const ORIGIN = "https://example.com";
const rows = (n) => Array.from({ length: n }, (_, i) => ({ seller: ORIGIN, route: `/v1/r${i}`, method: "GET", slug: `r${i}`, price: 0.001, paid: true, originDeclaredPrice: 0.001, networks: ["eip155:8453"], networksVerifiedAt: Date.now() - 60_000, quoteSource: "live-402", quoteObservedAt: Date.now() - 60_000 }));
const entry = () => ({ manifest: { name: "example.com" }, tools: rows(300), error: null, history: [true], fetchedAt: Date.now() });

const A = await import("../src/x402-index.js?container=a");
const B = await import("../src/x402-index.js?container=b");
let crawlsA = 0, crawlsB = 0;
try {
  A.__testSeedCache([[ORIGIN, entry()]]); B.__testSeedCache([[ORIGIN, entry()]]);
  const ra = await A.registerOrigin(ORIGIN, { crawl: async () => { crawlsA++; return null; } });
  const spentOnA = hits;
  say(ra.reverify?.routesRechecked === true && ra.reverify.documentsReread === true && crawlsA === 1, `control: A re-reads and re-checks the origin (${spentOnA} probes)`);
  hits = 0;
  const rb = await B.registerOrigin(ORIGIN, { crawl: async () => { crawlsB++; return null; } });
  say(crawlsB === 0 && rb.reverify?.documentsReread === false, "B honours the document re-read window A opened");
  say(hits === 0 && rb.reverify?.routesRechecked === false, `B honours the re-price window A opened (sent ${hits} probes)`);
  // Past the window, the hourly allowance A spent still counts on B.
  B.__shiftRecheckClocksForTest(11 * 60_000);
  A.__shiftRecheckClocksForTest(11 * 60_000);
  hits = 0;
  await A.registerOrigin(ORIGIN, { crawl: async () => null });
  B.__shiftRecheckClocksForTest(11 * 60_000);
  A.__shiftRecheckClocksForTest(11 * 60_000);
  const spentA2 = hits;
  hits = 0;
  const rb2 = await B.registerOrigin(ORIGIN, { crawl: async () => null });
  say(spentOnA + spentA2 + hits <= 240, `across both containers the origin is re-checked at most 240 routes in the hour (${spentOnA} + ${spentA2} + ${hits})`);
  say(rb2.reverify?.recheckAllowanceLeft === 0, "B reads the allowance A spent");
} finally {
  globalThis.fetch = orig;
  console.log = quiet;
  A.__resetForcedCrawlForTest(); B.__resetForcedCrawlForTest();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
