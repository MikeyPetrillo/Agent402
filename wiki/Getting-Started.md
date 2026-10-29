# Getting Started

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

You can make your first call in under a minute, with no wallet and no money.

## 1. Discover the catalog (free)

```bash
curl https://agent402.tools/api/pricing      # every endpoint, price, category
curl https://agent402.tools/openapi.json     # full OpenAPI 3.1 with schemas
curl https://agent402.tools/llms.txt         # the agent-oriented overview
curl 'https://agent402.tools/api/find?q=ocr' # resolve a task to the best tool
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

One file, no install for the free run: the demo discovers the catalog, gets quoted, pays with a fraction of a second of CPU, and uses the result:

```bash
curl -s https://agent402.tools/demo.js -o demo.js && node demo.js
```

To settle in real USDC instead, fund a new EVM wallet on Base (**Use a new wallet holding only a few dollars of USDC. Never your main wallet.**), run `npm i @x402/core @x402/evm @x402/fetch viem` in the same folder as `demo.js`, then `AGENT_KEY=0xYOUR_KEY node demo.js`.

## 4. Pick your integration

| You are… | Use |
|---|---|
| A Claude user | Paste `https://agent402.tools/mcp` into Settings → Connectors - see [[MCP Connector]] |
| A Cursor, VS Code, Windsurf, Cline, Codex or Gemini CLI user | Each host's config block is in the [agent-hosts guide](https://agent402.tools/guides/agent-hosts) - see also [[MCP Connector]] |
| An MCP-based agent | `npx -y agent402-mcp@0.13.23` with optional `AGENT_KEY` - see [[MCP Connector]] |
| On OpenAI / Anthropic / Vercel AI SDK / LangChain / LlamaIndex | One of the framework adapter packages - see [[Adapters]] |
| Calling over HTTP with a wallet | One x402-wrapped fetch - see [[Paying with x402]] |
| Wallet-less / sandboxed | Proof-of-work on 150+ pure-CPU tools - see [[Paying with Compute]] |
| Have a card, no wallet | Buy a finished report by card at [`/reports`](https://agent402.tools/reports). A prepaid credits key ([`/credits`](https://agent402.tools/credits) says whether packs are on sale) pays Agent402's own paid routes with `Authorization: Bearer a402_…`, except the wallet-identity-bound ones and the routes that buy from an outside seller, and `agent402-mcp` and `agent402-client` take the same key - see [[Reports and Monitors|Reports-and-Monitors]] |
| A person who wants one finished report | Buy it by card at [`/reports`](https://agent402.tools/reports), or a monthly monitor at [`/monitors`](https://agent402.tools/monitors) - see [[Reports and Monitors|Reports-and-Monitors]] |

## What things cost

Flat per-call prices from **$0.001** (utilities, conversions); most tools are **$0.001 to $0.02** (e.g. browser rendering), with premium AI, media, and multi-tool skill packs priced higher. Report products (research, dossier, ticker pack, fund, SEC filing, domain audit, recall, insider flow, token brief, token risk, LinkedIn article, IPO digest) are priced per outcome over x402 or MPP, and by card at [`/reports`](https://agent402.tools/reports), where the card price includes payment processing; monitors are billed monthly per target. The one exception to flat pricing is the LLM gateway's metered tier (`/v1/metered/*`), where the 402 quotes each request from its own body (see [[LLM Gateway (OpenAI /v1)|LLM-Gateway]]). No tiers, no rate-limit plans - every call settles in seconds and the next one is independent. Prices are in the catalog and in every 402 response.
