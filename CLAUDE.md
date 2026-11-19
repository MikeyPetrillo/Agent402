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
- `src/mcp-mpp.js`, `src/mcp-tasks.js`, `src/mcp-skills.js`, `src/mcp-x402.js`, `src/mcp-x402-routes.js`:
  connector payments, long calls as tasks, skill packs, the x402 MCP codec and the internal x402 twins of
  flagships (both wired to `/mcp` through `x402Loopback`, off in FREE_MODE; see `.claude/rules/mcp.md`).
- `src/mpp-shim.js`, `src/mpp-tempo.js`, `src/mpp-stripe.js`, `src/mpp-subscriptions.js`: MPP
  wire support. x402 keeps sole settlement authority on the evm path; the shim only translates.
- `src/credits.js`: prepaid card credits (hold at authorize, debit on a final 200).
- `src/human-checkout.js`, `src/stripe-subscriptions.js`, `src/monitor-scheduler.js`: card
  report products and recurring monitors.
- `src/seller-reputation.js` (`/api/reputation`): outside sellers' reputation from our own crawl
  and the router's own paid calls; never a payment, buyer or settlement count.
- `src/find.js` (`/api/find`), `src/discovery.js` (`/.well-known/x402`, `/api/reliability`),
  `src/x402-index.js` (crawled seller index), `src/dispatch-eligibility.js` (router labels).
  Submissions, parts, tool cap and the paywall probe: `.claude/rules/index-router.md`.
- `src/tools/route-execute.js`: route-and-execute, buys from proven external sellers per chain
  (`src/x402-buyer.js`, `src/solana-buyer.js` whose external leg runs under `SOR_SVM_BUDGET_MS`,
  inside a recent blockhash's life, `src/tempo-buyer.js`, `src/algorand-sellers.js`).
- `src/referral-gate.js` (the gate), `src/referral-settle.js` (facilitator client),
  `src/referral-chain.js` (chain reads), `src/referral-proof.js` (the receipt rule),
  `src/referral-book.js` (the settlement book and its sweep), `src/referral-answers.js` (answers
  kept for a re-sent payment), `src/referral-run.js` (route hints inside a referral run),
  `src/run-ceiling.js` (a run's ceiling on upstream waits): referral copies of allowlisted paid
  routes under `/ref/<slug>` (own gate; off unless all eight required settings are set:
  `REFERRAL_PAY_TO`, `REFERRAL_FACILITATOR_URL`, `REFERRAL_SIGNER_KEY`, `REFERRAL_SLUGS`,
  `REFERRAL_SETUP_URL`, `REFERRAL_COMMISSION_BPS`, `REFERRAL_MERCHANT_ID` and
  `REFERRAL_PAYOUT_ADDRESS`; `.claude/rules/payments.md`).
- `src/refund-ledger.js` + `scripts/refund-run.js`: charged-but-failed is recorded as a debt and
  repaid only after on-chain proof (`src/payment-verify.js`).
- `src/state-db.js`, `src/json-document.js`: the state database (Postgres) and the whole-file JSON
  store API; leases, store readiness and large rows in `.claude/rules/ops.md`.
- `src/status.js`, `src/status-store.js`: `/status`, measured from outside production.
- `src/solana-history-rpc.js` (Solana transaction reads: public lane first, keyed lane behind it),
  `src/solana-activity-store.js` (the activity scans' state across restarts),
  `src/upstream-call-days.js` (per-caller daily call counts); detail in `.claude/rules/ops.md`.
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
- A tool whose EVERY upstream wait ends at a run's ceiling declares `endsAtCeiling`
  (`markEndsAtCeiling`, `src/run-ceiling.js`), set beside the handler, slug by slug; the mark is what
  lets `/ref` serve it, so a handler that gains a wait the ceiling cannot end loses the mark in the
  same change (`scripts/test-run-ceiling.js`).
- A sale on `/ref` is booked once on the private rail `referral` (`src/paid-rails.js`): every public
  sales figure (`/api/sales`, rankings, the scorecard) counts it at the buyer's price and names the rail
  `marketplace`, `/api/stats` counts it as a paid call, only the operator's margin view reads its net,
  and the direct routes' settle breaker, status words, tool-call log and failure monitor do not count it.
- Nothing a `/ref` route answers points a buyer at this server's own surfaces (catalog, prices, docs,
  a direct route), and a `/ref` copy is sold at the price listed for the same call on the public
  route: a slug whose published example names this host, or that the public route gives for less
  (proof of work, the trial parameter, the first-call allowance), is refused at boot with the
  reason, and a listed slug that is not served reads attention on the status word.
- A tool is `{ route, name, slug, category, price, description, tags, discovery:{inputSchema,
  input/example}, handler }`. `handler(input)` returns JSON or throws an `Error` with
  `.statusCode`.
- A tool whose answer is bytes (the `{ __binary, contentType }` sentinel) declares `mimeType`, the type its published example
  returns; listings, `/openapi.json` and `/api/pricing` read it (`src/tool-media-type.js`, `scripts/test-bazaar-contracts.js`).
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
- The same guard sends every field of every free tool a structured corpus (rows that share no
  key, a spec whose schemas each reference the next twice, dates at the ends of the range, an
  object whose `toString` is not a function), bounds the size of each answer, and fails when a
  proof-of-work tool answers 500 or 502 to any of it.
- Request headers get the same corpus: `scripts/test-redos-request-headers.js` fills each header
  to the server's limit on every unpaid surface class and reads the longest event-loop turn from
  inside the server (`scripts/lib/loop-gap-preload.js`); a header reader it does not reach is
  timed there directly, so a new one is added to that list.
- A proof-of-work tool whose input holds a value that cannot be coerced (an object whose own
  `toString` or `valueOf` is not a function) answers 400 with the field named: the catalog wraps
  those handlers once (`src/caller-input-errors.js`). Every other bare TypeError or RangeError
  stays a 500 and is counted as a tool failure; a tool checks its own inputs for everything else.
- **Identity-bound routes** (memory, my-usage, attest, feedback) are keyed on the signed
  EIP-3009 `authorization.from` (`src/payer.js` `identityPayerOf`: null in FREE_MODE, where no
  header is verified); they are EVM-exact only and refused on Tempo/credits gates. A wallet session (`src/wallet-sign-in.js`, off by default) names the wallet only where no signed payer does, and never for attribution. Never weaken payer attribution. Never case-fold base58/Stellar addresses.
- Catalog floor: 400 entries, CI-checked by `node scripts/sync-count.js --check`. Marketing leads
  with the payment and trust layer; catalog size appears only as a supporting line, as "500+ tools",
  never an exact number. The lead sentence lives in `src/positioning.js` (its signed-receipt clause
  reads `receiptsServed()`); runtime surfaces derive exact counts.
- Retired routes answer 410 with a replacement: add every retirement to `src/retired-tools.js`.
  `scripts/published-slugs.json` records every route ever published; after adding a tool or
  pack run `node scripts/published-slugs.js --write` (`test-retired-routes.js` fails otherwise,
  and fails when a published route is neither live, key-gated nor retired).
- **Upstream costs are private.** Model, speech, embedding, media and STT rates, the vendor
  card (X) and fixed fees (among them the per-use fee of the web search that report products and
  `/v1` web searches make through the model aggregator) live in `src/upstream-costs.js`'s table, loaded
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
  (`scripts/test-no-third-party-names.js`, also run by `.githooks/pre-push`); the one exception
  is a bare badge line in README.md's "Independent records" section. No hidden
  character (TAG text, zero-width, bidi, variation-selector carrier, soft hyphen) in an
  instruction file: `scripts/test-hidden-chars.js` scans CLAUDE.md, `.claude/`, `wiki/`, `docs/`,
  the package READMEs, the adapter READMEs, `src/mcp-http.js`, `src/mcp-flagship.js`,
  `src/server.js` and `mcp/index.js`; the same scan (`src/hidden-chars.js`) is a listing finding
  in the index's injection screen.

## Key machine-readable surfaces (free)
`/health`, `/api/pricing`, `/openapi.json`, `/llms.txt`, `/.well-known/x402`,
`/api/reliability`, `/api/find?q=<task>`, `/api/route`, `/api/index`, `/api/reputation?seller=<host>`, `/api/stats`,
`/api/status`, `/api/gateway-status` (bucketed status words only, never numbers), `/robots.txt`,
`/sitemap.xml`, `/.well-known/glama.json`, `/x402-test` (payment-refusal diagnostics).
Operator-only surfaces live under `/__operator/*` (token-authed); the operator view of a public
surface reads `X-Operator-Token` only, since `Authorization` there is a buyer's credential.
Such a route calls `operatorView(req, res)` (server.js): every answer varies on the header, and an
elevated one is `private, no-store`, so a shared cache never keeps it.
`/__operator/routes.json` lists every operator route from the router (`src/operator-routes.js`);
`scripts/test-operator-routes-refuse.js` calls each one without the token and expects 404, so an
operator route is registered on the app itself (a mounted router is not listed and fails it).
Every answer carries nosniff, a referrer policy and HSTS, a parser-refused request included
(`src/security-headers.js`; per surface class in `scripts/test-security-header-surfaces.js`).
A browser operator session ends after `OPERATOR_SESSION_IDLE_SECONDS` (default 1800) with no
request, inside its 8-hour lifetime; a write carrying the session cookie needs Sec-Fetch-Site
`same-origin` or an Origin equal to BASE_URL's (a header-token caller needs neither).

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
  A run on `main` is never canceled by a newer push (cancel-in-progress applies to the dev
  branch only): a second merge's run waits for the first, and every job has `timeout-minutes`
  (`scripts/test-ci-gating.js`).
- **Flow:** commit to the dev branch with `[test]` only (never `[deploy]` on dev), push, open a
  draft PR, let CI run, merge with `scripts/merge-on-green.sh <pr>` (push-event run, every
  required check green, pinned to the tested SHA). It then waits `STRIX_WAIT_SECONDS` (default
  1800) for Strix's pinned summary of that SHA and merges on a clean one (Strix posts no review
  on a clean PR). It refuses on changes requested in any review of that SHA, a Critical or High
  finding, or no current summary by the deadline (Strix may not re-review a push made after the
  PR opened: the owner re-requests it, or passes `--no-strix`, the owner's explicit override).
- A merge to `main` is not a package release: check `npm view <pkg> version` against the local
  `package.json`.
- The deploy job's "Bazaar listing validation on the new build" step (after Verify, keys blanked)
  runs `scripts/bazaar-validate.js` against production up to three times a minute apart: a clean
  run passes, an INVALID run with no clean run fails the job, three unreadable runs warn
  (`scripts/test-deploy-release-order.js` pins the step).
- `heartbeat.yml` probes prod on a schedule and opens issues for outages and low balances; a
  daily paid canary (`scripts/paid-canary.js`) buys across every rail. No open issues = healthy.
- Keep-alive knobs (repo variables): `BAZAAR_PRICE_CHANGE_MAX_USD` caps the deploy job's one buy
  of each route whose fixed price changed (default 5), and
  `BAZAAR_PRICE_CHANGE_MAX_ROUTES` its route count (default 25; raised for one repricing
  deploy, then unset). `CANARY_BURNER_LOW_USD` (default 1) is now a floor: the heartbeat's burner low-water
  mark is one above-ceiling keep-alive pass plus a margin, read from the live catalog
  (`scripts/keepalive-plan.js low-water`), never under it, and the variable alone when the
  catalog cannot be read.
- `bazaar-presence.yml` reads the CDP listing every four hours (`scripts/bazaar-presence.js`, two
  full passes at least) and buys each route missing from every pass once per absence through
  `refresh-bazaar.js` MODE=missing with an explicit slug list (`REQUIRE_SLUGS=1`); exempt kinds
  and routes above the ceiling are never bought there. The repo variable
  `BAZAAR_PRESENCE_MAX_USD` caps one run's buy (default 2; more than 10 routes also refuses).
  One issue opens on a route missing two checks in a row, or three unreadable checks in a row.
- `bazaar-mcp-listings.yml` buys the hosted connector's MCP tool listings (the six fixed-price
  flagship tools, `scripts/lib/mcp-listings.js`) through the connector's x402 transport, once each:
  `refresh-bazaar.js` MODE=mcp takes an explicit list (catalog slugs or dotted tool names) and
  refuses the run on any other entry. It signs only an offer that pays the address the server
  publishes at `/.well-known/x402`, holds exactly one plain exact USDC accept on Base at the list
  price and asks ten minutes of validity or less; each signature is held to its listing's price
  and the run to the listings' prices together. A dispatch buys its `slugs` input; the 1st and
  15th run buys the plan's list only while the repo variable `BAZAAR_MCP_KEEPALIVE` is `on` (the
  burner low-water mark counts the pass only then). The plan job holds no key and joins no
  concurrency group; only a run on main buys. One issue records the listings a pass did not buy
  and closes when a run buys them (`scripts/mcp-listings-issue.js`). The presence check reads the
  listings (`/mcp#<tool>`), names in its log each one that was listed and left, pages on one
  missing two checks in a row under its own issue (fixed text, never the route issue) whatever
  that switch says, and never buys one;
  `bazaar-validate.js --mcp` checks the offers.
- The heartbeat also pages (one issue) on a security advisory in triage longer than the repo
  variable `ADVISORY_TRIAGE_MAX_HOURS` (default 24), and on a read it cannot make
  (`scripts/advisory-triage-check.js`): it reads with the Actions secret `ADVISORY_READ_TOKEN`
  (fine-grained, this repo, Security advisories read); a GHSA id in the repo variable
  `ADVISORY_TRIAGE_ACK` (comma list) does not page. The issue is fixed text pointing to the
  Security tab (no id, age or count), never commented on while open; ids and ages go to the job log.
- `model-drift.yml` runs the live-catalog guard (`scripts/test-gateway-model-ids.js`) every 6 hours,
  never on a push, and keeps one issue open while it fails (a cost row under its dearest live
  endpoint, or more than 15% above it for every servable model the row owns); its output is
  redacted before log or issue (`scripts/test-model-drift-redaction.js`).
- `bazaar-rank.yml` checks weekly that our own routes answer our main discovery queries
  (`scripts/bazaar-rank-monitor.js`) and keeps one issue open naming each absent query; a query
  text in the repo variable `BAZAAR_RANK_ACK` (comma list, unset by default) does not page, and a
  week whose search cannot be read records "not measured" and never pages or closes the issue.
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
  A lane's script list lives in `scripts/ci/lanes/<lane>.sh` under the `# @step N` its
  deploy.yml step runs (`bash scripts/ci/run-step.sh <lane> N`); add a test line there, and
  guards read deploy.yml through `scripts/lib/ci-workflow.js`.
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
- An offline suite imports `scripts/lib/offline-stores.js` FIRST (before any `src/` module): it
  clears `REDIS_URL`, `STATE_DATABASE_URL` and the journal switch, which modules read once at
  import, so a developer's shell never puts the suite on a shared backend. A suite that boots a
  server spreads `ownStoreEnv(label)` (`scripts/lib/own-stores.js`) after `process.env`, so every
  file store lands in its own temp directory and two servers never share a SQLite file. Every
  suite that reaches `src/` gets a stats store of its own from its first import (the offline pin,
  or `scripts/lib/own-stats.js` in a suite that runs on a real store); `scripts/test-stats-store-hygiene.js`
  fails a suite without one.

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
and `src/hangup-settlement.js` books it as owed. The settle-sent mark is a refusing hook
(`src/x402-hook-guard.js`): a throw cancels the settle (`settle_mark_failed`), so a charge is
never booked as a forgiven hang-up. The budget never refuses service. A route
whose effect outlives the answer never takes a ticket (`hasLastingEffect`: the memory writers,
`attest`, `feedback`, the route-execute tiers, `seller-payability`); add a new one there.
A payer's first hang-up in the window is forgiven at any price under the service-wide budget
when its payer and IP keys hold nothing in flight or abandoned; later ones meet the per-key
budget. Refunds stay human-run (`refund.yml`, dry run first); any buyer's owed row reads
`refundsOwed=owed` on `/api/gateway-status` past a short grace (a card report refund that could
not be sent, `owedRefunds` in `src/human-checkout.js`, folds into the same word), and the status Worker and
heartbeat page on it under one issue that closes when nothing is owed.

## Path-scoped rules, skills and reviewers
Subsystem detail lives in `.claude/rules/`, and each file loads only when a file matching its
`paths:` list is read: `payments.md` (gates, settlement, facilitators, breakers, price floors,
replay and idempotency, 402 bodies), `index-router.md` (seller index, submissions, parts and tool
cap, paywall probe, router, route-execute and its buyers), `gateway.md` (LLM gateway, metering,
model catalog, report products), `ops.md` (state database, scheduled loops, drain and containment,
monitors, backups, status, live view, workflows and workers), `identity-telemetry.md` (wallet sessions, Web Bot Auth, PostHog LLM and error events), `cdn.md` (CDN and client address,
async jobs and sync windows, large bodies, outbound fetches), `media.md` (OCR, PDF, Office and
media workers), `mcp.md` (connector modules, front door, shareable answers). Read the matching
file before changing a subsystem it names. The batch procedure is the `/batch` skill
(`.claude/skills/batch/`); the gate's reviewers are `.claude/agents/*-reviewer.md`.

## Environment
Configuration and secrets are set on Railway (and, where a workflow needs them, as GitHub
Actions secrets), never in the repo. Rollout switches are generally "key present = feature on"
(for example `MPP_SECRET_KEY`, `TEMPO_API_KEY`, `STRIPE_SECRET_KEY`, `OPENROUTER_API_KEY`,
`X_BEARER_TOKEN`). `STOCK_DATA_PROVIDER` (`off` default, `databento`) selects the stock data adapter
(`src/tools/stock-provider.js`); it is active only with its own key, else the stock tools and packs are unlisted. `KALSHI_TOOLS=on`
(`src/kalshi-switch.js`) lists the Kalshi tools; unset, they are unlisted and answer 503. `COINGECKO_API_TIER` (`demo`, the default, or `pro`) picks the CoinGecko
host and key header for `COINGECKO_API_KEY` (`src/tools/coingecko-endpoint.js`, the only file
that names them): a paid key needs `pro`, and a keyless call uses the public host whatever the
tier. `OPEN_METEO_API_KEY` present = the weather tools read Open-Meteo's keyed
hosts; unset = its public hosts. Per-variable notes and thresholds live in `CLAUDE.local.md`. The backup
bucket credentials (`BACKUP_S3_*`) live on Railway only, shown by `railway bucket credentials` and pasted by the operator
into the service variables, never in Actions: the deploy job's variable upsert must not name a
variable whose source of truth is Railway (`scripts/test-ci-secretless-install.js`).
The direct inference upstream's daily spend alarm reads `DIRECT_UPSTREAM_DAILY_ALERT_USD`
(Railway; `0` or `off` turns it off; `src/direct-upstream-spend.js`): an alarm only, it never
refuses, caps or reroutes a call.
