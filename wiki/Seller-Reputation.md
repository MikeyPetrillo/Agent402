# Seller Reputation

Agent402 publishes a reputation record for each outside x402 seller in its
index. Every figure in it is a measurement this server made itself: its crawl
of the seller's documents, its unpaid probe of the seller's paywall, its live
read of each route's 402, and the router's own paid calls to the seller.

| Surface | What it returns |
|---|---|
| `GET /api/reputation?seller=<host>` | The seller's record and one row per route (up to 200, with `returned`, `matched`, `complete` and `truncated`). Free, cached for five minutes. |
| `GET /api/index?seller=<host>` | The same record as `reputation`, and a compact `reputation` on each route row (`toolReputationLegend` states the method once). |
| The seller card on a chain page (`/base?seller=<host>`) | One line: each metric as a percentage with its sample size, or "not enough data". |

## Metrics

Every metric carries `status` (`scored` or `not-enough-data`), `score` (0 to
1, only when scored), `sampleSize`, `minSampleSize`, `windowDays` (30),
`lastMeasuredAt` and `method`. A metric is scored only when its sample in the
window reaches the minimum; below it the record says `not-enough-data` and
shows the sample it has, so a new or quiet seller is never given a number a
handful of readings cannot support.

| Metric | Sample | Minimum | Score |
|---|---|---|---|
| `manifestUptime` | The seller's newest crawl, recorded once per hourly pass when newer than the last one recorded | 10 | Share of crawls where the seller's own documents answered with routes |
| `paywallUptime` | The newest unpaid probe of the seller's cheapest paid route | 5 | Share of probes answered with a 402 |
| `responsiveness` | The time from that probe to the seller's response headers, measured from this server | 5 | Share answered within 2,000 ms, beside `medianMs` |
| `priceHonesty` | Routes whose 402 we read live in the window and whose own documents list a price | 3 | Share where the price the 402 asks is within 1% of the listed price |
| `delivery` | The router's own paid calls to the seller for requests that are not ours | 5 | Share that settled and answered 200 |

`overall` is the weighted mean of the scored components (paywall uptime 0.3,
delivery 0.25, manifest uptime 0.2, price honesty 0.15, responsiveness 0.1),
the weights renormalized over the components that are scored. It is published
only when both uptime metrics are scored. `age` gives when the record first saw
the seller and `recordsSince`, the date the record began.

## What is left out

- **Our side of a read.** A crawl that failed on our side (our time limit, our
  resolver, our size limit), a robots.txt exclusion, a registry-only record
  with no read of the origin, and a probe that read no status or answered our
  malformed request (400, 415, 422) are not counted for or against the seller.
- **Payments and buyers.** No metric reads a payment count, a buyer count or a
  settlement total. Router purchases, our own wallets and test traffic are
  never buyer evidence, and a seller's own settlement figures are not part of
  the record. The router's paid calls count only as delivery observations.
- **Our own traffic.** A routed call made for a heartbeat probe, a canary or
  one of our own wallets is not recorded. Recording and the scheduled pass run
  only on a server that runs the production crawl; a CI, test or local boot
  records nothing.
- **A caller's input.** A delivery failure is what the router records as a
  strike: a 5xx after payment, or a 4xx the seller or the chain shows was
  charged. A caller's own input error is not a strike, and one payer's repeated
  request counts as the memo counts it.

## How it is computed

A scheduled pass (hourly, under a lease so one replica runs it) walks the index
once, folds each seller's newest crawl, paywall probe and price reading into a
compact per-day record, and stores the whole record as one state document.
Each replica reads that document; a lookup reads one seller's record, never the
index. Delivery outcomes are kept per process and folded into their own
document every minute. Records keep 30 days and at most 8,000 sellers.

Settings: `SELLER_REPUTATION=off` turns it off; `SELLER_REPUTATION_INTERVAL_MS`
(default one hour) and `SELLER_REPUTATION_FIRST_MS` (default ten minutes) set
the pass; `SELLER_REPUTATION_MAX_SELLERS` (8,000) and
`SELLER_REPUTATION_MAX_DELIVERY_ORIGINS` (4,000) bound the stores.

See also: [[x402 Index and Router|x402-Index-and-Router]].
