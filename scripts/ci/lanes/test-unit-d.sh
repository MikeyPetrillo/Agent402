# Test list for the test-unit-d lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-unit-d N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (162 scripts, one process each)
# Paid scan budget (a public route must not spend without limit)
t node scripts/test-paid-scan-budget.js
# A registry listing is not a seller answering (origin-responded)
t node scripts/test-origin-responded.js
# Monitor scheduler (welcome/scheduled/change/TLS/filing delivery, paid-run bounds, backoff, lock)
t node scripts/test-monitor-scheduler.js
# Tempo transfer feed (incremental sync, overlap dedupe, coverage gating, leaderboard source A vs RPC fallback - offline)
t node scripts/test-tempo-transfers.js
# Route-and-execute (SOR executing surface — resolution, caps, receipts — offline)
t node scripts/test-route-execute.js
# Status page store (unobserved days are never uptime; stale is never operational — offline)
t node scripts/test-status-store.js
# Status page reads at scale (two million rows: the page is byte-identical to the whole-table reads, every history-independent read is an index search, the kept count equals
t node scripts/test-status-store-scale.js
# /llms.txt route-execute tier pricing derived from EXEC_TIERS (a future 5th tier can't go silently missing — offline)
t node scripts/test-llms-route-execute-tiers.js
# Status probe worker (Cloudflare cron observer mapping; stubbed fetch — offline)
t node scripts/test-status-probe-worker.js
# Tool and upstream failure monitor (counting by class and origin, the word thresholds, the replica merge, the Celo settle demotion and its safety rule, words-only public view,
t node scripts/test-tool-failure-monitor.js
# heartbeat.yml's failure-word step run against stubbed curl and gh (pages, comments, closes; slugs only, never counts or upstream names) and the Worker's matching alarms - offline
t node scripts/test-heartbeat-failure-words.js
# Three gateway-status words and their two observers
t node scripts/test-status-word-pagers.js
# heartbeat.yml issue lookups keep only the exact alarm title (a title search also finds near-identical titles; the wallet steps never touch each other's issues) - offline
t node scripts/test-heartbeat-issue-lookup.js
# Paid 200 answer classes (ok / empty / error-shaped / unchecked), the toolAnswers word and its heartbeat + Worker alarm, the identical-answer read over a scratch sales ledger, the
t node scripts/test-answer-shape.js
t node scripts/test-charged-failure-leg.js
# 402 Index price sync (reprices only our own priced listings that drifted; other hosts, unpriced and unsold rows untouched - offline)
t node scripts/test-index402-sync.js
# Render deadline cancellation (R-09 — timed-out contexts close before the slot frees; live contexts never exceed the limit — offline)
t node scripts/test-render-cancel.js
# Stripe MPP settlement (stripe/charge cards via SPT — mint/binding/settlement-ordering, $0.50 min — offline)
t node scripts/test-mpp-stripe.js
# Composite cap enforcement (maxUpstreamUsd is checked at the shared chokepoint, not merely declared - offline)
t node scripts/test-composite-cap-enforcement.js
t node scripts/test-composite-context.js
# Agentic Finance glossary (one DefinedTermSet, anchors unique, category term aliased, explainer bodies link it, post + sitemap + llms - offline)
t node scripts/test-glossary.js
# x402 Leaderboard pure helpers (offline; Bazaar parsing + ranking)
t node scripts/test-x402-leaderboard.js
# x402-kit tests (transfer-auth typed data + live Base RPC reads)
t node scripts/test-x402-kit.js
# farcaster-social kit (offline)
t node scripts/test-farcaster-social-kit.js
# Algorand marketplace page tests (offline, fixture snapshot)
t node scripts/test-algorand-page.js
# Homepage tests (offline, fixture snapshot)
t node scripts/test-home-page.js
# Header: Pricing, Company, Status as plain links, one primary action, every earlier destination still linked (offline)
t node scripts/test-nav-primary.js
t node scripts/test-badge-contrast.js
t node scripts/test-ga-snippet.js
# Page analytics in a DOM: PostHog URLs keep only utm_*, Global Privacy Control loads nothing, the footer reopens the choice
t node scripts/test-analytics-privacy.js
t node scripts/test-chain-page-cache.js
# ?seller= views: unknown sellers never build, one build per listed seller, bounded memo, flat heap
t node scripts/test-chain-seller-view-memo.js
# Operator heap read names every large store: sizes track the heap, the read stays bounded at production scale, operator-only (free-mode boot, offline)
t node scripts/test-memory-stores.js
# Operator demand-board page tests (verdict rendering, no double-escape, robots disallow — offline)
t node scripts/test-operator-wishes.js
# Rail self-heal (the facilitator map cannot silently drift)
t node scripts/test-rail-selfheal.js
# Egress meter (cheap, safe, host-only, never throws on the hot path)
t node scripts/test-egress-meter.js
# Raw fetch audit: every fetch outside the guard is on a classed allowlist
t node scripts/test-raw-fetch-audit.js
# Stellar activity scan tests (offline, fixture Horizon records)
t node scripts/test-stellar-activity.js
# Kit2 tool tests (36 tools, exact-output assertions)
t node scripts/test-kit2.js
# Stripe subscriptions (checkout, provisioning, webhook signature discipline)
t node scripts/test-stripe-subscriptions.js
# Monitor renewal terms beside Subscribe and on Checkout; the manage-link route (same answer, rate limits, one send)
t node scripts/test-monitor-manage-link.js
# Prepaid card credits (mint-once, exact micro-dollar balances, gate debits only on 200, 402 on insufficient, operator view)
t node scripts/test-credits.js
# CAN-SPAM: every outbound email carries the physical postal address
t node scripts/test-email-postal-address.js
# List-Unsubscribe headers reach both email providers (ZeptoMail mime_headers, Resend headers)
t node scripts/test-email-unsub-headers.js
# Prepaid credits are not SOLD by default (no held balance), but existing keys still redeem
t node scripts/test-credits-sales-gate.js
# Stripe shadow ledger (off by default and inert, idempotent on tx hash, failures swallowed, restart-durable, caller unchanged in every world)
t node scripts/test-stripe-shadow-ledger.js
# Every Stripe client sends the pinned API version, never the SDK default
t node scripts/test-stripe-api-version.js
# Fetch-guard error attribution (upstream 4xx→422, 5xx→502; media Content-Type fail-fast)
t node scripts/test-fetch-guard.js
t node scripts/test-ssrf-literal-ip.js
# Guard lookups run on c-ares, not the thread pool: a full pool and unanswered names never delay a healthy one
t node scripts/test-dns-pool-starvation.js
t node scripts/test-dns-name-filter.js
t node scripts/test-undici-dispatcher.js
# Discovery & trust surfaces (/.well-known/x402, /api/reliability)
t node scripts/test-discovery.js
# Bazaar validate client (catalog method travels, required vs advisory, 429 backoff, unreadable never valid - offline)
t node scripts/test-bazaar-validate.js
# Anthropic Messages wire on the five tiers (validation, probe clamp, outbound prefs, billing strip, failover, paid-empty guard, SSE scrub - offline)
t node scripts/test-llm-messages.js
# Reasoning fitted to the output cap: a buyer effort or budget too high for a small cap is lowered before the call and disclosed, one same-model retry at the lowest effort after an
t node scripts/test-llm-answer-fit.js
# Wire parity: one caller mistake or upstream condition gets the same class of answer on chat completions, Messages, Responses and generateContent, and a metered request that cannot
t node scripts/test-llm-wire-parity.js
# The gateway suites pass on the placeholder cost table too (docs/example-upstream-costs.json; prints exit codes and counts only - offline)
t node scripts/test-example-costs-suites.js
# Availability failover: a model with no live host is served by its same-family successor (named in the reply), model_fallback:false opts out, rate limits retry the same model first
t node scripts/test-gateway-availability.js
# Flight search and status: sellers are config, payTo pinned and capped, no second seller after a payment may have left, spend guard first (offline)
t node scripts/test-flights-kit.js
# Google's native generateContent wire (translation, not a relay)
t node scripts/test-llm-gemini-kit.js
# The CLASS of a 4xx in telemetry, and the promise no buyer text rides with it
t node scripts/test-refusal-reason.js
# OpenAI's transcription wire: the hand-written multipart parser
t node scripts/test-multipart.js
# Cross-origin reads for the machine surfaces (browser-side x402 buyers)
t node scripts/test-cors.js
# Solana revenue scanner (token-balance decode + classification)
t node scripts/test-revenue-scan-solana.js
# USDC settle-receipt network attribution (viaUSDCByNetwork)
t node scripts/test-stats-network.js
# Internal settled calls (canary / Tempo volume) never book as external paid demand
t node scripts/test-stats-internal-paid.js
# WALLET_BLOCKLIST payer matcher (blocked wallets refused pre-settle)
t node scripts/test-wallet-blocklist.js
# Builder Code suffix parser (ERC-8021 round-trip vs @x402/extensions encoder)
t node scripts/test-builder-attribution.js
# Usage report (payment-keyed identity, payer-scoped ledger view, spoof lock — offline)
t node scripts/test-usage.js
# STT margin cap (duration enforced locally before any OpenAI spend — offline)
t node scripts/test-stt-cap.js
# TTS lite tier (Kokoro over OpenRouter): contract parity, the margin bound, refusals (offline)
t node scripts/test-tts-lite.js
t node scripts/test-tts-elevenlabs.js
# TTS per-request quote: anchors, round-up, floor, the served body, refusals before any spend (offline); the margin at every length against the private rows
t node scripts/test-tts-quote.js
t node scripts/test-tts-margins.js
# Dub (translate, then speak): both steps stubbed, uncharged step failures, the cap before any call, language forms, json mode, the price sum (offline)
t node scripts/test-dub-kit.js
# Stellar late-settle confirmation (a confirmed transfer overrides the facilitator; a payment to anyone else never does — offline)
t node scripts/test-stellar-confirm.js
# Stellar one payment, one answer: the signed entry claimed before settle, a re-encoded copy refused, the success-path tx claim, the replay key (offline)
t node scripts/test-stellar-nonce-claim.js
# SVM settle-reason clarity (a measured empty wallet becomes "insufficient_funds"; specific reasons and funded wallets never rewritten — offline)
t node scripts/test-svm-clarify.js
# Refund ledger + planner (idempotent debts, evidence-gated resolution, caps, canary excluded, no silent chain drops — offline)
t node scripts/test-refund-ledger.js
# Outbound new-destination watch (first sighting per chain+recipient, ok/new/burst words, window expiry, file-mode persistence across a restart, word-only public field - offline +
t node scripts/test-outbound-destinations.js
# Refund lookup (exact tx only, unknown == no refund, no payer leak, own rows on my-usage, rate limited - boots its own server)
t node scripts/test-refund-lookup.js
# Refund ledger routes: a full refund run's call burst is never refused; the runner resends only a 429 (boots its own server)
t node scripts/test-refund-ledger-limiter.js
# Daily MPP reconciliation (every mismatch category, unknown never ok, idempotent reruns, words-only public status, operator-only routes — offline)
t node scripts/test-mpp-reconcile.js
# Refund pre-send proof (same payer, our payTo, enough value, on a transaction that actually succeeded — offline)
t node scripts/test-payment-verify.js
# Refund job proves a route-execute debt paid to a spending wallet (the real job, refund.yml's env, stub chains — offline)
t node scripts/test-refund-run-self-funding.js
# Refund job on Tempo and Solana: dry run plans only, claim before send, one send per debt, outbound proof before paid, void never sent (stubs only, offline)
t node scripts/test-refund-run-chains.js
# Payment-header precedence (attribution must follow the header the middleware SETTLES from — offline)
t node scripts/test-payer-header-order.js
# Refund monitor (stuck sends page, in-flight ones do not, and no address ever reaches a public issue — offline)
t node scripts/test-refund-monitor.js
# Model-drift redaction (no dollar figure, bare decimal or exponent reaches the log or issue; stale-high grader on stub rows; offline)
t node scripts/test-model-drift-redaction.js
# Bazaar register verdict (harvester lag is not a failure; a failed or unpaid route is — offline)
t node scripts/test-bazaar-verdict.js
# Bazaar feed read (two full passes must agree, a third on disagreement; only routes absent from every pass are bought; short pages never end a walk, offline)
t node scripts/test-bazaar-twopass.js
# External-buy spend cap (reserve before send; release only on a conclusive on-chain miss — offline)
t node scripts/test-spend-budget.js
# Third-party catalog (disclaimers present, seller strings inert, links nofollowed — offline)
t node scripts/test-index-tools-catalog.js
# Burner-key log guard (agent-e2e never prints a private key on funding timeout; no console.* emits a raw key — offline)
t node scripts/test-burner-log-guard.js
# Algorand rail canary classifiers (upstream/edge outage vs real defect — offline)
t node scripts/test-algorand-canary-classify.js
# Catalog floor invariant (floorViolation — null at ≥400, kit-missing message)
t node scripts/test-sync-count-floor.js
# Self-check semantic invariants are meaningful (good passes, broken fails)
t node scripts/test-invariants.js
# CDP kit unit tests (JWT signing both key formats, validation, faucet gate — offline)
t node scripts/test-cdp-kit.js
# onchain-sql query-count histogram: queries per call by how the response ended, stored as counts only, 35 days kept (offline)
t node scripts/test-sql-query-stats.js
# CDP facilitator config built on the kit's JWT minter (header groups, claims, wire path; offline)
t node scripts/test-cdp-facilitator.js
# Seller-trust honesty invariants (no evidence never reads as a bad verdict; advertised ≠ settled — offline)
t node scripts/test-seller-trust.js
# Seller-dossier honesty invariants (unknown is unknown; inherited wallets named; no score; flags name their evidence — offline)
t node scripts/test-seller-dossier.js
# F-15: what the dossier and the leaderboards publish about NAMED outside businesses
t node scripts/test-third-party-reports.js
# Seller payability check (buys one call from a seller): contract, the spend bound, the wrong-domain case, every refusal (offline stubs)
t node scripts/test-seller-payability.js
# Package integrity (files allowlist covers every import; no sibling dep range excludes what we ship — offline)
t node scripts/test-package-integrity.js
# Published packages retry a shed discovery 503 (bounded, capped, never a paid call) and then name the surface (offline stubs)
t node scripts/test-package-shed-retry.js
# Every SOLD skill pack has a real step config (a pack without one answers 200 with 0/N steps and still charges — offline)
t node scripts/test-skill-pack-steps.js
# Every skill-pack step sends only input keys its tool declares (boots its own FREE_MODE server on port 0)
t node scripts/test-skill-step-inputs.js
# A pack's copy matches its run mode (chain vs fanout); wallet-audit reads a token the wallet holds (offline)
t node scripts/test-pack-copy-modes.js
# The content-pipeline guide and wiki derive the EVM-only, no-Tempo stages from isLongRunningSlug (offline)
t node scripts/test-content-pipeline-guide.js
# Every model-backed tool says so in its description, and World Bank and FRED credits survive the listing cap (boots its own FREE_MODE server on port 0)
t node scripts/test-catalog-honesty-markers.js
# Refund backfill decides who is OWED money: who is in, who is out, idempotent (offline, temp ledgers)
t node scripts/test-refund-backfill.js
# Upstream-spend meter records with PostHog OFF and in exact micro-dollars (offline)
t node scripts/test-upstream-spend.js
# Every model-backed kit outside the chat tiers
t node scripts/test-upstream-spend-meter.js
# Analytics redaction (per-tool table never reaches an unauthenticated caller - seeded, DB not required)
t node scripts/test-analytics-redaction.js
# Reveal-on-scroll no hero flash (the hero must never hide behind opacity:0 waiting on the observer)
t node scripts/test-reveal-no-hero-flash.js
# Revenue buyers series (distinct-count semantics; seeded ledger — offline)
t node scripts/test-revenue-buyers.js
# Circle Gateway batched sales on /revenue (off-chain label, no figure
# with none, a withdrawal mint never counted again; seeded, offline)
t node scripts/test-revenue-gateway.js
# Marketplace activity scan bounds (a paged walk must report the whole window,
# not its own page ceiling; stubbed sources — offline, spends nothing)
t node scripts/test-scan-cap.js
# Market terminal contract (palette resolves + clears WCAG AA in BOTH themes,
# no literal hex, escaping, and a capped scan still reads as a floor — offline)
t node scripts/test-terminal-tokens.js
# Revenue buyers trend (rolling 14d recent-vs-prior comparison — offline)
t node scripts/test-buyers-trend.js
# Per-chain price premiums (fee-charging rails priced in; dormant default byte-identical — offline)
t node scripts/test-price-premium.js
# Per-chain price floors (eip155:4663 never quotes below its floor; other chains unchanged; metered quotes floored; every surface reads one constant - offline)
t node scripts/test-network-floors.js
# Sales and debts book what was paid on the chain (floor, premium, signed EVM amount; other chains unchanged - offline)
t node scripts/test-paid-price.js
# Canary underfunded classification (empty burner is funding, never an outage — offline)
t node scripts/test-canary-underfunded.js
# Catalog buy (every tool bought at list price: grade, cap, rotation slice, funding preflight, exit codes - stub server + fake payer, offline)
t node scripts/test-catalog-buy.js
# Buy scripts honor the slow-route contract (respond-async up front, job followed, a failed job fails, one 400 respond_async_required fallback - stub server, throwaway signing key, offline)
t node scripts/test-slow-route-buy.js
# Catalog buy answers into examples: trimming, redaction, host/address guards, the never-overwrite merge rule, the enhancement report (synthetic captures, offline)
t node scripts/test-catalog-buy-examples.js
# Captured examples render where buyers read them: /openapi.json and the tool page carry the example, its date and model label (FREE_MODE boot on a free port)
t node scripts/test-captured-examples-render.js
# Payer identity (reads X-PAYMENT + legacy header; rejects unsigned/invalid — money-path regression lock — offline)
t node scripts/test-payer.js
# Payment rail scoping (A402-03 identity routes EVM-only; every other tool keeps all chains — offline)
t node scripts/test-payment-identity-rails.js
# Egress proxy validate+pin (F04 — proxy refuses CONNECT to loopback/RFC1918/metadata/ULA; Chromium can't rebind to a private dest — offline)
t node scripts/test-egress-proxy.js
# E2B cost/output caps (F12 — aggregate UTF-8 output truncation + global sandbox concurrency ceiling — offline)
t node scripts/test-code-run-caps.js
# Safe-regex guard (rejects ReDoS patterns for caller-supplied regexes — DoS lock — offline)
t node scripts/test-safe-regex.js
# Sales ledger unit tests (named sales, internal/external classification, revenue math — offline)
t node scripts/test-sales-ledger.js
# Weekly outside MPP agents: counts only, internal excluded, new vs returning over all history, operator-only route
t node scripts/test-mpp-agents-weekly.js
# Arrival path per sale (mcp, client package, http) on the operator surfaces; sweep/burst cohorts; the Gateway test buyer is ours
t node scripts/test-sale-path.js
# First-call allowance returning payers (operator view): granted wallets with a later outside paid sale, and within 7 days; one batched ledger read, cached (offline, temp SQLite ledger)
t node scripts/test-first-call-allowance-returned.js
t node scripts/test-attest-kit.js
# One mirror pull in flight; a fresh lookup during a running pull waits and pulls again (offline)
t node scripts/test-single-flight.js
# Repo-wide: no count-named field is the length of a LIMITed query result (source scan, offline)
t node scripts/test-capped-counts.js
# Every published figure carries its own scope: a capped, sampled, windowed or filtered
# number must say so in a machine-readable field, never only in prose (offline)
t node scripts/test-figure-scope.js
t node scripts/test-proof.js
# Tempo relay verdicts are visible (non-2xx relay status + body reach the rejection log, per-request — offline)
t node scripts/test-mpp-tempo-relay-errors.js
# A keyed broadcast the relay refuses for its validBefore is re-sent once without the key (offline)
t node scripts/test-mpp-tempo-idempotency-policy.js
# Tempo settlement mode: TEMPO_RELAY=off never calls the relay; unset keeps it (offline)
t node scripts/test-mpp-tempo-direct.js
# mppx's own Tempo charge replay claims sit in one store per process, redis-backed when configured
t node scripts/test-mppx-store.js
# Every Tempo server method constructs under a production runtime (mppx refuses one with no store there)
t node scripts/test-mppx-production-store.js
# Tempo direct mode screens every payment party against the OFAC SDN list before money moves (fixture list, offline)
t node scripts/test-sanctions-screen.js
# An x402 payer on the same EVM set is refused after verify and before the handler, nothing settles; no list serves (paid-mode boot vs stub facilitator - offline)
t node scripts/test-x402-payer-screen.js
# workflow_run references name a workflow that exists (GitHub matches on name:, a mismatch never fires - offline)
t node scripts/test-workflow-run-refs.js
# Every workflow job names a versioned runner image, never a moving -latest label (offline)
t node scripts/test-workflow-runner-pins.js
# Workflow trust gates (workflow_run jobs need a push run of this repo; PyPI build has no id-token; wish text fenced)
t node scripts/test-workflow-trust-gates.js
# Metered settlement pricing rule (upto only, never above the ceiling, missing cost is not free - offline)
t node scripts/test-gateway-meter.js
t node scripts/test-metered-quote-binding.js
t node scripts/test-model-catalog.js
# Metered settlement is wired and fails safe (sentinel never reaches a buyer - offline)
t node scripts/test-gateway-meter-wiring.js
# Payment scheme is read where @x402/core actually puts it (v1 top-level vs v2 accepted - pins the INSTALLED dep, offline)
t node scripts/test-payer-scheme-shape.js
# Supply-chain guards (npm publish token never shares a step with code execution; no consumer-install hooks; files-allowlist only; remote installs pinned + scriptless — offline)
t node scripts/test-supply-chain-guards.js
# Third-party behavioural scan of what we SHIP and what ships with it.
# The offline guard above proves our own repo is sane; this asks Socket
# whether any dependency has started behaving like malware since the last
# run - the question a static self-audit cannot answer. Blocks only on
# critical/high; a Socket outage or exhausted quota warns loudly and does
# NOT block (their uptime is not our release gate).
# Wallet E2E offline leg (keygen + leak audit; funded on-chain flow runs in paytest)
t node scripts/test-wallet-e2e.js
# MCP Registry find-latest-version helper (used by the publish job to auto-deprecate a superseded version — offline)
t node scripts/test-mcp-find-latest-version.js
# FFmpeg video-decode lockout (R-06: every ffmpeg and ffprobe call passes an audio-only -codec_whitelist before -i, so the MagicYUV video decoder never opens; offline)
t node scripts/test-ffmpeg-novideo.js
# Log-injection guard (F24 — CR/LF + ANSI + control chars stripped from attacker-controlled log text — offline)
t node scripts/test-log-safe.js
# Postgres TLS policy by route (F11 — verified cert on public hosts, relaxed only on the private railway.internal mesh — offline)
t node scripts/test-db-ssl.js
# Local SQLite fallback contract: the stats and memory stores report persistence honestly and fail loud in prod without durable storage
t node scripts/test-stats-persistence.js
# Several processes opening one fresh SQLite store at once all boot (WAL switch retried on SQLITE_BUSY - offline)
t node scripts/test-stats-concurrent-open.js
# Buyer SDK response-size ceiling (refused before parsing; a paid oversize says it was paid - offline)
t node scripts/test-client-response-cap.js
# Long-running routes are EVM-exact-only by ONE definition (server and the AVM sweep agree - offline)
t node scripts/test-long-running-parity.js
# Buyer SDK spending caps (concurrency reservation + 402-amount inspection — wallet-safety lock — offline)
t node scripts/test-client-caps.js
# PDF toolkit tests (merge/split/rotate/info/images-to-pdf)
t node scripts/test-pdf.js
# Demand-kit tests (pdf-to-markdown)
t node scripts/test-demand.js
# Media-kit tests (ffprobe, mp4-to-mp3, loudnorm — real ffmpeg)
t node scripts/test-media.js
# Finance-math-kit tests (TVM, Black-Scholes, bonds, CAGR, Sharpe — vs textbook values)
t node scripts/test-finance-math-kit.js
# Barcode-kit tests (QR/barcode decode round-trip, PNG + JPEG)
t node scripts/test-barcode.js
# Lazy tool dependencies stay out of the boot graph; first call of each tool still answers (boots a server)
t node scripts/test-lazy-deps.js

# @step 2: Offline suites (42 scripts, one process each)
# Demand-radar seller intel (signalType, near-threshold, noise flag, wallet-only — offline)
t node scripts/test-demand-radar.js
# Correctness corpus harness (expectation checking + outcome classification, offline)
t node scripts/test-corpus-harness.js
# Correctness corpus, tier 0: every pure-CPU tool on a SECOND input, values asserted (self-booted FREE_MODE, ~3 s)
t node scripts/test-corpus.js --tier 0 --concurrency 6
# Cross-surface pairs: pricing/openapi/manifest/models/route/find/wishes/radar must agree (self-booted FREE_MODE)
t node scripts/test-cross-surface.js
# MPP discovery offers and the live 402 tempo challenge share one predicate (offline)
t node scripts/test-mpp-discovery-agreement.js
# /openapi.json payment prose (MPP rails per route, creditsKey) read from the 402's own config (offline)
t node scripts/test-openapi-mpp-clause.js
# Util-kit tests (geo-distance)
t node scripts/test-util-kit.js
# webhook-verify: per-provider HMAC vectors, tamper, replay tolerance, secret never echoed (offline)
t node scripts/test-webhook-verify.js
# Burner sweep sizing: per-buy amount from the live 402, buys from the excess over the float (offline, no spend)
t node scripts/test-sweep-burner.js
# x-data kit (offline)
t node scripts/test-x-data-kit.js
# x-search-recent author and post histogram: counted on the final response, counts only (offline)
t node scripts/test-x-search-stats.js
# x-data daily ceilings: served past the alarm ceiling, refused at the hard one, 0 refuses all, both observers page (offline)
t node scripts/test-x-data-ceilings.js
# Router per-minute spend ceilings: a purchase past the alarm ceiling is made and the word reads over, the stop refuses 429 before signing, the word clears after its hold, 0 refuses
t node scripts/test-router-spend-window.js
# Exa kit (env-gated on EXA_API_KEY; offline, stubbed fetch, nothing spent)
t node scripts/test-exa-kit.js
# Exa daily ceilings: served past the alarm ceiling, refused at the hard one, 0 refuses all, allowance word untouched, both observers page (offline)
t node scripts/test-exa-ceilings.js
# b2b-enrich kit (offline)
t node scripts/test-b2b-enrich-kit.js
# Ox Alpha free-trial safety (fails closed on a repriced upstream, offline)
t node scripts/test-ox-trial.js
# OpenRouter attribution + composite accounting guard (offline)
t node scripts/test-openrouter-attribution.js
# alchemy-data kit (offline)
t node scripts/test-alchemy-data-kit.js
# llm-context kit (Brave grounding context, stubbed fetch, no live Brave call, offline)
t node scripts/test-llm-context-kit.js
# search-lite (Brave web search sample: validation + output shaping, stubbed fetch, no live Brave call, offline)
t node scripts/test-search-lite.js
# Paid-upstream leak guard (Brave + E2B — every metered route/pack must be skipped — offline)
t node scripts/test-brave-leak.js
# Derived CI-spend exposure: every paid key a TEST lane can reach must have its slugs bounded
t node scripts/test-ci-key-exposure.js
# Daily call budgets for every paid upstream (Brave, Alchemy, CoinGecko, OpenAI, E2B, Neynar, Exa)
t node scripts/test-upstream-budgets.js
t node scripts/test-upstream-hard-caps.js
# /api/gateway-status is public: verdicts only, never limits or balances
t node scripts/test-gateway-status-privacy.js
# An owed card report refund reads on the refundsOwed word (a server boot on the file backends)
t node scripts/test-refund-owed-card.js
# Redis persistence as one word (INFO persistence parse, the monitor, the journal gate on a stub client, the heartbeat and Worker legs - offline)
t node scripts/test-redis-persistence.js
# SQL execution-certificate firewall (risk catalogue, false-positive guards, cert binding — offline)
t node scripts/test-sql-guard.js
# Whois RDAP bootstrap parser (IANA dns.json → TLD map — offline)
t node scripts/test-whois-bootstrap.js
# B20 decode unit tests (offline, synthetic logs in both indexed layouts)
t node scripts/test-b20-decode.js
# Base activity via CDP SQL — guard/fail-safe paths (offline)
t node scripts/test-base-activity.js
# Tools catalog page tests (offline, fixture snapshot)
t node scripts/test-catalog-page.js
# Skill packs index page tests (offline, live SKILL_PACKS data)
t node scripts/test-skills-index-page.js
# Docs GitBook unification tests (offline, real wiki content)
t node scripts/test-docs-gitbook.js
# Operator revenue visibility (zero-revenue rail flagging + top-by-revenue vs top-by-calls, offline)
t node scripts/test-operator-revenue-visibility.js
# MPP marketplace page rendering tests (offline)
t node scripts/test-mpp-market-page.js
# Agent wish loop tests (caps, dedup clustering, rate limits, file cap, aggregate shape — offline)
t node scripts/test-wish.js
# Wish-board intent judgment: no key means no calls, a failing upstream changes no row, and no verdict can move a count (offline, stubbed)
t node scripts/test-wish-classify.js
# Discovery re-rank: build-vs-alias verdicts, no key means no calls, adverts never reach the build list, /api/find untouched (offline, stubbed)
t node scripts/test-discovery-rerank.js
# Typed judgment tool: the input caps ARE the margin guard, upstream bodies never reach the buyer, model-backed is declared (offline, stubbed)
t node scripts/test-judge-kit.js
# Loop gate: budget and iteration stops in code at the same price, repeats and near-identical outputs found lexically, every refusal a 400 and every model failure an uncharged 5xx,
t node scripts/test-loop-gate.js
# Judgment backends: order, the private-table bound on Luna, one answer shape per route, /v1/decisions wire (offline, stubbed)
t node scripts/test-judge-luna.js
t node scripts/test-judge-preview.js
# Decision-1: the shared client, the internal fallback at every Jev call site, the third paid backend and its private-table bound (offline, stubbed)
t node scripts/test-decision-one.js
# Wish-board input hygiene (a client bug is not market demand)
t node scripts/test-wish-hygiene.js

# @step 3: Offline suites (4 scripts, one process each)
# Chain names (a rail we take money on must not report as a hex id)
t node scripts/test-chain-names.js
# FX failover (a fallback that only fires on ERROR cannot rescue SLOW)
t node scripts/test-fx-failover.js
# Metered upstreams (nothing that bills per call is reachable unbounded)
t node scripts/test-metered-upstreams.js
# Router gate needs breadth, not just a manufacturable count
t node scripts/test-sor-breadth.js

# @step 4: Offline suites (10 scripts, one process each)
# Rate limits are per-process; replicas must not multiply them
t node scripts/test-limiter-replicas.js
# Every test script is wired into CI (no orphaned suites)
t node scripts/test-ci-coverage.js
# EVM/Solana/Robinhood activity scan tests (offline, fixture Alchemy/RPC/Blockscout records)
t node scripts/test-chain-activity.js
# Compression-kit tests (gzip, gunzip, brotli, compress-compare — pure CPU, zip-bomb guard)
t node scripts/test-compression-kit.js
t node scripts/test-model-retirements.js
t node scripts/test-slow-origins.js
# Stats-kit tests (summary, correlation, regression, moving-average, outliers — pure CPU)
t node scripts/test-stats-kit.js
# Tollbooth atomic replay + origin binding (F05/F18 — Durable Object single-use claim + PoW origin/method binding — offline)
t node scripts/test-tollbooth-replay.js
# Tollbooth verifier timeout/cancellation (FR4-10 — x402VerifierFromExpress honors the AbortSignal; a late settle can't grant — offline)
t node scripts/test-tollbooth-verifier.js
# WordPress tollbooth plugin (static: skip rule reads what WordPress serves; verifier pass must be HMAC-bound to the request)
t node scripts/test-wp-tollbooth-plugin.js
