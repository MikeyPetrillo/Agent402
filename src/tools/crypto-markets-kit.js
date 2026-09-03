// Crypto-markets-kit: the CoinGecko market-data surface that crypto-kit and
// price-feed-kit do NOT already cover. Those kits own simple/price
// (crypto-price, price-coingecko), coins/markets (crypto-market,
// stablecoin-peg), coins/{id}/market_chart by days (crypto-history),
// search/trending (crypto-trending) and /global (crypto-global). This kit adds
// the rest of the public catalog: token prices by contract address, a coin's
// profile, a dated snapshot, OHLC candles, an arbitrary unix time window,
// categories, the DeFi global slice, exchanges + their tickers, BTC-based
// exchange rates, full-text search and the full coin list with platform
// contracts. Same slug-style ids as the rest of the catalog.
//
// Upstream: api.coingecko.com/api/v3 (fixed host; every caller-supplied value
// rides as an encoded path segment or query parameter, never a URL). The Demo
// API key (`COINGECKO_API_KEY`, read at call time, sent as
// `x-cg-demo-api-key`) moves metering from a shared per-IP bucket to our own
// quota: 30 calls/min, 10k calls/month. That monthly budget is the reason
// every response is cached in-process (60s for prices, 5 min for lists and
// profiles, 10 min for the coin list): a second identical call inside the
// window costs the buyer the same and costs the quota nothing. Live-verified
// 2026-08-22: every endpoint below answers on the Demo plan; the
// gainers/losers endpoint is paid-plan only (401, error 10005) and is not
// offered; history/ohlc/range are limited to the past 365 days on this plan
// (401, error 10012), which the handlers enforce locally so a buyer gets a
// 400 with the rule instead of a wasted round-trip.
//
// Error mapping (never relays an upstream body): 404 / unknown id -> 422,
// 429 -> 503 with a retry hint, 5xx -> 502, 401/403 -> 422 (plan limit),
// timeout/network -> 504. Every result carries `source` + `fetchedAt` (the
// time the upstream answer was fetched, so a cached answer says so).

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export const CG_BASE = "https://api.coingecko.com/api/v3";
const SOURCE = "coingecko";
const TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = 1500;

// --- in-process response cache ------------------------------------------------
// Keyed by the full upstream URL (which encodes every input that changes the
// answer). Bounded: oldest entries drop past MAX_ENTRIES. Values are the parsed
// JSON plus the fetch time; handlers project from the cached object every time,
// never mutate it.
const TTL = Object.freeze({ price: 60_000, list: 300_000, coinList: 600_000 });
const MAX_ENTRIES = 256;
const cache = new Map();

export function clearCryptoMarketsCache() { cache.clear(); }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) { cache.delete(key); return null; }
  return hit;
}

function cachePut(key, data, ttlMs) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const fetchedAt = new Date().toISOString();
  cache.set(key, { data, fetchedAt, expiresAt: Date.now() + ttlMs });
  return { data, fetchedAt, cached: false };
}

function userAgent() {
  return (process.env.CRYPTO_USER_AGENT || "").trim() || "Mozilla/5.0 (compatible; Agent402/1.0; +https://agent402.tools)";
}

function headers() {
  const key = (process.env.COINGECKO_API_KEY || "").trim();
  return {
    "User-Agent": userAgent(),
    Accept: "application/json",
    ...(key ? { "x-cg-demo-api-key": key } : {}),
  };
}

// One upstream GET with the cache in front. `ttlMs` picks the cache class.
// Returns { data, fetchedAt, cached }.
// Demo plan allows 30 requests a minute for the whole deployment, so paid
// traffic has to be paced here rather than discovered at the upstream 429. A
// caller that arrives with an empty bucket gets 503 (capacity) and is not
// charged; a cache hit never takes a token.
const cgRatePerMin = () => Math.max(1, parseInt(process.env.COINGECKO_MAX_PER_MIN || "25", 10) || 25);
let cgTokens = null, cgRefilledAt = 0;
function takeCgToken(now) {
  const cap = cgRatePerMin();
  if (cgTokens === null) { cgTokens = cap; cgRefilledAt = now; }
  const elapsed = now - cgRefilledAt;
  if (elapsed > 0) {
    cgTokens = Math.min(cap, cgTokens + (elapsed / 60_000) * cap);
    cgRefilledAt = now;
  }
  if (cgTokens < 1) return false;
  cgTokens -= 1;
  return true;
}
/** Test seam: refill the bucket (offline suites make dozens of stubbed calls). */
export function resetCgRateLimit() { cgTokens = null; cgRefilledAt = 0; }

async function cgGet(path, params, ttlMs) {
  const url = new URL(CG_BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  const key = url.toString();
  const hit = cacheGet(key);
  if (hit) return { data: hit.data, fetchedAt: hit.fetchedAt, cached: true };

  if (!takeCgToken(Date.now())) throw bad("Market data is rate limited right now, retry in a few seconds. You were not charged.", 503);
  const attempt = () => fetch(key, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  let res;
  try {
    res = await attempt();
  } catch (e) {
    throw bad(`Market data upstream unreachable: ${e?.name === "TimeoutError" ? "timed out" : "network error"}`, 504);
  }
  // One retry on 429/5xx after a short backoff: the Demo bucket is 30/min and
  // a chained agent call can brush it; a second failure of the same class maps
  // below.
  if (res.status === 429 || res.status >= 500) {
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    try {
      const again = await attempt();
      if (again.ok || again.status !== res.status) res = again;
    } catch { /* keep the first response */ }
  }
  if (!res.ok) {
    const s = res.status;
    if (s === 404) throw bad("Unknown id: the coin, exchange or platform is not tracked upstream", 422);
    if (s === 429) throw bad("Market data upstream rate-limited this request (30/min shared budget) - retry in about 60 seconds", 503);
    if (s === 401 || s === 403) throw bad("Market data upstream refused the request: outside the plan's allowed range (history is limited to the past 365 days) or an endpoint this plan does not serve", 422);
    if (s >= 500) throw bad(`Market data upstream HTTP ${s} - try again later`, 502);
    throw bad(`Market data upstream rejected the request (HTTP ${s}) - check the inputs`, 422);
  }
  let data;
  try { data = await res.json(); }
  catch { throw bad("Market data upstream returned non-JSON", 502); }
  return cachePut(key, data, ttlMs);
}

// --- input helpers --------------------------------------------------------------
const ID_RE = /^[a-z0-9][a-z0-9-_.]{0,99}$/i;

function takeId(raw, field, { required = true } = {}) {
  if (raw == null || raw === "") {
    if (required) throw bad(`"${field}" is required (slug-style id, e.g. "bitcoin")`);
    return null;
  }
  if (typeof raw !== "string") throw bad(`"${field}" must be a string`);
  const s = raw.trim().toLowerCase();
  if (!ID_RE.test(s)) throw bad(`"${field}" must be a slug-style id (letters, digits, hyphens; max 100 chars)`);
  return s;
}

function takeCurrency(raw, dflt = "usd") {
  if (raw == null || raw === "") return dflt;
  if (typeof raw !== "string") throw bad('"currency" must be a string');
  const s = raw.trim().toLowerCase();
  if (!/^[a-z0-9]{2,8}$/.test(s)) throw bad('"currency" must be a 2-8 char code (usd, eur, btc, eth)');
  return s;
}

function takeInt(raw, field, { min, max, dflt }) {
  if (raw == null || raw === "") return dflt;
  const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^-?\d+$/.test(raw.trim()) ? parseInt(raw, 10) : NaN);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`"${field}" must be an integer ${min}-${max}`);
  return n;
}

function takeBool(raw, dflt = false) {
  if (raw == null || raw === "") return dflt;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  throw bad("boolean fields accept true/false");
}

// Comma-separated or array list of slug-style ids.
function takeIdList(raw, field, max) {
  const items = Array.isArray(raw) ? raw : (typeof raw === "string" ? raw.split(",") : null);
  if (!items) throw bad(`"${field}" is required (comma-separated list or array)`);
  const out = [];
  for (const x of items) {
    if (typeof x !== "string") throw bad(`"${field}" entries must be strings`);
    const s = x.trim().toLowerCase();
    if (!s) continue;
    if (!ID_RE.test(s)) throw bad(`"${field}" entry "${x.slice(0, 40)}" is not a valid id`);
    out.push(s);
  }
  if (out.length === 0) throw bad(`"${field}" is empty`);
  if (out.length > max) throw bad(`"${field}" must contain at most ${max} entries (got ${out.length})`);
  return out;
}

// Contract addresses: EVM hex, Solana/base58, Algorand base32, Hedera 0.0.x,
// Stellar issuer forms all fit "printable, no whitespace, <= 128 chars".
const CONTRACT_RE = /^[A-Za-z0-9._:\-]{3,128}$/;
function takeContracts(raw, max = 25) {
  const items = Array.isArray(raw) ? raw : (typeof raw === "string" ? raw.split(",") : null);
  if (!items) throw bad('"contracts" is required (comma-separated contract addresses or an array)');
  const out = [];
  for (const x of items) {
    if (typeof x !== "string") throw bad('"contracts" entries must be strings');
    const s = x.trim();
    if (!s) continue;
    if (!CONTRACT_RE.test(s)) throw bad(`"contracts" entry "${s.slice(0, 40)}" is not a valid contract address`);
    out.push(s);
  }
  if (out.length === 0) throw bad('"contracts" is empty');
  if (out.length > max) throw bad(`"contracts" must contain at most ${max} entries (got ${out.length})`);
  return out;
}

const DAY_MS = 86_400_000;
const MAX_HISTORY_DAYS = 365; // Demo-plan window, enforced locally

// Accepts unix seconds (number or numeric string) or an ISO-8601 / YYYY-MM-DD
// string. Returns unix seconds.
function takeTime(raw, field) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.floor(raw > 1e12 ? raw / 1000 : raw);
  if (typeof raw === "string") {
    const s = raw.trim();
    if (/^\d{9,13}$/.test(s)) { const n = Number(s); return Math.floor(n > 1e12 ? n / 1000 : n); }
    const t = Date.parse(s);
    if (Number.isFinite(t)) return Math.floor(t / 1000);
  }
  throw bad(`"${field}" must be unix seconds or an ISO-8601 date (e.g. 2026-08-01 or 1754006400)`);
}

// Relative window like "6h", "3d", "2w" -> milliseconds.
function takeLookback(raw) {
  if (raw == null || raw === "") return null;
  const m = typeof raw === "string" ? raw.trim().toLowerCase().match(/^(\d{1,4})\s*([hdw])$/) : null;
  if (!m) throw bad('"lookback" must be like "6h", "3d" or "2w"');
  const n = parseInt(m[1], 10);
  const unit = m[2] === "h" ? 3_600_000 : m[2] === "d" ? DAY_MS : 7 * DAY_MS;
  const ms = n * unit;
  if (ms <= 0 || ms > MAX_HISTORY_DAYS * DAY_MS) throw bad(`"lookback" must be between 1h and ${MAX_HISTORY_DAYS}d`);
  return ms;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null));
const pct = (v) => (num(v) == null ? null : +num(v).toFixed(4));
const iso = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
// Label the series spacing from the data itself (upstream picks the
// granularity by window AND by how far back it starts; asserting it from the
// inputs alone mislabels an older 1-day window, which arrives hourly).
function granularityOf(timesMs) {
  const ts = timesMs.filter((t) => typeof t === "number").slice(0, 8);
  if (ts.length < 2) return null;
  const deltas = [];
  for (let k = 1; k < ts.length; k++) deltas.push(ts[k] - ts[k - 1]);
  deltas.sort((a, b) => a - b);
  const d = deltas[Math.floor(deltas.length / 2)];
  if (d <= 0) return null;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
  if (d < DAY_MS) return `${Math.round(d / 3_600_000)}h`;
  return `${Math.round(d / DAY_MS)}d`;
}
const trim = (s, n) => (typeof s === "string" ? (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s) : null);
const upper = (s) => (typeof s === "string" && s ? s.toUpperCase() : null);

// --- tools --------------------------------------------------------------------
export const CRYPTO_MARKETS_TOOLS = [
  // ===========================================================================
  // coin-price-by-contract: token prices by platform + contract address.
  // ===========================================================================
  {
    route: "GET /api/coin-price-by-contract",
    name: "Token price by contract address",
    slug: "coin-price-by-contract",
    category: "crypto",
    price: "$0.005",
    description:
      "Live price, market cap, 24h volume and 24h change for ERC-20 / SPL / other chain tokens looked up by CONTRACT ADDRESS on a named platform (ethereum, base, polygon-pos, arbitrum-one, optimistic-ethereum, binance-smart-chain, solana, avalanche, ...). Up to 25 contracts per call, any vs currency (default usd). The address-first sibling of crypto-price: use it when an agent holds a token address from a wallet, a DEX pair or a contract scan and has no coin id. Unknown addresses come back as null rather than failing the batch. Responses are cached in-process for 60 seconds.",
    tags: ["crypto", "token", "price", "contract", "erc20", "evm", "solana", "market-data"],
    discovery: {
      input: { platform: "ethereum", contracts: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", currency: "usd" },
      inputSchema: {
        properties: {
          platform: { type: "string", description: "Asset platform id: ethereum, base, polygon-pos, arbitrum-one, optimistic-ethereum, binance-smart-chain, solana, avalanche, ... " },
          contracts: { type: "string", description: "Comma-separated contract addresses (max 25). Also accepts an array." },
          currency: { type: "string", description: "vs currency (default usd): fiat (usd, eur) or crypto (btc, eth)." },
        },
        required: ["platform", "contracts"],
      },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-08-22T13:20:00.000Z", cached: false,
          platform: "ethereum", currency: "usd", count: 1,
          tokens: [
            { contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", price: 0.999916, marketCap: 73514026487.98, volume24h: 26092767405.46, change24hPct: 0.0212, lastUpdated: "2026-08-22T13:15:40.000Z" },
          ],
        },
      },
    },
    handler: async (i) => {
      const platform = takeId(i.platform, "platform");
      const contracts = takeContracts(i.contracts, 25);
      const currency = takeCurrency(i.currency);
      const { data, fetchedAt, cached } = await cgGet(`/simple/token_price/${encodeURIComponent(platform)}`, {
        contract_addresses: contracts.join(","), vs_currencies: currency,
        include_market_cap: "true", include_24hr_vol: "true", include_24hr_change: "true", include_last_updated_at: "true",
      }, TTL.price);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw bad("Market data upstream returned an unexpected shape", 502);
      // Upstream keys EVM addresses lowercase; look up case-insensitively so a
      // checksummed input still matches.
      const byLower = new Map(Object.entries(data).map(([k, v]) => [k.toLowerCase(), v]));
      const tokens = contracts.map((c) => {
        const row = byLower.get(c.toLowerCase());
        if (!row) return { contract: c, price: null, marketCap: null, volume24h: null, change24hPct: null, lastUpdated: null };
        return {
          contract: Object.keys(data).find((k) => k.toLowerCase() === c.toLowerCase()) || c,
          price: num(row[currency]),
          marketCap: num(row[`${currency}_market_cap`]),
          volume24h: num(row[`${currency}_24h_vol`]),
          change24hPct: pct(row[`${currency}_24h_change`]),
          lastUpdated: iso(row.last_updated_at),
        };
      });
      return { source: SOURCE, fetchedAt, cached, platform, currency, count: tokens.filter((t) => t.price != null).length, tokens };
    },
  },

  // ===========================================================================
  // coin-profile: one coin's full profile + market snapshot.
  // ===========================================================================
  {
    route: "GET /api/coin-profile",
    name: "Coin profile",
    slug: "coin-profile",
    category: "crypto",
    price: "$0.008",
    description:
      "Full profile of one coin by id: name/symbol, description, categories, contract addresses per platform, links (homepage, explorers, repos, social), hashing algorithm, genesis date, and a market snapshot in your currency: price, rank, market cap, fully diluted valuation, 24h volume, ATH/ATL with dates and distance, circulating/total/max supply, 24h/7d/30d/1y change. One call for the metadata a token-risk or research agent otherwise assembles from five. Cached in-process for 5 minutes.",
    tags: ["crypto", "coin", "profile", "metadata", "market-data", "supply", "ath", "links"],
    discovery: {
      input: { coin: "ethereum", currency: "usd" },
      inputSchema: {
        properties: {
          coin: { type: "string", description: "Coin id (bitcoin, ethereum, usd-coin, ...). Use coin-search to resolve a symbol." },
          currency: { type: "string", description: "vs currency for the market block (default usd)." },
        },
        required: ["coin"],
      },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-08-22T13:20:00.000Z", cached: false,
          id: "ethereum", symbol: "ETH", name: "Ethereum", rank: 2, currency: "usd",
          description: "Ethereum is a global, open-source platform for decentralized applications...",
          categories: ["Smart Contract Platform", "Layer 1 (L1)"],
          platforms: [{ platform: "ethereum", contract: null, decimals: null }],
          links: { homepage: "https://www.ethereum.org/", explorers: ["https://etherscan.io/"], repos: ["https://github.com/ethereum/go-ethereum"], twitter: "ethereum", reddit: "https://www.reddit.com/r/ethereum", whitepaper: null },
          hashingAlgorithm: "Ethash", genesisDate: "2015-07-30",
          market: { price: 2424.5, marketCap: 292876442962, fullyDilutedValuation: 292876442962, volume24h: 14200000000, high24h: 2480.1, low24h: 2390.2, change24hPct: 1.2, change7dPct: -3.1, change30dPct: 8.4, change1yPct: -12.9, ath: 4878.26, athDate: "2021-11-10T14:24:19.604Z", athChangePct: -50.3, atl: 0.432979, atlDate: "2015-10-20T00:00:00.000Z", circulatingSupply: 120700000, totalSupply: 120700000, maxSupply: null, lastUpdated: "2026-08-22T13:19:00.000Z" },
          sentimentUpPct: 71.4, watchlistUsers: 2200000,
        },
      },
    },
    handler: async (i) => {
      const coin = takeId(i.coin, "coin");
      const currency = takeCurrency(i.currency);
      const { data: d, fetchedAt, cached } = await cgGet(`/coins/${encodeURIComponent(coin)}`, {
    // CoinGecko removes the community_data and developer_data BLOCKS on
    // 2026-08-28 (their changelog, 2026-08-14). The two figures this tool
    // surfaces are top-level fields that survive the removal - probed live
    // 2026-08-22: sentiment_votes_up_percentage and watchlist_portfolio_users
    // both answer with community_data off - so we stop asking for a block that
    // is about to stop existing.
        localization: "false", tickers: "false", market_data: "true", community_data: "false", developer_data: "false", sparkline: "false",
      }, TTL.list);
      if (!d || typeof d !== "object" || !d.id) throw bad("Market data upstream returned an unexpected shape", 502);
      const md = d.market_data || {};
      const pick = (obj) => (obj && typeof obj === "object" ? num(obj[currency]) : null);
      const platforms = Object.entries(d.detail_platforms || {})
        .filter(([k]) => k !== "")
        .map(([platform, v]) => ({ platform, contract: v?.contract_address || null, decimals: num(v?.decimal_place) }));
      const firstUrl = (arr) => (Array.isArray(arr) ? arr.find((u) => typeof u === "string" && u) || null : null);
      const urls = (arr, n) => (Array.isArray(arr) ? arr.filter((u) => typeof u === "string" && u).slice(0, n) : []);
      const links = d.links || {};
      return {
        source: SOURCE, fetchedAt, cached,
        id: d.id, symbol: upper(d.symbol), name: d.name ?? null, rank: num(d.market_cap_rank), currency,
        description: trim((d.description?.en || "").replace(/\s+/g, " ").trim(), 600) || null,
        categories: Array.isArray(d.categories) ? d.categories.filter((c) => typeof c === "string").slice(0, 25) : [],
        platforms,
        links: {
          homepage: firstUrl(links.homepage),
          explorers: urls(links.blockchain_site, 3),
          repos: urls(links.repos_url?.github, 3),
          twitter: links.twitter_screen_name || null,
          reddit: links.subreddit_url || null,
          whitepaper: links.whitepaper || null,
        },
        hashingAlgorithm: d.hashing_algorithm ?? null,
        genesisDate: d.genesis_date ?? null,
        market: {
          price: pick(md.current_price),
          marketCap: pick(md.market_cap),
          fullyDilutedValuation: pick(md.fully_diluted_valuation),
          volume24h: pick(md.total_volume),
          high24h: pick(md.high_24h),
          low24h: pick(md.low_24h),
          change24hPct: pct(md.price_change_percentage_24h_in_currency?.[currency] ?? md.price_change_percentage_24h),
          change7dPct: pct(md.price_change_percentage_7d_in_currency?.[currency] ?? md.price_change_percentage_7d),
          change30dPct: pct(md.price_change_percentage_30d_in_currency?.[currency] ?? md.price_change_percentage_30d),
          change1yPct: pct(md.price_change_percentage_1y_in_currency?.[currency] ?? md.price_change_percentage_1y),
          ath: pick(md.ath), athDate: iso(md.ath_date?.[currency]), athChangePct: pct(md.ath_change_percentage?.[currency]),
          atl: pick(md.atl), atlDate: iso(md.atl_date?.[currency]),
          circulatingSupply: num(md.circulating_supply), totalSupply: num(md.total_supply), maxSupply: num(md.max_supply),
          lastUpdated: iso(md.last_updated || d.last_updated),
        },
        sentimentUpPct: pct(d.sentiment_votes_up_percentage),
        watchlistUsers: num(d.watchlist_portfolio_users),
      };
    },
  },

  // ===========================================================================
  // coin-history: price / market cap / volume snapshot on a given date.
  // ===========================================================================
  {
    route: "GET /api/coin-history",
    name: "Coin snapshot on a date",
    slug: "coin-history",
    category: "crypto",
    price: "$0.005",
    description:
      "Price, market cap and 24h volume of a coin on ONE past date (00:00 UTC snapshot), in every currency at once plus your chosen one called out. Pass `date` (YYYY-MM-DD) or `daysAgo` (1-365). The point-in-time sibling of crypto-history (which returns a series): use it to value a position as of a date, compute a since-date return, or check a tax-lot basis. Historical range on this plan is the past 365 days, enforced before the call. Cached in-process for 5 minutes.",
    tags: ["crypto", "history", "snapshot", "price", "date", "market-cap", "tax"],
    discovery: {
      input: { coin: "bitcoin", daysAgo: 30, currency: "usd" },
      inputSchema: {
        properties: {
          coin: { type: "string", description: "Coin id (bitcoin, ethereum, ...)." },
          date: { type: "string", description: "Snapshot date YYYY-MM-DD (UTC), within the past 365 days. Alternative to daysAgo." },
          daysAgo: { type: "number", description: "Days before today, 1-365 (used when date is absent; default 30)." },
          currency: { type: "string", description: "Currency to call out (default usd); all currencies are still returned under `allCurrencies`." },
        },
        required: ["coin"],
      },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-08-22T13:20:00.000Z", cached: false,
          id: "bitcoin", symbol: "BTC", name: "Bitcoin", date: "2026-07-23", currency: "usd",
          price: 118412.55, marketCap: 2356000000000, volume24h: 41000000000,
          allCurrencies: { price: { usd: 118412.55, eur: 100812.3, btc: 1 }, marketCap: { usd: 2356000000000 }, volume24h: { usd: 41000000000 } },
        },
      },
    },
    handler: async (i) => {
      const coin = takeId(i.coin, "coin");
      const currency = takeCurrency(i.currency);
      let dateStr;
      if (i.date != null && i.date !== "") {
        if (typeof i.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(i.date.trim())) throw bad('"date" must be YYYY-MM-DD');
        dateStr = i.date.trim();
        const t = Date.parse(dateStr + "T00:00:00Z");
        if (!Number.isFinite(t)) throw bad('"date" is not a valid calendar date');
        const ageDays = (Date.now() - t) / DAY_MS;
        if (ageDays < 0) throw bad('"date" is in the future');
        if (ageDays > MAX_HISTORY_DAYS) throw bad(`"date" must be within the past ${MAX_HISTORY_DAYS} days on this plan`);
      } else {
        const daysAgo = takeInt(i.daysAgo, "daysAgo", { min: 1, max: MAX_HISTORY_DAYS, dflt: 30 });
        dateStr = new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
      }
      const [y, m, dd] = dateStr.split("-");
      const { data: d, fetchedAt, cached } = await cgGet(`/coins/${encodeURIComponent(coin)}/history`, { date: `${dd}-${m}-${y}`, localization: "false" }, TTL.list);
      if (!d || typeof d !== "object" || !d.id) throw bad("Market data upstream returned an unexpected shape", 502);
      const md = d.market_data;
      if (!md) throw bad("No market data recorded for that coin on that date", 422);
      const numMap = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, num(v)]).filter(([, v]) => v != null));
      return {
        source: SOURCE, fetchedAt, cached,
        id: d.id, symbol: upper(d.symbol), name: d.name ?? null, date: dateStr, currency,
        price: num(md.current_price?.[currency]),
        marketCap: num(md.market_cap?.[currency]),
        volume24h: num(md.total_volume?.[currency]),
        allCurrencies: { price: numMap(md.current_price), marketCap: numMap(md.market_cap), volume24h: numMap(md.total_volume) },
      };
    },
  },

  // ===========================================================================
  // coin-ohlc: candles.
  // ===========================================================================
  {
    route: "GET /api/coin-ohlc",
    name: "Coin OHLC candles",
    slug: "coin-ohlc",
    category: "crypto",
    price: "$0.008",
    description:
      "OHLC candles for a coin: days 1 (30-min candles), 7 or 14 (4-hour), 30 / 90 / 180 / 365 (daily), in any vs currency. Returns aligned {time, open, high, low, close} bars plus the window's high/low/first/last and % change. The candle sibling of crypto-history, which returns close-only points: use OHLC for technical indicators, range/volatility work and charting. Cached in-process for 60 seconds.",
    tags: ["crypto", "ohlc", "candles", "chart", "technical-analysis", "volatility", "timeseries"],
    discovery: {
      input: { coin: "bitcoin", days: 7, currency: "usd" },
      inputSchema: {
        properties: {
          coin: { type: "string", description: "Coin id (bitcoin, ethereum, ...)." },
          days: { type: "number", description: "1, 7, 14, 30, 90, 180 or 365 (default 7)." },
          currency: { type: "string", description: "vs currency (default usd)." },
        },
        required: ["coin"],
      },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-08-22T13:20:00.000Z", cached: false,
          coin: "bitcoin", currency: "usd", days: 7, count: 42, granularity: "4h",
          summary: { first: 66120.4, last: 68210.0, high: 69850.0, low: 64995.9, changePct: 3.16 },
          bars: [{ time: "2026-08-15T16:00:00.000Z", open: 66120.4, high: 66500.1, low: 65900.0, close: 66210.3 }],
        },
      },
    },
    handler: async (i) => {
      const coin = takeId(i.coin, "coin");
      const currency = takeCurrency(i.currency);
      const allowed = [1, 7, 14, 30, 90, 180, 365];
      const days = takeInt(i.days, "days", { min: 1, max: 365, dflt: 7 });
      if (!allowed.includes(days)) throw bad(`"days" must be one of ${allowed.join(", ")}`);
      const { data, fetchedAt, cached } = await cgGet(`/coins/${encodeURIComponent(coin)}/ohlc`, { vs_currency: currency, days }, TTL.price);
      if (!Array.isArray(data)) throw bad("Market data upstream returned an unexpected shape", 502);
      const bars = data.filter((r) => Array.isArray(r) && r.length >= 5).map(([t, o, h, l, c]) => ({ time: iso(t), open: num(o), high: num(h), low: num(l), close: num(c) }));
      const closes = bars.map((b) => b.close).filter((v) => v != null);
      const highs = bars.map((b) => b.high).filter((v) => v != null);
      const lows = bars.map((b) => b.low).filter((v) => v != null);
      const first = bars.length ? bars[0].open ?? closes[0] ?? null : null;
      const last = closes.length ? closes[closes.length - 1] : null;
      return {
        source: SOURCE, fetchedAt, cached, coin, currency, days, count: bars.length,
        granularity: granularityOf(data.map((r) => r?.[0])),
        summary: {
          first, last,
          high: highs.length ? Math.max(...highs) : null,
          low: lows.length ? Math.min(...lows) : null,
          changePct: first && last != null ? +(((last - first) / first) * 100).toFixed(4) : null,
        },
        bars,
      };
    },
  },

  // ===========================================================================
  // coin-market-chart-range: price/mcap/volume series over an arbitrary window.
  // ===========================================================================
  {
    route: "GET /api/coin-market-chart-range",
    name: "Coin market chart for a time window",
    slug: "coin-market-chart-range",
    category: "crypto",
    price: "$0.008",
    description:
      "Price, market cap and volume series for a coin over an ARBITRARY time window: `from`/`to` as unix seconds or ISO dates, or `lookback` (\"6h\", \"3d\", \"2w\") ending now. Granularity is automatic upstream: 5-minute points for a window of 1 day or less, hourly up to 90 days, daily beyond. The windowed sibling of crypto-history (which counts days back from now): use it to align with a specific event, a filing date or another series. Window must lie within the past 365 days on this plan, enforced before the call. Cached in-process for 60 seconds.",
    tags: ["crypto", "history", "range", "chart", "timeseries", "backtest", "event-study"],
    discovery: {
      input: { coin: "ethereum", lookback: "3d", currency: "usd" },
      inputSchema: {
        properties: {
          coin: { type: "string", description: "Coin id (bitcoin, ethereum, ...)." },
          from: { type: "string", description: "Window start: unix seconds or ISO-8601 date. Default = to minus 24h." },
          to: { type: "string", description: "Window end: unix seconds or ISO-8601 date. Default = now." },
          lookback: { type: "string", description: "Alternative to from: a window ending at `to`, like \"6h\", \"3d\" or \"2w\"." },
          currency: { type: "string", description: "vs currency (default usd)." },
        },
        required: ["coin"],
      },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-08-22T13:20:00.000Z", cached: false,
          coin: "ethereum", currency: "usd", from: "2026-08-19T13:20:00.000Z", to: "2026-08-22T13:20:00.000Z", count: 73, granularity: "1h",
          summary: { first: 2380.1, last: 2424.5, high: 2480.1, low: 2350.0, changePct: 1.87 },
          points: [{ time: "2026-08-19T14:00:00.000Z", price: 2380.1, marketCap: 287000000000, volume: 13800000000 }],
        },
      },
    },
    handler: async (i) => {
      const coin = takeId(i.coin, "coin");
      const currency = takeCurrency(i.currency);
      const nowSec = Math.floor(Date.now() / 1000);
      const to = takeTime(i.to, "to") ?? nowSec;
      const lookbackMs = takeLookback(i.lookback);
      let from = takeTime(i.from, "from");
      if (from == null) from = lookbackMs != null ? to - Math.floor(lookbackMs / 1000) : to - 86_400;
      if (to > nowSec + 60) throw bad('"to" is in the future');
      if (from >= to) throw bad('"from" must be before "to"');
      if ((nowSec - from) * 1000 > MAX_HISTORY_DAYS * DAY_MS + DAY_MS) throw bad(`the window must lie within the past ${MAX_HISTORY_DAYS} days on this plan`);
      const { data, fetchedAt, cached } = await cgGet(`/coins/${encodeURIComponent(coin)}/market_chart/range`, { vs_currency: currency, from, to }, TTL.price);
      const prices = Array.isArray(data?.prices) ? data.prices : null;
      if (!prices) throw bad("Market data upstream returned an unexpected shape", 502);
      const caps = Array.isArray(data.market_caps) ? data.market_caps : [];
      const vols = Array.isArray(data.total_volumes) ? data.total_volumes : [];
      const points = prices.map(([t, p], idx) => ({ time: iso(t), price: num(p), marketCap: num(caps[idx]?.[1]), volume: num(vols[idx]?.[1]) }));
      const vals = points.map((p) => p.price).filter((v) => v != null);
      const first = vals[0] ?? null, last = vals.length ? vals[vals.length - 1] : null;
      return {
        source: SOURCE, fetchedAt, cached, coin, currency,
        from: new Date(from * 1000).toISOString(), to: new Date(to * 1000).toISOString(),
        count: points.length, granularity: granularityOf(prices.map((r) => r?.[0])),
        summary: {
          first, last,
          high: vals.length ? Math.max(...vals) : null, low: vals.length ? Math.min(...vals) : null,
          changePct: first && last != null ? +(((last - first) / first) * 100).toFixed(4) : null,
        },
        points,
      };
    },
  },

  // ===========================================================================
  // coin-categories: market cap by category.
  // ===========================================================================
  {
    route: "GET /api/coin-categories",
    name: "Crypto categories by market cap",
    slug: "coin-categories",
    category: "crypto",
    price: "$0.005",
    description:
      "Coin categories (Layer 1, Meme, AI, DeFi, Stablecoins, RWA, ...) ranked by market cap, with 24h market cap change %, 24h volume and the top-3 coins per category. Order by market_cap_desc (default), market_cap_asc, market_cap_change_24h_desc/asc, name_asc/desc; optional `query` substring filter on category name/id; limit 1-100 (default 25). The sector-rotation view: which narratives are gaining or bleeding today. Cached in-process for 5 minutes.",
    tags: ["crypto", "categories", "sectors", "narrative", "market-cap", "rotation", "defi", "meme", "ai"],
    discovery: {
      input: { order: "market_cap_desc", limit: 10 },
      inputSchema: {
        properties: {
          order: { type: "string", description: "market_cap_desc (default), market_cap_asc, market_cap_change_24h_desc, market_cap_change_24h_asc, name_asc, name_desc." },
          limit: { type: "number", description: "1-100 (default 25)." },
          query: { type: "string", description: "Optional case-insensitive substring filter on the category name or id (e.g. \"meme\", \"layer-2\")." },
        },
      },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-08-22T13:20:00.000Z", cached: false,
          order: "market_cap_desc", count: 1, totalCategories: 400,
          categories: [
            { rank: 1, id: "smart-contract-platform", name: "Smart Contract Platform", marketCap: 2261471553524.96, marketCapChange24hPct: 1.1784, volume24h: 95000000000, topCoins: ["bitcoin", "ethereum", "solana"], updatedAt: "2026-08-22T13:15:00.000Z" },
          ],
        },
      },
    },
    handler: async (i) => {
      const orders = ["market_cap_desc", "market_cap_asc", "market_cap_change_24h_desc", "market_cap_change_24h_asc", "name_asc", "name_desc"];
      const order = i.order == null || i.order === "" ? "market_cap_desc" : String(i.order).trim().toLowerCase();
      if (!orders.includes(order)) throw bad(`"order" must be one of ${orders.join(", ")}`);
      const limit = takeInt(i.limit, "limit", { min: 1, max: 100, dflt: 25 });
      const query = i.query == null || i.query === "" ? null : String(i.query).trim().toLowerCase().slice(0, 64);
      const { data, fetchedAt, cached } = await cgGet("/coins/categories", { order }, TTL.list);
      if (!Array.isArray(data)) throw bad("Market data upstream returned an unexpected shape", 502);
      // Image URLs for top coins carry the coin image path, which includes the
      // numeric image id, not the coin id. Keep the names readable by deriving
      // from the URL's trailing file stem; callers wanting ids use coin-search.
      const stem = (u) => (typeof u === "string" ? (u.split("/").pop() || "").split(".")[0].split("?")[0] || null : null);
      const rows = data.map((c, idx) => ({
        rank: idx + 1,
        id: c.id ?? null, name: c.name ?? null,
        marketCap: num(c.market_cap), marketCapChange24hPct: pct(c.market_cap_change_24h), volume24h: num(c.volume_24h),
        topCoins: Array.isArray(c.top_3_coins_id) && c.top_3_coins_id.length ? c.top_3_coins_id.slice(0, 3) : (Array.isArray(c.top_3_coins) ? c.top_3_coins.map(stem).filter(Boolean) : []),
        updatedAt: iso(c.updated_at),
      }));
      const filtered = query ? rows.filter((r) => (r.name || "").toLowerCase().includes(query) || (r.id || "").includes(query)) : rows;
      return { source: SOURCE, fetchedAt, cached, order, query, count: Math.min(limit, filtered.length), totalCategories: rows.length, categories: filtered.slice(0, limit) };
    },
  },

  // ===========================================================================
  // global-defi: DeFi slice of the global market.
  // ===========================================================================
  {
    route: "GET /api/global-defi",
    name: "Global DeFi market",
    slug: "global-defi",
    category: "crypto",
    price: "$0.005",
    description:
      "Global DeFi snapshot: DeFi market cap (USD), ETH market cap, DeFi-to-ETH ratio, 24h DeFi trading volume, DeFi dominance % of the whole crypto market, and the top DeFi coin with its share of DeFi. The DeFi companion of crypto-global (whole-market caps and BTC/ETH dominance) and of defi-tvl (locked value, a different measure). Cached in-process for 5 minutes.",
    tags: ["crypto", "defi", "global", "dominance", "market-cap", "macro"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-08-22T13:20:00.000Z", cached: false,
          defiMarketCapUsd: 112237506811.1, ethMarketCapUsd: 292876442962.28, defiToEthRatioPct: 38.3317,
          defiVolume24hUsd: 10184726070.56, defiDominancePct: 4.1566,
          topCoin: { name: "Lido Staked Ether", defiDominancePct: 20.7086 },
        },
      },
    },
    handler: async () => {
      const { data, fetchedAt, cached } = await cgGet("/global/decentralized_finance_defi", {}, TTL.list);
      const d = data?.data;
      if (!d || typeof d !== "object") throw bad("Market data upstream returned an unexpected shape", 502);
      return {
        source: SOURCE, fetchedAt, cached,
        defiMarketCapUsd: num(d.defi_market_cap), ethMarketCapUsd: num(d.eth_market_cap), defiToEthRatioPct: pct(d.defi_to_eth_ratio),
        defiVolume24hUsd: num(d.trading_volume_24h), defiDominancePct: pct(d.defi_dominance),
        topCoin: { name: d.top_coin_name ?? null, defiDominancePct: pct(d.top_coin_defi_dominance) },
      };
    },
  },

  // ===========================================================================
  // exchanges: ranked list, or one exchange's volume/trust profile.
  // ===========================================================================
  {
    route: "GET /api/exchanges",
    name: "Crypto exchanges",
    slug: "exchanges",
    category: "crypto",
    price: "$0.005",
    description:
      "Crypto exchanges ranked by trust score: id, name, country, year established, trust score (1-10) and rank, 24h volume in BTC (and normalized), centralized flag and URL; limit 1-100 (default 25). Pass `exchange` (an id such as binance, gdax, kraken) for ONE exchange's profile instead: the same fields plus description, trade volume incl. and excl. wash-trade normalization, ticker count and social links. Cached in-process for 5 minutes. Use exchange-tickers for an exchange's markets.",
    tags: ["crypto", "exchanges", "cex", "trust-score", "volume", "venue"],
    discovery: {
      input: { limit: 10 },
      inputSchema: {
        properties: {
          limit: { type: "number", description: "List mode: 1-100 exchanges (default 25)." },
          page: { type: "number", description: "List mode: page number (default 1)." },
          exchange: { type: "string", description: "Profile mode: one exchange id (binance, gdax, kraken, okex, bybit_spot, ...)." },
        },
      },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-08-22T13:20:00.000Z", cached: false,
          mode: "list", page: 1, count: 1,
          exchanges: [
            { rank: 1, id: "gdax", name: "Coinbase Exchange", country: "United States", yearEstablished: 2012, trustScore: 10, trustScoreRank: 1, volume24hBtc: 28651.7, volume24hBtcNormalized: 28651.7, centralized: true, url: "https://www.coinbase.com/" },
          ],
        },
      },
    },
    handler: async (i) => {
      const exchange = takeId(i.exchange, "exchange", { required: false });
      if (exchange) {
        const { data: d, fetchedAt, cached } = await cgGet(`/exchanges/${encodeURIComponent(exchange)}`, {}, TTL.list);
        if (!d || typeof d !== "object" || !d.name) throw bad("Market data upstream returned an unexpected shape", 502);
        return {
          source: SOURCE, fetchedAt, cached, mode: "profile",
          exchange: {
            id: exchange, name: d.name ?? null, country: d.country ?? null, yearEstablished: num(d.year_established),
            description: trim((d.description || "").replace(/\s+/g, " ").trim(), 400) || null,
            url: d.url ?? null, centralized: typeof d.centralized === "boolean" ? d.centralized : null,
            trustScore: num(d.trust_score), trustScoreRank: num(d.trust_score_rank),
            volume24hBtc: num(d.trade_volume_24h_btc), volume24hBtcNormalized: num(d.trade_volume_24h_btc_normalized),
            tickerCount: Array.isArray(d.tickers) ? d.tickers.length : null,
            coinsCount: num(d.coins), pairsCount: num(d.pairs),
            hasTradingIncentive: typeof d.has_trading_incentive === "boolean" ? d.has_trading_incentive : null,
            links: { twitter: d.twitter_handle || null, facebook: d.facebook_url || null, reddit: d.reddit_url || null, telegram: d.telegram_url || null },
          },
        };
      }
      const limit = takeInt(i.limit, "limit", { min: 1, max: 100, dflt: 25 });
      const page = takeInt(i.page, "page", { min: 1, max: 50, dflt: 1 });
      const { data, fetchedAt, cached } = await cgGet("/exchanges", { per_page: limit, page }, TTL.list);
      if (!Array.isArray(data)) throw bad("Market data upstream returned an unexpected shape", 502);
      const exchanges = data.map((e, idx) => ({
        rank: (page - 1) * limit + idx + 1,
        id: e.id ?? null, name: e.name ?? null, country: e.country ?? null, yearEstablished: num(e.year_established),
        trustScore: num(e.trust_score), trustScoreRank: num(e.trust_score_rank),
        volume24hBtc: num(e.trade_volume_24h_btc), volume24hBtcNormalized: num(e.trade_volume_24h_btc_normalized),
        centralized: typeof e.centralized === "boolean" ? e.centralized : null, url: e.url ?? null,
      }));
      return { source: SOURCE, fetchedAt, cached, mode: "list", page, count: exchanges.length, exchanges };
    },
  },

  // ===========================================================================
  // exchange-tickers: one exchange's markets.
  // ===========================================================================
  {
    route: "GET /api/exchange-tickers",
    name: "Exchange tickers",
    slug: "exchange-tickers",
    category: "crypto",
    price: "$0.008",
    description:
      "Markets (tickers) listed on one exchange: base/target pair, last price, 24h volume, USD- and BTC-converted last price and volume, bid-ask spread %, trust score (green/yellow/red), anomaly and stale flags, trade URL and last trade time. Filter by `coins` (coin ids, max 10); pages of up to 100 tickers (`page`), trimmed to `limit` (default 50). Where is a coin actually trading, at what spread, and is the volume trusted. Cached in-process for 60 seconds.",
    tags: ["crypto", "exchange", "tickers", "markets", "pairs", "spread", "volume", "liquidity"],
    discovery: {
      input: { exchange: "binance", coins: "ethereum", limit: 5 },
      inputSchema: {
        properties: {
          exchange: { type: "string", description: "Exchange id (binance, gdax, kraken, ...). See the exchanges tool." },
          coins: { type: "string", description: "Optional comma-separated coin ids to filter (max 10), e.g. \"bitcoin,ethereum\"." },
          page: { type: "number", description: "Page of 100 tickers upstream (default 1)." },
          limit: { type: "number", description: "Max tickers returned from that page, 1-100 (default 50)." },
        },
        required: ["exchange"],
      },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-08-22T13:20:00.000Z", cached: false,
          exchange: "binance", exchangeName: "Binance", page: 1, count: 1,
          tickers: [
            { base: "ETH", target: "USDT", coinId: "ethereum", targetCoinId: "tether", last: 2424.51, volume24h: 412000.5, lastUsd: 2424.6, volume24hUsd: 998000000, lastBtc: 0.0314, spreadPct: 0.01, trustScore: "green", anomaly: false, stale: false, tradeUrl: "https://www.binance.com/en/trade/ETH_USDT", lastTradedAt: "2026-08-22T13:19:30.000Z" },
          ],
        },
      },
    },
    handler: async (i) => {
      const exchange = takeId(i.exchange, "exchange");
      const coins = i.coins == null || i.coins === "" ? null : takeIdList(i.coins, "coins", 10);
      const page = takeInt(i.page, "page", { min: 1, max: 100, dflt: 1 });
      const limit = takeInt(i.limit, "limit", { min: 1, max: 100, dflt: 50 });
      const { data: d, fetchedAt, cached } = await cgGet(`/exchanges/${encodeURIComponent(exchange)}/tickers`, { coin_ids: coins ? coins.join(",") : undefined, page, include_exchange_logo: "false" }, TTL.price);
      if (!d || !Array.isArray(d.tickers)) throw bad("Market data upstream returned an unexpected shape", 502);
      const tickers = d.tickers.slice(0, limit).map((t) => ({
        base: t.base ?? null, target: t.target ?? null, coinId: t.coin_id ?? null, targetCoinId: t.target_coin_id ?? null,
        last: num(t.last), volume24h: num(t.volume),
        lastUsd: num(t.converted_last?.usd), volume24hUsd: num(t.converted_volume?.usd), lastBtc: num(t.converted_last?.btc),
        spreadPct: pct(t.bid_ask_spread_percentage), trustScore: t.trust_score ?? null,
        anomaly: Boolean(t.is_anomaly), stale: Boolean(t.is_stale),
        tradeUrl: t.trade_url ?? null, lastTradedAt: iso(t.last_traded_at),
      }));
      return { source: SOURCE, fetchedAt, cached, exchange, exchangeName: d.name ?? null, page, coins, count: tickers.length, tickers };
    },
  },

  // ===========================================================================
  // exchange-rates: BTC-based rates.
  // ===========================================================================
  {
    route: "GET /api/exchange-rates",
    name: "BTC exchange rates",
    slug: "exchange-rates",
    category: "crypto",
    price: "$0.005",
    description:
      "BTC-denominated exchange rates for ~60 units: crypto (ETH, LTC, BNB, SOL, ...), fiat (USD, EUR, JPY, ...) and commodities (gold, silver ounces), each as units per 1 BTC with name and type. Optional `currencies` filter (comma-separated unit codes) and `type` filter (crypto, fiat, commodity). One call gives a consistent cross-rate table: BTC in gold ounces, ETH/BTC, USD/JPY via BTC. Cached in-process for 60 seconds.",
    tags: ["crypto", "exchange-rates", "btc", "fiat", "gold", "cross-rate", "fx"],
    discovery: {
      input: { currencies: "usd,eur,eth,xau" },
      inputSchema: {
        properties: {
          currencies: { type: "string", description: "Optional comma-separated unit codes to keep (usd, eur, eth, xau, ...). Default: all." },
          type: { type: "string", description: "Optional filter: crypto, fiat or commodity." },
        },
      },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-08-22T13:20:00.000Z", cached: false,
          base: "BTC", count: 4,
          rates: [
            { code: "usd", name: "US Dollar", unit: "$", type: "fiat", perBtc: 77018 },
            { code: "eur", name: "Euro", unit: "€", type: "fiat", perBtc: 65600.2 },
            { code: "eth", name: "Ether", unit: "ETH", type: "crypto", perBtc: 31.813 },
            { code: "xau", name: "Gold - Troy Ounce", unit: "XAU", type: "commodity", perBtc: 22.91 },
          ],
        },
      },
    },
    handler: async (i) => {
      const want = i.currencies == null || i.currencies === "" ? null : new Set(takeIdList(i.currencies, "currencies", 60));
      const type = i.type == null || i.type === "" ? null : String(i.type).trim().toLowerCase();
      if (type && !["crypto", "fiat", "commodity"].includes(type)) throw bad('"type" must be crypto, fiat or commodity');
      const { data, fetchedAt, cached } = await cgGet("/exchange_rates", {}, TTL.price);
      const r = data?.rates;
      if (!r || typeof r !== "object") throw bad("Market data upstream returned an unexpected shape", 502);
      const rates = Object.entries(r)
        .filter(([code, v]) => (!want || want.has(code.toLowerCase())) && (!type || v?.type === type))
        .map(([code, v]) => ({ code, name: v?.name ?? null, unit: v?.unit ?? null, type: v?.type ?? null, perBtc: num(v?.value) }));
      return { source: SOURCE, fetchedAt, cached, base: "BTC", count: rates.length, rates };
    },
  },

  // ===========================================================================
  // coin-search: query -> coins / exchanges / categories.
  // ===========================================================================
  {
    route: "GET /api/coin-search",
    name: "Coin search",
    slug: "coin-search",
    category: "crypto",
    price: "$0.005",
    description:
      "Resolve a name or ticker to coin ids: full-text search returning matching coins (id, symbol, name, market cap rank, ordered by rank), exchanges (id, name, market type) and categories (id, name), plus NFT collections. `limit` per group 1-50 (default 10). The id resolver for every other coin tool: an agent holding \"PEPE\" or \"render\" gets the canonical id here before calling coin-profile, coin-ohlc or coin-history. Cached in-process for 5 minutes.",
    tags: ["crypto", "search", "resolve", "symbol", "coin-id", "exchanges", "categories", "lookup"],
    discovery: {
      input: { query: "usdc", limit: 5 },
      inputSchema: {
        properties: {
          query: { type: "string", description: "Name, symbol or fragment, 1-64 chars (e.g. \"usdc\", \"render\", \"pepe\")." },
          limit: { type: "number", description: "Max results per group, 1-50 (default 10)." },
        },
        required: ["query"],
      },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-08-22T13:20:00.000Z", cached: false,
          query: "usdc", counts: { coins: 5, exchanges: 0, categories: 1, nfts: 0 },
          coins: [{ id: "usd-coin", symbol: "USDC", name: "USDC", rank: 6 }],
          exchanges: [], categories: [{ id: "usdc-stablecoins", name: "USDC Stablecoins" }], nfts: [],
        },
      },
    },
    handler: async (i) => {
      if (typeof i.query !== "string" || !i.query.trim()) throw bad('"query" is required (1-64 chars)');
      const query = i.query.trim().replace(/\s+/g, " ");
      if (query.length > 64) throw bad('"query" must be at most 64 chars');
      if (/[\u0000-\u001f\u007f]/.test(query)) throw bad('"query" contains control characters');
      const limit = takeInt(i.limit, "limit", { min: 1, max: 50, dflt: 10 });
      const { data: d, fetchedAt, cached } = await cgGet("/search", { query }, TTL.list);
      if (!d || typeof d !== "object") throw bad("Market data upstream returned an unexpected shape", 502);
      const arr = (x) => (Array.isArray(x) ? x : []);
      const coins = arr(d.coins).map((c) => ({ id: c.id ?? null, symbol: upper(c.symbol), name: c.name ?? null, rank: num(c.market_cap_rank) }))
        .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9)).slice(0, limit);
      const exchanges = arr(d.exchanges).slice(0, limit).map((e) => ({ id: e.id ?? null, name: e.name ?? null, marketType: e.market_type ?? null }));
      const categories = arr(d.categories).slice(0, limit).map((c) => ({ id: c.id ?? null, name: c.name ?? null }));
      const nfts = arr(d.nfts).slice(0, limit).map((n) => ({ id: n.id ?? null, symbol: n.symbol ?? null, name: n.name ?? null }));
      return { source: SOURCE, fetchedAt, cached, query, counts: { coins: coins.length, exchanges: exchanges.length, categories: categories.length, nfts: nfts.length }, coins, exchanges, categories, nfts };
    },
  },

  // ===========================================================================
  // coins-list: the full id list, paged, optional platform contracts.
  // ===========================================================================
  {
    route: "GET /api/coins-list",
    name: "All coin ids (paged)",
    slug: "coins-list",
    category: "crypto",
    price: "$0.005",
    description:
      "The complete list of tracked coins (~18k) as {id, symbol, name}, paged: `page` + `perPage` (1-500, default 250). `includePlatforms: true` adds each coin's contract address per platform; `platform` (e.g. base, solana, ethereum) keeps only coins with a contract there; `symbol` keeps one ticker (exact, case-insensitive) across all its namesakes. For bulk id resolution, building a local symbol map, or enumerating every token on one chain; for a single lookup use coin-search. The upstream list is fetched once and cached in-process for 10 minutes, so paging through it costs the shared quota one call.",
    tags: ["crypto", "coins", "list", "ids", "symbols", "platforms", "contracts", "bulk"],
    discovery: {
      input: { symbol: "usdc", includePlatforms: true },
      inputSchema: {
        properties: {
          page: { type: "number", description: "Page number (default 1)." },
          perPage: { type: "number", description: "Rows per page, 1-500 (default 250)." },
          includePlatforms: { type: "boolean", description: "Include contract addresses per platform (default false)." },
          platform: { type: "string", description: "Keep only coins with a contract on this platform id (implies includePlatforms)." },
          symbol: { type: "string", description: "Keep only coins with this ticker symbol (exact, case-insensitive)." },
        },
      },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-08-22T13:20:00.000Z", cached: false,
          page: 1, perPage: 250, total: 3, totalPages: 1, count: 3, filters: { symbol: "usdc", platform: null },
          coins: [
            { id: "usd-coin", symbol: "usdc", name: "USDC", platforms: { ethereum: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", solana: "EPjFWdd5AuFqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } },
          ],
        },
      },
    },
    handler: async (i) => {
      const page = takeInt(i.page, "page", { min: 1, max: 100000, dflt: 1 });
      const perPage = takeInt(i.perPage, "perPage", { min: 1, max: 500, dflt: 250 });
      const platform = takeId(i.platform, "platform", { required: false });
      const includePlatforms = takeBool(i.includePlatforms, false) || Boolean(platform);
      const symbol = i.symbol == null || i.symbol === "" ? null : String(i.symbol).trim().toLowerCase();
      if (symbol != null && (symbol.length > 32 || /\s/.test(symbol))) throw bad('"symbol" must be a single ticker (max 32 chars)');
      const { data, fetchedAt, cached } = await cgGet("/coins/list", { include_platform: includePlatforms ? "true" : undefined }, TTL.coinList);
      if (!Array.isArray(data)) throw bad("Market data upstream returned an unexpected shape", 502);
      let rows = data;
      if (symbol != null) rows = rows.filter((c) => typeof c?.symbol === "string" && c.symbol.toLowerCase() === symbol);
      if (platform) rows = rows.filter((c) => c?.platforms && typeof c.platforms[platform] === "string" && c.platforms[platform]);
      const total = rows.length;
      const totalPages = Math.max(1, Math.ceil(total / perPage));
      const slice = rows.slice((page - 1) * perPage, page * perPage);
      const coins = slice.map((c) => {
        const row = { id: c.id ?? null, symbol: c.symbol ?? null, name: c.name ?? null };
        if (includePlatforms) {
          row.platforms = Object.fromEntries(Object.entries(c.platforms || {}).filter(([k, v]) => k && typeof v === "string" && v));
        }
        return row;
      });
      return { source: SOURCE, fetchedAt, cached, page, perPage, total, totalPages, count: coins.length, filters: { symbol, platform }, coins };
    },
  },
];

// --- Real-world assets (tokenized stocks, ETFs, commodities) ------------------
// CoinGecko's /rwas endpoints (announced 2026-08-31). Live-verified on the Demo
// plan 2026-09-02: /rwas/list (649 assets: 461 stocks, 186 ETFs, 2
// commodities; ignores paging and returns the whole list), /rwas/markets
// (vs_currency, ids, asset_type, order, per_page, page - the market block is
// `tokenized_market_data`, i.e. the ONCHAIN wrapper's price and cap, not the
// underlying's), /rwas/{id} (metadata only - image, web slug, last updated; no
// market block on this plan whatever the query says, so rwa-asset joins it with
// its /rwas/markets row), /rwas/issuers/list (33 issuers) and
// /rwas/issuers/{id} (aggregate cap/volume + the tokens with their contract
// per platform). /rwas/{id}/tickers is paid-plan only and is not offered.
const RWA_TYPES = new Set(["stock", "etf", "commodity"]);
const RWA_ORDERS = new Set(["market_cap_desc", "market_cap_asc", "volume_desc", "volume_asc"]);
function takeRwaType(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().toLowerCase();
  if (!RWA_TYPES.has(s)) throw bad('"type" must be one of stock, etf, commodity');
  return s;
}
function shapeRwaMarket(r, currency) {
  const m = r?.tokenized_market_data || {};
  return {
    id: r?.id ?? null, symbol: typeof r?.symbol === "string" ? r.symbol.toUpperCase() : null, name: r?.name ?? null,
    type: r?.asset_type ?? null, image: typeof r?.image === "string" ? r.image : (r?.image?.large ?? null),
    currency,
    price: num(m.current_price), marketCap: num(m.market_cap), volume24h: num(m.total_volume),
    high24h: num(m.high_24h), low24h: num(m.low_24h),
    change24h: num(m.price_change_24h), change24hPct: num(m.price_change_percentage_24h),
    marketCapChange24h: num(m.market_cap_change_24h), marketCapChange24hPct: num(m.market_cap_change_percentage_24h),
    lastUpdated: m.last_updated ?? null,
  };
}
const RWA_TOOLS = [
  {
    route: "GET /api/rwa-list",
    name: "Tokenized assets list",
    slug: "rwa-list",
    category: "crypto",
    price: "$0.003",
    description:
      "Every real-world asset with a tokenized onchain version that CoinGecko tracks: stocks, ETFs and commodities, with id, symbol, name and type. Filter by type or a name/symbol substring; ids feed rwa-markets and rwa-asset. Counts by type ride along. Cached in-process for 10 minutes.",
    tags: ["crypto", "rwa", "tokenized", "stocks", "etf", "commodities", "list"],
    discovery: {
      input: { type: "commodity" },
      inputSchema: {
        properties: {
          type: { type: "string", description: "stock | etf | commodity (default: all)." },
          q: { type: "string", description: "Case-insensitive substring on name or symbol (e.g. nvidia, gold, spy)." },
          limit: { type: "integer", description: "Max rows (1-700, default 200)." },
        },
      },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-09-02T18:50:00.000Z", cached: false,
          total: 649, byType: { stock: 461, etf: 186, commodity: 2 }, filters: { type: "commodity", q: null }, count: 2,
          assets: [{ id: "gold", symbol: "XAU", name: "Gold", type: "commodity" }, { id: "silver", symbol: "XAG", name: "Silver", type: "commodity" }],
        },
      },
    },
    handler: async (i) => {
      const type = takeRwaType(i.type);
      const q = i.q == null || i.q === "" ? null : String(i.q).trim().toLowerCase().slice(0, 60);
      const limit = takeInt(i.limit, "limit", { min: 1, max: 700, dflt: 200 });
      const { data, fetchedAt, cached } = await cgGet("/rwas/list", {}, TTL.coinList);
      const all = Array.isArray(data) ? data : [];
      const byType = {};
      for (const a of all) byType[a?.asset_type ?? "unknown"] = (byType[a?.asset_type ?? "unknown"] || 0) + 1;
      const assets = all
        .filter((a) => (!type || a?.asset_type === type) && (!q || String(a?.name || "").toLowerCase().includes(q) || String(a?.symbol || "").toLowerCase().includes(q)))
        .slice(0, limit)
        .map((a) => ({ id: a.id ?? null, symbol: typeof a.symbol === "string" ? a.symbol.toUpperCase() : null, name: a.name ?? null, type: a.asset_type ?? null }));
      return { source: SOURCE, fetchedAt, cached, total: all.length, byType, filters: { type, q }, count: assets.length, assets };
    },
  },
  {
    route: "GET /api/rwa-markets",
    name: "Tokenized asset markets",
    slug: "rwa-markets",
    category: "crypto",
    price: "$0.006",
    description:
      "Market data for tokenized real-world assets - tokenized stocks (Nvidia, Tesla, pre-IPO names), ETFs and commodities like gold - ranked by market cap or volume: price, market cap, 24h volume, 24h high/low and change, in your currency. Filter by type or a list of ids. Note these are the ONCHAIN wrappers' figures (what is tokenized and trading), not the underlying's exchange listing. Cached in-process for 60 seconds.",
    tags: ["crypto", "rwa", "tokenized", "stocks", "etf", "commodities", "market-data", "price"],
    discovery: {
      input: { type: "stock", order: "market_cap_desc", perPage: 10 },
      inputSchema: {
        properties: {
          currency: { type: "string", description: "vs currency (default usd)." },
          type: { type: "string", description: "stock | etf | commodity (default: all)." },
          ids: { type: "string", description: "Comma-separated asset ids to fetch instead of a ranked page (max 50), e.g. gold,nvidia." },
          order: { type: "string", description: "market_cap_desc (default) | market_cap_asc | volume_desc | volume_asc." },
          perPage: { type: "integer", description: "Rows per page (1-100, default 25)." },
          page: { type: "integer", description: "Page number (default 1)." },
        },
      },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-09-02T18:50:00.000Z", cached: false,
          currency: "usd", type: "stock", order: "market_cap_desc", page: 1, perPage: 10, count: 1,
          markets: [{ id: "circle-internet-group", symbol: "CRCL", name: "Circle Internet Group", type: "stock", image: "https://coin-images.coingecko.com/coins/images/68595/large/crclon_160x160.png", currency: "usd", price: 89.14, marketCap: 274735360, volume24h: 32316372, high24h: 90.12, low24h: 86.22, change24h: 0.3088, change24hPct: 0.34762, marketCapChange24h: 3496406, marketCapChange24hPct: 1.28905, lastUpdated: "2026-09-02T18:49:30Z" }],
        },
      },
    },
    handler: async (i) => {
      const currency = takeCurrency(i.currency);
      const type = takeRwaType(i.type);
      const ids = i.ids == null || i.ids === "" ? null : takeIdList(i.ids, "ids", 50);
      const order = i.order == null || i.order === "" ? "market_cap_desc" : String(i.order).trim().toLowerCase();
      if (!RWA_ORDERS.has(order)) throw bad('"order" must be one of market_cap_desc, market_cap_asc, volume_desc, volume_asc');
      const perPage = takeInt(i.perPage ?? i.per_page, "perPage", { min: 1, max: 100, dflt: 25 });
      const page = takeInt(i.page, "page", { min: 1, max: 100, dflt: 1 });
      const { data, fetchedAt, cached } = await cgGet("/rwas/markets", {
        vs_currency: currency, asset_type: type || undefined, ids: ids ? ids.join(",") : undefined, order, per_page: perPage, page,
      }, TTL.price);
      const rows = Array.isArray(data) ? data : [];
      return { source: SOURCE, fetchedAt, cached, currency, type, ids, order, page, perPage, count: rows.length, markets: rows.map((r) => shapeRwaMarket(r, currency)) };
    },
  },
  {
    route: "GET /api/rwa-asset",
    name: "Tokenized asset",
    slug: "rwa-asset",
    category: "crypto",
    price: "$0.006",
    description:
      "One tokenized real-world asset by id (gold, nvidia, tesla, spy ...): identity, type, image and web slug joined with its onchain market row - price, market cap, 24h volume and change in your currency. Two cached upstream reads, one answer. Use rwa-list to find the id.",
    tags: ["crypto", "rwa", "tokenized", "stock", "commodity", "market-data", "profile"],
    discovery: {
      input: { id: "gold", currency: "usd" },
      inputSchema: {
        properties: {
          id: { type: "string", description: "Asset id from rwa-list (gold, nvidia, tesla, ...)." },
          currency: { type: "string", description: "vs currency for the market block (default usd)." },
        },
        required: ["id"],
      },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-09-02T18:50:00.000Z", cached: false,
          id: "gold", symbol: "XAU", name: "Gold", type: "commodity", image: "https://coin-images.coingecko.com/coins/images/10481/large/logo.png", webSlug: "gold", lastUpdated: "2026-09-02T18:49:00Z",
          market: { id: "gold", symbol: "XAU", name: "Gold", type: "commodity", image: "https://coin-images.coingecko.com/coins/images/10481/large/logo.png", currency: "usd", price: 4376.6, marketCap: 5219552133, volume24h: 557496353, high24h: 4394.94, low24h: 4289.36, change24h: 42.77, change24hPct: 0.98698, marketCapChange24h: 44135859, marketCapChange24hPct: 0.8528, lastUpdated: "2026-09-02T18:49:00Z" },
        },
      },
    },
    handler: async (i) => {
      const id = takeId(i.id, "id");
      const currency = takeCurrency(i.currency);
      const meta = await cgGet(`/rwas/${encodeURIComponent(id)}`, {}, TTL.list);
      const mk = await cgGet("/rwas/markets", { vs_currency: currency, ids: id, per_page: 1, page: 1 }, TTL.price);
      const d = meta.data || {};
      const row = Array.isArray(mk.data) ? mk.data.find((r) => r?.id === id) || mk.data[0] : null;
      return {
        source: SOURCE, fetchedAt: mk.fetchedAt, cached: meta.cached && mk.cached,
        id: d.id ?? id, symbol: typeof d.symbol === "string" ? d.symbol.toUpperCase() : null, name: d.name ?? null, type: d.asset_type ?? null,
        image: d.image?.large ?? d.image?.small ?? (typeof d.image === "string" ? d.image : null), webSlug: d.web_slug ?? null, lastUpdated: d.last_updated ?? null,
        market: row ? shapeRwaMarket(row, currency) : null,
      };
    },
  },
  {
    route: "GET /api/rwa-issuers",
    name: "Tokenized asset issuers",
    slug: "rwa-issuers",
    category: "crypto",
    price: "$0.003",
    description:
      "The issuers behind tokenized real-world assets (Coinbase, Backpack Securities, Ondo, xStocks and the rest): id and name, for rwa-issuer. Cached in-process for 5 minutes.",
    tags: ["crypto", "rwa", "tokenized", "issuers", "list"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-09-02T18:50:00.000Z", cached: false, count: 33,
          issuers: [{ id: "coinbase-ecosystem", name: "Coinbase" }, { id: "backpack-securities-ecosystem", name: "Backpack Securities" }],
        },
      },
    },
    handler: async () => {
      const { data, fetchedAt, cached } = await cgGet("/rwas/issuers/list", {}, TTL.list);
      const issuers = (Array.isArray(data) ? data : []).map((x) => ({ id: x?.id ?? null, name: x?.name ?? null }));
      return { source: SOURCE, fetchedAt, cached, count: issuers.length, issuers };
    },
  },
  {
    route: "GET /api/rwa-issuer",
    name: "Tokenized asset issuer",
    slug: "rwa-issuer",
    category: "crypto",
    price: "$0.006",
    description:
      "One issuer of tokenized real-world assets by id: aggregate tokenized market cap, 24h cap change and 24h volume, plus every token it issues with symbol, name and contract address per platform (e.g. Coinbase's Base-chain tokenized Apple, Nvidia, Meta, Alphabet). Use rwa-issuers for ids. Cached in-process for 5 minutes.",
    tags: ["crypto", "rwa", "tokenized", "issuer", "contracts", "market-data"],
    discovery: {
      input: { id: "coinbase-ecosystem" },
      inputSchema: {
        properties: { id: { type: "string", description: "Issuer id from rwa-issuers (coinbase-ecosystem, ...)." } },
        required: ["id"],
      },
      output: {
        example: {
          source: "coingecko", fetchedAt: "2026-09-02T18:50:00.000Z", cached: false,
          id: "coinbase-ecosystem", name: "Coinbase", marketCap: 9982908.56, marketCapChange24h: 100918.35, volume24h: 20001148.07, updatedAt: "2026-09-02T17:00:00Z", count: 4,
          tokens: [{ id: "nvidia-coinbase-tokenized-stock", symbol: "NVDAC", name: "NVIDIA (Coinbase Tokenized Stock)", platforms: { base: "0xb20000000000000000000078ee7ce2fe4908108c" } }],
        },
      },
    },
    handler: async (i) => {
      const id = takeId(i.id, "id");
      const { data: d, fetchedAt, cached } = await cgGet(`/rwas/issuers/${encodeURIComponent(id)}`, {}, TTL.list);
      const tokens = (Array.isArray(d?.tokens) ? d.tokens : []).map((t) => ({
        id: t?.id ?? null, symbol: typeof t?.symbol === "string" ? t.symbol.toUpperCase() : null, name: t?.name ?? null,
        platforms: Object.fromEntries(Object.entries(t?.platforms || {}).filter(([k, v]) => k && typeof v === "string" && v)),
      }));
      return {
        source: SOURCE, fetchedAt, cached, id: d?.id ?? id, name: d?.name ?? null,
        marketCap: num(d?.market_cap), marketCapChange24h: num(d?.market_cap_change_24h), volume24h: num(d?.volume_24h), updatedAt: d?.updated_at ?? null,
        count: tokens.length, tokens,
      };
    },
  },
];
CRYPTO_MARKETS_TOOLS.push(...RWA_TOOLS);

export const __test = { takeId, takeCurrency, takeInt, takeBool, takeIdList, takeContracts, takeTime, takeLookback, cgGet, TTL, MAX_ENTRIES, MAX_HISTORY_DAYS, takeRwaType, shapeRwaMarket };
