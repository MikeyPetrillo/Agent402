# agent402-anthropic-tools

Drop-in **Anthropic tool-use tools** for [Agent402](https://agent402.tools) - the open-source, self-hostable x402 + MCP server with 500+ pay-per-call web tools (browser, web search, PDF, images, live data, payment helpers, wallet-keyed memory).

> **Agent402 is the applied layer of [Agentic Finance](https://agent402.tools/agentic-finance)** - agents that pay and get paid on their own over the two open wires, [x402](https://agent402.tools/what-is-x402) and [MPP](https://agent402.tools/what-is-mpp) (Machine Payments Protocol). Every paid endpoint answers both on the same 402; wallet-only tools take any payment-wrapped fetch (`@x402/fetch`, or a stock `mppx` fetch).

> Already using Claude with **MCP**? `agent402-mcp` is the better path - paste `https://agent402.tools/mcp` into your client. This package is for direct **Messages API** integrations (server-side agents, custom tool loops) where MCP isn't available.

- **Zero new infra.** Get back a ready-to-pass `tools` array for the Messages API.
- **Free tier by default.** No wallet needed - the compute-payable tools settle with a built-in proof-of-work.
- **Wallet-only tools optional.** Pass an `@x402/fetch`-wrapped fetch to use the full catalog.
- **Doesn't burn discovery tokens.** Give Claude the catalog up front instead of letting it scrape its way to a tool.

## Install

```bash
npm install @anthropic-ai/sdk agent402-anthropic-tools
```

## Use with the Messages API

```js
import Anthropic from "@anthropic-ai/sdk";
import { agent402Tools } from "agent402-anthropic-tools";

const client = new Anthropic();
// The default (freeOnly: true) keeps only compute-payable tools, so list free ones here;
// wallet-only slugs such as "extract" or "render" need freeOnly: false and a paying fetch (below).
const { tools, execute } = await agent402Tools({ slugs: ["hash", "uuid", "json-to-csv"] });

const res = await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  tools,
  messages: [{ role: "user", content: "What is the SHA-256 of 'hello world'?" }],
});

// Resolve tool_use blocks (free - paid via proof-of-work behind the scenes).
const block = res.content.find((b) => b.type === "tool_use");
if (block) {
  const result = await execute(block.name, block.input);
  console.log(result);
}
```

## Pay with USDC (wallet-only tools)

For the catalog's wallet-only tools (browser, network, memory), wrap your fetch with `@x402/fetch` and pass it in:

```js
const { tools, execute } = await agent402Tools({
  slugs: ["extract", "render", "screenshot"],
  freeOnly: false,
  fetch: payFetch, // your @x402/fetch-wrapped fetch
});
```

## Self-hosted Agent402

```js
const { tools, execute } = await agent402Tools({ baseUrl: "https://agent402.example.com" });
```

## Trust & `baseUrl`

The catalog server you point `baseUrl` at controls the **name, description, and JSON Schema** of every generated tool - and tool descriptions are passed to Claude. Only point `baseUrl` at an Agent402 instance you operate or trust. The default (`https://agent402.tools`) is the maintained, open-source hosted instance.

## License

MIT
