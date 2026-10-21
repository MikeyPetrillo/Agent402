// Finance tools: US equity end-of-day data from Databento.
//
// Previously Yahoo Finance. That was removed 2026-09-20: their developer terms
// forbid deriving income from the API without written permission, the endpoint
// used was an undocumented internal one, and reaching it required fetching an
// anti-bot "crumb" and routing around an IP block through a Cloudflare relay.
// None of that is a posture worth defending for a $0.001 tool.
//
// Databento is a paid commercial account, so access is licensed. The dataset is
// EQUS.SUMMARY, the consolidated end-of-day summary across all US exchanges
// and ATSs, with DBEQ.BASIC (a three-venue consolidation) as the fallback -
// see databento.js for what each covers, particularly for volume. Every
// answer names the dataset it came from and its coverage.
//
// Three tools went with Yahoo rather than moving: options-chain (would need a
// separate OPRA build), premarket-quote (extended-hours needs the live feed)
// and stock-dividends (corporate actions are not market data and Databento
// does not carry them). Removing beat keeping an unlicensed source.
import { availableEnd, availableEndInfo, dailyBarsRead, noteQuoteSymbol, quoteWindow, COVERAGE, PRIMARY_DATASET } from "./databento.js";
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
const MAX_QUERY_USD = 0.0035;

// What an answer says about where its bars came from. The note is the one
// caveat a reader needs for that dataset; `volume` is the market total only
// when the dataset is consolidated, and null otherwise.
const SUMMARY_NOTE = "Official consolidated end-of-day bars across all US exchanges and ATSs; volume is the consolidated total and includes post-market trading. Prices are unadjusted for splits and dividends.";
const FALLBACK_NOTE = "Daily bars from a three-venue consolidation (the consolidated dataset was unavailable for this read); venueVolume counts those venues only, not the consolidated tape, and volume is null.";
function provenance(dataset) {
  const c = COVERAGE[dataset];
  return { dataset: c.dataset, coverage: c.coverage, venues: c.venues, source: "databento.com " + c.dataset, note: c.consolidated ? SUMMARY_NOTE : FALLBACK_NOTE };
}
const COVERAGE_COPY = "Built from the official consolidated end-of-day summary across all US exchanges and ATSs, so price, range and volume are market totals. If that dataset is unavailable for a read, the answer comes from a consolidation of three U.S. exchange venues instead and says so: coverage reads three-venue, venueVolume counts those venues only and volume is null.";

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
      `End-of-day US equity quote: last close, day range, consolidated volume, previous close and the change between them. US equities only; indices, FX and crypto are not covered (crypto-price serves those). ${COVERAGE_COPY} No 52-week range and no intraday print: for a date range call stock-history. Each answer names its dataset and coverage, and says whether its bars came from this session's cache (cached, fetchedAt).`,
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
          ...provenance(PRIMARY_DATASET),
          note: `End-of-day close, not a live intraday quote, and no 52-week range (use stock-history for a range). ${SUMMARY_NOTE}`,
          cached: true,
          fetchedAt: "2026-10-14T13:05:12.000Z",
          rangeCheckedAt: "2026-10-14T13:00:03.000Z",
        },
      },
    },
    handler: async (i, ctx) => {
      const symbol = assertSymbol(i.symbol);
      // The available end is served from memory once warm (the warmer in
      // databento.js re-reads it off the request path), so a symbol already
      // read this session answers with no upstream call, and a cold one with
      // a single data read. Both say which they were: `cached` and
      // `fetchedAt` are the bars' own read time, `rangeCheckedAt` when the
      // session boundary was last confirmed.
      const range = await availableEndInfo({ demand: !ctx?.selfcheck });
      // A WEEK, not a year. Databento bills by bytes, and a 52-week lookback
      // priced above this tool's price - the cost guard refused it. Yahoo gave the 52-week range away inside one quote payload; here
      // it is a separate, larger query, so the fields are gone rather than
      // sold at a loss or silently narrowed. stock-history serves a range.
      const { start, end } = quoteWindow(range.end);
      // A read the upstream does not answer may be served from the last good
      // read (labeled stale), except for the self-check, which must see it.
      const read = await dailyBarsRead({ symbol, start, end, lastGoodOk: !ctx?.selfcheck });
      // The self-check's own call (/api/selfcheck) is not a buyer's demand.
      if (!ctx?.selfcheck) noteQuoteSymbol(symbol);
      const bars = read.bars;
      const last = bars.at(-1), prev = bars.at(-2) || null;
      const where = provenance(read.dataset);
      return {
        symbol,
        currency: "USD",
        price: last.close,
        previousClose: prev ? prev.close : null,
        changeAbs: prev ? Number((last.close - prev.close).toFixed(4)) : null,
        changePct: prev ? Number((((last.close - prev.close) / prev.close) * 100).toFixed(4)) : null,
        dayHigh: last.high,
        dayLow: last.low,
        // The market total on the consolidated dataset; null on the
        // three-venue fallback, whose share is only ever venueVolume.
        volume: last.volume ?? null,
        // Volume across the venues named in `venues`: the whole market on
        // the consolidated dataset, three venues on the fallback.
        venueVolume: last.venueVolume,
        asOf: last.day,
        ...where,
        cached: read.cached,
        fetchedAt: read.fetchedAt,
        rangeCheckedAt: range.checkedAt,
        // The upstream did not answer this read: the bars are the newest this
        // server holds for the symbol (databento.js, last good quote).
        ...(read.stale ? { stale: true, staleReason: "The market data upstream did not answer in time; this quote is the last end-of-day read this server holds for the symbol (see asOf and fetchedAt)." } : {}),
        note: `End-of-day close, not a live intraday quote, and no 52-week range (use stock-history for a range). ${where.note}`,
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
      `Daily OHLCV bars for a US equity: the last \`days\` sessions, 1 to 250, default 30. Daily only, no intraday. ${COVERAGE_COPY} On that fallback each bar's high and low are the extremes across the three venues and open and close come from the venue that traded the most that session. A flat ascending array ready for charting or backtests. Set indicators to also get technical analysis computed from the same bars: RSI(14), MACD(12,26,9), EMA 20/50/200, SMA 20/50, Bollinger(20,2) and ATR(14), with a plain summary (close vs EMA50, RSI zone, MACD cross). Indicators need enough sessions (EMA200 needs days >= 200) and are descriptive, not a trading recommendation.`,
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
          ...provenance(PRIMARY_DATASET),
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
      const end = await availableEnd({ demand: !ctx?.selfcheck });
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
      const read = await dailyBarsRead({ symbol, start, end, maxUsd: MAX_QUERY_USD });
      const bars = read.bars.slice(-days);
      return {
        symbol,
        days: bars.length,
        bars,
        asOf: bars.at(-1)?.day ?? null,
        ...provenance(read.dataset),
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
