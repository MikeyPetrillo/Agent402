// Databento client for the equities tools.
//
// Replaces Yahoo Finance, which we had no licence to resell: their developer
// terms forbid deriving income from the API without written permission, the
// endpoint we used was an undocumented internal one, and reaching it meant
// fetching an anti-bot "crumb" and routing around an IP block through a
// relay. Databento is a paid commercial account with a real licence to the
// access itself, so the remaining question is redistribution scope rather
// than whether we may read the data at all.
//
// DBEQ.BASIC is a three-venue consolidation (NYSE Texas, NYSE National,
// IEX), not the consolidated tape. MIAX Pearl left the dataset on
// 2024-04-01. Prices track the wider market closely; VOLUME DOES NOT,
// because it counts only those venues. Every tool here says so in its own
// output rather than letting a partial figure read as a total.
import { assertPublicUrl } from "./fetch-guard.js";

const HOST = "https://hist.databento.com/v0";
export const DATASET = "DBEQ.BASIC";
export const VENUES = "NYSE Texas (formerly NYSE Chicago), NYSE National, IEX";
// Databento prices are fixed-point integers scaled by 1e9.
const PX = 1e-9;
// A query is priced by uncompressed bytes. Nothing we issue should cost more
// than a fraction of the call's price, so a malformed or over-wide range is
// refused BEFORE it is run rather than discovered on the invoice.
const DEFAULT_MAX_QUERY_USD = Number(process.env.DATABENTO_MAX_QUERY_USD || 0.0002);

const bad = (msg, code = 400) => { const e = new Error(msg); e.statusCode = code; return e; };
const keyOf = () => (process.env.DATABENTO_API_KEY || "").trim();
export const databentoEnabled = () => !!keyOf();

function auth() {
  const k = keyOf();
  if (!k) throw bad("Market data is not configured on this server (DATABENTO_API_KEY unset).", 503);
  return "Basic " + Buffer.from(k + ":").toString("base64");
}

// Per-call upstream bounds. A slow upstream used to surface as a bare 500
// after up to 55 s (range read 15 s + cost read 20 s + data read 20 s, and a
// timeout carried no status), which read as our defect. Each read is bounded
// tighter now and a timeout or a dropped connection is a 504/502 naming the
// upstream; a >= 400 cancels settlement, so nobody is charged for it.
export const DATABENTO_TIMEOUTS_MS = { range: 6_000, cost: 5_000, data: 12_000 };
async function upstreamFetch(url, init, timeoutMs) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw bad(`Market data upstream did not answer within ${Math.round(timeoutMs / 1000)} s. Retry shortly.`, 504);
    throw bad("Market data upstream could not be reached. Retry shortly.", 502);
  }
}

async function post(path, params, timeoutMs = DATABENTO_TIMEOUTS_MS.data) {
  const url = `${HOST}/${path}`;
  await assertPublicUrl(url);
  const res = await upstreamFetch(url, {
    method: "POST",
    headers: { authorization: auth(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  }, timeoutMs);
  const text = await res.text();
  if (!res.ok) {
    // Their 4xx bodies name the cause (unknown symbol, range past the data).
    // Relay the CLASS, never the raw body: it can carry query details.
    if (res.status === 422 && /symbol/i.test(text)) throw bad("No market data for that symbol. US equities only - indices, FX and crypto are not covered.");
    if (res.status === 422) throw bad("That date range is outside the available data.");
    if (res.status === 401 || res.status === 403) throw bad("Market data upstream rejected our credentials.", 503);
    throw bad(`Market data upstream returned ${res.status}.`, 502);
  }
  return text;
}

async function get(path, params) {
  const url = `${HOST}/${path}?${new URLSearchParams(params)}`;
  await assertPublicUrl(url);
  const res = await upstreamFetch(url, { headers: { authorization: auth() } }, DATABENTO_TIMEOUTS_MS.range);
  if (!res.ok) throw bad(`Market data upstream returned ${res.status}.`, 502);
  return res.json();
}

/** Last session the dataset actually holds. Asking for "today" 422s on a
 *  weekend or whenever the feed lags, so every range is bounded by this. */
let rangeCache = { at: 0, end: null };
export async function availableEnd() {
  if (Date.now() - rangeCache.at < 15 * 60_000 && rangeCache.end) return rangeCache.end;
  const r = await get("metadata.get_dataset_range", { dataset: DATASET });
  const end = String(r.end ?? r.end_date ?? "").slice(0, 10);
  if (!end) throw bad("Market data upstream did not report its available range.", 502);
  rangeCache = { at: Date.now(), end };
  return end;
}

/** Price the query first and refuse anything unexpectedly large. */
async function assertAffordable(params, maxUsd = DEFAULT_MAX_QUERY_USD) {
  try {
    const usd = Number(await post("metadata.get_cost", { ...params, mode: "historical" }, DATABENTO_TIMEOUTS_MS.cost));
    if (Number.isFinite(usd) && usd > maxUsd) {
      throw bad(`That request is wider than this endpoint serves. Narrow the range.`);
    }
  } catch (e) {
    if (e?.statusCode === 400) throw e;      // our own refusal, keep it
    /* pricing unavailable is not a reason to fail the call */
  }
}

// Daily bars are end-of-day data: for a given symbol and range they cannot
// change until the dataset's available end advances, and every caller bounds
// `end` by availableEnd(), so the range is part of the key and a new session
// is a new key. A first read costs two upstream POSTs (cost check, then
// data); a repeat of a symbol inside the session answers from memory with no
// upstream read at all. Errors are never cached; a bounded map drops the
// oldest entry past BARS_CACHE_MAX.
const BARS_CACHE_MAX = 2_000;
const barsCache = new Map(); // key -> bars (frozen rows)
let barsCacheMax = BARS_CACHE_MAX;
/** Test hook: shrink (or reset) the bars cache bound; clears the cache. */
export function __setBarsCacheMax(n) { barsCacheMax = Number.isInteger(n) && n > 0 ? n : BARS_CACHE_MAX; barsCache.clear(); }
export function barsCacheSize() { return barsCache.size; }

export async function dailyBars({ symbol, start, end, maxUsd }) {
  const params = { dataset: DATASET, symbols: String(symbol).toUpperCase(), schema: "ohlcv-1d", start, end };
  const key = `${params.dataset}|${params.symbols}|${params.schema}|${start}|${end}`;
  const hit = barsCache.get(key);
  if (hit) {
    // Refresh recency so a symbol polled daily is never the oldest entry.
    barsCache.delete(key); barsCache.set(key, hit);
    return hit.map((b) => ({ ...b }));
  }
  await assertAffordable(params, maxUsd);
  const text = await post("timeseries.get_range", { ...params, encoding: "json" });
  const rows = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (!rows.length) throw bad("No market data for that symbol in that range. US equities only.");
  const bars = consolidate(rows);
  barsCache.set(key, bars.map((b) => Object.freeze({ ...b })));
  while (barsCache.size > barsCacheMax) barsCache.delete(barsCache.keys().next().value);
  return bars;
}

/** DBEQ.BASIC returns ONE BAR PER VENUE. A quote consolidates them: the day's
 *  high/low are the extremes across venues, volume is their sum (and is
 *  therefore venue-partial), and open/close come from the venue that traded
 *  the most that session - a thin venue's print is not the day's close. */
export function consolidate(rows) {
  const byDay = new Map();
  for (const r of rows) {
    const day = new Date(Number(r.hd.ts_event) / 1e6).toISOString().slice(0, 10);
    const g = byDay.get(day) || { day, high: -Infinity, low: Infinity, venueVolume: 0, best: null };
    g.high = Math.max(g.high, Number(r.high) * PX);
    g.low = Math.min(g.low, Number(r.low) * PX);
    g.venueVolume += Number(r.volume);
    if (!g.best || Number(r.volume) > Number(g.best.volume)) g.best = r;
    byDay.set(day, g);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((g) => ({
    day: g.day,
    open: round(Number(g.best.open) * PX), high: round(g.high),
    low: round(g.low), close: round(Number(g.best.close) * PX),
    venueVolume: g.venueVolume,
  }));
}
const round = (n) => Number(n.toFixed(4));
