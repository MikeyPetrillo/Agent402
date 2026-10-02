// /integrations/<slug> - one page per published package: the framework
// adapters in adapters/, plus the MCP server (mcp/), the buyer SDK (client/),
// the tollbooth (tollbooth/) and the OpenClaw provider (openclaw/).
//
// Every install line and code sample below is taken from that package's own
// README and matches the exports in its index.js; if a package's API moves,
// update the entry here in the same change. Tool links are resolved against
// the live catalog at render time, so a retired slug drops off the page
// instead of linking to a 404.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { repoUrl } from "./repo-link.js";

const X402_FETCH = `import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const payClient = new x402Client();
registerExactEvmScheme(payClient, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, payClient);`;

// Shared descriptions of the two adapter shapes, so every page in a family
// says the same true thing.
const PER_SLUG_EXPOSES = [
  "One native tool per catalog slug you pass in `slugs` (a short list gives the model better tool selection).",
  "With no `slugs`, the free-tier catalog: every compute-payable tool (`freeOnly: true` is the default).",
  "An `execute(name, args)` function that runs a tool call and pays for it underneath.",
  "`baseUrl` points the adapter at a self-hosted Agent402 instance.",
];
const PER_SLUG_PAYMENT = [
  "Free tier: compute-payable tools settle with a sha256 proof-of-work solved in-process. No wallet, no API key.",
  "Wallet-only tools (browser, network, memory, live data): set `freeOnly: false` and pass a payment-wrapped `fetch`. An `@x402/fetch` fetch pays in USDC over x402; a stock `mppx` fetch pays over MPP. The same 402 carries both offers.",
  "Prices come from the live catalog at /api/pricing and are quoted in every 402 before anything is signed.",
];
const META_EXPOSES = [
  "`agent402_find`: a plain-language task in, the best-matching tools out (slug, route, price, input schema, a ready example).",
  "`agent402_route`: ranks tools across every indexed x402 seller; `include: \"external\"` leaves this server out.",
  "`agent402_call`: calls a tool by slug and pays for it.",
  "`agent402_about`: the service manifest (payment options, capability map, MCP connector).",
  "`agent402ToolSpecs()` returns the same four as framework-agnostic specs (name, description, JSON Schema, execute) with no framework dependency.",
];
const META_PAYMENT = [
  "Pure-CPU tools: `agent402_call` fetches a proof-of-work challenge and solves it in-process, so no wallet is needed.",
  "Wallet-only tools: pass `fetch`, a payment-wrapped fetch. `@x402/fetch` pays in USDC over x402 on whichever chain your wallet is funded for; a stock `mppx` fetch pays over MPP.",
  "Unpaid lookups (find, route, about) use `fetchImpl` and never spend anything.",
];

export const INTEGRATIONS = [
  {
    slug: "openai",
    meta: "Agent402 tools as OpenAI function-calling definitions for chat.completions, Assistants and Responses. Free tier by proof-of-work; paid tools over x402 or MPP.",
    name: "OpenAI function calling",
    short: "OpenAI",
    pkg: "agent402-openai-tools",
    dir: "adapters/openai-tools",
    docsSlug: "openai",
    what: "Turns Agent402 tools into OpenAI function-calling definitions. The returned `tools` array is the same JSON used by chat.completions, Assistants v2 and the Responses API, and `execute` runs whatever tool call the model returns.",
    install: "npm install openai agent402-openai-tools",
    example: `import OpenAI from "openai";
import { agent402Tools } from "agent402-openai-tools";

const openai = new OpenAI();
// free tier: every tool listed here is compute-payable (proof-of-work, no wallet)
const { tools, execute } = await agent402Tools({ slugs: ["hash", "markdown-to-html", "text-stats", "uuid"] });

const res = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "What is the SHA-256 of 'hello world'?" }],
  tools,
});

const call = res.choices[0].message.tool_calls?.[0];
if (call) {
  const result = await execute(call.function.name, JSON.parse(call.function.arguments));
  console.log(result);
}`,
    walletExample: `${X402_FETCH}

// wallet-only tools (extract, render, screenshot, ...) need freeOnly: false and a paying fetch
const { tools, execute } = await agent402Tools({
  slugs: ["extract", "render", "hash"],
  freeOnly: false,
  fetch: payFetch,
});`,
    exposes: PER_SLUG_EXPOSES,
    payment: PER_SLUG_PAYMENT,
    tools: ["extract", "hash", "render", "screenshot", "search", "answer"],
    guides: ["x402-in-5-minutes", "agent-hosts"],
  },
  {
    slug: "anthropic",
    meta: "Agent402 tools as Anthropic Messages API tool definitions with an execute helper. Free tier by proof-of-work; paid tools over x402 or MPP.",
    name: "Anthropic tool use",
    short: "Anthropic",
    pkg: "agent402-anthropic-tools",
    dir: "adapters/anthropic-tools",
    docsSlug: "anthropic",
    what: "Turns Agent402 tools into Anthropic Messages API tool definitions (`input_schema` format) for server-side agents and custom tool loops. For Claude clients that speak MCP, the hosted connector at /mcp is the shorter path; this package is for direct Messages API integrations.",
    install: "npm install @anthropic-ai/sdk agent402-anthropic-tools",
    example: `import Anthropic from "@anthropic-ai/sdk";
import { agent402Tools } from "agent402-anthropic-tools";

const client = new Anthropic();
// free tier: every tool listed here is compute-payable (proof-of-work, no wallet)
const { tools, execute } = await agent402Tools({ slugs: ["hash", "markdown-to-html", "text-stats", "uuid"] });

const res = await client.messages.create({
  model: "claude-opus-5-5",
  max_tokens: 1024,
  tools,
  messages: [{ role: "user", content: "What is the SHA-256 of 'hello world'?" }],
});

const block = res.content.find((b) => b.type === "tool_use");
if (block) {
  const result = await execute(block.name, block.input);
  console.log(result);
}`,
    walletExample: `${X402_FETCH}

// wallet-only tools (extract, render, screenshot, ...) need freeOnly: false and a paying fetch
const { tools, execute } = await agent402Tools({
  slugs: ["extract", "render", "hash"],
  freeOnly: false,
  fetch: payFetch,
});`,
    exposes: PER_SLUG_EXPOSES,
    payment: PER_SLUG_PAYMENT,
    tools: ["extract", "hash", "render", "screenshot", "whois", "search"],
    guides: ["agent-hosts", "x402-in-5-minutes"],
  },
  {
    slug: "ai-sdk",
    meta: "Four meta tools that give a Vercel AI SDK agent the whole Agent402 catalog: find, route, call, about. Proof-of-work free tier; paid tools over x402 or MPP.",
    name: "Vercel AI SDK",
    short: "Vercel AI SDK",
    pkg: "agent402-ai-sdk",
    dir: "adapters/ai-sdk",
    docsSlug: "ai-sdk",
    what: "Gives a Vercel AI SDK agent four meta tools that reach the whole catalog: the model describes a task, `agent402_find` or `agent402_route` picks the tool, and `agent402_call` runs and pays for it. Works with `generateText` and `streamText` on any provider the SDK supports.",
    install: "npm install agent402-ai-sdk ai @ai-sdk/openai zod",
    example: `import { agent402Tools } from "agent402-ai-sdk";
import { generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";

const tools = await agent402Tools();   // an object keyed by tool name; free tier: proof-of-work, no wallet

const { text } = await generateText({
  model: openai("gpt-4o"),
  tools,
  stopWhen: stepCountIs(3),   // let the model read the tool result and answer
  prompt: "Hash 'hello world' with sha256",
});`,
    walletExample: `${X402_FETCH}

// agent402_call pays wallet-only tools through this fetch
const tools = await agent402Tools({ fetch: payFetch });`,
    exposes: META_EXPOSES,
    payment: META_PAYMENT,
    tools: ["hash", "search", "extract", "render", "route-execute"],
    guides: ["smart-order-router", "x402-in-5-minutes"],
  },
  {
    slug: "langchain",
    meta: "LangChain.js and LangGraph tools for Agent402: four meta tools that reach the whole catalog, with proof-of-work for free tools and x402 or MPP for paid ones.",
    name: "LangChain.js and LangGraph",
    short: "LangChain.js",
    pkg: "agent402-langchain",
    dir: "adapters/langchain",
    docsSlug: "langchain",
    what: "LangChain.js tool objects for Agent402, ready for any LangChain or LangGraph agent. Four meta tools cover the whole catalog, so the agent's tool budget stays small however many endpoints the catalog holds.",
    install: "npm install agent402-langchain @langchain/core @langchain/langgraph @langchain/openai zod",
    example: `import { agent402Tools } from "agent402-langchain";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const tools = await agent402Tools();   // an array of four tools; free tier: proof-of-work, no wallet
const agent = createReactAgent({ llm: new ChatOpenAI({ model: "gpt-4o-mini" }), tools });

const result = await agent.invoke({
  messages: [{ role: "user", content: "Hash 'hello world' with sha256" }],
});`,
    walletExample: `${X402_FETCH}

// agent402_call pays wallet-only tools through this fetch
const tools = await agent402Tools({ fetch: payFetch });`,
    exposes: META_EXPOSES,
    payment: META_PAYMENT,
    tools: ["search", "answer", "extract", "hash", "route-execute"],
    guides: ["smart-order-router", "agent-hosts"],
  },
  {
    slug: "langchain-python",
    meta: "Agent402 for Python LangChain and CrewAI agents: a toolkit with four meta tools, free pure-CPU tools by proof-of-work, paid tools through a signed fetch.",
    name: "LangChain and CrewAI (Python)",
    short: "LangChain (Python)",
    pkg: "agent402-langchain",
    registry: "pypi",
    dir: "adapters/langchain-py",
    what: "The Python adapter: an `Agent402Toolkit` that hands LangChain and CrewAI agents the same four meta tools the JavaScript adapters expose. Pure-CPU tools are free through the built-in proof-of-work; live-data tools settle in USDC through a signing callable you pass in.",
    install: `pip install "agent402-langchain[langchain]"`,
    lang: "python",
    example: `from agent402_langchain import Agent402Toolkit

toolkit = Agent402Toolkit(base_url="https://agent402.tools")
tools = toolkit.get_tools()   # four meta-tools your agent can call`,
    walletExample: `# x402_fetch: a callable with the requests-style signature
# (method, url, **kwargs) -> requests.Response that signs the USDC payment
toolkit = Agent402Toolkit(base_url="https://agent402.tools", x402_fetch=my_signed_fetch)`,
    exposes: [
      "`agent402_find`: resolve a plain-language task to the best tool (slug, price, schema, example).",
      "`agent402_route`: the cross-seller x402 router across the indexed ecosystem.",
      "`agent402_call`: call a tool by slug and pay for it.",
      "`agent402_about`: the service manifest.",
      "`agent402_tool_specs()` returns the four as plain dicts (name, description, JSON Schema, execute) with no langchain-core dependency.",
    ],
    payment: [
      "Pure-CPU tools (hashing, encoding, QR, markdown, JSON) settle with proof-of-work: no wallet, no API key.",
      "Wallet-only tools need `x402_fetch`; without it, calling one raises an error naming what is missing, and the free tier keeps working.",
    ],
    tools: ["hash", "search", "stock-quote", "extract", "uuid"],
    guides: ["x402-in-5-minutes", "smart-order-router"],
  },
  {
    slug: "llamaindex",
    meta: "Agent402 tools as LlamaIndex TS FunctionTools built from the catalog's JSON Schema. Free tier by proof-of-work; paid tools over x402 or MPP.",
    name: "LlamaIndex TS",
    short: "LlamaIndex",
    pkg: "agent402-llamaindex",
    dir: "adapters/llamaindex",
    docsSlug: "llamaindex",
    what: "Returns a `FunctionTool[]` array for any LlamaIndex TS agent or workflow, built from the catalog's raw JSON Schema, so there is no Zod or hand-written schema to maintain.",
    install: "npm install llamaindex @llamaindex/workflow @llamaindex/openai agent402-llamaindex",
    example: `import { agent } from "@llamaindex/workflow";
import { openai } from "@llamaindex/openai";
import { agent402Tools } from "agent402-llamaindex";

// free tier: every tool listed here is compute-payable (proof-of-work, no wallet)
const { tools } = await agent402Tools({ slugs: ["hash", "markdown-to-html", "text-stats", "uuid"] });

const myAgent = agent({ tools, llm: openai({ model: "gpt-4o-mini" }) });
const res = await myAgent.run("What is the SHA-256 of 'hello world'?");
console.log(res.data.result);`,
    walletExample: `${X402_FETCH}

// wallet-only tools (extract, render, screenshot, ...) need freeOnly: false and a paying fetch
const { tools } = await agent402Tools({
  slugs: ["extract", "render", "hash"],
  freeOnly: false,
  fetch: payFetch,
});`,
    exposes: PER_SLUG_EXPOSES,
    payment: PER_SLUG_PAYMENT,
    tools: ["extract", "hash", "render", "screenshot", "markdown-to-html"],
    guides: ["x402-in-5-minutes", "durable-memory-for-agents"],
  },
  {
    slug: "google-adk",
    meta: "Agent402 tools for Gemini agents on Google's Agent Development Kit: find, route, call and about, with proof-of-work or x402 and MPP payment underneath.",
    name: "Google Agent Development Kit",
    short: "Google ADK",
    pkg: "agent402-google-adk",
    dir: "adapters/google-adk",
    docsSlug: "google-adk",
    what: "ADK `FunctionTool` instances for Gemini agents built on the Agent Development Kit. Both peers are optional: without `@google/adk` and `zod`, `agent402ToolSpecs()` gives the same four tools with no dependencies.",
    install: "npm install agent402-google-adk @google/adk zod",
    example: `import { agent402Tools } from "agent402-google-adk";
import { LlmAgent } from "@google/adk";

const tools = await agent402Tools();   // free tier: proof-of-work, no wallet

const agent = new LlmAgent({
  name: "x402-agent",
  model: "gemini-3.6-flash",
  tools,
  instruction: "Use agent402_find to discover the right tool, then agent402_call to invoke it.",
});`,
    walletExample: `${X402_FETCH}

// agent402_call pays wallet-only tools through this fetch
const tools = await agent402Tools({ fetch: payFetch });`,
    exposes: META_EXPOSES,
    payment: META_PAYMENT,
    tools: ["search", "answer", "hash", "crypto-market-pulse", "route-execute"],
    guides: ["x402-in-5-minutes", "why-twelve-chains"],
  },
  {
    slug: "openai-agents",
    meta: "Agent402 tools for the OpenAI Agents SDK: four meta tools that reach the whole catalog, paid by proof-of-work or over x402 or MPP.",
    name: "OpenAI Agents SDK",
    short: "OpenAI Agents SDK",
    pkg: "agent402-openai-agents",
    dir: "adapters/openai-agents",
    docsSlug: "openai-agents",
    what: "Tools for agents built with the OpenAI Agents SDK (`@openai/agents`). Pass them to `new Agent({ tools })` and the agent can find, route to and call any tool in the catalog.",
    install: "npm install agent402-openai-agents @openai/agents zod",
    example: `import { agent402ToolSpecs } from "agent402-openai-agents";
import { Agent, run, tool } from "@openai/agents";

// The four specs as Agents SDK tools. strict: false because agent402_call's
// "params" is optional and the SDK's strict schema mode requires every field.
const toTools = (specs) => specs.map((s) => tool({
  name: s.name,
  description: s.description,
  parameters: s.parametersJsonSchema,
  strict: false,
  execute: s.execute,
}));
const tools = toTools(agent402ToolSpecs());   // free tier: proof-of-work, no wallet

const agent = new Agent({
  name: "x402-agent",
  instructions: "Use agent402 to find and call paid web tools when needed.",
  tools,
});
const result = await run(agent, "Hash 'hello world' with sha256");`,
    walletExample: `${X402_FETCH}

// agent402_call pays wallet-only tools through this fetch
const tools = toTools(agent402ToolSpecs({ fetch: payFetch }));`,
    exposes: META_EXPOSES,
    payment: META_PAYMENT,
    tools: ["hash", "search", "answer", "extract", "route-execute"],
    guides: ["agent-hosts", "smart-order-router"],
  },
  {
    slug: "strands",
    meta: "Agent402 tools as Strands Agents tool instances, including on AWS Bedrock AgentCore. Free tier by proof-of-work; paid tools over x402.",
    name: "Strands Agents",
    short: "Strands",
    pkg: "agent402-strands",
    dir: "adapters/strands",
    docsSlug: "strands",
    what: "Strands `tool({...})` instances for TypeScript agents, including Strands agents running on AWS Bedrock AgentCore. Pull a curated subset of the catalog into the agent; when it calls a tool, the adapter solves a proof-of-work or signs an x402 payment and returns the structured result.",
    install: "npm install agent402-strands @strands-agents/sdk zod",
    lang: "ts",
    example: `import { Agent } from "@strands-agents/sdk";
import { agent402Tools } from "agent402-strands";

// free tier: every tool listed here is compute-payable (proof-of-work, no wallet)
const { tools } = await agent402Tools({
  slugs: ["hash", "markdown-to-html", "text-stats", "uuid"],
});

const agent = new Agent({ tools });
const out = await agent.invoke("What is the SHA-256 of 'hello world'?");`,
    walletExample: `${X402_FETCH}

// wallet-only tools (extract, render, screenshot, ...) need freeOnly: false and a paying fetch
const { tools } = await agent402Tools({
  slugs: ["extract", "render", "hash"],
  freeOnly: false,
  fetch: payFetch,
});`,
    exposes: [
      ...PER_SLUG_EXPOSES,
      "A `client` field with the underlying buyer SDK (`find()`, `call()`, `clearCache()`), and `agent402Execute()` for a standalone executor.",
    ],
    payment: PER_SLUG_PAYMENT,
    tools: ["extract", "hash", "render", "screenshot", "search"],
    guides: ["agent-hosts", "x402-payments-toolkit"],
  },
  {
    slug: "agentkit",
    meta: "An AgentKit action provider: agents with CDP, Privy, ZeroDev or viem wallets find and call Agent402 tools, paying over x402 in USDC on Base.",
    name: "Coinbase AgentKit",
    short: "AgentKit",
    pkg: "agent402-agentkit",
    dir: "adapters/agentkit",
    what: "An AgentKit action provider. An agent with a CDP, Privy, ZeroDev or viem-backed wallet gets three actions and pays for wallet-only tools over x402 in USDC on Base, signed by its own wallet provider. The signer is derived the same way AgentKit's own x402 provider derives it (`toSigner()` plus `readContract`).",
    install: "npm install agent402-agentkit @coinbase/agentkit @x402/fetch @x402/evm zod",
    lang: "ts",
    example: `import { AgentKit, CdpEvmWalletProvider } from "@coinbase/agentkit";
import { agent402ActionProvider } from "agent402-agentkit";

const walletProvider = await CdpEvmWalletProvider.configureWithWallet({
  apiKeyId: process.env.CDP_API_KEY_ID,
  apiKeySecret: process.env.CDP_API_KEY_SECRET,
  walletSecret: process.env.CDP_WALLET_SECRET,
  networkId: "base-mainnet",
});

const agentKit = await AgentKit.from({
  walletProvider,
  actionProviders: [await agent402ActionProvider()],
});
// hand agentKit.getActions() to your framework`,
    walletExample: `// spend bounds, checked before any signature
await agent402ActionProvider({
  maxPerCallUsd: 1,          // refuse a paid call above this
  dailyLimitUsd: 5,          // rolling 24-hour ceiling
  payees: ["0x..."],         // refuse a 402 that names any other payTo
});`,
    exposes: [
      "`agent402_find` (free): a task in, the best-matching tools out, with price and whether a wallet is needed.",
      "`agent402_call`: calls a tool by slug; free-tier tools pay with proof-of-work, wallet-only tools pay over x402 from the wallet provider.",
      "`agent402_about` (free): what the service is, how it is paid, live tool counts.",
      "`agent402Actions()` returns the raw action list for hosts that wrap actions themselves.",
    ],
    payment: [
      "x402 in USDC on Base, signed by the AgentKit wallet provider. The key never leaves the provider.",
      "`maxPerCallUsd` (default 1), `dailyLimitUsd` and `maxPerHostUsd` are measured against one client per wallet provider, so the daily ceiling holds across calls.",
      "`creditsKey` (a prepaid `a402_...` key) pays wallet-only tools without a wallet.",
    ],
    tools: ["crypto-price", "search", "answer", "hash", "route-execute"],
    guides: ["pay-with-coinbase-agentic-wallet", "create-agent-wallet"],
  },
  {
    slug: "eliza",
    meta: "An elizaOS plugin to find and call Agent402 tools, paid by prepaid credits or USDC over x402, inside per-call and daily spend ceilings.",
    name: "elizaOS plugin",
    short: "elizaOS",
    pkg: "elizaos-plugin-agent402",
    dir: "adapters/eliza",
    what: "An elizaOS plugin with three actions and a provider, installed from npm into the agent project and named in the character's \`plugins\` list. The agent can find a tool from a plain-language task and call it, paying with a prepaid credits key or in USDC over x402, inside per-call and daily ceilings you set in the character config.",
    install: "npm install elizaos-plugin-agent402",
    lang: "json",
    example: `{
  "plugins": ["elizaos-plugin-agent402"],
  "settings": {
    "AGENT402_CREDITS_KEY": "a402_...",
    "AGENT402_MAX_PER_CALL_USD": "1"
  }
}`,
    walletExample: `# pay from a wallet instead of a credits key
bun add @x402/fetch @x402/evm viem
# then set AGENT402_WALLET_KEY (an EVM key holding USDC on Base) in settings`,
    exposes: [
      "`AGENT402_FIND` (free): a task in, matching tools out with price and a ready example input.",
      "`AGENT402_CALL`: runs one tool and returns its complete JSON result in the action text the model reads next.",
      "`AGENT402_ABOUT` (free): what the service is and how it is paid.",
      "An `AGENT402` provider that tells the agent each turn which payment mode is configured. Keys never appear in results or provider text.",
    ],
    payment: [
      "`AGENT402_CREDITS_KEY`: a prepaid card-credits key; wallet-only tools are debited only on a successful call.",
      "`AGENT402_WALLET_KEY`: an EVM key paying USDC over x402 (optional peers `@x402/fetch @x402/evm viem`).",
      "Neither set: the proof-of-work free tier still works.",
      "`AGENT402_MAX_PER_CALL_USD` (default 1) and `AGENT402_DAILY_LIMIT_USD` are enforced per runtime before any request is sent; every paid call carries an `Idempotency-Key`.",
    ],
    tools: ["search", "render", "stock-quote", "dns-lookup", "tls-cert"],
    guides: ["agent-hosts", "x402-and-mpp"],
  },
  {
    slug: "mcp",
    meta: "agent402-mcp: an MCP server for Claude, Cursor and any MCP client, paying for tools with a wallet, a prepaid credits key or proof-of-work.",
    name: "MCP server",
    short: "MCP",
    pkg: "agent402-mcp",
    dir: "mcp",
    what: "An MCP server for any MCP client (Claude Desktop, Claude Code, Cursor and others). Flagship tools are listed as first-class MCP tools and the rest of the catalog is reachable through `catalog.search`, `catalog.find` and `catalog.call`, with skill packs surfaced as MCP prompts. The hosted connector at /mcp needs no install at all.",
    install: "npx -y agent402-mcp",
    lang: "json",
    example: `{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp"],
      "env": { "AGENT402_CREDITS_KEY": "a402_YOUR_KEY" }
    }
  }
}`,
    walletExample: `# Claude Code, hosted connector (no install)
claude mcp add --transport http agent402 https://agent402.tools/mcp

# Claude Code, local server paying from a wallet
claude mcp add agent402 -e AGENT_KEY=0x... -- npx -y agent402-mcp`,
    exposes: [
      "Flagship tools under dotted names: `web.search`, `web.answer`, `web.news`, `browser.render`, `market.quote`, `audio.transcribe`, `memory.read`, `memory.write`.",
      "`catalog.search` / `catalog.find` + `catalog.call` for the rest of the catalog, keeping the context window small.",
      "`payment.info`, `server.describe` and `sellers.list` for orientation, spend caps and the live seller leaderboards.",
      "Skill packs as MCP prompts (`prompts/list`, `prompts/get`).",
    ],
    payment: [
      "`AGENT_KEY` (EVM) or `SOLANA_AGENT_KEY`: the server signs an x402 payment on a chain the tool accepts and retries.",
      "`AGENT402_CREDITS_KEY`: sends `Authorization: Bearer a402_...`; the list price is debited only on a 200.",
      "Neither: the pure-CPU tools pay with proof-of-work (about 0.2 s of CPU).",
      "`AGENT402_MAX_PER_CALL` and `AGENT402_BUDGET` are enforced before a payment is signed. The hosted /mcp connector is also payable over MPP from an mppx-wrapped MCP client.",
    ],
    tools: ["search", "answer", "search-news", "render", "stock-quote", "transcribe"],
    guides: ["agent-hosts", "x402-and-mpp"],
    learn: ["mcp-payments", "mpp"],
  },
  {
    slug: "client",
    meta: "agent402-client: find a tool for a task and call it with payment handled, by proof-of-work, x402, MPP or prepaid credits, with spend caps.",
    name: "Buyer SDK",
    short: "agent402-client",
    pkg: "agent402-client",
    dir: "client",
    what: "A small buyer-side client: resolve a task to a tool with `find()`, then `call()` it with payment handled. Results are cached, spend is capped before anything is sent, and every send carries an `Idempotency-Key` that is stable per client and operation. Zero dependencies for the free tier.",
    install: "npm install agent402-client",
    example: `import { Agent402 } from "agent402-client";

const a = new Agent402();   // https://agent402.tools

const matches = await a.find("extract the article from a url");
// [{ slug: "extract", route, price, inputSchema, example, ... }]

const out = await a.call("hash", { text: "hello world", algo: "sha256" });
console.log(out.hex);`,
    walletExample: `import { Fetch, evm, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_KEY);
const mppFetch = Fetch.from({ methods: [tempo.charge({ account }), evm.charge({ account })] });

const a = new Agent402({ fetch: mppFetch, maxPerCallUsd: 0.05 });
const verdict = await a.call("sql-guard", { sql: "UPDATE users SET plan = 'pro' WHERE id = 42" });`,
    exposes: [
      "`find(task)`: the best-matching tools with route, price, input schema and example.",
      "`call(slug, params)`: runs the tool and returns its JSON, paying as needed.",
      "`maxPerCallUsd`, `dailyLimitUsd` and `maxPerHostUsd` spend caps, with reservations so concurrent calls cannot overspend.",
      "`topSellers()` and the network helpers `withNetworkPreference` / `withPayeeAllowlist` for an x402 client.",
    ],
    payment: [
      "Free pure-CPU tools: built-in proof-of-work, no wallet.",
      "Wallet-only tools: pass a payment-aware `fetch`. A stock `mppx` fetch pays over MPP (USDC on Base or Celo, or natively on Tempo); an `@x402/fetch` fetch pays over x402.",
      "`creditsKey`: a prepaid `a402_...` key pays by card balance, debited only on a 200.",
    ],
    tools: ["extract", "hash", "sql-guard", "whois", "search"],
    guides: ["x402-in-5-minutes", "x402-and-mpp"],
    learn: ["pay-per-call-api", "agent-payments"],
  },
  {
    slug: "tollbooth",
    meta: "agent402-tollbooth: middleware or a reverse proxy that charges AI crawlers per request over x402 and MPP while people browse free.",
    name: "Tollbooth (pay-per-crawl)",
    short: "Tollbooth",
    pkg: "agent402-tollbooth",
    dir: "tollbooth",
    what: "The sell side: middleware or a reverse proxy that puts a per-request price on a site or API for AI crawlers and agents while human visitors browse free. One 402 carries an x402 offer and an MPP challenge, plus a proof-of-work path for a walletless agent. Non-custodial: payments go to your own wallet.",
    install: "npm install agent402-tollbooth",
    example: `import express from "express";
import { createTollbooth } from "agent402-tollbooth";

const app = express();

// Humans pass through; known AI crawlers get 402 and must pay or solve a proof-of-work.
app.use(createTollbooth({ price: "$0.002" }));

app.get("/article", (_req, res) => res.send("...your content..."));
app.listen(3000);`,
    walletExample: `# reverse proxy in front of any site, settling over x402 and MPP from env alone
npm i @x402/express @x402/core @x402/evm
TOLLBOOTH_UPSTREAM=https://your-site.com \\
TOLLBOOTH_PAYTO=0xYourWallet \\
TOLLBOOTH_FACILITATOR_URL=https://x402.org/facilitator \\
TOLLBOOTH_NETWORK=base-sepolia \\
npx agent402-tollbooth   # testnet dry run; for mainnet, drop TOLLBOOTH_NETWORK and use a mainnet facilitator`,
    exposes: [
      "`createTollbooth(config)`: Express-compatible middleware with charge modes, adaptive proof-of-work and a stats sink.",
      "`npx agent402-tollbooth`: a reverse proxy that needs no code change on the origin.",
      "An edge build on the Web Crypto and Fetch APIs, with deploy templates for Cloudflare Workers, Next.js and Docker.",
      "A `/__tollbooth` dashboard and `gate.stats()` for what was served and paid.",
    ],
    payment: [
      "x402: USDC through a facilitator you choose, verified before the request is served and settled only on a successful response.",
      "MPP: `WWW-Authenticate: Payment` challenges on the same 402, including native MPP on Tempo with split payments.",
      "Proof-of-work: a sha256 puzzle, single-use and bound to the exact URL, so a crawler with no wallet can still get through.",
    ],
    tools: ["robots-check", "tls-cert", "http-headers", "x402-quote"],
    guides: ["sell-your-api-over-x402", "coinbase-business-get-paid-by-agents"],
    learn: ["http-402", "pay-per-call-api"],
  },
  {
    slug: "openclaw",
    meta: "Agent402 as an OpenClaw model provider: routed and explicit models priced per call, paid by credits key or USDC over x402 through a local proxy.",
    name: "OpenClaw model provider",
    short: "OpenClaw",
    pkg: "agent402-openclaw",
    dir: "openclaw",
    what: "An OpenClaw plugin that adds Agent402 as a model provider: the routed `auto` model and every model the gateway lists, priced per call. A loopback proxy pays Agent402 and forwards, so OpenClaw only ever sees a local OpenAI-compatible URL. The same key or wallet reaches the tool catalog.",
    install: "openclaw plugins install agent402-openclaw",
    lang: "bash",
    example: `openclaw plugins install agent402-openclaw
npx agent402-openclaw setup --write   # no key? it creates a wallet and prints the address to fund
openclaw gateway restart`,
    walletExample: `# pay by card instead: buy a credits pack, then
AGENT402_CREDITS_KEY=a402_... npx agent402-openclaw setup --write

# no OpenClaw? run the proxy alone and point any OpenAI client at it
npx agent402-openclaw proxy   # http://127.0.0.1:8412/v1, model "auto"`,
    exposes: [
      "`auto` (routed per prompt) plus every model id from GET /v1/models.",
      "Explicit models go to the metered route by default, where each request is quoted from its body; `--flat` keeps them on flat per-call tiers.",
      "CLI commands: `setup`, `proxy`, `doctor`, `wallet`, `permit2-approve`.",
    ],
    payment: [
      "A prepaid credits key: card balance, metered calls debited at actual usage.",
      "A wallet: USDC on Base over x402, exact by default; after a one-time `permit2-approve`, the quote becomes a ceiling and the call settles at actual usage.",
      "The proxy answers loopback only and refuses browser-originated requests, so a web page cannot spend the key.",
    ],
    tools: ["v1-chat-metered", "v1-chat", "v1-embeddings", "search", "answer"],
    guides: ["openclaw-model-provider", "agent-hosts"],
    learn: ["pay-per-call-api", "agent-payments"],
  },
];

export const integrationSlugs = () => INTEGRATIONS.map((i) => i.slug);
export const integrationBySlug = (slug) => INTEGRATIONS.find((i) => i.slug === slug) || null;

// Guide slug -> integrations that guide's reader will want next. Read by
// guides.js to render a "packages" block under the guide body.
export const GUIDE_INTEGRATIONS = (() => {
  const m = {};
  for (const i of INTEGRATIONS) for (const g of i.guides || []) (m[g] ||= []).push(i.slug);
  return m;
})();

const registryUrl = (i) => (i.registry === "pypi" ? `https://pypi.org/project/${i.pkg}/` : `https://www.npmjs.com/package/${i.pkg}`);
const registryLabel = (i) => (i.registry === "pypi" ? "PyPI" : "npm");

const LEARN_LABELS = {
  x402: "What x402 is",
  "http-402": "HTTP 402 Payment Required",
  mpp: "MPP (Machine Payments Protocol)",
  "agent-payments": "Agent payments",
  "pay-per-call-api": "Pay-per-call APIs",
  "mcp-payments": "Payments over MCP",
};

// Inline code spans in the short prose fields use backticks; render them as
// <code> after escaping.
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code style="font-family:var(--font-mono);font-size:.9em;">$1</code>');

const guideTitle = (slug) => slug.replace(/-/g, " ");

function toolsFor(i, catalog) {
  const bySlug = new Map(Object.values(catalog || {}).filter((d) => d && d.slug).map((d) => [d.slug, d]));
  return (i.tools || []).map((s) => bySlug.get(s)).filter(Boolean);
}

const H2 = 'style="font-family:var(--font-body);font-weight:800;font-size:24px;letter-spacing:-.02em;margin:0 0 12px;"';
const PRE = 'style="background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-size:.82rem;line-height:1.55;padding:16px;margin:0;overflow-x:auto;white-space:pre;"';
const LI = 'style="color:var(--muted);font-size:.95rem;line-height:1.65;margin:0 0 8px;"';
const A = 'style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);"';

export function integrationPage(baseUrl, slug, catalog, guideTitles = {}) {
  const i = integrationBySlug(slug);
  if (!i) return null;
  const canonical = `${baseUrl}/integrations/${i.slug}`;
  const title = `${i.name} integration (${i.pkg})`;
  const description = i.meta;
  const github = repoUrl(`tree/main/${i.dir}`);
  const tools = toolsFor(i, catalog);

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
      { "@type": "ListItem", position: 2, name: "Integrations", item: `${baseUrl}/integrations` },
      { "@type": "ListItem", position: 3, name: i.name, item: canonical },
    ],
  };
  const codeLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    name: i.pkg,
    description: i.what.replace(/`/g, ""),
    url: canonical,
    codeRepository: github,
    programmingLanguage: i.registry === "pypi" ? "Python" : "JavaScript",
    license: "https://opensource.org/licenses/MIT",
    sameAs: [registryUrl(i)],
    author: { "@type": "Organization", name: "Havok Holdings LLC" },
  };

  const toolCards = tools.map((t) => `<a href="/tools/${esc(t.slug)}" style="display:block;border:1px solid var(--hairline);background:var(--card);padding:14px 16px;text-decoration:none;color:var(--ink);">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;"><span style="font-weight:700;font-size:15px;">${esc(t.name || t.slug)}</span><span style="font-family:var(--font-mono);font-size:12px;color:var(--accent);">${esc(t.price || "")}</span></div>
      <div style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);margin-top:4px;">${esc(t.slug)}</div>
    </a>`).join("\n");

  const learnLinks = (i.learn || ["x402", "mpp"]).filter((s) => LEARN_LABELS[s])
    .map((s) => `<a href="/learn/${s}" ${A}>${esc(LEARN_LABELS[s])}</a>`).join(" &middot; ");
  const guideLinks = (i.guides || []).map((g) => `<a href="/guides/${esc(g)}" ${A}>${esc(guideTitles[g] || guideTitle(g))}</a>`).join(" &middot; ");
  const docsLink = i.docsSlug ? ` &middot; <a href="/docs/adapters/${esc(i.docsSlug)}" ${A}>configuration reference</a>` : "";

  const body = `
  <div style="max-width:980px;margin:0 auto;padding:50px 30px 64px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin:0 0 20px;"><a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <a href="/integrations" style="color:var(--muted);text-decoration:none;">integrations</a> / <span style="color:var(--ink);">${esc(i.slug)}</span></nav>
    <h1 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1.02;letter-spacing:-.025em;margin:0 0 10px;">${esc(i.name)}</h1>
    <div style="font-family:var(--font-mono);font-size:.9rem;color:var(--accent);margin-bottom:18px;">${esc(i.pkg)} &middot; ${esc(registryLabel(i))} &middot; MIT</div>
    <p style="color:var(--muted);font-size:1.05rem;line-height:1.7;margin:0 0 34px;max-width:760px;">${inline(i.what)}</p>

    <section style="margin-bottom:34px;">
      <h2 ${H2}>Install</h2>
      <pre ${PRE}><code>${esc(i.install)}</code></pre>
    </section>

    <section style="margin-bottom:34px;">
      <h2 ${H2}>Example</h2>
      <pre ${PRE}><code>${esc(i.example)}</code></pre>
    </section>

    <section style="margin-bottom:34px;">
      <h2 ${H2}>What it exposes</h2>
      <ul style="padding-left:20px;margin:0;">${i.exposes.map((e) => `<li ${LI}>${inline(e)}</li>`).join("")}</ul>
    </section>

    <section style="margin-bottom:34px;">
      <h2 ${H2}>How payment works</h2>
      <ul style="padding-left:20px;margin:0 0 16px;">${i.payment.map((e) => `<li ${LI}>${inline(e)}</li>`).join("")}</ul>
      ${i.walletExample ? `<pre ${PRE}><code>${esc(i.walletExample)}</code></pre>` : ""}
      <p style="color:var(--muted);font-size:.92rem;line-height:1.6;margin:14px 0 0;">A call that fails is not charged: settlement runs after the tool and only on a successful response. Background: ${learnLinks}.</p>
    </section>

    ${tools.length ? `<section style="margin-bottom:34px;">
      <h2 ${H2}>Tools to try first</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;">
${toolCards}
      </div>
      <p style="color:var(--muted);font-size:.9rem;margin:12px 0 0;">Every tool, price and input schema: <a href="/tools" ${A}>the catalog</a>.</p>
    </section>` : ""}

    <section style="margin-bottom:10px;">
      <h2 ${H2}>Links</h2>
      <p style="color:var(--muted);font-size:.95rem;line-height:1.8;margin:0;">
        <a href="${esc(registryUrl(i))}" rel="noopener" ${A}>${esc(i.pkg)} on ${esc(registryLabel(i))}</a> &middot; <a href="${esc(github)}" rel="noopener" ${A}>source on GitHub</a>${docsLink}<br>
        ${guideLinks ? `Guides: ${guideLinks}<br>` : ""}
        <a href="/integrations" ${A}>All integrations</a>
      </p>
    </section>
  </div>
  ${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "__none__", jsonLd: [breadcrumbLd, codeLd], body });
}
