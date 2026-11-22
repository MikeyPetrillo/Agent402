# Sessions and Channels (one payment, many calls)

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]].

This page maps every way one payment can cover many calls, and every way a
call can be charged up to a ceiling and settle what it used. Each option names
the protocol mechanism it rides on. Options marked **off by default** are
offered only when the operator turns them on; whether one is on right now is
machine-readable on `/api/rails` and in each 402's `accepts`.

The rule every x402 option on this page keeps (exact, upto, Gateway batched
and batch-settlement), and credits too: an x402 call is charged only on its
final 200. A 4xx or 5xx is never settled, an x402 buyer who hangs up before the
answer is not charged on x402 while the run holds a hang-up forgiveness ticket,
and nothing is debited before the handler has answered. (A Tempo push transfer
is the one exception: it is on chain before the call runs, so a failed call on
it is recorded as owed and repaid.) Some calls are paid before they run; a failed one can be retried free with the same payment, or is refunded.

## What is offered

| Need | Mechanism | Status |
|---|---|---|
| Pay per call, fixed price | x402 `exact` (EIP-3009, every rail) | on |
| Charge up to a ceiling, settle actual use (`/v1` chat, Messages, Responses) | x402 `upto` (Permit2) | off by default (`X402_UPTO_NETWORKS`, `GATEWAY_METERED_BILLING`) |
| Deposit once, sign each call, settled in batches | x402 `exact` under the Circle Gateway batched domain | off by default (`GATEWAY_NANOPAYMENTS`); see [[Circle Gateway (batched USDC)\|Circle-Gateway]] |
| Deposit once into a channel, a cumulative voucher per call, claimed in batches, unused deposit refunded | x402 `batch-settlement` | off by default (`X402_BATCH_SETTLEMENT_NETWORKS`) |
| Charge up to a ceiling on speech, transcription and embeddings | x402 `upto` (and `batch-settlement`) with the work meter | off by default (`METERED_MEDIA`), below |
| Pay per call over MPP | MPP `charge` intent (evm, Tempo, card) | on where configured |
| Recurring monitors over MPP | MPP Tempo `subscription` intent | on where configured |
| Prepaid balance by card | credits (hold at authorize, debit on a final 200) | sales off |

## Channels: x402 `batch-settlement`

The x402 `batch-settlement` scheme (`@x402/evm/batch-settlement`) is a payment
channel. The protocol defines four payload types, and the server uses them as
the protocol defines them:

1. **Deposit** (`type: "deposit"`). The buyer's first call carries a deposit
   authorization (EIP-3009 `receiveWithAuthorization`, or Permit2) into the
   channel escrow contract, plus the first voucher. The facilitator puts the
   deposit on chain; the funds stay the buyer's in escrow until claimed.
2. **Voucher** (`type: "voucher"`). Every later call carries one signed
   voucher whose `maxClaimableAmount` is the running total: what the channel
   has been charged so far plus this call's price. No transaction per call.
   The server checks the voucher against its channel record and the channel
   balance before the handler runs.
3. **Claim and settle.** The server's channel manager claims the charged
   vouchers in batches through the facilitator and then settles the claimed
   funds to the payTo, on a timer.
4. **Refund** (`type: "refund"`). The unused remainder of the deposit goes
   back to the buyer: on the buyer's request (a refund payload), or for a
   channel idle past the operator's window (a cooperative refund the manager
   starts). A buyer can also withdraw on its own after the channel's
   `withdrawDelay`.

**Per-call accounting.** A voucher is committed as charged only after the
handler answered below 400 and every settlement guard passed (hang-up,
blocklist, settle-sent mark). A call that fails, or whose buyer left while it
holds a forgiveness ticket, leaves the channel's charged total where it was,
so the next voucher is signed against the same base. A channel admits one call
at a time (an admission lock per channel); a second call on the same channel
while one runs is refused on x402 before its handler, with no charge to the channel. A replayed voucher
does not match the channel's running total and is refused with the channel
state in the 402, so the buyer can sign the right one. Each committed call is
booked as a sale at the amount charged, with no transaction of its own; the
batch claim and settle carry the chain transactions. A buyer who leaves after
its call's charge was committed is treated as on every other rail: when the
call holds a hang-up forgiveness ticket (the close landed during the settle
itself), the charge is credited back to the channel, once, and the call
counts against the forgiveness budget like any other forgiven hang-up;
otherwise (the forgiveness budget is spent, or the call took no ticket) the
charge stands and the undelivered answer is booked as owed. A credit the channel can no
longer take (already claimed on chain) is booked as owed and repaid by hand.

**Where it is offered.** Beside `exact` on each network listed in
`X402_BATCH_SETTLEMENT_NETWORKS` that a configured facilitator advertises the
`batch-settlement` kind for at `/supported` (with its receiver authorizer),
last in the accepts. Never on an identity-bound route, a route whose effect
outlives the answer, or a long-running report, and never on a network with a
price floor or a settlement premium. The voucher store is the shared Redis
(atomic per channel across replicas); without Redis the option is not offered
unless `X402_BATCH_SETTLEMENT_STORE=memory` names the single-process store.

Settings (all optional except the switch): `X402_BATCH_SETTLEMENT_NETWORKS`
(CSV of CAIP-2 ids; unset = off), `X402_BATCH_CLAIM_INTERVAL_SECONDS` (default
300: how often charged vouchers are claimed, and the claimed funds settled),
`X402_BATCH_REFUND_INTERVAL_SECONDS` (default 900: how often idle channels are
looked for), `X402_BATCH_IDLE_REFUND_SECONDS` (default 86400: a channel idle
that long gets its remainder back), `X402_BATCH_SETTLEMENT_STORE` (`redis`, the
default, or `memory`). One replica runs each pass (a lease). `/api/rails`
carries `batchSettlement` (status, networks, dropped networks with a reason
word, `claims` ok or failing, and the last claim, settle and refund times)
while the switch names a network.

## Charge up to: the work meter

`upto` lets the buyer authorize a ceiling (the route's price or per-request
quote) and the server settle what the call used, never above the ceiling. The
`/v1` chat, Messages and Responses routes meter today when
`GATEWAY_METERED_BILLING=on`. With `METERED_MEDIA=on` as well, speech
(`tts`, `tts-hd`, `tts-lite`), transcription and embeddings report what the
served call used and settle that under the ceiling, through the same meter and
the same rules: an unknown usage settles the ceiling, an amount under the
facilitator's settle minimum settles the ceiling, and a ceiling the minimum
reaches is not metered. A `batch-settlement` voucher meters the same way: the
channel is charged the metered amount, never more than the voucher signed.

## MPP sessions

MPP's Tempo `session` intent (TIP-1034 escrow channels: open, voucher, top up,
close) is the MPP counterpart of a channel. It is not offered here yet: the
server would have to hold a Tempo signing key of its own to settle and close
channels on chain, and the Tempo gate holds none by design. MPP's evm and card
methods define the `charge` intent only, so there is no session on those wires.

## Not offered

- **Metered streams over x402.** A streamed answer's usage arrives after its
  headers, and x402 settles before a stream's first byte, so a stream settles
  at its ceiling (a credits stream debits the metered amount).
- **Authorize and capture** (`@x402/evm/auth-capture`): an escrow hold
  captured later. The `upto` and `batch-settlement` options cover the same
  needs on this server.
