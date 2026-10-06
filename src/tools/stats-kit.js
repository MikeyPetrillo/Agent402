// Stats kit — descriptive stats, correlation, regression, moving averages,
// outlier detection. The pieces an agent needs constantly when chaining
// finance-kit / macro-kit / edgar-kit outputs into actual analysis (instead
// of just returning the raw arrays for a human to summarize).
//
// All pure CPU, no dependencies, no network → automatically proof-of-work
// eligible (free tier). Covered by scripts/test-stats-kit.js.

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Coerce an input to a finite-number array. Throws 400 (not 500) on every
// failure mode so callers see an honest message instead of a stack trace.
function toNumbers(value, field) {
  if (!Array.isArray(value)) throw bad(`"${field}" must be an array of numbers`);
  if (value.length === 0) throw bad(`"${field}" must be a non-empty array`);
  // 10k cap is generous (one year of daily prices is ~252, a decade is ~2520).
  // The real ceiling is JSON round-trip cost, not algorithm runtime.
  if (value.length > 10000) throw bad(`"${field}" exceeds 10000 element limit`);
  const out = new Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const n = Number(value[i]);
    if (!Number.isFinite(n)) throw bad(`"${field}[${i}]" is not a finite number (got ${JSON.stringify(value[i])})`);
    out[i] = n;
  }
  return out;
}

// 4-decimal rounding for "human-readable" stats outputs. Internal math uses
// full precision; rounding happens once at the boundary so we don't compound
// floating-point error across operations.
function round4(n) {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 10000) / 10000;
}

function quantile(sortedAsc, q) {
  // Linear interpolation between closest ranks — the same convention numpy
  // and pandas use by default. Cheap and produces the answer most agents
  // expect when they say "q1" or "q3".
  if (sortedAsc.length === 0) return NaN;
  if (q <= 0) return sortedAsc[0];
  if (q >= 1) return sortedAsc[sortedAsc.length - 1];
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

function mean(arr) {
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

// Sample standard deviation (Bessel-corrected, divide by n-1). Matches
// Excel's STDEV.S, Python's statistics.stdev, and what agents almost always
// want when they say "standard deviation" without specifying.
function stddev(arr, mu) {
  if (arr.length < 2) return 0;
  let s = 0;
  for (const v of arr) {
    const d = v - mu;
    s += d * d;
  }
  return Math.sqrt(s / (arr.length - 1));
}

export const STATS_TOOLS = [
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/stats-summary", name: "Stats summary", slug: "stats-summary",
    category: "data", price: "$0.001",
    description:
      "Compute the full descriptive-stats panel for an array of numbers in one call: count, sum, mean, median, mode, stddev (sample), variance, min, max, range, q1, q3, IQR. Beats calling 12 separate tools when you already have the array in front of you.",
    tags: ["stats", "statistics", "descriptive", "mean", "median", "stddev", "quantile", "summary"],
    discovery: {
      bodyType: "json",
      input: { values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
      inputSchema: {
        properties: {
          values: { type: "array", description: "Non-empty array of numbers (max 10000)" },
        },
        required: ["values"],
      },
      output: {
        example: {
          count: 10, sum: 55, mean: 5.5, median: 5.5, mode: null,
          stddev: 3.0277, variance: 9.1667,
          min: 1, max: 10, range: 9,
          q1: 3.25, q3: 7.75, iqr: 4.5,
        },
      },
    },
    handler: (i) => {
      const values = toNumbers(i.values, "values");
      const sorted = [...values].sort((a, b) => a - b);
      const mu = mean(values);
      const sd = stddev(values, mu);

      // Mode: most-frequent value if any value appears more than once,
      // otherwise null (every value is unique → no meaningful mode).
      const counts = new Map();
      for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
      let mode = null;
      let maxCount = 1;
      for (const [v, c] of counts) {
        if (c > maxCount) {
          maxCount = c;
          mode = v;
        }
      }

      const q1 = quantile(sorted, 0.25);
      const q3 = quantile(sorted, 0.75);

      return {
        count: values.length,
        sum: round4(mu * values.length),
        mean: round4(mu),
        median: round4(quantile(sorted, 0.5)),
        mode,
        stddev: round4(sd),
        variance: round4(sd * sd),
        min: sorted[0],
        max: sorted[sorted.length - 1],
        range: round4(sorted[sorted.length - 1] - sorted[0]),
        q1: round4(q1),
        q3: round4(q3),
        iqr: round4(q3 - q1),
      };
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/correlation", name: "Correlation (Pearson)", slug: "correlation",
    category: "data", price: "$0.001",
    description:
      "Pearson correlation coefficient between two equal-length numeric series. Returns r (the correlation, -1 to 1), r² (variance explained), n (sample size). Use this to ask things like: is a stock's daily return correlated with a macro indicator? Are two FRED series moving together?",
    tags: ["stats", "correlation", "pearson", "r-squared", "series"],
    discovery: {
      bodyType: "json",
      input: { x: [1, 2, 3, 4, 5], y: [2, 4, 6, 8, 10] },
      inputSchema: {
        properties: {
          x: { type: "array", description: "First numeric series" },
          y: { type: "array", description: "Second numeric series (same length as x)" },
        },
        required: ["x", "y"],
      },
      output: { example: { n: 5, r: 1, rSquared: 1, interpretation: "perfect positive linear relationship" } },
    },
    handler: (i) => {
      const x = toNumbers(i.x, "x");
      const y = toNumbers(i.y, "y");
      if (x.length !== y.length) throw bad(`"x" and "y" must have equal length (got ${x.length} and ${y.length})`);
      if (x.length < 2) throw bad(`need at least 2 paired observations to compute correlation`);

      const mx = mean(x);
      const my = mean(y);
      let num = 0, dx2 = 0, dy2 = 0;
      for (let k = 0; k < x.length; k++) {
        const dx = x[k] - mx;
        const dy = y[k] - my;
        num += dx * dy;
        dx2 += dx * dx;
        dy2 += dy * dy;
      }
      const denom = Math.sqrt(dx2 * dy2);
      // denom=0 means one of the series is constant — correlation is undefined,
      // not "0". Surface that honestly instead of returning a fake number.
      if (denom === 0) throw bad(`correlation undefined - at least one input series has zero variance (all values equal)`);
      const r = num / denom;

      // A one-line interpretation helps agents do the right thing without
      // re-deriving the rule. Bands chosen to match the conventional
      // "weak/moderate/strong" heuristics used in stats textbooks.
      const ar = Math.abs(r);
      const dir = r >= 0 ? "positive" : "negative";
      let strength;
      if (ar >= 0.9) strength = ar === 1 ? "perfect" : "very strong";
      else if (ar >= 0.7) strength = "strong";
      else if (ar >= 0.4) strength = "moderate";
      else if (ar >= 0.2) strength = "weak";
      else strength = "negligible";
      const interpretation = strength === "negligible"
        ? "negligible linear relationship"
        : `${strength} ${dir} linear relationship`;

      return { n: x.length, r: round4(r), rSquared: round4(r * r), interpretation };
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/linear-regression", name: "Linear regression (OLS)", slug: "linear-regression",
    category: "data", price: "$0.001",
    description:
      "Fit a least-squares line y = slope·x + intercept to two equal-length series. Returns slope, intercept, r² (variance explained), and optionally predicted y values for new x inputs - useful for trend extrapolation (e.g. project next quarter's revenue from the last 8 quarters).",
    tags: ["stats", "regression", "ols", "trend", "slope", "intercept", "r-squared"],
    discovery: {
      bodyType: "json",
      input: { x: [1, 2, 3, 4, 5], y: [2.1, 4.0, 6.1, 7.9, 10.2], predict: [6, 7] },
      inputSchema: {
        properties: {
          x: { type: "array", description: "Independent variable series (e.g. time)" },
          y: { type: "array", description: "Dependent variable series (same length as x)" },
          predict: { type: "array", description: "Optional x values to predict y for, using the fitted line" },
        },
        required: ["x", "y"],
      },
      output: {
        example: {
          n: 5, slope: 2.01, intercept: 0.03, rSquared: 0.9997,
          equation: "y = 2.01x + 0.03",
          predictions: [{ x: 6, y: 12.09 }, { x: 7, y: 14.1 }],
        },
      },
    },
    handler: (i) => {
      const x = toNumbers(i.x, "x");
      const y = toNumbers(i.y, "y");
      if (x.length !== y.length) throw bad(`"x" and "y" must have equal length (got ${x.length} and ${y.length})`);
      if (x.length < 2) throw bad(`need at least 2 paired observations to fit a line`);

      const mx = mean(x);
      const my = mean(y);
      let num = 0, denom = 0;
      for (let k = 0; k < x.length; k++) {
        const dx = x[k] - mx;
        num += dx * (y[k] - my);
        denom += dx * dx;
      }
      if (denom === 0) throw bad(`cannot fit - "x" has zero variance (all values equal)`);
      const slope = num / denom;
      const intercept = my - slope * mx;

      // r² from the regression itself (1 - SS_res / SS_tot) — equivalent to
      // r² from Pearson but computed directly here so it stays self-contained.
      let ssRes = 0, ssTot = 0;
      for (let k = 0; k < x.length; k++) {
        const pred = slope * x[k] + intercept;
        ssRes += (y[k] - pred) ** 2;
        ssTot += (y[k] - my) ** 2;
      }
      const rSquared = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

      const out = {
        n: x.length,
        slope: round4(slope),
        intercept: round4(intercept),
        rSquared: round4(rSquared),
        equation: `y = ${round4(slope)}x + ${round4(intercept)}`,
      };
      if (Array.isArray(i.predict)) {
        const px = toNumbers(i.predict, "predict");
        out.predictions = px.map((xv) => ({ x: xv, y: round4(slope * xv + intercept) }));
      }
      return out;
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/moving-average", name: "Moving average (SMA + EMA)", slug: "moving-average", aliases: ["ema", "sma", "exponential-moving-average", "closing-prices"],
    category: "data", price: "$0.001",
    description:
      "Compute simple (SMA) and exponential (EMA) moving averages over a numeric series. Returns one value per input position - the first (window-1) SMA values are null since there isn't enough history. EMA uses the standard alpha = 2/(window+1) smoothing factor used in technical analysis.",
    tags: ["stats", "moving-average", "sma", "ema", "smoothing", "timeseries"],
    discovery: {
      bodyType: "json",
      input: { values: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19], window: 3 },
      inputSchema: {
        properties: {
          values: { type: "array", description: "Numeric series (max 10000)" },
          window: { type: "number", description: "Window size, 2 to values.length" },
          which: { type: "string", description: "\"sma\", \"ema\", or \"both\" (default \"both\")" },
        },
        required: ["values", "window"],
      },
      output: {
        example: {
          window: 3, count: 10,
          sma: [null, null, 11, 12, 13, 14, 15, 16, 17, 18],
          ema: [10, 10.5, 11.25, 12.125, 13.0625, 14.0312, 15.0156, 16.0078, 17.0039, 18.002],
        },
      },
    },
    handler: (i) => {
      const values = toNumbers(i.values, "values");
      const window = Number(i.window);
      if (!Number.isInteger(window) || window < 2 || window > values.length) {
        throw bad(`"window" must be an integer between 2 and values.length (${values.length})`);
      }
      const which = i.which || "both";
      if (!["sma", "ema", "both"].includes(which)) throw bad(`"which" must be "sma", "ema", or "both"`);

      const out = { window, count: values.length };

      if (which === "sma" || which === "both") {
        // Rolling sum — O(n) total instead of O(n·window). Avoids quadratic
        // blow-up on large arrays with large windows.
        const sma = new Array(values.length).fill(null);
        let sum = 0;
        for (let k = 0; k < values.length; k++) {
          sum += values[k];
          if (k >= window) sum -= values[k - window];
          if (k >= window - 1) sma[k] = round4(sum / window);
        }
        out.sma = sma;
      }

      if (which === "ema" || which === "both") {
        const alpha = 2 / (window + 1);
        const ema = new Array(values.length);
        ema[0] = round4(values[0]);
        for (let k = 1; k < values.length; k++) {
          ema[k] = round4(alpha * values[k] + (1 - alpha) * ema[k - 1]);
        }
        out.ema = ema;
      }

      return out;
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/outliers", name: "Outlier detection (IQR + z-score)", slug: "outliers",
    category: "data", price: "$0.001",
    description:
      "Flag outliers in a numeric series using either the IQR rule (Tukey fences at 1.5·IQR - robust, default) or z-score (|z| > threshold - assumes normality). Returns the outlier values + their indices + the thresholds used so you can decide whether to trust them.",
    tags: ["stats", "outliers", "iqr", "z-score", "anomaly"],
    discovery: {
      bodyType: "json",
      input: { values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 100], method: "iqr" },
      inputSchema: {
        properties: {
          values: { type: "array", description: "Numeric series (max 10000, at least 4 values)" },
          method: { type: "string", description: "\"iqr\" (default) or \"zscore\"" },
          threshold: { type: "number", description: "IQR multiplier (default 1.5) or z-score cutoff (default 3)" },
        },
        required: ["values"],
      },
      output: {
        example: {
          method: "iqr", n: 10, threshold: 1.5,
          lowerBound: -4.625, upperBound: 14.375,
          outliers: [{ index: 9, value: 100 }],
          outlierCount: 1,
        },
      },
    },
    handler: (i) => {
      const values = toNumbers(i.values, "values");
      if (values.length < 4) throw bad(`need at least 4 values to detect outliers`);
      const method = i.method || "iqr";
      if (!["iqr", "zscore"].includes(method)) throw bad(`"method" must be "iqr" or "zscore"`);

      const out = { method, n: values.length };

      if (method === "iqr") {
        const threshold = i.threshold === undefined ? 1.5 : Number(i.threshold);
        if (!Number.isFinite(threshold) || threshold <= 0) throw bad(`"threshold" must be a positive number`);
        const sorted = [...values].sort((a, b) => a - b);
        const q1 = quantile(sorted, 0.25);
        const q3 = quantile(sorted, 0.75);
        const iqr = q3 - q1;
        const lo = q1 - threshold * iqr;
        const hi = q3 + threshold * iqr;
        const outliers = [];
        for (let k = 0; k < values.length; k++) {
          if (values[k] < lo || values[k] > hi) outliers.push({ index: k, value: values[k] });
        }
        out.threshold = threshold;
        out.lowerBound = round4(lo);
        out.upperBound = round4(hi);
        out.outliers = outliers;
        out.outlierCount = outliers.length;
      } else {
        const threshold = i.threshold === undefined ? 3 : Number(i.threshold);
        if (!Number.isFinite(threshold) || threshold <= 0) throw bad(`"threshold" must be a positive number`);
        const mu = mean(values);
        const sd = stddev(values, mu);
        if (sd === 0) throw bad(`z-score outliers undefined - series has zero variance (all values equal)`);
        const outliers = [];
        for (let k = 0; k < values.length; k++) {
          const z = (values[k] - mu) / sd;
          if (Math.abs(z) > threshold) outliers.push({ index: k, value: values[k], z: round4(z) });
        }
        out.threshold = threshold;
        out.mean = round4(mu);
        out.stddev = round4(sd);
        out.outliers = outliers;
        out.outlierCount = outliers.length;
      }

      return out;
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/rsi", name: "RSI (relative strength index)", slug: "rsi",
    aliases: ["relative-strength-index", "rsi-indicator", "overbought-oversold"],
    category: "data", price: "$0.001",
    description:
      "Compute the relative strength index (Wilder's smoothing, default period 14) over a price series you supply, such as daily closes. Returns one value per input position (null until the first full period), the latest value, and a reading: overbought at 70 or above, oversold at 30 or below, else neutral. No market data is fetched: pass your own closes.",
    tags: ["stats", "rsi", "technical-analysis", "momentum", "timeseries"],
    discovery: {
      bodyType: "json",
      input: { values: [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64], period: 14 },
      inputSchema: {
        properties: {
          values: { type: "array", description: "Price series, oldest first (closes), at least period + 1 values, max 10000" },
          period: { type: "number", description: "Look-back period, 2 to 200 (default 14)" },
        },
        required: ["values"],
      },
      output: {
        example: {
          period: 14, count: 20,
          rsi: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, 70.4641, 66.2496, 66.4809, 69.3469, 66.2947, 57.915],
          latest: 57.915, reading: "neutral",
        },
      },
    },
    handler: (i) => {
      const values = toNumbers(i.values, "values");
      const period = i.period === undefined || i.period === null || i.period === "" ? 14 : Number(i.period);
      if (!Number.isInteger(period) || period < 2 || period > 200) throw bad('"period" must be an integer between 2 and 200');
      if (values.length < period + 1) throw bad(`"values" needs at least period + 1 (${period + 1}) prices; got ${values.length}`);
      const rsi = new Array(values.length).fill(null);
      let gain = 0, loss = 0;
      for (let k = 1; k <= period; k++) {
        const d = values[k] - values[k - 1];
        if (d > 0) gain += d; else loss -= d;
      }
      let avgGain = gain / period, avgLoss = loss / period;
      const rsiOf = () => (avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss));
      rsi[period] = round4(rsiOf());
      for (let k = period + 1; k < values.length; k++) {
        const d = values[k] - values[k - 1];
        avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
        rsi[k] = round4(rsiOf());
      }
      const latest = rsi[rsi.length - 1];
      return { period, count: values.length, rsi, latest, reading: latest >= 70 ? "overbought" : latest <= 30 ? "oversold" : "neutral" };
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/gcd-lcm", name: "GCD + LCM", slug: "gcd-lcm",
    aliases: ["greatest-common-divisor", "least-common-multiple", "gcd", "lcm", "hcf"],
    category: "data", price: "$0.001",
    description:
      "Greatest common divisor and least common multiple of two or more integers, computed exactly (arbitrary precision). Useful for cycle alignment, scheduling periods and fraction work. Signs are ignored; a zero makes the LCM zero. Results beyond 2^53 come back as strings so no digit is lost.",
    tags: ["math", "gcd", "lcm", "integers", "number-theory"],
    discovery: {
      bodyType: "json",
      input: { numbers: [12, 18, 30] },
      inputSchema: {
        properties: {
          numbers: { type: "array", description: "Two to 1000 integers (numbers or digit strings)" },
        },
        required: ["numbers"],
      },
      output: { example: { count: 3, gcd: 6, lcm: 180 } },
    },
    handler: (i) => {
      const raw = Array.isArray(i.numbers) ? i.numbers : typeof i.numbers === "string" ? i.numbers.split(/[\s,]+/).filter(Boolean) : null;
      if (!raw || raw.length < 2 || raw.length > 1000) throw bad('"numbers" must be an array of 2 to 1000 integers');
      const nums = raw.map((v, k) => {
        const t = typeof v === "number" ? (Number.isSafeInteger(v) ? String(v) : null) : String(v).trim();
        if (!t || !/^[-+]?\d{1,300}$/.test(t)) throw bad(`numbers[${k}] is not an integer${typeof v === "number" ? " within 2^53 (send larger values as digit strings)" : ""}`);
        const b = BigInt(t);
        return b < 0n ? -b : b;
      });
      const gcd2 = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
      let g = nums[0], l = nums[0];
      for (const n of nums.slice(1)) {
        g = gcd2(g, n);
        l = l === 0n || n === 0n ? 0n : (l / gcd2(l, n)) * n;
        if (l.toString().length > 1000) throw bad("the LCM exceeds 1000 digits");
      }
      const out = (b) => (b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b.toString());
      return { count: nums.length, gcd: out(g), lcm: out(l) };
    },
  },
];
