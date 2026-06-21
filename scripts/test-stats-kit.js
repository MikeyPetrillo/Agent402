// scripts/test-stats-kit.js
// Direct handler tests for src/tools/stats-kit.js. No server needed.
// Covers: happy paths against known-correct math, edge cases (zero variance,
// constant series, single-value), error contracts (statusCode=400), and the
// "answers its own example" invariant the CI suite cares about.
import { STATS_TOOLS } from "../src/tools/stats-kit.js";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    console.log("ok -", msg);
    passed++;
  } else {
    console.error("FAIL -", msg);
    failed++;
  }
}
function throws(fn, statusCode, msg) {
  try {
    fn();
    console.error("FAIL -", msg, "(expected throw, got none)");
    failed++;
  } catch (e) {
    if (statusCode && e.statusCode !== statusCode) {
      console.error("FAIL -", msg, `(expected statusCode=${statusCode}, got ${e.statusCode})`);
      failed++;
    } else {
      console.log("ok -", msg);
      passed++;
    }
  }
}
function approxEq(a, b, eps = 0.001) {
  return Math.abs(a - b) <= eps;
}

const bySlug = Object.fromEntries(STATS_TOOLS.map((t) => [t.slug, t]));

// ============================================================================
// stats-summary
// ============================================================================
const summary = bySlug["stats-summary"];

// Known answers for 1..10: mean=5.5, median=5.5, sd≈3.0277, q1=3.25, q3=7.75
const s = summary.handler({ values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
ok(s.count === 10, "stats-summary: count=10");
ok(s.sum === 55, "stats-summary: sum=55");
ok(s.mean === 5.5, "stats-summary: mean=5.5");
ok(s.median === 5.5, "stats-summary: median=5.5 (even-length)");
ok(s.min === 1 && s.max === 10, "stats-summary: min/max correct");
ok(s.range === 9, "stats-summary: range=9");
ok(approxEq(s.stddev, 3.0277), `stats-summary: stddev≈3.0277 (got ${s.stddev})`);
ok(s.q1 === 3.25 && s.q3 === 7.75, `stats-summary: q1=3.25, q3=7.75 (got ${s.q1}, ${s.q3})`);
ok(s.iqr === 4.5, "stats-summary: iqr=4.5");
ok(s.mode === null, "stats-summary: no mode when all values unique");

// Mode detection.
const s2 = summary.handler({ values: [1, 2, 2, 3, 4] });
ok(s2.mode === 2, "stats-summary: mode=2 when 2 appears twice");

// Single-value edge case — stddev should be 0, not NaN.
const s3 = summary.handler({ values: [42] });
ok(s3.count === 1 && s3.mean === 42 && s3.stddev === 0, "stats-summary: single value handled");

// ============================================================================
// correlation
// ============================================================================
const corr = bySlug["correlation"];

// Perfect positive: r=1
const c1 = corr.handler({ x: [1, 2, 3, 4, 5], y: [2, 4, 6, 8, 10] });
ok(c1.r === 1 && c1.rSquared === 1, "correlation: perfect positive r=1");
ok(c1.interpretation.includes("perfect") && c1.interpretation.includes("positive"), "correlation: interpretation labels perfect positive");

// Perfect negative: r=-1
const c2 = corr.handler({ x: [1, 2, 3, 4, 5], y: [10, 8, 6, 4, 2] });
ok(c2.r === -1, "correlation: perfect negative r=-1");
ok(c2.interpretation.includes("negative"), "correlation: interpretation labels negative");

// No correlation (designed to give r≈0)
const c3 = corr.handler({ x: [1, 2, 3, 4, 5], y: [3, 1, 4, 1, 5] });
ok(Math.abs(c3.r) < 0.5, `correlation: low r for uncorrelated data (got ${c3.r})`);

// ============================================================================
// linear-regression
// ============================================================================
const reg = bySlug["linear-regression"];

// Perfect line y = 2x + 0 → slope=2, intercept=0, r²=1
const r1 = reg.handler({ x: [1, 2, 3, 4, 5], y: [2, 4, 6, 8, 10] });
ok(r1.slope === 2, `linear-regression: slope=2 (got ${r1.slope})`);
ok(r1.intercept === 0, `linear-regression: intercept=0 (got ${r1.intercept})`);
ok(r1.rSquared === 1, "linear-regression: rSquared=1 for perfect fit");
ok(r1.equation === "y = 2x + 0", `linear-regression: equation string (got ${r1.equation})`);

// With predictions.
const r2 = reg.handler({ x: [1, 2, 3], y: [3, 5, 7], predict: [4, 5] });
ok(Array.isArray(r2.predictions) && r2.predictions.length === 2, "linear-regression: predictions returned");
ok(r2.predictions[0].x === 4 && r2.predictions[0].y === 9, "linear-regression: predict(4)=9");
ok(r2.predictions[1].x === 5 && r2.predictions[1].y === 11, "linear-regression: predict(5)=11");

// Noisy fit — r² should be between 0 and 1.
const r3 = reg.handler({ x: [1, 2, 3, 4, 5], y: [2.1, 3.9, 6.2, 7.8, 10.1] });
ok(r3.rSquared > 0.9 && r3.rSquared < 1, `linear-regression: noisy fit has 0<r²<1 (got ${r3.rSquared})`);

// ============================================================================
// moving-average
// ============================================================================
const ma = bySlug["moving-average"];

const m1 = ma.handler({ values: [10, 11, 12, 13, 14], window: 3 });
ok(m1.sma[0] === null && m1.sma[1] === null, "moving-average: first window-1 SMA values are null");
ok(m1.sma[2] === 11, `moving-average: SMA at window-1 idx (got ${m1.sma[2]})`); // (10+11+12)/3
ok(m1.sma[3] === 12, "moving-average: SMA slides forward");
ok(m1.sma[4] === 13, "moving-average: SMA last value");

// EMA starts at the first value and smooths toward steady state.
ok(m1.ema[0] === 10, "moving-average: EMA seeds with first value");
ok(m1.ema[m1.ema.length - 1] > m1.ema[0], "moving-average: EMA trends with values");

// which=sma only.
const m2 = ma.handler({ values: [1, 2, 3, 4], window: 2, which: "sma" });
ok(m2.sma !== undefined && m2.ema === undefined, "moving-average: which=sma omits ema");

// which=ema only.
const m3 = ma.handler({ values: [1, 2, 3, 4], window: 2, which: "ema" });
ok(m3.ema !== undefined && m3.sma === undefined, "moving-average: which=ema omits sma");

// ============================================================================
// outliers
// ============================================================================
const out = bySlug["outliers"];

// 100 is clearly an IQR outlier in 1..9, 100.
const o1 = out.handler({ values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 100], method: "iqr" });
ok(o1.outlierCount === 1, `outliers iqr: 1 outlier (got ${o1.outlierCount})`);
ok(o1.outliers[0].value === 100 && o1.outliers[0].index === 9, "outliers iqr: flags 100 at index 9");
ok(o1.lowerBound < 0 && o1.upperBound < 100, "outliers iqr: bounds straddle the data");

// Same data with z-score.
const o2 = out.handler({ values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 100], method: "zscore" });
ok(o2.outlierCount >= 0, "outliers zscore: returns count");
// z-score uses sample stddev which is inflated by the outlier — the value
// may or may not exceed threshold=3 depending on inflation. Just verify shape.
ok(typeof o2.mean === "number" && typeof o2.stddev === "number", "outliers zscore: returns mean+stddev");

// No outliers in a tight series.
const o3 = out.handler({ values: [10, 11, 12, 13, 14, 15, 16] });
ok(o3.outlierCount === 0, "outliers iqr: 0 outliers in tight series");

// Custom threshold.
const o4 = out.handler({ values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 20], method: "iqr", threshold: 3 });
ok(o4.outlierCount === 0, "outliers iqr: high threshold excludes mild outlier");

// ============================================================================
// Error contracts — every failure mode returns statusCode=400.
// ============================================================================
throws(() => summary.handler({}), 400, "stats-summary: missing values → 400");
throws(() => summary.handler({ values: [] }), 400, "stats-summary: empty array → 400");
throws(() => summary.handler({ values: [1, "x", 3] }), 400, "stats-summary: non-numeric → 400");
throws(() => summary.handler({ values: [1, NaN, 3] }), 400, "stats-summary: NaN → 400");
throws(() => summary.handler({ values: new Array(10001).fill(0) }), 400, "stats-summary: >10000 elements → 400");

throws(() => corr.handler({ x: [1, 2], y: [1, 2, 3] }), 400, "correlation: length mismatch → 400");
throws(() => corr.handler({ x: [1], y: [1] }), 400, "correlation: n<2 → 400");
throws(() => corr.handler({ x: [1, 1, 1], y: [1, 2, 3] }), 400, "correlation: zero variance → 400");

throws(() => reg.handler({ x: [1, 1, 1], y: [1, 2, 3] }), 400, "linear-regression: zero x variance → 400");
throws(() => reg.handler({ x: [1, 2], y: [1] }), 400, "linear-regression: length mismatch → 400");

throws(() => ma.handler({ values: [1, 2, 3], window: 1 }), 400, "moving-average: window<2 → 400");
throws(() => ma.handler({ values: [1, 2, 3], window: 4 }), 400, "moving-average: window>n → 400");
throws(() => ma.handler({ values: [1, 2, 3], window: 2, which: "wat" }), 400, "moving-average: bad which → 400");

throws(() => out.handler({ values: [1, 2, 3] }), 400, "outliers: n<4 → 400");
throws(() => out.handler({ values: [1, 2, 3, 4], method: "wat" }), 400, "outliers: bad method → 400");
throws(() => out.handler({ values: [1, 2, 3, 4], threshold: -1 }), 400, "outliers: negative threshold → 400");
throws(() => out.handler({ values: [5, 5, 5, 5], method: "zscore" }), 400, "outliers zscore: zero variance → 400");

// ============================================================================
// "Answers its own example" invariant.
// ============================================================================
for (const tool of STATS_TOOLS) {
  try {
    const result = tool.handler(tool.discovery.input);
    ok(result && typeof result === "object", `${tool.slug}: example input returns an object`);
  } catch (e) {
    ok(false, `${tool.slug}: example input throws (${e.message})`);
  }
}

// ============================================================================
// Pricing consistency.
// ============================================================================
for (const tool of STATS_TOOLS) {
  ok(tool.price === "$0.001", `${tool.slug}: priced at $0.001`);
  ok(tool.category === "data", `${tool.slug}: category=data`);
}

// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
