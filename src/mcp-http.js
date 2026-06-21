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
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { findTools } from "./find.js";
import { rankBy as rankLeaderboard } from "./leaderboard.js";
import { SKILL_PACKS, buildPromptMessages, rankSkillPacks } from "./skills.js";
import {
  createLimiter,
  MAX_CALLS_PER_BURST,
  MAX_CALLS_PER_WINDOW,
} from "./rate-limit.js";

const VERSION = "0.3.0";

// Per-IP sliding-window rate limit for tool executions (search/info are free).
// Generous enough for real use of $0.001-grade CPU tools, tight enough that
// the free tier can't be farmed as infrastructure. Limiter implementation +
// policy live in src/rate-limit.js so the direct-HTTP PoW redemption path
// applies the same quota.
const mcpLimiter = createLimiter("mcp");
const rateLimited = (ip) => mcpLimiter.check(ip).limited;

/**
 * Mount the MCP endpoint on the express app.
 * `catalog` is the CATALOG map (route -> tool def), `opts.isComputePayable`
 * decides the free set. `opts.onServed(slug, { latencyMs, errored })` feeds
 * both the stats counters and the analytics dashboard with full per-call meta.
 */
export function mountMcp(app, catalog, { baseUrl, isComputePayable, onServed = () => {}, getLeaderboard = null }) {
  const tools = new Map(); // slug -> { def, free }
  for (const def of Object.values(catalog)) {
    tools.set(def.slug, { def, free: isComputePayable(def) });
  }
  const freeCount = [...tools.values()].filter((t) => t.free).length;
  const freeSlugs = new Set([...tools.entries()].filter(([, t]) => t.free).map(([slug]) => slug));
  const mcpClients = new Map(); // "name@version" -> initialize count since boot

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
    const server = new Server({ name: "agent402", version: VERSION }, { capabilities: { tools: {}, prompts: {} } });

    // Skill packs are exposed as MCP prompts: each pack becomes a discoverable
    // prompt the client can render in a slash menu (Claude Desktop, Cursor,
    // etc.). The pack data lives in src/skills.js — same source of truth as
    // the HTML pages at /skills/<slug>. buildPromptMessages does the args
    // substitution + tool-plan rendering, and gets freeSlugs so it can pre-
    // split free vs wallet-only tools for the caller.
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: SKILL_PACKS.map((p) => ({
        name: p.slug,
        title: p.title,
        description: p.tagline,
        arguments: (p.promptArgs || []).map((a) => ({
          name: a.name,
          description: a.description,
          required: a.required ?? true,
        })),
      })),
    }));
    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const { name, arguments: args = {} } = req.params;
      const pack = SKILL_PACKS.find((p) => p.slug === name);
      if (!pack) throw new Error(`Unknown prompt "${name}". List available with prompts/list.`);
      return buildPromptMessages(pack, args, { freeSlugs });
    });

    // Titles + safety annotations on every tool are required for listing in
    // Anthropic's connector directory. The free tier only ever executes
    // pure-CPU deterministic functions — nothing destructive, no external
    // reads/writes — so all three tools are honestly read-only.
    const SAFE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "search_tools",
          title: "Search the Agent402 tool catalog",
          annotations: { title: "Search the Agent402 tool catalog", ...SAFE },
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
          name: "find_tool",
          title: "Find the right Agent402 tool for a task",
          annotations: { title: "Find the right Agent402 tool for a task", ...SAFE },
          description:
            "Describe a task in plain language and get the best-matching Agent402 tool(s) ready to call — slug, price, input schema, and an example — so you skip searching/exploring. Then run call_tool with the chosen slug + params.",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string", description: 'What you want to do, e.g. "extract the article from this url" or "convert miles to km"' },
              limit: { type: "number", description: "Max results (default 5)" },
            },
            required: ["task"],
          },
        },
        {
          name: "call_tool",
          title: "Run an Agent402 tool",
          annotations: { title: "Run an Agent402 tool", ...SAFE },
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
          title: "About this connector",
          annotations: { title: "About this connector", ...SAFE },
          description: "What this connector is: the free tier of agent402.tools, what's free vs wallet-only, the curated multi-tool workflows (skill packs) available as prompts, and how paid access works (x402, USDC on Base, proof-of-work).",
          inputSchema: { type: "object", properties: {} },
        },
        // Hosted leaderboard of x402 sellers settled in the recent window
        // (default 24h). The same data backs /api/leaderboard + /leaderboard;
        // surfacing it on MCP lets agents discover *which* sellers are getting
        // paid in the wild, not just *what* tools exist in this catalog. The
        // snapshot is shared across the process (hourly refresh) so this call
        // is O(rows-returned) and never hits the chain on the request path.
        ...(getLeaderboard ? [{
          name: "top_x402_sellers",
          title: "Top x402 sellers in the recent window",
          annotations: { title: "Top x402 sellers in the recent window", ...SAFE },
          description:
            "List the x402 sellers earning the most USDC (or serving the most calls) on Base in the last ~24h, derived from on-chain USDC transfers. Cached snapshot — safe to call freely. Useful for agents discovering the live x402 economy: who's getting paid, which networks, and where to point demand. Defaults: top 10, sort by USDC, exclude this host's own wallet.",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "number", description: "Max rows to return (default 10, max 50)" },
              sort: { type: "string", enum: ["usd", "calls"], description: "Rank by USDC settled (default) or by call count" },
              include: { type: "string", enum: ["external", "all"], description: "'external' (default) hides this host's own wallet; 'all' includes it" },
            },
          },
        }] : []),
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args = {} } = req.params;
      try {
        if (name === "search_tools") {
          const q = args.query ?? "";
          const results = searchTools(q, args.limit);
          // Multi-tool workflows that match the same query — surface them so an
          // agent asking "audit a domain" sees the whole security-audit pack
          // (callable via prompts/get on this connector) alongside the tools.
          const workflows = rankSkillPacks(q, { k: 2, baseUrl });
          return {
            content: [{
              type: "text",
              text: results.length || workflows.length
                ? JSON.stringify({
                    results,
                    ...(workflows.length ? { workflows, workflowsUsage: "prompts/get { name: workflows[i].promptName, arguments: { …promptArgs } }" } : {}),
                    usage: 'call_tool {"slug": …, "params": …}',
                  }, null, 2)
                : `No tools matched "${q}". Full catalog: ${baseUrl}/tools`,
            }],
          };
        }
        if (name === "find_tool") {
          const r = findTools(catalog, args.task ?? args.query ?? "", { k: args.limit, baseUrl, powSlugs: freeSlugs });
          const results = r.results.map((t) => ({
            slug: t.slug,
            price: t.price,
            access: t.computePayable ? "free here (rate-limited)" : "wallet required (USDC via x402 — use the agent402-mcp npm server)",
            description: t.description.length > 200 ? `${t.description.slice(0, 200)}…` : t.description,
            inputSchema: t.inputSchema,
            example: t.example,
            callWith: { name: "call_tool", arguments: { slug: t.slug, params: t.example ?? {} } },
          }));
          return {
            content: [{
              type: "text",
              text: results.length || r.packs?.length
                ? JSON.stringify({
                    task: r.query,
                    results,
                    ...(r.packs?.length ? { workflows: r.packs, workflowsUsage: "prompts/get { name: workflows[i].promptName, arguments: { …promptArgs } }" } : {}),
                    usage: "Run call_tool with the chosen {slug, params}. Free results execute here; wallet-only need the agent402-mcp npm server.",
                  }, null, 2)
                : `No tool matched "${args.task ?? args.query ?? ""}". Browse the catalog: ${baseUrl}/tools`,
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
                // Curated multi-tool workflows callable as MCP prompts. An agent
                // asking "what can this connector do?" should learn about the
                // task-level workflows here, not just the atomic tools — the
                // workflows are usually a better starting point than search_tools
                // for any task that spans 2+ steps.
                workflows: {
                  count: SKILL_PACKS.length,
                  usage: "prompts/list → prompts/get { name: '<slug>', arguments: { … } } — same slugs as below.",
                  items: SKILL_PACKS.map((p) => ({
                    slug: p.slug,
                    title: p.title,
                    toolCount: (p.toolSlugs || []).length,
                    tagline: p.tagline,
                  })),
                },
                clientsSeenSinceBoot: Object.fromEntries([...mcpClients].sort((a, b) => b[1] - a[1]).slice(0, 20)),
                paidAccess: "Every tool, no rate limit: pay per call in USDC on Base via the x402 protocol — npx agent402-mcp with AGENT_KEY, or any x402 HTTP client. No signup, no API key; prices $0.001–$0.02/call.",
                ...(getLeaderboard ? { ecosystem: "Call top_x402_sellers to see which x402 sellers (any wallet, not just this host) are settling the most USDC on Base in the last 24h — discovers the live economy beyond this catalog." } : {}),
                docs: `${baseUrl}/llms.txt`,
              }, null, 2),
            }],
          };
        }
        if (name === "top_x402_sellers" && getLeaderboard) {
          const snap = getLeaderboard() || {};
          const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 50);
          const sort = args.sort === "calls" ? "calls" : "usd";
          const include = args.include === "all" ? "all" : "external";
          // Self-wallet filter: agents asking "who else is on x402?" want the
          // host's own wallet hidden by default. The hosted catalog ranks
          // because of this very tool process, so leaving it in skews the top
          // toward Agent402 itself.
          const self = (process.env.WALLET_ADDRESS || "").toLowerCase();
          let board = Array.isArray(snap.leaderboard) ? snap.leaderboard : [];
          if (include === "external" && self) board = board.filter((r) => (r.wallet || "").toLowerCase() !== self);
          board = rankLeaderboard(board, sort).slice(0, limit);
          // Trim to a token-cheap row shape — full row (origins, endpoints,
          // etc.) is at /api/leaderboard for agents that want it. Round USDC
          // to 4dp to match the HTML page's display precision and keep the
          // JSON compact.
          const rows = board.map((r) => ({
            rank: r.rank,
            name: r.name,
            network: r.network,
            wallet: r.wallet,
            homepage: r.homepage || null,
            callsSettled: r.callsSettled || 0,
            totalUsd: Math.round((r.totalUsd || 0) * 10000) / 10000,
            uniqueBuyers: r.uniqueBuyers || 0,
          }));
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                window: snap.windowLabel || "24h",
                asOf: snap.asOf,
                sort,
                include,
                totalSellers: (snap.leaderboard || []).length,
                results: rows,
                ...(snap.warming || snap.scanSkipped ? { note: "Cache is warming — results may be partial. Retry in ~60s." } : {}),
                source: `${baseUrl}/api/leaderboard`,
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
        // Accept params as an object OR a JSON string — LLM clients (e.g. some
        // Claude Code calls) often stringify object arguments. Parse those so
        // the handler receives real fields instead of an empty object.
        //
        // ALSO: many LLMs ignore the {slug, params} envelope and flatten the
        // arguments — e.g. { slug: "whois", domain: "example.com" } instead of
        // { slug: "whois", params: { domain: "example.com" } }. Without a
        // fallback those calls all 4xx in 1ms (the analytics dashboard makes
        // this brutally visible — whois was 100% errored with p50=1ms). When
        // `params` is missing/invalid, treat the rest of `args` as params so
        // the natural-but-wrong shape still works.
        let params = args.params;
        if (typeof params === "string") {
          const s = params.trim();
          try { params = JSON.parse(s); }
          catch {
            // tolerate a single "key=value" pair as a last resort
            const eq = s.indexOf("=");
            params = eq > 0 ? { [s.slice(0, eq).trim()]: s.slice(eq + 1).trim() } : {};
          }
        }
        if (!params || typeof params !== "object" || Array.isArray(params)) {
          // Flattened args fallback: everything except `slug` becomes params.
          const { slug: _drop, ...rest } = args;
          params = rest && typeof rest === "object" && Object.keys(rest).length ? rest : {};
        }
        // Same contract as the express kit routes; handlers only see input.
        // Time the call so the analytics dispatcher gets accurate latency for
        // MCP traffic (same as the HTTP path). Errors here flow into the
        // catch below and are reported with errored:true.
        const startedAt = Date.now();
        let result;
        try {
          result = await entry.def.handler(params, { headers: {}, query: params, body: params, ip });
        } catch (handlerErr) {
          // statusCode lets the analytics dispatcher split 4xx (bad input) from
          // 5xx (handler/upstream broke). errorMessage flows into the diagnostic
          // log so we can spot patterns like a single bad caller hammering one
          // tool with the wrong field shape.
          onServed(entry.def.slug, {
            latencyMs: Date.now() - startedAt,
            errored: true,
            statusCode: handlerErr.statusCode || 500,
            errorMessage: handlerErr.message,
          });
          // Self-correction envelope: when the call fails the LLM caller almost
          // always has enough information in the original tool description, but
          // it ignored it. Echo the expected shape + a working example back so
          // the next attempt can fix itself without another search_tools call.
          const hint = {
            error: handlerErr.message,
            tool: entry.def.slug,
            expected: entry.def.discovery?.inputSchema?.properties || {},
            required: entry.def.discovery?.inputSchema?.required || [],
            example: entry.def.discovery?.input || {},
            callWith: {
              name: "call_tool",
              arguments: { slug: entry.def.slug, params: entry.def.discovery?.input || {} },
            },
          };
          return { content: [{ type: "text", text: JSON.stringify(hint, null, 2) }], isError: true };
        }
        onServed(entry.def.slug, { latencyMs: Date.now() - startedAt, errored: false });
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
    // req.ip is derived via the app's "trust proxy" setting, so it's the real
    // client IP (the edge-appended XFF hop) — NOT a spoofable client-supplied
    // X-Forwarded-For value. This is the only abuse control on the free tier,
    // so it must not be bypassable by injecting a header.
    const ip = (req.ip || req.socket.remoteAddress || "?").trim();
    // Adoption telemetry: every MCP session announces its client at
    // initialize (e.g. "claude-ai", "claude-code"). In-memory since boot.
    const ci = req.body?.method === "initialize" ? req.body?.params?.clientInfo : null;
    if (ci?.name && mcpClients.size < 500) {
      const key = `${ci.name}@${ci.version || "?"}`.slice(0, 80);
      mcpClients.set(key, (mcpClients.get(key) || 0) + 1);
      console.log(`[mcp] initialize from ${key}`);
    }
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
