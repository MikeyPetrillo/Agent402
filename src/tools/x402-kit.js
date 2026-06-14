// x402 payments kit — NON-CUSTODIAL, multi-chain tooling for agents that move
// their own money with their own key. Agent402 never holds, receives, or
// transfers funds: these tools decode 402 quotes, read public on-chain state,
// and BUILD (never sign) an EIP-3009 transfer authorization. Keyless public RPC.
//
//   x402-quote             fetch a URL's HTTP 402 and decode its payment terms
//   x402-verify            confirm a USDC payment settled on-chain (by tx hash)
//   usdc-balance           USDC balance of an address
//   tx-status              confirmation status of a transaction
//   gas-estimate           current gas price
//   transfer-authorization build EIP-3009 transferWithAuthorization typed data
//
// All chain tools take an optional `network` (base default; also polygon,
// arbitrum, optimism, ethereum). Marked wallet-only so they stay OFF the free
// hosted connector — the payments surface is the paid HTTP/npm path.
import { randomBytes } from "node:crypto";
import sha3 from "js-sha3"; // CommonJS — default import, then destructure
const { keccak256 } = sha3;
import { assertPublicUrl, ssrfDispatcher } from "./fetch-guard.js";

// ENS (Ethereum mainnet) — namehash + registry/resolver selectors for forward
// resolution (name -> address). keccak256 over UTF-8 labels per EIP-137.
const ENS_REGISTRY = "0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e";
const SEL_RESOLVER = "0x0178b8bf"; // resolver(bytes32)
const SEL_ADDR = "0x3b3b57de"; // addr(bytes32)
function namehash(name) {
  let node = Buffer.alloc(32);
  if (name) {
    for (const label of name.toLowerCase().split(".").reverse()) {
      const labelHash = Buffer.from(keccak256(label), "hex");
      node = Buffer.from(keccak256(Buffer.concat([node, labelHash])), "hex");
    }
  }
  return "0x" + node.toString("hex");
}
const isZeroAddr = (a) => /^0x0*$/.test(a);

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Native Circle USDC per chain (EIP-712 domain name "USD Coin" / version "2").
const NETWORKS = {
  base: {
    chainId: 8453, usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.llamarpc.com", "https://base.drpc.org"],
  },
  polygon: {
    chainId: 137, usdc: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    rpcs: ["https://polygon-rpc.com", "https://polygon-bor-rpc.publicnode.com", "https://polygon.llamarpc.com", "https://polygon.drpc.org"],
  },
  arbitrum: {
    chainId: 42161, usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.llamarpc.com", "https://arbitrum.drpc.org"],
  },
  optimism: {
    chainId: 10, usdc: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
    rpcs: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com", "https://optimism.llamarpc.com", "https://optimism.drpc.org"],
  },
  ethereum: {
    chainId: 1, usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://eth.drpc.org", "https://cloudflare-eth.com"],
  },
};
const NETWORK_NAMES = Object.keys(NETWORKS);
const USDC_DECIMALS = 6;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function resolveNetwork(name) {
  const key = String(name || "base").toLowerCase();
  const net = NETWORKS[key];
  if (!net) throw bad(`unknown network "${name}". Supported: ${NETWORK_NAMES.join(", ")}`);
  return { key, ...net };
}

const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const isTxHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
const pad32 = (hexNo0x) => hexNo0x.toLowerCase().padStart(64, "0");
const topicToAddress = (t) => "0x" + t.slice(26).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatUnits(raw, decimals) {
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

async function rpc(net, method, params, { passes = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < passes; attempt++) {
    for (const url of net.rpcs) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(15000),
          dispatcher: ssrfDispatcher,
        });
        const text = await r.text();
        let j; try { j = JSON.parse(text); } catch { lastErr = new Error(`${url}: non-JSON`); continue; }
        if (j.result !== undefined) return j.result;
        lastErr = new Error(`${url}: ${JSON.stringify(j.error ?? j).slice(0, 120)}`);
      } catch (e) { lastErr = e; }
    }
    if (attempt < passes - 1) await sleep(1000 * (attempt + 1));
  }
  throw bad(`${net.key} RPC unavailable: ${lastErr?.message}`, 502);
}

const NETWORK_PARAM = { type: "string", description: `chain: ${NETWORK_NAMES.join(" | ")} (default base)` };

export const X402_TOOLS = [
  {
    route: "GET /api/x402-quote", name: "x402 quote", slug: "x402-quote", category: "payments", price: "$0.003",
    description:
      "Probe any URL and decode its HTTP 402 payment requirements (price, asset, network, pay-to) into clean JSON — what an agent needs to decide whether/how to pay. Read-only; does not pay. ?url=https://api.example.com/paid&method=GET",
    tags: ["x402", "402", "payment-required", "quote", "discovery"],
    discovery: {
      input: { url: "https://agent402.tools/api/hash", method: "POST" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "URL of the paid resource to probe" },
          method: { type: "string", description: "HTTP method to probe with (default GET)" },
        },
        required: ["url"],
      },
      output: {
        example: {
          url: "https://api.example.com/paid", status: 402, paymentRequired: true,
          accepts: [{ scheme: "exact", network: "base", asset: "USDC", maxAmountRequired: "1000", payTo: "0x…" }],
        },
      },
    },
    handler: async (i) => {
      const method = (i.method || "GET").toUpperCase();
      if (!["GET", "POST", "HEAD"].includes(method)) throw bad("method must be GET, POST, or HEAD");
      const url = await assertPublicUrl(i.url);
      let res;
      try {
        res = await fetch(url, {
          method, redirect: "follow", dispatcher: ssrfDispatcher,
          signal: AbortSignal.timeout(15000),
          headers: { Accept: "application/json", "User-Agent": "Agent402-x402-quote/1.0" },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
      } catch (e) {
        throw bad(`could not reach URL: ${e.message}`, 502);
      }
      const paymentRequired = res.status === 402;
      let body = null;
      try { body = await res.json(); } catch { /* may be empty/non-JSON */ }
      const accepts = Array.isArray(body?.accepts) ? body.accepts : undefined;
      return {
        url: url.href, status: res.status, paymentRequired,
        x402Version: body?.x402Version, accepts,
        ...(paymentRequired && !accepts ? { note: "402 returned but no x402 'accepts' array found; check the response body/headers", raw: body } : {}),
      };
    },
  },
  {
    route: "GET /api/usdc-balance", name: "USDC balance", slug: "usdc-balance", category: "payments", price: "$0.003",
    description:
      "Read the USDC balance of any address on Base, Polygon, Arbitrum, Optimism, or Ethereum. Read-only on-chain call. ?address=0x…&network=base",
    tags: ["usdc", "balance", "wallet", "erc20", "multichain"],
    discovery: {
      input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "base" },
      inputSchema: { properties: { address: { type: "string", description: "0x EVM address" }, network: NETWORK_PARAM }, required: ["address"] },
      output: { example: { address: "0x…", usdc: "12.5", raw: "12500000", token: "USDC", network: "base" } },
    },
    handler: async (i) => {
      if (!isAddress(i.address)) throw bad("address must be a 0x EVM address");
      const net = resolveNetwork(i.network);
      const data = "0x70a08231" + pad32(i.address.slice(2));
      const hex = await rpc(net, "eth_call", [{ to: net.usdc, data }, "latest"]);
      const raw = BigInt(hex && hex !== "0x" ? hex : "0x0");
      return { address: i.address, usdc: formatUnits(raw, USDC_DECIMALS), raw: raw.toString(), token: "USDC", network: net.key };
    },
  },
  {
    route: "GET /api/tx-status", name: "Transaction status", slug: "tx-status", category: "payments", price: "$0.003",
    description:
      "Check the confirmation status of a transaction by hash on Base/Polygon/Arbitrum/Optimism/Ethereum: success / failed / pending / not found, with block, from, to, gas used. Read-only. ?hash=0x…&network=base",
    tags: ["transaction", "status", "receipt", "confirmation", "multichain"],
    discovery: {
      input: { hash: "0x0000000000000000000000000000000000000000000000000000000000000000", network: "base" },
      inputSchema: { properties: { hash: { type: "string", description: "0x transaction hash" }, network: NETWORK_PARAM }, required: ["hash"] },
      output: { example: { hash: "0x…", status: "success", network: "base", blockNumber: 18000000, from: "0x…", to: "0x…", gasUsed: 51000 } },
    },
    handler: async (i) => {
      if (!isTxHash(i.hash)) throw bad("hash must be a 0x transaction hash (32 bytes)");
      const net = resolveNetwork(i.network);
      const receipt = await rpc(net, "eth_getTransactionReceipt", [i.hash]);
      if (!receipt) {
        const tx = await rpc(net, "eth_getTransactionByHash", [i.hash]);
        return { hash: i.hash, network: net.key, status: tx ? "pending" : "not_found" };
      }
      return {
        hash: i.hash, network: net.key,
        status: BigInt(receipt.status) === 1n ? "success" : "failed",
        blockNumber: parseInt(receipt.blockNumber, 16),
        from: receipt.from, to: receipt.to, gasUsed: parseInt(receipt.gasUsed, 16),
      };
    },
  },
  {
    route: "GET /api/gas-estimate", name: "Gas price", slug: "gas-estimate", category: "payments", price: "$0.002",
    description:
      "Current gas price (gwei and wei) on Base, Polygon, Arbitrum, Optimism, or Ethereum — for an agent budgeting a transaction. Read-only. ?network=base",
    tags: ["gas", "gas-price", "fees", "gwei", "multichain"],
    discovery: {
      input: { network: "base" },
      inputSchema: { properties: { network: NETWORK_PARAM } },
      output: { example: { network: "base", gasPriceGwei: "0.0051", gasPriceWei: "5100000" } },
    },
    handler: async (i) => {
      const net = resolveNetwork(i.network);
      const hex = await rpc(net, "eth_gasPrice", []);
      const wei = BigInt(hex);
      return { network: net.key, gasPriceGwei: formatUnits(wei, 9), gasPriceWei: wei.toString() };
    },
  },
  {
    route: "GET /api/x402-verify", name: "Verify x402 settlement", slug: "x402-verify", category: "payments", price: "$0.004",
    description:
      "Confirm a USDC payment actually settled: given a tx hash (and network), returns whether it succeeded and the USDC transfers it contains (from, to, amount). Optionally check it paid a specific address at least a minimum amount. Read-only proof of payment. ?hash=0x…&network=base&to=0x…&min=0.001",
    tags: ["x402", "verify", "settlement", "receipt", "usdc", "proof", "multichain"],
    discovery: {
      input: { hash: "0x0000000000000000000000000000000000000000000000000000000000000000", network: "base" },
      inputSchema: {
        properties: {
          hash: { type: "string", description: "0x transaction hash" },
          network: NETWORK_PARAM,
          to: { type: "string", description: "optional: expected recipient address to check" },
          min: { type: "number", description: "optional: minimum USDC expected to that recipient" },
        },
        required: ["hash"],
      },
      output: { example: { hash: "0x…", network: "base", settled: true, status: "success", transfers: [{ from: "0x…", to: "0x…", usdc: "0.001" }], matched: true } },
    },
    handler: async (i) => {
      if (!isTxHash(i.hash)) throw bad("hash must be a 0x transaction hash (32 bytes)");
      const net = resolveNetwork(i.network);
      const receipt = await rpc(net, "eth_getTransactionReceipt", [i.hash]);
      if (!receipt) return { hash: i.hash, network: net.key, settled: false, status: "pending_or_not_found", transfers: [] };
      const status = BigInt(receipt.status) === 1n ? "success" : "failed";
      const transfers = (receipt.logs || [])
        .filter((l) => l.address?.toLowerCase() === net.usdc && l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC && l.topics.length >= 3)
        .map((l) => ({ from: topicToAddress(l.topics[1]), to: topicToAddress(l.topics[2]), usdc: formatUnits(BigInt(l.data), USDC_DECIMALS) }));
      const out = { hash: i.hash, network: net.key, settled: status === "success" && transfers.length > 0, status, transfers };
      if (i.to || i.min != null) {
        const to = i.to ? String(i.to).toLowerCase() : null;
        const min = i.min != null ? Number(i.min) : 0;
        out.matched = transfers.some((t) => (!to || t.to === to) && Number(t.usdc) >= min) && status === "success";
      }
      return out;
    },
  },
  {
    route: "POST /api/transfer-authorization", name: "Build USDC transfer authorization", slug: "transfer-authorization", category: "payments", price: "$0.003",
    description:
      "Build the EIP-3009 transferWithAuthorization typed data for a gasless USDC transfer on Base/Polygon/Arbitrum/Optimism/Ethereum — the exact EIP-712 object an agent signs with its OWN key to authorize an x402 payment. We construct it; we never sign or send. Non-custodial.",
    tags: ["x402", "eip-3009", "eip-712", "usdc", "transfer", "authorization", "gasless", "multichain"],
    discovery: {
      bodyType: "json",
      input: { from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", amount: 0.01, network: "base" },
      inputSchema: {
        properties: {
          from: { type: "string", description: "payer address (the wallet that will sign)" },
          to: { type: "string", description: "recipient address" },
          amount: { type: "number", description: "USDC amount (e.g. 0.01)" },
          network: NETWORK_PARAM,
          validForSeconds: { type: "number", description: "how long the authorization is valid (default 3600)" },
        },
        required: ["from", "to", "amount"],
      },
      output: { example: { typedData: { domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589f…" }, primaryType: "TransferWithAuthorization", message: {} }, network: "base" } },
    },
    handler: (i) => {
      if (!isAddress(i.from)) throw bad('"from" must be a 0x EVM address');
      if (!isAddress(i.to)) throw bad('"to" must be a 0x EVM address');
      const amount = Number(i.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw bad('"amount" must be a positive number (USDC)');
      const net = resolveNetwork(i.network);
      const value = BigInt(Math.round(amount * 10 ** USDC_DECIMALS)).toString();
      const now = Math.floor(Date.now() / 1000);
      const validForSeconds = Math.min(Math.max(parseInt(i.validForSeconds, 10) || 3600, 60), 86400);
      const nonce = "0x" + randomBytes(32).toString("hex");
      return {
        typedData: {
          domain: { name: "USD Coin", version: "2", chainId: net.chainId, verifyingContract: net.usdc },
          types: {
            TransferWithAuthorization: [
              { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
              { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
            ],
          },
          primaryType: "TransferWithAuthorization",
          message: { from: i.from, to: i.to, value, validAfter: 0, validBefore: now + validForSeconds, nonce },
        },
        amountUsdc: amount, valueAtomic: value, asset: "USDC", network: net.key, chainId: net.chainId,
        note: "Sign typedData with the 'from' wallet (EIP-712 / signTypedData). Agent402 never signs or sends — this is the unsigned authorization only.",
      };
    },
  },
  {
    route: "GET /api/ens-resolve", name: "ENS resolve", slug: "ens-resolve", category: "payments", price: "$0.003",
    description:
      "Resolve an ENS name (e.g. vitalik.eth) to its Ethereum address — so an agent can turn a human-readable recipient into a payable address. Read-only on Ethereum mainnet. ?name=vitalik.eth",
    tags: ["ens", "resolve", "ethereum", "name", "address"],
    discovery: {
      input: { name: "vitalik.eth" },
      inputSchema: { properties: { name: { type: "string", description: "an ENS name, e.g. name.eth" } }, required: ["name"] },
      output: { example: { name: "vitalik.eth", address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", found: true } },
    },
    handler: async (i) => {
      const name = String(i.name ?? "").trim().toLowerCase();
      if (!name || !name.includes(".") || /\s/.test(name)) throw bad("name must be an ENS name like vitalik.eth");
      const eth = resolveNetwork("ethereum");
      const node = namehash(name).slice(2);
      const resolverHex = await rpc(eth, "eth_call", [{ to: ENS_REGISTRY, data: SEL_RESOLVER + node }, "latest"]);
      const resolver = "0x" + (resolverHex || "0x").slice(-40);
      if (isZeroAddr(resolver)) return { name, address: null, found: false };
      const addrHex = await rpc(eth, "eth_call", [{ to: resolver, data: SEL_ADDR + node }, "latest"]);
      const address = "0x" + (addrHex || "0x").slice(-40);
      if (isZeroAddr(address)) return { name, address: null, found: false };
      return { name, address, found: true };
    },
  },
];
