# Agent402 Wiki

**Agent402** is a live node in the machine-to-machine economy: **1,000+ pay-per-call web tools for AI agents** over HTTP. No signup, no API key, no account — an agent calls an endpoint, gets quoted over **HTTP 402**, settles in **USDC on Base** via the [x402 protocol](https://x402.org) (or pays with **CPU proof-of-work** on the eligible tools), retries, and gets the result. The payment *is* the identity.

- **Live service:** https://agent402.tools
- **Machine-readable catalog:** [`/api/pricing`](https://agent402.tools/api/pricing) · [`/openapi.json`](https://agent402.tools/openapi.json) · [`/llms.txt`](https://agent402.tools/llms.txt)
- **Live economy stats (and the revenue wallet):** [`/api/stats`](https://agent402.tools/api/stats)
- **Hosted MCP connector (paste into Claude):** `https://agent402.tools/mcp`

## Start here

| Page | What it covers |
|---|---|
| [[Getting Started]] | Your first call in 60 seconds — free, no wallet |
| [[Paying with x402]] | USDC payments: the 402 flow, code, spend controls, Stripe's `purl` |
| [[Paying with Compute]] | The proof-of-work tier: spec + reference solver |
| [[MCP Connector]] | Hosted connector + the `agent402-mcp` npm server |
| [[Tool Catalog]] | What the ~1,083 tools are and how agents discover them |
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
