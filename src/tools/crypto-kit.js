// Crypto-kit — live market data for crypto, complementing finance-kit's
// equity coverage. Yahoo serves BTC-USD via /stock-quote but that's a single
// price point; this kit unlocks the richer crypto-native surface: 24h volume,
// market cap rank, historical OHLC, trending coins, and global market metrics.
//
// Upstream: CoinGecko's public API (api.coingecko.com/api/v3). Keyless,
// generous rate limits (~30 req/min from a single IP, no per-account cap),
// stable JSON shapes since 2018.
//
// CoinGecko quirk worth knowing: their canonical identifier is the slug-style
// `id` ("bitcoin", "ethereum"), not the ticker symbol ("BTC", "ETH"). Agents
// almost always reach for the symbol first, so this kit accepts either —
// resolving symbol → id via an embedded top-coins map. Unknown symbols fall
// through and let CoinGecko's 404 surface the error.
//
// safeFetch hardcodes the Agent402 UA, which CoinGecko's CDN accepts, but we
// use the same assertPublicUrl + native fetch pattern as finance-kit for
// consistency and to keep the per-host UA option open.
import { assertPublicUrl } from "./fetch-guard.js";
import { redactSecrets } from "./redact.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function cryptoUserAgent() {
  return (
    (process.env.CRYPTO_USER_AGENT || "").trim() ||
    "Mozilla/5.0 (compatible; Agent402/1.0; +https://agent402.tools)"
  );
}

// Symbol → CoinGecko id map for the top market-cap coins. This list deliberately
// covers high-volume tickers an agent is most likely to be asked about; anything
// outside this set must be passed as the canonical id (e.g. "render-token").
// CoinGecko's /coins/list has ~15k entries — embedding all of them bloats this
// file; if a use case demands it, a future `crypto-search` tool can wrap
// /search?query= instead.
const SYMBOL_TO_ID = {
  BTC: "bitcoin", ETH: "ethereum", USDT: "tether", BNB: "binancecoin",
  SOL: "solana", USDC: "usd-coin", XRP: "ripple", DOGE: "dogecoin",
  ADA: "cardano", TRX: "tron", AVAX: "avalanche-2", SHIB: "shiba-inu",
  TON: "the-open-network", DOT: "polkadot", LINK: "chainlink", MATIC: "matic-network",
  BCH: "bitcoin-cash", LTC: "litecoin", ICP: "internet-computer", LEO: "leo-token",
  DAI: "dai", UNI: "uniswap", ETC: "ethereum-classic", KAS: "kaspa",
  ATOM: "cosmos", XLM: "stellar", XMR: "monero", APT: "aptos",
  FIL: "filecoin", OKB: "okb", HBAR: "hedera-hashgraph", NEAR: "near",
  CRO: "crypto-com-chain", VET: "vechain", ARB: "arbitrum", MNT: "mantle",
  GRT: "the-graph", AAVE: "aave", OP: "optimism", ALGO: "algorand",
  RNDR: "render-token", IMX: "immutable-x", QNT: "quant-network", MKR: "maker",
  STX: "blockstack", INJ: "injective-protocol", FTM: "fantom", FLOW: "flow",
  SUI: "sui", PEPE: "pepe",
};

// Accept either an id ("bitcoin") or a symbol ("BTC"). Symbols go uppercase and
// look up in SYMBOL_TO_ID; unrecognised symbols fall through as-is and let
// CoinGecko 404 (which we map to 422). IDs go lowercase — that's CoinGecko's
// convention. Restrict to a defensive whitelist; CoinGecko ids are slug-style
// (alphanumeric + hyphen).
function resolveCoinId(raw) {
  if (typeof raw !== "string") throw bad('"coin" is required (e.g. "BTC", "bitcoin")');
  const s = raw.trim();
  if (!s) throw bad('"coin" is required');
  if (s.length > 64) throw bad('"coin" too long');
  if (!/^[A-Za-z0-9-]+$/.test(s)) throw bad('"coin" must be alphanumeric + hyphens (e.g. "bitcoin" or "BTC")');
  const upper = s.toUpperCase();
  if (SYMBOL_TO_ID[upper]) return SYMBOL_TO_ID[upper];
  return s.toLowerCase();
}

// CoinGecko's /simple/price accepts a comma-separated list. Resolve each entry
// independently so an agent can mix symbols and ids in one call.
function resolveCoinList(raw, max = 25) {
  if (typeof raw !== "string") throw bad('"coins" is required (comma-separated, e.g. "BTC,ETH,SOL")');
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) throw bad('"coins" is empty');
  if (items.length > max) throw bad(`"coins" must contain at most ${max} entries (got ${items.length})`);
  return items.map(resolveCoinId);
}

// vs_currency for CoinGecko — fiat or crypto. Most agents will use "usd"; we
// accept anything CoinGecko supports (their /simple/supported_vs_currencies
// list has ~60 entries) and let upstream reject invalid ones with 400.
function normalizeCurrency(raw, dflt = "usd") {
  if (raw == null || raw === "") return dflt;
  if (typeof raw !== "string") throw bad('"currency" must be a string');
  const s = raw.trim().toLowerCase();
  if (!/^[a-z0-9]{2,8}$/.test(s)) throw bad('"currency" must be a 2-8 char alphanumeric code (e.g. "usd", "eur", "btc")');
  return s;
}

async function jsonGet(url, host = "CoinGecko") {
  const safeUrl = await assertPublicUrl(url);
  // CoinGecko Demo key (env-gated; keyless works too, just worse): keyless
  // requests are rate-limited PER IP — and Railway egress IPs are shared, so
  // the effective quota is whatever other tenants left. A key moves metering
  // to our own ~30 req/min quota. Gated to CoinGecko hosts only: this shared
  // helper also hits Coinbase Exchange (crypto-orderbook), and the key must
  // never ride a request to another host.
  const cgKey = process.env.COINGECKO_API_KEY;
  const sendCgKey = Boolean(cgKey) && safeUrl.hostname.toLowerCase().includes("coingecko");
  const attempt = (timeout) =>
    fetch(safeUrl, {
      headers: {
        "User-Agent": cryptoUserAgent(),
        Accept: "application/json",
        ...(sendCgKey ? { "x-cg-demo-api-key": cgKey.trim() } : {}),
      },
      signal: AbortSignal.timeout(timeout),
    });
  let res;
  try {
    res = await attempt(10000);
  } catch (e) {
    // Single retry on network/timeout failure (same pattern as finance-kit).
    try {
      res = await attempt(12000);
    } catch (e2) {
      throw bad(`${host} request failed: ${e2.message}`, 504);
    }
  }
  // Retry once on 429/5xx after a short backoff. CoinGecko burst-limits per
  // IP; a chained skill pack (crypto-dossier: price → history → trending →
  // global) fires four CG calls in ~3s and the fourth intermittently 429s —
  // the backoff clears the burst window without threatening the pack's
  // overall time budget. (finance-kit/gov-kit carry the same 5xx retry.)
  if (res.status === 429 || res.status >= 500) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const retryRes = await attempt(12000);
      if (retryRes.ok || retryRes.status !== res.status) res = retryRes;
    } catch { /* fall through with the original response */ }
  }
  const text = await res.text();
  if (!res.ok) {
    const s = res.status;
    if (s === 404) throw bad(`${host} returned 404 - unknown coin or market`, 422);
    if (s === 429) throw bad(`${host} rate-limited the request - retry shortly`, 503);
    if (s >= 500) throw bad(`${host} upstream HTTP ${s} - try again later`, 502);
    // Redact the FULL upstream body before slicing (a secret straddling the
    // 200-char cut would otherwise leave an unredactable prefix): the CoinGecko
    // demo key rides this request and there is no 401/403 shield above.
    throw bad(`${host} HTTP ${s}: ${redactSecrets(text).slice(0, 200)}`, 422);
  }
  try { return JSON.parse(text); }
  catch { throw bad(`${host} returned non-JSON response`, 502); }
}

const CG = "https://api.coingecko.com/api/v3";

export const CRYPTO_TOOLS = [
  {
    route: "GET /api/crypto-price",
    name: "Crypto price",
    slug: "crypto-price",
    category: "data",
    price: "$0.010",
    description:
      "Live crypto prices for one or many coins in any vs_currency (usd, eur, btc, eth, etc). Returns last price, 24h change %, 24h volume, and market cap per coin. The simplest crypto price read - for ranked market-cap tables use crypto-market, for candles use crypto-history, and when you need an oracle-grade price with a confidence interval use price-pyth. Accepts ticker symbols (BTC, ETH, SOL) for the top ~50 by market cap, or canonical CoinGecko ids (e.g. \"render-token\") for any of the ~15k tracked coins. Batched: up to 25 coins per call. Backed by CoinGecko's public API - keyless.",
    tags: ["crypto", "price", "market-data", "bitcoin", "ethereum", "defi"],
    discovery: {
      input: { coins: "BTC,ETH,SOL", currency: "usd" },
      inputSchema: {
        properties: {
          coins: { type: "string", description: "Comma-separated symbols or ids (e.g. \"BTC,ETH\" or \"bitcoin,ethereum\"). Max 25." },
          currency: { type: "string", description: "vs_currency (default: usd). Accepts fiat (usd, eur, gbp, jpy) or crypto (btc, eth)." },
        },
        required: ["coins"],
      },
      output: {
        example: {
          currency: "usd",
          count: 3,
          coins: {
            bitcoin: { price: 67234.12, change24hPct: 1.42, volume24h: 28100000000, marketCap: 1320000000000, lastUpdated: "2026-06-20T00:30:00Z" },
            ethereum: { price: 3520.45, change24hPct: 2.18, volume24h: 14200000000, marketCap: 423000000000, lastUpdated: "2026-06-20T00:30:00Z" },
            solana:   { price: 148.20, change24hPct: -0.65, volume24h: 2400000000, marketCap: 68000000000, lastUpdated: "2026-06-20T00:30:00Z" },
          },
        },
      },
    },
    handler: async (i) => {
      const ids = resolveCoinList(i.coins, 25);
      const currency = normalizeCurrency(i.currency);
      const url = `${CG}/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=${encodeURIComponent(currency)}&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true`;
      const data = await jsonGet(url);
      // CoinGecko's response shape is { id: { usd: 123, usd_24h_change: 1.4, ... } }.
      // Flatten to { id: { price, change24hPct, volume24h, marketCap } } so the
      // currency key doesn't have to be parsed by the caller.
      const out = {};
      for (const id of ids) {
        const row = data[id];
        if (!row) continue; // unknown id → silently absent; better than failing the batch
        out[id] = {
          price: row[currency] ?? null,
          change24hPct: row[`${currency}_24h_change`] != null ? +row[`${currency}_24h_change`].toFixed(4) : null,
          volume24h: row[`${currency}_24h_vol`] ?? null,
          marketCap: row[`${currency}_market_cap`] ?? null,
          lastUpdated: row.last_updated_at ? new Date(row.last_updated_at * 1000).toISOString() : null,
        };
      }
      return { currency, count: Object.keys(out).length, coins: out };
    },
  },

  {
    route: "GET /api/crypto-market",
    name: "Crypto market overview",
    slug: "crypto-market",
    category: "data",
    price: "$0.015",
    description:
      "Top N coins by market capitalization with full market snapshot per coin: rank, price, 24h change, 7d change, 24h volume, market cap, circulating supply, and all-time high. Default 10, max 100 per call. Backed by CoinGecko's public API.",
    tags: ["crypto", "market", "ranking", "marketcap", "top-coins"],
    discovery: {
      input: { limit: 10, currency: "usd" },
      inputSchema: {
        properties: {
          limit: { type: "number", description: "Number of coins to return (1-100, default 10)" },
          currency: { type: "string", description: "vs_currency (default: usd)" },
        },
      },
      output: {
        example: {
          currency: "usd",
          count: 2,
          coins: [
            { rank: 1, id: "bitcoin", symbol: "btc", name: "Bitcoin", price: 67234.12, change24hPct: 1.42, change7dPct: 4.81, volume24h: 28100000000, marketCap: 1320000000000, circulatingSupply: 19700000, ath: 73750, athDate: "2024-03-14T07:10:36Z" },
            { rank: 2, id: "ethereum", symbol: "eth", name: "Ethereum", price: 3520.45, change24hPct: 2.18, change7dPct: 1.92, volume24h: 14200000000, marketCap: 423000000000, circulatingSupply: 120300000, ath: 4878.26, athDate: "2021-11-10T14:24:11Z" },
          ],
        },
      },
    },
    handler: async (i) => {
      const limit = Number.isFinite(i.limit) ? Math.floor(i.limit) : (typeof i.limit === "string" ? parseInt(i.limit, 10) : 10);
      if (!Number.isFinite(limit) || limit < 1 || limit > 100) throw bad('"limit" must be an integer 1-100');
      const currency = normalizeCurrency(i.currency);
      const url = `${CG}/coins/markets?vs_currency=${encodeURIComponent(currency)}&order=market_cap_desc&per_page=${limit}&page=1&price_change_percentage=24h,7d`;
      const data = await jsonGet(url);
      if (!Array.isArray(data)) throw bad("CoinGecko returned unexpected shape for /coins/markets", 502);
      const coins = data.map((c) => ({
        rank: c.market_cap_rank ?? null,
        id: c.id,
        symbol: c.symbol,
        name: c.name,
        price: c.current_price ?? null,
        change24hPct: c.price_change_percentage_24h_in_currency != null ? +c.price_change_percentage_24h_in_currency.toFixed(4) : null,
        change7dPct: c.price_change_percentage_7d_in_currency != null ? +c.price_change_percentage_7d_in_currency.toFixed(4) : null,
        volume24h: c.total_volume ?? null,
        marketCap: c.market_cap ?? null,
        circulatingSupply: c.circulating_supply ?? null,
        ath: c.ath ?? null,
        athDate: c.ath_date ?? null,
      }));
      return { currency, count: coins.length, coins };
    },
  },

  {
    route: "GET /api/crypto-history",
    name: "Crypto price history",
    slug: "crypto-history",
    category: "data",
    price: "$0.015",
    description:
      "Historical price, market cap, and volume time series for a coin. Granularity is automatic per CoinGecko: <=1 day = 5-min bars, 2-90 days = hourly, >90 days = daily. Days: 1, 7, 14, 30, 90, 180, 365, or \"max\". Returns aligned arrays of {time, price, marketCap, volume}.",
    tags: ["crypto", "history", "chart", "backtest", "timeseries"],
    discovery: {
      input: { coin: "BTC", days: "7", currency: "usd" },
      inputSchema: {
        properties: {
          coin: { type: "string", description: "Symbol (BTC) or id (bitcoin)" },
          days: { type: "string", description: "1, 7, 14, 30, 90, 180, 365, or \"max\" (default 7)" },
          currency: { type: "string", description: "vs_currency (default: usd)" },
        },
        required: ["coin"],
      },
      output: {
        example: {
          coin: "bitcoin",
          currency: "usd",
          days: "7",
          count: 1,
          bars: [
            { time: "2026-06-13T00:00:00Z", price: 66120.45, marketCap: 1298000000000, volume: 27400000000 },
          ],
        },
      },
    },
    handler: async (i) => {
      const id = resolveCoinId(i.coin);
      const currency = normalizeCurrency(i.currency);
      const daysRaw = i.days == null || i.days === "" ? "7" : String(i.days).trim();
      // CoinGecko accepts an integer string or the literal "max". Anything else
      // is an agent-input bug — reject before burning the round-trip.
      if (daysRaw !== "max" && !/^\d+$/.test(daysRaw)) throw bad('"days" must be a positive integer or "max"');
      if (daysRaw !== "max" && (parseInt(daysRaw, 10) < 1 || parseInt(daysRaw, 10) > 3650)) throw bad('"days" out of range (1-3650 or "max")');
      const url = `${CG}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=${encodeURIComponent(currency)}&days=${encodeURIComponent(daysRaw)}`;
      const data = await jsonGet(url);
      const prices = Array.isArray(data?.prices) ? data.prices : [];
      const caps = Array.isArray(data?.market_caps) ? data.market_caps : [];
      const vols = Array.isArray(data?.total_volumes) ? data.total_volumes : [];
      // CoinGecko emits the three arrays with the same length and aligned ms
      // timestamps. Zip them by index — safer than zipping by timestamp since
      // a single skipped bar would shift the whole series silently.
      const bars = prices.map(([t, price], idx) => ({
        time: new Date(t).toISOString(),
        price,
        marketCap: caps[idx]?.[1] ?? null,
        volume: vols[idx]?.[1] ?? null,
      }));
      return { coin: id, currency, days: daysRaw, count: bars.length, bars };
    },
  },

  {
    route: "GET /api/crypto-trending",
    name: "Crypto trending",
    slug: "crypto-trending",
    category: "data",
    price: "$0.008",
    description:
      "Trending coins on CoinGecko in the last 24 hours, ranked by user search activity on the site (currently ~15 results). Includes coin id, symbol, market cap rank, current price (BTC-denominated), and score. Useful signal for detecting narrative shifts before they hit price charts.",
    tags: ["crypto", "trending", "discovery", "sentiment"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: {
        example: {
          count: 2,
          coins: [
            { id: "render-token", symbol: "RNDR", name: "Render", marketCapRank: 38, priceBtc: 0.00012345, score: 0 },
            { id: "sui", symbol: "SUI", name: "Sui", marketCapRank: 22, priceBtc: 0.00003421, score: 1 },
          ],
        },
      },
    },
    handler: async () => {
      const data = await jsonGet(`${CG}/search/trending`);
      const items = Array.isArray(data?.coins) ? data.coins : [];
      const coins = items.map((entry) => {
        const c = entry?.item ?? {};
        return {
          id: c.id ?? null,
          symbol: (c.symbol || "").toUpperCase() || null,
          name: c.name ?? null,
          marketCapRank: c.market_cap_rank ?? null,
          priceBtc: typeof c.price_btc === "number" ? c.price_btc : (c.price_btc != null ? Number(c.price_btc) : null),
          score: c.score ?? null,
        };
      });
      return { count: coins.length, coins };
    },
  },

  {
    route: "GET /api/crypto-global",
    name: "Crypto global market",
    slug: "crypto-global",
    category: "data",
    price: "$0.008",
    description:
      "Global crypto market snapshot: total market cap, total 24h volume, BTC dominance, ETH dominance, active coin count, active exchange count, and 24h market-cap change %. Returned in a chosen vs_currency (default usd). Backed by CoinGecko /global.",
    tags: ["crypto", "global", "market", "dominance", "macro"],
    discovery: {
      input: { currency: "usd" },
      inputSchema: {
        properties: {
          currency: { type: "string", description: "vs_currency for cap/volume (default: usd)" },
        },
      },
      output: {
        example: {
          currency: "usd",
          totalMarketCap: 2410000000000,
          totalVolume24h: 92000000000,
          marketCapChange24hPct: 1.23,
          btcDominancePct: 54.8,
          ethDominancePct: 17.6,
          activeCryptocurrencies: 12450,
          markets: 952,
          updatedAt: "2026-06-20T00:30:00Z",
        },
      },
    },
    handler: async (i) => {
      const currency = normalizeCurrency(i.currency);
      const data = await jsonGet(`${CG}/global`);
      const d = data?.data;
      if (!d) throw bad("CoinGecko returned unexpected shape for /global", 502);
      // total_market_cap and total_volume are objects keyed by currency.
      // If a caller asks for an unsupported one, surface null rather than
      // silently picking another currency.
      const cap = d.total_market_cap?.[currency];
      const vol = d.total_volume?.[currency];
      return {
        currency,
        totalMarketCap: cap != null ? +cap : null,
        totalVolume24h: vol != null ? +vol : null,
        marketCapChange24hPct: d.market_cap_change_percentage_24h_usd != null ? +d.market_cap_change_percentage_24h_usd.toFixed(4) : null,
        btcDominancePct: d.market_cap_percentage?.btc != null ? +d.market_cap_percentage.btc.toFixed(4) : null,
        ethDominancePct: d.market_cap_percentage?.eth != null ? +d.market_cap_percentage.eth.toFixed(4) : null,
        activeCryptocurrencies: d.active_cryptocurrencies ?? null,
        markets: d.markets ?? null,
        updatedAt: d.updated_at ? new Date(d.updated_at * 1000).toISOString() : null,
      };
    },
  },

  {
    route: "GET /api/crypto-orderbook",
    name: "Crypto order book",
    slug: "crypto-orderbook",
    category: "crypto",
    price: "$0.001",
    description:
      "L2 order-book snapshot for a spot pair: best bid/ask, mid price, spread (absolute + %), and the top N aggregated price levels per side (default 25, max 100). Pairs use BASE-QUOTE format (BTC-USD, ETH-USD, SOL-USDC). Backed by Coinbase Exchange's public market-data API - keyless; coverage is Coinbase-listed markets.",
    tags: ["crypto", "orderbook", "depth", "spread", "trading", "market-data"],
    discovery: {
      input: { pair: "BTC-USD" },
      inputSchema: {
        properties: {
          pair: { type: "string", description: "Spot pair as BASE-QUOTE (e.g. BTC-USD, ETH-USD, SOL-USDC)" },
          depth: { type: "number", description: "Price levels per side to return (1-100, default 25)" },
        },
        required: ["pair"],
      },
      output: {
        example: {
          pair: "BTC-USD",
          time: "2026-07-14T02:40:51Z",
          sequence: 132601080491,
          bestBid: 62489.29,
          bestAsk: 62490.01,
          midPrice: 62489.65,
          spread: 0.72,
          spreadPct: 0.0012,
          bids: [{ price: 62489.29, size: 0.81109777, orders: 8 }],
          asks: [{ price: 62490.01, size: 0.5, orders: 3 }],
          depth: 1,
          totalBidLevels: 15653,
          totalAskLevels: 27473,
        },
      },
    },
    handler: async (i) => {
      if (typeof i.pair !== "string" || !i.pair.trim()) throw bad('"pair" is required (e.g. "BTC-USD")');
      const pair = i.pair.trim().toUpperCase().replace("/", "-");
      if (!/^[A-Z0-9]{2,12}-[A-Z0-9]{2,12}$/.test(pair)) throw bad('"pair" must be BASE-QUOTE (e.g. "BTC-USD", "ETH-USDC")');
      let depth = 25;
      if (i.depth != null && i.depth !== "") {
        depth = Number.isFinite(i.depth) ? Math.floor(i.depth) : parseInt(String(i.depth), 10);
        if (!Number.isFinite(depth) || depth < 1 || depth > 100) throw bad('"depth" must be an integer 1-100');
      }
      // level=2 returns the FULL aggregated book (tens of thousands of levels
      // for BTC-USD) — we slice server-side so agents get a bounded payload.
      const data = await jsonGet(`https://api.exchange.coinbase.com/products/${encodeURIComponent(pair)}/book?level=2`, "Coinbase Exchange");
      if (!Array.isArray(data?.bids) || !Array.isArray(data?.asks)) throw bad("Coinbase Exchange returned unexpected shape for the order book", 502);
      // Levels arrive as [price, size, numOrders] string triples, best-first.
      //
      // The ELEMENTS are checked, not just the enclosing arrays. Destructuring
      // a level that is not an array (null, or an object shape) throws a
      // TypeError, which leaves the handler as an unmapped 500 - i.e. an
      // upstream sending something unexpected gets reported as OUR server
      // erroring. Every other upstream condition in this kit maps to 502/503/
      // 504/422; this was the one path that did not, and a 500 both misreports
      // whose fault it is and is the shape a caller cannot act on.
      const mapLevel = (lvl) => {
        if (!Array.isArray(lvl)) throw bad("Coinbase Exchange returned an unexpected order-book level shape", 502);
        const [price, size, orders] = lvl;
        return { price: +price, size: +size, orders: orders ?? null };
      };
      const bids = data.bids.slice(0, depth).map(mapLevel);
      const asks = data.asks.slice(0, depth).map(mapLevel);
      const bestBid = bids[0]?.price ?? null;
      const bestAsk = asks[0]?.price ?? null;
      const mid = bestBid != null && bestAsk != null ? +((bestBid + bestAsk) / 2).toFixed(8) : null;
      const spread = bestBid != null && bestAsk != null ? +(bestAsk - bestBid).toFixed(8) : null;
      const spreadPct = spread != null && mid ? +((spread / mid) * 100).toFixed(6) : null;
      return {
        pair,
        time: data.time ?? null,
        sequence: data.sequence ?? null,
        bestBid,
        bestAsk,
        midPrice: mid,
        spread,
        spreadPct,
        bids,
        asks,
        depth,
        totalBidLevels: data.bids.length,
        totalAskLevels: data.asks.length,
      };
    },
  },

  {
    route: "GET /api/stablecoin-peg",
    name: "Stablecoin peg monitor",
    slug: "stablecoin-peg",
    category: "crypto",
    price: "$0.003",
    description:
      "Live $1-peg deviation for the top USD stablecoins (USDT, USDC, USDS, DAI, USDe, PYUSD, USDD, TUSD, FDUSD by default, or pass your own list): current price, deviation in basis points, 24h high/low, worst 24h deviation, market cap, and an on-peg / stressed / depegged status. Backed by CoinGecko's public API.",
    tags: ["crypto", "stablecoin", "peg", "usdt", "usdc", "risk", "monitoring"],
    discovery: {
      input: {},
      inputSchema: {
        properties: {
          coins: { type: "string", description: "Optional comma-separated symbols or CoinGecko ids to check instead of the default top-stablecoin set (e.g. \"USDT,USDC\"). Max 15." },
        },
      },
      output: {
        example: {
          peg: "USD $1.00",
          count: 2,
          coins: [
            { id: "tether", symbol: "USDT", name: "Tether", price: 0.998868, deviationBps: -11.32, high24h: 0.999372, low24h: 0.998674, maxDeviation24hBps: 13.26, marketCap: 184092462233, status: "on-peg" },
            { id: "usd-coin", symbol: "USDC", name: "USDC", price: 0.999819, deviationBps: -1.81, high24h: 0.999923, low24h: 0.99953, maxDeviation24hBps: 4.7, marketCap: 73033499074, status: "on-peg" },
          ],
        },
      },
    },
    handler: async (i) => {
      // Default set: the top USD stablecoins by market cap (ids verified live).
      const DEFAULT_STABLECOINS = [
        "tether", "usd-coin", "usds", "dai", "ethena-usde",
        "paypal-usd", "usdd", "true-usd", "first-digital-usd",
      ];
      const ids = i.coins != null && i.coins !== "" ? resolveCoinList(i.coins, 15) : DEFAULT_STABLECOINS;
      const url = `${CG}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids.join(","))}&order=market_cap_desc`;
      const data = await jsonGet(url);
      if (!Array.isArray(data)) throw bad("CoinGecko returned unexpected shape for /coins/markets", 502);
      if (data.length === 0) throw bad("No CoinGecko data for the requested coins - check the ids/symbols", 422);
      const bps = (p) => (typeof p === "number" ? +((p - 1) * 10000).toFixed(2) : null);
      const coins = data.map((c) => {
        const dev = bps(c.current_price);
        // Worst 24h deviation from the high/low extremes. When BOTH source
        // fields are missing this is null (unknown), not 0.00 — a fabricated
        // "perfect peg" is worse than no answer. One-sided data still yields
        // the max of the available side.
        const hiDev = bps(c.high_24h);
        const loDev = bps(c.low_24h);
        const worst = hiDev == null && loDev == null ? null : Math.max(Math.abs(hiDev ?? 0), Math.abs(loDev ?? 0));
        // Deterministic bands: within ±50bps ($0.995-1.005) = on-peg, within
        // ±200bps = stressed, beyond = depegged.
        const status = dev == null ? "unknown" : Math.abs(dev) <= 50 ? "on-peg" : Math.abs(dev) <= 200 ? "stressed" : "depegged";
        return {
          id: c.id,
          symbol: (c.symbol || "").toUpperCase() || null,
          name: c.name ?? null,
          price: c.current_price ?? null,
          deviationBps: dev,
          high24h: c.high_24h ?? null,
          low24h: c.low_24h ?? null,
          maxDeviation24hBps: worst == null ? null : +worst.toFixed(2),
          marketCap: c.market_cap ?? null,
          status,
        };
      });
      return { peg: "USD $1.00", count: coins.length, coins };
    },
  },
];
