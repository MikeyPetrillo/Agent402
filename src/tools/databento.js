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

// The SSRF check resolves the host through DNS. HOST is a constant (never a
// caller's input), so one check per window is the same guarantee as one per
// read, without a resolver round trip on every request path.
const HOST_CHECK_MS = 10 * 60_000;
let hostCheckedAt = 0;
async function checkHost(url) {
  if (Date.now() - hostCheckedAt < HOST_CHECK_MS) return;
  await assertPublicUrl(url);
  hostCheckedAt = Date.now();
}

async function post(path, params, timeoutMs = DATABENTO_TIMEOUTS_MS.data) {
  const url = `${HOST}/${path}`;
  await checkHost(url);
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
  await checkHost(url);
  const res = await upstreamFetch(url, { headers: { authorization: auth() } }, DATABENTO_TIMEOUTS_MS.range);
  if (!res.ok) throw bad(`Market data upstream returned ${res.status}.`, 502);
  return res.json();
}

/** Last session the dataset actually holds. Asking for "today" 422s on a
 *  weekend or whenever the feed lags, so every range is bounded by this.
 *
 *  Off the request path once warm: the quote warmer below re-reads it on a
 *  timer while there is demand, and a request serves the last confirmed value
 *  with its age (availableEndInfo). A request reads it inline only when there
 *  is no value yet or the last one is older than DATABENTO_RANGE_MAX_AGE_MS
 *  (the warmer was idle). Concurrent reads share one upstream call. */
const envMs = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : dflt; };
export const RANGE_REFRESH_MS = envMs("DATABENTO_RANGE_REFRESH_MS", 15 * 60_000);
const rangeMaxAgeMs = () => envMs("DATABENTO_RANGE_MAX_AGE_MS", 60 * 60_000);
let rangeState = { end: null, at: 0 };
let rangeInflight = null;
function readRange() {
  if (!rangeInflight) {
    rangeInflight = (async () => {
      const r = await get("metadata.get_dataset_range", { dataset: DATASET });
      const end = String(r.end ?? r.end_date ?? "").slice(0, 10);
      if (!end) throw bad("Market data upstream did not report its available range.", 502);
      rangeState = { end, at: Date.now() };
      return end;
    })().finally(() => { rangeInflight = null; });
  }
  return rangeInflight;
}
/** `demand: false` (the self-check) reads the range without counting as a
 *  buyer's demand, so it never keeps the warmer awake. */
export async function availableEndInfo({ demand = true } = {}) {
  if (demand) lastDemandAt = Date.now();
  const age = Date.now() - rangeState.at;
  if (rangeState.end && age < rangeMaxAgeMs()) return { end: rangeState.end, checkedAt: new Date(rangeState.at).toISOString(), ageMs: age, cached: true };
  const end = await readRange();
  return { end, checkedAt: new Date(rangeState.at).toISOString(), ageMs: 0, cached: false };
}
export async function availableEnd(opts) { return (await availableEndInfo(opts)).end; }

/** Price the query first and refuse anything unexpectedly large. */
async function priceOf(params) {
  return Number(await post("metadata.get_cost", { ...params, mode: "historical" }, DATABENTO_TIMEOUTS_MS.cost));
}
async function assertAffordable(params, maxUsd = DEFAULT_MAX_QUERY_USD) {
  try {
    const usd = await priceOf(params);
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
// is a new key. A repeat of a symbol inside the session answers from memory
// with no upstream read at all, and says so (cached, fetchedAt). Concurrent
// first reads of one key share one upstream read. Errors are never cached; a
// bounded map drops the oldest entry past BARS_CACHE_MAX.
const BARS_CACHE_MAX = 2_000;
const barsCache = new Map(); // key -> { bars (frozen rows), fetchedAt }
const barsInflight = new Map(); // key -> promise of { bars, fetchedAt }
let barsCacheMax = BARS_CACHE_MAX;
/** Test hook: shrink (or reset) the bars cache bound; clears the cache. */
export function __setBarsCacheMax(n) { barsCacheMax = Number.isInteger(n) && n > 0 ? n : BARS_CACHE_MAX; barsCache.clear(); }
export function barsCacheSize() { return barsCache.size; }

// THE PRICE CHECK ON A QUOTE. metadata.get_cost is a spend guard: it prices a
// query and refuses to answer one wider than DEFAULT_MAX_QUERY_USD, so a
// malformed or over-wide range is caught rather than sold at a loss. On the
// request path it runs before the data read, so a refused query is never read;
// what it costs is a second upstream call on every first read of a symbol, and
// its own latency, ahead of the read.
//
// A quote's read is bounded BY CONSTRUCTION: one symbol, the daily schema, and
// a fixed lookback of QUOTE_LOOKBACK_DAYS calendar days, so its size (records
// = days x venues) does not depend on the caller. For exactly that shape the
// price is checked off the request path instead: the warmer prices the
// canonical quote query (a liquid symbol, the full lookback, the upper bound
// for the shape) once per session, and a quote read skips the inline check
// only when that audit ran for the read's own session and came back within the
// bound; before the first audit, with the warmer off, or after an audit that
// threw or answered no number (retried on the next tick), it is priced inline.
// If an audit ever comes back over the bound, the latch below puts the price
// check back on every quote read, inline, as before. Every other shape
// (stock-history, any wider range) keeps the inline check unchanged.
export const QUOTE_LOOKBACK_DAYS = 10;
const QUOTE_AUDIT_SYMBOL = "AAPL";
let quotePriceInline = false;     // latched true by a failed audit
let quotePriceAudit = { end: null, at: 0, ok: null };
export function quoteWindow(end) {
  return { start: new Date(new Date(end) - QUOTE_LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10), end };
}
function isQuoteShape(params) {
  if (params.schema !== "ohlcv-1d" || String(params.symbols).includes(",")) return false;
  const span = (new Date(params.end) - new Date(params.start)) / 864e5;
  return Number.isFinite(span) && span >= 0 && span <= QUOTE_LOOKBACK_DAYS;
}

export async function dailyBars(opts) { return (await dailyBarsRead(opts)).bars; }

/** Bars plus where they came from: { bars, cached, fetchedAt }. */
export async function dailyBarsRead({ symbol, start, end, maxUsd }) {
  const params = { dataset: DATASET, symbols: String(symbol).toUpperCase(), schema: "ohlcv-1d", start, end };
  const key = `${params.dataset}|${params.symbols}|${params.schema}|${start}|${end}`;
  const hit = barsCache.get(key);
  if (hit) {
    // Refresh recency so a symbol polled daily is never the oldest entry.
    barsCache.delete(key); barsCache.set(key, hit);
    return { bars: hit.bars.map((b) => ({ ...b })), cached: true, fetchedAt: hit.fetchedAt };
  }
  let p = barsInflight.get(key);
  if (!p) {
    p = readBars(params, key, maxUsd).finally(() => barsInflight.delete(key));
    barsInflight.set(key, p);
  }
  const r = await p;
  return { bars: r.bars.map((b) => ({ ...b })), cached: false, fetchedAt: r.fetchedAt };
}

/** Whether a read of `params` is priced on the request path: always, except
 *  a quote-shaped read of a session whose audit came back within the bound
 *  (an audit that has not run, threw, or answered no number leaves it on). */
export function readPricesInline(params, maxUsd) {
  const audited = quotePriceAudit.ok === true && quotePriceAudit.end === params.end;
  return quotePriceInline || !audited || !isQuoteShape(params) || (maxUsd !== undefined && maxUsd < DEFAULT_MAX_QUERY_USD);
}

async function readBars(params, key, maxUsd) {
  // The price check, when it is on the request path, runs BEFORE the data
  // read: a query it refuses is never read (nor paid for upstream). Pricing
  // that is unavailable does not fail the call (assertAffordable).
  if (readPricesInline(params, maxUsd)) await assertAffordable(params, maxUsd);
  const text = await post("timeseries.get_range", { ...params, encoding: "json" });
  const rows = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (!rows.length) throw bad("No market data for that symbol in that range. US equities only.");
  const bars = consolidate(rows);
  const entry = { bars: bars.map((b) => Object.freeze({ ...b })), fetchedAt: new Date().toISOString() };
  barsCache.set(key, entry);
  while (barsCache.size > barsCacheMax) barsCache.delete(barsCache.keys().next().value);
  return entry;
}

// ---------------------------------------------------------------- warmer
//
// Keeps the request path free of upstream reads for the symbols buyers
// actually ask for. While there is demand (a stock request inside
// DATABENTO_WARM_IDLE_MS), a timer re-reads the available end every
// RANGE_REFRESH_MS; when the end advances to a new session it prices the
// canonical quote query once (above) and pre-reads the top
// DATABENTO_WARM_TOP_N symbols by recent paid requests for the new session.
// It starts at boot (never from inside a request), only with a key configured
// and DATABENTO_WARM not "off"; with no demand it makes no call at all beyond
// the boot read of the range and the session's one price check.
//
// THE BOUND. Every background call counts against
// DATABENTO_BACKGROUND_DAILY_MAX_CALLS per UTC day (default 150: 96 range
// reads at a 15-minute refresh, one price check and the top-N pre-reads per
// session, with room). Past it the warmer stops for the day and a request
// falls back to reading inline, exactly as before the warmer existed. The
// symbols come only from successful paid quote requests (stock-quote is
// wallet-only; the free tier never reaches this kit).
const warm = { timer: null, started: false, lastTickAt: 0, lastWarmedEnd: null, day: null, calls: 0, ceilingHitDay: null, prefetched: 0 };
let lastDemandAt = 0;
const popularity = new Map(); // symbol -> { hits, lastAt }
const POPULARITY_MAX = 500;
const warmTopN = () => { const n = Number(process.env.DATABENTO_WARM_TOP_N); return Number.isInteger(n) && n >= 0 ? Math.min(n, 100) : 10; };
const warmWindowMs = () => envMs("DATABENTO_WARM_WINDOW_MS", 3 * 864e5);
const warmIdleMs = () => envMs("DATABENTO_WARM_IDLE_MS", 6 * 3600_000);
export const backgroundDailyMax = () => {
  const raw = String(process.env.DATABENTO_BACKGROUND_DAILY_MAX_CALLS ?? "").trim();
  const n = Number(raw);
  // A malformed value falls back to the default, never to unbounded.
  return raw !== "" && Number.isInteger(n) && n >= 0 ? n : 150;
};

function spendBackground() {
  const day = new Date().toISOString().slice(0, 10);
  if (warm.day !== day) { warm.day = day; warm.calls = 0; }
  if (warm.calls + 1 > backgroundDailyMax()) {
    if (warm.ceilingHitDay !== day) { warm.ceilingHitDay = day; console.warn(`[databento] quote warmer reached its daily ceiling (${backgroundDailyMax()} background calls); requests read inline until the next UTC day`); }
    return false;
  }
  warm.calls++;
  return true;
}

/** A successful paid quote of `symbol`: feeds the warmer's top-N list. */
export function noteQuoteSymbol(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (!s) return;
  const now = Date.now();
  lastDemandAt = now;
  const row = popularity.get(s) || { hits: 0, lastAt: 0 };
  row.hits++; row.lastAt = now;
  popularity.delete(s); popularity.set(s, row);
  while (popularity.size > POPULARITY_MAX) popularity.delete(popularity.keys().next().value);
}
export function warmSymbols(n = warmTopN()) {
  const since = Date.now() - warmWindowMs();
  return [...popularity.entries()].filter(([, r]) => r.lastAt >= since)
    .sort((a, b) => b[1].hits - a[1].hits || b[1].lastAt - a[1].lastAt).slice(0, n).map(([s]) => s);
}

async function auditQuotePrice(end) {
  if (quotePriceAudit.end === end) return;
  if (!spendBackground()) return;
  quotePriceAudit = { end, at: Date.now(), ok: null };
  try {
    const usd = await priceOf({ dataset: DATASET, symbols: QUOTE_AUDIT_SYMBOL, schema: "ohlcv-1d", ...quoteWindow(end) });
    // No number: the session is not audited, and the next tick tries again.
    if (!Number.isFinite(usd)) { quotePriceAudit.end = null; return; }
    quotePriceAudit.ok = usd <= DEFAULT_MAX_QUERY_USD;
    if (!quotePriceAudit.ok && !quotePriceInline) {
      quotePriceInline = true;
      console.warn("[databento] the quote-shaped query priced over its bound; the price check is back on every quote read");
    }
  } catch { quotePriceAudit.end = null; /* pricing unavailable: quotes stay priced inline; retried on the next tick */ }
}

/** One warmer pass. Exported for tests; the timer calls it. */
export async function warmTick() {
  warm.lastTickAt = Date.now();
  if (!databentoEnabled()) return { skipped: "no-key" };
  const idle = Date.now() - lastDemandAt > warmIdleMs();
  // The boot read (no value yet) runs once without demand; after that, no
  // demand means no call.
  if (idle && (rangeState.end || warm.primed)) return { skipped: "idle" };
  warm.primed = true;
  if (!spendBackground()) return { skipped: "ceiling" };
  let end;
  try { end = await readRange(); } catch (e) { return { skipped: "range-failed", error: String(e?.message || e).slice(0, 120) }; }
  // The quote shape is priced once per session, including the boot read, so
  // no quote goes unpriced past the first tick after a deploy.
  await auditQuotePrice(end);
  if (idle || end === warm.lastWarmedEnd) return { end };
  warm.lastWarmedEnd = end;
  let read = 0;
  for (const symbol of warmSymbols()) {
    const { start } = quoteWindow(end);
    if (barsCache.has(`${DATASET}|${symbol}|ohlcv-1d|${start}|${end}`)) continue;
    // A pre-read priced inline is two upstream calls; both count.
    if (!spendBackground()) break;
    if (readPricesInline({ dataset: DATASET, symbols: symbol, schema: "ohlcv-1d", start, end }) && !spendBackground()) break;
    try { await dailyBarsRead({ symbol, start, end }); read++; warm.prefetched++; } catch { /* a failed pre-read is a cold read later */ }
  }
  return { end, prefetched: read };
}

// The last tick's outcome ({ end, prefetched } or { skipped: reason }), kept
// for the operator surface so a warmer that never reads says why.
async function recordedTick() {
  try { warm.lastResult = await warmTick(); }
  catch (e) { warm.lastResult = { skipped: "error", error: String(e?.message || e).slice(0, 120) }; }
  return warm.lastResult;
}

/** Start the warmer (boot only; idempotent). Returns whether it is running. */
export function startQuoteWarmer() {
  if (warm.started) return true;
  if (!databentoEnabled() || String(process.env.DATABENTO_WARM || "").toLowerCase() === "off") return false;
  warm.started = true;
  recordedTick();
  warm.timer = setInterval(() => { recordedTick(); }, RANGE_REFRESH_MS);
  warm.timer.unref?.();
  return true;
}
export function stopQuoteWarmer() { if (warm.timer) clearInterval(warm.timer); warm.timer = null; warm.started = false; }

/** Counts only (no symbols: they are buyer inputs), for the operator surface. */
export function quoteWarmerStatus() {
  const day = new Date().toISOString().slice(0, 10);
  return {
    running: warm.started,
    lastTickAt: warm.lastTickAt ? new Date(warm.lastTickAt).toISOString() : null,
    range: rangeState.end ? { end: rangeState.end, ageSec: Math.round((Date.now() - rangeState.at) / 1000) } : null,
    background: { day, calls: warm.day === day ? warm.calls : 0, dailyMax: backgroundDailyMax(), ceilingHit: warm.ceilingHitDay === day },
    trackedSymbols: popularity.size, topN: warmTopN(), prefetched: warm.prefetched,
    quotePriceCheck: quotePriceInline ? "inline" : "per-session",
    quotePriceAuditOk: quotePriceAudit.ok,
    lastTick: warm.lastResult ? { skipped: warm.lastResult.skipped || null, error: warm.lastResult.error || null, prefetched: warm.lastResult.prefetched ?? null } : null,
  };
}

/** Test hook: forget every piece of warm state. */
export function __resetDatabentoState() {
  stopQuoteWarmer();
  rangeState = { end: null, at: 0 }; rangeInflight = null; hostCheckedAt = 0;
  barsCache.clear(); barsInflight.clear(); popularity.clear(); lastDemandAt = 0;
  quotePriceInline = false; quotePriceAudit = { end: null, at: 0, ok: null };
  Object.assign(warm, { lastTickAt: 0, lastWarmedEnd: null, day: null, calls: 0, ceilingHitDay: null, prefetched: 0, primed: false });
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
