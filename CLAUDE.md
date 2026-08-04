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
- `src/mcp-http.js` — hosted MCP connector (`/mcp`): tools `search_tools`, `find_tool`, `call_tool`, `about_agent402`.
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
credits LOW" issue on "low" — threshold `OPENROUTER_LOW_CREDITS_USD`, default $5,
because /v1 settles before the handler and an empty balance = charged-but-failed; response also carries `upstreamBuyer` — the x402 spending wallet's bucketed status, heartbeat opens "Upstream buyer wallet LOW (x402)" on low, threshold `UPSTREAM_BUYER_LOW_USD` default $0.50).

## Dev / CI / deploy workflow
- **Develop on branch `claude/sweet-brown-i99jl3`.** `main` is protected (PR required, no force-push).
- CI (`.github/workflows/deploy.yml`) triggers on push to the dev branch **and** a touched
  `.github/trigger-*` path, with jobs gated on **commit-message markers**:
  - `[test]` → full test job · `[deploy]` → Railway deploy · `[publish]` → npm + MCP Registry
  - `[probe]` → live prod probe · `[paytest]`/`[drain]`/`[purl]`
  - To trigger: bump the matching `.github/trigger-<name>` file and put the marker(s) in the commit message.
- **Flow:** commit to the dev branch (with markers) → push → open a **draft PR** → CI runs →
  merge to `main`. The `create_pull_request` tool auto-appends a session-link footer; **strip it**
  via `update_pull_request` before/after creating (no session links in PR bodies/commits).
- **Heartbeat** (`heartbeat.yml`) probes prod every 15 min and opens a "production DOWN" issue on
  failure; a daily paid canary buys a $0.001 tool. No open issues = prod healthy. Also
  watches the **PayAI settlement quota** (PayAI is PRIMARY for Solana/Polygon/Arbitrum/
  Avalanche, free tier 10k settles/month): rolling 30-day on-chain count from
  `/api/revenue/daily`, opens "PayAI settlement quota HIGH" at `PAYAI_QUOTA_WARN`
  (repo var, default 8000). Unreadable data logs a loud warning, never a silent skip.

## Testing (run locally)
- Boot free mode: `FREE_MODE=true PORT=3000 node src/server.js` then `TARGET_URL=http://localhost:3000 node scripts/test-all.js` (every tool answers its example) and `scripts/test-mcp-all.js`.
- Paid-mode tests boot their own server (PoW path): `scripts/test-idempotency.js`, `client/test.js`.
- Unit/offline: `scripts/test-memory.js`, `test-find.js`, `test-revenue-scan.js`, `test-util-kit.js`, `test-discovery.js`, `tollbooth/test.js`+`edge.test.js`+`features.test.js`.
- Raise the MCP free-tier limit for sweeps: `AGENT402_MCP_MAX_PER_MIN=999999 AGENT402_MCP_MAX_PER_HOUR=9999999`.

## x402 settlement ordering (CRITICAL — get this right)
The installed **`@x402/express` v2.16 runs the handler FIRST, then settles**, and
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
- **Idempotency:** opt-in `Idempotency-Key` header; cache key = `sha256(METHOD /path + key + gate-credential)`. **Settlement-aware (FR4-01):** the body is captured at `res.json` but COMMITTED to the cache only on `res.on("finish")` when the FINAL `statusCode === 200` — i.e. after `@x402/express` has settled — so an unsettled 200 (settlement-failure → 402) is never cached/replayed. No-op without the header; streamed responses are never replayable. `scripts/test-idempotency-settlement.js`.
- **Tollbooth:** charge modes (`bots`/`all`/`strict`), adaptive PoW, analytics (`gate.stats()` + `/__tollbooth/stats` + `/__tollbooth` dashboard), deploy templates (Cloudflare/Next.js/Docker). Defaults preserve original behavior.
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
  plus **`/v1/images/generations` `$0.08`** (`v1-images` — OpenAI images wire translated
  to OpenRouter chat `modalities:["image","text"]`, model locked `google/gemini-2.5-flash-image`,
  n locked 1, `IMAGES_MAX_TOKENS` 1600 + `IMAGES_MAX_PRICE` provider bound, data-URI →
  `b64_json`, no cache/stream, imageless upstream → 502),
  plus **`/v1/audio/speech` `$0.06`** (`v1-audio-speech` — OpenAI TTS wire on
  OpenRouter's audio API. OpenRouter has NO OpenAI TTS models (their docs still say
  otherwise — burned us 2026-07-09); serves a FIVE-model failover chain instead
  (`SPEECH_MODELS`: Voxtral Mini TTS → Grok Voice → Kokoro-82M → Zonos → MAI-Voice-2,
  all proven by real buys 2026-07-16 via the dispatchable
  `.github/workflows/openrouter-tts-probe.yml`, which probes the live
  `?output_modalities=speech` list — never hardcoded ids). Chain walks on ANY
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
  (resolved model included). **Margin protection (two layers, both in `validateRequest`):**
  (1) per-tier `maxPrice` rides upstream as `provider.max_price` on every call — buyer-supplied
  `provider` can never loosen it; (2) margin clamp — exact-BPE (`gpt-tokenizer` o200k, static
  import: must stay sync for `promptCacheKey`) prices the FULL outbound body (incl. tools
  schemas, images flat 1600 tok, `n`≤4 multiplier) against `MODEL_COST` (longest-prefix,
  elementwise-min'd with `maxPrice`), then shrinks `max_tokens` so worst-case upstream ≤ 70%
  of tier price; input alone over budget → self-explaining 400. Deterministic → cache-key
  safe; cheap models never feel it. **Margin telemetry:** non-stream calls ride
  `usage:{include:true}` to OpenRouter (call-time inject, never in cache keys); exact
  upstream cost → PostHog `gateway_usage` event (price/upstream/margin/tokens), then
  `cost`/`cost_details`/`is_byok` are STRIPPED before the response is cached or returned
  (never leak the bill to buyers; posthog.js loaded lazily in the handler). Streams skip
  accounting — cost would ride the buyer's raw SSE. **zdr knob:** `zdr:true` (or
  `provider.zdr`) is the ONLY buyer-settable provider field — folds into the server-owned
  provider prefs next to `max_price`, lives in the normalized body (distinct cache entries),
  stripped from the top-level outbound body. All tiers in `WALLET_ONLY_SLUGS` and
  test-all's lenient NETWORK set.
- **Route-and-execute (`POST /api/route/execute`, $0.01, `src/tools/route-execute.js`):**
  resolves a task/slug via `findTools`, dispatches the underlying internal tool (underlying
  price cap $0.005), returns `{result, receipt}`; underlying errors pass through.
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
- **Payer attribution (`src/payer.js`):** `payerFromRequest` reads only the signed EIP-3009
  `authorization.from` — memory identity depends on it, never weaken. `payerFromPaymentResponse`
  (facilitator settle-receipt `payer`) is the fallback for SVM/Stellar, telemetry/sales only.
  Never lowercase base58/Stellar addresses (EVM only).
- **Deploy safety (live-buyer protection):** deploy job runs `scripts/deploy-quiet-gate.js`
  BEFORE the Railway variable upsert (the upsert itself can trigger a redeploy) — polls
  `/api/stats` `recentCalls`, waits for 180s with no external USDC call (heartbeat/PoW never
  block); fail-open on stats-down, sustained traffic past `QUIET_GATE_MAX_WAIT` (repo var,
  default 1200s), or repo var `QUIET_GATE=off`. Deploy also sets
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=90` — Railway's default SIGTERM→SIGKILL grace is **0s**,
  so without it the server's graceful drain never runs. Drain (`src/server.js` shutdown):
  `closeIdleConnections()` sweep every 5s + 75s hard deadline (covers transcribe's 60s
  upstream timeout).
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
  per audio minute (~$0.003 mini / ~$0.006 4o), so break-even on the $0.03 tier is ~10 min
  and the cap is the margin bound, not a UX nicety. Unreadable duration → 422 (an
  unreadable container would be an unbounded upstream bill). `assertWithinDurationCap` /
  `probeDurationSeconds` exported for `scripts/test-stt-cap.js`.
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
  `scripts/test-mpp-shim.js` (offline, in CI): real mppx client buys over the
  native wire vs a stub facilitator, single verify+settle, EIP-712 sig checked
  against Base USDC's real domain, x402 pass-through untouched, HMAC
  tamper/expiry rejected.
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
  self-heals). Residual: a boot-dropped rail returns only on the next restart; a mid-run-
  dead rail stays advertised until then (isolated, self-healing on recovery).
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
- **Marketplace latency / snapshot caching (`src/x402-economy.js`):** `GET /marketplace`
  (and `/api/x402-economy`) render from `x402EconomySnapshot()` — a ~500ms on-chain read
  (EIP-3009 USDC settlements on Base via CDP SQL). It is **stale-while-revalidate**: a fresh
  cache (30 min, `ECONOMY_FRESH_MS`) returns as-is; a stale-but-present cache is served
  immediately while a single **deduped** background rebuild (`startEconomyRefresh`, one
  in-flight query for a concurrent burst) runs; only a cold cache (first request after boot)
  awaits the build. Errored reads back-date `cachedAt` so they expire in ~5 min, not 30.
  No visitor request ever blocks on the rebuild — before this, the first visitor after each
  30-min expiry ate the full ~500ms. `getIndexSnapshot()` is a separate 30s in-memory cache
  (`INDEX_SNAPSHOT_TTL_MS`). The **crawl cache itself warm-starts from `/data`**
  (`INDEX_CACHE_FILE`, default `/data/x402-index-cache.json`; persisted after each
  crawl, loaded in `startCrawler`, never clobbers a live-refreshed entry) — it used to
  be memory-only, so every redeploy served a half-crawled ecosystem for the minutes a
  ~2,200-origin re-crawl takes (a visitor saw 569 sellers against a real 2,169). Same
  fix and same reasoning as the leaderboard's own snapshot warm-start.
  `scripts/test-index-warmstart.js` (offline, in CI). Note the two seller counts on
  `/marketplace` are deliberately different populations: the stat card counts **distinct
  payees** (rows after collapsing origins sharing a leaderboard payTo gid) and the chain
  nav counts **raw origins** — the card names both so they reconcile. Measured live 2026-07-18: `/marketplace` p50 135ms / max 224ms,
  `/api/x402-economy` p50 93ms, zero requests >500ms across 26 samples. NB: there is **no CDN**
  in front (no `age`/`cf-cache` header) — the server-side snapshot caches are the origin
  protection; the `max-age=120` on the response is a browser-only hint. Contract pinned by
  `scripts/test-x402-economy.js` (dedup + warm-cache identity, never-throws).
- **Homepage = `src/ledger-home.js`** (`ledgerHomePage`; the old `src/landing.js` is unused
  but still unit-tested). Its `faqs` array renders BOTH the visible FAQ and the FAQPage
  JSON-LD, and the WebApplication offer is an AggregateOffer — deploy.yml's SEO gate greps
  prod for `"FAQPage"` / `GET /faq` / `AggregateOffer`. That gate runs BEFORE the deploy job,
  so a fix to those surfaces goes green on the run AFTER the one shipping it.
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
  (`agent402-status-probe.mikepetrillo1775.workers.dev`; `OPERATOR_TOKEN` secret = Railway's
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
  hand-maintained token table; EVM decimals read from the contract). Caps: $0.25/refund,
  $2/run, both overridable at dispatch; over-cap and unsupported rows are HELD and
  listed, never dropped. Canary/synthetic rows are recorded but held unless
  `include_synthetic`. Spending keys are Actions secrets ONLY and refunds ride
  the CI CANARY BURNERS by default (Mike's decision 2026-08-04 — refund volume is
  minimal, the burners already hold USDC on the paying chains, and the canary
  low-water alarms watch their balances, so refund spend pages for a top-up like
  canary spend does). Dedicated `REFUND_EVM_KEY` / `REFUND_STELLAR_SECRET` /
  `REFUND_ALGORAND_MNEMONIC` take precedence whenever set. NEVER the treasury;
  the server records debts but can never send money. Solana is detection-only until
  the SVM spending wallet lands (rare there anyway: a failed Solana txn moves no
  tokens, measured 2026-08-03). A failed send leaves the row owed and exits 1.
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
  (default $2, ~2 runs) — "burner LOW" issue pages for a top-up BEFORE starvation.
  The balance read walks a 3-RPC fallback chain (mainnet.base.org rejected the read
  2026-07-27 while the wallet sat at $0.00, so an empty wallet paged as "buying looks
  broken"); an unreadable balance is logged loudly and never demotes a green run.
- **Algorand rail canary (`scripts/algorand-rail-canary.js`, `algorand-rail-canary.yml`,
  weekly Mon ~06:41 UTC + dispatch):** buys EVERY catalog tool on Algorand and asserts
  402 → sign → settle → 200 → non-empty payload. Fills the gap between paid-canary (ONE
  Algorand leg) and challenge-sweep (skips already-registered, so it re-verifies nothing).
  Failures are classified **rail** (paid, still got a 402 = settlement refused), **tool**
  (settled path fine, handler didn't deliver; a ≥400 cancels settlement so nobody was
  charged), and **unexpected-missing-accept** (a non-identity-bound tool stopped
  advertising `algorand:*`). All three fail the run and open/close ONE issue, heartbeat
  style — no tolerance thresholds, each class is a real defect. Identity-bound routes are
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
  tier's safety rests on `WALLET_ONLY_SLUGS`, which is hand-maintained - a kit
  whose author forgets to list an egressing slug is permanently free, and the
  Brave and E2B CI-spend leaks are the evidence that hand-maintenance fails. The
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
  different social act and needs Mike's OK on those terms.
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
  (burner buy) or `robinhood` (free /api/revenue → `scripts/robinhood-card.js`) |
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

## Environment / ops (set on Railway, not in repo)
`WALLET_ADDRESS`, `WALLET_ENS`, `NETWORK`, `CDP_API_KEY_ID/SECRET`, `FACILITATOR_URL`,
`GLAMA_MAINTAINER_EMAIL`, `POW_SECRET`, `MPP_SECRET_KEY` (MPP dual-stack shim — HMAC secret binding MPP challenge ids; presence is the rollout switch, unset = shim not mounted; also in GitHub Actions secrets, injected by the deploy job), `MPP_CHALLENGE_NETWORKS` (optional — "all" or CSV of chain ids that get MPP challenges on 402s; default Base+Celo), `BRAVE_API_KEY` (search-kit Web/News/Images — **CI SPENDS THIS**: the test job boots the server with the real key and FREE_MODE, so any sweep reaching a Brave-backed handler buys a live query, and the CI server has no PostHog, making those calls invisible to every inbound accounting surface. `scripts/test-all.js` BRAVE_ROUTES skips the direct routes AND every skill pack whose steps invoke one; `scripts/test-brave-leak.js` fails CI if a Brave-reaching pack is missing from that set. Measured cost of the gap: ~11.4 Brave requests per CI run before the 2026-07-23 audit, ~2.3 after it (three packs added later), and 0 since 2026-08-02 - the "~0" claimed here in between was never measured and was really 2, leaking via `research-company` (a research-kit tool that calls the search-news HANDLER in-process) and the `financial-research` pack composing it; neither names a Brave slug, so both slug-based guards cleared them. `test-brave-leak.js` now resolves reach through KITS, not slug names, and 0 is measured with an outbound counter whose sight is proven by a control call before any zero is believed — about 4,500 of July's 5,106 billed Search requests were CI, not customers), `BRAVE_ANSWERS_API_KEY` (search-kit `answer` — distinct subscription token from Brave; falls back to `BRAVE_API_KEY` if unset), `BRAVE_SUGGEST_API_KEY` (search-kit `search-suggest` — distinct suggest subscription; falls back to `BRAVE_API_KEY` if unset), `NEYNAR_API_KEY` (onchain-identity-kit Farcaster tools — Neynar API; falls back to `WARPCAST_API_KEY`), `FRED_API_KEY` (macro-kit v1), `FRED_API_KEY_V2` (macro-kit v2 bulk release/observations — distinct key from v1), `DATA_GOV_API_KEY` (gov-kit `gov-data` — data.gov CKAN catalog via the api.gsa.gov/technology/datagov/v3 proxy; falls back to the rate-limited public `DEMO_KEY` if unset), `COINGECKO_API_KEY` (crypto-kit — CoinGecko Demo key sent as `x-cg-demo-api-key`; keyless fallback works but shares the per-IP rate limit with other Railway tenants), `YAHOO_RELAY_URL`+`YAHOO_RELAY_TOKEN` (finance-kit — optional CF Worker relay for Yahoo's chart endpoint; bypasses Railway egress null-route. See `workers/yfinance-relay/`. Both must be set; falls back to direct Yahoo if unset), `NASDAQ_RELAY_URL`+`NASDAQ_RELAY_TOKEN` (finance-kit — optional CF Worker relay for Nasdaq's calendar endpoint; bypasses Railway egress null-route. See `workers/nasdaq-relay/`. Both must be set; falls back to direct Nasdaq if unset), `SEI_RELAY_URL`+`SEI_RELAY_TOKEN` (revenue surfaces — CF Worker relay for Sei's EVM JSON-RPC; evm-rpc.sei-apis.com errors every eth_getLogs from Railway's egress IPs while the only public alternative archive-gates getLogs. See `workers/sei-rpc-relay/` (POST-only, read-method allowlist, Bearer-gated). Both must be set; falls back to direct Sei RPCs if unset), `ALGORAND_RELAY_URL`+`ALGORAND_RELAY_TOKEN` (revenue surfaces — CF Worker relay for Nodely's Algorand algod/indexer; Nodely 403s Railway's egress IP outright and both direct fallbacks are Nodely-operated. See `workers/algorand-relay/`. Both must be set; falls back to direct Nodely if unset), `OPENAI_API_KEY` (llm-kit + image-gen-kit — OpenAI proxy), `OPENROUTER_API_KEY` (LLM gateway `/v1/*` tiers — OpenRouter upstream; routes 503 without it), `E2B_API_KEY` (code-run-kit — E2B sandbox. **CI SPENDS THIS** — same class as Brave: the key sits at test-job scope, so until 2026-07-29 test-all's sweep spun two real sandboxes per run; now `E2B_ROUTES` skips them (opt-in `E2B_LIVE_TEST=1`), live coverage stays in the dedicated test-code-run-kit step, and `scripts/test-brave-leak.js` guards both Brave and E2B structurally), `X402_UPSTREAM_BUYER_KEY` (blockscout-kit `contract-inspect`/`address-profile` — the server's DEDICATED x402 SPENDING wallet (0x7706…4121, fund with ~\$5 USDC on Base), pays Blockscout's Pro API \$0.002/call upstream; NEVER the treasury or the CI burner; tools 503 without it; margin guard refuses upstream quotes over \$0.005), `ALGORAND_UPSTREAM_BUYER_MNEMONIC` (route-execute external on Algorand — a DEDICATED AVM spending hot wallet's 25-word mnemonic; must be opted in to USDC ASA 31566704 and hold a little ALGO for fees; NEVER the treasury or the CI burner; Algorand external routing 409s without it; rides the Algorand relay for algod when `ALGORAND_RELAY_URL/TOKEN` are set), `ALGORAND_UPSTREAM_BUYER_ADDRESS` (the AVM spending wallet's PUBLIC address — a repo VARIABLE injected by the deploy job, same pattern as `X402_UPSTREAM_BUYER_ADDRESS`. Set: route-execute's Algorand legs settle to the AVM spending wallet, chain-matched self-funding closing the loop like Base — router tiers ONLY, Blockscout keeps the treasury because its upstream spend is Base-pinned. Unset = Algorand revenue keeps the treasury payTo. Inbound to it is scanned as revenue via `algorandExtraWallets`; never case-fold it), `BASE_BUILDER_CODE` (Base Builder Code for onchain attribution — from dashboard.base.org; env-gated no-op if unset), `BASE_NOTIFICATIONS_API_KEY` (Base Notifications API — from Base Dashboard; enables push notifications to users who pinned the app; env-gated no-op if unset), `GOOGLE_SITE_VERIFICATION` (Search Console HTML-tag verification token — rendered as a meta tag in the shared ledger head; env-gated no-op if unset), `INDEXNOW_KEY` (IndexNow ownership key — serves /{key}.txt and enables scripts/indexnow-submit.js instant-indexing pings to Bing/Copilot/DDG/Yahoo; env-gated no-op if unset), `SOLANA_WALLET_ADDRESS` (Solana payTo address for USDC on Solana), `ALGORAND_WALLET_ADDRESS` (Algorand payTo address for USDC on Algorand — must be opted in to ASA 31566704 or settlement fails on-chain), `ALGORAND_FACILITATOR_URL` (optional override for the GoPlausible-hosted AVM facilitator; default `https://facilitator.goplausible.xyz`), `CELO_FACILITATOR_URL` (optional override for the Celo-operated x402 facilitator; default `https://api.x402.celo.org` — advertises `exact/eip155:42220`. Celo USDC `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` has on-chain EIP-712 name "USDC" (not "USD Coin"), handled by the money parser in `src/payments.js`), `CELO_FACILITATOR_KEY` (REQUIRED to offer the Celo rail — the facilitator's /supported+/verify are keyless but /settle 401s without an X-API-Key, so payments.js drops Celo from the offer when unset. Free self-service: sign a no-gas SIWE-style message at x402.celo.org → POST /api/keys mints an `x402_…` key, shown once, rotatable on the same page; NOT payTo-bound — the current key was minted 2026-07-20 with a throwaway signer), `ROBINHOOD_FACILITATOR_URL` (required to enable the Robinhood/USDG rail — no default baked in; set to `https://facilitator.naven.network` (Naven, the first x402 facilitator on Robinhood Crypto — keyless, advertises `exact/eip155:4663` + Base at `/supported`, verified settling USDG 2026-07-17). Swapped from the prior `mpp.hyreagent.fun/r402`, which began rejecting settles 2026-07-16), `OUR_ALGORAND_WALLETS` (optional comma-separated override of the internal/canary Algorand burner set used to classify revenue), `ALGORAND_BURNER_MNEMONIC` (GitHub Actions secret only — 25-word mnemonic for the Algorand leg of `scripts/paid-canary.js`; never set on Railway), `AGENT402_OPERATOR_TOKEN` (operator auth for `/__operator/*` and `POST /api/status/probe`. Set on Railway. **Must ALSO be a GitHub Actions secret** — `charged-failure-alert.yml` (reads the charged-failure log), `status-backfill.yml`, and the heartbeat's status-probe step all need it; without it the charged-failure alarm fails loudly by design, because silently skipping is exactly what hid it being dead for months. `wish-issues.yml` also references it but is gated off by the `WISH_ISSUES_ENABLED` repo variable, which is why the gap went unnoticed), `PAYAI_API_KEY_ID`+`PAYAI_API_KEY_SECRET` (PayAI facilitator auth — optional, free tier 10k settlements/month needs no keys; get at merchant.payai.network), `PAYAI_FACILITATOR_URL` (optional PayAI URL override — parity with every other `*_FACILITATOR_URL`; the stub seam `scripts/test-supported-guard.js` boots against, never set in prod), `X402_SUPPORTED_GUARD` (`off` disables the boot /supported guard that drops networks no reachable facilitator advertises — escape hatch only, default on), `PAYMENT_NETWORKS` (comma-separated chains to accept — default is the primary network only; e.g. `base,solana,polygon,arbitrum,stellar,algorand,monad,celo,avalanche,sei,optimism,robinhood`; CDP facilitator handles Base, PayAI handles Solana/Polygon/Arbitrum/Avalanche/Sei, Solvador handles Optimism (keyed, network-filtered primary), and Monad/Celo/Robinhood ride their dedicated facilitators), `WALLET_BLOCKLIST` (comma-separated wallet addresses refused service — enforced by a beforeSettle abort in `src/payments.js`, so a blocked wallet is never charged; the 402's receipt carries errorReason `wallet_blocked` and the tally records a `settle_failed` event. Call-time read; the /terms enforcement section is the policy this implements), `NETWORK_PRICE_PREMIUMS` (per-chain price premiums, CAIP-2 keyed CSV e.g. `eip155:10=0.001` — adds the facilitator fee to that chain's 402 accepts quote so fee-charging rails are priced in structurally while fee-free rails stay at list; unset = byte-identical accepts, negative/malformed entries refused loudly; integer micro-dollar arithmetic; `scripts/test-price-premium.js`), `SQL_CERT_SIGNING_KEY` (sql-guard's Ed25519 signing identity, PKCS8 PEM with literal \n escapes — the key that certifies a SQL statement passed policy. Env-gated no-op: unset, sql-guard still returns full verdicts and says plainly it cannot certify, never an unsigned object shaped like a certificate. Rotating it invalidates outstanding certificates, which live 5 minutes by default), `SOLVADOR_KEY` (Solvador facilitator API key — dashboard.solvador.com, pay-as-you-go: first 1,000 settlements/month free then $0.001. Enables Solvador as the LAST settle-fallback candidate; fallback-only, never a primary route. The only second facilitator covering Celo/Monad/Robinhood. Anything routed through a fee-charging facilitator as a PRIMARY must be priced to cover the fee — see the per-chain accepts pricing rule; fallback settles of existing quotes are fine, the free tier covers them), `SOLVADOR_FACILITATOR_URL` (optional override, default `https://api.solvador.com`), `PAYMENT_SETTLE_FALLBACK` (`true` to re-settle via the fallback chain — PayAI, then Solvador when `SOLVADOR_KEY` is set; PayAI is skipped on networks it cannot settle, so Celo/Monad/Robinhood go straight to Solvador — when the primary facilitator rejects settlement BEFORE broadcasting — an HTTP 402 such as CDP's `payment-method-required` billing gate; never on timeout/5xx, so it can't double-settle. Default off: Base stays purely on CDP for Bazaar + fee-free settlement. Turn on for never-miss-a-sale insurance against a CDP billing lapse. Facilitator verify/settle failures are always logged loudly regardless via `onVerifyFailure`/`onSettleFailure` hooks). Never commit secrets or wallet keys.

## This sandbox vs. prod
The Claude Code **web** environment has an egress allowlist (npm + GitHub reachable;
`agent402.tools`, `basescan.org`, `glama.ai` are **blocked**). Verify prod via CI
(`[probe]`, heartbeat, canary) or a local terminal (full network). npm registry is reachable for `npm view`.
