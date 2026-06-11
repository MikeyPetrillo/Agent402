import express from "express";
import { extractArticle, fetchPageMeta } from "./tools/extract.js";
import { dnsLookup } from "./tools/dns.js";
import { pdfToText } from "./tools/pdf.js";
import { renderArticle, screenshotPage } from "./tools/render.js";
import { memoryPut, memoryGet, memoryDelete } from "./tools/memory.js";
import { payerFromRequest } from "./payer.js";
import { landingPage } from "./landing.js";
import { buildPaymentMiddleware } from "./payments.js";

const PORT = process.env.PORT || 3000;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const NETWORK = process.env.NETWORK || "base";
const FREE_MODE = process.env.FREE_MODE === "true";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const CATALOG = {
  "POST /api/extract": {
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

const app = express();
app.use(express.json({ limit: "100kb" }));

// Free, unauthenticated routes
app.get("/", (_req, res) => res.type("html").send(landingPage(BASE_URL, NETWORK, FREE_MODE)));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/pricing", (_req, res) =>
  res.json({
    name: "Agent402",
    description: "Paid web tools for AI agents via the x402 payment protocol.",
    payment: { protocol: "x402", version: 2, network: NETWORK, currency: "USDC" },
    baseUrl: BASE_URL,
    endpoints: Object.entries(CATALOG).map(([route, { price, description }]) => {
      const [method, path] = route.split(" ");
      return { method, path, price, description };
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
  app.use(
    await buildPaymentMiddleware({
      walletAddress: WALLET_ADDRESS,
      network: NETWORK,
      baseUrl: BASE_URL,
      catalog: CATALOG,
    })
  );
  console.log(`x402 payments enabled: ${NETWORK} -> ${WALLET_ADDRESS}`);
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

app.listen(PORT, () => console.log(`Agent402 listening on :${PORT}`));
