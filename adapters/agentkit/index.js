// agent402-agentkit - Agent402 as a Coinbase AgentKit action provider.
//
// Gives an AgentKit agent (a CDP, Privy, ZeroDev or viem-backed wallet
// provider) three actions over the Agent402 catalog: find a tool for a
// task, call it (paying under the hood), and read what Agent402 is. Payment
// is handled by agent402-client: a few seconds of proof-of-work for the free
// tier, or an x402 USDC payment on Base signed by the agent's own wallet
// provider for wallet-only tools. The signer is derived the same way
// AgentKit's own x402 action provider derives it (toSigner + readContract).
//
//   import { AgentKit, CdpEvmWalletProvider } from "@coinbase/agentkit";
//   import { agent402ActionProvider } from "agent402-agentkit";
//
//   const walletProvider = await CdpEvmWalletProvider.configureWithWallet({ networkId: "base-mainnet" });
//   const agentKit = await AgentKit.from({ walletProvider, actionProviders: [await agent402ActionProvider()] });
//
// `agent402Actions()` returns the raw { name, description, schema, invoke }
// list for hosts that wrap actions themselves; `agent402ActionProvider()`
// wraps them with AgentKit's customActionProvider.

import { Agent402 } from "agent402-client";

const DEFAULT_BASE = "https://agent402.tools";
// Keep in lockstep with package.json: the User-Agent product token that names
// this package on every call it sends.
const USER_AGENT = "agent402-agentkit/0.1.10";

// Discovery reads (catalog, find, route, manifest, a proof-of-work challenge)
// settle nothing, so a 503 the server sheds under load is safe to repeat. It
// is retried only when it names its own delay (a Retry-After header or a
// retryAfterSeconds body field), at most DISCOVERY_ATTEMPTS tries in all,
// each wait capped at DISCOVERY_MAX_WAIT_MS. A paid call never goes through
// here: a repeat of one could settle twice.
const DISCOVERY_ATTEMPTS = 3;
const DISCOVERY_MAX_WAIT_MS = 5000;

async function shedRetryWaitMs(r) {
  if (!r || r.status !== 503) return null;
  const header = r.headers && typeof r.headers.get === "function" ? r.headers.get("retry-after") : null;
  let seconds = header != null && String(header).trim() !== "" ? Number(header) : NaN;
  if (!Number.isFinite(seconds)) {
    try {
      const body = await (typeof r.clone === "function" ? r.clone() : r).json();
      seconds = Number(body && body.retryAfterSeconds);
    } catch { seconds = NaN; }
  }
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, DISCOVERY_MAX_WAIT_MS);
}

// Resolves with the 2xx response, or throws `${label}: HTTP <status>` (plus
// "after N attempts" when it retried) with `.status` and `.attempts` set.
// `init` may be a function, so each attempt gets its own timeout signal.
async function discoveryFetch(fetchImpl, label, url, init) {
  let r;
  let attempts = 0;
  for (;;) {
    attempts++;
    r = await fetchImpl(url, typeof init === "function" ? init() : init);
    if (r.ok) return r;
    if (attempts >= DISCOVERY_ATTEMPTS) break;
    const wait = await shedRetryWaitMs(r);
    if (wait == null) break;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  const err = new Error(`${label}: HTTP ${r.status}${attempts > 1 ? ` after ${attempts} attempts` : ""}`);
  err.status = r.status;
  err.attempts = attempts;
  throw err;
}

/**
 * The three actions, as plain AgentKit custom-action definitions.
 * @param {object} [opts]
 * @param {string} [opts.baseUrl="https://agent402.tools"]
 * @param {typeof fetch} [opts.fetchImpl]  fetch used for free discovery and as the base of the paying fetch
 * @param {object} [opts.zod]              a zod module (loaded from the host when omitted)
 * @param {number} [opts.maxPerCallUsd=1]  ceiling on one paid call (USD); over it the call is refused before paying
 * @param {number} [opts.dailyLimitUsd]    ceiling on rolling-24h paid spend (USD)
 * @param {number} [opts.maxPerHostUsd]    ceiling on rolling-24h paid spend to one seller host (USD)
 * @param {string[]} [opts.payees]         only pay these payTo addresses (lowercased EVM); anything else is refused before signing
 * @param {string} [opts.creditsKey]       prepaid credits key (a402_...); pays wallet-only tools on Agent402's own services without a wallet
 */
export async function agent402Actions({ baseUrl = DEFAULT_BASE, fetchImpl = globalThis.fetch, zod, maxPerCallUsd = 1, dailyLimitUsd = null, maxPerHostUsd = null, payees = null, creditsKey = null } = {}) {
  const z = zod || (await loadZod());
  // ONE client per wallet provider for the life of these actions. The rolling
  // daily and per-host ceilings live in the client's ledger, so a client built
  // per invoke (as 0.1.1 did) measured every call against an empty ledger and
  // the daily ceiling bounded each call alone (found in the elizaOS plugin's
  // registry review, 2026-09-14; the same shape was here).
  const clients = new WeakMap();
  const NO_WALLET = {};
  const clientFor = async (walletProvider) => {
    const key = walletProvider && typeof walletProvider === "object" ? walletProvider : NO_WALLET;
    if (clients.has(key)) return clients.get(key);
    // The x402 client is handed to agent402-client too, which holds every
    // payment it signs to the ceilings below (guardX402Client).
    const paying = creditsKey ? null : await x402For(walletProvider, fetchImpl, { payees, guarded: true });
    const client = new Agent402({ userAgent: USER_AGENT, baseUrl: base, fetch: paying?.payFetch, x402Client: paying?.client, fetchImpl, creditsKey, maxPerCallUsd, dailyLimitUsd, maxPerHostUsd });
    clients.set(key, client);
    return client;
  };
  // Linear trailing-slash strip (a /\/+$/ regex on caller input is the
  // polynomial-ReDoS shape CodeQL flags; same fix as openclaw/models.js).
  let base = String(baseUrl);
  while (base.endsWith("/")) base = base.slice(0, -1);

  const find = {
    name: "agent402_find",
    description:
      "Find an Agent402 tool for a task (web search, page render, PDFs, OCR, market and crypto data, SEC filings, DNS/TLS " +
      "checks), payable over x402 in USDC or free via proof-of-work. Returns the best-matching tools with slug, price, " +
      "whether a wallet is needed, and a ready example. Free: no payment is made.",
    schema: z.object({
      task: z.string().min(1).describe("What you need done, in plain language, e.g. 'extract the article at a URL'"),
      k: z.number().int().min(1).max(10).optional().describe("How many matches to return (default 5)"),
    }),
    invoke: async ({ task, k = 5 }) => {
      const r = await discoveryFetch(fetchImpl, "agent402_find failed (GET /api/find)", `${base}/api/find?q=${encodeURIComponent(task)}&k=${k}`);
      const j = await r.json();
      const rows = (j.results || []).map((t) => ({
        slug: t.slug, name: t.name, price: t.price, route: t.route, walletRequired: t.computePayable === false || t.walletOnly === true,
        description: t.description, example: t.example ?? t.input ?? null,
      }));
      return JSON.stringify({ query: task, results: rows });
    },
  };

  const call = {
    name: "agent402_call",
    description:
      "Call an Agent402 tool by slug (from agent402_find) with its input and return the result. Pays for the call: " +
      "proof-of-work for free-tier tools, or an x402 USDC micropayment on Base signed by this wallet for wallet-only tools " +
      "(prices are typically $0.001 to $0.05). The result is the tool's JSON.",
    schema: z.object({
      slug: z.string().min(1).describe("Tool slug, e.g. 'hash', 'extract', 'render'"),
      params: z.record(z.any()).optional().describe("Input matching the tool's example from agent402_find"),
    }),
    invoke: async (walletProvider, { slug, params = {} }) => {
      // Spend bounds ride with every paid call and are checked on the payment
      // that is signed: a per-call ceiling (default $1, the same default
      // AgentKit's own x402 provider uses), optional rolling daily and
      // per-host ceilings, and an optional payee allowlist. With a per-call
      // ceiling set (the default), no single payment is signed above it,
      // whatever baseUrl is set to; set dailyLimitUsd to bound the total too.
      const client = await clientFor(walletProvider);
      const out = await client.call(slug, params);
      return typeof out === "string" ? out : JSON.stringify(out);
    },
  };

  const about = {
    name: "agent402_about",
    description: "What Agent402 is, how it is paid, and how many tools it serves right now. Free.",
    schema: z.object({}),
    invoke: async () => {
      const r = await discoveryFetch(fetchImpl, "agent402_about failed (GET /api/pricing)", `${base}/api/pricing`);
      const p = await r.json();
      const endpoints = p.endpoints || [];
      return JSON.stringify({
        name: "Agent402",
        baseUrl: base,
        tools: endpoints.length,
        freeTier: endpoints.filter((e) => e.computePayable).length,
        pay: "x402 (USDC on Base and other chains) from this wallet, or proof-of-work for free-tier tools; a prepaid credits key, where sold or already issued, also pays on Agent402's own services",
        discover: `${base}/api/find?q=<task>`,
        docs: `${base}/llms.txt`,
      });
    },
  };

  return [find, call, about];
}

/**
 * An AgentKit ActionProvider carrying the three actions. Requires
 * @coinbase/agentkit in the host project (it is a peer, never bundled).
 */
export async function agent402ActionProvider(opts = {}) {
  const actions = await agent402Actions(opts);
  let mod;
  try { mod = await import("@coinbase/agentkit"); }
  catch { throw new Error("agent402-agentkit requires '@coinbase/agentkit' - install it with: npm install @coinbase/agentkit"); }
  if (typeof mod.customActionProvider === "function") return mod.customActionProvider(actions);
  if (typeof mod.CustomActionProvider === "function") return new mod.CustomActionProvider(actions);
  throw new Error("@coinbase/agentkit does not expose customActionProvider - upgrade @coinbase/agentkit");
}

/**
 * Build the paying fetch from an AgentKit wallet provider. EVM providers
 * expose toSigner() (a viem account) and readContract(); the exact-EVM x402
 * scheme is registered on it exactly as AgentKit's x402 provider does. A
 * provider without toSigner() (or no provider at all) yields undefined, and
 * agent402-client then pays free-tier tools with proof-of-work only.
 */
export async function payFetchFor(walletProvider, fetchImpl = globalThis.fetch, { payees = null } = {}) {
  return (await x402For(walletProvider, fetchImpl, { payees, guarded: false }))?.payFetch;
}

/** The x402 client and its paying fetch. `guarded`: agent402-client registers
 *  its own signing guard on the client (the caller does that), which replaces
 *  the library's default spend control; unguarded (payFetchFor on its own),
 *  that default control stays on. */
async function x402For(walletProvider, fetchImpl, { payees = null, guarded = false } = {}) {
  if (!walletProvider || typeof walletProvider.toSigner !== "function") return null;
  const account = await walletProvider.toSigner();
  if (!account || typeof account.signTypedData !== "function") return null;
  const signer = typeof walletProvider.readContract === "function"
    ? { ...account, readContract: (args) => walletProvider.readContract(args) }
    : account;
  const [{ x402Client, wrapFetchWithPayment }, { registerExactEvmScheme }] = await Promise.all([
    import("@x402/fetch"), import("@x402/evm/exact/client"),
  ]);
  const client = new x402Client();
  // Guarded, agent402-client's signing guard holds each payment to this
  // package's ceilings and prices it from known assets, so the library's
  // default control (its own default assets only, a fixed $1) is replaced.
  if (guarded) client.setSpendControls?.(false);
  registerExactEvmScheme(client, { signer });
  if (Array.isArray(payees) && payees.length) {
    const { withPayeeAllowlist } = await import("agent402-client");
    withPayeeAllowlist(client, payees);
  }
  return { client, payFetch: wrapFetchWithPayment(fetchImpl, client) };
}

async function loadZod() {
  try { const m = await import("zod"); return m.z || m.default?.z || m; }
  catch { throw new Error("agent402-agentkit requires 'zod' - install it with: npm install zod"); }
}
