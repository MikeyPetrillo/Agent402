# agent402-mcp

MCP server for [Agent402](https://agent402.tools) — 1,100+ pay-per-call web tools for AI agents, paid per call in USDC via the [x402 protocol](https://www.x402.org), or **with compute (proof-of-work)** when no wallet is configured. Built by [Mikey Petrillo](https://github.com/MikeyPetrillo).

Your agent gets browser rendering, screenshots, PDF text extraction, URL→markdown, live web search **+ web answers with citations**, live **financial/crypto/macro data** (Yahoo stock quotes, CoinGecko, FRED, ECB FX, World Bank, yield curve), **SEC EDGAR filings** (10-K/10-Q text, XBRL, insider, 13F, IPO calendar), DNS/TLS/WHOIS, wallet-keyed shared memory, and ~1,040 utility/conversion tools — with payment handled invisibly underneath the MCP calls. No signup, no API key.

## Quick start

**Zero install (hosted connector):** add `https://agent402.tools/mcp` as a remote
MCP server — e.g. claude.ai → Settings → Connectors → Add custom connector. The
pure-CPU tools run free there (rate-limited); for the full catalog and no rate
limit, run this package locally with a wallet:

With a funded wallet (USDC on Base) — every tool available:

```json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp"],
      "env": { "AGENT_KEY": "0xYOUR_PRIVATE_KEY" }
    }
  }
}
```

Without a wallet — the ~1000 pure-CPU tools work free via proof-of-work (the network/browser/memory tools will ask for a wallet):

```json
{
  "mcpServers": {
    "agent402": { "command": "npx", "args": ["-y", "agent402-mcp"] }
  }
}
```

Claude Code: `claude mcp add agent402 -- npx -y agent402-mcp`

## How it works

- On startup the server reads the live catalog from `https://agent402.tools/api/pricing` + `/openapi.json`.
- The high-value tools (`extract`, `render`, `screenshot`, `pdf`, `meta`, `dns`, `http-check`, `tls-cert`, `whois`, the `memory-*` coordination tools, `hash`) are exposed as first-class MCP tools.
- The other ~1000 tools are reachable via `search_tools` (find by description) + `call_tool` (call by slug) — keeping your context window small.
- When a call hits HTTP 402: with `AGENT_KEY` set, the server signs an x402 USDC payment and retries; without a key it solves the tool's proof-of-work challenge (~0.2 s of CPU) on the eligible tools.
- `payment_info` tells the model which mode it's in and what a wallet would unlock.

## Configuration

| env | default | meaning |
| --- | --- | --- |
| `AGENT_KEY` | _(unset)_ | Hex private key of a wallet funded with USDC on Base. Unset = proof-of-work mode. |
| `AGENT402_URL` | `https://agent402.tools` | Target service (point at your own deployment). |
| `AGENT402_TOOLS` | curated set | Comma-separated slugs to expose as first-class tools. |
| `AGENT402_MAX_PER_CALL` | unlimited | Refuse any single call priced above this many USD (e.g. `0.01`). |
| `AGENT402_BUDGET` | unlimited | Hard cap on total USDC spent per session (e.g. `1.00`). |

Spend controls are enforced **before a payment is signed** — a runaway model is
refused, not billed. `payment_info` reports the caps, what's been spent, and
what remains. Use a dedicated low-value wallet for `AGENT_KEY`, funded only
with what you intend to spend — calls cost $0.001–$0.02 each.

## Test

From the repo root: `node mcp/test.js` (boots a local paywalled instance and drives the MCP server with a real client; the proof-of-work path settles real challenges).
