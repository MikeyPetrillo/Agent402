# Agent402 + Claude Code

Add 500+ tools to Claude Code in one command.

## Install

```bash
claude mcp add agent402 -- npx agent402-mcp
```

That's it. Claude Code now has access to:
- `search_tools` - find the right tool for any task (returns slug, price and
  input schema; task-shaped queries also surface matching skill packs)
- `call_tool` - execute it (free via proof-of-work on the pure-CPU tools)
- `payment_info` - which mode the server is in, the spend caps, and what a
  funded wallet unlocks
- `list_top_sellers` - the live x402 seller leaderboard by settled USDC (free)
- `router.execute` - resolve and pay a proven external x402 seller in one
  call, result relayed back (needs a funded wallet)

Skill packs (multi-tool workflows) arrive as MCP prompts, so they show up in
Claude Code's slash-command list without any extra wiring.

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
