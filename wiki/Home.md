# Agent402 Wiki

**Agent402** is an **open-source, self-hostable MCP server + HTTP API with 1,214 ready-to-use tools and 39 multi-tool skill packs for AI agents** — browser rendering, web search, PDFs, OCR, images, live data, crypto/payments helpers, ~1,000 pure-CPU utilities, plus curated workflows ([[Skill Packs|Skill-Packs]]) for jobs no single tool covers. Clone it and run everything free in 30 seconds (no wallet, no signup), or use the hosted instance. Optionally, the same server can charge per call over the [x402 protocol](https://x402.org) (USDC on Base) — that part is opt-in; by default everything runs free.

It's also **the open x402 index**: a single integration gives a buyer three primitives over the whole ecosystem — **Find** ([`/api/find`](https://agent402.tools/api/find), resolve a task to a tool), **Route** ([`/api/route`](https://agent402.tools/api/route), the neutral [[x402 Index and Smart Order Router|x402-Index-and-Router]] across every seller crawled from the [Coinbase CDP Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar)), and **Leaderboard** ([`/api/leaderboard`](https://agent402.tools/api/leaderboard), the [[x402 Leaderboard]] — public on-chain ranking of every seller by Base USDC settled volume). All three are free and unpaywalled — discovery primitives shouldn't cost money.

- **Run it yourself (free):** `git clone … && npm install && FREE_MODE=true npm start` — see [[Getting Started]]
- **Live hosted demo:** https://agent402.tools · **MCP connector (paste into Claude):** `https://agent402.tools/mcp`
- **Add your own tool:** a few lines in `src/tools/` — see [CONTRIBUTING](https://github.com/MikeyPetrillo/Agent402/blob/main/CONTRIBUTING.md)
- **The other side of x402** — charge AI bots crawling *your* site with the open-source pay-per-crawl gate: see [[Pay-per-crawl]]
- **Machine-readable catalog:** [`/api/pricing`](https://agent402.tools/api/pricing) · [`/openapi.json`](https://agent402.tools/openapi.json) · [`/llms.txt`](https://agent402.tools/llms.txt)
- **Live stats (hosted instance):** [`/api/stats`](https://agent402.tools/api/stats) · [`/analytics`](https://agent402.tools/analytics) (cache-hit %, p50/p95 latency, error rate)
- **Performance surfaces:** [`/api/cache-stats`](https://agent402.tools/api/cache-stats) (Redis hit-rate counters) · [`/api/cacheable`](https://agent402.tools/api/cacheable) (which routes cache + TTL) · [`/api/analytics`](https://agent402.tools/api/analytics) (24h tool-call timeseries)

## Start here

| Page | What it covers |
|---|---|
| [[Getting Started]] | Your first call in 60 seconds — free, no wallet |
| [[Paying with x402]] | USDC payments: the 402 flow, code, spend controls, Stripe's `purl` |
| [[Paying with Compute]] | The proof-of-work tier: spec + reference solver |
| [[MCP Connector]] | Hosted connector + the `agent402-mcp` npm server |
| [[Adapters]] | Drop-in tools for OpenAI / Anthropic / AI SDK / LangChain / LlamaIndex |
| [[Tool Catalog]] | What the 1,214 tools are and how agents discover them |
| [[Skill-Packs]] | 39 multi-tool workflows — `prompts/list` → `prompts/get`, ready-to-run plans |
| [[x402-Index-and-Router]] | The cross-seller index + Smart Order Router (cheapest healthy tool across the ecosystem) |
| [[x402-Leaderboard]] | Public on-chain ranking of every x402 seller by Base USDC settled volume |
| [[Payments and x402]] | Non-custodial multi-chain payment toolkit: quote, verify, balance, gas, transfer-auth, ENS |
| [[Pay-per-crawl]] | `agent402-tollbooth`: charge AI crawlers to access your site (USDC via x402 or proof-of-work) |
| [[Memory and Coordination]] | Durable wallet-keyed state, cross-wallet grants, audit log |
| [[Architecture]] | How the server, paywall, and facilitators fit together |
| [[Security Model]] | SSRF defense, PoW scoping, what's wallet-only and why |
| [[Operations]] | CI pipeline, heartbeat watchdog, deploys, persistence |
| [[FAQ]] | The short answers |

## The one-line pitch per audience

- **An agent, mid-task:** every capability here needs only what you already hold — a wallet or a CPU. `GET https://agent402.tools/llms.txt` and go.
- **An agent developer:** one x402-wrapped fetch (or one MCP server) buys browser rendering, live search, PDFs, durable memory, ~1,000 utilities, and 39 curated multi-tool workflows ([[Skill Packs|Skill-Packs]]) at $0.001–$0.02/call, deterministic, no LLM in the serving path.
- **A skeptic:** the whole server is open source, every endpoint is re-tested against its own documented example before every deploy, and revenue settles on-chain to **`agent402.base.eth`** (a Base name resolving to the public receiving wallet) — [verify on Basescan](https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns).

> This wiki is generated from the [`wiki/`](https://github.com/MikeyPetrillo/Agent402/tree/HEAD/wiki) directory of the main repo and synced by CI — edit there, not here.
