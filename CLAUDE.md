# Agent402.Tools: project map for Claude Code

Agent402.Tools is an **open-source, self-hostable x402 + MCP server**: 500+ web tools an AI
agent can call and pay for per request (USDC via x402, MPP, card, or free via
proof-of-work). It also ships `agent402-tollbooth` (pay-per-crawl for site owners) and
`agent402-client` (a buyer SDK). Hosted at https://agent402.tools. Maintained by Havok Holdings
LLC: credit the entity, never a personal name.

> This file is a technical map. Do **not** put conversation content, personal info, secrets,
> costs, margins, vendor rates, wallet balances, third-party seller names or strategy in any
> committed file. Private operational detail lives in `CLAUDE.local.md` (gitignored).

## Repository map
- `src/server.js`: Express app. Builds `CATALOG` (route -> tool def), mounts free routes, the
  payment gates (x402, MPP/Tempo, Stripe, credits), the PoW gate, stats, and every tool route.
- `src/tools/`: the tool kits. Add tools here.
- `src/payments.js`: x402 v2 middleware (multi-chain accepts, facilitator clients, Bazaar
  discovery extension, boot `/supported` guard).
- `src/pow.js`: proof-of-work tier. `WALLET_ONLY_SLUGS` = tools with no free tier.
- `src/mcp-http.js`: hosted MCP connector at `/mcp` (dotted tool names: `catalog.search`,
  `catalog.find`, `catalog.call`, `payment.info`, `server.describe`, `sellers.list`,
  `demand.request`, flagship aliases). Old snake names remain CallTool aliases only.
  `src/mcp-mpp.js` makes wallet-only tools payable on the connector by replaying the call as a
  loopback request to the real paid route; `src/mcp-tasks.js` handles long calls as MCP tasks.
- `src/mpp-shim.js`, `src/mpp-tempo.js`, `src/mpp-stripe.js`, `src/mpp-subscriptions.js`: MPP
  wire support. x402 keeps sole settlement authority on the evm path; the shim only translates.
- `src/credits.js`: prepaid card credits (hold at authorize, debit on a final 200).
- `src/human-checkout.js`, `src/stripe-subscriptions.js`, `src/monitor-scheduler.js`: card
  report products and recurring monitors.
- `src/find.js` (`/api/find`), `src/discovery.js` (`/.well-known/x402`, `/api/reliability`),
  `src/x402-index.js` (crawled seller index), `src/dispatch-eligibility.js` (router labels).
- `src/tools/route-execute.js`: route-and-execute, buys from proven external sellers per chain
  (`src/x402-buyer.js`, `src/solana-buyer.js` whose external leg runs under `SOR_SVM_BUDGET_MS`,
  inside a recent blockhash's life, `src/tempo-buyer.js`, `src/algorand-sellers.js`).
- `src/refund-ledger.js` + `scripts/refund-run.js`: charged-but-failed is recorded as a debt and
  repaid only after on-chain proof (`src/payment-verify.js`).
- `src/state-db.js`: the state database (Postgres, schema `state`): documents, records, log
  lines, leases, imports. `STATE_DATABASE_URL` is the switch (unset: files on the volume as
  before; a merge never cuts over, the variable does). `src/json-document.js`
  is the one API a whole-file JSON store uses (file on the volume without a database, the row with
  one; the file is imported once). Every scheduled loop runs under `leased(name, ...)`, so two
  containers never run the same tick; a store registers its first load with `trackStoreReady` and
  the server awaits `stateStoresReady` before it listens. `/api/gateway-status` reports `stateDb`.
- `src/status.js`, `src/status-store.js`: `/status`, measured from outside production.
- `src/stats.js`, `src/sales-ledger.js`, `src/seo.js`, `src/pages.js`, `src/guides.js`,
  `src/privacy.js`, `src/terms.js`, `src/security-page.js`, `src/company.js`.
- `facilitator/`: self-hosted Stellar facilitator (own lockfile; redeploys only on
  `facilitator/**` changes).
- `scripts/`: tests and ops (canaries, sweeps, corpus, refunds, backups).
- `mcp/` (`agent402-mcp`), `tollbooth/`, `client/`, `adapters/`, `openclaw/`: published packages.
- `workers/`: Cloudflare workers (status probe, relays). `wiki/`: GitHub wiki source (CI-synced).
  `docs/`: ecosystem-listing copy.

## Conventions
- **Every change raises user, developer and agent experience together** (UX, DX, AX) and
  breaks none of them: a page, an API answer and an agent-facing surface (MCP, llms.txt,
  openapi, 402 bodies) are judged as one product.
- **UI work reads `DESIGN.md` first** (tokens, type scale, components, voice); page modules use
  its `var(--token)` and `var(--fs-*)` values, never raw hex or literal sizes
  (`scripts/test-design-tokens.js`).
- A tool is `{ route, name, slug, category, price, description, tags, discovery:{inputSchema,
  input/example}, handler }`. `handler(input)` returns JSON or throws an `Error` with
  `.statusCode`.
- **Honest claims.** Most tools are deterministic code; model-backed ones (the `/v1` LLM tiers,
  report products, media/embedding/answer tools) are marked `modelBacked` and public copy must
  say so. Never write an unscoped "no model in the serving path" or "every tool is
  deterministic"; `scripts/test-copy-absolutes.js` enforces this.
- Every tool must answer its own published example (`scripts/test-all.js`), and an example that
  returns empty arrays where the docs show data is a failure.
- The free (PoW) tier is an allowlist: a tool is PoW-eligible only when `src/free-tier.js` lists
  it and `WALLET_ONLY_SLUGS` (`src/pow.js`) does not override it, so a new tool is wallet-only by
  default. Add a slug there only for pure-CPU tools (no egress, key or model). Free-tier egress is
  a tested invariant (`scripts/test-free-tier-egress.js`), and so is a bounded run on long
  adversarial strings: `scripts/test-redos-free-tier.js` sends every free tool's and skill's
  string fields a hostile corpus while it times the event loop.
- **Identity-bound routes** (memory, my-usage, attest, feedback) are keyed on the signed
  EIP-3009 `authorization.from` (`src/payer.js`); they are EVM-exact only and refused on
  Tempo/credits gates. Never weaken payer attribution. Never case-fold base58/Stellar addresses.
- Catalog floor: 400 entries, CI-checked by `node scripts/sync-count.js --check`. Marketing and
  static surfaces say **"500+ tools"**, never an exact number; runtime surfaces derive exact counts.
- Retired routes answer 410 with a replacement: add every retirement to `src/retired-tools.js`.
  `scripts/published-slugs.json` records every route ever published; after adding a tool or
  pack run `node scripts/published-slugs.js --write` (`test-retired-routes.js` fails otherwise,
  and fails when a published route is neither live, key-gated nor retired).
- **Upstream costs are private.** Model, speech, embedding, media and STT rates, vendor cards
  (Exa, X) and fixed fees live in `src/upstream-costs.js`'s table, loaded
  from `UPSTREAM_COSTS_JSON` (Railway; Actions secret) or `UPSTREAM_COSTS_FILE`, as does the
  meter markup (a buyer can derive it from any metered 402, so it is not a secret; it is kept
  in the table and never printed). Never commit a
  rate, never print one in a CI log, never type one in a test (`scripts/test-upstream-costs.js`
  scans the shipped trees and scripts). Blank the secret in every step that installs packages
  (`scripts/test-ci-secretless-install.js`). A drifted rate is a table edit, not a code change.
  A new key a serving path or a margin test reads goes in `REQUIRED` there, so a table
  without it reads `partial` on `/api/gateway-status` and the heartbeat pages; add it to
  `docs/example-upstream-costs.json` (placeholder numbers only) in the same change.
- Sitemap `lastmod` is per URL from `src/page-dates.js` (module commit dates, kit dates for
  tools, the printed date for legal pages, a report's own date; otherwise omitted), read from
  the committed `src/generated/page-dates.json`: after editing a page module or a tool kit run
  `node scripts/gen-page-dates.js --write` (`scripts/test-page-dates.js` fails when it is stale).
- Prices quoted in prose are derived from the catalog, never typed
  (`scripts/test-price-prose.js`); the "most tools" per-call band is `TYPICAL_PRICE_RANGE`
  (`src/typical-price-range.js`), and a markdown surface that quotes it must match its `text`.
  Skill-pack prices are generated (`node scripts/pack-prices.js --write`).
- A list answer that is a page or a capped sample says so in fields (`src/partial-answer.js`),
  not only in a prose note.
- Before adding a data source, read its terms.
- Tests use port 0 (or a port below 32768) and read the bound port back
  (`scripts/test-port-hygiene.js`).
- Public copy: first-party and affirmative, no competitor names, no em dashes, US spelling
  (`scripts/test-us-spelling.js` reads the markdown trees, the page modules and every tool
  description; a quoted token or an object key is a contract value and is not read).
- Copy that offers something reads the switch that sells it (`creditsSalesEnabled()`), and is
  guarded by test-static-pages, test-legal-dates, test-wire-count-copy, test-pack-copy-retired
  and copy-absolutes. No third-party seller or counterparty name in any tracked file
  (`scripts/test-no-third-party-names.js`, also run by `.githooks/pre-push`). No hidden
  character (TAG text, zero-width, bidi, variation-selector carrier, soft hyphen) in an
  instruction file: `scripts/test-hidden-chars.js` scans CLAUDE.md, `.claude/`, `wiki/`, `docs/`,
  the package READMEs, the adapter READMEs, `src/mcp-http.js`, `src/mcp-flagship.js`,
  `src/server.js` and `mcp/index.js`; the same scan (`src/hidden-chars.js`) is a listing finding
  in the index's injection screen.

## Key machine-readable surfaces (free)
`/health`, `/api/pricing`, `/openapi.json`, `/llms.txt`, `/.well-known/x402`,
`/api/reliability`, `/api/find?q=<task>`, `/api/route`, `/api/index`, `/api/stats`,
`/api/status`, `/api/gateway-status` (bucketed status words only, never numbers), `/robots.txt`,
`/sitemap.xml`, `/.well-known/glama.json`, `/x402-test` (payment-refusal diagnostics).
Operator-only surfaces live under `/__operator/*` (token-authed); the operator view of a public
surface reads `X-Operator-Token` only, since `Authorization` there is a buyer's credential.
Such a route calls `operatorView(req, res)` (server.js): every answer varies on the header, and an
elevated one is `private, no-store`, so a shared cache never keeps it.

## Dev / CI / deploy workflow
- **Develop on branch `claude/sweet-brown-i99jl3`.** `main` is protected: PR required, never
  force-push `main`, never delete the dev branch. The dev branch is never force-pushed by hand;
  the one exception is `scripts/sync-dev-branch.sh` (run by `merge-on-green.sh` after every
  merge), which moves it to main's head only when no PR is open from it and merging it would
  change nothing on main.
- CI is `.github/workflows/deploy.yml`, triggered by pushes to the dev branch or `main`. Every
  dev push runs all test lanes. Jobs are gated by commit-message markers: `[test]` (tests),
  `[deploy]` (Railway), `[publish]` (npm + MCP Registry), plus `[probe]`, `[paytest]`,
  `[drain]`, `[purl]`. `[deploy]` and `[publish]` run only from `main` (environment branch policy).
- **Put the marker in a COMMIT SUBJECT on the branch, not the PR title.** The markers job
  parses subject lines only, and `merge-on-green.sh` merges with `--merge`, which puts the PR
  title in the merge commit's body.
- **A push to `main` tests and deploys unconditionally**; merging is shipping.
- **Flow:** commit to the dev branch with `[test]` only (never `[deploy]` on dev), push, open a
  draft PR, let CI run, merge with `scripts/merge-on-green.sh <pr>` (push-event run, every
  required check green, pinned to the tested SHA).
- A merge to `main` is not a package release: check `npm view <pkg> version` against the local
  `package.json`.
- `heartbeat.yml` probes prod on a schedule and opens issues for outages and low balances; a
  daily paid canary (`scripts/paid-canary.js`) buys across every rail. No open issues = healthy.
- `model-drift.yml` runs the live-catalog guard (`scripts/test-gateway-model-ids.js`) every 6 hours,
  never on a push, and keeps one issue open while it fails (a cost row under its dearest live
  endpoint, or more than 15% above it for every servable model the row owns); its output is
  redacted before log or issue (`scripts/test-model-drift-redaction.js`).
- Other workflows gate on their own `.github/trigger-*` path filters, independent of deploy.yml.

## Splitting work across agents
- Fan out only where steps are independent: a step that does not read another step's output
  runs beside it. Two steps that write the same file, store or wallet are not independent.
- Give each parallel agent its own worktree and branch, and merge the branches into the batch
  in one place; never let two agents edit one checkout.
- Reduce in code where possible (counts, diffs, exit codes) and keep what returns to the
  parent short, so the merge step never has to hold every agent's full output.
- Verify with fresh context: before a batch PR, a reviewer that did not write the change reads
  the full diff against `main` and runs the suites the change touches. The author's own
  passing run is not that review.
- Anchor every claim of done on something outside the agent: a test exit code, a CI run, a
  live read of production.

## Testing (run locally)
- Free-mode boot: `FREE_MODE=true PORT=3000 node src/server.js`, then
  `TARGET_URL=http://localhost:3000 node scripts/test-all.js` and `scripts/test-mcp-all.js`.
  If another app holds :3000, boot on a free port and export `TARGET_URL`.
- CI runs parallel lanes; `scripts/test-ci-gating.js` derives them and requires each to gate
  deploy/publish. Browser page checks and both catalog sweeps live in the sweeps lane.
- Paid-mode tests boot their own server: `scripts/test-idempotency.js`, `client/test.js`,
  `scripts/test-mpp-shim.js` (run MPP paid-path suites alone; they share a local stats DB).
- Metered slugs (LLM tiers, search, report products) are excluded from the catalog sweeps
  (`METERED_SLUGS` in `scripts/test-non-metered-examples.js`) because CI holds no third-party
  keys and must never spend upstream. Their inputs are covered by `scripts/test-report-probes.js`;
  the synthesis half is driven by hand with `scripts/audit-metered.mjs` (not in CI).
- Correctness corpus: `scripts/test-corpus.js` (second inputs per tool, asserting values).
- Unit/offline: `scripts/test-memory.js`, `test-find.js`, `test-discovery.js`,
  `tollbooth/test.js` + `edge.test.js` + `features.test.js`, and the many `scripts/test-*.js`.
- Raise the MCP free-tier limit for sweeps:
  `AGENT402_MCP_MAX_PER_MIN=999999 AGENT402_MCP_MAX_PER_HOUR=9999999`.
- Independent MCP client: `scripts/mcp-client-check.js` reads `/mcp` with the reference SDK
  client (a handful of free calls, no wallet); `scripts/test-mcp-client-check.js` runs it against
  a port-0 boot and a drifted stub, and `mcp-clients.yml` runs it against production every 6
  hours (`MCP_CHECK_TARGET=prod`), paging one issue.
- A skipped integration test is not coverage: under `CI`, a missing dependency must fail.

## x402 settlement ordering (CRITICAL)
The installed `@x402/express` **runs the handler FIRST, then settles**, and only settles a
`<400` response. For any handler `statusCode >= 400` it cancels settlement, so the buyer is
**not charged**; if settlement of a `<400` response fails, it discards the buffered body and
returns a 402. So a 4xx/5xx is never charged, and a 200 is charged only if settlement then
succeeds. We never declare the opt-in upfront payment flow. Anything that caches, credits or
bills on handler status before settlement is unsafe: key it off the FINAL response
(`res.on("finish")` with `res.statusCode === 200`). The idempotency cache, credits debit and
refund ledger all follow this rule. (`node_modules/@x402/express/dist/esm/index.mjs`.)
A buyer whose connection closes before the first response byte is not settled while the
run holds a hang-up forgiveness ticket (`src/hangup-forgiveness.js`: reserved when the
handler starts, priced at the charge, against a per-wallet, per-IP and service-wide budget
that a paid success never resets): an onBeforeSettle hook aborts with
`client_disconnected`, the Tempo broadcast and the Stripe capture make the same check first,
and credits release the hold. Without a ticket, for a Tempo push credential (finalized
before the handler) and for a close during the settle call itself, the charge goes through
and `src/hangup-settlement.js` books it as owed. The budget never refuses service. A route
whose effect outlives the answer never takes a ticket (`hasLastingEffect`: the memory writers,
`attest`, `feedback`, the route-execute tiers, `seller-payability`); add a new one there.
A payer's first hang-up in the window is forgiven at any price under the service-wide budget
when its payer and IP keys hold nothing in flight or abandoned; later ones meet the per-key
budget. Refunds stay human-run (`refund.yml`, dry run first); any buyer's owed row reads
`refundsOwed=owed` on `/api/gateway-status` past a short grace (a card report refund that could
not be sent, `owedRefunds` in `src/human-checkout.js`, folds into the same word), and the status Worker and
heartbeat page on it under one issue that closes when nothing is owed.

## Subsystem pointers
- **Async jobs:** `Prefer: respond-async` on a paid slow route (`runSeconds`, from `EVM_RUN_SECONDS`) answers 202 and a job link (`src/async-jobs.js`, mounted before every payment gate); the call is replayed over 127.0.0.1 with the buyer's payment and settles only on a final 200; `GET /api/jobs/:id` serves it. Jobs report progress: `status` keeps working/completed/failed, `state` is queued/running/succeeded/failed with `stage`, `progress`, `etaSeconds` and `Retry-After` (`src/job-progress.js`); which routes are slow, and what the 402, /api/pricing, /openapi.json and /llms-full.txt say about them, comes from `src/slow-routes.js`.
  A Tempo push credential's transfer is final before the call, so neither sync window refuses it directly: `src/slow-sync-window.js` and `src/cdn-sync-window.js` park the refusal on the request with `deferSyncWindowRefusal` and the Tempo gate answers it from `syncWindowRefusalOf(req)` in its push input check (the transfer booked as owed until the same credential returns with the header); server.js defers only while `tempoGateMounted` is true, set right after the gate mounts, so with no gate the windows refuse as for any other payment. That deferred answer applies to a slow route that offers Tempo, of which the current catalog has none: every slow route is long-running (`isLongRunningSlug`), so `tempoOfferedFor` is false there and the gate's binding check refuses the push credential first (`routeRefusal`: long-running, identity-bound, priced above the challenge, free), asks the relay whether the transfer pays the challenge and books a confirmed one as owed the same way; `scripts/test-tempo-push-debts.js` pins that no slow route offers Tempo, so a change that adds one is noticed and covers the deferred path there.
  Through the CDN proxy (`req.viaCdn`), a paid call without the header to a route whose run budget is past `CDN_SYNC_MAX_SECONDS` (default 90) runs as a job only for a client that follows a 202 on its own (agent402-client 0.8.16+) and is otherwise refused with a 504 before any gate, while LLM attempts, image fallback links and route-execute's seller waits are bounded by `cdnSyncLeftMs(req)` (`src/cdn-sync-window.js`).
- **Client address:** `src/cdn-client-ip.js` redefines `req.ip` right after `trust proxy`: CF-Connecting-IP is the client only when the edge-reported peer is inside the embedded CDN ranges (plus `CF_IP_RANGES_EXTRA`) and the header parses as an address; from any other peer it is ignored. `CDN_PROXY` (`cloudflare` or `on`, default off) turns the resolver and the CDN sync window on, and while on a peer's CF-Connecting-IP counts (and the request is `req.viaCdn`) only when it also carries `CDN_ORIGIN_SECRET` in `X-Origin-Auth` (constant-time compare, stripped before handlers), so off or without the secret `req.ip` is the trust-proxy address. Read the client address only through `req.ip`.
  `cdnOrigin` on `/api/gateway-status` reads `unauthenticated` while a CDN-range peer reached the origin without the secret inside the window.
- **Idempotency:** opt-in `Idempotency-Key` (and x402 `payment-identifier` as an alias), bound
  to credential + route + query + body, committed only after a settled 200. With no explicit key, an
  x402 EVM payment's identity (network, signed payer, nonce; `paymentNonceIdentityOf`) is the
  implicit key, so a re-sent signed payment is served from its first answer (`X-Replayed-Answer: 1`,
  no handler, no settle, no sale), except on a `hasLastingEffect` route, an identity-bound route
  (a settled header can be rebuilt from chain data) or a streamed call; the store
  (`src/idempotency-store.js`) is Redis-shared across replicas. Replays are counted per slug on
  `/__operator/tool-failures.json`.
- **LLM gateway:** `src/tools/llm-gateway-kit.js` (OpenAI chat wire), `llm-messages-kit.js`
  (Anthropic Messages), `llm-responses-kit.js` (OpenAI Responses); flat tiers plus a metered
  tier whose 402 is a per-request quote. `handlerInputOf(req)` (`src/handler-input.js`) is the
  one input object for pricing and serving; a body nested past `MAX_INPUT_DEPTH` (64) is refused
  there with a 400 before any handler walks it. Streams commit 200 only on the first `data:` frame.
  `GATEWAY_METERED_BILLING=on` gates metered settlement, the buffered override and a credits
  stream's debit on finish alike (`recordStreamedUsage`, `meteredUsdOf` in `src/gateway-meter.js`).
- **Settle-failure breakers:** `src/gateway-settle-breaker.js` (per wallet and global on `/v1`,
  per wallet on other wallet-only tools). A wallet is refused only when it holds
  `GATEWAY_SETTLE_BREAKER_MAX` failures in the window AND they are more than
  `GATEWAY_SETTLE_BREAKER_MIN_FAIL_SHARE` (default 0.5) of its outcomes there; settled calls
  stay in the window as outcomes and never erase failures, so a buyer settling hundreds of
  calls is not cut off by a few replayed authorizations, whatever order the fast reverts and
  slower settlements land in; `GATEWAY_SETTLE_BREAKER_HARD_MAX` (default 40) failures refuse
  a wallet whatever it settled, the bound on unpaid handler runs. The `/v1` global pause counts distinct buyers, not
  failures. Only a refusal whose offer the next 402 withdraws (`isWithdrawnSubcentRefusal`)
  stays off the buyer's count, and it still feeds the `/v1` global pause, each one counted on
  its own; every other facilitator billing refusal (`src/payment-reject.js`) counts in both
  breakers and the composite guard, with a 429 that names it instead of the wallet.
  The composite guard (`src/composite-spend-guard.js`) reads its window the same way: a settled
  run stays as an outcome and never erases failures; a payer is blocked at
  `COMPOSITE_GUARD_MAX_FAILS` only while failures are more than `COMPOSITE_GUARD_MIN_FAIL_SHARE`
  (default 0.5) of its outcomes, and at `COMPOSITE_GUARD_HARD_MAX` (default 10) whatever it settled.
- **Replay guard:** `src/replay-guard.js` claims a payment credential (x402 nonce, Tempo, Stripe)
  in Redis while its call runs; the claim is renewed every 30 s until settle or release, so a
  route that outlives the claim's expiry cannot run twice on one payment. With Redis configured
  but unreachable, a long-running or composite route (`isLongRunningSlug`) is refused 503 with
  `Retry-After` before any payment is taken (x402 dispatcher and card gate); fast routes fall back
  to a per-process claim.
- **Per-chain price floors:** `src/network-floors.js`. Every accept is priced through
  `priceForNetwork` (`src/payments.js`: list or per-request quote, plus the chain's
  `NETWORK_PRICE_PREMIUMS` premium, raised to its floor). eip155:4663 has a static floor
  (`ROBINHOOD_MIN_PRICE_USD`, "0" off; `NETWORK_PRICE_FLOORS` for others) because its settlement
  can run through our own relayer; it is static so the paid retry re-derives the same amount.
  A floored network, or one with a premium above zero, is never offered `upto` (the boot gate refuses it). /api/pricing (`minPriceUsdByNetwork`), llms-full.txt,
  the chain page and the guides read the same floor; `payment.premiumUsdByNetwork` there publishes
  each chain's premium, and llms.txt, openapi and MCP `payment.info` read the same map. Sales, hang-up debts and charged-failure
  debts on an x402 settle book what the buyer paid on that chain (`src/paid-price.js`: the
  amount signed on an EVM rail, else the gated price through `priceForNetwork`), so revenue
  reads the premium and the floor and a refund repays what was paid.
- **Algorand sub-cent offer gate:** `src/avm-sponsorship.js` drops the Algorand accept from
  sub-cent 402s while the facilitator cannot sponsor sub-cent settlement (fails open;
  a status row last updated in an earlier UTC month, or with an unreadable `updatedTs`, is
  not evidence; a pause a settle refusal set holds against headroom reads for
  `AVM_SPONSORSHIP_REFUSAL_HOLD_MS`; published on `/api/rails`, the only excuse the canaries
  accept for a missing sub-cent accept; `AVM_SUBCENT_GATE=off`).
- **External spend guard:** `src/external-spend-guard.js` (per payer and per chain wallet).
- **Router evidence:** `src/evidence-binding.js` keeps settlement evidence per wallet;
  `src/seller-funding.js` nets payments made with USDC the paid wallet itself sent the payer
  (each payer's history read once when it first pays, then incremental; state on `/data`);
  `src/shared-paytos.js` lists shared settlement contracts. `src/router-purchases.js` records
  the router's own buys per origin, payTo and chain for 30 days (`SOR_ROUTER_PURCHASES_FILE`),
  and the evidence rule deducts them from an origin's Bazaar counts: a router buy never proves a seller.
  The funding reader can be switched off (`LEADERBOARD_FUNDING_SCAN=off`); off, the router reads
  gross per-wallet evidence with no netting and no verdict.
- **Report products:** kits under `src/tools/*-report-kit.js`, `src/report-tiers.js`,
  house style in `src/house-style.js`, samples in `src/sample-reports.js`. Every kit that serves
  model prose passes it through `sanitizeReportProse` (`src/report-grounding.js`: a link stays a
  link only to a listed source's host; images and raw HTML are removed) and wraps fetched text in
  `quotedMaterial`; `scripts/test-report-prose-filter.js` runs each kit.
- **Facilitators:** boot guard in `src/payments.js` and `src/x402-boot-init.js`; diagnostics in
  `src/facilitator-diagnostics.js`; Stellar confirm in `src/stellar-confirm.js`; Tempo
  chain-truth confirm in `src/tempo-confirm.js`. Arc (`eip155:5042`) settles through Circle's
  facilitator only (`src/circle-facilitator.js`): `CIRCLE_FACILITATOR_API_KEY` is the switch,
  the client is Arc-only, reduces every upstream error to a status and a reason code, and Arc
  fails closed on Circle's own `/supported` (`scripts/test-arc-rail.js`).
  `ROBINHOOD_FACILITATOR_URL` is an ordered list: the first settles, the rest are Robinhood's
  settle fallback (never routing facilitators), reached after a pre-broadcast refusal or, on
  `eip155:4663` only, a reverted `transferWithAuthorization` (`isRetryableSettleRefusal`).
  `src/facilitator-gas.js` reads each listed facilitator's settlement signers (from
  `/supported`) for gas runway every 10 minutes under a lease (`scripts/test-settle-fallback.js`,
  `scripts/test-tool-failure-monitor.js`). `ROBINHOOD_RELAYER_KEY` (key present = on) adds our own
  settler after the listed ones (`src/robinhood-relayer.js`): our 4663 sales only (token, call and
  treasury fixed), the package's exact EVM facilitator verify and settle, one submission per
  relayer key across replicas under a lease with the nonce read under it, fee and gas caps, a
  balance check before signing, and a hash for any send that may have reached the node so a
  missing receipt stops the chain; its signer joins the gas check (`scripts/test-own-relayer.js`).
  With it, an ambiguous listed-facilitator failure on 4663 (5xx, timeout, no verdict, no
  transaction) is read on chain (`src/robinhood-outage.js`): the authorization used with our
  transfer is served (claimed first), still unused after `ROBINHOOD_AMBIGUOUS_WAIT_MS` (the wait
  ends inside the authorization's settle deadline and the CDN answer window) goes to our relayer,
  which is skipped when the buyer left forgiven, the deadline leaves it no time, or a CDN
  window is shorter than its lock wait plus receipt wait. A read failure (an unreadable receipt
  included) is a 402 with the authorization booked in the late-settlement book, which never
  closes a used authorization as not landed (`scripts/test-rh-outage.js`).
- **Heap attribution:** `HEAP_SAMPLING=on` (exactly "on"; off by default) starts V8's sampling heap
  profiler at the first import (`src/boot-profile.js`); `/__operator/heap-sampling.json` reports
  live sampled bytes by function and file. A read holds the loop about a second on a large heap
  (concurrent reads share one walk); turn it on for a measurement, then off.
- **Deploy selectors:** the render worker and `decide` redeploy from CI only when the pushed range
  touches their paths (`scripts/worker-deploy-paths.js`, `scripts/decide-deploy-paths.js`: image
  inputs, import closure, and for decide its export row format and kit); an unreadable or capped
  diff, or a check that fails, redeploys.
- **Drain:** in-flight composites are aborted on SIGTERM (`src/drain-abort.js`); drain starts
  immediately (`scripts/test-drain-on-sigterm.js`).
- **Backups:** `src/backup.js` (encrypted, offsite); restore with `scripts/backup-restore.js`.
  The `backup` word reads `unencrypted` while `BACKUP_ENCRYPTION_KEY` is unset in production
  (`NODE_ENV` or the platform's environment name); the heartbeat and the status probe page on it.
- **Status observers:** GitHub heartbeat plus `workers/status-probe`; a failed check is
  re-probed once before it is recorded.
- **Router worker:** `src/router-pool.js` scores route queries in a worker thread
  (`src/router-worker-thread.js` imports `x402-index.js` and holds a replica of the stores a
  query reads, fed by the index's replica observer); `routeQueryAsync` stays the entry point and
  runs in-thread when no worker is loaded. `ROUTER_WORKERS` (default 1; 0 with the crawler off),
  `ROUTER_QUERY_DEADLINE_MS` (default 10000). Status on `/__operator/perf.json`.
  The index cache (`IndexCache` in `x402-index.js`) interns short strings (64 characters or
  fewer) in every entry it stores, so a value repeated across sellers' tools is held once;
  `INDEX_INTERN_STRINGS=off` stores entries untouched (`scripts/test-index-intern-strings.js`).
- **Failure monitor:** `src/tool-failure-monitor.js` counts every catalog answer past the gates by slug, class, origin (outside vs our own synthetic traffic) and payment rail (`outcomeRailOf` in `src/payment-rail.js`; a free proof-of-work or trial outcome counts on its own lane, shown in the detail and read by `toolFailures` only when a tool fails nearly every free call: `TOOL_FREE_FAIL_RATE`, default 0.9, over `TOOL_FREE_FAIL_MIN_CALLS`, default 20, in an hour) and every named upstream's fetch outcomes through the egress meter's observer, in five-minute buckets merged across replicas through Redis; `toolFailures`, `upstreamHealth` and `facilitatorFunds` (also `low` while a facilitator signer is short of gas) are words on `/api/gateway-status`, detail on `/__operator/tool-failures.json`. Every final 200 is also classified by body (`src/answer-shape.js`: ok, empty, error-shaped, unchecked; a tool whose contract allows an empty answer goes in `EMPTY_RESULT_OK` or sets `discovery.emptyOk`) into the `toolAnswers` word; the same detail lists live-data slugs whose sales all returned one response digest. `src/settle-demotion.js` puts Celo's alternates first after consecutive out-of-funds refusals.
- **Sale paths and cohorts:** each sale records how it arrived (`src/sale-path.js`: the
  connector's loopback, a client package by its User-Agent product token, or HTTP) in the
  ledger's `via` column; `/__operator/cohorts.json` lists wallets past a per-day distinct-tool
  (`COHORT_TOOLS_PER_DAY`) or per-hour call (`COHORT_CALLS_PER_HOUR`, default 300) threshold.
- **Live view:** `services/live` deploys from this repository with every merge. The page reads
  one event stream and, with nothing on it after 8 s (a proxy holding it), polls `/api/poll`
  for the same numbered batches (`LIVE_POLL_KEEP_BATCHES`, default 300; a whole-hour answer at
  most `LIVE_POLL_HELLO_PER_MIN`, default 30, times a minute per address). Tests:
  `services/live/test.js`, `test-guard.js`.
- **Large bodies:** `src/large-body-gate.js` sits before the parsers of the routes that take more
  than the global 100 KB body: it refuses a Content-Encoding (415), answers an unpaid oversized
  body whose price does not read it without reading it, rate-limits the unpaid ones that are
  parsed, and reserves each parse against one in-flight budget (`LARGE_BODY_INFLIGHT_MAX_MB`,
  default 256; 503 with Retry-After when spent), of which one client address holds at most a
  quarter (never less than two of the largest route's bodies). A slow body is bounded by the
  server's `HTTP_REQUEST_TIMEOUT_MS`.
- **Media and documents:** the OCR language data is baked into the image at build
  (`scripts/fetch-tessdata.js`, pinned and hash-checked; `OCR_TESSDATA_DIR` overrides the
  directory), so `image-ocr` never fetches a model at request time; an engine that does not
  start within `OCR_INIT_TIMEOUT_MS` (default 30000) answers 503. PDF transforms
  (`src/tools/pdf-ops.js`) run in a fresh worker thread per call (`pdf-offthread.js`,
  `pdf-worker.js`) with a heap limit, a decoded-stream cap and a deadline that terminates it
  (422). ffmpeg, ffprobe and Chromium start with `childEnv()` (`src/tools/child-env.js`), an
  allowlist of environment variables, so no key reaches a child process.
- **Listing screen:** `src/listing-screen.js` (re-exported by `src/x402-index.js`) flags seller
  listing text that tries to instruct its reader; it depends only on `src/hidden-chars.js`, so
  a workflow with no install (`wish-issues.yml`) reads the same rules.
- **Unpaid quote budget:** `src/unpaid-quote-budget.js` bounds bursts of unpaid 402 reads. A
  payment header counts as an attempt (`src/payment-attempt.js`) only when it decodes to an offered
  network or an MPP credential; bytes that do not decode are an unpaid read.
- **Robots:** `src/seo.js`; the private disallow list is repeated in every named-crawler group.
- **Challenge size:** `scripts/test-challenge-size.js` keeps the 402 header under what a buyer
  can echo back; `scripts/test-bazaar-contracts.js` validates every 402 against the protocol's
  own schema.
- **402 body mirror:** `src/payment-required-body.js` copies the decoded PAYMENT-REQUIRED object
  into the JSON body of every paywall 402 (header authoritative, header keys win, our fields
  kept); a refusal that explains itself (a `hint`, or a problem's `detail`) gets the offer and
  no `error`, so `error`-first clients read the explanation. Keyed on the header, so
  settle-failure, credits and Tempo/Stripe direct 402s are untouched. It wraps `res.send`, so it
  is mounted before the MPP shim and the Tempo/Stripe gates.
- **Tempo push refusals:** `src/push-refusal-body.js`: for a push credential the Tempo gate
  restates a 4xx JSON body's not-charged sentence and sets `charged`, `transferClaimed`, `refundOwed`.
- **Algorand network id:** `src/avm-network.js`: the CAIP-2 (32-character) id is what every 402
  carries; the genesis-hash spelling is folded on the paid path (`src/x402-v1-accepts.js`) and read
  as an alias in seller rows and the buyer.
- **X posting:** `announce.yml` / `scripts/tweet.js` (workflow dispatch only) and
  `src/tweet-queue.js`; both sign through `src/x-oauth.js`. Tweet copy is never committed.

## Environment
Configuration and secrets are set on Railway (and, where a workflow needs them, as GitHub
Actions secrets), never in the repo. Rollout switches are generally "key present = feature on"
(for example `MPP_SECRET_KEY`, `TEMPO_API_KEY`, `STRIPE_SECRET_KEY`, `OPENROUTER_API_KEY`,
`X_BEARER_TOKEN`). Per-variable notes and thresholds live in `CLAUDE.local.md`. The backup
bucket credentials (`BACKUP_S3_*`) live on Railway only, shown by `railway bucket credentials` and pasted by the operator
into the service variables, never in Actions: the deploy job's variable upsert must not name a
variable whose source of truth is Railway (`scripts/test-ci-secretless-install.js`).
