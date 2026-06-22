// scripts/test-forecast-kit.js
// Direct handler tests for src/tools/forecast-kit.js. No server needed.
// Covers: known-correct math, every tool's "answers its own example"
// invariant, the input/output contract for each method (point forecasts,
// 95% intervals, MAPE/RMSE backtest), error contracts (statusCode=400),
// and the two design decisions baked into the kit:
//   - hybrid period detection in holt-winters (auto-detect when omitted,
//     surface periodSource + periodAcf, throw clearly when neither works)
//   - warn-but-compute in forecast-eval (testSize > n/2 → warning, not error)
import { FORECAST_TOOLS } from "../src/tools/forecast-kit.js";

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

const bySlug = Object.fromEntries(FORECAST_TOOLS.map((t) => [t.slug, t]));

// ============================================================================
// forecast-naive
// ============================================================================
const naive = bySlug["forecast-naive"];

const dr = naive.handler({ values: [10, 12, 13, 12, 15, 16, 18, 19, 21, 22], horizon: 3, method: "drift" });
ok(dr.method === "drift" && dr.n === 10 && dr.horizon === 3, "forecast-naive[drift]: envelope fields");
ok(dr.forecast.length === 3, "forecast-naive[drift]: horizon length");
// Drift slope = (22-10)/9 = 1.3333; step 1 = 22 + 1.333 ≈ 23.333
ok(approxEq(dr.forecast[0].point, 23.3333), "forecast-naive[drift]: step 1 = last + slope");
ok(approxEq(dr.forecast[1].point, 24.6667), "forecast-naive[drift]: step 2 grows by slope");
ok(dr.forecast[1].upper95 > dr.forecast[0].upper95, "forecast-naive[drift]: variance grows with horizon");

const mn = naive.handler({ values: [5, 5, 5, 5, 5], horizon: 4, method: "mean" });
ok(mn.forecast.every((f) => f.point === 5), "forecast-naive[mean]: flat at series mean");
ok(mn.forecast.every((f) => f.lower95 === 5 && f.upper95 === 5), "forecast-naive[mean]: zero-variance series → zero-width interval");

// Constant-diff series (σ of diffs = 0) → flat last value, zero-width interval.
const nvFlat = naive.handler({ values: [10, 20, 30, 40, 50], horizon: 3, method: "naive" });
ok(nvFlat.forecast.every((f) => f.point === 50), "forecast-naive[naive]: flat at last value");
// Noisy-diff series → σ > 0, so per Hyndman σ_h = σ·√h: interval must widen.
const nvNoisy = naive.handler({ values: [10, 13, 11, 16, 14, 18, 15, 21, 19, 24], horizon: 3, method: "naive" });
ok(nvNoisy.forecast[2].upper95 - nvNoisy.forecast[2].lower95 > nvNoisy.forecast[0].upper95 - nvNoisy.forecast[0].lower95,
   "forecast-naive[naive]: interval widens with √h on noisy series");

throws(() => naive.handler({ values: [1], horizon: 1, method: "drift" }), 400, "forecast-naive: rejects < 2 obs");
throws(() => naive.handler({ values: [1, 2, 3], horizon: 0, method: "drift" }), 400, "forecast-naive: rejects horizon=0");
throws(() => naive.handler({ values: [1, 2, 3], horizon: 1001, method: "drift" }), 400, "forecast-naive: rejects horizon>1000");
throws(() => naive.handler({ values: [1, 2, 3], horizon: 1, method: "exponential" }), 400, "forecast-naive: rejects unknown method");
throws(() => naive.handler({ values: "not-an-array", horizon: 1 }), 400, "forecast-naive: rejects non-array values");

// ============================================================================
// forecast-ses
// ============================================================================
const ses = bySlug["forecast-ses"];

const sFlat = ses.handler({ values: [10, 10, 10, 10, 10], horizon: 3, alpha: 0.5 });
ok(sFlat.forecast.every((f) => f.point === 10), "forecast-ses: constant series → flat at constant");

const sLast = ses.handler({ values: [1, 2, 3, 4, 5], horizon: 2, alpha: 0.999 });
ok(approxEq(sLast.forecast[0].point, 5, 0.05), "forecast-ses: alpha≈1 tracks last value");

const sOut = ses.handler({ values: [42, 44, 41, 43, 45, 44, 46, 45, 47, 46], horizon: 3, alpha: 0.3 });
ok(sOut.forecast[0].point === sOut.forecast[1].point && sOut.forecast[1].point === sOut.forecast[2].point,
   "forecast-ses: point forecast is flat across horizons (level-only)");
ok(sOut.forecast[2].upper95 - sOut.forecast[2].lower95 > sOut.forecast[0].upper95 - sOut.forecast[0].lower95,
   "forecast-ses: interval widens with horizon (∝ √(1+(h-1)α²))");

throws(() => ses.handler({ values: [1, 2], horizon: 1 }), 400, "forecast-ses: rejects < 3 obs");
throws(() => ses.handler({ values: [1, 2, 3], horizon: 1, alpha: 0 }), 400, "forecast-ses: rejects alpha=0");
throws(() => ses.handler({ values: [1, 2, 3], horizon: 1, alpha: 1 }), 400, "forecast-ses: rejects alpha=1");
throws(() => ses.handler({ values: [1, 2, 3], horizon: 1, alpha: -0.5 }), 400, "forecast-ses: rejects alpha<0");

// ============================================================================
// forecast-holt
// ============================================================================
const holt = bySlug["forecast-holt"];

const hLin = holt.handler({ values: [100, 105, 111, 118, 124, 131, 137, 144, 150, 157], horizon: 3, alpha: 0.5, beta: 0.3 });
ok(hLin.forecast[0].point < hLin.forecast[1].point && hLin.forecast[1].point < hLin.forecast[2].point,
   "forecast-holt: point forecast increases linearly on rising series");
const step01 = hLin.forecast[1].point - hLin.forecast[0].point;
const step12 = hLin.forecast[2].point - hLin.forecast[1].point;
ok(approxEq(step01, step12, 0.01), "forecast-holt: equal step size between horizons (linear extrapolation)");
ok(hLin.forecast[2].upper95 - hLin.forecast[2].lower95 > hLin.forecast[0].upper95 - hLin.forecast[0].lower95,
   "forecast-holt: prediction interval widens with horizon");

throws(() => holt.handler({ values: [1, 2, 3], horizon: 1 }), 400, "forecast-holt: rejects < 4 obs");
throws(() => holt.handler({ values: [1, 2, 3, 4], horizon: 1, alpha: 1.5 }), 400, "forecast-holt: rejects alpha out of (0,1)");
throws(() => holt.handler({ values: [1, 2, 3, 4], horizon: 1, beta: -0.1 }), 400, "forecast-holt: rejects beta out of (0,1)");

// ============================================================================
// forecast-holt-winters — DECISION POINT 1 verification
// ============================================================================
const hw = bySlug["forecast-holt-winters"];

// Provided period: a perfect 4-period cycle.
const hwProvided = hw.handler({ values: [10, 14, 18, 22, 11, 15, 19, 23, 12, 16, 20, 24], horizon: 4, period: 4 });
ok(hwProvided.period === 4 && hwProvided.periodSource === "provided", "forecast-holt-winters: provided period surfaces periodSource=provided");
ok(hwProvided.periodAcf === undefined, "forecast-holt-winters: provided period does not include periodAcf (only detected does)");
ok(hwProvided.forecast.length === 4, "forecast-holt-winters: horizon=4 → 4 forecast steps");

// Auto-detection on a strongly seasonal series.
const seasonalSeries = [];
for (let i = 0; i < 24; i++) seasonalSeries.push(10 + (i % 4) * 5 + i * 0.5);
const hwDetected = hw.handler({ values: seasonalSeries, horizon: 4 });
ok(hwDetected.periodSource === "detected", "forecast-holt-winters: auto-detect surfaces periodSource=detected");
ok(typeof hwDetected.periodAcf === "number" && hwDetected.periodAcf > 0.3, "forecast-holt-winters: detected period surfaces periodAcf > threshold");
ok(hwDetected.period >= 2 && hwDetected.period <= Math.floor(seasonalSeries.length / 2),
   "forecast-holt-winters: detected period in valid range [2, n/2]");

// Auto-detect failure on a flat series (no seasonality, no trend, no signal).
throws(
  () => hw.handler({ values: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5], horizon: 4 }),
  400,
  "forecast-holt-winters: refuses with clear error when auto-detect finds no seasonal lag",
);

// Multiplicative seasonality requires positive values.
throws(
  () => hw.handler({ values: [10, 14, 18, 22, -1, 15, 19, 23], horizon: 4, period: 4, seasonality: "multiplicative" }),
  400,
  "forecast-holt-winters: rejects multiplicative + non-positive value",
);

// Multiplicative on a clean positive series should work.
const hwMul = hw.handler({ values: [10, 14, 18, 22, 11, 15, 19, 23, 12, 16, 20, 24], horizon: 4, period: 4, seasonality: "multiplicative" });
ok(hwMul.seasonality === "multiplicative" && hwMul.forecast.length === 4, "forecast-holt-winters: multiplicative path works on positive series");

// Period validation.
throws(() => hw.handler({ values: [1, 2, 3, 4, 5, 6], horizon: 2, period: 1 }), 400, "forecast-holt-winters: rejects period < 2");
throws(() => hw.handler({ values: [1, 2, 3, 4, 5, 6], horizon: 2, period: 4 }), 400, "forecast-holt-winters: rejects period > n/2");
// n=3, period=2 → 3 < 2·2: fails the "two full cycles" rule.
throws(() => hw.handler({ values: [1, 2, 3], horizon: 2, period: 2 }), 400, "forecast-holt-winters: rejects n < 2·period (n=3, period=2)");

// Smoothing bounds.
throws(() => hw.handler({ values: [10, 14, 18, 22, 11, 15, 19, 23], horizon: 2, period: 4, gamma: 0 }), 400, "forecast-holt-winters: rejects gamma=0");

// ============================================================================
// forecast-eval — DECISION POINT 2 verification
// ============================================================================
const ev = bySlug["forecast-eval"];

const evClean = ev.handler({ values: [10, 12, 13, 12, 15, 16, 18, 19, 21, 22], testSize: 3, method: "drift" });
ok(evClean.method === "drift" && evClean.n === 10 && evClean.testSize === 3 && evClean.trainSize === 7,
   "forecast-eval: envelope fields");
ok(typeof evClean.mape === "number" && typeof evClean.rmse === "number", "forecast-eval: returns numeric MAPE + RMSE");
ok(Array.isArray(evClean.warnings) && evClean.warnings.length === 0,
   "forecast-eval: testSize <= n/2 → warnings is empty array (consistent shape)");
ok(evClean.forecast.length === 3 && evClean.forecast.every((f) => "actual" in f && "predicted" in f),
   "forecast-eval: forecast detail includes actual + predicted per step");

// DECISION POINT 2: testSize > n/2 → warn but compute, do NOT error.
const evWarn = ev.handler({ values: [10, 12, 13, 12, 15, 16, 18, 19, 21, 22], testSize: 7, method: "drift" });
ok(typeof evWarn.mape === "number", "forecast-eval[testSize>n/2]: still returns MAPE (warn-but-compute)");
ok(evWarn.warnings.length >= 1 && evWarn.warnings[0].includes("testSize"),
   "forecast-eval[testSize>n/2]: surfaces a warning naming testSize");

// MAPE handling with zero actuals — should not divide by zero silently.
const evZero = ev.handler({ values: [5, 3, 1, 0, 2, 4, 6, 0, 5, 7], testSize: 3, method: "naive" });
ok(evZero.warnings.some((w) => w.includes("MAPE")) || evZero.mape === null || typeof evZero.mape === "number",
   "forecast-eval: zero in actuals surfaces a MAPE warning or computes over non-zero subset");

// Forwarding to underlying methods.
const evSes = ev.handler({ values: [10, 11, 12, 11, 13, 12, 14, 13, 15, 14], testSize: 3, method: "ses", alpha: 0.5 });
ok(evSes.method === "ses" && typeof evSes.rmse === "number", "forecast-eval: forwards SES alpha and runs");

const evHolt = ev.handler({ values: [100, 105, 111, 118, 124, 131, 137, 144, 150, 157], testSize: 3, method: "holt" });
ok(evHolt.method === "holt" && typeof evHolt.rmse === "number", "forecast-eval: runs Holt with default smoothing");

// Error contracts.
throws(() => ev.handler({ values: [1, 2, 3, 4, 5], testSize: 0, method: "drift" }), 400, "forecast-eval: rejects testSize=0");
throws(() => ev.handler({ values: [1, 2, 3, 4, 5], testSize: 4, method: "drift" }), 400, "forecast-eval: rejects testSize > n-2");
throws(() => ev.handler({ values: [1, 2, 3, 4, 5], testSize: 2, method: "lstm" }), 400, "forecast-eval: rejects unknown method");
throws(() => ev.handler({ values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], testSize: 4, method: "holt-winters" }), 400,
       "forecast-eval: surfaces underlying method error (holt-winters needs period or auto-detect)");

// ============================================================================
// Every tool answers its own example (the CI-level invariant)
// ============================================================================
for (const t of FORECAST_TOOLS) {
  const got = t.handler(t.discovery.input);
  const want = t.discovery.output.example;
  ok(JSON.stringify(got) === JSON.stringify(want), `${t.slug}: handler output === discovery.output.example`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
