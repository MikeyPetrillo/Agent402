# Agent402 — install instructions for AI agents

This file tells an AI coding agent how to install the Agent402 MCP server
into the client the user is running, with no API keys and no signup. The
hosted instance (`https://agent402.tools`) is free for the pure-CPU tools
(it pays a tiny proof-of-work for you); paid tools cost a few cents in USDC
on Base via the [x402 protocol](https://x402.org).

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

Four MCP tools that cover all 1,275 underlying Agent402 tools:

- `search_tools(query)` — lexical search across the catalog.
- `find_tool(query)` — the single best-match tool with its input schema.
- `call_tool(slug, input)` — invoke any tool; the server handles
  proof-of-work (free tier) or x402 payment (paid tier) under the hood.
- `about_agent402` — server metadata, pricing model, links.

Pure-CPU tools (~1,040 of them — hashing, encoding, parsing, regex, date
math, validators, converters, geo math) are free via proof-of-work and
need no wallet. Paid tools (browser rendering, web search, PDF tooling,
live data, crypto reads) cost $0.001–$0.02 in USDC on Base; see
`https://agent402.tools/api/pricing`.

## Verifying it works

After install, ask the agent to run a free tool — e.g. "use agent402 to
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
