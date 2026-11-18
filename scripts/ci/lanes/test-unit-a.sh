# Test list for the test-unit-a lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-unit-a N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (10 scripts, one process each)
# Wildcard route bypass closed (@x402/core 2.21.0 dotAll fix — percent-encoded line terminators can't skip payment on /api/convert/* — offline)
t node scripts/test-wildcard-route-bypass.js
# Wallet-free trial (scope, bounds, never counted as revenue)
t node scripts/test-trial.js
# LLM gateway validation (OpenAI-compat tiers, caps, env-gated 503)
t node scripts/test-llm-gateway.js
# Timed-out attempt budget on chat, Messages and Responses, plain and streamed (offline)
t node scripts/test-llm-timed-out-budget.js
# Direct inference upstream: off by default, ZDR, fallback to OpenRouter, billed once (offline stubs)
t node scripts/test-direct-upstream.js
# Direct upstream price guard (offline): a per-call eligibility check against the listed prices of both routes and a private threshold; fails closed; measured backstop; word-only
t node scripts/test-direct-upstream-cost-guard.js
# Direct upstream daily spend and balance words: alarms only, a 402 balance refusal served by OpenRouter, pagers (offline stubs)
t node scripts/test-direct-upstream-spend.js
t node scripts/test-gateway-resilience.js
t node scripts/test-upstream-refusal.js
t node scripts/test-llm-kit-spend.js
t node scripts/test-upstream-costs.js
t node scripts/test-ci-secretless-install.js
# Every workflow apt install goes through the bounded helper (offline)
t node scripts/test-ci-apt-bounded.js
# Gateway settle-failure breaker (per-payer + global refusal before any upstream call, finish-listener outcomes, source pins - offline)
t node scripts/test-gateway-settle-breaker.js

# @step 2: Offline suites (7 scripts, one process each)
# Economy history unit tests (daily upsert idempotency + week-over-week math — offline)
t node scripts/test-x402-economy.js
# /sitemap.xml coverage (every skill pack, sample tools, static surfaces, per-URL lastmod stable across boots)
t node scripts/test-sitemap-coverage.js
# Sitemap URLs are their own canonical; breadcrumb trails match their BreadcrumbList; one site entity in JSON-LD
t node scripts/test-seo-structure.js
# One sameAs profile list for every Organization in JSON-LD; the site entity names what it is
t node scripts/test-org-same-as.js
# Canonical host: canonical, og:url, JSON-LD, sitemap and the MCP server card all name BASE_URL's host; /about and /press
t node scripts/test-canonical-host.js
# The sitemap lastmod table matches git history (needs the full-depth checkout above)
t node scripts/test-page-dates.js
# Bing sitemap registration script: lists then submits only the missing feeds (stubbed, offline)
t node scripts/test-submit-sitemaps.js
