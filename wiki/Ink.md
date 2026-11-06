# Ink (USDC)

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Agent402 settles x402 payments in **USDC** on **Ink**, an OP Stack L2 with
chain id **57073**. The rail is re-proven daily by an automated on-chain
canary purchase. The live [/ink](https://agent402.tools/ink) page shows the
chain's sellers and the service's own wallet on it.

## Chain parameters

| | |
|---|---|
| Chain id | 57073 (CAIP-2 `eip155:57073`) |
| RPC | `https://rpc-gel.inkonchain.com` (also `https://rpc-qnd.inkonchain.com`) |
| Explorer | `explorer.inkonchain.com` |
| Stablecoin | USDC (native) - `0x2D270e6886d130D724215A266106e6832161EAEd`, 6 decimals |
| EIP-712 domain | name `"USDC"`, version `"2"` |
| Gas | paid in ETH by the facilitator; the buyer needs only USDC |

## Buy in USDC on Ink

**With `agent402-mcp`:** set `AGENT402_NETWORKS=eip155:57073` (plus
`AGENT_KEY` for a wallet holding USDC on chain 57073) and every MCP tool call
settles on Ink. The accept carries the asset and the EIP-712 domain, so the
signer needs no Ink-specific setup.

**With `agent402-client` or any @x402 client:**

```js
import { withNetworkPreference } from "agent402-client";
withNetworkPreference(x402client, ["eip155:57073"]);
```

Agent402's 402 lists Base first, so pinning the chain is required - an
unmodified client that takes the first accept it can pay settles on Base. The
preference throws **before** paying if the seller doesn't offer the chain.

## Sell in USDC on Ink

- **Agent402 server**: add `ink` to `PAYMENT_NETWORKS` and set
  `INK_FACILITATOR_URL` (one URL, or an ordered comma-separated list: the
  first whose `/supported` confirms `eip155:57073` at boot settles first, the
  rest are its settle fallback). Without the URL Ink is not configured and
  every other chain keeps serving. See [[Self-Hosting]].

## Find other sellers on the chain

The neutral router takes a network filter:
`GET /api/route?q=<task>&network=ink` - only sellers whose crawled 402
advertises `eip155:57073` are ranked (sellers with unknown accepts are kept;
the filter excludes sellers known *not* to settle there).

## Recognizing a settlement on-chain

An x402 settlement on Ink is a `transferWithAuthorization` (EIP-3009) on the
USDC contract, submitted by the facilitator (the buyer paid no gas), with the
decoded transfer showing buyer to seller for the quoted price.
