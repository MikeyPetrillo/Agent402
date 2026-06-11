import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402/extensions/bazaar";

const NETWORKS = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
};

/**
 * Build the x402 v2 payment middleware: an "exact" USDC payment scheme on
 * Base, paywalling the routes in `catalog`, with Bazaar discovery metadata
 * so agents can find the service.
 */
export async function buildPaymentMiddleware({ walletAddress, network, baseUrl, catalog }) {
  const caip2 = NETWORKS[network];
  if (!caip2) {
    throw new Error(`Unsupported NETWORK "${network}". Use one of: ${Object.keys(NETWORKS).join(", ")}`);
  }

  const facilitatorClient = new HTTPFacilitatorClient(await resolveFacilitatorConfig(network));
  const server = new x402ResourceServer(facilitatorClient)
    .register(caip2, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);

  const routes = Object.fromEntries(
    Object.entries(catalog).map(([route, item]) => [
      route,
      {
        accepts: { scheme: "exact", payTo: walletAddress, price: item.price, network: caip2 },
        description: item.description,
        serviceName: "Agent402",
        tags: ["web", "tools", "agents", ...(item.tags ?? [])],
        mimeType: "application/json",
        resource: `${baseUrl}${route.split(" ")[1]}`,
        extensions: declareDiscoveryExtension(item.discovery),
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
