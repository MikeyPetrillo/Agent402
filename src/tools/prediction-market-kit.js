// Prediction-market kit — read-only access to the two largest prediction-market
// venues. Polymarket (Gamma metadata + CLOB orderbook/history) and Kalshi
// (CFTC-regulated US event contracts). Both venues expose public, keyless
// HTTP APIs we can proxy without holding user funds.
//
// Honest scoping: read-only. No order placement, no signed L2 actions.
// Order placement requires user-signed EIP-712 (Polymarket) or Kalshi API
// keys; both lie outside Agent402's deterministic, pay-per-call envelope.
//
// Why this matters for agents: prediction markets are the canonical
// "live probability of a future event" feed (sports, elections, macro,
// crypto, climate). Existing search/news kits report what *happened*;
// this kit reports what the market thinks will happen, with timestamped
// odds movements.
//
// All 6 tools are wallet-only — every handler hits an external API and
// shares a per-IP rate limit with the public endpoint pool.
//
// Covered by scripts/test-prediction-market-kit.js (offline + opt-in live).

const TIMEOUT_MS = 12_000;

// Endpoints. All keyless as of 2026-06; documented at:
// - https://docs.polymarket.com/developers/gamma-markets-api/overview
// - https://docs.polymarket.com/developers/CLOB/overview
// - https://trading-api.readme.io/reference/getmarkets (Kalshi)
const POLY_GAMMA = "https://gamma-api.polymarket.com";
const POLY_CLOB = "https://clob.polymarket.com";
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function fetchJson(url, label) {
  let res;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "agent402/prediction-market-kit" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === "TimeoutError" || /aborted/i.test(e.message)) {
      throw bad(`${label} upstream timed out after ${TIMEOUT_MS}ms`, 504);
    }
    throw bad(`${label} upstream unreachable: ${e.message}`, 502);
  }
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    const body = ct.includes("json") ? JSON.stringify(await res.json().catch(() => null)).slice(0, 240) : (await res.text().catch(() => "")).slice(0, 240);
    throw bad(`${label} upstream returned HTTP ${res.status}${body ? ": " + body : ""}`, res.status >= 500 ? 502 : res.status);
  }
  if (!ct.includes("json")) {
    throw bad(`${label} upstream returned non-JSON content-type: ${ct}`, 502);
  }
  return res.json();
}

// Polymarket Gamma reports prices as strings ("0.45"); CLOB orderbook reports
// the same way. Normalize to numbers so agents don't have to parseFloat
// everywhere — but keep the raw string in case the agent wants the original.
function asNumber(value, fallback = null) {
  if (value == null) return fallback;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

// Polymarket markets include outcomes + prices as JSON-encoded strings inside
// the response (a quirk of the Gamma API). Parse them; on failure return [].
function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Compact, agent-friendly Polymarket market envelope. We drop ~40 fields
// from Gamma's raw payload that aren't useful for an agent reading the
// market (graphic URLs, internal flags, denormalized series links).
function shapeMarket(m) {
  const outcomes = parseJsonArray(m.outcomes);
  const prices = parseJsonArray(m.outcomePrices).map((p) => asNumber(p));
  const tokenIds = parseJsonArray(m.clobTokenIds);
  return {
    id: m.id ?? null,
    slug: m.slug ?? null,
    question: m.question ?? null,
    description: m.description ?? null,
    endDate: m.endDate ?? null,
    active: !!m.active,
    closed: !!m.closed,
    archived: !!m.archived,
    volume: asNumber(m.volume),
    liquidity: asNumber(m.liquidity),
    outcomes,
    prices,
    clobTokenIds: tokenIds,
    eventSlug: m.events?.[0]?.slug ?? null,
    venue: "polymarket",
    venueUrl: m.slug ? `https://polymarket.com/market/${m.slug}` : null,
  };
}

function shapeKalshiMarket(m) {
  return {
    ticker: m.ticker ?? null,
    eventTicker: m.event_ticker ?? null,
    title: m.title ?? null,
    subtitle: m.subtitle ?? null,
    status: m.status ?? null,
    openTime: m.open_time ?? null,
    closeTime: m.close_time ?? null,
    expirationTime: m.expiration_time ?? null,
    yesBid: asNumber(m.yes_bid),
    yesAsk: asNumber(m.yes_ask),
    noBid: asNumber(m.no_bid),
    noAsk: asNumber(m.no_ask),
    lastPrice: asNumber(m.last_price),
    volume: asNumber(m.volume),
    openInterest: asNumber(m.open_interest),
    venue: "kalshi",
    venueUrl: m.ticker ? `https://kalshi.com/markets/${m.ticker.toLowerCase()}` : null,
  };
}

// ----------------------------------------------------------------------------
// 1. polymarket-search — keyword search across active Polymarket markets
// ----------------------------------------------------------------------------
async function polymarketSearch({ query, limit, activeOnly } = {}) {
  if (typeof query !== "string" || !query.trim()) {
    throw bad('"query" is required (non-empty string)');
  }
  const lim = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
  const params = new URLSearchParams({
    limit: String(Math.min(lim * 4, 200)), // overfetch then filter client-side
    order: "volume24hr",
    ascending: "false",
  });
  if (activeOnly !== false) {
    params.set("active", "true");
    params.set("closed", "false");
  }
  const raw = await fetchJson(`${POLY_GAMMA}/markets?${params}`, "Polymarket Gamma");
  const arr = Array.isArray(raw) ? raw : [];
  const q = query.trim().toLowerCase();
  const matched = arr
    .filter((m) => {
      const hay = `${m.question || ""} ${m.slug || ""} ${m.description || ""}`.toLowerCase();
      return hay.includes(q);
    })
    .slice(0, lim)
    .map(shapeMarket);
  return {
    query: query.trim(),
    count: matched.length,
    markets: matched,
    source: "polymarket-gamma",
  };
}

// ----------------------------------------------------------------------------
// 2. polymarket-market — get a single market by slug or id with full detail
// ----------------------------------------------------------------------------
async function polymarketMarket({ slug, id } = {}) {
  const s = typeof slug === "string" ? slug.trim() : "";
  const i = typeof id === "string" || typeof id === "number" ? String(id).trim() : "";
  if (!s && !i) throw bad('"slug" or "id" is required');
  let raw;
  if (i) {
    raw = await fetchJson(`${POLY_GAMMA}/markets/${encodeURIComponent(i)}`, "Polymarket Gamma");
  } else {
    // Gamma doesn't take ?slug= directly — fetch by slug filter.
    const r = await fetchJson(`${POLY_GAMMA}/markets?slug=${encodeURIComponent(s)}`, "Polymarket Gamma");
    if (!Array.isArray(r) || !r.length) throw bad(`Market not found for slug "${s}"`, 404);
    raw = r[0];
  }
  return shapeMarket(raw);
}

// ----------------------------------------------------------------------------
// 3. polymarket-orderbook — bids/asks for a specific outcome token (CLOB)
// ----------------------------------------------------------------------------
async function polymarketOrderbook({ tokenId, depth } = {}) {
  if (typeof tokenId !== "string" || !/^\d+$/.test(tokenId.trim())) {
    throw bad('"tokenId" is required (decimal-encoded CLOB token id string — see market.clobTokenIds)');
  }
  const d = Math.max(1, Math.min(50, Number.parseInt(depth, 10) || 10));
  const raw = await fetchJson(
    `${POLY_CLOB}/book?token_id=${encodeURIComponent(tokenId.trim())}`,
    "Polymarket CLOB",
  );
  const bids = Array.isArray(raw.bids) ? raw.bids : [];
  const asks = Array.isArray(raw.asks) ? raw.asks : [];
  // CLOB returns bids low→high; flip so top of book is index 0 (highest bid first).
  // Asks come low→high which is already correct (lowest ask = top of book).
  const topBids = [...bids].reverse().slice(0, d).map((b) => ({ price: asNumber(b.price), size: asNumber(b.size) }));
  const topAsks = asks.slice(0, d).map((a) => ({ price: asNumber(a.price), size: asNumber(a.size) }));
  const bestBid = topBids[0]?.price ?? null;
  const bestAsk = topAsks[0]?.price ?? null;
  return {
    tokenId: tokenId.trim(),
    market: raw.market ?? null,
    asset: raw.asset_id ?? null,
    timestamp: raw.timestamp ?? null,
    bestBid,
    bestAsk,
    midPrice: bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null,
    spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null,
    bids: topBids,
    asks: topAsks,
    source: "polymarket-clob",
  };
}

// ----------------------------------------------------------------------------
// 4. polymarket-price-history — historical odds for a market outcome
// ----------------------------------------------------------------------------
async function polymarketPriceHistory({ tokenId, interval, fidelity } = {}) {
  if (typeof tokenId !== "string" || !/^\d+$/.test(tokenId.trim())) {
    throw bad('"tokenId" is required (decimal-encoded CLOB token id string)');
  }
  const intervalAllowed = new Set(["1h", "6h", "1d", "1w", "1m", "max"]);
  const iv = typeof interval === "string" && intervalAllowed.has(interval) ? interval : "1d";
  const fi = Math.max(1, Math.min(720, Number.parseInt(fidelity, 10) || 60)); // minutes per sample
  const url = `${POLY_CLOB}/prices-history?market=${encodeURIComponent(tokenId.trim())}&interval=${iv}&fidelity=${fi}`;
  const raw = await fetchJson(url, "Polymarket CLOB");
  const history = Array.isArray(raw.history) ? raw.history : [];
  const points = history.map((p) => ({
    timestamp: p.t ?? null,
    price: asNumber(p.p),
  }));
  const prices = points.map((p) => p.price).filter((p) => p != null);
  return {
    tokenId: tokenId.trim(),
    interval: iv,
    fidelityMinutes: fi,
    count: points.length,
    min: prices.length ? Math.min(...prices) : null,
    max: prices.length ? Math.max(...prices) : null,
    first: points[0]?.price ?? null,
    last: points[points.length - 1]?.price ?? null,
    points,
    source: "polymarket-clob",
  };
}

// ----------------------------------------------------------------------------
// 5. kalshi-markets — list Kalshi markets, filterable by status/event
// ----------------------------------------------------------------------------
async function kalshiMarkets({ status, eventTicker, limit } = {}) {
  const lim = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 20));
  const params = new URLSearchParams({ limit: String(lim) });
  if (typeof status === "string" && status.trim()) {
    const allowed = new Set(["open", "closed", "settled", "unopened"]);
    if (!allowed.has(status.trim().toLowerCase())) {
      throw bad(`"status" must be one of ${[...allowed].join(", ")}`);
    }
    params.set("status", status.trim().toLowerCase());
  }
  if (typeof eventTicker === "string" && eventTicker.trim()) {
    params.set("event_ticker", eventTicker.trim().toUpperCase());
  }
  const raw = await fetchJson(`${KALSHI}/markets?${params}`, "Kalshi");
  const markets = Array.isArray(raw.markets) ? raw.markets.map(shapeKalshiMarket) : [];
  return {
    count: markets.length,
    cursor: raw.cursor ?? null,
    markets,
    source: "kalshi",
  };
}

// ----------------------------------------------------------------------------
// 6. kalshi-event — full detail for a Kalshi event (all its markets)
// ----------------------------------------------------------------------------
async function kalshiEvent({ eventTicker } = {}) {
  const t = typeof eventTicker === "string" ? eventTicker.trim().toUpperCase() : "";
  if (!t) throw bad('"eventTicker" is required (Kalshi event ticker, e.g. "PRES-24")');
  const raw = await fetchJson(
    `${KALSHI}/events/${encodeURIComponent(t)}?with_nested_markets=true`,
    "Kalshi",
  );
  const event = raw.event ?? raw;
  const markets = Array.isArray(event.markets) ? event.markets.map(shapeKalshiMarket) : [];
  return {
    eventTicker: event.event_ticker ?? t,
    title: event.title ?? null,
    subTitle: event.sub_title ?? null,
    seriesTicker: event.series_ticker ?? null,
    category: event.category ?? null,
    mutuallyExclusive: !!event.mutually_exclusive,
    marketCount: markets.length,
    markets,
    source: "kalshi",
  };
}

// ----------------------------------------------------------------------------
// Catalog
// ----------------------------------------------------------------------------
export const PREDICTION_MARKET_TOOLS = [
  {
    route: "POST /api/polymarket-search",
    name: "Polymarket search",
    slug: "polymarket-search",
    category: "crypto",
    price: "$0.002",
    description:
      "Search active Polymarket markets by keyword. Returns the top matches sorted by 24h volume, with question, current outcome prices (implied probabilities), volume, liquidity, end date, and CLOB token ids for orderbook lookups.",
    tags: ["polymarket", "prediction-market", "odds", "search", "betting"],
    discovery: {
      bodyType: "json",
      input: { query: "election", limit: 5 },
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Keyword to search market questions, slugs, and descriptions." },
          limit: { type: "number", description: "Max markets to return (1-50, default 10)." },
          activeOnly: { type: "boolean", description: "Filter to active+open markets only (default true)." },
        },
      },
      output: {
        example: {
          query: "election",
          count: 1,
          markets: [{
            id: "12345",
            slug: "will-x-win-election",
            question: "Will X win the election?",
            endDate: "2026-11-03T23:59:00Z",
            active: true,
            closed: false,
            volume: 1234567.89,
            outcomes: ["Yes", "No"],
            prices: [0.62, 0.38],
            clobTokenIds: ["7290..."],
            venue: "polymarket",
            venueUrl: "https://polymarket.com/market/will-x-win-election",
          }],
          source: "polymarket-gamma",
        },
      },
    },
    handler: polymarketSearch,
  },
  {
    route: "POST /api/polymarket-market",
    name: "Polymarket market detail",
    slug: "polymarket-market",
    category: "crypto",
    price: "$0.002",
    description:
      "Get full detail for a single Polymarket market by slug or id. Returns question, description, outcome prices (implied probabilities), volume, liquidity, end date, resolution status, and CLOB token ids needed for orderbook + history lookups.",
    tags: ["polymarket", "prediction-market", "market-detail", "odds"],
    discovery: {
      bodyType: "json",
      input: { slug: "will-x-win-election" },
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Market slug (one of slug/id required)." },
          id: { type: "string", description: "Numeric market id (one of slug/id required)." },
        },
      },
      output: {
        example: {
          id: "12345",
          slug: "will-x-win-election",
          question: "Will X win the election?",
          description: "Resolves YES if X is declared the winner by AP.",
          endDate: "2026-11-03T23:59:00Z",
          active: true,
          closed: false,
          archived: false,
          volume: 1234567.89,
          liquidity: 56789.01,
          outcomes: ["Yes", "No"],
          prices: [0.62, 0.38],
          clobTokenIds: ["7290...", "8390..."],
          eventSlug: "us-election-2026",
          venue: "polymarket",
          venueUrl: "https://polymarket.com/market/will-x-win-election",
        },
      },
    },
    handler: polymarketMarket,
  },
  {
    route: "POST /api/polymarket-orderbook",
    name: "Polymarket orderbook",
    slug: "polymarket-orderbook",
    category: "crypto",
    price: "$0.002",
    description:
      "Live CLOB orderbook for a Polymarket outcome token. Returns top N bids (highest first), top N asks (lowest first), best bid/ask, mid-price, and spread. Use a clobTokenId from polymarket-market or polymarket-search.",
    tags: ["polymarket", "orderbook", "bids-asks", "spread", "liquidity"],
    discovery: {
      bodyType: "json",
      input: { tokenId: "72909859729837290837290837290837290837290837290837290837290837290", depth: 5 },
      inputSchema: {
        type: "object",
        required: ["tokenId"],
        properties: {
          tokenId: { type: "string", description: "CLOB token id (decimal string) from market.clobTokenIds." },
          depth: { type: "number", description: "Levels each side to return (1-50, default 10)." },
        },
      },
      output: {
        example: {
          tokenId: "72909...",
          market: "0xabc...",
          asset: "72909...",
          timestamp: "1751234567",
          bestBid: 0.61,
          bestAsk: 0.63,
          midPrice: 0.62,
          spread: 0.02,
          bids: [{ price: 0.61, size: 1000 }, { price: 0.60, size: 500 }],
          asks: [{ price: 0.63, size: 800 }, { price: 0.64, size: 1200 }],
          source: "polymarket-clob",
        },
      },
    },
    handler: polymarketOrderbook,
  },
  {
    route: "POST /api/polymarket-price-history",
    name: "Polymarket price history",
    slug: "polymarket-price-history",
    category: "crypto",
    price: "$0.002",
    description:
      "Historical odds (implied probabilities) for a Polymarket outcome token. Returns timestamped price samples with first/last/min/max summary. Useful for: tracking probability shifts around events, computing realized volatility, backtesting prediction strategies.",
    tags: ["polymarket", "history", "odds-history", "time-series", "probability"],
    discovery: {
      bodyType: "json",
      input: { tokenId: "72909859729837290837290837290837290837290837290837290837290837290", interval: "1d" },
      inputSchema: {
        type: "object",
        required: ["tokenId"],
        properties: {
          tokenId: { type: "string", description: "CLOB token id (decimal string) from market.clobTokenIds." },
          interval: { type: "string", description: "Lookback window: 1h, 6h, 1d, 1w, 1m, max (default 1d)." },
          fidelity: { type: "number", description: "Sample granularity in minutes (1-720, default 60)." },
        },
      },
      output: {
        example: {
          tokenId: "72909...",
          interval: "1d",
          fidelityMinutes: 60,
          count: 24,
          min: 0.55,
          max: 0.67,
          first: 0.58,
          last: 0.62,
          points: [
            { timestamp: 1751200000, price: 0.58 },
            { timestamp: 1751203600, price: 0.59 },
          ],
          source: "polymarket-clob",
        },
      },
    },
    handler: polymarketPriceHistory,
  },
  {
    route: "POST /api/kalshi-markets",
    name: "Kalshi markets list",
    slug: "kalshi-markets",
    category: "crypto",
    price: "$0.002",
    description:
      "List Kalshi markets (CFTC-regulated US event contracts). Filter by status (open/closed/settled/unopened) or by event ticker. Returns yes/no bid/ask, last price, volume, open interest. Complement to Polymarket for US-regulated markets and Kalshi-only categories (weather, economic data).",
    tags: ["kalshi", "prediction-market", "regulated", "event-contracts", "cftc"],
    discovery: {
      bodyType: "json",
      input: { status: "open", limit: 5 },
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status: open, closed, settled, unopened." },
          eventTicker: { type: "string", description: "Filter to a specific event ticker." },
          limit: { type: "number", description: "Max markets (1-100, default 20)." },
        },
      },
      output: {
        example: {
          count: 1,
          cursor: "next-page-token",
          markets: [{
            ticker: "PRES-24-DEM",
            eventTicker: "PRES-24",
            title: "Will the Democratic nominee win?",
            subtitle: "2026 US Presidential election",
            status: "open",
            openTime: "2026-01-01T00:00:00Z",
            closeTime: "2026-11-03T23:59:00Z",
            yesBid: 0.45,
            yesAsk: 0.47,
            noBid: 0.53,
            noAsk: 0.55,
            lastPrice: 0.46,
            volume: 12345,
            openInterest: 5678,
            venue: "kalshi",
            venueUrl: "https://kalshi.com/markets/pres-24-dem",
          }],
          source: "kalshi",
        },
      },
    },
    handler: kalshiMarkets,
  },
  {
    route: "POST /api/kalshi-event",
    name: "Kalshi event detail",
    slug: "kalshi-event",
    category: "crypto",
    price: "$0.002",
    description:
      "Get full detail for a single Kalshi event with all its nested markets. Mutually-exclusive flag tells you whether the markets partition outcome space (e.g. one winner). Useful for: viewing all candidates in an election, all CPI ranges, all weather buckets.",
    tags: ["kalshi", "event", "prediction-market", "regulated"],
    discovery: {
      bodyType: "json",
      input: { eventTicker: "PRES-24" },
      inputSchema: {
        type: "object",
        required: ["eventTicker"],
        properties: {
          eventTicker: { type: "string", description: "Kalshi event ticker, e.g. PRES-24, CPI-25APR." },
        },
      },
      output: {
        example: {
          eventTicker: "PRES-24",
          title: "2026 US Presidential election",
          subTitle: "Who will win?",
          seriesTicker: "PRES",
          category: "Politics",
          mutuallyExclusive: true,
          marketCount: 2,
          markets: [{
            ticker: "PRES-24-DEM",
            eventTicker: "PRES-24",
            title: "Will the Democratic nominee win?",
            status: "open",
            yesBid: 0.45,
            yesAsk: 0.47,
            noBid: 0.53,
            noAsk: 0.55,
            lastPrice: 0.46,
            volume: 12345,
            openInterest: 5678,
            venue: "kalshi",
            venueUrl: "https://kalshi.com/markets/pres-24-dem",
          }],
          source: "kalshi",
        },
      },
    },
    handler: kalshiEvent,
  },
];

// Test-only exports
export const __test = {
  asNumber,
  parseJsonArray,
  shapeMarket,
  shapeKalshiMarket,
  POLY_GAMMA,
  POLY_CLOB,
  KALSHI,
};
