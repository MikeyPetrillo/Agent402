# Changelog

## Unreleased

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
