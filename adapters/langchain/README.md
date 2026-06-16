# agent402-langchain

Drop-in **LangChain JS tools** for [Agent402](https://agent402.tools) — the open-source, self-hostable x402 + MCP server with ~1,100 pay-per-call web tools (browser, web search, PDF, images, live data, payment helpers, wallet-keyed memory).

- **Zero new infra.** Get back a ready-to-pass `Tool[]` array for any LangChain agent or LangGraph node.
- **Free tier by default.** No wallet needed — compute-payable tools settle with a built-in proof-of-work.
- **Wallet-only tools optional.** Pass an `@x402/fetch`-wrapped fetch to use the full catalog.
- **JSON Schema → Zod automatically.** No manual schema authoring.

## Install

```bash
npm install @langchain/core @langchain/openai zod agent402-langchain
```

## Use with LangGraph's prebuilt ReAct agent

```js
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { agent402Tools } from "agent402-langchain";

const { tools } = await agent402Tools({ slugs: ["extract", "hash", "render", "screenshot"] });

const agent = createReactAgent({
  llm: new ChatOpenAI({ model: "gpt-4o-mini" }),
  tools,
});

const res = await agent.invoke({
  messages: [{ role: "user", content: "Get the title of https://example.com/article" }],
});
console.log(res.messages.at(-1).content);
```

## Use with a classic LangChain agent

```js
import { AgentExecutor, createOpenAIFunctionsAgent } from "langchain/agents";
import { ChatOpenAI } from "@langchain/openai";

const { tools } = await agent402Tools({ slugs: ["hash"] });
const agent = await createOpenAIFunctionsAgent({
  llm: new ChatOpenAI({ model: "gpt-4o-mini" }),
  tools,
  prompt: yourPrompt,
});
const exec = new AgentExecutor({ agent, tools });
await exec.invoke({ input: "Compute SHA-256 of 'hello world'" });
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
