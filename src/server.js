import express from "express";
import { readFileSync } from "node:fs";
import { extractArticle, fetchPageMeta } from "./tools/extract.js";
import { dnsLookup } from "./tools/dns.js";
import { pdfToText } from "./tools/pdf.js";
import { renderArticle, screenshotPage, rasterizeSvg } from "./tools/render.js";
import {
  memoryPut, memoryGet, memoryDelete, memoryIncr, memoryCas,
  grant, revoke, listGrants, getLog, remember, recall, forget,
} from "./tools/memory.js";
import { payerFromRequest } from "./payer.js";
import { landingPage } from "./landing.js";
import { statusPage } from "./status.js";
import { tollboothLandingPage } from "./tollbooth-landing.js";
import { tollboothCloudPage } from "./tollbooth-cloud.js";
import { tollboothWaitlistPage } from "./tollbooth-waitlist.js";
import { operatorLeadsPage } from "./operator-leads.js";
import { initLeadsDb, insertLead, listLeads, countLeads, leadsDbEnabled } from "./leads-db.js";
import { cacheEnabled, cacheGet, cacheSet, cacheKeyFor, CACHEABLE_ROUTES, noteCacheOutcome, cacheCounters } from "./cache.js";
import { initAnalyticsDb, recordToolCall, getAnalytics, analyticsEnabled } from "./analytics-db.js";
import { initSentry, captureToolError, sentryEnabled } from "./sentry.js";
import { initPostHog, capturePostHogToolError, posthogEnabled } from "./posthog.js";
import { analyticsPage } from "./analytics-page.js";
import { operatorPage } from "./operator.js";
import { privacyPage } from "./privacy.js";
import { termsPage } from "./terms.js";
import { robotsTxt, sitemapXml, llmsTxt } from "./seo.js";
import { serviceManifest, reliabilityReport } from "./discovery.js";
import { findTools } from "./find.js";
import { indexPage, indexSnapshot, routeQuery, startCrawler } from "./x402-index.js";
import { getLeaderboardSnapshot, startLeaderboardRefresh, leaderboardPage } from "./leaderboard.js";
import { buildPaymentMiddleware, enabledNetworks } from "./payments.js";
import { KIT } from "./tools/kit.js";
import { KIT2 } from "./tools/kit2.js";
import { CONVERSIONS } from "./tools/convert-gen.js";
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
import { UTIL_TOOLS } from "./tools/util-kit.js";
import { API_TOOLS } from "./tools/api-kit.js";
import { MACRO_TOOLS } from "./tools/macro-kit.js";
import { EDGAR_TOOLS } from "./tools/edgar-kit.js";
import { toolPage, toolsIndexPage, openapiSpec, toolList, CATEGORIES, faqPage } from "./pages.js";
import { mountMcp } from "./mcp-http.js";
import { guidesIndex, guidePage } from "./guides.js";

const ALL_KIT = [...KIT, ...KIT2, ...CONVERSIONS, ...SEARCH_TOOLS, ...PDF_TOOLS, ...DEMAND_TOOLS, ...MEDIA_TOOLS, ...GOV_TOOLS, ...GEO_TOOLS, ...OCR_TOOLS, ...AGENT_TOOLS, ...BARCODE_TOOLS, ...DATA_TOOLS, ...IMAGE_TOOLS, ...X402_TOOLS, ...UTIL_TOOLS, ...API_TOOLS, ...MACRO_TOOLS, ...EDGAR_TOOLS];
import { issueChallenge, verifySolution, isComputePayable, powInfo, POW_DIFFICULTY, WALLET_ONLY_SLUGS, verifyHeartbeatToken } from "./pow.js";
import { createLimiter as createRateLimiter, LIMITS_LABEL as POW_LIMITS_LABEL } from "./rate-limit.js";

// Shared with the MCP free tier (src/mcp-http.js) — same policy, separate
// per-IP bucket. PoW redemption on the direct HTTP path goes through here.
const powHttpLimiter = createRateLimiter("pow-http");
import { recordServedCall, recordChargedFailure, getStats, getOperatorBreakdown, dbHealthy } from "./stats.js";
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { marketplaceSlugToken } from "./marketplace-token.js";

const PORT = process.env.PORT || 3000;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
// Human-readable Base name for the receiving wallet (resolves to WALLET_ADDRESS).
// Display/branding only — the x402 payTo is always the resolved 0x address.
const WALLET_ENS = process.env.WALLET_ENS || "agent402.base.eth";
const NETWORK = process.env.NETWORK || "base";
const FREE_MODE = process.env.FREE_MODE === "true";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Marketplace bridge (agent402.app): that platform IS the paywall — it collects
// the caller's USDC (settled directly to our wallet) and then forwards the call
// to the endpoint we registered. So those forwarded calls must skip our own
// x402 paywall. Off unless MARKETPLACE_TOKEN is set.
//
// The master MARKETPLACE_TOKEN is NEVER placed in a URL. Each registered
// service_endpoint instead carries a PER-SLUG token = HMAC(master, slug): it
// authorizes exactly one tool, so a leaked endpoint (their on-chain metadata is
// public) grants free access to that single tool, not the whole catalog, and
// reveals nothing about the master secret. The bypass header the gate honors is
// also per-slug-derived and only set on internally-forwarded requests.
const MARKETPLACE_TOKEN = process.env.MARKETPLACE_TOKEN || "";
const marketplaceTokenOk = (t) => {
  if (!MARKETPLACE_TOKEN || typeof t !== "string") return false;
  const a = Buffer.from(t);
  const b = Buffer.from(MARKETPLACE_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};
// HMAC(master, slug), hex-truncated — the token that actually appears in a URL.
// Shared with the registration/verify scripts via src/marketplace-token.js.
const marketplaceSlugTokenOk = (token, slug) => {
  if (!MARKETPLACE_TOKEN || typeof token !== "string") return false;
  const a = Buffer.from(token);
  const b = Buffer.from(marketplaceSlugToken(MARKETPLACE_TOKEN, slug));
  return a.length === b.length && timingSafeEqual(a, b);
};

const CATALOG = {
  "POST /api/extract": {
    name: "Extract article",
    slug: "extract",
    category: "web",
    price: "$0.005",
    description:
      "Extract the main article content from any public URL as clean markdown. Returns title, byline, excerpt, word count, and markdown.",
    tags: ["scraping", "markdown", "content-extraction"],
    discovery: {
      bodyType: "json",
      input: { url: "https://example.com/article" },
      inputSchema: {
        properties: { url: { type: "string", description: "Public http(s) URL to extract" } },
        required: ["url"],
      },
      output: {
        example: {
          url: "https://example.com/article",
          title: "Article title",
          byline: "Author",
          excerpt: "Short summary…",
          wordCount: 850,
          markdown: "# Article title\n\nBody…",
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
      input: { url: "https://example.com/whitepaper.pdf" },
      inputSchema: {
        properties: { url: { type: "string", description: "Public http(s) URL of a PDF" } },
        required: ["url"],
      },
      output: {
        example: { url: "https://example.com/whitepaper.pdf", pages: 12, info: { title: "Whitepaper" }, wordCount: 4800, text: "…" },
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
      input: { key: "research/task-42" },
      inputSchema: {
        properties: {
          key: { type: "string", description: "Key to read; omit to list all keys" },
          owner: { type: "string", description: "Optional 0x namespace to read (requires a grant)" },
        },
      },
      output: { example: { key: "research/task-42", value: { status: "done" }, updated: 1760000000000, owner: "0x…" } },
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
// Behind Railway's single edge proxy: trust exactly that hop so req.ip is the
// real client IP (the X-Forwarded-For entry the edge appends), not an
// attacker-supplied XFF value. This is what the per-IP rate limiters key on,
// so spoofing it must not mint a fresh bucket. Tune for other topologies.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS) || 1);
app.use(express.json({ limit: "100kb" }));

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
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
  );
  next();
});

// Free, unauthenticated routes
// Sets browser/CDN cache headers for static-ish HTML pages so clicking around
// the top nav doesn't re-render the world every time. stale-while-revalidate
// gives instant back/forward while a background refresh keeps content fresh.
const htmlCache = (res, maxAge, swr) =>
  res.set("Cache-Control", `public, max-age=${maxAge}, stale-while-revalidate=${swr}`).type("html");
app.get("/", (_req, res) =>
  htmlCache(res, 60, 300).send(
    landingPage(BASE_URL, NETWORK, FREE_MODE, CATALOG, getStats({ wallet: WALLET_ADDRESS, walletName: WALLET_ENS, network: NETWORK, toolCount: Object.keys(CATALOG).length, baseUrl: BASE_URL, prices: TOOL_PRICES }))
  )
);
// Real health check — fails (503) when a load balancer or heartbeat should
// route around this instance. Verifies the stats DB is readable and that the
// payment configuration is intact (wallet present unless we're explicitly in
// FREE_MODE). Kept O(1) so a flood of probes can't degrade the service.
app.get("/health", (_req, res) => {
  const checks = {
    db: dbHealthy(),
    wallet: FREE_MODE || Boolean(WALLET_ADDRESS),
  };
  // Non-fatal flags — surface tollbooth-leads wiring so we can verify the
  // Railway DATABASE_URL / AGENT402_OPERATOR_TOKEN env without poking either.
  // These don't affect overall ok status; the tollbooth waitlist is optional.
  const flags = {
    leadsDb: leadsDbReady,
    operatorToken: Boolean(OPERATOR_TOKEN),
    sentry: sentryEnabled(),
    posthog: posthogEnabled(),
  };
  const ok = checks.db && checks.wallet;
  res.status(ok ? 200 : 503).json({ ok, checks, flags });
});
// Glama connector ownership verification: claims our listing at
// glama.ai/mcp/connectors/io.github.MikeyPetrillo/agent402. The maintainer email
// must match the Glama account — set it via the GLAMA_MAINTAINER_EMAIL env var
// (kept out of source so a personal address isn't committed/served by default).
app.get("/.well-known/glama.json", (_req, res) => {
  const email = process.env.GLAMA_MAINTAINER_EMAIL;
  res.json({
    $schema: "https://glama.ai/mcp/schemas/connector.json",
    maintainers: email ? [{ email }] : [],
  });
});
app.get("/privacy", (_req, res) => htmlCache(res, 300, 900).send(privacyPage(BASE_URL)));
app.get("/terms", (_req, res) => htmlCache(res, 300, 900).send(termsPage(BASE_URL)));
app.get("/faq", (_req, res) => htmlCache(res, 300, 900).send(faqPage(BASE_URL)));
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
// Token is accepted via Authorization: Bearer or X-Operator-Token header
// (preferred — keeps the secret out of access logs, browser history, Referer)
// or ?token= query (legacy, for the initial magic-link click — the dashboard
// HTML strips it from the URL on load and uses header auth for everything
// else, so the secret only ever appears in one access-log line per session).
const OPERATOR_TOKEN = process.env.AGENT402_OPERATOR_TOKEN || "";
const operatorTokenOk = (t) => {
  if (!OPERATOR_TOKEN || typeof t !== "string") return false;
  const a = Buffer.from(t);
  const b = Buffer.from(OPERATOR_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};
const getOperatorToken = (req) => {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  const hdr = req.headers["x-operator-token"];
  if (typeof hdr === "string") return hdr;
  if (typeof req.query.token === "string") return req.query.token;
  return "";
};
app.get("/__operator", (req, res) => {
  if (!operatorTokenOk(getOperatorToken(req))) return res.status(404).type("html").send("<p>Not found.</p>");
  res.type("html").send(operatorPage(BASE_URL, getOperatorBreakdown({ prices: TOOL_PRICES, walletOnlySet: WALLET_ONLY_SLUGS })));
});
app.get("/__operator/stats", (req, res) => {
  if (!operatorTokenOk(getOperatorToken(req))) return res.status(404).json({ error: "Not found" });
  res.json(getOperatorBreakdown({ prices: TOOL_PRICES, walletOnlySet: WALLET_ONLY_SLUGS }));
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
const computeFind = (q, k) => findTools(CATALOG, q, { k, baseUrl: BASE_URL, powSlugs: POW_SLUGS });
const findCachePath = "/api/find";
const findCachePolicy = CACHEABLE_ROUTES[findCachePath];

// Diagnostic log for tool errors. Lets us spot patterns like "100% of /api/whois
// calls fail in 1ms" without leaking PII — only slug + HTTP status + the error
// message we already serialize to the response body. No body, no IP, no UA.
// 4xx = caller sent bad input; 5xx = our tool or its upstream broke.
function logToolError(slug, status, message, shape, synthetic) {
  const klass = status >= 500 ? "5xx" : status >= 400 ? "4xx" : "err";
  // Log the request's TOP-LEVEL KEYS (no values, no IPs, no payment info) on
  // 4xx so we can spot shape-mismatch patterns the schema didn't anticipate.
  // Keys are bounded — privacy-safe and small.
  const shapeStr = shape && Array.isArray(shape) && shape.length ? ` shape=[${shape.slice(0, 12).join(",")}]` : "";
  const synthStr = synthetic ? " synthetic=true" : "";
  console.error(`[tool-error] ${klass} slug=${slug} status=${status}${shapeStr}${synthStr} msg=${String(message || "").slice(0, 200)}`);
  // Sentry mirrors the same data as searchable tags so we can query/trend
  // rejected shapes from the Sentry UI. No-op when SENTRY_DSN is unset.
  captureToolError({ slug, status, message, shape, synthetic });
  // PostHog mirrors the same payload as a "tool_error" event with slug/
  // status/errorClass/shape properties. Same privacy posture, same no-op
  // behavior when POSTHOG_API_KEY is unset. Independent of Sentry — either,
  // both, or neither can be enabled at any time.
  capturePostHogToolError({ slug, status, message, shape, synthetic });
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
    recordToolCall({
      slug: analyticsSlug,
      latencyMs: Date.now() - startedAt,
      cached,
      errored,
      status,
      synthetic,
    }).catch(() => {});
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
// Snapshot memo. indexSnapshot iterates the full CATALOG (~1100 tools) and the
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
app.get("/index", (_req, res) =>
  htmlCache(res, 60, 300).send(indexPage(getIndexSnapshot(), { baseUrl: BASE_URL }))
);
app.get("/api/index", (_req, res) =>
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300").json(getIndexSnapshot())
);
const computeRoute = (q, k, include) => routeQuery({ query: q, top: k, include, ...indexCtx() });
const routeCachePath = "/api/route";
const routeCachePolicy = CACHEABLE_ROUTES[routeCachePath];
app.get("/api/route", (req, res) => {
  const q = req.query.q ?? req.query.task ?? req.query.query;
  const top = req.query.top ?? req.query.k;
  const include = req.query.include;
  return serveCachedDiscovery(routeCachePath, routeCachePolicy, { q, task: q, query: q, top, k: top, include }, () => computeRoute(q, top, include), "_route", req, res);
});
app.post("/api/route", (req, res) => {
  const q = req.body?.q ?? req.body?.task ?? req.body?.query;
  const top = req.body?.top ?? req.body?.k;
  const include = req.body?.include;
  return serveCachedDiscovery(routeCachePath, routeCachePolicy, { q, task: q, query: q, top, k: top, include }, () => computeRoute(q, top, include), "_route", req, res);
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
//   window   requested window hint: "24h" (default, currently the only one
//            served), "7d" / "30d" / "all" are documented but currently fall
//            back to the active snapshot — wider windows require a separate
//            deep-cache pipeline (roadmap). The response always reports the
//            window actually served in `windowLabel` + `windowRequested`.
const SUPPORTED_WINDOWS = new Set(["24h", "7d", "30d", "all"]);
app.get("/api/leaderboard", (req, res) => {
  const snap = getLeaderboardSnapshot();
  const top = Math.min(Math.max(parseInt(req.query.top, 10) || 25, 1), 500);
  const include = req.query.include === "external" ? "external" : "all";
  const self = (req.query.self || WALLET_ADDRESS || "").toLowerCase();
  const requested = String(req.query.window || "").toLowerCase();
  const windowRequested = SUPPORTED_WINDOWS.has(requested) ? requested : "24h";
  let board = snap.leaderboard || [];
  if (include === "external" && self) board = board.filter((r) => r.wallet !== self);
  res.json({
    ...snap,
    include,
    windowRequested,
    windowServed: snap.windowLabel || "24h",
    leaderboard: board.slice(0, top),
    totalSellers: (snap.leaderboard || []).length,
  });
});
// Human-readable companion to /api/leaderboard. Same cached snapshot, rendered
// as a dashboard so visitors (and the site nav) have something to land on.
app.get("/leaderboard", (_req, res) => htmlCache(res, 60, 300).send(leaderboardPage(getLeaderboardSnapshot(), { baseUrl: BASE_URL })));
app.get("/robots.txt", (_req, res) => res.type("text/plain").send(robotsTxt(BASE_URL)));
app.get("/sitemap.xml", (_req, res) => res.type("application/xml").send(sitemapXml(BASE_URL, CATALOG)));
app.get("/llms.txt", (_req, res) => res.type("text/plain").send(llmsTxt(BASE_URL, CATALOG)));
// The runnable buyer demo, served from the site itself (the repo is private,
// so "git clone" is not a path a visitor can take).
app.get("/demo.js", (_req, res) =>
  res.type("text/javascript").send(readFileSync(new URL("../scripts/demo-payment.js", import.meta.url), "utf-8"))
);

// Brand mark — the same 402 glyph as the favicon, at logo size. The PNG is
// rasterized once via the existing headless Chromium and cached for the
// process lifetime (marketplaces and link previews often refuse SVG).
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#0b0e14"/><text x="256" y="295" font-size="170" font-weight="700" font-family="ui-monospace,Menlo,monospace" text-anchor="middle" fill="#4ade80">402</text><text x="256" y="408" font-size="42" font-family="ui-monospace,Menlo,monospace" text-anchor="middle" fill="#8b93a7">agent402.tools</text></svg>`;
app.get("/logo.svg", (_req, res) => res.type("image/svg+xml").send(LOGO_SVG));

// Marketplace bridge endpoint. agent402.app POSTs the caller's JSON body here
// after collecting payment; we authenticate via the PER-SLUG token in the path
// (HMAC(master, slug) — the master secret is never in any URL), adapt the body
// to the tool's own method, and serve the result with the paywall bypassed. A
// leaked endpoint thus only exposes its one tool. A coarse global rate limit
// bounds abuse. Off unless MARKETPLACE_TOKEN set.
if (MARKETPLACE_TOKEN) {
  // The bridge dispatches paid tool calls forwarded by the marketplace. It must
  // NOT be able to reach wallet-keyed memory tools: those are identity-scoped to
  // the paying wallet, and a bridged call carries no payer. Exclude them so the
  // bridge's safety doesn't rest on a downstream "no payer -> 400" check.
  const slugToRoute = new Map();
  for (const [route, def] of Object.entries(CATALOG)) {
    if (def.slug.startsWith("memory-")) continue;
    slugToRoute.set(def.slug, route);
  }
  let mktCount = 0;
  let mktWindow = Date.now();
  const MKT_PER_MIN = Math.min(Math.max(parseInt(process.env.MARKETPLACE_RATE_PER_MIN, 10) || 600, 10), 100000);

  app.all("/mkt/:token/:slug", async (req, res) => {
    // Token in the path is scoped to this exact slug — not the master secret.
    if (!marketplaceSlugTokenOk(req.params.token, req.params.slug)) {
      return res.status(404).json({ error: "Not found" });
    }
    const route = slugToRoute.get(req.params.slug);
    if (!route) return res.status(404).json({ error: `Unknown service "${req.params.slug}"` });
    const now = Date.now();
    if (now - mktWindow > 60000) { mktCount = 0; mktWindow = now; }
    if (++mktCount > MKT_PER_MIN) return res.status(429).json({ error: "Marketplace rate limit" });

    const [method, path] = route.split(" ");
    const input = { ...(req.query || {}), ...(req.body || {}) };
    const headers = { "X-Mkt-Bypass": MARKETPLACE_TOKEN };
    let target = `http://127.0.0.1:${PORT}${path}`;
    let body;
    if (method === "GET") {
      const qs = new URLSearchParams(
        Object.entries(input).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])
      ).toString();
      if (qs) target += `?${qs}`;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(input);
    }
    try {
      const r = await fetch(target, { method, headers, body });
      const ct = r.headers.get("content-type") || "application/json";
      const buf = Buffer.from(await r.arrayBuffer());
      res.status(r.status).type(ct).send(buf);
    } catch (err) {
      res.status(502).json({ error: `Bridge dispatch failed: ${err.message}` });
    }
  });
  console.log(`Marketplace bridge enabled at /mkt/<per-slug-token>/<slug> (${MKT_PER_MIN}/min cap)`);
}
let logoPngCache = null;
app.get("/logo.png", async (_req, res) => {
  try {
    logoPngCache ??= await rasterizeSvg(LOGO_SVG, 512);
    res.type("image/png").send(logoPngCache);
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
  res.type("image/svg+xml").set("Cache-Control", "public, max-age=86400").send(LOGO_SVG)
);
app.get("/favicon.ico", async (_req, res) => {
  try {
    logoPngCache ??= await rasterizeSvg(LOGO_SVG, 512);
    res.type("image/png").set("Cache-Control", "public, max-age=86400").send(logoPngCache);
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#0b0e14"/>
  <g transform="translate(${tx},${ty}) scale(${s})">
  <rect x="40" y="40" width="1120" height="550" rx="28" fill="none" stroke="#1e2638" stroke-width="2"/>
  <rect x="86" y="96" width="150" height="150" rx="30" fill="#000" stroke="#1f4a1d" stroke-width="2"/>
  <text x="161" y="186" font-size="56" font-weight="700" font-family="ui-monospace,Menlo,monospace" text-anchor="middle" fill="#4ade80">402</text>
  <text x="86" y="350" font-size="74" font-weight="800" font-family="system-ui,-apple-system,sans-serif" fill="#e6e9f0">Where agents pay agents<tspan fill="#4ade80">.</tspan></text>
  <text x="88" y="416" font-size="33" font-family="system-ui,-apple-system,sans-serif" fill="#8b93a7">The browser, search &amp; memory your agent's sandbox doesn't have.</text>
  <text x="88" y="492" font-size="26" font-family="ui-monospace,Menlo,monospace" fill="#4ade80">x402 · USDC on Base · or pay with proof-of-work · open source</text>
  <text x="88" y="552" font-size="28" font-weight="600" font-family="ui-monospace,Menlo,monospace" fill="#e6e9f0">agent402.tools</text>
  </g>
</svg>`;
};
app.get("/card.svg", (_req, res) => res.type("image/svg+xml").send(cardSvg()));
let cardPngCache = null;
app.get("/card.png", async (_req, res) => {
  try {
    cardPngCache ??= await rasterizeSvg(cardSvg(), { width: 1200, height: 630 });
    res.type("image/png").send(cardPngCache);
  } catch {
    res.redirect(302, "/card.svg");
  }
});
// GitHub repo social preview (Settings → Social preview) wants 1280×640.
let cardGithubCache = null;
app.get("/card-1280.png", async (_req, res) => {
  try {
    cardGithubCache ??= await rasterizeSvg(cardSvg(1280, 640), { width: 1280, height: 640 });
    res.type("image/png").send(cardGithubCache);
  } catch {
    res.redirect(302, "/card.svg");
  }
});
app.get("/openapi.json", (_req, res) => res.json(openapiSpec(BASE_URL, CATALOG)));
app.get("/tools", (_req, res) => htmlCache(res, 300, 900).send(toolsIndexPage(BASE_URL, CATALOG)));
app.get("/tools/:slug", (req, res) => {
  const tools = toolList(CATALOG);
  const tool = tools.find((t) => t.slug === req.params.slug);
  if (!tool) return res.status(404).type("html").send('<p>Tool not found. <a href="/tools">All tools</a></p>');
  const related = tools.filter((t) => t.category === tool.category && t.slug !== tool.slug).slice(0, 3);
  const cachePolicy = tool.method === "GET" ? CACHEABLE_ROUTES[tool.path] : null;
  htmlCache(res, 300, 900).send(toolPage(BASE_URL, tool, related, { computePayable: POW_SLUGS.has(tool.slug), powDifficulty: POW_DIFFICULTY, cacheTtl: cachePolicy?.ttl ?? null }));
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
  res.json(await getAnalytics({ windowHours, top, includeSynthetic }));
});

// Human-readable analytics dashboard. Same data as /api/analytics, rendered as
// HTML with stat cards, a sparkline, and the top-tools table. When no DB is
// wired, the page shows a clean "not enabled" panel — server still boots.
app.get("/analytics", async (req, res) => {
  const windowHours = Math.max(1, Math.min(720, parseInt(req.query.hours, 10) || 24));
  const includeSynthetic = req.query.include_synthetic === "1" || req.query.include_synthetic === "true";
  const data = await getAnalytics({ windowHours, top: 25, includeSynthetic });
  htmlCache(res, 30, 60).send(analyticsPage(data, { baseUrl: BASE_URL }));
});

// Remote MCP connector (streamable HTTP, authless free tier): paste
// https://agent402.tools/mcp into Claude/ChatGPT custom connectors. Mounted
// before the paywall — it meters itself (PoW-eligible tools only, per-IP
// rate limit) and counts served calls under the proof-of-work tier.
mountMcp(app, CATALOG, {
  baseUrl: BASE_URL,
  isComputePayable,
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
    // MCP transport has no HTTP header surface, so `X-Heartbeat-Token` can't
    // ride along — synthetic is always false here. Pass explicitly so future
    // refactors don't accidentally let a stray truthy value through.
    if (meta.errored) logToolError(slug, status, meta.errorMessage || "mcp-error", undefined, false);
    recordToolCall({
      slug,
      latencyMs: meta.latencyMs | 0,
      cached: false,
      errored: !!meta.errored,
      status,
      synthetic: false,
    }).catch(() => {});
  },
});

app.get("/api/pricing", (_req, res) =>
  res.json({
    name: "Agent402",
    description: "Pay-per-call tools for AI agents via the x402 payment protocol.",
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
  })
);

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
  // Gate: for a compute-payable route, a valid proof-of-work bypasses the x402
  // paywall; otherwise the normal USDC paywall applies (and we advertise the
  // PoW alternative via a response header on its 402). PoW redemption is
  // sliding-window rate-limited per IP using the SAME limiter+policy as the
  // hosted MCP free tier (src/rate-limit.js) — otherwise a client exhausted
  // on /mcp could keep hammering /api/* with fresh PoW solutions for free.
  app.use((req, res, next) => {
    // Marketplace-forwarded calls already settled USDC to our wallet via
    // agent402.app's facilitator — honor the bridge token and skip our paywall.
    if (marketplaceTokenOk(req.header("x-mkt-bypass"))) {
      res.setHeader("X-Settled-Via", "marketplace");
      return next();
    }
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
    return x402mw(req, res, next);
  });
  console.log(`x402 payments enabled: ${NETWORK} -> ${WALLET_ADDRESS}; proof-of-work tier on ${POW_SLUGS.size} tools (difficulty ${POW_DIFFICULTY} bits)`);
}

// Tally successfully served paid-tool calls for /api/stats (best-effort; runs
// after the paywall so only paid/proven requests that return 200 are counted).
app.use((req, res, next) => {
  const def = CATALOG[`${req.method} ${req.path}`];
  if (def) {
    res.on("finish", () => {
      // Attribute by what the gate actually ACCEPTED, not by header presence —
      // an invalid PoW header on a USDC-settled call must count as usdc.
      // Heartbeat probe attribution requires a POW_SECRET-signed X-Heartbeat-Token
      // (not just a User-Agent string, which would be spoofable). Anything that
      // claims to be the probe but lacks a valid token is counted as real PoW.
      if (res.statusCode === 200) {
        const powAccepted = res.getHeader("X-Pow-Accepted") === "true";
        const isHeartbeat = powAccepted && verifyHeartbeatToken(req.header("x-heartbeat-token"));
        recordServedCall(def.slug, isHeartbeat ? "heartbeat" : powAccepted ? "pow" : "usdc");
      } else if (res.getHeader("X-PAYMENT-RESPONSE")) {
        // x402 middleware sets X-PAYMENT-RESPONSE only after USDC settlement
        // succeeded. A non-200 with this header set means we charged the buyer
        // on-chain but the handler errored — they paid for nothing. Track it.
        recordChargedFailure(def.slug, res.statusCode);
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
  try {
    res.json(await renderArticle(url));
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
  }
});

app.get("/api/screenshot", async (req, res) => {
  const { url, fullPage } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing "url" query parameter' });
  try {
    const png = await screenshotPage(url, { fullPage: fullPage === "true" });
    res.type("png").send(png);
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
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
    let cached = false;
    let errored = false;
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

      // Cache successful, non-error JSON responses. Errors are never cached —
      // an upstream blip shouldn't poison the key for the whole TTL.
      if (cacheKey && result && typeof result === "object" && !result.error) {
        cacheSet(cacheKey, result, cachePolicy.ttl || 300).catch(() => {});
      }
      res.json(result);
    } catch (err) {
      errored = true;
      status = err.statusCode || 500;
      logToolError(tool.slug, status, err.message, status < 500 ? requestShape(req) : null, synthetic);
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
      // Fire-and-forget. Analytics outages must NEVER affect agents.
      recordToolCall({
        slug: tool.slug,
        latencyMs: Date.now() - startedAt,
        cached,
        errored,
        status,
        synthetic,
      }).catch(() => {});
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
  const wantsJson = req.path.startsWith("/api") || req.path.startsWith("/__operator") || req.accepts(["html", "json"]) === "json";
  if (wantsJson) {
    res.status(status).json({ ok: false, error: status === 400 ? "bad-request" : status === 413 ? "payload-too-large" : status === 429 ? "rate-limited" : "internal" });
  } else {
    res.status(status).type("html").send(`<!doctype html><meta charset="utf-8"><title>${status}</title><p>${status === 404 ? "Not found." : "Something went wrong."}</p>`);
  }
});

const httpServer = app.listen(PORT, () =>
  console.log(`Agent402 listening on :${PORT} with ${Object.keys(CATALOG).length} paid tools`)
);

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
// origins pulled from public x402 registries (Coinbase CDP Bazaar, agent402.app).
// selfOrigin is passed so the discovery feeder skips our own listings. Fire-and-
// forget so a slow upstream can't delay boot or /health.
startCrawler({ selfOrigin: BASE_URL });

// x402 Leaderboard cache: warms once at boot, refreshes hourly. Failures keep
// the previous good snapshot rather than wiping it — a transient RPC outage
// shouldn't make /api/leaderboard return nothing. Fire-and-forget so a slow
// Bazaar walk can't delay boot or /health.
startLeaderboardRefresh();

// Graceful shutdown: a Railway redeploy sends SIGTERM. Stop accepting new
// connections but let in-flight (already paid-for) requests finish before
// exiting — a hard kill would take an agent's money and return nothing.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — draining in-flight requests`);
  httpServer.close(() => process.exit(0));
  // Hard deadline so a stuck request can't block the redeploy.
  setTimeout(() => process.exit(0), 25_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Safety net: a stray unhandled rejection/exception in some request path must not
// take down a process that's handling real payments. Log and keep serving; every
// request path is already try/caught, so this only catches the unexpected.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? reason.stack : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.stack || err);
});
