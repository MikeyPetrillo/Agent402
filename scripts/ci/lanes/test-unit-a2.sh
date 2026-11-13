# Test list for the test-unit-a2 lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-unit-a2 N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (15 scripts, one process each)
# /.well-known/x402 manifest contract (envelope + payment + capabilities + discovery)
t node scripts/test-x402-manifest.js
# MPP subscription rail-canary gate (canary product is never advertised and is mintable only for a heartbeat-token caller; boots a real server, spends nothing)
t node scripts/test-mpp-subscription-canary-gate.js
# MPP monitor manage routes take the token from X-Manage-Token, a JSON body or ?token=, and answer no-store with no referrer (boots a real server, spends nothing)
t node scripts/test-mpp-manage-token.js
# /api/leaderboard envelope (spec, defaults, per-row shape — MCP top_x402_sellers piggybacks on this)
t node scripts/test-leaderboard-envelope.js
# Payer concentration on leaderboard rows (no payer address leaks; both axes trip the flag)
t node scripts/test-payer-concentration.js
# MCP call_tool contract (canonical + flattened + stringified + wallet-refusal + self-correction envelope)
t node scripts/test-mcp-call-tool-contract.js
# Hosted MCP serverInfo.version is the registry package version with the build as semver metadata; the image copies mcp/package.json (boots free mode on port 0)
t node scripts/test-mcp-server-version.js
# Exposure hardening (A402-11/12/13 no X-Powered-By; security.txt; health gates flags; credential-free MCP CORS — spawns child)
t node scripts/test-security-headers.js
# Document headers: pages always, JSON API paths never, an HTML answer under /api again (offline, in-process)
t node scripts/test-security-headers-unit.js
# Security header set per surface class: page, API 200, 402, 404, operator 404, /mcp, static documents, redirects, parser-refused requests (boots paid-mode on port 0)
t node scripts/test-security-header-surfaces.js
t node scripts/test-algorand-page-deadline.js
# crawl kit (offline)
t node scripts/test-crawl-kit.js
# page-change kit (fixture server on port 0; a DNS lookup is the only network touch)
t node scripts/test-page-change-kit.js
# email-guard (offline: MIME reader, HTML worker, header, link and text signals)
t node scripts/test-email-guard.js
# Office files (offline: xlsx, docx and pptx read back by an independent zip reader; caps, no-formula, no-egress, timing)
t node scripts/test-office-create.js
# Memory v2 unit tests (grants, counters, audit chain, recall)
t node scripts/test-memory.js
# The local embedding's token hash: unchanged for strings, string-coerced and bounded.
t node scripts/test-memory-fnv1a.js
# Security regressions (proto-pollution, input-DoS, 500-hardening)
t node scripts/test-security.js

# @step 2: Offline suites (5 scripts, one process each)
# "Settlement reconciliation (facilitator said paid vs chain says landed — offline)"
t node scripts/test-settlement-reconcile.js
# "Tollbooth x402 middleware mode + MPP (real @x402/express settles after the handler; real mppx client buys over the MPP wire; stub facilitator — offline)"
t node scripts/test-tollbooth-mpp.js
# "Buyer wallet trend (a self-funding wallet that FALLS is unexplained; a transient in-flight dip is not — offline)"
t node scripts/test-buyer-balance-trend.js
# "Spending-wallet chain words (five hanging RPCs read side by side under one deadline, unknown not a stall; offline)"
t node scripts/test-upstream-buyer-status.js
# "Stepped sort equals the engine's sort (same comparisons, same order; offline)"
t node scripts/test-timsort-steps.js

# @step 3: Shared limits (REAL redis: the counter primitive on both backends, two Redis instances read one count, a store that does not answer is a miss and never an exception; then two servers and two control replicas on one Redis: a breaker, a money guard and a budget counted on A refuse on B, an operator session minted on A is honoured and revoked on B, the judge's token ceiling and a wallet's in-flight runs are summed across A and B)
t node scripts/test-shared-limits.js
t node scripts/test-shared-limits-crossprocess.js
# exaSpend, xDataSpend and routerSpendWindow in a new process
t node scripts/test-spend-words-shared-redis.js
# topBuyerFailures read the same on a container that served none of the failures; a refusing store leaves this process's own word.
t node scripts/test-top-buyer-failures-redis.js
# A close made while a connect is still in flight ends that connect too.
t node scripts/test-shared-redis-close.js
# The in-flight run cover: memory, a store that does not answer (local ledger decides), and real Redis.
t node scripts/test-inflight-cover-shared.js
# The judge's daily token ceiling on the Redis backend (the memory half runs in its own lane).
t node scripts/test-tool-judge.js
# An already-on-chain settle recovers only this request's own transfer; replays across two servers on one Redis never answer twice.
t node scripts/test-settle-onchain-proof.js
# The CoinGecko minute and day caps are one budget across two servers on one Redis
t node scripts/test-coingecko-shared.js
# The hard daily upstream ceilings are one count across two containers on one Redis: A spends the ceiling, B refuses after its sync.
t node scripts/test-upstream-hard-caps-redis.js
# A sub-cent Algorand settle refusal in one process withdraws that accept in another after one shared read.
t node scripts/test-avm-subcent-shared-redis.js
# Seller registration limits (x402 and MPP, per IP and global) are one count across two servers on one Redis, with each process's own count as the floor.
t node scripts/test-registration-limits-redis.js
# Hang-up settlement with the booted server's forgiveness budget on the shared store (Part 2 keeps REDIS_URL under a per-run prefix).
t node scripts/test-hangup-settlement.js
# The settle-failure breaker writes through to the shared store: a trip on one process pauses the other.
t node scripts/test-gateway-settle-breaker.js
# A burst alarm tripped on one container reads burst on another through the shared flag (settle breaker and report guard).
t node scripts/test-alarm-flag-shared-redis.js
# Two servers on one live Redis run one payment sent to both at once exactly once (the outage cases also run offline).
t node scripts/test-replay-store-outage.js
# The consumed mark's hold read back from Redis
t node scripts/test-replay-consumed-hold.js

# @step 4: State database (REAL postgres: documents/records/log lines/leases; every migrated store imports its file once and reads the row; loops skip under another holder's lease; idempotency answers and claims shared over REAL redis)
# The journals move to Redis only while its persistence reads on (src/redis-persistence.js);
# the service image starts without append-only, so turn it on first.
docker exec "$REDIS_CONTAINER_ID" redis-cli CONFIG SET appendonly yes
t node scripts/test-state-db.js
t node scripts/test-stores-pg.js
# The boot step drops the retired tollbooth_leads table, logs only its count, never recreates it.
t node scripts/test-leads-purge-pg.js
# Two containers on one schema: the email stores never undo or repeat each other.
t node scripts/test-overlap-stores-pg.js
# A signed email link for a record the other container made works here.
t node scripts/test-email-links-pg.js
# email status row read at module load with the state database; a later boot reports the recorded outcome (Postgres)
t node scripts/test-email-status-boot-pg.js
# A link whose row write cannot land answers unavailable (503), never ok.
t node scripts/test-email-links-outage-pg.js
t node scripts/test-leased-loops.js
# The call log: rows past the retention are deleted in batches under a lease; the pool's statement limit cuts a slow statement and the insert path never throws.
t node scripts/test-analytics-retention.js
# With more than one replica, a database error never lets a singleton (backup, reconcile) run on both.
t node scripts/test-lease-failopen-replicas.js
# A tick whose lease was lost stops before its next send, pull or paid run.
t node scripts/test-lease-fencing-pg.js
# A paid monitor run is claimed on its record; saves merge, never erase.
t node scripts/test-monitor-scheduler-pg.js
t node scripts/test-idempotency-store.js
# Every store that left the volume: file imported once, rows win, invariant on Postgres.
t node scripts/test-stats-pg.js
t node scripts/test-status-store-pg.js
t node scripts/test-x402-economy-pg.js
t node scripts/test-pow-pg.js
t node scripts/test-memory-pg.js
t node scripts/test-stripe-shadow-ledger-pg.js
t node scripts/test-traffic-classifier-pg.js
t node scripts/test-tweet-queue-pg.js
t node scripts/test-x402-index-pg.js
# Two containers, one seller index: pull, newer wins, removals stick.
t node scripts/test-index-replicas-pg.js
# Two copies of one revision written in either order converge on one copy in both containers and the row.
t node scripts/test-index-equal-rev-pg.js
# The index's save and pull yield on time at production scale (5,800 origins, 198k tools).
t node scripts/test-index-persist-slices-pg.js
# A row of tens of megabytes is written and warm-started under a statement limit it outlasts (the one-row fallback)
t node scripts/test-index-large-row-pg.js
# A 77k-tool seller is stored as a header and parts
t node scripts/test-index-parts-pg.js
# The tool directory from the state database
t node scripts/test-index-listings-pg.js
# A re-price outside a crawl reaches the other container; a boot rewrites nothing it read
t node scripts/test-index-reprice-replicas-pg.js
# Index side stores merge per key and fold the other container's changes on the pull
t node scripts/test-index-side-stores-pg.js
t node scripts/test-leaderboard-peer-adopt-pg.js
# Two containers, one chain scan per cadence on the Base, Solana and MPP boards
t node scripts/test-board-scan-once-pg.js
# Two containers, one live rail scan: the real lease lets one scan, the snapshot is saved as a state document and adopted by the other and by a boot
t node scripts/test-revenue-shared-scan-pg.js
# The seller-funding operator switch set on one container applies on the other after one re-read.
t node scripts/test-seller-funding-switch-pg.js
# Two containers, one MPP index: registrations reach the other by its pull, saves merge by origin, a skipped crawl saves nothing.
t node scripts/test-mpp-index-replicas-pg.js
t node scripts/test-x402-removals-pg.js
t node scripts/test-scan-state-version-pg.js
t node scripts/test-revenue-ledger-pg.js
t node scripts/test-revenue-ledger-enable-pg.js
t node scripts/test-refund-ledger-pg.js
t node scripts/test-sales-ledger-pg.js
# A receipt check on one container finds a sale another just recorded.
t node scripts/test-sale-lookup-crosscontainer-pg.js
# Two containers attesting one sale write one attestation.
t node scripts/test-attest-crosscontainer-pg.js
# A lookup made while its sale's write is queued waits for the write.
t node scripts/test-attest-queued-sale-pg.js
# Buy, then attest the receipt's transaction at once, on a paid boot.
t node scripts/test-attest-after-buy-pg.js
# The gateway response cache is shared across replicas (needs this lane's Redis).
t node scripts/test-prompt-cache-shared.js
t node scripts/test-ledger-dead-letter-pg.js
# The journals in REAL redis: claimed once across containers, a lapsed lease recovered,
# local disk (and the "local" word) when redis is away; card finals keep one outcome.
t node scripts/test-ledger-journal-redis-pg.js
# One drainer at a time, and every claimed entry leased: each guard on its own.
t node scripts/test-ledger-journal-claim-redis.js
# The persistence gate on REAL redis: append-only off holds an entry on local disk (the word local); on sends the next to Redis.
t node scripts/test-ledger-journal-persistence-gate.js
# A push debt replayed from another container's dead-letter never undoes that push's void.
t node scripts/test-tempo-push-void-crosscontainer-pg.js
t node scripts/test-mcp-tasks-pg.js
t node scripts/test-hangup-forgiveness-pg.js
# The forgiveness budget holds across replicas: one reservation script over every window on REAL redis (needs this lane's Redis).
t node scripts/test-hangup-forgiveness-redis.js
# First-call allowance: a new wallet's first eligible call is served and its settle skipped, inside the per-wallet, per-address and daily caps claimed on REAL redis; nothing booked
t node scripts/test-first-call-allowance.js
# The allowance's settle skip is keyed by the payment (network, payer, nonce), never by finding the request: a moved adapter path still skips a granted 200 (REAL redis, in-process).
t node scripts/test-first-call-allowance-hook.js
# The grant's record on Postgres keeps the claim time, so a paid call booked while a slow free call ran reads as a return (REAL redis + postgres, in-process).
t node scripts/test-first-call-allowance-record-pg.js
t node scripts/test-external-spend-guard-pg.js
# The Robinhood order's since on REAL postgres: a fresh process keeps the robinhoodSettler clock, one that finds the facilitator first resets it.
t node scripts/test-robinhood-settler-pg.js
# The per-payer unsettled ceiling holds across replicas: one reservation script on REAL redis (needs this lane's Redis).
t node scripts/test-external-spend-guard-redis.js
# The Base unproven lane's per-seller daily cap is one window across two replicas on one Redis: racing reservations grant exactly the cap.
t node scripts/test-base-unproven-cap-redis.js
# A free (proof-of-work or trial) call drops any payment header riding on it before the handler: a forged header naming our wallet keeps the call on the outside lane of the failure
t node scripts/test-free-call-payment-headers.js
t node scripts/test-mpp-subscriptions-pg.js
t node scripts/test-decide-ledger-pg.js
# A paid step is never turned into a 500 by a later ledger failure; writes after a spend survive an exit.
t node scripts/test-decide-ledger-failures-pg.js
t node scripts/test-credits-pg.js
# A retried settle books what the first one took; another container's sweep leaves a live hold.
t node scripts/test-credits-failures-pg.js
# Erasure on request reaches the rows: alert, follow-up and subscription documents, credit keys and the card failure counter; a dry run writes nothing.
t node scripts/test-erase-subject-pg.js
t node scripts/test-human-checkout-pg.js
# A report made is never refunded or regenerated over a database failure; a refund is recorded first.
t node scripts/test-human-checkout-failures-pg.js
# Another container never takes over a claim whose owner still beats, nor refunds one marked generated.
t node scripts/test-human-checkout-crosscontainer-pg.js
# A paid subscription recorded while the database is away survives a true restart (the next container lands it by its boot replay); reload shows another container's.
t node scripts/test-stripe-subscriptions-pg.js
# A report read that fails answers a fixed message; the driver's text goes to the log.
t node scripts/test-session-read-error-pg.js
t node scripts/test-wish-pg.js
# A first load that failed is retried until it lands; DDL from two boots never races;
# a failed write is kept and retried; a stats batch whose COMMIT reply was lost counts once.
t node scripts/test-store-boot-blip-pg.js
t node scripts/test-store-retry-recovery-pg.js
t node scripts/test-json-document-outage-pg.js
# An import that timed out is a failed load (retried), never an empty store.
t node scripts/test-json-document-import-fail-pg.js
t node scripts/test-store-import-fail-pg.js
# A first boot's imports share two slots: no connect timeouts, serving reads not starved.
t node scripts/test-state-db-import-congestion-pg.js
# A blocked event loop is not a hung database: queries in flight across a block answer; schema-lock waiters hold no connection.
t node scripts/test-state-db-stall-timeout-pg.js
t node scripts/test-store-ddl-race-pg.js
t node scripts/test-store-write-retry-pg.js
t node scripts/test-stats-ack-loss-pg.js
# The nightly backup stages every state table and the restore brings one back.
t node scripts/test-backup-state.js
t node scripts/test-backup-no-volume-pg.js
t node scripts/test-backup-stage-concurrent-pg.js
t node scripts/test-state-roundtrip-pg.js
t node scripts/test-state-migration-verify-pg.js
t node scripts/test-state-ledger-checksum-pg.js
t node scripts/test-state-cutover-check-pg.js
t node scripts/test-state-export-pg.js
# The server through a Postgres outage and back, a burst, a clean drain; two processes on one schema.
t node scripts/test-state-db-resilience.js
t node scripts/test-surface-memo-partial-pg.js
t node scripts/test-index-unloaded-503-pg.js
t node scripts/test-state-db-overlap.js
# The file/memory half runs without the database; the Postgres half with it.
t node scripts/test-json-document.js
# web.answer share=true: the page is written only on a settled 200; hostile answers render inert; noindex, 404/410 (paid boot, stub facilitator + stub answer upstream); the
t node scripts/test-answer-share.js

# @step 5: Offline suites (5 scripts, one process each)
# Marketplace external-seller provenance (F09 — every external result marked untrustedContent + response-level flag; semantic-injection bypass regression — offline)
t node scripts/test-marketplace-provenance.js
# programmatic report pages (offline)
t node scripts/test-programmatic-pages.js
t node scripts/test-edgar-summary.js
# Programmatic page gate wait (a queued EDGAR build cannot hang a crawler; abandoned waiters freed — offline)
t node scripts/test-programmatic-gate-wait.js
# Seller registration conversion/churn table (first_seen immutable, last_settled_seen sticky — offline)
t node scripts/test-seller-registrations.js

# @step 6: Offline suites (44 scripts, one process each)
# Composite-spend guard (research/dossier upstream-drain protection)
t node scripts/test-composite-guard.js
t node scripts/test-run-time-note.js
t node scripts/test-async-jobs.js
# Through the CDN proxy: a paid call to a route that outlasts its wait runs as a job (a 202-following SDK) or is refused before any gate; LLM and image waits end inside the bound;
t node scripts/test-cdn-sync-window.js
# A paid call to a slow route without Prefer
t node scripts/test-slow-sync-window.js
# A file job store's boot sweep fails other boots' running jobs, so each server takes its own directory
t node scripts/test-task-store-isolation.js
# A settled async-job 200 whose body is lost is booked as owed, and the job says only what was done (offline)
t node scripts/test-async-jobs-body-loss.js
# Slow routes advertise their duration and async advice; job progress (queued/running/stage/ETA), sinks keyed in-process only, throttled writes, terminal records never updated (offline)
t node scripts/test-job-progress.js
# A settle failure's PAYMENT-RESPONSE carries a code and a fixed message, never the facilitator's raw text (paid-mode boot vs stub facilitator - offline)
t node scripts/test-settle-failure-header.js
# One payment_settled per settlement, from the one place a settlement becomes final
t node scripts/test-settlement-event.js
# x402-market-pulse supply-mix per-seller tool cap
t node scripts/test-ecosystem-supply.js
# The market pulse's supply picture builds and rebuilds in slices at production scale.
t node scripts/test-market-pulse-slices.js
# "Cache hygiene (M5 — Attack III: paid responses no-store, free discovery stays cacheable)"
t node scripts/test-cache-hygiene.js
t node scripts/test-cache-keys.js
t node scripts/test-nominatim-pace.js
# "SOR external leg for MPP sellers on Tempo (catalog from the verified MPP index, asset pin, live-quote cap, proven-seller gate fail-closed, chain mapping — offline)"
t node scripts/test-tempo-router.js
# MPP request bodies shaped from the seller's llms.txt example (bounded parse, lossless url/query/id cases only; x402 bodies untouched)
t node scripts/test-mpp-input-examples.js
# The same shaping driven through the index, the Tempo catalog, the resolver's candidate builders, route-execute and the MPP payer to a stub seller
t node scripts/test-mpp-example-wiring.js
# Tempo paid-leg errors: unused only on chain proof past the credential's validBefore; possibly-paid failures booked as before; pre-payment failures fall through
t node scripts/test-tempo-refusal-proof.js
t node scripts/test-sor-resolver-scope.js
# Seller sweep: the judgement half (grades a paid answer against the seller's OWN declared contract). The paying half is dispatch-only and never runs here.
t node scripts/test-seller-verify.js
# Seller succession: a seller moving to a permanent domain keeps their listing age, and the claim can never retire or edit the predecessor
t node scripts/test-seller-succession.js
# Operator removal of one seller origin: exact match, persisted, every discovery write refuses it, register answers 410
t node scripts/test-seller-remove.js
t node scripts/test-third-party-routes.js
t node scripts/test-nc-sales-tax.js
t node scripts/test-evidence-watch.js
# Two surfaces that told a consumer something false (paging base, find-miss wish)
t node scripts/test-index-paging-and-find-bridge.js
t node scripts/test-index-paging-contract.js
# A negative answer must be a fact about its subject
t node scripts/test-negative-answer-honesty.js
# What the pack sweep excuses and what it must never excuse - both edges, because a classifier that excuses too much stops being able to fail
t node scripts/test-pack-classifier.js
# Sanctions screening: a MISS must never read as a clearance, and a list that failed to load must refuse rather than answer 'no match'
t node scripts/test-sanctions.js
# The router must never sign a payment to a sanctioned payee - and must NOT stop paying everyone when the list fails to load
t node scripts/test-router-sanctions.js
# Sanctions tools keep the held list when a download shrinks past half (offline)
t node scripts/test-sanctions-shrink-guard.js
# Paid seller verification: an allowlisted projection, a manifest that states the limit of the claim, and a workflow that never holds bucket credentials
t node scripts/test-seller-verification.js
# Delivery-failure memory: a seller whose PAID call 5xx'd with no receipt (or never answered) stops being ranked and stops being labelled callable, until a call to it succeeds
t node scripts/test-seller-delivery-memory.js
# Refusal and delivery memos reach the other replica through the shared store
t node scripts/test-seller-memo-shared.js
# Re-registration cooldowns per origin hold across replicas (shared store)
t node scripts/test-register-cooldown-shared.js
# "External spend guard (per-payer debt ceiling: an UNSETTLED upstream spend keeps counting, so verify-then-fail-to-settle cannot drain the wallet — offline)"
t node scripts/test-external-spend-guard.js
# H-01/H-03: one halt reaches every signing path; the daily ceiling survives a restart
t node scripts/test-signing-halt.js
# A paid seller's rejection is logged with its reason, and none of their body reaches our buyer (source assertions, offline)
t node scripts/test-buyer-rejection-diagnostics.js
# A paid request with no answer keeps its hold and ends the request
t node scripts/test-router-paid-outcomes.js
# Seller-written and caller-chosen bodies are read as capped streams: reading stops at the cap instead of buffering the whole body first (offline, pull-counted streams)
t node scripts/test-capped-body-reads.js
# Hidden page content (comments, display:none, white-on-white, zero-width text) is reported by every HTML-to-text tool and quoted when it reads as an instruction to an AI; the
t node scripts/test-hidden-content.js
# HTML parsing runs in the worker pool: the main thread stays available during a slow parse, a parse past the limit is stopped with a 503 and the pool recovers, a full queue is a
t node scripts/test-html-pool.js
