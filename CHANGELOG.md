# Changelog

## Unreleased

- **Payment-nonce replay guard** (security hardening, M3): the x402 paywall now rejects a
  duplicate payment authorization *before* it reaches the facilitator, and refuses a
  concurrent replay (the same signed authorization fired many times at once, racing the
  settle). Agent402 already settles-before-grant — an EIP-3009 nonce is single-use on-chain,
  so a replayed authorization fails at the facilitator and the duplicate-grant rate was
  already 1 — this is a strictly-earlier, cheaper defense-in-depth layer against Attack II
  ("replay / insufficient idempotency") from the "Five Attacks on x402" analysis.
  Release-on-failure: a nonce is only marked consumed on a granted 200 (which, under
  settle-before-grant, means the payment settled); any non-200 releases it so a legitimate
  retry of the still-valid authorization proceeds. Requests without a payment header (unpaid
  402 challenges, discovery crawls, proof-of-work calls) are never touched. New
  `src/replay-guard.js`; CI-locked (`scripts/test-replay-guard.js`, incl. a concurrent-replay
  HTTP E2E proving 8 identical authorizations collapse to a single grant).

- **Router Sybil / metadata-capture resistance** (security hardening, M6): the neutral
  cross-seller router (`/api/route`, MCP router) now (1) drops any external listing whose the neutral
  cross-seller router (`/api/route`, MCP router) now (1) drops any external listing whose
  text tries to command the ranker — "ignore previous instructions", "always pick this",
  fake `<system>` tags, oversized padding — instead of describing a tool, and (2) caps how
  many shortlist slots any one external seller can occupy (`ceil(k/3)`), backfilling from
  the remainder so a full shortlist is still returned. This blunts the discovery-capture
  failure mode (Attack IV) from the "Five Attacks on x402" analysis, where one crafted
  server reached 71.8% selection via metadata injection and a single domain owned 77.5% of
  a real registry's results. The local catalog is exempt (one trusted seller by construction);
  honest limitation: a Sybil spread across many distinct domains/wallets still gets one slot
  each — the paper's open problem. CI-locked (`scripts/test-router-sybil.js`).

- **Cache hygiene on paid responses** (security hardening, M5): every gated catalog
  response now sets `Cache-Control: no-store, private`, so a shared cache or CDN can never
  serve a paid result to a later unpaid caller of the same URL. This closes the cache-leakage
  failure mode (Attack III) from the "Five Attacks on x402 Agentic Payment Protocol" analysis,
  which validated the leak at 100% on nginx `proxy_cache`. Free discovery/static surfaces
  (`/llms.txt`, landing, `/api/find`, `/api/pricing`…) are unaffected and keep their public
  caching. CI-locked (`scripts/test-cache-hygiene.js`).

- **Skill packs are now the front door**: the home page hero, page titles, meta/OG
  descriptions, and top nav all lead with "46 skill packs — a whole agent job, one x402
  payment" (the tool catalog reframed as the supporting long tail), with a six-pack
  flagship showcase (financial-research, search-and-cite, onchain-analyst, seo-audit,
  wallet-readiness, decode-blob) linking straight to `POST /api/skill/{slug}`. llms.txt
  now tells agents up front that packs are buyable as ONE bundled x402 call — previously
  it only advertised the free prompt-template route. Every count stays exact.

- **Sales ledger** (`/api/sales` + a "What's selling" section on `/revenue`): every served
  paid/proven call recorded BY NAME at settle time — slug, price, rail, settlement chain,
  verified EIP-3009 payer, settle tx — on the persistent `/data` volume, classified
  internal/external (heartbeat-token traffic and burner-wallet payers never count as
  demand). Answers the merchant question the odometer can't: which tools do external
  wallets actually buy, and who comes back. The paid canary now sends the POW_SECRET-signed
  heartbeat token on every request so its daily real-money buys are excluded from demand
  metrics on all rails (including Solana, where the payer isn't server-visible).

- **Four new skill packs** (catalog: 1,346 → **1,350** tools, 42 → **46** packs), aimed at
  real agent jobs on the newest kits: `wallet-readiness` ($0.05 — USDC balances on Base +
  Solana, gas, and a Coinbase Onramp funding link in one preflight), `onchain-analyst`
  ($0.20 — your SQL over Coinbase's decoded Base data with the schema + a stats profile of
  the result in the same envelope), `seo-audit` ($0.07 — reachability, TLS, robots policy
  incl. LLM crawlers, sitemap, meta/OG, and X-Robots-Tag headers for one URL), and
  `cheapest-rail` ($0.05 — live cross-chain gas comparison priced in dollars). All four are
  wallet-only (every underlying tool hits the network). agent402-mcp 0.11.2 and
  agent402-client 0.4.2 republished for the corrected catalog metadata.

- **PostHog conversion funnel** (discovery → 402 → settlement): the env-gated PostHog stream
  gains three funnel events — `discovery` (machine-readable surface fetches: llms.txt,
  openapi.json, the x402 manifest, pricing, `/api/find`, index, route, and the MCP connector's
  search/find/about tools), `paywall_402` (quotes issued; rolled up in memory per slug/window
  so registry-crawler sweeps can't blow the event budget — `sum(count)` is the exact total),
  and `payment_settled` (rail-attributed: usdc with the settlement chain from the x402
  receipt, pow, heartbeat, marketplace). Privacy posture unchanged: no caller IP/UA/wallet
  — aggregate stage counters only, conversion computed as a ratio of stage totals. A CI test
  boots a paid-mode server against a mock facilitator (real offline 402s) and asserts the
  exact events; an operator dashboard with stage trends, the 402→paid conversion ratio, and
  settled-$ tracking ships alongside.

- **Weekly x402 Economy report**: every observatory refresh now persists its daily settlement
  rows into SQLite on the `/data` volume, so history compounds past the 30-day query window.
  `/x402-economy` gains a week-over-week trend line (trailing 7 complete days vs the prior 7)
  and `/api/x402-economy` exposes `weekly`; the daily digest workflow warms the snapshot so a
  history row lands every day even with zero page traffic.

- **Claims audit** (site + GitHub + packages): every public factual claim re-verified against
  the live system. Tool counts corrected 1,338 → **1,346** across 27 files (README, wiki, npm
  package descriptions, site pages, badges); free-tier count corrected to **1,156**
  (was variously ~1,040/~1,100/1,158); the hardcoded GitHub star count removed from the site
  nav; hand-written chain lists that omitted the USDG/Robinhood rail completed (landing metas,
  pricing meta, MCP connector tool descriptions); third-party claims hedged (Cloudflare
  gateway status, Stripe's x402 role stated as client tooling); absolutes softened ("every
  x402 seller" → indexed sellers, "guaranteed valid JSON" → schema-enforced, "only public
  gate" → one of the few). Packages republished for the corrected npm metadata:
  agent402-mcp 0.11.1, agent402-client 0.4.1, agent402-tollbooth 0.4.1.

- **x402 Economy Observatory** (`/x402-economy` + `GET /api/x402-economy`): live, chain-wide
  analytics on the x402 economy — daily gasless EIP-3009 USDC settlements on Base, unique
  payers, volume, and the top-earning seller wallets, measured directly from decoded on-chain
  events (Transfer + AuthorizationUsed pairs on the USDC contract) across EVERY seller, not
  just Agent402 — including sellers no directory has indexed. Data flows through the same paid
  `onchain-sql` tool agents can buy. 30-minute cache, per-query error resilience, graceful
  "warming up" state without CDP keys.

- **Onchain SQL** (`onchain-sql` $0.02 + `onchain-sql-schema` $0.002): run read-only
  ClickHouse-dialect SQL against Coinbase's indexed, DECODED chain data — `base.events`
  (decoded logs with parameters), `base.transactions`, `base.blocks`,
  `base.decoded_user_operations`, `base.transaction_attributions` (builder codes), plus
  Solana token instructions — as a pay-per-call x402 tool. Ask Base anything in one call,
  no indexer to run; server-side grammar validation, 50k rows / 30s / 100GB-read caps,
  optional result caching. The groundwork for the x402 Economy Observatory.

- **Solana onboarding parity**: `testnet-fund` now also drips on **Solana devnet** (USDC or
  SOL via the CDP faucet, base58 validation, solscan devnet links) and `wallet-balances`
  reads **Solana + Solana devnet** SPL balances (mint address in the `contract` field) —
  the create → rehearse → fund → verify loop now covers both major rails end to end.

- **Wallet birth-to-first-purchase E2E + non-custodial wallet guide**: a CI test generates a
  fresh keypair inside the runner (only the address is ever printed), funds it with testnet
  USDC via the CDP faucet, completes a REAL gasless x402 purchase against a paid-mode
  base-sepolia server, then scans every byte of its own output and the server's full log for
  key material in any prefix/case form — failing on any hit. The offline leg (keygen + leak
  audit) gates every test run. A new guide, `/guides/create-agent-wallet`, documents the same
  flow for users: keys generated locally and never transmitted, gasless payments (USDC only,
  no ETH), testnet rehearsal via `testnet-fund`, real funding via `onramp-link`.

- **CDP onboarding kit** (`wallet-balances`, `testnet-fund`, `onramp-link`): agent-wallet
  onboarding tools built on the Coinbase Developer Platform, reusing the same CDP keys that
  already drive x402 settlement (no new secrets; 503 when unset). `wallet-balances` returns
  indexed ERC-20 + native balances for any address in one call; `testnet-fund` drips Base
  Sepolia USDC/ETH via the CDP faucet so an agent can rehearse the full x402 payment loop
  safely — a tenth of a cent buys a full testnet dollar (local + CDP-side rate caps); `onramp-link`
  mints a single-use Coinbase Onramp URL so a human can fund an agent's wallet with a card or
  Apple Pay. Auth is a zero-dependency `node:crypto` JWT signer (ES256 PEM + Ed25519 base64,
  mirroring the official SDK's claims), unit-tested offline with real signature verification
  plus a live CI check where the secrets exist.

- **USDG buyer support in the packages**: `agent402-mcp` 0.11.0 adds `AGENT402_NETWORKS` (restrict + order the chains the buyer pays on — `robinhood` settles USDG on chain 4663; raw CAIP-2 accepted); `agent402-client` 0.4.0 exports a zero-dep `withNetworkPreference(client, networks)`. Both throw before paying if the preference matches none of a seller's options.
- **Tollbooth 0.4.0**: `TOLLBOOTH_ASSET` (with the existing `TOLLBOOTH_NETWORK`) lets operators charge crawlers in USDG on Robinhood Chain; defaults (USDC on Base) unchanged and regression-guarded.
- **Network-aware Smart Order Router**: crawled sellers record every chain their 402 advertises; `/api/route?network=<name|caip2>` filters to sellers that settle there (positive-signal semantics); `/index` rows carry `networks`.
- **/robinhood**: dedicated landing page for the USDG rail (chain params, buyer/seller recipes, on-chain proof), derived from the single rails source of truth.
- **Revenue visibility**: `SCAN_NETWORK=robinhood` on the revenue scanner (USDG on chain 4663); the CI probe scans it when offered; a new daily **revenue-digest** workflow maintains a single per-rail takings issue.
- **Live consolidated revenue view** (`/revenue` + `GET /api/revenue`): every rail's wallet balance and recent inbound transfers on one page — Base / Solana / Polygon / Arbitrum / Robinhood Chain read live from public RPCs (60s cache, best-effort per rail), every figure linking to its explorer proof. Replaces cycling three explorer tabs; the rails-copy CI lock asserts the view covers every configured rail. Transfers are classified with the scanners' shared rule — internal canary/test money renders dimmed and never counts as revenue.
- **All-time revenue ledger** (`src/revenue-ledger.js`): a persistent SQLite table (on the `/data` volume, same pattern as stats) of every inbound stablecoin transfer on every rail, backfilled from the wallet's first funding via polite chunked RPC sweeps with a resumable per-chain cursor, then tailed incrementally. `SUM(external)` = true all-time revenue — the headline figure on `/revenue` and `allTime` in `/api/revenue`, with per-chain splits and sync progress. Unit-tested (idempotent rescans, wallet scoping, CI self-gate: the loop only runs where `/data` exists or `REVENUE_LEDGER=true`).
- **Ops armor**: daily USDG canary leg (real $0.001 settlement, accepts-pinned), heartbeat rails check (pages if Base — or an intended Robinhood rail — drops from the live 402), deploy job now polls Railway to SUCCESS before verifying (no more false-green deploys), and a gating rails-copy CI lock (`src/rails.js` ↔ payments code ↔ rendered pages, incl. the topbar ticker).

- **Robinhood Chain support** (chain reads + a full payment rail): added Robinhood Chain (Arbitrum Orbit / Nitro L2, EVM-equivalent, chain id 4663, AI-native RWA chain, mainnet live 2026-07-01) end to end. `tx-status` and `gas-estimate` accept `network=robinhood` against the public RPC (its canonical stablecoin is USDG / Global Dollar, not Circle USDC, so the USDC-specific tools return a clear message on that network). **x402 payments settle in USDG on Robinhood Chain**: opt in with `robinhood` in `PAYMENT_NETWORKS` + an operator-supplied `ROBINHOOD_FACILITATOR_URL`; a custom money parser resolves USDG (6 decimals, EIP-712 domain env-overridable) and settlement routes to that facilitator without disturbing the CDP (Base) / PayAI paths. Verified with a real on-chain USDG settlement.
- **Payments hardening**: a network listed in `PAYMENT_NETWORKS` with no facilitator behind it (e.g. `robinhood` without `ROBINHOOD_FACILITATOR_URL`) is now dropped from the 402 offer instead of poisoning the challenge — previously this surfaced as HTTP 500 on every paid endpoint. Unknown `PAYMENT_NETWORKS` entries are skipped with a warning instead of crashing boot. A gating CI regression test reproduces the exact misconfig.
- **Facilitator failure observability**: `onVerifyFailure`/`onSettleFailure` hooks log every facilitator rejection loudly (kind, network, payer, reason) — a silent settle regression now leaves a trace. Optional `PAYMENT_SETTLE_FALLBACK` re-settles via PayAI only on pre-broadcast rejections (never on timeout/5xx, so it can't double-settle).
- **x402 Index + Smart Order Router** (`/index`, `GET /api/index`, `POST /api/route`): free, cross-seller routing layer. Crawls the local catalog plus operator seeds plus an auto-discovered set from public x402 registries (Coinbase CDP Bazaar, refreshed hourly). Picks the cheapest healthy seller for a task.
- **Health-aware routing**: each seller carries a rolling 5-entry crawl history. Sellers whose recent crawls errored are excluded from `/api/route`; healthier sellers tiebreak ahead of cheaper-but-flaky ones at equal match score.
- **Three-rail attribution** on `/api/stats` and `/__operator`: USDC / proof-of-work / heartbeat counts are tracked separately so the maintainer can see real external demand vs. internal probe noise. The heartbeat rail is now gated on a `POW_SECRET`-signed `X-Heartbeat-Token` (HMAC of UTC minute with ±5 min skew) — not a spoofable User-Agent — closing the audit finding from `scripts/audit-deep.mjs`.
- **Charged-but-failed counter**: any non-200 response that left an `X-PAYMENT-RESPONSE` header is now tracked so the operator can catch handlers that errored after the buyer was charged.
- **New kits**: `ocr-image` (pure-CPU OCR) and a deterministic `geo-*` set (distance / bbox / bearing / geohash).

## v1.0.0 — 2026-06-12

The service is feature-complete as a v1 and battle-tested end to end:

- **~1,338 pay-per-call tools** live at [agent402.tools](https://agent402.tools): browser rendering/screenshots, live web search, PDFs, real-ffmpeg audio, wallet-keyed memory with cross-wallet grants and a hash-chained audit log, US open-data feeds, and ~1,040 pure-CPU utilities including ~970 unit conversions.
- **Three payment rails**: x402 (USDC on Base, Solana, Polygon & Arbitrum; Coinbase CDP facilitator), a proof-of-work free tier (single-use, slug-scoped sha256 challenges), and the agent402.app marketplace bridge.
- **MCP everywhere**: hosted streamable-HTTP connector at `agent402.tools/mcp` (authless free tier, rate-limited) + the [`agent402-mcp`](https://www.npmjs.com/package/agent402-mcp) npm server (v0.3.0) with pre-signature spend controls — both published in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.MikeyPetrillo/agent402).
- **Interop proven with real money**: Stripe's [`purl`](https://github.com/stripe/purl) x402 client parses our quotes and settles paid calls (CI-verified); marketplace roundtrip settled real USDC end to end.
- **Operations**: CI re-tests every endpoint against its own documented example before each deploy; a heartbeat probes production every 15 minutes and decodes on-chain receipts every 6 hours to flag external customers; SQLite state on a persistent volume; graceful drain on redeploy.
- **Hardening**: DNS-pinned SSRF guards with per-request browser re-validation, wallet-only gating of costly tools, zero `npm audit` findings (vulnerable Excel toolchain removed along with its tools), MIT-licensed and fully open source.
