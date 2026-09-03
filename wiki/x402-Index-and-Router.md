# x402 Index & Smart Order Router

Agent402 is not only a seller of 500+ tools - it's also a **routing layer for
the whole x402 ecosystem**. It crawls public x402 sellers, tracks their health,
and lets a buyer ask *"find me the cheapest healthy tool that does X"* across
every seller it knows about.

Three surfaces, all **free** (mounted outside the paywall - discovery primitives
shouldn't cost money, by the same logic as `/api/find`):

| Surface | What it returns |
|---|---|
| `GET /marketplace` | HTML dashboard: every seller indexed, tool count, network, last-fetched time, rolling health, discovery sources. (`GET /index` is the old path and now answers `301 → /marketplace`; follow redirects or just use `/marketplace`.) |
| `GET /api/index` | JSON snapshot of the same data: per-seller `health`, `routable`, rolling `history`, totals |
| `POST /api/route` | Smart Order Router / neutral x402 discovery API: `{ query, top, include }` → top-N matching tools across sellers, ranked by match score, then health, then price. `include` = `all` (default) / `external` (exclude Agent402 itself) / `local` |
| `GET /api/leaderboard` | On-chain ranking of every seller by **Base USDC settled volume** - see [[x402-Leaderboard]] |

And one **paid** executing surface built on the same resolver:

| Surface | What it does |
|---|---|
| `POST /api/route/execute` ($0.01) | Resolve a task description (or explicit slug) to the best-matching catalog tool and run it in the same call. Returns `{result, receipt}` - the receipt names the dispatched slug, its price (capped at $0.005 underlying), and how it was resolved. Underlying tool errors pass through with their own status codes. Wallet-only. |
| `POST /api/route/execute-plus` ($0.05) | Same contract, mid budget: underlying tools priced up to $0.04 - the proportional rung, so a $0.02 tool costs $0.05 through the router rather than $0.55. |
| `POST /api/route/execute-max` ($0.55) | Same contract, top budget: underlying tools priced up to $0.50. |
| `POST /api/route/execute-pro` ($3.30) | Same contract for the report-sized tools: underlying tools priced up to $3.00. |

### The execution tier ladder

Four rungs, because one flat routing fee cannot cover both a $0.001 utility and
a $3 report without overcharging almost every buyer:

| Route | You pay | Covers an underlying tool priced |
|---|---|---|
| `POST /api/route/execute` | $0.01 | ≤ $0.005 |
| `POST /api/route/execute-plus` | $0.05 | ≤ $0.04 |
| `POST /api/route/execute-max` | $0.55 | ≤ $0.50 |
| `POST /api/route/execute-pro` | $3.30 | ≤ $3.00 |

Pick the **cheapest rung that covers the tool**. You do not have to guess:
`POST /api/route` already quotes the right one per result in `executeVia`
(`{tool, price, underlyingPriceUsd, routingFeeUsd}`), and asking a rung to run
something above its cap returns a self-correcting `409` naming the exact tier
that covers it, or the tool's direct route. A `409` is a `4xx`, so it cancels
settlement: an under-budget attempt costs nothing.

### External execution: run any proven x402 or MPP seller in one call

With `include: "external"`, route-execute goes beyond this host's catalog: it resolves the best **external** seller for the task - an x402 seller from the open index, or an **MPP seller on Tempo** from the live-verified [MPP marketplace](https://agent402.tools/mpp-marketplace) - pays them from Agent402's own spending wallet over the seller's wire (x402 or MPP), and relays the result. One payment from you, one request, cross-vendor and cross-protocol settlement underneath.

The reliability filter is the point. The open ecosystem is full of endpoints that answer a 402 but never deliver a paid result, so route-execute only considers sellers with **proven settled volume** (on Base: on-chain completed deliveries on the [[x402-Leaderboard]]; on Algorand: verification counts witnessed by the GoPlausible facilitator; on Tempo/MPP: recent inbound USDC.e transfers to the seller's own recipient, read on-chain) and then probes the candidate for a live 402 before committing. External settlement is **chain-matched**: pay on Base and the router pays a Base seller from its Base spending wallet; pay on Algorand and it pays an Algorand seller from its AVM wallet; pay over MPP on Tempo and it pays a Tempo/MPP seller from its Tempo wallet - the chain you fund is the chain it spends. (An operator can additionally let Base buyers fall through to Tempo/MPP sellers.) A payment on a chain without a spending wallet gets an honest 409 naming the supported chains, and a 4xx/5xx always cancels your settlement, so you are never charged for a failure. Relayed bodies are marked `untrustedContent` (the seller's output, not ours). Default remains local-only: external routing is an explicit opt-in.

The full walkthrough - tiers, selection mechanics, chain matching, and a real production receipt with both on-chain settlement transactions - is the [Smart Order Router guide](https://agent402.tools/guides/smart-order-router).

## How a seller gets into the Index

1. **Local catalog** - the Agent402 server's own tools are always present (no network).
2. **Operator seeds** - origins listed in the `X402_INDEX_SEEDS` env (comma-separated) get crawled every 30 minutes.
3. **Auto-discovery** - every hour, the indexer pulls public x402 registries (currently the [Coinbase CDP Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar)) and adds new origins to the crawl set, capped at 50,000 sellers as a sanity guard. Crawls run through a worker pool with a concurrency limit (`CRAWL_CONCURRENCY = 25`) so a large seed list never floods outbound.

Each crawl fetches `<origin>/.well-known/x402` plus the seller's `openapi.json`
when present, runs every request through the SSRF guard (`safeFetch`), caps
response sizes, and records the outcome in a **rolling 5-entry history** per
seller.

## Health-aware routing

A buyer routed to a dead seller wastes money. The router takes that seriously:

- **Excluded:** a seller whose last `HEALTH_WINDOW` (5) crawl outcomes include any errors is **not routable** and is skipped by `/api/route`.
- **Brand new:** sellers with no history yet *are* routable - benefit of the doubt for newcomers.
- **Ranked:** at equal match score, healthier sellers rank first. Then cheaper wins.
- **Snapshot:** `GET /api/index` exposes every seller's `health` (0..1), `routable` flag, and rolling `history` so an operator can audit the decisions.

The unit tests for these guarantees live in [`scripts/test-router-health.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/scripts/test-router-health.js)
(eight scenarios, offline - they seed the in-memory cache directly via a test
escape hatch).

### Trust evidence for one seller (`GET /api/x402/seller-trust`, $0.005)

The router's gate, exposed as a tool so a buyer can ask about a specific origin
before routing to it. Pass a seller origin and get back the evidence the router
itself uses: whether the origin is indexed, whether its manifest parses, how
many tools it publishes, which chains it actually advertises, how many settled
calls it has been observed receiving on-chain, and the verdict on whether the
Smart Order Router would spend buyer money there. The gate is returned **field
by field**, so a refusal is explainable rather than a shrug.

It never fetches the seller at call time. This is accumulated crawl and
settlement evidence, not a liveness probe, so it cannot be used to make us
generate traffic against a third party.

## Calling the router

```bash
# Default - include everything (local + crawled remotes), pick the cheapest healthy match
curl -X POST https://agent402.tools/api/route \
  -H 'content-type: application/json' \
  -d '{"query":"ocr image to text","top":5}'

# Neutral discovery: rank only OTHER x402 sellers (exclude Agent402 itself)
curl -X POST https://agent402.tools/api/route \
  -H 'content-type: application/json' \
  -d '{"query":"ocr image to text","top":5,"include":"external"}'

# Local-only escape hatch (Agent402's catalog only)
curl -X POST https://agent402.tools/api/route \
  -H 'content-type: application/json' \
  -d '{"query":"ocr image to text","top":5,"include":"local"}'
```

Returns an **object**, not a bare array. The matches are in `results`:

```json
{
  "query": "screenshot webpage",
  "include": "all",
  "count": 2,
  "sellers": 2,
  "results": [
    {
      "seller": "https://seller.example",
      "sellerHome": "https://seller.example",
      "sellerName": "seller.example",
      "slug": "screenshot",
      "name": "Screenshot any URL through headless Chromium",
      "method": "POST",
      "route": "/shot",
      "url": "https://seller.example/shot",
      "price": 0.005,
      "priceUsd": 0.005,
      "category": "other",
      "description": "…",
      "score": 13,
      "health": 1,
      "networks": ["eip155:8453"],
      "paymentNetworksKnown": true,
      "routerDispatchEligible": true,
      "routerDispatchReason": "eligible",
      "executeViaCallableNow": true,
      "executeVia": {
        "tool": "route-execute",
        "price": "$0.01",
        "underlyingPriceUsd": 0.005,
        "routingFeeUsd": 0.005
      },
      "untrustedContent": true,
      "source": "https://seller.example"
    }
  ]
}
```

- `seller` is `"self"` for the local catalog, or the origin URL for a remote
  seller, so a buyer can address the right seller directly. `url` is the full
  callable endpoint.
- `price` is whatever the seller published (a number or a string); **`priceUsd`
  is the normalized number** to compare on.
- `routerDispatchEligible` / `routerDispatchReason` say whether this host's
  router will pay the seller on your behalf right now and why not otherwise
  (`crawl_failed`, `network_unknown`, `no_supported_route`, `url_template`,
  `price_unknown`, `settlement_required`, `settlement_checked_at_pay_time`,
  `eligible`, `local_catalog`); `routable` and `health` are crawl readiness,
  never a promise to pay. The response's `dispatchLegend` spells each out.
- `executeVia` names the cheapest execution rung that covers this result (see
  the ladder above) and appears **only on a row the router will pay now**
  (`executeViaCallableNow: true`). A row that is not dispatch-eligible carries
  `executeViaWhenEligible` with `executeViaCallableNow: false` instead, so a
  tier name never reads as a callable action. `networksInferred: true` marks a
  row whose chains were inherited from its seller rather than read on its own 402.
- `count` is the number of results returned; `sellers` is how many distinct
  sellers they came from.
- The response echoes back the resolved `include` value (invalid values fall
  back to `all`).

## Why this matters - the router as the x402 front door

- **Neutral discovery layer.** `include:"external"` lets buyers explicitly route to non-Agent402 sellers. We list because we trust the ranking, not because we'd rig it for ourselves - and that makes the same endpoint usable as a public discovery API for the whole protocol, not just our catalog.
- **One integration, the whole ecosystem.** A buyer that integrates Agent402's `agent402-client` SDK or the hosted `/mcp` connector already has access to 500+ local tools *and* can route across every other x402 seller without per-seller wiring.
- **Discoverability that compounds.** Sellers don't have to register with Agent402 - appearing in any public x402 registry is enough. The Index pulls them in automatically.
- **Trust signals are checkable.** Health scores are derived from real crawl outcomes, not self-reports. The full `history` is in `/api/index` for anyone to verify. Agent402 advertises this surface in its own [`/.well-known/x402` manifest](https://agent402.tools/.well-known/x402) under the `discovery` field so other indexes and agents can find the router programmatically.

## Related

- [[Architecture]] - where the indexer sits in the request flow
- [[Operations]] - 3-rail attribution (USDC / PoW / Heartbeat) on the operator dashboard
- [[x402-Leaderboard]] - on-chain ranking using the same Bazaar walk
- [`/api/find`](https://agent402.tools/api/find) - local-only resolver (older, simpler)
