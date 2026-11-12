# Test list for the test-unit-a3 lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-unit-a3 N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (7 scripts, one process each)
# /api/route neutral cross-seller router envelope (per-row shape, include filter, missing-query)
t node scripts/test-route-envelope.js
# Tool correctness regressions (20 wrong-answer bugs from the review; boots free-mode, TZ=UTC)
t node scripts/test-correctness-fixes.js
# Find ranker — live-catalog smoke test (boots free-mode, locks top-1 for agent queries)
t node scripts/test-find-ranking.js
# /api/find and a stated conversion direction
t node scripts/test-find-direction.js
# /openapi.json coverage (every CATALOG tool has a path + operationId + x-price)
t node scripts/test-openapi-coverage.js
# MCP prompts/list + prompts/get (one prompt per skill pack; substitution renders)
t node scripts/test-mcp-prompts.js
# MCP outer transport limits (R-11 — per-IP cap + concurrency ceiling bound floods before server/transport allocation — spawns child)
t node scripts/test-mcp-limits.js
# Hosted connector bounds: a free answer past the size ceiling is cut to valid JSON with answerBound fields, catalog.search holds its row maximum for any limit, a refusing limiter
t node scripts/test-mcp-answer-bound.js
# Hosted connector and revenue view error text: a configured key or a database URL's password an error quotes never reaches an answer, the reason stays (offline, bare express + mountMcp)
t node scripts/test-mcp-error-redaction.js

# @step 2: Offline suites (13 scripts, one process each)
# /llms.txt content lock (tool count + discovery URLs + PoW/MCP/wallet signals)
t node scripts/test-llms-txt.js
# Every HTML page names /llms.txt (head link + Link header); /api/pricing and the x402 manifest name EVM-only routes
t node scripts/test-llms-link.js
# No third-party seller host or counterparty name in any tracked file (hashed list)
t node scripts/test-no-third-party-names.js
# No hidden character (TAG text, zero-width, bidi, variation-selector carrier, soft hyphen) in an instruction file: CLAUDE.md, .claude, wiki, docs, READMEs, the MCP instructions module
t node scripts/test-hidden-chars.js
# A payment log line in src/ prints a wallet by its first characters only (shortPayer), outside a reasoned allowlist (offline)
t node scripts/test-log-payer-short.js
# US spelling in public copy: README, wiki, docs, package READMEs, legal and guide pages, tool descriptions (offline)
t node scripts/test-us-spelling.js
# No filesystem path built from a URL pathname (percent-encoded: a checkout path with a space breaks) and no hand-made file:// entry check, in every source tree (offline)
t node scripts/test-no-url-pathname.js
# CHANGELOG.md and the /changelog page agree: no duplicated page item, and every dated group from 2026-11-05 on is in both with the same item counts (offline)
t node scripts/test-changelog-parity.js
# Seller text on the agent-read JSON surfaces is cleaned and capped at serve time; a flagged listing is marked and served without its description
t env AGENT402_SHOW_ROUTER=1 node scripts/test-listing-text-serve.js
# The listing screen's necessary-word hints answer exactly as the unhinted reading (implication per pattern on a generated corpus, agreement on the honest fixture; offline)
t node scripts/test-listing-screen-hints.js
# Well-known store (operator-published domain-verification docs; traversal impossible, reserved names refused, no shadowing of /.well-known/x402 — offline)
t node scripts/test-well-known-store.js
# /api/reliability envelope (guarantees claim+verify pairing — every listing portal reads this)
t node scripts/test-reliability-envelope.js
# PostHog analytics proxy abuse controls (R-17 — method allowlist + per-IP cap before the upstream call — spawns child)
t node scripts/test-posthog-proxy.js
# Leaderboard scan memory bound (300k synthetic transfers folded in batches; proves the 7d-OOM fix)
t node scripts/test-leaderboard-memory.js
# Conversion tools (~970 endpoints, exact + round-trip)
t node scripts/test-convert.js
t node scripts/test-json-canonical.js
