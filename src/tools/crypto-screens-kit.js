// Crypto-screens-kit: computed answers over market data. Each tool reads one
// to three upstream documents and answers with what it worked out from them:
// ranks, shares, spreads, deviations, concentration and flags. No tool here
// returns an upstream document reshaped, and none words an answer as advice,
// a rating or a call to trade: a flag names a measured condition and the
// threshold that set it.
//
//   funding-screener        funding and basis for one coin across every listed
//                           perpetual venue (or a board of coins)
//   stablecoin-depeg-watch  every USD stablecoin above a size floor, deviation
//                           now, over 24 hours and over 7 days
//   exchange-spread         one coin's price on every venue against the median
//   defi-screener           the DeFi category ranked with computed columns
//   chain-board             native assets of chains ranked against the market
//   dex-volume-board        a network's DEXes by share of top-pool volume
//   dex-pool-health         one pool: liquidity, churn, flow and wallet mix
//
// Upstream: the CoinGecko API through crypto-markets-kit's cgGet, so every
// read shares that kit's response cache (this process and, through the shared
// store, every replica), its error mapping, and the one per-minute and daily
// budget in coingecko-rate.js. A repeat call inside a document's cache window
// spends nothing of that budget; the large documents (the derivatives list,
// the stablecoin page with its 7-day series) are cached as the few fields the
// tools read. The on-chain pool endpoints answer only to a key, so the two
// pool tools answer 503 (nothing charged) on a deployment without one.
//
// Every tool carries the credit CoinGecko's terms require, in its description
// and as the `credit` field of every answer (src/data-attribution.js).

import { cgGet, knownIdGate } from "./crypto-markets-kit.js";
import { cgScopeAll } from "./coingecko-rate.js";
import { attribute, creditAnswers, COINGECKO_CREDIT } from "../data-attribution.js";
import { underBudgetAll, PAYMENT_WINDOW_BUDGET_MS } from "../upstream-deadline.js";
import { partialFields } from "../partial-answer.js";

const SOURCE = "coingecko";
// How long each tool's upstream documents are kept (the shared response cache
// in crypto-markets-kit.js: keyed on the upstream URL built from the
// normalized input, bounded, shared across replicas). The key's daily budget
// is one number for every tool that reads this upstream, so a window is as
// long as the data behind it allows: one caller polling a tool every minute
// spends (documents read) x (86400 / window) reads a day on it (the table in
// scripts/test-crypto-screens-kit.js works the sum out for one such caller
// per tool). That is not a ceiling: callers that change the input each call
// (network after network, pool after pool, pools=100 at five pages a call)
// miss the cache every time. The ceiling is the day less a reserve kept for
// the other CoinGecko tools (cgScopeAll at the end of this file, cgCeiling in
// coingecko-rate.js: COINGECKO_OTHERS_RESERVE of COINGECKO_DAILY_MAX),
// whatever the inputs, so the other tools always keep that reserve; and every
// page a board reads past its default is quoted at the listed price per page
// (dexVolumeBoard.quote), so a read costs the same whatever `pools` asks.
//   funding rates settle every one to eight hours           30 minutes
//   the stablecoin page (now, 24-hour and 7-day ranges)     15 minutes
//   one coin's venue tickers move fastest                    5 minutes
//   the DeFi page and the market page (24-hour columns)     30 minutes
//   a network's pool pages (24-hour volume per pool)        30 minutes
//   a pool's latest trades                                   5 minutes
//   a pool's own totals (liquidity, 24-hour volume, age)    30 minutes
//   the chain list (which chains exist, their native coin)   6 hours
// Each listing states its window ("refreshed every N minutes").
const MIN = 60_000;
export const SCREEN_TTL = Object.freeze({
  funding: 30 * MIN,         // funding-screener: the derivatives list
  depeg: 15 * MIN,           // stablecoin-depeg-watch: the stablecoin page with its 7-day series
  spread: 5 * MIN,           // exchange-spread: one coin's venue tickers
  defi: 30 * MIN,            // defi-screener: the DeFi category page
  chainMarkets: 30 * MIN,    // chain-board: the market page and the global totals
  chainPlatforms: 360 * MIN, // chain-board: the chain list (reference data)
  dexBoard: 30 * MIN,        // dex-volume-board: a network's pool pages
  poolTrades: 5 * MIN,       // dex-pool-health: the pool's latest trades
  pool: 30 * MIN,            // dex-pool-health: the pool's own totals
});
/** The oldest a market reading from these tools can be: the longest window of
 *  a document that carries prices, rates or volumes. The chain list is
 *  reference data (names and ids) and is left out. */
export const SCREENS_MAX_TTL_MS = Math.max(...Object.entries(SCREEN_TTL).filter(([k]) => k !== "chainPlatforms").map(([, ms]) => ms));

/** Documents one uncached call reads, per tool: [window key, how many]. The
 *  daily cost of one caller polling without pause is the sum over a tool's
 *  rows of count x (86400000 / window). */
export const SCREEN_READS = Object.freeze({
  "funding-screener": [["funding", 1]],
  "stablecoin-depeg-watch": [["depeg", 1]],
  "exchange-spread": [["spread", 1]],
  "defi-screener": [["defi", 1]],
  "chain-board": [["chainMarkets", 2], ["chainPlatforms", 1]],
  "dex-volume-board": [["dexBoard", 5]], // pools=100, the most one call reads (3 by default)
  "dex-pool-health": [["poolTrades", 1], ["pool", 1]],
});
export const readsPerDay = (slug) => SCREEN_READS[slug].reduce((n, [k, count]) => n + count * (86_400_000 / SCREEN_TTL[k]), 0);

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// --- numbers ------------------------------------------------------------------
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null));
const round = (v, dp = 4) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(dp));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function quantile(xs, q) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
function stdev(xs) {
  if (xs.length < 2) return null;
  const m = sum(xs) / xs.length;
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}
/** Mean of `value` weighted by `weight` over rows where both are numbers. */
function weightedMean(rows, value, weight) {
  let w = 0, acc = 0;
  for (const r of rows) {
    const v = value(r), k = weight(r);
    if (v == null || k == null || k <= 0) continue;
    w += k; acc += v * k;
  }
  return w > 0 ? acc / w : null;
}
/** Herfindahl-Hirschman index of a list of sizes, on the 0-10000 scale. */
function hhi(sizes) {
  const total = sum(sizes);
  return total > 0 ? sum(sizes.map((s) => ((s / total) * 100) ** 2)) : null;
}
const share = (part, whole) => (part == null || !(whole > 0) ? null : (part / whole) * 100);

// --- inputs -------------------------------------------------------------------
const ID_RE = /^[a-z0-9][a-z0-9-_.]{0,99}$/i;
function takeId(raw, field, dflt = null) {
  if (raw == null || raw === "") {
    if (dflt != null) return dflt;
    throw bad(`"${field}" is required`);
  }
  if (typeof raw !== "string") throw bad(`"${field}" must be a string`);
  const s = raw.trim().toLowerCase();
  if (!ID_RE.test(s)) throw bad(`"${field}" must be a slug-style id (letters, digits, hyphens; max 100 chars)`);
  return s;
}
function takeInt(raw, field, { min, max, dflt }) {
  if (raw == null || raw === "") return dflt;
  const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^-?\d+$/.test(raw.trim()) ? parseInt(raw, 10) : NaN);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`"${field}" must be an integer ${min}-${max}`);
  return n;
}
function takeNumber(raw, field, { min, max, dflt }) {
  if (raw == null || raw === "") return dflt;
  const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^-?\d+(\.\d+)?(e\d+)?$/i.test(raw.trim()) ? Number(raw) : NaN);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`"${field}" must be a number ${min}-${max}`);
  return n;
}
function takeChoice(raw, field, choices, dflt) {
  if (raw == null || raw === "") return dflt;
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!choices.includes(s)) throw bad(`"${field}" must be one of ${choices.join(", ")}`);
  return s;
}
const SYMBOL_RE = /^[A-Za-z0-9.]{1,20}$/;
const POOL_RE = /^[A-Za-z0-9]{20,100}$/;

/** The oldest fetch time of several reads: an answer built from three
 *  documents is as old as its oldest one. */
const oldest = (reads) => reads.map((r) => r.fetchedAt).sort()[0];
const allCached = (reads) => reads.every((r) => r.cached);

// A computed answer is kept beside the documents it was worked out from. The
// same question (the normalized input) over the same documents (the very
// objects the response cache holds, each numbered once here) is answered from
// the kept text, so a repeat inside the cache window works nothing out again;
// a document read again is another object and the answer is computed again. Kept as text and parsed per
// answer, so no caller shares an object with another. Bounded: the oldest
// question leaves first.
export const ANSWER_MEMO_MAX = 500;
const answerMemo = new Map(); // question -> { stamp, json }
const memoCounts = { computed: 0, kept: 0 };
const docNumbers = new WeakMap(); // a cached document -> its number (the map holds no document alive)
let docCount = 0;
const docNumber = (doc) => { let n = docNumbers.get(doc); if (n === undefined) { n = ++docCount; docNumbers.set(doc, n); } return n; };
function answerOnce(question, reads, compute) {
  // cgGet hands back objects and lists only; anything else is an upstream failure, never a TypeError here.
  if (reads.some((r) => r.data === null || typeof r.data !== "object")) throw bad("Market data upstream returned an unexpected shape", 502);
  const stamp = reads.map((r) => docNumber(r.data)).join("|");
  const head = { source: SOURCE, fetchedAt: oldest(reads), cached: allCached(reads) };
  const hit = answerMemo.get(question);
  if (hit && hit.stamp === stamp) { memoCounts.kept++; return { ...head, ...JSON.parse(hit.json) }; }
  const answer = compute();
  memoCounts.computed++;
  answerMemo.delete(question);
  answerMemo.set(question, { stamp, json: JSON.stringify(answer) });
  while (answerMemo.size > ANSWER_MEMO_MAX) answerMemo.delete(answerMemo.keys().next().value);
  return { ...head, ...answer };
}

// An id the upstream does not know (a coin, a network, a pool) is remembered
// for a short time, so the same id sent again makes no upstream read. Only
// the upstream's own "unknown id" answer is remembered, never a failed read;
// the oldest id leaves first once a set is full.
export const UNKNOWN_ID_TTL_MS = 5 * MIN;
export const UNKNOWN_ID_MAX = 500;
function unknownIds() {
  const until = new Map(); // id -> remembered until (ms)
  return {
    has(id) { const t = until.get(id); if (t === undefined) return false; if (t > Date.now()) return true; until.delete(id); return false; },
    add(id) { until.delete(id); until.set(id, Date.now() + UNKNOWN_ID_TTL_MS); while (until.size > UNKNOWN_ID_MAX) until.delete(until.keys().next().value); },
    clear() { until.clear(); },
    get size() { return until.size; },
  };
}
const unknownCoins = unknownIds(), unknownNetworks = unknownIds(), unknownPools = unknownIds();
/** Test seam: forget every kept answer and every remembered unknown id. */
export function resetScreensMemory() { answerMemo.clear(); memoCounts.computed = 0; memoCounts.kept = 0; unknownCoins.clear(); unknownNetworks.clear(); unknownPools.clear(); }

// =============================================================================
// funding-screener
// =============================================================================
// One document lists every derivatives ticker the upstream tracks. Kept from
// it: perpetuals that are live, carry a funding rate and hold at least
// FUNDING_MIN_OI_USD of open interest (the floor a caller may screen at).
// funding_rate and basis arrive in percent; open interest and volume in USD.
const FUNDING_MIN_OI_USD = 100_000;
const FUNDING_INTERVALS_PER_YEAR = 3 * 365;
function perpFields(t) {
  if (!t || typeof t !== "object" || t.contract_type !== "perpetual" || t.expired_at != null) return null;
  const f = num(t.funding_rate), oi = num(t.open_interest);
  if (f == null || oi == null || oi < FUNDING_MIN_OI_USD) return null;
  if (typeof t.index_id !== "string" || !t.index_id || typeof t.market !== "string") return null;
  return [t.market, String(t.symbol ?? ""), t.index_id.toUpperCase(), f, oi, num(t.basis), num(t.volume_24h)];
}

// The derivatives list is one JSON array of several megabytes. Parsed whole it
// holds the event loop for the length of the parse, so it is read in slices:
// the text is scanned for the array's top-level objects, each is parsed on its
// own, and the loop is yielded once a slice's worth of text has been read. A
// body that is not one complete JSON array is refused, and one over the cap is
// not scanned at all.
export const LIST_SLICE_CHARS = 131_072;
export const LIST_MAX_CHARS = 48 * 1024 * 1024;
const isSpace = (c) => c === 32 || c === 10 || c === 13 || c === 9;
export async function eachListObject(text, onObject, sliceChars = LIST_SLICE_CHARS) {
  const n = text.length;
  if (n > LIST_MAX_CHARS) throw new Error("list too large");
  let i = 0;
  while (i < n && isSpace(text.charCodeAt(i))) i++;
  if (text.charCodeAt(i) !== 91) throw new Error("not a list");
  let depth = 1, inString = false, start = -1, closed = false, sliceEnd = i + sliceChars;
  for (i += 1; i < n; i++) {
    const c = text.charCodeAt(i);
    if (inString) { if (c === 92) i++; else if (c === 34) inString = false; continue; }
    if (c === 34) inString = true;
    else if (c === 123 || c === 91) { if (depth === 1 && c === 123) start = i; depth++; }
    else if (c === 125 || c === 93) {
      depth--;
      if (depth === 0) { closed = c === 93; i++; break; }
      if (depth === 1 && start >= 0) {
        onObject(JSON.parse(text.slice(start, i + 1)));
        start = -1;
        if (i >= sliceEnd) { await new Promise((r) => setImmediate(r)); sliceEnd = i + sliceChars; }
      }
    }
  }
  while (i < n && isSpace(text.charCodeAt(i))) i++;
  if (!closed || inString || i !== n) throw new Error("not a complete list");
}

const reducePerps = {
  name: "perps",
  fn(doc) {
    if (!Array.isArray(doc)) throw new Error("not a list");
    const rows = [];
    for (const t of doc) { const r = perpFields(t); if (r) rows.push(r); }
    return rows;
  },
  // The same reduction from the body text, in slices (cgLoad calls this one).
  async fromText(text) {
    const rows = [];
    await eachListObject(text, (t) => { const r = perpFields(t); if (r) rows.push(r); });
    return rows;
  },
};
const perpRow = (a) => ({ venue: a[0], symbol: a[1], coin: a[2], funding: a[3], oi: a[4], basis: a[5], volume: a[6] });

function fundingStats(rows) {
  const f = rows.map((r) => r.funding);
  const oiTotal = sum(rows.map((r) => r.oi));
  const weighted = weightedMean(rows, (r) => r.funding, (r) => r.oi);
  return {
    oiTotal,
    weighted,
    median: median(f),
    min: Math.min(...f),
    max: Math.max(...f),
    stdev: stdev(f),
    positiveShare: (f.filter((x) => x > 0).length / f.length) * 100,
  };
}

const fundingScreener = {
  route: "GET /api/funding-screener",
  name: "Funding rate screener across venues",
  slug: "funding-screener", aliases: ["funding-across-exchanges", "cross-exchange-funding", "funding-rate-comparison"],
  category: "crypto",
  price: "$0.005",
  description:
    "Perpetual funding for one coin across every listed derivatives venue, computed in one call: open-interest-weighted and median funding, the dispersion between the highest and lowest venue, annualized carry, the share of venues paying positive funding, basis, and how concentrated open interest is, with the highest and lowest venues ranked against the median. Omit `coin` for a board of coins ranked by open interest, dispersion or funding. Venues under the open-interest floor are left out. Flags name measured conditions (wide dispersion, a sign split, concentrated open interest). Deterministic code over market data; refreshed every 30 minutes.",
  tags: ["crypto", "derivatives", "perpetuals", "funding", "funding-rate", "basis", "carry", "screener", "cross-exchange"],
  discovery: {
    input: { coin: "ETH" },
    inputSchema: {
      properties: {
        coin: { type: "string", description: "Underlying ticker (BTC, ETH, SOL). Omit for the board of coins." },
        minOpenInterestUsd: { type: "number", description: `Leave out venues holding less open interest than this in USD (default 1000000, minimum ${FUNDING_MIN_OI_USD}).` },
        limit: { type: "number", description: "Coin mode: venues per side, 1-25 (default 5). Board mode: coins, 1-50 (default 10)." },
        sort: { type: "string", description: "Board mode: open_interest (default), dispersion or funding." },
      },
    },
    output: {
      example: {
        source: "coingecko", fetchedAt: "2026-11-16T12:00:00.000Z", cached: false,
        mode: "coin", coin: "ETH", venues: 42, minOpenInterestUsd: 1000000,
        funding: { unit: "percent per funding interval", oiWeightedPct: -0.0021, medianPct: -0.0034, minPct: -0.0153, maxPct: 0.0182, dispersionPct: 0.0335, stdevPct: 0.0061, positiveVenueSharePct: 31, annualizedOiWeightedPct: -2.2995, annualizationAssumes: "8-hour funding intervals (3 a day); venues with other intervals differ" },
        basis: { oiWeightedPct: 0.0612, medianPct: 0.0591, minPct: -0.02, maxPct: 0.1087 },
        openInterest: { totalUsd: 18400000000, topVenueSharePct: 22.58, hhi: 1034 },
        highest: [{ rank: 1, venue: "Example Futures", symbol: "ETH_PERP", fundingPct: 0.0182, annualizedPct: 19.929, vsMedianPct: 0.0216, openInterestSharePct: 1.2, basisPct: 0.0949 }],
        lowest: [{ rank: 1, venue: "Sample Derivatives", symbol: "ETHUSDT", fundingPct: -0.0153, annualizedPct: -16.7535, vsMedianPct: -0.0119, openInterestSharePct: 0.8, basisPct: 0.031 }],
        flags: ["funding-sign-split"],
      },
    },
  },
  handler: async (i = {}) => {
    const minOi = takeNumber(i.minOpenInterestUsd, "minOpenInterestUsd", { min: FUNDING_MIN_OI_USD, max: 1e12, dflt: 1_000_000 });
    let coin = null;
    if (i.coin != null && i.coin !== "") {
      if (typeof i.coin !== "string" || !SYMBOL_RE.test(i.coin.trim())) throw bad('"coin" must be an underlying ticker such as BTC, ETH or SOL');
      coin = i.coin.trim().toUpperCase();
    }
    const sort = takeChoice(i.sort, "sort", ["open_interest", "dispersion", "funding"], "open_interest");
    const read = await cgGet("/derivatives", {}, SCREEN_TTL.funding, reducePerps);
    const annual = (pct) => round(pct * FUNDING_INTERVALS_PER_YEAR, 4);
    const venuesAbove = () => read.data.map(perpRow).filter((r) => r.oi >= minOi);

    if (!coin) {
      const limit = takeInt(i.limit, "limit", { min: 1, max: 50, dflt: 10 });
      return answerOnce(`funding-board|${minOi}|${sort}|${limit}`, [read], () => {
      const all = venuesAbove();
      const by = new Map();
      for (const r of all) { if (!by.has(r.coin)) by.set(r.coin, []); by.get(r.coin).push(r); }
      const oiAll = sum(all.map((r) => r.oi));
      // A coin needs three venues before a dispersion means anything.
      const board = [...by.entries()].filter(([, rows]) => rows.length >= 3).map(([c, rows]) => {
        const s = fundingStats(rows);
        return { coin: c, venues: rows.length, oiWeightedFundingPct: round(s.weighted, 6), medianFundingPct: round(s.median, 6), dispersionPct: round(s.max - s.min, 6), annualizedOiWeightedPct: annual(s.weighted), openInterestSharePct: round(share(s.oiTotal, oiAll), 2), _oi: s.oiTotal };
      });
      const key = sort === "dispersion" ? (r) => r.dispersionPct : sort === "funding" ? (r) => Math.abs(r.oiWeightedFundingPct) : (r) => r._oi;
      board.sort((a, b) => key(b) - key(a));
      const coins = board.slice(0, limit).map(({ _oi, ...r }, idx) => ({ rank: idx + 1, ...r }));
      return {
        mode: "board", sort, minOpenInterestUsd: minOi, venuesScreened: all.length,
        ...partialFields(board.length, coins.length),
        unit: "percent per funding interval",
        annualizationAssumes: "8-hour funding intervals (3 a day); venues with other intervals differ",
        coins,
      };
      });
    }

    const limit = takeInt(i.limit, "limit", { min: 1, max: 25, dflt: 5 });
    return answerOnce(`funding-coin|${coin}|${minOi}|${limit}`, [read], () => {
    const rows = venuesAbove().filter((r) => r.coin === coin);
    if (rows.length === 0) throw bad(`No perpetual venue lists "${coin}" with at least $${minOi} of open interest - check the ticker or lower minOpenInterestUsd`, 422);
    const s = fundingStats(rows);
    const basisRows = rows.filter((r) => r.basis != null);
    const b = basisRows.map((r) => r.basis);
    const slim = (r, idx) => ({
      rank: idx + 1, venue: r.venue, symbol: r.symbol,
      fundingPct: round(r.funding, 6), annualizedPct: annual(r.funding), vsMedianPct: round(r.funding - s.median, 6),
      openInterestSharePct: round(share(r.oi, s.oiTotal), 2), basisPct: round(r.basis, 4),
    });
    const desc = [...rows].sort((x, y) => y.funding - x.funding);
    const per = Math.min(limit, rows.length);
    const oiShares = rows.map((r) => r.oi);
    const topShare = share(Math.max(...oiShares), s.oiTotal);
    const dispersion = s.max - s.min;
    const flags = [];
    // Thresholds: a spread between venues above 0.05% per interval; at least a
    // quarter of venues on each side of zero; one venue above half the open interest.
    if (rows.length >= 3 && dispersion > 0.05) flags.push("wide-dispersion");
    if (rows.length >= 4 && s.positiveShare >= 25 && s.positiveShare <= 75) flags.push("funding-sign-split");
    if (rows.length >= 2 && topShare > 50) flags.push("concentrated-open-interest");
    return {
      mode: "coin", coin, venues: rows.length, minOpenInterestUsd: minOi,
      funding: {
        unit: "percent per funding interval",
        oiWeightedPct: round(s.weighted, 6), medianPct: round(s.median, 6), minPct: round(s.min, 6), maxPct: round(s.max, 6),
        dispersionPct: round(dispersion, 6), stdevPct: round(s.stdev, 6), positiveVenueSharePct: round(s.positiveShare, 2),
        annualizedOiWeightedPct: annual(s.weighted),
        annualizationAssumes: "8-hour funding intervals (3 a day); venues with other intervals differ",
      },
      basis: b.length ? { oiWeightedPct: round(weightedMean(basisRows, (r) => r.basis, (r) => r.oi), 4), medianPct: round(median(b), 4), minPct: round(Math.min(...b), 4), maxPct: round(Math.max(...b), 4) } : null,
      openInterest: { totalUsd: Math.round(s.oiTotal), topVenueSharePct: round(topShare, 2), hhi: Math.round(hhi(oiShares)) },
      highest: desc.slice(0, per).map(slim),
      lowest: [...desc].reverse().slice(0, per).map(slim),
      flags,
    };
    });
  },
};

// =============================================================================
// stablecoin-depeg-watch
// =============================================================================
// One page of the stablecoin category (the 250 largest), with each coin's
// 7-day hourly series. Kept per coin: price, market cap, the 24-hour range and
// the low, high and median of the 7-day series.
const PEG_CLASS_BAND = 0.02; // a 7-day median within 2% of $1 is a USD peg
const DEPEG_PAGE = 250;
const reduceStables = {
  name: "stables7d",
  fn(doc) {
    if (!Array.isArray(doc)) throw new Error("not a list");
    return doc.map((c) => {
      const series = (Array.isArray(c?.sparkline_in_7d?.price) ? c.sparkline_in_7d.price : []).filter((p) => typeof p === "number" && Number.isFinite(p) && p > 0);
      const has = series.length >= 24;
      return [c?.id ?? null, typeof c?.symbol === "string" ? c.symbol.toUpperCase() : null, c?.name ?? null, num(c?.current_price), num(c?.market_cap), num(c?.high_24h), num(c?.low_24h),
        has ? Math.min(...series) : null, has ? Math.max(...series) : null, has ? median(series) : null];
    }).filter((r) => r[0] && r[3] != null && r[3] > 0 && r[4] != null && r[4] > 0);
  },
};
const stableRow = (a) => ({ id: a[0], symbol: a[1], name: a[2], price: a[3], cap: a[4], high24: a[5], low24: a[6], low7: a[7], high7: a[8], median7: a[9] });
const bps = (p) => (p == null ? null : (p - 1) * 10_000);
const worstBps = (lo, hi) => (lo == null && hi == null ? null : Math.max(Math.abs(bps(lo) ?? 0), Math.abs(bps(hi) ?? 0)));
const pegStatus = (dev) => (dev == null ? "unknown" : Math.abs(dev) <= 50 ? "on-peg" : Math.abs(dev) <= 200 ? "stressed" : "depegged");

const depegWatch = {
  route: "GET /api/stablecoin-depeg-watch",
  name: "Stablecoin depeg watch",
  slug: "stablecoin-depeg-watch", aliases: ["depeg-monitor", "stablecoin-depeg", "stablecoin-risk-watch"],
  category: "crypto",
  price: "$0.005",
  description:
    "Every USD stablecoin above a market-cap floor in one call, flagged ones first: deviation from $1 now in basis points, the worst deviation over 24 hours and over 7 days, an on-peg / stressed / depegged status (within 50 bps, within 200 bps, beyond), each coin's share of the watched market cap, and how much of that cap sits on peg. A coin counts as USD-pegged when its 7-day median price is within 2% of $1; the rest of the category (other currencies, value-accruing tokens, pegs lost more than a week ago) is listed separately with its distance from $1, never dropped silently. The whole-market sibling of stablecoin-peg, which checks a named list. Deterministic code over market data; refreshed every 15 minutes.",
  tags: ["crypto", "stablecoin", "depeg", "peg", "risk", "monitoring", "usdt", "usdc", "screener"],
  discovery: {
    input: { minMarketCapUsd: 100000000 },
    inputSchema: {
      properties: {
        minMarketCapUsd: { type: "number", description: "Watch stablecoins at or above this market cap in USD (default 100000000, minimum 1000000)." },
        thresholdBps: { type: "number", description: "Flag a coin whose deviation now, over 24 hours or over 7 days reaches this many basis points (default 50, 1-5000)." },
        limit: { type: "number", description: "Coins returned, 1-100 (default 25)." },
      },
    },
    output: {
      example: {
        source: "coingecko", fetchedAt: "2026-11-16T12:00:00.000Z", cached: false,
        peg: "USD $1.00", minMarketCapUsd: 100000000, thresholdBps: 50,
        screened: 38, assessed: 33, flaggedCount: 1, returned: 2, matched: 33, complete: false, truncated: true,
        onPegMarketCapSharePct: 99.41,
        worstNow: { symbol: "XUSD", deviationBps: -92.1 },
        coins: [
          { rank: 1, id: "example-usd", symbol: "XUSD", name: "Example USD", deviationBps: -92.1, maxDeviation24hBps: 117.2, maxDeviation7dBps: 131.5, marketCapSharePct: 0.07, status: "stressed", flags: ["off-peg-now", "off-peg-24h", "off-peg-7d"] },
          { rank: 2, id: "tether", symbol: "USDT", name: "Tether", deviationBps: -6.49, maxDeviation24hBps: 9.1, maxDeviation7dBps: 14.3, marketCapSharePct: 61.2, status: "on-peg", flags: [] },
        ],
        notAssessed: { count: 5, reason: "7-day median price is more than 2% from $1: another currency's peg, a value-accruing token, or a peg lost more than a week ago", coins: [{ id: "example-euro", symbol: "XEUR", distanceFromUsdPct: 9.9 }] },
      },
    },
  },
  handler: async (i = {}) => {
    const floor = takeNumber(i.minMarketCapUsd, "minMarketCapUsd", { min: 1_000_000, max: 1e13, dflt: 100_000_000 });
    const threshold = takeNumber(i.thresholdBps, "thresholdBps", { min: 1, max: 5000, dflt: 50 });
    const limit = takeInt(i.limit, "limit", { min: 1, max: 100, dflt: 25 });
    const read = await cgGet("/coins/markets", { vs_currency: "usd", category: "stablecoins", order: "market_cap_desc", per_page: DEPEG_PAGE, page: 1, sparkline: "true" }, SCREEN_TTL.depeg, reduceStables);
    return answerOnce(`depeg|${floor}|${threshold}|${limit}`, [read], () => {
    const page = read.data.map(stableRow);
    const inScope = page.filter((c) => c.cap >= floor);
    // The page holds the 250 largest; a floor under the smallest row on a full
    // page may have more below it than this read saw.
    const floorBelowPage = page.length >= DEPEG_PAGE && page[page.length - 1].cap >= floor;
    const isUsd = (c) => (c.median7 != null ? Math.abs(c.median7 - 1) <= PEG_CLASS_BAND : Math.abs(c.price - 1) <= PEG_CLASS_BAND);
    const assessed = inScope.filter(isUsd);
    const other = inScope.filter((c) => !isUsd(c));
    const capAssessed = sum(assessed.map((c) => c.cap));
    const rows = assessed.map((c) => {
      const dev = bps(c.price);
      // Each window holds the one inside it: the 24 hours include the price
      // now, and the 7 days include the last 24 hours (the 7-day series is
      // hourly, so a wick inside an hour shows only in the 24-hour range).
      const range24 = worstBps(c.low24, c.high24);
      const d24 = range24 == null ? null : Math.max(range24, Math.abs(dev));
      const range7 = worstBps(c.low7, c.high7);
      const d7 = range7 == null ? null : Math.max(range7, d24 ?? Math.abs(dev));
      const flags = [];
      if (Math.abs(dev) >= threshold) flags.push("off-peg-now");
      if (d24 != null && d24 >= threshold) flags.push("off-peg-24h");
      if (d7 != null && d7 >= threshold) flags.push("off-peg-7d");
      return { id: c.id, symbol: c.symbol, name: c.name, deviationBps: round(dev, 2), maxDeviation24hBps: round(d24, 2), maxDeviation7dBps: round(d7, 2), marketCapSharePct: round(share(c.cap, capAssessed), 2), status: pegStatus(dev), flags, _cap: c.cap };
    });
    // Flagged first (most flags, then the widest deviation now); the rest by
    // the widest deviation now.
    rows.sort((a, b) => (b.flags.length - a.flags.length) || (Math.abs(b.deviationBps) - Math.abs(a.deviationBps)));
    const onPegCap = sum(rows.filter((r) => Math.abs(r.deviationBps) < threshold).map((r) => r._cap));
    const worst = [...rows].sort((a, b) => Math.abs(b.deviationBps) - Math.abs(a.deviationBps))[0] || null;
    const coins = rows.slice(0, limit).map(({ _cap, ...r }, idx) => ({ rank: idx + 1, ...r }));
    return {
      peg: "USD $1.00", minMarketCapUsd: floor, thresholdBps: threshold,
      screened: inScope.length, assessed: assessed.length, flaggedCount: rows.filter((r) => r.flags.length).length,
      ...partialFields(rows.length, coins.length),
      ...(floorBelowPage ? { coverage: `the ${DEPEG_PAGE} largest stablecoins were read; smaller ones above this floor are not in this answer` } : {}),
      onPegMarketCapSharePct: round(share(onPegCap, capAssessed), 2),
      worstNow: worst ? { symbol: worst.symbol, deviationBps: worst.deviationBps } : null,
      coins,
      notAssessed: {
        count: other.length,
        reason: "7-day median price is more than 2% from $1: another currency's peg, a value-accruing token, or a peg lost more than a week ago",
        coins: other.slice(0, 20).map((c) => ({ id: c.id, symbol: c.symbol, distanceFromUsdPct: round((c.price - 1) * 100, 2) })),
      },
    };
    });
  },
};

// =============================================================================
// exchange-spread
// =============================================================================
// One coin's tickers, the 100 largest by volume. One ticker per venue (its
// largest), priced in USD by the upstream's conversion. Stale and anomalous
// tickers are counted and left out of the median.
const SPREAD_PAGE = 100;
const unknownCoin = (coin) => bad(`No coin with the id "${coin}" is tracked - check the coin id`, 422);
const exchangeSpread = {
  route: "GET /api/exchange-spread",
  name: "Cross-exchange price spread",
  slug: "exchange-spread", aliases: ["cross-exchange-spread", "price-dispersion", "venue-price-spread"],
  category: "crypto",
  price: "$0.005",
  description:
    "One coin's price across every major venue, measured against the cross-venue median: each venue's deviation in basis points, the high-to-low and interquartile spread, volume-weighted versus median price, each venue's quoted bid-ask spread and share of volume, and flags for stale, anomalous, wide-quote and outlier tickers. Takes the venue's largest market per coin from the 100 largest tickers by volume; pass `quote` to compare one quote currency only (USDT, USD, USDC). Measured facts only, no trade direction. Deterministic code over market data; refreshed every 5 minutes.",
  tags: ["crypto", "exchange", "spread", "price-dispersion", "cross-exchange", "venue", "bid-ask", "liquidity"],
  discovery: {
    input: { coin: "ethereum" },
    inputSchema: {
      properties: {
        coin: { type: "string", description: "Coin id (bitcoin, ethereum, solana). Use coin-search for ids." },
        quote: { type: "string", description: "Only compare markets quoted in this currency (USDT, USD, USDC). Omit for every quote, converted to USD." },
        limit: { type: "number", description: "Venues returned, widest deviation first, 1-50 (default 20)." },
      },
      required: ["coin"],
    },
    output: {
      example: {
        source: "coingecko", fetchedAt: "2026-11-16T12:00:00.000Z", cached: false,
        coin: "ethereum", name: "Ethereum", quote: null, tickersRead: 100, venuesCompared: 61,
        returned: 1, matched: 61, complete: false, truncated: true,
        medianPriceUsd: 1811.6, volumeWeightedPriceUsd: 1811.72,
        spread: { highLowBps: 38.4, interquartileBps: 4.1, stdevBps: 6.2, medianBidAskPct: 0.0117 },
        highest: { venue: "Example Exchange", pair: "ETH/USDT", deviationBps: 21.3 },
        lowest: { venue: "Sample Markets", pair: "ETH/USD", deviationBps: -17.1 },
        venues: [{ rank: 1, venue: "Example Exchange", pair: "ETH/USDT", deviationBps: 21.3, bidAskPct: 0.02, volumeSharePct: 0.4, flags: ["outlier"] }],
        excluded: { stale: 1, anomalous: 0 },
      },
    },
  },
  handler: async (i = {}) => {
    const coin = takeId(i.coin, "coin");
    let quote = null;
    if (i.quote != null && i.quote !== "") {
      if (typeof i.quote !== "string" || !SYMBOL_RE.test(i.quote.trim())) throw bad('"quote" must be a currency code such as USDT, USD or USDC');
      quote = i.quote.trim().toUpperCase();
    }
    const limit = takeInt(i.limit, "limit", { min: 1, max: 50, dflt: 20 });
    if (unknownCoins.has(coin)) throw unknownCoin(coin);
    try { await knownIdGate("coin", coin); } catch (err) { if (err?.unknownId) unknownCoins.add(coin); throw err?.unknownId ? unknownCoin(coin) : err; }
    let read;
    try { read = await cgGet(`/coins/${encodeURIComponent(coin)}/tickers`, { order: "volume_desc", page: 1 }, SCREEN_TTL.spread); } catch (err) {
      if (!err?.unknownId) throw err;
      unknownCoins.add(coin);
      throw unknownCoin(coin);
    }
    const doc = read.data;
    if (!doc || !Array.isArray(doc.tickers)) throw bad("Market data upstream returned an unexpected shape", 502);
    return answerOnce(`spread|${coin}|${quote ?? ""}|${limit}`, [read], () => {
    let stale = 0, anomalous = 0;
    const byVenue = new Map();
    for (const t of doc.tickers.slice(0, SPREAD_PAGE)) {
      const price = num(t?.converted_last?.usd), vol = num(t?.converted_volume?.usd) ?? 0;
      const venueId = t?.market?.identifier;
      if (price == null || price <= 0 || typeof venueId !== "string") continue;
      if (quote && String(t.target ?? "").toUpperCase() !== quote) continue;
      if (t.is_stale === true) { stale++; continue; }
      if (t.is_anomaly === true) { anomalous++; continue; }
      const row = { venue: t.market.name ?? venueId, pair: `${String(t.base ?? "").slice(0, 20)}/${String(t.target ?? "").slice(0, 20)}`, price, vol, bidAsk: num(t.bid_ask_spread_percentage) };
      const seen = byVenue.get(venueId);
      if (!seen || row.vol > seen.vol) byVenue.set(venueId, row);
    }
    const rows = [...byVenue.values()];
    if (rows.length < 2) throw bad(`Fewer than two live venues list "${coin}"${quote ? ` against ${quote}` : ""}: nothing to compare`, 422);
    const prices = rows.map((r) => r.price);
    const mid = median(prices);
    const devBps = (p) => ((p - mid) / mid) * 10_000;
    const volTotal = sum(rows.map((r) => r.vol));
    const devs = prices.map(devBps);
    const iqr = quantile(devs, 0.75) - quantile(devs, 0.25);
    // An outlier sits more than three interquartile ranges from the median
    // (and at least 10 bps, so a tight market does not flag noise).
    const outlierAt = Math.max(10, 3 * iqr);
    const shaped = rows.map((r) => {
      const d = devBps(r.price);
      const flags = [];
      if (Math.abs(d) > outlierAt) flags.push("outlier");
      if (r.bidAsk != null && r.bidAsk > 0.5) flags.push("wide-quote");
      return { venue: r.venue, pair: r.pair, deviationBps: round(d, 2), bidAskPct: round(r.bidAsk, 4), volumeSharePct: round(share(r.vol, volTotal), 2), flags };
    }).sort((a, b) => Math.abs(b.deviationBps) - Math.abs(a.deviationBps));
    const byDev = [...shaped].sort((a, b) => b.deviationBps - a.deviationBps);
    const pick = (r) => ({ venue: r.venue, pair: r.pair, deviationBps: r.deviationBps });
    const venues = shaped.slice(0, limit).map((r, idx) => ({ rank: idx + 1, ...r }));
    const quotes = rows.map((r) => r.bidAsk).filter((x) => x != null);
    return {
      coin, name: doc.name ?? null, quote, tickersRead: Math.min(doc.tickers.length, SPREAD_PAGE), venuesCompared: rows.length,
      ...partialFields(shaped.length, venues.length),
      medianPriceUsd: round(mid, mid < 1 ? 8 : 4),
      volumeWeightedPriceUsd: round(weightedMean(rows, (r) => r.price, (r) => r.vol), mid < 1 ? 8 : 4),
      spread: { highLowBps: round(Math.max(...devs) - Math.min(...devs), 2), interquartileBps: round(iqr, 2), stdevBps: round(stdev(devs), 2), medianBidAskPct: round(median(quotes), 4) },
      highest: pick(byDev[0]), lowest: pick(byDev[byDev.length - 1]),
      venues,
      excluded: { stale, anomalous },
    };
    });
  },
};

// =============================================================================
// defi-screener
// =============================================================================
const DEFI_CATEGORY = "decentralized-finance-defi";
const DEFI_PAGE = 250;
const reduceCategoryPage = {
  name: "screen",
  fn(doc) {
    if (!Array.isArray(doc)) throw new Error("not a list");
    return doc.map((c) => [c?.id ?? null, typeof c?.symbol === "string" ? c.symbol.toUpperCase() : null, c?.name ?? null, num(c?.market_cap), num(c?.total_volume),
      num(c?.price_change_percentage_24h), num(c?.price_change_percentage_7d_in_currency), num(c?.ath_change_percentage), num(c?.fully_diluted_valuation), num(c?.market_cap_rank)])
      .filter((r) => r[0] && r[3] != null && r[3] > 0);
  },
};
const screenRow = (a) => ({ id: a[0], symbol: a[1], name: a[2], cap: a[3], volume: a[4], ch24: a[5], ch7: a[6], athChange: a[7], fdv: a[8], marketRank: a[9] });
const DEFI_SORTS = ["market_cap", "turnover", "change_24h", "change_7d", "ath_drawdown"];

const defiScreener = {
  route: "GET /api/defi-screener",
  name: "DeFi token screener",
  slug: "defi-screener", aliases: ["defi-token-screener", "defi-tokens"],
  category: "crypto",
  price: "$0.005",
  description:
    "Screen the DeFi category's 250 largest tokens with computed columns: share of the category's market cap, turnover (24h volume over market cap), 24h move against the cap-weighted category, 7-day move, drawdown from the all-time high, fully-diluted value over market cap, and rank in the chosen order. Filter by market cap and turnover; sort by market_cap, turnover, change_24h, change_7d or ath_drawdown. Category totals come with it: turnover, cap-weighted 24h move, the share of tokens up on the day and the top ten's share of the cap. Flags name measured conditions (high turnover, deep drawdown, dilution overhang). Token market data, not locked value. Deterministic code over market data; refreshed every 30 minutes.",
  tags: ["crypto", "defi", "screener", "token-screener", "turnover", "momentum", "drawdown", "ranking", "category"],
  discovery: {
    input: { sort: "turnover", minMarketCapUsd: 100000000, limit: 5 },
    inputSchema: {
      properties: {
        sort: { type: "string", description: `Order: ${DEFI_SORTS.join(", ")} (default market_cap).` },
        minMarketCapUsd: { type: "number", description: "Only tokens at or above this market cap in USD (default 0)." },
        minTurnoverPct: { type: "number", description: "Only tokens whose 24h volume is at least this percent of market cap (default 0)." },
        limit: { type: "number", description: "Tokens returned, 1-100 (default 25)." },
      },
    },
    output: {
      example: {
        source: "coingecko", fetchedAt: "2026-11-16T12:00:00.000Z", cached: false,
        category: "decentralized-finance-defi", sort: "turnover", minMarketCapUsd: 100000000, minTurnoverPct: 0,
        screened: 250, returned: 1, matched: 58, complete: false, truncated: true,
        categoryTotals: { marketCapUsd: 98400000000, turnoverPct: 6.31, capWeightedChange24hPct: -0.42, tokensUpSharePct: 37.2, top10CapSharePct: 61.8 },
        tokens: [{ rank: 1, capRank: 14, id: "example-dex", symbol: "XDEX", name: "Example DEX", capSharePct: 0.91, turnoverPct: 48.2, change24hPct: 6.1, change24hVsCategoryPct: 6.52, change7dPct: -3.4, athDrawdownPct: -71.2, fdvToCapRatio: 1.62, flags: ["high-turnover", "deep-drawdown", "dilution-overhang"] }],
      },
    },
  },
  handler: async (i = {}) => {
    const sort = takeChoice(i.sort, "sort", DEFI_SORTS, "market_cap");
    const minCap = takeNumber(i.minMarketCapUsd, "minMarketCapUsd", { min: 0, max: 1e13, dflt: 0 });
    const minTurnover = takeNumber(i.minTurnoverPct, "minTurnoverPct", { min: 0, max: 100000, dflt: 0 });
    const limit = takeInt(i.limit, "limit", { min: 1, max: 100, dflt: 25 });
    const read = await cgGet("/coins/markets", { vs_currency: "usd", category: DEFI_CATEGORY, order: "market_cap_desc", per_page: DEFI_PAGE, page: 1, price_change_percentage: "7d" }, SCREEN_TTL.defi, reduceCategoryPage);
    return answerOnce(`defi|${sort}|${minCap}|${minTurnover}|${limit}`, [read], () => {
    const all = read.data.map(screenRow).sort((a, b) => b.cap - a.cap);
    if (all.length === 0) throw bad("Market data upstream returned no tokens for the category", 502);
    const capTotal = sum(all.map((c) => c.cap));
    const volTotal = sum(all.map((c) => c.volume ?? 0));
    const catChange = weightedMean(all, (c) => c.ch24, (c) => c.cap);
    const withMove = all.filter((c) => c.ch24 != null);
    const rows = all.map((c, idx) => {
      const turnover = share(c.volume, c.cap);
      const fdvRatio = c.fdv != null && c.fdv > 0 ? c.fdv / c.cap : null;
      const flags = [];
      // Thresholds: a day's volume above 25% of market cap; more than 80%
      // below the all-time high; fully diluted value above twice the cap.
      if (turnover != null && turnover > 25) flags.push("high-turnover");
      if (c.athChange != null && c.athChange < -80) flags.push("deep-drawdown");
      if (fdvRatio != null && fdvRatio > 2) flags.push("dilution-overhang");
      return {
        capRank: idx + 1, id: c.id, symbol: c.symbol, name: c.name,
        capSharePct: round(share(c.cap, capTotal), 3), turnoverPct: round(turnover, 2),
        change24hPct: round(c.ch24, 2), change24hVsCategoryPct: c.ch24 == null || catChange == null ? null : round(c.ch24 - catChange, 2),
        change7dPct: round(c.ch7, 2), athDrawdownPct: round(c.athChange, 2), fdvToCapRatio: round(fdvRatio, 2), flags, _cap: c.cap,
      };
    });
    const matched = rows.filter((r) => r._cap >= minCap && (r.turnoverPct ?? 0) >= minTurnover);
    const desc = (f) => (a, b) => (f(b) ?? -Infinity) - (f(a) ?? -Infinity);
    const order = { market_cap: desc((r) => r._cap), turnover: desc((r) => r.turnoverPct), change_24h: desc((r) => r.change24hPct), change_7d: desc((r) => r.change7dPct), ath_drawdown: (a, b) => (a.athDrawdownPct ?? Infinity) - (b.athDrawdownPct ?? Infinity) }[sort];
    matched.sort(order);
    const tokens = matched.slice(0, limit).map(({ _cap, ...r }, idx) => ({ rank: idx + 1, ...r }));
    return {
      category: DEFI_CATEGORY, sort, minMarketCapUsd: minCap, minTurnoverPct: minTurnover,
      screened: all.length, ...partialFields(matched.length, tokens.length),
      categoryTotals: {
        marketCapUsd: Math.round(capTotal), turnoverPct: round(share(volTotal, capTotal), 2), capWeightedChange24hPct: round(catChange, 2),
        tokensUpSharePct: withMove.length ? round((withMove.filter((c) => c.ch24 > 0).length / withMove.length) * 100, 2) : null,
        top10CapSharePct: round(share(sum(all.slice(0, 10).map((c) => c.cap)), capTotal), 2),
      },
      tokens,
    };
    });
  },
};

// =============================================================================
// chain-board
// =============================================================================
// Three documents: the asset platforms (each chain names its native coin), the
// 250 largest coins, and the whole-market totals. A native asset is ranked
// when it is among those 250; one asset can fuel many chains (ETH on its
// rollups), so a row is the asset with the chains that use it.
const reducePlatforms = {
  name: "native",
  fn(doc) {
    if (!Array.isArray(doc)) throw new Error("not a list");
    return doc.filter((p) => p && typeof p.id === "string" && typeof p.native_coin_id === "string" && p.native_coin_id)
      .map((p) => [p.id, p.name ?? p.id, Number.isInteger(p.chain_identifier) ? p.chain_identifier : null, p.native_coin_id]);
  },
};
const CHAIN_SORTS = ["market_cap", "change_24h", "turnover", "chains"];
const CHAINS_PER_ROW = 6;

const chainBoard = {
  route: "GET /api/chain-board",
  name: "Chain board by native asset",
  slug: "chain-board", aliases: ["chain-ranking", "blockchain-ranking"],
  category: "crypto",
  price: "$0.005",
  description:
    "Blockchains ranked by their native asset, computed from three market documents: each native asset's share of the whole crypto market cap, its 24h move against the whole market, turnover (24h volume over market cap), drawdown from the all-time high, and the chains it fuels with their EVM chain ids (one asset can serve many chains, as ETH does its rollups). Sort by market_cap, change_24h, turnover or chains. Covers native assets among the 250 largest coins and says how many tracked chains fall outside. Asset market data, not locked value. Deterministic code over market data; refreshed every 30 minutes (the list of chains every 6 hours).",
  tags: ["crypto", "chains", "blockchain", "layer-1", "layer-2", "native-asset", "ranking", "dominance", "market-share"],
  discovery: {
    input: { limit: 5 },
    inputSchema: {
      properties: {
        sort: { type: "string", description: `Order: ${CHAIN_SORTS.join(", ")} (default market_cap).` },
        limit: { type: "number", description: "Native assets returned, 1-100 (default 20)." },
      },
    },
    output: {
      example: {
        source: "coingecko", fetchedAt: "2026-11-16T12:00:00.000Z", cached: false,
        sort: "market_cap", chainsTracked: 470, chainsRanked: 212, chainsOutsideTop250: 258,
        returned: 1, matched: 74, complete: false, truncated: true,
        market: { change24hPct: -0.31, nativeAssetsCapSharePct: 71.4 },
        assets: [{ rank: 1, nativeCoin: "ethereum", symbol: "ETH", name: "Ethereum", capRank: 2, capSharePct: 10.01, change24hPct: 0.15, change24hVsMarketPct: 0.46, turnoverPct: 4.2, athDrawdownPct: -63.3, chainCount: 58, chains: [{ id: "ethereum", name: "Ethereum", chainId: 1 }, { id: "base", name: "Base", chainId: 8453 }] }],
      },
    },
  },
  handler: async (i = {}) => {
    const sort = takeChoice(i.sort, "sort", CHAIN_SORTS, "market_cap");
    const limit = takeInt(i.limit, "limit", { min: 1, max: 100, dflt: 20 });
    const reads = await Promise.all([
      cgGet("/asset_platforms", {}, SCREEN_TTL.chainPlatforms, reducePlatforms),
      cgGet("/coins/markets", { vs_currency: "usd", order: "market_cap_desc", per_page: 250, page: 1 }, SCREEN_TTL.chainMarkets, reduceCategoryPage),
      cgGet("/global", {}, SCREEN_TTL.chainMarkets),
    ]);
    const [platforms, markets, global] = reads;
    return answerOnce(`chain|${sort}|${limit}`, reads, () => {
    const g = global.data?.data;
    const marketCap = num(g?.total_market_cap?.usd);
    if (!(marketCap > 0)) throw bad("Market data upstream returned an unexpected shape", 502);
    const marketChange = num(g?.market_cap_change_percentage_24h_usd);
    const coins = new Map(markets.data.map(screenRow).map((c) => [c.id, c]));
    const byAsset = new Map();
    let ranked = 0;
    for (const [id, name, chainId, native] of platforms.data) {
      if (!coins.has(native)) continue;
      ranked++;
      if (!byAsset.has(native)) byAsset.set(native, []);
      byAsset.get(native).push({ id, name, chainId });
    }
    const rows = [...byAsset.entries()].map(([native, chains]) => {
      const c = coins.get(native);
      // The chain that shares the asset's own id first, then chains with an
      // EVM chain id, then by name: a stable order whatever the upstream's.
      chains.sort((a, b) => (Number(b.id === native) - Number(a.id === native)) || (Number(b.chainId != null) - Number(a.chainId != null)) || a.name.localeCompare(b.name));
      return {
        nativeCoin: native, symbol: c.symbol, name: c.name, capRank: c.marketRank,
        capSharePct: round(share(c.cap, marketCap), 3), change24hPct: round(c.ch24, 2),
        change24hVsMarketPct: c.ch24 == null || marketChange == null ? null : round(c.ch24 - marketChange, 2),
        turnoverPct: round(share(c.volume, c.cap), 2), athDrawdownPct: round(c.athChange, 2),
        chainCount: chains.length, chains: chains.slice(0, CHAINS_PER_ROW), _cap: c.cap,
      };
    });
    const desc = (f) => (a, b) => (f(b) ?? -Infinity) - (f(a) ?? -Infinity);
    rows.sort({ market_cap: desc((r) => r._cap), change_24h: desc((r) => r.change24hPct), turnover: desc((r) => r.turnoverPct), chains: desc((r) => r.chainCount) }[sort]);
    const assets = rows.slice(0, limit).map(({ _cap, ...r }, idx) => ({ rank: idx + 1, ...r }));
    return {
      sort, chainsTracked: platforms.data.length, chainsRanked: ranked, chainsOutsideTop250: platforms.data.length - ranked,
      ...partialFields(rows.length, assets.length),
      market: { change24hPct: round(marketChange, 2), nativeAssetsCapSharePct: round(share(sum(rows.map((r) => r._cap)), marketCap), 2) },
      assets,
    };
    });
  },
};

// =============================================================================
// dex-volume-board
// =============================================================================
// A network's top pools by 24-hour volume, 20 a page, read in parallel. The
// board is what those pools add up to per DEX: a share of the top-pool volume,
// not of every pool on the network, and the answer says so.
const POOLS_PER_PAGE = 20;
const reducePoolPage = {
  name: "pools",
  fn(doc) {
    if (!doc || !Array.isArray(doc.data)) throw new Error("not a pool page");
    const names = {};
    for (const x of Array.isArray(doc.included) ? doc.included : []) if (x?.type === "dex" && typeof x.id === "string") names[x.id] = x.attributes?.name ?? x.id;
    const pools = doc.data.map((p) => {
      const a = p?.attributes || {};
      const tx = a.transactions?.h24 || {};
      return [p?.relationships?.dex?.data?.id ?? null, a.address ?? null, a.name ?? null, num(a.volume_usd?.h24), num(a.reserve_in_usd), num(tx.buys), num(tx.sells)];
    }).filter((r) => r[0] && r[1]);
    return { names, pools };
  },
};

const unknownNetwork = (network) => bad(`No pools are tracked for network "${network}" - check the network id`, 422);

// PRICED BY THE PAGES READ. The listed price covers the default board (60
// pools, three pages); 80 and 100 pools read a fourth and fifth page, and each
// page past the default is quoted at the listed price over the default's pages
// (the per-input quote, src/payments.js acceptsForItem), so a read costs the
// same on every board. Fewer pools than the default pay the listed price.
const BOARD_PRICE = "$0.005";
const BOARD_DEFAULT_POOLS = 60;
const usdText = (usd) => "$" + Number(usd).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""); // as the 402 writes it
const boardPages = (pools) => pools / POOLS_PER_PAGE;
/** The price of a board of \`pools\` pools, in USD: never below the listed price. */
export function boardQuoteUsd(pools) {
  const list = Number(BOARD_PRICE.slice(1));
  const n = typeof pools === "number" ? pools : (typeof pools === "string" && /^\d+$/.test(pools.trim()) ? Number(pools) : BOARD_DEFAULT_POOLS);
  const pages = Number.isInteger(n) && n >= POOLS_PER_PAGE && n <= 100 && n % POOLS_PER_PAGE === 0 ? boardPages(n) : boardPages(BOARD_DEFAULT_POOLS);
  return Math.ceil(list * Math.max(1, pages / boardPages(BOARD_DEFAULT_POOLS)) * 1e6) / 1e6;
}

const dexVolumeBoard = {
  route: "GET /api/dex-volume-board",
  name: "DEX volume board by network",
  slug: "dex-volume-board", aliases: ["dex-volume", "dex-market-share"],
  category: "crypto",
  price: BOARD_PRICE,
  quote: (body) => boardQuoteUsd(body?.pools),
  quoteMaxUsd: boardQuoteUsd(100),
  description:
    `A network's decentralized exchanges ranked by their share of 24h volume across the network's top pools (the ${BOARD_DEFAULT_POOLS} largest by volume, or 20-100 with \`pools\`): each DEX's volume share, liquidity share, turnover (volume over liquidity), pool count, buy share of trades and its largest pool, with the network's concentration (the top DEX's share and a Herfindahl index). Networks use on-chain ids such as eth, base, solana, arbitrum, bsc, polygon_pos. Shares are of the pools read, stated in the answer. Up to ${BOARD_DEFAULT_POOLS} pools is the listed price; 80 and 100 pools read more pages and are quoted at ${usdText(boardQuoteUsd(80))} and ${usdText(boardQuoteUsd(100))} in the 402. Deterministic code over market data; refreshed every 30 minutes.`,
  tags: ["crypto", "dex", "volume", "market-share", "liquidity", "network", "ranking", "defi", "concentration"],
  discovery: {
    input: { network: "base" },
    inputSchema: {
      properties: {
        network: { type: "string", description: "On-chain network id: eth, base, solana, arbitrum, bsc, polygon_pos, optimism, avax, ..." },
        pools: { type: "number", description: `How many of the network's top pools by 24h volume to add up: 20, 40, 60, 80 or 100 (default ${BOARD_DEFAULT_POOLS}); 80 and 100 are quoted at ${usdText(boardQuoteUsd(80))} and ${usdText(boardQuoteUsd(100))}.` },
        limit: { type: "number", description: "DEXes returned, 1-50 (default 15)." },
      },
      required: ["network"],
    },
    output: {
      example: {
        source: "coingecko", fetchedAt: "2026-11-16T12:00:00.000Z", cached: false,
        network: "base", poolsRead: 60, scope: "the network's 60 largest pools by 24h volume",
        returned: 1, matched: 7, complete: false, truncated: true,
        totals: { volume24hUsd: 412000000, liquidityUsd: 286000000, turnover: 1.44, dexes: 7, topDexSharePct: 58.3, hhi: 4120 },
        dexes: [{ rank: 1, dex: "example-dex-base", name: "Example DEX (Base)", volumeSharePct: 58.3, liquiditySharePct: 41.2, turnover: 2.04, pools: 22, buyTradeSharePct: 50.6, topPool: { name: "WETH / USDC", address: "0x0000000000000000000000000000000000000001", shareOfDexVolumePct: 37.5 } }],
        flags: ["concentrated"],
      },
    },
  },
  handler: async (i = {}) => {
    const network = takeId(i.network, "network");
    const want = takeInt(i.pools, "pools", { min: POOLS_PER_PAGE, max: 100, dflt: BOARD_DEFAULT_POOLS });
    if (want % POOLS_PER_PAGE !== 0) throw bad('"pools" must be 20, 40, 60, 80 or 100');
    const limit = takeInt(i.limit, "limit", { min: 1, max: 50, dflt: 15 });
    if (unknownNetworks.has(network)) throw unknownNetwork(network);
    const readPage = (page) => cgGet(`/onchain/networks/${encodeURIComponent(network)}/pools`, { include: "dex", sort: "h24_volume_usd_desc", page }, SCREEN_TTL.dexBoard, reducePoolPage);
    // The first page is read alone: an unknown network, or one with no pools,
    // ends there, whatever `pools` asks for.
    let first;
    try { first = await readPage(1); } catch (err) {
      if (!err?.unknownId) throw err;
      unknownNetworks.add(network);
      throw unknownNetwork(network);
    }
    if (first.data.pools.length === 0) throw unknownNetwork(network);
    const later = Array.from({ length: want / POOLS_PER_PAGE - 1 }, (_, k) => k + 2);
    const reads = [first, ...(await Promise.all(later.map(readPage)))];
    return answerOnce(`dex-board|${network}|${want}|${limit}`, reads, () => {
    const names = Object.assign(Object.create(null), ...reads.map((r) => r.data.names));
    const seen = new Set();
    const pools = [];
    for (const r of reads) for (const [dex, address, name, vol, liq, buys, sells] of r.data.pools) {
      if (seen.has(address)) continue; // a pool can move between pages mid-read
      seen.add(address);
      pools.push({ dex, address, name, vol: vol ?? 0, liq: liq ?? 0, buys: buys ?? 0, sells: sells ?? 0 });
    }
    const by = new Map();
    for (const p of pools) { if (!by.has(p.dex)) by.set(p.dex, []); by.get(p.dex).push(p); }
    const volTotal = sum(pools.map((p) => p.vol)), liqTotal = sum(pools.map((p) => p.liq));
    const rows = [...by.entries()].map(([dex, ps]) => {
      const vol = sum(ps.map((p) => p.vol)), liq = sum(ps.map((p) => p.liq));
      const buys = sum(ps.map((p) => p.buys)), sells = sum(ps.map((p) => p.sells));
      const top = [...ps].sort((a, b) => b.vol - a.vol)[0];
      return {
        dex, name: names[dex] ?? dex, volumeSharePct: round(share(vol, volTotal), 2), liquiditySharePct: round(share(liq, liqTotal), 2),
        turnover: liq > 0 ? round(vol / liq, 2) : null, pools: ps.length, buyTradeSharePct: round(share(buys, buys + sells), 2),
        topPool: { name: top.name, address: top.address, shareOfDexVolumePct: round(share(top.vol, vol), 2) }, _vol: vol,
      };
    }).sort((a, b) => b._vol - a._vol);
    const topShare = share(rows[0]._vol, volTotal);
    const dexes = rows.slice(0, limit).map(({ _vol, ...r }, idx) => ({ rank: idx + 1, ...r }));
    return {
      network, poolsRead: pools.length, scope: `the network's ${pools.length} largest pools by 24h volume`,
      ...partialFields(rows.length, dexes.length),
      totals: { volume24hUsd: Math.round(volTotal), liquidityUsd: Math.round(liqTotal), turnover: liqTotal > 0 ? round(volTotal / liqTotal, 2) : null, dexes: rows.length, topDexSharePct: round(topShare, 2), hhi: volTotal > 0 ? Math.round(hhi(rows.map((r) => r._vol))) : null },
      dexes,
      // One DEX above half of the volume read.
      flags: topShare != null && topShare > 50 ? ["concentrated"] : [],
    };
    });
  },
};

// =============================================================================
// dex-pool-health
// =============================================================================
// Two documents: the pool, and its latest trades (300 at most). The pool is
// read first and alone: an address the upstream does not know ends there, at
// one read, and is remembered (with its network) so the same pair sent again
// makes none. The pool's own totals move over a rolling day and are kept
// longer than its trades.
const unknownPool = (network, pool) => bad(`No pool "${pool}" is tracked on network "${network}" - check the network id and the pool address`, 422);
const dexPoolHealth = {
  route: "GET /api/dex-pool-health",
  name: "DEX pool health",
  slug: "dex-pool-health", aliases: ["pool-liquidity", "dex-pool-liquidity", "pool-health"],
  category: "crypto",
  price: "$0.005",
  description:
    "Measured health of one DEX pool by network and pool address: liquidity, 24h turnover (volume over liquidity), buy share of trades and of traders, the size distribution of its latest trades (median, 90th percentile, largest, largest as a share of liquidity), how concentrated those trades are among wallets (top wallet's share, share from wallets trading three times or more), buy share of recent volume, a constant-product price-impact estimate for $1,000 and $10,000, the pool's age and locked-liquidity share. `tradesRead` is false, and the recent-trades block null, when the pool's trade list could not be read. Flags name measured conditions with fixed thresholds (thin liquidity, new pool, high churn, one-sided flow, wallet concentration, repeat-wallet flow, no recent trades); measurements only, with no score and no verdict. Networks use on-chain ids such as eth, base, solana. Deterministic code over market data; recent trades refreshed every 5 minutes, the pool's liquidity, 24h volume and 24h counts every 30 minutes.",
  tags: ["crypto", "dex", "pool", "liquidity", "pool-health", "price-impact", "repeat-wallets", "trades", "defi"],
  discovery: {
    input: { network: "eth", pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640" },
    inputSchema: {
      properties: {
        network: { type: "string", description: "On-chain network id: eth, base, solana, arbitrum, bsc, polygon_pos, ..." },
        pool: { type: "string", description: "Pool address on that network." },
      },
      required: ["network", "pool"],
    },
    output: {
      example: {
        source: "coingecko", fetchedAt: "2026-11-16T12:00:00.000Z", cached: false,
        network: "eth", pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", name: "WETH / USDC 0.05%", dex: "uniswap_v3", ageDays: 1783,
        liquidityUsd: 76692781, volume24hUsd: 104131045, turnover24h: 1.36, lockedLiquidityPct: 0,
        activity24h: { trades: 6098, buyTradeSharePct: 50.18, buyerSharePct: 48.08 },
        tradesRead: true, recentTrades: { count: 300, windowMinutes: 96, medianUsd: 1840.5, p90Usd: 41200, largestUsd: 512000, largestShareOfLiquidityPct: 0.67, buyVolumeSharePct: 47.3, uniqueWallets: 168, topWalletTradeSharePct: 6.33, repeatWalletTradeSharePct: 38.67, anomalous: 0 },
        priceImpactEstimate: { per1kUsdPct: 0.0026, per10kUsdPct: 0.0261, method: "constant-product approximation from total liquidity; a concentrated-liquidity pool trades tighter near the current price" },
        flags: [],
      },
    },
  },
  handler: async (i = {}) => {
    const network = takeId(i.network, "network");
    if (typeof i.pool !== "string" || !POOL_RE.test(i.pool.trim())) throw bad('"pool" must be a pool address (20-100 letters and digits)');
    const raw = i.pool.trim();
    const pool = /^0x/i.test(raw) ? raw.toLowerCase() : raw; // base58 addresses are case-sensitive
    const base = `/onchain/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(pool)}`;
    const poolKey = `${network}/${pool}`;
    if (unknownPools.has(poolKey)) throw unknownPool(network, pool);
    const reads = [];
    try { reads.push(await cgGet(base, {}, SCREEN_TTL.pool)); } catch (err) {
      if (!err?.unknownId) throw err;
      unknownPools.add(poolKey);
      throw unknownPool(network, pool);
    }
    // Only the pool read's own "not found" is a verdict on the pool. The
    // trades read answering "not found" for a pool that was just read is
    // answered from the pool's data with the trades absent (`tradesRead`
    // false); nothing is remembered, so the next call reads the trades again.
    let tradesRead = true;
    try { reads.push(await cgGet(`${base}/trades`, {}, SCREEN_TTL.poolTrades)); } catch (err) {
      if (!err?.unknownId) throw err;
      tradesRead = false;
    }
    const a = reads[0].data?.data?.attributes;
    if (!a || typeof a !== "object") throw bad("Market data upstream returned an unexpected shape", 502);
    return answerOnce(`pool|${poolKey}`, reads, () => {
    const liq = num(a.reserve_in_usd), vol = num(a.volume_usd?.h24);
    const tx = a.transactions?.h24 || {};
    const buys = num(tx.buys) ?? 0, sells = num(tx.sells) ?? 0, buyers = num(tx.buyers), sellers = num(tx.sellers);
    const created = Date.parse(a.pool_created_at);
    const ageDays = Number.isFinite(created) ? Math.max(0, Math.floor((Date.now() - created) / 86_400_000)) : null;
    const turnover = liq > 0 && vol != null ? vol / liq : null;

    const trades = (Array.isArray(reads[1]?.data?.data) ? reads[1].data.data : []).map((t) => t?.attributes).filter((t) => t && num(t.volume_in_usd) != null)
      .map((t) => ({ usd: num(t.volume_in_usd), kind: t.kind, wallet: typeof t.tx_from_address === "string" ? t.tx_from_address : null, at: Date.parse(t.block_timestamp), anomalous: t.is_anomalous === true }));
    let recent = null;
    if (trades.length) {
      const sizes = trades.map((t) => t.usd);
      const volRecent = sum(sizes);
      const perWallet = new Map();
      for (const t of trades) if (t.wallet) perWallet.set(t.wallet, (perWallet.get(t.wallet) || 0) + 1);
      const counts = [...perWallet.values()];
      const withWallet = sum(counts);
      const times = trades.map((t) => t.at).filter(Number.isFinite);
      const largest = Math.max(...sizes);
      recent = {
        count: trades.length,
        windowMinutes: times.length >= 2 ? Math.round((Math.max(...times) - Math.min(...times)) / 60_000) : null,
        medianUsd: round(median(sizes), 2), p90Usd: round(quantile(sizes, 0.9), 2), largestUsd: round(largest, 2),
        largestShareOfLiquidityPct: round(share(largest, liq), 4),
        buyVolumeSharePct: round(share(sum(trades.filter((t) => t.kind === "buy").map((t) => t.usd)), volRecent), 2),
        uniqueWallets: perWallet.size,
        topWalletTradeSharePct: withWallet ? round(share(Math.max(...counts), withWallet), 2) : null,
        repeatWalletTradeSharePct: withWallet ? round(share(sum(counts.filter((c) => c >= 3)), withWallet), 2) : null,
        anomalous: trades.filter((t) => t.anomalous).length,
      };
    }
    // Constant product with half the liquidity on each side: a buy of d moves
    // the price by about d / (liquidity / 2 + d).
    const impact = (d) => (liq > 0 ? round((d / (liq / 2 + d)) * 100, 4) : null);
    const buyTradeShare = share(buys, buys + sells);
    const flags = [];
    // Thresholds: under $50,000 of liquidity; under 7 days old; a day's volume
    // above 5x liquidity; over 80% of the day's trades on one side; one wallet
    // above 25% of the latest trades; wallets trading three times or more
    // above 60% of them (with at least 30 trades read); no trade in 24 hours.
    if (liq != null && liq < 50_000) flags.push("thin-liquidity");
    if (ageDays != null && ageDays < 7) flags.push("new-pool");
    if (turnover != null && turnover > 5) flags.push("high-churn");
    if (buys + sells >= 20 && (buyTradeShare > 80 || buyTradeShare < 20)) flags.push("one-sided-flow");
    if (recent && recent.count >= 30 && recent.topWalletTradeSharePct > 25) flags.push("wallet-concentration");
    if (recent && recent.count >= 30 && recent.repeatWalletTradeSharePct > 60) flags.push("repeat-wallet-flow");
    if (buys + sells === 0) flags.push("no-recent-trades");
    return {
      network, pool: a.address ?? pool, name: a.name ?? null, dex: reads[0].data.data.relationships?.dex?.data?.id ?? null, ageDays,
      liquidityUsd: liq == null ? null : Math.round(liq), volume24hUsd: vol == null ? null : Math.round(vol), turnover24h: round(turnover, 2),
      lockedLiquidityPct: round(num(a.locked_liquidity_percentage), 2),
      activity24h: { trades: buys + sells, buyTradeSharePct: round(buyTradeShare, 2), buyerSharePct: buyers != null && sellers != null ? round(share(buyers, buyers + sellers), 2) : null },
      tradesRead, recentTrades: recent,
      priceImpactEstimate: { per1kUsdPct: impact(1_000), per10kUsdPct: impact(10_000), method: "constant-product approximation from total liquidity; a concentrated-liquidity pool trades tighter near the current price" },
      flags,
    };
    });
  },
};

export const CRYPTO_SCREENS_TOOLS = [fundingScreener, depegWatch, exchangeSpread, defiScreener, chainBoard, dexVolumeBoard, dexPoolHealth];

/** The tools whose upstream endpoints answer only to a key: without one they
 *  answer 503 with nothing charged. */
export const KEY_ONLY_SCREEN_SLUGS = Object.freeze(["dex-volume-board", "dex-pool-health"]);

// Every tool here reads CoinGecko, whose terms require the credit (see
// COINGECKO_ATTRIBUTION in coingecko-rate.js), in the description and as the
// `credit` field of every answer.
for (const t of CRYPTO_SCREENS_TOOLS) creditAnswers(attribute(t, "coingecko"), COINGECKO_CREDIT);

export const __test = { memoCounts, answerMemoSize: () => answerMemo.size, median, quantile, stdev, weightedMean, hhi, reducePerps, reduceStables, reduceCategoryPage, reducePlatforms, reducePoolPage, FUNDING_MIN_OI_USD, PEG_CLASS_BAND, LIST_SLICE_CHARS };

// Every handler runs under one budget (src/upstream-deadline.js).
// The screens read several documents a call: they stop short of the reserve
// kept for the other CoinGecko tools (src/tools/coingecko-rate.js cgCeiling),
// so the others keep it whatever the screens are asked, and the screens can
// use the rest of the day while the others are quiet.
underBudgetAll(cgScopeAll(CRYPTO_SCREENS_TOOLS, { ceiling: "screens" }), PAYMENT_WINDOW_BUDGET_MS);
