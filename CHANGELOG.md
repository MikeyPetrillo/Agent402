# Changelog

All notable user-facing changes to the Agent402 server and site. Package
releases are listed under the server version they shipped with; each package
carries its own version on npm.

## Unreleased

Since v2.5.0 (2026-10-07).

### 2026-10-08
- `/v1/judge` is answered by OpenAI's Decisions API (`gpt-6-luna`) first, with
  Jev as the fallback; `model` names which one answers first, the answer names
  the model that served, and `fallbackFrom` says when the first was
  unavailable. The answer shape is unchanged.
- Add `POST /v1/decisions`: OpenAI's Decisions wire, so an OpenAI SDK pointed
  here calls `decisions.create` unchanged and pays per call. Text input; same
  backends and fallback (`fallback_from`).
- Add `/fixtures/sample-speech.wav`, a two-voice clip; the `transcribe` and
  `transcribe-pro` examples use it, and `diarize: true` names two speakers.
- The `image-exif`, `image-dominant-color`, `image-crop`, `image-ocr` and
  `pdf-summarize` examples and the document-brief and openapi-audit packs read
  this site's own sample files.

## v2.5.0 - 2026-10-07

Since v2.4.0 (2026-09-18).

### 2026-10-07
- `/api/tts` speaks with ElevenLabs Eleven v4 Turbo and `/api/tts-hd` with
  Eleven v4: each of the ten voice names has its own voice, 21 ElevenLabs
  voices can be named directly, and all six formats are served. When the
  primary model is busy, a backup model serves and the answer names it.
- Transcription takes `diarize: true` for speaker labels and word timestamps
  (ElevenLabs Scribe v2) on `/api/transcribe`, `/api/transcribe-pro` and the
  OpenAI transcription wire, at the same price and cap.
- A speech failure with no backup left reads "temporarily unavailable" and
  carries no upstream error text.
- Most published examples fetch from agent402.tools and its own sample files.
- `/api/find` marks a row weak when only an indexed outside seller does the task.
- Multi-search whose every query is empty is a 400 before any upstream call.
- Seller index: a fallback seller (no `/.well-known/x402`) keeps its catalog
  across a 304, and its `/openapi.json`, `/agents.json` and `/llms.txt` are
  read once per crawl.
- Gateway: more successors for thinly hosted models, served on every wire and
  named in `agent402_model_substituted`.
- Flight search and flight status from outside sellers, off unless configured;
  an answer that cannot be read is an uncharged 502.
- jsdom 30.1.2.

### 2026-10-06
- The local proxy (`npx agent402-openclaw proxy`, agent402-openclaw 0.5.0)
  answers the Anthropic Messages wire: point Claude Code at it with
  `ANTHROPIC_BASE_URL` and each turn is paid from a wallet over x402. The proxy
  relays the x402 settlement receipt to the client.
- The Messages route clamps a thinking budget along with `max_tokens` instead of
  refusing it.
- When every host of a requested model is down, its same-family successor
  serves, on chat, Messages and Responses, named in
  `agent402_model_substituted`.
- `exa-contents` is repriced to cover its largest accepted call.
- Refund runs survive RPC rate limits: verification retries 429/5xx reads with
  backoff, and the refund ledger routes get their own operator limiter.
- Connector instructions (hosted and stdio, identical) start one fact at
  `web.search` / `web.answer` and a multi-step job at `decide.plan` then
  `decide.execute`.
- `search` answers carry `next` naming `answer`, and `decide` answers name
  `decide-execute`, with route and price from the catalog.
- A task that names several steps gets a free `plan` on `/api/find`,
  `/api/route` and `catalog.find`: each step ranked, with fallbacks.
- New tools: `rsi`, `gcd-lcm` (both free tier) and `fetch-json`.
- `/api/revenue/daily` adds `repeat7`, buyers who paid again within 7 days.
- Every HTML page links `/llms.txt` (`<link rel="alternate">` and a `Link`
  header); `/api/pricing` rows for EVM-only routes carry `networks`.
- `/credits` is `noindex` and out of the sitemaps while credit sales are off;
  `/revenue` is served `no-cache`.
- Public copy, comments and terms match what the code does.
- @x402/* 2.28, @modelcontextprotocol/sdk 1.32.0, viem 2.57.3; agent402-mcp 0.13.9.

### 2026-10-05
- The free (proof-of-work) tier is an allowlist: a new tool is wallet-only by
  default.
- A skill pack with no step config is refused with a 500, never charged.
- `routerDispatchEligible` names the Base unproven-tier exception;
  such rows carry `executeViaCallableNow: true` and `executeViaLane: "unproven"`.

### 2026-10-04
- `/revenue` shows the newest settle on each rail whoever paid, with our own
  runs marked `ours`; each row links to our wallet, never a buyer's transaction.
- `/api/gateway-status` gains a `sanctions` field (`ok`, `stale`, `unloaded`,
  `loading`).
- Upstream rates load from a private table instead of the source.

### 2026-10-03
- Retiring model ids are served by their successors; a `:free` suffix is not
  carried to the successor.
- Our own 402 Index listings are repriced daily when they drift from the catalog.

### 2026-10-02
- A seller can be registered as host plus path prefix; each prefix lists as its
  own seller.
- Header: a "live" link to live.agent402.tools.
- A seller whose crawl is failing keeps its last good catalog across restarts,
  as unhealthy and unroutable.
- Site, machine-readable surfaces and package READMEs corrected to match the
  code; counts, prices, rails and cadences in copy are derived from the catalog.
- Free filing alerts watch 10-K, 10-Q and 8-K and list the filings in the email.
- `/algorand` renders within 8 s when the indexer stalls.
- Index submissions: a quick-tunnel origin's slot is released 3 days after its
  last successful probe, and tunnels hold at most a quarter of the slots.
- Tool pages name MPP only where it is offered; credits refusals point at
  `/api/pricing` while packs are off sale.
- Packages: agent402-mcp 0.13.7, agent402-client 0.8.11, agent402-openclaw
  0.4.5, agent402-tollbooth 0.10.3, ten JS adapters, elizaos-plugin-agent402
  0.2.4, agent402-langchain (PyPI) 0.1.4.

### 2026-10-01
- live.agent402.tools shows x402 payments on Base and MPP payments on Tempo as
  they settle; the home page hero links to it.
- Decide: `POST /api/decide` turns a task into a plan of tools (ours and outside
  sellers with a recently verified 402), with fallbacks and schema-checked
  params; `POST /api/decide/execute` runs it within a budget and returns unspent
  money as a credit. `decide.feedback` records whether a step worked.
- `/revenue` serves its saved reading after a restart and bounds each rail.

### 2026-09-29 to 2026-09-30
- The router may pay a Base seller below the settlement-history floor, under a
  one-cent ceiling, after every proven seller and only at the wallet its own
  live 402 names; the receipt flags it unproven.
- route-execute and seller-payability pay another seller only while the buyer's
  own authorization can still settle afterwards; otherwise they answer 504
  before paying anyone.
- `/revenue` and the chain pages read recent transfers from the settlement
  ledger on every load.
- `/status`: the paid path is observed every 5 minutes by two independent
  observers.
- Seller index: `fallbackErrors` names each fallback file that gave nothing.

### 2026-09-28
- The JSON body of every paywall 402 also carries the PaymentRequired object
  from the `PAYMENT-REQUIRED` header (`x402Version`, `error`, `resource`,
  `accepts`, `extensions`), after this server's own fields. The header is
  unchanged and stays authoritative. A refused payment's body leaves out the
  header's one-line `error`: its `hint`, or an MPP problem's `detail`, says
  what went wrong, and a client that reads `error` first reads that instead.
- Packages: agent402-mcp 0.13.5 (a refused paid call reads as its reason,
  not the offer), agent402-openclaw 0.4.4 (a refused x402 payment reaches
  OpenClaw as one OpenAI-shaped error sentence), agent402-client 0.8.9 (a
  failed call's text falls back to the refusal's hint).

### 2026-09-25
- The tool directory (`/marketplace/tools`, `/api/index/tools`) is built once
  per index change instead of on every page request, and the search index
  indexes a large seller in slices; both showed as event-loop stalls.
- Paid calls come first under load: when the event loop lags or too many
  requests are in flight, free and discovery requests get 503 + Retry-After
  before they are parsed, and uncached searches share a per-second CPU
  budget across all callers. Calls to priced routes and the gateway, paid
  or not, are never shed. Lag sheds only while the loop stays saturated;
  requests queued behind a single slow moment are served.
- Revenue, sales, status, proof and marketplace pages are built at most once
  a minute on the server instead of on every request, and the revenue series
  reads one chain at a time; these were the main event-loop stalls. Once
  built, an expired page is served at once and rebuilt in the background.
  The tool directory rebuilds in slices while the previous one serves, the
  revenue series is built across several turns, and the chain strip on every
  page is computed once per index change. The router holds about a quarter
  less memory for the same index (shared name tokens), so memory cleanups
  pause the server for less time.
- `requestContract` on index rows also reads a JSON Schema the seller declares
  beside a route in its `/.well-known/x402` manifest (`input_schema` or
  `inputSchema`), labeled `source: "seller_manifest"`; a contract from the
  seller's OpenAPI document still wins.
- The index cache is written without blocking the server: each seller is
  serialized once, in batches, where the whole cache used to be serialized
  three times in one pass.
- `/api/route` and `/api/find` answer faster: common words ("to", "for",
  "the") no longer pull most of the index into every search, one request
  scores its query once, and the index rebuild after each crawl runs in the
  background in short slices instead of blocking the server.
- `/api/find` no longer flags a correct answer as a miss because the query
  carries a word no tool mentions ("claims" in "decode jwt token and extract
  claims"): the top result counts as served when it covers at least two
  query terms, half the query's weight, and one term in its own slug or name.
- `crypto-indicators` takes `ohlcv` (0-100) and returns the last N OHLCV
  candles beside the indicators, so spot close, candles and RSI/EMA arrive in
  one call at the same price.
- `jwt-decode` and `unit-convert` descriptions name what they already handle
  (JWT claims and expiration; stones, kilopascals, bar, joules, btu,
  horsepower), so searches in those words find them.
- `stock-history` takes `indicators` (true or a list of rsi, macd, ema, sma,
  bollinger, atr) and `points`, and returns technical analysis computed from
  the same daily bars at the same price, with a plain summary.
- `json-format` takes `sortKeys` and `canonical`; `canonical: true` returns
  the RFC 8785 canonical form and its SHA-256.
- `unit-convert` converts imperial Russian measures: versts, sazhens,
  arshins, vershoks, poods, funts and zolotniks.
- New `cve-lookup` ($0.005): a CVE by id, or a keyword search, with the NVD
  description, CVSS, CWE, affected products and references, joined with the
  EPSS exploitation probability and the CISA KEV entry. This product uses the
  NVD API but is not endorsed or certified by the NVD.
- Seller index: request and response contracts are read through local OpenAPI
  references (`#/components/...`), so a FastAPI seller's required fields and
  guaranteed response paths show as declared instead of partial.

### 2026-09-24
- `polymarket-search`, `polymarket-market`, `polymarket-orderbook` and
  `polymarket-price-history` are retired. Each route answers 410 naming the
  nearest Kalshi tool (`kalshi-markets`, `kalshi-event` or `kalshi-live-data`).
- Model gateway: `openai/gpt-6-luna` is the nano default and leads the auto
  router's fast band; `openai/gpt-6-sol` is served on the pro tier;
  `anthropic/claude-opus-5.5`, the Grok 4.5 to 4.7 models and
  `qwen/qwen3.8-max-prime` get their own cost and reasoning rows, so a small
  budget is not spent entirely on reasoning and qwen3.8-max-prime is servable
  on the metered route. Four DeepSeek ids the upstream removes on 2026-09-28
  (`deepseek-v3.2`, `-v3.2-exp`, `-v3.1-terminus`, `-r1-distill-llama-70b`)
  are refused by name with a successor named.
- `/v1/images/generations` is served by FLUX.2 Pro (GPT-5 Image Mini as the
  failover) ahead of Gemini 2.5 Flash Image's shutdown on 2026-10-02. The wire
  is unchanged: one 1024x1024 PNG per call as inline base64.
- Seller index: a route that is not in the seller's own manifest or OpenAPI
  must answer a live 402 at least every 7 days and leaves the listing when it
  answers 404 or 405 twice at least an hour apart; a 410 removes any route;
  re-registering re-checks every route. `/api/index?seller=` shows
  each route's `declared`, `source` and `lastVerifiedAt`.
- `kalshi-markets` and `kalshi-event` return `yesBidSize` and `yesAskSize`,
  the resting contracts at the best yes bid and ask. Kalshi retires its
  liquidity figure on 2026-10-01 and it already reads zero on live books, so
  `liquidityUsd` is null with a `liquidityUsdNote` wherever Kalshi publishes
  no figure.
- agent402-tollbooth 0.10.2: the Tempo settlement confirm used after a failed
  relay broadcast requires the transfer's MPP memo to be bound to the
  credential's own challenge.

### 2026-09-23
- The model gateway serves Meta's Muse Spark (`meta/muse-spark-1.3`, `-1.2`,
  `-1.1`) and Muse Glimmer 30B (`meta/muse-glimmer-30b`) on the base tier and
  on every route priced by model. "Contributor" listings
  are refused by name.
- /guides/agent-hosts covers Muse Code (MCP over Streamable HTTP or stdio);
  `/muse` links to it.
- A 402 lists the MPP tempo challenge first, so a client holding Tempo funds
  pays over Tempo; a client whose tempo credential was just refused gets the
  evm challenge first for 30 minutes (`MPP_TEMPO_DEMOTE_MS`).
- The hosted MCP connector answers an unpaid paid-tool call with a readable
  tool result whose text names every way to pay and whose
  `_meta["org.paymentauth/payment-required"]` carries the challenges, instead
  of a bare JSON-RPC `-32042`; mppx clients pay it the same way. Refused
  credentials still answer `-32043`, and the tasks path keeps `-32042`.
- `/openapi.json` drops repeated per-operation boilerplate (the 402 walkthrough
  lives once in `info.x-guidance`).
- `/openapi.json` offers an MPP tempo payment only on routes whose 402 offers
  one (not on wallet-identity or long-running routes), and per-request-priced
  routes publish a dynamic price range with null offer amounts.
- The hosted MCP connector declares the MPP methods it accepts in
  `capabilities.experimental.payment`.
- README: a three-line quickstart for paying over MPP and over x402.
- Telemetry records the payment rail each call presented (x402, MPP evm,
  MPP tempo, MPP stripe, credits, proof-of-work); the operator traffic report
  and its daily summary line carry per-rail attempts, paid, refused, errored
  and distinct payers.
- CONTRIBUTING and the issue templates point sellers at
  `POST /api/index/register` instead of a seed PR.

### 2026-09-22
- Say, in fields a machine reads, that `GET /api/index` is one page: `complete`
  (false whenever a seller is absent from this response but present in the
  index), an RFC 8288 `Link` header with first/prev/next/last, `X-Total-Count`,
  and a note that leads with PARTIAL. `perPage` is honoured as an alias for
  `limit`. The seller detail (`?seller=`) now declares `toolsReturned`,
  `toolsTruncated` and `toolsCap` instead of silently cutting the tool list at
  500. `llms.txt` no longer calls the paginated listing a snapshot of every
  seller indexed.
- Read a base-unit `amount` in an index listing as dollars only when the token
  is one we recognise as dollar-pegged: a declared `decimals` no longer sizes an
  arbitrary asset, a declaration that contradicts the chain publishes no price,
  and a figure that cannot be written as a plain decimal is refused.
- Retire contract-inspect, address-profile, token-info, token-holders and
  tx-inspect; the routes answer 410, naming a replacement where one exists.
- Read every `token-risk` token fact from keyless probes; the advertised chains
  are now the ones the token-security probe serves (celo out, bsc in), and a
  source that does not answer refuses 502 or 503 rather than 422.
- Remove the `/api/chain/proxy` verb with the tool it pointed at.
- Add `search-lite` (`GET`/`POST /api/search-lite`, $0.008): up to 5 web results
  (title, URL, snippet) from the same index as `search`, no freshness filter.
  A generic SERP query still resolves to `search` on `/api/route` and
  `/api/find`.
- Publish a `GET` query parameter in `/openapi.json` with the type its schema
  declares when that type is `integer` or `boolean`; both were published as
  `string` beside a numeric or boolean example.
- Price a flat chat route by the model it is asked for: a model that another
  flat tier serves (nano, base, pro, premium) now gets a 402 quoting that
  tier's price and, once paid, is served under that tier's caps, allowlist and
  failover instead of a 400. Applies to the chat, Messages, Responses and
  Gemini wires; the answer carries `agent402_tier`. Catalog prices, `/api/pricing`
  and `/openapi.json` are unchanged.

### 2026-09-21
- Add `POST /v1/judge` ($0.001): typed judgments (a choice from a named set, a
  scored scale, a probability) over a supplied state.
- Accept alternate unit spellings in `unit-convert` (plural/singular, British
  spellings, spaces and underscores, `statute-` prefix); unknown units still 400.
- Add `priceKnown` to `/api/index` sellers, `/api/route` rows and seller detail;
  `priceUsd` is unchanged.
- Accept a seller origin on a non-default port at x402 registration, MPP
  registration and MPP discovery.
- Send `User-Agent: Mozilla/5.0 (compatible; Agent402-Router/1.0; +https://agent402.tools/crawler)`
  and `X-Agent402-Via: router` on every paid call the router makes; `/crawler`
  documents it.
- Count a transfer that matches a wallet's published price as a settlement at
  any size on the seller leaderboard; rows carry `settlementsAbovePerCallCeiling`
  and `transfersSkippedOverCeiling`.
- Accept `?limit=` as an alias of `?top=` on `GET /api/leaderboard`.
- Fix heading order on `/reports`, `/monitors`, `/quickstart` and `/transparency`;
  stop `/leaderboard` printing the same figure twice; trim ~6 KB of repeated nav
  style from every page.
- Fix the `x-tweet` documented example to a real tweet id.
- Retired tools and skill packs answer 410 Gone with the retirement date and the
  live replacement instead of a 404.
- Packages: agent402-mcp 0.13.3, agent402-client 0.8.7, agent402-anthropic-tools
  0.1.8, agent402-langchain 0.2.7, agent402-llamaindex 0.1.8,
  agent402-openai-agents 0.1.7, agent402-openai-tools 0.1.8, agent402-strands
  0.1.8 (corrected READMEs, descriptions and the report price ladder on npm).

### 2026-09-18 to 2026-09-20
- Add Google's native `generateContent` wire on every gateway tier.
- Add `POST /v1/audio/transcriptions` (OpenAI transcription wire, multipart).
- Add `service_tier: "priority"` on the pro and premium tiers (2x list);
  `:nitro` is pinned to the default tier.
- Add `perp-dexs`, `perp-dex-markets` and `perp-dex-limits` on Hyperliquid
  builder-deployed (HIP-3) dexs.
- Add `kalshi-live-data` and `kalshi-weather-index`.
- Add `edgar-13f-datasets` ($0.003) and `edgar-13f-dataset-head` ($0.005).
- Restore `sol-token-holders` (was returning an empty table).
- Move `stock-quote` and `stock-history` onto Databento DBEQ.BASIC: per-venue
  volume is reported as `venueVolume`, `stock-history` accepts up to 250 sessions,
  the 52-week high/low fields are gone.
- Remove `options-chain`, `premarket-quote`, `stock-dividends`,
  `earnings-calendar`, `dividend-calendar` and the `market-open` skill pack.
- Stop selling prepaid card credits; existing keys keep redeeming.
- Add CORS on the machine surfaces (`/api/`, `/v1/`, `/mcp`, `/.well-known/`,
  `/openapi.json`, `/llms.txt`) with the payment headers exposed.
- Point an under-funded buyer at what its balance covers on the 402
  (`retry: "lower-price-route"`).
- Add input aliases for 20 more required parameter names (`barcode`, `upc`,
  `ean`, `coin`, `prompt`, `html`, `hash`, `mint`, `spec`, `payload`, ...).
- Serve an A2A AgentCard at `/.well-known/agent-card.json` and
  `/.well-known/agent.json`, and the ERC-8004 registration file at
  `/.well-known/agent-registration.json`.
- Seed Base and Algorand settlement evidence from our own crawl as well as the
  facilitator catalogs; a seller's detail view echoes its own description and
  tags; re-registering an origin re-reads its documents.
- Add a Monthly bucket to `/revenue`; rebuild the per-chain marketplace pages as
  a dense table; redact upstream error text on `/api/revenue`.
- Add a disclaimer to `dossier`, `research-deep`, `recall-report` and
  `crypto-indicators` output.
- Refuse `cohere/rerank-4-fast` on `/v1/rerank` by name.
- Fix `email-deliverability` reporting a failed DNS lookup as a missing record.
- Ship the OFL licence files with the self-hosted fonts.
- mppx 0.10.1.

## v2.4.0 - 2026-09-18

- Admit `openai/gpt-6-astra` and `anthropic/claude-fable-5.1` on the premium tier.
- Add top-level `effort` on the Messages wire for Claude 4.7+; refuse `speed`
  other than `standard`.
- Move `transcribe` onto `gpt-transcribe` with a 4-minute cap; cap `tts-lite`
  text at 800 chars.
- Add `/api/chain/<verb>` (35 RPC verbs) and five chain reads: `chain-nonce`,
  `chain-storage`, `chain-pending`, `chain-total-supply`, `chain-erc1155-balance`;
  a contract revert is a 422.
- Add `POST /api/attest` (EAS attestation on Base for a settled call) and
  `POST /api/feedback` / `GET /api/feedback/summary`.
- Answer `/api/route` from a candidate index; validate Exa search categories;
  read Polymarket price history from the Data API.
- Add `/x402-test` (`/conformance`, `/debug`), the payment-refusal diagnostic.
- List a migrated seller once: a verified succession retires the predecessor
  while the successor is live.
- Read a route that answers 200 with no paywall as free; re-registration re-asks
  every learned price.
- Read every OpenAPI payment-annotation dialect and object-shaped manifest prices.
- Default `GET /api/leaderboard` to `include=external`; the host's own row carries
  `self: true`.
- Add `POST /api/seller-dossier` ($0.05).
- Add `sanctions-wallet` and `sanctions-name` (OFAC SDN screening).
- Upgrade `@x402/*` to 2.26.0 and `@solana/kit` to 8.3.0; Node 22.23.2.
- Reorder the settle fallback between the backup facilitators.
- Packages: agent402-mcp 0.13.2, agent402-openclaw 0.4.3, elizaos-plugin-agent402
  0.2.3, agent402-agentkit 0.1.3, agent402-tollbooth 0.10.1 (CLI runs through the
  npm bin symlink again), agent402-client 0.8.4 to 0.8.6, agent402-ai-sdk 0.2.7,
  agent402-google-adk 0.1.7.

## v2.3.0 - 2026-09-02

- Carry the typed output schema on every 402 as `accepts[0].outputSchema`.
- Add `rwa-list`, `rwa-markets`, `rwa-asset`, `rwa-issuers`, `rwa-issuer`
  ($0.003 to $0.006).
- Show `executeVia` only on `/api/route` rows the router will pay now; every row
  and index seller carries `routerDispatchEligible` and `routerDispatchReason`.
- Re-read a manifest-priced route's live 402 weekly so newly added rails reach
  the index.
- Retire `gpt-4.1-nano` and the `openai/o4` prefix; `gpt-5.6-luna` is the nano
  default, `gpt-5.6-terra` joins premium; `/v1/images/fast` fails over to
  `gpt-5-image-mini`.
- Answer a refused MCP payment credential with JSON-RPC `-32043`.
- Retry a failed Tempo subscription renewal in minutes and read the chain before
  re-signing after a timed-out send.
- Run every tool a skill pack advertises.
- Packages: agent402-tollbooth 0.10.0 (MPP on the edge build), mppx 0.9.2.

## v2.2.0 - 2026-08-26

- Add `/agentic-finance`, `/101`, `/glossary` and `/why`.
- Settle MPP natively on Tempo (`tempo/charge`) beside the `evm` method; answer
  rejected credentials with RFC 9457 problem documents.
- Add MPP subscriptions over `tempo/subscription`.
- Offer cards over MPP (`stripe/charge`) on routes priced $0.50 and up.
- Add `/mpp-marketplace`, `/api/mpp-index` and `/api/mpp-leaderboard`.
- Pay MPP sellers on Tempo through the Smart Order Router; `agent402-client` pays
  MPP sellers.
- Add `/reports` (card checkout for finished reports), `/monitors` ($5/month
  watches) and `/credits` (prepaid card credits).
- Add the report products on `/v1`: research (three tiers), market brief,
  dossier, ticker pack, fund, insider, filing, domain audit, recall, token risk,
  token brief, IPO digest and LinkedIn article.
- Add `/reports/insider/:ticker`, `/reports/fund/:manager` and
  `/reports/dossier/:ticker`.
- Add the metered gateway tier (`POST /v1/metered/chat/completions`): each 402
  quotes the request; `upto` and credits buyers settle actual usage.
- Add the Anthropic Messages and OpenAI Responses wires on every tier,
  `POST /v1/rerank`, the grounded tier, images and video routes.
- Rename the MCP tools to dotted names (`catalog.search`, `catalog.call`, ...);
  the snake_case names remain call aliases.
- Retire 40 free-tier tools and 29 skill packs with no external use in 30 days.
- Redesign the site: light theme by default with a dark toggle, self-hosted fonts.
- Packages: agent402-mcp 0.13.0, agent402-client 0.8.2, agent402-tollbooth 0.9.3,
  agent402-openclaw 0.3.1, agent402-agentkit 0.1.0.

## v2.1.0 - 2026-08-17

- Redesign the homepage, `/what-is-x402`, `/sell`, `/tools`, `/leaderboard`,
  `/skills` and `/marketplace`; add an in-browser proof-of-work demo.
- Exclude the host's own row from the seller leaderboard.
- Add four payment rails: Celo, Avalanche, Sei and Optimism (twelve chains).
- Tighten the site Content-Security-Policy.
- Answer MPP (`WWW-Authenticate: Payment`) on every 402 beside x402 (2026-07-24).
- Add external execution to the Smart Order Router on Base and Algorand
  (2026-07-21 to 2026-07-23).
- Return the same 402 on HEAD as on GET.

## v2.0.0 - 2026-07-14

- Retire ~970 generated pairwise unit-converter routes in favour of
  `POST /api/unit-convert`; retired routes answer a 410 naming the replacement.
- Rebuild the catalog to 500+ entries; CI enforces a 400-entry floor.
- Relicense the server to AGPL-3.0; `client/`, `mcp/` and `tollbooth/` stay MIT.
- Add `x402-audit`, the Sales ledger, the x402 Economy observatory, Onchain SQL,
  the CDP onboarding kit, Robinhood Chain (USDG) settlement and the x402 index
  with the Smart Order Router.

## v1.3.0 - 2026-07-12

- Add the federal-data pack and `market-pulse`.

## v1.2.0 - 2026-07-05

- Add 100 skill packs.

## v1.1.0 - 2026-07-04

- Add Stellar settlement and Stripe ACP; six chains.

## v1.0.0 - 2026-06-25

- First public release: pay-per-call tools over x402 (USDC on Base, Solana,
  Polygon and Arbitrum), a proof-of-work free tier, the hosted MCP connector and
  the `agent402-mcp` package.
