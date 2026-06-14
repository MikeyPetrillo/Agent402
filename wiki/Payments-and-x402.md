# Payments and x402

Agent402's payments toolkit is **non-custodial**: it helps an agent move its
*own* USDC with its *own* key. Agent402 never holds, receives, signs, or sends
funds — it decodes quotes, reads public chain state, and builds the
authorization you sign. All tools are keyless (public RPC) and work across
**Base, Polygon, Arbitrum, Optimism, and Ethereum** (`network` param, default
`base`).

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

1. **`x402-quote`** — what does this endpoint cost?
2. **`ens-resolve`** — turn a `name.eth` recipient into an address (if needed).
3. **`usdc-balance` + `gas-estimate`** — can the agent afford it?
4. **`transfer-authorization`** — build the EIP-712 object; the agent signs it with its own key (e.g. viem `signTypedData`).
5. **`x402-verify`** — confirm the settlement landed.

## Why non-custodial

Custodial "pay for me" services must hold your funds — which means money
transmission, KYC/AML, and trusting a middleman. These tools never touch your
money: you keep your key, you sign, you send. That's the correct architecture
for agent payments, and the reason this surface stays clean.

## Notes

- Tools are **wallet-only** (paid per call in USDC via x402), so they are *not*
  exposed on the free hosted MCP connector — the payments surface is the paid
  HTTP / `agent402-mcp` path. See [[MCP Connector]].
- USDC addresses are the native Circle deployments per chain; EIP-712 domain is
  `USD Coin` / version `2`.
- Open source: [src/tools/x402-kit.js](https://github.com/MikeyPetrillo/Agent402/blob/main/src/tools/x402-kit.js).
