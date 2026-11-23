// fred-series' sources: common FRED series IDs, each read from the agency
// that publishes it, so the route serves no FRED data.
//
//   - U.S. Bureau of Labor Statistics, Public Data API (api.bls.gov): the
//     labor and price series. BLS publishes into the public domain
//     (https://www.bls.gov/opub/copyright-information.htm). Its API terms
//     (https://www.bls.gov/developers/termsOfService.htm) ask users to cite
//     the date the data were retrieved, to state that "BLS.gov cannot vouch
//     for the data or analyses derived from these data after the data have
//     been retrieved from BLS.gov", and not to modify content and still cite
//     it as BLS.gov: every answer carries `retrievedAt` and that sentence, and
//     a transformed or aggregated answer is marked `derived` and credited as
//     computed by this service from BLS data. Keyless (v1) the API allows 25
//     queries a day; with BLS_API_KEY (v2) 500. Reads are cached by decade
//     and held under a daily budget below the API's own limit.
//   - Federal Reserve Bank of New York, Markets Data API
//     (markets.newyorkfed.org): EFFR, SOFR and OBFR. Its Terms of Use
//     (https://www.newyorkfed.org/privacy/termsofuse) license use, copying and
//     distribution "for your personal or business purposes" and ask a
//     publisher of reference rate data to carry a notice, and a product that
//     names a rate to carry a disclaimer; both ride every answer (NYFED_NOTICE).
//   - U.S. Treasury, Fiscal Data API (api.fiscaldata.treasury.gov): total
//     public debt outstanding. "The data on this site is available to copy,
//     adapt, redistribute, or otherwise use for non-commercial and commercial
//     purposes" (https://fiscaldata.treasury.gov/about-us/).
import { safeFetch, retryTransient } from "./fetch-guard.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export const BLS_VOUCH = "BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov.";
export const NYFED_NOTICE = (name) =>
  `The ${name} is subject to the Terms of Use posted at newyorkfed.org. The New York Fed is not responsible for publication of the ${name} by Agent402, does not sanction or endorse any particular republication, and has no liability for your use. Agent402 is not affiliated with the New York Fed. The New York Fed does not sanction, endorse, or recommend any products or services offered by Agent402.`;
export const SOFR_DTCC_NOTICE = "The Secured Overnight Financing Rate (SOFR) Data are calculated using data provided under a license granted to the New York Fed by DTCC Solutions LLC (\"Solutions\"), an affiliate of The Depository Trust & Clearing Corporation. Solutions, its affiliates, and third parties from which they obtained data have no liability for the content of this material.";
// Each answer links the terms its publisher's data is served under (the New
// York Fed's ask that its content be passed on with the same permissions,
// conditions and restrictions is met by naming them).
export const TERMS = Object.freeze({
  bls: "BLS Public Data API terms of service: https://www.bls.gov/developers/termsOfService.htm",
  nyfed: "New York Fed Terms of Use, which apply to this data as passed on here: https://www.newyorkfed.org/privacy/termsofuse",
  treasury: "U.S. Treasury Fiscal Data: https://fiscaldata.treasury.gov/about-us/",
});
export const TREASURY_FISCAL_CREDIT = "Source: U.S. Department of the Treasury, Fiscal Data (fiscaldata.treasury.gov).";

const BLS = (id, title) => ({ source: "bls", id, freq: "m", title });
const NYF = (path, name, title, extra = {}) => ({ source: "nyfed", path, name, freq: "d", title, ...extra });
/** FRED series ID -> the publisher's own series. */
export const SERIES = Object.freeze({
  UNRATE: BLS("LNS14000000", "Unemployment Rate (percent, seasonally adjusted)"),
  UNRATENSA: BLS("LNU04000000", "Unemployment Rate (percent, not seasonally adjusted)"),
  U6RATE: BLS("LNS13327709", "Total unemployed, plus marginally attached and part time for economic reasons (U-6, percent, seasonally adjusted)"),
  CIVPART: BLS("LNS11300000", "Labor Force Participation Rate (percent, seasonally adjusted)"),
  EMRATIO: BLS("LNS12300000", "Employment-Population Ratio (percent, seasonally adjusted)"),
  PAYEMS: BLS("CES0000000001", "All Employees, Total Nonfarm (thousands, seasonally adjusted)"),
  CES0500000003: BLS("CES0500000003", "Average Hourly Earnings of All Employees, Total Private (dollars, seasonally adjusted)"),
  JTSJOL: BLS("JTS000000000000000JOL", "Job Openings: Total Nonfarm (thousands, seasonally adjusted)"),
  CPIAUCSL: BLS("CUSR0000SA0", "Consumer Price Index for All Urban Consumers: All Items (index 1982-1984=100, seasonally adjusted)"),
  CPIAUCNS: BLS("CUUR0000SA0", "Consumer Price Index for All Urban Consumers: All Items (index 1982-1984=100, not seasonally adjusted)"),
  CPILFESL: BLS("CUSR0000SA0L1E", "CPI-U: All Items Less Food and Energy (index 1982-1984=100, seasonally adjusted)"),
  PPIACO: BLS("WPU00000000", "Producer Price Index: All Commodities (index 1982=100, not seasonally adjusted)"),
  EFFR: NYF("unsecured/effr", "Effective Federal Funds Rate (EFFR)", "Effective Federal Funds Rate (percent, business days)"),
  DFF: NYF("unsecured/effr", "Effective Federal Funds Rate (EFFR)", "Effective Federal Funds Rate (percent, business days)", { note: "Read from the New York Fed's EFFR, published on business days only; weekends and holidays carry no observation." }),
  FEDFUNDS: NYF("unsecured/effr", "Effective Federal Funds Rate (EFFR)", "Federal Funds Effective Rate, monthly average (percent)", { freq: "m", monthlyAverage: true }),
  SOFR: NYF("secured/sofr", "Secured Overnight Financing Rate (SOFR)", "Secured Overnight Financing Rate (percent, business days)", { dtcc: true }),
  OBFR: NYF("unsecured/obfr", "Overnight Bank Funding Rate (OBFR)", "Overnight Bank Funding Rate (percent, business days)"),
  GFDEBTN: { source: "treasury", freq: "q", title: "Federal Debt: Total Public Debt (millions of dollars, end of quarter)" },
});
export const SUPPORTED_IDS = Object.freeze(Object.keys(SERIES));

// ---- caches and budgets ------------------------------------------------------
const HOUR = 3_600_000;
const cache = new Map(); // key -> { at, ttl, value, retrievedAt }
const CACHE_MAX = 500;
function cached(key) {
  const c = cache.get(key);
  if (!c) return null;
  if (Date.now() - c.at > c.ttl) { cache.delete(key); return null; }
  return c;
}
function keep(key, value, ttl) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  const entry = { at: Date.now(), ttl, value, retrievedAt: new Date().toISOString() };
  cache.set(key, entry);
  return entry;
}
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const blsKey = () => (process.env.BLS_API_KEY || "").trim();
/** Queries a UTC day this server makes to the BLS API, under its limit (25 keyless, 500 keyed). */
export const blsDailyBudget = () => (blsKey() ? 450 : 20);
const blsDay = { day: "", used: 0 };
function takeBlsQuery() {
  const d = new Date().toISOString().slice(0, 10);
  if (blsDay.day !== d) { blsDay.day = d; blsDay.used = 0; }
  if (blsDay.used >= blsDailyBudget()) return false;
  blsDay.used++;
  return true;
}
/** Test seam: forget every cached read and the day's BLS count. */
export function _resetUsMacroForTest() { cache.clear(); inflight.clear(); blsDay.day = ""; blsDay.used = 0; }

const busy = (what) => Object.assign(bad(`${what} is not available right now; retry shortly. Nothing was charged.`, 503), { retryAfter: 60 });

// ---- BLS ---------------------------------------------------------------------
/** One decade of a BLS series (startYear a multiple of 10), oldest first. */
async function blsDecade(id, startYear) {
  const endYear = startYear + 9;
  const k = `bls:${id}:${startYear}`;
  const hit = cached(k);
  if (hit) return hit;
  return once(k, async () => {
    if (!takeBlsQuery()) throw Object.assign(bad("The U.S. Bureau of Labor Statistics daily query allowance of this server is used up; this decade of the series is not held yet. Retry tomorrow, or ask for a window this server has read today. Nothing was charged.", 503), { retryAfter: 3600 });
    const key = blsKey();
    const body = { seriesid: [id], startyear: String(startYear), endyear: String(endYear), ...(key ? { registrationkey: key } : {}) };
    const url = key ? "https://api.bls.gov/publicAPI/v2/timeseries/data/" : "https://api.bls.gov/publicAPI/v1/timeseries/data/";
    let j;
    try {
      const { html } = await retryTransient(() => safeFetch(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, timeoutMs: 12_000, maxBytes: 4 * 1024 * 1024, ownUpstream: true }));
      j = JSON.parse(html);
    } catch (e) {
      if (e?.statusCode && e.statusCode < 500 && e.statusCode !== 429) throw e;
      throw busy("The U.S. Bureau of Labor Statistics API");
    }
    if (j?.status !== "REQUEST_SUCCEEDED") throw busy("The U.S. Bureau of Labor Statistics API");
    const rows = [];
    for (const d of j?.Results?.series?.[0]?.data || []) {
      const m = /^M(0[1-9]|1[0-2])$/.exec(String(d.period));
      const v = Number(d.value);
      if (!m || !Number.isFinite(v) || !/^\d{4}$/.test(String(d.year))) continue;
      rows.push({ date: `${d.year}-${m[1]}-01`, value: v });
    }
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    const thisDecade = Math.floor(new Date().getUTCFullYear() / 10) * 10 === startYear;
    return keep(k, rows, thisDecade ? 6 * HOUR : 7 * 24 * HOUR);
  });
}

/** The most decades one call reads (two keyless queries a day each spare the allowance). */
export const BLS_MAX_DECADES = 3;
async function blsSeries(id, fromYear, toYear) {
  const decades = [];
  for (let y = Math.floor(fromYear / 10) * 10; y <= toYear; y += 10) decades.push(y);
  if (decades.length > BLS_MAX_DECADES) throw bad(`A window on this series may touch at most three calendar decades (for example 2000-01-01 to 2029-12-31); narrow startDate and endDate.`);
  const parts = [];
  for (const y of decades) parts.push(await blsDecade(id, y));
  return { rows: parts.flatMap((p) => p.value), retrievedAt: parts.map((p) => p.retrievedAt).sort()[0] };
}

// ---- New York Fed ------------------------------------------------------------
async function nyfedRates(path) {
  const k = `nyfed:${path}`;
  const hit = cached(k);
  if (hit) return hit;
  return once(k, async () => {
    const end = new Date().toISOString().slice(0, 10);
    const url = `https://markets.newyorkfed.org/api/rates/${path}/search.json?startDate=2000-01-01&endDate=${end}`;
    let j;
    try {
      const { html } = await retryTransient(() => safeFetch(url, { timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024, ownUpstream: true }));
      j = JSON.parse(html);
    } catch {
      throw busy("The New York Fed Markets Data API");
    }
    const rows = (j?.refRates || [])
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r.effectiveDate)) && Number.isFinite(Number(r.percentRate)))
      .map((r) => ({ date: r.effectiveDate, value: Number(r.percentRate) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!rows.length) throw busy("The New York Fed Markets Data API");
    return keep(k, rows, 2 * HOUR);
  });
}

/** Monthly averages of a business-day rate over every calendar day, each day
 *  at the latest rate published on or before it (the method of the Federal
 *  Reserve's monthly effective rate); only months that have ended. */
export function monthlyCalendarAverage(daily, today = new Date().toISOString().slice(0, 10)) {
  const out = [];
  if (!daily.length) return out;
  const first = new Date(`${daily[0].date}T00:00:00Z`);
  let m = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1)); // the first whole month
  // Months that have ended, through the month of the latest published rate.
  const thisMonth = today.slice(0, 7);
  const lastMonth = daily[daily.length - 1].date.slice(0, 7);
  let i = 0, cur = null;
  while (m.toISOString().slice(0, 7) < thisMonth && m.toISOString().slice(0, 7) <= lastMonth) {
    const next = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
    let sum = 0, n = 0;
    for (let d = new Date(m); d < next; d = new Date(d.getTime() + 86_400_000)) {
      const ds = d.toISOString().slice(0, 10);
      while (i < daily.length && daily[i].date <= ds) cur = daily[i++].value;
      if (cur !== null) { sum += cur; n++; }
    }
    if (n) out.push({ date: m.toISOString().slice(0, 10), value: Math.round((sum / n) * 100) / 100 });
    m = next;
  }
  return out;
}

// ---- Treasury Fiscal Data ----------------------------------------------------
async function treasuryDebtQuarterly() {
  const k = "treasury:mspd-total";
  const hit = cached(k);
  if (hit) return hit;
  return once(k, async () => {
    const url = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/debt/mspd/mspd_table_1?filter=security_type_desc:eq:Total%20Public%20Debt%20Outstanding&fields=record_date,total_mil_amt&sort=record_date&page[size]=1000";
    let j;
    try {
      const { html } = await retryTransient(() => safeFetch(url, { timeoutMs: 10_000, maxBytes: 4 * 1024 * 1024, ownUpstream: true }), { retries: 2, backoffMs: 400 });
      j = JSON.parse(html);
    } catch {
      throw busy("The U.S. Treasury Fiscal Data API");
    }
    const rows = [];
    for (const r of j?.data || []) {
      const m = /^(\d{4})-(03|06|09|12)-\d{2}$/.exec(String(r.record_date));
      const v = Number(r.total_mil_amt);
      if (!m || !Number.isFinite(v)) continue;
      const qStart = { "03": "01", "06": "04", "09": "07", "12": "10" }[m[2]];
      rows.push({ date: `${m[1]}-${qStart}-01`, value: v });
    }
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!rows.length) throw busy("The U.S. Treasury Fiscal Data API");
    return keep(k, rows, 6 * HOUR);
  });
}

// ---- transformations ---------------------------------------------------------
const PER_YEAR = { d: 260, w: 52, m: 12, q: 4, sa: 2, a: 1 };
const round = (x) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null);
/** The value a year before observation i: the same date a year earlier for
 *  a monthly or lower series, else the latest observation on or before it. */
function yearAgo(rows, i, freq) {
  const target = `${Number(rows[i].date.slice(0, 4)) - 1}${rows[i].date.slice(4)}`;
  let lo = 0, hi = i - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].date <= target) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  if (found < 0) return null;
  if (PER_YEAR[freq] <= 12 && rows[found].date !== target) return null;
  return rows[found].value;
}
/** FRED's units codes, computed from the publisher's levels. */
export function transform(rows, units, freq) {
  if (units === "lin") return rows;
  const n = PER_YEAR[freq] || 12;
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const x = rows[i].value, p = i > 0 ? rows[i - 1].value : null;
    let v = null;
    if (units === "chg") v = p === null ? null : x - p;
    else if (units === "pch") v = p ? (x / p - 1) * 100 : null;
    else if (units === "pca") v = p ? (Math.pow(x / p, n) - 1) * 100 : null;
    else if (units === "cca") v = p && x > 0 && p > 0 ? n * Math.log(x / p) * 100 : null;
    else if (units === "log") v = x > 0 ? Math.log(x) : null;
    else if (units === "ch1" || units === "pc1") {
      const y = yearAgo(rows, i, freq);
      v = y === null ? null : units === "ch1" ? x - y : y ? (x / y - 1) * 100 : null;
    }
    if (v !== null && Number.isFinite(v)) out.push({ date: rows[i].date, value: round(v) });
  }
  return out;
}

const RANK = { d: 0, w: 1, m: 2, q: 3, sa: 4, a: 5 };
export const SUPPORTED_FREQ = Object.freeze(["d", "w", "m", "q", "sa", "a"]);
function periodStart(date, freq) {
  const y = date.slice(0, 4), mo = Number(date.slice(5, 7));
  if (freq === "m") return `${y}-${date.slice(5, 7)}-01`;
  if (freq === "q") return `${y}-${String(Math.floor((mo - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
  if (freq === "sa") return `${y}-${mo <= 6 ? "01" : "07"}-01`;
  if (freq === "a") return `${y}-01-01`;
  // w: weeks ending Friday, dated by the Friday (FRED's wef)
  const d = new Date(`${date}T00:00:00Z`);
  const fri = new Date(d.getTime() + ((5 - d.getUTCDay() + 7) % 7) * 86_400_000);
  return fri.toISOString().slice(0, 10);
}
/** Averages to a lower frequency; only periods the data covers through their end. */
export function aggregate(rows, from, to) {
  if (to === from || (to === "d" && from === "d")) return rows;
  if (RANK[to] < RANK[from]) throw bad(`"frequency" ${to} is higher than this series' own frequency (${from}); a series can only be aggregated to a lower one.`);
  const groups = new Map();
  for (const r of rows) {
    const k = periodStart(r.date, to);
    const g = groups.get(k) || { n: 0, sum: 0 };
    g.n++; g.sum += r.value;
    groups.set(k, g);
  }
  const last = rows.length ? rows[rows.length - 1].date : "";
  const need = from === "m" ? { q: 3, sa: 6, a: 12 }[to] : null;
  // Averages are given at the precision the series is published in.
  const places = rows.reduce((m, r) => Math.max(m, (String(r.value).split(".")[1] || "").length), 0);
  const out = [];
  for (const [k, g] of groups) {
    if (need && g.n < need) continue;
    if (!need && from === "d") {
      // the period must have ended by the last observation
      const end = to === "w" ? k : periodEnd(k, to);
      if (end > last && !(to === "w" && k <= last)) continue;
    }
    out.push({ date: k, value: Number((g.sum / g.n).toFixed(places)) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
function periodEnd(start, freq) {
  const d = new Date(`${start}T00:00:00Z`);
  const months = { m: 1, q: 3, sa: 6, a: 12 }[freq];
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 0)).toISOString().slice(0, 10);
}

// ---- the series read ---------------------------------------------------------
const yearOf = (iso) => Number(iso.slice(0, 4));
/**
 * Observations of a supported FRED series ID from its publisher, in
 * fred-series' answer shape. `frequency` and `units` follow FRED's codes
 * (frequency: d, w, m, q, sa, a).
 */
export async function usMacroSeries({ seriesId, startDate, endDate, limit = 1000, units = "lin", frequency }) {
  const s = SERIES[seriesId];
  if (!s) return null;
  if (frequency && !SUPPORTED_FREQ.includes(frequency === "wef" ? "w" : frequency)) {
    throw bad(`"frequency" ${frequency} is not offered on this series; use one of: ${SUPPORTED_FREQ.join(", ")} (w is weeks ending Friday).`);
  }
  const freqOut = frequency === "wef" ? "w" : frequency;
  const nowYear = new Date().getUTCFullYear();
  let rows, retrievedAt, sourceName, sourceSeries, credit, windowNote = null, defaultedStart = false;
  // A year more than asked, so the first observations of a year-over-year
  // transform have their base.
  const pad = units === "ch1" || units === "pc1" ? 1 : units === "lin" ? 0 : 1;
  if (s.source === "bls") {
    const toYear = endDate ? Math.min(yearOf(endDate), nowYear) : nowYear;
    let fromYear;
    if (startDate) fromYear = yearOf(startDate) - pad;
    else { fromYear = toYear - 9 - pad; defaultedStart = true; }
    const got = await blsSeries(s.id, Math.max(fromYear, 1913), toYear);
    rows = got.rows; retrievedAt = got.retrievedAt;
    sourceName = "U.S. Bureau of Labor Statistics"; sourceSeries = s.id;
    credit = BLS_VOUCH;
    if (defaultedStart) windowNote = "With no startDate, this series answers its last 10 years; pass startDate for earlier years (up to three calendar decades per call).";
  } else if (s.source === "nyfed") {
    const got = await nyfedRates(s.path);
    rows = s.monthlyAverage ? monthlyCalendarAverage(got.value) : got.value;
    retrievedAt = got.retrievedAt;
    sourceName = "Federal Reserve Bank of New York"; sourceSeries = s.path.split("/")[1].toUpperCase();
    credit = `${NYFED_NOTICE(s.name)}${s.dtcc ? ` ${SOFR_DTCC_NOTICE}` : ""} © ${nowYear} Federal Reserve Bank of New York. Content from the New York Fed subject to the Terms of Use at newyorkfed.org.`;
  } else {
    const got = await treasuryDebtQuarterly();
    rows = got.value; retrievedAt = got.retrievedAt;
    sourceName = "U.S. Department of the Treasury, Fiscal Data"; sourceSeries = "mspd_table_1: Total Public Debt Outstanding";
    credit = TREASURY_FISCAL_CREDIT;
  }
  rows = rows.slice();
  let derived = !!s.monthlyAverage;
  if (freqOut && freqOut !== s.freq) { rows = aggregate(rows, s.freq, freqOut); derived = true; }
  if (units !== "lin") { rows = transform(rows, units, freqOut || s.freq); derived = true; }
  const from = startDate || (defaultedStart ? `${(endDate ? Math.min(yearOf(endDate), nowYear) : nowYear) - 9}-01-01` : null);
  if (from) rows = rows.filter((r) => r.date >= from);
  if (endDate) rows = rows.filter((r) => r.date <= endDate);
  const matched = rows.length;
  const observations = rows.slice(0, limit);
  return {
    seriesId,
    units,
    count: observations.length,
    observations,
    source: derived ? `Computed by Agent402 from ${sourceName} data` : sourceName,
    sourceSeries,
    title: s.title,
    retrievedAt,
    credit,
    terms: TERMS[s.source],
    ...(derived ? { derived: true } : {}),
    ...(s.note ? { note: s.note } : {}),
    ...(windowNote ? { window: windowNote } : {}),
    ...(matched > observations.length ? { returned: observations.length, matched, complete: false, truncated: true } : {}),
  };
}

/** The 404 for an ID this route does not serve: the supported IDs, named. */
export function unsupportedSeriesError(seriesId) {
  return Object.assign(
    bad(`Series ${seriesId} is not served here. fred-series answers these FRED series IDs from the agencies that publish them: ${SUPPORTED_IDS.join(", ")}.`, 404),
    { supportedSeriesIds: SUPPORTED_IDS },
  );
}
