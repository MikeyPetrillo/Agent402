# MCP Connector

Agent402 speaks [MCP](https://modelcontextprotocol.io) two ways. Both are listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.MikeyPetrillo/agent402) under `io.github.MikeyPetrillo/agent402`.

## 1. Hosted connector — zero install (the free tier)

Add **`https://agent402.tools/mcp`** as a remote MCP server:

- **claude.ai / Claude mobile:** Settings → Connectors → *Add custom connector* → name `Agent402`, that URL, no auth.
- **Claude Code:** `claude mcp add --transport http agent402 https://agent402.tools/mcp`
- Any client speaking **streamable HTTP** (the endpoint is stateless — every JSON-RPC message is self-contained).

It exposes three read-only tools (each carries safety annotations):

| Tool | Does |
|---|---|
| `search_tools` | Find tools by description across the catalog; returns slugs + input schemas |
| `call_tool` | Execute a tool by slug. The ~1,040 pure-CPU tools run **free** (rate-limited: 20/min, 120/hr per client); wallet-only tools return paid-path instructions instead of executing |
| `about_agent402` | Service description, free-vs-paid breakdown |

## 2. `agent402-mcp` (npm) — the full catalog, payment underneath

```json
{ "mcpServers": { "agent402": {
  "command": "npx", "args": ["-y", "agent402-mcp"],
  "env": {
    "AGENT_KEY": "0x<funded wallet key — optional>",
    "AGENT402_BUDGET": "1.00",
    "AGENT402_MAX_PER_CALL": "0.01"
  }
} } }
```

- **With `AGENT_KEY`** (a wallet holding USDC on Base): every tool works; each call settles via x402 invisibly under the MCP call. Spend controls (`AGENT402_BUDGET`, `AGENT402_MAX_PER_CALL`) are enforced *before any payment is signed*.
- **Without a key:** the pure-CPU tools work free via proof-of-work; wallet-only tools explain what they'd cost and how to enable them.

High-value tools (`search`, `extract`, `render`, `screenshot`, `pdf`, `meta`, `dns`, the `memory-*` family, …) are first-class MCP tools; the long tail is reachable via `search_tools` + `call_tool` to keep your context window small.

Other env knobs: `AGENT402_URL` (target service), `AGENT402_TOOLS` (override the first-class tool list).

## Choosing between them

| | Hosted `/mcp` | npm `agent402-mcp` |
|---|---|---|
| Install | none | `npx` |
| Works in claude.ai | ✅ | ❌ (stdio is Desktop/Code only) |
| Pure-CPU tools | free, rate-limited | free (PoW), unlimited |
| Search/browser/PDF/memory | ❌ (refused with guidance) | ✅ with a funded wallet |
| Identity | anonymous | your wallet = your identity (unlocks [[Memory and Coordination]]) |
