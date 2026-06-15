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
import { privacyPage } from "./privacy.js";
import { termsPage } from "./terms.js";
import { robotsTxt, sitemapXml, llmsTxt } from "./seo.js";
import { serviceManifest, reliabilityReport } from "./discovery.js";
import { findTools } from "./find.js";
import { buildPaymentMiddleware, enabledNetworks } from "./payments.js";
import { KIT } from "./tools/kit.js";
import { KIT2 } from "./tools/kit2.js";
import { CONVERSIONS } from "./tools/convert-gen.js";
import { SEARCH_TOOLS } from "./tools/search.js";
import { PDF_TOOLS } from "./tools/pdf-kit.js";
import { DEMAND_TOOLS } from "./tools/demand-kit.js";
import { MEDIA_TOOLS } from "./tools/media-kit.js";
import { GOV_TOOLS } from "./tools/gov-kit.js";
import { AGENT_TOOLS } from "./tools/agent-kit.js";
import { BARCODE_TOOLS } from "./tools/barcode-kit.js";
import { DATA_TOOLS } from "./tools/data-kit.js";
import { IMAGE_TOOLS } from "./tools/image-kit.js";
import { X402_TOOLS } from "./tools/x402-kit.js";
import { UTIL_TOOLS } from "./tools/util-kit.js";
import { toolPage, toolsIndexPage, openapiSpec, toolList, CATEGORIES, faqPage } from "./pages.js";
import { mountMcp } from "./mcp-http.js";
import { guidesIndex, guidePage } from "./guides.js";

const ALL_KIT = [...KIT, ...KIT2, ...CONVERSIONS, ...SEARCH_TOOLS, ...PDF_TOOLS, ...DEMAND_TOOLS, ...MEDIA_TOOLS, ...GOV_TOOLS, ...AGENT_TOOLS, ...BARCODE_TOOLS, ...DATA_TOOLS, ...IMAGE_TOOLS, ...X402_TOOLS, ...UTIL_TOOLS];
import { issueChallenge, verifySolution, isComputePayable, powInfo, POW_DIFFICULTY } from "./pow.js";
import { recordServedCall, getStats } from "./stats.js";
import { timingSafeEqual, createHash } from "node:crypto";
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

// Baseline security headers on every response. No CSP (the HTML landing/tool/
// guide pages use inline styles), but these are cheap, no-break hardening for
// an API that also serves a few HTML pages.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  next();
});

// Free, unauthenticated routes
app.get("/", (_req, res) =>
  res.type("html").send(
    landingPage(BASE_URL, NETWORK, FREE_MODE, CATALOG, getStats({ wallet: WALLET_ADDRESS, walletName: WALLET_ENS, network: NETWORK, toolCount: Object.keys(CATALOG).length, baseUrl: BASE_URL, prices: TOOL_PRICES }))
  )
);
app.get("/health", (_req, res) => res.json({ ok: true }));
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
app.get("/privacy", (_req, res) => res.type("html").send(privacyPage(BASE_URL)));
app.get("/terms", (_req, res) => res.type("html").send(termsPage(BASE_URL)));
app.get("/faq", (_req, res) => res.type("html").send(faqPage(BASE_URL)));
app.get("/guides", (_req, res) => res.type("html").send(guidesIndex(BASE_URL)));
app.get("/guides/:slug", (req, res) => {
  const html = guidePage(BASE_URL, req.params.slug);
  if (!html) return res.status(404).type("html").send('<p>Guide not found. <a href="/guides">All guides</a></p>');
  res.type("html").send(html);
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
app.get("/.well-known/x402", (_req, res) => res.json(MANIFEST));
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
const findHandler = (q, k, res) => res.json(findTools(CATALOG, q, { k, baseUrl: BASE_URL, powSlugs: POW_SLUGS }));
app.get("/api/find", (req, res) => findHandler(req.query.q ?? req.query.task ?? req.query.query, req.query.k, res));
app.post("/api/find", (req, res) => findHandler(req.body?.q ?? req.body?.task ?? req.body?.query, req.body?.k, res));
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
app.get("/tools", (_req, res) => res.type("html").send(toolsIndexPage(BASE_URL, CATALOG)));
app.get("/tools/:slug", (req, res) => {
  const tools = toolList(CATALOG);
  const tool = tools.find((t) => t.slug === req.params.slug);
  if (!tool) return res.status(404).type("html").send('<p>Tool not found. <a href="/tools">All tools</a></p>');
  const related = tools.filter((t) => t.category === tool.category && t.slug !== tool.slug).slice(0, 3);
  res.type("html").send(toolPage(BASE_URL, tool, related, { computePayable: POW_SLUGS.has(tool.slug), powDifficulty: POW_DIFFICULTY }));
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
app.get("/api/stats", (_req, res) =>
  res.json(getStats({ wallet: WALLET_ADDRESS, walletName: WALLET_ENS, network: NETWORK, toolCount: Object.keys(CATALOG).length, baseUrl: BASE_URL, prices: TOOL_PRICES }))
);

// Remote MCP connector (streamable HTTP, authless free tier): paste
// https://agent402.tools/mcp into Claude/ChatGPT custom connectors. Mounted
// before the paywall — it meters itself (PoW-eligible tools only, per-IP
// rate limit) and counts served calls under the proof-of-work tier.
mountMcp(app, CATALOG, {
  baseUrl: BASE_URL,
  isComputePayable,
  onServed: (slug) => recordServedCall(slug, "pow"),
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
const idemStore = new Map(); // hashKey -> { at, body }
const IDEM_TTL_MS = 10 * 60 * 1000;
const IDEM_MAX = 5000;
const idemHashKey = (req) => {
  const idem = req.header("idempotency-key");
  if (!idem || idem.length > 256) return null;
  const cred = req.header("x-payment") || req.header("payment-signature") || req.header("x-pow-solution");
  if (!cred) return null; // nothing to securely bind the key to → don't cache
  return createHash("sha256").update(`${idem}\n${cred}`).digest("hex");
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
      if (idemStore.size >= IDEM_MAX) idemStore.delete(idemStore.keys().next().value);
      idemStore.set(key, { at: Date.now(), body });
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
  const x402mw = await buildPaymentMiddleware({
    walletAddress: WALLET_ADDRESS,
    network: NETWORK,
    baseUrl: BASE_URL,
    catalog: CATALOG,
  });
  // Gate: for a compute-payable route, a valid proof-of-work bypasses the x402
  // paywall; otherwise the normal USDC paywall applies (and we advertise the
  // PoW alternative via a response header on its 402).
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
      if (res.statusCode === 200) recordServedCall(def.slug, res.getHeader("X-Pow-Accepted") === "true" ? "pow" : "usdc");
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
for (const tool of ALL_KIT) {
  const [method, path] = tool.route.split(" ");
  app[method.toLowerCase()](path, async (req, res) => {
    try {
      const result = await tool.handler({ ...req.query, ...(req.body ?? {}) }, req);
      if (result && result.__binary) return res.type(result.contentType).send(result.__binary);
      res.json(result);
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });
}

const httpServer = app.listen(PORT, () =>
  console.log(`Agent402 listening on :${PORT} with ${Object.keys(CATALOG).length} paid tools`)
);

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
