# agent402-strands

Drop-in [Strands Agents](https://strandsagents.com) (TypeScript) tools for
[Agent402](https://agent402.tools) - turn 500+ pay-per-call web tools into
Strands `tool({...})` instances your agent can invoke. Payment is handled
underneath: proof-of-work for the compute-payable tools (no wallet), and the
payment-wrapped fetch you pass (x402 in USDC on 11 chains or USDG on Robinhood
Chain, or a stock `mppx` fetch) for wallet-only tools.

> **Agent402 is the applied layer of [Agentic Finance](https://agent402.tools/agentic-finance)** - agents that pay and get paid on their own over the two open wires, [x402](https://agent402.tools/what-is-x402) and [MPP](https://agent402.tools/what-is-mpp) (Machine Payments Protocol). Every paid endpoint answers both on the same 402; wallet-only tools take any payment-wrapped fetch (`@x402/fetch`, or a stock `mppx` fetch).

Works in a Strands agent anywhere it runs, including on AWS Bedrock AgentCore.

## Install

```bash
npm install agent402-strands @strands-agents/sdk zod @x402/fetch @x402/core @x402/evm viem
```

The `@x402/*` and `viem` packages pay wallet-only tools from your wallet; the free tier needs only the first three.

## Use

```ts
import { Agent } from "@strands-agents/sdk";
import { agent402Tools } from "agent402-strands";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const payClient = new x402Client();
registerExactEvmScheme(payClient, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, payClient);

// Web search, then a cited answer: both wallet-only, paid per call through payFetch.
const { tools } = await agent402Tools({
  slugs: ["search", "answer"],   // pick what you need
  freeOnly: false,
  fetch: payFetch,
});

const agent = new Agent({ tools });
const out = await agent.invoke("Search the web for x402 payment protocol adoption, then answer with citations: what is the x402 payment protocol?");
```

**No wallet yet?** The pure-CPU tools (hash, uuid, base64, markdown, JSON and more) run free with proof-of-work and no wallet. Leave out `fetch`; the default (`freeOnly: true`) keeps only those tools:

```ts
const { tools } = await agent402Tools({
  slugs: ["hash", "uuid", "json-to-csv"],
});
```

That's it. The agent now has those tools available; when it calls one, the
adapter signs an x402 payment (paid tier) or solves a proof-of-work (free
tier) under the hood and returns the result as a structured object.

## On AWS Bedrock AgentCore

Two ways in:

1. Add `https://agent402.tools/mcp` as a Gateway target to reach the catalog
   over MCP, no adapter needed.
2. Or use this adapter to pull a *curated subset* of tools and embed them
   directly in a Strands agent running on AgentCore.

See the [AWS Bedrock AgentCore integration guide](https://github.com/MikeyPetrillo/Agent402/wiki/AWS-Bedrock-AgentCore)
for the end-to-end recipe.

## API

```ts
agent402Tools(opts?: {
  baseUrl?: string;       // default "https://agent402.tools"
  slugs?: string[];       // restrict to these tool slugs (recommended)
  freeOnly?: boolean;     // default true - only compute-payable tools (no wallet)
  fetch?: typeof fetch;   // an @x402/fetch-wrapped fetch (only for wallet-only tools)
}): Promise<{
  tools:   StrandsTool[];                       // pass to `new Agent({ tools })`
  execute: (name, args) => Promise<unknown>;    // pays under the hood
  client:  Agent402;                            // raw buyer SDK (find()/call()/clearCache())
}>;

agent402Execute(opts?: {
  baseUrl?: string;
  fetch?: typeof fetch;
}): (name, args) => Promise<unknown>;
```

`freeOnly: true` (the default) filters to the compute-payable (pure-CPU)
tools - every one of them works with no wallet, paid in a fraction of a second
of CPU via proof-of-work. Set `freeOnly: false` and pass an
`@x402/fetch`-wrapped `fetch` to reach the wallet-only tools (the network- and
disk-touching ones, and most skill packs). The live split is on
`/api/pricing` (`computePayable` per entry).

## Sibling adapters

Same shape, different framework:

- [`agent402-openai-tools`](https://www.npmjs.com/package/agent402-openai-tools) - OpenAI function-calling
- [`agent402-anthropic-tools`](https://www.npmjs.com/package/agent402-anthropic-tools) - Anthropic Messages
- [`agent402-ai-sdk`](https://www.npmjs.com/package/agent402-ai-sdk) - Vercel AI SDK
- [`agent402-langchain`](https://www.npmjs.com/package/agent402-langchain) - LangChain JS / LangGraph
- [`agent402-llamaindex`](https://www.npmjs.com/package/agent402-llamaindex) - LlamaIndex TS

Source: [`adapters/strands/`](https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/strands).
Issues + PRs welcome on the [main repo](https://github.com/MikeyPetrillo/Agent402).
MIT licensed.
