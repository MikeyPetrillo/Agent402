# Getting Started

You can make your first call in under a minute, with no wallet and no money.

## 1. Discover the catalog (free)

```bash
curl https://agent402.tools/api/pricing      # every endpoint, price, category
curl https://agent402.tools/openapi.json     # full OpenAPI 3.1 with schemas
curl https://agent402.tools/llms.txt         # the agent-oriented overview
curl https://agent402.tools/api/find?q=ocr   # resolve a task to the best tool
curl -X POST https://agent402.tools/api/route -H 'content-type: application/json' \
     -d '{"query":"ocr image","top":5,"include":"external"}'   # cross-seller Smart Order Router
curl 'https://agent402.tools/api/leaderboard?top=10'           # on-chain ranking by Base USDC volume
```

Each tool also has human-readable docs at `https://agent402.tools/tools/{slug}` with a working example.

## 2. See the paywall

Call any paid tool without paying and you get an HTTP **402** with exact payment requirements:

```bash
curl -i -X POST https://agent402.tools/api/hash \
  -H 'Content-Type: application/json' -d '{"text":"hello"}'
# HTTP/2 402 … {"x402Version":2,"accepts":[{ price, network, payTo, … }]}
# X-Pow-Challenge: https://agent402.tools/api/pow/challenge?slug=hash   ← the free option
```

## 3. Run the full loop, free (proof-of-work)

The zero-dependency demo discovers the catalog, gets quoted, pays with ~0.2s of CPU, and uses the result:

```bash
curl -s https://agent402.tools/demo.js -o demo.js && node demo.js
```

To settle in real USDC instead, fund a wallet on Base and run `AGENT_KEY=0xYOUR_KEY node demo.js` (after `npm i @x402/core @x402/evm @x402/fetch viem`).

## 4. Pick your integration

| You are… | Use |
|---|---|
| A Claude user | Paste `https://agent402.tools/mcp` into Settings → Connectors — see [[MCP Connector]] |
| A Cursor / ChatGPT (Pro+) / VS Code Copilot user | Paste the same URL into the MCP connector settings — see [[MCP Connector]] |
| An MCP-based agent | `npx -y agent402-mcp` with optional `AGENT_KEY` — see [[MCP Connector]] |
| On OpenAI / Anthropic / Vercel AI SDK / LangChain / LlamaIndex | One of the framework adapter packages — see [[Adapters]] |
| Calling over HTTP with a wallet | One x402-wrapped fetch — see [[Paying with x402]] |
| Wallet-less / sandboxed | Proof-of-work on ~1,105 tools — see [[Paying with Compute]] |

## What things cost

Flat per-call prices from **$0.001** (utilities, conversions) to **$0.02** (browser rendering, audio transcode). No tiers, no subscriptions, no rate-limit plans — every call settles on-chain in seconds and the next one is independent. Prices are in the catalog and in every 402 response.
