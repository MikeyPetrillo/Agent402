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
npm install @anthropic-ai/sdk agent402-anthropic-tools @x402/fetch @x402/core @x402/evm viem
```

The `@x402/*` and `viem` packages pay wallet-only tools from your wallet; the free tier needs only the first two.

## Use with the Messages API

```js
import Anthropic from "@anthropic-ai/sdk";
import { agent402Tools } from "agent402-anthropic-tools";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const payClient = new x402Client();
registerExactEvmScheme(payClient, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, payClient);

const client = new Anthropic();
// Web search, then a cited answer: both wallet-only, paid per call through payFetch.
const { tools, execute } = await agent402Tools({ slugs: ["search", "answer"], freeOnly: false, fetch: payFetch });

const messages = [{ role: "user", content: "Search the web for x402 payment protocol adoption, then answer with citations: what is the x402 payment protocol?" }];
for (let turn = 0; turn < 4; turn++) {
  const res = await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 1024, tools, messages });
  messages.push({ role: "assistant", content: res.content });
  const uses = res.content.filter((b) => b.type === "tool_use");
  if (!uses.length) { console.log(res.content.find((b) => b.type === "text")?.text); break; }
  const results = [];
  for (const b of uses) results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(await execute(b.name, b.input)) });
  messages.push({ role: "user", content: results });
}
```

**No wallet yet?** The pure-CPU tools (hash, uuid, base64, markdown, JSON and more) run free with proof-of-work and no wallet. Leave out `fetch`; the default (`freeOnly: true`) keeps only those tools:

```js
const { tools, execute } = await agent402Tools({ slugs: ["hash", "uuid", "json-to-csv"] });
```

## More wallet-only tools

The rest of the wallet-only catalog (browser, network, memory) is paid the same way, through the same `payFetch`:

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
