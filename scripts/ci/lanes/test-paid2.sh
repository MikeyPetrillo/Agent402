# Test list for the test-paid2 lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-paid2 N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (16 scripts, one process each)
# Native MPP on /mcp (stock MCP SDK client + mppx McpClient pays a wallet-only tool via the real gates; stub facilitator; -32042 wire; RFC 9457 problem on tamper - offline)
t node scripts/test-mcp-mpp.js
# A binary tool answer through a real MCP tools/call on both result paths
t node scripts/test-mcp-binary-e2e.js
# A paid call whose client hangs up is settled once and recorded once as owed (boots a paid server against a slow-settle stub facilitator - offline)
t node scripts/test-hangup-settlement.js
# Circle Gateway batched option: the client against a stub (supported, verify, settle, pending resolved on the transfer record, no fallback for a batched payment, gateway-batched
t node scripts/test-gateway-nanopayments.js
# Gateway withdraw script: --amount without --from refuses and names the domains, the signed burn intent expires at the source block plus a bounded window, an unreadable block
t node scripts/test-gateway-withdraw.js
# Per-phase timing of paid calls: verify, handler and settle measured against injected stub delays, filed under the right rail (x402 vs mpp-evm), a hang-up marked gone, summary
t node scripts/test-paid-phase-timing.js
# A paid run that never gets paid meets a bound
t node scripts/test-paytime-bounds.js
# A wallet's runs in flight are covered by its balance together on every wire that settles after the handler, and the breaker's hard count holds for calls that arrive together (boots paid servers against chain-like stubs - offline)
t node scripts/test-inflight-burst.js
# The admission's rules: a balance that covers a wallet's calls in flight starts every one, a balance that cannot be read is judged on the wallet's last good read or the allowance of calls at once, Gateway batched terms (offline)
t node scripts/test-inflight-admission.js
# A header a handler set for its answer is not sent on a refusal: dub on Tempo pull, MPP evm and x402 (boots a paid server - offline)
t node scripts/test-answer-headers.js
# A streamed chat answer that ends with no answer (all reasoning) is a 502 before any byte and is never settled on any wire; one with content is relayed byte for byte as before and settled once (boots a paid server - offline)
t node scripts/test-stream-empty-answer.js
# A card or Tempo challenge must outlive the run it pays for, and the breaker keys an address by its IPv6 /64 (boots a paid server - offline)
t node scripts/test-challenge-life.js
# Golden trajectories: 56 fixed route-execute tasks through the real paid server, resolver and payer against a stub seller ecosystem, each graded step by step (candidates, order
t node scripts/test-golden-trajectories.js
# One-product MCP endpoint (/mcp/sec): profile lists only the SEC tools, hides the catalog meta tools, /mcp unchanged (boots a free server)
t node scripts/test-mcp-sec.js
# MCP wire: a 2026-07-28 client that opens with initialize is served the negotiated revision; tools/call arguments past the element bound are InvalidParams on /mcp and on the stdio
t node scripts/test-mcp-protocol-input-bound.js
# Prepared Railway IaC file carries the facilitator and worker service settings as a named partial with unmanaged variables
t node scripts/test-railway-iac.js
