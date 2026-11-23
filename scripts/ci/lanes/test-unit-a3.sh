# Test list for the test-unit-a3 lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test-unit-a3 N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (8 scripts, one process each)
# /api/route neutral cross-seller router envelope (per-row shape, include filter, missing-query)
t node scripts/test-route-envelope.js
# Tool correctness regressions (20 wrong-answer bugs from the review; boots free-mode, TZ=UTC)
t node scripts/test-correctness-fixes.js
# Find ranker — live-catalog smoke test (boots free-mode, locks top-1 for agent queries)
t node scripts/test-find-ranking.js
# /api/find and a stated conversion direction
t node scripts/test-find-direction.js
# /api/find: past find-misses a catalog tool answers rank it first and read as served (scripts/fixtures/find-misses.json)
t node scripts/test-find-misses-corpus.js
# /api/find and catalog.find: a search with the operator token records no find-miss; Vary and no-store on the header (booted)
t node scripts/test-find-operator-quiet.js
# /openapi.json coverage (every CATALOG tool has a path + operationId + x-price)
t node scripts/test-openapi-coverage.js
# /openapi.json schemas: every operation's request and answer schema present, compiling under 2020-12, examples valid, GET tools declare every input (boots free-mode)
t node scripts/test-openapi-schemas.js
# MCP prompts/list + prompts/get (one prompt per skill pack; substitution renders)
t node scripts/test-mcp-prompts.js
# MCP outer transport limits (R-11 — per-IP cap + concurrency ceiling bound floods before server/transport allocation — spawns child)
t node scripts/test-mcp-limits.js
# Hosted connector bounds: a free answer past the size ceiling is cut to valid JSON with answerBound fields, catalog.search holds its row maximum for any limit, a refusing limiter
t node scripts/test-mcp-answer-bound.js
# Hosted connector and revenue view error text: a configured key or a database URL's password an error quotes never reaches an answer, the reason stays (offline, bare express + mountMcp)
t node scripts/test-mcp-error-redaction.js
# x402 MCP transport codec: payment-required and invalid-payment results with MPP _meta kept byte for byte (x402/ keys never merged), _meta payment reader refuses malformed input as 400 with size and depth bounded before serialization, PAYMENT-SIGNATURE and PAYMENT-RESPONSE round trips through @x402/core, the official @x402/mcp client (installed --no-save by the step before) pays and re-signs against it (offline, in-memory)
t node scripts/test-mcp-x402.js
# x402 MCP wire on the hosted connector: a flagship's first ask carries the twin's PaymentRequired beside the MPP challenges, the official @x402/mcp client (installed --no-save by the step before) pays it and reads the settle receipt, memory.read keyed on the signed payer, replay refused, settle failure and error answers unsettled with no output, MPP wins when both are sent, a free tool at its limit offers x402, paid calls meet their own larger per-IP transport limit, the copy names only the wires offered (paid boot, stub facilitator, in-process mounts)
t node scripts/test-mcp-x402-connector.js
# A paid replay the hosted MCP connector stopped waiting for: the call id rides only the genuine marker, a settled answer the connector never read is booked as owed in either order (an event-loop stall reproduced over the real loopback client), one outcome per call, bounded entries, server and connector wiring pins (offline, port 0)
t node scripts/test-mcp-loopback-cut.js

# @step 2: Offline suites (21 scripts, one process each)
# /llms.txt content lock (tool count + discovery URLs + PoW/MCP/wallet signals)
t node scripts/test-llms-txt.js
# Every HTML page names /llms.txt (head link + Link header); /api/pricing and the x402 manifest name EVM-only routes
t node scripts/test-llms-link.js
# Copy about paying on the hosted MCP connector names the wires that boot takes in the call and no other: /llms.txt, /agents.md, /how-to-pay, /quickstart, /learn/mcp-payments, /integrations/mcp and the agent-hosts guide against the connector's own instructions, descriptions, payment.info and first ask, on a paid boot with MPP, a paid boot without, and FREE_MODE; static trees name x402 wherever they name MPP on the connector (three boots, stub facilitator)
t node scripts/test-connector-pay-copy.js
t node scripts/test-start-page.js
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
# A changelog entry about something a switch sells is on /changelog and its feed only while the switch is on.
t node scripts/test-changelog-switched.js
# NOTICE, the README, CONTRIBUTING.md and /llms-full.txt carry one ownership sentence, word for word (offline)
t node scripts/test-ownership-statement.js
# Seller text on the agent-read JSON surfaces is cleaned and capped at serve time; a flagged listing is marked and served without its description
t env AGENT402_SHOW_ROUTER=1 node scripts/test-listing-text-serve.js
# An operation's OpenAPI externalDocs.url is kept only as a same-host https link and served as sellerDocsUrl on /api/index?seller= alone, withheld on a flagged row (boots a server and reads every other surface)
t node scripts/test-seller-docs-url.js
# Seller reputation: scoring math and minimum samples, the fold (our own failed reads, robots, registry-only records and verdict-less probes left out), store bounds, the delivery recorder's exclusions (off unless the production crawl runs, outside a request, a request that is ours), no payment/buyer/settlement field; /api/reputation cache header, capped rows, refusals and hostile values, ?seller= and the seller card (boots a server on a seeded index)
t node scripts/test-seller-reputation.js
# Reputation output and copy state measurements, never a judgment word (offline)
t node scripts/test-reputation-wording.js
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
# PostHog LLM analytics and error tracking: each event carries only its allowlisted fields and no prompt, answer, body, header value, payer address or secret; sampling, hourly ceilings, the fingerprint window and the bounded queue hold; off switches and an absent key send nothing (offline)
t node scripts/test-posthog-observability.js
# render-film --out: absolute paths are used as given, relative ones read from the repository root (offline)
t node scripts/test-render-film-out.js
# Wallet sign-in (EIP-4361): nonce replay, cross-domain message, wrong URI, wrong chain, expired message and token, altered and foreign tokens, sign-out; a signed payer wins and a different session wallet is refused; off mounts nothing (two FREE_MODE boots)
t node scripts/test-wallet-sign-in.js
# Web Bot Auth verification: the RFC 9421 Ed25519 example, draft-shaped signatures and each refusal, bounded directory fetches, never refusing a request; every switch off and on answers pricing, openapi, llms.txt and the identity-bound 402s byte for byte alike (two paid boots, stub facilitator)
t node scripts/test-web-bot-auth.js
# Configuration reference: every environment variable src/ reads has a purpose line; docs/configuration.md is current (offline)
t node scripts/test-config-reference.js
# Debug and test switches are never honored on a production boot (src/test-seams.js; offline)
t node scripts/test-debug-off-in-production.js
# Every declared package is imported (offline)
t node scripts/test-unused-deps.js
# CycloneDX SBOM from package-lock.json: deterministic, no network (offline)
t node scripts/test-sbom.js
# Data-room metrics read only the public surfaces (stub, then a FREE_MODE boot on port 0)
t node scripts/test-data-room-metrics.js
