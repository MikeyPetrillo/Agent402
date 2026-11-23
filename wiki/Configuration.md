# Configuration

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Agent402 reads every setting from environment variables set on the host; nothing is committed to the repository.

- **[Configuration reference](https://github.com/MikeyPetrillo/Agent402/blob/main/docs/configuration.md)**: every variable the server's code reads, grouped by prefix, with its purpose, its default and the files that read it. It is generated from the source by `node scripts/gen-config-reference.js --write`, and CI fails when it is stale or when the code reads a variable it does not list.
- **[`.env.example`](https://github.com/MikeyPetrillo/Agent402/blob/main/.env.example)**: a commented starting file for a paid instance (payout wallet, network, facilitator, proof-of-work secret).
- **[[Self-Hosting]]**: the settings most deployments set, in one table, with what each one turns on.

## The settings that decide what runs

| Setting | Effect |
|---|---|
| `FREE_MODE=true` | Every tool answers without payment; no paywall and no proof-of-work gate. Without it, the paid-mode settings below are required or the server exits at boot |
| `WALLET_ADDRESS`, `NETWORK` | Paid mode: where payments land and the primary chain |
| `PAYMENT_NETWORKS` | Extra chains to accept; each non-EVM chain needs its own payTo ([[Solana]], [[Stellar]], [[Algorand]]) |
| `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET`, or `FACILITATOR_URL` | The facilitator that verifies and settles x402 payments |
| `POW_SECRET` | Keeps proof-of-work challenges valid across restarts |
| `MPP_SECRET_KEY`, `TEMPO_API_KEY` | The MPP wire, and native settlement on Tempo ([[Tempo]]) |
| `STRIPE_SECRET_KEY` | Card checkout, monitors and the credits gate ([[Card Payments|Card-Payments]], [[Credits]]) |
| `STATE_DATABASE_URL`, `REDIS_URL` | Shared state in Postgres, and the response cache |

Most features follow one rule: the key present turns the feature on, and an unset key leaves it off with the rest of the server unchanged. A switch named `..._TOOLS` or `..._SALES` lists or sells a feature only while it is on.

See also [[Troubleshooting]] and [[Upgrading]].
