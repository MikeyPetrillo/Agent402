# Paying with x402 (USDC)

[x402](https://x402.org) is an open HTTP payment standard (the `402 Payment Required` status, finally used). Settlement runs through x402 facilitators that verify and settle each payment on its chain, and stock client tooling pays it (`purl`, below, is one). x402 is one of the two wires underneath [[Agentic Finance]] - the other is [[MPP|Paying-with-MPP]], answered on the same 402.

## The flow

1. Client calls a paid endpoint.
2. Server replies `402` with a machine-readable quote: price, asset (USDC), network (`eip155:8453` = Base mainnet), and the pay-to address.
3. Client signs a USDC `transferWithAuthorization` from its own wallet (no gas needed - the facilitator sponsors it) and retries with the payment header.
4. Facilitator verifies + settles on-chain; the server serves the result. End-to-end this is seconds.

The payer needs **only USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Arc, Stellar, or Algorand** - no ETH, no account, no API key. Agent402 also accepts **USDG on Robinhood Chain** (see [[Robinhood Chain (USDG)|Robinhood-Chain]]).

## What the 402 carries

The payment requirements ride in the `PAYMENT-REQUIRED` response header (base64 JSON),
which is where the x402 v2 spec puts them and where clients should keep reading them: the
header is authoritative. The JSON body carries the same PaymentRequired object (`x402Version`,
`error`, `resource`, `accepts`, `extensions`) beside our own fields (`altPayment` on tools that
take proof-of-work, and `reason`, `hint` and `retry` when a payment was refused), so a reader of
either finds the offer and the two never disagree. A refused payment's body leaves out the
header's one-line `error`: its `hint` (or, for an MPP credential, the problem's `detail`) says
what went wrong, and a client that reads `error` first reads that instead. Every route's challenge is
valid under `@x402/core`'s own schemas (CI runs all 500+ routes through the official parser),
and it carries a typed output schema twice: inside the `bazaar` discovery extension (with the
input schema and an example) and as `accepts[0].outputSchema` on the first accept, so a client
that reads the spec's field knows the response shape before it pays. The schema sits on the
first accept only: a buyer echoes its chosen accept back in the payment, so one copy is what
keeps the challenge under the header ceiling.

## JavaScript (x402 v2 SDKs)

```js
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch("https://agent402.tools/api/extract", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://agent402.tools/guides/x402-in-5-minutes" }),
});
console.log(await res.json());
```

## Batched option on Arc and Base (Circle Gateway)

Where an instance turns it on (`GATEWAY_NANOPAYMENTS`, see [[Self-Hosting]]), the
402 on Arc and Base carries a second `exact` accept beside the plain one, at the
same price and to the same payTo, whose `extra.name` is `GatewayWalletBatched`
(with `extra.version` and `extra.verifyingContract`). The plain accept stays
first, so a client that ignores `extra.name` keeps paying it. Whether it is on
right now is machine-readable: `/api/pricing` (`payment.acceptKinds`,
`payment.gatewayNanopayments`), `/.well-known/x402`, `/api/rails`
(`gatewayBatched`) and `/llms.txt`.

- **Before the first call:** deposit USDC into Circle Gateway (an on-chain
  transfer the buyer makes and pays gas for).
- **Each call:** sign the same EIP-3009 `TransferWithAuthorization` under the
  accept's Gateway domain (its name, version and verifyingContract, with the
  network's own chainId), for exactly the quoted amount, with the validity
  window the accept's `maxTimeoutSeconds` sets. No gas per call: Circle Gateway verifies the
  signature against the deposit and settles it off chain in batches. EOA
  signatures only on this option.
- **If Gateway has not confirmed it yet:** the answer is a `402` with
  `Retry-After` and reason `settlement_pending`. Resend the same request with
  the same payment header (never a new signature) and it is served once Gateway
  confirms it, with no second charge. A batched payment Gateway settles and that
  is never served is recorded as owed to the paying wallet and refunded under
  the [refund policy](https://agent402.tools/terms).
- **Where it is not offered:** identity-bound routes (memory, attest, feedback,
  my-usage) and routes with a lasting effect (such as the route-execute tiers)
  carry the plain accept only.

`agent402-client` 0.8.20 and later pays the batched accept when constructed
with `{ gateway: { signer } }` (an EIP-712 signer whose address holds a Gateway
deposit; off by default, and a 402 with no batched accept falls back to the
payment `fetch`); `agent402-mcp` and a stock x402 client pay the plain accept,
the first one they can pay. The mechanism, the SDK option and the signing
helpers are on [[Circle Gateway (batched USDC)|Circle-Gateway]].

## Paying over MPP instead (dual-stack)

Every paid endpoint also speaks **MPP** (Machine Payments Protocol - the
IETF-track `Payment` HTTP auth scheme from [tempoxyz/mpp](https://github.com/tempoxyz/mpp)),
and now offers TWO MPP methods: `evm` (below, same URL, same price, same
on-chain USDC settlement as x402, just a different HTTP dialect) and `tempo`
(native settlement via [Tempo](https://tempo.xyz)'s own relay, TIP-1034/
TIP-20, no x402 facilitator, a genuinely different mechanism; use
`tempo.charge` from `mppx/client` the same way `evm.charge` is used below).
MPP responses add a signed `Payment-Receipt` header either way. With the
reference [`mppx`](https://www.npmjs.com/package/mppx) client:

```js
import { Fetch, evm } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const payFetch = Fetch.from({
  methods: [evm.charge({
    account: privateKeyToAccount(KEY),
    currencies: [evm.assets.base.USDC],
    maxAmount: "1.00",
  })],
});
const res = await payFetch("https://agent402.tools/api/uuid"); // 402 -> sign -> paid retry -> 200
console.log(res.headers.get("payment-receipt"));               // signed MPP receipt
```

The buyer's client picks the dialect: mppx prefers the native MPP challenge and
pays via `Authorization: Payment`; x402 clients keep using `PAYMENT-SIGNATURE`.
An MPP `evm`-method buyer and an x402 buyer settle the identical EIP-3009
authorization; an MPP `tempo`-method buyer settles via Tempo's own relay
instead - different mechanism, same price.

## The same 402 sells report products

The outcome-priced report routes (`POST /v1/research`, `/v1/dossier`, `/v1/ticker-pack`, `/v1/fund`, `/v1/filing-report`, `/v1/domain-audit`, `/v1/recall-report`, `/v1/insider-report`, `/v1/token-brief`, `/v1/token-risk`, `/v1/linkedin-article`; $0.60 to $2.00, and $0.05 for the `/v1/ipo-report` digest) answer the same 402, so a client that pays a $0.001 tool pays a $0.85 dossier the same way. Every report route above except the `/v1/ipo-report` digest runs for minutes and settles after the report is written, so those routes offer only the EVM exact accepts. People without a wallet buy the same reports by card at [`/reports`](https://agent402.tools/reports) for $2 to $5, where the price includes payment processing. A prepaid credits key pays Agent402's own routes by sending `Authorization: Bearer a402_…` instead of a payment header; the credits gate holds the list price and debits only on a final `200`. Details on [[Reports and Monitors|Reports-and-Monitors]].

## Command line: Stripe's `purl`

Stripe's open-source [purl](https://github.com/stripe/purl) ("curl for paid endpoints") works against Agent402 out of the box - a dispatchable CI job checks that it parses our 402 and, when its test wallet holds funds, pays one:

```bash
purl wallet add --name me --type evm -k 0xYOUR_KEY -p yourpass --set-active=true
purl --dry-run "https://agent402.tools/api/dns?name=example.com&type=A"  # see the quote
purl "https://agent402.tools/api/dns?name=example.com&type=A"            # pay + get result
```

## Spend controls

Client-side caps belong on the buyer:

- **purl:** `PURL_MAX_AMOUNT` (atomic units; 1000 = $0.001 USDC).
- **agent402-mcp:** `AGENT402_MAX_PER_CALL` (refuse any single call above this USD price; on by default at 4, `off` disables it) and `AGENT402_BUDGET` (opt-in hard session cap; unset means none). Both are enforced on the payment that is signed, priced from the known decimals of its asset, so a confused model cannot drain the wallet.

## Verifying you weren't cheated

Every settled Base call on the plain accept is an on-chain USDC transfer to **`agent402.base.eth`** (a Base name resolving to the public revenue wallet, which also receives on the other EVM chains) - auditable by anyone at [Basescan](https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns). The receiving address for every other rail (Solana, Stellar, Algorand, Tempo) is in [`/.well-known/x402`](https://agent402.tools/.well-known/x402), and settled transactions by rail are on [`/revenue`](https://agent402.tools/revenue). A Circle Gateway batched payment settles off chain at Gateway, not as a transfer to that wallet: its receipt names Gateway's transfer id, and `/revenue` counts those sales from the sales ledger with that label. The service also publishes served-call counters at [`/api/stats`](https://agent402.tools/api/stats); the chain, not the counter, is the source of truth.
