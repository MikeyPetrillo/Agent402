# agent402-algorand-relay

Cloudflare Worker that proxies the keyless Algorand **algod** and **indexer**
APIs. Some hosting egress ranges are refused by the upstream, and both of the
server's direct fallback hostnames are the same provider, so routing through
Cloudflare moves the egress to its IP range.

## Surface

- `GET /algod/v2/*` → `https://mainnet-api.4160.nodely.dev/v2/*`
- `GET /idx/v2/*` → `https://mainnet-idx.4160.nodely.dev/v2/*`
- Everything else 403s (not a general-purpose proxy).
- Auth: `Authorization: Bearer <RELAY_TOKEN>` (Worker secret), 401 otherwise.

## Deploy

```sh
npx wrangler deploy
npx wrangler secret put RELAY_TOKEN   # any long random string
```

Then set on Railway (both required; unset pair = direct Nodely, which works
everywhere except Railway):

- `ALGORAND_RELAY_URL` — the workers.dev URL printed by deploy
- `ALGORAND_RELAY_TOKEN` — the same token

Consumers: `src/revenue-live.js` (30-day activity on /revenue) and
`src/revenue-ledger.js` (all-time sync). Both walk the relay FIRST, then
the direct Nodely bases.
