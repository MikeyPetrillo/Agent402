// Top-level discovery & trust surfaces - the two things that make an agent (or a
// discovery layer) PICK this x402 seller over the thousands in the index:
//
//   1. serviceManifest()  → GET /.well-known/x402  - one fetch that describes the
//      whole service: identity, the open-source/self-hostable wedge, every
//      payment option (x402 networks + proof-of-work), the capability map, the
//      MCP connector, the machine-readable surfaces, and the trust signals.
//      Per-resource payment terms still live in each endpoint's HTTP 402 and the
//      x402 Bazaar; this is the convenience index that ties them together.
//
//   2. reliabilityReport() → GET /api/reliability - the "is this seller safe to
//      depend on" surface: uptime, calls served, on-chain revenue proof, and the
//      operational guarantees (tested-before-deploy, 15-min heartbeat, daily paid
//      canary, deterministic, non-custodial) each with a URL to verify it.
//
// Both are pure functions of already-computed state - no network, no secrets.

import { toolList, CATEGORIES } from "./pages.js";
import { SKILL_PACKS } from "./skills.js";
import { RAIL_CHAIN_NAMES, RAILS_NOTE } from "./rails.js";

const REPO = "https://github.com/MikeyPetrillo/Agent402";
const MAINTAINER = { name: "Havok Holdings LLC", email: "mike@agent402.tools", url: REPO };

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
    // x402scan compatibility (Merit-Systems/x402scan docs/DISCOVERY.md): its
    // /.well-known/x402 fan-out wants `version: 1` + a `resources` URL array.
    // Additive - everything below remains the richer agent-facing manifest.
    version: 1,
    // Dedupe by URL, not by catalog key: a handful of tools (e.g. /api/memory)
    // are registered twice in the catalog, once per HTTP method (GET read,
    // POST write) - x402scan's discovery format wants a flat resource-URL
    // list, not a method-annotated one (openapi.json already carries that),
    // so the honest fix here is "list the URL once" rather than emitting the
    // same address twice with no way for a consumer to tell why.
    resources: [...new Set(Object.keys(catalog).map((route) => `${baseUrl}${route.split(" ")[1] || route}`))],
    about: `${REPO}#agent402-in-the-x402-ecosystem`,
    name: "Agent402.Tools",
    summary:
      `Agent402.Tools - open-source, self-hostable, x402 + MPP (+ MCP server): 500+ pay-per-call tools for AI agents in one integration (the applied layer of Agentic Finance) - browser, search, PDFs, images, OCR, live financial/crypto/macro data, SEC EDGAR, ${SKILL_PACKS.length} curated multi-tool skill packs callable as MCP prompts, wallet-keyed memory, and an OpenAI-compatible LLM gateway at /v1 (flat-priced chat from $0.003/call, embeddings $0.002 - no API key, the wallet is the account). Free via proof-of-work, or pay per call in USDC via x402 or over MPP (Base/Celo USDC, native Tempo).`,
    homepage: baseUrl,
    repository: REPO,
    openSource: true,
    selfHostable: true,
    license: "AGPL-3.0-or-later",
    maintainer: MAINTAINER,
    // Programmatic buyers get their terms notice here, in llms.txt, and on
    // /v1/models - use of the service constitutes acceptance (see /terms).
    termsOfService: `${baseUrl}/terms`,
    privacyPolicy: `${baseUrl}/privacy`,
    // Base ecosystem metadata - the builder code links on-chain settlements to
    // this app in the Base builder program; the app ID is our registered Base
    // MCP plugin identifier. Both are optional (env-gated / static).
    ...(process.env.BASE_BUILDER_CODE ? { builderCode: process.env.BASE_BUILDER_CODE } : {}),
    baseApp: "6a3dd86ca341d86b910769fb",
    ecosystem: {
      chains: RAIL_CHAIN_NAMES,
      primaryChain: "Base",
      primaryChainId: 8453,
      currency: "USDC",
      protocol: "x402",
      note: RAILS_NOTE,
    },
    // Positive, machine-readable summary of what Agent402 offers: open and
    // self-hostable, the whole catalog in one integration, and it owns the
    // other side of the protocol too (pay-per-crawl).
    differentiators: [
      "Open-source and self-hostable - read every line, run it yourself (AGPL-3.0).",
      `One integration covers all 500+ tools - no per-service SDKs or signups.`,
      "People pay too: finished, cited reports by card at /reports ($2 to $5 by card; agents pay the lower tool price, $0.60 to $2.00 per call for an agent, per call), $5/month monitors at /monitors, and prepaid credits at /credits (an a402_ key that pays every tool by card, debited only on success).",
      "Two-sided: also ships agent402-tollbooth, an open pay-per-crawl gate for the demand side of x402.",
      "Deterministic utility tools - no LLM in that serving path; same input, same output, full OpenAPI schemas. The /v1 gateway (metered and flat tiers) and the report products are model-backed and say so.",
      "Free without a wallet via proof-of-work on the pure-CPU tools.",
      `${SKILL_PACKS.length} curated multi-tool workflows (skill packs) callable as MCP prompts - agents fetch the whole task template, not just one tool.`,
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
        ...(process.env.BASE_BUILDER_CODE ? { builderCode: process.env.BASE_BUILDER_CODE } : {}),
      },
      proofOfWork: {
        summary: "No wallet? Solve a single-use sha256 puzzle (a fraction of a second of CPU) - no money, no AI tokens, no model involved.",
        difficultyBits: powDifficulty,
        eligibleTools: powEligible.length,
        challengeUrl: `${baseUrl}/api/pow/challenge`,
        info: `${baseUrl}/api/pow`,
      },
      // Data minimisation on the payment path (machine-readable so a
      // compliance-aware buyer can verify posture before transacting). An x402
      // token may carry optional annotation fields; we read only the signed
      // payer address (already public on-chain) and never parse, log, or retain
      // the rest.
      dataHandling: {
        readsPaymentMetadata: false,
        retainsPaymentMetadata: false,
        readsOnly: ["authorization.from (signed payer address, public on-chain)"],
        note: "Optional x402 token annotation fields (resource URL, description, reason) are never parsed, logged, or retained. Data-minimisation by construction.",
        policy: `${baseUrl}/privacy`,
      },
    },
    capabilities: {
      tools: toolCount,
      categories: capabilityMap(catalog, powSlugs),
    },
    // Curated multi-tool workflows ("skill packs"). Each pack composes 5–7
    // catalog tools into a Claude-ready task template for jobs that no single
    // tool covers (e.g. "audit a domain", "diagnose deliverability"). Callable
    // as MCP prompts (prompts/list → prompts/get) or via plain HTTP. Same
    // discovery wedge as `capabilities.tools` but at the *task* granularity.
    workflows: {
      count: SKILL_PACKS.length,
      indexHtml: `${baseUrl}/skills`,
      index: `${baseUrl}/api/skill-packs.json`,
      promptHttp: `${baseUrl}/api/skill-packs/{slug}/prompt`,
      mcpPromptsHint: "On the MCP connector, call prompts/list then prompts/get { name: '<slug>', arguments: {…} } - same slugs as below.",
      items: SKILL_PACKS.map((p) => ({
        slug: p.slug,
        title: p.title,
        toolCount: (p.toolSlugs || []).length,
        url: `${baseUrl}/skills/${p.slug}`,
        promptName: p.slug,
      })),
    },
    mcp: {
      remoteConnector: `${baseUrl}/mcp`,
      remoteNote: "Streamable HTTP, no auth - paste into Claude, Claude Code, Cursor, ChatGPT (Pro+), or VS Code (GitHub Copilot MCP) custom connectors. Pure-CPU tools run free (rate-limited).",
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
      // Public on-chain ranking of every x402 seller by Base USDC settled volume.
      leaderboard: `${baseUrl}/api/leaderboard`,
    },
    // Neutral cross-seller discovery surface - same router we use ourselves,
    // exposed as a public API so any x402 buyer can find the cheapest healthy
    // tool across the whole ecosystem (not just our catalog). `include=external`
    // explicitly excludes us from the results - we list because we trust the
    // ranking, not because we'd rig it for ourselves.
    discovery: {
      spec: "x402-discovery/1",
      neutralRouter: `${baseUrl}/api/route`,
      sellerIndex: `${baseUrl}/api/index`,
      sellerIndexHtml: `${baseUrl}/marketplace`,
      // On-chain ranking of every seller in the Bazaar by Base USDC settled
      // volume. Same router, different sort key - closes the loop on
      // discovery: find a tool, route to a seller, see who's most used.
      leaderboard: `${baseUrl}/api/leaderboard`,
      leaderboardHtml: `${baseUrl}/leaderboard`,
      // The MPP side of the same primitives: a live-verified index of sellers
      // speaking WWW-Authenticate: Payment (with the payment offers their real
      // 402 makes), and an on-chain ranking by inbound USDC.e transfers on Tempo
      // to each seller's live recipient (`routable` = the router will pay them).
      mppSellerIndex: `${baseUrl}/api/mpp-index`,
      mppSellerIndexHtml: `${baseUrl}/mpp-marketplace`,
      mppLeaderboard: `${baseUrl}/api/mpp-leaderboard`,
      // The leaderboard primitive ships on three equivalent surfaces so an
      // agent can consume it however it already talks to Agent402. The HTTP
      // endpoint is the source of truth; the MCP tool and SDK method are thin
      // proxies that hit it. Naming them here as a typed shape (instead of
      // only prose in llms.txt) lets cross-protocol routers dispatch on it.
      leaderboardSurfaces: {
        http: `${baseUrl}/api/leaderboard`,
        mcpTool: "sellers.list",
        sdkMethod: "topSellers",
      },
      includeOptions: ["all", "external", "local"],
      // Same lens as the HTML toggle on /leaderboard.
      // `usd` = total USDC settled (default); `calls` = raw call count.
      sortOptions: ["usd", "calls"],
      example: {
        method: "POST",
        url: `${baseUrl}/api/route`,
        body: { query: "ocr image", top: 3, include: "external" },
      },
      sources: ["self", "Coinbase CDP Bazaar"],
      refreshSeconds: { discovery: 3600, crawl: 300, leaderboard: 3600 },
    },
    trust: {
      onchainRevenueProof: wallet
        ? `${network === "base-sepolia" ? "https://sepolia.basescan.org" : "https://basescan.org"}/address/${wallet}#tokentxns`
        : null,
      namedMaintainer: MAINTAINER.url,
      testedBeforeEveryDeploy: true,
      productionHeartbeatMinutes: 15,
      deterministic: true,
      // Not a refund program: settlement runs after the handler and only
      // completes for an under-400 response, so an error cancels payment in
      // the middleware itself - there is nothing to claim back.
      failedCallsNeverCharged: "structural",
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
export function reliabilityReport({ baseUrl, network, wallet, stats, observedStatus = null }) {
  const explorer = network === "base-sepolia" ? "https://sepolia.basescan.org" : "https://basescan.org";
  return {
    service: "Agent402.Tools",
    // Serving BY the app only proves this node answered. The honest word is
    // what the OUTSIDE observers measured, so this mirrors /api/status's
    // `overall` rather than asserting a second opinion: the two surfaces
    // disagreed in the same minute ("degraded" here, "operational" there) and
    // a partner polling either one was wrong half the time (found by an
    // outside reviewer, 2026-08-28). Falls back to "serving" - never to
    // "operational" - when the observation store cannot be read.
    status: observedStatus || "serving",
    statusMeasuredFrom: `${baseUrl}/api/status`,
    asOf: new Date().toISOString(),
    servingSince: stats.servingSince,
    processUptimeSeconds: stats.processUptimeSeconds,
    toolCallsServed: stats.toolCallsServed,
    onchain: {
      revenueProof: wallet ? `${explorer}/address/${wallet}#tokentxns` : null,
      note: "Settled revenue is verifiable on-chain - that is the trustless source of truth, not any counter here.",
    },
    guarantees: [
      {
        // Was "Every tool". It is not every tool: CI deliberately skips 20 of
        // 528 endpoints (18 Brave-backed, 2 E2B) because exercising them spends
        // real money on a metered upstream on every run, and the sweep once
        // cost ~4,500 billed Brave queries in a month. The skip is the right
        // call; claiming otherwise was not, and "every" is the kind of word a
        // reader can check against our own open CI logs.
        claim: "Every tool is called with its own documented example in CI, and the release is blocked on any failure - except 20 of 528 endpoints backed by metered third-party APIs (Brave, E2B), which are skipped so a CI run does not spend on every push and are covered instead by the post-deploy paid canary and a dedicated live test.",
        verify: `${baseUrl}/openapi.json`,
        evidence: `${REPO}/actions/workflows/deploy.yml`,
      },
      {
        // Sharpened rather than corrected: the substance held but the
        // attribution did not. "A production heartbeat" is really TWO
        // independent observers on separate infrastructure (a GitHub schedule
        // and a Cloudflare cron), which is the part actually worth claiming,
        // and the measured rate is better than the number we advertised.
        // Measured over 24h at the time of writing: 378 observations for
        // health/catalog/MCP/paywall/rails (~3.8 min apart) and 90 for the
        // proof-of-work paid path (~16 min apart), the latter lower because
        // only the GitHub observer holds the credentials to make a paid call.
        claim: "Two independent observers outside production (a GitHub schedule and a Cloudflare cron on separate infrastructure) probe the live instance - health, catalog, MCP, the 402 paywall, rails - and file a public issue on failure. Measured over 24h: ~378 observations per component, about one every 4 minutes; the proof-of-work paid path is probed by the GitHub observer alone at ~16 minute intervals. Per-component uptime and observation counts are published at /api/status.",
        verify: `${baseUrl}/health`,
        evidence: `${REPO}/issues?q=label%3Aheartbeat`,
      },
      {
        claim: "A daily canary makes a real $0.001 USDC purchase against production to prove the paid path settles end-to-end.",
        verify: `${baseUrl}/api/stats`,
        evidence: wallet ? `${explorer}/address/${wallet}#tokentxns` : null,
      },
      {
        claim: "Deterministic utilities: no LLM in the serving path of the utility tools - the same input always yields the same output. The /v1 gateway and the report products are model-backed and priced as such.",
        verify: `${baseUrl}/openapi.json`,
      },
      {
        claim: "Non-custodial on the payment rails: an agent signs with its own key and settlement goes wallet to wallet, so no customer key or crypto balance is ever held. Two card paths are NOT non-custodial and are named as such: prepaid credits are a balance we hold until spent, and card report purchases are held by the payment processor.",
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
      // Availability history measured by an observer OUTSIDE this server, so a
      // buyer deciding whether to depend on us can check uptime without taking
      // our word for it. `status` is the JSON; `statusPage` is the human view.
      status: `${baseUrl}/api/status`,
      statusPage: `${baseUrl}/status`,
      openapi: `${baseUrl}/openapi.json`,
      manifest: `${baseUrl}/.well-known/x402`,
    },
    incidents: `${REPO}/issues?q=label%3Aheartbeat`,
  };
}
