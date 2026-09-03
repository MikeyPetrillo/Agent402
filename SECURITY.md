# Security Policy

Agent402 handles real money (USDC settlement via x402 and MPP, card payments via
Stripe for reports, monitors and prepaid credits), runs a headless browser
against user-supplied URLs, and stores wallet-keyed data - security reports are
taken seriously and acted on fast.

## Reporting a vulnerability

- **Preferred:** open a [private security advisory](https://github.com/MikeyPetrillo/Agent402/security/advisories/new) on this repository.
- Or open a regular issue *without exploit details* and ask for a private channel.
- Direct email: **mike@agent402.tools**.
- Maintainer: [Havok Holdings LLC](https://havok.holdings) - [github.com/MikeyPetrillo/Agent402](https://github.com/MikeyPetrillo/Agent402).

Please include reproduction steps and impact. Good-faith research inside the scope below will not be met
with legal action. You can expect an acknowledgement within two business days; fixes for real issues ship through the normal CI pipeline
(which re-tests every endpoint) as soon as they're ready.

## Scope

- The live service at `agent402.tools`, including `/mcp`, the `/v1` LLM gateway and report
  products, the x402 / MPP paywall on every paid route, the prepaid-credits gate
  (`Authorization: Bearer a402_...`), and the card front door (`/reports`, `/monitors`,
  `/credits`, the Stripe webhook)
- This codebase: SSRF guards, the proof-of-work scheme, payment gating, the memory access-control model
- The `agent402-mcp` npm package (especially the spend-control enforcement)
- The `agent402-client` buyer SDK and the `agent402-tollbooth` pay-per-crawl gate

Out of scope: the x402 protocol itself, the Coinbase facilitator, Base/USDC
contracts, and volumetric denial-of-service.

## Controls on the code

Every pull request runs CodeQL, gitleaks secret scanning (with a planted-canary self-check), Socket
dependency review, DCO sign-off and the full test lanes, all required before merge; every GitHub
Action is pinned to a full commit SHA; payment, gating and CI paths require code-owner review; the
container image is pinned by digest and runs as a non-root user; npm packages publish through OIDC
with provenance. The human-readable version is at https://agent402.tools/security.

## Existing defenses (verify them)

The security model - DNS-pinned SSRF guards with per-request browser
re-validation, single-use slug-scoped proof-of-work, wallet-only gating of
costly tools, timing-safe token comparison - is documented in the
[Security Model wiki page](https://github.com/MikeyPetrillo/Agent402/wiki/Security-Model)
and is all in this repo to read.
