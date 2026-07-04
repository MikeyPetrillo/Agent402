# Agent402 + Claude Code

Add 1,355 tools to Claude Code in one command.

## Install

```bash
claude mcp add agent402 -- npx agent402-mcp
```

That's it. Claude Code now has access to:
- `search_tools` — find the right tool for any task
- `call_tool` — execute it (free via proof-of-work)
- `find_tool` — get full schema for a specific tool

## Example prompts

- "Search the web for the latest x402 news"
- "Get Apple's stock price and key financials"
- "Look up the WHOIS data for stripe.com"
- "Generate a QR code for https://agent402.tools"

## Paid tools (optional)

For wallet-only tools (search, finance, EDGAR), add a funded wallet:

```bash
claude mcp add agent402 -- npx agent402-mcp
# Then set env: AGENT_KEY=0x<private-key-with-USDC>
```

## Links
- [Full tool catalog](https://agent402.tools/tools)
- [MCP documentation](https://agent402.tools/docs)
- [GitHub](https://github.com/MikeyPetrillo/Agent402)
