// Chain kit — wallet balances, token metadata + price, NFT ownership + metadata,
// gas snapshot, and a read-only JSON-RPC passthrough for power users. Backed by
// Alchemy (single key, every supported chain). Wallet-only (egress = external
// quota), never PoW-eligible.
//
// Supported networks: ethereum, base, polygon, arbitrum, optimism. Mainnets only —
// agents debugging testnets can use eth-call against a public RPC if needed.
//
// All tools accept a `network` field. Default is "base" because that's where x402
// settles and where most agent activity lives today.
//
// Covered by scripts/test-chain-kit.js (offline validation tests, no key needed).

const TIMEOUT_MS = 10_000;

// Alchemy URL conventions:
//   JSON-RPC node:  https://{net}-mainnet.g.alchemy.com/v2/{KEY}
//   NFT API v3:     https://{net}-mainnet.g.alchemy.com/nft/v3/{KEY}/{method}
//   Prices API:     https://api.g.alchemy.com/prices/v1/{KEY}/{method}
//   Data API:       https://api.g.alchemy.com/data/v1/{KEY}/{method}
//
// One key works for every product on the same app.
const NETWORKS = {
  ethereum: { subdomain: "eth-mainnet", chainId: 1, pricesId: "eth-mainnet" },
  base:     { subdomain: "base-mainnet", chainId: 8453, pricesId: "base-mainnet" },
  polygon:  { subdomain: "polygon-mainnet", chainId: 137, pricesId: "polygon-mainnet" },
  arbitrum: { subdomain: "arb-mainnet", chainId: 42161, pricesId: "arb-mainnet" },
  optimism: { subdomain: "opt-mainnet", chainId: 10, pricesId: "opt-mainnet" },
};

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_RE  = /^0x[a-fA-F0-9]*$/;

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
  return { name: n, ...def };
}

function takeAddress(raw, field = "address") {
  if (typeof raw !== "string" || !ADDR_RE.test(raw.trim())) {
    throw bad(`"${field}" must be a 0x-prefixed 40-char hex Ethereum address`);
  }
  return raw.trim().toLowerCase();
}

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

async function nftApi(network, method, params) {
  const key = requireKey();
  const qs = new URLSearchParams(params).toString();
  const url = `https://${network.subdomain}.g.alchemy.com/nft/v3/${key}/${method}?${qs}`;
  return alchemyFetch(url);
}

async function pricesApi(method, body) {
  const key = requireKey();
  const url = `https://api.g.alchemy.com/prices/v1/${key}/${method}`;
  return alchemyFetch(url, { method: "POST", body: JSON.stringify(body) });
}

async function dataApi(method, body) {
  const key = requireKey();
  const url = `https://api.g.alchemy.com/data/v1/${key}/${method}`;
  return alchemyFetch(url, { method: "POST", body: JSON.stringify(body) });
}

// Convert a hex string ("0x...") to a decimal string. We return decimal strings,
// not Numbers, because uint256 values routinely exceed Number.MAX_SAFE_INTEGER.
function hexToDecString(hex) {
  if (typeof hex !== "string" || !HEX_RE.test(hex)) return "0";
  return BigInt(hex).toString(10);
}

// Apply ERC-20 decimals to a raw uint256 balance and return a human-readable
// decimal string (e.g. raw "1500000000" with 6 decimals → "1500"). Trailing
// zeros after the decimal point are trimmed.
function formatUnits(rawDecimal, decimals) {
  const d = parseInt(decimals, 10);
  if (!Number.isFinite(d) || d < 0 || d > 36) return rawDecimal;
  if (d === 0) return rawDecimal;
  const padded = rawDecimal.padStart(d + 1, "0");
  const whole = padded.slice(0, -d);
  const frac = padded.slice(-d).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// JSON-RPC methods the eth-call passthrough will accept. Strictly read-only —
// no eth_sendTransaction / eth_sendRawTransaction / anything that mutates state
// or could be used to relay a paid broadcast through our quota.
const RPC_METHOD_WHITELIST = new Set([
  "eth_call",
  "eth_blockNumber",
  "eth_chainId",
  "eth_gasPrice",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_getUncleCountByBlockHash",
  "eth_getUncleCountByBlockNumber",
  "eth_maxPriorityFeePerGas",
  "net_version",
  "web3_clientVersion",
]);

export const CHAIN_TOOLS = [
  // ===========================================================================
  // wallet-balance — native + ERC-20 balances for an address.
  // ===========================================================================
  {
    route: "POST /api/wallet-balance",
    name: "Wallet balance (native + ERC-20)",
    slug: "wallet-balance",
    category: "crypto",
    price: "$0.002",
    description:
      "Look up the native coin balance (ETH/MATIC) plus every ERC-20 holding for a wallet address on Ethereum, Base, Polygon, Arbitrum, or Optimism. Returns clean decimal balances (already scaled by token decimals) plus symbol and contract — ready to display in a UI or feed into a portfolio tool.",
    tags: ["crypto", "wallet", "balance", "erc20", "evm", "base", "ethereum"],
    discovery: {
      bodyType: "json",
      input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "base" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "0x-prefixed 40-char hex wallet address." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["address"],
      },
      output: {
        example: {
          address: "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0",
          network: "base",
          native: { symbol: "ETH", balance: "0.001234", raw: "1234000000000000" },
          tokens: [
            { contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6, balance: "100", raw: "100000000" },
          ],
        },
      },
    },
    handler: async (i) => {
      const address = takeAddress(i.address);
      const network = pickNetwork(i.network);
      // Native via eth_getBalance.
      const rawHex = await jsonRpc(network, "eth_getBalance", [address, "latest"]);
      const rawNative = hexToDecString(rawHex);
      const nativeSymbol = network.name === "polygon" ? "MATIC" : "ETH";
      const native = { symbol: nativeSymbol, balance: formatUnits(rawNative, 18), raw: rawNative };
      // ERC-20 portfolio via Data API.
      const portfolio = await dataApi("assets/tokens/by-address", {
        addresses: [{ address, networks: [network.pricesId] }],
      });
      const rows = portfolio?.data?.tokens ?? portfolio?.tokens ?? [];
      const tokens = rows
        .filter((r) => r.tokenAddress && r.tokenBalance && r.tokenBalance !== "0x0")
        .map((r) => {
          const raw = hexToDecString(r.tokenBalance);
          const decimals = r.tokenMetadata?.decimals ?? 18;
          return {
            contract: String(r.tokenAddress).toLowerCase(),
            symbol: r.tokenMetadata?.symbol ?? null,
            decimals,
            balance: formatUnits(raw, decimals),
            raw,
          };
        });
      return { address, network: network.name, native, tokens };
    },
  },

  // ===========================================================================
  // token-metadata — symbol, decimals, name, logo for an ERC-20 contract.
  // ===========================================================================
  {
    route: "POST /api/token-metadata",
    name: "ERC-20 token metadata",
    slug: "token-metadata",
    category: "crypto",
    price: "$0.001",
    description:
      "Resolve an ERC-20 contract address to its on-chain metadata: symbol, decimals, name, and logo URL where available. Use this to humanize a raw contract address before showing it to a user or before computing fiat values.",
    tags: ["crypto", "erc20", "token", "metadata", "evm"],
    discovery: {
      bodyType: "json",
      input: { contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", network: "base" },
      inputSchema: {
        properties: {
          contract: { type: "string", description: "0x-prefixed 40-char ERC-20 contract address." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["contract"],
      },
      output: {
        example: {
          contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          network: "base",
          symbol: "USDC", name: "USD Coin", decimals: 6,
          logo: "https://example.com/usdc.png",
        },
      },
    },
    handler: async (i) => {
      const contract = takeAddress(i.contract, "contract");
      const network = pickNetwork(i.network);
      const meta = await jsonRpc(network, "alchemy_getTokenMetadata", [contract]);
      return {
        contract,
        network: network.name,
        symbol: meta?.symbol ?? null,
        name: meta?.name ?? null,
        decimals: typeof meta?.decimals === "number" ? meta.decimals : null,
        logo: meta?.logo ?? null,
      };
    },
  },

  // ===========================================================================
  // token-price — spot USD price for an ERC-20 contract (Alchemy Prices API).
  // ===========================================================================
  {
    route: "POST /api/token-price",
    name: "Token spot price (USD)",
    slug: "token-price",
    category: "crypto",
    price: "$0.001",
    description:
      "Return the current USD spot price for an ERC-20 token, identified by its contract address and network. Sourced from Alchemy's aggregated price feed. Use this for portfolio-value calculations or to denominate a balance in fiat without depending on a separate market-data API.",
    tags: ["crypto", "price", "token", "usd", "spot", "erc20"],
    discovery: {
      bodyType: "json",
      input: { contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", network: "base" },
      inputSchema: {
        properties: {
          contract: { type: "string", description: "0x-prefixed 40-char ERC-20 contract address." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["contract"],
      },
      output: {
        example: {
          contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          network: "base",
          symbol: "USDC", priceUsd: 1.0001, lastUpdated: "2026-06-22T17:30:00Z",
        },
      },
    },
    handler: async (i) => {
      const contract = takeAddress(i.contract, "contract");
      const network = pickNetwork(i.network);
      const r = await pricesApi("tokens/by-address", {
        addresses: [{ network: network.pricesId, address: contract }],
      });
      const row = r?.data?.[0] ?? r?.[0] ?? null;
      const priceObj = row?.prices?.find?.((p) => (p.currency || "").toLowerCase() === "usd") ?? row?.prices?.[0] ?? null;
      const priceUsd = priceObj?.value != null ? Number(priceObj.value) : null;
      return {
        contract,
        network: network.name,
        symbol: row?.symbol ?? null,
        priceUsd,
        lastUpdated: priceObj?.lastUpdatedAt ?? null,
      };
    },
  },

  // ===========================================================================
  // wallet-transactions — last N asset transfers (in + out).
  // ===========================================================================
  {
    route: "POST /api/wallet-transactions",
    name: "Wallet transaction history",
    slug: "wallet-transactions",
    category: "crypto",
    price: "$0.002",
    description:
      "Return the most recent asset transfers (incoming + outgoing) for a wallet address — native coin, ERC-20, ERC-721, ERC-1155 — already merged and sorted newest first. Each row carries the block, tx hash, counterparty, asset, and decimal value. Cap is 100 per direction; widen the window via `fromBlock` if you need deeper history.",
    tags: ["crypto", "wallet", "transactions", "history", "transfers", "evm"],
    discovery: {
      bodyType: "json",
      input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "base", limit: 10 },
      inputSchema: {
        properties: {
          address: { type: "string", description: "0x-prefixed 40-char hex wallet address." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
          limit: { type: "number", description: "Max transfers per direction (1-100, default 25)." },
          fromBlock: { type: "string", description: "Optional starting block in hex (default 0x0 = earliest)." },
        },
        required: ["address"],
      },
      output: {
        example: {
          address: "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0",
          network: "base", limit: 10,
          transfers: [
            { direction: "in", blockNum: 18250000, hash: "0xabc…", from: "0x…", to: "0xabf…", asset: "USDC", value: "0.001", category: "erc20" },
          ],
        },
      },
    },
    handler: async (i) => {
      const address = takeAddress(i.address);
      const network = pickNetwork(i.network);
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || 25, 1), 100);
      const fromBlock = typeof i.fromBlock === "string" && HEX_RE.test(i.fromBlock) ? i.fromBlock : "0x0";
      const categories = ["external", "erc20", "erc721", "erc1155"];
      const baseParams = { fromBlock, toBlock: "latest", category: categories, maxCount: `0x${limit.toString(16)}`, order: "desc" };
      const [out, inc] = await Promise.all([
        jsonRpc(network, "alchemy_getAssetTransfers", [{ ...baseParams, fromAddress: address }]),
        jsonRpc(network, "alchemy_getAssetTransfers", [{ ...baseParams, toAddress: address }]),
      ]);
      const norm = (rows, direction) =>
        (rows?.transfers ?? []).map((t) => ({
          direction,
          blockNum: parseInt(t.blockNum, 16),
          hash: t.hash,
          from: t.from,
          to: t.to,
          asset: t.asset ?? null,
          value: t.value != null ? String(t.value) : null,
          category: t.category,
        }));
      const merged = [...norm(out, "out"), ...norm(inc, "in")]
        .sort((a, b) => b.blockNum - a.blockNum)
        .slice(0, limit * 2);
      return { address, network: network.name, limit, transfers: merged };
    },
  },

  // ===========================================================================
  // nft-holdings — NFTs owned by a wallet.
  // ===========================================================================
  {
    route: "POST /api/nft-holdings",
    name: "NFT holdings for an address",
    slug: "nft-holdings",
    category: "crypto",
    price: "$0.002",
    description:
      "Return the NFTs owned by a wallet address on a given network. Each row carries the collection name, contract address, token ID, image URL (where available), and ERC-721 vs ERC-1155 standard. Up to 100 per call — paginate with `pageKey` from the previous response.",
    tags: ["crypto", "nft", "wallet", "erc721", "erc1155", "evm"],
    discovery: {
      bodyType: "json",
      input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "base" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "0x-prefixed 40-char hex wallet address." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
          pageKey: { type: "string", description: "Optional pagination cursor from a previous response." },
        },
        required: ["address"],
      },
      output: {
        example: {
          address: "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0",
          network: "base",
          totalCount: 0,
          nfts: [],
          pageKey: null,
        },
      },
    },
    handler: async (i) => {
      const address = takeAddress(i.address);
      const network = pickNetwork(i.network);
      const params = { owner: address, withMetadata: "true", pageSize: "100" };
      if (typeof i.pageKey === "string" && i.pageKey) params.pageKey = i.pageKey;
      const data = await nftApi(network, "getNFTsForOwner", params);
      const nfts = (data.ownedNfts ?? []).map((n) => ({
        contract: n.contract?.address?.toLowerCase() ?? null,
        tokenId: n.tokenId ?? null,
        standard: n.tokenType ?? null,
        title: n.name ?? n.contract?.name ?? null,
        collection: n.contract?.name ?? null,
        image: n.image?.cachedUrl ?? n.image?.originalUrl ?? null,
        balance: n.balance ?? "1",
      }));
      return {
        address,
        network: network.name,
        totalCount: data.totalCount ?? nfts.length,
        nfts,
        pageKey: data.pageKey ?? null,
      };
    },
  },

  // ===========================================================================
  // nft-metadata — metadata for a single NFT (contract + tokenId).
  // ===========================================================================
  {
    route: "POST /api/nft-metadata",
    name: "NFT metadata lookup",
    slug: "nft-metadata",
    category: "crypto",
    price: "$0.001",
    description:
      "Resolve the metadata for a single NFT: title, description, image URLs (original + cached CDN), attributes/traits, and the standard (ERC-721 vs ERC-1155). Useful when you have a contract+tokenId and need the display data without re-fetching the whole collection.",
    tags: ["crypto", "nft", "metadata", "erc721", "erc1155", "evm"],
    discovery: {
      bodyType: "json",
      input: { contract: "0xed5af388653567af2f388e6224dc7c4b3241c544", tokenId: "1", network: "ethereum" },
      inputSchema: {
        properties: {
          contract: { type: "string", description: "0x-prefixed 40-char NFT contract address." },
          tokenId: { type: "string", description: "Token ID as a string (decimal or hex)." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["contract", "tokenId"],
      },
      output: {
        example: {
          contract: "0xed5af388653567af2f388e6224dc7c4b3241c544",
          tokenId: "1",
          network: "ethereum",
          title: "Azuki #1",
          collection: "Azuki",
          standard: "ERC721",
          description: "Azuki starts with…",
          image: "https://example.com/azuki1.png",
          attributes: [{ trait_type: "Hair", value: "Pink Hairband" }],
        },
      },
    },
    handler: async (i) => {
      const contract = takeAddress(i.contract, "contract");
      const tokenId = typeof i.tokenId === "string" ? i.tokenId.trim() : "";
      if (!tokenId) throw bad(`"tokenId" is required (decimal or hex string)`);
      const network = pickNetwork(i.network);
      const data = await nftApi(network, "getNFTMetadata", { contractAddress: contract, tokenId });
      return {
        contract,
        tokenId,
        network: network.name,
        title: data.name ?? null,
        collection: data.contract?.name ?? null,
        standard: data.tokenType ?? null,
        description: data.description ?? null,
        image: data.image?.cachedUrl ?? data.image?.originalUrl ?? null,
        attributes: data.raw?.metadata?.attributes ?? [],
      };
    },
  },

  // ===========================================================================
  // gas-snapshot — slow / standard / fast gas tier in gwei + USD.
  // ===========================================================================
  {
    route: "POST /api/gas-snapshot",
    name: "Gas snapshot (slow / standard / fast)",
    slug: "gas-snapshot",
    category: "crypto",
    price: "$0.001",
    description:
      "Live gas price snapshot for a chain — slow / standard / fast tiers in gwei, plus the latest base fee. Sampled from eth_feeHistory (last 4 blocks, 25th/50th/90th percentile priority fees). Use to estimate before broadcasting a transaction from another tool.",
    tags: ["crypto", "gas", "fees", "evm", "transaction"],
    discovery: {
      bodyType: "json",
      input: { network: "base" },
      inputSchema: {
        properties: {
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
      },
      output: {
        example: {
          network: "base", chainId: 8453,
          baseFeeGwei: 0.005,
          slow: { priorityFeeGwei: 0.001, totalGwei: 0.006 },
          standard: { priorityFeeGwei: 0.002, totalGwei: 0.007 },
          fast: { priorityFeeGwei: 0.005, totalGwei: 0.010 },
        },
      },
    },
    handler: async (i) => {
      const network = pickNetwork(i.network);
      const history = await jsonRpc(network, "eth_feeHistory", ["0x4", "latest", [25, 50, 90]]);
      const baseHexArr = history?.baseFeePerGas ?? [];
      const rewardsArr = history?.reward ?? [];
      const baseFee = baseHexArr.length ? BigInt(baseHexArr[baseHexArr.length - 1]) : 0n;
      const lastReward = rewardsArr.length ? rewardsArr[rewardsArr.length - 1] : ["0x0", "0x0", "0x0"];
      const toGwei = (wei) => Number(wei) / 1e9;
      const tier = (idx) => {
        const priority = BigInt(lastReward[idx] || "0x0");
        return {
          priorityFeeGwei: Number(toGwei(priority).toFixed(6)),
          totalGwei: Number(toGwei(baseFee + priority).toFixed(6)),
        };
      };
      return {
        network: network.name,
        chainId: network.chainId,
        baseFeeGwei: Number(toGwei(baseFee).toFixed(6)),
        slow: tier(0),
        standard: tier(1),
        fast: tier(2),
      };
    },
  },

  // ===========================================================================
  // eth-call — read-only JSON-RPC passthrough (whitelisted methods).
  // ===========================================================================
  {
    route: "POST /api/eth-call",
    name: "Read-only JSON-RPC passthrough",
    slug: "eth-call",
    category: "crypto",
    price: "$0.002",
    description:
      "Escape hatch for power users: forward an arbitrary read-only JSON-RPC method to the chain. Method must be in our read-only whitelist (eth_call, eth_getLogs, eth_getBlockByNumber, eth_getTransactionReceipt, eth_chainId, eth_blockNumber, etc.). Mutating methods (eth_sendTransaction, eth_sendRawTransaction) are rejected — sign and broadcast through your own provider.",
    tags: ["crypto", "rpc", "json-rpc", "evm", "eth-call", "advanced"],
    discovery: {
      bodyType: "json",
      input: { method: "eth_blockNumber", params: [], network: "base" },
      inputSchema: {
        properties: {
          method: { type: "string", description: "JSON-RPC method (must be in the read-only whitelist)." },
          params: { type: "array", description: "JSON-RPC parameter array (often empty for simple methods)." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["method"],
      },
      output: {
        example: {
          network: "base",
          method: "eth_blockNumber",
          result: "0x1234567",
        },
      },
    },
    handler: async (i) => {
      const method = typeof i.method === "string" ? i.method.trim() : "";
      if (!method) throw bad(`"method" is required`);
      if (!RPC_METHOD_WHITELIST.has(method)) {
        throw bad(`Method "${method}" is not in the read-only whitelist. Allowed: ${[...RPC_METHOD_WHITELIST].join(", ")}`);
      }
      const params = Array.isArray(i.params) ? i.params : [];
      const network = pickNetwork(i.network);
      const result = await jsonRpc(network, method, params);
      return { network: network.name, method, result };
    },
  },
];
