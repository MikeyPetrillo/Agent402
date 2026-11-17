# Test list for the test lane of .github/workflows/deploy.yml.
# Each "# @step N" section is the body of the deploy.yml step that runs
# `bash scripts/ci/run-step.sh test N`; that step keeps its env and services.
# scripts/ci/run-step.sh defines `t` and evaluates the section, so each line runs
# exactly as it would inside the step's own run block.

# @step 1: Offline suites (17 scripts, one process each)
# Deterministic correctness proofs run FIRST — a flaky live upstream
# (e.g. data.gov downtime) must never mask whether the tools actually work.
# Secret-leak guard (canary keys never reach responses, caches, or errors; gateway cost-strip — offline)
t node scripts/test-leak-guard.js
# Tool errors: the route binder and the error log scrub configured secrets and credential-bearing URLs (own port-0 boot)
t node scripts/test-tool-error-redaction.js
# Weather kit: keyed Open-Meteo hosts and apikey only with the key, a keyed 429 is an uncharged 503 with no public-host fallback, no key in errors or logs (offline)
t node scripts/test-open-meteo-keyed.js
# Paid-canary verdict (pages on real buying breaks, warns on upstream)
t node scripts/test-paid-canary.js
# derivatives kit (offline)
t node scripts/test-derivatives-kit.js
# solana-intel kit (offline)
t node scripts/test-solana-intel-kit.js
# computed crypto answers and the lending-rate contract reads (offline, stubbed)
t node scripts/test-crypto-screens-kit.js
t node scripts/test-lending-rates-kit.js
# market tick: stubbed sources, the per-symbol cache, partial marking, and the MARKET_TICK switch (offline)
t node scripts/test-market-tick.js
t node scripts/test-cve-kit.js
# mcp-package kit (offline, stub registry on port 0)
t node scripts/test-mcp-package-kit.js
# crypto-signals kit (offline)
t node scripts/test-crypto-signals-kit.js
# Hyperliquid info cache shared by the two Hyperliquid kits (offline)
t node scripts/test-hyperliquid-shared-cache.js
# openFDA reference tools: labels, NDC, 510(k), device MDRs (offline)
t node scripts/test-openfda-reference.js
# x402-market-pulse category classifier (path-aware, closed taxonomy)
t node scripts/test-ecosystem-category.js
# token brief kit (offline)
t node scripts/test-token-brief-kit.js
# crypto-markets kit (offline)
t node scripts/test-crypto-markets-kit.js
# CoinGecko host and key header per COINGECKO_API_TIER, every calling kit (offline)
t node scripts/test-coingecko-endpoint.js
# Offline suites that stub an upstream pass with every real name lookup refused (the address guard's resolver; booted servers inherit the preload)
t node scripts/test-offline-suites-no-dns.js
