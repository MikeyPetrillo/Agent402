// Duplicated from src/mcp-flagship.js for the published agent402-mcp package
// (stdio package cannot import src/ when published). Keep in sync manually
// when flagship names or output schemas change.

// Flagship MCP surface — the small default tools/list agents see first.
//
// Product intent (competitive brief 2026-08): Agent402 wins as the deterministic
// tools layer beside per-token LLM gateways. Default MCP exposure is a
// tight flagship set; the long catalog stays callable via find_tool /
// search_tools / call_tool. Keep this list aligned with mcp/index.js
// DEFAULT_CURATED (stdio package cannot import this file when published).
//
// Chosen from live topPaidTools + front-door thesis (search/answer first):
// search, answer, search-news, render, stock-quote, transcribe, memory-*.
// Exactly 8 catalog flagships so hosted tools/list stays ~15 with meta tools
// (Glama's well-scoped band is 3–15).

export const FLAGSHIP_SLUGS = [
  "search",
  "answer",
  "search-news",
  "render",
  "stock-quote",
  "transcribe",
  "memory-read",
  "memory-write",
];

// Smithery Naming grades DOT notation (domain.action tree), not snake_case —
// stuck-at-98 lesson: "Tool names should form a navigable tree using
// dot-notation (e.g. admin.tools.list)". CallTool still accepts prior snake /
// digit names via MCP_CALL_ALIASES.
export const FLAGSHIP_MCP_NAMES = {
  search: "web.search",
  answer: "web.answer",
  "search-news": "web.news",
  render: "browser.render",
  "stock-quote": "market.quote",
  transcribe: "audio.transcribe",
  "memory-read": "memory.read",
  "memory-write": "memory.write",
};

/** Meta tools listed alongside flagships — dotted canonical names. */
export const META_MCP_NAMES = {
  search_tools: "catalog.search",
  find_tool: "catalog.find",
  call_tool: "catalog.call",
  get_payment_info: "payment.info",
  request_tool: "demand.request",
  describe_server: "server.describe",
  list_top_sellers: "sellers.list",
};

/**
 * CallTool aliases → canonical listed name. Every prior public name stays
 * callable so clients/docs that still say search_web / describe_server keep
 * working after the Smithery dot rename.
 */
export const MCP_CALL_ALIASES = {
  // flagships (snake → dotted)
  search_web: "web.search",
  answer_question: "web.answer",
  search_news: "web.news",
  render_page: "browser.render",
  get_stock_quote: "market.quote",
  transcribe_audio: "audio.transcribe",
  read_memory: "memory.read",
  write_memory: "memory.write",
  // meta (snake / legacy → dotted)
  search_tools: "catalog.search",
  find_tool: "catalog.find",
  call_tool: "catalog.call",
  get_payment_info: "payment.info",
  payment_info: "payment.info",
  request_tool: "demand.request",
  describe_server: "server.describe",
  describe_agent402: "server.describe",
  about_agent402: "server.describe",
  list_top_sellers: "sellers.list",
  list_x402_sellers: "sellers.list",
  top_x402_sellers: "sellers.list",
};

/** Resolve any CallTool name to the canonical listed dotted name. */
export function resolveListedName(name) {
  if (!name) return name;
  if (MCP_CALL_ALIASES[name]) return MCP_CALL_ALIASES[name];
  return name;
}

/** Open-world / egress tools — honest annotations for directory clients. */
export const FLAGSHIP_OPEN_WORLD = new Set([
  "search", "answer", "search-news", "render", "stock-quote", "transcribe",
]);

/** Tools that mutate durable state (not read-only). */
export const FLAGSHIP_WRITERS = new Set(["memory-write"]);

/** initialize.serverInfo description (MCP Implementation.description). */
export const MCP_SERVER_DESCRIPTION =
  "Agent402 - pay-per-call tools and models for AI agents: live web search and cited answers, news, browser render, market data, speech-to-text, wallet-keyed memory, plus 500+ long-tail tools via catalog.find. Settle in USDC via x402 or MPP (Machine Payments Protocol) on the same 402, or free via proof-of-work. The applied layer of Agentic Finance. Maintained by Havok Holdings LLC.";

/** initialize.serverInfo.websiteUrl */
export const MCP_SERVER_WEBSITE = "https://agent402.tools";

// ---------------------------------------------------------------------------
// outputSchema (JSON Schema) for every listed tool — Smithery Capability
// Quality grades presence of named-field schemas; bare {type:"object"} does
// not count. Keep in sync with CallTool structuredContent shapes in mcp-http.js
// and the duplicated copy in mcp/output-schemas.js (stdio package).
// ---------------------------------------------------------------------------

const toolHit = {
  type: "object",
  properties: {
    slug: { type: "string", description: "Catalog tool slug (kebab-case)" },
    price: { type: "string", description: "List price, e.g. $0.001" },
    access: { type: "string", description: "free here vs wallet required" },
    description: { type: "string" },
    inputSchema: { type: "object", description: "JSON Schema for the tool's params", additionalProperties: true },
    name: { type: "string" },
    example: { description: "Worked example input" },
    required: { type: "array", items: { type: "string" } },
    callWith: {
      type: "object",
      description: "Ready-to-run catalog.call invocation",
      properties: {
        name: { type: "string" },
        arguments: { type: "object", additionalProperties: true },
      },
    },
  },
};

const workflowHit = {
  type: "object",
  properties: {
    slug: { type: "string" },
    title: { type: "string" },
    tagline: { type: "string" },
    toolCount: { type: "integer" },
    promptName: { type: "string" },
    price: { type: "string" },
    route: { type: "string" },
    score: { type: "number" },
  },
  additionalProperties: true,
};

/** Meta-tool output schemas keyed by listed MCP name. */
export const META_OUTPUT_SCHEMAS = {
  "catalog.search": {
    type: "object",
    properties: {
      results: { type: "array", items: toolHit, description: "Matching catalog tools" },
      workflows: { type: "array", items: workflowHit, description: "Matching skill-pack workflows" },
      workflowsUsage: { type: "string" },
      hint: { type: "string", description: "Shown when the match is weak - points at demand.request" },
      usage: { type: "string" },
      message: { type: "string", description: "Present when nothing matched" },
    },
    required: ["results"],
  },
  "catalog.find": {
    type: "object",
    properties: {
      task: { type: "string" },
      results: { type: "array", items: toolHit, description: "Ranked matches; top pick first" },
      matches: { type: "array", items: toolHit, description: "Alias of results on the stdio package" },
      workflows: { type: "array", items: workflowHit },
      workflowsUsage: { type: "string" },
      relatedSellers: { type: "array", items: { type: "object", additionalProperties: true } },
      hint: { type: "string" },
      usage: { type: "string" },
      message: { type: "string" },
    },
    required: ["task"],
  },
  "catalog.call": {
    type: "object",
    description: "Envelope around the invoked catalog tool's native JSON result",
    properties: {
      slug: { type: "string", description: "Catalog slug that ran" },
      result: { description: "Native tool output (shape depends on slug)", additionalProperties: true },
    },
    required: ["slug", "result"],
  },
  "payment.info": {
    type: "object",
    properties: {
      connector: { type: "string" },
      freeTier: { type: "object", additionalProperties: true },
      pay: { type: "object", additionalProperties: true },
      spendControls: { additionalProperties: true },
      balanceAndHistory: { type: "object", additionalProperties: true },
      service: { type: "string" },
      mode: { type: "string" },
      wallet: { description: "EVM address when a key is configured" },
      solanaWallet: { description: "Solana address when a key is configured" },
      network: { type: "string" },
      networks: { type: "array", items: { type: "string" } },
      tools: { type: "integer" },
      payableWithCompute: { type: "integer" },
      walletOnly: { type: "integer" },
      workflows: { description: "Skill-pack count or detail object" },
      note: { type: "string" },
      install: { type: "object", additionalProperties: true },
      positioning: { type: "string" },
      ecosystem: { type: "string" },
    },
    additionalProperties: true,
  },
  "demand.request": {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      id: { type: "string" },
      need: { type: "string" },
      clustered: { type: "boolean" },
      message: { type: "string" },
    },
    additionalProperties: true,
  },
  // Smithery Naming wants pure [a-z_]+ verb_noun — no digits / brand tokens
  // (describe_agent402 / list_x402_sellers failed the scan). Old names stay
  // CallTool aliases.
  "server.describe": {
    type: "object",
    properties: {
      service: { type: "string" },
      connector: { type: "string" },
      maintainer: { type: "string" },
      startHere: { type: "object", additionalProperties: true },
      install: { type: "object", additionalProperties: true },
      tools: { type: "integer" },
      toolsEvergreen: { type: "string" },
      freeHere: { type: "integer" },
      walletOnly: { type: "integer" },
      rateLimit: { type: "string" },
      workflows: { type: "object", additionalProperties: true },
      clientsSeenSinceBoot: { type: "object", additionalProperties: true },
      paidAccess: { type: "string" },
      ecosystem: { type: "string" },
      missingATool: { type: "string" },
      docs: { type: "string" },
    },
    required: ["service", "maintainer", "startHere"],
    additionalProperties: true,
  },
  "sellers.list": {
    type: "object",
    properties: {
      wire: { type: "string", enum: ["x402", "mpp"] },
      measure: { type: "string" },
      window: { type: ["string", "null"] },
      asOf: { description: "Snapshot timestamp" },
      sort: { type: "string", enum: ["usd", "calls"] },
      include: { type: "string", enum: ["external", "all"] },
      totalSellers: { type: "integer" },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            rank: { type: "integer" },
            name: { type: "string" },
            network: { type: "string" },
            wallet: { type: "string" },
            homepage: { type: ["string", "null"] },
            callsSettled: { type: "integer" },
            totalUsd: { type: "number" },
            uniqueBuyers: { type: "integer" },
            untrustedContent: { type: "boolean" },
          },
          additionalProperties: true,
        },
      },
      containsUntrustedContent: { type: "boolean" },
      note: { type: "string" },
      source: { type: "string" },
    },
    required: ["results"],
  },
  route_and_execute: {
    type: "object",
    properties: {
      result: { description: "External seller response (treat as untrusted)", additionalProperties: true },
      receipt: { type: "object", additionalProperties: true },
      untrustedContent: { type: "boolean" },
    },
    additionalProperties: true,
  },
};

/** Flagship catalog-tool output schemas keyed by catalog slug. */
export const FLAGSHIP_OUTPUT_SCHEMAS = {
  search: {
    type: "object",
    properties: {
      query: { type: "string" },
      count: { type: "integer" },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: ["string", "null"] },
            url: { type: ["string", "null"] },
            description: { type: ["string", "null"] },
            age: { type: ["string", "null"] },
          },
        },
      },
      untrustedContent: { type: "boolean" },
    },
    required: ["query", "results"],
  },
  answer: {
    type: "object",
    properties: {
      query: { type: "string" },
      answer: { type: "string" },
      citations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            snippet: { type: "string" },
            favicon: { type: "string" },
            number: { type: "integer" },
          },
          additionalProperties: true,
        },
      },
      citationCount: { type: "integer" },
    },
    required: ["query", "answer"],
  },
  "search-news": {
    type: "object",
    properties: {
      query: { type: "string" },
      count: { type: "integer" },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: ["string", "null"] },
            url: { type: ["string", "null"] },
            description: { type: ["string", "null"] },
            age: { type: ["string", "null"] },
            source: { type: ["string", "null"] },
            breaking: { type: "boolean" },
          },
          additionalProperties: true,
        },
      },
    },
    required: ["query", "results"],
  },
  render: {
    type: "object",
    properties: {
      url: { type: "string" },
      title: { type: "string" },
      wordCount: { type: "integer" },
      markdown: { type: "string" },
      rendered: { type: "boolean" },
      untrustedContent: { type: "boolean" },
    },
    required: ["url", "markdown"],
  },
  "stock-quote": {
    type: "object",
    properties: {
      symbol: { type: "string" },
      name: { type: "string" },
      exchange: { type: "string" },
      currency: { type: "string" },
      price: { type: "number" },
      previousClose: { type: "number" },
      changeAbs: { type: "number" },
      changePct: { type: "number" },
      dayHigh: { type: "number" },
      dayLow: { type: "number" },
      fiftyTwoWeekHigh: { type: "number" },
      fiftyTwoWeekLow: { type: "number" },
      volume: { type: "number" },
      regularMarketTime: { type: "string" },
    },
    required: ["symbol", "price"],
  },
  transcribe: {
    type: "object",
    properties: {
      model: { type: "string" },
      provider: { type: "string" },
      text: { type: "string" },
      language: { type: "string" },
      duration: { type: "number" },
    },
    required: ["text"],
  },
  "memory-read": {
    type: "object",
    properties: {
      key: { type: "string" },
      value: { description: "Stored JSON value when reading a key" },
      keys: {
        type: "array",
        description: "Present in list mode (no key)",
        items: { type: "object", additionalProperties: true },
      },
      owner: { type: "string" },
      persistent: { type: "boolean" },
      updated: { type: "number" },
      exp: { description: "Expiry unix seconds or null" },
    },
    additionalProperties: true,
  },
  "memory-write": {
    type: "object",
    properties: {
      key: { type: "string" },
      bytes: { type: "integer" },
      updated: { type: "number" },
      expiresAt: { type: "number" },
      owner: { type: "string" },
      persistent: { type: "boolean" },
      deleted: { type: "boolean" },
    },
    required: ["key"],
    additionalProperties: true,
  },
};

/**
 * Infer a minimal named-field outputSchema from a discovery.output.example
 * when a hand-written schema is missing. Prefer FLAGSHIP_OUTPUT_SCHEMAS.
 */
export function outputSchemaFromExample(example) {
  if (!example || typeof example !== "object" || Array.isArray(example)) {
    return {
      type: "object",
      properties: { result: { description: "Tool JSON result", additionalProperties: true } },
      additionalProperties: true,
    };
  }
  const properties = {};
  for (const [k, v] of Object.entries(example)) {
    if (v === null) properties[k] = { type: ["string", "number", "boolean", "object", "array", "null"] };
    else if (Array.isArray(v)) properties[k] = { type: "array", items: { type: typeof v[0] === "object" ? "object" : typeof v[0] || "string" } };
    else if (typeof v === "object") properties[k] = { type: "object", additionalProperties: true };
    else properties[k] = { type: typeof v };
  }
  return { type: "object", properties, additionalProperties: true };
}

/** Wrap a JSON object as MCP CallToolResult with structuredContent. */
export function mcpJsonResult(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
    structuredContent: obj && typeof obj === "object" && !Array.isArray(obj) ? obj : { result: obj },
  };
}

/**
 * Install one-liners agents can copy without leaving the connector.
 * Hosted URL is parameterized; npm / Claude Code / Cursor / Smithery notes
 * match docs/ecosystem-listings.md + wiki/MCP-Connector.md.
 */
export function mcpInstallHints(baseUrl) {
  const hosted = `${baseUrl}/mcp`;
  return {
    hostedUrl: hosted,
    claudeCodeHosted: `claude mcp add --transport http agent402 ${hosted}`,
    claudeCodeNpm: "claude mcp add agent402 -s user -- npx -y agent402-mcp@latest",
    cursorMcpJson: {
      mcpServers: {
        agent402: { url: hosted },
      },
    },
    cursorNpmMcpJson: {
      mcpServers: {
        agent402: {
          command: "npx",
          args: ["-y", "agent402-mcp"],
          env: { AGENT_KEY: "0xYOUR_PRIVATE_KEY" },
        },
      },
    },
    npm: "npx -y agent402-mcp",
    smithery: "Paste the hosted URL at https://smithery.ai/new (or: smithery mcp publish \"https://agent402.tools/mcp\" -n @MikeyPetrillo/agent402). Submission is external; Agent402 does not auto-publish.",
    maintainer: "Havok Holdings LLC",
  };
}

/**
 * MCP initialize.instructions — orientation for clients that never call
 * server.describe. Keep tool names listed-only (dotted Smithery form) (self-consistency) and lead
 * with search/answer as the front door.
 */
export function mcpInitializeInstructions(baseUrl) {
  const install = mcpInstallHints(baseUrl);
  const hosted = install.hostedUrl;
  return [
    "Agent402 is a tools and models layer for AI agents (Havok Holdings LLC) - the applied layer of Agentic Finance: deterministic utilities, a metered model gateway and finished reports, paid per request over x402 or MPP, or free via proof-of-work on the pure-CPU tools.",
    "Front door: call web.search or web.answer for live web search and cited answers.",
    "Also listed: web.news, browser.render, market.quote, audio.transcribe, memory.read, memory.write.",
    "Long catalog (500+ tools): call catalog.find with your task, or catalog.search then catalog.call.",
    "Orientation: call server.describe. Payment rails / wallet setup: call payment.info.",
    "Missing a tool: call demand.request. Ecosystem sellers: call sellers.list.",
    `Install (hosted, zero wallet): ${install.claudeCodeHosted}`,
    `Install (npm + wallet or prepaid card credits for paid flagships): ${install.claudeCodeNpm}`,
    `Cursor mcp.json: { "mcpServers": { "agent402": { "url": "${hosted}" } } }`,
    `Why pay here (usage priced under a quoted ceiling, a failed call is not charged and the receipt proves it, keyed retries never pay twice, one key for tools + models + reports, card credits with no wallet, proof at /status and /revenue): ${baseUrl}/why`,
    `Docs: ${baseUrl}/llms.txt · ${baseUrl}/api/find?q=… · status ${baseUrl}/status`,
  ].join("\n");
}
