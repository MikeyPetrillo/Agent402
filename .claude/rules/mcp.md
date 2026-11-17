---
paths:
  - "src/mcp-*.js"
  - "mcp/**"
  - "src/front-door.js"
  - "src/answer-share.js"
---

# MCP connector and agent-facing surfaces

Loaded when a connector or front-door file is read.

- **Connector modules:** `src/mcp-mpp.js` makes wallet-only tools payable on the connector by replaying the call as a
  loopback request to the real paid route; `src/mcp-tasks.js` handles long calls as MCP tasks;
  `src/mcp-skills.js` serves skill packs over the Skills extension (`MCP_SKILLS=on`, negotiated only).
  `src/mcp-x402-routes.js` holds internal x402 twins of six fixed-price flagships at `/__mcp-x402/<slug>`:
  reachable only with the loopback secret (anything else is the ordinary 404), rewritten to the tool's route
  and priced by its accepts with resource `/mcp` and an MCP discovery extension; a flagged request the twin
  paywall does not price runs the route's own paywall.
  `src/mcp-x402.js` is the x402 MCP transport codec (`_meta["x402/payment"]` in, payment-required,
  invalid-payment and settlement-failed results, `x402/payment-response` out), pure.
  `/mcp` wires both (`x402Loopback`, off in FREE_MODE): a flagship called by its listed name with a twin
  is asked and paid on the twin, `catalog.call` (and a flagship without a twin) on the slug's own HTTP
  route; the first ask carries the x402 PaymentRequired (JSON in the first text block, never
  `structuredContent`: every paid tool lists an `outputSchema`, and the SDK client checks any
  structuredContent against it, error results included) beside the MPP `_meta` challenges; a
  settlement-pending result carries its fields in `_meta["org.agent402/settlement-pending"]`; MPP wins when
  both are sent; x402 is blocking only (a slow route is refused before the payment is presented; it
  is paid in the call over MPP as a task, and public copy says so). Every text the connector writes
  about paying in the call reads `payWires` (`connectorWires()`, src/connector-pay.js, never in
  FREE_MODE), the account the pages read (`scripts/test-connector-pay-copy.js`).
  A tools/call whose `_meta` holds a plausible payment (`metaCarriesPayment`: an MPP credential that
  decodes, or an x402 payment on an offered network) is counted on its own per-IP transport bucket
  (`AGENT402_MCP_PAID_REQ_PER_MIN`/`_HOUR`, default 5x the normal one); unless the call then reaches a
  paywall replay (`reachesPaidReplay`), the handler also holds it to the normal bucket, so a credential
  on a discovery tool buys nothing. A free tool at its limit offers its route's x402 challenge. A 402
  whose settlement is undecided (retry same-payment or watch-transaction, or settlement_pending) is the
  pending result: the route's hint, no offer. A settle that failed never gets an offer: any 402 carrying a settle
  receipt marked `success: false`, on either wire, is the route's explanation with no offer and the
  transaction to watch when one is named (`buildSettlementUnprovenResult`), since the receipt does not
  say how a settle fallback ended; a 5xx after a payment was presented is the route's answer with no offer
  (`buildPaidRouteFailedResult`). A verify refusal (no settle receipt) keeps its fresh offer. A long call is refused before its payment is read. A twin's unpaid offer is reused for 30 s
  (`scripts/test-mcp-x402-connector.js`).
  The interop suites need the official `@x402/mcp` client, which CI installs with `--no-save` in the
  step before them and `package.json` never lists (an optional peer of mppx would ship in prod).
- **Front door:** `src/front-door.js` writes the three lines that lead `/llms.txt`, `/agents.md`
  and `server.describe`; the access line names coins and wires from the rails list and the MPP
  config. The unpaid 402 body carries the access line and the `/agents.md` link only with
  `FRONT_DOOR_402=on` (exactly); otherwise the body is the offer alone.
- **Shareable answers:** `src/answer-share.js`, off unless `ANSWER_SHARE=on` (exactly); then web.answer takes
  `share=true` and writes a public page after a settled 200 (`/answers/:id`, record at `/answers/:id.json`);
  off, no surface offers it and existing pages serve until expiry. `ANSWER_SHARE_TTL_DAYS` (default 30)
  keeps it (then 410 expired for 90 days), `ANSWER_SHARE_PER_HOUR` (default 60) caps each payer's shares,
  claimed before the call, and `ANSWER_SHARE_DIR` is the file store without the state database. Takedown:
  `POST /__operator/answer-shares/delete {id, note}` (410 removed).
- **Answer ceiling:** a free tool answer larger than `AGENT402_MCP_MAX_ANSWER_BYTES` (default 1 MiB of compact JSON)
  is cut in document order to valid JSON and carries `answerBound` (`src/mcp-answer-bound.js`: the partial-answer
  fields in bytes, plus one entry per cut list, string or object). A paid answer is delivered whole.
- **Annotations:** `readOnlyHint: true` only on a tool that never charges and never writes on any path here
  (`catalog.search`, `catalog.find`, `sellers.list`, `server.describe`, `payment.info`); a host may run those without
  asking. Every flagship (it can charge) and `catalog.call`, `demand.request`, `decide.feedback` are not read-only;
  `memory.write` is also `destructiveHint: true`. `scripts/test-mcp-http.js` derives this from the free-tier table.
  The stdio package keeps its own copy.
- **429:** the transport limiter's refusal carries `Retry-After` (seconds, from `src/rate-limit.js` `retryAfterSeconds`).
