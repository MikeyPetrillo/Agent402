# Architecture

One Node 22 / Express process serving everything; deliberately boring where possible.

```
                      ┌──────────────────────────────────────────────┐
   agent (buyer) ───▶ │  Express                                     │
                      │   free surfaces: /, /tools, /api/pricing,    │
                      │     /openapi.json, /llms.txt, /api/stats,    │
                      │     /api/pow*, /mcp, /privacy                │
                      │   gate (per request):                        │
                      │     marketplace token? ──▶ bypass            │
                      │     valid X-Pow-Solution? ──▶ bypass         │
                      │     else ──▶ x402 paywall (402 quote /       │
                      │              verify+settle via facilitator)  │
                      │   1,199 tool handlers (pure fns + kits)      │
                      └──────┬───────────────┬───────────────────────┘
                             │               │
                   Playwright Chromium   SQLite (WAL) on /data volume
                   ffmpeg (no shell)     (stats · memory · pow replay)
```

## Key pieces

- **Catalog as data.** Every tool is an entry `{ route, slug, price, description, discovery: { inputSchema, example }, handler }`. The paywall, docs pages, OpenAPI spec, llms.txt, sitemap, MCP servers, and CI tests are all *generated from the same catalog* — one source of truth, so a new tool is automatically priced, documented, discoverable, and tested.
- **Payments** (`src/payments.js`): `@x402/express` middleware quoting USDC on Base (`eip155:8453`), settled through the **Coinbase CDP facilitator** (`CDP_API_KEY_ID/SECRET`; `FACILITATOR_URL` overrides). Multi-chain USDC schemes are registered in code.
- **Proof-of-work** (`src/pow.js`): HMAC-signed challenges, difficulty 16 bits, single-use (replay table in SQLite), strictly slug-scoped. A `WALLET_ONLY_SLUGS` set keeps anything that costs real money out of the free tier.
- **Browser tools** (`src/tools/render.js`): a shared headless Chromium with max 3 concurrent contexts, self-healing relaunch on crash, and per-request SSRF re-validation of *every* subresource the page loads (see [[Security Model]]).
- **Media tools**: ffmpeg via `execFile` (no shell), 30 MB cap, 90 s timeout, max 2 concurrent with `429 + Retry-After`.
- **Remote MCP** (`src/mcp-http.js`): stateless streamable-HTTP endpoint mounted *before* the paywall; it meters itself (free set + per-IP rate limit) and feeds the same stats counters.
- **x402 Index + Router** (`src/x402-index.js`): a free, in-memory aggregation layer. Crawls the local catalog + operator seeds + auto-discovered sellers (from public x402 registries, refreshed hourly) every 5 minutes via `safeFetch`. Every crawl outcome lands in a rolling 5-entry history per seller; the Smart Order Router (`POST /api/route`) skips sellers whose recent history shows errors, and tiebreaks on health then price. Public surfaces: `/index` (HTML), `/api/index` (JSON), `/api/route` (router). See [[x402-Index-and-Router]].
- **Marketplace bridge** (`/mkt/:token/:slug`): agent402.app collects the buyer's USDC (settled directly to our wallet) and forwards the call with a token that bypasses our own paywall. The token in the URL is **per-slug** (`HMAC(master, slug)`), so the master secret never appears in a URL and a leaked endpoint exposes only its one tool — timing-safe comparison, global rate cap.
- **State**: SQLite (better-sqlite3, WAL) on a Railway persistent volume at `/data` — stats, memory namespaces, PoW replay protection all survive redeploys.
- **Shutdown**: SIGTERM drains in-flight requests before exit, because a hard kill would take an agent's money and return nothing.

## Design positions

- **No LLM in the serving path.** Determinism is the product: schemas, flat prices, reproducible outputs.
- **Payment is identity.** No accounts means no credential database, no signup abuse surface, and memory ownership falls out of the payment protocol for free.
- **Charge-then-fail is unacceptable.** x402 settles before the handler runs, so anything that can't be served reliably (e.g. upstreams that block datacenter IPs) gets removed from the catalog rather than monetized.
