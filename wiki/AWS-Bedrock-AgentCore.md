# Agent402 with Amazon Bedrock AgentCore

Amazon Web Services, AWS and Amazon Bedrock AgentCore are trademarks of Amazon.com, Inc. or its affiliates. Agent402 is not affiliated with or endorsed by AWS.

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

[Amazon Bedrock AgentCore Payments](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html) is a fully-managed orchestrator for **x402** - the same protocol [Agent402](https://agent402.tools) speaks natively. Because both speak x402, an AgentCore agent can call Agent402 tools with **no protocol bridging code**: AgentCore handles the wallet and the signing, Agent402 supplies the catalog and serves the 402 challenges.

This page is a 5-minute recipe to wire the two together - buy side (let an AgentCore agent call Agent402 tools) and sell side (charge AgentCore agents that crawl *your* site, using `agent402-tollbooth`).

## The live-proven path: AgentCore Payments plugin

AWS ships an agent-side **Payments plugin** that reads an x402 `402 Payment Required`, authorizes a USDC micropayment from an AgentCore-managed wallet, and retries the request with the payment proof. The agent code holds no keys and no payment logic, and spend is bounded by the Payment Session limit you set. It speaks both **x402 and MPP** - exactly the two wires every Agent402 endpoint serves.

We publish a runnable sample: [`examples/agentcore-x402-buyer`](https://github.com/MikeyPetrillo/Agent402/tree/main/examples/agentcore-x402-buyer). It has a deterministic proof loop (`direct_buy.py`: fetch → 402 → sign → retry → verify the paid sha256 answer) and a Strands-agent showcase (`agent_buy.py`: a web search, then a cited answer, each paid from the wallet), with the full testnet (Base Sepolia faucet) → mainnet (Base USDC) path in its README. Validated live: an AgentCore agent bought `POST /api/hash` from agent402.tools for $0.001, settled on Base mainnet.

> **x402 works with no extra configuration.** The Payments plugin calls sellers with the `python-httpx` User-Agent, and Agent402 answers that client with the x402 offer alone: the `402` carries the `PAYMENT-REQUIRED` header and the full offer in its body, with no `WWW-Authenticate: Payment` challenge, so the plugin pays over x402 in USDC on Base from the same funded wallet.
>
> **To pay over MPP on Tempo,** send the header `X-Payment-Offers: mpp` with the request, hold a Tempo stablecoin the `402` offers on Tempo mainnet (the live list is under `mpp` in [`/.well-known/x402`](https://agent402.tools/.well-known/x402)), and configure the Payments plugin with `network_preferences_config=["tempo:4217", "eip155:4217"]` (Tempo first) and `buyer_pays_gas_fees=True`. The `402` then carries the MPP challenges, Tempo first, exactly as every other client gets them; the sample's [`tempo-mpp-probe/mpp_tempo_buy.py`](https://github.com/MikeyPetrillo/Agent402/tree/main/examples/agentcore-x402-buyer/tempo-mpp-probe) shows the configuration. See [[Paying with MPP]].

> **Where payment happens matters:** AgentCore Gateway cannot pay a 402 on the Gateway→target hop - payment is an agent-side capability. Use Gateway for tool discovery, and the Payments plugin (or the adapters below) for settlement.

## What you get out of the box

- 500+ pay-per-call tools + 80+ multi-tool skill packs from Agent402, callable from an AgentCore-hosted agent
- Free tier with **no wallet** on the pure-CPU tools (proof-of-work through the adapters, or free and rate-limited through the hosted `/mcp` connector)
- USDC settlement for wallet-only tools through the Payments plugin (the live-proven path above)
- A Strands adapter (`agent402-agent-loop-tools`) for embedding a chosen tool subset in a Strands agent

## Option 1: Gateway target (zero code, free tier + discovery)

The fastest path for the free tier. Agent402 exposes a hosted [MCP](https://modelcontextprotocol.io) endpoint at `https://agent402.tools/mcp`; point AgentCore Gateway at it and the catalog shows up in your agent.

1. **Gateway target:** in AgentCore Gateway, add an MCP target with URL `https://agent402.tools/mcp` (auth: none).
2. **Done.** Your agent sees Agent402's flagship-first MCP surface (~15 tools): PDF to markdown, US economic series and current weather, plus render/stock/transcribe/memory, meta tools (`catalog.search`, `catalog.find`, `catalog.call`, `server.describe`, …), and via `catalog.call` the full 500+ tool catalog. The pure-CPU tools run free on the connector (rate-limited per client) - no wallet anywhere.

For **wallet-only (paid) tools**, remember the Gateway cannot settle a 402 on the Gateway→target hop: pay agent-side with the Payments plugin (sample above). A client that speaks x402 or MPP over MCP can also pay wallet-only tools directly on the connector: `/mcp` answers with the x402 PaymentRequired as JSON in the tool result's first text block (payment back in `_meta["x402/payment"]`) and the MPP challenges in `_meta["org.paymentauth/payment-required"]`. See [[MCP Connector]] and [[Paying with MPP]].

> Want to host the catalog yourself instead? Run Agent402 anywhere (`FREE_MODE=false` with `WALLET_ADDRESS` + CDP keys), and point Gateway at `https://your-host/mcp` the same way.

## Option 2: Strands adapter (curated tool subset, embedded in the agent)

When you want to ship a small, curated set of tools rather than the whole catalog - better tool-selection accuracy, smaller token cost. Use [`agent402-agent-loop-tools`](https://www.npmjs.com/package/agent402-agent-loop-tools), the drop-in adapter:

```bash
npm install agent402-agent-loop-tools @strands-agents/sdk zod
```

```ts
import { Agent } from "@strands-agents/sdk";
import { agent402Tools } from "agent402-agent-loop-tools";

// web search, then a cited answer: both wallet-only, paid per call through payFetch,
// an @x402/fetch-wrapped fetch (the Adapters page builds one from a viem account)
const { tools } = await agent402Tools({
  slugs: ["search", "answer"],
  freeOnly: false,
  fetch: payFetch,
});

const agent = new Agent({ tools });
const out = await agent.invoke("Search the web for x402 payment protocol adoption, then answer with citations: what is the x402 payment protocol?");
```

**No wallet yet?** The pure-CPU tools (hash, uuid, base64, markdown-to-html, json-to-csv and more) run free with proof-of-work and no wallet. Leave out `fetch`; the default (`freeOnly: true`) keeps only those tools:

```ts
const { tools } = await agent402Tools({
  slugs: ["hash", "uuid", "json-to-csv"],
});
```

More wallet-only tools (extract, render, screenshot and most of the catalog) go in the same `slugs` list beside `freeOnly: false`.

That's the whole adapter. It has the same shape as the [OpenAI](https://www.npmjs.com/package/agent402-function-calling), [Anthropic](https://www.npmjs.com/package/agent402-tool-use) and [LlamaIndex](https://www.npmjs.com/package/agent402-function-tools) adapters; the [LangChain](https://www.npmjs.com/package/agent402-structured-tools) and [Vercel AI SDK](https://www.npmjs.com/package/agent402-stream-tools) adapters register four meta tools instead (see [[Adapters]]) - pick the one your code already uses.

## Option 3: Sell side - charge AgentCore agents with `agent402-tollbooth`

AgentCore Payments doesn't just spend; it also identifies AI traffic. If you run a site or API, [`agent402-tollbooth`](https://www.npmjs.com/package/agent402-tollbooth) is an open-source pay-per-crawl gate that fits the other half of the loop. With an x402 settlement middleware wired in, an agent pays it the same way it pays anything else over x402.

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

As written, the gate offers the free proof-of-work rail and quotes the USDC price, but settles no USDC: to accept payment from a stock x402 client, pass an `@x402/express` `paymentMiddleware(...)` as the `x402` option (it owns verify and settle; see [[Pay-per-crawl]]).

The exported factory is **`createTollbooth`** (there is no `tollbooth` export), and the options are **`payTo`** and **`price`** (not `walletAddress` / `pricePerRequest`).

`observe` is a **boolean** and is independent of `mode`: leave `observe: true` to classify and count without ever returning a 402, then remove it and pick a `mode`. `mode` is `bots` (default, charges the `AI_BOTS` user-agents), `strict` (charges anything that is not a real-browser request, i.e. no `Mozilla/5.0` UA plus `text/html` Accept), or `all` (charges every client, browsers included). `mode: "observe"` is not valid and would leave you charging on the `bots` default.

Adaptive proof-of-work means cash-poor agents can still pay in CPU. Edge-deployable to Cloudflare Workers and Next.js middleware. As Express middleware the gate registers **no routes**, so read counters from `gate.stats()` / `gate.snapshot()` and serve them yourself. Run the package as a reverse proxy instead (`TOLLBOOTH_UPSTREAM=… npx agent402-tollbooth`) and you get `/__tollbooth` plus `/__tollbooth/stats`, authed with `Authorization: Bearer <TOLLBOOTH_ADMIN_TOKEN>` or `X-Admin-Token`, never a `?token=` query string.


## How the request flow looks (Option 2)

```
┌──────────────────────────────────────────────────────────────┐
│  AgentCore Runtime                                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Strands Agent  (your code, agent402-agent-loop-tools wired in) │  │
│  │       │                                                │  │
│  │       │ tool.callback({...})                           │  │
│  │       ▼                                                │  │
│  │  agent402-client  ──── HTTP ────► agent402.tools       │  │
│  │       │  402 Payment Required                          │  │
│  │       │  ◄────────────────────────                     │  │
│  │       │                                                │  │
│  │       │  proof-of-work (free tier)                     │  │
│  │       │  ── OR ──                                      │  │
│  │       │  the x402 fetch you passed signs the USDC      │  │
│  │       │  payment and retries                           │  │
│  │       ▼                                                │  │
│  │  200 OK + structured tool result                       │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

No bridging code, no protocol translation - x402 on both ends.

## Why this works without glue

- **AgentCore Payments speaks x402.** Per the AWS docs, AgentCore orchestrates payments using `HTTP 402 Payment Required` (x402) with the `exact` scheme. That's exactly what Agent402 emits.
- **Agent402 is x402 v2 native.** Agent402 serves x402 v2, the protocol AgentCore Payments pays.
- **The `agent402-agent-loop-tools` adapter returns native Strands `tool({...})` instances**, so a Strands Agent built with it needs no shape changes.

## See also

- [`examples/agentcore-x402-buyer`](https://github.com/MikeyPetrillo/Agent402/tree/main/examples/agentcore-x402-buyer) - the live-proven Payments-plugin buyer sample
- [[Adapters]] - sibling adapters for OpenAI, Anthropic, Vercel AI SDK, LangChain, LlamaIndex
- [[MCP Connector]] - the hosted MCP path used in Option 1
- [[Pay-per-crawl]] - `agent402-tollbooth` deep dive (deploy templates, modes, dashboard)
- [[Paying with x402]] · [[Paying with Compute]] - the two payment paths
- [AWS docs: AgentCore Payments overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html)
- [AWS docs: AgentCore Identity (credential providers)](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html)
- [x402 protocol](https://x402.org) · [Strands Agents](https://strandsagents.com)
