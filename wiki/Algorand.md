# Algorand (USDC)

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Agent402 accepts x402 payments in USDC on Algorand mainnet, settled through an x402 facilitator for Algorand. See [[Paying with x402]] for the buyer side.

## Accepting Algorand on your own server

| Setting | Effect |
|---|---|
| `PAYMENT_NETWORKS` | Add `algorand` to the list |
| `ALGORAND_WALLET_ADDRESS` | Required with `algorand`: the address that receives USDC. Unset, the server logs a boot warning and leaves Algorand out of every 402 |
| `ALGORAND_FACILITATOR_URL` | Optional: the facilitator that settles Algorand payments (the code names a public one by default) |
| `ALGORAND_ALGOD_URL(S)`, `ALGORAND_INDEXER_URL(S)` | Optional: the node and indexer endpoints the server reads Algorand through |

The receiving address must be opted in to USDC (Algorand's asset opt-in) before it can receive a payment.

Algorand addresses are case-sensitive: the server never changes their case. Identity-bound routes (memory, attest, feedback, my-usage) take an EVM `exact` payment only.

Every Algorand variable is in the [configuration reference](https://github.com/MikeyPetrillo/Agent402/blob/main/docs/configuration.md). See also [[Troubleshooting]].
