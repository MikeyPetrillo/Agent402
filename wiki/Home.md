# Agent402.Tools Wiki

**Agent402.Tools** is the applied layer of **Agentic Finance** - agents that pay and get paid on their own over x402 and MPP (see [[Agentic Finance]]) - shipped as an **open-source, self-hostable MCP server + HTTP API with 500+ ready-to-use tools and 70+ multi-tool skill packs for AI agents** - browser rendering, web search, PDFs, OCR, image and video generation, live data, crypto derivatives and DeFi and Solana token intel, crypto/payments helpers, 150+ pure-CPU utilities, plus curated workflows ([[Skill Packs|Skill-Packs]]) for jobs no single tool covers. Clone it and run it free with `FREE_MODE=true` (no wallet, no signup; a tool that calls a keyed upstream answers `503` until you add that provider's key), or use the hosted instance. Optionally, the same server can charge per call over the [x402 protocol](https://x402.org) (USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar & Algorand - plus USDG on Robinhood Chain) **and over MPP** (the Machine Payments Protocol `Payment` HTTP auth scheme: USDC on Base and Celo, USDC.e or PathUSD natively on Tempo, and cards over MPP through Stripe on routes from $0.50) - both wires on the same 402, both opt-in; by default everything runs free. See [[Paying with MPP]]. Beside the per-call tools it sells **outcome-priced reports** (research, due-diligence dossiers, 13F fund reports, SEC filing reports, domain audits, FDA recall, insider flow, token risk, a publish-ready LinkedIn article package - priced per report over x402 or MPP, or by card), **monthly monitors** that re-run a report when something changes, and **prepaid card credits** (not on sale at the moment; keys already issued keep spending on every tool except the wallet-identity-bound ones) - see [[Reports, Monitors and Credits|Reports-and-Monitors]].

> **Every entry earns its place** - every tool outside the metered set (the model tiers, keyed search and the report products, which CI cannot call without spending upstream) is tested against its own example on every CI run, and every entry is priced to market. CI holds a 400-entry catalog floor and verifies the “500+” claim against the running server (`scripts/sync-count.js --check`).

It's also **the open x402 index**: a single integration gives a buyer three primitives over the whole ecosystem - **Find** ([`/api/find`](https://agent402.tools/api/find), resolve a task to a tool), **Route** ([`/api/route`](https://agent402.tools/api/route), the neutral [[x402 Index and Smart Order Router|x402-Index-and-Router]] across every seller crawled from the [Coinbase CDP Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar)), and **Leaderboard** ([`/api/leaderboard`](https://agent402.tools/api/leaderboard), the [[x402 Leaderboard]] - public on-chain ranking of sellers by Base USDC settled volume, served top-N with `totalSellers` for the full count). All three are free and unpaywalled - discovery primitives shouldn't cost money.

- **Run it yourself (free):** `git clone … && npm install && FREE_MODE=true npm start` - see [[Getting Started]]
- **Live hosted demo:** https://agent402.tools · **MCP connector (paste into Claude):** `https://agent402.tools/mcp`
- **For people (card, no wallet):** [`/reports`](https://agent402.tools/reports) one-off reports · [`/monitors`](https://agent402.tools/monitors) monthly watches · [`/credits`](https://agent402.tools/credits) prepaid credits (not on sale at the moment; keys already issued keep working) - see [[Reports, Monitors and Credits|Reports-and-Monitors]]
- **Market intel per call:** live perpetuals and options, DeFi yields and TVL, stablecoin supply, Solana token safety and risk reports, crypto news and computed indicators, indexed EVM chain reads, Farcaster social, and whole-site crawling - most of them keyless (the indexed EVM reads and Farcaster tools run on the operator's provider keys), see [[Tool Catalog]]
- **Images and video:** flat-price generation on the OpenAI wire (`/v1/images/fast`, `/v1/images/pro`, `/v1/images/generations`, `/v1/videos/generations`) - priced per picture or per clip, not per token
- **Add your own tool:** a few lines in `src/tools/` - see [CONTRIBUTING](https://github.com/MikeyPetrillo/Agent402/blob/main/CONTRIBUTING.md)
- **The other side of x402** - charge AI bots crawling *your* site with the open-source pay-per-crawl gate: see [[Pay-per-crawl]]
- **Machine-readable catalog:** [`/api/pricing`](https://agent402.tools/api/pricing) · [`/openapi.json`](https://agent402.tools/openapi.json) · [`/llms.txt`](https://agent402.tools/llms.txt)
- **Developer experience:** [Quickstart](https://agent402.tools/quickstart) · [Playground](https://agent402.tools/playground) · [SDK REPL](https://agent402.tools/sdk-playground) · [API Explorer](https://agent402.tools/docs/api/explorer) · [Adapter Docs](https://agent402.tools/docs/adapters) · [Workflows](https://agent402.tools/workflows)
- **Live stats (hosted instance):** [`/api/stats`](https://agent402.tools/api/stats) · [`/status`](https://agent402.tools/status) (measured availability)
- **Performance surfaces:** [`/api/cache-stats`](https://agent402.tools/api/cache-stats) (Redis hit-rate counters) · [`/api/cacheable`](https://agent402.tools/api/cacheable) (which routes cache + TTL) · [`/api/analytics`](https://agent402.tools/api/analytics) (24h tool-call timeseries)
- **Community:** [Blog](https://agent402.tools/blog) · [Community](https://agent402.tools/community) · [Contribute](https://agent402.tools/contribute) · [Changelog](https://agent402.tools/changelog) · [Badges](https://agent402.tools/badges)

## Start here

| Page | What it covers |
|---|---|
| [[Agentic Finance]] | What Agentic Finance is, the stack, and where Agent402 sits |
| [[Why Pay Here|Why-Pay-Here]] | Seven things that are different about paying here, each linked to the surface that proves it |
| [[Getting Started]] | Your first call in 60 seconds - free, no wallet |
| [[Reports, Monitors and Credits|Reports-and-Monitors]] | Outcome-priced report products (`/v1/research`, `/v1/dossier`, `/v1/ticker-pack`, `/v1/fund`, `/v1/filing-report`, `/v1/domain-audit`, `/v1/recall-report`, `/v1/insider-report`, `/v1/token-brief`, `/v1/token-risk`, `/v1/linkedin-article`, `/v1/ipo-report`), the card front door (`/reports`, `/monitors`), and prepaid credits (`/credits`, `Authorization: Bearer a402_…`; not on sale at the moment, keys already issued keep working) |
| [[Paying with x402]] | USDC payments: the 402 flow, code, spend controls, Stripe's `purl` |
| [[Paying with MPP]] | The Machine Payments Protocol wire: `WWW-Authenticate: Payment`, mppx clients, Base/Celo, native Tempo settlement, cards over MPP, native MPP on the `/mcp` connector |
| [[Paying with Compute]] | The proof-of-work tier: spec + reference solver |
| [[MCP Connector]] | Hosted connector (dotted tools: `catalog.find`, `catalog.call`, `web.search`, …, payable over MPP in the call) + the `agent402-mcp` npm server (wallet or prepaid credits) |
| [[Adapters]] | Drop-in tools for OpenAI / Anthropic / AI SDK / LangChain / LlamaIndex |
| [[Decide]] | Describe a job in plain language; get a call-ready plan over this catalog and outside x402 sellers, run it yourself or through Agent402 |
| [[Tool Catalog]] | What the 500+ tools are and how agents discover them |
| [[Skill-Packs]] | 70+ multi-tool workflows - `prompts/list` → `prompts/get`, ready-to-run plans |
| [[x402-Index-and-Router]] | The cross-seller index + Smart Order Router (cheapest healthy tool across the ecosystem) |
| [[x402-Leaderboard]] | Public on-chain ranking of x402 sellers by Base USDC settled volume, served as the top N |
| [[LLM Gateway (OpenAI /v1)|LLM-Gateway]] | OpenAI-compatible chat, embeddings, rerank, images, video and speech at `/v1` (plus the Anthropic Messages and OpenAI Responses wires) - flat chat tiers from $0.003 per call, a metered tier whose 402 quotes each request from its body, embeddings and rerank from $0.002, model-optional auto-routing, streaming, response caching; any OpenAI SDK adopts it by changing `base_url` |
| [[LLM Proxy Gateway|LLM-Proxy]] | Three tiers of OpenAI inference via x402 - GPT-4o-mini, GPT-4o/4.1, o3/o3-mini |
| [[Image Generation Gateway|Image-Gen]] | Three tiers of GPT Image generation via x402 - text-to-image, no API key needed |
| [[Code Execution Sandbox|Code-Execution]] | Sandboxed Python/JS execution via E2B - isolated cloud VMs, pay per run |
| [[Text-to-Speech|TTS]] | Convert text to speech - three tiers, 10 voices, up to 6 formats depending on tier, pay per call |
| [[Speech-to-Text|STT]] | Transcribe audio to text via OpenAI - URL-based input, multi-language |
| [[Text Embeddings|Embeddings]] | Generate embedding vectors via OpenAI - 1536/3072 dimensions for RAG and search |
| [[Payments and x402]] | Non-custodial multi-chain payment toolkit: quote, verify, balance, gas, transfer-auth, ENS |
| [[Pay-per-crawl]] | `agent402-tollbooth`: charge AI crawlers to access your site (USDC via x402 or MPP, native MPP on Tempo with split payments, or proof-of-work) |
| [[Memory and Coordination]] | Durable wallet-keyed state, cross-wallet grants, audit log |
| [[Architecture]] | How the server, paywall, and facilitators fit together |
| [[Security Model]] | SSRF defense, PoW scoping, what's wallet-only and why |
| [[Operations]] | CI pipeline, heartbeat watchdog, deploys, persistence |
| [[Self-Hosting]] | Run Agent402 on your own infrastructure |
| [[API-Reference]] | Complete HTTP endpoint reference - discovery, tools, payments |
| [[FAQ]] | The short answers |

## The one-line pitch per audience

- **An agent, mid-task:** every capability here needs only what you already hold - a wallet, a prepaid credits key already issued, or a CPU (proof-of-work covers the pure-CPU tools). `GET https://agent402.tools/llms.txt` and go.
- **A person who needs one answer:** buy a finished report by card at [`/reports`](https://agent402.tools/reports), or a monitor that emails you when a filing, recall or certificate changes at [`/monitors`](https://agent402.tools/monitors). No wallet involved.
- **An agent developer:** one x402-wrapped fetch (or one MCP server) buys browser rendering, live search, PDFs, durable memory, and 150+ utilities from $0.001/call (most $0.001–$0.02; premium AI/media higher), plus 70+ curated multi-tool workflows ([[Skill Packs|Skill-Packs]]) priced by the tools they bundle - and outcome-priced report products on the same 402 when the job is a whole report rather than a call.
- **A skeptic:** the whole server is open source, every endpoint outside the metered set is re-tested against its own documented example before every deploy, and revenue settles on-chain to **`agent402.base.eth`** (a Base name resolving to the public receiving wallet) - [verify on Basescan](https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns).

> This wiki is generated from the [`wiki/`](https://github.com/MikeyPetrillo/Agent402/tree/HEAD/wiki) directory of the main repo and synced by CI - edit there, not here.
