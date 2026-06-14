# Agent402 — a self-hostable MCP server with 1,100+ tools for AI agents

[![Live](https://img.shields.io/website?url=https%3A%2F%2Fagent402.tools%2Fhealth&label=agent402.tools&up_message=live)](https://agent402.tools)
[![npm](https://img.shields.io/npm/v/agent402-mcp?label=agent402-mcp)](https://www.npmjs.com/package/agent402-mcp)
[![CI](https://github.com/MikeyPetrillo/Agent402/actions/workflows/deploy.yml/badge.svg)](https://github.com/MikeyPetrillo/Agent402/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

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

## What's in the catalog (~1,100 tools)

| | Examples |
|---|---|
| **Browser & web** | `render` (headless Chromium, executes JS), `screenshot`, `extract` (article→markdown), `meta` |
| **Live search** | `search` — a real web index behind one call |
| **PDFs & media** | `pdf-to-markdown`, `pdf-merge`/`extract-pages`/`rotate`, `images-to-pdf`, `audio-convert`, `audio-normalize` (EBU R128, real ffmpeg) |
| **Images** | `image-resize`, `image-convert`, `image-thumbnail`, `barcode-decode` (jimp/zxing, pure-CPU) |
| **Live data** | `fx-rate` (ECB), `barcode-lookup` (Open Food Facts), `gov-data` (data.gov), `weather-forecast`/`weather-alerts`, `earthquakes` (USGS) |
| **Network truth** | `dns`, `tls-cert`, `whois`, `http-check`, `robots-check`, `email-validate`, `ip-info` |
| **Crypto & payments** | `usdc-balance`, `tx-status`, `gas-estimate`, `ens-resolve`, `x402-quote`/`verify`, `transfer-authorization` — non-custodial, multi-chain (Base/Polygon/Arbitrum/Optimism/Ethereum) |
| **Agent memory** | wallet-keyed KV + TTL, atomic counters, cross-wallet grants, hash-chained audit log, similarity recall |
| **~1,040 pure-CPU utilities** | hashing, JWT, base58, JSON⇄CSV/YAML, `token-count`, `text-chunk`, `json-validate`, text stats, cron math, validators, ~970 unit conversions |

Full schemas live in [`/openapi.json`](https://agent402.tools/openapi.json); a
machine-readable catalog is at [`/api/pricing`](https://agent402.tools/api/pricing)
and [`/llms.txt`](https://agent402.tools/llms.txt).

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

### Sibling: `agent402-tollbooth` (open-source pay-per-crawl)

Want the *other* side of x402 — charging AI bots that crawl **your** site?
[`tollbooth/`](tollbooth) is a self-hostable **pay-per-crawl** gate: drop it in
front of any site/API and humans browse free while AI crawlers pay per request
(USDC via x402, or free via proof-of-work). The open, crypto-native answer to
Cloudflare's closed pay-per-crawl — no CDN, no Stripe, no signup. Runs as
Express middleware, a reverse proxy, **or on the edge** (Cloudflare Workers /
Next.js middleware, via one Web-Crypto core). See [tollbooth/README.md](tollbooth/README.md).

## Repository map

| Path | What |
|---|---|
| `src/server.js` | Express app + the tool catalog (routes, prices, schemas, discovery) |
| `src/tools/` | The tool kits (web, PDF, media, images, live data, crypto/x402, ~1,040 pure-CPU utilities) — **add tools here** |
| `src/mcp-http.js` | Hosted MCP connector (streamable HTTP, authless free tier) |
| `src/pow.js` | Proof-of-work tier (signed, single-use, slug-scoped challenges) |
| `src/payments.js` | Optional x402 v2 wiring: USDC on Base, CDP facilitator, Bazaar discovery |
| `mcp/` | The `agent402-mcp` npm package (stdio MCP server) |
| `wiki/` | Source for the [GitHub wiki](https://github.com/MikeyPetrillo/Agent402/wiki) (CI-synced) |
| `scripts/` | Tests, demos, ops tooling |

## Contributing

PRs that add useful tools, fix bugs, or improve docs are very welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed. Maintained by
[Mikey Petrillo](https://github.com/MikeyPetrillo).
