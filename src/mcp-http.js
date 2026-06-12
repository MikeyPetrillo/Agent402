// Remote MCP endpoint (Streamable HTTP) — makes Agent402 an installable
// connector: paste https://agent402.tools/mcp into Claude (Settings >
// Connectors), ChatGPT, or any MCP client that speaks streamable HTTP.
//
// This is the authless free tier. It runs in the same process as the tools and
// dispatches handlers directly, so it exposes exactly the proof-of-work set —
// the pure-CPU tools that are ~free to serve — behind a per-IP rate limit.
// The wallet-only tools (search, browser, PDF, media, memory) are quoted with
// instructions to use the npm `agent402-mcp` server with a funded AGENT_KEY,
// where x402 settles per call. Payment identity can't flow through a hosted
// authless connector (the connector has no wallet), so paid usage stays on
// the stdio package by design.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const VERSION = "0.3.0";

// Per-IP sliding-window rate limit for tool executions (search/info are free).
// Generous enough for real use of $0.001-grade CPU tools, tight enough that
// the free tier can't be farmed as infrastructure.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_CALLS_PER_WINDOW = 120;
const BURST_WINDOW_MS = 60 * 1000;
const MAX_CALLS_PER_BURST = 20;
const buckets = new Map(); // ip -> number[] (call timestamps)

function rateLimited(ip) {
  const now = Date.now();
  let hits = buckets.get(ip);
  if (!hits) buckets.set(ip, (hits = []));
  while (hits.length && hits[0] < now - WINDOW_MS) hits.shift();
  const inBurst = hits.filter((t) => t > now - BURST_WINDOW_MS).length;
  if (hits.length >= MAX_CALLS_PER_WINDOW || inBurst >= MAX_CALLS_PER_BURST) return true;
  hits.push(now);
  return false;
}
// Bound the table: drop empty/stale buckets occasionally.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, hits] of buckets) {
    while (hits.length && hits[0] < cutoff) hits.shift();
    if (!hits.length) buckets.delete(ip);
  }
}, 10 * 60 * 1000).unref();

/**
 * Mount the MCP endpoint on the express app.
 * `catalog` is the CATALOG map (route -> tool def), `opts.isComputePayable`
 * decides the free set, `opts.onServed(slug)` feeds the stats counters.
 */
export function mountMcp(app, catalog, { baseUrl, isComputePayable, onServed = () => {} }) {
  const tools = new Map(); // slug -> { def, free }
  for (const def of Object.values(catalog)) {
    tools.set(def.slug, { def, free: isComputePayable(def) });
  }
  const freeCount = [...tools.values()].filter((t) => t.free).length;

  const schemaOf = (def) => {
    const s = def.discovery?.inputSchema;
    return s ? { type: "object", ...s } : { type: "object" };
  };

  function searchTools(query, limit = 10) {
    const terms = String(query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const scored = [];
    for (const { def, free } of tools.values()) {
      const slug = def.slug.toLowerCase();
      const hay = `${def.name} ${def.description} ${def.category} ${(def.tags || []).join(" ")}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (slug === term) score += 10;
        if (slug.includes(term)) score += 4;
        if (hay.includes(term)) score += 1;
      }
      if (score > 0) scored.push([score, def, free]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, Math.min(Number(limit) || 10, 25)).map(([, def, free]) => ({
      slug: def.slug,
      price: def.price,
      access: free ? "free here (rate-limited)" : "wallet required (USDC via x402 — use the agent402-mcp npm server)",
      description: def.description.length > 200 ? `${def.description.slice(0, 200)}…` : def.description,
      inputSchema: schemaOf(def),
    }));
  }

  function walletRequiredText(def) {
    return [
      `"${def.slug}" (${def.price}/call) needs per-call USDC payment and is not part of this hosted free tier.`,
      `To use it from Claude/any MCP client: run the npm server with a funded Base wallet —`,
      `npx agent402-mcp with env AGENT_KEY=0x<private key> (spend caps: AGENT402_MAX_PER_CALL, AGENT402_BUDGET).`,
      `Or call it over HTTP with any x402 client. Docs: ${baseUrl}/tools/${def.slug}`,
    ].join(" ");
  }

  function buildServer(ip) {
    const server = new Server({ name: "agent402", version: VERSION }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "search_tools",
          description:
            `Search Agent402's ${tools.size} pay-per-call web tools (encoding, crypto, text, time, math, validation, unit conversions, network, browser, PDF, search, memory). ${freeCount} pure-CPU tools run free right here; the rest need a USDC wallet. Returns slugs + input schemas for call_tool.`,
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: 'What you need, e.g. "decode JWT", "miles to km", "cron next run"' },
              limit: { type: "number", description: "Max results (default 10)" },
            },
            required: ["query"],
          },
        },
        {
          name: "call_tool",
          description:
            `Run an Agent402 tool by slug (find slugs with search_tools). The ${freeCount} pure-CPU tools execute free on this hosted connector (rate-limited). Wallet-only tools (live search, browser rendering, PDFs, durable memory) return instructions for paid access instead.`,
          inputSchema: {
            type: "object",
            properties: {
              slug: { type: "string", description: 'Tool slug, e.g. "convert-miles-to-kilometers"' },
              params: { type: "object", description: "Tool input, matching the tool's inputSchema" },
            },
            required: ["slug"],
          },
        },
        {
          name: "about_agent402",
          description: "What this connector is: the free tier of agent402.tools, what's free vs wallet-only, and how paid access works (x402, USDC on Base, proof-of-work).",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args = {} } = req.params;
      try {
        if (name === "search_tools") {
          const results = searchTools(args.query ?? "", args.limit);
          return {
            content: [{
              type: "text",
              text: results.length
                ? JSON.stringify({ results, usage: 'call_tool {"slug": …, "params": …}' }, null, 2)
                : `No tools matched "${args.query}". Full catalog: ${baseUrl}/tools`,
            }],
          };
        }
        if (name === "about_agent402") {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                service: baseUrl,
                connector: "hosted free tier (authless)",
                tools: tools.size,
                freeHere: freeCount,
                walletOnly: tools.size - freeCount,
                rateLimit: `${MAX_CALLS_PER_BURST}/min, ${MAX_CALLS_PER_WINDOW}/hour per client`,
                paidAccess: "Every tool, no rate limit: pay per call in USDC on Base via the x402 protocol — npx agent402-mcp with AGENT_KEY, or any x402 HTTP client. No signup, no API key; prices $0.001–$0.02/call.",
                docs: `${baseUrl}/llms.txt`,
              }, null, 2),
            }],
          };
        }
        if (name !== "call_tool") {
          return { content: [{ type: "text", text: `Unknown tool "${name}".` }], isError: true };
        }
        const entry = tools.get(String(args.slug ?? ""));
        if (!entry) {
          return { content: [{ type: "text", text: `Unknown slug "${args.slug}". Use search_tools to find the right slug.` }], isError: true };
        }
        if (!entry.free) {
          return { content: [{ type: "text", text: walletRequiredText(entry.def) }], isError: true };
        }
        if (rateLimited(ip)) {
          return {
            content: [{ type: "text", text: `Free-tier rate limit reached (${MAX_CALLS_PER_BURST}/min, ${MAX_CALLS_PER_WINDOW}/hour). For unmetered access pay per call via x402: npx agent402-mcp with AGENT_KEY. ${baseUrl}/llms.txt` }],
            isError: true,
          };
        }
        const params = args.params && typeof args.params === "object" ? args.params : {};
        // Same contract as the express kit routes; handlers only see input.
        const result = await entry.def.handler(params, { headers: {}, query: params, body: params, ip });
        onServed(entry.def.slug);
        if (result && result.__binary) {
          return { content: [{ type: "image", data: Buffer.from(result.__binary).toString("base64"), mimeType: result.contentType }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Agent402: ${err.message}` }], isError: true };
      }
    });

    return server;
  }

  // Permissive CORS so browser-based MCP clients (inspector, web agents) work;
  // claude.ai connects server-side and ignores this.
  app.use("/mcp", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  // Stateless mode: a fresh server+transport per POST, no session table. Every
  // JSON-RPC message (including initialize) is self-contained, which survives
  // redeploys and needs no sticky routing.
  app.post("/mcp", async (req, res) => {
    const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "?").trim();
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => transport.close());
      await buildServer(ip).connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: null });
      }
    }
  });

  // Stateless servers have no notification stream or session to manage.
  app.get("/mcp", (_req, res) => res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "This MCP endpoint is stateless: POST JSON-RPC messages to /mcp." },
    id: null,
  }));
  app.delete("/mcp", (_req, res) => res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Stateless endpoint — no session to terminate." },
    id: null,
  }));
}
