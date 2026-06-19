# yfinance-relay

A Cloudflare Worker that proxies Yahoo Finance's keyless chart endpoint so
that an Agent402 deployment whose egress IPs are silently null-routed by
Yahoo can still serve `/api/stock-quote` and `/api/stock-history`.

## Why this exists

Some hosting providers' egress IP ranges are blocked at Yahoo's edge —
packets are dropped (no TCP SYN-ACK), the connection times out
(`ETIMEDOUT`), and `fetch` reports `"fetch failed"`. Routing the call
through a Cloudflare Worker moves the egress to Cloudflare's IP range,
which Yahoo permits.

## Surface

- **GET only** — Yahoo's chart API is GET; nothing else is allowed.
- **Path allowlist** — only `/v8/finance/chart/<SYMBOL>`. Refuses anything
  else with 403 so the Worker can't be repurposed as a generic proxy.
- **Bearer auth required** — `Authorization: Bearer <token>` must match
  the `RELAY_TOKEN` Worker secret. Prevents open abuse.

## Deploy

```bash
cd workers/yfinance-relay
npx wrangler deploy
# generate a 32-byte token and set it as a Worker secret
openssl rand -hex 32 | wrangler secret put RELAY_TOKEN
```

The deploy prints a URL like `https://agent402-yfinance-relay.<account>.workers.dev`.

## Wire it into the Agent402 server

Set two env vars on the Agent402 deployment (e.g., Railway):

- `YAHOO_RELAY_URL` — the Worker URL (no trailing slash)
- `YAHOO_RELAY_TOKEN` — the same value you set as `RELAY_TOKEN` above

When both are set, finance-kit routes Yahoo calls through the relay. When
either is unset, finance-kit hits Yahoo directly (preserves behavior for
deployers whose egress isn't blocked).

## Verifying

After deploy and env-var set, the next paid-canary tick (or a manual run)
should print `OK finance /api/stock-quote → settled $0.005`. If the relay
itself can't reach Yahoo, finance-kit will surface `Yahoo Finance request
failed: HTTP 502 ... upstream fetch failed` instead of the original
`ETIMEDOUT` — distinguishable from the original failure mode.
