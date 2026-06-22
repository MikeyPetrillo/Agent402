// Dex kit — Uniswap V3 pool reads on every Alchemy-supported chain. Resolve a
// pool by (tokenA, tokenB, fee), read its on-chain state, get a spot quote
// from sqrtPriceX96, and surface top pools by TVL via DeFiLlama (keyless).
//
// Honest scoping: dex-quote is a SPOT quote at the current tick — no multi-
// tick swap simulation. Deeper sims are a future kit. We name it accordingly.
//
// All 4 tools are wallet-only: 3 share the Alchemy quota with chain-kit,
// dex-top-pools shares DeFiLlama's per-IP limit.
//
// Covered by scripts/test-dex-kit.js (offline) and the daily paid-canary
// (which probes Alchemy end-to-end via gas-snapshot).

const TIMEOUT_MS = 10_000;

// Uniswap V3 deployments. Ethereum/Polygon/Arbitrum/Optimism share the
// canonical factory; Base has a Coinbase-deployed factory at a different
// address. Source: https://docs.uniswap.org/contracts/v3/reference/deployments
const V3_FACTORY = {
  ethereum: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  polygon:  "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  arbitrum: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  optimism: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  base:     "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
};

const NETWORKS = {
  ethereum: { subdomain: "eth-mainnet", chainId: 1 },
  base:     { subdomain: "base-mainnet", chainId: 8453 },
  polygon:  { subdomain: "polygon-mainnet", chainId: 137 },
  arbitrum: { subdomain: "arb-mainnet", chainId: 42161 },
  optimism: { subdomain: "opt-mainnet", chainId: 10 },
};

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const SUPPORTED_FEES = new Set([100, 500, 3000, 10000]);

// Function selectors (keccak256(sig).slice(0,4)) — standard, verified against
// Uniswap V3 + ERC-20 contracts on every supported chain.
const SEL = {
  getPool:   "0x1698ee82", // factory.getPool(address,address,uint24)
  slot0:     "0x3850c7bd", // pool.slot0()
  liquidity: "0x1a686502", // pool.liquidity()
  token0:    "0x0dfe1681", // pool.token0()
  token1:    "0xd21220a7", // pool.token1()
  fee:       "0xddca3f43", // pool.fee()
  decimals:  "0x313ce567", // erc20.decimals()
};

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function requireKey() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) throw bad("Chain tools are not configured on this deployment", 503);
  return key;
}

function pickNetwork(value, dflt = "base") {
  const n = typeof value === "string" ? value.toLowerCase().trim() : dflt;
  const def = NETWORKS[n];
  if (!def) throw bad(`Unsupported network "${value}" — supported: ${Object.keys(NETWORKS).join(", ")}`);
  return { name: n, ...def, factory: V3_FACTORY[n] };
}

function takeAddress(raw, field = "address") {
  if (typeof raw !== "string" || !ADDR_RE.test(raw.trim())) {
    throw bad(`"${field}" must be a 0x-prefixed 40-char hex Ethereum address`);
  }
  return raw.trim().toLowerCase();
}

function pickFee(value) {
  const f = Number.parseInt(value, 10);
  if (!SUPPORTED_FEES.has(f)) {
    throw bad(`"fee" must be one of ${[...SUPPORTED_FEES].join(", ")} (100/500/3000/10000 bps)`);
  }
  return f;
}

// --- ABI encoding ---------------------------------------------------------
function pad32(hex) {
  return hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}
function encAddr(a) { return pad32(a); }
function encUint(n) { return pad32(BigInt(n).toString(16)); }

// Slice a raw eth_call hex response ("0x...") into 32-byte slots (64-char
// hex strings, no leading 0x). Solidity ABI packs each return value into a
// 32-byte slot regardless of declared type.
function slots(hex) {
  const data = (hex || "0x").replace(/^0x/, "");
  const out = [];
  for (let i = 0; i < data.length; i += 64) out.push(data.slice(i, i + 64));
  return out;
}

function decodeUint(slot) { return BigInt("0x" + slot); }
function decodeInt(slot) {
  // Two's complement for int256: if top bit is set, subtract 2^256.
  const big = BigInt("0x" + slot);
  return big >= (1n << 255n) ? big - (1n << 256n) : big;
}
function decodeAddr(slot) { return "0x" + slot.slice(-40); }

// --- RPC plumbing ---------------------------------------------------------
async function alchemyFetch(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(opts.headers || {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw bad("Chain upstream timed out", 504);
  }
  if (res.status === 429) throw bad("Chain rate limit reached upstream — retry shortly", 503);
  if (!res.ok) throw bad(`Chain upstream error (HTTP ${res.status})`, 502);
  return res.json();
}

async function jsonRpc(network, method, params) {
  const key = requireKey();
  const url = `https://${network.subdomain}.g.alchemy.com/v2/${key}`;
  const data = await alchemyFetch(url, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (data.error) throw bad(`Chain RPC error: ${data.error.message || "unknown"}`, 502);
  return data.result;
}

async function ethCall(network, to, data) {
  return jsonRpc(network, "eth_call", [{ to, data }, "latest"]);
}

// --- V3 math --------------------------------------------------------------
// sqrtPriceX96 = sqrt(token1/token0) × 2^96 (raw units).
// price1per0_human = (sqrtPriceX96 / 2^96)^2 × 10^(decimals0 − decimals1)
//
// We do the math in BigInt to keep precision, then Number() the final scaled
// result for a JSON-friendly output. PRECISION = 1e18 of intermediate scale.
function priceFromSqrt(sqrtPriceX96, decimals0, decimals1) {
  const sp = BigInt(sqrtPriceX96);
  const PRECISION = 10n ** 18n;
  const numerator = sp * sp * PRECISION * 10n ** BigInt(decimals0);
  const denominator = (1n << 192n) * 10n ** BigInt(decimals1);
  if (denominator === 0n) return 0;
  return Number(numerator / denominator) / 1e18;
}

// Spot quote at current tick. NOT a multi-tick swap simulation — slippage
// from depleting concentrated liquidity is not modeled. Use for indicative
// pricing; quote against a proper SDK before broadcasting.
function spotQuote({ amountIn, sqrtPriceX96, fee, zeroForOne, decimals0, decimals1 }) {
  const inN = Number(amountIn);
  if (!Number.isFinite(inN) || inN < 0) throw bad("amountIn must be a non-negative number");
  const feeDec = Number(fee) / 1_000_000; // fee is in 1e-6 units (3000 = 0.30%)
  const afterFee = inN * (1 - feeDec);
  const price01 = priceFromSqrt(sqrtPriceX96, decimals0, decimals1);
  if (price01 === 0) return 0;
  return zeroForOne ? afterFee * price01 : afterFee / price01;
}

// --- Tools ----------------------------------------------------------------
export const DEX_TOOLS = [
  // ===========================================================================
  // dex-pair — resolve (tokenA, tokenB, fee) → V3 pool address.
  // ===========================================================================
  {
    route: "POST /api/dex-pair",
    name: "Resolve Uniswap V3 pool address",
    slug: "dex-pair",
    category: "crypto",
    price: "$0.001",
    description:
      "Look up the Uniswap V3 pool address for a token pair + fee tier on Ethereum, Base, Polygon, Arbitrum, or Optimism. Pass either order (tokenA/tokenB) — the factory sorts internally. Returns 0x0…0 if no pool has been deployed for that combination yet.",
    tags: ["crypto", "uniswap", "dex", "v3", "pool", "evm"],
    discovery: {
      bodyType: "json",
      input: {
        tokenA: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        tokenB: "0x4200000000000000000000000000000000000006",
        fee: 500,
        network: "base",
      },
      inputSchema: {
        properties: {
          tokenA: { type: "string", description: "0x-prefixed ERC-20 contract address." },
          tokenB: { type: "string", description: "0x-prefixed ERC-20 contract address (other side of the pair)." },
          fee: { type: "number", description: "Fee tier in 1e-6 units: 100, 500, 3000, or 10000 (0.01% / 0.05% / 0.30% / 1.00%)." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["tokenA", "tokenB", "fee"],
      },
      output: {
        example: {
          network: "base",
          tokenA: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          tokenB: "0x4200000000000000000000000000000000000006",
          fee: 500,
          poolAddress: "0xd0b53d9277642d899df5c87a3966a349a798f224",
        },
      },
    },
    handler: async (i) => {
      const network = pickNetwork(i.network);
      const tokenA = takeAddress(i.tokenA, "tokenA");
      const tokenB = takeAddress(i.tokenB, "tokenB");
      const fee = pickFee(i.fee);
      const data = SEL.getPool + encAddr(tokenA) + encAddr(tokenB) + encUint(fee);
      const raw = await ethCall(network, network.factory, data);
      const poolAddress = decodeAddr(slots(raw)[0] || "0".repeat(64));
      return { network: network.name, tokenA, tokenB, fee, poolAddress };
    },
  },

  // ===========================================================================
  // dex-pool — read pool state: slot0, liquidity, tokens, fee, spot price.
  // ===========================================================================
  {
    route: "POST /api/dex-pool",
    name: "Read Uniswap V3 pool state",
    slug: "dex-pool",
    category: "crypto",
    price: "$0.002",
    description:
      "Read on-chain state of a Uniswap V3 pool: token0/token1 addresses + decimals, fee tier, current sqrtPriceX96, tick, in-range liquidity, and the decoded human-readable spot price (token1 per token0). One $0.002 call replaces ~6 RPC roundtrips on the caller's side.",
    tags: ["crypto", "uniswap", "dex", "v3", "pool", "price", "evm"],
    discovery: {
      bodyType: "json",
      input: {
        poolAddress: "0xd0b53d9277642d899df5c87a3966a349a798f224",
        network: "base",
      },
      inputSchema: {
        properties: {
          poolAddress: { type: "string", description: "0x-prefixed Uniswap V3 pool contract address." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["poolAddress"],
      },
      output: {
        example: {
          network: "base",
          poolAddress: "0xd0b53d9277642d899df5c87a3966a349a798f224",
          token0: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
          token1: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
          fee: 500,
          sqrtPriceX96: "1456834567890123456789012345",
          tick: 196543,
          liquidity: "1234567890123456789",
          spotPrice_1per0: 3500.05,
        },
      },
    },
    handler: async (i) => {
      const network = pickNetwork(i.network);
      const poolAddress = takeAddress(i.poolAddress, "poolAddress");
      const [slot0Raw, liqRaw, t0Raw, t1Raw, feeRaw] = await Promise.all([
        ethCall(network, poolAddress, SEL.slot0),
        ethCall(network, poolAddress, SEL.liquidity),
        ethCall(network, poolAddress, SEL.token0),
        ethCall(network, poolAddress, SEL.token1),
        ethCall(network, poolAddress, SEL.fee),
      ]);
      const s = slots(slot0Raw);
      const sqrtPriceX96 = decodeUint(s[0] || "".padStart(64, "0"));
      const tick = Number(decodeInt(s[1] || "".padStart(64, "0")));
      const liquidity = decodeUint(slots(liqRaw)[0] || "".padStart(64, "0"));
      const token0 = decodeAddr(slots(t0Raw)[0] || "".padStart(64, "0"));
      const token1 = decodeAddr(slots(t1Raw)[0] || "".padStart(64, "0"));
      const fee = Number(decodeUint(slots(feeRaw)[0] || "".padStart(64, "0")));

      // Fetch decimals in parallel — agents almost always want them.
      const [d0Raw, d1Raw] = await Promise.all([
        ethCall(network, token0, SEL.decimals),
        ethCall(network, token1, SEL.decimals),
      ]);
      const decimals0 = Number(decodeUint(slots(d0Raw)[0] || "".padStart(64, "0")));
      const decimals1 = Number(decodeUint(slots(d1Raw)[0] || "".padStart(64, "0")));

      return {
        network: network.name,
        poolAddress,
        token0: { address: token0, decimals: decimals0 },
        token1: { address: token1, decimals: decimals1 },
        fee,
        sqrtPriceX96: sqrtPriceX96.toString(),
        tick,
        liquidity: liquidity.toString(),
        spotPrice_1per0: priceFromSqrt(sqrtPriceX96, decimals0, decimals1),
      };
    },
  },

  // ===========================================================================
  // dex-quote — spot quote at current tick (single-tick approximation).
  // ===========================================================================
  {
    route: "POST /api/dex-quote",
    name: "Uniswap V3 spot quote",
    slug: "dex-quote",
    category: "crypto",
    price: "$0.002",
    description:
      "Spot quote for swapping through a Uniswap V3 pool at the current tick. amountIn is in human units (not wei). zeroForOne=true sends token0 → token1; false sends token1 → token0. Returns amountOut net of the pool's fee tier. NOTE: this is a single-tick spot quote — slippage from depleting concentrated liquidity is NOT modeled. Use for indicative pricing; for production swaps quote against the Uniswap SDK.",
    tags: ["crypto", "uniswap", "dex", "v3", "quote", "swap", "evm"],
    discovery: {
      bodyType: "json",
      input: {
        poolAddress: "0xd0b53d9277642d899df5c87a3966a349a798f224",
        amountIn: 1,
        zeroForOne: true,
        network: "base",
      },
      inputSchema: {
        properties: {
          poolAddress: { type: "string", description: "0x-prefixed Uniswap V3 pool address." },
          amountIn: { type: "number", description: "Input amount in human units (e.g. 1 WETH, not 1e18 wei)." },
          zeroForOne: { type: "boolean", description: "true: send token0 → receive token1. false: send token1 → receive token0." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["poolAddress", "amountIn", "zeroForOne"],
      },
      output: {
        example: {
          network: "base",
          poolAddress: "0xd0b53d9277642d899df5c87a3966a349a798f224",
          amountIn: 1,
          zeroForOne: true,
          fee: 500,
          spotPrice_1per0: 3500.05,
          amountOut: 3498.30,
          note: "spot quote at current tick — no multi-tick swap simulation",
        },
      },
    },
    handler: async (i) => {
      const network = pickNetwork(i.network);
      const poolAddress = takeAddress(i.poolAddress, "poolAddress");
      if (typeof i.amountIn !== "number" || !Number.isFinite(i.amountIn) || i.amountIn < 0) {
        throw bad("amountIn must be a non-negative number (human units)");
      }
      if (typeof i.zeroForOne !== "boolean") {
        throw bad("zeroForOne must be a boolean: true (token0→token1) or false (token1→token0)");
      }

      const [slot0Raw, t0Raw, t1Raw, feeRaw] = await Promise.all([
        ethCall(network, poolAddress, SEL.slot0),
        ethCall(network, poolAddress, SEL.token0),
        ethCall(network, poolAddress, SEL.token1),
        ethCall(network, poolAddress, SEL.fee),
      ]);
      const sqrtPriceX96 = decodeUint(slots(slot0Raw)[0] || "".padStart(64, "0"));
      const token0 = decodeAddr(slots(t0Raw)[0] || "".padStart(64, "0"));
      const token1 = decodeAddr(slots(t1Raw)[0] || "".padStart(64, "0"));
      const fee = Number(decodeUint(slots(feeRaw)[0] || "".padStart(64, "0")));

      const [d0Raw, d1Raw] = await Promise.all([
        ethCall(network, token0, SEL.decimals),
        ethCall(network, token1, SEL.decimals),
      ]);
      const decimals0 = Number(decodeUint(slots(d0Raw)[0] || "".padStart(64, "0")));
      const decimals1 = Number(decodeUint(slots(d1Raw)[0] || "".padStart(64, "0")));

      const spotPrice = priceFromSqrt(sqrtPriceX96, decimals0, decimals1);
      const amountOut = spotQuote({
        amountIn: i.amountIn,
        sqrtPriceX96,
        fee,
        zeroForOne: i.zeroForOne,
        decimals0,
        decimals1,
      });

      return {
        network: network.name,
        poolAddress,
        amountIn: i.amountIn,
        zeroForOne: i.zeroForOne,
        fee,
        spotPrice_1per0: spotPrice,
        amountOut,
        note: "spot quote at current tick — no multi-tick swap simulation",
      };
    },
  },

  // ===========================================================================
  // dex-top-pools — top DEX pools by TVL via DeFiLlama Yields (keyless).
  // ===========================================================================
  {
    route: "POST /api/dex-top-pools",
    name: "Top DEX pools by TVL",
    slug: "dex-top-pools",
    category: "crypto",
    price: "$0.001",
    description:
      "Top DEX pools (Uniswap, Sushi, Curve, Aerodrome, etc.) ranked by current TVL — filterable by chain and project. Sourced from DeFiLlama's public Yields API (keyless). Each row carries chain, project slug, symbol pair, TVL in USD, current APY, and pool ID for follow-up queries.",
    tags: ["crypto", "dex", "tvl", "defillama", "pools", "yield"],
    discovery: {
      bodyType: "json",
      input: { chain: "Base", project: "uniswap-v3", limit: 5 },
      inputSchema: {
        properties: {
          chain: { type: "string", description: "Chain name as DeFiLlama uses it (Ethereum, Base, Polygon, Arbitrum, Optimism, etc.). Case-insensitive. Omit for all chains." },
          project: { type: "string", description: "Project slug substring (uniswap-v3, aerodrome-v1, curve-dex, etc.). Case-insensitive substring match. Omit for all DEXes." },
          limit: { type: "number", description: "Max pools to return (1-50, default 10)." },
        },
      },
      output: {
        example: {
          source: "defillama-yields",
          chain: "Base",
          project: "uniswap-v3",
          count: 5,
          pools: [
            { pool: "abc123", chain: "Base", project: "uniswap-v3", symbol: "WETH-USDC", tvlUsd: 45000000, apy: 12.3 },
          ],
        },
      },
    },
    handler: async (i) => {
      const limit = Math.max(1, Math.min(50, Number.parseInt(i.limit, 10) || 10));
      const chain = typeof i.chain === "string" ? i.chain.trim() : "";
      const project = typeof i.project === "string" ? i.project.trim().toLowerCase() : "";

      let res;
      try {
        res = await fetch("https://yields.llama.fi/pools", { signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        throw bad("DeFiLlama upstream timed out", 504);
      }
      if (res.status === 429) throw bad("DeFiLlama rate limit reached upstream — retry shortly", 503);
      if (!res.ok) throw bad(`DeFiLlama upstream error (HTTP ${res.status})`, 502);
      const json = await res.json();
      let pools = Array.isArray(json.data) ? json.data : [];

      if (chain) {
        const want = chain.toLowerCase();
        pools = pools.filter((p) => String(p.chain || "").toLowerCase() === want);
      }
      if (project) {
        pools = pools.filter((p) => String(p.project || "").toLowerCase().includes(project));
      }
      pools.sort((a, b) => (Number(b.tvlUsd) || 0) - (Number(a.tvlUsd) || 0));
      const top = pools.slice(0, limit).map((p) => ({
        pool: p.pool,
        chain: p.chain,
        project: p.project,
        symbol: p.symbol,
        tvlUsd: Number(p.tvlUsd) || 0,
        apy: typeof p.apy === "number" ? p.apy : null,
      }));

      return {
        source: "defillama-yields",
        chain: chain || null,
        project: project || null,
        count: top.length,
        pools: top,
      };
    },
  },
];

// Exported for unit-testing the pure math without standing up RPC.
export const __test = {
  priceFromSqrt, spotQuote, slots, decodeUint, decodeInt, decodeAddr,
  pad32, encAddr, encUint, pickNetwork, pickFee, takeAddress, NETWORKS, V3_FACTORY, ZERO_ADDR,
};
