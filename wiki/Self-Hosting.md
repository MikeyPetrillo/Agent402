# Self-Hosting

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Run Agent402 on your own infrastructure for full control over pricing, data, rate limits, and uptime.

## Why self-host

- **Privacy.** URLs, inputs, and outputs never leave your network.
- **No rate limits.** You control concurrency, burst policies, and who gets access.
- **Custom pricing.** Set your own per-call prices or run everything free.
- **Reliability.** No dependency on a third-party host; deploy where your agents already run.

## Prerequisites

- **Node.js >= 20** (22 recommended; the hosted instance runs Node 22)
- **git**
- **Optional:** Redis (response caching), Postgres (analytics/call tracking)
- **Optional:** Chromium + ffmpeg if you want browser/media tools (installed automatically by Playwright on first run)

## Quick start

### Manual (recommended)

```bash
git clone https://github.com/MikeyPetrillo/Agent402.git
cd Agent402
npm install
FREE_MODE=true npm start        # everything runs free, no wallet needed
```

The server starts on port 3000 by default (`PORT` env var overrides).

### Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
ENV FREE_MODE=true
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
```

```bash
docker build -t agent402 .
docker run -p 3000:3000 -e FREE_MODE=true agent402
```

For persistent state (stats, memory, PoW replay protection), mount a volume at `/data`.

### Railway

1. Fork the repo on GitHub.
2. Create a new Railway project from your fork.
3. Add a persistent volume mounted at `/data`.
4. Set environment variables in the Railway dashboard (see table below).
5. Deploy. Railway auto-detects the start command from `package.json`.

> **Protect in-flight paid calls across redeploys:** set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=120` on the service (the hosted deploy job sets 120). Railway's default grace between SIGTERM and SIGKILL is **0 seconds**, which kills in-flight (already paid-for) requests on every redeploy. With the variable set, the server's built-in graceful drain finishes active requests (up to 75s) before exiting.

## Environment variables

Set these on your host. None are committed to the repo.

| Variable | Required? | What it enables |
|---|---|---|
| `FREE_MODE` | No | Set `true` to serve all tools free (no paywall, no PoW gate) |
| `PORT` | No | HTTP listen port (default: 3000) |
| `WALLET_ADDRESS` | For paid mode | Your USDC receiving address (Base) |
| `WALLET_ENS` | No | ENS or Basename for display (e.g. `agent402.base.eth`) |
| `NETWORK` | For paid mode | Chain identifier (default: `eip155:8453` = Base mainnet) |
| `PAYMENT_NETWORKS` | No | Comma-separated chains to accept (default: the primary network only), e.g. `base,solana,polygon,arbitrum,stellar,algorand,monad,celo,avalanche,sei,optimism,robinhood`; each extra chain needs its own payTo / facilitator settings (see below) |
| `CDP_API_KEY_ID` | For paid mode | Coinbase CDP API key ID (facilitator auth) |
| `CDP_API_KEY_SECRET` | For paid mode | Coinbase CDP API secret |
| `FACILITATOR_URL` | No | Custom x402 facilitator URL (defaults to Coinbase's) |
| `POW_SECRET` | For PoW tier | HMAC secret for signing PoW challenges |
| `BRAVE_API_KEY` | No | Enables search-kit tools (Web, News, Images) |
| `BRAVE_ANSWERS_API_KEY` | No | Distinct Brave subscription token for the `answer` tool; falls back to `BRAVE_API_KEY` |
| `BRAVE_SUGGEST_API_KEY` | No | Distinct Brave subscription token for `search-suggest`; falls back to `BRAVE_API_KEY` |
| `NEYNAR_API_KEY` | No | Enables Farcaster tools (Neynar API); falls back to `WARPCAST_API_KEY` |
| `FRED_API_KEY` | No | Enables macro-kit v1 (FRED economic data) |
| `FRED_API_KEY_V2` | No | Distinct key for macro-kit v2 bulk endpoints |
| `YAHOO_RELAY_URL` | No | Cloudflare Worker relay URL for Yahoo Finance charts (both URL and TOKEN must be set) |
| `YAHOO_RELAY_TOKEN` | No | Bearer token for the Yahoo relay worker |
| `OPENROUTER_API_KEY` | No | Enables the `/v1` LLM gateway tiers (chat, metered, embeddings, rerank, images, speech); the routes answer `503` without it |
| `OPENAI_API_KEY` | No | Enables the older `/api/llm*`, `/api/image-gen*`, `/api/tts*`, `/api/transcribe*` and `/api/embed*` proxies |
| `E2B_API_KEY` | No | Enables the `/api/code-run*` sandbox tools |
| `REDIS_URL` | No | Enables Redis response caching (see below) |
| `ANALYTICS_DATABASE_URL` | No | Postgres connection string for analytics; falls back to `DATABASE_URL` |
| `GLAMA_MAINTAINER_EMAIL` | No | Email returned at `/.well-known/glama.json` |
| `MPP_SECRET_KEY` | For MPP | HMAC secret binding MPP challenges; presence mounts the MPP dual-stack shim (`WWW-Authenticate: Payment` on every 402, `evm` method settled through your x402 facilitator). Unset = pure x402 |
| `MPP_CHALLENGE_NETWORKS` | No | `all` or a CSV of chain ids that get MPP `evm` challenges (default Base + Celo) |
| `MPP_EVM_DOMAIN_FALLBACK` | No | `off` disarms the wrong-EIP-712-domain detection. On by default: a credential signed under a different known token-domain name than the one your accepts entry advertises is refused locally with an RFC 9457 problem, and MPP challenges are withheld from that client briefly so an MPP-preferring wallet falls through to your x402 offer instead of looping. `MPP_EVM_DOMAIN_FALLBACK_TTL_MS` (30 min) and `MPP_EVM_DOMAIN_FALLBACK_MAX_RESPONSES` (5) bound the hold |
| `TEMPO_API_KEY` | For native Tempo | Tempo MPP relay key (needs the `mpp:write` scope); with a recipient it offers `tempo/charge` challenges settled natively on Tempo |
| `TEMPO_RECIPIENT_ADDRESS` | No | Tempo payTo (defaults to `WALLET_ADDRESS`) |
| `TEMPO_CURRENCY` | No | CSV of TIP-20 token addresses to offer (first = preferred; default PathUSD, the hosted instance offers USDC.e then PathUSD) |
| `STRIPE_SECRET_KEY` | For card paths | Rollout switch for the human front door: `/reports` (card checkout), `/monitors` (subscriptions), `/credits` (prepaid credits) and the `Authorization: Bearer a402_…` credits gate. Unset = none of it is mounted; the `/v1` report routes still sell over x402 / MPP |
| `STRIPE_WEBHOOK_SECRET` | With Stripe | Signing secret for the Stripe webhook endpoint (subscription status, invoices, credit packs, refunds and disputes). The webhook is verified only when set |
| `STRIPE_PROFILE_ID` | No | With `STRIPE_SECRET_KEY`, mounts cards over the MPP wire (`stripe/charge` via Shared Payment Tokens) on routes priced $0.50 or more |
| `STRIPE_AUTOMATIC_TAX` | No | `true` adds Stripe Tax to every Checkout Session (enable Stripe Tax in the dashboard first) |
| `EMAIL_FROM` | For emails | Verified sender address; with a provider key below, report links, monitor reports and credits keys are emailed |
| `ZEPTOMAIL_TOKEN` | No | Zoho ZeptoMail send-mail token (with or without the `Zoho-enczapikey` prefix); `ZEPTOMAIL_URL` overrides the regional API base |
| `RESEND_API_KEY` | No | Resend API key, the alternative email provider (ZeptoMail wins when both are set) |
| `MONITOR_SCHEDULER` | No | `off` disarms the monitor fulfilment timer (manual operator runs still work) |

## Free mode vs paid mode

- **`FREE_MODE=true`** -- every tool responds without payment. Good for development, internal deployments, or self-hosted agents that don't need metering. The PoW gate and x402 paywall are both disabled.
- **Without `FREE_MODE`** -- the x402 paywall activates. Callers pay per request (USDC on Base by default; add Solana, Polygon, Arbitrum, Stellar, Algorand and the chains below with `PAYMENT_NETWORKS`, each with its own payTo / facilitator setting) or solve a proof-of-work challenge for pure-CPU tools. You need `WALLET_ADDRESS`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, and `POW_SECRET` at minimum. To also accept **USDC on Monad** (EVM chain 143), add `monad` to `PAYMENT_NETWORKS` (settles via `MONAD_FACILITATOR_URL`, default the molandak-operated public facilitator). Avalanche (43114) and Sei (1329) are likewise opt-in via `PAYMENT_NETWORKS` (both settle via PayAI, no extra config). Optimism (10) is opt-in via `PAYMENT_NETWORKS` plus `SOLVADOR_KEY` (settles via the Solvador facilitator; price its per-settlement fee in with `NETWORK_PRICE_PREMIUMS=eip155:10=0.001`). To also accept **USDC on Celo** (EVM chain 42220), add `celo` to `PAYMENT_NETWORKS` and set `CELO_FACILITATOR_KEY` (free self-service key: sign a no-gas message with any wallet at [x402.celo.org](https://x402.celo.org); the facilitator's `/settle` requires it). Settles via `CELO_FACILITATOR_URL`, default the Celo-operated `api.x402.celo.org`. To accept **USDG on Robinhood Chain**, add `robinhood` to `PAYMENT_NETWORKS` and set `ROBINHOOD_FACILITATOR_URL`.

**MPP on the same 402:** set `MPP_SECRET_KEY` and every paid route also answers `WWW-Authenticate: Payment` (the `evm` method settles through your existing facilitator); add `TEMPO_API_KEY` for native Tempo settlement. **Cards:** `STRIPE_SECRET_KEY` (+ `STRIPE_WEBHOOK_SECRET`) mounts the report checkout, monitors and prepaid credits; `STRIPE_PROFILE_ID` adds cards over MPP. **Email:** `EMAIL_FROM` plus `ZEPTOMAIL_TOKEN` or `RESEND_API_KEY`; without them the card pages still work and the report link is shown on the page.

See [[Paying with x402]], [[Paying with MPP]], [[Paying with Compute]] and [[Reports, Monitors and Credits|Reports-and-Monitors]] for the buyer-side flows.

## Optional infrastructure

### Redis (response caching)

Set `REDIS_URL` to enable response caching for eligible routes. The server defines a `CACHEABLE_ROUTES` set internally -- deterministic, read-only tools whose output can be safely replayed. Cache is env-gated: no `REDIS_URL`, no caching, no behavior change.

### Postgres (analytics)

Set `ANALYTICS_DATABASE_URL` (or `DATABASE_URL`) to enable call-level analytics tracking. This records per-tool call counts, latency, and error rates. Also env-gated -- without the variable, analytics is a silent no-op.

### SQLite (built-in)

Stats, memory namespaces, and PoW replay protection use SQLite (better-sqlite3, WAL mode) stored in `/data`. This works out of the box with no configuration -- just ensure the `/data` directory is writable and persistent across deploys.

## Health checks

- **`GET /health`** -- returns `200` and a deliberately small public body: `{ ok, meta: { toolCount, build } }`. Process uptime and the operating-mode/feature flags are **operator-only** and appear only on the token-authenticated response. Use this path as your load-balancer or container health probe.
- **CI heartbeat** -- the repo's `heartbeat.yml` workflow probes the hosted instance every 15 minutes and auto-opens a GitHub issue on failure. You can adapt the same workflow for your own deployment.

## Verifying your deployment

```bash
# Smoke test: every tool should answer its own documented example
FREE_MODE=true PORT=3000 node src/server.js &
TARGET_URL=http://localhost:3000 node scripts/test-all.js
```

## See also

- [[Getting Started]] -- your first call in 60 seconds
- [[Architecture]] -- how the server, paywall, and facilitators fit together
- [[Security Model]] -- SSRF defense, PoW scoping, wallet-only tools
- [[Operations]] -- CI pipeline, heartbeat watchdog, deploys
