# Changelog

All notable user-facing changes to the Agent402 server and site. Package
releases are listed under the server version they shipped with; each package
carries its own version on npm.

## Unreleased

### 2026-11-13 (payment and input hardening)
Tools:
- Transcription measures each file's length by decoding it before any upstream
  call. WMA, raw AAC, AMR and CAF recordings are read and sent as FLAC, an
  MP4, MKV, WebM or Ogg file holding several audio tracks is measured and sent
  as its first track, and AAC behind an ID3 tag, an MP3 with leading padding
  and an Ogg file sent under another format's name are read too. A PCM WAV
  whose size alone keeps it inside the cap is sent without a decode, and a
  call that finds the decoder busy waits its turn inside the time its payment
  allows, or is answered a retryable 503 at once when the queue for the
  decoder is full. A refusal says nothing was charged on a call to the route
  itself, in the wording that names the Tempo push exception, and not inside a
  skill-pack step.
- A file sent for transcription whose length cannot be confirmed is
  transcribed up to its tier's cap, and the answer says so in
  trimmedToCapSeconds and durationUnconfirmed; both fields are in the output
  schemas.
- Large images sent to image-ocr wait their turn per caller, a step run by a
  decision, by route-execute or by a skill pack included, so one caller's run
  of large images cannot hold every place in the queue. The caller is the
  verified payer, else the client address. A refusal says nothing was charged
  on a call to the route itself only.
- Transcription measures and cuts each file by the audio samples it decodes,
  not by the timestamps its container writes, and a file sent as it came is
  uploaded under the name of the format it was measured as.
- openapi-resolve-refs resolves long chains of refs, deeply nested documents
  and long pointers inside cyclic refs in time proportional to their size, and
  a cycle reached from many top-level keys once. A spec whose refs inside a
  cycle take more than 1.5 million steps to resolve is refused with a 400
  that says to resolve it in parts.
- route-execute does not resell a 200 a seller sent without taking payment
  when its body is empty or blank, an empty list, an error sent as text, or
  text, a list or a bare value where the seller promised JSON fields; the next
  seller is tried. A paid answer that is not JSON on a route that promised
  JSON fields counts as a missed promise in the seller's delivery record. A
  paid answer longer than the router reads is judged on the JSON document it
  closed, and one that cannot be read that way is counted as unverifiable in
  the delivery record and the seller dossier.
- Report kits remove bracket runs from quoted source text across combining
  marks, blanks, control characters and the compatibility forms of each
  bracket.
- The router judges read each listing as quoted data: one JSON object per
  listing with every line break escaped, under a rule that a speaker label or
  instruction inside it is the seller's text. The listing text they read drops
  a sentence opened by a role marker behind markdown list, heading or emphasis
  marks, a closing brace, a lookalike colon, a guillemet or an arrow, and
  /api/route's judge reads the same screened text as route-execute's, with a
  price label formatted from the parsed price. The paywall probe's judge reads
  a route's answer as one quoted JSON string.
- /api/route ranks with the same order as before in steps, so a ranking
  query hands the server back between slices while it sorts.
Payments:
- A paid answer whose connection closed after its headers went out is kept
  under its idempotency key, so a retry with the same key, a prepaid credits
  key included, replays it instead of running and being debited again.
- A subscription whose first payment settled while its record was not written
  is rebuilt once when the same credential returns: its first period is booked
  once, and a cancel recorded meanwhile is kept.
- A refused Tempo push transfer is recorded as owed before its credential is
  released, so a retry with the same credential finds the debt.
- While many /v1 payments fail to settle across the service, only a wallet
  that has never settled a payment is held after one payment refused for its
  own reason, and the 429 says why; a wallet that has ever paid is served as
  before, a caller with no proven wallet keeps the usual count, a failure of
  unknown cause keeps its usual count, and settlements that fail for an
  unknown cause or are counted against an address or a credits key never
  start that bound.
- One signed EVM authorization whose settlement keeps failing for the buyer's
  reason is refused on its own, and a new authorization from the same wallet
  is served at once.
- One EVM authorization holds one claim on a server without a shared store,
  whatever unsigned network fields a copy of its header carries.
Packages:
- The job-link poller follows a redirect only within the server's own origin
  and refuses a redirect to any other origin before reading it, saying so in
  its error. The server-side scripts use it, as do agent402-client 0.8.26 and
  agent402-mcp 0.13.32, whose MCP output schemas also carry the transcription
  fields trimmedToCapSeconds and durationUnconfirmed.
Surfaces:
- MCP connector answers whose indented JSON would pass the size ceiling are
  sent as compact JSON.
- /privacy lists the per-authorization settle-failure count, the list of
  failing payer wallets and the sales-ledger read the settle refusals use.

### 2026-11-13 (model refresh)
Gateway:
- The /v1 chat tiers' defaults move to newer models at the same prices: base
  gpt-6-luna, pro gpt-6.1-terra, premium claude-opus-5.5; the bare claude-opus,
  claude-haiku and x-ai/grok names serve opus-5.5, haiku-5.5 and grok-4.7. Every
  replaced model id is still served when a call names it.
- Nano admits claude-haiku-5.5 and deepseek-v4.1-flash; qwen3.8-flash joins
  base, auto, grounded and metered, and takes a rung in auto's fast code
  ranking; pro admits gemini-3.8-flash and gemini-4-argon; premium admits
  gemini-4-argon and claude-fable-5.2.
- A tier serves its own default when a call names it, at that tier's price,
  and /v1/models lists it under that tier: gpt-6-luna named on base is served
  on base, on the chat, Messages and Responses wires.
- /api/llm and /api/llm-pro default to gpt-6-luna. A call there that names no
  model is served without the temperature and top_p it sends, and the answer
  names them in agent402_params_not_sent.
- Image tiers render on gpt-image-2.6 flare and sunburst. A one-link image edit
  route's refusal no longer names an empty failover.
- Gateway examples name models each tier serves at its own price: base its
  default, gpt-6-luna; the /v1/pro tier gpt-6.1-terra.
Speech:
- TTS (/api/tts, /api/tts-hd): Voxtral TTS 3 joins the backups behind Voxtral
  Mini, same voices.
Judgment:
- /v1/judge and /v1/decisions add Gemini Decision-1 and the same pinned Jev
  version over OpenRouter as fallbacks. The discovery reranker, wish
  classification and the decide planner ask that Jev version over OpenRouter
  before Decision-1. Decisions requests carry a no-data-collection preference,
  and zero data retention where every endpoint offers it.
- /v1/judge, /v1/judge/vision, /locate and /long keep the other answers when a
  noul has no probability, marked noProbability: true; an answer with none stays
  an uncharged 502.
Search:
- Neural search sends the legacy fast and instant types as lite and says so, and
  passes upstream warnings and notices through, screened of hidden characters.
- /api/route scores our own rows without their attribution sentences, as
  /api/find and catalog search do.
Server:
- /privacy says route, decide and demand-board text can also reach judgment
  models over OpenRouter.
- The web framework takes its November security release.
- /health stays 200 while a state database write waits for its retry; the
  stateDb status word reports the outage.
- cve-lookup waits up to 25 s for the NVD record read, which now takes
  several seconds; the EPSS and KEV reads keep 10 s.

### 2026-11-13 (image header bound)
Server:
- The TIFF header reader bounds every tag's declared value count by the file
  size, whatever the tag's type.

### 2026-11-12 (Bazaar listings)
Payments:
- Every route's Bazaar listing carries a service name, five tags led by its
  category, a PNG icon, a description, and input and output schemas; the
  typed-judgment routes keep their whole description and judge's model list
  beside a link to the full sample answer.
- Descriptions keep the sentences around a query hint.
- Every Bazaar listing that serves third-party data ends with the attribution
  that source requires (FRED, CoinGecko, Jupiter, OpenStreetMap, Open-Meteo,
  NVD), the skill packs that run those tools included; their skill pages and
  MCP skill files carry the same lines. Catalog search no longer ranks tools
  on these notices.
- A payment signed against the previous release's 402 is accepted when only
  the output schema it echoes differs.
- Output schemas read from examples type numbers as number, so a fractional
  answer always matches its listing.
Server:
- The HTTP adapter used by the MCP connector takes its November security
  release.

### 2026-11-12 (vendor updates: security releases)
Server:
- The HTTP client takes the November undici security release; Stripe calls
  pin their API version; the MPP and Solana libraries take their current
  releases.
- The Railway configuration runbook covers the December 2026 cutover.
- The sanctions list refresh reads the list and builds its address and name
  sets in short slices, so it no longer holds other requests while it runs.
- /api/gateway-status reports xSearchAuthors (a day of X search author reads
  past its alert level) and mppSubscriptions (on, off, or failed to start).

### 2026-11-12 (leftovers: payer keys, lookups, retirements, site polish)
Payments:
- A Solana payment is keyed on its transfer authority when other transfer
  accounts sit in a lookup table, and x402 v1 Solana payments carry a payer key.
- Solana payments are screened on the transfer authority and every required
  signer other than the fee payer, and version 1 transactions are read.
- A router seller that answers 200 without taking payment and returns no answer
  is treated as a failed upstream: the next seller is tried, and if none
  answers the buyer is not charged on x402 (a Tempo push payment is recorded
  as owed and refunded).
- The proof that an EVM authorization went unused reads chain time, not the
  host clock.
- Bazaar service names end on a whole word and stay distinct per tier; the
  OpenAI-compatible image and transcription routes are named "Image gen" and
  "Transcribe".
Server:
- Outbound tools resolve hostnames without the shared thread pool, so a name
  that never answers no longer delays other lookups; a name server that refuses
  a query falls back to the system resolver once; every resolved address is
  checked before a fetch, rendered pages included.
- The LLM tiers advertise the successors of the OpenAI models retiring
  2026-12-11; the retiring ids are still accepted.
- /api/llm-premium's refusal lists every model family it accepts.
- The insider, LinkedIn article and IPO reports fence the filer- and
  publisher-written text they read.
- Daily upstream ceilings no longer count a call the upstream refused.
- /mcp and the revenue view redact secrets from error text, including keys
  split across lines, cut short, or written as bare hex; transaction hashes
  stay readable.
- Six more status words page on their alarm values.
- The tollbooth Docker image runs on Node 22.23.5 as a non-root user; a replay
  store in /var/lib/tollbooth or on a mounted volume, written by an older
  image, is handed to that user at boot.
Site:
- Every code block on the site has the shared copy button.
- /company form fields use the control border; tool page breadcrumbs keep their
  spacing; wrap fixes on /docs, /tools and tool pages.
- /llms.txt is shorter; route descriptions for the MPP start routes moved to
  /llms-full.txt.
- /transparency prints its own last-updated date.
- /privacy names the paying wallet of a Solana payment (the transfer's
  authority) beside its signers.

### 2026-11-12 (home page and company contacts)
Site:
- The home page shows Agent402's own figures (uptime, external payments,
  chains, latency) under the pitch, beside the live view, so the hero no longer
  leaves open space above the headline.
- /company lists the operator mailbox once, with the roles it answers, and the
  page footer links to contact instead of printing the address.

### 2026-11-11 (Node security release)
Server:
- The server, facilitator, worker and MCP images run on Node 22.23.5, the
  November 2026 Node.js security release.

### 2026-11-11 (buyer scorecard, trust page and one story)
Site:
- /scorecard and GET /api/scorecard publish monthly buyer counts: outside
  paying wallets, returning wallets, wallets with paid calls on two or more
  days, and settled calls and USD by chain, for the current month to date and
  the six before. Our own wallets and internal traffic are not counted; small
  counts read <3.
- /trust gathers subprocessors, encryption, incident response and restore
  testing on one page; /company lists the business phone, postal address and
  role mailboxes.
- The home page hero shows uptime, external payments, the chains live and
  median latency, rendered on the server. The site navigation adds Pricing,
  Company and Status and one primary action, Add to your agent.
- One lead sentence describes Agent402 on the home page, README, llms.txt, the
  MCP connector and the package READMEs in the repository.
- Design: form controls share one border token, every control shows a 2px
  focus ring, pages open with a skip link, prose reads at 16px, small targets
  are at least 24px, and code blocks share one component with a copy button.
Payments:
- GET /api/refunds?tx=<hash> looks up a refund by settlement transaction, with
  found, priceUsd and txUrl fields; the /api/refunds/lookup path answers the
  same lookup.
- The /v1 settle breaker keys a Solana, Algorand or Stellar payment by its
  signed payer.
Surfaces:
- /api/gateway-status carries onchainSqlBusy (ok, alert, unknown or off):
  alert while a top paying buyer was recently told the onchain query service
  is busy. Busy refusals are counted per day on the operator views; the query
  limit is unchanged.

### 2026-11-11 (whose side failed, settle verdicts and rail reasons)
Payments:
- A paid /v1 call whose settlement failed counts toward the paying wallet's
  settle refusal only when the failure is a verdict on that payment: too
  little of the asset, a bad signature, an authorization already used or
  expired, or a refused payload. A timeout, a store failure or a facilitator
  error on our side does not count against the wallet. Settlements of unknown
  cause refuse the wallet only at three times that count, and that answer says
  only that settlement did not complete.
- A facilitator's definite 4xx answer to a settlement is no longer read as a
  settlement that did not complete. A settlement answer of 4xx that names no
  reason (other than 401, 403, 408 or 429) counts as unknown cause.
- A payment whose verification could not be completed (a timeout, a connection
  that failed, a facilitator 5xx, 408 or 429, or an on-chain signature check
  that could not finish) answers reason not-checked with retry same-payment
  and Retry-After 5, before any other reading of the error: nothing was
  charged, and the same payment can be sent again.
- On Tempo with direct chain reads (TEMPO_RELAY=off), a payment our server
  could not read on chain answers 503 with reason chain-unreachable: the
  credential was not checked, and the same credential can be sent again. This
  server keeps listing Tempo first in the payment challenges it sends that
  client. A push credential (a transfer already sent) that could not be
  checked this way, because the payment relay could not be reached, or because
  the shared payment store did not answer, is told its transfer has not been
  claimed and, once final, still pays for the request.
- /api/rails gives each payment network left off at startup a reason word
  (probe-timeout, read-failed, not-advertised or config) and, while the
  batched option is on, its status and the networks it dropped. The startup
  read of each facilitator takes up to three tries when it times out and two
  when it answers with an error.
Router:
- The seller index keeps a seller routable when our own read of it fails (our
  time limit, our resolver, our byte cap, our own network path) and its last
  completed crawl succeeded within 6 hours; a connection the seller's host
  refused, reset or failed TLS on is the seller's own answer. ?seller= and the
  index rows carry lastReadIncomplete and errorKind, the seller dossier says
  our read did not complete, and a paywall probe that read no status records
  no verdict.
- The seller index backs off a seller whose host refuses connections and stops
  routing to it.
- Route-and-execute stops buying from a seller that takes payment and then
  fails. It counts one delivery strike per payer and distinct request, and the
  same request from the same payer counts again at its third failure; a
  seller's 500 whose body names the request's own input is not a strike. No
  refusal is noted against a seller for a payment method our buyer cannot
  make, for a challenge that differs only in the caller's query, or for a
  validity window we shortened.
- A seller's payment count read on Algorand or Solana that did not complete
  reads unknown, never zero.
Tools:
- A tool error names an upstream as failing only when that upstream answered
  so. Our own read limit, a call budget spent before any request was sent, our
  DNS lookup, our own key, allowance or request pacing, and our own internal
  errors say they are ours; an input long enough to outlast the limit is told
  to send a shorter one, and a caller's URL that did not answer is told to
  check it or retry. The hosted connector's free answers read the same.
- A seller or tool host whose name does not resolve reads attribution unknown
  and counts toward upstream health; only a lookup our resolver could not
  finish is ours.
- When a provider refuses this server's own key, image generation, embeddings,
  moderation, text generation and the model gateway say the failure is on our
  side.
- The onchain query health check keeps a failing reading for one minute, then
  reads the service again.
- Stock quotes keep reading the consolidated dataset after a single 400 answer
  (400s for two different symbols or a symbol and the range read inside the
  skip window, or one 401 or 403, still switch to the three-venue dataset),
  and the three-venue note says the consolidated dataset was unavailable only
  when it answered so for that read.
- Text to speech keeps its primary voices when long texts reach our own time
  limit; later callers move to the backup voices when the primary link stops
  answering for several callers. Model calls on the direct upstream link move
  to the fallback route on the upstream's own answers, not on our timeout or
  DNS failure.
- Text to speech and model calls on the direct upstream link move even a
  single caller to the backup after three unanswered short requests.
- The GPT Image tools (image-gen, image-gen-hd and image-gen-premium) send the
  provider's less restrictive content filter level by default (send moderation
  "auto" for stricter filtering; a model that does not take the setting runs
  at the provider's standard level), and a prompt the model's content check
  refuses gets a plain 400, not charged on x402.
- Image generation sends one request instead of two to a model that does not
  take the moderation setting.
Surfaces:
- /api/gateway-status carries topBuyerFailures (ok, alert, unknown or off);
  upstreamHealth reads unanswered when one upstream did not answer within our
  limit for several callers while others answered, and facilitatorFunds reads
  unknown when a settlement signer's balance could not be read, with alert
  sustained once that has held past FACILITATOR_UNREAD_PAGE_HOURS (default 6).
- The upstreamHealth word also reads unanswered for an upstream that answered
  none of its calls with one caller or background work alone.

### 2026-11-11 (spend alarm, funding refusals and connector answers)
Gateway:
- A call naming qwen/qwen-2.5-7b-instruct, which has left the upstream model
  list, is served on the nano, base or metered tier by
  mistralai/ministral-8b-2512, the swap named in agent402_model_substituted.
  The generateContent routes carry agent402_model_substituted for a retired id
  and for an availability successor, as the chat, Messages and Responses
  routes do.
- The upstream lists an expiration of 2026-11-20 for
  meta-llama/llama-3.2-1b-instruct. A call naming it is served as itself until
  that day, then by meta-llama/llama-3.2-3b-instruct at the tier and price of
  the route called, the swap named in agent402_model_substituted.
- Each metered route's tool page, /pricing, /docs, the buying-at-volume,
  agent-hosts and OpenClaw provider guides, the README and the
  Buying-at-Volume wiki page state the client timeout to set, and a metered
  route's first-contact 402 body carries it as clientTimeout (seconds, note).
Payments:
- A payment refused because the paying wallet holds too little of the asset,
  or no account for it (no USDC account on Solana, no trustline on Stellar,
  not opted in on Algorand), says so on EVM, Solana, Stellar and Algorand: the
  refusal carries reason (insufficient-funds or no-token-account), a sentence
  with the price and the chain's name, and a needs field with the network,
  asset, base-unit amount and dollars. Stellar amounts are read at 7 decimals.
- A payment refused in simulation on a network whose balance the server does
  not read (every network but Base, and Base when the read fails) names the
  chain and the price and says it is one of two things: the paying wallet
  holds less of the asset than the price, or the authorization's nonce was
  already spent or its validity window has passed. It no longer says the
  wallet covers the price.
- A payment network left off the offer because its facilitator could not be
  read when the server started rejoins on its own once that facilitator lists
  it: every 402, /api/rails, /.well-known/x402, /api/pricing and /openapi.json
  follow. Arc, and the upto and batched accepts on a rejoined network, return
  on the next restart.
- A settled payment's replay mark is kept about an hour after the call, or
  until the authorization's own validBefore plus 10 minutes when that is
  later, at most 30 days after the call. The privacy page and the readsOnly
  list under payment.dataHandling on /.well-known/x402 state the same hold.
- The log line written for a refused payment names the network, the route and
  the paying address by its first characters, and shortens the paying address
  where the facilitator's own text repeats it (an EVM address in any letter
  case, any other address as written). Other payment log lines name a paying
  address by its first characters too, except a line written when a payment
  that may be owed back could not be recorded anywhere else, which keeps the
  full address so the payment can be returned. The privacy page says so.
- A card report page keeps answering while the card processor is slow: a poll
  waits up to 8 seconds, then answers generating, and the report starts as
  soon as the payment is confirmed, with no further poll needed. A poll for a
  refund still being sent answers within the same wait, with the refund shown
  as being processed.
- A refused payment credential sent again as soon as its 402 arrives gets that
  402 and its retry hint again, not a 409.
Router:
- Route-and-execute keeps buying for paying callers through a busy minute. The
  per-minute spend ceiling is an alarm: past it purchases are still made and
  routerSpendWindow on /api/gateway-status reads over (its words are ok, over,
  capped and off). A purchase is refused only at a hard stop above the alarm,
  where the word reads capped.
Tools:
- An attest or feedback call made right after a purchase finds that purchase
  while its ledger write is still landing: the lookup waits up to 5 seconds
  for the write.
- The transcription duration caps hold the audio a file plays: the audio is
  decoded on the server and its length read, and the cap applies to the longer
  of that and the duration the file's headers declare. A file the server
  cannot decode is held to the shortest length its byte count can play when it
  is lossy audio-only in one or two channels at a sample rate of 48 kHz or
  less; any other file (a lossless one, one with a video track, more than two
  channels, a higher sample rate or no reported sample rate) keeps its
  declared length.
- The domain audit and token risk reports (model-backed) pass the records they
  read (DNS, header and certificate values, registration text, token names,
  symbols and labels, web reputation text) to the model as quoted data, with
  the rule to describe them and never follow them.
- The daily call ceilings on upstream services count calls that may have
  reached the upstream. A call that never left the server (a name that did not
  resolve, a refused connection, a call its caller had canceled before it was
  made) gives its unit back.
Surfaces:
- The hosted connector sends Retry-After on its 429, and its free-tier
  rate-limit answer says in how many seconds there is room again. A free
  answer over the connector's size ceiling is cut to valid JSON and says what
  was cut in answerBound (unit, maxBytes, returned, matched, complete,
  truncated, cuts, cutsListed, cutsTotal); a paid answer is delivered whole.
  catalog.search takes a limit of 1 to 25 (10 when the limit is missing or
  zero); a value outside that range is clamped to it. Tools that can charge
  (every flagship, catalog.call) are not marked read-only; catalog.search,
  catalog.find, sellers.list, server.describe and payment.info are.
  memory.write is marked destructive, since it replaces the value a key held.
- The page of a retired tool or skill pack answers 410 with its retirement
  date and, where there is one, a link to the replacement's page, as its API
  route does.
- /status says when a component's last observation is stale and how old it is.
  Its two observers are named Scheduled heartbeat and Outside probe on the page,
  in its method notes and in /api/status.
- A request the HTTP parser refuses (a malformed request line or header, a
  header block over the size limit, a request that never finished arriving) is
  answered with the X-Content-Type-Options, Referrer-Policy and
  Strict-Transport-Security headers every other answer carries.
- The home page's live figures give up a read that stalls for 8 seconds and
  keep the values they last showed.
- The 429 from a direct proof-of-work redemption carries Retry-After, the
  seconds until there is room again.

### 2026-11-10 (wire parity and payment answers)
Gateway:
- A byte-identical paid repeat on /v1/embeddings, /v1/rerank and cache:true
  chat is served from the payer's cache when paid with the standard x402 v2
  client; from 2026-11-06 those repeats were generated and charged again.
- A metered body that cannot be served (an unlisted model id, an input over
  the model's cap) answers 400 before any payment requirement on the Messages,
  Responses and generateContent routes, as it does on chat completions, each
  in the error shape its own SDK parses.
- The Messages and Responses routes answer an unlisted metered model id with
  400 (code unknown_model, with suggestions), and an input over the cap names
  the calling wire's own routes.
- A buffered Messages or Responses call whose provider refuses the request
  answers 400 naming the model, as chat completions and every streamed call
  do; it had answered 502.
- On the chat, Messages and Responses routes a reasoning effort above low is
  sent as low when the output cap is under the tier's default output budget,
  and a reasoning or thinking budget is lowered to leave a quarter of the cap
  for the answer. An answer that came back empty for length gets one more run
  on the same model at its lowest effort when the price covers another run and
  the payment window allows. The answer names the change in
  agent402_reasoning_adjusted (a response header on a stream); the quote reads
  the buyer's own values.
- The metered routes advise a client timeout of at least 120 s on llms.txt,
  llms-full.txt, openapi, the home page, SKILL.md, the x402 guide, a flat
  tier's 402, the connector's server.describe and payment.info answers and the
  LLM-Gateway wiki page: the answer is generated and the payment settled
  before the response is sent, and a charge for an answer the client did not
  wait for is recorded as owed and reviewed for a refund.
- An EVM wallet's repeated settle failures on the /v1 routes are counted per
  network the payment named, so its 429 holds that network only and carries
  retry, refusedNetwork, retryAfterSeconds and otherNetworksFrom. A burst of
  settle failures across buyers refuses nobody; it reads as a status word
  (settleFailures, unsettledReports: ok or burst) on /api/gateway-status.
- The settleFailures status word also reads burst when one EVM wallet's
  unsettled /v1 calls reach the per-network refusing count on three networks
  inside one window. The word refuses nothing: the wallet is held per network
  as before, and no other buyer is.
Payments:
- A first-contact 402 body carries a payment block: this request's price in
  dollars on the network it names, one sentence on paying, the proof-of-work
  path on a free-tier tool, the caller's own model, request size and output
  cap on a body-quoted route, and links to /llms.txt, the pay section of
  /agents.md and the connector. The header and every other field are
  unchanged; a self-hosted server removes the block with
  PAYMENT_GUIDE_402=off.
- A tool call sent with conditional or range request headers (If-None-Match,
  If-Modified-Since, If-Match, If-Unmodified-Since, If-Range, Range) answers a
  full 200 on every rail and in free mode. Free documents keep their 304.
- A route quoted per request prints one from price on /api/pricing,
  /openapi.json, its tool page and llms-full.txt: the smallest amount its 402
  can ask. Decide reads its quick depth there.
- The paying wallet of an MPP monitor subscription is screened before its
  first payment and before each renewal, as per-call payers are. A refused
  first payment answers the Tempo rail's 402 and nothing is sent; a refused
  renewal is not sent and ends the subscription with the reason
  payer-not-accepted on its status answer.
- An MPP subscription's signing key is deleted when the subscription is
  canceled or ends. The ended record is reduced to its id, product, payment
  rail and wire, a flag for one of our own test subscriptions, wallet, key
  address, chain, currency, amount, period, dates, final state, cancel reason,
  last transaction and a marker for a charge that was never confirmed, and
  deleted 30 days after the end.
- The card report route generates, records and refunds only for a paid
  Checkout session that names a report product; any other session answers
  invalid. A report whose product left sale after the purchase is still
  refunded, and an owed card refund is retried and counted in refundsOwed only
  when it belongs to a report purchase.
Router:
- When a seller refuses route-and-execute's paid request as invalid input and
  the caller's params lack body fields the seller's published request contract
  requires, the answer is 400 naming those fields; it had been a 502.
- One deadline bounds a seller purchase across its requests: a signed payment
  is not sent or resent past it, and route-and-execute answers 504, with
  nothing spent and nothing charged, when a candidate would start with too
  little time left.
- A refused Solana purchase releases its hold only when the finalized block
  height read from our own RPC is past the blockhash's last valid height and a
  debit scan shows nothing; an unreadable height keeps the hold.
- A purchase is recorded when its payment is signed, at the address the signed
  payment names, and the record is taken back only when the payment provably
  moved nothing. A listed route whose text joins to a URL outside its seller's
  key is not ranked.
- A Tempo purchase refused before signing names a seller-supplied value
  (currency, chain id, method, intent) only when it has the shape of a token
  address, a number or a short identifier, and in fixed wording otherwise.
- /api/find ranks a tool named for the opposite conversion direction (the task
  says X to Y, the tool is Y to X) below every other match and marks the row
  reversed: true. When no tool states the direction asked for and the top
  result does not mention both ends, the answer carries direction.served:
  false with the miss hint. catalog.find on the connector passes the same
  fields.
- A seller tool name longer than 10 words does not score as a slug alias, so a
  sentence in the name field does not outrank a tool named for the task.
- The two per-client 429s on /api/find and /api/route name their rule and say
  that tool calls, paid or proof-of-work, are not counted against the search
  limit.
Tools:
- A transcription call whose upstream answers a 5xx, a rate limit naming a
  wait of at most three seconds, or a failed connection gets one more attempt
  on the same model inside the time cap the call already had, when at least
  20 s of it remain. A served second attempt carries agent402_retried
  {attempts, reason}; a 5xx on a route call says nothing was charged and names
  the other transcription path.
- Markdown-to-html gives a document in its ordinary lane 1 s to render; past
  it the document starts again in the lane for slow documents under that
  lane's deadline. Waiting in the ordinary lane is fair by client address: the
  caller with the least render time used goes next, and one address holds at
  most 128 places.
- The PDF, image, HTML, regex, markdown and office parser workers start with
  an allowlisted environment.
- Exa-search, exa-answer, exa-contents and the X data tools keep serving past
  their daily alarm ceiling, where exaSpend and xDataSpend on
  /api/gateway-status read over; at a higher hard ceiling a call answers 503
  and the word reads capped. Each word is read from the day's count shared
  across containers, so it keeps its reading through a restart, and it reads
  capped for an hour after any call is refused at the hard ceiling.
Operations:
- /status and /api/status list each observer of the paid call path with its
  own state, age and staleness bound (current.sources); an observer past its
  bound reads not current beside the one the component's word comes from.
- On /api/gateway-status, sharedLimits and replayStore carry a second word,
  alert, that reads sustained once the first has held ten minutes without a
  break, and backup.status reads unconfigured in production with a state
  database and no backup bucket. The status Worker and the heartbeat page on
  these and on gatewayBalance.
- Call-log rows older than TOOL_CALLS_RETENTION_DAYS (default 180, never under
  31) are deleted daily; the URL tools (extract, meta, dns, render,
  screenshot, pdf) and the memory routes write one call-log row per call.
- A second merge to main queues behind a running release instead of canceling
  it, and the deploy, publish and probe jobs carry time bounds.
- Timing checks in the test suite read the thread's own time or counted work,
  so a busy runner does not fail them.
Surfaces:
- Pack and report copy names the data each product reports: the storefront's
  fund card is headed by a fund's 13F holdings, and the macro packs name the
  series, its source and its as-of date. Card report copy says the charge is
  taken at checkout, and llms.txt offers decide-execute for a wallet payment
  only.
- Every page that describes a failed call as not charged carries the same
  late-settle exception.
Privacy:
- /privacy and /terms list how long an async job's or MCP task's result is
  kept, the screening of subscription payers, the reduced record of an ended
  MPP subscription, and the daily count of searches the free search routes
  turned away.
Docs:
- The buying-at-volume guide and wiki page state the metered pre-payment
  refusals for every wire, and the LLM-Gateway wiki page states the
  provider-refusal 400 for every wire; Self-Hosting documents the payTo
  variables and BASE_URL; every markdown install line pins the agent402-mcp
  version.

### 2026-11-09 (tool and payment bounds)
Tools:
- Image-crop and image-dominant-color decode in the image worker pool, like
  image-resize, image-convert and image-thumbnail, with a 15 s deadline; a
  busy pool answers 503 and nothing is charged.
- The image tools read each format's header the way its decoder does (a GIF's
  first frame and its codes, a PNG's chunk list, a JPEG's frame headers, a
  TIFF's directories) and answer 400, naming what was wrong, when a file's
  header and contents disagree. An interlaced PNG is inflated under a bound
  for its declared size. A TIFF decodes from its first image; a CCITT fax page
  decodes in an isolated process. TIFF compressions 9 and 34316 are not
  decoded.
- Business-days counts by arithmetic, so a range of any length answers at
  once.
- Markdown-to-html renders every document with the same heading ids as before;
  documents over 2,500 characters render in a dedicated worker with a 10 s
  render deadline (400 when the document's markers are the cause, 503
  otherwise, never charged).
- Json-to-csv writes large sheets in slices and serves up to 10,000,000 cells
  or 16 MB of CSV; a larger sheet is refused with its row and column counts
  and how to split it.
- Openapi-resolve-refs reuses resolved schemas and serves up to 16 MB; a
  larger result answers 413 and says to resolve the spec in parts.
- A proof-of-work tool whose input holds a value that cannot be coerced
  answers 400 with the field named; other errors are unchanged.
Payments:
- A payment that settles a signed transaction (Solana, Algorand, Stellar) is
  identified by that transaction alone, and a Permit2 payment by its signed
  permit, for retries, payer attribution and payer screening; an authorization
  block no signature covers is removed from the header before anything reads
  it.
Router:
- Seller-written names and descriptions are cleaned of markdown links and
  images in a single pass, in time linear in their length.
- Route-and-execute names no paying chain for a payment header that names two
  different networks, and answers its ordinary refusal.
- A registry-only listing larger than the per-seller tool cap is cut to the
  cap before the crawl's passes run; stored tools and reported totals are
  unchanged.
Site:
- Pinned install commands such as agent402-mcp@0.13.31 arrive intact in page
  HTML for readers that run no script.

### 2026-11-08 (buying at volume)
Docs:
- A buying-at-volume guide (/guides/buying-at-volume, wiki page
  Buying-at-Volume) for agents that buy in bursts: the per-address limits and
  their Retry-After, retries that never pay twice, async jobs, spend caps in
  agent402-client, agent402-mcp and agent402-openclaw, which rails settle when,
  metered model ids and input caps, and the errors to handle. llms.txt and the
  three package pages link it.
- The /v1/metered unpaid-quote 429 carries Retry-After: 60, retryAfterSeconds
  and a guide link.
- Once a client address has paid (a final 200 that settled on any rail, or a
  credits debit), its unpaid price checks read against 10 times the hourly
  figure for the rest of that clock hour and for 10 minutes after each paid
  call; past the plain /v1/metered quote figure, each paid /v1/metered call
  from that address earns 2 more quotes, used within 10 minutes, up to 10
  times each figure; on the shared Worker egress address the whole address
  keeps its ceiling; a refused payment credential still counts.
- A content-pipeline guide (/guides/content-pipeline, wiki page
  Content-Pipeline): research, script, voiceover, images, transcription,
  subtitles, dubbing and media checks as paid calls from one wallet, with a
  runnable example per stage, an end-to-end flow, the stages that run as jobs,
  spend caps and Tempo pull and push. llms.txt and the buying-at-volume guide
  link it.
- inception/mercury-2.5 reached its upstream expiration and is no longer
  listed; a call naming it is served by google/gemini-3.1-flash-lite with the
  swap named.
Payments:
- A resend of a payment whose answer was charged but never delivered gets a
  503 (replay_pending, Retry-After: 10) while the ledger has not yet confirmed
  that answer as served; nothing more is charged, and a retry with the same
  payment receives it.
- When the Tempo relay does not answer whether it claimed a push transfer, the
  503 says so (transferClaimed: null); when the ledger records the transfer as
  owed, the 503 also carries refundOwed: true, and a retry with the same
  credential that pays for the request voids that debt.
- A Tempo pull payment answered 402 after its broadcast failed is read on chain
  again (by default 15 s, 45 s and 2 minutes later); a transfer that lands
  after the 402 is booked as owed, to be refunded.
- A keyed call whose client closes its connection keeps its claim until the
  run ends, so a retry with the same key gets 409 idempotent_request_in_flight,
  then the stored answer, never a second run.
- A credits call whose client leaves after the response headers is decided
  when the response ends: a response of 400 or above, a replay or a cache hit
  is not debited, and a metered call is debited its metered amount, never the
  whole hold.
- A card subscription status event that arrives late never reactivates a
  canceled subscription.
- Refund recipients are screened like every payout; a held refund logs a
  fixed reason and stays owed.
Tools:
- The company-dossier and financial-research packs return 90 days of Form 4
  insider trades; their insider step had been read at the 30-day default.
- wallet-audit looks up metadata for a token the wallet holds, not for the
  wallet address; a wallet holding no tokens gets a 422 on that step.
- Report products, the image edit route and the subtitle-pipeline and
  search-and-cite packs say model-backed in their descriptions.
Router:
- A seller's 402 must name the URL requested (the same origin, the same path
  or the route mounted under a path prefix, and the same query); one naming
  another resource is refused before anything is signed.
- A GET seller is probed at its bare listing URL first; while candidates are
  compared, the caller's inputs reach one only when that probe answers 400 or
  422.
- Algorand sellers are paid only at the address their settlement proof names.
- When several proven sellers on one chain refuse our payments with no settle
  between them, routes on that chain are not benched until a payment there
  settles.
Site:
- The navigation puts live, status and llms.txt in the menus.
Operations:
- /api/gateway-status reports lateSettlements (ok, near_capacity, full,
  unresolved) for settlements whose outcome was not known when the call was
  answered, and replayStore (ok, pending) while a settled payment's consumed
  mark waits to reach the shared store.
- An operator closes an unresolved late settlement as booked owed, paid (with
  its refund transaction) or dismissed, and each resolution is recorded before
  the entry is dropped; unresolved entries are read on chain again every 6
  hours and close once the chain answers.
- A Tempo pull transaction that lands after its 402 is booked as owed even
  past the per-process watch bound or across a restart: every watch is on
  record, and a one-minute sweep reads any the process did not finish.
- Tempo subscription gas sponsorship has a rolling 24 h ceiling on
  transactions and fees, with a fifth of each held for renewals; past it a
  send is refused before broadcast, and /api/gateway-status reads
  subscriptionFeePayer.ceiling=reached.
Privacy:
- The shared record that an address paid recently is keyed by a keyed hash of
  the address, never the address or a plain hash of it, and expires within the
  hour; /privacy names it.
- /privacy says a candidate seller may receive a request's inputs unpaid
  before it is paid, sometimes more than once.
- /privacy and /.well-known/x402 name the Tempo pull credential kept, with
  its route, amount and payer, until its late-landing check ends (at most 24
  hours while the chain cannot be read).
- /terms says an x402 payment on an EVM chain, or a Tempo transaction, that
  lands on chain after an error answer is recorded as owed and repaid, and that a repayment is checked against the published
  sanctions lists first.

### 2026-11-07 (onchain-sql price, X data tools, Solana token search, metered chat, OCR and fetch errors)
Tools:
- onchain-sql is $0.030 a call (was $0.040), and a call still sends the query
  service at most 3 queries. The onchain-analyst pack follows the tool's
  price.
- x-tweet no longer reads the author: the tweet carries authorId, its author
  username, name and verified fields are null, and its link is the
  /i/web/status form.
- x-user-tweets is $0.09. Looked up by username, the account's profile still
  fills user and each row's author. Looked up by id, the author is not read:
  rows carry authorId, null author fields and the /i/web/status link, and
  user carries the id with null username, name and verified.
- x-search-recent is unchanged.
- sol-token-search finds a Solana token whose ticker is busy on other chains:
  when the pair search holds no matching Solana pair, the mints come from a
  Solana token index (verified first) and their pairs are read by mint. The
  answer says whether that fallback ran, names both sources when it did, and
  carries the partial-answer fields. No pair found while a fallback read did
  not answer is a 5xx, never an empty answer.
- image-ocr answers 422 for a body that is not an image it reads (a PDF, a
  webpage, an SVG), naming what it got and the formats it reads (PNG, JPEG,
  GIF, BMP, TIFF, WebP, PNM), and 422 for an image that does not decode or
  whose header does not give its size, where it answered 500 "OCR failed:
  unknown". An image over 64 megapixels or 32,767 pixels a side is a 422
  (image-too-large) before it is decoded, naming maxMegapixels, maxSide, the
  image's width, height and megapixels, the longest side to downscale to
  (downscaleToLongestSide, also in fix) and a howToCall with a note to resend
  the image downscaled. One image over 16 megapixels is read at a time;
  another waits up to 15 s, then answers 503 (large-image-busy) with
  Retry-After.
- A tool that fetches a URL answers a source host that times out or refuses
  the connection with a 504 carrying attribution "upstream" and the hint
  source-timeout or source-unreachable, so a caller can retry later or pick
  another host.

Gateway:
- A metered model id written with a hyphenated version (v4-1 for v4.1) is
  served as the dotted id when that exact id is on the upstream's live list;
  any other unknown part is still refused. The unknown-model 400 carries
  suggestions (the closest served ids, at most three) and a howToCall that
  retries with the first.
- The metered routes take 200k input chars on every model and more on a model
  with a larger context window (three chars per window token, up to
  1,000,000), each request still quoted from its own body. An input over the
  cap is refused with maxInputChars, inputChars, a trim-input hint and models
  whose window takes it, before payment on /v1/metered/chat/completions.

Operations:
- A /v1/metered/chat/completions input refusal answered before payment is
  logged and counted like a handler 400, marked pre-payment.

### 2026-11-06 (Ink rail)
Payments:
- Ink (chain 57073) is a listed rail: x402 payments settle in native USDC on
  Ink, named on every surface that lists the chains, with its own chain page.
- A chain page links the service's wallet on the chain explorer even before
  the rail's first revenue reading.
Packages:
- The buyer client, MCP server and OpenClaw plugin price and sign Ink USDC
  accepts, and refuse an Ink accept that names another EIP-712 domain than
  the token's own (agent402-client 0.8.25, agent402-mcp 0.13.31,
  agent402-openclaw 0.5.11).

### 2026-11-06 (EVM router chains, call hints, package limits)
Router:
- The router buys from proven sellers on each EVM chain the operator lists,
  with the same price binding, validity cap and spending caps per chain as on
  Base, and each listed chain counts toward the global unsettled-spend
  ceiling.
Agents:
- An input-validation 400 carries howToCall: the method, URL and a ready
  request body from the tool's own example, plus a query-string form where the
  route serves one; the first-contact 402 body carries the same call, or the
  method and URL alone when the example is large.
- A call to a retired tool through catalog.call names its retirement date and
  replacement, as the HTTP route's 410 does.
Payments:
- A cached gateway answer is served only to the payer that settled it, on a
  payment not already used.
- A Stellar refund or settle confirmation counts USDC only from its pinned
  issuer, and a refused settle releases the authorization's claims so the
  buyer can retry.
Packages:
- The buyer client (with an x402Client), MCP server and OpenClaw plugin refuse
  to sign an authorization valid for longer than 24 hours, except the client's
  batched payments, which keep their own limit of seven days and an hour; a
  held amount is released ten minutes after its authorization expires
  (agent402-client 0.8.24, agent402-mcp 0.13.30, agent402-openclaw 0.5.10).
- The MCP server redacts its configured keys from every result, error and log
  line; the OpenClaw proxy removes its credits key from error logs and error
  answers, and its doctor no longer prints it.
- Tollbooth grants a charged request only when its payment middleware took a
  payment; a charged request whose method the middleware does not price is
  answered with a 402, so price every method served (agent402-tollbooth
  0.11.0).
Operations:
- The heartbeat opens one issue when a repository security advisory waits in
  triage for more than a day; the issue names no advisory.
- Retired-route answers are counted by coarse source (client family, referring
  host, payment rail, HTTP or MCP), with no address, wallet or full user agent
  kept.
- The EVM wallet alarm also opens when an enabled chain's balance cannot be
  read for an hour, and the status probe pages on it.

### 2026-11-06 (Stellar settle confirmation)
Payments:
- A Stellar settle that the chain confirms is matched to the payment it
  signed: asset, amount and transaction, and each confirmed transaction
  serves one request.

### 2026-11-06 (router buyer price binding)
Router:
- The router's buyer signs exactly the price it checked against its caps, on
  every challenge version, and refuses a seller accept whose price fields
  disagree; a live quote with disagreeing fields reads as unpriced.

### 2026-11-06 (settler alarm, direct upstream switch, facilitator map)
Payments:
- A payment whose payload declares an x402 version other than the one this
  server offers is answered with the 402 offer instead of being matched.
- Payment headers are read once at intake through one decoder and passed on
  in canonical form, so every check reads the same payment.
- A Stellar payment's signed authorization is claimed before it settles, so
  one signed payment is served once.
- The Tempo buyer pays only challenges whose method details it recognizes.
- MPP subscription renewal reconciliation reads the renewal amount in base
  units and finds a renewal that landed after a timed-out send.
- MPP subscription activation signs with its own 25 s validity window, so a
  timed-out activation cannot land after its answer.
Operations:
- A `subscriptionRenewals` status word reads `unconfirmed` when an MPP
  subscription renewal has stayed unconfirmed for longer than
  `MPP_SUB_UNCONFIRMED_ALERT_HOURS`, and the heartbeat and status Worker page
  on it.
- A `robinhoodSettler` status word reads `relayer` when our own relayer has
  settled Robinhood Chain sales in place of the listed facilitator for longer
  than `ROBINHOOD_RELAYER_FIRST_ALERT_HOURS`, and the heartbeat and status
  Worker page on it.
- The manifest's facilitator map names only chains this server offers.
- A 402 exposes to browsers only the headers it carries, and the MPP charge
  challenge leaves out the output schema the x402 challenge already holds, so
  every 402 stays well inside common header limits.
Gateway:
- An optional direct inference upstream (`DIRECT_UPSTREAM_*`, off unless set)
  serves listed models on the chat wire with zero data retention
  requested on every call, and falls back to the usual route on any failure;
  while it is configured, the privacy page names it under third parties.
Operations:
- The repo's paid buy scripts price offers from a known asset table, sign
  only the amount that passed their cap, and refuse a target outside this
  service unless told otherwise.
Packages:
- viem is 2.57.16.
- agent402-client 0.8.23, agent402-mcp 0.13.29 and agent402-openclaw 0.5.9
  price an offer by the field its challenge version signs, check the signed
  amount before sending, and openclaw removes its per-call cap only with an
  explicit acknowledgment.
- agent402-client and agent402-mcp keep a sent payment's signed amount held
  against their caps until its authorization can no longer settle, and an
  error after sending reports the payment as unknown rather than unpaid.

### 2026-11-05 (Robinhood facilitator order, public-index disclosure, job buys)
Payments:
- On Robinhood Chain the server settles through the first listed facilitator
  whose `/supported` confirms exact at boot, so a primary that does not answer
  then leaves the rail on the next one. A listed facilitator's refusal that is
  not about the buyer's payment moves to the next listed facilitator before
  our own relayer; a refusal about the payment itself is never retried.
Privacy:
- When the facilitator that settles Robinhood Chain publishes settlements on a
  public index (`FACILITATOR_PUBLIC_INDEX_CHAINS`), the privacy page names it
  and what it publishes, the terms, `/.well-known/x402`, llms.txt and the
  Robinhood page point there, and the pages print the date it began.
Operations:
- The operator view of first-call grants counts refusals of wallets that
  never paid by reason and route, apart from returning buyers, so a route a
  newcomer wanted shows up by name.
- Every Playwright install in CI goes through the bounded apt helper
  (`scripts/ci-apt-install.sh --playwright-chromium`), and a guard fails any
  workflow step that runs apt directly.
- The listing pass and the other catalog buy scripts send
  `Prefer: respond-async` to slow routes and follow the job to its answer; a
  failed job counts as a failed buy, and records keep a job's state, never
  its link.

### 2026-11-05 (x402 2.30, a wider unproven lane, one spend workflow)
Payments:
- The x402 libraries are 2.30.0 and mppx 0.17.1. A money or identity check
  that runs before verify or settle and fails refuses the payment with a 402 and charges
  nothing. A Tempo charge whose broadcast is rejected as a replay recovers its
  receipt instead of answering a new 402.
Router:
- On Base an unproven seller is tried up to $0.05 a call (was $0.01), only
  after every proven candidate, paid at its own live 402's payTo, with at most
  $0.25 a day per seller (`SOR_BASE_UNPROVEN_SELLER_DAILY_USD`) and $5 a day
  across all unproven sellers (`SOR_BASE_UNPROVEN_DAILY_USD`).
- Route-execute is graded step by step in CI: 56 fixed tasks run the real
  paid server, resolver and payer against stub sellers and check every step
  from the candidate set to the receipt. The unproven lane reads the same
  verdict as the public label, at the seller's live payTo.
- The lane's terms name only the daily caps that are switched on, and the
  seller-trust and seller-dossier examples show the lane as the tool answers.
- The per-seller cap keys a path-scoped seller on its origin plus prefix, so
  tenants on one host keep their own day. Each cap window keeps a running
  sum, rebuilt from the window when invalid and at least daily, so an older
  build during a deploy overlap cannot drift the cap.
Tools:
- `linkedin-article` takes images only from fast-tier links its resizer can
  read; the fast tier still serves WebP to buyers.
Security:
- A standing red-team suite runs in CI against the MCP connector, the seller
  judge, decide, the fetch guard, the router's payer and report prose. MCP
  refusals quote an echoed name as data, and the listing and judge screens
  read markup-split, lookalike and tool-abuse wordings of the same text.
- In FREE_MODE, identity-bound routes take no wallet identity from an
  unverified payment header. `TRUST_PROXY_HOPS` defaults to 0 when unset,
  with a boot warning (set 1 behind one edge proxy). MCP prompt arguments are
  quoted as data. A paid server answers a job created by a FREE_MODE server as
  not found.
Upgrade note:
- `TRUST_PROXY_HOPS` unset now reads 0 (it read 1), and an explicit 0, which
  used to read as 1, is honored: set `TRUST_PROXY_HOPS=1` behind one edge
  proxy. With no hop trusted, the server warns once when a loopback or private
  peer sends X-Forwarded-For. Without it, every visitor behind the proxy reads
  as the proxy's one address and shares its rate limits.
Limits:
- The unpaid price-check budget counts per client address (an IPv6 /64 as
  one) whatever the User-Agent; a named indexer or search crawler reads
  against ten times the budget on its address, and only our signed probes are
  exempt. On the one address Cloudflare Workers share, each User-Agent gets its
  own budget under a ceiling for the address.
Monitoring:
- The heartbeat signs its paywall read, the status Worker pages "Paywall not
  observed" after three unobserved runs, and both read the unpaid price-check
  budget's 429 as not observed, never as a paywall failure.
Index:
- A failed paywall check is re-run after 24 hours and when a seller registers
  again, and the check skips a templated route.
Gateway:
- `/v1/images/fast` now falls over to Recraft V4.1 Flash (WebP) and
  `/v1/images/generations` to MAI-Image-2.6 Flash (PNG), ahead of the GPT-5
  Image Mini link's upstream expiry; the former id is still accepted in
  `model`. The live model guard checks every image, video and speech link's
  upstream expiration date.
- `/v1/audio/speech` and the `/api/tts` backups move to MAI-Voice-2.1 and
  MAI-Voice-2.1-Flash ahead of the 2.0 models' upstream expiry, with a
  distinct English voice per voice name; the former ids are still accepted.
Pages:
- Operator pages tell search engines not to index them, and the sitemap lists
  only pages that are their own canonical.
- Structured data names one site entity, Agent402, part of Havok Holdings
  LLC, as every page's author and publisher.
- Report, skill, blog, guide, docs, category and marketplace pages show a
  breadcrumb trail that matches their structured data, and seeded SEC report
  pages carry the date of the newest filing they show.
Surfaces:
- The agent hosts guide adds Agent402 to a HarnessRouter workspace as a
  remote MCP server under Add-ons (`/harnessrouter`).
Operations:
- The spend jobs run from one workflow, `spend.yml`, each behind the same
  approval. Only the listing pass is scheduled (weekly, still waiting for that
  approval); every other job runs on dispatch.
Packages:
- agent402-mcp 0.13.28 runs on x402 2.30 and MCP SDK 1.32.2.

### 2026-11-05 (Audio-only decoding, refused redirects answer 400, documented gateway fields)
Tools:
- `media-info`, `audio-convert` and `audio-normalize` decode audio streams
  only. `media-info` still lists every stream: a video, image or subtitle
  stream is read from the container headers and carries `decoded: false`,
  with null for a resolution only its decoder would know. A file with no
  audio stream converts to nothing and answers 422, as before.
- `render` and `screenshot` answer 400 (not charged) when the page's
  navigation is redirected to a host the browser may not load, instead of
  rendering the refusal as the page.
- `html-frames` runs documents in a browser of its own with the JavaScript
  JIT off, so WebAssembly is not available to a document; plain script,
  canvas, SVG and CSS animation render as before. After 5 failed documents
  from one payer in 10 minutes, the next answers 429 with Retry-After.
- `a2a-card-fetch` answers the address check's 400 for a host it may not
  reach, the same answer every URL tool gives.
- URL tools answer 503 with Retry-After when this server's resolver cannot
  answer a lookup, and the one 400 for a name that does not exist. A host
  name without a dot is answered with that 400. `favicon-grab` refuses a
  non-http scheme.
Gateway:
- The Responses and Messages wires pass each input item, content block and
  tool on with its documented fields only.
Index:
- A seller registration naming one of this server's own hosts is refused.
- A seller listing with a number, object or array where text belongs is
  stored with text fields: numbers become their digits, anything else is
  dropped, and every seller page, route and search reads it as text.
- The index keeps at most 5000 tools per seller (`INDEX_SELLER_TOOL_CAP`),
  described tools first. `/api/index` rows and `?seller=` carry `toolsTotal`
  (what the seller lists) and `toolsCapped`; /marketplace shows "N of M tools"
  for a capped seller, and its listing count reads what sellers list.
- A seller listing that fails to read is skipped on its own; every other
  seller still routes. `/api/gateway-status` gains `containedTurns` and
  `brokenListings`.
Gateway:
- On the Messages wire, a text block's citation text counts against the
  tier's input cap, as its own text does.
Reports:
- A public report's JSON has its own address, `/reports/public/<id>.json`.
Packages:
- agent402-client 0.8.22 resends its own request once when the connection
  failed before any answer (a closed keep-alive socket), with the same headers
  and Idempotency-Key; `retryResets: false` turns it off. A caller's payFetch is
  not wrapped; `resetRetryFetch` is exported to put under a payment wrapper.

### 2026-11-04 (Office files from data, shorter pages, one page per adapter)
Gateway:
- inception/mercury-2.5 leaves the auto tier's fast band ahead of its
  upstream expiration on 2026-11-08, a date every model of its family
  carries. A call naming it is served as itself until that day, then by
  google/gemini-3.1-flash-lite at the tier and price of the route called,
  the swap named in agent402_model_substituted.
Tools:
- New `xlsx-create`, `docx-create` and `pptx-create` ($0.003 each, wallet
  only) turn structured data into a real Office file in one call, answered as
  base64 with its size, content type and filename, the same shape as the PDF
  tools. `xlsx-create` takes sheets of rows (arrays, or objects with an
  optional column order) with a bold, filled, frozen header row by default,
  optional header styling, column widths (auto-sized otherwise) and number
  formats; every cell is a literal value and text that starts with = + - or @
  is written as text with the Text format, never a formula. `docx-create`
  takes a title and markdown (headings, emphasis, lists, task lists, tables,
  code blocks, quotes, rules, links). `pptx-create` takes slides with a
  title, bullets in up to five levels, an optional table and speaker notes,
  plus an optional title slide. Nothing is fetched: a link is written as a
  hyperlink and an image as its alt text linked to its address. Each call is
  bounded (sheets, rows, cells, slides, bullets, table sizes and table cells,
  100,000 characters of text in a request body of up to 2 MB, an 8 MB file):
  an input cap answers 400 naming it, the file size cap and the build
  deadline answer 422, and the file is built in a worker thread.
Surfaces:
- Agent hosts guide: add Agent402 to a Paperclip company as a custom MCP
  server, with the free proof-of-work tools, how paid tools answer on the
  connector, and the per-action Allowed, Ask first and Off settings.
- The home page is five blocks: the hero with the live payments panel, the
  agents and people doors (the free tier in two lines, Decide as a table
  row), three short claims with one row of chain marks, a two-line seller
  block, and four questions. The seven full claims and the comparison table
  moved to /docs#why (/why and /compare redirect there); the seller board
  lives on /leaderboard, the demand ranking on /tools/bestsellers and the
  proof-of-work demo on /playground, each linked from the page.
- /agentic-finance, /sell, /what-is-x402, /what-is-mpp, /faq and /docs read
  shorter: one-sentence openings, one call to action per target, one x402 vs
  MPP table (on /what-is-x402), FAQ questions grouped under headings, and
  /docs titled Docs; /terms states that prepaid credits are not currently sold.
- Chain pages and /marketplace keep their shared legend and scope notes in
  one collapsed "About these figures" block; each framework adapter has one
  page at /integrations/<slug> with its configuration table
  (/docs/adapters/<slug> redirects there); tool, integration and /markets
  pages share one failed-call footnote; openings name the chain count and
  link the one chain list on /pricing; page titles are plain descriptions.

### 2026-11-03 (replay claims at a deploy, pending settles explained, sweeps follow jobs)
Payments:
- While another container may be serving (more than one replica configured,
  the first 120 seconds after a container starts serving, set by
  `DEPLOY_OVERLAP_SECONDS`, or a drain), a paid call on any route answers 503
  with Retry-After when the shared payment store does not answer, before any
  payment is verified or settled. A lone container past that window serves
  fast routes on its own claim, so a store outage does not stop sales; a
  long-running route needs the shared store as before.
- A re-sent x402 payment is matched by its network, signed payer and nonce,
  so two wallets or two networks signing the same nonce are two payments;
  marks an earlier build wrote are still honored across a deploy.
- A settle fallback that answers pending with a transaction is read on chain
  like the primary's, and the call is served once the transfer to us is
  proven. When no noted transaction is confirmed in time, the 402 says so:
  reason `settlement-unconfirmed`, retry `watch-transaction`, the network and
  the transactions to watch, and that a transfer which still lands is booked
  as owed and repaid after on-chain proof. Listed on /x402-test; the
  no-receipt exception on /agents.md, /llms-full.txt and the guides names
  this case beside a timed-out settle and a disconnect during settle.
- A buyer whose connection closes while its settlement is already in flight
  spends no hang-up forgiveness budget: the log reads SETTLE UNCONFIRMED (a
  late transfer is booked as owed) in place of NOT CHARGED, and SETTLE
  WITHHELD when no settlement was sent.
- A settlement sent while the buyer was connected is a settlement outcome
  whether or not the buyer stays: one that fails after the buyer closes
  counts toward the wallet's settle breaker and the composite guard like one
  whose buyer stayed, and one that succeeds records the sale beside the owed
  charge. Before, a close timed into the settle call left the run bounded by
  neither the breaker nor the forgiveness budget. The "settlement sent" mark
  is now set where the charge leaves: a settle the first-call allowance
  skipped or the authorization claim refused is never read as sent, so that
  hang-up spends forgiveness budget as an abandoned run and feeds the
  breaker nothing.
- The Tempo gate and the card gate require the shared replay claim on the
  same rule as the x402 dispatcher: on a long-running route always, and on
  every route while another container may be serving (more than one
  replica, a deploy's overlap window, a drain). With the shared store
  configured but unreachable, a Tempo pull or push credential or a card
  credential is then refused 503 with `Retry-After` before the handler
  runs, before a push transfer is claimed and before a card is captured;
  past the window a lone container serves on its per-process claim. Before,
  both gates took a per-process claim on a store failure, so one credential
  sent to two containers could run twice (a push transfer is already
  final).
- A settled payment's consumed mark in the replay guard keeps the guard's
  default hold (one hour). Only a grant that was not settled (a hang-up
  the forgiveness budget forgave, a first-call allowance) is held to the
  authorization's own `validBefore` plus a margin, since that
  authorization is still live on chain. Before, every settled call was
  held to its `validBefore`, one long-lived key per paid call for a client
  signing long validity windows.
- The privacy page says the replay mark is a digest of the payment's network,
  signed payer and nonce, and how long it is kept: about an hour after a
  settled call, and for a grant that was not settled (a forgiven hang-up, a
  served first-call allowance) until the authorization's own validBefore
  plus ten minutes. The `readsOnly` list under `payment.dataHandling` on
  /.well-known/x402 names the same mark with the same hold.
Tools:
- An upstream read that would start with under 5 ms of its budget is refused
  as the budget's deadline before any request leaves, instead of leaving with
  a cap too small to use.
Surfaces:
- A seller's own rows on `/api/index?seller=` carry the same `executeVia`
  fields as route rows (callable now, its lane, or when it becomes eligible).
- html-frames' published example fits its 402 whole; a paid sweep that meets
  an example the 402 shortened replays the full one from /openapi.json
  instead of the placeholder.
Operations:
- The Bazaar keep-alive sweep follows a slow route to its settlement: a route
  that refuses a synchronous paid call is called again with `Prefer:
  respond-async` and its job polled at the Retry-After it names until it
  succeeds or fails. A failed job's status and body are read from its error,
  and it is never retried as a second paid job.
- The deploy job validates the new build's flagship Bazaar listings after the
  deploy is verified, keyless, up to three runs a minute apart: a clean run
  passes, an INVALID run with no clean run fails the job, and three unreadable
  runs warn.
- Every shared-store wait (the hang-up ticket, the per-payer spend reserve,
  journals, idempotency, the first-call store, the shared market-data and
  geocoding reads, the cache, the database ping, lease release, the shared
  limiters) counts loop time, so an answer that landed while the loop was
  held is read before the deadline expires instead of being booked as a store
  that did not answer.
- The revenue snapshot's boot warm-ups (a scan of every rail over public
  chain RPCs) are off under `X402_INDEX_CRAWL=off`, `X402_SYNC_ON_START=false`
  or `REVENUE_WARMUP=off`; before, two of them ran on every boot that
  configured a wallet, test boots included.

### 2026-11-03 (onchain-sql, metered chat, seller registration)
Router and index:
- Self-serve seller registration holds 4,000 submission slots (was 2,000,
  which filled with live sellers), set by `INDEX_MAX_SUBMITTED_SEEDS`. A
  seller that has settled payments gives its slot back after 90 days with
  no successful probe (`INDEX_SETTLED_RELEASE_AFTER_DAYS`; it was never
  released); other origins after 30 days as before. A released seller's
  registration and tenure survive, and it re-registers into a free slot.
Tools:
- onchain-sql is $0.040 a call (was $0.020), and a call sends the query
  service at most 3 queries: the query itself and up to 2 recovery runs (the
  row-size measure, then the filtered run or a small re-run). A call that
  reaches the cap without an answer is the uncharged 422 with
  `hint: "narrow-query"`; the original query is never resent, and small rows
  served from the re-run are marked truncated with a note naming the cap.
  The onchain-analyst pack follows the tool's price.
- onchain-sql: a query whose result is too large for the query service to
  send (its instant internal error) is run again with LIMIT 10, again while
  the call's query budget holds (a small result of this kind still fails now
  and then). Fewer than 10 rows back is the whole result and is served
  complete. Rows so small the whole result could not have been too large
  mean the original is sent once more when the budget still holds a query
  (a query at the subquery depth limit, which skips the row-size measure)
  and served whole; refused again, or with no query left, the 10 rows are
  served marked
  truncated (`recovered: "result-size"`, `rowBytes`, `resent` and
  `refusedAgain` after a second refusal) with a note saying which.
  Otherwise the 10 rows are served marked truncated with a note giving the
  row size and the LIMIT that keeps an answer under about 500 KB. When even
  10 rows do not fit, the answer says to select fewer or narrower columns.
- onchain-sql: the query service refuses to send a result that holds a row
  over 64 KB (measured: a 65,520-byte row is sent, a 65,540-byte row is
  not, while ten 30 KB rows are). On that refusal the tool now measures the
  rows in SQL, serves up to 1,000 of the rows under the limit and says how
  many were omitted and why (`recovered: "row-size"`, `rowsOmitted`,
  `omittedReason`, `rowLimitBytes`, `maxRowBytes`, `note`), instead of
  blaming the result's size; a query already at the service's subquery
  depth limit keeps the small re-run. The match count is never below the
  rows served plus the rows omitted, and an answer whose measure saw a
  different set of rows than the run that served them (a query with no
  ORDER BY) says so (`countsFromSeparateRun`). The texts that explain the
  service's instant internal error state its rule: a row over 64 KB is
  never sent, and a whole answer under about 500 KB usually is.
- onchain-sql takes SQL up to 60,000 characters (was 10,000; the query
  service answered 48,000-character queries when measured, and the old cap
  refused real queries).
- onchain-sql returns at most 1,000 rows per call: a plain SELECT is sent
  with an outer row cap, and a result cut at 1,000 says so in fields
  (`truncated`, `complete`, `matchedIsLowerBound`, `note`, `maxRows`).
  Queries opening with WITH, or carrying SETTINGS or FORMAT, are sent as
  written. A query ending in a comment or a semicolon is accepted. A query
  already two subqueries deep (the query service's limit) takes the cap in
  its own outer LIMIT instead of the wrapper, which the service refused as
  one level too many; a syntax error the service places by line is named
  on the query as written.
- onchain-sql: a query on solana.instructions that filters, groups, orders
  or aggregates needs a block_time range and is refused before the call
  (400, `hint: "add-block-time"`) with the clause to add; a bare sample or
  count is sent.
- onchain-sql: a query the service cuts off after its answer window of
  about 10 s is answered with how to narrow it (`hint: "narrow-query"`):
  a 422 when the service still answers a known-good query on the same
  table, a 502 when it does not; a fast 5xx is tried twice, then answered
  502 with the same hint. For Solana the answer names the span the query
  covered and a day of block_time as the range to start from. At most two
  buyer queries run at once per server; a third is refused 429 with a
  retry time, uncharged. The description no longer lists hyperevm.events.
- Tool error answers carry a short `hint` code when the tool sets one.
- The metered chat route refuses a model id missing from the upstream's
  live chat model list with a 400 before payment, naming the nearest ids it
  serves (a model with a same-family successor is still served).

### 2026-11-02 (agent front door)
Surfaces:
- /llms.txt (after its title, summary, base URL and full-text link),
  /agents.md and the MCP server.describe answer open with the same
  three-line front door: the first call (web.search, with web.answer beside
  it) at its catalog price; access with no account or API key, led by the
  proof-of-work tools that run free with no wallet (counted from the
  catalog, listed at /api/pow), then pay per call in the stablecoins and
  over the wires this server offers (named from its live configuration);
  and when to use the service and when not to, linked to /agents.md.
  server.describe's startHere.firstJob opens with the same first call. With
  FRONT_DOOR_402=on, the unpaid 402 body also carries the access line and the
  /agents.md link (off by default). Rails and wire detail follow unchanged.
- New /agents.md (text/markdown, free): the front door, then "When a call
  fails" (four recovery lines, each scoped to where it holds), then how to
  connect, pay and find more tools. Linked from /llms.txt, listed in the
  sitemap and robots.txt.
- The OpenAPI info description and the /.well-known/x402 summary lead with
  what the first call returns for its price.
- The Bazaar listings of web search, web answer, news search and browser
  render say what one call returns; the search and news sample outputs
  show two results with a matching count.
- When shareable answers are enabled (`ANSWER_SHARE=on`, off by default),
  web.answer takes `share=true` (same price): the answer
  also carries `share: { url, cardUrl, expiresAt }`, a public page of the
  question, the answer and its cited sources with a 1200x630 preview card,
  written only once the call settles and kept 30 days (then 410 expired for
  90 days; the operator can remove a page, 410 removed). The question is
  labeled as the caller's; the record is at /answers/<id>.json. The page is
  not indexed; /privacy describes what it keeps.
Payments:
- A Solana payment refused because the paying wallet has no USDC account
  or less USDC than the price now says so (reason no-token-account or
  insufficient-funds, retry fund-wallet, Retry-After 300) and asks for the
  wallet to be funded or another listed network, instead of asking for a
  fresh signature. A wallet refused this way three times in ten minutes
  gets the same answer without a new check until its Retry-After passes.
### 2026-11-02 (paid answers on a pending settle)
Payments:
- An EVM payment whose transfer confirms moments after the facilitator stops
  waiting for it now receives its answer, instead of a refusal and a later
  refund: when a settle comes back pending with a transaction, the server
  reads that transaction on chain for a few seconds and serves the call once
  the transfer to us is proven.

### 2026-11-02 (router on Tempo and MPP, CDP headers in-house)
Router:
- route-execute moves on to the next Tempo seller when a seller fails
  before any payment left, as it does on every other chain; each seller is
  paid with its own freshly signed credential.
- A Tempo seller's error after payment is reported as "it may have been
  charged", unless the chain shows the payment was never taken, which is
  read only when the caller's answer window outlasts the payment's expiry.
- An MPP seller whose own llms.txt example takes a list (for example
  `urls: [...]`) receives a single url, query or id in that shape; the
  receipt's `paramsAdapted` names the rename. An ambiguous case is sent as
  written, and a seller with a published input schema is unchanged.
Payments:
- The CDP facilitator's auth headers are built by the server itself, so a
  self-hosted server no longer installs @coinbase/x402; the same CDP key
  variables apply.
Surfaces:
- /revenue's MPP table shows each rail's last settlement by date, marked
  "ours" when it was our own, as the x402 table does.

### 2026-11-02 (new pro models, 2026-12-11 retirements, MCP install text, lite search, Stellar RPC)
Gateway:
- The pro tier serves openai/gpt-6.1-terra (and its -pro twin) and
  moonshotai/kimi-k3.1-pro, both with a 1M-token context and tools.
- gpt-5, gpt-5-mini, gpt-5-nano, gpt-5-pro, o3 and o3-pro are served as
  themselves until 2026-12-11, then by their named gpt-5.6 successors at the
  tier and price of the route called, the swap named in
  agent402_model_substituted.
- gpt-5-codex and gpt-5-chat-latest, shut down upstream, are served on the
  premium and metered tiers by gpt-5.6-sol, the swap named.
- The metered tier's default model is Claude Haiku 5.5. A call that names no
  model but sends temperature, top_p, top_k, an assistant prefill or a fixed
  reasoning budget is served by Claude Haiku 4.5 instead of a 400; /v1/models
  and the route descriptions name both.
- The base tier falls back to gpt-6-luna, then deepseek-chat, when the
  requested model has no available host, as the nano tier does.
- Judgment routes run Jev 1.14.0.
Surfaces:
- server.describe, llms.txt and the README offer the hosted connector at
  https://agent402.tools/mcp in place of an add-server form that has closed.
- The hosted connector can serve every skill pack as an Agent Skill over the
  MCP Skills extension (skills/list, skills/get, resources/read of
  skill://agent402/<pack>/SKILL.md), offered only to a client that declares
  the extension; off until MCP_SKILLS=on. Prompts are unchanged. A pack whose
  tool runs free with proof-of-work says so, with the wallet price as the
  alternative.
Packages:
- agent402-mcp 0.13.27 carries the same server.describe install text, and
  every install pin names it.
Tools:
- exa-search accepts type "lite": the fastest search, served from cached
  pages, with every filter the tool takes. Its published example runs it.
Payments:
- Self-hosters can add the stablecoin issuer's facilitator as the last
  settle fallback on Base and Polygon (`CIRCLE_FACILITATOR_EVM_FALLBACK=on`,
  off by default): exact USDC only, reached only after every earlier settler
  refused before broadcasting. It is tried only on a chain the issuer's
  /supported lists, read again every 10 minutes
  (`CIRCLE_EVM_SUPPORTED_REFRESH_MS`).
Facilitator:
- On pubnet an RPC already on version 30 is tried first, ahead of the
  Protocol 30 vote, and startup logs each RPC's version with a warning for one below protocol 30.

### 2026-11-01 (x402 2.29 libraries, model "default")
Payments:
- The server runs the x402 2.29 libraries (core, express, evm, svm,
  stellar, avm, fetch, extensions) and mppx 0.13.6, and agent402-mcp 0.13.26
  runs x402 2.29 core, evm, svm and fetch. The 402 challenge a buyer echoes
  back is unchanged in size, and a free-tier tool's 402 body still leads with
  its proof-of-work option.
- The router pays an Algorand seller that advertises the full genesis-hash
  network id, echoing the seller's own accept.
Gateway:
- Model "default" on any chat wire is served as the tier's default model,
  exactly as an omitted model is, and the metered 402 quotes it that way.

### 2026-10-29 (transactions page updates itself, cleanup)
Surfaces:
- An open /revenue page reads its figures again every minute while the tab
  is visible (the headline and the rail and MPP tables; the chart every fifth
  minute), for the same date range (a preset range moves with the day). A failed read keeps
  what is shown.
- /revenue's timestamp line says when the payment figures were last read
  from the chains (every 5 minutes) apart from the rail status scan behind
  the Status column (every 4 hours).
Packages:
- agent402-mcp 0.13.25 accepts every rail by name in AGENT402_NETWORKS
  (monad, celo, avalanche, sei, optimism, stellar and algorand joined base,
  polygon, arbitrum, robinhood, arc and solana); a raw CAIP-2 id still works.
Tools:
- dex-pair, dex-pool and dex-quote answer on a deployment without a provider
  key, reading public nodes the way evm-rpc does.
Payments:
- On Algorand the route-execute tiers settle to the router's own spending
  wallet, as they do on Base. Every other route on Algorand settles to the
  treasury as before.

### 2026-10-29 (metered default, speech quotes, sale paths)
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
- The privacy page (dated 2026-10-29) says the sales ledger keeps how a paid
  call arrived.

Speech:
- /api/tts and /api/tts-hd are quoted per request from the length of the
  text: a floor plus a per-character rate, rounded up to the next $0.001, so
  2,000 characters costs what the flat price did. The cap stays 2,000
  characters on both. The 402, Tempo and credits all read the quote;
  /api/pricing (quoteRange, quoteFormula), /openapi.json, the tool pages and
  /llms-full.txt publish the range and the formula. /api/dub keeps its
  2,000-character cap and its price; /api/tts-lite stays flat.
- /api/tts and /api/tts-hd are called directly: route-execute refuses routes
  quoted per request, so the 402 carries the real price.
- Catalog lines in /llms-full.txt read "from" the floor on every route quoted
  per request.

Packages:
- agent402-client 0.8.21 takes a userAgent option (a calling package's own
  product token, sent before the client's). agent402-mcp 0.13.24,
  agent402-agentkit 0.1.10, agent402-ai-sdk 0.2.12, agent402-anthropic-tools
  0.1.13, elizaos-plugin-agent402 0.2.10, agent402-google-adk 0.1.12,
  agent402-langchain 0.2.12, agent402-llamaindex 0.1.13,
  agent402-openai-agents 0.1.13, agent402-openai-tools 0.1.13,
  agent402-strands 0.1.13 and agent402-langchain 0.1.6 on PyPI name
  themselves in the User-Agent of every request; the adapters that pass it
  require agent402-client 0.8.21 or later. agent402-openclaw 0.5.8 ships its
  README's metered-default wording.
- agent402-mcp 0.13.24 pins viem, @solana/kit and @modelcontextprotocol/sdk
  to exact versions, so an install resolves the signing libraries it was
  tested with. agent402-tollbooth 0.10.8 accepts the x402 packages from 2.0.0
  up to, not including, 3. agent402-openclaw 0.5.8, agent402-agentkit 0.1.10
  and elizaos-plugin-agent402 0.2.10 cap each optional peer below its next
  major (the x402 packages and viem below 3, @coinbase/agentkit below 1, zod
  below 5); agent402-ai-sdk 0.2.12 caps ai below 8 and agent402-llamaindex
  0.1.13 caps llamaindex below 1.

Operations:
- Each sale records the path it arrived on: the hosted connector's loopback,
  one of our client packages by its User-Agent product token, or HTTP; rows
  recorded before read unknown. The operator sales and tool-failure views
  group by that path, and an operator cohort view lists wallets past a
  per-day distinct-tool or per-hour call threshold beside a daily series
  without them. Public figures are unchanged.
- An operator test wallet that pays the Gateway batched route is booked as
  our own traffic.
- A catalog call served on the free proof-of-work or trial tier that ends
  in a 5xx counts on its own lane of the operator tool-failure view, beside
  a per-rail breakdown; the toolFailures word on /api/gateway-status reads
  paying buyers' outcomes, and free outcomes only when a tool fails nearly
  every free call.

Limits:
- A request body nested more than 64 levels deep answers 400; a compressed
  request body (any Content-Encoding) on the large-upload routes answers 415;
  a large upload while this host's in-flight upload budget, or one address's
  share of it, is full answers 503 with Retry-After; repeated unpaid large bodies from one address to a
  quoted route answer 429; a PDF whose streams decode past the processing
  limits answers 422, and a PDF call while the PDF workers and their queue
  are full answers 503 with Retry-After; base58 text is capped at 4,096
  characters (400 past it). None of these is charged.

Live view:
- Where a network holds the event stream back, the page switches to short
  polls of /api/poll after 8 seconds and keeps updating; its status label
  reads the connection, so a quiet minute on a working connection reads live.

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
