# Operations

Everything is automated through two GitHub Actions workflows; production is a single Railway service with a persistent volume.

## Deploy pipeline (`.github/workflows/deploy.yml`)

Jobs are selected by commit-message markers (`[test]`, `[deploy]`, `[publish]`, `[paytest]`, `[purl]`, `[marketplace]`, `[drain]`, `[probe]`) or `workflow_dispatch`:

| Job | What it proves |
|---|---|
| `test` | Boots the server in free mode and runs the full gauntlet: unit tests for memory/kit2/PDF/media/conversions, **every endpoint called with its own documented example** (~1,070 calls), live-site exercises (BBC, Wikipedia, arXiv…), the SSRF guard (metadata endpoint must be blocked), PoW gate with payments enabled, marketplace bridge auth, MCP server e2e, the remote `/mcp` connector e2e — then polls **production** post-deploy: catalog size, 402 on unpaid calls, SEO surfaces, a real PoW-settled call, and the live `/mcp` endpoint |
| `deploy` | Railway via GraphQL: find/create project + service, ensure the `/data` volume, domains, env vars, trigger the image build |
| `publish` | `agent402-mcp` to npm (gated on its own e2e), then the official MCP Registry via GitHub OIDC |
| `paytest` / `drain` | Funded-wallet end-to-end buys against production; drain empties the test burner into the revenue wallet through real paid calls |
| `purl` | Interop: Stripe's `purl` client must parse our 402 and (burner permitting) settle a real payment |
| `marketplace` | Registers/verifies the agent402.app listing end-to-end |
| `probe` | Read-only diagnostics: Railway deploy history, marketplace docs, on-chain revenue decode |

## Heartbeat (`.github/workflows/heartbeat.yml`)

- **Every 15 min:** probe production — `/health`, catalog ≥1000, a real PoW-paid call, MCP `initialize`. Three consecutive failures → a `Heartbeat: production DOWN` issue (auto-closed on recovery).
- **Every 6 h:** decode recent on-chain USDC receipts to the **real payer** (the `transferWithAuthorization` calldata, not the facilitator's tx.from). Any payer that isn't the known test burner → an **"External customer payments detected"** issue with amount, wallet, and tx link — deduped by tx hash. Your first customer is a push notification.

## Observability: 3-rail attribution

`/api/stats` and the operator dashboard (`/__operator`) break served calls into **three rails** so a maintainer can see real external demand at a glance, not just total volume:

- **USDC** — settled on-chain via x402; the X-PAYMENT-RESPONSE header presence is authoritative.
- **Proof-of-work** — the PoW gate accepted a valid `X-Pow-Solution`; the operator sees how much of the free-tier traffic is real.
- **Heartbeat** — Agent402's own 15-minute production probe. Gated on a `POW_SECRET`-signed `X-Heartbeat-Token` (HMAC of the current UTC minute, ±5 min skew) so it can't be impersonated by a spoofed User-Agent. Lets the operator subtract internal noise from external demand.

There's also a **charged-but-failed** counter: any non-200 response that left an `X-PAYMENT-RESPONSE` header is recorded — the buyer paid on-chain but the handler errored, so the operator can chase it down before they complain.

## Production

- **Railway**, single service, Docker (Node 22 + Chromium + ffmpeg), persistent volume at `/data` (SQLite: stats, memory, PoW replay). Without the volume, counters and paid memory reset on every redeploy — this was a real incident; the volume is now asserted by the deploy job.
- **Graceful SIGTERM**: in-flight (already-paid) requests drain before exit.
- Env that matters: `WALLET_ADDRESS`, `NETWORK`, `CDP_API_KEY_ID/SECRET` (facilitator), `BASE_URL`, `BRAVE_API_KEY` (search), `MARKETPLACE_TOKEN` (bridge), `POW_SECRET` (durable PoW + heartbeat-token signer), `X402_INDEX_SEEDS` (extra origins for the Index, optional), `FREE_MODE` (never in production).

## Incident playbook

1. A heartbeat issue opened? Check the linked run for which probe failed, then the `probe` job for Railway build/deploy logs.
2. Redeploy = push a `[deploy]` commit (or dispatch the workflow with mode `deploy`).
3. Catalog regressions are caught pre-deploy by the test job; production checks tolerate ~2 min of rollout race before declaring failure.
