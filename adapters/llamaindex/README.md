# agent402-llamaindex

Drop-in **LlamaIndex TS tools** for [Agent402](https://agent402.tools) - the open-source, self-hostable x402 + MCP server with 500+ pay-per-call web tools (browser, web search, PDF, images, live data, payment helpers, wallet-keyed memory).

> **Agent402 is the applied layer of [Agentic Finance](https://agent402.tools/agentic-finance)** - agents that pay and get paid on their own over the two open wires, [x402](https://agent402.tools/what-is-x402) and [MPP](https://agent402.tools/what-is-mpp) (Machine Payments Protocol). Every paid endpoint answers both on the same 402; wallet-only tools take any payment-wrapped fetch (`@x402/fetch`, or a stock `mppx` fetch).

- **Zero new infra.** Get back a ready-to-pass `FunctionTool[]` array for any LlamaIndex agent.
- **Free tier by default.** No wallet needed - compute-payable tools settle with a built-in proof-of-work.
- **Wallet-only tools optional.** Pass an `@x402/fetch`-wrapped fetch to use the full catalog.
- **Raw JSON Schema.** No Zod or manual schema authoring needed.

## Install

```bash
npm install llamaindex @llamaindex/workflow @llamaindex/openai agent402-llamaindex @x402/fetch @x402/core @x402/evm viem
```

`llamaindex` is what this adapter builds its tools with; `@llamaindex/workflow`
(the agent) and `@llamaindex/openai` (an LLM) are what the example below runs on,
and the `@x402/*` and `viem` packages pay wallet-only tools from your wallet.

## Use with an agent workflow

```js
import { agent } from "@llamaindex/workflow";
import { openai } from "@llamaindex/openai";
import { agent402Tools } from "agent402-llamaindex";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const payClient = new x402Client();
registerExactEvmScheme(payClient, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, payClient);

// Web search, then a cited answer: both wallet-only, paid per call through payFetch.
const { tools } = await agent402Tools({ slugs: ["search", "answer"], freeOnly: false, fetch: payFetch });

const myAgent = agent({ tools, llm: openai({ model: "gpt-4o-mini" }) });
const res = await myAgent.run("Search the web for x402 payment protocol adoption, then answer with citations: what is the x402 payment protocol?");
```

**No wallet yet?** The pure-CPU tools (hash, uuid, base64, markdown, JSON and more) run free with proof-of-work and no wallet. Leave out `fetch`; the default (`freeOnly: true`) keeps only those tools:

```js
const { tools } = await agent402Tools({ slugs: ["hash", "uuid", "json-to-csv"] });
```

## More wallet-only tools

```js
const { tools } = await agent402Tools({
  slugs: ["extract", "render", "screenshot"],
  freeOnly: false,
  fetch: payFetch, // the @x402/fetch-wrapped fetch from above
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
