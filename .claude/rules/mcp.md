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
