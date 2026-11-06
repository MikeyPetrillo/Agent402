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
  The metered chat route refuses a model id missing from the upstream's live model list with a 400
  before any payment gate (`src/model-catalog.js`, read every 10 minutes and on a miss at most once a
  minute; fails open with no read under 30 minutes old; retiring ids and ids with successors are left to their fallback;
  `MODEL_CATALOG_URL` points the read at a stub).
  `GATEWAY_METERED_BILLING=on` gates metered settlement, the buffered override and a credits
  stream's debit on finish alike (`recordStreamedUsage`, `meteredUsdOf` in `src/gateway-meter.js`).
- **Report products:** kits under `src/tools/*-report-kit.js`, `src/report-tiers.js`,
  house style in `src/house-style.js`, samples in `src/sample-reports.js`. Every kit that serves
  model prose passes it through `sanitizeReportProse` (`src/report-grounding.js`: a link stays a
  link only to a listed source's host; images and raw HTML are removed) and wraps fetched text in
  `quotedMaterial`; `scripts/test-report-prose-filter.js` runs each kit.
- **Direct upstream (off by default):** `src/gateway-direct-upstream.js`. With `DIRECT_UPSTREAM_URL`
  (https; plain http only to loopback), `DIRECT_UPSTREAM_KEY` and `DIRECT_UPSTREAM_MODELS`
  (`<openrouter id>=<upstream id>,...`) all set, the chat wire (`llm-gateway-kit.js` makeHandler,
  plain and streamed; Messages and Responses stay on OpenRouter) adds one attempt before the first
  OpenRouter attempt of each listed model. `DIRECT_UPSTREAM_SHARE` (0-100, default 100; invalid
  reads 0) is the A/B draw per attempt; `DIRECT_UPSTREAM_TIMEOUT_MS` (default 45000, capped by the
  payment window) bounds it, and a timeout counts in `LLM_MAX_TIMED_OUT_ATTEMPTS`. Only text
  messages (system/user/assistant) and `DIRECT_ALLOWED_PARAMS` go there; tools, images,
  response_format, logprobs, reasoning, service_tier, plugins or any other field keep the call on
  OpenRouter. Every body carries `provider: { zdr: true }` and the clamped `max_tokens`. Any failure
  (connect, timeout, 402, 429 without retry, 503, 5xx, other 4xx, an error object in a 200 body
  after leading whitespace, a non-JSON or messageless body, a missing cost) is a walkable 502/503/504
  and the same model goes to OpenRouter. The answer's cost (an `x_*` object's integer
  `charged_micro`, else an `x-*-charged-micro` header, else `usage.cost`) becomes `usage.cost`, so the
  shared path strips and meters it once; `x_*` fields are removed from bodies and stream frames, and
  the upstream's model id is relabeled to the buyer's. A/B counts and p50/p90 latency per upstream:
  `/__operator/direct-upstream.json`; PostHog `gateway_usage.upstream`. While configured, /privacy
  adds a sentence and prints the later of its date and `DIRECT_UPSTREAM_SINCE` (once reached).
  Suite: `scripts/test-direct-upstream.js`.
- **Direct upstream cost guard:** `src/gateway-direct-pricebook.js`. A direct attempt is taken only
  when the call is estimated cheaper there: the kit's input estimate (`estimateInputTokens` of the
  direct body) times prompt price plus the clamped `max_tokens` times completion price, on the
  direct upstream's listed prices, must be below the same sum on OpenRouter's cheapest routable
  endpoint for the model (priority-tier `*/fast|ultrafast|priority` endpoints and any endpoint
  above the call's `provider.max_price` excluded; `PRIORITY_ENDPOINT_TAG`, shared with
  `scripts/test-gateway-model-ids.js`) by the minimum saving share. A price book refreshed in the
  background (`startDirectPriceBook` at boot; never on a request) reads `<DIRECT_UPSTREAM_URL>/models`
  (public, no key) and each mapped model's OpenRouter `/endpoints`; a failed read keeps the last
  good one. Fails closed to OpenRouter: no read yet, older than three intervals, a model missing
  from the listing, an unparsable, zero or negative prompt or completion price, a non-zero
  `request` fee, no routable endpoint, a non-positive estimate. Measured backstop: the reported
  cost per 1k prompt-plus-completion tokens over the last answers per model on each upstream
  (direct: its own charge; OpenRouter: `usage.cost`, priority answers left out); once both hold
  the minimum sample and direct does not measure below OpenRouter, the model stays on OpenRouter
  until it does. Skips are bucketed on the A/B stats (`price_unreadable`, `price_unlisted`,
  `price_bad_price`, `price_request_fee`, `price_no_endpoint`, `price_estimate`, `not_cheaper`,
  `measured_not_cheaper`). Env: `DIRECT_UPSTREAM_PRICE_REFRESH_MS` (default one hour),
  `DIRECT_UPSTREAM_PRICE_TIMEOUT_MS` (default 15 s), `DIRECT_UPSTREAM_MIN_SAVING_PCT` (0 to below
  100; unset reads the private table's `vendor.direct.minSaving` fraction (a required key: a table without it reads `partial`); neither means
  strictly cheaper; the value is policy and is never written in the repo), `DIRECT_UPSTREAM_MEASURE_WINDOW`
  (default 200), `DIRECT_UPSTREAM_MEASURE_MIN` (default 30), `DIRECT_UPSTREAM_OR_MODELS_URL` (test
  stubs). `/api/gateway-status` `directUpstream` is a word only: `off`, `starting`, `ok`,
  `not_cheaper` (a mapped model's listed prices undercut OpenRouter at none of the reference
  shapes, its listing is unusable, or its measure blocks it) or `unreadable` (a book unread or
  stale); heartbeat and the status Worker page on `not_cheaper`/`unreadable` under one title and
  close on `ok`/`off`. Figures (listed prices, cheapest endpoint per unit, ages, measures, saving
  share) are on `/__operator/direct-upstream.json` `priceBook` only; logs print the word only.
  `model-drift.yml` grades the listed prices every 6 hours when the `DIRECT_UPSTREAM_URL` and
  `DIRECT_UPSTREAM_MODELS` Actions secrets are set (unset: skipped with a note; lines name the
  OpenRouter id and a reason, never a price). Suite: `scripts/test-direct-upstream-cost-guard.js`.
