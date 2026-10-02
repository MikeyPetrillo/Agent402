# Agent402.Tools - Stellar x402 Integration

## What is Agent402?

Agent402.Tools is an open-source, self-hostable x402 + MCP server with 500+ pay-per-call tools and multi-tool skill packs for AI agents. Agents pay per API call in USDC over x402 (or MPP, the Machine Payments Protocol, on the same 402) - no signup, no API keys. The wallet IS the identity.

## Stellar Integration

Agent402 accepts USDC payments on Stellar via the x402 protocol through its own self-hosted x402 Stellar facilitator (open source, in this repository, live on mainnet since 2026-08-13; the OpenZeppelin channel service is the settlement fallback, and `STELLAR_FACILITATOR_URL` points a self-host at either). First confirmed Stellar settlement: July 4, 2026.

- **Facilitator:** self-hosted x402 Stellar facilitator (this repository), OpenZeppelin channel service as fallback
- **Asset:** USDC on Stellar (Soroban token contract `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`)
- **Seller wallet:** `GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL`
- **Settlement:** ~5 seconds, fees sponsored by facilitator
- **SDK:** `@x402/stellar` (npm)

## How It Works

1. An AI agent calls any Agent402 tool endpoint (e.g. `/api/stock-quote?symbol=AAPL`)
2. The server responds with HTTP 402 Payment Required, including `stellar:pubnet` as a payment option
3. The agent signs a Soroban authorization entry authorizing a USDC transfer
4. The facilitator verifies and settles the payment on-chain (~5 seconds)
5. The server returns the tool result

## Product Scope

- **500+ tools** - web search, browser rendering, PDFs, OCR, finance/EDGAR data, crypto market data, DNS/security, text processing, and 150+ pure-CPU utilities
- **Skill packs** - multi-tool workflows that solve entire agent jobs in one call (company research dossiers, domain security audits, crypto market briefs, financial analysis)
- **12 payment chains** - Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar, Algorand (USDC) and Robinhood Chain (USDG)
- **Free tier** - 150+ pure-CPU tools available via proof-of-work (no wallet needed)
- **MCP native** - works with Claude Code, Cursor, and any MCP-compatible agent
- **Open source** - https://github.com/MikeyPetrillo/Agent402
- **Buyer SDK** - `agent402-client` (npm) with auto-payment via PoW or x402
- **Tollbooth** - `agent402-tollbooth` lets site owners charge AI crawlers per page (x402 + MPP)
- **Report products** - deep research, company dossier, 13F fund report, SEC filing report, domain audit, token risk, FDA recall and insider flow reports ($0.60 to $2.00 per call) on the same paid endpoints, also sold by card at https://agent402.tools/reports for $2 to $5 (the card price includes payment processing); $5/month monitors at https://agent402.tools/monitors

## Why Stellar?

Stellar's sub-5-second finality and near-zero fees make it ideal for micropayments. With the x402 facilitator sponsoring gas, AI agents only need USDC - no XLM required. This lowers the barrier for agents that already hold USDC on Stellar to start using paid tools immediately.

## Links

- Website: https://agent402.tools
- GitHub: https://github.com/MikeyPetrillo/Agent402
- MCP endpoint: https://agent402.tools/mcp
- Discovery: https://agent402.tools/.well-known/x402
- npm: https://www.npmjs.com/package/agent402-mcp
- X/Twitter: https://x.com/Agent402Tools
- Contact: https://github.com/MikeyPetrillo/Agent402/issues (maintainer: Havok Holdings LLC)
