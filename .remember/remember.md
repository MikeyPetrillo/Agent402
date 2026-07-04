# Handoff

## State
All merged and deployed. PRs #213-#218 shipped: company-financials, multi-search, whois retry, PostHog payer tracking, financial-analysis pack, market-brief pack. Canary 60/60. Tool count: 1355.

## Next
1. Monitor price bumps in ~1 week (edgar-company-lookup/whois/gas-snapshot $0.001→$0.005) — check volume holds
2. Check PostHog for first `payer` events once external wallets buy again — validate tracking works
3. Solana isn't broken (confirmed), but Bazaar only indexes Base — consider a periodic discovery ping or manual listing to surface Solana availability

## Context
- Deploy is two-keyed: `[deploy]` in commit msg + touch `.github/trigger-deploy`
- Skill packs need entry in 3 places: `src/skills.js`, `src/tools/skill-runner.js` (PACK_PRICES + PACK_STEPS), `src/pow.js` (WALLET_ONLY_SLUGS)
- financial-analysis earnings-calendar step can timeout via Nasdaq (Railway egress WAF) — known, non-blocking (partial-success envelope handles it)
