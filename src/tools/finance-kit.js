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
// Note on options-chain: Yahoo's /v7/finance/options endpoint moved behind a
// session-cookie + crumb gate in 2023 and returns 401 to bare keyless callers.
// We implement the same handshake browsers do (fc.yahoo.com sets the A3
// cookie, /v1/test/getcrumb converts it to a crumb) — see getYahooSession()
// below. The cookie+crumb pair is cached module-wide and refreshed once on a
// 401, so steady-state calls cost a single upstream round-trip.
//
// safeFetch hardcodes the Agent402 UA (correct for our HTML scrapers) but
// some of these upstreams discriminate on UA, so this kit uses
// assertPublicUrl + native fetch with a per-host UA.
import { assertPublicUrl } from "./fetch-guard.js";
import { redactSecrets } from "./redact.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// A modern Chrome UA keeps Yahoo's chart endpoint and Nasdaq's calendar happy.
// Yahoo's API gateway is more relaxed; Nasdaq's CloudFront edge is the stricter
// of the two. CONFIRMED by an in-container test from Railway prod: Nasdaq
// tar-pits the old "Agent402/1.0" UA (request times out) but returns 200 to a
// browser UA from the same egress IP. So the default MUST be a browser UA —
// the previous Agent402 default is exactly what silently broke earnings-calendar.
// Override via FINANCE_USER_AGENT for deployer-specific values.
function financeUserAgent() {
  return (
    (process.env.FINANCE_USER_AGENT || "").trim() ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
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

async function jsonGet(url, host, extraHeaders = {}) {
  const safeUrl = await assertPublicUrl(url);
  const headers = {
    "User-Agent": financeUserAgent(),
    Accept: "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    ...extraHeaders,
  };
  const attempt = (timeout) => fetch(safeUrl, { headers, signal: AbortSignal.timeout(timeout) });
  let res;
  try {
    res = await attempt(10_000);
  } catch (firstErr) {
    // Single retry on network/timeout failure — handles transient upstream
    // slowness (Nasdaq CloudFront, Yahoo edge) without raising the base timeout.
    try {
      res = await attempt(12_000);
    } catch (e) {
      const cause = e.cause?.code ? ` (${e.cause.code})` : "";
      throw bad(`${host} request failed: ${e.message}${cause}`, 504);
    }
  }
  // Retry once on 5xx — Nasdaq and data.gov intermittently return 520/502/404
  // on first attempt then succeed immediately after. Without this, the Bazaar
  // registration sweep fails on the same 2-3 tools every run.
  if (res.status >= 500) {
    try {
      res = await attempt(12_000);
    } catch { /* fall through to the error handler below with the original 5xx */ }
  }
  const text = await res.text();
  if (!res.ok) {
    const s = res.status;
    if (s === 404) throw bad(`${host} returned 404 - unknown symbol or no data for the requested window`, 422);
    if (s === 401 || s === 403) throw bad(`${host} returned ${s} - upstream may require auth (try a different symbol or retry later)`, 502);
    if (s === 429) throw bad(`${host} rate-limited the request - retry shortly`, 503);
    if (s >= 500) throw bad(`${host} upstream HTTP ${s} - try again later`, 502);
    // Redact the full body before slicing — the Yahoo/Nasdaq relay token rides
    // Authorization: Bearer into this fetcher and could be reflected upstream.
    throw bad(`${host} HTTP ${s}: ${redactSecrets(text).slice(0, 200)}`, 422);
  }
  try { return JSON.parse(text); }
  catch { throw bad(`${host} returned non-JSON response`, 502); }
}

// Yahoo accepts only this enumerated set for interval and range — anything
// else returns a 422-style error from the chart API. Pre-validate so a bad
// agent input gets a 400 with the allowed list, not an upstream surprise.
const VALID_INTERVALS = new Set(["1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "1d", "5d", "1wk", "1mo", "3mo"]);
const VALID_RANGES = new Set(["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"]);

// Optional Cloudflare Worker relay for Yahoo's chart endpoint. When both env
// vars are set, we route through the relay instead of hitting Yahoo direct.
// This exists because some hosting providers' egress IPs are silently
// null-routed by Yahoo's edge (observed as TCP ETIMEDOUT). See
// workers/yfinance-relay/README.md. When env vars are unset, we hit Yahoo
// directly — preserves behavior for deployers whose egress isn't blocked.
async function fetchChart(symbol, params = {}) {
  const qs = new URLSearchParams(params);
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`;
  const relayUrl = (process.env.YAHOO_RELAY_URL || "").trim().replace(/\/$/, "");
  const relayToken = (process.env.YAHOO_RELAY_TOKEN || "").trim();
  if (relayUrl && relayToken) {
    return jsonGet(`${relayUrl}${path}`, "Yahoo Finance (relay)", { Authorization: `Bearer ${relayToken}` });
  }
  return jsonGet(`https://query1.finance.yahoo.com${path}`, "Yahoo Finance");
}

// Optional Cloudflare Worker relay for Nasdaq's calendar endpoint. Same
// pattern as fetchChart/yfinance-relay: Railway egress IPs are null-routed
// by Nasdaq's CloudFront. See workers/nasdaq-relay/README.md.
async function fetchNasdaq(path) {
  // Go DIRECT first. Confirmed from inside Railway prod: api.nasdaq.com returns
  // 200 to a browser UA (see financeUserAgent) from our own egress IP — there is
  // no IP block. The CF Worker relay is now the BROKEN path: Nasdaq blocks
  // Cloudflare's Worker egress IPs and returns 520 through it. So the relay is
  // only a fallback for a hypothetical future direct failure, never the primary.
  const relayUrl = (process.env.NASDAQ_RELAY_URL || "").trim().replace(/\/$/, "");
  const relayToken = (process.env.NASDAQ_RELAY_TOKEN || "").trim();
  if (!(relayUrl && relayToken)) return jsonGet(`https://api.nasdaq.com${path}`, "Nasdaq");
  try {
    return await jsonGet(`https://api.nasdaq.com${path}`, "Nasdaq");
  } catch (e) {
    return jsonGet(`${relayUrl}${path}`, "Nasdaq (relay)", { Authorization: `Bearer ${relayToken}` });
  }
}

// --- Yahoo options session (cookie + crumb handshake) -----------------------
// fc.yahoo.com answers 404 but sets the HttpOnly A3 session cookie;
// /v1/test/getcrumb converts that cookie into the crumb the options endpoint
// requires. Both are cached module-wide (the cookie is valid for months, the
// crumb for the cookie's lifetime) and refreshed at most once per failed call.
let yahooSession = null; // { cookie, crumb, fetchedAt }
const YAHOO_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

async function getYahooSession(force = false) {
  if (!force && yahooSession && Date.now() - yahooSession.fetchedAt < YAHOO_SESSION_TTL_MS) return yahooSession;
  const headers = { "User-Agent": financeUserAgent(), Accept: "*/*" };
  let cookie = "";
  try {
    const url = await assertPublicUrl("https://fc.yahoo.com/");
    const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    await res.text().catch(() => {}); // drain — body is a throwaway 404 page
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    cookie = setCookies.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
  } catch (e) {
    throw bad(`Yahoo Finance session handshake failed: ${e.message}`, 504);
  }
  if (!cookie) throw bad("Yahoo Finance did not issue a session cookie - options auth handshake failed", 502);
  const crumbUrl = await assertPublicUrl("https://query1.finance.yahoo.com/v1/test/getcrumb");
  let crumbRes;
  try {
    crumbRes = await fetch(crumbUrl, { headers: { ...headers, Cookie: cookie }, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw bad(`Yahoo Finance crumb request failed: ${e.message}`, 504);
  }
  const crumb = (await crumbRes.text()).trim();
  // A real crumb is a short opaque token; HTML in the body means a block page.
  if (!crumbRes.ok || !crumb || crumb.length > 64 || crumb.includes("<")) {
    throw bad(`Yahoo Finance crumb handshake failed (HTTP ${crumbRes.status})`, 502);
  }
  yahooSession = { cookie, crumb, fetchedAt: Date.now() };
  return yahooSession;
}

// Options fetch: relay first when configured (the relay Worker performs the
// crumb dance on its own egress — see workers/yfinance-relay), falling back
// to a direct cookie+crumb call. Direct-first would be wasted work on hosts
// whose egress Yahoo null-routes (the whole reason the relay exists).
async function fetchOptions(symbol, params = {}) {
  const basePath = `/v7/finance/options/${encodeURIComponent(symbol)}`;
  const relayUrl = (process.env.YAHOO_RELAY_URL || "").trim().replace(/\/$/, "");
  const relayToken = (process.env.YAHOO_RELAY_TOKEN || "").trim();
  if (relayUrl && relayToken) {
    try {
      const qs = new URLSearchParams(params);
      return await jsonGet(`${relayUrl}${basePath}?${qs}`, "Yahoo Finance (relay)", { Authorization: `Bearer ${relayToken}` });
    } catch {
      // Deployed relay may predate the options path (403s it) — fall through
      // to direct, which works wherever Yahoo permits the egress IP.
    }
  }
  const attempt = async (force) => {
    const s = await getYahooSession(force);
    const qs = new URLSearchParams(params);
    qs.set("crumb", s.crumb);
    return jsonGet(`https://query1.finance.yahoo.com${basePath}?${qs}`, "Yahoo Finance (options)", { Cookie: s.cookie });
  };
  try {
    return await attempt(false);
  } catch (e) {
    // jsonGet maps Yahoo's 401 "Invalid Crumb" to 502 — refresh the session
    // once (expired cookie) and retry before surfacing the error.
    if (e.statusCode === 502) return attempt(true);
    throw e;
  }
}

// Session classifier for pre/post-market quotes. `currentTradingPeriod` in
// Yahoo's chart meta carries the epoch bounds of today's pre/regular/post
// windows in the exchange's own timezone — no local DST math needed.
function classifySession(epochSeconds, ctp) {
  if (!ctp || !Number.isFinite(epochSeconds)) return "unknown";
  const inside = (p) => p && epochSeconds >= p.start && epochSeconds < p.end;
  if (inside(ctp.pre)) return "pre";
  if (inside(ctp.regular)) return "regular";
  if (inside(ctp.post)) return "post";
  return "closed";
}

// Options-chain expiration guard — pure, exported so scripts/test-finance-kit.js
// can exercise it offline. `requested` is the caller's YYYY-MM-DD string,
// `listedIsoDates` the YYYY-MM-DD list derived from Yahoo's
// optionChain.result[0].expirationDates meta. The error message caps the
// listed dates at 12 so a long-dated underlying (SPY has 20+) stays readable.
export function assertListedExpiration(requested, listedIsoDates, symbol) {
  if (listedIsoDates.includes(requested)) return;
  const shown = listedIsoDates.slice(0, 12).join(", ") + (listedIsoDates.length > 12 ? ", …" : "");
  throw bad(`"${symbol}" has no listed option expiration ${requested} - "expiration" must be one of the listed expirations: ${shown}`, 422);
}

export const FINANCE_TOOLS = [
  {
    route: "GET /api/stock-quote",
    name: "Stock quote",
    slug: "stock-quote",
    category: "data",
    // $0.010 → $0.003 (2026-07-13): our broadest-organic-demand tool (35
    // distinct paying wallets/14d) was priced 3.3× the market leader's
    // identical product. Match the market; watch volume.
    price: "$0.001",
    description:
      "Live stock/index/FX/crypto quote: last price, day range, 52-week range, previous close, currency, exchange, and a relative change vs. previous close, as clean JSON. The single-symbol NOW read - for OHLC time series use stock-history, for pre/post-market use premarket-quote, and for crypto pairs crypto-price returns richer market fields. Backed by Yahoo Finance's public chart endpoint - keyless, no rate limits in practice. Symbols: equities (AAPL), indices (^GSPC), FX (EURUSD=X), crypto (BTC-USD).",
    tags: ["finance", "stocks", "quote", "market-data", "price"],
    discovery: {
      input: { symbol: "AAPL" },
      inputSchema: {
        properties: {
          symbol: { type: "string", description: "Ticker symbol - equity (AAPL), index (^GSPC), FX (EURUSD=X), crypto (BTC-USD)" },
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
        // The bulk of this tool's real errors are well-formed-but-wrong symbols
        // (an agent guessing the ticker format). Return the exact conventions so
        // the agent can self-correct on the next call instead of re-guessing.
        throw bad(
          `No quote data for "${symbol}". Check the symbol format - equity: AAPL · index needs a caret: ^GSPC · FX pair uses =X: EURUSD=X · crypto uses -USD: BTC-USD.`,
          422,
        );
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
    price: "$0.015",
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
    price: "$0.015",
    description:
      "Earnings calendar for a given date - every company reporting that day with EPS estimate, EPS actual (if reported), and reporting time slot. Optional `symbol` filter narrows to one ticker. Defaults to today (UTC). Backed by Nasdaq's public calendar API.",
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
      const data = await fetchNasdaq(
        `/api/calendar/earnings?date=${encodeURIComponent(date)}`,
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

  {
    route: "GET /api/options-chain",
    name: "Options chain",
    slug: "options-chain",
    category: "data",
    price: "$0.005",
    description:
      "Option chain for a US-listed ticker: all listed expiration dates, the strike ladder, and per-contract bid/ask/last/volume/open-interest/implied-volatility for calls and puts at one expiry (nearest by default, or pass `expiration` as YYYY-MM-DD). Backed by Yahoo Finance's options endpoint with the session-crumb handshake handled server-side.",
    tags: ["finance", "options", "derivatives", "strikes", "market-data"],
    discovery: {
      input: { symbol: "AAPL" },
      inputSchema: {
        properties: {
          symbol: { type: "string", description: "US-listed ticker (e.g. AAPL, SPY, TSLA)" },
          expiration: { type: "string", description: "Optional expiry to fetch, YYYY-MM-DD - must be one of the listed expirations (default: nearest)" },
        },
        required: ["symbol"],
      },
      output: {
        example: {
          symbol: "AAPL",
          underlyingPrice: 232.45,
          currency: "USD",
          expiration: "2026-07-17",
          expirations: ["2026-07-17", "2026-07-24", "2026-08-21"],
          strikes: [220, 225, 230, 235, 240],
          calls: [
            { contractSymbol: "AAPL260717C00230000", strike: 230, lastPrice: 4.35, bid: 4.30, ask: 4.45, volume: 1523, openInterest: 8211, impliedVolatility: 0.2431, inTheMoney: true, expiration: "2026-07-17" },
          ],
          puts: [
            { contractSymbol: "AAPL260717P00230000", strike: 230, lastPrice: 1.95, bid: 1.90, ask: 2.02, volume: 987, openInterest: 5410, impliedVolatility: 0.2519, inTheMoney: false, expiration: "2026-07-17" },
          ],
          callCount: 1,
          putCount: 1,
        },
      },
    },
    handler: async (i) => {
      const symbol = normalizeSymbol(i.symbol);
      const params = {};
      if (i.expiration != null && i.expiration !== "") {
        if (typeof i.expiration !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(i.expiration)) {
          throw bad('"expiration" must be YYYY-MM-DD (one of the listed expirations)');
        }
        // Yahoo keys expiries by UTC-midnight epoch seconds.
        params.date = String(Math.floor(Date.parse(`${i.expiration}T00:00:00Z`) / 1000));
      }
      const data = await fetchOptions(symbol, params);
      const r = data?.optionChain?.result?.[0];
      if (!r) {
        throw bad(`No options data for "${symbol}" - the symbol may not have listed options (only US-listed equities/ETFs do).`, 422);
      }
      const iso = (sec) => (Number.isFinite(sec) ? new Date(sec * 1000).toISOString().slice(0, 10) : null);
      const expirations = (r.expirationDates ?? []).map(iso).filter(Boolean);
      // Yahoo does NOT reject an unlisted `date` — it echoes it back with empty
      // calls/puts, which would turn into a paid 200 with callCount: 0. Enforce
      // the "must be one of the listed expirations" contract ourselves (this
      // also catches impossible dates like 2026-02-31, which Date.parse
      // silently rolls over to a different day).
      if (params.date) assertListedExpiration(i.expiration, expirations, symbol);
      const chain = r.options?.[0];
      if (!chain && params.date) {
        throw bad(`"${symbol}" has no option chain for expiration ${i.expiration}. Listed expirations: ${expirations.join(", ")}`, 422);
      }
      const mapContract = (c) => ({
        contractSymbol: c.contractSymbol ?? null,
        strike: c.strike ?? null,
        lastPrice: c.lastPrice ?? null,
        bid: c.bid ?? null,
        ask: c.ask ?? null,
        volume: c.volume ?? null,
        openInterest: c.openInterest ?? null,
        impliedVolatility: typeof c.impliedVolatility === "number" ? +c.impliedVolatility.toFixed(6) : null,
        inTheMoney: c.inTheMoney ?? null,
        expiration: iso(c.expiration),
      });
      const calls = (chain?.calls ?? []).map(mapContract);
      const puts = (chain?.puts ?? []).map(mapContract);
      return {
        symbol: r.underlyingSymbol ?? symbol,
        underlyingPrice: r.quote?.regularMarketPrice ?? null,
        currency: r.quote?.currency ?? null,
        expiration: iso(chain?.expirationDate),
        expirations,
        strikes: r.strikes ?? [],
        calls,
        puts,
        callCount: calls.length,
        putCount: puts.length,
      };
    },
  },

  {
    route: "GET /api/premarket-quote",
    name: "Pre/post-market quote",
    slug: "premarket-quote",
    category: "data",
    price: "$0.003",
    description:
      "Extended-hours quote for a US-listed ticker: latest traded price including pre-market and after-hours sessions, which session it printed in (pre / regular / post / closed), change vs. the last regular-session price, and today's session windows. Backed by Yahoo Finance's chart endpoint with includePrePost.",
    tags: ["finance", "stocks", "premarket", "after-hours", "quote", "extended-hours"],
    discovery: {
      input: { symbol: "SPY" },
      inputSchema: {
        properties: {
          symbol: { type: "string", description: "US-listed ticker (e.g. SPY, AAPL)" },
        },
        required: ["symbol"],
      },
      output: {
        example: {
          symbol: "SPY",
          name: "SPDR S&P 500 ETF Trust",
          currency: "USD",
          exchange: "PCX",
          marketState: "post",
          regularMarketPrice: 620.32,
          regularMarketTime: "2026-07-13T20:00:00Z",
          previousClose: 618.10,
          latestPrice: 621.05,
          latestTime: "2026-07-13T23:59:00Z",
          latestSession: "post",
          extendedChangeAbs: 0.73,
          extendedChangePct: 0.1177,
          sessions: {
            pre: { start: "2026-07-13T08:00:00Z", end: "2026-07-13T13:30:00Z" },
            regular: { start: "2026-07-13T13:30:00Z", end: "2026-07-13T20:00:00Z" },
            post: { start: "2026-07-13T20:00:00Z", end: "2026-07-14T00:00:00Z" },
          },
        },
      },
    },
    handler: async (i) => {
      const symbol = normalizeSymbol(i.symbol);
      const data = await fetchChart(symbol, { interval: "1m", range: "1d", includePrePost: "true" });
      const r = data?.chart?.result?.[0];
      const m = r?.meta;
      if (!m || typeof m.regularMarketPrice !== "number") {
        throw bad(`No quote data for "${symbol}". Extended-hours quotes cover US-listed equities/ETFs (e.g. SPY, AAPL).`, 422);
      }
      const ctp = m.currentTradingPeriod;
      // Walk the 1-minute bars from the end for the latest print — with
      // includePrePost the series covers pre + regular + post sessions.
      const ts = r.timestamp ?? [];
      const closes = r.indicators?.quote?.[0]?.close ?? [];
      let latestPrice = null, latestEpoch = null;
      for (let idx = ts.length - 1; idx >= 0; idx--) {
        if (closes[idx] != null) { latestPrice = closes[idx]; latestEpoch = ts[idx]; break; }
      }
      if (latestPrice == null) { latestPrice = m.regularMarketPrice; latestEpoch = m.regularMarketTime ?? null; }
      const latestSession = classifySession(latestEpoch, ctp);
      // Change vs the last regular-session price — correct in both directions:
      // during pre-market regularMarketPrice is yesterday's close; after hours
      // it's today's close.
      const base = m.regularMarketPrice;
      const extAbs = base ? +(latestPrice - base).toFixed(6) : null;
      const extPct = base ? +(((latestPrice - base) / base) * 100).toFixed(4) : null;
      const window = (p) => (p && Number.isFinite(p.start) && Number.isFinite(p.end)
        ? { start: new Date(p.start * 1000).toISOString(), end: new Date(p.end * 1000).toISOString() }
        : null);
      return {
        symbol: m.symbol ?? symbol,
        name: m.longName ?? m.shortName ?? null,
        currency: m.currency ?? null,
        exchange: m.exchangeName ?? null,
        marketState: classifySession(Math.floor(Date.now() / 1000), ctp),
        regularMarketPrice: base,
        regularMarketTime: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
        previousClose: m.chartPreviousClose ?? m.previousClose ?? null,
        latestPrice,
        latestTime: latestEpoch ? new Date(latestEpoch * 1000).toISOString() : null,
        latestSession,
        extendedChangeAbs: extAbs,
        extendedChangePct: extPct,
        sessions: { pre: window(ctp?.pre), regular: window(ctp?.regular), post: window(ctp?.post) },
      };
    },
  },

  {
    route: "GET /api/stock-dividends",
    name: "Stock dividends & splits",
    slug: "stock-dividends",
    category: "data",
    price: "$0.003",
    description:
      "Dividend and stock-split history for a ticker: every cash dividend (ex-date + amount) and split (date + ratio) over a configurable range (default 5y, up to max). Empty arrays for non-payers - a valid answer, not an error. Backed by Yahoo Finance's chart endpoint with events=div,split.",
    tags: ["finance", "dividends", "splits", "income", "history"],
    discovery: {
      input: { symbol: "AAPL" },
      inputSchema: {
        properties: {
          symbol: { type: "string", description: "Ticker symbol (e.g. AAPL)" },
          range: { type: "string", description: "History window: 1y, 2y, 5y, 10y, ytd, max (default 5y)" },
        },
        required: ["symbol"],
      },
      output: {
        example: {
          symbol: "AAPL",
          currency: "USD",
          range: "5y",
          dividends: [
            { date: "2026-05-11", amount: 0.26 },
          ],
          splits: [
            { date: "2020-08-31", numerator: 4, denominator: 1, ratio: "4:1" },
          ],
          dividendCount: 1,
          splitCount: 1,
        },
      },
    },
    handler: async (i) => {
      const symbol = normalizeSymbol(i.symbol);
      const range = typeof i.range === "string" && i.range ? i.range : "5y";
      if (!VALID_RANGES.has(range)) throw bad(`"range" must be one of: ${[...VALID_RANGES].join(", ")}`);
      const data = await fetchChart(symbol, { interval: "1mo", range, events: "div,split" });
      const r = data?.chart?.result?.[0];
      if (!r) throw bad(`No data for "${symbol}" - check the symbol format (equity: AAPL).`, 422);
      const day = (sec) => (Number.isFinite(sec) ? new Date(sec * 1000).toISOString().slice(0, 10) : null);
      const dividends = Object.values(r.events?.dividends ?? {})
        .map((d) => ({ date: day(d.date), amount: d.amount ?? null }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      const splits = Object.values(r.events?.splits ?? {})
        .map((s) => ({
          date: day(s.date),
          numerator: s.numerator ?? null,
          denominator: s.denominator ?? null,
          ratio: s.splitRatio ?? (s.numerator && s.denominator ? `${s.numerator}:${s.denominator}` : null),
        }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      return {
        symbol: r.meta?.symbol ?? symbol,
        currency: r.meta?.currency ?? null,
        range,
        dividends,
        splits,
        dividendCount: dividends.length,
        splitCount: splits.length,
      };
    },
  },

  {
    route: "GET /api/dividend-calendar",
    name: "Dividend calendar",
    slug: "dividend-calendar",
    category: "data",
    price: "$0.005",
    description:
      "Market-wide ex-dividend calendar for a given date - every US-listed company going ex-dividend that day with dividend rate, indicated annual dividend, payment date, and record date. Optional `symbol` filter narrows to one ticker. Defaults to today (UTC). Backed by Nasdaq's public calendar API - same upstream as earnings-calendar.",
    tags: ["finance", "dividends", "calendar", "ex-dividend", "income", "events"],
    discovery: {
      input: {},
      inputSchema: {
        properties: {
          date: { type: "string", description: "YYYY-MM-DD (default: today UTC)" },
          symbol: { type: "string", description: "Optional ticker filter" },
        },
      },
      output: {
        example: {
          date: "2026-07-14",
          count: 1,
          entries: [
            { symbol: "APOG", name: "Apogee Enterprises, Inc. Common Stock", exDate: "2026-07-14", paymentDate: "2026-07-29", recordDate: "2026-07-14", announcementDate: "2026-06-24", dividend: 0.27, annualDividend: 1.08 },
          ],
        },
      },
    },
    handler: async (i) => {
      const date = typeof i.date === "string" && i.date ? i.date : new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('"date" must be YYYY-MM-DD');
      const data = await fetchNasdaq(`/api/calendar/dividends?date=${encodeURIComponent(date)}`);
      // Nasdaq nests dividend rows one level deeper than earnings:
      // { data: { calendar: { rows: [...] } } }. Empty dates → null calendar —
      // surface as count: 0, "nothing goes ex-div today" is a valid answer.
      const rows = data?.data?.calendar?.rows ?? [];
      const filter = typeof i.symbol === "string" ? normalizeSymbol(i.symbol) : null;
      // Rates arrive as numbers, but guard the "N/A"/string case Nasdaq uses
      // elsewhere in the same API family (see earnings-calendar).
      const num = (v) => {
        if (v == null || v === "" || v === "N/A") return null;
        const n = Number(String(v).replace(/[$,]/g, ""));
        return Number.isFinite(n) ? n : null;
      };
      // Dates arrive US-style ("7/14/2026") — normalize to ISO for agents.
      const usDate = (s) => {
        if (typeof s !== "string" || !s || s === "N/A") return null;
        const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
      };
      const entries = rows
        .filter((row) => !filter || row.symbol === filter)
        .map((row) => ({
          symbol: row.symbol ?? null,
          name: row.companyName ?? null,
          exDate: usDate(row.dividend_Ex_Date),
          paymentDate: usDate(row.payment_Date),
          recordDate: usDate(row.record_Date),
          announcementDate: usDate(row.announcement_Date),
          dividend: num(row.dividend_Rate),
          annualDividend: num(row.indicated_Annual_Dividend),
        }));
      return { date, count: entries.length, entries };
    },
  },
];
