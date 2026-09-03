---
title: "Agent402 Plugin"
description: "Discover and call 500+ pay-per-call web tools via x402 payments (USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar & Algorand; USDG on Robinhood Chain - 12 chains) through Agent402.tools"
tags: [x402, tools, api, payments, agents]
name: agent402
version: 0.1.0
integration: http-api
chains: [base, base-sepolia]
requires:
  shell: none
  allowlist: [agent402.tools]
  externalMcp: null
  cliPackage: null
auth: none
risk: []
---

> [!IMPORTANT]
> ## STOP - COMPLETE ONBOARDING BEFORE USING THIS PLUGIN
> Complete the Base MCP onboarding in SKILL.md first. You must have a funded Base wallet with USDC to call paid tools. Run `get_wallets` to confirm your wallet address and USDC balance before proceeding.

## Overview

Agent402 is an open-source x402 tool server hosting 500+ pay-per-call web tools for AI agents at `https://agent402.tools`. Tools span browser rendering, web search, PDFs, OCR, image processing, financial data, crypto analytics, SEC EDGAR filings, unit conversions, encoding, hashing, and wallet-keyed memory. Every tool is called over HTTP: the agent receives an HTTP 402 response with exact USDC payment terms, pays via x402, and gets the result. Most single tools cost $0.001--$0.02 per call; the routing tiers top out at $0.55, multi-tool skill packs reach $1.50, and the report products (deep research, company dossier, 13F fund report, SEC filing report, domain audit, token risk, FDA recall, insider flow) run $0.20 to $1.10 per report. No signup, no API key -- the payment is the only credential.

Agent402 exposes free discovery endpoints (no payment required) that resolve tasks to the right tool, plus paid tool endpoints that settle via x402 in USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar, or Algorand (or USDG on Robinhood Chain - 12 chains in total). This plugin teaches agents to discover tools, understand pricing, and call any tool using Base MCP's `initiate_x402_request` / `complete_x402_request` flow.

## Surface Routing

| Capability | Claude (consumer) | Claude Code / Cursor | ChatGPT |
|---|---|---|---|
| Discovery (read) | `web_request` GET | `web_request` GET or harness HTTP | `web_request` GET |
| Call paid tool | `initiate_x402_request` + `complete_x402_request` | `initiate_x402_request` + `complete_x402_request` | `initiate_x402_request` + `complete_x402_request` |

All discovery endpoints are free GET requests. All paid tool calls go through the x402 payment flow.

## Endpoints

### Discovery Endpoints (free, no payment required)

#### Find a tool by task description

Resolves a plain-language task to the best-matching tools with route, price, input schema, and a ready example.

```
GET https://agent402.tools/api/find?q={task}&k={limit}
```

**Parameters:**
- `q` (required): Natural-language task description, e.g. `"extract article from url"`, `"convert miles to km"`, `"hash sha256"`
- `k` (optional): Max results, default 5, max 25

**Response shape:**
```json
{
  "query": "convert miles to km",
  "count": 3,
  "results": [
    {
      "slug": "unit-convert",
      "name": "Unit convert",
      "route": "POST /api/unit-convert",
      "price": "$0.001",
      "callExample": {
        "method": "POST",
        "path": "/api/unit-convert",
        "body": { "value": 26.2, "from": "miles", "to": "kilometers" }
      },
      "example": { "value": 26.2, "from": "miles", "to": "kilometers" },
      "required": ["value", "from", "to"],
      "inputSchema": {
        "type": "object",
        "properties": {
          "value": { "type": "number" },
          "from": { "type": "string" },
          "to": { "type": "string" }
        },
        "required": ["value", "from", "to"]
      },
      "category": "math",
      "description": "Convert a value between units of length, mass, temperature, and more.",
      "computePayable": true,
      "docs": "https://agent402.tools/tools/unit-convert"
    }
  ]
}
```

The `callExample` field contains the exact method, path, and query/body needed to call the tool. `computePayable: true` means the tool also accepts free proof-of-work.

#### Browse the full catalog with pricing

Returns every tool with its price, category, slug, and whether it accepts free proof-of-work.

```
GET https://agent402.tools/api/pricing
```

**Response shape:**
```json
{
  "name": "Agent402.Tools",
  "payment": {
    "protocol": "x402",
    "version": 2,
    "network": "base",
    "currency": "USDC"
  },
  "baseUrl": "https://agent402.tools",
  "endpoints": [
    {
      "method": "POST",
      "path": "/api/unit-convert",
      "price": "$0.001",
      "category": "math",
      "slug": "unit-convert",
      "description": "Convert a value between units of length, mass, temperature, and more.",
      "docs": "https://agent402.tools/tools/unit-convert",
      "computePayable": true
    }
  ]
}
```

#### Smart Order Router (cross-seller discovery)

Routes a task across every x402 seller in the ecosystem (not just Agent402), ranked by health then price.

```
GET https://agent402.tools/api/route?q={task}&top={limit}&include={all|external|local}
```

**Parameters:**
- `q` (required): Task description
- `top` (optional): Max results, default 5
- `include` (optional): `"all"` (default), `"external"` (exclude Agent402), or `"local"` (Agent402 only)

#### x402 Economy Leaderboard

Live on-chain ranking of x402 sellers by USDC settled volume on Base.

```
GET https://agent402.tools/api/leaderboard?top={limit}&include={all|external}&sort={usd|calls}
```

**Parameters:**
- `top` (optional): Max rows, default 25, max 500
- `include` (optional): `"all"` (default) or `"external"` (exclude Agent402's own wallet)
- `sort` (optional): `"usd"` (default, by USDC settled) or `"calls"` (by call count)

**Response shape:**
```json
{
  "windowLabel": "24h",
  "asOf": "2026-06-25T12:00:00.000Z",
  "include": "all",
  "sortServed": "usd",
  "totalSellers": 15,
  "leaderboard": [
    {
      "rank": 1,
      "name": "SomeService",
      "network": "base",
      "wallet": "0x...",
      "homepage": "https://example.com",
      "callsSettled": 1200,
      "totalUsd": 4.8,
      "uniqueBuyers": 23
    }
  ]
}
```

#### Service Manifest

Machine-readable summary of the entire service (identity, payment options, capabilities, MCP connector, trust signals).

```
GET https://agent402.tools/.well-known/x402
```

### Paid Tool Endpoints (x402 payment required)

Every tool in the catalog is a paid endpoint. Calling it without payment returns HTTP 402 with exact USDC terms. Use the x402 payment flow below.

**Tool URL pattern:** `https://agent402.tools{path}` where `{path}` comes from the `route` field in `/api/find` or `/api/pricing` results.

**GET tools** (lookups): pass parameters as query strings.
Example: `https://agent402.tools/api/dns?name=example.com&type=A`

**POST tools** (browser, search, extract, memory): pass parameters as JSON body.
Example: `https://agent402.tools/api/extract` with body `{"url": "https://example.com"}`

### Route-and-execute (one paid call, tool resolved for you)

Instead of discovering a tool and then calling it, hand the router a task and it
resolves the best-matching tool and runs it in the same paid request, returning
`{ result, receipt }`. With `include: "external"` the underlying tool may belong
to another x402 seller, which the router pays on your behalf and relays.

There are three rungs, so the flat routing fee stays proportional to what is
being bought. Pick the cheapest rung that covers the underlying tool's price:

| Underlying tool price | Fee | Route |
|---|---|---|
| ≤ $0.005 | $0.01 | `POST /api/route/execute` |
| ≤ $0.04 | $0.05 | `POST /api/route/execute-plus` |
| ≤ $0.50 | $0.55 | `POST /api/route/execute-max` |

A tool priced above the rung's ceiling returns a self-correcting HTTP 409 naming
its direct route. `GET /api/route?q={task}` (free) quotes which rung a task needs.

## Orchestration

### Discovering the right tool

1. Call `get_wallets` to confirm your Base wallet address and USDC balance.
2. Use `/api/find?q=<task>` to resolve a task to matching tools. Read the `callExample` from the response -- it contains the exact method, path, and parameters needed.
3. If you want to browse categories or compare prices, use `/api/pricing` for the full catalog.
4. To find tools across the entire x402 ecosystem (not just Agent402), use `/api/route?q=<task>&include=all`.

### Calling a paid tool via x402

Once you have the tool's method, path, and parameters from discovery:

1. **Construct the full URL.** Prepend `https://agent402.tools` to the path. For GET tools, append query parameters. For POST tools, prepare the JSON body.

2. **Initiate the x402 payment request.** Call `initiate_x402_request` with:
   - `url`: The full tool URL
   - `method`: `"GET"` or `"POST"` (from the tool's route)
   - `body`: The JSON input (POST tools only)
   - `maxPayment`: A tight USDC cap (e.g. `"0.01"` for a $0.001 tool -- always leave a small margin)

3. **Wait for user approval.** Base MCP returns an approval link and `requestId`. The user reviews and approves the USDC payment.

4. **Complete the request.** Call `complete_x402_request` with the `requestId`. This replays the request with the signed payment and returns the tool's JSON result.

### Checking the x402 economy

1. Call `/api/leaderboard?top=10&sort=usd` to see which x402 sellers are earning the most USDC.
2. Use `include=external` to see only sellers other than Agent402.
3. Use `sort=calls` to rank by usage volume instead of revenue.

## Submission

This plugin uses `initiate_x402_request` and `complete_x402_request` for all paid tool calls. No `send_calls` mapping is needed -- x402 payments are handled natively by Base MCP's payment flow, not through raw calldata.

| Tool | Use for |
|---|---|
| `initiate_x402_request` | Start a paid tool call with a USDC spending cap |
| `complete_x402_request` | Finalize the payment and retrieve the tool's response |
| `web_request` | Free discovery endpoints only (`/api/find`, `/api/pricing`, `/api/route`, `/api/leaderboard`) |

### Mapping discovery results to x402 calls

From `/api/find` response, extract the tool's `callExample`:

**For a GET tool** (e.g. `dns`):
```
callExample: { method: "GET", path: "/api/dns", query: { name: "example.com", type: "A" } }
```
Map to `initiate_x402_request`:
```json
{
  "url": "https://agent402.tools/api/dns?name=example.com&type=A",
  "method": "GET",
  "maxPayment": "0.01"
}
```

**For a POST tool** (e.g. `extract`):
```
callExample: { method: "POST", path: "/api/extract", body: { url: "https://example.com" } }
```
Map to `initiate_x402_request`:
```json
{
  "url": "https://agent402.tools/api/extract",
  "method": "POST",
  "body": { "url": "https://example.com" },
  "maxPayment": "0.01"
}
```

Then call `complete_x402_request` with the returned `requestId` to get the result.

## Example Prompts

**Prompt:** "Find me a tool to convert 26.2 miles to kilometers and call it"

1. Discover: `GET https://agent402.tools/api/find?q=convert%20miles%20to%20kilometers`
2. Read the top result's `callExample`: method POST, path `/api/unit-convert`, body `{value: 26.2, from: "miles", to: "kilometers"}`
3. Call `initiate_x402_request` with url `https://agent402.tools/api/unit-convert`, method POST, body `{"value": 26.2, "from": "miles", "to": "kilometers"}`, maxPayment `"0.01"`
4. User approves the ~$0.001 USDC payment
5. Call `complete_x402_request` with the requestId to get the conversion result

**Prompt:** "Extract the main article content from https://example.com/blog/post"

1. Discover: `GET https://agent402.tools/api/find?q=extract%20article%20from%20url`
2. Top result is `extract` (POST /api/extract, $0.010/call)
3. Call `initiate_x402_request` with url `https://agent402.tools/api/extract`, method POST, body `{"url": "https://example.com/blog/post"}`, maxPayment `"0.02"`
4. User approves the ~$0.010 USDC payment
5. Call `complete_x402_request` to get clean markdown of the article

**Prompt:** "What are the top x402 sellers right now?"

1. Read: `GET https://agent402.tools/api/leaderboard?top=10&sort=usd&include=external`
2. Display the ranked sellers with their USDC volume, call counts, and unique buyers
3. No payment needed -- the leaderboard is a free endpoint

**Prompt:** "Search the web for recent news about Base blockchain"

1. Discover: `GET https://agent402.tools/api/find?q=web%20search%20news`
2. Top result is `search-news` (GET /api/search-news, $0.02/call)
3. Call `initiate_x402_request` with url `https://agent402.tools/api/search-news?q=Base%20blockchain`, method GET, maxPayment `"0.03"`
4. User approves the ~$0.02 USDC payment
5. Call `complete_x402_request` to get the search results

## Notes

- **No signup or API key required.** The USDC payment via x402 is the only credential. The wallet address is the identity.
- **Deterministic utilities.** No LLM in the serving path of the utility tools -- same input always yields the same output. The `/v1` model gateway and the report products are model-backed and say so.
- **Idempotency.** For safe retries, pass an `Idempotency-Key` header. If the same key + endpoint is replayed, the cached result is returned without re-charging.
- **Price range.** Most single tools cost $0.001--$0.02; the routing tiers top out at $0.55 (`route-execute-max`), multi-tool skill packs run up to $1.50, and the report products run $0.20 to $1.10 (`POST /v1/domain-audit` $0.60 through `POST /v1/research/max` $1.10 - same endpoints a human buys by card at https://agent402.tools/reports for $1 to $2, a price that includes payment processing). **Don't hardcode a `maxPayment` cap** - read the exact price from `/api/pricing` (or the `402` quote) before paying, so you never under-cap and fail a legitimate call.
- **Free discovery.** The endpoints `/api/find`, `/api/pricing`, `/api/route`, `/api/leaderboard`, `/.well-known/x402`, and `/api/reliability` are all free and require no payment.
- **MCP connector.** For direct MCP access (outside Base MCP), paste `https://agent402.tools/mcp` into any MCP client. Pure-CPU tools run free there (rate-limited); wallet-only tools are payable on the connector over MPP (a paid call answers JSON-RPC error `-32042` with the challenges), or run the `agent402-mcp` npm package with a funded wallet or a prepaid card-credits key.
- **Other ways to pay.** Every paid route also accepts MPP (Machine Payments Protocol) on the same 402 (USDC on Base/Celo, or natively on Tempo), and prepaid card credits from https://agent402.tools/credits ($20/$50/$100 packs; `Authorization: Bearer a402_...`; debited only on a successful call; never expire).
- **Open source.** The full server is AGPL-3.0-licensed at https://github.com/MikeyPetrillo/Agent402 -- read every line, self-host, or fork.
- **Settlement.** All payments settle on-chain to `agent402.base.eth` on Base mainnet, verifiable on Basescan.
