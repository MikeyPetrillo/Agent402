# Agent402 — pay-per-call web tools for AI agents (x402 + MCP)

[![Live](https://img.shields.io/website?url=https%3A%2F%2Fagent402.tools%2Fhealth&label=agent402.tools&up_message=live)](https://agent402.tools)
[![npm](https://img.shields.io/npm/v/agent402-mcp?label=agent402-mcp)](https://www.npmjs.com/package/agent402-mcp)
[![CI](https://github.com/MikeyPetrillo/Agent402/actions/workflows/deploy.yml/badge.svg)](https://github.com/MikeyPetrillo/Agent402/actions/workflows/deploy.yml)
[![Heartbeat](https://github.com/MikeyPetrillo/Agent402/actions/workflows/heartbeat.yml/badge.svg)](https://github.com/MikeyPetrillo/Agent402/actions/workflows/heartbeat.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**A live node in the machine-to-machine economy: 1,000+ web tools that autonomous
agents pay for per call — USDC on Base via the [x402 protocol](https://x402.org),
or free with proof-of-work.** No humans, no signups, no API keys: an agent calls
an endpoint, gets an `HTTP 402 Payment Required` quote, settles from its own
wallet (or with a fraction of a second of CPU), and gets the result.
**The payment _is_ the identity.**

🟢 **Live at [agent402.tools](https://agent402.tools)** · 📖 **[Full documentation in the wiki](https://github.com/MikeyPetrillo/Agent402/wiki)** · 📊 **[Live stats + revenue wallet](https://agent402.tools/api/stats)**

## Try it in 30 seconds

**In Claude (claude.ai → Settings → Connectors → Add custom connector):**

```
https://agent402.tools/mcp
```

**In Claude Code / any MCP client** (full catalog, payment handled underneath):

```bash
claude mcp add agent402 -e AGENT_KEY=0x... -e AGENT402_BUDGET=1.00 -- npx -y agent402-mcp
```

**Over plain HTTP, no wallet, no install** — watch an autonomous buyer discover
the catalog, get quoted over 402, pay with compute, and use the result:

```bash
curl -s https://agent402.tools/demo.js -o demo.js && node demo.js
```

**With Stripe's [`purl`](https://github.com/stripe/purl)** (we're interop-tested
against it in CI, real settlement included):

```bash
purl "https://agent402.tools/api/convert/kilometers-to-miles?value=42"
```

## What's in the catalog (~1,083 tools)

| | Examples | Price |
|---|---|---|
| **Browser & web** | `render` (headless Chromium, executes JS), `screenshot`, `extract` (article→markdown), `meta` | $0.002–0.02 |
| **Live search** | `search` — paid web index, the wallet is the credential | $0.01 |
| **PDFs & media** | `pdf-to-markdown`, `pdf-merge`/`extract-pages`/`rotate`, `images-to-pdf`, `audio-convert`, `audio-normalize` (EBU R128, real ffmpeg) | $0.005–0.02 |
| **Agent memory** | wallet-keyed KV + TTL, atomic counters, **cross-wallet grants**, hash-chained audit log, similarity recall | $0.002–0.003 |
| **Network truth** | `dns`, `tls-cert`, `whois`, `http-check`, `robots-check`, `email-validate`, `ip-info` | $0.002–0.005 |
| **Open data** | `gov-data` (data.gov), `weather-alerts`, `earthquakes` (USGS) | $0.003 |
| **~1,040 pure-CPU utilities** | hashing, JWT, base58, JSON⇄CSV/YAML, text stats, cron math, validators, ~970 unit conversions | $0.001 · **free via proof-of-work** |

Everything is deterministic — **no LLM in the serving path** — with full schemas
in [`/openapi.json`](https://agent402.tools/openapi.json) and a machine-readable
catalog at [`/api/pricing`](https://agent402.tools/api/pricing) /
[`/llms.txt`](https://agent402.tools/llms.txt). Every endpoint is re-tested
against its own documented example before every deploy.

## How agents pay

Three ways, all standard ([wiki: Paying with x402](https://github.com/MikeyPetrillo/Agent402/wiki/Paying-with-x402) · [Paying with Compute](https://github.com/MikeyPetrillo/Agent402/wiki/Paying-with-Compute)):

```js
// x402 v2 — any client works; this is @x402/fetch
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);
const res = await payFetch("https://agent402.tools/api/extract", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com/article" }),
});
```

No wallet? The ~1,040 pure-CPU tools take a sha256 proof-of-work instead
(single-use, tool-scoped challenges — sub-second on any CPU). The MCP servers
solve it for you automatically.

## Verify, don't trust

Every claim here is machine-checkable:

- **Revenue is on-chain** — every paid call settles to the public wallet shown at [`/api/stats`](https://agent402.tools/api/stats); audit it on [Basescan](https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns).
- **Listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.MikeyPetrillo/agent402)** (`io.github.MikeyPetrillo/agent402`, with the hosted remote) and on [npm](https://www.npmjs.com/package/agent402-mcp).
- **Discoverable in the [Coinbase CDP x402 Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar)** — the index agents browse for x402 services.
- **CI is public**: the full test gauntlet, a production heartbeat every 15 minutes, and interop runs against Stripe's x402 client.
- **A named maintainer** — most x402 sellers are anonymous wallets. This one is [Mikey Petrillo](https://github.com/MikeyPetrillo).

## Run your own

```bash
npm install
FREE_MODE=true npm start              # demo mode, no payments
# or with payments: set WALLET_ADDRESS + CDP_API_KEY_ID/SECRET (free at portal.cdp.coinbase.com)
```

Deploying to Railway, the CI pipeline, the heartbeat watchdog, and the
persistence model are documented in
[wiki: Operations](https://github.com/MikeyPetrillo/Agent402/wiki/Operations);
the SSRF defenses and proof-of-work hardening in
[wiki: Security Model](https://github.com/MikeyPetrillo/Agent402/wiki/Security-Model);
the request path and design positions in
[wiki: Architecture](https://github.com/MikeyPetrillo/Agent402/wiki/Architecture).

## Repository map

| Path | What |
|---|---|
| `src/server.js` | Express app + the tool catalog (prices, schemas, discovery) |
| `src/payments.js` | x402 v2 wiring: USDC on Base, CDP facilitator, Bazaar discovery |
| `src/pow.js` | Proof-of-work tier (signed, single-use, slug-scoped challenges) |
| `src/mcp-http.js` | Hosted MCP connector (streamable HTTP, authless free tier) |
| `src/tools/` | The tool kits (web, PDF, media, gov data, ~1,040 pure-CPU utilities) |
| `mcp/` | The `agent402-mcp` npm package (stdio MCP server with spend controls) |
| `wiki/` | Source of truth for the [GitHub wiki](https://github.com/MikeyPetrillo/Agent402/wiki) (CI-synced) |
| `scripts/` | Tests, demos (`demo-payment.js`, `demo-coordination.js`), ops tooling |

MIT licensed. Issues and integration ideas welcome →
[github.com/MikeyPetrillo/Agent402/issues](https://github.com/MikeyPetrillo/Agent402/issues).
