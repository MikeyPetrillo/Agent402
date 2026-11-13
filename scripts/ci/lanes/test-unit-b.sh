# Test list for the test-unit-b lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-unit-b N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (8 scripts, one process each)
# PoW solve roundtrip (paid-mode boot, honest solver unlocks /api/hash, replay rejected)
t node scripts/test-pow-solve-roundtrip.js
# Tool-page PoW snippets (paid-mode boot, every GET snippet sends its documented input and answers 200)
t node scripts/test-tool-page-pow-snippet.js
# Cold start (a wallet-less agent reaches its first call from the docs alone)
t node scripts/test-coldstart.js
# Idempotency (opt-in safe retry of paid/proven calls; boots paid-mode)
t node scripts/test-idempotency.js
# A paid tool call carrying a conditional or range header is a full 200, settled and booked once (stub facilitator; a free document keeps its 304)
t node scripts/test-paid-full-answer.js
# Gateway response cache paid with the stock x402 client: the payer's paid repeat is a cache hit, not settled; another wallet's is charged (paid boot, stub facilitator and upstreams)
t node scripts/test-gateway-cache-paid-path.js
# The URL tools and the memory family write one call-log row per call, final status (free and paid boots, stub facilitator, loopback-only fetch)
t node scripts/test-bespoke-call-log.js
# Large-body routes: no compressed body, no unpaid body over 100 KB read unless priced from it, one in-flight byte budget (boots paid-mode on port 0)
t node scripts/test-large-body-gate.js

# @step 2: Offline suites (4 scripts, one process each)
# /.well-known/glama.json maintainer email env pass-through (with + without override)
t node scripts/test-glama-manifest.js
# Skill-pack invariants (toolSlugs resolve in catalog; substitution renders)
t node scripts/test-skill-packs.js
# /health flag shape contract (every documented flag present + boolean-typed)
t node scripts/test-health-flags.js
# /skills/<slug> contract (every pack renders workflow + tools + claudePrompt + JSON-LD)
t node scripts/test-skill-page-contract.js
