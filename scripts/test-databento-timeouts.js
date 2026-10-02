#!/usr/bin/env node
// A slow or unreachable market-data upstream is a 504/502 naming the
// upstream, never a bare 500 (2026-09-30: stock-quote and stock-history
// answered 500 after 15-35 s when the upstream was slow, because a fetch
// timeout carried no status). Offline: global fetch is stubbed.
process.env.DATABENTO_API_KEY = "db-test-key-not-real";
const { dailyBars, availableEnd, DATABENTO_TIMEOUTS_MS } = await import("../src/tools/databento.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };
const realFetch = globalThis.fetch;
const timeoutErr = () => Object.assign(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

globalThis.fetch = async () => { throw timeoutErr(); };
try { await availableEnd(); ok(false, "range read times out"); }
catch (e) { ok(e.statusCode === 504 && /did not answer/.test(e.message), `a timed-out range read is a 504 naming the upstream (${e.statusCode}: ${e.message})`); }

try { await dailyBars({ symbol: "AAPL", start: "2026-09-01", end: "2026-09-05" }); ok(false, "data read times out"); }
catch (e) { ok(e.statusCode === 504, `a timed-out data read is a 504, not a 500 (${e.statusCode})`); }

globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
try { await dailyBars({ symbol: "AAPL", start: "2026-09-01", end: "2026-09-05" }); ok(false, "unreachable"); }
catch (e) { ok(e.statusCode === 502 && /could not be reached/.test(e.message), `an unreachable upstream is a 502 (${e.statusCode})`); }

// The cost read failing is not a reason to refuse: the data read still runs.
let calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  if (String(url).includes("get_cost")) throw timeoutErr();
  const bar = { hd: { ts_event: String(Date.UTC(2026, 8, 2) * 1e6) }, open: "1e9", high: "2e9", low: "5e8", close: "1.5e9", volume: "100" };
  return new Response(JSON.stringify(bar) + "\n", { status: 200 });
};
const bars = await dailyBars({ symbol: "AAPL", start: "2026-09-01", end: "2026-09-05" });
ok(calls === 2 && Array.isArray(bars) && bars.length === 1, `a timed-out cost read still serves the data (${calls} calls, ${bars.length} bar)`);

const worst = DATABENTO_TIMEOUTS_MS.range + DATABENTO_TIMEOUTS_MS.cost + DATABENTO_TIMEOUTS_MS.data;
ok(worst <= 25_000, `the three reads together are bounded at ${worst} ms, under a buyer's patience`);

globalThis.fetch = realFetch;
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
