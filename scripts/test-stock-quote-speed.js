#!/usr/bin/env node
// stock-quote answers from memory once warm, and a cold symbol costs one
// upstream round trip on the request path (src/tools/databento.js).
//
//   node scripts/test-stock-quote-speed.js        (offline: fetch and DNS stubbed)
//
// WHY: a paid quote took ~11 s end to end and the buyer's ~10 s timeout closed
// first. The handler made up to three upstream reads per request (the
// session boundary, a price check, the data), and every one of them could sit
// on the request path. Proven here, against a stub upstream with a fixed
// injected latency per call:
//   a. a symbol already read this session answers with no upstream call;
//   b. a cold symbol makes exactly one upstream call on the request path;
//   c. the session boundary is not read on the request path once warm, even
//      past its refresh interval, and is read inline only past its max age;
//   d. the warmer respects its daily ceiling of background calls and stops;
//   e. every answer says whether it came from cache (cached, fetchedAt);
// plus: the price check moves to the warmer for the quote shape only, and a
// failed price audit puts it back inline; concurrent cold reads share one
// upstream read; an idle warmer makes no call. A quote is read unpriced ONLY
// after an audit of its own session came back within the bound: before the
// first audit, with the warmer off, or after an audit that threw or answered
// no number, it is priced inline, and that audit is retried on the next tick.
// Wherever the price check is on the request path it runs BEFORE the read, so
// an over-bound query is refused without being read. A warmer pre-read counts
// every upstream call it makes. The self-check's quote is not demand.
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

process.env.DATABENTO_API_KEY = "db-test-key-not-real";
process.env.DATABENTO_WARM_TOP_N = "2";
delete process.env.DATABENTO_BACKGROUND_DAILY_MAX_CALLS;
delete process.env.DATABENTO_RANGE_MAX_AGE_MS;
delete process.env.DATABENTO_WARM_IDLE_MS;
// The SSRF host check resolves DNS; answer it locally so nothing leaves.
dnsPromises.lookup = async () => ({ address: "1.1.1.1", family: 4 });
syncBuiltinESMExports();

const db = await import("../src/tools/databento.js");
const { FINANCE_TOOLS } = await import("../src/tools/finance-kit.js");
const quote = FINANCE_TOOLS.find((t) => t.slug === "stock-quote").handler;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };

// ---- stub upstream: every call takes LATENCY ms
const LATENCY = 150;
const up = { range: 0, cost: 0, data: 0, end: "2026-10-09", price: "0.00001", costFail: null, inflight: 0, maxInflight: 0, order: [] };
const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bar = (day, close) => JSON.stringify({ hd: { ts_event: String(Date.parse(day) * 1e6) }, open: "1e11", high: "2e11", low: "5e10", close, volume: "100" });
globalThis.fetch = async (url) => {
  const u = String(url);
  if (!u.startsWith("https://hist.databento.com/")) throw new Error(`unexpected egress: ${u}`);
  up.inflight++; up.maxInflight = Math.max(up.maxInflight, up.inflight);
  try {
    await sleep(LATENCY);
    if (u.includes("get_dataset_range")) { up.range++; return new Response(JSON.stringify({ end: up.end }), { status: 200 }); }
    if (u.includes("get_cost")) { up.cost++; up.order.push("cost"); if (up.costFail === "throw") return new Response("upstream down", { status: 500 }); if (up.costFail === "nan") return new Response("not a number", { status: 200 }); return new Response(up.price, { status: 200 }); }
    if (u.includes("get_range")) { up.data++; up.order.push("data"); return new Response(bar("2026-10-08", "1.4e11") + "\n" + bar(up.end, "1.5e11") + "\n", { status: 200 }); }
    throw new Error(`unstubbed path ${u}`);
  } finally { up.inflight--; }
};
const snap = () => ({ range: up.range, cost: up.cost, data: up.data });
const diff = (a, b) => ({ range: b.range - a.range, cost: b.cost - a.cost, data: b.data - a.data });
const total = (d) => d.range + d.cost + d.data;
// One request: what it called upstream while it ran, and how long it took.
async function timed(symbol) {
  const s0 = snap(), t0 = performance.now();
  const body = await quote({ symbol });
  return { body, ms: Math.round(performance.now() - t0), calls: diff(s0, snap()) };
}
// A controllable clock for the age rules.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const MIN = 60_000;

try {
  // ---- cold boot: no session boundary yet. Read inline (the only time).
  db.__resetDatabentoState();
  const first = await timed("IBM");
  ok(first.calls.range === 1 && first.calls.data === 1 && first.calls.cost === 1,
    `cold boot, cold symbol: no audit has run yet, so the read is priced inline (${JSON.stringify(first.calls)}, ${first.ms} ms)`);

  // An over-bound quote before any audit: refused by the price check, never read.
  db.__resetDatabentoState();
  up.price = "5"; up.order.length = 0;
  let early = null; const e0 = snap();
  try { await quote({ symbol: "IBM" }); } catch (e) { early = e; }
  ok(early?.statusCode === 400 && diff(e0, snap()).data === 0 && up.order[0] === "cost", `before any audit an over-bound quote is refused by the price check, with no data read (${JSON.stringify(diff(e0, snap()))})`);
  up.price = "0.00001";

  // The warmer off (DATABENTO_WARM=off): no audit ever runs, so every cold quote is priced inline.
  db.__resetDatabentoState();
  process.env.DATABENTO_WARM = "off";
  ok(db.startQuoteWarmer() === false, "DATABENTO_WARM=off: the warmer does not start");
  const off1 = await timed("OFFA");
  ok(off1.calls.cost === 1 && off1.calls.data === 1, `with the warmer off a cold quote is priced inline (${JSON.stringify(off1.calls)})`);
  delete process.env.DATABENTO_WARM;

  // A boot audit that throws, or answers no number: quotes stay priced inline
  // and the next tick audits again; once it passes, quotes read unpriced.
  for (const mode of ["throw", "nan"]) {
    db.__resetDatabentoState();
    up.costFail = mode;
    await db.warmTick();
    ok(db.quoteWarmerStatus().quotePriceAuditOk !== true, `a boot audit that ${mode === "throw" ? "throws" : "answers no number"} does not mark the session audited`);
    await quote({ symbol: "AUDA" }); // demand, so the next tick is not idle
    const a1 = await timed("AUDB");
    ok(a1.calls.cost === 1 && a1.calls.data === 1, `after a boot audit that ${mode === "throw" ? "threw" : "answered no number"} a cold quote is still priced inline (${JSON.stringify(a1.calls)})`);
    up.costFail = null;
    const r0 = snap();
    await db.warmTick();
    ok(diff(r0, snap()).cost === 1 && db.quoteWarmerStatus().quotePriceAuditOk === true, `the next tick retries the audit (${JSON.stringify(diff(r0, snap()))})`);
    const a2 = await timed("AUDC");
    ok(a2.calls.cost === 0 && a2.calls.data === 1, `after the retried audit passes a cold quote reads unpriced (${JSON.stringify(a2.calls)})`);
  }

  // ---- warm boundary: the warmer's boot read, off the request path.
  db.__resetDatabentoState();
  const p0 = snap();
  const prime = await db.warmTick();
  ok(prime.end === up.end && diff(p0, snap()).range === 1 && diff(p0, snap()).cost === 1 && diff(p0, snap()).data === 0, `the warmer's boot read fetches the boundary once and prices the quote shape once (${JSON.stringify(diff(p0, snap()))})`);

  // b. a cold symbol: one upstream call on the request path.
  const cold = await timed("MSFT");
  ok(total(cold.calls) === 1 && cold.calls.data === 1, `b. a cold symbol makes exactly one upstream call on the request path (${JSON.stringify(cold.calls)})`);
  ok(cold.ms < LATENCY * 1.6, `b. a cold symbol answers in about one upstream latency (${cold.ms} ms vs ${LATENCY} ms per call)`);
  ok(cold.body.cached === false && typeof cold.body.fetchedAt === "string" && !Number.isNaN(Date.parse(cold.body.fetchedAt)) && typeof cold.body.rangeCheckedAt === "string",
    `e. a fresh read says cached:false with its fetchedAt and rangeCheckedAt (${cold.body.cached}, ${cold.body.fetchedAt})`);
  ok(cold.body.price === 150 && cold.body.previousClose === 140 && cold.body.asOf === up.end, `the quote itself is unchanged (price ${cold.body.price}, prev ${cold.body.previousClose}, asOf ${cold.body.asOf})`);

  // a. the same symbol again: nothing upstream.
  const warmHit = await timed("msft");
  ok(total(warmHit.calls) === 0, `a. a warm symbol makes no upstream call (${JSON.stringify(warmHit.calls)})`);
  ok(warmHit.ms < 50, `a. a warm symbol answers well under a second (${warmHit.ms} ms)`);
  ok(warmHit.body.cached === true && warmHit.body.fetchedAt === cold.body.fetchedAt && warmHit.body.price === cold.body.price,
    `e. a cached answer says cached:true and keeps the original fetchedAt (${warmHit.body.fetchedAt})`);

  // c. past the refresh interval but inside the max age: still nothing on the request path.
  skew += 30 * MIN;
  const aged = await timed("MSFT");
  ok(total(aged.calls) === 0, `c. 30 min later the boundary is not re-read on the request path (${JSON.stringify(aged.calls)})`);
  ok(aged.body.rangeCheckedAt === cold.body.rangeCheckedAt, "c. the answer carries the boundary's original check time, not a fresh-looking one");
  // The warmer refreshes it instead (there is demand), and prices the quote shape once for the session.
  const t1 = snap();
  await db.warmTick();
  const tick1 = diff(t1, snap());
  ok(tick1.range === 1 && tick1.cost === 0 && tick1.data === 0, `c. the warmer re-reads the boundary off the request path; the session is already priced and MSFT already cached (${JSON.stringify(tick1)})`);
  const t2 = snap();
  await db.warmTick();
  ok(diff(t2, snap()).cost === 0 && diff(t2, snap()).range === 1, "the price check runs once per session, not once per tick");

  // Session roll: the warmer pre-reads the top symbols for the new session.
  await quote({ symbol: "AAPL" }); await quote({ symbol: "AAPL" }); // AAPL is now the top symbol, then MSFT; IBM was before the reset
  up.end = "2026-10-12";
  const t3 = snap();
  const roll = await db.warmTick();
  const rolled = diff(t3, snap());
  ok(roll.end === "2026-10-12" && rolled.range === 1 && rolled.cost === 1 && rolled.data === 2 && roll.prefetched === 2,
    `a new session: boundary, one price check and the top ${process.env.DATABENTO_WARM_TOP_N} symbols pre-read in the background (${JSON.stringify(rolled)})`);
  const pre = await timed("AAPL");
  ok(total(pre.calls) === 0 && pre.body.cached === true && pre.body.asOf === "2026-10-12", `a. a pre-read top symbol answers the new session with no upstream call (${JSON.stringify(pre.calls)}, asOf ${pre.body.asOf})`);

  // c. past the max age with no warmer tick (the warmer was idle): read inline, once.
  skew += 61 * MIN;
  const stale = await timed("MSFT");
  ok(stale.calls.range === 1, `c. past the max age the boundary is read inline (${JSON.stringify(stale.calls)})`);

  // Concurrent cold reads of one symbol share a single upstream read.
  const c0 = snap();
  await Promise.all([quote({ symbol: "ORCL" }), quote({ symbol: "ORCL" }), quote({ symbol: "ORCL" })]);
  ok(diff(c0, snap()).data === 1, `three concurrent cold reads of one symbol make one upstream read (${diff(c0, snap()).data})`);

  // Idle: no demand inside the idle window means the warmer makes no call.
  skew += 7 * 60 * MIN;
  const i0 = snap();
  const idle = await db.warmTick();
  ok(idle.skipped === "idle" && total(diff(i0, snap())) === 0, `an idle warmer makes no upstream call (${JSON.stringify(idle)})`);

  // d. the ceiling: four background calls a day, then nothing.
  db.__resetDatabentoState();
  process.env.DATABENTO_BACKGROUND_DAILY_MAX_CALLS = "4";
  up.end = "2026-10-13";
  await db.warmTick(); // boot read + price: 2 calls
  for (const s of ["AAA", "BBB", "CCC"]) await quote({ symbol: s }); // demand + popularity (request-path reads)
  up.end = "2026-10-14";
  const d0 = snap();
  const capped = await db.warmTick(); // range (3) + price (4) + no room for a pre-read
  const dd = diff(d0, snap());
  const st = db.quoteWarmerStatus();
  ok(dd.range === 1 && dd.cost === 1 && dd.data === 0 && capped.prefetched === 0, `d. the warmer stops pre-reading at its ceiling (${JSON.stringify(dd)})`);
  ok(st.background.calls === 4 && st.background.dailyMax === 4 && st.background.ceilingHit === true, `d. the status reports the ceiling reached (${JSON.stringify(st.background)})`);
  const d1 = snap();
  const after = await db.warmTick();
  ok(after.skipped === "ceiling" && total(diff(d1, snap())) === 0, `d. past the ceiling a tick makes no call at all (${JSON.stringify(after)})`);
  const served = await timed("DDD");
  ok(served.calls.data === 1 && served.body.price === 150, "d. requests still answer past the ceiling (they read inline, as before the warmer)");
  ok(!JSON.stringify(st).includes("AAA"), "the warmer status carries counts, never a requested symbol");
  process.env.DATABENTO_BACKGROUND_DAILY_MAX_CALLS = "not-a-number";
  ok(db.backgroundDailyMax() === 150, "a malformed ceiling falls back to the default, never to unbounded");
  delete process.env.DATABENTO_BACKGROUND_DAILY_MAX_CALLS;

  // The price check's guarantee: a quote shape that prices over the bound puts
  // the check back inline on every quote read.
  db.__resetDatabentoState();
  await db.warmTick();                      // boot: priced within bound
  ok(db.quoteWarmerStatus().quotePriceCheck === "per-session" && db.quoteWarmerStatus().quotePriceAuditOk === true, "the boot read prices the quote shape and finds it within bound");
  await quote({ symbol: "EEE" });           // demand
  up.price = "5"; // over any bound
  up.end = "2026-10-15";
  await db.warmTick();                      // the audit fails -> latch
  ok(db.quoteWarmerStatus().quotePriceCheck === "inline" && db.quoteWarmerStatus().quotePriceAuditOk === false, "a quote shape priced over the bound latches the price check back inline");
  const l0 = snap();
  let refused = null;
  try { await quote({ symbol: "FFF" }); } catch (e) { refused = e; }
  ok(diff(l0, snap()).cost === 1 && refused?.statusCode === 400, `after the latch a cold quote is priced inline and refused when over the bound (${JSON.stringify(diff(l0, snap()))}, ${refused?.statusCode})`);
  ok(diff(l0, snap()).data === 0, `...and the refused query is never read upstream (${diff(l0, snap()).data} data reads)`);
  up.price = "0.00001";

  // stock-history keeps its inline price check (a wider, caller-sized range).
  db.__resetDatabentoState();
  await db.warmTick();
  const h0 = snap();
  await FINANCE_TOOLS.find((t) => t.slug === "stock-history").handler({ symbol: "GGG", days: 5 });
  ok(diff(h0, snap()).cost === 1 && diff(h0, snap()).data === 1, `stock-history still prices its read inline (${JSON.stringify(diff(h0, snap()))})`);
  up.price = "5"; up.order.length = 0;
  const h1 = snap(); let hRefused = null;
  try { await FINANCE_TOOLS.find((t) => t.slug === "stock-history").handler({ symbol: "GGH", days: 5 }); } catch (e) { hRefused = e; }
  ok(hRefused?.statusCode === 400 && diff(h1, snap()).data === 0 && up.order.join() === "cost", `an over-bound stock-history is refused before its read, which never runs (${JSON.stringify(diff(h1, snap()))})`);
  up.price = "0.00001";

  // A warmer pre-read that is priced inline makes two upstream calls and
  // counts both against the daily ceiling.
  db.__resetDatabentoState();
  await db.warmTick();
  await quote({ symbol: "PREA" }); await quote({ symbol: "PREB" });
  up.end = "2026-10-16"; up.costFail = "throw"; // the session's audit fails: pre-reads are priced inline
  const w0 = snap(), b0 = db.quoteWarmerStatus().background.calls;
  const pr = await db.warmTick();
  const wd = diff(w0, snap());
  up.costFail = null;
  ok(pr.prefetched === 2 && wd.data === 2 && wd.cost === 3, `an unaudited session's pre-reads are priced inline (${JSON.stringify(wd)})`);
  ok(db.quoteWarmerStatus().background.calls - b0 === total(wd), `every background upstream call is counted (${db.quoteWarmerStatus().background.calls - b0} counted, ${total(wd)} made)`);

  // The self-check's own quote is not demand: no symbol, no warm-up.
  db.__resetDatabentoState();
  await db.warmTick();
  await quote({ symbol: "SELF" }, { selfcheck: true });
  ok(!db.warmSymbols().includes("SELF") && db.quoteWarmerStatus().trackedSymbols === 0, "a self-check quote adds no symbol to the warm list");
  const s0 = snap();
  ok((await db.warmTick()).skipped === "idle" && total(diff(s0, snap())) === 0, "...and counts as no demand (the next tick is idle)");
  await FINANCE_TOOLS.find((t) => t.slug === "stock-history").handler({ symbol: "SELF", days: 5 }, { selfcheck: true });
  ok((await db.warmTick()).skipped === "idle", "a self-check stock-history is no demand either");
  await quote({ symbol: "PAID" });
  ok(db.warmSymbols().includes("PAID"), "a buyer's quote still feeds the warm list");

  // No key: the warmer does not start and makes no call.
  db.__resetDatabentoState();
  const k = process.env.DATABENTO_API_KEY; delete process.env.DATABENTO_API_KEY;
  const n0 = snap();
  ok(db.startQuoteWarmer() === false && total(diff(n0, snap())) === 0, "with no key the warmer does not start");
  process.env.DATABENTO_API_KEY = k;
  process.env.DATABENTO_WARM = "off";
  ok(db.startQuoteWarmer() === false, "DATABENTO_WARM=off keeps the warmer off");
  delete process.env.DATABENTO_WARM;

  console.log(`\nlatency with ${LATENCY} ms per upstream call: cold boot ${first.ms} ms, cold symbol ${cold.ms} ms, warm symbol ${warmHit.ms} ms`);
} finally {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  db.__resetDatabentoState();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
