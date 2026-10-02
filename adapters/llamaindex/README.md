# agent402-llamaindex

Drop-in **LlamaIndex TS tools** for [Agent402](https://agent402.tools) - the open-source, self-hostable x402 + MCP server with 500+ pay-per-call web tools (browser, web search, PDF, images, live data, payment helpers, wallet-keyed memory).

> **Agent402 is the applied layer of [Agentic Finance](https://agent402.tools/agentic-finance)** - agents that pay and get paid on their own over the two open wires, [x402](https://agent402.tools/what-is-x402) and [MPP](https://agent402.tools/what-is-mpp) (Machine Payments Protocol). Every paid endpoint answers both on the same 402; wallet-only tools take any payment-wrapped fetch (`@x402/fetch`, or a stock `mppx` fetch).

- **Zero new infra.** Get back a ready-to-pass `FunctionTool[]` array for any LlamaIndex agent.
- **Free tier by default.** No wallet needed - compute-payable tools settle with a built-in proof-of-work.
- **Wallet-only tools optional.** Pass an `@x402/fetch`-wrapped fetch to use the full catalog.
- **Raw JSON Schema.** No Zod or manual schema authoring needed.

## Install

```bash
npm install llamaindex @llamaindex/workflow @llamaindex/openai agent402-llamaindex
```

`llamaindex` is what this adapter builds its tools with; `@llamaindex/workflow`
(the agent) and `@llamaindex/openai` (an LLM) are what the example below runs on.

## Use with an agent workflow

```js
import { agent } from "@llamaindex/workflow";
import { openai } from "@llamaindex/openai";
import { agent402Tools } from "agent402-llamaindex";

// The default (freeOnly: true) keeps only compute-payable tools, so list free ones here;
// wallet-only slugs such as "extract" or "render" need freeOnly: false and a paying fetch (below).
const { tools } = await agent402Tools({ slugs: ["hash", "uuid", "json-to-csv"] });

const myAgent = agent({ tools, llm: openai({ model: "gpt-4o-mini" }) });
const res = await myAgent.run("Compute SHA-256 of 'hello world'");
```

## Pay with USDC (wallet-only tools)

```js
const { tools } = await agent402Tools({
  slugs: ["extract", "render", "screenshot"],
  freeOnly: false,
  fetch: payFetch, // your @x402/fetch-wrapped fetch
});
```

## Self-hosted Agent402

```js
const { tools } = await agent402Tools({ baseUrl: "https://agent402.example.com" });
```

## Trust & `baseUrl`

The catalog server you point `baseUrl` at controls the **name, description, and JSON Schema** of every generated tool - and tool descriptions are passed to your LLM. Only point `baseUrl` at an Agent402 instance you operate or trust. The default (`https://agent402.tools`) is the maintained, open-source hosted instance.

## License

MIT
