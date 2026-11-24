# agent402-dev-kit-tools

[Agent402](https://agent402.tools) tools for use with the Agent Development Kit (ADK) from Google. Agent402 is
the open-source x402 + MCP server with 500+ pay-per-call web tools (browser, web
search, OCR, PDFs, durable memory, pure-CPU utilities) **and** the
cross-seller [Smart Order Router](https://agent402.tools/marketplace) that ranks
tools across the x402 sellers Agent402 indexes.

Works with the Agent Development Kit for TypeScript (`@google/adk`). Agent402 is not affiliated with or endorsed by Google.

Formerly `agent402-google-adk`: the same API under a new name. Change the dependency and the import specifier; nothing else changes.

> **Agent402 is the applied layer of [Agentic Finance](https://agent402.tools/agentic-finance)** - agents that pay and get paid on their own over the two open wires, [x402](https://agent402.tools/what-is-x402) and [MPP](https://agent402.tools/what-is-mpp) (Machine Payments Protocol). Every paid endpoint answers both on the same 402; wallet-only tools take any payment-wrapped fetch (`@x402/fetch`, or a stock `mppx` fetch).

```bash
npm install agent402-dev-kit-tools @google/adk zod
```

Both peers are optional: install them only if you want real ADK `FunctionTool`
instances. Without them, use `agent402ToolSpecs()` (below), which has no deps.

## Quickstart

```js
import { agent402Tools } from "agent402-dev-kit-tools";
import { LlmAgent } from "@google/adk";

// Free tier (proof-of-work auto-pay, no wallet)
const tools = await agent402Tools();

// Or, for wallet-required tools (browser, search, memory), supply an
// x402-wrapped fetch (e.g. @x402/fetch with your funded Base wallet):
// const tools = await agent402Tools({ fetch: payFetch });

const agent = new LlmAgent({
  name: "x402-agent",
  model: "gemini-2.0-flash",
  tools,
  instruction:
    "You have access to Agent402's 500+ web tools. Use agent402_find to " +
    "discover the right tool, then agent402_call to invoke it.",
});
```

## What you get - four meta tools

The LLM picks tasks; the router ranks sellers; the caller handles payment.

| Tool | Purpose |
|---|---|
| `agent402_find` | Resolve a task description to the best **local** Agent402 tool - slug, route, price, input schema, and a ready example. |
| `agent402_route` | **Cross-seller x402 router**: rank tools across the x402 sellers Agent402 indexes (its own catalog plus the other sellers it discovers and crawls). Ranked by match score; ties break on health, then buyer count, then price. `include: "external"` excludes Agent402 itself, so it doubles as a neutral discovery API over the rest of the ecosystem. |
| `agent402_call` | Call a tool by slug. Pays automatically: pure-CPU tools via proof-of-work; wallet-only via your x402 fetch. |
| `agent402_about` | The Agent402 service manifest - payment options, capability map, MCP connector, trust signals. |

Why four meta tools and not one tool per slug? Registering 500+ individual
tools blows past most agents' tool-budget and the LLM can't reason over
hundreds of entries. Routing-as-discovery scales - the LLM describes the
task, the router ranks the sellers that can serve it, the caller handles
payment.

## Framework-agnostic specs

If you'd rather not pull in `@google/adk` and `zod` (or you want to wrap the
tools with your own factory), use the framework-agnostic export:

```js
import { agent402ToolSpecs } from "agent402-dev-kit-tools";

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
  baseUrl?: string,         // default: "https://agent402.tools"
  fetch?: typeof fetch,     // x402-wrapped fetch for wallet-required tools
  fetchImpl?: typeof fetch, // base fetch for unpaid lookups (default: global fetch)
  maxPerCallUsd?: number | "off", // ceiling on one paid call, checked on its list price (default 5; 0 or "off" turns it off)
  dailyLimitUsd?: number,   // opt-in rolling 24-hour total for paid calls
})
```

### Spending caps

A paid call is checked before your payment `fetch` runs: a tool whose listed
price is above `maxPerCallUsd` (default $5, agent402-client's default, which
covers every fixed price in the catalog; `0` or `"off"` turns it off) is
refused, and so is a call that would bring the rolling 24-hour total above
`dailyLimitUsd` (opt-in). Every call sent through the payment `fetch` counts
its list price against that total, whatever its outcome. A refusal throws an
error with `code: "SPENDING_LIMIT"` and `limit` naming the cap; nothing is
paid. These caps read the list price; to hold them on the payment that is
signed, use agent402-client with its `x402Client` option.

A proof-of-work challenge above 28 bits (`MAX_POW_DIFFICULTY`) is refused
before any work, and the search yields to the event loop while it runs.

`agent402ToolSpecs()` takes the same options.

## Payment

Pure-CPU tools are free: `agent402_call` fetches a proof-of-work challenge and
solves it in-process (a fraction of a second of CPU), so no wallet is needed.
Wallet-only tools (network, browser, disk, live data) settle in USDC over x402
on whichever chain your wrapped `fetch` is funded for - Base, Solana, Polygon,
Arbitrum, Monad, Celo, Avalanche, Sei, OP Mainnet, Arc, Ink, Stellar or Algorand, plus
USDG on Robinhood Chain (14 chains in all). Prices come from the live catalog at
`/api/pricing`; never hardcode one.

## License

MIT - part of [Agent402](https://github.com/MikeyPetrillo/Agent402).
