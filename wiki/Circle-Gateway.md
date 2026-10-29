# Circle Gateway (batched USDC payments)

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

The Circle Gateway batched option is a second way to pay an x402 `exact` accept
on **Arc** and **Base**: the buyer deposits USDC into Circle Gateway once, then
pays each call with a signature against that balance. No transaction goes on
chain per call; Circle Gateway verifies each payment, settles it off chain and
lands the batch on chain later. Same price, same payTo as the plain accept.

Whether it is on right now is machine-readable: `/api/pricing`
(`payment.acceptKinds`, `payment.gatewayNanopayments`), `/.well-known/x402`,
`/api/rails` (`gatewayBatched`) and `/llms.txt`. The operator side (the
`GATEWAY_NANOPAYMENTS` switch, withdrawals, status words) is on [[Self-Hosting]].

## The mechanism

1. **Deposit once.** The buyer moves USDC into Circle Gateway through Circle's
   GatewayWallet contract on the chain it will pay on. That is an ordinary
   on-chain transfer the buyer makes and pays gas for, once. `agent402-client`
   never deposits or withdraws; the deposit is the buyer's own step.
2. **Sign per call.** The 402 carries a second `exact` accept beside the plain
   one, whose `extra.name` is `GatewayWalletBatched`, with `extra.version` and
   `extra.verifyingContract`. The buyer signs the same EIP-3009
   `TransferWithAuthorization` as for the plain accept (from, to, value,
   validAfter, validBefore, nonce), but under that Gateway EIP-712 domain (the
   accept's name, version and verifyingContract, with the chain's own id)
   instead of the USDC contract's domain, for exactly the quoted amount, with
   the validity window the accept's `maxTimeoutSeconds` sets. The payment goes
   in the `PAYMENT-SIGNATURE` header as an x402 v2 payload whose `accepted` is
   that accept. EOA signatures only on this option.
3. **Settle off chain.** The server runs the call, then Circle Gateway verifies
   the signature against the deposit and locks the amount; the seller's answer
   carries a receipt naming Gateway's transfer id instead of a chain hash. A
   failed call (4xx or 5xx) is never settled.
4. **Batched on chain.** Gateway lands settled payments on chain in batches
   later; the seller withdraws its Gateway balance separately. On
   [/revenue](https://agent402.tools/revenue) these sales are counted from the
   sales ledger under their own label.

The plain accept stays first in `accepts`, so a client that ignores
`extra.name` keeps paying it and nothing changes for existing buyers.

## Paying it from agent402-client

Since 0.8.20 the buyer SDK pays the batched accept when the `gateway` option is
set. `signer` is an EIP-712 signer (a viem account: `address` and
`signTypedData`) whose address holds a USDC deposit in Circle Gateway. Off by
default.

```js
import { Agent402 } from "agent402-client";
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(process.env.AGENT_KEY); // deposited into Circle Gateway on Base or Arc
const a = new Agent402({ gateway: { signer }, maxPerCallUsd: 0.05 });
const out = await a.call("extract", { url: "https://example.com/article" });
```

- Where the 402 offers a batched accept on an EVM chain the signer may pay
  (`gateway.networks`, chain names such as `["arc"]`, narrows it; the default is
  any chain offered), the client signs it under the Gateway domain and sends it
  on the plain fetch. The spending caps (`maxPerCallUsd`, `dailyLimitUsd`,
  `maxPerHostUsd`) are checked against the accept's amount before anything is
  signed, exactly as on a plain accept.
- Where the 402 offers none (another seller, an identity-bound route, a route
  with a lasting effect), the call falls back to the payment `fetch` or the
  `creditsKey` as if the option were off; with neither, it fails with a 402
  that says the seller offers no batched accept.
- A refusal for a short Gateway balance relays the server's hint and says to
  deposit first, and the amount is released from the caps.
- A payment Gateway has not confirmed inside the server's wait is answered
  `402` with reason `settlement-pending` and `Retry-After`. The client resends
  the **same** signed header after that wait, up to three times, and is served
  once Gateway confirms it, with no second charge. Past that it throws
  `GatewayPendingError` carrying `paymentHeader`, the exact header to resend
  later; it never signs a new authorization for the same request, which could
  be a second charge. A batched payment Gateway settles and that is never
  served is recorded as owed to the paying wallet and refunded under the
  [refund policy](https://agent402.tools/terms).

`agent402-mcp` pays the plain accept.

## Signing it yourself

Two helpers are exported for a client of your own: `gatewayAcceptOf(accepts,
networks?)` picks the batched accept a buyer may pay out of a 402's `accepts`
(scheme `exact`, `extra.name` `GatewayWalletBatched`, an EVM chain, a payTo, a
verifyingContract, a version, a validity window and an amount in a known
asset), and `signGatewayPayment(accept, { signer, resource })` returns the x402
v2 payload and its base64 `PAYMENT-SIGNATURE` value.

## Where it is not offered

Identity-bound routes (memory, attest, feedback, my-usage) and routes with a
lasting effect (such as the route-execute tiers) carry the plain accept only:
a batched payment Gateway leaves pending is answered after the handler ran,
and its resend would run the effect twice.
