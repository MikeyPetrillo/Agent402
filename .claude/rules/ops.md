---
paths:
  - "src/state-db.js"
  - "src/json-document.js"
  - "src/backup.js"
  - "src/contained-turn.js"
  - "src/drain-abort.js"
  - "src/tool-failure-monitor.js"
  - "src/answer-shape.js"
  - "src/payment-rail.js"
  - "src/settle-demotion.js"
  - "src/loop-deadline.js"
  - "src/boot-profile.js"
  - "src/sale-path.js"
  - "src/status*.js"
  - "src/seo.js"
  - "src/scorecard.js"
  - "src/top-buyer-failures.js"
  - "src/sql-query-stats.js"
  - "src/tweet-queue.js"
  - "src/x-oauth.js"
  - "services/**"
  - "scripts/*-deploy-paths.js"
  - "scripts/backup-restore.js"
  - ".github/workflows/**"
  - "workers/**"
---

# State, scheduled loops, monitoring and operations

Loaded when a state, loop, monitor, workflow or worker file is read.

- **State database:** `src/state-db.js`: the state database (Postgres, schema `state`): documents, records, log
  lines, leases, imports. `STATE_DATABASE_URL` is the switch (unset: files on the volume as
  before; a merge never cuts over, the variable does). `src/json-document.js`
  is the one API a whole-file JSON store uses (file on the volume without a database, the row with
  one; the file is imported once). Every scheduled loop runs under `leased(name, ...)`, so two
  containers never run the same tick; a store registers its first load with `trackStoreReady` and
  the server awaits `stateStoresReady` before it listens. `/api/gateway-status` reports `stateDb`.
  The live revenue snapshot (`src/revenue-live.js`) reports `revenueLive` (fresh, due, stale,
  cold): a snapshot missing an offered rail rescans at once, a failed scan backs off 30 s, and
  the status Worker pages on stale (`scripts/test-revenue-shared-scan.js`).
- **Large rows:** A statement carrying a large single row (the one-row fallback) runs
  under `largeRowTimeoutMs`: the default limit plus `STATE_DB_MS_PER_MB` (500) per megabyte past the
  first, at most `STATE_DB_LARGE_ROW_MAX_MS` (120000); after a warm-start page times out, the rows
  that page covered are read one at a time, then full pages resume.
- **Store deadlines:** `src/loop-deadline.js` (`withLoopTimeout`, `withLoopDeadline`, `loopDeadline`)
  bounds every Redis wait (shared limits, the hang-up ticket, the spend reserve, journals,
  idempotency, the first-call allowance, the shared Databento read, the cache, the
  database ping, lease release) in loop time: a deadline re-arms once for time the loop was held
  and expires only after a poll phase, so an answer that landed during boot work is read, not
  booked as a store that did not answer (`scripts/test-loop-deadline.js`, `test-loop-deadline-sites.js`).
- **Heap attribution:** `HEAP_SAMPLING=on` (exactly "on"; off by default) starts V8's sampling heap
  profiler at the first import (`src/boot-profile.js`); `/__operator/heap-sampling.json` reports
  live sampled bytes by function and file. A read holds the loop about a second on a large heap
  (concurrent reads share one walk); turn it on for a measurement, then off.
- **Deploy selectors:** the render worker and `decide` redeploy from CI only when the pushed range
  touches their paths (`scripts/worker-deploy-paths.js`, `scripts/decide-deploy-paths.js`: image
  inputs, import closure, and for decide its export row format and kit); an unreadable or capped
  diff, or a check that fails, redeploys.
- **Release queue:** `deploy.yml` runs in two concurrency groups per branch. Pushes, pull requests
  and a dispatch with mode `deploy` or `publish` share `deploy-<ref>`; every other dispatch mode
  shares `deploy-dispatch-<ref>`, so a manual pass neither holds a merge's run nor replaces it
  while it is pending. Nothing on `main` is canceled in progress. GitHub keeps one pending run per
  group: of two merges queued behind a running release only the newer runs, on a tree that
  contains both. On main the markers job reads commit subjects from the head of the last push run
  whose markers job finished (`scripts/marker-base.js`, the job's token has `actions: read`), so a
  replaced push's markers are read by the run that replaced it and by no later one; with no such
  run, the API unreadable, or no answer inside the lookup's one deadline (`MARKER_BASE_DEADLINE_MS`,
  default 40000, also its most; half the job's 2-minute limit), it reads its own pushed range; `MARKER_WORKFLOW_FILE` (default
  `deploy.yml`) names the workflow whose runs it lists (`scripts/test-ci-gating.js` runs the
  step on a three-push sequence and evaluates the group for every mode a job reads).
- **Drain:** in-flight composites are aborted on SIGTERM (`src/drain-abort.js`); drain starts
  immediately (`scripts/test-drain-on-sigterm.js`). An uncaught exception stays fatal, so every
  scheduled turn that reads seller data (the route index drain and shadow rebuild, the crawl timers,
  the surface memo and index snapshot rebuilds) runs under `contained(name, fn)`
  (`src/contained-turn.js`): a throw is counted by name and never escapes, and a listing whose rows
  cannot be read is dropped alone and counted by origin (`containedTurns`, `brokenListings` on
  `/__operator/perf.json`; `scripts/test-crash-containment.js`, `scripts/test-contained-turns-sites.js`
  keeps every timer callback wrapped or allowlisted). The `containedTurns` word on `/api/gateway-status`
  reads `repeating` while one name has thrown in each of the last three or more consecutive minutes
  (a per-name minute ring), or on each of its last three or more runs across three distinct minutes
  with no clean run between (a 30- or 60-minute loop); the heartbeat and the status Worker page on it under one issue.
  The `brokenListings` word reads `widespread` while the distinct origins whose listings broke in a rolling
  15 minutes reach both 20 and 5% of the indexed origins (one seller's bad data never does; a code bug that
  breaks every listing does), paged the same way; both issues close only on the second ok read in a row.
- **Backups:** `src/backup.js` (encrypted, offsite); restore with `scripts/backup-restore.js`.
  The `backup` word reads `unencrypted` while `BACKUP_ENCRYPTION_KEY` is unset in production
  (`NODE_ENV` or the platform's environment name), and `unconfigured` while the `BACKUP_S3_*`
  bucket variables are unset in production with a state database (no backup runs at all); the
  heartbeat and the status probe page on both under "Offsite backup is not current", closed on
  `ok`. Without a bucket, a FREE_MODE boot, a boot outside production and a boot with no state
  database read `off`, which never pages.
- **Status observers:** GitHub heartbeat plus `workers/status-probe`; a failed check is
  re-probed once before it is recorded. The heartbeat signs its paywall read with X-Heartbeat-Token,
  so the unpaid budget never refuses it; the status Worker pages "Paywall not observed" after three
  unobserved runs (the age of the newest paywall row on /api/status) and closes on its next observed
  read. Roll back the server before (or with) the status Worker, never the
  Worker alone: an older Worker reads the unpaid-quote budget's 429 as a paywall failure.
  The Base unproven cap keys are versioned (`base-unproven-seller-v2`, `-v2-sum`): a rolled-back
  build books in its own unversioned window, so for as long as it serves the two builds' caps are
  independent (each seller and the lane can be paid up to one cap per build), and on the next
  roll-forward each sum's next rebuild (within a day) folds in that window's unexpired entries.
- **Every status word has a pager:** each word on `/api/gateway-status` is read by a status Worker
  alarm (`scripts/test-status-word-pagers.js` boots the server and fails on a word no verdict reads;
  none is excused). Paged on their alarm values only, by the Worker and `heartbeat.yml` under one
  title each: `jevSpend` capped (a refusal against the total ceiling today, local or shared; with a
  shared store the word reads the shared day total and a refusal mark held to 00:00 UTC, so a
  fresh process on a capped day reads capped, and unknown, which does neither, until its first
  shared read; the free share alone reads ok; closes on ok), `externalSpendGlobal` refusing (ok, off; near is a
  forecast and does neither), `solanaHistory` and `evmLogs` failing (publics, fallback; idle does
  neither, and reads idle until five recent reads are in, so one failure after a deploy never
  pages), `speechUpstream` cooling (ok, probing: the cool-down ended and the next call tries the
  primary link, so a quiet service does not hold the page open; closes on the second clear read in
  a row, `closeAfterTwoOk`, so a failed probe between cool-downs does not reopen it each cycle),
  `firstCallAllowance` unavailable
  (on, spent: spent is the day's cap working as set; present only while the trial is on),
  `directUpstreamSpend` high and `directUpstreamBalance` exhausted (ok, off; unknown and starting
  do neither; alarms only, see gateway.md; rolling back past them leaves an open issue to close by
  hand), `xSearchAuthors` alert (ok; see the X search author alarm below), `mppSubscriptions` failed (on,
  off: the MPP subscription engine is configured but did not build at boot, including an installed
  mppx with no subscription method; `buildMppSubscriptionsEngine` in `src/mpp-subscriptions.js`;
  `subscriptionRenewals` then reads unknown), `openMeteo` refused (ok, off: a keyed Open-Meteo request was
  refused, by 401, 403 or a 400 whose reason names the key or a plan, in the last 15 minutes;
  `openMeteoStatus` in `src/tools/weather-kit.js`; buyers got an uncharged 503). `coverageReads` pages like `sharedLimits`, on its
  second word only: `alert: sustained` (paid calls started or refused without a balance read made
  for them in 3 or more separate minutes of the last 10, for 3 or more accounts;
  `coverageReadsVerdict` in `src/inflight-cover.js`). `status` ok and off close; `status: degraded`
  alone, which one wallet can cause, opens nothing. Counts are under the operator's `inflightCover`. `loopLag`
  and `mppEvmDomainFallback` publish a flag, not a word, and page nothing.
- **Ended MPP subscriptions:** the private half of a subscription's access key is deleted when a
  cancel is stored or the subscription ends (`finishEnded` in `src/mpp-subscriptions.js`, reached from
  every write that ends one), and the record is reduced to `TOMBSTONE_FIELDS` unless a renewal is in
  flight. The leased sweep `mpp-subscription-ended-sweep` (every `ENDED_SWEEP_INTERVAL_MS`, at most
  `ENDED_SWEEP_MAX_PER_RUN` records changed per run, counts-only log line) closes records whose end
  only the clock decides, finishes ended records, and deletes a reduced record
  `ENDED_RECORD_KEEP_MS` after its end; the three constants live in
  `src/mpp-subscription-retention.js`, which /privacy prints. A new path that ends a subscription
  writes through `writeRecKeepingCancel` or calls `finishEnded`. The paying wallet is screened
  (`screenPayer`: the exact list match, then the one-hop funding check and its cache) before the
  first payment and before each renewal is signed; a refused first payment is the Tempo rail's
  `screen-rejected` 402, a refused renewal is an ending write (`payer-not-accepted`), and with no
  list loaded the payment is sent and counted (`payerScreen` on `/__operator/monitors.json`,
  `sanctionsScreen.mppSubscriptions` on the operator view of `/api/gateway-status`).
- **Subscription sponsor ceiling:** `src/tempo-sponsor-ceiling.js` wraps the RPC transport of both
  Tempo subscription clients (`src/mpp-subscriptions.js`): every raw send carrying a fee-payer
  signature is admitted into a rolling 24 h window (`src/shared-limits.js`, shared across replicas;
  this process's own window decides when the store does not answer) counted by transactions and
  summed by fee bound (gas limit x maxFeePerGas), or refused before it leaves the process.
  `MPP_SUB_SPONSOR_DAILY_MAX_TX` (default 100) and `MPP_SUB_SPONSOR_DAILY_MAX_USD` (default 2); a
  malformed or non-positive value keeps the default. A fifth of each ceiling (`RENEWAL_RESERVE_FRACTION`, 0.2) is held
  for renewals: activations read against the rest, the count rounded down (at
  `MPP_SUB_SPONSOR_DAILY_MAX_TX=1` no activation is sponsored); a send not named a renewal reads as
  an activation. A refusal logs the knob that bounds it, is a
  definite pre-send failure (a renewal goes past_due as with any failed charge, an activation is a
  402) and reads `ceiling=reached` on `subscriptionFeePayer` in `/api/gateway-status`; a send stays
  counted whatever the RPC answers, so the window only over-counts.
  `ceiling=reached` pages (the status Worker and `heartbeat.yml`, one issue "Subscription gas sponsor
  CEILING reached"), and `ok` closes it.
- **Failure monitor:** `src/tool-failure-monitor.js` counts every catalog answer past the gates by slug, class, origin (outside vs our own synthetic traffic) and payment rail (`outcomeRailOf` in `src/payment-rail.js`; a free proof-of-work or trial outcome counts on its own lane, shown in the detail and read by `toolFailures` only when a tool fails nearly every free call: `TOOL_FREE_FAIL_RATE`, default 0.9, over `TOOL_FREE_FAIL_MIN_CALLS`, default 20, in an hour) and every named upstream's fetch outcomes through the egress meter's observer, in five-minute buckets merged across replicas through Redis (`upstreamHealth` counts only the upstream's own failures, `UPSTREAM_FAILURE_KINDS`: 5xx, a transport timeout, a refused or reset connection, a host name that does not resolve (ENOTFOUND, EAI_NONAME, EAI_NODATA); our own deadline (`deadline`: an AbortSignal.timeout of ours, a health check's limit), a lookup our resolver could not finish or a route our side lacks (`egress`) and a caller's cancel (`aborted`) are operator detail only, with one exception: our deadline firing on ONE upstream on at least `UPSTREAM_UNANSWERED_MIN` (default 5) calls from at least `UPSTREAM_UNANSWERED_MIN_CALLERS` (default 3) distinct callers, at least `UPSTREAM_UNANSWERED_RATE` (default 0.5) of its calls, inside `UPSTREAM_UNANSWERED_WINDOW_MS` (default 15 minutes), or on every one of at least `UPSTREAM_UNANSWERED_ALL_HELD_MIN` (default 10) calls in that window whatever the callers (one buyer, or background work alone), while another upstream answered in the same five-minute buckets, reads `upstreamHealth=unanswered` and pages under its own neutral title, "did not answer within our limit"; when more than half the upstreams with traffic are held at once, or none other answered, nothing is named (`ourSide`). A caller is a keyed hash of `req.ip` held in memory (`src/request-timing.js`), never an address; the rule lives in `src/unanswered-rule.js`, and the speech link (`src/tools/tts-kit.js`) and the direct LLM link (`src/gateway-direct-upstream.js`) apply the same thresholds to route the next callers to their backups for an input at or past `HEAVY_INPUT_SHARE` of its cap; on a shorter input our limit passing counts toward their breakers like any other failure, so one caller is moved to the backup by the third); `toolFailures`, `upstreamHealth` and `facilitatorFunds` (also `low` while a facilitator signer is short of gas, and `unknown` while a signer's balance could not be read, which pages nothing until it has held past `FACILITATOR_UNREAD_PAGE_HOURS` (default 6): then the public word carries `alert=sustained` and both pagers open "a settlement signer's balance could not be read for hours", closed when the balance reads again (ok or low); the operator view carries `unreadSince`; a dry Robinhood signer our relayer covers is left out and pages as `robinhoodSettler=relayer` instead, `.claude/rules/payments.md`) are words on `/api/gateway-status`, detail on `/__operator/tool-failures.json`. Every final 200 is also classified by body (`src/answer-shape.js`: ok, empty, error-shaped, unchecked; a tool whose contract allows an empty answer goes in `EMPTY_RESULT_OK` or sets `discovery.emptyOk`) into the `toolAnswers` word; the same detail lists live-data slugs whose sales all returned one response digest. `src/settle-demotion.js` puts Celo's alternates first after consecutive out-of-funds refusals.
- **Top buyer failures:** `src/top-buyer-failures.js` records every verified paid request (past
  every gate and on to the dispatcher: x402 on every rail, the MPP shim, Tempo) whose final
  answer is not a 2xx (the caller's own input refused, 400, 404, 409, 413, 415 or 422, is left out),
  under the payer its gate proved (`verifiedPayerOf` in server.js: the signed
  EVM `from`, the Tempo sender the gate proved, the settle receipt, else the signer of the signed
  Solana, Algorand or Stellar transaction, case kept). Credits and card payments are not watched:
  the ledger books them with no payer, so they cannot rank), with the slug, status, time and the first 160 characters of the error text we sent
  (`redactSecrets`). An unpaid 402 challenge and a refusal before the gate never reach it; our own
  traffic and wallets are left out. Kept in process (at most 2000 payers, 50 failures each) and,
  with Redis, in a per-payer window in the shared store (`top-buyer-fail`), so every container
  reads every container's failures; a payer with nothing inside the window plus the hold is swept
  from the process on the refresh timer. The watched payers are the top `TOP_BUYERS_COUNT` (default 10)
  outside payers by paid spend over `TOP_BUYERS_DAYS` (default 7) from the sales ledger
  (`topExternalPayersAsync`: external rows on money rails, our wallets left out by address), read
  shortly after boot and every `TOP_BUYERS_REFRESH_MS` (default 300000), never on a request's
  path. `topBuyerFailures` on `/api/gateway-status` reads `alert` while a watched payer has
  `TOP_BUYER_FAIL_MIN` (default 3) or more failures inside `TOP_BUYER_FAIL_WINDOW_MS` (default
  600000), held `TOP_BUYER_FAIL_HOLD_MS` (default 1200000) after the failure that met the rule so
  the 5- and 15-minute pagers read it; `ok` otherwise, `unknown` before the first read of the top
  payers, `off` in FREE_MODE. Publicly the word only; the operator view lists per alerting payer
  its short id (`shortPayer`), spend rank and failures (slug, status, time, error text), never a
  full address or a spend figure. The status Worker and `heartbeat.yml` page once on `alert`
  ("topBuyerFailures: a top paying buyer is getting failed answers", fixed text) and close on `ok`.
  An alarm only: nothing is refused for it (`scripts/test-top-buyer-failures.js`,
  `scripts/test-top-buyer-failures-redis.js`).
- **Buyer scorecard:** `src/scorecard.js` serves `GET /api/scorecard` and `/scorecard` from
  `buyerScorecardAsync` (`src/sales-ledger.js`): per UTC month (current to date and six before),
  outside paying wallets, returning wallets (paid in any earlier month), wallets with paid calls on
  2+ days, settled calls and USD by chain. Counted: internal = 0, a paying rail, a recorded paying
  wallet outside every wallet of ours (re-read now). A count of 1 or 2 reads `<3`; a month with
  fewer than 3 wallets publishes that bucket alone; a chain with fewer than 3 wallets folds into
  `other`. Computed shortly after boot and every `SCORECARD_REFRESH_MS` (default 900000, at least
  10000), paged and spread over loop turns, never per request. Sample settlement transactions
  (explorer links, the month's first by ledger id) are public only with `SCORECARD_PUBLISH_TX=on`
  (default off: a buyer's transaction names its payer on chain); the operator view
  (`X-Operator-Token`, private, no-store) always lists them (`scripts/test-scorecard.js`).
- **onchain-sql busy refusals:** onchain-sql refuses a query past `BUYER_QUERY_INFLIGHT_MAX`
  buyer queries in flight on this server (`src/tools/cdp-kit.js`; a 429 with `Retry-After`,
  `hint: "busy"`, shed, never charged) and marks the request scope (`onchainSqlBusy`). When its
  response has ended, server.js counts it per UTC day by caller (`noteSqlBusy`,
  `src/sql-query-stats.js`: `busy.topBuyer` when the proven payer is one of the watched top
  payers then, `busy.other` otherwise, including a call with no proven payer; by lane, outside or
  synthetic; on `/__operator/onchain-sql-queries.json` and `onchainSqlQueries` on
  `/__operator/tool-failures.json`, counts only) and keeps a top payer's refusal among its
  failures with kind `sql-busy`. `onchainSqlBusy` on `/api/gateway-status` reads `alert` while a
  watched payer has one such refusal inside `TOP_BUYER_FAIL_HOLD_MS`, `ok` otherwise, `unknown`
  before the first read of the top payers, `off` in FREE_MODE; publicly the word only, the
  operator view names the short payer, rank and refusal times. The status Worker and
  `heartbeat.yml` page once on `alert` ("onchainSqlBusy: a top paying buyer was told the query
  service is busy", fixed text) and close on `ok`. An alarm only: the cap is unchanged. The test
  preload `scripts/lib/cdp-sql-stub-preload.js` holds a `hold_<id>` query open until the file
  `<id>` exists in `CDP_SQL_STUB_HOLD_DIR` (test only).
- **Per-call count documents:** `src/sql-query-stats.js` (onchain-sql queries per call) and
  `src/x-search-stats.js` (x-search-recent authors and posts per call) keep per-UTC-day
  histograms as state documents (`src/json-document.js`), folded into the document on a timer
  and at shutdown. x-search is counted on a final 200. Every onchain-sql run inside a request
  is counted once its response has ended (`onFinalResponse`, `src/request-timing.js`; a handler
  that outlives its buyer is counted when it returns): the queries it sent (`q0` for a refusal
  before any query, to `q3`) under `charged` (a final 200 with settle evidence, the server's
  `scope.saleOutcome`), `free` (a final 200 nothing was asked for: FREE_MODE, proof-of-work, a
  trial, a first-call allowance) or `uncharged` (a 4xx or 5xx, a 402 after the handler ran, a
  buyer who left, which reads uncharged even when that payment went on to settle), by lane
  (outside, synthetic), with the budget refusals beside them. An unpaid 402 runs no handler and
  is not counted. Read at `/__operator/onchain-sql-queries.json` (operator token; days, totals,
  calls and queries by outcome, `queriesPerChargedCall` for the outside lane; counts only) and
  as `onchainSqlQueries` on `/__operator/tool-failures.json`. A day an earlier build stored
  (final-200 counts with no outcome) reads as charged. A failed count or store write is
  counted (`failures`), logged at most once a UTC day, and never reaches the call. Env:
  `SQL_QUERY_STATS_KEEP_DAYS` (default 121: today and the 120 days before it, as earlier builds
  kept; up to 400; a lower or malformed value keeps the default, so no setting drops a stored day
  an earlier build kept), `SQL_QUERY_STATS_FILE` (default
  `/data/onchain-sql-query-stats.json`), `SQL_QUERY_STATS_FLUSH_MS` (default 60000, at least
  1000), `X_SEARCH_STATS_FILE` (default `/data/x-search-author-stats.json`),
  `X_SEARCH_STATS_FLUSH_MS` (default 60000, at least 1000). The files are used only without a
  state database; `ownStoreEnv` (`scripts/lib/own-stores.js`) points both into a booted test
  server's own directory (`scripts/test-sql-query-stats.js`,
  `scripts/test-onchain-sql-queries-route.js`).
- **Refund debts for named sales:** `POST /__operator/refunds/backfill-sales` (operator token, heavy
  limiter; `src/refund-backfill.js` `backfillNamedSales`) takes `{"txs":[...],"note":"why"}`, at most
  100 settle tx values and a note of 3 to 200 characters. Each tx must match exactly one external
  sale (`salesByTx`, matched as stored); the debt's payer, network, slug, price and wire are that
  ledger row's and nothing else in the body is read. Skipped by name: `no_sale`, `internal_sale`,
  `more_than_one_sale`, `no_payer`, `no_amount`, `repeated_in_request`. Dry unless `?write=1`
  (`wouldMint`, `byPayer`, `owedUsd`); a write is idempotent on the tx. It records only:
  `scripts/refund-run.js` stays the sole payer. The pack backfill (`/__operator/refunds/backfill`)
  is unchanged (`scripts/test-refund-backfill-sales.js`).
- **Search refusals:** `src/discovery-refusals.js` counts every search `/api/find` and `/api/route`
  turn away, per UTC day, by route and rule (`load-gate`, `client-rate`, `client-compute`,
  `shared-compute`, `inflight`, `deadline`) under a keyed, day-scoped digest of the limiter's client
  key (never an address) and a User-Agent family, and marks a refused client that is served a
  search or finishes a paid or free tool call later that day. One state document
  (`discovery-refusals`), folded in on a timer and at shutdown, 8 days kept; at most
  `DISCOVERY_REFUSALS_MAX_CLIENTS` (default 500, at most 5000) clients a day, the smallest folded
  into `other` so totals stay exact. Read at `/__operator/discovery-refusals.json`. Env:
  `DISCOVERY_REFUSALS_FILE` (default `/data/discovery-refusals.json`, used only without a state
  database; `ownStoreEnv` points it into a test server's own directory),
  `DISCOVERY_REFUSALS_FLUSH_MS` (default 300000, at least 1000). The connector's `catalog.find`
  runs under the MCP limiter, not these rules, and is not counted here.
- **X data ceilings:** `X_DATA_DAILY_MAX_USD` (default 1) is the alarm: past it the X data tools
  keep serving and `xDataSpend` on `/api/gateway-status` reads `over`; `0` refuses every call
  (`off`). `X_DATA_DAILY_HARD_MAX_USD` (default 5 times the alarm ceiling; never under it) is
  where a read is refused 503 and the word reads `capped`. The status Worker and `heartbeat.yml`
  page on `over` and `capped` under one issue ("X data daily spend OVER its ceiling") and close it
  on `ok` or `off` (`scripts/test-x-data-ceilings.js`). The word is built from the larger of this
  process's day and the shared day counter the refusal reads (one read of at most `STATUS_READ_MS`
  per status answer, reused 5 s; a failed read leaves this process's own figure), so a new
  container does not read `ok` on a day already past a ceiling, and a refusal on any replica
  holds `capped` for `REFUSAL_HOLD_MS` (an hour; a refused call books nothing, so the total can
  sit under the ceiling) (`src/daily-ceilings.js`, `scripts/test-spend-words-shared-redis.js`).
- **X search author alarm:** x-search-recent's author expansion stays at the listed price; an
  alarm watches the day's author reads (owner decision 2026-11-12; the permanent exception in
  `scripts/test-pricing-margin.js`). `src/x-search-stats.js` keeps each day's exact expanded-author
  reads per lane (`authorReads`), and `xSearchAuthors` on `/api/gateway-status` reads `alert` once
  the day's reads (both lanes, stored and unflushed) pass `X_SEARCH_AUTHOR_DAILY_ALERT` (default
  500: at most `X_MAX_POSTS_PER_CALL` authors a page, so 50 full pages a day at its default of 10), `ok` under it,
  `unknown` when the stored day cannot be read. One store read per status answer, reused 30 s.
  An alarm only: no call is refused or capped for it. Paged under "X search author reads OVER the
  daily alert", closed on `ok` (`scripts/test-x-search-stats.js`, `scripts/test-status-word-pagers.js`).
- **Router per-minute spend word:** `routerSpendWindow` carries the same words (`over` serves,
  `capped` refuses, `off` is the switch) for `SOR_SPEND_CAP_ATOMIC` and
  `SOR_SPEND_HARD_CAP_ATOMIC`, each held an hour; paged under "Router spend per minute OVER its
  ceiling", closed on `ok` or `off`. Detail in `index-router.md` (`src/router-spend-window.js`).
- **Words with a grace period:** `sharedLimits` reads `degraded` for a minute after any one failed
  Redis command and `replayStore` reads `pending` until the next retry pass, so each carries a
  second word, `alert`, that reads `sustained` once the first has held ten minutes without a break
  (`SHARED_LIMITS_ALERT_AFTER_MS`, `REPLAY_STORE_ALERT_AFTER_MS`; kept in process memory, so a
  restart starts the count again). The status Worker and `heartbeat.yml` page on `sustained`
  ("Shared limits store DEGRADED (Redis)", "Replay store marks PENDING (Redis)") and close when
  the first word reads healthy (`on` or `memory`; `ok`); the alert word inside its grace period
  does neither. `gatewayBalance` reads `withdraw` from the read that reaches
  `GATEWAY_WITHDRAW_ALERT_USD` until the balance is moved, and pages at once ("Gateway balance
  READY to withdraw"), closing on `ok` or `off` (`scripts/test-status-word-pagers.js`).
- **Pre-payment refusal logs:** an input refusal answered before any payment gate
  (`src/prepayment-refusal.js`) writes its `[tool-error] ... prepay=true` line for the first 20
  in a clock minute per process; the rest print one summary line per minute (count and top
  slugs). The `tool_calls` row (`pre_payment`), PostHog and the failure monitor see every one,
  and `getAnalytics` leaves `pre_payment` rows out of the totals, tables and the perf
  `calls`/`errorRate` unless `include_pre_payment=1` (`prePaymentHidden` counts them).
  `logToolError` replaces control characters in the message and the key names
  (`stripControlChars`), so one error is one line.
- **Call log retention:** `tool_calls` (`src/analytics-db.js`, one row per tool call) keeps
  `TOOL_CALLS_RETENTION_DAYS` (default 180; never under 31, so the dashboard's widest window of
  30 days always has its rows; `off` or `0` keeps everything). A daily tick under the lease
  `tool-calls-retention` (first run seven minutes after boot) deletes older rows oldest first by
  the `ts` index, 5000 a statement with a pause between, at most 100 statements a run; the rest
  waits for the next run. Its pool sets the server-side limits the state database pool sets:
  `ANALYTICS_DB_STATEMENT_TIMEOUT_MS` (default 10000) and `ANALYTICS_DB_IDLE_TX_TIMEOUT_MS`
  (default 30000). A cut statement drops that one row or ends that run; the insert path never
  throws (`scripts/test-analytics-retention.js`). `ANALYTICS_TEST_CAPTURE=1` (default unset) is
  a test sink: each call-log row is printed as one `[tool-call-test]` line and none is written;
  never set in production (`scripts/test-bespoke-call-log.js`).
- **Sale paths and cohorts:** each sale records how it arrived (`src/sale-path.js`: the
  connector's loopback, a client package by its User-Agent product token, or HTTP) in the
  ledger's `via` column; `/__operator/cohorts.json` lists wallets past a per-day distinct-tool
  (`COHORT_TOOLS_PER_DAY`) or per-hour call (`COHORT_CALLS_PER_HOUR`, default 300) threshold.
- **Live view:** `services/live` deploys from this repository with every merge. The page reads
  one event stream and, with nothing on it after 8 s (a proxy holding it), polls `/api/poll`
  for the same numbered batches (`LIVE_POLL_KEEP_BATCHES`, default 300; a whole-hour answer at
  most `LIVE_POLL_HELLO_PER_MIN`, default 30, times a minute per address). Tests:
  `services/live/test.js`, `test-guard.js`.
- **Robots:** `src/seo.js`; the private disallow list is repeated in every named-crawler group.
- **X posting:** `announce.yml` / `scripts/tweet.js` (workflow dispatch only) and
  `src/tweet-queue.js`; both sign through `src/x-oauth.js`. Tweet copy is never committed.
- **Referral settlement book:** `src/referral-book.js` keeps the referral gate's unfinished
  settlements in the `referral-settlements` state document (without a database the file
  `REFERRAL_BOOK_FILE`, else `/data/agent402-referral-settlements.json`, else the same name under
  the temp directory): an `intent` written before `/settle` (with the chain head read before
  `/verify`, so the proof is searched from there however late it is read), `in-doubt` when the
  call did not say whether the payment moved, `unconfirmed` when the facilitator answered success
  and its receipt was not yet readable (`flagged` after 3 minutes without one), `contradicted`
  when the chain contradicts a success or a charged entry's transaction (kept until resolved by
  hand), `charged-undelivered` when the payment is proven and the buyer has not received the
  answer, and a `refund-owed` mark (kept until the authorization expires) once such a buyer is
  owed back. An entry carries `delivered: true` from just before its answer is sent. The document
  also holds the gate's own forgiven hang-ups, the last 200 hand resolutions (with their
  outcomes and notes), the last 500 entries closed because their receipt is not recognized, the
  short-net records by slug, the booked-payment marks of the last hour (`sold`), and which slugs have a proven sale at their floor (`proven`, one
  small record a slug with a fingerprint of the settings, so a deploy does not make every slug
  cold; an older build drops the field on its next write and the slugs are cold once). The book holds no answer: owed answers are files under `REFERRAL_ANSWER_DIR` (default
  `agent402-referral-answer-cache` beside the book file), on this process's disk only, never a
  database row (the nightly backup copies those, and the file backup leaves out a `cache` name),
  deleted at their expiry (`IDEM_TTL_MS`, 10 minutes), at most 32 MB in all; a restart loses
  them. A paid call writes the book four times (the intent, the charge, the delivered mark, the close;
  measured against a database at 2 ms round trip: 4.0 writes and 4.0 attempts a call, the gate adds
  about 27 ms). At most 2000 entries, 40 for one payer: a payer past its share, or a
  book at capacity with nothing to retire, refuses a paid call (503 before `/verify` and the
  handler); at capacity the oldest expired in-doubt entry is retired to the operator record. The leased sweep `referral-settle-sweep` (at
  boot and every `REFERRAL_SWEEP_MS`, default 60000; `contained`) reads up to 50 open entries a
  pass (in-doubt and intent entries first, a reserved fifth of the reads for refused entries, each
  group least recently read first; no read starts after the pass's 40 s chain budget, of which the
  last fifth is kept for dropped records, and at least one dropped record is read every pass), each
  as it stands at that moment: routed to this
  merchant by its own receipt books the sale once; a nonce spent without paying us, an
  authorization expired unused, or one expired with a complete search that found nothing closes
  the entry with nothing booked; a spent one whose transaction was found, with a receipt read in
  full that the rule does not recognize, is closed to the operator record once it has expired and
  been read so `REFERRAL_UNRECOGNIZED_READS` times (default 5: no sale, no refund, an error line,
  attention for a day), except one whose receipt the contract routed to this merchant, which stays
  open for an operator (attention); unconfirmed ones are confirmed or flagged; an entry whose
  answer is still being sent (`sendingUntil`) is left to that send; a delivered entry
  whose closing write failed is closed; a `charged-undelivered` entry whose answer is gone becomes
  a refund owed at the gross, only behind the receipt proof read again (`refundsOwed` covers
  it). An operator closes an entry by hand with
  `POST /__operator/referral.json {"action":"resolve","key":"<entry key>","note":"what was checked","outcome":"refund"|"delivered"|"dismissed"}`
  (token-authed; recorded with the outcome and the note). `refund` writes the refund debt at the
  gross behind the receipt proof and keeps the `refund-owed` mark; with no proof it answers 400
  and changes nothing. `delivered` and `dismissed` write no debt and remove the entry. A
  `charged-undelivered` entry needs the outcome named. While a `contradicted` entry or a flagged
  `unconfirmed` one is open, new payments are answered 503 (`settlement_under_review`: every
  payer for a flagged unconfirmed entry or one carrying `scope: "route"`, otherwise only that
  entry's payer) until it is resolved, so
  resolving one is what reopens the route. A record in `closedUnrecognized` goes back to the open
  entries with `{"action":"reopen","key":"<its key>","note":"what was checked"}`; it is then never
  closed by itself, and `resolve` works on it. An open entry marked `routedToUs` paid this
  merchant under settings this server does not hold (a payout wallet changed on chain first):
  correct `REFERRAL_PAYOUT_ADDRESS` and the sweep proves and books it, or resolve it by hand
  (`refund` writes its debt). The view's `shortNet` lists slugs whose sales arrived under the
  net `REFERRAL_COMMISSION_BPS` expects (attention from the first, with both amounts): correct
  the map and redeploy (the sweep drops the record), or clear it with
  `{"action":"clear-short","slug":"<slug>","note":"what was checked"}`; a slug paid under its stop
  floor (`REFERRAL_MIN_NET_BPS`, else half the expected net) once for a model-backed tool,
  `REFERRAL_SHORT_NET_MAX` times for another, answers 503 until then; so does a slug whose
  receipt named another product id than `REFERRAL_PRODUCT_IDS` holds for it (the word names both
  ids; correct the id and redeploy, or `clear-short`). With contradicted entries
  from three payers and no proven sale since, the route lets one payment at a time through as a
  probe and answers 503 to the rest: a probe that proves reopens it by itself; if probes keep
  being contradicted, check `REFERRAL_MERCHANT_ID` and resolve the entries. The word's
  `noProductId` lists slugs not bound to a product id (`REFERRAL_PRODUCT_IDS`); an open entry
  routed to us for another product stays for the operator. Operator view: `GET /__operator/referral.json`. The
  word `referralSettlement` on `/api/gateway-status` (only while the gate is mounted) reads
  attention on the conditions `.claude/rules/payments.md` lists; the status Worker and
  `heartbeat.yml` page on it (`scripts/test-referral-gate.js`, `scripts/test-status-word-pagers.js`).
- **Referral gate, standing facts (measured 2026-11-14, stubs for the facilitator and the chain):**
  one paid `/ref` call makes 1 `/verify`, 1 `/settle`, 1 receipt read, 4 book writes, and writes and
  removes one answer file. The book is ONE document rewritten whole by each write, so a write costs
  the document's size (about 0.5 MB at 1000 open entries); changes queue per process and those
  waiting are written together (`src/referral-book.js` `change`), so under load writes per call fall
  (24 calls at once on a 1000-entry book: 34 writes for 96 calls, 1.00 attempts a write, no call
  refused for the store), and two of this process's writers never collide; compare-and-swap is left
  to arbitrate between processes. The sweep writes its "read, nothing changed" marks once a pass,
  hands on at most 50 charged, undelivered entries a pass (oldest first) and its answer-file pass
  reads one file a turn. Sweep RPC volume: no chain read with an empty book; from 50 open entries up
  about 3,000 reads an hour (50 entries a pass, a pass a minute). Kept answers live under the
  container's temp directory: a deploy loses them, and each charged, undelivered one then becomes a
  refund at the gross. A deploy overlap is two processes on one book: an answer is delivered or
  owed back, never both (the store decides; `.claude/rules/payments.md`), and an answer whose
  sender ended mid-send gets a refund held for review. During a drain a settle call ends 10 s
  before the drain's deadline (`REFERRAL_DRAIN_SETTLE_MARGIN_MS`), 4 s before the state database's
  pool starts closing, so its book write lands. Store outage: an intent write is given up at 3 s; the hold that follows is the store rule in
  `.claude/rules/payments.md` (`REFERRAL_STORE_WRITE_MS`, `REFERRAL_STORE_WINDOW_MS`,
  `REFERRAL_STORE_COOLDOWN_MS`). The status word also
  reads attention while the chain head could not be read for 5 minutes (every paid call is then
  refused) and while the store takes no writes; "not answering" reasons age out 30 minutes after
  the last unanswered call; the retired and closed reasons clear when an operator acknowledges them
  (`POST /__operator/referral.json {"action":"acknowledge","what":"retired"|"closed"|"dropped","note"}`);
  `{"action":"resolve-many","state","reason","outcome":"dismissed"|"delivered","note"}` resolves
  every open entry of one state and recorded reason, each recorded (never a refund, and never a charged, undelivered or unconfirmed entry: those are resolved one at a time). One issue
  covers every reason: the heartbeat comments on it when the operator view's `status.tag` (a digest
  of which reasons hold), keyed with a dedicated key that has no other role (the Actions secret
  `REFERRAL_MARK_KEY`, HMAC-SHA256, 24 hex; never the operator token, which only reads the operator
  view), is a mark the issue has not carried; with no key set, one fixed comment is posted per
  issue with no mark; the tag itself is printed nowhere (not on the issue, not in the job log). A listed slug that is not served is a standing reason.
- **Money-state sweeps and books (batch 2026-11-08a):** `TEMPO_PUSH_HELD_MAX_MINUTES` (default 30)
  is the age past which a leased sweep reopens a held Tempo push debt whose run never finished;
  `TEMPO_LATE_CONFIRM_DELAYS_MS` (comma list of delays, default 15000,45000,120000; at most 6, each
  at most 30 minutes; `off` disables) and `TEMPO_LATE_CONFIRM_MAX_WATCHES` (default 200 per process)
  bound the re-reads that book a Tempo pull landing after its 402 as owed (`src/mpp-tempo.js`).
  Every watch is first written to the `tempo-late-watches` state document (`src/tempo-late-watches.js`;
  without a database the file `TEMPO_LATE_WATCH_FILE`, else memory): one past the bound, one whose
  process stops mid-watch, one whose last read failed and one whose booking did not land are read by a
  leased one-minute sweep (`tempo-late-watch-sweep`) once their last delay plus 30 s has passed, and
  booked by transaction hash, so a second read books nothing more; an entry whose reads fail for 24
  hours is logged as an error and dropped, and past 2000 entries the oldest is logged and dropped;
  `GATEWAY_RESUME_RENEW_MS` (default a third of the 10-minute resume lease, 200000; for tests) is how
  often a Gateway resend renews its hold, for at most 30 minutes (`src/gateway-nanopayments.js`).
  The held-claim sweep walks every refund row created before its cutoff by createdAt window,
  with a cursor kept across ticks (at most 5000 rows a tick; a window whose page fills is halved),
  so a stranded hold is found however many newer rows exist; the same walk logs owed rows unpaid
  past `OWED_ESCALATE_DAYS` (default 7) as an error, at most once a day (no addresses).
  The late-settlement book reports `lateSettlements` on /api/gateway-status: ok, near_capacity
  (80% of the open bound), full, unresolved (an entry waits for a human, a booking sits in the
  journal, or one could not be recorded anywhere in the last 24 hours; that time is also written
  to the resolutions document, retried on the next status read when the write fails, so it outlives
  a restart until it ages out or is acknowledged). The status Worker and the
  heartbeat page on unresolved and full and close on ok or near_capacity. Unresolved entries are
  read on chain again every 6 hours (five a pass) and close themselves once the chain answers; an
  operator clears one with `POST /__operator/late-settlements`
  `{"action":"resolve","key","outcome":"booked_owed"|"paid"|"dismissed","note","tx"}`
  (booked_owed writes the refund debt, paid needs the refund tx) or the unrecorded count with
  `{"action":"acknowledge_unrecorded","note"}`; each is recorded in the
  `late-settlements-resolutions` document before the entry is dropped and listed on
  `/__operator/refunds.json` (`unconfirmedSettlements.resolutions`).
  Rollback: a build before batch 2026-11-08a counts unresolved entries toward the 2000-entry
  bound and refuses a new booking past it ("NOT booked"), so before rolling back resolve entries
  until the whole book (open plus unresolved, `/__operator/refunds.json`) is under 2000. Such a
  build emits neither `lateSettlements` nor `subscriptionFeePayer.ceiling`; both read `unknown`,
  which neither opens nor closes an issue, so close an open "Late settlements need attention" or
  "Subscription gas sponsor CEILING reached" issue by hand after checking the log.
  A Gateway booking held outside its pending book is also written to the `gateway-pending-lost`
  state document (with a state database), read back by the next container; past 200 in memory the
  oldest is logged as an error naming it, the `gatewayPending` word pages for 24 hours, and it
  stays in the document (bound 2000) until memory has room. Without a volume the local copy is a
  0600 file in a per-process mkdtemp directory. Rollback: an older build ignores the document and starts
  with empty memory, so before rolling back read `heldInMemory` and `heldDurable` on
  `/__operator/gateway-pending.json` and resolve what is held.
