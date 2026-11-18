// Seller reputation (src/seller-reputation.js, /api/reputation, the
// reputation block on /api/index?seller=, the seller card on a chain page).
//
// Part A, offline: the scoring math, the minimum samples (one under reads
//   not-enough-data, the minimum scores), the fold (a crawl or paywall reading
//   is recorded once; our own failed reads, a robots exclusion, a registry-only
//   record and a probe that read no verdict are left out), the window, the
//   bounds of every store, the delivery recorder's exclusions (off unless
//   enabled, outside a request, a request that is ours), and that no record
//   carries a payment, buyer or settlement count.
// Part B, a FREE_MODE boot on a seeded index and a seeded reputation file
//   (X402_INDEX_CRAWL=on with the first crawl held, so nothing is fetched):
//   the pass folds the index, /api/reputation answers scored and
//   not-enough-data sellers with public cache headers, bounded rows and
//   the partial-answer fields, refuses a missing, oversized or own-host value,
//   and answers a hostile value quickly; ?seller= and the seller card carry it.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { bootServer } from "./lib/boot-server.js";

const R = await import("../src/seller-reputation.js");
const { requestTimingMiddleware } = await import("../src/request-timing.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const day = (ms) => Math.floor(ms / DAY);

// Every key in a value, recursively.
function keysOf(v, out = []) {
  if (Array.isArray(v)) { for (const x of v) keysOf(x, out); return out; }
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); }
  return out;
}
const PRIVATE_KEY_RE = /settle|buyer|payer|wallet|volume|usd|calls30d|payers30d|netCount|fund/i;

// ---------------------------------------------------------------- A. offline
{
  // A series of n samples, ok of them passing, spread one a day back from NOW.
  const series = (ok, n, endDay = day(NOW)) => {
    const s = [];
    for (let i = n - 1; i >= 0; i--) s.push(endDay - i, i < ok ? 1 : 0, 1);
    return s;
  };

  // Scoring math and the minimum sample.
  const M = R.MIN_SAMPLES;
  let rep = R.reputationOf({ rec: { f: NOW - 40 * DAY, c: series(9, M.manifestUptime - 1), p: [], l: [] }, now: NOW });
  ok(rep.metrics.manifestUptime.status === "not-enough-data" && rep.metrics.manifestUptime.score === null && rep.metrics.manifestUptime.sampleSize === M.manifestUptime - 1,
    `one sample under the minimum reads not-enough-data with its sample size (${rep.metrics.manifestUptime.sampleSize} of ${M.manifestUptime})`);
  rep = R.reputationOf({ rec: { f: NOW - 40 * DAY, c: series(7, M.manifestUptime), p: [], l: [] }, now: NOW });
  ok(rep.metrics.manifestUptime.status === "scored" && rep.metrics.manifestUptime.score === 0.7, `at the minimum it scores ok/n (${rep.metrics.manifestUptime.score})`);
  const m = rep.metrics.manifestUptime;
  ok(typeof m.method === "string" && m.method.length > 20 && m.windowDays === 30 && m.minSampleSize === M.manifestUptime && typeof m.lastMeasuredAt === "string",
    "every metric names its method, window, minimum sample and last measurement");
  ok(rep.overall.status === "not-enough-data" && rep.overall.score === null, "no overall score while paywall uptime is unscored");

  // Overall: weighted mean over the scored components, renormalized.
  const full = {
    f: NOW - 60 * DAY, lc: NOW - 3600_000, lp: NOW - 7200_000,
    c: series(10, 10), p: series(4, 5),
    l: [day(NOW) - 4, 100, day(NOW) - 3, 300, day(NOW) - 2, 2500, day(NOW) - 1, 900, day(NOW), 4000],
    q: [4, 3, NOW - DAY],
  };
  rep = R.reputationOf({ rec: full, delivery: { d: series(1, 2) }, since: NOW - 90 * DAY, updatedAt: NOW, now: NOW });
  const W = R.OVERALL_WEIGHTS;
  const expect = (W.manifestUptime * 1 + W.paywallUptime * 0.8 + W.responsiveness * 0.6 + W.priceHonesty * 0.75) / (W.manifestUptime + W.paywallUptime + W.responsiveness + W.priceHonesty);
  ok(rep.overall.status === "scored" && Math.abs(rep.overall.score - Math.round(expect * 1000) / 1000) < 1e-9, `overall is the renormalized weighted mean of the scored components (${rep.overall.score} vs ${expect.toFixed(3)})`);
  ok(JSON.stringify(rep.overall.components) === JSON.stringify(["paywallUptime", "manifestUptime", "priceHonesty", "responsiveness"]), `an unscored component (delivery, n=2) is left out of it (${rep.overall.components})`);
  ok(rep.metrics.responsiveness.score === 0.6 && rep.metrics.responsiveness.medianMs === 900 && rep.metrics.responsiveness.thresholdMs === R.RESPONSIVE_MS, `responsiveness: share within the threshold and the median (${rep.metrics.responsiveness.score}, ${rep.metrics.responsiveness.medianMs} ms)`);
  ok(rep.metrics.priceHonesty.score === 0.75 && rep.metrics.priceHonesty.sampleSize === 4, "price honesty: matched routes over routes read");
  ok(rep.metrics.delivery.status === "not-enough-data" && rep.metrics.delivery.sampleSize === 2, "delivery under its minimum reads not-enough-data");
  ok(rep.age.firstObservedAt === new Date(NOW - 60 * DAY).toISOString() && rep.age.observedDays === 60 && rep.age.recordsSince === new Date(NOW - 90 * DAY).toISOString(), "age: first observed, days observed and when records began");
  ok(rep.metrics.manifestUptime.lastMeasuredAt === new Date(NOW - 3600_000).toISOString(), "last measured is the newest recorded crawl's own time");

  // The private count is never present, whatever the inputs carry.
  const noisy = { ...full, uniqueBuyers: 99, callsSettled: 1234, netSettled: 77, payers: ["0xabc"] };
  const served = R.reputationOf({ rec: noisy, delivery: { d: series(5, 5), buyers: 9, settled: 9 }, now: NOW });
  const leaked = keysOf(served).filter((k) => PRIVATE_KEY_RE.test(k));
  ok(leaked.length === 0, `a served record has no payment, buyer or settlement key (${leaked.join(",") || "none"})`);
  ok(!/"(uniqueBuyers|callsSettled|netSettled)"/.test(JSON.stringify(served)), "fields a stored record might carry beside it are never copied out");

  // The window: a sample older than 30 days leaves the score.
  const old = R.reputationOf({ rec: { f: NOW - 90 * DAY, c: series(0, 20, day(NOW) - 31), p: [], l: [] }, now: NOW });
  ok(old.metrics.manifestUptime.sampleSize === 0 && old.metrics.manifestUptime.status === "not-enough-data", "samples outside the window are not counted");
  const stalePrice = R.reputationOf({ rec: { q: [5, 5, NOW - 31 * DAY] }, now: NOW });
  ok(stalePrice.metrics.priceHonesty.sampleSize === 0, "a price snapshot older than the window is not counted");

  // Price matching and the per-row reading.
  ok(R.priceMatches(1000, 1000) && R.priceMatches(1005, 1000) && !R.priceMatches(1020, 1000) && !R.priceMatches(0, 1000), "a price within 1% matches; 2% does not; a zero never does");
  const row = (o) => ({ method: "GET", route: "/a", ...o });
  ok(R.rowPriceReading(row({ price: 0.01, originDeclaredPrice: 0.01, quoteObservedAt: NOW - DAY }), NOW)?.matches === true, "a live read at the listed price matches");
  ok(R.rowPriceReading(row({ price: 0.02, originDeclaredPrice: 0.01, networksVerifiedAt: NOW - DAY }), NOW)?.matches === false, "a live read at another price differs");
  ok(R.rowPriceReading(row({ price: 0.02, originDeclaredPrice: 0.01 }), NOW) === null, "a row never read live has no reading");
  ok(R.rowPriceReading(row({ price: 0.02, quoteObservedAt: NOW - DAY }), NOW) === null, "a row with no listed price has no reading");
  ok(R.rowPriceReading(row({ price: 0.01, originDeclaredPrice: 0.01, quoteObservedAt: NOW - 31 * DAY }), NOW) === null, "a read outside the window is not counted");
  ok(R.rowPriceReading(row({ price: 0.01, originDeclaredPrice: 0.01, quoteObservedAt: NOW - DAY, quoteRetiredAt: NOW }), NOW) === null, "a retired quote is not counted");
  ok(JSON.stringify(R.priceSnapshot([row({ price: 0.01, originDeclaredPrice: 0.01, quoteObservedAt: NOW - DAY }), row({ price: 0.05, originDeclaredPrice: 0.01, quoteObservedAt: NOW - 2 * DAY }), row({})], NOW)) === JSON.stringify([2, 1, NOW - DAY]), "the snapshot counts read and matched routes and the newest read");

  // The fold.
  const entry = (o) => ({ fetchedAt: NOW - 1000, error: null, originResponded: true, history: [1], tools: [], ...o });
  let rec = R.foldEntry(null, entry({}), NOW);
  rec = R.foldEntry(rec, entry({}), NOW);
  ok(R.seriesTotals(rec.c, NOW).n === 1, "the same crawl read twice is recorded once");
  rec = R.foldEntry(rec, entry({ fetchedAt: NOW - 500, error: "timeout", errorOurs: true }), NOW);
  ok(R.seriesTotals(rec.c, NOW).n === 1 && rec.lc === NOW - 500, "a read that failed on our side is not the seller's answer (not counted)");
  rec = R.foldEntry(rec, entry({ fetchedAt: NOW - 400, error: "robots", robotsBlocked: true }), NOW);
  ok(R.seriesTotals(rec.c, NOW).n === 1, "a robots.txt exclusion is not counted");
  rec = R.foldEntry(rec, entry({ fetchedAt: NOW - 300, source: "bazaar-fallback", originResponded: undefined }), NOW);
  ok(R.seriesTotals(rec.c, NOW).n === 1, "a registry-only record with no read of the origin is not counted");
  rec = R.foldEntry(rec, entry({ fetchedAt: NOW - 200, error: "HTTP 500" }), NOW);
  const t1 = R.seriesTotals(rec.c, NOW);
  ok(t1.n === 2 && t1.ok === 1, "the seller's own error counts as a failure");
  rec = R.foldEntry(rec, entry({ fetchedAt: NOW - 100, originResponded: false }), NOW);
  ok(R.seriesTotals(rec.c, NOW).n === 3 && R.seriesTotals(rec.c, NOW).ok === 1, "an origin that answered nothing counts as a failure");

  rec = R.foldEntry(rec, entry({ fetchedAt: NOW - 100, paywall: { ok: null, unknown: true, status: 0, at: NOW - 90 } }), NOW);
  ok(R.seriesTotals(rec.p, NOW).n === 0 && rec.lp === NOW - 90, "a probe that read no verdict is not counted");
  rec = R.foldEntry(rec, entry({ fetchedAt: NOW - 100, paywall: { ok: false, status: 0, at: NOW - 80 } }), NOW);
  ok(R.seriesTotals(rec.p, NOW).n === 0, "a stored failure with no status is not counted");
  rec = R.foldEntry(rec, entry({ fetchedAt: NOW - 100, paywall: { ok: true, status: 402, at: NOW - 70, ms: 123 } }), NOW);
  rec = R.foldEntry(rec, entry({ fetchedAt: NOW - 100, paywall: { ok: true, status: 402, at: NOW - 70, ms: 123 } }), NOW);
  rec = R.foldEntry(rec, entry({ fetchedAt: NOW - 100, paywall: { ok: false, status: 500, at: NOW - 60, ms: 50 } }), NOW);
  const pt = R.seriesTotals(rec.p, NOW);
  ok(pt.n === 2 && pt.ok === 1 && rec.l.length === 4 && rec.l[1] === 123 && rec.l[3] === 50, "a 402 passes, a 500 fails, each probe once, with its answer time");
  for (let i = 0; i < 80; i++) rec = R.foldEntry(rec, entry({ fetchedAt: NOW - 100, paywall: { ok: true, status: 402, at: NOW - 50 + i, ms: i } }), NOW);
  ok(rec.l.length === 60, `latencies are capped at the newest 30 (${rec.l.length / 2})`);

  // Bounds: a series never holds more than the window's days.
  let r2 = null;
  for (let d = 0; d < 120; d++) r2 = R.foldEntry(r2, entry({ fetchedAt: NOW - (120 - d) * DAY }), NOW);
  ok(r2.c.length / 3 <= 30, `a record's daily series holds at most the window (${r2.c.length / 3} days)`);
  const many = {};
  for (let i = 0; i < 50; i++) many[`https://s${i}.example`] = { s: NOW - i * 1000 };
  many["https://gone.example"] = { s: NOW - 31 * DAY };
  const kept = R.pruneSellers(many, NOW, 10);
  ok(Object.keys(kept).length === 10 && kept["https://s0.example"] && !kept["https://gone.example"], "the stored sellers are capped and a seller unseen for the window is dropped");
  const delivery = {};
  for (let i = 0; i < 100; i++) delivery[`https://d${i}.example`] = { d: [day(NOW), 1, 1], r: Object.fromEntries(Array.from({ length: 100 }, (_, k) => [`GET /r${k}`, [day(NOW), 1, 1]])) };
  process.env.SELLER_REPUTATION_MAX_DELIVERY_ORIGINS = "40";
  const merged = R.mergeDelivery(null, delivery, NOW);
  delete process.env.SELLER_REPUTATION_MAX_DELIVERY_ORIGINS;
  ok(Object.keys(merged.o).length === 40 && Object.values(merged.o).every((v) => Object.keys(v.r).length <= 64), "delivery outcomes are capped per store and per seller");
  const twice = R.mergeDelivery(R.mergeDelivery(null, { "https://a.example": { d: [day(NOW) - 1, 1, 1, day(NOW), 0, 1], r: {} } }, NOW), { "https://a.example": { d: [day(NOW), 1, 2], r: {} } }, NOW);
  ok(JSON.stringify(twice.o["https://a.example"].d) === JSON.stringify([day(NOW) - 1, 1, 1, day(NOW), 1, 3]), "merging adds per day and keeps day order");

  // The per-tool record.
  const tr = R.toolReputationOf({ method: "GET", route: "/x", price: 0.01, originDeclaredPrice: 0.01, quoteObservedAt: NOW - DAY },
    { routes: { "GET /x": series(5, 5) }, url: "https://t.example/x", now: NOW });
  ok(tr.price.status === "matches" && tr.price.listedPrice === 0.01 && tr.delivery.status === "scored" && tr.delivery.score === 1, "a tool row reads its price and its own delivery");
  const tr2 = R.toolReputationOf({ method: "POST", route: "/x" }, { routes: { "GET /x": series(5, 5) }, url: "https://t.example/x", now: NOW });
  ok(tr2.price.status === "not-measured" && tr2.delivery.sampleSize === 0, "another verb's deliveries are not this row's");

  // The delivery recorder's exclusions.
  const inRequest = (scopeExtra, fn) => new Promise((resolve) => {
    const res = new EventEmitter(); res.statusCode = 200; res.writableFinished = true; res.headersSent = true; res.locals = {};
    requestTimingMiddleware(() => "test")({ ip: "127.0.0.1" }, res, async () => {
      const { currentRequestScope } = await import("../src/request-timing.js");
      Object.assign(currentRequestScope(), scopeExtra);
      resolve(fn());
    });
  });
  R.__resetReputationForTest();
  ok(await inRequest({}, () => R.noteSellerDeliveryOutcome("https://o.example", { ok: true, url: "https://o.example/a" })) === false, "nothing is recorded while reputation is off (a CI, test or local boot)");
  R.__setReputationEnabledForTest(true);
  ok(R.noteSellerDeliveryOutcome("https://o.example", { ok: true, url: "https://o.example/a" }) === false, "nothing is recorded outside a request");
  ok(await inRequest({ isOurs: () => true }, () => R.noteSellerDeliveryOutcome("https://o.example", { ok: true, url: "https://o.example/a" })) === false, "nothing is recorded for a request that is ours (canary, heartbeat, our own wallet)");
  ok(await inRequest({ isOurs: () => false }, () => R.noteSellerDeliveryOutcome("https://o.example", { ok: false, url: "https://o.example/a", method: "post" })) === true, "an outside buyer's routed call is recorded");
  const pend = R.__pendingDeliveryForTest()["https://o.example"];
  ok(pend && pend.d[1] === 0 && pend.d[2] === 1 && pend.r["POST /a"], "it is recorded as a failure on its route");
  for (let i = 0; i < 700; i++) await inRequest({}, () => R.noteSellerDeliveryOutcome(`https://p${i}.example`, { ok: true }));
  ok(Object.keys(R.__pendingDeliveryForTest()).length <= 500, "unflushed outcomes are bounded per process");
  R.__resetReputationForTest();

  // Wiring: only the router's own purchase writes an outcome (memoizeDelivery),
  // and the paid handler marks a call that is ours.
  const buyer = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8");
  const tempo = readFileSync(new URL("../src/tempo-buyer.js", import.meta.url), "utf8");
  const sites = [...buyer.matchAll(/noteSellerDeliveryOutcome\(/g)].length + [...tempo.matchAll(/noteSellerDeliveryOutcome\(/g)].length;
  ok(sites === 3, `three write sites: the struck-failure memo and the settled deliveries on x402 and Tempo (${sites})`);
  ok(/if \(memoizeDelivery && tx\) \{[^}]*noteSellerDeliveryOutcome\(/.test(buyer) && /if \(memoizeDelivery && reference\) \{[^}]*noteSellerDeliveryOutcome\(/.test(tempo),
    "a settled delivery is recorded only on the router's own purchase");
  const fn = buyer.slice(buyer.indexOf("export function noteSellerDeliveryFailure"), buyer.indexOf("export function noteSellerDeliveryFailure") + 4000);
  ok(fn.indexOf("noteSellerDeliveryOutcome(") > fn.indexOf("(repeats - 1) % DELIVERY_SAME_INPUT_RECOUNT"), "a failure is recorded after the same-request repeat rule, as the memo counts it");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/scope\.isOurs = \(\) => callIsOurs\(req\)/.test(server), "the paid handler marks a call that is ours on its request scope");
  ok(/enabled: x402Crawl\.on && /.test(server), "reputation runs only where the production crawl runs");
}

// ---------------------------------------------------------------- B. the server
{
  const dir = mkdtempSync(join(tmpdir(), "a402-reputation-"));
  const now = Date.now();
  const today = day(now);
  const lines = [];
  const SCORED = "https://scored.example", THIN = "https://thin.example", BIG = "https://big.example";
  const mk = (origin, tools, extra = {}) => JSON.stringify([origin, { manifest: { name: origin.slice(8), homepage: origin }, tools, fetchedAt: now - 60_000, source: "manifest", error: null, history: [1, 1, 1, 1, 1], originResponded: true, ...extra }]);
  const tool = (origin, i, o = {}) => ({ seller: origin, method: "GET", route: `/api/t${i}`, slug: `t${i}`, name: `Tool ${i}`, description: "a test tool", category: "data", tags: ["data"], price: 0.001, networks: ["eip155:8453"], ...o });
  lines.push(mk(SCORED, [tool(SCORED, 0, { originDeclaredPrice: 0.001, quoteObservedAt: now - DAY }), tool(SCORED, 1, { price: 0.002, originDeclaredPrice: 0.001, quoteObservedAt: now - DAY }), tool(SCORED, 2, { originDeclaredPrice: 0.001, networksVerifiedAt: now - DAY })],
    { paywall: { ok: true, status: 402, at: now - 30_000, ms: 210, mpp: false } }));
  lines.push(mk(THIN, [tool(THIN, 0)]));
  lines.push(mk(BIG, Array.from({ length: 900 }, (_, i) => tool(BIG, i))));
  writeFileSync(join(dir, "x402-index-cache.ndjson"), [JSON.stringify({ savedAt: now, format: "ndjson-v1", origins: lines.length }), ...lines].join("\n") + "\n");
  const series = (ok, n) => { const s = []; for (let i = n - 1; i >= 0; i--) s.push(today - i, i < ok ? 1 : 0, 1); return s; };
  const repFile = join(dir, "seller-reputation.json");
  const delFile = join(dir, "seller-delivery-outcomes.json");
  writeFileSync(repFile, JSON.stringify({ v: 1, since: now - 40 * DAY, updatedAt: now - 3600_000, sellers: {
    [SCORED]: { f: now - 40 * DAY, s: now - 3600_000, lc: now - 2 * DAY, lp: now - 2 * DAY, c: series(19, 20), p: series(6, 6), l: [today - 3, 300, today - 2, 400, today - 1, 500, today, 600, today, 3000], uniqueBuyers: 42, callsSettled: 900 },
    "https://stale.example": { f: now - 90 * DAY, s: now - 35 * DAY, c: [], p: [], l: [] },
  } }));
  writeFileSync(delFile, JSON.stringify({ v: 1, o: { [SCORED]: { d: series(5, 6), r: { "GET /api/t0": series(5, 5) }, at: now } } }));
  let srv = null;
  try {
    srv = await bootServer({
      stores: "reputation",
      env: {
        FREE_MODE: "true", INDEX_CACHE_FILE: join(dir, "x402-index-cache.json"), INDEX_FIRST_CRAWL_DELAY_MS: "999999999",
        X402_INDEX_CRAWL: "on", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", STATE_DATABASE_URL: "", X402_ECONOMY_DB: join(dir, "econ.db"),
        ROUTER_WORKERS: "0", LOAD_SHED: "off", SELLER_REPUTATION_FILE: repFile, SELLER_DELIVERY_FILE: delFile, SELLER_REPUTATION_FIRST_MS: "1500",
      },
    });
  } catch (e) { ok(false, `server booted (${String(e?.message || e).slice(0, 400)})`); }
  const base = srv?.url || "http://127.0.0.1:0";
  const get = async (p) => { const r = await fetch(`${base}${p}`); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ } return { r, text, json }; };
  try {
    if (!srv) throw new Error("no server");
    ok(true, "server booted");
    let sellers = 0;
    for (let i = 0; i < 60 && sellers < 3; i++) {
      try { sellers = (await (await fetch(`${base}/api/index?limit=1`)).json()).sellerCount || 0; } catch { /* warming */ }
      if (sellers < 3) await sleep(500);
    }
    ok(sellers >= 3, `the index warm-started with the seeded sellers (${sellers})`);
    // The pass runs once after SELLER_REPUTATION_FIRST_MS and rewrites the file.
    let stored = null;
    for (let i = 0; i < 40; i++) {
      try { stored = JSON.parse(readFileSync(repFile, "utf8")); } catch { stored = null; }
      if (stored?.sellers?.[THIN]) break;
      await sleep(250);
    }
    ok(stored?.sellers?.[THIN] && stored.sellers[SCORED].lc === now - 60_000, "the pass folded every indexed seller's newest crawl into the stored record");
    ok(!stored?.sellers?.["https://stale.example"], "a seller unseen for the window left the stored record");
    ok(stored?.sellers?.[SCORED]?.lp === now - 30_000 && stored.sellers[SCORED].l.includes(210), "the paywall reading and its answer time were folded once");

    const a = await get(`/api/reputation?seller=scored.example`);
    const rep = a.json?.reputation;
    ok(a.r.status === 200 && /public/.test(a.r.headers.get("cache-control") || "") && /max-age=300/.test(a.r.headers.get("cache-control") || ""), `200 with a public cache header (${a.r.headers.get("cache-control")})`);
    ok(rep?.metrics?.manifestUptime?.status === "scored" && rep.metrics.manifestUptime.sampleSize === 21, `a seller past every minimum is scored (manifest n=${rep?.metrics?.manifestUptime?.sampleSize})`);
    ok(rep?.metrics?.paywallUptime?.status === "scored" && rep?.metrics?.delivery?.status === "scored" && rep.metrics.delivery.score === 0.833, `paywall and delivery scored (delivery ${rep?.metrics?.delivery?.score})`);
    ok(rep?.metrics?.priceHonesty?.status === "scored" && rep.metrics.priceHonesty.sampleSize === 3 && rep.metrics.priceHonesty.score === 0.667, `price honesty read from the live index (${rep?.metrics?.priceHonesty?.score})`);
    ok(rep?.overall?.status === "scored" && rep.overall.score > 0 && rep.overall.score <= 1, `overall scored (${rep?.overall?.score})`);
    ok(rep?.recordState === "ready" && typeof rep?.methodDoc === "string" && /wiki\/Seller-Reputation$/.test(rep.methodDoc), "the record names its state and its method document");
    const leaked = keysOf(a.json).filter((k) => PRIVATE_KEY_RE.test(k));
    ok(leaked.length === 0 && !/uniqueBuyers|callsSettled/.test(a.text), `no payment, buyer or settlement count on the answer, though the stored record carried two (${leaked.join(",") || "none"})`);
    const t0 = a.json?.tools?.find((t) => t.route === "/api/t0");
    const t1 = a.json?.tools?.find((t) => t.route === "/api/t1");
    ok(t0?.reputation?.delivery?.status === "scored" && t0.reputation.price.status === "matches" && t1?.reputation?.price?.status === "differs", "per-route rows carry their own delivery and price reading");
    ok(a.json?.complete === true && a.json?.returned === 3 && a.json?.matched === 3, "a whole tool list says it is complete");

    const thin = await get(`/api/reputation?seller=https://thin.example/`);
    ok(thin.r.status === 200 && thin.json?.reputation?.overall?.status === "not-enough-data" && thin.json.reputation.metrics.manifestUptime.sampleSize === 1, "a seller with one crawl reads not-enough-data with its sample size");

    const big = await get(`/api/reputation?seller=big.example`);
    ok(big.r.status === 200 && big.json?.tools?.length === 200 && big.json.truncated === true && big.json.complete === false && big.json.matched === 900 && big.json.returned === 200,
      `a long tool list is capped and says so (${big.json?.returned} of ${big.json?.matched})`);
    ok(big.text.length < 120_000, `the capped answer stays bounded (${big.text.length} bytes)`);

    const missing = await get(`/api/reputation`);
    const arr = await get(`/api/reputation?seller=a.example&seller=b.example`);
    const long = await get(`/api/reputation?seller=${"a".repeat(600)}.example`);
    const self = await get(`/api/reputation?seller=agent402.tools`);
    const unknown = await get(`/api/reputation?seller=nobody.example`);
    ok(missing.r.status === 400 && arr.r.status === 400 && long.r.status === 400, `a missing, repeated or oversized value is refused (${missing.r.status}, ${arr.r.status}, ${long.r.status})`);
    ok(self.r.status === 404 && /does not score its own host/.test(self.json?.error || ""), "this server's own host is not scored");
    ok(unknown.r.status === 404 && unknown.json?.indexing === false, "an unknown seller is a 404 that names the index state");
    const hostile = ["a.".repeat(255), `https://${"x".repeat(500)}`, "%".repeat(500), `${"/".repeat(500)}`, "\u0000".repeat(200)];
    const tH = Date.now();
    const answers = await Promise.all(hostile.map((v) => fetch(`${base}/api/reputation?seller=${encodeURIComponent(v)}`).then((r) => r.status)));
    ok(answers.every((s) => s === 400 || s === 404) && Date.now() - tH < 3000, `hostile values answer 400 or 404 quickly (${answers.join(",")}, ${Date.now() - tH} ms)`);

    const detail = await get(`/api/index?seller=scored.example`);
    ok(detail.json?.reputation?.overall?.status === "scored" && typeof detail.json?.toolReputationLegend === "string", "?seller= carries the seller's reputation and the per-route legend");
    ok(detail.json?.tools?.every((t) => t.reputation && t.reputation.price && t.reputation.delivery && !("method" in t.reputation.delivery)), "each ?seller= row carries a compact reputation (its method in the legend)");
    ok(keysOf(detail.json?.reputation).filter((k) => PRIVATE_KEY_RE.test(k)).length === 0, "the ?seller= reputation block has no payment, buyer or settlement key");

    const page = await get(`/base?seller=scored.example`);
    ok(page.r.status === 200 && page.text.includes('id="seller-reputation"') && page.text.includes("/api/reputation?seller=scored.example") && /overall \d+%/.test(page.text), "the seller card shows the reputation line with a link to the data");
    const thinPage = await get(`/base?seller=thin.example`);
    ok(thinPage.text.includes("overall: not enough data"), "a thin seller's card says not enough data");

    const llms = await get(`/llms.txt`);
    ok(llms.text.includes("/api/reputation?seller="), "llms.txt names /api/reputation");
    const oa = await get(`/openapi.json`);
    ok(oa.json?.paths?.["/api/reputation"]?.get?.security?.length === 0, "openapi documents GET /api/reputation as free");
  } catch (e) {
    ok(false, `server part ran to the end (${String(e?.message || e).slice(0, 200)})`);
  } finally {
    await srv?.stop();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
