import express from "express";
import { extractArticle, fetchPageMeta } from "./tools/extract.js";
import { dnsLookup } from "./tools/dns.js";
import { pdfToText } from "./tools/pdf.js";
import { renderArticle, screenshotPage } from "./tools/render.js";
import { memoryPut, memoryGet, memoryDelete } from "./tools/memory.js";
import { payerFromRequest } from "./payer.js";
import { landingPage } from "./landing.js";
import { robotsTxt, sitemapXml, llmsTxt } from "./seo.js";
import { buildPaymentMiddleware } from "./payments.js";
import { KIT } from "./tools/kit.js";
import { toolPage, toolsIndexPage, openapiSpec, toolList, CATEGORIES } from "./pages.js";
import { issueChallenge, verifySolution, isComputePayable, powInfo, POW_DIFFICULTY } from "./pow.js";

const PORT = process.env.PORT || 3000;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const NETWORK = process.env.NETWORK || "base";
const FREE_MODE = process.env.FREE_MODE === "true";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

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
      "Persistent key-value memory for agents, scoped to the paying wallet. Your x402 payment IS your authentication: the wallet that pays owns the namespace. No signup, no API keys. Body: {\"key\": \"…\", \"value\": any JSON} to write, or {\"key\": \"…\", \"delete\": true} to remove. Values up to 64KB.",
    tags: ["memory", "storage", "state", "key-value", "persistence"],
    discovery: {
      bodyType: "json",
      input: { key: "research/task-42", value: { status: "done", findings: ["…"] } },
      inputSchema: {
        properties: {
          key: { type: "string", description: "Key to write (max 256 chars)" },
          value: { description: "Any JSON value (max 64KB serialized)" },
          delete: { type: "boolean", description: "Set true to delete the key instead" },
        },
        required: ["key"],
      },
      output: { example: { key: "research/task-42", bytes: 42, updated: 1760000000000, persistent: true } },
    },
  },
  "GET /api/memory": {
    name: "Memory read",
    slug: "memory-read",
    category: "memory",
    price: "$0.001",
    description:
      "Read from your wallet-scoped memory. ?key=… returns the stored value; omit key to list your keys. Only the wallet that paid for the writes can read them.",
    tags: ["memory", "storage", "state", "key-value"],
    discovery: {
      input: { key: "research/task-42" },
      inputSchema: {
        properties: { key: { type: "string", description: "Key to read; omit to list all your keys" } },
      },
      output: { example: { key: "research/task-42", value: { status: "done" }, updated: 1760000000000 } },
    },
  },
};

// The utility kit (49 small tools) joins the catalog; same paywall, same discovery.
for (const tool of KIT) {
  if (CATALOG[tool.route]) throw new Error(`Duplicate route in kit: ${tool.route}`);
  CATALOG[tool.route] = tool;
}

// Routes that accept proof-of-work in lieu of payment: the pure-CPU tools.
// Map "METHOD /path" -> tool slug, for the gate and the challenge endpoint.
const POW_ROUTES = new Map();
const POW_SLUGS = new Set();
for (const [route, def] of Object.entries(CATALOG)) {
  if (isComputePayable(def)) {
    POW_ROUTES.set(route, def.slug);
    POW_SLUGS.add(def.slug);
  }
}

const app = express();
app.use(express.json({ limit: "100kb" }));

// Free, unauthenticated routes
app.get("/", (_req, res) => res.type("html").send(landingPage(BASE_URL, NETWORK, FREE_MODE, CATALOG)));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/robots.txt", (_req, res) => res.type("text/plain").send(robotsTxt(BASE_URL)));
app.get("/sitemap.xml", (_req, res) => res.type("application/xml").send(sitemapXml(BASE_URL, CATALOG)));
app.get("/llms.txt", (_req, res) => res.type("text/plain").send(llmsTxt(BASE_URL, CATALOG)));
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
app.get("/api/pow/challenge", (req, res) => {
  const requested = (req.query.slug || req.query.path || "").toString().replace(/^.*\//, "");
  const slug = POW_SLUGS.has(requested) ? requested : "*";
  res.json(issueChallenge(slug));
});

app.get("/api/pricing", (_req, res) =>
  res.json({
    name: "Agent402",
    description: "Pay-per-call tools for AI agents via the x402 payment protocol.",
    payment: { protocol: "x402", version: 2, network: NETWORK, currency: "USDC" },
    altPayment: {
      protocol: "proof-of-work",
      summary: "No wallet? Spend CPU instead on the pure-CPU tools.",
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
      return { method, path, price, category, description, docs: `${BASE_URL}/tools/${slug}`, computePayable: POW_SLUGS.has(slug) };
    }),
  })
);

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

// Wallet-keyed memory: the verified payer address is the namespace.
function memoryNamespace(req, res) {
  const payer = payerFromRequest(req);
  if (payer) return payer;
  if (FREE_MODE && req.query.ns) return `demo:${req.query.ns}`;
  res.status(400).json({
    error: "No payer identity found on this request. Pay via x402 — the paying wallet owns the namespace.",
  });
  return null;
}

app.post("/api/memory", (req, res) => {
  const ns = memoryNamespace(req, res);
  if (!ns) return;
  const { key, value, delete: del } = req.body ?? {};
  try {
    res.json(del ? memoryDelete(ns, key) : memoryPut(ns, key, value));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get("/api/memory", (req, res) => {
  const ns = memoryNamespace(req, res);
  if (!ns) return;
  try {
    res.json(memoryGet(ns, req.query.key));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Kit routes: input is merged query + JSON body; handlers return JSON or
// { __binary, contentType } for image responses.
for (const tool of KIT) {
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

app.listen(PORT, () => console.log(`Agent402 listening on :${PORT} with ${Object.keys(CATALOG).length} paid tools`));
