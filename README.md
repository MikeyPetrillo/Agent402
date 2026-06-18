# Agent402 — the open x402 index (Find · Route · Leaderboard) + 1,100 tools for AI agents

> **What makes it different:** Agent402 is **open-source and self-hostable** — and a
> single integration gives a buyer **three free primitives over the whole x402
> ecosystem**:
>
> - **Find** — [`/api/find?q={task}`](https://agent402.tools/api/find) resolves a task description to the best-matching tools (route, price, schema, ready example).
> - **Route** — [`POST /api/route`](https://agent402.tools/api/route) is the **neutral Smart Order Router**: rank tools across every x402 seller crawled (auto-discovered from the Coinbase CDP Bazaar), health-aware, with `include=external` to exclude us.
> - **Leaderboard** — [`GET /api/leaderboard`](https://agent402.tools/api/leaderboard) is the **public on-chain ranking** of every x402 seller by **Base USDC settled volume** — calls served, totalUsd, unique buyers per seller. Pipeline: Bazaar → `eth_getLogs` → per-call ceiling → aggregate by `payTo`. Hourly snapshot.
>
> Plus the whole ~1,100-tool catalog, runnable yourself, and
> [`agent402-tollbooth`](tollbooth) — an open pay-per-crawl gate for the other
> side of x402.

[![Live](https://img.shields.io/website?url=https%3A%2F%2Fagent402.tools%2Fhealth&label=agent402.tools&up_message=live)](https://agent402.tools)
[![npm](https://img.shields.io/npm/v/agent402-mcp?label=agent402-mcp)](https://www.npmjs.com/package/agent402-mcp)
[![npm](https://img.shields.io/npm/v/agent402-client?label=agent402-client)](https://www.npmjs.com/package/agent402-client)
[![npm](https://img.shields.io/npm/v/agent402-tollbooth?label=agent402-tollbooth)](https://www.npmjs.com/package/agent402-tollbooth)
[![CI](https://github.com/MikeyPetrillo/Agent402/actions/workflows/deploy.yml/badge.svg)](https://github.com/MikeyPetrillo/Agent402/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Framework adapters** (drop-in tools for the major agent stacks — auto-payment underneath):
[![npm](https://img.shields.io/npm/v/agent402-openai-tools?label=openai-tools)](https://www.npmjs.com/package/agent402-openai-tools)
[![npm](https://img.shields.io/npm/v/agent402-anthropic-tools?label=anthropic-tools)](https://www.npmjs.com/package/agent402-anthropic-tools)
[![npm](https://img.shields.io/npm/v/agent402-ai-sdk?label=ai-sdk)](https://www.npmjs.com/package/agent402-ai-sdk)
[![npm](https://img.shields.io/npm/v/agent402-langchain?label=langchain)](https://www.npmjs.com/package/agent402-langchain)
[![npm](https://img.shields.io/npm/v/agent402-llamaindex?label=llamaindex)](https://www.npmjs.com/package/agent402-llamaindex)
[![npm](https://img.shields.io/npm/v/agent402-strands?label=strands)](https://www.npmjs.com/package/agent402-strands)

**Give your AI agent ~1,100 ready-to-use web tools from one server — browser
rendering, web search, PDFs, images, live data, crypto/payments helpers, and
~1,040 pure-CPU utilities.** Run it yourself for free in 30 seconds (MCP **or**
plain HTTP, no API keys, no signup), connect it to Claude/ChatGPT/any MCP
client, and add your own tools in a few lines. Every tool is deterministic —
**no LLM in the serving path** — and re-tested against its own example before
every release.

> Optionally, the same server can charge per call over the [x402
> protocol](https://x402.org) (USDC on Base) — so the instance you self-host for
> free can also be a hosted, monetized one. That part is opt-in; **by default
> everything runs free.**

🟢 **Hosted demo: [agent402.tools](https://agent402.tools)** · 📖 **[Wiki](https://github.com/MikeyPetrillo/Agent402/wiki)** · 📦 **[npm](https://www.npmjs.com/package/agent402-mcp)** · 🔌 **[MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.MikeyPetrillo/agent402)**

## Run it yourself in 30 seconds

Pick whichever fits — all three are free and need no wallet:

**1. Zero install — add the hosted connector to Claude** (claude.ai → Settings → Connectors → Add custom connector):

```
https://agent402.tools/mcp
```

**2. One command — run the MCP server locally** (the pure-CPU tools work with no key; it pays the tiny proof-of-work for you):

```bash
npx -y agent402-mcp
# in Claude Code:  claude mcp add agent402 -- npx -y agent402-mcp
```

**3. Clone and host the whole thing** (all ~1,100 tools as an HTTP API + MCP, free mode, no payments):

```bash
git clone https://github.com/MikeyPetrillo/Agent402 && cd Agent402
npm install
FREE_MODE=true npm start          # → http://localhost:3000  (HTTP API + /mcp)
```

```bash
# try a tool over HTTP — no auth in free mode
curl -s -X POST localhost:3000/api/hash -H 'content-type: application/json' \
  -d '{"text":"hello world","algo":"sha256"}'
```

**4. One-click deploy to Railway** (full self-hosted instance — adds optional Postgres + Redis plugins for analytics + response caching):

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https%3A%2F%2Fgithub.com%2FMikeyPetrillo%2FAgent402)

Boots straight from the repo's `railway.toml` + `Dockerfile`. Optional plugins are auto-detected via env: add **Redis** → `REDIS_URL` enables the upstream response cache (`X-Cache: hit|miss`), add **Postgres** → `DATABASE_URL` enables the public `/api/analytics` dashboard and the tollbooth waitlist. No env vars required to boot in free mode.

## What's in the catalog (~1,100 tools)

| | Examples |
|---|---|
| **Browser & web** | `render` (headless Chromium, executes JS), `screenshot`, `extract` (article→markdown), `meta` |
| **Live search** | `search` — a real web index behind one call |
| **PDFs & media** | `pdf-to-markdown`, `pdf-merge`/`extract-pages`/`rotate`, `images-to-pdf`, `audio-convert`, `audio-normalize` (EBU R128, real ffmpeg) |
| **Images** | `image-resize`, `image-convert`, `image-thumbnail`, `barcode-decode` (jimp/zxing, pure-CPU) |
| **OCR** | `ocr-image` (text out of any image — pure-CPU, no model) |
| **Geo** | `geo-distance`, `geo-bbox`, `geo-bearing`, `geo-geohash` (vincenty / haversine — deterministic) |
| **Live data** | `fx-rate` (ECB), `barcode-lookup` (Open Food Facts), `gov-data` (data.gov), `weather-forecast`/`weather-alerts`, `earthquakes` (USGS) |
| **Network truth** | `dns`, `tls-cert`, `whois`, `http-check`, `robots-check`, `email-validate`, `ip-info` |
| **Crypto & payments** | `usdc-balance`, `tx-status`, `gas-estimate`, `ens-resolve`, `x402-quote`/`verify`, `transfer-authorization` — non-custodial, multi-chain (Base/Polygon/Arbitrum/Optimism/Ethereum) |
| **Agent memory** | wallet-keyed KV + TTL, atomic counters, cross-wallet grants, hash-chained audit log, similarity recall |
| **~1,040 pure-CPU utilities** | hashing, JWT, base58, JSON⇄CSV/YAML, `token-count`, `text-chunk`, `json-validate`, text stats, cron math, validators, ~970 unit conversions |

Full schemas live in [`/openapi.json`](https://agent402.tools/openapi.json); a
machine-readable catalog is at [`/api/pricing`](https://agent402.tools/api/pricing)
and [`/llms.txt`](https://agent402.tools/llms.txt). Don't know which tool you need?
[`/api/find?q=<task>`](https://agent402.tools/api/find?q=extract%20article) resolves
a task description to the right tool — route, price, schema, and a ready example —
so an agent skips the token-heavy "search around to find a tool" step.

## x402 Index — Find · Route · Leaderboard

Agent402 is also **the open routing + ranking layer for the whole x402
ecosystem**: it crawls public x402 sellers (the local catalog + an
auto-discovered set from the [Coinbase CDP Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar),
refreshed hourly) and exposes them through three free surfaces — same logic as
`/api/find`: discovery primitives shouldn't cost money.

| Surface | What |
|---|---|
| [`GET /api/find?q={task}`](https://agent402.tools/api/find) | Resolve a task to the best-matching tools (route, price, schema, ready example) |
| [`POST /api/route`](https://agent402.tools/api/route) | Smart Order Router: `{ query, top, include }` → ranked tools across sellers (match score, then **health**, then price). `include=external` excludes Agent402 itself |
| [`GET /api/leaderboard`](https://agent402.tools/api/leaderboard) | **On-chain ranking** of every x402 seller by Base USDC settled volume (callsSettled, totalUsd, uniqueBuyers per seller). Pipeline: Bazaar → `eth_getLogs` → per-call ceiling → aggregate. Hourly snapshot |
| [`/index`](https://agent402.tools/index) | Public HTML dashboard: every seller, tool count, network, last-fetched, rolling health |
| [`GET /api/index`](https://agent402.tools/api/index) | JSON snapshot of the same data (totals, per-seller health/routable flags) |

```bash
# "I need an OCR tool — find me the cheapest healthy one anywhere on x402"
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
[`/__operator`](https://agent402.tools/__operator)): USDC vs. proof-of-work vs.
heartbeat-probe traffic are counted separately — and the heartbeat rail is gated
on a `POW_SECRET`-signed token (not a spoofable User-Agent), so the operator
view reflects real external demand.

**From code**, the [`agent402-client`](client) npm package wraps all of this —
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

If you're already on OpenAI / Anthropic / Vercel AI SDK / LangChain / LlamaIndex, skip the wiring — there's a drop-in package that turns the Agent402 catalog into native tool objects for your framework, with payment handled underneath (proof-of-work for free tools, x402+USDC when you pass an `@x402/fetch`):

| Stack | npm | Returns |
|---|---|---|
| OpenAI function-calling (chat.completions / Assistants v2 / Responses) | [`agent402-openai-tools`](https://www.npmjs.com/package/agent402-openai-tools) | `tools[]` for `tools:` param |
| Anthropic Messages API (`tool_use`) | [`agent402-anthropic-tools`](https://www.npmjs.com/package/agent402-anthropic-tools) | `tools[]` for `tools:` param |
| Vercel AI SDK (`streamText` / `generateText`) | [`agent402-ai-sdk`](https://www.npmjs.com/package/agent402-ai-sdk) | `Record<name, tool()>` |
| LangChain JS / LangGraph | [`agent402-langchain`](https://www.npmjs.com/package/agent402-langchain) | `DynamicStructuredTool[]` |
| LlamaIndex TS | [`agent402-llamaindex`](https://www.npmjs.com/package/agent402-llamaindex) | `FunctionTool[]` |
| Strands Agents (AWS Bedrock AgentCore) | [`agent402-strands`](https://www.npmjs.com/package/agent402-strands) | `StrandsTool[]` for `new Agent({ tools })` |

```js
// e.g. OpenAI — every adapter has the same surface.
import OpenAI from "openai";
import { agent402Tools } from "agent402-openai-tools";

const openai = new OpenAI();
const { tools, execute } = await agent402Tools({ slugs: ["extract", "hash", "render"] });
const res = await openai.chat.completions.create({ model: "gpt-4o-mini", tools, messages: [...] });
// when the model returns a tool call: await execute(call.function.name, JSON.parse(call.function.arguments));
```

Already a Claude/MCP user? `agent402-mcp` is still the better path — paste `https://agent402.tools/mcp` into your client. The adapters are for direct API integrations where MCP isn't available. Sources: [`adapters/`](adapters).

## Add your own tool (~15 lines)

A tool is just an object in a kit array. Drop this into any file in
[`src/tools/`](src/tools) (e.g. append to `AGENT_TOOLS` in `src/tools/agent-kit.js`)
and it's live — routed, schema-published, MCP-exposed, and covered by the
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

The same server can require payment per call — useful if you host a public
instance. It's off by default (`FREE_MODE=true`); to enable, set `WALLET_ADDRESS`
+ CDP facilitator keys (free at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com))
and agents pay in USDC on Base via standard x402 clients:

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

Agents without a wallet still use every pure-CPU tool by solving a single-use
sha256 proof-of-work (sub-second; the MCP servers do it automatically). Details:
[wiki: Paying with x402](https://github.com/MikeyPetrillo/Agent402/wiki/Paying-with-x402)
· [Paying with Compute](https://github.com/MikeyPetrillo/Agent402/wiki/Paying-with-Compute).

## Why it's solid

- **Everything is tested** — CI calls all ~1,100 tools with their own documented
  examples and blocks the release on any failure; a production heartbeat checks
  the live instance every 15 minutes.
- **Hardened** — connect-time SSRF guard on every URL tool (DNS-rebind safe),
  proof-of-work that's signed/single-use/slug-scoped, per-IP rate limits, and
  security headers. See [wiki: Security Model](https://github.com/MikeyPetrillo/Agent402/wiki/Security-Model).
- **Deterministic** — no model in the serving path, so the same input always
  gives the same output, with full OpenAPI schemas.
- **Auditable, on-chain revenue** — every paid call settles in USDC to
  [`agent402.base.eth`](https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns)
  (a Base name resolving to the public receiving wallet) — verifiable by anyone
  on Basescan; live counts at [`/api/stats`](https://agent402.tools/api/stats).
- **MIT licensed, fork-friendly** — clone it, strip what you don't need, add
  what you do.

## Agent402 in the x402 ecosystem

[x402](https://x402.org) is an open payment protocol built on HTTP `402 Payment
Required` for machine-to-machine, pay-per-call payments in stablecoins (USDC).
Most projects in the space are the [protocol + SDKs](https://github.com/coinbase/x402),
a starter template, or a payment facilitator. **Agent402 is the applied layer** —
a ready-to-run **x402 server** that already speaks the protocol and ships ~1,100
working tools, so you don't have to build the catalog yourself.

- **Want the protocol or an SDK?** → [coinbase/x402](https://github.com/coinbase/x402).
- **Want a server you can run *today* that actually does things over x402 + MCP?** → you're here.
- Self-hostable, deterministic, free via proof-of-work without a wallet, and
  non-custodial on the payment tools (your agent signs with its own key — Agent402 never holds funds).

Listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.MikeyPetrillo/agent402)
and discoverable in the Coinbase [x402 Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar).

**Works with [AWS Bedrock AgentCore Payments](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html) out of the box** — AgentCore orchestrates x402, which is the protocol Agent402 already speaks. Point the AgentCore Gateway at `https://agent402.tools/mcp` for all ~1,100 tools, or use [`agent402-strands`](https://www.npmjs.com/package/agent402-strands) for a curated subset inside a [Strands](https://strandsagents.com) agent. Five-minute recipe: [wiki: AWS Bedrock AgentCore](https://github.com/MikeyPetrillo/Agent402/wiki/AWS-Bedrock-AgentCore).

### Tollbooth — pay-per-crawl for **your** site (the other side of x402)

Charge AI crawlers that hit your site. Humans browse free; known bots get
`402 Payment Required` and can pay in USDC over x402 — or solve a free
proof-of-work. The open, crypto-native answer to Cloudflare's closed
pay-per-crawl: no CDN lock-in, no Stripe, no merchant-of-record, no signup.

- **Product page · pricing · live install:** [agent402.tools/tollbooth](https://agent402.tools/tollbooth)
- **Managed Tollbooth Cloud (Solo / Team / Agency / Enterprise):** [agent402.tools/tollbooth/cloud](https://agent402.tools/tollbooth/cloud) — join the waitlist
- **Run it yourself (MIT, npm):** `npm i agent402-tollbooth` · [`tollbooth/`](tollbooth) · [tollbooth/README.md](tollbooth/README.md)

Runs as Express middleware, a Next.js / Vercel Edge middleware, a Cloudflare
Worker, a reverse proxy, or a WordPress plugin (beta). Drop-in templates in
[`tollbooth/deploy/`](tollbooth/deploy). One Web-Crypto core powers all of them.

## Repository map

| Path | What |
|---|---|
| `src/server.js` | Express app + the tool catalog (routes, prices, schemas, discovery) |
| `src/tools/` | The tool kits (web, PDF, media, images, live data, crypto/x402, ~1,040 pure-CPU utilities) — **add tools here** |
| `src/mcp-http.js` | Hosted MCP connector (streamable HTTP, authless free tier) |
| `src/pow.js` | Proof-of-work tier (signed, single-use, slug-scoped challenges) |
| `src/payments.js` | Optional x402 v2 wiring: USDC on Base, CDP facilitator, Bazaar discovery |
| `src/x402-index.js` | x402 Index + Smart Order Router: cross-seller crawl, auto-discovery, health-aware routing |
| `mcp/` | The `agent402-mcp` npm package (stdio MCP server) |
| `client/` | The `agent402-client` buyer SDK (`find()` + `call()` with auto-payment) |
| `tollbooth/` | The `agent402-tollbooth` pay-per-crawl gate (Express / edge / proxy) |
| `adapters/` | Drop-in tools for OpenAI / Anthropic / AI SDK / LangChain / LlamaIndex |
| `wiki/` | Source for the [GitHub wiki](https://github.com/MikeyPetrillo/Agent402/wiki) (CI-synced) |
| `scripts/` | Tests, demos, ops tooling |

## Contributing

PRs that add useful tools, fix bugs, or improve docs are very welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed. Maintained by
[Mikey Petrillo](https://github.com/MikeyPetrillo).
