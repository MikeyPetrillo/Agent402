// Finance-kit — live market data complement to EDGAR. EDGAR is the slow-moving
// authoritative truth (10-Ks, 13Fs, XBRL); this kit is the fast-moving public
// price/calendar surface agents reach for first when asked about a stock. Both
// kits accept ticker symbols, so an agent can answer "what is Apple's P/E vs.
// its 5-year revenue trend?" in two calls — one finance, one EDGAR.
//
// Upstreams (all keyless, all browser-discoverable JSON):
//
//   • Yahoo Finance /v8/finance/chart/SYMBOL — last price + OHLCV bars. One
//     endpoint covers both stock-quote (read meta) and stock-history (read
//     timestamp+indicators arrays). Stable since 2017, never required auth.
//   • Nasdaq /api/calendar/earnings?date=YYYY-MM-DD — earnings calendar for a
//     given date (all companies reporting that day). Their CDN rejects empty
//     User-Agents, so we send a browser-like one.
//
// Note: options-chain is intentionally NOT in this kit. Yahoo's
// /v7/finance/options endpoint moved behind a session-cookie + crumb gate
// in 2023 and now returns 401 to keyless callers. A future follow-up will
// either implement the crumb dance or wire a different upstream.
//
// safeFetch hardcodes the Agent402 UA (correct for our HTML scrapers) but
// some of these upstreams discriminate on UA, so this kit uses
// assertPublicUrl + native fetch with a per-host UA.
import { assertPublicUrl } from "./fetch-guard.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// A modern Chrome UA keeps Yahoo's chart endpoint and Nasdaq's calendar happy.
// Yahoo's API gateway is more relaxed; Nasdaq's CloudFront edge is the stricter
// of the two. Override via FINANCE_USER_AGENT for deployer-specific values.
function financeUserAgent() {
  return (
    (process.env.FINANCE_USER_AGENT || "").trim() ||
    "Mozilla/5.0 (compatible; Agent402/1.0; +https://agent402.tools)"
  );
}

// Yahoo accepts equities (AAPL), indices (^GSPC), FX (EURUSD=X), crypto
// (BTC-USD). Cap at 16 chars and restrict to a defensive whitelist — anything
// outside is almost certainly an agent input bug, and we should reject before
// burning a Yahoo round-trip.
function normalizeSymbol(raw) {
  if (typeof raw !== "string") throw bad('"symbol" is required (e.g. "AAPL", "^GSPC", "BTC-USD")');
  const s = raw.trim().toUpperCase();
  if (!s) throw bad('"symbol" is required');
  if (s.length > 16) throw bad('"symbol" too long');
  if (!/^[A-Z0-9^.\-=]+$/.test(s)) throw bad('"symbol" contains invalid characters');
  return s;
}

async function jsonGet(url, host) {
  const safeUrl = await assertPublicUrl(url);
  let res;
  try {
    res = await fetch(safeUrl, {
      headers: {
        "User-Agent": financeUserAgent(),
        Accept: "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw bad(`${host} request failed: ${e.message}`, 504);
  }
  const text = await res.text();
  if (!res.ok) {
    const s = res.status;
    if (s === 404) throw bad(`${host} returned 404 — unknown symbol or no data for the requested window`, 422);
    if (s === 401 || s === 403) throw bad(`${host} returned ${s} — upstream may require auth (try a different symbol or retry later)`, 502);
    if (s === 429) throw bad(`${host} rate-limited the request — retry shortly`, 503);
    if (s >= 500) throw bad(`${host} upstream HTTP ${s} — try again later`, 502);
    throw bad(`${host} HTTP ${s}: ${text.slice(0, 200)}`, 422);
  }
  try { return JSON.parse(text); }
  catch { throw bad(`${host} returned non-JSON response`, 502); }
}

// Yahoo accepts only this enumerated set for interval and range — anything
// else returns a 422-style error from the chart API. Pre-validate so a bad
// agent input gets a 400 with the allowed list, not an upstream surprise.
const VALID_INTERVALS = new Set(["1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "1d", "5d", "1wk", "1mo", "3mo"]);
const VALID_RANGES = new Set(["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"]);

async function fetchChart(symbol, params = {}) {
  const qs = new URLSearchParams(params);
  return jsonGet(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`, "Yahoo Finance");
}

export const FINANCE_TOOLS = [
  {
    route: "GET /api/stock-quote",
    name: "Stock quote",
    slug: "stock-quote",
    category: "data",
    price: "$0.005",
    description:
      "Live stock/index/FX/crypto quote: last price, day range, 52-week range, previous close, currency, exchange, and a relative change vs. previous close, as clean JSON. Backed by Yahoo Finance's public chart endpoint — keyless, no rate limits in practice. Symbols: equities (AAPL), indices (^GSPC), FX (EURUSD=X), crypto (BTC-USD).",
    tags: ["finance", "stocks", "quote", "market-data", "price"],
    discovery: {
      input: { symbol: "AAPL" },
      inputSchema: {
        properties: {
          symbol: { type: "string", description: "Ticker symbol — equity (AAPL), index (^GSPC), FX (EURUSD=X), crypto (BTC-USD)" },
        },
        required: ["symbol"],
      },
      output: {
        example: {
          symbol: "AAPL",
          name: "Apple Inc.",
          exchange: "NMS",
          currency: "USD",
          price: 232.45,
          previousClose: 230.10,
          changeAbs: 2.35,
          changePct: 1.0213,
          dayHigh: 233.50,
          dayLow: 229.20,
          fiftyTwoWeekHigh: 260.10,
          fiftyTwoWeekLow: 164.08,
          volume: 51234567,
          regularMarketTime: "2026-06-19T20:00:00Z",
        },
      },
    },
    handler: async (i) => {
      const symbol = normalizeSymbol(i.symbol);
      // 1d / 1m gives the smallest possible payload while still populating
      // meta with everything the quote tool needs. We never look at the bars.
      const data = await fetchChart(symbol, { interval: "1m", range: "1d" });
      const r = data?.chart?.result?.[0];
      const m = r?.meta;
      if (!m || typeof m.regularMarketPrice !== "number") {
        throw bad("Yahoo Finance returned no quote data for this symbol", 422);
      }
      const price = m.regularMarketPrice;
      const prev = m.chartPreviousClose ?? m.previousClose ?? null;
      const changeAbs = prev != null ? +(price - prev).toFixed(6) : null;
      const changePct = prev != null && prev !== 0 ? +(((price - prev) / prev) * 100).toFixed(4) : null;
      return {
        symbol: m.symbol ?? symbol,
        name: m.longName ?? m.shortName ?? null,
        exchange: m.exchangeName ?? null,
        currency: m.currency ?? null,
        price,
        previousClose: prev,
        changeAbs,
        changePct,
        dayHigh: m.regularMarketDayHigh ?? null,
        dayLow: m.regularMarketDayLow ?? null,
        fiftyTwoWeekHigh: m.fiftyTwoWeekHigh ?? null,
        fiftyTwoWeekLow: m.fiftyTwoWeekLow ?? null,
        volume: m.regularMarketVolume ?? null,
        regularMarketTime: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
      };
    },
  },

  {
    route: "GET /api/stock-history",
    name: "Stock historical bars",
    slug: "stock-history",
    category: "data",
    price: "$0.005",
    description:
      "Historical OHLCV bars for a symbol. Configurable interval (1m, 5m, 15m, 30m, 60m, 1d, 1wk, 1mo, 3mo) and range (1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max). Intraday intervals are limited by Yahoo to ~60 days of data. Returns a flat array of bars (time, open, high, low, close, volume) ready for charting or backtests.",
    tags: ["finance", "stocks", "history", "ohlcv", "backtest", "charting"],
    discovery: {
      input: { symbol: "AAPL", interval: "1d", range: "1mo" },
      inputSchema: {
        properties: {
          symbol: { type: "string", description: "Ticker symbol" },
          interval: { type: "string", description: "Bar size: 1m, 5m, 15m, 30m, 60m, 1d, 1wk, 1mo, 3mo (default 1d)" },
          range: { type: "string", description: "History window: 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max (default 1mo)" },
        },
        required: ["symbol"],
      },
      output: {
        example: {
          symbol: "AAPL",
          interval: "1d",
          range: "1mo",
          currency: "USD",
          timezone: "America/New_York",
          bars: [
            { time: "2026-05-20T13:30:00Z", open: 218.20, high: 220.30, low: 217.65, close: 219.80, volume: 48123456 },
          ],
          count: 1,
        },
      },
    },
    handler: async (i) => {
      const symbol = normalizeSymbol(i.symbol);
      const interval = typeof i.interval === "string" ? i.interval : "1d";
      const range = typeof i.range === "string" ? i.range : "1mo";
      if (!VALID_INTERVALS.has(interval)) throw bad(`"interval" must be one of: ${[...VALID_INTERVALS].join(", ")}`);
      if (!VALID_RANGES.has(range)) throw bad(`"range" must be one of: ${[...VALID_RANGES].join(", ")}`);
      const data = await fetchChart(symbol, { interval, range });
      const r = data?.chart?.result?.[0];
      if (!r) throw bad("Yahoo Finance returned no history for this symbol/range", 422);
      const ts = r.timestamp ?? [];
      const q = r.indicators?.quote?.[0] ?? {};
      const bars = ts.map((t, idx) => ({
        time: new Date(t * 1000).toISOString(),
        open: q.open?.[idx] ?? null,
        high: q.high?.[idx] ?? null,
        low: q.low?.[idx] ?? null,
        close: q.close?.[idx] ?? null,
        volume: q.volume?.[idx] ?? null,
      // Yahoo emits null gaps for non-trading minutes; drop them so charters
      // get a clean continuous series without having to filter client-side.
      })).filter((b) => b.close != null);
      return {
        symbol: r.meta?.symbol ?? symbol,
        interval,
        range,
        currency: r.meta?.currency ?? null,
        timezone: r.meta?.exchangeTimezoneName ?? null,
        bars,
        count: bars.length,
      };
    },
  },

  {
    route: "GET /api/earnings-calendar",
    name: "Earnings calendar",
    slug: "earnings-calendar",
    category: "data",
    price: "$0.005",
    description:
      "Earnings calendar for a given date — every company reporting that day with EPS estimate, EPS actual (if reported), and reporting time slot. Optional `symbol` filter narrows to one ticker. Defaults to today (UTC). Backed by Nasdaq's public calendar API.",
    tags: ["finance", "earnings", "calendar", "eps", "events"],
    discovery: {
      input: { date: "2026-06-22" },
      inputSchema: {
        properties: {
          date: { type: "string", description: "YYYY-MM-DD (default: today UTC)" },
          symbol: { type: "string", description: "Optional ticker filter" },
        },
      },
      output: {
        example: {
          date: "2026-06-22",
          count: 2,
          entries: [
            { symbol: "AAPL", name: "Apple Inc.", time: "amc", epsEstimate: 1.55, epsActual: null, marketCap: 3400000000000 },
            { symbol: "TSLA", name: "Tesla, Inc.", time: "bmo", epsEstimate: 0.72, epsActual: null, marketCap: 800000000000 },
          ],
        },
      },
    },
    handler: async (i) => {
      const date = typeof i.date === "string" && i.date ? i.date : new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('"date" must be YYYY-MM-DD');
      const data = await jsonGet(
        `https://api.nasdaq.com/api/calendar/earnings?date=${encodeURIComponent(date)}`,
        "Nasdaq",
      );
      // Nasdaq wraps every response in { data: { rows: [...] }, status: {...} }.
      // When there are no earnings on a date, `data` is null — surface as empty
      // rather than 422, since "no companies reporting" is a valid answer.
      const rows = data?.data?.rows ?? [];
      const filter = typeof i.symbol === "string" ? normalizeSymbol(i.symbol) : null;
      // Nasdaq quirks: marketCap is a $-prefixed comma-separated string like
      // "$3,400,000,000,000", and epsEstimate/epsActual can be "$1.55", "$(0.12)"
      // for negatives, or "N/A". parseNumeric handles all three.
      const parseNumeric = (s) => {
        if (s == null || s === "" || s === "N/A") return null;
        const cleaned = String(s).replace(/[$,]/g, "").replace(/^\((.+)\)$/, "-$1");
        const n = Number(cleaned);
        return Number.isFinite(n) ? n : null;
      };
      const entries = rows
        .filter((row) => !filter || row.symbol === filter)
        .map((row) => ({
          symbol: row.symbol ?? null,
          name: row.name ?? null,
          time: row.time ?? null,
          epsEstimate: parseNumeric(row.epsForecast),
          epsActual: parseNumeric(row.eps),
          marketCap: parseNumeric(row.marketCap),
        }));
      return { date, count: entries.length, entries };
    },
  },
];
