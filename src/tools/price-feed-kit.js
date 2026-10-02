// Price-feed kit — three deterministic gateway tools that surface public price
// + TVL data feeds without requiring a key in our deployment:
//
//   • price-pyth      — Pyth Hermes API (keyless, sub-second updates, 400+ feeds)
//   • price-coingecko — CoinGecko public simple/price (keyless free tier)
//   • defi-tvl        — DeFiLlama protocol TVL (keyless, refreshed every 5m)
//
// Wallet-only (each call costs egress + counts against the upstream's public
// rate limit), never PoW-eligible. Covered by scripts/test-price-feed-kit.js.

import { protocols as llamaProtocols } from "./defi-kit.js";
import { takeCgToken, isCoinGeckoHost } from "./coingecko-rate.js";
const TIMEOUT_MS = 10_000;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// DefiLlama's /protocol/{slug} document is 2-10 MB rendered at their origin;
// a CDN miss takes past 10 s from a cold region (the nightly corpus 504'd
// `uniswap` at exactly 10 s in three of four runs, 2026-09-06/07, the server
// log naming api.llama.fi → TimeoutError) while a warm read is 0.2 s. A 504 is
// never charged, so waiting longer costs the buyer nothing but the wait.
const LLAMA_DOC_TIMEOUT_MS = 25_000;

async function feedFetch(url, { timeout = TIMEOUT_MS } = {}) {
  const host = new URL(url).hostname;
  const headers = { Accept: "application/json" };
  // CoinGecko demo key rides along when configured (call-time read, same header
  // as crypto-kit's jsonGet). Keyless CoinGecko is metered per IP — and our
  // egress IP is shared with every other Railway tenant.
  if (isCoinGeckoHost(host)) {
    if (process.env.COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
    // The key's minute budget is ONE bucket shared with crypto-kit and
    // crypto-markets-kit (coingecko-rate.js). This kit sent the same key with
    // no bucket at all (the 2026-08-28 fix reached the other two kits only), so
    // under load it overran the key for every caller. Refuse before the call
    // when the minute is spent: 503 is never charged.
    if (!takeCgToken(Date.now())) throw bad("CoinGecko is rate limited right now, retry in a few seconds. You were not charged.", 503);
  }
  let res;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    // Keep the evidence: the transport cause must reach the server log, not
    // vanish into a generic 504.
    console.warn(`[price-feed] upstream unreachable: ${host} → ${err.name ?? err.code ?? err.message}`);
    throw bad("Price feed upstream timed out", 504);
  }
  if (res.status === 429) throw bad("Price feed rate limit reached upstream - retry shortly", 503);
  if (res.status === 404) throw bad("Price feed upstream: not found (check ids / contract)", 404);
  // DefiLlama answers 400 for a protocol slug it does not know: that is the
  // buyer's input being refused, not an outage (corpus, 2026-09-06).
  if (res.status === 400) throw bad("Price feed upstream: not found or rejected (check the protocol / ids / contract)", 404);
  if (!res.ok) throw bad(`Price feed upstream error (HTTP ${res.status})`, 502);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("json")) {
    throw bad(`Price feed upstream returned non-JSON (${ct.split(";")[0] || "unknown"})`, 502);
  }
  try { return await res.json(); }
  catch { throw bad("Price feed upstream returned malformed JSON", 502); }
}

// Pyth quotes prices as { price, expo } where the human value is price * 10**expo.
// expo is almost always negative (e.g. -8 means the integer is in 1e-8 units).

// price-pyth was RETIRED 2026-08-26: Pyth put Hermes behind a Bearer key at
// 16:00 UTC that day (keyless = 401), the base API plan is $500/month, and the
// tool had zero external use in the ledger's history (retirement rule, CLAUDE.md).
export const PRICE_FEED_TOOLS = [
  // ===========================================================================
  // price-pyth — by Pyth feed ID (or a small set of well-known aliases).
  // ===========================================================================
  {
    route: "POST /api/price-coingecko",
    name: "CoinGecko spot price",
    slug: "price-coingecko",
    category: "crypto",
    price: "$0.001",
    description:
      "Live spot price for up to 25 coins by CoinGecko id, one row per id in the order asked: prices[] of {id, price, change24h, lastUpdated}. Identify coins by their CoinGecko ID slug (bitcoin, ethereum, solana, usd-coin, ...), as an array or a comma-separated string; for ticker symbols (BTC, ETH) plus volume and market cap use crypto-price. Defaults to USD; pass vsCurrency to denominate in EUR, JPY, ETH, BTC, etc. change24h is filled only when include24hChange is true. An id CoinGecko does not know comes back with a null price and is listed in unknown.",
    tags: ["crypto", "price", "coingecko", "spot", "market"],
    discovery: {
      bodyType: "json",
      input: { ids: ["bitcoin", "ethereum"] },
      inputSchema: {
        properties: {
          ids: { type: ["array", "string"], items: { type: "string" }, description: "CoinGecko coin IDs (e.g. bitcoin, ethereum, solana): an array, or one comma-separated string. 1-25 entries." },
          vsCurrency: { type: "string", description: "Quote currency (default usd). Supports any CoinGecko vs_currencies value." },
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
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=${vs}&include_last_updated_at=true` +
        (wantChange ? `&include_24hr_change=true` : "");
      const data = await feedFetch(url);
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

  // ===========================================================================
  // defi-tvl — DeFiLlama protocol TVL by slug.
  // ===========================================================================
  {
    route: "POST /api/defi-tvl",
    name: "DeFi protocol TVL",
    slug: "defi-tvl",
    category: "crypto",
    price: "$0.001",
    description:
      "Look up the current Total Value Locked (TVL) for a DeFi protocol via DeFiLlama's public API. Identify the protocol by its DeFiLlama slug (uniswap, aave, lido, ethena, etc.). Returns the total TVL plus per-chain breakdown and 24h/7d/30d change where DeFiLlama exposes it.",
    tags: ["crypto", "defi", "tvl", "defillama", "protocol"],
    discovery: {
      bodyType: "json",
      input: { protocol: "aave" },
      inputSchema: {
        properties: {
          protocol: { type: "string", description: "DeFiLlama protocol slug (e.g. uniswap, aave, lido). Lowercase, hyphen-separated." },
        },
        required: ["protocol"],
      },
      output: {
        example: {
          protocol: "aave", name: "AAVE", category: "Lending",
          tvlUsd: 15_000_000_000,
          change24h: 0.5, change7d: 2.1, change30d: 8.0,
          chainTvls: [{ chain: "Ethereum", tvlUsd: 11_000_000_000 }],
        },
      },
    },
    handler: async (i) => {
      const protocol = typeof i.protocol === "string" ? i.protocol.trim().toLowerCase() : "";
      if (!protocol) throw bad(`"protocol" is required`);
      if (!/^[a-z0-9-]+$/.test(protocol)) throw bad(`"protocol" must be a slug (lowercase, alphanumerics + hyphens)`);
      const data = await feedFetch(`https://api.llama.fi/protocol/${protocol}`, { timeout: LLAMA_DOC_TIMEOUT_MS });
      // DeFiLlama returns chainTvls as an object keyed by chain. Flatten for the
      // caller — they don't want to iterate object keys.
      // DeFiLlama's chainTvls object also carries aggregate pseudo-keys
      // (borrowed, staking, pool2, …) and per-chain suffixed variants
      // (Ethereum-borrowed, Polygon-staking). Those are NOT chains and must not be
      // summed as TVL — doing so double-counts and folds in borrowed/staked value
      // (it was overstating TVL ~2.6x). Keep only real, unsuffixed chain keys.
      const PSEUDO_TVL_KEYS = new Set(["borrowed", "staking", "pool2", "offers", "treasury", "vesting", "masterchef", "dcAndLsOverlap"]);
      const isChainKey = (k) => !k.includes("-") && !PSEUDO_TVL_KEYS.has(k);
      const chainTvls = Object.entries(data?.chainTvls ?? {})
        .filter(([chain]) => isChainKey(chain))
        .map(([chain, payload]) => {
          // Newer chainTvls entries are objects { tvl: [...timeseries] }; older
          // ones can be flat numbers. Handle both shapes.
          const series = Array.isArray(payload?.tvl) ? payload.tvl : null;
          const latest = series && series.length ? series[series.length - 1]?.totalLiquidityUSD : (typeof payload === "number" ? payload : null);
          return { chain, tvlUsd: typeof latest === "number" ? latest : null };
        })
        .filter((r) => r.tvlUsd != null && r.tvlUsd > 0)
        .sort((a, b) => b.tvlUsd - a.tvlUsd);
      // Top-level tvlUsd: prefer DeFiLlama's canonical aggregate series (data.tvl,
      // the headline figure), else sum the real (non-pseudo) chains.
      const tvlSeries = Array.isArray(data?.tvl) ? data.tvl : null;
      const headlineTvl = tvlSeries && tvlSeries.length ? tvlSeries[tvlSeries.length - 1]?.totalLiquidityUSD : null;
      const tvlUsd = typeof headlineTvl === "number" && headlineTvl > 0
        ? headlineTvl
        : chainTvls.reduce((a, b) => a + (b.tvlUsd || 0), 0);
      // DefiLlama's /protocol/{slug} document stopped carrying category and
      // the change_* fields (measured 2026-09-06: null on uniswap AND aave), so
      // every buyer got a category:null, change:null answer on the biggest
      // protocols - the promised fields, never populated. The category comes
      // from the cached /protocols list (defi-kit) and the changes are derived
      // from the document's own daily TVL series, which it still carries.
      let listRow = null;
      try {
        const rows = (await llamaProtocols()).value; // defi-kit's cache wrapper: { value, fetchedAt, cached, stale }
        // A parent slug (uniswap, aave) has no row of its own: its children
        // (uniswap-v3 ...) carry parentProtocol = the parent slug.
        listRow = rows.find((r) => r.slug === protocol) ?? rows.find((r) => r.parentProtocol === protocol) ?? null;
      } catch { /* the list is a bonus; the document answers alone */ }
      const pctFromSeries = (daysBack) => {
        if (!tvlSeries || tvlSeries.length < 2 || !(tvlUsd > 0)) return null;
        const last = tvlSeries[tvlSeries.length - 1];
        const target = Number(last?.date) - daysBack * 86400;
        let ref = null;
        for (let k = tvlSeries.length - 2; k >= 0; k--) { if (Number(tvlSeries[k]?.date) <= target) { ref = tvlSeries[k]; break; } }
        const base = Number(ref?.totalLiquidityUSD);
        return Number.isFinite(base) && base > 0 ? Number((((tvlUsd / base) - 1) * 100).toFixed(2)) : null;
      };
      const pick = (docField, listField, daysBack) =>
        typeof data?.[docField] === "number" ? data[docField]
          : typeof listRow?.[listField] === "number" ? listRow[listField]
            : pctFromSeries(daysBack);
      const sourceOf = (docField, listField) =>
        typeof data?.[docField] === "number" ? "defillama-protocol"
          : typeof listRow?.[listField] === "number" ? "defillama-protocols-list"
            : "derived-from-tvl-series";
      return {
        protocol,
        name: data?.name ?? null,
        category: data?.category ?? listRow?.category ?? null,
        tvlUsd,
        change24h: pick("change_1d", "change1dPct", 1),
        change7d:  pick("change_7d", "change7dPct", 7),
        change30d: pick("change_1m", "change30dPct", 30),
        // Where each change figure came from (review, 2026-09-06): the
        // document, DefiLlama's protocol list, or our own arithmetic on the
        // document's daily TVL series.
        changeSource: { change24h: sourceOf("change_1d", "change1dPct"), change7d: sourceOf("change_7d", "change7dPct"), change30d: sourceOf("change_1m", "change30dPct") },
        chainTvls,
      };
    },
  },
];
