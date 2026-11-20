# Seller Reputation

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Agent402 publishes a reputation record for each outside x402 seller in its
index. Every figure in it is a measurement this server made itself: its crawl
of the seller's documents, its unpaid probe of the seller's paywall, its live
read of each route's 402, and the router's own paid calls to the seller.

| Surface | What it returns |
|---|---|
| `GET /api/reputation?seller=<host>` | The seller's record and one row per route (up to 200, with `returned`, `matched`, `complete` and `truncated`). Free, cached for five minutes. |
| `POST /api/reputation/recheck?seller=<host>` | Asks for a fresh measurement of the seller. Free; answers `202` with `crawlBy` and `recordBy` (see [Corrections](#corrections)). |
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
| `priceMatchesListing` | Routes whose 402 we read live in the window and whose own documents list a price | 3 | Share where the price the 402 asks is within 1% of the listed price |
| `delivery` | Calls measured from purchases Agent402's router made for buyers (our own probes, canaries and wallets left out) | 5 | Share where the seller answered 200 after taking the payment |

`overall` is the weighted mean of the scored components (paywall uptime 0.3,
delivery 0.25, manifest uptime 0.2, price matches listing 0.15, responsiveness 0.1),
the weights renormalized over the components that are scored. It is published
only when both uptime metrics are scored. `age` gives when the record first saw
the seller and `recordsSince`, the date the record began.

`measurementIssue` lists the days left out of the crawl and paywall metrics
because our own crawl cycle failed broadly on our side that day (see below),
with the status "measurement issue on our side"; it is `null` when there are
none. `lastRecheckedAt` is the newest crawl read after a re-check request, and
`recheck` gives the newest request's time and whether it is `scheduled` or
`measured`.

## What is left out

- **A day our crawl failed broadly on our side.** A day is recorded when one
  crawl cycle shows all of the following: at least half of its reads ended on
  our side (with at least 20 reads in the cycle); counted one vote per operator
  (a registrable domain, however many hosts it runs), at least 10 operators'
  reads ended on our side and they are at least half of the operators read;
  and a control read of our own, of hosts no seller runs, got no answer
  either. That day's crawl, paywall
  and response-time readings are then left out of `manifestUptime`, `paywallUptime`
  and `responsiveness` for every seller. Reads of one operator's hosts that do
  not complete stay in that operator's own record. Each such metric shows
  `excludedSamples` and `excludedReason: "measurement issue on our side"`.
- **Our side of a read.** A crawl that failed on our side (our time limit, our
  resolver, our size limit), a robots.txt exclusion, a registry-only record
  with no read of the origin, and a probe that read no status or answered our
  malformed request (400, 415, 422) are not counted for or against the seller.
- **Payments and buyers.** No metric reads a payment count, a buyer count or a
  settlement total. Router purchases, our own wallets and test traffic are
  never buyer evidence, and a seller's own settlement figures are not part of
  the record. The delivery metric is labeled "measured from purchases
  Agent402's router made for buyers" wherever it appears: it observes the
  seller's answers to those calls, and nothing that qualifies or ranks a
  seller for the router reads it.
- **Our own traffic.** A routed call made for a heartbeat probe, a canary or
  one of our own wallets is not recorded. Recording and the scheduled pass run
  only on a server that runs the production crawl; a CI, test or local boot
  records nothing.
- **A caller's input.** A delivery failure is what the router records as a
  strike: a 5xx after payment, or a 4xx the seller or the chain shows was
  charged. A caller's own input error is not a strike, and one payer's repeated
  request counts as the memo counts it.

## Corrections

A seller that has fixed something, or reads a figure it believes we measured
wrong, can ask for a fresh measurement:

```
curl -X POST "https://agent402.tools/api/reputation/recheck?seller=your-host.example"
```

The call is free and fetches nothing itself. The crawl reads the seller on its
next cycle (about 30 minutes) inside the seller's own per-operator crawl
budget: the read takes one of its operator's places that cycle, never an
extra one, and a Retry-After or daily budget the seller set still applies. The
next hourly pass folds that read into the record, which then shows it under
`lastRecheckedAt`. The answer is `202` with `requestedAt`, `crawlBy`,
`recordBy` and `nextAcceptedAt`. One request per seller is accepted every 6
hours; a repeat inside that span answers the request already scheduled and
changes nothing. Each caller may send 10 requests an hour.

For anything a re-check does not settle, write to mike@agent402.tools with the
seller's host and the metric in question.

## How it is computed

A scheduled pass (hourly, under a lease so one replica runs it) walks the index
once, folds each seller's newest crawl, paywall probe and price reading into a
compact per-day record, and stores the whole record as one state document.
Each replica reads that document; a lookup reads one seller's record, never the
index. Delivery outcomes are kept per process and folded into their own
document every minute. Records keep 30 days and at most 8,000 sellers.

Settings: `SELLER_REPUTATION=off` turns it off; `SELLER_REPUTATION_RECHECK_HOST_MS`
(default six hours) sets the re-check span per seller and
`REPUTATION_RECHECK_PER_IP_HOUR` (10) the per-caller limit; `SELLER_REPUTATION_INTERVAL_MS`
(default one hour) and `SELLER_REPUTATION_FIRST_MS` (default ten minutes) set
the pass; `SELLER_REPUTATION_MAX_SELLERS` (8,000) and
`SELLER_REPUTATION_MAX_DELIVERY_ORIGINS` (4,000) bound the stores.

See also: [[x402 Index and Router|x402-Index-and-Router]].
