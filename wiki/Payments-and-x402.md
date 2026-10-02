# Payments and x402

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Agent402's payments toolkit is **non-custodial**: it helps an agent move its
*own* USDC with its *own* key. These tools never hold, receive, sign, or send
funds - they decode quotes, read public chain state, and build the
authorization you sign. (Two paths elsewhere on the service are not
non-custodial and are named as such: a prepaid credits balance is money held
until it is spent, and a card report purchase is held by the payment processor
until the report is delivered. See [Security](https://agent402.tools/security).) The caller needs no API key: the
tools read public chain state through the server's own RPC providers. The chain
tools take a `network` param (default `base`): **Base, Polygon, Arbitrum,
Optimism, Ethereum, Monad, Celo, Avalanche and Sei**, plus Robinhood Chain for
the chain-read tools (`tx-status`, `gas-estimate`).

Walkthrough with runnable examples: [the x402 payments guide](https://agent402.tools/guides/x402-payments-toolkit).

## The tools

| Tool | What it does |
|---|---|
| `x402-quote` | Probe any URL, decode its HTTP 402 payment terms (price, asset, network, pay-to) |
| `ens-resolve` | Resolve `name.eth` → Ethereum address (so a named recipient becomes payable) |
| `usdc-balance` | USDC balance of an address on any supported chain |
| `gas-estimate` | Current gas price (gwei + wei) for budgeting a transaction |
| `transfer-authorization` | Build the EIP-3009 `transferWithAuthorization` typed data to sign (gasless USDC) |
| `tx-status` | Confirmation status of a transaction (success / failed / pending / not found) |
| `x402-verify` | Confirm a USDC payment settled on-chain; optionally check recipient + min amount |

## The payment flow

1. **`x402-quote`** - what does this endpoint cost?
2. **`ens-resolve`** - turn a `name.eth` recipient into an address (if needed).
3. **`usdc-balance` + `gas-estimate`** - can the agent afford it?
4. **`transfer-authorization`** - build the EIP-712 object; the agent signs it with its own key (e.g. viem `signTypedData`).
5. **`x402-verify`** - confirm the settlement landed.

## Why non-custodial

These tools never touch your money: you keep your key, you sign, you send.
Nothing here holds a balance on your behalf.

## Notes

- Tools are **wallet-only** (paid per call in USDC via x402), so they are *not*
  exposed on the free hosted MCP connector - the payments surface is the paid
  HTTP / `agent402-mcp` path. See [[MCP Connector]].
- USDC addresses are the native deployments per chain. The EIP-712 domain is
  the token's own: name `USD Coin` on most chains and `USDC` on Celo, Monad and
  Sei, version `2`; `transfer-authorization` fills it in for the chosen network.
- Open source: [src/tools/x402-kit.js](https://github.com/MikeyPetrillo/Agent402/blob/main/src/tools/x402-kit.js).
