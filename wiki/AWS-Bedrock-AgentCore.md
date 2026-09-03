# AWS Bedrock AgentCore

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

[AWS Bedrock AgentCore Payments](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html) is a fully-managed orchestrator for **x402** - the same protocol [Agent402](https://agent402.tools) speaks natively. That means Agent402 snaps into AgentCore as a first-class tool source with **no protocol bridging code**: AgentCore handles the wallet and the signing, Agent402 supplies the catalog and serves the 402 challenges.

This page is a 5-minute recipe to wire the two together - buy side (let an AgentCore agent call Agent402 tools) and sell side (charge AgentCore agents that crawl *your* site, using `agent402-tollbooth`).

## The live-proven path: AgentCore Payments plugin

AWS ships an agent-side **Payments plugin** (built with Coinbase and Stripe) that reads an x402 `402 Payment Required`, authorizes a USDC micropayment from an AgentCore-managed wallet, and retries the request with the payment proof. The agent code holds no keys and no payment logic, and spend is bounded by the Payment Session limit you set. It speaks both **x402 and MPP** - exactly the two wires every Agent402 endpoint serves.

We publish a runnable sample: [`examples/agentcore-x402-buyer`](https://github.com/MikeyPetrillo/Agent402/tree/main/examples/agentcore-x402-buyer). It has a deterministic proof loop (`direct_buy.py`: fetch → 402 → sign → retry → verify the paid sha256 answer) and a Strands-agent showcase (`agent_buy.py`), with the full testnet (Base Sepolia faucet) → mainnet (Base USDC) path in its README. Validated live: an AgentCore agent bought `POST /api/hash` from agent402.tools for $0.001, settled on Base mainnet.

> **On Base, buys settle over x402, and that is handled for you.** AgentCore Payments signs the MPP `evm` path under EIP-712 domain name `"USDC"`, while Base USDC's contract domain is `"USD Coin"`, so that signature cannot verify on Base (reported upstream as [awslabs/agentcore-samples#2002](https://github.com/awslabs/agentcore-samples/issues/2002)). The same instrument settles our x402 path perfectly. Agent402 recognises the mismatch from the credential itself, answers with an RFC 9457 problem naming both domain names, and withholds the MPP challenge briefly so the Payments plugin falls through to the x402 offer in the same `402`. Nothing to configure: your buy goes through on x402. See [[Paying with MPP]] for the signing rule.

> **Where payment happens matters:** AgentCore Gateway cannot pay a 402 on the Gateway→target hop - payment is an agent-side capability. Use Gateway for tool discovery, and the Payments plugin (or the adapters below) for settlement.

## What you get out of the box

- 500+ pay-per-call tools + 70+ multi-tool skill packs from Agent402, callable from an AgentCore-hosted agent
- Free tier with **no wallet** (proof-of-work; AgentCore Identity is optional for that path)
- USDC-on-Base settlement for wallet-only tools, via AgentCore's `PaymentCredentialProvider` + CDP
- CloudWatch observability for every payment (AgentCore handles this)
- Strands SDK as the agent framework - AgentCore's preferred Python/TS surface

## Option 1: Gateway target (zero code, free tier + discovery)

The fastest path for the free tier. Agent402 exposes a hosted [MCP](https://modelcontextprotocol.io) endpoint at `https://agent402.tools/mcp`; point AgentCore Gateway at it and the catalog shows up in your agent.

1. **Gateway target:** in AgentCore Gateway, add an MCP target with URL `https://agent402.tools/mcp` (auth: none).
2. **Done.** Your agent sees Agent402's flagship-first MCP surface (~15 tools): `web.search` / `web.answer` as the front door, plus news/render/stock/transcribe/memory, meta tools (`catalog.search`, `catalog.find`, `catalog.call`, `server.describe`, …), and via `catalog.call` the full 500+ tool catalog. Free tools pay automatically via proof-of-work in the request path - no wallet anywhere.

For **wallet-only (paid) tools**, remember the Gateway cannot settle a 402 on the Gateway→target hop: pay agent-side with the Payments plugin (sample above). MPP-speaking clients can also pay wallet-only tools directly on the connector - `/mcp` serves native MPP challenges (JSON-RPC error `-32042`) - see [[Paying with MPP]].

> Want to host the catalog yourself instead? Run Agent402 anywhere (`FREE_MODE=false` with `WALLET_ADDRESS` + CDP keys), and point Gateway at `https://your-host/mcp` the same way.

## Option 2: Strands adapter (curated tool subset, embedded in the agent)

When you want to ship a small, curated set of tools rather than the whole catalog - better tool-selection accuracy, smaller token cost. Use [`agent402-strands`](https://www.npmjs.com/package/agent402-strands), the drop-in adapter:

```bash
npm install agent402-strands @strands-agents/sdk zod
```

```ts
import { Agent } from "@strands-agents/sdk";
import { agent402Tools } from "agent402-strands";

// AgentCore deploys this exact Strands Agent - no extra glue.
const { tools } = await agent402Tools({
  slugs: ["extract", "hash", "render", "screenshot"],
});

const agent = new Agent({ tools });
const out = await agent.invoke("Extract the article at https://example.com/post");
```

Free-tier tools (150+ of them) pay automatically via proof-of-work - **no wallet required**. For the wallet-only tools (most of the catalog), pass an `@x402/fetch`-wrapped `fetch`; AgentCore Payments signs with the CDP-backed key in Identity, so you never see private keys in your code.

```ts
const { tools } = await agent402Tools({
  freeOnly: false,
  fetch: agentcoreX402Fetch,    // the wrapper AgentCore Payments hands you
});
```

That's the whole adapter. Same shape as the sibling adapters ([OpenAI](https://www.npmjs.com/package/agent402-openai-tools), [Anthropic](https://www.npmjs.com/package/agent402-anthropic-tools), [LangChain](https://www.npmjs.com/package/agent402-langchain), [LlamaIndex](https://www.npmjs.com/package/agent402-llamaindex), [Vercel AI SDK](https://www.npmjs.com/package/agent402-ai-sdk)) - pick the one your code already uses.

## Option 3: Sell side - charge AgentCore agents with `agent402-tollbooth`

AgentCore Payments doesn't just spend; it also identifies AI traffic. If you run a site or API, [`agent402-tollbooth`](https://www.npmjs.com/package/agent402-tollbooth) is an open-source pay-per-crawl gate that fits the other half of the loop. AgentCore-hosted agents pay it the same way they pay anything else over x402.

```js
// Express app - humans browse free, AgentCore-hosted (and any other) AI agents pay per request.
import express from "express";
import { createTollbooth } from "agent402-tollbooth";

const app = express();
const gate = createTollbooth({
  payTo: "0xYourWallet",               // where USDC lands
  network: "base",
  price: "$0.001",
  observe: true,                       // safe default; delete it, then set mode, when ready
  // mode: "bots",                     // bots | all | strict (default: bots)
});
app.get("/__stats", (_req, res) => res.json(gate.stats()));  // gate this with a token
app.use(gate);
app.get("/", (_req, res) => res.send("hello"));
app.listen(3000);
```

The exported factory is **`createTollbooth`** (there is no `tollbooth` export), and the options are **`payTo`** and **`price`** (not `walletAddress` / `pricePerRequest`).

`observe` is a **boolean** and is independent of `mode`: leave `observe: true` to classify and count without ever returning a 402, then remove it and pick a `mode`. `mode` is `bots` (default, charges the `AI_BOTS` user-agents), `strict` (charges anything that is not a real-browser request, i.e. no `Mozilla/5.0` UA plus `text/html` Accept), or `all` (charges every client, browsers included). `mode: "observe"` is not valid and would leave you charging on the `bots` default.

Adaptive proof-of-work means cash-poor agents can still pay in CPU. Edge-deployable to Cloudflare Workers and Next.js middleware. As Express middleware the gate registers **no routes**, so read counters from `gate.stats()` / `gate.snapshot()` and serve them yourself. Run the package as a reverse proxy instead (`TOLLBOOTH_UPSTREAM=… npx agent402-tollbooth`) and you get `/__tollbooth` plus `/__tollbooth/stats`, authed with `Authorization: Bearer <TOLLBOOTH_ADMIN_TOKEN>` or `X-Admin-Token`, never a `?token=` query string.

This is one of the few public open-source gates that AgentCore agents can pay end-to-end today.

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

No bridging code, no protocol translation - x402 on both ends.

## Why this works without glue

- **AgentCore Payments speaks x402.** Per the AWS docs, AgentCore orchestrates payments using `HTTP 402 Payment Required` (x402) with the `exact` scheme. That's exactly what Agent402 emits.
- **Agent402 is x402 v2 native.** The same paywall middleware that powers `agent402.tools` is what AgentCore expects to negotiate against.
- **CDP is a supported credential provider** in AgentCore Identity. That's the same CDP facilitator Agent402's hosted instance uses - same network (Base), same token (USDC), same `PaymentRequirements` shape.
- **Strands is AgentCore's preferred SDK.** The `agent402-strands` adapter returns native `tool({...})` instances, so a Strands Agent can be deployed straight onto AgentCore with no shape changes.

## See also

- [`examples/agentcore-x402-buyer`](https://github.com/MikeyPetrillo/Agent402/tree/main/examples/agentcore-x402-buyer) - the live-proven Payments-plugin buyer sample
- [[Adapters]] - sibling adapters for OpenAI, Anthropic, Vercel AI SDK, LangChain, LlamaIndex
- [[MCP Connector]] - the hosted MCP path used in Option 1
- [[Pay-per-crawl]] - `agent402-tollbooth` deep dive (deploy templates, modes, dashboard)
- [[Paying with x402]] · [[Paying with Compute]] - the two payment paths
- [AWS docs: AgentCore Payments overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html)
- [AWS docs: AgentCore Identity (credential providers)](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html)
- [x402 protocol](https://x402.org) · [Strands Agents](https://strandsagents.com)
