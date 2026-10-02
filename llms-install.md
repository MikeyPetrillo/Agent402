# Agent402 - install instructions for AI agents

This file tells an AI coding agent how to install the Agent402 MCP server
into the client the user is running, with no API keys and no signup. The
hosted instance (`https://agent402.tools`) is free for the pure-CPU tools
(it pays a tiny proof-of-work for you); paid tools cost a few cents in USDC
on Base via the [x402 protocol](https://x402.org) or MPP (Machine Payments
Protocol), or by card through a prepaid credits key (`AGENT402_CREDITS_KEY`,
bought at `https://agent402.tools/credits`) for users without a wallet.

If the user has not stated a client, ask. Otherwise pick the matching
section below and apply the config.

## Claude Code (CLI)

Run once in the user's project directory:

```bash
claude mcp add agent402 -- npx -y agent402-mcp
```

To use the hosted server instead of the npm package:

```bash
claude mcp add --transport http agent402 https://agent402.tools/mcp
```

## Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config) and
add to `mcpServers`:

```json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp"]
    }
  }
}
```

For the hosted connector instead: claude.ai → Settings → Connectors → Add
custom connector → `https://agent402.tools/mcp`.

## Cline (VS Code extension)

Open the Cline MCP Servers panel and add:

```json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Cursor

Settings → MCP → Add new MCP server:

```json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp"]
    }
  }
}
```

## VS Code (built-in MCP support)

Add to `.vscode/mcp.json` in the workspace, or to the user-level `mcp.json`:

```json
{
  "servers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp"]
    }
  }
}
```

## What you get

A small set of dotted MCP tools that cover all 500+ underlying Agent402
tools (the older snake_case names such as `search_tools` / `call_tool` still
work as call aliases):

- Flagships, callable directly: `web.search`, `web.answer`, `web.news`,
  `browser.render`, `market.quote`, `audio.transcribe`, `memory.read`,
  `memory.write`.
- `catalog.search(query)` - lexical search across the catalog. Task-shaped
  queries also return matching multi-tool skill packs, which the server
  publishes as MCP prompts (`prompts/list` / `prompts/get`).
- `catalog.find(task)` - resolve a task description to the one best tool.
- `catalog.call(slug, params)` - invoke any tool; the server handles
  proof-of-work (free tier), x402 / MPP payment, or the prepaid credits key
  under the hood.
- `payment.info` - which mode the server is in (proof-of-work, wallet, or
  credits), the spend caps in force, what has been spent, and what a wallet
  unlocks.
- `server.describe` - what this connector is and how to use it.
- `sellers.list` - the live x402 seller leaderboard by settled USDC.
  Free to call, no payment and no proof-of-work.
- `route_and_execute(task, params, maxUsd)` - reach a tool OUTSIDE this
  catalog: Agent402 resolves a proven external x402 seller, pays it on your
  behalf, and relays the result marked `untrustedContent`. Needs a funded
  wallet. A flat routing fee by rung, one rung per band of underlying
  price (`route-execute`, `-plus`, `-max`, `-pro`); `GET /api/pricing`
  lists each rung's fee and ceiling.

Pure-CPU tools (150+ of them - hashing, encoding, parsing, regex, date
math, validators, converters, geo math) are free via proof-of-work and
need no wallet; `GET /api/pow` lists them. Paid tools (browser rendering,
web search, PDF tooling, live data, crypto reads) start at $0.001 per call
in USDC over x402 on Base or any other chain the 402 lists (Solana, Polygon,
Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar, Algorand, and
USDG on Robinhood Chain), over MPP, or from a prepaid card credits key.
Multi-tool skill packs cost the sum of the tools they run, less a bundle
discount. The finished report products under `/v1` (deep research, company
dossier, 13F fund report, domain audit, FDA recall, insider flow, SEC
filings, Solana token brief, token risk) are the same reports people buy by
card at `https://agent402.tools/reports`; the card price includes payment
processing, so an agent paying per call pays less for the same report.
`https://agent402.tools/api/pricing` has every current price.

## Verifying it works

After install, ask the agent to run a free tool - e.g. "use agent402 to
hash the string `hello world` with sha256". A successful response means
the MCP wiring + free tier are working.

## Self-hosting

Clone and run in free mode (no payments, no wallet):

```bash
git clone https://github.com/MikeyPetrillo/Agent402 && cd Agent402
npm install
FREE_MODE=true npm start          # → http://localhost:3000  (HTTP API + /mcp)
```

Point the MCP client at `http://localhost:3000/mcp` instead of the npm
package.
