# Security Policy

Agent402 handles real money (USDC settlement via x402), runs a headless browser
against user-supplied URLs, and stores wallet-keyed data — security reports are
taken seriously and acted on fast.

## Reporting a vulnerability

- **Preferred:** open a [private security advisory](https://github.com/MikeyPetrillo/Agent402/security/advisories/new) on this repository.
- Or open a regular issue *without exploit details* and ask for a private channel.
- Maintainer contact: [mikepetrillo.dev](https://mikepetrillo.dev/).

Please include reproduction steps and impact. You can expect an initial response
within a few days; fixes for real issues ship through the normal CI pipeline
(which re-tests every endpoint) as soon as they're ready.

## Scope

- The live service at `agent402.tools` (including `/mcp` and the marketplace bridge)
- This codebase: SSRF guards, the proof-of-work scheme, payment gating, the memory access-control model
- The `agent402-mcp` npm package (especially the spend-control enforcement)

Out of scope: the x402 protocol itself, the Coinbase facilitator, Base/USDC
contracts, and volumetric denial-of-service.

## Existing defenses (verify them)

The security model — DNS-pinned SSRF guards with per-request browser
re-validation, single-use slug-scoped proof-of-work, wallet-only gating of
costly tools, timing-safe token comparison — is documented in the
[Security Model wiki page](https://github.com/MikeyPetrillo/Agent402/wiki/Security-Model)
and is all in this repo to read.
