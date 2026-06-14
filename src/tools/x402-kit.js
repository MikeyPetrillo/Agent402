// x402 payments kit — NON-CUSTODIAL tooling for agents that move their own
// money with their own key. Agent402 never holds, receives, or transfers funds:
// these tools decode 402 quotes, read public on-chain state, and BUILD (never
// sign) an EIP-3009 transfer authorization. All keyless (public Base RPC).
//
//   x402-quote             fetch a URL's HTTP 402 and decode its payment terms
//   x402-verify            confirm a USDC payment settled on-chain (by tx hash)
//   usdc-balance           USDC balance of an address on Base
//   tx-status              confirmation status of a transaction
//   gas-estimate           current Base gas price
//   transfer-authorization build EIP-3009 transferWithAuthorization typed data
//
// Marked wallet-only so they are NOT exposed on the free hosted connector — the
// payments surface stays on the paid HTTP/npm path.
import { randomBytes } from "node:crypto";
import { assertPublicUrl, ssrfDispatcher } from "./fetch-guard.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; // USDC on Base
const USDC_DECIMALS = 6;
const CHAIN_ID = 8453;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BASE_RPCS = (process.env.BASE_RPCS ||
  "https://mainnet.base.org,https://base-rpc.publicnode.com,https://base.llamarpc.com,https://base.drpc.org")
  .split(",").map((s) => s.trim()).filter(Boolean);

const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const isTxHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
const pad32 = (hexNo0x) => hexNo0x.toLowerCase().padStart(64, "0");
const topicToAddress = (t) => "0x" + t.slice(26).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Atomic units (BigInt) -> decimal string, no float rounding.
function formatUnits(raw, decimals) {
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

async function rpc(method, params, { passes = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < passes; attempt++) {
    for (const url of BASE_RPCS) {
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
  throw bad(`Base RPC unavailable: ${lastErr?.message}`, 502);
}

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
          ...(method === "POST" ? { body: "{}", } : {}),
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
        x402Version: body?.x402Version,
        accepts,
        ...(paymentRequired && !accepts ? { note: "402 returned but no x402 'accepts' array found; check the response body/headers", raw: body } : {}),
      };
    },
  },
  {
    route: "GET /api/usdc-balance", name: "USDC balance (Base)", slug: "usdc-balance", category: "payments", price: "$0.003",
    description:
      "Read the USDC balance of any address on Base. Read-only on-chain call. ?address=0x…",
    tags: ["usdc", "balance", "base", "wallet", "erc20"],
    discovery: {
      input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0" },
      inputSchema: { properties: { address: { type: "string", description: "0x EVM address" } }, required: ["address"] },
      output: { example: { address: "0x…", usdc: "12.5", raw: "12500000", token: "USDC", network: "base" } },
    },
    handler: async (i) => {
      if (!isAddress(i.address)) throw bad("address must be a 0x EVM address");
      const data = "0x70a08231" + pad32(i.address.slice(2)); // balanceOf(address)
      const hex = await rpc("eth_call", [{ to: USDC, data }, "latest"]);
      const raw = BigInt(hex && hex !== "0x" ? hex : "0x0");
      return { address: i.address, usdc: formatUnits(raw, USDC_DECIMALS), raw: raw.toString(), token: "USDC", network: "base" };
    },
  },
  {
    route: "GET /api/tx-status", name: "Transaction status (Base)", slug: "tx-status", category: "payments", price: "$0.003",
    description:
      "Check the confirmation status of a Base transaction by hash: success / failed / pending / not found, with block, from, to, and gas used. Read-only. ?hash=0x…",
    tags: ["transaction", "status", "receipt", "base", "confirmation"],
    discovery: {
      input: { hash: "0x0000000000000000000000000000000000000000000000000000000000000000" },
      inputSchema: { properties: { hash: { type: "string", description: "0x transaction hash" } }, required: ["hash"] },
      output: { example: { hash: "0x…", status: "success", blockNumber: 18000000, from: "0x…", to: "0x…", gasUsed: 51000 } },
    },
    handler: async (i) => {
      if (!isTxHash(i.hash)) throw bad("hash must be a 0x transaction hash (32 bytes)");
      const receipt = await rpc("eth_getTransactionReceipt", [i.hash]);
      if (!receipt) {
        const tx = await rpc("eth_getTransactionByHash", [i.hash]);
        return { hash: i.hash, status: tx ? "pending" : "not_found" };
      }
      return {
        hash: i.hash,
        status: BigInt(receipt.status) === 1n ? "success" : "failed",
        blockNumber: parseInt(receipt.blockNumber, 16),
        from: receipt.from, to: receipt.to,
        gasUsed: parseInt(receipt.gasUsed, 16),
      };
    },
  },
  {
    route: "GET /api/gas-estimate", name: "Gas price (Base)", slug: "gas-estimate", category: "payments", price: "$0.002",
    description:
      "Current gas price on Base, in gwei and wei — for an agent budgeting a transaction. Read-only.",
    tags: ["gas", "gas-price", "base", "fees", "gwei"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: { example: { network: "base", gasPriceGwei: "0.0051", gasPriceWei: "5100000" } },
    },
    handler: async () => {
      const hex = await rpc("eth_gasPrice", []);
      const wei = BigInt(hex);
      return { network: "base", gasPriceGwei: formatUnits(wei, 9), gasPriceWei: wei.toString() };
    },
  },
  {
    route: "GET /api/x402-verify", name: "Verify x402 settlement", slug: "x402-verify", category: "payments", price: "$0.004",
    description:
      "Confirm a USDC payment actually settled on Base: given a transaction hash, returns whether it succeeded and the USDC transfers it contains (from, to, amount). Optionally check it paid a specific address at least a minimum amount. Read-only proof of payment. ?hash=0x…&to=0x…&min=0.001",
    tags: ["x402", "verify", "settlement", "receipt", "usdc", "proof"],
    discovery: {
      input: { hash: "0x0000000000000000000000000000000000000000000000000000000000000000" },
      inputSchema: {
        properties: {
          hash: { type: "string", description: "0x transaction hash" },
          to: { type: "string", description: "optional: expected recipient address to check" },
          min: { type: "number", description: "optional: minimum USDC expected to that recipient" },
        },
        required: ["hash"],
      },
      output: {
        example: {
          hash: "0x…", settled: true, status: "success",
          transfers: [{ from: "0x…", to: "0x…", usdc: "0.001" }], matched: true,
        },
      },
    },
    handler: async (i) => {
      if (!isTxHash(i.hash)) throw bad("hash must be a 0x transaction hash (32 bytes)");
      const receipt = await rpc("eth_getTransactionReceipt", [i.hash]);
      if (!receipt) return { hash: i.hash, settled: false, status: "pending_or_not_found", transfers: [] };
      const status = BigInt(receipt.status) === 1n ? "success" : "failed";
      const transfers = (receipt.logs || [])
        .filter((l) => l.address?.toLowerCase() === USDC && l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC && l.topics.length >= 3)
        .map((l) => ({
          from: topicToAddress(l.topics[1]),
          to: topicToAddress(l.topics[2]),
          usdc: formatUnits(BigInt(l.data), USDC_DECIMALS),
        }));
      const out = { hash: i.hash, settled: status === "success" && transfers.length > 0, status, transfers };
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
      "Build the EIP-3009 transferWithAuthorization typed data for a gasless USDC transfer on Base — the exact EIP-712 object an agent signs with its OWN key to authorize an x402 payment. We construct it; we never sign or send. Non-custodial.",
    tags: ["x402", "eip-3009", "eip-712", "usdc", "transfer", "authorization", "gasless"],
    discovery: {
      bodyType: "json",
      input: { from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", amount: 0.01 },
      inputSchema: {
        properties: {
          from: { type: "string", description: "payer address (the wallet that will sign)" },
          to: { type: "string", description: "recipient address" },
          amount: { type: "number", description: "USDC amount (e.g. 0.01)" },
          validForSeconds: { type: "number", description: "how long the authorization is valid (default 3600)" },
        },
        required: ["from", "to", "amount"],
      },
      output: { example: { typedData: { domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589f…" }, primaryType: "TransferWithAuthorization", message: {} } } },
    },
    handler: (i) => {
      if (!isAddress(i.from)) throw bad('"from" must be a 0x EVM address');
      if (!isAddress(i.to)) throw bad('"to" must be a 0x EVM address');
      const amount = Number(i.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw bad('"amount" must be a positive number (USDC)');
      const value = BigInt(Math.round(amount * 10 ** USDC_DECIMALS)).toString();
      const now = Math.floor(Date.now() / 1000);
      const validForSeconds = Math.min(Math.max(parseInt(i.validForSeconds, 10) || 3600, 60), 86400);
      const nonce = "0x" + randomBytes(32).toString("hex");
      return {
        typedData: {
          domain: { name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: USDC },
          types: {
            TransferWithAuthorization: [
              { name: "from", type: "address" },
              { name: "to", type: "address" },
              { name: "value", type: "uint256" },
              { name: "validAfter", type: "uint256" },
              { name: "validBefore", type: "uint256" },
              { name: "nonce", type: "bytes32" },
            ],
          },
          primaryType: "TransferWithAuthorization",
          message: { from: i.from, to: i.to, value, validAfter: 0, validBefore: now + validForSeconds, nonce },
        },
        amountUsdc: amount, valueAtomic: value, asset: "USDC", network: "base", chainId: CHAIN_ID,
        note: "Sign typedData with the 'from' wallet (EIP-712 / signTypedData). Agent402 never signs or sends — this is the unsigned authorization only.",
      };
    },
  },
];
