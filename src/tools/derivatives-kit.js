// Derivatives kit - crypto perpetuals and options market data from public,
// keyless APIs. Perp data (funding, open interest, mark/oracle, candles,
// order book, predicted funding) comes from the Hyperliquid info API; options
// data (index, DVOL, book summaries, tickers) from Deribit's public API; the
// onchain options protocol volume ranking from DefiLlama's free options
// overview (the perps/derivatives overview is behind their paid plan and is
// deliberately not used here).
//
// Every handler validates its inputs (400), bounds list sizes (limit <= 500),
// times out at 10s (504), maps upstream 5xx to 502 and 429 to 503, and never
// relays an upstream error body to the buyer. Output is compact JSON with
// `source` + `fetchedAt` on every response.
//
// All tools are wallet-only (every call egresses). Offline coverage:
// scripts/test-derivatives-kit.js (stubbed fetch).

const TIMEOUT_MS = 10_000;
const HL_INFO = "https://api.hyperliquid.xyz/info";
const DERIBIT = "https://www.deribit.com/api/v2/public";
const LLAMA_OPTIONS =
  "https://api.llama.fi/overview/options?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true";
const UA = "Mozilla/5.0 (compatible; Agent402/1.0; +https://agent402.tools)";

const MAX_LIMIT = 500;
const HOURS_PER_YEAR = 24 * 365;
const META_TTL_MS = 5 * 60_000;

// Hyperliquid candle intervals -> milliseconds (their documented set).
const INTERVALS = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000, "12h": 43_200_000,
  "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000, "1M": 2_592_000_000,
};

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round = (v, d = 6) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const nowIso = () => new Date().toISOString();

// --- input helpers ---------------------------------------------------------
function takeLimit(raw, dflt, max = MAX_LIMIT) {
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw bad(`"limit" must be an integer between 1 and ${max}`);
  return n;
}

function takeCoinInput(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw bad('"coin" is required (e.g. "BTC", "ETH", "SOL")');
  const s = raw.trim();
  if (s.length > 32) throw bad('"coin" too long');
  if (!/^[A-Za-z0-9:_\-.@]+$/.test(s)) throw bad('"coin" must be a perp ticker such as "BTC" or "kPEPE"');
  return s;
}

function takeCurrency(raw, dflt = "BTC") {
  if (raw == null || raw === "") return dflt;
  if (typeof raw !== "string") throw bad('"currency" must be a string (e.g. "BTC", "ETH")');
  const s = raw.trim().toUpperCase();
  if (!/^[A-Z]{2,8}$/.test(s)) throw bad('"currency" must be a 2-8 letter code such as "BTC" or "ETH"');
  return s;
}

const EXPIRY_RE = /^\d{1,2}[A-Z]{3}\d{2}$/;
function takeExpiry(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") throw bad('"expiry" must be a string like "26DEC26"');
  const s = raw.trim().toUpperCase();
  if (!EXPIRY_RE.test(s)) throw bad('"expiry" must look like "26DEC26" (DDMMMYY, as Deribit names it)');
  return s;
}

function takeInstrument(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw bad('"instrument" is required (e.g. "BTC-PERPETUAL" or "BTC-26DEC26-100000-C")');
  const s = raw.trim().toUpperCase();
  if (s.length > 40 || !/^[A-Z0-9_]{2,12}(-[A-Z0-9_.]{1,14}){1,4}$/.test(s)) {
    throw bad('"instrument" must be a Deribit instrument name such as "BTC-PERPETUAL" or "ETH-27MAR26-3000-P"');
  }
  return s;
}

// --- egress -----------------------------------------------------------------
// One transport wrapper for all three upstreams. Returns { status, text } so
// the per-source helpers can interpret non-2xx bodies (Deribit puts its error
// in a 400 JSON envelope, Hyperliquid answers 500 "null" for unknown coins).
async function rawFetch(url, { method = "GET", body, label }) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`[derivatives] ${label} unreachable: ${err?.name ?? err?.code ?? err?.message}`);
    throw bad(`${label} request timed out or was unreachable`, 504);
  }
  let text = "";
  try { text = await res.text(); } catch { text = ""; }
  if (res.status === 429) throw bad(`${label} rate limit reached upstream - retry shortly`, 503);
  return { status: res.status, text };
}

function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch { throw bad(`${label} returned a non-JSON response`, 502); }
}

// Hyperliquid info endpoint. Unknown coins come back as HTTP 500 "null"
// (candleSnapshot, fundingHistory) or HTTP 200 "null" (l2Book); both are
// "no such market" to a buyer, not an outage.
async function hlInfo(payload) {
  const { status, text } = await rawFetch(HL_INFO, { method: "POST", body: JSON.stringify(payload), label: "Hyperliquid" });
  const trimmed = text.trim();
  if (status >= 500) {
    if (trimmed === "null") throw bad("Hyperliquid has no market for that coin", 422);
    throw bad(`Hyperliquid upstream HTTP ${status} - try again later`, 502);
  }
  if (status >= 400) throw bad("Hyperliquid rejected the request (check coin / interval)", 422);
  const json = parseJson(trimmed, "Hyperliquid");
  if (json == null) throw bad("Hyperliquid has no market for that coin", 422);
  return json;
}

// Deribit public JSON-RPC over GET. Their 400 envelope carries
// {error:{code, data:{reason, param}}}; we map invalid params to 422 with a
// short allowlisted reason, never the raw body.
async function deribit(method, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) qs.set(k, String(v));
  const url = `${DERIBIT}/${method}${qs.toString() ? `?${qs}` : ""}`;
  const { status, text } = await rawFetch(url, { label: "Deribit" });
  if (status >= 500) throw bad(`Deribit upstream HTTP ${status} - try again later`, 502);
  const json = parseJson(text, "Deribit");
  if (json && json.error) {
    const reason = String(json.error?.data?.reason || "");
    const param = String(json.error?.data?.param || "");
    const safeReason = /^[a-z ]{1,40}$/.test(reason) ? reason : "invalid params";
    const safeParam = /^[a-z_]{1,30}$/.test(param) ? ` (${param})` : "";
    throw bad(`Deribit rejected the request: ${safeReason}${safeParam}`, 422);
  }
  if (status >= 400) throw bad("Deribit rejected the request", 422);
  if (json == null || !("result" in json)) throw bad("Deribit returned an unexpected response shape", 502);
  return json.result;
}

async function llamaOptionsOverview() {
  const { status, text } = await rawFetch(LLAMA_OPTIONS, { label: "DefiLlama" });
  if (status >= 500) throw bad(`DefiLlama upstream HTTP ${status} - try again later`, 502);
  if (status >= 400) throw bad("DefiLlama refused the request", 502);
  const json = parseJson(text, "DefiLlama");
  if (!json || !Array.isArray(json.protocols)) throw bad("DefiLlama returned an unexpected response shape", 502);
  return json;
}

// --- Hyperliquid helpers ----------------------------------------------------
// metaAndAssetCtxs -> [{universe:[{name, szDecimals, maxLeverage, isDelisted?}], ...}, [ctx...]]
// ctx: {funding, openInterest, prevDayPx, dayNtlVlm, premium, oraclePx, markPx, midPx, impactPxs}
async function perpMarkets() {
  const json = await hlInfo({ type: "metaAndAssetCtxs" });
  const universe = json?.[0]?.universe;
  const ctxs = json?.[1];
  if (!Array.isArray(universe) || !Array.isArray(ctxs)) throw bad("Hyperliquid returned an unexpected response shape", 502);
  const rows = [];
  for (let i = 0; i < universe.length; i++) {
    const u = universe[i];
    const c = ctxs[i];
    if (!u || !c || u.isDelisted) continue;
    const markPx = num(c.markPx);
    const oraclePx = num(c.oraclePx);
    const prevDayPx = num(c.prevDayPx);
    const fundingHourly = num(c.funding);
    const openInterest = num(c.openInterest);
    rows.push({
      coin: u.name,
      markPx,
      oraclePx,
      midPx: num(c.midPx),
      prevDayPx,
      change24hPct: markPx != null && prevDayPx ? round(((markPx - prevDayPx) / prevDayPx) * 100, 4) : null,
      fundingHourly,
      funding8h: fundingHourly != null ? round(fundingHourly * 8, 8) : null,
      fundingAprPct: fundingHourly != null ? round(fundingHourly * HOURS_PER_YEAR * 100, 4) : null,
      openInterest,
      openInterestUsd: openInterest != null && markPx != null ? round(openInterest * markPx, 2) : null,
      volume24hUsd: round(num(c.dayNtlVlm), 2),
      premiumPct: c.premium != null ? round(num(c.premium) * 100, 6) : null,
      maxLeverage: num(u.maxLeverage),
      szDecimals: num(u.szDecimals),
    });
  }
  return rows;
}

// Case-insensitive coin resolution against the live universe. Cached 5 min so
// the single-coin tools pay one validation call per window, not per request.
let metaCache = { at: 0, names: null };
async function resolveCoin(rawInput, rows = null) {
  const want = takeCoinInput(rawInput);
  if (rows) {
    const hit = rows.find((r) => r.coin === want) || rows.find((r) => r.coin.toLowerCase() === want.toLowerCase());
    if (!hit) throw bad(`Unknown perp market "${want}" - use a listed coin such as BTC, ETH, SOL`, 422);
    return hit.coin;
  }
  if (!metaCache.names || Date.now() - metaCache.at > META_TTL_MS) {
    const json = await hlInfo({ type: "meta" });
    const universe = json?.universe;
    if (!Array.isArray(universe)) throw bad("Hyperliquid returned an unexpected response shape", 502);
    metaCache = { at: Date.now(), names: universe.filter((u) => u && !u.isDelisted).map((u) => String(u.name)) };
  }
  const exact = metaCache.names.find((n) => n === want);
  if (exact) return exact;
  const ci = metaCache.names.find((n) => n.toLowerCase() === want.toLowerCase());
  if (ci) return ci;
  throw bad(`Unknown perp market "${want}" - use a listed coin such as BTC, ETH, SOL`, 422);
}

function pickRow(rows, coin) {
  return rows.find((r) => r.coin === coin) || null;
}

const fundingView = (hourly) => ({
  hourly: hourly == null ? null : round(hourly, 8),
  per8h: hourly == null ? null : round(hourly * 8, 8),
  aprPct: hourly == null ? null : round(hourly * HOURS_PER_YEAR * 100, 4),
});

// --- Deribit helpers ----------------------------------------------------------
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function expiryToTs(exp) {
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(exp || "");
  if (!m || !(m[2] in MONTHS)) return null;
  // Deribit options expire 08:00 UTC on the named day.
  return Date.UTC(2000 + Number(m[3]), MONTHS[m[2]], Number(m[1]), 8, 0, 0);
}
const OPTION_NAME_RE = /^([A-Z0-9_]+)-(\d{1,2}[A-Z]{3}\d{2})-(\d+(?:d\d+)?)-([CP])$/;
function parseOptionName(name) {
  const m = OPTION_NAME_RE.exec(String(name || ""));
  if (!m) return null;
  return { underlying: m[1], expiry: m[2], strike: Number(m[3].replace("d", ".")), type: m[4] === "C" ? "call" : "put" };
}

function optionRow(s) {
  const parsed = parseOptionName(s.instrument_name) || {};
  return {
    instrument: s.instrument_name,
    expiry: parsed.expiry ?? null,
    strike: parsed.strike ?? null,
    type: parsed.type ?? null,
    bid: num(s.bid_price),
    ask: num(s.ask_price),
    mark: num(s.mark_price),
    markIv: num(s.mark_iv),
    openInterest: num(s.open_interest),
    volume24h: num(s.volume),
    volume24hUsd: num(s.volume_usd),
    underlyingPrice: num(s.underlying_price),
  };
}

function summarizeOptions(list) {
  let callOi = 0, putOi = 0, oiUsd = 0, volUsd = 0, volBase = 0, count = 0;
  const expiries = new Map();
  for (const s of list) {
    const p = parseOptionName(s.instrument_name);
    if (!p) continue;
    count++;
    const oi = num(s.open_interest) || 0;
    const und = num(s.underlying_price) || num(s.estimated_delivery_price) || 0;
    if (p.type === "call") callOi += oi; else putOi += oi;
    oiUsd += oi * und;
    volUsd += num(s.volume_usd) || 0;
    volBase += num(s.volume) || 0;
    const e = expiries.get(p.expiry) || { expiry: p.expiry, ts: expiryToTs(p.expiry), openInterest: 0, volume24hUsd: 0, instruments: 0 };
    e.openInterest += oi;
    e.volume24hUsd += num(s.volume_usd) || 0;
    e.instruments++;
    expiries.set(p.expiry, e);
  }
  const byExpiry = [...expiries.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)).map((e) => ({
    expiry: e.expiry,
    expiresAt: e.ts ? new Date(e.ts).toISOString() : null,
    openInterest: round(e.openInterest, 4),
    volume24hUsd: round(e.volume24hUsd, 2),
    instruments: e.instruments,
  }));
  return {
    instruments: count,
    callOpenInterest: round(callOi, 4),
    putOpenInterest: round(putOi, 4),
    totalOpenInterest: round(callOi + putOi, 4),
    putCallOiRatio: callOi > 0 ? round(putOi / callOi, 4) : null,
    openInterestUsd: round(oiUsd, 2),
    volume24hBase: round(volBase, 4),
    volume24hUsd: round(volUsd, 2),
    expiries: byExpiry,
  };
}

function tickerView(t) {
  const stats = t?.stats || {};
  return {
    instrument: t.instrument_name,
    state: t.state ?? null,
    markPrice: num(t.mark_price),
    lastPrice: num(t.last_price),
    bestBid: num(t.best_bid_price),
    bestAsk: num(t.best_ask_price),
    bestBidAmount: num(t.best_bid_amount),
    bestAskAmount: num(t.best_ask_amount),
    indexPrice: num(t.index_price),
    underlyingPrice: num(t.underlying_price),
    underlyingIndex: t.underlying_index ?? null,
    openInterest: num(t.open_interest),
    markIv: num(t.mark_iv),
    bidIv: num(t.bid_iv),
    askIv: num(t.ask_iv),
    greeks: t.greeks && typeof t.greeks === "object"
      ? { delta: num(t.greeks.delta), gamma: num(t.greeks.gamma), vega: num(t.greeks.vega), theta: num(t.greeks.theta), rho: num(t.greeks.rho) }
      : null,
    currentFunding: num(t.current_funding),
    funding8h: num(t.funding_8h),
    settlementPrice: num(t.settlement_price),
    stats: {
      high24h: num(stats.high),
      low24h: num(stats.low),
      priceChange24hPct: num(stats.price_change),
      volume24h: num(stats.volume),
      volume24hUsd: num(stats.volume_usd),
    },
    timestamp: t.timestamp ? new Date(t.timestamp).toISOString() : null,
  };
}

// --- Tools ----------------------------------------------------------------
export const DERIVATIVES_TOOLS = [
  // ===========================================================================
  // perp-markets - every listed perp: funding, OI, mark/oracle, 24h volume.
  // ===========================================================================
  {
    route: "POST /api/perp-markets",
    name: "Perp markets snapshot",
    slug: "perp-markets",
    category: "crypto",
    price: "$0.003",
    description:
      "Snapshot of every listed perpetual on Hyperliquid in one call: mark and oracle price, 24h change, hourly funding (plus 8h and annualized), open interest in coins and USD, 24h notional volume, impact premium and max leverage. Sort by volume, openInterest, funding or change and cap the list with limit (max 500). Keyless public data.",
    tags: ["crypto", "derivatives", "perpetuals", "funding", "open-interest", "hyperliquid"],
    discovery: {
      bodyType: "json",
      input: { limit: 10 },
      inputSchema: {
        properties: {
          limit: { type: "number", description: "Rows to return (default 50, max 500)." },
          sort: { type: "string", description: "volume (default), openInterest, funding, change, or coin." },
          coins: { type: "string", description: "Optional comma-separated coin filter (e.g. \"BTC,ETH,SOL\")." },
        },
        required: [],
      },
      output: {
        example: {
          source: "hyperliquid",
          count: 2,
          totalMarkets: 230,
          sort: "volume",
          markets: [
            { coin: "BTC", markPx: 77267, oraclePx: 77236, change24hPct: 0.39, fundingHourly: 0.0000125, funding8h: 0.0001, fundingAprPct: 10.95, openInterest: 35935.67, openInterestUsd: 2776803000, volume24hUsd: 4679441788.67, premiumPct: 0.0388, maxLeverage: 40 },
          ],
          fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i = {}) => {
      const limit = takeLimit(i.limit, 50);
      const sort = i.sort == null || i.sort === "" ? "volume" : String(i.sort);
      const sorters = {
        volume: (a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0),
        openInterest: (a, b) => (b.openInterestUsd ?? 0) - (a.openInterestUsd ?? 0),
        funding: (a, b) => (b.fundingHourly ?? 0) - (a.fundingHourly ?? 0),
        change: (a, b) => (b.change24hPct ?? 0) - (a.change24hPct ?? 0),
        coin: (a, b) => a.coin.localeCompare(b.coin),
      };
      if (!sorters[sort]) throw bad(`"sort" must be one of ${Object.keys(sorters).join(", ")}`);
      let filter = null;
      if (i.coins != null && i.coins !== "") {
        if (typeof i.coins !== "string") throw bad('"coins" must be a comma-separated string');
        const items = i.coins.split(",").map((s) => s.trim()).filter(Boolean);
        if (items.length === 0 || items.length > 100) throw bad('"coins" must list between 1 and 100 entries');
        for (const c of items) takeCoinInput(c);
        filter = new Set(items.map((s) => s.toLowerCase()));
      }
      let rows = await perpMarkets();
      const totalMarkets = rows.length;
      if (filter) rows = rows.filter((r) => filter.has(r.coin.toLowerCase()));
      rows.sort(sorters[sort]);
      return {
        source: "hyperliquid",
        count: Math.min(rows.length, limit),
        totalMarkets,
        sort,
        markets: rows.slice(0, limit),
        fetchedAt: nowIso(),
      };
    },
  },

  // ===========================================================================
  // perp-funding - one coin: current funding + history + stats.
  // ===========================================================================
  {
    route: "POST /api/perp-funding",
    name: "Perp funding rate and history",
    slug: "perp-funding",
    category: "crypto",
    price: "$0.003",
    description:
      "Current funding rate for one perpetual (hourly, per 8h and annualized) plus the last N hourly funding prints with premium, and window statistics (average, min, max, share of positive hours). limit = hours of history (default 24, max 500). Hyperliquid public data, no key.",
    tags: ["crypto", "derivatives", "perpetuals", "funding", "funding-history", "hyperliquid"],
    discovery: {
      bodyType: "json",
      input: { coin: "BTC", limit: 24 },
      inputSchema: {
        properties: {
          coin: { type: "string", description: "Perp ticker, e.g. BTC, ETH, SOL (case-insensitive)." },
          limit: { type: "number", description: "Hourly history points to return (default 24, max 500)." },
        },
        required: ["coin"],
      },
      output: {
        example: {
          source: "hyperliquid",
          coin: "BTC",
          markPx: 77267,
          current: { hourly: 0.0000125, per8h: 0.0001, aprPct: 10.95, premiumPct: 0.0388 },
          history: [{ time: "2026-08-22T11:00:00.000Z", fundingRate: 0.0000125, premium: 0.00043 }],
          stats: { points: 24, avgHourly: 0.0000125, avgPer8h: 0.0001, avgAprPct: 10.95, minHourly: 0.0000125, maxHourly: 0.0000125, positiveSharePct: 100 },
          fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i = {}) => {
      const limit = takeLimit(i.limit, 24);
      takeCoinInput(i.coin);
      const rows = await perpMarkets();
      const coin = await resolveCoin(i.coin, rows);
      const row = pickRow(rows, coin);
      const startTime = Date.now() - (limit + 1) * 3_600_000;
      const hist = await hlInfo({ type: "fundingHistory", coin, startTime });
      const points = (Array.isArray(hist) ? hist : [])
        .map((h) => ({ time: h.time ? new Date(Number(h.time)).toISOString() : null, fundingRate: num(h.fundingRate), premium: num(h.premium) }))
        .filter((h) => h.fundingRate != null)
        .slice(-limit);
      const rates = points.map((p) => p.fundingRate);
      const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
      return {
        source: "hyperliquid",
        coin,
        markPx: row?.markPx ?? null,
        current: { ...fundingView(row?.fundingHourly ?? null), premiumPct: row?.premiumPct ?? null },
        history: points,
        stats: {
          points: rates.length,
          avgHourly: avg == null ? null : round(avg, 8),
          avgPer8h: avg == null ? null : round(avg * 8, 8),
          avgAprPct: avg == null ? null : round(avg * HOURS_PER_YEAR * 100, 4),
          minHourly: rates.length ? round(Math.min(...rates), 8) : null,
          maxHourly: rates.length ? round(Math.max(...rates), 8) : null,
          positiveSharePct: rates.length ? round((rates.filter((r) => r > 0).length / rates.length) * 100, 2) : null,
        },
        fetchedAt: nowIso(),
      };
    },
  },

  // ===========================================================================
  // perp-funding-screener - most positive / most negative funding.
  // ===========================================================================
  {
    route: "POST /api/perp-funding-screener",
    name: "Perp funding screener",
    slug: "perp-funding-screener",
    category: "crypto",
    price: "$0.003",
    description:
      "Rank perpetuals by funding rate: the N most positive (longs pay shorts) and N most negative (shorts pay longs) markets with hourly, 8h and annualized rates, open interest and 24h volume. minVolumeUsd filters out illiquid markets (default $1M). The carry and basis-trade screen in one call. Hyperliquid public data.",
    tags: ["crypto", "derivatives", "perpetuals", "funding", "screener", "carry"],
    discovery: {
      bodyType: "json",
      input: { limit: 5 },
      inputSchema: {
        properties: {
          limit: { type: "number", description: "Rows per side (default 10, max 100)." },
          minVolumeUsd: { type: "number", description: "Minimum 24h notional volume in USD (default 1000000, 0 disables)." },
        },
        required: [],
      },
      output: {
        example: {
          source: "hyperliquid",
          screened: 180,
          minVolumeUsd: 1000000,
          highest: [{ coin: "XYZ", fundingHourly: 0.0001, funding8h: 0.0008, fundingAprPct: 87.6, openInterestUsd: 12000000, volume24hUsd: 35000000, markPx: 1.23 }],
          lowest: [{ coin: "ABC", fundingHourly: -0.00005, funding8h: -0.0004, fundingAprPct: -43.8, openInterestUsd: 9000000, volume24hUsd: 21000000, markPx: 0.45 }],
          fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i = {}) => {
      const limit = takeLimit(i.limit, 10, 100);
      let minVol = 1_000_000;
      if (i.minVolumeUsd != null && i.minVolumeUsd !== "") {
        const n = Number(i.minVolumeUsd);
        if (!Number.isFinite(n) || n < 0) throw bad('"minVolumeUsd" must be a non-negative number');
        minVol = n;
      }
      const rows = (await perpMarkets()).filter((r) => r.fundingHourly != null && (r.volume24hUsd ?? 0) >= minVol);
      const slim = (r) => ({
        coin: r.coin,
        fundingHourly: r.fundingHourly,
        funding8h: r.funding8h,
        fundingAprPct: r.fundingAprPct,
        openInterestUsd: r.openInterestUsd,
        volume24hUsd: r.volume24hUsd,
        markPx: r.markPx,
      });
      const desc = [...rows].sort((a, b) => b.fundingHourly - a.fundingHourly);
      return {
        source: "hyperliquid",
        screened: rows.length,
        minVolumeUsd: minVol,
        highest: desc.slice(0, limit).map(slim),
        lowest: [...desc].reverse().slice(0, limit).map(slim),
        fetchedAt: nowIso(),
      };
    },
  },

  // ===========================================================================
  // perp-open-interest - one coin, or the top N by USD open interest.
  // ===========================================================================
  {
    route: "POST /api/perp-open-interest",
    name: "Perp open interest",
    slug: "perp-open-interest",
    category: "crypto",
    price: "$0.001",
    description:
      "Open interest for perpetuals in coins and USD notional. Pass coin for one market (with its share of total open interest) or omit it for the top N markets ranked by USD open interest plus the venue total. Hyperliquid public data, no key.",
    tags: ["crypto", "derivatives", "perpetuals", "open-interest", "hyperliquid"],
    discovery: {
      bodyType: "json",
      input: { limit: 10 },
      inputSchema: {
        properties: {
          coin: { type: "string", description: "Optional perp ticker for a single market (e.g. BTC)." },
          limit: { type: "number", description: "Rows when ranking (default 20, max 500)." },
        },
        required: [],
      },
      output: {
        example: {
          source: "hyperliquid",
          totalOpenInterestUsd: 9500000000,
          markets: [{ coin: "BTC", openInterest: 35935.67, openInterestUsd: 2776803000, shareOfTotalPct: 29.2, markPx: 77267, volume24hUsd: 4679441788.67 }],
          fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i = {}) => {
      const limit = takeLimit(i.limit, 20);
      const wantCoin = i.coin != null && i.coin !== "";
      if (wantCoin) takeCoinInput(i.coin);
      const rows = await perpMarkets();
      const total = rows.reduce((a, r) => a + (r.openInterestUsd ?? 0), 0);
      const view = (r) => ({
        coin: r.coin,
        openInterest: r.openInterest,
        openInterestUsd: r.openInterestUsd,
        shareOfTotalPct: total > 0 && r.openInterestUsd != null ? round((r.openInterestUsd / total) * 100, 4) : null,
        markPx: r.markPx,
        volume24hUsd: r.volume24hUsd,
      });
      if (wantCoin) {
        const coin = await resolveCoin(i.coin, rows);
        return { source: "hyperliquid", totalOpenInterestUsd: round(total, 2), market: view(pickRow(rows, coin)), fetchedAt: nowIso() };
      }
      const ranked = [...rows].sort((a, b) => (b.openInterestUsd ?? 0) - (a.openInterestUsd ?? 0)).slice(0, limit).map(view);
      return { source: "hyperliquid", totalOpenInterestUsd: round(total, 2), count: ranked.length, markets: ranked, fetchedAt: nowIso() };
    },
  },

  // ===========================================================================
  // perp-klines - OHLCV candles for one perp.
  // ===========================================================================
  {
    route: "POST /api/perp-klines",
    name: "Perp candles (OHLCV)",
    slug: "perp-klines",
    category: "crypto",
    price: "$0.001",
    description:
      "OHLCV candles for one perpetual at intervals from 1m to 1M (1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 3d 1w 1M), newest last, with a window summary (open, close, change %, high, low, volume). limit = number of candles (default 100, max 500). Hyperliquid public data, no key.",
    tags: ["crypto", "derivatives", "perpetuals", "candles", "ohlcv", "klines", "hyperliquid"],
    discovery: {
      bodyType: "json",
      input: { coin: "ETH", interval: "1h", limit: 24 },
      inputSchema: {
        properties: {
          coin: { type: "string", description: "Perp ticker, e.g. BTC, ETH, SOL." },
          interval: { type: "string", description: "Candle interval (default 1h): 1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 3d 1w 1M." },
          limit: { type: "number", description: "Candles to return (default 100, max 500)." },
        },
        required: ["coin"],
      },
      output: {
        example: {
          source: "hyperliquid",
          coin: "ETH",
          interval: "1h",
          count: 24,
          candles: [{ t: "2026-08-22T11:00:00.000Z", o: 2420.1, h: 2431.0, l: 2415.5, c: 2429.3, v: 1234.5, trades: 8800 }],
          summary: { open: 2380.3, close: 2429.3, changePct: 2.06, high: 2440.0, low: 2370.1, volume: 30000.2 },
          fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i = {}) => {
      const limit = takeLimit(i.limit, 100);
      const interval = i.interval == null || i.interval === "" ? "1h" : String(i.interval);
      if (!INTERVALS[interval]) throw bad(`"interval" must be one of ${Object.keys(INTERVALS).join(" ")}`);
      const coin = await resolveCoin(i.coin);
      const endTime = Date.now();
      const startTime = endTime - limit * INTERVALS[interval];
      const raw = await hlInfo({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } });
      if (!Array.isArray(raw)) throw bad("Hyperliquid returned an unexpected response shape", 502);
      const candles = raw.slice(-limit).map((c) => ({
        t: c.t ? new Date(Number(c.t)).toISOString() : null,
        o: num(c.o), h: num(c.h), l: num(c.l), c: num(c.c), v: num(c.v), trades: num(c.n),
      }));
      let summary = null;
      if (candles.length) {
        const open = candles[0].o, close = candles[candles.length - 1].c;
        summary = {
          open,
          close,
          changePct: open ? round(((close - open) / open) * 100, 4) : null,
          high: Math.max(...candles.map((c) => c.h ?? -Infinity)),
          low: Math.min(...candles.map((c) => c.l ?? Infinity)),
          volume: round(candles.reduce((a, c) => a + (c.v ?? 0), 0), 6),
        };
      }
      return { source: "hyperliquid", coin, interval, count: candles.length, candles, summary, fetchedAt: nowIso() };
    },
  },

  // ===========================================================================
  // perp-orderbook - L2 book with spread and imbalance.
  // ===========================================================================
  {
    route: "POST /api/perp-orderbook",
    name: "Perp order book",
    slug: "perp-orderbook",
    category: "crypto",
    price: "$0.002",
    description:
      "Level-2 order book for one perpetual: best bid/ask, mid, spread (absolute and bps), up to 20 levels per side with size and order count, cumulative depth in coins and USD on each side, and the bid/ask imbalance within the requested depth. Hyperliquid public data, no key.",
    tags: ["crypto", "derivatives", "perpetuals", "orderbook", "depth", "spread", "hyperliquid"],
    discovery: {
      bodyType: "json",
      input: { coin: "BTC", depth: 5 },
      inputSchema: {
        properties: {
          coin: { type: "string", description: "Perp ticker, e.g. BTC, ETH, SOL." },
          depth: { type: "number", description: "Levels per side to return (default 10, max 20)." },
        },
        required: ["coin"],
      },
      output: {
        example: {
          source: "hyperliquid",
          coin: "BTC",
          time: "2026-08-22T12:00:00.000Z",
          bestBid: 77279, bestAsk: 77280, mid: 77279.5, spread: 1, spreadBps: 0.129,
          bids: [{ px: 77279, sz: 3.13, n: 10 }],
          asks: [{ px: 77280, sz: 1.2, n: 4 }],
          bidDepth: { levels: 5, size: 6.1, notionalUsd: 471000 },
          askDepth: { levels: 5, size: 4.2, notionalUsd: 324000 },
          imbalance: 0.185,
          fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i = {}) => {
      const depth = takeLimit(i.depth, 10, 20);
      const coin = await resolveCoin(i.coin);
      const book = await hlInfo({ type: "l2Book", coin });
      const levels = book?.levels;
      if (!Array.isArray(levels) || levels.length < 2) throw bad("Hyperliquid returned an unexpected response shape", 502);
      const side = (arr) => (Array.isArray(arr) ? arr : []).slice(0, depth).map((l) => ({ px: num(l.px), sz: num(l.sz), n: num(l.n) }));
      const bids = side(levels[0]);
      const asks = side(levels[1]);
      const agg = (arr) => {
        const size = arr.reduce((a, l) => a + (l.sz ?? 0), 0);
        const notional = arr.reduce((a, l) => a + (l.sz ?? 0) * (l.px ?? 0), 0);
        return { levels: arr.length, size: round(size, 6), notionalUsd: round(notional, 2) };
      };
      const bidDepth = agg(bids), askDepth = agg(asks);
      const bestBid = bids[0]?.px ?? null, bestAsk = asks[0]?.px ?? null;
      const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
      const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
      const denom = (bidDepth.notionalUsd ?? 0) + (askDepth.notionalUsd ?? 0);
      return {
        source: "hyperliquid",
        coin,
        time: book.time ? new Date(Number(book.time)).toISOString() : null,
        bestBid, bestAsk, mid: round(mid, 8), spread: round(spread, 8),
        spreadBps: mid ? round((spread / mid) * 10_000, 4) : null,
        bids, asks, bidDepth, askDepth,
        imbalance: denom > 0 ? round(((bidDepth.notionalUsd ?? 0) - (askDepth.notionalUsd ?? 0)) / denom, 4) : null,
        fetchedAt: nowIso(),
      };
    },
  },

  // ===========================================================================
  // perp-basis - mark vs oracle premium + predicted funding across venues.
  // ===========================================================================
  {
    route: "POST /api/perp-basis",
    name: "Perp premium and predicted funding",
    slug: "perp-basis",
    category: "crypto",
    price: "$0.003",
    description:
      "Basis view for one perpetual: mark, oracle and mid price, mark-vs-oracle premium in percent and bps, the impact premium the venue uses for funding, the current hourly funding, and the predicted next funding rate per venue (rate, interval, next funding time, 8h-normalized and annualized) as published by Hyperliquid's predictedFundings feed. No key.",
    tags: ["crypto", "derivatives", "perpetuals", "basis", "premium", "predicted-funding", "hyperliquid"],
    discovery: {
      bodyType: "json",
      input: { coin: "BTC" },
      inputSchema: {
        properties: {
          coin: { type: "string", description: "Perp ticker, e.g. BTC, ETH, SOL." },
        },
        required: ["coin"],
      },
      output: {
        example: {
          source: "hyperliquid",
          coin: "BTC",
          markPx: 77267, oraclePx: 77236, midPx: 77266.5,
          markOraclePremiumPct: 0.0401, markOraclePremiumBps: 4.01,
          impactPremiumPct: 0.0388,
          funding: { hourly: 0.0000125, per8h: 0.0001, aprPct: 10.95 },
          predictedFunding: [{ venue: "HlPerp", fundingRate: 0.0000125, fundingIntervalHours: 1, nextFundingTime: "2026-08-22T13:00:00.000Z", per8h: 0.0001, aprPct: 10.95 }],
          fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i = {}) => {
      takeCoinInput(i.coin);
      const rows = await perpMarkets();
      const coin = await resolveCoin(i.coin, rows);
      const row = pickRow(rows, coin);
      const predicted = await hlInfo({ type: "predictedFundings" });
      const entry = (Array.isArray(predicted) ? predicted : []).find((e) => Array.isArray(e) && e[0] === coin);
      const venues = (entry && Array.isArray(entry[1]) ? entry[1] : []).map(([venue, v]) => {
        const rate = num(v?.fundingRate);
        const hours = num(v?.fundingIntervalHours) || 8;
        const hourly = rate == null ? null : rate / hours;
        return {
          venue: String(venue),
          fundingRate: rate,
          fundingIntervalHours: hours,
          nextFundingTime: v?.nextFundingTime ? new Date(Number(v.nextFundingTime)).toISOString() : null,
          per8h: hourly == null ? null : round(hourly * 8, 8),
          aprPct: hourly == null ? null : round(hourly * HOURS_PER_YEAR * 100, 4),
        };
      });
      const prem = row.markPx != null && row.oraclePx ? (row.markPx - row.oraclePx) / row.oraclePx : null;
      return {
        source: "hyperliquid",
        coin,
        markPx: row.markPx,
        oraclePx: row.oraclePx,
        midPx: row.midPx,
        markOraclePremiumPct: prem == null ? null : round(prem * 100, 6),
        markOraclePremiumBps: prem == null ? null : round(prem * 10_000, 4),
        impactPremiumPct: row.premiumPct,
        funding: fundingView(row.fundingHourly),
        predictedFunding: venues,
        fetchedAt: nowIso(),
      };
    },
  },

  // ===========================================================================
  // options-summary - Deribit: index, DVOL, options OI/volume, perpetual.
  // ===========================================================================
  {
    route: "POST /api/options-summary",
    name: "Options market summary",
    slug: "options-summary",
    category: "crypto",
    price: "$0.005",
    description:
      "One-call options market summary for a currency on Deribit: index price, the DVOL implied-volatility index, call and put open interest with put/call ratio, total open interest in coins and USD, 24h volume, per-expiry open interest and volume, the top instruments by open interest, and the perpetual's mark, funding and open interest. BTC and ETH carry the deep books; other currencies return whatever Deribit lists. Keyless public data.",
    tags: ["crypto", "derivatives", "options", "implied-volatility", "dvol", "open-interest", "deribit"],
    discovery: {
      bodyType: "json",
      input: { currency: "BTC" },
      inputSchema: {
        properties: {
          currency: { type: "string", description: "BTC (default), ETH, or another Deribit currency code." },
        },
        required: [],
      },
      output: {
        example: {
          source: "deribit",
          currency: "BTC",
          indexPrice: 77232.62,
          dvol: { value: 41.74, time: "2026-08-22T11:00:00.000Z" },
          options: {
            instruments: 900, callOpenInterest: 150000, putOpenInterest: 110000, putCallOiRatio: 0.733, totalOpenInterest: 260000,
            openInterestUsd: 20000000000, volume24hBase: 12000, volume24hUsd: 900000000,
            expiries: [{ expiry: "26AUG26", expiresAt: "2026-08-26T08:00:00.000Z", openInterest: 12000, volume24hUsd: 5000000, instruments: 60 }],
            topByOpenInterest: [{ instrument: "BTC-25SEP26-120000-P", expiry: "25SEP26", strike: 120000, type: "put", openInterest: 174.5, markIv: 62.03, volume24hUsd: 0 }],
          },
          perpetual: { instrument: "BTC-PERPETUAL", markPrice: 77263.43, funding8h: 0.000195, currentFunding: 0.000149, openInterest: 903679080, volume24hUsd: 664803850 },
          fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i = {}) => {
      const currency = takeCurrency(i.currency);
      const now = Date.now();
      const [indexRes, bookRes, dvolRes, perpRes] = await Promise.allSettled([
        deribit("get_index_price", { index_name: `${currency.toLowerCase()}_usd` }),
        deribit("get_book_summary_by_currency", { currency, kind: "option" }),
        deribit("get_volatility_index_data", { currency, start_timestamp: now - 3 * 3_600_000, end_timestamp: now, resolution: 3600 }),
        deribit("ticker", { instrument_name: `${currency}-PERPETUAL` }),
      ]);
      // The option book is the load-bearing call; the other three degrade to null.
      if (bookRes.status === "rejected") throw bookRes.reason;
      const book = Array.isArray(bookRes.value) ? bookRes.value : [];
      const summary = summarizeOptions(book);
      const top = book
        .filter((s) => parseOptionName(s.instrument_name))
        .sort((a, b) => (num(b.open_interest) || 0) - (num(a.open_interest) || 0))
        .slice(0, 10)
        .map((s) => { const r = optionRow(s); return { instrument: r.instrument, expiry: r.expiry, strike: r.strike, type: r.type, openInterest: r.openInterest, markIv: r.markIv, volume24hUsd: r.volume24hUsd }; });
      let dvol = null;
      if (dvolRes.status === "fulfilled" && Array.isArray(dvolRes.value?.data) && dvolRes.value.data.length) {
        const last = dvolRes.value.data[dvolRes.value.data.length - 1];
        dvol = { value: num(last?.[4]), time: last?.[0] ? new Date(Number(last[0])).toISOString() : null };
      }
      let perpetual = null;
      if (perpRes.status === "fulfilled" && perpRes.value) {
        const t = perpRes.value;
        perpetual = {
          instrument: t.instrument_name,
          markPrice: num(t.mark_price),
          funding8h: num(t.funding_8h),
          currentFunding: num(t.current_funding),
          openInterest: num(t.open_interest),
          volume24hUsd: num(t.stats?.volume_usd),
        };
      }
      return {
        source: "deribit",
        currency,
        indexPrice: indexRes.status === "fulfilled" ? num(indexRes.value?.index_price) : null,
        dvol,
        options: { ...summary, topByOpenInterest: top },
        perpetual,
        fetchedAt: nowIso(),
      };
    },
  },

  // ===========================================================================
  // options-chain - strikes for one expiry (nearest by default).
  // ===========================================================================
  {
    route: "POST /api/crypto-options-chain",
    name: "Options chain by expiry",
    slug: "crypto-options-chain",
    category: "crypto",
    price: "$0.004",
    description:
      "Options chain for a currency and expiry on Deribit, sorted by strike: instrument, strike, call/put, bid, ask, mark, mark IV, open interest, 24h volume and underlying price for each listed option, plus the list of available expiries. Omit expiry to get the nearest one; pass type call or put to filter one side. limit caps rows (default 100, max 500). Keyless public data.",
    tags: ["crypto", "crypto-options", "derivatives", "options", "options-chain", "strikes", "implied-volatility", "bitcoin", "ethereum", "deribit"],
    discovery: {
      bodyType: "json",
      input: { currency: "BTC", limit: 20 },
      inputSchema: {
        properties: {
          currency: { type: "string", description: "BTC (default) or ETH." },
          expiry: { type: "string", description: "Deribit expiry label like 26DEC26; omit for the nearest expiry." },
          type: { type: "string", description: "Optional: call or put." },
          limit: { type: "number", description: "Rows to return (default 100, max 500)." },
        },
        required: [],
      },
      output: {
        example: {
          source: "deribit",
          currency: "BTC",
          expiry: "26AUG26",
          expiresAt: "2026-08-26T08:00:00.000Z",
          underlyingPrice: 77317.9,
          expiries: ["26AUG26", "27AUG26", "25SEP26"],
          count: 2,
          options: [{ instrument: "BTC-26AUG26-80000-C", expiry: "26AUG26", strike: 80000, type: "call", bid: 0.0065, ask: 0.008, mark: 0.0073, markIv: 48.03, openInterest: 12.5, volume24h: 3.1, volume24hUsd: 1800, underlyingPrice: 77317.9 }],
          fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i = {}) => {
      const currency = takeCurrency(i.currency);
      const wantExpiry = takeExpiry(i.expiry);
      const limit = takeLimit(i.limit, 100);
      let type = null;
      if (i.type != null && i.type !== "") {
        const t = String(i.type).toLowerCase();
        if (t !== "call" && t !== "put") throw bad('"type" must be "call" or "put"');
        type = t;
      }
      const book = await deribit("get_book_summary_by_currency", { currency, kind: "option" });
      const rows = (Array.isArray(book) ? book : []).map(optionRow).filter((r) => r.expiry);
      const expiries = [...new Set(rows.map((r) => r.expiry))].sort((a, b) => (expiryToTs(a) ?? 0) - (expiryToTs(b) ?? 0));
      if (expiries.length === 0) throw bad(`Deribit lists no options for "${currency}"`, 422);
      const expiry = wantExpiry ?? expiries[0];
      if (!expiries.includes(expiry)) throw bad(`No ${currency} options expire ${expiry} - available: ${expiries.slice(0, 12).join(", ")}`, 422);
      let chain = rows.filter((r) => r.expiry === expiry);
      if (type) chain = chain.filter((r) => r.type === type);
      chain.sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0) || a.type.localeCompare(b.type));
      const ts = expiryToTs(expiry);
      return {
        source: "deribit",
        currency,
        expiry,
        expiresAt: ts ? new Date(ts).toISOString() : null,
        underlyingPrice: chain.find((r) => r.underlyingPrice != null)?.underlyingPrice ?? null,
        expiries,
        count: Math.min(chain.length, limit),
        options: chain.slice(0, limit),
        fetchedAt: nowIso(),
      };
    },
  },

  // ===========================================================================
  // options-ticker - one Deribit instrument (option, future, or perpetual).
  // ===========================================================================
  {
    route: "POST /api/options-ticker",
    name: "Options instrument ticker",
    slug: "options-ticker",
    category: "crypto",
    price: "$0.002",
    description:
      "Live ticker for one Deribit instrument: mark, last, best bid/ask with sizes, index and underlying price, open interest, mark/bid/ask IV and greeks (delta, gamma, vega, theta, rho) for options, funding for perpetuals, and 24h stats. Pass instrument (e.g. BTC-26DEC26-100000-C or BTC-PERPETUAL), or pass currency (+ optional type call/put) to get the at-the-money option of the nearest expiry. Keyless public data.",
    tags: ["crypto", "derivatives", "options", "ticker", "greeks", "implied-volatility", "deribit"],
    discovery: {
      bodyType: "json",
      input: { currency: "BTC" },
      inputSchema: {
        properties: {
          instrument: { type: "string", description: "Deribit instrument name, e.g. BTC-PERPETUAL or ETH-27MAR26-3000-P." },
          currency: { type: "string", description: "Alternative to instrument: BTC or ETH picks the nearest-expiry at-the-money option." },
          type: { type: "string", description: "With currency: call (default) or put." },
        },
        required: [],
      },
      output: {
        example: {
          source: "deribit",
          resolvedFrom: "nearest-expiry-atm",
          ticker: {
            instrument: "BTC-26AUG26-77000-C", state: "open", markPrice: 0.0121, lastPrice: 0.012, bestBid: 0.0115, bestAsk: 0.0125,
            indexPrice: 77242.3, underlyingPrice: 77317.9, underlyingIndex: "BTC-26AUG26", openInterest: 85.2,
            markIv: 47.5, bidIv: 46.1, askIv: 48.9,
            greeks: { delta: 0.52, gamma: 0.00012, vega: 30.1, theta: -190.2, rho: 2.1 },
            stats: { high24h: 0.013, low24h: 0.011, priceChange24hPct: -4.2, volume24h: 120.5, volume24hUsd: 112000 },
            timestamp: "2026-08-22T12:00:00.000Z",
          },
          fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i = {}) => {
      let instrument, resolvedFrom = "instrument";
      if (i.instrument != null && i.instrument !== "") {
        instrument = takeInstrument(i.instrument);
      } else if (i.currency != null && i.currency !== "") {
        const currency = takeCurrency(i.currency);
        let type = "call";
        if (i.type != null && i.type !== "") {
          type = String(i.type).toLowerCase();
          if (type !== "call" && type !== "put") throw bad('"type" must be "call" or "put"');
        }
        const book = await deribit("get_book_summary_by_currency", { currency, kind: "option" });
        const rows = (Array.isArray(book) ? book : []).map(optionRow).filter((r) => r.expiry && r.type === type);
        if (!rows.length) throw bad(`Deribit lists no ${type} options for "${currency}"`, 422);
        const expiries = [...new Set(rows.map((r) => r.expiry))].sort((a, b) => (expiryToTs(a) ?? 0) - (expiryToTs(b) ?? 0));
        const chain = rows.filter((r) => r.expiry === expiries[0]);
        const und = chain.find((r) => r.underlyingPrice != null)?.underlyingPrice ?? 0;
        chain.sort((a, b) => Math.abs((a.strike ?? 0) - und) - Math.abs((b.strike ?? 0) - und));
        instrument = chain[0].instrument;
        resolvedFrom = "nearest-expiry-atm";
      } else {
        throw bad('Pass "instrument" (e.g. BTC-PERPETUAL) or "currency" (e.g. BTC)');
      }
      const t = await deribit("ticker", { instrument_name: instrument });
      if (!t || typeof t !== "object") throw bad("Deribit returned an unexpected response shape", 502);
      return { source: "deribit", resolvedFrom, ticker: tickerView(t), fetchedAt: nowIso() };
    },
  },

  // ===========================================================================
  // options-volume - DefiLlama onchain options protocols ranked by volume.
  // ===========================================================================
  {
    route: "POST /api/options-volume",
    name: "Onchain options volume by protocol",
    slug: "options-volume",
    category: "crypto",
    price: "$0.002",
    description:
      "Onchain options protocols ranked by 24h notional volume from DefiLlama's options overview: per-protocol 24h, 7d and 30d volume with 1d/7d change and chains, plus sector totals and the list of chains with options volume. limit caps rows (default 25, max 100). Keyless public data.",
    tags: ["crypto", "derivatives", "options", "volume", "defi", "defillama", "ranking"],
    discovery: {
      bodyType: "json",
      input: { limit: 10 },
      inputSchema: {
        properties: {
          limit: { type: "number", description: "Protocols to return (default 25, max 100)." },
          chain: { type: "string", description: "Optional chain name filter, e.g. Arbitrum (case-insensitive)." },
        },
        required: [],
      },
      output: {
        example: {
          source: "defillama-options",
          totals: { volume24hUsd: 5093016, volume7dUsd: 11148265.31, volume30dUsd: 30971390.66, change1dPct: 10.03, change7dPct: 4.1 },
          chains: ["Derive Chain", "Hyperliquid L1", "Base"],
          count: 1,
          protocols: [{ name: "Derive", slug: "derive", category: "Options", chains: ["Derive Chain"], volume24hUsd: 3000000, volume7dUsd: 7000000, volume30dUsd: 20000000, change1dPct: 12.5, change7dPct: 3.2 }],
          fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i = {}) => {
      const limit = takeLimit(i.limit, 25, 100);
      let chain = null;
      if (i.chain != null && i.chain !== "") {
        if (typeof i.chain !== "string" || i.chain.length > 40 || !/^[A-Za-z0-9 .\-]+$/.test(i.chain)) throw bad('"chain" must be a chain name such as "Arbitrum"');
        chain = i.chain.trim().toLowerCase();
      }
      const json = await llamaOptionsOverview();
      let protocols = json.protocols.map((p) => ({
        name: p.displayName || p.name || null,
        slug: p.module || p.slug || null,
        category: p.category || null,
        chains: Array.isArray(p.chains) ? p.chains : [],
        volume24hUsd: num(p.total24h),
        volume7dUsd: num(p.total7d),
        volume30dUsd: num(p.total30d),
        change1dPct: num(p.change_1d),
        change7dPct: num(p.change_7d),
      }));
      if (chain) protocols = protocols.filter((p) => p.chains.some((c) => String(c).toLowerCase() === chain));
      protocols.sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
      return {
        source: "defillama-options",
        totals: {
          volume24hUsd: num(json.total24h),
          volume7dUsd: num(json.total7d),
          volume30dUsd: num(json.total30d),
          change1dPct: num(json.change_1d),
          change7dPct: num(json.change_7d),
        },
        chains: Array.isArray(json.allChains) ? json.allChains : [],
        count: Math.min(protocols.length, limit),
        protocols: protocols.slice(0, limit),
        fetchedAt: nowIso(),
      };
    },
  },
];

export const __test = {
  resetMetaCache: () => { metaCache = { at: 0, names: null }; },
  parseOptionName,
  expiryToTs,
  summarizeOptions,
  INTERVALS,
  HL_INFO,
  DERIBIT,
  LLAMA_OPTIONS,
};
