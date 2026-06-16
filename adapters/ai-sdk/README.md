# agent402-ai-sdk

Drop-in **Vercel AI SDK tools** for [Agent402](https://agent402.tools) — the open-source, self-hostable x402 + MCP server with ~1,100 pay-per-call web tools (browser, web search, PDF, images, live data, payment helpers, wallet-keyed memory).

- **Zero new infra.** Get back a ready-to-pass `tools` record for `streamText` / `generateText` / `generateObject`.
- **Free tier by default.** No wallet needed — compute-payable tools settle with a built-in proof-of-work.
- **Wallet-only tools optional.** Pass an `@x402/fetch`-wrapped fetch to use the full catalog.
- **Provider-agnostic.** Works with `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, etc.

## Install

```bash
npm install ai agent402-ai-sdk
```

## Use with `streamText`

```js
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { agent402Tools } from "agent402-ai-sdk";

const { tools } = await agent402Tools({ slugs: ["extract", "hash", "render", "screenshot"] });

const result = await streamText({
  model: openai("gpt-4o-mini"),
  tools,
  prompt: "Get the title of https://example.com/article",
});

for await (const chunk of result.textStream) process.stdout.write(chunk);
```

## Use with `generateText` (one-shot)

```js
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const { tools } = await agent402Tools({ slugs: ["hash"] });
const { text } = await generateText({
  model: anthropic("claude-sonnet-4-6"),
  tools,
  prompt: "Compute the SHA-256 of 'hello world'",
});
```

## Pay with USDC (wallet-only tools)

For the catalog's wallet-only tools (browser, network, memory), wrap your fetch with `@x402/fetch` and pass it in:

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
