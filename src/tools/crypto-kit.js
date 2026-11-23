// Crypto-kit — live market data for crypto, complementing finance-kit's
// equity coverage. Yahoo serves BTC-USD via /stock-quote but that's a single
// price point; this kit unlocks the richer crypto-native surface: 24h volume,
// market cap rank, historical OHLC, trending coins, and global market metrics.
//
// Upstream: CoinGecko's API (host and key header from coingecko-endpoint.js). Keyless,
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
import { upstreamFetch, bodyUnderDeadline, underBudgetAll, PAYMENT_WINDOW_BUDGET_MS, budgetSpent, currentBudget } from "../upstream-deadline.js";
const CRYPTO_READ_MS = 10_000;
const CRYPTO_RETRY_READ_MS = 12_000;
import { cgTake, cgRefusal, isCoinGeckoHost, cgScopeAll, cgNoteUnknownId, cgUnknownIdOfPath } from "./coingecko-rate.js";
import { cgBase, cgKeyHeaders } from "./coingecko-endpoint.js";
import { attribute, creditAnswers, addCredit, COINGECKO_CREDIT, HYPERLIQUID_ATTRIBUTION } from "../data-attribution.js";
import { markResaleBarred, markResaleComputed, markRefAnswer, MARKET_DATA_RESALE_REASON } from "../resale-terms.js";
import { createCgCache } from "./coingecko-cache.js";
import { knownIdsGate, knownIdGate, seriesSummary } from "./crypto-markets-kit.js";
import { hlSharedInfo } from "./hyperliquid-shared.js";
import { partialFields } from "../partial-answer.js";
import { upstreamErrorText } from "./redact.js";

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

const ID_TO_SYMBOL = Object.freeze(Object.fromEntries(Object.entries(SYMBOL_TO_ID).map(([sym, id]) => [id, sym])));

export function resolveCoinId(raw) {
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

// The coin and currency gates in this kit's own words (status and message):
// the list check is crypto-markets-kit's, the refusal reads as this kit's
// upstream 404 and currency refusals always have.
async function coinGate(id) {
  try { await knownIdGate("coin", id); } catch (err) { if (err?.unknownId) throw bad("CoinGecko returned 404 - unknown coin or market", 422); throw err; }
}
async function currencyGate(currency) {
  try { await knownIdGate("currency", currency); } catch (err) { if (err?.unknownId) throw bad(`currency "${currency}" is not supported by CoinGecko (try usd, eur, gbp, btc, eth)`); throw err; }
}

// Short cache for CoinGecko reads, keyed on the exact URL. An identical
// request inside the window gets the same answer the upstream gave moments ago
// and spends no key budget, on this replica or another
// (src/tools/coingecko-cache.js). Text is stored, so every caller parses its
// own copy. A body over 256 KB is served but not kept, so the cache stays small.
const CG_CACHE_TTL_MS = 30_000;
const CG_CACHE_MAX = 200;
const cgCache = createCgCache("crypto", { max: CG_CACHE_MAX, maxBody: 256 * 1024 });
/** Test seam: drop every cached CoinGecko answer. */
export function clearCryptoCache() { cgCache.clear(); }

// CoinGecko error codes on a 401/403. Plan/range codes are about the request
// (an endpoint or a date range the key does not serve); everything else on a
// 401/403 is this server's key, which no buyer input can fix.
const CG_PLAN_CODES = new Set([10005, 10012]);
function cgErrorCode(text) {
  try { const b = JSON.parse(text); const c = b?.status?.error_code ?? b?.error?.status?.error_code; return c != null && Number.isFinite(Number(c)) ? Number(c) : null; } catch { return null; }
}

async function jsonGet(url, host = "CoinGecko") {
  const safeUrl = await assertPublicUrl(url, { ownUpstream: true });
  // CoinGecko Demo key (env-gated; keyless works too, just worse): keyless
  // requests are rate-limited PER IP — and Railway egress IPs are shared, so
  // the effective quota is whatever other tenants left. A key moves metering
  // to our own quota. Gated to CoinGecko hosts only: the key must never ride
  // a request to another host.
  const isCg = isCoinGeckoHost(safeUrl.hostname);
  if (!isCg) return (await jsonLoad(safeUrl, host, { isCg })).data;
  const { entry } = await cgCache.through(safeUrl.toString(), CG_CACHE_TTL_MS, () => jsonLoad(safeUrl, host, { isCg }));
  return JSON.parse(entry.text);
}

// One upstream read for jsonGet: the body of a 200 that parses as JSON, as
// { text, data }, or a thrown refusal (never cached).
async function jsonLoad(safeUrl, host, { isCg }) {
  // The key's budget is ONE bucket shared with crypto-markets-kit
  // (coingecko-rate.js). Refuse before the upstream call when it is spent:
  // 503 is never charged. Every request that goes out takes a token,
  // retries included.
  if (isCg) {
    const why = await cgTake(Date.now());
    if (why) throw cgRefusal(why);
  }
  // DEADLINES (src/upstream-deadline.js): each attempt runs under its own cap
  // and the handler budget, so the retry gets what remains instead of a second
  // full cap; a read that outlives it is a 503 naming the upstream and the
  // step, never a 504. The reads answered in 0.04 to 0.3 s when measured
  // (2026-10-14).
  const attempt = (timeout) =>
    upstreamFetch(safeUrl, {
      headers: {
        "User-Agent": cryptoUserAgent(),
        Accept: "application/json",
        // Key header for the configured tier (coingecko-endpoint.js), only
        // on a CoinGecko host.
        ...(isCg ? cgKeyHeaders() : {}),
      },
    }, { label: host, step: "query", timeoutMs: timeout, tag: "[crypto]" });
  const mayRetry = async () => !isCg || (await cgTake(Date.now())) === null;
  let res;
  try {
    res = await attempt(CRYPTO_READ_MS);
  } catch (e) {
    // Single retry on a deadline or transport failure (same pattern as
    // finance-kit), only while the budget can hold another read.
    if (!(await mayRetry()) || budgetSpent(currentBudget(), 2_000)) throw e;
    res = await attempt(CRYPTO_RETRY_READ_MS);
  }
  // Retry once on 429/5xx after a short backoff. CoinGecko burst-limits per
  // IP; a chained skill pack (crypto-dossier: price → history → trending →
  // global) fires four CG calls in ~3s and the fourth intermittently 429s —
  // the backoff clears the burst window without threatening the pack's
  // overall time budget. (finance-kit/gov-kit carry the same 5xx retry.)
  if ((res.status === 429 || res.status >= 500) && !budgetSpent(currentBudget(), 4_500)) {
    await new Promise((r) => setTimeout(r, 2500));
    if (await mayRetry()) {
      try {
        const retryRes = await attempt(CRYPTO_RETRY_READ_MS);
        if (retryRes.ok || retryRes.status !== res.status) res = retryRes;
      } catch { /* fall through with the original response */ }
    }
  }
  const text = await res.text();
  if (!res.ok) {
    const s = res.status;
    if (s === 404) {
      // The upstream's verdict on a coin id this path reads, kept for the day (knownIdsGate).
      const named = isCg ? cgUnknownIdOfPath(safeUrl.pathname) : null;
      if (named) cgNoteUnknownId(named.kind, named.id);
      throw bad(`${host} returned 404 - unknown coin or market`, 422);
    }
    if (s === 429) throw bad(`${host} rate-limited the request - retry shortly`, 503);
    if (s >= 500) throw bad(`${host} upstream HTTP ${s} - try again later`, 502);
    if (isCg && (s === 401 || s === 403) && !CG_PLAN_CODES.has(cgErrorCode(text))) {
      throw bad(`${host} is not configured on this deployment. You were not charged.`, 503);
    }
    // Redact the FULL upstream body before slicing (a secret straddling the
    // 200-char cut would otherwise leave an unredactable prefix): the CoinGecko
    // demo key rides this request and there is no 401/403 shield above.
    throw bad(`${host} HTTP ${s}: ${upstreamErrorText(text, 200)}`, 422);
  }
  let data;
  try { data = JSON.parse(text); }
  catch { throw bad(`${host} returned non-JSON response`, 502); }
  return { text, data };
}

// --- crypto-price's second source ------------------------------------------------
// A USD price is checked against the oracle price of the same coin's
// perpetual on Hyperliquid, an on-chain perp exchange whose validators publish
// a spot index every few seconds. The document is the universe-wide one the
// derivatives and signals kits already read, through the cache they share
// (src/tools/hyperliquid-shared.js: one read per 5 s for every caller, a copy
// at most a minute old when the host refuses for rate), so the check rarely
// spends a read of its own. It runs after the price read, under its own short
// cap; a check that cannot be read leaves the price answer as it is
// (`check: "unavailable"`) and is not tried again for CHECK_BACKOFF_MS.
// Only coins in the symbol map above are matched, by ticker, to a listed
// (not delisted) perp: "BTC", or "kPEPE" quoted per 1,000 units.
const HL_INFO = "https://api.hyperliquid.xyz/info";
export const CHECK_READ_MS = 1_500;
export const CHECK_BACKOFF_MS = 30_000;
// A price whose upstream timestamp is older than this reads stale: true.
export const STALE_AFTER_SECONDS = 600;
export const CHECK_SOURCE = "hyperliquid-oracle";
let checkDownUntil = 0;
const referenceMaps = new WeakMap(); // a universe document -> Map(name -> oracle price)

// The shared cache stores what a transport returns, for every kit that reads
// it, so this one returns only a document of the expected shape.
async function hlReferenceDoc(payload) {
  const ctx = { label: "Hyperliquid", step: "reference price", timeoutMs: CHECK_READ_MS, tag: "[crypto]" };
  const res = await upstreamFetch(HL_INFO, {
    method: "POST",
    headers: { "User-Agent": cryptoUserAgent(), Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, ctx);
  const text = await bodyUnderDeadline(res.text(), ctx);
  if (res.status === 429) throw Object.assign(bad("Hyperliquid rate limit reached upstream - retry shortly", 503), { rateLimited: true, retryAfter: 5 });
  if (!res.ok) throw bad(`Hyperliquid upstream HTTP ${res.status}`, 502);
  let json;
  try { json = JSON.parse(text); } catch { throw bad("Hyperliquid returned a non-JSON response", 502); }
  if (!referenceMapOf(json)) throw bad("Hyperliquid returned an unexpected response shape", 502);
  return json;
}

function referenceMapOf(doc) {
  if (doc && typeof doc === "object" && referenceMaps.has(doc)) return referenceMaps.get(doc);
  const universe = Array.isArray(doc) ? doc[0]?.universe : null;
  const ctxs = Array.isArray(doc) ? doc[1] : null;
  if (!Array.isArray(universe) || !Array.isArray(ctxs)) return null;
  const map = new Map();
  for (let k = 0; k < universe.length; k++) {
    const u = universe[k], c = ctxs[k];
    if (!u || !c || u.isDelisted || typeof u.name !== "string") continue;
    const px = Number(c.oraclePx);
    if (Number.isFinite(px) && px > 0) map.set(u.name, px);
  }
  referenceMaps.set(doc, map);
  return map;
}

/** The reference USD price for a coin id from a reference map, or null. */
export function referencePriceOf(map, id) {
  const sym = Object.hasOwn(ID_TO_SYMBOL, id) ? ID_TO_SYMBOL[id] : null;
  if (!map || !sym) return null;
  if (map.has(sym)) return map.get(sym);
  if (map.has(`k${sym}`)) return map.get(`k${sym}`) / 1000;
  return null;
}

/** The reference map, or null when it cannot be read inside the cap (then
 *  not tried again for CHECK_BACKOFF_MS). Never throws. */
async function readReferenceMap() {
  if (Date.now() < checkDownUntil) return null;
  let timer;
  const read = hlSharedInfo({ type: "metaAndAssetCtxs" }, hlReferenceDoc)
    .then(referenceMapOf, () => null)
    .then((map) => { if (!map) checkDownUntil = Date.now() + CHECK_BACKOFF_MS; return map; });
  // A read joined in flight from another kit runs under that kit's cap, so
  // the wait here has its own bound (cleared as soon as the read settles).
  const bound = new Promise((resolve) => { timer = setTimeout(resolve, CHECK_READ_MS + 250, null); });
  const map = await Promise.race([read, bound]);
  clearTimeout(timer);
  return map;
}
/** `answer` crediting the second source (Hyperliquid's oracle prices, by name
 *  and link; src/data-attribution.js) when `check` says its read was used,
 *  after the price source's own credit (the callers are CoinGecko-backed). */
export function checkCredited(answer, check) {
  return check === CHECK_SOURCE ? addCredit(addCredit(answer, COINGECKO_CREDIT), HYPERLIQUID_ATTRIBUTION) : answer;
}
/** The credit of an answer whose check read the second source. */
export const CHECKED_CREDIT = `${COINGECKO_CREDIT} ${HYPERLIQUID_ATTRIBUTION}`;
/** Test seam: forget a failed check, so the next call reads again. */
export function resetPriceCheck() { checkDownUntil = 0; }

/**
 * The check a price answer carries, written onto its rows: `stale` (the
 * upstream timestamp is older than STALE_AFTER_SECONDS; null with no
 * timestamp) and `divergencePct` (a USD price's gap to the second source, in
 * percent; null where that source lists no market for the coin, or no check
 * ran). `entries` is [coinId, row] pairs, each row holding `price` and
 * `lastUpdated`. Returns the answer's `check` word: the second source's name,
 * "usd-only", "no-reference" (no coin asked has a mapped market) or
 * "unavailable". Never throws; at most one reference read.
 */
export async function applyPriceCheck(entries, currency) {
  let check = "usd-only", map = null;
  if (currency === "usd") {
    if (!entries.some(([id]) => Object.hasOwn(ID_TO_SYMBOL, id))) check = "no-reference";
    else { map = await readReferenceMap(); check = map ? CHECK_SOURCE : "unavailable"; }
  }
  const now = Date.now();
  for (const [id, row] of entries) {
    const at = row.lastUpdated ? Date.parse(row.lastUpdated) : NaN;
    row.stale = Number.isFinite(at) ? (now - at) / 1000 > STALE_AFTER_SECONDS : null;
    const ref = referencePriceOf(map, id);
    row.divergencePct = ref && typeof row.price === "number" ? +(((row.price - ref) / ref) * 100).toFixed(4) : null;
  }
  return check;
}

// --- crypto-market's screen ---------------------------------------------------------
// With any screen field (or a sort other than rank), crypto-market reads the
// top SCREEN_UNIVERSE coins by market cap in one upstream read, applies the
// screen and the sort here, and answers at most `limit` rows with the fields
// that say how many matched and that coins below that rank were not read
// (src/partial-answer.js).
export const SCREEN_UNIVERSE = 250;
const SCREEN_SORTS = Object.freeze({
  rank: (a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9),
  change24h_desc: (a, b) => (b.change24hPct ?? -Infinity) - (a.change24hPct ?? -Infinity),
  change24h_asc: (a, b) => (a.change24hPct ?? Infinity) - (b.change24hPct ?? Infinity),
  change7d_desc: (a, b) => (b.change7dPct ?? -Infinity) - (a.change7dPct ?? -Infinity),
  change7d_asc: (a, b) => (a.change7dPct ?? Infinity) - (b.change7dPct ?? Infinity),
  volume_desc: (a, b) => (b.volume24h ?? -Infinity) - (a.volume24h ?? -Infinity),
  turnover_desc: (a, b) => (b.turnoverPct ?? -Infinity) - (a.turnoverPct ?? -Infinity),
});
// field -> [row key, comparison]: a row passes when its value exists and meets the bound.
const SCREEN_FIELDS = Object.freeze({
  minMarketCap: ["marketCap", "min"],
  minVolume24h: ["volume24h", "min"],
  minTurnoverPct: ["turnoverPct", "min"],
  minChange24hPct: ["change24hPct", "min"],
  maxChange24hPct: ["change24hPct", "max"],
  maxBelowAthPct: ["athDrawdownPct", "nearAth"],
});
function screenNumber(raw, field) {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^\s*-?\d+(\.\d+)?(e\d+)?\s*$/i.test(raw) ? Number(raw) : NaN);
  if (!Number.isFinite(n)) throw bad(`"${field}" must be a number`);
  if (field !== "minChange24hPct" && field !== "maxChange24hPct" && n < 0) throw bad(`"${field}" must not be negative`);
  if (field === "maxBelowAthPct" && n > 100) throw bad('"maxBelowAthPct" must be 0-100');
  return n;
}
function takeScreen(i) {
  const filters = {};
  for (const field of Object.keys(SCREEN_FIELDS)) {
    const n = screenNumber(i?.[field], field);
    if (n != null) filters[field] = n;
  }
  const sort = i?.sort == null || i.sort === "" ? "rank" : String(i.sort).trim().toLowerCase();
  if (!Object.hasOwn(SCREEN_SORTS, sort)) throw bad(`"sort" must be one of ${Object.keys(SCREEN_SORTS).join(", ")}`);
  if (filters.minChange24hPct != null && filters.maxChange24hPct != null && filters.minChange24hPct > filters.maxChange24hPct) throw bad('"minChange24hPct" is above "maxChange24hPct"');
  return { filters, sort, active: Object.keys(filters).length > 0 || sort !== "rank" };
}
function passesScreen(row, filters) {
  for (const [field, bound] of Object.entries(filters)) {
    const [key, how] = SCREEN_FIELDS[field];
    const v = row[key];
    if (v == null) return false;
    if (how === "min" && v < bound) return false;
    if (how === "max" && v > bound) return false;
    if (how === "nearAth" && v < -bound) return false;
  }
  return true;
}


export const CRYPTO_TOOLS = [
  {
    route: "GET /api/crypto-price",
    name: "Crypto price",
    slug: "crypto-price",
    category: "data",
    price: "$0.001",
    description:
      "Checked live crypto prices for one or many coins in any vs_currency (usd, eur, btc, eth, etc). Returns last price, 24h change %, 24h volume, and market cap per coin, each with stale (upstream timestamp older than 10 minutes) and, in usd, divergencePct: the gap to the oracle price of the coin's perpetual on Hyperliquid, an on-chain perp exchange (null where it lists none); check names that second source or says why no check ran. For ranked market-cap tables use crypto-market, for candles use crypto-history. Accepts ticker symbols (BTC, ETH, SOL) for the top ~50 by market cap, or canonical coin ids (e.g. \"render-token\") for any of the ~15k tracked coins. Batched: up to 25 coins per call.",
    tags: ["crypto", "price", "market-data", "bitcoin", "ethereum", "defi", "cryptocurrency", "btc", "eth", "spot"],
    discovery: {
      input: { coins: "BTC,ETH", currency: "usd" },
      inputSchema: {
        properties: {
          coins: { type: "string", description: "Comma-separated symbols or ids (e.g. \"BTC,ETH\" or \"bitcoin,ethereum\"). Max 25." },
          currency: { type: "string", maxLength: 8, description: "vs_currency (default: usd). Accepts fiat (usd, eur, gbp, jpy) or crypto (btc, eth)." },
        },
        required: ["coins"],
      },
      output: {
        example: {
          currency: "usd",
          count: 2,
          check: "hyperliquid-oracle",
          credit: CHECKED_CREDIT,
          coins: {
            bitcoin: { price: 67234.12, change24hPct: 1.42, volume24h: 28100000000, marketCap: 1320000000000, lastUpdated: "2026-06-20T00:30:00Z", stale: false, divergencePct: 0.03 },
            ethereum: { price: 3520.45, change24hPct: 2.18, volume24h: 14200000000, marketCap: 423000000000, lastUpdated: "2026-06-20T00:30:00Z", stale: false, divergencePct: -0.05 },
          },
        },
      },
    },
    handler: async (i) => {
      const ids = resolveCoinList(i.coins, 25);
      const currency = normalizeCurrency(i.currency);
      // Ids and the currency are checked against their lists first once the
      // share of the day kept for unpaid calls is full (crypto-markets-kit
      // knownIdsGate): nothing known is answered with no read.
      const gate = await knownIdsGate("coin", ids);
      if (!gate.known.length) throw bad(`unknown coin(s): ${gate.unknown.join(", ")} - use a CoinGecko id or a listed symbol`, 404);
      await currencyGate(currency);
      const url = `${cgBase()}/simple/price?ids=${encodeURIComponent(gate.known.join(","))}&vs_currencies=${encodeURIComponent(currency)}&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true`;
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
      // A symbol nothing resolved to used to come back as a 200 with coins:{}
      // and count 0 - a charged answer with nothing in it (corpus, 2026-09-06).
      // Nothing known -> 404 naming the input; a partial miss is listed.
      const unknown = ids.filter((id) => !out[id]);
      if (!Object.keys(out).length) throw bad(`unknown coin(s): ${unknown.join(", ")} - use a CoinGecko id or a listed symbol`, 404);
      if (Object.values(out).every((row) => row.price === null)) throw bad(`currency "${currency}" is not supported by CoinGecko's simple price endpoint (try usd, eur, gbp, btc, eth)`);
      // The check: every price says whether its upstream timestamp is stale,
      // and a USD price says how far it sits from the second source (null
      // where that source has no listed market for the coin, or no check ran).
      const check = await applyPriceCheck(Object.entries(out), currency);
      return checkCredited({ currency, count: Object.keys(out).length, check, coins: out, ...(unknown.length ? { unknown } : {}) }, check);
    },
  },

  {
    route: "GET /api/crypto-market",
    name: "Crypto market overview",
    slug: "crypto-market",
    category: "data",
    price: "$0.003",
    description:
      "Top N coins by market capitalization with full market snapshot per coin: rank, price, 24h change, 7d change, 24h volume, market cap, circulating supply, and all-time high, plus computed turnover and distance below that high. Default 10, max 100 per call, or screen the top 250 with min/max filters and a sort. As a screener, any of minMarketCap, minVolume24h, minTurnoverPct (24h volume as a percent of market cap), minChange24hPct, maxChange24hPct, maxBelowAthPct, or a sort (change24h_desc, change24h_asc, change7d_desc, change7d_asc, volume_desc, turnover_desc) screens the top 250 by market cap and answers up to limit rows, with matched, returned, complete and truncated, and scan fields that say no coin below rank 250 was read.",
    tags: ["crypto", "market", "ranking", "marketcap", "top-coins", "screener"],
    discovery: {
      input: { limit: 10, currency: "usd" },
      inputSchema: {
        properties: {
          limit: { type: "number", description: "Number of coins to return (1-100, default 10)" },
          currency: { type: "string", maxLength: 8, description: "vs_currency (default: usd)" },
          minMarketCap: { type: "number", description: "Screen: market cap at least this" },
          minVolume24h: { type: "number", description: "Screen: 24h volume at least this" },
          minTurnoverPct: { type: "number", description: "Screen: 24h volume / market cap, percent" },
          minChange24hPct: { type: "number", description: "Screen: 24h change at least this percent" },
          maxChange24hPct: { type: "number", description: "Screen: 24h change at most this percent" },
          maxBelowAthPct: { type: "number", description: "Screen: at most this percent below the all-time high" },
          sort: { type: "string", description: "rank (default), change24h_desc, change24h_asc, change7d_desc, change7d_asc, volume_desc, turnover_desc" },
        },
      },
      output: {
        example: {
          currency: "usd",
          count: 1,
          coins: [
            { rank: 1, id: "bitcoin", symbol: "btc", name: "Bitcoin", price: 67234.12, change24hPct: 1.42, change7dPct: 4.81, volume24h: 28100000000, marketCap: 1320000000000, circulatingSupply: 19700000, ath: 73750, athDate: "2024-03-14T07:10:36Z", turnoverPct: 2.1288, athDrawdownPct: -8.835 },
          ],
        },
      },
    },
    handler: async (i) => {
      const limit = Number.isFinite(i.limit) ? Math.floor(i.limit) : (typeof i.limit === "string" ? parseInt(i.limit, 10) : 10);
      if (!Number.isFinite(limit) || limit < 1 || limit > 100) throw bad('"limit" must be an integer 1-100');
      const currency = normalizeCurrency(i.currency);
      const screen = takeScreen(i);
      await currencyGate(currency);
      // A screen reads the whole universe it screens; a plain call reads only the top `limit`.
      const perPage = screen.active ? SCREEN_UNIVERSE : limit;
      const url = `${cgBase()}/coins/markets?vs_currency=${encodeURIComponent(currency)}&order=market_cap_desc&per_page=${perPage}&page=1&price_change_percentage=24h,7d`;
      const data = await jsonGet(url);
      if (!Array.isArray(data)) throw bad("CoinGecko returned unexpected shape for /coins/markets", 502);
      const pctOf = (part, whole) => (typeof part === "number" && typeof whole === "number" && whole > 0 ? +((part / whole) * 100).toFixed(4) : null);
      const rows = data.map((c) => {
        const price = c.current_price ?? null, ath = c.ath ?? null;
        const volume24h = c.total_volume ?? null, marketCap = c.market_cap ?? null;
        return {
          rank: c.market_cap_rank ?? null,
          id: c.id,
          symbol: c.symbol,
          name: c.name,
          price,
          change24hPct: c.price_change_percentage_24h_in_currency != null ? +c.price_change_percentage_24h_in_currency.toFixed(4) : null,
          change7dPct: c.price_change_percentage_7d_in_currency != null ? +c.price_change_percentage_7d_in_currency.toFixed(4) : null,
          volume24h,
          marketCap,
          circulatingSupply: c.circulating_supply ?? null,
          ath,
          athDate: c.ath_date ?? null,
          // Computed here: a day's volume as a share of market cap, and the
          // distance below the all-time high (0 at a new high).
          turnoverPct: pctOf(volume24h, marketCap),
          athDrawdownPct: typeof price === "number" && typeof ath === "number" && ath > 0 ? +(Math.min(0, (price / ath - 1) * 100)).toFixed(4) : null,
        };
      });
      if (!screen.active) return { currency, count: rows.length, coins: rows };
      const matched = rows.filter((r) => passesScreen(r, screen.filters)).sort(SCREEN_SORTS[screen.sort]);
      const coins = matched.slice(0, limit);
      return {
        currency, count: coins.length,
        screen: { sort: screen.sort, filters: screen.filters },
        ...partialFields(matched.length, coins.length),
        scanned: rows.length, scanCap: SCREEN_UNIVERSE, scanCoversAll: false,
        scanNote: `Only the top ${rows.length} coins by market cap were screened; a coin below that rank is not in this answer even when it would pass.`,
        coins,
      };
    },
  },

  {
    route: "GET /api/crypto-history",
    name: "Crypto price history",
    slug: "crypto-history",
    category: "data",
    price: "$0.015",
    description:
      "Crypto price series over a window of days, led by its summary (return, annualized volatility, max drawdown, first/last/high/low), then bars[] of {time, price, marketCap, volume}. Granularity is automatic: <=1 day = 5-min bars, 2-90 days = hourly, >90 days = daily. Days: 1, 7, 14, 30, 90, 180, 365, or \"max\".",
    tags: ["crypto", "history", "chart", "backtest", "timeseries"],
    discovery: {
      input: { coin: "BTC", days: "7", currency: "usd" },
      inputSchema: {
        properties: {
          coin: { type: "string", maxLength: 64, description: "Symbol (BTC) or id (bitcoin)" },
          days: { type: "string", description: "1, 7, 14, 30, 90, 180, 365, or \"max\" (default 7)" },
          currency: { type: "string", maxLength: 8, description: "vs_currency (default: usd)" },
        },
        required: ["coin"],
      },
      output: {
        example: {
          coin: "bitcoin",
          currency: "usd",
          days: "7",
          summary: { first: 66120.45, last: 67234.12, high: 68010.2, low: 65480.9, changePct: 1.6843, volatilityPct: 38.21, maxDrawdownPct: -3.72 },
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
      await coinGate(id);
      await currencyGate(currency);
      const url = `${cgBase()}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=${encodeURIComponent(currency)}&days=${encodeURIComponent(daysRaw)}`;
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
      // The series leads with its statistics (crypto-markets-kit seriesSummary).
      const summary = seriesSummary(prices.map(([t]) => t), prices.map(([, p]) => p));
      return { coin: id, currency, days: daysRaw, summary, count: bars.length, bars };
    },
  },

  {
    route: "GET /api/crypto-trending",
    name: "Crypto trending",
    slug: "crypto-trending",
    category: "data",
    price: "$0.001",
    description:
      "Trending coins in the last 24 hours, ranked by user search activity on the market-data site (currently ~15 results). Includes coin id, symbol, market cap rank, current price (BTC-denominated), and score. Useful signal for detecting narrative shifts before they hit price charts.",
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
      const data = await jsonGet(`${cgBase()}/search/trending`);
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
    price: "$0.003",
    description:
      "Global crypto market snapshot: total market cap, total 24h volume, BTC dominance, ETH dominance, active coin count, active exchange count, and 24h market-cap change %. Returned in a chosen vs_currency (default usd).",
    tags: ["crypto", "global", "market", "dominance", "macro"],
    discovery: {
      input: { currency: "usd" },
      inputSchema: {
        properties: {
          currency: { type: "string", maxLength: 8, description: "vs_currency for cap/volume (default: usd)" },
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
      const data = await jsonGet(`${cgBase()}/global`);
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
    route: "GET /api/stablecoin-peg",
    name: "Stablecoin peg monitor",
    slug: "stablecoin-peg",
    category: "crypto",
    price: "$0.003",
    description:
      "Live $1-peg deviation for the top USD stablecoins (USDT, USDC, USDS, DAI, USDe, PYUSD, USDD, TUSD, FDUSD by default, or pass your own list): current price, deviation in basis points, 24h high/low, worst 24h deviation, market cap, and an on-peg / stressed / depegged status.",
    tags: ["crypto", "stablecoin", "peg", "usdt", "usdc", "risk", "monitoring"],
    discovery: {
      input: {},
      inputSchema: {
        properties: {
          coins: { type: "string", description: "Optional comma-separated symbols or coin ids to check instead of the default top-stablecoin set (e.g. \"USDT,USDC\"). Max 15." },
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
      const asked = i.coins != null && i.coins !== "" ? resolveCoinList(i.coins, 15) : DEFAULT_STABLECOINS;
      const { known: ids } = asked === DEFAULT_STABLECOINS ? { known: asked } : await knownIdsGate("coin", asked);
      if (!ids.length) throw bad("No CoinGecko data for the requested coins - check the ids/symbols", 422);
      const url = `${cgBase()}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids.join(","))}&order=market_cap_desc`;
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
// The CoinGecko-backed tools carry the attribution its terms require (see
// COINGECKO_ATTRIBUTION in coingecko-rate.js), in the description and as the
// `credit` field of every answer.
for (const t of CRYPTO_TOOLS) creditAnswers(attribute(t, "coingecko"), COINGECKO_CREDIT);
// Resale terms (src/resale-terms.js): these answer the source's data as it
// came, so they are not resold through a third party; stablecoin-peg answers
// a deviation and a band computed here.
markResaleBarred(CRYPTO_TOOLS, ["crypto-price", "crypto-market", "crypto-history", "crypto-trending", "crypto-global"], MARKET_DATA_RESALE_REASON);
markResaleComputed(CRYPTO_TOOLS, ["stablecoin-peg"]);
// On a /ref copy and on /aws (both resold through a third party) stablecoin-peg serves what it
// computes and the credit, without the source's own figures per coin (price,
// 24h high and low, market cap). The public route's answer is unchanged.
export const STABLECOIN_PEG_REF_RAW_FIELDS = Object.freeze(["price", "high24h", "low24h", "marketCap"]);
markRefAnswer(CRYPTO_TOOLS, ["stablecoin-peg"], (answer) => {
  if (!answer || typeof answer !== "object" || !Array.isArray(answer.coins)) return answer;
  const coins = answer.coins.map((c) => {
    if (!c || typeof c !== "object") return c;
    const kept = { ...c };
    for (const k of STABLECOIN_PEG_REF_RAW_FIELDS) delete kept[k];
    return kept;
  });
  return { ...answer, coins };
});

// Every handler runs under one budget (src/upstream-deadline.js).
// A call that ends in an error counts its CoinGecko reads on the unsettled
// share of the day (src/tools/coingecko-rate.js).
underBudgetAll(cgScopeAll(CRYPTO_TOOLS), PAYMENT_WINDOW_BUDGET_MS);
