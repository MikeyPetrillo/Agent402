# Paying with MPP

**MPP** (Machine Payments Protocol) is the open, IETF-track HTTP payment scheme co-authored by Tempo and Stripe: the server answers `402` with `WWW-Authenticate: Payment`, the client replies with `Authorization: Payment`, and a settled response carries a signed `Payment-Receipt`. Spec and tooling: [tempoxyz/mpp](https://github.com/tempoxyz/mpp) · [mpp.dev](https://mpp.dev) · client/server library [`mppx`](https://www.npmjs.com/package/mppx).

Every paid endpoint on Agent402.Tools is **dual-stack**: the same 402 carries an x402 offer *and* an MPP challenge. Same URL, same price - the buyer's client picks the wire. MPP is one of the two wires underneath [[Agentic Finance]], agents that pay and get paid on their own; Agent402 is its applied layer.

## What settles, where

| MPP method | Asset | Where it settles | Notes |
|---|---|---|---|
| `evm` charge | USDC | Base, Celo | Same EIP-3009 on-chain settlement as x402, translated by the shim; verifiable on Basescan/Celoscan |
| `tempo` charge | USDC.e, PathUSD | Tempo (chain 4217) | Native TIP-20 settlement through Tempo's hosted MPP relay, no x402 facilitator involved. The hosted instance offers USDC.e first, then PathUSD (one challenge per currency; a stock mppx client pays the first it can, or `autoSwap` between them) |
| `stripe` charge | card (USD) | Stripe | Cards over the MPP wire via Stripe Shared Payment Tokens, offered only on routes priced $0.50 or more (the card minimum); settles a PaymentIntent after the handler, same settle-after-handler discipline. Mounted when the operator sets `STRIPE_SECRET_KEY` + `STRIPE_PROFILE_ID` |

### Signing an `evm` challenge: use the token's own EIP-712 domain

An `evm`/`charge` credential is an EIP-3009 `TransferWithAuthorization` signed under the **token's** EIP-712 domain, and that domain's `name` differs by chain: Base USDC is `"USD Coin"`, while Celo, Monad and Sei USDC each report `"USDC"`. Hardcoding one of them produces a signature no facilitator and no contract can accept on the chains that use the other, and it fails quietly, looking like a rejected payment rather than a wrong one.

There is nothing to guess: the challenge carries the verbatim x402 accepts entry it was minted from, and that entry's `extra.name` / `extra.version` are the domain to sign under, read from the token on chain.

If a credential arrives signed under a different known name, we recover the signer and recognise it before spending a facilitator round trip. The reply is a `402` with an RFC 9457 `application/problem+json` body naming both the name you signed under and the one the token uses. That response deliberately carries no `WWW-Authenticate` header, so a client whose manager prefers MPP has nothing to select and falls through to the x402 offer in the same `402`, which the same wallet can pay. The hold is short, self-clearing, and never applied to a request that presents a credential.

The [MPP marketplace](https://agent402.tools/mpp-marketplace) lists other MPP sellers we can verify live and ranks them on the **MPP leaderboard**: inbound USDC.e transfers on Tempo to the recipient each seller's live challenge names, read from the chain by us over the most recent window (transfers, distinct payers, volume; rows at or above the router's floor are marked routable). Machine-readable at [`/api/mpp-index`](https://agent402.tools/api/mpp-index) and [`/api/mpp-leaderboard`](https://agent402.tools/api/mpp-leaderboard). The [transactions page](https://agent402.tools/revenue) shows every MPP-wire settlement per rail with explorer links, led by transaction counts (adoption) with external revenue underneath.

## JavaScript (mppx)

```js
import { Mppx, tempo, evm } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_KEY);
// Offer both methods; the client picks the one the 402 advertises that it can pay.
const client = Mppx.create({ methods: [tempo.charge({ account }), evm.charge({ account })] });

const res = await client.fetch("https://agent402.tools/api/uuid");
console.log(res.status, res.headers.get("payment-receipt"));
console.log(await res.json());
```

For `evm` you need USDC on Base or Celo in the paying wallet; for `tempo` you need USDC.e (or PathUSD) on Tempo mainnet. No API key, no signup: the wallet is the account.

## MPP on the MCP connector

The hosted connector at `https://agent402.tools/mcp` speaks MPP's MCP wire too: a wallet-only tool called through `catalog.call` (or a flagship such as `web.search`) answers JSON-RPC error `-32042` (`-32043` when a presented credential was refused) with `data.challenges`, the client retries with the credential in `_meta["org.paymentauth/credential"]`, and the paid result carries `_meta["org.paymentauth/receipt"]`. mppx's `McpClient.wrap` over a stock MCP SDK client handles it. The connector replays the call as a loopback request to its own paid HTTP route, so the real gates verify and settle and the same invariants hold (`src/mcp-mpp.js`). See [[MCP Connector]].

## Verifying a settlement

- `evm`: the `Payment-Receipt` reference is the on-chain tx hash on Base or Celo.
- `tempo`: the reference is the Tempo tx hash, viewable at `https://explore.tempo.xyz/tx/<hash>`. A rejected MPP credential answers 402 with fresh challenges and an RFC 9457 `application/problem+json` body naming the reason.
- `stripe`: the receipt references the Stripe PaymentIntent.
- Aggregate, machine-readable: [`/api/revenue/mpp`](https://agent402.tools/api/revenue/mpp) (counts, per-rail hashes, no buyer data).

## Accepting MPP on your own API

If you already speak x402, MPP can be added without touching settlement: emit an additional `WWW-Authenticate: Payment` challenge derived from your existing offer, and re-encode inbound `Authorization: Payment` credentials into your existing verification path. Agent402's implementation is open source in this repository (`src/mpp-shim.js` for the evm translation, `src/mpp-tempo.js` for native Tempo). Set `MPP_SECRET_KEY` to enable the shim on your own instance, `TEMPO_API_KEY` (plus a recipient; `TEMPO_CURRENCY` picks the currencies) to offer native Tempo, and `STRIPE_SECRET_KEY` + `STRIPE_PROFILE_ID` to offer cards over MPP (`src/mpp-stripe.js`). The same three settle the `agent402-tollbooth` gate on your own site, including native Tempo with split payments since 0.9.0 (see [[Pay-per-crawl]]).

## Related

- [[Paying with x402]] - the other wire on the same 402
- [[Paying with Compute]] - the free proof-of-work tier
- [What is MPP](https://agent402.tools/what-is-mpp) - the longer explainer
