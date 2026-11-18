// Finance tools: US equity end-of-day quote and daily bars, read through the
// stock-provider seam (src/tools/stock-provider.js). The provider is chosen by
// STOCK_DATA_PROVIDER and is active only with its own key; with none active
// these tools are not listed (FINANCE_TOOLS_ENABLED is empty) and the routes
// answer 503 not-offered. Every answer names the source it came from and its
// coverage (the adapter's provenance fields).
import { selectedStockAdapter, stockDataEnabled, quote as providerQuote, dailyBars as providerDailyBars } from "./stock-provider.js";
import { computeIndicators } from "./crypto-signals-kit.js";

// The selected adapter's own copy and example fields (the tools are listed
// only once its key is present too); with "off" they carry no provider text.
const ADAPTER = await selectedStockAdapter();
const DESCRIBE = ADAPTER?.describe || { coverageCopy: "", barsCopy: "", exampleProvenance: {} };
const COVERAGE_COPY = DESCRIBE.coverageCopy;
const EXAMPLE_PROVENANCE = DESCRIBE.exampleProvenance;
const sentence = (t) => (t ? ` ${t}` : "");

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Input validation runs before anything touches the network or the API key,
// so a malformed ticker is always a 400 naming the cause and never a 503
// about our own configuration.
function assertSymbol(raw) {
  const symbol = String(raw || "").trim().toUpperCase();
  if (!symbol) throw bad('"symbol" is required, e.g. AAPL.');
  if (!/^[A-Z][A-Z.\-]{0,9}$/.test(symbol)) {
    throw bad(`"${symbol}" is not a US equity ticker. This tool covers US equities only - indices, FX and crypto are not available.`);
  }
  return symbol;
}

const MAX_DAYS = 250;
// Indicators stock-history can compute from its daily bars. VWAP is left out:
// on the fallback dataset the bars carry three-venue volume, not the
// consolidated tape, and an indicator must not change meaning by dataset.
const STOCK_INDICATOR_IDS = ["rsi", "macd", "ema", "sma", "bollinger", "atr"];
function stockIndicatorSet(raw) {
  if (raw === undefined || raw === null || raw === "" || raw === false || raw === "false") return null;
  if (raw === true || raw === "true" || raw === "all") return new Set(STOCK_INDICATOR_IDS);
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const ids = list.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const unknown = ids.filter((x) => !STOCK_INDICATOR_IDS.includes(x));
  if (!ids.length || unknown.length) throw bad(`"indicators" must be true or a list of: ${STOCK_INDICATOR_IDS.join(", ")}${unknown.length ? ` (unknown: ${unknown.join(", ")})` : ""}.`);
  return new Set(ids);
}
// The spend bound a history read is held to (an adapter that prices its
// queries refuses one wider than this).
const MAX_QUERY_USD = 0.0035;

export const FINANCE_TOOLS = [
  {
    route: "GET /api/stock-quote",
    name: "Stock quote",
    slug: "stock-quote",
    // Repeat share is measured on the symbol (hashed in telemetry, never the value).
    telemetryKey: (i) => String(i?.symbol || "").trim().toUpperCase() || null,
    category: "data",
    price: "$0.001",
    description:
      `End-of-day US equity quote: last close, day range, consolidated volume, previous close and the change between them. US equities only; indices, FX and crypto are not covered (crypto-price serves those).${sentence(COVERAGE_COPY)} No 52-week range and no intraday print: for a date range call stock-history. Each answer names its dataset and coverage, and says whether its bars came from this session's cache (cached, fetchedAt).`,
    tags: ["finance", "stocks", "quote", "market-data", "price"],
    discovery: {
      input: { symbol: "AAPL" },
      inputSchema: {
        properties: {
          symbol: { type: "string", description: "US equity ticker, e.g. AAPL. Indices, FX and crypto are not covered." },
        },
        required: ["symbol"],
      },
      output: {
        example: {
          symbol: "AAPL",
          currency: "USD",
          price: 341.27,
          previousClose: 340.97,
          changeAbs: 0.3,
          changePct: 0.088,
          dayHigh: 348.1499,
          dayLow: 340.74,
          volume: 38983839,
          venueVolume: 38983839,
          asOf: "2026-10-13",
          ...EXAMPLE_PROVENANCE,
          note: `End-of-day close, not a live intraday quote, and no 52-week range (use stock-history for a range).${sentence(EXAMPLE_PROVENANCE.note)}`,
          cached: true,
          fetchedAt: "2026-10-14T13:05:12.000Z",
          rangeCheckedAt: "2026-10-14T13:00:03.000Z",
        },
      },
    },
    handler: async (i, ctx) => {
      const symbol = assertSymbol(i.symbol);
      // The adapter serves the newest session it holds; a symbol already read
      // this session answers from its cache. `cached` and `fetchedAt` are the
      // bars' own read time, `rangeCheckedAt` when the session boundary was
      // last confirmed. A read the upstream does not answer may be served
      // from the last good read (labeled stale), except for the self-check,
      // which must see it and is not a buyer's demand.
      const read = await providerQuote(symbol, { demand: !ctx?.selfcheck, lastGoodOk: !ctx?.selfcheck });
      const bars = read.bars;
      const last = bars.at(-1), prev = bars.at(-2) || null;
      const where = read.provenance;
      return {
        symbol,
        currency: "USD",
        price: last.close,
        previousClose: prev ? prev.close : null,
        changeAbs: prev ? Number((last.close - prev.close).toFixed(4)) : null,
        changePct: prev ? Number((((last.close - prev.close) / prev.close) * 100).toFixed(4)) : null,
        dayHigh: last.high,
        dayLow: last.low,
        // The market total on a consolidated source; null on a partial one,
        // whose share is only ever venueVolume.
        volume: last.volume ?? null,
        // Volume across the venues named in `venues`.
        venueVolume: last.venueVolume,
        asOf: last.day,
        ...where,
        cached: read.cached,
        fetchedAt: read.fetchedAt,
        rangeCheckedAt: read.rangeCheckedAt,
        // The session boundary's refresh failed: the answer is bounded by the
        // last confirmed end.
        ...(read.rangeStale ? { rangeStale: true } : {}),
        // The upstream did not answer this read: the bars are the newest this
        // server holds for the symbol.
        ...(read.stale ? { stale: true, staleReason: "The market data upstream did not answer in time; this quote is the last end-of-day read this server holds for the symbol (see asOf and fetchedAt)." } : {}),
        note: `End-of-day close, not a live intraday quote, and no 52-week range (use stock-history for a range).${sentence(where?.note)}`,
      };
    },
  },

  {
    route: "GET /api/stock-history",
    name: "Stock historical bars",
    slug: "stock-history",
    // Repeat share is measured on the symbol (hashed in telemetry, never the value).
    telemetryKey: (i) => String(i?.symbol || "").trim().toUpperCase() || null,
    category: "data",
    price: "$0.005",
    description:
      `Daily OHLCV bars for a US equity: the last \`days\` sessions, 1 to 250, default 30. Daily only, no intraday.${sentence(COVERAGE_COPY)}${sentence(DESCRIBE.barsCopy)} A flat ascending array ready for charting or backtests. Set indicators to also get technical analysis computed from the same bars: RSI(14), MACD(12,26,9), EMA 20/50/200, SMA 20/50, Bollinger(20,2) and ATR(14), with a plain summary (close vs EMA50, RSI zone, MACD cross). Indicators need enough sessions (EMA200 needs days >= 200) and are descriptive, not a trading recommendation.`,
    tags: ["finance", "stocks", "history", "ohlcv", "technical-analysis"],
    discovery: {
      input: { symbol: "AAPL", days: 30 },
      inputSchema: {
        properties: {
          symbol: { type: "string", description: "US equity ticker, e.g. AAPL. Indices, FX and crypto are not covered." },
          days: { type: "integer", description: "Trading sessions to return, 1 to 250 (default 30)." },
          indicators: { description: `true for all, or a list of: ${STOCK_INDICATOR_IDS.join(", ")}. Computed from the returned bars (default none).` },
          points: { type: "integer", description: "Series points per indicator, newest last (default 5, max 100). Only with indicators." },
        },
        required: ["symbol"],
      },
      output: {
        example: {
          symbol: "AAPL",
          days: 2,
          bars: [
            { day: "2026-10-12", open: 338.215, high: 342.63, low: 337.6, close: 340.97, venueVolume: 25900599, volume: 25900599 },
            { day: "2026-10-13", open: 344.665, high: 348.1499, low: 340.74, close: 341.27, venueVolume: 38983839, volume: 38983839 },
          ],
          asOf: "2026-10-13",
          ...EXAMPLE_PROVENANCE,
        },
      },
    },
    handler: async (i, ctx) => {
      const symbol = assertSymbol(i.symbol);
      // An explicit out-of-range `days` is refused rather than clamped: a
      // caller who asked for 9999 sessions and silently got 365 would build
      // on a window they never requested. Absent means the documented 30.
      let days = 30;
      if (i.days !== undefined && i.days !== null && i.days !== "") {
        days = Number(i.days);
        if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
          throw bad(`"days" must be a whole number of sessions from 1 to ${MAX_DAYS} (got ${JSON.stringify(i.days)}).`);
        }
      }
      const want = stockIndicatorSet(i.indicators);
      let points = 5;
      if (i.points !== undefined && i.points !== null && i.points !== "") {
        points = Number(i.points);
        if (!Number.isInteger(points) || points < 1 || points > 100) throw bad(`"points" must be a whole number from 1 to 100 (got ${JSON.stringify(i.points)}).`);
      }
      // Bounded by the standing margin rule on this tool's own price: query
      // cost scales with the calendar span, so the advertised maximum is one
      // a buyer can actually spend.
      const read = await providerDailyBars(symbol, { sessions: days, maxUsd: MAX_QUERY_USD, demand: !ctx?.selfcheck });
      const bars = read.bars.slice(-days);
      return {
        symbol,
        days: bars.length,
        bars,
        asOf: bars.at(-1)?.day ?? null,
        ...read.provenance,
        // The session boundary's refresh failed: the bars end at the last
        // confirmed end, which `rangeCheckedAt` dates.
        ...(read.rangeStale ? { rangeStale: true, rangeCheckedAt: read.rangeCheckedAt } : {}),
        ...(want && bars.length >= 2 ? { analysis: stockAnalysis(bars, want, points) } : {}),
      };
    },
  },
];

/** The finance tools this boot lists: all of them with an active stock
 *  provider, none without one. */
export function financeToolsEnabled(env = process.env) {
  return stockDataEnabled(env) ? FINANCE_TOOLS : [];
}

// Technical indicators over the returned daily bars, through the same pure
// arithmetic crypto-indicators uses. No extra market-data read.
export function stockAnalysis(bars, want, points) {
  const candles = bars.map((b) => ({ t: Date.parse(`${b.day}T00:00:00Z`), o: b.open, h: b.high, l: b.low, c: b.close, v: b.venueVolume ?? 0 }));
  const { candles: _n, window: _w, ...rest } = computeIndicators(candles, want, points);
  return { sessions: candles.length, ...rest, disclaimer: "Technical indicators computed from daily bars. Descriptive only: not investment advice and not a trading signal or recommendation." };
}
