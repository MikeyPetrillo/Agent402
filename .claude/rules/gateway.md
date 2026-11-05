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
