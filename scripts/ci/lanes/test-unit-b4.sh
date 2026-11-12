# Test list for the test-unit-b4 lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-unit-b4 N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (35 scripts, one process each)
# "Router Sybil resistance (M6 — Attack IV: per-seller diversity cap, metadata-injection listings dropped)"
t node scripts/test-router-sybil.js
# Data-kit tests (barcode-lookup, fx-rate, weather-forecast — live keyless APIs)
t node scripts/test-data-kit.js
# Index self-serve registration tests (offline)
t node scripts/test-index-register.js
# Path-scoped sellers: an app under a prefix on a shared host (offline, crawl seam)
t node scripts/test-path-scoped-sellers.js
# Live probes go to the origin a seller's manifest is served from; a same-host https upgrade is re-asked once (offline, loopback)
t node scripts/test-index-probe-redirect.js
# A failed paywall verdict expires and is re-probed; a registration probes at once (offline, loopback)
t node scripts/test-index-paywall-recheck.js
# re-registration re-check: per-origin window + hourly route allowance
t node scripts/test-register-recheck-cooldown.js
# A registration answers by its deadline (202 pending) and stops starting probes past it.
t node scripts/test-index-register-deadline.js
# Settlement-derived proven-ness + discovery-gap honesty
t node scripts/test-settlement-proof.js
# "A venue with many payees is not one seller (multi-payTo index — offline)"
t node scripts/test-multi-payto.js
# Cert-transparency crt.sh→certspotter fallback (flaky-upstream resilience)
t node scripts/test-cert-transparency.js
# Revenue chart free-tier lane (free calls never priced as revenue; jsdom — offline)
t node scripts/test-revenue-chart.js
# Revenue date ranges (parser, ranged daily APIs with 400s, first-paint window, URL round trip; fixture ledger, port from the kernel, offline)
t node scripts/test-revenue-range.js
t node scripts/test-revenue-live-refresh.js
# MPP-by-rail Last settled: date only, "ours" when the newest settlement is ours (offline)
t node scripts/test-revenue-mpp-last.js
# Prices quoted in PROSE match real prices (meta + og descriptions, which docs-truth cannot see - offline)
t node scripts/test-price-prose.js
# "Live 402 quote (a priceless row learns its price from the challenge; unpriceable never becomes $0; PUT/PATCH/DELETE never probed — offline)"
t node scripts/test-x402-live-quote.js
t node scripts/test-live-quote-method-refused.js
t node scripts/test-live-quote-query-params.js
t node scripts/test-live-price-adopt.js
t node scripts/test-live-quote-body-redirect.js
t node scripts/test-probe-example.js
t node scripts/test-proto-pollution-guard.js
t node scripts/test-tool-judge.js
# Free /api/route judged answers are bounded per caller (boots a free server against a stub judgment endpoint - offline)
t node scripts/test-route-judge-limit.js
t node scripts/test-route-conversion.js
# A route that went free retires its learned price (issue #1365: re-register re-asks priced rows, GET 200 retires, carry-forward keeps it over the Bazaar snapshot - offline)
t node scripts/test-quote-retired-on-free.js
# A route the seller answers 410 Gone leaves the index and stays out across the Bazaar merge (offline)
t node scripts/test-gone-routes.js
# Request/response contracts read through local OpenAPI $refs (FastAPI shape); external, dangling and cyclic refs stay partial (offline)
t node scripts/test-openapi-local-refs.js
# Uncached /api/find and /api/route computes are budgeted per client; the seller summary is memoized (boots a server)
t node scripts/test-discovery-compute-limit.js
t node scripts/test-coingecko-rate.js
# Paid smoke buyer preflight (external targets require an outcome assertion before key/client/network work)
t node scripts/test-smoke-buy.js
# Paying scripts: signed amount priced from the known-assets table, own-target guard
t node scripts/test-buyer-guard.js
# Every script that signs a payment checks its target or is listed with its reason and cap (static scan, offline)
t node scripts/test-paid-scripts-guarded.js
# "Every paid route's PAYMENT-REQUIRED document parses under the OFFICIAL @x402/core
#  schemas. Our live challenges did not: 557 of 560 published more than the protocol's
#  five-tag maximum, so a buyer validating before paying got an invalid document
#  (verified first-party against prod, 2026-08-29). Boots the real server against a
#  local /supported stub; no payment is made."
t node scripts/test-bazaar-contracts.js
# A 402's shortened example is replayed from /openapi.json; html-frames' example fits whole (offline)
t node scripts/test-replayable-example.js
# Our own listing text (every 402, /api/pricing, /openapi.json, /.well-known/x402) passes
# the listing screen and the hidden-character scan we hold sellers to (stub facilitator)
t node scripts/test-own-listing-screen.js
# Standing red team (scripts/redteam-corpus.json): injection and tool-abuse payloads against
# the MCP connector, the seller judge, decide's planner, the fetch guard, the router's payer
# and report prose; fails on any attack that lands (stub judge, model and facilitator, port 0)
t node scripts/test-agent-redteam.js
# Every accept of every 402 asks list plus the chain's premium, raised to its
# floor, as /api/pricing publishes them (three rails, a stub facilitator).
t node scripts/test-accept-prices.js
# A throw in an x402 beforeVerify / beforeSettle hook answers the hook's declared choice: the
# wallet blocklist and the Arc contract-wallet gate refuse with their own reason (402, no settle,
# no sale, no idempotency commit, never the handler for a verify refusal), bookkeeping hooks pass;
# a payment header decoding to non-object JSON answers 4xx (real resource server + two paid boots)
t node scripts/test-x402-hook-throws.js

# @step 2: Offline suites (9 scripts, one process each)
# "x402-audit grader (deterministic scoring: TLS, cache hygiene, terms, info-leak → letter grade)"
t node scripts/test-x402-audit.js
# Finance-kit tests (Yahoo chart quote+history, Nasdaq earnings calendar — keyless live APIs)
t node scripts/test-finance-kit.js
t node scripts/test-databento-timeouts.js
t node scripts/test-databento-fallback.js
t node scripts/test-databento-bar-range.js
t node scripts/test-databento-range-fallback.js
# "stock-quote: warm symbol answers with no upstream call, cold symbol with one; warmer ceiling (offline, stubbed)"
t node scripts/test-stock-quote-speed.js
# "Operator bulk seed route: token-only, bounded, same validation as /sell, dry by default"
t node scripts/test-operator-seed.js
# "MPP self-registration probe hint (optional path/method: validated, probed, kept only on success, persisted with the seed - offline)"
t node scripts/test-mpp-index-hint.js

# @step 3: Offline suites (105 scripts, one process each)
# Tollbooth CLI settles x402 + MPP from env (real CLI process vs stub facilitator; mppx + @x402/fetch buys settle once each; misconfig fails closed)
t node scripts/test-tollbooth-cli.js
# /tollbooth install snippet runs against the package for every mode (observe, bots, strict, all; PoW unlock, stock x402 buy vs stub facilitator)
t node scripts/test-tollbooth-landing.js
# /crawler claims vs the real crawl (robots exemptions, fallback documents, User-Agent on every probe - offline stub origins)
t node scripts/test-crawler-page.js
# /contribute: every script and file it names exists; free-tier allowlist, route recording and pack pricing rules match the code (offline)
t node scripts/test-contribute-page.js
# /integrations pages: installs carry every imported package, credits copy reads the sales switch, shape note and tool cards derived (offline)
t node scripts/test-integration-pages.js
# /workflows chains: no step after a markdown producer takes HTML or CSV; copy promises only what steps return (offline)
t node scripts/test-workflows-page.js
# /SKILL.md agent-onboarding sheet (frontmatter, section order, every named route registered, house style - offline)
t node scripts/test-skill-md.js
# Manifest resources[] dedup (a tool registered under 2 HTTP methods lists its URL once, not twice)
t node scripts/test-manifest-resources-dedup.js
# AVM validity guard (short-window Algorand payment rejected pre-handler, no upstream burn — offline)
t node scripts/test-avm-validity.js
t node scripts/test-decide-index.js
# The decide export and concurrent crawls of large OpenAPI documents hold the event loop in bounded slices, with the same rows as one turn (offline)
t node scripts/test-loop-slices.js
# Decide BM25 index in typed arrays: same scores, tie order, filtered searches and suite plans as the Map-and-Set index it replaced, over a mutation sequence (offline)
t node scripts/test-decide-lexical.js
t node scripts/test-decide-planner.js
# Decide specialized planners: one seam each, router threshold and fallback, seller neutrality, synthetic suite plan-only (offline)
t node scripts/test-decide-harness.js
t node scripts/test-decide-execute.js
# Execute runs independent plan steps at once: one run budget reserved per leg, deadline and drain on every step (offline)
t node scripts/test-decide-execute-parallel.js
t node scripts/test-decide-feedback.js
t node scripts/test-decide-site.js
t node scripts/test-decide-cost.js
t node scripts/test-decide-reconcile.js
# Decide instrumentation: planner version, text-free plan shape, run join, skip codes, own-traffic flag, operator stats (offline)
t node scripts/test-decide-instrumentation.js
# Decide as a buyer meets it: valid 402s that name each depth's price and carry the whole example, the execute example runs as written, an unknown decisionId is a free 404, prices
t node scripts/test-decide-paywall.js
DECIDE_TEST_PG_URL=postgres://decide@127.0.0.1:5432/decide_test t node scripts/test-decide-pg.js
t node scripts/test-image-gen-kit.js
# Leaderboard chain config (right token on the right rail; testnets excluded — offline)
t node scripts/test-leaderboard-chains.js
# Discovery strict-source filters (testnet + junk origins)
t node scripts/test-discovery-filter.js
# Registry discovery folds each page as it arrives: same published maps as the whole-list fold, a failed walk publishes nothing, lower peak heap (offline)
t node scripts/test-discovery-streaming.js
# Index warm-start (crawl cache survives a redeploy; no half-crawled marketplace — offline)
t node scripts/test-index-warmstart.js
t node scripts/test-index-persist-last-good.js
# A crawl read of ours that did not complete keeps the last good entry: no unroutable seller, no backoff (offline)
t node scripts/test-crawl-read-incomplete.js
# A seller without /.well-known/x402 keeps its catalog when its /openapi.json, /agents.json or /llms.txt answers 304 (offline)
t node scripts/test-index-fallback-304.js
# A crawled entry keeps the slim manifest; a 304 derives the same catalog from the packed body (offline)
t node scripts/test-index-slim-manifest.js
# A seller's own payTo outranks a registry's record of an old wallet, across re-crawls (offline)
t node scripts/test-seller-payto-precedence.js
# Crawl load is per operator, not per origin; the register global cap is a backstop (offline)
t node scripts/test-crawl-politeness.js
# Index warm-start is incremental (NDJSON twin parsed a batch per turn; no event-loop hold; legacy fallback — offline)
t node scripts/test-index-ndjson-warmstart.js
# A large seller's entry splits into parts and assembles deep-equal; one changed part; shrink to one row; a mix of two saves refused (offline)
t node scripts/test-index-parts.js
t node scripts/test-stall-profiler.js
t node scripts/test-offload-stalls.js
# A registry-fallback crawl of a 77k-row seller takes its whole-list passes across turns (offline)
t node scripts/test-fallback-crawl-turn.js
# Ledger and index figures behind the stalled routes build across turns
t node scripts/test-stall-routes.js
t node scripts/test-manifest-input-schema.js
t node scripts/test-request-timing.js
t node scripts/test-surface-memo.js
t node scripts/test-load-shed.js
t node scripts/test-stall-alarm.js
# A paid call whose handler runs past its bound pages, slugs only; declared-slow routes use their own budget (offline)
t node scripts/test-slow-paid-alarm.js
t node scripts/test-perf-budget.js
# Crawl cadence copy is derived (served pages cannot advertise a cadence we do not run — offline)
t node scripts/test-crawl-cadence.js
# CI lane gating (every test lane blocks deploy/publish; Chromium only where a script needs it — offline)
t node scripts/test-ci-gating.js
# A sharded lane runs every script it names in exactly one shard (dry run of every shard, mutated copies must fail)
t node scripts/test-ci-shards.js
t node scripts/test-port-hygiene.js
# Every suite that reaches src/ takes a stats store of its own with its first import
t node scripts/test-stats-store-hygiene.js
# scripts/lib/boot-server.js: PORT=0 boots read the bound port back, two at once get two ports, a crash rejects with its log (boots the server; offline)
t node scripts/test-boot-server.js
# Home hero first-party figures: served with an as-of each, no dash or loading placeholder, a slow source never holds the page (boots the server; offline)
t node scripts/test-home-proof.js
# Stubbed fetches route by the parsed host (scripts/lib/url-host.js), never a URL substring; older files frozen with counts (static; offline)
t node scripts/test-url-host-match.js
# Every offline suite pins its stores first
t node scripts/test-offline-stores-import.js
# test-all waits for the seller index before its strict sweep and fails naming the state if it never loads (stub server; offline)
t node scripts/test-all-index-wait.js
# A child's JSON result is read with childJson, never as its last line (offline)
t node scripts/test-child-json.js
# No em dash in a shipped package file or a workflow issue body (read from each package's files allowlist - offline)
t node scripts/test-no-em-dash-shipped.js
# A public issue body carries reasons and ids, never a dollar figure (workflow bodies + the quoted runner log lines - offline)
t node scripts/test-public-issue-figures.js
# Dev-branch sync moves the branch only when merging it would change nothing on main (throwaway git repos - offline)
t node scripts/test-sync-dev-branch.js
# Free tier is an allowlist: a tool on no list is wallet-only by default (offline)
t node scripts/test-free-tier-allowlist.js
# Flagship answers carry an additive next call (search -> answer, plan -> execute) - offline
t node scripts/test-next-call.js
# Licensing split stays legible: server AGPL, every published package MIT with its own LICENSE + repository.directory (offline)
t node scripts/test-package-licenses.js
# OFL 1.1 condition 2: a redistributed font ships its licence
t node scripts/test-font-licenses.js
# CI tree gate (a merge may skip the suite ONLY on a tree that already passed it — offline)
t node scripts/test-ci-tree-gate.js
# Single-resource x402 manifest (spec 402-body shape; chains reach an OpenAPI-sourced row — offline)
t node scripts/test-single-resource-manifest.js
# Catalogue-entry payment terms (nested accepts / flat fields / service-wide block; atomic amounts are not dollars — offline)
t node scripts/test-manifest-catalogue-payment.js
# Submission slot release (30d dead, outage guard fails closed, settled sellers never released — offline)
t node scripts/test-submission-release.js
# Slot release: rowless submissions age out, each cycle logs the release outcome (offline)
t node scripts/test-slot-release-health.js
t node scripts/test-tunnel-submissions.js
# Browser pool admission (A402-08 bounded queue, deadline, disconnect-abort — offline)
t node scripts/test-render-queue.js
# MPP_CHALLENGE_NETWORKS default verified against installed mppx registry (drift guard — offline)
t node scripts/test-mpp-shim-mppx-registry.js
# Report economics (every card/agent/monitor price clears MEASURED worst-case upstream, not a declared cap - offline)
t node scripts/test-report-margins.js
# Untrusted-content provenance (R-14 — external page/search content carries untrustedContent; extract/render/search marked — offline)
t node scripts/test-provenance.js
# x402-trending momentum tool (organic score, sorts, WoW activation, history persistence — offline)
t node scripts/test-x402-trending.js
# ticker pack kit (offline)
t node scripts/test-ticker-pack-kit.js
t node scripts/test-dossier-inputs.js
t node scripts/test-report-inputs.js
# The research plan must never collapse silently into a one-search report.
t node scripts/test-research-planner-guard.js
t node scripts/test-linkedin-article-kit.js
# Stellar marketplace page tests (offline, fixture snapshot)
t node scripts/test-stellar-page.js
# What-is-x402 pillar page tests (offline, fixture snapshot)
t node scripts/test-what-is-x402-page.js
# What-is-MPP page tests (offline)
t node scripts/test-what-is-mpp-page.js
# robots-check ReDoS regression (wildcard cap, normal robots.txt behavior — offline)
t node scripts/test-robots-redos.js
# transcribe's refusal for our own billing limit names our side and no vendor (offline)
t node scripts/test-stt-billing-limit.js
# transcribe makes one more upstream attempt on a transient failure, inside its cap and its counters (offline)
t node scripts/test-stt-retry.js
# rwa-asset joins only the requested asset's market row (offline)
t node scripts/test-rwa-asset-own-row.js
# filing-watch form filter reads the full recent list and older filing files, bounded reads (offline)
t node scripts/test-filing-watch-older-files.js
# cpi-yoy lists unpublished months; world-bank default end year is last year; release calendar uses the Chicago date (offline)
t node scripts/test-macro-dates.js
# flight-search refuses a date as past only before today's date in UTC-12 (offline)
t node scripts/test-flights-local-date.js
# weather tools keep a missing precipitation value as null, never 0 mm (offline)
t node scripts/test-weather-null-precip.js
# IPO filings list each accession once across pages (offline)
t node scripts/test-ipo-dedupe.js
# 13F amendments apply oldest first (offline)
t node scripts/test-13f-amendment-order.js
# Insider reports keep only Form 4 filings whose issuer is the company (offline)
t node scripts/test-insider-issuer-filter.js
# EDGAR financials pick ~3- and ~12-month periods; fallback tags labeled as what they measure (offline)
t node scripts/test-edgar-period-pick.js
# 13G cover: an empty or absent tag falls through and reads as unknown, never 0 (offline)
t node scripts/test-13g-cover-fallback.js
# S3 wire for backup and dataset snapshot: list not HEAD, per-segment path signed as sent, no content-length on a Buffer PUT (stubbed fetch, offline)
t node scripts/test-backup-s3-wire.js
# load-shed boot warm-up default is 60 s (offline)
t node scripts/test-load-shed-warmup.js
# deploy job redeploys the render/media worker when a push changes its import closure or image inputs (offline)
t node scripts/test-worker-deploy-step.js
t node scripts/test-decide-deploy-step.js
# variable upsert never starts its own deploy; ClawHub publishes last (offline)
t node scripts/test-deploy-release-order.js
# ClawHub release helper: retries only the write rate limit, never publishes after a failed inspect (fake CLI, offline)
t node scripts/test-clawhub-release.js
t node scripts/test-heap-sampling.js
t node scripts/test-network-names-own-keys.js
t node scripts/test-email-text.js
t node scripts/test-mcp-version-pins.js
# The heartbeat's MCP install-pin check: a served agent402-mcp version npm lacks reads missing; an unreadable site or registry reads unknown (offline, stub site + stub registry)
t node scripts/test-mcp-pin-on-npm.js
t node scripts/test-env-num.js
# post-deploy has() counts a needle only in a 2xx answer (runs the workflow's shell function locally)
t node scripts/test-deploy-has-status.js
# ffmpeg/ffprobe read a downloaded body as a local file of a named format (stub runner, offline)
t node scripts/test-media-input-args.js
# safeFetch timeoutMs bounds the body read too (local trickle server, offline)
t node scripts/test-safefetch-body-timeout.js
# yaml-to-json refuses aliases that expand past the JSON size cap (offline)
t node scripts/test-yaml-alias-cap.js
# every call into the outside-seller buyers is a listed caller that books against the shared spending ceilings (offline, source read)
t node scripts/test-buyer-callers.js
