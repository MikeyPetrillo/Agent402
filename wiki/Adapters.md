# Adapters

If your agent isn't an MCP client, there's a zero-dependency npm package that turns the Agent402 catalog into native tool objects for your framework — with payment handled underneath (proof-of-work for free tools, USDC via x402 for wallet-only).

| Stack | npm package | Returns |
|---|---|---|
| OpenAI function-calling (chat.completions / Assistants v2 / Responses) | [`agent402-openai-tools`](https://www.npmjs.com/package/agent402-openai-tools) | `tools[]` for the `tools:` param |
| Anthropic Messages API (`tool_use`) | [`agent402-anthropic-tools`](https://www.npmjs.com/package/agent402-anthropic-tools) | `tools[]` for the `tools:` param |
| Vercel AI SDK (`streamText` / `generateText` / `generateObject`) | [`agent402-ai-sdk`](https://www.npmjs.com/package/agent402-ai-sdk) | `Record<name, tool()>` |
| LangChain JS / LangGraph | [`agent402-langchain`](https://www.npmjs.com/package/agent402-langchain) | `DynamicStructuredTool[]` |
| LlamaIndex TS | [`agent402-llamaindex`](https://www.npmjs.com/package/agent402-llamaindex) | `FunctionTool[]` |

Sources live at [`adapters/`](https://github.com/MikeyPetrillo/Agent402/tree/main/adapters).

> Already a Claude/MCP user? Use the hosted [[MCP Connector]] — it's the better path. Adapters are for direct API integrations where MCP isn't available.

## Shared surface

Every adapter exports the same `agent402Tools()` function:

```ts
agent402Tools(opts?: {
  baseUrl?: string;       // default "https://agent402.tools"
  slugs?: string[];       // restrict to these tool slugs (recommended — smaller list = better tool-selection)
  freeOnly?: boolean;     // default true — only include compute-payable tools (no wallet needed)
  fetch?: typeof fetch;   // an @x402/fetch-wrapped fetch; only needed for wallet-only tools
}): Promise<{
  tools: <framework-shape>;
  execute: (name, args) => Promise<unknown>;   // pays under the hood
  client: Agent402;                            // raw buyer SDK (find()/call()/clearCache())
}>
```

A standalone `agent402Execute({ baseUrl, fetch })` is also exported if you built your tool list a different way and just want the payment-aware executor.

## OpenAI

```js
import OpenAI from "openai";
import { agent402Tools } from "agent402-openai-tools";

const openai = new OpenAI();
const { tools, execute } = await agent402Tools({ slugs: ["extract", "hash", "render", "screenshot"] });

const res = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Get the title of https://example.com/article" }],
  tools,
});

const call = res.choices[0].message.tool_calls?.[0];
if (call) console.log(await execute(call.function.name, JSON.parse(call.function.arguments)));
```

Same `tools` array works for `assistants.create({ tools })` and `responses.create({ tools })`.

## Anthropic

```js
import Anthropic from "@anthropic-ai/sdk";
import { agent402Tools } from "agent402-anthropic-tools";

const client = new Anthropic();
const { tools, execute } = await agent402Tools({ slugs: ["extract", "hash"] });

const res = await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  tools,
  messages: [{ role: "user", content: "Get the title of https://example.com/article" }],
});

const block = res.content.find((b) => b.type === "tool_use");
if (block) console.log(await execute(block.name, block.input));
```

## Vercel AI SDK

```js
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { agent402Tools } from "agent402-ai-sdk";

const { tools } = await agent402Tools({ slugs: ["extract", "hash"] });
const result = await streamText({
  model: openai("gpt-4o-mini"),
  tools,
  prompt: "Get the title of https://example.com/article",
});

for await (const chunk of result.textStream) process.stdout.write(chunk);
```

## LangChain JS

```js
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { agent402Tools } from "agent402-langchain";

const { tools } = await agent402Tools({ slugs: ["extract", "hash"] });
const agent = createReactAgent({
  llm: new ChatOpenAI({ model: "gpt-4o-mini" }),
  tools,
});
const res = await agent.invoke({
  messages: [{ role: "user", content: "Get the title of https://example.com/article" }],
});
```

## LlamaIndex TS

```js
import { OpenAIAgent } from "llamaindex";
import { agent402Tools } from "agent402-llamaindex";

const { tools } = await agent402Tools({ slugs: ["extract", "hash"] });
const agent = new OpenAIAgent({ tools });
const res = await agent.chat({ message: "Get the title of https://example.com/article" });
```

## Pay with USDC (wallet-only tools)

By default `freeOnly: true` restricts to compute-payable tools so no wallet is needed. For the wallet-only catalog (browser, network, memory), wrap your fetch with `@x402/fetch` and pass it in:

```js
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

const { tools, execute } = await agent402Tools({ freeOnly: false, fetch: payFetch });
```

## Self-hosted catalog

Point at your own Agent402 instance:

```js
const { tools } = await agent402Tools({ baseUrl: "https://agent402.example.com" });
```

## Trust & `baseUrl`

The catalog server you point `baseUrl` at controls the **name, description, and JSON Schema** of every generated tool — and tool descriptions are passed to your LLM. Only point `baseUrl` at an Agent402 instance you operate or trust. The default (`https://agent402.tools`) is the maintained, open-source hosted instance. Catalog/pricing fetches are bounded by a 15s `AbortSignal.timeout()` to cap the discovery hang if a misconfigured `baseUrl` is unreachable.

See also: [[Security Model]] · [[Getting Started]] · [[Paying with x402]] · [[Paying with Compute]].
