# x402 Index & Smart Order Router

Agent402 is not only a seller of ~1,100 tools — it's also a **routing layer for
the whole x402 ecosystem**. It crawls public x402 sellers, tracks their health,
and lets a buyer ask *"find me the cheapest healthy tool that does X"* across
every seller it knows about.

Three surfaces, all **free** (mounted outside the paywall — discovery primitives
shouldn't cost money, by the same logic as `/api/find`):

| Surface | What it returns |
|---|---|
| `GET /index` | HTML dashboard: every seller indexed, tool count, network, last-fetched time, rolling health, discovery sources |
| `GET /api/index` | JSON snapshot of the same data: per-seller `health`, `routable`, rolling `history`, totals |
| `POST /api/route` | Smart Order Router: `{ query, top }` → top-N matching tools across sellers, ranked by match score, then health, then price |

## How a seller gets into the Index

1. **Local catalog** — the Agent402 server's own tools are always present (no network).
2. **Operator seeds** — origins listed in the `X402_INDEX_SEEDS` env (comma-separated) get crawled every 5 minutes.
3. **Auto-discovery** — every hour, the indexer pulls public x402 registries (currently the [Coinbase CDP Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar)) and adds new origins to the crawl set, capped at 200 sellers so a misbehaving registry can't blow up memory.

Each crawl fetches `<origin>/.well-known/x402` plus the seller's `openapi.json`
when present, runs every request through the SSRF guard (`safeFetch`), caps
response sizes, and records the outcome in a **rolling 5-entry history** per
seller.

## Health-aware routing

A buyer routed to a dead seller wastes money. The router takes that seriously:

- **Excluded:** a seller whose last `HEALTH_WINDOW` (5) crawl outcomes include any errors is **not routable** and is skipped by `/api/route`.
- **Brand new:** sellers with no history yet *are* routable — benefit of the doubt for newcomers.
- **Ranked:** at equal match score, healthier sellers rank first. Then cheaper wins.
- **Snapshot:** `GET /api/index` exposes every seller's `health` (0..1), `routable` flag, and rolling `history` so an operator can audit the decisions.

The unit tests for these guarantees live in [`scripts/test-router-health.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/scripts/test-router-health.js)
(six scenarios, offline — they seed the in-memory cache directly via a test
escape hatch).

## Calling the router

```bash
curl -X POST https://agent402.tools/api/route \
  -H 'content-type: application/json' \
  -d '{"query":"ocr image to text","top":5}'
```

Returns an array of `{ seller, route, slug, name, price, health, score }` entries.
`seller` is `"self"` for the local catalog or the origin URL for remote sellers,
so a buyer can address the right seller directly.

## Why this matters

- **One integration, the whole ecosystem.** A buyer that integrates Agent402's `agent402-client` SDK or the hosted `/mcp` connector already has access to ~1,100 local tools *and* can route across every other x402 seller without per-seller wiring.
- **Discoverability that compounds.** Sellers don't have to register with Agent402 — appearing in any public x402 registry is enough. The Index pulls them in automatically.
- **Trust signals are checkable.** Health scores are derived from real crawl outcomes, not self-reports. The full `history` is in `/api/index` for anyone to verify.

## Related

- [[Architecture]] — where the indexer sits in the request flow
- [[Operations]] — 3-rail attribution (USDC / PoW / Heartbeat) on the operator dashboard
- [`/api/find`](https://agent402.tools/api/find) — local-only resolver (older, simpler)
