// Frankfurter v2 adapter: ECB reference rates in the shapes the FX tools
// already serve.
//
// v1 (api.frankfurter.dev/v1) is frozen; v2 answers a flat list of
// {date, base, quote, rate} rows. By default v2 BLENDS rates across every
// provider it carries; the FX tools are described as European Central Bank
// reference rates, so every read here pins `providers=ecb`. That keeps the
// numbers, the currency set and the published-date roll-back (a weekend date
// answers the prior business day) identical to v1, measured side by side
// 2026-10-14: same rate to the last digit on latest, a single date, a range
// and the G10 basket.
//
// Behavior v2 changes, mapped here so callers see what v1 gave them:
//   * a code v2 does not know answers HTTP 422 "invalid currency" (v1: 404);
//     isUnknownCurrency() reads either.
//   * a code v2 knows but the ECB does not publish (AED, for one) answers an
//     EMPTY list (v1: 404). latestShape() returns null for it, so a caller
//     reports "not a listed pair" rather than an outage.
//   * there is no amount parameter; conversion is amount * rate, done by the
//     caller at full precision (v1 rounded the converted figure to about five
//     significant digits, so 12345.678 USD read as 11028 EUR).
//
// Terms: the ECB's reference rates are free to reuse with the source named;
// every FX answer names "ECB via Frankfurter". Frankfurter's own code is MIT.
export const FRANKFURTER_V2 = "https://api.frankfurter.dev/v2";

const CODE_RE = /^[A-Z]{3}$/;

/** One ECB-scoped /v2/rates URL. `date` for one day, `from`/`to` for a window. */
export function ratesUrl({ base, quotes, date, from, to }) {
  const q = new URLSearchParams({ providers: "ecb" });
  if (base) q.set("base", String(base).toUpperCase());
  const list = (Array.isArray(quotes) ? quotes : [quotes]).filter(Boolean).map((c) => String(c).toUpperCase());
  if (list.length) q.set("quotes", list.join(","));
  if (date) q.set("date", date);
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  return `${FRANKFURTER_V2}/rates?${q.toString().replace(/%2C/g, ",")}`;
}

function rowsOf(json) {
  if (!Array.isArray(json)) {
    const e = new Error("Frankfurter returned an unexpected response shape");
    e.statusCode = 502;
    throw e;
  }
  return json.filter((r) => r && CODE_RE.test(String(r.quote || "")) && typeof r.rate === "number" && /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || "")));
}

/**
 * One-date answer in the v1 shape: { base, date, rates: { QUOTE: rate } }.
 * The latest date in the rows wins (a one-date read carries one date; this
 * keeps a mixed answer from being reported under a stale day). Returns null
 * when no quote came back, which is how v2 says "the ECB does not publish
 * that pair".
 */
export function latestShape(json, base) {
  const rows = rowsOf(json);
  if (!rows.length) return null;
  const date = rows.reduce((d, r) => (r.date > d ? r.date : d), rows[0].date);
  const rates = {};
  for (const r of rows) if (r.date === date) rates[r.quote] = r.rate;
  return { base: base ? String(base).toUpperCase() : rows[0].base ?? null, date, rates };
}

/**
 * Window answer in the v1 shape: { base, start_date, end_date,
 * rates: { "YYYY-MM-DD": { QUOTE: rate } } }. Empty `rates` when nothing came
 * back; the caller decides what an empty window means.
 */
export function seriesShape(json, base) {
  const rows = rowsOf(json);
  const rates = {};
  for (const r of rows) (rates[r.date] ||= {})[r.quote] = r.rate;
  const days = Object.keys(rates).sort();
  return { base: base ? String(base).toUpperCase() : null, start_date: days[0] ?? null, end_date: days[days.length - 1] ?? null, rates };
}

/** True when the error is Frankfurter refusing a currency code (v2 422, v1 404). */
export function isUnknownCurrency(e) {
  const s = Number(e?.upstreamStatus);
  if (s === 422 || s === 404) return true;
  return e?.statusCode === 422 && /HTTP (422|404)/.test(String(e?.message || ""));
}
