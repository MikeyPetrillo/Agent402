#!/usr/bin/env node
// A slow or unreachable market-data upstream is a 504/502 naming the
// upstream, never a bare 500 (a fetch timeout carries no status of its own).
// Offline: global fetch is stubbed.
process.env.DATABENTO_API_KEY = "db-test-key-not-real";
const { dailyBars, availableEnd, DATABENTO_TIMEOUTS_MS } = await import("../src/tools/databento.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };
const realFetch = globalThis.fetch;
const timeoutErr = () => Object.assign(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

globalThis.fetch = async () => { throw timeoutErr(); };
try { await availableEnd(); ok(false, "range read times out"); }
catch (e) { ok(e.statusCode === 504 && /did not answer/.test(e.message), `a timed-out range read is a 504 naming the upstream (${e.statusCode}: ${e.message})`); }

try { await dailyBars({ symbol: "AAPL", start: "2026-08-01", end: "2026-09-05" }); ok(false, "data read times out"); }
catch (e) { ok(e.statusCode === 504, `a timed-out data read is a 504, not a 500 (${e.statusCode})`); }

globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
try { await dailyBars({ symbol: "AAPL", start: "2026-08-01", end: "2026-09-05" }); ok(false, "unreachable"); }
catch (e) { ok(e.statusCode === 502 && /could not be reached/.test(e.message), `an unreachable upstream is a 502 (${e.statusCode})`); }

// The cost read failing is not a reason to refuse: the data read still runs.
// These reads use a range wider than a quote's lookback, the shape that keeps
// its price check on the request path (a quote-shaped read is priced by the
// warmer instead: scripts/test-stock-quote-speed.js).
let calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  if (String(url).includes("get_cost")) throw timeoutErr();
  const bar = { hd: { ts_event: String(Date.UTC(2026, 8, 2) * 1e6) }, open: "1e9", high: "2e9", low: "5e8", close: "1.5e9", volume: "100" };
  return new Response(JSON.stringify(bar) + "\n", { status: 200 });
};
const bars = await dailyBars({ symbol: "AAPL", start: "2026-08-01", end: "2026-09-05" });
ok(calls === 2 && Array.isArray(bars) && bars.length === 1, `a timed-out cost read still serves the data (${calls} calls, ${bars.length} bar)`);

// Bars are end-of-day data keyed by symbol and range: a repeat inside the
// session answers from memory with no upstream read. Errors are never cached,
// the bound drops the oldest entry, and the cached rows cannot be mutated by
// a caller (each read gets its own copies).
const { __setBarsCacheMax, barsCacheSize } = await import("../src/tools/databento.js");
__setBarsCacheMax(2);
const barOf = (ts, close) => ({ hd: { ts_event: String(ts * 1e6) }, open: "1e9", high: "2e9", low: "5e8", close, volume: "100" });
let dataReads = 0, costReads = 0, failData = false;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("get_cost")) { costReads++; return new Response("0.00001", { status: 200 }); }
  if (u.includes("get_range")) {
    dataReads++;
    if (failData) throw timeoutErr();
    return new Response(JSON.stringify(barOf(Date.UTC(2026, 8, 2), "1.5e9")) + "\n", { status: 200 });
  }
  return new Response(JSON.stringify({ end: "2026-09-05" }), { status: 200 });
};
const q = { symbol: "aapl", start: "2026-08-01", end: "2026-09-05" };
const first = await dailyBars(q);
ok(dataReads === 1 && costReads === 1, `first read of a symbol and range costs one cost check and one data read (${costReads}/${dataReads})`);
first[0].close = 0; // a caller mutating its copy must not poison the cache
const second = await dailyBars({ ...q, symbol: "AAPL" });
ok(dataReads === 1 && costReads === 1 && second[0].close === 1.5, `a repeat of the same symbol and range (any case) reads nothing upstream and returns the original bar (${dataReads} data reads, close ${second[0].close})`);
await dailyBars({ ...q, end: "2026-09-08" });
ok(dataReads === 2, `a new available end is a new key and reads upstream again (${dataReads})`);
failData = true;
try { await dailyBars({ ...q, symbol: "MSFT" }); ok(false, "failed read"); } catch (e) { ok(e.statusCode === 504, `a failed data read is still the 504 (${e.statusCode})`); }
failData = false;
await dailyBars({ ...q, symbol: "MSFT" });
ok(dataReads === 4, `a failed read is never cached: the retry reads upstream (${dataReads})`);
ok(barsCacheSize() === 2, `the cache holds at most its bound (${barsCacheSize()} of 2)`);
await dailyBars(q);
ok(dataReads === 5, `the oldest entry was dropped past the bound, so the first symbol reads again (${dataReads})`);
__setBarsCacheMax();

// The price check and the data read run side by side: two reads that each
// take one upstream latency finish in about one, not two.
{
  globalThis.fetch = async (url) => {
    await new Promise((r) => setTimeout(r, 200));
    if (String(url).includes("get_cost")) return new Response("0.00001", { status: 200 });
    const bar = { hd: { ts_event: String(Date.UTC(2026, 8, 3) * 1e6) }, open: "1e9", high: "2e9", low: "5e8", close: "1.5e9", volume: "100" };
    return new Response(JSON.stringify(bar) + "\n", { status: 200 });
  };
  const t0 = Date.now();
  const bars = await dailyBars({ symbol: "MSFT", start: "2026-08-01", end: "2026-09-05" });
  const took = Date.now() - t0;
  ok(bars.length === 1 && took < 340, `a first read with two 200 ms upstream reads finishes in about one latency (${took} ms)`);
}

const worst = DATABENTO_TIMEOUTS_MS.range + DATABENTO_TIMEOUTS_MS.cost + DATABENTO_TIMEOUTS_MS.data;
ok(worst <= 25_000, `the three reads together are bounded at ${worst} ms, under a buyer's patience`);

globalThis.fetch = realFetch;
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
