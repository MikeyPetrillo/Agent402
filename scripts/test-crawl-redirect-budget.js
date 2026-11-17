#!/usr/bin/env node
// A request is counted on the day of the origin whose crawl sent it
// (src/seller-load.js takeBudget `chargeTo`, src/x402-index.js probeOnce),
// driven through the real crawl with stub documents and probes:
//   * an origin whose discovery documents permanently redirect to another
//     listed seller has its price and paywall reads counted on its own day,
//     not on the day of the seller they land on;
//   * however many of those reads it causes, the seller they land on keeps
//     its own day and its own scheduled crawl still runs;
//   * every request that lands on a host through other origins' redirects
//     (a document read following the redirect, or a probe sent where the
//     documents moved) is counted on that host's landed allowance and is not
//     sent past it; the redirecting origin keeps its listing and is read
//     again the next day;
//   * fifty origins redirecting to one host, listed or not, land no more than
//     one allowance there in a day (whole cycles over three hundred such
//     origins: test-crawl-landing-turns.js);
//   * a succession marker that redirects off its origin is not followed.
// Offline: no network, no server.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/guard-dns-offline.js"; // the guard's name lookups answer here, not from the machine's resolver (see the file)
import { ownStoreEnv } from "./lib/own-stores.js";
Object.assign(process.env, ownStoreEnv("crawl-redirect-budget"));
process.env.X402_INDEX_CRAWL = "off";
const BUDGET = 20;
process.env.SELLER_PROBE_DAILY_BUDGET = String(BUDGET);
{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.REMOVED_ORIGINS_FILE = join(mkdtempSync(join(tmpdir(), "crawl-redirect-budget-")), "removed-origins.json");
}
const idx = await import("../src/x402-index.js");
const { sellerLoad } = await import("../src/seller-load.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const PAY = "0x000000000000000000000000000000000000dEaD";
const accepts = (amount) => [{ scheme: "exact", network: "eip155:8453", amount, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
const ROUTES = [["/api/one", "0.02", "20000"], ["/api/two", "0.01", "10000"]];
const B = "https://stays.example";   // a listed seller, serving its own documents
const A = "https://moved.example";   // an origin whose documents redirect to B
const DOCS = ["/.well-known/x402", "/openapi.json"];

const docs = new Map();
docs.set(`${B}/.well-known/x402`, JSON.stringify({ x402Version: 2, name: "Seller", resources: ROUTES.map(([p, usd, amt]) => ({ resource: `${B}${p}`, method: "GET", description: `Route ${p}`, price: `$${usd}`, accepts: accepts(amt) })) }));
docs.set(`${B}/openapi.json`, JSON.stringify({ openapi: "3.1.0", info: { title: "Seller" }, paths: Object.fromEntries(ROUTES.map(([p]) => [p, { get: { operationId: p.slice(5), summary: `Route ${p}` } }])) }));
// Where each origin's documents redirect (origin -> the origin they land on).
// The stub follows a redirect the way the guarded fetch does: the first
// request reaches the origin asked, the hop is put to `beforeRedirect` and is
// sent only when that returns. `sent` is every request that reached a host.
const redirects = new Map([[A, B]]);
const sent = [];
const hostOf = (u) => new URL(u).origin;
const sentTo = (o, from = 0) => sent.slice(from).filter((u) => hostOf(u) === o).length;
idx.__setCrawlFetchForTest(async (url, opts) => {
  sent.push(url);
  const to = redirects.get(hostOf(url));
  let at = url;
  if (to && DOCS.includes(new URL(url).pathname)) {
    at = `${to}${new URL(url).pathname}`;
    await opts?.beforeRedirect?.(at, url);
    sent.push(at);
  }
  const d = docs.get(at);
  if (!d) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
  return { html: d, finalUrl: at, validators: {} };
});
const probes = [];
idx.__setProbeFetchForTest(async (url, opts) => {
  probes.push(`${String(opts?.method || "GET").toUpperCase()} ${url}`);
  sent.push(url);
  const r = ROUTES.find(([p]) => new URL(url).pathname === p);
  if (!r) return new Response("{}", { status: 404 });
  return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts: accepts(r[2]) })).toString("base64") } });
});
// What a listing offers: each route with its price and networks.
const offer = (e) => JSON.stringify((e?.tools || []).map((t) => [t.method, t.route, t.price, t.networks]));
const used = async (o) => (await sellerLoad.budgetSpent(o)).used;
let mark = 0;
const landedOnB = () => sentTo(B, mark);

// B is listed first, by its own crawl.
await idx.__crawlSellerForTest(B);
const bOwn = await used(B);
ok(bOwn > 0 && bOwn < BUDGET, `the seller's own crawl is counted on its own day (${bOwn} of ${BUDGET})`);
ok(idx.crossHostRedirectAccepted(A, B), "control: a redirect to a listed, self-canonical seller is accepted");

// A's crawl: its documents land on B, and so do its price and paywall reads.
probes.length = 0;
mark = sent.length;
await idx.__crawlSellerForTest(A);
ok(idx._cacheForTests().get(A)?.redirectedTo === B, `the crawl recorded the redirect (${idx._cacheForTests().get(A)?.redirectedTo})`);
const first = landedOnB();
ok(first > 0 && probes.some((p) => hostOf(p.split(" ")[1]) === B) && first > probes.length, `control: the redirecting origin's document reads and probes land on the other seller's host (${first}, ${probes.length} of them probes)`);
ok((await used(B)) === bOwn, `they are not counted on that seller's day (${await used(B)}, was ${bOwn})`);
ok((await used(A)) >= first, `they are counted on the day of the origin being crawled (${await used(A)})`);

// However often A is read (a registration is never held back), B's own day
// stays its own, B's scheduled crawl still runs, and the reads landing on B
// through the redirect stop at a day's allowance.
const listedA = offer(idx._cacheForTests().get(A));
for (let i = 0; i < 3 * BUDGET; i++) await idx.__crawlSellerForTest(A, { forcePaywall: true });
{
  const a = idx._cacheForTests().get(A);
  ok(!a.error && a.history.at(-1) === 1 && !a.readIncomplete && a.tools.length === ROUTES.length && offer(a) === listedA, "the redirecting origin keeps its listing, every route priced as before");
  const why = await idx.__crawlScheduledForTest(A);
  ok((await sellerLoad.landingSpent(B, A)) && (why === "landing" || why === "budget"), `and its scheduled crawl waits (${why})`);
  const before = sent.length;
  await idx.__crawlScheduledForTest(A);
  ok(sent.length === before, "a waiting origin's turn sends nothing to either host");
}
ok((await used(B)) === bOwn, `after ${3 * BUDGET} more reads of the redirecting origin the seller's day is unchanged (${await used(B)})`);
ok((await sellerLoad.hold(B)) === null, `the seller is not held (${await sellerLoad.hold(B)})`);
const plan = await sellerLoad.crawlPlan(B);
ok(plan.skip !== "budget", `its scheduled crawl is not skipped for a spent day (${plan.skip})`);
const landed = landedOnB();
ok((await sellerLoad.landedToday(B)) === landed, `the landings are counted apart from its day (${await sellerLoad.landedToday(B)})`);
ok(landed === BUDGET, `the requests that landed on its host through the redirect stopped at a day's allowance (${landed} of ${BUDGET})`);
{
  const before = sent.length;
  await sellerLoad.resetRevisit(B, "test");
  const skip = await idx.__crawlScheduledForTest(B);
  ok(skip === null && sentTo(B, before) > 0, `and its own scheduled crawl reads its documents (${skip}, ${sentTo(B, before)} requests)`);
  ok((await sellerLoad.landedToday(B)) === BUDGET, "its own crawl counts no landing");
}

// ---- fifty origins, one landing host ------------------------------------------
// The clock moves a day at a time; every count below is one UTC day's.
const DAY = 86_400_000;
let today = Date.now() + DAY;
sellerLoad.setClock(() => today);
const entry = (o) => idx._cacheForTests().get(o);
const N = 50;
async function fiftyOnto(target, label, { listed }) {
  const origins = Array.from({ length: N }, (_, i) => `https://${label}-${i}.example`);
  for (const o of origins) redirects.set(o, target);
  if (listed) {
    // Listing all fifty takes several days: each day's landings stop at the
    // allowance, and the origins not reached wait for the next day.
    let days = 0, worst = 0;
    while (origins.some((o) => !entry(o)?.tools?.length) && days < 60) {
      today += DAY; days++;
      const from = sent.length;
      for (const o of origins) if (!entry(o)?.tools?.length) await idx.__crawlScheduledForTest(o);
      worst = Math.max(worst, sentTo(target, from));
    }
    ok(origins.every((o) => entry(o)?.tools?.length && entry(o).redirectedTo === target), `${label}: all ${N} origins are listed from the host they redirect to, over ${days} days`);
    ok(days > 1 && worst <= BUDGET, `${label}: no day of that landed more than the allowance there (${worst} of ${BUDGET})`);
  }
  // One day, every origin asked for again and again (the cycle's turn, and a
  // registration's forced read, which no revisit wait or spent day holds back).
  today += DAY;
  const from = sent.length;
  const before = new Map(origins.map((o) => [o, JSON.stringify(entry(o) ?? null)]));
  const listing = new Map(origins.map((o) => [o, offer(entry(o))]));
  const reasons = {};
  for (let round = 0; round < 6; round++) {
    for (const o of origins) {
      await sellerLoad.resetRevisit(o, "test");
      const why = await idx.__crawlScheduledForTest(o);
      reasons[why] = (reasons[why] || 0) + 1;
      if (round % 2) await idx.__crawlSellerForTest(o, { forcePaywall: true });
    }
  }
  const landedDay = sentTo(target, from);
  ok(landedDay <= BUDGET && landedDay > 0, `${label}: ${N} origins' requests landing on one host in a day stay within the allowance (${landedDay} of ${BUDGET})`);
  ok((await sellerLoad.landedToday(target)) === landedDay, `${label}: every one of them is counted on the landed allowance (${await sellerLoad.landedToday(target)})`);
  ok((await sellerLoad.budgetSpent(target)).used === 0, `${label}: none is counted on the landing host's own day`);
  ok(reasons.landing > 0, `${label}: the origins past it wait on the landing host's allowance (${JSON.stringify(reasons)})`);
  if (listed) {
    const kept = origins.filter((o) => { const e = entry(o); return e && !e.error && e.history.at(-1) === 1 && e.tools.length === ROUTES.length && offer(e) === listing.get(o); });
    ok(kept.length === N, `${label}: every redirecting origin keeps its listing (${kept.length} of ${N})`);
    const held = origins.filter((o) => JSON.stringify(entry(o)) === before.get(o));
    ok(held.length > 0, `${label}: an origin whose reads were not sent has its entry exactly as it was (${held.length})`);
    // Its documents are known to be read from the landing host, so its
    // scheduled turn waits before any request: its own host is not asked either.
    const turn = sent.length;
    const whys = new Set();
    for (const o of held) { await sellerLoad.resetRevisit(o, "test"); whys.add(await idx.__crawlScheduledForTest(o)); }
    ok(sent.length === turn && whys.size === 1 && whys.has("landing"), `${label}: a waiting origin's scheduled turn sends nothing, to it or to the landing host (${sent.length - turn} requests, ${[...whys]})`);
  } else {
    ok(origins.every((o) => !entry(o)?.tools?.length), `${label}: control: a host that is not a listed seller lists nothing under the redirecting origins`);
  }
  return { origins, landedDay };
}

// A listed seller as the landing host.
const B2 = "https://hub.example";
for (const p of DOCS) docs.set(`${B2}${p}`, docs.get(`${B}${p}`).split(B).join(B2));
await idx.__crawlSellerForTest(B2);
ok(entry(B2)?.tools?.length === ROUTES.length, "control: the landing seller is listed by its own crawl");
const hub = await fiftyOnto(B2, "moved", { listed: true });
{
  ok((await sellerLoad.hold(B2)) === null, "the landing seller is not held by the landings");
  const from = sent.length;
  await sellerLoad.resetRevisit(B2, "test");
  const skip = await idx.__crawlScheduledForTest(B2);
  ok(skip === null && sentTo(B2, from) > 0, `its own scheduled crawl still runs on that day (${skip}, ${sentTo(B2, from)} requests)`);
  ok((await sellerLoad.landedToday(B2)) === hub.landedDay, "and is not counted as a landing");
  // The router's request before a purchase is never held by landings.
  const r = await sellerLoad.takeBudget(`${B2}/api/one`, "router-probe", { essential: true });
  ok(r.ok === true, "the router's request before a purchase goes through");
  // The next day the waiting origins are read again.
  today += DAY;
  const next = sent.length;
  await sellerLoad.resetRevisit(hub.origins[0], "test");
  const again = await idx.__crawlScheduledForTest(hub.origins[0]);
  ok(again === null && sentTo(B2, next) > 0, `the next day a waiting origin is read again (${again})`);
}

// A host that is not a listed seller: every document read lands there and is
// refused as another host's document, and the landings are bounded the same way.
const U = "https://elsewhere.example";
for (const p of DOCS) docs.set(`${U}${p}`, docs.get(`${B}${p}`).split(B).join(U));
await fiftyOnto(U, "stray", { listed: false });

// ---- the guarded fetch itself ---------------------------------------------------
// The crawl's real read (no crawl stub): only the network is stubbed. A hop is
// put to the check before it is sent, and is not sent once the landing host's
// allowance is spent.
{
  const R = "https://relay.example", T = "https://target.example";
  const Q = "https://rules.example";   // serves its own documents; its robots.txt redirects to T
  for (const p of DOCS) docs.set(`${T}${p}`, docs.get(`${B}${p}`).split(B).join(T));
  for (const p of DOCS) docs.set(`${Q}${p}`, docs.get(`${B}${p}`).split(B).join(Q));
  idx.__setCrawlFetchForTest(null);
  const wire = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    wire.push({ url: u, redirect: init?.redirect });
    const respond = (body, status, headers) => { const r = new Response(body, { status, headers }); Object.defineProperty(r, "url", { value: u }); return r; };
    if (hostOf(u) === R && DOCS.includes(new URL(u).pathname)) return respond(null, 301, { location: `${T}${new URL(u).pathname}` });
    if (u === `${Q}/robots.txt`) return respond(null, 301, { location: `${T}/robots.txt` });
    const d = docs.get(u);
    return d ? respond(d, 200, { "content-type": "application/json" }) : respond("no", 404, {});
  };
  try {
    today += DAY;
    await idx.__crawlSellerForTest(T);
    ok(entry(T)?.tools?.length === ROUTES.length, "control: the target is listed by its own crawl through the guarded fetch");
    wire.length = 0;
    await idx.__crawlSellerForTest(R);
    const hops = wire.filter((w) => hostOf(w.url) === T);
    ok(entry(R)?.redirectedTo === T && hops.length >= 2, `the guarded fetch follows the redirect hop by hop (${hops.length} hops reached the target)`);
    ok(wire.every((w) => w.redirect === "manual"), "every crawler request is sent with redirects not followed by the fetch itself");
    ok((await sellerLoad.landedToday(T)) >= hops.length, `each hop is counted on the target's landed allowance (${await sellerLoad.landedToday(T)})`);
    const offered = offer(entry(R));
    for (let i = 0; i < 2 * BUDGET; i++) await idx.__crawlSellerForTest(R, { forcePaywall: true });
    ok((await sellerLoad.landedToday(T)) === BUDGET, `the landings stop at the allowance (${await sellerLoad.landedToday(T)} of ${BUDGET})`);
    const from = wire.length, sentFrom = sent.length;
    await idx.__crawlSellerForTest(R, { forcePaywall: true });
    ok(wire.slice(from).some((w) => hostOf(w.url) === R), "control: past it the origin itself is still asked");
    ok(!wire.slice(from).some((w) => hostOf(w.url) === T) && sentTo(T, sentFrom) === 0, "and no request is sent to the target");
    const e = entry(R);
    ok(!e.error && e.history.at(-1) === 1 && offer(e) === offered, "the origin keeps its listing");

    // A robots.txt that redirects there is not read either, and a crawl that
    // could not read the rules ends with nothing recorded.
    const q = await idx.__crawlSellerForTest(Q);
    ok(q?.landingHeld && !entry(Q), "an origin whose robots.txt redirects to the spent host is not listed without its rules");

    // The MPP index's document read follows a redirect the same way.
    const mpp = await import("../src/mpp-index.js");
    const MR = "https://mpp-relay.example";
    docs.set(`${T}/openapi.json`, JSON.stringify({ openapi: "3.1.0", paths: { "/paid": { get: { "x-payment-info": { amount: "0.01" } } } } }));
    const base = globalThis.fetch;
    globalThis.fetch = async (url, init) => (String(url) === `${MR}/openapi.json`
      ? (wire.push({ url: String(url), redirect: init?.redirect }), new Response(null, { status: 301, headers: { location: `${T}/openapi.json` } }))
      : base(url, init));
    const asked = [];
    const probe = async ({ url }) => { asked.push(url); return { ok: true, status: 402, url, at: Date.now(), offers: [], retryAfter: null, error: null }; };
    const at = wire.length;
    const heldBack = await mpp.verifyMppSeller(MR, { probe, fetchText: async () => ({ html: "" }) });
    ok(wire.slice(at).some((w) => w.url === `${MR}/openapi.json`) && !wire.slice(at).some((w) => hostOf(w.url) === T) && !asked.length && heldBack === null,
      "the MPP index's document read is not sent on to a host past its landed allowance, and nothing is recorded");
    today += DAY;
    const at2 = wire.length;
    await mpp.verifyMppSeller(MR, { probe, fetchText: async () => ({ html: "" }) });
    ok(wire.slice(at2).filter((w) => hostOf(w.url) === T).length === 1 && (await sellerLoad.landedToday(T)) === 1 && asked.includes(`${MR}/paid`),
      `the next day it is, counted on the landed allowance (${await sellerLoad.landedToday(T)})`);
    await idx.__crawlSellerForTest(Q);
    ok(entry(Q)?.tools?.length === ROUTES.length, "and the origin whose rules could not be read is read and listed");

    // A succession marker is proof only when its origin serves it: a marker
    // read that is redirected to another origin is not followed there.
    const OLD = "https://old-home.example", NEW = "https://new-home.example", OFF = "https://marker-host.example";
    const marker = idx.SUCCESSION_PATH;
    const served = new Map([[`${NEW}${marker}`, JSON.stringify({ succeeds: OLD })], [`${OLD}${marker}`, JSON.stringify({ succeededBy: NEW })]]);
    const moved = new Set();
    const under = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (new URL(u).pathname !== marker) return under(url, init);
      wire.push({ url: u, redirect: init?.redirect });
      const respond = (body, status, headers) => { const r = new Response(body, { status, headers }); Object.defineProperty(r, "url", { value: u }); return r; };
      const respondFrom = (at) => { const r = new Response(JSON.stringify({ succeededBy: NEW }), { status: 200, headers: { "content-type": "application/json" } }); Object.defineProperty(r, "url", { value: at }); return r; };
      if (hostOf(u) === OFF) return respondFrom(u);
      if (moved.has(hostOf(u))) {
        // As fetch does: a request sent with redirects followed goes on to
        // the other origin by itself; one sent "manual" gets the 302 back.
        if (init?.redirect === "manual") return respond(null, 302, { location: `${OFF}${marker}` });
        wire.push({ url: `${OFF}${marker}`, redirect: init?.redirect });
        return respondFrom(`${OFF}${marker}`);
      }
      const d = served.get(u);
      return d ? respond(d, 200, { "content-type": "application/json" }) : respond("no", 404, {});
    };
    const m0 = wire.length;
    const proved = await idx.verifySuccessionMarkers(NEW, OLD);
    ok(proved.ok === true && wire.slice(m0).length === 2, `control: markers each origin serves itself are read through the guarded fetch and prove the succession (${wire.slice(m0).length} requests)`);
    moved.add(OLD);
    const m1 = wire.length;
    const refused = await idx.verifySuccessionMarkers(NEW, OLD);
    const after = wire.slice(m1);
    ok(refused.ok === false && after.some((w) => w.url === `${OLD}${marker}`), "a marker the old origin redirects to another origin proves nothing");
    ok(!after.some((w) => hostOf(w.url) === OFF), `and the redirect is not followed: no request reaches the other origin (${after.filter((w) => hostOf(w.url) === OFF).length})`);
  } finally { globalThis.fetch = realFetch; }
}

console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
