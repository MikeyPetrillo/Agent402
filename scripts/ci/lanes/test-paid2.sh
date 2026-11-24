# Test list for the test-paid2 lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-paid2 N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (21 scripts, one process each)
# Native MPP on /mcp (stock MCP SDK client + mppx McpClient pays a wallet-only tool via the real gates; stub facilitator; -32042 wire; RFC 9457 problem on tamper - offline)
t node scripts/test-mcp-mpp.js
# A binary tool answer through a real MCP tools/call on both result paths
t node scripts/test-mcp-binary-e2e.js
# A paid call whose client hangs up is settled once and recorded once as owed (boots a paid server against a slow-settle stub facilitator - offline)
t node scripts/test-hangup-settlement.js
# A granted call answered with any 2xx consumes its payment, so the same payment never runs twice (paid boot, stub facilitator - offline)
t node scripts/test-replay-consumed-2xx.js
# A settled answer arrives whole after a long settle: every byte of a large answer and its settlement header, once, on every gate (paid boot, stub facilitator - offline)
t node scripts/test-avm-long-settle-answer.js
# Circle Gateway batched option: the client against a stub (supported, verify, settle, pending resolved on the transfer record, no fallback for a batched payment, gateway-batched
t node scripts/test-gateway-nanopayments.js
# Gateway withdraw script: --amount without --from refuses and names the domains, the signed burn intent expires at the source block plus a bounded window, an unreadable block
t node scripts/test-gateway-withdraw.js
# Per-phase timing of paid calls: verify, handler and settle measured against injected stub delays, filed under the right rail (x402 vs mpp-evm), a hang-up marked gone, summary
t node scripts/test-paid-phase-timing.js
# Stock-data switch on real boots: off hides the tools and packs from every surface and their routes answer 503 with no payment challenge (paid boot, stub facilitator); on (stubbed upstream) restores them and their published examples answer - offline
t node scripts/test-stock-switch.js
# Kalshi switch: off hides the Kalshi tools from every surface, the kit reads no upstream and the routes answer 503 with no payment challenge (paid boot, stub facilitator); on lists them again and a call reaches the handler - offline
t node scripts/test-kalshi-switch.js
# A paid run that never gets paid meets a bound
t node scripts/test-paytime-bounds.js
# A wallet's runs in flight are covered by its balance together on every wire that settles after the handler, and the breaker's hard count holds for calls that arrive together (boots paid servers against chain-like stubs - offline)
t node scripts/test-inflight-burst.js
# The admission's rules: a balance that covers a wallet's calls in flight starts every one, a balance that cannot be read is judged on the wallet's last good read or the allowance of calls at once, Gateway batched terms (offline)
t node scripts/test-inflight-admission.js
# Settle first: on the model and image routes a wallet with no paid sale on the books, and a wallet or authorization holding runs that did not settle, has its payment settled before the upstream call; the order of the settle call and the upstream call read on every x402 exact wire, every refusal of the buyer's input before any settle, every failure after it booked owed in its class, a hang-up, a replay, a restart on the sales ledger, and the same calls with the switch off (boots paid servers against chain-like stubs - offline)
t node scripts/test-settle-first.js
# Settle first on the catalog routes with an upstream cost (search and answer, image generation, speech, transcription, judgment): the settle call before the upstream call, a buyer's mistake and a reached daily ceiling refused before any settle, a failure after it owed in its class and run free on the same payment, the switch off unchanged, and those routes feeding the same budget meter and per-wallet count (boots paid servers against stub upstreams - offline)
t node scripts/test-settle-first-routes.js
# A header a handler set for its answer is not sent on a refusal: dub on Tempo pull, MPP evm and x402 (boots a paid server - offline)
t node scripts/test-answer-headers.js
# OUSD on the Tempo MPP rail: the name resolves in every reader, USDC.e stays the first challenge, an OUSD pull credential verifies and settles, and it is refused where TEMPO_CURRENCY does not list it (boots a paid server - offline)
t node scripts/test-tempo-ousd.js
# Price webhooks on a paid server: a registration whose settlement is refused leaves nothing stored, the registrant is the payer on Base, Tempo and Solana, its own excess is the 409, the same URL again renews in place (boots a paid server - offline)
t node scripts/test-price-webhooks-paid.js
# The conformance document's cells against the code: every wire paid (an error not settled, a success settled with the receipt the cell names, replay and idempotency as claimed), switches flipped change their cells, FREE_MODE offers nothing, and its refund terms are the /terms sentences (boots paid servers - offline)
t node scripts/test-conformance.js
# Signed receipts: the one key format and its refusals, sign and verify with tamper on every field, rotation, the header bound and the cost per call; with a key every settling wire's 200 carries a receipt that verifies and none on an error or a refused settle; without one no receipt and no cell claims it (boots paid servers - offline)
t node scripts/test-receipt-signing.js
# Signed receipts beyond a one-piece answer: a settled stream ends with an agent402-receipt comment line no event parser dispatches (and a trailer with TE: trailers) over every byte streamed, on every wire; a credits call is debited before its answer ends and its receipt names the key id and the debit; a card-bought report's receipt covers the checkout and the report text on its page and email; tamper fails (boots paid servers - offline)
t node scripts/test-receipt-streams.js
# Our own upstream caps: each refusal counted per cap and slug, the upstreamCaps word, cached answers not counted, and a refused call never charged on any rail or debited from credits (boots a paid server - offline)
t node scripts/test-upstream-cap-refusals.js
# The audit report on a paid server with a key: one wallet's x402, MPP evm and Tempo calls each carry the receipt their header carried and verify through the public check, the summary verifies, another wallet sees none of them, EVM x402 only, and the store keeps one receipt per settled 200 (boots paid servers - offline)
t node scripts/test-audit-report-paid.js
# A streamed chat, Messages or Responses answer that ends with no answer (all reasoning) is a 502 before any byte and is never settled on any wire; one with content is relayed byte for byte and settled once; a hold commits at the CDN window tail (boots a paid server - offline)
t node scripts/test-stream-empty-answer.js
# A card or Tempo challenge must outlive the run it pays for, and the breaker keys an address by its IPv6 /64 (boots a paid server - offline)
t node scripts/test-challenge-life.js
# Golden trajectories: 56 fixed route-execute tasks through the real paid server, resolver and payer against a stub seller ecosystem, each graded step by step (candidates, order
t node scripts/test-golden-trajectories.js
# The returning-wallet price end to end: discounted quote and settle for the hinted wallet, another wallet refused at list with the facilitator never asked (boots paid servers, stub facilitator)
t node scripts/test-returning-wallet-paid.js
# One-product MCP endpoint (/mcp/sec): profile lists only the SEC tools, hides the catalog meta tools, /mcp unchanged (boots a free server)
t node scripts/test-mcp-sec.js
# MCP wire: a 2026-07-28 client that opens with initialize is served the negotiated revision; tools/call arguments past the element bound are InvalidParams on /mcp and on the stdio
t node scripts/test-mcp-protocol-input-bound.js
# Prepared Railway IaC file carries the facilitator and worker service settings as a named partial with unmanaged variables
t node scripts/test-railway-iac.js
