// NFT market kit — the market-side surfaces that complement chain-kit's
// existing nft-holdings + nft-metadata tools. Built on Alchemy NFT API v3
// (already keyed via ALCHEMY_API_KEY, shared with chain-kit / dex-kit /
// mev-and-l2-kit on the same compute-unit pool — NFT endpoints are cheap,
// 1-5 CU per call).
//
// Why this kit: chain-kit already answers "what NFTs does this address own?"
// and "what is the metadata for one token?". This kit fills the missing
// market-side: collection-level identity (with OpenSea slug + verification),
// cross-marketplace floor prices, and recent sales history.
//
// Honest scoping: read-only collection identity + market prices + sales
// history. We don't list, buy, sweep, or sign anything. All three tools
// surface public on-chain data that the underlying contracts emit.
//
// Upstreams (all Alchemy NFT v3, multichain):
//   • /getContractMetadata  — collection name, image, total supply, OS slug
//   • /getFloorPrice        — floor across OpenSea + LooksRare per collection
//   • /getNFTSales          — recent sales for a collection (or token)
//
// All 3 tools are wallet-only — every handler hits Alchemy and shares the
// compute-unit quota with the rest of the chain stack.
//
// Covered by scripts/test-nft-market-kit.js (offline + opt-in live).

const TIMEOUT_MS = 12_000;

// Same chain map as chain-kit/dex-kit/mev-and-l2-kit so an agent can pivot
// freely. NFT API supports the same 5 chains.
const NETWORKS = {
  ethereum: { subdomain: "eth-mainnet", chainId: 1     },
  base:     { subdomain: "base-mainnet", chainId: 8453 },
  polygon:  { subdomain: "polygon-mainnet", chainId: 137 },
  arbitrum: { subdomain: "arb-mainnet", chainId: 42161 },
  optimism: { subdomain: "opt-mainnet", chainId: 10    },
};

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function requireAlchemyKey() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) throw bad("NFT market tools are not configured on this deployment (no ALCHEMY_API_KEY)", 503);
  return key;
}

function pickNetwork(value, dflt = "ethereum") {
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

function takeTokenId(raw) {
  // EIP-721 tokenId is a uint256; accept decimal string, "0x..." hex, or number.
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return String(Math.floor(raw));
  if (typeof raw === "string" && raw.trim().length) {
    const s = raw.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s).toString();
    if (/^\d+$/.test(s)) return s;
  }
  throw bad('"tokenId" must be a non-negative integer (decimal string, 0x-prefixed hex, or number)');
}

async function alchemyGet(network, path, params, label) {
  const key = requireAlchemyKey();
  const net = pickNetwork(network);
  const qs = new URLSearchParams(params).toString();
  const url = `https://${net.subdomain}.g.alchemy.com/nft/v3/${key}/${path}${qs ? "?" + qs : ""}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "agent402/nft-market-kit" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === "TimeoutError" || /aborted/i.test(e.message)) {
      throw bad(`${label} upstream timed out after ${TIMEOUT_MS}ms`, 504);
    }
    throw bad(`${label} upstream unreachable: ${e.message}`, 502);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 240);
    throw bad(`${label} upstream returned HTTP ${res.status}${body ? ": " + body : ""}`, res.status >= 500 ? 502 : res.status);
  }
  return res.json();
}

// ----------------------------------------------------------------------------
// 1. nft-collection — contract metadata (name, image, supply, OS slug)
// ----------------------------------------------------------------------------
async function nftCollection({ contract, network } = {}) {
  const c = takeAddress(contract, "contract");
  const net = pickNetwork(network);
  const json = await alchemyGet(net.name, "getContractMetadata", { contractAddress: c }, "Alchemy NFT");
  const meta = json.openSeaMetadata || {};
  return {
    contract: c,
    network: net.name,
    name: json.name ?? meta.collectionName ?? null,
    symbol: json.symbol ?? null,
    tokenType: json.tokenType ?? null,
    totalSupply: json.totalSupply ?? null,
    deployedBlockNumber: json.deployedBlockNumber ?? null,
    deployerAddress: json.contractDeployer ?? null,
    openSeaSlug: meta.collectionSlug ?? null,
    openSeaImage: meta.imageUrl ?? null,
    floorPrice: meta.floorPrice ?? null, // ETH
    floorPriceSource: meta.floorPrice != null ? "opensea" : null,
    safelistStatus: meta.safelistRequestStatus ?? null,
    description: meta.description ?? null,
    externalUrl: meta.externalUrl ?? null,
    twitterUsername: meta.twitterUsername ?? null,
    discordUrl: meta.discordUrl ?? null,
    source: "alchemy-nft-v3",
  };
}

// ----------------------------------------------------------------------------
// 2. nft-floor — floor price across marketplaces for a collection
// ----------------------------------------------------------------------------
async function nftFloor({ contract, network } = {}) {
  const c = takeAddress(contract, "contract");
  const net = pickNetwork(network);
  const json = await alchemyGet(net.name, "getFloorPrice", { contractAddress: c }, "Alchemy NFT");
  // Shape: { openSea: { floorPrice, priceCurrency, collectionUrl, retrievedAt, error }, looksRare: { ... } }
  const reshape = (m) => {
    if (!m || m.error) return { available: false, error: m?.error || "unavailable" };
    return {
      available: true,
      floorPrice: m.floorPrice ?? null,
      priceCurrency: m.priceCurrency ?? null,
      collectionUrl: m.collectionUrl ?? null,
      retrievedAt: m.retrievedAt ?? null,
    };
  };
  const openSea = reshape(json.openSea);
  const looksRare = reshape(json.looksRare);
  // Convenience: cheapest available floor in ETH (both marketplaces quote ETH).
  const candidates = [openSea, looksRare].filter((m) => m.available && typeof m.floorPrice === "number");
  const cheapest = candidates.length ? candidates.reduce((a, b) => (a.floorPrice <= b.floorPrice ? a : b)) : null;
  return {
    contract: c,
    network: net.name,
    openSea,
    looksRare,
    cheapestFloorEth: cheapest ? cheapest.floorPrice : null,
    cheapestMarketplace: cheapest ? (cheapest === openSea ? "opensea" : "looksrare") : null,
    source: "alchemy-nft-v3",
  };
}

// ----------------------------------------------------------------------------
// 3. nft-sales — recent sales for a collection (or specific token)
// ----------------------------------------------------------------------------
async function nftSales({ contract, tokenId, network, limit } = {}) {
  const c = takeAddress(contract, "contract");
  const net = pickNetwork(network);
  const lim = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 20));
  const params = { contractAddress: c, limit: String(lim), order: "desc" };
  if (tokenId !== undefined && tokenId !== null && tokenId !== "") {
    params.tokenId = takeTokenId(tokenId);
  }
  const json = await alchemyGet(net.name, "getNFTSales", params, "Alchemy NFT");
  const sales = (json.nftSales || []).map((s) => {
    const sp = s.sellerFee || {};
    const pp = s.protocolFee || {};
    const rp = s.royaltyFee || {};
    // sellerFee.amount is the wei-string price the seller received; sellerFee.decimals
    // + symbol identify the currency. Convert to a float for ergonomics.
    const priceUnits = sp.amount != null && sp.decimals != null
      ? Number(sp.amount) / 10 ** Number(sp.decimals)
      : null;
    return {
      txHash: s.transactionHash ?? null,
      blockNumber: s.blockNumber ?? null,
      logIndex: s.logIndex ?? null,
      buyer: s.buyerAddress ?? null,
      seller: s.sellerAddress ?? null,
      tokenId: s.tokenId ?? null,
      marketplace: s.marketplace ?? null,
      marketplaceAddress: s.marketplaceAddress ?? null,
      priceUnits,
      priceCurrency: sp.symbol ?? null,
      priceWei: sp.amount ?? null,
      protocolFeeWei: pp.amount ?? null,
      royaltyFeeWei: rp.amount ?? null,
      tokenType: s.tokenType ?? null,
      quantity: s.quantity ?? "1",
    };
  });
  return {
    contract: c,
    tokenId: params.tokenId ?? null,
    network: net.name,
    count: sales.length,
    sales,
    pageKey: json.pageKey ?? null,
    source: "alchemy-nft-v3",
  };
}

// ----------------------------------------------------------------------------
// Catalog
// ----------------------------------------------------------------------------
export const NFT_MARKET_TOOLS = [
  {
    route: "POST /api/nft-collection",
    name: "NFT collection metadata",
    slug: "nft-collection",
    category: "crypto",
    price: "$0.002",
    description:
      "Fetch NFT collection (ERC-721 / ERC-1155) metadata by contract address on Ethereum, Base, Polygon, Arbitrum, or Optimism: name, symbol, token type, total supply, deployer, OpenSea slug + image, floor (ETH), Twitter/Discord, and verification (safelist) status. Use to label a contract address with its collection identity before pulling tokens or sales.",
    tags: ["nft", "collection", "erc721", "erc1155", "metadata", "opensea"],
    discovery: {
      bodyType: "json",
      input: { contract: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d", network: "ethereum" },
      inputSchema: {
        type: "object",
        required: ["contract"],
        properties: {
          contract: { type: "string", description: "NFT contract address (0x-prefixed 40-hex)." },
          network: { type: "string", description: "Chain: ethereum, base, polygon, arbitrum, optimism (default ethereum)." },
        },
      },
      output: {
        example: {
          contract: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d",
          network: "ethereum",
          name: "BoredApeYachtClub",
          symbol: "BAYC",
          tokenType: "ERC721",
          totalSupply: "10000",
          deployedBlockNumber: 12287507,
          deployerAddress: "0xaba7161a7fb69c88e16ed9f455ce62b791ee4d03",
          openSeaSlug: "boredapeyachtclub",
          openSeaImage: "https://...",
          floorPrice: 13.5,
          floorPriceSource: "opensea",
          safelistStatus: "verified",
          description: "The Bored Ape Yacht Club is a collection of 10,000 unique Bored Ape NFTs.",
          externalUrl: "https://boredapeyachtclub.com",
          twitterUsername: "BoredApeYC",
          discordUrl: "https://discord.gg/3P5K3dzgdB",
          source: "alchemy-nft-v3",
        },
      },
    },
    handler: nftCollection,
  },
  {
    route: "POST /api/nft-floor",
    name: "NFT floor price",
    slug: "nft-floor",
    category: "crypto",
    price: "$0.002",
    description:
      "Get the current floor price for an NFT collection across OpenSea + LooksRare (Ethereum). Returns per-marketplace floor (ETH), collection URL, retrieval timestamp, and the cheapest cross-marketplace floor with the marketplace tag. Use to price a collection without scraping marketplace UIs, or to detect cross-venue arbitrage gaps.",
    tags: ["nft", "floor", "price", "opensea", "looksrare", "marketplace"],
    discovery: {
      bodyType: "json",
      input: { contract: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d" },
      inputSchema: {
        type: "object",
        required: ["contract"],
        properties: {
          contract: { type: "string", description: "NFT contract address (0x-prefixed 40-hex)." },
          network: { type: "string", description: "Chain: ethereum, base, polygon, arbitrum, optimism (default ethereum). Cross-marketplace floors are Ethereum-mainnet only." },
        },
      },
      output: {
        example: {
          contract: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d",
          network: "ethereum",
          openSea: { available: true, floorPrice: 13.5, priceCurrency: "ETH", collectionUrl: "https://opensea.io/collection/boredapeyachtclub", retrievedAt: "2026-06-22T19:00:00.000Z" },
          looksRare: { available: true, floorPrice: 13.7, priceCurrency: "ETH", collectionUrl: "https://looksrare.org/collections/0xbc4c...", retrievedAt: "2026-06-22T19:00:00.000Z" },
          cheapestFloorEth: 13.5,
          cheapestMarketplace: "opensea",
          source: "alchemy-nft-v3",
        },
      },
    },
    handler: nftFloor,
  },
  {
    route: "POST /api/nft-sales",
    name: "NFT recent sales",
    slug: "nft-sales",
    category: "crypto",
    price: "$0.002",
    description:
      "Recent sales for an NFT collection (or specific token) on any of 5 chains, ordered descending by block. Returns buyer, seller, marketplace (OpenSea/LooksRare/X2Y2/Blur), price (units + wei), protocol/royalty fees, tx hash, block, and quantity for each sale. Use to track volume, detect wash trades by repeat buyer/seller pairs, or chart a collection's price trajectory.",
    tags: ["nft", "sales", "history", "volume", "marketplace", "trades"],
    discovery: {
      bodyType: "json",
      input: { contract: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d", network: "ethereum", limit: 5 },
      inputSchema: {
        type: "object",
        required: ["contract"],
        properties: {
          contract: { type: "string", description: "NFT contract address (0x-prefixed 40-hex)." },
          tokenId: { type: "string", description: "Optional: limit sales to a specific token ID." },
          network: { type: "string", description: "Chain: ethereum, base, polygon, arbitrum, optimism (default ethereum)." },
          limit: { type: "number", description: "Max sales to return (1-100, default 20)." },
        },
      },
      output: {
        example: {
          contract: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d",
          tokenId: null,
          network: "ethereum",
          count: 1,
          sales: [{
            txHash: "0xabc...",
            blockNumber: 19000000,
            logIndex: 42,
            buyer: "0xbuyer...",
            seller: "0xseller...",
            tokenId: "1234",
            marketplace: "seaport",
            marketplaceAddress: "0x00000000006c3852cbef3e08e8df289169ede581",
            priceUnits: 12.5,
            priceCurrency: "ETH",
            priceWei: "12500000000000000000",
            protocolFeeWei: "0",
            royaltyFeeWei: "312500000000000000",
            tokenType: "ERC721",
            quantity: "1",
          }],
          pageKey: null,
          source: "alchemy-nft-v3",
        },
      },
    },
    handler: nftSales,
  },
];

// Test-only exports
export const __test = {
  takeAddress,
  takeTokenId,
  pickNetwork,
  NETWORKS,
};
