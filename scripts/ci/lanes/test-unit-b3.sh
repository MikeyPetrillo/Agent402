# Test list for the test-unit-b3 lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-unit-b3 N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (9 scripts, one process each)
# /api/skill-packs.json shape (what stdio agent402-mcp consumes at startup)
t node scripts/test-skill-packs-json.js
# /api/stats envelope (M2M economy counters — rail breakdown, revenue proof, tools floor)
t node scripts/test-stats-envelope.js
# Shared trial counter (a cap of 1 must mean 1 across replicas)
t node scripts/test-shared-limit.js
# Store deadlines count loop time: an answer that landed while the loop was held is read, not a timeout
t node scripts/test-loop-deadline.js
t node scripts/test-loop-deadline-sites.js
# Tool pages backlink to the skill packs they belong to
t node scripts/test-tool-page-backlinks.js
# Tool pages: escaped examples, one h1, title/description bounds, sections
t node scripts/test-tool-page-content.js
t node scripts/test-tool-page-mpp.js
# Every tool category is a CATEGORIES key (breadcrumb + category page), decide included (offline + booted)
TARGET_URL=http://localhost:3000 t node scripts/test-tool-categories.js

# @step 2: Offline suites (17 scripts, one process each)
# Static page renders smoke (every HTML surface returns 200 with the right page-specific title)
t node scripts/test-static-pages.js
# Integration + learn pages and /llms-full.txt: 200, unique title, one H1, canonical, BreadcrumbList, in both sitemaps; llms-full lists every catalog route (boots a real server, offline)
t node scripts/test-integration-learn-pages.js
# Developer-docs code samples match the packages they import
t env TARGET_URL=http://127.0.0.1:3000 node scripts/test-doc-snippets.js
# Section Open Graph cards: every section page derives its own og:image, tool pages keep theirs, every card SVG well-formed (2026-09-14)
t node scripts/test-og-cards.js
# SEO meta ratchet: title <= 70, description <= 165, exactly one H1, canonical on every hand-written page (reader pass 2026-09-08)
t node scripts/test-seo-meta.js
# Operator auth (A402-07 no ?token= query; session cookie + header; hardened cookie flags — spawns child)
t node scripts/test-operator-auth.js
# Every route the booted router registers under /__operator refuses a caller without the token
t node scripts/test-operator-routes-refuse.js
# Probe-only credential: STATUS_PROBE_TOKEN opens POST /api/status/probe and NOTHING else, the operator token still works there, and the narrow gate is wired to one route (boots a
t node scripts/test-status-probe-token.js
# The status Worker's paid-call challenge: STATUS_PROBE_TOKEN gets a low-difficulty challenge on the probe slug only, its call is booked internal, the mark cannot be forged or
t node scripts/test-status-probe-pow.js
# /openapi.json header parameters (Idempotency-Key on every op, X-Pow-Solution only where PoW-eligible)
t node scripts/test-openapi-header-params.js
# Process lifecycle (A402-10 SIGTERM drains + exits 0; uncaught exception is fatal + exits non-zero — spawns child)
t node scripts/test-shutdown.js
# SIGTERM closes the listener at once and drains in-flight (the replacement is already serving when the signal lands; deadline fits the Railway grace)
t node scripts/test-drain-on-sigterm.js
t node scripts/test-db-status.js
t node scripts/test-db-init-retry.js
# Search data pipeline: JWT, GSC pagination/backfill, Bing parsing, idempotent upserts, weekly summary, IndexNow helpers, operator routes 404 without auth (stubbed, boots a server)
t node scripts/test-search-data.js
# The Stellar facilitator's fee account is a spending wallet; its low-water alarm must never report "ok" off an unreadable balance or a stranger's /health
t node scripts/test-stellar-facilitator-status.js
# Facilitator gate scoping stays honest (its tests import nothing outside facilitator/)
t node scripts/test-ci-facilitator-scope.js
# A composite report is refused (503, not charged) while draining - a late request on a busy keep-alive socket must not start a 4-minute run into the deadline
t node scripts/test-drain-refuses-composites.js
