# Proposal: signed paid-call receipts and machine-readable refund terms

Status: proposal, with a working implementation in this repository.

Two small documents let a buyer's agent check, before it pays and after it is
served, what a paid HTTP call settled and what happens to the money when the
call does not deliver. Both work beside the 402 flow of x402 and MPP without
changing either wire. This note states the formats as this server serves them,
so another seller can serve the same shapes and a buyer can read every seller
the same way.

## 1. The receipt

A seller that settled a paid call and answered it with a 200 attaches a
receipt it signs over the request, the answer and the settlement.

### Delivery

- A single-body answer: the response header `Agent402-Receipt`.
- A streamed answer: after the last byte, over every byte streamed, as a
  final server-sent comment line `: agent402-receipt <receipt>` on a
  `text/event-stream` answer (a comment, which event-stream parsers skip),
  and as an `Agent402-Receipt` HTTP trailer when the client sent
  `TE: trailers`.
- An error answer, a failed settlement, or a free answer carries none.

### Format

A compact JWS (RFC 7515). Protected header: `alg` `EdDSA` (Ed25519), `typ`
`agent402-receipt+jws`, `kid` naming the signing key. The payload is one JSON
object, the record:

| Field | Meaning |
|---|---|
| `v` | Record version, `1`. |
| `id` | Receipt id: derived from the rail, network, settlement and both digests when a settlement exists, so the same settled call always yields the same id. |
| `iss` | The issuing origin. |
| `iat` | When it was signed, ISO 8601. |
| `method`, `path`, `slug` | The request line and the tool it reached. |
| `requestSha256` | sha256 hex of `"<METHOD> <path>[?query]\n"` followed by the request body as JSON (`-` when there is none). |
| `responseSha256` | sha256 hex of the answer's bytes before content encoding. |
| `priceUsd` | The price charged, in dollars. |
| `rail` | `x402`, `gateway-batched`, `mpp-evm`, `mpp-tempo`, `mpp-stripe`, `credits` or `card-checkout`. |
| `network` | CAIP-2 network id, or null off chain. |
| `payer` | The payer the seller's books record (the signed payer, or the settlement's payer), or null where the rail names none. |
| `settlement` | The settlement reference: a transaction hash, a batch transfer id, a payment id or a debit id. |
| `replay` | true when the answer is a replay of an earlier settled answer. |

Every string field is capped, and the whole header stays under 2 KB.

### Keys and checking

- Public keys: `/.well-known/agent402-receipt-key.json`, a list of
  `{ kid, kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", x, status,
  validFrom, validUntil }`. A retired key stays listed so receipts it signed
  still verify.
- A buyer checks the signature against `kid`, recomputes `responseSha256`
  from the bytes it received and `requestSha256` from the request it sent,
  and looks `settlement` up on `network`.
- `POST /api/receipts/verify` performs the same check for a client without a
  JWS library.

## 2. The refund terms document

`/.well-known/agent402-refund-terms.json` states, per payment rail the seller
accepts, what happens to a payment when the call does not deliver. Each field
is computed from the code and switches that run the behavior, so the document
changes when the behavior does. Sizes of budgets, caps and balances are not
part of it.

### Top level

| Field | Meaning |
|---|---|
| `document`, `version`, `url`, `generatedAt` | Identity of the document. |
| `terms`, `termsVersion`, `governs` | The human terms this restates; those govern. |
| `freeMode` | true when the server answers without payment, so no rail is offered. |
| `rules` | The rules every rail shares (below). |
| `rails` | One row per rail (below). |
| `clauses` | The refund sentences of the terms, word for word, each with the facts it states as fields. |

### `rules`

- `x402Ordering`: `settlesOnlyBelow: 400`. On x402 the route runs first and
  only an answer below 400 is settled; any other answer cancels settlement.
- `hangupForgiveness`: `enabled`, `budgeted`, and `neverForgivenSlugs`, the
  routes whose effect outlives the answer and are therefore settled.
- `refundLedger`: which events record an amount as owed, who is repaid
  (`paying-wallet`) and on which chain (`the-chain-it-paid-on`), the chain
  families repaid on, that the payment is proven on chain before a repayment
  is sent, the families on which the repayment is itself proven, that the
  receiving address is screened before sending, and the public status word
  that reads `owed` while a debt waits.
- `credits`: debited only on a final 200, the hold released otherwise, and
  the refund-on-request route when it is offered (null when it is not).
- `cardReport`: refunded to the card automatically when generation fails.

### `rails[]`

| Field | Meaning |
|---|---|
| `id` | Rail id, for example `x402:exact:eip155:8453`, `mpp:tempo:push`, `credits`. |
| `protocol`, `network`, `offered` | What the rail is and whether it is accepted now. |
| `chargedOnErrorAnswer` | false: on this rail (x402, MPP evm, a Tempo pull, a card capture, credits) an error answer is not charged. true: the payment is taken before the route runs (a Tempo push transfer, a card checkout), so a failed call is repaid as `refundOnChargedFailure` says. null: nothing is charged on the rail. |
| `repaymentFamily` | The chain family a repayment is sent on, or null. |
| `settleAfterAnswer`, `hangupForgiveness`, `refundOnChargedFailure` | Cells `{ supported, detail, source }`: whether the rail implements the rule, one sentence on how, and the module that runs it. |

Some calls are paid before they run; a failed one can be retried free with the same payment, or is refunded.

## 3. Payer screening, stated per rail

A seller that screens payers against a sanctions list states, per rail, which
identifier it screens, in the rail's `sanctionsScreening` cell of
`/.well-known/agent402-conformance.json`: `identifier` names the address the
screen reads (the signed payer on an EVM chain, the transaction's signers on
Solana, the transfer's `from` on Stellar, the payment's sender on Algorand,
the paying wallet on Tempo), and is null on a rail that carries no payer
address (a card payment, a prepaid key). A payer that is not listed is never
refused by the screen.

## 4. Why these shapes

- Every field a buyer acts on is a field, not prose: an agent decides from
  `chargedOnErrorAnswer` and `refundOnChargedFailure.supported` without
  parsing sentences.
- Each claim names the module that implements it, so a reader of an
  open-source seller can check the claim against the code.
- The receipt is bound to both digests and the settlement, so it proves
  which bytes were delivered for which payment, and nothing more.
- Both documents are additive: a client that ignores them loses nothing.
