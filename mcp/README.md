# agent402-mcp

MCP server for [Agent402](https://agent402.tools), the applied layer of [Agentic Finance](https://agent402.tools/agentic-finance) - a catalog of **500+: 400+ pay-per-call web tools + 100+ curated multi-tool skill packs** for AI agents (every one tested, priced, and settled on-chain; every one earns its place), paid per call in USDC via the [x402 protocol](https://www.x402.org), **with compute (proof-of-work)** when no wallet is configured, or **by card** through a prepaid credits key. (The hosted API is dual-stack: it also accepts [MPP](https://agent402.tools/what-is-mpp) clients on the same 402, settling on Base/Celo or natively on Tempo; this package pays via x402 or credits.) Built by [Havok Holdings LLC](https://github.com/MikeyPetrillo/Agent402).

Your agent gets browser rendering, screenshots, PDF text extraction, URL→markdown, live web search **+ web answers with citations**, live **financial/crypto/macro data** (Yahoo stock quotes, CoinGecko, FRED, ECB FX, World Bank, yield curve), **SEC EDGAR filings** (10-K/10-Q text, XBRL, insider, 13F, IPO calendar), **deterministic stats & forecasting** (Pearson correlation, OLS, Holt-Winters), **compression** (gzip/brotli), DNS/TLS/WHOIS + email-deliverability checks, wallet-keyed shared memory, and 200+ deterministic pure-CPU utilities - plus 100+ **skill packs** like `security-audit`, `trend-analysis`, `structured-scrape`, `decode-blob`, and `forecasting-bake-off` callable as MCP prompts, and the **report products** (deep research, company dossier, 13F fund report, domain audit, token risk, FDA recall, insider flow, market brief) as ordinary catalog slugs. Payment handled invisibly underneath the MCP calls. No signup, no API key.

## Quick start

**Zero install (hosted connector):** add `https://agent402.tools/mcp` as a remote
MCP server - e.g. claude.ai → Settings → Connectors → Add custom connector. The
pure-CPU tools run free there (rate-limited), and the paid tools are payable
right on the connector over [MPP](https://agent402.tools/what-is-mpp): a paid
call answers JSON-RPC error `-32042` with the challenges (`-32043` if a presented credential was refused), and an MCP client
wrapped with `mppx`'s `McpClient.wrap()` (USDC on Base/Celo, or native Tempo)
pays and retries on its own, receipt in `_meta`. For no rate limit, or to pay
over x402 or by card instead, run this package locally:

With a funded wallet (USDC on Base, Polygon, Arbitrum, Monad, or Solana, or USDG on Robinhood Chain - the underlying service accepts 12 chains in total, but this package currently signs only EVM and Solana payments) - every tool available:

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

With prepaid card credits (no wallet) - buy a pack at https://agent402.tools/credits, claim the `a402_...` key once, and every tool is available:

```json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp"],
      "env": { "AGENT402_CREDITS_KEY": "a402_YOUR_KEY" }
    }
  }
}
```

Without a wallet or credits key - the 200+ pure-CPU tools work free via proof-of-work (the network/browser/memory tools will ask for a wallet or a credits key):

```json
{
  "mcpServers": {
    "agent402": { "command": "npx", "args": ["-y", "agent402-mcp"] }
  }
}
```

Claude Code: `claude mcp add agent402 -- npx -y agent402-mcp`

## Configuration

Every variable the server reads (all optional):

| env | default | meaning |
| --- | --- | --- |
| `AGENT_KEY` | _(unset)_ | Hex private key of an EVM wallet funded with USDC on Base (or Polygon/Arbitrum/Monad), or USDG on Robinhood Chain. |
| `SOLANA_AGENT_KEY` | _(unset)_ | Base58 secret key (or JSON byte array) of a Solana wallet funded with USDC on Solana. |
| `AGENT402_CREDITS_KEY` | _(unset)_ | A prepaid card-credits key (`a402_...`) from https://agent402.tools/credits. Sent as `Authorization: Bearer` on every catalog call; the server debits the list price only on a successful (200) call and answers `X-Credits-Balance`. Used only when no wallet key is set (a wallet key wins); in credits mode every call - pure-CPU tools included - is debited from the key. |
| `AGENT402_URL` | `https://agent402.tools` | Target service (point at your own deployment). |
| `AGENT402_TOOLS` | curated set | Comma-separated slugs to expose as first-class tools. |
| `AGENT402_MAX_PER_CALL` | unlimited | Refuse any single call priced above this many USD (e.g. `0.01`). Applies to the wallet and the credits path. |
| `AGENT402_BUDGET` | unlimited | Hard cap on total USD spent per session (e.g. `1.00`). Applies to the wallet and the credits path. |
| `AGENT402_NETWORKS` | _(unset)_ | Restrict + order the chains to pay on - e.g. `robinhood` (USDG on Robinhood Chain), `base,solana`, or a raw CAIP-2 like `eip155:4663`. Unset = the client picks (effectively Base on multi-chain sellers). |

Spend controls are enforced **before a payment is signed** (or a credits call is
sent) - a runaway model is refused, not billed. `payment.info` reports the
caps, what's been spent, and what remains. With no wallet key and no credits key,
the server runs in proof-of-work mode (pure-CPU tools stay free). Use dedicated
low-value wallets for `AGENT_KEY` / `SOLANA_AGENT_KEY`, funded only with what
you intend to spend. Most tools cost $0.001–$0.02. The routing tiers top out
at $0.55 (`route-execute-max`); multi-tool skill packs run up to $1.50; and the
report products run $0.20 to $1.10 per report (domain-audit $0.20 up to research-max $1.10),
so set `AGENT402_MAX_PER_CALL` if you want a hard per-call ceiling.

## How it works

- On startup the server reads the live catalog from `https://agent402.tools/api/pricing` + `/openapi.json`.
- **Flagship tools** are exposed as first-class MCP tools under dotted names - `web.search`, `web.answer`, `web.news`, `browser.render`, `market.quote`, `audio.transcribe`, `memory.read`, `memory.write` - search/answer is the front door. Override the set with `AGENT402_TOOLS` (slugs; a non-flagship slug is listed as its snake_case name).
- The rest of the 500+ endpoint catalog is reachable via the meta tools `catalog.search` / `catalog.find` + `catalog.call` - keeping your context window small. The same dotted names are listed on the hosted connector; the older snake names (`search_tools`, `find_tool`, `call_tool`, `get_payment_info`, `describe_server`, `list_top_sellers`, and the flagship `search_web` …) remain accepted as CallTool aliases, so existing configs keep working.
- When a call hits HTTP 402: with a wallet key set (`AGENT_KEY` for the EVM chains - Base/Polygon/Arbitrum/Monad plus Robinhood Chain, `SOLANA_AGENT_KEY` for Solana), the server signs an x402 payment on a chain the seller accepts and retries; with only a credits key it sends `Authorization: Bearer a402_…` and the server debits the balance on success; with neither it solves the tool's proof-of-work challenge (~0.2 s of CPU) on the eligible tools. (The service settles USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar and Algorand, plus USDG on Robinhood Chain - 12 chains total - for callers using a raw x402 client rather than this package.)
- `payment.info` tells the model which mode it's in and what a wallet or a credits key would unlock.
- `server.describe` returns orientation (flagship-first tools, install one-liners, free vs paid, discovery URLs). Call it first.
- `sellers.list` returns the live leaderboards - `wire: "x402"` (default) ranks x402 sellers settling the most USDC (primarily on Base) in the last ~24h from on-chain transfers; `wire: "mpp"` ranks live-verified MPP sellers by inbound USDC.e transfers on Tempo. Free to call (no payment, no proof-of-work). Useful for agents discovering the wider x402 / MPP economy beyond this single service's catalog.
- `route_and_execute` reaches tools **outside** this catalog in one call: give it a plain-language `task` and Agent402 resolves a proven external x402 seller (one with real on-chain settled volume), pays that seller on your behalf, and relays the result marked `untrustedContent`. Wallet-only. Flat routing fee, cheapest covering tier chosen from `maxUsd`:

  | Underlying seller price | Fee | Route |
  | --- | --- | --- |
  | ≤ $0.005 | $0.01 | `POST /api/route/execute` |
  | ≤ $0.04 | $0.05 | `POST /api/route/execute-plus` |
  | ≤ $0.50 | $0.55 | `POST /api/route/execute-max` |

  A tool priced above the tier's ceiling returns a self-correcting 409 naming its direct route.
- **Report products** are catalog slugs like any other, so `catalog.call` runs them with a wallet or a credits key: `research` ($0.35), `research-pro` ($0.65), `research-max` ($1.10), `market-brief` ($0.35), `dossier` ($0.55), `dossier-max` ($0.95), `fund-report` ($0.25), `fund-report-max` ($0.50), `domain-audit` ($0.20), `domain-audit-pro` ($0.30), `token-risk` ($0.30), `token-risk-pro` ($0.60), `token-brief` ($0.35), `recall-report` ($0.20), `insider-report` ($0.25), `filing-report` ($0.25), `ticker-pack` ($0.75). The same reports are sold to people by card at https://agent402.tools/reports for $1, or $2 for the deepest three: the card price includes payment processing, and an agent paying per call pays the lower tool price for the same report. The recurring monitors (domain, SEC filing, token, fund, recall, insider, IPO - $3/month) are at https://agent402.tools/monitors.

## Workflows (skill packs)

For jobs that no single tool covers (e.g. "audit a domain", "build a stock
brief"), Agent402 ships curated multi-tool **skill packs**. They're surfaced
as standard MCP **prompts**, so any MCP-aware client picks them up
automatically:

- `prompts/list` returns each pack with typed arguments.
- `prompts/get { name: "<slug>", arguments: { … } }` returns the rendered
  task template - a Claude-ready plan with the chosen tools wired in.
- `catalog.search` also surfaces matching workflows alongside individual tools,
  so a task-shaped query points the agent at the right plan, not just the
  raw tools.

## Test

From the repo root: `node mcp/test.js` (boots a local paywalled instance and drives the MCP server with a real client; the proof-of-work path settles real challenges).

## Legal

Use of the hosted instance at agent402.tools is subject to its [Terms of Service](https://agent402.tools/terms) (acceptable-use policy included) and [Privacy Policy](https://agent402.tools/privacy). This package is MIT-licensed; the hosted server is AGPL-3.0. Both are provided as-is without warranty, and self-hosted deployments are their operator's responsibility.
