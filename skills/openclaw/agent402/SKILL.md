---
name: agent402
description: "Pay-per-call access to Agent402.Tools: 500+ tools an agent calls over plain HTTP or MCP, paid per request in USDC over x402 or MPP, with a prepaid card credits key, or free via proof-of-work for pure-compute tools. Web search and page rendering, PDFs and OCR, SEC EDGAR and market data, crypto data, utilities, a metered model gateway on the OpenAI and Anthropic wires, and finished report products. Discover with GET /api/find?q=<task>. Use when the agent needs a specific capability it cannot do itself: scrape or render a URL, search the web, read a filing, OCR an image, hash or convert data, or run a model call without its own inference account. Do NOT activate for open-ended reasoning or when no tool matches; POST /api/wish in that case."
homepage: https://github.com/MikeyPetrillo/Agent402
metadata:
  openclaw:
    emoji: "🧰"
    homepage: "https://github.com/MikeyPetrillo/Agent402"
    primaryEnv: EVM_PRIVATE_KEY
---

# Agent402.Tools

500+ tools an agent can call over plain HTTP (or MCP), paid per call. Most are
deterministic code: the same input gives the same output. The model-backed
ones (the `/v1` gateway tiers, the report products, and the image, speech,
transcription, embedding and answer tools) are marked `modelBacked` in
`GET /api/pricing`. Open source (AGPL-3.0) and self-hostable; this skill points
at the hosted instance.

Base URL for every path below: `https://agent402.tools`

## Prerequisites

**Browse only, no keys needed:**
```bash
curl "https://agent402.tools/api/find?q=hash a string"
curl "https://agent402.tools/api/pricing"
```

**To pay for a tool, pick one (none needs a signup):**

1. **Wallet, USDC over x402.** Set `EVM_PRIVATE_KEY` to a **dedicated** wallet
   that holds only a small working balance, never a treasury or personal
   wallet. Base is the default rail; the same call also settles on Solana,
   Polygon, Arbitrum, Stellar, Algorand, Monad, Avalanche, Sei, Optimism,
   Robinhood Chain (USDG) and Celo, as listed in each tool's 402.
2. **Prepaid card credits.** Buy a pack at `https://agent402.tools/credits` and
   send `Authorization: Bearer a402_<key>`. The list price is held before the
   call and debited only when the call returns 200. No wallet involved.
3. **No payment at all.** Pure-compute tools accept a proof-of-work solution
   instead of a payment. See "Free tier" below.

Never hardcode a price. The 402 response is the source of truth, and
`GET /api/pricing` lists every current price.

## When to activate this skill

Activate when the agent needs to:
- call a specific tool: scraping or rendering a page, web search, PDFs, OCR,
  SEC EDGAR, market or crypto data, DNS and other utilities, hashing,
  encoding, conversion, stats
- run a chat, embedding, image or speech call through an OpenAI- or
  Anthropic-compatible wire without its own inference account
- pay a small USDC amount over x402 or MPP for any of the above
- resolve "which tool does X" without reading docs

Do not activate for open-ended reasoning, or when nothing in `/api/find`
matches (use `POST /api/wish`, below).

## Discover: `GET /api/find?q=<task>`

Free, no keys. Send a plain-language task; get back the best-matching tools
with route, price, input schema and a ready-to-run example.

```bash
curl "https://agent402.tools/api/find?q=hash a string"
```

Each result carries `route`, `price`, `inputSchema`, a pre-assembled
`callExample` (method, path, body or query) and `computePayable`, which is
`true` when the tool also accepts proof-of-work. For the whole catalog in one
call, use `GET /api/pricing`.

## Pay per call

Send the request normally. A priced tool answers `402 Payment Required` with:
- a `PAYMENT-REQUIRED` header: the x402 v2 challenge (base64 JSON) whose
  `accepts[]` lists every chain the tool settles on, and
- a `WWW-Authenticate: Payment` header: the MPP challenge.

Pay one of them and retry: x402 clients send `PAYMENT-SIGNATURE`, MPP clients
send `Authorization: Payment`. A failed call is never charged: payment settles
only after the tool returns a successful answer.

With the JavaScript SDK (`agent402-client`) and a standard x402 client:

```js
import { Agent402 } from "agent402-client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY) });
const a = new Agent402({ fetch: wrapFetchWithPayment(fetch, client), maxPerCallUsd: 0.05 });

const article = await a.call("extract", { url: "https://example.com/article" });
```

Or with a credits key and no wallet: `new Agent402({ creditsKey: "a402_..." })`.

**Budget guardrail:** without a pre-approved spend budget, confirm with the
user before paid calls above a few cents.

## Free tier: proof-of-work (no wallet needed)

```bash
curl "https://agent402.tools/api/pow/challenge?slug=hash"
```

The answer gives a `challenge`, a `difficulty` in leading zero bits and a
`token`. Find a nonce such that `sha256("<challenge>:" + nonce)` has that many
leading zero bits (a fraction of a second of CPU), then resend the original
request with `X-Pow-Solution: <token>:<nonce>` instead of a payment. The full
spec and the list of eligible tools are at `GET /api/pow`.

## Model gateway

OpenAI-compatible chat, embeddings, images and speech, plus the Anthropic
Messages wire, on the same payment rails:

- Chat tiers: `POST /v1/nano/chat/completions`, `/v1/auto/...`,
  `/v1/chat/completions`, `/v1/pro/...`, `/v1/premium/...`, each a flat price
  per call.
- Metered: `POST /v1/metered/chat/completions` (and `/v1/metered/messages`)
  quotes a price from the request body in the 402 and settles actual usage
  under that quote.
- `POST /v1/embeddings`, `POST /v1/images/generations`, `POST /v1/audio/speech`.

`GET /v1/models` lists the models each tier serves; `GET /api/pricing` lists
each tier's current price.

## One-shot dispatch: `POST /api/route/execute`

Pay one flat fee, describe the task (or name the slug), and the router
resolves the best match and runs it in the same request. Four tiers cover
increasingly expensive underlying tools: `/api/route/execute`,
`/api/route/execute-plus`, `/api/route/execute-max` and
`/api/route/execute-pro`. `GET /api/route?q=<task>` (free) shows which tool
matches and which tier it needs.

```bash
curl -i -X POST https://agent402.tools/api/route/execute \
  -H 'content-type: application/json' \
  -d '{"slug":"hash","params":{"text":"agent402","algo":"sha256"}}'
# HTTP/2 402 Payment Required - pay it like any other route, then retry
```

The answer carries a `receipt` (tool, route, what was paid) and the tool's
`result`. A tool priced above the tier's ceiling answers a 409 naming its
direct route, so the agent can call it there at list price or retry on a
higher tier.

## Nothing matches: `POST /api/wish`

If `/api/find` has no strong match, `POST /api/wish` with
`{ "need": "<what the agent needs>", "context": "<optional>" }` records the gap
(free, rate-limited). On the MCP connector the same thing is `demand.request`.

## Reference

- `GET /health`: liveness
- `GET /api/pricing`: the full priced catalog in one call
- `GET /.well-known/x402`: machine-readable service manifest
- `GET /api/reliability`: uptime and error rates
- MCP: `https://agent402.tools/mcp`, or `npx -y agent402-mcp`
- Docs: https://agent402.tools/docs · Source: https://github.com/MikeyPetrillo/Agent402
