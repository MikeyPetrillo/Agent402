# Test list for the test-pricing lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-pricing N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (62 scripts, one process each)
# Moved here from test-unit-a (2026-08-25 rebalance): the pricing lane was
# one 4.5-minute test; with that test bounded (see countTokensBounded in
# llm-gateway-kit.js) it had four minutes of headroom.
# Deterministic correctness proofs run FIRST — a flaky live upstream
# (e.g. data.gov downtime) must never mask whether the tools actually work.
# Ox Alpha tier (locked stealth model, zdr refusal, zero-cost clamp, reasoning floor, vanish gate - offline)
t node scripts/test-ox-tier.js
# Macro-kit tests (FRED yield curve, Treasury debt + avg rates, ECB FX series, World Bank — live keyless APIs)
t node scripts/test-macro-kit.js
# MPP dual-stack shim (real mppx client buys over WWW-Authenticate/Authorization wire; single settle; x402 pass-through; HMAC tamper — offline)
t node scripts/test-mpp-shim.js
# MPP evm EIP-712 domain fallback (a wrong-domain credential is refused locally, its 402 carries no challenge so the client takes x402, healthy clients untouched — boots a paid
t node scripts/test-mpp-evm-domain.js
# Report products' free probe stage + the pure handler helpers it feeds
t node scripts/test-report-probes.js
# Checkout rate limit runs BEFORE the body parser (a malformed body used to 400 at the parser and be counted against nothing) — boots a server, offline
t node scripts/test-checkout-limiter.js
# Client address behind the CDN proxy: CF-Connecting-IP only from a CDN peer and only when valid, IPv4 and IPv6, a forged header never mints a limiter bucket (boots a server, offline)
t node scripts/test-cdn-client-ip.js
# Trust proxy: TRUST_PROXY_HOPS unset trusts no forwarded hop (a spoofed X-Forwarded-For never mints a limiter bucket, boot warning names the variable), 1 behaves as behind the edge
t node scripts/test-trust-proxy.js
# FREE_MODE holds no paid fact: a forged payment header names no wallet on the identity-bound routes, and a paid server answers a FREE_MODE sibling's job 404 (boots a FREE_MODE and
t node scripts/test-free-mode-isolation.js
# A refused payment says WHY on the 402 (the vendor answers a bare {} and drops the reason; one client looped ~9/min for 12h) — boots a paid server, offline
t node scripts/test-payment-reject.js
# A v1-era client names the price maxAmountRequired; x402 v2 deep-equals the echoed accepts block, so that one rename made a correct payment unmatchable — boots a paid server, offline
t node scripts/test-x402-v1-accepts.js
# The 402 JSON body carries the same PaymentRequired object as the PAYMENT-REQUIRED header
t node scripts/test-payment-required-body.js
# The three-line front door leads /llms.txt, /agents.md, the MCP server.describe answer and the unpaid 402 body
t node scripts/test-front-door.js
# HEAD paywall bypass closed (HEAD on paid GET routes 402s with challenges + empty body; free surfaces untouched — offline)
t node scripts/test-head-paywall.js
# Anthropic SDK base-URL alias (/v1/<tier>/v1/messages) + 1 MB body limit on the metered routes (boots a paid server, offline)
t node scripts/test-messages-sdk-alias.js
# Price by model: a flat route's 402 quotes the named model's home tier (x402 + Tempo), and only that payment is served as that tier (boots a paid server, offline)
t node scripts/test-price-by-model.js
# TTS quoted per request: the 402 on each chain, Tempo, settlement and the credits hold all read the quote for the text; over-cap refused before any spend; the price surfaces carry
t node scripts/test-tts-quote-paid.js
# Every quoted route states one floor: /api/pricing, /openapi.json, /llms-full.txt and the 402's smallest quote agree (paid boot, stub facilitator).
t node scripts/test-quoted-from-price.js
# Real sample reports: fixtures are finished reports, pages indexable with own title/JSON-LD, /reports links them, sitemap carries them (boots FREE_MODE, offline)
t node scripts/test-sample-reports.js
# openFDA 404 = no matches, an empty result: recall-report must not 502 on it (offline)
t node scripts/test-recall-nomatch.js
# Free email alerts engine: double opt-in, signed links, change-only daily email, caps (offline)
t node scripts/test-free-alerts.js
t node scripts/test-free-alert-probes.js
t node scripts/test-email-status.js
# Alert routes end to end on a booted server: confirm / unsubscribe / stop pages render (the engine test could not see a 500 here)
t node scripts/test-alerts-routes.js
# Post-purchase follow-ups: two emails at most, stoppable, failure notice (offline)
t node scripts/test-followups.js
# Erasure on request, file backend: erase-subject.js removes an address from every file store that holds one (alerts, follow-ups, a leftover weekly digest file, card and MPP
t node scripts/test-erase-subject.js
# Server-side tweet queue: one post per clock hour oldest first, recorded before it is sent (a killed child never re-sends), two processes post once, drops past the window, an
t node scripts/test-tweet-queue.js
# tweet.js media upload: --upload-only honors DRY_RUN=1 and --dry-run (no request at all), a refused STATUS read while a video processes is exit 2 with the status (stub fetch
t node scripts/test-tweet-cli.js
# Public reports: buyer toggle by session id, unguessable public id, indexable page, revocable (boots FREE_MODE)
t node scripts/test-public-reports.js
# House style on every report tier: no em/en dashes in delivered copy (offline)
t node scripts/test-house-style.js
# Domain audit inputs round 2: DKIM by MX provider, DNS-host feasibility, advisory cross-origin headers, www twin (offline)
t node scripts/test-domain-audit-inputs.js
# Dev shortlinks (/claude, /cursor, ...) + the /install script (boots a free server)
t node scripts/test-shortlinks.js
# Retired catalog routes answer 410 with the replacement, never the guessed-slug 404 (boots a free server)
t node scripts/test-retired-routes.js
# Who hits us: per-request classes, the crawler rule, repeat-buyer memory, the operator read (boots a free server)
t node scripts/test-traffic-classifier.js
# Hourly budget on unpaid price checks per client: 429 past it, never for payments, named indexers, our probes or discovery (boots paid + FREE_MODE servers, offline)
t node scripts/test-unpaid-quote-budget.js
# An address that paid is not held to the unpaid-quote limiters for the trust window; free calls, 4xx and unverified headers still count (paid boot, stub facilitator)
t node scripts/test-paid-quote-trust.js
# A rejected payment is answered in the buyer's terms (balance vs stale authorization) on the 402 (offline)
t node scripts/test-verify-hint.js
t node scripts/test-verify-hint-live.js
# A refused payment resent before its 402's write completes is refused again, never held as a replay
t node scripts/test-replay-release-at-end.js
# A Solana wallet with no USDC account or too little USDC is told to fund it
t node scripts/test-svm-funding-refusal.js
# A top paying buyer's failed paid calls raise topBuyerFailures within minutes, word only in public
t node scripts/test-top-buyer-failures.js
# Buyer scorecard: monthly outside wallets, returning and multi-day wallets, calls and USD by network from the sales ledger; our wallets and test traffic left out, "<3" buckets, no
t node scripts/test-scorecard.js
# A verify refused for lack of funds names its class, the amount and the asset on every rail, and its log line carries the slug and a short payer (offline)
t node scripts/test-verify-refusal-reason.js
# Settle-failure breaker on EVERY wallet-only tool (paid boot, stub facilitator verifies then refuses to settle)
t node scripts/test-paid-settle-breaker.js
# onchain-sql queries per call on a booted server
t node scripts/test-onchain-sql-queries-route.js
# Refund debts for sales named by settle tx: dry by default, ledger row decides payer and price, skips named, idempotent, operator only (FREE_MODE boot, seeded ledger)
t node scripts/test-refund-backfill-sales.js
# Algorand leaves sub-cent 402s while the facilitator's sponsored sub-cent allowance is spent; a quota refusal is never the buyer's (paid boot, stub facilitators + stub sponsorship status)
t node scripts/test-avm-subcent-offer.js
# Every route's 402 payTo equals the payee /.well-known/x402 declares for it (payToByRoute for the router tiers); spending-wallet addresses set and unset (two paid boots, stub facilitator)
t node scripts/test-payto-by-route.js
# Every skill pack's Algorand accept matches the requirement the paid request rebuilds
t node scripts/test-skill-pack-avm-match.js
# The Algorand buyer pays a seller on the legacy network id (full genesis hash): folded inside the scheme, the seller's own accept echoed (offline, stub algod)
t node scripts/test-avm-buyer-legacy-network.js
# Router dispatch eligibility, labelled: one function for the resolver's Base gate and every public row (offline)
t node scripts/test-dispatch-eligibility.js
# The router's buyer on every EVM chain SOR_EVM_CHAINS enables
t node scripts/test-evm-buyer-chains.js
# Routes that sell personal data about individuals stay listed and are never ranked, labeled eligible or paid; worker thread agrees (in-process pool + a free boot, offline)
t node scripts/test-router-people-data.js
# The raw-text gate before the category patterns never skips text the normalized gate would pass (offline)
t node scripts/test-route-category-gate.js
t node scripts/test-unproven-lane-labels.js
# seller-trust and seller-dossier report both router lanes (proven, Base unproven) from the per-route verdicts, through their routes (FREE_MODE boots, seeded index, ceiling on and off)
t node scripts/test-seller-trust-lanes.js
# USDC EIP-712 domain truth per chain: table pinned to payments.js + @x402/evm, wrong-name accepts refused (offline)
t node scripts/test-evm-usdc-domain.js
t node scripts/test-direct-transfer-seller.js
# Shared-wallet settlement evidence counts only where the live 402 pays: fake leaderboard row + fake 402s, call sites pinned (offline)
t node scripts/test-sor-payto-binding.js
# The router's own purchases are never a seller's proof: merchant SQL excludes our wallets, Bazaar figures reduced by the purchase record, Solana credit rule, payers 0 refuses (offline)
t node scripts/test-router-purchases.js
# Operator-listed shared payTo wallets credit nobody: the rule, the persisted store, and the lever on a booted free server across a restart
t node scripts/test-shared-paytos.js
# Self-funded payers are not settlement evidence: ordered funding read, refunds kept, circular wallets' Bazaar figures ignored, end-to-end scan against a stub Bazaar + RPC (offline)
t node scripts/test-seller-funding.js
# The funding reader's calls stay bounded and fall away with 1 to 200 heavy payTos: the real scan, refresh after refresh, against a stub Bazaar + RPC (offline)
t node scripts/test-funding-read-budget.js
# In-flight composites are cut off on SIGTERM: scope wrapper + fetch signal + shutdown seam (offline)
t node scripts/test-drain-abort.js
# Solana SPL leaderboard: batched credits scan, primed gate, payTo list, ranking, persistence (offline stub RPC)
t node scripts/test-solana-leaderboard.js
# Solana board scans survive a restart: cursors checkpointed mid-scan and on drain, next boot resumes without re-reading, newest stored cursors adopted, a read failing scan after
t node scripts/test-solana-leaderboard-checkpoint.js
# Solana history reads public RPC first: keyed lane on 429/timeout/null, identical board, throws when every lane is down, pacing, counters (offline stub RPCs)
t node scripts/test-solana-history-rpc.js
# Base board keeps its read log window: identical board to a full read across head advances, new/returning wallets, failed reads, restart, store mismatch, row cap, switch (offline stub RPC)
t node scripts/test-leaderboard-log-cache.js
# Base board log cache at the row cap: kept rows folded by index (identical order to a full read), only changed segments re-hashed and saved, no stale digest after any invalidation,
t node scripts/test-leaderboard-log-cache-scan.js
# Recent EVM getLogs public-first: complete-answer guard (own head, filter match), fallback on error/range cap/behind head/timeout/429, skips, rollback, ledger rows identical
t node scripts/test-evm-logs-rpc.js
# accepts[0].outputSchema on the 402: pure header rewrite + mount order (offline)
t node scripts/test-accept-output-schema.js
# OWN LANE on purpose. This single step ran 254s - 42% of the unit-a
# lane, and unit-a was the slowest of the three, so it was 42% of the
# critical path. It rebuilds a max-size dense-CJK body and BPE-tokenizes
# it once PER MODEL, when the text is identical across models in a tier.
#
# The obvious speedup is memoizing the tokenizer, but this test imports
# worstCaseUpstreamCost / clampToMargin FROM PRODUCTION precisely so the
# guard and the runtime can never disagree about what a call costs. That
# property is worth more than four minutes, so the step is untouched and
# moved off the critical path instead, where its duration stops mattering.
# Pricing margin invariant (worst-case upstream < price on every gateway tier, failover links included; cap-before-spend; 410 tool_gone telemetry — offline)
t node scripts/test-pricing-margin.js
# A model whose reasoning bills outside max_tokens is quoted and clamped for it: the metered quote covers the measured token mixes at the markup (private table, offline)
t node scripts/test-metered-uncapped-reasoning.js
