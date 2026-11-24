# Tempo (operator setup)

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Tempo payments arrive over the MPP wire: a `tempo/charge` challenge on the same 402 as the x402 offer, paid in a TIP-20 stablecoin and settled natively on Tempo. The buyer side is in [[Paying with MPP]]; this page is for running it on your own server.

## Turning it on

| Setting | Effect |
|---|---|
| `MPP_SECRET_KEY` | Mounts the MPP wire: every paid 402 also carries `WWW-Authenticate: Payment`, and the `evm` method settles through your existing x402 facilitator |
| `TEMPO_API_KEY` | Adds `tempo/charge` challenges settled through Tempo's hosted relay (the key needs the `mpp:write` scope) |
| `TEMPO_RELAY=off` | Settles Tempo payments in the server itself instead (verify, simulate, broadcast over `TEMPO_RPC_URL`); no relay key is needed, and every party to a per-call payment is screened against the sanctions list first |
| `TEMPO_RECIPIENT_ADDRESS` | Where Tempo payments land (defaults to `WALLET_ADDRESS`) |
| `TEMPO_CURRENCY` | The tokens offered, one challenge each in order (first = preferred): `usdc` (USDC.e), `pathusd` (PathUSD), `ousd` (OUSD), or token addresses |

## What differs from x402

- A Tempo transfer the buyer pushes before the call is final when sent: a call that then fails is recorded as a refund owed.
- Tempo is never settled first and never takes the x402-only paths: the identity-bound routes (memory, attest, feedback, my-usage) refuse it.
- MPP subscriptions on Tempo (`TEMPO_SUBSCRIPTION_*`) use a fee payer key of their own.

Every Tempo and MPP variable is in the [configuration reference](https://github.com/MikeyPetrillo/Agent402/blob/main/docs/configuration.md). See also [[Sessions and Channels|Sessions-and-Channels]] and [[Troubleshooting]].
