import { RAILS_PAREN, RAILS_OR } from "./rails.js";
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
import { recordWish } from "./wish.js";
import { capturePostHogDiscovery } from "./posthog.js";
import { rankBy as rankLeaderboard } from "./leaderboard.js";
import { SKILL_PACKS, buildPromptMessages, rankSkillPacks } from "./skills.js";
import {
  createLimiter,
  MAX_CALLS_PER_BURST,
  MAX_CALLS_PER_WINDOW,
} from "./rate-limit.js";

const VERSION = "0.3.0";

// Mirrors server.js's FIND_WEAK_SCORE: an empty result set, or a top score
// below this, reads as "the catalog probably doesn't have this" — the
// trigger for the request_tool hint + a fire-and-forget find-miss wish.
const FIND_WEAK_SCORE = 5;
const WISH_HINT_TEXT = "Nothing matched well? Tell us what you needed via POST /api/wish — we cluster demand and build what keeps coming up.";

// Per-IP sliding-window rate limit for tool executions (search/info are free).
// Generous enough for real use of $0.001-grade CPU tools, tight enough that
// the free tier can't be farmed as infrastructure. Limiter implementation +
// policy live in src/rate-limit.js so the direct-HTTP PoW redemption path
// applies the same quota.
const mcpLimiter = createLimiter("mcp");
const rateLimited = (ip) => mcpLimiter.check(ip).limited;

// Outer transport guards (audit R-11). The tool limiter above only fires INSIDE
// call_tool; a flood of initialize/discovery/malformed POSTs would otherwise
// allocate a server + transport per request before any tool limit applies.
// These bound raw POST volume BEFORE server creation:
//   - a per-IP request cap on its OWN bucket, deliberately more generous than
//     the tool limiter so a legit session (one initialize + many tool calls)
//     is never throttled by it;
//   - a global in-flight transport semaphore capping concurrent allocation;
//   - a per-request deadline so a stalled request can't pin a transport.
// All env-tunable; defaults are generous for real clients, tight against floods.
const MCP_REQ_PER_MIN = Number(process.env.AGENT402_MCP_REQ_PER_MIN) || Math.max(60, MAX_CALLS_PER_BURST * 3);
const MCP_REQ_PER_HOUR = Number(process.env.AGENT402_MCP_REQ_PER_HOUR) || Math.max(600, MAX_CALLS_PER_WINDOW * 3);
const mcpReqLimiter = createLimiter("mcp-transport", { perMin: MCP_REQ_PER_MIN, perHour: MCP_REQ_PER_HOUR });
const MCP_MAX_CONCURRENT = Number(process.env.AGENT402_MCP_MAX_CONCURRENT) || 64;
const MCP_REQ_DEADLINE_MS = Number(process.env.AGENT402_MCP_REQ_DEADLINE_MS) || 30_000;
let mcpInFlight = 0;

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

  // Curated first-class tools: a SMALL, highly-recognizable set of free utilities
  // exposed directly in tools/list so MCP directories (Glama, etc.) and agents
  // see a legible slice of the catalog without a search_tools round-trip. All
  // must be PoW-eligible (free). Calling one by name is equivalent to
  // call_tool({slug, params}) — same handler, same rate limit. Kept deliberately
  // TIGHT (the full 500-tool catalog lives behind search_tools/find_tool/call_tool
  // by design): MCP directories score a well-scoped server at ~3-15 tools, and
  // every entry here rides in each client's context on every turn. So this is a
  // small legibility sample of universally-recognized dev utilities, not a dump.
  // Exactly 15 tools listed in total: Glama's tool-count rubric scores a
  // well-scoped server at 3-15, so curated changes here must SWAP, not add.
  // timezone-convert replaced markdown-to-html 2026-07-16: the completeness
  // rubric called out "no date/time manipulation beyond unit conversion",
  // and document rendering was the weakest fit for an agent utility sample.
  const CURATED_SLUGS = [
    "hash", "unit-convert", "qr", "json-format", "jwt-decode",
    "base64", "uuid", "csv-to-json", "timezone-convert",
  ];
  const curatedSet = new Set();
  for (const slug of CURATED_SLUGS) {
    const entry = tools.get(slug);
    if (entry?.free) curatedSet.add(slug);
  }

  // Wallet-management tools surfaced first-class so MCP directories see explicit
  // balance + history capabilities by name (this is the dimension Glama scores
  // as "wallet management"), not just the payment_info doc tool. These are
  // on-chain READ tools and wallet-only (paid egress), so on this authless
  // connector calling one returns paid-access setup instructions — the listing
  // advertises the capability honestly; execution needs a funded wallet.
  const WALLET_MGMT_SLUGS = ["wallet-balances", "wallet-transactions"];
  const walletMgmtSet = new Set();
  for (const slug of WALLET_MGMT_SLUGS) {
    if (tools.has(slug)) walletMgmtSet.add(slug);
  }

  const schemaOf = (def) => {
    const s = def.discovery?.inputSchema;
    return s ? { type: "object", ...s } : { type: "object" };
  };

  // MCP tool names are exposed in snake_case so the whole tools/list is one
  // consistent convention (the meta-tools are already snake_case; the curated
  // tools' slugs are kebab). CallTool accepts either form, so no caller breaks.
  const toSnake = (slug) => String(slug).replace(/-/g, "_");
  // Every MCP tool name follows ONE pattern: verb_noun, action first — the
  // pattern Glama's naming-consistency rubric names as the target ("many use
  // verb_noun with underscores"). Slug -> exposed name; the meta tools
  // (search_tools/find_tool/call_tool) are already verb-first.
  const MCP_NAME_OVERRIDES = {
    hash: "generate_hash",
    "unit-convert": "convert_units",
    qr: "generate_qr",
    "json-format": "format_json",
    "jwt-decode": "decode_jwt",
    base64: "convert_base64",
    uuid: "generate_uuid",
    "csv-to-json": "parse_csv",
    "timezone-convert": "convert_timezone",
    "wallet-balances": "get_wallet_balances",
    "wallet-transactions": "get_wallet_transactions",
  };
  const mcpNameOf = (slug) => MCP_NAME_OVERRIDES[slug] || toSnake(slug);
  // Prior exposed names that must still route so no integration breaks across a
  // rename: the 2026-07-17 noun_verb pass (base64_convert, qr_generate, …).
  // The old `payment_info` meta name is aliased in the CallTool dispatch below.
  const LEGACY_MCP_ALIASES = {
    base64_convert: "base64", qr_generate: "qr", uuid_generate: "uuid", hash_generate: "hash",
  };
  // Every accepted spelling of a first-class tool name -> its catalog slug
  // (exposed verb_noun name, legacy snake form, raw kebab slug, prior renames).
  const namedToolSlugs = new Map();
  for (const slug of [...curatedSet, ...walletMgmtSet]) {
    namedToolSlugs.set(mcpNameOf(slug), slug);
    namedToolSlugs.set(toSnake(slug), slug);
    namedToolSlugs.set(slug, slug);
  }
  for (const [alias, slug] of Object.entries(LEGACY_MCP_ALIASES)) {
    if (curatedSet.has(slug) || walletMgmtSet.has(slug)) namedToolSlugs.set(alias, slug);
  }
  // A concise "Returns { … }" clause from a tool's documented example so every
  // curated tool advertises its output shape, not just its input.
  const returnsHint = (def) => {
    const ex = def.discovery?.output?.example;
    if (!ex || typeof ex !== "object") return "";
    const keys = Object.keys(ex).slice(0, 8);
    return keys.length ? ` Returns { ${keys.join(", ")} }.` : "";
  };

  // Returns { rows, topScore } — topScore feeds the "did this actually match
  // anything useful" check for the request_tool hint (see search_tools below).
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
    const rows = scored.slice(0, Math.min(Number(limit) || 10, 25)).map(([, def, free]) => ({
      slug: def.slug,
      price: def.price,
      access: free ? "free here (rate-limited)" : "wallet required (USDC via x402 — use the agent402-mcp npm server)",
      description: def.description.length > 200 ? `${def.description.slice(0, 200)}…` : def.description,
      inputSchema: schemaOf(def),
    }));
    return { rows, topScore: scored[0]?.[0] ?? 0 };
  }

  function walletRequiredText(def) {
    return [
      `"${def.slug}" (${def.price}/call) needs per-call USDC payment and is not part of this hosted free tier.`,
      `To use it from Claude/any MCP client: run the npm server with a funded Base wallet —`,
      `npx agent402-mcp with env AGENT_KEY=0x<private key> (USDC on Base/Polygon/Arbitrum, or USDG on Robinhood Chain via AGENT402_NETWORKS=robinhood) and/or SOLANA_AGENT_KEY=<base58 secret> (USDC on Solana); spend caps: AGENT402_MAX_PER_CALL, AGENT402_BUDGET.`,
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
            `BROWSE the catalog: keyword search over Agent402's ${tools.size} pay-per-call web tools, returning a LIST of candidates to compare (its counterpart find_tool resolves a task to ONE ready-to-run pick — search explores, find decides). Categories: live market data (stock-quote at $0.003), encoding, crypto, text, time, math, validation, unit conversions, network, browser, PDF, search, memory. ${freeCount} pure-CPU tools run free here (proof-of-work — no wallet needed); the rest need a USDC wallet. There is also an OpenAI-compatible LLM gateway at ${baseUrl}/v1 — flat per-call (chat nano $0.003, auto $0.01, embeddings $0.002), no API key: a funded wallet is the account. Returns { results, workflows } — each result has slug, price, access, description, inputSchema; run one with call_tool.`,
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
          title: "Resolve a task to the one best Agent402 tool",
          annotations: { title: "Resolve a task to the one best Agent402 tool", ...SAFE },
          description:
            "DECIDE, don't browse: resolve a plain-language task to the single best-matching Agent402 tool, returned call-ready — slug, price, input schema, and a worked example (its counterpart search_tools returns a list of candidates to compare — search explores, find decides). Returns { task, matches } with the top pick first; then run call_tool with the chosen slug + params.",
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
            `Run an Agent402 tool by slug (discover slugs with search_tools or find_tool; params must match that tool's inputSchema). The ${freeCount} pure-CPU tools execute free on this hosted connector (rate-limited, no wallet — proof-of-work covers them) and return the tool's JSON result. Wallet-only tools (live market data like stock-quote at $0.003, live search, browser rendering, PDFs, durable memory) return a paid-access setup guide instead — this connector holds no wallet. An unknown slug returns an error pointing back to search_tools.`,
          inputSchema: {
            type: "object",
            properties: {
              slug: { type: "string", description: 'Tool slug, e.g. "unit-convert"' },
              params: { type: "object", description: "Tool input, matching the tool's inputSchema" },
            },
            required: ["slug"],
          },
        },
        // Payment / wallet management surface — documents how paying works, how
        // to configure a wallet + spend caps, and points to the on-chain
        // wallet-balances / wallet-transactions tools for balance + history.
        {
          name: "get_payment_info",
          title: "Payment and wallet setup",
          annotations: { title: "Payment and wallet setup", ...SAFE },
          description:
            `How paying for Agent402 tools works and how to manage a wallet. This hosted connector holds NO wallet: ${freeCount} pure-CPU tools run free here (or solve a proof-of-work puzzle), the rest — including the /v1 OpenAI-compatible LLM gateway (chat nano $0.003, embeddings $0.002; no API key, wallet = account) — settle in USDC via x402. Covers: the free vs paid split, how to configure a funded wallet + per-call and budget spend caps, the rails (${RAILS_OR}), and checking a wallet's balance/transaction history via the wallet-balances / wallet-transactions tools. Returns { connector, freeTier, pay, spendControls, balanceAndHistory }.`,
          inputSchema: { type: "object", properties: {} },
        },
        // Curated free tools — exposed first-class so directory listings
        // (Glama, etc.) show what agents can actually run on this connector
        // without needing search_tools first. Each is callable by name.
        ...[...curatedSet].map((slug) => {
          const { def } = tools.get(slug);
          return {
            name: mcpNameOf(slug),
            title: def.name,
            annotations: { title: def.name, ...SAFE },
            description: `[free, no wallet] ${def.description}${returnsHint(def)}`,
            inputSchema: schemaOf(def),
          };
        }),
        // Wallet-management tools — listed by name so directories/agents see the
        // balance + history capability explicitly. Wallet-only: on this authless
        // connector call_tool returns paid-access setup, not a live result.
        ...[...walletMgmtSet].map((slug) => {
          const { def } = tools.get(slug);
          return {
            name: mcpNameOf(slug),
            title: def.name,
            annotations: { title: def.name, ...SAFE },
            description: `[wallet-required, ${def.price}/call] ${def.description}${returnsHint(def)} This hosted connector holds no wallet, so calling it here returns paid-access setup; run it with a funded wallet via npx agent402-mcp or any x402 client.`,
            inputSchema: schemaOf(def),
          };
        }),
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args = {} } = req.params;
      try {
        if (name === "search_tools") {
          // Funnel stage 1 (discovery) — same event the HTTP discovery
          // surfaces emit in server.js; env-gated no-op without PostHog.
          capturePostHogDiscovery({ surface: "mcp:search_tools" });
          const q = args.query ?? "";
          const { rows: results, topScore } = searchTools(q, args.limit);
          // Multi-tool workflows that match the same query — surface them so an
          // agent asking "audit a domain" sees the whole security-audit pack
          // (callable via prompts/get on this connector) alongside the tools.
          const workflows = rankSkillPacks(q, { k: 2, baseUrl });
          // Weak/empty match: nudge toward request_tool instead of a dead
          // end. No wish recorded here — search_tools is a looser lexical
          // search than find_tool, not a task-intent signal; the explicit
          // request_tool call (or find_tool's find-miss capture) is the
          // actual demand signal.
          const weak = results.length === 0 || topScore < FIND_WEAK_SCORE;
          return {
            content: [{
              type: "text",
              text: results.length || workflows.length
                ? JSON.stringify({
                    results,
                    ...(workflows.length ? { workflows, workflowsUsage: "prompts/get { name: workflows[i].promptName, arguments: { …promptArgs } }" } : {}),
                    ...(weak ? { hint: WISH_HINT_TEXT } : {}),
                    usage: 'call_tool {"slug": …, "params": …}',
                  }, null, 2)
                : `No tools matched "${q}". Full catalog: ${baseUrl}/tools. ${WISH_HINT_TEXT}`,
            }],
          };
        }
        if (name === "find_tool") {
          capturePostHogDiscovery({ surface: "mcp:find_tool" });
          const taskStr = String(args.task ?? args.query ?? "");
          const r = findTools(catalog, taskStr, { k: args.limit, baseUrl, powSlugs: freeSlugs });
          const results = r.results.map((t) => ({
            slug: t.slug,
            price: t.price,
            access: t.computePayable ? "free here (rate-limited)" : "wallet required (USDC via x402 — use the agent402-mcp npm server)",
            // Discovery up top: same ordering as /api/find — the answer to
            // "how do I call this" (callWith / example / required) should be
            // visible before the verbose description/schema fields. `required`
            // is always an array so callers can scan without a guard.
            callWith: { name: "call_tool", arguments: { slug: t.slug, params: t.example ?? {} } },
            example: t.example,
            required: Array.isArray(t.required) ? t.required : [],
            inputSchema: t.inputSchema,
            description: t.description.length > 200 ? `${t.description.slice(0, 200)}…` : t.description,
          }));
          // Weak/empty match: this IS a task-intent signal (unlike
          // search_tools' looser lexical search), so capture it as a
          // find-miss wish — fire-and-forget, rate-limit exempt, never
          // blocks the response.
          const topScore = r.results[0]?.score ?? 0;
          const weak = r.count === 0 || topScore < FIND_WEAK_SCORE;
          if (weak && taskStr.trim()) {
            try { recordWish({ need: taskStr.trim(), source: "find-miss" }); } catch { /* best-effort */ }
          }
          return {
            content: [{
              type: "text",
              text: results.length || r.packs?.length
                ? JSON.stringify({
                    task: r.query,
                    results,
                    ...(r.packs?.length ? { workflows: r.packs, workflowsUsage: "prompts/get { name: workflows[i].promptName, arguments: { …promptArgs } }" } : {}),
                    ...(weak ? { hint: WISH_HINT_TEXT } : {}),
                    usage: "Run call_tool with the chosen {slug, params}. Free results execute here; wallet-only need the agent402-mcp npm server.",
                  }, null, 2)
                : `No tool matched "${taskStr}". Browse the catalog: ${baseUrl}/tools. ${WISH_HINT_TEXT}`,
            }],
          };
        }
        if (name === "request_tool") {
          // The other half of the wish loop: an explicit "I needed something
          // you don't have" signal, same recordWish path as POST /api/wish
          // (source "mcp" instead of "api") — rate-limited per-IP/global,
          // clustered by normalized text, surfaced at GET /api/wishes.
          try {
            const result = recordWish({ need: args.need, context: args.context, source: "mcp", ip });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          } catch (err) {
            return { content: [{ type: "text", text: err.message }], isError: true };
          }
        }
        if (name === "about_agent402") {
          capturePostHogDiscovery({ surface: "mcp:about" });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                service: baseUrl,
                connector: "hosted free tier (authless)",
                // Lead with what the demand data says converts. Prices here must
                // track the catalog (llm-gateway-kit tiers, finance-kit
                // stock-quote) — update in lockstep, never invent numbers.
                startHere: {
                  llmGateway: `OpenAI-compatible LLM gateway at ${baseUrl}/v1 — flat per-call pricing: chat nano $0.003, auto (eval-ranked model routing) $0.01, embeddings $0.002. No API key, no signup: a funded wallet IS the account (x402 settles per call).`,
                  freeTier: `${freeCount} pure-CPU tools run free right here with no wallet — payable with ~milliseconds of proof-of-work CPU.`,
                  liveMarketData: "Live market data at agent-native prices — stock-quote is $0.003/call (find it and stock-history/crypto-price via search_tools).",
                },
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
                paidAccess: `Every tool, no rate limit: pay per call in ${RAILS_PAREN} via the x402 protocol — npx agent402-mcp with AGENT_KEY (EVM) and/or SOLANA_AGENT_KEY (Solana), or any x402 HTTP client. No signup, no API key; most tools $0.001–$0.02/call (LLM gateway tiers $0.002–$0.50).`,
                ...(getLeaderboard ? { ecosystem: "Call top_x402_sellers to see which x402 sellers (any wallet, not just this host) are settling the most USDC (primarily on Base) in the last 24h — discovers the live economy beyond this catalog." } : {}),
                missingATool: "Call request_tool (or POST /api/wish) with what you needed. We cluster and track demand — repeated requests get built.",
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
        // Curated tools called by name: route to the same handler as
        // call_tool but use `name` as the slug and `args` as params directly.
        if (name === "get_payment_info" || name === "payment_info") {
          return {
            content: [{ type: "text", text: JSON.stringify({
              connector: "hosted free tier — no wallet is held on this connector (authless)",
              freeTier: {
                pureCpuToolsFree: freeCount,
                how: "pure-CPU tools run free here (rate-limited); wallet-only tools return paid-access instructions",
                proofOfWork: "a walletless client can solve a proof-of-work puzzle instead of paying on eligible tools",
              },
              pay: {
                model: "HTTP 402 + x402, settled in USDC on-chain, non-custodial (you hold the key)",
                rails: RAILS_PAREN,
                setup: "run the agent402-mcp npm server: `npx agent402-mcp` with AGENT_KEY=0x<private key> for EVM (USDC on Base/Polygon/Arbitrum, USDG on Robinhood via AGENT402_NETWORKS) and/or SOLANA_AGENT_KEY=<base58 secret> for Solana. No signup, no API key.",
                prices: "most tools $0.001–$0.02 per call (LLM gateway tiers $0.002–$0.50) — see each tool's exact price in search_tools results",
                llmGateway: `the /v1 OpenAI-compatible endpoints (chat nano $0.003, auto $0.01, embeddings $0.002) settle the same way — point any OpenAI SDK at ${baseUrl}/v1 through an x402-paying fetch; no API key, the wallet is the account`,
              },
              spendControls: { perCall: "AGENT402_MAX_PER_CALL caps any single call", totalBudget: "AGENT402_BUDGET caps cumulative spend for the session" },
              balanceAndHistory: {
                balance: "check a wallet's USDC balance with the `wallet-balances` (multi-chain) or `wallet-balance` (single) tool",
                transactions: "pull a wallet's transaction history with the `wallet-transactions` tool",
                note: "these are on-chain read tools — call them via call_tool (they need a wallet/paid access, or run them on the npm server)",
              },
            }, null, 2) }],
          };
        }
        // First-class tools are exposed under their MCP name (mcpNameOf), but
        // the router accepts every historical spelling — exposed name, legacy
        // snake form, raw kebab slug — so no existing caller breaks across
        // renames. Curated tools are free; wallet-management tools are
        // wallet-only and fall through to the paid-access response below (same
        // as any wallet tool reached via call_tool).
        const namedSlug = namedToolSlugs.get(name) ?? namedToolSlugs.get(name.replace(/_/g, "-")) ?? null;
        const isNamed = namedSlug !== null;
        const isCurated = isNamed && curatedSet.has(namedSlug);
        if (name !== "call_tool" && !isNamed) {
          return { content: [{ type: "text", text: `Unknown tool "${name}".` }], isError: true };
        }
        const resolvedSlug = isNamed ? namedSlug : String(args.slug ?? "");
        const entry = tools.get(resolvedSlug);
        if (!entry) {
          return { content: [{ type: "text", text: `Unknown slug "${resolvedSlug}". Use search_tools to find the right slug.` }], isError: true };
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
        // Curated tools called by name: args IS the params (no envelope).
        // call_tool path: accept params as object, JSON string, or flattened.
        let params;
        if (isCurated) {
          params = args;
        } else {
          // Accept params as an object OR a JSON string — LLM clients (e.g.
          // some Claude Code calls) often stringify object arguments.
          //
          // ALSO: many LLMs ignore the {slug, params} envelope and flatten —
          // e.g. { slug: "whois", domain: "example.com" } instead of
          // { slug: "whois", params: { domain: "example.com" } }. When
          // `params` is missing/invalid, treat the rest of `args` as params.
          params = args.params;
          if (typeof params === "string") {
            const s = params.trim();
            try { params = JSON.parse(s); }
            catch {
              const eq = s.indexOf("=");
              params = eq > 0 ? { [s.slice(0, eq).trim()]: s.slice(eq + 1).trim() } : {};
            }
          }
          if (!params || typeof params !== "object" || Array.isArray(params)) {
            const { slug: _drop, ...rest } = args;
            params = rest && typeof rest === "object" && Object.keys(rest).length ? rest : {};
          }
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
            inputKeys: params && typeof params === "object" ? Object.keys(params) : [],
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

  // Wildcard CORS so browser-based MCP clients (inspector, web agents) work;
  // claude.ai connects server-side and ignores this. This is a deliberate
  // product requirement for a PUBLIC MCP connector (security audit A402-12).
  // It is safe because it is CREDENTIAL-FREE: Access-Control-Allow-Credentials
  // is never set, so browsers won't attach cookies, and the wildcard origin +
  // credentials combination is rejected by the browser anyway. There is no
  // cookie/session authority on /mcp; abuse is bounded by the per-IP/per-minute
  // and per-hour rate limits (AGENT402_MCP_MAX_PER_MIN / _PER_HOUR), not by
  // origin. DO NOT add Access-Control-Allow-Credentials here.
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
    // R-11 outer gate #1: per-IP raw-request cap, BEFORE allocating anything.
    if (mcpReqLimiter.check(ip).limited) {
      return res.status(429).json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many requests to /mcp — slow down and retry shortly." }, id: req.body?.id ?? null });
    }
    // R-11 outer gate #2: global in-flight transport ceiling, BEFORE building
    // the server/transport (bounds allocation under an initialize/malformed flood).
    if (mcpInFlight >= MCP_MAX_CONCURRENT) {
      return res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "MCP endpoint is at capacity — retry shortly." }, id: req.body?.id ?? null });
    }
    // Adoption telemetry: every MCP session announces its client at
    // initialize (e.g. "claude-ai", "claude-code"). In-memory since boot.
    const ci = req.body?.method === "initialize" ? req.body?.params?.clientInfo : null;
    if (ci?.name && mcpClients.size < 500) {
      const key = `${ci.name}@${ci.version || "?"}`.slice(0, 80);
      mcpClients.set(key, (mcpClients.get(key) || 0) + 1);
      console.log(`[mcp] initialize from ${key}`);
    }
    mcpInFlight++;
    let deadlineTimer = null;
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => transport.close());
      await buildServer(ip).connect(transport);
      // R-11 outer gate #3: per-request deadline — a stalled request can't pin
      // a transport (and its slot) forever.
      const deadline = new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => reject(Object.assign(new Error("mcp request deadline exceeded"), { __deadline: true })), MCP_REQ_DEADLINE_MS);
      });
      await Promise.race([transport.handleRequest(req, res, req.body), deadline]);
    } catch (err) {
      if (!res.headersSent) {
        res.status(err.__deadline ? 504 : 500).json({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: req.body?.id ?? null });
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      mcpInFlight--;
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
