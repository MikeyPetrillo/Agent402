// Top-level discovery & trust surfaces — the two things that make an agent (or a
// discovery layer) PICK this x402 seller over the thousands in the index:
//
//   1. serviceManifest()  → GET /.well-known/x402  — one fetch that describes the
//      whole service: identity, the open-source/self-hostable wedge, every
//      payment option (x402 networks + proof-of-work), the capability map, the
//      MCP connector, the machine-readable surfaces, and the trust signals.
//      Per-resource payment terms still live in each endpoint's HTTP 402 and the
//      x402 Bazaar; this is the convenience index that ties them together.
//
//   2. reliabilityReport() → GET /api/reliability — the "is this seller safe to
//      depend on" surface: uptime, calls served, on-chain revenue proof, and the
//      operational guarantees (tested-before-deploy, 15-min heartbeat, daily paid
//      canary, deterministic, non-custodial) each with a URL to verify it.
//
// Both are pure functions of already-computed state — no network, no secrets.

import { toolList, CATEGORIES } from "./pages.js";

const REPO = "https://github.com/MikeyPetrillo/Agent402";
const MAINTAINER = { name: "Mikey Petrillo", url: "https://github.com/MikeyPetrillo" };

function priceRange(prices) {
  const nums = prices.filter((n) => n > 0);
  if (!nums.length) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const fmt = (n) => `$${n.toFixed(3).replace(/0+$/, "").replace(/\.$/, ".0")}`;
  return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
}

/** Per-category rollup: count, price range, and whether any tool is compute-payable. */
function capabilityMap(catalog, powSlugs) {
  const tools = toolList(catalog);
  return Object.entries(CATEGORIES)
    .map(([key, { label }]) => {
      const inCat = tools.filter((t) => t.category === key);
      if (!inCat.length) return null;
      const prices = inCat.map((t) => parseFloat(String(t.price).replace(/[^0-9.]/g, "")) || 0);
      return {
        key,
        label,
        tools: inCat.length,
        priceRange: priceRange(prices),
        computePayable: inCat.some((t) => powSlugs.has(t.slug)),
      };
    })
    .filter(Boolean);
}

/**
 * The canonical machine-readable summary of this service, served at
 * /.well-known/x402. Designed so a discovery agent can decide "use this seller"
 * from a single GET, then drill into /openapi.json or each route's 402 for terms.
 */
export function serviceManifest({ baseUrl, network, networks, wallet, walletName, catalog, toolCount, powSlugs, powDifficulty, prices }) {
  const powEligible = [...powSlugs];
  return {
    spec: "agent402-service-manifest/1",
    about: `${REPO}#agent402-in-the-x402-ecosystem`,
    name: "Agent402",
    summary:
      "The open-source, self-hostable x402 + MCP server: one integration, a full catalog of web tools for AI agents — browser, search, PDFs, images, live data, payments — plus ~1,000 deterministic utilities.",
    homepage: baseUrl,
    repository: REPO,
    openSource: true,
    selfHostable: true,
    license: "MIT",
    maintainer: MAINTAINER,
    // The differentiator, stated for machines: most x402 sellers are closed
    // gateways exposing a handful of tools. This one is open, self-hostable, has
    // the whole catalog, AND owns the other side of the protocol (pay-per-crawl).
    differentiators: [
      "Open-source and self-hostable — read every line, run it yourself (MIT).",
      `One integration covers all ${toolCount} tools (vs. per-service SDKs/signups).`,
      "Two-sided: also ships agent402-tollbooth, an open pay-per-crawl gate for the demand side of x402.",
      "Deterministic — no LLM in the serving path; same input, same output, full OpenAPI schemas.",
      "Free without a wallet via proof-of-work on the pure-CPU tools.",
    ],
    twoSided: {
      tollbooth: {
        summary:
          "Open-source, self-hostable pay-per-crawl gate: charge AI crawlers per request (USDC via x402, or free proof-of-work) while humans browse free. Express middleware, reverse proxy, or edge (Cloudflare Workers / Next.js).",
        repository: `${REPO}/tree/main/tollbooth`,
        npm: "agent402-tollbooth",
      },
    },
    payment: {
      x402: {
        version: 2,
        currency: "USDC",
        networks,
        primaryNetwork: network,
        priceRange: priceRange(Object.values(prices)),
        payTo: wallet || null,
        payToName: walletName || null,
        nonCustodial: true,
      },
      proofOfWork: {
        summary: "No wallet? Solve a single-use sha256 puzzle (a fraction of a second of CPU) — no money, no AI tokens, no model involved.",
        difficultyBits: powDifficulty,
        eligibleTools: powEligible.length,
        challengeUrl: `${baseUrl}/api/pow/challenge`,
        info: `${baseUrl}/api/pow`,
      },
    },
    capabilities: {
      tools: toolCount,
      categories: capabilityMap(catalog, powSlugs),
    },
    mcp: {
      remoteConnector: `${baseUrl}/mcp`,
      remoteNote: "Streamable HTTP, no auth — paste into Claude/ChatGPT custom connectors. Pure-CPU tools run free (rate-limited).",
      package: "agent402-mcp",
      registry: "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.MikeyPetrillo/agent402",
    },
    machineReadable: {
      openapi: `${baseUrl}/openapi.json`,
      pricing: `${baseUrl}/api/pricing`,
      llmsTxt: `${baseUrl}/llms.txt`,
      stats: `${baseUrl}/api/stats`,
      reliability: `${baseUrl}/api/reliability`,
      // Resolve a task to the right tool in one call (skip the exploration step).
      findTool: `${baseUrl}/api/find?q={task}`,
    },
    trust: {
      onchainRevenueProof: wallet
        ? `${network === "base-sepolia" ? "https://sepolia.basescan.org" : "https://basescan.org"}/address/${wallet}#tokentxns`
        : null,
      namedMaintainer: MAINTAINER.url,
      testedBeforeEveryDeploy: true,
      productionHeartbeatMinutes: 15,
      deterministic: true,
      details: `${baseUrl}/api/reliability`,
    },
  };
}

/**
 * Structured reliability / trust report served at /api/reliability. Every claim
 * an agent might want before depending on this seller, each paired with a URL to
 * verify it independently. Liveness facts come from the live stats object; the
 * guarantees are operational facts about how the service is built and watched.
 */
export function reliabilityReport({ baseUrl, network, wallet, stats }) {
  const explorer = network === "base-sepolia" ? "https://sepolia.basescan.org" : "https://basescan.org";
  return {
    service: "Agent402",
    // This report is served BY the app, so a 200 here means the node is up and
    // serving. Real-time external liveness is the heartbeat + /health below.
    status: "operational",
    asOf: new Date().toISOString(),
    servingSince: stats.servingSince,
    uptimeSeconds: stats.uptimeSeconds,
    toolCallsServed: stats.toolCallsServed,
    onchain: {
      revenueProof: wallet ? `${explorer}/address/${wallet}#tokentxns` : null,
      note: "Settled revenue is verifiable on-chain — that is the trustless source of truth, not any counter here.",
    },
    guarantees: [
      {
        claim: "Every tool is called with its own documented example in CI, and the release is blocked on any failure.",
        verify: `${baseUrl}/openapi.json`,
        evidence: `${REPO}/actions/workflows/deploy.yml`,
      },
      {
        claim: "A production heartbeat probes the live instance (health, catalog, MCP, the 402 paywall, proof-of-work) every 15 minutes and files a public issue on failure.",
        verify: `${baseUrl}/health`,
        evidence: `${REPO}/issues?q=label%3Aheartbeat`,
      },
      {
        claim: "A daily canary makes a real $0.001 USDC purchase against production to prove the paid path settles end-to-end.",
        verify: `${baseUrl}/api/stats`,
        evidence: wallet ? `${explorer}/address/${wallet}#tokentxns` : null,
      },
      {
        claim: "Deterministic: no LLM in the serving path — the same input always yields the same output.",
        verify: `${baseUrl}/openapi.json`,
      },
      {
        claim: "Non-custodial: the agent signs payment with its own key; Agent402 never holds or moves funds.",
        verify: `${baseUrl}/llms.txt`,
      },
      {
        claim: "Hardened: connect-time SSRF guard on every URL tool (DNS-rebind safe), signed single-use slug-scoped proof-of-work, per-IP rate limits, and security headers.",
        verify: `${REPO}/wiki/Security-Model`,
      },
    ],
    endpoints: {
      health: `${baseUrl}/health`,
      stats: `${baseUrl}/api/stats`,
      openapi: `${baseUrl}/openapi.json`,
      manifest: `${baseUrl}/.well-known/x402`,
    },
    incidents: `${REPO}/issues?q=label%3Aheartbeat`,
  };
}
