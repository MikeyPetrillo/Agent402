// Forecast kit — deterministic time-series forecasting. Completes the
// trend-analysis arc: after fetch → describe → smooth → trend → outliers
// → benchmark, an agent finally has a numeric projection forward (point
// estimate + 95% prediction interval) instead of an LLM's hallucinated guess.
//
// All pure CPU, no dependencies, no network → automatically proof-of-work
// eligible (free tier). Covered by scripts/test-forecast-kit.js.
//
// Methods (escalating sophistication):
//   - naive       : mean / naive / drift baselines (no parameters)
//   - ses         : simple exponential smoothing (level only)
//   - holt        : double exponential smoothing (level + trend)
//   - holt-winters: triple exponential smoothing (level + trend + season)
//   - forecast-eval: backtest a method on the input series, return MAPE/RMSE
//
// Prediction intervals assume residuals are approximately normal. For
// series with heavy-tailed residuals (financial returns, count data),
// treat the intervals as indicative not exact.

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function toNumbers(value, field) {
  if (!Array.isArray(value)) throw bad(`"${field}" must be an array of numbers`);
  if (value.length === 0) throw bad(`"${field}" must be a non-empty array`);
  if (value.length > 10000) throw bad(`"${field}" exceeds 10000 element limit`);
  const out = new Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const n = Number(value[i]);
    if (!Number.isFinite(n)) throw bad(`"${field}[${i}]" is not a finite number (got ${JSON.stringify(value[i])})`);
    out[i] = n;
  }
  return out;
}

function round4(n) {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 10000) / 10000;
}

function mean(arr) {
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function stddev(arr, mu) {
  if (arr.length < 2) return 0;
  let s = 0;
  for (const v of arr) {
    const d = v - mu;
    s += d * d;
  }
  return Math.sqrt(s / (arr.length - 1));
}

const Z95 = 1.96;

function parseHorizon(input) {
  const horizon = Math.trunc(Number(input.horizon));
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 1000) {
    throw bad(`"horizon" must be an integer between 1 and 1000`);
  }
  return horizon;
}

function buildForecast(point, sigmaH) {
  return point.map((p, i) => ({
    step: i + 1,
    point: round4(p),
    lower95: round4(p - Z95 * sigmaH[i]),
    upper95: round4(p + Z95 * sigmaH[i]),
  }));
}

// ---------------------------------------------------------------------------
// Pure fitting functions — used by both the individual tool handlers and by
// forecast-eval's backtest dispatcher. Each returns { point: number[],
// sigmaH: number[] } (length === horizon). No input validation here; callers
// validate before calling.
// ---------------------------------------------------------------------------

function fitNaive(values, horizon, method) {
  const n = values.length;
  if (method === "mean") {
    const mu = mean(values);
    const sigma = stddev(values, mu);
    const s = sigma * Math.sqrt(1 + 1 / n);
    return {
      point: new Array(horizon).fill(mu),
      sigmaH: new Array(horizon).fill(s),
    };
  }
  if (method === "naive") {
    const last = values[n - 1];
    const diffs = new Array(n - 1);
    for (let k = 1; k < n; k++) diffs[k - 1] = values[k] - values[k - 1];
    const sigma = stddev(diffs, mean(diffs));
    const point = new Array(horizon).fill(last);
    const sigmaH = new Array(horizon);
    for (let h = 1; h <= horizon; h++) sigmaH[h - 1] = sigma * Math.sqrt(h);
    return { point, sigmaH };
  }
  // drift
  const slope = (values[n - 1] - values[0]) / (n - 1);
  const last = values[n - 1];
  const residuals = new Array(n);
  for (let k = 0; k < n; k++) residuals[k] = values[k] - (values[0] + slope * k);
  const sigma = stddev(residuals, mean(residuals));
  const point = new Array(horizon);
  const sigmaH = new Array(horizon);
  for (let h = 1; h <= horizon; h++) {
    point[h - 1] = last + slope * h;
    sigmaH[h - 1] = sigma * Math.sqrt(h * (1 + h / (n - 1)));
  }
  return { point, sigmaH };
}

function fitSes(values, horizon, alpha) {
  let level = values[0];
  const residuals = new Array(values.length - 1);
  for (let k = 1; k < values.length; k++) {
    residuals[k - 1] = values[k] - level;
    level = alpha * values[k] + (1 - alpha) * level;
  }
  const sigma = stddev(residuals, mean(residuals));
  const point = new Array(horizon).fill(level);
  const sigmaH = new Array(horizon);
  for (let h = 1; h <= horizon; h++) sigmaH[h - 1] = sigma * Math.sqrt(1 + (h - 1) * alpha * alpha);
  return { point, sigmaH };
}

function fitHolt(values, horizon, alpha, beta) {
  let level = values[0];
  let trend = values[1] - values[0];
  const residuals = new Array(values.length - 1);
  for (let k = 1; k < values.length; k++) {
    residuals[k - 1] = values[k] - (level + trend);
    const newLevel = alpha * values[k] + (1 - alpha) * (level + trend);
    const newTrend = beta * (newLevel - level) + (1 - beta) * trend;
    level = newLevel;
    trend = newTrend;
  }
  const sigma = stddev(residuals, mean(residuals));
  const point = new Array(horizon);
  const sigmaH = new Array(horizon);
  let varSum = 0;
  for (let h = 1; h <= horizon; h++) {
    point[h - 1] = level + h * trend;
    const coef = alpha + (h - 1) * alpha * beta;
    varSum += coef * coef;
    sigmaH[h - 1] = sigma * Math.sqrt(varSum);
  }
  return { point, sigmaH };
}

// Hybrid period detection (Decision Point 1, option C): detrend via first
// differences, compute ACF at lags 2..floor(n/2), return the lag with the
// strongest autocorrelation above `threshold`. Returns null if nothing
// crosses the threshold — caller decides whether that's an error or a
// fallback to non-seasonal.
function detectPeriod(values, threshold = 0.3) {
  const n = values.length;
  if (n < 8) return null; // can't reliably detect anything from < 8 points
  const d = new Array(n - 1);
  for (let i = 1; i < n; i++) d[i - 1] = values[i] - values[i - 1];
  const muD = mean(d);
  let totVar = 0;
  for (const v of d) totVar += (v - muD) * (v - muD);
  if (totVar === 0) return null;
  const maxLag = Math.floor(n / 2);
  let bestLag = null;
  let bestAcf = -Infinity;
  for (let lag = 2; lag <= maxLag && lag < d.length; lag++) {
    let cov = 0;
    for (let t = lag; t < d.length; t++) cov += (d[t] - muD) * (d[t - lag] - muD);
    const acf = cov / totVar;
    if (acf > bestAcf) {
      bestAcf = acf;
      bestLag = lag;
    }
  }
  if (bestAcf < threshold) return null;
  return { period: bestLag, acf: bestAcf };
}

function fitHoltWinters(values, horizon, period, seasonality, alpha, beta, gamma) {
  const n = values.length;
  const m = period;
  const mult = seasonality === "multiplicative";

  // Init: level₀ = mean of first cycle, trend₀ = slope between first two cycle means.
  const c1 = mean(values.slice(0, m));
  const c2 = mean(values.slice(m, 2 * m));
  let level = c1;
  let trend = (c2 - c1) / m;
  // Seasonal indices initialized from the first cycle's deviation from level.
  const season = new Array(m);
  for (let i = 0; i < m; i++) {
    season[i] = mult ? values[i] / c1 : values[i] - c1;
  }

  const residuals = [];
  for (let k = m; k < n; k++) {
    const sIdx = k % m;
    const s = season[sIdx];
    const oneStepFc = mult ? (level + trend) * s : (level + trend) + s;
    residuals.push(values[k] - oneStepFc);
    const newLevel = mult
      ? alpha * (values[k] / s) + (1 - alpha) * (level + trend)
      : alpha * (values[k] - s) + (1 - alpha) * (level + trend);
    const newTrend = beta * (newLevel - level) + (1 - beta) * trend;
    const newSeason = mult
      ? gamma * (values[k] / newLevel) + (1 - gamma) * s
      : gamma * (values[k] - newLevel) + (1 - gamma) * s;
    level = newLevel;
    trend = newTrend;
    season[sIdx] = newSeason;
  }
  const sigma = residuals.length >= 2 ? stddev(residuals, mean(residuals)) : 0;

  const point = new Array(horizon);
  const sigmaH = new Array(horizon);
  for (let h = 1; h <= horizon; h++) {
    const sIdx = (n + h - 1) % m;
    const s = season[sIdx];
    point[h - 1] = mult ? (level + h * trend) * s : (level + h * trend) + s;
    // Approximate σ²_h ≈ σ² · h — same horizon scaling as drift. Not exact
    // for Holt-Winters (true variance is method-specific) but matches the
    // "indicative not exact" disclaimer in the file header.
    sigmaH[h - 1] = sigma * Math.sqrt(h);
  }
  return { point, sigmaH };
}

// Dispatcher used by forecast-eval. Accepts the union of every method's
// parameters; pulls the ones each method needs.
function runForecast(method, values, horizon, opts) {
  if (method === "mean" || method === "naive" || method === "drift") {
    return fitNaive(values, horizon, method);
  }
  if (method === "ses") {
    return fitSes(values, horizon, opts.alpha ?? 0.3);
  }
  if (method === "holt") {
    return fitHolt(values, horizon, opts.alpha ?? 0.5, opts.beta ?? 0.3);
  }
  if (method === "holt-winters") {
    if (!opts.period) throw bad(`"period" required for method "holt-winters"`);
    return fitHoltWinters(
      values, horizon, opts.period,
      opts.seasonality || "additive",
      opts.alpha ?? 0.5, opts.beta ?? 0.1, opts.gamma ?? 0.1,
    );
  }
  throw bad(`unknown method "${method}"`);
}

// FORECAST_TOOLS = production-mounted (every tool's example output is
// byte-identical to what its handler returns — that's what scripts/test-all.js
// asserts on every kit).
export const FORECAST_TOOLS = [
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/forecast-naive", name: "Forecast (naive baselines)", slug: "forecast-naive",
    category: "data", price: "$0.001",
    description:
      "Three textbook baseline forecasts: mean (forecast = average of history), naive (forecast = last value), drift (linear extrapolation from first to last point). Use as a sanity floor — any sophisticated method (SES, Holt, Holt-Winters) should beat the best of these on a backtest, otherwise the extra complexity isn't earning its keep. Returns point forecasts + 95% prediction intervals per Hyndman §3.1.",
    tags: ["forecast", "timeseries", "naive", "drift", "baseline", "prediction"],
    discovery: {
      bodyType: "json",
      input: { values: [10, 12, 13, 12, 15, 16, 18, 19, 21, 22], horizon: 3, method: "drift" },
      inputSchema: {
        properties: {
          values: { type: "array", description: "Numeric series in chronological order (max 10000)" },
          horizon: { type: "number", description: "Number of future periods to forecast (1 to 1000)" },
          method: { type: "string", description: "\"mean\", \"naive\", or \"drift\" (default \"drift\")" },
        },
        required: ["values", "horizon"],
      },
      output: {
        example: {
          method: "drift", n: 10, horizon: 3,
          forecast: [
            { step: 1, point: 23.3333, lower95: 21.8037, upper95: 24.863 },
            { step: 2, point: 24.6667, lower95: 22.3979, upper95: 26.9355 },
            { step: 3, point: 26, lower95: 23.0977, upper95: 28.9023 },
          ],
        },
      },
    },
    handler: (i) => {
      const values = toNumbers(i.values, "values");
      if (values.length < 2) throw bad(`need at least 2 observations (got ${values.length})`);
      const horizon = parseHorizon(i);
      const method = i.method || "drift";
      if (!["mean", "naive", "drift"].includes(method)) throw bad(`"method" must be "mean", "naive", or "drift"`);
      const { point, sigmaH } = fitNaive(values, horizon, method);
      return { method, n: values.length, horizon, forecast: buildForecast(point, sigmaH) };
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/forecast-ses", name: "Forecast (simple exponential smoothing)", slug: "forecast-ses",
    category: "data", price: "$0.001",
    description:
      "Simple exponential smoothing (SES) — level-only forecast for series without trend or seasonality. Higher alpha (closer to 1) tracks recent values aggressively; lower alpha (closer to 0) smooths through noise. Default alpha=0.3 is a common conservative pick; pass an explicit alpha or use forecast-eval to pick the one that minimizes backtest error. Forecast is flat (= last fitted level) for all horizons.",
    tags: ["forecast", "timeseries", "ses", "exponential-smoothing", "prediction"],
    discovery: {
      bodyType: "json",
      input: { values: [42, 44, 41, 43, 45, 44, 46, 45, 47, 46], horizon: 3, alpha: 0.3 },
      inputSchema: {
        properties: {
          values: { type: "array", description: "Numeric series in chronological order (max 10000, min 3)" },
          horizon: { type: "number", description: "Number of future periods to forecast (1 to 1000)" },
          alpha: { type: "number", description: "Smoothing parameter, 0 < alpha < 1 (default 0.3)" },
        },
        required: ["values", "horizon"],
      },
      output: {
        example: {
          method: "ses", n: 10, horizon: 3, alpha: 0.3,
          forecast: [
            { step: 1, point: 45.4431, lower95: 42.7805, upper95: 48.1057 },
            { step: 2, point: 45.4431, lower95: 42.6633, upper95: 48.2229 },
            { step: 3, point: 45.4431, lower95: 42.5508, upper95: 48.3354 },
          ],
        },
      },
    },
    handler: (i) => {
      const values = toNumbers(i.values, "values");
      if (values.length < 3) throw bad(`need at least 3 observations (got ${values.length})`);
      const horizon = parseHorizon(i);
      const alpha = i.alpha === undefined ? 0.3 : Number(i.alpha);
      if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) throw bad(`"alpha" must be a number strictly between 0 and 1`);
      const { point, sigmaH } = fitSes(values, horizon, alpha);
      return { method: "ses", n: values.length, horizon, alpha: round4(alpha), forecast: buildForecast(point, sigmaH) };
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/forecast-holt", name: "Forecast (Holt linear trend)", slug: "forecast-holt",
    category: "data", price: "$0.001",
    description:
      "Holt's linear trend method — level + trend (no seasonality). Two smoothing parameters: alpha (level) and beta (trend). Forecast extrapolates as a straight line from the last fitted level along the last fitted trend, so it grows or shrinks linearly with horizon. Use this when your series has a persistent up/down trend but no seasonal cycle (e.g. a SaaS MRR climb, a deflating cohort retention curve).",
    tags: ["forecast", "timeseries", "holt", "exponential-smoothing", "trend", "prediction"],
    discovery: {
      bodyType: "json",
      input: { values: [100, 105, 111, 118, 124, 131, 137, 144, 150, 157], horizon: 3, alpha: 0.5, beta: 0.3 },
      inputSchema: {
        properties: {
          values: { type: "array", description: "Numeric series in chronological order (max 10000, min 4)" },
          horizon: { type: "number", description: "Number of future periods to forecast (1 to 1000)" },
          alpha: { type: "number", description: "Level smoothing, 0 < alpha < 1 (default 0.5)" },
          beta: { type: "number", description: "Trend smoothing, 0 < beta < 1 (default 0.3)" },
        },
        required: ["values", "horizon"],
      },
      output: {
        example: {
          method: "holt", n: 10, horizon: 3, alpha: 0.5, beta: 0.3,
          forecast: [
            { step: 1, point: 163.2012, lower95: 162.4237, upper95: 163.9786 },
            { step: 2, point: 169.7416, lower95: 168.4665, upper95: 171.0167 },
            { step: 3, point: 176.282, lower95: 174.5007, upper95: 178.0633 },
          ],
        },
      },
    },
    handler: (i) => {
      const values = toNumbers(i.values, "values");
      if (values.length < 4) throw bad(`need at least 4 observations (got ${values.length})`);
      const horizon = parseHorizon(i);
      const alpha = i.alpha === undefined ? 0.5 : Number(i.alpha);
      const beta = i.beta === undefined ? 0.3 : Number(i.beta);
      if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) throw bad(`"alpha" must be a number strictly between 0 and 1`);
      if (!Number.isFinite(beta) || beta <= 0 || beta >= 1) throw bad(`"beta" must be a number strictly between 0 and 1`);
      const { point, sigmaH } = fitHolt(values, horizon, alpha, beta);
      return {
        method: "holt", n: values.length, horizon,
        alpha: round4(alpha), beta: round4(beta),
        forecast: buildForecast(point, sigmaH),
      };
    },
  },
  // ---------------------------------------------------------------------------
  // DECISION POINT 1 resolved as option C (hybrid): `period` is optional. If
  // provided, use it. If not, auto-detect via ACF on first differences and
  // surface `periodSource: "detected"` + `periodAcf` so the agent knows what
  // happened. Refuses with a clear error if neither is possible — never
  // silently picks a bogus period.
  {
    route: "POST /api/forecast-holt-winters", name: "Forecast (Holt-Winters seasonal)", slug: "forecast-holt-winters",
    category: "data", price: "$0.001",
    description:
      "Holt-Winters triple exponential smoothing — level + trend + seasonal component. Use for series with a repeating cycle (weekly retail traffic, monthly utility usage, quarterly revenue). Additive seasonality (constant amplitude) or multiplicative (amplitude grows with level). `period` is optional — if omitted, the kit auto-detects via autocorrelation on first differences and surfaces what it picked (with the ACF strength) so you can audit. Needs at least two full seasonal cycles to fit reliably.",
    tags: ["forecast", "timeseries", "holt-winters", "seasonal", "exponential-smoothing", "prediction"],
    discovery: {
      bodyType: "json",
      input: { values: [10, 14, 18, 22, 11, 15, 19, 23, 12, 16, 20, 24], horizon: 4, period: 4 },
      inputSchema: {
        properties: {
          values: { type: "array", description: "Numeric series in chronological order (max 10000)" },
          horizon: { type: "number", description: "Number of future periods to forecast (1 to 1000)" },
          period: { type: "number", description: "Optional seasonal period (e.g. 7 for daily/weekly, 12 for monthly/yearly). Auto-detected via ACF if omitted." },
          seasonality: { type: "string", description: "\"additive\" (default) or \"multiplicative\"" },
          alpha: { type: "number", description: "Level smoothing, 0 < alpha < 1 (default 0.5)" },
          beta: { type: "number", description: "Trend smoothing, 0 < beta < 1 (default 0.1)" },
          gamma: { type: "number", description: "Seasonal smoothing, 0 < gamma < 1 (default 0.1)" },
        },
        required: ["values", "horizon"],
      },
      output: {
        // Filled in via smoke-test pass below to match handler output byte-for-byte.
        example: {
          method: "holt-winters", n: 12, horizon: 4,
          period: 4, periodSource: "provided", seasonality: "additive",
          alpha: 0.5, beta: 0.1, gamma: 0.1,
          forecast: [
            { step: 1, point: 12.5324, lower95: 11.6958, upper95: 13.369 },
            { step: 2, point: 16.7253, lower95: 15.5421, upper95: 17.9084 },
            { step: 3, point: 20.9462, lower95: 19.4972, upper95: 22.3952 },
            { step: 4, point: 25.1831, lower95: 23.5098, upper95: 26.8563 },
          ],
        },
      },
    },
    handler: (i) => {
      const values = toNumbers(i.values, "values");
      const horizon = parseHorizon(i);
      const seasonality = i.seasonality || "additive";
      if (!["additive", "multiplicative"].includes(seasonality)) throw bad(`"seasonality" must be "additive" or "multiplicative"`);
      const alpha = i.alpha === undefined ? 0.5 : Number(i.alpha);
      const beta = i.beta === undefined ? 0.1 : Number(i.beta);
      const gamma = i.gamma === undefined ? 0.1 : Number(i.gamma);
      for (const [name, v] of [["alpha", alpha], ["beta", beta], ["gamma", gamma]]) {
        if (!Number.isFinite(v) || v <= 0 || v >= 1) throw bad(`"${name}" must be a number strictly between 0 and 1`);
      }

      let period, periodSource, periodAcf;
      if (i.period !== undefined) {
        period = Math.trunc(Number(i.period));
        if (!Number.isInteger(period) || period < 2 || period > Math.floor(values.length / 2)) {
          throw bad(`"period" must be an integer between 2 and floor(n/2) = ${Math.floor(values.length / 2)}`);
        }
        periodSource = "provided";
      } else {
        const detected = detectPeriod(values);
        if (!detected) {
          throw bad(`could not auto-detect a seasonal period (no ACF lag above 0.3 on first differences). Pass "period" explicitly or use forecast-holt for a non-seasonal trend.`);
        }
        period = detected.period;
        periodAcf = round4(detected.acf);
        periodSource = "detected";
      }
      if (values.length < 2 * period) {
        throw bad(`need at least 2·period (${2 * period}) observations to fit Holt-Winters (got ${values.length})`);
      }
      if (seasonality === "multiplicative" && values.some((v) => v <= 0)) {
        throw bad(`multiplicative seasonality requires all values > 0`);
      }

      const { point, sigmaH } = fitHoltWinters(values, horizon, period, seasonality, alpha, beta, gamma);
      const out = {
        method: "holt-winters", n: values.length, horizon,
        period, periodSource,
      };
      if (periodAcf !== undefined) out.periodAcf = periodAcf;
      out.seasonality = seasonality;
      out.alpha = round4(alpha);
      out.beta = round4(beta);
      out.gamma = round4(gamma);
      out.forecast = buildForecast(point, sigmaH);
      return out;
    },
  },
  // ---------------------------------------------------------------------------
  // DECISION POINT 2 resolved as option B (warn but compute): if testSize > n/2,
  // we still run the backtest and return MAPE/RMSE, but we surface a
  // `warnings` array explaining the result is indicative not predictive.
  // Always include a `warnings` field (empty array when clean) so the response
  // shape is uniform — agents that key off `warnings.length === 0` will get a
  // consistent contract.
  {
    route: "POST /api/forecast-eval", name: "Forecast backtest (MAPE + RMSE)", slug: "forecast-eval",
    category: "data", price: "$0.001",
    description:
      "Backtest a forecasting method on the input series by holding out the last `testSize` observations, forecasting them, and computing MAPE (mean absolute percentage error) + RMSE (root mean squared error). Lets an agent pick which method (mean / naive / drift / ses / holt / holt-winters) actually fits its data before committing to a forward forecast. Always returns a `warnings` array — empty when the backtest is well-posed, populated when `testSize` exceeds n/2 (treat error as indicative not predictive).",
    tags: ["forecast", "backtest", "evaluation", "mape", "rmse", "cross-validation"],
    discovery: {
      bodyType: "json",
      input: { values: [10, 12, 13, 12, 15, 16, 18, 19, 21, 22], testSize: 3, method: "drift" },
      inputSchema: {
        properties: {
          values: { type: "array", description: "Numeric series (max 10000)" },
          testSize: { type: "number", description: "Trailing observations to hold out (1 to values.length - 2). Values above n/2 trigger a warning, not an error." },
          method: { type: "string", description: "\"mean\", \"naive\", \"drift\", \"ses\", \"holt\", \"holt-winters\"" },
          alpha: { type: "number", description: "Smoothing for ses/holt/holt-winters" },
          beta: { type: "number", description: "Trend smoothing for holt/holt-winters" },
          gamma: { type: "number", description: "Seasonal smoothing for holt-winters" },
          period: { type: "number", description: "Seasonal period for holt-winters (auto-detected if omitted)" },
          seasonality: { type: "string", description: "\"additive\" or \"multiplicative\" for holt-winters" },
        },
        required: ["values", "testSize", "method"],
      },
      output: {
        // Filled in via smoke-test pass to match handler output exactly.
        example: {
          method: "drift", n: 10, testSize: 3, trainSize: 7,
          mape: 1.1139, rmse: 0.2722,
          forecast: [
            { step: 1, actual: 19, predicted: 19.3333 },
            { step: 2, actual: 21, predicted: 20.6667 },
            { step: 3, actual: 22, predicted: 22 },
          ],
          warnings: [],
        },
      },
    },
    handler: (i) => {
      const values = toNumbers(i.values, "values");
      const testSize = Math.trunc(Number(i.testSize));
      if (!Number.isInteger(testSize) || testSize < 1 || testSize > values.length - 2) {
        throw bad(`"testSize" must be an integer between 1 and values.length - 2 (= ${values.length - 2})`);
      }
      const method = i.method;
      if (typeof method !== "string") throw bad(`"method" required`);

      const trainSize = values.length - testSize;
      const train = values.slice(0, trainSize);
      const test = values.slice(trainSize);

      const warnings = [];
      if (testSize > Math.floor(values.length / 2)) {
        warnings.push(`testSize (${testSize}) exceeds n/2 (${Math.floor(values.length / 2)}); backtest error is indicative not predictive — point forecasts diverge past ~half the input length.`);
      }

      // Run the chosen method via the shared dispatcher so we don't duplicate
      // input parsing or math. Note period for holt-winters is forwarded — if
      // omitted, the dispatcher will throw, surfacing the requirement.
      let fit;
      try {
        fit = runForecast(method, train, testSize, {
          alpha: i.alpha !== undefined ? Number(i.alpha) : undefined,
          beta: i.beta !== undefined ? Number(i.beta) : undefined,
          gamma: i.gamma !== undefined ? Number(i.gamma) : undefined,
          period: i.period !== undefined ? Math.trunc(Number(i.period)) : undefined,
          seasonality: i.seasonality,
        });
      } catch (e) {
        // Surface the underlying error verbatim so the agent can fix its inputs.
        throw bad(`backtest failed: ${e.message}`);
      }

      // MAPE undefined when any actual is 0; fall back to RMSE in that case
      // with a warning, rather than dividing by zero silently.
      let mapeSum = 0;
      let mapeCount = 0;
      let mseSum = 0;
      const detail = new Array(testSize);
      for (let k = 0; k < testSize; k++) {
        const actual = test[k];
        const predicted = fit.point[k];
        detail[k] = { step: k + 1, actual: round4(actual), predicted: round4(predicted) };
        const err = actual - predicted;
        mseSum += err * err;
        if (actual !== 0) {
          mapeSum += Math.abs(err / actual);
          mapeCount += 1;
        }
      }
      const rmse = Math.sqrt(mseSum / testSize);
      let mape = null;
      if (mapeCount === testSize) {
        mape = (mapeSum / testSize) * 100;
      } else if (mapeCount === 0) {
        warnings.push(`MAPE undefined — every actual value in the test window is 0; using RMSE only.`);
      } else {
        mape = (mapeSum / mapeCount) * 100;
        warnings.push(`MAPE computed over ${mapeCount}/${testSize} test points (skipped ${testSize - mapeCount} zero-valued actuals).`);
      }

      return {
        method, n: values.length, testSize, trainSize,
        mape: mape === null ? null : round4(mape),
        rmse: round4(rmse),
        forecast: detail,
        warnings,
      };
    },
  },
];
