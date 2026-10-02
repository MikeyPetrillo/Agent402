// Unit tests for /revenue's buyersTrend() - the rolling 14-day recent-vs-
// prior buyer-diversity comparison added after an internal audit found
// distinct daily buyers fell 45% over 60 days, independent of any single
// wallet, with nothing on the page surfacing that trend directly (a viewer
// had to eyeball the chart). Extracts the actual function source and
// executes it for real - not a regex/string check - since this is genuine
// arithmetic, not just DOM structure. Lives in assets/js/revenue-chart.js
// (external file, CSP hardening, 2026-08-16) - was inline in
// src/revenue-live.js's shared <script> block before that.
//
// Offline - no server, no network.
import { readFileSync } from "node:fs";
import vm from "node:vm";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const src = readFileSync(new URL("../assets/js/revenue-chart.js", import.meta.url), "utf8");
const m = src.match(/function buyersTrend\(\)\{[\s\S]*?\n    \}/);
ok(!!m, "found buyersTrend() source in assets/js/revenue-chart.js");

// Reconstruct it standalone, injecting `state` as a parameter instead of a
// closure variable so fixture rows can be supplied directly.
const fnSrc = m[0].replace("function buyersTrend()", "function buyersTrend(state)");
// Compiled in a fresh context from our own browser script, so the test drives
// the exact code the page ships.
const buyersTrend = vm.runInNewContext(`(${fnSrc})`);

function rows(counts, startDay = "2026-06-01") {
  const start = new Date(startDay + "T00:00:00Z");
  return counts.map((n, i) => {
    const d = new Date(start.getTime() + i * 86400000);
    return { day: d.toISOString().slice(0, 10), buyers: n };
  });
}

// --- insufficient history: fewer than 28 days -> null, no trend asserted ---
ok(buyersTrend({ buyers: rows(Array(27).fill(5)) }) === null, "27 days of history -> null (needs 28)");
ok(buyersTrend({ buyers: [] }) === null, "no data -> null");
ok(buyersTrend({ buyers: null }) === null, "buyers: null -> does not throw, returns null");
ok(buyersTrend({}) === null, "missing buyers field entirely -> does not throw, returns null");

// --- exactly 28 days: the boundary case must compute, not just clear it ---
{
  const t = buyersTrend({ buyers: rows(Array(28).fill(10)) });
  ok(t !== null, "exactly 28 days of history -> a real trend object (boundary is inclusive)");
}

// --- real decline shape (matches the audit's own measured numbers) ---
{
  // 14 days at ~14/day, then 14 days at ~7/day - a genuine ~50% decline.
  const counts = [...Array(14).fill(14), ...Array(14).fill(7)];
  const t = buyersTrend({ buyers: rows(counts) });
  ok(t.prior === 14, `prior-period average computed correctly (got ${t.prior})`);
  ok(t.recent === 7, `recent-period average computed correctly (got ${t.recent})`);
  ok(Math.abs(t.pct - -50) < 0.01, `pct correctly negative for a decline (got ${t.pct.toFixed(2)})`);
}

// --- growth shape: pct must be positive, not just "not negative" ---
{
  const counts = [...Array(14).fill(5), ...Array(14).fill(10)];
  const t = buyersTrend({ buyers: rows(counts) });
  ok(t.pct > 0, `pct is positive for real growth (got ${t.pct.toFixed(2)})`);
}

// --- flat: near-zero swing lands close to 0%, not spuriously large ---
{
  const counts = [...Array(14).fill(10), ...Array(14).fill(10)];
  const t = buyersTrend({ buyers: rows(counts) });
  ok(Math.abs(t.pct) < 0.01, `identical periods -> ~0% (got ${t.pct.toFixed(2)})`);
}

// --- prior period all zero: division-by-zero guard, not Infinity/NaN ---
{
  const counts = [...Array(14).fill(0), ...Array(14).fill(5)];
  const t = buyersTrend({ buyers: rows(counts) });
  ok(t === null, "prior-period average of 0 -> null, not Infinity/NaN (division-by-zero guard)");
}

// --- unsorted input rows: function must sort by day itself, not trust order ---
{
  const counts = [...Array(14).fill(14), ...Array(14).fill(7)];
  const ordered = rows(counts);
  const shuffled = [...ordered].reverse();
  const t = buyersTrend({ buyers: shuffled });
  ok(t.prior === 14 && t.recent === 7, "sorts rows by day itself - correct even when input arrives out of order");
}

// --- more than 28 days: only the trailing 28 matter, older history ignored ---
{
  // 40 days total: first 12 are noise (should be ignored entirely), then the
  // same 14-at-14/14-at-7 shape in the trailing 28.
  const counts = [...Array(12).fill(999), ...Array(14).fill(14), ...Array(14).fill(7)];
  const t = buyersTrend({ buyers: rows(counts) });
  ok(t.prior === 14 && t.recent === 7, `only the trailing 28 days feed the comparison, older noise ignored (got prior=${t.prior}, recent=${t.recent})`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
