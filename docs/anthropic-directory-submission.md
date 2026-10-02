# Anthropic Connector Directory - submission package

Submit at: **https://claude.com/docs/connectors/building/submission**
(Anthropic account required - this is the one step only a human can do.)

Everything below is ready to paste. All technical requirements are already
live: a title and safety annotations on every listed tool, a stable
privacy policy, public docs, and a no-auth streamable-HTTP endpoint.

---

## Basic information

| Field | Value |
|---|---|
| Server name | Agent402 |
| Server URL | `https://agent402.tools/mcp` |
| Transport | Streamable HTTP |
| Auth type | None (anonymous; no account, no API key) |
| Read/write | Mostly read-only; `demand.request`, `memory.write` and, where Decide is enabled, `decide.feedback` carry `readOnlyHint: false`. |
| Website | https://agent402.tools |
| Public docs | https://agent402.tools/llms.txt (also /tools and /openapi.json) |
| Privacy policy | https://agent402.tools/privacy |
| Support contact | https://github.com/MikeyPetrillo/Agent402/issues |
| Maintainer | Havok Holdings LLC - https://github.com/MikeyPetrillo/Agent402 |
| Source code | https://github.com/MikeyPetrillo/Agent402 (AGPL-3.0 server, MIT packages; fully open source) |

## Tagline (short)

> Live web search and cited answers for Claude, plus a 500+ tool catalog behind find. No signup, no API key.

## Description

> Agent402 is a tools and models layer for Claude: search the web and get
> cited answers as first-class MCP tools, then reach 500+ pay-per-call utilities
> (render, data, memory, encoding, conversions, and more) via catalog.find /
> catalog.search / catalog.call. There is no account and no API key. Pure-CPU
> tools run free on the hosted connector (rate-limited); wallet-only tools are
> payable on the connector itself over MPP (a paid call answers JSON-RPC error
> -32042 with the challenges; an mppx-wrapped client pays and retries), or run
> the npm server with a funded wallet or a card-credits key bought earlier. No LLM is
> involved in serving the utility tools: same input, same output, with full
> input schemas. Report products (deep research, company dossier, 13F fund
> report, SEC filing report, domain audit, token risk, FDA recall, insider flow,
> $0.60 to $2.00 each) are catalog slugs too. Open source. Also reachable over the x402 and MPP payment protocols for
> autonomous agents with their own wallets.

## Tools exposed (each with title + safety annotations)

Flagship demand tools first, then meta discovery for the long catalog. Where
Decide is enabled, `decide.plan`, `decide.execute` and `decide.feedback` are
listed as well. Names
are dotted (`web.search`, `catalog.call`, …); the earlier snake_case names
(`search_web`, `call_tool`, …) remain accepted as CallTool aliases but are not
listed.

1. **web.search** - "Live web search". Ranked results (title, URL, snippet).
   Wallet-only: payable on this connector over MPP, else returns paid-access setup. Open-world.
2. **web.answer** - "Cited answer". Grounded answer from live search.
   Wallet-only (MPP-payable here). Open-world.
3. **web.news** - "News search". Wallet-only (MPP-payable here).
4. **browser.render** - "Render page". Headless Chromium → markdown.
   Wallet-only (MPP-payable here).
5. **market.quote** - "Stock quote". Wallet-only (MPP-payable here).
6. **audio.transcribe** - "Transcribe audio". Wallet-only (MPP-payable here).
7. **memory.read** - "Read durable memory". Wallet-only (wallet = identity).
8. **memory.write** - "Write durable memory". Writer; wallet-only.
9. **catalog.search** - "Search the Agent402 tool catalog". Browse 500+ tools by
   description; returns slugs, prices, input schemas, and matching skill packs. Read-only.
10. **catalog.find** - "Resolve a task to the one best Agent402 tool". Returns the
    single best-matching tool call-ready: slug, price, input schema, and a worked
    example. Read-only.
11. **catalog.call** - "Run an Agent402 tool". Executes a catalog tool by slug.
    On this hosted connector the pure-CPU, deterministic tools execute (150+ of
    them); wallet-only tools are payable over MPP or return guidance. Read-only for
    free tools.
12. **payment.info** - "Payment and wallet setup". Explains the free vs paid
    split, wallet setup, spend caps, and settlement rails. Static guidance,
    read-only.
13. **server.describe** - "About this Agent402 connector". Flagship-first
    orientation, Claude/Cursor/npm install one-liners, free vs paid, discovery
    URLs. Free, read-only. Also returned in initialize.instructions.
14. **demand.request** - "Request a missing tool". Writer; records demand.
15. **sellers.list** - "List top x402 sellers". Ranked sellers from the on-chain
    settlement leaderboards (x402 on Base, or MPP on Tempo with `wire: "mpp"`). Free, read-only.

## Connection requirements

None. Anonymous streamable HTTP; stateless (every JSON-RPC message is
self-contained). Per-client rate limit: 20 calls/min, 120/hour.

## Example prompts (use cases)

- "Search the web for x402 adoption in 2026."
- "Answer: what is the Sahm Rule, with citations."
- "Render https://example.com and summarize the page."
- "Find a tool that hashes text with sha256, then run it."
- "What payment rails does Agent402 accept?"
- "Decode this JWT and tell me when it expires." (via catalog.find → catalog.call)

## Reliability / review notes

- CI drives each tool that needs no third-party key with its own documented
  example before a deploy; the MCP connector itself has an end-to-end JSON-RPC
  test gating both CI and the production rollout.
- Observers outside production probe health, the catalog, a paid call and MCP
  initialize on a schedule. Live status: https://agent402.tools/status
- Input errors are structured and human-readable: a 400 names the missing or
  invalid field.
- No accounts, no ad trackers; site pages run Google Analytics (consent strip in
  Europe) and a first-party page counter. IP addresses are used for rate limiting
  and operational logs as described at https://agent402.tools/privacy.
