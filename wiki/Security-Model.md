# Security Model

The whole server is open source — these claims are checkable in code.

## No accounts = no account attack surface

There is nothing to sign up for, so there are no passwords, sessions, password resets, or PII stores to breach. Identity, where needed (memory), is proof of wallet control via the x402 payment itself.

## SSRF defense (the big one for a URL-fetching service)

Tools that fetch user-supplied URLs (`extract`, `meta`, `render`, `screenshot`, `pdf`, …) are a classic SSRF target. Defenses (`src/tools/fetch-guard.js`):

- DNS resolution is **pinned and validated**: the resolved IP is checked against private/internal ranges and the connection is made to the validated IP (no resolve-then-re-resolve gap).
- The IPv6 filter handles the sneaky encodings: IPv4-mapped (`::ffff:10.0.0.1`), NAT64, 6to4, Teredo, link-local, ULA — **fail-closed** on anything unparseable.
- Cloud metadata (`169.254.169.254` and friends), localhost, and RFC1918 are unreachable. CI asserts this on every run.
- **The browser is re-guarded per request**: Chromium does its own DNS, so the upfront check isn't enough (rebinding, redirects, subresources). Every request the page makes is re-validated against the same public-IP policy at request time and aborted if it targets private space.

## Why some tools are wallet-only

Proof-of-work proves *effort*, not *cost coverage*. Anything that spends real resources per call — Chromium time, network egress, the paid search index, disk (memory), ffmpeg CPU — would otherwise be farmable through the free tier. The `WALLET_ONLY_SLUGS` set in `src/pow.js` is the explicit, reviewable list.

## Proof-of-work hardening

- Challenges are HMAC-signed server-side, **single-use** (SQLite replay table), short-lived, and scoped to exactly one tool slug — no wildcard tokens, no retargeting, no replay.
- Difficulty (16 bits) prices abuse in CPU while keeping legitimate use sub-second.

## Free-tier abuse limits

- Hosted MCP connector: only the pure-CPU set executes; per-IP sliding window (20/min, 120/hr).
- Marketplace bridge: secret-token auth (timing-safe compare) + a global rate cap, so a leaked endpoint URL is bounded.

## Payment safety (for buyers)

- The server never sees a private key — buyers sign locally; the facilitator settles.
- Client-side spend caps exist at every layer (see [[Paying with x402]]).
- Settlement is on-chain and publicly auditable; the seller cannot inflate revenue claims.

## Supply chain

- `npm audit` is kept at zero known vulnerabilities — dependencies with unfixable advisories get removed along with their tools (this happened to the Excel tools: SheetJS prototype-pollution/ReDoS on untrusted input, no patched build installable — tools deleted rather than shipped vulnerable).
- ffmpeg and all child processes run via `execFile` (no shell interpolation), with size and time limits.
