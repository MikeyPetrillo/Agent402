# Test list for the test-unit-c lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-unit-c N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (3 scripts, one process each)
# upto scheme ships dark, refuses what it cannot price
t node scripts/test-upto-scheme.js
# upto gas sponsoring and Arc upto: declared only when switched on and listed by the facilitator
t node scripts/test-upto-gas-sponsoring.js
# EVM preflights refuse non-string payload fields and pin the upto permit rules
t node scripts/test-evm-preflight-inputs.js
