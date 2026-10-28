# Agent402 plugin for Claude Code

The Agent402 plugin connects Claude Code to Agent402.Tools, a catalog of 500+ web tools that AI agents call one request at a time. It adds one MCP server, so Claude can search the catalog and call any tool in it: web search and answers, page rendering, SEC filings, market data, conversions, and utilities.

## What it does

- Adds the Agent402 MCP server at `https://agent402.tools/mcp`.
- Lets Claude find the right tool for a task with `catalog.find`, then call it.
- Shows each tool's price in its catalog entry, so you can see what a call costs before you make it.

## How you pay

- **Free, with proof-of-work.** Pure-compute tools (no outbound calls, keys or models) run free through a proof-of-work challenge, with no account and no wallet.
- **Per call, in USDC.** Paid tools settle over x402 or MPP on supported chains. On x402, a call the server answers with an error is not charged; settlement runs only after a successful answer.
- **Prepaid credits key.** If you already hold an `a402_...` credits key, set it as `AGENT402_CREDITS_KEY` to pay from that balance. New credits are not on sale.

## Install

```
/plugin marketplace add MikeyPetrillo/Agent402
/plugin install agent402 --marketplace MikeyPetrillo/Agent402
```

## Find and call a tool

Ask Claude for what you need. It uses `catalog.find` with your task, then calls the best match. You can also ask it to search the catalog by name.

## Privacy

See the privacy policy at https://agent402.tools/privacy.

## License

AGPL-3.0-or-later. Published by Havok Holdings LLC.
