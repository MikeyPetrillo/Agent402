# Test list for the test-paid lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-paid N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (3 scripts, one process each)
# MCP Skills on /mcp (io.modelcontextprotocol/skills behind MCP_SKILLS - negotiated only, manifests verify, prompts unchanged - offline)
t node scripts/test-mcp-skills.js
# MCP Tasks on /mcp (io.modelcontextprotocol/tasks - handle then poll to completed, failures never a silent empty success, cancel aborts the paid run, restart resolves orphans,
t node scripts/test-mcp-tasks.js
# PostHog funnel (discovery→402→settlement capture; paid-mode boot vs mock facilitator — offline)
t node scripts/test-posthog-funnel.js
