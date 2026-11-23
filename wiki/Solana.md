# Solana (USDC)

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Agent402 accepts x402 payments in USDC on Solana mainnet beside Base and the other chains. A buyer picks the chain it holds funds on from the same 402; see [[Paying with x402]] for the buyer side.

## Accepting Solana on your own server

| Setting | Effect |
|---|---|
| `PAYMENT_NETWORKS` | Add `solana` to the list |
| `SOLANA_WALLET_ADDRESS` | Required with `solana`: the base58 address that receives USDC. Unset, the server logs a boot warning and leaves Solana out of every 402 |
| `SOLANA_RPC_URL`, `SOLANA_RPCS` | Optional: the RPC endpoints the server reads Solana through |
| `SOLANA_FACILITATOR_URL`, `SOLANA_FACILITATOR_SHARE` | Optional: a second Solana facilitator and the share of Solana quotes that name it |

The receiving address must already hold a USDC token account, or every buyer's payment fails on-chain simulation while the 402 looks healthy. Send the address any amount of USDC on Solana once before enabling it; boot checks this and warns.

Solana addresses are base58 and case-sensitive: the server never changes their case. Identity-bound routes (memory, attest, feedback, my-usage) take an EVM `exact` payment only.

Every Solana variable is in the [configuration reference](https://github.com/MikeyPetrillo/Agent402/blob/main/docs/configuration.md). See also [[Troubleshooting]].
