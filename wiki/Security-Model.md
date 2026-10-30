# Security Model

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

The whole server is open source - these claims are checkable in code.

## No accounts = no account attack surface

There is nothing to sign up for, so there are no passwords, sessions, password resets, or PII stores to breach. Identity, where needed (memory), is proof of wallet control via the x402 payment itself. The card paths keep that shape: a prepaid credits key is a hashed bearer key (no login), a report link is the bearer for that one report, and the Stripe webhook is signature-verified (`STRIPE_WEBHOOK_SECRET`), so nothing trusts an unsigned claim of payment.

## Credits, cards and identity-bound routes

- **Identity-bound tools take wallet payments only.** Memory, `my-usage`, `receipts`, `attest` and `feedback` read the payer from the signed EIP-3009 authorization. A prepaid credits key or a Tempo/Stripe MPP credential carries no verified wallet, so those gates refuse identity-bound routes (`402`, `reason: "identity-bound"`) and strip any x402 payment headers that ride along when they accept a request, so a forged `authorization.from` can never reach a memory handler for a sub-cent credit.
- **Outside-seller routes take wallet payments only.** The route-execute tiers, `seller-payability`, `/api/decide/execute` and the flight routes buy from an outside seller with our wallet; the credits gate refuses them (`402`, `reason: "third-party-purchase"`) and the card challenge over MPP is never offered on them, because credits and cards pay Agent402's own services only.
- **Credits are held, then settled.** The credits gate reserves the list price before the handler and converts the hold to a debit only on a final `200`; concurrent calls on one key cannot overspend it, a client abort releases the hold while the call holds a hang-up forgiveness ticket, and keys are stored hashed. A refund or dispute on the pack disables the key.
- **Card report sessions generate once.** A report is produced only for a Stripe-verified paid session, exactly once per session; a failed run is refunded automatically and an unissued refund is recorded as owed and retried. Monitor status is re-read from Stripe before every paid run, so a canceled subscriber is not fulfilled.
- Long-running composite routes (the report products) are offered on rails whose payment cannot expire before the handler finishes (EVM exact), never on a rail whose signed payment would lapse mid-run.

## SSRF defense (the big one for a URL-fetching service)

Tools that fetch user-supplied URLs (`extract`, `meta`, `render`, `screenshot`, `pdf`, …) are a classic SSRF target. Defenses (`src/tools/fetch-guard.js`):

- DNS resolution is **pinned and validated**: the resolved IP is checked against private/internal ranges and the connection is made to the validated IP (no resolve-then-re-resolve gap).
- The IPv6 filter handles the sneaky encodings: IPv4-mapped (`::ffff:10.0.0.1`), NAT64, 6to4, Teredo, link-local, ULA - **fail-closed** on anything unparseable.
- Cloud metadata (`169.254.169.254` and friends), localhost, and RFC1918 are unreachable. CI asserts this on every run.
- **The browser is re-guarded per request**: Chromium does its own DNS, so the upfront check isn't enough (rebinding, redirects, subresources). Every request the page makes is re-validated against the same public-IP policy at request time and aborted if it targets private space.

## Why some tools are wallet-only

Proof-of-work proves *effort*, not *cost coverage*. Anything that spends real resources per call - Chromium time, network egress, the paid search index, disk (memory), ffmpeg CPU - would otherwise be farmable through the free tier. So the free tier is an allowlist: `FREE_TIER_SLUGS` in `src/free-tier.js` names the pure-CPU tools that are free, a new tool is wallet-only until it is listed there, and `WALLET_ONLY_SLUGS` in `src/pow.js` is a reviewed override that wins over it. `scripts/test-free-tier-egress.js` proves every listed tool makes no outbound call.

## Proof-of-work hardening

- Challenges are HMAC-signed server-side, **single-use** (a replay table in the state database), short-lived, and scoped to exactly one tool slug - no wildcard tokens, no retargeting, no replay.
- Difficulty (16 bits) prices abuse in CPU while keeping legitimate use sub-second.

## Free-tier abuse limits

- Hosted MCP connector: free calls are limited to the pure-CPU set, per-IP sliding window (20/min, 120/hr); wallet-only tools are payable in the call over MPP.
- Operator surfaces (`/__operator/*`, `POST /api/status/probe`): token auth with a timing-safe compare. The uptime probe endpoint is authed precisely because an open one would let anyone forge our availability record.
- Card endpoints that make an outbound Stripe call (`/api/buy`, `/api/subscribe`, `/api/credits/checkout`, session reads) are per-IP rate-limited, and unknown or unpaid session ids are negatively cached, so nobody can amplify requests into Stripe through us.

## Payment safety (for buyers)

- The server never sees a private key - buyers sign locally; the facilitator settles.
- Client-side spend caps exist at every layer (see [[Paying with x402]]).
- Settlement is on-chain and publicly auditable; the seller cannot inflate revenue claims.

## Sanctions screening

When the server settles Tempo payments itself (`TEMPO_RELAY=off`), every party to a payment, and the wallets that recently funded the payer, are checked against OFAC's SDN list before anything settles. A listed party is refused and nothing is settled; a push transfer such a party already sent is held for review. Without a loaded list the server offers no Tempo challenge at all, so a payment is never accepted unscreened. An x402 payment's EVM payer (the signed `authorization.from`, or the Permit2 signer) is checked against the same list after the payment verifies and before the tool runs; a listed payer is refused with a 403 and nothing settles. If the list has not loaded, x402 payments are served and `/api/gateway-status` reports the screen as missing. A Solana, Stellar or Algorand payment's signer is checked the same way after the payment verifies Payments the router makes to outside sellers are screened against the same list. The list is read from OFAC's full SDN XML export and refreshed on a schedule; `/api/gateway-status` reports its state as one word.

## Supply chain

- `npm audit` is kept at zero known vulnerabilities - dependencies with unfixable advisories get removed along with their tools (this happened to the Excel tools: SheetJS prototype-pollution/ReDoS on untrusted input, no patched build installable - tools deleted rather than shipped vulnerable).
- ffmpeg and all child processes run via `execFile` (no shell interpolation), with size and time limits.
