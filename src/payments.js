import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402/extensions/bazaar";
import {
  BUILDER_CODE,
  builderCodeResourceServerExtension,
  declareBuilderCodeExtension,
} from "@x402/extensions/builder-code";

// Supported networks. EVM chains use eip155: CAIP-2 IDs; Solana uses the
// solana: genesis-hash CAIP-2. Adding a chain = register its scheme + list
// it in `accepts`. Only chains a facilitator can settle are safe to add.
// Only chains whose USDC address is in @x402/evm's built-in asset registry.
// Avalanche is excluded — getDefaultAsset throws for eip155:43114.
const EVM_NETWORKS = {
  base: "eip155:8453",
  polygon: "eip155:137",
  arbitrum: "eip155:42161",
  "base-sepolia": "eip155:84532",
};
const SVM_NETWORKS = {
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};
const NETWORKS = { ...EVM_NETWORKS, ...SVM_NETWORKS };

/** Which networks to accept. PAYMENT_NETWORKS="base,polygon,arbitrum" opts in;
 *  default is the single primary network (current behavior, zero change). The
 *  primary `network` is always included and listed first (it carries the Bazaar
 *  resource + is what the facilitator must support). */
export function enabledNetworks(network) {
  const requested = (process.env.PAYMENT_NETWORKS || network)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const names = [network, ...requested.filter((n) => n !== network)];
  const seen = new Set();
  const out = [];
  for (const n of names) {
    if (!NETWORKS[n]) throw new Error(`Unsupported network "${n}". Known: ${Object.keys(NETWORKS).join(", ")}`);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * Build the x402 v2 payment middleware: an "exact" USDC payment scheme,
 * paywalling the routes in `catalog`, with Bazaar discovery metadata so agents
 * can find the service. Accepts USDC on EVM chains and optionally Solana (the
 * agent picks the chain it holds funds on).
 */
export async function buildPaymentMiddleware({ walletAddress, network, baseUrl, catalog }) {
  const networks = enabledNetworks(network);
  const caip2List = networks.map((n) => NETWORKS[n]);
  const evmCaip2 = caip2List.filter((c) => c.startsWith("eip155:"));
  const svmCaip2 = caip2List.filter((c) => c.startsWith("solana:"));

  // Facilitator routing. x402ResourceServer accepts a LIST of facilitator
  // clients: at sync it asks each for its /supported kinds and routes every
  // verify/settle by the payment's (network, scheme), earlier clients winning
  // ties. A facilitator that is down at sync only logs a warning — the others
  // keep their networks serving.
  //
  //   - Single network (default): unchanged — CDP (Bazaar discovery +
  //     fee-free Base settlement) or FACILITATOR_URL.
  //   - Multi-chain: CDP FIRST, PayAI second. Base settlement must stay on
  //     CDP: the Bazaar harvester only indexes/refreshes a listing when it
  //     observes a payment settle through CDP, so moving Base to PayAI would
  //     silently degrade marketplace discovery for the chain that actually
  //     earns. PayAI covers the chains CDP doesn't settle (Solana, Polygon,
  //     Arbitrum — free tier 10k settlements/month).
  const isMultiChain = networks.length > 1;
  const facilitatorClients = [];
  if (isMultiChain) {
    const cdpConfig = await resolveCdpFacilitatorConfig();
    if (cdpConfig) {
      facilitatorClients.push(new HTTPFacilitatorClient(cdpConfig));
    } else {
      console.warn(
        "WARNING: multi-chain mode without CDP keys — Base will settle via PayAI and the " +
          "x402 Bazaar will stop indexing/refreshing this seller's listings. Set " +
          "CDP_API_KEY_ID + CDP_API_KEY_SECRET to keep Base on CDP (Bazaar discovery + fee-free)."
      );
    }
    facilitatorClients.push(new HTTPFacilitatorClient(await resolvePayAIFacilitatorConfig()));
    console.log(
      `Multi-chain facilitator routing: ${cdpConfig ? "CDP (Base + Bazaar) → PayAI (remaining chains)" : "PayAI (all chains)"}`
    );
  } else {
    facilitatorClients.push(new HTTPFacilitatorClient(await resolveFacilitatorConfig(network)));
  }
  let server = new x402ResourceServer(facilitatorClients)
    .registerExtension(bazaarResourceServerExtension)
    .registerExtension(builderCodeResourceServerExtension);
  for (const caip2 of evmCaip2) server = server.register(caip2, new ExactEvmScheme());
  for (const caip2 of svmCaip2) server = server.register(caip2, new ExactSvmScheme());
  console.log(`Accepting USDC on: ${networks.join(", ")} (${caip2List.join(", ")})`);

  const solanaWallet = (process.env.SOLANA_WALLET_ADDRESS || "").trim();
  if (svmCaip2.length && solanaWallet) console.log(`Solana payTo: ${solanaWallet}`);
  // Loud, because the failure is silent everywhere else: acceptsFor() below
  // simply omits the Solana option, so every 402 offers EVM chains only and
  // buyers never learn Solana was intended. Zero Solana revenue with no error
  // anywhere is exactly what that misconfiguration looks like.
  if (svmCaip2.length && !solanaWallet) {
    console.warn(
      "WARNING: PAYMENT_NETWORKS enables a Solana network but SOLANA_WALLET_ADDRESS is unset — " +
        "the Solana payment option will be OMITTED from every 402. Set SOLANA_WALLET_ADDRESS " +
        "(base58 Solana address) to actually accept USDC on Solana."
    );
  }

  // One payment option per enabled chain — agents pick the chain they hold funds on.
  const acceptsFor = (item) => [
    ...evmCaip2.map((caip2) => ({ scheme: "exact", payTo: walletAddress, price: item.price, network: caip2 })),
    ...(solanaWallet ? svmCaip2.map((caip2) => ({ scheme: "exact", payTo: solanaWallet, price: item.price, network: caip2 })) : []),
  ];

  // The payment-required header is one base64-encoded JSON blob carrying
  // description + discovery extensions.  Skill packs and tools with rich
  // schemas can push it past ~2900 bytes, which @x402/fetch fails to
  // negotiate.  Cap description and strip bulky output examples here; full
  // text lives on /api/pricing, /openapi.json, tool pages, and MCP surfaces.
  const capDesc = (s) => (s && s.length > 250 ? s.slice(0, 247) + "..." : s);
  const slimDiscovery = (d) => {
    if (!d) return d;
    const slim = { ...d };
    if (slim.output) slim.output = { type: slim.output.type || "json" };
    return slim;
  };

  const builderCode = process.env.BASE_BUILDER_CODE || null;
  if (builderCode) console.log(`Builder Code: ${builderCode} (Base onchain attribution enabled)`);

  const routes = Object.fromEntries(
    Object.entries(catalog).map(([route, item]) => {
      const ext = {};
      if (item.bazaar !== false) Object.assign(ext, declareDiscoveryExtension(slimDiscovery(item.discovery)));
      if (builderCode) Object.assign(ext, { [BUILDER_CODE]: declareBuilderCodeExtension(builderCode) });
      return [
        route,
        {
          accepts: acceptsFor(item),
          description: capDesc(item.description),
          serviceName: "Agent402.tools",
          tags: ["web", "tools", "agents", ...(item.tags ?? [])],
          mimeType: "application/json",
          resource: `${baseUrl}${route.split(" ")[1]}`,
          extensions: Object.keys(ext).length ? ext : undefined,
        },
      ];
    })
  );

  // X402_SYNC_ON_START=false skips the facilitator handshake at boot —
  // only for local testing where the facilitator is unreachable.
  const syncOnStart = process.env.X402_SYNC_ON_START !== "false";
  return paymentMiddleware(routes, server, undefined, undefined, syncOnStart);
}

async function resolvePayAIFacilitatorConfig() {
  if (process.env.PAYAI_API_KEY_ID && process.env.PAYAI_API_KEY_SECRET) {
    const { createFacilitatorConfig } = await import("@payai/facilitator");
    console.log("Facilitator (Solana): PayAI (authenticated)");
    return createFacilitatorConfig(process.env.PAYAI_API_KEY_ID, process.env.PAYAI_API_KEY_SECRET);
  }
  // PayAI free tier: 10,000 settlements/month, no API key needed.
  const { facilitator } = await import("@payai/facilitator");
  console.log("Facilitator (Solana): PayAI (free tier)");
  return facilitator;
}

/** Coinbase CDP facilitator config, or null when the keys aren't set. CDP
 *  settles on Base (fee-free) and indexes discoverable endpoints in the
 *  x402 Bazaar — it's the facilitator Base settlement should always prefer. */
async function resolveCdpFacilitatorConfig() {
  if (!(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET)) return null;
  const { createFacilitatorConfig } = await import("@coinbase/x402");
  console.log("Facilitator: Coinbase CDP (Bazaar discovery enabled)");
  return createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET);
}

async function resolveFacilitatorConfig(network) {
  const cdp = await resolveCdpFacilitatorConfig();
  if (cdp) return cdp;
  if (process.env.FACILITATOR_URL) {
    console.log(`Facilitator: ${process.env.FACILITATOR_URL}`);
    return { url: process.env.FACILITATOR_URL };
  }
  if (network !== "base-sepolia") {
    throw new Error(
      `Network is "${network}" but no facilitator is configured. ` +
        "Set CDP_API_KEY_ID + CDP_API_KEY_SECRET (free at portal.cdp.coinbase.com) " +
        "or FACILITATOR_URL. The default x402.org facilitator only supports base-sepolia testnet."
    );
  }
  console.log("Facilitator: default (x402.org, testnet)");
  return undefined;
}
