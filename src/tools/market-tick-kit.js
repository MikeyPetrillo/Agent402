// Market tick: one flat-priced read of the last price for up to ten symbols,
// crypto and US equities together, for a loop that polls a price.
//
// The 2026-09-22 benchmark: a bot polling a price calls a quote tool in a
// loop and wants one cheap call. This route adds NO data source and widens
// nothing: every figure is produced by calling, in-process, the handler of a
// tool already served (crypto-price for a coin, stock-quote for an equity), so
// those kits' own caches, key budgets, hard caps and deadlines apply to every
// read made here exactly as they do on the tools' own routes.
//
// What this layer adds is a shared cache per symbol (MARKET_TICK_CACHE_MS,
// default 15 s; the shared store when REDIS_URL is set, src/tools/
// coingecko-cache.js), so a loop polling the same symbols costs one source
// read per symbol per window however many callers poll them. Each item names
// its source tool, `cached` says whether this answer came from the cache, and
// a symbol a source cannot answer is listed with its error and the answer is
// marked partial (src/partial-answer.js); when nothing answers, the call
// refuses with the source's status.
//
// Price: the price of the cheapest tool it reads from, never below it (the
// unit test derives both; neither is typed here). Cold worst case per call:
// one batched coin read plus at most MAX_EQUITIES equity reads, each of which
// the equity kit caches for the session.
//
// Switch: listed only while MARKET_TICK=on (src/market-tick-switch.js). It
// ships off: the data terms of both source tools are under review, and the
// route is listed only once what it serves is settled.
import { CRYPTO_TOOLS, isKnownCryptoSymbol, resolveCoinId } from "./crypto-kit.js";
import { FINANCE_TOOLS } from "./finance-kit.js";
import { createCgCache } from "./coingecko-cache.js";
import { partialFields } from "../partial-answer.js";
import { MARKET_TICK_SLUG, marketTickEnabled } from "../market-tick-switch.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export const MAX_SYMBOLS = 10;
// Equities are one source read per symbol on a cold cache; coins are one read
// for the whole batch. The cap keeps a cold call's reads inside its price.
export const MAX_EQUITIES = 5;
const DEFAULT_CACHE_MS = 15_000;
/** The per-symbol cache window (MARKET_TICK_CACHE_MS, default 15 s; 0 caches nothing). */
export function tickCacheMs(env = process.env) {
  const n = Number(env.MARKET_TICK_CACHE_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_CACHE_MS;
}
const CACHE_SECONDS = Math.ceil(tickCacheMs() / 1000);

export const SOURCE_SLUGS = Object.freeze({ crypto: "crypto-price", equity: "stock-quote" });

// Per-symbol entries hold one serialized item each, so the shared body bound
// is small; the process map holds every symbol a loop could poll.
const cache = createCgCache("market-tick", { max: 1000, maxBody: 4096 });
/** Test seam: drop this process's cached items. */
export function clearMarketTickCache() { cache.clear(); }

function handlerOf(list, slug) {
  const t = list.find((x) => x.slug === slug);
  if (!t || typeof t.handler !== "function") throw new Error(`market-tick: source tool ${slug} is not in its kit`);
  return t.handler;
}
let sources = null;
function sourceHandlers() {
  if (!sources) sources = { crypto: handlerOf(CRYPTO_TOOLS, SOURCE_SLUGS.crypto), equity: handlerOf(FINANCE_TOOLS, SOURCE_SLUGS.equity) };
  return sources;
}
/** Test seam: replace one or both source handlers (null restores the kits'). */
export function __setMarketTickSources(override) {
  sources = override ? { ...sourceHandlers(), ...override } : null;
}

// "BTC,ETH,AAPL": a symbol the coin map knows reads as crypto, anything else
// as a US equity ticker; "crypto:" or "equity:" forces the kind. Repeats are
// read once. Over the cap is refused, not clamped: a dropped symbol a caller
// asked for is the quiet-contract defect partial-answer.js was written for.
const SYMBOL_RE = /^(?:(crypto|equity):)?([A-Za-z0-9.\-]{1,24})$/;
export function parseSymbols(raw) {
  if (raw == null || raw === "") throw bad('"symbols" is required: a comma-separated list, e.g. BTC,ETH,AAPL (crypto: or equity: forces the kind)');
  const parts = Array.isArray(raw) ? raw : String(raw).split(",");
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const s = String(p).trim();
    if (!s) continue;
    const m = SYMBOL_RE.exec(s);
    if (!m) throw bad(`"${s.slice(0, 40)}" is not a symbol this endpoint reads: letters, digits, dot or hyphen, with an optional crypto: or equity: prefix`);
    const symbol = m[2].toUpperCase();
    const kind = m[1] || (isKnownCryptoSymbol(symbol) ? "crypto" : "equity");
    const key = `${kind}:${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ symbol, kind, key });
  }
  if (!out.length) throw bad('"symbols" is empty');
  if (out.length > MAX_SYMBOLS) throw bad(`"symbols" holds ${out.length} entries; this endpoint reads at most ${MAX_SYMBOLS} per call`);
  const equities = out.filter((x) => x.kind === "equity").length;
  if (equities > MAX_EQUITIES) throw bad(`"symbols" holds ${equities} equity tickers; this endpoint reads at most ${MAX_EQUITIES} equities per call (coins are not capped below ${MAX_SYMBOLS}). A ticker the coin map does not know reads as an equity; prefix one with crypto: to read it as a coin.`);
  return out;
}

const statusOf = (e) => (Number.isInteger(e?.statusCode) && e.statusCode >= 400 ? e.statusCode : 500);
const failure = (want, e) => ({ symbol: want.symbol, kind: want.kind, source: SOURCE_SLUGS[want.kind], ok: false, error: String(e?.message || e), status: statusOf(e) });

// One crypto-price call for every coin that missed the cache. Its answer is
// keyed by coin id, so each symbol is mapped back through the same resolver.
async function readCrypto(wants, ctx) {
  if (!wants.length) return [];
  const ids = wants.map((w) => ({ ...w, id: resolveCoinId(w.symbol) }));
  let answer;
  try {
    answer = await sourceHandlers().crypto({ coins: ids.map((w) => w.id).join(","), currency: "usd" }, ctx);
  } catch (e) {
    return ids.map((w) => failure(w, e));
  }
  return ids.map((w) => {
    const row = answer?.coins?.[w.id];
    if (!row || row.price == null) return failure(w, bad(`unknown coin: ${w.symbol} (no listed symbol or coin id matched)`, 404));
    return {
      symbol: w.symbol, kind: "crypto", id: w.id, source: SOURCE_SLUGS.crypto, ok: true,
      price: row.price, change24hPct: row.change24hPct ?? null, currency: "usd",
      asOf: row.lastUpdated ?? null,
    };
  });
}

// One stock-quote call per equity that missed the cache, in parallel.
async function readEquities(wants, ctx) {
  return Promise.all(wants.map(async (w) => {
    try {
      const q = await sourceHandlers().equity({ symbol: w.symbol }, ctx);
      return {
        symbol: w.symbol, kind: "equity", source: SOURCE_SLUGS.equity, ok: true,
        price: q.price, change24hPct: null, changePct: q.changePct ?? null, previousClose: q.previousClose ?? null,
        currency: q.currency || "USD", asOf: q.asOf ?? null,
      };
    } catch (e) {
      return failure(w, e);
    }
  }));
}

async function tick(input, ctx) {
  const wants = parseSymbols(input?.symbols);
  const ttl = tickCacheMs();
  const items = new Map();
  const misses = [];
  for (const w of wants) {
    const hit = ttl > 0 ? await cache.get(w.key) : null;
    if (hit) items.set(w.key, { ...JSON.parse(hit.text), cached: true, fetchedAt: hit.fetchedAt });
    else misses.push(w);
  }
  const fetchedAt = new Date().toISOString();
  const fresh = await Promise.all([
    readCrypto(misses.filter((w) => w.kind === "crypto"), ctx),
    readEquities(misses.filter((w) => w.kind === "equity"), ctx),
  ]);
  for (const item of fresh.flat()) {
    const key = `${item.kind}:${item.symbol}`;
    // Only an answer is kept: a refusal is read again on the next call.
    if (item.ok && ttl > 0) cache.put(key, JSON.stringify(item), ttl, fetchedAt);
    items.set(key, { ...item, cached: false, fetchedAt });
  }
  const ordered = wants.map((w) => items.get(w.key));
  const served = ordered.filter((i) => i.ok);
  const failed = ordered.filter((i) => !i.ok);
  if (!served.length) {
    // The first symbol's status: a 4xx names the caller's input, a 5xx the
    // source, and either way the message lists every symbol with its reason.
    throw bad(`no symbol answered: ${failed.map((f) => `${f.symbol}: ${f.error}`).join("; ")}`, failed[0].status);
  }
  return {
    asOf: fetchedAt,
    cacheSeconds: Math.ceil(ttl / 1000),
    cached: ordered.every((i) => i.cached),
    sources: { ...SOURCE_SLUGS },
    items: ordered,
    ...partialFields(wants.length, served.length),
    ...(failed.length ? { failed: failed.map((f) => f.symbol) } : {}),
  };
}

export const MARKET_TICK_TOOLS = [
  {
    route: "GET /api/market/tick",
    name: "Market tick",
    slug: MARKET_TICK_SLUG,
    category: "data",
    price: "$0.001",
    description:
      `Last price for up to ${MAX_SYMBOLS} symbols in one flat-priced call, crypto and US equities together, built for a loop that polls a price. Nothing is read from a new source: each coin figure is the crypto-price tool's answer (last price and 24h change in USD) and each equity figure is the stock-quote tool's answer (end-of-day close, previous close and the change between them; no intraday print), called in-process with their own caches, budgets and deadlines. Figures are cached server-side per symbol for up to ${CACHE_SECONDS} seconds, so a loop polling the same symbols costs one source read per symbol per window; cached says whether this answer came from that cache and every item names its source tool. A bare symbol the coin map knows (BTC, ETH, SOL and the other top coins by market cap) reads as crypto and anything else as a US equity ticker; a crypto: or equity: prefix forces the kind. At most ${MAX_EQUITIES} equity tickers per call. A symbol a source cannot answer is listed with its error and the answer carries the partial fields (returned, matched, complete); when no symbol answers, the call is refused with the source's status.`,
    tags: ["market-data", "price", "crypto", "stocks", "quote", "tick", "polling", "bitcoin", "ethereum"],
    discovery: {
      input: { symbols: "BTC,ETH,AAPL" },
      inputSchema: {
        properties: {
          symbols: { type: "string", description: `Comma-separated symbols, at most ${MAX_SYMBOLS} (at most ${MAX_EQUITIES} equities), e.g. "BTC,ETH,AAPL". A known coin symbol reads as crypto, anything else as a US equity; "crypto:LINK" or "equity:LINK" forces the kind.` },
        },
        required: ["symbols"],
      },
      output: {
        example: {
          asOf: "2026-10-14T13:05:12.000Z",
          cacheSeconds: CACHE_SECONDS,
          cached: false,
          sources: { crypto: "crypto-price", equity: "stock-quote" },
          items: [
            { symbol: "BTC", kind: "crypto", id: "bitcoin", source: "crypto-price", ok: true, price: 67234.12, change24hPct: 1.42, currency: "usd", asOf: "2026-10-14T13:05:00.000Z", cached: false, fetchedAt: "2026-10-14T13:05:12.000Z" },
            { symbol: "ETH", kind: "crypto", id: "ethereum", source: "crypto-price", ok: true, price: 3520.45, change24hPct: 2.18, currency: "usd", asOf: "2026-10-14T13:05:00.000Z", cached: false, fetchedAt: "2026-10-14T13:05:12.000Z" },
            { symbol: "AAPL", kind: "equity", source: "stock-quote", ok: true, price: 341.27, change24hPct: null, changePct: 0.088, previousClose: 340.97, currency: "USD", asOf: "2026-10-13", cached: false, fetchedAt: "2026-10-14T13:05:12.000Z" },
          ],
          returned: 3,
          matched: 3,
          complete: true,
          truncated: false,
        },
      },
    },
    handler: tick,
  },
];

/** The kit as the server lists it: every tool with MARKET_TICK=on, none without. */
export function marketTickToolsEnabled(env = process.env) {
  return marketTickEnabled(env) ? MARKET_TICK_TOOLS : [];
}
