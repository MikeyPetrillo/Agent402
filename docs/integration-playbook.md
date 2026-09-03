# Integration Playbook - Agent402 Ecosystem Expansion

Quick-reference for registering Agent402 on platforms and marketplaces.

## Circle Agent Marketplace

**URL:** https://agents.circle.com/services
**Status:** Not yet listed

Circle's Agent Marketplace lets AI agents discover, evaluate, and pay for services
via x402 + USDC nanopayments. Agent402 is a natural fit - we already speak x402.

**Steps:**
1. Visit https://agents.circle.com/services
2. Click "Submit your service" (or equivalent intake form)
3. Provide:
   - Service name: `Agent402.Tools`
   - URL: `https://agent402.tools`
   - Description: "500+ pay-per-call tools for AI agents (search, finance, EDGAR, crypto, PDFs, OCR, and more), plus report products ($0.20-$1.10 deep research, dossier, fund, SEC filing, domain audit, token risk, recall, insider; $1-$2 by card) and $3/month monitors. x402 native; MPP on the same 402; free proof-of-work tier; prepaid card credits."
   - Payment: x402 / USDC on Base (primary), Solana, Polygon, Arbitrum, Monad,
     Celo, Avalanche, Sei, Optimism, Stellar, Algorand, plus USDG on Robinhood
     Chain (12 chains); MPP (Base/Celo, native Tempo); card credits
   - MCP endpoint: `https://agent402.tools/mcp`
   - Discovery: `https://agent402.tools/.well-known/x402`
   - Tool count: 500+ (400+ tools + 100+ skill packs)
4. Reference our Bazaar registration (already indexed by Coinbase CDP)

---

## x402 Foundation Membership

**URL:** https://www.linuxfoundation.org/x402foundation/
**Status:** Not yet a member

The x402 Foundation (Linux Foundation) governs the protocol. 20+ founding members
include Google, Visa, Stripe, AWS, Mastercard, Circle, Microsoft, Shopify, Anthropic.

**Steps:**
1. Visit https://www.linuxfoundation.org/x402foundation/
2. Click membership application / "Join" link
3. Apply as: Individual / Startup tier (likely free or nominal)
4. Provide:
   - Project: Agent402.Tools (https://agent402.tools)
   - Role: x402 seller (500+ tool endpoints, settled on-chain; verifiable on the
     revenue wallet and at https://agent402.tools/revenue)
   - Open source: https://github.com/MikeyPetrillo/Agent402
   - Contribution: open-source x402 + MPP tool server; ships agent402-tollbooth
     (pay-per-crawl, x402 + MPP + native Tempo) and agent402-client (buyer SDK)

---

## AWS Bedrock AgentCore

**Status:** Already discoverable (via Bazaar MCP server in AgentCore)
**Opportunity:** Get featured in AWS docs/blog as an example x402 seller

AgentCore ships a managed Bazaar MCP server - Agent402's 500+ endpoints are already
in the Bazaar. The opportunity is being a *featured* example in the AWS getting-started
guide for AgentCore Payments.

**Action:** Reach out to the AWS AgentCore team (via the x402 Foundation once joined,
or via the GitHub sample repo: github.com/aws-samples/sample-agentcore-cloudfront-x402-payments).

---

## Stripe ACP (Agentic Commerce Protocol)

**Status:** Live - `GET https://agent402.tools/acp/feed` serves the full tool
catalog as ACP products (`src/acp.js`).

The open standard for agent commerce. Any agent reading ACP feeds can discover
Agent402 tools programmatically.

---

## Cloudflare Agents SDK

**Status:** Integration guide written - `docs/cloudflare-agents.md`.

Cloudflare has first-class x402 support (`withX402`, `paidTool`). The guide shows
how a Worker or Agent discovers and calls Agent402 tools, and how to connect the
hosted MCP endpoint.

---

## Apify

**URL:** https://apify.com (x402 integration available)
**Opportunity:** Cross-listing. Agent402 tools are callable from any x402 client,
so a listing there needs only the catalog URL + `/.well-known/x402`.
