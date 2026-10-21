#!/usr/bin/env node
// The dataset range read is cached and, when a refresh times out, the call is
// answered on the last confirmed end inside a hard age limit instead of a 503.
// Offline: global fetch is stubbed; no Redis, no state database.
process.env.DATABENTO_API_KEY = "db-test-key-not-real";
delete process.env.REDIS_URL;
delete process.env.STATE_DATABASE_URL;
const db = await import("../src/tools/databento.js");
const { availableEndInfo, __resetDatabentoState, __ageRange, quoteWarmerStatus } = db;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };
const timeoutErr = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
const MIN = 60_000, HOUR = 60 * MIN;

let rangeReads = 0, mode = "ok", end = "2026-10-20", gate = null;
globalThis.fetch = async (url) => {
  if (!String(url).includes("get_dataset_range")) throw new Error(`unexpected upstream read: ${url}`);
  rangeReads++;
  if (gate) await gate;
  if (mode === "timeout") throw timeoutErr();
  if (mode === "500") return new Response("{}", { status: 500 });
  return new Response(JSON.stringify({ end, schema: { "ohlcv-1d": { end } } }), { status: 200 });
};

// 1. First read caches: the second call reads nothing upstream.
__resetDatabentoState();
const a = await availableEndInfo();
const b = await availableEndInfo();
ok(a.end === "2026-10-20" && a.cached === false && rangeReads === 1, `first read goes upstream once (${rangeReads})`);
ok(b.end === a.end && b.cached === true && rangeReads === 1, `a repeat inside the max age answers from memory (${rangeReads})`);

// 2. A timeout past the max age, with a last good end inside the hard limit,
//    still answers, on that end, with its real age and stale: true.
__ageRange(2 * HOUR);
mode = "timeout"; end = "2026-10-21";
const c = await availableEndInfo();
ok(c.end === "2026-10-20" && c.stale === true && c.ageMs >= 2 * HOUR - 1000, `a timed-out refresh serves the last good end (${c.end}, stale ${c.stale}, age ${Math.round(c.ageMs / MIN)} min)`);
ok(rangeReads === 2, `the refresh was attempted before falling back (${rangeReads})`);
ok(new Date(c.checkedAt).getTime() <= Date.now() - 2 * HOUR + 1000, `checkedAt is the original confirmation time, not now (${c.checkedAt})`);
// An upstream error status is the same as a timeout here.
mode = "500";
const c2 = await availableEndInfo();
ok(c2.end === "2026-10-20" && c2.stale === true, `an upstream error status also serves the last good end (${c2.end})`);
ok(quoteWarmerStatus().rangeFallback.staleServed === 2, `the operator surface counts stale answers (${JSON.stringify(quoteWarmerStatus().rangeFallback)})`);
// A later good refresh replaces it and clears stale.
mode = "ok";
const d = await availableEndInfo();
ok(d.end === "2026-10-21" && d.cached === false && !d.stale, `a recovered refresh adopts the new end (${d.end})`);

// 3. A timeout with no cached end fails as before (503 naming the step).
__resetDatabentoState(); rangeReads = 0; mode = "timeout";
try { await availableEndInfo(); ok(false, "no cache: refused"); }
catch (e) { ok(e.statusCode === 503 && /dataset range/.test(e.message), `a timed-out read with no cached end is the 503 (${e.statusCode}: ${e.message})`); }

// 4. A last good end older than the hard limit is not used.
__resetDatabentoState(); rangeReads = 0; mode = "ok"; end = "2026-10-20";
await availableEndInfo();
__ageRange(25 * HOUR);
mode = "timeout";
try { await availableEndInfo(); ok(false, "past hard limit: refused"); }
catch (e) { ok(e.statusCode === 503, `an end older than the hard limit is never served (${e.statusCode})`); }
// The limit is configurable and read per call.
process.env.DATABENTO_RANGE_STALE_MAX_MS = String(30 * HOUR);
const e2 = await availableEndInfo();
ok(e2.stale === true && e2.end === "2026-10-20", `a raised hard limit serves it again (${e2.end})`);
delete process.env.DATABENTO_RANGE_STALE_MAX_MS;

// 5. N concurrent callers share one in-flight refresh, and all are answered
//    on the last good end when it times out.
__resetDatabentoState(); rangeReads = 0; mode = "ok"; end = "2026-10-20";
await availableEndInfo();
__ageRange(2 * HOUR);
rangeReads = 0; mode = "timeout";
let release; gate = new Promise((r) => { release = r; });
const N = 25;
const all = Promise.all(Array.from({ length: N }, () => availableEndInfo()));
await new Promise((r) => setTimeout(r, 20));
release(); gate = null;
const answers = await all;
ok(rangeReads === 1, `${N} concurrent callers made one upstream read (${rangeReads})`);
ok(answers.every((x) => x.end === "2026-10-20" && x.stale === true), `every concurrent caller got the last good end`);
// Concurrent first reads (no cache) also share one read.
__resetDatabentoState(); rangeReads = 0; mode = "ok";
gate = new Promise((r) => { release = r; });
const firsts = Promise.all(Array.from({ length: N }, () => availableEndInfo()));
await new Promise((r) => setTimeout(r, 20));
release(); gate = null;
const fr = await firsts;
ok(rangeReads === 1 && fr.every((x) => x.end === "2026-10-20"), `${N} concurrent first reads made one upstream read (${rangeReads})`);

// 6. Between the refresh interval and the max age, with no warmer running, a
//    request answers on the cached end at once and starts one background
//    refresh; repeats inside the retry window start no more.
__resetDatabentoState(); rangeReads = 0; mode = "ok"; end = "2026-10-20";
await availableEndInfo();
__ageRange(20 * MIN);
rangeReads = 0; end = "2026-10-21";
const f = await availableEndInfo();
ok(f.end === "2026-10-20" && f.cached === true && !f.stale, `inside the max age the cached end answers at once (${f.end})`);
await new Promise((r) => setTimeout(r, 20));
ok(rangeReads === 1, `one background refresh started (${rangeReads})`);
const g = await availableEndInfo();
ok(g.end === "2026-10-21" && g.cached === true, `the next request sees the refreshed end (${g.end})`);
// A failing background refresh is retried at most once per retry window.
process.env.DATABENTO_RANGE_RETRY_MS = "200";
__resetDatabentoState(); mode = "ok"; end = "2026-10-20";
await availableEndInfo();
__ageRange(20 * MIN);
rangeReads = 0; mode = "timeout";
for (let i = 0; i < 5; i++) await availableEndInfo();
await new Promise((r) => setTimeout(r, 20));
ok(rangeReads === 1, `five requests during a failing refresh start one background read (${rangeReads})`);
await new Promise((r) => setTimeout(r, 250));
const h = await availableEndInfo();
await new Promise((r) => setTimeout(r, 20));
ok(rangeReads === 2 && h.end === "2026-10-20", `after the retry window one more read starts, and the cached end still answers (${rangeReads}, ${h.end})`);
ok(quoteWarmerStatus().rangeFallback.backgroundRefreshes === 2, `background refreshes are counted (${quoteWarmerStatus().rangeFallback.backgroundRefreshes})`);
delete process.env.DATABENTO_RANGE_RETRY_MS;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
