// NFT market kit — the market-side surfaces that complement chain-kit's
// existing nft-holdings + nft-metadata tools. Built on Alchemy NFT API v3
// (already keyed via ALCHEMY_API_KEY, shared with chain-kit / dex-kit /
// mev-and-l2-kit on the same compute-unit pool — NFT endpoints are cheap,
// 1-5 CU per call).
//
// Why this kit: chain-kit already answers "what NFTs does this address own?"
// and "what is the metadata for one token?". This kit fills the missing
// market-side: collection-level identity (with OpenSea slug + verification)
// and cross-marketplace floor prices.
//
// Honest scoping: read-only collection identity + market prices. We don't
// list, buy, sweep, or sign anything. Both tools surface public on-chain
// data that the underlying contracts emit.
//
// nft-sales (Alchemy getNFTSales) was RETIRED 2026-08-19: Alchemy removes
// getNFTSales on 2026-09-30 with no direct replacement, and the live
// alternatives (Reservoir is itself sunsetting its NFT API; OpenSea v2 events
// need a key, cover OpenSea-only, and key collection events by slug not
// contract) would be a keyed, narrower, input-changed tool - not worth it for
// one $0.002 route. Re-add via OpenSea/SimpleHash if a sales tool is wanted.
//
// Upstreams (all Alchemy NFT v3, multichain):
//   • /getContractMetadata  — collection name, image, total supply, OS slug
//   • /getFloorPrice        — floor across OpenSea + LooksRare per collection
//
// Both tools are wallet-only — every handler hits Alchemy and shares the
// compute-unit quota with the rest of the chain stack.
//
// Covered by scripts/test-nft-market-kit.js (offline + opt-in live).

import { redactSecrets } from "./redact.js";
import { upstreamFetch, bodyUnderDeadline, underBudgetAll, PAYMENT_WINDOW_BUDGET_MS } from "../upstream-deadline.js";

// DEADLINES (src/upstream-deadline.js): one read per handler, under its own
// cap and the handler budget; a read that outlives it is a 503 naming the
// upstream and the step, never a 504.
const READ_MS = 12_000;

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
  const def = Object.hasOwn(NETWORKS, n) ? NETWORKS[n] : null;
  if (!def) throw bad(`Unsupported network "${value}" - supported: ${Object.keys(NETWORKS).join(", ")}`);
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
  const ctx = { label, step: path, timeoutMs: READ_MS, tag: "[nft-market]" };
  const res = await upstreamFetch(url, {
    headers: { accept: "application/json", "user-agent": "agent402/nft-market-kit" },
  }, ctx);
  if (!res.ok) {
    // Redact the FULL body before slicing — the Alchemy key rides the request
    // URL and an upstream error body could reflect it.
    const body = redactSecrets(await res.text().catch(() => "")).slice(0, 240);
    throw bad(`${label} upstream returned HTTP ${res.status}${body ? ": " + body : ""}`, res.status >= 500 ? 502 : res.status);
  }
  try { return await bodyUnderDeadline(res.json(), ctx); }
  catch (err) { if (err?.statusCode) throw err; throw bad(`${label} upstream returned non-JSON`, 502); }
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
];

// Test-only exports
export const __test = {
  takeAddress,
  takeTokenId,
  pickNetwork,
  NETWORKS,
};

// Every handler runs under one budget (src/upstream-deadline.js).
underBudgetAll(NFT_MARKET_TOOLS, PAYMENT_WINDOW_BUDGET_MS);
