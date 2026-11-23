# Stellar (USDC)

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Agent402 accepts x402 payments in USDC on Stellar mainnet (pubnet), settled through an x402 facilitator for Stellar. See [[Paying with x402]] for the buyer side.

## Accepting Stellar on your own server

| Setting | Effect |
|---|---|
| `PAYMENT_NETWORKS` | Add `stellar` to the list |
| `STELLAR_WALLET_ADDRESS` | Required with `stellar`: the public key (`G...`) that receives USDC. Unset, the server logs a boot warning and leaves Stellar out of every 402 |
| `STELLAR_FACILITATOR_URL`, `STELLAR_FACILITATOR_KEY` | The facilitator that verifies and settles Stellar payments, and its key. The default facilitator requires a key: without one, Stellar is left out with a boot warning |
| `STELLAR_FALLBACK_FACILITATOR_URL`, `STELLAR_FALLBACK_FACILITATOR_KEY` | Optional: a second facilitator tried when the first cannot settle |
| `STELLAR_HORIZON_URL`, `STELLAR_HORIZON_URLS` | Optional: the Horizon endpoints the server reads Stellar through |

## Run your own Stellar facilitator

[`facilitator/`](https://github.com/MikeyPetrillo/Agent402/tree/main/facilitator) is an open-source, self-hostable x402 facilitator for Stellar: it verifies and settles `exact` USDC payments on Soroban and confirms each settlement on chain. It runs on testnet by default; mainnet is an explicit opt-in (`FACILITATOR_NETWORK=pubnet`). Point `STELLAR_FACILITATOR_URL` at it. Its README covers install, keys and the signer's XLM balance.

Every Stellar variable is in the [configuration reference](https://github.com/MikeyPetrillo/Agent402/blob/main/docs/configuration.md). See also [[Troubleshooting]].
