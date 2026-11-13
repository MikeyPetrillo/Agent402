# Test list for the test-unit-a4 lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-unit-a4 N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (18 scripts, one process each)
# Offsite backup (stub S3 — consistent sqlite snapshots, cache excluded, budget holds visibly, bill guard refuses over-cap, retention prunes date prefixes — offline)
t node scripts/test-backup.js
# backup-restore.js gives back every object shape the nightly run writes (offline)
t node scripts/test-backup-restore.js
t node scripts/test-dataset-snapshot.js
t node scripts/test-dataset-health.js
t node scripts/test-price-parse.js
t node scripts/test-receipts.js
t node scripts/test-feedback-kit.js
t node scripts/test-chain-namespace.js
t node scripts/test-standing-band.js
t node scripts/test-wish-reports.js
t node scripts/test-x402-spend-controls.js
t node scripts/test-x402-boot-init.js
# The vendor's per-route bazaar check runs after boot in short slices, never as one boot-time loop.
t node scripts/test-bazaar-route-check.js
# The strict sweep reports a listed keyless upstream's 5xx refusal; our own 5xx still fails.
t node scripts/test-sweep-upstream-refusal.js
# A Solana intel read that outlives its deadline answers a 503 naming the upstream and the step on the real route, inside the handler budget (stubbed upstreams).
t node scripts/test-solana-intel-deadline.js
# Every kit that reads an upstream: a stalled read ends at its cap, composed with the handler budget, as the shared 503 class naming the upstream and the step (stubbed fetch, short budget).
t node scripts/test-upstream-deadline.js
# Whose failure an error names: our own 500, limit, budget, key or allowance is ours; a caller URL that did not answer is told to check it or retry; a router leg our clamp cut is
t node scripts/test-error-attribution.js
t node scripts/test-solana-kit-deps.js
t node scripts/test-workflow-client-pins.js

# @step 2: Offline suites (62 scripts, one process each)
# images-fast kit (offline)
t node scripts/test-images-fast-kit.js
# Index openapi-fallback crawl tests (payment-signal gate, Bazaar merge, ranking — offline)
t node scripts/test-openapi-fallback.js
# Producer/consumer shape contract (no consumer reads a field nothing emits)
t node scripts/test-producer-shapes.js
# Human checkout (no free report, generate-once, auto-refund)
t node scripts/test-human-checkout.js
# OpenAI Responses wire on the five tiers (validation, server-tool refusal, store:false, reasoning defaults, nested usage scrub - offline)
t node scripts/test-llm-responses.js
# Server tools (pinned engines, buyer cannot widen the cap, loop priced into the margin - offline)
t node scripts/test-server-tools.js
# Algorand external router (chain-matched settlement, accept pinning, catalog ranking, AVM buyer gating — offline)
t node scripts/test-algorand-router.js
# Algorand payTo binding: every candidate is paid only at the address its proof was counted at; no address, not dispatched (offline)
t node scripts/test-algorand-payto-proof.js
# Solana external routing: accept pinning (devnet never matches), env gate, pay-time proven-seller gate fails closed, offline e2e signed buy vs stub seller + stub RPC
t node scripts/test-solana-router.js
# PayAI Solana listing sweep: the diff between the routes sold on Solana and the registry's rows, from fixtures (offline)
t node scripts/test-payai-solana-sweep.js
# Listing coverage per registry and chain from fixtures; the PayAI pass's selection, cap and preflight (offline)
t node scripts/test-listing-coverage.js
t node scripts/test-payai-listing-pass.js
# The listing pass's purposeful inputs validate against each route's published input schema (booted FREE_MODE, offline)
t node scripts/test-listing-inputs.js
# Multipart routes publish multipart/form-data on /openapi.json
t node scripts/test-multipart-openapi.js
# Per-request facilitator preference: honored only with the operator token, the 402 byte-identical otherwise, verify and settle at the named facilitator (booted, two stub
t node scripts/test-settle-preference.js
# Tool resolver (/api/find ranking, guards)
t node scripts/test-find.js
# Reader searches find the article extractor through its aliases, on the real catalog (booted free-mode server)
t node scripts/test-find-reader-aliases.js
# Discovery gate: every compute under a deadline, slot released, self-healing in-flight count, perf fields (booted, offline)
t node scripts/test-discovery-deadline.js
# Search refusals: counted by route, rule and keyed client digest, capped with exact totals, kept 8 days, operator route, 429 fields (booted, offline)
t node scripts/test-discovery-refusals.js
# Router worker pool: worker answers equal in-thread, /health stays fast under a burst, crash and deadline recovery, refresh reaches the worker (offline, boots a server from the fixture)
t node scripts/test-router-worker.js
t node scripts/test-router-worker-prod-boot.js
t node scripts/test-route-index-compaction.js
t node scripts/test-health-router-warming.js
t node scripts/test-plan-sketch.js
# Report synthesis: a length stop is retried once, then trimmed to a complete block and marked (offline)
t node scripts/test-report-synthesis.js
# boundedSchema: a 402's discovery input schema trimmed to a byte budget, descriptions first (offline)
t node scripts/test-bounded-schema.js
# MTA-STS policy text is well-formed for any configuration (offline)
t node scripts/test-mta-sts.js
# Unicode-aware query tokenization shared by /api/route, /api/find and the index search: CJK bigrams, short-Latin whole-token rule kept (offline)
t node scripts/test-query-terms.js
# Revenue ledger unit tests (all-time external accounting, idempotent rescans, CI self-gate)
t node scripts/test-revenue-ledger.js
# Every getLogs reader narrows on each result-cap wording a node has sent
t node scripts/test-logs-cap-wording.js
t node scripts/test-block-clock.js
# Base block time across Denim (2 s to 200 ms): windows stay the same wall-clock length (offline)
t node scripts/test-chain-block-time.js
t node scripts/test-payai-credit-watch.js
# Heartbeat security advisory triage check: script vs a stub GitHub API, and the step's shell with gh stubbed (offline)
t node scripts/test-advisory-triage.js
# Heartbeat 7-day MPP reconciliation window step, run with curl/gh stubbed (offline)
t node scripts/test-heartbeat-mpp-window.js
t node scripts/test-revenue-fresh-recent.js
t node scripts/test-chain-page-own-settle.js
t node scripts/test-revenue-cold.js
# The live rail scan runs once per period across containers (lease + shared snapshot, adopted at boot); cadences default to 4 hours and the copy says so (injected scan/store/lease - offline)
t node scripts/test-revenue-shared-scan.js
# The paged Tempo read equals the one-query read it replaced: same rows once each, same sum, (ts, id) order, with ties across page boundaries (offline)
t node scripts/test-tempo-paging-oracle.js
# Settle-fallback chain (Solvador first on its advertised networks -> PayAI -> Solvador last resort; double-settle gate between fallbacks - offline)
t node scripts/test-settle-fallback.js
# A listed Robinhood settle fallback is tried only after its /supported confirms eip155:4663 (paid-mode boot vs stub facilitators - offline)
t node scripts/test-rh-fallback-confirm.js
# Robinhood boot order: the first listed facilitator whose /supported confirms eip155:4663 settles first; a 200 refusal in words with no verdict goes to the next listed, a verdict
t node scripts/test-rh-boot-primary.js
# Ink (eip155:57073) rail, graduated into RAILS: unconfigured without INK_FACILITATOR_URL (paywall intact); enabled, the 402 offers native USDC with the "USDC" v2 domain at the
t node scripts/test-ink-rail.js
# Ink graduated: in RAILS right after Arc, /ink serves with the payTo's explorer link, and every surface (nav, strip, chain list, llms.txt, openapi, manifest, pricing, sitemap)
t node scripts/test-ink-graduation.js
# Every 402 fits with Ink graduated: worst routes project 300+ bytes under 16,200 total header bytes; a 402 exposes exactly the listed headers it carries; the MPP evm challenge
t node scripts/test-challenge-fit.js
# Robinhood refusals in words: no-verdict passes to the next listed before our relayer and is read on chain when none settles; buyer verdicts retried nowhere; 5xx and other networks
t node scripts/test-rh-prose-refusal.js
# A settle failure that names a transaction is booked and read from the chain
t node scripts/test-late-settlements.js
# A pending settle answer naming a tx is read on chain first
t node scripts/test-pending-settle.js
# Our own Robinhood settler: our sales only, verify refusals, one nonce per relayer across replicas, a never-mined send stops the chain, listed facilitators first, gas check,
t node scripts/test-own-relayer.js
# Robinhood settle order follows the listed facilitator's relayer gas: dry -> our relayer first, funded -> facilitator first, unread never moves it (offline)
t node scripts/test-robinhood-order.js
# robinhoodSettler: relayer once our relayer has settled first past ROBINHOOD_RELAYER_FIRST_ALERT_HOURS, ok shorter or after the facilitator is first again, off disabled; the stored
t node scripts/test-robinhood-settler.js
# subscriptionRenewals: gateway-status carries the engine's word (full only for the operator, off without an engine); heartbeat and Worker page on unconfirmed, close on ok / off (offline)
t node scripts/test-subscription-renewals.js
# Robinhood outage: an ambiguous facilitator failure is read on chain (used with our transfer -> served once; unused -> our relayer; read failure -> 402 and the authorization booked
t node scripts/test-rh-outage.js
# Arc rail via Circle's facilitator: Arc-only /supported, reduced errors (no key or upstream body anywhere), cross-chain refusal, fail-closed boot (offline stubs)
t node scripts/test-arc-rail.js
# The issuer's facilitator as the last Base/Polygon settle fallback
t node scripts/test-circle-evm-fallback.js
# Render actual-byte budget (F03 — chunked/streamed/headerless/WebSocket bytes counted via CDP, cap not bypassable — offline)
t node scripts/test-render-bytebudget.js
# Tempo chain-truth confirm (relay says failed but the credential's tx settled -> serve the buyer; pinned on the real incident tx — offline)
t node scripts/test-tempo-confirm.js
# Durable Tempo late-landing watches: failed reads kept, a day of failures dropped with an error, bounded list, in-process removal only once answered (offline)
t node scripts/test-tempo-late-watches.js
# Leaderboard RPC failures never carry the Alchemy key (host-only naming + redaction on the public lastError path — offline)
t node scripts/test-leaderboard-redaction.js
t node scripts/test-leaderboard-price-match.js
t node scripts/test-price-known.js
# Every reader of a crawled row's price reads labels, numbers and objects through src/price-usd.js (offline, real row shapes)
t node scripts/test-price-label-readers.js
# /api/revenue error strings never carry the Alchemy key, and the transaction surfaces keep their scraping bound (offline + source pins)
t node scripts/test-revenue-redaction.js
# The public source link is read from one constant, so moving the repo off a personal account stays a one-line change (offline)
t node scripts/test-repo-link.js
# Surface copy gate (every package, README, wiki page, connector string and machine surface names Agentic Finance + both wires - offline)
t node scripts/test-surface-copy.js
# The lead sentence and category line (src/positioning.js) on the home hero, llms.txt, both MCP connectors, the READMEs and package descriptions (offline)
t node scripts/test-positioning.js
# Leaderboard SEO/discovery surfaces (robots, sitemap, llms.txt, manifest, landing JSON-LD)
t node scripts/test-leaderboard-surface.js
# filing watch kit (offline)
t node scripts/test-filing-watch-kit.js
# Persistent upstream meter (day buckets, caller split, restart survival — offline)
t node scripts/test-upstream-meter.js
# Base/Solana/Polygon/Arbitrum/Robinhood marketplace page tests (offline, fixture snapshot)
t node scripts/test-market-pages.js
# Leaderboard page tests (offline, fixture snapshot)
t node scripts/test-leaderboard-page.js
# MPP index self-serve registration + snapshot honesty tests (offline)
t node scripts/test-mpp-index.js

# @step 3: Offline suites (23 scripts, one process each)
# Ledger-backed rail transfers (empty ledger must fall back, never render zero)
t node scripts/test-ledger-recent.js
# The shared HTML escapers escape the single quote; leaderboard notes are escaped per note
t node scripts/test-escape-quotes.js
# The document CSP's form-action allows only this origin and mailto:, and every form in the tree submits inside it
t node scripts/test-csp-form-action.js
# The report page's image preview src comes only from an allowlisted image type and a plain base64 payload
t node scripts/test-report-view-image.js
# The STATUS_PROBE_TOKEN comment names every route that accepts it, and the value is read once
t node scripts/test-status-probe-token-scope.js
# /api/revenue publishes no payer address and no outside buyer's tx hash
t node scripts/test-revenue-no-payers.js
# /api/revenue publishes no wallet balance; the operator view keeps them
t node scripts/test-revenue-no-balances.js
t node scripts/test-revenue-memo-chain.js
# Html-kit tests (html-select, html-table, html-strip, html-links, html-meta)
t node scripts/test-html-kit.js
# Bazaar quality ingestion (30d calls/payers on index sellers + /api/find external rows + ranking tiebreak - offline)
t node scripts/test-bazaar-quality.js
# A seller field that is not text (a number, object or array name, tags as a string) routes without throwing
t node scripts/test-seller-field-types.js
# A stored index of sellers with non-text fields boots and serves every seller page and API; entries are cleaned as the cache stores them
t node scripts/test-seller-field-types-serve.js
# A route's off-seller verdict is decided from its text and equals the parsed answer for every input
t node scripts/test-off-seller-route.js
# The index keeps at most INDEX_SELLER_TOOL_CAP tools per seller, described first, in one funnel
t node scripts/test-seller-tool-cap.js
# A throw inside a scheduled turn (the drain, a shadow rebuild) or inside one seller's listing is contained: the process stays up, the other sellers answer, the counts reach the
t node scripts/test-crash-containment.js
# Every setImmediate/setTimeout/setInterval callback in the index module and the server runs under contained() or is allowlisted with a reason
t node scripts/test-contained-turns-sites.js
# /api/route ordering: route-order.js pinned to the comparator, read by why.tiebreaks and the ranking sentence (offline)
t node scripts/test-route-order.js
# Revenue detector classification (real x402 buys vs funding/tests)
t node scripts/test-revenue-scan.js
# Revenue daily series (day bucketing, EVM block estimation, canary-vs-funding split — offline)
t node scripts/test-revenue-daily.js
# New-tool coverage lock (The 500 slugs swept by test-all; canary leg prices honest — offline)
t node scripts/test-canary-coverage.js
t node scripts/test-canary-refusal-classify.js
# Self-listing exclusion (crawled agent402.tools origin never appears as an "external" seller — offline)
t node scripts/test-self-listing-exclusion.js
# OCR crash containment (A402-10 malformed image returns clean error, no uncaughtException — tesseract worker)
t node scripts/test-ocr-crash.js
# OCR language workers stay under their cap, evicted ones are terminated, data is read only from the local directory
t node scripts/test-ocr-workers.js
# Secretless worker isolation (F02/F04/F06 — worker auth/dispatch, client round-trip, secret-guard refuses to boot with a payment secret — offline)
t node scripts/test-worker-isolation.js
# Render-worker wake retries (connection refused / edge 502 while the worker starts are retried in the deadline; a worker answer is final - offline)
t node scripts/test-worker-wake-retry.js
# Published examples that a tool fetches name a page that exists (no path on a reserved example host - offline)
t node scripts/test-example-urls-fetchable.js
# RugCheck-backed tools pause on consecutive RugCheck outages: free 503 + Retry-After before any gate, fail open after the cool-down (offline)
t node scripts/test-rugcheck-pause.js
# MPP recurring subscriptions (tempo/subscription challenge shape, binding refuses forged/foreign/expired/underpriced before any settlement, period accounting, dunning, cancellation
t node scripts/test-mpp-subscriptions.js
# An MPP subscription's signing key is deleted when the subscription is canceled or ends
t node scripts/test-mpp-subscription-key-lifetime.js
# MPP subscription payers are screened before the first payment and before each renewal
t node scripts/test-mpp-subscription-screen.js
# Subscription gas sponsor: a rolling 24 h count and fee ceiling refuses a sponsored send past it before the RPC (offline, stub RPC)
t node scripts/test-tempo-sponsor-ceiling.js
# Tempo buyer: a minted credential must move exactly the capped quote to the checked recipient, refused before it is sent; our paying scripts sign tempo/charge under the per-call
t node scripts/test-tempo-credential-check.js

# @step 4: Offline suites (26 scripts, one process each)
# MPP leaderboard (live-offer recipients via mppx codec, one batched Tempo getLogs per chunk, grouping/ranking/priming, split-on-error + stale-keeps-previous, page badges - offline)
t node scripts/test-mpp-leaderboard.js
# Agent-kit tests (token-count, text-chunk, json-validate, jsonl)
t node scripts/test-agent-kit.js
# Bestsellers catalog-demand tool (lenses, trend windows, organic score, window-query filters, wallet-only — offline)
t node scripts/test-bestsellers.js
# Nav chain roster (every live rail in dropdown + mobile menu — offline)
t node scripts/test-nav-chains.js
# Sell hub page tests (offline, fixture snapshot)
t node scripts/test-sell-page.js
# Marketplace index page tests (offline, fixture snapshot)
t node scripts/test-marketplace-index-page.js
# Router alias-collapse tests (redirect aliases, subset guard, Sybil slots — offline)
t node scripts/test-router-alias.js
# Reliability claims (a published guarantee must survive being checked)
t node scripts/test-reliability-claims.js
# Four false absolutes (a claim must stay true as the service widens)
t node scripts/test-copy-absolutes.js
# The router and decide execute are described as buying from sellers and reselling (copy, tags, terms; offline)
t node scripts/test-resale-copy.js
t node scripts/test-mcp-dockerfiles.js
# Both images print npm's debug log when npm ci fails and keep its exit code (runs the install group under /bin/sh with a stub npm)
t node scripts/test-dockerfile-npm-log.js
# Every tracked Dockerfile's node base runs one Node patch, pinned by digest; the tollbooth image runs as node (offline)
t node scripts/test-dockerfile-node-patch.js
# Buyer packages price quotes from one known-asset table: copies identical, table matches the rails (offline)
t node scripts/test-known-assets.js
# Distrusted intermediate CA refusal: published hashes, every copy, live TLS legs (offline, port 0)
t node scripts/test-tls-distrust.js
# tls-cert's own lookup: a resolver that cannot answer is a retryable 503, a missing name the neutral 400 (stubbed resolver, offline)
t node scripts/test-tls-cert-lookup.js
# A cached repeat's "payment is not charged" copy names the Tempo transfer exception (offline)
t node scripts/test-cache-repeat-copy.js
t node scripts/test-legal-dates.js
# Legal, security and machine copy state what the code does (backups, refunds, CSP, MPP chains; offline)
t node scripts/test-legal-claims.js
# /trust and the /company contact block state only what the code runs (offline)
t node scripts/test-trust-page.js
# Sentences a review found contradicting the code, pinned to its constants
t node scripts/test-copy-truth.js
# FACILITATOR_PUBLIC_INDEX_CHAINS: the privacy paragraph and terms pointer appear only for the listed chains, with their exact wording (offline)
t node scripts/test-public-index-copy.js
t node scripts/test-wire-count-copy.js
t node scripts/test-chain-list-copy.js
t node scripts/test-pack-copy-retired.js
# Retired hosted tollbooth: no surface offers it; retired URLs 301, the intake 410s; the operator leads page is gone (boots a server)
t node scripts/test-tollbooth-cloud-retired.js
t node scripts/test-sitemap-superset.js
# Published SDK snippets never let the SDK send an environment credential to our host
t node scripts/test-sdk-snippet-credentials.js
t node scripts/test-plugin-manifests.js
# Docs that state a requirement match the engines that enforce it
t node scripts/test-doc-claims.js
# The cheap EVM token-safety verdict (unknown is never counted as safe)
t node scripts/test-token-safety.js
# Index seller count is not instance-inflated (origins vs operators)
t node scripts/test-index-inflation.js
# Tollbooth dashboard runtime smoke (boots CLI, hits /__tollbooth + /__tollbooth/stats over HTTP)
t node scripts/test-tollbooth-runtime.js
