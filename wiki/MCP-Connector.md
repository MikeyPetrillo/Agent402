# MCP Connector

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Agent402 speaks [MCP](https://modelcontextprotocol.io) two ways. Both are listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.MikeyPetrillo/agent402) under `io.github.MikeyPetrillo/agent402`.

## 1. Hosted connector - zero install (the free tier)

Add **`https://agent402.tools/mcp`** as a remote MCP server:

- **claude.ai / Claude mobile:** Settings → Connectors → *Add custom connector* → name `Agent402`, that URL, no auth.
- **Claude Code:** run `claude mcp add --transport http agent402 https://agent402.tools/mcp` in a terminal.
- **Copy-paste blocks for Claude Code, Cursor, Continue, ElizaOS and AgentCore:** https://agent402.tools/guides/agent-hosts
- **Cursor:** Settings → MCP → *Add new MCP server* → name `agent402`, transport `streamable-http`, URL `https://agent402.tools/mcp`. (Or add directly to `~/.cursor/mcp.json`.)
- **ChatGPT:** Settings → Connectors → *Add custom connector* → that URL, no auth (where your plan offers custom connectors).
- **VS Code (GitHub Copilot Chat with MCP):** *MCP: Add Server* → HTTP → `https://agent402.tools/mcp`.
- Any client speaking **streamable HTTP** (the endpoint is stateless - every JSON-RPC message is self-contained).

It exposes a **flagship-first** tools/list (~15 tools, each with titles + safety annotations). Search and answer are the front door; the long catalog (500+ tools) stays behind `catalog.find` / `catalog.search` / `catalog.call`. Tool names are **dotted** (`namespace.verb`); the earlier snake_case names (`search_tools`, `find_tool`, `call_tool`, `get_payment_info`, `describe_server`, `list_top_sellers`, `request_tool`, `search_web`, `answer_question`, `render_page`, …) still work as CallTool aliases but are not listed.

| Tool | Does |
|---|---|
| `web.search` | Live web search (title, URL, snippet). Start here to discover pages |
| `web.answer` | Cited answer grounded in live web search |
| `web.news` | News search |
| `browser.render` | Headless Chromium render → markdown |
| `market.quote` | Live stock quote |
| `audio.transcribe` | Speech-to-text |
| `memory.read` / `memory.write` | Durable wallet-keyed memory |
| `catalog.find` | Describe a task in plain language; returns the best-matching tool(s) **ready to call** - slug, price, input schema, an example, and the exact `catalog.call` invocation |
| `catalog.search` | Browse the long catalog by description; returns slugs + input schemas (plus matching skill packs) |
| `catalog.call` | Execute any catalog tool by slug. Pure-CPU tools run **free** here (rate-limited: 20/min, 120/hr per client); wallet-only tools are payable right here over MPP (below) or return paid-path instructions |
| `decide.plan` | (When Decide is enabled on the instance.) Describe a job; returns a call-ready plan over this catalog and outside x402 sellers: tools in order, fallbacks, validated params, chained steps. See [[Decide]] |
| `decide.execute` | (When Decide is enabled.) Runs a decision's plan within a budget; the decision fee comes back as credit |
| `decide.feedback` | (When Decide is enabled.) Free. Report whether one step of a plan worked |
| `payment.info` | Free vs paid rails, wallet setup, spend caps, prepaid credits |
| `server.describe` | Service description, install one-liners, free-vs-paid breakdown |
| `demand.request` | Tell us a tool you needed that is missing (same intake as `POST /api/wish`) |
| `sellers.list` | On-chain seller leaderboards: x402 sellers by Base USDC (default) or `wire: "mpp"` for MPP sellers by USDC.e transfers on Tempo. Listed when a wallet or credits key is set, or with `AGENT402_SHOW_ROUTER=1` |

`initialize` also returns **instructions** with the same front-door story and Claude/Cursor install one-liners, so clients that never call `server.describe` still get oriented.

The connector is also read every 6 hours by an independent client (the reference MCP SDK over Streamable HTTP, `scripts/mcp-client-check.js`): it initializes, lists the tools, makes a handful of free calls and checks the paid-call refusal, so a drift in names, descriptions or answer shapes that our own harness would not see opens an issue.

**Native MPP on `/mcp`.** A wallet-only tool called on the hosted connector is payable in the call itself, over the Machine Payments Protocol's MCP wire: the connector answers with an `isError` tool result whose text names every way to pay and whose `_meta["org.paymentauth/payment-required"]` carries the challenges (the same `WWW-Authenticate: Payment` challenges the HTTP route mints; a host that does not speak MPP shows the text instead of a bare error). A presented credential that is refused answers JSON-RPC `-32043`, and a call on the tasks path answers `-32042`, both with `data.challenges`. Then the client retries with the credential in `_meta["org.paymentauth/credential"]`, and a paid result carries the receipt in `_meta["org.paymentauth/receipt"]`. mppx's `McpClient.wrap` does this automatically with `evm.charge` (USDC on Base/Celo) or `tempo.charge` (native Tempo). Settlement authority is unchanged: the connector replays the call as a loopback request to its own paid HTTP route and lets the real gates verify and settle, so every paywall invariant (handler before money, replay guard, idempotency) applies verbatim (`src/mcp-mpp.js`). Without an MPP client, flagship tools that need egress or durable state (`web.search`, `web.answer`, `browser.render`, memory, …) return paid-path setup instead: run the npm server with `AGENT_KEY` or a prepaid credits key, or call over HTTP with any x402 client. Pure-CPU long-tail tools via `catalog.call` still run free and rate-limited.

## 2. `agent402-mcp` (npm) - the full catalog, payment underneath

```json
{ "mcpServers": { "agent402": {
  "command": "npx", "args": ["-y", "agent402-mcp@0.13.23"],
  "env": {
    "AGENT_KEY": "0x<funded wallet key - optional>",
    "AGENT402_BUDGET": "1.00",
    "AGENT402_MAX_PER_CALL": "0.01"
  }
} } }
```

**Use a new wallet holding only a few dollars of USDC. Never your main wallet.**

- **With `AGENT_KEY`** (an EVM wallet: it pays on any EVM chain the 402 offers, Base first; pin one with `AGENT402_NETWORKS`, e.g. `robinhood` for USDG on Robinhood Chain, or `eip155:5042` for USDC on Arc) **and/or `SOLANA_AGENT_KEY`** (a Solana wallet holding USDC on Solana): every tool works; each call settles via x402 invisibly under the MCP call. The service also accepts USDC on Stellar and Algorand, which this npm server does not sign. Spend controls (`AGENT402_BUDGET`, `AGENT402_MAX_PER_CALL`) are enforced *before any payment is signed*.
- **With `AGENT402_CREDITS_KEY`** (0.13.0+): a prepaid credits key (`a402_…`), where sold or already issued, pays every wallet-only tool on Agent402's own services, debited only on a successful call, inside the same spend controls; the wallet-identity-bound tools and the routes that buy from an outside seller (`router.execute`, `seller-payability`, `decide.execute`) need a wallet. [`/credits`](https://agent402.tools/credits) says whether credits are on sale. See [[Reports and Monitors|Reports-and-Monitors]].
- **Without a key:** the pure-CPU tools work free via proof-of-work; wallet-only tools explain what they'd cost and how to enable them.

The same flagship set is first-class; the long tail is reachable via `catalog.search` + `catalog.call` to keep your context window small.

The npm server also exposes **`router.execute`** (since 0.13.11; `route_and_execute`, its name since 0.12.0, still works) `{ task, params?, maxUsd? }`: describe a task and the Smart Order Router resolves the best-matching **external** x402 seller (the MCP tool always sends `include: "external"`; for this catalog's own tools, call the tool directly), pays it from your configured wallet, and relays the result marked `untrustedContent`. Sellers are routable on proven on-chain settlement, with one exception: a seller with no settlement history yet is tried only after every proven candidate, under a small per-call cap, and flagged unproven on the receipt. See [[x402 Index and Router|x402-Index-and-Router]].

`maxUsd` is the cap on the **underlying seller's** price and defaults to `0.005`. From it the server picks the cheapest routing rung that covers it, exactly as the HTTP ladder does: `maxUsd ≤ 0.005` → the $0.01 tier, `> 0.005` and `≤ 0.04` → the $0.05 tier, `> 0.04` → the $0.55 tier (underlying up to $0.50). Needs a funded wallet.

Other env knobs: `AGENT402_URL` (target service), `AGENT402_TOOLS` (override the first-class tool list), `AGENT402_NETWORKS` (e.g. `robinhood`).

## Choosing between them

| | Hosted `/mcp` | npm `agent402-mcp` |
|---|---|---|
| Install | none | `npx` |
| Works in claude.ai | ✅ | ❌ (stdio is Desktop/Code only) |
| Pure-CPU tools | free, rate-limited | free (PoW), unlimited |
| Flagship search / render / memory | listed; payable in the call over MPP with an mppx client, otherwise returns paid-path setup | ✅ with a funded wallet or a prepaid credits key |
| Identity | anonymous (or the MPP payer) | your wallet = your identity (unlocks [[Memory and Coordination]]; credits keys carry no wallet identity, so memory needs a wallet) |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **Connector won't connect** in claude.ai/Claude Code | Confirm the URL is exactly `https://agent402.tools/mcp` (HTTPS, no trailing path). In Claude Code, `claude mcp list` should show `agent402 ✓ Connected`. If it's mid-deploy it can briefly drop - retry in ~60s. |
| **"Error occurred during tool execution"** (transient) | Usually a redeploy window on the host; the same call succeeds on retry. The endpoint is health-gated in CI on every deploy. |
| **`catalog.call` says a field is missing / "must be a number"** | Pass `params` as a JSON object, e.g. `{"slug":"unit-convert","params":{"value":42,"from":"kilometers","to":"miles"}}`. A stringified object (`"{\"value\":42}"`) is also accepted. |
| **A tool returns "wallet required" / paid-path guidance** | That flagship (live search, browser render, STT, durable memory, …) isn't free on the authless hosted connector. Pay it in the call with an mppx MCP client, run the npm server `npx -y agent402-mcp@0.13.23` with `AGENT_KEY` (funded wallet) or `AGENT402_CREDITS_KEY` (a prepaid credits key, where sold or already issued), or call it over HTTP with any x402 client. |
| **"Free-tier rate limit reached"** | The hosted connector is capped at 20 calls/min, 120/hour per client, shared across replicas. Wait, or use the npm server with a wallet (or a prepaid credits key) for the paid, uncapped path. |
| **Finding the right tool** | Call `catalog.find` with a plain-language task - it returns the best match ready to call (slug + example + the exact `catalog.call` invocation). `catalog.search` is the broader, lower-level browse. |
| **My client still sends `find_tool` / `call_tool`** | Those names remain CallTool aliases and keep working; only the listing moved to the dotted names. |

More: [[Paying with x402]] · [[Paying with Compute]] · [Open an issue](https://github.com/MikeyPetrillo/Agent402/issues).
