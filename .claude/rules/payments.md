---
paths:
  - "src/payments.js"
  - "src/mpp-*.js"
  - "src/x402-*.js"
  - "src/payment-*.js"
  - "src/*settle*.js"
  - "src/hangup-*.js"
  - "src/replay-*.js"
  - "src/network-floors.js"
  - "src/paid-price.js"
  - "src/credits.js"
  - "src/rails.js"
  - "src/idempotency-store.js"
  - "src/composite-spend-guard.js"
  - "src/circle-*.js"
  - "src/robinhood-*.js"
  - "src/referral-*.js"
  - "src/run-ceiling.js"
  - "src/tools/fetch-guard.js"
  - "src/tools/kit.js"
  - "src/tools/gov-kit.js"
  - "src/tools/data-kit.js"
  - "src/tools/geo-kit.js"
  - "src/tools/weather-kit.js"
  - "src/tools/macro-kit.js"
  - "src/facilitator-*.js"
  - "src/stellar-confirm.js"
  - "src/tempo-confirm.js"
  - "src/svm-funding-refusal.js"
  - "src/avm-*.js"
  - "src/first-call-allowance.js"
  - "src/push-refusal-body.js"
  - "src/unpaid-quote-budget.js"
  - "scripts/test-challenge-size.js"
  - "scripts/test-bazaar-contracts.js"
  - "facilitator/**"
---

# Payments: gates, settlement, facilitators, breakers

Loaded when a payment-path file is read. The settlement-ordering rule in the root
`CLAUDE.md` governs everything here.

- **Idempotency:** opt-in `Idempotency-Key` (and x402 `payment-identifier` as an alias), bound
  to credential + route + query + body, committed only after a settled 200. With no explicit key, an
  x402 EVM payment's identity (network, signed payer, nonce; `paymentNonceIdentityOf`) is the
  implicit key, so a re-sent signed payment is served from its first answer (`X-Replayed-Answer: 1`,
  no handler, no settle, no sale), except on a `hasLastingEffect` route, an identity-bound route
  (a settled header can be rebuilt from chain data) or a streamed call; the store
  (`src/idempotency-store.js`) is Redis-shared across replicas. Replays are counted per slug on
  `/__operator/tool-failures.json`. A claim is renewed while its run is in flight and released when
  the run ends; `IDEM_INFLIGHT_MAX_MS` (default 2 hours, at least 1000) bounds how long one is held
  for a run whose response never ends (`src/idempotency-store.js`).
- **Credits holds:** a credits hold is debited on a final 200 and released otherwise; one whose buyer
  left before the first byte is decided when the response ends, and one nothing ends is released after
  `CREDITS_ABANDONED_HOLD_MS` (default 10 minutes). A running request keeps its hold fresh against
  that sweep for at most `CREDITS_HOLD_REFRESH_MAX_MS` (default 6 hours, never under the abandoned
  window) (`src/credits.js`).
- **Settle-failure breakers:** `src/gateway-settle-breaker.js` (per wallet on `/v1` and other
  wallet-only tools). The key is the signed EVM payer (per network), the verified Tempo sender,
  the credits key, or the signer read from a Solana, Algorand or Stellar payment
  (`src/non-evm-payer.js`, `svm:`/`avm:`/`stellar:`, never case-folded); the client IP only when
  none can be read. Each failed settle is read for the fault it proves (`settleFailureFault` in
  `src/settle-fault.js`, from the receipt code and the facilitator's raw words the receipt guard
  keeps on the request; the Tempo gate's `SETTLE_FAULT` mark): a verdict on the buyer's payment
  (balance, signature, an authorization used or expired, or the chain's own balance words: an EVM
  token's "exceeds balance", Solana's transfer `Custom:1` or `InvalidAccountData`, Stellar `#10` or
  `op_underfunded`, an Algorand asset underflow) counts at `GATEWAY_SETTLE_BREAKER_MAX`; a failure
  of unknown cause (a revert or simulation naming no balance, a bare `settlement_failed`, a 402
  with no receipt, a pending settle) counts at `GATEWAY_SETTLE_BREAKER_UNKNOWN_MAX` (default 3x)
  and its 429 says only that settlement did not complete; ours or a third party's (timeouts,
  store or hook failures, our relayer or credentials, facilitator HTTP errors, billing refusals)
  never counts. Unknown and not-buyer runs at the normal count also raise the burst alarm
  (`unprovenTrips`). A signed EVM payer is counted per network its payment named (key
  `payer@network`, read through `decodePaymentHeader`), so its 429 holds that network only, says the
  wallet can pay on another at once and carries `retry`, `refusedNetwork`, `retryAfterSeconds` and
  `otherNetworksFrom` (`src/tool-error-fields.js`); a Tempo sender, a credits key and the IP
  fallback keep one key. No request is refused for other buyers' failures: `GATEWAY_SETTLE_BREAKER_GLOBAL_MAX`
  distinct failing `/v1` buyers in a window set `settleFailures` on `/api/gateway-status` to `burst`
  (ok / burst) for one window; so does ONE signed EVM payer whose `/v1` failures read refusing
  (the same rule that refuses it) on `GATEWAY_SETTLE_BREAKER_MULTI_NETWORK_MIN` networks (default
  3, never under 2) inside the window, since the per-network count would otherwise let one wallet
  be served unpaid up to the limit on every offered network with no word moving (shared window
  `gwb-nets` per payer; an alarm only, the wallet's per-network refusals are unchanged); and `COMPOSITE_GUARD_GLOBAL_MAX_FAILS` unsettled report or media
  runs set `unsettledReports` to `burst` for `COMPOSITE_GUARD_GLOBAL_PAUSE_MS`; each logs a line
  and the heartbeat and the status Worker page on `burst` under one issue per word that `ok`
  closes. The shared flags are `gwb-alarm` and `cg-alarm`, read by the status words only; the
  earlier `gwb-pause` and `cg-pause` are neither written nor read, and payer-only windows are not
  read for a payment that names a network, so a deploy overlap refuses nobody. **Service-wide bound:**
  `GATEWAY_SETTLE_BREAKER_GLOBAL_MAX` distinct buyers whose `/v1` failures are a verdict on their
  payment (`buyer` only; never unknown, not-buyer, withdrawn or pending) raise the flag `gwb-wide`
  for one window; while it is up a `/v1` consult reads a key's verdict count (never its unknown
  count, which keeps `_UNKNOWN_MAX`) at
  `GATEWAY_SETTLE_BREAKER_BURST_MAX` (default 1) only for a wallet that has never settled (no
  settled call in the window and no paid sale on the books, `payerHasPaidSale`, read only while the
  flag is up and the lower count would refuse; a read that throws counts as paid), under the same
  share rule, its refusal held no longer than the flag. A rotated wallet is served one unpaid run
  instead of three; a wallet that has ever paid, a fresh wallet, a wallet whose failures are of
  unknown cause (below `_UNKNOWN_MAX`) and the catalog consult are served as before. The 429 says
  the service-wide bound is why.
  **One authorization:** a served run whose settle fails for the buyer's fault (the same `buyer`
  class the wallet count reads; never ours, an unknown cause, a withdrawn sub-cent refusal or a
  payment still settling) is also counted per signed EVM authorization (`payer@network#nonce`, shared `gwb-auth`);
  at `GATEWAY_SETTLE_BREAKER_AUTH_MAX` (default `MAX`) that authorization alone is refused with
  `hint: sign-new-authorization`, and a new authorization from the wallet is served at once. A wallet is refused only when it holds
  `GATEWAY_SETTLE_BREAKER_MAX` failures in the window AND they are more than
  `GATEWAY_SETTLE_BREAKER_MIN_FAIL_SHARE` (default 0.5) of its outcomes there; settled calls
  stay in the window as outcomes and never erase failures, so a buyer settling hundreds of
  calls is not cut off by a few replayed authorizations, whatever order the fast reverts and
  slower settlements land in; `GATEWAY_SETTLE_BREAKER_HARD_MAX` (default 40) failures refuse
  a wallet whatever it settled, the bound on unpaid handler runs. **Runs in flight:** the counts are
  of recorded outcomes, and calls that arrive together are all consulted before the first fails, so
  for a payer with NO paid record (`src/paid-record.js`: no settlement seen by this process, no paid
  sale on the books) the consult also counts the key's runs in flight
  that are taken from the payer's balance after the handler (an x402 header, a Tempo pull credential)
  and were not admitted as covered or trusted (`coveredRunStateOf`); such a call is refused 429
  (`Retry-After` 5 s; x402 and a Tempo pull credential are not charged for it) once failures plus
  counted runs in flight reach `_HARD_MAX`. Never counted: a covered or trusted run, any payer with a
  paid record, a card, credits, a Tempo push credential, a key that names no wallet, and everything
  with `INFLIGHT_COVER` set to `off` or `composite` (the consult is then as it was). Per process. **Past its
  count:** `GATEWAY_SETTLE_BREAKER_OVERRUN_ALARM` (default `MAX`) verdict failures recorded for one
  key after its count already read refusing (runs served past the bound) set `settleFailures` to
  `burst`, from the `/v1` and the catalog consult alike; an alarm only. The address fallback key is
  the IPv6 /64 (`limiterKey`), as is the composite guard's; a card buyer refused at its count is not
  told about a wallet or a balance.
  The `/v1` burst alarm otherwise counts distinct buyers, not
  failures. Only a refusal whose offer the next 402 withdraws (`isWithdrawnSubcentRefusal`)
  stays off the buyer's count, and it still feeds the `/v1` burst alarm, each one counted on
  its own; every other facilitator billing refusal (`src/payment-reject.js`) counts in both
  breakers and the composite guard, with a 429 that names it instead of the wallet.
  The composite guard (`src/composite-spend-guard.js`) reads its window the same way: a settled
  run stays as an outcome and never erases failures; a payer is blocked at
  `COMPOSITE_GUARD_MAX_FAILS` only while failures are more than `COMPOSITE_GUARD_MIN_FAIL_SHARE`
  (default 0.5) of its outcomes, and at `COMPOSITE_GUARD_HARD_MAX` (default 10) whatever it settled.
- **Runs in flight are covered together:** `src/inflight-cover.js` (`admitCoveredRun`), called
  through `admitPaidRun` (server.js) before the breaker consult on EVERY mount of a paid handler that
  is not proof-of-work payable: the kit dispatcher, and `withToolCallLog` for the six bespoke content
  routes (`extract`, `meta`, `dns`, `render`, `screenshot`, `pdf`) and the memory family. A new mount
  of a paid handler calls `admitPaidRun` too. (The referral gate bounds its own lane.) Each payment
  is verified alone and settled after its handler, so a run is admitted only when the payer's
  balance of the paying token covers every run it has in flight plus this one; otherwise 429 before
  the handler ("You have not been charged").
  **The rules.** On the report and media routes (`EXPENSIVE_COMPOSITE_SLUGS`) a run is judged as
  it always was: the admission gives a balance read up to 5 s (`COMPOSITE_SETTLE_WAIT_MS`), a run
  the balance does not cover answers 429 with `Retry-After: 30` in the words it always had, and an
  unread balance admits `INFLIGHT_COVER_UNREAD_MAX` (4) runs in flight for every wallet. On every
  other paid route there is no bound on a wallet's runs at once other than its balance, and no
  call waits for another call's settlement to make room. Two waits remain, each bounded by the
  admission wait (`ADMIT_WAIT_MS`, about 1 s; `COMPOSITE_SETTLE_WAIT_MS`, 5 s, on the report and
  media routes): a call whose balance read is slow waits up to it for the read, and a call refused
  while another call of the wallet is settling answers after up to that same wait.
  *Balance read* inside `ADMIT_WAIT_MS` (about a second): the run is admitted if and only if the
  balance covers every run the wallet has in flight plus this one, however many those are (a funded
  wallet's 200 calls at once are all admitted at once); otherwise 429 (`Retry-After: 30`), no
  settle attempted, so the wallet takes no strike. While another run of the wallet is settling (its
  payment may be off the wallet while the ledger still counts it) and cover cannot be confirmed
  yet, the 429 says "Another call from this wallet is still settling" with `Retry-After: 5`.
  *Balance not read right now* (the read failed, did not answer inside the wait, or the account
  cannot be read by this server): the run is judged on the wallet's LAST GOOD READ, the last
  balance this server read for that wallet and token no longer than `GOOD_READ_MAX_MS` (15 min)
  ago, less what the wallet's runs have taken or hold since. Covered: admitted. Not covered: the
  allowance below applies (a kept read is never stricter than no read: the wallet may have been
  funded since). `taken` grows only by what a run took: a settlement's amount (the amount the
  settle reports under a ceiling, `markCoveredRunSettled(req, amount)`), nothing for a run whose
  answer ended at 400 or above with no settlement, and the full amount for any other end. A read
  BEGUN inside the same judgment and then lost stands (never the allowance): refused 429 with
  `Retry-After: 5`; a read cached from before the judgment is a kept read like any other. One
  ledger key per balance: an EVM payment that names no asset is keyed on the chain's token. A wallet gets a good read from any read made for it and from one background read
  when a payment of its settles and it has none younger than `GOOD_READ_REFRESH_MS` (5 min): that
  read is queued in the lane (skipped only when `BG_QUEUE_MAX`, 32, already wait there) and, after
  a background read on a network fails, none is asked for there for `BG_BACKOFF_MS` (10 s). The
  read lane is PER NETWORK (8 at once each), so reads hanging on one chain take no place from a
  wallet on another; a read an admission waits for takes a place before queued background reads,
  which hold at most half a lane (`BG_IN_FLIGHT_MAX`), and a queued background read an admission
  asks for is moved up. The
  per-wallet store (`wallets`: the sum taken, the good read, the last settlement) is bounded:
  `WALLETS_MAX` (50,000) keys, and a wallet with nothing in flight goes after 15 min untouched. A
  read record is a lower bound wherever it is held (`lowerOf`: its balance less what the wallet's
  runs took since it was asked for), and a judgment that has had a read keeps it: a later read
  that does not answer never makes it an unread one. A read that already reflects a settlement
  (that run's amount then taken off it again) leaves the judgment undecided with nothing in flight:
  its one follow-up read is let finish, bounded by the read timeout (`READ_TIMEOUT_MS`, 2.5 s),
  instead of the admission wait. A slow read marks nothing; a read that FAILS
  marks that account's reads down for 10 s (one log line a minute per network), during which its
  admissions wait 25 ms for a read and one read a second is made for it (`READ_FAIL_GAP_MS`). The
  report and media routes are never judged on a kept read. With nothing in flight a run is
  admitted on verify's proof, unless a run of the wallet settled after the request arrived
  (`req.__a402ArrivedAt`): then it is judged like any other.
  *Judged at once:* off the report and media routes, a wallet whose last good read is no older than
  `KEPT_AT_ONCE_MS` (5 min, the settlement refresh's age) and covers every run it has in flight
  plus this one (`lowerOf`, with another container's runs added) is admitted on it at once, with no
  read waited for (`admittedAtOnceOnKeptRead`); only before the judgment asked for a read of its
  own, and only on a read begun after another container's view when one holds a run. A run that
  read does not cover, or an older read, is judged as before (the one-price mirror still refuses).
  *The read gap:* a wallet's reads are at least `INFLIGHT_COVER_READ_GAP_MS` apart (default 10 s,
  1 s to 15 min); inside it a judgment its record does not cover is decided on that record as it
  is (`short`, no read), so a wallet funded within the gap is recognized when it ends (the short
  429's Retry-After is 30). Not held back by the gap: a read needed because another container holds
  a run, the follow-up read after a settlement counted twice, a wallet with no record.
  *The daily budget:* a read whose RPC list reaches a capped host (`ceilingOfRead`: EVM, Solana and
  Tempo lists; `AGENT402_BASE_RPC` for Base) takes a unit of the `cover-reads` share in
  `src/upstream-hard-caps.js` (`HARD_CAP_SHARES`, shared across replicas like the ceilings):
  `INFLIGHT_COVER_READS_DAILY_MAX`, default a fifth of `HARDCAP_ALCHEMY_CALLS`, a set value held to
  half of it (the ceiling off: the set value, or none). A read dropped unmade gives its unit back.
  Past it no read is made (`readsOverBudget`) and the call is judged exactly as when reads are
  down (the kept read, or the allowance; nothing waits), so paid tools keep the rest of the ceiling.
  Counts on the operator view (`inflightCover.readBudget`, `readGapMs`). The longest admission off
  the report and media routes is `ADMIT_SETTLED_READ_MAX_MS` (the wait plus the read timeout,
  3.5 s), when a settlement lands during the read.
  *No good read that recent, balance not read:* a fixed allowance of runs in flight, never an open
  door: `INFLIGHT_COVER_UNREAD_MAX` (4) for a payer with no paid record (`src/paid-record.js`) when
  the admission began, `INFLIGHT_COVER_UNREAD_PAID_MAX` (16) for one with a record; a run past it
  answers 429 at once (`Retry-After: 5`). This is the one place a wallet whose balance would cover
  its runs can be refused.
  A balance can be moved out while covered runs are in flight: those runs fail at settlement, and
  the settle breaker answers afterward (`src/gateway-settle-breaker.js`).
  **The refusal's class** rides on the error (`coverRefusal`: short, settling, beside, unread,
  kept). `src/refusal-reason.js` files it as `cover_*` (third argument, the error), and the tool
  log prints one line per wallet per minute and a summary line for the rest, the wallet by its
  first characters (`createCoverRefusalLogSampler` in `src/prepayment-refusal.js`,
  `noteCoverRefusalLog` in server.js, called once per refusal on both mounts of a paid handler,
  the page-content and memory routes included). The refused call's `[paid-timing]` line follows
  the same answer (`markCoverRefusalLine` in `src/paid-phase-timing.js`); a call that ran prints
  as before. A `short` or `settling` refusal is the payer starting more than its balance covers
  and is not counted by the top-buyer failure alarm (`BUYER_COVER_REFUSALS` in
  `src/top-buyer-failures.js`); `beside`, `unread` and `kept` are. `coverageReads` on
  `/api/gateway-status` (`coverageReadsVerdict`) publishes two words. `status` reads `degraded`
  for ten minutes after an admission decided without a balance read made for it, `off` with the
  check off, else `ok`; one wallet can make it read `degraded`. `alert` reads `sustained` only
  when such admissions fell in 3 or more separate minutes of the last 10 AND for 3 or more
  accounts (an account with no balance source is skipped), else `ok`. The status Worker and the
  heartbeat page on `alert: sustained` only, under one title, and close on the second read in a row
  with `alert` ok (whatever `status` reads: one wallet keeps it degraded) or `status` off (or ok).
  **Across containers:** the wallet's last-settlement mark is shared (`inflight-cover-settled`, a
  flag per wallet that lapses after `SETTLED_MARK_MS`, 2 min): before verify's proof is trusted
  the mark is read once, and a settlement another container made forgets the last good read. A
  reservation in the shared window counts only while the process that
  wrote it keeps its liveness key (`inflight-cover-live`, `INFLIGHT_COVER_LIVE_TTL_MS`, default
  30 s, renewed on a timer), so a container killed mid-run stops being counted within that time.
  That rule applies only to a reservation whose id carries this build's mark (`LIVE_MARK`): a build
  that keeps no liveness key writes ids without it, and its reservations count until they age out
  of the window, so the older build's runs are never dropped while a deploy overlaps. A dropped
  reservation is a departure (the wallet's next judgment is made on a read taken after it, and its
  good read is forgotten), and a process whose key renewal comes later than the key lasts writes
  the reservations it still holds back (`beatOnce`).
  Terms (`coverTermsOfRequest`): the x402 EVM authorization or Permit2 (the MPP evm wire arrives as
  one), a Circle Gateway batched payment (judged on the signer's Gateway balance, `/v1/balances`), a
  Tempo pull credential from a verified sender (`req.mppTempoPull`), and Solana (the transfer's
  SOURCE token account; the paid record is the authority's; when an account of the transfer is a
  lookup-table entry, the WALLET, its static authority, `byOwner`, read as the sum of its token
  accounts of the accepted mint by `getTokenAccountsByOwner`, none reading unknown), Algorand and Stellar payments
  (`src/rail-cover.js`, amount and asset from the matched `accepted`). Balance reads, one bounded
  read each, null = unknown: EVM `balanceOf` (chains from the rails table), Tempo `balanceOf` on
  `TEMPO_RPC_URL`, Solana `getTokenAccountBalance`, algod's asset holding, Horizon's classic balance
  of the asset whose contract id is the accept's. Never judged here: credits, a card, a Tempo push
  credential. A run leaves on its settle success (x402 afterSettle, the fallback chain, the Tempo
  gate), which is also the payer's paid record, or when its response ends.
  `INFLIGHT_COVER=composite`: the check covers the report and media routes only, and the settle
  breaker counts no runs in flight; `INFLIGHT_COVER=off`: the check is off everywhere. Not behind
  the switch (always on): the answer-header stripping on a refused payment
  (`src/answer-headers.js`), the challenge-life rule for card and Tempo pull challenges
  (`src/challenge-life.js`), the settle breaker's IPv6 /64 address key, and the breaker consult
  `admitPaidRun` makes on the bespoke content routes and the memory family. A reservation nobody
  removed (a container that died mid-run) ages out of the shared window after
  `INFLIGHT_COVER_SHARED_WINDOW_MS` (default 900000, minimum 60000).
  Counts on the operator
  view of `/api/gateway-status` (`inflightCover`). Suites: `scripts/test-inflight-burst.js` (every
  wire and mount, `scripts/lib/paid-wires-rig.js`), `scripts/test-inflight-admission.js` (the rules,
  offline).
- **A challenge outlives its run:** `src/challenge-life.js`. The card gate and the Tempo gate (pull
  credentials) settle through a library call that asserts the challenge's expiry again after the
  handler, so before the handler the challenge must have left the route's run seconds
  (`EVM_RUN_SECONDS`; a card route with none, `STRIPE_DEFAULT_RUN_SECONDS` 20; a Tempo route with
  none, 0) plus `CAPTURE_ALLOWANCE_SECONDS` (10): short of it, a 402 with a fresh challenge, nothing
  run or charged. The moment the capture must begin is presented as the run window
  (`presentRunWindow`), so the chat tiers end their upstream work by it. The MPP evm wire settles by
  the authorization's own `validBefore` and needs no such rule (`scripts/test-challenge-life.js`).
- **Answer headers:** a header a handler sets for its answer goes through `setAnswerHeader`
  (`src/answer-headers.js`); the guard, mounted before every payment gate, removes the recorded names
  from any response whose final status is 400 or above, so a gate that refuses after the handler
  sends none of the answer (`scripts/test-answer-headers.js`).
- **Replay guard:** `src/replay-guard.js` claims a payment credential (x402 nonce, Tempo, Stripe)
  in Redis while its call runs; the claim is renewed every 30 s until settle or release, so a
  route that outlives the claim's expiry cannot run twice on one payment. With Redis configured
  but unreachable, a paid call is refused 503 with `Retry-After` before any payment is taken (x402
  dispatcher, Tempo gate and card gate, each through `sharedClaimRequired`) on a long-running or
  composite route (`isLongRunningSlug`), and on any route while another container may be serving
  (`src/replay-topology.js`: more than one replica configured, inside `DEPLOY_OVERLAP_SECONDS` of
  listen, default 120, anchored by `markListening` from the listen callback, else import time, or
  draining, read from `drainSignal()`); a lone container past that window serves fast routes on a
  per-process claim, so a store outage does not stop sales. Every granted x402 call's consumed mark
  is held while its authorization stays valid (`validBefore` plus a margin, never under the default
  hold): the gateway cache reader (`src/gateway-cache-scope.js`) takes a still-valid authorization
  the guard does not hold as its payer's proof, so a settled mark must not lapse first. A settled
  call's hold ends `MAX_SETTLED_VALIDITY_HOLD_MS` (30 days) after its settle at the latest, so no
  `validBefore` keeps a key per paid call for longer; past that bound a settled mark is let go (its
  nonce is spent on chain, so it cannot be charged again), and an authorization signed valid from
  the epoch for longer than the bound is the one case the reader cannot tell from a fresh payment in
  its last minutes. A grant that was not settled (`grantedUnsettled` in
  `src/hangup-settlement.js`: a forgiven hang-up, a first-call allowance) is held to its
  `validBefore` in full, since that authorization is still live on chain. The call site is
  `consumedHoldFor`; a longer hold is a longer TTL on the same writes
  (`scripts/test-replay-consumed-hold.js`, on Redis).
- **Per-chain price floors:** `src/network-floors.js`. Every accept is priced through
  `priceForNetwork` (`src/payments.js`: list or per-request quote, plus the chain's
  `NETWORK_PRICE_PREMIUMS` premium, raised to its floor). eip155:4663 has a static floor
  (`ROBINHOOD_MIN_PRICE_USD`, "0" off; `NETWORK_PRICE_FLOORS` for others) because its settlement
  can run through our own relayer; it is static so the paid retry re-derives the same amount.
  Ink (eip155:57073) has none by default: only its listed facilitators pay its gas, so the
  floor rule (a settler of ours may pay) does not apply; a per-settlement fee is a premium.
  A floored network, or one with a premium above zero, is never offered `upto` (the boot gate refuses it). /api/pricing (`minPriceUsdByNetwork`), llms-full.txt,
  the chain page and the guides read the same floor; `payment.premiumUsdByNetwork` there publishes
  each chain's premium, and llms.txt, openapi and MCP `payment.info` read the same map. Sales, hang-up debts and charged-failure
  debts on an x402 settle book what the buyer paid on that chain (`src/paid-price.js`: the
  amount signed on an EVM rail, else the gated price through `priceForNetwork`), so revenue
  reads the premium and the floor and a refund repays what was paid.
- **`upto` and Permit2 gas sponsorship (both off by default):** `X402_UPTO_NETWORKS` (CSV of
  CAIP-2 ids, or `all`) offers `upto` beside `exact` on each listed EVM network a routing
  facilitator advertises upto for at `/supported` (`src/payments.js`, `scripts/test-upto-scheme.js`).
  Arc (`eip155:5042`) is a member only when named (`all` never adds it); named, the Circle client
  lists Circle's Arc upto kind and preflights a Permit2 payment locally (signature under Permit2's
  domain, upto proxy as spender, our payTo and Circle's facilitator in the witness, the ceiling equal
  to the quote on verify and at or above the settle amount), and books a pending settle under its
  Permit2 nonce in 32-byte form. `X402_UPTO_GAS_SPONSORING` (`on` = `eip2612GasSponsoring`; or a CSV
  that may add `erc20ApprovalGasSponsoring`) declares the key in `PaymentRequired.extensions` on a
  per-request priced `/v1` route that offers upto, only when the first facilitator advertising upto
  on EVERY offered upto network lists the key in its `/supported` `extensions`; the declaration is
  the SDK helper's `info` without its schema (header budget). Sponsorship moves the one-time Permit2
  approval's gas to the facilitator; the settled amount is still the meter's, capped at the quote
  (`src/upto-gas-sponsoring.js`, `scripts/test-upto-gas-sponsoring.js`). An upto accept past the first
  and the declaration are charged to the route's 402 budget (`uptoChallengeBytes`), so Arc upto and
  sponsoring on shrink about 320 listings; a route still over budget keeps every exact accept and one
  upto accept on the first network that is not explicit-only (Base; `uptoNetworkKept`), whatever the
  list order, and declares no sponsoring. The upto set and the keys are read from `/supported` at boot
  only (a restored rail does not re-read them): a facilitator change takes effect at the next restart.
  The preflights read only string payload fields (`txt` in `src/circle-shapes.js`) and refuse an
  EIP-2612 permit with any permit field but no matching `from`
  (`scripts/test-evm-preflight-inputs.js`).
- **Solana funding refusals:** `src/svm-funding-refusal.js` words a Solana verify refused for no USDC
  account or too little USDC (`retry: fund-wallet`, Retry-After `SVM_FUNDING_RETRY_AFTER_S`, default 300)
  and, after `SVM_FUNDING_HOLD_AFTER` (3) such refusals per wallet and source account in
  `SVM_FUNDING_WINDOW_MS` (10 min), answers from a beforeVerify hold lasting the Retry-After, shared
  through shared-limits; a valid verify clears it; `SVM_FUNDING_THROTTLE=off` disables the hold.
- **Verify refusals, said and logged:** a verify refused for funds carries `reason`
  (`insufficient-funds`, or `no-token-account` for no USDC account on Solana, no trustline on
  Stellar, not opted in on Algorand), a sentence with the price, and `needs` (network, asset,
  base-unit amount and dollars from our own requirements, `needsOf` in `src/verify-hint.js`;
  Stellar amounts read at 7 decimals). On Stellar and Algorand the facilitator's message is read
  for the class, never echoed; on EVM only the reason code is. With no balance read (any EVM
  chain but Base) a reverted simulation is worded as either reading, never as a wallet that
  covers the price. The log line (`src/verify-failure-log.js`) carries `route=<slug>` and
  `payer=<first 4 characters>` (`0x` plus four hex on EVM, case kept, never the address), one
  bounded line, and prints `?` for any field that is not a string
  (`scripts/test-verify-refusal-reason.js`, `scripts/test-svm-funding-refusal.js`).
- **Algorand sub-cent offer gate:** `src/avm-sponsorship.js` drops the Algorand accept from
  sub-cent 402s while the facilitator cannot sponsor sub-cent settlement (fails open;
  a status row last updated in an earlier UTC month, or with an unreadable `updatedTs`, is
  not evidence; a pause a settle refusal set holds against headroom reads for
  `AVM_SPONSORSHIP_REFUSAL_HOLD_MS`; published on `/api/rails`, the only excuse the canaries
  accept for a missing sub-cent accept; `AVM_SUBCENT_GATE=off`).
- **First-call allowance:** `src/first-call-allowance.js`, off unless `FIRST_CALL_ALLOWANCE=on`: a wallet with no paid sale gets one unsettled first call (x402 EVM exact, a flagship or `FIRST_CALL_ALLOWANCE_SLUGS` route at or under `FIRST_CALL_ALLOWANCE_MAX_USD`), inside `FIRST_CALL_ALLOWANCE_DAILY_USD` and `FIRST_CALL_ALLOWANCE_IP_PER_DAY` claimed on Redis before a balance read bounded by `FIRST_CALL_ALLOWANCE_BALANCE_MS` (default 1000); a call asking for a share link is never granted; the wallet key expires (`FIRST_CALL_ALLOWANCE_WALLET_TTL_DAYS`, default 400; a claim after 30 minutes), the state record does not; an onBeforeSettle `skip` leaves its 200 unsettled and unbooked; figures on `/__operator/refunds.json`, with `returnedPayers` (granted wallets with a later outside paid sale, and within 7 days; one batched ledger read per chunk, cached `FIRST_CALL_ALLOWANCE_RETURNED_CACHE_MS` (default 5 minutes), reported with the switch off). The `firstCallAllowance` word on `/api/gateway-status` (on, spent, unavailable) pages nothing: a store that does not answer grants nothing, so every call is paid as usual.
- **Rails dropped at boot, re-read:** the boot guard offers only networks a facilitator's
  `/supported` read confirms (`src/boot-supported-read.js`): up to three tries (6 s each, at 0,
  8 and 22 s; tries 2 and 3 are new requests, and any request still out counts; a third only
  after a try of ours timed out, so two error answers keep today's two tries), every boot read
  at once (the guard, Arc's read, which is the guard's own read of the Circle client, and the
  Gateway batched read), inside a bound no longer than the boot held before for that
  configuration: 14 s plus 8 s each for Arc and the batched option (so a deployment with neither
  gets two tries at boot and the re-read below is the third). `X402_SUPPORTED_TRY_MS` and
  `X402_SUPPORTED_BOOT_MS` override the try and the bound (tests). `/api/rails` gives each
  dropped rail a `reasonWord`: `probe-timeout` (our read got no answer within our limit),
  `read-failed` (an error answer or a failed connection), `not-advertised` (answered without
  it), `config` (another guard); its `gatewayBatched` field (while `GATEWAY_NANOPAYMENTS=on`)
  carries `status` offered / partial / dropped and each dropped network with its word (also
  `not-in-offer`), which the heartbeat's rail check counts beside `degraded`. A network dropped
  while a read had FAILED (error or timeout) is read again in the background (`src/rail-recheck.js`): the facilitators whose read
  failed, one read each per tick, first after `X402_RAIL_RECHECK_MS` (default 30000; `off`
  disables), doubling to `X402_RAIL_RECHECK_MAX_MS` (default 600000). When one lists the network,
  `restoreRail` (`src/payments.js`) writes, in one synchronous turn, the scheme registration, the
  resource server's two lookup entries for that network, the offered list and every route's
  `accepts` (the vendor reads `accepts` per request), asks the vendor's route check, and rolls the
  offer back if it objects; `initialize()` is never called again (it clears its maps before
  awaiting facilitators). `/api/rails`, `/.well-known/x402`, `/api/pricing`, the cached
  `/openapi.json` and the nav follow (`onRailRestored`). A facilitator leaves the list as soon as
  it answers, so a network it does not list stays dropped, and one dropped while every
  facilitator answered is never re-read. Left for the next restart: Arc (fails closed on Circle's
  own read; its contract-wallet gate is registered only with Arc in the boot offer) and, on a
  restored network, the `upto` and Gateway batched accepts (`scripts/test-rail-restore.js`).
- **Facilitators:** boot guard in `src/payments.js` and `src/x402-boot-init.js`; diagnostics in
  `src/facilitator-diagnostics.js`; Stellar confirm in `src/stellar-confirm.js`; Tempo
  chain-truth confirm in `src/tempo-confirm.js`. Arc (`eip155:5042`) settles through Circle's
  facilitator only (`src/circle-facilitator.js`): `CIRCLE_FACILITATOR_API_KEY` is the switch,
  the client is Arc-only, reduces every upstream error to a status and a reason code, and Arc
  fails closed on Circle's own `/supported` (`scripts/test-arc-rail.js`).
  `CIRCLE_FACILITATOR_EVM_FALLBACK` is off by default; with `=on`, the Arc key and
  `PAYMENT_SETTLE_FALLBACK=true`, the issuer's facilitator is the last settle fallback on Base
  and Polygon, only for networks its `/supported` lists (re-read every
  `CIRCLE_EVM_SUPPORTED_REFRESH_MS`, default 10 minutes; a failed read tries none) (`src/circle-facilitator.js`,
  `src/circle-supported.js`; `scripts/test-circle-evm-fallback.js`).
  `ROBINHOOD_FACILITATOR_URL` is an ordered list: at boot (more than one listed, not offline) each
  `/supported` is read at once and the first in list order that confirms exact on `eip155:4663`
  settles (`firstConfirmedFacilitator`, logged when it is not the first; none confirms = the first,
  as before); the rest are Robinhood's settle fallback (never routing facilitators), reached after
  a pre-broadcast refusal or, on `eip155:4663` only, a reverted `transferWithAuthorization`
  (`isRetryableSettleRefusal`) or a listed facilitator's graceful HTTP 200 `success:false` with no
  transaction and a reason that is not a verdict about the buyer (`isListedPassOnRefusal`,
  `markGracefulRefusals`; verdicts as codes or prose in `src/settle-verdict.js`): that one goes to
  the next LISTED facilitator only, and when none settles it, it is read on chain like an ambiguous
  failure before our relayer may submit. A buyer verdict (signature, buyer balance, expired; a code,
  or words on a graceful answer) is retried nowhere and not read on chain; a used nonce or
  authorization (code or words) goes to no other settler but is read on chain, since the
  facilitator's own earlier submission may have used it; an HTTP error with the same words keeps
  the ambiguous path (`scripts/test-rh-boot-primary.js`, `scripts/test-rh-prose-refusal.js`,
  `scripts/test-rh-outage.js`).
  `INK_FACILITATOR_URL` (Ink, `eip155:57073`, native Circle USDC `0x2D27...AEEd`, domain
  "USDC" v2 in `TIER1_USDC`) is the same ordered list with the same boot choice
  (`chooseListedPrimary`), listed fallbacks (`wireListedFallbacks`) and pass-on rules
  (`REVERT_RETRY_NETWORKS` holds both chains), but no own relayer and no outage read: an
  ambiguous or passed-on Ink failure that no listed facilitator settles stops as a 402 (the
  pending-settle read still applies; `EVM_RPC_57073` overrides the RPC, whose receipts are
  read at the sequencer's head). Its fallback override is the listed ones only (no
  PayAI/Solvador). The chosen client routes Ink only and every other routing client has
  Ink removed from its `/supported` (`exclusiveNetworkOwners`), so the operator's order is
  the only one. Unset, `enabledNetworks` leaves `ink` unconfigured (warned once). Ink is in
  RAILS (graduated after its first live settle). A new rail can start in `GATED_RAILS`
  (`src/rails.js`) with its read-config in `GATED_EVM` (`src/revenue-live.js`); graduating it
  after a live settle moves both entries, and every typed chain list and count follows
  (`scripts/test-chain-list-copy.js`). No price floor by default (no settler of
  ours pays its gas); `NETWORK_PRICE_FLOORS` sets one and /api/pricing
  `minPriceUsdByNetwork` publishes any offered chain's floor (`scripts/test-ink-rail.js`,
  `scripts/test-ink-graduation.js`).
  `src/facilitator-gas.js` reads each listed facilitator's settlement signers (from
  `/supported`) for gas runway every 10 minutes under a lease, one check per listed-facilitator
  rail whose readings replace only that network's rows (`scripts/test-settle-fallback.js`,
  `scripts/test-tool-failure-monitor.js`). There is no extra Solana settle fallback by design: a
  Solana payment names the quoted facilitator's fee payer, and any other facilitator refuses it.
  `FACILITATOR_PUBLIC_INDEX_CHAINS` (`robinhood` and `ink` are the known values; unset = none;
  any other value renders nothing and warns at boot; a listed chain renders only while the
  final offer carries it, and one it leaves out is named in a boot warning,
  `publicIndexUnofferedWarnings`) renders the /privacy paragraph (every field the index
  publishes, its per-seller payer pages, permanence, where it is processed), scopes the no-sale
  line to that list, adds the /terms pointer, `payment.dataHandling.publicSettlementIndex` on
  `/.well-known/x402`, a clause on the listed chains' llms.txt lines and a row on their chain
  pages; each chain names the facilitator it settles through first, from its own list (one
  shared host is named once, different hosts each with their chain).
  `FACILITATOR_PUBLIC_INDEX_NAME` (display name, escaped), `FACILITATOR_PUBLIC_INDEX_POLICY_URL`
  (linked only as a parsed https URL) and `FACILITATOR_PUBLIC_INDEX_SINCE` (YYYY-MM-DD; /privacy
  and /terms print the later of their own date and it, once reached) are optional. The boot warns
  when a listed chain's facilitator list (`ROBINHOOD_FACILITATOR_URL`, `INK_FACILITATOR_URL`) has no parsable first host, and for an
  invalid URL or date (`publicIndexBootWarnings`); there is no status word for it
  (`src/facilitator-public-index.js`, `scripts/test-public-index-copy.js`). `ROBINHOOD_RELAYER_KEY` (key present = on) adds our own
  settler after the listed ones (`src/robinhood-relayer.js`): our 4663 sales only (token, call and
  treasury fixed), the package's exact EVM facilitator verify and settle, one submission per
  relayer key across replicas under a lease with the nonce read under it, fee and gas caps, a
  balance check before signing, and a hash for any send that may have reached the node so a
  missing receipt stops the chain; its signer joins the gas check (`scripts/test-own-relayer.js`).
  While every fresh gas reading of the first listed facilitator's signer is under
  `ROBINHOOD_SKIP_DRY_BELOW_SETTLEMENTS` (default 50) settlements, our relayer settles first
  (`src/robinhood-order.js`; facilitatorFunds leaves that covered row out). The order's start
  (`since`) is a state-database document (`robinhood-order:eip155:4663`), so a deploy or another
  replica keeps the clock; `robinhoodSettler` on `/api/gateway-status` reads `relayer` once our
  relayer has been first without a break for longer than `ROBINHOOD_RELAYER_FIRST_ALERT_HOURS`
  (default 6; 0 or `off` reads `off`), `ok` otherwise, `off` without an order, and `unknown`
  before a fresh process's first update unless the stored clock (read at creation) already reads
  `relayer`. A facilitator-first decision taken on a reading stores `resetAt`; a relayer-first
  start before the latest reset restarts at it, so a lagging replica cannot revive an old clock.
  The heartbeat and the status Worker page on `relayer` under one issue that ok or off closes
  (`unknown` does neither); the operator view
  has the clock (`scripts/test-robinhood-settler.js`, `scripts/test-robinhood-settler-pg.js`).
  With it, an ambiguous listed-facilitator failure on 4663 (5xx, timeout, no verdict, no
  transaction) is read on chain (`src/robinhood-outage.js`): the authorization used with our
  transfer is served (claimed first), still unused after `ROBINHOOD_AMBIGUOUS_WAIT_MS` (the wait
  ends inside the authorization's settle deadline and the CDN answer window) goes to our relayer,
  which is skipped when the buyer left forgiven, the deadline leaves it no time, or a CDN
  window is shorter than its lock wait plus receipt wait. A read failure (an unreadable receipt
  included) is a 402 with the authorization booked in the late-settlement book, which never
  closes a used authorization as not landed (`scripts/test-rh-outage.js`).
  An EVM exact settle failure (not 4663, Arc, Tempo or Gateway batched) whose answers named a
  pending tx is read on chain first (`src/pending-settle.js`): every pending answer's tx is noted
  on the payment (the library's one retry can name another), and a receipt within
  `PENDING_SETTLE_RECEIPT_WAIT_MS` (default 12000, also inside the CDN window and validBefore)
  that is status 1, uses this authorization and moves the price from the payer to our payTo, not
  a recorded sale, is claimed and served (its pending 5xx answers leave the upstream count in
  their own lane); anything else, or a buyer gone, keeps the 402 and books every noted tx, each
  pinned to the authorization's nonce so only one can be owed. At most
  `PENDING_SETTLE_MAX_INFLIGHT` (default 8) reads run per process; past it, or after an RPC 429
  or rate-limit error, the read ends. Outcomes by network and facilitator are on
  `/__operator/tool-failures.json` (`pendingSettles`; `scripts/test-pending-settle.js`).
- **Unpaid quote budget:** `src/unpaid-quote-budget.js` bounds bursts of unpaid 402 reads. A
  payment header counts as an attempt (`src/payment-attempt.js`) only when it decodes to an offered
  network or an MPP credential; bytes that do not decode are an unpaid read. The key is the client
  address alone (`clientKeyOf`: `limiterKey(req.ip)`, an IPv6 /64 as one); the User-Agent is kept
  for the log line only. From Cloudflare's shared Worker egress address (2a06:98c0:3600::103) the key
  is the address plus the User-Agent token, under a ten-times whole-address ceiling. Only our signed probes are exempt (`isSynthetic`, server.js `isSyntheticRequest`: the
  HMAC `X-Heartbeat-Token`); a User-Agent naming us is counted like any other, and a
  self-declared named indexer or crawler reads against `NAMED_CLIENT_BUDGET_MULTIPLIER` (10) times
  the budget on the same address count, never a pass.
- **Challenge size:** `scripts/test-challenge-size.js` keeps the 402 header under what a buyer
  can echo back; `scripts/test-bazaar-contracts.js` validates every 402 against the protocol's
  own schema.
- **402 body mirror:** `src/payment-required-body.js` copies the decoded PAYMENT-REQUIRED object
  into the JSON body of every paywall 402 (header authoritative, header keys win, our fields
  kept); a refusal that explains itself (a `hint`, or a problem's `detail`) gets the offer and
  no `error`, so `error`-first clients read the explanation. Keyed on the header, so
  settle-failure, credits and Tempo/Stripe direct 402s are untouched. It wraps `res.send`, so it
  is mounted before the MPP shim and the Tempo/Stripe gates.
- **402 `payment` block:** `src/payment-guide.js`: a first-contact 402 body carries `payment`
  (this request's dollar price on the primary network through `priceForNetwork`, or on the first
  network offered when the route does not offer the primary; one sentence on paying; `noWallet`
  on a proof-of-work tool; `quote` with the caller's own model, request bytes and output cap on a
  body-quoted route, never a rate or cost; links to `/llms.txt`, `/agents.md#pay` and `/mcp`).
  Body only, keyed on the PAYMENT-REQUIRED header. A refused payment carries none: an x402
  header that decodes and is refused, or an `Authorization` credential, keeps its own
  explanation. An x402 header that does not decode is removed at intake
  (`src/payment-header.js`), so its 402 is a first-contact answer and carries the block beside
  `reason: malformed-header`. Every other field and the header are unchanged
  (`scripts/test-payment-guide.js`). Rollback lever:
  `PAYMENT_GUIDE_402=off`.
- **Tempo push refusals:** `src/push-refusal-body.js`: for a push credential the Tempo gate
  restates a 4xx JSON body's not-charged sentence and sets `charged`, `transferClaimed`, `refundOwed`.
- **Algorand network id:** `src/avm-network.js`: the CAIP-2 (32-character) id is what every 402
  carries; the genesis-hash spelling is folded on the paid path (`src/x402-v1-accepts.js`) and read
  as an alias in seller rows and the buyer.
- **Replay store word:** `/api/gateway-status` reports `replayStore` (ok or pending). pending means a
  settled payment's consumed mark could not be written to the shared store yet; one shared retry loop
  writes it, and the local consumed mark keeps the payment from running again meanwhile. A second
  word, `alert`, reads `sustained` once pending has held ten minutes without a break
  (`REPLAY_STORE_ALERT_AFTER_MS`); the status Worker and `heartbeat.yml` page on it ("Replay store
  marks PENDING (Redis)") and close on `ok`.
- **Paid-quote trust:** an address with a settled paid 200 gets 10x the unpaid price-check figures for
  10 minutes after each paid call (`PAID_CLIENT_QUOTE_MULTIPLIER`), keyed by an HMAC of the client key.
  On `/v1/metered` the raise is earned per call: past the plain figure each settled `/v1/metered` call
  grants `METERED_QUOTE_CREDITS_PER_CALL` (2) quotes, held up to the raised per-minute figure for the
  window, on this process only (`src/paid-quote-trust.js` `creditMetered`).
- **Listing content type:** a tool def's `mimeType` (`src/tool-media-type.js`) is the type its x402 listing, `/openapi.json` and `/api/pricing` state. `X402_BINARY_LISTINGS` (default on: unset or any value but `off`): a binary route's x402 listing carries its content type, output type `binary` and a string sample naming its bytes; `off` returns every 402 header, body and discovery extension to the earlier shape (`application/json`, output type `json`, the tool's `legacyListingExample`). `/openapi.json`, `/api/pricing` and the tool pages do not read it. It is read once when the payment middleware is built, so a flip takes effect on restart. `scripts/bazaar-validate.js` with no arguments checks the flagship set plus every `/api/pricing` row whose `mimeType` is not JSON (at most 12 more) and ends at `BAZAAR_VALIDATE_DEADLINE_MS` (default 8 minutes), reporting what it did not reach as unreadable.
- **Referral copies (`/ref/<slug>`, off by default):** `src/referral-gate.js` (the gate), `src/referral-settle.js` (the facilitator client), `src/referral-chain.js` (chain reads), `src/referral-proof.js` (the receipt rule, import-free), `src/referral-book.js` (the durable book), `src/referral-answers.js` (owed answers at rest), `src/referral-run.js` (the run scope). Paid mode only, and only with every REQUIRED setting present and usable: `REFERRAL_PAY_TO` (the referral network's split contract), `REFERRAL_MERCHANT_ID` (this merchant's id on that contract, a decimal number), `REFERRAL_PAYOUT_ADDRESS` (the wallet the contract pays this merchant's amount to; not the pay-to contract), `REFERRAL_FACILITATOR_URL` (https), `REFERRAL_SIGNER_KEY` (32-byte key that signs facilitator requests; an unusable one leaves the gate off, never fails the boot; the router worker's environment drops it), `REFERRAL_SLUGS`, `REFERRAL_SETUP_URL` and `REFERRAL_COMMISSION_BPS` (`default:<bps>,<slug>:<bps>`; no built-in rate; every slug must be named or covered by `default`; read for the least a payout must carry for the proof, and to book a success whose receipt cannot be read yet). Optional, with defaults: `REFERRAL_ROUTED_TOPIC` (topic0 of the split contract's routed-payment event; the documented one), `REFERRAL_FEE_BPS` (0), `REFERRAL_DEADLINE_MS` (25000, handler budget), `REFERRAL_SETTLE_MS` (50000, the `/settle` call waits for the receipt), `REFERRAL_VERIFY_MS` (10000), `REFERRAL_SETTLE_RESERVE_MS` (10000), `REFERRAL_MAX_VALIDITY_MS` (900000), `REFERRAL_VERIFY_SIGNED` (on; `off` sends `/verify` unsigned), `REFERRAL_RECEIPT_WAIT_MS` (4000) and `REFERRAL_UNCONFIRMED_MAX` (5), `REFERRAL_UNRECOGNIZED_READS` (5, full readings of a receipt the proof rule does not recognize before an expired entry is closed to the operator record), `REFERRAL_SEND_IDLE_MS` (15000) and `REFERRAL_SEND_MAX_MS` (120000, the bounds on one answer's send), `REFERRAL_SHORT_NET_MAX` (3; 0 never stops a slug), `REFERRAL_MIN_NET_BPS` (none; `default:<bps>,<slug>:<bps>`, a slug's stop floor as a share of the price) and `REFERRAL_PRODUCT_IDS` (none; `<slug>:<0x 32-byte id>`), both optional and both leaving the gate off when malformed, `REFERRAL_UNSETTLED_MAX` (3), `REFERRAL_UNSETTLED_HARD_MAX` (40) and `REFERRAL_UNSETTLED_GLOBAL_MAX` (12) per `REFERRAL_UNSETTLED_WINDOW_MS` (900000), `REFERRAL_PAYER_INFLIGHT_MAX` (8), `REFERRAL_MAX_INFLIGHT` (24), `REFERRAL_OWN_FAULT_MAX` (3) and `REFERRAL_OWN_FAULT_COOLDOWN_MS` (60000), `REFERRAL_HANGUP_KEY_USD` and `REFERRAL_HANGUP_GLOBAL_USD` (the direct routes' sizes) per `REFERRAL_HANGUP_WINDOW_MS` (one day), `REFERRAL_SWEEP_MS` (60000), `REFERRAL_BOOK_FILE`, `REFERRAL_ANSWER_DIR`. Invariant: deadline + settle reserve + verify wait fit the 60 s the 402 asks a buyer to sign for (a configuration past it leaves the gate off); the settle call may run past `validBefore`, since it waits on a transaction submitted inside it. With the settings absent nothing is mounted: `/ref` answers exactly as any unknown path (status, body, headers) and `/api/gateway-status` carries no referral word; FREE_MODE never builds the gate. Every dependency the server passes the gate is required: one missing leaves the gate off.
  **Surface.** A standalone gate mounted before every payment gate (GET, HEAD, POST; the canonical spelling `/ref/<slug>` only: any other, a trailing slash included, is a JSON 404, never a redirect): no catalog entry, no rail, no discovery surface, `X-Robots-Tag: noindex`; while mounted, `/ref` is a JSON API path with the API routes' CORS. Its 402 (JSON body only) has one accept: exact, Base USDC, `payTo` the split contract, `extra.authorizationType` `ReceiveWithAuthorization`, and the amount the direct route's Base accept carries for the same request (`quotedPriceUsd` through `priceForNetwork`; never higher), with the referrer token echoed in `extensions` byte for byte (a token over 8192 characters or not printable ASCII is not echoed). **An empty request** (no query, and no body or a JSON body of exactly `{}`) runs the tool's published example (`def.discovery.input`): the 402 quotes that example and the paid call runs exactly it; any other body (text, a form, a JSON array) is served as the direct route serves it. An unpaid body the direct route refuses before payment is refused the same way. A refusal's ready-to-run call is dropped, and the chat tiers' hints that name a route are left out at their source inside a referral run (`routeHint` / `inReferralRun`); a new hint in an admitted tool's answers goes through `routeHint`. The load-shed list, the unpaid-quote budget (its 429 has `/ref` text of its own), the metered quote limiter, the refused-credential limiter and the body parsers read the `/ref` twins.
  **A paid call, in order.** Local checks, before anything leaves this server: `to`, the exact value, the payer's own ECDSA signature over the ReceiveWithAuthorization (v 27/28 or 0/1, or compact; a contract wallet's signature is not taken); an answer already kept for this payment (below); then validity for the whole run (deadline + reserve + verify) and no further ahead than `REFERRAL_MAX_VALIDITY_MS`; the direct route's payer screen (same 403; a screen that throws answers 503, fails closed); a full book (503 here, before anything runs); the drain check; the input pre-validation; the bounds on calls waiting for `/verify` (route-wide 4 x `REFERRAL_MAX_INFLIGHT`, per payer `REFERRAL_PAYER_INFLIGHT_MAX`, per address 4 x that); the unsettled-run lane (below); the claim in the gate's own replay guard; the own-fault hold (below); **the chain head, read and kept before `/verify`** (no head readable: 503, nothing runs); the facilitator's `/verify`, always, sent the payment REBUILT from the fields this server validated (`normalizedPayment`: the quoted requirement as `accepted`, the checked signature and six authorization fields, the two attribution strings; never the buyer's object passed through). A verdict on the payment is the documented `isValid: false` or a JSON 400 (the buyer's refused credential: 402, counted by the credential limiter); an intermediary's 403 or 429, a page that is not JSON or a 5xx is a 503 counted against nobody. A run slot (`REFERRAL_MAX_INFLIGHT`) is taken only once the payment has verified. Only then the handler, chat bodies forced non-streaming before the quote, under the deadline, presented to it as the end of its payment window (`presentRunWindow`) and as a ceiling on its handler budget (`withBudgetCeiling`), so upstream work is cut off at the deadline. Boot serves a slug only when the deadline can end its upstream work (a pure-CPU tool, a chat tier, a handler under `underBudget`, or a definition marked `endsAtCeiling`, `src/run-ceiling.js`: its reads carry fixed timeouts of their own, each cut short by the run's ceiling, with no lookup, request, retry or connection started after it; a handler that gains another kind of wait leaves that list, and `scripts/test-run-ceiling.js` drives every marked tool to hold it) or its own upstream timeout fits, and logs why for each. A handler that comes back only after its ceiling is answered 504 and never settled, whatever it returned; also left out: missing, no handler, identity-bound, lasting-effect, third-party-paying, long-running, binary.
  **The claim.** Released only while nothing ran (an input or verify refusal, a store that did not answer). Once the handler has started the authorization is spent for running purposes whatever follows: held to `validBefore`.
  **Paid means routed to us** (`proveReceipt`, `src/referral-proof.js`). The buyer's authorization names only the split contract, which pays whichever merchant its caller names, so money reaching the contract is not yet ours. One receipt must show all of: this authorization's AuthorizationUsed log followed directly (next log index) by a USDC Transfer from the payer into the contract of at least the amount, in a successful transaction with the hash asked about; and, before the next authorization in that transaction, the contract's routed-payment event (`PaymentRouted(uint256,uint256,uint256,address,uint256,bytes32,uint256,uint256,uint256,uint256,uint256,uint256)`: three indexed ids, then buyer wallet, merchant id, product id, gross amount, four split legs, merchant amount) naming this buyer, this gross and `REFERRAL_MERCHANT_ID`, with a USDC Transfer from the contract to `REFERRAL_PAYOUT_ADDRESS` of the merchant amount the event states, an amount above zero, in a transaction whose receipt `to` is the contract. **The size of the merchant amount does not decide it**: the buyer paid the whole amount and the contract routed it to us, so a share under the minimum net (`referralMinNet`: the gross less the commission and fee total rounded UP plus one unit for each further split leg) is still paid, and is this server's own configuration drift (below). The proof states the merchant amount it read (`net`) and whether the contract's event names our merchant id whatever else fails (`routedToUs`). **The product is bound per slug** when `REFERRAL_PRODUCT_IDS` names it: the routed event's product id (data word 2) must equal the slug's, else the receipt is `unknown` and routed to us (held for the operator, attention; never booked or delivered as that slug's sale); a slug with no id configured is not bound, and the operator's word lists such slugs (`noProductId`). The event's three indexed ids are not read. The refund path does not bind the product. Nothing stands in for the event: a payout transfer with no decodable event is `unknown`. Routed to another merchant is `unpaid`. **A shape not recognized is `unknown`** (no event, our event without its payout or under the expected net, an event of another shape, buyer or gross, a transaction sent to another contract): never paid and never unpaid. The rule is pinned to a settlement in the rail's shape (test wallets, ids, amounts), `scripts/fixtures/referral-receipt-base.json` (the event's data words by position: 0 buyer, 1 merchant id, 2 product id, 3 gross, 4 to 7 split legs, 8 merchant amount; the event is the last log, after the payout): the suite proves it and refuses each single-field tamper, so a change to the rule is made against that file.
  **Settlement.** A JSON answer only (a stream, bytes or an answer over 8 MB is a 500, uncharged). A buyer gone before settlement is not settled while the run holds a hang-up forgiveness ticket: the direct routes' rule on budgets of this gate's OWN (per payer, per address, route-wide; abandoned records kept in the book), so referral traffic never changes a direct buyer's outcome; without a ticket the payment is settled and the answer kept. **A buyer gone during the settle call** spends its ticket too (unlike the direct routes, where it is returned: here a refund repays the gross and only the net was received), and the open entry carries the hang-up from that moment, whatever the outcome reads yet: `settle in flight` for one inside the budget, the spent-budget reason (`payer budget`, `ip budget`, `global budget`) for a repeat, so a payment that lands later is owed back as a hang-up and the refund run holds the repeat. The intent (with the head read before `/verify`, `fromBlock`) is written to the book BEFORE `/settle`; with no intent stored `/settle` is not called (503, answer kept). One `/settle` is in flight per authorization. The facilitator's `success` is checked against the receipt rule before delivery, the read retried for `REFERRAL_RECEIPT_WAIT_MS`, and the receipt has THREE readings. **Proven**: delivered and booked. **Not readable yet** (no receipt): delivered and booked as `unconfirmed` only while fewer than `REFERRAL_UNCONFIRMED_MAX` unconfirmed entries are open, else the answer is held as in doubt (the buyer's re-send gets it once proven); the sweep confirms it, or after 3 minutes with still no receipt flags it (attention until resolved). **Read in full and not a proof of this sale**: never delivered, never booked, never counted as unconfirmed. Contradicted (`unpaid`) KEEPS a `contradicted` entry until an operator resolves it. A receipt that names ANOTHER PRODUCT than the slug's has a verdict of its own: the slug stops at once (503 `rate_under_review` before the handler; the word names both ids, `product id differs: configured X, receipt Y`; never a route-wide fault), the buyer is answered 409 `settled_for_another_product` and the gross is written as owed (wire `referral`: the money did reach this merchant), and it ends when the configured id matches or an operator clears it (`clear-short`). Any other shape (no payout to our wallet, another buyer or gross, no event or one of another shape, a transaction sent to another contract) is held in doubt as `unproven` for the operator, with a reason of its own on the word. **An unproven success that moved money is owed back and never closed by itself**: the receipt shows the buyer's own transfer into the split contract, so the gross is written as owed at once (`oweUnproven`: wire `referral-operator`, proven by that transfer under the payment's nonce; no sale is booked; once), the buyer is answered 409 `settlement_unproven_refund_owed`, and the entry STAYS open (in doubt, `debtAt`) until an operator resolves it; the sweep finds the same for an in-doubt entry whose receipt it reads that way. Such entries hold no payer of their own; once they stand from three payers the route holds and stays held: a payer that has never paid here is not a probe, only a payer with a paid sale on the books probes, and the hold ends on a receipt-proven sale or by the operator. An unconfirmed entry whose receipt then reads this way becomes `unproven` too, never the route-wide flag. A definite refusal of a payment never in doubt answers 402 with its reason. **Our own fault** is only the facilitator refusing this server's signature (a 401, the documented merchant-signature reason) or a request this server could not sign: after `REFERRAL_OWN_FAULT_MAX` in a row every paid call is answered 503 before the handler for `REFERRAL_OWN_FAULT_COOLDOWN_MS`, then ONE call at a time probes until the facilitator accepts a request; a 400, a lookup the facilitator could not make and a contradicted success never count, so no buyer can close the route. Anything else (no answer, a 5xx, an intermediary's 4xx, no transaction, pending, another payer named, any "already used" refusal) is decided by the chain (`chainVerdict`): the AuthorizationUsed log is searched page by page from `fromBlock` to the head over the configured Base RPCs then public ones; paid (the rule above) is delivered and booked; a cancel, or a transaction that used the nonce without routing it to us, is `unpaid` (never delivered, never booked, the entry closed, counted in the payer's lane, 402 `authorization_used_unpaid`); a spent nonce whose log is not found is unknown while the authorization lives, and closed as not paid once it has expired AND a complete search from the recorded head found neither log. **A spent nonce whose transaction WAS found** and whose receipt, read in full, is not a shape the rule recognizes is counted by the sweep; once the authorization can no longer be sent and it has been read so `REFERRAL_UNRECOGNIZED_READS` times, the entry is closed to an operator record (`closedUnrecognized`: the transaction, an error line, the word at attention for a day), with no sale booked and no refund written; a receipt that cannot be read is never counted, and one that proves the payment is booked the moment it is read. **A receipt whose routed event names OUR merchant id is never counted or closed** (`routedToUs`: a payout address or an amount that differs from this server's settings): the entry stays open, the word reads attention, and an operator's `refund` works on it. **The operator's proof** for `refund` is the full rule or, where the rule does not recognize what the contract did (an event of another shape, a payout address that differs), a receipt read in full that shows this authorization's own transfer of the amount into the split contract: proof the buyer paid, which is what a refund needs, not proof this merchant was paid, so no sale is booked. Such a row is written on the wire `referral-operator`, which the refund run proves by that same transfer (`src/payment-verify.js`); a payment routed to another merchant, or a receipt that cannot be read, is refused. A second `refund` on the same entry writes no second debt and no second hand record. A close is recoverable: `{"action":"reopen","key","note"}` puts a `closedUnrecognized` record back as an open entry that is never closed by itself again (`noAutoClose`), where the three outcomes work. An entry that was ever in doubt otherwise stays until the chain settles it or an operator resolves it by hand (`POST /__operator/referral.json {"action":"resolve","key","note","outcome"}`): `refund` writes the refund debt through the automatic path's own writer (behind the receipt proof read then, never with the delivered mark, at the gross, once) and leaves the `refund-owed` mark, and with no proof writes nothing and leaves the entry; `delivered` and `dismissed` write none and remove it; a `charged-undelivered` entry needs the outcome named, any other reads `dismissed` without one; each is recorded with the outcome, the note and whether a debt was written. **A rate above the commission map** (the contract takes more than `REFERRAL_COMMISSION_BPS` holds): the call is paid, the answer delivered, the sale booked at the amount received; no unconfirmed slot, no hold on the payer, no 402. The gate records it per slug in the book (`short`, once per transaction) and the word reads attention from the first such sale with a reason naming the slug and both amounts (`expected at least X, received Y`), until the map admits the amount (a restart with the corrected map; the sweep then drops the record) or an operator clears it (`{"action":"clear-short","slug","note"}`, recorded). The record is written whenever the net becomes known, whatever the ledger correction returns. **The stop.** A sale under the slug's STOP floor (the share of the price `REFERRAL_MIN_NET_BPS` sets for it; unset, for a model-backed tool the share of the price its upstream cost is kept within, read from `MARGIN` in `src/tools/llm-gateway-kit.js` and passed to the gate as `modelNetFloorBps`, 7000 bps today, and for any other tool half the expected net) counts toward the slug's stop: ONE such sale for a tool the catalog marks `modelBacked`, `REFERRAL_SHORT_NET_MAX` for any other; then 503 `rate_under_review` at admission (before the claim and `/verify`), again once the claim is held and again before the handler starts, nothing charged, other slugs served. It holds from the moment the short sale is seen (this process's own count runs ahead of the book's write; a slug held by that count alone still reads attention with a reason, and `clear-short` clears it) and ends when the last amount is no longer under the floor as the maps stand (a map corrected even in part) or an operator clears it. **A reservation**: until one sale on a slug has arrived at or above its floor in this process, no more calls are in flight on it than its bound (one, or three), so a burst is not all served under the floor before the first receipt is read; **Before a model-backed slug is listed on the network, one purchase is made on it from our own wallet, so the slug is proven before the first outside buyer arrives**; the record survives deploys and has no age (it ends only with a changed setting, the slug's own stop or `clear-short`). "Proven" survives a restart: the book keeps one small record per slug (`proven`, at most 500) with a fingerprint of what the proof was judged against (the slug's commission and the fee, its stop floor, its product id, the merchant id, the pay-to contract and the payout wallet), so a process that starts with the same settings reads the slug as warm, any change to one of them makes it cold again, and so do the slug's own stop and an operator's `clear-short` (a build that does not know the field ignores it and writes the document back without it: the slugs are cold once); the place is taken only once `/verify` has accepted the payment and is given back when that call ends, however it ends (a settle refused or in doubt, a handler error, a timeout, a hang-up), so a payment that verifies and then fails holds a cold slug for its own run only, at the cost of one handler run, bounded per payer by the unsettled-run lane (a credential that does not verify never holds a cold slug), and a payer with a paid sale on the books (a paying rail, or this gate's own rail: `payerHasPrivateRailSale`) is not held to it; a slug proven earlier in the process whose on-chain rate then rises can still serve the calls already running when the first short receipt is read (at most `REFERRAL_MAX_INFLIGHT` less one), since a run that has started cannot be recalled. **The hold for a book that is wrong** (`bookFault`): while an entry is `contradicted`, or `unconfirmed` and flagged, a NEW payment is answered 503 `settlement_under_review` after the local checks and before the screen, the claim, `/verify` and the handler (nothing run, nothing charged; a re-send of a payment already run is answered as always). Scope: **the entry's own payer only** for every contradicted settle success (routed to another merchant, a reverted or another transaction, an answer that went out on a success the chain later denies, an entry with no scope recorded): an authorization names the split contract and no merchant, so its signer can present it elsewhere, cancel it or spend it, and nothing a payment can produce may close the route for others. The route also holds once contradicted successes that MOVED money (the buyer's transfer reached the contract and was routed elsewhere: a wrong merchant id setting looks like this) stand open from `REFERRAL_CONTRADICTED_PAYERS` (3) distinct payers inside one unsettled-run window with NO settle proven paid since; one payer with any number of payments never reaches it, and one that moved no money never counts. **That hold probes and heals itself** (`routeGate`): ONE payment at a time goes through as the probe; a probe whose receipt proves paid ends the hold (contradictions are counted only since the last proven sale, so the open entries stop counting); a probe contradicted again keeps it and starts `REFERRAL_OWN_FAULT_COOLDOWN_MS` before a payer that has never paid here may probe again, while a payer with a paid sale on the books probes at any time. A wrong setting therefore charges about one new buyer a cool-down, not every buyer; an outside party must itself be every probe to keep the route closed (one contradicted payment a cool-down, and it still cannot keep out a returning buyer, whose probe reopens the route). It also ends when the entries resolve. **Every payer** otherwise only for two facts no payment can cause: an unconfirmed entry flagged because the receipt of a transaction the facilitator called successful still cannot be read or recognized after 3 minutes (the buyer signs an authorization and nothing else; the cause is this server's settings or chain reads, or the contract's event shape), and a payment already BOOKED on a proving receipt whose receipt no longer proves it (`scope: "route"`, written by the debt writer; only the chain or its readers changing their answer for one hash does that). It ends when the entry resolves (the sweep confirms it, or an operator resolves it).
  **Kept answers and refunds.** A tool's answer is kept for a re-send for `IDEM_TTL_MS` (10 minutes, the privacy page's bound for a paid answer kept against its payment), never past `validBefore` plus 15 minutes, in memory and at rest alike (`src/referral-answers.js`: one FILE each on this process's disk, never a database row, since the nightly backup copies those; the directory name is one the file backup leaves out; at most 256 KB each and 32 MB in all; dropped on delivery, refusal, an unpaid or expired outcome; a restart loses them, one replica serves the route). A re-send of the same PAYMENT-SIGNATURE never runs the handler again: proven paid returns the answer with its transaction and books the sale once; unused and still valid makes one more settle attempt (at most two after the first); expired unused answers 402 `authorization_expired_unused`. **The delivered mark** is written to the book before any answer byte goes out; an entry that carries it is never read as undelivered, and a closing write that fails is retried and then left to the sweep (which closes it, never refunds it). **How much went out.** One `res.end` of the whole body reads as finished whatever the buyer read (measured: 5 MB to a client that read nothing and reset ends `writableFinished`), so the body goes out in 16 KB pieces (`REFERRAL_SEND_CHUNK_BYTES`, `sendCounted`), the next only once the last one's write callback confirms the socket took it; the pump is not awaited, so a slow reader never holds a run slot. **Nothing may sit between that send and the socket**: `compression()` leaves `/ref/` alone while the gate is mounted (a compressor drops the write callback; a new response-wrapping middleware mounted before the gate needs the same exemption). **Bounded**: a piece not confirmed within `REFERRAL_SEND_IDLE_MS`, or a send still going after `REFERRAL_SEND_MAX_MS`, is ended by destroying the response and read by the bytes rule, so a dropped callback or a reader that stopped never waits forever. **One send in flight per payment**: a re-send meanwhile is answered 409 `inflight`. The delivered mark carries `sendingUntil` (the send's bound plus a margin): the sweep, the unconfirmed check and the debt writer leave an entry alone until its send has ended or that time has passed. At the close (`sentOutcome`): every byte confirmed is delivered; nothing handed to the socket is not served (the mark is taken back, the answer kept for a re-send, the gross owed back if it is never delivered); anything between is **partly served** (the buyer may hold most of it: the mark is taken back, the answer stays for a re-send, and the entry is marked `partial` with the bytes handed over, the most the buyer can hold). A piece in flight can reach the buyer before its confirmation (measured: a client had read about 64 KB more than was confirmed), which is why the bound is the bytes handed over; and an answer the kernel takes whole reads delivered whatever the client read (measured on loopback: up to about 2 MB unread), where the kept answer still serves a re-send. **A refund debt** is written only when all hold at that moment: the entry is `charged-undelivered` without the delivered mark; no answer is still deliverable; the receipt proves, read again, that the payment was routed to us (unreadable waits, contradicted is flagged); and no row stands for that transaction and payer on this wire. The row (`src/refund-ledger.js`) is at the GROSS amount, wire `referral`, network `eip155:8453`, with the fields a direct hang-up debt carries (`httpStatus` 499 and `hangupReason`: a hang-up past a spent forgiveness budget is held by the refund run's repeat hang-up rule, as on the direct routes; a `partial` entry's debt carries `REFERRAL_PARTIAL_HOLD_REASON`, one of the reasons that run holds, with the byte counts in its note, so it is never repaid without a review), so `refundsOwed` pages and `scripts/refund-run.js` repays it once `src/payment-verify.js` proves the same receipt rule (`refund.yml` passes `REFERRAL_PAY_TO`, `REFERRAL_MERCHANT_ID`, `REFERRAL_PAYOUT_ADDRESS` from repository variables). The refund run's per-refund cap is below the price of the dearest tools: such a debt waits for a run with a raised cap. The entry becomes a `refund-owed` mark until the authorization expires, so a re-send is told 409 `answer_unavailable_refund_owed` and nothing runs twice.
  **The book.** State document `referral-settlements` (a database row, else a file); one payer holds at most `PER_PAYER_MAX` open entries (its own share: refused past it, other payers served); at capacity the oldest in-doubt entry whose authorization has expired is retired to an operator record (`retiredAtCapacity`, error line, the status word reads attention for a day), and a charged, owed or still-sendable entry is never retired; an entry whose receipt is not recognized is closed to its sibling record (`closedUnrecognized`, above). A leased sweep (`referral-settle-sweep`) reads the open entries, least recently read first, a bounded number a pass (`.claude/rules/ops.md`). Operator view: `/__operator/referral.json` (the word's reasons, counters, open settlements, hand resolutions, both closed records; never an answer or a signed payment). **Status word** `referralSettlement` on `/api/gateway-status` (only while mounted; `ok` / `attention`): attention while an entry is in doubt, charged and undelivered, unconfirmed or an intent past 15 minutes; a contradicted or flagged entry is open; our own signature was refused in the last 15 minutes; `/verify` or `/settle` left two or more calls in a row unanswered, the first 10 minutes ago or more; an intent could not be stored in the last 15 minutes; the book is full; an open entry's receipt was routed to this merchant and is not accepted by the rule; a slug's sales arrive under the map's expected net; contradicted successes stand from three or more payers; or an entry was retired at capacity or closed as unrecognized in the last day. The status Worker and `heartbeat.yml` page on attention under one issue that ok closes.
  **Booking and isolation.** One sale per settled authorization on the rail `referral`, at the net amount (the merchant amount the proving receipt shows; a success booked before its receipt can be read is booked at the computed gross less the slug's commission and the fee, and CORRECTED at confirmation: `amendPrivateRailSaleNet` updates that payer's one row under the transaction in place, private rails only, never above its quoted gross, so no reader sees two rows and two payments settled in one transaction never rewrite each other; ONE PAYMENT, ONE ROW: each booked payment leaves a mark in the book (`sold`, by authorization key, kept an hour, at most 2000), which outlives its entry and the process; the rows the ledger holds for a payer and slug under a transaction (`privateRailSaleCount`) are weighed against the other payments of that payer marked there, so two payments of one payer in one transaction are two rows, across a restart too; a correction names its payment's gross as well (`quote_usd`), so it never rewrites a sibling row. ONE PAYMENT, ONE REFUND ROW: a referral refund row's evidence is the transaction and the authorization's nonce (`referralRefundEvidence`, `<tx>#<nonce>`; `src/payment-verify.js` reads the pair and proves that nonce), so two refunds in one transaction are two rows; the gross is `quote_usd`), only with the transaction that paid. `referral` is a private rail (`src/paid-rails.js`): never in `PAYING_RAILS`, returned by no public reader of the sales table (every SELECT there names its rails; the suite reads them), shown to the buyer's own receipts and usage at the gross. Not counted by `recordServedCall`, the tool-call log or the failure monitor; the PostHog `tool_call` event carries `rail: referral`. A run is marked for the settle breaker's other lane (`settleBreakerOtherLane`). **The service-wide rule on the run slots**: while `REFERRAL_UNSETTLED_GLOBAL_MAX` distinct payers have unsettled runs in the window, the word reads attention and payers with no paid sale on the books share a quarter of the run slots (`REFERRAL_MAX_INFLIGHT` / 4, at least one; 6 of 24 by default; past it a new payer is answered 503 `busy` at once, nothing run), so a stream of payments that run a tool and do not settle cannot take every slot; a payer with a paid sale (a paying rail, or this gate's rail) is never refused by it. **The lane** mirrors the direct settle breaker on the gate's own counts: unsettled outcomes (a settle refused for the payment, a nonce spent without paying, a settle in doubt until proven paid; NOT a run that ended at this route's own deadline) per signed payer refuse it at `REFERRAL_UNSETTLED_MAX` when they are over half its outcomes, or at `REFERRAL_UNSETTLED_HARD_MAX` whatever it settled; with `REFERRAL_UNSETTLED_GLOBAL_MAX` distinct failing payers a never-paid wallet (no settled outcome, no paid sale) is held at one; a client address (an IPv6 /64 as one) is counted at 4 x the payer's figures (`REFERRAL_ADDRESS_FACTOR`) and refuses only a payer with an unsettled outcome of its own; Retry-After is when the oldest unsettled outcome leaves the window. A settled call earns its client address the paid-quote trust window (`scripts/test-referral-gate.js`).
  **What a buyer is told.** Every answer says what is known of the payment, never more. A debt recorded for the buyer answers 409 with `transaction` and `refundStatusUrl` (the free lookup, `GET /api/refunds?tx=`), in the words "recorded as owed to the paying wallet ... repaid on Base after the payment is reviewed" (never an unconditional "will be repaid": hang-up and partial debts are held by the refund run). A refund row is keyed `<tx>#<authorization nonce>` (`referralRefundEvidence`), one per payment, and a row keyed by the transaction alone covers the same payer's keyed row and the reverse (`referralRefundWriter`: one payable row a payment); the automatic unproven refund and the operator's refund of a payment routed elsewhere carry status 499 and the reason the refund run holds, and a note that says "held for review": the refund run lists such rows in their own bucket with why, and releases them only by the refund workflow's `include_review_holds` input (`REFUND_INCLUDE_REVIEW_HOLDS=true`; the repeat hang-up switch does not); every reader of the evidence key takes that shape: the lookup lists every refund of a transaction and leads with the one furthest from repaid (`refundsByTransaction`, `src/refund-lookup.js`), the refund run's proof reads the nonce (`src/payment-verify.js`), its memo and the payer's own listing name the transaction (`evidenceTx`). A settle success whose receipt shows the buyer's transfer routed to ANOTHER merchant answers 409 `settled_to_another_merchant` with the transaction (settled elsewhere, not received here, nothing delivered; never "sign a new authorization"), is kept as contradicted, and an operator's `refund` on that kept entry records the debt on the wire `referral-operator` with the reason (the first `refund` on an entry not yet contradicted writes nothing and flags it). A settle the facilitator refuses is its word only: with the chain reading the authorization unused the entry is kept as `refused` (it pages nobody, holds nobody, does not count toward the payer's share, counts as room, and is the first dropped at capacity; a dropped one leaves a small record, `droppedRefused`, at most 2000 of them, that the sweep reads until a verdict, so a payment that lands late is written back as charged and undelivered. The sweep reads at most 25 records a pass (1,500 an hour), earliest expiry first (among records already expired, the least recently read first), and no read starts after the pass's one wall budget for all its chain reads (`SWEEP_CHAIN_BUDGET_MS`, 40 s: entries charged already are handed on before any read, then in-doubt and intent entries are read with a fifth of the pass's reads kept for refused ones, then dropped records, which keep the last fifth of the budget and of which at least one is read every pass). A record is forgotten on a verdict (spent without paying us, expired unused, or spent with nothing found by a complete search after expiry); a read that reaches none keeps it, and it is given up only when BOTH 5 reads after its expiry reached no verdict AND 6 hours have passed since that expiry: then one log line names it (slug, short payer, nonce prefix, amount), it is counted (`unresolved`, as is an expired record pushed out at the cap), and a notice is recorded that raises the status word for a day, until an operator acknowledges it (`acknowledge` "dropped"); a record pushed out before its expiry is logged, counted (`evictedEarly`) and raises the same notice) until the sweep reads it expired unused (closed) or finds the payment (then charged, undelivered: delivered on a re-send, else owed back); while the chain cannot be read it is in doubt. A payment proven paid always has an entry: `markPaid` writes one again where it was closed. The buyer text is "no charge is recorded; if one lands it is owed".
  **An empty request** (no query; no body or `{}`) runs the tool's published example at the example's price: the 402 for it carries `emptyRequest: { note, input }`, a field of this server's own beside `accepts` and `extensions` (the network's readiness check reads `accepts[0]` and the echoed token, both unchanged).
  **No pointer home, and price parity (boot checks, `referralIneligibility`).** A slug is refused at boot, with the reason logged, when its published example, example output or input schema text names this server's host (`namesOwnHost`; the base URL's host and the canonical one), since an empty request runs that example and a refused input quotes it; and when the public route gives the same call for less than its listed price by a path `/ref` lacks (`referralCheaperDirect`, server.js): proof of work or the trial parameter (the pure-CPU set, `isComputePayable`), or the first-call allowance while it is on (`allowanceRouteRefusal`). No slug is exempt by default; an operator may name some in `REFERRAL_PARITY_GRANDFATHERED` (each is then served and named in a warning at every boot). A LISTED slug that is not served, for any boot reason, is a reason on the status word for as long as it is listed (its `/ref` route is a 404 for every buyer sent to it). Refusal bodies drop every field whose text names this host or one of its paths (`scrub`: the expected-input descriptions, an example), and the unpaid-quote 429 on `/ref` names no page; the suite walks every served slug's 402, unpaid and paid invalid input for such a pointer. The refund lookup URL in an owed-back answer is the one exception.
  **Two processes on one book.** An answer is delivered or owed back, never both, and the store decides: the delivered mark is a conditional write that refuses an entry already recorded as owed (`resolve(..., { unless })`), and a debt is CLAIMED on the entry as the store has it (`debtPendingAt`, 60 s) before its row is written, refused for an entry that is delivered, sending or in a request's hands (`inCallUntil`, set when a request records the charge). The sweep leaves such entries to their request. An entry that keeps the delivered mark past its send bound in a process that did not send it (the sender ended first) gets a debt at the gross with the reason the refund run holds for review (`oweUnconfirmedSend`), behind the receipt, once; where this process sent it, it is closed as served.
  **The store.** Book changes queue per process and the ones waiting are written together (one read, one write; compare-and-swap arbitrates between processes only). An intent write is given up at `REFERRAL_STORE_WRITE_MS` (3 s): 503, nothing settled. THE STORE RULE (`storeHold`, `src/referral-gate.js`), one rule: (1) a sliding window (`REFERRAL_STORE_WINDOW_MS`, 5 minutes) holds the failures of intent writes, a failure being a write the store refused or one that missed its deadline (a late write that later stands is still late), counted once per write however many intents it carried; (2) two or more failures in the window hold paid calls, 503 `settlement_store_down` BEFORE anything is claimed or run, whatever was stored in between: a stored intent erases nothing, failures leave only by aging out; (3) one failure alone is followed at once by one small write, and when that stands nobody is held; (4) a hold lasts its cool-down (`REFERRAL_STORE_COOLDOWN_MS`, 15 s) and ends only when the cool-down has passed AND a probe stands (one small write, or two in a row while the window still holds two or more failures, so a store that takes every other write does not pass it); a failed probe starts the hold again; each hold entered while the window holds two or more failures doubles the cool-down, up to `REFERRAL_STORE_COOLDOWN_MAX_MS` (10 minutes), and it is the default again once the window holds no failure and no hold is active (a later incident never starts from where an earlier one ended); (5) the word reads attention while a hold is active, while the window holds two or more failures, and while it holds any late write; one refused write the store recovers from stays ok; (6) a full book or the payer's own share refusing an intent is not a store failure; the sweep makes the probe too, so a hold ends with no traffic; there is no timer. A store that refuses every other write gives away two tool runs per window.
  **Service-wide unsettled runs, the cost.** Payers whose runs do not settle are counted for 15 minutes; `REFERRAL_UNSETTLED_GLOBAL_MAX` (12) of them raise attention ("unsettled runs came from N payers ...") and limit payers with no paid sale to a quarter of the run slots. Each such payer's run is one unpaid tool run, so the rule is reached only by that many of them in a window; a payer with a paid sale is never refused by it.
- **Listing icon:** every 402 names `${BASE_URL}/favicon.png` (`BAZAAR_ICON_PATH`); a build before it has no such route, so a rollback serves the icon as a 404 until a build that has it deploys again: an icon fault is fixed forward.
