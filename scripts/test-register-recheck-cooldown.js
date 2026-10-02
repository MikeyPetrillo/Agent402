// A re-registration re-checks an origin's routes, but not on every call
// (2026-09-28). ignoreBudget makes every live-verified route a probe candidate
// and a successful probe clears that route's backoff, so each call to
// POST /api/index/register re-asked up to 120 routes on two or three verbs,
// and anyone may make that call about any origin. Now: one re-check per origin
// per window, an hourly route allowance per origin, and the register answer
// says what ran and when the next one is available. Offline: stubbed fetch,
// injected crawler; example.com only so the SSRF guard's DNS check resolves.
process.env.X402_INDEX_CRAWL = "off";
const { registerOrigin, __testResetSubmitted, __testSeedCache, __resetForcedCrawlForTest, __shiftRecheckClocksForTest } = await import("../src/x402-index.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const accepts = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", payTo: "0x9fb365E4E9385E2a39FeBAd70368267e6f571d9A", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }] };
const header = Buffer.from(JSON.stringify(accepts)).toString("base64");
const hits = [];
const orig = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  hits.push(`${u.host} ${String(init.method || "GET").toUpperCase()} ${u.pathname}`);
  return new Response("{}", { status: 402, headers: { "payment-required": header, "content-type": "application/json" } });
};
const quiet = console.log; console.log = () => {};
const log = (...a) => quiet(...a);
const okq = (c, m) => { console.log = quiet; ok(c, m); console.log = () => {}; };

const ORIGIN = "https://example.com";
const OTHER = "https://www.example.com";
const verifiedRows = (host, n) => Array.from({ length: n }, (_, i) => ({
  seller: host, route: `/v1/r${i}`, method: "GET", slug: `r${i}`, price: 0.001, paid: true,
  originDeclaredPrice: 0.001, networks: ["eip155:8453"], networksVerifiedAt: Date.now() - 60_000,
  quoteSource: "live-402", quoteObservedAt: Date.now() - 60_000,
}));
const entry = (host, n) => ({ manifest: { name: host }, tools: verifiedRows(host, n), error: null, history: [true], fetchedAt: Date.now() });

let crawls = 0;
const crawl = async () => { crawls++; return null; };
const routesHit = (host) => new Set(hits.filter((h) => h.startsWith(`${host} `)).map((h) => h.split(" ")[2])).size;

try {
  __testResetSubmitted(); __resetForcedCrawlForTest();
  __testSeedCache([[ORIGIN, entry("example.com", 300)], [OTHER, entry("www.example.com", 5)]]);

  // 1. A seller who fixed their listing is re-checked on the FIRST call.
  let r = await registerOrigin(ORIGIN, { crawl });
  const first = routesHit("example.com");
  okq(first > 0 && first <= 120, `control: the first re-registration re-checks the routes at once (${first} routes, within the 120 per-call cap)`);
  okq(r.listed === true && r.reverify?.routesRechecked === true && r.reverify.routesProbed === first, "and the answer says it re-checked them, with the count");
  okq(r.reverify.documentsReread === true && crawls === 1, "the documents were re-read too");

  // 2. Repeated calls inside the window cost the origin nothing.
  hits.length = 0;
  for (let i = 0; i < 4; i++) r = await registerOrigin(ORIGIN, { crawl });
  okq(hits.length === 0, `four more calls inside the window send NO probes to the origin (sent ${hits.length})`);
  okq(crawls === 1, "and re-read no documents");
  okq(r.listed === true && r.reverify.routesRechecked === false && r.reverify.nextRecheckInSeconds > 0,
    `the answer says the re-check was skipped and when the next is available (${r.reverify.nextRecheckInSeconds}s)`);
  okq(/re-checked recently/.test(r.reverify.note), "in words as well as fields");

  // Control: the window is per ORIGIN, not global - another seller is unaffected.
  const o = await registerOrigin(OTHER, { crawl });
  okq(o.reverify.routesRechecked === true && routesHit("www.example.com") === 5, "another origin re-registered in the same minute is re-checked in full");

  // 3. Once the window passes the ask is honoured again...
  hits.length = 0;
  __shiftRecheckClocksForTest(11 * 60_000);
  r = await registerOrigin(ORIGIN, { crawl });
  const second = routesHit("example.com");
  okq(second > 0 && r.reverify.routesRechecked === true, `after the window a new call re-checks again (${second} routes)`);

  // 4. ...but the origin's hourly allowance caps the total however the calls are spaced.
  hits.length = 0;
  __shiftRecheckClocksForTest(11 * 60_000);
  r = await registerOrigin(ORIGIN, { crawl });
  okq(first + second + routesHit("example.com") <= 240, `three calls spaced past the window re-check at most 240 routes in the hour (${first + second + routesHit("example.com")})`);
  okq(r.reverify.recheckAllowanceLeft === 0 && r.reverify.routesRechecked === false && /allowance/.test(r.reverify.note),
    "once the allowance is spent the answer says so");

  // 5. The allowance refills over the hour.
  hits.length = 0;
  __shiftRecheckClocksForTest(61 * 60_000);
  r = await registerOrigin(ORIGIN, { crawl });
  okq(r.reverify.routesRechecked === true && routesHit("example.com") > 0, "an hour later the origin can be re-checked again");
} finally {
  globalThis.fetch = orig;
  console.log = quiet;
  __testResetSubmitted(); __resetForcedCrawlForTest();
}

// The route: a call that fetched nothing gives back its GLOBAL slot (so calls
// about one known origin cannot use up the hour for new sellers), and the
// per-IP key folds an IPv6 address to its /64. Pinned from source.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const route = src.slice(src.indexOf('app.post("/api/index/register"'), src.indexOf("// MPP self-serve listing"));
  ok(/const ip = limiterKey\(req\.ip/.test(route), "the register route keys its per-IP limit through limiterKey (IPv6 /64)");
  ok(/!result\.reverify\.documentsReread && !result\.reverify\.routesRechecked[\s\S]{0,120}regGlobal\.splice/.test(route),
    "a re-registration that fetched nothing returns its global-cap slot");
  const { limiterKey } = await import("../src/rate-limit.js");
  ok(limiterKey("2001:db8:1:2:aaaa::1") === limiterKey("2001:db8:1:2:bbbb::9"), "two addresses in one /64 share a key");
}

log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
