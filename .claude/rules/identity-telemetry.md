---
paths:
  - "src/wallet-sign-in.js"
  - "src/web-bot-auth.js"
  - "src/posthog.js"
  - "src/posthog-observability.js"
  - "src/payer.js"
  - "src/tools/usage-kit.js"
---

# Wallet sessions, signed agents, server telemetry

Loaded when a sign-in, signed-agent, payer or PostHog file is read.

- **Wallet sign-in (EIP-4361):** `src/wallet-sign-in.js`, off unless `SIWE_SESSION_SECRET` is set (at
  least 32 characters); off, no route mounts and no header is read. On: `GET /api/wallet-session/nonce`,
  `POST /api/wallet-session` `{message, signature}`, `DELETE /api/wallet-session` (sign-out), per-IP
  limited. A nonce lives 5 minutes and is spent by the first verify naming it; the message must match the
  EIP-4361 layout line by line, name BASE_URL's host and origin, a chain in `SIWE_CHAIN_IDS` (default
  8453,1,137,42161,10), and recover to its own address (EOA signatures only). The token
  (`X-Wallet-Session`) is HMAC-signed, bound to the host, lasts `SIWE_SESSION_SECONDS` (default 900, at
  most 3600, never past the message's Expiration Time); nonces and sign-outs are per process (one replica).
  `resolveRouteIdentity(req, scope, identityPayerOf(req))` is the only reader: a signed EVM payer always
  wins, a session naming another wallet is a 400, a PoW or trial call is a 402, a bad token a 401 (none
  charged). Scopes: my-usage, receipts, and the memory slugs in `MEMORY_SESSION_SLUGS` (grants and
  revocations stay payer-only); attest, feedback and every attribution reader (sales, refunds, ledger,
  `payer.js`) never read a session. A session is identity, never payment: the route's price is unchanged.
- **Web Bot Auth:** `src/web-bot-auth.js`, off unless `WEB_BOT_AUTH=on` (exactly). Verification only (the
  protocol is an Internet-Draft): RFC 9421 signatures tagged `web-bot-auth`, Ed25519 only, keys from the
  Signature-Agent's directory fetched in the background through `safeFetch` (no redirects, 64 KB, 20 keys,
  30 fetches a minute, 4 at once, 500 cached, an hour each; a failure waits 10 minutes). The outcome is
  `req.webBotAuth` and the `web_bot_auth` PostHog rollup; it never refuses or changes an answer.
- **PostHog LLM analytics and error tracking:** `src/posthog-observability.js`, off by default: each
  stream needs its own switch set to exactly `on` (`POSTHOG_AI_EVENTS=on`, `POSTHOG_EXCEPTIONS=on`) and
  `POSTHOG_API_KEY` (the same production guard as the rest of `src/posthog.js`). The privacy page's
  sentence for each stream renders only while its switch is on (`aiEventsEnabled`,
  `exceptionEventsEnabled`). `$ai_generation` rides `capturePostHogGatewayUsage`
  (model, tier, token counts, status; never a prompt, answer or cost); `$exception` comes from
  unhandled rejections, the fatal uncaught exception and tool 5xx (scrubbed message, frames as file and
  line). Every event is an allowlist (`*_FIELDS`), pinned by `scripts/test-posthog-observability.js`;
  a new field goes in the allowlist and the privacy page in the same change. Bounded: one 256-entry
  queue, `POSTHOG_AI_SAMPLE` / `POSTHOG_EXCEPTION_SAMPLE` (default 1), `POSTHOG_AI_HOURLY_MAX` (3000),
  `POSTHOG_EXCEPTION_HOURLY_MAX` (120), one exception per fingerprint per 10 minutes.
- New request headers read here (`signature`, `signature-input`, `signature-agent`, `x-wallet-session`)
  are in `scripts/test-redos-request-headers.js`, timed directly since the boots there leave both off.
