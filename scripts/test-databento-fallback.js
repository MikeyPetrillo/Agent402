#!/usr/bin/env node
// The equities tools read the consolidated end-of-day summary (EQUS.SUMMARY)
// and fall back to the three-venue feed (DBEQ.BASIC) only when the primary
// answers with an error or no rows. Offline: global fetch is stubbed, and
// every answer must name the dataset it came from.
process.env.DATABENTO_API_KEY = "db-test-key-not-real";
process.env.DATABENTO_WARM = "off";
const db = await import("../src/tools/databento.js");
const { FINANCE_TOOLS } = await import("../src/tools/finance-kit.js");
const quote = FINANCE_TOOLS.find((t) => t.slug === "stock-quote").handler;
const history = FINANCE_TOOLS.find((t) => t.slug === "stock-history").handler;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };
const realFetch = globalThis.fetch;

const ns = (day) => String(Date.parse(`${day}T00:00:00Z`) * 1e6);
const row = (day, close, volume, extra = {}) => JSON.stringify({ hd: { ts_event: ns(day), publisher_id: 90 }, open: "3.4e11", high: "3.48e11", low: "3.38e11", close, volume: String(volume), ...extra });
// One bar per session on the consolidated dataset; one per venue on the fallback.
const SUMMARY = [row("2026-10-12", "340970000000", 25900599), row("2026-10-13", "341270000000", 38983839)].join("\n") + "\n";
const DBEQ = [
  row("2026-10-12", "341060000000", 700000), row("2026-10-12", "341000000000", 20000), row("2026-10-12", "340900000000", 9225),
  row("2026-10-13", "340530000000", 1400000), row("2026-10-13", "340600000000", 25000), row("2026-10-13", "340400000000", 4841),
].join("\n") + "\n";

const up = { calls: [], summary: "ok", summaryRange: "ok" };
const datasetOf = (url, init) => {
  const u = new URL(String(url));
  return u.searchParams.get("dataset") || new URLSearchParams(String(init?.body || "")).get("dataset");
};
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith("https://hist.databento.com/")) throw new Error(`unexpected egress: ${u}`);
  const ds = datasetOf(url, init);
  const kind = u.includes("get_dataset_range") ? "range" : u.includes("get_cost") ? "cost" : u.includes("get_range") ? "data" : "other";
  up.calls.push(`${kind}:${ds}`);
  if (kind === "range") {
    if (up.rangeAll === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (ds === "EQUS.SUMMARY" && up.summaryRange === "500") return new Response("busy", { status: 500 });
    return new Response(JSON.stringify({ end: up.rangeEnd || "2026-10-14" }), { status: 200 });
  }
  if (kind === "cost") return new Response("0.00001", { status: 200 });
  if (kind === "data") {
    if (ds === "EQUS.SUMMARY") {
      if (up.summary === "timeout") throw Object.assign(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      if (up.summary === "500") return new Response("internal", { status: 500 });
      if (up.summary === "403") return new Response("not entitled", { status: 403 });
      if (up.summary === "400") return new Response('{"detail":"bad request"}', { status: 400 });
      if (up.summary === "empty") return new Response("", { status: 200 });
      if (up.summary === "422range") return new Response('{"detail":"end is after the available range"}', { status: 422 });
      if (up.summary === "422symbol") return new Response('{"detail":"Could not resolve symbol ZZZZ"}', { status: 422 });
      return new Response(SUMMARY, { status: 200 });
    }
    if (up.dbeq === "422symbol") return new Response('{"detail":"Could not resolve symbol ZZZZ"}', { status: 422 });
    return new Response(DBEQ, { status: 200 });
  }
  throw new Error(`unstubbed path ${u}`);
};
const reset = () => { db.__resetDatabentoState(); up.calls = []; up.summary = "ok"; up.summaryRange = "ok"; up.rangeAll = "ok"; up.dbeq = "ok"; up.rangeEnd = null; };
const dataReads = () => up.calls.filter((c) => c.startsWith("data:"));

try {
  // ---- the primary answers: consolidated bars, the official close, total volume
  reset();
  const q = await quote({ symbol: "AAPL" });
  ok(q.dataset === "EQUS.SUMMARY" && q.coverage === "consolidated" && q.source === "databento.com EQUS.SUMMARY", `a quote names the consolidated dataset (${q.dataset}, ${q.coverage})`);
  ok(q.price === 341.27 && q.previousClose === 340.97 && q.asOf === "2026-10-13", `the price is the summary's close, not a venue's (${q.price}, prev ${q.previousClose})`);
  ok(q.volume === 38983839 && q.venueVolume === 38983839, `volume is the consolidated total and venueVolume agrees with it (${q.volume}/${q.venueVolume})`);
  ok(/all US exchanges and ATSs/i.test(q.venues) && /consolidated total/.test(q.note), "venues and note say the coverage in words");
  ok(JSON.stringify(dataReads()) === JSON.stringify(["data:EQUS.SUMMARY"]), `a primary that answers is read once, with no fallback read (${dataReads().join(" ")})`);
  ok(up.calls[0] === "range:EQUS.SUMMARY", `the session boundary is the primary's range (${up.calls[0]})`);

  const h = await history({ symbol: "AAPL", days: 2 });
  ok(h.dataset === "EQUS.SUMMARY" && h.coverage === "consolidated" && h.bars.length === 2 && h.bars.every((b) => b.volume === b.venueVolume && b.volume > 0),
    `history bars carry the consolidated volume under both names (${JSON.stringify(h.bars.map((b) => b.volume))})`);
  const keys = Object.keys(FINANCE_TOOLS.find((t) => t.slug === "stock-quote").discovery.output.example).sort();
  ok(JSON.stringify(Object.keys(q).sort()) === JSON.stringify(keys), `a live answer has exactly the published example's fields (${Object.keys(q).length} keys)`);

  // ---- dataset-level failures fall back to the three-venue feed, and say so
  for (const mode of ["500", "403", "empty", "422range"]) {
    reset(); up.summary = mode;
    const r = await quote({ symbol: "AAPL" });
    ok(r.dataset === "DBEQ.BASIC" && r.coverage === "three-venue" && r.volume === null && /NYSE National/.test(r.venues),
      `a primary that answers ${mode} falls back and names the three-venue dataset (${r.dataset}, volume ${r.volume})`);
    ok(r.venueVolume === 1400000 + 25000 + 4841 && r.price === 340.53, `the fallback folds its venue bars as before (venueVolume ${r.venueVolume}, close ${r.price})`);
    ok(/three-venue consolidation/.test(r.note) && /volume is null/.test(r.note), "the fallback's note says what its volume counts");
    ok(JSON.stringify(dataReads()) === JSON.stringify(["data:EQUS.SUMMARY", "data:DBEQ.BASIC"]), `one primary read, then one fallback read (${dataReads().join(" ")})`);
  }
  {
    reset(); up.summary = "500";
    const r = await history({ symbol: "AAPL", days: 2 });
    ok(r.dataset === "DBEQ.BASIC" && r.coverage === "three-venue" && r.bars.every((b) => b.volume === null), "history falls back too, and its bars carry volume null");
  }

  // ---- not a dataset failure: answered as it is, no second read
  reset(); up.summary = "timeout";
  try { await quote({ symbol: "AAPL" }); ok(false, "a transport failure is not retried on the fallback"); }
  catch (e) { ok(e.statusCode === 503 && dataReads().length === 1, `a timed-out primary read is the 503 and the same host is not asked twice (${e.statusCode}, ${dataReads().length} data read)`); }
  reset(); up.summary = "422symbol";
  try { await quote({ symbol: "ZZZZ" }); ok(false, "an unknown symbol is the caller's input"); }
  catch (e) { ok(e.statusCode === 400 && /No market data for that symbol/.test(e.message) && dataReads().length === 1, `an unknown symbol is a 400 with no fallback read (${e.statusCode}, ${dataReads().length})`); }
  reset(); up.summary = "500"; up.dbeq = "422symbol";
  try { await quote({ symbol: "ZZZZ" }); ok(false, "both fail"); }
  catch (e) { ok(e.statusCode === 400, `when the fallback also refuses, its own answer is returned (${e.statusCode})`); }

  // ---- the range read falls back the same way
  reset(); up.summaryRange = "500";
  const end = await db.availableEnd();
  ok(end === "2026-10-14" && up.calls.slice(0, 2).join() === "range:EQUS.SUMMARY,range:DBEQ.BASIC", `a primary range error reads the fallback's range (${up.calls.slice(0, 2).join(" ")})`);
  ok(db.quoteWarmerStatus().range?.dataset === "DBEQ.BASIC", "the operator view names the dataset the boundary came from");

  // ---- the switch pins the fallback
  reset(); process.env.DATABENTO_SUMMARY = "off";
  const pinned = await quote({ symbol: "AAPL" });
  ok(pinned.dataset === "DBEQ.BASIC" && !up.calls.some((c) => c.endsWith("EQUS.SUMMARY")), `DATABENTO_SUMMARY=off never asks the consolidated dataset (${pinned.dataset})`);
  delete process.env.DATABENTO_SUMMARY;

  // ---- each dataset caches under its own key
  reset();
  await quote({ symbol: "MSFT" });
  const before = dataReads().length;
  const again = await quote({ symbol: "MSFT" });
  ok(again.cached === true && again.dataset === "EQUS.SUMMARY" && dataReads().length === before, "a repeat inside the session answers from the primary's cache");

  // ---- a primary that refuses the request is skipped for a while
  for (const mode of ["400", "403"]) {
    reset(); up.summary = mode;
    await quote({ symbol: "AAPL" });
    up.calls = [];
    const r = await quote({ symbol: "NVDA" });
    ok(r.dataset === "DBEQ.BASIC" && JSON.stringify(dataReads()) === JSON.stringify(["data:DBEQ.BASIC"]),
      `after a primary ${mode}, the next read goes straight to the fallback (${dataReads().join(" ")})`);
    ok(db.quoteWarmerStatus().primarySkip?.skipping === true && db.quoteWarmerStatus().primarySkip.skippedReads >= 1, "the operator view says the primary is being skipped");
  }
  {
    reset(); up.summary = "403"; process.env.DATABENTO_PRIMARY_SKIP_MS = "40";
    await quote({ symbol: "AAPL" });
    await new Promise((r) => setTimeout(r, 60));
    up.calls = []; up.summary = "ok";
    const r = await quote({ symbol: "TSLA" });
    ok(r.dataset === "EQUS.SUMMARY" && dataReads()[0] === "data:EQUS.SUMMARY", `once the skip window ends the primary is asked again (${dataReads().join(" ")})`);
    delete process.env.DATABENTO_PRIMARY_SKIP_MS;
  }
  {
    reset(); up.summary = "500";
    await quote({ symbol: "AAPL" });
    up.calls = [];
    await quote({ symbol: "NVDA" });
    ok(dataReads()[0] === "data:EQUS.SUMMARY", `a primary 5xx is not remembered: the next read asks the primary first (${dataReads().join(" ")})`);
  }

  // ---- a timed-out quote answers from the last good read, labeled
  {
    reset(); up.rangeEnd = "2026-10-13";
    const first = await quote({ symbol: "AAPL" });
    process.env.DATABENTO_RANGE_MAX_AGE_MS = "1";
    await new Promise((r) => setTimeout(r, 5));
    up.rangeEnd = "2026-10-14"; up.summary = "timeout";
    const r = await quote({ symbol: "AAPL" });
    ok(r.stale === true && /did not answer in time/.test(r.staleReason), `a timed-out quote read answers from the last good read and says so (${r.stale})`);
    ok(r.asOf === first.asOf && r.fetchedAt === first.fetchedAt && r.dataset === "EQUS.SUMMARY", `the stale answer carries its own day, read time and dataset (${r.asOf}, ${r.fetchedAt})`);
    try { await history({ symbol: "AAPL", days: 2 }); ok(false, "history is not served stale"); }
    catch (e) { ok(e.statusCode === 503, `a timed-out history read is still the 503 (${e.statusCode})`); }
    try { await quote({ symbol: "MSFT" }); ok(false, "no copy, no answer"); }
    catch (e) { ok(e.statusCode === 503, `a timed-out quote with no copy is still the 503 (${e.statusCode})`); }
    process.env.DATABENTO_QUOTE_STALE_MAX_MS = "1";
    await new Promise((r) => setTimeout(r, 5));
    try { await quote({ symbol: "AAPL" }); ok(false, "an old copy is not served"); }
    catch (e) { ok(e.statusCode === 503, `a copy older than the stale limit is not served (${e.statusCode})`); }
    delete process.env.DATABENTO_QUOTE_STALE_MAX_MS; delete process.env.DATABENTO_RANGE_MAX_AGE_MS;
  }
  // ---- a session boundary served from the last confirmed end says so
  {
    reset();
    const fresh = await quote({ symbol: "AAPL" });
    const freshH = await history({ symbol: "AAPL", days: 2 });
    ok(!("rangeStale" in fresh) && !("rangeStale" in freshH) && !("rangeCheckedAt" in freshH), "a confirmed boundary adds no stale field to either answer");
    db.__ageRange(2 * 3600_000);
    up.rangeAll = "timeout";
    const q = await quote({ symbol: "AAPL" });
    const aged = (x) => Date.parse(x) <= Date.now() - 2 * 3600_000 + 5000;
    ok(q.rangeStale === true && aged(q.rangeCheckedAt), `a quote on the fallback boundary carries rangeStale and the original (aged) rangeCheckedAt (${q.rangeStale}, ${q.rangeCheckedAt})`);
    const h = await history({ symbol: "AAPL", days: 2 });
    ok(h.rangeStale === true && aged(h.rangeCheckedAt) && h.bars.length === 2, `history on the fallback boundary carries rangeStale and rangeCheckedAt (${h.rangeStale}, ${h.rangeCheckedAt})`);
    up.rangeAll = "ok";
  }
} finally {
  globalThis.fetch = realFetch;
  db.__resetDatabentoState();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
