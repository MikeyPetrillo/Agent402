# agent402-mcp

MCP server for [Agent402](https://agent402.tools), the applied layer of Agentic Finance: a catalog of **500+ web tools** that AI agents call one request at a time, paid per call in USDC over x402 or MPP (Machine Payments Protocol). Pure-CPU tools are free: each call solves a small proof-of-work puzzle on your own machine. Other tools are paid per call in USDC over the [x402 protocol](https://www.x402.org) from a wallet you control. Built by [Havok Holdings LLC](https://github.com/MikeyPetrillo/Agent402).

## Quick start

Pick one setup. Both run locally through `npx`.

**1. Free, no wallet.** Pure-CPU tools (no outbound calls, keys or models) run free. Each call solves a proof-of-work puzzle with your CPU, typically well under a second on a laptop. Tools that reach the network or a model ask for a wallet.

```
claude mcp add agent402 -s user -- npx -y agent402-mcp@0.13.20
```

**2. Paid, with a wallet.** Paid tools are settled in USDC on each call.

```json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp@0.13.20"],
      "env": { "AGENT_KEY": "0xYOUR_PRIVATE_KEY" }
    }
  }
}
```

> Use a new wallet holding only a few dollars of USDC. Never use your main wallet.

Use `SOLANA_AGENT_KEY` instead for USDC on Solana. Each call is capped at $4 by default; there is no session budget unless you set `AGENT402_BUDGET`.

Claude Code with a wallet: `claude mcp add agent402 -s user -e AGENT_KEY=0xYOUR_PRIVATE_KEY -- npx -y agent402-mcp@0.13.20`
(use a new wallet holding only a few dollars of USDC; never your main wallet).

Advanced setup (chains, MPP, error codes, the hosted connector) is in [Advanced](#advanced).

## Configuration

Every variable the server reads (all optional):

| env | default | meaning |
| --- | --- | --- |
| `AGENT_KEY` | _(unset)_ | Hex private key of an EVM wallet funded with USDC on Base (or another EVM chain the server offers), or USDG on Robinhood Chain. |
| `SOLANA_AGENT_KEY` | _(unset)_ | Base58 secret key (or JSON byte array) of a Solana wallet funded with USDC on Solana. |
| `AGENT402_CREDITS_KEY` | _(unset)_ | A prepaid credits key (`a402_...`) already issued (new credits are not on sale). Sent as `Authorization: Bearer` on every catalog call; the server debits the list price only on a successful (200) call and answers `X-Credits-Balance`. Used only when no wallet key is set (a wallet key wins); in credits mode every call - pure-CPU tools included - is debited from the key. |
| `AGENT402_URL` | `https://agent402.tools` | Target service (point at your own deployment). Paid calls never follow redirects, so use the address that serves the routes directly; a redirect is refused with the origin to use. |
| `AGENT402_TOOLS` | curated set | Comma-separated slugs to expose as first-class tools. |
| `AGENT402_MAX_PER_CALL` | `4` | Refuse any single call priced above this many USD (e.g. `0.05`); `off` disables it. Applies to the wallet and the credits path. |
| `AGENT402_BUDGET` | _(unset, no cap)_ | Optional hard cap on total USD spent per session (e.g. `1.00`); unset or `off` means no session cap. Applies to the wallet and the credits path. |
| `AGENT402_SHOW_ROUTER` | _(unset)_ | `1` lists `router.execute` and `sellers.list` even without a wallet. Both are listed automatically when a wallet or credits key is set. |
| `AGENT402_NETWORKS` | _(unset)_ | Restrict + order the chains to pay on - e.g. `robinhood` (USDG on Robinhood Chain), `base,solana`, or a raw CAIP-2 like `eip155:4663`. Unset = the client picks (effectively Base on multi-chain sellers). |
| `AGENT402_ASYNC` | `auto` | Slow routes (reports, video, the premium image; `async.recommended` on their `/api/pricing` row) are paid with `Prefer: respond-async` and collected from their job link, so a long run never outlives the connection. `off` waits on the connection instead (since 0.13.18 sending `Prefer: wait=<maxSeconds>` where the row gives `async.preferWait`); `always` uses a job on every route that runs as one. |
| `AGENT402_ASYNC_TIMEOUT_MS` | `900000` | How long to poll a job before answering with its link (`structuredContent.jobUrl`) to collect later. |

The per-call cap is on by default and the session budget is opt-in; both are
enforced on the payment that is signed (or before a credits call is sent) - a
runaway model is refused, not billed. The
wallet's x402 client carries a policy that drops every payment option over the
per-call cap or what is left of the budget, so the 402 the wallet signs is held
to the caps, and a wallet call sends no unpaid preflight first. Each option is priced from the
known decimals of its asset (USDC on each rail, USDG on Robinhood Chain), never
from a decimals value in the challenge, and an option in any other asset is not
signed. A value that is not a USD amount or `off` reads as the default (the
$4 per-call cap and no session budget). Set `AGENT402_BUDGET` to cap the session total.
`payment.info` reports the caps, what's been spent, and what remains. With no wallet key and no credits key,
the server runs in proof-of-work mode (pure-CPU tools stay free). Use dedicated
low-value wallets for `AGENT_KEY` / `SOLANA_AGENT_KEY`, funded only with what
you intend to spend. Most tools cost $0.001–$0.02. The routing tiers top out
at $3.30 (`route-execute-pro`); multi-tool skill packs run $0.003 to $0.101; and the
report products run $0.60 to $2.00 per report (domain-audit $0.60 up to the ticker pack at $2.00),
so the default per-call cap of $4 covers every tool; set `AGENT402_MAX_PER_CALL` lower for a
tighter ceiling.

## Advanced

**Hosted connector (no install).** Add `https://agent402.tools/mcp` as a remote MCP server (for example claude.ai → Settings → Connectors → Add custom connector). Pure-CPU tools run free there, rate-limited. Paid tools are payable on the connector over [MPP](https://agent402.tools/what-is-mpp): a paid call answers JSON-RPC error `-32042` with the payment challenges, and `-32043` if a credential you presented was refused. An MCP client wrapped with `mppx`'s `McpClient.wrap()` pays and retries on its own, with the receipt in `_meta`. This package runs locally for no rate limit, or to pay over x402.

**Chains.** With a funded wallet, `AGENT_KEY` pays USDC on any EVM chain the server offers (Base, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Arc) or USDG on Robinhood Chain. `SOLANA_AGENT_KEY` pays USDC on Solana. The service also settles on Stellar and Algorand, which this package does not sign. Restrict or order chains with `AGENT402_NETWORKS`.

**Credits key.** A prepaid credits key already issued (`AGENT402_CREDITS_KEY`) pays from its balance. New credits are not on sale.

**Error codes.** `-32042` payment required (the challenges are in the error data). `-32043` a presented credential was refused.

## How it works

- On startup the server reads the live catalog from `https://agent402.tools/api/pricing` + `/openapi.json`.
- **Flagship tools** are exposed as first-class MCP tools under dotted names - `web.search`, `web.answer`, `web.news`, `browser.render`, `market.quote`, `audio.transcribe`, `memory.read`, `memory.write` - search/answer is the front door. Override the set with `AGENT402_TOOLS` (slugs; a non-flagship slug is listed as its snake_case name).
- **Decide** (`decide.plan`, `decide.execute`, `decide.feedback`): describe a job and get a call-ready plan over the catalog and outside x402 sellers (tools in order, fallbacks, validated params, chained steps), then run it yourself or through Agent402. Listed when the server offers Decide; see https://agent402.tools/decide.
- The rest of the 500+ tool catalog is reachable via the meta tools `catalog.search` / `catalog.find` + `catalog.call` - keeping your context window small. The same dotted names are listed on the hosted connector; the older snake names (`search_tools`, `find_tool`, `call_tool`, `get_payment_info`, `describe_server`, `list_top_sellers`, and the flagship `search_web` …) remain accepted as CallTool aliases, so existing configs keep working.
- When a call hits HTTP 402: with a wallet key set (`AGENT_KEY` for the EVM chains, Robinhood Chain included; `SOLANA_AGENT_KEY` for Solana), the server signs an x402 payment on a chain the seller accepts and retries; with only a credits key it sends `Authorization: Bearer a402_…` and the server debits the balance on success; with neither it solves the tool's proof-of-work challenge (~0.2 s of CPU) on the eligible tools. (The service settles USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Arc, Stellar and Algorand, plus USDG on Robinhood Chain - 13 chains total - for callers using a raw x402 client rather than this package. Where the server also offers a Circle Gateway batched accept on Arc or Base, this package pays the plain accept beside it.)
- Since 0.13.15 the server's requests to the catalog and to sellers (catalog reads, the 402 and the paid retry) refuse a TLS chain through one of the intermediate CAs listed in `networks.js` (keys reported recoverable in Mozilla bug 2083449), keyed on each certificate's SubjectPublicKeyInfo hash, on a dedicated dispatcher. With a proxy or custom dispatcher installed, requests go out through it unchanged.
- **Slow routes run as jobs** (since 0.13.17): a paid call to a route the catalog marks slow carries `Prefer: respond-async`, answers `202` with a job link, and the server polls `GET /api/jobs/{id}` (free), waiting `Retry-After` seconds between polls, until the answer is ready, reading the job's `state` and falling back to its `status`. Payment settles only on the delivered answer. A caller that sends a `progressToken` gets `notifications/progress` from the job's stage, steps and ETA. A job still running when `AGENT402_ASYNC_TIMEOUT_MS` ends comes back with its `jobUrl` instead.
- `payment.info` tells the model which mode it's in and what a wallet or a credits key would unlock.
- `server.describe` returns orientation (flagship-first tools, install one-liners, free vs paid, discovery URLs). Call it first.
- `sellers.list` returns the live leaderboards - `wire: "x402"` (default) ranks x402 sellers settling the most USDC (primarily on Base) in the last ~24h from on-chain transfers; `wire: "mpp"` ranks live-verified MPP sellers by inbound USDC.e transfers on Tempo. Free to call (no payment, no proof-of-work). Useful for agents discovering the wider x402 / MPP economy beyond this single service's catalog.
- `router.execute` (formerly `route_and_execute`, still accepted) reaches tools **outside** this catalog in one call: give it a plain-language `task` and Agent402 resolves a proven external x402 seller (one with real on-chain settled volume), buys the result from that seller and sells it to you, marked `untrustedContent`. Wallet-only. Flat price, cheapest covering tier chosen from `maxUsd`:

  | Underlying seller price | Fee | Route |
  | --- | --- | --- |
  | ≤ $0.005 | $0.01 | `POST /api/route/execute` |
  | ≤ $0.04 | $0.05 | `POST /api/route/execute-plus` |
  | ≤ $0.50 | $0.55 | `POST /api/route/execute-max` |

  A tool priced above the tier's ceiling returns a self-correcting 409 naming its direct route.
- **Report products** are catalog slugs like any other, so `catalog.call` runs them with a wallet or a credits key: `research` ($0.60), `research-pro` ($0.85), `research-max` ($1.10), `market-brief` ($0.85), `dossier` ($0.85), `dossier-max` ($1.10), `fund-report` ($0.60), `fund-report-max` ($0.85), `domain-audit` ($0.60), `domain-audit-pro` ($0.85), `token-risk` ($0.60), `token-risk-pro` ($0.85), `token-brief` ($0.60), `recall-report` ($0.60), `insider-report` ($0.60), `filing-report` ($0.85), `ticker-pack` ($2.00); the live figures are always at https://agent402.tools/api/pricing. The same reports are sold to people by card at https://agent402.tools/reports for $2 to $5 depending on depth: the card price includes payment processing, and an agent paying per call pays the lower tool price for the same report. The recurring monitors (domain, SEC filing, token, fund, recall, insider, IPO, research - $5/month) are at https://agent402.tools/monitors.

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
