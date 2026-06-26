# Self-Hosting

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
FROM node:20-slim
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

## Environment variables

Set these on your host. None are committed to the repo.

| Variable | Required? | What it enables |
|---|---|---|
| `FREE_MODE` | No | Set `true` to serve all tools free (no paywall, no PoW gate) |
| `PORT` | No | HTTP listen port (default: 3000) |
| `WALLET_ADDRESS` | For paid mode | Your USDC receiving address (Base) |
| `WALLET_ENS` | No | ENS or Basename for display (e.g. `agent402.base.eth`) |
| `NETWORK` | For paid mode | Chain identifier (default: `eip155:8453` = Base mainnet) |
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
| `REDIS_URL` | No | Enables Redis response caching (see below) |
| `ANALYTICS_DATABASE_URL` | No | Postgres connection string for analytics; falls back to `DATABASE_URL` |
| `MARKETPLACE_TOKEN` | No | Secret for the agent402.app marketplace bridge |
| `GLAMA_MAINTAINER_EMAIL` | No | Email returned at `/.well-known/glama.json` |

## Free mode vs paid mode

- **`FREE_MODE=true`** -- every tool responds without payment. Good for development, internal deployments, or self-hosted agents that don't need metering. The PoW gate and x402 paywall are both disabled.
- **Without `FREE_MODE`** -- the x402 paywall activates. Callers pay per request (USDC on Base, Solana, Polygon, or Arbitrum via x402) or solve a proof-of-work challenge for pure-CPU tools. You need `WALLET_ADDRESS`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, and `POW_SECRET` at minimum.

See [[Paying with x402]] and [[Paying with Compute]] for the buyer-side flows.

## Optional infrastructure

### Redis (response caching)

Set `REDIS_URL` to enable response caching for eligible routes. The server defines a `CACHEABLE_ROUTES` set internally -- deterministic, read-only tools whose output can be safely replayed. Cache is env-gated: no `REDIS_URL`, no caching, no behavior change.

### Postgres (analytics)

Set `ANALYTICS_DATABASE_URL` (or `DATABASE_URL`) to enable call-level analytics tracking. This records per-tool call counts, latency, and error rates. Also env-gated -- without the variable, analytics is a silent no-op.

### SQLite (built-in)

Stats, memory namespaces, and PoW replay protection use SQLite (better-sqlite3, WAL mode) stored in `/data`. This works out of the box with no configuration -- just ensure the `/data` directory is writable and persistent across deploys.

## Health checks

- **`GET /health`** -- returns `200` with server status, uptime, and feature flags (including `yahooRelay` activation). Use this as your load-balancer or container health probe.
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
