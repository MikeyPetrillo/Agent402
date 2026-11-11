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
