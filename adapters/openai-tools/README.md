# agent402-openai-tools

Drop-in **OpenAI function-calling tools** for [Agent402](https://agent402.tools) - the open-source, self-hostable x402 + MCP server with 500+ pay-per-call web tools (browser, web search, PDF, images, live data, payment helpers, wallet-keyed memory).

> **Agent402 is the applied layer of [Agentic Finance](https://agent402.tools/agentic-finance)** - agents that pay and get paid on their own over the two open wires, [x402](https://agent402.tools/what-is-x402) and [MPP](https://agent402.tools/what-is-mpp) (Machine Payments Protocol). Every paid endpoint answers both on the same 402; wallet-only tools take any payment-wrapped fetch (`@x402/fetch`, or a stock `mppx` fetch).

- **Zero new infra.** Get back a ready-to-pass `tools` array for `chat.completions`, Assistants v2, or the Responses API.
- **Free tier by default.** No wallet needed - the compute-payable tools settle with a built-in proof-of-work (sub-second sha256 puzzle).
- **Wallet-only tools optional.** Pass an `@x402/fetch`-wrapped fetch and the model can call any tool in the catalog.
- **Doesn't burn discovery tokens.** Stop the model from "exploring" the web to find a tool - give it the catalog up front.

## Install

```bash
npm install openai agent402-openai-tools
```

## Use with `chat.completions`

```js
import OpenAI from "openai";
import { agent402Tools } from "agent402-openai-tools";

const openai = new OpenAI();

// Pick the tools you want the model to know about. Smaller list = better tool-selection.
// The default (freeOnly: true) keeps only compute-payable tools, so list free ones here;
// wallet-only slugs such as "extract" or "render" need freeOnly: false and a paying fetch (below).
const { tools, execute } = await agent402Tools({ slugs: ["hash", "uuid", "json-to-csv"] });

const res = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "What is the SHA-256 of 'hello world'?" }],
  tools,
});

// Resolve tool calls (free - paid via proof-of-work behind the scenes).
const call = res.choices[0].message.tool_calls?.[0];
if (call) {
  const result = await execute(call.function.name, JSON.parse(call.function.arguments));
  console.log(result);
}
```

## Use with Assistants v2 or the Responses API

The shape returned by `agent402Tools()` is the same OpenAI function-calling JSON used by every flavor of the OpenAI API. Pass `tools` directly to `assistants.create({ tools })` or to `responses.create({ tools })`.

## Pay with USDC (wallet-only tools)

For the catalog's wallet-only tools (browser, network, memory), wrap your fetch with `@x402/fetch` and pass it in:

```js
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

const { tools, execute } = await agent402Tools({
  slugs: ["extract", "render", "screenshot"],
  freeOnly: false,
  fetch: payFetch,
});
```

## Self-hosted Agent402

Point at your own instance:

```js
const { tools, execute } = await agent402Tools({ baseUrl: "https://agent402.example.com" });
```

## Trust & `baseUrl`

The catalog server you point `baseUrl` at controls the **name, description, and JSON Schema** of every generated tool - and tool descriptions are passed to your LLM. Only point `baseUrl` at an Agent402 instance you operate or trust. The default (`https://agent402.tools`) is the maintained, open-source hosted instance.

## License

MIT
