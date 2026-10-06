# Operations

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Deploys and production probes run through GitHub Actions (`deploy.yml` and `heartbeat.yml` are the two described here; the repository carries others for canaries, refunds and listings); production is a single Railway service with a persistent volume.

## Deploy pipeline (`.github/workflows/deploy.yml`)

Jobs are selected by commit-message markers or `workflow_dispatch`; every push to the development branch runs the test lanes with or without a marker, and a push to `main` (a PR merge) tests and deploys unconditionally. The full marker set, as parsed by the workflow, is:

`[test]` · `[deploy]` · `[publish]` · `[probe]` · `[drain]` · `[paytest]` · `[purl]` · `[bazaar-refresh]` · `[bazaar-register]` · `[bazaar-solana]`

| Job | What it proves |
|---|---|
| `test` | Boots the server in free mode and runs the full gauntlet: unit tests for memory/kit2/PDF/media/conversions, **every endpoint called with its own documented example** (500+ calls), live-site exercises, the SSRF guard (metadata endpoint must be blocked), PoW gate with payments enabled, MCP server e2e, the remote `/mcp` connector e2e - then polls **production** post-deploy: catalog size, 402 on unpaid calls, SEO surfaces, a real PoW-settled call, and the live `/mcp` endpoint |
| `deploy` | Railway via GraphQL: find/create project + service, ensure the `/data` volume, domains, env vars, trigger the image build |
| `publish` | Every published package to npm over OIDC trusted publishing (`agent402-mcp`, the tollbooth, the client, the OpenClaw plugin and the framework adapters), then the official MCP Registry via GitHub OIDC |
| `paytest` | Funded-wallet end-to-end buys against production |
| `purl` | Interop: Stripe's `purl` client must parse our 402 and (burner permitting) settle a real payment |
| `probe` | Read-only diagnostics: Railway deploy history, on-chain revenue decode |
| `bazaar-refresh` / `bazaar-register` / `bazaar-solana` | Discovery upkeep: re-walk the Bazaar, pay one tiny call on routes it has never registered so they get harvested, and the Solana-rail equivalent |

## Heartbeat (`.github/workflows/heartbeat.yml`)

- **Every 15 min (scheduled):** probe production - `/health`, catalog ≥400, a real PoW-paid call, MCP `initialize`. Three consecutive failures → a `Heartbeat: production DOWN` issue (auto-closed on recovery).

## Observability: attribution by payment path

`/api/stats` (`toolCallsServed`) breaks served calls down by how they were paid, so a maintainer can see real external demand at a glance, not just total volume. The main rows:

- **USDC** - settled on-chain (x402, or MPP through the same settlement); the settlement receipt on the response is authoritative. Carries a per-network split and the MPP-wire subset.
- **Proof-of-work** - the PoW gate accepted a valid `X-Pow-Solution`; the operator sees how much of the free-tier traffic is real.
- **Heartbeat** - Agent402's own 15-minute production probe. Gated on a `POW_SECRET`-signed `X-Heartbeat-Token` (HMAC of the current UTC minute, ±5 min skew) so it can't be impersonated by a spoofed User-Agent. Lets the operator subtract internal noise from external demand.

There's also a **charged-but-failed** counter: any non-200 response that carried a settlement receipt is recorded - the buyer paid on-chain but the handler errored and repaid through the refund ledger.

## Production

- **Railway**, single service, Docker (Node 22 + Chromium + ffmpeg), persistent volume at `/data` (SQLite: stats, memory, PoW replay). Without the volume, counters and paid memory reset on every redeploy - so the volume is required.
- **Graceful SIGTERM**: ordinary in-flight requests complete before exit; a report composite still running is cut off and answers 503, which is never charged (settlement runs after the handler and only on a response under 400).
- Env that matters: `WALLET_ADDRESS`, `NETWORK`, `CDP_API_KEY_ID/SECRET` (facilitator), `BASE_URL`, `BRAVE_API_KEY` (search), `POW_SECRET` (durable PoW + heartbeat-token signer), `X402_INDEX_SEEDS` (extra origins for the Index, optional), `MPP_SECRET_KEY` (MPP shim), `TEMPO_API_KEY` (native Tempo), `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (card reports, monitors, credits; `STRIPE_PROFILE_ID` adds cards over MPP), `EMAIL_FROM` + `ZEPTOMAIL_TOKEN` (report and monitor emails), `FREE_MODE` (never in production). Full table on [[Self-Hosting]].
- **Recurring engine:** the monitor scheduler ticks every 10 minutes in-process (one replica holds a lock in `/data`); `MONITOR_SCHEDULER=off` disarms it.
- **Payment wires in ops terms:** x402 settles through the facilitators, MPP `evm` through the same facilitators via the shim, MPP `tempo` through Tempo's relay, MPP `stripe` and the card pages through Stripe, prepaid credits against a local balance. Card sales and subscription invoices land in the same sales ledger as on-chain settlements (rail `card` / `credits`).
