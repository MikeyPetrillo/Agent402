// chain-rpc-kit - the five EVM reads the catalog did not have a name for.
//
// WHY THIS KIT IS SMALL. The obvious reading of "we should cover what the
// busiest x402 seller covers" was that we had a capability gap. We do not: of
// the 25 chain reads that seller lists, we already sold 20 under our own names
// (token-allowance, block-info, eth-call, contract-code, contract-abi,
// ens-resolve, token-balances, asset-transfers, nft-holdings, gas-estimate,
// event-logs, wallet-balance, chain-info, nft-metadata, erc721-owner,
// tx-receipt, tx-status, wallet-transactions, address-profile, evm-rpc), and
// the generic evm-rpc route covered the rest. The gap was that a buyer who
// knows `eth_getTransactionCount` had no way to guess we sell it.
//
// So the answer was a NAMESPACE (src/chain-namespace.js maps the RPC verb a
// buyer already knows onto the route that already serves it) plus these five
// reads, which genuinely had no named home. Listing twenty aliases as twenty
// more catalog rows would have been row-count theatre - the same capability
// counted twice on every index that reads our manifest, which is exactly the
// registry inflation we decline to do.
//
// Each of these is ONE JSON-RPC read through chain-kit's own transport, so it
// inherits the Alchemy-then-public fallback chain, the provider-refusal
// fallthrough and the SSRF dispatcher. Priced with block-number and
// contract-code, which do the same amount of work.
import { pickNetwork, publicJsonRpc } from "./chain-kit.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function takeAddress(raw, field = "address") {
  if (typeof raw !== "string" || !ADDR_RE.test(raw.trim())) {
    throw bad(`"${field}" must be a 0x-prefixed 40-char hex Ethereum address`);
  }
  return raw.trim().toLowerCase();
}

// "latest" (default), "pending", "earliest", "safe", "finalized", a decimal
// height or a 0x height. A caller reading a nonce for a transaction they are
// about to sign wants "pending"; one auditing history wants a height. Both are
// one word apart and neither should need a different endpoint.
function takeBlockTag(raw) {
  if (raw === undefined || raw === null || raw === "") return "latest";
  const v = String(raw).trim().toLowerCase();
  if (["latest", "pending", "earliest", "safe", "finalized"].includes(v)) return v;
  if (/^0x[0-9a-f]+$/.test(v)) return v;
  if (/^\d+$/.test(v)) return `0x${BigInt(v).toString(16)}`;
  throw bad('"block" must be latest, pending, earliest, safe, finalized, a block number, or a 0x block number');
}

const hexToDec = (hex) => {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/.test(hex)) return null;
  return BigInt(hex === "0x" ? "0x0" : hex).toString(10);
};

const pad32 = (hexNoPrefix) => hexNoPrefix.padStart(64, "0");
const addrWord = (addr) => pad32(addr.slice(2).toLowerCase());
const uintWord = (v) => pad32(BigInt(v).toString(16));

/** A uint256 rendered with a token's decimals, without floating point. */
function formatUnits(raw, decimals) {
  if (raw === null || decimals === null) return null;
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 36) return null;
  const s = String(raw).padStart(d + 1, "0");
  const whole = s.slice(0, s.length - d);
  const frac = d ? s.slice(s.length - d).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * A REVERT IS AN ANSWER, NOT AN OUTAGE.
 *
 * When a contract does not implement the method being called, the node answers
 * "execution reverted" and chain-kit's transport raises that as a 502 - which
 * blames the upstream for what is really a fact about the caller's address.
 * My own corpus cases caught it: asking an EOA for totalSupply() and an ERC-20
 * for the ERC-1155 balanceOf both came back 502. Both are 422s that name the
 * cause, and a 4xx also cancels settlement, so the caller is not charged for
 * learning that their address is the wrong kind of thing.
 *
 * Only a revert is reclassified. A timeout, a refusal or a dead node stays the
 * 502 it is, because those are outages and the caller should retry.
 */
const isRevert = (e) => /execution reverted|revert/i.test(String(e?.message || ""));

async function ethCall(network, to, data, { onRevert } = {}) {
  try {
    return await publicJsonRpc(network, "eth_call", [{ to, data }, "latest"]);
  } catch (e) {
    if (onRevert && isRevert(e)) throw Object.assign(new Error(onRevert), { statusCode: 422 });
    throw e;
  }
}

/** decimals() on a token, or null when the contract does not answer it. */
async function tokenDecimals(network, contract) {
  try {
    const hex = await ethCall(network, contract, "0x313ce567");
    const dec = hexToDec(hex);
    return dec === null ? null : Number(dec);
  } catch { return null; }
}

export const CHAIN_RPC_TOOLS = [
  {
    route: "GET /api/chain/nonce",
    name: "Account nonce",
    slug: "chain-nonce",
    category: "crypto",
    price: "$0.001",
    description:
      "The transaction count of an account, which is the nonce its next transaction must carry. Ask for block \"pending\" to include transactions already in the mempool, which is what you want before signing; the default \"latest\" counts only mined transactions. Returns the count as a decimal string and as hex. EVM chains: ethereum, base, polygon, arbitrum, optimism.",
    tags: ["evm", "nonce", "account", "rpc", "transaction"],
    aliases: ["transaction-count", "eth_getTransactionCount", "account-nonce"],
    discovery: {
      input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "base" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "0x account address" },
          network: { type: "string", description: "ethereum | base | polygon | arbitrum | optimism (default base)" },
          block: { type: "string", description: 'latest (default), pending, earliest, safe, finalized, or a block number. Use "pending" for the nonce of a transaction you are about to send.' },
        },
        required: ["address"],
      },
      output: { example: { address: "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0", network: "base", block: "latest", nonce: "412", nonceHex: "0x19c" } },
    },
    handler: async (input) => {
      const network = pickNetwork(input?.network);
      const address = takeAddress(input?.address);
      const block = takeBlockTag(input?.block);
      const hex = await publicJsonRpc(network, "eth_getTransactionCount", [address, block]);
      const nonce = hexToDec(hex);
      if (nonce === null) throw Object.assign(new Error("The RPC did not return a transaction count for that account"), { statusCode: 502 });
      return { address, network: network.name, block, nonce, nonceHex: hex };
    },
  },
  {
    route: "GET /api/chain/storage",
    name: "Contract storage slot",
    slug: "chain-storage",
    category: "crypto",
    price: "$0.001",
    description:
      "Read one 32-byte storage slot from a contract, the raw state under whatever the source code calls it. Returns the word as hex plus three readings of the same bytes - unsigned integer, address (low 20 bytes) and boolean - because a slot is untyped on chain and only the caller knows which it meant. Useful for proxy implementation slots, paused flags and any value the ABI does not expose. EVM chains: ethereum, base, polygon, arbitrum, optimism.",
    tags: ["evm", "storage", "slot", "rpc", "contract"],
    aliases: ["eth_getStorageAt", "storage-at", "slot"],
    discovery: {
      input: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", slot: "0x0", network: "base" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "0x contract address" },
          slot: { type: "string", description: "Slot index: a decimal number or a 0x-prefixed hex key (EIP-1967 implementation slot is 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)" },
          network: { type: "string", description: "ethereum | base | polygon | arbitrum | optimism (default base)" },
          block: { type: "string", description: "latest (default), pending, earliest, safe, finalized, or a block number" },
        },
        required: ["address", "slot"],
      },
      output: {
        example: {
          address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          network: "base", slot: "0x0", block: "latest",
          value: "0x0000000000000000000000000000000000000000000000000000000000000001",
          asUint: "1", asAddress: "0x0000000000000000000000000000000000000001", asBool: true,
        },
      },
    },
    handler: async (input) => {
      const network = pickNetwork(input?.network);
      const address = takeAddress(input?.address);
      const block = takeBlockTag(input?.block);
      const rawSlot = input?.slot;
      if (rawSlot === undefined || rawSlot === null || rawSlot === "") throw bad('"slot" is required: a decimal slot index or a 0x-prefixed hex slot key');
      const s = String(rawSlot).trim().toLowerCase();
      let slot;
      if (/^0x[0-9a-f]+$/.test(s)) slot = s;
      else if (/^\d+$/.test(s)) slot = `0x${BigInt(s).toString(16)}`;
      else throw bad('"slot" must be a decimal slot index or a 0x-prefixed hex slot key');
      const value = await publicJsonRpc(network, "eth_getStorageAt", [address, slot, block]);
      if (typeof value !== "string" || !/^0x[0-9a-f]*$/i.test(value)) {
        throw Object.assign(new Error("The RPC did not return a storage word for that slot"), { statusCode: 502 });
      }
      const word = value.slice(2).padStart(64, "0");
      return {
        address, network: network.name, slot, block, value: `0x${word}`,
        // The same 32 bytes, read three ways. A slot has no type on chain.
        asUint: BigInt(`0x${word}`).toString(10),
        asAddress: `0x${word.slice(24)}`,
        asBool: BigInt(`0x${word}`) === 1n,
      };
    },
  },
  {
    route: "GET /api/chain/pending",
    name: "Pending block",
    slug: "chain-pending",
    category: "crypto",
    price: "$0.001",
    description:
      "The chain's pending block: how many transactions are queued for the next block, the base fee they will pay, and the gas already used against the limit. This is the node's own view of what is about to be mined, so it answers \"is the chain congested right now\" without an indexer. Transaction hashes are included when the node returns them. EVM chains: ethereum, base, polygon, arbitrum, optimism.",
    tags: ["evm", "pending", "mempool", "gas", "rpc"],
    aliases: ["mempool", "pending-block", "queued"],
    discovery: {
      input: { network: "base" },
      inputSchema: {
        properties: {
          network: { type: "string", description: "ethereum | base | polygon | arbitrum | optimism (default base)" },
          hashes: { type: "boolean", description: "Include the pending transaction hashes (default false, counts only)" },
        },
        required: [],
      },
      output: {
        example: {
          network: "base", number: "34881204", transactionCount: 61,
          baseFeePerGas: "4218231", baseFeePerGasGwei: "0.004218",
          gasUsed: "12904331", gasLimit: "150000000", timestamp: "2026-09-12T21:30:11.000Z",
          note: "A pending block is the node's own view and differs between nodes; it is not a consensus value.",
        },
      },
    },
    handler: async (input) => {
      const network = pickNetwork(input?.network);
      const wantHashes = input?.hashes === true || input?.hashes === "true";
      const b = await publicJsonRpc(network, "eth_getBlockByNumber", ["pending", false]);
      if (!b || typeof b !== "object") {
        throw Object.assign(new Error(`${network.name} returned no pending block - not every node builds one`), { statusCode: 502 });
      }
      const txs = Array.isArray(b.transactions) ? b.transactions : [];
      const baseFee = hexToDec(b.baseFeePerGas);
      const ts = hexToDec(b.timestamp);
      return {
        network: network.name,
        number: hexToDec(b.number),
        transactionCount: txs.length,
        baseFeePerGas: baseFee,
        baseFeePerGasGwei: baseFee === null ? null : formatUnits(baseFee, 9),
        gasUsed: hexToDec(b.gasUsed),
        gasLimit: hexToDec(b.gasLimit),
        timestamp: ts === null ? null : new Date(Number(ts) * 1000).toISOString(),
        ...(wantHashes ? { transactions: txs } : {}),
        note: "A pending block is the node's own view and differs between nodes; it is not a consensus value.",
      };
    },
  },
  {
    route: "GET /api/chain/total-supply",
    name: "Token total supply",
    slug: "chain-total-supply",
    category: "crypto",
    price: "$0.001",
    description:
      "The circulating total supply of an ERC-20, read from the token contract itself rather than from an aggregator, so it is the number the chain holds at the block you asked for. Returns the raw uint256 and the same figure formatted with the token's own decimals. A contract that does not implement totalSupply answers 422 rather than a fabricated zero. EVM chains: ethereum, base, polygon, arbitrum, optimism.",
    tags: ["evm", "erc20", "supply", "token", "rpc"],
    aliases: ["totalSupply", "token-supply", "erc20-supply"],
    discovery: {
      input: { contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "base" },
      inputSchema: {
        properties: {
          contract: { type: "string", description: "0x ERC-20 token contract address" },
          network: { type: "string", description: "ethereum | base | polygon | arbitrum | optimism (default base)" },
        },
        required: ["contract"],
      },
      output: { example: { contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", network: "base", totalSupply: "4182993441205067", decimals: 6, totalSupplyFormatted: "4182993441.205067" } },
    },
    handler: async (input) => {
      const network = pickNetwork(input?.network);
      const contract = takeAddress(input?.contract, "contract");
      const notAToken = `${contract} did not answer totalSupply() on ${network.name} - it may not be an ERC-20, or not deployed on this chain`;
      const hex = await ethCall(network, contract, "0x18160ddd", { onRevert: notAToken });
      const raw = hexToDec(hex);
      if (raw === null || hex === "0x") throw Object.assign(new Error(notAToken), { statusCode: 422 });
      const decimals = await tokenDecimals(network, contract);
      return {
        contract, network: network.name,
        totalSupply: raw,
        decimals,
        totalSupplyFormatted: formatUnits(raw, decimals),
      };
    },
  },
  {
    route: "GET /api/chain/erc1155-balance",
    name: "ERC-1155 balance",
    slug: "chain-erc1155-balance",
    category: "crypto",
    price: "$0.002",
    description:
      "How many of one ERC-1155 token id an account holds, read straight from the contract. ERC-1155 is the multi-token standard behind most game items, editions and passes, where a single contract holds many ids and a balance is a quantity rather than ownership of one thing. Returns the balance as a decimal string. EVM chains: ethereum, base, polygon, arbitrum, optimism.",
    tags: ["evm", "erc1155", "nft", "balance", "rpc"],
    aliases: ["1155-balance", "multi-token-balance", "edition-balance"],
    discovery: {
      input: { contract: "0x2953399124F0cBB46d2CbACD8A89cF0599974963", address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", tokenId: "1", network: "polygon" },
      inputSchema: {
        properties: {
          contract: { type: "string", description: "0x ERC-1155 contract address" },
          address: { type: "string", description: "0x holder address" },
          tokenId: { type: "string", description: "Token id, decimal or 0x hex" },
          network: { type: "string", description: "ethereum | base | polygon | arbitrum | optimism (default base)" },
        },
        required: ["contract", "address", "tokenId"],
      },
      output: { example: { contract: "0x2953399124f0cbb46d2cbacd8a89cf0599974963", address: "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0", tokenId: "1", network: "polygon", balance: "0" } },
    },
    handler: async (input) => {
      const network = pickNetwork(input?.network);
      const contract = takeAddress(input?.contract, "contract");
      const address = takeAddress(input?.address);
      const rawId = input?.tokenId;
      if (rawId === undefined || rawId === null || rawId === "") throw bad('"tokenId" is required (decimal or 0x hex)');
      const idStr = String(rawId).trim().toLowerCase();
      let id;
      try {
        id = /^0x[0-9a-f]+$/.test(idStr) ? BigInt(idStr) : BigInt(idStr);
      } catch { throw bad('"tokenId" must be a decimal or 0x-prefixed hex token id'); }
      // balanceOf(address,uint256) on the ERC-1155 interface.
      const data = `0x00fdd58e${addrWord(address)}${uintWord(id)}`;
      const not1155 = `${contract} did not answer balanceOf(address,uint256) on ${network.name} - it may not be an ERC-1155, or not deployed on this chain`;
      const hex = await ethCall(network, contract, data, { onRevert: not1155 });
      const balance = hexToDec(hex);
      if (balance === null || hex === "0x") throw Object.assign(new Error(not1155), { statusCode: 422 });
      return { contract, address, tokenId: id.toString(10), network: network.name, balance };
    },
  },
];
