# Test list for the test-unit-c2 lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-unit-c2 N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (14 scripts, one process each)
# Boot /supported guard (a dead facilitator costs ONE rail, not every paid route — the 2026-08-01 Celo outage; probe-driven drop, fail-open on total blindness, escape hatch — offline)
t node scripts/test-supported-guard.js
# A rail dropped at boot on a failed or slow /supported read is read again on a backoff and rejoins the 402 and every derived surface without a restart
t node scripts/test-rail-restore.js
# Verify falls over to another facilitator when the first is UNREACHABLE, and never when it answers (offline, stub facilitators)
t node scripts/test-verify-failover.js
# The Bazaar keep-alive is actually scheduled, fails loudly without a key, and pages (CDP removes a resource after 30 days without a settlement)
t node scripts/test-bazaar-keepalive.js
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
