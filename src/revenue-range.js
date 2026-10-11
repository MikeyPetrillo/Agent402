// Date ranges for the /revenue charts and their daily series.
//
// One parser for the page and the three daily APIs, so a shared link and the
// JSON behind it read the same window. Days are UTC calendar days
// (YYYY-MM-DD), both ends inclusive. Filtering by date only: no row is
// relabeled or dropped for any other reason.
//
// Accepted query forms (exactly one):
//   range=7d|30d|90d|1y|all     a preset ending today
//   from=YYYY-MM-DD&to=...      a custom window (either end may be omitted)
//   days=N                      the last N days, today included
// Garbage is refused, not guessed: a malformed date, from after to, a start
// after today, a span over the cap, or two forms mixed.

export const REVENUE_RANGE_PRESETS = Object.freeze({ "7d": 7, "30d": 30, "90d": 90, "1y": 365, all: null });
export const REVENUE_RANGE_PRESET_LABELS = Object.freeze({ "7d": "7 days", "30d": "30 days", "90d": "90 days", "1y": "1 year", all: "All" });
// 30 days: a daily bar per day stays readable at phone width, and it matches
// the 30-day windows the page's card and Decide figures already use.
export const REVENUE_DEFAULT_RANGE = "30d";
// Ten years: far past any history this ledger holds, small enough that a
// request cannot ask the server to walk an unbounded calendar.
export const REVENUE_RANGE_MAX_SPAN_DAYS = 3660;
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const utcToday = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export function addDays(day, n) { return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10); }
export function spanDays(from, to) { return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1; }
// A real calendar date: 2026-02-31 parses in some engines, so round-trip it.
export function isUtcDay(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

/** True when the query names any range form (the default responses stay as they are without one). */
export function hasRangeQuery(q = {}) {
  return ["range", "from", "to", "days"].some((k) => q[k] !== undefined);
}

/**
 * Parse a range from a query object.
 *   firstDay: the first day the series holds data (the start is clamped up to it)
 *   now:      clock, for tests
 *   fallback: the preset used when no range form is present (null = no window)
 * Returns { window } or { error }. window = { from, to, days, preset }, with
 * `preset` null for a custom window.
 */
export function parseRevenueRange(q = {}, { firstDay = null, now = Date.now(), fallback = null } = {}) {
  const today = utcToday(now);
  const one = (k) => {
    const v = q[k];
    if (v === undefined) return undefined;
    if (typeof v !== "string") return { bad: `${k} must be given once` };
    return v.trim();
  };
  const range = one("range"), from0 = one("from"), to0 = one("to"), days0 = one("days");
  for (const v of [range, from0, to0, days0]) if (v && typeof v === "object") return { error: v.bad };
  const forms = [range !== undefined, from0 !== undefined || to0 !== undefined, days0 !== undefined].filter(Boolean).length;
  if (forms > 1) return { error: "use one of range, from/to, or days" };
  let from, to, preset = null;
  if (forms === 0) {
    if (!fallback) return { window: null };
    return parseRevenueRange({ range: fallback }, { firstDay, now });
  }
  if (range !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(REVENUE_RANGE_PRESETS, range)) return { error: `range must be one of ${Object.keys(REVENUE_RANGE_PRESETS).join(", ")}` };
    preset = range;
    to = today;
    const n = REVENUE_RANGE_PRESETS[range];
    from = n == null ? (firstDay && firstDay <= today ? firstDay : today) : addDays(today, -(n - 1));
  } else if (days0 !== undefined) {
    if (!/^\d{1,5}$/.test(days0)) return { error: "days must be a whole number" };
    const n = Number(days0);
    if (n < 1 || n > REVENUE_RANGE_MAX_SPAN_DAYS) return { error: `days must be 1 to ${REVENUE_RANGE_MAX_SPAN_DAYS}` };
    to = today;
    from = addDays(today, -(n - 1));
  } else {
    if (from0 !== undefined && !isUtcDay(from0)) return { error: "from must be a date as YYYY-MM-DD" };
    if (to0 !== undefined && !isUtcDay(to0)) return { error: "to must be a date as YYYY-MM-DD" };
    to = to0 || today;
    from = from0 || (firstDay && firstDay <= to ? firstDay : to);
    if (from > to) return { error: "from must be on or before to" };
    if (from > today) return { error: `from is after today (${today}, UTC)` };
    if (spanDays(from, to) > REVENUE_RANGE_MAX_SPAN_DAYS) return { error: `the range may span at most ${REVENUE_RANGE_MAX_SPAN_DAYS} days` };
  }
  // Clamp to the data: nothing exists after today or before the first day.
  // A window that ends before the first day stays as asked and reads empty.
  if (to > today) to = today;
  if (firstDay && from < firstDay && firstDay <= to) from = firstDay;
  return { window: { from, to, days: spanDays(from, to), preset } };
}

/** The window as a query string (no leading "?"), the form the page's URL uses. */
export function rangeQueryString(w) {
  if (!w) return "";
  return w.preset ? `range=${encodeURIComponent(w.preset)}` : `from=${w.from}&to=${w.to}`;
}

/** Rows with a `day` (or another key) inside the window, both ends inclusive. */
export function inWindow(rows, w, key = "day") {
  if (!Array.isArray(rows)) return [];
  if (!w) return rows;
  return rows.filter((r) => r && typeof r[key] === "string" && r[key] >= w.from && r[key] <= w.to);
}

/** Buckets (week or month rows) that overlap the window, each marked when it reaches past an edge. */
export function bucketsOverlapping(rows, w, startKey, endKey) {
  if (!Array.isArray(rows)) return [];
  if (!w) return rows;
  return rows
    .filter((r) => r && r[startKey] <= w.to && r[endKey] >= w.from)
    .map((r) => (r[startKey] < w.from || r[endKey] > w.to ? { ...r, extendsPastWindow: true } : r));
}

/** "2026-09-11 to 2026-10-10 (30 days, UTC)" */
export function windowLabel(w) {
  if (!w) return "all days";
  return `${w.from} to ${w.to} (${w.days} day${w.days === 1 ? "" : "s"}, UTC)`;
}

/** The first day a daily body holds a row (its `days` and `buyers`), or null. */
export function revenueSeriesFirstDay(body) {
  let first = null;
  for (const r of [...(body?.days || []), ...(body?.buyers || [])]) if (r?.day && (!first || r.day < first)) first = r.day;
  return first;
}

const PARTIAL_FIELDS = ["partial", "partialReason", "partialNote"];
/** Copy a memoized body's partial-state fields onto a body derived from it. */
export function carryPartial(from, to) {
  for (const k of PARTIAL_FIELDS) if (from && from[k] !== undefined) to[k] = from[k];
  return to;
}

/**
 * Window totals, summed from exactly the series the chart plots for the
 * window (on-chain rows plus the Tempo lane), so the line under the range
 * control and the bars above it never disagree. `concentration` is the
 * window's buyer concentration (its `buyers` is the distinct-wallet count).
 */
export function revenueWindowTotals(daily, tempo, w, concentration) {
  const t = { externalUsd: 0, externalPayments: 0, settlements: 0 };
  for (const r of [...inWindow(daily?.days, w), ...inWindow(tempo?.days, w)]) {
    t.externalUsd += Number(r.extUsd || 0);
    t.externalPayments += Number(r.extTx || 0);
    t.settlements += Number(r.extTx || 0) + Number(r.intTx || 0);
  }
  return {
    externalUsd: +t.externalUsd.toFixed(6),
    externalPayments: t.externalPayments,
    settlements: t.settlements,
    buyers: Number(concentration?.buyers || 0),
    note: "Summed from the charted series for this window: on-chain settlements to our wallets plus Tempo MPP settlements. externalUsd and externalPayments are money from others; settlements counts ours too. buyers is distinct outside wallets with an exposed payer (see concentration.scope).",
  };
}

/**
 * /api/revenue/daily for one window: the same body, every series cut to it.
 * Buyer weeks and months are distinct-count unions that cannot be cut, so a
 * bucket reaching past an edge is served whole and marked extendsPastWindow.
 * Retention and repeat7 stay all-time, as their own fields say.
 */
export function rangedRevenueDaily(body, w, { tempo = null, concentration = null } = {}) {
  const buyersAll = Array.isArray(body?.buyers) ? body.buyers : [];
  // The all-time distinct-buyer union as of the day before the window, so a
  // cumulative buyers line carries across days with no payments.
  let atStart = 0;
  for (const r of buyersAll) { if (r.day >= w.from) break; atStart = r.cumulative; }
  return carryPartial(body, {
    asOf: body.asOf,
    window: w,
    days: inWindow(body.days, w),
    daysScope: body.daysScope,
    buyers: inWindow(buyersAll, w),
    buyersCumulativeAtStart: atStart,
    buyersWeekly: bucketsOverlapping(body.buyersWeekly, w, "week", "weekEnd"),
    buyersMonthly: bucketsOverlapping(body.buyersMonthly, w, "month", "monthEnd"),
    concentration,
    retention: body.retention,
    repeat7: body.repeat7,
    totals: revenueWindowTotals(body, tempo, w, concentration),
  });
}

/**
 * The /revenue page's range: the URL's window, or the default. A range the
 * parser refuses falls back to the default and carries the reason as
 * `notice`, so a mistyped shared link still opens the page and says why.
 * totalsFor(window) supplies the window's totals.
 */
export function revenuePageRange(query, { firstDay = null, now = Date.now(), totalsFor = null } = {}) {
  let { window: w, error } = parseRevenueRange(query, { firstDay, now, fallback: REVENUE_DEFAULT_RANGE });
  if (error) w = parseRevenueRange({}, { firstDay, now, fallback: REVENUE_DEFAULT_RANGE }).window;
  return { window: w, firstDay, today: utcToday(now), notice: error || null, totals: totalsFor ? totalsFor(w) : null };
}
