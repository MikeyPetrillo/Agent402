# agent402-mcp

MCP server for [Agent402](https://agent402.tools) — **1,218 pay-per-call web tools** and **39 curated multi-tool skill packs** for AI agents, paid per call in USDC via the [x402 protocol](https://www.x402.org), or **with compute (proof-of-work)** when no wallet is configured. Built by [Mikey Petrillo](https://github.com/MikeyPetrillo).

Your agent gets browser rendering, screenshots, PDF text extraction, URL→markdown, live web search **+ web answers with citations**, live **financial/crypto/macro data** (Yahoo stock quotes, CoinGecko, FRED, ECB FX, World Bank, yield curve), **SEC EDGAR filings** (10-K/10-Q text, XBRL, insider, 13F, IPO calendar), **deterministic stats & forecasting** (Pearson correlation, OLS, Holt-Winters), **compression** (gzip/brotli), DNS/TLS/WHOIS + email-deliverability checks, wallet-keyed shared memory, and ~1,000 utility/conversion tools — plus 39 **skill packs** like `security-audit`, `trend-analysis`, `structured-scrape`, `decode-blob`, and `forecasting-bake-off` callable as MCP prompts. Payment handled invisibly underneath the MCP calls. No signup, no API key.

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

Without a wallet — the ~1,100 pure-CPU tools work free via proof-of-work (the network/browser/memory tools will ask for a wallet):

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
- The other ~1,185 tools are reachable via `search_tools` (find by description) + `call_tool` (call by slug) — keeping your context window small.
- When a call hits HTTP 402: with `AGENT_KEY` set, the server signs an x402 USDC payment and retries; without a key it solves the tool's proof-of-work challenge (~0.2 s of CPU) on the eligible tools.
- `payment_info` tells the model which mode it's in and what a wallet would unlock.
- `top_x402_sellers` returns the live x402 leaderboard — which sellers are settling the most USDC on Base in the last ~24h, derived from on-chain transfers. Free to call (no payment, no proof-of-work). Useful for agents discovering the wider x402 economy beyond this single service's catalog.

## Workflows (skill packs)

For jobs that no single tool covers (e.g. "audit a domain", "build a stock
brief"), Agent402 ships curated multi-tool **skill packs**. They're surfaced
as standard MCP **prompts**, so any MCP-aware client picks them up
automatically:

- `prompts/list` returns each pack with typed arguments.
- `prompts/get { name: "<slug>", arguments: { … } }` returns the rendered
  task template — a Claude-ready plan with the chosen tools wired in.
- `search_tools` also surfaces matching workflows alongside individual tools,
  so a task-shaped query points the agent at the right plan, not just the
  raw tools.

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
