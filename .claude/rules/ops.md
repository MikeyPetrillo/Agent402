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
  (`NODE_ENV` or the platform's environment name); the heartbeat and the status probe page on it.
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
- **Failure monitor:** `src/tool-failure-monitor.js` counts every catalog answer past the gates by slug, class, origin (outside vs our own synthetic traffic) and payment rail (`outcomeRailOf` in `src/payment-rail.js`; a free proof-of-work or trial outcome counts on its own lane, shown in the detail and read by `toolFailures` only when a tool fails nearly every free call: `TOOL_FREE_FAIL_RATE`, default 0.9, over `TOOL_FREE_FAIL_MIN_CALLS`, default 20, in an hour) and every named upstream's fetch outcomes through the egress meter's observer, in five-minute buckets merged across replicas through Redis; `toolFailures`, `upstreamHealth` and `facilitatorFunds` (also `low` while a facilitator signer is short of gas; a dry Robinhood signer our relayer covers is left out and pages as `robinhoodSettler=relayer` instead, `.claude/rules/payments.md`) are words on `/api/gateway-status`, detail on `/__operator/tool-failures.json`. Every final 200 is also classified by body (`src/answer-shape.js`: ok, empty, error-shaped, unchecked; a tool whose contract allows an empty answer goes in `EMPTY_RESULT_OK` or sets `discovery.emptyOk`) into the `toolAnswers` word; the same detail lists live-data slugs whose sales all returned one response digest. `src/settle-demotion.js` puts Celo's alternates first after consecutive out-of-funds refusals.
- **Per-call count documents:** `src/sql-query-stats.js` (onchain-sql queries per call) and
  `src/x-search-stats.js` (x-search-recent authors and posts per call) keep per-UTC-day
  histograms as state documents (`src/json-document.js`), counted on a final 200 and folded
  into the document on a timer and at shutdown. Env: `SQL_QUERY_STATS_FILE` (default
  `/data/onchain-sql-query-stats.json`), `SQL_QUERY_STATS_FLUSH_MS` (default 60000, at least
  1000), `X_SEARCH_STATS_FILE` (default `/data/x-search-author-stats.json`),
  `X_SEARCH_STATS_FLUSH_MS` (default 60000, at least 1000). The files are used only without a
  state database; `ownStoreEnv` (`scripts/lib/own-stores.js`) points both into a booted test
  server's own directory.
- **Pre-payment refusal logs:** an input refusal answered before any payment gate
  (`src/prepayment-refusal.js`) writes its `[tool-error] ... prepay=true` line for the first 20
  in a clock minute per process; the rest print one summary line per minute (count and top
  slugs). The `tool_calls` row (`pre_payment`), PostHog and the failure monitor see every one,
  and `getAnalytics` leaves `pre_payment` rows out of the totals, tables and the perf
  `calls`/`errorRate` unless `include_pre_payment=1` (`prePaymentHidden` counts them).
  `logToolError` replaces control characters in the message and the key names
  (`stripControlChars`), so one error is one line.
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
  `TEMPO_LATE_CONFIRM_DELAYS_MS` and `TEMPO_LATE_CONFIRM_MAX_WATCHES` bound the re-reads that book a
  Tempo pull landing after its 402 as owed; `GATEWAY_RESUME_RENEW_MS` renews a Gateway resend hold.
  The late-settlement book reports `lateSettlements` (ok, unresolved, full) on /api/gateway-status,
  paged by the status Worker and the heartbeat.
