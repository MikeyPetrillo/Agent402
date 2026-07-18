import { RAILS_OR, RAILS_SHORT } from "./rails.js";
// Railway's egress has NO working IPv6 (every AAAA is ENETUNREACH). Node's
// happy-eyeballs races the IPv6 address on dual-stack upstreams and fails ~15% of
// the time (UND_ERR_SOCKET / "could not connect"). Force IPv4 process-wide for the
// payment client and any raw fetch (the SSRF dispatcher forces it separately for
// the tool fetchers). Nothing is lost — an IPv6-only host is unreachable here anyway.
import dns from "node:dns";
import { setGlobalDispatcher, Agent as UndiciAgent } from "undici";
dns.setDefaultResultOrder("ipv4first");
setGlobalDispatcher(new UndiciAgent({ connect: { family: 4 } }));
import express from "express";
import compression from "compression";
import { readFileSync } from "node:fs";
import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";
import { extractArticle, fetchPageMeta } from "./tools/extract.js";
import { dnsLookup } from "./tools/dns.js";
import { pdfToText } from "./tools/pdf.js";
import { renderArticle, screenshotPage, rasterizeSvg } from "./tools/render.js";
import {
  memoryPut, memoryGet, memoryDelete, memoryIncr, memoryCas,
  grant, revoke, listGrants, getLog, remember, recall, forget,
  PERSISTENT as memoryPersistent,
} from "./tools/memory.js";
import { payerFromRequest, payerFromPaymentResponse } from "./payer.js";
import { paymentReplayKey, createReplayGuard } from "./replay-guard.js";
import { landingPage } from "./landing.js";
import { statusPage } from "./status.js";
import { tollboothLandingPage } from "./tollbooth-landing.js";
import { tollboothCloudPage } from "./tollbooth-cloud.js";
import { tollboothWaitlistPage } from "./tollbooth-waitlist.js";
import { operatorLeadsPage } from "./operator-leads.js";
import { operatorWishesPage } from "./operator-wishes.js";
import { initLeadsDb, insertLead, listLeads, countLeads, leadsDbEnabled } from "./leads-db.js";
import { cacheEnabled, cacheGet, cacheSet, cacheKeyFor, CACHEABLE_ROUTES, noteCacheOutcome, cacheCounters } from "./cache.js";
import { initAnalyticsDb, recordToolCall, getAnalytics, analyticsEnabled } from "./analytics-db.js";
import { baseNotificationsEnabled } from "./base-notifications.js";
import { initSentry, captureToolError, sentryEnabled } from "./sentry.js";
import { initPostHog, capturePostHogToolError, capturePostHogToolCall, capturePostHogDiscovery, capturePostHogPaywall, capturePostHogPowChallenge, capturePostHogSettlement, capturePostHogChargedFailure, capturePostHogSettleFailed, capturePostHogToolGone, shutdownPostHog, posthogEnabled } from "./posthog.js";
import { analyticsPage } from "./analytics-page.js";
import { operatorPage, operatorLoginPage } from "./operator.js";
import { privacyPage } from "./privacy.js";
import { termsPage } from "./terms.js";
import { transparencyPage } from "./transparency.js";
import { contactPage } from "./contact.js";
import { quickstartPage } from "./quickstart.js";
import { robotsTxt, sitemapXml, llmsTxt, sitemapIndex, sitemapPages, sitemapTools, sitemapGuides, sitemapSkills } from "./seo.js";
import { serviceManifest, reliabilityReport } from "./discovery.js";
import { runSelfCheck } from "./selfcheck.js";
import { acpFeed, acpManifest } from "./acp.js";
import { findTools } from "./find.js";
import { recordWish, getWishesAggregate } from "./wish.js";
import { indexSnapshot, routeQuery, startCrawler, validateOriginInput, registerOrigin } from "./x402-index.js";
import { getLeaderboardSnapshot, startLeaderboardRefresh, leaderboardPage, rankBy } from "./leaderboard.js";
import { buildPaymentMiddleware, enabledNetworks, isIdentityBoundRoute } from "./payments.js";
import { KIT } from "./tools/kit.js";
import { KIT2 } from "./tools/kit2.js";
import { UNIT_CATEGORIES, convertAnyUnit } from "./tools/convert-gen.js";
import { SEARCH_TOOLS } from "./tools/search.js";
import { PDF_TOOLS } from "./tools/pdf-kit.js";
import { DEMAND_TOOLS } from "./tools/demand-kit.js";
import { MEDIA_TOOLS } from "./tools/media-kit.js";
import { GOV_TOOLS } from "./tools/gov-kit.js";
import { GEO_TOOLS } from "./tools/geo-kit.js";
import { OCR_TOOLS } from "./tools/ocr-kit.js";
import { AGENT_TOOLS } from "./tools/agent-kit.js";
import { BARCODE_TOOLS } from "./tools/barcode-kit.js";
import { DATA_TOOLS } from "./tools/data-kit.js";
import { IMAGE_TOOLS } from "./tools/image-kit.js";
import { X402_TOOLS } from "./tools/x402-kit.js";
import { B20_TOOLS } from "./tools/b20-kit.js";
import { UTIL_TOOLS } from "./tools/util-kit.js";
import { API_TOOLS } from "./tools/api-kit.js";
import { MACRO_TOOLS } from "./tools/macro-kit.js";
import { EDGAR_TOOLS } from "./tools/edgar-kit.js";
import { FINANCE_TOOLS } from "./tools/finance-kit.js";
import { CRYPTO_TOOLS } from "./tools/crypto-kit.js";
import { RESEARCH_TOOLS } from "./tools/research-kit.js";
import { NETWORK_TOOLS } from "./tools/network-kit.js";
import { NETWORK_TOOLS2 } from "./tools/network-kit2.js";
import { HTML_TOOLS } from "./tools/html-kit.js";
import { COMPRESSION_TOOLS } from "./tools/compression-kit.js";
import { STATS_TOOLS } from "./tools/stats-kit.js";
import { FORECAST_TOOLS } from "./tools/forecast-kit.js";
import { FINANCE_MATH_TOOLS } from "./tools/finance-math-kit.js";
import { COLOR_TOOLS } from "./tools/color-kit.js";
import { CHAIN_TOOLS } from "./tools/chain-kit.js";
import { CONTRACT_TOOLS } from "./tools/contract-kit.js";
import { ENRICH_TOOLS } from "./tools/enrich-kit.js";
import { WEB_TOOLS } from "./tools/web-kit.js";
import { PRICE_FEED_TOOLS } from "./tools/price-feed-kit.js";
import { DEX_TOOLS } from "./tools/dex-kit.js";
import { PREDICTION_MARKET_TOOLS } from "./tools/prediction-market-kit.js";
import { MEV_AND_L2_TOOLS } from "./tools/mev-and-l2-kit.js";
import { ONCHAIN_IDENTITY_TOOLS } from "./tools/onchain-identity-kit.js";
import { NFT_MARKET_TOOLS } from "./tools/nft-market-kit.js";
import { WEATHER_TOOLS } from "./tools/weather-kit.js";
import { DATE_TIME_TOOLS } from "./tools/date-time-kit.js";
import { TEXT_ANALYSIS_TOOLS } from "./tools/text-analysis-kit.js";
import { VALIDATION_TOOLS } from "./tools/validation-kit.js";
import { ENCODING_TOOLS } from "./tools/encoding-kit.js";
import { MATH_TOOLS } from "./tools/math-kit.js";
import { CRYPTO_HASH_TOOLS } from "./tools/crypto-hash-kit.js";
import { STRING_TOOLS } from "./tools/string-kit.js";
import { CALENDAR_TOOLS } from "./tools/calendar-kit.js";
import { LLM_TOOLS } from "./tools/llm-kit.js";
import { LLM_GATEWAY_TOOLS, modelsList, promptCacheKey, promptCacheGet, GATEWAY_TIER_BY_PATH, embeddingsCacheKey, EMBEDDINGS_PATH, gatewayCreditsStatus } from "./tools/llm-gateway-kit.js";
// /v1/audio/speech stays behind OPENROUTER_TTS_ENABLED as a rollout gate:
// x402 settles before the handler, so a listed-but-broken route charges
// buyers for 502s (no route -> no 402 -> no charge). The upstream WAS
// verified on 2026-07-16 — the dispatchable probe workflow
// (.github/workflows/openrouter-tts-probe.yml) bought real audio from all
// five chain models (see SPEECH_MODELS in llm-gateway-kit.js). Flip the
// Railway var to true after this ships, then run the paid canary — its
// llm-speech leg is the standing proof. If the flag is ever pulled again,
// also pull the canary leg, or every canary run goes red.
const GATEWAY_TOOLS_ENABLED = LLM_GATEWAY_TOOLS.filter(
  (t) => t.slug !== "v1-audio-speech" || process.env.OPENROUTER_TTS_ENABLED === "true"
);
import { IMAGE_GEN_TOOLS } from "./tools/image-gen-kit.js";
import { CODE_RUN_TOOLS } from "./tools/code-run-kit.js";
import { TTS_TOOLS } from "./tools/tts-kit.js";
import { STT_TOOLS } from "./tools/stt-kit.js";
import { EMBED_TOOLS } from "./tools/embed-kit.js";
import { USAGE_TOOLS } from "./tools/usage-kit.js";
import { MODERATE_TOOLS } from "./tools/moderate-kit.js";
import { CDP_TOOLS } from "./tools/cdp-kit.js";
import { toolPage, toolsIndexPage, openapiSpec, toolList, CATEGORIES, faqPage, categoryPage } from "./pages.js";
import { mountMcp } from "./mcp-http.js";
import { guidesIndex, guidePage } from "./guides.js";
import { skillsIndex, skillPackPage, skillPacksJson, SKILL_PACKS, buildPromptMessages } from "./skills.js";
import { docsIndex, docsPage, docsApi } from "./docs.js";
import { shopPage } from "./shop.js";
import { integrationsPage } from "./integrations.js";
import { pricingPage } from "./pricing-page.js";
import { changelogPage, changelogRss } from "./changelog.js";
import { useCasesPage } from "./use-cases.js";
import { playgroundPage } from "./playground.js";
import { apiExplorerPage } from "./api-explorer.js";
import { sdkPlaygroundPage } from "./sdk-playground.js";
import { blogIndex, blogPost, BLOG_POSTS } from "./blog.js";
import { comparePage } from "./compare.js";
import { communityPage } from "./community.js";
import { contributePage } from "./contribute.js";
import { workflowsPage } from "./workflows.js";
import { uptimePage } from "./uptime.js";
import { badgesPage, badgeSvg } from "./badges.js";
import { adapterDocsIndex, adapterDocPage, ADAPTERS } from "./adapter-docs.js";
import { webhooksPage } from "./webhooks.js";
import { setOgImageVersion, setNavIndexProvider } from "./ledger-chrome.js";
import { ledgerHomePage } from "./ledger-home.js";
import { ledgerCatalogPage } from "./ledger-catalog.js";
import { ledgerPricingPage } from "./ledger-pricing.js";
import { revenueSnapshot, revenuePage, stellarRail, stellarActivity, algorandRail, algorandActivity, evmActivity, solanaActivity, robinhoodActivity, baseActivityViaSql } from "./revenue-live.js";
import { stellarPage, stellarSellers } from "./stellar-page.js";
import { algorandPage, algorandSellers } from "./algorand-page.js";
import { CHAIN_PAGES, marketSellers, marketPage, marketPanelHtml } from "./market-page.js";
import { sellPage } from "./sell.js";
import { startRevenueLedger, ledgerSummary } from "./revenue-ledger.js";
import { x402EconomySnapshot } from "./x402-economy.js";
import { recordSale, salesSummary, txFromPaymentResponse } from "./sales-ledger.js";
import { ledgerLeaderboardPage } from "./ledger-leaderboard.js";
import { ledgerDocsPage } from "./ledger-docs.js";
import { ledgerIntegrationsPage } from "./ledger-integrations.js";

const ALL_KIT = [...KIT, ...KIT2, ...SEARCH_TOOLS, ...PDF_TOOLS, ...DEMAND_TOOLS, ...MEDIA_TOOLS, ...GOV_TOOLS, ...GEO_TOOLS, ...OCR_TOOLS, ...AGENT_TOOLS, ...BARCODE_TOOLS, ...DATA_TOOLS, ...IMAGE_TOOLS, ...X402_TOOLS, ...B20_TOOLS, ...UTIL_TOOLS, ...API_TOOLS, ...MACRO_TOOLS, ...EDGAR_TOOLS, ...FINANCE_TOOLS, ...CRYPTO_TOOLS, ...RESEARCH_TOOLS, ...NETWORK_TOOLS, ...NETWORK_TOOLS2, ...HTML_TOOLS, ...COMPRESSION_TOOLS, ...STATS_TOOLS, ...FORECAST_TOOLS, ...FINANCE_MATH_TOOLS, ...COLOR_TOOLS, ...CHAIN_TOOLS, ...CONTRACT_TOOLS, ...ENRICH_TOOLS, ...WEB_TOOLS, ...PRICE_FEED_TOOLS, ...DEX_TOOLS, ...PREDICTION_MARKET_TOOLS, ...MEV_AND_L2_TOOLS, ...ONCHAIN_IDENTITY_TOOLS, ...NFT_MARKET_TOOLS, ...WEATHER_TOOLS, ...DATE_TIME_TOOLS, ...TEXT_ANALYSIS_TOOLS, ...VALIDATION_TOOLS, ...ENCODING_TOOLS, ...MATH_TOOLS, ...CRYPTO_HASH_TOOLS, ...STRING_TOOLS, ...CALENDAR_TOOLS, ...LLM_TOOLS, ...GATEWAY_TOOLS_ENABLED, ...IMAGE_GEN_TOOLS, ...CODE_RUN_TOOLS, ...TTS_TOOLS, ...STT_TOOLS, ...EMBED_TOOLS, ...MODERATE_TOOLS, ...CDP_TOOLS, ...USAGE_TOOLS];
import { buildSkillTools } from "./tools/skill-runner.js";
import { buildRouteExecuteTool } from "./tools/route-execute.js";
import { issueChallenge, verifySolution, isComputePayable, powInfo, POW_DIFFICULTY, WALLET_ONLY_SLUGS, verifyHeartbeatToken } from "./pow.js";
import { createLimiter as createRateLimiter, LIMITS_LABEL as POW_LIMITS_LABEL } from "./rate-limit.js";

// Shared with the MCP free tier (src/mcp-http.js) — same policy, separate
// per-IP bucket. PoW redemption on the direct HTTP path goes through here.
const powHttpLimiter = createRateLimiter("pow-http");
import { recordServedCall, recordChargedFailure, networkFromPaymentResponse, decodeSettleReceipt, getStats, getOperatorBreakdown, dbHealthy, statsPersistent } from "./stats.js";
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";

const PORT = process.env.PORT || 3000;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
// Human-readable Base name for the receiving wallet (resolves to WALLET_ADDRESS).
// Display/branding only — the x402 payTo is always the resolved 0x address.
const WALLET_ENS = process.env.WALLET_ENS || "agent402.base.eth";
const NETWORK = process.env.NETWORK || "base";
const FREE_MODE = process.env.FREE_MODE === "true";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const CATALOG = {
  "POST /api/extract": {
    name: "Extract article",
    slug: "extract",
    category: "web",
    price: "$0.010",
    description:
      "Extract the main article content from any public URL as clean markdown. Returns title, byline, excerpt, word count, and markdown.",
    tags: ["scraping", "markdown", "content-extraction"],
    discovery: {
      bodyType: "json",
      // Self-hosted guide, not example.com/article: example.com serves only its
      // root page, so any made-up path 404s. Our own guide can't go stale.
      input: { url: "https://agent402.tools/guides/x402-in-5-minutes" },
      inputSchema: {
        properties: { url: { type: "string", description: "Public http(s) URL to extract" } },
        required: ["url"],
      },
      output: {
        example: {
          url: "https://agent402.tools/guides/x402-in-5-minutes",
          title: "x402 in 5 minutes",
          byline: null,
          excerpt: "Short summary…",
          wordCount: 850,
          markdown: "# x402 in 5 minutes\n\nBody…",
        },
      },
    },
  },
  "GET /api/meta": {
    name: "Page metadata",
    slug: "meta",
    category: "web",
    price: "$0.002",
    description:
      "Fetch page metadata for a URL: title, description, OpenGraph, Twitter cards, canonical URL, favicon.",
    tags: ["metadata", "opengraph", "seo"],
    discovery: {
      input: { url: "https://example.com" },
      inputSchema: {
        properties: { url: { type: "string", description: "Public http(s) URL" } },
        required: ["url"],
      },
      output: {
        example: {
          url: "https://example.com",
          title: "Example",
          description: "Example site",
          og: { title: "Example" },
          twitter: {},
        },
      },
    },
  },
  "GET /api/dns": {
    name: "DNS lookup",
    slug: "dns",
    category: "network",
    price: "$0.001",
    description: "DNS lookup for a domain. Supported record types: A, AAAA, MX, TXT, NS, CNAME.",
    tags: ["dns", "domains", "networking"],
    discovery: {
      input: { name: "example.com", type: "A" },
      inputSchema: {
        properties: {
          name: { type: "string", description: "Domain name, e.g. example.com" },
          type: { type: "string", description: "Record type (default A)" },
        },
        required: ["name"],
      },
      output: { example: { name: "example.com", type: "A", records: ["93.184.215.14"] } },
    },
  },
  "POST /api/render": {
    name: "Browser render",
    slug: "render",
    category: "web",
    price: "$0.02",
    description:
      "Render a page in a real headless Chromium browser (JavaScript executed), then extract the main content as clean markdown. Use this for SPAs and JS-heavy sites where plain fetching returns an empty shell.",
    tags: ["browser", "javascript", "spa", "scraping", "markdown"],
    discovery: {
      bodyType: "json",
      input: { url: "https://example.com/spa-page" },
      inputSchema: {
        properties: { url: { type: "string", description: "Public http(s) URL to render" } },
        required: ["url"],
      },
      output: {
        example: { url: "https://example.com/spa-page", title: "Page title", wordCount: 500, markdown: "…", rendered: true },
      },
    },
  },
  "GET /api/screenshot": {
    name: "Screenshot",
    slug: "screenshot",
    category: "web",
    price: "$0.015",
    description:
      "Screenshot any public URL in headless Chromium. Returns a PNG image. Query params: ?url=https://…&fullPage=true (optional).",
    tags: ["browser", "screenshot", "png", "visual"],
    mimeType: "image/png",
    discovery: {
      input: { url: "https://example.com", fullPage: "false" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "Public http(s) URL to screenshot" },
          fullPage: { type: "string", description: "true for full-page capture (default false)" },
        },
        required: ["url"],
      },
      output: { example: { contentType: "image/png", body: "(binary PNG image)" } },
    },
  },
  "POST /api/pdf": {
    name: "PDF to text",
    slug: "pdf",
    category: "web",
    price: "$0.01",
    description:
      "Fetch a PDF from a URL and extract its text content. Returns page count, document info, and the full text (up to 20MB PDFs).",
    tags: ["pdf", "documents", "text-extraction"],
    discovery: {
      bodyType: "json",
      // A real, famously stable whitepaper URL — example.com/whitepaper.pdf 404s.
      input: { url: "https://bitcoin.org/bitcoin.pdf" },
      inputSchema: {
        properties: { url: { type: "string", description: "Public http(s) URL of a PDF" } },
        required: ["url"],
      },
      output: {
        example: { url: "https://bitcoin.org/bitcoin.pdf", pages: 9, info: { title: null }, wordCount: 3604, text: "Bitcoin: A Peer-to-Peer Electronic Cash System\n…" },
      },
    },
  },
  "POST /api/memory": {
    name: "Memory write",
    slug: "memory-write",
    category: "memory",
    price: "$0.002",
    description:
      "Persistent key-value memory for agents, scoped to the paying wallet. Your x402 payment IS your authentication: the wallet that pays owns the namespace. No signup, no API keys. Body: {\"key\":\"…\",\"value\":any JSON,\"ttlSeconds\":3600?} to write (optional TTL), or {\"key\":\"…\",\"delete\":true} to remove. Add \"owner\":\"0x…\" to write into another wallet's namespace you've been granted. Values up to 64KB.",
    tags: ["memory", "storage", "state", "key-value", "persistence", "ttl"],
    discovery: {
      bodyType: "json",
      input: { key: "research/task-42", value: { status: "done", findings: ["…"] }, ttlSeconds: 86400 },
      inputSchema: {
        properties: {
          key: { type: "string", description: "Key to write (max 256 chars)" },
          value: { description: "Any JSON value (max 64KB serialized)" },
          ttlSeconds: { type: "number", description: "Optional: auto-expire the key after N seconds" },
          owner: { type: "string", description: "Optional 0x namespace to write into (requires a readwrite grant)" },
          delete: { type: "boolean", description: "Set true to delete the key instead" },
        },
        required: ["key"],
      },
      output: { example: { key: "research/task-42", bytes: 42, updated: 1760000000000, expiresAt: 1760086400, owner: "0x…", persistent: true } },
    },
  },
  "GET /api/memory": {
    name: "Memory read",
    slug: "memory-read",
    category: "memory",
    price: "$0.001",
    description:
      "Read from a wallet-scoped namespace. ?key=… returns the stored value; omit key to list keys. Reads your own namespace by default; add ?owner=0x… to read a namespace you've been granted access to.",
    tags: ["memory", "storage", "state", "key-value"],
    discovery: {
      // List mode ({} = no key), not a hardcoded key read: memory is
      // wallet-keyed, so a specific key correctly 404s for any wallet that
      // hasn't written it. Listing keys answers 200 for every wallet,
      // including a brand-new (empty) namespace.
      input: {},
      inputSchema: {
        properties: {
          key: { type: "string", description: "Key to read; omit to list all keys" },
          owner: { type: "string", description: "Optional 0x namespace to read (requires a grant)" },
        },
      },
      output: { example: { keys: [{ k: "research/task-42", updated: 1760000000000, exp: null }], owner: "0x…", persistent: true } },
    },
  },
  "POST /api/memory/incr": {
    name: "Memory counter",
    slug: "memory-incr",
    category: "memory",
    price: "$0.001",
    description:
      "Atomically increment (or decrement) a numeric key and return the new value — a coordination primitive for counters, locks, and rate budgets shared across agents. Creates the key at 0 if absent.",
    tags: ["memory", "counter", "atomic", "coordination", "lock"],
    discovery: {
      bodyType: "json",
      input: { key: "jobs/processed", by: 1 },
      inputSchema: {
        properties: {
          key: { type: "string", description: "Counter key" },
          by: { type: "number", description: "Amount to add (default 1; negative to decrement)" },
          owner: { type: "string", description: "Optional 0x namespace (requires a readwrite grant)" },
        },
        required: ["key"],
      },
      output: { example: { key: "jobs/processed", value: 43, owner: "0x…" } },
    },
  },
  "POST /api/memory/cas": {
    name: "Memory compare-and-set",
    slug: "memory-cas",
    category: "memory",
    price: "$0.001",
    description:
      "Atomically write (or release) a key only if its current value equals `expected` — the coordination primitive for distributed locks and optimistic concurrency across agents. Acquire a lock: expected=null + a value + ttlSeconds. Release it: expected=<your token> with no value (deletes on match). Update safely: expected=<old>, value=<new>. Returns whether it swapped and the current value.",
    tags: ["memory", "cas", "compare-and-set", "lock", "coordination", "atomic"],
    discovery: {
      bodyType: "json",
      input: { key: "locks/import", expected: null, value: "agent-7", ttlSeconds: 30 },
      inputSchema: {
        properties: {
          key: { type: "string", description: "Key to conditionally write" },
          expected: { description: "Required current value to match (null or omitted = key absent/expired)" },
          value: { description: "New value to set on match; omit to DELETE on match (lock release)" },
          ttlSeconds: { type: "number", description: "Optional TTL for the written value (lease for locks)" },
          owner: { type: "string", description: "Optional 0x namespace (requires a readwrite grant)" },
        },
        required: ["key"],
      },
      output: { example: { key: "locks/import", swapped: true, value: "agent-7", owner: "0x…", expiresAt: 1760086430 } },
    },
  },
  "POST /api/memory/grant": {
    name: "Memory grant",
    slug: "memory-grant",
    category: "memory",
    price: "$0.002",
    description:
      "Share your namespace with another wallet so different agents can coordinate through it. Grant read or readwrite access to a grantee wallet, optionally with a TTL. This is the cross-agent sharing a single agent cannot provide for itself.",
    tags: ["memory", "grant", "sharing", "coordination", "multi-agent", "acl"],
    discovery: {
      bodyType: "json",
      input: { grantee: "0x1111111111111111111111111111111111111111", mode: "readwrite", ttlSeconds: 86400 },
      inputSchema: {
        properties: {
          grantee: { type: "string", description: "0x wallet to grant access to" },
          mode: { type: "string", description: '"read" or "readwrite"' },
          ttlSeconds: { type: "number", description: "Optional: auto-expire the grant" },
        },
        required: ["grantee", "mode"],
      },
      output: { example: { owner: "0x…", grantee: "0x1111…", mode: "readwrite", expiresAt: 1760086400 } },
    },
  },
  "POST /api/memory/revoke": {
    name: "Memory revoke",
    slug: "memory-revoke",
    category: "memory",
    price: "$0.001",
    description: "Revoke a previously granted wallet's access to your namespace.",
    tags: ["memory", "revoke", "sharing", "acl"],
    discovery: {
      bodyType: "json",
      input: { grantee: "0x1111111111111111111111111111111111111111" },
      inputSchema: {
        properties: { grantee: { type: "string", description: "0x wallet to revoke" } },
        required: ["grantee"],
      },
      output: { example: { owner: "0x…", grantee: "0x1111…", revoked: true } },
    },
  },
  "GET /api/memory/grants": {
    name: "Memory grants list",
    slug: "memory-grants",
    category: "memory",
    price: "$0.001",
    description: "List the wallets you've granted access to your namespace, with their mode and expiry.",
    tags: ["memory", "grants", "sharing", "acl"],
    discovery: {
      input: {},
      inputSchema: { properties: {} },
      output: { example: { owner: "0x…", grants: [{ grantee: "0x1111…", mode: "read", active: true }] } },
    },
  },
  "GET /api/memory/log": {
    name: "Memory audit log",
    slug: "memory-log",
    category: "memory",
    price: "$0.001",
    description:
      "Tamper-evident history of every change to a namespace — an append-only, hash-chained audit log the server attests to (provenance an agent can't forge for itself). ?owner=0x… reads a granted namespace.",
    tags: ["memory", "audit", "provenance", "history", "verifiable"],
    discovery: {
      input: { limit: "50" },
      inputSchema: {
        properties: {
          limit: { type: "string", description: "Max entries (1-1000, default 100)" },
          owner: { type: "string", description: "Optional 0x namespace (requires a grant)" },
        },
      },
      output: { example: { ns: "0x…", entries: [{ seq: 1, action: "put", key: "task-42", hash: "…", prevHash: "" }] } },
    },
  },
  "POST /api/memory/remember": {
    name: "Memory remember",
    slug: "memory-remember",
    category: "memory",
    price: "$0.003",
    description:
      "Store a piece of text for later similarity recall — a per-wallet semantic index an agent cannot host in-session. Returns an id. Pair with /api/memory/recall to retrieve by meaning, not exact key.",
    tags: ["memory", "semantic", "embeddings", "recall", "vector"],
    discovery: {
      bodyType: "json",
      input: { text: "The deploy failed because the Railway build ran out of memory.", meta: { topic: "ops" } },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to remember (max 8KB)" },
          meta: { description: "Optional JSON metadata stored alongside" },
          owner: { type: "string", description: "Optional 0x namespace (requires a readwrite grant)" },
        },
        required: ["text"],
      },
      output: { example: { id: "abc123", owner: "0x…", stored: true } },
    },
  },
  "POST /api/memory/recall": {
    name: "Memory recall",
    slug: "memory-recall",
    category: "memory",
    price: "$0.002",
    description:
      "Recall remembered text by similarity to a query (ranked by cosine similarity), not by exact key. Returns the top-k matches with scores. The retrieval half of the wallet-scoped semantic memory.",
    tags: ["memory", "semantic", "search", "recall", "vector", "similarity"],
    discovery: {
      bodyType: "json",
      input: { query: "why did the deployment break", k: 3 },
      inputSchema: {
        properties: {
          query: { type: "string", description: "Natural-language query" },
          k: { type: "number", description: "How many matches (1-50, default 5)" },
          owner: { type: "string", description: "Optional 0x namespace (requires a grant)" },
        },
        required: ["query"],
      },
      output: { example: { query: "why did the deployment break", results: [{ id: "abc123", score: 0.62, text: "The deploy failed because…" }] } },
    },
  },
  "POST /api/memory/forget": {
    name: "Memory forget",
    slug: "memory-forget",
    category: "memory",
    price: "$0.001",
    description: "Delete a remembered document by id from the recall store.",
    tags: ["memory", "semantic", "delete"],
    discovery: {
      bodyType: "json",
      input: { id: "abc123" },
      inputSchema: { properties: { id: { type: "string", description: "Document id from /remember" } }, required: ["id"] },
      output: { example: { id: "abc123", deleted: true, owner: "0x…" } },
    },
  },
};

// The full tool kit (~1060 tools: kit + kit2 + generated conversions) joins the
// catalog; same paywall, same discovery.
for (const tool of ALL_KIT) {
  if (CATALOG[tool.route]) throw new Error(`Duplicate route in kit: ${tool.route}`);
  CATALOG[tool.route] = tool;
}

// Version the default OG card URL by tool count so social crawlers re-fetch
// the card image when the catalog changes instead of serving a stale cache.
setOgImageVersion(Object.keys(CATALOG).length);

// Skill packs as paid bundled-execution endpoints. Built AFTER ALL_KIT
// finishes populating CATALOG so each skill handler can resolve underlying
// tool handlers at call time via the live CATALOG. The inline handlers map
// covers routes that are bound inline in this file (extract/meta/dns/render/
// pdf) rather than declared in a kit — the runner tries this map first.
const SKILL_INLINE_HANDLERS = {
  // extract retries once on timeout/5xx (page fetches are flaky under load);
  // 422 (content not parseable) fails immediately — retry won't help there.
  extract: async ({ url } = {}) => {
    try { return await extractArticle(url); }
    catch (e) { if (e.statusCode === 422 || e.statusCode === 400) throw e; return await extractArticle(url); }
  },
  meta:    async ({ url } = {}) => fetchPageMeta(url),
  dns:     async ({ name, type } = {}) => dnsLookup(name, type),
  render:  async ({ url } = {}) => renderArticle(url),
  pdf:     async ({ url } = {}) => pdfToText(url),
};
const SKILL_TOOLS = buildSkillTools({
  getCatalog: () => CATALOG,
  inlineHandlers: SKILL_INLINE_HANDLERS,
});
for (const tool of SKILL_TOOLS) {
  if (CATALOG[tool.route]) throw new Error(`Duplicate route in skill set: ${tool.route}`);
  CATALOG[tool.route] = tool;
  ALL_KIT.push(tool); // so the route-binding loop below picks them up too
}

// Route-and-execute: the SOR's executing surface (internal dispatch v1).
// Registered after the skill tools so its runtime catalog getter sees them.
const ROUTE_EXECUTE_TOOL = buildRouteExecuteTool({ getCatalog: () => CATALOG, baseUrl: BASE_URL });
if (CATALOG[ROUTE_EXECUTE_TOOL.route]) throw new Error(`Duplicate route: ${ROUTE_EXECUTE_TOOL.route}`);
CATALOG[ROUTE_EXECUTE_TOOL.route] = ROUTE_EXECUTE_TOOL;
ALL_KIT.push(ROUTE_EXECUTE_TOOL);

// Security audit A402-03: the wallet-scoped memory family and the wallet-keyed
// my-usage report derive the caller's identity from the SIGNED EVM
// authorization (payerFromRequest, EVM-only). Advertising a non-EVM rail on
// them would let a buyer settle on Solana/Stellar/Algorand and THEN hit an
// identity error — a charged failure. Flag them here, in one place over the
// fully-assembled catalog, so the paywall offers EVM rails only for these
// routes. Every other tool is untouched and keeps all configured chains.
for (const def of Object.values(CATALOG)) {
  if (isIdentityBoundRoute(def)) def.identityBound = true;
}

// Boot-time guard: the retired pairwise-converter 410 handler (see the
// RETIRED_CONVERT_API_RE block below) owns both /api/convert-…-to-… and
// /api/convert/…-to-… — a future catalog tool on either shape would be
// silently shadowed by it, so fail the boot instead.
for (const route of Object.keys(CATALOG)) {
  if (/^(POST|GET) \/api\/convert[-/][a-z0-9-]+-to-[a-z0-9-]+$/.test(route)) {
    throw new Error(`Catalog route "${route}" matches the retired convert-*-to-* pattern and would be shadowed by the 410 handler`);
  }
}

// Routes that accept proof-of-work in lieu of payment: the pure-CPU tools.
// Map "METHOD /path" -> tool slug, for the gate and the challenge endpoint.
// slug -> numeric USD price, for revenue estimation in /api/stats.
const TOOL_PRICES = Object.fromEntries(
  Object.values(CATALOG).map((d) => [d.slug, parseFloat(String(d.price).replace(/[^0-9.]/g, "")) || 0])
);
const POW_ROUTES = new Map();
const POW_SLUGS = new Set();
for (const [route, def] of Object.entries(CATALOG)) {
  if (isComputePayable(def)) {
    POW_ROUTES.set(route, def.slug);
    POW_SLUGS.add(def.slug);
  }
}

const app = express();
// Drop the Express fingerprint header (security audit A402-13): no reason to
// advertise the stack to every caller.
app.disable("x-powered-by");
// Behind Railway's single edge proxy: trust exactly that hop so req.ip is the
// real client IP (the X-Forwarded-For entry the edge appends), not an
// attacker-supplied XFF value. This is what the per-IP rate limiters key on,
// so spoofing it must not mint a fresh bucket. Tune for other topologies.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS) || 1);

// PostHog reverse proxy: serve posthog-js AND ingest its events first-party
// through agent402.tools/e, so the browser never talks to a third-party host.
// This is what lets the cookieless client snippet (see ledger-chrome's head)
// dodge ad-blockers and keep CSP at 'self' — no third-party script/connect hosts.
// Two fixed upstreams (posthog only, so no SSRF): /e/static/* is the JS lib
// (assets host), everything else is the ingestion host. Raw body is piped
// through untouched; mounted before compression/json so it owns its response.
const PH_ASSETS_HOST = "https://us-assets.i.posthog.com";
const PH_INGEST_HOST = "https://us.i.posthog.com";
app.all(/^\/e\/(.*)$/, express.raw({ type: () => true, limit: "2mb" }), async (req, res) => {
  try {
    const sub = req.params[0] || "";
    const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    const upstream = `${sub.startsWith("static/") ? PH_ASSETS_HOST : PH_INGEST_HOST}/${sub}${qs}`;
    const headers = {};
    for (const h of ["content-type", "accept"]) if (req.headers[h]) headers[h] = req.headers[h];
    const init = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD" && req.body?.length) init.body = req.body;
    const up = await fetch(upstream, init);
    res.status(up.status);
    for (const h of ["content-type", "cache-control"]) { const v = up.headers.get(h); if (v) res.setHeader(h, v); }
    res.end(Buffer.from(await up.arrayBuffer())); // undici already decompressed; forward as-is
  } catch {
    res.status(502).end();
  }
});
// gzip/deflate every response EXCEPT: (1) /v1/* and /mcp — the LLM gateway's
// streaming tiers pipe SSE straight to the socket after settlement
// (`{__sse}` sentinel in the route binder), and buffering those chunks to
// compress them would break streaming and could stall a paid response. This
// is a hard safety rule, not a perf tweak. (2) responses already served as
// raw binary via the route binder's `{__binary, contentType}` sentinel
// (images, audio) — those bytes are already compressed formats, so gzipping
// them again just burns CPU for no size win; the default `compression`
// filter already skips non-text content-types, this is belt-and-braces.
// Everything else — HTML pages (the 475KB-and-growing /index chief among
// them) and JSON APIs — compresses.
app.use(compression({
  filter: (req, res) => {
    if (req.path.startsWith("/v1") || req.path.startsWith("/mcp")) return false;
    const contentType = res.getHeader("Content-Type");
    if (typeof contentType === "string" && /^(image|audio|video)\//.test(contentType)) return false;
    return compression.filter(req, res);
  },
}));
app.use(express.json({ limit: "100kb" }));

// Funnel stage 1 — discovery. An agent fetching any of these machine-readable
// surfaces is the top of the buyer journey (it learned the catalog exists and
// how to pay). Captured on response finish so only successfully served
// discovery counts; env-gated no-op like all PostHog capture. The MCP
// connector's search_tools/find_tool land here too (wired in mcp-http.js).
const DISCOVERY_SURFACES = new Map([
  ["/llms.txt", "llms.txt"],
  ["/openapi.json", "openapi.json"],
  ["/.well-known/x402", "x402-manifest"],
  ["/api/pricing", "pricing"],
  ["/api/find", "find"],
  ["/api/index", "index"],
  ["/api/route", "route"],
]);
app.use((req, res, next) => {
  const surface = DISCOVERY_SURFACES.get(req.path);
  if (surface) {
    res.on("finish", () => {
      if (res.statusCode < 400) capturePostHogDiscovery({ surface, synthetic: isSyntheticRequest(req) });
    });
  }
  next();
});

// Per-request id — useful for grepping logs when a buyer or operator forwards
// a failing response. Honored from upstream (load balancer) if present and
// well-formed; otherwise generated.
app.use((req, res, next) => {
  const incoming = req.header("x-request-id");
  const rid = (typeof incoming === "string" && /^[A-Za-z0-9_.\-]{6,128}$/.test(incoming))
    ? incoming
    : randomUUID();
  req.requestId = rid;
  res.setHeader("X-Request-Id", rid);
  next();
});

// Baseline security headers on every response. A loose CSP covers the HTML
// landing/operator/leaderboard pages — they use inline styles + one inline
// script, no remote scripts, no eval. Anything stricter would break existing
// pages without changing risk meaningfully.
// Redirect the Railway-generated hostname to the canonical custom domain.
// The old hostname created a duplicate listing on agentic.market / Bazaar.
if (BASE_URL.includes("agent402.tools")) {
  app.use((req, res, next) => {
    const host = req.hostname || req.headers.host?.split(":")[0] || "";
    if (host.endsWith(".up.railway.app")) {
      return res.redirect(301, `${BASE_URL}${req.originalUrl}`);
    }
    next();
  });
}

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  // Disable browser features we never use — defense-in-depth against any future
  // XSS or third-party script accidentally probing for them.
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
  );
  next();
});

// Free, unauthenticated routes
// Sets browser/CDN cache headers for static-ish HTML pages so clicking around
// the top nav doesn't re-render the world every time. stale-while-revalidate
// gives instant back/forward while a background refresh keeps content fresh.
const htmlCache = (res, maxAge, swr) =>
  res.set("Cache-Control", `public, max-age=${maxAge}, stale-while-revalidate=${swr}`).type("html");
app.get("/", (_req, res) => {
  // By-chain strip cell counts: real seller counts from the same index
  // snapshot every /<chain> market page renders — never hardcoded. Iterates
  // CHAIN_PAGES so a new chain page lights up the strip with zero edits
  // here; a missing count (crawl failure) just leaves that key out — the
  // strip renders its dimmed "unavailable" state, never a zero.
  const chainSellerCounts = {};
  try {
    const snapshot = getIndexSnapshot();
    for (const key of Object.keys(CHAIN_PAGES)) {
      try { chainSellerCounts[key] = marketSellers(key, snapshot).length; } catch { /* strip cell renders without the count */ }
    }
  } catch { /* snapshot unavailable — strip renders rail-only cells */ }
  htmlCache(res, 60, 300).send(
    ledgerHomePage(BASE_URL, CATALOG, getStats({ wallet: WALLET_ADDRESS, walletName: WALLET_ENS, network: NETWORK, toolCount: Object.keys(CATALOG).length, baseUrl: BASE_URL, prices: TOOL_PRICES }), getLeaderboardSnapshot(), SKILL_PACKS, { chainSellerCounts })
  );
});
// /marketplaces — legacy surface, merged into /marketplace (301 keeps SEO equity).
app.get("/marketplaces", (_req, res) => res.redirect(301, "/marketplace"));
// Real health check — fails (503) when a load balancer or heartbeat should
// route around this instance. Verifies the stats DB is readable and that the
// payment configuration is intact (wallet present unless we're explicitly in
// FREE_MODE). Kept O(1) so a flood of probes can't degrade the service.
app.get("/health", (req, res) => {
  const checks = {
    db: dbHealthy(),
    wallet: FREE_MODE || Boolean(WALLET_ADDRESS),
  };
  const ok = checks.db && checks.wallet;
  // Public `meta` carries ONLY toolCount — it's already published on
  // /api/pricing, /openapi.json, and /api/stats, and sync-count.js reads it
  // here. Process uptime (restart-timing recon) and freeMode (operating mode)
  // are operator-only diagnostics (audit R-15), added to the authenticated
  // response below.
  const meta = { toolCount: Object.keys(CATALOG).length };
  // The sensitive disclosure is the enabled-integration flags (which upstreams
  // are wired, whether the operator token is configured), the health checks,
  // and now uptime/freeMode — that internal wiring is returned ONLY to an
  // authenticated operator (audit A402-11 / R-15). Monitoring (Railway
  // healthcheck, heartbeat.yml) needs just the 200 + ok. operatorTokenOk /
  // getOperatorToken are module consts defined below; this handler runs at
  // request time, after they init.
  if (!operatorTokenOk(getOperatorToken(req))) {
    return res.status(ok ? 200 : 503).json({ ok, meta });
  }
  const diagnostics = { uptime: Math.floor(process.uptime()), freeMode: FREE_MODE };
  // Non-fatal flags — surface tollbooth-leads wiring so we can verify the
  // Railway DATABASE_URL / AGENT402_OPERATOR_TOKEN env without poking either.
  // These don't affect overall ok status; the tollbooth waitlist is optional.
  const flags = {
    leadsDb: leadsDbReady,
    operatorToken: Boolean(OPERATOR_TOKEN),
    sentry: sentryEnabled(),
    posthog: posthogEnabled(),
    // True only when BOTH relay env vars are set — matches finance-kit's gate
    // (src/tools/finance-kit.js). Either unset = direct-to-Yahoo, which is
    // currently null-routed by Railway egress and causes ETIMEDOUT canaries.
    yahooRelay: Boolean((process.env.YAHOO_RELAY_URL || "").trim()) && Boolean((process.env.YAHOO_RELAY_TOKEN || "").trim()),
    nasdaqRelay: Boolean((process.env.NASDAQ_RELAY_URL || "").trim()) && Boolean((process.env.NASDAQ_RELAY_TOKEN || "").trim()),
    // True when the stats SQLite DB is on the /data volume (counters + the
    // recentCalls ring buffer survive restarts). False = silent fallback to
    // /tmp, which wipes the activity feed on every container restart and
    // makes traffic look thinner than it is. CI auto-attaches /data, but
    // surfacing this here means a misconfigured deploy can't hide.
    statsPersistent,
    // True when the memory tools' SQLite DB is on /data. Memory is the worst
    // case for a silent fallback because agents PAY USDC per write — the
    // value of that storage is its durability. Boot fails loud in prod if
    // /data is missing, but this flag lets an operator verify externally
    // before pointing buyers at /api/memory*.
    memoryPersistent,
    builderCode: Boolean((process.env.BASE_BUILDER_CODE || "").trim()),
    solana: Boolean((process.env.SOLANA_WALLET_ADDRESS || "").trim()),
    // OpenAI-compatible LLM gateway upstream (OpenRouter). False = the three
    // /v1/*chat/completions routes 503 at call time.
    llmGateway: Boolean((process.env.OPENROUTER_API_KEY || "").trim()),
    baseNotifications: baseNotificationsEnabled(),
  };
  res.status(ok ? 200 : 503).json({ ok, checks, flags, meta: { ...meta, ...diagnostics } });
});
// Security disclosure contact (RFC 9116, security audit A402-13). Expires is
// computed ~1 year out on each request so the file is never stale. Contact
// override via SECURITY_CONTACT_EMAIL; defaults to the maintainer address.
app.get("/.well-known/security.txt", (_req, res) => {
  const contact = (process.env.SECURITY_CONTACT_EMAIL || "").trim() || "mike@agent402.tools";
  const expires = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  const body = [
    `Contact: mailto:${contact}`,
    `Expires: ${expires}`,
    "Preferred-Languages: en",
    `Canonical: ${BASE_URL}/.well-known/security.txt`,
    `Policy: ${BASE_URL}/terms`,
    "",
  ].join("\n");
  res.type("text/plain").set("Cache-Control", "public, max-age=3600").send(body);
});
// Glama connector ownership verification: claims our listing at
// glama.ai/mcp/connectors/io.github.MikeyPetrillo/agent402. The maintainer email
// must match the Glama account. Defaults to the project's domain-scoped
// maintainer address; GLAMA_MAINTAINER_EMAIL env override exists for forks.
// OpenAI-compatible model discovery for the x402 LLM gateway — free, like
// every other machine-readable surface: an SDK pointed at base_url /v1 lists
// models before it ever pays.
app.get("/v1/models", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300").json(modelsList());
});
// Bucketed gateway-credits status ("ok"/"low"/"unknown"/"unconfigured") — the
// heartbeat alarms on "low" BEFORE an empty OpenRouter balance turns paid /v1
// calls into charged-but-failed 503s. Numbers never leave the server; the
// 5-minute in-module cache makes this safe to expose unpaywalled.
app.get("/api/gateway-status", async (_req, res) => {
  res.set("Cache-Control", "public, max-age=60").json(await gatewayCreditsStatus());
});
app.get("/.well-known/glama.json", (_req, res) => {
  const email = process.env.GLAMA_MAINTAINER_EMAIL || "mike@agent402.tools";
  res.set("Cache-Control", "public, max-age=86400").json({
    $schema: "https://glama.ai/mcp/schemas/connector.json",
    maintainers: [{ email }],
  });
});
app.get("/privacy", (_req, res) => htmlCache(res, 300, 900).send(privacyPage(BASE_URL)));
app.get("/terms", (_req, res) => htmlCache(res, 300, 900).send(termsPage(BASE_URL)));
app.get("/transparency", (_req, res) => htmlCache(res, 300, 900).send(transparencyPage(BASE_URL)));
app.get("/contact", (_req, res) => htmlCache(res, 300, 900).send(contactPage(BASE_URL)));
app.get("/quickstart", (_req, res) => htmlCache(res, 300, 900).send(quickstartPage(BASE_URL)));
app.get("/faq", (_req, res) => htmlCache(res, 300, 900).send(faqPage(BASE_URL)));
app.get("/integrations", (_req, res) => htmlCache(res, 300, 900).send(ledgerIntegrationsPage(BASE_URL)));
app.get("/pricing", (_req, res) => htmlCache(res, 300, 900).send(ledgerPricingPage(BASE_URL, CATALOG)));
// Live consolidated revenue view — every rail's wallet on one page instead
// of one explorer tab per chain. Server-side reads with a 60s module cache;
// individual rail failures degrade to "unavailable" without a 500.
const revenueWallets = () => ({ walletAddress: WALLET_ADDRESS, solanaWallet: (process.env.SOLANA_WALLET_ADDRESS || "").trim() || null, stellarWallet: (process.env.STELLAR_WALLET_ADDRESS || "").trim() || null, algorandWallet: (process.env.ALGORAND_WALLET_ADDRESS || "").trim() || null });
app.get("/api/revenue", async (_req, res) => {
  try {
    const snap = await revenueSnapshot(revenueWallets());
    res.set("Cache-Control", "public, max-age=30").json({ ...snap, allTime: ledgerSummary(revenueWallets()), sales: salesSummary() });
  } catch (e) {
    res.status(500).json({ error: "revenue snapshot failed", detail: String(e?.message || e).slice(0, 120) });
  }
});
app.get("/revenue", async (_req, res) => {
  try {
    const snap = await revenueSnapshot(revenueWallets());
    res.set("Cache-Control", "public, max-age=30").type("html").send(revenuePage(BASE_URL, { ...snap, allTime: ledgerSummary(revenueWallets()), sales: salesSummary() }));
  } catch (e) {
    res.status(500).type("html").send('<p>Revenue view temporarily unavailable. <a href="/">Home</a></p>');
  }
});
// Sales ledger — what external wallets actually buy, by name. Free and
// public like /api/stats: payer wallets are already public in the settle
// txs; slugs and counts are the merchant transparency this catalog sells on.
app.get("/api/sales", (_req, res) => {
  try {
    res.set("Cache-Control", "public, max-age=60").json(salesSummary());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// x402 Economy Observatory — chain-wide settlement analytics (30-min cache
// inside the snapshot; per-query error resilience; env-gated on CDP keys).
app.get("/api/x402-economy", async (_req, res) => {
  try {
    res.set("Cache-Control", "public, max-age=300").json(await x402EconomySnapshot());
  } catch (e) {
    res.status(500).json({ error: "economy snapshot failed", detail: String(e?.message || e).slice(0, 120) });
  }
});
// The standalone Observatory page folded into the marketplace's "The economy,
// over time" section (id="economy") - little standalone traffic, and the daily
// history + week-over-week trend now sit next to the rest of the ecosystem
// dashboard. Permanent redirect straight to /marketplace (never chain through
// the /index 301 - a redirect Location must not point at another redirect);
// /api/x402-economy (above) is unchanged for machine consumers.
app.get("/x402-economy", (_req, res) => {
  res.redirect(301, "/marketplace#economy");
});
app.get("/changelog", (_req, res) => htmlCache(res, 300, 900).send(changelogPage(BASE_URL)));
app.get("/use-cases", (_req, res) => htmlCache(res, 300, 900).send(useCasesPage(BASE_URL)));
app.get("/playground", (_req, res) => htmlCache(res, 300, 900).send(playgroundPage(BASE_URL, CATALOG)));
app.get("/sdk-playground", (_req, res) => htmlCache(res, 300, 900).send(sdkPlaygroundPage(BASE_URL)));
app.get("/docs/api/explorer", (_req, res) => htmlCache(res, 300, 900).send(apiExplorerPage(BASE_URL)));
app.get("/blog", (_req, res) => htmlCache(res, 300, 900).send(blogIndex(BASE_URL)));
app.get("/blog/:slug", (req, res) => { const html = blogPost(BASE_URL, req.params.slug); if (!html) return res.status(404).type("html").send('<p>Post not found. <a href="/blog">All posts</a></p>'); htmlCache(res, 300, 900).send(html); });
app.get("/compare", (_req, res) => htmlCache(res, 300, 900).send(comparePage(BASE_URL)));
app.get("/community", (_req, res) => htmlCache(res, 300, 900).send(communityPage(BASE_URL)));
app.get("/contribute", (_req, res) => htmlCache(res, 300, 900).send(contributePage(BASE_URL)));
app.get("/workflows", (_req, res) => htmlCache(res, 300, 900).send(workflowsPage(BASE_URL)));
app.get("/uptime", (_req, res) => htmlCache(res, 300, 900).send(uptimePage(BASE_URL)));
app.get("/badges", (_req, res) => htmlCache(res, 300, 900).send(badgesPage(BASE_URL)));
app.get("/badges/:style.svg", (req, res) => { const svg = badgeSvg(req.params.style); if (!svg) return res.status(404).json({ error: "unknown badge style" }); res.setHeader("Cache-Control", "public, max-age=3600").type("image/svg+xml").send(svg); });
app.get("/docs/adapters", (_req, res) => htmlCache(res, 300, 900).send(adapterDocsIndex(BASE_URL)));
app.get("/docs/webhooks", (_req, res) => htmlCache(res, 300, 900).send(webhooksPage(BASE_URL)));
app.get("/docs/adapters/:slug", (req, res) => { const html = adapterDocPage(BASE_URL, req.params.slug); if (!html) return res.status(404).type("html").send('<p>Adapter not found. <a href="/docs/adapters">All adapters</a></p>'); htmlCache(res, 300, 900).send(html); });
app.get("/changelog.xml", (_req, res) => { res.setHeader("Cache-Control", "public, max-age=600"); res.type("application/rss+xml").send(changelogRss(BASE_URL)); });
app.get("/sitemapindex.xml", (_req, res) => { res.setHeader("Cache-Control", "public, max-age=3600"); res.type("application/xml").send(sitemapIndex(BASE_URL)); });
app.get("/sitemap-pages.xml", (_req, res) => { res.setHeader("Cache-Control", "public, max-age=3600"); res.type("application/xml").send(sitemapPages(BASE_URL, CATALOG)); });
app.get("/sitemap-tools.xml", (_req, res) => { res.setHeader("Cache-Control", "public, max-age=3600"); res.type("application/xml").send(sitemapTools(BASE_URL, CATALOG)); });
app.get("/sitemap-guides.xml", (_req, res) => { res.setHeader("Cache-Control", "public, max-age=3600"); res.type("application/xml").send(sitemapGuides(BASE_URL)); });
app.get("/sitemap-skills.xml", (_req, res) => { res.setHeader("Cache-Control", "public, max-age=3600"); res.type("application/xml").send(sitemapSkills(BASE_URL)); });
app.get("/status", (_req, res) =>
  htmlCache(res, 60, 300).send(
    statusPage(BASE_URL, getStats({ wallet: WALLET_ADDRESS, walletName: WALLET_ENS, network: NETWORK, toolCount: Object.keys(CATALOG).length, baseUrl: BASE_URL, prices: TOOL_PRICES }))
  )
);
app.get("/tollbooth", (_req, res) => htmlCache(res, 300, 900).send(tollboothLandingPage(BASE_URL)));
app.get("/tollbooth/cloud", (_req, res) => htmlCache(res, 300, 900).send(tollboothCloudPage(BASE_URL)));
app.get("/tollbooth/waitlist", (req, res) => {
  const plan = String(req.query.plan || "team").toLowerCase();
  const kind = String(req.query.kind || "waitlist").toLowerCase();
  htmlCache(res, 300, 900).send(tollboothWaitlistPage(BASE_URL, { plan, kind }));
});

// Tollbooth waitlist intake. Form on /tollbooth/waitlist POSTs JSON here; we
// validate, light rate-limit by IP, drop honeypot hits, and persist into
// Postgres (DATABASE_URL). If the DB isn't configured the endpoint returns
// 503 and the form falls back to its GitHub pre-fill flow.
const ALLOWED_PLANS = new Set(["solo", "team", "agency", "enterprise", "partner"]);
const ALLOWED_KINDS = new Set(["waitlist", "enterprise", "partner"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const waitlistHits = new Map(); // ip -> [timestamps]
const WAITLIST_LIMIT = 5; // per IP per window
const WAITLIST_WINDOW_MS = 60_000;
function waitlistRateOk(ip) {
  const now = Date.now();
  const arr = (waitlistHits.get(ip) || []).filter((t) => now - t < WAITLIST_WINDOW_MS);
  if (arr.length >= WAITLIST_LIMIT) {
    waitlistHits.set(ip, arr);
    return false;
  }
  arr.push(now);
  waitlistHits.set(ip, arr);
  return true;
}
app.post("/api/tollbooth/waitlist", async (req, res) => {
  if (!leadsDbEnabled()) {
    return res.status(503).json({ ok: false, error: "leads-db-unavailable" });
  }
  // Use Express's req.ip (honors `trust proxy`, line 470) so the bucket keys
  // on the real client IP. Reading X-Forwarded-For directly + splitting on
  // commas would return the attacker-supplied left-most value, letting a
  // single source mint unlimited fresh buckets and bypass the rate limit.
  const ip = req.ip || "unknown";
  if (!waitlistRateOk(ip)) {
    return res.status(429).json({ ok: false, error: "rate-limited" });
  }
  const b = req.body || {};
  // Honeypot: real form leaves `website` empty; bots fill every field.
  if (typeof b.website === "string" && b.website.length > 0) {
    return res.json({ ok: true, id: 0 });
  }
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const email = typeof b.email === "string" ? b.email.trim() : "";
  if (!name || !email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: "name+email required" });
  }
  const plan = ALLOWED_PLANS.has(String(b.plan || "").toLowerCase()) ? String(b.plan).toLowerCase() : "team";
  const kind = ALLOWED_KINDS.has(String(b.kind || "").toLowerCase()) ? String(b.kind).toLowerCase() : "waitlist";
  const r = await insertLead({
    kind, plan, name, email,
    org: typeof b.org === "string" ? b.org.trim() : "",
    sites: typeof b.sites === "string" ? b.sites.trim() : "",
    message: typeof b.message === "string" ? b.message.trim() : "",
    ip,
    ua: (req.get("user-agent") || "").toString(),
  });
  if (!r.ok) return res.status(500).json({ ok: false, error: "insert-failed" });
  res.json({ ok: true, id: r.id });
});

// Operator dashboard — full per-tool usage + recent calls feed, gated by
// AGENT402_OPERATOR_TOKEN. Off unless the env var is set. Timing-safe compare
// (constant-time byte equality) so token presence/length isn't probeable.
//
// Auth is via a header (Authorization: Bearer / X-Operator-Token — for curl and
// API), or a Secure + HttpOnly + SameSite=Strict session cookie set by the
// POST /__operator/login form below. The token is NEVER read from the query
// string (security audit A402-07): a ?token= in a URL leaks into access logs,
// browser history, and Referer headers. The login form takes the token in a
// POST body (never a URL) and exchanges it for the cookie, so the secret never
// appears in a logged URL.
const OPERATOR_TOKEN = process.env.AGENT402_OPERATOR_TOKEN || "";
const OPERATOR_COOKIE = "a402_op";
const operatorTokenOk = (t) => {
  if (!OPERATOR_TOKEN || typeof t !== "string") return false;
  const a = Buffer.from(t);
  const b = Buffer.from(OPERATOR_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};
// Minimal cookie reader (no cookie-parser dependency): pull one named cookie
// out of the raw Cookie header.
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (typeof raw !== "string") return "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return ""; }
    }
  }
  return "";
}
const getOperatorToken = (req) => {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  const hdr = req.headers["x-operator-token"];
  if (typeof hdr === "string") return hdr;
  return readCookie(req, OPERATOR_COOKIE);
};
const reqIsHttps = (req) =>
  req.secure || (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
// Operator session bootstrap. GET serves a minimal paste-the-token form; POST
// validates the token from the BODY (never a URL) and sets the session cookie.
// Scoped to /__operator, HttpOnly (no JS/XSS read), SameSite=Strict (no CSRF),
// Secure on HTTPS, and an 8h absolute expiry.
app.get("/__operator/login", (_req, res) => {
  res.type("html").send(operatorLoginPage(BASE_URL));
});
app.post("/__operator/login", (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (!operatorTokenOk(token)) return res.status(401).json({ ok: false, error: "invalid token" });
  const attrs = `Path=/__operator; HttpOnly; SameSite=Strict; Max-Age=${8 * 3600}${reqIsHttps(req) ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", `${OPERATOR_COOKIE}=${encodeURIComponent(token)}; ${attrs}`);
  res.json({ ok: true });
});
app.get("/__operator/logout", (req, res) => {
  const attrs = `Path=/__operator; HttpOnly; SameSite=Strict; Max-Age=0${reqIsHttps(req) ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", `${OPERATOR_COOKIE}=; ${attrs}`);
  res.redirect("/__operator/login");
});
app.get("/__operator", (req, res) => {
  if (!operatorTokenOk(getOperatorToken(req))) return res.status(404).type("html").send("<p>Not found.</p>");
  res.type("html").send(operatorPage(BASE_URL, getOperatorBreakdown({ prices: TOOL_PRICES, walletOnlySet: WALLET_ONLY_SLUGS })));
});
app.get("/__operator/stats", (req, res) => {
  if (!operatorTokenOk(getOperatorToken(req))) return res.status(404).json({ error: "Not found" });
  res.json(getOperatorBreakdown({ prices: TOOL_PRICES, walletOnlySet: WALLET_ONLY_SLUGS }));
});
app.get("/__operator/wishes", (req, res) => {
  if (!operatorTokenOk(getOperatorToken(req))) return res.status(404).type("html").send("<p>Not found.</p>");
  res.type("html").send(operatorWishesPage(BASE_URL, getWishesAggregate({ limit: 500 })));
});
app.get("/__operator/leads", async (req, res) => {
  if (!operatorTokenOk(getOperatorToken(req))) return res.status(404).type("html").send("<p>Not found.</p>");
  const list = await listLeads({ limit: 200 });
  const stats = await countLeads();
  res.type("html").send(operatorLeadsPage({
    ok: list.ok,
    rows: list.rows,
    total: stats.total,
    byPlan: stats.byPlan,
    dbEnabled: leadsDbEnabled(),
  }));
});
app.get("/guides", (_req, res) => htmlCache(res, 300, 900).send(guidesIndex(BASE_URL)));
app.get("/guides/:slug", (req, res) => {
  const html = guidePage(BASE_URL, req.params.slug);
  if (!html) return res.status(404).type("html").send('<p>Guide not found. <a href="/guides">All guides</a></p>');
  htmlCache(res, 300, 900).send(html);
});
// /skills — curated multi-tool workflows. Index + per-pack detail pages, both
// server-rendered from SKILL_PACKS in src/skills.js. The detail page looks each
// tool slug up in the live CATALOG so prices/descriptions stay accurate.
app.get("/skills", (_req, res) => htmlCache(res, 300, 900).send(skillsIndex(BASE_URL)));
app.get("/skills/:slug", (req, res) => {
  const html = skillPackPage(BASE_URL, req.params.slug, CATALOG);
  if (!html) return res.status(404).type("html").send('<p>Skill pack not found. <a href="/skills">All skill packs</a></p>');
  htmlCache(res, 300, 900).send(html);
});
// Machine-readable skill packs — the canonical source for the `agent402-mcp`
// npm package's prompts surface (and any future discovery aggregator). The
// stdio package fetches this at boot to register its prompts/list response.
// `/api/skill-packs/:slug/prompt` renders the same MCP messages the hosted
// /mcp returns, accepting query args matching the pack's promptArgs.
app.get("/api/skill-packs.json", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300, s-maxage=900");
  res.json(skillPacksJson());
});
app.get("/api/skill-packs/:slug/prompt", (req, res) => {
  const pack = SKILL_PACKS.find((p) => p.slug === req.params.slug);
  if (!pack) return res.status(404).json({ error: `Unknown skill pack "${req.params.slug}". List: /api/skill-packs.json` });
  // Pull args from the query string by promptArgs name. Anything not
  // declared is ignored (no surprise substitutions). Compute freeSlugs from
  // the live catalog so the access split in the rendered prompt is honest.
  const args = {};
  for (const a of pack.promptArgs || []) {
    if (req.query[a.name] != null && req.query[a.name] !== "") args[a.name] = String(req.query[a.name]);
  }
  const freeSlugs = new Set(Object.values(CATALOG).filter((def) => isComputePayable(def)).map((def) => def.slug));
  res.set("Cache-Control", "public, max-age=60");
  res.json(buildPromptMessages(pack, args, { freeSlugs }));
});
// /docs hub — server-rendered from wiki/*.md (the same source of truth that
// syncs to the GitHub wiki via CI). /docs/api is registered *before* the
// parameterized /docs/:slug so the literal "api" path doesn't get captured
// as a wiki slug lookup.
app.get("/docs", (_req, res) => htmlCache(res, 300, 900).send(ledgerDocsPage(BASE_URL, CATALOG)));
app.get("/docs/api", (_req, res) => htmlCache(res, 300, 900).send(docsApi(BASE_URL, Object.values(CATALOG))));
app.get("/docs/:slug", (req, res) => {
  const html = docsPage(BASE_URL, req.params.slug);
  if (!html) return res.status(404).type("html").send('<p>Doc not found. <a href="/docs">All docs</a></p>');
  htmlCache(res, 300, 900).send(html);
});
// Top-level machine-readable service manifest — one fetch tells a discovery
// agent the whole story (identity, payment options, capability map, MCP, trust),
// so this seller is the one selected. Per-resource terms still live in each
// 402 + the x402 Bazaar; this is the index that ties them together. Built once:
// it depends only on boot-time constants (catalog, prices, networks, wallet).
const MANIFEST = serviceManifest({
  baseUrl: BASE_URL, network: NETWORK, networks: enabledNetworks(NETWORK),
  wallet: WALLET_ADDRESS, walletName: WALLET_ENS, catalog: CATALOG,
  toolCount: Object.keys(CATALOG).length, powSlugs: POW_SLUGS,
  powDifficulty: POW_DIFFICULTY, prices: TOOL_PRICES,
});
// Shared helper: builds a small 24h performance signal from the analytics
// table (cache hit rate, error rate, p50/p95 latency, dashboard URL). Used by
// /api/stats and /.well-known/x402 so a discovery agent fetching either one
// sees the same liveness signal a human sees on /analytics. Returns null when
// analytics is disabled or the query fails — callers omit the field entirely.
// Never blocks the response. Returns the last cached perf snapshot
// synchronously; if it's stale, fires a background refresh so the NEXT caller
// sees fresh data. First-ever caller gets null (perf signal just omitted) —
// the alternative is making /api/stats wait on Postgres, which under
// concurrent load on the home-page activity poller starved the event loop
// and made every page take 30s.
const PERF_CACHE_MS = 30_000;
let perfCache = { at: 0, value: null };
let perfRefreshing = false;
function refreshPerf24hInBackground() {
  if (perfRefreshing || !analyticsEnabled()) return;
  perfRefreshing = true;
  (async () => {
    try {
      const a = await getAnalytics({ windowHours: 24, top: 1 });
      if (a && a.ok && a.totals && a.totals.calls) {
        const t = a.totals;
        perfCache = {
          at: Date.now(),
          value: {
            windowHours: 24,
            calls: t.calls,
            cacheHitRate: +((t.cached / t.calls) || 0).toFixed(4),
            errorRate: +((t.errored / t.calls) || 0).toFixed(4),
            p50LatencyMs: t.p50_latency_ms,
            p95LatencyMs: t.p95_latency_ms,
            dashboardUrl: `${BASE_URL}/analytics`,
          },
        };
      } else {
        // Cache the "no data" verdict too so we don't keep retrying within the
        // freshness window when analytics is wired but empty.
        perfCache = { at: Date.now(), value: null };
      }
    } catch (_e) {
      perfCache = { at: Date.now(), value: null };
    } finally {
      perfRefreshing = false;
    }
  })();
}
function getPerformance24h() {
  if (!analyticsEnabled()) return null;
  if (Date.now() - perfCache.at >= PERF_CACHE_MS) refreshPerf24hInBackground();
  return perfCache.value;
}
// /.well-known/x402 — discovery agents fetch this once to learn the seller.
// Most of the manifest is boot-time constants (catalog, networks, wallet) so
// MANIFEST is built once; we only enrich with the live performance24h block
// on each request when analytics is enabled. Failing-open: if the analytics
// query stalls, we serve the static manifest instead of blocking the call.
app.get("/.well-known/x402", (_req, res) => {
  const perf = getPerformance24h();
  if (perf) res.json({ ...MANIFEST, performance24h: perf });
  else res.json(MANIFEST);
});
// Structured reliability / trust report — the "safe to depend on" surface, each
// claim paired with a URL to verify it independently.
app.get("/api/reliability", (_req, res) =>
  res.json(reliabilityReport({
    baseUrl: BASE_URL, network: NETWORK, wallet: WALLET_ADDRESS,
    stats: getStats({ wallet: WALLET_ADDRESS, walletName: WALLET_ENS, network: NETWORK, toolCount: Object.keys(CATALOG).length, baseUrl: BASE_URL, prices: TOOL_PRICES }),
  }))
);
// Synthetic self-check — runs a curated set of high-value tools' own examples
// live (see src/selfcheck.js) so a paid tool that breaks in prod is caught even
// with zero organic traffic. Cached 5 min + single-flighted so repeated polls
// (and any abuse) can't hammer the upstreams; the tool-alert.yml Action polls
// this and opens an issue on failure, mirroring the heartbeat. Free/unpaywalled.
const SELFCHECK_TTL_MS = 5 * 60 * 1000;
let selfCheckCache = { at: 0, value: null };
let selfCheckInFlight = null;
app.get("/api/selfcheck", async (_req, res) => {
  if (selfCheckCache.value && Date.now() - selfCheckCache.at < SELFCHECK_TTL_MS) {
    return res.json({ ...selfCheckCache.value, cached: true });
  }
  if (!selfCheckInFlight) {
    selfCheckInFlight = runSelfCheck(CATALOG)
      .then((v) => { selfCheckCache = { at: Date.now(), value: v }; return v; })
      .finally(() => { selfCheckInFlight = null; });
  }
  try {
    res.json({ ...(await selfCheckInFlight), cached: false });
  } catch {
    res.status(500).json({ ok: false, error: "selfcheck failed to run" });
  }
});
// Stripe Agentic Commerce Protocol (ACP) — lets AI agents on Stripe's payment
// rails discover and browse our tool catalog. Free, unpaywalled discovery surface.
app.get("/acp/feed", (_req, res) =>
  res.set("Cache-Control", "public, max-age=3600").json(acpFeed({ baseUrl: BASE_URL, catalog: CATALOG, powSlugs: POW_SLUGS }))
);
app.get("/acp/manifest", (_req, res) =>
  res.set("Cache-Control", "public, max-age=3600").json(acpManifest({
    baseUrl: BASE_URL, network: NETWORK, networks: enabledNetworks(NETWORK),
    wallet: WALLET_ADDRESS, toolCount: Object.keys(CATALOG).length, powDifficulty: POW_DIFFICULTY,
  }))
);

// One-call tool resolver (free): an agent sends a task description and gets the
// best-matching tools with route, price, input schema, and a ready example — so
// it can call directly instead of burning tokens "exploring" to find a tool.
// Deterministic lexical ranking; not in CATALOG, so it stays free + unpaywalled.
//
// /api/find and /api/route share a cache wrapper (CACHEABLE_ROUTES policy in
// cache.js, 60s TTL) and write through to analytics under the synthetic slug
// "_find" / "_route" so the dashboard counts discovery calls alongside tools.
// These endpoints are the most-hit routes in the whole server — every agent
// touches them on the first call of a session — so even a 60s window
// meaningfully cuts CPU on repeat queries.
// A "weak" match (empty results, or a top score below this) means the
// catalog probably doesn't have what the caller wanted. That's the signal
// the wish loop exists to capture: log it as a find-miss (rate-limit exempt,
// fire-and-forget) and tell the caller how to say what they actually needed.
// Threshold sits below a single tag hit (score 3) or slug-substring hit
// (score 4) — a real single-term match to a relevant tool should NOT be
// treated as a miss.
const FIND_WEAK_SCORE = 5;
const computeFind = (q, k) => {
  const result = findTools(CATALOG, q, { k, baseUrl: BASE_URL, powSlugs: POW_SLUGS });
  const topScore = result.results[0]?.score ?? 0;
  if (result.count === 0 || topScore < FIND_WEAK_SCORE) {
    result.hint = "POST /api/wish with what you needed";
    const qStr = String(q ?? "").trim();
    if (qStr) {
      try { recordWish({ need: qStr, source: "find-miss" }); } catch { /* best-effort; never break /api/find */ }
    }
  }
  return result;
};
const findCachePath = "/api/find";
const findCachePolicy = CACHEABLE_ROUTES[findCachePath];

// Diagnostic log for tool errors. Lets us spot patterns like "100% of /api/whois
// calls fail in 1ms" without leaking PII — only slug + HTTP status + the error
// message we already serialize to the response body. No body, no IP, no UA.
// 4xx = caller sent bad input; 5xx = our tool or its upstream broke.
function logToolError(slug, status, message, shape, synthetic, probe) {
  const klass = status >= 500 ? "5xx" : status >= 400 ? "4xx" : "err";
  // Probe 4xx = an empty-input scanner sweeping the catalog and every tool
  // correctly rejecting it — expected behavior, not an error. An indexer sweep
  // of the full catalog (1,432 entries at the time) emitted 1,432 [err] lines
  // in ~10s (2026-07-13), tripping Railway's 500 logs/sec cap and DROPPING
  // real log lines. Skip the console
  // line for those (PostHog still captures the probe-tagged event for
  // dashboards); probe 5xx still logs — a server bug is our bug no matter who
  // triggered it.
  const skipConsole = probe && status < 500;
  // Log the request's TOP-LEVEL KEYS (no values, no IPs, no payment info) on
  // 4xx so we can spot shape-mismatch patterns the schema didn't anticipate.
  // Keys are bounded — privacy-safe and small.
  const shapeStr = shape && Array.isArray(shape) && shape.length ? ` shape=[${shape.slice(0, 12).join(",")}]` : "";
  const synthStr = synthetic ? " synthetic=true" : "";
  const probeStr = probe ? " probe=true" : "";
  if (!skipConsole) console.error(`[tool-error] ${klass} slug=${slug} status=${status}${shapeStr}${synthStr}${probeStr} msg=${String(message || "").slice(0, 200)}`);
  // Sentry mirrors the same data as searchable tags so we can query/trend
  // rejected shapes from the Sentry UI. No-op when SENTRY_DSN is unset.
  captureToolError({ slug, status, message, shape, synthetic });
  // PostHog mirrors the same payload as a "tool_error" event with slug/
  // status/errorClass/shape properties. Same privacy posture, same no-op
  // behavior when POSTHOG_API_KEY is unset. Independent of Sentry — either,
  // both, or neither can be enabled at any time.
  capturePostHogToolError({ slug, status, message, shape, synthetic, probe });
}
// True iff this request carries a valid HMAC-signed X-Heartbeat-Token (POW_SECRET).
// Unspoofable: an external caller cannot mint a valid token without POW_SECRET.
// Used to mark trusted internal traffic (CI canaries, heartbeat probes, operator
// smoke tests) so the public dashboard can exclude it from real error rates.
function isSyntheticRequest(req) {
  try { return !!(req && verifyHeartbeatToken(req.header("x-heartbeat-token"))); }
  catch { return false; }
}
function requestShape(req) {
  // Return the top-level keys of body + query, deduped and bounded. Values
  // are never read — this is purely "what fields did the caller send", which
  // is the diagnostic signal we need to fix schema mismatches without
  // logging anything sensitive.
  try {
    const keys = new Set();
    if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
      for (const k of Object.keys(req.body).slice(0, 20)) keys.add(`b:${k}`);
    }
    if (req.query && typeof req.query === "object") {
      for (const k of Object.keys(req.query).slice(0, 20)) keys.add(`q:${k}`);
    }
    return [...keys];
  } catch { return []; }
}
async function serveCachedDiscovery(path, policy, input, computeFn, analyticsSlug, req, res) {
  const startedAt = Date.now();
  const synthetic = isSyntheticRequest(req);
  let cached = false;
  let errored = false;
  let status = 200;
  try {
    let cacheKey = null;
    if (policy && cacheEnabled()) {
      cacheKey = cacheKeyFor(path, input, policy.keyFields || []);
      const hit = await cacheGet(cacheKey);
      if (hit !== null) {
        cached = true;
        noteCacheOutcome("hit");
        res.setHeader("X-Cache", "hit");
        return res.json(hit);
      }
    }
    const result = computeFn();
    if (policy) {
      noteCacheOutcome(cacheKey ? "miss" : "skip");
      res.setHeader("X-Cache", cacheKey ? "miss" : "skip");
    }
    if (cacheKey && result && typeof result === "object" && !result.error) {
      cacheSet(cacheKey, result, policy.ttl || 60).catch(() => {});
    }
    res.json(result);
  } catch (err) {
    errored = true;
    status = err.statusCode || 500;
    logToolError(analyticsSlug, status, err.message, undefined, synthetic);
    res.status(status).json({ error: err.message });
  } finally {
    const latencyMs = Date.now() - startedAt;
    recordToolCall({ slug: analyticsSlug, latencyMs, cached, errored, status, synthetic }).catch(() => {});
    capturePostHogToolCall({ slug: analyticsSlug, latencyMs, cached, errored, status, synthetic });
  }
}
app.get("/api/find", (req, res) => {
  const q = req.query.q ?? req.query.task ?? req.query.query;
  const k = req.query.k;
  return serveCachedDiscovery(findCachePath, findCachePolicy, { q, task: q, query: q, k }, () => computeFind(q, k), "_find", req, res);
});
app.post("/api/find", (req, res) => {
  const q = req.body?.q ?? req.body?.task ?? req.body?.query;
  const k = req.body?.k;
  return serveCachedDiscovery(findCachePath, findCachePolicy, { q, task: q, query: q, k }, () => computeFind(q, k), "_find", req, res);
});

// Agent wish loop: free, pre-paywall, like /api/find. When an agent needs a
// tool we don't have, this captures that demand instead of losing it
// silently. Explicit wishes (this endpoint + the MCP request_tool tool) are
// rate-limited
// (10/IP/hour, 100/day global — see wish.js); implicit find-misses recorded
// from /api/find and the MCP find_tool path are exempt. Never touches
// CATALOG/WALLET_ONLY_SLUGS — same free-surface category as /api/index/register.
app.post("/api/wish", (req, res) => {
  try {
    const { need, context } = req.body || {};
    const result = recordWish({ need, context, source: "api", ip: req.ip || "?" });
    res.json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message });
  }
});
// Aggregate view: normalized clusters only (no raw context, no IPs) — a
// future scheduled workflow polls this to open an issue once a cluster
// crosses WISH_THRESHOLD (server never calls the GitHub API itself).
app.get("/api/wishes", (req, res) => {
  res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
  res.json(getWishesAggregate({ limit: req.query?.limit }));
});

// x402 Index — public dashboard + Smart Order Router. Free, like /api/find: a
// discovery layer that exists to make the agent payments economy legible. The
// Router (cross-seller routing) and the Index page share the same crawler-warmed
// cache. Crawler boots after listen() — never blocks startup on third parties.
const indexCtx = () => ({
  baseUrl: BASE_URL,
  catalog: CATALOG,
  prices: TOOL_PRICES,
  network: NETWORK,
  toolCount: Object.keys(CATALOG).length,
  walletName: WALLET_ENS,
});
// Snapshot memo. indexSnapshot iterates the full CATALOG (500 endpoints) and the
// crawler's seller cache; building it costs hundreds of ms and was being done
// on every request. Cache for 30s with a sync read + background refresh so the
// hot path is a property lookup. Crawler refreshes still propagate within 30s.
const INDEX_SNAPSHOT_TTL_MS = 30_000;
let indexSnapshotCache = { at: 0, value: null };
let indexSnapshotRefreshing = false;
function refreshIndexSnapshotInBackground() {
  if (indexSnapshotRefreshing) return;
  indexSnapshotRefreshing = true;
  // setImmediate so the current request returns before we recompute.
  setImmediate(() => {
    try {
      indexSnapshotCache = { at: Date.now(), value: indexSnapshot(indexCtx()) };
    } catch (e) {
      // Don't poison the cache on a transient error — leave the prior value.
    } finally {
      indexSnapshotRefreshing = false;
    }
  });
}
function getIndexSnapshot() {
  if (!indexSnapshotCache.value) {
    // Cold start — block once so the first response isn't empty.
    indexSnapshotCache = { at: Date.now(), value: indexSnapshot(indexCtx()) };
    return indexSnapshotCache.value;
  }
  if (Date.now() - indexSnapshotCache.at >= INDEX_SNAPSHOT_TTL_MS) {
    refreshIndexSnapshotInBackground();
  }
  return indexSnapshotCache.value;
}
// Wire the nav/footer "by chain" dropdown + column to live data — cheap (the
// memoized snapshot above, no network at render) and defensive: nav() itself
// try/catches the provider, but each chain gets its own guard here too so one
// chain's failure never blanks the row next to it (honesty rule: that row
// reads "unavailable", never a fabricated zero).
setNavIndexProvider(() => {
  const snapshot = getIndexSnapshot();
  const chain = (label, href, chainKey) => {
    try {
      return { label, href, sellers: marketSellers(chainKey, snapshot).length, healthy: true };
    } catch {
      return { label, href, sellers: null, healthy: false };
    }
  };
  // Iterates CHAIN_PAGES so a third chain page joins the nav/footer strip
  // with zero server.js edits — add the entry in market-page.js and it
  // appears here automatically.
  return {
    chains: Object.keys(CHAIN_PAGES).map((key) => chain(key, `/${key}`, key)),
  };
});
// /index — legacy surface, merged into /marketplace (301 keeps SEO equity).
app.get("/index", (_req, res) => res.redirect(301, "/marketplace"));
// /stellar's receipt strip reuses stellarRail with the same 60s cache
// discipline the /revenue page applies — a public page must not turn every
// request into Horizon fetches (rate-limits shared with the revenue ledger).
const STELLAR_RAIL_TTL_MS = 60_000;
let stellarRailCache = { at: 0, value: null };
let stellarRailInFlight = null;
async function getStellarRailCached() {
  if (Date.now() - stellarRailCache.at < STELLAR_RAIL_TTL_MS) return stellarRailCache.value;
  if (!stellarRailInFlight) {
    stellarRailInFlight = (async () => {
      try {
        const r = await stellarRail((process.env.STELLAR_WALLET_ADDRESS || "").trim());
        stellarRailCache = { at: Date.now(), value: r && !r.error ? r : null };
      } catch {
        stellarRailCache = { at: Date.now(), value: null };
      } finally {
        stellarRailInFlight = null;
      }
    })();
  }
  await stellarRailInFlight;
  return stellarRailCache.value;
}
// 30-day activity scan (Transactions/Volume/Buyers cards) — pages Horizon
// harder than the receipt strip, so a longer 10-min cache, keyed per wallet:
// /stellar?seller=<host> switches the scan to that seller's advertised
// Stellar payTo. Wallets only ever come from the index snapshot (strkey-
// validated there AND re-checked here) — never from user input, so the
// selector can't be used to make Horizon fetch arbitrary paths. The map is
// bounded by the known-seller count; a failed scan caches null and the
// section renders its honest "unavailable" line rather than zeros.
const STELLAR_ACTIVITY_TTL_MS = 10 * 60_000;
const STELLAR_STRKEY_RE = /^G[A-Z2-7]{55}$/;
const stellarActivityByWallet = new Map(); // wallet -> { at, value, inFlight }
async function getStellarActivityFor(wallet) {
  if (!wallet || !STELLAR_STRKEY_RE.test(wallet)) return null;
  if (stellarActivityByWallet.size > 500) stellarActivityByWallet.clear(); // safety sweep
  let entry = stellarActivityByWallet.get(wallet);
  if (entry && !entry.inFlight && Date.now() - entry.at < STELLAR_ACTIVITY_TTL_MS) return entry.value;
  if (!entry || !entry.inFlight) {
    entry = entry || { at: 0, value: null, inFlight: null };
    stellarActivityByWallet.set(wallet, entry);
    entry.inFlight = (async () => {
      try {
        const a = await stellarActivity(wallet);
        entry.at = Date.now();
        entry.value = a && !a.error ? a : null;
      } catch {
        entry.at = Date.now();
        entry.value = null;
      } finally {
        entry.inFlight = null;
      }
    })();
  }
  await entry.inFlight;
  return entry.value;
}
// The Stellar x402 marketplace — the index snapshot filtered to the Stellar
// rail, plus live settlement receipts. stellarRail is best-effort (6s Horizon
// timeouts internally); a flake renders the honest "unavailable" line.
app.get("/stellar", async (req, res) => {
  try {
    const snapshot = getIndexSnapshot();
    const sellers = stellarSellers(snapshot);
    const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
    const q = String(req.query.seller || "").toLowerCase().slice(0, 253);
    const picked = (q && sellers.find((s) => !s.local && hostOf(s.homepage || s.origin) === q)) || sellers.find((s) => s.local) || null;
    const selfWallet = (process.env.STELLAR_WALLET_ADDRESS || "").trim();
    const wallet = picked && !picked.local ? picked.stellarWallet : selfWallet;
    const [rail, activity] = await Promise.all([getStellarRailCached(), getStellarActivityFor(wallet)]);
    const selectedSeller = picked
      ? { local: !!picked.local, host: picked.local ? null : hostOf(picked.homepage || picked.origin), name: picked.displayName || null }
      : null;
    htmlCache(res, 120, 600).send(stellarPage(BASE_URL, { snapshot, rail, activity, selectedSeller, stellarWallet: selfWallet || undefined }));
  } catch (e) {
    res.status(500).type("text/plain").send("temporarily unavailable");
  }
});
// /algorand's receipt strip reuses algorandRail with the same 60s cache
// discipline /stellar applies — a public page must not turn every request
// into indexer/algod fetches.
const ALGORAND_RAIL_TTL_MS = 60_000;
let algorandRailCache = { at: 0, value: null };
let algorandRailInFlight = null;
async function getAlgorandRailCached() {
  if (Date.now() - algorandRailCache.at < ALGORAND_RAIL_TTL_MS) return algorandRailCache.value;
  if (!algorandRailInFlight) {
    algorandRailInFlight = (async () => {
      try {
        const r = await algorandRail((process.env.ALGORAND_WALLET_ADDRESS || "").trim());
        algorandRailCache = { at: Date.now(), value: r && !r.error ? r : null };
      } catch {
        algorandRailCache = { at: Date.now(), value: null };
      } finally {
        algorandRailInFlight = null;
      }
    })();
  }
  await algorandRailInFlight;
  return algorandRailCache.value;
}
// 30-day activity scan (Transactions/Volume/Buyers cards) — pages the
// indexer harder than the receipt strip, so a longer 10-min cache, keyed per
// wallet: /algorand?seller=<host> switches the scan to that seller's
// advertised Algorand payTo. Wallets only ever come from the index snapshot
// (strkey-validated there AND re-checked here) — never from user input, so
// the selector can't be used to make the indexer fetch arbitrary paths. The
// map is bounded by the known-seller count; a failed scan caches null and
// the section renders its honest "unavailable" line rather than zeros.
const ALGORAND_ACTIVITY_TTL_MS = 10 * 60_000;
const ALGORAND_STRKEY_RE = /^[A-Z2-7]{58}$/;
const algorandActivityByWallet = new Map(); // wallet -> { at, value, inFlight }
async function getAlgorandActivityFor(wallet) {
  if (!wallet || !ALGORAND_STRKEY_RE.test(wallet)) return null;
  if (algorandActivityByWallet.size > 500) algorandActivityByWallet.clear(); // safety sweep
  let entry = algorandActivityByWallet.get(wallet);
  if (entry && !entry.inFlight && Date.now() - entry.at < ALGORAND_ACTIVITY_TTL_MS) return entry.value;
  if (!entry || !entry.inFlight) {
    entry = entry || { at: 0, value: null, inFlight: null };
    algorandActivityByWallet.set(wallet, entry);
    entry.inFlight = (async () => {
      try {
        const a = await algorandActivity(wallet);
        entry.at = Date.now();
        entry.value = a && !a.error ? a : null;
      } catch {
        entry.at = Date.now();
        entry.value = null;
      } finally {
        entry.inFlight = null;
      }
    })();
  }
  await entry.inFlight;
  return entry.value;
}
// The Algorand x402 marketplace — the index snapshot filtered to the
// Algorand rail, plus live settlement receipts. algorandRail is best-effort
// (6s timeouts internally); a flake renders the honest "unavailable" line.
app.get("/algorand", async (req, res) => {
  try {
    const snapshot = getIndexSnapshot();
    const sellers = algorandSellers(snapshot);
    const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
    const q = String(req.query.seller || "").toLowerCase().slice(0, 253);
    const picked = (q && sellers.find((s) => !s.local && hostOf(s.homepage || s.origin) === q)) || sellers.find((s) => s.local) || null;
    const selfWallet = (process.env.ALGORAND_WALLET_ADDRESS || "").trim();
    const wallet = picked && !picked.local ? picked.algorandWallet : selfWallet;
    const [rail, activity] = await Promise.all([getAlgorandRailCached(), getAlgorandActivityFor(wallet)]);
    const selectedSeller = picked
      ? { local: !!picked.local, host: picked.local ? null : hostOf(picked.homepage || picked.origin), name: picked.displayName || null }
      : null;
    htmlCache(res, 120, 600).send(algorandPage(BASE_URL, { snapshot, rail, activity, selectedSeller, algorandWallet: selfWallet || undefined }));
  } catch (e) {
    res.status(500).type("text/plain").send("temporarily unavailable");
  }
});
// 30-day activity scan (Transactions/Volume/Buyers cards) for the five
// snapshot-backed market pages — mirrors getStellarActivityFor/
// getAlgorandActivityFor EXACTLY in shape (10-min TTL, in-flight dedup,
// address-shape validated, 500-entry size-capped sweep), one deviation: on a
// failed refresh this keeps serving the LAST GOOD value instead of nulling
// it out (these scanners lean on third-party APIs — Alchemy/Blockscout —
// that are flakier than Horizon/AlgoNode, so a single bad refresh shouldn't
// blank out charts that were fine 10 minutes ago). A wallet that has never
// scanned successfully still reads null → the template's honest
// "unavailable" line. No `?seller=` switching for these five chains yet —
// the index snapshot carries no per-seller EVM/Solana payTo extraction (only
// Stellar/Algorand do), so scope stays THIS HOST only; do not invent
// external-seller wallets here.
const CHAIN_ACTIVITY_TTL_MS = 10 * 60_000;
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const chainActivityByWallet = new Map(); // "chainKey:wallet" -> { at, value, inFlight }
function walletShapeOkForChain(chainKey, wallet) {
  if (!wallet) return false;
  return chainKey === "solana" ? SOLANA_ADDR_RE.test(wallet) : EVM_ADDR_RE.test(wallet);
}
// One activity scan for a chain+wallet. Base uses CDP SQL (one server-side
// aggregation query, no 10k scan cap, ~0.5s) and falls back to the RPC transfer
// scan on ANY error (no CDP creds, rejected query, timeout) so the panel never
// breaks. Other chains use their existing scanners.
async function scanActivity(chainKey, wallet) {
  if (chainKey === "solana") return solanaActivity(wallet);
  if (chainKey === "robinhood") return robinhoodActivity(wallet);
  if (chainKey === "base") {
    const viaSql = await baseActivityViaSql(wallet).catch(() => null);
    if (viaSql && !viaSql.error) return viaSql; // exact + fast
    return evmActivity("base", wallet);          // fail-safe fallback
  }
  return evmActivity(chainKey, wallet);
}

// Stale-while-revalidate: a warm wallet returns instantly (even once past the
// TTL) and refreshes in the background, so switching sellers never blocks on a
// scan. Only the first-ever load of a wallet awaits — and on Base that's the
// ~0.5s CDP SQL query, not a 10-page RPC walk. Concurrent cold calls share one
// in-flight scan.
async function getActivityForChain(chainKey, wallet) {
  if (!walletShapeOkForChain(chainKey, wallet)) return null;
  const key = `${chainKey}:${wallet}`;
  if (chainActivityByWallet.size > 500) chainActivityByWallet.clear(); // safety sweep
  let entry = chainActivityByWallet.get(key);
  if (!entry) { entry = { at: 0, value: null, inFlight: null }; chainActivityByWallet.set(key, entry); }
  const stale = Date.now() - entry.at >= CHAIN_ACTIVITY_TTL_MS;
  if (stale && !entry.inFlight) {
    entry.inFlight = (async () => {
      try {
        const a = await scanActivity(chainKey, wallet);
        entry.at = Date.now();
        if (a && !a.error) entry.value = a; // success — refresh the cached value
        // else: keep the prior good value (stale-serve) or stay null
      } catch {
        entry.at = Date.now(); // still respect the TTL before retrying
      } finally {
        entry.inFlight = null;
      }
    })();
  }
  if (entry.value) return entry.value; // SWR: serve cached immediately (fresh or stale)
  await entry.inFlight;                // cold: nothing cached yet — wait for the first scan
  return entry.value;
}
// /base, /solana, /polygon, /arbitrum, /robinhood — five more x402
// marketplace pages over the same chain-agnostic renderer as /stellar and
// /algorand (mirrors its shape: 120/600 htmlCache, whole-body try/catch).
// These five reuse the revenueSnapshot cache for the receipt strip instead of
// standing up a dedicated per-chain rail fetcher — it already runs an
// SWR-cached scan of every EVM + Solana rail every 60s for /revenue, so the
// receipt strip here is a lookup, not a new network call. The 30-day
// activity charts (Transactions/Volume/Buyers) come from getActivityForChain
// above; a scanner with no data source (no ALCHEMY_API_KEY, RPC down) or a
// wallet that hasn't scanned yet renders the honest "unavailable" line, same
// as before this wiring existed.
// /robinhood replaces the old dedicated robinhood-page.js landing (folded
// its unique chain-parameter and tollbooth-config copy into this chain's
// sellParagraphHtml in market-page.js) — same URL, now the shared template.
const SNAPSHOT_RAIL_LABEL = { base: "Base", solana: "Solana", polygon: "Polygon", arbitrum: "Arbitrum", monad: "Monad", robinhood: "Robinhood Chain" };
// Per-chain wallet source: EVM rails (including Robinhood, chain 4663) all
// settle to the same WALLET_ADDRESS; Solana has its own env.
const chainWallet = (chainKey) => (chainKey === "solana" ? (process.env.SOLANA_WALLET_ADDRESS || "").trim() : WALLET_ADDRESS);
// Shared seller resolution for the chain market pages AND the /panel endpoint:
// read ?seller=<host>, find the picked seller, and decide which wallet the
// Activity charts scan — the seller's advertised payTo on THIS chain (network
// matched by C.isNetwork; getActivityForChain validates the address shape and
// returns null for an absent one → the honest per-seller "unavailable" line),
// else this host's wallet. Unknown/empty seller falls back to the host.
function resolveMarketSeller(chainKey, snapshot, sellerQuery) {
  const C = CHAIN_PAGES[chainKey];
  const sellers = marketSellers(chainKey, snapshot);
  const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
  const q = String(sellerQuery || "").toLowerCase().slice(0, 253);
  const picked = (q && sellers.find((s) => !s.local && hostOf(s.homepage || s.origin) === q)) || sellers.find((s) => s.local) || null;
  const sellerWallet = picked && !picked.local
    ? (Object.entries(picked.payToByNetwork || {}).find(([net]) => C.isNetwork(net))?.[1] || null)
    : null;
  const scanWallet = picked && !picked.local ? sellerWallet : chainWallet(chainKey);
  const selectedSeller = picked
    ? { local: !!picked.local, host: picked.local ? null : hostOf(picked.homepage || picked.origin), name: picked.displayName || null }
    : null;
  return { selectedSeller, scanWallet };
}
for (const chainKey of Object.keys(SNAPSHOT_RAIL_LABEL)) {
  app.get(`/${chainKey}`, async (req, res) => {
    try {
      const snapshot = getIndexSnapshot();
      const { selectedSeller, scanWallet } = resolveMarketSeller(chainKey, snapshot, req.query.seller);
      const [revSnap, activity] = await Promise.all([
        revenueSnapshot(revenueWallets()),
        scanWallet ? getActivityForChain(chainKey, scanWallet) : Promise.resolve(null),
      ]);
      const rail = revSnap?.rails?.find((r) => r.rail === SNAPSHOT_RAIL_LABEL[chainKey]) || null;
      htmlCache(res, 120, 600).send(marketPage(chainKey, BASE_URL, { snapshot, rail, activity, selectedSeller, wallet: rail?.wallet || undefined, leaderboardSnap: getLeaderboardSnapshot() }));
    } catch (e) {
      res.status(500).type("text/plain").send("temporarily unavailable");
    }
  });
}
// In-place seller switching: returns just the market panel (seller card +
// Activity charts) as JSON so the market page can swap it without a full reload
// (progressive enhancement — the roster links still navigate without JS). Same
// resolution + renderer as the page, so the swapped panel is byte-identical.
app.get("/api/market/:chain/panel", async (req, res) => {
  try {
    const chainKey = String(req.params.chain || "");
    if (!SNAPSHOT_RAIL_LABEL[chainKey]) return res.status(404).json({ error: "unknown chain" });
    const snapshot = getIndexSnapshot();
    const { selectedSeller, scanWallet } = resolveMarketSeller(chainKey, snapshot, req.query.seller);
    const activity = scanWallet ? await getActivityForChain(chainKey, scanWallet) : null;
    const html = marketPanelHtml(chainKey, { snapshot, activity, selectedSeller, leaderboardSnap: getLeaderboardSnapshot() });
    res.set("Cache-Control", "public, max-age=60").json({ html, seller: selectedSeller });
  } catch (e) {
    res.status(500).json({ error: "temporarily unavailable" });
  }
});
// The canonical all-chains marketplace directory — marketPage(null, …), the
// unified "The x402 marketplace" view (Task 2). Thin wrapper: getIndexSnapshot
// is the seller roster, getLeaderboardSnapshot is optional (a failed fetch
// still renders the directory, just without the per-seller settled-call join),
// and so is the economy snapshot (same try/catch the old /index route used —
// a failed fetch omits the #economy strip rather than breaking the page;
// x402EconomySnapshot caches 30 min, so this doesn't slow the hot path).
// ?all=1 opts out of the 100-row roster cap (see ALL_ROW_CAP in market-page.js).
app.get("/marketplace", async (req, res) => {
  const snapshot = getIndexSnapshot();
  let leaderboardSnap = null;
  try { leaderboardSnap = getLeaderboardSnapshot(); } catch { /* directory still renders */ }
  let economySnap = null;
  try { economySnap = await x402EconomySnapshot(); } catch { /* strip omitted */ }
  htmlCache(res, 120, 600).send(marketPage(null, BASE_URL, { snapshot, leaderboardSnap, economySnap, all: req.query.all === "1", wallet: WALLET_ADDRESS }));
});
// The seller front door — list an API on the index or tollbooth a site.
// Whole-body try/catch like /stellar and /algorand: any snapshot failure
// degrades to "temporarily unavailable" text rather than a half-rendered page.
app.get("/sell", (_req, res) => {
  try {
    htmlCache(res, 120, 600).send(
      sellPage(BASE_URL, { leaderboardSnapshot: getLeaderboardSnapshot(), indexSnapshot: getIndexSnapshot() })
    );
  } catch (e) {
    res.status(500).type("text/plain").send("temporarily unavailable");
  }
});
app.get("/api/index", (_req, res) =>
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300").json(getIndexSnapshot())
);
// Self-serve listing: validate + rate-limit here; ALL probing happens inside
// the crawler behind safeFetch (SSRF guard). 5/IP/hour, 30 new probes/hour
// globally — a public crawl trigger must not become a fetch amplifier. Body
// size is bounded by the global 100kb express.json() parser above (a
// per-route parser here would be a no-op — the global one already parsed the
// body by the time this handler runs).
const REG_WINDOW_MS = 3600_000;
const regByIp = new Map();
let regGlobal = [];
app.post("/api/index/register", async (req, res) => {
  const now = Date.now();
  const ip = req.ip || "?";
  const mine = (regByIp.get(ip) || []).filter((t) => now - t < REG_WINDOW_MS);
  if (mine.length >= 5) return res.status(429).json({ error: "rate limit: 5 submissions per hour per IP" });
  const v = validateOriginInput(req.body?.origin, { selfOrigin: BASE_URL });
  if (v.error) return res.status(400).json({ error: v.error });
  regGlobal = regGlobal.filter((t) => now - t < REG_WINDOW_MS);
  if (regGlobal.length >= 30) return res.status(429).json({ error: "rate limit: registration is busy, try again later" });
  mine.push(now); regByIp.set(ip, mine); regGlobal.push(now);
  const result = await registerOrigin(v.origin);
  res.json(result);
});
const computeRoute = (q, k, include, net) => routeQuery({ query: q, top: k, include, networkFilter: net, ...indexCtx() });
const routeCachePath = "/api/route";
const routeCachePolicy = CACHEABLE_ROUTES[routeCachePath];
app.get("/api/route", (req, res) => {
  const q = req.query.q ?? req.query.task ?? req.query.query;
  const top = req.query.top ?? req.query.k;
  const include = req.query.include;
  const net = req.query.network;
  return serveCachedDiscovery(routeCachePath, routeCachePolicy, { q, task: q, query: q, top, k: top, include, network: net }, () => computeRoute(q, top, include, net), "_route", req, res);
});
app.post("/api/route", (req, res) => {
  const q = req.body?.q ?? req.body?.task ?? req.body?.query;
  const top = req.body?.top ?? req.body?.k;
  const include = req.body?.include;
  const net = req.body?.network;
  return serveCachedDiscovery(routeCachePath, routeCachePolicy, { q, task: q, query: q, top, k: top, include, network: net }, () => computeRoute(q, top, include, net), "_route", req, res);
});
// x402 Leaderboard — public on-chain ranking of every seller in the Coinbase
// CDP Bazaar by settled USDC volume on Base. Free, like /api/find + /api/route:
// discovery primitives shouldn't cost money. Snapshot is cached in memory and
// refreshed hourly (see startLeaderboardRefresh below) — each request is a
// sub-millisecond read, never a live Bazaar walk.
//
// Query params (all optional):
//   top      max rows to return (default 25, max 500)
//   include  "all" (default) | "external" (exclude Agent402 — neutral view)
//   self     override the wallet treated as "self" for include=external
//   window   requested window hint: "24h" (default — the scan's SPAN_BLOCKS
//            default; see src/leaderboard.js), "7d" / "30d" / "all" are
//            documented but currently fall back to the active snapshot —
//            other windows require a separate deep-cache pipeline (roadmap).
//            The response always reports the window actually served in
//            `windowLabel` + `windowRequested`.
const SUPPORTED_WINDOWS = new Set(["24h", "7d", "30d", "all"]);
app.get("/api/leaderboard", (req, res) => {
  const snap = getLeaderboardSnapshot();
  const top = Math.min(Math.max(parseInt(req.query.top, 10) || 25, 1), 500);
  const include = req.query.include === "external" ? "external" : "all";
  const self = (req.query.self || WALLET_ADDRESS || "").toLowerCase();
  const requested = String(req.query.window || "").toLowerCase();
  const windowRequested = SUPPORTED_WINDOWS.has(requested) ? requested : "24h";
  // Mirror the HTML toggle on /leaderboard. Re-rank *after* the include filter
  // so ranks are consecutive in the caller's view (no gaps from dropped rows).
  // sortServed echoes what we actually applied, parallelling windowServed —
  // a caller passing ?sort=bogus can tell from the response which mode ran.
  const sortServed = req.query.sort === "calls" ? "calls" : "usd";
  let board = snap.leaderboard || [];
  if (include === "external" && self) board = board.filter((r) => r.wallet !== self);
  board = rankBy(board, sortServed);
  res.json({
    ...snap,
    include,
    sortServed,
    windowRequested,
    windowServed: snap.windowLabel || "24h",
    leaderboard: board.slice(0, top),
    totalSellers: (snap.leaderboard || []).length,
  });
});
// Human-readable companion to /api/leaderboard. Same cached snapshot, rendered
// as a dashboard so visitors (and the site nav) have something to land on.
app.get("/leaderboard", (_req, res) => htmlCache(res, 60, 300).send(ledgerLeaderboardPage(BASE_URL, getLeaderboardSnapshot())));
app.get("/robots.txt", (_req, res) => res.type("text/plain").set("Cache-Control", "public, max-age=3600").send(robotsTxt(BASE_URL)));
// IndexNow ownership key file (env-gated no-op like the other integrations).
// The protocol verifies a submitted key by fetching /{key}.txt from the host;
// scripts/indexnow-submit.js does the actual URL pings (Bing/Copilot/DDG/Yahoo
// share the index). Key is an opaque self-generated hex string, not a secret.
if (process.env.INDEXNOW_KEY) {
  app.get(`/${process.env.INDEXNOW_KEY}.txt`, (_req, res) =>
    res.type("text/plain").set("Cache-Control", "public, max-age=86400").send(process.env.INDEXNOW_KEY));
}
app.get("/sitemap.xml", (_req, res) => res.type("application/xml").set("Cache-Control", "public, max-age=3600").send(sitemapXml(BASE_URL, CATALOG)));
app.get("/llms.txt", (_req, res) => res.type("text/plain").set("Cache-Control", "public, max-age=3600").send(llmsTxt(BASE_URL, CATALOG)));
// The runnable buyer demo, served from the site itself (the repo is private,
// so "git clone" is not a path a visitor can take).
app.get("/demo.js", (_req, res) =>
  res.type("text/javascript").set("Cache-Control", "public, max-age=3600").send(readFileSync(new URL("../scripts/demo-payment.js", import.meta.url), "utf-8"))
);

// Brand images (logo + social cards) use the site's ledger design tokens:
// paper #F5F5F5, ink #0b0b0b, accent #D63C1A, Space Mono / Archivo. The two
// typefaces are embedded as data-URI @font-face (latin subsets committed in
// assets/fonts/, OFL-licensed) so rasterization is deterministic and offline —
// no Google Fonts fetch in the serving path. rasterizeSvg awaits fonts.ready.
const fontB64 = (f) => readFileSync(new URL(`../assets/fonts/${f}`, import.meta.url)).toString("base64");

// Self-hosted brand fonts (Archivo + Space Mono, latin woff2 in assets/fonts/),
// served first-party with a 1-year immutable cache. This replaces the
// render-blocking third-party Google Fonts stylesheet (worth ~1.9s of mobile
// render-block + a cross-origin request chain) and gives repeat visits a free
// cache hit. Filenames are strictly validated — no path traversal.
const FONT_FILE_RE = /^(archivo|spacemono)-(400|500|600|700|800|900)\.woff2$/;
app.get("/fonts/:file", (req, res) => {
  const file = String(req.params.file || "");
  if (!FONT_FILE_RE.test(file)) return res.status(404).end();
  let buf;
  try { buf = readFileSync(new URL(`../assets/fonts/${file}`, import.meta.url)); }
  catch { return res.status(404).end(); }
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.type("font/woff2").send(buf);
});
const BRAND_FONT_STYLE = `<style>
@font-face{font-family:'Space Mono';font-weight:400;src:url(data:font/woff2;base64,${fontB64("spacemono-400.woff2")}) format('woff2')}
@font-face{font-family:'Space Mono';font-weight:700;src:url(data:font/woff2;base64,${fontB64("spacemono-700.woff2")}) format('woff2')}
@font-face{font-family:'Archivo';font-weight:800;src:url(data:font/woff2;base64,${fontB64("archivo-800.woff2")}) format('woff2')}
</style>`;
const BRAND = { paper: "#F5F5F5", card: "#FFFFFF", ink: "#0b0b0b", muted: "#4A4A4A", hairline: "#E0E0DE", accent: "#D63C1A", mono: "'Space Mono',Consolas,monospace", display: "'Archivo',system-ui,sans-serif" };

// Brand mark — the ink slab: cream 402 with the accent period on dark ink,
// matching the ledger chrome (and the X avatar). The PNG is rasterized once
// via the existing headless Chromium and cached for the process lifetime
// (marketplaces and link previews often refuse SVG).
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${BRAND_FONT_STYLE}<rect width="512" height="512" fill="${BRAND.ink}"/><text x="256" y="308" font-size="150" font-weight="700" font-family=${JSON.stringify(BRAND.mono)} text-anchor="middle" letter-spacing="-4" fill="${BRAND.paper}">402<tspan fill="${BRAND.accent}">.</tspan></text></svg>`;
app.get("/logo.svg", (_req, res) => res.type("image/svg+xml").set("Cache-Control", "public, max-age=86400").send(LOGO_SVG));

// Favicon-scale mark: the logo's 150px glyphs cover ~40% of the canvas, which
// reads as a plain black square in a 16px browser tab. This variant fills the
// frame ("402" at 82% width, the brand period as a corner dot) so the mark
// survives tab scale. Marketplaces/link previews keep the roomier LOGO_SVG.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${BRAND_FONT_STYLE}<rect width="512" height="512" fill="${BRAND.ink}"/><text x="246" y="342" font-size="252" font-weight="700" font-family=${JSON.stringify(BRAND.mono)} text-anchor="middle" letter-spacing="-14" fill="${BRAND.paper}">402</text><rect x="408" y="408" width="68" height="68" fill="${BRAND.accent}"/></svg>`;

let logoPngCache = null;
app.get("/logo.png", async (_req, res) => {
  try {
    logoPngCache ??= await rasterizeSvg(LOGO_SVG, 512);
    res.type("image/png").set("Cache-Control", "public, max-age=31536000, immutable").send(logoPngCache);
  } catch {
    // No Chromium on this instance — the SVG is always available.
    res.redirect(302, "/logo.svg");
  }
});
// Real favicon files so third-party fetchers (Google's s2/favicons, used by the
// Anthropic directory) resolve our 402 mark instead of a generic globe. The SVG
// is always available; the .ico serves the rasterized PNG (favicon clients
// accept PNG bytes) and falls back to the SVG if Chromium is unavailable.
app.get("/favicon.svg", (_req, res) =>
  res.type("image/svg+xml").set("Cache-Control", "public, max-age=31536000, immutable").send(FAVICON_SVG)
);
let faviconPngCache = null;
app.get("/favicon.ico", async (_req, res) => {
  try {
    faviconPngCache ??= await rasterizeSvg(FAVICON_SVG, 512);
    res.type("image/png").set("Cache-Control", "public, max-age=31536000, immutable").send(faviconPngCache);
  } catch {
    res.redirect(302, "/favicon.svg");
  }
});

// 1200×630 social card for link previews (og:image / twitter:image).
// `width`/`height` letterbox the same art onto other canvases — GitHub's
// repo social preview wants exactly 1280×640.
const cardSvg = (width = 1200, height = 630) => {
  const n = Object.keys(CATALOG).length;
  const s = Math.min(width / 1200, height / 630);
  const tx = (width - 1200 * s) / 2;
  const ty = (height - 630 * s) / 2;
  const mono = JSON.stringify(BRAND.mono);
  const display = JSON.stringify(BRAND.display);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${BRAND_FONT_STYLE}
  <rect width="${width}" height="${height}" fill="${BRAND.paper}"/>
  <g transform="translate(${tx},${ty}) scale(${s})">
  <rect x="36" y="36" width="1128" height="558" fill="${BRAND.card}" stroke="${BRAND.ink}" stroke-width="3"/>
  <!-- nav row: bordered 402 badge + wordmark, ruled off like the site header -->
  <rect x="84" y="84" width="64" height="64" fill="none" stroke="${BRAND.ink}" stroke-width="5"/>
  <text x="116" y="126" font-size="26" font-weight="700" font-family=${mono} text-anchor="middle" fill="${BRAND.ink}">402</text>
  <text x="170" y="127" font-size="34" font-weight="800" font-family=${display} letter-spacing="-0.5" fill="${BRAND.ink}">AGENT402<tspan fill="${BRAND.accent}">.</tspan>TOOLS</text>
  <text x="1116" y="127" font-size="24" font-weight="700" font-family=${mono} text-anchor="end" fill="${BRAND.accent}">agent402.tools</text>
  <line x1="84" y1="172" x2="1116" y2="172" stroke="${BRAND.ink}" stroke-width="2.5"/>
  <text x="84" y="330" font-size="84" font-weight="800" font-family=${display} letter-spacing="-2" fill="${BRAND.ink}">Where agents pay</text>
  <text x="84" y="416" font-size="84" font-weight="800" font-family=${display} letter-spacing="-2" fill="${BRAND.ink}">agents<tspan fill="${BRAND.accent}">.</tspan></text>
  <line x1="84" y1="462" x2="1116" y2="462" stroke="${BRAND.hairline}" stroke-width="2"/>
  <text x="84" y="510" font-size="27" font-family=${mono} fill="${BRAND.muted}">The open x402 index: ${n.toLocaleString("en-US")} tools + ${SKILL_PACKS.length} skill packs.</text>
  <text x="84" y="554" font-size="23" font-family=${mono} fill="${BRAND.muted}">${RAILS_SHORT}</text>
  </g>
</svg>`;
};
app.get("/card.svg", (_req, res) => res.type("image/svg+xml").set("Cache-Control", "public, max-age=86400").send(cardSvg()));
let cardPngCache = null;
app.get("/card.png", async (_req, res) => {
  try {
    cardPngCache ??= await rasterizeSvg(cardSvg(), { width: 1200, height: 630 });
    res.type("image/png").set("Cache-Control", "public, max-age=86400").send(cardPngCache);
  } catch {
    res.redirect(302, "/card.svg");
  }
});
// GitHub repo social preview (Settings → Social preview) wants 1280×640.
let cardGithubCache = null;
app.get("/card-1280.png", async (_req, res) => {
  try {
    cardGithubCache ??= await rasterizeSvg(cardSvg(1280, 640), { width: 1280, height: 640 });
    res.type("image/png").set("Cache-Control", "public, max-age=86400").send(cardGithubCache);
  } catch {
    res.redirect(302, "/card.svg");
  }
});
app.get("/openapi.json", (_req, res) => res.set("Cache-Control", "public, max-age=3600").json(openapiSpec(BASE_URL, CATALOG)));
app.get("/tools", (_req, res) => htmlCache(res, 300, 900).send(ledgerCatalogPage(BASE_URL, CATALOG, SKILL_PACKS)));
app.get("/shop", (_req, res) => htmlCache(res, 300, 900).send(shopPage(BASE_URL, CATALOG)));
// The standalone economy dashboard folded into the marketplace's "The economy,
// over time" section (its 24h totals/concentration/network-split summary moved
// there; the top-10 list duplicated /leaderboard and was dropped). Redirect
// straight to /marketplace - never chain through the /index 301.
app.get("/economy", (_req, res) => res.redirect(301, "/marketplace#economy"));
// The ~970 pairwise convert-<from>-to-<to> endpoints are retired — the single
// parametric POST /api/unit-convert serves every pair with the same unit ids
// and the same math (src/tools/convert-gen.js). API calls that we CAN answer
// (valid unit pair + numeric value) are transparently served (200) through
// that same engine; the rest get a 410 that TEACHES the replacement — never
// a 301, because agents must not silently re-POST paid calls across routes;
// the body hands them the exact new call
// instead. Pattern safety: every retired slug starts with "convert-", so
// surviving routes like /api/base-convert, /api/unit-convert and
// /api/timezone-convert can never match ^/api/convert-…-to-…$.
const RETIRED_CONVERT_UNIT_IDS = new Set(
  Object.values(UNIT_CATEGORIES).flatMap((cat) => Object.keys(cat.units))
);
// Unit ids can themselves contain hyphens (nautical-miles, light-years), so
// the "<from>-to-<to>" middle segment can't be split on the first "-to-":
// try every "-to-" split point and keep the one where BOTH sides are real
// unit ids (temperature ids included). No valid split → nulls; the 410 body
// still teaches the generic replacement. Both retired prefixes —
// "/api/convert/" (the shape the live routes actually had) and
// "/api/convert-" (the slug shape) — are exactly 13 chars, so one slice
// handles either.
const parseRetiredConvertPath = (path) => {
  const middle = path.slice("/api/convert-".length);
  for (let i = middle.indexOf("-to-"); i !== -1; i = middle.indexOf("-to-", i + 1)) {
    const from = middle.slice(0, i);
    const to = middle.slice(i + 4);
    if (RETIRED_CONVERT_UNIT_IDS.has(from) && RETIRED_CONVERT_UNIT_IDS.has(to)) return { from, to };
  }
  return { from: null, to: null };
};
// The old tools accepted both POST {value} and GET ?value=N — the handler
// covers both verbs and echoes the caller's numeric value into the taught
// input (null when absent or non-numeric — never NaN in a JSON body).
//
// TRANSPARENT SERVE: third-party marketplaces (Bazaar, agentic.market) cache
// retired listings from past settlements long after retirement, and an agent
// that discovers us there, calls a retired converter, and gets a 410 counts
// it as OUR failure and deprioritizes us. So when we CAN compute the answer —
// the path parses to valid unit ids AND a numeric value arrived — we serve
// the real conversion (200) through the same engine, with the exact output
// shape of POST /api/unit-convert (result/from/to; from/to are canonical
// table ids so alias scaling is moot) plus honest shim markers `_retired` /
// `_replacement`. The teaching 410 remains only for requests we genuinely
// can't answer: unparseable pairs, cross-category guesses (routes that never
// existed — convertAnyUnit throws, we fall through), or no numeric value.
// These are legacy compatibility handlers, NOT catalog entries — the catalog
// count is untouched and the boot-time shadow guard above still applies.
const RETIRED_CONVERT_API_RE = /^\/api\/convert-[a-z0-9-]+-to-[a-z0-9-]+$/;
const retiredConvertHandler = (req, res) => {
  const { from, to } = parseRetiredConvertPath(req.path);
  const raw = req.body && req.body.value !== undefined ? req.body.value : req.query.value;
  const num = raw === undefined || raw === null || raw === "" ? NaN : Number(raw);
  if (from && to && Number.isFinite(num)) {
    try {
      const result = +convertAnyUnit(num, from, to).toPrecision(12);
      // Served hits emit NO event: tool_gone is reserved for the teaching
      // 410s, so the event means "a caller we could NOT serve". A marketplace
      // crawler sweeping all ~650 cached converter listings hourly since
      // 2026-07-14 was pushing ~590 served-fine tool_gone/hr — ~425k
      // events/mo of pure PostHog quota burn saying nothing.
      return res.json({
        result,
        from,
        to,
        _retired: true,
        _replacement: "unit-convert",
      });
    } catch {
      // Cross-category pair — a route shape that never existed. Can't compute;
      // fall through to the teaching 410 below.
    }
  }
  // Residual demand we can't serve is the product signal worth an event.
  // Fire-and-forget, rate-capped in posthog.js; env-gated no-op like every capture.
  capturePostHogToolGone({ route: req.path, replacement: "POST /api/unit-convert" });
  res.status(410).json({
    error: "This pairwise conversion endpoint is retired. Use POST /api/unit-convert with { value, from, to } — the same unit ids and the same math, one route for every pair. Discovery: GET /api/find?q=unit+convert.",
    replacement: {
      route: "POST /api/unit-convert",
      input: { value: Number.isFinite(num) ? num : null, from, to },
    },
  });
};
app.post(RETIRED_CONVERT_API_RE, retiredConvertHandler);
app.get(RETIRED_CONVERT_API_RE, retiredConvertHandler);
// The routes that were ACTUALLY mounted (and documented in the wiki / cited by
// buyers) were the slash form — GET /api/convert/<from>-to-<to>?value=N. Those
// must get the same teaching 410, not a bare 404. The slug form above stays
// covered too since agents commonly guess a route from a slug.
const RETIRED_CONVERT_API_SLASH_RE = /^\/api\/convert\/[a-z0-9-]+-to-[a-z0-9-]+$/;
app.post(RETIRED_CONVERT_API_SLASH_RE, retiredConvertHandler);
app.get(RETIRED_CONVERT_API_SLASH_RE, retiredConvertHandler);
// The retired tool PAGES carry inbound links + SEO equity — those 301 to the
// survivor's page (a page visit has no re-POST hazard, unlike the API).
app.get(/^\/tools\/convert-[a-z0-9-]+-to-[a-z0-9-]+$/, (_req, res) => res.redirect(301, "/tools/unit-convert"));
// The whole "convert" category page retired with its tools — same SEO-equity 301.
app.get("/tools/category/convert", (_req, res) => res.redirect(301, "/tools/unit-convert"));
app.get("/tools/category/:cat", (req, res) => {
  const html = categoryPage(BASE_URL, CATALOG, req.params.cat);
  if (!html) return res.status(404).type("html").send('<p>Category not found. <a href="/tools">All tools</a></p>');
  htmlCache(res, 300, 900).send(html);
});
app.get("/tools/:slug", (req, res) => {
  const tools = toolList(CATALOG);
  const tool = tools.find((t) => t.slug === req.params.slug);
  if (!tool) return res.status(404).type("html").send('<p>Tool not found. <a href="/tools">All tools</a></p>');
  const related = tools.filter((t) => t.category === tool.category && t.slug !== tool.slug).slice(0, 3);
  const cachePolicy = tool.method === "GET" ? CACHEABLE_ROUTES[tool.path] : null;
  htmlCache(res, 300, 900).send(toolPage(BASE_URL, tool, related, { computePayable: POW_SLUGS.has(tool.slug), powDifficulty: POW_DIFFICULTY, cacheTtl: cachePolicy?.ttl ?? null }));
});
const toolCardCache = new Map();
app.get("/tools/:slug/card.png", async (req, res) => {
  const tools = toolList(CATALOG);
  const tool = tools.find((t) => t.slug === req.params.slug);
  if (!tool) return res.status(404).json({ error: "not found" });
  const catLabel = CATEGORIES[tool.category]?.label ?? tool.category;
  const svgEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const nameT = tool.name.length > 36 ? tool.name.slice(0, 34) + "\u2026" : tool.name;
  const descT = tool.description.length > 74 ? tool.description.slice(0, 72) + "\u2026" : tool.description;
  const free = POW_SLUGS.has(tool.slug) ? "FREE w/ PoW \u00b7 " : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${BRAND_FONT_STYLE}<rect width="1200" height="630" fill="${BRAND.paper}"/><g><rect x="36" y="36" width="1128" height="558" fill="${BRAND.card}" stroke="${BRAND.ink}" stroke-width="3"/><rect x="84" y="84" width="64" height="64" fill="none" stroke="${BRAND.ink}" stroke-width="5"/><text x="116" y="126" font-size="26" font-weight="700" font-family=${JSON.stringify(BRAND.mono)} text-anchor="middle" fill="${BRAND.ink}">402</text><text x="170" y="118" font-size="26" font-weight="800" font-family=${JSON.stringify(BRAND.display)} fill="${BRAND.ink}">AGENT402<tspan fill="${BRAND.accent}">.</tspan>TOOLS</text><text x="170" y="146" font-size="20" font-family=${JSON.stringify(BRAND.mono)} fill="${BRAND.muted}">${svgEsc(catLabel)}</text><line x1="84" y1="172" x2="1116" y2="172" stroke="${BRAND.ink}" stroke-width="2.5"/><text x="84" y="308" font-size="58" font-weight="800" font-family=${JSON.stringify(BRAND.display)} letter-spacing="-1" fill="${BRAND.ink}">${svgEsc(nameT)}</text><text x="84" y="372" font-size="22" font-family=${JSON.stringify(BRAND.mono)} fill="${BRAND.muted}">${svgEsc(descT)}</text><line x1="84" y1="440" x2="1116" y2="440" stroke="${BRAND.hairline}" stroke-width="2"/><text x="84" y="496" font-size="29" font-weight="700" font-family=${JSON.stringify(BRAND.mono)} fill="${BRAND.accent}">${svgEsc(free)}${svgEsc(tool.price)} per call \u00b7 ${svgEsc(tool.method)} ${svgEsc(tool.path)}</text><text x="84" y="550" font-size="23" font-family=${JSON.stringify(BRAND.mono)} fill="${BRAND.muted}">Pay in USDC on Base via x402 \u2014 no API key, no signup</text></g></svg>`;
  try {
    if (!toolCardCache.has(tool.slug)) toolCardCache.set(tool.slug, await rasterizeSvg(svg, { width: 1200, height: 630 }));
    res.set("Cache-Control", "public, max-age=86400").type("image/png").send(toolCardCache.get(tool.slug));
  } catch { res.redirect(302, "/card.png"); }
});
// Free proof-of-work endpoints: agents without a wallet pay with CPU instead.
app.get("/api/pow", (_req, res) => res.json(powInfo(BASE_URL, [...POW_SLUGS].sort())));
// Light per-IP rate limit on challenge issuance. Issuing is cheap (one HMAC,
// stateless) but unmetered issuance is needless surface; this keeps a single
// client from hammering it while staying generous for legitimate solvers.
const powChallengeHits = new Map(); // ip -> number[] (timestamps, last 60s)
const POW_CHALLENGE_PER_MIN = Math.min(Math.max(parseInt(process.env.POW_CHALLENGE_PER_MIN, 10) || 120, 10), 100000);
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [ip, ts] of powChallengeHits) {
    while (ts.length && ts[0] < cutoff) ts.shift();
    if (!ts.length) powChallengeHits.delete(ip);
  }
}, 5 * 60 * 1000).unref();
app.get("/api/pow/challenge", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "?";
  const now = Date.now();
  let ts = powChallengeHits.get(ip);
  if (!ts) powChallengeHits.set(ip, (ts = []));
  while (ts.length && ts[0] < now - 60000) ts.shift();
  if (ts.length >= POW_CHALLENGE_PER_MIN) {
    return res.status(429).json({ error: `Too many challenge requests (${POW_CHALLENGE_PER_MIN}/min). Solve the ones you have, or pay via x402.` });
  }
  ts.push(now);
  const requested = (req.query.slug || req.query.path || "").toString().replace(/^.*\//, "");
  // Challenges are strictly scoped to one known compute-payable tool — no
  // wildcard tokens, so a solved challenge can never be retargeted.
  if (!POW_SLUGS.has(requested)) {
    return res.status(404).json({ error: `Unknown or wallet-only tool "${requested}". Compute-payable slugs: GET /api/pow` });
  }
  // Funnel stage 2b — a free-tier challenge was issued (agent asked how to pay
  // for free). Paired with payment_settled{rail=pow} this is the free-tier
  // take rate. Only genuine issuances count (past the 429/404 guards above).
  capturePostHogPowChallenge({ slug: requested, synthetic: isSyntheticRequest(req) });
  res.json(issueChallenge(requested));
});

// Live machine-to-machine economy stats (free). Money is provable on-chain at
// the wallet; this also tallies calls served and how they were paid for.
//
// When analytics is wired (DB attached), we ALSO enrich with a 24h performance
// snapshot — cache hit rate + latency percentiles — straight from the
// tool_calls table. Lets agents shopping the catalog see real performance
// without navigating to /analytics. Falls back to omitting the field if the
// query fails / DB is unset, so /api/stats never breaks on a slow Postgres.
app.get("/api/stats", (_req, res) => {
  const base = getStats({ wallet: WALLET_ADDRESS, walletName: WALLET_ENS, network: NETWORK, toolCount: Object.keys(CATALOG).length, baseUrl: BASE_URL, prices: TOOL_PRICES });
  const perf = getPerformance24h();
  if (perf) base.performance24h = perf;
  res.json(base);
});

// Tool-call analytics (free, public). Aggregates from the tool_calls table:
// total calls / cache-hit rate / error rate / latency percentiles over a
// configurable window, plus top tools by volume. Returns { enabled: false }
// when no analytics DB is wired — the server still works.
app.get("/api/analytics", async (req, res) => {
  const windowHours = Math.max(1, Math.min(720, parseInt(req.query.hours, 10) || 24));
  const top = Math.max(1, Math.min(200, parseInt(req.query.top, 10) || 25));
  // `?include_synthetic=1` opts in to seeing CI canaries / heartbeat probes /
  // operator smoke tests. Default hides them so the public dashboard reflects
  // real-caller error rates only. The aggregator still reports how many were
  // hidden via `syntheticHidden` so the toggle has accurate count.
  const includeSynthetic = req.query.include_synthetic === "1" || req.query.include_synthetic === "true";
  // `?include_probes=1` opts in to seeing empty-input scanning calls. Default
  // hides them — they inflate the 4xx rate without representing real callers.
  const includeProbes = req.query.include_probes === "1" || req.query.include_probes === "true";
  res.json(await getAnalytics({ windowHours, top, includeSynthetic, includeProbes }));
});

// Human-readable analytics dashboard. Same data as /api/analytics, rendered as
// HTML with stat cards, a sparkline, and the top-tools table. When no DB is
// wired, the page shows a clean "not enabled" panel — server still boots.
app.get("/analytics", async (req, res) => {
  const windowHours = Math.max(1, Math.min(720, parseInt(req.query.hours, 10) || 24));
  const includeSynthetic = req.query.include_synthetic === "1" || req.query.include_synthetic === "true";
  const includeProbes = req.query.include_probes === "1" || req.query.include_probes === "true";
  const data = await getAnalytics({ windowHours, top: 25, includeSynthetic, includeProbes });
  htmlCache(res, 30, 60).send(analyticsPage(data, { baseUrl: BASE_URL }));
});

// Remote MCP connector (streamable HTTP, authless free tier): paste
// https://agent402.tools/mcp into Claude/ChatGPT custom connectors. Mounted
// before the paywall — it meters itself (PoW-eligible tools only, per-IP
// rate limit) and counts served calls under the proof-of-work tier.
mountMcp(app, CATALOG, {
  baseUrl: BASE_URL,
  isComputePayable,
  // Hosted leaderboard snapshot powers the new `top_x402_sellers` MCP tool —
  // same data the HTML /leaderboard and /api/leaderboard surfaces use, so
  // agents see the same numbers no matter which surface they hit. Hourly-
  // refreshed in-process; safe to call freely from /mcp.
  getLeaderboard: getLeaderboardSnapshot,
  // MCP-served calls land on the same accounting + analytics rails as
  // direct-HTTP ones. PoW is the gate (no x402 settlement on /mcp's free
  // tier), so the served-call counter records under "pow". Analytics gets
  // the full meta (latency, errored). Cache hits don't flow through MCP
  // today — that path bypasses the central HTTP dispatcher.
  onServed: (slug, meta = {}) => {
    recordServedCall(slug, "pow");
    // MCP doesn't carry an HTTP status, so we synthesize one for the split:
    // 200 on success, 500 on error (no separate 4xx classification — MCP
    // tool-call errors come back in-band, not as transport-level failures).
    const status = meta.errored ? (meta.statusCode | 0 || 500) : 200;
    // Probe detection: a 4xx with zero input keys = scanning/discovery call.
    const isProbe = meta.errored && status >= 400 && status < 500
      && Array.isArray(meta.inputKeys) && meta.inputKeys.filter((k) => k !== "slug").length === 0;
    // MCP transport has no HTTP header surface, so `X-Heartbeat-Token` can't
    // ride along — synthetic is always false here. Pass explicitly so future
    // refactors don't accidentally let a stray truthy value through.
    if (meta.errored) logToolError(slug, status, meta.errorMessage || "mcp-error", undefined, false, isProbe);
    const latencyMs = meta.latencyMs | 0;
    const errored = !!meta.errored;
    recordToolCall({ slug, latencyMs, cached: false, errored, status, synthetic: false, probe: isProbe }).catch(() => {});
    capturePostHogToolCall({ slug, latencyMs, cached: false, errored, status, synthetic: false, probe: isProbe });
  },
});

app.get("/api/pricing", (_req, res) => {
  const endpointCount = Object.keys(CATALOG).length;
  return res.json({
    name: "Agent402.Tools",
    description: `Pay-per-call tools for AI agents via the x402 payment protocol — ${endpointCount} deterministic tools (browser, search, PDFs, OCR, finance, EDGAR, crypto, macro, memory), an OpenAI-compatible LLM gateway at /v1 (flat-priced chat from $0.003, embeddings $0.002, images — no API key, the wallet is the account), plus ${SKILL_PACKS.length} curated multi-tool skill packs callable as MCP prompts. Free via in-process proof-of-work or pay per call in ${RAILS_OR}. Open-source and self-hostable. MCP connector: ${BASE_URL}/mcp.`,
    // The LLM gateway is the highest-frequency product agents buy — surface its
    // tiers at the top level instead of burying them among ${endpointCount}
    // endpoint rows. Flat per-call pricing (not token-metered): a buyer knows
    // the worst case before sending.
    llmGateway: {
      wire: "OpenAI-compatible",
      base: `${BASE_URL}/v1`,
      pricing: "flat per call — never token-metered",
      tiers: [
        { path: "/v1/nano/chat/completions", price: "$0.003", note: "cheap fast models" },
        { path: "/v1/auto/chat/completions", price: "$0.01", note: "model optional — deterministic eval-ranked routing" },
        { path: "/v1/chat/completions", price: "$0.02", note: "base tier" },
        { path: "/v1/pro/chat/completions", price: "$0.10", note: "frontier models" },
        { path: "/v1/premium/chat/completions", price: "$0.50", note: "largest models" },
        { path: "/v1/embeddings", price: "$0.002", note: "batch ≤64, cached by default" },
        { path: "/v1/images/generations", price: "$0.08", note: "b64_json out" },
      ],
      docs: `${BASE_URL}/tools/category/llm`,
    },
    payment: { protocol: "x402", version: 2, network: NETWORK, currency: "USDC", networks: enabledNetworks(NETWORK) },
    altPayment: {
      protocol: "proof-of-work",
      summary: "No wallet? Solve a sha256 puzzle (a fraction of a second of CPU) instead — no money, no AI tokens, no model involved.",
      challengeUrl: `${BASE_URL}/api/pow/challenge`,
      info: `${BASE_URL}/api/pow`,
      difficultyBits: POW_DIFFICULTY,
      eligibleTools: [...POW_SLUGS].sort(),
    },
    baseUrl: BASE_URL,
    openapi: `${BASE_URL}/openapi.json`,
    categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])),
    endpoints: Object.entries(CATALOG).map(([route, { price, description, category, slug }]) => {
      const [method, path] = route.split(" ");
      return { method, path, price, category, slug, description, docs: `${BASE_URL}/tools/${slug}`, computePayable: POW_SLUGS.has(slug) };
    }),
  });
});

// Public machine-readable cache catalogue: every server-side cached route
// with its TTL and the request fields that contribute to the cache key.
// Why this is public:
//   - Buyer SDKs (agent402-client and any third-party MCP client) can avoid
//     burning their own local cache on routes the server is already caching.
//   - Operators evaluating Agent402 can audit cache aggressiveness before
//     wiring it into agent workflows.
// Response also reports whether REDIS_URL is wired in this deployment, so a
// caller can tell "policy exists" (always) from "policy is actually live"
// (only when Redis is connected). All TTLs are seconds; X-Cache: hit|miss|skip
// on responses to cached routes is the live signal.
app.get("/api/cacheable", (_req, res) => {
  const routes = Object.entries(CACHEABLE_ROUTES)
    .map(([path, policy]) => ({
      method: "GET",
      path,
      ttlSeconds: policy.ttl,
      keyFields: policy.keyFields,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  res.json({
    enabled: cacheEnabled(),
    backend: cacheEnabled() ? "redis" : "none",
    cacheHeader: "X-Cache",
    cacheHeaderValues: ["hit", "miss", "skip"],
    routes,
    note: "Server-side response cache. Buyer SDKs can skip their own cache for these paths — repeated identical calls within the TTL return the same JSON without re-hitting the upstream. Errors are never cached.",
  });
});

// Live in-process cache outcome counters since the server started. Independent
// of the analytics Postgres — works even on instances that never opt into
// analytics. Gives operators a simple "is the cache earning its keep" signal:
// look at hitRate. Reset on restart (which is honest: Redis content doesn't
// survive a fresh boot of a brand-new container with empty keyspace either).
app.get("/api/cache-stats", (_req, res) => res.json(cacheCounters()));

// Opt-in idempotency (safe retry for paid/proven calls). If a client sends an
// `Idempotency-Key`, a successful gated call is cached keyed by that key + the
// gate credential it presented (the x402 payment authorization or the
// proof-of-work token — both single-use). A retry with the SAME Idempotency-Key
// AND the SAME credential replays the stored result WITHOUT re-charging — so an
// agent that paid but lost the response doesn't pay twice. Because the cache key
// includes the credential (which only the original payer/solver holds), it can
// never serve a paid result to a non-payer; requests without the header are
// completely unaffected (default behavior, normal billing). Runs before the
// paywall so a replay hit skips settlement.
const idemStore = new Map(); // hashKey -> { at, body, bytes }
const IDEM_TTL_MS = 10 * 60 * 1000;
const IDEM_MAX_ENTRIES = 5000;
// Cap total cached body bytes — a single tool returning a large blob shouldn't
// pin tens of megabytes per slot. 32 MB total, ~1 MB per entry max; oversize
// responses skip the cache entirely (retry will re-run the tool, no charge
// because PoW/x402 credentials are single-use anyway).
const IDEM_MAX_BYTES = 32 * 1024 * 1024;
const IDEM_MAX_BODY_BYTES = 1024 * 1024;
let idemBytes = 0;
// Background sweep: entries expire on read at IDEM_TTL_MS, but on a quiet
// service stale bodies (some kits return large blobs) would sit in memory
// until pushed out by FIFO. Prune by age every minute so memory tracks
// actual recent traffic. .unref() so this never blocks process exit.
setInterval(() => {
  const cutoff = Date.now() - IDEM_TTL_MS;
  for (const [k, v] of idemStore) {
    if (v.at < cutoff) { idemBytes -= v.bytes; idemStore.delete(k); }
  }
}, 60_000).unref();
const idemHashKey = (req) => {
  const idem = req.header("idempotency-key");
  if (!idem || idem.length > 256) return null;
  const cred = req.header("x-payment") || req.header("payment-signature") || req.header("x-pow-solution");
  if (!cred) return null; // nothing to securely bind the key to → don't cache
  // Bind to the exact route AND the request body, so the same key+credential
  // can't be used to retrieve a cached response from a different payload or
  // different endpoint. Body is hashed (not stored) so the key stays compact.
  const bodyHash = req.body && Object.keys(req.body).length
    ? createHash("sha256").update(JSON.stringify(req.body)).digest("hex")
    : "-";
  return createHash("sha256").update(`${req.method} ${req.path}\n${idem}\n${cred}\n${bodyHash}`).digest("hex");
};
app.use((req, res, next) => {
  if (!CATALOG[`${req.method} ${req.path}`]) return next();
  const key = idemHashKey(req);
  if (!key) return next();
  const hit = idemStore.get(key);
  if (hit && Date.now() - hit.at < IDEM_TTL_MS) {
    res.setHeader("X-Idempotent-Replay", "true");
    return res.status(200).json(hit.body);
  }
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 200) {
      let bytes = 0;
      try { bytes = Buffer.byteLength(JSON.stringify(body), "utf8"); } catch { bytes = 0; }
      if (bytes && bytes <= IDEM_MAX_BODY_BYTES) {
        // Evict oldest entries (Map preserves insertion order → FIFO ≈ LRU
        // for write-heavy access) until we fit by entries AND by bytes.
        while (
          (idemStore.size >= IDEM_MAX_ENTRIES || idemBytes + bytes > IDEM_MAX_BYTES)
          && idemStore.size > 0
        ) {
          const firstKey = idemStore.keys().next().value;
          const ev = idemStore.get(firstKey);
          if (ev) idemBytes -= ev.bytes;
          idemStore.delete(firstKey);
        }
        idemStore.set(key, { at: Date.now(), body, bytes });
        idemBytes += bytes;
      }
    }
    return origJson(body);
  };
  next();
});

// x402 paywall for the catalog routes
if (FREE_MODE) {
  console.warn("FREE_MODE=true — payments are DISABLED. Do not run this in production.");
} else {
  if (!WALLET_ADDRESS) {
    console.error(
      "WALLET_ADDRESS is not set. Set it to your Base USDC receiving address, or set FREE_MODE=true to run without payments."
    );
    process.exit(1);
  }
  // Format-validate at startup so a typo'd / truncated address fails loudly
  // instead of silently directing receipts to a wrong-but-valid-looking string.
  // EIP-55 mixed-case checksum is optional (some prod stacks lowercase) — we
  // only require the 0x + 40 hex shape.
  if (!/^0x[0-9a-fA-F]{40}$/.test(WALLET_ADDRESS)) {
    console.error(
      `WALLET_ADDRESS is not a valid EVM address (expected 0x + 40 hex). Got: ${JSON.stringify(WALLET_ADDRESS).slice(0, 80)}`
    );
    process.exit(1);
  }
  const x402mw = await buildPaymentMiddleware({
    walletAddress: WALLET_ADDRESS,
    network: NETWORK,
    baseUrl: BASE_URL,
    catalog: CATALOG,
  });
  // Payment-nonce replay guard (M3, defends "Five Attacks on x402" Attack II).
  // Defense-in-depth over settle-before-grant: rejects a duplicate payment
  // authorization before it reaches the facilitator and closes the concurrent-
  // replay window. See src/replay-guard.js.
  const replayGuard = createReplayGuard();
  // Funnel stage 2 — a 402 challenge issued for a catalog route. Mounted
  // BEFORE the paywall because the paywall ends 402 responses without
  // calling next(), so the post-paywall tally middleware never sees them.
  // Rolled up in-memory (src/posthog.js) — registry crawlers sweep every
  // endpoint, so per-request events would swamp the budget.
  app.use((req, res, next) => {
    const def = CATALOG[`${req.method} ${req.path}`];
    if (def) {
      // Make the free tier DISCOVERABLE at the moment of rejection: PostHog
      // showed 2.1M 402 challenges vs 235 PoW challenges issued in 14 days —
      // the on-ramp exists but nothing at the paywall points to it. For
      // PoW-eligible tools, append an `altPayment` hint to the 402 JSON body
      // (additive — x402 clients read `accepts` and ignore unknown fields) so
      // an unfunded agent learns it can compute instead of pay.
      if (POW_SLUGS.has(def.slug)) {
        const origJson = res.json.bind(res);
        res.json = (body) => {
          if (res.statusCode === 402 && body && typeof body === "object" && !Array.isArray(body) && !body.altPayment) {
            body.altPayment = {
              protocol: "proof-of-work",
              summary: "No wallet? This tool is also payable with a few ms of CPU: solve a sha256 puzzle instead — no money, no tokens.",
              challengeUrl: `${BASE_URL}/api/pow/challenge?slug=${encodeURIComponent(def.slug)}`,
              info: `${BASE_URL}/api/pow`,
            };
          }
          return origJson(body);
        };
      }
      res.on("finish", () => {
        if (res.statusCode === 402) {
          // Classify the bounce by what the caller tried. A payment header that
          // still ended in 402 means the authorization was rejected (tried,
          // couldn't); its absence means a first-contact quote (no wallet /
          // crawl / looked-and-left). This is the couldn't-pay vs wouldn't-pay
          // split — the single most useful cut on the 402→settle drop-off.
          const paidAttempt = req.header("x-payment") || req.header("payment-signature");
          const powAttempt = req.header("x-pow-solution");
          const attempt = paidAttempt ? "usdc_failed" : powAttempt ? "pow_failed" : "none";
          capturePostHogPaywall({
            slug: def.slug,
            priceUsd: Number(String(def.price ?? "").replace(/[^0-9.]/g, "")) || 0,
            powEligible: POW_SLUGS.has(def.slug),
            synthetic: isSyntheticRequest(req),
            attempt,
          });
        }
      });
    }
    next();
  });
  // Gateway response cache, served HERE — before the paywall — so a
  // byte-identical repeat of an already-paid generation is free. Pre-payment
  // means buyer-agnostic by construction; only non-streamed 200s are ever
  // stored (see llm-gateway-kit.js). Two policies share the store:
  //   chat tiers   — explicit `cache: true` opt-in (LLM output is sampled;
  //                  a resend usually WANTS a fresh sample)
  //   /v1/embeddings — default-ON (deterministic output; `cache: false` opts out)
  // Invalid bodies fall through so the normal path produces the real 402/400.
  app.use((req, res, next) => {
    if (req.method !== "POST") return next();
    try {
      let key = null;
      if (req.path === EMBEDDINGS_PATH) {
        key = embeddingsCacheKey(req.body);
      } else if (req.body?.cache === true && req.body?.stream !== true) {
        const tierSlug = GATEWAY_TIER_BY_PATH[req.path];
        if (tierSlug) key = promptCacheKey(tierSlug, req.body);
      }
      if (key) {
        const hit = promptCacheGet(key);
        if (hit) {
          res.setHeader("X-Cache", "hit");
          res.setHeader("Cache-Control", "no-store, private");
          return res.status(200).json(hit);
        }
      }
    } catch { /* invalid input — let the paywall + handler answer honestly */ }
    next();
  });

  // Gate: for a compute-payable route, a valid proof-of-work bypasses the x402
  // paywall; otherwise the normal USDC paywall applies (and we advertise the
  // PoW alternative via a response header on its 402). PoW redemption is
  // sliding-window rate-limited per IP using the SAME limiter+policy as the
  // hosted MCP free tier (src/rate-limit.js) — otherwise a client exhausted
  // on /mcp could keep hammering /api/* with fresh PoW solutions for free.
  app.use((req, res, next) => {
    const slug = POW_ROUTES.get(`${req.method} ${req.path}`);
    if (slug) {
      const solution = req.header("x-pow-solution");
      if (solution) {
        const result = verifySolution(solution, slug);
        if (result.ok) {
          if (powHttpLimiter.check(req.ip || "unknown").limited) {
            res.setHeader("X-Pow-Rate-Limited", "true");
            res.setHeader("X-Pow-Limits", POW_LIMITS_LABEL);
            return res.status(429).json({
              error: "Free-tier rate limit reached for proof-of-work redemption. Retry later, or pay per call in USDC via x402.",
              limits: POW_LIMITS_LABEL,
              docs: `${BASE_URL}/llms.txt`,
            });
          }
          res.setHeader("X-Pow-Accepted", "true");
          return next(); // work accepted — skip the USDC paywall
        }
        res.setHeader("X-Pow-Error", result.reason);
      }
      res.setHeader("X-Pow-Challenge", `${BASE_URL}/api/pow/challenge?slug=${slug}`);
    }
    // Payment-nonce replay guard (M3, defends "Five Attacks on x402" Attack II —
    // replay / insufficient idempotency). Reached only on the genuine x402 path:
    // the PoW-accepted branch above already returned.
    // Settle-before-grant already makes an on-chain nonce single-use; this
    // rejects a duplicate authorization BEFORE the facilitator and refuses a
    // concurrent replay (same authorization fired at once, racing the settle —
    // the paper's duplicate-grant window). Release-on-failure: the nonce is only
    // marked consumed on a granted 200 (settle-before-grant ⇒ 200 means settled);
    // any non-200 releases it so a legitimate retry of the still-valid
    // authorization proceeds. Requests without a payment header (unpaid 402
    // challenges, discovery crawls) return a null key and are never guarded.
    const replayKey = paymentReplayKey(req);
    if (replayKey) {
      const verdict = replayGuard.begin(replayKey);
      if (verdict !== "ok") {
        res.setHeader("X-Payment-Replay", verdict); // "consumed" | "inflight"
        return res.status(409).json({
          error:
            "Payment authorization already used. Each x402 payment authorization (nonce) is single-use — sign a fresh authorization to make another paid call.",
          reason: verdict,
        });
      }
      let resolved = false;
      const finishGuard = () => {
        if (resolved) return;
        resolved = true;
        if (res.statusCode === 200) replayGuard.settle(replayKey);
        else replayGuard.release(replayKey); // not granted (facilitator rejected, handler errored, client aborted)
      };
      res.on("finish", finishGuard);
      res.on("close", finishGuard); // client aborted before the response finished
    }
    return x402mw(req, res, next);
  });
  console.log(`x402 payments enabled: ${NETWORK} -> ${WALLET_ADDRESS}; proof-of-work tier on ${POW_SLUGS.size} tools (difficulty ${POW_DIFFICULTY} bits)`);
}

// Tally successfully served paid-tool calls for /api/stats (best-effort; runs
// after the paywall so only paid/proven requests that return 200 are counted).
app.use((req, res, next) => {
  const def = CATALOG[`${req.method} ${req.path}`];
  if (def) {
    // Cache hygiene (M5, defends "Five Attacks on x402" Attack III — cache
    // leakage): a paid/gated response must never be storable by a shared
    // cache or CDN, or a later UNPAID caller of the same URL could be served
    // the paid result for free (validated at 100% on nginx proxy_cache in the
    // paper). Set the strongest directive on EVERY catalog route, before the
    // handler runs so it can't be forgotten per-tool. Free discovery/static
    // routes (llms.txt, landing, /api/find…) are NOT in CATALOG and keep
    // their public caching. `no-store` blocks all caches; `private` is
    // belt-and-suspenders against shared caches specifically.
    res.setHeader("Cache-Control", "no-store, private");
    res.on("finish", () => {
      // Attribute by what the gate actually ACCEPTED, not by header presence —
      // an invalid PoW header on a USDC-settled call must count as usdc.
      // Heartbeat probe attribution requires a POW_SECRET-signed X-Heartbeat-Token
      // (not just a User-Agent string, which would be spoofable). Anything that
      // claims to be the probe but lacks a valid token is counted as real PoW.
      //
      // The settle receipt: x402 v2 middleware sets PAYMENT-RESPONSE;
      // X-PAYMENT-RESPONSE was the v1 name (kept for old middleware versions).
      // getHeader is case-insensitive but NOT prefix-insensitive, so check both.
      const settleReceipt = res.getHeader("PAYMENT-RESPONSE") || res.getHeader("X-PAYMENT-RESPONSE");
      if (res.statusCode === 200) {
        const powAccepted = res.getHeader("X-Pow-Accepted") === "true";
        const isHeartbeat = powAccepted && verifyHeartbeatToken(req.header("x-heartbeat-token"));
        const method = isHeartbeat ? "heartbeat" : powAccepted ? "pow" : "usdc";
        // For USDC, also attribute the settlement chain from the settle receipt
        // (multi-chain x402: Base vs Solana vs Polygon…) so /api/stats can
        // answer "did anyone pay on <chain>" without per-chain explorer scans.
        recordServedCall(def.slug, method, method === "usdc" ? networkFromPaymentResponse(settleReceipt) : null);
        // Funnel stage 3 — the gate accepted payment and the tool answered.
        // Mirrors the stats attribution above. Skipped in FREE_MODE — nothing
        // was paid, so a "settlement" event would be a lie.
        if (!FREE_MODE) {
          const rail = method;
          const network = method === "usdc" ? networkFromPaymentResponse(settleReceipt) : null;
          const priceUsd = Number(String(def.price ?? "").replace(/[^0-9.]/g, "")) || 0;
          const synthetic = method === "heartbeat" || isSyntheticRequest(req);
          // Request-payload attribution covers EVM (EIP-3009 authorization.from);
          // SVM/Stellar payloads carry no such field, so fall back to the
          // facilitator-verified payer in the settle receipt — otherwise every
          // Solana/Stellar buyer records as null in PostHog and the sales ledger.
          const payer = payerFromRequest(req) || payerFromPaymentResponse(settleReceipt);
          // Client attribution: the User-Agent PRODUCT TOKEN only (first
          // whitespace-delimited token, ≤40 chars — e.g. "agent402-client/0.6.1",
          // "node") so payment_settled can answer "which SDK/client do paying
          // wallets use?". Never the full UA string, never an IP.
          const clientUa = String(req.headers["user-agent"] || "").trim().split(/\s+/)[0].slice(0, 40) || null;
          capturePostHogSettlement({ slug: def.slug, rail, network, priceUsd, synthetic, payer, clientUa });
          // Sales ledger — the same sale, BY NAME, persisted on /data with the
          // verified payer + settle tx so "what do external wallets actually
          // buy" is answerable forever (the question the odometer can't).
          recordSale({
            slug: def.slug, priceUsd, rail, network,
            payer,
            tx: txFromPaymentResponse(settleReceipt),
            synthetic,
          });
        }
      } else if (settleReceipt) {
        // A non-200 carrying the settle-receipt header. The receipt's `success`
        // field decides which incident this is: the middleware attaches the
        // header to settle FAILURES too (a facilitator rejection produces a 402
        // whose receipt is { success:false, errorReason }), so header presence
        // alone never means "charged" — a Robinhood settle rejection was
        // miscounted as charged-but-failed on 2026-07-16 (no USDG ever moved).
        const receipt = decodeSettleReceipt(settleReceipt);
        const priceUsd = Number(String(def.price ?? "").replace(/[^0-9.]/g, "")) || 0;
        const network = networkFromPaymentResponse(settleReceipt);
        const synthetic = isSyntheticRequest(req);
        const payer = payerFromRequest(req) || payerFromPaymentResponse(settleReceipt);
        if (receipt?.success === false) {
          // Settlement REJECTED — the buyer kept their money; we lost the
          // sale. A rail-health signal, not buyer harm: PostHog only, never
          // the local charged-failure odometer.
          capturePostHogSettleFailed({
            slug: def.slug,
            status: res.statusCode,
            network,
            priceUsd,
            synthetic,
            payer,
            errorReason: receipt.errorReason || receipt.errorMessage || null,
          });
        } else {
          // success:true — or an unreadable/legacy receipt without the field,
          // kept in this bucket ON PURPOSE: the buyer-was-charged alarm must
          // fail loud, so only an explicit success:false downgrades it.
          recordChargedFailure(def.slug, res.statusCode);
          // Mirror to PostHog with payer attribution so a spike is alertable in
          // near-real-time and traceable to a wallet (the local table keeps only
          // slug/status/ts, and the 30-min GitHub alert can't say WHO was hurt).
          capturePostHogChargedFailure({
            slug: def.slug,
            status: res.statusCode,
            network,
            priceUsd,
            synthetic,
            payer,
          });
        }
      }
    });
  }
  next();
});

// Paid routes
app.post("/api/extract", async (req, res) => {
  const { url } = req.body ?? {};
  if (!url) return res.status(400).json({ error: 'Missing "url" in JSON body' });
  try {
    res.json(await extractArticle(url));
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
  }
});

app.get("/api/meta", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing "url" query parameter' });
  try {
    res.json(await fetchPageMeta(url));
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
  }
});

app.get("/api/dns", async (req, res) => {
  const { name, type } = req.query;
  if (!name) return res.status(400).json({ error: 'Missing "name" query parameter' });
  try {
    res.json(await dnsLookup(name, type));
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
  }
});

app.post("/api/render", async (req, res) => {
  const { url } = req.body ?? {};
  if (!url) return res.status(400).json({ error: 'Missing "url" in JSON body' });
  // Abort a QUEUED render if the client hangs up, so it can't hold a browser
  // slot for work no one is waiting on (security audit A402-08). res 'close'
  // fires on disconnect OR normal completion — the writableEnded guard aborts
  // only on a real early disconnect. (req 'close' is wrong here: express.json
  // already consumed the body, so it fires immediately.)
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  try {
    res.json(await renderArticle(url, { signal: ac.signal }));
  } catch (err) {
    if (!res.headersSent) res.status(err.statusCode || 502).json({ error: err.message });
  }
});

app.get("/api/screenshot", async (req, res) => {
  const { url, fullPage } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing "url" query parameter' });
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  try {
    const png = await screenshotPage(url, { fullPage: fullPage === "true", signal: ac.signal });
    res.type("png").send(png);
  } catch (err) {
    if (!res.headersSent) res.status(err.statusCode || 502).json({ error: err.message });
  }
});

app.post("/api/pdf", async (req, res) => {
  const { url } = req.body ?? {};
  if (!url) return res.status(400).json({ error: 'Missing "url" in JSON body' });
  try {
    res.json(await pdfToText(url));
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
  }
});

// Wallet-keyed memory: the verified payer address is the caller identity.
// `actor` is who is calling; `owner` is the namespace being acted on (defaults
// to the caller's own namespace; a different owner requires a grant).
function memoryActor(req, res) {
  const payer = payerFromRequest(req);
  if (payer) return payer;
  if (FREE_MODE && req.query.ns) return `demo:${req.query.ns}`;
  res.status(400).json({
    error: "No payer identity found on this request. Pay via x402 — the paying wallet is your identity.",
  });
  return null;
}
const targetOwner = (req, actor) => {
  const o = (req.body?.owner ?? req.query.owner ?? "").toString().toLowerCase();
  return o && /^0x[0-9a-f]{40}$/.test(o) ? o : actor;
};
const memHandler = (fn) => async (req, res) => {
  // Defense in depth: the PoW gate already refuses memory routes via
  // WALLET_ONLY_SLUGS in src/pow.js, but if that set ever drifts, refuse here
  // too. Memory's whole identity model is "the paying wallet IS the caller",
  // so accepting a PoW-only request would silently let an anonymous solver
  // write to whatever owner namespace they chose.
  if (req.header("x-pow-accepted") || res.getHeader("X-Pow-Accepted")) {
    return res.status(402).json({
      error: "Memory tools are wallet-only (identity = payment). Pay via x402; proof-of-work cannot establish a namespace owner.",
    });
  }
  const actor = memoryActor(req, res);
  if (!actor) return;
  try {
    res.json(await fn(req, actor, targetOwner(req, actor)));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

app.post("/api/memory", memHandler((req, actor, owner) => {
  const { key, value, delete: del, ttlSeconds } = req.body ?? {};
  return del ? memoryDelete(owner, key, { actor }) : memoryPut(owner, key, value, { actor, ttlSeconds });
}));
app.get("/api/memory", memHandler((req, actor, owner) => memoryGet(owner, req.query.key, { actor })));

// Coordination + provenance + recall (all wallet-only; identity = payment).
app.post("/api/memory/incr", memHandler((req, actor, owner) => memoryIncr(owner, req.body?.key, req.body?.by, actor)));
app.post("/api/memory/cas", memHandler((req, actor, owner) =>
  memoryCas(owner, req.body?.key, req.body?.expected, req.body?.value, { actor, ttlSeconds: req.body?.ttlSeconds, hasValue: "value" in (req.body || {}) })
));
app.post("/api/memory/grant", memHandler((req, actor) => grant(actor, req.body?.grantee, req.body?.mode, req.body?.ttlSeconds)));
app.post("/api/memory/revoke", memHandler((req, actor) => revoke(actor, req.body?.grantee)));
app.get("/api/memory/grants", memHandler((req, actor) => listGrants(actor)));
app.get("/api/memory/log", memHandler((req, actor, owner) => getLog(owner, actor, parseInt(req.query.limit, 10) || 100)));
app.post("/api/memory/remember", memHandler((req, actor, owner) => remember(owner, req.body?.text, req.body?.meta, { actor })));
app.post("/api/memory/recall", memHandler((req, actor, owner) => recall(owner, req.body?.query, req.body?.k, { actor })));
app.post("/api/memory/forget", memHandler((req, actor, owner) => forget(owner, req.body?.id, { actor })));

// Kit routes: input is merged query + JSON body; handlers return JSON or
// { __binary, contentType } for image responses.
//
// Two cross-cutting features wrap every handler:
//   1. Redis response cache for routes listed in CACHEABLE_ROUTES (GET-only,
//      200-only, non-binary, non-error). No-op when REDIS_URL is unset.
//      Sets X-Cache: hit|miss|skip for transparency.
//   2. Analytics write-through: records slug, latency, cache flag, error flag
//      to Postgres after responding. Fire-and-forget, never blocks the call.
//      No-op when ANALYTICS_DATABASE_URL (or DATABASE_URL) is unset.
for (const tool of ALL_KIT) {
  const [method, path] = tool.route.split(" ");
  const lowerMethod = method.toLowerCase();
  const cachePolicy = lowerMethod === "get" ? CACHEABLE_ROUTES[path] : null;

  app[lowerMethod](path, async (req, res) => {
    const startedAt = Date.now();
    // Unspoofable: requires a valid HMAC-signed X-Heartbeat-Token. CI canaries,
    // heartbeat probes, and operator smoke tests carry it; real callers don't.
    // Threaded into analytics + Sentry + PostHog so test traffic never inflates
    // the public error rate (see /api/analytics ?include_synthetic to override).
    const synthetic = isSyntheticRequest(req);
    const payer = payerFromRequest(req);
    let cached = false;
    let errored = false;
    let probe = false;
    let status = 200;
    try {
      const input = { ...req.query, ...(req.body ?? {}) };
      // Accept MCP-style envelopes posted directly to the HTTP route. Agents
      // frequently mirror the shape they use over /mcp ({slug, params:{…}})
      // into POST /api/<slug> bodies, or wrap fields in {input:{…}} /
      // {args:{…}}. Unwrap once at the dispatcher so every tool accepts both
      // the flat shape AND the wrapped shape without per-tool code. Top-level
      // fields win on conflict — explicit beats nested.
      for (const wrap of ["params", "input", "args"]) {
        const inner = input[wrap];
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          for (const [k, v] of Object.entries(inner)) {
            if (input[k] === undefined) input[k] = v;
          }
        }
      }

      let cacheKey = null;
      if (cachePolicy && cacheEnabled()) {
        cacheKey = cacheKeyFor(path, input, cachePolicy.keyFields || []);
        const hit = await cacheGet(cacheKey);
        if (hit !== null) {
          cached = true;
          noteCacheOutcome("hit");
          res.setHeader("X-Cache", "hit");
          return res.json(hit);
        }
      }

      const result = await tool.handler(input, req);

      if (cachePolicy) {
        noteCacheOutcome(cacheKey ? "miss" : "skip");
        res.setHeader("X-Cache", cacheKey ? "miss" : "skip");
      }
      if (result && result.__binary) return res.type(result.contentType).send(result.__binary);
      // SSE escape hatch (LLM gateway streaming): the handler returns a
      // writer instead of a body and takes over the response. Runs after the
      // paywall settled; never cached (idempotency hooks res.json only).
      if (result && typeof result.__sse === "function") { await result.__sse(res); return; }

      // Cache successful, non-error JSON responses. Errors are never cached —
      // an upstream blip shouldn't poison the key for the whole TTL.
      if (cacheKey && result && typeof result === "object" && !result.error) {
        cacheSet(cacheKey, result, cachePolicy.ttl || 300).catch(() => {});
      }
      res.json(result);
    } catch (err) {
      errored = true;
      status = err.statusCode || 500;
      if (res.headersSent) { try { res.end(); } catch { /* stream already gone */ } return; }
      // Probe detection: a 4xx with zero meaningful input keys is a scanning/
      // discovery call (agent probing endpoints without arguments), not a real
      // schema mismatch. Tag it so the dashboard can exclude it from error rates.
      const shape = status < 500 ? requestShape(req) : null;
      if (status >= 400 && status < 500) {
        const meaningfulKeys = (shape || []).filter((k) => !["b:params", "b:input", "b:args", "b:slug"].includes(k));
        probe = meaningfulKeys.length === 0;
      }
      logToolError(tool.slug, status, err.message, shape, synthetic, probe);
      // Self-correction envelope: echo the tool's input schema + a working
      // example back on 4xx so the LLM has everything it needs to fix the
      // call without searching the catalog again. 5xx stays minimal — the
      // caller did nothing wrong, no schema hint is useful there.
      if (status >= 400 && status < 500) {
        res.status(status).json({
          error: err.message,
          tool: tool.slug,
          expected: tool.discovery?.inputSchema?.properties || {},
          required: tool.discovery?.inputSchema?.required || [],
          example: tool.discovery?.input || {},
        });
      } else {
        res.status(status).json({ error: err.message });
      }
    } finally {
      const latencyMs = Date.now() - startedAt;
      // Fire-and-forget. Analytics outages must NEVER affect agents.
      recordToolCall({ slug: tool.slug, latencyMs, cached, errored, status, synthetic, probe }).catch(() => {});
      capturePostHogToolCall({ slug: tool.slug, latencyMs, cached, errored, status, synthetic, probe, payer });
    }
  });
}

// Last-resort error handler. Express's default returns an HTML page with the
// full stack trace, leaking absolute file paths and module structure. For API
// routes (anything starting with /api or /__operator) return a small JSON
// error; for HTML routes return a tiny page. Never expose `err.stack` to the
// network. Has to be defined after every other route + middleware.
app.use((err, req, res, _next) => {
  if (res.headersSent) return; // already started streaming — let it go
  const status = err && typeof err.statusCode === "number" ? err.statusCode
              : err && typeof err.status === "number" ? err.status
              : err && err.type === "entity.too.large" ? 413
              : err && err.type === "entity.parse.failed" ? 400
              : 500;
  // Server-side visibility for real faults: a 5xx that reaches this handler
  // was thrown outside any tool handler and would otherwise vanish (the
  // client just sees {"error":"internal"}). Log message + stack to the
  // console only — never to the network.
  if (status >= 500) {
    console.error(`[unhandled-5xx] ${req.method} ${req.path} → ${status}: ${err?.message || err}`);
    if (err?.stack) console.error(String(err.stack).split("\n").slice(0, 6).join("\n"));
  }
  const wantsJson = req.path.startsWith("/api") || req.path.startsWith("/__operator") || req.accepts(["html", "json"]) === "json";
  if (wantsJson) {
    res.status(status).json({ ok: false, error: status === 400 ? "bad-request" : status === 413 ? "payload-too-large" : status === 429 ? "rate-limited" : "internal" });
  } else {
    const is404 = status === 404;
    const t = is404 ? "Page not found" : `Error ${status}`;
    const m = is404 ? "The page you\u2019re looking for doesn\u2019t exist." : "Something went wrong. Try again in a moment.";
    res.status(status).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${CHROME_HEAD_LINKS}<title>${t} \u2014 Agent402</title><style>${CHROME_CSS}:root{--bg:#0b0e14;--text:#e6e9f0;--muted:#8b93a7;--accent:#4ade80;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,sans-serif}.e{max-width:600px;margin:0 auto;padding:80px 20px;text-align:center}.e .code{font:700 5rem/1 var(--mono);color:var(--accent);text-shadow:0 0 30px rgba(74,222,128,.3);margin-bottom:16px}.e h1{font-size:1.5rem;margin:0 0 12px}.e p{color:var(--muted);margin:0 0 28px}.e a.btn{display:inline-block;padding:10px 20px;background:var(--accent);color:#06210f;border-radius:10px;text-decoration:none;font-weight:600;margin:0 6px}.e a.ghost{background:transparent;border:1px solid #2a3550;color:var(--text)}.e a.ghost:hover{border-color:var(--accent)}.e .links{margin-top:32px;color:var(--muted);font-size:.9rem}.e .links a{color:var(--accent);margin:0 8px}</style></head><body>${renderHeader("")}<div class="e"><div class="code">${status}</div><h1>${t}</h1><p>${m}</p><a class="btn" href="/">Home</a><a class="btn ghost" href="/tools">Browse tools</a><a class="btn ghost" href="/api/find">Find a tool</a><div class="links">or try: <a href="/playground">Playground</a><a href="/docs">Docs</a><a href="/quickstart">Quickstart</a></div></div>${renderFooter()}</body></html>`);
  }
});

const httpServer = app.listen(PORT, () =>
  console.log(`Agent402 listening on :${PORT} with ${Object.keys(CATALOG).length} paid tools`)
);

// All-time revenue ledger sync loop — self-gates on /data (prod volume) or
// REVENUE_LEDGER=true, so test/CI boots never touch public RPCs.
startRevenueLedger({ walletAddress: WALLET_ADDRESS, solanaWallet: (process.env.SOLANA_WALLET_ADDRESS || "").trim() || null, stellarWallet: (process.env.STELLAR_WALLET_ADDRESS || "").trim() || null, algorandWallet: (process.env.ALGORAND_WALLET_ADDRESS || "").trim() || null });

// Tollbooth leads — lazy Postgres init. No-op if DATABASE_URL is unset; in
// that case /api/tollbooth/waitlist returns 503 and the form falls back to the
// GitHub pre-fill flow. Status is surfaced via /health so we can verify the
// Railway DATABASE_URL wiring without poking the live leads table.
let leadsDbReady = false;
initLeadsDb().then((r) => {
  leadsDbReady = !!r.ok;
  if (r.ok) console.log("[leads-db] tollbooth_leads schema ready");
  else console.log(`[leads-db] disabled (${r.reason || "unknown"})`);
});

// Tool-call analytics — lazy Postgres init. Same pattern as leads-db: if no
// ANALYTICS_DATABASE_URL (and no DATABASE_URL to fall back to) it's a no-op.
// Powers the public /analytics dashboard. Boot fire-and-forget so a slow DB
// can't hold up /health.
initAnalyticsDb().then((r) => {
  if (r.ok) console.log("[analytics-db] tool_calls schema ready");
  else console.log(`[analytics-db] disabled (${r.reason || "unknown"})`);
});

// Sentry — opt-in via SENTRY_DSN. Same env-gated, fire-and-forget pattern
// as the other optional infra. Captures tool errors with slug + status + the
// keys-only shape as searchable tags. No values, no IPs, no headers.
const sentryInit = initSentry();
if (sentryInit.ok) console.log("[sentry] enabled");
else console.log(`[sentry] disabled (${sentryInit.reason || "unknown"})`);

// PostHog — opt-in via POSTHOG_API_KEY. Same env-gated, fire-and-forget
// pattern as Sentry. Captures tool errors as "tool_error" events. Free tier
// is generous (1M events/mo), and the same key powers product analytics and
// session replay later without code changes.
const posthogInit = initPostHog();
if (posthogInit.ok) console.log("[posthog] enabled");
else console.log(`[posthog] disabled (${posthogInit.reason || "unknown"})`);

// x402 Index crawler: warms the cross-seller cache used by /index + /api/route.
// Seeds come from X402_INDEX_SEEDS (comma-separated origins) plus auto-discovered
// origins pulled from public x402 registries (Coinbase CDP Bazaar, etc.).
// selfOrigin is passed so the discovery feeder skips our own listings. Fire-and-
// forget so a slow upstream can't delay boot or /health.
startCrawler({ selfOrigin: BASE_URL });

// Warm the revenue snapshot at boot (fire-and-forget): revenueSnapshot serves
// stale-while-revalidating, so the only request that could ever block on the
// full seven-rail RPC scan is the very first one after a deploy — this warm
// takes even that hit off buyers' pageviews.
revenueSnapshot(revenueWallets()).catch(() => { /* first pageview warms instead */ });

// x402 Leaderboard cache: warms once at boot, refreshes hourly. Failures keep
// the previous good snapshot rather than wiping it — a transient RPC outage
// shouldn't make /api/leaderboard return nothing. Fire-and-forget so a slow
// Bazaar walk can't delay boot or /health.
startLeaderboardRefresh();

// Graceful shutdown: a Railway redeploy sends SIGTERM. Stop accepting new
// connections but let in-flight (already paid-for) requests finish before
// exiting — a hard kill would take an agent's money and return nothing.
// This only works if the platform grants a grace period: Railway defaults to
// 0 seconds between SIGTERM and SIGKILL, so the deploy pipeline sets
// RAILWAY_DEPLOYMENT_DRAINING_SECONDS=90 (self-hosters: set it too, or this
// drain never runs). The hard deadline below stays under that grace and
// above the slowest single-call upstream timeout (transcribe: 60s OpenAI).
let shuttingDown = false;
// `code`/`deadlineMs` default to the graceful-redeploy values (exit 0, 75s to
// cover the slowest upstream). The fatal path below reuses this with a non-zero
// code and a short deadline — same drain machinery, different exit semantics.
function shutdown(signal, { code = 0, deadlineMs = 75_000 } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — draining in-flight requests (exit ${code})`);
  // Drain the PostHog paywall_402 rollup + client queue so a redeploy doesn't
  // drop up to a flush window of funnel counts. Fire-and-forget (no-op when
  // PostHog is disabled); the drain deadline below still governs exit.
  shutdownPostHog().catch(() => {});
  httpServer.close(() => process.exit(code));
  // server.close() waits for ALL connections, including idle keep-alive
  // sockets agents hold open between calls. Sweep those now and every few
  // seconds (a socket goes idle the moment its in-flight response finishes),
  // so an idle connection can't pin the drain to the hard deadline.
  httpServer.closeIdleConnections();
  setInterval(() => httpServer.closeIdleConnections(), 5_000).unref();
  // Hard deadline so a stuck request can't block the redeploy.
  setTimeout(() => process.exit(code), deadlineMs).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// An unhandled promise rejection doesn't corrupt synchronous global state the
// way an uncaught exception does — and in this async-heavy, fire-and-forget
// codebase (telemetry, cache warmers) a rejection is usually a stray background
// task, not a poisoned process. Log and keep serving; the request path is
// already try/caught, so a rejection here is the unexpected tail.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? reason.stack : reason);
});
// An uncaught exception leaves the process in an UNDEFINED state (Node's own
// guidance), so continuing to serve payments from it is unsafe (security audit
// A402-10). Make it fatal: drain in-flight, already-paid requests briefly, then
// force a NON-ZERO exit so Railway restarts a clean process. The deadline is
// short and the path is deliberately simple — we do not trust global state
// after the exception, so we neither linger the full redeploy grace nor depend
// on complex teardown. If the drain setup itself throws, exit immediately.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] fatal — draining then exiting non-zero:", err?.stack || err);
  try {
    shutdown("uncaughtException", { code: 1, deadlineMs: 10_000 });
  } catch {
    process.exit(1);
  }
});
