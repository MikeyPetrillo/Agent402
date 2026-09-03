// CDP kit — agent-wallet onboarding tools powered by the Coinbase Developer
// Platform, reusing the same CDP_API_KEY_ID / CDP_API_KEY_SECRET that already
// drive x402 settlement (no new secrets). Env-gated like llm-kit: missing
// keys → 503 at call time, never a boot failure.
//
//   wallet-balances  $0.002  indexed ERC-20 + native balances for any address
//                            (base / ethereum / base-sepolia) — one call, no
//                            per-token contract wrangling
//   testnet-fund     $0.001  base-sepolia faucet (USDC/ETH) — one tenth of a
//                            cent buys 1 full testnet USDC to rehearse the
//                            x402 loop safely (wallet-only: the faucet spends
//                            a shared per-account CDP budget)
//   onramp-link      $0.001  single-use Coinbase Onramp URL that lets a human
//                            fund an agent's wallet with a card / Apple Pay
//   onchain-sql      $0.020  read-only ClickHouse-dialect SQL over Coinbase's
//                            indexed DECODED chain data (Base events/txs/
//                            blocks/user-ops/builder-code attributions,
//                            Solana token instructions) — no indexer to run
//   onchain-sql-schema $0.002 the table/column schema for the above
//
// Auth: CDP REST uses a short-lived JWT (ES256 for PEM EC keys, EdDSA for
// base64 Ed25519 keys) with a per-request `uris` claim. Implemented on
// node:crypto — the @coinbase/cdp-sdk dependency tree (axios/viem/solana-kit)
// is far heavier than the three REST calls we make. Claim structure mirrors
// the SDK's auth/utils/jwt.ts exactly.
import { createPrivateKey, createSign, randomBytes, sign as edSign } from "node:crypto";
import { redactSecrets } from "./redact.js";

const CDP_HOST = "api.cdp.coinbase.com";

const keyId = () => (process.env.CDP_API_KEY_ID || "").trim();
const keySecret = () => (process.env.CDP_API_KEY_SECRET || "").trim();

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Mint a CDP REST JWT for one request. Exported for the offline unit test.
 *  The uris claim signs the PATHNAME only — query strings are excluded
 *  (mirrors the SDK's url.pathname; signing the query yields HTTP 401). */
export async function mintCdpJwt({ method, path, apiKeyId = keyId(), apiKeySecret = keySecret(), host = CDP_HOST }) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: apiKeyId,
    iss: "cdp",
    uris: [`${method} ${host}${path.split("?")[0]}`],
    iat: now,
    nbf: now,
    exp: now + 120,
  };
  let alg, key;
  if (apiKeySecret.includes("-----BEGIN")) {
    alg = "ES256";
    key = { key: createPrivateKey(apiKeySecret), dsaEncoding: "ieee-p1363" };
  } else {
    const decoded = Buffer.from(apiKeySecret, "base64");
    if (decoded.length !== 64) throw bad("CDP key secret is neither a PEM EC key nor a base64 Ed25519 key", 503);
    alg = "EdDSA";
    key = createPrivateKey({
      key: { kty: "OKP", crv: "Ed25519", d: decoded.subarray(0, 32).toString("base64url"), x: decoded.subarray(32).toString("base64url") },
      format: "jwk",
    });
  }
  const header = { alg, kid: apiKeyId, typ: "JWT", nonce: randomBytes(16).toString("hex") };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = alg === "ES256"
    ? createSign("SHA256").update(signingInput).sign(key)
    : edSign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(signature)}`;
}

/** One authenticated CDP REST call with repo-standard error attribution.
 *
 * Retries on transient failures — a network error / timeout, an HTTP 5xx
 * (a gateway 502/504 is normal on the heavier SQL-observatory aggregations),
 * or a 429 — with exponential backoff and a freshly-minted JWT per attempt.
 * A single blip from a busy upstream should never surface to a buyer (or a CI
 * gate) as a hard failure; only a sustained fault does. Client errors
 * (400/404/422) and auth/config issues are returned immediately — retrying
 * them just wastes time. Mirrors the 5xx-retry the finance/gov/crypto kits use. */
async function cdpFetch(method, path, body) {
  if (!keyId() || !keySecret()) {
    throw bad("This tool is temporarily unavailable: the operator has not configured Coinbase Developer Platform credentials (CDP_API_KEY_ID / CDP_API_KEY_SECRET).", 503);
  }
  // Ride out a transient CDP-side blip (a 5xx from their indexer, a timeout)
  // rather than surfacing it to the caller: 5 attempts with exponential +
  // jittered backoff (~0.4s, 0.8s, 1.6s, 3.2s, capped 4s; ~6s total worst case).
  // A shallow 3x/~0.9s retry once let a brief indexer hiccup fail a live check.
  // Our-fault errors (4xx) still fail fast below — only 429/5xx/network retry.
  const ATTEMPTS = 5;
  let lastErr;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(4000, 400 * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, backoff + Math.floor(Math.random() * 250)));
    }
    const jwt = await mintCdpJwt({ method, path });
    let res;
    try {
      res = await fetch(`https://${CDP_HOST}${path}`, {
        method,
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      lastErr = bad(`Coinbase Developer Platform did not respond: ${String(e?.message || e).slice(0, 80)}`, 504);
      continue; // network error / timeout — retry
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json;
    // Redact any configured secret from the upstream error text before echoing
    // it — the request's JWT carries CDP_API_KEY_ID as its issuer/subject, so a
    // "key <id> not found"-style upstream message could otherwise reflect it.
    const detail = redactSecrets(String(json?.errorMessage || json?.message || json?.errorType || res.statusText)).slice(0, 200);
    if (res.status === 400 || res.status === 404 || res.status === 422) throw bad(`CDP rejected the request: ${detail}`, 422);
    if (res.status === 429) { lastErr = bad(`CDP rate limit: ${detail}`, 429); continue; } // transient — back off + retry
    lastErr = bad(`CDP upstream error (HTTP ${res.status}): ${detail}`, 502);
    if (res.status < 500) throw lastErr; // other non-5xx (e.g. 401/403 auth) — not retryable
    // 5xx — fall through to retry
  }
  throw lastErr;
}

/** True when CDP credentials are configured (cdpSql/cdpFetch can run). Cheap
 *  pre-check so hot paths can fall back without triggering cdpFetch's 503 throw. */
export function cdpConfigured() { return !!(keyId() && keySecret()); }

/** Run a read-only ClickHouse SELECT over Coinbase's indexed, decoded chain data
 *  (base.events, base.transactions, …) and return the result rows as an array.
 *  Reuses cdpFetch (JWT + retry). Throws a 503 (via cdpFetch) when creds are unset
 *  and surfaces CDP's own 4xx on a bad query — callers in latency-sensitive paths
 *  should cdpConfigured()-gate and/or catch to fall back. `cacheSeconds` (≤900)
 *  sets CDP's server-side result cache. */
export async function cdpSql(sql, { cacheSeconds } = {}) {
  const body = { sql: String(sql) };
  if (Number.isFinite(cacheSeconds) && cacheSeconds > 0) {
    body.cache = { maxAgeMs: Math.min(Math.floor(cacheSeconds), 900) * 1000 };
  }
  const res = await cdpFetch("POST", "/platform/v2/data/query/run", body);
  const rows = res?.result ?? res?.rows ?? res?.data ?? res;
  return Array.isArray(rows) ? rows : [];
}

const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BALANCE_NETWORKS = new Set(["base", "ethereum", "base-sepolia", "solana", "solana-devnet"]);
const FAUCET_NETWORKS = new Set(["base-sepolia", "solana-devnet"]);
const FAUCET_TOKENS = { "base-sepolia": new Set(["usdc", "eth"]), "solana-devnet": new Set(["usdc", "sol"]) };
const ONRAMP_NETWORKS = new Set(["base", "ethereum", "polygon", "arbitrum", "optimism", "solana"]);

// Local faucet gate on top of CDP's own rolling-24h caps (1 USDC/request,
// 10 USDC/day per address AND per CDP account — the account cap is shared by
// everyone using this endpoint, so we spread it: 2 requests/address/day, 8
// total/day). In-memory on purpose: worst case a restart resets the local
// count and CDP's server-side caps still hold the line.
const faucetLog = { byAddress: new Map(), all: [] };
const DAY_MS = 24 * 60 * 60 * 1000;
export function faucetGate(address, now = Date.now()) {
  const prune = (arr) => arr.filter((t) => now - t < DAY_MS);
  faucetLog.all = prune(faucetLog.all);
  const forAddr = prune(faucetLog.byAddress.get(address) || []);
  faucetLog.byAddress.set(address, forAddr);
  if (forAddr.length >= 2) return { ok: false, reason: "This address already received 2 faucet drips in the last 24h. CDP also enforces its own per-address caps - try again tomorrow." };
  if (faucetLog.all.length >= 8) return { ok: false, reason: "The shared faucet budget for this service is exhausted for the next 24h (CDP caps faucet volume per account). Try again later." };
  forAddr.push(now);
  faucetLog.all.push(now);
  return { ok: true };
}

const SHARED_TAGS = ["cdp", "coinbase", "wallet", "onboarding", "x402", "agent-wallet"];

export const CDP_TOOLS = [
  {
    route: "GET /api/wallet-balances",
    name: "Wallet token balances (indexed)",
    slug: "wallet-balances",
    category: "wallet",
    price: "$0.002",
    description:
      "All token balances for any address in one call, from Coinbase's indexed data API - ERC-20 + native on EVM, SPL on Solana; no per-token contract calls, no RPC wrangling. Networks: base, ethereum, base-sepolia, solana, solana-devnet. Symbols/decimals populated for whitelisted tokens (USDC always included).",
    tags: [...SHARED_TAGS, "balances", "erc-20", "spl", "base", "ethereum", "solana", "portfolio"],
    discovery: {
      input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "base" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "Wallet address - EVM 0x… or Solana base58, matching the network" },
          network: { type: "string", description: "base (default) | ethereum | base-sepolia | solana | solana-devnet" },
        },
        required: ["address"],
      },
      output: {
        example: {
          address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0",
          network: "base",
          balances: [{ symbol: "USDC", name: "USD Coin", contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", amount: "8.655", raw: "8655000", decimals: 6 }],
          count: 1,
        },
      },
    },
    handler: async (input) => {
      const address = String(input?.address || "").trim();
      const network = String(input?.network || "base").trim().toLowerCase();
      if (!BALANCE_NETWORKS.has(network)) throw bad(`"network" must be one of: ${[...BALANCE_NETWORKS].join(", ")}`);
      const isSolana = network.startsWith("solana");
      if (isSolana ? !SOL_ADDR_RE.test(address) : !EVM_ADDR_RE.test(address)) {
        throw bad(isSolana ? '"address" must be a Solana address (base58)' : '"address" must be an EVM address (0x + 40 hex chars)');
      }
      const res = await cdpFetch("GET", `/platform/v2/${isSolana ? "solana" : "evm"}/token-balances/${network}/${address}?pageSize=100`);
      const balances = (res?.balances || []).map((b) => {
        const decimals = b?.amount?.decimals;
        const raw = String(b?.amount?.amount ?? "0");
        const amount = Number.isFinite(decimals) ? (Number(raw) / 10 ** decimals).toString() : null;
        return {
          symbol: b?.token?.symbol ?? null,
          name: b?.token?.name ?? null,
          contract: b?.token?.contractAddress ?? b?.token?.mintAddress ?? null,
          amount, raw, decimals: decimals ?? null,
        };
      });
      return { address, network, balances, count: balances.length, ...(res?.nextPageToken ? { truncated: true } : {}) };
    },
  },
  {
    route: "POST /api/testnet-fund",
    name: "Testnet faucet (try x402 free)",
    slug: "testnet-fund",
    category: "wallet",
    price: "$0.001",
    description:
      "Fund any address with testnet money via the Coinbase faucet - USDC (1) or ETH (0.0001) on Base Sepolia, USDC (1) or SOL on Solana devnet - everything an agent needs to rehearse the complete x402 payment loop safely before moving real money. A tenth of a cent buys a full testnet dollar. Limits: 2 drips per address per day; CDP enforces its own rolling caps on top.",
    tags: [...SHARED_TAGS, "faucet", "testnet", "base-sepolia", "solana-devnet", "getting-started"],
    discovery: {
      bodyType: "json",
      input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", token: "usdc" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "Address to fund - EVM 0x… or Solana base58, matching the network" },
          network: { type: "string", description: "base-sepolia (default) | solana-devnet" },
          token: { type: "string", description: "usdc (default, 1 USDC) | eth (0.0001, base-sepolia) | sol (solana-devnet)" },
        },
        required: ["address"],
      },
      output: {
        example: { funded: true, network: "base-sepolia", token: "usdc", transactionHash: "0xabc123…", explorer: "https://sepolia.basescan.org/tx/0xabc123…" },
      },
    },
    handler: async (input) => {
      const network = String(input?.network || "base-sepolia").trim().toLowerCase();
      if (!FAUCET_NETWORKS.has(network)) throw bad(`"network" must be one of: ${[...FAUCET_NETWORKS].join(", ")}`);
      const isSolana = network === "solana-devnet";
      const address = String(input?.address || "").trim();
      if (isSolana ? !SOL_ADDR_RE.test(address) : !EVM_ADDR_RE.test(address)) {
        throw bad(isSolana ? '"address" must be a Solana address (base58)' : '"address" must be an EVM address (0x + 40 hex chars)');
      }
      const token = String(input?.token || "usdc").trim().toLowerCase();
      if (!FAUCET_TOKENS[network].has(token)) throw bad(`"token" must be one of: ${[...FAUCET_TOKENS[network]].join(", ")} on ${network}`);
      const gate = faucetGate(isSolana ? address : address.toLowerCase());
      if (!gate.ok) throw bad(gate.reason, 429);
      const res = isSolana
        ? await cdpFetch("POST", "/platform/v2/solana/faucet", { address, token })
        : await cdpFetch("POST", "/platform/v2/evm/faucet", { address, network, token });
      const tx = res?.transactionHash || res?.transactionSignature || null;
      return {
        funded: Boolean(tx),
        network,
        token,
        transactionHash: tx,
        explorer: tx ? (isSolana ? `https://solscan.io/tx/${tx}?cluster=devnet` : `https://sepolia.basescan.org/tx/${tx}`) : null,
        note: isSolana
          ? "Devnet funds on Solana. Point your x402 SVM client at a solana-devnet seller (or run the open-source Agent402 server locally with a devnet config) to rehearse the payment loop."
          : "Testnet funds on Base Sepolia. Point your x402 client at a base-sepolia seller (or run the open-source Agent402 server locally with NETWORK=base-sepolia) to rehearse the full payment loop.",
      };
    },
  },
  {
    route: "POST /api/onramp-link",
    name: "Onramp link (fund a wallet with a card)",
    slug: "onramp-link",
    category: "wallet",
    price: "$0.001",
    description:
      "Generate a single-use Coinbase Onramp URL that lets a human fund any wallet with a card or Apple Pay - the fastest way to put real USDC into an agent's wallet. Returns the ready-to-open URL, and a fee-inclusive quote when Coinbase provides one. Networks: base, ethereum, polygon, arbitrum, optimism, solana.",
    tags: [...SHARED_TAGS, "onramp", "fiat", "usdc", "fund-wallet", "apple-pay"],
    discovery: {
      bodyType: "json",
      input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "base", amount: "10" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "Destination wallet address (EVM 0x… or Solana base58, matching the network)" },
          network: { type: "string", description: "base (default) | ethereum | polygon | arbitrum | optimism | solana" },
          asset: { type: "string", description: "Ticker to purchase (default USDC)" },
          amount: { type: "string", description: "Crypto amount the wallet should receive (default 10)" },
          country: { type: "string", description: "Buyer's ISO 3166-1 country code (default US)" },
          subdivision: { type: "string", description: "US state code (e.g. NY) - required for US buyers by some payment methods" },
          redirectUrl: { type: "string", description: "Optional URL to send the buyer to after checkout" },
        },
        required: ["address"],
      },
      output: {
        example: {
          onrampUrl: "https://pay.coinbase.com/…single-use…",
          singleUse: true,
          note: "Open the URL in a browser to complete the purchase - it is single-use and expires after first visit.",
        },
        // `quote` ({paymentTotal, paymentSubtotal, paymentCurrency, purchaseAmount,
        // purchaseCurrency, destinationNetwork, exchangeRate}) rides alongside
        // WHEN Coinbase returns one. It is deliberately not in the example: it
        // is not always there, and an example is read as a promise.
      },
    },
    handler: async (input) => {
      const address = String(input?.address || "").trim();
      if (!address || address.length < 26 || address.length > 64) throw bad('"address" must be a wallet address on the chosen network');
      const network = String(input?.network || "base").trim().toLowerCase();
      if (!ONRAMP_NETWORKS.has(network)) throw bad(`"network" must be one of: ${[...ONRAMP_NETWORKS].join(", ")}`);
      if (network !== "solana" && !EVM_ADDR_RE.test(address)) throw bad(`"address" must be an EVM address (0x + 40 hex) for network ${network}`);
      const asset = String(input?.asset || "USDC").trim().toUpperCase().slice(0, 12);
      const amount = String(input?.amount || "10").trim();
      if (!/^\d{1,7}(\.\d{1,6})?$/.test(amount)) throw bad('"amount" must be a positive decimal string (e.g. "10")');
      const country = String(input?.country || "US").trim().toUpperCase().slice(0, 2);
      const body = {
        purchaseCurrency: asset,
        destinationNetwork: network,
        destinationAddress: address,
        purchaseAmount: amount,
        country,
      };
      if (input?.subdivision) body.subdivision = String(input.subdivision).trim().toUpperCase().slice(0, 2);
      if (input?.redirectUrl) {
        const r = String(input.redirectUrl).trim();
        if (!/^https:\/\/[^\s]{1,300}$/.test(r)) throw bad('"redirectUrl" must be an https URL');
        body.redirectUrl = r;
      }
      const res = await cdpFetch("POST", "/platform/v2/onramp/sessions", body);
      const url = res?.session?.onrampUrl || null;
      if (!url) throw bad("CDP did not return an onramp URL", 502);
      return {
        onrampUrl: url,
        singleUse: true,
        ...(res?.quote ? { quote: {
          paymentTotal: res.quote.paymentTotal,
          paymentSubtotal: res.quote.paymentSubtotal,
          paymentCurrency: res.quote.paymentCurrency,
          purchaseAmount: res.quote.purchaseAmount,
          purchaseCurrency: res.quote.purchaseCurrency,
          destinationNetwork: res.quote.destinationNetwork,
          exchangeRate: res.quote.exchangeRate,
        } } : {}),
        note: "Open the URL in a browser to complete the purchase - it is single-use and expires after first visit.",
      };
    },
  },
  {
    route: "POST /api/onchain-sql",
    name: "Onchain SQL (query Base with SQL)",
    slug: "onchain-sql",
    category: "wallet",
    price: "$0.020",
    description:
      "Run read-only SQL against Coinbase's indexed, DECODED blockchain data - base.events (decoded logs with parameters), base.transactions, base.blocks, base.decoded_user_operations, base.transaction_attributions (builder codes), plus solana.instructions and hyperevm.events. ClickHouse-dialect SELECTs, server-side grammar validation, up to 50k rows / 30s / 12 joins. Ask Base anything - token flows, event analytics, gas studies - in one call, no indexer to run.",
    tags: [...SHARED_TAGS, "sql", "analytics", "onchain-data", "base", "events", "clickhouse", "data-science"],
    discovery: {
      bodyType: "json",
      input: { sql: "SELECT COUNT(*) AS txs FROM base.transactions WHERE block_number > 0 LIMIT 1" },
      inputSchema: {
        properties: {
          sql: { type: "string", description: "Read-only SELECT (ClickHouse dialect, max 10,000 chars). Tables: base.events, base.transactions, base.blocks, base.encoded_logs, base.decoded_user_operations, base.transaction_attributions, base_sepolia.*, solana.instructions, hyperevm.events" },
          cacheSeconds: { type: "number", description: "Accept cached results up to this old (max 900). Cheaper + faster for repeated analytics." },
        },
        required: ["sql"],
      },
      output: {
        example: { rows: [{ txs: 123456 }], rowCount: 1 },
      },
    },
    handler: async (input) => {
      const sql = String(input?.sql || "").trim();
      if (!sql) throw bad('"sql" is required');
      if (sql.length > 10_000) throw bad(`"sql" too long (${sql.length} chars, max 10,000)`);
      if (!/^\s*(select|with)\b/i.test(sql)) throw bad('"sql" must be a read-only SELECT (or WITH … SELECT) statement');
      const body = { sql };
      const cacheSeconds = Number(input?.cacheSeconds);
      if (Number.isFinite(cacheSeconds) && cacheSeconds > 0) {
        body.cache = { maxAgeMs: Math.min(Math.floor(cacheSeconds), 900) * 1000 };
      }
      const res = await cdpFetch("POST", "/platform/v2/data/query/run", body);
      const rows = res?.result ?? res?.rows ?? res?.data ?? res;
      const list = Array.isArray(rows) ? rows : [];
      return { rows: list, rowCount: list.length, ...(Array.isArray(rows) ? {} : { raw: res }) };
    },
  },
  {
    route: "GET /api/onchain-sql-schema",
    name: "Onchain SQL schema",
    slug: "onchain-sql-schema",
    category: "wallet",
    price: "$0.002",
    description:
      "The table + column schema for the onchain-sql tool - every queryable table (base.events, base.transactions, base.blocks, base.decoded_user_operations, base.transaction_attributions, solana.instructions, …) with its columns and types. Fetch once, then write SQL with confidence.",
    tags: [...SHARED_TAGS, "sql", "schema", "onchain-data", "reference"],
    discovery: {
      input: {},
      inputSchema: { properties: {}, required: [] },
      output: { example: { schema: { "base.events": [{ name: "block_number", type: "UInt64" }] } } },
    },
    handler: async () => {
      const res = await cdpFetch("GET", "/platform/v2/data/query/schema");
      return { schema: res };
    },
  },
];
