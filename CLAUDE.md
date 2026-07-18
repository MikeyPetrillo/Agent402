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
because /v1 settles before the handler and an empty balance = charged-but-failed).

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
  failure; a daily paid canary buys a $0.001 tool. No open issues = prod healthy.

## Testing (run locally)
- Boot free mode: `FREE_MODE=true PORT=3000 node src/server.js` then `TARGET_URL=http://localhost:3000 node scripts/test-all.js` (every tool answers its example) and `scripts/test-mcp-all.js`.
- Paid-mode tests boot their own server (PoW path): `scripts/test-idempotency.js`, `client/test.js`.
- Unit/offline: `scripts/test-memory.js`, `test-find.js`, `test-revenue-scan.js`, `test-util-kit.js`, `test-discovery.js`, `tollbooth/test.js`+`edge.test.js`+`features.test.js`.
- Raise the MCP free-tier limit for sweeps: `AGENT402_MCP_MAX_PER_MIN=999999 AGENT402_MCP_MAX_PER_HOUR=9999999`.

## Notable features (current)
- **Idempotency:** opt-in `Idempotency-Key` header; cache key = `sha256(METHOD /path + key + gate-credential)`; replays a paid result without re-charging; no-op without the header. Hooks `res.json` only — streamed responses are never replayable.
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
- **STT margin cap (`src/tools/stt-kit.js`):** per-tier `maxMinutes` (5/10) is enforced
  locally via a `music-metadata` duration probe BEFORE any OpenAI spend — upstream bills
  per audio minute (~$0.003 mini / ~$0.006 4o), so break-even on the $0.03 tier is ~10 min
  and the cap is the margin bound, not a UX nicety. Unreadable duration → 422 (an
  unreadable container would be an unbounded upstream bill). `assertWithinDurationCap` /
  `probeDurationSeconds` exported for `scripts/test-stt-cap.js`.
- **Marketplace latency / snapshot caching (`src/x402-economy.js`):** `GET /marketplace`
  (and `/api/x402-economy`) render from `x402EconomySnapshot()` — a ~500ms on-chain read
  (EIP-3009 USDC settlements on Base via CDP SQL). It is **stale-while-revalidate**: a fresh
  cache (30 min, `ECONOMY_FRESH_MS`) returns as-is; a stale-but-present cache is served
  immediately while a single **deduped** background rebuild (`startEconomyRefresh`, one
  in-flight query for a concurrent burst) runs; only a cold cache (first request after boot)
  awaits the build. Errored reads back-date `cachedAt` so they expire in ~5 min, not 30.
  No visitor request ever blocks on the rebuild — before this, the first visitor after each
  30-min expiry ate the full ~500ms. `getIndexSnapshot()` is a separate 30s in-memory cache
  (`INDEX_SNAPSHOT_TTL_MS`). Measured live 2026-07-18: `/marketplace` p50 135ms / max 224ms,
  `/api/x402-economy` p50 93ms, zero requests >500ms across 26 samples. NB: there is **no CDN**
  in front (no `age`/`cf-cache` header) — the server-side snapshot caches are the origin
  protection; the `max-age=120` on the response is a browser-only hint. Contract pinned by
  `scripts/test-x402-economy.js` (dedup + warm-cache identity, never-throws).
- **Homepage = `src/ledger-home.js`** (`ledgerHomePage`; the old `src/landing.js` is unused
  but still unit-tested). Its `faqs` array renders BOTH the visible FAQ and the FAQPage
  JSON-LD, and the WebApplication offer is an AggregateOffer — deploy.yml's SEO gate greps
  prod for `"FAQPage"` / `GET /faq` / `AggregateOffer`. That gate runs BEFORE the deploy job,
  so a fix to those surfaces goes green on the run AFTER the one shipping it.
- **Paid canary (`scripts/paid-canary.js`):** 27 legs — tools across chains
  (Base/Solana/Polygon/Arbitrum/Stellar/Robinhood), incl. two federal-data legs
  (vin-decode / geo-lookup) whose Base settlements also seed the gov tools into
  settlement-driven indexes like x402scan, plus llm-nano (failover), llm-stream
  (`raw:true`, asserts SSE `data:`…`[DONE]`), llm-auto (model-less request must carry the
  `agent402_router` disclosure), llm-embed + embed-cache (default-on free repeat,
  per-run nonce input), llm-image (real b64_json payload >10k chars), my-usage
  (self-referential history), route-exec (receipt + digest), prompt-cache (pays once,
  identical unpaid repeat must be 200 + `X-Cache: hit`). Trigger via workflow_dispatch on
  `paid-canary.yml` (ref main) after a deploy; verdict is the job log tail.

## Open follow-ups (as of 2026-07-16)
- ~~/v1/audio/speech re-enable~~ **DONE 2026-07-16**: merged + deployed,
  `OPENROUTER_TTS_ENABLED=true` live on Railway, paid canary llm-speech leg settled
  green ($0.06 real buy, run 29529146243 — 28/28). `OPENROUTER_API_KEY` also lives in
  GitHub Actions secrets (added 2026-07-15 for the probe workflow).
- OpenRouter account top-up is manual (their programmatic top-up API is deprecated). If a
  "Gateway credits LOW" issue opens, top up the account; the alarm auto-closes the issue
  once `/api/gateway-status` reports `ok` again.
- Contributor PR **#258** (agentservices.to seed) — MERGED 2026-07-13. Their listing
  stays STALE until their Railway edge cert stops serving `*.up.railway.app` (verified
  3/3 wrong at merge; manifest itself is valid). They'll ping when fixed — then confirm
  the seller appears on /marketplace. Issue **#282** — awaiting the contributor's
  follow-up PR.
- CI nicety (non-blocking): add an Actions concurrency group to the deploy job so rapid
  pushes stop surfacing benign Railway "superseded build" failures.
- Directory/web-form submissions: copy-paste-ready text lives in `docs/ecosystem-listings.md`.

## Environment / ops (set on Railway, not in repo)
`WALLET_ADDRESS`, `WALLET_ENS`, `NETWORK`, `CDP_API_KEY_ID/SECRET`, `FACILITATOR_URL`,
`GLAMA_MAINTAINER_EMAIL`, `POW_SECRET`, `BRAVE_API_KEY` (search-kit Web/News/Images), `BRAVE_ANSWERS_API_KEY` (search-kit `answer` — distinct subscription token from Brave; falls back to `BRAVE_API_KEY` if unset), `BRAVE_SUGGEST_API_KEY` (search-kit `search-suggest` — distinct suggest subscription; falls back to `BRAVE_API_KEY` if unset), `NEYNAR_API_KEY` (onchain-identity-kit Farcaster tools — Neynar API; falls back to `WARPCAST_API_KEY`), `FRED_API_KEY` (macro-kit v1), `FRED_API_KEY_V2` (macro-kit v2 bulk release/observations — distinct key from v1), `DATA_GOV_API_KEY` (gov-kit `gov-data` — data.gov CKAN catalog via the api.gsa.gov/technology/datagov/v3 proxy; falls back to the rate-limited public `DEMO_KEY` if unset), `COINGECKO_API_KEY` (crypto-kit — CoinGecko Demo key sent as `x-cg-demo-api-key`; keyless fallback works but shares the per-IP rate limit with other Railway tenants), `YAHOO_RELAY_URL`+`YAHOO_RELAY_TOKEN` (finance-kit — optional CF Worker relay for Yahoo's chart endpoint; bypasses Railway egress null-route. See `workers/yfinance-relay/`. Both must be set; falls back to direct Yahoo if unset), `NASDAQ_RELAY_URL`+`NASDAQ_RELAY_TOKEN` (finance-kit — optional CF Worker relay for Nasdaq's calendar endpoint; bypasses Railway egress null-route. See `workers/nasdaq-relay/`. Both must be set; falls back to direct Nasdaq if unset), `ALGORAND_RELAY_URL`+`ALGORAND_RELAY_TOKEN` (revenue surfaces — CF Worker relay for Nodely's Algorand algod/indexer; Nodely 403s Railway's egress IP outright and both direct fallbacks are Nodely-operated. See `workers/algorand-relay/`. Both must be set; falls back to direct Nodely if unset), `OPENAI_API_KEY` (llm-kit + image-gen-kit — OpenAI proxy), `OPENROUTER_API_KEY` (LLM gateway `/v1/*` tiers — OpenRouter upstream; routes 503 without it), `E2B_API_KEY` (code-run-kit — E2B sandbox), `BASE_BUILDER_CODE` (Base Builder Code for onchain attribution — from dashboard.base.org; env-gated no-op if unset), `BASE_NOTIFICATIONS_API_KEY` (Base Notifications API — from Base Dashboard; enables push notifications to users who pinned the app; env-gated no-op if unset), `GOOGLE_SITE_VERIFICATION` (Search Console HTML-tag verification token — rendered as a meta tag in the shared ledger head; env-gated no-op if unset), `INDEXNOW_KEY` (IndexNow ownership key — serves /{key}.txt and enables scripts/indexnow-submit.js instant-indexing pings to Bing/Copilot/DDG/Yahoo; env-gated no-op if unset), `SOLANA_WALLET_ADDRESS` (Solana payTo address for USDC on Solana), `ALGORAND_WALLET_ADDRESS` (Algorand payTo address for USDC on Algorand — must be opted in to ASA 31566704 or settlement fails on-chain), `ALGORAND_FACILITATOR_URL` (optional override for the GoPlausible-hosted AVM facilitator; default `https://facilitator.goplausible.xyz`), `ROBINHOOD_FACILITATOR_URL` (required to enable the Robinhood/USDG rail — no default baked in; set to `https://facilitator.naven.network` (Naven, the first x402 facilitator on Robinhood Crypto — keyless, advertises `exact/eip155:4663` + Base at `/supported`, verified settling USDG 2026-07-17). Swapped from the prior `mpp.hyreagent.fun/r402`, which began rejecting settles 2026-07-16), `OUR_ALGORAND_WALLETS` (optional comma-separated override of the internal/canary Algorand burner set used to classify revenue), `ALGORAND_BURNER_MNEMONIC` (GitHub Actions secret only — 25-word mnemonic for the Algorand leg of `scripts/paid-canary.js`; never set on Railway), `PAYAI_API_KEY_ID`+`PAYAI_API_KEY_SECRET` (PayAI facilitator auth — optional, free tier 10k settlements/month needs no keys; get at merchant.payai.network), `PAYMENT_NETWORKS` (comma-separated chains to accept — default is the primary network only; e.g. `base,solana,polygon,arbitrum,stellar,algorand`; CDP facilitator handles Base, PayAI handles the rest), `WALLET_BLOCKLIST` (comma-separated wallet addresses refused service — enforced by a beforeSettle abort in `src/payments.js`, so a blocked wallet is never charged; the 402's receipt carries errorReason `wallet_blocked` and the tally records a `settle_failed` event. Call-time read; the /terms enforcement section is the policy this implements), `PAYMENT_SETTLE_FALLBACK` (`true` to re-settle via PayAI when the primary facilitator rejects settlement BEFORE broadcasting — an HTTP 402 such as CDP's `payment-method-required` billing gate; never on timeout/5xx, so it can't double-settle. Default off: Base stays purely on CDP for Bazaar + fee-free settlement. Turn on for never-miss-a-sale insurance against a CDP billing lapse. Facilitator verify/settle failures are always logged loudly regardless via `onVerifyFailure`/`onSettleFailure` hooks). Never commit secrets or wallet keys.

## This sandbox vs. prod
The Claude Code **web** environment has an egress allowlist (npm + GitHub reachable;
`agent402.tools`, `basescan.org`, `glama.ai` are **blocked**). Verify prod via CI
(`[probe]`, heartbeat, canary) or a local terminal (full network). npm registry is reachable for `npm view`.
