# Agent402.Tools: project map for Claude Code

Agent402.Tools is an **open-source, self-hostable x402 + MCP server**: 500+ web tools an AI
agent can call and pay for per request (USDC via x402, MPP, prepaid card credits, or free via
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
  (`src/x402-buyer.js`, `src/solana-buyer.js`, `src/tempo-buyer.js`, `src/algorand-sellers.js`).
- `src/refund-ledger.js` + `scripts/refund-run.js`: charged-but-failed is recorded as a debt and
  repaid only after on-chain proof (`src/payment-verify.js`).
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
- A tool is `{ route, name, slug, category, price, description, tags, discovery:{inputSchema,
  input/example}, handler }`. `handler(input)` returns JSON or throws an `Error` with
  `.statusCode`.
- **Honest claims.** Most tools are deterministic code; model-backed ones (the `/v1` LLM tiers,
  report products, media/embedding/answer tools) are marked `modelBacked` and public copy must
  say so. Never write an unscoped "no model in the serving path" or "every tool is
  deterministic"; `scripts/test-copy-absolutes.js` enforces this.
- Every tool must answer its own published example (`scripts/test-all.js`), and an example that
  returns empty arrays where the docs show data is a failure.
- Pure-CPU tools are PoW-eligible unless listed in `WALLET_ONLY_SLUGS`. Free-tier egress is a
  tested invariant (`scripts/test-free-tier-egress.js`).
- **Identity-bound routes** (memory, my-usage, attest, feedback) are keyed on the signed
  EIP-3009 `authorization.from` (`src/payer.js`); they are EVM-exact only and refused on
  Tempo/credits gates. Never weaken payer attribution. Never case-fold base58/Stellar addresses.
- Catalog floor: 400 entries, CI-checked by `node scripts/sync-count.js --check`. Marketing and
  static surfaces say **"500+ tools"**, never an exact number; runtime surfaces derive exact counts.
- Retired routes answer 410 with a replacement: add every retirement to `src/retired-tools.js`.
  `scripts/published-slugs.json` records every route ever published; after adding a tool or
  pack run `node scripts/published-slugs.js --write` (`test-retired-routes.js` fails otherwise,
  and fails when a published route is neither live, key-gated nor retired).
- Prices quoted in prose are derived from the catalog, never typed
  (`scripts/test-price-prose.js`). Skill-pack prices are generated
  (`node scripts/pack-prices.js --write`).
- A list answer that is a page or a capped sample says so in fields (`src/partial-answer.js`),
  not only in a prose note.
- Before adding a data source, read its terms.
- Tests use port 0 (or a port below 32768) and read the bound port back
  (`scripts/test-port-hygiene.js`).
- Public copy: first-party and affirmative, no competitor names, no em dashes.

## Key machine-readable surfaces (free)
`/health`, `/api/pricing`, `/openapi.json`, `/llms.txt`, `/.well-known/x402`,
`/api/reliability`, `/api/find?q=<task>`, `/api/route`, `/api/index`, `/api/stats`,
`/api/status`, `/api/gateway-status` (bucketed status words only, never numbers), `/robots.txt`,
`/sitemap.xml`, `/.well-known/glama.json`, `/x402-test` (payment-refusal diagnostics).
Operator-only surfaces live under `/__operator/*` (token-authed).

## Dev / CI / deploy workflow
- **Develop on branch `claude/sweet-brown-i99jl3`.** `main` is protected: PR required, never
  force-push `main`, never delete the dev branch.
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
  required check green, pinned to the tested SHA). Strip session-link footers from PR bodies.
- **Batch the merges:** one PR per batch of related changes. Every merge deploys and each deploy
  is a short no-container window (the service is volume-backed). Urgent production fixes ship
  alone.
- A merge to `main` is not a package release: check `npm view <pkg> version` against the local
  `package.json`.
- Railway: any variable write or service-setting change redeploys `main`'s head. Change settings
  right after a merge lands, never during a CI run, and re-read `/health` `build` afterwards.
  The deploy job runs `scripts/deploy-quiet-gate.js` before its variable upsert.
- `heartbeat.yml` probes prod on a schedule and opens issues for outages and low balances; a
  daily paid canary (`scripts/paid-canary.js`) buys across every rail. No open issues = healthy.
- Other workflows gate on their own `.github/trigger-*` path filters, independent of deploy.yml.

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

## Subsystem pointers
- **Idempotency:** opt-in `Idempotency-Key` (and x402 `payment-identifier` as an alias), bound
  to credential + route + body, committed only after a settled 200.
- **LLM gateway:** `src/tools/llm-gateway-kit.js` (OpenAI chat wire), `llm-messages-kit.js`
  (Anthropic Messages), `llm-responses-kit.js` (OpenAI Responses); flat tiers plus a metered
  tier whose 402 is a per-request quote. `handlerInputOf(req)` (`src/handler-input.js`) is the
  one input object for pricing and serving. Streams commit 200 only on the first `data:` frame.
- **Settle-failure breakers:** `src/gateway-settle-breaker.js` (per wallet and global on `/v1`,
  per wallet on other wallet-only tools). The `/v1` global pause counts distinct buyers, not
  failures. Only a refusal whose offer the next 402 withdraws (`isWithdrawnSubcentRefusal`)
  stays off the buyer's count, and it still feeds the `/v1` global pause, each one counted on
  its own; every other facilitator billing refusal (`src/payment-reject.js`) counts in both
  breakers and the composite guard, with a 429 that names it instead of the wallet.
- **Algorand sub-cent offer gate:** `src/avm-sponsorship.js` drops the Algorand accept from
  sub-cent 402s while the facilitator's sponsored sub-cent allowance is spent (fails open;
  a status row last updated in an earlier UTC month, or with an unreadable `updatedTs`, is
  not evidence; a pause a settle refusal set holds against headroom reads for
  `AVM_SPONSORSHIP_REFUSAL_HOLD_MS`; published on `/api/rails`, the only excuse the canaries
  accept for a missing sub-cent accept; `AVM_SUBCENT_GATE=off`).
- **External spend guard:** `src/external-spend-guard.js` (per payer and per chain wallet).
- **Router evidence:** `src/evidence-binding.js` keeps settlement evidence per wallet;
  `src/seller-funding.js` nets payments made with USDC the paid wallet itself sent the payer
  (each payer's history read once when it first pays, then incremental; state on `/data`);
  `src/shared-paytos.js` lists shared settlement contracts.
  Operator levers: `/__operator/shared-paytos`, `/__operator/seller-funding`. The funding
  reader's switch is `LEADERBOARD_FUNDING_SCAN=off` or `POST /__operator/seller-funding
  {"action":"disable"}` (runtime, persisted); off, the router reads gross per-wallet evidence
  with no netting and no verdict. Each wallet's history reads get a bounded share, kept with
  their progress across scans; retries past a wallet's planned reads are capped per rolling
  day (`LEADERBOARD_FUNDING_DAY_MAX_CALLS`), first reads are not. A wallet whose reads cannot
  finish waits (see `src/seller-funding.js`). The scan's counts and log line name why a wallet
  was not read.
- **Report products:** kits under `src/tools/*-report-kit.js`, `src/report-tiers.js`,
  house style in `src/house-style.js`, samples in `src/sample-reports.js`.
- **Facilitators:** boot guard in `src/payments.js` and `src/x402-boot-init.js`; diagnostics in
  `src/facilitator-diagnostics.js`; Stellar confirm in `src/stellar-confirm.js`; Tempo
  chain-truth confirm in `src/tempo-confirm.js`.
- **Drain:** in-flight composites are aborted on SIGTERM (`src/drain-abort.js`); drain starts
  immediately (`scripts/test-drain-on-sigterm.js`).
- **Backups:** `src/backup.js` (encrypted, offsite); restore with `scripts/backup-restore.js`.
- **Status observers:** GitHub heartbeat plus `workers/status-probe`; a failed check is
  re-probed once before it is recorded.
- **Unpaid quote budget:** `src/unpaid-quote-budget.js` bounds bursts of unpaid 402 reads.
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
- **X posting:** one-off posts go through `announce.yml` / `scripts/tweet.js` (dispatched via
  Actions). The approved queue posts from the server (`src/tweet-queue.js`, Railway `TWEET_QUEUE`,
  off unless set, `TWEET_QUEUE_POSTING=off` read-only, `GET /__operator/tweet-queue.json`): one
  post per clock hour, recorded before it is sent; a post in doubt (5xx, timeout) gets one retry
  ten minutes later (X's duplicate refusal records it posted), then never. `tweetQueue` on
  `/api/gateway-status` is one word the status Worker pages on. Only the
  production server posts: FREE_MODE, no `NODE_ENV=production` (`TWEET_QUEUE_FORCE=true`
  overrides that check only) or no `/data` volume keeps it read-only. It replaces
  `tweet-queue.yml`, which is disabled at cutover so exactly one poster runs. Both sign through
  `src/x-oauth.js`. Tweet copy is never committed.

## Environment
Configuration and secrets are set on Railway (and, where a workflow needs them, as GitHub
Actions secrets), never in the repo. Rollout switches are generally "key present = feature on"
(for example `MPP_SECRET_KEY`, `TEMPO_API_KEY`, `STRIPE_SECRET_KEY`, `OPENROUTER_API_KEY`,
`X_BEARER_TOKEN`). Per-variable notes and thresholds live in `CLAUDE.local.md`.

## This sandbox vs. prod
The Claude Code web environment has an egress allowlist (npm and GitHub reachable;
`agent402.tools` blocked). Verify prod via CI (`[probe]`, heartbeat, canary) or a local
terminal.
