# Robinhood Chain (USDG)

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Agent402 settles x402 payments in **USDG (Global Dollar)** on **Robinhood
Chain** - an Arbitrum Orbit L2, chain id **4663**. The rail is re-proven
daily by an automated on-chain canary purchase. Everything below is also on the live
[/robinhood](https://agent402.tools/robinhood) page and in the
[full guide](https://agent402.tools/guides/usdg-payments-robinhood-chain).

## Chain parameters

| | |
|---|---|
| Chain id | 4663 (CAIP-2 `eip155:4663`) |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `robinhoodchain.blockscout.com` |
| Stablecoin | USDG (Global Dollar) - `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals |
| EIP-712 domain | name `"Global Dollar"`, version `"1"` |

## Buy in USDG

**With `agent402-mcp` (≥ 0.11.0):** set `AGENT402_NETWORKS=robinhood` (plus
`AGENT_KEY` for a wallet holding USDG on chain 4663) and every MCP tool call
settles in USDG.

**With `agent402-client` (≥ 0.4.0) or any @x402 client:**

```js
import { withNetworkPreference } from "agent402-client";
withNetworkPreference(x402client, ["robinhood"]); // or ["eip155:4663"]
```

Agent402's 402 lists Base first, so pinning the chain is required - an
unmodified client that takes the first accept it can pay settles on Base. The preference throws
**before** paying if the seller doesn't offer the chain.

## Sell in USDG

- **Agent402 server**: `PAYMENT_NETWORKS=…,robinhood` +
  `ROBINHOOD_FACILITATOR_URL=<an x402 facilitator that settles eip155:4663>`.
  If the facilitator URL is unset the rail is omitted gracefully - every other
  chain keeps serving. See [[Self-Hosting]].
- **Tollbooth (≥ 0.4.0)**: `TOLLBOOTH_NETWORK=eip155:4663 TOLLBOOTH_ASSET=USDG`
  quotes crawlers in USDG. To settle it, use the library API -
  `createTollbooth({ x402: paymentMiddleware(...) })` with a scheme your
  facilitator settles on chain 4663; the CLI's built-in settlement covers
  USDC only and refuses to start with a facilitator URL and a non-USDC asset.
  See [[Pay-per-crawl]].

## Find other sellers on the chain

The neutral router takes a network filter:
`GET /api/route?q=<task>&network=robinhood` - only sellers whose crawled 402
advertises `eip155:4663` are ranked (sellers with unknown accepts are kept;
the filter excludes sellers known *not* to settle there).

## Recognizing a settlement on-chain

There is no "402" label on-chain. An x402 settlement is a
`transferWithAuthorization` (EIP-3009, selector `0xe3ee160e`) on the USDG
contract, submitted by the facilitator's relayer (the buyer paid no gas), with
the decoded transfer showing buyer → seller for the quoted price. A real
example: [`0xae8e3e40…f826`](https://robinhoodchain.blockscout.com/tx/0xae8e3e4048a28a1db30ad17ac83d998885623c764d0e3d27abf8e817f578f826).

## Ops notes

- The **paid canary** makes one real $0.001 USDG settlement daily (pinned to
  the chain via accepts filtering - no silent Base fallback).
- The **heartbeat** decodes the live 402 on every run and opens an issue
  if the rail drops out of the offer while the `ROBINHOOD_FACILITATOR_URL`
  secret says it should be there.
- `SCAN_NETWORK=robinhood node scripts/revenue-scan.js` reports USDG received
  by the revenue wallet.
