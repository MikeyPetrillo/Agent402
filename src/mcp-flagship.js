// Flagship MCP surface — the small default tools/list agents see first.
//
// Product intent: Agent402 is a tools and models layer for agents -
// deterministic utilities, a metered model gateway, finished reports. Default MCP exposure is a tight
// flagship set; the long catalog stays callable via find_tool /
// search_tools / call_tool. Keep this list aligned with mcp/index.js
// DEFAULT_CURATED (stdio package cannot import this file when published).
//
// Every flagship reads a source whose terms are cleared for resale
// (src/resale-terms.js) or reads none: PDF to markdown, the US macro series,
// current weather, render, stock-quote, transcribe, memory-*. The web search,
// news and cited-answer tools stay catalog tools (catalog.call), their prior
// MCP names callable as aliases (FORMER_FLAGSHIP_MCP_NAMES), never listed.
// Exactly 8 catalog flagships so hosted tools/list stays ~15 with meta tools
// (Glama's well-scoped band is 3–15).

import { leadSentence, SUPPORT_LINE } from "./positioning.js";
import { stockQuoteEnabled } from "./tools/stock-provider.js";

/** The US macro series tool's catalog slug (the agencies' series by FRED ID). */
export const MACRO_SERIES_SLUG = "us-macro-series";

export const FLAGSHIP_SLUGS = [
  "pdf-to-markdown",
  MACRO_SERIES_SLUG,
  "weather-current",
  "render",
  "stock-quote",
  "transcribe",
  "memory-read",
  "memory-write",
  // Listed only where the decide service is configured (absent from the
  // catalog otherwise, and a flagship must be in the catalog to be listed).
  "decide",
  "decide-execute",
];

// Smithery Naming grades DOT notation (domain.action tree), not snake_case —
// stuck-at-98 lesson: "Tool names should form a navigable tree using
// dot-notation (e.g. admin.tools.list)". CallTool still accepts prior snake /
// digit names via MCP_CALL_ALIASES.
export const FLAGSHIP_MCP_NAMES = {
  "pdf-to-markdown": "pdf.markdown",
  // The key is MACRO_SERIES_SLUG, written out (the self-consistency check reads this table as text).
  "us-macro-series": "macro.series",
  "weather-current": "weather.current",
  render: "browser.render",
  "stock-quote": "market.quote",
  transcribe: "audio.transcribe",
  "memory-read": "memory.read",
  "memory-write": "memory.write",
  decide: "decide.plan",
  "decide-execute": "decide.execute",
};

/**
 * Former flagships: catalog tools once listed under these names. Never
 * listed now; a call by the name (or its plain or snake alias) still runs the
 * tool, priced and paid on its own HTTP route, as catalog.call does.
 */
export const FORMER_FLAGSHIP_MCP_NAMES = {
  search: "web.search",
  answer: "web.answer",
  "search-news": "web.news",
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
  // former flagships (snake → dotted), callable, not listed
  search_web: "web.search",
  answer_question: "web.answer",
  search_news: "web.news",
  // flagships (snake → dotted)
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

/** Every dotted name a call may use (flagships, former flagships, meta tools, the router). */
const LISTED_DOTTED = new Set([
  ...Object.values(FLAGSHIP_MCP_NAMES),
  ...Object.values(FORMER_FLAGSHIP_MCP_NAMES),
  ...Object.values(META_MCP_NAMES),
  ...Object.values(MCP_CALL_ALIASES),
  "decide.feedback",
]);

/** The /mcp query value (`?tool_names=underscore`) that lists plain names. */
export const PLAIN_TOOL_NAMES_VALUE = "underscore";

/**
 * A listed name in letters, digits, _ and - only, for a host that refuses a
 * dot in a tool name: the snake form when resolveListedName takes it back to
 * the same tool, else the name as listed.
 */
export function plainToolName(name) {
  if (typeof name !== "string" || !name.includes(".")) return name;
  const plain = name.replace(/\./g, "_");
  return resolveListedName(plain) === name ? plain : name;
}

/**
 * A pattern that finds each of `names` standing as its own token in text: not
 * inside a longer dotted word, a host name or a path (a "/mcp#web.search"
 * listing id). Each name is read as literal text (every metacharacter, the
 * backslash included, escaped); the longest name is tried first.
 */
export function dottedNamesPattern(names) {
  const literal = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![A-Za-z0-9_./#-])(${[...names].sort((a, b) => b.length - a.length).map(literal).join("|")})(?!\\.?[A-Za-z0-9_])`,
    "g",
  );
}

const DOTTED_IN_TEXT = dottedNamesPattern(LISTED_DOTTED);

/**
 * Text (or any JSON value's strings) with every listed dotted tool name it
 * names put in its plain spelling (plainToolName), for the answers a
 * plain-names listing (?tool_names=underscore) gives: a host that registered
 * catalog_call is never told to call catalog.call. Object keys are kept.
 */
export function plainToolText(value, depth = 0) {
  if (typeof value === "string") return value.includes(".") ? value.replace(DOTTED_IN_TEXT, (m) => plainToolName(m)) : value;
  if (depth > 32 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => plainToolText(v, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = plainToolText(v, depth + 1);
  return out;
}

/** The listed tools whose own answers are guidance (not a tool's data): their text is renamed in a plain listing. */
export const GUIDANCE_TOOL_NAMES = new Set([...Object.values(META_MCP_NAMES), "decide.feedback", "decide.plan"].filter((n) => n !== "catalog.call"));

const proseBlocks = (r) => ({ ...r, content: r.content.map((b) => (b?.type === "text" && typeof b.text === "string" && !/^\s*[{[]/.test(b.text) ? { ...b, text: plainToolText(b.text) } : b)) });
function plainCallResult(req, r) {
  if (!r || typeof r !== "object") return r;
  if (GUIDANCE_TOOL_NAMES.has(resolveListedName(req?.params?.name))) {
    const { _meta, ...rest } = r;
    return { ...plainToolText(rest), ...(_meta !== undefined ? { _meta } : {}) };
  }
  return r.isError && Array.isArray(r.content) ? proseBlocks(r) : r;
}

/**
 * A request handler for a plain-names listing (?tool_names=underscore): every
 * tool is named in its plain spelling everywhere it answers (the listing's
 * names, titles, descriptions and schemas, the prompts, a thrown error's
 * message, and the text of the tools whose answers are guidance). A tool's own
 * data (a catalog.call result, a flagship's answer) is returned as the tool
 * gave it, and a payment offer is never touched: _meta, an error's data and a
 * JSON text block of a refusal (the x402 PaymentRequired a client signs
 * against) stay as built.
 */
export function plainNamesHandler(method, handler) {
  return async (req, ctx) => {
    try {
      const r = await handler(req, ctx);
      return method === "tools/call" ? plainCallResult(req, r) : plainToolText(r);
    } catch (e) {
      if (e && typeof e.message === "string") e.message = plainToolText(e.message);
      throw e;
    }
  };
}

/**
 * Resolve any CallTool name to the canonical listed dotted name: a prior
 * public alias (MCP_CALL_ALIASES), or the snake form of a listed dotted name
 * (catalog_search, catalog_find, payment_info, web_search), which a client
 * that cannot send a dot in a tool name produces. Anything else is returned as
 * given, so a raw catalog slug still reaches the slug lookup.
 */
export function resolveListedName(name) {
  if (!name) return name;
  if (MCP_CALL_ALIASES[name]) return MCP_CALL_ALIASES[name];
  if (typeof name === "string" && name.includes("_") && !name.includes(".")) {
    const dotted = name.replace(/_/g, ".");
    if (LISTED_DOTTED.has(dotted)) return dotted;
  }
  return name;
}

/** Open-world / egress tools — honest annotations for directory clients. */
export const FLAGSHIP_OPEN_WORLD = new Set([
  "pdf-to-markdown", MACRO_SERIES_SLUG, "weather-current", "render", "stock-quote", "transcribe", "decide",
]);

/** Tools that mutate durable state (not read-only). */
export const FLAGSHIP_WRITERS = new Set(["memory-write", "decide-execute"]);

/** initialize.serverInfo description (MCP Implementation.description), with
 *  the wires this server offers: `mpp` is the MPP switch (mppMethodsSummary),
 *  `receipts` is receiptsServed() (the signed-receipt clause), `stock` is the
 *  stock switch (market.quote is listed only with a stock provider). The
 *  published default names no quote flagship. */
export function mcpServerDescription({ mpp = true, receipts = true, stock = false } = {}) {
  return `${leadSentence({ mpp, receipts })} ${SUPPORT_LINE} Flagships: PDF to markdown, US economic series, current weather, browser render, ${stock ? "market data, " : ""}speech-to-text and wallet-keyed memory; the rest via catalog.find. Settle in USDC via ${mpp ? "x402 or MPP (Machine Payments Protocol) on the same 402" : "x402"}, or free via proof-of-work. The applied layer of Agentic Finance. Maintained by Havok Holdings LLC.`;
}
/** The short description (100 characters at most) the MCP Registry entry
 *  (mcp/server.json) and the server card carry. */
export function mcpShortDescription({ mpp = true } = {}) {
  return `Payment and trust layer for agentic commerce (Agentic Finance): pay and verify over ${mpp ? "x402 and MPP" : "x402"}`;
}
/** The published description (both wires), identical to the stdio package's. */
export const MCP_SERVER_DESCRIPTION = mcpServerDescription();

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
      plan: { type: "object", additionalProperties: true, description: "Present when the task names several steps: each step ranked by this free search (no model), with an estimated total and the paid decide upgrade" },
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
      answerBound: { type: "object", description: "Present only when a free answer was cut to the connector's size ceiling: unit, maxBytes, returned, matched, complete, truncated, cuts (one entry per cut list, string or object: path, kind, returned, matched, complete, truncated), cutsListed (entries in cuts) and cutsTotal (every cut made)", additionalProperties: true },
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
      emptyWallet: { type: "object", description: "What to do with an empty wallet: state, whoActs, command, wait", additionalProperties: true },
      mppStartHere: { type: "object", description: "MPP start-here routes (slug, method, path, url, price, why)", additionalProperties: true },
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
      frontDoor: {
        type: "object",
        properties: {
          firstCall: { type: "string" },
          access: { type: "string" },
          use: { type: "string" },
          guide: { type: "string" },
        },
        additionalProperties: true,
      },
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

/** Flagship catalog-tool output schemas keyed by catalog slug. Every field is
 *  optional (no `required`), and none is typed against the x402
 *  PaymentRequired's own fields (x402Version, error, resource, accepts,
 *  extensions): a payment ask on the connector carries the PaymentRequired as
 *  structuredContent only where it validates against the listed schema
 *  (src/mcp-x402.js), and the reference SDK client holds every
 *  structuredContent, error results included, to that schema.
 *  scripts/test-mcp-x402-structured.js holds each one to it. */
export const FLAGSHIP_OUTPUT_SCHEMAS = {
  "pdf-to-markdown": {
    type: "object",
    properties: {
      url: { type: "string" },
      pages: { type: "integer" },
      title: { type: ["string", "null"] },
      wordCount: { type: "integer" },
      markdown: { type: "string" },
    },
    additionalProperties: true,
  },
  "us-macro-series": {
    type: "object",
    properties: {
      seriesId: { type: "string" },
      units: { type: "string" },
      count: { type: "integer" },
      observations: {
        type: "array",
        items: {
          type: "object",
          properties: { date: { type: "string" }, value: { type: ["number", "null"] } },
          additionalProperties: true,
        },
      },
      source: { type: "string" },
      sourceSeries: { type: ["string", "null"] },
      title: { type: ["string", "null"] },
      retrievedAt: { type: ["string", "null"] },
      credit: { description: "The publisher's credit line" },
      terms: { description: "The publisher's terms for the data" },
    },
    additionalProperties: true,
  },
  "weather-current": {
    type: "object",
    properties: {
      lat: { type: "number" },
      lon: { type: "number" },
      place: { type: "object", additionalProperties: true, description: "Present when the location was given by name" },
      current: {
        type: "object",
        properties: {
          time: { type: ["string", "null"] },
          temperature: { type: ["number", "null"] },
          feelsLike: { type: ["number", "null"] },
          unit: { type: "string" },
          humidity: { type: ["number", "null"] },
          precipitation: { type: ["number", "null"] },
          condition: { type: ["string", "null"] },
          windSpeed: { type: ["number", "null"] },
          windUnit: { type: "string" },
        },
        additionalProperties: true,
      },
      source: { type: "string" },
    },
    additionalProperties: true,
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
  },
  "stock-quote": {
    type: "object",
    properties: {
      symbol: { type: "string" },
      currency: { type: "string" },
      price: { type: "number" },
      previousClose: { type: "number" },
      changeAbs: { type: "number" },
      changePct: { type: "number" },
      dayHigh: { type: "number" },
      dayLow: { type: "number" },
      // The consolidated market total; null when the answer came from the
      // three-venue fallback dataset (coverage says which).
      volume: { type: ["number", "null"] },
      // Volume across the venues in `venues`: the whole market on the
      // consolidated dataset, three venues on the fallback.
      venueVolume: { type: "number" },
      asOf: { type: "string" },
      dataset: { type: "string" },
      coverage: { type: "string", enum: ["consolidated", "three-venue"] },
      venues: { type: "string" },
      source: { type: "string" },
      note: { type: "string" },
    },
  },
  transcribe: {
    type: "object",
    properties: {
      model: { type: "string" },
      provider: { type: "string" },
      text: { type: "string" },
      language: { type: "string" },
      duration: { type: "number" },
      trimmedToCapSeconds: { type: "number", description: "Present only when the file's length could not be confirmed: the audio was transcribed up to this many seconds (the tier's cap)" },
      durationUnconfirmed: { type: "boolean", description: "Present (true) only with trimmedToCapSeconds: the file's full length was not confirmed" },
    },
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
      expiresAt: { type: ["number", "null"], description: "Expiry in unix seconds; null when the key does not expire" },
      owner: { type: "string" },
      persistent: { type: "boolean" },
      deleted: { type: "boolean" },
    },
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
  // Every type written here is a JSON Schema type name: a client compiles
  // the listed outputSchema (the reference SDK does, at tools/list), and one
  // name outside the set ("undefined" from an empty example array, "bigint")
  // makes it refuse the whole listing, not one tool.
  const jsonType = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const JSON_TYPES = new Set(["string", "number", "boolean", "object", "array", "null"]);
  const properties = {};
  for (const [k, v] of Object.entries(example)) {
    if (v === null) properties[k] = { type: ["string", "number", "boolean", "object", "array", "null"] };
    else if (Array.isArray(v)) {
      const itemType = v.length ? jsonType(v[0]) : null;
      properties[k] = { type: "array", ...(itemType && JSON_TYPES.has(itemType) ? { items: { type: itemType } } : {}) };
    }
    else if (typeof v === "object") properties[k] = { type: "object", additionalProperties: true };
    else if (JSON_TYPES.has(typeof v)) properties[k] = { type: typeof v };
    else properties[k] = { description: "Tool JSON value" };
  }
  return { type: "object", properties, additionalProperties: true };
}

/** Wrap a JSON object as MCP CallToolResult with structuredContent. */
export function mcpJsonResult(obj, text = JSON.stringify(obj, null, 2)) {
  return {
    content: [{ type: "text", text }],
    structuredContent: obj && typeof obj === "object" && !Array.isArray(obj) ? obj : { result: obj },
  };
}

/**
 * Install one-liners agents can copy without leaving the connector.
 * Hosted URL is parameterized; npm / Claude Code / Cursor notes
 * match docs/ecosystem-listings.md + wiki/MCP-Connector.md.
 */
export const AGENT402_MCP_VERSION = "0.17.1";

/** A listed MCP tool description, at most `max` characters. Hosts truncate or
 *  skip long descriptions, so the listing keeps the first whole sentences; the
 *  full catalog text stays on catalog.find and the tool's page. */
export const TOOL_DESCRIPTION_MAX = 400;
export function clipToolDescription(text, max = TOOL_DESCRIPTION_MAX) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const cut = head.lastIndexOf(". ");
  if (cut > max * 0.5) return head.slice(0, cut + 1);
  const sp = head.lastIndexOf(" ", max - 1);
  return head.slice(0, sp > 0 ? sp : max - 1).replace(/[,;:\-\s]+$/, "") + ".";
}

export function mcpInstallHints(baseUrl) {
  const hosted = `${baseUrl}/mcp`;
  return {
    hostedUrl: hosted,
    claudeCodeHosted: `claude mcp add --transport http -s user agent402 ${hosted}`,
    walletWarning: "Use a new wallet holding only a few dollars of USDC. Never your main wallet.",
    claudeCodeNpm: `claude mcp add agent402 -s user -- npx -y agent402-mcp@${AGENT402_MCP_VERSION}`,
    cursorMcpJson: {
      mcpServers: {
        agent402: { url: hosted },
      },
    },
    cursorNpmMcpJson: {
      mcpServers: {
        agent402: {
          command: "npx",
          args: ["-y", "agent402-mcp@0.17.1"],
          env: { AGENT_KEY: "0xYOUR_PRIVATE_KEY" },
        },
      },
    },
    npm: "npx -y agent402-mcp@0.17.1",
    maintainer: "Havok Holdings LLC",
  };
}

// The terms every call through a connector is made under, one line, in the
// initialize instructions of every mount (the hosted connector and each
// product profile; src/mcp-http.js adds it to a profile's own text).
export function mcpTermsLine(baseUrl) {
  return `Terms: use of this server is subject to the Terms of Service at ${baseUrl}/terms.`;
}

/**
 * MCP initialize.instructions — orientation for clients that never call
 * server.describe. Keep tool names listed-only (dotted Smithery form) (self-consistency).
 */
// `mpp`: a paid call can be settled over MPP on this connector (the loopback);
// `mppOffered`: the MPP switch, which sets the wires the lead sentence names.
export function mcpInitializeInstructions(baseUrl, { decide = false, mpp = false, x402 = false, mppOffered = true, receipts = true, demand = true, stock = stockQuoteEnabled() } = {}) {
  const install = mcpInstallHints(baseUrl);
  const hosted = install.hostedUrl;
  return [
    `${leadSentence({ mpp: mppOffered, receipts })} ${SUPPORT_LINE} Per-call tools and metered models, paid in USDC, or free through proof-of-work for the pure-CPU tools; the applied layer of Agentic Finance.`,
    // market.quote only while a stock provider is active (it is listed then).
    `Flagship tools: pdf.markdown (PDF to markdown), macro.series (US economic series), weather.current (current weather anywhere), browser.render, ${stock ? "market.quote, " : ""}audio.transcribe, memory.read, memory.write.`,
    "Long tail: catalog.search lists tools by keyword, catalog.find returns the best match with its input schema and price, catalog.call runs a tool by slug.",
    // Only where the decide tools are listed: an instruction must never name a
    // tool the connector does not advertise.
    ...(decide ? ["Multi-step jobs: decide.plan returns a call-ready plan (tools, order, fallbacks, inputs); decide.execute runs it. The plan fee is credited toward the run."] : []),
    // demand.request is named only where it is listed (the hosted connector).
    `Also: server.describe (connector details), payment.info (wallet and payment setup)${demand ? ", demand.request (report a missing tool)" : ""}.`,
    `Install (npm package, pinned): ${install.claudeCodeNpm}`,
    `Hosted connector (proof-of-work tools free; ${x402 || mpp ? `other tools paid in the call over ${[x402 && "x402", mpp && "MPP"].filter(Boolean).join(" or ")} from a wallet` : "others need a wallet on the npm package"}): ${install.claudeCodeHosted}`,
    `Cursor mcp.json: { "mcpServers": { "agent402": { "url": "${hosted}" } } }`,
    `Docs: ${baseUrl}/llms.txt · status ${baseUrl}/status`,
    mcpTermsLine(baseUrl),
  ].join("\n");
}

// Tool input element bound. The SDK's maxToolInputElements option lives on
// McpServer and is checked inside McpServer's own tools/call handler; both
// connectors use the low-level Server with their own CallTool handler, where
// that option is never read. So the same check runs here, with the SDK's
// counting rule (every array element and every own object member, at any
// depth) and its InvalidParams message.
//
// The bound: a JSON element costs at least two bytes ("0,"), so the hosted
// connector's 100kb body parser admits at most 51,200 of them. A bound at that
// figure never refuses a body the parser accepts, and the largest
// handler-capped input (three 10,000-value series) sits well under it. On the
// stdio package, which reads lines with no byte cap, an argument tree past it
// is refused before it is serialized and sent to a server that would 413 it.
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 51_200;

// Counts array elements and object members in `value`, stopping once the
// count passes `max` (so a huge tree costs at most max + 1 steps).
export function toolInputElementCount(value, max = MCP_MAX_TOOL_INPUT_ELEMENTS) {
  let count = 0;
  const stack = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const child of node) {
        if (++count > max) return count;
        if (child !== null && typeof child === "object") stack.push(child);
      }
    } else {
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        if (++count > max) return count;
        const child = node[key];
        if (child !== null && typeof child === "object") stack.push(child);
      }
    }
  }
  return count;
}

// The refusal text for an over-bound call, or null when the input is within
// the bound. Same wording as the SDK's McpServer refusal.
export function toolInputBoundRefusal(toolName, args, max = MCP_MAX_TOOL_INPUT_ELEMENTS) {
  if (toolInputElementCount(args, max) <= max) return null;
  return `Invalid arguments for tool ${toolName}: arguments contain more than the maximum of ${max} elements`;
}
