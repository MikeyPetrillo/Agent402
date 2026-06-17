# x402 Leaderboard

`GET /api/leaderboard` is the **public, on-chain ranking of every x402 seller
by Base USDC settled volume**. It's the third surface in Agent402's open x402
index — alongside [`/api/find`](https://agent402.tools/api/find) (resolve a
task to a tool) and [`/api/route`](https://agent402.tools/api/route) (the
neutral Smart Order Router across every seller).

| Surface | Free | What it returns |
|---|---|---|
| `GET /api/find?q={task}` | ✅ | Best matching tools (route, price, schema, example) |
| `POST /api/route {query, top, include}` | ✅ | Smart Order Router across every x402 seller, ranked by match → health → price |
| `GET /api/leaderboard?top=N&include=all\|external` | ✅ | On-chain ranking of every x402 seller by Base USDC settled volume |

## Why on-chain volume

In an open marketplace, anyone can claim anything in a manifest. **What you
can't fake is settlement on a public chain.** Every x402 paid call leaves a
USDC `Transfer` log on Base. The leaderboard reads those logs directly — no
self-reports, no caches you have to trust, no API keys involved.

## Pipeline

1. **Discovery** — walk every page of the [Coinbase CDP Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar)
   `discovery/resources` endpoint (`limit=1000`, page until `pagination.total`
   reached). Extract each seller's `payTo` wallet from listings whose `network`
   is Base mainnet (`eip155:8453` / `base`) and whose asset is USDC.
2. **On-chain scan** — call Base USDC `eth_getLogs` in chunks (`9000` blocks
   per call, `200` wallets per call) for the `Transfer(_, payTo, _)` topic
   across the active window (default `43200` blocks ≈ **24h** — sellers with
   bursty traffic show real revenue here that a tight 5h scan would miss).
3. **Per-call ceiling filter** — keep only transfers whose value is ≤ `$0.50`
   (configurable). Anything larger is funding, swap, or a treasury move — not
   a paid x402 call.
4. **Aggregate** — for each seller: `callsSettled` (count), `totalUsd` (sum),
   `uniqueBuyers` (distinct `from` addresses).
5. **Rank** — by `totalUsd` (then `callsSettled`, then seller name) and assign
   a `rank` 1..N.

The snapshot **refreshes hourly server-side**. Requests hit the cache; if the
refresh ever fails, the last good snapshot is preserved.

## Calling it

```bash
# Top 10, including Agent402 itself
curl https://agent402.tools/api/leaderboard?top=10

# Rank only the rest of the ecosystem (exclude Agent402)
curl 'https://agent402.tools/api/leaderboard?top=25&include=external'

# Window hint — currently the active 24h cache is served regardless; 7d/30d
# are reserved for the deep-cache rollout. The response always reports the
# window actually served in `windowServed`.
curl 'https://agent402.tools/api/leaderboard?window=24h'
```

Returns:

```json
{
  "asOf": "2026-06-16T21:00:00.000Z",
  "network": "base",
  "asset": "USDC",
  "perCallCeilingUsd": 0.5,
  "rows": [
    {
      "rank": 1,
      "wallet": "0x…",
      "serviceName": "…",
      "homepage": "https://…",
      "endpoints": 12,
      "callsSettled": 412,
      "totalUsd": 1.234,
      "uniqueBuyers": 78
    }
  ]
}
```

`include=external` excludes the Agent402 payTo (`SELF_WALLET` in the
operator's env) — same logic as `/api/route?include=external`. We list because
we trust the ranking, not because we'd rig it for ourselves.

## Tests & guarantees

- [`scripts/test-x402-leaderboard.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/scripts/test-x402-leaderboard.js)
  — 33 offline unit tests for the parsers, the asset/network filter, the
  ceiling cutoff, and the deterministic tie-break.
- [`scripts/test-leaderboard-surface.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/scripts/test-leaderboard-surface.js)
  — locks the leaderboard surfacing into robots.txt, sitemap.xml, llms.txt,
  the service manifest, and the landing FAQ JSON-LD so a future deploy can't
  silently drop it.

## Related

- [[x402-Index-and-Router]] — Smart Order Router that uses the same Bazaar walk
- [[Architecture]] — where the leaderboard sits relative to the indexer
- [`/.well-known/x402`](https://agent402.tools/.well-known/x402) — the service
  manifest now advertises the leaderboard in both `machineReadable` and
  `discovery` blocks (`refreshSeconds.leaderboard = 3600`)
