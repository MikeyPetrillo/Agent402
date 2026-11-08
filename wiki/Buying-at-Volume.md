# Buying at Volume

An agent that buys hundreds or thousands of calls in a burst, over x402 or MPP, needs four things: a price it can check before it pays, a retry that never pays twice, a ceiling on spend, and limits it can plan around. This page names each mechanism and the file that enforces it. The live figures, rendered from that code, are on the guide: [agent402.tools/guides/buying-at-volume](https://agent402.tools/guides/buying-at-volume).

## Prices

- [`/api/pricing`](https://agent402.tools/api/pricing) lists every route, its list price, the chains it takes (`networks`) and, on a route that runs as a job, its `async` block. Chains with a settlement premium or a price floor are listed under `payment.premiumUsdByNetwork` and `payment.minPriceUsdByNetwork`.
- The 402 is the quote for the request in hand. On the metered model routes it is computed from the body, and the paid retry is priced again from its own body (`acceptsForItem` in `src/payments.js`), so the paid retry carries the body that was quoted.
- Price changes are on the [changelog](https://agent402.tools/changelog). Read `/api/pricing` at the start of each burst.

## Throughput limits

Paid calls are not counted per wallet. Every limit below answers before any payment is taken, and each one sets `Retry-After`.

| What is counted | Default | Source |
|---|---|---|
| Unpaid price checks to priced catalog routes, per client address | 3,000 an hour; an address that settled a payment this hour is not counted for the rest of it | `src/unpaid-quote-budget.js` |
| Unpaid quotes on `/v1/metered`, per client address | 60 a minute, 1,200 an hour (429, `Retry-After: 60`, with a `guide` link); not counted for 10 minutes after each paid call from that address | `METERED_UNPAID_QUOTES_PER_MIN` / `_PER_HOUR` in `src/unpaid-quote-budget.js`, enforced in `src/server.js` |
| Refused payment credentials on `/v1/metered` | the same figures, counted once a credential is refused | `src/server.js` |
| Payments that verified and then failed to settle, per wallet | 3 in 15 minutes while failures are more than half of the wallet's outcomes, or 40 whatever it settled | `src/gateway-settle-breaker.js` |
| Concurrent report and media runs, per wallet | the balance must cover every run in flight plus the new one (429, `Retry-After: 30`) | `src/inflight-cover.js` |
| Jobs per client address | 4 at once (429, `Retry-After: 30`) | `ASYNC_JOBS_PER_CLIENT` in `src/async-jobs.js` |

An IPv6 /64 is one address. A stock x402 client sends one unpaid read and one paid retry per call, and only the unpaid read is counted. Once an address has paid, its quotes are not limited for 10 minutes after each paid call (a final 200 that settled on any rail, or a credits debit; `PAID_QUOTE_TRUST_MINUTES` in `src/paid-quote-trust.js`), so the per-address unpaid-quote limit paces only an address that has not paid yet. A payment credential that is refused still counts.

## Retries that never pay twice

- **`Idempotency-Key`:** the same key with the same credential, route, query and body returns the first 200 (`X-Idempotent-Replay: true`) with no second run and no second settlement; a copy that arrives while the first runs gets 409 `idempotent_request_in_flight` with `Retry-After: 2` (`src/idempotency.js`, store in `src/idempotency-store.js`).
- **Implicit replay on EVM payments:** the signed payment (network, payer, nonce) is the key, so a re-sent payment returns the first answer marked `X-Replayed-Answer: 1`, except on identity-bound routes, routes with a lasting effect and streamed calls.
- **Solana:** no implicit key; send `Idempotency-Key` with the exact payment header that went out the first time.
- On x402 a response of 400 or above is not settled, so a retry after one costs nothing extra. Read `PAYMENT-RESPONSE` on each answer to see whether it settled.

## Slow calls

A route with an `async` block takes `Prefer: respond-async`: 202 and a `Location` job link at once, `GET /api/jobs/{id}` (free) until `status` is `completed` or `failed`, payment settled only on the delivered result (`src/async-jobs.js`, `src/slow-routes.js`). agent402-client and agent402-mcp switch to jobs on their own.

## Spend caps in the packages

| Package | Per call | Across calls | Source |
|---|---|---|---|
| agent402-client | `maxPerCallUsd` | `dailyLimitUsd`, `maxPerHostUsd` (rolling 24 hours, per instance) | `client/index.js` |
| agent402-mcp | `AGENT402_MAX_PER_CALL` (on by default, `off` removes it) | `AGENT402_BUDGET` (whole session, opt-in) | `mcp/index.js` |
| agent402-openclaw | `maxPerCallUsd` or `AGENT402_MAX_PER_CALL_USD` (defaults to the metered per-call cap) | none | `openclaw/index.js` |

Every cap is checked before a payment is signed. All three packages refuse an accept asking for a signing validity longer than a day (`MAX_VALIDITY_SECONDS` in each `known-assets.js`). `AGENT402_NETWORKS` (agent402-mcp) restricts and orders the chains a wallet pays on.

## Rails

| Rail | Settles | When the call fails |
|---|---|---|
| x402 exact, EVM chain | after the tool answers, only under 400 | not charged |
| x402 exact, Solana | after the tool answers, only under 400 | not charged |
| MPP `evm` charge | the same x402 settlement | not charged |
| MPP Tempo pull | broadcast after the tool answers, only under 400 | not charged |
| MPP Tempo push | final before the call runs | booked as a refund owed, repaid after on-chain proof |

The long routes (report products, video, the slow media tiers) take x402 exact on EVM chains only, and Tempo is not offered on identity-bound or long-running routes. A Solana payment embeds a recent blockhash that lives about a minute, so sign each one right before it is sent. A Solana payment refused for a missing or underfunded USDC account answers `retry: "fund-wallet"` with `Retry-After` (`src/svm-funding-refusal.js`).

## Metered chat

- Model ids: `GET /v1/models`. An unlisted id is refused before payment with `suggestions` and a `howToCall` retried with the first.
- Input size: each model's cap is `x402.meteredMaxInputChars` on `/v1/models` (`maxInputCharsFor` in `src/tools/llm-gateway-kit.js`); over it, `input_too_large` before payment, with `suggestions` of models whose window takes it.
- Per-call cap: a body quoting above `METERED_MAX_QUOTE_USD` is refused with a 400 before any upstream call.

## Errors

- 400, 422: input refused; the body carries `howToCall` (method, URL, ready body). Not charged on x402.
- 402: the first-contact body carries the offer, `howToCall` and, on a job route, `async`.
- 409: the same keyed call is still running; resend after `Retry-After`.
- 429, 503: a limit or a busy route; wait `Retry-After`. image-ocr answers 503 `large-image-busy` while it reads another large image.
- 502, 504 with `attribution: "upstream"`: a source the tool reads failed, not the input.

See also: [[Paying with x402]], [[Paying with MPP]], [[LLM Gateway (OpenAI /v1)|LLM-Gateway]], [[Agentic Finance]].
