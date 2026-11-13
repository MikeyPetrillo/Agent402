# Test list for the test-unit-b2 lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-unit-b2 N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (28 scripts, one process each)
# Production image carries every script the server needs at runtime (derived from source, not listed)
t node scripts/test-image-runtime-scripts.js
# /api/pow/challenge envelope (free-tier gate — full shape + slug scoping + 404s)
t node scripts/test-pow-challenge-envelope.js
# wiki/Why-Pay-Here.md is generated from WHY_POINTS (scripts/why-wiki.js) and must stay current
t node scripts/test-why-wiki.js
# /api/pricing envelope contract (every scraper reads this — per-endpoint shape, slug uniqueness)
t node scripts/test-pricing-envelope.js
# /health envelope + .flags shape (boolean discipline locks the Yahoo-relay-flap class)
t node scripts/test-health-envelope.js
# EDGAR-kit tests (SEC ticker→CIK, filings, XBRL company-concept/facts/frames — live keyless APIs)
t node scripts/test-edgar-kit.js
# Form 13F data sets: index parser + bounded Range reads of a real in-memory zip (offline)
t node scripts/test-edgar-13f-datasets.js
# Deploy quiet gate (outside-traffic lull incl. free/MCP calls, visibility, the ledgerDeadLetter hold, fail-open paths per check; offline)
t node scripts/test-quiet-gate.js
# Self-check policy (transient-filtering, timeout, unknown-slug — the prod tool-failure alarm — offline)
t node scripts/test-selfcheck.js
# /robots.txt policy (every LLM bot explicitly allowed, /api/ closed except the documented surfaces, sitemap URLs all allowed)
t node scripts/test-robots-policy.js
# /api/find envelope + top-1 ranking lock (per-row shape + known queries → known top slugs)
t node scripts/test-find-envelope.js
# Settlement-aware idempotency (FR4-01 — a non-200/unsettled response is NOT cached; @x402/express settles AFTER the handler)
t node scripts/test-idempotency-settlement.js
t node scripts/test-idempotency-inflight.js
t node scripts/test-idempotency-pow-binding.js
# Gateway response cache is scoped to the payer who paid (a decodable header or another wallet reads nothing; real EIP-3009 signatures, offline)
t node scripts/test-gateway-cache-scope.js
# Image-kit tests (resize, convert, thumbnail — jimp, exact dims)
t node scripts/test-image.js
# jimp on the root zod 4 (no nested zod 3; outputs and option checks match the zod 3 baseline)
t node scripts/test-jimp-zod.js
# MCP search_tools — live-catalog smoke test (locks top-1 for agent queries)
t node scripts/test-mcp-search-ranking.js
# Report -> monitor upgrade loop (kind mapping, table-driven price, escaping, prefill-only deep link)
t node scripts/test-report-upgrade.js
# Model-written reports say so on every surface a person reads (storefront, viewer, samples, public pages, emails)
t node scripts/test-report-model-note.js
# Every number a report kit writes is traced to its synthesis material (offline)
t node scripts/test-report-grounding.js
# Every report kit serves model prose with no foreign link, image or active tag (offline)
t node scripts/test-report-prose-filter.js
# /llms.txt MPP/x402 dual-header reading note (issue #794 guidance, offline)
t node scripts/test-llms-mpp-header-note.js
# "Payment-nonce replay guard (M3 — Attack II: concurrent replay collapses to one grant, release-on-failure)"
t node scripts/test-replay-guard.js
t node scripts/test-payment-header-signed-fields.js
t node scripts/test-replay-topology.js
# "Replay guard with its shared store unreachable: long-running routes refuse 503 before any payment, fast routes keep the per-process claim (real server + stub facilitator - offline)"
t node scripts/test-replay-store-outage.js
# "agent402-client pays over MPP (real mppx fetch as the SDK's fetch; real server + stub facilitator — offline)"
t node scripts/test-client-mpp.js
# "Facilitator diagnostics (an HTML error page must name itself: block vs rate limit vs origin failure, and never touch the response — offline)"
t node scripts/test-facilitator-diagnostics.js
# Facilitator access policy (open-mainnet startup warning, constant-time bearer compare; offline)
t node scripts/test-facilitator-access-policy.js
