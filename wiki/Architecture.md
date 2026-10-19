# Architecture

One Node 22 / Express process serving everything; deliberately boring where possible.

```
                      ┌──────────────────────────────────────────────┐
   agent (buyer) ───▶ │  Express                                     │
                      │   free surfaces: /, /tools, /api/pricing,    │
                      │     /openapi.json, /llms.txt, /api/stats,    │
                      │     /api/pow*, /mcp, /privacy                │
                      │   gate (per request, in order):              │
                      │     HEAD on a catalog GET ──▶ rewritten to   │
                      │              GET so no gate is skipped       │
                      │     MPP shim: Authorization: Payment ──▶     │
                      │              re-encoded as PAYMENT-SIGNATURE │
                      │     tempo / stripe / credits gates: settle   │
                      │              after a <400 response, bypass   │
                      │              the x402 dispatcher on accept   │
                      │     Idempotency-Key? ──▶ replay a cached     │
                      │              settled 200 for the same key    │
                      │     valid X-Pow-Solution? ──▶ bypass         │
                      │     else ──▶ x402 paywall (402 quote, then   │
                      │              handler, then verify+settle)    │
                      │   500+ tool handlers (pure fns + kits)      │
                      └──────┬───────────────┬───────────────────────┘
                             │               │
              render worker (separate     state: Postgres state database when
              service, no secrets):       STATE_DATABASE_URL is set, else SQLite
                                          + files on the /data volume
              Playwright Chromium +
              ffmpeg (no shell)
```

The browser/media tier is a **separate service**, not in-process: when
`RENDER_WORKER_URL` + `RENDER_WORKER_TOKEN` are set (`src/worker-client.js`),
`render` / `screenshot` / the media handlers execute in a worker that holds no
payment, DB, operator, or provider secrets and has no `/data` mount, so a
Chromium or ffmpeg parser compromise from hostile input lands somewhere with
nothing worth stealing. Setting exactly one of the two fails the boot loudly;
`RENDER_WORKER_REQUIRED` refuses to boot at all without the worker. Unset both
and everything runs in-process (the self-host default).

The **MPP dual-stack shim** (`src/mpp-shim.js`, mounted when `MPP_SECRET_KEY`
is set) is pure header translation: 402s gain a `WWW-Authenticate: Payment`
challenge per allowed EVM rail, and an inbound `Authorization: Payment`
credential that HMAC-verifies is re-encoded as `PAYMENT-SIGNATURE` before the
paywall sees it. `@x402/express` keeps sole settlement authority, and every
paywall invariant (replay guard, payer attribution, settlement ordering,
idempotency) reads the same header it always did.

**Tempo, a second, independent MPP settlement path** (`src/mpp-tempo.js`,
mounted when `TEMPO_API_KEY` is set), exists because Tempo's `tempo` MPP
method uses TIP-1034/TIP-20 primitives, not EIP-3009, so it can never become
a `PAYMENT-SIGNATURE`; no x402 facilitator can settle it, and the shim above
genuinely doesn't apply. This is NOT a translation layer: a `createTempoGate`
middleware buffers the route handler's response (mirroring `@x402/express`'s
own settlement-ordering technique) and, by default, only calls Tempo's hosted
relay (`api.tempo.xyz`, a non-mutating `validate` then a terminal `broadcast`)
after
a successful handler response, preserving the same "handler runs before
money moves" guarantee through an entirely separate mechanism. A dedicated
`createReplayGuard()` instance (never shared with the x402 one) closes the
concurrent-replay window this path would otherwise leave open, since it
bypasses the PoW/replay-guard/x402mw dispatcher chain entirely.

**Two more settle-after-handler gates share that shape.** `src/mpp-stripe.js` (mounted
when `STRIPE_SECRET_KEY` + `STRIPE_PROFILE_ID` are set) mints `stripe/charge` MPP
challenges on routes priced $0.50 or more and settles a Stripe PaymentIntent only
after a successful handler response. `src/credits.js` (mounted with the Stripe key)
authorizes an `Authorization: Bearer a402_…` prepaid-credits key against its balance
BEFORE the handler, holds the list price, and debits only on a final `200`. Both strip
the x402 payment headers on acceptance and refuse identity-bound routes (memory,
`my-usage`), where the signed wallet is the identity.

**The hosted MCP connector is payable over MPP too** (`src/mcp-mpp.js`): a paid call
is answered with a tool result carrying the challenges in `_meta` (`-32042` on the tasks path, `-32043` for a refused credential), the credential rides back in `_meta`, and the connector
replays it as a loopback HTTP request to its own paid route so the gates above keep
sole settlement authority.

**Human front door + recurring engine** (`src/human-checkout.js`,
`src/stripe-subscriptions.js`, `src/monitor-scheduler.js`, `src/credits.js`, all gated
on `STRIPE_SECRET_KEY`): `/reports` sells the report products by card (Stripe
Checkout, generate-once per paid session, auto-refund on failure, report at
`/r/:session`), `/monitors` sells $5/month subscriptions whose fulfilment is a
10-minute scheduler tick (free daily probes, a paid re-run only on change or cadence,
reports at `/m/:id`, emails via `src/email.js`), and `/credits` sells prepaid credit
packs while `CREDITS_SALES=on` (off by default; keys already issued keep spending). The Stripe webhook endpoint is signature-verified with
`STRIPE_WEBHOOK_SECRET`. Stores are rows in the Postgres state database when `STATE_DATABASE_URL` is set, and atomic files under `/data` otherwise.

## Key pieces

- **Catalog as data.** Every tool is an entry `{ route, slug, price, description, discovery: { inputSchema, example }, handler }`. The paywall, docs pages, OpenAPI spec, llms.txt, sitemap, MCP servers, and CI tests are all *generated from the same catalog* - one source of truth, so a new tool is automatically priced, documented, discoverable, and tested. The report products (`src/tools/research-deep-kit.js`, `dossier-kit.js`, `ticker-pack-kit.js`, `fund-report-kit.js`, `filing-watch-kit.js`, `domain-audit-kit.js`, `recall-report-kit.js`, `insider-flow-kit.js`, `token-brief-kit.js`, `token-risk-kit.js`, `linkedin-article-kit.js`, `ipo-report-kit.js`) are ordinary catalog entries on `/v1/...` routes; the card front door and the monitor scheduler call the same handlers.
- **Payments** (`src/payments.js`): `@x402/express` middleware quoting USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar and Algorand, plus USDG on Robinhood Chain: twelve x402 networks. **No single facilitator covers all twelve.** Each chain is routed to a facilitator that settles it, with clients tried in order; the per-network order lives in `src/payments.js`, and the environment that configures each one is in [[Self-Hosting]]. Stellar rides the self-hosted facilitator in this repository (`STELLAR_FACILITATOR_URL`). `PAYMENT_SETTLE_FALLBACK=true` adds a last-resort re-settle chain for a primary that rejects settlement *before* broadcasting, never on a timeout or 5xx, so it cannot double-settle. Multi-chain USDC schemes are registered in code. Monad (EVM chain id 143), Celo (42220), Avalanche (43114), Sei (1329) and Optimism (10) are opt-in via `PAYMENT_NETWORKS`, each settling through a facilitator that advertises it, with on-chain-verified USDC domains (money parsers in code). Robinhood Chain (USDG / Global Dollar, chain id 4663) settles through an operator-supplied facilitator (`ROBINHOOD_FACILITATOR_URL`) with a custom USDG money parser.
- **Proof-of-work** (`src/pow.js`): HMAC-signed challenges, difficulty 16 bits, single-use (a replay table in the state database, or SQLite on the volume without one), strictly slug-scoped. A `WALLET_ONLY_SLUGS` set keeps anything that costs real money out of the free tier.
- **Browser tools** (`src/tools/render.js`, executed in the render worker): a shared headless Chromium with max 3 concurrent contexts, self-healing relaunch on crash, and per-request SSRF re-validation of *every* subresource the page loads (see [[Security Model]]).
- **Media tools** (same worker): ffmpeg via `execFile` (no shell), 30 MB cap, 90 s timeout, max 2 concurrent with `429 + Retry-After`.
- **Remote MCP** (`src/mcp-http.js` + `src/mcp-flagship.js`): stateless streamable-HTTP endpoint mounted *before* the paywall; it meters itself (free set + per-IP rate limit) and feeds the same stats counters. Tools are dotted (`catalog.find`, `catalog.call`, `web.search`, …; the old snake names are aliases only) and wallet-only tools are payable in the call over MPP (`src/mcp-mpp.js`).
- **x402 Index + Router** (`src/x402-index.js`): a free, in-memory aggregation layer. Crawls the local catalog + operator seeds + auto-discovered sellers (from public x402 registries, refreshed hourly) every 30 minutes via `safeFetch`. Every crawl outcome lands in a rolling 5-entry history per seller; the Smart Order Router (`POST /api/route`) skips sellers whose recent history shows errors, and breaks ties on health, then distinct payers over the last 30 days, then price, then the curated flag (each result lists the order in `why.tiebreaks`). Public surfaces: `/marketplace` (HTML; `/index` redirects there), `/api/index` (JSON), `/api/route` (router). See [[x402-Index-and-Router]].
- **State** (`src/state-db.js`): when `STATE_DATABASE_URL` is set (the hosted instance), documents, records, logs, memory namespaces, PoW replay protection and the leases every scheduled loop runs under live in a Postgres state database (schema `state`), so two containers can overlap during a deploy. Unset, the same stores are SQLite (better-sqlite3, WAL) and files on a persistent volume at `/data`. Either way they survive redeploys.
- **Shutdown**: SIGTERM drains in-flight requests before exit, because a hard kill would take an agent's money and return nothing.

## Design positions

- **No LLM in the utility serving path.** The utility tools are deterministic: schemas, flat prices, reproducible outputs. The model-backed surfaces are the `/v1` gateway and judgment routes, the report products, Decide, the router's judgment model, and the image, speech, transcription, embedding and answer tools; each carries `modelBacked: true` in `/api/pricing`, says so, and is priced for it (the metered tier quotes a ceiling per request).
- **Settlement evidence comes from the chain, never from a registry.** Before the router pays an outside seller from our wallet, it wants evidence that others already pay them. That evidence is read from the chain on every rail we can spend on: Base and Solana from their own USDC transfers, Tempo from its own, Algorand from inbound USDC-ASA transfers to the payTo the seller advertises. Third-party registries (Coinbase's Bazaar, a facilitator's catalog) are a source of CANDIDATES and never the only source, so a seller indexed only by our own crawl is judged on its chain history like any other. An unreadable chain is a refusal, not evidence, and evidence a seller inherits from a wallet it does not itself pay to is refused outright.
- **Payment is identity.** No accounts means no credential database, no signup abuse surface, and memory ownership falls out of the payment protocol for free.
- **Charge-then-fail is unacceptable.** Get the ordering right: the installed `@x402/express` runs the **handler first and settles afterwards**, and it settles **only** a response whose `statusCode` is `< 400`. Any `4xx`/`5xx` (a bad input, a capacity `503`, an upstream `502`) **cancels settlement**, so the buyer is not charged for a failure. A `200` is charged only if settlement then succeeds; if settlement of a `200` fails, the buffered body is discarded and the caller gets a `402` instead. Two consequences the code depends on: anything that caches, credits, or bills must key off the **final, post-settlement** response (`res.on("finish")` with `statusCode === 200`), never the handler's own status; and a tool that cannot be served reliably (e.g. upstreams that block datacenter IPs) gets removed from the catalog rather than monetized, because a steady stream of canceled settlements is a broken product even though nobody was billed.
