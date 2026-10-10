// Finance tools: US equity end-of-day data from Databento.
//
// Previously Yahoo Finance. That was removed 2026-09-20: their developer terms
// forbid deriving income from the API without written permission, the endpoint
// used was an undocumented internal one, and reaching it required fetching an
// anti-bot "crumb" and routing around an IP block through a Cloudflare relay.
// None of that is a posture worth defending for a $0.001 tool.
//
// Databento is a paid commercial account, so access is licensed. The dataset is
// DBEQ.BASIC, a three-venue consolidation - see databento.js for what that does
// and does not mean, particularly for volume.
//
// Three tools went with Yahoo rather than moving: options-chain (would need a
// separate OPRA build), premarket-quote (extended-hours needs the live feed)
// and stock-dividends (corporate actions are not market data and Databento
// does not carry them). Removing beat keeping an unlicensed source.
import { availableEnd, availableEndInfo, dailyBars, dailyBarsRead, noteQuoteSymbol, quoteWindow, DATASET, VENUES } from "./databento.js";
import { computeIndicators } from "./crypto-signals-kit.js";

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
// the bars carry three-venue volume, not the consolidated tape.
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
      "End-of-day US equity quote: last close, day range, previous close and the change between them. US equities only; indices, FX and crypto are not covered (crypto-price serves those). Built from a three-venue consolidation (Databento DBEQ.BASIC), so the prices track the wider market but the volume counts those three venues only and is returned as venueVolume rather than as a total. No 52-week range and no intraday print: for a date range call stock-history. Each answer says whether its bars came from this session's cache (cached, fetchedAt).",
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
          price: 335.5,
          previousClose: 336.79,
          changeAbs: -1.29,
          changePct: -0.383,
          dayHigh: 338.41,
          dayLow: 332.545,
          venueVolume: 1630155,
          asOf: "2026-09-18",
          venues: VENUES,
          source: "databento.com DBEQ.BASIC",
          cached: true,
          fetchedAt: "2026-09-19T13:05:12.000Z",
          rangeCheckedAt: "2026-09-19T13:00:03.000Z",
          note: "End-of-day close from a three-venue consolidation. Not a live intraday quote, not consolidated-tape volume, and no 52-week range - use stock-history for a range.",
        },
      },
    },
    handler: async (i) => {
      const symbol = assertSymbol(i.symbol);
      // The available end is served from memory once warm (the warmer in
      // databento.js re-reads it off the request path), so a symbol already
      // read this session answers with no upstream call, and a cold one with
      // a single data read. Both say which they were: `cached` and
      // `fetchedAt` are the bars' own read time, `rangeCheckedAt` when the
      // session boundary was last confirmed.
      const range = await availableEndInfo();
      // A WEEK, not a year. Databento bills by bytes, and a 52-week lookback
      // priced above this tool's price - the cost guard refused it. Yahoo gave the 52-week range away inside one quote payload; here
      // it is a separate, larger query, so the fields are gone rather than
      // sold at a loss or silently narrowed. stock-history serves a range.
      const { start, end } = quoteWindow(range.end);
      const read = await dailyBarsRead({ symbol, start, end });
      noteQuoteSymbol(symbol);
      const bars = read.bars;
      const last = bars.at(-1), prev = bars.at(-2) || null;
      return {
        symbol,
        currency: "USD",
        price: last.close,
        previousClose: prev ? prev.close : null,
        changeAbs: prev ? Number((last.close - prev.close).toFixed(4)) : null,
        changePct: prev ? Number((((last.close - prev.close) / prev.close) * 100).toFixed(4)) : null,
        dayHigh: last.high,
        dayLow: last.low,
        // NOT total market volume: DBEQ.BASIC covers three venues, so this is
        // their share only. Named venueVolume so it cannot read as a total.
        venueVolume: last.venueVolume,
        asOf: last.day,
        venues: VENUES,
        source: "databento.com " + DATASET,
        cached: read.cached,
        fetchedAt: read.fetchedAt,
        rangeCheckedAt: range.checkedAt,
        note: "End-of-day close from a three-venue consolidation. Not a live intraday quote, not consolidated-tape volume, and no 52-week range - use stock-history for a range.",
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
      "Daily OHLCV bars for a US equity: the last `days` sessions, 1 to 250, default 30. Daily only, no intraday. Built from a three-venue consolidation (Databento DBEQ.BASIC), so each bar's high and low are the extremes across those venues, open and close come from the venue that traded the most that session, and venueVolume sums those three venues rather than the consolidated tape. A flat ascending array ready for charting or backtests. Set indicators to also get technical analysis computed from the same bars: RSI(14), MACD(12,26,9), EMA 20/50/200, SMA 20/50, Bollinger(20,2) and ATR(14), with a plain summary (close vs EMA50, RSI zone, MACD cross). Indicators need enough sessions (EMA200 needs days >= 200) and are descriptive, not a trading recommendation.",
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
            { day: "2026-09-17", open: 218.2, high: 220.3, low: 217.65, close: 219.8, venueVolume: 1481234 },
            { day: "2026-09-18", open: 219.9, high: 221.05, low: 219.1, close: 220.4, venueVolume: 1630155 },
          ],
          asOf: "2026-09-18",
          venues: VENUES,
          source: "databento.com DBEQ.BASIC",
          note: "Daily bars from a three-venue consolidation; venueVolume counts those venues only, not the consolidated tape.",
        },
      },
    },
    handler: async (i) => {
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
      const end = await availableEnd();
      // N sessions span about 1.4N calendar days once weekends are counted,
      // so the lookback SCALES rather than adding a flat margin: a flat +10
      // returned 29 bars for a 30-session ask, and the shortfall grows with
      // the window. The extra 12 days covers the ~9 US market holidays a
      // year plus the partial week either side of them.
      const span = Math.ceil(days * 1.45) + 12;
      const start = new Date(new Date(end) - span * 864e5).toISOString().slice(0, 10);
      // Bounded by the standing margin rule on this tool's own price. That
      // bound, not a round number, is what sets MAX_DAYS: query cost scales
      // with the calendar span, so the advertised maximum is one a buyer can
      // actually spend. A flat 365 was advertised
      // and refused at 90.
      const bars = (await dailyBars({ symbol, start, end, maxUsd: MAX_QUERY_USD })).slice(-days);
      return {
        symbol,
        days: bars.length,
        bars,
        asOf: bars.at(-1)?.day ?? null,
        venues: VENUES,
        source: "databento.com " + DATASET,
        note: "Daily bars from a three-venue consolidation; venueVolume counts those venues only, not the consolidated tape.",
        ...(want && bars.length >= 2 ? { analysis: stockAnalysis(bars, want, points) } : {}),
      };
    },
  },
];

// Technical indicators over the returned daily bars, through the same pure
// arithmetic crypto-indicators uses. No extra market-data read.
export function stockAnalysis(bars, want, points) {
  const candles = bars.map((b) => ({ t: Date.parse(`${b.day}T00:00:00Z`), o: b.open, h: b.high, l: b.low, c: b.close, v: b.venueVolume ?? 0 }));
  const { candles: _n, window: _w, ...rest } = computeIndicators(candles, want, points);
  return { sessions: candles.length, ...rest, disclaimer: "Technical indicators computed from daily bars. Descriptive only: not investment advice and not a trading signal or recommendation." };
}
