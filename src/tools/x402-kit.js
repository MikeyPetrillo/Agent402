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
// arbitrum, optimism, ethereum, monad, celo, avalanche, sei, robinhood -
// robinhood is chain-read only, see requireUsdc()). Marked wallet-only so they
// stay OFF the free hosted connector - the payments surface is the paid
// HTTP/npm path.
import { randomBytes } from "node:crypto";
import sha3 from "js-sha3"; // CommonJS — default import, then destructure
const { keccak256 } = sha3;

// FR4-08: read a response body with a hard byte cap. `AbortSignal.timeout`
// bounds elapsed time, not memory — a fast large response from a user-controlled
// URL would still buffer unbounded via res.json()/res.text(). Cancels the stream
// and throws (502) past the cap. x402 quote/audit metadata is small.
const X402_MAX_BODY_BYTES = 256 * 1024;
async function boundedText(res, maxBytes = X402_MAX_BODY_BYTES) {
  const reader = res.body?.getReader?.();
  if (!reader) return await res.text();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw Object.assign(new Error(`response body exceeded ${maxBytes} bytes`), { statusCode: 502 });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}
import { assertPublicUrl, ssrfDispatcher } from "./fetch-guard.js";
import { redactSecrets } from "./redact.js";

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

// Native Circle USDC per chain. `name` is the on-chain EIP-712 domain name
// signed into the transferWithAuthorization typed data - Circle's canonical
// deployments answer "USD Coin", but Monad, Celo, and Sei's native Circle USDC
// report the domain name as "USDC" instead (verified against each chain
// directly - see src/payments.js, which settles the same four chains and
// carries the same addresses/names, independently confirmed on-chain again
// here 2026-08-11). Getting this field wrong makes a buyer sign a valid-looking
// authorization against the WRONG domain, which a facilitator's exact/EIP-3009
// verify then silently rejects - so it is explicit per chain, never assumed.
const NETWORKS = {
  base: {
    chainId: 8453, usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", name: "USD Coin",
    rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"],
  },
  polygon: {
    chainId: 137, usdc: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", name: "USD Coin",
    rpcs: ["https://polygon-rpc.com", "https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
  },
  arbitrum: {
    chainId: 42161, usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", name: "USD Coin",
    rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
  },
  optimism: {
    chainId: 10, usdc: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", name: "USD Coin",
    rpcs: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"],
  },
  ethereum: {
    chainId: 1, usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", name: "USD Coin",
    rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://cloudflare-eth.com"],
  },
  // Monad (EVM L1, chain 143). Native Circle USDC, but the on-chain EIP-712
  // domain name is "USDC" not "USD Coin" (same fact src/payments.js's
  // makeMonadUsdcScheme relies on for settlement; verified again directly
  // against the chain 2026-08-11: name()="USDC", version()="2", decimals=6).
  monad: {
    chainId: 143, usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", name: "USDC",
    rpcs: ["https://rpc.monad.xyz", "https://rpc2.monad.xyz"],
  },
  // Celo (EVM L2, chain 42220). Native Circle USDC, on-chain EIP-712 domain
  // name "USDC" not "USD Coin" (same fact src/payments.js's
  // makeCeloUsdcScheme relies on; verified again directly 2026-08-11).
  celo: {
    chainId: 42220, usdc: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", name: "USDC",
    rpcs: ["https://forno.celo.org"],
  },
  // Avalanche C-Chain (chain 43114). Native Circle USDC, standard "USD Coin"
  // domain name (verified 2026-08-11).
  avalanche: {
    chainId: 43114, usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", name: "USD Coin",
    rpcs: ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"],
  },
  // Sei (pacific-1 EVM, chain 1329). Native Circle USDC - NOT Noble's IBC
  // token (0x3894…) - on-chain EIP-712 domain name "USDC" (verified 2026-08-11,
  // same address src/payments.js and src/revenue-live.js already settle/scan).
  // evm-rpc.sei-apis.com is known to reject eth_getLogs from Railway's egress
  // IPs (see revenue-live.js) - irrelevant here, these tools never call
  // eth_getLogs, only eth_call/eth_gasPrice/eth_getTransactionReceipt, all
  // verified working against this same endpoint 2026-08-11.
  sei: {
    chainId: 1329, usdc: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392", name: "USDC",
    rpcs: ["https://evm-rpc.sei-apis.com", "https://sei-evm-rpc.publicnode.com"],
  },
  // Robinhood Chain — Arbitrum Orbit / Nitro L2, EVM-equivalent, AI-native RWA
  // chain (tokenized US stocks/ETFs, 24/7 markets), mainnet live 2026-07-01.
  // Gas token is ETH; the chain's canonical stablecoin is USDG (Global Dollar),
  // NOT Circle USDC — so `usdc` is intentionally omitted and the USDC-specific
  // tools skip it via requireUsdc(). The chain-read tools (tx-status,
  // gas-estimate) work here today; USDC payments await facilitator + USDG support.
  robinhood: {
    chainId: 4663,
    // Alchemy first when the key is set (per-app network enablement required
    // on the Alchemy dashboard — a not-enabled network 403s and falls through
    // to the public RPC). This chain has exactly one public endpoint, so the
    // Alchemy lane is the only redundancy available.
    rpcs: [
      ...(process.env.ALCHEMY_API_KEY ? [`https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
      "https://rpc.mainnet.chain.robinhood.com",
    ],
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

// Some chains (e.g. Robinhood Chain) settle in a non-Circle stablecoin (USDG),
// so they carry no canonical Circle USDC address. The USDC-specific tools call
// this to fail with a clear, actionable message instead of building a call to
// `undefined`. Chain-read tools (tx-status, gas-estimate) don't need it.
function requireUsdc(net) {
  if (!net.usdc) {
    throw bad(
      `USDC tools aren't available on ${net.key} - its canonical stablecoin is USDG (Global Dollar), not Circle USDC. ` +
        `The chain-read tools (tx-status, gas-estimate) do work on ${net.key}.`
    );
  }
  return net.usdc;
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
        const text = await boundedText(r);
        let j; try { j = JSON.parse(text); } catch { lastErr = new Error(`${url}: non-JSON`); continue; }
        if (j.result !== undefined) return j.result;
        lastErr = new Error(`${url}: ${JSON.stringify(j.error ?? j).slice(0, 120)}`);
      } catch (e) { lastErr = e; }
    }
    if (attempt < passes - 1) await sleep(1000 * (attempt + 1));
  }
  // lastErr.message can embed the RPC URL, which for the Alchemy robinhood
  // endpoint carries ALCHEMY_API_KEY — redact before it reaches the buyer/log.
  throw bad(`${net.key} RPC unavailable: ${redactSecrets(String(lastErr?.message ?? "")).slice(0, 200)}`, 502);
}

const NETWORK_PARAM = { type: "string", description: `chain: ${NETWORK_NAMES.join(" | ")} (default base)` };

export const X402_TOOLS = [
  {
    route: "GET /api/x402-market-pulse", name: "x402 market pulse", slug: "x402-market-pulse", category: "payments", price: "$0.01",
    description:
      "Live cross-provider x402 market sentiment. topProviders: the top x402 sellers ecosystem-wide, ranked by REAL on-chain activity (Agent402 included and flagged isSelf:true). Pick the lens with sort: 'usd' (revenue, default - whale-skewable), 'buyers' (distinct paying wallets - broadest adoption/reach), or 'calls' (raw volume). Every row carries all metrics plus callsPerBuyer (intensity), so revenue and actual ecosystem usage are both visible. topToolCategories: the tool-category supply mix the whole market offers (from every indexed seller's manifest). Per-tool purchase counts are not on-chain, so demand is provider-level - the honest whole-market read. ?top=10&sort=buyers",
    tags: ["x402", "market", "sentiment", "leaderboard", "ecosystem", "providers", "intelligence", "discovery"],
    discovery: {
      input: { top: 10, sort: "usd" },
      inputSchema: {
        properties: {
          top: { type: "integer", description: "How many top providers to return (1-50, default 10). Agent402's own row is always included at its true rank even if it falls outside this many." },
          sort: { type: "string", enum: ["usd", "buyers", "calls"], description: "Ranking lens: usd=revenue (default), buyers=distinct paying wallets (reach), calls=raw volume" },
        },
      },
      output: {
        example: {
          asOf: "2026-07-12T00:00:00.000Z", window: "last 24h", sortedBy: "usd",
          ecosystem: { sellersIndexed: 1479, toolsIndexed: 33779, toolsCapPerSeller: 50 },
          topProviders: [{ rank: 1, provider: "blockrun.ai", usdSettled: 294.55, calls: 353970, buyers: 163, callsPerBuyer: 2171, homepage: "https://blockrun.ai" }],
          topToolCategories: [{ category: "crypto", sellersOffering: 446, tools: 3353 }],
        },
      },
    },
    handler: async (i) => {
      const [{ getLeaderboardSnapshot }, { ecosystemMarket }] = await Promise.all([
        import("../leaderboard.js"), import("../x402-index.js"),
      ]);
      const top = Math.min(Math.max(parseInt(i?.top, 10) || 10, 1), 50);
      // "Top" is multi-dimensional: revenue is whale-skewable, distinct buyers
      // is the broadest-adoption lens, calls is raw volume. Let the caller pick
      // which question they're asking; every row carries all metrics regardless.
      const SORTS = { usd: (r) => r.usdSettled, buyers: (r) => r.buyers, calls: (r) => r.calls };
      const sort = SORTS[String(i?.sort || "").toLowerCase()] ? String(i.sort).toLowerCase() : "usd";
      const lb = (typeof getLeaderboardSnapshot === "function" && getLeaderboardSnapshot()) || null;
      const board = Array.isArray(lb?.leaderboard) ? lb.leaderboard : [];
      // Agent402 is a market participant too - include it, but label our own row
      // so the ranking is honest (a market pulse that deletes a top seller is wrong).
      const isSelf = (r) => /agent402\.tools/i.test(String(r?.homepage || "")) || (r?.origins || []).some((o) => /agent402\.tools/i.test(String(o)));
      const rows = board.map((r) => {
        const usdSettled = +(Number(r.totalUsd) || 0).toFixed(2);
        const calls = Number(r.callsSettled) || 0;
        const buyers = Number(r.uniqueBuyers) || 0;
        return {
          provider: r.name || String(r.homepage || "").replace(/^https?:\/\//, ""),
          usdSettled, calls, buyers,
          callsPerBuyer: buyers ? Math.round(calls / buyers) : calls, // intensity; noisy when buyers is tiny
          homepage: r.homepage || null,
          ...(isSelf(r) ? { isSelf: true } : {}),
        };
      });
      const ranked = rows.sort((a, b) => SORTS[sort](b) - SORTS[sort](a) || b.usdSettled - a.usdSettled);
      const topProviders = ranked.slice(0, top).map((r, idx) => ({ rank: idx + 1, ...r }));
      // Always surface Agent402: if our row ranks outside the top-N on this lens,
      // append it at its TRUE rank (not a faked position) so the caller can always
      // see where we stand, whatever the sort or top value.
      if (!topProviders.some((r) => r.isSelf)) {
        const selfIdx = ranked.findIndex((r) => r.isSelf);
        if (selfIdx >= 0) topProviders.push({ rank: selfIdx + 1, outsideTop: true, ...ranked[selfIdx] });
      }
      const market = ecosystemMarket({ limit: 12 });
      return {
        asOf: lb?.asOf || null,
        window: lb?.windowLabel || "last 24h",
        sortedBy: sort,
        ecosystem: { sellersIndexed: market.sellers, toolsIndexed: market.tools, toolsCapPerSeller: market.toolsCapPerSeller },
        topProviders,
        topToolCategories: market.categories,
        note: "Cross-provider x402 market pulse. topProviders = real on-chain activity per seller (ecosystem-wide, primarily Base), ranked by sortedBy; Agent402 is ranked alongside everyone else and flagged isSelf:true, and is always included at its true rank (with outsideTop:true) even when it falls outside the top-N on the chosen lens. Revenue (usd) is whale-skewable, buyers is the broadest-adoption lens, calls is raw volume, callsPerBuyer is intensity (noisy when buyers is tiny) - all four ride every row so revenue and real usage are both visible. topToolCategories = SUPPLY mix, ranked by DISTINCT SELLERS per category (the dominance-resistant metric); each category's tools count is capped at toolsCapPerSeller per seller so one giant auto-generated catalogue can't skew it - ecosystem.toolsIndexed is the true, uncapped total. Categories come from a closed functional taxonomy (crypto, defi, finance, social, ai, search, etc.); per-tool purchase counts are not published on-chain, so tool-level demand cannot be measured directly. Sources: the hourly cross-seller index crawl + the on-chain leaderboard.",
      };
    },
  },
  {
    route: "GET /api/x402-quote", name: "x402 quote", slug: "x402-quote", category: "payments", price: "$0.002",
    description:
      "Probe any URL and decode its HTTP 402 payment requirements (price, asset, network, pay-to) into clean JSON - what an agent needs to decide whether/how to pay. Read-only; does not pay. ?url=https://api.example.com/paid&method=GET",
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
      try { const t = await boundedText(res); body = t ? JSON.parse(t) : null; } catch { /* may be empty/non-JSON/oversized */ }
      // x402 v1 put the payment requirements in the 402 body; v2 moved them to
      // the base64-encoded PAYMENT-REQUIRED header (the body is `{}`). Decode
      // whichever the seller speaks — without the header path this tool returns
      // an empty quote for every v2 seller, including this server itself.
      let accepts = Array.isArray(body?.accepts) && body.accepts.length ? body.accepts : undefined;
      let x402Version = body?.x402Version ?? undefined;
      if (!accepts) {
        const header = res.headers.get("payment-required");
        if (header) {
          try {
            const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
            if (Array.isArray(decoded?.accepts)) accepts = decoded.accepts;
            x402Version = decoded?.x402Version ?? x402Version;
          } catch { /* undecodable header → fall through to the note below */ }
        }
      }
      return {
        url: url.href, status: res.status, paymentRequired,
        x402Version, accepts,
        ...(paymentRequired && !accepts ? { note: "402 returned but no x402 'accepts' found in the body (v1) or PAYMENT-REQUIRED header (v2)", raw: body } : {}),
      };
    },
  },
  {
    route: "GET /api/usdc-balance", name: "USDC balance", slug: "usdc-balance", category: "payments", price: "$0.003",
    description:
      "Read the USDC balance of any address on Base, Polygon, Arbitrum, Optimism, Ethereum, Monad, Celo, Avalanche, or Sei. Read-only on-chain call. The minimal single-token read for payment flows - for EVERY token a wallet holds in one call use wallet-balance. ?address=0x…&network=base",
    tags: ["usdc", "balance", "wallet", "erc20", "multichain"],
    discovery: {
      input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "base" },
      inputSchema: { properties: { address: { type: "string", description: "0x EVM address" }, network: NETWORK_PARAM }, required: ["address"] },
      output: { example: { address: "0x…", usdc: "12.5", raw: "12500000", token: "USDC", network: "base" } },
    },
    handler: async (i) => {
      if (!isAddress(i.address)) throw bad("address must be a 0x EVM address");
      const net = resolveNetwork(i.network);
      requireUsdc(net);
      const data = "0x70a08231" + pad32(i.address.slice(2));
      const hex = await rpc(net, "eth_call", [{ to: net.usdc, data }, "latest"]);
      const raw = BigInt(hex && hex !== "0x" ? hex : "0x0");
      return { address: i.address, usdc: formatUnits(raw, USDC_DECIMALS), raw: raw.toString(), token: "USDC", network: net.key };
    },
  },
  {
    route: "GET /api/tx-status", name: "Transaction status", slug: "tx-status", category: "payments", price: "$0.001",
    description:
      "Check the confirmation status of a transaction by hash on Base/Polygon/Arbitrum/Optimism/Ethereum/Monad/Celo/Avalanche/Sei/Robinhood Chain: success / failed / pending / not found, with block, from, to, gas used. Read-only. ?hash=0x…&network=base",
    tags: ["transaction", "status", "receipt", "confirmation", "multichain", "robinhood", "usdg"],
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
      "Current gas price (gwei and wei) on Base, Polygon, Arbitrum, Optimism, Ethereum, Monad, Celo, Avalanche, Sei, or Robinhood Chain - for an agent budgeting a transaction. Read-only. ?network=base",
    tags: ["gas", "gas-price", "fees", "gwei", "multichain", "robinhood", "usdg"],
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
      requireUsdc(net);
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
      "Build the EIP-3009 transferWithAuthorization typed data for a gasless USDC transfer on Base/Polygon/Arbitrum/Optimism/Ethereum/Monad/Celo/Avalanche/Sei - the exact EIP-712 object an agent signs with its OWN key to authorize an x402 payment. We construct it; we never sign or send. Non-custodial.",
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
      requireUsdc(net);
      const value = BigInt(Math.round(amount * 10 ** USDC_DECIMALS)).toString();
      const now = Math.floor(Date.now() / 1000);
      const validForSeconds = Math.min(Math.max(parseInt(i.validForSeconds, 10) || 3600, 60), 86400);
      const nonce = "0x" + randomBytes(32).toString("hex");
      return {
        typedData: {
          domain: { name: net.name, version: "2", chainId: net.chainId, verifyingContract: net.usdc },
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
        note: "Sign typedData with the 'from' wallet (EIP-712 / signTypedData). Agent402 never signs or sends - this is the unsigned authorization only.",
      };
    },
  },
  {
    route: "GET /api/ens-resolve", name: "ENS resolve", slug: "ens-resolve", category: "payments", price: "$0.001",
    description:
      "Resolve an ENS name (e.g. vitalik.eth) to its Ethereum address - so an agent can turn a human-readable recipient into a payable address. Read-only on Ethereum mainnet. ?name=vitalik.eth",
    tags: ["ens", "resolve", "ethereum", "name", "address", "lookup"],
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
  {
    route: "GET /api/x402-audit", name: "x402 security audit", slug: "x402-audit", category: "payments", price: "$0.01",
    description:
      "Grade any x402 seller's payment-security posture from the outside - a read-only black-box check mapped to the 'Five Attacks on x402' failure modes. Probes the URL's 402 challenge (never pays) and scores TLS transport, gated-response cache hygiene (Attack III / cache leakage), error/info-leak hygiene, and payment-terms well-formedness, then returns a letter grade with per-check findings and an honest note on what only insider/active testing can confirm. ?url=https://api.example.com/paid&method=GET",
    tags: ["x402", "audit", "security", "posture", "cache", "tls", "grade", "five-attacks"],
    discovery: {
      input: { url: "https://agent402.tools/api/hash", method: "POST" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "URL of the paid resource to audit" },
          method: { type: "string", description: "HTTP method to probe with (default GET)" },
        },
        required: ["url"],
      },
      output: {
        example: {
          url: "https://api.example.com/paid", reachable: true, status: 402, paymentRequired: true,
          x402Version: 2, score: 92, grade: "A",
          checks: [
            { id: "transport-tls", title: "Payment challenge served over TLS", attack: "credential interception", severity: "high", status: "pass", detail: "https" },
            { id: "cache-hygiene", title: "Gated response is not shared-cacheable", attack: "III - cache leakage", severity: "high", status: "pass", detail: "Cache-Control: no-store, private" },
          ],
          summary: "A (92/100) - 6 passed, 1 warning, 0 failed. Note: replay/idempotency (II) and router Sybil (IV) can't be graded from outside.",
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
          headers: { Accept: "application/json", "User-Agent": "Agent402-x402-audit/1.0" },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
      } catch (e) {
        throw bad(`could not reach URL: ${e.message}`, 502);
      }

      const cacheControl = res.headers.get("cache-control") || "";
      let bodyText = "";
      try { bodyText = await boundedText(res); } catch { /* empty/unreadable/oversized body */ }
      const paymentRequiredHeader = res.headers.get("payment-required") || null;
      return gradeX402Response({ href: url.href, protocol: url.protocol, status: res.status, cacheControl, bodyText, paymentRequiredHeader });
    },
  },
  {
    route: "GET /api/x402-trending", name: "x402 trending sellers", slug: "x402-trending", category: "payments", price: "$0.005",
    description:
      "Momentum radar for the x402 seller ecosystem - which sellers are heating up, graded for wash-trade resistance. Reads the hourly on-chain leaderboard (real Base USDC settlements) and adds per-seller signals the raw board doesn't have: organicScore (uniqueBuyers/callsSettled - 1000 calls from 2 buyers smells like self-dealing, 1000 from 400 is organic demand) and avgTicketUsd. Rank by sort: 'usd' (revenue, default), 'calls' (volume), 'organic' (buyer diversity - the honest-demand lens), or 'buyers' (reach). include='external' (default) excludes Agent402's own row; 'all' keeps it. Once ~7 days of persisted snapshots accrue, each row also carries deltaVsPrevWeek + trend (rising/flat/cooling/new) - the wow envelope says whether those are live; deltas are never faked. ?sort=organic&limit=10",
    tags: ["x402", "trending", "momentum", "sellers", "leaderboard", "organic", "wash-trading", "ecosystem", "discovery"],
    discovery: {
      input: { sort: "usd", limit: 10, include: "external" },
      inputSchema: {
        properties: {
          sort: { type: "string", enum: ["usd", "calls", "organic", "buyers"], description: "Ranking lens: usd=USDC settled (default), calls=raw volume, organic=organicScore (buyer diversity), buyers=distinct paying wallets" },
          limit: { type: "integer", description: "How many sellers to return (1-50, default 10)" },
          include: { type: "string", enum: ["external", "all"], description: "external (default) excludes Agent402's own wallet; all keeps it" },
        },
      },
      output: {
        example: {
          window: "24h", sort: "usd", include: "external", limit: 10, totalSellers: 214,
          sellers: [{
            rank: 1, name: "example-seller", homepage: "https://seller.example", network: "base",
            wallet: "0x1111111111111111111111111111111111111111",
            callsSettled: 3541, totalUsd: 41.2, uniqueBuyers: 402,
            organicScore: 0.1135, avgTicketUsd: 0.011635,
          }],
          wow: { available: false, note: "no persisted snapshot ~7 days old yet - week-over-week deltas activate automatically as history accrues" },
          snapshotAsOf: "2026-07-14T00:00:00.000Z", generatedAt: "2026-07-14T00:00:05.000Z",
        },
      },
    },
    handler: async (i) => {
      const { getLeaderboardSnapshot, readLeaderboardHistory } = await import("../leaderboard.js");
      return computeTrending(getLeaderboardSnapshot(), i, {
        selfWallet: process.env.WALLET_ADDRESS || "",
        history: readLeaderboardHistory(),
      });
    },
  },
  {
    route: "GET /api/demand-radar", name: "agent demand radar", slug: "demand-radar", category: "research", price: "$0.005",
    description:
      "What agents want that no one is serving yet - the paid intelligence layer over Agent402's agent-demand board, for x402 sellers deciding what to build next. Ranks the aggregated wish clusters (searches that found nothing + explicit tool requests) and adds the analysis the free raw feed (/api/wishes) doesn't have: signalType classifies each cluster as 'explicit-request' (agents proactively asked - build it), 'discoverability' (dominated by find-misses - the capability may exist but ranking failed, so improve discovery before building), or 'mixed'; nearThreshold marks clusters within 2 signals of the build threshold (the strongest build signals), with gapToThreshold as the exact distance; obvious operator/CI test traffic is flagged noise:true, never silently dropped. sort: 'count' (default) or 'recent' (by lastSeen); minCount filters low-signal noise. ?sort=count&limit=10",
    tags: ["demand", "market-intelligence", "x402", "agents", "wishes", "research"],
    discovery: {
      input: { sort: "count", limit: 10, minCount: 1 },
      inputSchema: {
        properties: {
          sort: { type: "string", enum: ["count", "recent"], description: "Ranking lens: count=most-demanded first (default), recent=most recently seen first" },
          limit: { type: "integer", description: "How many clusters to return (1-50, default 10)" },
          minCount: { type: "integer", description: "Only clusters with at least this many signals (default 1)" },
        },
      },
      output: {
        example: {
          totalWishes: 42, distinctClusters: 17, buildThreshold: 5,
          sort: "count", minCount: 1, limit: 10, matchedClusters: 17,
          radar: [{
            text: "reverse geocode coordinates to street address",
            count: 4, sources: { api: 3, mcp: 1, "find-miss": 0 },
            firstSeen: "2026-07-01T09:00:00.000Z", lastSeen: "2026-07-13T18:30:00.000Z",
            signalType: "explicit-request", nearThreshold: true, gapToThreshold: 1, noise: false,
          }],
          generatedAt: "2026-07-14T00:00:05.000Z",
        },
      },
    },
    handler: async (i) => {
      const { getWishesAggregate } = await import("../wish.js");
      return computeDemandRadar(getWishesAggregate({ limit: 500 }), i);
    },
  },
  {
    route: "GET /api/bestsellers", name: "Agent402 bestsellers", slug: "bestsellers", category: "research", price: "$0.005",
    description:
      "What agents actually pay for on a 500+ tool x402 catalog - the paid intelligence layer over Agent402's own sales ledger, the one demand signal that never reaches the chain (settlements are on-chain; WHICH tool was bought is not). Aggregate sales totals are free at /api/sales; this adds the per-tool layer they deliberately omit: pick the window (days 1-90) and the ranking lens with sort: 'buyers' (distinct paying wallets, default - the whale/wash-resistant read), 'sales' (volume), 'usd' (revenue), or 'organic' (buyers-per-sale diversity grade, same metric as x402-trending); every row carries all lenses plus organicScore, avgTicketUsd, revenueShare, and a trend vs the previous same-length window (deltaSales + rising/flat/cooling/new - never faked: a row with no prior-window sales says 'new'). Canary/burner/heartbeat traffic is excluded at the source, and if this tool ranks in its own chart the row is flagged isSelf:true rather than hidden - buying the chart puts you on the chart. ?sort=buyers&days=30&limit=10",
    tags: ["bestsellers", "demand", "market-intelligence", "sales", "x402", "catalog", "trending", "discovery"],
    discovery: {
      input: { days: 30, sort: "buyers", limit: 10 },
      inputSchema: {
        properties: {
          days: { type: "integer", description: "Aggregation window in days, 1-90 (default 30). The trend compares against the same-length window immediately before it." },
          sort: { type: "string", enum: ["buyers", "sales", "usd", "organic"], description: "Ranking lens: buyers=distinct paying wallets (default, whale-resistant), sales=volume, usd=revenue, organic=organicScore (buyer diversity)" },
          limit: { type: "integer", description: "How many tools to return (1-50, default 10)" },
        },
      },
      output: {
        example: {
          days: 30, sort: "buyers", limit: 10,
          recordingSince: "2026-07-04T00:00:00.000Z", persistent: true,
          totals: { sales: 63, revenueUsd: 0.58, distinctTools: 12 },
          bestsellers: [{
            rank: 1, slug: "vin-decode", sales: 14, revenueUsd: 0.056, revenueShare: 0.0966,
            buyers: 6, organicScore: 0.4286, avgTicketUsd: 0.004,
            firstAt: "2026-07-05T11:00:00.000Z", lastAt: "2026-07-14T09:30:00.000Z",
            prevSales: 3, deltaSales: 11, trend: "rising",
          }],
          note: "External paid demand only - canary/burner/heartbeat traffic excluded at the source.",
          generatedAt: "2026-07-16T00:00:05.000Z",
        },
      },
    },
    handler: async (i) => {
      const { externalSlugWindow, firstRecordedTs, salesPersistent } = await import("../sales-ledger.js");
      const days = clampBestsellerDays(i?.days);
      const now = Date.now();
      const since = now - days * 86400000;
      return computeBestsellers(
        externalSlugWindow(since, now + 1),
        externalSlugWindow(since - days * 86400000, since),
        i,
        { recordingSince: firstRecordedTs(), persistent: salesPersistent, now }
      );
    },
  },
];

/**
 * Compute the x402-trending response from a leaderboard snapshot (and optional
 * persisted history). Pure and deterministic given its inputs — no network, no
 * env reads — so it is unit-testable in isolation (scripts/test-x402-trending.js).
 *
 * Momentum signals from a single snapshot:
 *   - organicScore = uniqueBuyers / callsSettled, clamped to [0,1] (0 when no
 *     calls). High = diverse organic demand; low = few wallets hammering one
 *     seller (wash-trade smell). This is the wash-resistance differentiator.
 *   - avgTicketUsd = totalUsd / callsSettled (0 when no calls).
 *
 * Week-over-week (honest): only computed when a persisted daily point aged
 * 6-10 days exists (closest to 7 wins). Then each row gains deltaVsPrevWeek
 * {callsSettled, totalUsd}, trend (rising/flat/cooling by a ±5%-of-prev-calls
 * band, min 1 call) and newThisWindow (true when the seller has no matching
 * wallet in the baseline). Without a baseline the envelope's `wow.available`
 * is false and NO delta fields appear — the tool never fakes a WoW number.
 */
export function computeTrending(snap, input = {}, { selfWallet = "", history = [] } = {}) {
  const SORTS = new Set(["usd", "calls", "organic", "buyers"]);
  const sort = SORTS.has(String(input?.sort || "").toLowerCase()) ? String(input.sort).toLowerCase() : "usd";
  const limit = Math.min(Math.max(parseInt(input?.limit, 10) || 10, 1), 50);
  const include = input?.include === "all" ? "all" : "external";
  const self = String(selfWallet || "").toLowerCase();

  let board = Array.isArray(snap?.leaderboard) ? snap.leaderboard : [];
  // Same convention as /api/leaderboard?include=external — drop our own row(s)
  // so the default view is the rest of the ecosystem. Checks the whole wallet
  // group, not just the primary, so a multi-wallet self row can't slip through.
  if (include === "external" && self) {
    board = board.filter(
      (r) => r?.wallet !== self && !(Array.isArray(r?.wallets) && r.wallets.some((w) => String(w).toLowerCase() === self))
    );
  }

  // WoW baseline: the persisted point aged 6-10 days whose age is closest to 7.
  const nowMs = Date.parse(snap?.asOf || "") || Date.now();
  let baseline = null;
  let baselineAge = Infinity;
  for (const p of history || []) {
    const t = Date.parse(p?.asOf || p?.day || "");
    if (!Number.isFinite(t)) continue;
    const ageDays = (nowMs - t) / 86400000;
    if (ageDays >= 6 && ageDays <= 10 && Math.abs(ageDays - 7) < Math.abs(baselineAge - 7)) {
      baseline = p;
      baselineAge = ageDays;
    }
  }
  const prevByWallet = new Map();
  if (baseline) {
    for (const s of baseline.sellers || []) {
      for (const w of s.wallets || []) prevByWallet.set(String(w).toLowerCase(), s);
    }
  }

  const rows = board.map((r) => {
    const calls = Number(r?.callsSettled) || 0;
    const usd = Number(r?.totalUsd) || 0;
    const buyers = Number(r?.uniqueBuyers) || 0;
    const row = {
      name: r?.name || String(r?.homepage || "").replace(/^https?:\/\//, "") || r?.wallet || "unknown",
      homepage: r?.homepage || null,
      network: r?.network || "base",
      wallet: r?.wallet || null,
      ...(Array.isArray(r?.wallets) && r.wallets.length > 1 ? { wallets: r.wallets } : {}),
      callsSettled: calls,
      totalUsd: Number(usd.toFixed(6)),
      uniqueBuyers: buyers,
      organicScore: calls > 0 ? Number(Math.min(1, buyers / calls).toFixed(4)) : 0,
      avgTicketUsd: calls > 0 ? Number((usd / calls).toFixed(6)) : 0,
    };
    if (baseline) {
      const group = [r?.wallet, ...(Array.isArray(r?.wallets) ? r.wallets : [])].filter(Boolean);
      const prev = group.map((w) => prevByWallet.get(String(w).toLowerCase())).find(Boolean);
      if (prev) {
        const dCalls = calls - (Number(prev.callsSettled) || 0);
        row.deltaVsPrevWeek = { callsSettled: dCalls, totalUsd: Number((usd - (Number(prev.totalUsd) || 0)).toFixed(6)) };
        const band = Math.max(1, (Number(prev.callsSettled) || 0) * 0.05);
        row.trend = dCalls > band ? "rising" : dCalls < -band ? "cooling" : "flat";
        row.newThisWindow = false;
      } else {
        row.trend = "new";
        row.newThisWindow = true;
      }
    }
    return row;
  });

  const metric = { usd: (r) => r.totalUsd, calls: (r) => r.callsSettled, organic: (r) => r.organicScore, buyers: (r) => r.uniqueBuyers }[sort];
  rows.sort(
    (a, b) =>
      metric(b) - metric(a) ||
      b.callsSettled - a.callsSettled ||
      b.totalUsd - a.totalUsd ||
      String(a.name).localeCompare(String(b.name))
  );

  return {
    window: snap?.windowLabel || "-",
    sort,
    include,
    limit,
    totalSellers: rows.length,
    sellers: rows.slice(0, limit).map((r, i2) => ({ rank: i2 + 1, ...r })),
    wow: baseline
      ? { available: true, comparedTo: baseline.day, note: "deltaVsPrevWeek compares this window's aggregates to the persisted snapshot from ~7 days ago" }
      : { available: false, note: "no persisted snapshot ~7 days old yet - week-over-week deltas activate automatically as history accrues" },
    snapshotAsOf: snap?.asOf || null,
    generatedAt: new Date().toISOString(),
    ...(snap?.warming ? { warming: true } : {}),
  };
}

// Obvious operator/CI test traffic in the wish stream. Flagged, never dropped —
// a buyer of this report may still want to see it, but it must not read as
// organic demand. Deliberately NOT a content blocklist: only unambiguous
// test-harness markers belong here.
const NOISE_EXACT = new Set(["test"]);
const NOISE_MARKERS = ["probe-test", "launch check"];

// A cluster is "dominated" by one side when >= 2/3 of its signals come from it.
const DOMINANCE = 2 / 3;
// Clusters within this many signals of the build threshold are the strongest
// build signals — one or two more asks and the board flags them for build.
const NEAR_BAND = 2;

/**
 * Compute the demand-radar response from a wishes aggregate (getWishesAggregate
 * shape: { totalWishes, distinctClusters, threshold, clusters:[{ text, count,
 * sources:{api,mcp,"find-miss"}, firstSeen, lastSeen }] }). Pure and
 * deterministic given its inputs — no I/O, no env reads — so it is
 * unit-testable in isolation (scripts/test-demand-radar.js).
 *
 * Analysis the raw /api/wishes feed doesn't carry:
 *   - signalType: "discoverability" when find-miss dominates (>= 2/3 of the
 *     cluster's signals — agents searched and our ranking failed; the fix may
 *     be discovery, not a new tool), "explicit-request" when api/mcp dominates
 *     (agents proactively asked — a real build signal), else "mixed".
 *   - nearThreshold + gapToThreshold: proximity to the build threshold from
 *     the aggregate (count >= threshold - 2 → nearThreshold true).
 *   - noise: unambiguous test-harness clusters are flagged, never dropped.
 *
 * Never throws on an empty or missing aggregate — a fresh boot returns a
 * clean { totalWishes:0, distinctClusters:0, radar:[] } envelope.
 */
export function computeDemandRadar(agg, input = {}) {
  const SORTS = new Set(["count", "recent"]);
  const sort = SORTS.has(String(input?.sort || "").toLowerCase()) ? String(input.sort).toLowerCase() : "count";
  const limit = Math.min(Math.max(parseInt(input?.limit, 10) || 10, 1), 50);
  const minCount = Math.max(parseInt(input?.minCount, 10) || 1, 1);
  const threshold = Number(agg?.threshold) || 0;

  const rows = (Array.isArray(agg?.clusters) ? agg.clusters : [])
    .map((c) => {
      const sources = {
        api: Number(c?.sources?.api) || 0,
        mcp: Number(c?.sources?.mcp) || 0,
        "find-miss": Number(c?.sources?.["find-miss"]) || 0,
      };
      const count = Number(c?.count) || 0;
      const total = sources.api + sources.mcp + sources["find-miss"];
      const findMissShare = total > 0 ? sources["find-miss"] / total : 0;
      const signalType =
        total === 0 ? "mixed"
          : findMissShare >= DOMINANCE ? "discoverability"
            : (1 - findMissShare) >= DOMINANCE ? "explicit-request"
              : "mixed";
      const text = String(c?.text || "");
      const noise = NOISE_EXACT.has(text) || NOISE_MARKERS.some((m) => text.includes(m));
      return {
        text,
        count,
        sources,
        firstSeen: c?.firstSeen || null,
        lastSeen: c?.lastSeen || null,
        signalType,
        nearThreshold: threshold > 0 && count >= threshold - NEAR_BAND,
        gapToThreshold: threshold > 0 ? Math.max(threshold - count, 0) : null,
        noise,
      };
    })
    .filter((r) => r.count >= minCount);

  const lastMs = (r) => Date.parse(r.lastSeen || "") || 0;
  rows.sort(
    sort === "recent"
      ? (a, b) => lastMs(b) - lastMs(a) || b.count - a.count || a.text.localeCompare(b.text)
      : (a, b) => b.count - a.count || lastMs(b) - lastMs(a) || a.text.localeCompare(b.text)
  );

  return {
    totalWishes: Number(agg?.totalWishes) || 0,
    distinctClusters: Number(agg?.distinctClusters) || 0,
    buildThreshold: threshold,
    sort,
    minCount,
    limit,
    matchedClusters: rows.length,
    radar: rows.slice(0, limit),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Grade an x402 seller's externally-observable payment-security posture from a
 * single probed response. Pure and deterministic (no network, no clock, no
 * randomness) so it is unit-testable in isolation and CI-stable. Maps each check
 * to a failure mode from the "Five Attacks on x402" analysis and returns a
 * weighted letter grade plus an honest note on what a black-box probe cannot
 * see (replay/idempotency and router Sybil resistance need insider/active tests).
 */
export function gradeX402Response({ href, protocol, status, cacheControl, bodyText, paymentRequiredHeader }) {
  const paymentRequired = status === 402;
  const cc = String(cacheControl || "").toLowerCase();
  const text = String(bodyText || "");
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON body */ }

  // Decode the payment terms (v1 body `accepts`, or v2 base64 PAYMENT-REQUIRED header).
  let accepts = Array.isArray(body?.accepts) && body.accepts.length ? body.accepts : undefined;
  let x402Version = body?.x402Version ?? undefined;
  if (!accepts && paymentRequiredHeader) {
    try {
      const decoded = JSON.parse(Buffer.from(paymentRequiredHeader, "base64").toString("utf8"));
      if (Array.isArray(decoded?.accepts)) accepts = decoded.accepts;
      x402Version = decoded?.x402Version ?? x402Version;
    } catch { /* undecodable header */ }
  }

  const checks = [];
  const add = (id, title, attack, severity, st, detail) => checks.push({ id, title, attack, severity, status: st, detail });

  // 1. Transport — the payment authorization (and any credential) must not cross
  //    the wire in the clear.
  add("transport-tls", "Payment challenge served over TLS", "credential interception", "high",
    protocol === "https:" ? "pass" : "fail",
    protocol === "https:" ? "https" : "served over http - a payment authorization would be interceptable in transit");

  if (paymentRequired) {
    // 2. Cache hygiene (Attack III) — the only externally-observable signal:
    //    does the gated response forbid shared caching? A seller that sets
    //    no-store on the 402 challenge signals it sets it on paid responses too;
    //    a publicly-cacheable gated response is the exact leak the paper
    //    validated at 100% on nginx proxy_cache.
    if (cc.includes("no-store")) {
      add("cache-hygiene", "Gated response is not shared-cacheable", "III - cache leakage", "high", "pass",
        `Cache-Control: ${cc}`);
    } else if (cc.includes("private") || cc.includes("no-cache")) {
      add("cache-hygiene", "Gated response is not shared-cacheable", "III - cache leakage", "high", "warn",
        `Cache-Control: ${cc} - private/no-cache is weaker than no-store; a paid 200 could still be revalidated-and-served`);
    } else {
      add("cache-hygiene", "Gated response is not shared-cacheable", "III - cache leakage", "high", "fail",
        cc
          ? `Cache-Control: ${cc} - no no-store directive; a shared cache/CDN could serve a paid result to a later unpaid caller`
          : "no Cache-Control on the gated response - add 'no-store, private' so a shared cache/CDN can't serve a paid result to an unpaid caller");
    }

    // 3. Payment terms present & well-formed (discoverability / correct routing).
    if (accepts && accepts.length) {
      const badTerm = accepts.find((a) => !a || !a.payTo || (!a.network && !a.scheme));
      add("terms-present", "Payment terms are advertised and well-formed", "IV - discovery", "medium",
        badTerm ? "warn" : "pass",
        badTerm ? "an accepts entry is missing payTo/network/scheme" : `${accepts.length} payment option(s) advertised`);

      // 4. payTo address shape (EVM 0x…40 or base58 for solana).
      const badPay = accepts.find((a) => {
        const net = String(a.network || "");
        const to = String(a.payTo || "");
        if (net.startsWith("solana:")) return !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to);
        if (net.startsWith("stellar:")) return !/^G[A-Z2-7]{55}$/.test(to);
        if (net.startsWith("algorand:")) return !/^[A-Z2-7]{58}$/.test(to);
        return !isAddress(to);
      });
      add("payto-format", "Pay-to addresses are well-formed", "misdirected payment", "medium",
        badPay ? "warn" : "pass",
        badPay ? `a payTo address is malformed for its network (${badPay.network})` : "all payTo addresses parse for their network");

      // 5. Price sanity — a positive amount.
      const badPrice = accepts.find((a) => {
        const v = Number(a.maxAmountRequired ?? a.price);
        return !Number.isFinite(v) || v <= 0;
      });
      add("price-sanity", "Advertised price is a positive amount", "pricing", "low",
        badPrice ? "warn" : "pass",
        badPrice ? "an accepts entry has a non-positive or unparseable amount" : "advertised amounts are positive");

      // 6. Version detectable.
      add("version", "x402 protocol version is detectable", "IV - discovery", "low",
        x402Version != null ? "pass" : "warn",
        x402Version != null ? `x402 v${x402Version}` : "no x402Version in the body or PAYMENT-REQUIRED header");
    } else {
      add("terms-present", "Payment terms are advertised and well-formed", "IV - discovery", "medium", "fail",
        "402 returned but no x402 'accepts' found in the body (v1) or PAYMENT-REQUIRED header (v2) - buyers can't learn how to pay");
    }
  } else {
    add("payment-required", "URL is a paid x402 endpoint", "n/a", "info", "info",
      `status ${status} (not 402) - this URL did not issue a payment challenge, so payment-posture checks are not applicable`);
  }

  // 7. Error / info-leak hygiene — the response body must not spill a stack
  //    trace, internal path, or exception detail.
  const leakSig = /(\bat\s+\/|node_modules|Traceback \(most recent|\bECONNREFUSED\b|\/usr\/|\/home\/|\/var\/www|SyntaxError:|ReferenceError:|TypeError:.*\n\s+at\s)/;
  const leak = leakSig.test(text.slice(0, 4000));
  add("error-hygiene", "Response does not leak internal errors", "info disclosure", "medium",
    leak ? "fail" : "pass",
    leak ? "the response body appears to contain a stack trace or internal path" : "no stack trace / internal path detected in the response body");

  // Weighted deterministic score. pass=1, warn=0.5, fail=0; info rows are
  // excluded from scoring (they carry no pass/fail signal).
  const WEIGHT = { high: 3, medium: 2, low: 1, info: 0 };
  const FRAC = { pass: 1, warn: 0.5, fail: 0 };
  let num = 0, den = 0;
  for (const c of checks) {
    const w = WEIGHT[c.severity] ?? 0;
    if (!w || !(c.status in FRAC)) continue;
    num += w * FRAC[c.status];
    den += w;
  }
  const score = den ? Math.round((num / den) * 100) : 0;
  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
  const nPass = checks.filter((c) => c.status === "pass").length;
  const nWarn = checks.filter((c) => c.status === "warn").length;
  const nFail = checks.filter((c) => c.status === "fail").length;

  return {
    url: href, reachable: true, status, paymentRequired, x402Version,
    score, grade, checks,
    summary:
      `${grade} (${score}/100) - ${nPass} passed, ${nWarn} warning${nWarn === 1 ? "" : "s"}, ${nFail} failed. ` +
      "Note: replay/idempotency (Attack II) and router Sybil resistance (Attack IV) can't be graded from a black-box probe - they need insider or active testing.",
  };
}

// Bestsellers window: 1-90 days, default 30. Shared by the handler (which
// derives the SQL windows from it) and computeBestsellers (which echoes it) so
// the two can never disagree about what window the response describes.
export function clampBestsellerDays(v) {
  return Math.min(Math.max(parseInt(v, 10) || 30, 1), 90);
}

/**
 * Compute the bestsellers response from two externalSlugWindow() row sets —
 * the current window and the same-length window immediately before it. Pure
 * and deterministic given its inputs — no I/O, no env reads — so it is
 * unit-testable in isolation (scripts/test-bestsellers.js).
 *
 * Analysis the free raw feed (/api/sales) doesn't carry:
 *   - ranking lenses: buyers (default — distinct paying wallets, the
 *     whale/wash-resistant read), sales, usd, organic.
 *   - organicScore = buyers / sales clamped to [0,1] — the same buyer-diversity
 *     grade x402-trending applies to sellers, applied to our own tools. SVM/
 *     Stellar settlements carry no server-visible payer, so they count toward
 *     sales but never buyers; the score understates (never overstates) on
 *     mixed-chain rows.
 *   - trend vs the previous same-length window: deltaSales and
 *     rising/flat/cooling (±5%-of-prev band, min 1 sale — same convention as
 *     x402-trending) or "new" when the prior window had no sales. Never faked:
 *     an empty prior window is exactly what "new" says.
 *   - revenueShare: the row's slice of the window's external revenue.
 *
 * Honesty: if this tool ranks in its own chart, the row is flagged isSelf:true
 * rather than hidden — buying the chart puts you on the chart.
 */
export function computeBestsellers(rows, prevRows, input = {}, { recordingSince = null, persistent = false, now = Date.now() } = {}) {
  const SORTS = new Set(["buyers", "sales", "usd", "organic"]);
  const sort = SORTS.has(String(input?.sort || "").toLowerCase()) ? String(input.sort).toLowerCase() : "buyers";
  const limit = Math.min(Math.max(parseInt(input?.limit, 10) || 10, 1), 50);
  const days = clampBestsellerDays(input?.days);

  const prevBySlug = new Map((prevRows || []).map((r) => [r?.slug, Number(r?.sales) || 0]));
  const totalRevenue = (rows || []).reduce((s, r) => s + (Number(r?.revenue) || 0), 0);

  const list = (rows || []).map((r) => {
    const sales = Number(r?.sales) || 0;
    const revenue = Number(r?.revenue) || 0;
    const buyers = Number(r?.buyers) || 0;
    const prevSales = prevBySlug.get(r?.slug) || 0;
    const delta = sales - prevSales;
    const band = Math.max(1, prevSales * 0.05);
    return {
      slug: String(r?.slug || "unknown"),
      sales,
      revenueUsd: Number(revenue.toFixed(4)),
      revenueShare: totalRevenue > 0 ? Number((revenue / totalRevenue).toFixed(4)) : 0,
      buyers,
      organicScore: sales > 0 ? Number(Math.min(1, buyers / sales).toFixed(4)) : 0,
      avgTicketUsd: sales > 0 ? Number((revenue / sales).toFixed(6)) : 0,
      firstAt: r?.first_ts ? new Date(r.first_ts).toISOString() : null,
      lastAt: r?.last_ts ? new Date(r.last_ts).toISOString() : null,
      prevSales,
      deltaSales: delta,
      trend: prevSales === 0 ? "new" : delta > band ? "rising" : delta < -band ? "cooling" : "flat",
      ...(r?.slug === "bestsellers" ? { isSelf: true } : {}),
    };
  });

  const metric = { buyers: (r) => r.buyers, sales: (r) => r.sales, usd: (r) => r.revenueUsd, organic: (r) => r.organicScore }[sort];
  list.sort(
    (a, b) =>
      metric(b) - metric(a) ||
      b.sales - a.sales ||
      b.revenueUsd - a.revenueUsd ||
      a.slug.localeCompare(b.slug)
  );

  return {
    days,
    sort,
    limit,
    recordingSince: recordingSince ? new Date(recordingSince).toISOString() : null,
    persistent,
    totals: {
      sales: list.reduce((s, r) => s + r.sales, 0),
      revenueUsd: Number(totalRevenue.toFixed(4)),
      distinctTools: list.length,
    },
    bestsellers: list.slice(0, limit).map((r, i2) => ({ rank: i2 + 1, ...r })),
    note:
      "External paid demand on Agent402's own catalog - canary/burner/heartbeat traffic excluded at the source (sales ledger internal=0, money rails only). buyers counts distinct verified payers; Solana/Stellar settlements carry no server-visible payer, so they count toward sales but never buyers. trend compares this window to the same-length window immediately before it. Aggregate sales totals are free at /api/sales; per-tool purchase counts are not published there and never reach the chain, so this ledger is where tool-level x402 demand lives.",
    generatedAt: new Date(now).toISOString(),
  };
}
