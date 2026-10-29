# Arc (USDC)

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Agent402 settles x402 payments in **USDC** on **Arc**, an EVM chain with chain
id **5042** whose gas is paid in USDC. The rail is re-proven daily by an
automated on-chain canary purchase. The live
[/arc](https://agent402.tools/arc) page shows the chain's sellers and the
service's own wallet on it.

## Chain parameters

| | |
|---|---|
| Chain id | 5042 (CAIP-2 `eip155:5042`) |
| RPC | `https://rpc.mainnet.arc.io` |
| Explorer | `explorer.arc.io` |
| Stablecoin | USDC - `0x3600000000000000000000000000000000000000` (the ERC-20 interface), 6 decimals |
| EIP-712 domain | name `"USDC"`, version `"2"` |
| Gas | paid in USDC by the facilitator; the buyer needs only USDC |

## Buy in USDC on Arc

**With `agent402-mcp`:** set `AGENT402_NETWORKS=eip155:5042` (plus `AGENT_KEY`
for a wallet holding USDC on chain 5042) and every MCP tool call settles on
Arc. The accept carries the asset and the EIP-712 domain, so the signer needs
no Arc-specific setup.

**With `agent402-client` or any @x402 client:**

```js
import { withNetworkPreference } from "agent402-client";
withNetworkPreference(x402client, ["eip155:5042"]);
```

Agent402's 402 lists Base first, so pinning the chain is required - an
unmodified client that takes the first accept it can pay settles on Base. The
preference throws **before** paying if the seller doesn't offer the chain.
Sign with an ordinary EOA key.

## Sell in USDC on Arc

- **Agent402 server**: set `CIRCLE_FACILITATOR_API_KEY`. Its presence is the
  switch: Arc joins a multi-chain `PAYMENT_NETWORKS` list on its own, settles
  through Circle's facilitator only, and is offered only while that
  facilitator's `/supported` lists it. Without the key Arc is not configured
  and every other chain keeps serving. See [[Self-Hosting]].
- **Batched option (optional)**: with `GATEWAY_NANOPAYMENTS=on`, the Arc and
  Base 402s also carry a Circle Gateway batched accept (`extra.name`
  `GatewayWalletBatched`) beside the plain one: buyers who deposited USDC into
  Gateway sign per call with no gas, and Gateway settles off chain in batches
  into the seller's Gateway balance, withdrawn on chain separately. Off by
  default. Buyer side: [[Circle Gateway (batched USDC)|Circle-Gateway]]
  (`agent402-client` pays it with the `gateway` option); operator side:
  [[Self-Hosting]].

## Find other sellers on the chain

The neutral router takes a network filter:
`GET /api/route?q=<task>&network=arc` - only sellers whose crawled 402
advertises `eip155:5042` are ranked (sellers with unknown accepts are kept;
the filter excludes sellers known *not* to settle there).

## Recognizing a settlement on-chain

An x402 settlement on Arc is a `transferWithAuthorization` (EIP-3009) on the
USDC contract, submitted by the facilitator (the buyer paid no gas), with the
decoded transfer showing buyer to seller for the quoted price. The
`x402-verify` and `tx-status` tools take `network=arc`.

## Ops notes

- The **paid canary** makes one real $0.001 USDC settlement on Arc daily
  (pinned to the chain via accepts filtering - no silent Base fallback), and
  its result is the Arc row on [/status](https://agent402.tools/status).
- The **heartbeat** decodes the live 402 on every run and opens an issue if
  Arc drops out of the offer while the Circle key secret says it should be
  there; `/api/rails` reports the rail like every other.
- The revenue ledger reads the service wallet's USDC on Arc into
  [/revenue](https://agent402.tools/revenue). Circle Gateway batched sales
  settle off chain, so /revenue counts them from the sales ledger under their
  own label; a withdrawal's mint to the wallet is not counted again.
