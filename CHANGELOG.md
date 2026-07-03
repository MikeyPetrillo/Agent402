# Changelog

## Unreleased

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
