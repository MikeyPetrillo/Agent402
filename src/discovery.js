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
import { mppMethodsSummary } from "./mpp-offers.js";
import { RAIL_CHAIN_NAMES, RAILS_NOTE } from "./rails.js";
import { agentReportPriceRange, cardReportPriceRange, reportLadderProse } from "./report-tiers.js";
import { HUMAN_PRODUCTS } from "./human-checkout.js";
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";
import { CRAWL_INTERVAL_SECONDS, DISCOVERY_INTERVAL_SECONDS } from "./crawl-cadence.js";

import { REPO_URL, REPO_NAMESPACE } from "./repo-link.js";
const REPO = REPO_URL;
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
export function serviceManifest({ baseUrl, network, networks, wallet, walletName, payToByNetwork = null, catalog, toolCount, powSlugs, powDifficulty, prices }) {
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
      `Agent402.Tools - open-source, self-hostable, x402 + MPP (+ MCP server): 500+ pay-per-call tools for AI agents in one integration (the applied layer of Agentic Finance) - browser, search, PDFs, images, OCR, live financial/crypto/macro data, SEC EDGAR, ${SKILL_PACKS.length} curated multi-tool skill packs callable as MCP prompts, wallet-keyed memory, and an OpenAI-compatible LLM gateway at /v1 (flat-priced chat from $0.003/call, embeddings $0.002 - no API key, the wallet is the account). Free via proof-of-work, or pay per call in USDC via x402 or over MPP (native Tempo, Base/Celo USDC, cards on routes of $0.50 or more).`,
    // The MPP methods the 402 offers, in its order (src/mpp-offers.js - the
    // same source /openapi.json x-payment-info and /llms.txt read).
    mpp: mppMethodsSummary(),
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
      // Prices read from the product tables, never typed; credits are not on sale.
      `People pay too: finished reports by card at /reports (${cardReportPriceRange(HUMAN_PRODUCTS).text} by card; an agent pays the tool price per call, ${agentReportPriceRange().text}) and monitors at /monitors (${reportLadderProse({ monitorProducts: MONITOR_PRODUCTS }).monthly} a month).`,
      "Two-sided: also ships agent402-tollbooth, an open pay-per-crawl gate for the demand side of x402.",
      "Utility tools run as code with no language model writing the answer, and every route publishes a full OpenAPI schema. The /v1 gateway (metered and flat tiers), the report products and the media tools are model-backed and say so.",
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
        // The EVM payTo above serves every EVM rail; Solana, Stellar and
        // Algorand settle to their own addresses (each 402 carries the exact
        // one per accept). Listed here so a reader of the manifest alone does
        // not conclude a non-EVM rail pays to an EVM address (an outside
        // reader did, 2026-09-03). Only rails with a configured address appear.
        ...(payToByNetwork && Object.keys(payToByNetwork).length ? { payToByNetwork } : {}),
        // A sentence, not a boolean: a boolean cannot carry the exception, and the
        // exception is real (prepaid card credits and card-paid reports are held
        // balances; see /security). Same rule as `deterministic` and
        // `testedBeforeEveryDeploy`, pinned by test-copy-absolutes.
        nonCustodial: "on the x402 and MPP rails these tools never hold, receive, sign or send funds: a payment settles wallet to wallet through the facilitator. Prepaid card credits (no longer sold; issued keys still spend) are the one balance held; card reports and monitors are ordinary card charges; see /security.",
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
      // compliance-aware buyer can verify posture before transacting). The
      // list names every field of a payment the server reads and why; it once
      // named only authorization.from while the payment-identifier extension,
      // the Solana transaction's signers, the Tempo credential source and the
      // facilitator receipt's payer were all read too.
      dataHandling: {
        readsPaymentMetadata: false,
        retainsPaymentMetadata: false,
        readsOnly: [
          "authorization.from (signed EVM payer address, public on-chain): the identity of wallet-scoped routes and the payer recorded for a sale",
          "the payment-identifier extension, when sent: an idempotency key bound to the credential, route and body",
          "the signers of a Solana payment transaction: to tell one paying wallet from another in failure telemetry, stored only as a keyed hash",
          "the source of a Tempo MPP credential (a did:pkh address): to classify the payer of a sale",
          "the payer named in the facilitator's settlement receipt: recorded with the sale when the payment itself names none we can verify",
        ],
        retains: "each sale's payer address, settlement transaction, route and price, in the sales ledger; payer addresses are never published",
        note: "Optional x402 token annotation fields (resource URL, description, reason) are not parsed, logged, or retained.",
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
      registry: `https://registry.modelcontextprotocol.io/v0/servers?search=${REPO_NAMESPACE}/agent402`,
    },
    machineReadable: {
      openapi: `${baseUrl}/openapi.json`,
      pricing: `${baseUrl}/api/pricing`,
      llmsTxt: `${baseUrl}/llms.txt`,
      stats: `${baseUrl}/api/stats`,
      reliability: `${baseUrl}/api/reliability`,
      // Resolve a task to the right tool in one call (skip the exploration step).
      findTool: `${baseUrl}/api/find?q={task}`,
      // Public on-chain ranking of x402 sellers by Base USDC settled volume.
      // A top-N slice per request (25 default, 50 ceiling unauthenticated);
      // `totalSellers` in the response carries how many are ranked in all.
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
      // On-chain ranking of Bazaar sellers by Base USDC settled volume, head
      // of the board first - a ranked page, never the whole board in one GET.
      // Same router, different sort key - closes the loop on discovery: find a
      // tool, route to a seller, see who's most used.
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
      // Read from the crawler's own timers; "crawl: 300" stood here while the
      // crawler ran every 1800 s.
      refreshSeconds: { discovery: DISCOVERY_INTERVAL_SECONDS, crawl: CRAWL_INTERVAL_SECONDS, leaderboard: 3600 },
    },
    trust: {
      onchainRevenueProof: wallet
        ? `${network === "base-sepolia" ? "https://sepolia.basescan.org" : "https://basescan.org"}/address/${wallet}#tokentxns`
        : null,
      namedMaintainer: MAINTAINER.url,
      // Both of these were unqualified booleans that were not true of the whole
      // catalog, which is the worst shape for a machine-readable trust claim:
      // a consumer reads `true` and cannot see the exception.
      //
      // testedBeforeEveryDeploy: the two catalog sweeps exclude the metered
      // slugs by design (CI holds no third-party keys and must not spend
      // upstream), so the honest answer names the exemption and its size.
      testedBeforeEveryDeploy: "every non-metered route answers its own documented example before each deploy; the metered routes (third-party keys, real upstream spend) are exempt, the daily paid canary buys a sample of them and an offline probe checks the report inputs",
      // The interval of the observer that keeps it: the Cloudflare cron runs
      // every 5 minutes (workers/status-probe/wrangler.toml). The GitHub
      // schedule asks for 15 and is delivered far less often, so 15 was the
      // request, not the cadence.
      productionHeartbeatMinutes: 5,
      productionHeartbeat: "a Cloudflare cron probes every 5 minutes; a GitHub schedule adds its own observations at irregular intervals; per-component observation counts are at /api/status",
      // deterministic: true was false for the /v1 gateway tiers, every report
      // product, and the image, speech, transcription, embedding and
      // AI-answer tools. The string says which is which.
      deterministic: "most tools are pure deterministic code with no model in their path; the /v1 gateway tiers, the report products and the image, speech, transcription, embedding and AI-answer tools are model-backed and marked modelBacked in the catalog",
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
export function reliabilityReport({ baseUrl, network, wallet, stats, observedStatus = null, meteredSkip = null }) {
  // Exact count of priced routes the catalog sweeps skip as metered, derived
  // from src/metered-slugs.js (the list the sweeps read) over the live catalog.
  const skipped = meteredSkip && Number.isFinite(meteredSkip.metered) && Number.isFinite(meteredSkip.total)
    ? `${meteredSkip.metered} of this server's ${meteredSkip.total} priced routes`
    : null;
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
        // Was "Every tool". It is not every tool: CI deliberately skips the
        // metered routes because exercising them spends real money upstream on
        // every run. The count is derived (meteredSkip over the live catalog,
        // from src/metered-slugs.js, the list both sweeps read), never typed:
        // a typed "20 of 528" here went stale as the metered set grew.
        claim: `Every tool CI can run without a third-party key is called with its own documented example, and the release is blocked on any failure. The metered tools (search, the model gateway, the reports and other keyed or upstream-billed tools${skipped ? `: ${skipped}` : ""}) are skipped so a CI run never spends upstream; the daily paid canary buys a sample of them and an offline probe checks the report inputs.`,
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
        // health/catalog/MCP/paywall/rails (~3.8 min apart). The proof-of-work
        // paid path was then observed by the GitHub heartbeat alone; since
        // 2026-09-28 the Cloudflare cron walks it too, with a probe-only
        // challenge (src/pow.js), so the claim names both and quotes that
        // cadence as a schedule, not as a measurement. The two walk different
        // challenges, which is why /status judges paid-call per observer
        // (stateFromSources in src/status-store.js) and the claim says so.
        claim: "Two independent observers outside production (a GitHub schedule and a Cloudflare cron on separate infrastructure) probe the live instance - health, catalog, MCP, the 402 paywall, rails and the proof-of-work paid path - and file a public issue on failure. The Cloudflare cron runs every 5 minutes and the GitHub schedule adds its own runs; the paid path is walked end to end by both observers, the GitHub schedule on the challenge a buyer is issued and the Cloudflare cron on a low-difficulty probe challenge every 5 minutes, and a failure either records stands until that same observer sees the path work again. Per-component uptime and observation counts are published at /api/status.",
        verify: `${baseUrl}/health`,
        evidence: `${REPO}/issues?q=label%3Aheartbeat`,
      },
      {
        claim: "A daily canary makes a real $0.001 USDC purchase against production to prove the paid path settles end-to-end.",
        verify: `${baseUrl}/api/stats`,
        evidence: wallet ? `${explorer}/address/${wallet}#tokentxns` : null,
      },
      {
        claim: "No language model writes the answer of a utility tool: a pure-computation tool returns the same output for the same input, and a live-data tool returns its source's current reading. The /v1 gateway, the report products and the media tools are model-backed and priced as such, and a judgment model can choose among candidates on the router.",
        verify: `${baseUrl}/openapi.json`,
      },
      {
        claim: "Non-custodial on the payment rails: an agent signs with its own key and settlement goes wallet to wallet, so no customer key or crypto balance is ever held. One card path is NOT non-custodial and is named as such: a prepaid credits balance (credits are no longer sold; issued keys still spend) is money we hold until spent. A card report is charged at checkout and refunded to the card automatically if generation fails.",
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
