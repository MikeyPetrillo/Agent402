#!/usr/bin/env node
// Agent402 MCP server — exposes the agent402.tools catalog (1000+ pay-per-call
// web tools) to any MCP client (Claude, ChatGPT, custom agents) and settles
// payment underneath, so the model never sees the 402 dance:
//
//   • AGENT_KEY=0x…   pay per call in USDC via x402 (any tool)
//   • no key          pay with compute (proof-of-work) on the eligible tools
//
// The full catalog is too large to register as individual MCP tools, so the
// high-value tools are first-class and everything else is reachable through
// search_tools + call_tool.
//
// Config (env):
//   AGENT402_URL   target service (default https://agent402.tools)
//   AGENT_KEY      hex private key of a funded wallet (USDC on Base) — optional
//   AGENT402_TOOLS comma-separated slugs to expose first-class (overrides default)
import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = (process.env.AGENT402_URL || "https://agent402.tools").replace(/\/$/, "");
const AGENT_KEY = process.env.AGENT_KEY || "";
const VERSION = "0.1.0";

const DEFAULT_CURATED = [
  // the tools agents can't replicate locally: browser, live web, PDF, shared memory
  "extract", "render", "screenshot", "pdf", "meta", "dns", "http-check", "tls-cert", "whois",
  "memory-write", "memory-read", "memory-remember", "memory-recall",
  // one cheap pure-CPU tool so wallet-less clients see the proof-of-work path work
  "hash",
];

// stdout is the MCP protocol channel — all logging goes to stderr.
const log = (...a) => console.error("[agent402-mcp]", ...a);

// ---------------------------------------------------------------------------
// Catalog: built from the service's own machine-readable surfaces.
const catalog = new Map(); // slug -> { slug, method, path, price, description, category, computePayable, inputSchema }

async function loadCatalog() {
  const [pricing, openapi] = await Promise.all([
    fetch(`${BASE}/api/pricing`).then((r) => r.json()),
    fetch(`${BASE}/openapi.json`).then((r) => r.json()),
  ]);
  for (const e of pricing.endpoints) {
    const slug = e.slug ?? e.docs?.split("/tools/").pop();
    if (!slug) continue;
    const op = openapi.paths?.[e.path]?.[e.method.toLowerCase()];
    let inputSchema = { type: "object" };
    if (op) {
      if (e.method === "GET") {
        const params = op.parameters ?? [];
        inputSchema = {
          type: "object",
          properties: Object.fromEntries(
            params.map((p) => [p.name, { type: p.schema?.type ?? "string", ...(p.description ? { description: p.description } : {}) }])
          ),
        };
        const required = params.filter((p) => p.required).map((p) => p.name);
        if (required.length) inputSchema.required = required;
      } else {
        const body = op.requestBody?.content?.["application/json"]?.schema;
        if (body) inputSchema = { type: "object", properties: body.properties ?? {}, ...(body.required?.length ? { required: body.required } : {}) };
      }
    }
    catalog.set(slug, {
      slug,
      method: e.method,
      path: e.path,
      price: e.price,
      description: e.description,
      category: e.category,
      computePayable: !!e.computePayable,
      inputSchema,
    });
  }
  return pricing;
}

// ---------------------------------------------------------------------------
// Payment: USDC via x402 when a key is configured, else proof-of-work.
let payFetchPromise;
function getPayFetch() {
  payFetchPromise ??= (async () => {
    const { x402Client } = await import("@x402/core/client");
    const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
    const { wrapFetchWithPayment } = await import("@x402/fetch");
    const { privateKeyToAccount } = await import("viem/accounts");
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(AGENT_KEY) });
    return wrapFetchWithPayment(fetch, client);
  })();
  return payFetchPromise;
}

function solvePow(challenge) {
  const leadingZeroBits = (buf) => {
    let total = 0;
    for (const byte of buf) {
      if (byte === 0) { total += 8; continue; }
      total += Math.clz32(byte) - 24;
      break;
    }
    return total;
  };
  let nonce = 0;
  while (leadingZeroBits(createHash("sha256").update(`${challenge.challenge}:${nonce}`).digest()) < challenge.difficulty) nonce++;
  return nonce;
}

function walletRequiredText(tool) {
  return [
    `"${tool.slug}" costs ${tool.price}/call and requires a USDC wallet (it is not eligible for the proof-of-work tier).`,
    `To enable it: set the AGENT_KEY environment variable on this MCP server to the hex private key of a wallet`,
    `funded with USDC on Base. Payment is per call via the x402 protocol — no signup or API key.`,
    `Pricing and details: ${BASE}/tools/${tool.slug}`,
  ].join(" ");
}

async function callEndpoint(tool, args = {}) {
  const url = new URL(`${BASE}${tool.path}`);
  const init = { method: tool.method, headers: { Accept: "application/json" } };
  if (tool.method === "GET") {
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  } else {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(args);
  }

  let res;
  if (AGENT_KEY) {
    const payFetch = await getPayFetch();
    res = await payFetch(url, init);
  } else if (tool.computePayable) {
    // No wallet: pay with compute up front — solving before the call skips the
    // 402 round-trip entirely (challenges are single-use and tool-scoped).
    const challenge = await (await fetch(`${BASE}/api/pow/challenge?slug=${encodeURIComponent(tool.slug)}`)).json();
    const nonce = solvePow(challenge);
    res = await fetch(url, { ...init, headers: { ...init.headers, "X-Pow-Solution": `${challenge.token}:${nonce}` } });
  } else {
    return { content: [{ type: "text", text: walletRequiredText(tool) }], isError: true };
  }

  const contentType = (res.headers.get("content-type") || "").split(";")[0];
  if (contentType.startsWith("image/")) {
    const data = Buffer.from(await res.arrayBuffer()).toString("base64");
    return { content: [{ type: "image", data, mimeType: contentType }] };
  }
  const text = await res.text();
  return { content: [{ type: "text", text }], ...(res.status >= 400 ? { isError: true } : {}) };
}

// ---------------------------------------------------------------------------
// Tool search over the full catalog (for everything not exposed first-class).
function searchTools(query, limit = 10) {
  const terms = String(query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const scored = [];
  for (const t of catalog.values()) {
    const slug = t.slug.toLowerCase();
    const hay = `${t.description} ${t.category}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (slug === term) score += 10;
      if (slug.includes(term)) score += 4;
      if (hay.includes(term)) score += 1;
    }
    if (score > 0) scored.push([score, t]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(([, t]) => ({
    slug: t.slug,
    method: t.method,
    path: t.path,
    price: t.price,
    payment: t.computePayable ? "USDC or free via proof-of-work" : "USDC (wallet required)",
    description: t.description.length > 220 ? `${t.description.slice(0, 220)}…` : t.description,
    inputSchema: t.inputSchema,
  }));
}

// ---------------------------------------------------------------------------
// MCP wiring
const server = new Server({ name: "agent402", version: VERSION }, { capabilities: { tools: {} } });

let curated = [];
let pricingInfo = null;

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = curated.map((t) => ({
    name: t.slug,
    description: `[${t.price}/call${t.computePayable ? ", or free via proof-of-work" : ", wallet required"}] ${t.description}`,
    inputSchema: t.inputSchema,
  }));
  tools.push(
    {
      name: "search_tools",
      description:
        `Search the full Agent402 catalog (${catalog.size} pay-per-call tools: encoding, crypto, data conversion, text, time, validation, math, unit conversions, network, browser, memory). Returns matching tools with their price, payment options, and input schema. Call them with call_tool.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you need, e.g. \"convert miles to km\", \"decode JWT\", \"cron next run\"" },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "call_tool",
      description:
        "Call any Agent402 tool by slug (find slugs and input schemas with search_tools). Payment is handled automatically: USDC via x402 if this server has a wallet key, otherwise proof-of-work on eligible tools.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Tool slug from search_tools, e.g. \"convert-miles-to-kilometers\"" },
          params: { type: "object", description: "Tool input parameters, matching the tool's inputSchema" },
        },
        required: ["slug"],
      },
    },
    {
      name: "payment_info",
      description: "How this MCP server is paying for Agent402 calls (USDC wallet vs proof-of-work), and what that unlocks.",
      inputSchema: { type: "object", properties: {} },
    }
  );
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === "search_tools") {
      const results = searchTools(args.query ?? "", args.limit ?? 10);
      return {
        content: [{
          type: "text",
          text: results.length
            ? JSON.stringify({ results, usage: "call_tool {\"slug\": …, \"params\": …}" }, null, 2)
            : `No tools matched "${args.query}". Browse the catalog at ${BASE}/tools or ${BASE}/api/pricing.`,
        }],
      };
    }
    if (name === "payment_info") {
      let address = null;
      if (AGENT_KEY) {
        const { privateKeyToAccount } = await import("viem/accounts");
        address = privateKeyToAccount(AGENT_KEY).address;
      }
      const computePayable = [...catalog.values()].filter((t) => t.computePayable).length;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            service: BASE,
            mode: AGENT_KEY ? "usdc" : "proof-of-work",
            wallet: address,
            network: pricingInfo?.payment?.network ?? "base",
            tools: catalog.size,
            payableWithCompute: computePayable,
            walletOnly: catalog.size - computePayable,
            note: AGENT_KEY
              ? "Every tool is available; each call is paid in USDC via x402 from the configured wallet."
              : `No AGENT_KEY configured: ${computePayable} pure-CPU tools are free via proof-of-work; the ${catalog.size - computePayable} network/browser/memory tools need a funded wallet (set AGENT_KEY).`,
          }, null, 2),
        }],
      };
    }
    const tool = catalog.get(name === "call_tool" ? args.slug : name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool slug "${name === "call_tool" ? args.slug : name}". Use search_tools to find the right slug.` }], isError: true };
    }
    return await callEndpoint(tool, name === "call_tool" ? (args.params ?? {}) : args);
  } catch (err) {
    return { content: [{ type: "text", text: `Agent402 call failed: ${err.message}` }], isError: true };
  }
});

// ---------------------------------------------------------------------------
try {
  pricingInfo = await loadCatalog();
} catch (err) {
  log(`Could not load the catalog from ${BASE}: ${err.message}`);
  process.exit(1);
}
const requested = (process.env.AGENT402_TOOLS || DEFAULT_CURATED.join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);
curated = requested.map((slug) => catalog.get(slug)).filter(Boolean);
log(`catalog: ${catalog.size} tools from ${BASE}; ${curated.length} first-class, rest via search_tools/call_tool`);
log(AGENT_KEY ? "payment: USDC via x402 (wallet configured)" : "payment: proof-of-work on eligible tools (no AGENT_KEY)");

await server.connect(new StdioServerTransport());
