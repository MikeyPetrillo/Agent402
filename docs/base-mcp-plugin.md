---
title: "Agent402 Plugin"
description: "Discover and call 1,338 pay-per-call web tools via x402 USDC payments on Base, Solana, Polygon & Arbitrum through Agent402.tools"
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
> ## STOP — COMPLETE ONBOARDING BEFORE USING THIS PLUGIN
> Complete the Base MCP onboarding in SKILL.md first. You must have a funded Base wallet with USDC to call paid tools. Run `get_wallets` to confirm your wallet address and USDC balance before proceeding.

## Overview

Agent402 is an open-source x402 tool server hosting 1,338 deterministic, pay-per-call web tools for AI agents at `https://agent402.tools`. Tools span browser rendering, web search, PDFs, OCR, image processing, financial data, crypto analytics, SEC EDGAR filings, unit conversions, encoding, hashing, and wallet-keyed memory. Every tool is called over HTTP: the agent receives an HTTP 402 response with exact USDC payment terms, pays via x402, and gets the result. Prices range $0.001--$0.02 per call. No signup, no API key -- the payment is the only credential.

Agent402 exposes free discovery endpoints (no payment required) that resolve tasks to the right tool, plus paid tool endpoints that settle via x402 USDC on Base, Solana, Polygon, or Arbitrum. This plugin teaches agents to discover tools, understand pricing, and call any tool using Base MCP's `initiate_x402_request` / `complete_x402_request` flow.

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
      "slug": "convert-miles-to-kilometers",
      "name": "Miles to Kilometers",
      "route": "GET /api/convert/miles-to-kilometers",
      "price": "$0.001",
      "callExample": {
        "method": "GET",
        "path": "/api/convert/miles-to-kilometers",
        "query": { "value": "26.2" }
      },
      "example": { "value": "26.2" },
      "required": ["value"],
      "inputSchema": {
        "type": "object",
        "properties": { "value": { "type": "string" } },
        "required": ["value"]
      },
      "category": "convert",
      "description": "Convert miles to kilometers.",
      "computePayable": true,
      "docs": "https://agent402.tools/tools/convert-miles-to-kilometers"
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
      "method": "GET",
      "path": "/api/convert/miles-to-kilometers",
      "price": "$0.001",
      "category": "convert",
      "slug": "convert-miles-to-kilometers",
      "description": "Convert miles to kilometers.",
      "docs": "https://agent402.tools/tools/convert-miles-to-kilometers",
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

**GET tools** (conversions, lookups): pass parameters as query strings.
Example: `https://agent402.tools/api/convert/miles-to-kilometers?value=26.2`

**POST tools** (browser, search, extract, memory): pass parameters as JSON body.
Example: `https://agent402.tools/api/extract` with body `{"url": "https://example.com"}`

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

**For a GET tool** (e.g. `convert-miles-to-kilometers`):
```
callExample: { method: "GET", path: "/api/convert/miles-to-kilometers", query: { value: "26.2" } }
```
Map to `initiate_x402_request`:
```json
{
  "url": "https://agent402.tools/api/convert/miles-to-kilometers?value=26.2",
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
2. Read the top result's `callExample`: method GET, path `/api/convert/miles-to-kilometers`, query `{value: "26.2"}`
3. Call `initiate_x402_request` with url `https://agent402.tools/api/convert/miles-to-kilometers?value=26.2`, method GET, maxPayment `"0.01"`
4. User approves the ~$0.001 USDC payment
5. Call `complete_x402_request` with the requestId to get the conversion result

**Prompt:** "Extract the main article content from https://example.com/blog/post"

1. Discover: `GET https://agent402.tools/api/find?q=extract%20article%20from%20url`
2. Top result is `extract` (POST /api/extract, $0.004/call)
3. Call `initiate_x402_request` with url `https://agent402.tools/api/extract`, method POST, body `{"url": "https://example.com/blog/post"}`, maxPayment `"0.01"`
4. User approves the ~$0.004 USDC payment
5. Call `complete_x402_request` to get clean markdown of the article

**Prompt:** "What are the top x402 sellers right now?"

1. Read: `GET https://agent402.tools/api/leaderboard?top=10&sort=usd&include=external`
2. Display the ranked sellers with their USDC volume, call counts, and unique buyers
3. No payment needed -- the leaderboard is a free endpoint

**Prompt:** "Search the web for recent news about Base blockchain"

1. Discover: `GET https://agent402.tools/api/find?q=web%20search%20news`
2. Top result is `search-news` (POST /api/search/news, $0.005/call)
3. Call `initiate_x402_request` with url `https://agent402.tools/api/search/news`, method POST, body `{"q": "Base blockchain"}`, maxPayment `"0.01"`
4. User approves the ~$0.005 USDC payment
5. Call `complete_x402_request` to get the search results

## Notes

- **No signup or API key required.** The USDC payment via x402 is the only credential. The wallet address is the identity.
- **Deterministic tools.** No LLM in the serving path -- same input always yields the same output. Results are trustworthy and reproducible.
- **Idempotency.** For safe retries, pass an `Idempotency-Key` header. If the same key + endpoint is replayed, the cached result is returned without re-charging.
- **Price range.** All tools cost $0.001--$0.02 per call. Use a `maxPayment` of `"0.05"` or less for any single tool. Check exact prices via `/api/find` or `/api/pricing`.
- **Free discovery.** The endpoints `/api/find`, `/api/pricing`, `/api/route`, `/api/leaderboard`, `/.well-known/x402`, and `/api/reliability` are all free and require no payment.
- **MCP connector.** For direct MCP access (outside Base MCP), paste `https://agent402.tools/mcp` into any MCP client. Pure-CPU tools run free there (rate-limited); paid tools require the `agent402-mcp` npm package with a funded wallet.
- **Open source.** The full server is MIT-licensed at https://github.com/MikeyPetrillo/Agent402 -- read every line, self-host, or fork.
- **Settlement.** All payments settle on-chain to `agent402.base.eth` on Base mainnet, verifiable on Basescan.
