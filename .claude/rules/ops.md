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
  idempotency, the first-call allowance, the shared Databento and Nominatim reads, the cache, the
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
- **Exa ceilings:** the same two ceilings and words, read the same way (`src/daily-ceilings.js`): `EXA_DAILY_MAX_USD`
  (default 1; `0` refuses every call) is the alarm and `exaSpend` reads `over` past it while the
  Exa tools keep serving; `EXA_DAILY_HARD_MAX_USD` (default 5 times the alarm ceiling; never
  under it) refuses 503 and reads `capped`. Paged under "Exa daily spend OVER its ceiling",
  closed on `ok` or `off` (`scripts/test-exa-ceilings.js`). `exaAllowance` and `EXA_CREDITS_USD`
  are separate and unchanged: with the prepaid balance spent the upstream refuses and the tools
  answer 503 whatever the ceilings say.
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
