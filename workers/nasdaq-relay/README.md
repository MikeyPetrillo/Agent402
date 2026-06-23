# nasdaq-relay

A Cloudflare Worker that proxies Nasdaq's keyless calendar endpoint so
that an Agent402 deployment whose egress IPs are null-routed by Nasdaq's
CloudFront can still serve `/api/earnings-calendar`.

## Why this exists

Same pattern as `yfinance-relay`: Railway's egress IP range is blocked
at Nasdaq's edge — packets are dropped (no TCP SYN-ACK), the connection
times out (`ETIMEDOUT`), and `fetch` reports `"fetch failed"`. Routing
through a Cloudflare Worker moves the egress to CF's IP range.

## Surface

- **GET only** — Nasdaq's calendar API is GET; nothing else is allowed.
- **Path allowlist** — only `/api/calendar/<type>` (e.g., `earnings`).
  Refuses anything else with 403.
- **Bearer auth required** — `Authorization: Bearer <token>` must match
  the `RELAY_TOKEN` Worker secret.

## Deploy

```bash
cd workers/nasdaq-relay
npx wrangler deploy
openssl rand -hex 32 | wrangler secret put RELAY_TOKEN
```

The deploy prints a URL like `https://agent402-nasdaq-relay.<account>.workers.dev`.

## Wire it into the Agent402 server

Set two env vars on the Agent402 deployment (e.g., Railway):

- `NASDAQ_RELAY_URL` — the Worker URL (no trailing slash)
- `NASDAQ_RELAY_TOKEN` — the same value you set as `RELAY_TOKEN` above

When both are set, finance-kit routes Nasdaq calls through the relay.
When either is unset, finance-kit hits Nasdaq directly.

## Verifying

After deploy, check `/health` — the `flags.nasdaqRelay` field should
be `true`. Then call `/api/earnings-calendar` — it should return data
instead of a 504 timeout.
