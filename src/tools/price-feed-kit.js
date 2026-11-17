// Price-feed kit: one deterministic gateway tool over a public price feed:
//
//   • price-coingecko — CoinGecko public simple/price (keyless free tier)
//
// Wallet-only (each call costs egress + counts against the upstream's public
// rate limit), never PoW-eligible. Covered by scripts/test-price-feed-kit.js.

import { cgTake, cgRefusal, isCoinGeckoHost } from "./coingecko-rate.js";
import { cgBase, cgKeyHeaders } from "./coingecko-endpoint.js";
import { attribute, creditAnswers, COINGECKO_CREDIT } from "../data-attribution.js";
import { createCgCache } from "./coingecko-cache.js";
import { upstreamFetch, bodyUnderDeadline, underBudgetAll, PAYMENT_WINDOW_BUDGET_MS } from "../upstream-deadline.js";
// DEADLINES (src/upstream-deadline.js): each read has its own cap, composed
// with the handler budget, and a read that outlives it is a 503 naming the
// upstream and the step, never a 504. The simple-price read answered in 0.15 s
// when measured (2026-10-14), so the cap below leaves room for a slow day.
const FEED_READ_MS = 10_000;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Short cache for CoinGecko reads, keyed on the exact URL: an identical
// request inside the window gets the answer fetched moments ago and spends no
// key budget, on this replica or another (src/tools/coingecko-cache.js). Text
// is stored, so every caller parses its own copy. A body over 256 KB is served
// but not kept, so the cache stays small.
const CG_CACHE_TTL_MS = 30_000;
const CG_CACHE_MAX = 200;
const cgCache = createCgCache("price-feed", { max: CG_CACHE_MAX, maxBody: 256 * 1024 });
/** Test seam: drop every cached CoinGecko answer. */
export function clearPriceFeedCache() { cgCache.clear(); }

async function feedFetch(url, opts = {}) {
  const host = new URL(url).hostname;
  if (!isCoinGeckoHost(host)) return (await feedLoad(url, host, opts)).data;
  const { entry } = await cgCache.through(String(url), CG_CACHE_TTL_MS, () => feedLoad(url, host, opts));
  return JSON.parse(entry.text);
}

// One upstream read: the body of a 200 that parses as JSON, as { text, data },
// or a thrown refusal (never cached).
async function feedLoad(url, host, { timeout = FEED_READ_MS, step = "data" } = {}) {
  const headers = { Accept: "application/json" };
  // CoinGecko key rides along when configured (call-time read; header per
  // tier from coingecko-endpoint.js, same as crypto-kit's jsonGet). Keyless
  // CoinGecko is metered per IP, and our egress IP is shared with every other
  // Railway tenant.
  if (isCoinGeckoHost(host)) {
    Object.assign(headers, cgKeyHeaders());
    // The key's minute budget is ONE bucket shared with crypto-kit and
    // crypto-markets-kit (coingecko-rate.js). This kit sent the same key with
    // no bucket at all (the 2026-08-28 fix reached the other two kits only), so
    // under load it overran the key for every caller. Refuse before the call
    // when the minute is spent: 503 is never charged.
    const why = await cgTake(Date.now());
    if (why) throw cgRefusal(why);
  }
  // A read that outlives its cap, or a host that cannot be reached, is the
  // upstream's: a 503 naming the step (the transport cause reaches the log).
  const ctx = { label: "Price feed", step, timeoutMs: timeout, tag: "[price-feed]" };
  const res = await upstreamFetch(url, { headers }, ctx);
  if (res.status === 429) throw bad("Price feed rate limit reached upstream - retry shortly", 503);
  if (res.status === 404) throw bad("Price feed upstream: not found (check ids / contract)", 404);
  // A 400 is the buyer's input being refused, not an outage.
  if (res.status === 400) throw bad("Price feed upstream: not found or rejected (check the ids / contract)", 404);
  if (!res.ok) throw bad(`Price feed upstream error (HTTP ${res.status})`, 502);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("json")) {
    throw bad(`Price feed upstream returned non-JSON (${ct.split(";")[0] || "unknown"})`, 502);
  }
  let text, data;
  try { text = await bodyUnderDeadline(res.text(), ctx); data = JSON.parse(text); }
  catch (err) { if (err?.statusCode) throw err; throw bad("Price feed upstream returned malformed JSON", 502); }
  return { text, data };
}

// price-pyth was RETIRED 2026-08-26: Pyth put Hermes behind a Bearer key at
// 16:00 UTC that day (keyless = 401), and the tool had zero external use in
// the ledger's history (retirement rule, CLAUDE.md).
export const PRICE_FEED_TOOLS = [
  // ===========================================================================
  // price-coingecko, spot price by CoinGecko coin id.
  // ===========================================================================
  {
    route: "POST /api/price-coingecko",
    name: "Crypto spot price by coin id",
    slug: "price-coingecko",
    category: "crypto",
    price: "$0.001",
    description:
      "Live spot price for up to 25 coins by coin id, one row per id in the order asked: prices[] of {id, price, change24h, lastUpdated}. Identify coins by their coin ID slug (bitcoin, ethereum, solana, usd-coin, ...), as an array or a comma-separated string; for ticker symbols (BTC, ETH) plus volume and market cap use crypto-price. Defaults to USD; pass vsCurrency to denominate in EUR, JPY, ETH, BTC, etc. change24h is filled only when include24hChange is true. An unknown id comes back with a null price and is listed in unknown.",
    tags: ["crypto", "price", "spot", "market"],
    discovery: {
      bodyType: "json",
      input: { ids: ["bitcoin", "ethereum"] },
      inputSchema: {
        properties: {
          ids: { type: ["array", "string"], items: { type: "string" }, description: "Coin IDs (e.g. bitcoin, ethereum, solana): an array, or one comma-separated string. 1-25 entries." },
          vsCurrency: { type: "string", description: "Quote currency (default usd). Supports any vs_currencies value the coin index lists." },
          include24hChange: { type: "boolean", description: "Include 24h % change in the response (default false)." },
        },
        required: ["ids"],
      },
      output: {
        example: {
          count: 2, vsCurrency: "usd",
          prices: [
            { id: "bitcoin", price: 67000.12, change24h: null, lastUpdated: "2026-09-24T14:50:20.000Z" },
            { id: "ethereum", price: 3500.05, change24h: null, lastUpdated: "2026-09-24T14:50:20.000Z" },
          ],
        },
      },
    },
    handler: async (i) => {
      // One id or a comma list as a plain string is the obvious other shape (the
      // sibling sol-price and crypto-price both take it); refusing it was a 400
      // on a correct request.
      const rawIds = typeof i.ids === "string" ? i.ids.split(",").map((x) => x.trim()).filter(Boolean) : i.ids;
      if (!Array.isArray(rawIds) || rawIds.length === 0) throw bad(`"ids" must be a non-empty array (or a comma-separated string)`);
      if (rawIds.length > 25) throw bad(`"ids" cannot exceed 25 entries`);
      const ids = rawIds.map((x) => {
        if (typeof x !== "string" || !x.trim()) throw bad(`Each id must be a non-empty string`);
        if (!/^[a-z0-9-]+$/i.test(x.trim())) throw bad(`"${x}" is not a valid CoinGecko id (alphanumerics + hyphens only)`);
        return x.trim().toLowerCase();
      });
      const vs = typeof i.vsCurrency === "string" && /^[a-z]{2,10}$/i.test(i.vsCurrency.trim())
        ? i.vsCurrency.trim().toLowerCase()
        : "usd";
      const wantChange = i.include24hChange === true;
      const url = `${cgBase()}/simple/price?ids=${ids.join(",")}&vs_currencies=${vs}&include_last_updated_at=true` +
        (wantChange ? `&include_24hr_change=true` : "");
      const data = await feedFetch(url, { step: "simple price" });
      const prices = ids.map((id) => {
        const row = data[id];
        if (!row) return { id, price: null, change24h: null, lastUpdated: null };
        return {
          id,
          price: typeof row[vs] === "number" ? row[vs] : null,
          change24h: wantChange && typeof row[`${vs}_24h_change`] === "number" ? row[`${vs}_24h_change`] : null,
          // When CoinGecko last refreshed this price: a spot price without a
          // timestamp cannot be judged fresh or stale.
          lastUpdated: Number.isFinite(row.last_updated_at) ? new Date(row.last_updated_at * 1000).toISOString() : null,
        };
      });
      // Every id unknown was a 200 of null rows (corpus, 2026-09-06): 404
      // naming the ids instead; a partial miss keeps its null rows and lists them.
      // A row that exists but lacks the requested currency key is a
      // CURRENCY miss, never an unknown id (review, 2026-09-06).
      const knownIds = ids.filter((id) => data[id]);
      if (knownIds.length && knownIds.every((id) => typeof data[id]?.[vs] !== "number")) throw bad(`vsCurrency "${vs}" is not supported by CoinGecko's simple price endpoint (try usd, eur, gbp, btc, eth)`);
      const unknown = ids.filter((id) => !data[id]);
      if (unknown.length === prices.length) throw bad(`unknown CoinGecko id(s): ${unknown.join(", ")}`, 404);
      return { count: prices.length, vsCurrency: vs, prices, ...(unknown.length ? { unknown } : {}) };
    },
  },
];
// price-coingecko reads CoinGecko, whose terms require the attribution (see
// COINGECKO_ATTRIBUTION in coingecko-rate.js), in the description and as the
// `credit` field of every answer.
for (const t of PRICE_FEED_TOOLS) if (t.slug === "price-coingecko") creditAnswers(attribute(t, "coingecko"), COINGECKO_CREDIT);

// Every handler runs under one budget (src/upstream-deadline.js).
underBudgetAll(PRICE_FEED_TOOLS, PAYMENT_WINDOW_BUDGET_MS);
