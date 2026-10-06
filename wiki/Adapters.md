# Adapters

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

If your agent isn't an MCP client, there's an npm package that turns the Agent402 catalog into native tool objects for your framework - with payment handled underneath (proof-of-work for free tools, USDC via x402 for wallet-only).

| Stack | npm package | Returns |
|---|---|---|
| OpenAI function-calling (chat.completions / Assistants v2 / Responses) | [`agent402-openai-tools`](https://www.npmjs.com/package/agent402-openai-tools) | `tools[]` for the `tools:` param |
| Anthropic Messages API (`tool_use`) | [`agent402-anthropic-tools`](https://www.npmjs.com/package/agent402-anthropic-tools) | `tools[]` for the `tools:` param |
| Vercel AI SDK (`streamText` / `generateText`) | [`agent402-ai-sdk`](https://www.npmjs.com/package/agent402-ai-sdk) | `Record<name, tool()>` (four meta tools) |
| LangChain JS / LangGraph | [`agent402-langchain`](https://www.npmjs.com/package/agent402-langchain) | `DynamicStructuredTool[]` (four meta tools) |
| LlamaIndex TS | [`agent402-llamaindex`](https://www.npmjs.com/package/agent402-llamaindex) | `FunctionTool[]` |
| elizaOS | [`elizaos-plugin-agent402`](https://www.npmjs.com/package/elizaos-plugin-agent402) | a `Plugin` with `AGENT402_FIND` / `AGENT402_CALL` / `AGENT402_ABOUT` actions and an `AGENT402` provider |
| Coinbase AgentKit (CDP, Privy, ZeroDev, viem wallets) | [`agent402-agentkit`](https://www.npmjs.com/package/agent402-agentkit) | an `ActionProvider` for `AgentKit.from({ actionProviders })` |
| Strands Agents (AWS Bedrock AgentCore) | [`agent402-strands`](https://www.npmjs.com/package/agent402-strands) | `StrandsTool[]` for `new Agent({ tools })` |
| Google ADK (Agent Development Kit) | [`agent402-google-adk`](https://www.npmjs.com/package/agent402-google-adk) | `FunctionTool[]` (four meta tools) |
| OpenAI Agents SDK | [`agent402-openai-agents`](https://www.npmjs.com/package/agent402-openai-agents) | `tool()` instances for `new Agent({ tools })` (four meta tools) |

Sources live at [`adapters/`](https://github.com/MikeyPetrillo/Agent402/tree/main/adapters).

> Already a Claude/MCP user? Use the hosted [[MCP Connector]] - it's the better path. Adapters are for direct API integrations where MCP isn't available.

## Two shapes

The adapters come in two shapes.

**Catalog tools** (`agent402-openai-tools`, `agent402-anthropic-tools`, `agent402-llamaindex`, `agent402-strands`) turn the catalog tools you pick into native tool objects, one per slug:

```ts
agent402Tools(opts?: {
  baseUrl?: string;       // default "https://agent402.tools"
  slugs?: string[];       // restrict to these tool slugs (recommended - smaller list = better tool-selection)
  freeOnly?: boolean;     // default true - only include compute-payable tools (no wallet needed)
  fetch?: typeof fetch;   // an @x402/fetch-wrapped fetch; only needed for wallet-only tools
}): Promise<{
  tools: <framework-shape>;
  execute: (name, args) => Promise<unknown>;   // pays under the hood
  client: Agent402;                            // raw buyer SDK (find()/call()/clearCache())
}>
```

With the default `freeOnly: true`, a wallet-only slug in `slugs` (such as `extract` or `render`) is filtered out, so list compute-payable tools there, or pass `freeOnly: false` with a paying `fetch`. A standalone `agent402Execute({ baseUrl, fetch })` is also exported if you built your tool list a different way and just want the payment-aware executor.

**Meta tools** (`agent402-ai-sdk`, `agent402-langchain`, `agent402-google-adk`, `agent402-openai-agents`) register four tools instead of one per slug: `agent402_find` (resolve a task to a catalog tool), `agent402_route` (the cross-seller router), `agent402_call` (call any tool by slug, paying underneath) and `agent402_about` (the service manifest). The model picks the slug at run time:

```ts
agent402Tools(opts?: {
  baseUrl?: string;       // default "https://agent402.tools"
  fetch?: typeof fetch;   // an @x402/fetch-wrapped fetch; only needed for wallet-only tools
}): Promise<<framework-shape>>   // the tools themselves: an object keyed by name (AI SDK) or an array
```

`agent402ToolSpecs(opts)` returns the same four entries as framework-agnostic specs (plain JSON Schema plus an `execute`).

## Pay with a wallet

Every example below runs a web search (`search`) and then a cited answer (`answer`), two wallet-only tools paid per call in USDC. Wrap `fetch` once with `@x402/fetch` and pass it in as `fetch` (the meta-tool adapters take the same option):

```js
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);
```

## OpenAI

```js
import OpenAI from "openai";
import { agent402Tools } from "agent402-openai-tools";

const openai = new OpenAI();
// web search, then a cited answer: both paid per call through payFetch (above)
const { tools, execute } = await agent402Tools({ slugs: ["search", "answer"], freeOnly: false, fetch: payFetch });

const messages = [{ role: "user", content: "Search the web for x402 payment protocol adoption, then answer with citations: what is the x402 payment protocol?" }];
for (let turn = 0; turn < 4; turn++) {
  const res = await openai.chat.completions.create({ model: "gpt-4o-mini", messages, tools });
  const msg = res.choices[0].message;
  messages.push(msg);
  if (!msg.tool_calls?.length) { console.log(msg.content); break; }
  for (const call of msg.tool_calls) {
    const result = await execute(call.function.name, JSON.parse(call.function.arguments));
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
}
```

**No wallet yet?** The pure-CPU tools (hash, uuid, base64, markdown, JSON and more) run free with proof-of-work and no wallet:

```js
const { tools, execute } = await agent402Tools({ slugs: ["hash", "uuid", "json-to-csv"] });   // freeOnly: true is the default
```

Same `tools` array works for `assistants.create({ tools })` and `responses.create({ tools })`.

## Anthropic

```js
import Anthropic from "@anthropic-ai/sdk";
import { agent402Tools } from "agent402-anthropic-tools";

const anthropic = new Anthropic();
const { tools, execute } = await agent402Tools({ slugs: ["search", "answer"], freeOnly: false, fetch: payFetch });

const messages = [{ role: "user", content: "Search the web for x402 payment protocol adoption, then answer with citations: what is the x402 payment protocol?" }];
for (let turn = 0; turn < 4; turn++) {
  const res = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 1024, tools, messages });
  messages.push({ role: "assistant", content: res.content });
  const uses = res.content.filter((b) => b.type === "tool_use");
  if (!uses.length) { console.log(res.content.find((b) => b.type === "text")?.text); break; }
  const results = [];
  for (const b of uses) results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(await execute(b.name, b.input)) });
  messages.push({ role: "user", content: results });
}
```

## Vercel AI SDK

```js
import { generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { agent402Tools } from "agent402-ai-sdk";

const tools = await agent402Tools({ fetch: payFetch });   // agent402Tools() alone: the proof-of-work free tier
const { text } = await generateText({
  model: openai("gpt-4o-mini"),
  tools,
  stopWhen: stepCountIs(6),
  prompt: "Search the web for x402 payment protocol adoption, then answer with citations: what is the x402 payment protocol?",
});
```

## LangChain JS

```js
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { agent402Tools } from "agent402-langchain";

const tools = await agent402Tools({ fetch: payFetch });   // agent402Tools() alone: the proof-of-work free tier
const agent = createReactAgent({
  llm: new ChatOpenAI({ model: "gpt-4o-mini" }),
  tools,
});
const res = await agent.invoke({
  messages: [{ role: "user", content: "Search the web for x402 payment protocol adoption, then answer with citations: what is the x402 payment protocol?" }],
});
```

## LlamaIndex TS

```js
import { agent } from "@llamaindex/workflow";
import { openai } from "@llamaindex/openai";
import { agent402Tools } from "agent402-llamaindex";

const { tools } = await agent402Tools({ slugs: ["search", "answer"], freeOnly: false, fetch: payFetch });
const myAgent = agent({ tools, llm: openai({ model: "gpt-4o-mini" }) });
const res = await myAgent.run("Search the web for x402 payment protocol adoption, then answer with citations: what is the x402 payment protocol?");
```

## elizaOS

```json
{ "plugins": ["elizaos-plugin-agent402"], "settings": { "AGENT402_CREDITS_KEY": "a402_..." } }
```

Three actions: `AGENT402_FIND` (free discovery from a plain-language task), `AGENT402_CALL` (`content.slug` + `content.params`; proof-of-work for the free tier, the credits key or an x402 wallet for wallet-only tools, capped by `AGENT402_MAX_PER_CALL_USD`), `AGENT402_ABOUT`. The `AGENT402` provider tells the agent every turn that the catalog exists and which payment mode is configured. No runtime dependency on `@elizaos/core`. Package: [`elizaos-plugin-agent402`](https://www.npmjs.com/package/elizaos-plugin-agent402).

## Coinbase AgentKit

```ts
import { AgentKit, CdpEvmWalletProvider } from "@coinbase/agentkit";
import { agent402ActionProvider } from "agent402-agentkit";

const walletProvider = await CdpEvmWalletProvider.configureWithWallet({ networkId: "base-mainnet" });
const agentKit = await AgentKit.from({ walletProvider, actionProviders: [await agent402ActionProvider()] });
```

Three actions: `agent402_find` (free discovery), `agent402_call` (pays: proof-of-work for the free tier, x402 USDC on Base signed by the wallet provider for wallet-only tools), `agent402_about`. The signer is derived from the wallet provider the way AgentKit's own x402 provider does it, so CDP, Privy, ZeroDev and viem-backed wallets all pay; live-proven against production with a `ViemWalletProvider` ([tx](https://basescan.org/tx/0x1c0592f73d1f9182ee9bd40eb34d9b6c70b3196814b111589b82df4e79e7fb59)). Package: [`agent402-agentkit`](https://www.npmjs.com/package/agent402-agentkit).

## Strands Agents (AWS Bedrock AgentCore)

```js
import { Agent } from "@strands-agents/sdk";
import { agent402Tools } from "agent402-strands";

const { tools } = await agent402Tools({ slugs: ["search", "answer"], freeOnly: false, fetch: payFetch });
const agent = new Agent({ tools });
const res = await agent.invoke("Search the web for x402 payment protocol adoption, then answer with citations: what is the x402 payment protocol?");
```

For an agent on [AWS Bedrock AgentCore](AWS-Bedrock-AgentCore), this adapter embeds a chosen subset of tools in a Strands agent; the hosted `/mcp` connector as a Gateway target is the other way in. Wallet-only tools are paid through the x402-wrapped `fetch` you pass, as in [Pay with a wallet](#pay-with-a-wallet).

## Free tier (no wallet)

On the catalog-tools adapters, `freeOnly: true` (the default) restricts to compute-payable tools, paid with proof-of-work, so no wallet is needed. Leave out `fetch` and list pure-CPU slugs:

```js
const { tools, execute } = await agent402Tools({ slugs: ["hash", "uuid", "json-to-csv"] });
```

On the meta-tool adapters, `agent402Tools()` with no `fetch` gives the same four tools; `agent402_call` then pays the pure-CPU tools with proof-of-work. The rest of the wallet-only catalog (browser, network, memory) is reached the same way as the examples above: `freeOnly: false` plus a paying `fetch`.

## Self-hosted catalog

Point at your own Agent402 instance:

```js
const { tools } = await agent402Tools({ baseUrl: "https://agent402.example.com" });   // meta-tool adapters: const tools = await agent402Tools({ baseUrl })
```

## Trust & `baseUrl`

The catalog server you point `baseUrl` at controls the **name, description, and JSON Schema** of every generated catalog tool, and the results the meta tools return - and both reach your LLM. Only point `baseUrl` at an Agent402 instance you operate or trust. The default (`https://agent402.tools`) is the maintained, open-source hosted instance. On the catalog-tools adapters, the catalog and pricing fetches are bounded by a 15s `AbortSignal.timeout()` to cap the discovery hang if a misconfigured `baseUrl` is unreachable.

See also: [[Security Model]] · [[Getting Started]] · [[Paying with x402]] · [[Paying with Compute]].
