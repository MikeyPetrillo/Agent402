// Stripe Agentic Commerce Protocol (ACP) — discovery surfaces
//
// ACP is an open standard (Stripe + OpenAI + Meta) that lets AI agents discover
// and purchase products/services. We expose the Agent402 tool catalog as an
// ACP-compatible product feed so agents using Stripe's payment rails can find us.
//
// Two free, unpaywalled endpoints:
//   GET /acp/feed     — the full tool catalog as ACP products
//   GET /acp/manifest — service metadata (who, what, how to buy)

import { toolList, CATEGORIES } from "./pages.js";

/**
 * ACP product feed — each tool in the catalog becomes an ACP product with
 * structured price, purchase URL, and payment protocol info.
 */
export function acpFeed({ baseUrl, catalog, powSlugs }) {
  const tools = toolList(catalog);
  const products = tools.map((t) => {
    const price = parseFloat(String(t.price).replace(/[^0-9.]/g, "")) || 0;
    return {
      id: t.slug,
      name: t.name,
      description: t.description,
      category: t.category,
      price: {
        amount: price.toFixed(3),
        currency: "USD",
      },
      purchase_url: `${baseUrl}/api/${t.slug}`,
      payment_protocol: "x402",
      compute_payable: powSlugs.has(t.slug),
      docs_url: `${baseUrl}/tools/${t.slug}`,
    };
  });

  return {
    spec: "acp/1",
    merchant: {
      name: "Agent402.Tools",
      url: baseUrl,
      description: `Open-source, self-hostable x402 + MCP server: ${tools.length} pay-per-call tools for AI agents - browser, search, PDFs, OCR, finance, crypto, and more. Pay per call in USDC via x402, or free via proof-of-work.`,
    },
    catalog_size: products.length,
    categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])),
    products,
  };
}

/**
 * ACP service manifest — tells an ACP-aware agent who we are, what we sell,
 * and how to complete a purchase.
 */
export function acpManifest({ baseUrl, network, networks, wallet, toolCount, powDifficulty }) {
  return {
    spec: "acp/1",
    merchant: {
      name: "Agent402.Tools",
      url: baseUrl,
      support_email: "mike@agent402.tools",
      logo_url: `${baseUrl}/icon-192.png`,
    },
    service: {
      type: "api",
      description: `${toolCount} pay-per-call tools for AI agents: deterministic utilities (no model in that serving path - same input, same output), a metered model gateway on the OpenAI and Anthropic wires, and finished report products.`,
      catalog_url: `${baseUrl}/acp/feed`,
      openapi_url: `${baseUrl}/openapi.json`,
      pricing_url: `${baseUrl}/api/pricing`,
      docs_url: `${baseUrl}/docs`,
    },
    payment: {
      protocol: "x402",
      version: 2,
      currency: "USDC",
      networks,
      primary_network: network,
      pay_to: wallet || null,
      non_custodial: true,
      note: "Send a signed x402 payment header with each API call. No signup, no API key - the payment IS the authentication.",
    },
    free_tier: {
      protocol: "proof-of-work",
      description: "Solve a sha256 puzzle (fraction of a second of CPU) to use pure-CPU tools for free - no wallet needed.",
      challenge_url: `${baseUrl}/api/pow/challenge`,
      difficulty_bits: powDifficulty,
    },
    discovery: {
      feed_url: `${baseUrl}/acp/feed`,
      manifest_url: `${baseUrl}/acp/manifest`,
      well_known_x402: `${baseUrl}/.well-known/x402`,
      mcp_connector: `${baseUrl}/mcp`,
      find_tool: `${baseUrl}/api/find?q={task}`,
    },
  };
}
