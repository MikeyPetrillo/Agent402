# Integration Playbook — Agent402 Ecosystem Expansion

Quick-reference for registering Agent402 on platforms and marketplaces.

## Circle Agent Marketplace

**URL:** https://agents.circle.com/services
**Status:** Not yet listed

Circle's Agent Marketplace lets AI agents discover, evaluate, and pay for services
via x402 + USDC nanopayments. Agent402 is a natural fit — we already speak x402.

**Steps:**
1. Visit https://agents.circle.com/services
2. Click "Submit your service" (or equivalent intake form)
3. Provide:
   - Service name: `Agent402.Tools`
   - URL: `https://agent402.tools`
   - Description: "1,355 deterministic pay-per-call tools for AI agents (search, finance, EDGAR, crypto, PDFs, OCR, and more). x402 native."
   - Payment: x402 / USDC on Base (primary), Solana, Polygon, Arbitrum
   - MCP endpoint: `https://agent402.tools/mcp`
   - Discovery: `https://agent402.tools/.well-known/x402`
   - Tool count: 1,355 + 48 skill packs
4. Reference our Bazaar registration (already indexed by Coinbase CDP)

**Why it matters:** Circle has "high enterprise visibility" — their marketplace is where
corporate agents look first. Being listed here = discovery by enterprise buyers.

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
   - Role: x402 seller (1,355 tool endpoints, 1,500+ settlements)
   - Open source: https://github.com/MikeyPetrillo/Agent402
   - Contribution: First large-scale open-source x402 tool marketplace; ships
     agent402-tollbooth (pay-per-crawl) and agent402-client (buyer SDK)

**Why it matters:** Foundation membership = credibility + influence on the protocol.
Agent402 is one of the most active x402 sellers by endpoint count.

---

## AWS Bedrock AgentCore

**Status:** Already discoverable (via Bazaar MCP server in AgentCore)
**Opportunity:** Get featured in AWS docs/blog as an example x402 seller

AgentCore ships a managed Bazaar MCP server — Agent402's 1,355 endpoints are already
in the Bazaar. The opportunity is being a *featured* example in the AWS getting-started
guide for AgentCore Payments.

**Action:** Reach out to the AWS AgentCore team (via the x402 Foundation once joined,
or via the GitHub sample repo: github.com/aws-samples/sample-agentcore-cloudfront-x402-payments).

---

## Stripe ACP (Agentic Commerce Protocol)

**Status:** Building `/acp/feed` endpoint (this session)

Stripe + OpenAI + Meta's open standard for agent commerce. Once our ACP feed is live,
any agent using Stripe's payment rails can discover Agent402 tools programmatically.

**Endpoint:** `GET https://agent402.tools/acp/feed`

---

## Cloudflare Agents SDK

**Status:** Building integration docs (this session)

Cloudflare has first-class x402 support (`withX402`, `paidTool`). Our docs show
CF developers how to use Agent402 as a tool provider from their Workers/Agents.

---

## Apify

**URL:** https://apify.com (they launched x402 integration)
**Opportunity:** Cross-listing / partnership. They have 20,000+ tools on x402.
Complementary catalog (their tools are web scraping; ours are computation + data).
