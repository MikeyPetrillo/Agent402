import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402/extensions/bazaar";

// USDC is auto-resolved per network by @x402/evm's built-in asset registry, so
// adding a chain just means registering the scheme + offering it in `accepts`.
// Only chains the registry knows USDC for (and a facilitator can settle) are safe.
const NETWORKS = {
  base: "eip155:8453",
  polygon: "eip155:137",
  arbitrum: "eip155:42161",
  "base-sepolia": "eip155:84532",
};

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
 * can find the service. Accepts USDC on one or more EVM chains (the agent picks
 * the chain it holds funds on).
 */
export async function buildPaymentMiddleware({ walletAddress, network, baseUrl, catalog }) {
  const networks = enabledNetworks(network);
  const caip2List = networks.map((n) => NETWORKS[n]);

  const facilitatorClient = new HTTPFacilitatorClient(await resolveFacilitatorConfig(network));
  let server = new x402ResourceServer(facilitatorClient).registerExtension(bazaarResourceServerExtension);
  for (const caip2 of caip2List) server = server.register(caip2, new ExactEvmScheme());
  console.log(`Accepting USDC on: ${networks.join(", ")} (${caip2List.join(", ")})`);

  // One payment option per enabled chain — an array of accepts the agent can choose from.
  const acceptsFor = (item) => caip2List.map((caip2) => ({ scheme: "exact", payTo: walletAddress, price: item.price, network: caip2 }));

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

  const routes = Object.fromEntries(
    Object.entries(catalog).map(([route, item]) => [
      route,
      {
        accepts: acceptsFor(item),
        description: capDesc(item.description),
        // The brand string the Coinbase CDP Bazaar surfaces for every listing
        // we publish — also what appears on /api/leaderboard. We use the
        // domain so the row on every public x402 surface back-links the site.
        serviceName: "Agent402.tools",
        tags: ["web", "tools", "agents", ...(item.tags ?? [])],
        mimeType: "application/json",
        resource: `${baseUrl}${route.split(" ")[1]}`,
        extensions: declareDiscoveryExtension(slimDiscovery(item.discovery)),
      },
    ])
  );

  // X402_SYNC_ON_START=false skips the facilitator handshake at boot —
  // only for local testing where the facilitator is unreachable.
  const syncOnStart = process.env.X402_SYNC_ON_START !== "false";
  return paymentMiddleware(routes, server, undefined, undefined, syncOnStart);
}

async function resolveFacilitatorConfig(network) {
  if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) {
    // Coinbase facilitator: settles on Base mainnet and indexes discoverable
    // endpoints in the x402 Bazaar.
    const { createFacilitatorConfig } = await import("@coinbase/x402");
    console.log("Facilitator: Coinbase CDP (Bazaar discovery enabled)");
    return createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET);
  }
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
