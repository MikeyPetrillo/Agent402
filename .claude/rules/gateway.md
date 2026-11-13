---
paths:
  - "src/tools/llm-*.js"
  - "src/gateway-*.js"
  - "src/model-catalog.js"
  - "src/upstream-costs.js"
  - "src/handler-input.js"
  - "src/tools/*-report-kit.js"
  - "src/report-*.js"
  - "src/house-style.js"
  - "src/sample-reports.js"
---

# LLM gateway and report products

Loaded when a gateway, metering, model-catalog or report file is read.

- **LLM gateway:** `src/tools/llm-gateway-kit.js` (OpenAI chat wire), `llm-messages-kit.js`
  (Anthropic Messages), `llm-responses-kit.js` (OpenAI Responses); flat tiers plus a metered
  tier whose 402 is a per-request quote. `handlerInputOf(req)` (`src/handler-input.js`) is the
  one input object for pricing and serving; a body nested past `MAX_INPUT_DEPTH` (64) is refused
  there with a 400 before any handler walks it. Streams commit 200 only on the first `data:` frame.
  Every metered route (chat, Messages, Responses, generateContent) refuses a model id missing from the upstream's live model list with a 400
  before any payment gate (`meteredPrePaymentRefusal` in `src/gateway-prepayment.js`, one check over a
  row per wire: where the model id is, how the input is counted, the wire's own error object;
  each wire's validation throws the same verdict through `refuseUnlistedMeteredModel`; `src/model-catalog.js`, read every 10 minutes and on a miss at most once a
  minute; fails open with no read under 30 minutes old; retiring ids and ids with successors are left to their fallback;
  `MODEL_CATALOG_URL` points the read at a stub). A hyphenated version in an id (`v4-1`) is read
  as its dotted form only when that exact dotted id is on the fresh live list.
  **Per-model input cap:** `maxInputCharsFor(tier, model)`: the metered tier's floor (200,000
  chars) on every model, raised to `METERED_CHARS_PER_CONTEXT_TOKEN` (3) chars per token of a
  larger live context window, up to `METERED_MAX_INPUT_CHARS_CEILING` (1,000,000, the
  /v1/metered body bound); `/v1/models` publishes each model's own value as
  `meteredMaxInputChars` (a vendor wildcard reads the floor). **Pre-payment size refusal:** a
  metered body over its model's cap is refused with a 400 (`input_too_large`,
  `maxInputChars`, `inputChars`, `hint: trim-input`, larger-window `suggestions`) before any
  payment gate on every wire, as the unknown-model refusal is; each wire's own validation is the
  counter, and the message names that wire's route (`inputTooLargeError`'s `pathByTier`).
  **Upstream HTTP errors:** every wire reads one through `upstreamHttpError` (buffered and
  streamed): a provider 4xx about the request is `upstreamRejected` and the route binder answers
  400; `scripts/test-llm-wire-parity.js` sends each caller mistake and upstream condition to every wire. A Tempo push credential skips the pre-payment check and is answered by its
  gate, which books the transfer as owed; a refusal to one names that exception in its charge
  sentence (`PUSH_EXCEPTION`, `withPushException` in server.js).
  **Large quotes:** a /v1/metered body of 16k chars or more is counted before the gates by
  `warmQuoteTokenCounts`, which yields the loop every 64 KB or 8 ms of BPE and keeps each count
  for 60 s (8M chars at most); the synchronous quote reads the kept count. An unpaid quote is
  limited per address (60/min); a request carrying a payment-shaped header is counted against a
  separate budget of the same size once its credential is refused (a final 401 or 402), so a
  verified payment never spends it.
  `GATEWAY_METERED_BILLING=on` gates metered settlement, the buffered override and a credits
  stream's debit on finish alike (`recordStreamedUsage`, `meteredUsdOf` in `src/gateway-meter.js`).
- **Model retirements** (`RETIRING_MODELS` in `llm-gateway-kit.js`): each id maps to the successor
  `canonicalModel` serves from `until` (`asItselfUntil` serves the id as itself before that day).
  `keepOn: [tierSlug]` keeps an id, and every id of its family, admitted on a tier whose list no
  longer names it (`retiredKeepAdmits`); `asItself: { flex, efforts }` holds the flex attempt and
  reasoning-effort row that apply only while the id is still served as itself (`pendingAsItself`).
  Tests move the clock with `setRetiringClockForTest`; `MODEL_RETIREMENTS_NOW=<ISO date>` runs
  `scripts/test-model-retirements.js` as of that day, to prove a change passes after a date.
- **Reasoning fitted to the output cap** (chat, Messages, Responses; `reasoningForLink`,
  `fitEffortToBudget`, `fitBudgetForAnswer` in `llm-gateway-kit.js`): on each outbound link a
  buyer effort above "low" is sent as "low" when the link's cap is under `smallBudgetThreshold`
  (the tier's default output budget, the threshold `smallBudgetEffort` reads), and a reasoning or
  thinking budget is lowered to leave a quarter of the cap (never under the provider floor). A model
  flagged `reasoningOutsideMaxTokens` is left as sent. The normalized body, the cache key, the
  clamp and the metered quote read the buyer's own values; only the outbound link changes, and it
  only gets cheaper. An empty-for-length answer from OpenRouter gets one same-model run at the
  model's lowest effort (`retryEmptyAtLowestEffort`: once per call, only when
  `recoveryRunAffordable` holds, the payment window leaves time and the timed-out budget is not
  spent), metered at the served run alone; then the walk is as before. Disclosure:
  `agent402_reasoning_adjusted {field, requested, used, reason}` on the answer, the same JSON in
  `X-Agent402-Reasoning-Adjusted` on a stream. It adds no refusal. Suite:
  `scripts/test-llm-answer-fit.js`.
- **Judgment over OpenRouter** (`src/decision-one.js`): Decision-1, Gemini Decision-1 and the
  pinned Jev version (`jevOpenRouterModel`) on OpenRouter's Decisions endpoint, each on while
  `OPENROUTER_API_KEY` is set and its own switch is not `off`: `DECISION_ONE`, `GEMINI_DECISION`,
  `JEV_OPENROUTER` (`openRouterDecisionsEnabled`). Every body carries `data_collection: "deny"`, and
  `zdr: true` for a model whose every endpoint is ZDR (`DECISIONS_ZDR_MODELS`). /v1/judge walks its
  backends in `firstAnswer` (judge-kit); the internal judges (discovery rerank, wish classification,
  tool-judge, the decide planner) walk the OpenRouter legs in turn. Every walk ends at a leg that may
  have billed us (`mayBeBilled`: a timeout, or a 200 the caller cannot use); only a certain
  non-charge (refused, 5xx, 429, credentials) passes to the next leg. Suite: `scripts/test-decision-one.js`.
- **Report products:** kits under `src/tools/*-report-kit.js`, `src/report-tiers.js`,
  house style in `src/house-style.js`, samples in `src/sample-reports.js`. Every kit that serves
  model prose passes it through `sanitizeReportProse` (`src/report-grounding.js`: a link stays a
  link only to a listed source's host; images and raw HTML are removed) and wraps fetched text in
  `quotedMaterial`; `scripts/test-report-prose-filter.js` runs each kit.
- **Card report refunds owed:** a buyer's poll of an owed refund (`retryOwedRefund` in
  `src/human-checkout.js`) waits `OWED_RETRY_WAIT_MS` (8 s) for Stripe, then answers with the
  stored owed record while the retry runs on and records its own outcome. One retry per record is
  open at a time; one still open after `OWED_RETRY_ABANDON_MS` (5 minutes, past the Stripe
  client's own waits) is given up so a later poll starts another. Every refund create carries the
  payment's idempotency key, so two calls are one refund, and a late failure never writes over a
  recorded refund (`scripts/test-human-checkout.js`, `scripts/test-refund-owed-card.js`).
- **Metered client timeout:** `meteredTimeoutSentence()` (`src/metered-lead.js`, from
  `UPSTREAM_TIMEOUT_MS`) is the one wording on every surface that describes a metered call: the
  metered tool pages, `/pricing`, `/docs`, the guides, and a metered route's first-contact 402
  body as `clientTimeout` (`{ seconds, note }`, body only). `wiki/Buying-at-Volume.md` and the
  README type it; `scripts/test-wiki-facts.js` pins each to the derived text.
- **Card report first poll:** a session with no record yet is read from Stripe before anything is
  decided (`fulfill`); the poll waits `SESSION_READ_WAIT_MS` (8 s) and is then answered
  `generating`, with nothing recorded (never `unpaid` or `not_found` on an unanswered read). One
  read per session is open at a time; when it answers late, `fulfill` runs once more from that
  session, so a paid session starts its report without another poll. A read open past
  `SESSION_READ_ABANDON_MS` (5 minutes) is given up and its answer unused.
- **Direct upstream (off by default):** `src/gateway-direct-upstream.js`. With `DIRECT_UPSTREAM_URL`
  (https; plain http only to loopback), `DIRECT_UPSTREAM_KEY` and `DIRECT_UPSTREAM_MODELS`
  (`<openrouter id>=<upstream id>,...`) all set, the chat wire (`llm-gateway-kit.js` makeHandler,
  plain and streamed; Messages and Responses stay on OpenRouter) adds one attempt before the first
  OpenRouter attempt of each listed model. `DIRECT_UPSTREAM_SHARE` (0-100, default 100; invalid
  reads 0) is the A/B draw per attempt; `DIRECT_UPSTREAM_TIMEOUT_MS` (default 45000, capped by the
  payment window) bounds it, and a direct timeout does NOT count in `LLM_MAX_TIMED_OUT_ATTEMPTS`
  (OpenRouter keeps its whole budget). A non-stream direct body is read under
  `DIRECT_UPSTREAM_MAX_BYTES` (default 4 MB; over it is a `malformed` failure). A per-process
  breaker opens after `DIRECT_UPSTREAM_BREAKER_FAILS` (default 3) consecutive counted direct
  failures, the upstream's own answers only (`DIRECT_BREAKER_COUNTED`): auth (401/403), quota
  (402), 429, 404/405, 5xx, a refused or reset connection (`connect`), malformed or oversized
  body, late error, missing cost. Our own timeout (`timeout`) on a prompt at or past `HEAVY_INPUT_SHARE` of the tier's input cap, a
  lookup our resolver could not finish or a route our side lacks (`egress`; a host name that does not resolve is `connect` and counts), a stream cut with no status (`stream`), a refusal of the request itself (any other
  4xx, bucket `refused`), a client gone and an empty answer do not count; an answer resets it. Our own `timeout` on a shorter prompt counts like the upstream's own failure. One exception: our own `timeout` on a long prompt on the direct link on `UPSTREAM_UNANSWERED_MIN` calls from `UPSTREAM_UNANSWERED_MIN_CALLERS` callers inside `UPSTREAM_UNANSWERED_WINDOW_MS`, with no answer between, opens it at once (`src/unanswered-rule.js`; the log says "did not answer within our limit"). No call
  goes direct while open (`DIRECT_UPSTREAM_BREAKER_OPEN_MS`, default 5 minutes, skip bucket
  `breaker_open`); after that it is half-open (reads ok publicly) and the next call that passes the
  price check and the share draw takes the one trial: a success closes it, a counted failure
  reopens it, an uncounted outcome passes the trial on. Only text
  messages (system/user/assistant) and `DIRECT_ALLOWED_PARAMS` go there; tools, images,
  response_format, logprobs, reasoning, service_tier, plugins or any other field keep the call on
  OpenRouter. Every body carries `provider: { zdr: true }` and the clamped `max_tokens`. Any failure
  (connect, timeout, 402, 429 without retry, 503, 5xx, other 4xx, an error object in a 200 body
  after leading whitespace, a non-JSON or messageless body, a missing cost) is a walkable 502/503/504
  and the same model goes to OpenRouter; so is an empty refusal or an empty `length` answer from
  the direct attempt (only an OpenRouter empty answer skips the model's remaining attempts). A
  stream's charge sent in a frame of its own, before or after a cost-less usage frame, is carried
  to that frame and metered once. The answer's cost (an `x_*` object's integer
  `charged_micro`, else an `x-*-charged-micro` header, else `usage.cost`) becomes `usage.cost`, so the
  shared path strips and meters it once; `x_*` fields are removed from bodies and stream frames, and
  the upstream's model id is relabeled to the buyer's. A/B counts and p50/p90 latency per upstream:
  `/__operator/direct-upstream.json`; PostHog `gateway_usage.upstream`. While configured, /privacy
  adds a sentence and a Third parties item (`DIRECT_UPSTREAM_NAME`, printed escaped, and
  `DIRECT_UPSTREAM_POLICY_URL`, linked only as a parsed https URL; unset: "a direct inference
  provider"), the location sentence gains its exception, and the page prints the later of its date
  and `DIRECT_UPSTREAM_SINCE` (once reached; a boot warning while configured without a valid one).
  Suite: `scripts/test-direct-upstream.js`.
- **Direct upstream price guard:** `src/gateway-direct-pricebook.js`. A direct attempt is taken only
  when a per-call eligibility check passes: the kit's input estimate (the clamp's own estimate for
  the link; `estimateInputTokens` of the direct body on the metered tier) times prompt price plus
  the clamped `max_tokens` times completion price, on the listed prices of both routes, direct
  against the lowest routable OpenRouter endpoint for the model (priority-tier
  `*/fast|ultrafast|priority` endpoints and any endpoint above the call's `provider.max_price`
  excluded; `PRIORITY_ENDPOINT_TAG`, shared with `scripts/test-gateway-model-ids.js`), with a
  private threshold applied. A price book refreshed in the
  background (`startDirectPriceBook` at boot; never on a request) reads `<DIRECT_UPSTREAM_URL>/models`
  (public, no key) and each mapped model's OpenRouter `/endpoints`, each body under
  `DIRECT_UPSTREAM_PRICE_MAX_BYTES` (default 4 MB); a failed read keeps the last good one, and a
  refresh with a failed read is retried after 1, 2 and 5 minutes (`PRICE_RETRY_BACKOFF_MS`). Fails closed to OpenRouter: no read yet, older than three intervals, a model missing
  from the listing, an unparsable, zero or negative prompt or completion price, a non-zero
  `request` fee, no routable endpoint, a non-positive estimate. Measured backstop: each answer's reported
  cost (direct: its own charge; OpenRouter: `usage.cost`, priority answers left out) over what that
  upstream's listed prices charge for the same prompt and completion tokens, a ratio per model per
  upstream; a side with the minimum sample scales its listed per-call figure by its ratio before the
  comparison (unlike traffic on the two sides is never compared as is), and a call the scaled
  comparison keeps on OpenRouter still goes direct on `DIRECT_UPSTREAM_MEASURE_PROBE_PCT` (default
  2) so the direct ratio keeps its samples (bucket `measure_probe_sent`). Skips are bucketed on the A/B stats (`price_unreadable`, `price_unlisted`,
  `price_bad_price`, `price_request_fee`, `price_no_endpoint`, `price_estimate`, `price_guard`,
  `measured_guard`, `breaker_open`). Env: `DIRECT_UPSTREAM_PRICE_REFRESH_MS` (default one hour),
  `DIRECT_UPSTREAM_PRICE_TIMEOUT_MS` (default 15 s), `DIRECT_UPSTREAM_MIN_SAVING_PCT` (0 to below
  100; unset reads the private table's `vendor.direct.minSaving` fraction (a required key: a table
  without it reads `partial`); neither means 0; the value is policy and is never written in the repo), `DIRECT_UPSTREAM_MEASURE_WINDOW`
  (default 200), `DIRECT_UPSTREAM_MEASURE_MIN` (default 30), `DIRECT_UPSTREAM_OR_MODELS_URL` (test
  stubs). `/api/gateway-status` `directUpstream.status` is a neutral word: `off`, `starting` (no
  refresh has read everything yet and retries are left), `ok` or `degraded`. Only `breaker_open` and
  `book_unreadable` read `degraded`; a model the check keeps on OpenRouter (`listed_prices`,
  `measured_cost`) is correct routing and reads `ok`. The operator read adds `reason` whenever there
  is one.
  Heartbeat and the status Worker page on `degraded` under one neutral title, with a body naming the
  word and the operator path only, and close on `ok`/`off`. Figures (listed prices, lowest
  endpoint per unit, ages, measured ratios, threshold, breaker counts) are on
  `/__operator/direct-upstream.json` only; logs print the word and the reason code.
  `model-drift.yml` grades the listings every 6 hours when the `DIRECT_UPSTREAM_URL` and
  `DIRECT_UPSTREAM_MODELS` Actions secrets are set (unset: skipped with a note); since the ids are a
  secret its lines carry counts and reason codes only, never an id or a price
  (`scripts/test-model-drift-redaction.js`). Suite: `scripts/test-direct-upstream-cost-guard.js`.
- **Hard daily ceilings** (`src/upstream-hard-caps.js`, `HARDCAP_*`): a unit is a call the upstream may have
  served. It is taken before the call and given back when the call provably never left this process
  (`neverReachedUpstream`: the name did not resolve, the connection was refused or never opened, or the signal was
  already aborted at the call) or the upstream refused it before any work (`upstreamRefusedBeforeWork`: a 4xx answer;
  for E2B's create also the SDK's AuthenticationError, RateLimitError and ServiceBusyError). A 2xx, 3xx or 5xx
  answer, a timeout and a reset keep their unit. The operator view counts the units given back as `releasedToday`.
  Suite: `scripts/test-upstream-hard-caps.js`.
- **Quoted material:** every report kit hands the model third-party text inside `quotedMaterial` blocks
  (`src/report-grounding.js`) and carries `QUOTED_MATERIAL_RULE`, or `QUOTED_DATA_RULE` (the same rule without its
  citation sentence) where the report lists no numbered sources: the domain audit's probe blocks and the token risk
  report's token, holder, liquidity and web blocks. The insider report quotes its issuer line and every table (filer-written
  names, roles, security titles); the LinkedIn article quotes the research report and its source list. The IPO digest
  calls no model: each filer-written field reaches its markdown through `filerText` (one line, no link, tag or quote
  marker). `scripts/test-report-grounding.js` runs each with a planted directive.
