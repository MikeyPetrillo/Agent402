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
  `/__operator/tool-failures.json`.
- **Settle-failure breakers:** `src/gateway-settle-breaker.js` (per wallet and global on `/v1`,
  per wallet on other wallet-only tools). A wallet is refused only when it holds
  `GATEWAY_SETTLE_BREAKER_MAX` failures in the window AND they are more than
  `GATEWAY_SETTLE_BREAKER_MIN_FAIL_SHARE` (default 0.5) of its outcomes there; settled calls
  stay in the window as outcomes and never erase failures, so a buyer settling hundreds of
  calls is not cut off by a few replayed authorizations, whatever order the fast reverts and
  slower settlements land in; `GATEWAY_SETTLE_BREAKER_HARD_MAX` (default 40) failures refuse
  a wallet whatever it settled, the bound on unpaid handler runs. The `/v1` global pause counts distinct buyers, not
  failures. Only a refusal whose offer the next 402 withdraws (`isWithdrawnSubcentRefusal`)
  stays off the buyer's count, and it still feeds the `/v1` global pause, each one counted on
  its own; every other facilitator billing refusal (`src/payment-reject.js`) counts in both
  breakers and the composite guard, with a 429 that names it instead of the wallet.
  The composite guard (`src/composite-spend-guard.js`) reads its window the same way: a settled
  run stays as an outcome and never erases failures; a payer is blocked at
  `COMPOSITE_GUARD_MAX_FAILS` only while failures are more than `COMPOSITE_GUARD_MIN_FAIL_SHARE`
  (default 0.5) of its outcomes, and at `COMPOSITE_GUARD_HARD_MAX` (default 10) whatever it settled.
- **Replay guard:** `src/replay-guard.js` claims a payment credential (x402 nonce, Tempo, Stripe)
  in Redis while its call runs; the claim is renewed every 30 s until settle or release, so a
  route that outlives the claim's expiry cannot run twice on one payment. With Redis configured
  but unreachable, a paid call is refused 503 with `Retry-After` before any payment is taken (x402
  dispatcher, Tempo gate and card gate, each through `sharedClaimRequired`) on a long-running or
  composite route (`isLongRunningSlug`), and on any route while another container may be serving
  (`src/replay-topology.js`: more than one replica configured, inside `DEPLOY_OVERLAP_SECONDS` of
  listen, default 120, anchored by `markListening` from the listen callback, else import time, or
  draining, read from `drainSignal()`); a lone container past that window serves fast routes on a
  per-process claim, so a store outage does not stop sales. A settled 200's consumed mark keeps the
  guard's default hold; only a grant that was not settled (`grantedUnsettled` in
  `src/hangup-settlement.js`: a forgiven hang-up, a first-call allowance) is held to the
  authorization's own `validBefore` plus a margin, since that authorization is still live on chain
  (`scripts/test-replay-consumed-hold.js`, on Redis).
- **Per-chain price floors:** `src/network-floors.js`. Every accept is priced through
  `priceForNetwork` (`src/payments.js`: list or per-request quote, plus the chain's
  `NETWORK_PRICE_PREMIUMS` premium, raised to its floor). eip155:4663 has a static floor
  (`ROBINHOOD_MIN_PRICE_USD`, "0" off; `NETWORK_PRICE_FLOORS` for others) because its settlement
  can run through our own relayer; it is static so the paid retry re-derives the same amount.
  A floored network, or one with a premium above zero, is never offered `upto` (the boot gate refuses it). /api/pricing (`minPriceUsdByNetwork`), llms-full.txt,
  the chain page and the guides read the same floor; `payment.premiumUsdByNetwork` there publishes
  each chain's premium, and llms.txt, openapi and MCP `payment.info` read the same map. Sales, hang-up debts and charged-failure
  debts on an x402 settle book what the buyer paid on that chain (`src/paid-price.js`: the
  amount signed on an EVM rail, else the gated price through `priceForNetwork`), so revenue
  reads the premium and the floor and a refund repays what was paid.
- **Solana funding refusals:** `src/svm-funding-refusal.js` words a Solana verify refused for no USDC
  account or too little USDC (`retry: fund-wallet`, Retry-After `SVM_FUNDING_RETRY_AFTER_S`, default 300)
  and, after `SVM_FUNDING_HOLD_AFTER` (3) such refusals per wallet and source account in
  `SVM_FUNDING_WINDOW_MS` (10 min), answers from a beforeVerify hold lasting the Retry-After, shared
  through shared-limits; a valid verify clears it; `SVM_FUNDING_THROTTLE=off` disables the hold.
- **Algorand sub-cent offer gate:** `src/avm-sponsorship.js` drops the Algorand accept from
  sub-cent 402s while the facilitator cannot sponsor sub-cent settlement (fails open;
  a status row last updated in an earlier UTC month, or with an unreadable `updatedTs`, is
  not evidence; a pause a settle refusal set holds against headroom reads for
  `AVM_SPONSORSHIP_REFUSAL_HOLD_MS`; published on `/api/rails`, the only excuse the canaries
  accept for a missing sub-cent accept; `AVM_SUBCENT_GATE=off`).
- **First-call allowance:** `src/first-call-allowance.js`, off unless `FIRST_CALL_ALLOWANCE=on`: a wallet with no paid sale gets one unsettled first call (x402 EVM exact, a flagship or `FIRST_CALL_ALLOWANCE_SLUGS` route at or under `FIRST_CALL_ALLOWANCE_MAX_USD`), inside `FIRST_CALL_ALLOWANCE_DAILY_USD` and `FIRST_CALL_ALLOWANCE_IP_PER_DAY` claimed on Redis before a balance read bounded by `FIRST_CALL_ALLOWANCE_BALANCE_MS` (default 1000); a call asking for a share link is never granted; the wallet key expires (`FIRST_CALL_ALLOWANCE_WALLET_TTL_DAYS`, default 400; a claim after 30 minutes), the state record does not; an onBeforeSettle `skip` leaves its 200 unsettled and unbooked; figures on `/__operator/refunds.json`, with `returnedPayers` (granted wallets with a later outside paid sale, and within 7 days; one batched ledger read per chunk, cached `FIRST_CALL_ALLOWANCE_RETURNED_CACHE_MS` (default 5 minutes), reported with the switch off). The `firstCallAllowance` word on `/api/gateway-status` (on, spent, unavailable) pages nothing: a store that does not answer grants nothing, so every call is paid as usual.
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
  `src/facilitator-gas.js` reads each listed facilitator's settlement signers (from
  `/supported`) for gas runway every 10 minutes under a lease (`scripts/test-settle-fallback.js`,
  `scripts/test-tool-failure-monitor.js`). There is no extra Solana settle fallback by design: a
  Solana payment names the quoted facilitator's fee payer, and any other facilitator refuses it.
  `FACILITATOR_PUBLIC_INDEX_CHAINS` (`robinhood` is the one known value; unset = none; any other
  value renders nothing and warns at boot) renders the /privacy paragraph (every field the index
  publishes, its per-seller payer pages, permanence, where it is processed), scopes the no-sale
  line to that list, adds the /terms pointer, `payment.dataHandling.publicSettlementIndex` on
  `/.well-known/x402`, a clause on llms.txt's Robinhood line and a row on /robinhood.
  `FACILITATOR_PUBLIC_INDEX_NAME` (display name, escaped), `FACILITATOR_PUBLIC_INDEX_POLICY_URL`
  (linked only as a parsed https URL) and `FACILITATOR_PUBLIC_INDEX_SINCE` (YYYY-MM-DD; /privacy
  and /terms print the later of their own date and it, once reached) are optional. The boot warns
  when robinhood is listed and `ROBINHOOD_FACILITATOR_URL` has no parsable first host, and for an
  invalid URL or date (`publicIndexBootWarnings`); there is no status word for it
  (`src/facilitator-public-index.js`, `scripts/test-public-index-copy.js`). `ROBINHOOD_RELAYER_KEY` (key present = on) adds our own
  settler after the listed ones (`src/robinhood-relayer.js`): our 4663 sales only (token, call and
  treasury fixed), the package's exact EVM facilitator verify and settle, one submission per
  relayer key across replicas under a lease with the nonce read under it, fee and gas caps, a
  balance check before signing, and a hash for any send that may have reached the node so a
  missing receipt stops the chain; its signer joins the gas check (`scripts/test-own-relayer.js`).
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
- **Tempo push refusals:** `src/push-refusal-body.js`: for a push credential the Tempo gate
  restates a 4xx JSON body's not-charged sentence and sets `charged`, `transferClaimed`, `refundOwed`.
- **Algorand network id:** `src/avm-network.js`: the CAIP-2 (32-character) id is what every 402
  carries; the genesis-hash spelling is folded on the paid path (`src/x402-v1-accepts.js`) and read
  as an alias in seller rows and the buyer.
