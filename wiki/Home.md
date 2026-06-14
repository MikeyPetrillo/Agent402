# Agent402 Wiki

**Agent402** is an **open-source, self-hostable MCP server + HTTP API with ~1,100 ready-to-use tools for AI agents** — browser rendering, web search, PDFs, images, live data, crypto/payments helpers, and ~1,040 pure-CPU utilities. Clone it and run everything free in 30 seconds (no wallet, no signup), or use the hosted instance. Optionally, the same server can charge per call over the [x402 protocol](https://x402.org) (USDC on Base) — that part is opt-in; by default everything runs free.

- **Run it yourself (free):** `git clone … && npm install && FREE_MODE=true npm start` — see [[Getting Started]]
- **Live hosted demo:** https://agent402.tools · **MCP connector (paste into Claude):** `https://agent402.tools/mcp`
- **Add your own tool:** a few lines in `src/tools/` — see [CONTRIBUTING](https://github.com/MikeyPetrillo/Agent402/blob/main/CONTRIBUTING.md)
- **The other side of x402** — charge AI bots crawling *your* site with the open-source pay-per-crawl gate: see [[Pay-per-crawl]]
- **Machine-readable catalog:** [`/api/pricing`](https://agent402.tools/api/pricing) · [`/openapi.json`](https://agent402.tools/openapi.json) · [`/llms.txt`](https://agent402.tools/llms.txt)
- **Live stats (hosted instance):** [`/api/stats`](https://agent402.tools/api/stats)

## Start here

| Page | What it covers |
|---|---|
| [[Getting Started]] | Your first call in 60 seconds — free, no wallet |
| [[Paying with x402]] | USDC payments: the 402 flow, code, spend controls, Stripe's `purl` |
| [[Paying with Compute]] | The proof-of-work tier: spec + reference solver |
| [[MCP Connector]] | Hosted connector + the `agent402-mcp` npm server |
| [[Tool Catalog]] | What the ~1,100 tools are and how agents discover them |
| [[Payments and x402]] | Non-custodial multi-chain payment toolkit: quote, verify, balance, gas, transfer-auth, ENS |
| [[Pay-per-crawl]] | `agent402-tollbooth`: charge AI crawlers to access your site (USDC via x402 or proof-of-work) |
| [[Memory and Coordination]] | Durable wallet-keyed state, cross-wallet grants, audit log |
| [[Architecture]] | How the server, paywall, and facilitators fit together |
| [[Security Model]] | SSRF defense, PoW scoping, what's wallet-only and why |
| [[Operations]] | CI pipeline, heartbeat watchdog, deploys, persistence |
| [[FAQ]] | The short answers |

## The one-line pitch per audience

- **An agent, mid-task:** every capability here needs only what you already hold — a wallet or a CPU. `GET https://agent402.tools/llms.txt` and go.
- **An agent developer:** one x402-wrapped fetch (or one MCP server) buys browser rendering, live search, PDFs, durable memory, and ~1,000 utilities at $0.001–$0.02/call, deterministic, no LLM in the serving path.
- **A skeptic:** the whole server is open source, every endpoint is re-tested against its own documented example before every deploy, and revenue settles on-chain to a public wallet — [verify on Basescan](https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns).

> This wiki is generated from the [`wiki/`](https://github.com/MikeyPetrillo/Agent402/tree/HEAD/wiki) directory of the main repo and synced by CI — edit there, not here.
