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
//   AGENT402_URL          target service (default https://agent402.tools)
//   AGENT_KEY             hex private key of a funded wallet (USDC on Base) — optional
//   AGENT402_TOOLS        comma-separated slugs to expose first-class (overrides default)
//   AGENT402_MAX_PER_CALL refuse any single call priced above this many USD (e.g. 0.01)
//   AGENT402_BUDGET       hard cap on total USDC spent this session (e.g. 1.00)
import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE = (process.env.AGENT402_URL || "https://agent402.tools").replace(/\/$/, "");
const AGENT_KEY = process.env.AGENT_KEY || "";
const VERSION = "0.8.0";

// Spend controls — enforced BEFORE a payment is ever signed, so a confused or
// runaway model cannot drain the wallet. Unset = unlimited (back-compat).
const num = (v) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const MAX_PER_CALL = num(process.env.AGENT402_MAX_PER_CALL) ?? Infinity;
const BUDGET = num(process.env.AGENT402_BUDGET) ?? Infinity;
let spentUsd = 0;

const DEFAULT_CURATED = [
  // the tools agents can't replicate locally: live search, browser, PDF, shared memory
  "search", "extract", "render", "screenshot", "pdf", "meta", "dns", "http-check", "tls-cert", "whois",
  "memory-write", "memory-read", "memory-remember", "memory-recall",
  // one cheap pure-CPU tool so wallet-less clients see the proof-of-work path work
  "hash",
];

// stdout is the MCP protocol channel — all logging goes to stderr.
const log = (...a) => console.error("[agent402-mcp]", ...a);

// ---------------------------------------------------------------------------
// Catalog: built from the service's own machine-readable surfaces.
const catalog = new Map(); // slug -> { slug, method, path, price, description, category, computePayable, inputSchema }
// Skill packs — curated multi-tool workflows, fetched at startup from the
// hosted service so the npm package picks up new packs without a republish.
// Empty if the discovery fetch fails (older services or transient errors);
// prompts/list will just return an empty array in that case.
let skillPacks = [];

async function loadCatalog() {
  const [pricing, openapi, packs] = await Promise.all([
    fetch(`${BASE}/api/pricing`).then((r) => r.json()),
    fetch(`${BASE}/openapi.json`).then((r) => r.json()),
    fetch(`${BASE}/api/skill-packs.json`).then((r) => (r.ok ? r.json() : { packs: [] })).catch(() => ({ packs: [] })),
  ]);
  skillPacks = Array.isArray(packs?.packs) ? packs.packs : [];
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
    const price = parseFloat(String(tool.price).replace(/[^0-9.]/g, "")) || 0;
    if (price > MAX_PER_CALL) {
      return {
        content: [{ type: "text", text: `Refused without paying: "${tool.slug}" costs ${tool.price}/call, above the AGENT402_MAX_PER_CALL cap of $${MAX_PER_CALL}. Raise the cap on this MCP server to allow it.` }],
        isError: true,
      };
    }
    if (spentUsd + price > BUDGET) {
      return {
        content: [{ type: "text", text: `Refused without paying: session budget exhausted ($${spentUsd.toFixed(4)} of $${BUDGET} spent; "${tool.slug}" costs ${tool.price}). Restart the MCP server or raise AGENT402_BUDGET.` }],
        isError: true,
      };
    }
    const payFetch = await getPayFetch();
    res = await payFetch(url, init);
    // Count spend when the server confirms settlement (payment receipt header),
    // falling back to any 2xx — conservative in the buyer's favor.
    if (res.headers.get("x-payment-response") || res.ok) spentUsd += price;
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

// Rank the curated multi-tool skill packs against the same query, so a single
// search_tools call also tells the agent "this looks like a `security-audit`
// or `email-deliverability` job — fetch the whole template via prompts/get".
// Weighted slug/title/tagline/useCase/toolSlugs match — same shape as the
// hosted /api/find ranking, kept inline here so the stdio package stays
// dependency-free. Returns [] when no pack scores above the noise floor.
function rankWorkflows(query, k = 2) {
  const terms = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  if (!terms.length || !skillPacks.length) return [];
  const scored = [];
  for (const p of skillPacks) {
    const slug = p.slug.toLowerCase();
    const title = (p.title || "").toLowerCase();
    const tagline = (p.tagline || "").toLowerCase();
    const useCase = (p.useCase || "").toLowerCase();
    const toolSet = new Set((p.toolSlugs || []).map((s) => String(s).toLowerCase()));
    const workflowHay = (p.workflow || []).join(" ").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (slug === term) score += 12;
      else if (slug.includes(term)) score += 5;
      if (title.includes(term)) score += 3;
      if (tagline.includes(term)) score += 2;
      if (useCase.includes(term)) score += 1;
      if (toolSet.has(term)) score += 4;
      if (workflowHay.includes(term)) score += 1;
    }
    if (score >= 4) scored.push([score, p]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].slug.length - b[1].slug.length);
  return scored.slice(0, k).map(([score, p]) => ({
    slug: p.slug,
    title: p.title,
    tagline: p.tagline,
    toolCount: (p.toolSlugs || []).length,
    promptName: p.slug,
    score,
  }));
}

// ---------------------------------------------------------------------------
// MCP wiring
const server = new Server({ name: "agent402", version: VERSION }, { capabilities: { tools: {}, prompts: {} } });

// Skill packs are exposed as MCP prompts — discoverable in slash menus on any
// MCP-aware client. The list is fetched once at boot in loadCatalog(); the
// per-prompt rendering is delegated to the hosted service so the npm package
// stays thin and prompt text stays canonical with the website at /skills.
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: skillPacks.map((p) => ({
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
  const pack = skillPacks.find((p) => p.slug === name);
  if (!pack) throw new Error(`Unknown prompt "${name}". List available with prompts/list.`);
  const url = new URL(`${BASE}/api/skill-packs/${encodeURIComponent(name)}/prompt`);
  for (const [k, v] of Object.entries(args || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to render prompt "${name}" from ${BASE}: HTTP ${res.status}`);
  return await res.json();
});

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
        `Search the full Agent402 catalog (${catalog.size} pay-per-call tools: encoding, crypto, data conversion, text, time, validation, math, unit conversions, network, browser, memory). Returns matching tools with price, payment options, and input schema — call them with call_tool. Also returns matching multi-tool workflow templates (skill packs) when the query is task-shaped; fetch the whole template via prompts/get { name: "<slug>", arguments: { … } }.`,
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
    },
    // Discovery primitive: who's earning USDC on x402 right now? Proxies the
    // hosted /api/leaderboard (free, unpaywalled) and trims to the same compact
    // shape as the hosted MCP connector so cross-surface agents see the same UX.
    {
      name: "top_x402_sellers",
      description:
        "List the x402 sellers earning the most USDC (or serving the most calls) on Base in the last ~24h, derived from on-chain USDC transfers. Useful for agents discovering the live x402 economy: who's getting paid, which networks, and where to point demand. Free to call (no payment, no proof-of-work). Defaults: top 10, sort by USDC, exclude this service's own wallet.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max rows to return (default 10, max 50)" },
          sort: { type: "string", enum: ["usd", "calls"], description: "Rank by USDC settled (default) or by call count" },
          include: { type: "string", enum: ["external", "all"], description: "'external' (default) hides this service's own wallet; 'all' includes it" },
        },
      },
    }
  );
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === "search_tools") {
      const q = args.query ?? "";
      const results = searchTools(q, args.limit ?? 10);
      const workflows = rankWorkflows(q, 2);
      return {
        content: [{
          type: "text",
          text: results.length || workflows.length
            ? JSON.stringify({
                results,
                ...(workflows.length ? { workflows, workflowsUsage: "prompts/get { name: workflows[i].promptName, arguments: { …per-pack args } } returns the full Claude-ready task template." } : {}),
                usage: "call_tool {\"slug\": …, \"params\": …}",
              }, null, 2)
            : `No tools matched "${q}". Browse the catalog at ${BASE}/tools or ${BASE}/api/pricing.`,
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
            workflows: skillPacks.length,
            spendControls: AGENT_KEY
              ? {
                  maxPerCallUsd: MAX_PER_CALL === Infinity ? "unlimited" : MAX_PER_CALL,
                  sessionBudgetUsd: BUDGET === Infinity ? "unlimited" : BUDGET,
                  spentThisSessionUsd: Number(spentUsd.toFixed(6)),
                  remainingUsd: BUDGET === Infinity ? "unlimited" : Number(Math.max(0, BUDGET - spentUsd).toFixed(6)),
                }
              : "n/a (proof-of-work mode spends CPU, not money)",
            note: AGENT_KEY
              ? "Every tool is available; each call is paid in USDC via x402 from the configured wallet, within the spend controls above."
              : `No AGENT_KEY configured: ${computePayable} pure-CPU tools are free via proof-of-work; the ${catalog.size - computePayable} network/browser/memory tools need a funded wallet (set AGENT_KEY).`,
            ecosystem: "Call top_x402_sellers to see which x402 sellers (any wallet, not just this host) are settling the most USDC on Base in the last 24h — discovers the live economy beyond this catalog.",
          }, null, 2),
        }],
      };
    }
    if (name === "top_x402_sellers") {
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 50);
      const sort = args.sort === "calls" ? "calls" : "usd";
      const include = args.include === "all" ? "all" : "external";
      // /api/leaderboard is free + unpaywalled, so this stays free regardless
      // of payment mode. Honor its query params verbatim so the surface is a
      // thin pass-through — single source of truth for ranking + filtering.
      const url = new URL(`${BASE}/api/leaderboard`);
      url.searchParams.set("top", String(limit));
      url.searchParams.set("sort", sort);
      url.searchParams.set("include", include);
      const res = await fetch(url);
      if (!res.ok) {
        return { content: [{ type: "text", text: `Failed to fetch leaderboard from ${BASE}: HTTP ${res.status}` }], isError: true };
      }
      const snap = await res.json();
      // Trim to the same compact row shape the hosted MCP connector returns —
      // cross-surface agents see one mental model. Full row (origins,
      // endpoints, scan metadata) stays accessible at /api/leaderboard.
      const rows = (snap.leaderboard || []).map((r) => ({
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
            window: snap.windowLabel || snap.windowServed || "24h",
            asOf: snap.asOf,
            sort: snap.sortServed || sort,
            include: snap.include || include,
            totalSellers: snap.totalSellers ?? (snap.leaderboard || []).length,
            results: rows,
            ...(snap.warming || snap.scanSkipped ? { note: "Cache is warming — results may be partial. Retry in ~60s." } : {}),
            source: `${BASE}/api/leaderboard`,
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
  // Don't hard-exit: starting with an empty catalog still lets the server
  // connect and answer introspection (tools/list) — required to pass directory
  // health checks (e.g. Glama) and more resilient if the catalog endpoint is
  // briefly unreachable. search_tools/call_tool just return nothing until the
  // catalog is reachable again.
  log(`Could not load the catalog from ${BASE}: ${err.message} — starting with an empty catalog`);
}
const requested = (process.env.AGENT402_TOOLS || DEFAULT_CURATED.join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);
curated = requested.map((slug) => catalog.get(slug)).filter(Boolean);
log(`catalog: ${catalog.size} tools from ${BASE}; ${curated.length} first-class, rest via search_tools/call_tool`);
log(
  AGENT_KEY
    ? `payment: USDC via x402 (wallet configured; max/call ${MAX_PER_CALL === Infinity ? "unlimited" : `$${MAX_PER_CALL}`}, budget ${BUDGET === Infinity ? "unlimited" : `$${BUDGET}`})`
    : "payment: proof-of-work on eligible tools (no AGENT_KEY)"
);

await server.connect(new StdioServerTransport());
