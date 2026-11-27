# Test list for the test-unit-c2 lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-unit-c2 N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (20 scripts, one process each)
# Boot /supported guard (a dead facilitator costs ONE rail, not every paid route — the 2026-08-01 Celo outage; probe-driven drop, fail-open on total blindness, escape hatch — offline)
t node scripts/test-supported-guard.js
# A rail dropped at boot on a failed or slow /supported read is read again on a backoff and rejoins the 402 and every derived surface without a restart
t node scripts/test-rail-restore.js
# Verify falls over to another facilitator when the first is UNREACHABLE, and never when it answers (offline, stub facilitators)
t node scripts/test-verify-failover.js
# The Bazaar keep-alive is actually scheduled, fails loudly without a key, and pages (CDP removes a resource after 30 days without a settlement)
t node scripts/test-bazaar-keepalive.js
# The keep-alive above the ceiling and the price-change buy: route selection, changed-price detection, spend-cap refusals, the burner low-water figure (offline, stub catalog, DRY_RUN)
t node scripts/test-keepalive-plan.js
# The Bazaar presence check every four hours: a route missing from every listing pass is bought once (exempt kinds and caps refuse), an unreadable listing never buys and pages only after three checks, one issue on a repeat miss (offline fixtures, loopback stub)
t node scripts/test-bazaar-presence.js
# MCP tool listings in the listing scripts: refresh-bazaar MODE=mcp buys an explicit slug list once each through the connector's x402 transport and refuses any other slug, its dry run prints each price and the total, an offer that is not the tool's MCP listing offer is never signed, a failed settle is not sent again, the presence check finds the listings and never buys one, bazaar-validate --mcp, the plan and the workflow (stub catalog, paid boot with a stub facilitator, throwaway key)
t node scripts/test-mcp-listing-tools.js
# Weekly check of our own Bazaar listing: query list from demand, ours by exact host and route, unreadable never pages, the one-issue page with an ack list (offline fixtures)
t node scripts/test-bazaar-rank-monitor.js
# verify_failed carries a DERIVED payer id (never an address), so a retry loop can be told from many clients (offline)
t node scripts/test-verify-failed-payer-key.js
t node scripts/test-svm-payer.js
t node scripts/test-non-evm-payer.js
# Event-loop lag monitor measures a real block and stays cheap enough to leave on (offline)
t node scripts/test-loop-lag.js
# Tempo MPP settlement (native tempo/charge via Tempo's relay — challenge wiring + settlement-ordering proof — offline)
t node scripts/test-mpp-tempo-shim.js
t node scripts/test-tempo-push-debts.js
# Tempo pull credentials: per-buyer bounds key only on a sender the signature (or the chain, for an access key) proves; routes that spend before settlement refuse an unproven one
t node scripts/test-tempo-sender.js
t node scripts/test-ox-single-copy.js
# MPP discovery parity: every paid route's 402 challenges == its /openapi.json offers; /llms.txt + /.well-known/x402 agree (boots paid mode, offline)
t node scripts/test-mpp-discovery-parity.js
# MPP start-here set: every slug offers tempo, and /what-is-mpp, /llms.txt, /openapi.json and MCP payment.info derive from src/mpp-flagship.js at catalog prices (boots FREE_MODE, offline)
t node scripts/test-mpp-flagship.js
# 30 concurrent buyers for 45 s against a FREE_MODE server on a free port, /health probed beside them
t node scripts/test-load-concurrency.js
# Runtime switches: provider, then environment, then the declared default; booleans and declared names only (offline)
t node scripts/test-feature-flags.js
# Railway feature flags as the switch provider: off unless FEATURE_FLAGS_RAILWAY_TOKEN is set; the real SDK against a stub endpoint (offline)
t node scripts/test-feature-flags-railway.js
# /integrations/agentcore: copy follows the MPP offer gate and the Tempo switch; route, index, sitemaps, llms.txt and page date (offline, port 0)
t node scripts/test-agentcore-page.js
# /integrations/claude-managed-agents: the agent definition, derived figures, attributed claims; route, index, sitemaps, llms.txt, page date; /mcp?tool_names=underscore lists plain names and runs either spelling (offline, port 0)
t node scripts/test-managed-agents-page.js
# Every issue a scheduled check opens is the fixed neutral title and body, in every workflow and the status Worker (offline)
t node scripts/test-monitor-issue-wording.js
# An open issue a check filed under its previous title gets the current one before any lookup: one list, the adoption script against a stand-in gh, the step in every job that looks an issue up (offline)
t node scripts/test-issue-title-adoption.js
# A check that fails again within seven days of its issue closing reopens that issue: the one rule, the workflows' opener and the status Worker against stubbed reads (offline)
t node scripts/test-check-issue-reopen.js
# Router benchmarks: aggregates over the reputation records, no seller named, nothing under five sellers, no purchase count (offline, port 0)
t node scripts/test-router-benchmarks.js
# Price webhooks: input rules, the registrant's cap (never the host's), renewal, expiry and the store's bound, a registration kept only when its call settles, one change set stored once, signed delivery, retries, a delivery turn fair across receivers that never runs beside itself, the fetch guard, the served tool and its removal route (offline, port 0)
t node scripts/test-price-webhooks.js
# Named speech and transcription models: served and listed only with a cost row inside the margin bound at the model's own cap where it declares one (offline, stubbed upstream)
t node scripts/test-speech-additions.js
# Speech answers name the model that spoke (X-Agent402-Model, X-Agent402-Model-Fallback on a named model that fell back) and log it; a named model's own character cap (FREE_MODE boot, stubbed upstream, port 0)
t node scripts/test-speech-served-model.js
