# Agent402.Tools — project memory for Claude Code

Agent402.Tools is an **open-source, self-hostable x402 + MCP server**: 500+ deterministic
web tools an AI agent can call and pay for per request (USDC on Base via the x402
protocol, or free via proof-of-work). It's two-sided — it also ships
`agent402-tollbooth` (pay-per-crawl for site owners) and `agent402-client` (a buyer SDK).
Hosted at https://agent402.tools. Maintained by Havok Holdings LLC (the operating entity — use it, never a personal name, anywhere a maintainer is credited).

> This file is technical project memory. Do **not** put conversation content,
> personal info, secrets, or marketing/strategy in any committed file. Private
> context goes in `CLAUDE.local.md` (gitignored).

## Repository map
- `src/server.js` — Express app. Builds `CATALOG` (route → tool def), mounts free
  routes, the x402 paywall + proof-of-work gate, the stats tally, and all tool routes.
- `src/tools/` — the tool kits (kit, kit2, convert-gen, search, pdf-kit, demand-kit,
  media-kit, gov-kit, agent-kit, barcode-kit, data-kit, image-kit, x402-kit, util-kit,
  memory). Add tools here.
- `src/payments.js` — x402 v2 middleware (USDC on Base/Polygon/Arbitrum, CDP facilitator, Bazaar discovery).
- `src/pow.js` — proof-of-work tier (signed, single-use, slug-scoped). `WALLET_ONLY_SLUGS` = non-PoW tools.
- `src/mcp-http.js` — hosted MCP connector (`/mcp`): tools are DOTTED since the Smithery-naming commit `8aefdd89`
  (`catalog.search`, `catalog.find`, `catalog.call`, `payment.info`, `server.describe`, `sellers.list`, `demand.request`,
  plus flagship aliases `web.search`/`web.answer`/`web.news`/`browser.render`/`market.quote`/`audio.transcribe`/
  `memory.read`/`memory.write`); the old snake names (`search_tools`, `find_tool`, `call_tool`, `about_agent402`,
  `describe_server`, `list_top_sellers`, `request_tool`) remain CallTool ALIASES only, not listed.
  **Native MPP on /mcp (2026-08-19, `src/mcp-mpp.js`):** a wallet-only tool called on the connector is payable
  there - mppx's MCP wire (JSON-RPC error `-32042` + `data.challenges`; credential in
  `_meta["org.paymentauth/credential"]`; receipt in `_meta["org.paymentauth/receipt"]`). Settlement authority is
  UNCHANGED: the call is replayed as a LOOPBACK HTTP request to our own paid route (127.0.0.1:PORT, buyer IP on
  X-Forwarded-For) with `Authorization: Payment <credential>`, the real gates verify+settle, and only the wire
  shapes are translated (402 -> -32042 with that 402's fresh challenges + its RFC 9457 body as `problem`; 200 +
  Payment-Receipt -> result + receipt meta; other statuses -> isError "not charged"). Rollout switch =
  MPP_SECRET_KEY (no gates, no challenges -> the old paid-access text). `scripts/test-mcp-mpp.js` (14, boots
  the real server, stock SDK client + `McpClient.wrap`, stub facilitator sees exactly one verify + one settle).
- `src/find.js` — `/api/find` tool resolver (lexical ranking; also used by the `find_tool` MCP tool).
- `src/discovery.js` — `/.well-known/x402` service manifest + `/api/reliability` report.
- `src/stats.js`, `src/seo.js`, `src/landing.js`, `src/pages.js`, `src/guides.js`, `src/privacy.js`, `src/terms.js`.
- `scripts/` — tests + ops (revenue-scan, paid-canary, demo-payment, etc.).
- `mcp/` — `agent402-mcp` npm package (stdio MCP server). `tollbooth/` — `agent402-tollbooth` package. `client/` — `agent402-client` SDK.
- `wiki/` — source for the GitHub wiki (CI-synced). `docs/` — ecosystem-listing copy.

## Conventions
- A tool is an object: `{ route, name, slug, category, price, description, tags, discovery:{inputSchema, input/example}, handler }`. `handler(input)` returns JSON or throws `Error` with `.statusCode`.
- **Deterministic only — no LLM in the serving path.** Every tool is covered by the
  "answers its own example" CI check (`scripts/test-all.js`).
- Pure-CPU tools are PoW-eligible (free tier) automatically unless in `WALLET_ONLY_SLUGS`.
- **Catalog floor: 400 entries, CI-checked by `sync-count.js --check`** (counts derive live from the booted server, never from a doc). No upper bound — additions must meet the bar: answers its own example, priced to market, live-verified.
- **`price-pyth` RETIRED 2026-08-26:** Pyth put Hermes behind `Authorization: Bearer` at 16:00 UTC that day (keyless = 401 on
  hermes and hermes-beta; it broke the strict sweep within two hours), the base API plan is $500/month, and the ledger shows zero
  external sales ever - the retirement rule applied. `price-coingecko` covers spot prices; oracle-grade Pyth confidence data is
  not offered. Do not re-add without a paid key AND measured demand.
- **Retirement rule (2026-08-25):** a free-tier tool named on no marketing surface with zero external use in 30
  days (paid or PoW, from `/__operator/sales.json`) is a candidate to retire; a kit that empties is deleted
  outright. First cut: 40 tools + 29 skill packs (627 -> 558 catalog entries): `encoding-kit`, `math-kit`,
  `string-kit`, `color-kit` deleted; `date-time`/`validation`/`crypto-hash`/`util`/`text-analysis` kits kept only
  the tools a live pack or the test corpus depends on (timezone-convert, date-format, csv-lint, checksum,
  geo-distance, readability-score). Measured before cutting: the figure used was "20 of 627 priced tools had ANY external use in 30
  days, 10 buyers" - BOTH WRONG, and corrected 2026-08-30: they were the lengths of LIMIT-20 and
  LIMIT-10 queries, so neither could ever report more (src/sales-ledger.js; guard
  scripts/test-capped-counts.js). The real window: 412 tools / 111 buyers, or 132 tools / 109 buyers
  excluding one catalog-walking evaluator and our own Tempo burner. The REVENUE figure ($33) came
  from an uncapped aggregate and was right - external demand really is broad and shallow, not
  absent. Eleven retired packs had real outside buyers inside the window and were restored
  2026-08-30; free-tier use was 5 tools. Never retire below the 500 the "500+" claim check enforces.
- **Counts on marketing/static surfaces are evergreen — “500+ tools”, never an exact number** (README, wiki, docs, adapters, package descriptions, served-page copy). Adding tools requires NO doc sweep. `node scripts/sync-count.js` (and `--check` in CI) verifies, live from the booted server: the 400-entry floor, that the “500+” claim is honest (total ≥ 500), and that the README H1 still carries “500+ tools”. The old repo-wide numeric rewrite is RETIRED (it once corrupted HTTP 500s/font-weights/prices — see sync-count.js header); never reintroduce it. Runtime surfaces (`/api/pricing`, `/openapi.json`, `/health`, `docs.js`) derive the exact count — leave those exact.
- Memory tools (`/api/memory*`) are wallet-keyed (payment = identity), routed via `memHandler`, and must be in `WALLET_ONLY_SLUGS`. Per-namespace
  quotas: 10k keys (`MEMORY_MAX_NS_KEYS`, call-time read, default 10000) AND a 32MB
  total-value byte budget (`MEMORY_MAX_NS_BYTES`, call-time read); both return **413** when
  full — the byte budget is the disk-fill guard for the shared /data volume.

## Key machine-readable surfaces (free, unpaywalled)
`/health`, `/api/pricing`, `/openapi.json`, `/llms.txt`, `/.well-known/x402`,
`/api/reliability`, `/api/find?q=<task>`, `/api/stats`, `/robots.txt`, `/sitemap.xml`,
`/.well-known/glama.json` (maintainer email from `GLAMA_MAINTAINER_EMAIL` env),
`/api/gateway-status` (bucketed OpenRouter-balance status — "ok"/"low"/"unknown"/
"unconfigured", numbers never exposed, 5-min cache; heartbeat opens a "Gateway
credits LOW" issue on "low" — threshold `OPENROUTER_LOW_CREDITS_USD` (default: see CLAUDE.local.md),
because /v1 settles before the handler and an empty balance = charged-but-failed; response also carries `upstreamBuyer` — the x402 spending wallet's bucketed status, heartbeat opens "Upstream buyer wallet LOW (x402)" on low, threshold `UPSTREAM_BUYER_LOW_USD` (default: see CLAUDE.local.md)).

## Dev / CI / deploy workflow
- **Develop on branch `claude/sweet-brown-i99jl3`.** `main` is protected (PR required, no force-push).
- CI (`.github/workflows/deploy.yml`) triggers on push to the dev branch OR to `main`. Jobs gate
  on **commit-message markers** - no `.github/trigger-*` file needs touching (that path filter
  was removed 2026-08-11; it can't be scoped per-branch in one `push:` block, and it made `main`
  effectively un-triggerable since a PR merge commit never touches one):
  - `[test]` → full test job · `[deploy]` → Railway deploy · `[publish]` → npm + MCP Registry.
    **Since 2026-08-25 every push to the dev branch runs all test lanes with or without `[test]`** (a
    skipped lane satisfies a GitHub required check, so marker-less pushes were a loophole); `[deploy]` /
    `[publish]` still gate their jobs. A PR from our own dev branch does NOT run lanes on the
    `pull_request` event (the push run of the same commit provides the check runs); forks and other
    branches keep full PR lanes. The "protect main" ruleset requires every lane + markers + gitleaks +
    CodeQL + Socket (add new lane names there when splitting). Merge with `scripts/merge-on-green.sh <pr>` (push-event run, every lane green,
    pinned to the tested SHA). One-line test steps are collapsed into per-lane blocks (original step
    names ride as comments; the guards read the literal `node scripts/test-*.js` lines); `node_modules`
    is cache-restored by lockfile hash and `npm ci` skipped on a hit.
  - `[probe]` → live prod probe · `[paytest]`/`[drain]`/`[purl]`
  - **A push to `main` tests + deploys unconditionally, no marker required.** A PR merge commit
    (usually just the PR title) never carries our marker convention, so `main` can't be
    marker-gated the way the dev branch is - merging to main already means "this should be
    live." Closes a real class of bug (found 2026-08-11): five PRs, one an external contributor's,
    three from throwaway Cursor branches, merged clean, passed CI, and sat undeployed for hours
    because nothing separately pushed the dev branch afterward. One was a duplicate-seller bug
    the same contributor found live in production after their own fix had already merged.
  - `.github/trigger-tool-alert`, `-charged-alert`, `-heartbeat`, `-announce`, `-b20check`,
    `-x-verify`, `-self-consistency-alert` are unrelated to deploy.yml - each still gates its
    own dedicated workflow's path filter, untouched by the above.
- **Flow:** commit to the dev branch with `[test]` ONLY (never `[deploy]` - the operator, 2026-08-25: main deploys on
  merge, so a dev `[deploy]` swaps prod twice for one change) → push → open a **draft PR** → CI runs →
  merge to `main` (deploys on its own now, whether or not the dev branch was ever synced). The
  `create_pull_request` tool auto-appends a session-link footer; **strip it** via
  `update_pull_request` before/after creating (no session links in PR bodies/commits).
- **Heartbeat** (`heartbeat.yml`) probes prod every 15 min and opens a "production DOWN" issue on
  failure; a daily paid canary buys a $0.001 tool. No open issues = prod healthy. Also
  watches the **PayAI settlement quota** (PayAI is PRIMARY for Solana/Polygon/Arbitrum/
  Avalanche): rolling 30-day on-chain count from
  `/api/revenue/daily`, opens "PayAI settlement quota HIGH" at `PAYAI_QUOTA_WARN`
  (repo var, default: see CLAUDE.local.md). Unreadable data logs a loud warning, never a silent skip.

## Testing (run locally)
- Boot free mode: `FREE_MODE=true PORT=3000 node src/server.js` then `TARGET_URL=http://localhost:3000 node scripts/test-all.js` (every tool answers its example) and `scripts/test-mcp-all.js`.
- CI runs SEVENTEEN parallel test lanes (`test`, `test-sweeps`/`sweeps2`, `test-paid`/`paid2`, `test-unit-a`/`a2`/`a3`/`a4`, `b`/`b2`/`b3`/`b4`, `c`/`c2`, `d`, `test-pricing`), split by the seconds each script prints in its own log line (2026-08-25; the split is mechanical - a contiguous cut of each heavy lane's step list at half its measured seconds, so a re-split from a fresh run's log is a script, not hand work); the facilitator gate (~60 s of real Stellar testnet payments) is PATH-SCOPED to `facilitator/**` changes, fail-open on an unreadable diff, honest only while `facilitator/test.js` imports nothing outside `facilitator/` (`test-ci-facilitator-scope.js` pins the import closure); the two catalog sweeps + every browser page check live in `test-sweeps` (the only lane with Chromium, cached by playwright-core version). In that lane `test-all` runs with `TEST_ALL_SKIP_STRICT_COVERED=1` and hands the ~450 routes the strict non-metered sweep asserts on to it (one hit per endpoint; the strict sweep carries the documented-keys shape check too) - locally without the flag `test-all` still covers everything. `test-ci-gating.js` derives the lanes and requires each to gate deploy/publish.
- Paid-mode tests boot their own server (PoW path): `scripts/test-idempotency.js`, `client/test.js`.
- **The 147 metered slugs are excluded from the catalog sweeps, and the probe half is now covered.** `METERED_SLUGS`
  (`scripts/test-non-metered-examples.js`) excludes every LLM tier, every search tool and every paid report product from
  both catalog sweeps, correctly (CI holds no third-party keys and must not spend upstream) - and that is where
  outsiders keep finding defects, e.g. the 2026-08-29 domain-audit 500. A keyless local boot cannot reach them either:
  the report routes check `OPENROUTER_API_KEY` and 503 BEFORE their input probes run. `scripts/test-report-probes.js`
  (in CI, ~11s, no key, nothing spent) drives each report kit's exported free probe (the ones the monitors already call
  daily). **Driving the probes ALONE would not have caught that outage and the test says so:** `probeDomain` never
  threw; the crash was one layer in, in the handler's prompt-building, where `reportMailboxesFrom` spread the probe's
  `reportingUris` OBJECT as an array - a fixture said "object" and passed, the live probe says object too, and nothing
  had put the two together. So each leg also feeds its LIVE probe output through the pure functions the handler feeds it
  into (`consumers`). Verified by reintroducing the real defect verbatim. Only OUR code failing is fatal: every leg is
  retried once and only what survives is classified by `scripts/probe-classify.js` (programming error, or our own
  4xx/500 -> fail; 502/503/504, 429, network -> reported, never fatal, the same 502-is-not-ours rule test-all's lenient
  lane uses), whose nine rules are pinned in the test because getting 500-vs-502 backwards would file every real defect
  as "upstream" and keep the run green. A CONTROL leg with a planted defect runs FIRST, so a clean sweep is only
  believed once the harness has been shown to catch one. (Coverage notes in CLAUDE.local.md.)
- Unit/offline: `scripts/test-memory.js`, `test-find.js`, `test-revenue-scan.js`, `test-util-kit.js`, `test-discovery.js`, `tollbooth/test.js`+`edge.test.js`+`features.test.js`.
- Raise the MCP free-tier limit for sweeps: `AGENT402_MCP_MAX_PER_MIN=999999 AGENT402_MCP_MAX_PER_HOUR=9999999`.

## x402 settlement ordering (CRITICAL — get this right)
The installed **`@x402/express` (2.22.0 as of 2026-08-23, NOT the 2.16 this note
long claimed) runs the handler FIRST, then settles**, and
ONLY settles a `<400` response — for any handler `statusCode >= 400` it CANCELS
settlement (`reason: "handler_failed"`) so the buyer is **NOT charged**; if
settlement of a `<400` response fails, it discards the buffered body and returns a
402. So: **a 4xx/5xx (incl. a capacity 503 or an upstream 502) is never charged**,
and a 200 is only charged if settlement then succeeds. Do NOT assume "settles
before the handler" (an earlier, wrong belief that produced the F13 free-render
bypass and the pre-settlement idempotency cache — both since fixed). Anything that
caches, credits, or bills based on handler status BEFORE settlement is unsafe;
key such logic off the FINAL (post-settlement) response, e.g. `res.on("finish")`
with `res.statusCode === 200`. (`node_modules/@x402/express/dist/esm/index.mjs`.)

## Notable features (current)
- **Idempotency:** opt-in `Idempotency-Key` header; cache key = `sha256(METHOD /path + key + gate-credential)`. **x402 `payment-identifier` (2026-08-19):** declared on every route's 402 (`declarePaymentIdentifierExtension(false)`, payments.js) and honoured as an ALIAS of the header (`paymentIdentifierOf(req)` in payer.js, header wins) under the SAME binding rules - exact credential + route + body - never a cross-authorization dedupe (the id is client-chosen text on a payload unverified at that point in the chain). Pinned in test-mpp-shim (declared on the 402; exact retry replays with one settle; same id on a new credential settles again). **Settlement-aware (FR4-01):** the body is captured at `res.json` but COMMITTED to the cache only on `res.on("finish")` when the FINAL `statusCode === 200` — i.e. after `@x402/express` has settled — so an unsettled 200 (settlement-failure → 402) is never cached/replayed. No-op without the header; streamed responses are never replayable. `scripts/test-idempotency-settlement.js`.
- **Tollbooth:** charge modes (`bots`/`all`/`strict`), adaptive PoW, analytics (`gate.stats()` + `/__tollbooth/stats` + `/__tollbooth` dashboard), deploy templates (Cloudflare/Next.js/Docker). Defaults preserve original behavior.
  **0.9.0 (2026-08-19, build #13): native MPP on TEMPO + split payments.** `createTollbooth({ tempo: { apiKey,
  recipient, currency|currencies, splits:[{recipient, amount}], chainId, apiBaseUrl } })` (env
  `TOLLBOOTH_TEMPO_API_KEY`/`_RECIPIENT`/`_CURRENCY`/`_SPLITS`) - `tollbooth/tempo.js`, dependency-free like
  mpp.js: mints tempo/charge challenges with the same HMAC id binding (mppx Challenge.verify agrees), wire
  request byte-for-byte mppx's schema output (base-units amount, NO decimals, `methodDetails.chainId`,
  `methodDetails.splits` in base units, ≤10, total < price - a bad split never mints), speaks Tempo's relay
  over plain fetch (`/v1/mpp/validate` before the handler, `/v1/mpp/broadcast` after a <400 response with
  `idempotency-key`, `tempo-api-key` header), buffers the handler's response (writeHead/write/end/
  flushHeaders) exactly like the main app's tempo gate, replays with `Payment-Receipt` +
  `X-Tollbooth-Paid: mpp-tempo`, counts `tempoPaid`; refused credentials get the gate 402 + fresh
  challenges + RFC 9457 `problem`; single-use via the operator's `replayStore` (`tempo:<id>`) or an
  in-process map; works with NO x402 middleware (Tempo-only tollbooths). `tollbooth/tempo.test.js` (31,
  in CI). Published 2026-08-19 via `[publish]`. **LIVE-PROVEN 2026-08-19 (0.9.1):** `tollbooth-tempo-live.yml`
  (dispatch; `TEMPO_API_KEY` is an Actions secret since 2026-08-19) boots a tollbooth on the REAL relay and
  pays it $0.001 from the canary burner - run 32302253442: 200 + `X-Tollbooth-Paid: mpp-tempo` +
  Payment-Receipt, tx `0x9ec426902345790c3d07cbcf32831e702648907e43ebed5c21077677101c3728`, `tempoPaid:1`.
  The FIRST live run (0.9.0) failed and found what the stub relay could not: `relayInput` forwarded the
  wire challenge with `request` as the base64url STRING, while mppx hands the relay the DESERIALIZED
  credential (`request` = decoded object, Relay.js `toRelayInput`) - the real relay refused every
  credential. 0.9.1 decodes it and `tollbooth/tempo.test.js` pins the relay wire shape (34). Lesson
  (same as the main gate's two wire drifts): a stub relay that accepts anything proves nothing about the
  wire; the live dispatch is the proof, and it prints the 402 `problem` + `X-Tollbooth-Error` on failure.
  **0.9.2 (2026-08-20): chain-truth confirm on broadcast failure** — same fix as the main gate's
  `src/tempo-confirm.js` (relay reports failure for a SETTLED payment when a buyer's yParity-style v byte
  is normalized by the node), dependency-free: keccak-256 implemented in-package (BigInt lanes, pinned
  against standard vectors + the live incident tx), candidates = submitted bytes + v-swapped twin, receipt
  must succeed and pay the challenge currency/recipient/>=amount, fails closed to the 402. `confirm:false`
  disables; `confirmRpcUrl`/`TOLLBOOTH_TEMPO_RPC_URL` overrides the RPC; `confirmSettlement` injectable.
  `tollbooth/tempo.test.js` (55).
  **0.7.0 (2026-08-18): `x402:` middleware mode + MPP.** `createTollbooth({ x402: paymentMiddleware })` delegates paid requests to the operator's @x402/express middleware with the REAL response (verify -> handler -> settle in its own order), lifts its PAYMENT-REQUIRED onto the gate's 402 (stock x402 v2 clients can pay), and - default on - mints `WWW-Authenticate: Payment` evm/charge challenges from it and translates `Authorization: Payment` -> PAYMENT-SIGNATURE (`tollbooth/mpp.js`, dependency-free codec, HMAC id binding compatible with mppx's `Challenge.verify`), mirroring `Payment-Receipt` on settle. **`x402VerifierFromExpress` is deprecated: with @x402/express v2 (settle AFTER handler) it granted on verify and never settled - served, never charged - because it handed the middleware a stub response the real handler never ended; measured in `scripts/test-tollbooth-mpp.js` (32 assertions: real @x402/express + stub facilitator, real mppx client buys, real @x402/fetch buys, settle counted once each, tampered credential, PoW-first).** Edge gate: PoW + legacy verify only for now.
- **Buyer SDK (`agent402-client`):** `find()` + `call()` with auto-payment (PoW free / x402 paid), caching, idempotent retries, non-custodial.
- **LLM gateway (`src/tools/llm-gateway-kit.js`, OpenAI wire paths):** five tiers —
  nano `$0.003 /v1/nano/…`, **auto `$0.01 /v1/auto/…`** (model optional: deterministic
  eval-ranked routing via `AUTO_RANKINGS[quality][category]` + `classifyPrompt` —
  code/reasoning/long/general × quality bands fast/balanced/best (`quality` knob,
  price-neutral, 400s alongside an explicit model); ranking doubles as the failover chain;
  response adds `agent402_router {category, quality, served}`; tier listed LAST in `TIERS`
  so `tierFor()` ordering is stable), base `$0.02`, pro `$0.10`, premium `$0.50`,
  plus **`/v1/embeddings` `$0.002`** (OpenAI upstream, batch ≤64/16k chars, cache
  DEFAULT-ON — deterministic output; `cache:false` opts out; `embeddingsCacheKey`),
  plus **`/v1/rerank` `$0.002`** (`v1-rerank`, 2026-08-19 build #12 part 1 — Cohere wire
  `{query, documents[], top_n}` over OpenRouter `/rerank`, model locked `cohere/rerank-v3.5`;
  live: 1 search unit = $0.001; caps ≤50 docs × ≤1,600 chars, ≤40k total, query ≤500 chars keep
  every call at ONE search unit so $0.001 sits under the 70% bound with no token math; strings
  only (structured {text,image} docs bill differently → 400); cache DEFAULT-ON (`rerankCacheKey`,
  deterministic ranker); billing fields stripped, `search_units` kept; `gateway_usage` tier
  `v1-rerank`; paid-canary `llm-rerank` leg),
  plus the **Anthropic Messages wire on all five tiers** (`src/tools/llm-messages-kit.js`, build #12
  part 2 — `POST /v1/nano/messages` `$0.003`, `/v1/auto/messages` `$0.01`, `/v1/messages` `$0.02`,
  `/v1/pro/messages` `$0.10`, `/v1/premium/messages` `$0.50`; slugs `<tier>-messages`; same TIERS
  config = same allowlist/caps/max_price/flex/failover as the chat route; OpenRouter `/api/v1/messages`
  serves ANY model through this wire (live-verified gemini + claude); Anthropic body validated
  (system, content blocks text/image/tool_use/tool_result/thinking, client tools with input_schema
  only — server tools refused, thinking {enabled budget|adaptive|disabled}, stop_sequences, top_k);
  margin clamp runs on a PROBE copy with base64 images replaced by a marker (billed flat); usage
  cost/is_byok/cost_details stripped non-stream, SSE `message_delta` frame scrubbed by the shared
  scrubber; `stop_reason:max_tokens` + nothing said walks the chain (`isEmptyMaxTokens`);
  telemetry tier `<tier>:messages`; auto tier adds `agent402_router`; NOT on this wire: the opt-in
  prompt cache and reasoning-effort defaults (buyer sets `thinking` natively). Canary `llm-messages`
  leg. `scripts/test-llm-messages.js` (41)),
  plus the **OpenAI Responses wire on all five tiers** (`src/tools/llm-responses-kit.js`, build #12
  part 3 — `POST /v1/{nano,auto,pro,premium}/responses` + `/v1/responses`, slugs `<tier>-responses`,
  same TIERS config; OpenRouter `/api/v1/responses` (any model; live-verified gpt-4o-mini, gpt-5-nano,
  claude); `input` string or items (message with input_text/input_image parts, function_call,
  function_call_output, reasoning), `instructions`, `max_output_tokens` (default/clamp like the chat
  wire), function tools ONLY (web_search*/file_search/computer/mcp/code_interpreter/image_generation
  refused), `text.format` (json_schema/json_object → `provider.require_parameters`), buyer `reasoning`
  validated + the chat wire's default effort injection (`defaultReasoningFor`), `store` forced false,
  `previous_response_id`/`background` refused (no server state), `input_file` refused (metered parse);
  `status:incomplete` for max_output_tokens + nothing said walks the chain (`isEmptyIncomplete`);
  usage billing stripped non-stream, and the stream's NESTED `response.usage` scrubbed - the shared
  SSE scrubber now strips `obj.usage`, `obj.response.usage` and `obj.message.usage` (the top-level-only
  scrub would have leaked cost on every streamed Responses call). Telemetry `<tier>:responses`; canary
  `llm-responses` leg; `scripts/test-llm-responses.js` (26)),
  plus the **grounded tier** (build #12 part 4 — `POST /v1/grounded/chat/completions` `$0.03`,
  `v1-chat-grounded`: the auto router + OpenRouter's `web` plugin (Exa, `max_results` 5) on every
  call, answers carry OpenAI-wire `annotations` url_citation; search is billed per REQUEST on top of
  tokens (measured: Exa auto $0.007 in `usage.cost`, ~700 injected prompt tokens/result) so the
  tier carries `fixedUpstreamUsd: 0.007` + `extraInputTokens: 4500`, both folded into
  `worstCaseUpstreamCost`/`clampToMargin` (largest call on the priciest ranked model ≈ $0.015 vs the
  $0.021 bound); `noCache: true` (promptCacheKey null, no deferred write - the web moves); web +
  response-healing plugins merge; `:online` stays refused everywhere else (this tier is the
  sanctioned home); listed LAST in TIERS so tierFor() keeps resolving explicit models to their
  home tiers; canary `llm-grounded` leg. Build #12 is COMPLETE: rerank, Messages, Responses,
  grounded),
  plus **`/v1/images/generations` `$0.08`** (`v1-images` — OpenAI images wire translated
  to OpenRouter chat `modalities:["image","text"]`, model locked `google/gemini-2.5-flash-image`,
  n locked 1, `IMAGES_MAX_TOKENS` 1600 + `IMAGES_MAX_PRICE` provider bound, data-URI →
  `b64_json`, no cache/stream, imageless upstream → 502),
  plus **`/v1/audio/speech` `$0.06`** (`v1-audio-speech` — OpenAI TTS wire on
  OpenRouter's audio API. OpenRouter has NO OpenAI TTS models (their docs still say
  otherwise — burned us 2026-07-09); serves a FIVE-model failover chain instead
  (`SPEECH_MODELS`: Voxtral Mini TTS → Grok Voice → Kokoro-82M →
  MAI-Voice-2-Flash → MAI-Voice-2 (Zonos removed 2026-08-19: zero endpoints upstream), all proven by real buys via the dispatchable
  `.github/workflows/openrouter-tts-probe.yml`, which probes the live
  `?output_modalities=speech` list — never hardcoded ids; latest full sweep run
  30971572514, 2026-08-05, which also proved the -Flash link before it entered).
  Chain walks on ANY
  upstream failure incl. empty audio — payment settles pre-handler, so a provider
  outage must never be the buyer's 502. OpenAI voice names map per-model; native ids
  (e.g. `en_paul_cheerful`) accepted, listed per model on `/v1/models`. 2k-char cap;
  TTS bills per INPUT char so worst-case/link is deterministic ($0.032 Voxtral … $0.044
  MAI, all under price). `instructions` rejected (self-explaining 400 — no serving model
  supports it); `speed` 0.25–4 accepted (cost-neutral, ignored by most). Raw mp3/pcm
  bytes via the route binder's `{__binary, contentType}` sentinel — no cache/usage
  accounting on binary. Listing gated on `OPENROUTER_TTS_ENABLED=true`
  (server.js `GATEWAY_TOOLS_ENABLED`) as the rollout switch — ON in prod since
  2026-07-16; canary llm-speech leg settles green). Upstream OpenRouter (`OPENROUTER_API_KEY`, 503 when unset). Failover walks
  the chain on upstream 502/503/504 only — every chain ends in the canary-proven model.
  **Streaming** (`stream:true`): handler returns `{__sse}` sentinel, route binder pipes SSE
  after settlement. **Prompt cache** (`cache:true`, opt-in): byte-identical repeat served
  free pre-paywall within 10 min (`X-Cache: hit`); keys on the tier + normalized body
  (resolved model included) **computed WITHOUT the margin clamp** (`validateRequest(..., {clamp:false})`,
  2026-08-25) - the clamp is where the tokenizer runs and the key is computed for unauthenticated
  requests, so it must stay O(body); the clamp runs in the handler after the 402 is cleared. **Margin protection (two layers, both in `validateRequest`):**
  (1) per-tier `maxPrice` rides upstream as `provider.max_price` on every call — buyer-supplied
  `provider` can never loosen it; (2) margin clamp — exact-BPE (`gpt-tokenizer` o200k, static
  import: must stay sync for `promptCacheKey`) prices the FULL outbound body (incl. tools
  schemas, images flat 1600 tok, `n`≤4 multiplier; **counted in 1 KB pieces + 1 token per boundary**
  (`countInPieces`, 2026-08-25: one unbroken CJK run was a single quadratic BPE chunk, 24 s per 100 KB;
  the piecewise count is structurally >= exact; embeddings/rerank use the same helper; gpt-tokenizer's
  merge cache capped at 2,000 entries per encoder so buyer text cannot park gigabytes in it) against `MODEL_COST` (longest-prefix,
  elementwise-min'd with `maxPrice`), then shrinks `max_tokens` so worst-case upstream ≤ 70%
  of tier price; input alone over budget → self-explaining 400. Deterministic → cache-key
  safe; cheap models never feel it. **Margin telemetry:** non-stream calls ride
  `usage:{include:true}` to OpenRouter (call-time inject, never in cache keys); exact
  upstream cost → PostHog `gateway_usage` event (price/upstream/margin/tokens), then
  `cost`/`cost_details`/`is_byok` are STRIPPED before the response is cached or returned
  (never leak the bill to buyers; posthog.js loaded lazily in the handler). **Streams
  too (2026-08-19):** OpenRouter now puts full usage incl. `cost` in the final SSE frame with NO
  opt-in (`usage.include` is a documented no-op), and the stream path piped raw bytes, so every
  streaming buyer saw our upstream bill - verified live with a nano stream. `createSseUsageScrubber`
  strips the billing fields in flight (line-aware, partial lines buffered across chunks) and hands
  the cost to the same PostHog event, so streams carry margin telemetry now. **`user` field:**
  every upstream call carries `user: a402:<sha256(payer or gate credential)>` (`upstreamUserId`) -
  OpenRouter scopes provider policy blocks to it; without it one abusive buyer could get the whole
  account blocked. Call-time injection, never in cache keys. **Variants:** `:online` (per-request
  web-search billing outside max_price) and `:batch` (async) are refused with self-explaining 400s;
  routing-only `:nitro`/`:floor` still pass. **Live-catalog guard:** `scripts/test-gateway-model-ids.js`
  (CI, network) fails on any advertised/ranked/fallback/TTS id missing upstream, any MODEL_COST
  entry under a live admitted price inside the tier's max_price, or a ranked model expiring within
  14 days - it found 5 dead advertised ids, the dead Zonos TTS link, and 9 underpriced MODEL_COST
  rows on its first run (all fixed the same day). **Balance alarm (`gatewayCreditsStatus`) reads
  TWO ceilings:** `/credits` (balance, low-water `OPENROUTER_LOW_CREDITS_USD`, default in CLAUDE.local.md) and
  `/key` `limit_remaining` (the prod key's own monthly USD limit, set 2026-08-19, figure in CLAUDE.local.md;
  low under `OPENROUTER_LOW_KEY_LIMIT_FRACTION`); either low → "low"; "ok" needs the balance
  leg readable; otherwise "unknown" with `unknownForMinutes`, and heartbeat opens "Gateway balance
  UNREADABLE (OpenRouter)" after 180 min of unknown (a balance we cannot read is its own alarm).
  **Flex-first (2026-08-19, `FLEX_MODELS` + `flexAttempts`):** every chain link in the live-verified
  flex table (gemini-2.5/3.x families, gpt-5-nano, gpt-5.6-*; `/v1/images/generations` too) is
  tried with `service_tier:"flex"` (OpenRouter's 50% tier, higher latency, never falls back on
  its own) and then the SAME model on the default tier before the chain advances; an empty
  refusal on flex skips the default retry (it would refuse too). Measured: the image model's
  flex endpoints are exactly half price on every unit, and images were ~99% of the upstream
  bill (68 of 528 calls, $2.63 of $2.67, 07-19..08-18; ~44% of that was the daily canary's
  own image leg, which now rides flex automatically). `gateway_usage.serviceTier` records which
  tier served. `OPENROUTER_FLEX=off` disables. The live guard fails CI if a FLEX_MODELS entry
  loses its `*/flex` endpoint (flex on a model without one 404s = a wasted attempt per call).
  **Prompt-cache levers (2026-08-19):** every chat call carries top-level `cache_control:{type:"ephemeral"}`
  (default on; buyer `cache_control:false` disables; `ttl:"1h"` refused - 2x Anthropic write cost) and
  `session_id` = the per-buyer `user` id (OpenRouter sticky provider routing, so implicit caches on
  OpenAI/Gemini/DeepSeek/Grok and Anthropic's explicit cache actually hit). Call-time only, never in the
  cache key. The margin clamp prices Anthropic input at 1.25x (`cacheWriteFactor`: a first-seen long
  prompt is a cache WRITE) so the bound stays honest; reads bill 0.1x. `usage.cache_discount` is stripped
  with the other billing fields (non-stream + SSE scrubber). `provider.sort:"price"` rides on the BUDGET
  tiers only (nano + auto, `priceSort: true`): on the same model sort-by-price can land on a quantized
  provider - a buyer-visible quality change pro/premium did not buy, and max_price already bounds them.
  `OPENROUTER_PROVIDER_SORT=off` disables. All four fields live-verified accepted by OpenRouter on
  Gemini/DeepSeek/OpenAI/Anthropic before shipping.
  **Reasoning defaults + wire compat (2026-08-19, build #5):** `REASONING_MODELS` (prefix ->
  supported efforts; live-guarded) + `defaultReasoningFor(model, tier)`: when the buyer sent no
  `reasoning`/`reasoning_effort`, a default-on/mandatory reasoning link gets `reasoning.effort` =
  lowest non-"none" effort on nano/auto/base (`reasoningDefault:"lowest"`), "low" on pro, the
  model default on premium. Measured: gpt-5-nano at max_tokens 64 AND 256 with default/low effort
  returned `finish_reason:length` + EMPTY content (paid empty answer); minimal answered. Buyer
  `reasoning` objects are validated (effort set, max_tokens <= tier cap, exclude/enabled bools)
  and live in the normalized body (cache key); `max_completion_tokens` is honoured as the cap
  alias. `isEmptyLength` (length + nothing said) walks the chain like an empty refusal (same
  model's default-tier retry skipped), end-to-end empty -> 502. `response_format` json_schema /
  json_object adds `provider.require_parameters:true` and, off-stream, `plugins:[{id:
  "response-healing"}]` (live-verified: accepted, no cost change; buyer `plugins` never pass).
  **zdr knob:** `zdr:true` (or
  `provider.zdr`) is the ONLY buyer-settable provider field — folds into the server-owned
  provider prefs next to `max_price`, lives in the normalized body (distinct cache entries),
  stripped from the top-level outbound body. All tiers in `WALLET_ONLY_SLUGS` and
  test-all's lenient NETWORK set.
- **Metered gateway tier (2026-08-26, `v1-chat-metered`, `POST /v1/metered/chat/completions`):** the 402 PRICE IS A
  PER-REQUEST QUOTE. `@x402/core` resolves a `price(context)` function on every request (payments.js `acceptsForItem`:
  a catalog item with `quote(body)` advertises a function price on every option, exact + upto), so the amount is
  re-derived from the body actually served - a payment authorized for a small quote cannot ride a bigger body (the
  requirements no longer match, 402 again). Quote = the margin clamp's worst case (exact-BPE input + max_tokens at
  the model's list price) x `METER_MARKUP` (1.15) + `METER_FLOOR_USD`, never below `METER_MIN_SETTLE_USD` ($0.001,
  the facilitator floor), rounded UP to a micro-dollar; over `METERED_MAX_QUOTE_USD` ($2, env
  `GATEWAY_METERED_MAX_QUOTE_USD`) the 402 carries the cap and the handler refuses 400 (>= 400 cancels settlement).
  Prefixes = union of the flat tiers' (listed LAST so `tierFor` keeps home tiers first; `/v1/models` lists no
  duplicate ids, every chat entry carries `meteredEndpoint`/`meteredFromUsd` instead). `clampToMargin` is a no-op on
  it (the ceiling grows with the request). The upto meter (`gateway-meter.js`) uses the stashed
  `req.__meteredQuoteUsd` as the ceiling, so an upto buyer settles actual x 1.15 under the quote. The Tempo, Stripe
  and credits gates price through `quotedPriceUsd(def, req)` (server.js) so a metered call is bound/held at its
  quote, never the $0.001 catalog floor. Why: flat tiers are 170x-2,162x upstream on small calls, and exact-only
  clients (most stock x402 clients) never see the upto meter - this is the per-token-router-shaped price
  (a comparable live 402 elsewhere quotes $0.002 for a 50-token gpt-4o-mini call). `test-pricing-margin` asserts quote >= worst
  case x markup on this tier instead of "< price"; `test-price-premium` pins the function price; `test-llm-gateway`
  pins floor/growth/cap/refusal.
- **Dossier inputs: operating-to-net bridge + verbatim filing excerpts (2026-08-26, `dossier-kit.js`,
  `scripts/test-dossier-inputs.js`):** a customer's INTC ticker pack listed "the unexplained $11.03B quarterly net loss ...
  cannot be reconciled from the material provided" as a RED FLAG. The 10-Q explains it in one sentence (a $12.5B fair-value
  loss on Escrowed Shares issued to the US Government) and XBRL carries it (`NonoperatingIncomeExpense` -$12.58B); the
  pipeline had fed the synthesis nine headline concepts plus filing TITLES, no filing text, no bridging lines - the model was
  honest about thin inputs, the inputs were the defect. Now: `FIN_CONCEPTS` carries non-operating / pre-tax / tax;
  `incomeBridge()` emits an OPERATING-TO-NET BRIDGE block for the newest period whose ends disagree by >15% (reported lines,
  remainder, "explained" verdict); `pullFilingExcerpts()` reads the newest 10-Q (else 10-K) primary document ONCE (bounded,
  iXBRL `<ix:header>` stripped, XBRL-id soup filtered) and hands the synthesis <= 6k chars of verbatim windows around a fixed
  vocabulary (`EXCERPT_TERMS`: mark-to-market, fair value, escrow, warrant, impairment, restructuring, going concern,
  material weakness, ...) under the filing's own source number; prompt rule 4b: A GAP IN THIS MATERIAL IS NEVER A FINDING
  ABOUT THE COMPANY ("the material provided here does not explain ..." - never "unexplained"/"undisclosed"/red flag).
  Live-verified on INTC the same day: "That gap is not a mystery: the filing attributes it to a $12.5 billion ... mark-to-
  market loss on the Escrowed Shares derivative liability [4]". Ticker pack inherits it (same handler). Note `fmtUsd` now
  renders negatives as `-$12.58B` (was `$-12.58B`).
- **LinkedIn article product (2026-08-26, `src/tools/linkedin-article-kit.js`, `linkedin-article`, `POST /v1/linkedin-article`
  $1.10 agent / $4 card (the derived ladder rung for $1.10), cap $0.65):** topic (+ angle, audience, tone, author byline,
  CTA, length short/standard/long, images {cover, inline 0-1, style}, hashtags 0-5) -> the research-deep pipeline
  in-process (`makeResearchHandler("research")` with the new `accountAs` seam so the spend books once under this slug)
  -> one Opus JSON synthesis in LinkedIn's shape (3 headlines <= 100 chars, subtitle, hook-first body under ## subheads
  with facts as markdown LINKS to their sources - LinkedIn keeps links, has no [n] - takeaways, companion post <= 3,000
  chars with hashtags, image briefs) -> one budget image per brief (`v1-images-fast` handler in-process, ~$0.014) crop-
  filled in-process (`image-ops` new `cover` op, off-thread via the image pool) to LinkedIn's OWN sizes: article cover
  1920x1080 (LinkedIn help: "optimal image size for the cover photo is 1920 (w) x 1080 (h)", max 7680x4320), post /
  link-share 1200x627 (1.91:1), feed square 1200x1200, feed portrait 1080x1350, in-article 1200x675 - JPEG, under the
  3 MB cap, dimensions re-read from the JPEG header. Deliverable = markdown `report` (article, takeaways, linked
  sources, companion post, alternative headlines, image manifest, publishing notes) + structured `article`/`post`/
  `images[{slot, alt, prompt, files[{name, use, width, height, bytes, b64}]}]`; `_humanGenerate` carries `images` into
  the card bundle, `human-checkout` stores it, `report-view.js` previews each slot and downloads each size as a real
  file. House style enforced in code (em/en dashes replaced). A failed cover = 502 not charged; a failed inline image
  is named in the report. Registered: ALL_KIT, `_premiumHandlers` + kind `linkedin`, HUMAN_PRODUCTS, /reports card,
  WALLET_ONLY, EXPENSIVE_COMPOSITE (long-running: EVM exact only), REPORT_TIERS, margins ladder, test-all NETWORK,
  non-metered METERED_SLUGS. `scripts/test-linkedin-article-kit.js` (25, in CI: stubbed upstreams, REAL resizing).
  LinkedIn has no public API for personal articles: the product delivers the package, never posts.
- **Report inputs round 3 (2026-08-26; `scripts/test-report-inputs.js` 44, in CI):** **token-risk** told buyers owner
  privileges/upgradeability were "not visible here" - now three keyless legs run beside the paid Blockscout ones:
  `probeGoPlus` (token_security: proxy, mintable, honeypot, owner + renounced, hidden owner, taxes, pausable, blacklist,
  LP holders/lock share, DEX liquidity; chain-id map in `GOPLUS_CHAIN_IDS`), `probeDexPairs` (DexScreener pairs: depth,
  24h/1h volume + buys/sells, profile), Blockscout `address-profile` (proxy type/implementations/is_scam) and the
  Sourcify ABI through `privilegedFunctions()` (a fixed vocabulary of owner-privilege names: mint/pause/blacklist/
  setFee/enableTrading/upgradeTo ...); CONTROL & UPGRADEABILITY + LIQUIDITY & TRADING blocks; rule 2 disclaims ONLY
  what a probe marked FAILED. Verified on BRETT/Base. **token-brief**: `shapeJupStats` keeps Jupiter's ORGANIC buy/sell
  volumes + organic buyers (their wash-trade signal) for 24h/6h/1h, pairs print 6h/1h flow, websites/socials and the
  jup verified/strict flags reach the identity block, risks and lockers say "N of M". **domain-audit**:
  `probeDnsPosture` (CAA via resolveCaa, MTA-STS/TLS-RPT/BIMI TXT, DNSSEC via cloudflare-dns.com dns-json AD flag - a
  failed leg is "unknown", never "not configured"), SPF lookups counted RECURSIVELY through include/redirect in
  `countSpfLookupsRecursive` (network-kit; github.com 8 top-level -> 10, stripe.com 3 -> 7; `valid` uses the recursive
  count; both the composite and the standalone spf tool carry `lookupCountRecursive` + `lookupTree`), whois
  status/nameservers/dnssec and CT `truncated` reach the material, signals carry dnssec/caa/mta-sts/tls-rpt.
  **research-deep / market-brief**: `readBodies` fetches the top 5/8/10 reranked sources' page bodies through the
  SSRF-guarded `extractArticle` (6k chars each, +$0.04-0.08 per report) and labels every source FULL TEXT or EXCERPT
  ONLY in the prompt and the appended list; the thin-evidence guard counts searches that returned CITED evidence (not
  call success) and requires >= 3 distinct sources; sub-answers ride through `stripInlineCites`; rule 7 is the
  MATERIAL-vs-SUBJECT sentence; `auditCitations()` (pure, exported) strips [n] outside the source range, expands
  ranges, sets `meta.sources_cited` to the DISTINCT n actually used (was the listed count), and records
  `unverified_numeric_claims` (a sentence's number found in neither the cited source's text/snippet nor the
  sub-answers) in meta - never rewrites prose; `sources[]` returned to the buyer carry `fullText`/`bodyChars`, bodies
  themselves stay server-side. Handler takes `deps.fetchBody` for tests.
- **Report inputs round 2 - the SEC kits (2026-08-26; `scripts/test-report-inputs.js` 36, in CI; every fix verified live
  on the reviewer's own example):** **filing-report** read 800 KB of a 10-Q (22% of INTC's text, ending before the
  escrow note) and read an earnings 8-K as its 4k-char shell - now periodic reports (10-K/10-Q/20-F/40-F) are read to
  8 MB (`docMaxBytesFor`) and the 36k-char budget is spent BY SECTION (`sliceForBudget`: cover+statements, notes opening
  + vocabulary windows via the dossier's `extractFilingExcerpts`, MD&A opening + windows, Legal Proceedings, Risk Factors;
  headings found by TEXT and POSITION because a 10-Q carries each heading in its TOC, a glossary and an index at the END -
  MD&A = the LAST long run, notes = the FIRST, legal/risk >= 15% into the doc); an 8-K whose items are 2.02/7.01/8.01/
  1.01/2.01/5.02 also gets its EX-99 exhibit read (`exhibitFromIndexHeaders` on the accession's `-index-headers.html`
  SGML, entity-escaped); 8-K `items` ride from the submissions JSON with `ITEM_LABELS`; SUBSTANTIVE puts the periodic
  report ahead of the 8-K; FWP/424B5/S-8/SCHEDULE 13G|13D are ROUTINE; doc blocks say EXCERPTED with the sections held.
  **insider-report** parsed only `nonDerivativeTransaction` (11 of META's 41 Form 4s are derivative-only - those
  directors vanished) - `parseForm4` now returns `derivativeTransactions` + `holdings` (`nonDerivativeHolding`), the
  prompt carries DERIVATIVE TRANSACTIONS + REPORTED HOLDINGS blocks and per-insider "direct holding after latest
  transaction", `val()` strips nested tags (a `<footnoteId/>` leaked into `expires`), `maxFilings` 40 -> 100 (one EFTS
  page, XML reads only) and the header/totals say "newest N of M, coverage from <oldest read>" when the window holds more.
  **fund-report** dropped every 13F-HR/A (Berkshire's Q1-2025 NEW HOLDINGS amendment adding D R Horton/Lennar/Nucor
  after confidential treatment) and wrote "no prior quarter exists" for a read timeout - `get13fHoldings` now reads the
  cover (`parse13fCover`: isConfidentialOmitted, totals) and folds same-period amendments (NEW HOLDINGS appended,
  RESTATEMENT replaces; `amendments[]` on the result), the prior read is retried once then 502 (not charged),
  ADD/TRIM are ranked by the DOLLAR SIZE of the change with % vs prior, `changeRows` 20/30 per bucket, a CAUTION line
  when either cover declares confidential treatment. **ipo-report** called every 424B4 a "priced IPO" and every S-1 a
  "company preparing to list" (last week: 5 of 9 and 8 of 10 were follow-ons/resales by public issuers) - each filer is
  now classified from its OWN submissions index (`classifyFromSubmissions`: periodic report filed BEFORE the filing =>
  follow-on; SIC 6770 => spac; else ipo; 6h cache, <= 150 filers, concurrency 4), F-1 is a third leg, `edgar-recent-
  ipos` pages EFTS up to `limit`, the headline says "read N of TOTAL" and tickers/exchanges ride the rows. **ticker-pack**
  holders were 12 managers by full-text relevance (INTC: Coatue, REX Advisers, none of Vanguard/BlackRock) - `probe13G`
  (one EFTS query over SCHEDULE 13G/13G-A/13D/13D-A + legacy SC forms, `ciks=` issuer, 400 days; `parse13GCover` on the
  post-2024 structured `primary_doc.xml`; rows whose cover `issuerCik` is not ours are dropped - EFTS `ciks=` matches ANY
  CIK on the filing, so Intel's own 13G on Mobileye came back) renders "5%+ holders as disclosed on Schedule 13G/13D"
  ABOVE the 13F sample; a 0-share/0% row is a filer disclosing it fell below 5% (Vanguard on INTC, 2026-03-13) and is
  shown as that. Every prompt got the MATERIAL-vs-SUBJECT sentence.
- **Cross-report input review (2026-08-26, three lenses after the INTC dossier miss; round 1 shipped, rest in memory
  `report-inputs-review-2026-08-26`):** recall-report queried openFDA UNSORTED (relevance order) and headlined the 20
  rows as the universe - losartan's newest recall (2024-05-07, Ongoing) was absent from the page it called "newest
  first", and the monitor's fingerprint (recall numbers of that page) could never see a new recall that did not rank
  into the top 20; now every enforcement fetch carries `sort=recall_initiation_date:desc`, returns `total`, and the
  composite asks with `full:true` (reason/product/distribution uncapped - 20 of 20 insulin-pump reasons exceeded the
  220-char public cap; the NDC sits at the END of drug descriptions) plus lots (`code_info`), event id (117 losartan
  RECORDS = 51 EVENTS), termination date, quantity; the prompt/header say "N most recent of TOTAL" and count events.
  domain-audit graded a self-signed or wrong-host certificate 100/100 (TLS scored on days alone): `tlsScoreOf(tls,
  domain)` is 0 when `chainTrusted === false` or the cert does not cover the host (`certCoversHost`, wildcard-aware);
  tls-cert now returns `authorizationError`/`protocol`/`cipher`; the material shows DMARC sp/aspf/adkim/rua/ruf/fo, MX
  hosts, header VALUES (300 chars), the DKIM selectors probed. `scripts/test-report-inputs.js` (12, in CI). The
  warm-start test's timing control is now self-consistent (one-shot hold >= half its own measured parse) - it used to
  demand 3x the incremental loader's worst tick and a 93 ms GC pause on a runner failed a green build.
- **Usage-based billing on the metered tier for EVERY buyer type (2026-08-26):** (1) **credits/card buyers**: `isMeterable`
  now counts `req.creditsSettled` - `applyMeteredSettlement` sets `X-Metered-Usd` (no x402 override) and the credits
  gate's finish hook debits `min(hold, X-Metered-Usd)` via `settle(hash, held, slug, chargeUsd)`, returning the rest of
  the held quote to the balance (before: a card buyer on `/v1/metered` paid the worst-case quote, not usage; the sales
  ledger already read the header). Pinned in test-credits (metered debit, cap at the hold) and test-gateway-meter
  (credits request metered, no override). (2) **plugin wallet buyers** (`agent402-openclaw` 0.3.0): `resolvePayFetch`
  reads the wallet's Permit2 allowance on Base USDC (`getPermit2AllowanceReadParams`, `AGENT402_BASE_RPC` default
  mainnet.base.org); with an allowance it registers `UptoEvmScheme` on eip155:8453 and the client selector
  (`selectAccept`) picks the `upto` accept - the quote becomes a ceiling and the gateway settles actual x 1.15; without
  it, exact (the quote) as before, with a one-line hint. `agent402-openclaw permit2-approve` sends the one-time USDC ->
  Permit2 approval (viem wallet client; the wallet needs a little ETH on Base for gas); `doctor` reports the mode.
  Why: per-token routers bill actual tokens plus a few percent; with (1)+(2) every buyer of ours pays actual x 1.15 + the $0.001 facilitator
  floor, and the remaining gap is the markup, a pricing call. Live proof = the paid canary's `metered-upto` rail leg (2026-08-26): the CI burner ALREADY held a max Permit2
  allowance on Base USDC (read on-chain: a max allowance with a little already spent through it before the leg existed -
  the earlier note here that it had none was wrong), so `permit2-approve` was a no-op and no approval tx was sent; the leg
  registers `UptoEvmScheme` beside exact with the plugin's selector, buys the llm-metered body, and fails the run unless the
  OUTGOING credential was scheme `upto`, `X-Metered-Usd` is strictly under the quote, and a receipt settled (a client that
  quietly fell back to exact still gets a 200, which is why the sent scheme is asserted). Pinned in `test-canary-coverage`.
- **agent402-openclaw is tested against a REAL OpenClaw (2026-08-26, `openclaw/test-real-install.js`, in CI):** `npm i
  openclaw@latest` (~90 MB, Node >= 22.22) into a scratch dir, `npm pack` + `npm i -g` (the bin symlink), `openclaw plugins
  install <tgz>`, `setup --write` through the symlink against a stub gateway, `openclaw models list/status`, `openclaw
  gateway run` (the plugin service must start the loopback proxy), then ONE `openclaw agent` turn asserted at the stub
  (metered route, credits Bearer, answer echoed back). Its first run found THREE defects every stub-based test had passed:
  (1) `openclaw plugins install` REFUSED every published version 0.1.0-0.2.0 (`plugin manifest requires configSchema`) -
  the manifest now carries `configSchema` + `uiHints`; (2) `agent402/auto` as primary could never complete a turn:
  OpenClaw sends ~70k chars of system prompt + tool schemas before the user's first word (measured 33,476 + 37,210 on
  2026.7.1) and its precheck refuses "Context overflow" against `auto`'s 16k-char input cap - `setup` now writes the
  cheapest preferred metered model that fits (`defaultPrimary`, `OPENCLAW_MIN_INPUT_CHARS` 80k; haiku-4.5 > gpt-4.1-mini >
  gemini-2.5-flash > gpt-4o-mini, else cheapest fitting, else `auto` + a loud warning), metered routes advertise the METERED
  tier's caps (`/v1/models` now carries `meteredMaxInputChars`/`meteredMaxTokens`; the plugin defaults to 200k/8192 on
  older gateways), and the guide's hand-written block points at `/v1/metered` with an explicit model; (3) `setup --port N`
  moved only the provider baseUrl while the plugin service read its port from `plugins.entries.agent402.config` (stayed on
  8412). Also: `openclaw plugins install` does not link the package bin, so the docs say `npx agent402-openclaw setup`.
  Lesson (third time on this package): stub-proven is not proven; the host is the oracle. Note for that test file: spawns
  must be ASYNC because the stub gateway lives in the test process (a sync spawn starves it). 0.2.1 published.
- **Security + cost review of the 2026-08-25/26 builds (2026-08-26, four lenses: leaks / bypass / money / claims+CI;
  fixes in the same-day audit PR):** HIGH (process) `scripts/merge-on-green.sh` gated only the `test*` lanes and merged
  with `--admin`, which bypasses the ruleset's required checks - #949 merged with CodeQL red; it now reads the ruleset's
  required contexts and refuses unless each is SUCCESS on the PR head (`--admin` stays: the ruleset needs a code-owner
  review and there is one owner). HIGH (product) `agent402-openclaw` 0.1.0/0.1.1 were NO-OPS through npm's bin symlink
  (`import.meta.url === file://${process.argv[1]}` is false when argv[1] is the symlink) - the registry smoke ran cli.js
  by direct path and never saw it; 0.1.2 compares against `pathToFileURL(realpathSync(argv[1]))` and the test invokes
  the CLI through a symlink and from a path with a space. HIGH the metered quote was recomputed ~15x per unauthenticated
  POST (13 rails + 2 appenders, ~1.5 s of event loop on a 33 KB CJK body) - memoized on the request
  (`req.__meteredQuoteUsd`, payments.js + `quotedPriceUsd`). HIGH (accounting) metered sales were booked at the $0.001
  catalog floor - `settledPriceUsd(def, req, res)` (X-Metered-Usd override > quote > catalog) feeds the ledger/PostHog/
  shadow ledger, and `gateway_usage.priceUsd` is the quote. MED metered + card was loss-making under ~$3 (Stripe 2.9% +
  $0.30 on a 1.15x quote) - `cardPriceUsd` grosses the fee up on QUOTED routes only (flat routes unchanged). MED the
  metered tier sent `provider.max_price` 20/100 - now the quoted model's MODEL_COST row. MED "retries never pay twice" was
  false: the idempotency cache ignored credits buyers (no payment header) and the plugin minted a fresh key per call -
  the cache now binds a credits key's HASH as the credential (`req.creditsSettled` counts as paid for seeding) and the
  proxy passes a client Idempotency-Key through. MED the plugin proxy spent the user's key on any browser no-cors POST to
  loopback - requests with an `Origin` header or a non-loopback `Host` are refused. MED three typed claims on the
  2026-08-26 X cards were wrong or loose ("USDC on 12 chains" = 11 + USDG; the MPP evm row implied 12 chains when the
  evm challenge is Base+Celo; stripe shown on a $0.02 route) - script corrected for reuse; the posts stand (a
  correction is the operator's call). LOW: `setup --write` rewrote openclaw.json at 0644 (mode now preserved, 0600 when new);
  credits key accepted via env/stdin; unsigned webhook hits no longer cost a disk write each (5 s debounce, verified
  events persist at once); guide tier table rendered from TIERS; stripe log slices buyer strings; canary metered leg
  quotes ABOVE the floor so a collapsed quote is visible. **First real metered settlement:** paid-canary run
  32962953735, `llm-metered -> settled $0.001` (2026-08-26 11:28Z). Card rail first live settlement:
  pi_3U8VOXRaPcokjIwV0WvAvBAb (2026-08-26 01:12Z) - recorded here because the repo carried no evidence of it.
- **Route-and-execute (`POST /api/route/execute`, $0.01, `src/tools/route-execute.js`):**
  resolves a task/slug via `findTools`, dispatches the underlying internal tool (underlying
  price cap $0.005), returns `{result, receipt}`; underlying errors pass through.
  **The spend ceiling books the WORST CASE, not the seller's declared price (2026-08-29 review):** since the price-cut
  ratchet fix a route's resolved price comes from the origin's OWN current declaration, which made one seller-controlled
  document the number booked against the per-payer `EXTERNAL_MAX_UNSETTLED_USD` ceiling (value in CLAUDE.local.md). Per-call spend was never
  at risk (`payExternal` re-checks `maxAtomic` against the accept it signs), but a seller declaring $0.0001 while
  quoting $0.005 made each call count as a FIFTIETH of its exposure, giving the self-dealing case 50x the headroom.
  Now `maySpend`/`noteSpend` take the tier `cap` and `adjustSpend(handle, underlyingUsd)` corrects DOWN once the seller
  has actually quoted (only ever lowers; ignores negative/unreadable; no-op on an unknown handle). The call site is
  pinned FROM SOURCE in `test-external-spend-guard.js` (31) because the two mutations are not equally visible: letting
  `adjustSpend` raise fails three assertions, but quietly handing the caller the declared price again fails NOTHING -
  the primitive stays correct and is simply given the wrong number.
  **Resolve-time model check (2026-09-02, `sellerServesModel` in x402-buyer.js):** an LLM task names a model and the
  model namespace is the SELLER'S own - "chat completions" + `gpt-4o-mini` on Solana resolved to api.xfuel.app, which
  settled the $0.01 and answered 400 model_not_found, and xfuel KEEPS the money on a 400 (our chain check saw the
  debit, so no fallthrough). Every OpenAI-shaped seller publishes GET .../models for free (blockrun + netintel list
  gpt-4o-mini; xfuel, openrelay, ai-rook, agentexchange do not), so route-execute hands `params.model` to
  `resolveExternalSeller({ wantModel })`, which reads the candidate's list (chat-shaped routes only: chat/completions,
  completions, messages, responses -> /models; cached 10 min per list URL; SSRF-guarded; 5 s) and SKIPS a seller whose
  READABLE list lacks the model, before the probe. Only "not-served" decides: no list, empty list, unparseable, non-chat
  route or no model requested is "unknown" and changes nothing (openrelay answers gpt-4o-mini with MiniMax - mapping is
  not a defect). Prefix-tolerant both ways (`openai/gpt-4o-mini` ~ `gpt-4o-mini`), never substring. Pinned in
  test-solana-router (95), test-sor-resolver-scope (14, call site from source), test-route-execute (64).
  **Base chain-truth refusal (2026-09-02, `src/evm-authorization-state.js`):** the Solana-only "refused payment -> read
  the chain -> fall through" now has its Base twin, and it is EXACT rather than a wallet window: the EIP-3009 nonce we
  signed is either consumed on the token (`authorizationState(authorizer, nonce)`, selector 0xe94a0102, pinned against
  viem) or it is not. payX402 asks it on any non-200 paid retry on Base when the payload carries a nonce; false after the
  8 s grace = provably unpaid (hold released, error uncommitted + `refused`, seller memoized 6 h on base, route-execute
  tries the next candidate); true or an unreadable RPC keeps the post-commit stance. Base only (`AGENT402_BASE_RPC`);
  other EVM rails still take the seller's word. test-x402-buyer.
  **External settlement is CHAIN-MATCHED (2026-07-23):** the buyer's payment network picks
  the spending wallet — `eip155:8453` → Base (X402_UPSTREAM_BUYER_KEY, the proven path),
  Algorand mainnet CAIP-2 → the AVM spending wallet (`ALGORAND_UPSTREAM_BUYER_MNEMONIC`,
  env-gated: without it Algorand buyers get a 409 naming supported chains and are never
  charged). Algorand candidate discovery + proven-ness both come from the GoPlausible
  facilitator catalog (`src/algorand-sellers.js`: /discovery/merchants × /discovery/resources
  → origin-keyed verifications, 30-min stale-while-revalidate cache, https-only hygiene
  filter; same `SOR_MIN_SETTLED_TX` threshold, same live 402-probe + payX402 margin guard
  before any spend). AVM buys sign 1000-round validity (the image-gen-premium dead-txn
  lesson). `scripts/test-algorand-router.js` (offline, in CI).
  **MPP sellers on Tempo (2026-08-18, `src/tempo-sellers.js` + `src/tempo-buyer.js`):** a
  third external chain, `tempo`. Candidates = OUR live-verified MPP index (mpp.dev
  registry, probed) flattened to routable resources: tempo/charge in **USDC.e only**
  (`0x20C0…8b50` — 138/141 registry sellers and mppx's mainnet default; PathUSD is
  mppx's TESTNET default), static integer prices only, no path templates. Pay =
  `payTempo`: bare request → live 402 → asset pin + chain 4217 + live amount ≤ cap →
  **proven-seller gate** (recent inbound USDC.e transfers to the challenge's recipient
  via `rpc.tempo.xyz` eth_getLogs, 99k-block window ≈15h, `SOR_TEMPO_MIN_SETTLED_TX`
  default 20, fails CLOSED on RPC error; measured: Firecrawl 4,184 / Exa 2,129 vs 0
  for two others) → mppx `tempo.charge` credential from the DEDICATED Tempo spending
  wallet `TEMPO_UPSTREAM_BUYER_KEY` (EVM key; may be the same address as the Base
  spending wallet, funded separately with USDC on Tempo; NEVER treasury/canary) → retry
  with `Authorization: Payment` → relay result + `Payment-Receipt` reference (`wire:
  "mpp"` on the router receipt). Inbound mapping: an MPP/tempo buyer (the tempo gate
  sets `req.mppTempoCredential` before the handler; `buyerPaymentNetwork` reads it as
  `eip155:4217`) routes to Tempo sellers (chain-matched); Base buyers fall through to
  Tempo sellers only when `SOR_TEMPO_FROM_BASE=true` (Base revenue funding Tempo spend
  is a treasury-float decision). `/api/gateway-status.upstreamBuyerTempo` + heartbeat
  "Tempo upstream buyer wallet LOW (MPP)". `scripts/test-tempo-router.js` (32
  assertions, offline, in CI). Seller-side counterpart: `TEMPO_CURRENCY` is a CSV (one
  tempo challenge per currency, first = preferred; a stock mppx client pays the FIRST
  tempo challenge and does not auto-swap by default), code default still PathUSD; **PROD
  FLIPPED 2026-08-18: Railway `TEMPO_CURRENCY=usdc,pathusd`** (live 402 offers USDC.e then
  PathUSD) and PROVEN the same day: tempo-canary run 32167901691 paid from the PathUSD-funded
  burner via `autoSwap: true` - on-chain tx 0x28db1d76… swapped 1001 PathUSD → 1000 USDC.e
  and delivered 1000 USDC.e to our payTo, 200 + Payment-Receipt. Both canaries keep
  `autoSwap: true`.
- **Solana SPL leaderboard (2026-09-02, `src/solana-leaderboard.js`) - INCREMENTAL, because the first version cost 3,122
  Alchemy calls in its first hour:** every Solana payTo the index knows (`allSolanaPayToOrigins`, mainnet label only,
  base58) keeps three things across cycles - its USDC token account (resolved once; a payTo with NONE is re-checked daily,
  not every cycle), the newest signature seen (`getSignaturesForAddress` with `until`, plus a dedupe belt against the
  event log so an RPC that ignores the cursor cannot double-count), and the credited events inside the 7-day window
  (`creditFromTx`, the gate's rule extracted pure: balance rose AND a non-self account was debited; funder recorded).
  A cycle costs one signatures read per payTo with an account plus one `getTransaction` per NEW inbound transfer
  chain-wide (measured second-cycle cost in the test: 1 call for a quiet payTo, 0 for an empty one). One payTo at a time
  (two in parallel drew 37 Alchemy 429s/timeouts on the first live scan), one retry, previous row kept `stale` on error,
  120 tx reads per payTo per cycle (`truncated`), two-hour cadence, persisted WITH its cursors at
  `/data/solana-leaderboard.json`, warm-started. Each refresh PRIMES `primeSvmInboundCount` (solana-buyer) and both gates
  default to `cachedSolanaInboundCount`: a primed count that clears the floor answers with no RPC, one below it falls
  through to a live read (stale data never refuses). **Evidence does NOT feed `buildSettledByOrigin`/`buildPayersByOrigin` (security review 2026-09-02, MED, fixed the same day):** the fold attributed a payTo's credits to every origin whose OWN manifest advertises that payTo, and those maps feed the BASE router gate, whose only belt (`provenPayToMatches`) binds a Base address - a fresh origin naming a heavily-paid third-party Solana payTo cleared the Base floor and would have been paid at its own Base address. Solana proven-ness is read from the chain at pay time against the accept's own payTo; the board only primes that read. Pinned from source in test-dispatch-eligibility.
  `GET /api/solana-leaderboard`: counts only, self row flagged, `stale`, `scannedAt`, `rpcCallsLastScan` - never the
  RPC's error text (stripped from public rows). `SOLANA_LEADERBOARD=off` disarms. The egress meter
  (`/__operator/egress.json`) is how the cost is read; its PLUMBING regex now skips the drain-aware and
  facilitator-diagnostics fetch wrappers (every host read as `drain-abort.js` within an hour of that wrapper shipping).
  First live scan (14:56Z): 357 payTos, 80 active, ten past the cap (glim, Nansen, svm402, 0x, blockrun, Oblique, Laso 61
  payers, Bitrefill 213 payers) - "Solana is one wallet" was a 15-hour reading; it is not. `scripts/test-solana-leaderboard.js`
  (29, offline stub RPC; incremental cost pinned per cycle; mutation-checked on the cursor + dedupe).
- **SOR widened to dynamic-priced MPP sellers + Bazaar quality (2026-08-19, build #9):**
  `tempoCatalog` now admits `payment.dynamic` / non-integer-amount tempo/charge USDC.e endpoints
  (~185 registry endpoints) as candidates with `priceUsd:null, dynamic:true`; `rankTempoResources`
  ranks them AFTER in-cap fixed-price peers of equal score; `resolveExternalSeller` (server.js)
  prices a dynamic candidate from its LIVE 402 tempo/charge offer (`liveTempoPriceUsd`, mppx
  codec) and skips it when over the tier cap or unreadable - never "choose now, learn the price
  at pay time"; payTempo re-checks the same cap before signing. **Bazaar quality:** the Bazaar
  feed's per-resource `quality{l30DaysTotalCalls,l30DaysUniquePayers,lastCalledAt}` is folded per
  origin (calls summed, payers MAX - a seller-level unique count is unknowable from per-resource
  counts) into `bazaarQualityByOrigin` (x402-index.js; `bazaarQualityFor`/`bazaarQualityEntries`),
  exposed as `bazaar` on index-snapshot sellers and on `/api/route?include=external` EXTERNAL rows (routeQuery; `/api/find` returns local tools + `relatedSellers` without it), used as a routeQuery
  tiebreak after health (more distinct payers first), folded as MAX into the SOR gate's
  settled/payers evidence (buildSettledByOrigin/buildPayersByOrigin), and shown on the market
  seller card as "Coinbase Bazaar, last 30 days (their measurement, not ours)". `curated` is NOT
  ingested: it only appears on curated items in the Bazaar SEARCH endpoint (the bundles endpoint
  needs auth), so it cannot be bulk-enumerated keylessly. `scripts/test-bazaar-quality.js`,
  `test-tempo-router.js` (41). **Bazaar listing copy (2026-08-19):** the 402/Bazaar description was a
  hard 250-char slice (every flagship cut mid-sentence on the live listing); now `bazaarCapDescription`
  (500-char Bazaar cap, sentence/word boundary, never "...") for all routes, and `BAZAAR_DESCRIPTIONS`
  (payments.js, by slug) carries purpose-written what+when copy for the 15 flagships - Bazaar/402
  only, the catalog description (llms.txt/MCP/find) is untouched. `scripts/test-bazaar-descriptions.js`
  (95, in CI against the booted server).
- **Security + cost review of the 2026-08-19 builds (same day, four lenses: leaks / free upstream /
  spend bounds / live claims; fixes in PR #838):** HIGH `:online` was accepted on the NEW Messages +
  Responses wires (chat refused it) - `refuseCostVariants()` is now shared by every wire; HIGH a
  Tempo-settled request honoured an UNSIGNED `PAYMENT-SIGNATURE` riding alongside the tempo credential
  (dispatcher skips x402 verification once the tempo gate accepts; `payerFromRequest` read the forged
  `authorization.from` = memory/my-usage identity takeover for $0.001) - the gate now deletes
  `payment-signature`/`x-payment`/`payment-identifier` on acceptance AND identity-bound routes refuse
  Tempo at the binding check + get no tempo challenge (`priceFor` carries `identityBound`;
  test-mpp-tempo-shim cases J/K). MED: relay error BODIES were relayed verbatim into buyer-facing RFC
  9457 `detail` (our gate + tollbooth) - buyer gets mppx message + relay CODE only (`buyerReason`,
  tollbooth `relayFailure` vs `relayFailureDetail` for the log); the Tempo transfer feed's `lastError`
  (public on /api/mpp-leaderboard) is redacted + code-only (test-leaderboard-redaction covers the MPP
  board); Responses `function_call_output.output` arrays go through `probeParts` (input_file/images);
  per-block `cache_control.ttl:"1h"` refused on chat+Messages (`checkBlockCacheControl`, tools too);
  Responses/Messages `tool_choice` shape-checked; gpt-4o-mini images priced at ~48k tokens in the clamp
  (`imageTokensFor`: OpenAI bills 4o-mini image input ~33x 4o's token count). ACCOUNTING: a settled
  call paid by OUR wallets (heartbeat token on a USDC/Tempo request: canary, tempo-volume) used to bump
  viaUSDC/viaMPPWire/the chain split - now `viaUSDCInternal`/`viaMPPWireInternal` + heartbeat series
  (`recordServedCall(..., {internal})`, test-stats-internal-paid); `/api/revenue/mpp` derived
  "external" from the 30 NEWEST rows (all ours once volume ran) - now all-time GROUP BY network x
  internal, external hashes first (`qMppTotals`); MPP leaderboard totals exclude the self row
  (`selfTransfers`). BOUNDS: the transfer feed folds payer detail only for rankable recipients + self
  and keeps other addresses 48h counts-only (was every chain-wide address for 31 days, ~22MB JSON and
  linear in chain volume; `track` set, async persist); grounded tier `maxAttempts: 2` (each attempt
  re-bills the $0.007 search); rerank refuses past ONE Cohere search unit by an o200k chunk estimate
  (CJK at ~1 token/char reached 2 units under the char caps); tempo-volume: `if: always()` on the
  alert step, unreadable balance refuses (exit 2), count validated + capped 1000/run, bucketed
  balances in the public log/issue; Algorand rail sweep bare requests got the heartbeat single-retry
  (16 "tool failures" on run 32288638827 were the deploy switch 19:19-19:21; the other 3 were
  Blockscout upstream 500s, not charged). Images `usage.cache_discount` stripped; SSE scrubber matches
  `data:` with no space. (Accepted residuals from this review are in CLAUDE.local.md.)
- **Human front door + report products + recurring engine (2026-08-21):** `src/human-checkout.js`
  (Stripe Checkout for the premium report products, `/reports`, `POST /api/buy`, `/r/:sessionId`; no
  report without a Stripe-verified paid session, generate-once cross-replica, auto-refund on failure),
  `src/stripe-subscriptions.js` (Phase 2a: `MONITOR_PRODUCTS` domain-monitor + fund-monitor $5/mo,
  subscription-mode Checkout, durable subscriber store, signature-verified webhook, Customer Portal;
  `/monitors`, `POST /api/subscribe`, `/monitors/thanks`, `/monitors/manage`), and **Phase 2b
  `src/monitor-scheduler.js`** (fulfilment: 10-min tick, unref'd, first tick +90s; per active sub -
  domain: welcome report on first sight, FREE daily re-probe via `probeDomain()` (the SAME grade
  stage the paid handler uses, exported from domain-audit-kit, no LLM) with a security-facts
  fingerprint, full paid re-run on change / cert <= 14 days (once per cert) / every 30 days, 12h
  anti-flap gap (alert-only email inside it); fund: manager resolved once, daily `latest13fFiling()`
  (one EDGAR submissions read), full report only on a NEW accession which advances only after
  success; MAX 10 paid reports per tick, 1h-doubling-to-24h backoff per sub with no email on failure,
  a failed change-run restores the old baseline so the retry re-detects; shared-store lock in
  `/data/monitor-runs.json` so one replica ticks; reports served at `/m/:id` (the id is the bearer,
  same viewer as `/r/`) + `/api/m/:id`; `/monitors/manage?report=<id>` reaches the portal; email via
  `sendMonitorEmail` (ZeptoMail). Ops: `GET /__operator/monitors.json`, `POST /__operator/monitors/run`
  (`?sub=<id>` forces one; heavy-limited). `MONITOR_SCHEDULER=off` disarms the timer. Rollout switch
  for all of it = `STRIPE_SECRET_KEY`. `scripts/test-monitor-scheduler.js` (35, offline, in CI).
- **Security + cost review of the report products / human front door / recurring engine (2026-08-22,
  three adversarial lenses - leaks+auth, money-safety, spend-bounds+abuse - same recipe as 08-19):**
  HIGH a canceled subscriber re-activated themselves by reloading the thanks page (`recordFromSession`
  hardcoded `active`; the Checkout Session stays paid forever) - status now comes from the live
  Subscription object, a replayed `checkout.session.completed` never overwrites a terminal status, and
  the scheduler calls `refreshStatus` BEFORE every paid run. HIGH a deploy mid-generation stranded a
  paid one-shot as "generating" forever (charged, no report, no refund) - human-checkout is now one
  atomic file per session (legacy single-file store imported once), a claim older than 10 min with no
  local job is taken over ONCE (then refunded), a boot sweep re-drives abandoned claims, owed refunds
  (refund call failed) are persisted + retried + listed at `GET /__operator/human-checkout.json`, never
  reported as refunded. HIGH long-running composites (2-4 min, settle-after) were advertised on SVM
  (recent-blockhash ~60-90s), default AVM (~28s) and Tempo (client-bounded credential): work done, never
  charged - `def.longRunning` => EVM exact only (`acceptsForItem`), no Tempo challenge/binding, AVM
  SLOW_TOOL_SECONDS 300 (card/SPT unaffected). MED the monitor report id doubled as the Customer Portal
  bearer on a page we tell subscribers to share - the manage link is now `?report=<id>&k=<HMAC(report)>`
  derived from STRIPE_SECRET_KEY, carried only in the subscriber's email, and the report JSON carries no
  portal bearer. MED unlimited Stripe-API amplification on `/api/r/`, `/api/monitors/confirm`,
  `/monitors/manage` - per-IP `sessionReadLimiter` (per-minute cap in CLAUDE.local.md) + 60s/10s negative caches for unknown/unpaid
  ids. MED composite guard: key falls back to Tempo payer / client IP (nobody unkeyed), counts only 402
  and 5xx (4xx input errors no longer block a wallet), plus a GLOBAL breaker (N unsettled runs in a window
  => 503 pause on all composites, `COMPOSITE_GUARD_GLOBAL_*`; numbers in CLAUDE.local.md). MED thin-evidence reports sold at full
  price - research needs >= 1/3 of its searches, token-risk needs token OR holders (source alone is not
  a risk report). MED monitor targets validated at checkout (`validateTarget`: domain parses, manager
  resolves on EDGAR) and a target failing 5x tells the subscriber ONCE (`problem` email) - no silent
  billing; per-sub cap on paid runs per 30d (then alert-only; number in CLAUDE.local.md); fingerprint excludes TLS issuer/valid-to (CDN
  rotation is not a security change; expiry alert still fires). Accounting: card sales + paid
  subscription invoices now land in the sales ledger (rail `card`, network `stripe`, wire
  `stripe-checkout`/`stripe-subscription`), every composite run emits PostHog `composite_usage`
  (upstream vs price; running totals in the operator JSON), and human/monitor runs carry a per-buyer
  upstream `user` id. LOW: Stripe error text no longer relayed to buyers (SDK errors carry their own
  statusCode - relay only our own 4xx), inputs >500 chars chunked across metadata keys (Stripe cap),
  email subjects control-char-stripped, report viewer escapes quotes + CSV formula-prefix, `Object.hasOwn`
  on product keys, `human-checkout`/`stripe-subscriptions` stores write tmp+rename (merge-on-save).
  Prod runs ONE replica (Railway `numReplicas: 1`), so the cross-replica lost-update class is theoretical;
  the file stores are now safe for it anyway. Tests: test-human-checkout (39), test-stripe-subscriptions
  (28), test-monitor-scheduler (41), test-composite-guard (16, incl. EVM-only accepts + global breaker).
- **Recall watch + IPO watch (2026-08-22):** `src/tools/recall-report-kit.js` (`recall-report` $3, POST
  `/v1/recall-report {query}`: free openFDA drug/food/device enforcement probes -> grounding-strict Opus
  synthesis, records appendix; `probeRecalls()` exported - the monitor's free daily probe, fingerprint =
  recall numbers; `allowEmpty:true` lets a welcome report find nothing yet; WALLET_ONLY, composite-guarded,
  METERED) and `src/tools/ipo-report-kit.js` (`ipo-report` $0.05, POST `/v1/ipo-report {days, keyword}`:
  DETERMINISTIC S-1 + 424B4 digest from EDGAR full-text search, no LLM; `probeIpos()`; WALLET_ONLY for
  egress, not composite-guarded). Monitor kinds in `monitor-scheduler.js`: `recall` (daily probe, paid
  re-run + "recall" email only on a NEW recall number, seen-set advances after success) and `ipo`
  (weekly "digest" run, no email on an empty week). Products: `recall-monitor` + `ipo-monitor` ($5/mo) in
  MONITOR_PRODUCTS, `recall-report` ($3) in HUMAN_PRODUCTS + `/reports` card. Adding a monitor kind =
  kit with a cheap `probeX()` + a `processX` branch + MONITOR_PRODUCTS entry + email reason.
- **Insider flow + market brief (2026-08-22):** `src/tools/insider-flow-kit.js` (`insider-report` $4, POST
  `/v1/insider-report {ticker|cik, days}`: Form 4 filings against the issuer via EDGAR full-text search,
  each filing's XML fetched (`fetchXmlText`, concurrency 4) and PARSED (`parseForm4`: owners/roles,
  non-derivative transactions with code/shares/price/owned-after, 10b5-1 footnote flag) -> open-market
  buys/sells vs awards/exercises/withholding, per-insider + net flow -> grounding-strict Opus synthesis,
  transactions + insiders appendix; `probeInsiderFilings()` = the monitor's cheap daily probe
  (fingerprint = accession set); `insider-monitor` $5/mo, kind `insider`, "filing" email on a new
  accession). `market-brief` ($7, POST `/v1/research/market-brief`) = the research-deep pipeline with a
  competitive-intelligence `planFrame` + fixed `synthFrame` (RESEARCH_TIERS supports both). Both in
  WALLET_ONLY, composite guard, METERED, test-all NETWORK, HUMAN_PRODUCTS + `/reports` cards. EDGAR
  primitives (`resolveCompany`, `eftsSearch`, `fetchXmlText`, `edgarGetJson`) are now exported from
  edgar-kit for the composite kits. **`PAYING_RAILS` now includes `card` + `credits`** - Stripe card
  sales/subscription invoices were recorded with rail `card` but not counted as paying, so the human
  front door was invisible to `/revenue` (caught 2026-08-22).
- **Prepaid card credits (2026-08-22, `src/credits.js`):** buy $20/$50/$100 by card
  (`/credits`, `POST /api/credits/checkout`), claim the key ONCE on `/credits/thanks` (`GET
  /api/credits/claim?session=`; a second claim returns `claimed`, never the key; emailed too), spend it on
  any priced catalog route with `Authorization: Bearer a402_…` - the GATE (mounted before x402mw next to
  the tempo/stripe gates; dispatcher bypasses x402 for `req.creditsSettling`) authorizes against the
  balance BEFORE the handler and DEBITS only on a final 200 (integer micro-dollars, sub-cent exact;
  `X-Credits-Balance` header; 402 `{reason, balanceUsd, topup}` on insufficient/unknown/disabled).
  Keys stored hashed (sha256) in per-key files under `/data/credits` (atomic), claim-once index.
  Accounting: pack purchase = row `credits:<pack>` on the NON-paying rail `card-prepaid` (cash received);
  each debit = sale on rail `credits` (PAYING_RAILS) with the key id as payer - counted once, when spent;
  the gate RESERVES the price at authorize (hold) and settles on a final 200 / releases otherwise, so
  concurrent calls can never overspend a key; debit fires on "finish" only (a client abort releases); stats `viaCredits`; the route binder skips its own recordSale
  for credits (onDebit books the exact charge). Ops: `GET /__operator/credits.json` (totals + key ids,
  never key material), `POST /__operator/credits/disable {keyId}`. `GET /api/credits/balance` (Bearer).
  Linked from footers, mobile menu, homepage people door, llms.txt, sitemap. `scripts/test-credits.js`
  (26, in CI). **Stripe Tax:** `STRIPE_AUTOMATIC_TAX=true` adds `automatic_tax` to every Checkout Session
  (one-shot, subscription, credits) - enable Stripe Tax in the dashboard FIRST or sessions 400.
- **Brand marks + packages on the new system (2026-08-22):** `/logo.svg|png`, `/favicon.svg|ico`, `/card.svg|png`
  (homepage OG card, letterboxes to GitHub's 1280x640), per-tool `/tools/:slug/card.png` and the AIFI card
  (`src/aifi-card.js`) all render in the obsidian + milled system with embedded Geist / Geist Mono (woff2 from
  `assets/fonts`); `BRAND` in server.js is the token set (`BRAND_DEFS` carries the milled/panel gradients).
  `agent402-mcp` 0.13.0 and `agent402-client` 0.7.0 accept a prepaid credits key (`AGENT402_CREDITS_KEY` env /
  `{ creditsKey }`) and pay wallet-only tools by card through it; `/reports` cards link each product's
  `/tools/<slug>` page as "Sample output + API docs".
- **Security + cost review of the 2026-08-22 builds (dark theme, new products, credits, brand; three lenses + PMF):**
  HIGH credits gate bypassed x402 but left unsigned `payment-signature`/`x-payment` in place - a $0.001
  credits call could forge `authorization.from` on identity-bound routes (memory/my-usage takeover) - now
  the gate REFUSES identity-bound routes (`priceFor` carries `identityBound`, 402 `identity-bound`) and
  STRIPS the three payment headers on acceptance (same as Tempo/Stripe gates; pinned in test-credits).
  HIGH authorize-then-charge had no reservation (N concurrent calls on one key all passed; only
  floor(balance/price) debits landed) - authorize now HOLDS the price, settle() converts the hold on a
  final 200, release() returns it otherwise; the debit fires on "finish" only (Node's default statusCode
  is 200 before any write, so a client abort was being charged). HIGH `/revenue` double-counted credits
  (pack purchase on rail `card` AND debits on rail `credits`) - packs are now `card-prepaid` (non-paying,
  cash received), debits stay `credits`. MED the 30-day paid cap applied to domain only - every kind now
  caps (alert-only + seen-set advance past it); a prompt-cache hit releases the hold (x402 buyers get
  hits free); `charge.refunded` / `charge.dispute.created` disable the key (`disableByPaymentIntent`);
  `allowEmpty` honoured only for the scheduler's own calls; insider needs >= 50% of Form 4 filings read,
  recall >= 2 of 3 feeds; openFDA `OPENFDA_API_KEY` support (keyless shares a per-IP daily cap); credit packs also
  mint from `checkout.session.completed`. Leak scan: a public example attributed invented figures to a
  real Form 4 filer - anonymized; "roadmap/phase" framing dropped from public text (the remaining "Phase 2"
  comment labels and "moat" wording in served copy were removed 2026-08-27). (Replica notes in CLAUDE.local.md.)
- **Payer attribution (`src/payer.js`):** `payerFromRequest` reads only the signed EIP-3009
  `authorization.from` — memory identity depends on it, never weaken. `payerFromPaymentResponse`
  (facilitator settle-receipt `payer`) is the fallback for SVM/Stellar, telemetry/sales only.
  Never lowercase base58/Stellar addresses (EVM only).
- **Deploy safety (live-buyer protection):** deploy job runs `scripts/deploy-quiet-gate.js`
  BEFORE the Railway variable upsert (the upsert itself can trigger a redeploy) — polls
  `/api/stats` `recentCalls`, waits for 180s with no external USDC call (heartbeat/PoW never
  block); fail-open on stats-down, sustained traffic past `QUIET_GATE_MAX_WAIT` (repo var,
  default 1200s), or repo var `QUIET_GATE=off`. **Var-upsert race (measured 2026-08-05):**
  an upsert that introduces NEW variables makes Railway auto-redeploy the PREVIOUS build,
  which races the workflow's SHA-pinned deploy (lost by 56ms; the pinned deployment ended
  REMOVED and prod served stale code with the new vars — healthy, wrong version).
  Unchanged-value upserts are no-ops and never race. When adding deploy-injected
  variables: expect the first [deploy] run to fail at "deployment ended REMOVED", verify
  prod health, then push a second [deploy] (vars now pre-exist, cannot race) — or
  pre-create the variables before the code ships.
  **ANY variable WRITE does this, not just a new key, and the build it falls back to is
  MAIN's HEAD (measured 2026-08-23):** changing `GATEWAY_METERED_BILLING` from `on` to
  `off` on a service running a SHA-pinned dev-branch build silently rolled prod back to
  the last main-branch deploy — the pinned deployment went REMOVED and prod served code
  four commits older, healthy, with no failure anywhere to notice it. Railway redeploys
  the CONNECTED BRANCH's head, and that is `main`; a dev-branch build only exists because
  the workflow pinned it. So a flag flip on a dev-branch build is a rollback with extra
  steps. Either merge to main first, or set the variable BEFORE the [deploy] job runs its
  pinned deploy (during the test job is safe — the pinned deploy then carries both), and
  re-read `/health` `build` afterwards rather than assuming the flip was inert. Deploy also sets
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=120` — Railway's default SIGTERM→SIGKILL grace is **0s**,
  so without it the server's graceful drain never runs. Drain (`src/server.js` shutdown):
  `closeIdleConnections()` sweep every 5s + 75s hard deadline (covers transcribe's 60s
  upstream timeout). **The service is volume-backed, so Railway stops the old container
  BEFORE starting the new one (no overlap possible, `overlapSeconds` inert; verified from
  container logs 2026-08-25): every deploy has a ~60-90s no-container window, and any
  "keep serving after SIGTERM" logic only lengthens the deploy by exactly its own duration
  (the 08-24/25 lame duck took deploys to 16 min measuring its own setting as "Railway's
  gap"). Drain immediately; `scripts/test-drain-on-sigterm.js` pins it.** While draining, a composite report
  route (`EXPENSIVE_COMPOSITE_SLUGS`) is refused 503 by a global middleware before any gate
  (`test-drain-refuses-composites.js`), so a 4-minute run is never started into the deadline; the worker
  (`worker/server.js`) has the same close-then-deadline drain. Boot instrumentation (`[boot]` lines: per-step
  event-loop hold after listen + worst 60 s stall) exists because prod shows ~18 s with a bound listener
  answering nothing - read the next deploy's log before guessing.
  **In-flight composites are CUT OFF on SIGTERM (2026-09-02, `src/drain-abort.js`):** the drain refused to START a
  composite but could not stop one running, so a report (30 s-4 min of OpenRouter/Brave/EDGAR calls) ran to the 75 s
  deadline with the money spent and no 200 ever written - pure loss on every deploy that caught one. Now a composite
  runs in an AsyncLocalStorage scope (the dispatcher for `EXPENSIVE_COMPOSITE_SLUGS`, and `_humanGenerate` for card/
  monitor runs) and a global fetch wrapper joins the process-wide drain signal (`AbortSignal.any` with the caller's own)
  onto every outbound call made inside it; `shutdown()` aborts the controller right after `draining = true`, every
  waiting upstream call rejects, the handler throws, the route answers 503 with a retry-in-a-minute message (never
  charged), and the process can exit as soon as the socket closes. A fetch outside a scope is untouched, so an ordinary
  in-flight request still completes after SIGTERM (test-drain-on-sigterm). Honest bound: a generation already finished
  upstream is billed anyway; the abort saves every call not yet started or still generating. `scripts/test-drain-abort.js`
  (offline + four source pins), in the pricing lane.
  **Railway service settings, set to what they should be 2026-08-25 (dashboard state, not in the repo):** `agent402`
  runs ONE replica in us-west2 (`railway scale --service agent402 --environment production us-west2=1`; the
  dashboard had drifted to 2, which with a single volume only doubled boot cost) and `RATE_LIMIT_REPLICAS=1`
  (it was 2, which silently HALVED every shared rate-limit quota - the limiter divides by replica count);
  `agent402-worker` has App Sleeping ON (secretless render worker, idle between renders, ~0 cost while asleep -
  first render after sleep pays a cold start); `healthcheckTimeout` 60 on both. **Any of these writes redeploys
  MAIN's head** (the var-write race above applies to `railway scale` and MCP `update-service` too - the
  2026-08-25 scale call produced a second deploy that swapped prod mid-CI-sweep and failed three self-targeting
  examples: a2a-card-fetch, x402-quote, x402-audit all fetch agent402.tools). Change settings right AFTER a merge
  lands, never during a CI run. `railway.toml` config-as-code is DEPRECATED by Railway in favour of
  `.railway/railway.ts` (grace until 2026-12-01, hard cutoff) - `railway config migrate` is the one-command path, but
  read the dry run first: it emits only healthcheck/timeout/replicas and DROPS `restartPolicyType`,
  `restartPolicyMaxRetries` and `overlapSeconds` (the IaC DSL has no field for any of them). Measured 2026-08-29 and
  already handled: healthcheckPath, healthcheckTimeout and the us-west2 replica count were already set at the SERVICE
  level and survive the cutoff on their own; the restart policy lived only in the toml, so `ON_FAILURE` + 5 retries are
  now set on the service in production (that write did NOT redeploy - Railway applies it on the next deployment, and
  prod stayed on the same build); `overlapSeconds` is inert on a volume-backed service. The service's build config
  reads `builder: RAILPACK`, which is a DEFAULT LABEL and not the builder in use - Railway's docs: "Railway will always
  build with a Dockerfile if it finds one", the build log confirms ours runs, and that does not depend on the toml, so
  the Dockerfile ENTRYPOINT (the root->node privilege drop) is safe past the cutoff and needs no builder setting.
  **The app killed its own Postgres init at every boot, and nothing paged (found 2026-08-25):** both
  `[leads-db]`/`[analytics-db] init failed: Connection terminated due to connection timeout` lines share ONE
  millisecond with the "listening" line, and a TCP probe a second later connects in 10 ms on v4 and v6 - the
  event loop was blocked. Init fired at module top level and pg's 8 s handshake timer expired inside the ~10 s
  post-listen stall (@x402/express per-route Ajv compile); one deploy in a row won the race by luck. Postgres's own
  log (`last known up at 2026-07-02`) is consistent with the app not connecting since then, and the app degrades
  quietly when the databases are gone (leads + tool-call analytics stop being recorded, buyers unaffected), which
  is why it went unnoticed. Now: `initWithRetry` (`src/db-init-retry.js`: 20 s / 60 s / 5 min after each failed
  attempt, timers unref'd, `no-db` never retries) boots both databases; `connectionTimeoutMillis` 8 s -> 20 s so
  the handshake outlives the stall; `analytics-db`'s permanent `unavailable` latch (one failed init = off until the
  next redeploy) is a 5-min backoff on the per-call path, and an EXPLICIT init resets it and never reports ok
  without a pool; `/api/gateway-status.databases` (`src/db-status.js`: live `SELECT 1`, 5 s timeout, 60 s cache,
  STATUS WORDS ONLY on the public surface) + heartbeat leg "Postgres UNREACHABLE (leads/analytics)";
  `src/db-probe.js` (#937) logs family/port on init failure, no credentials. `scripts/test-db-status.js` (17) and
  `test-db-init-retry.js` (16), in CI. Verify on the next deploy: `[leads-db] ready (attempt 2)` or a first-attempt
  `ready` in the boot log.
- **AVM validity guard (`src/avm-validity.js`):** Algorand payments are rejected 422
  BEFORE the handler when the signed txn's validity window can't outlive the tool
  (settlement is post-handler, so a dead txn = buyer refunded but our upstream spend
  burned — proven by image-gen-premium vs algokit's 10-round/~28s default window).
  Default requirement 20s (under the default window, normal tools unaffected);
  `SLOW_TOOL_SECONDS` maps the slow slugs (image-gen-premium 90). Round anchor from
  `ALGORAND_ALGOD_BASES` (5-min cache), fail-open on any decode/algod failure.
  `scripts/test-avm-validity.js` (offline, in CI).
- **STT margin cap (`src/tools/stt-kit.js`):** per-tier `maxMinutes` (5/10) is enforced
  locally via a `music-metadata` duration probe BEFORE any OpenAI spend — upstream bills
  per audio minute (~$0.003 mini / ~$0.0045 gpt-transcribe), so the cap is the margin
  bound, not a UX nicety. transcribe-pro rides `gpt-transcribe` since 2026-08-04
  (OpenAI's 2026-07-28 release, 25% under the old gpt-4o-transcribe rate). Unreadable
  duration → 422 (an unreadable container would be an unbounded upstream bill).
  `assertWithinDurationCap` / `probeDurationSeconds` exported for `scripts/test-stt-cap.js`.
- **2026-08-04 upstream-model sweep** (verify against live sources before repeating —
  model catalogs move): image-gen + image-gen-hd migrated `gpt-image-1-mini` →
  `gpt-image-2` (OpenAI retires 1-mini **2026-12-01**; hd and premium now differ in
  prompt cap only — premium differentiation is an open pricing decision). Gateway
  `AUTO_RANKINGS` refreshed: `google/gemini-2.0-flash-001`/-lite VANISHED from
  OpenRouter (the old fast band led every category with the dead id, burning a failed
  round-trip per routed call — live-verify ranked ids when touching the table);
  `openai/gpt-5.6-luna` ($0.10/$0.60) + `gemini-2.5-flash-lite` entered; new tier
  prefixes gpt-5.6 terra/sol, gemini-3.x, laguna; `MODEL_COST` prices
  `claude-sonnet-5` at STANDARD $3/$15 (intro $2/$10 dies 2026-08-31 — never enter
  intro rates). Two gateway guards added in the same sweep: buyer `tools` entries were limited to
  `type:"function"` because server tools had no spend bound; that is NO LONGER the whole
  rule - see the server-tools entry below, and an EMPTY
  safety-refusal 200 (finish_reason `content_filter` / native `refusal`, no content —
  Claude-5-class models) walks the failover chain instead of reaching the buyer as a
  paid empty answer; a chain refusing end-to-end surfaces 502 (settlement cancelled).
- **Offsite /data backup (`src/backup.js`, 2026-08-05):** nightly gzip'd copies of
  the volume's SQLite/state files to a Railway Bucket (Tigris S3, path-style,
  hand-rolled SigV4 — no SDK dep; bucket `agent402-backups`, creds ride the
  DEPLOY JOB's quiet-gated upsert as `BACKUP_S3_*`, all-four-or-nothing). Cost
  is BOUNDED BY DESIGN: date-keyed objects (same-day rerun overwrites),
  `BACKUP_KEEP_DAYS` (14) prunes old date prefixes every run,
  `BACKUP_MAX_RUN_MB` (512, compressed) holds over-budget files VISIBLY in
  status, and `BACKUP_MAX_TOTAL_GB` (20) is a bill guard that refuses uploads
  outright when the bucket exceeds it. Cache-like files (*cache*, wal/shm,
  tmp) excluded — they rebuild. SQLite staged via better-sqlite3's online
  backup API (consistent under live writers), scratch space in container tmp
  (never /data). Ops: `GET /__operator/backup.json` (status + inventory,
  works pre-creds), `POST /__operator/backup/run` (heavy-limited). Scheduler
  fires once per UTC day at `BACKUP_UTC_HOUR` (4), timer unref'd, no-op
  without creds. Restore = download object, gunzip, replace file, restart.
  `scripts/test-backup.js` (28 assertions, stub S3 + real sqlite, in CI);
  signer proven live against the real bucket 2026-08-05 before first deploy.
- **Facilitator RPC failover (2026-08-26, `facilitator/rpc-failover.js`):** the facilitator's recurring failure was an RPC
  STALL before submission on the configured provider (08-14, 08-19, 08-26: `/settle` timed out, nothing on-chain). Now
  every `rpc.Server` method that fails at the TRANSPORT level (timeout / connection error / 5xx / 429 / body-less
  response) is retried once on each URL in `FACILITATOR_RPC_FALLBACK_URLS` (default pubnet:
  `mainnet.sorobanrpc.com`, `rpc.ankr.com/stellar_soroban` - keyless, probed live; testnet: `soroban-testnet.stellar.org`;
  `off` disables). A JSON-RPC error is an ANSWER and is never retried; a fallback instance never recurses; each hop
  inherits the per-request timeout; the primary's error is what the caller sees when every node fails
  (`fallbackErrors` attached). Installed LAST at boot so it wraps the timeout + diagnostics patches. Same prototype
  seam as rpc-timeout.js (@x402/stellar builds its own rpc.Server per call). OpenZeppelin as PRIMARY was tried the
  same day (canary run 33001317156): `unexpected_verify_error` at their verify step, nothing on-chain - reverted; OZ
  stays the settle fallback only. Tests in `facilitator/test.js` (real rpc.Server against local stall/answer servers).
- **Stellar confirm by the named hash (2026-08-28, `settleTxOf` + `confirmByHash` in stellar-confirm.js, test-stellar-confirm 37):** the
  facilitator's timeout body now carries `transaction` when something was submitted before its bound, so `settleWithStellarFallback`
  hands `{payer, txHash}` to confirm and `confirmStellarTransfer` checks THAT transaction first (`/transactions/<hash>` successful +
  an `account_credited` effect to our payTo in USDC, polled for the wait window) - exact, no payer window, the same-buyer-window
  ambiguity structurally avoided; the payer scan remains the fallback when no hash was named.
- **Facilitator: hedged reads + poll cap + 25 s settle bound (2026-08-28, after paid-canary run 33183770242):** the Stellar leg failed
  with `[/settle] dispatch error: TimeoutError: settle timed out after 60000ms`, NO failover line, NO submission and nothing on-chain
  (Horizon checked) - the primary (Alchemy) was answering, just slowly, so the 10 s per-request bound and the transport-only failover
  never fired while six to ten pre-submit reads ate the budget; and the vendor's post-submit poll runs `requirements.maxTimeoutSeconds`
  attempts (we advertise 300), so once submitted only OUR timeout ends it. Now: `installRpcFailover(..., { hedgeMs })` (default 3 s,
  `FACILITATOR_RPC_HEDGE_MS`) also sends a read still silent past the delay to the first fallback, first ANSWER wins (JSON-RPC error =
  answer; transport failure waits for the other side; sendTransaction never hedged; `shouldHedge`); `settle-poll.js` caps
  `pollForTransaction` at `FACILITATOR_MAX_POLL_ATTEMPTS` (8), logs `[settle-poll] submitted <hash>... polling up to N` and the
  outcome with elapsed ms, and hands the hash to `/settle` via AsyncLocalStorage so a timeout body carries `transaction`; the settle
  bound is 25 s (was 60 s; the CALLER gives up at 30 s, so the old bound could only ever reach it as a bodiless timeout); every settle
  logs `settled|not settled in Nms tx ...`. `decodeErrorResult` reads the SDK's parsed `errorResult` object (sdk >= 13) as well as the
  legacy `errorResultXdr` string (the 08-27 "(no errorResultXdr in response) otherKeys:[errorResult]" line). facilitator/test.js 59
  offline pins. The facilitator redeploys ONLY on `facilitator/**` changes and has its own lockfile: a root Dependabot bump never
  touches it (verified 2026-08-28 while diagnosing this; the same-day mppx/viem/algosdk bump was cleared by a canary rerun).
- **Four skill packs were SOLD and structurally unimplemented (2026-08-31, `scripts/test-skill-pack-steps.js`):** `earnings-deep-dive`,
  `options-analytics`, `fixed-income-desk` and `defi-protocol-scanner` were in `SKILL_PACKS` with prices, catalog entries and live
  tool pages, and had NO `PACK_STEPS` entry - so `getStepConfig` fell back to the stub whose every `mapInput` throws `todoError()`,
  and each call returned **HTTP 200 with "0/N steps succeeded"**, deterministically, for every buyer, **2026-07-08 to 2026-08-31**.
  61 settlements at $0.05; most were our own canaries (the burner set is listed in CLAUDE.local.md) but
  ~5 were outside wallets in neither `OUR_WALLETS` nor `OUR_ALGORAND_WALLETS`. **Why nothing caught it: the partial-success envelope
  is a VALID shape whatever the steps did**, so the "answers its own example" sweep (status + documented keys) passed, and three of
  the four are additionally in test-all's Brave skip list so they were never executed at all. Now implemented from each pack's own
  declared `workflow`/`toolSlugs` (options and fixed-income are CHAINS: black-scholes gets the live spot plus a volatility measured
  from that stock's own history via `realizedVolatility`, and the bond is priced at the curve's own 10Y then re-inverted with
  `bond-ytm` to confirm - verified live, AAPL 316.85 -> ATM strike delta 0.49, bond round-tripping to 4.73%). `requireNumber` fails a
  chained step cleanly rather than letting a missing prior coerce to NaN and produce a confident-looking answer built on nothing.
  **A pack where ZERO steps succeed now REFUSES** (`runPack` throws; 400 when every step failed on the caller's input, else 502) so
  settlement is cancelled and nobody pays for an empty envelope - a 200 charges, because @x402/express settles anything under 400.
  Partial success is unchanged and still 200: "the absence is part of the dossier" is about SOME steps failing, never all.
  **`mapInputs` (plural) is new**: a step may offer ordered candidate inputs and the runner tries them until one works. It exists
  because `crypto-dossier`'s `extract` read whichever news site ranked first and **failed 43.5% of the time (37 of 85 runs over 60
  days) while every other step in that pack ran at 100%** - a coin flip on the publisher, charged to the buyer as a missing step; it
  now walks the ranked results and ends on the coin's own CoinGecko page, which is readable. NOT a defect and left alone:
  `decode-blob` reads as 42.9% failed because it throws a blob at seven decoders and a JWT is not gzip/brotli/hex - the misses ARE
  the answer. The guard (in CI, offline, 659 assertions, mutation-killed) pins that every `SKILL_PACKS` slug has a `PACK_STEPS`
  entry, that every step can build its input, and that every step is a tool the pack advertises in `toolSlugs` - the last one is
  what a future retirement cut would otherwise hollow out silently.
  **The refusal immediately found a FIFTH dead pack, which is the point of it:** `openapi-audit` (26 of 26 step calls failed in
  telemetry) HAS a `PACK_STEPS` entry, so the missing-entry guard passed it, and CI only surfaced it once a 0/N answer stopped
  being a 200. Three real bugs: both steps handed the caller's URL to tools that take the DOCUMENT (`spec`: "object or JSON
  string"), `openapi-validate-payload` was missing its required `part` and aimed at a hardcoded `get /` no real spec declares,
  and `openapi-security-summary` was advertised in the pack's own `toolSlugs` and never wired at all. Now `fetchOpenApiSpec`
  (one `safeFetch` through the SSRF guard, 5MB cap, in-flight dedupe so a fan-out is not three fetches of the same spec) plus
  `firstOperation` (the first method+path the spec actually declares); 3/3 on its own petstore example. **Note `safeFetch`
  names the text body `html` whatever the content type is** - reading `body` there made every step fail "not JSON" until the
  return shape was actually inspected. (Follow-up list in CLAUDE.local.md; resolved 2026-09-02, see the entry below.)
- **Skill-pack prices are DERIVED, not declared (2026-09-02, `scripts/pack-prices.js` + `scripts/test-pack-pricing-rule.js` in the
  sweeps lane):** the old `PACK_PRICES` table was a hand-written premium ($0.05-$1.50) with no relation to the tools a pack runs,
  which after the 08-28 floor cuts left packs costing 10x-100x their parts (the operator's decision: option 2). Rule: a pack costs
  the SUM of its advertised `toolSlugs` prices (unique slugs, read from the live `/api/pricing`) minus a 10% bundle discount
  (`PACK_DISCOUNT`), rounded UP to the $0.001 settlement floor (`ceilMilli`, floor `PACK_FLOOR_USD`); range now $0.003 to $0.168.
  `--write` regenerates the table in `src/skills.js` (GENERATED header, one comment per row with tool count + parts); the
  default mode is the CI check (fails on drift or an unknown tool), so repricing a tool means re-running `--write` in the same
  PR. Prices compare as whole milli-dollars (`milli()`) and print with three decimals - the first cut rounded $0.171 to $0.17
  in the table and the check flagged five packs it had just written. `PACK_PRICE_RANGE` (skills.js) derives the range the
  /skills hero and FAQ quote ("How is a pack priced?"), the wiki Skill-Packs rows and the four paid-canary pack legs were
  repriced from the table, and test-skills-index-page pins the derived text. Retire/reprice a tool -> the pack follows.
- **Every tool a pack advertises now RUNS, and a conditional leg can be skipped without being charged (2026-09-02):**
  ten packs listed a tool in `toolSlugs` their `PACK_STEPS` never invoked (structured-scrape/html-meta, ipo-watch/
  search-news, jwt-toolkit/jwt-sign, fx-monitor/fx-historical, page-audit/sitemap, article-digest/search-news,
  content-grade/readability-score, contact-verify/spf-check, trend-analysis/fred-series, markdown-convert/text-diff) - the
  tool page promised it, the buyer never got it. Each now runs it from the pack's own args or a prior step (jwt-toolkit and
  page-audit became CHAINS: jwt-sign re-issues the claims jwt-decode read; sitemap takes the URLs robots-check DECLARES
  first - stripe.com, the pack's own example, has no /sitemap.xml - with the conventional paths as `mapInputs` fallbacks).
  **`step.when(args, prior)`** is new in the runner: false = the leg does not apply to this input and is reported
  `skipped: true` (ok, never a failure, never counted in "N/M succeeded"); trend-analysis uses it so fred-series runs only
  when stock-history served nothing, and every downstream step reads `bakeOffValues(p)` from whichever fetcher served. A
  pack whose every ATTEMPTED step fails still refuses. `test-skill-pack-steps` (760) now asserts the converse rule too:
  every advertised tool is a step (`ADVERTISED_NOT_RUN` must name any justified omission with a reason; it is empty) and
  pins the `when` semantics offline; all ten verified against their published examples on a keyless boot (the two
  Brave-backed legs self-report not-ours there, as designed).
- **Every guard we owned asserted SHAPE, never OUTCOME (2026-08-31, `scripts/test-pack-examples.js`):** the root cause behind nine
  packs selling broken for two months. The example sweep asserts an HTTP 200 and the documented TOP-LEVEL keys, and
  `{pack, args, steps, summary}` is a valid shape whether the steps returned data or all threw - so `0/N steps succeeded` passed
  everything. `tool_call` telemetry is blind the same way (`errored`/`status` both read clean on a hollow 200), three of the dead
  packs sit in test-all's Brave skip list so they never executed at all, and the canary's pack legs did not assert step outcomes.
  **Swept all 85 packs against their own published examples**; beyond the nine already fixed this found `structured-scrape` (its
  three `html-*` steps were fed `render.markdown`, and markdown has no `<table>` or class attributes, so `html-table` could never
  match on ANY page - `fetchPageHtml` now gives them real HTML), `api-investigation` (`api.example.com` does not resolve),
  `tx-forensics` (an all-zero tx hash that exists on no chain, so calldata-decode and selector-lookup always failed - now a real
  immutable Base tx) and `forecasting-bake-off` (`forecast-eval` REQUIRES an explicit `period` for holt-winters even though the
  standalone tool auto-detects, and the standalone cannot auto-detect on daily closes either). ~13 of 85 packs, 15%. The class is
  essentially confined to packs: of 404 non-pack examples returning 200, ONE buries an error the same way. `claudePrompt` strings
  were realigned with the corrected substitutes - the prompt is what an agent copies, so a stale one publishes a second broken
  instruction. **The guard drives every pack with the exact input we publish and requires steps to SUCCEED**; an expected miss
  needs a named reason (`EXPECTED_MISSES`: a JWT is not gzip, a ticker is not a FRED series), key/upstream failures are
  report-only (`NOT_OURS`, the probe-classify doctrine) and so is anything DOWNSTREAM of an upstream-blocked step. Two traps it
  hit in development, both worth keeping in mind for any sweep: it initially **passed while measuring nothing** when the server
  under test had died (now fails under a 50% floor - silence is not success), and driving all 85 packs in CI would have **bought a
  live Brave query on every push**, the CI-spend leak that has recurred three times, so the CI step boots its OWN KEYLESS server -
  keyed packs self-report "not configured" and skip as not-ours, keyless packs are fully verified, and no skip list can drift.
  (Coverage of the keyed subset is noted in CLAUDE.local.md.) It also caught a defect in its own
  author's fix: crypto-dossier's "readable fallback" was the coin's CoinGecko page, which **answers 403 to our fetcher**
  (measured), so it appended a guaranteed-dead candidate - removed, six real search results walked instead.
  **`skill-openapi-audit` moved to `WALLET_ONLY_SLUGS`:** it was pure-CPU and PoW-eligible ONLY because it never actually fetched
  anything; giving it a working caller-supplied fetch made the free tier able to fetch arbitrary URLs. The free-tier egress probe
  caught it on the first CI run after the fix.
- **Stellar settlements bid ABOVE the network minimum (2026-08-31, `facilitator/fee-bid.js`):** the Stellar rail was our only
  unreliable one - 25 up / 15 down over 30 days of canary observations (62.5%) against Base's 40/40 - and every failure reduced
  to ONE cause: `@x402/stellar` builds the settlement transaction with `fee: BASE_FEE` (100 stroops, the network MINIMUM,
  `dist/esm/exact/facilitator/index.mjs:159`) and that is the bid we take into Stellar's fee auction. Horizon `/fee_stats` at
  diagnosis: `ledger_capacity_usage` 0.78, `fee_charged` p90 **9,486**. Losing the auction has TWO shapes and both were read as
  separate mysteries for weeks: the RPC rejects the submission (`rpc-diagnostics` decoded `{"code":"txInsufficientFee"}` ->
  `settle_exact_stellar_transaction_submission_failed`), or it is accepted PENDING, outbid, dropped, and the vendor reports
  `settle_exact_stellar_transaction_failed` after our poll gives up. **Nobody was ever charged** (neither failed hash appears in
  the payer's Horizon history), so this is a rail-proof failure, not a money failure, and **the 08-28 poll cap is NOT implicated**
  - those transactions never landed at all, so polling longer buys nothing; do not widen it chasing this. RAISING THE BID IS
  NEARLY FREE because Stellar charges the auction's CLEARING price, not your bid (same read: `max_fee` p50 67,136 vs
  `fee_charged` p50 100), so the bid is a CEILING, not a cost. `installFeeBid` patches `TransactionBuilder.prototype.build` (the
  vendor imports the class as an unassignable ESM binding and constructs it inline, so the constructor argument is out of reach;
  `baseFee` is an own property read in `build()`) - the same prototype seam as rpc-timeout/rpc-diagnostics/rpc-failover/
  settle-poll. Default `FACILITATOR_INCLUSION_FEE_STROOPS` 50,000 per operation (clears the measured p90 with room, worst case
  0.005 XLM ~= $0.0015); `off`/`0` disables; a MALFORMED value falls back to the DEFAULT, never to disabled, because disabled is
  the old broken behaviour and a typo must not select it. Only ever RAISES, and only from the vendor minimum. Deliberately a
  fixed bid, not a `/fee_stats` read: that would put a network call in the settle path and the clearing-price rule means the
  precision buys nothing. **We configure no `feeBumpSigner`**, so `build()` makes the transaction we submit; if one is ever added
  the fee bump carries its own hardcoded `BASE_FEE` that this patch cannot reach, so `assertFeeBumpUnpatched()` warns at startup
  rather than letting the bid silently revert. `facilitator/test.js` 80 offline pins, incl. that a transaction BUILT at the
  vendor default goes out at the raised bid (reading `this.baseFee` would pass a `build()` that ignored it - mutation-killed) and
  that no nested `@stellar/stellar-sdk` copy shadows the class we mutate (a second copy would leave the fix installed, logged,
  and inert).
- **Stellar facilitator fee account has a low-water alarm (2026-08-31, `src/stellar-facilitator-status.js`):** it pays the fee on
  EVERY Stellar settlement and was the one spending wallet we run with nothing watching it (balance at the time in CLAUDE.local.md). Stellar
  settlement is CHEAP and this is a slow alarm, not an urgent one: observed `fee_charged` is 23,501 stroops = **0.00235 XLM**
  (~$0.0007 at $0.30), so that balance covered thousands of settlements (figures in CLAUDE.local.md). (An
  earlier draft of this entry said 0.0235 XLM and "~250 settlements" - a 10x slip, stroops are 1e7 to the XLM, and the
  dollar figure beside it was right; the alarm's default threshold was sized against the wrong number and lowered
  once it was caught.) Default `FACILITATOR_LOW_BALANCE_XLM` is in CLAUDE.local.md: the point is
  that an empty fee account does not look like an outage, not that the found balance is nearly empty - a threshold that pages with
  thousands of settlements left is an alarm nobody reads. The facilitator already computed it - `GET /health` returns `signerAddress`,
  `xlmBalance` and `low` against `FACILITATOR_LOW_BALANCE_XLM` - and nothing polled it, so this is a bucketed relay
  onto `/api/gateway-status` as `stellarFacilitator` (status words only, never the balance or the address: public surface), plus
  a heartbeat leg "Stellar facilitator fee account LOW (XLM)". Two flattering-failure guards, both pinned: `low:null` (the
  facilitator could not read Horizon) is `unknown`, never `ok`; and because `STELLAR_FACILITATOR_URL` can point at a THIRD PARTY
  (it defaults to one), a 200 from a `/health` that does not carry our own shape is `unknown`, never a fabricated all-clear.
  An empty fee account does not look like an outage - settlements just stop landing and the canary reports a rail failure.
  `scripts/test-stellar-facilitator-status.js` (15, in CI).
- **Facilitator support report (`GET /__operator/facilitators.json`, 2026-08-19, fix #9):** operator-
  authed dump of what each configured facilitator client ADVERTISES (`getSupported` kinds → exact
  networks, extensions) plus `firstTriedFor` (the first client advertising each network = the one
  @x402 tries first). Built because CDP's facilitator table grew (Polygon, Arbitrum, Solana, World)
  and CDP is first in `facilitatorClients`, so it may settle chains the boot-log LABELS attribute to
  PayAI; `/supported` needs a JWT so only the live clients can answer. **Read on prod 2026-08-19:
  CDP (first in the list) now advertises exact on `eip155:137` (Polygon), `eip155:42161` (Arbitrum),
  Solana mainnet AND World Chain (`eip155:480`) - so CDP is the FIRST-TRIED facilitator for Polygon,
  Arbitrum and Solana payments, not PayAI as the boot-log labels imply; PayAI is first only for
  Avalanche/Sei/XLayer/SKALE, Naven for Robinhood, molandak for Monad, Celo/Solvador/our Stellar/
  GoPlausible as labelled.** This is BY DESIGN (the operator, 2026-08-19): CDP is first-order for every chain
  it advertises - CDP-settled payments count toward Bazaar quality and that outranks PayAI's free
  tier; do NOT reorder `facilitatorClients`. Only the boot-log labels/comments that still say "PayAI
  handles Polygon/Arbitrum/Solana" are stale. World Chain (480) is offered by CDP but not in our
  `PAYMENT_NETWORKS` - a 13th rail is one env change away if wanted.
- **Well-known store (`src/well-known-store.js`, 2026-08-05):** operator-published
  domain-verification documents served at `/.well-known/<path>` without a redeploy
  (built for Talkshi's 15-minute domain challenge; covers any serve-a-file-to-prove-
  control flow). `POST /__operator/well-known` `{path, body}` publishes (`remove:true`
  deletes); memory-only, 24h TTL, 16-entry/16KB caps, traversal structurally
  impossible (segment allowlist), reserved names (x402, security.txt, glama.json)
  refused at write AND never shadowed at serve (catch-all `next()`s on miss).
  Never put a challenge's `claim_secret` in the published doc — it stays with the
  operator. `scripts/test-well-known-store.js` (28 assertions, boots the server, in CI).
- **MPP dual-stack shim (`src/mpp-shim.js`, 2026-07-23):** serves MPP (Machine
  Payments Protocol, tempoxyz/mpp — IETF-track "Payment" HTTP auth scheme,
  paymentauth.org) clients from the same routes, with @x402/express keeping SOLE
  settlement authority. Pure header translation: 402s gain `WWW-Authenticate:
  Payment` (one HMAC-bound evm/charge challenge per allowed EVM rail, the
  verbatim x402 accepts entry riding in challenge meta/opaque so inbound is
  stateless + byte-exact); inbound `Authorization: Payment` credentials that
  HMAC-verify are re-encoded as `PAYMENT-SIGNATURE` and fall through — every
  paywall invariant (replay guard, payer attribution, settlement ordering,
  idempotency) reads the same header it always has. The shim mounts BEFORE the
  idempotency middleware so the translated header is the gate credential the
  Idempotency-Key cache binds to — MPP buyers get the same paid-retry replay
  as x402 buyers (proven: one settle across original + keyed replay). Wire
  attribution: `/api/stats` `toolCallsServed.viaMPPWire` (subset of viaUSDC) +
  PostHog `payment_settled.wire` ("mpp"/"x402") — the MPP-adoption signal.
  Settled 200s for MPP buyers
  mirror `PAYMENT-RESPONSE` as `Payment-Receipt`. mppx is used for codec
  primitives ONLY — its request-guard/settle path is never mounted
  (double-settle risk). Rollout switch = `MPP_SECRET_KEY` presence (unset → not
  mounted, pure-x402). `MPP_CHALLENGE_NETWORKS` widens which chains get MPP
  challenges (default Base+Celo — the mainnets in stock mppx clients' asset
  registry; every extra challenge costs ~800 bytes on every 402).
  **AgentCore Payments over this shim (measured 2026-08-28):** an AgentCore/Privy instrument answers our Base evm/charge
  challenge with an EIP-3009 authorization signed under EIP-712 domain name "USDC" v2 - Base USDC's domain is "USD Coin"
  v2 - so CDP verify fails `invalid_exact_evm_payload_signature` (v byte canonical 0x1c: NOT the Tempo v-normalization
  class); the chain would refuse it too, and the mppx evm challenge schema carries no domain fields, so there is no
  way to TELL them the right name. The SAME instrument settles our plain x402 path (tx 0x9b48b7fe…, $0.001 on Base) when
  the 402 it sees has no `WWW-Authenticate: Payment` header - their manager prefers MPP and falls back to x402 only on
  challenge SELECTION errors, never on a failed verify. Their bug; REPORTED UPSTREAM 2026-08-28 as
  awslabs/agentcore-samples#2002 (open, no AWS comment as of 08-29).
  **STEERED SINCE 2026-08-29 (`src/mpp-evm-domain.js` + `src/mpp-fallback.js`), because there IS a seller-side move even
  though there is no seller-side fix:** the shim recovers the signer under the accepts entry's own `extra.name` and, only
  for a token whose advertised name is itself one of the known variants (`USD Coin` / `USDC` - Celo, Monad and Sei USDC
  really are "USDC", so this is per-token, never a global default), under the other one. `domain-mismatch` is reported
  ONLY when the signature recovers to the payload's own `from`, so it cannot be claimed for another wallet and an
  ordinary bad signature stays the facilitator's call. Such a credential is refused LOCALLY (facilitator never asked)
  with an RFC 9457 `verification-failed` problem naming both names and the working path, and that 402 carries NO
  `WWW-Authenticate` at all - having nothing to select is the whole mechanism, so the evm AND tempo halves are both
  withheld. Sticky because the retry is a fresh credential-less request. THE HOLD IS BOUNDED (review finding the same
  day): the key is address+UA, which is not exclusive, and the tempo half of a blanket hold would be a TOTAL payment
  denial for a USDC.e-only wallet that has no x402 offer it can pay - so a request PRESENTING a credential is never
  held, stickiness needs a non-empty User-Agent (an empty one is the widest possible net), and it lapses after
  `MPP_EVM_DOMAIN_FALLBACK_MAX_RESPONSES` (5) responses as well as the TTL. Both hooks share ONE decision per request.
  Fails open on an unreadable diagnosis; `MPP_EVM_DOMAIN_FALLBACK=off` disarms it; `/api/gateway-status`
  `mppEvmDomainFallback` reports counts only. (A proxy-hop precondition is noted in CLAUDE.local.md.) `scripts/test-mpp-evm-domain.js` (39, in CI, boots
  the real paid server; 6 mutations killed).
  `scripts/test-mpp-shim.js` (offline, in CI): real mppx client buys over the
  native wire vs a stub facilitator, single verify+settle, EIP-712 sig checked
  against Base USDC's real domain, x402 pass-through untouched, HMAC
  tamper/expiry rejected. **RFC 9457 failures (2026-08-19, `src/mpp-problem.js`):** a REJECTED MPP
  credential (evm: malformed / not ours / expired / bad payload; tempo: binding, validate, replay,
  post-handler settle failure) answers the spec shape - 402 + FRESH challenges + `application/problem+json`
  `{type: https://paymentauth.org/problems/<kind>, title, status, detail, hint?}` using mppx's own type
  vocabulary (invalid-challenge, malformed-credential, verification-failed, payment-insufficient,
  invalid-payload). Fall-through rejections mark the request (`markMppProblem`, patches `res.send` so the
  paywall's `{}` 402 body becomes the problem doc; non-402 responses untouched); direct ones (tempo replay -
  was a 409 - and settle failure) use `sendMppProblem`. A bare unpaid 402 stays body-less - only rejections
  are problems. Pinned on the wire in test-mpp-shim (through the real server) and test-mpp-tempo-shim.
- **Tempo MPP settlement (`src/mpp-tempo.js`, 2026-08-17):** a SECOND, independent
  MPP path — Tempo (chain 4217, PathUSD `0x20c0…0000`) is MPP's native method, built
  on TIP-20 primitives that are NOT EIP-3009, so it cannot be translated into x402
  like "evm" is and no x402 facilitator supports it. It rides Tempo's hosted relay
  (`api.tempo.xyz` `/v1/mpp/validate` + `/v1/mpp/broadcast` via mppx `tempo.charge({relay})`):
  validate before the handler, broadcast ONLY after a <400 response (the same
  settlement-ordering discipline as x402); we hold no Tempo signing key. Rollout
  switch = `TEMPO_API_KEY` + a recipient (`TEMPO_RECIPIENT_ADDRESS`, else
  `WALLET_ADDRESS`); the key needs the `mpp:write` scope. **Wire shape is mppx's own,
  never hand-assembled** (`Challenge.fromMethod` through the tempo/charge schema:
  base-units `amount` "1000" for $0.001, NO `decimals` key on the wire,
  `methodDetails.chainId` 4217). Both drifts bit us live: a decimal amount made the
  client throw before signing (2026-08-17), and `decimals` ON the wire made the
  relay re-parse the request and expect 1,000,000,000 base units for a 1000-unit
  transfer — every live buy rejected "no matching payment call found" (2026-08-18).
  **INBOUND BINDING (2026-08-18 security review, HIGH, fixed):** the gate handed the
  CLIENT-ECHOED challenge straight to mppx validate/broadcast, and with the relay configured
  those forward `{challenge, payload}` verbatim - the relay checks the signed tx against the
  challenge's OWN amount/recipient, never that WE minted it. A forged 1-base-unit challenge to
  any recipient bought any paid route (and a genuine $0.001 challenge bought a $0.50 route:
  challenges are not path-bound). Now `checkTempoCredentialBinding` runs BEFORE any relay call:
  `Challenge.verify` against MPP_SECRET_KEY, realm, expiry, currency ∈ TEMPO_CURRENCY,
  recipient = our payTo, chainId 4217, and `amount >= this route's price`; `createTempoGate`
  refuses to mount without `secretKey`+`priceFor`, `mintTempoChallenge` mints nothing without
  a secret. Same day: the gate now buffers `flushHeaders` (a streaming /v1 handler settled and
  then hung on the buffered-writeHead replay). While the fix rode CI, prod's Tempo gate was
  disabled by parking `TEMPO_API_KEY` (rollout switch) and restored after the fixed build.
  `scripts/test-mpp-tempo-shim.js` cases H + I.
  **Chain-truth confirm on broadcast failure (`src/tempo-confirm.js`, 2026-08-20):** the relay's
  broadcast verdict can be WRONG in the charged-but-failed direction — measured live: an AgentCore/Privy
  buyer's credential carries a yParity-style v byte (0x00/0x01) in the packed signature; the Tempo node
  ACCEPTS the tx and stores the canonical 27/28 form, so canonical txid != keccak(submitted bytes) and the
  relay's post-broadcast hash check reports `invalid_payment: "Broadcast transaction hash does not match
  the signed transaction"` for a payment that SETTLED (txs 0xbb2e11e3…/0x753f5655…, buyer told 402, retried
  = double charge). So on ANY broadcast failure the gate now asks the CHAIN before answering 402
  (`confirmSettlement` param, wired in server.js): the credential's own signed bytes determine the only
  txids it could have landed under (submitted + v-swapped twin — exact binding, no window heuristics, no
  payer matching, the Stellar same-buyer-window lesson structurally avoided); a receipt that exists,
  succeeded (0x1), and carries the challenge's transfer (currency + recipient + >= amount) is honoured —
  200 + constructed Payment-Receipt, verification never a re-broadcast, cannot double-charge. Fails closed
  on everything else (the 402 stands). `scripts/test-tempo-confirm.js` (26, in CI) pins the derivation
  against the REAL incident tx's on-chain bytes. Tollbooth's tempo gate got the same confirm in 0.9.2 (see the tollbooth entry above); a 2026-08-28 review note calling it open was reading this sentence before it was updated. Whose bug upstream (Privy signer vs relay verify) is
  deliberately unresolved here; the fix is correct under every theory.
  **The relay's verdict is invisible through mppx** (Relay.js drops non-2xx bodies
  AND the `message` of a 2xx `success:false` when the code is outside its allowlist —
  the live shape was `code:"unknown"`); `relayFetch` (injected `fetch`, per-request
  AsyncLocalStorage) keeps status+body in the rejection log; guard
  `scripts/test-mpp-tempo-relay-errors.js`. Live proof = `tempo-canary.yml`
  (dispatch, `scripts/tempo-canary-verify.js`, EVM canary burner funded with 2
  PathUSD on Tempo mainnet — checked on-chain 2026-08-18, never trust the comment) plus a
  daily `mpp-tempo` leg in paid-canary (one GRADED settle = the rail proof; `TEMPO_CANARY_TX_COUNT`
  can add volume ad hoc, default 1). **Tempo VOLUME (2026-08-19; lowered to ~200 tx/day 2026-08-20,
  the operator's call - was ~1,000):** `tempo-volume.yml` (cron every 2h, dispatchable with `count`) runs
  `scripts/tempo-volume.js`: 17 buys of `/api/uuid` (pure-CPU - no upstream spend; the $0.001 lands in
  OUR payTo, only Tempo's buyer-side fee is real cost) over tempo/charge from the canary burner,
  sequential (one wallet, nonces) with a 250ms pace, heartbeat token so stats file it as internal;
  refuses to start under a floor balance on the wallet (exit 2, floor in CLAUDE.local.md) or with no tempo challenge on the live 402; exit 1
  under 80% settled; opens/closes "Tempo MPP volume FAILING" heartbeat-style. 12 × 17 ≈ 204/day ≈
  $0.20/day. The per-chain funding sweep gained `tempo-usdce` (low-water in CLAUDE.local.md)
  + `tempo-pathusd` rows (per-entry `lowWater` override in `chainLowWaterReport`). The
  burner was funded with USDC.e on 2026-08-19 (USDC.e challenges paid
  natively, no swap) plus a PathUSD
  reserve (address and amounts in CLAUDE.local.md). Top up USDC.e when "CANARY BURNER LOW" names Tempo or the volume issue opens with exit 2. `scripts/test-mpp-tempo-shim.js` (offline, in
  CI) proves challenge wiring + settlement ordering with injected stubs.
- **MPP index seeds (2026-08-19):** two discovery sources - the mpp.dev registry (141 rows, 99
  bare-origin) and **MPPScan's tRPC `servers.list`** (`timeframeDays:0` = all-time, 200/page,
  314 rows at launch with name/description/url/logo → `parseMppScanList`, metadata used for
  sellers the registry does not describe; the rendered page's `originUrls` list is the fallback
  via `parseMppScanOrigins`; `discoveryMppScan` on the snapshot reports source/total/error). Probe target resolution: registry
  endpoints > submitted hint > the seller's OWN `/openapi.json` `x-payment-info` operation
  (the MPP discovery format; `probeTargetFromDiscovery`, cached 1h) > bare root. Measured
  live at launch: verified sellers 33 → 167 in one crawl (133 MPPScan-only), 166 with a Tempo
  recipient. Third seed source: **our own x402 crawl** - `mppDualStackOrigins()` (x402-index.js,
  origins whose probed 402 carried `WWW-Authenticate: Payment`) folds into the MPP seeds every
  cycle (`discoverFromX402Crawl`), so dual-stack sellers are detected with no registry and no
  submission. Verification is still ours: nothing lists without a real MPP challenge.
- **Tempo transfer feed = leaderboard source A (`src/tempo-transfers.js`, 2026-08-19, build #4):** with
  `TEMPO_DATA_API_KEY` (Tempo data:read key, on Railway since 2026-08-19) the MPP leaderboard reads
  `api.tempo.xyz GET /v1/transfers` instead of `eth_getLogs`: ONE token-wide INCREMENTAL sweep per
  rebuild (USDC.e, `timestamp.from` = cursor − 5-min overlap, `order=asc`, cursor paging, ids dedupe,
  ≤240 pages/sync), folded into hour buckets per recipient {transfers, volume, payers}, persisted at
  `/data/tempo-transfers.json`, pruned past 31 days. Measured: ~2,000 USDC.e transfers/HOUR chain-wide
  (≈1,000 pages/day; `limit` 5-50; RateLimit-Limit 10000), top recipient ~875/day. Window = 24h
  (`MPP_LB_FEED_WINDOW_MS`, `window.source:"tempo-api"`), history days merged feed-over-RPC per date (no
  double count). **Coverage gating:** the feed only serves once `feedCovers()` - a COMPLETE sync from a
  start ≥ window ago with a fresh head (≤90 min) - else the RPC scan keeps serving (a cold 24h backfill
  takes several syncs; never under-count meanwhile). Feed unreadable → RPC fallback, loudly.
  `MPP_LB_SOURCE=rpc` forces the old path. NOT available from this feed (probed): `attribution` is not
  an accepted `include` on this key and `memo` is empty on every sampled transfer incl. our own canary
  settlements - so MPP-tag filtering / realm fingerprints (the report's ask) are not possible here; counts
  stay "inbound USDC.e transfers". `scripts/test-tempo-transfers.js` (24, in CI).
- **MPP index + leaderboard (`src/mpp-index.js`, `src/mpp-leaderboard.js`, 2026-08-18):** the
  MPP counterpart of the x402 index/leaderboard. The index probe now parses each verified
  seller's LIVE challenge with mppx's codec (`parseOffers`: method/intent, recipient,
  currency, chainId, amount - kept from the last successful probe) - the recipient is where
  the seller is actually PAID, read from a real 402, never the registry. The leaderboard
  ranks verified sellers by inbound USDC.e transfers on Tempo to that recipient over the last
  99k blocks (rpc.tempo.xyz caps eth_getLogs at 100k; ~15h; a WINDOW, said on the page):
  ONE batched `eth_getLogs` per 33k-block chunk with every recipient in `topics[2]` (not one
  call per seller), chunks split on RPC error down to 2k blocks, a failure that survives
  keeps the previous board up marked stale + lastError; warm-start from
  `/data/mpp-leaderboard-cache.json`; rebuild 30 min (first at +120s, again at +10 min).
  Rows are keyed by recipient (a shared gateway recipient sits behind 15 registry names -
  page shows 4 + "N more"), `tempo/session` sellers rank too, `proven` = transfers ≥
  `SOR_TEMPO_MIN_SETTLED_TX`, `routable` = proven AND a tempo/charge offer (the router pays
  charge only); our own Tempo payTo is a self-flagged row. Counts prime tempo-buyer's
  proven-seller cache (`primeTempoInboundCount`) so a routed buy does not re-scan. Surfaces:
  `/mpp-marketplace` (leaderboard section + `routable · #rank` roster badges),
  `/api/mpp-index`, `/api/mpp-leaderboard`. Escape hatch `MPP_LEADERBOARD=off` (rides
  `MPP_INDEX_CRAWL=off` too). Measured live 2026-08-18: 16 recipients, 8 active, 9,392
  transfers / $62 in the window, whole build 2.5s. `scripts/test-mpp-leaderboard.js` (41
  assertions, offline, in CI). **Router Tempo leg gates UP FRONT on the board** when it is
  fresh (`rankTempoResources(..., { provenByRecipient })`: only `routable` recipients are
  candidates, ties break on settled - before this the first lexical hit could be an unproven
  seller, payTempo 409'd, and the proven one ranked second was never tried); a stale/empty
  board gates nothing there and the pay-time gate alone decides (`test-tempo-router.js`).
- **Boot /supported guard (`src/payments.js`, 2026-08-01 Celo facilitator outage):** a
  facilitator that is CONFIGURED but FAILING /supported never delivers its kinds to
  @x402's initialize() (which only warns), and route validation then 500s EVERY paid
  route per request — every catalog route advertises every offered network, so one dead
  facilitator zeroes ALL paid revenue while free surfaces stay green (measured live:
  api.x402.celo.org 500ing → `RouteConfigurationError … exact on eip155:42220` on all
  paid routes for ~4h; heartbeat saw it as `paywall(500)`, issue #649). The existing
  drop-don't-break guards only cover MISCONFIGURATION (missing key/URL), not outage. Now
  every facilitator client is probed at boot (6s timeout, one retry after 2s — the
  heartbeat's single-retry doctrine) and networks no REACHABLE facilitator advertises
  `exact` on are dropped with the same loud warning shape; a dropped rail returns on the
  next boot where its facilitator answers. FAIL-OPEN when EVERY probe fails —
  indistinguishable from our own egress being down, so the guard refuses to wipe the
  offer and keeps prior behavior (paid 500s, free tier fine), loudly. `getSupported` is
  memoized per client (60s, failures never cached), so probe + upto gate + @x402's own
  initialize cost ONE fetch per facilitator per boot (also kills a keep-alive reuse race
  the double-fetch had). `X402_SUPPORTED_GUARD=off` is the operator escape hatch; the
  probe is skipped under `X402_SYNC_ON_START=false` (offline tests).
  **Failure-mode map (no facilitator is load-bearing for the whole paywall):** dead at
  boot → its rail is dropped, 11 serve (the guard); dead MID-RUN after a healthy boot →
  only its own verify/settle fails (buyer never charged, picks another chain off the same
  402) because @x402/express latches isInitialized on first success and never re-fetches
  /supported — that latch is VENDOR behavior, pinned by the test's runtime leg, so a
  future @x402 bump to TTL re-init fails CI instead of quietly re-opening the class; ALL
  dead at boot → deliberate fail-open (paid 500s, free tier fine, per-request init retry
  self-heals). (Residuals in CLAUDE.local.md.)
  `scripts/test-supported-guard.js` (16 assertions, stub facilitators, mutation-checked,
  in CI). **Ops note: RESOLVED 2026-08-03.** `celo` was removed from prod's Railway
  `PAYMENT_NETWORKS` 2026-08-01 during the facilitator outage; it is back in the offer
  and verified working. Measured 2026-08-03: api.x402.celo.org/supported answers 200
  on 3/3 probes advertising `exact/eip155:42220`, and a live 402 on a paid route lists
  `eip155:42220` among 12 rails in the base64 `payment-required` header. Lifetime Celo
  settlement 51 inbound / $0.083, `caughtUp: true`. `/settle` still 401s without
  `CELO_FACILITATOR_KEY` (unchanged by the outage) — that key is what keeps the rail in
  the offer at all. Note the accepts live in the `payment-required` HEADER, not the 402
  body (which is `{}`); reading the body is how you conclude "no rails offered" on a
  perfectly healthy paywall.
- **HEAD paywall bypass CLOSED (2026-07-23, found via MPPScan's prober):**
  Express serves HEAD through app.get() but every gate keyed on
  "METHOD /path" — an unpaid HEAD skipped funnel/PoW/replay/x402 and executed
  GET handlers FREE (upstream-metered tools burned quota with no revenue).
  server.js now rewrites HEAD on catalog GET routes to GET for the gate chain
  and suppresses the body at res.end (RFC 9110 semantics: 402 + identical
  headers, empty body). `scripts/test-head-paywall.js` (offline, in CI).
- **Surface self-consistency (`scripts/test-mcp-self-consistency.js`, 2026-08-07, in CI):**
  every functional test drives the connector the way WE intend it to be used — they
  call the tools whose names they already know — so nothing tested whether our own
  published text names things that EXIST. Three times a tool had a working CallTool
  handler and was absent from `tools/list` (about_agent402, top_x402_sellers, then
  `request_tool`); the first two were fixed by hand with a comment and no test, so the
  class stayed open and the third shipped. The third was the worst: about_agent402's
  `missingATool` field tells agents to "Call request_tool", i.e. our orientation tool
  instructed agents to do something our capabilities made impossible, and the whole
  demand board only ever heard from callers who already knew the name. Found from
  OUTSIDE (issue #705), not by us. The guard reads five agent-facing surfaces
  (`tools/list` text, about_agent402, get_payment_info, `/llms.txt`,
  `/.well-known/x402`) and asserts every tool name in a call-this position is
  advertised, every named catalog slug exists, and every referenced route is
  registered — plus both parity directions (a CallTool branch no advertised name can
  reach; a listed tool with no handler or slug). **Route existence uses TWO oracles
  and reports missing only when BOTH say no:** a source scan of `app.<verb>("…")`
  (the only oracle that can see a POST-only route — a live GET 404 cannot
  distinguish "no such route" from "wrong method", the ambiguity the #705 reporter
  correctly refused to resolve) and a live GET (the only oracle that can see the
  template-literal chain pages `app.get(\`/${chainKey}\`)`). The live probe never
  touches `/api` or `/v1` — in FREE_MODE those handlers execute, and a consistency
  check must not call a tool that spends money. Path matching is SEGMENT-aware so
  `/api/wish` is never satisfied by `/api/wishes`. Extractors are proven against a
  planted control before any clean run is believed (same doctrine as the free-tier
  egress probe). **The first draft had a "does this look like one of our tools?"
  filter that skipped any unknown snake_case name — which is exactly the defect
  being hunted; a planted `Call submit_wish` passed a green run.** It is gone; the
  only escape hatch is the explicit `NOT_A_TOOL` set (one entry: `route_and_execute`,
  which is real but lives on the stdio npm package). Mutation-tested: removing
  `request_tool` from the listing fails 2 assertions, a fake tool name fails 1, a
  fake route fails 1.
- **Canary gate + settlement freshness alarm (2026-08-07):** the daily paid canary
  stopped buying on **2026-08-02** and reported success every run for five days. Its
  gate asked GitHub for the last SUCCESSFUL RUN, but a run whose gate SKIPS the buy
  also concludes green, so every skip refreshed the window the next gate read and it
  ratcheted permanently shut (measured across 40 runs: not one scheduled run bought
  after the gate shipped; every real purchase came from a manual dispatch, which
  bypasses the gate via `if: github.event_name == 'schedule'`). Nothing paged, because
  skipping is not a failure — the ONLY surface that noticed was `/status`, reporting
  the settlement component stale. **The gate now asks PRODUCTION when a canary last
  BOUGHT** (`/api/status` settlement observation, written only by a canary that ran),
  requiring fresh AND operational; unreachable status or a missing observation proceeds
  with the buy, and every `jq` read carries a fallback because jq exits non-zero on a
  non-JSON body and `set -e` would fail the gate. The canary job's `if` gained
  `!cancelled()`: a job-level `if` with no status function still carries the implicit
  `success()` on `needs`, so a FAILED gate would have SKIPPED the buy — the opposite of
  what the comment beside it claimed, and never verified. **`heartbeat.yml` now pages on
  a stale settlement observation** and self-heals once per episode by dispatching the
  canary on FIRST detection only (a dispatch always buys; page rather than loop if
  buying is genuinely broken). Proven end-to-end 2026-08-07: alarm fired → dispatched →
  found a real failure → opened issues; then the 14:17 UTC SCHEDULED run bought (first
  since 08-02) and the recovery branch closed its own issue. `scripts/test-canary-coverage.js`
  locks the class: the gate must read `/api/status` and must NOT read `gh run list`,
  every jq read must have a fallback, and the `if` must carry a status function.
- **Facilitator failure diagnostics (`src/facilitator-diagnostics.js`, 2026-08-07):**
  15 settle failures across Base/Solana/Polygon/Arbitrum all logged 200 characters of
  `<html><head><title>Coinbase</title>…` — `@x402/core`'s `responseExcerpt` truncates an
  error body at 200 chars, and on an HTML page that budget is spent entirely on markup.
  A facilitator outage and an edge REFUSING OUR EGRESS were indistinguishable, and those
  need opposite responses (wait vs build the fifth relay — Yahoo/Nasdaq/Sei/Nodely are
  the existing four, and Nodely 403s Railway's IP outright). A global-fetch wrapper,
  scoped to registered facilitator hosts and non-2xx non-JSON responses only, reads the
  body BEFORE the vendor truncates it, strips markup, and classifies: cloudflare
  challenge/block, access denied, rate limited, origin error behind the edge, gateway
  timeout — keeping `cf-ray`/`server`/`retry-after`. It **clones** before reading
  (consuming the body would break settlement), swallows every internal failure, and logs
  once at boot so a silent failure to install is visible immediately. **Errors are also
  LABELLED with the facilitator that threw them** (`labelFacilitatorErrors`): the failure
  hooks log the chain and never the client, so Solana/Polygon/Arbitrum failures read as
  Coinbase's words though the boot log routes those to PayAI and only Base to CDP —
  clients are tried in order, so the surfacing error is the FIRST tried, not the chain's
  owner. The label is **PREFIXED, never substituted**: `isPreBroadcastSettleRejection`
  matches `settle failed (402)` as a substring, so replacing the message would silently
  break the fallback's safety classification. `scripts/test-facilitator-diagnostics.js`
  (30 assertions, offline, in CI).
- **A facilitator VERIFY that dies at the socket is resent once; a settle never is (2026-09-02, `facilitator-diagnostics.js`):**
  test-verify-hint-live failed twice in CI (09-01 run 33579827783, 09-02 run 33621769411) with "402 with 0 facilitator
  verifies", called a one-off the first time. The server's own lines (printed since #1147) explain it: `[loop-lag] event
  loop blocked 5403ms` right after listen, then `[payments] facilitator VERIFY failed ... fetch failed [UND_ERR_SOCKET]`
  with the stub facilitator having seen nothing. The boot /supported probe opens a keep-alive socket; a post-listen stall
  over 5 s (Node's default idle timeout) lets the far side close it; the first verify is written to the dead pooled socket.
  undici retries idempotent requests on a stale socket itself but a POST is not idempotent to it - a verify IS to us (moves
  no money), so the facilitator fetch wrapper resends POST /verify or GET /supported ONCE on a socket-class error
  (`isRetryableFacilitatorRead`: facilitator host, string/Buffer body, UND_ERR_SOCKET/ECONNRESET/EPIPE/ECONNREFUSED/
  connect-timeout) and NEVER /settle. A response with a status is never retried. Pinned in test-facilitator-diagnostics
  (45). The same class reaches prod buyers: a verify lost to a stale socket was a 402 for a payment nobody examined.
- **Redis has REAL coverage in CI (2026-08-07):** nothing had ever connected to a redis.
  `test-shared-limit.js` injects a fake store on purpose (it proves "two callers share
  one counter", and a fake proves that exactly), which left the CLIENT path untested —
  so a redis 4→6 bump arrived with a green CI that could not have caught a client
  regression, the same worthless green as the tesseract 5→7 trap. Prod is **NOT**
  in-memory (verified against Railway: `REDIS_URL` and `RATE_LIMIT_REPLICAS` are set,
  and the shared limiter FAILS CLOSED). The test job now runs a `redis:7-alpine` service
  container and `scripts/test-redis-integration.js` drives the real client (cap-of-1,
  over-limit decrement, refund flooring, cache round trip). It asserts `degraded === false`
  so it cannot pass via the fail-closed path with no server, and it **exits 1 rather than
  skipping** when `REDIS_URL` is absent — a skipped integration test is why this went
  untested at all.
- **Marketplace latency / snapshot caching (`src/x402-economy.js`):** `GET /marketplace`
  (and `/api/x402-economy`) render from `x402EconomySnapshot()` — a ~500ms on-chain read
  (EIP-3009 USDC settlements on Base via CDP SQL). It is **stale-while-revalidate**: a fresh
  cache (30 min, `ECONOMY_FRESH_MS`) returns as-is; a stale-but-present cache is served
  immediately while a single **deduped** background rebuild (`startEconomyRefresh`, one
  in-flight query for a concurrent burst) runs; only a cold cache (first request after boot)
  awaits the build. Errored reads back-date `cachedAt` so they expire in ~5 min, not 30.
  No visitor request ever blocks on the rebuild — before this, the first visitor after each
  30-min expiry ate the full ~500ms. **`routeQuery` (/api/route, /api/find relatedSellers, the SOR resolution) memoizes per-entry
  derivations by object identity (2026-08-25):** alias `exactServiceKey`/slug sets, the decorated remote
  pool and per-tool statics (lowercased haystack, injection verdict, price rank) live in WeakMaps keyed by
  the cache entry / tool object - entries are replaced on re-crawl, never mutated, so no invalidation;
  measured 160 → 53 ms per query on a synthetic 2,900-seller cache (prod was 1.1 s cold). A source guard in
  `test-discovery-note.js` pins that the injection verdict is computed in the statics AND honoured for every
  row. `getIndexSnapshot()` is a separate 30s in-memory cache
  (`INDEX_SNAPSHOT_TTL_MS`). The **crawl cache itself warm-starts from `/data`**
  (`INDEX_CACHE_FILE`, default `/data/x402-index-cache.json`; persisted after each
  crawl, loaded in `startCrawler`, never clobbers a live-refreshed entry) — it used to
  be memory-only, so every redeploy served a half-crawled ecosystem for the minutes a
  ~2,200-origin re-crawl takes (a visitor saw 569 sellers against a real 2,169). Same
  fix and same reasoning as the leaderboard's own snapshot warm-start.
  `scripts/test-index-warmstart.js` (offline, in CI). **The persisted cache is SLIM (2026-08-25):** it had
  reached 91.4 MB on prod (full seller manifests, up to 4 MB each) and cost 3 s of boot parse plus a
  synchronous re-stringify after every crawl cycle; `persistedEntries()` keeps a manifest projection
  (name/description/homepage/capabilities.tools/synthesized, `slimmed:true`) and bounded tool scalars, the
  crawler writes via `persistIndexCacheAsync()` (which also writes an NDJSON twin, `*.ndjson`, one seller per
  line; every persist logs size + the five largest origins), and boot loads the twin INCREMENTALLY
  (`loadPersistedIndexCacheAsync`, 250 lines per turn with a `setImmediate` between batches, legacy one-shot JSON
  as fallback; `indexWarmStartInProgress()` keeps `getIndexSnapshot` from pinning a half-loaded cache for 30 s;
  `test-index-ndjson-warmstart.js`: 7 ms longest hold vs 68 ms one-shot on the same data). Safe because the
  ETag cache is memory-only: the first crawl after a boot re-fetches every manifest in full. Note the two seller counts on
  `/marketplace` are deliberately different populations: the stat card counts **distinct
  payees** (rows after collapsing origins sharing a leaderboard payTo gid) and the chain
  nav counts **raw origins** — the card names both so they reconcile. Measured live 2026-07-18: `/marketplace` p50 135ms / max 224ms,
  `/api/x402-economy` p50 93ms, zero requests >500ms across 26 samples. NB: there is **no CDN**
  in front (no `age`/`cf-cache` header) — the server-side snapshot caches are the origin
  protection; the `max-age=120` on the response is a browser-only hint. Contract pinned by
  `scripts/test-x402-economy.js` (dedup + warm-cache identity, never-throws).
- **Site redesign 2026-08-22 ("milled + obsidian", approved from the Agent402 Site Directions canvas):**
  TWO themes, LIGHT IS THE DEFAULT (flipped back the same day, the operator): the light "milled" palette sits on bare `:root`, the
  obsidian dark palette is the `:root[data-theme="dark"]` override, `site-chrome.js` stamps `data-theme="dark"` pre-paint
  only when the stored preference is dark, and typography tokens live on the default root (they are theme-independent - a
  font token stranded in the override block fails `test-css-tokens-resolve`). The earlier dark-default note follows: the dark palette sits on bare `:root` (first paint
  dark, no script, no flash); the light "milled" palette is `:root[data-theme="light"]`, applied by
  `assets/js/site-chrome.js` (synchronous in `<head>`, reads `localStorage a402-theme` pre-paint) and
  flipped by the nav `.ml-theme-toggle`; no OS media query. Theme-specific surfaces ride tokens
  (`--btn-bg/--btn-fg`, `--nav-bg`, `--brand-mark`, `--milled-bg`, `--obsidian-bg`, `--chip-bg`,
  `--card-inset`, `--on-accent`) - never a hardcoded hex in a page class; `test-theme.js` pins all of
  it (dark default tokens, complete light override, toggle present + CSP-clean, no server-stamped
  data-theme). Mobile menu: CTA first, groups people/buy/index/sell/more, chains as a 2-col chip grid.
  (Earlier the same day it shipped as ONE light theme on `:root` (`--paper #F3F4F5`, `--card #FFF`, `--ink #111315`, obsidian panels keep
  `--surface #0C0D0F` / `--on-dark`; `--accent #0F5E43` deep green for text/kickers on light,
  `--accent-lit #9EF0B0` phosphor ONLY on dark; `color-scheme: light`, no toggle, no OS media query -
  `test-theme.js` pins the new palette + the no-toggle rules). Fonts self-hosted Geist + Geist Mono
  (`assets/fonts/geist-*-latin{,-ext}.woff2`, weights 300-700 / 400-700, metric-matched `Geist Fallback`
  faces computed from the TTF metrics; `FONT_FILE_RE` in server.js admits them). `ledger-chrome.js`: status
  band removed; nav = Reports · Monitors · Tools▾ | Market▾ · MPP▾ · Leaderboard | Sell▾ · Docs + llms.txt
  pill + "Get a report" CTA (→ /reports, suppressed there) + burger; dropdown/mobile mechanics, chain rows
  (`test-nav-chains`) and `site-chrome.js` unchanged; footers carry a "for people" column. Homepage
  (`ledger-home.js`): hero = headline + obsidian 402-handshake terminal carrying the live counter
  (`#hm-counter` etc. preserved), two doors (people / agents), proof strip, PoW demo, sell, leaderboard +
  rails (obsidian band), demand lanes, rails chips, FAQ, closing CTA; the d3 dot-map + marquee are gone
  (homepage loads NO third-party script - `test-home-page` pins that now). `/reports`, `/r/:id`, `/m/:id`,
  `/monitors*` render through `ledgerShell` with shared `REPORTS_CSS` (class names unchanged for
  reports.js / report-view.js / monitors.js). Error page + a new catch-all 404 render through the shell.
  Sitewide `1.5px solid var(--ink)` borders softened to `1px solid var(--hairline)` (49 modules). Machine
  surfaces (`/llms.txt`, `/openapi.json`, `/.well-known/x402`, `/api/*`, MCP, sitemap/robots, JSON-LD)
  untouched; every page gate (`test-single-main-landmark`, reveal suite, `test-static-pages`,
  `test-css-tokens-resolve`, `test-faint-contrast`, `test-home-page`, `test-surface-copy`, ...) green.
  Booted page tests default to `TARGET_URL=http://localhost:3000` - if another app holds :3000 locally
  they read its HTML and fail confusingly; boot ours on a free port and export TARGET_URL.
- **Homepage = `src/ledger-home.js`** (`ledgerHomePage`; the old `src/landing.js` is unused
  but still unit-tested). Its `faqs` array renders BOTH the visible FAQ and the FAQPage
  JSON-LD, and the WebApplication offer is an AggregateOffer — deploy.yml's SEO gate greps
  prod for `"FAQPage"` / `GET /faq` / `AggregateOffer`. That gate runs BEFORE the deploy job,
  so a fix to those surfaces goes green on the run AFTER the one shipping it.
- **/revenue layout = two wires + a throughput band (2026-08-20, the operator):** `revenuePage` renders a
  wire overview (one card each for x402 and MPP — **headlines are EXTERNAL-only**: the MPP card
  headlining its combined count read as traction when 553 of 554 were our own volume runs, the
  registry-inflation move we call out in others), then **`railThroughputSection`** — a PROMINENT
  full-width band carrying the big COMBINED numbers (`allTimeInboundCount/Usd` on ledgerSummary +
  `mppSales().count`) with provenance in the same breath ("every settled on-chain transaction, ours
  included · throughput proves the rails, revenue counts only money from others"). Being paid proves
  demand; ~200 settlements/day through the same gates buyers use proves the plumbing — both are
  first-class, neither wears the other's clothes. Then the chart, `x402 rails · by chain` (EXTERNAL
  rows only) and `MPP wire · by rail` (big number = "through the rail (ours incl.)", external called
  out beside it; intro says "throughput, not revenue"). **Payer classification:** tempo settles
  record the credential's did:pkh `source` as CLASSIFICATION-GRADE payer (`req.mppTempoPayer`,
  never identity — same tier as the facilitator-receipt fallback); the operator's AgentCore/Privy test
  wallet (address in CLAUDE.local.md) is in OUR_EVM_WALLETS (its 2026-08-20 buy classified external for a day);
  sales-ledger boots with an idempotent reclassification sweep (payer ∈ BURNERS → internal, plus
  the one payer-less AgentCore row by tx hash).
- **Buyer counts on /revenue (`ledgerBuyersDaily` + `ledgerBuyerConcentration`):** a
  **Buyers** metric answering "more buyers, or the same handful paying more?", which
  tx counts cannot (200 calls is one whale or fifty customers; the revenue line is
  identical). Served on `/api/revenue/daily` as `buyers[]` + `concentration`. Distinct
  counts fail flatteringly, so four invariants are pinned by
  `scripts/test-revenue-buyers.js` (8 assertions) + `test-revenue-chart.js`: **cumulative
  is a running UNION, never a sum** of daily counts (summing double-counts every
  returning buyer and draws a rising line over a flat reality); a buyer paying on **two
  chains in one day is one buyer** (rows are keyed day+chain, so counting there reports
  two); **`newBuyers` is measured against ALL history**, not the charted window, so nobody
  is relabelled new when the epoch moves; and **base58/Stellar addresses are never
  case-folded** (that merges distinct buyers — same rule as `src/payer.js`). Buyers is
  external-only and count-only, so selecting it forces scope=ext/wire=all/traffic=paid.
  `unattributed` surfaces payments whose payer could not be read (measured 0 of 3,945).
  **Counts only, never addresses** — a per-day roster of who pays us is a customer list.
  Baseline 2026-07-27: 200 distinct buyers, ~1-6 new/day, majority returning.
- **Revenue chart free-tier lane (`/revenue`, `src/revenue-live.js` `revenueChartSection`):**
  the chart is built from the settlement ledger, so free (proof-of-work) calls are
  invisible to it — they settle nowhere. A **Paid / Free (PoW) / Both** control merges a
  second series from `GET /api/calls/daily`, backed by the `daily_calls (day, method, n)`
  table in `src/stats.js` (bumped inside the SAME transaction as the lifetime counters, so
  the two can never drift; never pruned — `recent_calls` is capped at 200 rows and can
  never source a time series). A free call earns **$0**, so the lane is mutually exclusive
  with the `Revenue $` metric: each control corrects the other (`setSeg`), and `build()`
  additionally refuses the lane unless `metric === "tx"`. Free tier is **not a chain** — it
  takes a neutral `--sfree` grey, never one of the 8 validated chain slots, and never folds
  into "Other". Per-day recording began when the table shipped; earlier days have **no
  record**, which the note distinguishes from "no free traffic" (heartbeat probes are
  excluded — external PoW only). Chart epoch is `REVENUE_DAILY_START`, default **2026-06-15**.
  `scripts/test-revenue-chart.js` (jsdom, in CI) pins the interaction invariants.
- **Status page (`/status`, `/api/status`, `src/status.js` + `src/status-store.js`):**
  availability measured from OUTSIDE production. The heartbeat (GitHub Actions, every
  15 min) POSTs what it observed to `POST /api/status/probe` (operator-authed — an open
  endpoint would let anyone forge our uptime), and the page only renders those rows.
  Three invariants, pinned by `scripts/test-status-store.js` (33 assertions, in CI):
  a day with **no observation is "no data", never uptime**; a component whose newest
  observation is **stale reads "unknown", not "operational"**; every percentage carries
  its **observation count**. When prod is down the probe can't report either, so an
  outage is a GAP — hence gaps never count as uptime. `latestByComponent` keys on
  **MAX(ts), never MAX(id)** (backfill inserts old rows after new ones). Incidents are
  computed from failed probes, not authored. Backfill via `status-backfill.yml` →
  `scripts/backfill-status-history.js`, judged **per PROBE STEP, never per run
  conclusion**: heartbeat runs fail for unrelated reasons (runner "Set up job", the
  issue step), and using conclusions invented 17 outages / 97.899% where the probe step
  gives **784 observations, 0 failures, 100.000%** (43 days). The OLD page hardcoded an
  "All systems operational" pill and headlined `process.uptime()` (resets every deploy) —
  never reintroduce either.
- **Independent status observer (`workers/status-probe`, Cloudflare cron, live 2026-07-27):**
  a second observer OUTSIDE production on separate infra, because /status is only as
  trustworthy as its observer and that was a single GitHub schedule. Probes every 5 min
  (`the Cloudflare worker whose URL lives in the STATUS_PROBE_WORKER_URL repo variable`; `OPERATOR_TOKEN` secret = Railway's
  `AGENT402_OPERATOR_TOKEN`), records `source: "cloudflare-cron"` on `POST /api/status/probe`,
  and covers `api`/`catalog`/`mcp`/`paywall`/`rails`. It deliberately **skips paid-call**:
  that needs a 16-bit PoW solve plus an `X-Heartbeat-Token` from `POW_SECRET`, and copying
  that secret to a second platform widens its blast radius while omitting it would count
  every probe as real external free-tier demand (288/day synthetic vs ~130/day genuine),
  corrupting the free-tier series on /revenue. So `paid-call`'s `staleAfterMs` is sized to
  ITS observer (`HOURLY_OBSERVER`, 3h = ~3 missed hourly GitHub runs), not the 45-min
  default. `POST /run` on the worker is token-gated for manual verification.
  **Single-retry semantics (2026-07-29):** a failed check is re-probed once after
  20s and only a failure that survives is recorded — one probe landing inside a
  deploy restart was ambering the whole day's bar on /status (6 of 7 amber days
  traced to deploy blips), which reads as "currently degraded" on a healthy
  service. A real outage fails both attempts and records exactly as before; the
  first attempt's blip still goes to the worker log. Paired fix: the Railway
  service now has `healthcheckPath=/health` (timeout 120s), so traffic only
  switches to a new container after it actually serves — deploys should no
  longer produce the blip at all (drain side was already covered by
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`). The GitHub heartbeat prober has the
  SAME single-retry semantics (`scripts/heartbeat-probe.sh` probe() wraps
  probe_once(), `PROBE_RETRY_DELAY` default 20s) — added later the same day
  after a sub-minute incident recorded at 03:40Z proved the worker-only fix
  left this observer blipping.
  `scripts/test-status-probe-worker.js` (11 assertions, stubbed fetch, in CI) pins the
  quiet regressions: a 200 where a 402 is required, a collapsed catalog, a rail silently
  missing from the offer, and "one dead endpoint must not abort the other checks".
- **Heartbeat cadence (why /status went amber on a healthy prod):** the workflow's
  cron says `*/15` but GitHub delivers it **about once an hour** (measured 2026-07-27:
  60-72 min gaps plus a 3.3h stall), while `COMPONENTS.staleAfterMs` marks these
  components stale at 45 min — so the page reported "degraded" with production
  perfectly healthy, the exact threshold-vs-cadence mismatch `src/status.js` warns
  about. Fixed by observing MORE, never by loosening the alarm: the probe moved to
  `scripts/heartbeat-probe.sh` (sourced, defines `probe()` + `record_observation()`)
  and a final `if: always()` step re-probes 4x at 12-min spacing, so freshness tracks
  the 45-min threshold again. That step runs LAST so nothing that can page is delayed;
  `timeout-minutes` is 75 to cover it. `scripts/test-heartbeat-probe.sh` (22 assertions,
  offline, stubbed curl, in CI) pins the FAILS -> per-component mapping — a mismap would
  silently report the wrong component down, or a broken one as operational.
- **Refund pipeline (`src/refund-ledger.js` + `scripts/refund-run.js` + `refund.yml`, 2026-08-04):**
  charged-but-failed is now a DEBT, not only an alarm. The moment a settle receipt with
  `success:true` goes out on a non-200 (the existing detection at the charged-failure
  tally in server.js), a row lands in `/data/agent402-refunds.db`: payer, network,
  priceUsd, settle tx as evidence, synthetic flag. Idempotent on the settle tx.
  Operator surface: `GET /__operator/refunds.json` (+ `POST /__operator/refunds/update`
  — `paid` REQUIRES the outbound tx, `void` REQUIRES a note; a silent write-off is the
  failure mode the ledger exists to prevent; resolved rows never re-resolve).
  Execution is the dispatch-only `refund.yml` → `scripts/refund-run.js`: DRY RUN by
  default (`live=true` to send), refunds the exact priceUsd to the recorded payer on
  the chain they paid on, asset read from OUR OWN live 402 accepts (never a
  hand-maintained token table; EVM decimals read from the contract). Caps: per refund,
  per run, and per payer per run (`REFUND_MAX_PER_PAYER_USD`; values in CLAUDE.local.md); optional dust floor
  `REFUND_MIN_USD` (default 0 = off). Over-cap, unsupported and dust rows are HELD and
  listed, never dropped.
  **PRE-SEND ON-CHAIN PROOF (`src/payment-verify.js`) — no refund leaves on a
  facilitator's word.** A debt is recorded on the settle receipt's `success:true`,
  which is unforgeable by a buyer but NOT guaranteed true — a facilitator can be
  wrong, and one demonstrably was this week in the opposite direction (Stellar
  reported failure for transfers that confirmed). The mirror (success reported for a
  reverted or never-landed transfer) would refund money we never received, with no
  attacker involved. So before each send the executor re-derives the payment from the
  chain: the SAME payer → OUR payTo (from the live 402 accepts), for AT LEAST the
  amount (>= because premium chains quote above list), in a transaction whose receipt
  status is success, with the token address matched and `decimals()` READ not assumed.
  Fails closed on every uncertainty — RPC error, missing receipt, junk tx, no verifier
  for that family — and the row is HELD, still owed, never paid and never written off.
  **All twelve rails verify** (2026-08-04): every EVM chain via receipt logs;
  Solana via pre/post token balances compared per OWNER (a payer may use a
  non-default token account, so matching derived addresses would miss it) with
  `meta.err` rejecting failed transactions — the exact shape our own whale produced
  when it ran dry; Algorand via the indexer, checking sender, receiver, **ASA id**
  (anyone can mint a token called USDC on Algorand) and amount; Stellar via the shared
  same-transaction confirmer. Monad and Robinhood RPCs were missing entirely, so their
  rows had been holding as "no RPC configured" — safe, but never repaid. 36 assertions
  in `scripts/test-payment-verify.js`; 15 mutations killed (accept a revert, ignore who
  paid, ignore who was credited, accept an underpayment, accept any token, assume 6
  decimals, proceed without a receipt).
  **Deep review 2026-08-04 — two MORE findings, both fixed.** (a) **Double-refund
  window.** The executor sent, then marked paid; a failure in between (a blip on the
  mark call) left the row `owed` while the money was gone — and the next run
  re-verifies the INBOUND payment, which is true forever, and pays again.
  Verification proves we were PAID; it can never prove we have not already REFUNDED.
  Rows are now CLAIMED (`owed → sending`) before any broadcast, only from `owed`, so
  a crash leaves a stuck `sending` row for a human instead of a silent second
  payment. `refund.yml` also has a `concurrency: refund-run` group so two dispatches
  cannot race at all. (b) **Stellar could vouch for the wrong debt.** Its confirmer
  answers "did this payer pay us near this time" — weaker than the other rails, which
  resolve a specific hash — so one genuine payment could verify a DIFFERENT debt from
  the same buyer in the same window, refunding it twice. When a row recorded a
  transaction, the confirmed one must now BE it.
  **Abuse review 2026-08-04 — two guards exist because of it.** (1) A debt requires
  POSITIVE PROOF: `receiptProvesCharge()` demands an explicit `success === true`. The
  charged-failure ALARM still fires on an unreadable/legacy receipt (loud on ambiguity
  is right for a warning), but a DEBT is money, so ambiguity must not mint one —
  otherwise a middleware change making the receipt unparseable would create a
  refundable row per failing call, one per slug per minute (no tx to key on). The
  receipt is unforgeable — a RESPONSE header written only by `@x402/express`, never
  echoed from a request — so `success:true` is trustworthy; the gap was trusting the
  ABSENCE of a field. (2) The per-payer cap bounds the sponsored-gas griefing loop:
  gas is sponsored for buyers on EVM, so a wallet can pay $0.001, force a
  charged-failure, take the $0.001 back and lose nothing while WE pay refund gas. Each
  debt is real, so the answer is a per-wallet bound (rows pile up visibly, held), never
  a refusal. Also verified: `isSyntheticRequest` needs a signed heartbeat token (a buyer
  cannot flag themselves), and refunds pay `def.price` (list) — on premium chains the
  buyer paid slightly MORE (the difference is noted in CLAUDE.local.md). Canary/synthetic rows are recorded but held unless
  `include_synthetic`. Spending keys are Actions secrets ONLY and refunds ride
  the CI CANARY BURNERS by default (the operator's decision 2026-08-04 — refund volume is
  minimal, the burners already hold USDC on the paying chains, and the canary
  low-water alarms watch their balances, so refund spend pages for a top-up like
  canary spend does). Dedicated `REFUND_EVM_KEY` / `REFUND_STELLAR_SECRET` /
  `REFUND_ALGORAND_MNEMONIC` take precedence whenever set. NEVER the treasury;
  the server records debts but can never send money. (Per-rail send coverage in CLAUDE.local.md.) A failed send leaves the row owed and exits 1.
  `scripts/test-refund-ledger.js` (27 assertions, 7 mutations killed, in CI).
- **Charged-failure alarm — READ THIS BEFORE TRUSTING IT.** `charged-failure-alert.yml`
  polled PUBLIC `/api/stats` for `.chargedFailures`, a field that only exists on
  `getOperatorBreakdown()` behind `/__operator/stats`. `jq -e` failed every run, it took
  the "unreadable → skip" path, and reported success — so the alarm for our worst failure
  mode (buyer paid, got nothing) had **never once fired** before 2026-07-25. Now reads
  `/__operator/stats` with `AGENT402_OPERATOR_TOKEN`, and a MISSING field is no longer
  treated as unreadable (that's what hid it). **`chargedButFailed` on `/api/stats` is a
  LIFETIME counter (~1726) polluted by a since-fixed miscount that logged Robinhood
  settlement *rejections* — where the buyer kept their money — as charged failures. Never
  quote it as current quality; use a recent window from the operator endpoint.**
- **Paid canary (`scripts/paid-canary.js`):** 32 legs — tools across all twelve rails
  (Base/Solana/Polygon/Arbitrum/Monad/Celo/Avalanche/Sei/Optimism/Stellar/Algorand/Robinhood).
  **Rail legs are graded separately from tool legs and now FAIL the run** (fixed
  2026-08-03). They live outside `results`, so `decideCanary()` never saw them and every
  rail branch was `console.warn` + `continue`: a rail could fail on every run for weeks
  while the script exited 0. Measured on run 30835380742 — "30/30 settled", exit green,
  Stellar broken on that run and the nine before it. All eleven rail failure paths now
  go through `railFail()`, and `main()` exits 1 if any fired. Silent skips are gone too:
  a rail missing from the live 402 accepts (the Celo-outage shape) is a failure, not a
  `continue`.
  **STELLAR SETTLES LATE — FIXED 2026-08-03, and the rail was never broken.** Stellar
  closes a ledger about every 5s. The OpenZeppelin channel service gives up before that
  and returns `settle_channel_service_failed`, so we returned 402 while the transfer
  confirmed anyway: measured 402 at 17:10:48.044, transfer confirmed 17:10:52, on-chain
  effects `account_debited CANARY BURNER 0.001 USDC` → `account_credited OUR PAYTO`. It
  reproduced on EVERY run because it is a race nobody can win, not a fault. The handler
  had already run, so we did the work, took the money, and discarded the answer — the
  buyer was charged and told they were not. Do NOT pull `stellar` from
  `PAYMENT_NETWORKS`: payments always succeeded, delivery did not.
  Fixed by `StellarConfirmingFacilitatorClient` in `src/payments.js` + `src/stellar-confirm.js`:
  on a settle failure we poll Horizon and, if a confirmed transfer from that payer to our
  payTo exists, honour the settlement that actually happened. **Verification, never a
  re-settle** — nothing is broadcast, so it cannot double-charge. A transfer counts only
  when the payer was debited AND our payTo credited in the SAME successful transaction
  after the attempt began; native XLM (fee) debits are excluded; any error returns null
  and leaves the original failure standing. Proven in production: canary
  `OK stellar → settled $0.001 USDC` on run 30845721207, all rail legs green.
  **The payer comes from the FACILITATOR (`SettleError.payer` / settle response), never
  from the payload** — the first version read `paymentPayload.payload.payer`, which does
  not exist (a Stellar payload carries `transaction`, a base64 XDR envelope), so the fix
  shipped DEAD and the canary caught it in one run. Parsing the XDR would not help
  either: the transaction source is the facilitator's channel account, not the buyer
  (measured GBA2DD…NY6O4 vs GDR2UY…KGE3T). `scripts/test-stellar-confirm.js` (18
  assertions, in CI) pins both halves — the original 13 all passed against the dead
  version because every one supplied a payer as an argument and none asked where a
  caller obtains one. Still worth reporting upstream: OpenZeppelin should not report
  failure for transfers that subsequently confirm.
  incl. two federal-data legs
  (vin-decode / geo-lookup) whose Base settlements also seed the gov tools into
  settlement-driven indexes like x402scan, plus llm-nano (failover), llm-stream
  (`raw:true`, asserts SSE `data:`…`[DONE]`), llm-auto (model-less request must carry the
  `agent402_router` disclosure), llm-embed + embed-cache (default-on free repeat,
  per-run nonce input), llm-image (real b64_json payload >10k chars), my-usage
  (self-referential history), supply-chain (address-profile: the daily two-settlement proof — canary pays us, prod's spending wallet pays Blockscout upstream), route-exec (receipt + digest), prompt-cache (pays once,
  identical unpaid repeat must be 200 + `X-Cache: hit`), and **render** (the only leg
  that exercises the secretless browser/media worker — a paid `example.com` render must
  return `rendered:true` + a stable "Example Domain" title, proving the live main→worker
  hop + Chromium + F04 egress proxy end-to-end; new-leg coverage locked by
  `scripts/test-canary-coverage.js`). Trigger via workflow_dispatch on
  `paid-canary.yml` (ref main) after a deploy; verdict is the job log tail.
  **Funding classification:** exit 3 = proven underfunded (all failed legs clean 402s,
  ≥1 real settle, live Base balance < cheapest failed leg — files a "burner EMPTY"
  issue, not an outage); exit 4 = green run but balance < `CANARY_LOW_WATER_USD`
  (default: see CLAUDE.local.md) — "burner LOW" issue pages for a top-up BEFORE starvation.
  The balance read walks a 3-RPC fallback chain (mainnet.base.org rejected the read
  2026-07-27 while the wallet sat at $0.00, so an empty wallet paged as "buying looks
  broken"); an unreadable balance is logged loudly and never demotes a green run.
- **Algorand rail canary (`scripts/algorand-rail-canary.js`, `algorand-rail-canary.yml`,
  weekly Mon ~06:41 UTC + dispatch):** buys EVERY catalog tool on Algorand and asserts
  402 → sign → settle → 200 → non-empty payload. Fills the gap between paid-canary (ONE
  Algorand leg) and challenge-sweep (skips already-registered, so it re-verifies nothing).
  **Every non-clean buy gets ONE fresh-signed retry before it is classified (2026-08-19):**
  a >=400 cancels settlement so a retry costs nothing unless it succeeds, and this sweep
  makes ~500 sequential paid buys over ~55 min, so three NON-defects otherwise fail the whole
  weekly gate on first sight — an edge `502 "upstream error"` (Railway swapping a container
  mid-sweep; it hits pure-CPU tools like `hash` too), a THIRD-PARTY upstream 5xx/timeout
  (Blockscout/GLEIF/OpenRouter, or a router `"Seller rejected the paid retry"`), and a
  `409 "authorization already used"` (two equal-priced AVM buys inside one ~50-min validity
  window can sign to the same txid; a fresh signature in a later round is a new txid). Only what
  SURVIVES the retry is classified: **rail** (paid, still a slow 402 = settlement refused), **tool**
  (settled path fine, our own handler didn't deliver; a ≥400 cancels settlement so nobody was
  charged), **unexpected-missing-accept** (a non-identity-bound tool stopped advertising
  `algorand:*`) — these three FAIL the run — plus **upstream** (a persistent third-party/edge
  outage: reported prominently, buyer never charged, **does NOT fail the run**, same doctrine as
  the external buyer) and **throttle**/**rate-limited** (our own burst). The pure classifiers
  (`outcomeOf`, `isUpstreamOutage`, `isThrottle`) live in `scripts/avm-canary-classify.js`
  (side-effect-free so they unit-test without booting the sweep) and are pinned by
  `scripts/test-algorand-canary-classify.js` (21, in CI). One issue, heartbeat style; a passing
  run auto-closes it. Before this, ANY blip over 500 buys kept the issue permanently open
  (#806). Identity-bound routes are
  excluded via `isIdentityBoundRoute` **imported from `src/payments.js`**, never a local
  pattern, so it can't drift from the server (a `^memory` heuristic missed `my-usage`).
  Self-buys recycle to our payTo; true cost = txn fees + per-tool upstream spend, hence
  weekly not daily. Baseline 2026-07-25: 490 buyable, 12 identity-bound, 14 over the
  $0.25/tool cap, ~$10.78 in flight.
- **External Algorand buying (`scripts/algorand-external-buy.js`, `algorand-external-buy.yml`,
  dispatch-only, **dry by default**):** pays OTHER Algorand sellers from the GoPlausible
  catalog (`src/algorand-sellers.js`) so we're a buyer on the rail, not only a seller.
  This money does NOT come back, so: hard total cap checked before every buy, per-buy cap,
  live 402 re-quote (catalog price is a hint only), USDC ASA pinned, and a self-buy guard
  that learns our own payTo from a live 402. Budget spreads one buy per seller per round,
  most-verified sellers first. First real run 2026-07-25: **$0.992 across 51 settled buys
  from 7 distinct sellers**. Expect a high non-200 rate (54 + 18 HTTP 400s, ZERO charged —
  no settle receipt) because external sellers publish no example inputs the way our bazaar
  extension does; `algo.netintel.dev` alone accounted for 42. A failed third-party buy
  never pages (their outage, not our defect).
- **Free-tier egress is a TESTED invariant, not a list
  (`scripts/test-free-tier-egress.js` + `egress-probe-preload.js`):** the free
  tier's safety rests on `WALLET_ONLY_SLUGS`, a curated list (why a test backs it is in CLAUDE.local.md). The
  probe boots the server under a preload that enters an AsyncLocalStorage
  context per inbound request and records every fetch/http/socket/DNS/
  child_process call inside one, so background work (which has no request
  context) is ignored rather than blamed on a tool. It then drives all 222
  compute-payable tools with their own documented examples and requires ZERO
  attributed egress; a failure names the tool and the target. It self-checks
  first with a fetch-based control tool and REFUSES to report a clean run if the
  probe is blind - the first version reported nothing while working perfectly,
  because the control used node:dns and never called fetch. Verified by planting
  a real leak (removing a fetching slug from WALLET_ONLY_SLUGS), which it caught.
  `X402_INDEX_CRAWL=off` skips the index crawler: it exists for this test's
  attribution, and it also stops CI crawling thousands of third-party origins on
  every boot for nothing.
- **Image transforms run OFF the main thread (`src/tools/image-pool.js`,
  `image-worker.js`, `image-ops.js`):** Jimp decodes in pure JS and
  SYNCHRONOUSLY, and the three compute-payable image tools (resize/convert/
  thumbnail) are reachable free on the authless connector and via PoW - so a
  free caller could occupy the only thread. Measured before the fix: eight
  concurrent 16M-pixel resizes put `/health` at a 363ms median with only 7-8
  probes landing in 3.2s; after, 2ms median with ~60 probes. A 2-worker pool
  (the memory ceiling, not a throughput knob: 16M px is a 64MB RGBA bitmap per
  in-flight job), a 32-deep queue, and a 5s per-job timeout that
  `terminate()`s - the only lever that works on a thread stuck inside a
  synchronous decode. Overflow and timeout answer **503, not 400**: the input
  was fine, and a >=400 cancels settlement so nobody is charged. Primitives
  live in `image-ops.js` and are imported by BOTH sides, so output bytes and
  error strings cannot drift; `statusCode` rides back on the worker message so
  a 400 stays a 400. URL-taking image tools (exif/dominant-color/crop) stay
  inline: they are wallet-only, so payment already bounds them. Guarded by an
  offline event-loop probe in `scripts/test-image.js` and end-to-end by
  `scripts/test-image-concurrency.js`. NB the naive lag metric scored total
  starvation as a perfect 0ms because the probe callback never ran - the test
  reads the outstanding timer's lateness instead.
- **X ops (post + read, all via Actions — keys never local):** `scripts/tweet.js` is a
  dependency-free OAuth 1.0a CLI (`--text/--file/--quote/--reply-to/--media/--delete/
  --verify/--force`, `DRY_RUN=1`; secrets `X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/
  X_ACCESS_SECRET`, Actions-only). The X App is on a **PAID API plan** — we pay for
  usage. **`--reply-to` and `--quote` are RESTRICTED to posts we authored or that
  mention us.** Measured 2026-08-03, replying to a third party's announcement:
  `X API 403 {"detail":"You can only reply to or quote posts where you are
  mentioned or are the author.","title":"Authorization Error"}`. So the
  **trailing-URL trick is a real workaround, not merely a formatting choice**:
  append a status URL as the LAST line of an ordinary post and X renders a true
  quote embed, because it is plain text and never touches the restricted params
  (verified working the same day, post 2084308190158536735). To respond to
  someone else, that is the only route — there is no reply equivalent, and a
  trailing-URL post is a BROADCAST rather than a threaded reply, which is a
  different social act and needs the operator's OK on those terms.
  This entry has now been wrong in BOTH directions: it once said "Free tier:
  POST /2/tweets + GET /2/users/me only", and was then over-corrected to
  "`--reply-to` works against ANY public post … verified live 2026-07-31" on the
  strength of a single reply that must have been to a post mentioning us. Both
  claims were acted on and both failed. Do not infer the tier or the permitted
  targets from this file — a paid plan does NOT imply unrestricted replies, and
  the only reliable check is a dispatch that either posts or 403s. Reading posts: `x-read.yml` (credential-free, fxtwitter →
  vxtwitter from the runner) remains the easiest path and needs no API quota;
  the mirrors are also reachable from a local terminal. Char counting: X weighs EVERY URL at 23 chars (incl. bare
  `agent402.tools`); tweet.js's guard counts raw length, so copy that's ≤280 weighted but
  >280 raw needs `force`. **`announce.yml` dispatch (ref main) posts with NO repo
  commit** — inputs: `text` (inline copy) | `file` | `media` | `card` = `bestsellers`
  (burner buy), `robinhood` (free /api/revenue → `scripts/robinhood-card.js`) or `proof` (free /api/proof → `scripts/proof-card.js`: latest external metered receipt, else the canary row labelled ours - the weekly proof post) |
  `quote`/`reply_to` (own posts only) | `delete_id` (replace flow: delete runs first) |
  `force`; every input rides an env var (N-03), never shell interpolation; a dispatch
  with neither `text` nor `file` is refused (the trigger-announce fallback is for the
  push path only, else a bare dispatch reposts stale copy). Cards render LIVE at post
  time (real-numbers doctrine; `--preview` fixture tag for layout checks only). The
  **/tweet skill** (`.claude/skills/tweet/SKILL.md`, committed via the `.gitignore`
  carve-out `!.claude/skills/`) carries the playbook + house style: no em dashes,
  evergreen counts, ALWAYS explicit user OK before any post. **Tweet copy is never
  committed** - it rides the dispatch `text` input only (docs/announcements files
  are the legacy push-trigger path; card PNGs under docs/announcements/media are
  fine to commit). No posted-tweet log or conversation state in this file.

- **Programmatic SEC pages + token brief (2026-08-22, reviewed same day):** `/reports/insider/:ticker`,
  `/reports/fund/:manager`, `/reports/dossier/:ticker` plus three crawlable hubs (`src/programmatic-pages.js`,
  `src/programmatic-seeds.js`: 100 tickers + 50 managers, each verified against EDGAR, 253 seeded URLs in
  `/sitemap-reports.xml`). Free teaser from real filings, paid CTA priced from HUMAN_PRODUCTS, Dataset +
  Breadcrumb + Product JSON-LD. **Cost design is the whole game here (free public pages on a paid egress):**
  shape regex before any upstream call; insider/dossier resolve against the 1h-cached `company_tickers.json` so a
  random ticker costs ZERO EDGAR calls; **an off-list FUND slug builds nothing at all** (it would otherwise be one
  live EDGAR full-text-search per unique slug on an unbounded slug space, aimed at the same egress the paid EDGAR
  products use - a builder returning null is a 404 plus a negative-cache entry); positive and negative caches are
  SEPARATE bounded maps (one shared map let a spray of bad slugs evict every seeded page, which then rebuilt
  through a saturated gate and served crawlers "could not be read"); an EDGAR gate of 2 concurrent with a queue of
  8, `while` not `if` so a resumed waiter cannot barge; `EDGAR_FETCH_TIMEOUT_MS` (12s) on every EDGAR socket,
  because a caller-side deadline frees its gate slot while an unbounded fetch keeps running; the limiter PEEKS to
  refuse and spends 1 per render / 2 per EDGAR build at a per-minute budget (number in CLAUDE.local.md), sized so one full-sitemap crawl fits and a spray
  does not, and a 429 carries `Retry-After` (a 429 to Googlebot costs the page in the index); a `degraded` page
  sends `X-Robots-Tag: noindex`; a `partial` page says the filings could not be READ rather than "no filings".
  **`ledgerShell`'s JSON-LD now escapes `<` as `\u003c`** like `jsonScriptTag` already did - a filer name containing
  `</script>` broke out of the block, and that affects every page that puts third-party text in JSON-LD.
  `/api/subscribe` no longer relays a validator's message unless we minted it (`err.buyerSafe`): an EDGAR helper
  puts a slice of the UPSTREAM BODY in there and that route is unauthenticated.
  `src/tools/token-brief-kit.js`: `token-brief` $9 (`POST /v1/token-brief`), one Opus synthesis over five keyless
  Solana probes, grounding-strict, thin-evidence refusals (<2 of 5 sources, or no market AND no holder data);
  WALLET_ONLY + EXPENSIVE_COMPOSITE (so longRunning = EVM exact only) + METERED. Card product `token-brief` $9 and
  `token-monitor` $5/mo (kind `token`, daily free probe, paid re-run only on a changed safety fingerprint;
  liquidity-derived risk NAMES are excluded from the fingerprint or a thin token flaps daily and burns its cap).
- **Review round on the seller-landscape kits (2026-08-22, three lenses: leaks/SSRF/PII, money/economics, abuse/DoS/hygiene):**
  no HIGH left open. PII: served discovery examples for the enrichment + Farcaster tools named a REAL person with a work email,
  title and social handle (same class as the Form 4 example) - all placeholders now, and the offline fixtures with them.
  Prompt injection: third-party free text (RSS headlines, posts, casts, token names/descriptions, page titles) now rides
  `markUntrusted` in crypto-signals / x-data / farcaster-social / solana-intel / site-map (site-crawl already did) via a
  wrap pass at the end of each kit. Money: the price cut left every `maxUpstreamUsd` where it was (research-max was 75% of
  price) - rescaled then, but to figures that were still BELOW measured cost; superseded 2026-08-23 by the measured ladder
  above, which is the one to trust. Monitors at $5/mo cut `MAX_FULL_PER_SUB_30D` (figures in CLAUDE.local.md); `v1-images-fast`/`v1-images-pro`/`v1-videos` joined `EXPENSIVE_COMPOSITE_SLUGS`
  (spend guard + longRunning = EVM exact only: settle-after on SVM/AVM/Tempo is work done, never charged), per-link image
  timeout 120s -> 45s so a timeout precedes billing, `VIDEOS_MAX_WAIT_MS` 240s -> 180s (under x402's 300s
  `maxTimeoutSeconds`), and `SLOW_TOOL_SECONDS` gained the media tiers + site-crawl/site-map. Bounds: site-crawl page cap
  2MB -> 300KB and a global 2-in-flight gate (JSDOM parse is synchronous - the image-pool lesson), CoinGecko a token
  bucket under the Demo plan's shared rate (numbers in CLAUDE.local.md), RSS feeds an in-flight map (a cold burst fanned out N times per publisher), and
  `content-length` refused before `res.text()` in three kits. X page size capped at 25 posts (X bills per post RETURNED, so
  the page size is the cost lever). Hygiene: a literal NUL byte in a test made the file invisible to grep and secret
  scanners; gitleaks allowlist rows pinned to literals.
- **Tokenized real-world assets (2026-09-02, `crypto-markets-kit.js`, five tools on the SAME CoinGecko Demo key):** CoinGecko's
  `/rwas` endpoints (announced 08-31, live-verified on our key the same day: 649 assets = 461 tokenized stocks, 186 ETFs, 2
  commodities; 33 issuers). `rwa-list` $0.003 (whole list, 10-min cache, type/q filters), `rwa-markets` $0.006 (ranked page or
  ids; the market block is the ONCHAIN wrapper's `tokenized_market_data`, not the underlying's listing), `rwa-asset` $0.006
  (`/rwas/{id}` is metadata-only on this plan whatever the query says, so it is joined with the asset's `/rwas/markets` row),
  `rwa-issuers` $0.003, `rwa-issuer` $0.006 (aggregate cap/volume + tokens with contract per platform). `/rwas/{id}/tickers` is
  paid-plan only, not offered. Registered: WALLET_ONLY, test-all NETWORK, the CoinGecko sample family in
  test-non-metered-examples (19 -> 24). test-crypto-markets-kit 274.
- **Second seller-landscape wave (2026-08-22, scope: everything servable right away and profitably on keys already held):** seven more kits, all wallet-only, offline tests in CI. KEYLESS: `crawl-kit.js` (`CRAWL_TOOLS`: site-map
  $0.005 robots+sitemap+homepage links <= 6 fetches; site-crawl $0.02 BFS <= 20 pages/depth 2, robots honoured, SSRF guard on
  every hop incl. redirects, 200+truncated once a page succeeded else 504), `crypto-signals-kit.js` (`CRYPTO_SIGNALS_TOOLS`:
  crypto-news $0.004 from 8 public RSS/Atom feeds with a dependency-free parser + 5-min per-source cache; crypto-indicators
  $0.005 RSI/MACD/EMA/SMA/Bollinger/ATR/VWAP on Hyperliquid candles; crypto-market-pulse $0.004 breadth/OI/funding snapshot),
  `defi-kit.js` (`DEFI_TOOLS`, 10 tools $0.002-$0.003 on DefiLlama's FREE endpoints - yields, yield history, protocols,
  protocol, chains, chain TVL history, stablecoins, stablecoin supply history, fees, dex volume; bulk docs (pools 11MB,
  protocols 8.6MB) fetched once per 5 min and trimmed; `/bridges` and `/overview/derivatives` are 402-paywalled, not built).
  EXISTING KEYS: `crypto-markets-kit.js` (`CRYPTO_MARKETS_TOOLS`, 12 CoinGecko Demo-plan gaps at $0.005-$0.008 vs a reseller's
  $0.06 - token price by contract, coin profile/history/ohlc/range, categories, global-defi, exchanges/tickers/rates, search,
  coins-list; `top_gainers_losers` is Pro-only, skipped; 60s-10min caches), `alchemy-data-kit.js` (`ALCHEMY_DATA_TOOLS`, 6 tools
  $0.002-$0.005 on `ALCHEMY_API_KEY`: asset-transfers, token-balances (named list + capped metadata fan-out), token-allowance,
  tx-receipt (one batched RPC, transfer events decoded locally), block-receipts, token-price-history; one request per call,
  CU-bounded), `farcaster-social-kit.js` (`FARCASTER_SOCIAL_TOOLS` + `farcasterSocialEnabled()` on NEYNAR_API_KEY |
  WARPCAST_API_KEY - prod has WARPCAST only, the alias is load-bearing; listed only with a key: fc-cast-search, fc-channel-feed,
  fc-trending (trending CHANNELS - Neynar's /feed/trending no longer exists), fc-user-casts, fc-cast, fc-cast-replies,
  fc-channel, fc-user-search, fc-cast-metrics, $0.003-$0.005), and `llm-images-fast-kit.js` (`IMAGES_FAST_TOOLS` on
  OpenRouter's dedicated Image + Video APIs, flat per-image pricing, all-or-nothing billing: `/v1/images/fast` $0.02
  (flux.2-klein-4b $0.014 -> gpt-image-1-mini medium), `/v1/images/pro` $0.05 (flux.2-pro $0.03 -> qwen-image-3 1K),
  `/v1/videos/generations` $0.20 (veo-3.1-lite, 4 s locked, 720p, no audio, $0.12; submit -> poll <= 240 s -> authed
  download -> inline b64 mp4); each link re-checks the model's LIVE listed price against the bound it was priced from and is
  skipped when repriced, chain repriced end to end -> 503 with nothing spent; `v1-videos` is in `LONG_RUNNING_SLUGS`
  (server.js: EVM exact only like the composites, since it runs 40 s+ settle-after). Live measured before pricing: klein
  $0.014 / 2 s, flux.2-pro $0.030, veo-lite 4 s $0.12 / 40 s. Registration helper pattern for a new kit: import + spread in
  ALL_KIT, slugs in WALLET_ONLY_SLUGS, routes in test-all NETWORK, test step in deploy.yml; a `slug:` regex over a kit file also
  matches example INPUTS named slug (defi-kit) - derive slugs from routes.
  A key-gated tool ALSO needs its slug in `METERED_SLUGS` (`scripts/test-non-metered-examples.js`): that sweep treats a 503 as a
  HARD failure (the lenient-NETWORK hole that once hid gov-data), so a tool whose key CI deliberately lacks fails the run until it
  is excluded there like every other keyed tool. Nine such failures (alchemy-data x6, images/video x3) blocked the 2026-08-22
  wave-2 deploy.
- **Seller-landscape builds (2026-08-22, from the x402scan/MPPScan top-seller research):** four kits. KEYLESS and listed:
  `src/tools/derivatives-kit.js` (`DERIVATIVES_TOOLS`, 11 tools $0.002-$0.005: perp-markets/funding/funding-screener/
  open-interest/klines/orderbook/basis on Hyperliquid's public info API, options-summary / crypto-options-chain / options-ticker on Deribit public (finance-kit already owns `options-chain` for equities),
  options-volume on DefiLlama - its `/overview/derivatives` is paywalled 402, so only options volume ships) and
  `src/tools/solana-intel-kit.js` (`SOLANA_INTEL_TOOLS`, 9 tools $0.002-$0.01: sol-token-safety/report/holders on RugCheck
  + Jupiter audit, sol-token-pairs/search/trending on DexScreener, sol-price/swap-quote/token-lookup on lite-api.jup.ag;
  public Solana RPC getTokenLargestAccounts 429s persistently, so holders come from RugCheck). ENV-GATED (listed only with
  the key, like TTS): `src/tools/x-data-kit.js` (`X_DATA_TOOLS` + `xDataEnabled()` on `X_BEARER_TOKEN`; X API v2 app-only:
  x-search-recent $0.08, x-user $0.015, x-user-tweets $0.08, x-tweet $0.008, x-users-lookup $0.15 (repriced 2026-08-27); 429 -> 503 with the
  reset hint) and `src/tools/b2b-enrich-kit.js` (`b2bEnrichEnabled()` returns the subset whose key is present:
  hunter-domain-search/email-finder/email-verify/company on `HUNTER_API_KEY`, apollo-people-search/org-enrich/person-match
  on `APOLLO_API_KEY`; PII-stripped; $0.02-$0.05). All 32 slugs in WALLET_ONLY_SLUGS + test-all NETWORK; offline tests
  `test-derivatives-kit` (327), `test-solana-intel-kit` (169), `test-x-data-kit` (102), `test-b2b-enrich-kit` (164) in CI.
  The env keys are the operator's call (X paid plan bearer exists only in Actions secrets today; Hunter/Apollo need signups).
- **Report pricing, re-derived from MEASURED spend (2026-08-23, `scripts/test-report-margins.js`):** the earlier cut had
  been set against the kits' DECLARED `maxUpstreamUsd` figures, which were fiction. PostHog `$ai_generation` over 30 days
  (114 opus-5 synthesis calls, the model every report kit uses) measures **avg $0.107, p95 $0.195, MAX $0.311**, plus
  ~$0.01 per gemini planning call. Every declared cap at the time ($0.13-$0.34) sat at or BELOW the p95, and three
  products were priced BELOW the observed maximum - recall $0.25, domain-audit $0.30, token-risk $0.30 - so a worst-case
  run LOST money. A fictional cap is not merely cosmetic: research-deep is the one kit that reads its own field, and it
  downgrades the synthesis model when spend exceeds it, so an under-set cap silently degrades the product too.
  **Ladder now (agent price / cap):** base $0.60 / $0.35, pro $0.85 / $0.50, max $1.10 / $0.65, ticker-pack $2.00 / $1.20
  (three syntheses). base = recall, domain-audit, token-risk, token-brief, fund-report, insider-report, research;
  pro = domain-audit-pro, token-risk-pro, fund-report-max, dossier, research-pro, market-brief, filing-report;
  max = research-max, dossier-max. **Card** must clear Stripe's 2.9% + $0.30 BEFORE the report is paid for (a $1 charge
  nets $0.671, which the deep tiers ate), so the card floor is **$2**, $3 for max tiers, $5 for the pack (the derived card ladder: agent <= $0.60 -> $2, <= $0.85 -> $3, <= $1.10 -> $4, else $5). **Monitors $5/mo**:
  one fee funds up to `MAX_FULL_PER_SUB_30D` paid runs, so the rule is net >= 2x the worst-case month, not a percentage.
  Every rail now clears 40%+ at measured worst case. Prices live in THREE places that must move together: kit
  `*_TIERS[...].price` (x402/MPP list), `HUMAN_PRODUCTS[...].price` cents (card), `MONITOR_PRODUCTS[...].price`; docs are
  checked by `test-docs-truth` (price per slug vs live catalog) and the economics by `test-report-margins` (in CI,
  4 mutations killed). The measured figures in that file are OBSERVATIONS: when the model mix or model pricing moves,
  re-measure and update them - never tune them to make a price look acceptable.
- **Machine-surface sync for products + credits (2026-08-22, batch A):** `/api/pricing` carries `credits`
  (packs) + `humanProducts` (reports/monitors) next to the catalog; `/openapi.json` is 2.1.0 with
  `securitySchemes` x402 / mpp / creditsKey (bearer `a402_…`) + `x-guidance`; `/llms.txt` has credits + reports
  paragraphs (FULL paths only - `test-mcp-self-consistency` extracts every `/path` token, so shorthand like
  "/pro, /max" or a path followed by ":" reads as a route); receipts (`/r/`, `/m/`, thanks pages) send
  `X-Robots-Tag: noindex` + `<meta name="robots">` via `ledgerShell({robots})`; robots.txt Disallows them;
  sitemap lists /reports /monitors /credits; homepage FAQ is 6 Q&As (visible == JSON-LD, pinned by
  test-home-page + test-index-page); hosted (`src/mcp-flagship.js`) and stdio (`mcp/output-schemas.js`)
  initialize instructions are separate copies that `test-surface-copy` requires byte-identical - edit both.

- **Margin-clamp corrections (2026-08-23, from a platform sweep):** two errors in our own cost model, both
  verified against primary sources the same day. (1) `MODEL_COST` carried a blanket `anthropic/claude-opus` at
  $15/$75; live pricing is $5/$25 for opus-5 and 4.5-4.8, and only opus-4 / 4.1 are still $15/$75, so the premium
  tier was shrinking `max_tokens` about 3x more than needed. Specific rows added (longest prefix wins) INCLUDING
  the `-fast` twins, which cost MORE than their base model (opus-5-fast $10/$50, opus-4.7-fast $30/$150) and would
  otherwise be underpriced by a shorter row. (2) The clamp counts the outbound body with o200k BPE, but Anthropic
  states "Claude 4.7 and later models ... use a newer tokenizer [that] produces approximately 30% more tokens for
  the same text" (their pricing page, read 2026-08-23), so we were UNDERCOUNTING input on exactly the priciest
  models - loose in the unsafe direction. `tokenizerFactor()` (1.35, a little over the stated 30%) now rides beside
  `cacheWriteFactor` and applies only to Claude 4.7+; Sonnet 4.6 and earlier and every non-Anthropic model take 1.
  Also: CoinGecko removes the `community_data` / `developer_data` BLOCKS on 2026-08-28, and crypto-markets asked
  for one; the two figures it surfaces are top-level and survive (probed live), so it stops requesting the block.
  `railway.toml` gained `overlapSeconds = 20` - Railway's default is 0, which lets a request reach a container that
  is already going away, the residual cause of the deploy blips that turned /status amber.

- **MCP tasks for the long products (2026-08-23, `src/mcp-tasks.js`):** the report composites run 30 s to 4 min,
  which a blocking `tools/call` cannot hold, so they were effectively unsellable on the connector. The connector now
  speaks the CURRENT spec's tasks EXTENSION (`io.modelcontextprotocol/tasks`, revision 2026-07-28): a long call
  returns a handle, the client polls `tasks/get`. Implemented BY HAND: the installed SDK (1.30.0) is on
  `2025-11-25` and ships the older CORE tasks feature (`tasks/result`, nested `task`, `params.task` opt-in), which
  is wire-incompatible with the extension (flat shapes, `resultType` discriminator, result inlined into
  `tasks/get`, `ttlMs`/`pollIntervalMs`, no `tasks/result`). The server decides; a client opts in per request via
  `_meta` and a server MUST NOT hand a task to one that did not.
  **Settlement does not move:** the loopback IS the paid request, so a failed/cancelled/orphaned task produced a
  non-200 and settlement was cancelled - nobody is charged, and the refund ledger is deliberately NOT wired to
  ordinary failures because nothing was taken. A ~8 s gate window runs first so a 402 is always answered
  synchronously: **a task is never minted for a call that has not cleared the paywall.** The record is on the
  volume, the RUN is in one process, so a boot sweep resolves orphans to `failed` truthfully. Per the extension,
  a tool error is `completed` + `isError` (never a silent empty success); only JSON-RPC errors are `failed`.
  Composites only, `AGENT402_MCP_TASKS=off`. `scripts/test-mcp-tasks.js` (77, 5 mutations killed - two of which
  initially SURVIVED because the test calls finished inside the gate window and so proved nothing).
- **MPP subscriptions (2026-08-23, `src/mpp-subscriptions.js`):** monitors were card-only; a wallet can now
  subscribe over `tempo/subscription`. Three things the docs got wrong and the code did not: `chargeModes` belongs
  to tempo/CHARGE, not subscription (a subscription is always a server PULL); `periodUnit` has no `month`, so
  $3/month is `periodCount 30, periodUnit "day"`; and **there is no relay path** - a subscription charge is a
  `transferWithMemo` signed by a server-held ACCESS KEY straight to a Tempo RPC, so "we hold no Tempo signing key"
  is no longer true and this module is the exception. The buyer's own signature scopes that key to one token, one
  selector, our payTo, a per-period limit and an on-chain expiry, and the tx sends from THEIR account so they pay
  their own gas. Measured hazard: `verifySubscriptionKeyAuthorization` accepts a signature over an
  ATTACKER-CHOSEN access key when you do not pass one (it falls back to the credential's echoed key), so we always
  pass the key we hold the private half of. Billing is pulled from `refreshStatus()` - the same gate the scheduler
  already calls before every paid run, so "are they paid up" and "charge them" are one answer. A failed period is
  `past_due` (free probes continue, no paid report), 1h backoff doubling to 24h, `canceled` after a 7-day grace.
  Every unpaid 402 mints a keypair, so unclaimed offers are swept and minting refuses past a ceiling.
  `MPP_SUBSCRIPTIONS=off`; gated on MPP_SECRET_KEY + a recipient + **a gas sponsor**, NOT on TEMPO_API_KEY (no relay).
  **THE RAIL NEEDS A FEE PAYER, proven live 2026-08-23 by the canary's first three runs.** With no relay in the path
  nothing sponsors the transaction's gas, and mppx's two code paths are NOT equivalent: with a fee payer it builds the
  tx through `prepareTransactionRequest` (which populates gas + fee fields), without one it calls `signTransaction` on a
  bare request that carries none. viem does not fill them in, so the unsponsored tx is signed with a ZERO gas price and
  Tempo refuses it - `-32000 details="gas price is less than basefee"` (basefee 0.6 gwei), pinned at the byte level:
  the serialized tx reads `821079 80 80 80`, chainId 4217 then three empty fee fields. mppx's fee-payer URL form is
  wired for tempo/CHARGE only (`Subscription.createContext` reads `feePayer`, never `feePayerUrl`), so a sponsorship
  URL is not an option and an ACCOUNT is required: `TEMPO_SUBSCRIPTION_FEE_PAYER_KEY`, a dedicated Tempo wallet holding
  gas, NEVER the treasury or the CI burner. **We pay the gas for every activation and renewal** - the earlier claim here
  that "the tx sends from THEIR account so they pay their own gas" was wrong about who funds it. `mppSubscriptionsEnabled()`
  now REQUIRES the sponsor: with no key the routes do not mount at all, because every subscribe would 402 forever and
  `/api/mpp/monitors` would be advertising a product we cannot deliver. the operator owes the funded key before this rail is live.
  **Sponsored-gas policy:** mppx's default fee-payer policy caps `maxGas` at 2,000,000 and its own docs point at the
  override when the access-key tx needs more; an ACTIVATION installs the key as well as moving the first period, so we
  pass `feePayerPolicy: { maxGas: 6_000_000 }` (`SUB_FEE_PAYER_MAX_GAS`, env knob `MPP_SUB_FEE_PAYER_MAX_GAS`, a
  malformed/zero value falls back rather than widening or voiding the policy). Deliberately generous, because the gas
  ceiling is NOT the money bound - mppx's untouched `maxTotalFee` is, refusing anything over $0.05/tx however far gas
  moves. **What sponsoring actually costs, measured on-chain, not estimated:** fees settle in USDC.e (the receipt's
  `feeToken`) and gas x price converts to token units at ~1e12 - a real charge tx used 46,575 gas at 0.6 gwei and was
  charged **28 units, $0.000028**. **The sponsor wallet must hold PATHUSD, not USDC.e** (measured: a sponsor funded with
  1 USDC.e and 0 PathUSD was refused `-32003 insufficient funds for gas * price + value: have 0 want 4859`). A SPONSORED
  transaction pays its fee in Tempo's default token because mppx's subscription `complete()` returns no `feeToken`, so
  nothing overrides the default - USDC.e is what the PRODUCTS are priced in, PathUSD is what the GAS is paid in, and
  funding the wrong one looks exactly like an empty wallet. `fund-tempo-fee-payer.yml` takes a `token` input and
  defaults to pathusd for this reason. Activation measured ~4,859 units = $0.0049; a renewal is far less. So a renewal costs us ~$0.00003 and the 6M ceiling is worth $0.0036; against $5/mo
  that is noise, and the earlier framing of this as a meaningful ongoing cost was wrong. Note also that the receipt's
  `feePayer` equals `from` on the working charge rail (the buyer self-pays; Tempo's relay does NOT sponsor), and that
  Tempo's `eth_getBalance` returns a SENTINEL (`4242...` repeating) - native gas is abstracted, so the sponsor wallet
  needs USDC.e, not a native balance.
  Diagnostics lesson, the third time on this rail: viem puts the server's words in `details` and the whole outbound
  request in `message`, so a message-first log truncated the one line that mattered (`diagnoseError`, cause first).
  **LIVE CANARY (2026-08-22, `scripts/tempo-subscription-canary.js` + `tempo-subscription-canary.yml`,
  dispatch-only):** proves BOTH halves against production with the existing EVM canary burner. Activation is
  charge-shaped (402 -> key authorization -> period 0 settles). The half worth proving is the RENEWAL: no buyer is
  present, our server signs with the delegated access key and broadcasts straight to a Tempo RPC, so unlike the
  charge rail there is NO relay verdict to read and NO confirm-fallback - a wrong wire here means a subscription
  silently stops billing (we serve for free) or bills wrong. A 30-day period puts that beyond any canary, so the
  canary buys a dedicated `rail-canary` product billing in mppx's `dev_second` unit (`CANARY_PERIOD_SECONDS`,
  default 60), waits for period 1 to come due, and drives `refreshStatus` via `GET /api/mpp/monitors/:id?refresh=1`
  - accepted ONLY for canary subscriptions, read from the STORED record, so a real subscriber's pull stays
  scheduler-driven. It asserts a NEW on-chain reference, not just an advanced counter, and always cancels (a canary
  that leaves standing authorizations behind is its own slow leak). Cost ~2 x $0.01 to our own payTo plus Tempo fees.
  **Two structural safeties, both mutation-tested, neither a flag anyone can set:** `rail-canary` is NOT in
  `MONITOR_PRODUCTS`, and `listActive()` skips any record whose product is absent there - so a canary subscription
  can never reach the monitor scheduler, produce a paid report or send an email; and it is mintable only for a
  caller carrying the POW_SECRET-signed heartbeat token (`isSyntheticRequest`), with an ungated ask answering the
  same generic "Unknown monitor product" 400 as any unknown string, so the gate confirms nothing. The period
  override keys off the RESOLVED product, never the caller's flag - the first draft keyed off the flag, which would
  have put a real $9 monitor on a 60-second period for any token holder, and `scripts/test-mpp-subscriptions.js`
  caught it before it ran once. `scripts/test-mpp-subscription-canary-gate.js` (10, boots a real server, in CI)
  covers the route half the engine test cannot see. **PROVEN END TO END 2026-08-23** (run 32653047928): activation
  tx `0xaaf929549236534372664f73d6a7dce08f29b9877cdd48972809beae0a8b6594`, renewal pulled with no buyer present
  tx `0x2d32927aa891d70dcafa232e77bc67af78c60652314f0c2df59e60a910d981cf`. **Now SCHEDULED daily** (06:37 UTC),
  paging heartbeat-style, because a broken renewal does not error loudly - it serves a subscriber for free until
  their grace window ends. Four defects preceded that green run and every one needed the LIVE rail to surface: the
  unsponsored zero-gas-price path, mppx's 2M `maxGas` default, funding the sponsor in USDC.e when gas is paid in
  PathUSD, and `renewSubscription` never receiving the sponsor at all (a standalone entry point that builds its own
  context, so the fee payer configured on the method did not reach it). 122 offline assertions were green
  throughout: stub-proven is not proven.
- **Server tools under a server-owned bound (2026-08-23, supersedes the 2026-08-04 blanket refusal):** the chat wire
  now allows exactly three OpenRouter server tools on the PRO and PREMIUM tiers - `openrouter:web_search`,
  `web_fetch` and `datetime` - because each has a published per-use price AND a hard `max_uses` count cap. We pin
  every cost-bearing field ourselves (`engine:"exa"` on search, never `auto`, which falls through to a
  provider-priced native path; `engine:"openrouter"` on fetch, the only free one; `max_uses`, `max_results`,
  `max_characters`, `max_content_tokens`) and the pinned object REPLACES the buyer's rather than merging, so
  widening is structurally impossible. Buyer `stop_server_tools_when` and `max_tool_calls` are refused by name, not
  silently dropped - a caller must never believe they set a budget they did not.
  **`max_cost` is a belt, not the bound:** OpenRouter's own schema says it stops the loop once cumulative cost
  "exceeds" the threshold and then still executes pending tool calls plus one final turn, so it OVERSHOOTS. The
  real bound is the count cap times the published per-use price, folded into `fixedUsd`, with `turns = steps + 1`
  multiplying both the re-billed transcript and the output side. Still refused, each with its reason:
  `subagent`/`advisor`/`fusion` (they spawn model calls on a model the CALLER names), `mcp` (buyer-supplied
  `server_url` returns arbitrarily large payloads with no content cap, from our account), `files` (reads our own
  key's workspace), `shell`/`bash`/`apply_patch` and anything with no published price, and the OpenAI shorthand
  `web_search`, which converts upstream into a form that hands the engine back to the caller. Server-tool requests
  are never cached (the web moves). Base/nano/auto tiers 400 with guidance: one Exa search is $0.007, which is the
  entire 70% budget of a $0.02 request. `scripts/test-server-tools.js` (117).
- **Grounding context (2026-08-23):** `llm-context` $0.02 (`POST /api/llm-context`, `src/tools/llm-context-kit.js`)
  on Brave's LLM Context API, using the SUBSCRIPTION TOKEN WE ALREADY HOLD - one call returns ranked, pre-extracted
  grounding chunks instead of links to fetch. Verified live 2026-08-23: 18 chunks from 10 hosts in 425 ms. Chunks
  are third-party web text so the result rides `markUntrusted`. UNCONFIRMED whether it bills as a Search unit or a
  separate plan; priced at $0.02 to match `search`, which is safe under either reading - re-price from the invoice.
  It also exposed a hole in `test-brave-leak.js`: reach was resolved only by IMPORT of search.js, so a new
  Brave-backed kit would have slipped the CI-spend guard and bought live queries on every run. The guard now also
  resolves by upstream HOST, mutation-tested both ways.
- **Stripe shadow ledger (2026-08-23, `src/stripe-shadow-ledger.js`, OFF by default):** records settled on-chain
  payments into Stripe as `transaction_verification` PaymentIntents so card and crypto revenue could eventually
  share one set of books. NOT a source of truth and structurally unable to become one: `record()` is synchronous
  and returns undefined (cannot be awaited into a request), disabled means no db file and no timer, every network
  call is on an unref'd drain, and a test asserts a request's status and body are identical across five worlds
  (disabled, success, Stripe 402, fetch throws, store broken). Idempotent on the tx hash. **Expect rejections:**
  Stripe's docs say payments should land on a Stripe-controlled deposit address and our payTo is our own treasury
  wallet, so the first week is an experiment, not an integration - a wall of one rejection code is the ANSWER, and
  it would mean unifying the books requires changing our payTo, a treasury decision. Also: Stripe's floor is $0.01
  so most of the $0.001 catalog is unpostable (never rounded up - that would fabricate an amount), only base,
  solana and tempo of our twelve rails are supported, and synthetic canary traffic is skipped as internal.
  `GET /__operator/shadow-ledger.json` reports both sides for the week-long comparison. `STRIPE_SHADOW_LEDGER=on`.

- **Published packages are verified against LIVE prod (2026-08-23, `scripts/verify-published-packages.js` +
  `verify-published-packages.yml`):** every other package test runs from the WORKING TREE, which proves the source
  is good and cannot prove that what people `npm install` works - publishing is a separate act with its own failure
  modes (a missing `files` entry, a stale registry version, a dependency resolving differently outside this repo, a
  package never republished after the surface it talks to moved), all invisible to a source test and visible to the
  first user. This installs `agent402-mcp@latest` + `agent402-client@latest` FROM THE REGISTRY into a scratch dir
  and drives real prod: MCP `initialize` over stdio, `tools/list`, the catalog tools an agent needs, a live
  `catalog.search`, and the SDK's `find()`. Read-only and free (it never buys, so it can be scheduled; the paid
  path stays the paid canary's job). Daily 07:23 UTC, after every successful Deploy, and on dispatch; pages
  heartbeat-style. First run: agent402-mcp@0.13.0 + agent402-client@0.7.0 both green, the server reporting 627
  tools - confirming the packages embed no tool list (`toolCount` is derived), so new tools reach users with no
  release. **`scripts/test-workflow-run-refs.js`** guards a class this shipped with: GitHub matches
  `workflow_run.workflows` on a workflow's `name:`, not its filename, so a mismatch NEVER FIRES and does so
  silently - the verifier first referenced "Deploy" when the workflow is "Deploy to Railway".

- **`maxUpstreamUsd` is now ENFORCED, not merely declared (2026-08-23, `src/report-tiers.js` +
  `recordCompositeUsage`):** it was a declared bound in 8 of the 10 report kits - only research-deep and
  ticker-pack read their own field at runtime - so the number was a comment nothing checked, which is how it
  drifted below measured cost and how three products ended up priced under their own worst case. Every report kit
  already reports through `recordCompositeUsage`, so the check lives THERE: one place, no per-kit wiring to forget.
  A breach increments `overCap` (total and per-slug), records what was spent AND the ceiling it broke, logs once
  with both numbers, and rides PostHog `composite_usage` flagged; totals are on `GET /__operator/human-checkout.json`
  as `compositeUsage`. It deliberately CANNOT abort - a single-synthesis report only knows its cost once the call has
  returned and been paid for, so aborting would discard work already bought; the structural bounds (one locked model,
  bounded `synthMaxTokens`, bounded inputs) remain what stops a runaway call, and this stops a breach being SILENT.
  Spend exactly AT the cap is not a breach, and a non-report slug is never flagged. The lookup is DEFERRED because
  the registry imports every kit and the kits import the guard: a static import is a cycle whose symptom is a TDZ
  error at boot rather than anything that looks like one. `scripts/test-composite-cap-enforcement.js` (21, in CI,
  2 mutations killed).
- **Subscription gas sponsor has a low-water alarm (2026-08-23):** `subscriptionFeePayerStatus()` on
  `/api/gateway-status` as `subscriptionFeePayer`, plus a heartbeat leg opening "Subscription gas sponsor LOW
  (PathUSD)". It watches **PathUSD, not USDC.e**, and that is the whole point: a sponsored tx pays its fee in
  Tempo's default token, so a sponsor full of USDC.e and empty of PathUSD is EMPTY for this purpose and the chain
  says `insufficient funds ... have 0`. It matters more than it looks - an empty sponsor fails ACTIVATIONS loudly
  (402, nobody charged) but sends RENEWALS to past_due, so existing subscribers keep being served for free until
  their grace window ends. Bucketed like every other balance (numbers never leave), unreadable is "unknown" never
  "ok", low-water `TEMPO_SUBSCRIPTION_FEE_PAYER_LOW_USD` (default: see CLAUDE.local.md). Top up with `fund-tempo-fee-payer.yml`
  and `token=pathusd`.

- **Prices quoted in PROSE are derived and guarded (2026-08-23, `scripts/test-price-prose.js`):** the repricing
  moved prices in the three places that SELL (kit tiers, HUMAN_PRODUCTS, MONITOR_PRODUCTS) and missed the prose that
  QUOTES them: for a full day `/reports` advertised "$1 or $2 by card and $0.20 to $1.10 for an agent" and
  `/monitors` advertised "$3 a month", in the meta AND og:description of both - i.e. what Google and every link
  preview show. `test-docs-truth` could not see it: it checks the price stated beside a ROUTE, never a sentence.
  Both strings are now DERIVED from HUMAN_PRODUCTS / MONITOR_PRODUCTS / `priceUsdFor`, and the guard fails on any
  dollar figure in a page description that is not a real product price (mutation-tested with the exact two strings
  that shipped). When adding a page that quotes a price in copy, derive it or add it to this guard.
- **The host's own entry on the discovery surfaces (2026-08-28, `src/host-entry.js`):** the marketplace, both leaderboards and
  `/api/index` rank OTHER sellers and keep the operator out of the ranked lists, the router's external pool and every seller
  count on purpose (an index that ranks itself first proves nothing, and our on-chain volume is mostly our own canary and
  volume runs) - but that left the host with no honest entry at all (`/api/index?seller=agent402.tools` answered "not
  found"). Now `hostFigures()` reads the sales ledger's OWN external classification (`salesSummary`, 30 days + all time:
  settlements, distinct buyers, tools sold; never internal/synthetic rows, never recomputed) and renders it OUTSIDE every
  ranking: a labelled card above the `/marketplace` roster ("this site, not ranked, not counted"), external-only rows plus the
  exclusion note in `/leaderboard`'s "our own row, disclosed" panel and a pinned unnumbered row under its table, a pinned row
  under the MPP board's ranked table, and `GET /api/index?seller=<host|origin|BASE_URL>` answering `self:true` with the same
  figures + links (built from the ledger and catalog, never from the crawl cache; `isSelfOrigin` still excludes the crawled
  self-entry from the external pool). The roster's existing pinned THIS HOST card and the MPP board's self-flagged ranked row
  are unchanged. Pins: test-marketplace-index-page (32), test-leaderboard-page (30), test-mpp-market-page (20),
  test-self-listing-exclusion (host entry built without the cache), test-shortlinks (booted `self:true` for host, origin and BASE_URL).
  **Per rail (same day):** every chain page (`/base` ... `/stellar`, `/algorand` through their wrappers) carries the same card
  with THAT rail's outside settlements and distinct buyers only (`externalByNetwork({days})` in sales-ledger, CAIP ids collapsed
  to the rail key; `hostFigures({network, byNetworkFn})`), labelled "outside buyers on <Chain> only"; the all-chains page keeps
  the all-rail totals. Pinned in test-marketplace-index-page (35) and test-sales-ledger (74).
- **Router dispatch eligibility is LABELLED on every public row (2026-09-02, `src/dispatch-eligibility.js`):** an outside
  public-facts readout (a buyer-agent tooling founder, at our request; kept in the private dir) showed a buyer agent
  over-reads `routable` + `health` + `networks` + Bazaar counts + `executeVia` as "Agent402 will pay this seller now" -
  measured on the day's snapshot: 84 sellers routable with NO networks, 946 with networks + health 1 but routable false,
  816 routable with no settlement count, route rows carrying executeVia with no networks. Now ONE function,
  `dispatchEligibility()`, is both the resolver's Base gate (`.chains.base.eligible`, replacing the raw meetsRouterGate
  call there) and the label on `/api/index` sellers + `?seller=` detail, every `/api/route` row (`withDispatchFields`,
  row-level price/template checks) and the marketplace/chain rosters (`withDispatchSnapshot`, badge + legend). Fields:
  `routerDispatchEligible`, `routerDispatchReason` (crawl_failed > network_unknown > no_supported_route > url_template >
  price_unknown > settlement_required | settlement_checked_at_pay_time (Solana/Algorand/Tempo: the chain is read at pay
  time) | eligible | local_catalog), `routerDispatchByChain`, `paymentNetworksKnown`, `networks` ALWAYS an array; both
  envelopes carry `legend`/`dispatchLegend` (routable = crawl readiness, never a promise to pay). Evidence maps are the
  resolver's own builders memoized 60 s (`dispatchEvidence`). `scripts/test-dispatch-eligibility.js` (offline, readout rows
  as fixtures, resolver call site pinned from source) + booted pins in test-shortlinks + page pins in
  test-marketplace-index-page. A row the handler did not label renders NO badge, never a guessed one.
  **`executeVia` is an affordance, gated on the verdict (2026-09-02 evening, the readout's second pass):** a `/api/route`
  row the router will not pay right now no longer carries `executeVia` (a buyer agent read it as a callable action); the
  tier moves to `executeViaWhenEligible` and `executeViaCallableNow` says false in so many words, eligible rows keep
  `executeVia` + `executeViaCallableNow: true`; legend entries for all three. Pinned booted in test-shortlinks and from
  source in test-dispatch-eligibility.
  **Row-level network inheritance (same day):** the live check showed api.strale.io's ranked row (`/x402/v2/image-to-text`,
  $0.054, 3,769 Bazaar calls) as `network_unknown` because the seller's OpenAPI documents the priced v2 paths while only its
  manifest rows carry accepts, so the router never dispatched to it. `decoratedRemoteTools` now gives a row with NO observed
  accepts its SELLER's known networks (own tools + Bazaar union, the same union the index seller row shows) flagged
  `networksInferred: true`; a seller with nothing known anywhere stays unknown. Money-safe because payX402 pins the accept
  from the live 402 before signing. Pinned in test-route-network-filter.
- **Router aliases + short-term token rule (2026-08-28, from an outside email that had the facts wrong but the symptom right):**
  `/api/route?q=ip geolocation` ranked a $0.05 external seller above our $0.003 `asn-info` ("ASN + IP geolocation"): the
  lexical scorer weights the SLUG, and ours says neither word; worse, the two-letter term "ip" substring-matched gzip /
  gunzip / html-strip (+4 each). Now a tool may declare curated `aliases` (scored exactly like the slug, max per term, never
  additive; carried by `buildLocalEntry`; asn-info: ip-geolocation, geoip, ip-lookup) and a term under three characters
  matches whole tokens only. Neutrality unchanged (no local boost, aliases are the tool's own declared names).
  `scripts/test-route-aliases.js` (8, offline, in CI). When a common query routes past a tool we sell, add an alias, not a boost.
  **The bigger defect found by sweeping every tool name through `/api/route` (538 queries):** an outside seller ranked FIRST for
  250 of them, and for "json to csv" our own `json-to-csv` sat 23rd behind 22 equally scored, equally priced copies - the
  2026-08-19 Bazaar-quality tie-break read local rows as ZERO payers (our origin is never in the index map), so any seller
  with one Bazaar payer outranked our identical tool. Now a local row is measured under `SELF_BAZAAR_ORIGIN` when the feed
  carries it, and when it does not the quality comparison is skipped for that pair (a missing measurement is not zero);
  external-vs-external ordering is unchanged. Re-run the sweep after deploy (the recipe is a 20-line node loop over
  `/api/pricing` endpoints -> `/api/route?q=<name>&top=3`) and expect the outside-first count to fall to genuine cases
  (cheaper or better-matched sellers).
- **16 pure-CPU / free-upstream tools cut to the floor (2026-08-28, priced against comparable listings):**
  measured first - against PROVEN outside peers (Bazaar payers30d >= 3, equal route score) we were cheaper on 80 tools,
  equal on 37, pricier on 36; two-thirds of the 36 carry real upstream cost (Brave, E2B, CoinGecko, LLM) and stay. The
  sixteen with no marginal cost moved to $0.001 (json-diff, robots-check, tls-cert, spf-check, dmarc-check, ens-resolve,
  polymarket-orderbook, perp-open-interest, perp-klines, crypto-orderbook, tx-status, stock-quote, weather-forecast) or
  $0.002 (x402-quote, weather-history, reverse-geocode); the canary's stock-quote leg pin followed. Price is the FOURTH
  route tie-break (match, health, Bazaar payers, then price), so a cut only moves ties; never price an upstream-metered
  tool to beat a peer that is hitting a free API.
- **`/why` = the one-page "what is different" surface (2026-08-26, `src/why.js`, `WHY_POINTS`):** seven first-party
  claims, each linked to the surface that proves it (usage priced under a quoted ceiling / upto settles actual; a failed call
  is never charged + keyed retries never pay twice + charged-but-failed is ledgered; one key buys models on three wires + 500+
  tools + reports; no wallet required; finished reports + monitors; route-and-execute buys on the agent's behalf; proof from
  outside production). NO third-party names or comparisons anywhere in public copy (standing rule); markup
  stays 15% (decided the same day: 15% on OpenRouter cost nets ~9% after their ~5.5% credit fee; 5%/4% would lose money).
  The same seven points are rendered from `whyPointsPlain()` into `/llms.txt` (info paragraph), one line in BOTH MCP initialize
  instruction copies, a README section, the OpenClaw guide + `agent402-openclaw` README (0.3.1) "What else the same key buys",
  a homepage 4-card strip (`.hm-why`) and the footer people column. Edit the points in why.js, then re-read the hand-written
  copies (README / guide / plugin README / MCP line) - those are prose, not derived. `/why` is in the sitemap + `test-static-pages`.

- **Security review of the 2026-08-26 builds (evening, three finders + adversarial filters; fixes in the same-day PR):** HIGH
  (money) the metered quote was computed from `req.body` while the dispatcher served `{...req.query, ...req.body}` with
  `params`/`input`/`args` envelopes unwrapped: `{input:{model:"anthropic/claude-opus-5", messages:[80k chars], max_tokens:8192}}`
  quoted the $0.001 floor (the quoter saw no model) and was served in full ($0.68 of upstream, measured in the test). Now ONE
  construction, `handlerInputOf(req)` (`src/handler-input.js`, memoized on the request), feeds the dispatcher, `quotedPriceUsd`
  and payments.js's x402 price function, AND the metered handler re-quotes the body it serves and refuses 400 (uncharged) when it
  exceeds the stashed gate price (`scripts/test-metered-quote-binding.js`, 14, in CI). MED (money, buyer-adverse) a credits-key
  buyer's keyed retry was DEBITED TWICE: the replay middleware is mounted after the credits gate, so the replayed 200 converted a
  fresh hold (on a metered route at the FULL worst case, no X-Metered-Usd on a replay) - the gate's finish hook now releases on
  `X-Idempotent-Replay: true` like a cache hit, the gate strips `x-pow-solution` on acceptance, and `idemHashKey` binds a
  credits-settled request to its key hash before any unverified header (test-credits 40). MED (CI supply chain) the real-OpenClaw
  install test ran `npm i openclaw@latest` (lifecycle scripts on) and its binary with the job's metered keys in env - the step
  shadows them to "" (F07 shape) and the test spawns with an allowlisted env. Clean: report kits (SSRF through the guard, no
  XML parser, escaped viewer), pages/JSON-LD, deploy.yml expressions, Stellar fallback + RPC failover, plugin proxy, upto selection.

- **Coinbase Business + AgentKit (2026-08-26, from Coinbase's "get paid by AI agents" push):** (1) `agent402-tollbooth` 0.9.3: with
  `TOLLBOOTH_CDP_API_KEY_ID/SECRET` (and no facilitator URL) the CLI settles through Coinbase's facilitator via `@coinbase/x402`
  `createFacilitatorConfig` (optional peer; a static header can never reach CDP, it needs per-request JWTs) - the path a Coinbase
  Business account uses: `TOLLBOOTH_PAYTO` = the account's USDC (Base) receive address (no fee taken from the payment, CDP free tier then per-settlement pricing, figures in CLAUDE.local.md; NOT Bazaar-listed - the CLI's wildcard route carries no discovery extension). The key is validated at boot by minting one JWT.
  **LIVE-PROVEN 2026-08-27** (`tollbooth-cdp-live.yml`, dispatch: PayAI control leg then the CDP leg, burner pays the treasury $0.001):
  CDP tx 0x8175178ac4e2229dfd9385a3c78c491ffe554b08fdf52cf92f99425c983ec5d1. First attempt failed with the facilitator's
  `self_send_not_allowed`: CDP refuses payer == payTo, so no self-pay proof exists on CDP (the control's stub-free PayAI leg
  allowed it). `agentkit-live.yml` PROVED the adapter with a real `ViemWalletProvider` on prod 2026-08-27 (ip-info $0.002, tx
  0x1c0592f73d1f9182ee9bd40eb34d9b6c70b3196814b111589b82df4e79e7fb59); AgentKit's analytics throws an
  UNHANDLED rejection on a non-2xx from its endpoint (HTTP 400 measured), so the proof script ignores unhandled rejections. Guide `/guides/coinbase-business-get-paid-by-agents`,
  example `examples/coinbase-business-tollbooth/`, linked from /sell, /tollbooth, the tollbooth README and wiki Pay-per-crawl.
  (2) `adapters/agentkit` = `agent402-agentkit` (0.1.0): a Coinbase AgentKit action provider (`agent402_find` free, `agent402_call`
  pays - PoW for the free tier, x402 exact-EVM signed by the wallet provider's `toSigner()` + `readContract`, the same derivation
  AgentKit's own x402 provider uses - `agent402_about`); `agent402Actions()` returns the raw defs, `agent402ActionProvider()` wraps
  them with `customActionProvider`; @coinbase/agentkit is an optional peer, stubbed in the test. Test lane + gate/publish steps in
  deploy.yml like the other adapters. A PR to coinbase/agentkit's examples is the operator's call.

- **Wish board integrity round 2 + discovery-gap attribution (2026-08-27):** the board's whole top since 08-24 (~30 clusters at
  55-66 hits, identical first/last timestamps) was ONE scripted sweep re-running a query list against `/api/find`: find-miss
  recording was rate-limit exempt with no per-caller dedupe, so one machine qualified 30 clusters. Now every signal carries a
  day-scoped `callerHash` (sha256(ip|UTC day) prefix, never the address; persisted on the JSONL line, rebuilt on boot), a
  find-miss is recorded ONCE per caller per need per day (explicit api/mcp wishes unaffected; no ip = no caller credit, no dedupe),
  `clusterQualifies` additionally requires `QUALIFY_MIN_CALLERS` (3) distinct callers (legacy clusters read 0 until fresh signals),
  the aggregate row carries `callers` (a count) and `qualifyMinCallers`, and the served overlay uses `WISH_SERVED_MIN_SCORE` (45)
  instead of FIND_WEAK_SCORE (3), which had marked 17 of 48 qualified clusters served by score-5 matches. test-wish 63.
  **Discovery gap:** `/__operator/discovery-gap.json` matched merchants against ROUTABLE sellers only, so every known-but-unroutable
  origin (probe failed, registry-only) counted as a blind spot. `allPayToOrigins(network)` (x402-index.js) maps every EVM payTo any
  known origin advertises - crawled entries routable or not, plus Bazaar-synthesized tools (the Bazaar carries payTo per resource,
  14,910 rows) - and `unattributedMerchants` now reports `attributedUnroutable` (known origin, cannot route) separately from
  `unattributed` (unknown). Submitted-seed slots: 586 of the 2,000 cap in use (2026-08-27). test-settlement-proof 44.

- **Our live 402 was INVALID under the protocol's own schema (2026-08-29, contributed fix, `scripts/test-bazaar-contracts.js`
  in CI):** `parsePaymentRequired` and `ResourceInfoSchema` from `@x402/core/schemas` REJECT a resource carrying more than
  FIVE tags, and we published nine or ten on 557 of 560 routes. Verified first-party against live prod, not taken on
  trust: `/api/hash` published `["web","tools","agents","x402","encoding","hash","sha256","checksum","crypto"]` and the
  official parser answered `resource.tags: Array must contain at most 5 element(s)`. **A buyer that validates a challenge
  before paying got an invalid document from every route.** Worse, our first five were all GENERIC
  (`web, tools, agents, x402, <category>`), identical on all 560, so a consumer that truncates rather than rejects saw
  ZERO discriminating signal; the fix orders category + the tool's own tags first (`hash` -> `encoding, hash, sha256,
  checksum`), so the cut to five is a discoverability GAIN. Uses the vendor's own `sanitizeTags` (MAX_TAGS = 5, confirmed
  in the package). Same PR gives the CHALLENGE-side schema the route-aware `required` policy `/openapi.json` already had
  (`boundedResponseSchemaFor`, honouring SHAPE_HAPPY_PATH_ONLY and the null rule, 6 variable-output routes deliberately
  left without invented guarantees) and lets a non-object example be a schema at all (`/v1/audio/speech` returns raw
  audio). Measured cost: +52 bytes on the largest challenge before the tag saving. The new sweep runs all 560 routes
  through both official validators; on the pre-fix tree it produced ~2,228 failures. Lesson: we validate what buyers
  send us and had never once validated what we send THEM against the spec's own parser.
- **The Postgres alarm paged on our own deploy (2026-08-29):** issue #1057 said both databases were unreachable; the boot
  log said `[leads-db] ready` + `[analytics-db] ready` at 22:40:52Z and the issue was filed at 22:44:03Z, with
  `/api/gateway-status` reading `ok` throughout. The service is volume-backed, so EVERY deploy has a 60-90s
  no-container window and the pools re-init behind the ~10-18s boot stall after it; the reading was taken inside that
  window and reported minutes later. Five merges in a day is five chances to page on nothing. This leg was the ONLY
  probe in heartbeat.yml without the single-retry doctrine every other one uses (`probe()` wrapping `probe_once()`) -
  it now re-probes after 30 s and files only if the second read agrees, which a stopped Postgres container still
  fails. Pinned in `test-db-status.js` (20) and mutation-checked by deleting the sleep. When adding an alarm that
  reads a live prod surface: one reading is never an outage here, because our own deploys produce that reading.
  **It paged five more times on 2026-09-02 (issues #1161/#1164/#1166/#1167/#1182), each minutes after one of our deploys,
  "confirmed by a second reading" - and the second reading was the SAME failed ping:** `databasesStatus` cached every
  reading 60 s, the Cloudflare Worker confirms 30 s later and the heartbeat 30 s later, so one failed `SELECT 1` (the
  boot log showed both pools ready at 20:07:58; the 20:11 ping still failed, most likely a post-listen stall longer than
  the 5 s ping timeout - measured 7.8 s and 11.6 s that boot) read as two. Now a FAILED reading is cached 5 s
  (`FAILURE_CACHE_MS`, a success keeps 60 s), the ping timeout is 12 s (over the measured stalls, under the observers'
  15 s fetch budget), and a failed ping logs `[db-status] <db> ping failed after Nms: timeout|<code>` so the next false
  page has evidence. test-db-status 24, mutation-checked (holding a failure for the long cache fails it).
- **Broken-tool audit with PRODUCTION KEYS (2026-08-29): the 156 metered tools are outside both catalog sweeps, and one flagship was
  crashing.** Both catalog sweeps EXCLUDE the metered set (third-party keys CI lacks, upstream spend), so ~156 tools -
  every report composite among them - are unexamined by CI on every run. Audited by booting FREE_MODE locally with the
  keys pulled from Railway into a 0600 scratchpad file (never committed, shredded after) and driving them against
  real upstreams.
  **The synthesis half now has a DRIVER: `scripts/audit-metered.mjs` (2026-09-02, NOT in CI - it spends).** Boot FREE_MODE
  with the prod keys (Railway vars into a 0600 scratch file, OPENROUTER_API_KEY = the audit key, CDP keys included) and run
  `TARGET_URL=http://127.0.0.1:PORT node scripts/audit-metered.mjs [--only a,b] [--out file.json]`: it reads METERED_SLUGS from
  the sweep's own source, each slug's method/path/example from `/openapi.json`, drives it with a 5-min bound, and grades
  with the sweep's `missingDocumentedKeys` + `emptyPromisedArrays` (ok / defect = our 4xx/500 or a hollow 200 / upstream =
  502-504, 429 / skipped = no op or identity-bound). First pass 2026-09-02: 147 driven, 112 ok, and THREE real findings, all
  fixed the same day: (1) **`callOpenRouter` and every other wire's parser checked only `res.ok`** - OpenRouter answered
  HTTP 200 with `{error:{message:"…temporarily rate-limited upstream"}}` and no choices on the auto tier's own example, and
  our route relayed it as a 200 = a PAID EMPTY ANSWER; `assertUpstreamBody()` now throws 503 (rate limit, walkable) / 502 on
  a body carrying `error` and no output, at all eight parse sites (chat, Messages, Responses, images, embeddings, rerank,
  speech); a body with output beside an error is returned as-is. The retired ox tier's "alpha has ended" 200-body is the
  same class and now 502s. (2) **The Responses wire hardcoded a 1,024 default budget** (ignored `tier.defaultMaxTokens`) and
  (3) **the premium tier had no `defaultMaxTokens`** while its default model reasons before it speaks, so `/v1/premium/
  responses`' own documented example (`max_output_tokens: 128`) answered 502 "reasoning consumed it"; premium now carries
  `defaultMaxTokens: 4_096`, the Responses wire uses the tier's default, and a tier with one publishes no budget in its
  example. Not defects, for the next reader: identity-bound routes 400 on a free boot (the driver skips them), X/Hunter/
  Apollo are unlisted without keys, token-risk's empty `tables` on WETH/Base is the Blockscout paid-leg outage (holders
  come from there), and the two Blockscout tools are that outage.
  **USE THE AUDIT KEY FOR OPENROUTER, NOT PROD'S (2026-08-30, after the spend was traced):** the OpenRouter account now
  carries a second API key, `Agent402 Audit (local metered-tool audits)`, with its own monthly limit (figure in CLAUDE.local.md) - export it as
  `OPENROUTER_API_KEY` for the local boot. Why: this audit costs REAL money and was invisible to every accounting surface
  we own, because a local boot has no PostHog. Prod's `gateway_usage` recorded $0.0276 on 08-29 while OpenRouter billed
  $11.04 that day, and the same shape produced $19.09 on the 08-21 launch day, against a ~$0.04 baseline. Per-key usage
  reads from `/api/v1/keys` and the activity export's `api_key_name` column, so audit spend is separable from buyer spend
  with no code change. WHAT IT DOES NOT DO: credits are ACCOUNT-wide, so an audit still draws down the same balance the
  gateway serves buyers from - the key BOUNDS and LABELS the spend, it does not ring-fence funds, and
  `gatewayCreditsStatus` still watches the account balance plus the PROD key's own limit. Budget for a full pass in CLAUDE.local.md. **`domain-audit` / `domain-audit-pro` ($0.60/$0.85, also a card product and a $5/mo monitor) answered
  500 on EVERY domain that publishes a DMARC rua or ruf** - i.e. most real domains: `reportingUris` is an OBJECT
  (`{aggregate, failure}`, parseDmarc in network-kit) and the mailbox block added on 08-28 spread it as an ARRAY, so
  `[...(obj || [])]` threw "is not iterable"; the line four above it read the same field correctly, which is how they
  drifted. Extracted as `reportMailboxesFrom()` and pinned by shape in test-domain-audit-inputs (41) where no key or
  upstream is needed. Every OTHER report composite was driven end to end and is healthy (research, market-brief,
  dossier, fund, insider, filing, recall, token-brief, token-risk, ticker-pack, ipo-report, domain-audit/pro). Note the
  harness traps that are NOT defects: `/v1/fund` is the fund route (not `/v1/fund-report`) and `dossier` returns its
  prose under `dossier`, not `report`.
  **Blockscout (2026-08-29):** the paid leg takes 7-19 s per path (token-holders measured 20.15 s), so payX402's 20 s
  DEFAULT bounded the whole buy at about one upstream response and `contract-inspect` failed "aborted due to timeout"
  while the same call succeeded seconds later - now 45 s (`BLOCKSCOUT_TIMEOUT_MS`). Driving all five back to back also
  produced three `HTTP 500` paid legs where the same five run serially answered 12/12: the upstream sheds load under a
  burst, and each of those cost us the $0.002 already paid AND returned the buyer a 502 (a >= 400 cancels OUR
  settlement, so we ate the bill and earned nothing). `buyBlockscout` now retries ONCE on a 5xx or timeout
  (`isTransientUpstream`), never on a 4xx - a 4xx is our request being wrong and paying twice cannot fix it. Worst case
  2 x $0.002 against a $0.005-$0.010 sale.
- **A published example that returns NOTHING is a broken tool (2026-08-29, `emptyPromisedArrays` in sweep-shape.js, in
  BOTH sweeps):** the documented-keys check only asserted keys are PRESENT, so `{keywords: [], phrases: []}` passed.
  Found: `/api/keywords` published `{text: "Long article text…"}` and answered two empty arrays;
  `polymarket-price-history` published a FABRICATED token id (a repeating digit pattern) and answered `count: 0`;
  `kalshi-event` published `PRES-24`, whose markets Kalshi removed when the 2024 election settled; `robots-check`
  pointed at example.com, which publishes no robots.txt; `text-stats`/`text-chunk` published placeholder prose. An agent
  copying our own example got an answer that looks like an outage. Now: where the documented 200 example shows a
  NON-EMPTY array, the tool's own documented input must produce a non-empty array there too, with `EMPTY_ARRAY_OK`
  naming each legitimate case AND ITS REASON (cold index, a weekend with no ex-dividend dates, a stock that never
  split, a coin with no contract platforms, a fresh memory store). Mutation-tested by replanting the old placeholder.
  Three fabricated fields in published examples were fixed the same way: `onramp-link` promised `quote` (CONDITIONAL -
  Coinbase does not always return one) while omitting `note` (always present), `onchain-sql` and the grounded chat tier
  each carried a SENTENCE ABOUT the output inside the output example as if it were a field. Market examples also carry
  an honest `note` when empty now, so a token id or event ticker that resolves later still teaches the truth instead of
  reading as an outage - the Kalshi field-rename lesson, from the other side.
- **Input aliases: accept the obvious other name (2026-08-29, `src/input-aliases.js`, `scripts/test-input-aliases.js`
  19 in CI):** measured from 60 days of telemetry after the "one buy then nothing" question - the buyers who EXPLORED the
  catalog and left hit no payment errors at all; **every failure was a 400.** One walked 77 tools and was rejected 723
  times, another 55 tools and 70 times, a third 44 tools and 107 times. The control that makes it readable: a walker
  using our DOCUMENTED EXAMPLES made 2,591 calls across 1,382 slugs with 25 errors (1%). Driving the same tools by hand
  reproduced it - a third of plausible first attempts fail on the NAME alone (`roman` wants `value` and a caller reaches
  for `number`; `tls-cert` wants `host`, a caller sends `domain`; `edgar-company-lookup` wants `ticker`, a caller sends
  `q`). An agent that READS our OpenAPI gets these right; one that infers from the tool name does not, and inferring is
  what agents do. Our 400s were already self-correcting (they carry `error`, `tool` and an `expected` block naming the
  field), so a careful agent recovers - these buyers did not read it. `applyInputAliases` fills a missing REQUIRED
  parameter from a curated DIRECTED table under three rules that make a wrong guess structurally impossible: (1) only a
  required property the caller OMITTED is ever filled, never an overwrite and never an invented optional; (2) the
  synonym must NOT itself be a declared property of that tool (a tool with both `host` and `domain` means two things);
  (3) exactly one synonym may match - two is ambiguity and the 400 is the better answer. The ADVERTISED contract is
  unchanged: schema, docs, examples and the `expected` block still name the canonical parameter. Wired into
  `handlerInputOf` so pricing and serving still read ONE object - and note the trap the test caught: the memo HIT must
  also alias, or a gate that priced the request before dispatch leaves the handler an un-aliased input while the
  "one object" test still passes. Filled names ride on `req.__aliasedParams` for telemetry. Mutation-tested: breaking
  each of the three rules fails the suite.
- **`accepts[0].outputSchema` on every 402 (2026-09-02, `src/accept-output-schema.js`, `scripts/test-accept-output-schema.js`
  24 in CI):** the spec's own field, carrying the SAME bounded schema the Bazaar extension already carries, on the FIRST
  accept only (thirteen copies would be echoed back by every buyer; measured on prod's widest sampled challenge, 11,108
  bytes, +~540 stays under the 12,000 ceiling). **The first draft rewrote the outgoing PAYMENT-REQUIRED header and failed
  CI's "an unmodified x402 client settles" control, and the reason is the rule for ANY accept-level field:** `@x402/core`
  builds ONE requirements list per request (`buildPaymentRequirementsFromOptions`), serialises it into the 402 AND
  deep-equals the buyer's echoed `accepted` against it at verify (`paymentRequirementsMatchAccepted`: every field but
  `extra` must match, key order ignored). A field the header carries and the requirement does not is a field every
  honest buyer echoes back and the server has never seen - "no matching requirements" on every payment. The builder
  copies only scheme/payTo/price/network/maxTimeoutSeconds/extra from a route accept, so the field cannot be declared
  upstream either. Now: the catalog route's first accept DECLARES `outputSchema` (payments.js, from the same extension
  object) and a prototype patch on `x402ResourceServer.buildPaymentRequirementsFromOptions` (installed before the server
  is constructed; the facilitator-patch seam) stamps it onto the requirement built from that accept - the one object that
  is both the 402 and what verify compares. **Two strict codecs then surfaced, both handled:** (1) OUR MPP shim rebuilt
  the x402 payload through mppx's `encodePaymentSignature`, whose eip155-typed zod schema STRIPS undeclared fields from
  `accepted` - every native MPP buy failed to match; the shim now validates through mppx and emits the same base64-JSON
  wire with the HMAC-bound RAW accept. (2) mppx's own x402 CLIENT protocol parses each accept through that schema and
  echoes the stripped object, so a buyer built on it would be refused on the Base accept - the patch also wraps
  `findMatchingRequirements`: when nothing matches and the echoed accept carries NO `outputSchema`, OUR advertised schema
  for that scheme + network is restored onto it (in place, so verify/settle see the advertised accept) and the match
  runs again; a different amount/payTo stays refused, a DIFFERENT echoed schema is never overwritten, v1 untouched.
  `ACCEPT_OUTPUT_SCHEMA=off` stops declaring the field (a facilitator whose /verify parser refuses it is one flag away;
  the paid canary's Base leg is the live proof CDP does not - it sends the matched requirement, field included).
  Pinned: test-bazaar-contracts (every route: accepts[0] equals the extension schema, later accepts none),
  test-x402-v1-accepts (the stock-client control), test-mpp-shim (native buy + the hand-encoded stripped echo), the unit
  test (stamp by scheme+network, restore rules, install once, payments.js order). Running the paid-path suites in
  PARALLEL locally fails test-mpp-shim's stats delta - they share one local stats DB; run it alone.
- **Typed output schema on the 402 itself (2026-08-29, `boundedSchemaFromExample`):** the OpenAPI fix left the surface a
  buyer reads AT THE MOMENT OF PAYING still example-only - `accepts[].outputSchema` was absent on every route and the
  `bazaar` discovery extension carried `output.example` with no schema. The extension now also carries a TYPED schema
  derived from the same example (`slimDiscovery` in payments.js). **Where it lands is the library's choice, not ours:**
  `declareDiscoveryExtension` CONSUMES `info.output.schema` and emits it at
  `extensions.bazaar.schema.properties.output.properties.example` - the path discovery crawlers already read (the
  existing comment there names it). Do not look for it under `info.output`; it is stripped from there by design.
  Verified live 2026-08-29 on `/api/unemployment-rate`. Two constraints shaped it: (1) the buyer ECHOES the
  challenge back inside its payment payload, so it is byte-budgeted (`BAZAAR_SCHEMA_MAX_BYTES`, 500) and shallows a level
  at a time to fit, dropping rather than blowing the budget - measured across 549 examples, 543 get a schema, the largest
  is 499 bytes, worst-case header growth 666 and the widest route lands at 11,312 of the 12,000 ceiling MEASURED ON PROD AFTER THE
  DEPLOY (projected 11,410; 67 routes now past the 9,000 watch line, up from 35); (2) it is ONE
  copy in the extension, never one per accept - with 13 rails a per-accept schema costs 13x on every 402 and is
  structurally unaffordable. The full typed schema is always in `/openapi.json`, which the listing links.
  **AN ARRAY'S ELEMENT TYPE CANNOT BE READ OFF ELEMENT 0** and @x402/core proved it at boot: the first draft inferred
  `items` from `value[0]` and six routes had their whole bazaar extension REJECTED as invalid (`/output/example/ema/1:
  must be integer` - a list opening with `4` then carrying `4.1`; `avatar: null` where row 0 had a string). `widen()`
  now merges up to 8 sampled elements: integer+number collapse to number, objects union their properties, anything else
  disagreeing becomes `{}` (no constraint). Same trap as the finding that started this, in the other direction - a
  promise inferred from one sample.
  **The guard was inert and now targets prod:** `test-challenge-size.js` ran with no TARGET_URL against the FREE_MODE CI
  server, which answers no 402, so it SKIPPED on every run. It now runs against agent402.tools (unpaid 402s are free,
  and only prod carries all 13 rails), sharing the SEO gate's one-run lag - the test job runs BEFORE the deploy, so a
  challenge that grows is caught on the run AFTER the one that ships it.
- **Typed 200 schemas in `/openapi.json` (2026-08-29, `src/openapi-schema.js`):** every JSON tool declared
  `schema: {type:"object"}` with a rich `example` beside it - a human reads the example, a MACHINE reads the schema, and an
  untyped object promises nothing. An outside audit of `/api/unemployment-rate` reported `properties_missing` +
  `required_fields_missing` and could not confirm the response carries the `current`/`history`/`source` fields our own
  example shows; that was a fair finding about all 560 routes, not one of them. `responseSchemaFor(path, example)` now
  derives typed `properties` (nested, arrays through `items`, depth cap 4, 40 props per object) from the tool's own
  example. **`required` is a PROMISE and is only made where CI already keeps it**: the catalog sweeps assert every 200
  carries its documented TOP-LEVEL keys, so `required` is the top level only (nested objects are typed, never required),
  a key whose example value is null is typed but not required, and the six `SHAPE_HAPPY_PATH_ONLY` routes - excused from
  the shape check because their live shape varies with the outcome - declare properties and require nothing. That set
  MOVED to `src/openapi-schema.js` and `scripts/sweep-shape.js` re-exports it, so a route excused from the check can
  never promise a shape in the spec. Measured: 548 of 551 JSON ops typed, 542 with `required`, doc 1.673 MB -> 1.690 MB
  (+1%).
- **The 402 challenge header has a ceiling that is not ours to set (2026-08-29, found by running our own smoke buy against an
  external seller):** a stock x402 client echoes EVERY extension it is offered straight back into the payment payload -
  `info` and the full JSON `schema` for each - so a rich 402 becomes a rich REQUEST header on the buyer's retry. Measured on
  that seller: our client built a 13,680-byte payment header against their 3,572-byte-equivalent for our own routes, their
  facilitator answered `'paymentPayload' is invalid`, and with one extension stripped the next attempt hit **HTTP 431
  Request Header Fields Too Large**; with ALL extensions stripped the request finally arrived and their gate refused it as
  "No matching payment requirements" - i.e. their endpoint is unpayable by a stock client either way. Nothing settled in any
  of the three runs. OURS IS THE SAME SHAPE, smaller: `/v1/metered/chat/completions` measured **10,704 bytes** (accepts
  3,268 across 13 rails, extensions 3,985 of which `bazaar` alone is 3,215). `scripts/test-challenge-size.js` (in CI) is the
  ratchet-stop: hard ceiling 12,000 bytes, warn line 9,000, so the challenge cannot silently grow past what a buyer can send
  back. Trim an extension before adding a rail. It sweeps EVERY paid route from the booted server's own `/api/pricing`, not a
  sample: the size is driven by the tool's OWN input schema (the bazaar extension carries it), so the largest challenge moves
  whenever a kit is added, and the first draft's two hardcoded routes missed the real worst case. Full prod sweep 2026-08-29:
  560 of 560 paid routes carry a challenge, largest `v1-chat` 10,744 and smallest 5,204, 35 past the watch line, none over the
  ceiling. A FREE_MODE server answers no 402 anywhere, so the guard SKIPS rather than reporting a pass that measured nothing.
  Separately this sweep fixed a real drift: 38 workflow sites pinned the x402
  client at 2.16.0 against a 2.22.0 server, which the daily canary could never catch because it only pays OUR challenges.
- **Manifest-vs-402 consistency (2026-09-02 evening, issue #1178's follow-up, from the seller themselves):** a manifest-priced,
  manifest-networked row was NEVER read live - the crawler had nothing to learn (price and chains both present) - so a seller
  who added a rail to their 402 middleware and not to their manifest stayed single-chain in our index (angel.finereli.com:
  live 402 offered Base AND Algorand, manifest said Base, our row said Base). `networksNeedLiveVerify(t)`: such a row is a
  live-402 candidate once (`networksVerifiedAt` absent), then every 7 days (`NETWORKS_VERIFY_AGE_MS`), inside the existing
  probe budget/cap; a read unions the offered chains in (never drops a manifest chain) and stamps `networksVerifiedAt`;
  `carryForwardLearnedQuotes` unions a VERIFIED remembered row's chains into the next crawl's manifest-shaped rebuild and
  carries the stamp (an unverified remembered row keeps the old fill-a-gap rule). Learned quotes keep their own clock
  (`quoteIsStale`; the "an origin-declared price never expires" pin stands). test-index-tools-catalog.
- **A learned VERB was stamped onto every row of a path (2026-09-02, `carryForwardLearnedQuotes`):** minia2a.uk declares GET
  and POST on each of ~1,700 paths; the carry-forward map was keyed by ROUTE alone and overwrote every current row's `method`
  with the remembered row's, so 86 of the first 500 rows read `GET` with a `_post` slug (two GET rows per path, the POST
  operation mislabelled). A seller whose POST route rejects GET would be published as GET, answer 405 to every buyer we
  sent, and be recorded broken by us - the seller-side twin of our own POST-on-GET 405. Traced by running the real
  ingestion on the live documents (OpenAPI + manifest came out GET+POST correctly; the Bazaar holds no minia2a rows), so
  the flip had to be a later step. Now: the map is keyed by METHOD + route with a route-only fallback for price and
  networks; a remembered verb replaces a current one only when the row INFERRED its verb (a manifest/llms.txt entry that
  named none - `normaliseManifestTools` now stamps `methodInferred: true`, which `probeMethodsFor` already honours by trying
  both verbs) or when the remembered row is a recorded CORRECTION of that verb (`methodCorrectedFrom`, written by
  `enrichLiveQuotes` when the stated verb did not answer and the other did). Pinned in test-index-tools-catalog (49),
  test-x402-live-quote (36), test-single-resource-manifest (26). Rows persisted before the marker existed lose a prior
  correction until the 7-day quote refresh re-probes them - accepted, because the old rule mislabelled far more.
- **A learned price could rise but never fall (2026-08-29, reported from OUTSIDE with two unauthenticated curls, issue #1043):**
  a seller cut `/audit` from $0.50 to $0.05 on 2026-08-20 and our index was still quoting the old number NINE DAYS and dozens
  of crawls later - a 10x overquote on their listing, and enough to push the route into the wrong route-execute tier. Three
  sites composed into a ratchet: (1) `mergeOpenapiIntoBazaar` resolved a price conflict with `Math.max(bazaar, origin)`;
  (2) `carryForwardLearnedQuotes` filled the fresh crawl's row with the stale live-402 amount and then re-stamped it
  `quoteSource: "live-402"`, so a nine-day-old number looked freshly observed; (3) `enrichLiveQuotes` only probed routes with
  NO price, so a route already carrying the stale amount was never re-probed and the live 402 that would correct it was never
  fetched. Fixed: the merge now prefers the ORIGIN'S OWN CURRENT DECLARATION, which STRICTLY DOMINATES the max() it replaced
  (in the raised-price case the origin IS the higher figure, so the original concern is handled identically; the two rules
  only diverge on a CUT, which is the bug); carry-forward fills a GAP only, never overrides a price the origin declared this
  crawl, flags itself `quoteCarriedForward` and no longer claims live-402 for a number it did not just learn; and a priced
  route whose amount disagrees with the origin's declaration by >= `QUOTE_DRIFT_FACTOR` (2x) is re-probed inside the existing
  budget. Rows carry `originDeclaredPrice` and `priceResolvedFrom` so drift is visible rather than silently resolved.
  A learned quote also EXPIRES now (`quoteIsStale`, `QUOTE_MAX_AGE_MS` 7 days, stamped `quoteObservedAt` and carried across
  crawls so the clock cannot reset): the drift re-probe only fires when the origin DECLARES a price, and measured against 260
  routable sellers only 14 publish one - for the other ~95% a learned amount would have stood forever, the same ratchet by a
  quieter route. A row from before stamping existed is refreshed once. Pinned both directions in test-index-tools-catalog
  (39) and in test-openapi-fallback, whose three max() assertions were UPDATED rather than deleted, with the reasoning in the
  test. **The first cut did NOT correct the reporter's own row, and only verifying against their LIVE endpoint showed it:**
  their tools are discovered via `/.well-known/x402`, not OpenAPI, and `originDeclaredPrice` was set only by the OpenAPI
  merge - so carry-forward kept overriding their corrected manifest price with the stale learned amount. A manifest price is
  an origin declaration too and is stamped as one now; note it is usually a DISPLAY STRING ("$0.05"), so the guard goes
  through `priceToMicroUsd` (a bare `Number()` yields NaN and skips the stamp in silence). "The origin declared this" is a
  property of SEVERAL discovery paths, and keying it to one fixes one seller shape.
  Watch out: the first cut of the merge fix returned the origin's price AS WRITTEN, and a seller's document can carry
  it as the string "0.003", which fails every numeric comparison downstream - the old code normalized through
  `microUsdToPrice` and the replacement has to as well (CI caught it). Lesson: a "safe" tie-break that always picks one side is a
  ratchet, and the party it hurts is the one who cannot see our index - they had to file an issue to tell us.
- **CodeQL caught a high-severity ReDoS in the same day's new code (2026-08-28):** `isSelfSellerQuery` in host-entry.js trimmed
  trailing slashes with `/\/+$/` on the caller-supplied `?seller=` value - polynomial backtracking on a string of many
  slashes, on a public endpoint (js/polynomial-redos, high). Replaced with a linear slice loop and a 256-char bound before
  any URL parse; a 120k-slash query now answers in 0 ms and every accepted spelling of the host is unchanged (pinned in
  test-shortlinks). The other `replace(/\/+$/)` sites in the tree take OPERATOR-set env values, not caller input, which is
  why only this one was flagged - the distinction to check before "fixing" the rest.
- **Outside-in reviews, 2026-08-28 (a security pass over the day's 41 commits + an adversarial partner due-diligence run):**
  HIGH, self-inflicted the same day: `hostEntryFigures()` ran 2-4 SYNCHRONOUS better-sqlite3 aggregates per render (one over
  ALL TIME) on `/marketplace`, the twelve chain pages, both leaderboards and `/api/index` - measured **215 ms of blocked event
  loop per render** on a 120k-row ledger, on public crawler-hit pages, single replica, with no CDN behind `htmlCache`. Now
  cached 60 s per chain key (`HOST_FIGURES_TTL_MS`), a failed rebuild keeps the last good figures. MED: the metered
  unpaid-quote limiter treated ANY `authorization` header as paid - `Bearer garbage` took 80 of 80 requests past it while 80
  unauthenticated ones were throttled at 44; "paid" now means a PLAUSIBLE credential shape. From the partner audit, all
  reproduced: the **"never holds or moves funds" claim was false** while we sell prepaid credits, so `/api/reliability`,
  `/company` and `/security` now say non-custodial ON THE PAYMENT RAILS and name the two card paths that are not, and
  `/terms` gained an explicit wind-down clause (30 days notice, sales stop, routes keep serving, unspent balance refunded to
  the card) - a held balance should not depend on us existing forever. `/api/reliability` hardcoded `status: "operational"`
  while `/api/status` computed "degraded" from real observations IN THE SAME MINUTE; it now mirrors the measured `overall`
  and falls back to "serving", never to a self-assessment. `POST /api/credits/checkout` refused every guessable pack id
  (`20`, `"$20"`, `{amount:20}`) with a bare "Unknown credit pack" while `/api/pricing` published only the dollar amounts -
  the reviewer brute-forced `credits-20`; the error now lists the valid ids and `/api/pricing` publishes `packs[]` plus the
  checkout shape. `?top=1000` on `/api/leaderboard` silently returned 50 - it now carries `truncated`, `topRequested` and the
  reason. **That list is now CLOSED except the operator item, each re-verified against LIVE prod 2026-08-29** (it had gone
  stale in the flattering direction, which is the failure mode a to-do list has): the MCP Registry entry reads
  `isLatest` 0.13.0 "Agentic Finance: 500+ tools ... over x402 or MPP, free via PoW, or prepaid card credits" (97 chars,
  evergreen, no inflated count - remember to filter on `isLatest`, the 32 older versions still list the 1,338 figure);
  `/api/route?include=external` returns 0 rows carrying a `{placeholder}` url; `/api/stats` publishes
  `viaUSDCAttributed` + `viaUSDCBeforeNetworkCounter` = `viaUSDC` with a note saying why (16,401 + 14,170 = 30,571 -
  the per-network split only starts when that counter shipped); `/marketplace` answers in 0.26 s; and
  `GLAMA_MAINTAINER_EMAIL` is GONE from Railway, so `/.well-known/glama.json` serves the code default
  `mike@agent402.tools`, which IS the company mailbox decided 2026-08-28 - nothing owed. **The list is CLOSED.**
  Note how it failed: four entries were re-verified live and the fifth was carried over unchecked because it was
  labelled operator-owned, in the very commit that closed the other four. An item nobody re-reads is not evidence,
  whoever owns it - check the surface.
- **mppx 0.9.2 (2026-09-02):** taken after a read of the 0.9.0-0.9.2 changelog: 0.9.0 removes machineUSD (never configured
  here) and adds dual MPP/x402 framework wrappers (unused - our shim is our own); 0.9.1 "fixed MCP payment errors to use the
  specification-defined JSON-RPC codes": `-32042` stays payment-required and `-32043` is a PRESENTED credential refused
  (`MCP_PAYMENT_VERIFICATION_FAILED_CODE`, mcp-mpp.js; mcp-http.js keys it on a credential having been PRESENTED in `_meta`, never
  on the body - an unpaid 402 can carry a problem-shaped body too, which is what test-mcp-tasks' stub does; the 0.9 client
  reads challenges from either code, an 0.8 client stops re-paying a refused credential, which is the spec's intent). All
  thirteen MPP/Tempo/Stripe suites green on 0.9.2 offline. Live proof after the deploy: the charge canary
  (tempo-canary-verify.yml, run 33657484283) settled; the subscription canary FAILED its renewal (run 33657453172) and the
  cause was NOT the bump: prod's log read `transaction expired: current block timestamp 1788367998 >= validBefore 1788367996`
  at eth_estimateGas - viem's Tempo chain config stamps `validBefore = now + 25 s` on every request, and that minute our own
  tempo-volume run had rpc.tempo.xyz answering in 7-20 s (the morning's green run had no volume overlap). Nobody was charged.
  The renewal then backed off a full HOUR, which is the wrong price for a slow RPC: `isTransientChargeError` (RPC/network
  shapes, read through viem's nested `cause.details`) now retries in `TRANSIENT_CHARGE_BACKOFF_MS` (2 min x attempts,
  capped at the hour); a refused transfer keeps the hour. **The next canary (run 33659899394) failed a different way and
  found the real hole: `eth_sendRawTransactionSync` TIMED OUT after the transfer had been handed to the RPC** (viem's default
  10 s request timeout; the sync send waits for inclusion). The chain showed it never landed that time, but nothing in the
  path could know that, and mppx renews with Tempo's EXPIRING nonce, so a retry is a NEW transaction that lands beside an
  earlier one that did - a double charge with no attacker. Now: (1) the subscriptions engine always supplies ITS OWN viem
  client with a 30 s timeout (`TEMPO_SUBSCRIPTION_RPC_TIMEOUT_MS`; before, `TEMPO_RPC_URL` was unset on Railway so mppx's
  default client ran); (2) a send-phase failure (`isSendPhaseAmbiguity`: the error names the send call and is
  timeout/network shaped) is remembered as `rec.unconfirmedCharge = {at, periodIndex}`, and the next pull asks the CHAIN
  first (`findRenewalOnChain`: Transfer logs payer -> our recipient since the attempt, value = the period amount, AND the
  transaction's transferWithMemo memo equal to mppx's attribution for `renewal:<subscriptionId>:<period>` -
  `expectedRenewalMemo` reproduces `tempo/Attribution.js` byte for byte and the test pins it against mppx's own encoder by
  file-path import): landed -> recorded in BOTH stores (mppx `put`, ours) and booked, nothing signed; never landed ->
  charged now; chain unreadable -> wait on the short backoff, never sign. (3) the canary waits 135 s for the server's
  transient retry before calling the rail broken. test-mpp-subscriptions 143. **Tollbooth 0.10.0 (same day): MPP on the EDGE gate** - `tollbooth/edge-mpp.js` (Web Crypto
  HMAC) mints one evm/charge challenge for the edge quote beside the x402 accepts block and translates an
  `Authorization: Payment` credential (HMAC-bound, unexpired, minted for THAT resource) to PAYMENT-SIGNATURE for the
  operator's `verifyX402`; the wire codec moved to `tollbooth/mpp-codec.js` (runtime-agnostic, shared with the Node build).
- **mppx 0.8.19 (2026-08-28; 0.8.18 carried the fix, 0.8.19 landed from a dependency bump on main and supersedes it):** carries (from 0.8.18) the UPSTREAM fix for the yParity/canonical-hash bug `src/tempo-confirm.js` exists to
  work around ("Normalized Tempo transactions before broadcast so accepted recovery-ID encodings matched the node's canonical
  hash"). Our chain-truth confirm STAYS - it is the belt that made an AgentCore/Privy buyer payable at all, and a library fix
  upstream does not retire a guard that reads the chain. Held to the 0.8 line deliberately: 0.9.x removes machineUSD (unused
  here) but also changes the MCP payment error codes we hardcode (`-32042` in `src/mcp-mpp.js`), so it needs its own read.
  All seven MPP/Tempo suites green offline; the live proof is the tempo canary + tempo-subscription canary dispatched AFTER
  the deploy, never a stub (the rail has drifted twice at the wire level and a stub relay accepts anything).
- **Sweep follow-through done end to end (2026-08-28):** Polymarket's two gamma LIST call sites moved to `/markets/keyset`
  (`polyList()` accepts the keyset object AND the legacy bare array, so a rollback cannot empty the tools; `offset` is refused
  there with a 422, `next_cursor` becomes `after_cursor`); the FRED attribution their terms require now ends all five
  fred-* descriptions; `mcp/package.json` SDK range aligned to the root's `^1.30.0`; the `actions/cache` pin (11 months
  stale) refreshed to v6.1.0 on all 20 steps; dated retirement comments on `openai/o4` -> gpt-5.6-terra and the
  gpt-4o-2024-05-13 row (both 2026-10-23) and on gpt-image-1-mini -> gpt-image-2 (2026-12-01). CORRECTION worth keeping:
  gpt-image-1-mini reads "absent" from OpenRouter's default chat-model list and is LIVE in the image catalog
  (`/api/v1/images/models`) - check the right catalog before calling an image or speech model dead, the same trap the speech
  models sit in.
- **Data-provider sweep (2026-08-28): Kalshi silently emptied two paid tools.** Kalshi REMOVED every integer-cents field
  (`yes_bid`, `yes_ask`, `no_bid`, `no_ask`, `last_price`, `volume`, `open_interest`) that `shapeKalshiMarket` was built on -
  verified live against 200 markets, not one of them present - so `kalshi-markets` and `kalshi-event` were answering HTTP 200
  with every price, volume and open-interest field NULL. A charged empty answer, invisible to every guard we have, because a
  200 with nulls is not an error and PostHog showed no recent calls to notice. The shaper now reads the new STRING-DOLLAR and
  fixed-point names (`yes_bid_dollars` "0.4700", `volume_fp`), keeps the buyer-facing values in CENTS so existing callers'
  arithmetic still works, publishes the dollar figures alongside (`yesBidUsd` ...) and falls back to the legacy names so a
  rollback on their side cannot break us twice; `liquidityUsd` is new. Pinned in test-prediction-market-kit (94) including
  the distinction the failure turned on: an untraded market reads 0, an ABSENT field reads null. Lesson for any shaper over a
  third-party feed: a field rename is indistinguishable from an outage unless something asserts the values are populated.
  Also from that sweep, NOT yet acted on: Polymarket's gamma `/markets` and `/events` carry `deprecation: true` and
  `sunset: Fri, 01 May 2026` in the HTTP HEADERS ONLY (nothing in their docs), pointing at `/markets/keyset` (`next_cursor`
  becomes `after_cursor`, `offset` is refused) - still 200 today, past its own sunset; the `OPENFDA_API_KEY` state in prod is noted in CLAUDE.local.md; **openFEC is RESOLVED, and the earlier note here was wrong**: the restriction
  (52 U.S.C. 30111(a)(4), as stated on fec.gov) is that the names and addresses of INDIVIDUAL CONTRIBUTORS may not be sold
  or used for commercial purposes or to solicit contributions - contributor-level PII only, not a blanket commercial bar
  and nothing about model training, which we do not do anyway. Our one FEC tool is `fec-candidates`, which returns
  candidate name, party, office, state, incumbent status and FEC id from `/v1/candidates/search`; it reads no contributor
  record and no Schedule A. Re-open this only if a tool ever returns contributor names or addresses. FRED's terms require the
  "not endorsed or certified by the Federal Reserve Bank of St. Louis" line, which no surface of ours carries; and Nasdaq's
  2026-05-11 terms are personal non-commercial only. The licensing cluster is one business decision, not nine tasks.
- **Chain/RPC sweep (2026-08-28, every endpoint probed live):** four dead-endpoint classes, two of them money paths failing
  CLOSED. (1) `scripts/refund-run.js` had `polygon-rpc.com` as the ONLY Polygon RPC - Polygon shut it off 2026-07-31 (probe:
  `tenant disabled`, 403), so every Polygon refund held unpaid; now `polygon-bor-rpc.publicnode.com`. (2) The same file pointed
  Robinhood at `rpc.robinhoodchain.com`, which answers an EMPTY body; the host the rest of the repo uses is
  `rpc.mainnet.chain.robinhood.com` (probe: chainId 0x1237). (3) EVERY `*.llamarpc.com` endpoint is dead (NXDOMAIN on
  polygon/arbitrum/optimism, HTTP 521 HTML on base/eth - the HTML breaks JSON.parse and each entry costs a full timeout for
  zero chance); purged from all ten files. (4) `seitrace.com` is down and de-listed by Sei's own docs; explorer links moved to
  `seiscan.io` (the Sei RPC is fine). Also bumped the facilitator's `@stellar/stellar-sdk` 16.2.0 -> 16.3.0, which backports
  the Protocol 28 XDR ahead of the mainnet vote on **2026-09-16** (pre-P28 SDKs fail to decode envelopes after it; 17.x is the
  breaking line, do NOT take it while `@x402/stellar` pins `^16.0.1`). VERIFIED CLEAN and needing nothing: all eleven
  stablecoin addresses and their EIP-712 domain pairs, each proven by recomputing `DOMAIN_SEPARATOR()` rather than trusting
  `name()` (USDG's `version()` reverts and was resolved by brute force, so payments.js's "best-effort" domain comment is
  actually verified), every chain id, and every registry we list on. Still to do: `mppx` >= 0.8.18 carries the UPSTREAM fix for
  the yParity/canonical-hash bug `src/tempo-confirm.js` works around (our `^0.8.17` pin can never reach 0.9.x) - bump behind
  the live Tempo canary, never a stub; Alchemy `getNFTSales` is removed 2026-09-30.
- **AI-provider sweep (2026-08-28, live models JSON + provider deprecation pages):** four fixes. (1) The Messages wire relayed
  `top_k`/`temperature`/`top_p` verbatim, and models released after Claude Opus 4.6 (opus-4.7/4.8/5, sonnet-5) REFUSE top_k at
  any value, temperature != 1 and top_p < 0.99 - a bare upstream 400 to the buyer; we now refuse those ourselves with the
  reason, and pre-4.6 models (haiku-4.5 and older) keep the old freedom. (2) MODEL_COST rows re-read live: terra was UNDER the
  real price ($1.5/$8 vs $2/$12) and sol, grok, gemini-2.5-pro and gemini-3.6-flash were all OVER (the clamp was cutting
  max_tokens up to 3.5x harder than the price bought). (3) `gpt-5.6-terra` came OFF the base tier: at $2/$12 it sits over that
  tier's completion bound, so `provider.max_price` refused every non-flex attempt and each call burnt a wasted round trip -
  dropped rather than raising the bound, which is the belt that catches a model repriced upward. (4) The nano tier's
  `defaultModel` moved to `gpt-5.6-luna`: `gpt-4.1-nano` retires 2026-10-23 (its named successor). NOT done on purpose:
  `usage:{include:true}` is documented as a no-op but is KEPT, because the margin telemetry and the metered meter read
  `usage.cost` and a docs line is not worth a silent telemetry loss. DONE 2026-09-02 ahead of the dates: `gpt-4.1-nano` left the nano/base prefixes (luna is the default,
  gpt-5-nano stays and is admitted on base too), the `openai/o4` prefix + alias went (o4-mini by its own id, gpt-5.6-terra
  added to premium), and link 2 of /v1/images/fast is `openai/gpt-5-image-mini` (identical $8/M image-token price; measured
  live $0.0126 at medium, worstCaseUsd 0.013). The `gpt-4o-2024-05-13` cost row STAYS until the id leaves the catalog: it is
  live at $5/$15 and the `openai/gpt-4o` prefix admits it, so removing the row made the live guard flag an under-count.
  `stealth/ox-alpha` has no upstream endpoints at all (the boot probe 503s it; set `OX_ALPHA_ENABLED=off` to stop advertising).
- **Server telemetry is ANONYMOUS (2026-08-28, from a provider sweep):** every `capture()` in posthog.js now carries
  `$process_person_profile: false`. Measured: 307,424 of 311,256 events in seven days were server events on the single
  constant id `agent402-server`, and PostHog bills an event WITH person processing at roughly five times the anonymous
  rate once the 1M free allowance is spent - at our volume that is the difference between a few dollars and a few
  hundred on the first overage month. The profile carried no signal (one row, no person properties; every insight reads
  event properties), and browser events from the site keep person processing. The three leak guards that assert an exact
  property key set now ignore `$`-prefixed PostHog control keys (`ourKeys()` in test-posthog-funnel, 64), and one pin
  requires the flag on every captured event. Same sweep corrected the facilitator quota watches: PayAI's free tier is
  smaller than the earlier note said, and the CDP-first chains carry a comparable monthly count against the same free
  tier with nothing watching them (figures in CLAUDE.local.md) - both now have heartbeat steps, and a quota refusal
  (`403 free_tier_exhausted`) is logged as billing rather than an outage.
- **PostHog ingestion is scanner-bounded, not traffic-bounded (2026-08-27):** the 08-25 spike (109,729 events vs
  ~40k/day) was ONE external scanner (one UA, one IP) hitting the free `GET /api/find` twice a second for 12
  hours - 57,277 `tool_call` events from one caller; and the 30-day baseline (~990k, at PostHog's 1M/month allowance)
  was 38% `tool_gone` (four scanners re-walk all ~970 retired `/api/convert/*` routes daily; the 500/hour cap WAS the
  volume) + 26% `discovery` + 19% `tool_call` - events with money in them were ~2%. Now every free-surface stream is
  ROLLED UP like `paywall_402` (one event per key per `POSTHOG_PAYWALL_FLUSH_MS` window carrying `count`; `sum(count)`
  is exact): `discovery` per (surface, synthetic), `tool_gone` per route (top 50 + `_other` with `routes`), and
  `tool_call` for the discovery pseudo-slugs (`_find`/`_route`: per slug x cached x errored x status, `latencyMs` =
  window average); real tool calls stay per-event. The hourly caps are gone (a windowed count bounds volume by key
  cardinality, not traffic, and drops nothing). Insights that COUNT events on those three streams must switch to
  `sum(count)`. PostHog carries no caller IP by design (`$ip` is our own egress) - attribute a burst from Railway's HTTP
  logs (`railway deployment list` for the deployment live at the time, then `get-logs types:["http"]` on that id).
  Same review: the external spend ceiling (`external-spend-guard`) is now keyed for Tempo buyers (`tempo:<payer>`,
  else `ip:`) - the tempo gate strips the x402 headers, so `payerFromRequest` was null and a Tempo buyer was exempt
  from the unsettled-spend bound the day the Tempo leg first resolved; `tempo-sor-live.js` refuses a `route` input
  off the two documented paths (a write-access dispatcher could otherwise point the burner's credential at another
  host). `test-posthog-funnel` (60), `test-tempo-router` (48), `test-pricing-margin` (186).
- **`adapters/eliza` = `elizaos-plugin-agent402` (2026-08-27):** elizaOS plugin (no runtime import of @elizaos/core; types
  only) with actions `AGENT402_FIND` / `AGENT402_CALL` / `AGENT402_ABOUT` (content.task / content.slug+params, ActionResult
  {success,text,data}, callback mirrored) and an `AGENT402` provider naming the payment mode, over `agent402-client`
  (credits key Bearer, or x402 wallet via optional peers, PoW free tier); spend bounds via
  `AGENT402_MAX_PER_CALL_USD`/`AGENT402_DAILY_LIMIT_USD`; `agentConfig.pluginParameters` marks the two keys sensitive.
  `adapters/eliza/test.js` (19: PoW buy, credits Bearer against a stub, key never in results, provider modes) in the
  adapter lane + gate/publish steps. **Listing process (read from their `packages/registry/README.md`):** the old
  `elizaos-plugins/registry` repo is archived; third-party plugins are listed by (1) publishing to npm as
  `elizaos-plugin-*` or own scope with keyword `elizaos` (the runtime auto-discovers by keyword; the listing is for
  discoverability), (2) adding `packages/registry/entries/third-party/<package>.json` (prepared:
  `adapters/eliza/registry-entry.json`), (3) `bun run --cwd packages/registry validate && generate`, (4) a PR against
  `develop` (reviewed for security, functionality, docs; CONTRIBUTING wants an issue first for non-trivial work).
  FIRST npm publish is the operator's (OIDC cannot create the package), then the upstream PR.
- **SSE relay commits the 200 only on the first `data:` frame (2026-08-27, `streamOpenRouterTo`):** the paid canary's
  `llm-stream` leg bought a nano stream that came back as ": OPENROUTER PROCESSING" keep-alive comments and then EOF
  (PostHog: `tool_call` 200 in 6.3 s, no `gateway_usage`), and the relay had already written 200, so the buyer paid
  $0.003 for nothing - the streaming twin of the paid-empty-answer class the non-stream wire walks the chain on. Now
  the status is held until real data exists (comment prelude buffered, bounded 64 KB); a comment-only or dropped-before-
  data stream throws 502 with nothing written, the callers' chain walk catches it (`!res.headersSent`) and settlement
  is cancelled end to end. Pinned in test-llm-gateway (comment-only -> 502, chain walked; comment + data -> served in
  order). Same day: the canary's `price-pyth` leg (tool retired 08-26) and `llm-ox` leg (stealth model gone upstream)
  were removed - both had warned on every run and warnings page nobody; the `derivatives` leg's check asserted a
  `funding.hourlyPct` field perp-funding never had (real shape `current.hourly/aprPct`) and had warned since 08-22.
  Still warning by design: `skill-pack` crypto-dossier's `extract` step depends on whichever news site the search
  returns (a buyer pays the pack price with one step failed - product wart, open).
- **Metered Messages wire (2026-08-27, `POST /v1/metered/messages`, slug `v1-chat-metered-messages`):** the metered tier
  on the Anthropic Messages wire. `MESSAGES_PATH_BY_TIER["v1-chat-metered"]` (LAST, the TIERS ordering rule); the 402 price
  is `quote: (body) => meteredMessagesQuoteUsd(body).usd`, priced from `validateMessagesRequest`'s PROBE through the new
  `meteredQuoteForProbe(probe, imageCount)` export in the gateway kit (same arithmetic, `METER_MARKUP`, floor, cap and
  micro-dollar rounding as the chat wire); the handler carries the chat wire's metered belt (re-quote the served body,
  400 if above the gated price), `provider.max_price` = the quoted model's `costFor` row, `gateway_usage.priceUsd` = the
  quote, and (for every Messages tier now) the `__meterUpstreamUsd` sentinel so upto/credits/card buyers settle actual x
  1.15. `/v1/models` carries `meteredMessagesEndpoint`. Cap note: the largest body validation admits (200k chars, Opus,
  8192 tokens) quotes ~$1.34, under the $2 cap, so the cap is pinned on the probe-level quoter. Paid-canary leg
  `llm-metered-messages` (haiku, max_tokens 300; test-canary-coverage pins priceUsd to the kit's quote). Gating:
  WALLET_ONLY + test-all NETWORK + METERED_SLUGS. Guide `/guides/agent-hosts` gained an Anthropic SDK block: the credits
  key must ride as `auth_token`/`authToken` (Authorization: Bearer), not `api_key` (x-api-key). **Claude Code as an LLM host
  is CLAIMED since 2026-08-27** (see the Claude Code host entry below): the 100 KB limit is lifted on /v1/metered and the
  wire was proven against claude-cli 2.1.250.
- **Security review of the 2026-08-28 paid-path changes (same evening, three lenses; money lens clean):** MED the 402 hint was keyed
  on the payer ADDRESS read from the unverified payload - anyone could read any wallet's Base balance through us and plant a
  misleading hint + 60 s backoff on a real buyer's next 402; now keyed by the CREDENTIAL (`credentialKeyOf`: sha256 of
  from|nonce|signature, `credentialKeyFromHeader` on the middleware side), so only the exact retried header sees its own hint;
  the balance read is 1.5 s bound with at most 4 in flight (a full lane reads "unknown", never queues) because the hook is
  awaited inside the paywall. MED the hint only fired for a THROWN verify (non-2xx, CDP's shape) - @x402/core's graceful
  `200 {isValid:false}` path (PayAI/Solvador/Stellar) has no failure hook, so `registerFacilitatorFailureHooks` now also
  records from `onAfterVerify` when `result.isValid === false` (shared `recordVerifyFailure`);
  `scripts/test-verify-hint-live.js` boots a paid server against a stub facilitator answering BOTH shapes. MED the www->apex
  301 reflected the Host header (open redirect) - only `www.<BASE_URL host>` redirects, to BASE_URL. MED the metered
  unpaid-quote limiter skipped GET/HEAD, which the method alias turns into the POST quote path - all three methods count.
  LOW `tool_gone` rollup keys capped (5,000 keys, 120-char routes, `_overflow`); the drain refusal checks the aliased
  method twin. (Accepted residual in CLAUDE.local.md.)
- **Dead-end sweep from the raw HTTP log (2026-08-28, after the 405 finding; the question was whether the same class exists in everything
  else we serve):** Railway's `get-logs` accepts `@httpStatus:404` / `>=500` filters and REMOVED deployments still answer, so a
  status-by-status read of ~6 h is one call each. Found and fixed in one PR: (1) trust/uptime indexers (kkj-x402-trust-index,
  nsgoods-payability-observatory, stelar-trust-monitor, ioi-indexer, PayAI-Uptime-Monitor, x402-observatory) send GET/HEAD to POST-only
  tools and skill packs and got 405 = "not payable"/"down" in their listings - the alias middleware now runs the POST gate chain for a
  GET/HEAD on a POST-only path (unpaid -> the 402 with challenges; free/paid -> the handler's own 400 naming the field; HEAD body
  suppressed); only methods no tool has (PUT ...) still 405; (2) `/v1/chat/completions` 413s (one agent, 5 in 30 min, still
  retrying hours later) said nothing - the error handler's 413 carries `hint` + `metered` pointing at `/v1/metered/*` (1 MB, priced
  from the body); (3) discovery paths indexers guess - `/.well-known/x402.json`, `/.well-known/x402-services.json` serve the manifest,
  `/swagger.json`, `/api-docs/openapi.json`, `/api/openapi.json` 301 to `/openapi.json`, `GET /v1`, `/v1/info`, `/v1/metered` answer a
  gateway index JSON; (4) an unknown `/api/*` path (retired tools and ~25 retired packs probed daily) answers a helpful JSON 404 with
  `hint`, `find` and three `suggestions` from `findTools`, counted as `tool_gone` (status stays 404 for the route oracle); (5) `/v1` and
  `/mcp` errors are JSON (the 404 catch-all and error handler treated them as HTML). Not fixed, noted: each deploy is a ~1 min 502 window
  and we deployed ~25 times that day - batch merges when nothing is urgent. Pins: test-wrong-method-405 (11), test-head-paywall (12),
  test-shortlinks (61).
- **POST on a GET-only tool is served, not 405'd (2026-08-28):** a buyer that had just paid walked the catalog POSTing JSON to every
  route and got `405 Method POST not allowed` on search, search-news, search-images, search-videos, search-suggest, ip-info,
  card-validate ... and stopped (Railway HTTP log, 18:07Z; agents POST everything). A top-level middleware (mounted in BOTH modes,
  before the `if (FREE_MODE)` branch - the paid gate block below it never mounts under FREE_MODE, which is why the first draft
  passed nothing) rewrites `POST /path` to `GET /path` when the catalog has only the GET, marks `req.__methodAliased`, and the
  identical gate chain runs (paywall keyed `GET /path`, PoW, replay, funnel); the JSON body is the input (`handlerInputOf` merges
  query + body, and `cacheKeyFor` keys on the merged input, so the GET cache cannot serve a different body's answer). A GET on a
  POST-only tool still 405s with `Allow` (a GET carries no body). Pinned in test-wrong-method-405 (served + body honoured) and
  test-head-paywall (unpaid POST alias -> 402 with PAYMENT-REQUIRED, garbage payment refused).
- **A rejected payment is answered in the buyer's terms (2026-08-28, `src/verify-hint.js`, `scripts/test-verify-hint.js` 18 in CI):**
  every verify failure surviving in Railway's removed-deployment logs read `[CDP (Base)] invalid_payload: contract call failed: unable
  to call contract: execution reverted` - CDP simulating the USDC transferWithAuthorization and the transfer reverting (an EMPTY wallet,
  or an authorization already spent / expired) - and the buyers' clients retried the same signed header ~400/hour because nothing said
  which. Now the awaited `onVerifyFailure` hook reads the payer's own USDC balance on Base (`usdcBalanceOnBase`: one `eth_call
  balanceOf` per payer per minute, 3 s bound, `AGENT402_BASE_RPC`) and remembers a hint for 5 minutes; `verifyHintMiddleware`
  (mounted before the MPP shim) merges `hint`, `retry` (`fund-wallet` | `fresh-authorization` | `other-network`) and
  `payerUsdcOnBase` into the 402 JSON body of a request that CARRIED a payment header from that payer, plus `Retry-After` (60 s when
  the wallet is short, 5 s otherwise); `error`/`accepts` untouched; a bare 402 and every non-402 are byte-identical. The balance goes
  only to the wallet that signed the authorization; `verify_failed` telemetry carries `payerBalanceBucket` (zero / under-price /
  covers-price / unknown), never an address or a number. Railway keeps logs of REMOVED deployments (list-deployments status REMOVED,
  limit <= 50): that is where the 08-28 reasons came from after the live deployment's log had nothing.
- **Missing `model` is served, not refused, and verify failures are telemetry (2026-08-28, from reading 30 days of real calls):** the
  single largest refusal on the LLM wires was `"model" is required` (82 in 30 days, 1 ms 400s: agents posting to a tier route with no
  model). Every non-router tier now carries `defaultModel` (nano gpt-4.1-nano, base gpt-4o-mini, pro gpt-4o, premium claude-opus-5,
  metered claude-haiku-4.5; advertised on `/v1/models` as `x402.defaultModel`), the chat wire marks the normalized body with a
  non-enumerable `__defaultedModel` (cache key and outbound body unchanged) and all three wires add `agent402_default_model` to the
  reply; the legacy `/api/llm` defaults to gpt-4o-mini. Pinned on every wire. **`verify_failed`** (posthog.js
  `capturePostHogVerifyFailed`, fired from payments.js's `onVerifyFailure`): network, scheme, route path, reason - never the payer;
  capped 300/hour. Why: the paywall's `usdc_failed` rollup showed ~10,000 failed paid attempts in 14 days (one client retrying a
  rejected payment ~400/hour on x402-trending + bestsellers on 08-26) against ~1,600 settlements and only 4 `settle_failed` events,
  and the container log with the verify reason had rolled off - the next burst is diagnosable from PostHog. What the 60-day buyer data
  said (2026-08-28): 250 external buyers, 92 one-call, 106 returned another day, 76 another week, 17 three+ weeks, median 2 settlements,
  $145 total; first buys are protocol test calls (random 42, stock-quote 25, compound-interest 13) and ~40% of those buyers return; the
  402 volume (300-540k/week) is index/trust probers (x402pulse, mako-pulse, kkj-trust-index, x402-observer, scanners walking the
  catalog), not agents leaving.
- **Metered Responses wire (2026-08-28, `POST /v1/metered/responses`, slug `v1-chat-metered-responses`):** the metered tier on the
  OpenAI Responses wire (the one Codex CLI's `model_providers` and the OpenAI Agents SDK speak). `RESPONSES_PATH_BY_TIER["v1-chat-metered"]`
  (LAST); `quote: (body) => meteredResponsesQuoteUsd(body).usd` prices the 402 from `validateResponsesRequest`'s probe through the shared
  `meteredQuoteForProbe`; the handler refuses over-cap bodies 400 before any upstream call, carries the belt (re-quote the served body
  against the stashed gate price), sends the quoted model's `costFor` row as `provider.max_price`, records `gateway_usage.priceUsd` = the
  quote, and sets the non-enumerable meter sentinel on the non-stream reply. `/v1/models` carries `meteredResponsesEndpoint`; `/docs`
  lists the row; the agent-hosts guide's Codex section carries a `model_providers` block (route canary-proven; a full Codex session not
  yet run - say so, never claim it). Registered: WALLET_ONLY (pow.js), test-all NETWORK, METERED_SLUGS (test-non-metered-examples),
  paid-canary leg `llm-metered-responses` (priceUsd pinned to the kit's quote in test-canary-coverage). test-llm-responses 40.
- **The weekly number is external metered buyers (2026-08-27):** PostHog insight "External metered buyers per week"
  (short id `Pj87HEzu`: distinct non-synthetic payers on `payment_settled{slug:v1-chat-metered}` per week, with
  settlements, settled USD, distinct `clientUa`); ledger mirror `meteredExternal({days})` (counts only) on
  `/__operator/sales.json` as `meteredExternal7d` and on `/api/proof` as `external.buyers7d`/`settlements7d`. Copy made
  metered-first the same day: `/docs#gateway` and `/pricing` list `/v1/metered/chat/completions` first ("from $0.001,
  quoted per request, settles actual usage under the quote"), the /pricing intro points SDKs at `/v1/metered`, the
  homepage eyebrow reads "Wallet or card. Same key, same receipts." (pinned in test-home-page), and the FAQ line
  "nothing is token-metered" (false since the metered tier) now describes the metered route. The plugin proxy sends
  `User-Agent: agent402-openclaw/<version>`, so `payment_settled.clientUa` splits metered buyers by host.
- **Security review of the metered Messages wire (2026-08-27, two HIGHs reproduced with the real modules, fixed the same
  day):** (1) an OVER-CAP Messages body was SERVED at the $2 cap - `meteredQuoteForProbe` clamped the 402 quote to
  `maxQuoteUsd` and the handler never refused (a 190k-char CJK body on opus-4.7-fast cost ~$8 upstream for $2; the chat wire
  refuses this inside `validateRequest`). The Messages handler now refuses 400 on `overCap` BEFORE any upstream call, with
  or without a request (`meteredQuoteForProbe` returns `rawUsd` beside the clamped `usd`); the belt refuses `overCap` too.
  (2) `route-execute` ($0.01) dispatched the quoted metered tools via `def.handler(params)` with no request - no quote, no
  belt, no cap - and nested the result, so `result.result.__meterUpstreamUsd` (our exact OpenRouter bill) reached the buyer.
  `dispatchable()` now refuses any def with a `quote` function ("per-request-priced tools are quoted from the body - call
  them directly"), the executor deletes the sentinel from any nested result, and the sentinel itself is NON-ENUMERABLE
  (`setMeterSentinel` in gateway-meter.js: readable by the route binder, invisible to `JSON.stringify`/`Object.keys`
  however deep it is nested; `applyMeteredSettlement` still deletes it). Inherited (fixed too): `worstCaseUpstreamCost`
  min'd the model row with `tier.maxPrice` (20/100) while the metered handlers send the RAW row as `provider.max_price`, so
  opus-4.7-fast (30/150) / gpt-5-pro quoted ~30% under their bound - the metered tier now quotes the un-min'd row. Tests:
  test-llm-messages (56), test-gateway-meter (58), test-route-execute (54).
- **Claude Code as an LLM host, proven (2026-08-27 evening):** `ANTHROPIC_BASE_URL=https://agent402.tools/v1/metered` +
  `ANTHROPIC_AUTH_TOKEN=<credits key>` runs Claude Code end to end (guide block on `/guides/agent-hosts`). Measured wire
  (claude-cli 2.1.250 against a catch server, then the real local gateway with the prod OpenRouter key): POST
  `/v1/messages?beta=true` appended to the base URL, Bearer auth, a 4 KB session-naming call with `tools: []` then a ~110 KB
  turn (system array with `cache_control`, 22 function tools, `max_tokens: 64000`, `thinking:{type:"adaptive",display:
  "omitted"}`, `output_config`, `context_management`, `metadata.user_id`, a MID-CONVERSATION `role:"system"` message per
  turn - the mid-conversation-system beta - and an 8-beta `anthropic-beta` header). Shipped: (1) server.js rewrites
  `/v1/<tier>/v1/messages` (and `/v1/v1/messages`) to the tier's Messages route BEFORE every gate (`MESSAGES_SDK_ALIASES`,
  query string kept) and mounts `express.json({limit:"1mb"})` on `/v1/metered` ahead of the global 100 KB parser (a metered
  body is priced from its size, so a big body is a big quote, never an unpriced cost; flat tiers keep 100 KB;
  `/v1/models` now advertises the metered tier's real 200k cap); (2) `validateMessagesRequest` folds a mid-conversation
  system message into a user turn in place, treats `tools: []` as no tools, and `canonicalModel` resolves Anthropic's dated
  ids (`claude-haiku-4-5-20251001` -> `anthropic/claude-haiku-4.5`); unknown fields (`output_config`, `context_management`)
  stay dropped, `cache_control.ttl:"1h"` stays refused. Proof: a full turn ("ok / I'm Sonnet 5") and a Bash tool-use round
  trip (`agent402-proof-42`) through the local gateway; quotes measured $0.115 (2 KB) / $0.22 (115 KB) on sonnet-5 at the
  8192 output cap, settled at actual. `scripts/test-messages-sdk-alias.js` (13, boots a paid server, in CI) + pins in
  test-llm-messages/test-llm-gateway. NOT done: `/v1/messages/count_tokens` (Claude Code did not call it in either run).
  **THE STREAMING RELAY WAS BROKEN FOR EVERY /v1 STREAM (found by this proof, fixed the same night):**
  `createSseUsageScrubber` decoded chunks with `Buffer.isBuffer(chunk) ? toString : String(chunk)`, and fetch's body yields
  `Uint8Array`, so `String(chunk)` was the comma-joined byte digits ("58,32,79,80..." = ": OPENROUTER PROCESSING") - no
  newline, no `data:`, the whole stream surfaced at `flush()` as digits. Before 13112334 the relay wrote 200 and streamed
  the digits (charged); after it every stream 502'd "no data frame" (uncharged). The 20:05Z paid canary saw exactly this on
  `llm-stream` ("bad-shape ... got 58,32,79,80,...") and only WARNED; the relay's unit tests fed Buffers and passed (the
  stub-proven lesson again). Now a streaming `TextDecoder` (multibyte-safe across chunks), the relay's catch logs its
  cause, the scrubber test feeds `Uint8Array` chunks with a split multibyte char, and paid-canary legs can declare
  `strictShape: true` (llm-stream does) so a settled 200 with the wrong wire shape FAILS the run (`decideCanary` reason).
- **`/markets` front door (2026-08-27, `src/markets.js`):** one page, one curl (`crypto-market-pulse`, $0.004, keyless),
  then the 24 keyless market-data tools (pulse/news/indicators, 7 perp tools, 4 options tools, 10 DeFi/stablecoin tools)
  as cards with prices READ FROM `CATALOG` (never typed; `marketsTools(catalog)` drops retired slugs). Built because the
  buyer-count leaders on x402scan are one-endpoint utilities (OneSource 1,802 buyers on 25 paths, glim 481 on 34) while
  our 500+ tools convert to ~105 - the front door is one obvious call, not breadth. Wired: server mount, both sitemaps,
  llms.txt Optional list, mobile menu, footer "for agents", test-static-pages + test-single-main-landmark. Same commit:
  purpose-written `BAZAAR_DESCRIPTIONS` for the 20 market-data slugs that were still falling back to truncated catalog
  text (derivatives/signals/defi), the first advertising the derivatives kit ever got (Kronos sells the same categories at
  $0.02-0.10 to 50 buyers; ours are $0.002-0.005).
- **x-data-kit repriced to X's published rate card (2026-08-27):** X pay-per-use bills $0.005 per post READ and $0.010 per
  user read (docs.x.com pricing, read 2026-08-27; resources dedupe within a UTC day). Page cap 25 -> 10 posts
  (`X_MAX_POSTS_PER_CALL` default), users-lookup cap 100 -> 10; prices x-search-recent $0.006 -> $0.08, x-user-tweets
  $0.01 -> $0.08 (10 posts = $0.05 upstream, under the 70% rule), x-user $0.005 -> $0.015, x-tweet $0.005 -> $0.008,
  x-users-lookup $0.01 -> $0.15. The kit still lists only with `X_BEARER_TOKEN` on Railway (the operator's call; the bearer exists
  only in Actions secrets). Market context: twit.sh (118 buyers of X data) stopped settling 2026-08-22; StableSocial sells
  X at a flat $0.06 through Scrape Creators. Hunter/Apollo (b2b-enrich, $0.02-0.05) need signups - unchanged.
- **Reports for humans: measurement + first fixes (2026-08-27 night; the operator's direction: "reports for humans, go"):** measured
  before building - 30d: ~470 homepage visitors (mostly direct, then Google/X/ChatGPT), 26 reached `/reports`, 13 `/monitors`,
  1 card sale, 0 active monitors, 0 credits keys; the 253 programmatic SEO pages had ZERO human pageviews and are not in
  Google (the query space is OpenInsider/SecForm4/GuruFocus); no PostHog event existed between `/reports` and a sale. Shipped:
  (1) **real sample reports** `src/sample-reports.js` + `assets/samples/<product>.json` -> `/reports/sample/<product>`
  (indexable, own title/canonical/Report+Product JSON-LD, same viewer as a buyer, `sample:true` turns the keep-hint into a
  buy box for the reader's own input; `/api/reports/sample/<product>` serves the bundle; in sitemap-reports; the /reports
  cards link "See a real sample" only where a fixture exists) - fixtures are REAL runs of the production handlers made on a
  local FREE_MODE boot with the prod upstream keys (dossier NVDA, insider NVDA, fund Berkshire, domain github.com, research
  jet-fuel hedging, recall losartan), `scripts/test-sample-reports.js` (73, boots, in CI) pins finished-report shape/no stub
  markers/no buyer fields/indexability; regenerate with the same recipe, never serve live generation on a free page;
  (2) **funnel instrumentation**: server `human_funnel` PostHog event (`capturePostHogHumanFunnel`: checkout_started /
  checkout_refused / paid / failed / report_opened / monitor_checkout_started / monitor_paid; product + price only, never the
  input or email) and client `report_buy_click` (reports.js, report-buy.js, sample buy box) / `monitor_subscribe_click`;
  (3) live bug: the LinkedIn card's buy button posted `product: undefined` (missing `linkedin` in reports.js sel/need maps);
  (4) homepage prose prices derived from HUMAN_PRODUCTS/MONITOR_PRODUCTS (was "$1 to $2, monitors $3" against $2-$5/$5);
  (5) wait copy "one to three minutes, deepest five" + an elapsed counter on the delivery page (was "about a minute" vs the
  storefront's "two minutes"); (6) homepage people door links the three free programmatic hubs (they were reachable only
  from /reports). **recall-report was unsellable:** openFDA answers HTTP 404 for a no-match search; fetch-guard relabels it
  422 and gov-kit's getJson relabelled that 502, so `getJsonAllowEmpty`'s `statusCode === 404` never matched and any drug
  absent from the food+device feeds (most) 502'd the 2-of-3 gate - now `upstreamStatus` rides through and a 404 is never
  retried (`scripts/test-recall-nomatch.js`). IndexNow: 256 URLs (the 253 report pages + /markets, /reports, /monitors)
  submitted 2026-08-28 01:4xZ. the operator-owned: Google Search Console sitemap submission; posting the samples. NEXT (not built):
  email capture + post-purchase sequence (one transactional email exists, no list), a shareable/public report option (every
  /r/ page is noindex + generic OG, so the paid artifact has no backlink surface), monitors for research/dossier kinds,
  seed expansion, a first-report promo. Weekly number for this bet: card sales + `human_funnel` conversion, not x402scan rank.
- **Sample review round 2 (2026-08-28 evening, from reading the generated samples and feeding the defects back into the
  kits):** five more real samples generated on a local FREE_MODE boot with the keys pulled from Railway (OpenRouter now via the audit key - see the broken-tool-audit entry; sample generation is the same class of spend and belongs under the same label) (filing AAPL, token
  JUP, market brief EV fast charging, ticker pack MSFT, LinkedIn article on per-request pricing) and each READ before publishing. Defects
  found and fixed in the kits, not the fixtures: (1) every kit writes its own H1 and the model wrote ANOTHER H1 + subtitle at the top of
  its prose (AAPL filing, JUP token) - `dropModelTitle` in house-style.js (inside `houseStyleMarkdown`, so every report tier and the
  sample loader get it) removes a second H1 within the first 1,500 chars plus its subtitle H2; a later H1 is content and stays; (2) the
  filing report listed three Form 4s and a Form 144 as NOT FETCHED ("the reporting persons cannot be stated") - `filing-watch-kit`
  now parses Forms 3/4/5 through `parseForm4` and Form 144 through `parseForm144` (raw XML = index url without the `/xsl.../` segment,
  `rawXmlUrl`; up to `ROUTINE_PARSE_MAX` 10; `deps.fetchForm` seam) and hands the synthesis a `=== ROUTINE FORMS PARSED ===` block
  (`describeRoutineForm`: insider + role, code/acquired-disposed, shares, price, owned after, 10b5-1; the 144 seller, size, value, date,
  broker, plan), rule 3 lets those be summarized, the header counts "N ownership forms parsed", `meta.routine_forms_parsed`; (3) the token
  brief called a locker unlock dated 2025-08-13 "upcoming" - rule 9 states TODAY's date and that past dates have elapsed; (4) the ticker
  pack's executive summary narrated the pipeline ("the dossier leg was produced successfully ... citing 20 sources") - rule 6: write about
  the company, coverage facts in one sentence, only a FAILED leg is named; (5) a Unicode minus sign survived house style - normalised.
  The samples for the three changed kits were regenerated on the fixed code. Recipe: `scratchpad/make-samples.sh` shape - pull keys with
  `railway variables -s agent402 -e production --json` into a 0600 env file, boot FREE_MODE on a free port, POST each route, save
  `{product,input,title,report,sources,tables,meta,at,generatedWith}`; never commit the env file.
- **Weekly spend digest + the homepage sentence (2026-09-02 night, `src/wallet-digest.js`, `src/digest-page.js`,
  `assets/js/digest-signup.js`, `scripts/test-wallet-digest.js` 29 in CI):** 92 of 250 buyers in 60 days bought once and
  nothing ever spoke to them again, because a wallet has no inbox. `/digest` subscribes an email to the identity a buyer
  already pays with: an EVM wallet proved by `personal_sign` over `digestProofMessage` (address + email + timestamp,
  15-min window, verified with viem `verifyMessage`) or a credits key proved by presenting it (`keyIdOf`, never stored)
  - a new key's claim email carries its own signed confirm link (`preEnrolCredits` -> `digestLinkFor` in credits.js).
  Same posture as free-alerts: double opt-in (the click is the consent), signed unsubscribe that drops the address,
  `List-Unsubscribe` headers, 3 per address, 5,000 store, pending TTL 3 days, counts-only `/__operator/digest.json`,
  `POST /__operator/digest/run?force=1`. One email a week from `payerUsage(payer, {days:7})` (calls, dollars, top
  tools, chains; `balanceById` + top-up link for a credits key); a quiet week after the first digest sends nothing
  but still advances the clock. Tick hourly (first +10 min); `WALLET_DIGEST=off` disarms. Secret rule = the alerts'.
  Same commit: the hero now leads with the one sentence - "No account. No API key. No card on file." / "Pay for any API
  call without an account." - pinned in test-home-page.
- **Free email alerts = the lead magnet on the free report pages (2026-08-28, day 2 of the reports bet; `src/free-alerts.js`,
  `assets/js/alert-signup.js`, `scripts/test-free-alerts.js` 35 in CI):** a visitor on `/reports/insider/<T>`, `/reports/fund/<m>`,
  `/reports/dossier/<T>` or a sample report enters an email; we watch that one target with the SAME free daily probe the paid
  monitors use (insider `probeInsiderFilings`, filing `probeCompanyFilings`, fund `resolveManager`+`latest13fFiling`, domain
  `probeDomain` fingerprint, recall `probeRecalls`; adapters in server.js return `{ids, items}`) and email ONLY on new ids, at most
  once a day, with the free page + buy CTA + the matching monitor upsell + a signed unsubscribe link (`List-Unsubscribe` header
  on Resend). Rules in code: DOUBLE OPT-IN (a signed `/alerts/confirm?id&k` link; nothing probed or sent before it; a signup
  whose confirmation email cannot be sent is refused 503 and not stored), `MAX_PER_EMAIL` 5, `MAX_STORE` 5000, pending TTL 3
  days, 5 failures then back-off, probe cap 200/tick, tick every 6h (first +5 min), store `/data/free-alerts.json` (atomic),
  honeypot field + `alerts-signup` limiter 6/min at `POST /api/alerts`, `POST /alerts/unsubscribe` for RFC 8058 one-click,
  operator `GET /__operator/alerts.json` (counts only) + `POST /__operator/alerts/run?force=1`. Secret = `FREE_ALERTS_SECRET` ||
  `POW_SECRET` || `MPP_SECRET_KEY` (none = signup 503; prod has POW_SECRET). `FREE_ALERTS=off` disarms the timer. PostHog
  `human_funnel` steps alert_signup / alert_confirmed / alert_sent / alert_unsubscribed, client `alert_signup_click`. Privacy +
  terms carry the alert clauses ("No account or signup" became "No account"). Sample-page mapping `ALERT_KIND_FOR_REPORT_KIND`
  (dossier -> filing). `sendEmail` takes an optional `headers` object (Resend only; ZeptoMail's documented body has none, the
  body link is the guarantee).
- **Post-purchase follow-ups (2026-08-28, day 3 of the reports bet; `src/followups.js`, `scripts/test-followups.js` 19 in CI):**
  a card buyer used to get one email ever. Now `createHumanCheckout` takes `onDelivered` (fires at the done hook with the
  session email, never stored on the record) and `onFailed` (the refund path); server.js enqueues a two-step sequence per
  purchase - day 2 the monitor for the SAME target (skipped silently for kinds with no monitor), day 7 "another report?" with
  the free sample pages - and sends the failure/refund notice at once. Every follow-up carries a signed
  `/followups/stop?id&k` link + `List-Unsubscribe` (RFC 8058 POST too); a repeat buyer's older sequence stops
  (`markRepeat`); a mail failure leaves the step pending, never marked sent; store `/data/followups.json` (atomic, pruned
  after 30 days when done); hourly tick (first +3 min); `FOLLOWUPS=off` disarms; operator `/__operator/followups.json`
  (counts). Same secret rule as the free alerts. `KIND_ALIAS` gained `dossier -> filing`, so dossier buyers get the filing
  watch in the ready email, the viewer upsell (`monitorMapJson` now carries alias keys) and the day-2 email; research and
  market-brief still have no monitor. Privacy: the card-purchase bullet names the two follow-ups and the refund email.
- **Public reports (2026-08-28, day 4 of the reports bet; `scripts/test-public-reports.js` 18 in CI):** every `/r/<session>`
  page is noindex with a generic card, so a paid report earned no link. Now the viewer's action bar carries "Make public" /
  "Make private" (`POST /api/r/:sessionId/public {public}` - the session id is the only credential, whoever holds it bought
  the report); `setPublic` mints an unguessable `rp_` id ONCE (revoking makes the link dead, re-publishing brings the SAME link
  back), keeps `public/publicId/publishedAt` on the record and an `_public.json` index; module-level `readPublicReport` /
  `listPublicReports` (human-checkout.js) serve `/reports/public/:publicId` + `/api/reports/public/:publicId` with or without
  a Stripe engine (files on the volume) - indexable, own title/canonical/Report JSON-LD, the shared viewer in `publicView`
  mode (buy box for the reader's own subject, like a sample), listed in `sitemap-reports.xml`, sessionReadLimiter on both.
  The record never held buyer identity, so a public view leaks nothing. PostHog steps report_published / report_unpublished.
  Privacy names the option.
- **Research question watch + storefront samples strip (2026-08-28, day 5 of the reports bet):** `research-monitor` ($5/mo,
  kind `research`, slug `research`, target = the question, validator 12-300 chars) - the last report kind with no upsell; there
  is no cheap probe for "did the answer change", so the product IS the weekly re-run: `processResearch` in monitor-scheduler
  (welcome on first sight, a fresh paid run every `RESEARCH_RERUN_MS` 7 days with the "scheduled" email, the 30-day cap of 4
  holds a fifth weekly run as "checked" until old runs age out; measured research cost ~$0.11/run so 4 runs <= $0.44 against
  the $4.56 net fee). market-brief (kind research) inherits the upsell; only `linkedin-article` has none now (pinned in
  test-report-upgrade). One-shot Checkout accepts Stripe promotion codes (`allow_promotion_codes: true`; codes are created in
  the dashboard). `/reports` hero carries a "read a real one first" strip built from `SAMPLES`. test-monitor-scheduler 56.
- **Security + footprint review, four lenses (2026-08-28; injection / money+abuse / secrets+supply-chain+infra / investor
  footprint; 47 findings, 38 fixed in one PR, 9 operator-only):** CRITICAL stored XSS on /marketplace from a crawled
  manifest's `capabilities.tools` STRING reaching `data-tools=` unescaped with unpkg still in `script-src` - `manifestToolCount`
  coerces at ingest (x402-index.js), `Number()` belts at every render site, unpkg dropped from the CSP, HSTS `preload`.
  HIGH credits abort: `finish` never fires on a destroyed socket, so the gate's `close` RELEASED the hold after dispatch (a
  free /v1/research; reproduced) - close after dispatch now SETTLES like every other rail (test-credits pins it). HIGH the
  nightly backup skipped every DIRECTORY store (credits/, human-checkout/: balances and paid reports had no offsite copy) -
  bundled as gzip'd NDJSON (`stageDir`, `<dir>.ndjson.gz`), real names in PRIORITY, test-backup pins the bundle. HIGH
  `compileUserRegex` shape list was bypassable ((a|a)*b ran 4.8 s on the free tier) - quantified groups + backreferences
  refused and `testUserRegex` runs every caller regex under `vm.runInNewContext({timeout:50})` (V8 interrupts a running
  regex; measured a+a+b on 10k chars 137 s -> 52 ms 400); json-validate + html-links use it. HIGH TIFF bomb (138 bytes
  declaring 30000x30000 -> 4.4 GB before the cap) - TIFF IFD0 + WebP headers parsed in `declaredDimensions`, unreadable
  containers refused on the free loader, image-pool workers carry `resourceLimits`. HIGH quadratic meta regex in tech-stack
  bounded. MED: sql-guard backslash-escape only inside E'...' (a `\'` hid a second statement) and EXPLAIN ANALYZE / SELECT
  INTO / DO / CALL / CTE MERGE are mutating; analytics loader redacts bearer URLs (/r/, /m/, /reports/public/, /alerts/,
  session=/k=/id=) from every URL property; report-view links render only to CITED-SOURCE hosts and the research prompt
  fences each source as quoted material with rule 8; tempo-buyer carries `ssrfDispatcher`; alert confirmation resend
  cooldown 10 min / max 3 + a per-address limiter; fund validator cached 1h + a global rate cap; promo codes: `amount_total`
  booked, `no_payment_required` fulfilled; webhook `event.id` dedupe 24h; metered unpaid-quote limiter per IP (rates in CLAUDE.local.md);
  Tempo-settled requests seed idempotency; tollbooth strips x-real-ip/cf-connecting-ip/true-client-ip/x-forwarded-proto/
  port/via; PDF getText 30 s deadline; `Object.hasOwn` on monitor report ids + WIKI slugs; https-only links in alert emails;
  dns tools refuse .internal/.local/localhost; Redis plaintext refused off the private mesh (`assertRedisTransport`);
  six workflows got `permissions:` (two alarms could not open issues); `MONITOR_MANAGE_SECRET` + `FREE_ALERTS_SECRET`
  hooks with verify-only fallbacks; privacy policy corrected (first-party PostHog in the browser, Sentry, shadow ledger,
  waitlist stores no IP/UA now, alerts drop the address at unsubscribe) + `scripts/erase-subject.js`; this file scrubbed
  of personal identifiers (no personal hostnames, names or wallet linkage - keep it that way, it is public). Footprint:
  `/security` (src/security-page.js) + `/company` (src/company.js) pages, security.txt Policy -> /security and Contact ->
  security@, SECURITY.md controls paragraph + 2-business-day ack + safe harbor, README first screen + CodeQL/secret-scan
  badges, one price ladder everywhere (FAQ, x402 manifest, listings), "70+ skill packs" (74 live), third-party names and
  "no model" absolutes rewritten affirmatively, /community shows the real samples, em dashes out of llms.txt/emails,
  /transparency headlined "Disclosures", status paid-call blurb, CODE_OF_CONDUCT.md. Mailboxes DECIDED 2026-08-28: one
  mailbox, `mike@agent402.tools`, for general/security/legal/conduct; investors and partnerships route to
  `hello@havok.holdings` (/company, /contact); no role aliases. Still operator-only: Railway `FREE_ALERTS_SECRET` +
  `MONITOR_MANAGE_SECRET`, GitHub production-environment reviewer + deploy-branch policy + ruleset without the standing admin
  bypass + Dependabot security updates + delete the unused NPM_TOKEN secret. Follow-ups in code: client-side backup
  encryption, tollbooth Tempo chain-truth confirm, shell 404s on seven fragment routes, operator-token guessing pager.
- **Backups encrypted client-side + shell 404s (2026-08-28, review follow-ups):** `BACKUP_ENCRYPTION_KEY` (32 bytes, 64 hex or
  base64) wraps every staged object in AES-256-GCM (`A402ENC1` + 12-byte IV + ciphertext + tag, object suffix `.gz.enc`);
  without it the run still uploads plain gzip but `status.encrypted:false` and the boot line WARNs. `scripts/backup-restore.js
  <object> [--out|--unbundle]` decrypts, gunzips and unbundles the NDJSON directory stores, dependency-free. test-backup (34)
  pins the encrypted upload, a tampered object failing auth, and the restore path. Set the key on Railway (operator). The
  nine bare `<p>Not found</p>` fragment routes (tool, category, guide, skill, doc, blog, adapter, sample, public report) render
  through `notFoundPage(res, {what, href, label})` (server.js, the shell 404 with the section link).
- **Checkout rate limit runs BEFORE the body parser (2026-08-29, `CHECKOUT_RATE_PATHS` + `scripts/test-checkout-limiter.js` 12,
  in CI):** an Acunetix-class scanner (one IP, spoofed Chrome UA, ~170 requests in 25 s) probed `POST /api/buy` with path
  traversal, `file:///etc/passwd`, `/WEB-INF/web.xml`, ASP SSTI (`response.write(9889177*9680697)`) and ESI
  (`bxss.me`) in the `product` field. Every one was refused - `createSession` does
  `Object.hasOwn(HUMAN_PRODUCTS, String(productKey))`, an allowlist key check, so the value never reaches a filesystem
  call, a template, an eval or a fetch, and `hasOwn` also blocks `__proto__`-style keys - and no session, report, charge
  or refund resulted (`inflight` empty, 0 `paid` events in 30 days, `compositeUsage.runs` 0; the 7 x 200 on `/api/alerts`
  were the honeypot answering `{ok:true}` while storing nothing, `emailsSent` 0). **The finding was the COUNTING:** 86 of
  the 170 were answered 400 while PostHog recorded only 43 refusals, because `express.json()` is mounted globally BEFORE
  these routes - an unparseable body 400s at the parser and never reached the in-route rate check, so half the burst was
  counted against nothing. Now one `app.use(CHECKOUT_RATE_PATHS, ...)` runs ahead of the parser for `/api/buy`,
  `/api/subscribe`, `/api/credits/checkout` and `/api/mpp/monitors/subscribe`, sets `req.__checkoutRateChecked`, and the
  in-route checks read that flag so one request still spends exactly one token; the ceiling is a per-minute plus a per-hour cap, tightened from the
  earlier values (a real buyer clicks Buy once, a few times when comparing; numbers in CLAUDE.local.md). Mutation-tested: moving the guard back after the
  parser, or restoring the old per-minute ceiling, each fails the suite.
- **Operator-token guessing pager (2026-08-28):** wrong operator credentials are counted globally over a rolling hour
  (`noteOperatorAuthFailure`, server.js; per-IP limiter unchanged), exposed as `operatorAuth: {status: ok|elevated,
  failures1h, threshold}` on `/api/gateway-status` (counts only), threshold `OPERATOR_AUTH_FAIL_ALERT` (default: see CLAUDE.local.md); heartbeat
  leg "Operator token guessing ELEVATED" opens/closes an issue; a boot-log WARN fires at most every 10 min. test-operator-auth 36.
- **GitHub control plane hardened (2026-08-28, applied by the operator's `gh` session):** the `agent402 / production`
  environment carries a deployment branch policy of PROTECTED BRANCHES ONLY, so the deploy job runs only from `main` (a
  dev-branch `[deploy]` push can no longer ship prod - the policy enforces what the 2026-08-25 rule asked for); the
  "protect main" ruleset's admin bypass is `pull_request` mode (merge-on-green.sh's `--admin` merge still works; a direct
  push to main by an admin session does not); Dependabot security updates are ON (fix PRs are opened, never auto-merged);
  the unused `NPM_TOKEN` Actions secret is deleted (publishing is OIDC). No required reviewer on the environment: with one
  owner it would be self-approval on every deploy.
- **One price per report on the card storefront (2026-08-28, decided from research, not preference):** `/reports` no longer shows
  Standard/Pro/Max tier buttons; every card sells its base product at one price with a "What you get" line written in deliverables
  (words, sections, tables), never effort counts ("8 searches vs 3" is exactly the non-alignable attribute the choice-overload
  literature says hurts a first-time buyer; the decoy effect does not replicate with realistic products; one-off report comparables
  differentiate by included content or quantity, never by depth). The pro/max tiers stay as AGENT API products (REPORT_TIERS,
  HUMAN_PRODUCTS keys kept so old sessions, /api/buy and docs still resolve). Re-tier only behind a visible deliverable fence and
  once card sales can read an A/B test.
- **Dev shortlinks + `/install` + six more hosts on `/guides/agent-hosts` (2026-08-28, `src/shortlinks.js`, `scripts/test-shortlinks.js`
  in CI):** agent402.sh (and agent402.co) are name.com-registered redirect domains that 301 path-preserved to agent402.tools (content
  lives ONLY on .tools; redirects are never indexed, the guide is in the sitemap + llms.txt). `SHORTLINKS` = `/claude /cursor /vscode
  /copilot /windsurf /cline /roo /codex /gemini /continue /eliza /openai /anthropic /agentcore /bedrock /openclaw /agentkit /langchain
  /llamaindex /adapters /hosts /key /api` -> 302 to a real page; `/install` serves a POSIX script (`curl -fsSL agent402.sh/install | sh`:
  `claude mcp add` when the CLI is present, OpenClaw/Cursor pointers, guide link; no sudo). Guide headings carry GitHub-style ids
  (`headingId` from the heading's TOKEN TEXT, never rendered html - CodeQL flagged the regex tag strip). The agent-hosts guide gained VS
  Code (`.vscode/mcp.json`, `servers` + `type:"http"`, `${input:}` for the key), Windsurf (`mcp_config.json`, `serverUrl`, 100-tool
  cap, `${env:}`), Cline (`streamableHttp`; its OpenAI Compatible provider takes `/v1/metered` as base URL), Roo Code (`streamable-http`,
  `.roo/mcp.json` wins), Codex CLI (`codex mcp add --url`; NOT a model host here: `model_providers` speak Responses only and the metered
  tier has no Responses route yet) and Gemini CLI (`gemini mcp add --transport http`, `httpUrl` = streamable, `url` = SSE) - every
  block read from the host's own docs the same day. The hosted `/mcp` does NOT take a Bearer credits key (paid tools ride the stdio
  `agent402-mcp` with `AGENT402_CREDITS_KEY`), so every "paid by card" block is the stdio form. Guide `md` is a JS template literal:
  literal `${...}` in a block must be written `\${...}`.
- **Domain audit inputs round 2 (2026-08-28, from a buyer's own review of a live run on their domain; `scripts/test-domain-audit-inputs.js`
  34, in CI):** the audit said "no DKIM" to an iCloud+ domain that signs with `sig1` - `email-deliverability` now resolves MX FIRST and
  probes the provider's own selectors (`PROVIDER_DKIM_SELECTORS`/`providerForMx`, network-kit: Apple sig1, Fastmail fm1-3, Proton,
  Zoho, M365, Migadu, IONOS, Mailgun, Proofpoint, Mimecast, ...) ahead of the common list, and reports `mx.provider`; verified live
  (sig1 2048-bit found). `probeDnsPosture` resolves NS and maps the DNS host (`DNS_HOSTS`/`dnsHostFor`: Railway offers no CAA/DNSSEC,
  Vercel/Netlify no DNSSEC, ...) so the prompt can refuse an infeasible recommendation; `probeWwwPair` checks the www/apex twin
  (reachable, redirect, HSTS on both); the prompt carries a REPORT MAILBOXES block (rua/ruf/iodef addresses the domain actually
  publishes) and eight fix rules (never invent a mailbox, feasibility, CAA with platform certs = name both CAs or skip, cross-origin
  headers advisory, strict vs permissive CSP, Server header informational, escalate monitor-first, check both hosts). `http-headers`
  (network-kit2): COOP/CORP/COEP are `advisory` findings with weight 0 (score = the six core headers scaled to 100), a CSP with
  'unsafe-inline' and no nonce/hash scores half and is named, report-only CSP is a warning, the Server header is `info:`. Report
  links negotiate JSON: `/r/<id>` and `/reports/public/<id>` with `Accept: application/json` serve the bundle from the matching
  `/api` route, HTML responses carry `Link: rel="alternate" type="application/json"`.
- **House style enforced in code on every report (2026-08-28, `src/house-style.js`, `scripts/test-house-style.js` in CI):** the
  models write em dashes into headings and prose whatever the prompt says (the NVDA dossier, Berkshire fund and jet-fuel research
  fixtures all did), so server.js wraps EVERY `REPORT_TIERS` handler at catalog build (`withHouseStyle`, in place, before
  `_premiumHandlers` is built - agents, card buyers, monitors and samples all reach the wrapped one): heading dashes become
  colons, prose dashes a spaced hyphen, numeric ranges a plain hyphen; urls/b64/hash/tx keys untouched, the non-enumerable meter
  sentinel survives. Page titles for every kind come from `reportHeadline()` (human-checkout.js): the report's own H1
  normalised (an all-caps fund H1 is title-cased, tickers kept), else `<product label>: <subject>` - a record's stored `title`
  is often just the buyer's input and was the public page title until this. Used by the public page (title, Report JSON-LD,
  breadcrumb) and the sample pages.
- **`/proof` + `GET /api/proof` (2026-08-27, `src/proof.js`, `proofFeed()` in sales-ledger):** receipts for the metered
  tier - the ledger now stores `quote_usd` (additive column) next to the settled `price_usd` on every metered sale
  (`recordSale({quoteUsd})` from the route binder's `req.__meteredQuoteUsd`), and the page shows aggregates plus ONE
  latest external row and ONE latest internal (daily canary) row with the settle tx and an explorer link - never a
  payer, never a per-call feed (the mppSales lesson); the EXTERNAL row's timestamp is truncated to the hour
  (`atPrecision`), matching /api/revenue/mpp, the canary row keeps the second. Linked from the /why proof point ("receipts"), sitemap,
  test-static-pages; `scripts/test-proof.js` (10, in CI). Purpose: one published receipt a week (external once an
  outside buyer settles on the metered route; until then the canary's, labelled ours).
- **Distribution surfaces checked 2026-08-27:** Continue has no Hub to publish to (hub.continue.dev does not resolve,
  docs carry no hub/blocks pages) - the config.yaml snippet on /guides/agent-hosts is the whole path; ElizaOS plugins
  live in the `elizaOS/eliza` monorepo `plugins/` directory (no separate registry repo resolves), so a listing there is
  a PR to their monorepo - the operator's call before opening; AgentCore: `examples/agentcore-gateway/` (CLI forms from the AWS
  developer guide: `mcp-server` target for `/mcp`, `open-api-schema` target for `/openapi.json`); a live gateway proof
  needs `aws login --profile agent402` (session expired) - the operator.
- **`/guides/agent-hosts` (2026-08-27):** one page of copy-paste blocks for Claude Code, Cursor, Continue, ElizaOS, any
  OpenAI SDK and Bedrock AgentCore - models via `https://agent402.tools/v1/metered` + credits key as the API key (every
  block verified against the host's own docs the same day: Claude Code `claude mcp add --transport http` / `-e`, Cursor
  `.cursor/mcp.json` url/command shapes, Continue `config.yaml` models.apiBase/apiKey + mcpServers streamable-http,
  ElizaOS `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_*_MODEL`/`OPENAI_EMBEDDING_URL` from plugin-openai's config.ts,
  AgentCore OpenAPI target + AgentCore Payments x402 flow from AWS docs) and tools via `/mcp` or `npx -y agent402-mcp`
  with `AGENT402_CREDITS_KEY`. DELIBERATELY NOT on the page: Claude Code as an LLM host over our Messages wire (it sends
  70-100k+ chars per turn into a 100 KB body limit at the $0.50 premium tier, plus adaptive thinking / context-management
  betas our validator has not been proven against - unverified = not claimed) and Virtuals GAME (no custom LLM endpoint,
  GAME API key only). Live check before publishing: the credits gate answers a `402 {reason:"malformed"}` to a bad
  Bearer on both `/v1/metered/chat/completions` and `/v1/messages` on prod. Same commit: `/v1/models` advertised
  `meteredMaxInputChars: 200000` past the 100 KB body limit - clamped to `ADVERTISED_MAX_INPUT_CHARS` (85,000) like
  premium. Prices on the page are template-derived (test-price-prose). Local `test-csp-violations` runs need
  `TARGET_URL=http://127.0.0.1:PORT` (a `localhost` target trips `connect-src 'self'` on the explorer pages; not a defect).
- **agent402-openclaw 0.4.0: wallet at setup + ClawHub-ready (2026-08-27):** `setup` with no credits key and no
  `AGENT402_WALLET_KEY` now MINTS an EVM wallet into `~/.openclaw/agent402/wallet.key` (0600, `wx` so a rerun never
  rotates it, key never printed) and prints the address to fund with USDC on Base - the same first-run shape as a
  per-token router that prints a wallet at install; `--no-wallet` opts out, a credits key on argv/env/file skips it,
  viem missing = card hint instead. `resolveWalletKey` (config > env > file) feeds the proxy, `doctor`,
  `permit2-approve` and the new `wallet` command (address + USDC balance). OpenClaw's docs do NOT carry a static
  third-party provider catalog (their `docs/plugins/community.md`: ClawHub is the discovery surface; provider pages are
  bundled or `@openclaw/*-provider` packages), so an upstream docs PR is the wrong lever - the listing path is
  `clawhub package publish ./openclaw` (dry-run validates and lists the 9 files; it required `openclaw.compat.pluginApi`
  + `openclaw.build.openclawVersion` + `install.minHostVersion`, now in package.json); the real publish needs a
  ClawHub login = the operator. openclaw/test.js 75. **Published on ClawHub 2026-08-27 by the operator (0.4.0, channel community,
  scanStatus clean, publisher @MikeyPetrillo; hidden from anonymous inspect/download until their review completes).**
  The deploy.yml publish job now carries a "Publish agent402-openclaw to ClawHub" step: repo secret `CLAWHUB_TOKEN`
  (a ClawHub CLI token on the publisher account, Actions-only, NOT Railway - prod has no use for it), config written
  under `CLAWHUB_CONFIG_PATH` in the job temp dir, `package inspect --version` as the idempotency check (verified: an
  existing version reads present, a bogus one absent), source metadata from the run; no token = loud skip.
  **OIDC path tried and shelved (2026-08-27):** ClawHub trusted publishing works ONLY through its reusable
  `openclaw/clawhub/.github/workflows/package-publish.yml` (the CLI has no OIDC code; the workflow requests an ID token
  itself and publishes from a ClawHub source checkout), and that workflow uses tag-pinned actions
  (`actions/checkout@v6`, `download-artifact@v8`, `upload-artifact@v7`) while this repository enforces full-SHA pinning
  (`sha_pinning_required: true`) - GitHub refuses the run: "all actions must be pinned to a full-length commit SHA"
  (run 33100511250). Not relaxing the policy for this. the operator DID set the trusted-publisher config on the package, which
  turns a token publish into a "manual" publish that ClawHub refuses without `--manual-override-reason` - the deploy.yml
  step now passes one. Revisit when ClawHub SHA-pins its reusable workflow (or the operator deletes the config with
  `clawhub package trusted-publisher delete agent402-openclaw`).
- **Test ports must stay OUT of the ephemeral range (2026-08-27):** `scripts/test-tollbooth-cli.js` spawned the tollbooth
  CLI on a random 40000-59999 port and, five times in nine days (CI only, never locally), the child exited 0 right after
  boot with no trace. The fifth run carried the new `beforeExit` evidence: `EADDRINUSE :::42828` - the number sat inside
  Linux's ephemeral range (32768-60999), so an outbound socket on the runner already held it; a listener that never
  bound drains the loop and exits 0, which is exactly the shape a bound listener cannot produce. Now the test passes
  `PORT=0`, the CLI banner prints the BOUND port (`server.address().port`), and the test reads it from the log. When a
  test needs a port: `0` + read it back, else pick under 32768. The `beforeExit`/`close`/`error` instrumentation stays.
  **Fleet sweep the same day:** `scripts/lib/free-port.js` (`getFreePort`/`getFreePorts`, OS-assigned on 127.0.0.1)
  replaces every pid-derived port (operator-auth, security-headers, drain-on-sigterm, drain-refuses-composites,
  coldstart, trial); every booted-server boot wait is >= 60 s (the 40 x 500 ms loops in idempotency, mpp-shim,
  mpp-tempo-shim, head-paywall, wildcard-route-bypass, correctness-fixes and cache-hygiene's 50 x 400 were 20 s, under
  the measured post-listen boot stall on a loaded runner); `scripts/test-port-hygiene.js` (CI) fails on any test port
  that is pid/random-derived or >= 32768. Still open with instrumentation only: test-security-headers once saw
  "listening", no stall, and 60 s of `fetch failed` with no error code (run 33100641970) - it now logs the full cause
  and a raw TCP probe on failure; read that before touching its timeout.
- **Cost audit 2026-08-27 (PostHog + operator ledgers + Railway logs):** no buyer over/undercharging found (0 charged-failures
  since 07-16, 0 refunds owed, 0 gateway calls over the 70% bound, ledger vs PostHog settlements reconcile). The month's
  upstream spend was ~$29 OpenRouter+Brave, of which ~$21 landed on 2026-08-21 (577 OpenRouter generations, 114 Opus, 491
  Brave searches) = the report-product launch day's live card runs, BEFORE card sales were ledgered (08-22), so our books
  cannot attribute it - Stripe's payment list for that day can. Two fixes from it: (1) `composite_usage` now carries
  `rail` (agent / card / monitor), the price the report ACTUALLY sold for, `capUsd` and `overCap` - `withCompositeContext`
  (composite-spend-guard, AsyncLocalStorage) is set by `_humanGenerate` around the kit handler with the card/monitor
  price, so kits stay door-agnostic (`scripts/test-composite-context.js`); (2) the paid canary's supply-chain leg
  (address-profile -> Blockscout, 23 of 69 synthetic runs 5xx in 30 days, paged nobody) is recorded as
  `rail_supply-chain` on /status (each rail component now exposes `recentOk`, newest-first, last 5) and
  `shouldPageUpstreamLeg` pages via railFail (exit 5, "Paid canary rail FAILED") after `CANARY_UPSTREAM_PAGE_AFTER` (3)
  CONSECUTIVE failures - unreachable status or too few observations never page. Not auditable from here: Stripe fees
  (MCP needs OAuth), OpenRouter/Brave/Alchemy/X dashboards.
- **Tempo spending wallet LIVE + SOR external legs were dead (2026-08-27):** `TEMPO_UPSTREAM_BUYER_KEY` set on Railway (wallet
  address and funding in CLAUDE.local.md, funded from the burner via `fund-tempo-fee-payer.yml token=usdc`; the operator's
  wallet app could not send on Tempo - fees are paid in the token, a native-gas wallet fails before broadcast). The first live
  Tempo SOR buy (`tempo-sor-live.yml`, burner pays us over Tempo for "scrape a web page with firecrawl") found THREE defects the 41
  offline router tests could not: (1) `provenPayToByOrigin` was a `var` inside the Base branch of `resolveExternalSeller`, so the
  Tempo AND Algorand legs threw `undefined.get` inside the probe try and resolved nothing (dead since the proven-payTo check,
  08-22) - declared at function scope, `test-sor-resolver-scope.js` pins it; (2) the resolved candidate dropped `wire`, so a Tempo
  seller's receipt said x402 - carried through; (3) a 69s Firecrawl scrape outlived the buyer's credential (~25s validBefore, we
  settle after the handler): seller paid $0.002 from the wallet, our settle refused, buyer 402 - `SOR_TEMPO_BUDGET_MS` (16000)
  now bounds the Tempo external leg (504 before spend when resolution ate it; seller call gets the remaining budget as timeout).
  PROVEN loop (before the budget): tx 0x46aedf76fca8cab483c085b2ed2c1e0e30aafb5cc8210c322e91ac7bcb01f5b7 (Firecrawl paid from the
  wallet, balance delta in CLAUDE.local.md). `SOR_TEMPO_FROM_BASE` stays off (treasury call).

## Environment / ops (set on Railway, not in repo)
`WALLET_ADDRESS`, `WALLET_ENS`, `NETWORK`, `CDP_API_KEY_ID/SECRET`, `FACILITATOR_URL`,
`GLAMA_MAINTAINER_EMAIL`, `POW_SECRET` (also keys the wish board's caller fingerprints unless `WISH_CALLER_SALT` is set: HMAC(secret, ip|UTC day), 12 hex, persisted per wish line; with neither secret no caller is credited and find-miss dedupe is off), `MPP_SECRET_KEY` (MPP dual-stack shim — HMAC secret binding MPP challenge ids; presence is the rollout switch, unset = shim not mounted; also in GitHub Actions secrets, injected by the deploy job), `MPP_CHALLENGE_NETWORKS` (optional — "all" or CSV of chain ids that get MPP challenges on 402s; default Base+Celo), `TEMPO_API_KEY` (Tempo MPP relay key from Tempo's dashboard — MUST carry the `mpp:write` scope; presence + a recipient is the Tempo rollout switch, unset = no tempo challenges), `TEMPO_DATA_API_KEY` (Tempo data:read key — the MPP leaderboard's transfer-feed source; unset = RPC scan), `MPP_LB_SOURCE` (`rpc` forces the RPC scan even with the key), `TEMPO_TRANSFERS_CACHE_FILE` (default `/data/tempo-transfers.json`), `TEMPO_RECIPIENT_ADDRESS` (Tempo payTo, defaults to `WALLET_ADDRESS`), `TEMPO_CURRENCY` (TIP-20 token address, default PathUSD `0x20c0…0000`), `TEMPO_DECIMALS` (default 6), `TEMPO_API_BASE_URL` (relay override, default `https://api.tempo.xyz`; the stub seam the relay-errors test uses), `TEMPO_UPSTREAM_BUYER_KEY` (route-execute external on Tempo/MPP — the DEDICATED Tempo spending wallet's EVM private key, funded with USDC.e on Tempo (0x20C0…8b50); NEVER the treasury or the CI burner; MPP external routing is simply not offered without it), `TEMPO_UPSTREAM_BUYER_LOW_USD` (low-water for that wallet, default: see CLAUDE.local.md → heartbeat issue), `TEMPO_RPC_URL` (default `https://rpc.tempo.xyz`; used for the proven-seller gate + balance), `SOR_TEMPO_MIN_SETTLED_TX` (proven-seller floor: inbound USDC.e transfers to the seller's recipient in the last ~15h, default 20), `SOR_TEMPO_FROM_BASE` (`true` lets Base-paying buyers fall through to Tempo/MPP sellers when no Base seller matches — spends the Tempo wallet against Base revenue, default off), `STRIPE_SECRET_KEY`+`STRIPE_PROFILE_ID` (Stripe cards-over-MPP `stripe/charge` via SPT — `src/mpp-stripe.js`, sell-side, the first non-crypto buyer path. BOTH present = rollout switch (unset → gate not mounted, no stripe challenge on any 402). The challenge-signing secret is DERIVED from `STRIPE_SECRET_KEY` (`HMAC(key,"mpp-challenge-signing")` base64) per Stripe's docs, NOT `MPP_SECRET_KEY`; profile id is the mppx `networkId`. Offered ONLY on routes ≥ $0.50 (SPT card minimum); settles a PaymentIntent to our Stripe balance post-handler on a <400 (same buffer-then-settle discipline as tempo, no relay so no confirm-fallback). Sandbox-validated end to end 2026-08-20 (`npx mppx validate --yes`). LIVE flip needs a live profile + a RESTRICTED key (PaymentIntents+Refunds write) via the deploy-job upsert, then a live $0.50 canary; `stripe` npm dep added. `scripts/test-mpp-stripe.js` (18, in CI)), `X_BEARER_TOKEN` (x-data-kit - X API v2 app-only bearer; unset = the five X tools are not listed), `HUNTER_API_KEY` / `APOLLO_API_KEY` (b2b-enrich-kit - each provider's tools list only with its key), `BRAVE_API_KEY` (search-kit Web/News/Images — **CI SPENDS THIS**: the test job boots the server with the real key and FREE_MODE, so any sweep reaching a Brave-backed handler buys a live query, and the CI server has no PostHog, making those calls invisible to every inbound accounting surface. `scripts/test-all.js` BRAVE_ROUTES skips the direct routes AND every skill pack whose steps invoke one; `scripts/test-brave-leak.js` fails CI if a Brave-reaching pack is missing from that set. Measured cost of the gap: ~11.4 Brave requests per CI run before the 2026-07-23 audit, ~2.3 after it (three packs added later), and 0 since 2026-08-02 - the "~0" claimed here in between was never measured and was really 2, leaking via `research-company` (a research-kit tool that calls the search-news HANDLER in-process) and the `financial-research` pack composing it; neither names a Brave slug, so both slug-based guards cleared them. `test-brave-leak.js` now resolves reach through KITS, not slug names, and 0 is measured with an outbound counter whose sight is proven by a control call before any zero is believed — about 4,500 of July's 5,106 billed Search requests were CI, not customers), `BRAVE_ANSWERS_API_KEY` (search-kit `answer` — distinct subscription token from Brave; falls back to `BRAVE_API_KEY` if unset), `BRAVE_SUGGEST_API_KEY` (search-kit `search-suggest` — distinct suggest subscription; falls back to `BRAVE_API_KEY` if unset), `NEYNAR_API_KEY` (onchain-identity-kit Farcaster tools — Neynar API; falls back to `WARPCAST_API_KEY`), `FRED_API_KEY` (macro-kit v1), `FRED_API_KEY_V2` (macro-kit v2 bulk release/observations — distinct key from v1), `DATA_GOV_API_KEY` (gov-kit `gov-data` — data.gov Catalog API v4 via api.gsa.gov/technology/datagov/v4/search; also College Scorecard + FEC; falls back to the rate-limited public `DEMO_KEY` if unset), `COINGECKO_API_KEY` (crypto-kit — CoinGecko Demo key sent as `x-cg-demo-api-key`; keyless fallback works but shares the per-IP rate limit with other Railway tenants), `YAHOO_RELAY_URL`+`YAHOO_RELAY_TOKEN` (finance-kit — optional CF Worker relay for Yahoo's chart endpoint; bypasses Railway egress null-route. See `workers/yfinance-relay/`. Both must be set; falls back to direct Yahoo if unset), `NASDAQ_RELAY_URL`+`NASDAQ_RELAY_TOKEN` (finance-kit — optional CF Worker relay for Nasdaq's calendar endpoint; bypasses Railway egress null-route. See `workers/nasdaq-relay/`. Both must be set; falls back to direct Nasdaq if unset), `SEI_RELAY_URL`+`SEI_RELAY_TOKEN` (revenue surfaces — CF Worker relay for Sei's EVM JSON-RPC; evm-rpc.sei-apis.com errors every eth_getLogs from Railway's egress IPs while the only public alternative archive-gates getLogs. See `workers/sei-rpc-relay/` (POST-only, read-method allowlist, Bearer-gated). Both must be set; falls back to direct Sei RPCs if unset), `ALGORAND_RELAY_URL`+`ALGORAND_RELAY_TOKEN` (revenue surfaces — CF Worker relay for Nodely's Algorand algod/indexer; Nodely 403s Railway's egress IP outright and both direct fallbacks are Nodely-operated. See `workers/algorand-relay/`. Both must be set; falls back to direct Nodely if unset), `OPENAI_API_KEY` (llm-kit + image-gen-kit — OpenAI proxy), `OPENROUTER_API_KEY` (LLM gateway `/v1/*` tiers — OpenRouter upstream; routes 503 without it), `OPENROUTER_MANAGEMENT_KEY` (OpenRouter management/provisioning key — set on Railway 2026-08-19; the documented credential for `/credits`, so `gatewayCreditsStatus` reads the balance leg with it when set and falls back to the API key otherwise; NEVER used for `/key`, which must describe the prod key's own monthly limit; it can list/limit/disable API keys via `/api/v1/keys`, which is how the prod key's limit was set — raising that limit stays a human act, never automated), `E2B_API_KEY` (code-run-kit — E2B sandbox. **CI SPENDS THIS** — same class as Brave: the key sits at test-job scope, so until 2026-07-29 test-all's sweep spun two real sandboxes per run; now `E2B_ROUTES` skips them (opt-in `E2B_LIVE_TEST=1`), live coverage stays in the dedicated test-code-run-kit step, and `scripts/test-brave-leak.js` guards both Brave and E2B structurally), `X402_UPSTREAM_BUYER_KEY` (blockscout-kit `contract-inspect`/`address-profile` — the server's DEDICATED x402 SPENDING wallet (address and funding level in CLAUDE.local.md), pays Blockscout's Pro API \$0.002/call upstream; NEVER the treasury or the CI burner; tools 503 without it; margin guard refuses upstream quotes over \$0.005), `ALGORAND_UPSTREAM_BUYER_MNEMONIC` (route-execute external on Algorand — a DEDICATED AVM spending hot wallet's 25-word mnemonic; must be opted in to USDC ASA 31566704 and hold a little ALGO for fees; NEVER the treasury or the CI burner; Algorand external routing 409s without it; rides the Algorand relay for algod when `ALGORAND_RELAY_URL/TOKEN` are set), `SOLANA_UPSTREAM_BUYER_KEY` (route-execute external on Solana - the DEDICATED SVM spending hot wallet's key, base58 secret or JSON byte array; fund with USDC on Solana; NEVER the treasury or the CI burner; Solana external routing is not offered without it - `src/solana-buyer.js`, proven-seller gate reads recent inbound USDC to the accept's payTo, fail closed, floor `SOR_SVM_MIN_SETTLED_TX` default `SOR_MIN_SETTLED_TX`), `SOLANA_UPSTREAM_BUYER_LOW_USD` (low-water for that wallet, default: see CLAUDE.local.md -> heartbeat issue "Solana upstream buyer wallet LOW (x402)"), `SOR_SVM_UNPROVEN_MAX_USD` (2026-09-02 - the UNPROVEN Solana tier: a seller whose payTo has fewer than the 20-credit floor but a readable chain is still routable when its quote is at or under this (default: see CLAUDE.local.md); tried only after every proven candidate, flagged `sellerProof:"unproven"` on the route-execute receipt; `0`/`off` restores the hard floor. Why: Solana x402 volume is one seller's payTo, and two zero-history sellers each settled a stock payment and delivered while the one proven seller for the task refused every payment), `SOR_SELLER_REFUSAL_TTL_MS` (default 6h - a seller that answered 402/401 to our paid retry while the chain showed no debit is skipped at resolve time for this long; the buyer proves "not charged" from our own wallet's USDC account (`confirmSvmNotDebited`), releases the hold and falls through to the next seller - Solana only), `SOR_SVM_UNPROVEN_MAX_USD` (2026-09-02 - the UNPROVEN Solana tier: a seller whose payTo has fewer than the 20-credit floor but a readable chain is still routable when its quote is at or under this (default: see CLAUDE.local.md); tried only after every proven candidate, flagged `sellerProof:"unproven"` on the route-execute receipt; `0`/`off` restores the hard floor. Why: Solana x402 volume is one seller's payTo, and two zero-history sellers each settled a stock payment and delivered while the one proven seller for the task refused every payment), `SOR_SELLER_REFUSAL_TTL_MS` (default 6h - a seller that answered 402/401 to our paid retry while the chain showed no debit is skipped at resolve time for this long; the buyer proves "not charged" from our own wallet's USDC account (`confirmSvmNotDebited`), releases the hold and falls through to the next seller - Solana only), `SOLANA_RPC_URL` (mainnet RPC for the SVM buyer's mint metadata + proof reads, default api.mainnet-beta.solana.com), `ALGORAND_UPSTREAM_BUYER_ADDRESS` (the AVM spending wallet's PUBLIC address — a repo VARIABLE injected by the deploy job, same pattern as `X402_UPSTREAM_BUYER_ADDRESS`. Set: route-execute's Algorand legs settle to the AVM spending wallet, chain-matched self-funding closing the loop like Base — router tiers ONLY, Blockscout keeps the treasury because its upstream spend is Base-pinned. Unset = Algorand revenue keeps the treasury payTo. Inbound to it is scanned as revenue via `algorandExtraWallets`; never case-fold it), `BASE_BUILDER_CODE` (Base Builder Code for onchain attribution — from dashboard.base.org; env-gated no-op if unset), `BASE_NOTIFICATIONS_API_KEY` (Base Notifications API — from Base Dashboard; enables push notifications to users who pinned the app; env-gated no-op if unset), `GOOGLE_SITE_VERIFICATION` (Search Console HTML-tag verification token — rendered as a meta tag in the shared ledger head; env-gated no-op if unset), `INDEXNOW_KEY` (IndexNow ownership key — serves /{key}.txt and enables scripts/indexnow-submit.js instant-indexing pings to Bing/Copilot/DDG/Yahoo; env-gated no-op if unset), `SOLANA_WALLET_ADDRESS` (Solana payTo address for USDC on Solana), `ALGORAND_WALLET_ADDRESS` (Algorand payTo address for USDC on Algorand — must be opted in to ASA 31566704 or settlement fails on-chain), `ALGORAND_FACILITATOR_URL` (optional override for the GoPlausible-hosted AVM facilitator; default `https://facilitator.goplausible.xyz`), `CELO_FACILITATOR_URL` (optional override for the Celo-operated x402 facilitator; default `https://api.x402.celo.org` — advertises `exact/eip155:42220`. Celo USDC `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` has on-chain EIP-712 name "USDC" (not "USD Coin"), handled by the money parser in `src/payments.js`), `CELO_FACILITATOR_KEY` (REQUIRED to offer the Celo rail — the facilitator's /supported+/verify are keyless but /settle 401s without an X-API-Key, so payments.js drops Celo from the offer when unset. Free self-service: sign a no-gas SIWE-style message at x402.celo.org → POST /api/keys mints an `x402_…` key, shown once, rotatable on the same page; NOT payTo-bound — the current key was minted 2026-07-20 with a throwaway signer), `ROBINHOOD_FACILITATOR_URL` (required to enable the Robinhood/USDG rail — no default baked in; set to `https://facilitator.naven.network` (Naven, the first x402 facilitator on Robinhood Crypto — keyless, advertises `exact/eip155:4663` + Base at `/supported`, verified settling USDG 2026-07-17). Swapped from the prior `mpp.hyreagent.fun/r402`, which began rejecting settles 2026-07-16), `OUR_ALGORAND_WALLETS` (optional comma-separated override of the internal/canary Algorand burner set used to classify revenue), `ALGORAND_BURNER_MNEMONIC` (GitHub Actions secret only — 25-word mnemonic for the Algorand leg of `scripts/paid-canary.js`; never set on Railway), `FACILITATOR_INCLUSION_FEE_STROOPS` (the Stellar settlement transaction's inclusion-fee bid per operation, on the agent402-facilitator service; default 50,000 stroops, `off`/`0` restores the vendor's 100-stroop network minimum. Stellar charges the auction clearing price, so this is a ceiling and not a per-settlement cost - see the fee-bid entry above), `FACILITATOR_LOW_BALANCE_XLM` (that facilitator's own low-water mark, default: see CLAUDE.local.md; surfaced bucketed on `/api/gateway-status` as `stellarFacilitator` and paged by heartbeat), `STATUS_PROBE_TOKEN` (2026-08-30 - a PROBE-ONLY credential accepted by `POST /api/status/probe` and read in exactly one place in the tree. Both observers outside production (the GitHub heartbeat and the Cloudflare status Worker) used to carry `AGENT402_OPERATOR_TOKEN` just to write one record, and that token also reaches `/__operator/refunds/update`, `/credits/disable`, `/well-known` (publishes a document at our own domain), `/leads`, `/backup/run`, `/monitors/run`, `/alerts/run`, `/stats` and `/wishes` - a master key to use one door, held on two other platforms. The operator token is STILL accepted on the probe route, so the two rotate independently and no observer goes dark mid-rotation; unset, behaviour is byte-identical to before. Set it on Railway, as the Worker secret `STATUS_PROBE_TOKEN` (then `wrangler secret delete OPERATOR_TOKEN`) and as the Actions secret `STATUS_PROBE_TOKEN` (heartbeat-probe.sh prefers `PROBE_TOKEN` over `OP_TOKEN`). Boot warns if it equals the operator token or is under 24 chars. `scripts/test-status-probe-token.js`), `AGENT402_OPERATOR_TOKEN` (operator auth for `/__operator/*` and `POST /api/status/probe`. Set on Railway. **Must ALSO be a GitHub Actions secret** — `charged-failure-alert.yml` (reads the charged-failure log), `status-backfill.yml`, and the heartbeat's status-probe step all need it; without it the charged-failure alarm fails loudly by design, because silently skipping is exactly what hid it being dead for months. `wish-issues.yml` also references it but is gated off by the `WISH_ISSUES_ENABLED` repo variable, which is why the gap went unnoticed), `PAYAI_API_KEY_ID`+`PAYAI_API_KEY_SECRET` (PayAI facilitator auth — optional, the free tier needs no keys; get at merchant.payai.network), `PAYAI_FACILITATOR_URL` (optional PayAI URL override — parity with every other `*_FACILITATOR_URL`; the stub seam `scripts/test-supported-guard.js` boots against, never set in prod), `X402_SUPPORTED_GUARD` (`off` disables the boot /supported guard that drops networks no reachable facilitator advertises — escape hatch only, default on), `PAYMENT_NETWORKS` (comma-separated chains to accept — default is the primary network only; e.g. `base,solana,polygon,arbitrum,stellar,algorand,monad,celo,avalanche,sei,optimism,robinhood`; CDP facilitator handles Base, PayAI handles Solana/Polygon/Arbitrum/Avalanche/Sei, Solvador handles Optimism (keyed, network-filtered primary), and Monad/Celo/Robinhood ride their dedicated facilitators), `MPP_EVM_DOMAIN_FALLBACK` (`off` disarms the wrong-EIP-712-domain detection + x402 steering; `MPP_EVM_DOMAIN_FALLBACK_TTL_MS` default 30 min and `MPP_EVM_DOMAIN_FALLBACK_MAX_RESPONSES` default 5 bound how long a proven wrong-domain signer is held), `WALLET_BLOCKLIST` (comma-separated wallet addresses refused service — enforced by a beforeSettle abort in `src/payments.js`, so a blocked wallet is never charged; the 402's receipt carries errorReason `wallet_blocked` and the tally records a `settle_failed` event. Call-time read; the /terms enforcement section is the policy this implements), `NETWORK_PRICE_PREMIUMS` (per-chain price premiums, CAIP-2 keyed CSV e.g. `eip155:10=0.001` — adds the facilitator fee to that chain's 402 accepts quote so fee-charging rails are priced in structurally while fee-free rails stay at list; unset = byte-identical accepts, negative/malformed entries refused loudly; integer micro-dollar arithmetic; `scripts/test-price-premium.js`), `SQL_CERT_SIGNING_KEY` (sql-guard's Ed25519 signing identity, PKCS8 PEM with literal \n escapes — the key that certifies a SQL statement passed policy. Env-gated no-op: unset, sql-guard still returns full verdicts and says plainly it cannot certify, never an unsigned object shaped like a certificate. Rotating it invalidates outstanding certificates, which live 5 minutes by default), `STELLAR_FALLBACK_FACILITATOR_URL`+`STELLAR_FALLBACK_FACILITATOR_KEY` (2026-08-26 - a SECOND Stellar facilitator, OpenZeppelin's `https://channels.openzeppelin.com/x402` with a `/gen` Bearer token, used ONLY when the primary's settle fails AND Horizon shows no transfer: the same signed envelope is re-submitted there (`settleWithStellarFallback`, `src/stellar-confirm.js`; one envelope lands at most once, so it cannot double-charge; Horizon is checked before and after). Not in `facilitatorClients` - @x402 never tries it as a peer; probed at boot loudly, non-fatal. Built after canary run 32962953735: our own facilitator's RPC rejected a submission `status=ERROR`, no XDR, tx never landed), `SOLVADOR_KEY` (Solvador facilitator API key — dashboard.solvador.com, pay-as-you-go with a free tier (figures in CLAUDE.local.md). Enables Solvador as the LAST settle-fallback candidate; fallback-only, never a primary route. The only second facilitator covering Celo/Monad/Robinhood. Anything routed through a fee-charging facilitator as a PRIMARY must be priced to cover the fee — see the per-chain accepts pricing rule; fallback settles of existing quotes are fine, the free tier covers them), `SOLVADOR_FACILITATOR_URL` (optional override, default `https://api.solvador.com`), `PAYMENT_SETTLE_FALLBACK` (`true` to re-settle via the fallback chain — PayAI, then Solvador when `SOLVADOR_KEY` is set; PayAI is skipped on networks it cannot settle, so Celo/Monad/Robinhood go straight to Solvador — when the primary facilitator rejects settlement BEFORE broadcasting — an HTTP 402 such as CDP's `payment-method-required` billing gate; never on timeout/5xx, so it can't double-settle. Default off: Base stays purely on CDP for Bazaar + fee-free settlement. Turn on for never-miss-a-sale insurance against a CDP billing lapse. Facilitator verify/settle failures are always logged loudly regardless via `onVerifyFailure`/`onSettleFailure` hooks). Never commit secrets or wallet keys.

## This sandbox vs. prod
The Claude Code **web** environment has an egress allowlist (npm + GitHub reachable;
`agent402.tools`, `basescan.org`, `glama.ai` are **blocked**). Verify prod via CI
(`[probe]`, heartbeat, canary) or a local terminal (full network). npm registry is reachable for `npm view`.
