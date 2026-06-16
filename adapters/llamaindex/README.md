# agent402-llamaindex

Drop-in **LlamaIndex TS tools** for [Agent402](https://agent402.tools) — the open-source, self-hostable x402 + MCP server with ~1,100 pay-per-call web tools (browser, web search, PDF, images, live data, payment helpers, wallet-keyed memory).

- **Zero new infra.** Get back a ready-to-pass `FunctionTool[]` array for any LlamaIndex agent.
- **Free tier by default.** No wallet needed — compute-payable tools settle with a built-in proof-of-work.
- **Wallet-only tools optional.** Pass an `@x402/fetch`-wrapped fetch to use the full catalog.
- **Raw JSON Schema.** No Zod or manual schema authoring needed.

## Install

```bash
npm install llamaindex agent402-llamaindex
```

## Use with the OpenAI agent

```js
import { OpenAIAgent } from "llamaindex";
import { agent402Tools } from "agent402-llamaindex";

const { tools } = await agent402Tools({ slugs: ["extract", "hash", "render", "screenshot"] });

const agent = new OpenAIAgent({ tools });
const res = await agent.chat({ message: "Get the title of https://example.com/article" });
console.log(res.response);
```

## Use with a Workflow

```js
import { agent } from "llamaindex";

const { tools } = await agent402Tools({ slugs: ["hash"] });
const myAgent = agent({ tools });
const res = await myAgent.run("Compute SHA-256 of 'hello world'");
```

## Pay with USDC (wallet-only tools)

```js
const { tools } = await agent402Tools({
  freeOnly: false,
  fetch: payFetch, // your @x402/fetch-wrapped fetch
});
```

## Self-hosted Agent402

```js
const { tools } = await agent402Tools({ baseUrl: "https://agent402.example.com" });
```

## Trust & `baseUrl`

The catalog server you point `baseUrl` at controls the **name, description, and JSON Schema** of every generated tool — and tool descriptions are passed to your LLM. Only point `baseUrl` at an Agent402 instance you operate or trust. The default (`https://agent402.tools`) is the maintained, open-source hosted instance.

## License

MIT
