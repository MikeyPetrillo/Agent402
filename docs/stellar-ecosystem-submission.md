# Agent402.Tools - Stellar x402 Integration

## What is Agent402?

Agent402.Tools is an open-source, self-hostable x402 + MCP server with 500+ pay-per-call tools and 100+ multi-tool skill packs for AI agents. Agents pay per API call in USDC over x402 (or MPP, the Machine Payments Protocol, on the same 402) - no signup, no API keys. The wallet IS the identity.

## Stellar Integration

Agent402 accepts USDC payments on Stellar via the x402 protocol through an x402 Stellar facilitator (the OpenZeppelin channel service is the default; a self-hosted facilitator is supported via `STELLAR_FACILITATOR_URL`). First confirmed Stellar settlement: July 4, 2026.

- **Facilitator:** x402 Stellar facilitator (OpenZeppelin channel service by default, or self-hosted)
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

- **500+ tools** - web search, browser rendering, PDFs, OCR, finance/EDGAR data, crypto market data, DNS/security, text processing, and 200+ pure-CPU utilities
- **100+ skill packs** - multi-tool workflows that solve entire agent jobs in one call (company research dossiers, domain security audits, crypto market briefs, financial analysis)
- **12 payment chains** - Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar, Algorand (USDC) and Robinhood Chain (USDG)
- **Free tier** - 200+ pure-CPU tools available via proof-of-work (no wallet needed)
- **MCP native** - works with Claude Code, Cursor, and any MCP-compatible agent
- **Open source** - https://github.com/MikeyPetrillo/Agent402
- **Buyer SDK** - `agent402-client` (npm) with auto-payment via PoW or x402
- **Tollbooth** - `agent402-tollbooth` lets site owners charge AI crawlers per page (x402 + MPP)
- **Report products** - deep research, company dossier, 13F fund report, SEC filing report, domain audit, token risk, FDA recall and insider flow reports ($0.20-$1.10) on the same paid endpoints, also sold by card at https://agent402.tools/reports for $1-$2 (the card price includes payment processing); $3/month monitors at /monitors; prepaid card credits at /credits

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
