---
paths:
  - "src/mcp-*.js"
  - "mcp/**"
  - "src/front-door.js"
  - "src/answer-share.js"
---

# MCP connector and agent-facing surfaces

Loaded when a connector or front-door file is read.

- **Connector modules:** `src/mcp-mpp.js` makes wallet-only tools payable on the connector by replaying the call as a
  loopback request to the real paid route; `src/mcp-tasks.js` handles long calls as MCP tasks;
  `src/mcp-skills.js` serves skill packs over the Skills extension (`MCP_SKILLS=on`, negotiated only).
  `src/mcp-x402-routes.js` holds internal x402 twins of six fixed-price flagships at `/__mcp-x402/<slug>`:
  reachable only with the loopback secret (anything else is the ordinary 404), rewritten to the tool's route
  and priced by its accepts with resource `/mcp` and an MCP discovery extension; a flagged request the twin
  paywall does not price runs the route's own paywall.
  `src/mcp-x402.js` is the x402 MCP transport codec (`_meta["x402/payment"]` in, payment-required,
  invalid-payment and settlement-failed results, `x402/payment-response` out), pure.
  `/mcp` wires both (`x402Loopback`, off in FREE_MODE): a flagship called by its listed name with a twin
  is asked and paid on the twin, `catalog.call` (and a flagship without a twin) on the slug's own HTTP
  route; the first ask carries the x402 PaymentRequired (JSON in the first text block, never
  `structuredContent`: every paid tool lists an `outputSchema`, and the SDK client checks any
  structuredContent against it, error results included) beside the MPP `_meta` challenges; a
  settlement-pending result carries its fields in `_meta["org.agent402/settlement-pending"]`; a fixed-price
  unpaid offer (a twin's first ask, a free tool's at its limit) is read once per route and reused for 30 s
  (bounded, `offerCacheMax`), a route priced per request every time; MPP wins when
  both are sent; x402 is blocking only (a slow route is refused before the payment is presented; it
  is paid in the call over MPP as a task, and public copy says so). Every text the connector writes
  about paying in the call reads `payWires` (`connectorWires()`, src/connector-pay.js, never in
  FREE_MODE), the account the pages read (`scripts/test-connector-pay-copy.js`).
  A tools/call whose `_meta` holds a plausible payment (`metaCarriesPayment`: an MPP credential that
  decodes within the HTTP header limit, checked before it is serialized or decoded, or an x402 payment on an
  offered network) is counted on its own per-IP transport bucket
  (`AGENT402_MCP_PAID_REQ_PER_MIN`/`_HOUR`, default 5x the normal one); unless the call then reaches a
  paywall replay (`reachesPaidReplay`), the handler also holds it to the normal bucket, so a credential
  on a discovery tool buys nothing. A free tool at its limit offers its route's x402 challenge. A 402
  whose settlement is undecided (retry same-payment or watch-transaction, or settlement_pending) is the
  pending result: the route's hint, no offer. A settle that failed never gets an offer: any 402 carrying a settle
  receipt marked `success: false`, on either wire, is the route's explanation with no offer and the
  transaction to watch when one is named (`buildSettlementUnprovenResult`), since the receipt does not
  say how a settle fallback ended; a 5xx after a payment was presented is the route's answer with no offer
  (`buildPaidRouteFailedResult`). A verify refusal (no settle receipt) keeps its fresh offer. A long call is refused before its payment is read. A twin's unpaid offer is reused for 30 s
  (`scripts/test-mcp-x402-connector.js`).
  The interop suites need the official `@x402/mcp` client, which CI installs with `--no-save` in the
  step before them and `package.json` never lists (an optional peer of mppx would ship in prod).
- **Protocol revisions (SDK v2, `@modelcontextprotocol/server` + `/node`):** `/mcp` serves 2026-07-28 and the 2025 era
  from one `buildServer`. `isLegacyRequest` (the SDK's own classifier, fed `eraProbeOf(req)` and the parsed body) picks
  the path: a request carrying `_meta["io.modelcontextprotocol/protocolVersion"]` goes to `createMcpHandler(..., { legacy:
  "reject" })` (server/discover, the envelope, `Mcp-Method`/`Mcp-Name` checks, `resultType` and `serverInfo` stamped on
  results); everything else (initialize, 2024-10-07 to 2025-11-25) to a per-request `NodeStreamableHTTPServerTransport`
  with JSON responses, byte for byte the SDK v1 answers. Errors keep v1's "MCP error <code>: " message prefix (the local
  `McpError`). The SDK lifts `io.modelcontextprotocol/*` keys out of `params._meta` before a handler runs, on both
  eras: read a per-request client capability from the raw body (`declaredCapabilities`), never from `req.params._meta`.
  Our own answers ahead of the SDK (tasks, skills, the deadline cutoff) carry `resultType` on a 2026-07-28 request, and a
  missing client capability there is a 400. `scripts/mcp-client-check.js` reads both (`MCP_CHECK_PROTOCOL=2026-07-28`
  uses the v2 client); the stdio package still runs SDK v1.
- **Front door:** `src/front-door.js` writes the three lines that lead `/llms.txt`, `/agents.md`
  and `server.describe`; the access line names coins and wires from the rails list and the MPP
  config. The unpaid 402 body carries the access line and the `/agents.md` link only with
  `FRONT_DOOR_402=on` (exactly); otherwise the body is the offer alone.
- **llms.txt short index:** `llmsTxt` (`src/seo.js`) keeps one clause per Key machine surfaces line
  (`surfaceClause`, `SURFACE_CLAUSE_MAX`; an entry in its `brief` list keeps that surface's own words)
  and points at /llms-full.txt, which keeps every line whole. `scripts/test-front-door.js` boot 3 runs
  production's switches plus the batched and channel blocks under the 16,384-byte bound.
- **Orphaned tasks and jobs:** each run names a key (`newRunKey`, `src/mcp-tasks.js`) kept on its
  record (never on the wire; no payer is recorded) and sent on its loopback (`X-Agent402-Via-Run`
  beside the connector's marker, `x-agent402-async-run` beside the job token); the route books it
  on that sale's `run_key` (`saleRunKeyOf`, `src/sale-path.js`; read only beside its proof). An
  orphan is worded from the sales ledger by that key: a sale under it is charged and booked once
  through `onChargedFailure` to the sale's own payer (keyed `task-<taskId>` when it has no tx); none
  under it and no sale of the tool in the window that names no run keeps the restart words it always
  had (`ORPHAN_MESSAGE`, with the Tempo push exception); anything else
  (an unkeyed sale of the tool in the window, a keyless record from before keys, an unreadable
  ledger) claims neither and books nothing. The ledger is read only once loaded (bounded wait and
  pull); the database sweep leaves an orphan working while it has not loaded, for up to
  `limits.ledgerWaitMs` (5 minutes) (`scripts/test-mcp-task-orphan-charge.js`, `test-mcp-tasks-pg.js`).
- **Shareable answers:** `src/answer-share.js`, off unless `ANSWER_SHARE=on` (exactly); then web.answer takes
  `share=true` and writes a public page after a settled 200 (`/answers/:id`, record at `/answers/:id.json`);
  off, no surface offers it and existing pages serve until expiry. `ANSWER_SHARE_TTL_DAYS` (default 30)
  keeps it (then 410 expired for 90 days), `ANSWER_SHARE_PER_HOUR` (default 60) caps each payer's shares,
  claimed before the call, and `ANSWER_SHARE_DIR` is the file store without the state database. Takedown:
  `POST /__operator/answer-shares/delete {id, note}` (410 removed).
- **Connector sign-in (OAuth 2.1):** `src/mcp-oauth.js` (+ `src/mcp-oauth-page.js`), off unless `MCP_OAUTH=on`
  (exactly) and credits are on sale; off, every route falls through (404) and `/mcp` is untouched. Public clients
  by dynamic registration (https or localhost redirect URIs), authorize with PKCE S256 only, exact redirect_uri,
  state required; the consent page (no framing, CSRF token plus same-origin on every form, its own CSP whose
  form-action names this site, the card checkout and the app's return origin) signs the person in with a code
  emailed to any address, as the balance page's link is (single use, tries, lockout), offers buying a pack by
  card only once signed in, through `credits.createCheckout` with the email and client address (the purchase
  checks, card authentication and limits of `POST /credits/account/buy`; back to the same sign-in, which claims
  the session and accepts it only for that email), and binds one key id and a daily cap. A key frozen by a
  dispute or fraud warning (`disabled` with a `FROZEN` reason) is not offered and pays nothing under a grant
  (`authorizeOn` answers `frozen`). `/start` and `payment.info` name `/mcp/credits` only while both
  `CREDITS_SALES` and `MCP_OAUTH` are on (`creditsConnectorOn`, `src/credits-sales.js`). Codes single-use and short-lived, access
  tokens short-lived, refresh tokens rotated; a spent code or refresh token presented again revokes the whole
  grant. State is three size-capped json-documents (apps, pending sign-ins, grants with codes and tokens as
  digests; `clientStore`/`requestStore` passed from server.js); a registration past the cap evicts the oldest
  app that never completed a sign-in, and such apps are pruned after an idle limit. Pending sign-ins are
  capped per address and per app, each evicting its own oldest, before the global cap. The `/mcp` reader is
  mounted before the connector: a token of ours resolves to a grant (`req.mcpCreditsGrant`) or answers 401
  with `WWW-Authenticate` naming the metadata; no token, or someone else's, passes untouched. `/mcp/credits`
  is the same connector that answers 401 without a token. A paid tool under a grant is replayed with a
  one-call handle (`openGrantHandle`, `X-Agent402-Via-Grant`, read only beside the genuine marker) and paid
  by the credits gate; free tools stay free. The balance page lists grants (app, key, cap, spend today,
  created, last use, coarse network) and changes or revokes them. Lifetimes are `MCP_OAUTH_*`
  variables (docs/configuration.md); every limit (code tries, sends, lockout, per-address rates counted by
  `limiterKey`, so an IPv6 /64 is one address, the bad-token bound, the pending-request cap and the
  document size) comes from the private credits table (`mcpOAuth` in `src/credits-guards.js`), and the
  sign-in stays off without it. A wrong code is counted on the shared per-email counter before it is compared
  (a right code gives its count back); code sends have a global hourly budget and a per-address daily total.
  Tokens carry a server-keyed tag: a made-up token is refused with no store read, a token found bad is held
  as bad briefly, and only failed lookups are slowed (429 past the bound); a valid token is never refused.
  Under a grant a refusal names no balance and no key. The sign-in pages (one h1 each, errors with
  `role="alert"` tied to their field, a disabled form on lockout with a resend) are held by
  `scripts/test-mcp-oauth-pages.js`. Authorize errors are shown on this site, never redirected to the app's address. A refusal never
  names its check (`scripts/test-mcp-oauth.js`).
- **Answer ceiling:** a free tool answer larger than `AGENT402_MCP_MAX_ANSWER_BYTES` (default 1 MiB of compact JSON)
  is cut in document order to valid JSON and carries `answerBound` (`src/mcp-answer-bound.js`: the partial-answer
  fields in bytes, plus one entry per cut list, string or object). A paid answer is delivered whole.
- **Annotations:** `readOnlyHint: true` only on a tool that never charges and never writes on any path here
  (`catalog.search`, `catalog.find`, `sellers.list`, `server.describe`, `payment.info`); a host may run those without
  asking. Every flagship (it can charge) and `catalog.call`, `demand.request`, `decide.feedback` are not read-only;
  `memory.write` is also `destructiveHint: true`. `scripts/test-mcp-http.js` derives this from the free-tier table.
  The stdio package keeps its own copy.
- **429:** the transport limiter's refusal carries `Retry-After` (seconds, from `src/rate-limit.js` `retryAfterSeconds`).
- **stdio package on SDK v2:** `mcp/index.js` runs `@modelcontextprotocol/server` (exact pin in `mcp/package.json`,
  in the signing list of `scripts/test-supply-chain-guards.js`) with handlers registered by method name and the
  `/stdio` transport; `mcp/test.js` drives it with the v2 client (an `mcp` devDependency, so a lane that runs the stdio
  server needs `npm --prefix mcp ci`). Errors are a local `McpError` over `ProtocolError` that keeps the
  "MCP error <code>: " prefix. The SDK lifts `io.modelcontextprotocol/*` keys out of `params._meta`, so a handler that
  needs one reads the raw message. A JSON-RPC batch on the hosted transport counts one limiter hit per message.
- **stdio package first run** (`mcp/test-first-run.js`, run by `mcp/test.js`): `AGENT_KEY` is read with or without
  `0x` (`mcp/wallet-key.js`, the same file as `client/wallet-key.js`); unset, the key `npx agent402-mcp setup`
  (`mcp/setup.js`) stored is read from the OS store (`mcp/key-store.js`, `AGENT402_KEY_STORE`; the key always goes on
  stdin, never argv). `AGENT402_MAX_USD_PER_DAY` / `_PER_MONTH` are UTC caps kept in `spend.json` (0600) under
  `AGENT402_CONFIG_DIR` (`mcp/spend-ledger.js`; only confirmed spend is written). A 2xx with
  `X-Agent402-Allowance: first-call` and no `PAYMENT-RESPONSE` is labeled "One-time free call" and not counted (the
  client SDK releases it too). Media answers become files in `AGENT402_OUTPUT_DIR` (`mcp/media-output.js`, names made
  from a fixed alphabet); an image up to `AGENT402_MEDIA_INLINE_MAX_BYTES` (default 1 MB) is also an inline image block,
  so the model loses no sight of it; `AGENT402_MEDIA_INLINE=1` keeps everything inline. A suite that spawns the stdio server sets
  `AGENT402_KEY_STORE=off` and temp `AGENT402_CONFIG_DIR` / `AGENT402_OUTPUT_DIR`, so a developer's stored key is never read.
