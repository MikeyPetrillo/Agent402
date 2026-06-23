// Price-feed kit — three deterministic gateway tools that surface public price
// + TVL data feeds without requiring a key in our deployment:
//
//   • price-pyth      — Pyth Hermes API (keyless, sub-second updates, 400+ feeds)
//   • price-coingecko — CoinGecko public simple/price (keyless free tier)
//   • defi-tvl        — DeFiLlama protocol TVL (keyless, refreshed every 5m)
//
// Wallet-only (each call costs egress + counts against the upstream's public
// rate limit), never PoW-eligible. Covered by scripts/test-price-feed-kit.js.

const TIMEOUT_MS = 10_000;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function feedFetch(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw bad("Price feed upstream timed out", 504);
  }
  if (res.status === 429) throw bad("Price feed rate limit reached upstream — retry shortly", 503);
  if (res.status === 404) throw bad("Price feed upstream: not found (check ids / contract)", 404);
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
function pythScale(price, expo) {
  if (price == null || expo == null) return null;
  const e = Number(expo);
  if (!Number.isFinite(e)) return null;
  return Number(BigInt(price)) * Math.pow(10, e);
}

export const PRICE_FEED_TOOLS = [
  // ===========================================================================
  // price-pyth — by Pyth feed ID (or a small set of well-known aliases).
  // ===========================================================================
  {
    route: "POST /api/price-pyth",
    name: "Pyth price (latest)",
    slug: "price-pyth",
    category: "crypto",
    price: "$0.001",
    description:
      "Latest aggregated price for one or more Pyth feeds, sourced live from Pyth's Hermes service. Identify feeds by hex feed-id (preferred — full precision) or by a small set of well-known aliases (BTCUSD, ETHUSD, SOLUSD, USDC, USDT). Each feed returns price, confidence interval, and publish-time so an agent can decide whether the quote is fresh enough to act on.",
    tags: ["crypto", "price", "pyth", "feed", "oracle"],
    discovery: {
      bodyType: "json",
      input: { ids: ["BTCUSD", "ETHUSD"] },
      inputSchema: {
        properties: {
          ids: {
            type: "array",
            description: "Pyth feed IDs (hex, with or without 0x) or known aliases (BTCUSD, ETHUSD, SOLUSD, USDC, USDT). 1-20 entries.",
          },
        },
        required: ["ids"],
      },
      output: {
        example: {
          count: 2,
          feeds: [
            { id: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", alias: "BTCUSD", price: 67000.12, conf: 18.5, publishTime: "2026-06-22T17:30:00Z" },
            { id: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", alias: "ETHUSD", price: 3500.05, conf: 1.2, publishTime: "2026-06-22T17:30:00Z" },
          ],
        },
      },
    },
    handler: async (i) => {
      // A curated set of common Pyth feed IDs. The full catalog (400+) is at
      // https://pyth.network/developers/price-feed-ids — agents can pass any
      // hex ID directly. We keep the alias map tiny on purpose: a few household
      // names so agents can call the tool without leaving to look up an ID.
      const ALIASES = {
        BTCUSD: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
        ETHUSD: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
        SOLUSD: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
        USDC:   "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
        USDT:   "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
      };
      if (!Array.isArray(i.ids) || i.ids.length === 0) throw bad(`"ids" must be a non-empty array`);
      if (i.ids.length > 20) throw bad(`"ids" cannot exceed 20 entries`);
      const resolved = i.ids.map((raw) => {
        if (typeof raw !== "string") throw bad(`Each id must be a string`);
        const s = raw.trim();
        const upper = s.toUpperCase();
        if (ALIASES[upper]) return { input: s, alias: upper, id: ALIASES[upper] };
        const hex = s.replace(/^0x/, "");
        if (!/^[a-fA-F0-9]{64}$/.test(hex)) {
          throw bad(`"${s}" is neither a known alias (${Object.keys(ALIASES).join(", ")}) nor a 64-char hex feed ID`);
        }
        return { input: s, alias: null, id: hex.toLowerCase() };
      });
      const qs = resolved.map((r) => `ids[]=${r.id}`).join("&");
      const url = `https://hermes.pyth.network/v2/updates/price/latest?${qs}&encoding=hex&parsed=true`;
      const data = await feedFetch(url);
      const parsed = data?.parsed ?? [];
      const feeds = resolved.map((r) => {
        const p = parsed.find((x) => String(x.id).toLowerCase() === r.id);
        if (!p) return { id: r.id, alias: r.alias, price: null, conf: null, publishTime: null };
        const price = pythScale(p.price?.price, p.price?.expo);
        const conf = pythScale(p.price?.conf, p.price?.expo);
        const publishTime = p.price?.publish_time
          ? new Date(p.price.publish_time * 1000).toISOString()
          : null;
        return { id: r.id, alias: r.alias, price, conf, publishTime };
      });
      return { count: feeds.length, feeds };
    },
  },

  // ===========================================================================
  // price-coingecko — current USD (or vs-currency) price by CoinGecko ID.
  // ===========================================================================
  {
    route: "POST /api/price-coingecko",
    name: "CoinGecko spot price",
    slug: "price-coingecko",
    category: "crypto",
    price: "$0.001",
    description:
      "Live spot price (and optional 24-hour change) for one or more coins from CoinGecko's public Simple Price endpoint. Identify coins by their CoinGecko ID slug (bitcoin, ethereum, solana, usd-coin, …). Defaults to USD; pass a `vsCurrency` to denominate in EUR, JPY, ETH, BTC, etc.",
    tags: ["crypto", "price", "coingecko", "spot", "market"],
    discovery: {
      bodyType: "json",
      input: { ids: ["bitcoin", "ethereum"] },
      inputSchema: {
        properties: {
          ids: { type: "array", description: "CoinGecko coin IDs (e.g. bitcoin, ethereum, solana). 1-25 entries." },
          vsCurrency: { type: "string", description: "Quote currency (default usd). Supports any CoinGecko vs_currencies value." },
          include24hChange: { type: "boolean", description: "Include 24h % change in the response (default false)." },
        },
        required: ["ids"],
      },
      output: {
        example: {
          count: 2, vsCurrency: "usd",
          prices: [
            { id: "bitcoin", price: 67000.12, change24h: null },
            { id: "ethereum", price: 3500.05, change24h: null },
          ],
        },
      },
    },
    handler: async (i) => {
      if (!Array.isArray(i.ids) || i.ids.length === 0) throw bad(`"ids" must be a non-empty array`);
      if (i.ids.length > 25) throw bad(`"ids" cannot exceed 25 entries`);
      const ids = i.ids.map((x) => {
        if (typeof x !== "string" || !x.trim()) throw bad(`Each id must be a non-empty string`);
        if (!/^[a-z0-9-]+$/i.test(x.trim())) throw bad(`"${x}" is not a valid CoinGecko id (alphanumerics + hyphens only)`);
        return x.trim().toLowerCase();
      });
      const vs = typeof i.vsCurrency === "string" && /^[a-z]{2,10}$/i.test(i.vsCurrency.trim())
        ? i.vsCurrency.trim().toLowerCase()
        : "usd";
      const wantChange = i.include24hChange === true;
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=${vs}` +
        (wantChange ? `&include_24hr_change=true` : "");
      const data = await feedFetch(url);
      const prices = ids.map((id) => {
        const row = data[id];
        if (!row) return { id, price: null, change24h: null };
        return {
          id,
          price: typeof row[vs] === "number" ? row[vs] : null,
          change24h: wantChange && typeof row[`${vs}_24h_change`] === "number" ? row[`${vs}_24h_change`] : null,
        };
      });
      return { count: prices.length, vsCurrency: vs, prices };
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
      const data = await feedFetch(`https://api.llama.fi/protocol/${protocol}`);
      // DeFiLlama returns chainTvls as an object keyed by chain. Flatten for the
      // caller — they don't want to iterate object keys.
      const chainTvls = Object.entries(data?.chainTvls ?? {})
        .map(([chain, payload]) => {
          // Newer chainTvls entries are objects { tvl: [...timeseries] }; older
          // ones can be flat numbers. Handle both shapes.
          const series = Array.isArray(payload?.tvl) ? payload.tvl : null;
          const latest = series && series.length ? series[series.length - 1]?.totalLiquidityUSD : (typeof payload === "number" ? payload : null);
          return { chain, tvlUsd: typeof latest === "number" ? latest : null };
        })
        .filter((r) => r.tvlUsd != null && r.tvlUsd > 0)
        .sort((a, b) => b.tvlUsd - a.tvlUsd);
      // Top-level tvlUsd: prefer the explicit field, fall back to sum of chains.
      const explicit = typeof data?.currentChainTvls === "object"
        ? Object.values(data.currentChainTvls).filter((v) => typeof v === "number").reduce((a, b) => a + b, 0)
        : null;
      const tvlUsd = explicit && explicit > 0 ? explicit : chainTvls.reduce((a, b) => a + (b.tvlUsd || 0), 0);
      return {
        protocol,
        name: data?.name ?? null,
        category: data?.category ?? null,
        tvlUsd,
        change24h: typeof data?.change_1d === "number" ? data.change_1d : null,
        change7d:  typeof data?.change_7d === "number" ? data.change_7d : null,
        change30d: typeof data?.change_1m === "number" ? data.change_1m : null,
        chainTvls,
      };
    },
  },
];
