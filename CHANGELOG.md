# Changelog

All notable user-facing changes to the Agent402 server and site. Package
releases are listed under the server version they shipped with; each package
carries its own version on npm.

## Unreleased

### 2026-10-30 (metered default, speech quotes, sale paths)
Surfaces:
- The metered gateway (/v1/metered/chat/completions and its Messages and
  Responses twins) is the default way to call a model on /llms.txt, the
  openapi guidance, SKILL.md, the connector's server.describe and
  payment.info, the home page, the FAQ, the x402 guide, the README and the
  wiki: the 402 quotes the request from its body (the input estimated from its
  tokens with headroom, plus max_tokens), and on x402, Tempo and credits
  settlement never exceeds that quote; a card payment adds the processor fee.
  The flat tiers stay as the predictable-price option, and a flat chat tier's
  unpaid 402 names its metered twin in meteredTwin.
- A retired route's 410 carries a Sunset header with its retirement date and,
  when a replacement is live, a Link header with rel="successor-version"
  naming it; the retired pairwise converters name /api/unit-convert. The JSON
  body is unchanged.
- /api/revenue's cacheSeconds is the HTTP max-age it sends;
  refreshesEverySeconds and nextRefreshAt state the cadence of the rail scan
  behind it.
- The privacy page (dated 2026-10-30) says the sales ledger keeps how a paid
  call arrived.

Speech:
- /api/tts and /api/tts-hd are quoted per request from the length of the
  text: $0.005 plus $0.0575 per 1,000 characters on tts and $0.010 plus $0.115
  per 1,000 characters on tts-hd, rounded up to the next $0.001, so 2,000
  characters costs what the flat price did ($0.120 and $0.240). The cap stays
  2,000 characters on both. The 402, Tempo and credits all read the quote;
  /api/pricing (quoteRange, quoteFormula), /openapi.json, the tool pages and
  /llms.txt publish the range and the formula. /api/dub keeps its
  2,000-character cap and its price; /api/tts-lite stays flat.
- /api/tts and /api/tts-hd are called directly: route-execute refuses routes
  quoted per request, so the 402 carries the real price.
- Catalog lines in /llms.txt and /llms-full.txt read "from" the floor on every
  route quoted per request.

Packages:
- agent402-client 0.8.21 takes a userAgent option (a calling package's own
  product token, sent before the client's). agent402-mcp 0.13.23,
  agent402-agentkit 0.1.10, agent402-ai-sdk 0.2.12, agent402-anthropic-tools
  0.1.13, elizaos-plugin-agent402 0.2.10, agent402-google-adk 0.1.12,
  agent402-langchain 0.2.12, agent402-llamaindex 0.1.13,
  agent402-openai-agents 0.1.13, agent402-openai-tools 0.1.13,
  agent402-strands 0.1.13 and agent402-langchain 0.1.6 on PyPI name
  themselves in the User-Agent of every request.

Operations:
- Each sale records the path it arrived on: the hosted connector's loopback,
  one of our client packages by its User-Agent product token, or HTTP; rows
  recorded before read unknown. The operator sales and tool-failure views
  group by that path, and an operator cohort view lists wallets past a
  per-day distinct-tool or per-hour call threshold beside a daily series
  without them. Public figures are unchanged.
- An operator test wallet that pays the Gateway batched route is booked as
  our own traffic.

### 2026-10-29 (payments, gateway, router, connector)
Payments and refunds:
- A card report bought at checkout is generated from the Stripe webhook as
  well as from the success page, so a buyer who closes the tab still gets it.
- An async job or MCP task whose settled answer was lost is booked as a debt
  at the price the buyer paid on its chain (premium and floor included, or the
  metered amount), with the x402 settle receipt as proof.
- A streamed metered call paid with prepaid credits is debited at the usage
  its last frame reports, not at the quote held when it started.
- A card report refund that could not be sent is read on the refundsOwed word
  of /api/gateway-status, so the status probe and the heartbeat page on it.
- A buyer that leaves while its payment settles is charged; a resend of the
  same payment voids the debt and is served the answer, and a resend after
  the refund was paid is refused. A hang-up forgiveness ticket is priced on
  the chain the verified header names.
- A refusal on a Tempo push payment says the transfer was claimed and a refund
  is owed; copy that says a refusal is not charged names x402, the rail that
  holds on.
- A credits pack refunded in full before its claim mints no key; a partial
  refund mints net of it; after minting, a refund takes its amount off the
  balance and a full refund or a dispute disables the key. A disputed
  subscription payment drops the subscription from the active list until the
  dispute is won, which also re-enables a key the dispute disabled.
- The unpaid-quote limiters and the gateway cache count a payment header only
  when it decodes to a payment on a chain this server sells on.
- agent402-client 0.8.20 pays the Circle Gateway batched accept on Arc and
  Base with the gateway option (an EIP-712 signer whose address holds a USDC
  deposit in Circle Gateway): the authorization is signed under the Gateway
  domain the accept carries, the caps hold before the signature, a pending
  settlement is resent with the same header, and a 402 with no batched accept
  falls back to the payment fetch. Off by default. A refusal for a short
  Gateway balance says to deposit, not to fund the wallet, and reads no wallet
  balance. The mechanism is on the wiki's Circle Gateway page and in the x402
  guide.

LLM gateway:
- A reasoning or thinking budget is fitted under the output cap the price
  covers on the chat, Messages and Responses wires, or refused with a 400
  when the provider's floor leaves no room.
- /v1/audio/speech stops walking links once its timed-out budget is spent,
  and a stream the upstream dropped after its first frame ends with an SSE
  error frame instead of silence.
- o4-mini is served by gpt-5.6-terra and the answer says so in
  agent402_model_substituted; the premium tier no longer lists it.

Router and index:
- A Solana, Stellar or Algorand x402 payer is screened against the sanctions
  list after its payment verifies, as an EVM payer already was; a listed
  signer is refused before the tool runs.
- A Solana payer's route-execute leg runs under a time budget, as the
  Algorand and Tempo legs do; a resolve that used it up is refused before
  anything is signed.
- Purchases the router makes with our own wallets never count toward a
  seller's settlement proof, on every source the floor reads.
- /api/route serves a seller's name, homepage, description and tags through
  the same listing screen as the index, and our own catalog is recognized by
  canonical host, a redirected manifest included.

MCP connector:
- server.describe no longer lists the client names seen since boot.
- A paid call is booked once, by the route it reaches.
- A paid blocking call to a slow route from a client without the tasks
  extension is refused before any payment, with the guidance the HTTP route
  gives; the free-tier limit copy says the figure is shared across replicas.
- tasks/cancel reaches a task running on another replica.

Surfaces:
- Each chain's settlement premium is published as payment.premiumUsdByNetwork
  on /api/pricing, in /llms.txt, in the openapi guidance and on the
  connector's payment.info, beside the per-chain floors.
- Algorand mainnet is offered under its 32-character CAIP-2 id; a payment
  naming the older full-hash id still settles. agent402-client 0.8.20,
  agent402-mcp 0.13.22 and agent402-openclaw 0.5.7 read both spellings; the
  earlier client matches only the old id. agent402-mcp 0.13.22,
  elizaos-plugin-agent402 0.2.9 and agent402-agentkit 0.1.9 describe a
  credits key as sold or already issued, and the mcp package shows a buy link
  only while the service's /api/pricing says credits are on sale.
- /health answers cross-origin requests, and a cdnOrigin word on
  /api/gateway-status reports whether a CDN-range peer reached the origin
  without its edge secret.
- /.well-known/x402 states under payment.dataHandling that payment
  annotations are not read as readsAnnotationFields, which replaces
  readsPaymentMetadata; the privacy page names readsOnly and
  readsAnnotationFields.
- The router's dispatch legend on /api/index carries settlementNetting (on or
  off) and its self-funded reason says it is read only while netting is on; a
  seller's historyLegend says a crawl outcome counts the routes found, from
  the manifest or from an OpenAPI, agents.json or llms.txt read.
- The home page labels a seller whose name reads as a page title by its host.
- The privacy page carries a rights section for readers in the EU and the UK,
  and its backups wording names the state database.

Operations:
- The operator view of a public surface reads X-Operator-Token only; an
  Authorization header there is a buyer's credential. An operator session is
  known on every operator route across containers.
- The nightly backup runs once a night across replicas.
- Deploy and probe steps that run package code see no job secret.
- @hono/node-server 2.1.3 in the root and mcp overrides; the agentkit-live
  lockfile installs again.

### 2026-10-28 (credits)
- Prepaid credits are a prepayment for Agent402's own services, for business
  and developer use: not cash, not transferable, never expiring, with no fees.
  The terms and privacy policy (both dated 2026-10-28) say so, and the
  checkout shows the rules.
- Routes that buy from an outside seller with our wallet (the router's execute
  tiers, seller-payability, decide-execute and the flight routes) take a
  wallet payment over x402 or MPP on a chain; prepaid credits and per-call
  card payments are refused on them with reason third-party-purchase.
- One buyer may buy at most $1,000 of credits in any 24 hours, matched by
  email or card; a purchase past that is refunded in full and issues no key,
  decided one buyer at a time across servers.
- A decision paid with prepaid credits or a card earns no execution credit, so
  card-funded value never pays decide-execute.
- An unspent credits balance under $10 is refunded on request, and a refunded
  or disputed purchase disables only the key it issued.
- Unknown or malformed credits keys are counted per client and shown to the
  operator; a valid key is never refused because of them.
- Credits checkout asks for a billing address, offers a business tax ID field
  and requires the business-use and terms answers, which the key keeps. A
  buyer billed in the EU or the UK enters a VAT number, or the purchase is
  refunded and issues no key. Prices are the same everywhere and include North
  Carolina sales tax on generated speech, audio and video for a buyer billed
  in North Carolina by card, which each of those tools' pages states.
- agent402-mcp 0.13.21 lists router.execute only with a wallet key;
  agent402-client 0.8.18, agent402-openclaw 0.5.6, elizaos-plugin-agent402
  0.2.8 and agent402-agentkit 0.1.8 carry the updated credits wording.

## v2.8.1 - 2026-10-28

### 2026-10-28
- The response cache keys each answer on every input the call sends, so calls
  to geocode, place-search, fx-rate, weather-alerts, earthquakes and the other
  cached tools with different inputs never share a cached answer. An answer
  from the backup geocoder is kept for 10 minutes.
- Decide keeps the task's letter case when it reuses a plan, so tasks that
  differ only in a URL path or an address get their own plan.
- Geocoding sends at most one request a second to its primary source across
  the service; a call that would wait longer is answered by the backup
  geocoder.
- unit-convert reads Kb, Mb, Gb and Tb as bits; MB, mb and every other unit
  name stay case-insensitive.
- ens-resolve reads through the ENS universal resolver, so names whose records
  moved (nick.eth) resolve; a name with no owner is found: false.
- Payment verification reads Solana transactions sent as version 1.
- page-change answers to urlwatch, url-watch and watch-page.
- Every paid 402 fits the response-header limit of Node's built-in fetch: a
  route's discovery block trims its input schema first and points to its full
  output example when it would not fit.
- llm-premium serves the retired o3-mini and o4-mini ids with gpt-5.6-terra.
- The Kalshi tools read Kalshi's dedicated API host, every GitHub API call
  names API version 2026-03-10, and hunter-email-verify fills result from
  status when the source leaves it out.
- agent402-mcp 0.13.20: tools that reach the network are labeled not read-only
  and open-world; router.execute and sellers.list are listed only with a
  wallet or credits key, or AGENT402_SHOW_ROUTER=1; every tool description on
  both connectors is at most 400 characters and a paid tool opens with its
  price; install commands are pinned to a published version; no default
  session budget.
- agent402-anthropic-tools, agent402-llamaindex, agent402-openai-tools and
  agent402-strands 0.1.12: the npm listings name every settlement chain.
- The Claude Code plugin is 2.8.1, with its icon, privacy policy link and
  README.

## v2.8.0 - 2026-10-20

### 2026-10-23
- A self-hosted server can offer a Circle Gateway batched option on Arc and
  Base (`GATEWAY_NANOPAYMENTS`, off by default): a second `exact` accept beside
  the plain one, at the same price and to the same payTo, whose `extra.name` is
  `GatewayWalletBatched`. A buyer who deposited USDC into Circle Gateway signs
  each call with no gas, and Gateway settles off chain in batches. A payment
  Gateway has not confirmed yet is answered `402` with `Retry-After`; resending
  the same payment serves it once with no second charge. Where it is on,
  `/api/pricing`, `/.well-known/x402`, `/api/rails`, `/llms.txt`, `/how-to-pay`
  and `payment.info` describe it, and `/revenue` counts its sales from the
  sales ledger as settled off chain, with a withdrawal to the wallet not
  counted again. `scripts/gateway-withdraw.js` moves the Gateway balance on
  chain (a dry run unless `--execute`).
- A request re-sent with the same signed EVM payment, to the same route with
  the same body, is answered from its first answer with no second settlement,
  even without an `Idempotency-Key`, and carries `X-Replayed-Answer: 1`.
  Identity-bound routes, routes with a lasting effect and streamed calls keep
  the explicit-key behavior.
- The settle-failure breaker refuses a wallet only while failures are more
  than a share of its outcomes in the window
  (`GATEWAY_SETTLE_BREAKER_MIN_FAIL_SHARE`), with a hard ceiling whatever its
  settled count (`GATEWAY_SETTLE_BREAKER_HARD_MAX`). A new `buyerRefusals`
  word on `/api/gateway-status` reads `refusing` while the breaker turns away a
  wallet that had settled a call in its window.
- The hosted MCP connector is checked on a schedule by an independent client
  built on the reference MCP SDK, which validates every tool's schemas and
  answer shapes the way a host does.
- A seller's OpenAPI price whose `currency` is a token contract is read in the
  token's base units, so `{ currency: <USDC contract>, amount: "10000" }` is
  $0.01.
- `agent402-client` 0.8.17 and `agent402-mcp` 0.13.19: with a prepaid credits
  key, a spending cap counts the route's own price, not a higher price another
  chain's payment option carries, so a budget lasts as long as it should.
- `agent402-client` 0.8.17 takes `payNetworks`, the chains a pre-wrapped
  payment fetch pays on, and counts the dearest option on those chains (the
  dearest of all when none of a quote's options is on them); without it the cap
  still counts the dearest option on any chain. Its chain names now cover every
  chain the gateway offers.

### 2026-10-22
- Please upgrade the buyer packages: `agent402-client` 0.8.16,
  `agent402-mcp` 0.13.17, `agent402-agentkit` 0.1.7, `agent402-openclaw`
  0.5.4, `elizaos-plugin-agent402` 0.2.7, `agent402-langchain` 0.2.11,
  `agent402-ai-sdk` 0.2.11, `agent402-google-adk` 0.1.11 and
  `agent402-openai-agents` 0.1.12 on npm, and `agent402-langchain` 0.1.5 on
  PyPI.
- Spending caps are checked against the payment that is signed, priced from
  the assets the package knows, so a payment over a cap is refused before it
  is signed, whatever amount the 402 quoted.
- A request that can carry a payment does not follow a redirect. The package
  refuses it and names where it pointed, so a signature or a credits key
  stays with the host you configured; if the new address is the one you
  meant, set it as the base URL.
- A paid call to a slow route (reports, video, the premium image) now sends
  `Prefer: respond-async` for a job link, or `Prefer: wait=<maxSeconds>` to
  wait on the connection. A paid call with neither is answered `400` before
  any payment is taken, so a client that would hang up first is never
  charged for an answer it did not receive. `agent402-client` 0.8.16 and
  later is run as a job on its own, and `agent402-mcp` 0.13.18 with
  `AGENT402_ASYNC=off` sends `Prefer: wait`.

### 2026-10-20
- New tool `dub` (`POST /api/dub`): translates a text into a target language
  and speaks the translation in one paid call, priced as the sum of the chat
  tier and the chosen speech tier and quoted in its 402. The audio comes back
  as raw bytes with the translation in the `X-Dub-Translation` header, or as
  JSON with `json: true`. A failed step answers an error naming the step and
  is not settled on x402. Model-backed.
- New tool `loop-gate` (`POST /api/loop-gate`): decides whether an agent loop
  should continue, stop or escalate after an iteration, with the checks behind
  the answer and a next step. Budget and iteration limits are checked in code
  first, and repeats are found lexically before any model runs. Model-backed
  for the goal and stuck judgments.
- New tool `email-guard` (`POST /api/email-guard`): reads one email the way a
  mail-triaging agent should before acting on it, reporting hidden text,
  invisible Unicode, text present in only one part, links whose text names
  another host, header signals and sentences phrased as instructions to an AI
  assistant, each with evidence and offsets. No score and no verdict.
  Deterministic code, no model.
- New tool `page-change` (`POST /api/page-change`): tells whether a public
  page changed since the last look, with nothing stored on our side. It
  answers a fingerprint of the readable text (a selector narrows it, ignore
  entries drop timestamps and counters), and a line diff with a similarity
  score when the previous text is sent back. Deterministic code, no model.
- New tool `mcp-package-check` (`POST /api/mcp-package-check`): the published
  facts about an npm package that ships an MCP server, read before running it:
  version and package age, maintainers, provenance, install scripts,
  dependency counts, deprecation and the GitHub repository the manifest names.
  Observations only, no score. Deterministic code, no model.
- `/api/tts` and `/api/tts-hd` back up ElevenLabs with Voxtral, then Grok
  voice, then MAI-Voice-2 on the same speech wire, each in all six formats.
- New pages: `/how-to-pay` walks the buyer path on every payment rail, and
  `/speech` covers the speech tools, with routes, prices and examples read
  from the catalog.
- On the MCP connector, audio from a paid call comes back as an audio block,
  with dub's translation kept.
- `agent402-mcp` 0.13.14 requires MCP SDK 1.32.1; the server runs
  follow-redirects 1.16.1 and hono 4.13.13.
- Outbound TLS from the server, the render worker, the Stellar facilitator
  and the canaries refuses a certificate chain through any of eight
  intermediate CAs whose keys are reported recoverable, keyed on each key's
  SubjectPublicKeyInfo hash. `agent402-client` 0.8.14 and `agent402-mcp`
  0.13.15 apply the same refusal to their own requests on a dedicated
  dispatcher.
- `html-frames`: an optional `compare` input (`baseline`, an array of
  `{t, png}` stills, or `baselineUrl`, a second document under the same
  render contract fetched through the public-URL guard) adds `similarity`
  (0 to 1) and `changedRegions` (bounding boxes on a 32x18 grid) to each
  compared frame. A compare by `baselineUrl` renders two documents and is
  quoted at twice the listed price in its 402.

### 2026-10-19
- `/v1/videos/generations`: a request that times out answers 504, which is
  not settled on x402. A wallet payer can send the same request again
  unchanged within 30 minutes to collect the same clip.
- `html-frames`: loading and every `renderAt` together share a 25 s budget.
- Route searches score in their worker thread on production servers again,
  instead of on the main thread.
- Tools whose upstream is billed per call have a daily call ceiling. Past it,
  a call answers 503 until 00:00 UTC, and a 503 is not settled on x402.
- stock-quote and stock-history read up to the last session the daily bars
  hold, so a read over a weekend answers instead of being refused.
- New tool `page-speed` (`POST /api/page-speed`): loads one public URL once in
  headless Chromium on a mobile or desktop viewport and reports navigation
  timings (TTFB, DOMContentLoaded, load), LCP, FCP, CLS and total blocking
  time from the page's own performance entries, transfer bytes, request
  count, the five heaviest resources, render-blocking scripts and styles, and
  console errors. The answer's `measurement` field states that it is a single
  lab measurement from one server location under shared load, not field data
  from real users. Deterministic code, no model.
- New tool `html-frames` (`POST /api/html-frames`): renders a self-contained
  HTML document with all network access refused, calls its
  `window.renderAt(t)` for each requested time, and returns a PNG still per
  time plus a contact-sheet PNG. Script errors and a missing or throwing
  `renderAt` answer 400. Deterministic code, no model.
- A saturated browser pool (render, screenshot and the two tools above)
  answers 503 with `Retry-After`.

### 2026-10-18
- Operators can choose which settlement service Celo tries first with an
  environment switch; the other one then becomes Celo's
  settle fallback. Unset, the order is unchanged.
- /sell has a New sellers section: listing and being paid by the router are
  separate gates, how the unproven lane works, and what each
  `routerDispatchReason` means with what the seller can do about it.
- seller-trust names why our own host is not on the proven lane instead of
  answering an empty `provenBlockers` list.
- demand-radar's description calls `/api/wishes` a free aggregate beacon
  (counts only), which is what it returns.

### 2026-10-17
- `POST /v1/images/edits` edits an image from a prompt and one to four PNG or
  JPEG reference images (JSON base64 or data: URLs, or one multipart `image`
  file, so OpenAI's `images.edit()` works unchanged): one JPEG of about one
  megapixel that keeps the first reference's aspect ratio. Model-backed,
  served by FLUX 3 Image Klein.
- `/v1/images/pro` fails over to FLUX 3 Image Klein (a few seconds) and
  `/v1/images/fast` adds it ahead of its existing failover; both keep their
  1024x1024 JPEG output.
- crypto-news recovers within seconds when every news feed failed once:
  a retry fetches the feeds again instead of repeating the cached failure
  for a minute.

### 2026-10-16
- seller-trust and seller-dossier report both router lanes from the router's
  own verdicts: the proven lane with each route-execute tier that can pay the
  seller, and the Base unproven tier with its ceiling. `routableByOurRouter` is
  true when either lane can pay; `routableAsProven` keeps the proven meaning.
- A crawled seller's price is read the same way everywhere whether the seller
  states it as a dollar label, a number or an object. seller-trust and
  seller-dossier count label-priced routes as paid, and the index re-checks
  them for staleness, price drift and networks like every other priced route.
- Market-data quotes and history answer `503` (nothing charged) when the data
  source stalls mid-answer, and the server instances share one cache of
  market bars, so a repeat read is served without waiting on the source.
- Crypto market tools share their response caches and one request budget
  across server instances.
- A Solana payment quoted by one server instance and paid on another settles:
  every instance names the same fee payer.
- A payment the facilitator reports as already on-chain is served when the
  chain shows it paid this request in full; one signed authorization pays for
  one answer.
- Site pages read cleanly on phones from 360 px wide: tables become cards,
  labels stay whole, and text keeps a readable measure.

## v2.7.0 - 2026-10-15

### 2026-10-15 (second batch)
- `POST /v1/judge/vision` (preview) asks typed questions about up to four PNG
  or JPEG images: noul, choice, score, and box answers (where something is,
  as edges from 0 to 1). Model-backed; built on Jev features its maker labels
  experimental.
- `POST /v1/judge/locate` (preview) finds up to four things in one image, each
  with whether it is there and its box.
- `POST /v1/judge/long` (preview) runs `/v1/judge`'s questions over a document
  of up to about 262k tokens.
- On `/v1/judge`, `jev-latest` is the Jev version we have tested and every
  answer names it; `jev-preview` reaches the newer release.
- `/api/find` corrects a one-letter slip in a long word (`corrected`) and marks
  the nearest matches `weak` when no tool does the task.
- Receipts, usage, attestations, feedback, refund lookups, monitor links and
  Decide quotes read the same record whichever server instance answers.
- Site pages were checked and fixed for contrast, labels, links and keyboard
  access.

### 2026-10-15
- sanctions-wallet now reads OFAC's full SDN XML export. Since it launched
  on 2026-09-12 it read the CSV export, which cuts long entries short: it saw
  about half of the published digital currency addresses, and some Tron,
  Dogecoin and other case-sensitive addresses were stored in the wrong case.
  An address in either group could have been answered as not listed. Every
  published address is now matched exactly as listed.
- Search and routing (/api/find, /api/route and the MCP catalog tools) bound
  every uncached search with a deadline and recover on their own if one
  stalls; under load they answer 503 with Retry-After instead of hanging.
- Every published npm package retries a discovery read that answers 503 with
  a retry delay, a few times and briefly, and never repeats a paid call.
- Data tools that wait on an outside service answer 503 naming the service
  and the step when it does not answer in time, and nothing is charged.

## v2.6.0 - 2026-10-08

### 2026-10-08
- Slow routes (reports, video, the premium image, `/api/decide/execute`)
  accept `Prefer: respond-async` on a paid call: it answers `202` with a job
  link at once, and `GET /api/jobs/{id}` (free) returns the answer when it is
  ready. Payment still settles only on a delivered answer; a failed run is not
  charged. Each of these routes now states how long it can take.
- An `Idempotency-Key` call sent again while the first copy is still running
  gets `409` with `Retry-After` and does not run; a retry after the first
  finishes replays its answer.
- On the chat wires, a model provider that refuses the request itself (for
  example a model with no endpoint for the request's tools) answers `400` with
  the reason instead of `502`, after failover has tried the next model.
- The free SEC company pages show three years of revenue, net income and
  total assets from each 10-K, twelve months of filing activity with the
  reasons for each 8-K, and recent filings; insider pages total the
  open-market flow they show, and fund pages show ten holdings and their
  concentration.
- agent402-mcp 0.13.11 lists `route_and_execute` as `router.execute` (the old
  name still works), and both MCP Docker images include every file the server
  loads.
- The README names the free seller listing at `/sell` near the top.
- A cached repeat on `/v1/embeddings`, `/v1/rerank` or an opted-in chat
  tier is served only to a request that carries a payment, and that payment
  is not charged (x402, card, credits, and Tempo payments the server sends;
  a Tempo transfer the buyer sends before the call is final when sent). A
  request with no payment gets the route's 402.
- `/v1/judge` falls back to OpenAI's Decisions API (`gpt-6-luna`) when Jev is
  unavailable; `model` names which one answers first (default `jev-latest`),
  the answer names the model that served, and `fallbackFrom` says when the
  first was unavailable. The answer shape is unchanged.
- Add `POST /v1/decisions`: OpenAI's Decisions wire, so an OpenAI SDK pointed
  here calls `decisions.create` unchanged and pays per call. Text input;
  `gpt-6-luna` answers first, with Jev as the fallback (`fallback_from`).
- MPP on Tempo: the gate can read the chain for a payment alongside the
  relay (`TEMPO_EARLY_CONFIRM=on`, off by default), and the settle log
  records what that read saw.
- Terms: a "Results from other sellers" paragraph states that Agent402 buys
  such results for its own account and sells them to you.
- Copy states plainly that the router and `/api/decide/execute` buy results
  from outside sellers and resell them; packages agent402-mcp 0.13.10 and
  agent402-openclaw 0.5.1 carry the same wording.
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
- `exa-contents` is repriced to its largest accepted input.
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
- Move `stock-quote` and `stock-history` onto a licensed equities feed: per-venue
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
