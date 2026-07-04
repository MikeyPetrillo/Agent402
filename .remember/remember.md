# Handoff

## State
PRs #213-#229 shipped. 1,358 tools, 51 skill packs, 6 chains. Stellar confirmed with real payment. ACP live. Premium packs deployed. Canary 60/60 on last clean run.

## Next — Fix skill pack reliability
1. **Premium packs failing steps** — company-dossier, domain-intel, crypto-dossier all have steps that timeout locally. On prod with relays they may score better, but VERIFY. Every step must pass.
   - Likely culprits: `extract` (needs Chromium, can timeout), `search` (Brave rate limit), `cert-transparency` (slow upstream)
   - Fix: add retries, increase timeouts for chain-mode packs, or remove unreliable steps
2. **Run paid canary with the new packs** — add company-dossier/domain-intel/crypto-dossier to canary and confirm ALL steps pass on prod
3. **Framework adoption** — starter templates are in `examples/`. Submit as PRs to LangChain/CrewAI docs.
4. **Registrations** — Circle (agents.circle.com/services), x402 Foundation (linuxfoundation.org/x402foundation), Stellar ecosystem

## Context
- Partial success in skill packs is NOT OK — user expects 100% of steps to work (see feedback memory)
- Premium pack prices: company-dossier $0.50, domain-intel $0.25, crypto-dossier $0.30
- financial-analysis bumped to $0.08, market-brief to $0.05
- Stellar facilitator key: on Railway as STELLAR_FACILITATOR_KEY (OpenZeppelin, Bearer auth)
- First Stellar payment confirmed: 49s settlement, $0.001 USDC
