# x402 Leaderboard

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

`GET /api/leaderboard` is the **public, on-chain ranking of x402 sellers by
Base USDC settled volume**. It answers with the **top N of that board and
never the whole of it** - 25 rows by default, 50 the ceiling, with
`totalSellers` in the response carrying how many are ranked in all, so a
seller you cannot find in the rows you were served may simply rank below
them. Only sellers that settled inside `windowServed` rank at all. It's the
third surface in Agent402's open x402
index - alongside [`/api/find`](https://agent402.tools/api/find) (resolve a
task to a tool) and [`/api/route`](https://agent402.tools/api/route) (the
neutral Smart Order Router across every seller).

| Surface | Free | What it returns |
|---|---|---|
| `GET /api/find?q={task}` | ✅ | Best matching tools (route, price, schema, example) |
| `POST /api/route {query, top, include}` | ✅ | Smart Order Router ranked over every x402 seller crawled (match → health → distinct payers → price); the response returns the top N and carries `matched` |
| `GET /api/leaderboard?top=N&include=external\|all` | ✅ | Top N of the on-chain ranking of x402 sellers by Base USDC settled volume (`include=external`, the default, leaves out this host's own row) - 25 default, 50 ceiling, `totalSellers` for the full count (`?limit=` is accepted as an alias of `?top=`) |

## Why on-chain volume

In an open marketplace, anyone can claim anything in a manifest. **What you
can't fake is settlement on a public chain.** Every x402 paid call leaves a
USDC `Transfer` log on Base. The leaderboard reads those logs directly - no
self-reports, no caches you have to trust, no API keys involved.

## Pipeline

1. **Discovery** - walk every page of the [Coinbase CDP Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar)
   `discovery/resources` endpoint (`limit=1000`, page until `pagination.total`
   reached). Extract each seller's `payTo` wallet from listings whose `network`
   is Base mainnet (`eip155:8453` / `base`) and whose asset is USDC.
2. **On-chain scan** - call Base USDC `eth_getLogs` in chunks (`CHUNK_BLOCKS`,
   default `9000` blocks per call; `WALLET_CHUNK`, default `200` wallets per
   call) for the `Transfer(_, payTo, _)` topic across the active window. The
   window is the operator's `SPAN_BLOCKS`; the hosted instance runs a **7d**
   window (`302400` Base blocks at ~2s each), and sellers with bursty traffic
   show real revenue there that a tight scan would miss. Never assume the
   window: the response reports the blocks actually scanned in `scannedBlocks`
   and the human label in `windowLabel` / `windowServed`. A chunk that fails
   after every RPC retry is skipped rather than aborting the scan; only an
   all-chunks-failed outage throws.
3. **Per-call filter** - a transfer counts as a paid call when its value
   matches a price the seller publishes, up to the price-match ceiling reported
   as `priceMatchMaxUsd` (`PRICE_MATCH_MAX_USD`, default **$25**), or when it
   is at or under the flat ceiling reported as `maxCallUsd` (`MAX_CALL_USD`,
   default **$0.75**). A transfer matching no published price above the flat
   ceiling, or matching one above the price-match ceiling, is funding, a swap,
   a gift card or a treasury move, and is skipped.
4. **Aggregate** - for each seller: `callsSettled` (count), `totalUsd` (sum),
   `uniqueBuyers` (distinct `from` addresses).
5. **Rank** - by `totalUsd` (then `callsSettled`, then seller name) and assign
   a `rank` 1..N.

The snapshot **refreshes hourly server-side**. Requests hit the cache; if the
refresh ever fails, the last good snapshot is preserved.

## Calling it

```bash
# Top 10 of the rest of the ecosystem (the default excludes Agent402;
# top, or limit, defaults to 25 and is clamped to 1..50)
curl 'https://agent402.tools/api/leaderboard?top=10'

# The full board, with this host's own row included and flagged self: true
curl 'https://agent402.tools/api/leaderboard?top=25&include=all'

# Rank by call count instead of USD (default sort=usd)
curl 'https://agent402.tools/api/leaderboard?sort=calls'

# Window hint. One cached snapshot is served regardless of what you ask for;
# the response echoes your ask in `windowRequested` and what it actually
# served in `windowServed` / `windowLabel`, so the two can never be confused.
curl 'https://agent402.tools/api/leaderboard?window=24h'
```

Returns (the seller array is **`leaderboard`**, not `rows`):

```json
{
  "spec": "x402-leaderboard/1",
  "asOf": "2026-07-30T03:44:45.814Z",
  "scannedBlocks": 302400,
  "windowLabel": "7d",
  "maxCallUsd": 0.75,
  "scannedSellers": 916,
  "walletsQueried": 916,
  "bazaarTotal": 15289,
  "leaderboard": [
    {
      "rank": 1,
      "name": "…",
      "origins": ["https://…"],
      "homepage": "https://…",
      "endpoints": 12,
      "wallet": "0x…",
      "wallets": ["0x…"],
      "walletCount": 1,
      "network": "base",
      "callsSettled": 412,
      "totalUsd": 1.234,
      "uniqueBuyers": 78
    }
  ],
  "cache": { "cachedAt": "…", "lastTriedAt": "…", "lastError": null, "refreshIntervalMs": 3600000 },
  "include": "external",
  "sortServed": "usd",
  "windowRequested": "24h",
  "windowServed": "7d",
  "totalSellers": 745
}
```

Field notes that matter when you parse it:

- **`leaderboard`** is the array. There is no `rows` key.
- The display name is **`name`**. There is no `serviceName` key.
- **`maxCallUsd`** is the flat per-call ceiling actually applied,
  **`priceMatchMaxUsd`** the ceiling on price-matched transfers, and
  **`scannedBlocks`** / **`windowServed`** are the window actually scanned.
  Read them rather than hardcoding a ceiling or a window.
- **`settlementsAbovePerCallCeiling`** counts transfers above `maxCallUsd`
  that were kept because they matched a price the seller publishes;
  **`transfersSkippedOverCeiling`** counts those dropped. A seller whose prices
  sit above the flat ceiling shows up in the first, not the second.
- One seller can settle to several wallets: `wallet` is the primary, `wallets`
  is the full set, and `walletCount` is its size. `origins` likewise lists
  every host origin collapsed into the row.
- `totalSellers` is the size of the full snapshot before `top` slicing, so you
  can tell "25 rows because I asked for 25" from "25 rows because that's all
  there is".

`include=external` (the default) excludes the operator's own payTo
(`WALLET_ADDRESS`), because this host's own row is inflated by its canary and
volume runs; `include=all` returns it, flagged `self: true`.

## Tests & guarantees

- [`scripts/test-x402-leaderboard.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/scripts/test-x402-leaderboard.js)
  - offline assertions covering the parsers, the asset/network filter, the
  ceiling cutoff, and the deterministic tie-break.
- [`scripts/test-leaderboard-surface.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/scripts/test-leaderboard-surface.js)
  - locks the leaderboard surfacing into robots.txt, sitemap.xml, llms.txt,
  the service manifest, and the landing FAQ JSON-LD so a future deploy can't
  silently drop it.

## Related

- [[x402-Index-and-Router]] - Smart Order Router that uses the same Bazaar walk
- [[Architecture]] - where the leaderboard sits relative to the indexer
- [`/.well-known/x402`](https://agent402.tools/.well-known/x402) - the service
  manifest now advertises the leaderboard in both `machineReadable` and
  `discovery` blocks (`refreshSeconds.leaderboard = 3600`)
