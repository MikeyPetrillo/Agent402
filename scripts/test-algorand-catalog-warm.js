// The Algorand seller catalog (src/algorand-sellers.js) after a deploy.
//
// The router was the catalog's only caller, so the first Algorand
// route-execute call after a deploy waited on the whole facilitator build and
// answered our own 504 when the payment's budget ran out. Offline, with the
// facilitator stubbed:
//   1. paging: each listing is read by the page size it returns (the
//      facilitator answers 100 rows whatever `limit` asks) until
//      pagination.total, and never past the page cap on a hostile total;
//   2. the background build (boot warm-up, scheduled refresh) reads with its
//      own longer per-read limit; a build a buyer waits on keeps the short one;
//   3. a cold catalog is waited on only for the time given, and route-execute
//      answers at once, uncharged, 503 with a Retry-After, never a 504;
//   4. the warm-up fills the cache, so the next caller does not wait;
//   5. a booted server warms the catalog in the background: /health answers
//      while the facilitator read is still held open.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { bootServer } from "./lib/boot-server.js";

let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log(`ok - ${name}`); } else { failed++; console.log(`FAIL - ${name}`); } };

const sellers = await import("../src/algorand-sellers.js");
const { buildRouteExecuteTool, CATALOG_WAIT_RESERVE_MS, CATALOG_WARMING_RETRY_AFTER_S } = await import("../src/tools/route-execute.js");
const { isCatalogWarming, isUpstreamOutage, isEdgeTimeout, isThrottle, outcomeOf, nextStep } = await import("./avm-canary-classify.js");

const USDC_ASA = "31566704";
const ADDR = "A".repeat(58);
const resourceRow = (i) => ({ merchantId: `m${i % 7}`, resourceUrl: `https://s${i}.example/price`, method: "GET", description: `price check ${i}`, accepts: [{ scheme: "exact", asset: USDC_ASA, amount: "5000", payTo: ADDR }] });
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
// A facilitator that answers at most 100 rows a page whatever `limit` asks.
function facilitator({ total = 2805, merchants = 7, hold = null } = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    calls.push({ path: u.pathname, offset: Number(u.searchParams.get("offset")), limit: Number(u.searchParams.get("limit")) });
    if (hold) await hold(u, init);
    const offset = Number(u.searchParams.get("offset")) || 0;
    if (u.pathname === "/discovery/merchants") {
      const items = Array.from({ length: Math.max(0, Math.min(100, merchants - offset)) }, (_, k) => ({ id: `m${offset + k}`, totalVerifications: 900 }));
      return json({ items, pagination: { total: merchants, limit: 100, offset } });
    }
    if (u.pathname === "/discovery/resources") {
      const items = Array.from({ length: Math.max(0, Math.min(100, total - offset)) }, (_, k) => resourceRow(offset + k));
      return json({ items, pagination: { total, limit: 100, offset } });
    }
    throw new Error(`unexpected fetch ${u.href}`);
  };
  return { calls, fetchImpl };
}
const realFetch = globalThis.fetch;

// --- 1. paging ---------------------------------------------------------------------
{
  const pages = [];
  const read = async (path) => {
    const u = new URL(`https://f.example${path}`);
    const offset = Number(u.searchParams.get("offset"));
    pages.push(offset);
    return { items: Array.from({ length: Math.min(100, 2805 - offset) }, (_, k) => ({ id: offset + k })), pagination: { total: 2805 } };
  };
  let rows = 0;
  const r = await sellers.readListing("/discovery/resources", read, { onRows: (items) => { rows += items.length; } });
  ok(rows === 2805 && r.rows === 2805 && r.pages === 29 && !r.capped, `a 2,805-row listing served 100 a page is read whole (${rows} rows in ${r.pages} pages)`);
  ok(pages[1] === 100 && pages[28] === 2800, `each page advances by the rows the last one returned (offsets ${pages.slice(0, 3).join(",")}...${pages.at(-1)})`);
  // The defect itself: asking for more rows than the facilitator serves a
  // page (500 asked, 100 served) read the first page and stopped.
  pages.length = 0;
  let asked500 = 0;
  const r500 = await sellers.readListing("/discovery/resources", read, { pageSize: 500, onRows: (items) => { asked500 += items.length; } });
  ok(asked500 === 2805 && r500.pages === 29, `a page shorter than the one asked for does not end the listing while the total says more (${asked500} rows in ${r500.pages} pages)`);

  let hostileReads = 0;
  const hostile = async () => { hostileReads++; return { items: Array.from({ length: 100 }, (_, k) => ({ id: k })), pagination: { total: 1e12 } }; };
  const h = await sellers.readListing("/discovery/resources", hostile, { onRows: () => {}, maxPages: 12 });
  ok(hostileReads === 12 && h.capped === true, `a hostile total stops at the page cap (${hostileReads} reads, capped ${h.capped})`);
  const info = sellers.algorandCatalogBuildInfo();
  ok(info.maxPages >= 29 && info.maxPages <= 500 && info.pageSize === 100, `the default cap reads today's listing whole and stays bounded (${info.maxPages} pages of ${info.pageSize})`);

  let emptyReads = 0;
  const lying = async () => { emptyReads++; return { items: [], pagination: { total: 5000 } }; };
  await sellers.readListing("/discovery/resources", lying, { onRows: () => {} });
  ok(emptyReads === 1, "an empty page ends the listing whatever total it claims");
  let noTotalReads = 0;
  const noTotal = async (path) => { noTotalReads++; const off = Number(new URL(`https://f.example${path}`).searchParams.get("offset")); return { items: off < 150 ? Array.from({ length: Math.min(100, 150 - off) }, () => ({})) : [] }; };
  const nt = await sellers.readListing("/discovery/resources", noTotal, { onRows: () => {} });
  ok(nt.rows === 150 && noTotalReads === 2, `with no total named, a short page ends it (${nt.rows} rows, ${noTotalReads} reads)`);
  await assertRejects(() => sellers.readListing("/x", read, { onRows: () => {}, deadline: Date.now() - 1 }), "a build past its time limit stops reading");

  // Through the real build: every resource reaches the catalog.
  const fac = facilitator({ total: 250 });
  globalThis.fetch = fac.fetchImpl;
  sellers._resetForTest();
  try {
    const cat = await sellers.algorandCatalog();
    ok(cat.length === 250, `the catalog build reads every resource page (${cat.length} of 250)`);
    ok(fac.calls.filter((c) => c.path === "/discovery/resources").length === 3, "in three pages of 100");
  } finally { globalThis.fetch = realFetch; sellers._resetForTest(); }
}

// --- 2. which per-read limit each build uses ---------------------------------------
{
  const seen = [];
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => { seen.push(ms); return realTimeout.call(AbortSignal, ms); };
  const fac = facilitator({ total: 10 });
  globalThis.fetch = fac.fetchImpl;
  try {
    sellers._resetForTest();
    await sellers.warmAlgorandCatalog();
    const bg = sellers.algorandCatalogBuildInfo();
    const bgSeen = [...new Set(seen)];
    seen.length = 0;
    sellers._resetForTest();
    await sellers.algorandCatalog();
    const fg = sellers.algorandCatalogBuildInfo();
    const fgSeen = [...new Set(seen)];
    ok(bg.background === true && bgSeen.length === 1 && bgSeen[0] === bg.backgroundReadTimeoutMs && bg.backgroundReadTimeoutMs > bg.shortReadTimeoutMs,
      `the background build reads with its own longer limit (${bgSeen.join(",")} ms)`);
    ok(bg.backgroundReadTimeoutMs >= 31_000, `long enough for the measured cold merchant read (${bg.backgroundReadTimeoutMs} ms)`);
    ok(fg.background === false && fgSeen.length === 1 && fgSeen[0] === fg.shortReadTimeoutMs && fg.shortReadTimeoutMs === 15_000,
      `a build a buyer waits on keeps the short limit (${fgSeen.join(",")} ms)`);
  } finally { AbortSignal.timeout = realTimeout; globalThis.fetch = realFetch; sellers._resetForTest(); }
}

// --- 3. a cold catalog answers within the budget, uncharged ------------------------
{
  let release;
  const held = new Promise((r) => { release = r; });
  const fac = facilitator({ total: 10, hold: () => held });
  globalThis.fetch = fac.fetchImpl;
  sellers._resetForTest();
  try {
    const t0 = Date.now();
    const w = await sellers.algorandCatalogWithin(150);
    ok(w.warming === true && w.resources.length === 0 && Date.now() - t0 < 1000, `a cold catalog is waited on only for the time given (${Date.now() - t0} ms, warming)`);

    // route-execute, as an Algorand buyer would reach it. The resolver stub
    // does what the server's Algorand branch does with catalogWaitMs.
    process.env.SOR_AVM_BUDGET_MS = String(CATALOG_WAIT_RESERVE_MS + 1500);
    let waitGiven = null;
    const resolveExternal = async (_task, { chain, catalogWaitMs }) => {
      waitGiven = catalogWaitMs;
      const cat = await sellers.algorandCatalogWithin(catalogWaitMs);
      const none = [];
      Object.defineProperty(none, "__gateDrops", { value: { total: 0, byReason: cat.warming ? { catalog_warming: 1 } : {} }, enumerable: false });
      return chain === "algorand" ? none : null;
    };
    let paid = 0;
    const tool = buildRouteExecuteTool({
      getCatalog: () => ({}), tier: { slug: "route-execute-mid", execPriceUsd: 0.06, underlyingMaxUsd: 0.05 },
      resolveExternal, payExternal: async () => { paid++; throw new Error("never"); },
      externalEnabled: () => true, externalChains: () => ["algorand"],
    });
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
    const header = b64({ x402Version: 2, accepted: { network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k" }, payload: {} });
    const req = { headers: { "x-payment": header }, header: (n) => (String(n).toLowerCase() === "x-payment" ? header : undefined) };
    const t1 = Date.now();
    let err = null;
    try { await tool.handler({ task: "crypto price check", include: "external" }, req); } catch (e) { err = e; }
    const took = Date.now() - t1;
    ok(waitGiven != null && waitGiven <= 1500 && waitGiven > 1000, `the catalog wait is the payment budget less the reserve (${waitGiven} ms of ${process.env.SOR_AVM_BUDGET_MS})`);
    ok(err?.statusCode === 503 && err.retryAfter === CATALOG_WARMING_RETRY_AFTER_S, `a cold catalog answers 503 with Retry-After ${err?.retryAfter}, not 504 (${err?.statusCode})`);
    ok(took < CATALOG_WAIT_RESERVE_MS + 1500 - 4000, `inside the payment's budget with the rest of the run's reserve left (${took} ms)`);
    ok(/still loading/.test(String(err?.message)) && /Nothing was charged\./.test(String(err?.message)) && paid === 0, `uncharged, nothing paid: ${err?.message}`);
    const body = JSON.stringify({ error: err?.message });
    ok(isCatalogWarming(503, body) && !isThrottle(503, body) && !isEdgeTimeout(503), "the Algorand canary reads it as a loading seller list (not a throttle, not an edge timeout)");
    ok(nextStep(outcomeOf({ status: 503, body, elapsedMs: took })) === "retry", "and retries it once before reporting it");
    ok(!isCatalogWarming(503, "Service Unavailable") && !isCatalogWarming(504, body) && isUpstreamOutage(503, "Service Unavailable"), "an edge 503 is still an outage, never a loading list");

    // 4. The build finishes in the background: the next caller does not wait.
    release();
    await sellers.warmAlgorandCatalog();
    const w2 = await sellers.algorandCatalogWithin(0);
    ok(w2.warming === false && w2.resources.length === 10, `once built, the catalog answers at once (${w2.resources.length} rows)`);
  } finally { delete process.env.SOR_AVM_BUDGET_MS; globalThis.fetch = realFetch; sellers._resetForTest(); }
}

// --- 4. the warm-up and its schedule -------------------------------------------------
{
  const fac = facilitator({ total: 30 });
  globalThis.fetch = fac.fetchImpl;
  sellers._resetForTest();
  try {
    const stop = sellers.startAlgorandCatalogRefresh({ checkMs: 1000 });
    for (const until = Date.now() + 5000; Date.now() < until;) {
      const w = await sellers.algorandCatalogWithin(0);
      if (!w.warming && w.resources.length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const before = fac.calls.length;
    const w = await sellers.algorandCatalogWithin(0);
    ok(w.warming === false && w.resources.length === 30 && sellers.algorandCatalogBuildInfo().background === true, `the warm-up fills the cache off the request path (${w.resources.length} rows)`);
    await new Promise((r) => setTimeout(r, 1200));
    ok(fac.calls.length === before, "a fresh cache is not rebuilt by the scheduled check");
    stop();

    // A build made before our index loaded is re-read in minutes, not kept for the TTL.
    sellers._resetForTest();
    let ready = false;
    sellers.setAlgorandCrawlSources({ crawledResources: async () => [], countInbound: async () => 0, crawlReady: () => ready });
    await sellers.warmAlgorandCatalog();
    const n0 = fac.calls.length;
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60_000;
    try { await sellers.warmAlgorandCatalog(); } finally { Date.now = realNow; }
    ok(fac.calls.length > n0, "a catalog built before the index loaded is rebuilt after minutes");
    ready = true;
    await sellers.warmAlgorandCatalog();
    const n1 = fac.calls.length;
    Date.now = () => realNow() + 6 * 60_000;
    try { await sellers.warmAlgorandCatalog(); } finally { Date.now = realNow; }
    ok(fac.calls.length === n1, "one built with the index loaded keeps its TTL");
  } finally { globalThis.fetch = realFetch; sellers.setAlgorandCrawlSources({}); sellers._resetForTest(); }
}

// --- 4b. the scheduled refresh skips an idle catalog; a read brings it back ------------
{
  const fac = facilitator({ total: 250 });
  globalThis.fetch = fac.fetchImpl;
  sellers._resetForTest();
  const realNow = Date.now;
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => { const m = a.join(" "); if (m.startsWith("[algorand-sellers]")) logs.push(m); else realLog(...a); };
  let stop = () => {};
  try {
    stop = sellers.startAlgorandCatalogRefresh({ checkMs: 1000 });
    for (const until = realNow() + 5000; realNow() < until && !sellers.scheduledRefreshWanted() && sellers.algorandCatalogBuildInfo().cacheBuildStartedAt === 0;) await new Promise((r) => setTimeout(r, 20));
    ok(sellers.algorandCatalogBuildInfo().cacheBuildStartedAt > 0, "the boot warm-up builds with no read");
    ok(logs.some((m) => /read 1 merchant page\(s\) and 3 resource page\(s\)/.test(m)), `each build logs the pages it read (${logs[0] || "no log"})`);
    ok(sellers.scheduledRefreshWanted() === false, "no read since the warm-up: the scheduled check does not want a rebuild");
    // Past the TTL with no read: the timer's checks read nothing.
    Date.now = () => realNow() + 31 * 60_000;
    const idleCalls = fac.calls.length;
    await new Promise((r) => setTimeout(r, 2300));
    ok(fac.calls.length === idleCalls, `a stale catalog nobody read is not rebuilt by the schedule (${fac.calls.length - idleCalls} reads)`);
    // A router read records use and starts the build on the stale cache.
    const w = await sellers.algorandCatalogWithin(0);
    ok(w.warming === false && w.resources.length === 250, "the read is answered from the stale list at once");
    for (const until = realNow() + 5000; realNow() < until && fac.calls.length === idleCalls;) await new Promise((r) => setTimeout(r, 20));
    ok(fac.calls.length > idleCalls, "a read on a stale catalog starts the next build");
    for (const until = realNow() + 5000; realNow() < until && sellers.algorandCatalogBuildInfo().cacheBuildStartedAt < sellers.algorandCatalogBuildInfo().lastUseAt;) await new Promise((r) => setTimeout(r, 20));
    ok(sellers.scheduledRefreshWanted() === true, "a read at or after the last build's start lets the schedule rebuild next time");
    // Used, then past the TTL again: the timer rebuilds without another read.
    Date.now = () => realNow() + 62 * 60_000;
    const usedCalls = fac.calls.length;
    for (const until = realNow() + 5000; realNow() < until && fac.calls.length === usedCalls;) await new Promise((r) => setTimeout(r, 50));
    ok(fac.calls.length > usedCalls, "after a read, the scheduled check rebuilds the stale catalog");
  } finally { stop(); Date.now = realNow; console.log = realLog; globalThis.fetch = realFetch; sellers._resetForTest(); }
}

// --- 4c. the read that starts a build counts as use, even when the clock ticks between them ---
{
  const fac = facilitator({ total: 30 });
  globalThis.fetch = fac.fetchImpl;
  sellers._resetForTest();
  const realNow = Date.now;
  // Every clock read moves 1 ms on, so the read and the build start it causes
  // can never share a millisecond (a slow host's case).
  let tick = realNow();
  Date.now = () => (tick += 1);
  try {
    await sellers.algorandCatalogWithin(null);
    for (const until = realNow() + 5000; realNow() < until && sellers.algorandCatalogBuildInfo().cacheBuildStartedAt === 0;) await new Promise((r) => setTimeout(r, 10));
    const info = sellers.algorandCatalogBuildInfo();
    ok(info.cacheBuildStartedAt > 0 && info.lastUseAt === info.cacheBuildStartedAt, `a build started by a read is dated at that read (${info.lastUseAt} vs ${info.cacheBuildStartedAt})`);
    ok(sellers.scheduledRefreshWanted() === true, "with a clock that moves between the read and the build start, the read still lets the schedule rebuild next time");
  } finally { Date.now = realNow; globalThis.fetch = realFetch; sellers._resetForTest(); }
}

// --- the server wiring -----------------------------------------------------------------
{
  const srv = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const branch = srv.slice(srv.indexOf('} else if (chain === "algorand") {'), srv.indexOf('} else if (chain === "solana") {'));
  ok(/const catalog = await algorandCatalogWithin\(catalogWaitMs\);/.test(branch) && /if \(catalog\.warming\) gateDrops\.byReason\.catalog_warming = 1;/.test(branch),
    "the resolver waits on a cold catalog for catalogWaitMs only, and says when it is still loading");
  ok(/if \(avmBuyerConfigured\(\) && process\.env\.ALGORAND_SELLERS_WARM !== "off"\) \{\n\s*bootStep\("algorandCatalogRefresh", \(\) => \{ startAlgorandCatalogRefresh\(\); \}\);/.test(srv),
    "the server starts the background warm-up and refresh at boot where the Algorand router can run");
}

// --- 5. a booted server warms in the background ----------------------------------------
{
  let releaseHold;
  const hold = new Promise((r) => { releaseHold = r; });
  const seen = [];
  const stub = createServer(async (req, res) => {
    const u = new URL(req.url, "http://stub");
    seen.push(u.pathname);
    if (u.pathname === "/discovery/merchants") await hold;
    const offset = Number(u.searchParams.get("offset")) || 0;
    const total = u.pathname === "/discovery/resources" ? 3 : 1;
    const items = offset ? [] : u.pathname === "/discovery/resources" ? [0, 1, 2].map(resourceRow) : [{ id: "m0", totalVerifications: 900 }];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items, pagination: { total } }));
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  const algosdk = (await import("algosdk")).default;
  let server = null;
  try {
    server = await bootServer({
      stores: "algo-catalog-warm",
      env: {
        FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0",
        ALGORAND_UPSTREAM_BUYER_MNEMONIC: algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk),
        ALGORAND_FACILITATOR_URL: stubUrl,
      },
      timeoutMs: 90_000,
    });
    for (const until = Date.now() + 20_000; !seen.includes("/discovery/merchants") && Date.now() < until;) await new Promise((r) => setTimeout(r, 50));
    ok(seen.includes("/discovery/merchants"), "the booted server starts the catalog build without any router call");
    const h = await fetch(`${server.url}/health`, { signal: AbortSignal.timeout(5000) });
    await h.arrayBuffer();
    ok(h.status === 200 && !seen.includes("/discovery/resources"), "boot and /health never wait on the facilitator (its read is still held open)");
    releaseHold();
    for (const until = Date.now() + 20_000; !seen.includes("/discovery/resources") && Date.now() < until;) await new Promise((r) => setTimeout(r, 50));
    ok(seen.includes("/discovery/resources"), "and the build goes on to the resource listing once the facilitator answers");
  } catch (e) {
    ok(false, `boot: ${String(e?.message || e).slice(0, 400)}`);
  } finally {
    releaseHold();
    await server?.stop();
    await new Promise((r) => stub.close(r));
  }
}

async function assertRejects(fn, name) {
  try { await fn(); ok(false, name); } catch { ok(true, name); }
}

console.log(`\ntest-algorand-catalog-warm: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
