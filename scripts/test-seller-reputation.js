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
  const expect = (W.manifestUptime * 1 + W.paywallUptime * 0.8 + W.responsiveness * 0.6 + W.priceMatchesListing * 0.75) / (W.manifestUptime + W.paywallUptime + W.responsiveness + W.priceMatchesListing);
  ok(rep.overall.status === "scored" && Math.abs(rep.overall.score - Math.round(expect * 1000) / 1000) < 1e-9, `overall is the renormalized weighted mean of the scored components (${rep.overall.score} vs ${expect.toFixed(3)})`);
  ok(JSON.stringify(rep.overall.components) === JSON.stringify(["paywallUptime", "manifestUptime", "priceMatchesListing", "responsiveness"]), `an unscored component (delivery, n=2) is left out of it (${rep.overall.components})`);
  ok(rep.metrics.responsiveness.score === 0.6 && rep.metrics.responsiveness.medianMs === 900 && rep.metrics.responsiveness.thresholdMs === R.RESPONSIVE_MS, `responsiveness: share within the threshold and the median (${rep.metrics.responsiveness.score}, ${rep.metrics.responsiveness.medianMs} ms)`);
  ok(rep.metrics.priceMatchesListing.score === 0.75 && rep.metrics.priceMatchesListing.sampleSize === 4, "price matches listing: matched routes over routes read");
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
  ok(stalePrice.metrics.priceMatchesListing.sampleSize === 0, "a price snapshot older than the window is not counted");

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

// ---------------------------------------------------------------- A2. the delivery label
// Owner decision: the delivery metric is labeled "measured from purchases
// Agent402's router made for buyers" wherever it appears, is never worded as
// buyers, sales or settlements, and never feeds the router's qualification.
const LABEL = "measured from purchases Agent402's router made for buyers";
const NOT_BUYER_WORDING = /buyer|sale|settl/i;
const unlabeled = (t) => String(t).split(LABEL).join("");
{
  ok(R.DELIVERY_LABEL === LABEL, "the module's delivery label is the owner's wording");
  ok(R.METHODS.delivery.startsWith(LABEL) && !NOT_BUYER_WORDING.test(unlabeled(R.METHODS.delivery)), "the delivery method text carries the label and no buyer, sale or settlement wording");
  const legendDelivery = R.TOOL_REPUTATION_LEGEND.slice(R.TOOL_REPUTATION_LEGEND.indexOf("delivery,"), R.TOOL_REPUTATION_LEGEND.indexOf("not-enough-data below."));
  ok(legendDelivery.includes(LABEL) && !NOT_BUYER_WORDING.test(unlabeled(legendDelivery)), "the per-route legend's delivery clause carries the label and no such wording");
  ok(R.METRIC_LABELS.delivery.includes(LABEL) && !NOT_BUYER_WORDING.test(unlabeled(R.METRIC_LABELS.delivery)), "the seller card's delivery label carries it");
  const rep = R.reputationOf({ now: NOW });
  ok(rep.metrics.delivery.label === LABEL && R.toolReputationOf({ method: "GET", route: "/x" }, { now: NOW }).delivery.label === LABEL, "the delivery metric and each route's delivery carry the label as a field");
  const wiki = readFileSync(new URL("../wiki/Seller-Reputation.md", import.meta.url), "utf8");
  const row = wiki.split("\n").find((l) => l.startsWith("| `delivery` |")) || "";
  ok(row.includes(LABEL) && !NOT_BUYER_WORDING.test(unlabeled(row)), "the wiki method page's delivery row carries the label and no such wording");
  ok(wiki.replace(/\s+/g, " ").includes(`labeled "${LABEL}" wherever it appears`), "the wiki method page states the label rule");
  const seo = readFileSync(new URL("../src/seo.js", import.meta.url), "utf8");
  ok(seo.includes(`delivery (${LABEL})`), "the llms.txt line labels delivery");
  // Nothing that qualifies, ranks or pays a seller reads reputation.
  const { readdirSync } = await import("node:fs");
  const srcDir = new URL("../src/", import.meta.url);
  const importers = [];
  const walk = (dir, rel) => { for (const e of readdirSync(dir, { withFileTypes: true })) { if (e.isDirectory()) { if (e.name !== "generated") walk(new URL(`${e.name}/`, dir), `${rel}${e.name}/`); } else if (e.name.endsWith(".js") && /seller-reputation\.js["']/.test(readFileSync(new URL(e.name, dir), "utf8")) && e.name !== "seller-reputation.js") importers.push(`${rel}${e.name}`); } };
  walk(srcDir, "src/");
  ok(JSON.stringify(importers.sort()) === JSON.stringify(["src/market-page.js", "src/server.js", "src/tempo-buyer.js", "src/x402-buyer.js", "src/x402-index.js"]), `only the surfaces and the two writers import it, no dispatch, floor or ranking module (${importers.join(", ")})`);
  const buyerSrc = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8") + readFileSync(new URL("../src/tempo-buyer.js", import.meta.url), "utf8");
  ok(!/import \{[^}]*(sellerReputation|sellerDeliveryRoutes|reputationOf)[^}]*\} from "\.\/seller-reputation\.js"/.test(buyerSrc), "the buyers only write outcomes, never read a score");
  const idx = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  const detail = idx.slice(idx.indexOf("export function sellerDetail("), idx.indexOf("export function screenSellerDetailForServe("));
  const uses = (t) => (t.match(/\b(sellerReputation|sellerDeliveryRoutes|toolReputationOf)\(/g) || []).length;
  ok(uses(idx) === uses(detail) && uses(detail) === 3, "the index reads reputation only inside the ?seller= detail, never in routing or eligibility");
}

// ------------------------------------------- A2. corrections (offline)
{
  const series = (ok, n, endDay = day(NOW)) => { const s = []; for (let i = n - 1; i >= 0; i--) s.push(endDay - i, i < ok ? 1 : 0, 1); return s; };
  // The rename: the price metric is "price matches listing", in fields and labels.
  const rep0 = R.reputationOf({ rec: { f: NOW - 40 * DAY, c: [], p: [], l: [], q: [4, 3, NOW - DAY] }, now: NOW });
  ok(rep0.metrics.priceMatchesListing?.score === 0.75 && !("priceHonesty" in rep0.metrics) && R.METRIC_LABELS.priceMatchesListing === "price matches listing" && "priceMatchesListing" in R.OVERALL_WEIGHTS && "priceMatchesListing" in R.MIN_SAMPLES,
    "the price metric is priceMatchesListing in the record, the weights, the minimums and the label");

  // A day our crawl failed broadly on our side is left out of the crawl,
  // paywall and latency metrics, and named.
  const today = day(NOW);
  const rec = { f: NOW - 40 * DAY, lc: NOW - 60_000, lp: NOW - 60_000, c: series(10, 12), p: series(3, 6), l: [today - 2, 300, today - 1, 400, today, 9000, today, 9000, today - 3, 500, today - 4, 600] };
  const before = R.reputationOf({ rec, now: NOW });
  const after = R.reputationOf({ rec, now: NOW, ourSideDays: [today, today - 1] });
  ok(before.measurementIssue === null && before.metrics.manifestUptime.sampleSize === 12 && !("excludedSamples" in before.metrics.manifestUptime), "control: no issue day, every sample counted");
  ok(after.metrics.manifestUptime.sampleSize === 10 && after.metrics.manifestUptime.excludedSamples === 2 && after.metrics.manifestUptime.excludedReason === R.OUR_SIDE_ISSUE,
    `the issue days' crawl samples are left out and counted as excluded (${after.metrics.manifestUptime.sampleSize}, excluded ${after.metrics.manifestUptime.excludedSamples})`);
  ok(after.metrics.paywallUptime.sampleSize === 4 && after.metrics.paywallUptime.excludedSamples === 2, "the paywall samples of those days are left out too");
  ok(before.metrics.responsiveness.sampleSize === 6 && after.metrics.responsiveness.sampleSize === 3 && after.metrics.responsiveness.excludedSamples === 3 && after.metrics.responsiveness.status === "not-enough-data", `the latencies of those days are left out (n ${after.metrics.responsiveness.sampleSize} of ${before.metrics.responsiveness.sampleSize}, so under the minimum)`);
  ok(after.measurementIssue?.status === "measurement issue on our side" && after.measurementIssue.days.length === 2 && after.measurementIssue.days[1] === new Date(today * DAY).toISOString().slice(0, 10), "the record names the days as a measurement issue on our side");
  ok(R.reputationOf({ rec, now: NOW, ourSideDays: [today - 400, "x", null] }).measurementIssue === null, "a day outside the window, or not a day, is ignored");
  ok(after.metrics.manifestUptime.lastMeasuredAt !== new Date(rec.lc).toISOString(), "the last measurement time does not name a left-out reading");

  // Re-check requests: one accepted per seller per span, a repeat changes nothing.
  const S = "https://fix.example";
  let a1 = R.applyRecheck(null, S, NOW, 6 * 3600_000);
  ok(a1.accepted && a1.requestedAt === NOW && a1.body.rechecks[S].at === NOW, "the first request is accepted");
  const a2 = R.applyRecheck(a1.body, S, NOW + 3600_000, 6 * 3600_000);
  ok(!a2.accepted && a2.requestedAt === NOW && a2.body.rechecks[S].at === NOW && a2.nextAcceptedAt === NOW + 6 * 3600_000, "a repeat inside the span answers the scheduled request and changes nothing");
  const a3 = R.applyRecheck(a2.body, S, NOW + 6 * 3600_000, 6 * 3600_000);
  ok(a3.accepted && a3.requestedAt === NOW + 6 * 3600_000, "past the span a new request is accepted");
  let big = null;
  for (let i = 0; i < 5100; i++) big = R.applyRecheck(big?.body, `https://s${i}.example`, NOW + i, 6 * 3600_000);
  ok(Object.keys(big.body.rechecks).length === 5000 && big.body.rechecks["https://s5099.example"], "the request store keeps at most 5000, newest first");

  // The fold marks the newest crawl read after a request: lastRecheckedAt.
  const f1 = R.foldEntry(null, { fetchedAt: NOW - 1000, tools: [] }, NOW, { recheckAt: NOW - 5000 });
  const f2 = R.foldEntry(null, { fetchedAt: NOW - 9000, tools: [] }, NOW, { recheckAt: NOW - 5000 });
  ok(f1.rk === NOW - 1000 && !("rk" in f2), "a crawl read at or after the request sets rk; an older one does not");
  const shown = R.reputationOf({ rec: f1, now: NOW, recheck: { requestedAt: NOW - 5000 } });
  ok(shown.lastRecheckedAt === new Date(NOW - 1000).toISOString() && shown.recheck.status === "measured" && shown.recheck.path === "/api/reputation/recheck", "the record shows lastRecheckedAt and the request as measured");
  ok(R.reputationOf({ rec: f2, now: NOW, recheck: { requestedAt: NOW - 5000 } }).recheck.status === "scheduled" && R.reputationOf({ rec: f2, now: NOW }).lastRecheckedAt === null, "before a read it is scheduled; with no request lastRecheckedAt is null");

  // The crawl gives a requested origin one of its operator's places, never an extra one.
  const { originsDueThisCycle } = await import("../src/x402-index.js");
  const many = Array.from({ length: 12 }, (_, i) => `https://h${i}.op.example`);
  const noSlow = { slowWaiting: () => false };
  const plain = originsDueThisCycle(many, 0, 4, noSlow);
  const target = many.find((o) => !plain.includes(o));
  const pref = originsDueThisCycle(many, 0, 4, { ...noSlow, prefer: (o) => o === target });
  ok(plain.length === 4 && pref.length === 4 && pref.includes(target), `a requested origin takes one of the operator's ${pref.length} places (cap 4), not an extra one`);
  ok(originsDueThisCycle(many, 0, 4, { ...noSlow, prefer: () => true }).length === 4, "every origin requested: still the cap");
  ok(originsDueThisCycle(many, 0, 4, { slowWaiting: (o) => o === target, prefer: (o) => o === target }).every((o) => o !== target), "a slow origin's own wait still holds for a requested read");
  const idx = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  ok(/const rechecks = await recheckWantedFor\(\);/.test(idx) && /if \(oursShare >= CRAWL_OURS_SIDE_SHARE\) \{ try \{ await ourSideIssueHook\(Date\.now\(\)\);/.test(idx), "runCrawl reads the requested origins and reports a broad failure on our side");
  const srvSrc = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/setCrawlRecheckSource\(\(\) => pendingRecheckOrigins\(\)\);/.test(srvSrc) && /setOurSideIssueHook\(\(at\) => noteOurSideIssue\(at\)\);/.test(srvSrc), "the server wires both hooks where reputation starts");
  // The shared meta document: a broad failure is recorded once per day, a
  // re-check is idempotent, and the crawl's pending list carries it.
  const metaDir = mkdtempSync(join(tmpdir(), "a402-rep-meta-"));
  process.env.SELLER_REPUTATION_META_FILE = join(metaDir, "meta.json");
  R.__resetReputationForTest();
  ok(await R.noteOurSideIssue(Date.now()) && await R.noteOurSideIssue(Date.now() + 1000), "a broad failure on our side is recorded");
  const X = "https://x.example";
  const q1 = await R.requestRecheck(X), q2 = await R.requestRecheck(X);
  ok(q1.ok && q1.accepted && q2.ok && !q2.accepted && q2.requestedAt === q1.requestedAt, "requestRecheck is idempotent inside the span");
  const pend = await R.pendingRecheckOrigins();
  ok(pend instanceof Map && pend.get(X) === q1.requestedAt, "the crawl's pending list carries the request and its time");
  const shownX = R.sellerReputation(X);
  ok(shownX.recheck.status === "scheduled" && shownX.measurementIssue?.days.length === 1, "the served record shows the scheduled re-check and one issue day (recorded once)");
  const stored = JSON.parse(readFileSync(process.env.SELLER_REPUTATION_META_FILE, "utf8"));
  ok(keysOf(stored).filter((k) => PRIVATE_KEY_RE.test(k)).length === 0 && !JSON.stringify(stored).includes("127.0.0.1"), "the meta document holds no payer, buyer or caller field");
  R.__resetReputationForTest();
  delete process.env.SELLER_REPUTATION_META_FILE;
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
        ROUTER_WORKERS: "0", LOAD_SHED: "off", SELLER_REPUTATION_FILE: repFile, SELLER_DELIVERY_FILE: delFile, SELLER_REPUTATION_FIRST_MS: "1500", REPUTATION_RECHECK_PER_IP_HOUR: "4",
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
    ok(rep?.metrics?.priceMatchesListing?.status === "scored" && rep.metrics.priceMatchesListing.sampleSize === 3 && rep.metrics.priceMatchesListing.score === 0.667, `price matches listing read from the live index (${rep?.metrics?.priceMatchesListing?.score})`);
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
    // The correction path: POST /api/reputation/recheck.
    const post = async (p) => { const r = await fetch(`${base}${p}`, { method: "POST" }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ } return { r, text, json }; };
    const rc1 = await post(`/api/reputation/recheck?seller=thin.example`);
    ok(rc1.r.status === 202 && rc1.json?.accepted === true && rc1.json.seller === THIN && rc1.json.status === "scheduled" && Date.parse(rc1.json.crawlBy) > Date.parse(rc1.json.requestedAt) && Date.parse(rc1.json.recordBy) > Date.parse(rc1.json.crawlBy) && /no-store/.test(rc1.r.headers.get("cache-control") || ""),
      `a re-check is accepted: 202 with when (${rc1.r.status}, crawlBy ${rc1.json?.crawlBy})`);
    const rc2 = await post(`/api/reputation/recheck?seller=https://thin.example`);
    ok(rc2.r.status === 202 && rc2.json?.accepted === false && rc2.json.requestedAt === rc1.json.requestedAt && rc2.json.nextAcceptedAt === rc1.json.nextAcceptedAt, "a repeat inside the span answers the same scheduled request (idempotent)");
    const thinAfter = await get(`/api/reputation?seller=thin.example`);
    ok(thinAfter.json?.reputation?.recheck?.status === "scheduled" && thinAfter.json.reputation.recheck.requestedAt === rc1.json.requestedAt && thinAfter.json.reputation.lastRecheckedAt === null, "the record shows the scheduled re-check, not yet measured");
    const rcMissing = await post(`/api/reputation/recheck`);
    const rcUnknown = await post(`/api/reputation/recheck?seller=nobody.example`);
    const rcSelf = await post(`/api/reputation/recheck?seller=agent402.tools`);
    ok(rcMissing.r.status === 400 && rcUnknown.r.status === 404 && rcSelf.r.status === 404, `missing, unknown and own-host values are refused (${rcMissing.r.status}, ${rcUnknown.r.status}, ${rcSelf.r.status})`);
    const rc3 = await post(`/api/reputation/recheck?seller=scored.example`);
    const rc4 = await post(`/api/reputation/recheck?seller=big.example`);
    const rc5 = await post(`/api/reputation/recheck?seller=scored.example`);
    ok(rc3.r.status === 202 && rc4.r.status === 202 && rc5.r.status === 429 && Number(rc5.r.headers.get("retry-after")) > 0, `the per-caller limit holds (4 an hour here): ${[rc1, rc2, rc3, rc4, rc5].map((x) => x.r.status).join(",")}`);
    const pageAfter = await get(`/base?seller=thin.example`);
    ok(/last re-checked never/.test(pageAfter.text), "the seller card shows last re-checked");

    const hostile = ["a.".repeat(255), `https://${"x".repeat(500)}`, "%".repeat(500), `${"/".repeat(500)}`, "\u0000".repeat(200)];
    const tH = Date.now();
    const answers = await Promise.all(hostile.map((v) => fetch(`${base}/api/reputation?seller=${encodeURIComponent(v)}`).then((r) => r.status)));
    ok(answers.every((s) => s === 400 || s === 404) && Date.now() - tH < 3000, `hostile values answer 400 or 404 quickly (${answers.join(",")}, ${Date.now() - tH} ms)`);

    const detail = await get(`/api/index?seller=scored.example`);
    ok(detail.json?.reputation?.overall?.status === "scored" && typeof detail.json?.toolReputationLegend === "string", "?seller= carries the seller's reputation and the per-route legend");
    ok(detail.json?.tools?.every((t) => t.reputation && t.reputation.price && t.reputation.delivery && !("method" in t.reputation.delivery)), "each ?seller= row carries a compact reputation (its method in the legend)");
    ok(keysOf(detail.json?.reputation).filter((k) => PRIVATE_KEY_RE.test(k)).length === 0, "the ?seller= reputation block has no payment, buyer or settlement key");

    ok(rep?.metrics?.delivery?.label === LABEL && rep.metrics.delivery.method.startsWith(LABEL) && !NOT_BUYER_WORDING.test(unlabeled(JSON.stringify(rep.metrics.delivery))), "/api/reputation's delivery metric carries the label and no buyer, sale or settlement wording");
    ok(t0?.reputation?.delivery?.label === LABEL && a.json.toolReputationLegend.includes(LABEL), "/api/reputation's route rows and legend carry the label");
    ok(detail.json?.reputation?.metrics?.delivery?.label === LABEL && detail.json.tools.every((t) => t.reputation.delivery.label === LABEL), "?seller= carries the label on the metric and every row");
    const page = await get(`/base?seller=scored.example`);
    const line = (page.text.match(/<div id="seller-reputation"[\s\S]*?<\/div>/) || [""])[0];
    const escLabel = LABEL.replace(/'/g, "&#39;");
    ok(line.includes(`delivered (${escLabel})`), "the seller card line labels delivery");
    ok(!NOT_BUYER_WORDING.test(line.split(escLabel).join("")), "the seller card line has no other buyer, sale or settlement wording");
    ok(page.r.status === 200 && page.text.includes('id="seller-reputation"') && page.text.includes("/api/reputation?seller=scored.example") && /overall \d+%/.test(page.text), "the seller card shows the reputation line with a link to the data");
    const thinPage = await get(`/base?seller=thin.example`);
    ok(thinPage.text.includes("overall: not enough data"), "a thin seller's card says not enough data");

    const llms = await get(`/llms.txt`);
    ok(llms.text.includes("/api/reputation?seller="), "llms.txt names /api/reputation");
    const oa = await get(`/openapi.json`);
    ok(oa.json?.paths?.["/api/reputation"]?.get?.security?.length === 0, "openapi documents GET /api/reputation as free");
    ok(oa.json?.paths?.["/api/reputation/recheck"]?.post?.security?.length === 0 && oa.json.paths["/api/reputation/recheck"].post.responses["202"], "openapi documents POST /api/reputation/recheck as free, answering 202");
  } catch (e) {
    ok(false, `server part ran to the end (${String(e?.message || e).slice(0, 200)})`);
  } finally {
    await srv?.stop();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
