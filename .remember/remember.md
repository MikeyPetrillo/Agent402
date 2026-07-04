# Handoff

## State
PRs #213-#240 shipped. 1,358 tools, 51 skill packs, 6 chains all proven with real settlements. Revenue page shows all chains with timestamps. 63/63 canary. Polygon+Arbitrum CI probes pass. Stellar confirmed.

## Next
1. Record viral demo: `AGENT_KEY=0x... node scripts/demo-company-onepager.js NVDA` → post to @Agent402Tools
2. Register: Circle (agents.circle.com/services), x402 Foundation (linuxfoundation.org/x402foundation)
3. Submit to Stellar ecosystem page
4. Monitor price bumps in ~1 week
5. Framework adoption: submit starter templates as PRs to LangChain/CrewAI docs

## Context
- Revenue page uses Alchemy for ALL EVM chains (Base/Polygon/Arbitrum/Robinhood) — free RPCs don't serve getLogs from Railway
- Solana scan queries the TOKEN ACCOUNT not the wallet address
- Stellar scan accepts invoke_host_function (Soroban) + path_payment_strict_send
- Skill packs must pass ALL steps — no partial success allowed
- company-dossier is fanout (not chain) to avoid Railway 30s timeout
- agent-e2e.js is the ACTUAL canary script (not paid-canary.js)
