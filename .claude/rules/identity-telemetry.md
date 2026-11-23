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
  most 3600, never past the message's Expiration Time); nonces are per process (one replica). A sign-out
  is this process's map plus, with Redis, the shared flag `wsess-out` keyed by the token's id and expiring
  with the token: `revoke` awaits the write (a miss answers the DELETE 503 `signedOutHere`, and a repeat
  writes again), and the middleware `mountWalletSignIn` adds awaits `syncRevocation` before any route
  registered after it, so a container that never saw the DELETE, or started after it, refuses the
  token. Only a live token this server signed reaches the store. A store that does not answer the
  READ leaves this process's record to decide and the session served (a refusal there would end every
  valid session on a store miss; the window is a token signed out elsewhere, for the outage and at most
  the token's life), noted under `wallet-session` (`scripts/test-wallet-sign-out-redis.js`, two servers
  and a later-started third on one Redis). A route that reads a session is registered after the mount.
  `resolveRouteIdentity(req, scope, identityPayerOf(req))` is the only reader: a signed EVM payer always
  wins, a session naming another wallet is a 400, a PoW or trial call is a 402, a bad token a 401 (none
  charged). A session is read-only. Scopes: my-usage, receipts, and the memory reads in
  `MEMORY_SESSION_SLUGS` (memory-read, the memory-grants listing); every memory route in
  `MEMORY_WRITE_SLUGS` passes `WRITE_SCOPE` and refuses a session with no signed payer (403); attest, feedback and every attribution reader (sales, refunds, ledger,
  `payer.js`) never read a session. A session is identity, never payment: the route's price is unchanged.
- **Web Bot Auth:** `src/web-bot-auth.js`, off unless `WEB_BOT_AUTH=on` (exactly). Verification only (the
  protocol is an Internet-Draft): RFC 9421 signatures tagged `web-bot-auth`, Ed25519 only, keys from the
  Signature-Agent's directory fetched in the background through `safeFetch` (no redirects, 64 KB, 20 keys,
  30 fetches a minute, 4 at once, 500 cached, an hour each; a failure waits 10 minutes). The outcome is
  `req.webBotAuth` and the `web_bot_auth` PostHog rollup; it never refuses or changes an answer.
- **Trusted Agent Protocol (Visa CLI):** the second branch of `src/web-bot-auth.js`, behind the same
  switch, for tags `agent-browser-auth` and `agent-payer-auth`: Ed25519, keyid a JWK thumbprint whose key
  comes only from the pinned registry `TAP_REGISTRY_ORIGIN` (`/v1/tap/registry/keys/{keyid}`; active,
  not simulated, thumbprint equal to the keyid), read in the background (16 KB, 5 s, no redirects, 30 a
  minute (keys never verified at most half of them), 4 at once, 500 cached, at most 60 s each, a miss 60 s); `@authority`/`@scheme` from BASE_URL;
  windows 60 s (identity) and 480 s (payer); Content-Digest hashed as the body parser reads the body (a
  passive tap on the stream's events, 1 MiB); a payer signature covers every payment credential header
  present, an identity one never covers authorization or cookie; Signature-Agent only compared with the
  two directory origins; the nonce claimed once in the shared store (`tap-nonce`, a store that does not
  answer leaves it unverified). A pass sets `req.visaCliAgent` and the rollup agent `visa-cli`; it is a
  label only: no module but `web-bot-auth.js` reads either field, and proof of work, rate limits and
  payment answer a signed request as an unsigned one (`scripts/test-visa-tap.js`, which boots with
  `scripts/lib/tap-registry-preload.js` in place of the registry). Reasons read `tap-*`.
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
- New request headers read here (`signature`, `signature-input`, `signature-agent`, `content-digest`, `x-wallet-session`)
  are in `scripts/test-redos-request-headers.js`, timed directly since the boots there leave both off.
