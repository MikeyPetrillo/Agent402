# agent402-facilitator

Open-source, self-hostable x402 facilitator for Stellar. Verify and settle
`exact`-scheme USDC payments on Soroban yourself, with correct on-chain
settlement confirmation. No third-party facilitator, no signup.

This wires the official [`@x402/core`](https://www.npmjs.com/package/@x402/core)
orchestration to the official
[`@x402/stellar`](https://www.npmjs.com/package/@x402/stellar) facilitator
scheme, which already implements Soroban simulation/auth-entry validation and
on-chain settlement confirmation internally — this package is glue, not a
payment protocol reimplementation.

**Network: testnet by default, mainnet as an explicit opt-in**
(`FACILITATOR_NETWORK=pubnet`, see below) — never the reverse. This is what
[agent402.tools](https://agent402.tools) itself runs in production for its
Stellar rail as of 2026-08-13.

## Why

Third-party Stellar facilitators can report a settlement failure moments
before the transfer actually confirms on-chain — Stellar closes ledgers
about every 5 seconds, and a facilitator's own timeout can fire just before
that close. That's a buyer charged and told they weren't. Running your own
facilitator means you control that reliability directly.

## Install

```bash
cd facilitator
npm install
```

## Run

```bash
FACILITATOR_STELLAR_SECRET=S... npm start
```

- `FACILITATOR_STELLAR_SECRET` — required. The facilitator's own Stellar
  secret seed (starts with `S`). This account pays transaction fees for
  every settlement. For testnet, generate a fresh keypair and fund it for
  free via [Friendbot](https://friendbot.stellar.org/?addr=YOUR_PUBLIC_KEY).
  **For mainnet this must be a REAL, FUNDED secret — never generate or fund
  one casually, and never commit it.**
- `FACILITATOR_NETWORK` — optional, default unset (testnet). Set to exactly
  `pubnet` to opt into mainnet — any other value, including a typo, stays on
  testnet by design (fail closed to the safe value).
- `FACILITATOR_MAINNET_RPC_URL` — required when `FACILITATOR_NETWORK=pubnet`.
  `@x402/stellar` ships a working default RPC for testnet but none for
  mainnet; the server fails loudly at startup rather than failing
  confusingly on the first request.
- `PORT` — optional, defaults to `4021`.
- `FACILITATOR_AUTH_TOKEN` — optional. When set, `/verify`, `/settle`, and
  `/supported` all require `Authorization: Bearer <token>`. When unset, those
  three endpoints are open (permissive default for local/dev use — a clear
  warning is logged at startup so this is never silently invisible).
- `FACILITATOR_ALLOWED_PAYTO` — optional, comma-separated Stellar addresses.
  When set, `/verify` and `/settle` reject any payment whose `payTo` isn't on
  the list, before doing any simulation work. When unset, any `payTo` is
  accepted (same startup-warning treatment as auth) — worth knowing an open
  facilitator can otherwise be used by anyone as a free Stellar gas sponsor.
- `FACILITATOR_LOW_BALANCE_XLM` — optional, default `5`. Threshold for the
  `low` flag on `GET /health`.
- `FACILITATOR_SETTLE_TIMEOUT_MS` / `FACILITATOR_VERIFY_TIMEOUT_MS` /
  `FACILITATOR_HEALTH_TIMEOUT_MS` — optional, default `60000` / `30000` /
  `10000`. Bounds how long a single `/settle`, `/verify`, or `/health` call
  waits on the underlying Stellar RPC before failing fast with a
  self-explaining reason (`settle_timed_out` / `verify_timed_out`) instead of
  hanging indefinitely — added after a real production incident where a
  `/settle` call hung for 300s with nothing bounding it at all. Raising
  `FACILITATOR_SETTLE_TIMEOUT_MS` also means raising
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (or your platform's equivalent) to
  match, so a redeploy's grace period still comfortably exceeds it.
- `FACILITATOR_RPC_FALLBACK_URLS` — optional CSV of Soroban RPC URLs tried, in
  order, when the primary fails at the TRANSPORT level (timeout, connection
  error, HTTP 5xx/429). Default on pubnet: `https://mainnet.sorobanrpc.com,
  https://rpc.ankr.com/stellar_soroban` (public, keyless; probed 2026-08-26);
  on testnet `https://soroban-testnet.stellar.org`. `off` disables. A JSON-RPC
  error (failed simulation, rejected transaction) is an answer and is never
  retried elsewhere. Each hop inherits the per-request timeout, so the worst
  case is (1 + fallbacks) x `FACILITATOR_RPC_TIMEOUT_MS`.
- `FACILITATOR_RPC_TIMEOUT_MS` — optional, default `10000`. Per-request
  timeout on every Soroban RPC round-trip the Stellar SDK makes (simulate,
  send, poll). The endpoint bounds above are the last line; this one makes a
  stalled RPC provider surface within seconds with a real error body (incl.
  the best-effort `payer`), inside the typical caller's own 30s settle budget,
  rather than the caller giving up blind. `0` disables.

The server exposes the three standard x402 facilitator endpoints —
`GET /supported`, `POST /verify`, `POST /settle` — plus an always-open,
unauthenticated `GET /health` (`{ signerAddress, xlmBalance, low }`) for
external monitoring. `/settle` calls are serialized internally: the
facilitator's single signer account has one Stellar sequence number, and
concurrent settlements racing on it is a real failure mode (proven live —
see `test.js` step 10), not a theoretical one. A `/settle` call that times
out or otherwise never gets a result from the underlying SDK still returns a
best-effort `payer` field on its failure response — callers running their
own "ask the chain before believing a failure" check (this facilitator's own
motivating use case) need it, since the underlying settlement may have
already been submitted, or may yet be, in the background.

## Running the tests

```bash
npm test
```

The facilitator's own signer is generated fresh and funded automatically
every run (XLM only, free via Friendbot — no manual step). The **payer**
account is different: it needs to actually hold testnet USDC, and Circle's
testnet faucet is CAPTCHA-gated in the browser, so it can't be scripted.
Set up a persistent payer account once:

1. [Stellar Laboratory](https://lab.stellar.org/account/create) → generate a
   keypair → fund it with Friendbot. Copy the `Secret` key.
2. [Fund Account](https://lab.stellar.org/account/fund) → paste your public
   key → Add USDC Trustline → sign with your secret key.
3. [Circle Faucet](https://faucet.circle.com/) → select Stellar (testnet) →
   request USDC to that public key.

Then run the tests with:

```bash
TEST_PAYER_STELLAR_SECRET=S... npm test
```

The test spawns the real server, builds and signs a real testnet payment,
drives it through `/verify` and `/settle`, and independently confirms via
Horizon that the transaction actually landed — the step that proves the
whole point of this package.

## License

MIT


## Reliability bounds (what keeps a slow node from costing a settlement)

- **Per-request RPC timeout** (`FACILITATOR_RPC_TIMEOUT_MS`, 10 s): a stalled node rejects instead of hanging.
- **Failover** (`FACILITATOR_RPC_FALLBACK_URLS`, defaults to two public Soroban RPCs): a transport failure is retried once on each fallback; a JSON-RPC error is an answer and is never retried.
- **Hedged reads** (`FACILITATOR_RPC_HEDGE_MS`, 3 s; `0` disables): a read still silent after the delay is also sent to the first fallback and the first answer wins. A node that answers slowly never trips the timeout, and a settlement is a chain of six to ten reads before submission, so without this a slow node burned the whole settle budget with no error anywhere (2026-08-28). `sendTransaction` is never hedged.
- **Confirmation poll cap** (`FACILITATOR_MAX_POLL_ATTEMPTS`, 8): the vendor polls `getTransaction` once per `maxTimeoutSeconds` (the x402 server advertises 300); Stellar closes a ledger every ~5 s, so a submitted transaction is in the next two ledgers or it is not coming. Each poll is logged with the hash and elapsed time.
- **Settle bound** (`FACILITATOR_SETTLE_TIMEOUT_MS`, 25 s): under the caller's 30 s, so a slow settlement reaches the caller as a real body carrying `payer` and, when something was submitted, `transaction`, which the caller's on-chain confirmation then checks.
