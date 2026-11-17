#!/usr/bin/env node
// Three hundred origins whose documents redirect to one host share that
// host's landed allowance for the day (src/seller-load.js), which reads only
// some of them. Driven through whole crawl cycles (src/x402-index.js runCrawl)
// with stub documents and probes, at the default allowance:
//   * a crawl held at the landing host casts no vote in the cycle's tally, so
//     the share of reads that ended on our side is taken over the reads made;
//   * that crawl's turn reads "landing": the cycle counts it as waiting, not
//     as a read;
//   * the origins take their turns least recently read first
//     (landingTurns), one after another, so none is read again while another still waits
//     and the longest wait between two reads of one origin is one round;
//   * they are read one after another, so a day's allowance ends partway
//     through one origin's read, not through every read then on its way.
// Offline: no network, no server.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/guard-dns-offline.js"; // the guard's name lookups answer here, not from the machine's resolver (see the file)
import { ownStoreEnv } from "./lib/own-stores.js";
Object.assign(process.env, ownStoreEnv("crawl-landing-turns"));
process.env.X402_INDEX_CRAWL = "off";
delete process.env.SELLER_PROBE_DAILY_BUDGET;
process.env.X402_PAYWALL_PROBES_PER_CYCLE = "0";
// The cycle's seeds: the origins, the hub their documents redirect to, and
// two dozen origins our reads of which can be made to time out.
const TURNS = 300, DUSK = 24;
const HUB = "https://turnhub.example";
const turnOrigins = Array.from({ length: TURNS }, (_, i) => `https://turn-${i}.example`);
const duskOrigins = Array.from({ length: DUSK }, (_, i) => `https://dusk-${i}.example`);
process.env.X402_INDEX_SEEDS = [HUB, ...turnOrigins, ...duskOrigins].join(",");
{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.REMOVED_ORIGINS_FILE = join(mkdtempSync(join(tmpdir(), "crawl-landing-turns-")), "removed-origins.json");
}
const idx = await import("../src/x402-index.js");
const { sellerLoad, DAILY_BUDGET: BUDGET } = await import("../src/seller-load.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

// ---- the turns alone -------------------------------------------------------------
// The origins behind one landing host take one turn together, at the place
// of the first of them, least recently read first; nothing else moves.
{
  const land = new Map([["https://a.example", "https://hub.example"], ["https://b.example", "https://hub.example"], ["https://c.example", "https://hub.example"], ["https://www.own.example", "https://own.example"], ["https://lone.example", "https://solo.example"]]);
  const at = new Map([["https://a.example", 30], ["https://b.example", 10], ["https://www.own.example", 1], ["https://lone.example", 2]]);
  const due = ["https://x.example", "https://a.example", "https://www.own.example", "https://b.example", "https://lone.example", "https://c.example", "https://y.example"];
  const got = idx.landingTurns(due, { landingOf: (o) => land.get(o) || null, readAt: (o) => at.get(o) });
  ok(JSON.stringify(got) === JSON.stringify(["https://x.example", ["https://c.example", "https://b.example", "https://a.example"], "https://www.own.example", "https://lone.example", "https://y.example"]),
    `origins behind one host take one turn, never read first, then oldest read first; the others keep theirs (${JSON.stringify(got).replace(/https:\/\/|\.example/g, "")})`);
  const same = idx.landingTurns(due, { landingOf: (o) => land.get(o) || null, readAt: () => 5 });
  ok(JSON.stringify(same[1]) === JSON.stringify(["https://a.example", "https://b.example", "https://c.example"]), "origins read at the same time keep the cycle's order");
  ok(idx.landingTurns(due, { landingOf: () => null, readAt: () => 0 }) === due, "a cycle with no shared landing host is the cycle as it was");
}

// ---- whole cycles ----------------------------------------------------------------
const PAY = "0x000000000000000000000000000000000000dEaD";
const accepts = (amount) => [{ scheme: "exact", network: "eip155:8453", amount, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
const ROUTES = [["/api/one", "0.02", "20000"], ["/api/two", "0.01", "10000"]];
const DOCS = ["/.well-known/x402", "/openapi.json"];
const docs = new Map();
docs.set(`${HUB}/.well-known/x402`, JSON.stringify({ x402Version: 2, name: "Seller", resources: ROUTES.map(([p, usd, amt]) => ({ resource: `${HUB}${p}`, method: "GET", description: `Route ${p}`, price: `$${usd}`, accepts: accepts(amt) })) }));
docs.set(`${HUB}/openapi.json`, JSON.stringify({ openapi: "3.1.0", info: { title: "Seller" }, paths: Object.fromEntries(ROUTES.map(([p]) => [p, { get: { operationId: p.slice(5), summary: `Route ${p}` } }])) }));
// The stub follows a redirect the way the guarded fetch does: the first
// request reaches the origin asked, the hop is put to `beforeRedirect` and is
// sent only when that returns. `sent` is every request that reached a host.
const redirects = new Map(turnOrigins.map((o) => [o, HUB]));
const sent = [];
const hostOf = (u) => new URL(u).origin;
const sentTo = (o, from = 0) => sent.slice(from).filter((u) => hostOf(u) === o).length;
const hops = new Map();   // origin -> the document reads of its that went on to the hub
let duskOut = false;   // while true, our reads of the dusk origins time out
// Every seventh origin answers slowly, as hosts do: read side by side, a
// slow origin is still on its way when the allowance ends on faster ones.
const slow = new Set(turnOrigins.filter((_, i) => i % 7 === 3));
const pause = async (turns) => { for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r)); };
idx.__setCrawlFetchForTest(async (url, opts) => {
  if (duskOut && new URL(url).hostname.startsWith("dusk-")) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  sent.push(url);
  const to = redirects.get(hostOf(url));
  let at = url;
  if (to && DOCS.includes(new URL(url).pathname)) {
    at = `${to}${new URL(url).pathname}`;
    if (slow.has(hostOf(url))) await pause(12);
    await opts?.beforeRedirect?.(at, url);
    sent.push(at);
    hops.set(hostOf(url), (hops.get(hostOf(url)) || 0) + 1);
  }
  const d = docs.get(at);
  if (!d) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
  return { html: d, finalUrl: at, validators: {} };
});
idx.__setProbeFetchForTest(async (url) => {
  sent.push(url);
  const r = ROUTES.find(([p]) => new URL(url).pathname === p);
  if (!r) return new Response("{}", { status: 404 });
  return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts: accepts(r[2]) })).toString("base64") } });
});
const entry = (o) => idx._cacheForTests().get(o);

// One clock for the load controls and the index (an entry's fetchedAt); it
// moves a day at a time, so every count below is one UTC day's.
const DAY = 86_400_000;
let today = Date.now() + DAY;
sellerLoad.setClock(() => today);
const realNow = Date.now;
Date.now = () => today;
try {
  await idx.__crawlSellerForTest(HUB);
  ok(entry(HUB)?.tools?.length === ROUTES.length, "control: the hub is listed by its own crawl");

  // The first cycle: no origin is known to land on the hub, so each is
  // crawled; the allowance ends after some and the rest are held at the hop.
  // Our reads of the dusk origins time out in the same cycle.
  duskOut = true;
  const from = sent.length;
  const first = await idx.__runCrawlCycleForTest();
  duskOut = false;
  const listed = turnOrigins.filter((o) => entry(o)?.tools?.length);
  const held = turnOrigins.filter((o) => !entry(o));
  ok(listed.length > 0 && held.length > TURNS / 2 && listed.length + held.length === TURNS, `control: the allowance ends after ${listed.length} of ${TURNS} origins, and ${held.length} are held at the hop`);
  ok(held.every((o) => sentTo(o, from) > 0) && (await sellerLoad.landedToday(HUB)) === BUDGET, `control: each held origin was asked itself, and the hub was sent the allowance (${await sellerLoad.landedToday(HUB)} of ${BUDGET})`);
  // A held crawl's turn reads "landing": it is not among the cycle's reads.
  ok(first.skipped.landing === held.length && first.crawled === first.due - held.length, `a crawl held at the landing host is counted as waiting on it, not as a read (${first.skipped.landing} landing, ${first.crawled} read of ${first.due})`);
  // And it casts no vote in the tally: the reads that timed out on our side
  // are the same share of the cycle's reads with or without the held crawls.
  const voted = first.due - held.length;
  ok(DUSK >= 20 && first.oursShare === Number((DUSK / voted).toFixed(3)) && first.oursShare !== Number((DUSK / first.due).toFixed(3)), `a held crawl casts no vote in the cycle's tally (${DUSK} of ${voted} reads ended on our side: ${first.oursShare}; ${Number((DUSK / first.due).toFixed(3))} had the ${held.length} voted)`);

  // Day after day, two cycles a day. Each day's allowance reads some of the
  // origins; which ones is the question.
  const reads = new Map(turnOrigins.map((o) => [o, []]));
  for (const o of listed) reads.get(o).push(0);
  const count = (o) => reads.get(o).length;
  // The day each origin was last read (-1: never), and two counts of days on
  // which the order failed: an origin read while another, read less recently,
  // was left waiting; an origin on its second read while another had none.
  const last = new Map(turnOrigins.map((o) => [o, listed.includes(o) ? 0 : -1]));
  let perDayMin = Infinity, perDayMax = 0, outOfTurn = 0, cutShort = 0, twiceBeforeOnce = 0, worstLanded = 0, lateLandings = 0, day = 0, firstRoundDays = 0;
  while (day < 60 && turnOrigins.some((o) => count(o) < 4)) {
    today += DAY; day++;
    hops.clear();
    await idx.__runCrawlCycleForTest();
    const mid = sent.length;
    await idx.__runCrawlCycleForTest();
    lateLandings += sentTo(HUB, mid);
    const readToday = turnOrigins.filter((o) => entry(o)?.fetchedAt === today);
    const n = readToday.length, got = new Set(readToday);
    const newestRead = Math.max(...readToday.map((o) => last.get(o)));
    const oldestWaiting = Math.min(...turnOrigins.filter((o) => !got.has(o)).map((o) => last.get(o)));
    if (newestRead > oldestWaiting) outOfTurn++;
    cutShort = Math.max(cutShort, [...hops.keys()].filter((o) => !got.has(o)).length);
    for (const o of readToday) { reads.get(o).push(day); last.set(o, day); }
    perDayMin = Math.min(perDayMin, n); perDayMax = Math.max(perDayMax, n);
    worstLanded = Math.max(worstLanded, await sellerLoad.landedToday(HUB));
    const counts = turnOrigins.map(count);
    if (Math.min(...counts) === 0 && Math.max(...counts) > 1) twiceBeforeOnce++;
    if (!firstRoundDays && Math.min(...counts) >= 1) firstRoundDays = day;
  }
  const gaps = turnOrigins.flatMap((o) => { const r = reads.get(o); return r.slice(1).map((d, i) => d - r[i]); });
  const maxWait = Math.max(...gaps), round = Math.ceil(TURNS / perDayMin);
  console.log(`# ${TURNS} origins behind one host, ${BUDGET} landings a day: ${perDayMin}-${perDayMax} origins read a day, all read once by day ${firstRoundDays}, four times by day ${day}; longest wait between two reads ${maxWait} days`);
  ok(turnOrigins.every((o) => count(o) >= 4), `every one of the ${TURNS} origins is read, again and again (${turnOrigins.filter((o) => count(o) < 4).length} not four times in ${day} days)`);
  ok(twiceBeforeOnce === 0 && firstRoundDays > 1, `no origin is read twice before another is read once (${twiceBeforeOnce} days; the first round took ${firstRoundDays})`);
  ok(outOfTurn === 0, `and on no day is an origin read while one read less recently is left waiting (${outOfTurn} of ${day} days)`);
  // Read one after another, the allowance ends on one origin's crawl; read
  // side by side it would end on every crawl then on its way, each having
  // spent requests of the day on a read that was not finished.
  ok(cutShort <= 1, `the day's allowance ends partway through at most one origin's read (${cutShort})`);
  ok(perDayMin > 0 && maxWait <= round + 1, `the longest wait between two reads of one origin is bounded by one round (${maxWait} days; a round is ${round} days at ${perDayMin} a day)`);
  ok(worstLanded <= BUDGET && lateLandings === 0, `no day lands more than the allowance on the hub, and a later cycle of a spent day sends it nothing (${worstLanded} of ${BUDGET}, ${lateLandings})`);
  ok(turnOrigins.every((o) => { const e = entry(o); return e && !e.error && e.tools.length === ROUTES.length && e.redirectedTo === HUB; }), "and every origin stays listed from the hub");
} finally { Date.now = realNow; }

console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
