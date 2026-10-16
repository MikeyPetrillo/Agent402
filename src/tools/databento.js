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
// TWO DATASETS, one answer shape.
//
// EQUS.SUMMARY (primary) is the consolidated end-of-day summary that Nasdaq
// disseminates on its NLS+ feed: one ohlcv-1d bar per symbol per session,
// across all US exchanges and ATSs, volume included (the 20:15 ET summary,
// so post-market volume is in it). Prices are unadjusted. Its history starts
// 2024-07-01, which covers every window these tools serve.
//
// DBEQ.BASIC (fallback) is a three-venue consolidation (NYSE Texas, NYSE
// National, IEX), not the consolidated tape. MIAX Pearl left the dataset on
// 2024-04-01. Prices track the wider market closely; VOLUME DOES NOT,
// because it counts only those venues. A read falls back to it only when the
// primary answers with an error or no rows (a dataset-level failure). A
// transport failure (timeout, refused connection) is the same host for both,
// so it does not double the wait by retrying the other dataset.
//
// Every answer names the dataset it came from and its coverage, so a
// three-venue figure never reads as a total. DATABENTO_SUMMARY=off pins the
// fallback.
import { assertPublicUrl } from "./fetch-guard.js";
import { upstreamFetch, bodyUnderDeadline } from "../upstream-deadline.js";
import { getSharedRedisClient } from "../shared-limit.js";
import { leased } from "../state-db.js";

const HOST = "https://hist.databento.com/v0";
export const PRIMARY_DATASET = "EQUS.SUMMARY";
export const FALLBACK_DATASET = "DBEQ.BASIC";
export const VENUES = "NYSE Texas (formerly NYSE Chicago), NYSE National, IEX";
/** What each dataset covers, as the tools report it. */
export const COVERAGE = Object.freeze({
  [PRIMARY_DATASET]: Object.freeze({
    dataset: PRIMARY_DATASET, coverage: "consolidated", consolidated: true,
    venues: "All US exchanges and ATSs (consolidated end-of-day summary)",
  }),
  [FALLBACK_DATASET]: Object.freeze({
    dataset: FALLBACK_DATASET, coverage: "three-venue", consolidated: false, venues: VENUES,
  }),
});
const summaryOn = () => String(process.env.DATABENTO_SUMMARY || "").trim().toLowerCase() !== "off";
/** The datasets a read tries, in order. */
export const datasetOrder = () => (summaryOn() ? [PRIMARY_DATASET, FALLBACK_DATASET] : [FALLBACK_DATASET]);
// Databento prices are fixed-point integers scaled by 1e9.
const PX = 1e-9;
// A query is priced by uncompressed bytes. Nothing we issue should cost more
// than a fraction of the call's price, so a malformed or over-wide range is
// refused BEFORE it is run rather than discovered on the invoice.
const DEFAULT_MAX_QUERY_USD = Number(process.env.DATABENTO_MAX_QUERY_USD || 0.0002);

const bad = (msg, code = 400) => { const e = new Error(msg); e.statusCode = code; return e; };
// A failure the dataset itself answered (an HTTP error status or no rows), as
// opposed to a transport failure: only this kind moves a read to the fallback.
const datasetFailure = (e) => Object.assign(e, { datasetError: true });
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
// tighter now, composed with the handler budget (src/upstream-deadline.js),
// and a read that outlives its cap or a dropped connection is a 503 naming
// the upstream and the step; a >= 400 cancels settlement, so nobody is
// charged for it.
// DATABENTO_{RANGE,COST,DATA}_TIMEOUT_MS override a cap (tests drive each read
// to its deadline without waiting the production cap out).
const capMs = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : dflt; };
export const DATABENTO_TIMEOUTS_MS = { range: capMs("DATABENTO_RANGE_TIMEOUT_MS", 6_000), cost: capMs("DATABENTO_COST_TIMEOUT_MS", 5_000), data: capMs("DATABENTO_DATA_TIMEOUT_MS", 12_000) };
// The ctx object is kept so the body read runs under the same deadline:
// upstreamFetch bounds headers AND body with one signal, and a body that
// stalls past it rejects with a bare TimeoutError ("The operation was aborted
// due to timeout"), which carries no status and used to surface as a 500.
// bodyUnderDeadline maps that abort to the same 503 as a header timeout.
async function readUnderDeadline(url, init, timeoutMs, step) {
  const ctx = { label: "Market data upstream", step, timeoutMs, tag: "[databento]" };
  const res = await upstreamFetch(url, init, ctx);
  return { res, body: (read) => bodyUnderDeadline(read(res), ctx) };
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

// ---------------------------------------------------------- shared copy
//
// Every replica used to hold its own bars cache, session boundary and quote
// price audit, so each warmed its own copy and every local miss paid the
// upstream, which on a slow evening answers a one-symbol read in seconds.
// With REDIS_URL set, a local miss reads the shared copy first and an
// upstream read writes it back, so a read made by one replica serves the
// others. What is shared is exactly what a fresh read of the same key
// returns (end-of-day bars keyed on dataset, symbol, schema and a range whose
// end is the dataset's own end; the boundary with the time it was confirmed;
// the audit of one dataset and session), so the answer does not change by
// replica. Every command is bounded by SHARED_DEADLINE_MS; one that does not
// answer, a payload that does not parse, or no Redis at all is a miss and
// the local path runs as before. Nothing is ever served from the shared copy
// that a local read would refuse.
const SHARED_PREFIX = () => String(process.env.DATABENTO_SHARED_PREFIX || "databento:v1:");
export const SHARED_DEADLINE_MS = capMs("DATABENTO_SHARED_DEADLINE_MS", 250);
/** Bars and audits outlive a session by a margin; the key itself changes
 *  when a new session lands, so the TTL only reclaims space. */
export const SHARED_BARS_TTL_S = 36 * 3600;
const SHARED_RANGE_TTL_S = 2 * 3600;
const sharedCounts = { hits: 0, misses: 0, writes: 0, errors: 0 };
const sharedPending = new Set();
function within(p) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${SHARED_DEADLINE_MS} ms`)), SHARED_DEADLINE_MS); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}
async function sharedClient() {
  try { return await within(getSharedRedisClient()); } catch { return null; }
}
async function sharedGet(key) {
  const c = await sharedClient();
  if (!c) return null;
  try {
    const raw = await within(c.get(SHARED_PREFIX() + key));
    if (raw == null) { sharedCounts.misses++; return null; }
    return JSON.parse(raw);
  } catch { sharedCounts.errors++; return null; }
}
/** Write-behind: never awaited on a request path. */
function sharedSet(key, value, ttlS) {
  const p = (async () => {
    const c = await sharedClient();
    if (!c) return;
    try { await within(c.set(SHARED_PREFIX() + key, JSON.stringify(value), { EX: ttlS })); sharedCounts.writes++; }
    catch { sharedCounts.errors++; }
  })();
  sharedPending.add(p);
  p.finally(() => sharedPending.delete(p));
  return p;
}
/** Test hook: resolves once every write-behind started so far has landed. */
export async function __sharedWritesSettled() { await Promise.allSettled([...sharedPending]); }
export function sharedCacheCounts() { return { ...sharedCounts }; }
const validBars = (v) => v && typeof v.fetchedAt === "string" && Array.isArray(v.bars) && v.bars.length > 0
  && v.bars.every((b) => b && typeof b.day === "string" && Number.isFinite(b.close) && Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.open));

async function post(path, params, timeoutMs = DATABENTO_TIMEOUTS_MS.data) {
  const url = `${HOST}/${path}`;
  await checkHost(url);
  const { res, body } = await readUnderDeadline(url, {
    method: "POST",
    headers: { authorization: auth(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  }, timeoutMs, path.replace(/^.*\./, "").replace(/_/g, " "));
  const text = await body((r) => r.text());
  if (!res.ok) {
    // Their 4xx bodies name the cause (unknown symbol, range past the data).
    // Relay the CLASS, never the raw body: it can carry query details.
    // An unknown symbol is the caller's input: no fallback read for it.
    if (res.status === 422 && /symbol/i.test(text)) throw bad("No market data for that symbol. US equities only - indices, FX and crypto are not covered.");
    if (res.status === 422) throw datasetFailure(bad("That date range is outside the available data."));
    if (res.status === 401 || res.status === 403) throw datasetFailure(bad("Market data upstream rejected our credentials.", 503));
    throw datasetFailure(bad(`Market data upstream returned ${res.status}.`, 502));
  }
  return text;
}

async function get(path, params) {
  const url = `${HOST}/${path}?${new URLSearchParams(params)}`;
  await checkHost(url);
  const { res, body } = await readUnderDeadline(url, { headers: { authorization: auth() } }, DATABENTO_TIMEOUTS_MS.range, "dataset range");
  if (!res.ok) throw datasetFailure(bad(`Market data upstream returned ${res.status}.`, 502));
  const text = await body((r) => r.text());
  try { return JSON.parse(text); } catch { throw datasetFailure(bad("Market data upstream returned an unreadable range answer.", 502)); }
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
let rangeState = { end: null, at: 0, dataset: null };
let rangeInflight = null;
async function readRangeOf(dataset) {
  const r = await get("metadata.get_dataset_range", { dataset });
  const end = String(r.end ?? r.end_date ?? "").slice(0, 10);
  if (!end) throw datasetFailure(bad("Market data upstream did not report its available range.", 502));
  return end;
}
// The primary's range, or the fallback's when the primary answers with an
// error. A read that then asks the primary past its own end gets a 422 and
// falls back to the dataset the end came from.
function readRange() {
  if (!rangeInflight) {
    rangeInflight = (async () => {
      const order = datasetOrder();
      for (const [i, dataset] of order.entries()) {
        try {
          const end = await readRangeOf(dataset);
          rangeState = { end, at: Date.now(), dataset };
          sharedSet("range", rangeState, SHARED_RANGE_TTL_S);
          return end;
        } catch (e) {
          if (!e.datasetError || i === order.length - 1) throw e;
        }
      }
    })().finally(() => { rangeInflight = null; });
  }
  return rangeInflight;
}
/** Adopt the boundary another replica confirmed, when it is younger than
 *  `maxAgeMs` and newer than ours. Its confirmation time is kept, so the age
 *  an answer reports is the real one. */
async function adoptSharedRange(maxAgeMs) {
  const s = await sharedGet("range");
  const ok = s && typeof s.end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.end) && Number.isFinite(s.at)
    && datasetOrder().includes(s.dataset) && Date.now() - s.at < maxAgeMs && s.at > rangeState.at;
  if (!ok) return false;
  sharedCounts.hits++;
  rangeState = { end: s.end, at: s.at, dataset: s.dataset };
  return true;
}
/** `demand: false` (the self-check) reads the range without counting as a
 *  buyer's demand, so it never keeps the warmer awake. */
export async function availableEndInfo({ demand = true } = {}) {
  if (demand) lastDemandAt = Date.now();
  let age = Date.now() - rangeState.at;
  if (rangeState.end && age < rangeMaxAgeMs()) return { end: rangeState.end, checkedAt: new Date(rangeState.at).toISOString(), ageMs: age, cached: true };
  // Stale here: another replica's warmer may have confirmed it since.
  if (await adoptSharedRange(rangeMaxAgeMs())) {
    age = Date.now() - rangeState.at;
    return { end: rangeState.end, checkedAt: new Date(rangeState.at).toISOString(), ageMs: age, cached: true };
  }
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
let quotePriceAudit = { end: null, at: 0, ok: null, dataset: null };
export function quoteWindow(end) {
  return { start: new Date(new Date(end) - QUOTE_LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10), end };
}
function isQuoteShape(params) {
  if (params.schema !== "ohlcv-1d" || String(params.symbols).includes(",")) return false;
  const span = (new Date(params.end) - new Date(params.start)) / 864e5;
  return Number.isFinite(span) && span >= 0 && span <= QUOTE_LOOKBACK_DAYS;
}

export async function dailyBars(opts) { return (await dailyBarsRead(opts)).bars; }

const barsKey = (p) => `${p.dataset}|${p.symbols}|${p.schema}|${p.start}|${p.end}`;

/** Bars plus where they came from: { bars, cached, fetchedAt, dataset }.
 *  Tries the primary dataset, then the fallback on a dataset-level failure
 *  (see the header). A refusal of our own (the price bound), an unknown
 *  symbol and a transport failure are answered as they are. */
export async function dailyBarsRead({ symbol, start, end, maxUsd }) {
  const order = datasetOrder();
  for (const [i, dataset] of order.entries()) {
    try { return await dailyBarsOf(dataset, { symbol, start, end, maxUsd }); }
    catch (e) {
      if (!e.datasetError || i === order.length - 1) throw e;
      console.warn(`[databento] ${dataset} read failed (${e.statusCode}); answering from ${order[i + 1]}`);
    }
  }
}

async function dailyBarsOf(dataset, { symbol, start, end, maxUsd }) {
  const params = { dataset, symbols: String(symbol).toUpperCase(), schema: "ohlcv-1d", start, end };
  const key = barsKey(params);
  const hit = barsCache.get(key);
  if (hit) {
    // Refresh recency so a symbol polled daily is never the oldest entry.
    barsCache.delete(key); barsCache.set(key, hit);
    return { bars: hit.bars.map((b) => ({ ...b })), cached: true, fetchedAt: hit.fetchedAt, dataset };
  }
  // One promise per key covers the shared read and the upstream read, so
  // concurrent first reads still make at most one of each.
  let p = barsInflight.get(key);
  if (!p) {
    p = loadBars(params, key, maxUsd).finally(() => barsInflight.delete(key));
    barsInflight.set(key, p);
  }
  const r = await p;
  return { bars: r.bars.map((b) => ({ ...b })), cached: r.shared === true, fetchedAt: r.fetchedAt, dataset };
}

function putLocal(key, entry) {
  barsCache.set(key, entry);
  while (barsCache.size > barsCacheMax) barsCache.delete(barsCache.keys().next().value);
}
/** The shared copy of `key` into the local cache, or null. */
async function adoptSharedBars(key) {
  const v = await sharedGet(`bars:${key}`);
  if (!validBars(v)) return null;
  sharedCounts.hits++;
  const entry = { bars: v.bars.map((b) => Object.freeze({ ...b })), fetchedAt: v.fetchedAt };
  putLocal(key, entry);
  return entry;
}
async function loadBars(params, key, maxUsd) {
  const shared = await adoptSharedBars(key);
  if (shared) return { ...shared, shared: true };
  const entry = await readBars(params, key, maxUsd);
  sharedSet(`bars:${key}`, entry, SHARED_BARS_TTL_S);
  return entry;
}

/** Whether a read of `params` is priced on the request path: always, except
 *  a quote-shaped read of a session whose audit came back within the bound
 *  (an audit that has not run, threw, or answered no number leaves it on). */
export function readPricesInline(params, maxUsd) {
  const audited = quotePriceAudit.ok === true && quotePriceAudit.end === params.end && quotePriceAudit.dataset === params.dataset;
  return quotePriceInline || !audited || !isQuoteShape(params) || (maxUsd !== undefined && maxUsd < DEFAULT_MAX_QUERY_USD);
}

async function readBars(params, key, maxUsd) {
  // The price check, when it is on the request path, runs BEFORE the data
  // read: a query it refuses is never read (nor paid for upstream). Pricing
  // that is unavailable does not fail the call (assertAffordable).
  // A quote-shaped read whose session this process has not seen audited
  // asks the shared copy first: the replica that warmed may have audited it.
  if (readPricesInline(params, maxUsd) && !quotePriceInline && isQuoteShape(params)) await adoptSharedAudit(params.dataset, params.end);
  if (readPricesInline(params, maxUsd)) await assertAffordable(params, maxUsd);
  const text = await post("timeseries.get_range", { ...params, encoding: "json" });
  let rows;
  try { rows = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { throw datasetFailure(bad("Market data upstream returned an unreadable answer.", 502)); }
  if (!rows.length) throw datasetFailure(bad("No market data for that symbol in that range. US equities only."));
  // A consolidated dataset's volume is the market total, so it is also
  // returned as `volume`; a venue-partial one carries volume: null, never
  // its partial sum under that name.
  const total = COVERAGE[params.dataset]?.consolidated === true;
  const bars = consolidate(rows).map((b) => ({ ...b, volume: total ? b.venueVolume : null }));
  const entry = { bars: bars.map((b) => Object.freeze({ ...b })), fetchedAt: new Date().toISOString() };
  putLocal(key, entry);
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
const warm = { timer: null, started: false, lastTickAt: 0, lastWarmedEnd: null, day: null, calls: 0, ceilingHitDay: null, prefetched: 0, adopted: 0, leaseSkips: 0 };
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

// THE AUDIT ACROSS REPLICAS. An audit is a fact about one dataset and one
// session, not about the process that ran it, so it is shared on the same
// match the local check uses (dataset and session end): the replica that
// runs the warmer's tick writes it, and any other replica adopts it on its
// own tick or on the first quote read of that session, so it does not price
// every quote inline while another replica holds the warmer. An audit over
// the bound is shared too, and adopting it latches the inline check here as
// it does on the replica that ran it. Without Redis each replica still runs
// its own tick (the lease only keeps two ticks from overlapping), so each
// audits for itself as before.
const auditKey = (dataset, end) => `audit:${dataset}:${end}`;
async function adoptSharedAudit(dataset, end) {
  if (quotePriceAudit.ok !== null && quotePriceAudit.end === end && quotePriceAudit.dataset === dataset) return true;
  const v = await sharedGet(auditKey(dataset, end));
  if (!v || typeof v.ok !== "boolean") return false;
  sharedCounts.hits++;
  quotePriceAudit = { end, at: Number(v.at) || Date.now(), ok: v.ok, dataset };
  if (!v.ok && !quotePriceInline) {
    quotePriceInline = true;
    console.warn("[databento] a shared audit priced the quote-shaped query over its bound; the price check is back on every quote read");
  }
  return true;
}

async function auditQuotePrice(end) {
  const dataset = datasetOrder()[0];
  if (quotePriceAudit.end === end && quotePriceAudit.dataset === dataset) return;
  if (await adoptSharedAudit(dataset, end)) return;
  if (!spendBackground()) return;
  quotePriceAudit = { end, at: Date.now(), ok: null, dataset };
  try {
    const usd = await priceOf({ dataset, symbols: QUOTE_AUDIT_SYMBOL, schema: "ohlcv-1d", ...quoteWindow(end) });
    // No number: the session is not audited, and the next tick tries again.
    if (!Number.isFinite(usd)) { quotePriceAudit.end = null; return; }
    quotePriceAudit.ok = usd <= DEFAULT_MAX_QUERY_USD;
    sharedSet(auditKey(dataset, end), { ok: quotePriceAudit.ok, at: quotePriceAudit.at }, SHARED_BARS_TTL_S);
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
  // A boundary another replica confirmed inside this refresh interval is the
  // one this tick would read: adopt it and make no upstream call for it.
  let end;
  if (await adoptSharedRange(RANGE_REFRESH_MS * 0.9)) end = rangeState.end;
  else {
    if (!spendBackground()) return { skipped: "ceiling" };
    try { end = await readRange(); } catch (e) { return { skipped: "range-failed", error: String(e?.message || e).slice(0, 120) }; }
  }
  // Primed only once the boot read landed, so a failed boot read is retried
  // (recordedTick) even with no demand yet.
  warm.primed = true;
  // The quote shape is priced once per session, including the boot read, so
  // no quote goes unpriced past the first tick after a deploy.
  await auditQuotePrice(end);
  // The tick ends (and the lease is released) only once its shared writes
  // landed or timed out, so the next holder reads what this one wrote.
  if (idle || end === warm.lastWarmedEnd) { await __sharedWritesSettled(); return { end }; }
  warm.lastWarmedEnd = end;
  let read = 0;
  const dataset = datasetOrder()[0];
  for (const symbol of warmSymbols()) {
    const { start } = quoteWindow(end);
    const params = { dataset, symbols: symbol, schema: "ohlcv-1d", start, end };
    if (barsCache.has(barsKey(params))) continue;
    // Read by another replica: copy it here, no upstream call.
    if (await adoptSharedBars(barsKey(params))) { warm.adopted++; continue; }
    // A pre-read priced inline is two upstream calls; both count.
    if (!spendBackground()) break;
    if (readPricesInline(params) && !spendBackground()) break;
    try { await dailyBarsRead({ symbol, start, end }); read++; warm.prefetched++; } catch { /* a failed pre-read is a cold read later */ }
  }
  await __sharedWritesSettled();
  return { end, prefetched: read };
}

// The last tick's outcome ({ end, prefetched } or { skipped: reason }), kept
// for the operator surface so a warmer that never reads says why.
// A tick whose range read failed is retried soon, backing off to the normal
// interval: a boot whose event loop is busy for a few seconds (the revenue
// snapshot) can time out the first read, and waiting a full interval left the
// boundary on the request path for 15 minutes.
//
// ONE REPLICA AT A TIME. The tick runs under a lease (src/state-db.js), so two
// replicas never run it at once; the one that holds it reads upstream and its
// reads land in the shared copy. A replica that finds the lease held retries
// shortly (the holder's tick is short), and its own tick then adopts the
// boundary, the audit and the pre-read bars from the shared copy with no
// upstream call, so it serves warm and audited too. The lease only orders
// ticks: without a state database it is the tick itself, and without Redis
// each replica's tick reads for itself, as before. Fail-open like the other
// read-only loops: its only effect is cache reads under the daily ceiling.
const WARM_RETRY_MS = envMs("DATABENTO_WARM_RETRY_MS", 30_000);
const leasedWarmTick = leased("databento-quote-warmer", { ttlMs: 10 * 60_000, failOpen: true }, () => warmTick());
async function recordedTick() {
  try { warm.lastResult = await leasedWarmTick(); }
  catch (e) { warm.lastResult = { skipped: "error", error: String(e?.message || e).slice(0, 120) }; }
  if (warm.lastResult?.skipped === "leased") warm.leaseSkips++;
  // "busy" is this process's own tick still running: no retry for that.
  const failed = warm.lastResult?.skipped === "range-failed" || warm.lastResult?.skipped === "error"
    || (warm.lastResult?.skipped === "leased" && warm.lastResult?.reason !== "busy" && warm.lastResult?.reason !== "shutdown");
  if (warm.retryTimer) { clearTimeout(warm.retryTimer); warm.retryTimer = null; }
  if (failed && warm.started) {
    warm.retryDelay = Math.min(RANGE_REFRESH_MS, warm.retryDelay ? warm.retryDelay * 2 : WARM_RETRY_MS);
    warm.retryTimer = setTimeout(() => { warm.retryTimer = null; recordedTick(); }, warm.retryDelay);
    warm.retryTimer.unref?.();
  } else warm.retryDelay = 0;
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
export function stopQuoteWarmer() { if (warm.timer) clearInterval(warm.timer); if (warm.retryTimer) clearTimeout(warm.retryTimer); warm.timer = null; warm.retryTimer = null; warm.retryDelay = 0; warm.started = false; }

/** Counts only (no symbols: they are buyer inputs), for the operator surface. */
export function quoteWarmerStatus() {
  const day = new Date().toISOString().slice(0, 10);
  return {
    running: warm.started,
    lastTickAt: warm.lastTickAt ? new Date(warm.lastTickAt).toISOString() : null,
    range: rangeState.end ? { end: rangeState.end, dataset: rangeState.dataset, ageSec: Math.round((Date.now() - rangeState.at) / 1000) } : null,
    background: { day, calls: warm.day === day ? warm.calls : 0, dailyMax: backgroundDailyMax(), ceilingHit: warm.ceilingHitDay === day },
    trackedSymbols: popularity.size, topN: warmTopN(), prefetched: warm.prefetched, adoptedFromShared: warm.adopted, leaseSkips: warm.leaseSkips,
    shared: sharedCacheCounts(),
    quotePriceCheck: quotePriceInline ? "inline" : "per-session",
    quotePriceAuditOk: quotePriceAudit.ok,
    lastTick: warm.lastResult ? { skipped: warm.lastResult.skipped || null, error: warm.lastResult.error || null, prefetched: warm.lastResult.prefetched ?? null } : null,
  };
}

/** Test hook: forget every piece of warm state. */
export function __resetDatabentoState() {
  stopQuoteWarmer();
  rangeState = { end: null, at: 0, dataset: null }; rangeInflight = null; hostCheckedAt = 0;
  barsCache.clear(); barsInflight.clear(); popularity.clear(); lastDemandAt = 0;
  quotePriceInline = false; quotePriceAudit = { end: null, at: 0, ok: null, dataset: null };
  Object.assign(warm, { lastTickAt: 0, lastWarmedEnd: null, day: null, calls: 0, ceilingHitDay: null, prefetched: 0, adopted: 0, leaseSkips: 0, primed: false });
  for (const k of Object.keys(sharedCounts)) sharedCounts[k] = 0;
}

/** DBEQ.BASIC returns ONE BAR PER VENUE (EQUS.SUMMARY returns one bar per
 *  session, which this passes through unchanged). A quote consolidates them: the day's
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
