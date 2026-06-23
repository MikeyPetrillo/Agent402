# AWS Bedrock AgentCore

[AWS Bedrock AgentCore Payments](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html) is a fully-managed orchestrator for **x402** — the same protocol [Agent402](https://agent402.tools) speaks natively. That means Agent402 snaps into AgentCore as a first-class tool source with **no protocol bridging code**: AgentCore handles the wallet and the signing, Agent402 supplies the catalog and serves the 402 challenges.

This page is a 5-minute recipe to wire the two together — buy side (let an AgentCore agent call Agent402 tools) and sell side (charge AgentCore agents that crawl *your* site, using `agent402-tollbooth`).

## What you get out of the box

- 1,323 deterministic, pay-per-call tools + 42 multi-tool skill packs from Agent402, callable from an AgentCore-hosted agent
- Free tier with **no wallet** (proof-of-work; AgentCore Identity is optional for that path)
- USDC-on-Base settlement for wallet-only tools, via AgentCore's `PaymentCredentialProvider` + CDP
- CloudWatch observability for every payment (AgentCore handles this)
- Strands SDK as the agent framework — AgentCore's preferred Python/TS surface

## Option 1: Gateway target (zero code, all 1,323 tools)

The fastest path. Agent402 exposes a hosted [MCP](https://modelcontextprotocol.io) endpoint at `https://agent402.tools/mcp`; point AgentCore Gateway at it and every tool shows up in your agent.

1. **Identity:** in AgentCore Identity, create a `PaymentCredentialProvider` of type `coinbaseCdp` (or `stripe` / `privy` — your choice). Paste your CDP API key id + secret. AgentCore stores them encrypted.
2. **Gateway target:** in AgentCore Gateway, add an MCP target:
   - URL: `https://agent402.tools/mcp`
   - Auth: none (free tier) or attach the `PaymentCredentialProvider` from step 1 (wallet tier)
3. **Done.** Your agent sees the four Agent402 MCP tools (`search_tools`, `find_tool`, `call_tool`, `about_agent402`) plus, via `call_tool`, the full 1,323-tool catalog. Payments — proof-of-work for free tools, USDC for wallet-only — happen in the request path; AgentCore logs every settled call to CloudWatch.

> Want to host the catalog yourself instead? Run Agent402 anywhere (`FREE_MODE=false` with `WALLET_ADDRESS` + CDP keys), and point Gateway at `https://your-host/mcp` the same way.

## Option 2: Strands adapter (curated tool subset, embedded in the agent)

When you want to ship a small, curated set of tools rather than the whole catalog — better tool-selection accuracy, smaller token cost. Use [`agent402-strands`](https://www.npmjs.com/package/agent402-strands), the drop-in adapter:

```bash
npm install agent402-strands @strands-agents/sdk zod
```

```ts
import { Agent } from "@strands-agents/sdk";
import { agent402Tools } from "agent402-strands";

// AgentCore deploys this exact Strands Agent — no extra glue.
const { tools } = await agent402Tools({
  slugs: ["extract", "hash", "render", "screenshot"],
});

const agent = new Agent({ tools });
const out = await agent.invoke("Extract the article at https://example.com/post");
```

Free-tier tools (~1,061 of them) pay automatically via proof-of-work — **no wallet required**. For the ~47 wallet-only tools, pass an `@x402/fetch`-wrapped `fetch`; AgentCore Payments signs with the CDP-backed key in Identity, so you never see private keys in your code.

```ts
const { tools } = await agent402Tools({
  freeOnly: false,
  fetch: agentcoreX402Fetch,    // the wrapper AgentCore Payments hands you
});
```

That's the whole adapter. Same shape as the sibling adapters ([OpenAI](https://www.npmjs.com/package/agent402-openai-tools), [Anthropic](https://www.npmjs.com/package/agent402-anthropic-tools), [LangChain](https://www.npmjs.com/package/agent402-langchain), [LlamaIndex](https://www.npmjs.com/package/agent402-llamaindex), [Vercel AI SDK](https://www.npmjs.com/package/agent402-ai-sdk)) — pick the one your code already uses.

## Option 3: Sell side — charge AgentCore agents with `agent402-tollbooth`

AgentCore Payments doesn't just spend; it also identifies AI traffic. If you run a site or API, [`agent402-tollbooth`](https://www.npmjs.com/package/agent402-tollbooth) is an open-source pay-per-crawl gate that fits the other half of the loop. AgentCore-hosted agents pay it the same way they pay anything else over x402.

```js
// Express app — humans browse free, AgentCore-hosted (and any other) AI agents pay per request.
import express from "express";
import { tollbooth } from "agent402-tollbooth";

const app = express();
app.use(tollbooth({
  walletAddress: "0xYourWallet",       // where USDC lands
  network: "base",
  pricePerRequest: "$0.001",
  mode: "observe",                     // safe default; flip to "bots" or "all" when ready
}));
app.get("/", (_req, res) => res.send("hello"));
app.listen(3000);
```

Three modes, three blast radii: `observe` (count + log only — recommended for the first 24h), `bots` (charge known AI user agents), `all` / `strict` (charge everything except humans). Adaptive proof-of-work means cash-poor agents can still pay in CPU. Edge-deployable to Cloudflare Workers and Next.js middleware. Stats are at `/__tollbooth` (token-gated dashboard) and machine-readable at `/__tollbooth/stats?token=...`.

This is the only public open-source gate that AgentCore agents can pay end-to-end today.

## How the request flow looks (Option 2)

```
┌──────────────────────────────────────────────────────────────┐
│  AgentCore Runtime                                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Strands Agent  (your code, agent402-strands wired in) │  │
│  │       │                                                │  │
│  │       │ tool.callback({...})                           │  │
│  │       ▼                                                │  │
│  │  agent402-client  ──── HTTP ────► agent402.tools       │  │
│  │       │  401/402 Payment Required                      │  │
│  │       │  ◄────────────────────────                     │  │
│  │       │                                                │  │
│  │       │  proof-of-work (free tier)                     │  │
│  │       │  ── OR ──                                      │  │
│  │       │  AgentCore Payments signs x402 USDC tx         │  │
│  │       │  using CDP creds in AgentCore Identity         │  │
│  │       ▼                                                │  │
│  │  200 OK + structured tool result                       │  │
│  └────────────────────────────────────────────────────────┘  │
│  CloudWatch: every paid call logged by AgentCore Payments    │
└──────────────────────────────────────────────────────────────┘
```

No bridging code, no protocol translation — x402 on both ends.

## Why this works without glue

- **AgentCore Payments speaks x402.** Per the AWS docs, AgentCore orchestrates payments using `HTTP 402 Payment Required` (x402) with the `exact` scheme. That's exactly what Agent402 emits.
- **Agent402 is x402 v2 native.** The same paywall middleware that powers `agent402.tools` is what AgentCore expects to negotiate against.
- **CDP is a supported credential provider** in AgentCore Identity. That's the same CDP facilitator Agent402's hosted instance uses — same network (Base), same token (USDC), same `PaymentRequirements` shape.
- **Strands is AgentCore's preferred SDK.** The `agent402-strands` adapter returns native `tool({...})` instances, so a Strands Agent can be deployed straight onto AgentCore with no shape changes.

## See also

- [[Adapters]] — sibling adapters for OpenAI, Anthropic, Vercel AI SDK, LangChain, LlamaIndex
- [[MCP Connector]] — the hosted MCP path used in Option 1
- [[Pay-per-crawl]] — `agent402-tollbooth` deep dive (deploy templates, modes, dashboard)
- [[Paying with x402]] · [[Paying with Compute]] — the two payment paths
- [AWS docs: AgentCore Payments overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html)
- [AWS docs: AgentCore Identity (credential providers)](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html)
- [x402 protocol](https://x402.org) · [Strands Agents](https://strandsagents.com)
