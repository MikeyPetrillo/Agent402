---
name: truth-audit
description: Audit every surface Agent402 is served on for truth, freshness, working links, analytics coverage, PostHog monitoring, cost posture and security. Use when the user says /truth-audit, "truth audit", "are our surfaces up to date", "check every claim", "do all our links work", or asks whether what we publish (site, GitHub, npm, Glama, x402scan, MPPScan, Bazaar, wiki, docs, packages) matches what the server actually does.
---

# /truth-audit: is everything we publish true, current, linked, measured, affordable and safe?

One pass, ten lenses, one report, one batch PR. The question for every line of
copy, every listing and every number is the same: **can I show the surface that
proves it, today?** If not, it is a finding.

## Standing rules (each one is a scar in CLAUDE.md, read that file first)

1. **Scope a check to the NUMBER, never to the page.** Every price drift we have
   shipped survived a guard aimed at the page that drifted last time. Grep the
   whole tree (src, wiki, docs, every package README, adapters, openclaw, the
   served HTML) for each retired figure, not for the page you expect it on.
2. **A merge is not a release.** For every package, `npm view <pkg> version`
   against the local `package.json` before believing a fix reached anyone.
3. **Derived beats typed.** A served number that is typed by hand is a finding
   even while it happens to be right; the fix is to derive it (catalog, TIERS,
   HUMAN_PRODUCTS, MONITOR_PRODUCTS, PACK_PRICE_RANGE, reportLadder) or add it
   to `scripts/test-price-prose.js`.
4. **Prove the sweep before believing its zero.** Plant a known-present string
   and confirm the grep/fetch reports it; a broken grep once reported three
   clean sweeps in one session.
5. **One reading is never an outage.** Our own deploys produce a 60-90 s
   no-container window; re-read before filing anything about prod.
6. **A cold cache says nothing.** The index, leaderboards and host figures
   warm-start; a seller count read in the first minutes of a boot is not a
   finding.
7. **Stub-proven is not proven.** Where a live proof exists (canary, registry
   smoke, verify-published-packages) read ITS latest run, not the unit test.
8. **Never tune a number to make a claim look acceptable.** Measured figures in
   tests are observations; update them from new measurements only.
9. **Public files carry no personal info, secrets, strategy or third-party
   business assessments.** The audit itself must not introduce any; balances
   and thresholds are bucketed words on public surfaces, figures live in
   `CLAUDE.local.md`.
10. **Evidence per finding:** surface (URL or path), the claim as written, the
    truth and where it was read, timestamp, severity, proposed fix, and whether
    it is ours to fix or operator-only.

## Where to run it

- **This sandbox cannot reach agent402.tools.** Prod HTTP reads need a local
  terminal, a `[probe]` dispatch, or the connectors attached to the session:
  the `Agent402` MCP tools (`server.describe`, `payment.info`, `catalog.search`
  hit the LIVE connector), Railway MCP (logs, variable NAMES, deployments;
  never print values), PostHog MCP (insights, alerts, event volume), GitHub
  MCP (workflow runs, issues, Dependabot and code-scanning alerts).
- Boot locally for everything the guards cover:
  `FREE_MODE=true X402_INDEX_CRAWL=off PORT=<free> node src/server.js`, then
  `TARGET_URL=http://127.0.0.1:<port>` for each script below. Use a port under
  32768; never 3000 if something else holds it.
- Write the report to `scratchpad/truth-audit-<date>.md` (gitignored) and
  carry only the fixes into the repo.

## Lens 1: copy and claims on the site and machine surfaces

Run the guards that already exist and read their output as the baseline, not
as the audit: `node scripts/sync-count.js --check`, `test-copy-absolutes.js`,
`test-price-prose.js`, `test-docs-truth.js`, `test-doc-claims.js`,
`test-reliability-claims.js`, `test-static-pages.js`, `test-surface-copy.js`,
`test-mcp-self-consistency.js`, `test-cross-surface.js`,
`test-public-surface-leak.js`. A green guard proves only what the guard reads.

Then read, as a stranger would, each of: `/` (hero, FAQ visible == JSON-LD,
AggregateOffer high/low derive from the catalog), `/why`, `/pricing`,
`/reports`, `/monitors`, `/credits`, `/markets`, `/faq`, `/docs`, `/compare`,
`/company`, `/security`, `/transparency`, `/revenue`, `/proof`, `/status`,
`/leaderboard`, `/marketplace`, `/mpp-marketplace`, `/x402-test`, `/sell`,
`/tollbooth`, `/skills`, `/101`, `/glossary`, `/agentic-finance`, every
`/guides/*`, every `/blog/*`, every chain page, `/privacy`, `/terms`. Machine
surfaces: `/llms.txt`, `/openapi.json`, `/.well-known/x402`,
`/.well-known/glama.json`, `/.well-known/security.txt` (Expires date in the
future?), `/api/pricing`, `/api/reliability`, `/api/find`, `/api/chain`,
`/v1/models`, the hosted `/mcp` initialize instructions and `payment.info` /
`server.describe` output, `robots.txt`, `sitemap.xml`, `sitemap-reports.xml`.

For each claim ask: is the count evergreen ("500+", never exact, except on the
runtime surfaces that derive it)? Is every price the current ladder? Read the ladder fresh from its sources
before reading any copy, never from this file or memory: `/api/pricing` (catalog,
`credits`, `humanProducts`), `REPORT_TIERS` (agent price + cap), `HUMAN_PRODUCTS`
(card cents), `MONITOR_PRODUCTS` (monthly cents), `PACK_PRICE_RANGE` (derived
pack range), and the metered floor in the gateway kit. Is every absolute
scoped ("these tools never hold funds", "no model in the serving path" only
with the exclusions named)? Does any sentence promise a chain, a facilitator,
a model id, a rail, a product or a tool that no longer exists (check against
`/api/pricing` and `/health`)? Does any date-stamped claim ("since", "as of",
"first", "only") still hold? Is the standing band suppressed on a cold cache?
Does every page reach the mobile menu, footer and the four machine links?

## Lens 2: links

Internal: `test-link-integrity.js`, `test-sitemap-coverage.js`,
`test-shortlinks.js`, `test-tool-page-backlinks.js`. External (NOT in CI, this
is the audit's job): collect every external href from README.md, `docs/**`,
`wiki/**`, every package README, `/company`, `/security`, `/transparency`,
footers, guides, blog posts, `security.txt`, and the badges; fetch each once
with a browser UA and a 15 s bound; report every non-2xx, every redirect to a
different host, every expired cert, every link to a retired page of ours
(`/pricing-page`, old guide slugs, `#anchor` ids that no longer render:
`headingId` derives them from token text). Check the redirect domains
`agent402.sh` and `agent402.co` 301 path-preserved, the `/install` script
serves, `/claude` and friends 302 to real pages, `www.` redirects only to
BASE_URL. Anchor links inside wiki pages point at headings that exist after the
CI sync.

## Lens 3: GitHub

README first screen (counts, prices, badges resolve, the hand-written copies of
`/why` points 06 and 07 match `why.js`), SECURITY.md (contact, ack window, safe
harbor, controls paragraph still true), CODE_OF_CONDUCT, LICENSE split
(AGPL server, MIT packages) stated consistently everywhere. Wiki: `wiki.yml`
last run green and the live wiki equals `wiki/`. Open issues: every heartbeat
issue open right now is a live alarm (gateway credits, wallets LOW, Postgres,
Tempo volume, PayAI credits, settlement stale, production DOWN); an issue open
for days is either a real condition or an alarm that cannot close itself.
Scheduled workflows: for every cron in `.github/workflows/*.yml` read the last
run's conclusion and date; a schedule that has not fired on time is a
GitHub-cadence problem to note, a scheduled run red for two cycles is a
finding. `test-workflow-run-refs.js` for `workflow_run` name drift. Rulesets:
"protect main" still requires every lane + markers + gitleaks + CodeQL +
Socket, SHA pinning required, admin bypass pull_request mode; the `production`
environment branch policy is `main` alone. Dependabot security updates on,
open Dependabot alerts triaged, CodeQL alerts zero open, secret scanning on
and clean, no stale Actions secrets (`NPM_TOKEN` gone; the list of secrets
matches what workflows reference; a secret referenced by no workflow and a
workflow referencing a missing secret are both findings).

## Lens 4: third-party listings and registries

For each, read the LIVE listing and compare to the paste-ready block in
`docs/ecosystem-listings.md` and to the truth in `/api/pricing`:
- npm: every package in the table below (description, README as rendered on
  npmjs.com, latest version == local, `deprecated` flags, provenance badge).
- PyPI `agent402-langchain` (publish-langchain-py.yml last run, README).
- MCP Registry: `registry.modelcontextprotocol.io/v0/servers?search=io.github.MikeyPetrillo/agent402`
  filtered on `isLatest` only (older versions still carry an exact tool count).
- Glama connector page vs `/.well-known/glama.json` (maintainer email is the
  company mailbox, schema still the one Glama publishes).
- Smithery server page, ClawHub `agent402-openclaw` (version == local, review
  status), wellknown.network badge, awesome-mcp-servers entry text if merged.
- Coinbase Bazaar: our resources carry <= 5 tags, descriptions are the
  purpose-written `BAZAAR_DESCRIPTIONS`, no retired route still listed
  (`bazaar-keepalive.yml`, `mint-bazaar-rows.yml` last runs).
- x402scan and the other x402 indexes: our seller row, price shown vs ours,
  the "701 payers" class (a sum of a non-additive metric is their defect, not
  a number to repeat).
- MPPScan + the mpp.dev registry: our entry, recipient, currency order
  (USDC.e first), the live 402 carries `WWW-Authenticate: Payment`.
- ERC-8004 registration (`erc8004-register.yml`), Base ecosystem / Stellar /
  Anthropic directory submission docs under `docs/`: every figure in a
  submission doc is a figure we would paste today.
- The X profile bio and pinned post (via `x-read.yml`), the Railway template.

Packages (truth = `npm view <name> version`, compare to local):
`agent402-mcp`, `agent402-client`, `agent402-tollbooth`, `agent402-openclaw`,
`agent402-agentkit`, `agent402-ai-sdk`, `agent402-anthropic-tools`,
`elizaos-plugin-agent402`, `agent402-google-adk`, `agent402-langchain`,
`agent402-llamaindex`, `agent402-openai-agents`, `agent402-openai-tools`,
`agent402-strands`, and `agent402-langchain` on PyPI.

## Lens 5: packages behave as documented

`verify-published-packages.yml` last run (installs from the REGISTRY and drives
prod). For each package: the bin works through a symlink (the no-op class
fixed twice), peer ranges admit the host's CURRENT stable (`npm view <host>
version`), README examples run against prod with a credits key or PoW,
`toolCount` is derived not embedded, the stdio and hosted MCP initialize
instructions are byte-identical, `mcp/server.json` matches the published
version, SLSA provenance on the latest publish. Every README price or count
matches the ladder read fresh in Lens 1.

## Lens 6: production runtime truth

`/health` build == `main` HEAD (a flag flip can roll prod back to an older
build with everything green). `/api/pricing` total >= 500 and the catalog
floor holds. `/api/gateway-status`: every leg reads `ok` (gateway credits,
upstreamBuyer, upstreamBuyerTempo, Solana buyer, stellarFacilitator,
subscriptionFeePayer, databases, operatorAuth, xDataSpend,
mppEvmDomainFallback); `unknown` is its own finding. `/status`: every
component fresh, no amber day without an incident behind it, both observers
(GitHub heartbeat, Cloudflare worker) reporting. `/api/reliability.status`
mirrors `/api/status.overall`. `/api/leaderboard` default `external`, self
row flagged. `/revenue` and `/proof` figures reconcile with
`/__operator/sales.json` (operator token from the local terminal only). Last
runs of: `paid-canary` (every rail leg), `algorand-rail-canary`,
`tempo-canary-verify`, `tempo-subscription-canary`, `upto-meter-canary`,
`stripe-link-canary`, `corpus-nightly`, `report-quality`,
`facilitator-mainnet-canary`, `solana-sor-live`, `tempo-sor-live`. A canary
that has only warned for a week is a finding (warnings page nobody).
`/__operator/facilitators.json`: first-tried facilitator per chain matches
what the boot log and docs say. Refund ledger: zero `owed` rows older than a
day, zero stuck `sending`.

## Lens 7: analytics (what we track, and whether we read it)

**Two analytics stacks, two jobs.** PostHog is product and payment telemetry:
the browser snippet (`posthogSnippet` in `ledger-chrome.js`, static loader
`/js/posthog-loader.js`) and the server events (`src/posthog.js`). Google
Analytics 4 (since 2026-10-01) counts visits and acquisition: `gaSnippet` in
`ledger-chrome.js`, static loader `/js/ga-loader.js`, rendered only when
`GA_MEASUREMENT_ID` is set on Railway. Guards: `test-ga-snippet.js`,
`test-analytics-redaction.js`.

GA checks: `GA_MEASUREMENT_ID` is set (name only) and the live HTML carries
the `ga-config` island; the island is absent on every bearer path (`/r/`,
`/m/`, `/reports/public/`, `/alerts`, `/followups`, `/credits/thanks`,
`/monitors/manage`, `/monitors/thanks`, `/digest`) and the loader's regex
still equals the server's `GA_BEARER_PATH`; Europe time zones start with
analytics storage denied and see the consent strip; ad storage, ad user data
and ad personalization are always denied; `?internal=1` traffic is filtered by
GA's Internal Traffic rule; the CSP names `www.googletagmanager.com` and
nothing broader; `/privacy` describes GA exactly as the loader behaves. In the
GA property: data is flowing, the key events a buyer journey needs are marked
(report buy click, monitor subscribe click, credits checkout, alert signup),
Search Console is linked, and referral exclusions cover `checkout.stripe.com`
so a card purchase is not credited to Stripe.

Check: the snippet loads on every HTML shell (ledgerShell pages, error and 404
pages, the report viewers, `/x402-test`, chain pages) and on no machine
surface; CSP admits it; the privacy page describes exactly what is collected
(first-party PostHog, Sentry, shadow ledger, no IP on server events,
`$process_person_profile:false` on every server capture). Server events exist
and carry the documented properties: `payment_settled` (wire, slug,
clientUa, synthetic), `gateway_usage` (price/upstream/margin/serviceTier),
`composite_usage` (rail, capUsd, overCap), `verify_failed` (errorReason,
network, path, payerKey, payerBalanceBucket), the rolled-up `paywall_402`,
`discovery`, `tool_gone`, `tool_call` (per-slug for real calls), `human_funnel`
(every step from checkout_started to report_published), the client events
`report_buy_click`, `monitor_subscribe_click`, `alert_signup_click`.
`test-posthog-funnel.js` pins the property sets; the audit asks whether the
INSIGHTS over them still exist and are read: "External metered buyers per
week" (the weekly number), "Pay-time gate" with the failed-USDC alert on the
COMPLETED day (upper 4,000), the external-only 5xx alert (25), the June
all-traffic 5xx alert still disabled, charged-failure window, card funnel
conversion, free-tier series on /revenue. Ingestion volume over the last 30
days against the 1M allowance, top event names by volume, any new scanner
shape. Search Console: sitemap submitted and read, index coverage of the
report pages, no manual actions. `INDEXNOW_KEY` file served.

## Lens 8: costs

Read every upstream bill and every balance alarm, then compare against what the
books attribute:
- OpenRouter: balance, the prod key's own monthly limit, the audit key's spend
  separate from buyer spend, `gateway_usage` sum vs the activity export for the
  month (an unexplained gap is a local audit or a leak), flex share, priority
  endpoints never billing over 2x their row (`test-gateway-model-ids.js`).
- Brave (`brave-reconcile.yml`: CI leak must be 0), E2B, CoinGecko Demo quota
  (prod ~1% of it; CI off the key), Alchemy CU (Solana leaderboard
  `rpcCallsLastScan`), X prepaid balance + `X_DATA_DAILY_MAX_USD`, openFDA,
  FRED, Hunter/Apollo if keyed.
- PostHog event volume (Lens 7), Sentry quota, Railway (one replica in
  us-west2, worker App Sleeping on, volume size, egress), Cloudflare workers,
  Tigris backup bucket under `BACKUP_MAX_TOTAL_GB`, Stripe fees vs the card
  floor, PayAI credits vs allowance, CDP, Solvador free tier, Celo key.
- Spending wallets (bucketed on `/api/gateway-status`, exact in the local
  terminal): Base, Solana, Algorand, Tempo USDC.e, subscription fee payer
  PathUSD, Stellar facilitator XLM, the CI canary burners per chain, the
  per-chain daily ceilings. `/__operator/margin.json`, `/__operator/egress.json`,
  `compositeUsage.overCap` on `/__operator/human-checkout.json`.
- Economics guards: `test-report-margins.js`, `test-pricing-margin.js`,
  `test-pack-pricing-rule.js`; re-measure the Opus synthesis cost from
  `$ai_generation` over 30 days and update the observations if the model mix
  moved, never the prices to fit.
- Process cost: merges per day on `main` (each is a 60-90 s gap); batch.

## Lens 9: security

Run `test-security-headers.js`, `test-free-tier-egress.js`,
`test-operator-auth.js`, `test-public-surface-leak.js`, the secret scan
(gitleaks) and CodeQL state. Then check by hand: every `/__operator/*` route
refuses unauthenticated (list them from `src/server.js`); `STATUS_PROBE_TOKEN`,
`FREE_ALERTS_SECRET`, `MONITOR_MANAGE_SECRET`, `BACKUP_ENCRYPTION_KEY` are SET
on Railway (names only; the 08-28 review left them operator-owed, and
`/__operator/backup.json` says `encrypted:true`); Actions secrets are
Actions-only where the notes say so (X keys, burners, refund keys), Railway
holds no CI-only key; `WALLET_ONLY_SLUGS` covers every tool that fetches
(the egress probe proves it); SSRF guard on every new fetcher; Redis refused
in plaintext off the private mesh; CSP has no third-party script host the
site does not load; HSTS preload; the www redirect is not open; rate limits
in front of the body parser on checkout paths; Dependabot and `npm audit`
(root, every package, facilitator) with no open high; the Stellar SDK on the
16.x line; `security.txt` Expires in the future; privacy and terms match the
stores that actually exist (alerts, digest, followups, credits, checkout,
leads, analytics); `CLAUDE.md` and every committed file free of personal
identifiers, wallet linkage, strategy and third-party business assessments;
the operator-token guessing counter reads `ok`.

## Lens 10: monitoring that can actually fire

For every alarm, name the last time it fired or was proven: heartbeat legs,
charged-failure alert (reads `/__operator/stats`, never public), settlement
freshness, PayAI credits, gateway balance unreadable, Postgres (two readings
30 s apart), operator guessing, canary funding (exit 3/4), tempo volume,
PostHog alerts (Lens 7), Sentry. An alarm that has never fired and has no
proof run is a finding, because the charged-failure alarm was dead for months
while reporting success. Every CI skip under `CI` must be a fail (ffmpeg,
redis, challenge-size, canary coverage). Every `workflow_run` reference names
an existing workflow by its `name:`.

## Output

1. `scratchpad/truth-audit-<date>.md`: a table per lens (surface, claim,
   truth, evidence, severity HIGH/MED/LOW, fix, owner), then "verified and
   true" per lens so a green lens is a list of what was read, not silence,
   then "could not verify from here" with the exact command for the operator.
2. ONE draft PR on the dev branch carrying every fix that is ours: derive the
   typed numbers, correct the stale copy on every surface the grep found,
   extend the guard that should have caught each one (scope it to the figure),
   add `[test]` to the commit subject, and `[publish]` in a commit SUBJECT
   when a package README changed (a merge is not a release). Operator-only
   items go in the report, never silently dropped.
3. Update `CLAUDE.md` with what the audit found and the lesson, in the
   existing dated style, without personal info, figures that belong in
   `CLAUDE.local.md`, or assessments of other people's businesses.
