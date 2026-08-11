# Agent402.Tools - search + answer front door, 500+ tools, open x402 index

[![MCP Toplist](https://mcptoplist.com/badge/io.github.MikeyPetrillo%2Fagent402.svg)](https://mcptoplist.com/server/io.github.MikeyPetrillo%2Fagent402)

> **What makes it different:** Agent402 is **open-source and self-hostable** - and a
> single integration gives a buyer **three free primitives over the whole x402
> ecosystem**:
>
> - **Find** - [`/api/find?q={task}`](https://agent402.tools/api/find) resolves a task description to the best-matching tools (route, price, schema, ready example).
> - **Route** - [`POST /api/route`](https://agent402.tools/api/route) is the **neutral Smart Order Router**: rank tools across every x402 seller crawled (auto-discovered from the Coinbase CDP Bazaar), health-aware, with `include=external` to exclude us.
> - **Leaderboard** - [`GET /api/leaderboard`](https://agent402.tools/api/leaderboard) is the **public on-chain ranking** of every x402 seller by **Base USDC settled volume** - calls served, totalUsd, unique buyers per seller. Pipeline: Bazaar → `eth_getLogs` → per-call ceiling → aggregate by `payTo`. Hourly snapshot.
>
> Plus the catalog - **500+ strong: search/answer as the MCP front door, then
> 400+ tools + 100+ curated skill packs** (multi-tool workflows callable as MCP
> prompts) - all runnable yourself, plus
> [`agent402-tollbooth`](tollbooth) - an open pay-per-crawl gate for the other
> side of x402.

[![Live](https://img.shields.io/website?url=https%3A%2F%2Fagent402.tools%2Fhealth&label=agent402.tools&up_message=live)](https://agent402.tools)
[![npm](https://img.shields.io/npm/v/agent402-mcp?label=agent402-mcp)](https://www.npmjs.com/package/agent402-mcp)
[![npm](https://img.shields.io/npm/v/agent402-client?label=agent402-client)](https://www.npmjs.com/package/agent402-client)
[![npm](https://img.shields.io/npm/v/agent402-tollbooth?label=agent402-tollbooth)](https://www.npmjs.com/package/agent402-tollbooth)
[![CI](https://github.com/MikeyPetrillo/Agent402/actions/workflows/deploy.yml/badge.svg)](https://github.com/MikeyPetrillo/Agent402/actions/workflows/deploy.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-green.svg)](LICENSE)
[![smithery badge](https://smithery.ai/badge/mike-kq9d/agent402)](https://smithery.ai/servers/mike-kq9d/agent402)

**Framework adapters** (drop-in tools for the major agent stacks - auto-payment underneath):
[![npm](https://img.shields.io/npm/v/agent402-openai-tools?label=openai-tools)](https://www.npmjs.com/package/agent402-openai-tools)
[![npm](https://img.shields.io/npm/v/agent402-anthropic-tools?label=anthropic-tools)](https://www.npmjs.com/package/agent402-anthropic-tools)
[![npm](https://img.shields.io/npm/v/agent402-ai-sdk?label=ai-sdk)](https://www.npmjs.com/package/agent402-ai-sdk)
[![npm](https://img.shields.io/npm/v/agent402-langchain?label=langchain)](https://www.npmjs.com/package/agent402-langchain)
[![npm](https://img.shields.io/npm/v/agent402-llamaindex?label=llamaindex)](https://www.npmjs.com/package/agent402-llamaindex)
[![npm](https://img.shields.io/npm/v/agent402-strands?label=strands)](https://www.npmjs.com/package/agent402-strands)
[![npm](https://img.shields.io/npm/v/agent402-google-adk?label=google-adk)](https://www.npmjs.com/package/agent402-google-adk)
[![npm](https://img.shields.io/npm/v/agent402-openai-agents?label=openai-agents)](https://www.npmjs.com/package/agent402-openai-agents)

**500+ strong - live web search and cited answers as the MCP front door, then 400+ ready-to-use web tools + 100+ multi-tool skill packs for your AI agent, from one server. Every one tested, priced, and settled on-chain; every one earns its place. Browser
rendering, web search, PDFs, images, OCR, live financial/crypto/macro data, SEC EDGAR, deterministic stats, forecasting, and options/bond pricing (Black-Scholes, YTM), compression, and 200+ pure-CPU utilities.** Run it yourself for free in 30 seconds (MCP **or**
plain HTTP, no API keys, no signup), connect it to Claude/ChatGPT/any MCP
client, and add your own tools in a few lines. Every tool is deterministic -
**no LLM in the serving path** - and re-tested against its own example before
every release.

> Optionally, the same server can charge per call over the [x402
> protocol](https://x402.org) (USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche,
> Sei, Optimism, Stellar & Algorand, plus USDG on Robinhood Chain - 12 chains) - so the instance you
> self-host for free can also be a hosted, monetized one. That part is opt-in;
> **by default everything runs free.**

🟢 **Hosted demo: [agent402.tools](https://agent402.tools)** · 📖 **[Wiki](https://github.com/MikeyPetrillo/Agent402/wiki)** · 📦 **[npm](https://www.npmjs.com/package/agent402-mcp)** · 🔌 **[MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.MikeyPetrillo/agent402)** · 🧩 **[Smithery](https://smithery.ai/servers/mike-kq9d/agent402)**

## Run it yourself in 30 seconds

Pick whichever fits. They are all free and need no wallet:

**1. Zero install - add the hosted connector to Claude** (claude.ai → Settings → Connectors → Add custom connector):

```
https://agent402.tools/mcp
```

**2. One command - run the MCP server locally** (the pure-CPU tools work with no key; it pays the tiny proof-of-work for you):

```bash
npx -y agent402-mcp
# in Claude Code:  claude mcp add agent402 -- npx -y agent402-mcp
```

**3. Clone and host the whole thing** (all 500+ tools as an HTTP API + MCP, free mode, no payments):

```bash
git clone https://github.com/MikeyPetrillo/Agent402 && cd Agent402
npm install
FREE_MODE=true npm start          # → http://localhost:3000  (HTTP API + /mcp)
```

```bash
# try a tool over HTTP - no auth in free mode
curl -s -X POST localhost:3000/api/hash -H 'content-type: application/json' \
  -d '{"text":"hello world","algo":"sha256"}'
```

**4. One-click deploy to Railway** (full self-hosted instance - adds optional Postgres + Redis plugins for analytics + response caching):

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https%3A%2F%2Fgithub.com%2FMikeyPetrillo%2FAgent402)

Boots straight from the repo's `railway.toml` + `Dockerfile`. Optional plugins are auto-detected via env: add **Redis** → `REDIS_URL` enables the upstream response cache (`X-Cache: hit|miss`), add **Postgres** → `DATABASE_URL` enables the public `/api/analytics` dashboard and the tollbooth waitlist. No env vars required to boot in free mode.

## What's in the catalog (500+ tools)

> **Every tool earns its place: deterministic, tested against its own example on every CI
> run, priced to market, settled on-chain.** CI holds a 400-entry catalog floor and
> verifies the “500+” claim against the running catalog (`scripts/sync-count.js --check`).
> The catalog grows only when a tool is worth calling.

| | Examples |
|---|---|
| **Browser & web** | `render` (headless Chromium, executes JS), `screenshot`, `extract` (article→markdown), `meta` |
| **Live search & answers** | `search` (real web index), `answer` (web answer with citations), `search-news`/`search-images`/`search-videos` variants, `search-suggest`, `multi-search` |
| **PDFs & media** | `pdf-to-markdown`, `pdf-merge`, `pdf-extract-pages`, `pdf-rotate`, `images-to-pdf`, `audio-convert`, `audio-normalize` (EBU R128, real ffmpeg) |
| **Images** | `image-resize`, `image-convert`, `image-thumbnail`, `barcode-decode` (jimp/zxing, pure-CPU) |
| **OCR** | `image-ocr` (text out of any image - pure-CPU, no model) |
| **Geo** | `geo-distance` (haversine, pure-CPU), `geocode`, `reverse-geocode`, `place-search`, `geo-lookup` |
| **Live data** | `fx-rate` (ECB), `barcode-lookup` (Open Food Facts), `gov-data` (data.gov), `weather-forecast`/`weather-alerts`, `earthquakes` (USGS) |
| **Finance & crypto** | `stock-quote`/`stock-history`/`earnings-calendar` (Yahoo), `crypto-price`/`crypto-market`/`crypto-history`/`crypto-trending`/`crypto-global` (CoinGecko) |
| **Macro (FRED + more)** | yield curve, treasury, fiscal, Fed funds, CPI, unemployment, Sahm rule, ECB FX, World Bank, FRED bulk release observations |
| **SEC EDGAR** | ticker→CIK, filing list, 10-K/10-Q text, XBRL frames, insider transactions, 13F holdings, IPO calendar, full-text search |
| **Network truth** | `dns`, `dns-lookup`, `tls-cert`, `whois`, `http-check`, `robots-check`, `email-validate`, `ip-info` |
| **Crypto & payments** | `usdc-balance`, `tx-status`, `gas-estimate`, `ens-resolve`, `x402-quote`, `x402-verify`, `transfer-authorization` - non-custodial, multi-chain (Base/Polygon/Arbitrum/Optimism/Ethereum) |
| **Agent memory** | wallet-keyed KV + TTL, atomic counters, cross-wallet grants, hash-chained audit log, similarity recall |
| **Stats & forecasting** | `stats-summary`, `correlation`, `linear-regression`, `moving-average`, `outliers`; `forecast-naive`, `forecast-ses`, `forecast-holt`, `forecast-holt-winters` + `forecast-eval` (MAPE/RMSE backtest) |
| **Finance math** | `black-scholes` (option pricing + greeks), `bond-price`/`bond-ytm`, `cagr`, `sharpe-ratio`, `annuity`, `npv`/`irr`, `compound-interest`, `loan-payment`/`amortization`, `break-even`, `effective-annual-rate` (pure-CPU, deterministic) |
| **Compression** | `gzip`/`gunzip`, `brotli-compress`/`brotli-decompress`, `compress-compare` (algorithm shootout, pure-CPU via node:zlib) |
| **HTML extraction** | `html-select` (CSS query), `html-table`, `html-strip`, `html-links`, `html-meta` - deterministic counterpart to `extract` |
| **Network ops** | `dns-lookup`, `dns-propagation`, `spf-check`/`dmarc-check`/`dkim-lookup`, `email-deliverability`; `cert-transparency`, `http-headers` (security audit), `tech-stack`, `asn-info` (IP geo) |
| **Chain reads** | `block-number`, `chain-info`, `block-info`, `contract-code`, `erc721-owner`, `event-logs` - keyless JSON-RPC reads with multi-endpoint failover on Ethereum/Base/Polygon/Arbitrum/Optimism, from $0.001 |
| **SQL policy** | `sql-guard` ($0.004 - pass/warn/block verdict with named risks on a SQL statement, plus an Ed25519 execution certificate when a signing key is configured), `sql-cert-verify` ($0.001 - verifies that certificate against the exact statement) |
| **x402 seller trust** | `seller-trust` (`GET /api/x402/seller-trust`, $0.005) - is a seller indexed, does its manifest parse, which chains does it advertise, how many settled calls has it been observed receiving on-chain, and would our own router spend buyer money on it |
| **200+ pure-CPU utilities** | hashing, JWT, base58, JSON⇄CSV/YAML, `token-count`, `text-chunk`, `json-validate`, text stats, cron math, validators, unit conversions across 13 categories (one parametric tool) |

Full schemas live in [`/openapi.json`](https://agent402.tools/openapi.json); a
machine-readable catalog is at [`/api/pricing`](https://agent402.tools/api/pricing)
and [`/llms.txt`](https://agent402.tools/llms.txt). Don't know which tool you need?
[`/api/find?q=<task>`](https://agent402.tools/api/find?q=extract%20article) resolves
a task description to the right tool - route, price, schema, and a ready example -
so an agent skips the token-heavy "search around to find a tool" step.

## OpenAI-compatible LLM gateway (`/v1`) - chat, embeddings & images, pay per call

Point any OpenAI SDK at `base_url = https://agent402.tools/v1` and pay per call in
USDC over x402 - no API key, no signup, no account:

| Endpoint | Price | Serves |
|---|---|---|
| `POST /v1/nano/chat/completions` | $0.003 | nano models - priced for high-frequency agent loops |
| `POST /v1/auto/chat/completions` | $0.01 | **no model needed** - deterministic eval-ranked routing (code / reasoning / long / general), optional `quality: fast \| balanced \| best` at the same price, decision disclosed via `agent402_router` |
| `POST /v1/chat/completions` | $0.02 | budget/mid models (gpt-4o-mini, claude haiku, gemini flash, deepseek, llama…) |
| `POST /v1/pro/chat/completions` | $0.10 | mid-frontier (gpt-4o, gpt-4.1, claude sonnet, gemini pro, grok) |
| `POST /v1/premium/chat/completions` | $0.50 | frontier (gpt-5, o3/o4, claude opus) |
| `POST /v1/embeddings` | $0.002 | OpenAI embeddings, batch up to 64 inputs - identical repeats are **free** (deterministic output, cache default-on) |
| `POST /v1/images/generations` | $0.08 | image generation (Gemini 2.5 Flash Image) - OpenAI images wire, inline base64 out |
| `POST /v1/audio/speech` | $0.06 | text-to-speech, OpenAI `audio.speech.create()` wire - up to 2,000 chars in, raw mp3 (default) or pcm bytes out, six-model failover chain |

Streaming (`stream: true`), full tools/function-calling passthrough, an opt-in
prompt cache on the chat tiers (`cache: true` → byte-identical repeats free for
10 minutes), upstream failover chains that end in a canary-proven model, and a
free [`GET /v1/models`](https://agent402.tools/v1/models) listing every model with
its tier and caps. A real-money canary buys from every one of these surfaces
daily - streaming, routing disclosure, and both cache behaviors included.

Two companion tools close the loop: `POST /api/route/execute` ($0.01, with
`execute-plus` $0.05 and `execute-max` $0.55 tiers for pricier tools) resolves a task description to the
best tool and runs it in one paid call, including, with `include:"external"`,
tools sold by **other x402 sellers** (it routes only to sellers with proven
on-chain settled volume, pays them on your behalf **on the chain you paid on** -
Base or Algorand - and relays the result; see the
[Smart Order Router guide](https://agent402.tools/guides/smart-order-router)), and
`POST /api/my-usage` ($0.005) returns the **paying wallet's own** purchase
history - no wallet parameter; the x402 payment is the identity, so nobody can
read another wallet's profile.

## Skill packs - 100+ multi-tool workflows

For jobs that span several tools - "audit a domain", "diagnose deliverability",
"work up a time-series", "peel an opaque blob" - Agent402 ships curated
**skill packs**: ordered, typed sequences of tool calls with a Claude-ready
prompt template. Callable as **MCP prompts** (`prompts/list` → `prompts/get { name, arguments }`)
or plain HTTP at `GET /api/skill-packs/{slug}/prompt` (every slug is listed in the
free JSON index at [`/api/skill-packs.json`](https://agent402.tools/api/skill-packs.json)).
A task-shaped query to `search_tools` returns the matching pack alongside individual tools.

| Featured pack | Chains | Use it for |
|---|---|---|
| [`security-audit`](https://agent402.tools/skills/security-audit) | cert-transparency · dns-lookup · spf-check · dmarc-check · http-headers · tls-cert · tech-stack | Domain security posture |
| [`trend-analysis`](https://agent402.tools/skills/trend-analysis) | stock-history · fred-series · stats-summary · moving-average · linear-regression · outliers · correlation · forecast-eval | Quant workup on any time series |
| [`structured-scrape`](https://agent402.tools/skills/structured-scrape) | extract · render · html-select · html-table · html-strip · html-links · html-meta | Deterministic scraping decision tree |
| [`decode-blob`](https://agent402.tools/skills/decode-blob) | jwt-decode · gunzip · brotli-decompress · base64 · hex · json-format · hash | Identify and peel any opaque string |
| [`forecasting-bake-off`](https://agent402.tools/skills/forecasting-bake-off) | stock-history · fred-series · forecast-eval · forecast-naive · forecast-ses · forecast-holt · forecast-holt-winters | Rank 4 forecasters by RMSE, pick the winner |
| [`document-intel`](https://agent402.tools/skills/document-intel) | pdf-info · pdf-to-markdown · pdf-extract-pages · image-ocr · barcode-decode · pdf-merge · images-to-pdf | PDF/OCR/barcode pipeline |
| [`status-snapshot`](https://agent402.tools/skills/status-snapshot) | dns-lookup · http-check · http-headers · tls-cert · robots-check | One-shot service-health sweep |
| [`webhook-debug`](https://agent402.tools/skills/webhook-debug) | json-format · jwt-decode · hmac · json-validate · time-convert · redact · extract-entities | Triage a webhook payload |

All 100+ packs at [`/skills`](https://agent402.tools/skills) · JSON index at [`/api/skill-packs.json`](https://agent402.tools/api/skill-packs.json) ·
on MCP the packs appear under `prompts/list` so any MCP-aware client picks them up automatically.

## x402 Index - Find · Route · Leaderboard

Agent402 is also **the open routing + ranking layer for the whole x402
ecosystem**: it crawls public x402 sellers (the local catalog + an
auto-discovered set from the [Coinbase CDP Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar),
refreshed hourly) and exposes them through three free surfaces - same logic as
`/api/find`: discovery primitives shouldn't cost money.

| Surface | What |
|---|---|
| [`GET /api/find?q={task}`](https://agent402.tools/api/find) | Resolve a task to the best-matching tools (route, price, schema, ready example) |
| [`POST /api/route`](https://agent402.tools/api/route) | Smart Order Router: `{ query, top, include }` → ranked tools across sellers (match score, then **health**, then price). `include=external` excludes Agent402 itself |
| [`GET /api/leaderboard`](https://agent402.tools/api/leaderboard) | **On-chain ranking** of every x402 seller by Base USDC settled volume (callsSettled, totalUsd, uniqueBuyers per seller). Pipeline: Bazaar → `eth_getLogs` → per-call ceiling → aggregate. Hourly snapshot |
| [`/marketplace`](https://agent402.tools/marketplace) | Public HTML dashboard: every seller, tool count, network, last-fetched, rolling health |
| [`GET /api/index`](https://agent402.tools/api/index) | JSON snapshot of the same data (totals, per-seller health/routable flags) |
| [`/stellar`](https://agent402.tools/stellar) · [`/algorand`](https://agent402.tools/algorand) | Per-chain marketplace pages: sellers and tools settling on that rail specifically |

```bash
# "I need an OCR tool - find me the cheapest healthy one anywhere on x402"
curl -X POST https://agent402.tools/api/route \
  -H 'content-type: application/json' \
  -d '{"query":"ocr image to text","top":5}'

# "Who are the most-used x402 sellers right now? (on-chain proof, not self-reports)"
curl 'https://agent402.tools/api/leaderboard?top=25&include=external'
```

**Health-aware:** sellers whose last few crawls errored are excluded from the
router (a buyer routed to a dead seller wastes money). Healthier sellers also
break ties at equal match score and price, so flaky-but-cheap sellers lose to
reliable ones. Brand-new sellers (no history yet) get the benefit of the doubt.

Operators get **3-rail attribution** on the dashboard ([`/api/stats`](https://agent402.tools/api/stats),
`/__operator`, token-gated - it answers 404 without the operator token): USDC vs. proof-of-work vs.
heartbeat-probe traffic are counted separately - and the heartbeat rail is gated
on a `POW_SECRET`-signed token (not a spoofable User-Agent), so the operator
view reflects real external demand.

**For API sellers:** [`/sell`](https://agent402.tools/sell) is the front door -
list an existing x402-speaking API on the index for free with
[`POST /api/index/register`](https://agent402.tools/sell) (health-routed, 0%
take, self-serve, no signup), or install [`agent402-tollbooth`](tollbooth) to
put a pay-per-crawl gate in front of a site that isn't x402-native yet.

**From code**, the [`agent402-client`](client) npm package wraps all of this -
`find()` a tool, then `call()` it, paying automatically (a built-in proof-of-work
for free tools, your x402 wallet for paid ones), with caching and idempotent
retries:

```bash
npm install agent402-client
```
```js
import { Agent402 } from "agent402-client";
const a = new Agent402();                       // free tier (proof-of-work)
const out = await a.call("hash", { text: "hello world", algo: "sha256" });
```

## Plug into your agent framework (zero-dep adapters)

If you're already on one of the stacks below - OpenAI, Anthropic, the Vercel AI SDK, LangChain (JS or Python), LlamaIndex, Strands, Google ADK, or the OpenAI Agents SDK - skip the wiring: there's a drop-in package that turns the Agent402 catalog into native tool objects for your framework, with payment handled underneath (proof-of-work for free tools, x402+USDC when you pass an `@x402/fetch`):

| Stack | npm | Returns |
|---|---|---|
| OpenAI function-calling (chat.completions / Assistants v2 / Responses) | [`agent402-openai-tools`](https://www.npmjs.com/package/agent402-openai-tools) | `tools[]` for `tools:` param |
| Anthropic Messages API (`tool_use`) | [`agent402-anthropic-tools`](https://www.npmjs.com/package/agent402-anthropic-tools) | `tools[]` for `tools:` param |
| Vercel AI SDK (`streamText` / `generateText`) | [`agent402-ai-sdk`](https://www.npmjs.com/package/agent402-ai-sdk) | `Record<name, tool()>` |
| LangChain JS / LangGraph | [`agent402-langchain`](https://www.npmjs.com/package/agent402-langchain) | `DynamicStructuredTool[]` |
| LlamaIndex TS | [`agent402-llamaindex`](https://www.npmjs.com/package/agent402-llamaindex) | `FunctionTool[]` |
| Strands Agents (AWS Bedrock AgentCore) | [`agent402-strands`](https://www.npmjs.com/package/agent402-strands) | `StrandsTool[]` for `new Agent({ tools })` |
| Google ADK (Agent Development Kit) | [`agent402-google-adk`](https://www.npmjs.com/package/agent402-google-adk) | `FunctionTool[]` for ADK agents |
| OpenAI Agents SDK | [`agent402-openai-agents`](https://www.npmjs.com/package/agent402-openai-agents) | `Agent tools` for `@openai/agents` |
| LangChain **Python** / CrewAI | [`agent402-langchain`](https://pypi.org/project/agent402-langchain/) (PyPI) | `StructuredTool[]` from `Agent402Toolkit.get_tools()` - four meta-tools (find / route / call / about), not one per slug |

```js
// e.g. OpenAI - every adapter has the same surface.
import OpenAI from "openai";
import { agent402Tools } from "agent402-openai-tools";

const openai = new OpenAI();
const { tools, execute } = await agent402Tools({ slugs: ["extract", "hash", "render"] });
const res = await openai.chat.completions.create({ model: "gpt-4o-mini", tools, messages: [...] });
// when the model returns a tool call: await execute(call.function.name, JSON.parse(call.function.arguments));
```

Already a Claude/MCP user? `agent402-mcp` is still the better path - paste `https://agent402.tools/mcp` into your client. The adapters are for direct API integrations where MCP isn't available. Sources: [`adapters/`](adapters).

**OpenClaw agents:** drop in [`skills/openclaw/agent402/SKILL.md`](skills/openclaw/agent402/SKILL.md) - teaches an OpenClaw agent to find, pay (x402 USDC on Base, eleven other chains accepted, or free proof-of-work), and call any of the 400+ tools (or 100+ packs).

## Add your own tool (~15 lines)

A tool is just an object in a kit array. Drop this into any file in
[`src/tools/`](src/tools) (e.g. append to `AGENT_TOOLS` in `src/tools/agent-kit.js`)
and it's live - routed, schema-published, MCP-exposed, and covered by the
"every tool answers its own example" CI check:

```js
{
  route: "POST /api/reverse",
  name: "Reverse text",
  slug: "reverse",
  category: "text",
  price: "$0.001",                       // free via proof-of-work for pure-CPU tools
  description: "Reverse a string. Example: {\"text\":\"abc\"} → {\"reversed\":\"cba\"}",
  discovery: {
    inputSchema: { properties: { text: { type: "string" } }, required: ["text"] },
    example: { text: "abc" },            // CI calls this and checks it works
  },
  handler: (input) => {
    if (typeof input.text !== "string") { const e = new Error('"text" required'); e.statusCode = 400; throw e; }
    return { reversed: [...input.text].reverse().join("") };
  },
}
```

That's the whole contract: `handler(input)` returns a JSON-serializable object
(or throws an `Error` with `.statusCode` for a 4xx). Pure-CPU tools are
automatically free-via-proof-of-work; tools that hit the network or disk stay
wallet-only. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full walkthrough.

## Optional: charge per call with x402

The same server can require payment per call - useful if you host a public
instance. Payments are the default posture: a bare `npm start` **fails closed**,
exiting unless `WALLET_ADDRESS` is set - running without payments is the
explicit opt-in (`FREE_MODE=true npm start`). To charge, set `WALLET_ADDRESS`
+ CDP facilitator keys (free at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com))
and agents pay in USDC on Base (or Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar,
Algorand - or USDG on Robinhood Chain via `PAYMENT_NETWORKS=…,robinhood` +
`ROBINHOOD_FACILITATOR_URL`) via standard x402 clients:

```js
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);
const res = await payFetch("https://agent402.tools/api/extract", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com/article" }),
});
```

**MPP dual-stack.** The paywall also speaks MPP (Machine Payments Protocol -
the IETF-track `Payment` HTTP auth scheme from [tempoxyz/mpp](https://github.com/tempoxyz/mpp)):
the same 402 carries a `WWW-Authenticate: Payment` challenge, `Authorization:
Payment` credentials settle identically (EIP-3009 USDC, same facilitator, same
price), and settled responses return a `Payment-Receipt`. An
[`mppx`](https://www.npmjs.com/package/mppx) client works out of the box; set
`MPP_SECRET_KEY` to enable it on your own instance. Same URL either way - the
buyer's client picks the dialect.

Agents without a wallet still use every pure-CPU tool by solving a single-use
sha256 proof-of-work (sub-second; the MCP servers do it automatically). Details:
[wiki: Paying with x402](https://github.com/MikeyPetrillo/Agent402/wiki/Paying-with-x402)
· [Paying with Compute](https://github.com/MikeyPetrillo/Agent402/wiki/Paying-with-Compute).

## Why it's solid

- **Everything is tested** - CI calls all 500+ tools with their own documented
  examples and blocks the release on any failure. Two independent probes outside
  production watch the live instance (one every 5 minutes, on separate infra from
  the other), and what they observe is public at
  [`/status`](https://agent402.tools/status) - where a day with no observation
  reads "no data", never uptime, because an outage is exactly when a probe
  cannot report.
- **Hardened** - connect-time SSRF guard on every URL tool (DNS-rebind safe),
  proof-of-work that's signed/single-use/slug-scoped, per-IP rate limits, and
  security headers. See [wiki: Security Model](https://github.com/MikeyPetrillo/Agent402/wiki/Security-Model).
- **Deterministic** - no model in the serving path, so the same input always
  gives the same output, with full OpenAPI schemas.
- **Auditable, on-chain revenue** - every paid call settles in USDC to
  [`agent402.base.eth`](https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns)
  (a Base name resolving to the public receiving wallet) - verifiable by anyone
  on Basescan; live counts at [`/api/stats`](https://agent402.tools/api/stats).
- **AGPL-3.0 licensed, self-host-friendly** - clone it, strip what you don't need, add
  what you do.

## Agent402 in the x402 ecosystem

[x402](https://x402.org) is an open payment protocol built on HTTP `402 Payment
Required` for machine-to-machine, pay-per-call payments in stablecoins (USDC).
Most projects in the space are the [protocol + SDKs](https://github.com/coinbase/x402),
a starter template, or a payment facilitator. **Agent402 is the applied layer** -
a ready-to-run **x402 server** that already speaks the protocol and ships 500+
working tools, so you don't have to build the catalog yourself.

- **Want the protocol or an SDK?** → [coinbase/x402](https://github.com/coinbase/x402).
- **Want a server you can run *today* that actually does things over x402 + MCP?** → you're here.
- Self-hostable, deterministic, free via proof-of-work without a wallet, and
  non-custodial on the payment tools (your agent signs with its own key - Agent402 never holds funds).

Listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.MikeyPetrillo/agent402)
and discoverable in the Coinbase [x402 Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar).

**Works with [AWS Bedrock AgentCore Payments](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html) out of the box** - AgentCore orchestrates x402, which is the protocol Agent402 already speaks. Point the AgentCore Gateway at `https://agent402.tools/mcp` for all 500+ tools, or use [`agent402-strands`](https://www.npmjs.com/package/agent402-strands) for a curated subset inside a [Strands](https://strandsagents.com) agent. Five-minute recipe: [wiki: AWS Bedrock AgentCore](https://github.com/MikeyPetrillo/Agent402/wiki/AWS-Bedrock-AgentCore).

### Tollbooth - pay-per-crawl for **your** site (the other side of x402)

Charge AI crawlers that hit your site. Humans browse free; known bots get
`402 Payment Required` and can pay in USDC over x402 - or solve a free
proof-of-work. The open, crypto-native answer to Cloudflare's closed
pay-per-crawl: no CDN lock-in, no Stripe, no merchant-of-record, no signup.

- **Product page · pricing · live install:** [agent402.tools/tollbooth](https://agent402.tools/tollbooth)
- **Managed Tollbooth Cloud (Solo / Team / Agency / Enterprise):** [agent402.tools/tollbooth/cloud](https://agent402.tools/tollbooth/cloud) - join the waitlist
- **Run it yourself (MIT, npm):** `npm i agent402-tollbooth` · [`tollbooth/`](tollbooth) · [tollbooth/README.md](tollbooth/README.md)

Runs as Express middleware, a Next.js / Vercel Edge middleware, a Cloudflare
Worker, a reverse proxy, or a WordPress plugin (beta). Drop-in templates in
[`tollbooth/deploy/`](tollbooth/deploy). One Web-Crypto core powers all of them.

## Repository map

| Path | What |
|---|---|
| `src/server.js` | Express app + the tool catalog (routes, prices, schemas, discovery) |
| `src/tools/` | The tool kits (web, PDF, media, images, live data, crypto/x402, 200+ pure-CPU utilities) - **add tools here** |
| `src/mcp-http.js` | Hosted MCP connector (streamable HTTP, authless free tier) |
| `src/pow.js` | Proof-of-work tier (signed, single-use, slug-scoped challenges) |
| `src/payments.js` | Optional x402 v2 wiring: USDC on Base/Solana/Polygon/Arbitrum/Monad/Celo/Avalanche/Sei/Optimism/Stellar/Algorand + USDG on Robinhood Chain (12 chains), CDP facilitator, Bazaar discovery |
| `src/x402-index.js` | x402 Index + Smart Order Router: cross-seller crawl, auto-discovery, health-aware routing, per-chain marketplace pages (`/stellar`, `/algorand`) |
| `src/sell.js` | `/sell` - the seller front door: free self-serve listing (`POST /api/index/register`) or `agent402-tollbooth` for pay-per-crawl |
| `mcp/` | The `agent402-mcp` npm package (stdio MCP server) |
| `client/` | The `agent402-client` buyer SDK (`find()` + `call()` with auto-payment) |
| `tollbooth/` | The `agent402-tollbooth` pay-per-crawl gate (Express / edge / proxy) |
| `adapters/` | Drop-in tools for every framework in the adapter table above (npm, plus `langchain-py` on PyPI for LangChain/CrewAI Python) |
| `wiki/` | Source for the [GitHub wiki](https://github.com/MikeyPetrillo/Agent402/wiki) (CI-synced) |
| `scripts/` | Tests, demos, ops tooling |

## Legal

- The hosted instance at agent402.tools is provided under its
  [Terms of Service](https://agent402.tools/terms) (acceptable-use policy included - using the
  service, including programmatically, constitutes acceptance) and
  [Privacy Policy](https://agent402.tools/privacy).
- AI-gateway traffic (`/v1` chat, embeddings, images, speech) is additionally subject to the
  upstream model providers' usage policies. Wallets used for prohibited content are blocked
  before settlement (`WALLET_BLOCKLIST`).
- The **server code** is AGPL-3.0-licensed (the client SDK, MCP connector, and tollbooth packages are MIT) and provided as-is, without warranty (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). "Agent402" and the logo are trademarks of Havok Holdings LLC - the license covers the code, not the name; forks must rename (see [TRADEMARKS.md](TRADEMARKS.md)).
  If you self-host, you are the operator: your deployment, your terms, your compliance -
  Havok Holdings LLC operates only the hosted instance and is not responsible for third-party
  deployments.

## Contact

- **Email:** [mike@agent402.tools](mailto:mike@agent402.tools)
- **X / Twitter:** [@Agent402Tools](https://x.com/Agent402Tools)
- **GitHub:** [MikeyPetrillo/Agent402](https://github.com/MikeyPetrillo/Agent402)

## Contributing

PRs that add useful tools, fix bugs, or improve docs are very welcome - see
[CONTRIBUTING.md](CONTRIBUTING.md). AGPL-3.0 licensed (packages MIT). Maintained by
[Havok Holdings LLC](https://github.com/MikeyPetrillo/Agent402).
