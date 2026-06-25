# agent402-openai-agents

OpenAI Agents SDK tools for [Agent402](https://agent402.tools) — the open-source
x402 + MCP server with 1,338 pay-per-call web tools (browser, web search,
OCR, PDFs, durable memory, ~1,000 pure-CPU utilities) **and** the cross-seller
[Smart Order Router](https://agent402.tools/index) that ranks tools across the
whole x402 ecosystem.

```bash
npm install agent402-openai-agents @openai/agents zod
```

## Quickstart

```js
import { agent402Tools } from "agent402-openai-agents";
import { Agent, run } from "@openai/agents";

// Free tier (proof-of-work auto-pay, no wallet)
const tools = await agent402Tools();

// Or, for wallet-required tools (browser, search, memory), supply an
// x402-wrapped fetch (e.g. @x402/fetch with your funded Base wallet):
const tools = await agent402Tools({ fetch: payFetch });

const agent = new Agent({
  name: "x402-agent",
  instructions: "Use agent402 to find and call paid web tools when needed.",
  tools,
});
const result = await run(agent, "Hash 'hello world' with sha256");
```

## What you get — four meta tools

The LLM picks tasks; the router picks sellers; the caller handles payment.

| Tool | Purpose |
|---|---|
| `agent402_find` | Resolve a plain-language task to the best **local** Agent402 tool — slug, route, price, input schema, and a ready example. |
| `agent402_route` | **Cross-seller x402 router**: rank tools across every x402 seller (Agent402 + auto-discovered competitors from the Coinbase CDP Bazaar). `include: "external"` excludes Agent402 itself — neutral discovery API over the rest of the ecosystem. |
| `agent402_call` | Call a tool by slug. Pays automatically: pure-CPU tools via proof-of-work; wallet-only via your x402 fetch. |
| `agent402_about` | The Agent402 service manifest — payment options, capability map, MCP connector, trust signals. |

Why four meta tools and not one tool per slug? Registering 1,338 individual
tools blows past most agents' tool-budget and the LLM can't reason over
hundreds of entries. Routing-as-discovery scales — the LLM describes the
task, the router picks the cheapest healthy seller, the caller handles
payment.

## Framework-agnostic specs

If you'd rather not pull in `@openai/agents` (or you want to wrap the tools
with your own factory), use the framework-agnostic export:

```js
import { agent402ToolSpecs } from "agent402-openai-agents";

const specs = agent402ToolSpecs();
// specs = [{ name, description, parametersJsonSchema, execute }, ...]
const result = await specs.find((s) => s.name === "agent402_route").execute({
  query: "ocr image",
  top: 3,
  include: "external",
});
```

## Options

```ts
agent402Tools({
  baseUrl?: string,    // default: "https://agent402.tools"
  fetch?: typeof fetch, // x402-wrapped fetch for wallet-required tools
  fetchImpl?: typeof fetch, // base fetch for unpaid lookups (default: global fetch)
})
```

## License

MIT — part of [Agent402](https://github.com/MikeyPetrillo/Agent402).
