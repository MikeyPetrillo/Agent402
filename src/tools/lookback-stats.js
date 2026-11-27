// Look-back statistics: what the price-history tools answer.
//
// A tool that reads a source's historical series (prices, candles, market
// cap, volume) answers figures computed here from that series and never the
// series: no price, market cap, volume, candle or time-and-value pair of the
// source is returned. What may appear is a percent, a ratio, a share, a
// count, or the TIME at which something computed here happened (the start
// and low of the largest fall, the best step).
//
// Pure functions over parallel arrays; no I/O. Every figure's formula is in
// the METHOD sentences below, which the tools answer in their `method` field.
// Percents are rounded to 4 decimals; a figure the series is too short to
// give is null, never a made-up 0.

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : (v != null && v !== "" && typeof v !== "object" && Number.isFinite(Number(v)) ? Number(v) : null));
const r4 = (v) => (Number.isFinite(v) ? +v.toFixed(4) : null);
const isoOf = (ms) => new Date(ms).toISOString();
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** The label of a spacing in ms ("5m", "1h", "1d"), or null. */
export function spacingLabel(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < DAY_MS) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / DAY_MS)}d`;
}

/** The median positive gap between consecutive times, in ms, or null. */
export function medianSpacingMs(timesMs) {
  const deltas = [];
  for (let k = 1; k < timesMs.length; k++) {
    const d = timesMs[k] - timesMs[k - 1];
    if (Number.isFinite(d) && d > 0) deltas.push(d);
  }
  if (!deltas.length) return null;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)];
}

/** The observations of a series that can be computed over: a finite time and
 *  a positive finite value, in the order given. */
export function observationsOf(timesMs, values) {
  const ts = [], vs = [];
  const n = Math.min(timesMs?.length ?? 0, values?.length ?? 0);
  for (let k = 0; k < n; k++) {
    const t = fin(timesMs[k]), v = fin(values[k]);
    if (t != null && v != null && v > 0) { ts.push(t); vs.push(v); }
  }
  return { ts, vs };
}

/** The window a set of observations covers: times only, never a value. */
export function windowOf(ts) {
  const spacing = medianSpacingMs(ts);
  return {
    from: ts.length ? isoOf(ts[0]) : null,
    to: ts.length ? isoOf(ts[ts.length - 1]) : null,
    observations: ts.length,
    spacing: spacingLabel(spacing),
    days: ts.length >= 2 ? r4((ts[ts.length - 1] - ts[0]) / DAY_MS) : null,
  };
}

/** The statistics of one series of observations, in the blocks a tool
 *  answers: `summary` (numbers only), `drawdown` (the times of the largest
 *  fall, null when the series never fell), `extremes` (when the window's high
 *  and low were set), `steps` (the returns between consecutive observations:
 *  how many, the share above zero, their deviation over the window, the best
 *  and the worst) and `trend`.
 *  `opts.first` replaces the first observation as the base of changePct (a
 *  candle series starts at its first open); `opts.highs` / `opts.lows`
 *  (parallel to the INPUT arrays) are where the window's high and low are
 *  looked for (candle extremes). */
export function lookbackStats(timesMs, values, opts = {}) {
  const { ts, vs } = observationsOf(timesMs, values);
  const n = vs.length;
  const summary = { changePct: null, volatilityPct: null, maxDrawdownPct: null, fromHighPct: null, fromLowPct: null };
  const out = { summary, drawdown: null, extremes: null, steps: null, trend: null };
  if (!n) return out;
  const last = vs[n - 1];
  const base = fin(opts.first) > 0 ? fin(opts.first) : vs[0];
  summary.changePct = r4((last / base - 1) * 100);

  // Step returns between consecutive observations.
  const logs = [], steps = [];
  for (let k = 1; k < n; k++) { logs.push(Math.log(vs[k] / vs[k - 1])); steps.push((vs[k] / vs[k - 1] - 1) * 100); }
  const spacing = medianSpacingMs(ts);
  let realized = null;
  if (n >= 3 && spacing) {
    const m = mean(logs);
    const sd = Math.sqrt(logs.reduce((a, r) => a + (r - m) ** 2, 0) / (logs.length - 1));
    summary.volatilityPct = r4(sd * Math.sqrt(YEAR_MS / spacing) * 100);
    realized = r4(sd * Math.sqrt(logs.length) * 100);
  }
  if (steps.length) {
    let bi = 0, wi = 0, up = 0;
    for (let k = 0; k < steps.length; k++) { if (steps[k] > steps[bi]) bi = k; if (steps[k] < steps[wi]) wi = k; if (steps[k] > 0) up++; }
    out.steps = { count: steps.length, upSharePct: r4((up / steps.length) * 100), realizedVolatilityPct: realized, best: { at: isoOf(ts[bi + 1]), returnPct: r4(steps[bi]) }, worst: { at: isoOf(ts[wi + 1]), returnPct: r4(steps[wi]) } };
  }

  // Largest fall from a running high to a later low, with its times.
  if (n >= 2) {
    let peak = 0, worst = 0, wPeak = 0, wTrough = 0;
    for (let k = 0; k < n; k++) {
      if (vs[k] > vs[peak]) peak = k;
      const dd = (vs[k] / vs[peak] - 1) * 100;
      if (dd < worst) { worst = dd; wPeak = peak; wTrough = k; }
    }
    summary.maxDrawdownPct = worst === 0 ? 0 : r4(worst);
    if (worst < 0) {
      let rec = null;
      for (let k = wTrough + 1; k < n; k++) if (vs[k] >= vs[wPeak]) { rec = k; break; }
      out.drawdown = { peakAt: isoOf(ts[wPeak]), troughAt: isoOf(ts[wTrough]), recoveredAt: rec == null ? null : isoOf(ts[rec]) };
    }
  }

  // Where the last observation stands in the window's range.
  let hi = -Infinity, lo = Infinity, hiT = null, loT = null;
  if (Array.isArray(opts.highs) && Array.isArray(opts.lows)) {
    for (let k = 0; k < timesMs.length; k++) {
      const t = fin(timesMs[k]), h = fin(opts.highs[k]), l = fin(opts.lows[k]);
      if (t == null) continue;
      if (h != null && h > 0 && h > hi) { hi = h; hiT = t; }
      if (l != null && l > 0 && l < lo) { lo = l; loT = t; }
    }
  }
  if (hiT == null || loT == null) {
    hi = -Infinity; lo = Infinity;
    for (let k = 0; k < n; k++) { if (vs[k] > hi) { hi = vs[k]; hiT = ts[k]; } if (vs[k] < lo) { lo = vs[k]; loT = ts[k]; } }
  }
  summary.fromHighPct = r4((last / hi - 1) * 100);
  summary.fromLowPct = r4((last / lo - 1) * 100);
  out.extremes = { highAt: isoOf(hiT), lowAt: isoOf(loT) };

  // Trend: least-squares line through ln(value) against time in days.
  if (n >= 3 && ts[n - 1] > ts[0]) {
    const xs = ts.map((t) => (t - ts[0]) / DAY_MS), ys = vs.map((v) => Math.log(v));
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let k = 0; k < n; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; syy += (ys[k] - my) ** 2; }
    if (sxx > 0) {
      const slope = r4((Math.exp(sxy / sxx) - 1) * 100);
      out.trend = { slopePctPerDay: slope, r2: syy > 0 ? r4((sxy * sxy) / (sxx * syy)) : null, direction: slope > 0 ? "up" : slope < 0 ? "down" : "flat" };
    }
  }
  return out;
}

/** Day-over-day statistics: the last observation of each UTC day is that
 *  day's close. Null when the series gives fewer than two daily returns. */
export function dailyStats(timesMs, values) {
  const { ts, vs } = observationsOf(timesMs, values);
  const days = [];
  for (let k = 0; k < ts.length; k++) {
    const date = isoOf(ts[k]).slice(0, 10);
    if (days.length && days[days.length - 1].date === date) days[days.length - 1].v = vs[k];
    else days.push({ date, v: vs[k] });
  }
  if (days.length < 3) return null;
  let best = null, worst = null, up = 0;
  for (let k = 1; k < days.length; k++) {
    const r = (days[k].v / days[k - 1].v - 1) * 100;
    if (!best || r > best.r) best = { date: days[k].date, r };
    if (!worst || r < worst.r) worst = { date: days[k].date, r };
    if (r > 0) up++;
  }
  return {
    days: days.length,
    bestDay: { date: best.date, returnPct: r4(best.r) },
    worstDay: { date: worst.date, returnPct: r4(worst.r) },
    upDaySharePct: r4((up / (days.length - 1)) * 100),
  };
}

/** The shape of a candle series, from rows of [time, open, high, low, close].
 *  Null when no row is a whole candle. */
export function candleShape(rows) {
  const cs = [];
  for (const r of rows || []) {
    if (!Array.isArray(r) || r.length < 5) continue;
    const o = fin(r[1]), h = fin(r[2]), l = fin(r[3]), c = fin(r[4]);
    if (o == null || h == null || l == null || c == null || o <= 0 || l <= 0 || h < l) continue;
    cs.push({ o, h, l, c });
  }
  if (!cs.length) return null;
  const ranged = cs.filter((x) => x.h > x.l);
  const share = (pick) => (ranged.length ? r4(mean(ranged.map((x) => pick(x) / (x.h - x.l))) * 100) : null);
  const trs = [];
  for (let k = 1; k < cs.length; k++) {
    const pc = cs[k - 1].c, x = cs[k];
    if (pc > 0) trs.push(Math.max(x.h - x.l, Math.abs(x.h - pc), Math.abs(x.l - pc)) / pc);
  }
  return {
    upSharePct: r4((cs.filter((x) => x.c > x.o).length / cs.length) * 100),
    bodyPct: share((x) => Math.abs(x.c - x.o)),
    upperWickPct: share((x) => x.h - Math.max(x.o, x.c)),
    lowerWickPct: share((x) => Math.min(x.o, x.c) - x.l),
    atrPct: trs.length ? r4(mean(trs) * 100) : null,
  };
}

/** Market-cap and volume figures of a window, as changes and ratios only,
 *  from arrays parallel by index. Null when neither series has a value. */
export function activityStats(caps, vols) {
  const cap = (caps || []).map(fin), vol = (vols || []).map(fin);
  const capsPos = cap.filter((v) => v != null && v > 0), volsPos = vol.filter((v) => v != null && v > 0);
  if (!capsPos.length && !volsPos.length) return null;
  const turn = [];
  for (let k = 0; k < Math.min(cap.length, vol.length); k++) if (cap[k] > 0 && vol[k] != null && vol[k] >= 0) turn.push(vol[k] / cap[k]);
  const volMean = mean(volsPos);
  return {
    marketCapChangePct: capsPos.length >= 2 ? r4((capsPos[capsPos.length - 1] / capsPos[0] - 1) * 100) : null,
    volumeVsWindowMeanPct: volsPos.length >= 2 ? r4((volsPos[volsPos.length - 1] / volMean - 1) * 100) : null,
    volumeChangePct: volsPos.length >= 2 ? r4((volsPos[volsPos.length - 1] / volsPos[0] - 1) * 100) : null,
    turnoverMeanPct: turn.length ? r4(mean(turn) * 100) : null,
  };
}

// --- the sentences a tool answers in `method` ------------------------------------
export const METHOD_SUMMARY =
  "summary.changePct is the last observation over the first, minus 1, in percent. volatilityPct is the sample standard deviation of the log returns between consecutive observations, scaled to a 365-day year from their median spacing. maxDrawdownPct is the largest fall from a running high to a later low; drawdown gives its peakAt, troughAt and recoveredAt (the first later observation at or above that high, null when none). fromHighPct and fromLowPct are the last observation over the window's high and over its low, minus 1; extremes gives when they were set (highAt, lowAt). steps counts the returns between consecutive observations: upSharePct is the share above zero, realizedVolatilityPct the same deviation as volatilityPct scaled to the window (times the square root of the count), best and worst the largest and smallest with the time of the later observation. trend is a least-squares line through the natural log of the observations against time in days: slopePctPerDay is e to the slope, minus 1, in percent, r2 its fit.";
export const METHOD_DAILY =
  "daily takes the last observation of each UTC day as that day's close: bestDay and worstDay are the largest and smallest day-over-day returns, upDaySharePct the share of them above zero (null under three days).";
export const METHOD_ACTIVITY =
  "activity.marketCapChangePct and volumeChangePct are last over first, minus 1; volumeVsWindowMeanPct is the last 24h volume against the window's mean; turnoverMeanPct is the mean of 24h volume over market cap.";
export const METHOD_CANDLES =
  "candleStats reads each candle: upSharePct is the share that closed above their open; bodyPct, upperWickPct and lowerWickPct are the mean body and wicks as a share of the candle's high-to-low range; atrPct is the mean true range (the greatest of high minus low and the gaps from the previous close to the high and to the low) over the previous close.";
export const METHOD_CLOSE = "Every figure is computed here from the source's series, which is not returned. Information only, not investment advice.";
export const NOT_ADVICE = "Information only, not investment advice.";

// --- the blocks beside the published sample ----------------------------------------
// A listing's sample shows the identity fields and the summary; every answer
// also carries these blocks (discovery.output.optional: typed and described
// in /openapi.json and on the tool page).
const obj = (description) => ({ type: "object", description });
export const OPTIONAL_WINDOW = obj("What the figures are computed over: from and to (the times of the first and last observation), observations, spacing (5m, 1h, 1d) and days. Times and counts only.");
export const OPTIONAL_DRAWDOWN = obj("When the largest fall ran: peakAt, troughAt and recoveredAt (null when the window ends below the peak). Null when the series never fell.");
export const OPTIONAL_EXTREMES = obj("When the window's high and low were set: highAt, lowAt.");
export const OPTIONAL_STEPS = obj("The returns between consecutive observations: count, upSharePct, realizedVolatilityPct, and best and worst as { at, returnPct }.");
export const OPTIONAL_TREND = obj("Least-squares trend of the log of the observations: slopePctPerDay, r2 and direction (up, down or flat). Null under three observations.");
export const OPTIONAL_DAILY = obj("Day-over-day figures from each UTC day's last observation: days, bestDay and worstDay as { date, returnPct }, upDaySharePct. Null under three days.");
export const OPTIONAL_ACTIVITY = obj("Market cap and volume as changes and ratios: marketCapChangePct, volumeChangePct, volumeVsWindowMeanPct, turnoverMeanPct.");

export const OPTIONAL_METHOD = { type: "string", description: "The formula of every figure in the answer." };
export const OPTIONAL_WITHDRAWN = { type: "string", description: "The fields this route stopped returning and what stands in their place." };
/** The optional-output declaration of a look-back tool (`extra` adds or, with null, removes a block). */
export function lookbackOptional(extra = {}) {
  const all = { window: OPTIONAL_WINDOW, drawdown: OPTIONAL_DRAWDOWN, extremes: OPTIONAL_EXTREMES, steps: OPTIONAL_STEPS, trend: OPTIONAL_TREND, daily: OPTIONAL_DAILY, activity: OPTIONAL_ACTIVITY, method: OPTIONAL_METHOD, withdrawn: OPTIONAL_WITHDRAWN, ...extra };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v));
}
